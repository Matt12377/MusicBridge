import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, renameSync, writeFileSync, type Stats } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isMobileId } from '@music-bridge/contracts';
import { capturePlaybackHistoryNodeRecord, readPlaybackHistoryProof, verifyPlaybackHistoryProof } from './playback-history-index.js';
import { capturePlaybackHistoryRequest, capturePlaybackHistoryReply, capturePlaybackHistoryToken,
  samePlaybackHistoryToken } from './playback-history-protocol.js';
import { MOBILE_AUTH_SEALED_MAX_BYTES, MobileAuthPersistenceError } from './types.js';
import type { PlaybackHistoryHeadToken, PlaybackHistoryHotState, PlaybackHistoryReply,
  PlaybackHistoryRequest, PlaybackHistorySnapshotIdentity } from './playback-history-types.js';

export type PlaybackHistoryOwnerFaultPhase = 'afterDatabaseCreate' | 'beforeSchemaCommit'
  | 'beforeCommit' | 'afterBackup' | 'beforeMarker' | 'afterMarker' | 'afterCommit';
const digest = (v: Uint8Array | string): string => createHash('sha256').update(v).digest('hex');
const markerSchema = 'musicbridge.playback-history-owner.v1';
const fileMax = Math.ceil(MOBILE_AUTH_SEALED_MAX_BYTES / 3) * 4 + 2048;
const bad = (): never => { throw new MobileAuthPersistenceError('not-sent'); };
const sameFile = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
const json = (v: unknown): string => JSON.stringify(v);
const tokenKey = (v: PlaybackHistoryHeadToken): string => json([v.authority, v.storeId, v.revision, v.commitId, v.hotSha256, v.headSha256, v.indexRoot]);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(v);
interface Legacy { token: PlaybackHistoryHeadToken; hot: PlaybackHistoryHotState; fileSha: string | null; bytes: Uint8Array | null }
interface Head { token: PlaybackHistoryHeadToken; hot: Uint8Array; sealedHead: Uint8Array; legacyFileSha: string | null; marker: string }
type Commit = Extract<PlaybackHistoryRequest, { op: 'commit' }>;
function blob(v: unknown, max = MOBILE_AUTH_SEALED_MAX_BYTES): Uint8Array {
  if (!(v instanceof Uint8Array) || v.byteLength < 1 || v.byteLength > max) return bad();
  return new Uint8Array(v);
}
function text(v: unknown): string { if (typeof v !== 'string') return bad(); return v; }
function parsed(v: unknown): unknown { return JSON.parse(text(v)); }
function fingerprint(request: Commit): string {
  return digest(json({ expected: tokenKey(request.expected), mode: request.mode, next: tokenKey(request.next.token),
    head: digest(request.next.sealedHead), hot: request.next.hot.kind === 'sealed' ? digest(request.next.hot.sealed) : 'reuse-current',
    archive: request.archiveCurrent, serverId: request.serverId, datasetId: request.datasetId }));
}
function pendingBytes(request: Commit): string {
  return json({ ...request, next: { ...request.next, sealedHead: Buffer.from(request.next.sealedHead).toString('base64'),
    hot: request.next.hot.kind === 'sealed' ? { kind: 'sealed', sealed: Buffer.from(request.next.hot.sealed).toString('base64') } : request.next.hot } });
}
function pendingRequest(value: unknown): Commit {
  const raw = parsed(value) as Record<string, unknown>, next = raw.next as Record<string, unknown>;
  const hot = next.hot as Record<string, unknown>;
  if (typeof next.sealedHead !== 'string' || hot.kind === 'sealed' && typeof hot.sealed !== 'string') return bad();
  const request = capturePlaybackHistoryRequest({ ...raw, next: { ...next,
    sealedHead: new Uint8Array(Buffer.from(next.sealedHead, 'base64')),
    hot: hot.kind === 'sealed' ? { ...hot, sealed: new Uint8Array(Buffer.from(hot.sealed as string, 'base64')) } : hot } });
  if (request.op !== 'commit' || request.mode !== 'activate' || pendingBytes(request) !== value) return bad();
  return request;
}

