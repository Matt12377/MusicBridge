import type { DatabaseSync } from 'node:sqlite';
import * as dto from '@music-bridge/contracts';
import { mediaFingerprint } from './media-store.js';
import { parseRecordingPlan } from './plan-integrity.js';
import { beginRecordingAttempt, reduceRecordingAttempt, isRecordingAttemptEvent, type RecordingAttemptEvent } from './attempt-state.js';

export class AttemptError extends Error {
  constructor(readonly code: dto.RecordingAttemptErrorCode) { super(`录音操作未完成，请核实当前状态。[${code}]`); }
}
export function attemptFail(code: dto.RecordingAttemptErrorCode = 'IO_ERROR'): never { throw new AttemptError(code); }
export const MAX_ATTEMPT_BYTES = 16 * 1024;
export const MAX_ATTEMPT_DATABASE_BYTES = 128 * 1024 * 1024;
export const MAX_ATTEMPTS = 10_000, MAX_ATTEMPT_EVENTS = 100_000, MAX_ATTEMPT_RECEIPTS = 100_000;
export type AttemptCommand = 'begin' | 'confirm' | 'beginSide' | 'stop';
export type AttemptRequest = dto.BeginRecordingAttemptRequest | dto.ConfirmRecordingAttemptRequest | dto.BeginRecordingAttemptSideRequest | dto.StopRecordingAttemptRequest;
export type AttemptStoredEvent = RecordingAttemptEvent | { type: 'begin'; at: string; runId: string };
export interface AttemptEventData { event: AttemptStoredEvent; after: dto.RecordingAttempt }
export interface AttemptReceiptData { action: AttemptCommand; request: AttemptRequest; event: AttemptStoredEvent; baseRevision: number }
export function validAttemptRequest(action: AttemptCommand, value: unknown): value is AttemptRequest {
  return action === 'begin' ? dto.isBeginRecordingAttemptRequest(value) : action === 'confirm' ? dto.isConfirmRecordingAttemptRequest(value) : action === 'beginSide' ? dto.isBeginRecordingAttemptSideRequest(value) : action === 'stop' && dto.isStopRecordingAttemptRequest(value);
}
export function parseAttempt(value: unknown): dto.RecordingAttempt {
  const text = String(value); if (Buffer.byteLength(text) > MAX_ATTEMPT_BYTES) return attemptFail();
  const parsed: unknown = JSON.parse(text); if (!dto.isRecordingAttempt(parsed)) return attemptFail(); return parsed;
}
export function attemptPlan(db: DatabaseSync, id: string): dto.RecordingPlanVersion {
  const row = db.prepare('SELECT data FROM recording_plan_versions WHERE id=?').get(id);
  if (!row) return attemptFail('PLAN_UNAVAILABLE'); return parseRecordingPlan(row.data);
}
function exactKeys(value: unknown, keys: string[]): boolean { return !!value && typeof value === 'object' && Object.keys(value).sort().join(',') === keys.sort().join(','); }
export function validStoredAttemptEvent(event: unknown): event is AttemptStoredEvent {
  if (!event || typeof event !== 'object') return false;
  const value = event as { type?: unknown; at?: unknown; runId?: unknown };
  if (value.type !== 'begin') return isRecordingAttemptEvent(event);
  return exactKeys(value, ['type', 'at', 'runId']) && dto.isCollectionId(value.runId) && typeof value.at === 'string' && Number.isFinite(Date.parse(value.at)) && new Date(value.at).toISOString() === value.at;
}
export function requestMatchesAttemptEvent(action: AttemptCommand, request: AttemptRequest, event: AttemptStoredEvent): boolean {
  if (action === 'begin') return event.type === 'begin';
  if (action === 'stop') return event.type === 'abort' && event.reason === 'user-stop';
  if (action === 'beginSide') return event.type === 'begin-side' && event.side === 'B';
  const confirmation = request as dto.ConfirmRecordingAttemptRequest;
  return event.type === 'confirm' && event.kind === confirmation.kind && (confirmation.kind !== 'physical-stop' || event.kind === 'physical-stop' && event.side === confirmation.side);
}
export function replayAttemptEvent(id: string, plan: dto.RecordingPlanVersion, before: dto.RecordingAttempt | undefined, event: AttemptStoredEvent): dto.RecordingAttempt {
  if (event.type === 'begin') {
    if (before) return attemptFail();
    return beginRecordingAttempt({ id, plan, startedAt: event.at, generation: event.runId });
  }
  if (!before) return attemptFail(); return reduceRecordingAttempt(before, event);
}

