import { recordingAttempt20Protection } from './record-integrity.js';
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

export interface RecordingAttemptAuditOptions { maxBytes?: number; maxEntries?: number }
declare const recordingAttemptBudgetTokenBrand: unique symbol;
export interface RecordingAttemptBudgetToken { readonly [recordingAttemptBudgetTokenBrand]: true }
export interface RecordingAttemptBudgetReservation {
  addedBytes: number;
  eventEntries: 0 | 1 | 2 | 3 | 4;
  receiptEntries: 0 | 1;
  emergency: boolean;
  maximumBytes: number;
}
type EventTuple = readonly [string, number, string, string, string, string];
type ReceiptTuple = readonly [string, string, string, string, number, string];
interface CachedPlan { data: string; plan: dto.RecordingPlanVersion }
interface CachedPrefix { planData: string; tuples: readonly EventTuple[]; last: dto.RecordingAttempt; hash: string; bytes: number }
interface CachedReceipts { tuples: readonly ReceiptTuple[]; bytes: number }
interface AuditSnapshot { environment: string; plans: Map<string, CachedPlan>; prefixes: Map<string, CachedPrefix>; receipts?: CachedReceipts; bytes: number; entries: number }
interface AttemptBudgetBaseline { bytes: number; attempts: number; events: number; receipts: number }
interface AttemptBudgetTokenState {
  db: DatabaseSync;
  epoch: object;
  savepoint: string;
  baseline: AttemptBudgetBaseline;
  maximumBytes: number;
  dataVersion: number;
  totalChanges: number;
}
interface AttemptEnvironment {
  dataVersion: number;
  totalChanges: number;
  state: string;
}
interface CertifiedAttemptHead {
  row: readonly [string, string, string, string, string, number, string];
  value: dto.RecordingAttempt;
}
interface CommittedAppendCertificateBase {
  environment: AttemptEnvironment;
  maximumBytes: number;
  baseline: AttemptBudgetBaseline;
  receiptRowid: number;
  receiptCount: number;
}
interface IdleAppendCertificate extends CommittedAppendCertificateBase {
  kind: 'idle';
}
interface ActiveAppendCertificate extends CommittedAppendCertificateBase {
  kind: 'active';
  head: CertifiedAttemptHead;
  planData: string;
  tail: EventTuple;
}
interface TerminalAppendCertificate extends CommittedAppendCertificateBase {
  kind: 'terminal';
  head: CertifiedAttemptHead;
  planData: string;
  tail: EventTuple;
  terminal: EventTuple;
}
type CommittedAppendCertificate = IdleAppendCertificate | ActiveAppendCertificate | TerminalAppendCertificate;
export type RecordingAttemptCertificateAction = 'begin' | 'progress' | 'terminal-event' | 'terminal-stop';
export interface RecordingAttemptAppendCandidate { readonly db: DatabaseSync; readonly epoch: object; readonly certificate: CommittedAppendCertificate }
export interface RecordingAttemptAppendSession {
  readonly token: RecordingAttemptBudgetToken;
  reconcile(): RecordingAttemptBudgetToken | null;
  expectMutationDelta(value: number): void;
  candidate(): RecordingAttemptAppendCandidate | null;
}
export interface RecordingAttemptRecoverySession {
  readonly token: RecordingAttemptBudgetToken;
  candidate(): RecordingAttemptAppendCandidate | null;
}
const MAX_AUDIT_BYTES = 16 * 1024 * 1024, MAX_AUDIT_ENTRIES = 10_000;
function eventTuple(row: Record<string, unknown>): EventTuple {
  if (typeof row.attempt_id !== 'string' || typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision)
    || typeof row.kind !== 'string' || typeof row.data !== 'string' || typeof row.previous_hash !== 'string' || typeof row.event_hash !== 'string') return attemptFail();
  return [row.attempt_id, row.revision, row.kind, row.data, row.previous_hash, row.event_hash];
}
function tupleBytes(tuple: EventTuple): number { return 8 + tuple.reduce<number>((sum, value) => sum + (typeof value === 'string' ? value.length * 2 : 0), 0); }
function receiptTuple(row: Record<string, unknown>): ReceiptTuple {
  if (typeof row.command_id !== 'string' || typeof row.fingerprint !== 'string' || typeof row.request !== 'string'
    || typeof row.attempt_id !== 'string' || typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 1
    || typeof row.result !== 'string') return attemptFail();
  return [row.command_id, row.fingerprint, row.request, row.attempt_id, row.revision, row.result];
}
function receiptTupleBytes(tuple: ReceiptTuple): number { return 8 + tuple.reduce<number>((sum, value) => sum + (typeof value === 'string' ? value.length * 2 : 0), 0); }
function scalar(db: DatabaseSync, sql: string, key: string): number { return Number(db.prepare(sql).get()?.[key]); }
function attemptEnvironment(db: DatabaseSync): AttemptEnvironment | null {
  try {
    if (!db.isTransaction) return null;
    const temporary = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_temp_schema ORDER BY type,name').all();
    if (temporary.length !== 0) return null;
    const databases = db.prepare('PRAGMA database_list').all(), main = databases[0], temp = databases[1];
    if ((databases.length !== 1 && databases.length !== 2) || main?.seq !== 0 || main?.name !== 'main' || typeof main.file !== 'string' || main.file.length === 0
      || databases.length === 2 && (temp?.seq !== 1 || temp?.name !== 'temp' || temp.file !== '')) return null;
    const pragmas = {
      userVersion: scalar(db, 'PRAGMA user_version', 'user_version'),
      schemaVersion: scalar(db, 'PRAGMA schema_version', 'schema_version'),
      tempSchemaVersion: scalar(db, 'PRAGMA temp.schema_version', 'schema_version'),
      foreignKeys: scalar(db, 'PRAGMA foreign_keys', 'foreign_keys'),
      recursiveTriggers: scalar(db, 'PRAGMA recursive_triggers', 'recursive_triggers'),
      trustedSchema: scalar(db, 'PRAGMA trusted_schema', 'trusted_schema'),
      ignoreChecks: scalar(db, 'PRAGMA ignore_check_constraints', 'ignore_check_constraints'),
      writableSchema: scalar(db, 'PRAGMA writable_schema', 'writable_schema'),
      queryOnly: scalar(db, 'PRAGMA query_only', 'query_only'),
      deferredForeignKeys: scalar(db, 'PRAGMA defer_foreign_keys', 'defer_foreign_keys'),
    };
    if (!Number.isSafeInteger(pragmas.userVersion) || !Number.isSafeInteger(pragmas.schemaVersion) || !Number.isSafeInteger(pragmas.tempSchemaVersion)
      || pragmas.foreignKeys !== 1 || pragmas.recursiveTriggers !== 0 || ![0, 1].includes(pragmas.trustedSchema)
      || pragmas.ignoreChecks !== 0 || pragmas.writableSchema !== 0 || pragmas.queryOnly !== 0 || pragmas.deferredForeignKeys !== 0) return null;
    const schema = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
    const dataVersion = scalar(db, 'PRAGMA data_version', 'data_version');
    const totalChanges = scalar(db, 'SELECT total_changes() total_changes', 'total_changes');
    if (!Number.isSafeInteger(dataVersion) || dataVersion < 0 || !Number.isSafeInteger(totalChanges) || totalChanges < 0) return null;
    return { dataVersion, totalChanges, state: mediaFingerprint({ databases, pragmas, schema, temporary }) };
  } catch { return null; }
}
function attemptHead(row: Record<string, unknown>): CertifiedAttemptHead {
  if (typeof row.id !== 'string' || typeof row.plan_id !== 'string' || typeof row.draft_id !== 'string' || typeof row.physical_id !== 'string'
    || typeof row.status !== 'string' || typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || typeof row.data !== 'string') return attemptFail();
  return { row: [row.id, row.plan_id, row.draft_id, row.physical_id, row.status, row.revision, row.data], value: parseAttempt(row.data) };
}
function sameTuple(actual: readonly unknown[], expected: readonly unknown[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}
function prefixUnchanged(statement: (sql: string) => ReturnType<DatabaseSync['prepare']>, id: string, prefix: CachedPrefix): boolean {
  let index = 0;
  for (const row of statement('SELECT * FROM recording_attempt_events WHERE attempt_id=? ORDER BY revision').iterate(id)) {
    if (index === prefix.tuples.length) break;
    const actual = eventTuple(row), expected = prefix.tuples[index++]!;
    if (actual.some((value, field) => value !== expected[field])) return false;
  }
  return index === prefix.tuples.length;
}
class AttemptAuditRun {
  readonly next: AuditSnapshot = { environment: '', plans: new Map(), prefixes: new Map(), bytes: 0, entries: 0 };
  readonly #statements = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  #previous: AuditSnapshot | undefined;
  constructor(previous: AuditSnapshot | undefined, private readonly maxBytes: number, private readonly maxEntries: number) { this.#previous = previous; }
  bindEnvironment(environment: string): void {
    this.next.environment = environment;
    if (this.#previous?.environment !== environment) this.#previous = undefined;
  }
  get previous(): AuditSnapshot | undefined { return this.#previous; }
  fits(bytes: number, entries: number): boolean { return this.next.bytes + bytes <= this.maxBytes && this.next.entries + entries <= this.maxEntries; }
  statement(db: DatabaseSync, sql: string): ReturnType<DatabaseSync['prepare']> {
    const known = this.#statements.get(sql); if (known) return known;
    const prepared = db.prepare(sql); this.#statements.set(sql, prepared); return prepared;
  }
  plan(db: DatabaseSync, id: string): CachedPlan {
    // 每个唯一Plan在本事务至少读取一次原data；同事务重复关系复用同一fresh值，不跨txn。
    const current = this.next.plans.get(id); if (current) return current;
    const row = this.statement(db, 'SELECT data FROM recording_plan_versions WHERE id=?').get(id);
    if (!row || typeof row.data !== 'string') return attemptFail('PLAN_UNAVAILABLE');
    const data = row.data, known = this.next.plans.get(id) ?? this.previous?.plans.get(id);
    const value = known?.data === data ? known : { data, plan: parseRecordingPlan(data) };
    const bytes = data.length * 4;
    if (!this.next.plans.has(id) && this.fits(bytes, 1)) { this.next.plans.set(id, value); this.next.bytes += bytes; this.next.entries++; }
    return value;
  }
  keep(id: string, prefix: CachedPrefix): void {
    if (this.fits(prefix.bytes, prefix.tuples.length + 1)) {
      this.next.prefixes.set(id, prefix); this.next.bytes += prefix.bytes; this.next.entries += prefix.tuples.length + 1;
    }
  }
  receiptPrefix(tuples: readonly ReceiptTuple[], bytes: number): number {
    const known = this.#previous?.receipts;
    if (!known || known.tuples.length > tuples.length || !this.fits(bytes, tuples.length)) return 0;
    for (let row = 0; row < known.tuples.length; ++row) {
      const actual = tuples[row]!, expected = known.tuples[row]!;
      if (actual.some((value, field) => value !== expected[field])) return 0;
    }
    return known.tuples.length;
  }
  keepReceipts(tuples: readonly ReceiptTuple[], bytes: number): void {
    if (!this.fits(bytes, tuples.length)) return;
    this.next.receipts = { tuples, bytes }; this.next.bytes += bytes; this.next.entries += tuples.length;
  }
}

/** 只用于热事务：实例绑定、原字符串及条目双预算；缓存没有权力确认尚未读取的append。 */
export function createRecordingAttemptAudit({ maxBytes = MAX_AUDIT_BYTES, maxEntries = MAX_AUDIT_ENTRIES }: RecordingAttemptAuditOptions = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_AUDIT_BYTES || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_AUDIT_ENTRIES) return attemptFail('INVALID_REQUEST');
  const snapshots = new WeakMap<DatabaseSync, AuditSnapshot>();
  const appendCertificates = new WeakMap<DatabaseSync, CommittedAppendCertificate>();
  const pendingAppendEpochs = new WeakMap<DatabaseSync, object>();
  const epochs = new WeakMap<DatabaseSync, object>();
  const tokens = new WeakMap<RecordingAttemptBudgetToken, AttemptBudgetTokenState>();
  const activeSavepoints = new WeakMap<DatabaseSync, string>();
  let savepointSequence = 0;
  function releaseActiveSavepoint(db: DatabaseSync): void {
    const savepoint = activeSavepoints.get(db); activeSavepoints.delete(db);
    if (!savepoint || !db.isTransaction) return;
    try { db.exec(`RELEASE SAVEPOINT ${savepoint}`); } catch { /* COMMIT／ROLLBACK已销毁的旧事务标记。 */ }
  }
  function issueToken(db: DatabaseSync, baseline: AttemptBudgetBaseline, maximumBytes: number, epoch: object): RecordingAttemptBudgetToken {
    const token = Object.freeze({}) as RecordingAttemptBudgetToken;
    if (!db.isTransaction) return token;
    const savepoint = `recording_attempt_budget_${++savepointSequence}`;
    try {
      db.exec(`SAVEPOINT ${savepoint}`); activeSavepoints.set(db, savepoint);
      const dataVersion = scalar(db, 'PRAGMA data_version', 'data_version');
      const totalChanges = scalar(db, 'SELECT total_changes() total_changes', 'total_changes');
      if (Number.isSafeInteger(dataVersion) && dataVersion >= 0 && Number.isSafeInteger(totalChanges) && totalChanges >= 0) {
        tokens.set(token, { db, epoch, savepoint, baseline, maximumBytes, dataVersion, totalChanges });
      } else releaseActiveSavepoint(db);
    } catch { releaseActiveSavepoint(db); }
    return token;
  }
  function fullVerify(db: DatabaseSync, maximumBytes: number): { token: RecordingAttemptBudgetToken; baseline: AttemptBudgetBaseline } {
    releaseActiveSavepoint(db);
    const epoch = Object.freeze({}); epochs.set(db, epoch);
    const run = new AttemptAuditRun(snapshots.get(db), maxBytes, maxEntries);
    try {
      const baseline = verifyAttemptDatabase(db, run); snapshots.set(db, run.next);
      return { token: issueToken(db, baseline, maximumBytes, epoch), baseline };
    } catch (error) { snapshots.delete(db); epochs.delete(db); appendCertificates.delete(db); throw error; }
  }
  function captureBaseline(db: DatabaseSync, baseline: AttemptBudgetBaseline, maximumBytes: number): CommittedAppendCertificate | null {
    try {
      const environment = attemptEnvironment(db);
      const rows = db.prepare("SELECT * FROM recording_attempts WHERE status='in-progress' ORDER BY id").all();
      if (!environment || rows.length > 1) return null;
      const receipt = db.prepare('SELECT count(*) n,COALESCE(max(rowid),0) rowid FROM recording_attempt_receipts').get();
      if (!receipt) return null;
      const receiptRowid = Number(receipt.rowid), receiptCount = Number(receipt.n);
      if (!Number.isSafeInteger(receiptRowid) || receiptRowid < 0 || !Number.isSafeInteger(receiptCount) || receiptCount < 0) return null;
      if (rows.length === 0) return { kind: 'idle', environment, maximumBytes, baseline, receiptRowid, receiptCount };
      const head = attemptHead(rows[0]!);
      if (head.value.status !== 'in-progress' || head.value.revision !== head.row[5]) return null;
      const planRow = db.prepare('SELECT data FROM recording_plan_versions WHERE id=?').get(head.value.planVersionId);
      const tailRow = db.prepare('SELECT * FROM recording_attempt_events WHERE attempt_id=? ORDER BY revision DESC LIMIT 1').get(head.value.id);
      if (!planRow || typeof planRow.data !== 'string' || !tailRow) return null;
      const tail = eventTuple(tailRow);
      if (tail[0] !== head.value.id || tail[1] !== head.value.revision) return null;
      return { kind: 'active', environment, maximumBytes, baseline, head, planData: planRow.data, tail, receiptRowid, receiptCount };
    } catch { return null; }
  }
  function certificateFits(certificate: CommittedAppendCertificate): boolean {
    const retainedBytes = certificate.kind === 'idle' ? 512
      : certificate.head.row[6].length * 2 + certificate.planData.length * 2 + tupleBytes(certificate.tail)
        + (certificate.kind === 'terminal' ? tupleBytes(certificate.terminal) : 0) + 512;
    return maxEntries >= (certificate.kind === 'idle' ? 1 : certificate.kind === 'terminal' ? 4 : 3) && retainedBytes <= maxBytes;
  }
  function validateReceipt(row: Record<string, unknown>, expected: dto.RecordingAttempt, plan: dto.RecordingPlanVersion,
    states: ReadonlyMap<number, dto.RecordingAttempt | undefined>): ReceiptTuple {
    const tuple = receiptTuple(row), stored = JSON.parse(tuple[2]) as AttemptReceiptData, result = parseAttempt(tuple[5]);
    if (!exactKeys(stored, ['action', 'request', 'event', 'baseRevision']) || !validAttemptRequest(stored.action, stored.request)
      || !validStoredAttemptEvent(stored.event) || !requestMatchesAttemptEvent(stored.action, stored.request, stored.event)
      || stored.request.commandId !== tuple[0] || tuple[1] !== mediaFingerprint({ action: stored.action, request: stored.request })
      || result.id !== tuple[3] || result.revision !== tuple[4] || mediaFingerprint(result) !== mediaFingerprint(expected)
      || !Number.isSafeInteger(stored.baseRevision) || stored.baseRevision < 0 || !states.has(stored.baseRevision)) return attemptFail();
    if (stored.action === 'begin') {
      const request = stored.request as dto.BeginRecordingAttemptRequest;
      if (stored.baseRevision !== 0 || request.planVersionId !== result.planVersionId || request.planContentHash !== result.planContentHash) return attemptFail();
    } else {
      const request = stored.request as Exclude<AttemptRequest, dto.BeginRecordingAttemptRequest>;
      if (request.attemptId !== result.id || 'expectedRevision' in request && request.expectedRevision !== stored.baseRevision) return attemptFail();
    }
    if (mediaFingerprint(replayAttemptEvent(result.id, plan, states.get(stored.baseRevision), stored.event)) !== mediaFingerprint(result)) return attemptFail();
    return tuple;
  }
  function validateIdleCandidate(db: DatabaseSync, prior: IdleAppendCertificate, epoch: object,
    action: 'baseline' | 'begin', expectedMutationDelta?: number): RecordingAttemptAppendCandidate {
    releaseActiveSavepoint(db);
    const environment = attemptEnvironment(db);
    if (!environment || environment.dataVersion !== prior.environment.dataVersion || environment.state !== prior.environment.state) return attemptFail();
    if (action === 'baseline') {
      if (environment.totalChanges !== prior.environment.totalChanges || db.prepare("SELECT 1 FROM recording_attempts WHERE status='in-progress'").get()) return attemptFail();
      return { db, epoch, certificate: { ...prior, environment } };
    }
    const rows = db.prepare("SELECT * FROM recording_attempts WHERE status='in-progress' ORDER BY id").all();
    if (rows.length !== 1 || !Number.isSafeInteger(expectedMutationDelta) || ![5, 6].includes(expectedMutationDelta!)
      || environment.totalChanges - prior.environment.totalChanges !== expectedMutationDelta) return attemptFail();
    const head = attemptHead(rows[0]!);
    const planRow = db.prepare('SELECT data FROM recording_plan_versions WHERE id=?').get(head.value.planVersionId);
    if (head.value.status !== 'in-progress' || head.value.revision !== 1 || !planRow || typeof planRow.data !== 'string') return attemptFail();
    const plan = parseRecordingPlan(planRow.data);
    const eventRows = db.prepare('SELECT * FROM recording_attempt_events WHERE attempt_id=? ORDER BY revision LIMIT 2').all(head.value.id);
    const receiptRows = db.prepare('SELECT command_id,fingerprint,request,attempt_id,revision,result FROM recording_attempt_receipts WHERE rowid>? ORDER BY rowid LIMIT 2').all(prior.receiptRowid);
    if (eventRows.length !== 1 || receiptRows.length !== 1) return attemptFail();
    const tail = eventTuple(eventRows[0]!), data = JSON.parse(tail[3]) as AttemptEventData;
    if (tail[0] !== head.value.id || tail[1] !== 1 || tail[2] !== 'begin' || tail[4] !== '' || !exactKeys(data, ['event', 'after'])
      || !validStoredAttemptEvent(data.event) || data.event.type !== 'begin') return attemptFail();
    const after = replayAttemptEvent(head.value.id, plan, undefined, data.event);
    if (!dto.isRecordingAttempt(data.after) || mediaFingerprint(after) !== mediaFingerprint(data.after) || mediaFingerprint(after) !== mediaFingerprint(head.value)
      || tail[5] !== mediaFingerprint({ id: head.value.id, revision: 1, previousHash: '', data })) return attemptFail();
    const states = new Map<number, dto.RecordingAttempt | undefined>([[0, undefined]]);
    const receipt = validateReceipt(receiptRows[0]!, head.value, plan, states);
    if ((JSON.parse(receipt[2]) as AttemptReceiptData).action !== 'begin') return attemptFail();
    const draft = db.prepare('SELECT 1 FROM master_drafts WHERE id=?').get(head.value.draftId);
    const heldCopy = db.prepare('SELECT physical_id,usage FROM physical_copies WHERE physical_id=?').get(head.value.physicalId);
    const reservation = db.prepare('SELECT physical_id FROM media_reservations WHERE plan_id=?').get(plan.layout.planId);
    if (!draft || head.value.planContentHash !== plan.contentHash || head.value.draftId !== plan.draftId || head.value.physicalId !== plan.physicalCopy.physicalId
      || !heldCopy || heldCopy.physical_id !== head.value.physicalId || heldCopy.usage !== 'reserved' || reservation?.physical_id !== head.value.physicalId) return attemptFail();
    const addedBytes = Buffer.byteLength(head.row[6]) + Buffer.byteLength(tail[3]) + Buffer.byteLength(receipt[2]) + Buffer.byteLength(receipt[5]);
    const baseline = { bytes: prior.baseline.bytes + addedBytes, attempts: prior.baseline.attempts + 1,
      events: prior.baseline.events + 1, receipts: prior.baseline.receipts + 1 };
    if (baseline.bytes > prior.maximumBytes - MAX_ATTEMPT_BYTES * 4 || baseline.attempts > MAX_ATTEMPTS
      || baseline.events > MAX_ATTEMPT_EVENTS - 4 || baseline.receipts > MAX_ATTEMPT_RECEIPTS - 1) return attemptFail('BUDGET_EXCEEDED');
    return { db, epoch, certificate: { kind: 'active', environment, maximumBytes: prior.maximumBytes, baseline,
      head, planData: planRow.data, tail, receiptRowid: prior.receiptRowid + 1, receiptCount: prior.receiptCount + 1 } };
  }
  function validateActiveCandidate(db: DatabaseSync, prior: ActiveAppendCertificate, epoch: object,
    action: Exclude<RecordingAttemptCertificateAction, 'begin'>, expectedMutationDelta?: number): RecordingAttemptAppendCandidate | null {
    // no-op progress不会调用reserve；候选负责释放仍存活的预算savepoint，token不得跨COMMIT残留。
    releaseActiveSavepoint(db);
    const headRow = db.prepare('SELECT * FROM recording_attempts WHERE id=?').get(prior.head.value.id);
    const planRow = db.prepare('SELECT data FROM recording_plan_versions WHERE id=?').get(prior.head.value.planVersionId);
    const tailRows = db.prepare('SELECT * FROM recording_attempt_events WHERE attempt_id=? AND revision>? ORDER BY revision LIMIT 5').iterate(prior.head.value.id, prior.head.value.revision);
    const appended = [...tailRows].map(eventTuple);
    const receiptRows = db.prepare('SELECT command_id,fingerprint,request,attempt_id,revision,result FROM recording_attempt_receipts WHERE rowid>? ORDER BY rowid LIMIT 2').all(prior.receiptRowid);
    const attempts = prior.baseline.attempts, events = prior.baseline.events + appended.length;
    const environment = attemptEnvironment(db);
    if (!headRow || !planRow || typeof planRow.data !== 'string' || planRow.data !== prior.planData || !environment
      || environment.dataVersion !== prior.environment.dataVersion || environment.state !== prior.environment.state
      || appended.length > (action === 'terminal-stop' ? 4 : 1) || receiptRows.length > (action === 'terminal-stop' ? 1 : 0)) return attemptFail();
    const head = attemptHead(headRow), plan = parseRecordingPlan(planRow.data);
    let addedBytes = Buffer.byteLength(head.row[6]) - Buffer.byteLength(prior.head.row[6]);
    if (appended.length === 0) {
      if (!sameTuple(head.row, prior.head.row) || environment.totalChanges !== prior.environment.totalChanges) return attemptFail();
    } else {
      let current = prior.head.value, previousHash = prior.tail[5];
      const states = new Map<number, dto.RecordingAttempt | undefined>([[current.revision, current]]);
      for (const tuple of appended) {
        const encoded = tuple[3], data = JSON.parse(encoded) as AttemptEventData;
        if (tuple[0] !== prior.head.value.id || tuple[1] !== current.revision + 1 || tuple[4] !== previousHash || Buffer.byteLength(encoded) > MAX_ATTEMPT_BYTES * 2
          || !exactKeys(data, ['event', 'after']) || !validStoredAttemptEvent(data.event) || data.event.type !== tuple[2]) return attemptFail();
        if (action === 'progress' && data.event.type !== 'progress'
          || action === 'terminal-event' && !['engine-cutoff', 'stop-ack', 'cleanup-quiescent'].includes(data.event.type)
          || action === 'terminal-stop' && !['engine-cutoff', 'stop-ack', 'cleanup-quiescent', 'abort'].includes(data.event.type)) return attemptFail();
        const after = replayAttemptEvent(prior.head.value.id, plan, current, data.event);
        const hash = mediaFingerprint({ id: prior.head.value.id, revision: after.revision, previousHash, data });
        if (tuple[5] !== hash || tuple[1] !== after.revision || !dto.isRecordingAttempt(data.after)
          || mediaFingerprint(after) !== mediaFingerprint(data.after)) return attemptFail();
        current = after; previousHash = hash; states.set(current.revision, current); addedBytes += Buffer.byteLength(encoded);
      }
      if (mediaFingerprint(current) !== mediaFingerprint(head.value) || head.row[0] !== current.id || head.row[1] !== current.planVersionId
        || head.row[2] !== current.draftId || head.row[3] !== current.physicalId || head.row[4] !== current.status || head.row[5] !== current.revision) return attemptFail();
      if (action === 'terminal-stop') {
        if (appended.length < 1 || receiptRows.length !== 1) return attemptFail();
        const stopEvents = appended.map(tuple => (JSON.parse(tuple[3]) as AttemptEventData).event), cleanup = stopEvents.slice(0, -1);
        const lastEvent = stopEvents.at(-1)!;
        if (cleanup.some(event => !['engine-cutoff', 'stop-ack', 'cleanup-quiescent'].includes(event.type))
          || new Set(cleanup.map(event => event.type)).size !== cleanup.length
          || lastEvent.type !== 'abort' || lastEvent.reason !== 'user-stop' || head.value.status !== 'aborted') return attemptFail();
        const receipt = validateReceipt(receiptRows[0]!, head.value, plan, states);
        if ((JSON.parse(receipt[2]) as AttemptReceiptData).action !== 'stop') return attemptFail();
        addedBytes += Buffer.byteLength(receipt[2]) + Buffer.byteLength(receipt[5]);
      } else if (receiptRows.length !== 0 || head.value.status !== 'in-progress') return attemptFail();
    }
    const exactDelta = action === 'terminal-stop' ? appended.length * 2 + receiptRows.length : appended.length * 2;
    if (environment.totalChanges - prior.environment.totalChanges !== exactDelta
      || expectedMutationDelta !== undefined && expectedMutationDelta !== exactDelta) return attemptFail();
    let nextReceiptRowid = prior.receiptRowid, nextReceiptCount = prior.receiptCount;
    if (action === 'terminal-stop') {
      const receiptState = db.prepare('SELECT count(*) n,COALESCE(max(rowid),0) rowid FROM recording_attempt_receipts').get();
      nextReceiptRowid = Number(receiptState?.rowid); nextReceiptCount = Number(receiptState?.n);
      if (nextReceiptRowid !== prior.receiptRowid + 1 || nextReceiptCount !== prior.receiptCount + 1) return attemptFail();
    }
    const nextBytes = prior.baseline.bytes + addedBytes;
    if (!Number.isSafeInteger(nextBytes) || nextBytes < 0 || nextBytes > prior.maximumBytes - MAX_ATTEMPT_BYTES * 4
      || events > MAX_ATTEMPT_EVENTS - 4 || nextReceiptCount > MAX_ATTEMPT_RECEIPTS - 1) return attemptFail('BUDGET_EXCEEDED');
    // 旧关系已由完整审计锚定；热路径只核本次两条已知写涉及的点关系，避免再次扫描全部事件／回执。
    const draft = db.prepare('SELECT 1 FROM master_drafts WHERE id=?').get(head.value.draftId);
    const heldCopy = db.prepare('SELECT physical_id,usage FROM physical_copies WHERE physical_id=?').get(head.value.physicalId);
    const reservation = db.prepare('SELECT physical_id FROM media_reservations WHERE plan_id=?').get(plan.layout.planId);
    if (!draft || !heldCopy || heldCopy.physical_id !== head.value.physicalId || heldCopy.usage !== 'reserved'
      || reservation?.physical_id !== head.value.physicalId) return attemptFail();
    if (action === 'terminal-stop') {
      const terminal = appended.at(-1)!;
      const certificate: TerminalAppendCertificate = {
        kind: 'terminal', environment, maximumBytes: prior.maximumBytes,
        baseline: { bytes: nextBytes, attempts, events, receipts: nextReceiptCount },
        head, planData: planRow.data, tail: terminal, terminal,
        receiptRowid: nextReceiptRowid, receiptCount: nextReceiptCount,
      };
      return { db, epoch, certificate };
    }
    const certificate: ActiveAppendCertificate = {
      kind: 'active', environment, maximumBytes: prior.maximumBytes,
      baseline: { bytes: nextBytes, attempts, events, receipts: prior.receiptCount },
      head, planData: planRow.data, tail: appended[0] ?? prior.tail,
      receiptRowid: prior.receiptRowid, receiptCount: prior.receiptCount,
    };
    return { db, epoch, certificate };
  }
  function validateTerminalCandidate(db: DatabaseSync, prior: TerminalAppendCertificate, epoch: object,
    expectedMutationDelta?: number): RecordingAttemptAppendCandidate {
    releaseActiveSavepoint(db);
    const terminalData = JSON.parse(prior.terminal[3]) as AttemptEventData;
    if (prior.head.value.status !== 'aborted' || prior.head.value.reason !== 'user-stop'
      || prior.terminal[0] !== prior.head.value.id || prior.terminal[2] !== 'abort'
      || !exactKeys(terminalData, ['event', 'after']) || !validStoredAttemptEvent(terminalData.event)
      || terminalData.event.type !== 'abort' || terminalData.event.reason !== 'user-stop') return attemptFail();
    const headRow = db.prepare('SELECT * FROM recording_attempts WHERE id=?').get(prior.head.value.id);
    const planRow = db.prepare('SELECT data FROM recording_plan_versions WHERE id=?').get(prior.head.value.planVersionId);
    const appended = [...db.prepare('SELECT * FROM recording_attempt_events WHERE attempt_id=? AND revision>? ORDER BY revision LIMIT 2')
      .iterate(prior.head.value.id, prior.head.value.revision)].map(eventTuple);
    const receiptRows = db.prepare('SELECT rowid FROM recording_attempt_receipts WHERE rowid>? ORDER BY rowid LIMIT 1').all(prior.receiptRowid);
    const environment = attemptEnvironment(db);
    if (!headRow || !planRow || typeof planRow.data !== 'string' || planRow.data !== prior.planData || !environment
      || environment.dataVersion !== prior.environment.dataVersion || environment.state !== prior.environment.state
      || appended.length > 1 || receiptRows.length !== 0) return attemptFail();
    const head = attemptHead(headRow), plan = parseRecordingPlan(planRow.data);
    let addedBytes = Buffer.byteLength(head.row[6]) - Buffer.byteLength(prior.head.row[6]);
    if (appended.length === 0) {
      if (!sameTuple(head.row, prior.head.row)) return attemptFail();
    } else {
      const tuple = appended[0]!, data = JSON.parse(tuple[3]) as AttemptEventData;
      if (tuple[0] !== prior.head.value.id || tuple[1] !== prior.head.value.revision + 1 || tuple[4] !== prior.tail[5]
        || Buffer.byteLength(tuple[3]) > MAX_ATTEMPT_BYTES * 2 || !exactKeys(data, ['event', 'after'])
        || !validStoredAttemptEvent(data.event) || data.event.type !== tuple[2]
        || !['engine-cutoff', 'stop-ack', 'cleanup-quiescent'].includes(data.event.type)) return attemptFail();
      const after = replayAttemptEvent(prior.head.value.id, plan, prior.head.value, data.event);
      const hash = mediaFingerprint({ id: prior.head.value.id, revision: after.revision, previousHash: prior.tail[5], data });
      if (tuple[5] !== hash || tuple[1] !== after.revision || !dto.isRecordingAttempt(data.after)
        || mediaFingerprint(after) !== mediaFingerprint(data.after) || mediaFingerprint(after) !== mediaFingerprint(head.value)
        || head.row[0] !== after.id || head.row[1] !== after.planVersionId || head.row[2] !== after.draftId
        || head.row[3] !== after.physicalId || head.row[4] !== after.status || head.row[5] !== after.revision
        || after.status !== 'aborted' || after.reason !== 'user-stop') return attemptFail();
      addedBytes += Buffer.byteLength(tuple[3]);
    }
    const exactDelta = appended.length * 2;
    if (environment.totalChanges - prior.environment.totalChanges !== exactDelta
      || expectedMutationDelta !== undefined && expectedMutationDelta !== exactDelta) return attemptFail();
    const nextBytes = prior.baseline.bytes + addedBytes, events = prior.baseline.events + appended.length;
    if (!Number.isSafeInteger(nextBytes) || nextBytes < 0 || nextBytes > prior.maximumBytes - MAX_ATTEMPT_BYTES * 4
      || events > MAX_ATTEMPT_EVENTS - 4 || prior.receiptCount > MAX_ATTEMPT_RECEIPTS - 1) return attemptFail('BUDGET_EXCEEDED');
    const draft = db.prepare('SELECT 1 FROM master_drafts WHERE id=?').get(head.value.draftId);
    const heldCopy = db.prepare('SELECT physical_id,usage FROM physical_copies WHERE physical_id=?').get(head.value.physicalId);
    const reservation = db.prepare('SELECT physical_id FROM media_reservations WHERE plan_id=?').get(plan.layout.planId);
    if (!draft || !heldCopy || heldCopy.physical_id !== head.value.physicalId || heldCopy.usage !== 'reserved'
      || reservation?.physical_id !== head.value.physicalId) return attemptFail();
    const certificate: TerminalAppendCertificate = {
      ...prior, environment, baseline: { ...prior.baseline, bytes: nextBytes, events }, head,
      tail: appended[0] ?? prior.tail,
    };
    return { db, epoch, certificate };
  }
  return {
    verify(db: DatabaseSync, maximumBytes = MAX_ATTEMPT_DATABASE_BYTES): RecordingAttemptBudgetToken {
      if (!Number.isSafeInteger(maximumBytes) || maximumBytes < MAX_ATTEMPT_BYTES * 5 || maximumBytes > MAX_ATTEMPT_DATABASE_BYTES) return attemptFail('INVALID_REQUEST');
      appendCertificates.delete(db);
      return fullVerify(db, maximumBytes).token;
    },
    beginRecovery(db: DatabaseSync, maximumBytes = MAX_ATTEMPT_DATABASE_BYTES): RecordingAttemptRecoverySession {
      if (!Number.isSafeInteger(maximumBytes) || maximumBytes < MAX_ATTEMPT_BYTES * 5 || maximumBytes > MAX_ATTEMPT_DATABASE_BYTES) return attemptFail('INVALID_REQUEST');
      releaseActiveSavepoint(db); appendCertificates.delete(db);
      const appendEpoch = Object.freeze({}); pendingAppendEpochs.set(db, appendEpoch);
      const verified = fullVerify(db, maximumBytes), prior = captureBaseline(db, verified.baseline, maximumBytes);
      let candidateIssued = false;
      return {
        token: verified.token,
        candidate: () => {
          if (candidateIssued) return attemptFail(); candidateIssued = true;
          return prior?.kind === 'idle' ? validateIdleCandidate(db, prior, appendEpoch, 'baseline') : null;
        },
      };
    },
    beginAppend(db: DatabaseSync, eligible: boolean, maximumBytes = MAX_ATTEMPT_DATABASE_BYTES,
      action: RecordingAttemptCertificateAction = 'progress'): RecordingAttemptAppendSession {
      if (!Number.isSafeInteger(maximumBytes) || maximumBytes < MAX_ATTEMPT_BYTES * 5 || maximumBytes > MAX_ATTEMPT_DATABASE_BYTES) return attemptFail('INVALID_REQUEST');
      releaseActiveSavepoint(db);
      const appendEpoch = Object.freeze({}); pendingAppendEpochs.set(db, appendEpoch);
      let prior = eligible ? appendCertificates.get(db) : undefined;
      if (!eligible) appendCertificates.delete(db);
      if (prior?.kind === 'terminal' && action !== 'terminal-event') { appendCertificates.delete(db); prior = undefined; }
      const current = prior ? attemptEnvironment(db) : null;
      if (!prior || !current || prior.maximumBytes !== maximumBytes || current.dataVersion !== prior.environment.dataVersion
        || current.totalChanges !== prior.environment.totalChanges || current.state !== prior.environment.state) {
        appendCertificates.delete(db);
        const verified = fullVerify(db, maximumBytes);
        prior = eligible ? captureBaseline(db, verified.baseline, maximumBytes) ?? undefined : undefined;
        let reconciled = false, candidateIssued = false, expectedMutationDelta: number | undefined, invalidExpectation = false;
        return {
          token: verified.token,
          reconcile: () => {
            if (!eligible || reconciled) return null; reconciled = true;
            const fresh = fullVerify(db, maximumBytes);
            prior = captureBaseline(db, fresh.baseline, maximumBytes) ?? undefined;
            return fresh.token;
          },
          expectMutationDelta: value => {
            if (!Number.isSafeInteger(value) || value < 0 || expectedMutationDelta !== undefined) invalidExpectation = true;
            else expectedMutationDelta = value;
          },
          candidate: () => {
            if (candidateIssued) return attemptFail(); candidateIssued = true;
            if (invalidExpectation || !prior) return null;
            if (prior.kind === 'idle') return action === 'begin' ? validateIdleCandidate(db, prior, appendEpoch, action, expectedMutationDelta) : null;
            if (prior.kind === 'terminal') return action === 'terminal-event' ? validateTerminalCandidate(db, prior, appendEpoch, expectedMutationDelta) : null;
            return action === 'begin' ? null : validateActiveCandidate(db, prior, appendEpoch, action, expectedMutationDelta);
          },
        };
      }
      const epoch = Object.freeze({}); epochs.set(db, epoch);
      const token = issueToken(db, prior.baseline, maximumBytes, epoch);
      let reconciled = false, candidateIssued = false, expectedMutationDelta: number | undefined, invalidExpectation = false;
      return {
        token,
        reconcile: () => {
          if (reconciled) return null; reconciled = true;
          appendCertificates.delete(db);
          const fresh = fullVerify(db, maximumBytes);
          prior = captureBaseline(db, fresh.baseline, maximumBytes) ?? undefined;
          return fresh.token;
        },
        expectMutationDelta: value => {
          if (!Number.isSafeInteger(value) || value < 0 || expectedMutationDelta !== undefined) invalidExpectation = true;
          else expectedMutationDelta = value;
        },
        candidate: () => {
          if (candidateIssued) return attemptFail(); candidateIssued = true;
          if (invalidExpectation) return null;
          const currentPrior = prior;
          if (!currentPrior) return null;
          if (currentPrior.kind === 'idle') return action === 'begin' ? validateIdleCandidate(db, currentPrior, appendEpoch, action, expectedMutationDelta) : null;
          if (currentPrior.kind === 'terminal') return action === 'terminal-event' ? validateTerminalCandidate(db, currentPrior, appendEpoch, expectedMutationDelta) : null;
          return action === 'begin' ? null : validateActiveCandidate(db, currentPrior, appendEpoch, action, expectedMutationDelta);
        },
      };
    },
    reserve(db: DatabaseSync, token: RecordingAttemptBudgetToken, reservation: RecordingAttemptBudgetReservation): boolean {
      const state = tokens.get(token); tokens.delete(token);
      if (!state || state.db !== db || epochs.get(db) !== state.epoch || activeSavepoints.get(db) !== state.savepoint || !db.isTransaction) return false;
      try {
        activeSavepoints.delete(db); db.exec(`RELEASE SAVEPOINT ${state.savepoint}`);
        const dataVersion = Number(db.prepare('PRAGMA data_version').get()?.data_version);
        const totalChanges = Number(db.prepare('SELECT total_changes() total_changes').get()?.total_changes);
        if (dataVersion !== state.dataVersion || totalChanges !== state.totalChanges) return false;
        const { addedBytes, eventEntries, receiptEntries, emergency, maximumBytes } = reservation;
        if (!Number.isSafeInteger(addedBytes) || addedBytes < 0 || !Number.isSafeInteger(maximumBytes)
          || maximumBytes < MAX_ATTEMPT_BYTES * 5 || maximumBytes > MAX_ATTEMPT_DATABASE_BYTES || maximumBytes !== state.maximumBytes
          || ![0, 1, 2, 3, 4].includes(eventEntries) || (receiptEntries !== 0 && receiptEntries !== 1) || typeof emergency !== 'boolean') return false;
        if (state.baseline.bytes + addedBytes > maximumBytes - (emergency ? 0 : MAX_ATTEMPT_BYTES * 4)
          || state.baseline.events + eventEntries > MAX_ATTEMPT_EVENTS - (emergency ? 0 : 4)
          || state.baseline.receipts + receiptEntries > MAX_ATTEMPT_RECEIPTS - (emergency ? 0 : 1)) return attemptFail('BUDGET_EXCEEDED');
        return true;
      } catch (error) {
        if (error instanceof AttemptError) throw error;
        return false;
      }
    },
    publish(db: DatabaseSync, candidate: RecordingAttemptAppendCandidate | null): void {
      const epoch = pendingAppendEpochs.get(db); pendingAppendEpochs.delete(db);
      if (!candidate || candidate.db !== db || candidate.epoch !== epoch || db.isTransaction || !certificateFits(candidate.certificate)) appendCertificates.delete(db);
      else appendCertificates.set(db, candidate.certificate);
    },
    clear(db: DatabaseSync): void { releaseActiveSavepoint(db); snapshots.delete(db); appendCertificates.delete(db); pendingAppendEpochs.delete(db); epochs.delete(db); },
  };
}

/** 纯只读：验证schema、预算、每条事件可重演、当前头及命令回执的同版本守恒。 */
export function verifyRecordingAttemptDatabase(db: DatabaseSync): void {
  verifyAttemptDatabase(db);
}
function verifyAttemptDatabase(db: DatabaseSync, audit?: AttemptAuditRun): AttemptBudgetBaseline {
  try {
    const statement = (sql: string) => audit?.statement(db, sql) ?? db.prepare(sql);
    const objects = statement("SELECT sql FROM sqlite_schema WHERE name GLOB 'recording_attempt*'").all();
    const version = Number(statement('PRAGMA user_version').get()!.user_version);
    const expectedSchema: readonly string[] = version >= 20 ? recordingAttemptSchema.map(sql => recordingAttempt20Protection.find(replacement => replacement.split(' BEFORE ')[0] === sql.split(' BEFORE ')[0]) ?? sql) : recordingAttemptSchema;
    if (objects.length !== expectedSchema.length || objects.some(row => !expectedSchema.includes(String(row.sql)))) return attemptFail();
    const environment = JSON.stringify([
      version,
      Number(statement('PRAGMA schema_version').get()!.schema_version),
      Number(statement('PRAGMA temp.schema_version').get()!.schema_version),
      Number(statement('PRAGMA foreign_keys').get()!.foreign_keys),
      Number(statement('PRAGMA recursive_triggers').get()!.recursive_triggers),
      Number(statement('PRAGMA ignore_check_constraints').get()!.ignore_check_constraints),
      statement('PRAGMA database_list').all(),
      objects.map(row => String(row.sql)).sort(),
    ]);
    audit?.bindEnvironment(environment);
    let bytes = 0, attempts = 0, events = 0, receipts = 0;
    for (const [table, maximum, columns] of [
      ['recording_attempts', MAX_ATTEMPTS, ['data']], ['recording_attempt_events', MAX_ATTEMPT_EVENTS, ['data']], ['recording_attempt_receipts', MAX_ATTEMPT_RECEIPTS, ['request', 'result']],
    ] as const) {
      const row = statement(`SELECT count(*) n,COALESCE(sum(${columns.map(column => `length(CAST(${column} AS BLOB))`).join('+')}),0) bytes FROM ${table}`).get()!;
      const count = Number(row.n), tableBytes = Number(row.bytes);
      if (!Number.isSafeInteger(count) || count < 0 || count > maximum || !Number.isSafeInteger(tableBytes) || tableBytes < 0) return attemptFail();
      bytes += tableBytes;
      if (table === 'recording_attempts') attempts = count; else if (table === 'recording_attempt_events') events = count; else receipts = count;
    }
    if (bytes > MAX_ATTEMPT_DATABASE_BYTES || statement('PRAGMA foreign_key_check').get()) return attemptFail();
    let active = 0;
    for (const row of statement('SELECT * FROM recording_attempts ORDER BY id').iterate()) {
      const current = parseAttempt(row.data), auditedPlan = audit?.plan(db, String(row.plan_id)), plan = auditedPlan?.plan ?? attemptPlan(db, String(row.plan_id));
      if (current.id !== row.id || current.planVersionId !== row.plan_id || current.draftId !== row.draft_id || current.physicalId !== row.physical_id || current.status !== row.status || current.revision !== row.revision || current.planContentHash !== plan.contentHash || current.draftId !== plan.draftId || current.physicalId !== plan.physicalCopy.physicalId) return attemptFail();
      let previous: dto.RecordingAttempt | undefined, previousHash = '';
      const cached = audit?.previous?.prefixes.get(current.id);
      const matched = cached && cached.planData === auditedPlan?.data && prefixUnchanged(statement, current.id, cached) ? cached : undefined;
      // 只保存一份末状态；旧tuple必须全部相等，差异则从第一条重演，不能信任旧链尾。
      if (matched) { previous = matched.last; previousHash = matched.hash; }
      let retained: EventTuple[] | undefined = audit ? [...(matched?.tuples ?? [])] : undefined;
      let retainedBytes = matched?.bytes ?? ((auditedPlan?.data.length ?? 0) * 2 + MAX_ATTEMPT_BYTES * 2);
      if (retained && !audit!.fits(retainedBytes, retained.length + 1)) retained = undefined;
      const events = matched
        ? statement('SELECT * FROM recording_attempt_events WHERE attempt_id=? AND revision>? ORDER BY revision').iterate(current.id, matched.last.revision)
        : statement('SELECT * FROM recording_attempt_events WHERE attempt_id=? ORDER BY revision').iterate(current.id);
      for (const eventRow of events) {
        if (Buffer.byteLength(String(eventRow.data)) > MAX_ATTEMPT_BYTES * 2) return attemptFail();
        const data = JSON.parse(String(eventRow.data)) as AttemptEventData;
        if (!exactKeys(data, ['event', 'after']) || !validStoredAttemptEvent(data.event) || data.event.type !== eventRow.kind || eventRow.revision !== (previous?.revision ?? 0) + 1 || eventRow.previous_hash !== previousHash) return attemptFail();
        const after = replayAttemptEvent(current.id, plan, previous, data.event);
        if (!dto.isRecordingAttempt(data.after) || mediaFingerprint(after) !== mediaFingerprint(data.after) || after.revision !== eventRow.revision) return attemptFail();
        const hash = mediaFingerprint({ id: current.id, revision: after.revision, previousHash, data });
        if (hash !== eventRow.event_hash) return attemptFail(); previousHash = hash; previous = after;
        if (retained) {
          const tuple = eventTuple(eventRow); retainedBytes += tupleBytes(tuple);
          if (audit!.fits(retainedBytes, retained.length + 2)) retained.push(tuple); else retained = undefined;
        }
      }
      if (!previous || mediaFingerprint(previous) !== mediaFingerprint(current)) return attemptFail();
      if (retained) audit!.keep(current.id, { planData: auditedPlan!.data, tuples: retained, last: previous, hash: previousHash, bytes: retainedBytes });
      const heldCopy = statement('SELECT usage FROM physical_copies WHERE physical_id=?').get(current.physicalId);
      if (!heldCopy || heldCopy.usage === 'blank' || version < 20 && heldCopy.usage === 'erased') return attemptFail();
      if (version >= 20 && heldCopy.usage === 'erased' && !statement("SELECT 1 FROM recording_record_current WHERE physical_id=? AND json_extract(data,'$.knowledge.state')='erased'").get(current.physicalId)) return attemptFail();
      if (current.status === 'in-progress') {
        if (++active > 1) return attemptFail();
        const reservation = statement('SELECT physical_id FROM media_reservations WHERE plan_id=?').get(plan.layout.planId);
        if (reservation?.physical_id !== current.physicalId || heldCopy.usage !== 'reserved') return attemptFail();
      }
    }
    // 每个事务仍完整读取原始row set；只在旧prefix逐字段完全相同时跳过其JSON/DTO/关系重放。
    const receiptRows = statement('SELECT command_id,fingerprint,request,attempt_id,revision,result FROM recording_attempt_receipts ORDER BY rowid').all();
    const receiptTuples = receiptRows.map(receiptTuple), receiptBytes = receiptTuples.reduce((sum, tuple) => sum + receiptTupleBytes(tuple), 0);
    const receiptPrefix = audit?.receiptPrefix(receiptTuples, receiptBytes) ?? 0;
    for (let index = receiptPrefix; index < receiptRows.length; ++index) {
      const row = receiptRows[index]!;
      const stored = JSON.parse(String(row.request)) as AttemptReceiptData, result = parseAttempt(row.result);
      if (!exactKeys(stored, ['action', 'request', 'event', 'baseRevision']) || !validAttemptRequest(stored.action, stored.request) || !validStoredAttemptEvent(stored.event) || !requestMatchesAttemptEvent(stored.action, stored.request, stored.event)
        || stored.request.commandId !== row.command_id || row.fingerprint !== mediaFingerprint({ action: stored.action, request: stored.request }) || result.id !== row.attempt_id || result.revision !== row.revision || !Number.isSafeInteger(stored.baseRevision) || stored.baseRevision < 0) return attemptFail();
      const selected = statement('SELECT data FROM recording_attempt_events WHERE attempt_id=? AND revision=?').get(result.id, result.revision);
      if (!selected || mediaFingerprint((JSON.parse(String(selected.data)) as AttemptEventData).after) !== mediaFingerprint(result)) return attemptFail();
      const plan = audit?.plan(db, result.planVersionId).plan ?? attemptPlan(db, result.planVersionId);
      const beforeRow = stored.baseRevision ? statement('SELECT data FROM recording_attempt_events WHERE attempt_id=? AND revision=?').get(result.id, stored.baseRevision) : undefined;
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
    audit?.keepReceipts(receiptTuples, receiptBytes);
    if (statement("SELECT 1 FROM recording_attempts a WHERE NOT EXISTS(SELECT 1 FROM recording_attempt_receipts r WHERE r.attempt_id=a.id AND json_extract(r.request,'$.action')='begin') LIMIT 1").get()) return attemptFail();
    return { bytes, attempts, events, receipts };
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
