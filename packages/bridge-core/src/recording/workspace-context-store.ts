import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  isCollectionId, isPutRecordingWorkspaceContextRequest, isRecordingWorkspaceContext,
  type PutRecordingWorkspaceContextRequest, type RecordingWorkspaceContext,
  type RecordingWorkspaceSelection, type RecordingWorkspaceStaleReason,
} from '@music-bridge/contracts';

export const recordingWorkspaceMigration = `
CREATE TABLE recording_workspace_contexts (
  draft_id TEXT PRIMARY KEY REFERENCES master_drafts(id),
  draft_revision INTEGER NOT NULL CHECK(draft_revision>0),
  context_revision INTEGER NOT NULL CHECK(context_revision>0),
  selection TEXT NOT NULL,
  page_position TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE recording_workspace_ledger (command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
CREATE TRIGGER recording_workspace_ledger_no_update BEFORE UPDATE ON recording_workspace_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
CREATE TRIGGER recording_workspace_ledger_no_delete BEFORE DELETE ON recording_workspace_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
PRAGMA user_version=22;
`;

interface Access { read<T>(fn: (db: DatabaseSync) => T): T; conflict(message: string): never; unavailable(): never; beforeCommit?: (action: string) => void }
interface ContextRow { draft_id: string; draft_revision: number; context_revision: number; selection: string; page_position: string }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
function fingerprint(request: PutRecordingWorkspaceContextRequest): string { return createHash('sha256').update(canonical(request)).digest('hex'); }

/** 校验当前对象关系，但不改写用户原有选择，也不把选择视为已预留。 */
function stale(db: DatabaseSync, draftId: string, savedRevision: number, selection: RecordingWorkspaceSelection): RecordingWorkspaceStaleReason[] {
  const result: RecordingWorkspaceStaleReason[] = [];
  const current = db.prepare('SELECT revision FROM master_drafts WHERE id=?').get(draftId);
  if (Number(current?.revision) !== savedRevision) result.push({ field: 'draft', reason: 'draft-changed' });
  const owned = (field: 'planId' | 'layoutId' | 'preparationId' | 'preparedId', table: string, id: string | undefined) => {
    if (!id) return undefined;
    const row = db.prepare(`SELECT draft_id,data FROM ${table} WHERE id=?`).get(id);
    if (!row) result.push({ field, reason: 'missing' });
    else if (row.draft_id !== draftId) result.push({ field, reason: 'different-draft' });
    return row && row.draft_id === draftId ? JSON.parse(String(row.data)) as Record<string, unknown> : undefined;
  };
  const plan = owned('planId', 'media_plans', selection.planId);
  const layout = owned('layoutId', 'layout_versions', selection.layoutId);
  const preparation = owned('preparationId', 'preparation_workspaces', selection.preparationId);
  const prepared = owned('preparedId', 'prepared_versions', selection.preparedId);
  if (plan && plan.draftRevision !== Number(current?.revision)) result.push({ field: 'planId', reason: 'plan-changed' });
  if (layout && selection.planId && layout.planId !== selection.planId) result.push({ field: 'layoutId', reason: 'plan-changed' });
  if (preparation && selection.layoutId && preparation.layoutVersionId !== selection.layoutId) result.push({ field: 'preparationId', reason: 'plan-changed' });
  if (prepared && selection.preparationId && prepared.preparationId !== selection.preparationId) result.push({ field: 'preparedId', reason: 'plan-changed' });
  if (selection.selectedPhysicalId) {
    const copy = db.prepare('SELECT usage,available FROM physical_copies WHERE physical_id=?').get(selection.selectedPhysicalId);
    const reservation = db.prepare('SELECT plan_id FROM media_reservations WHERE physical_id=?').get(selection.selectedPhysicalId);
    if (!copy || copy.available !== 1 || !['blank', 'erased', 'reserved'].includes(String(copy.usage))
      || copy.usage === 'reserved' && reservation?.plan_id !== selection.planId) result.push({ field: 'selectedPhysicalId', reason: 'copy-unavailable' });
    if (selection.planId) {
      const reserved = db.prepare('SELECT physical_id FROM media_reservations WHERE plan_id=?').get(selection.planId);
      if (reserved && reserved.physical_id !== selection.selectedPhysicalId) result.push({ field: 'selectedPhysicalId', reason: 'reservation-changed' });
    }
  }
  return result;
}

