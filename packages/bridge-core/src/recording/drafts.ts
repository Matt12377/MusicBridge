import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isCollectionId, isDraftText, isDraftProgramType, isDraftTrackMetadata, isMasterDraft, isMasterDraftResult, isUpdateMasterDraftRequest,
  type DraftTrackMetadata, type DraftProgramType, type MasterDraftTrack, type MasterDraft, type MasterDraftSummary, type MasterDraftResult, type UpdateMasterDraftRequest, type Page, type PageRequest } from '@music-bridge/contracts';

export const masterDraftsMigration = `
CREATE TABLE master_drafts (id TEXT PRIMARY KEY, data TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), updated_at TEXT NOT NULL) STRICT;
CREATE TABLE master_drafts_ledger (command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
CREATE TRIGGER drafts_ledger_no_update BEFORE UPDATE ON master_drafts_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
CREATE TRIGGER drafts_ledger_no_delete BEFORE DELETE ON master_drafts_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
PRAGMA user_version=5;
`;
export interface AppendDraftCommit { commandId: string; fingerprint: string; draftId?: string; expectedRevision?: number; title?: string; programType?: DraftProgramType; metadata: readonly DraftTrackMetadata[] }
export interface MasterDraftsRepository {
  list(page: PageRequest): Page<MasterDraftSummary>;
  detail(id: string): MasterDraft;
  cached(commandId: string, fingerprint: string): MasterDraftResult | undefined;
  append(request: AppendDraftCommit): MasterDraftResult;
  update(request: UpdateMasterDraftRequest, fingerprint: string): MasterDraftResult;
}
interface Access { read<T>(fn: (db: DatabaseSync) => T): T; conflict(message: string): never; unavailable(): never; beforeCommit?: (action: string) => void }
interface DraftData { title: string; programType: DraftProgramType; tracks: readonly MasterDraftTrack[] }
function estimated(data: DraftData): number | undefined {
  if (data.tracks.some(t => t.metadata.durationMs === undefined)) return undefined;
  return data.tracks.reduce((total, t) => total + t.metadata.durationMs!, 0) + (data.programType === 'compilation' ? Math.max(0, data.tracks.length - 1) * 5000 : 0);
}
export function createMasterDraftsRepository({ read, conflict, unavailable, beforeCommit }: Access): MasterDraftsRepository {
  function detail(db: DatabaseSync, id: string): MasterDraft {
    if (!isCollectionId(id)) return conflict('草稿编号无效。');
    const row = db.prepare('SELECT data,revision FROM master_drafts WHERE id=?').get(id);
    if (!row) return conflict('草稿不存在，请刷新。');
    const data = JSON.parse(String(row.data)) as DraftData;
    const duration = estimated(data);
    const result = { id, ...data, revision: Number(row.revision), status: 'draft' as const, sourceLockEligible: false as const, trackCount: data.tracks.length, ...(duration !== undefined ? { estimatedDurationMs: duration } : {}) };
    if (!isMasterDraft(result)) return unavailable(); return result;
  }
  function receipt(db: DatabaseSync, commandId: string, fingerprint: string): MasterDraftResult | undefined {
    if (!isCollectionId(commandId) || !/^[0-9a-f]{64}$/u.test(fingerprint)) return conflict('草稿操作编号无效。');
    const row = db.prepare('SELECT fingerprint,result FROM master_drafts_ledger WHERE command_id=?').get(commandId);
    if (!row) return undefined;
    if (row.fingerprint !== fingerprint) return conflict('同一操作编号不能用于不同草稿内容。');
    const result: unknown = JSON.parse(String(row.result)); if (!isMasterDraftResult(result)) return unavailable(); return result;
  }
  function transaction(commandId: string, fingerprint: string, action: string, fn: (db: DatabaseSync) => MasterDraftResult): MasterDraftResult {
    return read(db => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const prior = receipt(db, commandId, fingerprint); if (prior) { db.exec('COMMIT'); return prior; }
        const result = fn(db); if (!isMasterDraftResult(result)) return unavailable();
        db.prepare('INSERT INTO master_drafts_ledger VALUES (?,?,?,?)').run(commandId, fingerprint, JSON.stringify(result), new Date().toISOString());
        beforeCommit?.(action); db.exec('COMMIT'); return result;
      } catch (error) { try { db.exec('ROLLBACK'); } catch { /* 保留原操作编号供恢复，不清空草稿。 */ } throw error; }
    });
  }
  function write(db: DatabaseSync, id: string, data: DraftData): void {
    db.prepare('UPDATE master_drafts SET data=?,revision=revision+1,updated_at=? WHERE id=?').run(JSON.stringify(data), new Date().toISOString(), id);
    detail(db, id);
  }
  return {
    cached(commandId, fingerprint) { return read(db => receipt(db, commandId, fingerprint)); },
    list(page) {
      if (!Number.isSafeInteger(page?.offset) || page.offset < 0 || page.offset > 1_000_000 || !Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 100) return conflict('草稿分页无效。');
      return read(db => {
        const total = Number(db.prepare('SELECT COUNT(*) n FROM master_drafts').get()?.n);
        const items = db.prepare('SELECT id FROM master_drafts ORDER BY updated_at DESC,id LIMIT ? OFFSET ?').all(page.limit, page.offset).map(row => { const { tracks: _tracks, ...summary } = detail(db, String(row.id)); return summary; });
        return { items, ...page, total, hasMore: page.offset + items.length < total };
      });
    },
    detail(id) { return read(db => detail(db, id)); },
    append(request) {
      return transaction(request.commandId, request.fingerprint, 'append-draft-tracks', db => {
        if (!Array.isArray(request.metadata) || request.metadata.length < 1 || request.metadata.length > 100 || !request.metadata.every(isDraftTrackMetadata)) return conflict('选曲元数据无效或超出上限。');
        const tracks = request.metadata.map(metadata => ({ id: randomUUID(), source: 'roon' as const, metadata }));
        const id = request.draftId ?? randomUUID();
        if (request.draftId) {
          const current = detail(db, id);
          if (current.revision !== request.expectedRevision) return conflict('草稿已改变，请刷新后重新确认选曲。');
          if (current.tracks.length + tracks.length > 200) return conflict('一个草稿最多包含 200 首曲目。');
          write(db, id, { title: current.title, programType: current.programType, tracks: [...current.tracks, ...tracks] });
        } else {
          if (!isDraftText(request.title) || !isDraftProgramType(request.programType) || request.expectedRevision !== undefined) return conflict('新草稿需要有效标题和节目类型。');
          db.prepare('INSERT INTO master_drafts VALUES (?,?,1,?)').run(id, JSON.stringify({ title: request.title, programType: request.programType, tracks }), new Date().toISOString());
          detail(db, id);
        }
        return { draftId: id, trackIds: tracks.map(track => track.id) };
      });
    },
    update(request, fingerprint) {
      if (!isUpdateMasterDraftRequest(request)) return conflict('草稿编辑无效，请检查曲目和标题。');
      return transaction(request.commandId, fingerprint, 'update-master-draft', db => {
        const current = detail(db, request.draftId);
        if (current.revision !== request.expectedRevision) return conflict('草稿已改变，请刷新后重新编辑。');
        const tracks = request.trackIds.map(id => { const track = current.tracks.find(t => t.id === id); if (!track) return conflict('只能保留、排序或移除当前草稿已有曲目。'); return track; });
        write(db, request.draftId, { title: request.title, programType: request.programType, tracks });
        return { draftId: request.draftId, trackIds: request.trackIds };
      });
    },
  };
}
