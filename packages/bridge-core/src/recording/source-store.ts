import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { SourceSelection, SourceJob, SourceFailure, SourceAction, SourceConfirmation } from '@music-bridge/contracts';
import type { RootCapability, FileEvidence } from './source-files.js';

export const sourceEvidenceMigration = `
CREATE TABLE source_roots (id TEXT PRIMARY KEY,data TEXT NOT NULL) STRICT;
CREATE TABLE source_bindings (id TEXT PRIMARY KEY,data TEXT NOT NULL) STRICT;
CREATE TABLE draft_source_links (draft_id TEXT NOT NULL REFERENCES master_drafts(id),track_id TEXT NOT NULL,binding_id TEXT NOT NULL REFERENCES source_bindings(id),PRIMARY KEY(draft_id,track_id)) STRICT;
CREATE TABLE source_jobs (id TEXT PRIMARY KEY,data TEXT NOT NULL) STRICT;
CREATE TABLE source_ledger (command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
CREATE TRIGGER source_ledger_no_update BEFORE UPDATE ON source_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
CREATE TRIGGER source_ledger_no_delete BEFORE DELETE ON source_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
PRAGMA user_version=6;
`;
export interface StoredBinding { id: string; rootId: string; relative: string; acquisition: SourceSelection['acquisition']; evidence: FileEvidence; userConfirmed: boolean; invalidated: boolean }
export interface StoredJob { public: SourceJob; selection: SourceSelection; relative: string; previousBindingId: string | null; recheck: boolean }
interface Access { read<T>(fn: (db: DatabaseSync) => T): T; conflict(message: string): never; beforeCommit?: (action: string) => void }
export const sourceFingerprint = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function createSourceStore({ read, conflict, beforeCommit }: Access) {
  const get = <T>(db: DatabaseSync, table: string, id: string): T | undefined => { const row = db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id); return row ? JSON.parse(String(row.data)) as T : undefined; };
  const all = <T>(db: DatabaseSync, table: string): T[] => db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all().map(r => JSON.parse(String(r.data)) as T);
  const put = (db: DatabaseSync, table: string, id: string, data: unknown): void => { db.prepare(`INSERT INTO ${table} VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(id, JSON.stringify(data)); };
  const root = (db: DatabaseSync, id: string): RootCapability => get<RootCapability>(db, 'source_roots', id) ?? conflict('源目录不存在。');
  const binding = (db: DatabaseSync, id: string): StoredBinding => get<StoredBinding>(db, 'source_bindings', id) ?? conflict('源绑定不存在。');
  const linked = (db: DatabaseSync, draftId: string, trackId: string): string | null => { const row = db.prepare('SELECT binding_id FROM draft_source_links WHERE draft_id=? AND track_id=?').get(draftId, trackId); return row ? String(row.binding_id) : null; };
  function assertTrack(db: DatabaseSync, draftId: string, trackId: string): void {
    const draft = get<{ tracks: { id: string }[] }>(db, 'master_drafts', draftId);
    if (!draft?.tracks.some(t => t.id === trackId)) conflict('草稿曲目已改变，请刷新。');
  }
  function transaction<T>(action: string, fn: (db: DatabaseSync) => T): T {
    return read(db => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(db); beforeCommit?.(action); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } });
  }
  function cached(db: DatabaseSync, commandId: string, fingerprint: string): string | undefined {
    const row = db.prepare('SELECT fingerprint,result FROM source_ledger WHERE command_id=?').get(commandId);
    if (!row) return undefined;
    if (row.fingerprint !== fingerprint) return conflict('同一操作编号不能用于不同源操作。');
    return String(row.result);
  }
  function receipt(db: DatabaseSync, id: string, fingerprint: string, result: string): void { db.prepare('INSERT INTO source_ledger VALUES (?,?,?,?)').run(id, fingerprint, result, new Date().toISOString()); }
  return {
    roots: (): RootCapability[] => read(db => all(db, 'source_roots')),
    root: (id: string): RootCapability => read(db => root(db, id)),
    rootReceipt(commandId: string): RootCapability | undefined { return read(db => { const row = db.prepare('SELECT result FROM source_ledger WHERE command_id=? AND fingerprint=?').get(commandId, sourceFingerprint(['authorize', commandId])); return row ? root(db, String(row.result)) : undefined; }); },
    authorize(commandId: string, capability: Omit<RootCapability, 'id'>): RootCapability {
      return transaction('authorize-source-root', db => {
        const fingerprint = sourceFingerprint(['authorize', commandId]), prior = cached(db, commandId, fingerprint); if (prior) return root(db, prior);
        if (all(db, 'source_roots').length >= 100) return conflict('最多保存 100 个源目录授权。');
        const result = { ...capability, id: randomUUID() }; put(db, 'source_roots', result.id, result); receipt(db, commandId, fingerprint, result.id); return result;
      });
    },
    revoke(request: SourceAction): RootCapability {
      return transaction('revoke-source-root', db => {
        const fingerprint = sourceFingerprint(['revoke', request.id]), prior = cached(db, request.commandId, fingerprint); if (prior) return root(db, prior);
        const result = { ...root(db, request.id), authorized: false }; put(db, 'source_roots', result.id, result); receipt(db, request.commandId, fingerprint, result.id); return result;
      });
    },
    binding: (id: string): StoredBinding => read(db => binding(db, id)),
    linked: (draftId: string, trackId: string): StoredBinding | undefined => read(db => { const id = linked(db, draftId, trackId); return id ? binding(db, id) : undefined; }),
    job: (id: string): StoredJob | undefined => read(db => get(db, 'source_jobs', id)),
    jobs: (draftId: string, trackId: string): SourceJob[] => read(db => db.prepare("SELECT data FROM source_jobs WHERE json_extract(data,'$.public.draftId')=? AND json_extract(data,'$.public.trackId')=? ORDER BY rowid DESC LIMIT 20").all(draftId, trackId).map(r => (JSON.parse(String(r.data)) as StoredJob).public)),
    start(selection: SourceSelection, relative: string, recheck: boolean): StoredJob {
      return transaction('start-source-probe', db => {
        const prior = get<StoredJob>(db, 'source_jobs', selection.commandId);
        if (prior) { if (sourceFingerprint(prior.selection) !== sourceFingerprint(selection) || prior.recheck !== recheck) return conflict('校验操作编号已被另一请求使用。'); return prior; }
        const fingerprint = sourceFingerprint(['probe', selection, recheck]); cached(db, selection.commandId, fingerprint);
        assertTrack(db, selection.draftId, selection.trackId);
        if (!root(db, selection.rootId).authorized) return conflict('源目录授权已撤销。');
        const previousBindingId = linked(db, selection.draftId, selection.trackId);
        if (selection.relocateBindingId && selection.relocateBindingId !== previousBindingId) return conflict('只能重新定位当前曲目的源绑定。');
        const result: StoredJob = { selection, relative, previousBindingId, recheck, public: { id: selection.commandId, draftId: selection.draftId, trackId: selection.trackId, rootId: selection.rootId, state: 'running' } };
        put(db, 'source_jobs', selection.commandId, result); receipt(db, selection.commandId, fingerprint, selection.commandId); return result;
      });
    },
    finish(id: string, evidence: FileEvidence): SourceJob {
      return transaction('complete-source-probe', db => {
        const job = get<StoredJob>(db, 'source_jobs', id) ?? conflict('校验任务不存在。');
        if (job.public.state !== 'running') return job.public;
        let failure: SourceFailure | undefined;
        const draft = get<{ tracks: { id: string }[] }>(db, 'master_drafts', job.selection.draftId);
        if (!root(db, job.selection.rootId).authorized) failure = 'REVOKED';
        else if (!draft?.tracks.some(t => t.id === job.selection.trackId) || linked(db, job.selection.draftId, job.selection.trackId) !== job.previousBindingId) failure = 'DRAFT_CHANGED';
        const prior = job.previousBindingId ? binding(db, job.previousBindingId) : undefined;
        if (!failure && job.selection.relocateBindingId && prior?.evidence.sha256 !== evidence.sha256) failure = job.recheck ? 'CONTENT_CHANGED' : 'HASH_MISMATCH';
        if (failure) {
          if (job.recheck && prior && failure === 'CONTENT_CHANGED') put(db, 'source_bindings', prior.id, { ...prior, invalidated: true, userConfirmed: false });
          job.public = { ...job.public, state: 'failed', failure };
        } else {
          const keepIdentity = !!job.selection.relocateBindingId && !!prior;
          const result: StoredBinding = { id: keepIdentity ? prior!.id : randomUUID(), rootId: job.selection.rootId, relative: job.relative, acquisition: keepIdentity ? prior!.acquisition : job.selection.acquisition, evidence, userConfirmed: keepIdentity && prior!.userConfirmed, invalidated: false };
          put(db, 'source_bindings', result.id, result);
          db.prepare('INSERT INTO draft_source_links VALUES (?,?,?) ON CONFLICT(draft_id,track_id) DO UPDATE SET binding_id=excluded.binding_id').run(job.selection.draftId, job.selection.trackId, result.id);
          job.public = { ...job.public, state: 'completed', bindingId: result.id };
          // 内容证据与定位历史只追加，定位改变不抹掉旧证据。
          receipt(db, randomUUID(), sourceFingerprint(['binding-snapshot', result]), JSON.stringify(result));
        }
        put(db, 'source_jobs', id, job); return job.public;
      });
    },
    fail(id: string, failure: SourceFailure): SourceJob {
      return transaction('fail-source-probe', db => { const job = get<StoredJob>(db, 'source_jobs', id) ?? conflict('校验任务不存在。'); if (job.public.state === 'running') { job.public = { ...job.public, state: failure === 'CANCELLED' ? 'cancelled' : 'failed', failure }; put(db, 'source_jobs', id, job); } return job.public; });
    },
    cancel(request: SourceAction): SourceJob {
      return transaction('cancel-source-probe', db => {
        const fingerprint = sourceFingerprint(['cancel', request.id]), prior = cached(db, request.commandId, fingerprint);
        const job = get<StoredJob>(db, 'source_jobs', request.id) ?? conflict('校验任务不存在。');
        if (!prior) { if (job.public.state === 'running') { job.public = { ...job.public, state: 'cancelled', failure: 'CANCELLED' }; put(db, 'source_jobs', request.id, job); } receipt(db, request.commandId, fingerprint, request.id); }
        return job.public;
      });
    },
    confirm(request: SourceConfirmation): StoredBinding {
      return transaction('confirm-source-mapping', db => {
        const fingerprint = sourceFingerprint(['confirm', request.id, request.draftId, request.trackId]), prior = cached(db, request.commandId, fingerprint);
        if (prior) return binding(db, prior);
        assertTrack(db, request.draftId, request.trackId);
        if (linked(db, request.draftId, request.trackId) !== request.id) return conflict('源绑定已改变，请重新核对。');
        const result = binding(db, request.id); if (!root(db, result.rootId).authorized || result.invalidated) return conflict('源文件验证已失效。');
        result.userConfirmed = true; put(db, 'source_bindings', result.id, result); receipt(db, request.commandId, fingerprint, result.id); return result;
      });
    },
    recover(): void { transaction('interrupt-source-jobs', db => { for (const job of all<StoredJob>(db, 'source_jobs')) if (job.public.state === 'running') { job.public = { ...job.public, state: 'interrupted' }; put(db, 'source_jobs', job.public.id, job); } }); },
  };
}
export type SourceStore = ReturnType<typeof createSourceStore>;
