import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isActivateRestoredDataset, isRestoreActivationView, type ActivateRestoredDataset, type RestoreActivationView, type RestoreActivationIssue } from '@music-bridge/contracts';
import type { PreparedRestoredDataset } from './restore-activation-files.js';

export const restoreActivationSchemaObjects = [
  'CREATE TABLE restore_activations(id TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT',
  'CREATE TABLE active_dataset(singleton INTEGER PRIMARY KEY CHECK(singleton=1), active_id TEXT, pending_id TEXT) STRICT',
] as const;
export const restoreActivationSchema = `${restoreActivationSchemaObjects.join(';\n')};
INSERT INTO active_dataset VALUES(1,NULL,NULL);
`;
export interface StoredRestoreActivation { view: RestoreActivationView; dataset?: PreparedRestoredDataset }
export interface ActivationStoreAccess {
  read<T>(fn: (db: DatabaseSync) => T): T;
  transaction<T>(fn: (db: DatabaseSync) => T): T;
}
export class RestoreActivationError extends Error {
  constructor(readonly code: 'BACKUP_CONFLICT' | 'BACKUP_UNAVAILABLE') {
    super(code === 'BACKUP_CONFLICT' ? '恢复激活确认冲突，当前工作库未被替换。' : '恢复激活回执不可用，保留现有工作库。');
  }
}
const conflict = (): never => { throw new RestoreActivationError('BACKUP_CONFLICT'); };
const unavailable = (): never => { throw new RestoreActivationError('BACKUP_UNAVAILABLE'); };
/** 与维护库共享一个排他连接，所有状态变化与指针在同一事务提交。 */
export function createRestoreActivationStore(access: ActivationStoreAccess) {
  function get(db: DatabaseSync, id: string): StoredRestoreActivation {
    const row = db.prepare('SELECT data FROM restore_activations WHERE id=?').get(id);
    if (!row) return conflict();
    const value = JSON.parse(String(row.data)) as StoredRestoreActivation;
    if (!isRestoreActivationView(value.view) || value.view.id !== id || value.dataset && value.dataset.id !== id) return unavailable();
    return value;
  }
  function save(db: DatabaseSync, value: StoredRestoreActivation): void {
    if (!isRestoreActivationView(value.view)) return unavailable();
    db.prepare('INSERT INTO restore_activations VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(value.view.id, JSON.stringify(value));
  }
  function pointer(db: DatabaseSync): { activeId: string | null; pendingId: string | null } {
    const row = db.prepare('SELECT active_id,pending_id FROM active_dataset WHERE singleton=1').get();
    if (!row) return unavailable();
    return { activeId: row.active_id === null ? null : String(row.active_id), pendingId: row.pending_id === null ? null : String(row.pending_id) };
  }
  function fail(db: DatabaseSync, id: string, issue: RestoreActivationIssue): RestoreActivationView {
    const value = get(db, id), current = pointer(db);
    if (current.pendingId !== id || !['preparing','prepared','activating'].includes(value.view.state)) return value.view;
    value.view.state = value.view.state === 'activating' ? 'rolled-back' : 'failed'; value.view.issue = issue;
    save(db, value); db.prepare('UPDATE active_dataset SET pending_id=NULL WHERE singleton=1').run(); return value.view;
  }
  return {
    receipt(request: ActivateRestoredDataset): RestoreActivationView | null {
      if (!isActivateRestoredDataset(request)) return conflict();
      return access.read(db => {
        const receipt = db.prepare('SELECT fingerprint,result_id,action FROM backup_commands WHERE command_id=?').get(request.commandId);
        if (!receipt) return null;
        const fingerprint = createHash('sha256').update(JSON.stringify([request.restoreJobId, request.expectedActiveId])).digest('hex');
        if (receipt.action !== 'activate' || receipt.fingerprint !== fingerprint) return conflict();
        return get(db, String(receipt.result_id)).view;
      });
    },
    overview() { return access.read(db => ({ activeId: pointer(db).activeId, activations: db.prepare('SELECT id FROM restore_activations ORDER BY rowid DESC').all().map(row => get(db, String(row.id)).view) })); },
    get(id: string): StoredRestoreActivation { return access.read(db => get(db, id)); },
    begin(request: ActivateRestoredDataset): StoredRestoreActivation {
      if (!isActivateRestoredDataset(request)) return conflict();
      return access.transaction(db => {
        const fingerprint = createHash('sha256').update(JSON.stringify([request.restoreJobId, request.expectedActiveId])).digest('hex');
        const receipt = db.prepare('SELECT * FROM backup_commands WHERE command_id=?').get(request.commandId);
        if (receipt) { if (receipt.action !== 'activate' || receipt.fingerprint !== fingerprint) return conflict(); return get(db, String(receipt.result_id)); }
        const current = pointer(db);
        if (current.activeId !== request.expectedActiveId || current.pendingId !== null || Number(db.prepare('SELECT count(*) n FROM restore_activations').get()?.n) >= 100) return conflict();
        const value: StoredRestoreActivation = { view: { id: randomUUID(), restoreJobId: request.restoreJobId, previousId: current.activeId, state: 'preparing', createdAt: new Date().toISOString() } };
        save(db, value);
        db.prepare('INSERT INTO backup_commands VALUES(?,?,?,?)').run(request.commandId, fingerprint, value.view.id, 'activate');
        db.prepare('UPDATE active_dataset SET pending_id=? WHERE singleton=1').run(value.view.id);
        return value;
      });
    },
    prepared(id: string, dataset: PreparedRestoredDataset): RestoreActivationView {
      return access.transaction(db => {
        const value = get(db, id);
        if (pointer(db).pendingId !== id || value.view.state !== 'preparing' || dataset.id !== id) return conflict();
        value.dataset = dataset; value.view.state = 'prepared'; value.view.contentIncluded = dataset.contentIncluded;
        save(db, value); return value.view;
      });
    },
    fail(id: string, issue: RestoreActivationIssue): RestoreActivationView { return access.transaction(db => fail(db, id, issue)); },
    beginBoot(): { active?: StoredRestoreActivation; pending?: StoredRestoreActivation } {
      return access.transaction(db => {
        const current = pointer(db), active = current.activeId ? get(db, current.activeId) : undefined;
        if (active && active.view.state !== 'active') return unavailable();
        if (!current.pendingId) return { ...(active ? { active } : {}) };
        const pending = get(db, current.pendingId);
        if (pending.view.previousId !== current.activeId) return unavailable();
        if (pending.view.state === 'preparing' || pending.view.state === 'activating') {
          fail(db, pending.view.id, pending.view.state === 'preparing' ? 'PREPARATION_INTERRUPTED' : 'BOOT_INTERRUPTED');
          return { ...(active ? { active } : {}) };
        }
        if (pending.view.state !== 'prepared' || !pending.dataset) return unavailable();
        pending.view.state = 'activating'; save(db, pending);
        return { ...(active ? { active } : {}), pending };
      });
    },
    commitBoot(id: string): RestoreActivationView {
      return access.transaction(db => {
        const current = pointer(db), value = get(db, id);
        if (current.pendingId !== id || current.activeId !== value.view.previousId || value.view.state !== 'activating' || !value.dataset) return conflict();
        if (current.activeId) { const previous = get(db, current.activeId); previous.view.state = 'superseded'; save(db, previous); }
        value.view.state = 'active'; save(db, value);
        db.prepare('UPDATE active_dataset SET active_id=?,pending_id=NULL WHERE singleton=1').run(id); return value.view;
      });
    },
  };
}
export type RestoreActivationStore = ReturnType<typeof createRestoreActivationStore>;
