import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isCollectionId, type RecordingAttempt, type RenderSide } from '@music-bridge/contracts';
import { AttemptError, attemptFail, attemptPlan, parseAttempt, verifyRecordingAttemptDatabase } from './attempt-integrity.js';

/** 私有证明不写回旧Attempt/Plan/Record原文；迁移版本由repository统一设置。 */
const schema = [
  "CREATE TABLE output_run_legacy_attempts(attempt_id TEXT PRIMARY KEY REFERENCES recording_attempts(id),status TEXT NOT NULL CHECK(status IN ('in-progress','aborted','failed','interrupted','completed')),revision INTEGER NOT NULL CHECK(revision>0),head_sha256 TEXT NOT NULL,terminal_event_hash TEXT NOT NULL) STRICT",
  "CREATE TABLE output_run_barrier_events(attempt_id TEXT NOT NULL REFERENCES recording_attempts(id),side TEXT NOT NULL CHECK(side IN ('A','B','Program')),run_id TEXT NOT NULL,phase TEXT NOT NULL CHECK(phase IN ('pending','verified','failed')),plan_content_hash TEXT NOT NULL,audio_sha256 TEXT NOT NULL,at TEXT NOT NULL,reason TEXT,CHECK((phase='failed')=(reason IS NOT NULL)),PRIMARY KEY(attempt_id,side,phase)) STRICT",
  "CREATE UNIQUE INDEX output_run_one_terminal ON output_run_barrier_events(attempt_id,side) WHERE phase IN ('verified','failed')",
  "CREATE UNIQUE INDEX output_run_one_pending_run ON output_run_barrier_events(run_id) WHERE phase='pending'",
  "CREATE TRIGGER output_run_terminal_requires_pending BEFORE INSERT ON output_run_barrier_events WHEN NEW.phase!='pending' BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM output_run_barrier_events p WHERE p.attempt_id=NEW.attempt_id AND p.side=NEW.side AND p.phase='pending' AND p.run_id=NEW.run_id AND p.plan_content_hash=NEW.plan_content_hash AND p.audio_sha256=NEW.audio_sha256) THEN RAISE(ABORT,'output run pending identity mismatch') END; END",
  "CREATE TRIGGER output_run_legacy_no_update BEFORE UPDATE ON output_run_legacy_attempts BEGIN SELECT RAISE(ABORT,'immutable legacy attempt'); END",
  "CREATE TRIGGER output_run_legacy_no_delete BEFORE DELETE ON output_run_legacy_attempts BEGIN SELECT RAISE(ABORT,'immutable legacy attempt'); END",
  "CREATE TRIGGER output_run_events_no_update BEFORE UPDATE ON output_run_barrier_events BEGIN SELECT RAISE(ABORT,'immutable output run barrier'); END",
  "CREATE TRIGGER output_run_events_no_delete BEFORE DELETE ON output_run_barrier_events BEGIN SELECT RAISE(ABORT,'immutable output run barrier'); END",
] as const;

const rawHash = (value: string): string => createHash('sha256').update(value).digest('hex');
const hash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
const date = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const fail = (): never => attemptFail('IO_ERROR');
/** 共享repository在schema25接线；旧库只能只读迁移，不能签发新完成。 */
export const OUTPUT_RUN_BARRIER_SCHEMA_VERSION = 25;
export type OutputRunBarrierFailure = 'CANCELLED' | 'DRIVER_CLOSE_FAILED' | 'START_FAILED' | 'INPUT_CHANGED' | 'INPUT_UNAVAILABLE' | 'SCOPE_CHANGED' | 'BACKEND_FAILURE';
export interface OutputRunRecoveryRow {
  attemptId: string; side: RenderSide; runId: string; planContentSha256: string;
  audioSha256: string; pcmSha256: string; quietPersisted: boolean;
}
const failure = (value: unknown): value is OutputRunBarrierFailure => typeof value === 'string' && ['CANCELLED','DRIVER_CLOSE_FAILED','START_FAILED','INPUT_CHANGED','INPUT_UNAVAILABLE','SCOPE_CHANGED','BACKEND_FAILURE'].includes(value);