export function createRecordingWorkspaceStore({ read, conflict, unavailable, beforeCommit }: Access) {
  const get = (db: DatabaseSync, draftId: string): RecordingWorkspaceContext | null => {
    if (!isCollectionId(draftId)) return conflict('草稿编号无效。');
    if (!db.prepare('SELECT 1 FROM master_drafts WHERE id=?').get(draftId)) return conflict('草稿不存在，请刷新。');
    const row = db.prepare('SELECT * FROM recording_workspace_contexts WHERE draft_id=?').get(draftId) as unknown as ContextRow | undefined;
    if (!row) return null;
    const selection = JSON.parse(row.selection) as RecordingWorkspaceSelection;
    const result = { draftId: row.draft_id, draftRevision: Number(row.draft_revision), contextRevision: Number(row.context_revision), selection, pagePosition: row.page_position, staleReasons: stale(db, draftId, Number(row.draft_revision), selection) };
    if (!isRecordingWorkspaceContext(result)) return unavailable();
    return result;
  };
  return {
    get(draftId: string): RecordingWorkspaceContext | null { return read(db => get(db, draftId)); },
    put(request: PutRecordingWorkspaceContextRequest): RecordingWorkspaceContext {
      if (!isPutRecordingWorkspaceContextRequest(request)) return conflict('工作台保存请求无效。');
      return read(db => {
        db.exec('BEGIN IMMEDIATE');
        try {
          const hash = fingerprint(request);
          const prior = db.prepare('SELECT fingerprint,result FROM recording_workspace_ledger WHERE command_id=?').get(request.commandId);
          if (prior) {
            if (prior.fingerprint !== hash) return conflict('同一操作编号不能用于不同工作台内容。');
            const saved = JSON.parse(String(prior.result)) as RecordingWorkspaceContext;
            if (!isRecordingWorkspaceContext(saved)) return unavailable();
            db.exec('COMMIT'); return saved;
          }
          const draft = db.prepare('SELECT revision FROM master_drafts WHERE id=?').get(request.draftId);
          if (!draft || Number(draft.revision) !== request.expectedDraftRevision) return conflict('草稿已变化，工作台尚未保存，请刷新后确认。');
          const current = get(db, request.draftId);
          if ((current?.contextRevision ?? 0) !== request.expectedContextRevision) return conflict('工作台已在其他窗口改变，当前选择尚未保存，请刷新后确认。');
          if (request.selection.selectedPhysicalId && !db.prepare('SELECT 1 FROM physical_copies WHERE physical_id=?').get(request.selection.selectedPhysicalId)) {
            return conflict('所选实体副本不存在，工作台尚未保存，请刷新收藏。');
          }
          const reasons = stale(db, request.draftId, request.expectedDraftRevision, request.selection);
          // 同一草稿的旧规划仍可作为用户位置保存；失效原因由读取端展示，绝不改选最新版本。
          if (reasons.some(item => item.reason === 'different-draft' || item.reason === 'missing')) return conflict('所选工作对象已不属于当前草稿，工作台尚未保存，请刷新后确认。');
          const revision = request.expectedContextRevision + 1;
          db.prepare('INSERT INTO recording_workspace_contexts VALUES (?,?,?,?,?,?) ON CONFLICT(draft_id) DO UPDATE SET draft_revision=excluded.draft_revision,context_revision=excluded.context_revision,selection=excluded.selection,page_position=excluded.page_position,updated_at=excluded.updated_at').run(request.draftId, request.expectedDraftRevision, revision, JSON.stringify(request.selection), request.pagePosition, new Date().toISOString());
          const result = get(db, request.draftId);
          if (!result) return unavailable();
          db.prepare('INSERT INTO recording_workspace_ledger VALUES (?,?,?,?)').run(request.commandId, hash, JSON.stringify(result), new Date().toISOString());
          beforeCommit?.('put-recording-workspace-context');
          db.exec('COMMIT'); return result;
        } catch (error) { try { db.exec('ROLLBACK'); } catch { /* 保留原故障。 */ } throw error; }
      });
    },
  };
}
export type RecordingWorkspaceStore = ReturnType<typeof createRecordingWorkspaceStore>;

export function verifyRecordingWorkspaceDatabase(db: DatabaseSync): void {
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
  if (version < 22) return;
  const required = ['recording_workspace_contexts', 'recording_workspace_ledger'];
  if (required.some(name => !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))) throw new Error('工作台表结构缺失');
  const assertReferences = (draftId: string, selection: RecordingWorkspaceSelection): void => {
    for (const [field, table] of [
      ['planId', 'media_plans'], ['layoutId', 'layout_versions'],
      ['preparationId', 'preparation_workspaces'], ['preparedId', 'prepared_versions'],
    ] as const) {
      const id = selection[field];
      if (id && db.prepare(`SELECT draft_id FROM ${table} WHERE id=?`).get(id)?.draft_id !== draftId) throw new Error('工作台对象跨草稿或缺失');
    }
    if (selection.selectedPhysicalId && !db.prepare('SELECT 1 FROM physical_copies WHERE physical_id=?').get(selection.selectedPhysicalId)) throw new Error('工作台实体副本缺失');
  };
  for (const row of db.prepare('SELECT draft_id,draft_revision,context_revision,selection,page_position FROM recording_workspace_contexts').all()) {
    const draftId = String(row.draft_id);
    if (!db.prepare('SELECT 1 FROM master_drafts WHERE id=?').get(draftId)) throw new Error('工作台草稿引用无效');
    const value = { draftId, draftRevision: row.draft_revision, contextRevision: row.context_revision,
      selection: JSON.parse(String(row.selection)) as unknown, pagePosition: row.page_position, staleReasons: [] };
    if (!isRecordingWorkspaceContext(value)) throw new Error('工作台上下文结构无效');
    assertReferences(draftId, value.selection);
  }
  for (const row of db.prepare('SELECT command_id,fingerprint,result FROM recording_workspace_ledger').all()) {
    if (!isCollectionId(row.command_id) || !/^[0-9a-f]{64}$/u.test(String(row.fingerprint))) throw new Error('工作台回执身份无效');
    const result = JSON.parse(String(row.result)) as unknown;
    if (!isRecordingWorkspaceContext(result)) throw new Error('工作台回执结构无效');
    const current = db.prepare('SELECT context_revision FROM recording_workspace_contexts WHERE draft_id=?').get(result.draftId);
    if (!current || Number(current.context_revision) < result.contextRevision) throw new Error('工作台回执修订无效');
    assertReferences(result.draftId, result.selection);
  }
}