/** 纯只读：验证schema、预算、每条事件可重演、当前头及命令回执的同版本守恒。 */
export function verifyRecordingAttemptDatabase(db: DatabaseSync): void {
  try {
    const objects = db.prepare("SELECT sql FROM sqlite_schema WHERE name GLOB 'recording_attempt*'").all();
    if (objects.length !== recordingAttemptSchema.length || objects.some(row => !recordingAttemptSchema.includes(String(row.sql) as typeof recordingAttemptSchema[number]))) return attemptFail();
    let bytes = 0;
    for (const [table, maximum, columns] of [
      ['recording_attempts', MAX_ATTEMPTS, ['data']], ['recording_attempt_events', MAX_ATTEMPT_EVENTS, ['data']], ['recording_attempt_receipts', MAX_ATTEMPT_RECEIPTS, ['request', 'result']],
    ] as const) {
      const row = db.prepare(`SELECT count(*) n,COALESCE(sum(${columns.map(column => `length(CAST(${column} AS BLOB))`).join('+')}),0) bytes FROM ${table}`).get()!;
      if (Number(row.n) > maximum) return attemptFail(); bytes += Number(row.bytes);
    }
    if (bytes > MAX_ATTEMPT_DATABASE_BYTES || db.prepare('PRAGMA foreign_key_check').get()) return attemptFail();
    let active = 0;
    for (const row of db.prepare('SELECT * FROM recording_attempts ORDER BY id').iterate()) {
      const current = parseAttempt(row.data), plan = attemptPlan(db, String(row.plan_id));
      if (current.id !== row.id || current.planVersionId !== row.plan_id || current.draftId !== row.draft_id || current.physicalId !== row.physical_id || current.status !== row.status || current.revision !== row.revision || current.planContentHash !== plan.contentHash || current.draftId !== plan.draftId || current.physicalId !== plan.physicalCopy.physicalId) return attemptFail();
      let previous: dto.RecordingAttempt | undefined, previousHash = '';
      for (const eventRow of db.prepare('SELECT * FROM recording_attempt_events WHERE attempt_id=? ORDER BY revision').iterate(current.id)) {
        if (Buffer.byteLength(String(eventRow.data)) > MAX_ATTEMPT_BYTES * 2) return attemptFail();
        const data = JSON.parse(String(eventRow.data)) as AttemptEventData;
        if (!exactKeys(data, ['event', 'after']) || !validStoredAttemptEvent(data.event) || data.event.type !== eventRow.kind || eventRow.revision !== (previous?.revision ?? 0) + 1 || eventRow.previous_hash !== previousHash) return attemptFail();
        const after = replayAttemptEvent(current.id, plan, previous, data.event);
        if (!dto.isRecordingAttempt(data.after) || mediaFingerprint(after) !== mediaFingerprint(data.after) || after.revision !== eventRow.revision) return attemptFail();
        const hash = mediaFingerprint({ id: current.id, revision: after.revision, previousHash, data });
        if (hash !== eventRow.event_hash) return attemptFail(); previousHash = hash; previous = after;
      }
      if (!previous || mediaFingerprint(previous) !== mediaFingerprint(current)) return attemptFail();
      const heldCopy = db.prepare('SELECT usage FROM physical_copies WHERE physical_id=?').get(current.physicalId);
      if (!heldCopy || heldCopy.usage === 'blank' || heldCopy.usage === 'erased') return attemptFail();
      if (current.status === 'in-progress') {
        if (++active > 1) return attemptFail();
        const reservation = db.prepare('SELECT physical_id FROM media_reservations WHERE plan_id=?').get(plan.layout.planId);
        if (reservation?.physical_id !== current.physicalId || heldCopy.usage !== 'reserved') return attemptFail();
      }
    }
    for (const row of db.prepare('SELECT * FROM recording_attempt_receipts ORDER BY command_id').iterate()) {
      const stored = JSON.parse(String(row.request)) as AttemptReceiptData, result = parseAttempt(row.result);
      if (!exactKeys(stored, ['action', 'request', 'event', 'baseRevision']) || !validAttemptRequest(stored.action, stored.request) || !validStoredAttemptEvent(stored.event) || !requestMatchesAttemptEvent(stored.action, stored.request, stored.event)
        || stored.request.commandId !== row.command_id || row.fingerprint !== mediaFingerprint({ action: stored.action, request: stored.request }) || result.id !== row.attempt_id || result.revision !== row.revision || !Number.isSafeInteger(stored.baseRevision) || stored.baseRevision < 0) return attemptFail();
      const selected = db.prepare('SELECT data FROM recording_attempt_events WHERE attempt_id=? AND revision=?').get(result.id, result.revision);
      if (!selected || mediaFingerprint((JSON.parse(String(selected.data)) as AttemptEventData).after) !== mediaFingerprint(result)) return attemptFail();
      const plan = attemptPlan(db, result.planVersionId);
      const beforeRow = stored.baseRevision ? db.prepare('SELECT data FROM recording_attempt_events WHERE attempt_id=? AND revision=?').get(result.id, stored.baseRevision) : undefined;
      if (stored.baseRevision && !beforeRow) return attemptFail();
      const before = beforeRow ? (JSON.parse(String(beforeRow.data)) as AttemptEventData).after : undefined;
      if (stored.action === 'begin') {
        const request = stored.request as dto.BeginRecordingAttemptRequest;
        if (stored.baseRevision !== 0 || request.planVersionId !== result.planVersionId || request.planContentHash !== result.planContentHash) return attemptFail();
      } else {
        const request = stored.request as Exclude<AttemptRequest, dto.BeginRecordingAttemptRequest>;
        if (request.attemptId !== result.id || 'expectedRevision' in request && request.expectedRevision !== stored.baseRevision) return attemptFail();
      }
      if (mediaFingerprint(replayAttemptEvent(result.id, plan, before, stored.event)) !== mediaFingerprint(result)) return attemptFail();
    }
    if (db.prepare("SELECT 1 FROM recording_attempts a WHERE NOT EXISTS(SELECT 1 FROM recording_attempt_receipts r WHERE r.attempt_id=a.id AND json_extract(r.request,'$.action')='begin') LIMIT 1").get()) return attemptFail();
  } catch (error) { if (error instanceof AttemptError) throw error; return attemptFail(); }
}