/** 迁移时冻结旧ID；其中仅已Completed的原始头与事件Hash可保留完成豁免。 */
export function migrateOutputRunBarriers(db: DatabaseSync): void {
  if (!db.isTransaction) return fail();
  verifyRecordingAttemptDatabase(db);
  db.exec(`${schema.join(';\n')};`);
  const insert = db.prepare('INSERT INTO output_run_legacy_attempts VALUES(?,?,?,?,?)');
  for (const row of db.prepare('SELECT a.id,a.status,a.revision,a.data,e.event_hash FROM recording_attempts a JOIN recording_attempt_events e ON e.attempt_id=a.id AND e.revision=a.revision').all()) {
    insert.run(String(row.id), String(row.status), Number(row.revision), rawHash(String(row.data)), String(row.event_hash));
  }
}

function sideOf(attempt: RecordingAttempt, side: RenderSide, runId: string) {
  const entry = attempt.sides.find(value => value.side === side && value.runId === runId);
  if (!entry) return fail();
  return entry;
}

/** Begin/BeginSide提交后、provider.start前登记；登记失败绝不启动输出。 */
export function registerOutputRunPending(db: DatabaseSync, attempt: RecordingAttempt, side: RenderSide, runId: string): void {
  if (attempt.status !== 'in-progress' || db.prepare('SELECT 1 FROM output_run_legacy_attempts WHERE attempt_id=?').get(attempt.id)) return fail();
  const current = sideOf(attempt, side, runId);
  if (current.phase !== 'outputting') return fail();
  const row = db.prepare('SELECT data FROM recording_attempts WHERE id=?').get(attempt.id);
  if (!row || String(row.data) !== JSON.stringify(attempt)) return fail();
  const at = new Date().toISOString(), safeAt = at < attempt.updatedAt ? attempt.updatedAt : at;
  db.prepare('INSERT INTO output_run_barrier_events VALUES(?,?,?,?,?,?,?,?)')
    .run(attempt.id, side, runId, 'pending', attempt.planContentHash, current.audioSha256, safeAt, null);
}

/** verified仅表示driver软件静止、末Hash与FD关闭三项已完成；不表示硬件排空或实体录制。 */
export function settleOutputRunBarrier(db: DatabaseSync, attemptId: string, side: RenderSide, runId: string, phase: 'verified' | 'failed', reason?: OutputRunBarrierFailure): void {
  if (!isCollectionId(attemptId) || !isCollectionId(runId) || (phase === 'failed') !== (reason !== undefined) || reason !== undefined && !failure(reason)) return fail();
  const row = db.prepare("SELECT plan_content_hash,audio_sha256,at FROM output_run_barrier_events WHERE attempt_id=? AND side=? AND phase='pending' AND run_id=?").get(attemptId, side, runId);
  if (!row || db.prepare("SELECT 1 FROM output_run_barrier_events WHERE attempt_id=? AND side=? AND phase IN ('verified','failed')").get(attemptId, side)) return fail();
  const head = db.prepare('SELECT data FROM recording_attempts WHERE id=?').get(attemptId);
  if (!head) return fail();
  const attempt = parseAttempt(head.data), current = sideOf(attempt, side, runId);
  if (attempt.planContentHash !== row.plan_content_hash || current.audioSha256 !== row.audio_sha256 || phase === 'verified' && (!current.sourceEof || !current.backendDrained)) return fail();
  const at = new Date().toISOString(), floor = String(row.at) > attempt.updatedAt ? String(row.at) : attempt.updatedAt;
  db.prepare('INSERT INTO output_run_barrier_events VALUES(?,?,?,?,?,?,?,?)')
    .run(attemptId, side, runId, phase, row.plan_content_hash, row.audio_sha256, at < floor ? floor : at, reason ?? null);
}

