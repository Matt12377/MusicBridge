import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { isCollectionId, isPreparationZipJob, isPreparationZipProposal, isPreparationWorkspace, isStartPreparationZipRequest, type PreparationZipFailure, type PreparationZipHistory, type PreparationZipJob, type PreparationZipProposal, type PreparationZipReceiptRequest, type StartPreparationZipRequest } from '@music-bridge/contracts';
import type { RootCapability } from './source-files.js';
import type { OwnedPreparation, PreparationOutput } from './preparation-files.js';
import type { ZipEntryDescription } from './verified-zip.js';
import { mediaFingerprint } from './media-store.js';

const zipJobsTable = 'CREATE TABLE preparation_zip_jobs (id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES preparation_workspaces(id),draft_id TEXT NOT NULL REFERENCES master_drafts(id),data TEXT NOT NULL) STRICT';
const zipLedgerTable = 'CREATE TABLE preparation_zip_ledger (command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,job_id TEXT NOT NULL,created_at TEXT NOT NULL) STRICT';
const zipLedgerUpdateTrigger = "CREATE TRIGGER preparation_zip_ledger_no_update BEFORE UPDATE ON preparation_zip_ledger BEGIN SELECT RAISE(ABORT,'immutable preparation zip ledger'); END";
const zipLedgerDeleteTrigger = "CREATE TRIGGER preparation_zip_ledger_no_delete BEFORE DELETE ON preparation_zip_ledger BEGIN SELECT RAISE(ABORT,'immutable preparation zip ledger'); END";
const zipSessionTable = 'CREATE TABLE preparation_zip_session (id INTEGER PRIMARY KEY CHECK(id=1),epoch INTEGER NOT NULL CHECK(epoch BETWEEN 0 AND 9007199254740991)) STRICT';
const zipTargetsTable = 'CREATE TABLE preparation_zip_targets (id TEXT PRIMARY KEY,epoch INTEGER NOT NULL,dataset_id TEXT NOT NULL,scope_id TEXT NOT NULL,generation INTEGER NOT NULL,expires_at TEXT NOT NULL,fingerprint TEXT NOT NULL,revoked_at TEXT) STRICT';
const zipTargetsScopeIndex = 'CREATE INDEX preparation_zip_targets_scope ON preparation_zip_targets(epoch,scope_id,generation)';
const zipTargetsNoRebindTrigger = "CREATE TRIGGER preparation_zip_targets_no_rebind BEFORE UPDATE ON preparation_zip_targets WHEN OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR NEW.id!=OLD.id OR NEW.epoch!=OLD.epoch OR NEW.dataset_id!=OLD.dataset_id OR NEW.scope_id!=OLD.scope_id OR NEW.generation!=OLD.generation OR NEW.expires_at!=OLD.expires_at OR NEW.fingerprint!=OLD.fingerprint BEGIN SELECT RAISE(ABORT,'immutable preparation zip target revocation'); END";
const zipTargetsNoDeleteTrigger = "CREATE TRIGGER preparation_zip_targets_no_delete BEFORE DELETE ON preparation_zip_targets BEGIN SELECT RAISE(ABORT,'immutable preparation zip target'); END";
/** 仅在 schema25 安全屏障之后迁入；接线由集合仓储统一控制顺序。 */
export const preparationZipMigration = `${zipJobsTable};\n${zipLedgerTable};\n${zipLedgerUpdateTrigger};\n${zipLedgerDeleteTrigger};\n`;
/** schema30：只存目标绑定摘要与不可逆撤销，不把用户本机路径另存到授权表。 */
export const preparationZipSessionMigration = `${zipSessionTable};\nINSERT INTO preparation_zip_session VALUES (1,0);\n${zipTargetsTable};\n${zipTargetsScopeIndex};\n${zipTargetsNoRebindTrigger};\n${zipTargetsNoDeleteTrigger};\nPRAGMA user_version=30;\n`;
export interface PreparationZipTargetBinding {
  id: string; absolute: string; parent: RootCapability; datasetId: string; scopeId: string; generation: number; expiresAt: string;
}
export interface PreparationZipWorkspaceSnapshot {
  owned: OwnedPreparation; files: readonly PreparationOutput[]; manifestHash: string;
}
export interface ZipFileIdentity { dev: string; ino: string }
export interface StoredPreparationZipJob {
  public: PreparationZipJob;
  request: StartPreparationZipRequest;
  proposal: PreparationZipProposal;
  target: PreparationZipTargetBinding;
  workspace: PreparationZipWorkspaceSnapshot;
  packageManifest: string;
  entries: readonly ZipEntryDescription[];
  createdAt: string;
  temp?: ZipFileIdentity;
  verified?: { sha256: string; size: number };
  recoveryRevoked?: true;
}
interface Access { read<T>(fn: (db: DatabaseSync) => T): T; conflict(message: string): never; beforeCommit?: (action: string) => void; afterReceiptLedgerRead?: () => void }
const MAX_JOB_BYTES = 1024 * 1024;
const MAX_ALL_JOB_BYTES = 64 * 1024 * 1024;
const MAX_JOBS = 10_000;
const MAX_LEDGER = 40_000;
const MAX_TARGETS = 40_000;
export function createPreparationZipStore({ read, conflict, beforeCommit, afterReceiptLedgerRead }: Access) {
  const decode = (row: Record<string, unknown>): StoredPreparationZipJob => {
    if (typeof row.data !== 'string' || Buffer.byteLength(row.data) > MAX_JOB_BYTES) failAudit();
    let parsed: unknown;
    try { parsed = JSON.parse(row.data); } catch { failAudit(); }
    if (!stored(parsed) || row.id !== parsed.public.id || row.workspace_id !== parsed.public.workspaceId || row.draft_id !== parsed.public.draftId) failAudit();
    return parsed;
  };
  const get = (db: DatabaseSync, id: string): StoredPreparationZipJob | undefined => {
    const row = db.prepare('SELECT id,workspace_id,draft_id,data FROM preparation_zip_jobs WHERE id=?').get(id);
    return row ? decode(row) : undefined;
  };
  const required = (db: DatabaseSync, id: string): StoredPreparationZipJob => get(db, id) ?? conflict('ZIP 导出任务不存在。');
  const save = (db: DatabaseSync, job: StoredPreparationZipJob): void => {
    if (!stored(job)) failAudit();
    const encoded = JSON.stringify(job), size = Buffer.byteLength(encoded);
    const prior = Number(db.prepare('SELECT length(CAST(data AS BLOB)) AS n FROM preparation_zip_jobs WHERE id=?').get(job.public.id)?.n ?? 0);
    const total = Number(db.prepare('SELECT coalesce(sum(length(CAST(data AS BLOB))),0) AS n FROM preparation_zip_jobs').get()!.n);
    if (size > MAX_JOB_BYTES || total - prior + size > MAX_ALL_JOB_BYTES) return conflict('ZIP 任务记录预算已达到上限。');
    db.prepare('INSERT INTO preparation_zip_jobs VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(job.public.id, job.public.workspaceId, job.public.draftId, encoded);
  };
  function transaction<T>(action: string, fn: (db: DatabaseSync) => T): T {
    return read(db => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(db); beforeCommit?.(action); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } });
  }
  const fingerprint = (request: StartPreparationZipRequest): string => mediaFingerprint(['start-preparation-zip', request]);
  const currentEpoch = (db: DatabaseSync): number => {
    const rows = db.prepare('SELECT id,epoch FROM preparation_zip_session').all();
    if (rows.length !== 1 || rows[0]?.id !== 1 || !Number.isSafeInteger(rows[0]?.epoch) || Number(rows[0]?.epoch) < 0) failAudit();
    return Number(rows[0]!.epoch);
  };
  const requireEpoch = (db: DatabaseSync, epoch: number): void => {
    if (!Number.isSafeInteger(epoch) || epoch < 1 || currentEpoch(db) !== epoch) conflict('ZIP 会话已被新 Core 撤销。');
  };
  const targetFingerprint = (target: PreparationZipTargetBinding): string => mediaFingerprint(target);
  const revoke = (db: DatabaseSync, where: string, values: readonly (string | number)[]): void => {
    db.prepare(`UPDATE preparation_zip_targets SET revoked_at=? WHERE ${where} AND revoked_at IS NULL`).run(new Date().toISOString(), ...values);
  };
  function prior(db: DatabaseSync, commandId: string, fp: string): StoredPreparationZipJob | undefined {
    const row = db.prepare('SELECT fingerprint,job_id,created_at FROM preparation_zip_ledger WHERE command_id=?').get(commandId);
    if (row && row.fingerprint !== fp) return conflict('同一操作编号不能用于不同 ZIP 请求。');
    if (!row) return undefined;
    if (!hex(row.fingerprint) || !isCollectionId(row.job_id) || !iso(row.created_at)) failAudit();
    const cached = required(db, row.job_id);
    if (commandId === cached.public.id ? fp !== fingerprint(cached.request) : fp !== mediaFingerprint(['cancel-preparation-zip', cached.public.id])) failAudit();
    return cached;
  }
  return {
    /** 与其他 Core 抢同一库时，推进 epoch 和撤销旧目标必须原子提交。 */
    bootSession(): number {
      return transaction('boot-preparation-zip-session', db => {
        const prior = currentEpoch(db);
        if (prior >= Number.MAX_SAFE_INTEGER) return conflict('ZIP 会话代际已达到上限。');
        const epoch = prior + 1;
        db.prepare('UPDATE preparation_zip_session SET epoch=? WHERE id=1').run(epoch);
        revoke(db, 'epoch<?', [epoch]);
        return epoch;
      });
    },
    sessionCurrent: (epoch: number): boolean => read(db => currentEpoch(db) === epoch),
    targetCurrent: (target: PreparationZipTargetBinding, epoch: number): boolean => read(db => {
      if (currentEpoch(db) !== epoch) return false;
      const row = db.prepare('SELECT epoch,fingerprint,revoked_at FROM preparation_zip_targets WHERE id=?').get(target.id);
      return row?.epoch === epoch && row.fingerprint === targetFingerprint(target) && row.revoked_at === null;
    }),
    authorizeTarget(target: PreparationZipTargetBinding, epoch: number): void {
      transaction('authorize-preparation-zip-target', db => {
        requireEpoch(db, epoch);
        if (db.prepare('SELECT id FROM preparation_zip_targets WHERE id=?').get(target.id)) return conflict('ZIP 目标编号不可重复授权。');
        if (Number(db.prepare('SELECT count(*) AS n FROM preparation_zip_targets').get()!.n) >= MAX_TARGETS) return conflict('ZIP 目标授权预算已达到上限。');
        const row = db.prepare('SELECT max(generation) AS generation FROM preparation_zip_targets WHERE epoch=? AND scope_id=?').get(epoch, target.scopeId);
        const generation = row?.generation === null ? undefined : Number(row?.generation);
        if (generation !== undefined && (!Number.isSafeInteger(generation) || generation > target.generation)) return conflict('ZIP 目标代际已失效。');
        if (generation !== undefined && generation < target.generation) revoke(db, 'epoch=? AND scope_id=?', [epoch, target.scopeId]);
        db.prepare('INSERT INTO preparation_zip_targets VALUES (?,?,?,?,?,?,?,NULL)').run(target.id, epoch, target.datasetId, target.scopeId, target.generation, target.expiresAt, targetFingerprint(target));
      });
    },
    revokeScope(scopeId: string, epoch: number): void {
      transaction('revoke-preparation-zip-scope', db => {
        if (currentEpoch(db) === epoch) revoke(db, 'epoch=? AND scope_id=?', [epoch, scopeId]);
      });
    },
    revokeSession(epoch: number): void {
      transaction('revoke-preparation-zip-session', db => {
        if (currentEpoch(db) === epoch) revoke(db, 'epoch=?', [epoch]);
      });
    },
    expireTarget(id: string, epoch: number): void {
      transaction('expire-preparation-zip-target', db => {
        if (currentEpoch(db) !== epoch) return;
        const row = db.prepare('SELECT expires_at FROM preparation_zip_targets WHERE id=? AND epoch=? AND revoked_at IS NULL').get(id, epoch);
        if (row && iso(row.expires_at) && Date.now() >= Date.parse(String(row.expires_at))) revoke(db, 'id=? AND epoch=?', [id, epoch]);
      });
    },
    list(draftId: string): PreparationZipHistory {
      return read(db => {
        if (!isCollectionId(draftId) || !db.prepare('SELECT id FROM master_drafts WHERE id=?').get(draftId)) return conflict('草稿不存在，请刷新。');
        return { draftId, jobs: db.prepare('SELECT id,workspace_id,draft_id,data FROM preparation_zip_jobs WHERE draft_id=? ORDER BY rowid DESC').all(draftId).map(row => decode(row).public) };
      });
    },
    job: (id: string): StoredPreparationZipJob | undefined => read(db => get(db, id)),
    receipt: (request: PreparationZipReceiptRequest): { status: 'accepted' | 'not-accepted' | 'unknown'; job: PreparationZipJob | null } => read(db => {
      // 首次 ledger SELECT 固定 WAL 读快照；跨 Core 的提交和 boot 不能拼成伪造的“未接受”。
      db.exec('BEGIN DEFERRED');
      try {
        const fp = request.kind === 'start' ? mediaFingerprint(['start-preparation-zip', request.request]) : mediaFingerprint(['cancel-preparation-zip', request.request.id]);
        const job = prior(db, request.request.commandId, fp)?.public;
        afterReceiptLedgerRead?.();
        const result = job ? { status: 'accepted' as const, job }
          : request.kind === 'cancel' ? { status: 'unknown' as const, job: null }
          : (() => {
            const row = db.prepare('SELECT epoch,revoked_at FROM preparation_zip_targets WHERE id=?').get(request.request.targetId);
            return { status: row && (row.revoked_at !== null || Number(row.epoch) < currentEpoch(db)) ? 'not-accepted' as const : 'unknown' as const, job: null };
          })();
        db.exec('COMMIT');
        return result;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }),
    cached: (request: StartPreparationZipRequest): StoredPreparationZipJob | undefined => read(db => prior(db, request.commandId, fingerprint(request))),
    recoverable: (): StoredPreparationZipJob[] => read(db => db.prepare("SELECT id,workspace_id,draft_id,data FROM preparation_zip_jobs WHERE json_extract(data,'$.public.state') IN ('running','cancelling','interrupted','cancelled','failed')").all().map(decode)),
    start(job: StoredPreparationZipJob, epoch: number): StoredPreparationZipJob {
      return transaction('start-preparation-zip', db => {
        requireEpoch(db, epoch);
        if (job.public.state !== 'running' || job.public.completedFiles !== 0 || job.temp || job.verified || job.recoveryRevoked) return conflict('ZIP 启动状态无效。');
        const fp = fingerprint(job.request), existing = prior(db, job.request.commandId, fp);
        if (existing) return existing;
        const target = db.prepare('SELECT epoch,dataset_id,scope_id,generation,expires_at,fingerprint,revoked_at FROM preparation_zip_targets WHERE id=?').get(job.target.id);
        if (!target || target.epoch !== epoch || target.dataset_id !== job.target.datasetId || target.scope_id !== job.target.scopeId || target.generation !== job.target.generation || target.expires_at !== job.target.expiresAt || target.fingerprint !== targetFingerprint(job.target) || target.revoked_at !== null || Date.now() >= Date.parse(job.target.expiresAt)) return conflict('ZIP 另存目标已失效。');
        if (!db.prepare('SELECT id FROM preparation_workspaces WHERE id=? AND draft_id=?').get(job.public.workspaceId, job.public.draftId)) return conflict('工作区不再存在。');
        if (Number(db.prepare('SELECT count(*) AS n FROM preparation_zip_jobs').get()!.n) >= MAX_JOBS || Number(db.prepare('SELECT count(*) AS n FROM preparation_zip_ledger').get()!.n) >= MAX_LEDGER) return conflict('ZIP 任务总预算已达到上限。');
        if (Number(db.prepare('SELECT count(*) AS n FROM preparation_zip_jobs WHERE draft_id=?').get(job.public.draftId)!.n) >= 1000) return conflict('ZIP 任务历史已达到上限。');
        if (Number(db.prepare("SELECT count(*) AS n FROM preparation_zip_jobs WHERE json_extract(data,'$.public.state') IN ('running','cancelling')").get()!.n) >= 1) return conflict('已有 ZIP 任务在运行，请等待或取消。');
        save(db, job);
        db.prepare('INSERT INTO preparation_zip_ledger VALUES (?,?,?,?)').run(job.request.commandId, fp, job.public.id, new Date().toISOString());
        return job;
      });
    },
    temp(id: string, identity: ZipFileIdentity, epoch: number): StoredPreparationZipJob {
      return transaction('stage-preparation-zip', db => {
        requireEpoch(db, epoch);
        const current = required(db, id);
        if (current.public.state !== 'running' || current.temp) return conflict('ZIP 临时文件意图已失效。');
        const result = { ...current, temp: identity };
        save(db, result); return result;
      });
    },
    verified(id: string, receipt: { sha256: string; size: number }, epoch: number): StoredPreparationZipJob {
      return transaction('verify-preparation-zip', db => {
        requireEpoch(db, epoch);
        const current = required(db, id);
        if (current.public.state !== 'running' || !current.temp || current.verified) return conflict('ZIP 校验意图已失效。');
        const result: StoredPreparationZipJob = { ...current, verified: receipt, public: { ...current.public, completedFiles: current.public.fileCount } };
        save(db, result); return result;
      });
    },
    finish(id: string, epoch: number): PreparationZipJob {
      return transaction('finish-preparation-zip', db => {
        requireEpoch(db, epoch);
        const current = required(db, id);
        if (current.public.state === 'completed') return current.public;
        if (!current.temp || !current.verified) return conflict('ZIP 发布回执不完整。');
        const { failure: _failure, ...previous } = current.public;
        current.public = { ...previous, state: 'completed', completedFiles: current.public.fileCount, zipSha256: current.verified.sha256, zipBytes: current.verified.size };
        save(db, current); return current.public;
      });
    },
    fail(id: string, epoch: number, failure?: PreparationZipFailure): PreparationZipJob {
      return transaction('fail-preparation-zip', db => {
        requireEpoch(db, epoch);
        const current = required(db, id);
        if (current.public.state !== 'running' && current.public.state !== 'cancelling') return current.public;
        current.public = { ...current.public, state: failure === 'CANCELLED' ? 'cancelled' : failure ? 'failed' : 'interrupted', ...(failure ? { failure } : {}) };
        save(db, current); return current.public;
      });
    },
    cancel(request: { commandId: string; id: string }, epoch: number): PreparationZipJob {
      return transaction('cancel-preparation-zip', db => {
        requireEpoch(db, epoch);
        const fp = mediaFingerprint(['cancel-preparation-zip', request.id]), cached = prior(db, request.commandId, fp);
        if (cached) return cached.public;
        const current = required(db, request.id);
        if (Number(db.prepare('SELECT count(*) AS n FROM preparation_zip_ledger').get()!.n) >= MAX_LEDGER || Number(db.prepare('SELECT count(*) AS n FROM preparation_zip_ledger WHERE job_id=?').get(request.id)!.n) >= 17) return conflict('ZIP 取消回执预算已达到上限。');
        if (current.public.state === 'running') { current.public = { ...current.public, state: 'cancelling' }; save(db, current); }
        db.prepare('INSERT INTO preparation_zip_ledger VALUES (?,?,?,?)').run(request.commandId, fp, request.id, new Date().toISOString());
        return current.public;
      });
    },
    completeCancellation(id: string, epoch: number): PreparationZipJob {
      return transaction('complete-cancel-preparation-zip', db => {
        requireEpoch(db, epoch);
        const current = required(db, id);
        if (current.public.state !== 'cancelling') return current.public;
        current.public = { ...current.public, state: 'cancelled', failure: 'CANCELLED' };
        save(db, current); return current.public;
      });
    },
    revokeTarget(id: string, epoch: number): PreparationZipJob {
      return transaction('revoke-preparation-zip-target', db => {
        requireEpoch(db, epoch);
        const current = required(db, id);
        if (current.public.state === 'completed') return current.public;
        current.recoveryRevoked = true;
        const { failure: _failure, ...previous } = current.public;
        current.public = { ...previous, state: 'failed', failure: 'TARGET_INVALID' };
        save(db, current); return current.public;
      });
    },
  };
}
export type PreparationZipStore = ReturnType<typeof createPreparationZipStore>;

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const exactly = (value: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(value).every(key => allowed.includes(key));
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const numeric = (value: unknown): value is string => typeof value === 'string' && /^\d+$/u.test(value);
const iso = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value));
function failAudit(): never { throw new Error('Preparation ZIP 持久记录或引用闭包无效。'); }
const same = (a: unknown, b: unknown): boolean => mediaFingerprint(a) === mediaFingerprint(b);
function root(value: unknown): value is RootCapability {
  return object(value) && exactly(value, ['id','path','dev','ino','authorized','label']) && isCollectionId(value.id) && typeof value.path === 'string' && path.isAbsolute(value.path) && value.path.length <= 4096 && !value.path.includes('\0') && !value.path.split(path.sep).some(part => part === '.' || part === '..') && numeric(value.dev) && numeric(value.ino) && value.authorized === true && typeof value.label === 'string' && value.label.length <= 240;
}
function descriptor(value: unknown): value is PreparationOutput {
  return object(value) && exactly(value, ['relative','sha256','size']) && typeof value.relative === 'string' && /^(?:Sources\/[0-9]{3}\.(?:wav|aiff|flac)|Tracklist\.tsv|SourceLineage\.json|README\.txt)$/u.test(value.relative) && hex(value.sha256) && typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size >= 0 && value.size <= 68_719_476_736;
}
function fileIdentity(value: unknown): value is ZipFileIdentity { return object(value) && exactly(value, ['dev','ino']) && numeric(value.dev) && numeric(value.ino); }
function stored(value: unknown): value is StoredPreparationZipJob {
  if (!object(value) || !exactly(value, ['public','request','proposal','target','workspace','packageManifest','entries','createdAt','temp','verified','recoveryRevoked']) || !isPreparationZipJob(value.public) || !isStartPreparationZipRequest(value.request) || !isPreparationZipProposal(value.proposal) || !iso(value.createdAt)) return false;
  const job = value as unknown as StoredPreparationZipJob;
  if (job.public.id !== job.request.commandId || job.public.workspaceId !== job.request.workspaceId || job.public.draftId !== job.proposal.draftId || job.public.fileCount !== job.proposal.fileCount || job.request.targetId !== job.proposal.targetId || job.request.proposalFingerprint !== job.proposal.proposalFingerprint || job.proposal.workspaceId !== job.public.workspaceId || job.public.targetLabel !== job.proposal.targetLabel) return false;
  if (!object(value.target) || !exactly(value.target, ['id','absolute','parent','datasetId','scopeId','generation','expiresAt']) || !isCollectionId(value.target.id) || value.target.id !== job.request.targetId || !isCollectionId(value.target.datasetId) || !isCollectionId(value.target.scopeId) || !Number.isSafeInteger(value.target.generation) || Number(value.target.generation) < 0 || !iso(value.target.expiresAt) || !root(value.target.parent) || typeof value.target.absolute !== 'string' || !path.isAbsolute(value.target.absolute) || value.target.absolute.length > 4096 || value.target.absolute.includes('\0') || value.target.absolute.split(path.sep).some(part => part === '.' || part === '..') || value.target.absolute !== path.join(value.target.parent.path, path.basename(value.target.absolute)) || path.basename(value.target.absolute) !== job.public.targetLabel) return false;
  if (!object(value.workspace) || !exactly(value.workspace, ['owned','files','manifestHash']) || !hex(value.workspace.manifestHash) || value.workspace.manifestHash !== job.proposal.manifestHash || !Array.isArray(value.workspace.files) || value.workspace.files.length < 1 || value.workspace.files.length > 203 || !value.workspace.files.every(descriptor) || new Set(value.workspace.files.map((file: PreparationOutput) => file.relative)).size !== value.workspace.files.length) return false;
  const owned = value.workspace.owned;
  if (!object(owned) || !exactly(owned, ['id','root','destination','owner','directories','purpose']) || owned.id !== job.public.workspaceId || owned.purpose !== undefined || !root(owned.root) || !root(owned.destination) || owned.root.path !== path.join(owned.destination.path, `MusicBridge-Preparation-${owned.id}`) || typeof owned.owner !== 'string' || owned.owner.length > 1024 || !Array.isArray(owned.directories) || !owned.directories.every(root)) return false;
  let marker: unknown;
  try { marker = JSON.parse(owned.owner); } catch { return false; }
  if (!object(marker) || marker.format !== 1 || marker.operationId !== owned.id || !isCollectionId(marker.nonce) || owned.owner !== JSON.stringify(marker)) return false;
  const ownedRoot = owned.root;
  if (!root(ownedRoot)) return false;
  const directories = owned.directories.map((directory: RootCapability) => path.relative(ownedRoot.path, directory.path).split(path.sep).join('/'));
  const cassette = ['Sources','Bounce Targets','Bounce Targets/A','Bounce Targets/B'], dat = ['Sources','Bounce Targets','Bounce Targets/Program'];
  if (!same(directories, cassette) && !same(directories, dat)) return false;
  if (!Array.isArray(value.entries) || value.entries.length !== directories.length + job.workspace.files.length + 2 || value.entries.length > 210 || !value.entries.every(entry => object(entry) && exactly(entry, ['name','kind','size','sha256']) && typeof entry.name === 'string' && (entry.kind === 'directory' || entry.kind === 'file') && typeof entry.size === 'number' && Number.isSafeInteger(entry.size) && entry.size >= 0 && entry.size <= 68_719_476_736 && (entry.kind === 'directory' ? entry.sha256 === undefined && entry.size === 0 : hex(entry.sha256)))) return false;
  const files = [...job.workspace.files].sort((a, b) => a.relative.localeCompare(b.relative, 'en-US'));
  const packageManifest = JSON.stringify({ schemaVersion: 1, kind: 'musicbridge-preparation-zip', workspaceId: job.public.workspaceId, masterVersionId: job.proposal.masterVersionId, layoutVersionId: job.proposal.layoutVersionId, manifestHash: job.workspace.manifestHash, files, directories, executionReady: false }, null, 2) + '\n';
  if (typeof value.packageManifest !== 'string' || Buffer.byteLength(value.packageManifest) > 4 * 1024 * 1024 || value.packageManifest !== packageManifest) return false;
  const entries: ZipEntryDescription[] = value.entries as ZipEntryDescription[];
  const prefix: ZipEntryDescription[] = [...directories.map(name => ({ name: `${name}/`, kind: 'directory' as const, size: 0 })), ...files.map(file => ({ name: file.relative, kind: 'file' as const, size: file.size, sha256: file.sha256 }))];
  if (!same(entries.slice(0, -2), prefix) || !same(entries.at(-2), { name: 'Manifest.json', kind: 'file', size: entries.at(-2)?.size, sha256: job.workspace.manifestHash }) || !Number.isSafeInteger(entries.at(-2)?.size) || entries.at(-2)!.size < 1 || entries.at(-2)!.size > 4 * 1024 * 1024 || !same(entries.at(-1), { name: 'PackageManifest.json', kind: 'file', size: Buffer.byteLength(packageManifest), sha256: createHash('sha256').update(packageManifest).digest('hex') })) return false;
  const sourceBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (!Number.isSafeInteger(sourceBytes) || sourceBytes < 1 || sourceBytes !== job.proposal.sourceBytes || job.proposal.fileCount !== entries.length || sourceBytes > 200 * 68_719_476_736) return false;
  const proposal = { ...job.proposal, proposalFingerprint: '' };
  if (mediaFingerprint({ proposal, target: job.target, packageManifest, entries }) !== job.proposal.proposalFingerprint) return false;
  if (value.temp !== undefined && !fileIdentity(value.temp)) return false;
  if (value.verified !== undefined && (!object(value.verified) || !exactly(value.verified, ['sha256','size']) || !hex(value.verified.sha256) || !Number.isSafeInteger(value.verified.size) || Number(value.verified.size) < 1 || Number(value.verified.size) > sourceBytes + 16 * 1024 * 1024 || !value.temp)) return false;
  if (job.public.state === 'completed' && (!job.verified || job.public.zipSha256 !== job.verified.sha256 || job.public.zipBytes !== job.verified.size)) return false;
  if (value.recoveryRevoked !== undefined && (value.recoveryRevoked !== true || job.public.state !== 'failed' || job.public.failure !== 'TARGET_INVALID')) return false;
  return true;
}

