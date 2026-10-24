import { createHash } from 'node:crypto';
import { closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as yieldOwner } from 'node:timers/promises';
import { isLocalMetadata, isScanJobRecord, type LocalMetadata, type ScanJobRecord } from '@music-bridge/contracts';
import type { CollectionRepository } from './repository.js';
import { CUE_HEADER_METADATA_PARSER_VERSION, type MetadataReadResult } from '../library/metadata-reader-types.js';
import { admitScanFields } from './local-scan-coordinator.js';
import { ArtistMetadataBackfillDeferred, type ArtistMetadataBackfillCandidate } from './local-artist-metadata-types.js';

export interface ArtistMetadataBackfillStatus {
  phase: 'idle' | 'running' | 'paused' | 'completed' | 'needs-attention';
  cursor: number;
  succeeded: number;
  failed: number;
  pending: number;
  enumerationComplete: boolean;
}
const pin = (candidate: ArtistMetadataBackfillCandidate): string => createHash('sha256').update(JSON.stringify([
  candidate.track, candidate.asset, candidate.relative, candidate.signature, candidate.scanJobId,
])).digest('hex');
const APPLICATION_ID = 0x4d424146;
const failureCode = (value: unknown): string => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(value) ? value : 'READ_FAILED';

/** 可中断、可恢复的旧资料补读。只追加原目录tag观察；从不改源文件或旧扫描回执。 */
export function createArtistMetadataBackfillCoordinator(options: {
  collection: Pick<CollectionRepository, 'localCatalog'>;
  directory: string | null;
  assertCurrent(): void;
  read(candidate: ArtistMetadataBackfillCandidate, signal: AbortSignal): Promise<MetadataReadResult>;
  isBusy?(): boolean;
  onState?(state: ArtistMetadataBackfillStatus): void;
}) {
  let db: DatabaseSync | undefined, closing = false, automatic = false;
  let manuallyPaused = false, suspended = false;
  let active: Promise<ArtistMetadataBackfillStatus> | null = null, controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined, phase: ArtistMetadataBackfillStatus['phase'] = 'idle';
  const check = () => { if (closing) throw new Error('艺人补读已关闭。'); options.assertCurrent(); };
  function database(): DatabaseSync {
    if (db) return db;
    let file = ':memory:';
    if (options.directory !== null) {
      if (!path.isAbsolute(options.directory)) throw new Error('艺人补读状态目录无效。');
      mkdirSync(options.directory, { recursive: true, mode: 0o700 });
      if (!lstatSync(options.directory).isDirectory() || lstatSync(options.directory).isSymbolicLink()) throw new Error('艺人补读状态目录无效。');
      file = path.join(options.directory, 'metadata-backfill.sqlite');
      for (const suffix of ['', '-wal', '-shm']) {
        try { const stat = lstatSync(file + suffix); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('艺人补读状态文件无效。'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      const fd = openSync(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      try { fchmodSync(fd, 0o600); } finally { closeSync(fd); }
    }
    const opened = new DatabaseSync(file, { enableForeignKeyConstraints: true, allowExtension: false });
    try {
      opened.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
      const version = opened.prepare('PRAGMA user_version').get()?.user_version;
      if (version === 0 && opened.prepare("SELECT count(*) n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get()!.n === 0) {
        opened.exec(`CREATE TABLE progress(id INTEGER PRIMARY KEY CHECK(id=1),cursor INTEGER NOT NULL,enumeration_complete INTEGER NOT NULL CHECK(enumeration_complete IN(0,1)),owner_high_water INTEGER NOT NULL) STRICT;
          INSERT INTO progress VALUES(1,0,0,0);
          CREATE TABLE entries(track_id TEXT PRIMARY KEY,pin TEXT NOT NULL,ordinal INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN('pending','succeeded','failed')),code TEXT,attempts INTEGER NOT NULL) STRICT;
          PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1`);
      } else if (version !== 1 || opened.prepare('PRAGMA application_id').get()?.application_id !== APPLICATION_ID) throw new Error('艺人补读状态身份无效。');
      if (opened.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new Error('艺人补读状态损坏，原状态保留。');
      // v1只增添控制与恢复回执；旧游标、失败原因和尝试次数均保留。
      opened.exec(`CREATE TABLE IF NOT EXISTS backfill_control(id INTEGER PRIMARY KEY CHECK(id=1),manual_paused INTEGER NOT NULL CHECK(manual_paused IN(0,1))) STRICT;
        INSERT OR IGNORE INTO backfill_control VALUES(1,0);
        CREATE TABLE IF NOT EXISTS completed_scans(scan_id TEXT PRIMARY KEY,pin TEXT NOT NULL) STRICT`);
      manuallyPaused = opened.prepare('SELECT manual_paused FROM backfill_control WHERE id=1').get()!.manual_paused === 1;
      db = opened; return db;
    } catch (error) { opened.close(); throw error; }
  }
  function status(): ArtistMetadataBackfillStatus {
    const current = database(), progress = current.prepare('SELECT * FROM progress WHERE id=1').get()!;
    const counts = current.prepare("SELECT count(*) FILTER(WHERE status='succeeded') succeeded,count(*) FILTER(WHERE status='failed') failed,count(*) FILTER(WHERE status='pending') pending FROM entries").get()!;
    const enumerationComplete = progress.enumeration_complete === 1, failed = Number(counts.failed), pending = Number(counts.pending);
    const reported = manuallyPaused || suspended ? 'paused' : phase === 'running' ? phase : enumerationComplete ? failed || pending ? 'needs-attention' : 'completed' : phase;
    return { phase: reported, cursor: Number(progress.cursor), succeeded: Number(counts.succeeded), failed, pending, enumerationComplete };
  }
  function notify(): void { try { options.onState?.(status()); } catch { /* 状态观察不改变原补读或关闭结果。 */ } }
  function save(candidate: ArtistMetadataBackfillCandidate, fingerprint: string, outcome: 'pending' | 'succeeded' | 'failed', code: string | null): void {
    const current = database();
    current.exec('BEGIN IMMEDIATE');
    try {
      current.prepare(`INSERT INTO entries VALUES(?,?,?,?,?,?) ON CONFLICT(track_id) DO UPDATE SET pin=excluded.pin,ordinal=excluded.ordinal,status=excluded.status,code=excluded.code,
        attempts=CASE WHEN entries.pin=excluded.pin THEN entries.attempts+excluded.attempts ELSE excluded.attempts END`)
        .run(candidate.track.id, fingerprint, candidate.ordinal, outcome, code, outcome === 'pending' ? 1 : 0);
      if (outcome === 'pending') current.prepare('UPDATE progress SET enumeration_complete=0 WHERE id=1').run();
      if (outcome !== 'pending') current.prepare('UPDATE progress SET cursor=?,enumeration_complete=0,owner_high_water=? WHERE id=1')
        .run(candidate.ordinal, options.collection.localCatalog.privateArtistSearchChanges(Number.MAX_SAFE_INTEGER).highWater);
      current.exec('COMMIT');
    } catch (error) { current.exec('ROLLBACK'); throw error; }
  }
  async function run(limit: number): Promise<ArtistMetadataBackfillStatus> {
    check(); const current = database(), progress = current.prepare('SELECT * FROM progress WHERE id=1').get()!;
    if (manuallyPaused || suspended) { phase = 'paused'; return status(); }
    const ownerHighWater = options.collection.localCatalog.privateArtistSearchChanges(Number.MAX_SAFE_INTEGER).highWater;
    // 主库恢复到补读之前时撤回枚举游标；sidecar旧成功不能替代主库当前字段。
    if (ownerHighWater < Number(progress.owner_high_water)) {
      current.prepare('UPDATE progress SET cursor=0,enumeration_complete=0,owner_high_water=? WHERE id=1').run(ownerHighWater);
      progress.cursor = 0;
    }
    if (options.isBusy?.()) { phase = 'paused'; return status(); }
    const page = options.collection.localCatalog.privateArtistMetadataBackfillCandidates(Number(progress.cursor), limit);
    controller = new AbortController(); phase = 'running'; notify();
    try {
      for (const candidate of page.items) {
        // 即使旧条目已完成或立即被资格拒绝，也让出事件队列给前台请求与取消。
        await yieldOwner();
        if (closing || controller.signal.aborted) { phase = 'paused'; return status(); }
        if (options.isBusy?.()) { phase = 'paused'; return status(); }
        check(); const fingerprint = pin(candidate), saved = current.prepare('SELECT * FROM entries WHERE track_id=?').get(candidate.track.id);
        if (candidate.complete) {
          save(candidate, fingerprint, 'succeeded', null); continue;
        }
        if (saved?.pin === fingerprint && saved.status === 'failed') {
          current.prepare('UPDATE progress SET cursor=? WHERE id=1').run(candidate.ordinal); continue;
        }
        save(candidate, fingerprint, 'pending', null);
        if (!candidate.signature || !candidate.scanJobId) { save(candidate, fingerprint, 'failed', 'NO_SCAN_EVIDENCE'); continue; }
        let result: MetadataReadResult;
        try { result = await options.read(candidate, controller.signal); }
        catch (error) {
          if (closing || controller.signal.aborted) { phase = 'paused'; return status(); }
          if (error instanceof ArtistMetadataBackfillDeferred) { phase = 'paused'; return status(); }
          // 未确认的Reader/票据失败不当作单个文件失败后继续；保留pending与游标供原Owner排查。
          phase = 'needs-attention'; automatic = false; throw error;
        }
        if (closing || controller.signal.aborted) { phase = 'paused'; return status(); }
        check();
        if (result.status === 'failure') {
          const code = failureCode(result.code);
          if (['LEASE_RELEASE_FAILED', 'WORKER_FAILED', 'CLOSED', 'ADMISSION_FAILED'].includes(code)) {
            phase = 'needs-attention'; automatic = false; throw new Error('艺人补读Reader未安全完成，原进度保留。');
          }
          save(candidate, fingerprint, 'failed', code); continue;
        }
        // TTA/TAK头部资格只给技术参数；fields={}不能证明已完整读取或确认没有艺人标签。
        if (result.parserVersion === CUE_HEADER_METADATA_PARSER_VERSION) { save(candidate, fingerprint, 'failed', 'UNSUPPORTED'); continue; }
        const admitted = admitScanFields(result.fields);
        if (admitted.status !== 'accepted') { save(candidate, fingerprint, 'failed', admitted.code); continue; }
        const fields: LocalMetadata = { artists: admitted.fields.artists ?? (admitted.fields.artist?.trim() ? [admitted.fields.artist] : []),
          albumArtists: admitted.fields.albumArtists ?? (admitted.fields.albumArtist?.trim() ? [admitted.fields.albumArtist] : []), albumArtist: admitted.fields.albumArtist ?? '' };
        if (!isLocalMetadata(fields)) { save(candidate, fingerprint, 'failed', 'CATALOG_METADATA_INVALID'); continue; }
        try { options.collection.localCatalog.privateCommitArtistMetadataBackfill(candidate, fields, `${result.parserVersion}/artists-v1`); }
        catch { save(candidate, fingerprint, 'failed', 'CONTENT_CHANGED'); continue; }
        // COMMIT先于成功标志；若此处进程中断，恢复会从主库已追加的数组识别为完成，不重放旧写。
        save(candidate, fingerprint, 'succeeded', null);
      }
      if (!page.hasMore) current.prepare('UPDATE progress SET enumeration_complete=1 WHERE id=1').run();
      phase = page.hasMore ? 'idle' : 'completed'; return status();
    } finally { controller = null; notify(); }
  }
  function runBatch(limit = 25): Promise<ArtistMetadataBackfillStatus> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return Promise.reject(new Error('艺人补读批量范围无效。'));
    if (active) return active;
    const task = run(limit); active = task;
    void task.finally(() => { if (active === task) active = null; }).catch(() => undefined);
    return task;
  }
  function schedule(delay = 100): void {
    if (!automatic || closing || manuallyPaused || suspended || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void runBatch().then(state => {
        if (!state.enumerationComplete) schedule(state.phase === 'paused' ? 5000 : 100);
      }, () => { automatic = false; phase = 'needs-attention'; notify(); });
    }, delay); timer.unref?.();
  }
  async function stopForPause(): Promise<ArtistMetadataBackfillStatus> {
    if (timer) clearTimeout(timer); timer = undefined;
    controller?.abort(); await active?.catch(() => undefined); check(); phase = 'paused'; notify(); return status();
  }
  return {
    status,
    runBatch,
    start(): void { check(); database(); automatic = true; schedule(0); },
    async pause(): Promise<ArtistMetadataBackfillStatus> {
      check(); database().prepare('UPDATE backfill_control SET manual_paused=1 WHERE id=1').run();
      manuallyPaused = true; automatic = false; return stopForPause();
    },
    /** 交互读取只暂借后台时段，不改变持久的人工暂停。 */
    async suspend(): Promise<ArtistMetadataBackfillStatus> {
      check(); database(); suspended = true; return stopForPause();
    },
    resume(): void { check(); database(); suspended = false; if (!manuallyPaused) phase = 'idle'; schedule(0); },
    /** 只接受原Owner新发生的完成事件；快照回读和重启不生成恢复许可。 */
    async recoverAfterScan(job: Readonly<ScanJobRecord>, assertRecovered: () => void): Promise<void> {
      check(); assertRecovered();
      if (!isScanJobRecord(job) || job.phase !== 'completed') throw new Error('艺人补读恢复只接受已完成的原扫描。');
      const recovered = structuredClone(job);
      const fingerprint = createHash('sha256').update(JSON.stringify([
        recovered.datasetId, recovered.jobId, recovered.libraryRootId, recovered.sourceRootId, recovered.rootRevision, recovered.jobRevision,
      ])).digest('hex');
      if (active) await active;
      check(); assertRecovered(); const current = database();
      const previous = current.prepare('SELECT pin FROM completed_scans WHERE scan_id=?').get(recovered.jobId);
      if (previous) {
        if (previous.pin !== fingerprint) throw new Error('艺人补读恢复的原扫描身份已变化。');
        return;
      }
      current.exec('BEGIN IMMEDIATE');
      try {
        current.prepare('INSERT INTO completed_scans VALUES(?,?)').run(recovered.jobId, fingerprint);
        // 失败pin仍保留；只有原扫描更新的文件资格才会重新读取，完整数组直接跳过FD。
        current.prepare('UPDATE progress SET cursor=0,enumeration_complete=0 WHERE id=1').run();
        current.exec('COMMIT');
      } catch (error) { current.exec('ROLLBACK'); throw error; }
      if (!manuallyPaused && !suspended) phase = 'idle';
      notify(); schedule(0);
    },
    /** 仅原Owner的明确重试可解除人工暂停并重试相同失败pin。 */
    async retryFailed(): Promise<void> {
      if (active) await active; check(); const current = database();
      current.exec("BEGIN IMMEDIATE; UPDATE entries SET status='pending' WHERE status='failed'; UPDATE progress SET cursor=0,enumeration_complete=0 WHERE id=1; UPDATE backfill_control SET manual_paused=0 WHERE id=1; COMMIT");
      manuallyPaused = false;
      phase = 'idle'; automatic = true; schedule(0);
    },
    async close(): Promise<void> {
      if (closing) return; closing = true; automatic = false;
      if (timer) clearTimeout(timer); timer = undefined; controller?.abort();
      await active?.catch(() => undefined); db?.close(); db = undefined;
    },
  };
}
export type ArtistMetadataBackfillCoordinator = ReturnType<typeof createArtistMetadataBackfillCoordinator>;