/** 原Dataset Owner线程持有的独立私有库；不复用目录连接，不持明文密钥。 */
export function createMobilePlaybackHistoryOwnerStore(options: {
  directory: string; datasetId: string; assertCurrent?: () => void;
  /** 仅可信本地故障测试注入；不从RPC、环境或配置接收。 */
  fault?: (phase: PlaybackHistoryOwnerFaultPhase) => void;
}) {
  if (!path.isAbsolute(options.directory) || options.directory.includes('\0') || !isMobileId(options.datasetId)) return bad();
  const directory = path.join(options.directory, 'mobile-devices');
  const file = path.join(directory, 'playback-history.v1.sqlite');
  const legacyFile = path.join(directory, 'playback-state.v1.sealed.json');
  let db: DatabaseSync | undefined, descriptor: number | undefined, databaseIdentity: Stats | undefined;
  let directoryIdentity: Stats | undefined, closed = false, poisoned = false;
  function current(): void {
    if (closed || poisoned) return bad();
    options.assertCurrent?.();
  }
  function privateInfo(info: Stats, isDirectory = false): void {
    if (info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== (isDirectory ? 0o700 : 0o600)
      || (isDirectory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) return bad();
  }
  function assertDirectory(): void {
    current();
    const parent = lstatSync(options.directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.()) return bad();
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const info = lstatSync(directory); privateInfo(info, true);
    if (directoryIdentity && (directoryIdentity.dev !== info.dev || directoryIdentity.ino !== info.ino)) return bad();
    directoryIdentity ??= info;
  }
  function readFile(filePath: string, max = fileMax): Uint8Array | null {
    assertDirectory();
    let fd: number;
    try { fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    try {
      const before = fstatSync(fd); privateInfo(before);
      if (before.size < 1 || before.size > max) return bad();
      const bytes = new Uint8Array(readFileSync(fd));
      if (bytes.byteLength !== before.size || !sameFile(before, fstatSync(fd)) || !sameFile(before, lstatSync(filePath))) return bad();
      current(); return bytes;
    } finally { closeSync(fd); }
  }
  function syncDirectory(): void {
    const fd = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { privateInfo(fstatSync(fd), true); fsyncSync(fd); } finally { closeSync(fd); }
  }
  function writeAtomic(filePath: string, bytes: Uint8Array): void {
    const temporary = path.join(directory, `.history-pending-${randomUUID()}`);
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      fchmodSync(fd, 0o600); writeFileSync(fd, bytes); fsyncSync(fd);
      const before = fstatSync(fd); privateInfo(before);
      if (before.size !== bytes.byteLength || !sameFile(before, lstatSync(temporary))) return bad();
      current(); renameSync(temporary, filePath); syncDirectory();
    } finally { closeSync(fd); }
  }
  function legacy(bytes: Uint8Array | null): Legacy {
    if (bytes === null) return { token: { authority: 'legacy', storeId: null, revision: 0, commitId: null,
      hotSha256: null, headSha256: null, indexRoot: null }, hot: { kind: 'missing', datasetId: options.datasetId, revision: 0 }, fileSha: null, bytes };
    const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Record<string, unknown>;
    if (!raw || Object.keys(raw).sort().join(',') !== 'commitId,datasetId,revision,schema,sealed,sha256'
      || raw.schema !== 'musicbridge.mobile-sealed-state.v1' || raw.datasetId !== options.datasetId
      || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 1 || !uuid(raw.commitId) || typeof raw.sealed !== 'string') return bad();
    const sealed = new Uint8Array(Buffer.from(raw.sealed, 'base64'));
    if (!sealed.byteLength || sealed.byteLength > MOBILE_AUTH_SEALED_MAX_BYTES || Buffer.from(sealed).toString('base64') !== raw.sealed
      || digest(sealed) !== raw.sha256) return bad();
    const token: PlaybackHistoryHeadToken = { authority: 'legacy', storeId: null, revision: Number(raw.revision), commitId: raw.commitId,
      hotSha256: digest(sealed), headSha256: null, indexRoot: null };
    return { token, hot: { kind: 'sealed', datasetId: options.datasetId, revision: token.revision, commitId: raw.commitId, sealed }, fileSha: digest(bytes), bytes };
  }
  function connection(serverId: string): DatabaseSync {
    assertDirectory();
    if (!db) {
      let existed = true;
      try { privateInfo(lstatSync(file)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; existed = false; }
      // 已有marker却没有数据库不是可恢复的旧文件；不得悄悄另建作者。
      if (!existed) {
        const old = readFile(legacyFile);
        if (old !== null && (JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(old)) as { schema?: unknown }).schema === markerSchema) return bad();
      }
      for (const suffix of ['-wal', '-shm']) {
        try { privateInfo(lstatSync(file + suffix)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      descriptor = openSync(file, constants.O_RDWR | (existed ? 0 : constants.O_CREAT | constants.O_EXCL) | constants.O_NOFOLLOW, 0o600);
      fchmodSync(descriptor, 0o600); databaseIdentity = fstatSync(descriptor); privateInfo(databaseIdentity);
      if (!sameFile(databaseIdentity, lstatSync(file))) return bad();
      db = new DatabaseSync(file, { enableForeignKeyConstraints: true, allowExtension: false });
      db.exec('PRAGMA busy_timeout=1000; PRAGMA trusted_schema=OFF; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      const version = db.prepare('PRAGMA user_version').get()?.user_version;
      const empty = version === 0 && db.prepare('SELECT name FROM sqlite_schema LIMIT 1').get() === undefined;
      if (!existed) options.fault?.('afterDatabaseCreate');
      if (version !== 1 && !empty) return bad();
      if (empty) {
        const old = readFile(legacyFile);
        if (old !== null && (JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(old)) as { schema?: unknown }).schema === markerSchema) return bad();
        try {
          db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), dataset_id TEXT NOT NULL, server_id TEXT NOT NULL, instance_id TEXT NOT NULL) STRICT;
          CREATE TABLE current_head (singleton INTEGER PRIMARY KEY CHECK(singleton=1), token TEXT NOT NULL, hot BLOB NOT NULL, sealed_head BLOB NOT NULL, legacy_sha TEXT, marker TEXT NOT NULL) STRICT;
          CREATE TABLE archives (id TEXT PRIMARY KEY, snapshot TEXT NOT NULL, sealed BLOB NOT NULL) STRICT;
          CREATE TABLE nodes (hash TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;
          CREATE TABLE locators (value_hash TEXT PRIMARY KEY, archive_id TEXT NOT NULL REFERENCES archives(id), sealed BLOB NOT NULL) STRICT;
          CREATE TABLE stages (attempt_id TEXT PRIMARY KEY, expected TEXT NOT NULL) STRICT;
          CREATE TABLE stage_nodes (attempt_id TEXT NOT NULL REFERENCES stages(attempt_id), hash TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(attempt_id,hash)) STRICT;
          CREATE TABLE stage_locators (attempt_id TEXT NOT NULL REFERENCES stages(attempt_id), value_hash TEXT NOT NULL, archive_id TEXT NOT NULL, sealed BLOB NOT NULL, PRIMARY KEY(attempt_id,value_hash)) STRICT;
          CREATE TABLE commits (attempt_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, expected TEXT NOT NULL, next TEXT NOT NULL) STRICT;
          CREATE TABLE activation (singleton INTEGER PRIMARY KEY CHECK(singleton=1), request TEXT NOT NULL, fingerprint TEXT NOT NULL, legacy_sha TEXT, marker TEXT NOT NULL) STRICT;
          PRAGMA user_version=1;`);
          db.prepare('INSERT INTO identity VALUES(1,?,?,?)').run(options.datasetId, serverId, randomUUID());
          options.fault?.('beforeSchemaCommit'); current(); db.exec('COMMIT');
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch { poisoned = true; throw new MobileAuthPersistenceError('unknown'); }
          throw error;
        }
        syncDirectory();
      }
    }
    const info = fstatSync(descriptor!); privateInfo(info);
    const atPath = lstatSync(file); privateInfo(atPath);
    if (!databaseIdentity || info.dev !== databaseIdentity.dev || info.ino !== databaseIdentity.ino
      || info.dev !== atPath.dev || info.ino !== atPath.ino) return bad();
    const identity = db.prepare('SELECT dataset_id,server_id,instance_id FROM identity WHERE singleton=1').get();
    if (!identity || identity.dataset_id !== options.datasetId || identity.server_id !== serverId || !uuid(identity.instance_id)) return bad();
    for (const suffix of ['-wal', '-shm']) {
      try { privateInfo(lstatSync(file + suffix)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    current(); return db;
  }
  function transaction<T>(store: DatabaseSync, work: () => T): T {
    let committing = false, committed = false;
    store.exec('BEGIN IMMEDIATE');
    try {
      const result = work(); current(); committing = true; store.exec('COMMIT'); committed = true; return result;
    } catch (error) {
      if (!committed) {
        try { store.exec('ROLLBACK'); } catch { poisoned = true; throw new MobileAuthPersistenceError('unknown'); }
      }
      if (committing) throw new MobileAuthPersistenceError('unknown');
      throw error;
    }
  }
  function head(store: DatabaseSync): Head | null {
    const row = store.prepare('SELECT token,hot,sealed_head,legacy_sha,marker FROM current_head WHERE singleton=1').get();
    if (!row) return null;
    const token = capturePlaybackHistoryToken(parsed(row.token)), hot = blob(row.hot), sealedHead = blob(row.sealed_head, 256 * 1024);
    const identity = store.prepare('SELECT instance_id FROM identity WHERE singleton=1').get();
    if (token.authority !== 'journal' || identity?.instance_id !== token.storeId || digest(hot) !== token.hotSha256 || digest(sealedHead) !== token.headSha256
      || row.legacy_sha !== null && (typeof row.legacy_sha !== 'string' || !/^[a-f0-9]{64}$/u.test(row.legacy_sha))) return bad();
    const marker = text(row.marker), observed = readFile(legacyFile);
    if (observed === null || new TextDecoder('utf-8', { fatal: true }).decode(observed) !== marker) return bad();
    return { token, hot, sealedHead, legacyFileSha: row.legacy_sha as string | null, marker };
  }
  function marker(request: Commit, fileSha: string | null): string {
    return json({ schema: markerSchema, serverId: request.serverId, datasetId: request.datasetId,
      storeId: request.next.token.storeId, attemptId: request.attemptId, legacyFileSha256: fileSha, expected: request.expected }) + '\n';
  }
  function checkNext(request: Commit, hot: Uint8Array): void {
    if (digest(hot) !== request.next.token.hotSha256 || digest(request.next.sealedHead) !== request.next.token.headSha256) return bad();
  }
  function stageRows(store: DatabaseSync, request: Commit): void {
    const pending = store.prepare('SELECT expected FROM stages WHERE attempt_id=?').get(request.attemptId);
    if (pending && pending.expected !== tokenKey(request.expected)) return bad();
    if (request.archiveCurrent) {
      const old = head(store);
      if (!old || old.token.revision !== request.archiveCurrent.snapshot.revision || old.token.commitId !== request.archiveCurrent.snapshot.commitId
        || old.token.hotSha256 !== request.archiveCurrent.snapshot.hotSha256) return bad();
      const snapshot = json(request.archiveCurrent.snapshot), prior = store.prepare('SELECT snapshot,sealed FROM archives WHERE id=?').get(request.archiveCurrent.id);
      if (prior && (prior.snapshot !== snapshot || digest(blob(prior.sealed)) !== old.token.hotSha256)) return bad();
      if (!prior) store.prepare('INSERT INTO archives VALUES(?,?,?)').run(request.archiveCurrent.id, snapshot, old.hot);
    }
    if (pending) {
      const rows = store.prepare('SELECT hash,data FROM stage_nodes WHERE attempt_id=?').all(request.attemptId);
      for (const row of rows) {
        const node = capturePlaybackHistoryNodeRecord({ hash: row.hash, node: parsed(row.data) });
        const prior = store.prepare('SELECT data FROM nodes WHERE hash=?').get(node.hash);
        if (prior && prior.data !== row.data) return bad();
        if (!prior) store.prepare('INSERT INTO nodes VALUES(?,?)').run(node.hash, text(row.data));
      }
      for (const row of store.prepare('SELECT value_hash,archive_id,sealed FROM stage_locators WHERE attempt_id=?').all(request.attemptId)) {
        const sealed = blob(row.sealed, 256 * 1024);
        if (digest(sealed) !== row.value_hash || !store.prepare('SELECT id FROM archives WHERE id=?').get(text(row.archive_id))) return bad();
        const prior = store.prepare('SELECT archive_id,sealed FROM locators WHERE value_hash=?').get(text(row.value_hash));
        if (prior && (prior.archive_id !== row.archive_id || digest(blob(prior.sealed, 256 * 1024)) !== row.value_hash)) return bad();
        if (!prior) store.prepare('INSERT INTO locators VALUES(?,?,?)').run(text(row.value_hash), text(row.archive_id), sealed);
      }
    }
    const root = request.next.token.indexRoot;
    if (root !== null && !store.prepare('SELECT hash FROM nodes WHERE hash=?').get(root)) return bad();
    // 只核本次新节点的引用闭包；不扫描或解密既存历史。
    if (pending) for (const row of store.prepare('SELECT data FROM stage_nodes WHERE attempt_id=?').all(request.attemptId)) {
      const node = parsed(row.data) as { kind: string; key?: string; valueHash?: string; zero?: string; one?: string };
      if (node.kind === 'leaf') {
        if (!store.prepare('SELECT value_hash FROM locators WHERE value_hash=?').get(node.valueHash!)) return bad();
      } else if (!store.prepare('SELECT hash FROM nodes WHERE hash=?').get(node.zero!) || !store.prepare('SELECT hash FROM nodes WHERE hash=?').get(node.one!)) return bad();
    }
  }
  function publish(store: DatabaseSync, request: Commit, hot: Uint8Array, legacySha: string | null, markerText: string): void {
    checkNext(request, hot); stageRows(store, request);
    store.prepare('INSERT INTO current_head VALUES(1,?,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET token=excluded.token,hot=excluded.hot,sealed_head=excluded.sealed_head,legacy_sha=excluded.legacy_sha,marker=excluded.marker')
      .run(json(request.next.token), hot, request.next.sealedHead, legacySha, markerText);
    store.prepare('INSERT INTO commits VALUES(?,?,?,?)').run(request.attemptId, fingerprint(request), tokenKey(request.expected), json(request.next.token));
    store.prepare('DELETE FROM stage_nodes WHERE attempt_id=?').run(request.attemptId);
    store.prepare('DELETE FROM stage_locators WHERE attempt_id=?').run(request.attemptId);
    store.prepare('DELETE FROM stages WHERE attempt_id=?').run(request.attemptId);
    store.prepare('DELETE FROM activation WHERE singleton=1').run();
  }
  function completeActivation(store: DatabaseSync, request: Commit, legacySha: string | null, markerText: string, useFault: boolean): void {
    const observed = readFile(legacyFile), observedText = observed === null ? null : new TextDecoder('utf-8', { fatal: true }).decode(observed);
    const alreadyMarked = observedText === markerText;
    let original: Legacy;
    if (alreadyMarked) {
      original = legacy(legacySha === null ? null : readFile(path.join(directory, `playback-state.v1.legacy-${legacySha}.sealed.json`)));
      if (original.fileSha !== legacySha || !samePlaybackHistoryToken(original.token, request.expected)) return bad();
    } else {
      original = legacy(observed);
      if (original.fileSha !== legacySha || !samePlaybackHistoryToken(original.token, request.expected)) return bad();
      if (original.bytes !== null) {
        const backup = path.join(directory, `playback-state.v1.legacy-${legacySha}.sealed.json`), prior = readFile(backup);
        if (prior !== null && digest(prior) !== legacySha) return bad();
        if (prior === null) writeAtomic(backup, original.bytes);
      }
      if (useFault) options.fault?.('afterBackup');
      // 备份前后均重核原作者；marker前旧程序仍可推进，绝不能用旧备份盖掉新状态。
      const now = legacy(readFile(legacyFile));
      if (now.fileSha !== legacySha || !samePlaybackHistoryToken(now.token, request.expected)) return bad();
      if (useFault) options.fault?.('beforeMarker');
      const final = legacy(readFile(legacyFile));
      if (final.fileSha !== legacySha || !samePlaybackHistoryToken(final.token, request.expected)) return bad();
      writeAtomic(legacyFile, Buffer.from(markerText));
      if (useFault) options.fault?.('afterMarker');
    }
    const hot = request.next.hot.kind === 'sealed' ? request.next.hot.sealed : original.hot.kind === 'sealed' ? original.hot.sealed : bad();
    transaction(store, () => publish(store, request, hot, legacySha, markerText));
  }
  function recover(store: DatabaseSync): void {
    const pending = store.prepare('SELECT request,fingerprint,legacy_sha,marker FROM activation WHERE singleton=1').get();
    if (!pending) return;
    if (store.prepare('SELECT singleton FROM current_head').get()) return bad();
    const request = pendingRequest(pending.request);
    if (pending.legacy_sha !== null && (typeof pending.legacy_sha !== 'string' || !/^[a-f0-9]{64}$/u.test(pending.legacy_sha))
      || store.prepare('SELECT instance_id FROM identity WHERE singleton=1').get()?.instance_id !== request.next.token.storeId
      || fingerprint(request) !== pending.fingerprint || marker(request, pending.legacy_sha as string | null) !== pending.marker) return bad();
    const original = readFile(legacyFile), markerText = text(pending.marker);
    if (original === null || new TextDecoder('utf-8', { fatal: true }).decode(original) !== markerText) {
      const latest = legacy(original);
      if (!samePlaybackHistoryToken(latest.token, request.expected) || latest.fileSha !== pending.legacy_sha) {
        // marker前旧作者确已向前推进：废弃未出版的迁移意图，下一次原attempt对账只能得到conflict。
        // 缺失、回退或同revision换字节不是合法推进，仍拒绝，不能用备份覆盖。
        if (latest.token.revision <= request.expected.revision) return bad();
        transaction(store, () => {
          store.prepare('DELETE FROM activation WHERE singleton=1').run();
          store.prepare('DELETE FROM stage_nodes WHERE attempt_id=?').run(request.attemptId);
          store.prepare('DELETE FROM stage_locators WHERE attempt_id=?').run(request.attemptId);
          store.prepare('DELETE FROM stages WHERE attempt_id=?').run(request.attemptId);
        });
        return;
      }
    }
    completeActivation(store, request, pending.legacy_sha as string | null, markerText, false);
  }
  function observed(store: DatabaseSync): { token: PlaybackHistoryHeadToken; legacy: Legacy | null; head: Head | null } {
    const value = head(store);
    if (value) return { token: value.token, legacy: null, head: value };
    const old = legacy(readFile(legacyFile));
    return { token: old.token, legacy: old, head: null };
  }
  function execute(request: PlaybackHistoryRequest): PlaybackHistoryReply {
    current();
    if (request.datasetId !== options.datasetId) return bad();
    const store = connection(request.serverId); recover(store);
    const value = observed(store);
    if (request.op === 'load') return { kind: 'loaded', token: value.token, hot: value.head
      ? { kind: 'sealed', datasetId: options.datasetId, revision: value.token.revision, commitId: value.token.commitId,
        sealed: value.head.hot } as PlaybackHistoryHotState : value.legacy!.hot,
      sealedHead: value.head?.sealedHead ?? null, legacyFileSha256: value.head ? value.head.legacyFileSha : value.legacy!.fileSha };
    if (request.op === 'read-commit') {
      const receipt = store.prepare('SELECT expected,next FROM commits WHERE attempt_id=?').get(request.attemptId);
      if (receipt) {
        const next = capturePlaybackHistoryToken(parsed(receipt.next));
        if (receipt.expected !== tokenKey(request.expected) || !samePlaybackHistoryToken(next, request.next)) return bad();
        return { kind: 'committed', token: next, attemptId: request.attemptId };
      }
      return samePlaybackHistoryToken(value.token, request.expected) ? { kind: 'unconfirmed', token: value.token, attemptId: request.attemptId }
        : { kind: 'conflict', token: value.token };
    }
    if (request.op === 'commit') {
      const receipt = store.prepare('SELECT fingerprint,next FROM commits WHERE attempt_id=?').get(request.attemptId);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint(request)) return bad();
        return { kind: 'committed', token: capturePlaybackHistoryToken(parsed(receipt.next)), attemptId: request.attemptId };
      }
    }
    if (!samePlaybackHistoryToken(value.token, request.expected)) return { kind: 'conflict', token: value.token };
    if (request.op === 'lookup') {
      const proof = readPlaybackHistoryProof(value.token.indexRoot, request.key, hash => {
        const row = store.prepare('SELECT data FROM nodes WHERE hash=?').get(hash);
        if (!row) return bad(); return { hash, node: parsed(row.data) };
      });
      const presence = verifyPlaybackHistoryProof(value.token.indexRoot, request.key, proof);
      if (presence.kind === 'absent') return { kind: 'proof', token: value.token, key: request.key, proof, locator: null, archive: null };
      const row = store.prepare('SELECT archive_id,sealed FROM locators WHERE value_hash=?').get(presence.valueHash);
      if (!row) return bad();
      const sealed = blob(row.sealed, 256 * 1024), archiveId = text(row.archive_id);
      if (digest(sealed) !== presence.valueHash) return bad();
      const archive = store.prepare('SELECT snapshot,sealed FROM archives WHERE id=?').get(archiveId);
      if (!archive) return bad();
      const snapshot = parsed(archive.snapshot) as PlaybackHistorySnapshotIdentity, archiveSealed = blob(archive.sealed);
      if (digest(archiveSealed) !== snapshot.hotSha256) return bad();
      return { kind: 'proof', token: value.token, key: request.key, proof,
        locator: { valueHash: presence.valueHash, archiveId, sealed }, archive: { id: archiveId, snapshot, sealed: archiveSealed } };
    }
    if (request.op === 'stage') {
      transaction(store, () => {
        const committed = store.prepare('SELECT attempt_id FROM commits WHERE attempt_id=?').get(request.attemptId);
        if (committed) return bad();
        const prior = store.prepare('SELECT expected FROM stages WHERE attempt_id=?').get(request.attemptId);
        if (prior && prior.expected !== tokenKey(request.expected)) return bad();
        if (!prior) store.prepare('INSERT INTO stages VALUES(?,?)').run(request.attemptId, tokenKey(request.expected));
        for (const record of request.nodes) {
          const encoded = json(record.node), found = store.prepare('SELECT data FROM stage_nodes WHERE attempt_id=? AND hash=?').get(request.attemptId, record.hash);
          if (found && found.data !== encoded) return bad();
          if (!found) store.prepare('INSERT INTO stage_nodes VALUES(?,?,?)').run(request.attemptId, record.hash, encoded);
        }
        for (const record of request.locators) {
          if (digest(record.sealed) !== record.valueHash) return bad();
          const prior = store.prepare('SELECT archive_id,sealed FROM stage_locators WHERE attempt_id=? AND value_hash=?').get(request.attemptId, record.valueHash);
          if (prior && (prior.archive_id !== record.archiveId || digest(blob(prior.sealed, 256 * 1024)) !== record.valueHash)) return bad();
          if (!prior) store.prepare('INSERT INTO stage_locators VALUES(?,?,?,?)').run(request.attemptId, record.valueHash, record.archiveId, record.sealed);
        }
      });
      return { kind: 'staged', token: value.token, attemptId: request.attemptId };
    }
    let pendingActivation = false, published = false;
    try {
      if (request.mode === 'activate') {
        const old = value.legacy!;
        const hot = request.next.hot.kind === 'sealed' ? request.next.hot.sealed : old.hot.kind === 'sealed' ? old.hot.sealed : bad();
        checkNext(request, hot); options.fault?.('beforeCommit');
        const markerText = marker(request, old.fileSha);
        transaction(store, () => {
          store.prepare('UPDATE identity SET instance_id=? WHERE singleton=1').run(request.next.token.storeId!);
          store.prepare('INSERT INTO activation VALUES(1,?,?,?,?)').run(pendingBytes(request), fingerprint(request), old.fileSha, markerText);
        });
        pendingActivation = true;
        completeActivation(store, request, old.fileSha, markerText, true);
      } else {
        const old = value.head!;
        if (request.next.hot.kind !== 'sealed') return bad();
        checkNext(request, request.next.hot.sealed);
        transaction(store, () => { publish(store, request, request.next.hot.kind === 'sealed' ? request.next.hot.sealed : bad(), old.legacyFileSha, old.marker);
          options.fault?.('beforeCommit'); });
      }
      published = true; options.fault?.('afterCommit');
      const result = head(store);
      if (!result || !samePlaybackHistoryToken(result.token, request.next.token)) return bad();
      return { kind: 'committed', token: result.token, attemptId: request.attemptId };
    } catch (error) {
      if (pendingActivation || published || error instanceof MobileAuthPersistenceError && error.outcome === 'unknown') throw new MobileAuthPersistenceError('unknown');
      throw error;
    }
  }
  return {
    dispatch(raw: Readonly<PlaybackHistoryRequest>): PlaybackHistoryReply {
      let committed = false;
      try {
        const request = capturePlaybackHistoryRequest(raw), result = execute(request);
        committed = request.op === 'commit' && result.kind === 'committed';
        current(); return capturePlaybackHistoryReply(result, request);
      } catch (error) {
        throw new MobileAuthPersistenceError(committed ? 'unknown' : error instanceof MobileAuthPersistenceError ? error.outcome : 'not-sent');
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      try { db?.close(); } finally { db = undefined; if (descriptor !== undefined) { closeSync(descriptor); descriptor = undefined; } }
    },
  };
}
