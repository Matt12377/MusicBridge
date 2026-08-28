import { beginPhysicalRecording, registerCompletedRecording, type RecordingRecordBudgets } from './record-store.js';
import { recordingPermitMatchesPlan, verifyRecordingRecordDatabase } from './record-integrity.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import * as dto from '@music-bridge/contracts';
import { createRecordingPlanStore } from './plan-store.js';
import { mediaFingerprint } from './media-store.js';
import { captureRecordingOutput, type RecordingOutputInput } from './output-input.js';
import { RecordingAttemptStateError, type RecordingAttemptEvent } from './attempt-state.js';
import { AttemptError, attemptFail, attemptPlan, parseAttempt, replayAttemptEvent, requestMatchesAttemptEvent, validAttemptRequest, verifyRecordingAttemptDatabase,
  MAX_ATTEMPTS, MAX_ATTEMPT_EVENTS, MAX_ATTEMPT_RECEIPTS, MAX_ATTEMPT_BYTES, MAX_ATTEMPT_DATABASE_BYTES,
  type AttemptCommand, type AttemptRequest, type AttemptStoredEvent, type AttemptEventData, type AttemptReceiptData } from './attempt-integrity.js';

interface Access extends RecordingRecordBudgets { read<T>(fn: (db: DatabaseSync) => T): T; beforeCommit?: (action: string) => void; databaseBudgetBytes?: number }
function get(db: DatabaseSync, id: string): dto.RecordingAttempt | null {
  const row = db.prepare('SELECT * FROM recording_attempts WHERE id=?').get(id); if (!row) return null;
  const current = parseAttempt(row.data), last = db.prepare('SELECT data FROM recording_attempt_events WHERE attempt_id=? ORDER BY revision DESC LIMIT 1').get(id);
  if (!last || mediaFingerprint((JSON.parse(String(last.data)) as AttemptEventData).after) !== mediaFingerprint(current)
    || current.id !== row.id || current.revision !== row.revision || current.status !== row.status || current.physicalId !== row.physical_id || current.planVersionId !== row.plan_id || current.draftId !== row.draft_id) return attemptFail();
  return current;
}
function reserveBudget(db: DatabaseSync, added: number, event: boolean, receipt: boolean, emergency: boolean, maximum: number): void {
  let bytes = added;
  for (const [table, columns] of [['recording_attempts', ['data']], ['recording_attempt_events', ['data']], ['recording_attempt_receipts', ['request', 'result']]] as const) {
    bytes += Number(db.prepare(`SELECT COALESCE(sum(${columns.map(column => `length(CAST(${column} AS BLOB))`).join('+')}),0) bytes FROM ${table}`).get()!.bytes);
  }
  // 为一个活动Attempt保留终止/恢复空间；正常进度不能耗尽安全停止的最后容量。
  if (bytes > maximum - (emergency ? 0 : MAX_ATTEMPT_BYTES * 4)
    || Number(db.prepare('SELECT count(*) n FROM recording_attempt_events').get()!.n) + Number(event) > MAX_ATTEMPT_EVENTS - (emergency ? 0 : 4)
    || Number(db.prepare('SELECT count(*) n FROM recording_attempt_receipts').get()!.n) + Number(receipt) > MAX_ATTEMPT_RECEIPTS - (emergency ? 0 : 1)) return attemptFail('BUDGET_EXCEEDED');
}
function append(db: DatabaseSync, before: dto.RecordingAttempt | undefined, after: dto.RecordingAttempt, event: AttemptStoredEvent): void {
  const data: AttemptEventData = { event, after }, encoded = JSON.stringify(data);
  if (Buffer.byteLength(encoded) > MAX_ATTEMPT_BYTES * 2 || Buffer.byteLength(JSON.stringify(after)) > MAX_ATTEMPT_BYTES) return attemptFail('BUDGET_EXCEEDED');
  const previousHash = before ? String(db.prepare('SELECT event_hash FROM recording_attempt_events WHERE attempt_id=? AND revision=?').get(before.id, before.revision)?.event_hash ?? '') : '';
  if (before && !previousHash) return attemptFail();
  db.prepare('INSERT INTO recording_attempts VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,revision=excluded.revision,data=excluded.data')
    .run(after.id, after.planVersionId, after.draftId, after.physicalId, after.status, after.revision, JSON.stringify(after));
  db.prepare('INSERT INTO recording_attempt_events VALUES(?,?,?,?,?,?)').run(after.id, after.revision, event.type, encoded, previousHash, mediaFingerprint({ id: after.id, revision: after.revision, previousHash, data }));
}