/** 与最终确认放在同一BEGIN IMMEDIATE事务，不能仅靠内存slot或backend-drained。 */
export function assertOutputRunFinalReady(db: DatabaseSync, attempt: RecordingAttempt): void {
  if (!db.isTransaction || !attempt.sides.every(side => side.runId && side.sourceEof && side.backendDrained)) return attemptFail('INVALID_TRANSITION');
  for (const side of attempt.sides) assertOutputRunSideReady(db, attempt, side.side);
}

/** B面开始也必须在同一事务确认A面精确软件关闭与输入末核验。 */
export function assertOutputRunSideReady(db: DatabaseSync, attempt: RecordingAttempt, sideName: RenderSide): void {
  if (!db.isTransaction) return attemptFail('INVALID_TRANSITION');
  const side = attempt.sides.find(value => value.side === sideName);
  if (!side?.runId || !side.sourceEof || !side.backendDrained) return attemptFail('INVALID_TRANSITION');
  const rows = db.prepare('SELECT phase,run_id,plan_content_hash,audio_sha256 FROM output_run_barrier_events WHERE attempt_id=? AND side=? ORDER BY phase').all(attempt.id, side.side);
  if (rows.length !== 2 || rows.some(row => row.run_id !== side.runId || row.plan_content_hash !== attempt.planContentHash || row.audio_sha256 !== side.audioSha256)
    || !rows.some(row => row.phase === 'pending') || !rows.some(row => row.phase === 'verified')) return attemptFail('INVALID_TRANSITION');
}

/** 单一SQLite快照内取得每个持久pending run；成功/失败barrier也不能跳过sidecar撤销。 */
export function readOutputRunRecoveryRows(db: DatabaseSync): readonly OutputRunRecoveryRow[] {
  if (!db.isTransaction) return fail();
  verifyOutputRunBarrierDatabase(db);
  const rows: OutputRunRecoveryRow[] = [];
  for (const row of db.prepare("SELECT p.attempt_id,p.side,p.run_id,p.plan_content_hash,p.audio_sha256,a.data,t.phase terminal_phase FROM output_run_barrier_events p JOIN recording_attempts a ON a.id=p.attempt_id LEFT JOIN output_run_barrier_events t ON t.attempt_id=p.attempt_id AND t.side=p.side AND t.phase IN ('verified','failed') WHERE p.phase='pending' ORDER BY p.attempt_id,p.side").all()) {
    const attempt = parseAttempt(row.data), side = attempt.sides.find(item => item.side === row.side && item.runId === row.run_id);
    const plan = attemptPlan(db, attempt.planVersionId), receipt = plan.execution.audio.find(item => item.recipe.side === row.side);
    if (!side || !receipt || plan.contentHash !== row.plan_content_hash || attempt.planContentHash !== plan.contentHash
      || side.audioSha256 !== row.audio_sha256 || receipt.audio.sha256 !== side.audioSha256
      || receipt.audio.pcmSha256 !== side.pcmSha256 || row.terminal_phase !== null && row.terminal_phase !== 'verified' && row.terminal_phase !== 'failed') return fail();
    rows.push({ attemptId: attempt.id, side: side.side, runId: side.runId!, planContentSha256: plan.contentHash,
      audioSha256: side.audioSha256, pcmSha256: side.pcmSha256,
      quietPersisted: row.terminal_phase === 'verified' || side.engineStoppedSubmitting && side.cleanupQuiescent });
  }
  return rows;
}