/** 冷开、备份与隔离恢复共用的只读审计；不会触碰 target/工作区中的任何路径。 */
export function verifyPreparationZipDatabase(db: DatabaseSync): void {
  const sqlIdentity = (sql: string): string => sql.trim().replace(/;\s*$/u, '').replace(/\s+/gu, ' ');
  for (const [name, type, expected] of [
    ['preparation_zip_jobs', 'table', zipJobsTable],
    ['preparation_zip_ledger', 'table', zipLedgerTable],
    ['preparation_zip_ledger_no_update', 'trigger', zipLedgerUpdateTrigger],
    ['preparation_zip_ledger_no_delete', 'trigger', zipLedgerDeleteTrigger],
  ] as const) {
    const actual = db.prepare('SELECT type,sql FROM sqlite_master WHERE name=?').get(name);
    if (actual?.type !== type || typeof actual.sql !== 'string' || sqlIdentity(actual.sql) !== sqlIdentity(expected)) failAudit();
  }
  const foreignKeys = db.prepare('PRAGMA foreign_key_list(preparation_zip_jobs)').all()
    .map(row => [row.table, row.from, row.to, row.on_update, row.on_delete, row.match].map(String).join('|')).sort();
  if (!same(foreignKeys, [
    'master_drafts|draft_id|id|NO ACTION|NO ACTION|NONE',
    'preparation_workspaces|workspace_id|id|NO ACTION|NO ACTION|NONE',
  ].sort()) || db.prepare('PRAGMA foreign_key_check(preparation_zip_jobs)').get()) failAudit();
  const counts = db.prepare('SELECT count(*) AS n,coalesce(sum(length(CAST(data AS BLOB))),0) AS bytes FROM preparation_zip_jobs').get()!;
  const ledgerCount = Number(db.prepare('SELECT count(*) AS n FROM preparation_zip_ledger').get()!.n);
  if (Number(counts.n) > MAX_JOBS || Number(counts.bytes) > MAX_ALL_JOB_BYTES || ledgerCount > MAX_LEDGER) failAudit();
  const rows = db.prepare('SELECT id,workspace_id,draft_id,data FROM preparation_zip_jobs').all();
  const jobs = new Map<string, StoredPreparationZipJob>();
  const perDraft = new Map<string, number>();
  for (const row of rows) {
    if (typeof row.data !== 'string' || Buffer.byteLength(row.data) > MAX_JOB_BYTES) failAudit();
    let parsed: unknown;
    try { parsed = JSON.parse(row.data); } catch { failAudit(); }
    if (!stored(parsed) || row.id !== parsed.public.id || row.workspace_id !== parsed.public.workspaceId || row.draft_id !== parsed.public.draftId) failAudit();
    const job = parsed as StoredPreparationZipJob;
    const workspaceRow = db.prepare('SELECT data FROM preparation_workspaces WHERE id=? AND draft_id=?').get(job.public.workspaceId, job.public.draftId);
    const preparationRow = db.prepare('SELECT data FROM preparation_jobs WHERE id=? AND draft_id=?').get(job.public.workspaceId, job.public.draftId);
    if (!workspaceRow || !preparationRow) failAudit();
    let workspace: unknown, preparation: unknown;
    try { workspace = JSON.parse(String(workspaceRow.data)); preparation = JSON.parse(String(preparationRow.data)); } catch { failAudit(); }
    if (!isPreparationWorkspace(workspace) || workspace.id !== job.public.workspaceId || workspace.manifestHash !== job.workspace.manifestHash || workspace.masterVersionId !== job.proposal.masterVersionId || workspace.layoutVersionId !== job.proposal.layoutVersionId || !object(preparation) || !object(preparation.public) || preparation.public.state !== 'completed' || !same(preparation.owned, job.workspace.owned) || !same(preparation.files, job.workspace.files) || preparation.manifestHash !== job.workspace.manifestHash) failAudit();
    jobs.set(job.public.id, job);
    const n = (perDraft.get(job.public.draftId) ?? 0) + 1;
    if (n > 1000) failAudit();
    perDraft.set(job.public.draftId, n);
  }
  const ledger = db.prepare('SELECT command_id,fingerprint,job_id,created_at FROM preparation_zip_ledger').all();
  const perJob = new Map<string, number>(), starts = new Set<string>();
  for (const row of ledger) {
    const job = jobs.get(String(row.job_id));
    if (!job || !isCollectionId(row.command_id) || !hex(row.fingerprint) || !iso(row.created_at)) failAudit();
    const n = (perJob.get(job.public.id) ?? 0) + 1;
    if (n > 17) failAudit();
    perJob.set(job.public.id, n);
    if (row.command_id === job.public.id) {
      if (row.fingerprint !== mediaFingerprint(['start-preparation-zip', job.request])) failAudit();
      starts.add(job.public.id);
    } else if (row.fingerprint !== mediaFingerprint(['cancel-preparation-zip', job.public.id])) failAudit();
  }
  if (starts.size !== jobs.size) failAudit();
}