export const recordingAttemptSchema = [
  'CREATE TABLE recording_attempts(id TEXT PRIMARY KEY,plan_id TEXT NOT NULL REFERENCES recording_plan_versions(id),draft_id TEXT NOT NULL REFERENCES master_drafts(id),physical_id TEXT NOT NULL REFERENCES physical_copies(physical_id),status TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),data TEXT NOT NULL) STRICT',
  'CREATE TABLE recording_attempt_events(attempt_id TEXT NOT NULL REFERENCES recording_attempts(id) DEFERRABLE INITIALLY DEFERRED,revision INTEGER NOT NULL CHECK(revision>0),kind TEXT NOT NULL,data TEXT NOT NULL,previous_hash TEXT NOT NULL,event_hash TEXT NOT NULL,PRIMARY KEY(attempt_id,revision)) STRICT',
  'CREATE TABLE recording_attempt_receipts(command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,request TEXT NOT NULL,attempt_id TEXT NOT NULL,revision INTEGER NOT NULL,result TEXT NOT NULL,FOREIGN KEY(attempt_id,revision) REFERENCES recording_attempt_events(attempt_id,revision)) STRICT',
  "CREATE UNIQUE INDEX recording_attempt_one_active ON recording_attempts(status) WHERE status='in-progress'",
  "CREATE TRIGGER recording_attempt_events_no_update BEFORE UPDATE ON recording_attempt_events BEGIN SELECT RAISE(ABORT,'录音事件不可改写'); END",
  "CREATE TRIGGER recording_attempt_events_no_delete BEFORE DELETE ON recording_attempt_events BEGIN SELECT RAISE(ABORT,'录音事件不可删除'); END",
  "CREATE TRIGGER recording_attempt_receipts_no_update BEFORE UPDATE ON recording_attempt_receipts BEGIN SELECT RAISE(ABORT,'录音命令回执不可改写'); END",
  "CREATE TRIGGER recording_attempt_receipts_no_delete BEFORE DELETE ON recording_attempt_receipts BEGIN SELECT RAISE(ABORT,'录音命令回执不可删除'); END",
  "CREATE TRIGGER recording_attempts_no_delete BEFORE DELETE ON recording_attempts BEGIN SELECT RAISE(ABORT,'录音历史不可删除'); END",
  "CREATE TRIGGER recording_attempt_copy_no_blank BEFORE UPDATE OF usage ON physical_copies WHEN NEW.usage IN ('blank','erased') AND EXISTS(SELECT 1 FROM recording_attempts WHERE physical_id=OLD.physical_id) BEGIN SELECT RAISE(ABORT,'可能已写入的实体不能自动恢复空白'); END",
  "CREATE TRIGGER recording_attempt_reservation_no_delete BEFORE DELETE ON media_reservations WHEN EXISTS(SELECT 1 FROM recording_attempts WHERE physical_id=OLD.physical_id) BEGIN SELECT RAISE(ABORT,'录音实体占用须经明确处置'); END",
  "CREATE TRIGGER recording_attempt_reservation_no_rebind BEFORE UPDATE ON media_reservations WHEN EXISTS(SELECT 1 FROM recording_attempts WHERE physical_id=OLD.physical_id) BEGIN SELECT RAISE(ABORT,'录音实体占用不可自动改绑'); END",
  "CREATE TRIGGER recording_attempt_active_media_no_update BEFORE UPDATE ON media_plans WHEN EXISTS(SELECT 1 FROM recording_attempts a JOIN recording_plan_versions p ON p.id=a.plan_id WHERE a.status='in-progress' AND json_extract(p.data,'$.layout.planId')=OLD.id) BEGIN SELECT RAISE(ABORT,'活动录音的媒体规划不可修改'); END",
] as const;

export const recordingAttemptsMigration = `${recordingAttemptSchema.join(';')}; PRAGMA user_version=19;`;

/** 先保护可能已写入的实体；失败、停止和恢复均不能沿旧规划路径变回空白。 */
export function assertRecordingAttemptCopyReleasable(db: DatabaseSync, physicalId: string, conflict: (message: string) => never): void {
  if (db.prepare('SELECT 1 FROM recording_attempts WHERE physical_id=? LIMIT 1').get(physicalId)) conflict('这盘磁带可能已写入录音，请先核实并通过录音档案明确处置；不能自动恢复为空白。');
}