/** 冷启、备份和恢复共同调用；不把缺证明的新Completed误认成旧历史。 */
export function verifyOutputRunBarrierDatabase(db: DatabaseSync): void {
  try {
    const objects = db.prepare("SELECT sql FROM sqlite_schema WHERE name GLOB 'output_run_*' AND sql IS NOT NULL").all().map(row => String(row.sql));
    if (objects.length !== schema.length || objects.some(sql => !schema.includes(sql as typeof schema[number]))) return fail();
    if (db.prepare('PRAGMA foreign_key_check').get()) return fail();
    const legacy = db.prepare('SELECT count(*) n,COALESCE(sum(length(attempt_id)+length(status)+length(head_sha256)+length(terminal_event_hash)),0) bytes FROM output_run_legacy_attempts').get()!;
    const events = db.prepare('SELECT count(*) n,COALESCE(sum(length(attempt_id)+length(side)+length(run_id)+length(phase)+length(plan_content_hash)+length(audio_sha256)+length(at)+COALESCE(length(reason),0)),0) bytes FROM output_run_barrier_events').get()!;
    if (Number(legacy.n) > 10_000 || Number(legacy.bytes) > 2_000_000 || Number(events.n) > 40_000 || Number(events.bytes) > 12_000_000) return fail();
    const oldIds = new Set<string>();
    for (const row of db.prepare('SELECT * FROM output_run_legacy_attempts').all()) {
      const current = db.prepare('SELECT revision,status,data FROM recording_attempts WHERE id=?').get(String(row.attempt_id));
      const frozen = db.prepare('SELECT event_hash FROM recording_attempt_events WHERE attempt_id=? AND revision=?').get(String(row.attempt_id), Number(row.revision));
      if (!isCollectionId(row.attempt_id) || !Number.isSafeInteger(row.revision) || !hash(row.head_sha256) || !hash(row.terminal_event_hash)
        || !['in-progress','aborted','failed','interrupted','completed'].includes(String(row.status)) || !current || !frozen
        || frozen.event_hash !== row.terminal_event_hash
        || (row.status === 'completed'
          ? current.status !== 'completed' || current.revision !== row.revision || rawHash(String(current.data)) !== row.head_sha256
          : row.status === 'in-progress' ? current.status !== 'interrupted' && current.status !== 'in-progress' : current.status !== row.status)) return fail();
      oldIds.add(String(row.attempt_id));
    }
    const barriers = new Map<string, Map<string, Record<string, unknown>[]>>();
    for (const row of db.prepare('SELECT * FROM output_run_barrier_events ORDER BY attempt_id,side,phase').all()) {
      if (!isCollectionId(row.attempt_id) || !isCollectionId(row.run_id) || !['A','B','Program'].includes(String(row.side)) || !['pending','verified','failed'].includes(String(row.phase))
        || !hash(row.plan_content_hash) || !hash(row.audio_sha256) || !date(row.at) || (row.phase === 'failed' ? !failure(row.reason) : row.reason !== null)) return fail();
      const bySide = barriers.get(String(row.attempt_id)) ?? new Map<string, Record<string, unknown>[]>();
      const entries = bySide.get(String(row.side)) ?? []; entries.push(row); bySide.set(String(row.side), entries); barriers.set(String(row.attempt_id), bySide);
    }
    for (const row of db.prepare('SELECT id,data FROM recording_attempts').all()) {
      const attempt = parseAttempt(row.data), bySide = barriers.get(attempt.id);
      if (oldIds.has(attempt.id)) { if (bySide) return fail(); continue; }
      for (const side of attempt.sides) {
        const entries = bySide?.get(side.side) ?? [], pending = entries.find(item => item.phase === 'pending'), terminal = entries.find(item => item.phase !== 'pending');
        if (entries.length > 2 || (entries.length && !pending)
          || pending && (!side.runId || !side.startedAt || side.phase === 'pending' || String(pending.at) < side.startedAt)
          || entries.some(item => item.run_id !== side.runId || item.plan_content_hash !== attempt.planContentHash || item.audio_sha256 !== side.audioSha256)
          || terminal && (!pending || String(terminal.at) < String(pending.at)) || attempt.status === 'completed' && (!pending || terminal?.phase !== 'verified')
          || terminal?.phase === 'verified' && (!side.sourceEof || !side.backendDrained)
          || !pending && (side.sourceFramesRead > 0 || side.submittedFrames > 0 || side.consumedFrames > 0 || side.sourceEof || side.backendDrained)) return fail();
      }
      if (bySide && [...bySide.keys()].some(side => !attempt.sides.some(value => value.side === side))) return fail();
    }
  } catch (error) { if (error instanceof AttemptError) throw error; return fail(); }
}
