import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { isCollectionId, isMasterVersion, isLayoutVersion, type MasterVersion, type LayoutVersion, type PreparationHistory, type PreparationJob, type PreparationWorkspace, type PreparationProposal, type StartPreparationRequest, type PreparationFailure } from '@music-bridge/contracts';
import type { RootCapability } from './source-files.js';
import type { OwnedPreparation, PreparationOutput } from './preparation-files.js';
import { mediaFingerprint } from './media-store.js';

export const preparationMigration = `
CREATE TABLE preparation_destinations (id TEXT PRIMARY KEY,data TEXT NOT NULL) STRICT;
CREATE TABLE preparation_jobs (id TEXT PRIMARY KEY,draft_id TEXT NOT NULL REFERENCES master_drafts(id),data TEXT NOT NULL) STRICT;
CREATE TABLE preparation_workspaces (id TEXT PRIMARY KEY,draft_id TEXT NOT NULL REFERENCES master_drafts(id),data TEXT NOT NULL) STRICT;
CREATE TABLE preparation_ledger (command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
CREATE TRIGGER preparation_workspaces_no_update BEFORE UPDATE ON preparation_workspaces BEGIN SELECT RAISE(ABORT,'immutable preparation'); END;
CREATE TRIGGER preparation_workspaces_no_delete BEFORE DELETE ON preparation_workspaces BEGIN SELECT RAISE(ABORT,'immutable preparation'); END;
CREATE TRIGGER preparation_ledger_no_update BEFORE UPDATE ON preparation_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
CREATE TRIGGER preparation_ledger_no_delete BEFORE DELETE ON preparation_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
PRAGMA user_version=9;
`;
export interface PreparationInput { master: MasterVersion; layout: LayoutVersion; destination: RootCapability; proposal: PreparationProposal }
export interface StoredPreparationJob { public: PreparationJob; request: StartPreparationRequest; input: PreparationInput; createdAt: string; owned?: OwnedPreparation; files: readonly PreparationOutput[]; manifestHash?: string }
interface Access { read<T>(fn: (db: DatabaseSync) => T): T; conflict(message: string): never; beforeCommit?: (action: string) => void }
export function createPreparationStore({ read, conflict, beforeCommit }: Access) {
  const get = <T>(db: DatabaseSync, table: string, id: string): T | undefined => { const row = db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id); return row ? JSON.parse(String(row.data)) as T : undefined; };
  const job = (db: DatabaseSync, id: string): StoredPreparationJob => get<StoredPreparationJob>(db, 'preparation_jobs', id) ?? conflict('工作区任务不存在。');
  const save = (db: DatabaseSync, j: StoredPreparationJob): void => { db.prepare('INSERT INTO preparation_jobs VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(j.public.id, j.public.draftId, JSON.stringify(j)); };
  function transaction<T>(action: string, fn: (db: DatabaseSync) => T): T { return read(db => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(db); beforeCommit?.(action); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } }); }
  function receipt(db: DatabaseSync, command: string, fingerprint: string): string | undefined { const row = db.prepare('SELECT fingerprint,result FROM preparation_ledger WHERE command_id=?').get(command); if (row && row.fingerprint !== fingerprint) return conflict('同一操作编号不能用于不同工作区请求。'); return row ? String(row.result) : undefined; }
  const record = (db: DatabaseSync, command: string, fingerprint: string, result: string): void => { db.prepare('INSERT INTO preparation_ledger VALUES (?,?,?,?)').run(command, fingerprint, result, new Date().toISOString()); };
  const destination = (db: DatabaseSync, id: string): RootCapability => get<RootCapability>(db, 'preparation_destinations', id) ?? conflict('目标目录授权不存在。');
  const fingerprint = (request: StartPreparationRequest): string => mediaFingerprint(['start', request]);
  return {
    list(draftId: string): PreparationHistory {
      return read(db => {
        if (!isCollectionId(draftId) || !db.prepare('SELECT id FROM master_drafts WHERE id=?').get(draftId)) return conflict('草稿不存在，请刷新。');
        return { draftId, workspaces: db.prepare('SELECT data FROM preparation_workspaces WHERE draft_id=? ORDER BY rowid DESC').all(draftId).map(r => JSON.parse(String(r.data)) as PreparationWorkspace), jobs: db.prepare('SELECT data FROM preparation_jobs WHERE draft_id=? ORDER BY rowid DESC').all(draftId).map(r => (JSON.parse(String(r.data)) as StoredPreparationJob).public) };
      });
    },
    destinations: (): RootCapability[] => read(db => db.prepare('SELECT data FROM preparation_destinations').all().map(r => JSON.parse(String(r.data)) as RootCapability)),
    destination: (id: string) => read(db => destination(db, id)),
    authorizationReceipt: (id: string) => read(db => { const prior = receipt(db, id, mediaFingerprint(['authorize', id])); return prior ? destination(db, prior) : undefined; }),
    authorize(command: string, capability: Omit<RootCapability, 'id'>): RootCapability {
      return transaction('authorize-preparation', db => {
        const fp = mediaFingerprint(['authorize', command]), prior = receipt(db, command, fp); if (prior) return destination(db, prior);
        if (Number(db.prepare('SELECT count(*) AS n FROM preparation_destinations').get()!.n) >= 100) return conflict('最多保存 100 个目标目录授权。');
        const result = { ...capability, id: randomUUID() }; db.prepare('INSERT INTO preparation_destinations VALUES (?,?)').run(result.id, JSON.stringify(result)); record(db, command, fp, result.id); return result;
      });
    },
    revoke(request: { commandId: string; id: string }): RootCapability {
      return transaction('revoke-preparation', db => { const fp = mediaFingerprint(['revoke', request.id]), prior = receipt(db, request.commandId, fp); if (prior) return destination(db, prior); const result = { ...destination(db, request.id), authorized: false }; db.prepare('UPDATE preparation_destinations SET data=? WHERE id=?').run(JSON.stringify(result), request.id); record(db, request.commandId, fp, request.id); return result; });
    },
    frozen(layoutId: string): { master: MasterVersion; layout: LayoutVersion } {
      return read(db => { const layout = get<LayoutVersion>(db, 'layout_versions', layoutId); if (!isLayoutVersion(layout)) return conflict('冻结布局不存在。'); const master = get<MasterVersion>(db, 'master_versions', layout.masterVersionId); if (!isMasterVersion(master) || master.draftId !== layout.draftId) return conflict('冻结母版不存在。'); return { master, layout }; });
    },
    cached(request: StartPreparationRequest) { return read(db => { const prior = receipt(db, request.commandId, fingerprint(request)); return prior ? job(db, prior).public : undefined; }); },
    job: (id: string) => read(db => get<StoredPreparationJob>(db, 'preparation_jobs', id)),
    pending: () => read(db => db.prepare('SELECT data FROM preparation_jobs').all().map(r => JSON.parse(String(r.data)) as StoredPreparationJob).filter(j => j.public.state === 'running' || j.public.state === 'interrupted')),
    start(request: StartPreparationRequest, input: PreparationInput): StoredPreparationJob {
      return transaction('start-preparation', db => {
        const fp = fingerprint(request), prior = receipt(db, request.commandId, fp); if (prior) return job(db, prior);
        if (!destination(db, request.destinationId).authorized || mediaFingerprint(destination(db, request.destinationId)) !== mediaFingerprint(input.destination)) return conflict('目标目录授权已改变。');
        if (Number(db.prepare('SELECT count(*) AS n FROM preparation_jobs WHERE draft_id=?').get(input.master.draftId)!.n) >= 1000 || Number(db.prepare('SELECT count(*) AS n FROM preparation_workspaces WHERE draft_id=?').get(input.master.draftId)!.n) >= 100) return conflict('工作区历史已达到上限。');
        if (Number(db.prepare("SELECT count(*) AS n FROM preparation_jobs WHERE json_extract(data,'$.public.state')='running'").get()!.n) >= 2) return conflict('已有两项工作区任务，请等待或取消。');
        const result: StoredPreparationJob = { public: { id: request.commandId, draftId: input.master.draftId, layoutVersionId: input.layout.id, destinationId: input.destination.id, state: 'running', completedTracks: 0, totalTracks: input.master.content.tracks.length }, request, input, createdAt: new Date().toISOString(), files: [] };
        save(db, result); record(db, request.commandId, fp, request.commandId); return result;
      });
    },
    update(id: string, patch: Pick<Partial<StoredPreparationJob>, 'owned' | 'files' | 'manifestHash'>, completedTracks?: number): StoredPreparationJob {
      return transaction('progress-preparation', db => { const current = job(db, id); if (current.public.state !== 'running') return current; const result = { ...current, ...patch, public: { ...current.public, ...(completedTracks === undefined ? {} : { completedTracks }) } }; save(db, result); return result; });
    },
    finish(id: string): PreparationJob {
      return transaction('finish-preparation', db => {
        const current = job(db, id); if (!['running', 'interrupted'].includes(current.public.state)) return current.public;
        if (!current.owned || !current.manifestHash || current.public.completedTracks !== current.public.totalTracks) return conflict('工作区发布证据不完整。');
        const p = current.input.proposal, workspace: PreparationWorkspace = { id, draftId: p.draftId, masterVersionId: p.masterVersionId, layoutVersionId: p.layoutVersionId, destinationId: p.destinationId, createdAt: current.createdAt, manifestHash: current.manifestHash, trackCount: p.trackCount, bytes: p.bytes, kind: 'logic-working-copy', executionReady: false };
        db.prepare('INSERT INTO preparation_workspaces VALUES (?,?,?)').run(id, p.draftId, JSON.stringify(workspace));
        current.public = { ...current.public, state: 'completed', workspaceId: id }; save(db, current); return current.public;
      });
    },
    fail(id: string, failure?: PreparationFailure): PreparationJob {
      return transaction('fail-preparation', db => { const current = job(db, id); if (current.public.state !== 'running') return current.public; current.public = { ...current.public, state: failure === 'CANCELLED' ? 'cancelled' : failure ? 'failed' : 'interrupted', ...(failure ? { failure } : {}) }; save(db, current); return current.public; });
    },
    cancel(request: { commandId: string; id: string }): PreparationJob {
      return transaction('cancel-preparation', db => { const fp = mediaFingerprint(['cancel', request.id]), prior = receipt(db, request.commandId, fp); if (prior) return job(db, prior).public; const current = job(db, request.id); if (current.public.state === 'running') { current.public = { ...current.public, state: 'cancelled', failure: 'CANCELLED' }; save(db, current); } record(db, request.commandId, fp, request.id); return current.public; });
    },
  };
}
export type PreparationStore = ReturnType<typeof createPreparationStore>;