/** schema30 冷开审计：旧会话目标必须有不可逆撤销证据，历史账本仍按原字节保留。 */
export function verifyPreparationZipSessionDatabase(db: DatabaseSync): void {
  const sqlIdentity = (sql: string): string => sql.trim().replace(/;\s*$/u, '').replace(/\s+/gu, ' ');
  for (const [name, type, expected] of [
    ['preparation_zip_session', 'table', zipSessionTable],
    ['preparation_zip_targets', 'table', zipTargetsTable],
    ['preparation_zip_targets_scope', 'index', zipTargetsScopeIndex],
    ['preparation_zip_targets_no_rebind', 'trigger', zipTargetsNoRebindTrigger],
    ['preparation_zip_targets_no_delete', 'trigger', zipTargetsNoDeleteTrigger],
  ] as const) {
    const actual = db.prepare('SELECT type,sql FROM sqlite_master WHERE name=?').get(name);
    if (actual?.type !== type || typeof actual.sql !== 'string' || sqlIdentity(actual.sql) !== sqlIdentity(expected)) failAudit();
  }
  const session = db.prepare('SELECT id,epoch FROM preparation_zip_session').all();
  if (session.length !== 1 || session[0]?.id !== 1 || !Number.isSafeInteger(session[0]?.epoch) || Number(session[0]?.epoch) < 0) failAudit();
  const epoch = Number(session[0]!.epoch);
  const rows = db.prepare('SELECT id,epoch,dataset_id,scope_id,generation,expires_at,fingerprint,revoked_at FROM preparation_zip_targets').all();
  if (rows.length > MAX_TARGETS) failAudit();
  for (const row of rows) {
    if (!isCollectionId(row.id) || !Number.isSafeInteger(row.epoch) || Number(row.epoch) < 1 || Number(row.epoch) > epoch
      || !isCollectionId(row.dataset_id) || !isCollectionId(row.scope_id) || !Number.isSafeInteger(row.generation) || Number(row.generation) < 0
      || !iso(row.expires_at) || !hex(row.fingerprint) || row.revoked_at !== null && !iso(row.revoked_at)
      || Number(row.epoch) < epoch && row.revoked_at === null) failAudit();
  }
}

/** 恢复激活库不能再使用原主机路径；本函数只改 R16 私有状态，不触碰文件系统。 */
export function revokePreparationZipForRestore(db: DatabaseSync): void {
  verifyPreparationZipDatabase(db);
  if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 30) {
    verifyPreparationZipSessionDatabase(db);
    db.prepare('UPDATE preparation_zip_targets SET revoked_at=? WHERE revoked_at IS NULL').run(new Date().toISOString());
  }
  const rows = db.prepare('SELECT id,data FROM preparation_zip_jobs').all();
  for (const row of rows) {
    const job = JSON.parse(String(row.data)) as StoredPreparationZipJob;
    if (job.public.state === 'completed') continue;
    job.recoveryRevoked = true;
    job.public = { ...job.public, state: 'failed', failure: 'TARGET_INVALID' };
    db.prepare('UPDATE preparation_zip_jobs SET data=? WHERE id=?').run(JSON.stringify(job), String(row.id));
  }
  verifyPreparationZipDatabase(db);
  if (Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 30) verifyPreparationZipSessionDatabase(db);
}
