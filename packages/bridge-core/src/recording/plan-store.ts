import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import * as dto from '@music-bridge/contracts';
import { mediaFingerprint } from './media-store.js';
import { captureRecordingPlan, MAX_PLAN_BYTES, MAX_PLAN_DATABASE_BYTES, MAX_PLAN_HISTORY_BYTES, recordingPlanHistoryBytes, parseRecordingPlan, planFail, recordingPlanSchema, type RecordingPlanInput } from './plan-integrity.js';

export const recordingPlansMigration = `${recordingPlanSchema.join(';')}; PRAGMA user_version=18;`;
interface Access { read<T>(fn: (db: DatabaseSync) => T): T; conflict(message: string): never; beforeCommit?: (action: string) => void; /** 仅可向下收紧的合成测试预算。 */ historyBudgetBytes?: number }
export function createRecordingPlanStore({ read, conflict, beforeCommit, historyBudgetBytes = MAX_PLAN_HISTORY_BYTES }: Access) {
  if (!Number.isSafeInteger(historyBudgetBytes) || historyBudgetBytes < 1 || historyBudgetBytes > MAX_PLAN_HISTORY_BYTES) return planFail();
  function version(db: DatabaseSync, id: string): dto.RecordingPlanVersion | null {
    if (!dto.isCollectionId(id)) return planFail();
    const row = db.prepare('SELECT data FROM recording_plan_versions WHERE id=?').get(id); return row ? parseRecordingPlan(row.data) : null;
  }
  function head(db: DatabaseSync, draftId: string): dto.RecordingPlanVersion | null {
    const row = db.prepare('SELECT data FROM recording_plan_versions WHERE draft_id=? ORDER BY sequence DESC LIMIT 1').get(draftId); return row ? parseRecordingPlan(row.data) : null;
  }
  function fingerprint(db: DatabaseSync, input: RecordingPlanInput): string {
    const current = head(db, input.draftId); return mediaFingerprint({ identity: input.identity, head: current ? { id: current.id, sequence: current.sequence, contentHash: current.contentHash } : null });
  }
  function cached(db: DatabaseSync, request: dto.FreezeRecordingPlanRequest): dto.RecordingPlanVersion | undefined {
    const row = db.prepare('SELECT fingerprint,plan_id FROM recording_plan_ledger WHERE command_id=?').get(request.commandId);
    if (!row) return undefined;
    if (row.fingerprint !== mediaFingerprint(request)) return conflict('同一操作编号不能用于不同的录音计划。');
    return version(db, String(row.plan_id)) ?? planFail();
  }
  return {
    capture: (selection: dto.RecordingPlanSelection, frozen?: dto.RecordingProfileSnapshot) => read(db => captureRecordingPlan(db, selection, frozen)),
    fingerprint: (input: RecordingPlanInput) => read(db => fingerprint(db, input)),
    cached: (request: dto.FreezeRecordingPlanRequest) => read(db => cached(db, request)),
    version(request: dto.RecordingPlanIdRequest): { plan: dto.RecordingPlanVersion | null } {
      if (!dto.isRecordingPlanIdRequest(request)) return planFail(); return read(db => ({ plan: version(db, request.id) }));
    },
    list(request: dto.RecordingPlanHistoryRequest): dto.RecordingPlanHistory {
      if (!dto.isRecordingPlanHistoryRequest(request)) return planFail();
      return read(db => {
        if (!db.prepare('SELECT id FROM master_drafts WHERE id=?').get(request.draftId)) return planFail();
        const result = { draftId: request.draftId, versions: db.prepare('SELECT data FROM recording_plan_versions WHERE draft_id=? ORDER BY sequence DESC').all(request.draftId).map(row => parseRecordingPlan(row.data)) };
        if (!dto.isRecordingPlanHistory(result) || Buffer.byteLength(JSON.stringify(result)) > historyBudgetBytes) return planFail(); return result;
      });
    },
    freeze(request: dto.FreezeRecordingPlanRequest, verified: RecordingPlanInput): dto.RecordingPlanVersion {
      if (!dto.isFreezeRecordingPlanRequest(request)) return planFail();
      return read(db => {
        db.exec('BEGIN IMMEDIATE');
        try {
          const prior = cached(db, request); if (prior) { db.exec('COMMIT'); return prior; }
          const current = captureRecordingPlan(db, request.selection);
          if (current.identity !== verified.identity || fingerprint(db, current) !== request.proposalFingerprint) return conflict('计划依赖或历史版本已经变化，请重新预览并确认。');
          const previous = head(db, current.draftId);
          if ((previous?.sequence ?? 0) >= dto.MAX_RECORDING_PLAN_VERSIONS) return conflict('此草稿的录音计划历史已达到上限。');
          const plan: dto.RecordingPlanVersion = { ...current.material, id: randomUUID(), draftId: current.draftId, sequence: (previous?.sequence ?? 0) + 1, ...(previous ? { parentId: previous.id } : {}), createdAt: new Date().toISOString(), contentHash: mediaFingerprint(current.material), status: 'frozen' };
          const data = JSON.stringify(plan), body = JSON.stringify(request);
          const history = db.prepare('SELECT count(*) n,COALESCE(sum(length(CAST(data AS BLOB))),0) bytes FROM recording_plan_versions WHERE draft_id=?').get(plan.draftId)!;
          if (recordingPlanHistoryBytes(plan.draftId, Number(history.n) + 1, Number(history.bytes) + Buffer.byteLength(data)) > historyBudgetBytes) return conflict('录音计划历史已达到响应预算，已有历史不会截断或删除。');
          const budget = db.prepare('SELECT count(*) n,COALESCE(sum(length(CAST(data AS BLOB))),0) bytes FROM recording_plan_versions').get()!;
          const ledgerBytes = Number(db.prepare('SELECT COALESCE(sum(length(CAST(request AS BLOB))),0) bytes FROM recording_plan_ledger').get()!.bytes);
          if (!dto.isRecordingPlanVersion(plan) || Buffer.byteLength(data) > MAX_PLAN_BYTES || Number(budget.n) >= 10000 || Number(budget.bytes) + ledgerBytes + Buffer.byteLength(data) + Buffer.byteLength(body) > MAX_PLAN_DATABASE_BYTES) return conflict('录音计划存储已达到安全预算，历史不会自动删除。');
          db.prepare('INSERT INTO recording_plan_versions VALUES(?,?,?,?,?,?,?,?)').run(plan.id, plan.draftId, plan.sequence, plan.parentId ?? null, plan.execution.assetId, plan.archive.operationId, plan.physicalCopy.physicalId, data);
          db.prepare('INSERT INTO recording_plan_ledger VALUES(?,?,?,?)').run(request.commandId, mediaFingerprint(request), body, plan.id);
          beforeCommit?.('freeze-recording-plan'); db.exec('COMMIT'); return plan;
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      });
    },
  };
}
export type RecordingPlanStore = ReturnType<typeof createRecordingPlanStore>;
