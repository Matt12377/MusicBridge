import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import * as dto from '@music-bridge/contracts';
import type { LocalCatalogStore } from './local-catalog-store.js';
import { defaultArtworkCandidate, rankArtworkCandidates, stableArtworkTargetKey } from '../library/artwork-selection-rules.js';

const schemaObjects = [
  { type: 'table', name: 'local_artwork_candidates', sql: 'CREATE TABLE local_artwork_candidates(id TEXT PRIMARY KEY,edition_id TEXT NOT NULL REFERENCES local_catalog_editions(id),bytes INTEGER NOT NULL,data TEXT NOT NULL,expires_at TEXT NOT NULL) STRICT' },
  { type: 'index', name: 'local_artwork_candidates_edition', sql: 'CREATE INDEX local_artwork_candidates_edition ON local_artwork_candidates(edition_id)' },
  { type: 'table', name: 'local_artwork_selections', sql: 'CREATE TABLE local_artwork_selections(edition_id TEXT PRIMARY KEY REFERENCES local_catalog_editions(id),candidate_id TEXT REFERENCES local_artwork_candidates(id),data TEXT NOT NULL) STRICT' },
  { type: 'table', name: 'local_artwork_ledger', sql: 'CREATE TABLE local_artwork_ledger(command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL) STRICT' },
  { type: 'table', name: 'local_artwork_create_intents', sql: 'CREATE TABLE local_artwork_create_intents(command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL) STRICT' },
  { type: 'trigger', name: 'local_artwork_create_intents_no_update', sql: "CREATE TRIGGER local_artwork_create_intents_no_update BEFORE UPDATE ON local_artwork_create_intents BEGIN SELECT RAISE(ABORT,'独立发行请求不可改写'); END" },
  { type: 'trigger', name: 'local_artwork_create_intents_no_delete', sql: "CREATE TRIGGER local_artwork_create_intents_no_delete BEFORE DELETE ON local_artwork_create_intents BEGIN SELECT RAISE(ABORT,'独立发行请求不可删除'); END" },
  { type: 'trigger', name: 'local_artwork_ledger_no_update', sql: "CREATE TRIGGER local_artwork_ledger_no_update BEFORE UPDATE ON local_artwork_ledger BEGIN SELECT RAISE(ABORT,'选图回执不可改写'); END" },
  { type: 'trigger', name: 'local_artwork_ledger_no_delete', sql: "CREATE TRIGGER local_artwork_ledger_no_delete BEFORE DELETE ON local_artwork_ledger BEGIN SELECT RAISE(ABORT,'选图回执不可删除'); END" },
] as const;
/** 展示副本随唯一Owner的SQLite备份保存；迁移和恢复校验共用同一固定DDL。 */
export const localArtworkMigration = schemaObjects.map(value => value.sql + ';').join('\n') + '\nPRAGMA user_version=34;';
const retainedBytes = 256 * 1024 * 1024, stagedBytes = 8 * 1024 * 1024, maxStaged = 32, maxSelections = 4096, maxReceipts = 12000;
const hash = (s: string | Uint8Array): string => createHash('sha256').update(s).digest('hex');
const failure = (): never => { throw new Error('封面存储结构或资源预算无效，现有选择保留。'); };
function budget(db: DatabaseSync): void {
  const row = db.prepare('SELECT (SELECT count(*) FROM local_artwork_selections) selections,(SELECT count(*) FROM local_artwork_ledger)+(SELECT count(*) FROM local_artwork_create_intents) receipts,(SELECT coalesce(sum(length(CAST(data AS BLOB))),0) FROM local_artwork_candidates)+(SELECT coalesce(sum(length(CAST(data AS BLOB))),0) FROM local_artwork_selections)+(SELECT coalesce(sum(length(CAST(result AS BLOB))),0) FROM local_artwork_ledger)+(SELECT coalesce(sum(length(CAST(fingerprint AS BLOB))),0) FROM local_artwork_create_intents) total').get()!;
  if (Number(row.selections) > maxSelections || Number(row.receipts) > maxReceipts || Number(row.total) > retainedBytes * 2) failure();
  const cache = db.prepare('SELECT count(*) count,coalesce(sum(bytes),0) bytes FROM local_artwork_candidates WHERE id NOT IN (SELECT candidate_id FROM local_artwork_selections WHERE candidate_id IS NOT NULL)').get()!;
  if (Number(cache.count) > maxStaged || Number(cache.bytes) > stagedBytes) failure();
}
/** 校验先于恢复副本journal/授权变更；逐行有界解析，不把SQLite完整性当图片内容完整性。 */
export function verifyLocalArtworkDatabase(db: DatabaseSync): void {
  try {
    let objects = 0;
    for (const row of db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE tbl_name IN ('local_artwork_candidates','local_artwork_selections','local_artwork_ledger','local_artwork_create_intents') AND name NOT LIKE 'sqlite_%'").iterate()) {
      const expected = schemaObjects.find(value => value.name === row.name);
      if (!expected || row.type !== expected.type || row.sql !== expected.sql) failure();
      objects++;
    }
    if (objects !== schemaObjects.length) failure();
    budget(db);
    const editionExists = db.prepare('SELECT 1 FROM local_catalog_editions WHERE id=?');
    for (const row of db.prepare('SELECT * FROM local_artwork_candidates').iterate()) {
      const value = candidate(row.data);
      if (row.id !== value.id || row.edition_id !== value.editionId || row.bytes !== value.display.bytes || row.expires_at !== value.expiresAt || !editionExists.get(value.editionId)) failure();
    }
    const candidateRow = db.prepare('SELECT data FROM local_artwork_candidates WHERE id=? AND edition_id=?');
    for (const row of db.prepare('SELECT * FROM local_artwork_selections').iterate()) {
      const value = selection(row.data);
      if (row.edition_id !== value.editionId || row.candidate_id !== (value.candidate?.id ?? null) || !editionExists.get(value.editionId)) failure();
      if (value.candidate) {
        const stored = candidateRow.get(value.candidate.id, value.editionId);
        if (!stored || JSON.stringify(candidate(stored.data)) !== JSON.stringify(value.candidate)) failure();
      }
    }
    const validFingerprint = (v: unknown): boolean => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
    const intentRow = db.prepare('SELECT fingerprint FROM local_artwork_create_intents WHERE command_id=?');
    for (const row of db.prepare('SELECT * FROM local_artwork_ledger').iterate()) {
      if (!dto.isCollectionId(row.command_id) || !validFingerprint(row.fingerprint)) failure();
      const intent = intentRow.get(row.command_id as string);
      if (intent) {
        if (intent.fingerprint !== row.fingerprint) failure();
        const result = editionReceipt(row.result);
        if (!editionExists.get(result.id)) failure();
      } else {
        // 历史选图副本独立于LRU缓存，不要求旧候选仍在当前候选表中。
        const result = selection(row.result);
        if (!editionExists.get(result.editionId)) failure();
      }
    }
    for (const row of db.prepare('SELECT * FROM local_artwork_create_intents').iterate()) {
      if (!dto.isCollectionId(row.command_id) || !validFingerprint(row.fingerprint)) failure();
    }
  } catch { failure(); }
}
function parse(raw: unknown, limit: number): unknown {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > limit) return failure();
  try { return JSON.parse(raw); } catch { return failure(); }
}
function candidate(raw: unknown): dto.LocalArtworkCandidate {
  const v = parse(raw, 2 * dto.LOCAL_ARTWORK_DISPLAY_BYTES);
  if (!dto.isLocalArtworkCandidate(v)) return failure();
  const decoded = Buffer.from(v.display.dataUrl.slice(23), 'base64');
  if (decoded.length !== v.display.bytes || decoded.toString('base64') !== v.display.dataUrl.slice(23) || hash(decoded) !== v.display.sha256) return failure();
  return v;
}
function selection(raw: unknown): dto.LocalArtworkSelection {
  const v = parse(raw, 2 * dto.LOCAL_ARTWORK_DISPLAY_BYTES); if (!dto.isLocalArtworkSelection(v)) return failure();
  if (v.candidate) {
    if (v.candidate.editionId !== v.editionId || v.mode === 'local-default' && v.candidate.origin !== 'local-independent' && v.candidate.origin !== 'embedded') return failure();
    candidate(JSON.stringify(v.candidate));
  }
  return v;
}
const editionFingerprint = (v: dto.CreateLocalArtworkEdition): string => hash(JSON.stringify(['create-edition',v.trackId,v.expectedTrackRevision,v.title]));
function editionReceipt(raw: unknown): dto.AlbumEdition {
  const v = parse(raw, 16 * 1024); if (!dto.isAlbumEdition(v)) return failure(); return v;
}
interface Access { read<T>(operation: (db: DatabaseSync) => T): T; catalog: LocalCatalogStore; conflict(message: string): never; beforeCommit?(action: string): void }
export function createLocalArtworkStore(access: Access) {
  function sourceRevision(detail: dto.LocalLibraryTrackDetail): string { const a = detail.asset, r = access.catalog.root(a.libraryRootId); return hash(JSON.stringify([a.id,a.fileRevision,a.locationRevision,r.id,r.revision,r.sourceRootId])); }
  function assertTarget(target: dto.LocalArtworkTarget): void {
    if (!dto.isLocalArtworkTarget(target)) access.conflict('选图逻辑目标无效。');
    const detail = access.catalog.trackDetail(target.trackId);
    if (sourceRevision(detail) !== target.expectedSourceRevision || detail.track.selectionRevision !== target.expectedTrackRevision || !detail.editions.some(e => e.id === target.editionId && e.revision === target.expectedEditionRevision)) access.conflict('曲目或发行已改变，请刷新后重新选择封面。');
    // 稳定关系与请求修订分别处理，不能把图Hash用于发行身份。
    stableArtworkTargetKey({ purpose: 'digital', editionId: target.editionId, editionRevision: target.expectedEditionRevision });
  }
  function current(db: DatabaseSync, editionId: string): dto.LocalArtworkSelection | null {
    const row = db.prepare('SELECT data FROM local_artwork_selections WHERE edition_id=?').get(editionId);
    if (!row) return null;
    const v = selection(row.data); if (v.editionId !== editionId) return failure(); return v;
  }
  function pending(db: DatabaseSync, editionId: string): dto.LocalArtworkCandidate[] {
    const rows = db.prepare('SELECT data FROM local_artwork_candidates WHERE edition_id=? AND expires_at>? ORDER BY rowid DESC LIMIT 5').all(editionId, new Date().toISOString());
    if (rows.length > dto.LOCAL_ARTWORK_MAX_CANDIDATES) return failure(); return rankArtworkCandidates(rows.map(row => candidate(row.data)));
  }
  function set(db: DatabaseSync, editionId: string, chosen: dto.LocalArtworkCandidate | null, mode: dto.LocalArtworkSelection['mode']): dto.LocalArtworkSelection {
    const old = current(db, editionId);
    const v: dto.LocalArtworkSelection = { id: old?.id ?? randomUUID(), editionId, revision: old ? (BigInt(old.revision) + 1n).toString() : '1', mode, candidate: chosen };
    if (!dto.isLocalArtworkSelection(v)) return failure();
    db.prepare('INSERT INTO local_artwork_selections VALUES (?,?,?) ON CONFLICT(edition_id) DO UPDATE SET candidate_id=excluded.candidate_id,data=excluded.data').run(editionId, chosen?.id ?? null, JSON.stringify(v)); return v;
  }
  function transaction<T>(action: string, fn: (db: DatabaseSync) => T): T {
    return access.read(db => { db.exec('BEGIN IMMEDIATE'); try { const v = fn(db); budget(db); access.beforeCommit?.(action); db.exec('COMMIT'); return v; } catch (e) { db.exec('ROLLBACK'); throw e; } });
  }
  function context(request: dto.LocalArtworkCommandPayloads['localArtwork.context']): dto.LocalArtworkContext {
    if (!dto.isLocalArtworkCommandPayload('localArtwork.context', request)) access.conflict('封面读取逻辑目标无效。');
    const detail = access.catalog.trackDetail(request.trackId), edition = request.editionId === null ? detail.editions[0] : detail.editions.find(e => e.id === request.editionId);
    if (request.editionId !== null && !edition) access.conflict('发行关系已改变，请重新选择。');
    const target = edition ? { trackId: detail.track.id, editionId: edition.id, expectedEditionRevision: edition.revision, expectedTrackRevision: detail.track.selectionRevision, expectedSourceRevision: sourceRevision(detail) } : null;
    const result = access.read(db => ({ trackId: detail.track.id, trackRevision: detail.track.selectionRevision, target, editions: detail.editions, selection: edition ? current(db, edition.id) : null, candidates: edition ? pending(db, edition.id) : [], remoteProvider: 'music-and-commons-v1', sourceFilesWrite: 'OFF', status: 'missing' } as dto.LocalArtworkContext));
    if (result.selection?.candidate || result.candidates.length) result.status = 'ready';
    if (!dto.isLocalArtworkContext(result)) return failure(); return result;
  }
  return {
    assertTarget, context,
    hasReceipt(id: string): boolean { if (!dto.isCollectionId(id)) return false; return access.read(db => !!db.prepare('SELECT 1 FROM local_artwork_ledger WHERE command_id=?').get(id)); },
    prepareEdition(request: dto.CreateLocalArtworkEdition): dto.AlbumEdition | null {
      if (!dto.isCreateLocalArtworkEdition(request)) access.conflict('独立发行请求无效。');
      return transaction('local-artwork-edition-intent', db => {
        const fingerprint = editionFingerprint(request), old = db.prepare('SELECT fingerprint FROM local_artwork_create_intents WHERE command_id=?').get(request.commandId);
        if (old && old.fingerprint !== fingerprint) access.conflict('同一操作编号不能改变独立发行请求。');
        const receipt = db.prepare('SELECT fingerprint,result FROM local_artwork_ledger WHERE command_id=?').get(request.commandId);
        if (receipt) { if (receipt.fingerprint !== fingerprint) access.conflict('同一操作编号不能改变独立发行请求。'); return editionReceipt(receipt.result); }
        if (access.catalog.track(request.trackId).selectionRevision !== request.expectedTrackRevision) access.conflict('曲目来源已改变，请重新建立独立发行。');
        if (!old) db.prepare('INSERT INTO local_artwork_create_intents VALUES (?,?)').run(request.commandId,fingerprint);
        return null;
      });
    },
    completeEdition(request: dto.CreateLocalArtworkEdition, value: dto.AlbumEdition): dto.AlbumEdition {
      if (!dto.isCreateLocalArtworkEdition(request) || !dto.isAlbumEdition(value) || value.title !== request.title || value.edition !== '') access.conflict('独立发行回执无效。');
      return transaction('local-artwork-edition-complete', db => {
        const fingerprint = editionFingerprint(request), intent = db.prepare('SELECT fingerprint FROM local_artwork_create_intents WHERE command_id=?').get(request.commandId);
        if (intent?.fingerprint !== fingerprint) access.conflict('独立发行请求身份不符。');
        const old = db.prepare('SELECT fingerprint,result FROM local_artwork_ledger WHERE command_id=?').get(request.commandId);
        if (old) { if (old.fingerprint !== fingerprint) access.conflict('同一操作编号不能改变独立发行请求。'); return editionReceipt(old.result); }
        db.prepare('INSERT INTO local_artwork_ledger VALUES (?,?,?)').run(request.commandId,fingerprint,JSON.stringify(value)); return value;
      });
    },
    inspectCandidate(editionId: string, id: string): dto.LocalArtworkCandidate | null { return access.read(db => { const row = db.prepare('SELECT data FROM local_artwork_candidates WHERE edition_id=? AND id=?').get(editionId,id); return row ? candidate(row.data) : null; }); },
    stage(request: dto.LocalArtworkCommandPayloads['localArtwork.stage']): dto.LocalArtworkContext {
      if (!dto.isLocalArtworkCommandPayload('localArtwork.stage', request)) access.conflict('可信封面候选无效。'); assertTarget(request.target);
      const now = new Date().toISOString();
      transaction('local-artwork-stage', db => {
        db.prepare('DELETE FROM local_artwork_candidates WHERE expires_at<=? AND id NOT IN (SELECT candidate_id FROM local_artwork_selections WHERE candidate_id IS NOT NULL)').run(now);
        const previous = db.prepare('SELECT data FROM local_artwork_candidates WHERE edition_id=? AND expires_at>? ORDER BY rowid').all(request.target.editionId, now).map(row => candidate(row.data));
        if (previous.some(c => c.sourceIdentity === request.sourceIdentity && c.original.sha256 === request.image.original.sha256 && c.origin === request.origin)) return;
        if (previous.length >= dto.LOCAL_ARTWORK_MAX_CANDIDATES) {
          const removable = db.prepare('SELECT id FROM local_artwork_candidates WHERE edition_id=? AND expires_at>? AND id NOT IN (SELECT candidate_id FROM local_artwork_selections WHERE candidate_id IS NOT NULL) ORDER BY rowid LIMIT 1').get(request.target.editionId,now);
          if (!removable) access.conflict('候选缓存已满，当前选择保留。');
          db.prepare('DELETE FROM local_artwork_candidates WHERE id=?').run(removable!.id as string);
        }
        const v: dto.LocalArtworkCandidate = { id: randomUUID(), editionId: request.target.editionId, origin: request.origin, sourceIdentity: request.sourceIdentity, sourceLabel: request.sourceLabel, provider: request.origin === 'provider' ? dto.isCommonsArtworkSource(request.remoteSource) ? 'commons-cc0-v1' : 'cover-art-archive-v1' : 'local-readonly-v1', license: request.origin === 'provider' ? dto.isCommonsArtworkSource(request.remoteSource) ? 'CC0-1.0' : 'rights-unverified' : 'user-supplied', ...(request.remoteSource ? {remoteSource:request.remoteSource} : {}), expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), ...request.image };
        candidate(JSON.stringify(v));
        db.prepare('INSERT INTO local_artwork_candidates VALUES (?,?,?,?,?)').run(v.id, v.editionId, v.display.bytes, JSON.stringify(v), v.expiresAt);
        // 未选缓存按实际字节与数量淘汰；当前选择和不可变历史回执始终保留。
        for (;;) {
          const cached = db.prepare('SELECT count(*) count,coalesce(sum(bytes),0) bytes FROM local_artwork_candidates WHERE id NOT IN (SELECT candidate_id FROM local_artwork_selections WHERE candidate_id IS NOT NULL)').get()!;
          if (Number(cached.count) <= maxStaged && Number(cached.bytes) <= stagedBytes) break;
          db.prepare('DELETE FROM local_artwork_candidates WHERE id=(SELECT id FROM local_artwork_candidates WHERE id NOT IN (SELECT candidate_id FROM local_artwork_selections WHERE candidate_id IS NOT NULL) ORDER BY rowid LIMIT 1)').run();
        }
        // staging只增加候选；取消/失败不改变已有选择，应用是独立CAS命令。
      });
      return context({ trackId: request.target.trackId, editionId: request.target.editionId });
    },
    apply(request: dto.ApplyLocalArtworkSelection): dto.LocalArtworkSelection {
      if (!dto.isApplyLocalArtworkSelection(request)) access.conflict('封面应用请求无效。');
      const fingerprint = hash(JSON.stringify([request.target.trackId, request.target.editionId, request.target.expectedEditionRevision, request.target.expectedTrackRevision, request.target.expectedSourceRevision, request.candidateId, request.expectedSelectionRevision]));
      return transaction('local-artwork-apply', db => {
        if (db.prepare('SELECT 1 FROM local_artwork_create_intents WHERE command_id=?').get(request.commandId)) access.conflict('同一操作编号不能切换选图与独立发行请求。');
        const oldReceipt = db.prepare('SELECT fingerprint,result FROM local_artwork_ledger WHERE command_id=?').get(request.commandId);
        if (oldReceipt) { if (oldReceipt.fingerprint !== fingerprint) access.conflict('同一操作编号不能改变选图请求。'); return selection(oldReceipt.result); }
        assertTarget(request.target); const old = current(db, request.target.editionId);
        if ((old?.revision ?? null) !== request.expectedSelectionRevision) access.conflict('封面已改变，请先核对当前选择。');
        let chosen: dto.LocalArtworkCandidate | null = null;
        if (request.candidateId) {
          const row = db.prepare('SELECT data FROM local_artwork_candidates WHERE id=? AND edition_id=? AND expires_at>?').get(request.candidateId, request.target.editionId, new Date().toISOString());
          if (!row) access.conflict('候选已过期或属于其他发行，请重新读取。'); chosen = candidate(row!.data);
        } else chosen = defaultArtworkCandidate(pending(db, request.target.editionId)) ?? null;
        const v = set(db, request.target.editionId, chosen, request.candidateId ? 'manual' : 'local-default');
        db.prepare('INSERT INTO local_artwork_ledger VALUES (?,?,?)').run(request.commandId, fingerprint, JSON.stringify(v)); return v;
      });
    },
  };
}
export type LocalArtworkStore = ReturnType<typeof createLocalArtworkStore>;