/** 调用方拥有事务；必须先验证，绝不以恢复事件掩盖损坏头或历史。 */
export function recoverRecordingAttempts(db: DatabaseSync, at: string): void {
  verifyRecordingAttemptDatabase(db);
  for (const row of db.prepare("SELECT data FROM recording_attempts WHERE status='in-progress'").all()) {
    const before = parseAttempt(row.data), event = { type: 'recover', at: at < before.updatedAt ? before.updatedAt : at } as const;
    const after = replayAttemptEvent(before.id, attemptPlan(db, before.planVersionId), before, event);
    const added = Buffer.byteLength(JSON.stringify({ event, after })) + Buffer.byteLength(JSON.stringify(after)) - Buffer.byteLength(JSON.stringify(before));
    reserveBudget(db, added, true, false, true, MAX_ATTEMPT_DATABASE_BYTES); append(db, before, after, event);
  }
}

export function createRecordingAttemptStore({ read, beforeCommit, databaseBudgetBytes = MAX_ATTEMPT_DATABASE_BYTES, metadataBudgetBytes, visualBudgetBytes }: Access) {
  if (!Number.isSafeInteger(databaseBudgetBytes) || databaseBudgetBytes < MAX_ATTEMPT_BYTES * 5 || databaseBudgetBytes > MAX_ATTEMPT_DATABASE_BYTES) return attemptFail('INVALID_REQUEST');
  const recordBudgets = { ...(metadataBudgetBytes === undefined ? {} : { metadataBudgetBytes }), ...(visualBudgetBytes === undefined ? {} : { visualBudgetBytes }) };
  const plans = createRecordingPlanStore({ read, conflict: () => attemptFail('PLAN_CHANGED') });
  function cached(db: DatabaseSync, action: AttemptCommand, request: AttemptRequest): dto.RecordingAttempt | undefined {
    const row = db.prepare('SELECT fingerprint,result FROM recording_attempt_receipts WHERE command_id=?').get(request.commandId);
    if (!row) return undefined;
    if (row.fingerprint !== mediaFingerprint({ action, request })) return attemptFail('COMMAND_CONFLICT');
    return parseAttempt(row.result);
  }
  function transaction<T>(action: string, fn: (db: DatabaseSync) => T): T {
    return read(db => {
      db.exec('BEGIN IMMEDIATE');
      try { verifyRecordingAttemptDatabase(db); if (Number(db.prepare('PRAGMA user_version').get()!.user_version) >= 20) verifyRecordingRecordDatabase(db); const result = fn(db); beforeCommit?.(action); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); if (error instanceof RecordingAttemptStateError) return attemptFail(error.code); if (error instanceof AttemptError) throw error; return attemptFail(); }
    });
  }
  function command(db: DatabaseSync, action: AttemptCommand, request: AttemptRequest, event: AttemptStoredEvent, initial?: dto.RecordingPlanVersion) {
    const prior = cached(db, action, request); if (prior) return prior;
    if (!requestMatchesAttemptEvent(action, request, event)) return attemptFail('INVALID_REQUEST');
    const before = 'attemptId' in request ? get(db, request.attemptId) ?? attemptFail('ATTEMPT_NOT_FOUND') : undefined;
    if ('expectedRevision' in request && request.expectedRevision !== before?.revision) return attemptFail('VERSION_MISMATCH');
    const plan = initial ?? attemptPlan(db, before!.planVersionId), id = before?.id ?? randomUUID();
    const after = replayAttemptEvent(id, plan, before, event), changed = !before || after.revision !== before.revision;
    const receipt: AttemptReceiptData = { action, request, event, baseRevision: before?.revision ?? 0 };
    const body = JSON.stringify(receipt), result = JSON.stringify(after);
    const added = Buffer.byteLength(body) + Buffer.byteLength(result) + (changed ? Buffer.byteLength(JSON.stringify({ event, after })) + Buffer.byteLength(result) - (before ? Buffer.byteLength(JSON.stringify(before)) : 0) : 0);
    reserveBudget(db, added, changed, true, action === 'stop', databaseBudgetBytes);
    if (changed) {
      append(db, before, after, event);
      if (Number(db.prepare('PRAGMA user_version').get()!.user_version) >= 20) {
        if (!before) beginPhysicalRecording(db, after, plan, recordBudgets);
        if (after.status === 'completed' && before?.status !== 'completed') registerCompletedRecording(db, after, recordBudgets);
      }
    }
    db.prepare('INSERT INTO recording_attempt_receipts VALUES(?,?,?,?,?,?)').run(request.commandId, mediaFingerprint({ action, request }), body, after.id, after.revision, result);
    return after;
  }
  return {
    plans,
    capture(planVersionId: string, planContentHash: string, side?: dto.RenderSide): RecordingOutputInput {
      try {
        const plan = plans.version({ id: planVersionId }).plan ?? attemptFail('PLAN_UNAVAILABLE');
        if (plan.contentHash !== planContentHash) return attemptFail('PLAN_CHANGED');
        const selectedSide = side ?? plan.execution.audio[0]!.recipe.side;
        return captureRecordingOutput(plans, { planVersionId, side: selectedSide, runId: randomUUID() });
      } catch (error) { if (error instanceof AttemptError) throw error; return attemptFail('PLAN_CHANGED'); }
    },
    cached(action: AttemptCommand, request: AttemptRequest) {
      if (!validAttemptRequest(action, request)) return attemptFail('INVALID_REQUEST');
      return read(db => cached(db, action, request));
    },
    get(request: dto.RecordingAttemptIdRequest): { attempt: dto.RecordingAttempt | null } {
      if (!dto.isRecordingAttemptIdRequest(request)) return attemptFail('INVALID_REQUEST');
      return read(db => ({ attempt: get(db, request.attemptId) }));
    },
    list(request: dto.ListRecordingAttemptsRequest): dto.RecordingAttemptsPage {
      if (!dto.isListRecordingAttemptsRequest(request)) return attemptFail('INVALID_REQUEST');
      return read(db => {
        const clauses: string[] = [], values: string[] = [];
        for (const [field, column] of [['draftId', 'draft_id'], ['planVersionId', 'plan_id'], ['physicalId', 'physical_id']] as const) if (request[field]) { clauses.push(`${column}=?`); values.push(request[field]!); }
        const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
        const total = Number(db.prepare(`SELECT count(*) n FROM recording_attempts${where}`).get(...values)!.n);
        const items = db.prepare(`SELECT id FROM recording_attempts${where} ORDER BY rowid DESC LIMIT ? OFFSET ?`).all(...values, request.page.limit, request.page.offset).map(row => get(db, String(row.id))!);
        const result = { items, ...request.page, total, hasMore: request.page.offset + items.length < total };
        if (!dto.isRecordingAttemptsPage(result)) return attemptFail(); return result;
      });
    },
    begin(request: dto.BeginRecordingAttemptRequest, verified: RecordingOutputInput, runId: string): dto.RecordingAttempt {
      if (!dto.isBeginRecordingAttemptRequest(request)) return attemptFail('INVALID_REQUEST');
      return transaction('attempt-begin', db => {
        const prior = cached(db, 'begin', request); if (prior) return prior;
        if (db.prepare("SELECT 1 FROM recording_attempts WHERE status='in-progress'").get()) return attemptFail('ATTEMPT_CONFLICT');
        if (Number(db.prepare('SELECT count(*) n FROM recording_attempts').get()!.n) >= MAX_ATTEMPTS) return attemptFail('BUDGET_EXCEEDED');
        const current = this.capture(request.planVersionId, request.planContentHash, verified.receipt.recipe.side);
        if (current.facts.identity !== verified.facts.identity) return attemptFail('PLAN_CHANGED');
        if (db.prepare('SELECT 1 FROM recording_attempts WHERE physical_id=? LIMIT 1').get(current.plan.physicalCopy.physicalId) && !recordingPermitMatchesPlan(db, current.plan.physicalCopy.physicalId, current.plan.layout.planId, current.plan.mediaPlanRevision)) return attemptFail('COPY_UNAVAILABLE');
        return command(db, 'begin', request, { type: 'begin', runId, at: new Date().toISOString() }, current.plan);
      });
    },
    command(action: Exclude<AttemptCommand, 'begin'>, request: Exclude<AttemptRequest, dto.BeginRecordingAttemptRequest>, event: RecordingAttemptEvent): dto.RecordingAttempt {
      if (!validAttemptRequest(action, request)) return attemptFail('INVALID_REQUEST');
      return transaction(`attempt-${action}`, db => command(db, action, request, event));
    },
    event(attemptId: string, event: RecordingAttemptEvent): dto.RecordingAttempt {
      return transaction('attempt-event', db => {
        const before = get(db, attemptId) ?? attemptFail('ATTEMPT_NOT_FOUND');
        const after = replayAttemptEvent(before.id, attemptPlan(db, before.planVersionId), before, event);
        if (after.revision === before.revision) return before;
        const added = Buffer.byteLength(JSON.stringify({ event, after })) + Buffer.byteLength(JSON.stringify(after)) - Buffer.byteLength(JSON.stringify(before));
        reserveBudget(db, added, true, false, ['recover', 'interrupt', 'fail', 'abort', 'engine-cutoff', 'stop-ack', 'cleanup-quiescent'].includes(event.type), databaseBudgetBytes);
        append(db, before, after, event);
        if (Number(db.prepare('PRAGMA user_version').get()!.user_version) >= 20 && after.status === 'completed' && before.status !== 'completed') registerCompletedRecording(db, after, recordBudgets);
        return after;
      });
    },
  };
}
export type RecordingAttemptStore = ReturnType<typeof createRecordingAttemptStore>;
