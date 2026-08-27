import type { DatabaseSync } from 'node:sqlite';
import { isCollectionId, isFrozenPrepared, type PreparedHistory, type FrozenPrepared, type PreparedImportJob, type PreparedSelection, type SelectPreparedRequest, type StartPreparedImportRequest, type PreparedImportProposal, type MasterVersion, type LayoutVersion, type RawRenderAsset, type FreezePreparedRequest, type PreparedReview } from '@music-bridge/contracts';
import type { RootCapability, FileEvidence } from './source-files.js';
import type { OwnedPreparation, PreparationOutput } from './preparation-files.js';
import { mediaFingerprint } from './media-store.js';

export const preparedMigration = `
CREATE TABLE prepared_versions (id TEXT PRIMARY KEY,draft_id TEXT NOT NULL REFERENCES master_drafts(id),data TEXT NOT NULL) STRICT;
CREATE TABLE prepared_jobs (id TEXT PRIMARY KEY,draft_id TEXT NOT NULL REFERENCES master_drafts(id),data TEXT NOT NULL) STRICT;
CREATE TABLE prepared_selections (id TEXT PRIMARY KEY,data TEXT NOT NULL) STRICT;
CREATE TABLE prepared_ledger (command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
CREATE TRIGGER prepared_versions_no_update BEFORE UPDATE ON prepared_versions BEGIN SELECT RAISE(ABORT,'immutable prepared'); END;
CREATE TRIGGER prepared_versions_no_delete BEFORE DELETE ON prepared_versions BEGIN SELECT RAISE(ABORT,'immutable prepared'); END;
CREATE TRIGGER prepared_ledger_no_update BEFORE UPDATE ON prepared_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
CREATE TRIGGER prepared_ledger_no_delete BEFORE DELETE ON prepared_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
CREATE TRIGGER prepared_jobs_completed_no_update BEFORE UPDATE ON prepared_jobs WHEN json_extract(OLD.data,'$.public.state')='completed' BEGIN SELECT RAISE(ABORT,'immutable original render'); END;
CREATE TRIGGER prepared_jobs_no_delete BEFORE DELETE ON prepared_jobs BEGIN SELECT RAISE(ABORT,'immutable import history'); END;
PRAGMA user_version=10;
`;
export interface StoredPreparedSelection { public: PreparedSelection; root: RootCapability; relative: string; signature: string; createdAt: string; creationTimeEvidence: RawRenderAsset['creationTimeEvidence'] }
export interface PreparedInput { master: MasterVersion; layout: LayoutVersion; destination: RootCapability; proposal: PreparedImportProposal; selections: readonly (StoredPreparedSelection & { evidence: FileEvidence; asset: RawRenderAsset })[] }
export interface StoredPreparedJob { public: PreparedImportJob; request: StartPreparedImportRequest; input: PreparedInput; createdAt: string; owned?: OwnedPreparation; files: readonly PreparationOutput[]; manifestHash?: string }
interface Access { read<T>(fn: (db: DatabaseSync) => T): T; conflict(message: string): never; beforeCommit?: (action: string) => void }
export function createPreparedStore({ read, conflict, beforeCommit }: Access) {
  const get = <T>(db: DatabaseSync, table: string, id: string): T | undefined => { const row = db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id); return row ? JSON.parse(String(row.data)) as T : undefined; };
  const selection = (db: DatabaseSync, id: string): StoredPreparedSelection => get<StoredPreparedSelection>(db, 'prepared_selections', id) ?? conflict('Render 文件选择不存在。');
  const job = (db: DatabaseSync, id: string): StoredPreparedJob => get<StoredPreparedJob>(db, 'prepared_jobs', id) ?? conflict('Render 导入任务不存在。');
  const save = (db: DatabaseSync, value: StoredPreparedJob): void => { db.prepare('INSERT INTO prepared_jobs VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(value.public.id, value.public.draftId, JSON.stringify(value)); };
  const destinationAuthorized = (db: DatabaseSync, id: string): boolean => get<RootCapability>(db, 'preparation_destinations', id)?.authorized === true;
  const receipt = (db: DatabaseSync, id: string, fp: string): string | undefined => { const prior = db.prepare('SELECT fingerprint,result FROM prepared_ledger WHERE command_id=?').get(id); if (prior && prior.fingerprint !== fp) return conflict('原操作编号不能用于不同的 PREP 请求。'); return prior ? String(prior.result) : undefined; };
  const record = (db: DatabaseSync, id: string, fp: string, result: string): void => { db.prepare('INSERT INTO prepared_ledger VALUES (?,?,?,?)').run(id, fp, result, new Date().toISOString()); };
  function transaction<T>(action: string, fn: (db: DatabaseSync) => T): T { return read(db => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(db); beforeCommit?.(action); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } }); }
  return {
    list(draftId: string): PreparedHistory {
      return read(db => {
        if (!isCollectionId(draftId) || !db.prepare('SELECT id FROM master_drafts WHERE id=?').get(draftId)) return conflict('草稿不存在，请刷新。');
        return { draftId, preps: db.prepare('SELECT data FROM prepared_versions WHERE draft_id=? ORDER BY rowid DESC').all(draftId).map(r => JSON.parse(String(r.data)) as FrozenPrepared), jobs: db.prepare('SELECT data FROM prepared_jobs WHERE draft_id=? ORDER BY rowid DESC').all(draftId).map(r => (JSON.parse(String(r.data)) as { public: PreparedImportJob }).public) };
      });
    },
    selections: (preparationId: string): PreparedSelection[] => read(db => db.prepare("SELECT data FROM prepared_selections WHERE json_extract(data,'$.public.preparationId')=? ORDER BY rowid DESC").all(preparationId).map(r => (JSON.parse(String(r.data)) as StoredPreparedSelection).public)),
    selection: (id: string) => read(db => selection(db, id)),
    selectionReceipt: (request: SelectPreparedRequest) => read(db => { const prior = receipt(db, request.commandId, mediaFingerprint(['select', request])); return prior ? selection(db, prior).public : null; }),
    select(request: SelectPreparedRequest, input: Omit<StoredPreparedSelection, 'public'>, label: string): PreparedSelection {
      return transaction('select-prepared', db => {
        const fp = mediaFingerprint(['select', request]), prior = receipt(db, request.commandId, fp); if (prior) return selection(db, prior).public;
        if (!db.prepare('SELECT id FROM preparation_workspaces WHERE id=?').get(request.preparationId)) return conflict('必须先完成 Logic 工作区。');
        if (Number(db.prepare("SELECT COUNT(*) AS n FROM prepared_selections WHERE json_extract(data,'$.public.preparationId')=?").get(request.preparationId)!.n) >= 100) return conflict('该工作区的 Render 选择历史已达到上限。');
        const value: StoredPreparedSelection = { ...input, public: { id: request.commandId, preparationId: request.preparationId, side: request.side, label, authorized: true } };
        db.prepare('INSERT INTO prepared_selections VALUES (?,?)').run(value.public.id, JSON.stringify(value)); record(db, request.commandId, fp, value.public.id); return value.public;
      });
    },
    revoke(request: { commandId: string; id: string }): PreparedSelection {
      return transaction('revoke-prepared', db => { const fp = mediaFingerprint(['revoke', request.id]), prior = receipt(db, request.commandId, fp); if (prior) return selection(db, prior).public; const value = selection(db, request.id); value.public.authorized = false; value.root.authorized = false; db.prepare('UPDATE prepared_selections SET data=? WHERE id=?').run(JSON.stringify(value), request.id); record(db, request.commandId, fp, request.id); return value.public; });
    },
    cachedImport: (request: StartPreparedImportRequest) => read(db => { const prior = receipt(db, request.commandId, mediaFingerprint(['import', request])); return prior ? job(db, prior).public : undefined; }),
    job: (id: string) => read(db => get<StoredPreparedJob>(db, 'prepared_jobs', id)),
    pending: () => read(db => db.prepare("SELECT data FROM prepared_jobs WHERE json_extract(data,'$.public.state') IN ('running','interrupted')").all().map(r => JSON.parse(String(r.data)) as StoredPreparedJob)),
    start(request: StartPreparedImportRequest, input: PreparedInput): StoredPreparedJob {
      return transaction('start-prepared', db => {
        const fp = mediaFingerprint(['import', request]), prior = receipt(db, request.commandId, fp); if (prior) return job(db, prior);
        if (!destinationAuthorized(db, request.destinationId) || request.selectionIds.some(id => !selection(db, id).public.authorized)) return conflict('文件或目标授权已撤销。');
        if (Number(db.prepare('SELECT COUNT(*) AS n FROM prepared_jobs WHERE draft_id=?').get(input.master.draftId)!.n) >= 1000 || Number(db.prepare("SELECT COUNT(*) AS n FROM prepared_jobs WHERE json_extract(data,'$.public.state')='running'").get()!.n) >= 2) return conflict('Render 导入任务已达到上限，请等待或取消。');
        const value: StoredPreparedJob = { public: { id: request.commandId, draftId: input.master.draftId, preparationId: request.preparationId, destinationId: request.destinationId, state: 'running', completedFiles: 0, totalFiles: input.selections.length }, request, input, createdAt: new Date().toISOString(), files: [] };
        save(db, value); record(db, request.commandId, fp, value.public.id); return value;
      });
    },
    update(id: string, patch: Pick<Partial<StoredPreparedJob>, 'owned' | 'files' | 'manifestHash'>, completedFiles?: number): StoredPreparedJob {
      return transaction('progress-prepared', db => { const value = job(db, id); if (value.public.state !== 'running') return value; const result = { ...value, ...patch, public: { ...value.public, ...(completedFiles === undefined ? {} : { completedFiles }) } }; save(db, result); return result; });
    },
    finish(id: string): PreparedImportJob {
      return transaction('finish-prepared', db => {
        const value = job(db, id); if (!['running','interrupted'].includes(value.public.state)) return value.public;
        if (!value.owned || value.owned.purpose !== 'raw-render' || !value.manifestHash || value.public.completedFiles !== value.public.totalFiles || !destinationAuthorized(db, value.public.destinationId)) return conflict('原始 Render 保存证据或目标授权不完整。');
        value.public = { ...value.public, state: 'completed', assets: value.input.proposal.assets, manifestHash: value.manifestHash }; save(db, value); return value.public;
      });
    },
    fail(id: string, failure?: PreparedImportJob['failure']): PreparedImportJob {
      return transaction('fail-prepared', db => { const value = job(db, id); if (value.public.state !== 'running') return value.public; value.public = { ...value.public, state: failure === 'CANCELLED' ? 'cancelled' : failure ? 'failed' : 'interrupted', ...(failure ? { failure } : {}) }; save(db, value); return value.public; });
    },
    cancel(request: { commandId: string; id: string }): PreparedImportJob {
      return transaction('cancel-prepared', db => { const fp = mediaFingerprint(['cancel', request.id]), prior = receipt(db, request.commandId, fp); if (prior) return job(db, prior).public; const value = job(db, request.id); if (['running','interrupted'].includes(value.public.state)) { value.public = { ...value.public, state: 'cancelled', failure: 'CANCELLED' }; save(db, value); } record(db, request.commandId, fp, request.id); return value.public; });
    },
    cachedFreeze: (request: FreezePreparedRequest) => read(db => { const prior = receipt(db, request.commandId, mediaFingerprint(['freeze', request])); return prior ? get<FrozenPrepared>(db, 'prepared_versions', prior) : undefined; }),
    freeze(request: FreezePreparedRequest, review: PreparedReview): FrozenPrepared {
      return transaction('freeze-prepared', db => {
        const fp = mediaFingerprint(['freeze', request]), prior = receipt(db, request.commandId, fp); if (prior) return get<FrozenPrepared>(db, 'prepared_versions', prior)!;
        const imported = job(db, request.importJobId);
        if (imported.public.state !== 'completed' || !destinationAuthorized(db, imported.public.destinationId) || review.proposalFingerprint !== request.proposalFingerprint || !['MATCHED','ACCEPTED_VARIANCE'].includes(review.conformance.status)) return conflict('只能冻结已保存、已确认且符合要求的原始 Render。');
        const sequence = Number(db.prepare('SELECT COUNT(*) AS n FROM prepared_versions WHERE draft_id=?').get(imported.public.draftId)!.n) + 1; if (sequence > 100) return conflict('PREP 版本历史已达到上限。');
        const value: FrozenPrepared = { id: request.commandId, draftId: imported.public.draftId, sequence, preparationId: imported.public.preparationId, importJobId: imported.public.id, masterVersionId: imported.input.master.id, layoutVersionId: imported.input.layout.id, contentHash: imported.input.master.contentHash, plannedTimelineHash: imported.input.layout.timelineHash, plannedTimeline: imported.input.layout.timeline, renderTimeline: request.assessment.timeline, renderTimelineHash: mediaFingerprint(request.assessment.timeline), assets: imported.public.assets!, conformance: review.conformance, varianceReason: request.assessment.varianceReason, daw: request.daw, processingLineage: request.processingLineage, createdAt: new Date().toISOString(), transitionRenderingMode: 'Baked Into Render', status: 'frozen', executionReady: false };
        if (!isFrozenPrepared(value)) return conflict('冻结 PREP 的证据不完整。');
        db.prepare('INSERT INTO prepared_versions VALUES (?,?,?)').run(value.id, value.draftId, JSON.stringify(value)); record(db, request.commandId, fp, value.id); return value;
      });
    },
  };
}
export type PreparedStore = ReturnType<typeof createPreparedStore>;
