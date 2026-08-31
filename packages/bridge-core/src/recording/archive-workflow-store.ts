import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isCollectionId, isInitializeArchiveRequest, isSourceAction } from '@music-bridge/contracts';
import { mediaFingerprint } from './media-store.js';
import { planArchiveRootInitialization, type ArchiveRootInitialization, type OwnedArchive } from './archive-files.js';
import type { RootCapability } from './source-files.js';

export const archiveWorkflowMigration = `
CREATE TABLE archive_candidates(id TEXT PRIMARY KEY,data TEXT NOT NULL,authorized INTEGER NOT NULL CHECK(authorized IN (0,1))) STRICT;
CREATE TABLE archive_workflow_ledger(command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result_id TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
CREATE TRIGGER archive_workflow_ledger_no_update BEFORE UPDATE ON archive_workflow_ledger BEGIN SELECT RAISE(ABORT,'归档操作账本不可改写'); END;
CREATE TRIGGER archive_workflow_ledger_no_delete BEFORE DELETE ON archive_workflow_ledger BEGIN SELECT RAISE(ABORT,'归档操作账本不可删除'); END;
INSERT INTO archive_candidates SELECT id,json_object('id',id,'parent',json_extract(data,'$.parent'),'initialized',json('true')),authorized FROM archive_roots;
PRAGMA user_version=14;
`;
export interface ArchiveRootCandidate { id: string; parent: RootCapability; initialized: boolean; authorized: boolean; initialization?: ArchiveRootInitialization }
interface Access {
  read<T>(fn: (db: DatabaseSync) => T): T; conflict(message: string): never; beforeCommit?: (action: string) => void;
  registerRootInTransaction(db: DatabaseSync, archive: OwnedArchive): OwnedArchive;
}
export function createArchiveWorkflowStore({ read, conflict, beforeCommit, registerRootInTransaction }: Access) {
  function transaction<T>(action: string, fn: (db: DatabaseSync) => T): T { return read(db => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(db); beforeCommit?.(action); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } }); }
  function candidate(db: DatabaseSync, id: string): ArchiveRootCandidate {
    const row = db.prepare('SELECT data,authorized FROM archive_candidates WHERE id=?').get(id); if (!row) return conflict('归档目录候选不存在。');
    const result = JSON.parse(String(row.data)) as ArchiveRootCandidate; return { ...result, authorized: row.authorized === 1 };
  }
  function put(db: DatabaseSync, value: ArchiveRootCandidate): void {
    const { authorized, ...data } = value;
    db.prepare('INSERT INTO archive_candidates VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,authorized=excluded.authorized').run(value.id, JSON.stringify(data), Number(authorized));
  }
  function prior(db: DatabaseSync, commandId: string, fingerprint: string): string | undefined {
    const row = db.prepare('SELECT fingerprint,result_id FROM archive_workflow_ledger WHERE command_id=?').get(commandId);
    if (row && row.fingerprint !== fingerprint) return conflict('原归档操作编号不能用于不同请求。'); return row ? String(row.result_id) : undefined;
  }
  function record(db: DatabaseSync, commandId: string, fingerprint: string, result: string): void { db.prepare('INSERT INTO archive_workflow_ledger VALUES (?,?,?,?)').run(commandId, fingerprint, result, new Date().toISOString()); }
  return {
    candidates: () => read(db => db.prepare('SELECT id FROM archive_candidates ORDER BY rowid DESC').all().map(row => candidate(db, String(row.id)))),
    candidate: (id: string) => read(db => candidate(db, id)),
    authorizationReceipt: (commandId: string) => read(db => {
      const row = db.prepare('SELECT fingerprint,result_id FROM archive_workflow_ledger WHERE command_id=?').get(commandId);
      if (!row) return undefined;
      const value = candidate(db, String(row.result_id)), { id: _id, ...capability } = value.parent;
      if (row.fingerprint !== mediaFingerprint(['authorize-archive', capability])) return conflict('该操作不是目录选择命令。'); return value;
    }),
    authorizeCandidate(commandId: string, parent: RootCapability): ArchiveRootCandidate {
      if (!isCollectionId(commandId) || !parent.authorized) return conflict('归档目标授权无效。');
      return transaction('authorize-archive-candidate', db => {
        const { id: _id, ...capability } = parent, fingerprint = mediaFingerprint(['authorize-archive', capability]), previous = prior(db, commandId, fingerprint);
        if (previous) return candidate(db, previous);
        if (Number(db.prepare('SELECT count(*) n FROM archive_candidates').get()!.n) >= 100) return conflict('最多保存 100 个归档目录候选。');
        const value: ArchiveRootCandidate = { id: randomUUID(), parent: structuredClone(parent), initialized: false, authorized: true };
        put(db, value); record(db, commandId, fingerprint, value.id); return value;
      });
    },
    beginInitialization(request: { commandId: string; id: string; userConfirmed: boolean }): ArchiveRootCandidate {
      if (!isInitializeArchiveRequest(request)) return conflict('请明确确认初始化归档目录。');
      return transaction('begin-archive-initialization', db => {
        const value = candidate(db, request.id); if (!value.authorized) return conflict('归档目录授权已撤销。');
        const fingerprint = mediaFingerprint(['initialize-archive', request.id]), previous = prior(db, request.commandId, fingerprint);
        if (previous) return candidate(db, previous);
        if (!value.initialized && !value.initialization) { value.initialization = planArchiveRootInitialization(value.parent, value.id); put(db, value); }
        record(db, request.commandId, fingerprint, value.id); return value;
      });
    },
    finishInitialization(id: string, owned: OwnedArchive): ArchiveRootCandidate {
      return transaction('finish-archive-initialization', db => {
        const value = candidate(db, id), plan = value.initialization;
        if (!value.authorized || !plan || owned.id !== id || owned.owner !== plan.owner || mediaFingerprint(owned.parent) !== mediaFingerprint(plan.parent)) return conflict('归档初始化意图、归属或授权不一致。');
        registerRootInTransaction(db, owned); value.initialized = true; put(db, value); return value;
      });
    },
    revokeCandidate(request: { commandId: string; id: string }): ArchiveRootCandidate {
      if (!isSourceAction(request)) return conflict('归档撤权请求无效。');
      return transaction('revoke-archive-candidate', db => {
        const fingerprint = mediaFingerprint(['revoke-archive', request.id]), previous = prior(db, request.commandId, fingerprint);
        if (previous) return candidate(db, previous);
        const value = { ...candidate(db, request.id), authorized: false }; put(db, value);
        db.prepare('UPDATE archive_roots SET authorized=0 WHERE id=?').run(value.id); record(db, request.commandId, fingerprint, value.id); return value;
      });
    },
  };
}
