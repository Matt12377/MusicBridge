import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { isCollectionId, isStartExecutionRequest, isExecutionProposal, isExecutionAsset, isExecutionJob, isExecutionAudioReceipt, type ExecutionAsset, type ExecutionAudioReceipt, type ExecutionHistory, type ExecutionJob, type ExecutionProposal, type StartExecutionRequest, type MasterVersion, type LayoutVersion, type FrozenPrepared, type RecordingSessionSettings } from '@music-bridge/contracts';
import type { RootCapability } from './source-files.js';
import type { OwnedPreparation, PreparationOutput } from './preparation-files.js';
import type { ExecutionSourceLocation, ExecutionRenderLocation } from './execution-compiler.js';
import { mediaFingerprint } from './media-store.js';

export const executionMigration = `
CREATE TABLE execution_jobs (id TEXT PRIMARY KEY,draft_id TEXT NOT NULL REFERENCES master_drafts(id),data TEXT NOT NULL) STRICT;
CREATE TABLE execution_assets (id TEXT PRIMARY KEY REFERENCES execution_jobs(id),draft_id TEXT NOT NULL REFERENCES master_drafts(id),data TEXT NOT NULL) STRICT;
CREATE TABLE execution_ledger (command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
CREATE TRIGGER execution_assets_no_update BEFORE UPDATE ON execution_assets BEGIN SELECT RAISE(ABORT,'immutable execution asset'); END;
CREATE TRIGGER execution_assets_no_delete BEFORE DELETE ON execution_assets BEGIN SELECT RAISE(ABORT,'immutable execution asset'); END;
CREATE TRIGGER execution_ledger_no_update BEFORE UPDATE ON execution_ledger BEGIN SELECT RAISE(ABORT,'immutable execution ledger'); END;
CREATE TRIGGER execution_ledger_no_delete BEFORE DELETE ON execution_ledger BEGIN SELECT RAISE(ABORT,'immutable execution ledger'); END;
CREATE TRIGGER execution_jobs_completed_no_update BEFORE UPDATE ON execution_jobs WHEN json_extract(OLD.data,'$.public.state')='completed' BEGIN SELECT RAISE(ABORT,'immutable completed execution'); END;
CREATE TRIGGER execution_jobs_no_delete BEFORE DELETE ON execution_jobs BEGIN SELECT RAISE(ABORT,'immutable execution history'); END;
PRAGMA user_version=12;
`;
export interface ExecutionInput {
  master: MasterVersion; layout: LayoutVersion; destination: RootCapability; session: RecordingSessionSettings; proposal: ExecutionProposal;
  sources: readonly ExecutionSourceLocation[];
  retained?: { prepared: FrozenPrepared; owned: OwnedPreparation; files: readonly PreparationOutput[]; manifestHash: string; locations: readonly ExecutionRenderLocation[] };
}
export interface StoredExecutionJob { public: ExecutionJob; request: StartExecutionRequest; input: ExecutionInput; createdAt: string; owned?: OwnedPreparation; files: readonly PreparationOutput[]; audio: readonly ExecutionAudioReceipt[]; manifestHash?: string }
/** 清单只含公开谱系与相对输出名；源路径和授权 capability 仅留在 Core 数据库。 */
export function executionManifest(job: StoredExecutionJob): Buffer {
  const p = job.input.proposal;
  return Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'execution-audio', assetId: job.public.id, draftId: p.draftId, masterVersionId: p.masterVersionId, layoutVersionId: p.layoutVersionId, mode: p.mode, ...(p.preparedVersionId ? { preparedVersionId: p.preparedVersionId } : {}), settings: p.settings, recipes: p.recipes, audio: job.audio, files: job.files, createdAt: job.createdAt, retentionPolicy: p.retentionPolicy, formalReady: false }, null, 2) + '\n');
}
export const executionManifestHash = (job: StoredExecutionJob): string => createHash('sha256').update(executionManifest(job)).digest('hex');
export function executionAssetFromJob(job: StoredExecutionJob): ExecutionAsset {
  const p = job.input.proposal;
  return { id: job.public.id, draftId: p.draftId, masterVersionId: p.masterVersionId, layoutVersionId: p.layoutVersionId, destinationId: p.destinationId, mode: p.mode, ...(p.preparedVersionId ? { preparedVersionId: p.preparedVersionId } : {}), settings: p.settings, recipes: p.recipes, audio: job.audio, manifestHash: job.manifestHash ?? '', createdAt: job.createdAt, state: 'verified-at-publication', retentionPolicy: p.retentionPolicy, formalReady: false };
}
export function executionPublicationComplete(job: StoredExecutionJob): boolean {
  const asset = executionAssetFromJob(job);
  return !!job.owned && job.owned.id === job.public.id && job.owned.purpose === 'execution' && mediaFingerprint(job.owned.destination) === mediaFingerprint(job.input.destination) && isExecutionAsset(asset) && job.public.completedSides === job.public.totalSides && job.audio.every(a => a.recipeHash === mediaFingerprint(a.recipe)) && job.manifestHash === executionManifestHash(job) && (job.public.mode === 'direct' ? job.files.length === job.audio.length && job.files.every((f,i) => f.relative === `Audio/${job.audio[i]!.recipe.side}.execution.wav` && f.sha256 === job.audio[i]!.audio.sha256 && f.size === job.audio[i]!.audio.size) : job.files.length === 0 && !!job.input.retained);
}
interface Access { read<T>(fn: (db: DatabaseSync) => T): T; conflict(message: string): never; beforeCommit?: (action: string) => void }
export function createExecutionStore({ read, conflict, beforeCommit }: Access) {
  const get = <T>(db: DatabaseSync, table: string, id: string): T | undefined => { const row = db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id); return row ? JSON.parse(String(row.data)) as T : undefined; };
  const job = (db: DatabaseSync, id: string): StoredExecutionJob => get<StoredExecutionJob>(db, 'execution_jobs', id) ?? conflict('执行任务不存在。');
  const put = (db: DatabaseSync, value: StoredExecutionJob): void => { if (!isExecutionJob(value.public)) return conflict('执行任务状态无效。'); db.prepare('INSERT INTO execution_jobs VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(value.public.id, value.public.draftId, JSON.stringify(value)); };
  const destination = (db: DatabaseSync, id: string): RootCapability | undefined => get<RootCapability>(db, 'preparation_destinations', id);
  const authorized = (db: DatabaseSync, input: ExecutionInput): boolean => destination(db, input.destination.id)?.authorized === true && mediaFingerprint(destination(db, input.destination.id)) === mediaFingerprint(input.destination) && (!input.retained || destination(db, input.retained.owned.destination.id)?.authorized === true);
  const receipt = (db: DatabaseSync, id: string, fingerprint: string): string | undefined => { const row = db.prepare('SELECT fingerprint,result FROM execution_ledger WHERE command_id=?').get(id); if (row && row.fingerprint !== fingerprint) return conflict('原操作编号不能用于不同的执行请求。'); return row ? String(row.result) : undefined; };
  const record = (db: DatabaseSync, id: string, fp: string, result: string): void => { db.prepare('INSERT INTO execution_ledger VALUES (?,?,?,?)').run(id, fp, result, new Date().toISOString()); };
  function transaction<T>(action: string, fn: (db: DatabaseSync) => T): T { return read(db => { db.exec('BEGIN IMMEDIATE'); try { const value = fn(db); beforeCommit?.(action); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } }); }
  return {
    list(draftId: string): ExecutionHistory { return read(db => {
      if (!isCollectionId(draftId) || !db.prepare('SELECT id FROM master_drafts WHERE id=?').get(draftId)) return conflict('草稿不存在。');
      return { draftId, assets: db.prepare('SELECT data FROM execution_assets WHERE draft_id=? ORDER BY rowid DESC').all(draftId).map(row => { const v: unknown = JSON.parse(String(row.data)); if (!isExecutionAsset(v)) return conflict('执行资产记录损坏。'); return v; }), jobs: db.prepare('SELECT data FROM execution_jobs WHERE draft_id=? ORDER BY rowid DESC').all(draftId).map(row => (JSON.parse(String(row.data)) as StoredExecutionJob).public) };
    }); },
    job: (id: string) => read(db => get<StoredExecutionJob>(db, 'execution_jobs', id)),
    asset: (id: string) => read(db => get<ExecutionAsset>(db, 'execution_assets', id)),
    pending: () => read(db => db.prepare("SELECT data FROM execution_jobs WHERE json_extract(data,'$.public.state') IN ('running','interrupted') ORDER BY rowid").all().map(row => JSON.parse(String(row.data)) as StoredExecutionJob)),
    cached: (request: StartExecutionRequest) => read(db => { const id = receipt(db, request.commandId, mediaFingerprint(['start', request])); return id ? job(db, id).public : undefined; }),
    start(request: StartExecutionRequest, input: ExecutionInput): StoredExecutionJob {
      if (!isStartExecutionRequest(request) || !isExecutionProposal(input.proposal)) return conflict('执行提案无效或尚未确认。');
      return transaction('start-execution', db => {
        const fp = mediaFingerprint(['start', request]), prior = receipt(db, request.commandId, fp); if (prior) return job(db, prior);
        const p = input.proposal, sessionRow = db.prepare('SELECT data FROM recording_sessions WHERE draft_id=?').get(p.draftId);
        if (!authorized(db, input) || !sessionRow || mediaFingerprint(JSON.parse(String(sessionRow.data))) !== mediaFingerprint(input.session) || input.session.revision !== request.sessionRevision || input.session.profileVersionId !== p.settings.profile.id || p.proposalFingerprint !== request.proposalFingerprint || p.layoutVersionId !== request.layoutVersionId || p.destinationId !== request.destinationId || p.mode !== request.mode || p.preparedVersionId !== request.preparedVersionId) return conflict('参数或目标授权已改变，请重新预览。');
        if (mediaFingerprint(get(db, 'master_versions', p.masterVersionId)) !== mediaFingerprint(input.master) || mediaFingerprint(get(db, 'layout_versions', p.layoutVersionId)) !== mediaFingerprint(input.layout) || mediaFingerprint(get(db, 'recording_profile_versions', p.settings.profile.id)) !== mediaFingerprint(p.settings.profile) || input.retained && mediaFingerprint(get(db, 'prepared_versions', input.retained.prepared.id)) !== mediaFingerprint(input.retained.prepared)) return conflict('冻结版本或参数证据已改变。');
        if (Number(db.prepare('SELECT count(*) n FROM execution_jobs WHERE draft_id=?').get(p.draftId)!.n) >= 1000 || Number(db.prepare("SELECT count(*) n FROM execution_jobs WHERE json_extract(data,'$.public.state')='running'").get()!.n) >= 2 || Number(db.prepare("SELECT count(*) n FROM execution_jobs WHERE draft_id=? AND json_extract(data,'$.public.state') IN ('running','interrupted','completed')").get(p.draftId)!.n) >= 100) return conflict('执行资产任务已达到上限，请等待或取消。');
        const value: StoredExecutionJob = { public: { id: request.commandId, draftId: p.draftId, layoutVersionId: p.layoutVersionId, destinationId: p.destinationId, profileVersionId: p.settings.profile.id, mode: p.mode, state: 'running', completedSides: 0, totalSides: p.recipes.filter(r => r.totalFrames > 0).length }, request: structuredClone(request), input: structuredClone(input), createdAt: new Date().toISOString(), files: [], audio: [] };
        put(db, value); record(db, request.commandId, fp, value.public.id); return value;
      });
    },
    update(id: string, patch: Pick<Partial<StoredExecutionJob>, 'owned' | 'files' | 'audio' | 'manifestHash'>): StoredExecutionJob {
      return transaction('progress-execution', db => {
        const value = job(db, id); if (value.public.state !== 'running') return value;
        const next = { ...value, ...structuredClone(patch) }, recipes = next.input.proposal.recipes.filter(r => r.totalFrames > 0);
        if (next.audio.length < value.audio.length || next.audio.length > recipes.length || !next.audio.every((a,i) => isExecutionAudioReceipt(a) && a.recipeHash === mediaFingerprint(a.recipe) && mediaFingerprint(a.recipe) === mediaFingerprint(recipes[i])) || value.owned && mediaFingerprint(next.owned) !== mediaFingerprint(value.owned)) return conflict('执行进度与冻结配方不符。');
        next.public = { ...next.public, completedSides: next.audio.length }; put(db, next); return next;
      });
    },
    finish(id: string): ExecutionJob {
      return transaction('finish-execution', db => {
        const value = job(db, id); if (value.public.state !== 'running' && value.public.state !== 'interrupted') return value.public;
        if (!executionPublicationComplete(value) || !authorized(db, value.input)) return conflict('执行文件发布证据或授权不完整。');
        const asset = executionAssetFromJob(value); db.prepare('INSERT INTO execution_assets VALUES (?,?,?)').run(asset.id, asset.draftId, JSON.stringify(asset));
        value.public = { ...value.public, state: 'completed', assetId: asset.id }; put(db, value); return value.public;
      });
    },
    fail(id: string, failure?: ExecutionJob['failure']): ExecutionJob { return transaction('fail-execution', db => { const value = job(db, id); if (value.public.state !== 'running') return value.public; value.public = { ...value.public, state: failure === 'CANCELLED' ? 'cancelled' : failure ? 'failed' : 'interrupted', ...(failure ? { failure } : {}) }; put(db, value); return value.public; }); },
    cancel(request: { commandId: string; id: string }): ExecutionJob { return transaction('cancel-execution', db => { const fp = mediaFingerprint(['cancel', request.id]), prior = receipt(db, request.commandId, fp); if (prior) return job(db, prior).public; const value = job(db, request.id); if (value.public.state === 'running' || value.public.state === 'interrupted') { value.public = { ...value.public, state: 'cancelled', failure: 'CANCELLED' }; put(db, value); } record(db, request.commandId, fp, request.id); return value.public; }); },
  };
}
export type ExecutionStore = ReturnType<typeof createExecutionStore>;
