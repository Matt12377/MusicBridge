import { isCollectionId } from './collection.js';
import { isLocalCatalogRevision, isLocalCatalogText, isLocalExactInteger } from './local-catalog.js';

/** 013 独立整文件位置域；不扩展旧五命令或 012 writer 的资格与预算。 */
export const LOCAL_RELOCATION_PLAN_DOMAIN = 'LOCAL_RELOCATION_V1' as const;
export const LOCAL_RELOCATION_PLAN_BUDGET = Object.freeze({
  operations: 100, closedResources: 256, referenceEdges: 512, sourceAndTargetRoots: 16,
  requestUtf8Bytes: 4_194_304, completePlanBodyContextBytes: 4_194_304,
  snapshotDepth: 32, snapshotNodes: 65_536, allTextBytes: 131_072,
  singleSourceBytes: 17_179_869_184, planFullSourceBytes: 68_719_476_736,
  hashChunkBytes: 1_048_576, concurrentPlans: 1, concurrentFileIo: 1,
  phaseEventsPerResource: 64, phaseEventsPerPlan: 32_768,
  terminalReservedEventsPerResource: 8, terminalReservedEventsPerPlan: 32,
  journalProjectionBytes: 67_108_864, retainedMaterialsBytes: 137_438_953_472,
  runtimeDeadlineMs: 1_800_000,
  overBudget: 'REJECT_FULL_PLAN_WITHOUT_TRUNCATION_OR_PARTIAL_AUTHORIZATION',
  reservation: 'ACTUAL_SOURCE_TARGET_STAGE_RETAINED_MATERIALS_PLUS_TERMINAL_JOURNAL_BEFORE_IO',
  existing012AndReaderBudgetsChanged: false,
} as const);

export const LOCAL_RELOCATION_PLAN_COMMANDS = [
  'localRelocationPlan.chooseTarget', 'localRelocationPlan.preview', 'localRelocationPlan.confirm',
  'localRelocationPlan.cleanup', 'localRelocationPlan.cancel', 'localRelocationPlan.setPolicy',
  'localRelocationPlan.get', 'localRelocationPlan.history',
] as const;
/** 本域 journal 的原命令查询；不接入旧 generic commandOutbox.execute/retry。 */
export const LOCAL_RELOCATION_PLAN_RECEIPT_COMMANDS = [
  'localRelocationPlan.preview', 'localRelocationPlan.confirm', 'localRelocationPlan.cleanup',
  'localRelocationPlan.cancel', 'localRelocationPlan.setPolicy',
] as const;
export const LOCAL_RELOCATION_PLAN_STATES = [
  'PREVIEWING', 'READY', 'BLOCKED', 'DEFERRED', 'QUEUED', 'RUNNING', 'VERIFIED_TARGET',
  'SOURCE_RETAINED', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCEL_REQUESTED', 'CANCELLED', 'RECOVERY_REQUIRED',
] as const;
export const LOCAL_RELOCATION_PLAN_PHASES = [
  'PLANNED', 'RESERVED', 'SOURCE_VERIFIED', 'SOURCE_CAPTURED', 'TARGET_STAGED', 'TARGET_SYNCED',
  'TARGET_INSTALLED', 'VERIFIED_TARGET', 'REGISTERED', 'SOURCE_RETAINED', 'CLEANUP_REQUESTED',
  'SOURCE_REMOVED', 'DIRECTORY_SYNCED', 'TERMINAL', 'UNKNOWN',
] as const;
export const LOCAL_RELOCATION_RESOURCE_ROLES = ['AUDIO', 'CUE', 'LYRIC', 'IMAGE', 'DIRECTORY_SHARED_COVER', 'MANIFEST', 'UNKNOWN_REFERENCE'] as const;
export const LOCAL_RELOCATION_RESOURCE_STATES = ['pending', 'deferred', 'moving', 'verified', 'registered', 'retained', 'cleaned', 'unchanged', 'failed', 'unknown'] as const;
export const LOCAL_RELOCATION_REFERENCE_KINDS = ['CUE_AUDIO', 'LYRIC_AUDIO', 'IMAGE_AUDIO', 'DIRECTORY_COVER', 'MANIFEST', 'OTHER'] as const;
export const LOCAL_RELOCATION_PLAN_ISSUE_CODES = [
  'INVALID_REQUEST', 'NOT_FOUND', 'POLICY_DISABLED', 'DRAINING', 'UNQUALIFIED', 'BUSY', 'LEASE_ACTIVE',
  'PROTECTED', 'FROZEN_REFERENCE', 'PREPARED_REFERENCE', 'ARCHIVE_REFERENCE', 'UNKNOWN_REFERENCE',
  'SHARED_REFERENCE', 'CLOSURE_INCOMPLETE', 'UNSUPPORTED_SOURCE', 'SOURCE_CHANGED', 'TARGET_CHANGED',
  'ROOT_CHANGED', 'ROOT_OFFLINE', 'ROOT_REVOKED', 'ROOT_IDENTITY_UNPROVEN', 'SYMLINK', 'OUT_OF_ROOT',
  'COLLISION', 'SPACE_UNVERIFIED', 'SPACE_INSUFFICIENT', 'OVER_BUDGET', 'STALE_VIEW', 'HASH_MISMATCH',
  'VERIFY_FAILED', 'REVISION_CONFLICT', 'COMMAND_UNKNOWN', 'GRANT_INVALID', 'GRANT_EXPIRED',
  'GRANT_CONSUMED', 'CLEANUP_NOT_VERIFIED', 'CLEANUP_NOT_ALLOWED', 'READER_FAILED', 'IO_FAILED',
  'PERSISTENCE_FAILED', 'CANCELLED', 'RECOVERY_REQUIRED',
] as const;

export type LocalRelocationPlanCommand = typeof LOCAL_RELOCATION_PLAN_COMMANDS[number];
export type LocalRelocationPlanReceiptCommand = typeof LOCAL_RELOCATION_PLAN_RECEIPT_COMMANDS[number];
export type LocalRelocationPlanState = typeof LOCAL_RELOCATION_PLAN_STATES[number];
export type LocalRelocationPlanPhase = typeof LOCAL_RELOCATION_PLAN_PHASES[number];
export type LocalRelocationResourceRole = typeof LOCAL_RELOCATION_RESOURCE_ROLES[number];
export type LocalRelocationResourceState = typeof LOCAL_RELOCATION_RESOURCE_STATES[number];
export type LocalRelocationReferenceKind = typeof LOCAL_RELOCATION_REFERENCE_KINDS[number];
export type LocalRelocationPlanIssueCode = typeof LOCAL_RELOCATION_PLAN_ISSUE_CODES[number];
export type LocalRelocationSourceDisposition = 'RETAIN' | 'REQUEST_CLEANUP';

export interface LocalRelocationPlanSelection {
  assetId: string; expectedFileRevision: string; expectedLocationRevision: string; expectedRootRevision: string;
}
export type LocalRelocationPlanIntent =
  | { kind: 'rename'; target: LocalRelocationPlanSelection; newName: string; sourceDisposition: LocalRelocationSourceDisposition }
  | { kind: 'move'; targets: LocalRelocationPlanSelection[]; targetChoiceId: string; sourceDisposition: LocalRelocationSourceDisposition }
  | { kind: 'locate'; target: LocalRelocationPlanSelection; candidateId: string; targetChoiceId: string; sourceDisposition: 'RETAIN' }
  | { kind: 'root-reassociate'; libraryRootId: string; expectedRootRevision: string; targetChoiceId: string; sourceDisposition: 'RETAIN' }
  | { kind: 'recovery'; originPlanId: string; expectedOriginViewRevision: string; choiceId: string; recoveryFingerprint: string };
export interface LocalRelocationTargetRequest { datasetId: string; commandId: string; kind: 'directory' | 'file' }
export interface LocalRelocationTargetChoice { choiceId: string; kind: 'directory' | 'file'; label: string; expiresAt: string }
export interface LocalRelocationPlanConfirm {
  datasetId: string; commandId: string; planId: string; expectedViewRevision: string;
  domain: typeof LOCAL_RELOCATION_PLAN_DOMAIN; planHash: string; contextFingerprint: string;
}
export interface LocalRelocationPlanCleanup extends LocalRelocationPlanConfirm { verifiedTargetFingerprint: string; sourceResourceIds: string[] }
export interface LocalRelocationPlanPolicy { enabled: boolean; revision: string; draining: boolean }
export const LOCAL_RELOCATION_PLAN_DEFAULT_POLICY: Readonly<LocalRelocationPlanPolicy> = Object.freeze({ enabled: false, revision: '1', draining: false });
export interface LocalRelocationPlanIssue {
  code: LocalRelocationPlanIssueCode; label: string; retry: 'never' | 'repreview' | 'query-original' | 'new-specific-plan';
  operationId: string | null; resourceId: string | null;
}
/** accepted 只证明原命令已被接受，不能被 UI 投影成完成。 */
export interface LocalRelocationPlanReceipt {
  datasetId: string; commandId: string; command: LocalRelocationPlanReceiptCommand; requestFingerprint: string;
  planId: string | null; jobId: string | null; outcome: 'accepted' | 'rejected'; policy: LocalRelocationPlanPolicy | null; issue: LocalRelocationPlanIssue | null;
}
export interface LocalRelocationPlanContext {
  datasetId: string; kind: 'context'; policy: LocalRelocationPlanPolicy;
  qualification: { state: 'unqualified' | 'qualified' | 'blocked'; proofFingerprint: string | null; issue: LocalRelocationPlanIssue | null };
}
export interface LocalRelocationPlanItem {
  operationId: string; assetId: string | null; trackIds: string[]; sourceLabel: string; targetLabel: string;
  expectedFileRevision: string | null; expectedLocationRevision: string | null; expectedRootRevision: string;
  state: LocalRelocationResourceState; phase: LocalRelocationPlanPhase; resourceIds: string[]; issue: LocalRelocationPlanIssue | null;
}
export interface LocalRelocationPlanResource {
  resourceId: string; role: LocalRelocationResourceRole; label: string; operationIds: string[]; bytes: string | null;
  state: LocalRelocationResourceState; phase: LocalRelocationPlanPhase;
  verification: 'unverified' | 'verified-source' | 'verified-target' | 'unknown';
  sourceHandling: 'unchanged' | 'move-pending' | 'retained' | 'cleanup-eligible' | 'removed' | 'unknown';
  contentEffect: 'whole-bytes-preserved' | 'reference-rewritten' | 'none'; issue: LocalRelocationPlanIssue | null;
}
export interface LocalRelocationReferenceEdge { edgeId: string; fromResourceId: string; toResourceId: string; kind: LocalRelocationReferenceKind; shared: boolean }
export interface LocalRelocationPlanCleanupView {
  state: 'unavailable' | 'source-retained' | 'eligible' | 'running' | 'completed' | 'blocked' | 'unknown';
  verifiedTargetFingerprint: string | null; sourceResourceIds: string[]; issue: LocalRelocationPlanIssue | null;
}
export interface LocalRelocationPlanRecoveryChoice {
  choiceId: string; originPlanId: string; expectedOriginViewRevision: string; recoveryFingerprint: string;
  action: 'reconcile' | 'rollback' | 'keep-target'; label: string; resourceIds: string[];
}
export interface LocalRelocationPlan {
  version: 1; domain: typeof LOCAL_RELOCATION_PLAN_DOMAIN; datasetId: string; planId: string; jobId: string;
  viewRevision: string; journalSequence: string; createdAt: string; expiresAt: string; planHash: string; contextFingerprint: string; policyRevision: string;
  intent: LocalRelocationPlanIntent; state: LocalRelocationPlanState; sourceDisposition: LocalRelocationSourceDisposition;
  closure: { complete: boolean; operationCount: number; resourceCount: number; referenceEdgeCount: number; rootCount: number; fingerprint: string; totalSourceBytes: string; spaceVerified: boolean; protection: 'verified' | 'unknown' | 'blocked' };
  items: LocalRelocationPlanItem[]; resources: LocalRelocationPlanResource[]; referenceEdges: LocalRelocationReferenceEdge[];
  issues: LocalRelocationPlanIssue[]; cleanup: LocalRelocationPlanCleanupView; recoveryChoices: LocalRelocationPlanRecoveryChoice[];
}
export type LocalRelocationPlanGetSelector =
  | { kind: 'context' } | { kind: 'plan'; planId: string }
  | { kind: 'command'; commandId: string; expectedCommand: LocalRelocationPlanReceiptCommand; requestFingerprint: string };
export type LocalRelocationPlanGetResult = LocalRelocationPlanContext
  | { datasetId: string; kind: 'plan'; planId: string; plan: LocalRelocationPlan | null; issue: LocalRelocationPlanIssue | null }
  | { datasetId: string; kind: 'command'; commandId: string; expectedCommand: LocalRelocationPlanReceiptCommand; requestFingerprint: string; receipt: LocalRelocationPlanReceipt | null; issue: LocalRelocationPlanIssue | null };
export interface LocalRelocationPlanEvent {
  eventId: string; planId: string; journalSequence: string; operationId: string | null; resourceId: string | null;
  phase: LocalRelocationPlanPhase; occurredAt: string; label: string; issue: LocalRelocationPlanIssue | null;
}
export interface LocalRelocationPlanHistoryItem { planId: string; jobId: string; viewRevision: string; state: LocalRelocationPlanState; createdAt: string; operations: number; issue: LocalRelocationPlanIssue | null }
export type LocalRelocationPlanHistory =
  | { datasetId: string; kind: 'plans'; snapshotFingerprint: string; limit: number; items: LocalRelocationPlanHistoryItem[]; cursor: string | null; hasMore: boolean }
  | { datasetId: string; kind: 'events'; planId: string; snapshotFingerprint: string; limit: number; items: LocalRelocationPlanEvent[]; cursor: string | null; hasMore: boolean };
export interface LocalRelocationPlanCommandPayloads {
  'localRelocationPlan.chooseTarget': LocalRelocationTargetRequest;
  'localRelocationPlan.preview': { datasetId: string; commandId: string; intent: LocalRelocationPlanIntent };
  'localRelocationPlan.confirm': LocalRelocationPlanConfirm;
  'localRelocationPlan.cleanup': LocalRelocationPlanCleanup;
  'localRelocationPlan.cancel': { datasetId: string; commandId: string; planId: string; expectedViewRevision: string };
  'localRelocationPlan.setPolicy': { datasetId: string; commandId: string; expectedPolicyRevision: string; enabled: boolean };
  'localRelocationPlan.get': { datasetId: string; selector: LocalRelocationPlanGetSelector };
  'localRelocationPlan.history': { datasetId: string; selector: { kind: 'plans' } | { kind: 'events'; planId: string }; cursor: string | null; limit: number };
}
export interface LocalRelocationPlanCommandResults {
  'localRelocationPlan.chooseTarget': LocalRelocationTargetChoice | null;
  'localRelocationPlan.preview': LocalRelocationPlanReceipt;
  'localRelocationPlan.confirm': LocalRelocationPlanReceipt;
  'localRelocationPlan.cleanup': LocalRelocationPlanReceipt;
  'localRelocationPlan.cancel': LocalRelocationPlanReceipt;
  'localRelocationPlan.setPolicy': LocalRelocationPlanReceipt;
  'localRelocationPlan.get': LocalRelocationPlanGetResult;
  'localRelocationPlan.history': LocalRelocationPlanHistory;
}
export interface LocalRelocationPlanPublicApi {
  localRelocationPlan<C extends LocalRelocationPlanCommand>(command: C, payload: LocalRelocationPlanCommandPayloads[C]): Promise<LocalRelocationPlanCommandResults[C]>;
}

export interface LocalRelocationDataLimits { maxBytes?: number; maxNodes?: number; maxDepth?: number; maxTextBytes?: number; maxArray?: number; maxKeys?: number }
type Data = Record<string, unknown>;
const encoder = new TextEncoder();
const nonAscii = /[^\u0000-\u007f]/u;
const isolatedSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const invalid = (): never => { throw new Error('位置计划的数据描述符、闭集或预算无效。'); };
export const localRelocationUtf8Bytes = (value: string): number => !nonAscii.test(value) ? value.length : encoder.encode(value).byteLength;
const integer = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= min && value <= max;
const values = <T extends readonly string[]>(value: unknown, allowed: T): value is T[number] => typeof value === 'string' && (allowed as readonly string[]).includes(value);
export const isLocalRelocationPlanDatasetId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
export const isLocalRelocationPlanHash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
export const isLocalRelocationPlanCommand = (value: unknown): value is LocalRelocationPlanCommand => values(value, LOCAL_RELOCATION_PLAN_COMMANDS);
export const isLocalRelocationPlanReceiptCommand = (value: unknown): value is LocalRelocationPlanReceiptCommand => values(value, LOCAL_RELOCATION_PLAN_RECEIPT_COMMANDS);
export const isLocalRelocationPlanDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export const isLocalRelocationPlanLabel = (value: unknown): value is string => isLocalCatalogText(value) && !/(?:^|\s)(?:[\/\\]|~[\/\\]|[a-z]:[\/\\]|file:)/iu.test(value);
export const isLocalRelocationPlanBasename = (value: unknown): value is string => isLocalRelocationPlanLabel(value) && value !== '.' && value !== '..' && !/[\/\\:]/u.test(value);

/** 只检描述符；调用者先捕获，再从被冻结的快照读取值。 */
export function localRelocationRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Data {
  try {
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    const keys = Reflect.ownKeys(value);
    return keys.length === required.length + keys.filter(key => typeof key === 'string' && optional.includes(key)).length
      && required.every(key => keys.includes(key)) && keys.every(key => {
        if (typeof key !== 'string' || !required.includes(key) && !optional.includes(key)) return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value');
      });
  } catch { return false; }
}

/** 独立 G0 捕获：不执行 getter/toJSON/iterator，不改 012 的 depth 或 byte caps。 */
export function localRelocationDataSnapshot(value: unknown, limits: Readonly<LocalRelocationDataLimits> = {}): unknown {
  const maxBytes = limits.maxBytes ?? LOCAL_RELOCATION_PLAN_BUDGET.requestUtf8Bytes;
  const maxNodes = limits.maxNodes ?? LOCAL_RELOCATION_PLAN_BUDGET.snapshotNodes;
  const maxDepth = limits.maxDepth ?? LOCAL_RELOCATION_PLAN_BUDGET.snapshotDepth;
  const maxTextBytes = limits.maxTextBytes ?? LOCAL_RELOCATION_PLAN_BUDGET.allTextBytes;
  const maxArray = limits.maxArray ?? LOCAL_RELOCATION_PLAN_BUDGET.snapshotNodes;
  const maxKeys = limits.maxKeys ?? LOCAL_RELOCATION_PLAN_BUDGET.snapshotNodes;
  if (!integer(maxBytes, 1, LOCAL_RELOCATION_PLAN_BUDGET.requestUtf8Bytes) || !integer(maxNodes, 1, LOCAL_RELOCATION_PLAN_BUDGET.snapshotNodes)
    || !integer(maxDepth, 0, LOCAL_RELOCATION_PLAN_BUDGET.snapshotDepth) || !integer(maxTextBytes, 0, LOCAL_RELOCATION_PLAN_BUDGET.allTextBytes)
    || !integer(maxArray, 0, LOCAL_RELOCATION_PLAN_BUDGET.snapshotNodes) || !integer(maxKeys, 0, LOCAL_RELOCATION_PLAN_BUDGET.snapshotNodes)) return invalid();
  let nodes = 0, bytes = 0, textBytes = 0;
  const active = new Set<object>();
  const addBytes = (count: number): void => { bytes += count; if (bytes > maxBytes) invalid(); };
  const addText = (text: string): void => {
    if (text.length > maxTextBytes || isolatedSurrogate.test(text)) invalid();
    textBytes += localRelocationUtf8Bytes(text); if (textBytes > maxTextBytes) invalid();
  };
  const walk = (input: unknown, depth: number): unknown => {
    if (++nodes > maxNodes || depth > maxDepth) invalid();
    if (input === null || typeof input === 'boolean') { addBytes(input === null ? 4 : input ? 4 : 5); return input; }
    if (typeof input === 'string') { addText(input); addBytes(localRelocationUtf8Bytes(JSON.stringify(input))); return input; }
    if (typeof input === 'number') { if (!Number.isSafeInteger(input) || Object.is(input, -0)) return invalid(); addBytes(String(input).length); return input; }
    if (!input || typeof input !== 'object' || active.has(input)) return invalid();
    active.add(input);
    try {
      if (Array.isArray(input)) {
        if (Object.getPrototypeOf(input) !== Array.prototype) return invalid();
        const descriptor = Object.getOwnPropertyDescriptor(input, 'length');
        const length: unknown = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
        if (!integer(length, 0, maxArray)) return invalid();
        const names = Reflect.ownKeys(input);
        if (names.length !== length + 1 || names.some(name => typeof name !== 'string' || name !== 'length' && !/^(0|[1-9][0-9]*)$/u.test(name))) return invalid();
        addBytes(2 + Math.max(0, length - 1));
        const result: unknown[] = [];
        for (let index = 0; index < length; index++) {
          const item = Object.getOwnPropertyDescriptor(input, String(index));
          if (!item?.enumerable || !Object.hasOwn(item, 'value')) return invalid();
          result.push(walk(item.value, depth + 1));
        }
        return Object.freeze(result);
      }
      if (![Object.prototype, null].includes(Object.getPrototypeOf(input))) return invalid();
      const names = Reflect.ownKeys(input); if (names.length > maxKeys) return invalid();
      addBytes(2 + Math.max(0, names.length - 1));
      const result = Object.create(null) as Data;
      for (const name of names) {
        if (typeof name !== 'string') return invalid();
        addText(name);
        const descriptor = Object.getOwnPropertyDescriptor(input, name);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return invalid();
        addBytes(localRelocationUtf8Bytes(JSON.stringify(name)) + 1);
        Object.defineProperty(result, name, { value: walk(descriptor.value, depth + 1), enumerable: true });
      }
      return Object.freeze(result);
    } finally { active.delete(input); }
  };
  try { return walk(value, 0); } catch { return invalid(); }
}

const codePointCompare = (left: string, right: string): number => {
  let a = 0, b = 0;
  while (a < left.length && b < right.length) {
    const x = left.codePointAt(a)!, y = right.codePointAt(b)!;
    if (x !== y) return x - y;
    a += x > 0xffff ? 2 : 1; b += y > 0xffff ? 2 : 1;
  }
  return a < left.length ? 1 : b < right.length ? -1 : 0;
};
export function localRelocationCanonical(value: unknown, limits: Readonly<LocalRelocationDataLimits> = {}): string {
  const captured = localRelocationDataSnapshot(value, limits);
  const encode = (input: unknown): string => {
    if (input === null || typeof input !== 'object') return JSON.stringify(input);
    if (Array.isArray(input)) return `[${input.map(encode).join(',')}]`;
    return `{${Object.keys(input).sort(codePointCompare).map(key => `${JSON.stringify(key)}:${encode(Object.getOwnPropertyDescriptor(input, key)!.value)}`).join(',')}}`;
  };
  return encode(captured);
}
export function localRelocationRequestFingerprintInput<C extends LocalRelocationPlanCommand>(command: C, payload: unknown): string {
  return `${LOCAL_RELOCATION_PLAN_DOMAIN}\nREQUEST\n${localRelocationCanonical({ command, payload: localRelocationPlanCommandSnapshot(command, payload) })}`;
}
/** FrozenBody 的完整语义由私有 validator 核验；哈希输入始终包含独立域和全部九键。 */
export function localRelocationPlanHashInput(body: unknown): string {
  const captured = localRelocationDataSnapshot(body);
  if (!localRelocationRecord(captured, ['version', 'domain', 'createdAt', 'intent', 'operations', 'rootMappings', 'resourceClosure', 'sourceRetention', 'guards']) || captured.version !== 1 || captured.domain !== LOCAL_RELOCATION_PLAN_DOMAIN) return invalid();
  return `${LOCAL_RELOCATION_PLAN_DOMAIN}\nPLAN\n${localRelocationCanonical(captured)}`;
}
export function localRelocationContextFingerprintInput(context: unknown): string {
  const captured = localRelocationDataSnapshot(context);
  if (!localRelocationRecord(captured, ['version', 'domain', 'datasetId', 'planId', 'viewRevision', 'policyRevision', 'ownerEpoch', 'targetChoiceIds', 'rootObservationFingerprint', 'resourceObservationFingerprint', 'protectionFingerprint', 'reservationFingerprint', 'commandFingerprint']) || captured.version !== 1 || captured.domain !== LOCAL_RELOCATION_PLAN_DOMAIN) return invalid();
  return `${LOCAL_RELOCATION_PLAN_DOMAIN}\nCONTEXT\n${localRelocationCanonical(captured)}`;
}
/** body/context 合计计数；括号、转义、keys、文本和深度均计入，不作截断。 */
export function localRelocationCompletePlanWithinBudget(body: unknown, context: unknown): boolean {
  try { localRelocationDataSnapshot({ body, context }, { maxBytes: LOCAL_RELOCATION_PLAN_BUDGET.completePlanBodyContextBytes }); return true; } catch { return false; }
}

const record = localRelocationRecord;
const array = (value: unknown, maximum: number = LOCAL_RELOCATION_PLAN_BUDGET.snapshotNodes): value is unknown[] => Array.isArray(value) && value.length <= maximum;
const ids = (value: unknown, minimum = 0, maximum: number = LOCAL_RELOCATION_PLAN_BUDGET.snapshotNodes): value is string[] => array(value, maximum) && value.length >= minimum && value.every(isCollectionId) && new Set(value).size === value.length;
const nullableId = (value: unknown): value is string | null => value === null || isCollectionId(value);
const nullableRevision = (value: unknown): value is string | null => value === null || isLocalCatalogRevision(value);
const boundedBytes = (value: unknown, maximum: number, allowZero = true): value is string => isLocalExactInteger(value) && (allowZero || value !== '0') && BigInt(value) <= BigInt(maximum);
const state = (value: unknown): value is LocalRelocationPlanState => values(value, LOCAL_RELOCATION_PLAN_STATES);
const phase = (value: unknown): value is LocalRelocationPlanPhase => values(value, LOCAL_RELOCATION_PLAN_PHASES);
const resourceState = (value: unknown): value is LocalRelocationResourceState => values(value, LOCAL_RELOCATION_RESOURCE_STATES);
const disposition = (value: unknown): value is LocalRelocationSourceDisposition => value === 'RETAIN' || value === 'REQUEST_CLEANUP';
const issue = (value: unknown): boolean => value === null || issueData(value);
function issueData(value: unknown): value is LocalRelocationPlanIssue {
  if (!record(value, ['code', 'label', 'retry', 'operationId', 'resourceId']) || !values(value.code, LOCAL_RELOCATION_PLAN_ISSUE_CODES) || !isLocalRelocationPlanLabel(value.label)
    || !values(value.retry, ['never', 'repreview', 'query-original', 'new-specific-plan'] as const) || !nullableId(value.operationId) || !nullableId(value.resourceId)) return false;
  return value.code !== 'COMMAND_UNKNOWN' || value.retry === 'query-original';
}
export function isLocalRelocationPlanIssue(value: unknown): value is LocalRelocationPlanIssue { try { return issueData(localRelocationDataSnapshot(value)); } catch { return false; } }
function selection(value: unknown): value is LocalRelocationPlanSelection {
  return record(value, ['assetId', 'expectedFileRevision', 'expectedLocationRevision', 'expectedRootRevision']) && isCollectionId(value.assetId)
    && [value.expectedFileRevision, value.expectedLocationRevision, value.expectedRootRevision].every(isLocalCatalogRevision);
}
function intent(value: unknown): value is LocalRelocationPlanIntent {
  if (!value || typeof value !== 'object') return false;
  const data = value as Data;
  switch (data.kind) {
    case 'rename': return record(data, ['kind', 'target', 'newName', 'sourceDisposition']) && selection(data.target) && isLocalRelocationPlanBasename(data.newName) && disposition(data.sourceDisposition);
    case 'move': return record(data, ['kind', 'targets', 'targetChoiceId', 'sourceDisposition']) && array(data.targets, LOCAL_RELOCATION_PLAN_BUDGET.operations) && data.targets.length > 0
      && data.targets.every(selection) && new Set(data.targets.map(target => (target as LocalRelocationPlanSelection).assetId)).size === data.targets.length && isCollectionId(data.targetChoiceId) && disposition(data.sourceDisposition);
    case 'locate': return record(data, ['kind', 'target', 'candidateId', 'targetChoiceId', 'sourceDisposition']) && selection(data.target) && isCollectionId(data.candidateId) && isCollectionId(data.targetChoiceId) && data.sourceDisposition === 'RETAIN';
    case 'root-reassociate': return record(data, ['kind', 'libraryRootId', 'expectedRootRevision', 'targetChoiceId', 'sourceDisposition']) && isCollectionId(data.libraryRootId) && isLocalCatalogRevision(data.expectedRootRevision) && isCollectionId(data.targetChoiceId) && data.sourceDisposition === 'RETAIN';
    case 'recovery': return record(data, ['kind', 'originPlanId', 'expectedOriginViewRevision', 'choiceId', 'recoveryFingerprint']) && isCollectionId(data.originPlanId) && isLocalCatalogRevision(data.expectedOriginViewRevision) && isCollectionId(data.choiceId) && isLocalRelocationPlanHash(data.recoveryFingerprint);
  }
  return false;
}
export function isLocalRelocationPlanIntent(value: unknown): value is LocalRelocationPlanIntent { try { return intent(localRelocationDataSnapshot(value)); } catch { return false; } }
function policy(value: unknown): value is LocalRelocationPlanPolicy {
  return record(value, ['enabled', 'revision', 'draining']) && typeof value.enabled === 'boolean' && isLocalCatalogRevision(value.revision) && typeof value.draining === 'boolean' && (!value.draining || !value.enabled);
}
function targetChoice(value: unknown): value is LocalRelocationTargetChoice {
  return record(value, ['choiceId', 'kind', 'label', 'expiresAt']) && isCollectionId(value.choiceId) && (value.kind === 'directory' || value.kind === 'file') && isLocalRelocationPlanLabel(value.label) && isLocalRelocationPlanDate(value.expiresAt);
}
function confirm(value: Data): boolean {
  return isLocalRelocationPlanDatasetId(value.datasetId) && [value.commandId, value.planId].every(isCollectionId) && isLocalCatalogRevision(value.expectedViewRevision)
    && value.domain === LOCAL_RELOCATION_PLAN_DOMAIN && isLocalRelocationPlanHash(value.planHash) && isLocalRelocationPlanHash(value.contextFingerprint);
}
const confirmKeys = ['datasetId', 'commandId', 'planId', 'expectedViewRevision', 'domain', 'planHash', 'contextFingerprint'] as const;
function payloadData(command: LocalRelocationPlanCommand, value: unknown): boolean {
  if (!value || typeof value !== 'object' || !isLocalRelocationPlanDatasetId((value as Data).datasetId)) return false;
  const data = value as Data;
  switch (command) {
    case 'localRelocationPlan.chooseTarget': return record(data, ['datasetId', 'commandId', 'kind']) && isCollectionId(data.commandId) && (data.kind === 'directory' || data.kind === 'file');
    case 'localRelocationPlan.preview': return record(data, ['datasetId', 'commandId', 'intent']) && isCollectionId(data.commandId) && intent(data.intent);
    case 'localRelocationPlan.confirm': return record(data, confirmKeys) && confirm(data);
    case 'localRelocationPlan.cleanup': return record(data, [...confirmKeys, 'verifiedTargetFingerprint', 'sourceResourceIds']) && confirm(data) && isLocalRelocationPlanHash(data.verifiedTargetFingerprint) && ids(data.sourceResourceIds, 1, LOCAL_RELOCATION_PLAN_BUDGET.closedResources);
    case 'localRelocationPlan.cancel': return record(data, ['datasetId', 'commandId', 'planId', 'expectedViewRevision']) && [data.commandId, data.planId].every(isCollectionId) && isLocalCatalogRevision(data.expectedViewRevision);
    case 'localRelocationPlan.setPolicy': return record(data, ['datasetId', 'commandId', 'expectedPolicyRevision', 'enabled']) && isCollectionId(data.commandId) && isLocalCatalogRevision(data.expectedPolicyRevision) && typeof data.enabled === 'boolean';
    case 'localRelocationPlan.get': {
      if (!record(data, ['datasetId', 'selector']) || !data.selector || typeof data.selector !== 'object') return false;
      const selector = data.selector as Data;
      return record(selector, ['kind']) && selector.kind === 'context'
        || record(selector, ['kind', 'planId']) && selector.kind === 'plan' && isCollectionId(selector.planId)
        || record(selector, ['kind', 'commandId', 'expectedCommand', 'requestFingerprint']) && selector.kind === 'command' && isCollectionId(selector.commandId) && isLocalRelocationPlanReceiptCommand(selector.expectedCommand) && isLocalRelocationPlanHash(selector.requestFingerprint);
    }
    case 'localRelocationPlan.history': {
      if (!record(data, ['datasetId', 'selector', 'cursor', 'limit']) || !integer(data.limit, 1, LOCAL_RELOCATION_PLAN_BUDGET.operations) || !nullableId(data.cursor)) return false;
      const selector = data.selector;
      return record(selector, ['kind']) && selector.kind === 'plans' || record(selector, ['kind', 'planId']) && selector.kind === 'events' && isCollectionId(selector.planId);
    }
  }
  return false;
}
export function localRelocationPlanCommandSnapshot<C extends LocalRelocationPlanCommand>(command: C, input: unknown): LocalRelocationPlanCommandPayloads[C] {
  const value = localRelocationDataSnapshot(input);
  if (!isLocalRelocationPlanCommand(command) || !payloadData(command, value)) return invalid();
  return value as LocalRelocationPlanCommandPayloads[C];
}
export function isLocalRelocationPlanCommandPayload<C extends LocalRelocationPlanCommand>(command: C, input: unknown): input is LocalRelocationPlanCommandPayloads[C] {
  try { localRelocationPlanCommandSnapshot(command, input); return true; } catch { return false; }
}
function receipt(value: unknown): value is LocalRelocationPlanReceipt {
  if (!record(value, ['datasetId', 'commandId', 'command', 'requestFingerprint', 'planId', 'jobId', 'outcome', 'policy', 'issue']) || !isLocalRelocationPlanDatasetId(value.datasetId) || !isCollectionId(value.commandId)
    || !isLocalRelocationPlanReceiptCommand(value.command) || !isLocalRelocationPlanHash(value.requestFingerprint) || !issue(value.issue)) return false;
  if (value.outcome === 'rejected') return value.policy === null && value.issue !== null && (value.planId === null && value.jobId === null || isCollectionId(value.planId) && isCollectionId(value.jobId));
  return value.outcome === 'accepted' && value.issue === null && (value.command === 'localRelocationPlan.setPolicy'
    ? value.planId === null && value.jobId === null && policy(value.policy) : isCollectionId(value.planId) && isCollectionId(value.jobId) && value.policy === null);
}
function item(value: unknown): value is LocalRelocationPlanItem {
  if (!record(value, ['operationId', 'assetId', 'trackIds', 'sourceLabel', 'targetLabel', 'expectedFileRevision', 'expectedLocationRevision', 'expectedRootRevision', 'state', 'phase', 'resourceIds', 'issue']) || !isCollectionId(value.operationId)
    || !nullableId(value.assetId) || !ids(value.trackIds) || !isLocalRelocationPlanLabel(value.sourceLabel) || !isLocalRelocationPlanLabel(value.targetLabel)
    || !nullableRevision(value.expectedFileRevision) || !nullableRevision(value.expectedLocationRevision) || !isLocalCatalogRevision(value.expectedRootRevision)
    || !resourceState(value.state) || !phase(value.phase) || !ids(value.resourceIds, 1, LOCAL_RELOCATION_PLAN_BUDGET.closedResources) || !issue(value.issue)) return false;
  return value.assetId === null ? value.expectedFileRevision === null && value.expectedLocationRevision === null && value.trackIds.length === 0
    : isLocalCatalogRevision(value.expectedFileRevision) && isLocalCatalogRevision(value.expectedLocationRevision) && value.trackIds.length > 0;
}
function resource(value: unknown): value is LocalRelocationPlanResource {
  if (!record(value, ['resourceId', 'role', 'label', 'operationIds', 'bytes', 'state', 'phase', 'verification', 'sourceHandling', 'contentEffect', 'issue']) || !isCollectionId(value.resourceId)
    || !values(value.role, LOCAL_RELOCATION_RESOURCE_ROLES) || !isLocalRelocationPlanLabel(value.label) || !ids(value.operationIds, 1, LOCAL_RELOCATION_PLAN_BUDGET.operations)
    || !(value.bytes === null || boundedBytes(value.bytes, LOCAL_RELOCATION_PLAN_BUDGET.singleSourceBytes)) || !resourceState(value.state) || !phase(value.phase)
    || !values(value.verification, ['unverified', 'verified-source', 'verified-target', 'unknown'] as const)
    || !values(value.sourceHandling, ['unchanged', 'move-pending', 'retained', 'cleanup-eligible', 'removed', 'unknown'] as const)
    || !values(value.contentEffect, ['whole-bytes-preserved', 'reference-rewritten', 'none'] as const) || !issue(value.issue)) return false;
  if (value.role === 'AUDIO' && value.contentEffect !== 'whole-bytes-preserved') return false;
  if (value.contentEffect === 'reference-rewritten' && value.role !== 'CUE' && value.role !== 'MANIFEST') return false;
  if ((value.sourceHandling === 'removed' || value.sourceHandling === 'cleanup-eligible') && value.verification !== 'verified-target') return false;
  if ((value.state === 'registered' || value.state === 'retained' || value.state === 'cleaned') && value.verification !== 'verified-target') return false;
  return value.state !== 'cleaned' || value.sourceHandling === 'removed';
}
function edge(value: unknown): value is LocalRelocationReferenceEdge {
  return record(value, ['edgeId', 'fromResourceId', 'toResourceId', 'kind', 'shared']) && [value.edgeId, value.fromResourceId, value.toResourceId].every(isCollectionId)
    && value.fromResourceId !== value.toResourceId && values(value.kind, LOCAL_RELOCATION_REFERENCE_KINDS) && typeof value.shared === 'boolean';
}
function cleanupView(value: unknown): value is LocalRelocationPlanCleanupView {
  if (!record(value, ['state', 'verifiedTargetFingerprint', 'sourceResourceIds', 'issue']) || !values(value.state, ['unavailable', 'source-retained', 'eligible', 'running', 'completed', 'blocked', 'unknown'] as const)
    || !(value.verifiedTargetFingerprint === null || isLocalRelocationPlanHash(value.verifiedTargetFingerprint)) || !ids(value.sourceResourceIds, 0, LOCAL_RELOCATION_PLAN_BUDGET.closedResources) || !issue(value.issue)) return false;
  if (['eligible', 'running', 'completed'].includes(value.state)) return isLocalRelocationPlanHash(value.verifiedTargetFingerprint) && value.sourceResourceIds.length > 0 && value.issue === null;
  return value.state !== 'unavailable' || value.verifiedTargetFingerprint === null && value.sourceResourceIds.length === 0;
}
function recoveryChoice(value: unknown): value is LocalRelocationPlanRecoveryChoice {
  return record(value, ['choiceId', 'originPlanId', 'expectedOriginViewRevision', 'recoveryFingerprint', 'action', 'label', 'resourceIds']) && [value.choiceId, value.originPlanId].every(isCollectionId)
    && isLocalCatalogRevision(value.expectedOriginViewRevision) && isLocalRelocationPlanHash(value.recoveryFingerprint) && values(value.action, ['reconcile', 'rollback', 'keep-target'] as const)
    && isLocalRelocationPlanLabel(value.label) && ids(value.resourceIds, 1, LOCAL_RELOCATION_PLAN_BUDGET.closedResources);
}
function planData(value: unknown): value is LocalRelocationPlan {
  if (!record(value, ['version', 'domain', 'datasetId', 'planId', 'jobId', 'viewRevision', 'journalSequence', 'createdAt', 'expiresAt', 'planHash', 'contextFingerprint', 'policyRevision', 'intent', 'state', 'sourceDisposition', 'closure', 'items', 'resources', 'referenceEdges', 'issues', 'cleanup', 'recoveryChoices'])
    || value.version !== 1 || value.domain !== LOCAL_RELOCATION_PLAN_DOMAIN || !isLocalRelocationPlanDatasetId(value.datasetId) || ![value.planId, value.jobId].every(isCollectionId)
    || ![value.viewRevision, value.journalSequence, value.policyRevision].every(isLocalCatalogRevision) || ![value.createdAt, value.expiresAt].every(isLocalRelocationPlanDate)
    || Date.parse(value.expiresAt as string) <= Date.parse(value.createdAt as string) || ![value.planHash, value.contextFingerprint].every(isLocalRelocationPlanHash)
    || !intent(value.intent) || !state(value.state) || !disposition(value.sourceDisposition)
    || !array(value.items, LOCAL_RELOCATION_PLAN_BUDGET.operations) || !value.items.every(item) || !array(value.resources, LOCAL_RELOCATION_PLAN_BUDGET.closedResources) || !value.resources.every(resource)
    || !array(value.referenceEdges, LOCAL_RELOCATION_PLAN_BUDGET.referenceEdges) || !value.referenceEdges.every(edge) || !array(value.issues, LOCAL_RELOCATION_PLAN_BUDGET.closedResources) || !value.issues.every(issueData)
    || !cleanupView(value.cleanup) || !array(value.recoveryChoices, LOCAL_RELOCATION_PLAN_BUDGET.closedResources) || !value.recoveryChoices.every(recoveryChoice)) return false;
  const closure = value.closure;
  if (!record(closure, ['complete', 'operationCount', 'resourceCount', 'referenceEdgeCount', 'rootCount', 'fingerprint', 'totalSourceBytes', 'spaceVerified', 'protection']) || typeof closure.complete !== 'boolean'
    || !integer(closure.operationCount, 0, LOCAL_RELOCATION_PLAN_BUDGET.operations) || closure.operationCount !== value.items.length
    || !integer(closure.resourceCount, 0, LOCAL_RELOCATION_PLAN_BUDGET.closedResources) || closure.resourceCount !== value.resources.length
    || !integer(closure.referenceEdgeCount, 0, LOCAL_RELOCATION_PLAN_BUDGET.referenceEdges) || closure.referenceEdgeCount !== value.referenceEdges.length
    || !integer(closure.rootCount, 0, LOCAL_RELOCATION_PLAN_BUDGET.sourceAndTargetRoots) || !isLocalRelocationPlanHash(closure.fingerprint)
    || !boundedBytes(closure.totalSourceBytes, LOCAL_RELOCATION_PLAN_BUDGET.planFullSourceBytes) || typeof closure.spaceVerified !== 'boolean' || !values(closure.protection, ['verified', 'unknown', 'blocked'] as const)) return false;
  const items = value.items as LocalRelocationPlanItem[], resources = value.resources as LocalRelocationPlanResource[], edges = value.referenceEdges as LocalRelocationReferenceEdge[];
  const operationIds = new Set(items.map(entry => entry.operationId)), resourceIds = new Set(resources.map(entry => entry.resourceId));
  if (operationIds.size !== items.length || resourceIds.size !== resources.length || new Set(edges.map(entry => entry.edgeId)).size !== edges.length
    || new Set((value.recoveryChoices as LocalRelocationPlanRecoveryChoice[]).map(entry => entry.choiceId)).size !== value.recoveryChoices.length) return false;
  if (items.some(entry => entry.resourceIds.some(id => !resourceIds.has(id))) || resources.some(entry => entry.operationIds.some(id => !operationIds.has(id)))) return false;
  if (items.some(entry => entry.resourceIds.some(id => !resources.find(resource => resource.resourceId === id)!.operationIds.includes(entry.operationId)))
    || resources.some(entry => entry.operationIds.some(id => !items.find(item => item.operationId === id)!.resourceIds.includes(entry.resourceId)))) return false;
  if (edges.some(entry => !resourceIds.has(entry.fromResourceId) || !resourceIds.has(entry.toResourceId))) return false;
  if ((value.cleanup as LocalRelocationPlanCleanupView).sourceResourceIds.some(id => !resourceIds.has(id)) || (value.recoveryChoices as LocalRelocationPlanRecoveryChoice[]).some(entry => entry.resourceIds.some(id => !resourceIds.has(id)))) return false;
  if (value.state === 'READY' && (!closure.complete || !closure.spaceVerified || closure.protection !== 'verified' || !items.length || !resources.length || value.issues.length > 0
    || resources.some(entry => entry.role === 'UNKNOWN_REFERENCE' || entry.issue !== null || entry.state === 'unknown') || items.some(entry => entry.issue !== null || entry.state === 'unknown'))) return false;
  if (closure.complete && resources.some(entry => entry.bytes === null || entry.role === 'UNKNOWN_REFERENCE')) return false;
  if (resources.every(entry => entry.bytes !== null) && resources.reduce((sum, entry) => sum + BigInt(entry.bytes!), 0n) !== BigInt(closure.totalSourceBytes as string)) return false;
  const cleanup = value.cleanup as LocalRelocationPlanCleanupView;
  if (['eligible', 'running', 'completed'].includes(cleanup.state) && (value.state === 'VERIFIED_TARGET' || cleanup.sourceResourceIds.some(id => {
    const entry = resources.find(resource => resource.resourceId === id)!;
    return entry.verification !== 'verified-target' || !['registered', 'retained', 'cleaned'].includes(entry.state);
  }))) return false;
  if (value.state === 'COMPLETED' && (!closure.complete || value.issues.length > 0 || items.some(entry => !['registered', 'retained', 'cleaned', 'unchanged'].includes(entry.state) || entry.issue !== null)
    || resources.some(entry => !['registered', 'retained', 'cleaned', 'unchanged'].includes(entry.state) || entry.issue !== null))) return false;
  return true;
}
export function isLocalRelocationPlan(value: unknown): value is LocalRelocationPlan { try { return planData(localRelocationDataSnapshot(value)); } catch { return false; } }
function context(value: unknown): value is LocalRelocationPlanContext {
  if (!record(value, ['datasetId', 'kind', 'policy', 'qualification']) || !isLocalRelocationPlanDatasetId(value.datasetId) || value.kind !== 'context' || !policy(value.policy)) return false;
  const qualification = value.qualification;
  return record(qualification, ['state', 'proofFingerprint', 'issue']) && values(qualification.state, ['unqualified', 'qualified', 'blocked'] as const)
    && (qualification.proofFingerprint === null || isLocalRelocationPlanHash(qualification.proofFingerprint)) && issue(qualification.issue)
    && (qualification.state !== 'qualified' || isLocalRelocationPlanHash(qualification.proofFingerprint) && qualification.issue === null);
}
function getResult(value: unknown): value is LocalRelocationPlanGetResult {
  if (!value || typeof value !== 'object' || !isLocalRelocationPlanDatasetId((value as Data).datasetId)) return false;
  const data = value as Data;
  if (data.kind === 'context') return context(data);
  if (data.kind === 'plan') return record(data, ['datasetId', 'kind', 'planId', 'plan', 'issue']) && isCollectionId(data.planId) && issue(data.issue)
    && (data.plan === null ? data.issue !== null : planData(data.plan) && data.plan.planId === data.planId && data.plan.datasetId === data.datasetId && data.issue === null);
  return data.kind === 'command' && record(data, ['datasetId', 'kind', 'commandId', 'expectedCommand', 'requestFingerprint', 'receipt', 'issue']) && isCollectionId(data.commandId)
    && isLocalRelocationPlanReceiptCommand(data.expectedCommand) && isLocalRelocationPlanHash(data.requestFingerprint) && issue(data.issue)
    && (data.receipt === null ? data.issue !== null : receipt(data.receipt) && data.receipt.datasetId === data.datasetId && data.receipt.commandId === data.commandId
      && data.receipt.command === data.expectedCommand && data.receipt.requestFingerprint === data.requestFingerprint && data.issue === null);
}
function event(value: unknown): value is LocalRelocationPlanEvent {
  return record(value, ['eventId', 'planId', 'journalSequence', 'operationId', 'resourceId', 'phase', 'occurredAt', 'label', 'issue']) && [value.eventId, value.planId].every(isCollectionId)
    && isLocalCatalogRevision(value.journalSequence) && nullableId(value.operationId) && nullableId(value.resourceId) && phase(value.phase) && isLocalRelocationPlanDate(value.occurredAt) && isLocalRelocationPlanLabel(value.label) && issue(value.issue);
}
function historyItem(value: unknown): value is LocalRelocationPlanHistoryItem {
  return record(value, ['planId', 'jobId', 'viewRevision', 'state', 'createdAt', 'operations', 'issue']) && [value.planId, value.jobId].every(isCollectionId)
    && isLocalCatalogRevision(value.viewRevision) && state(value.state) && isLocalRelocationPlanDate(value.createdAt) && integer(value.operations, 0, LOCAL_RELOCATION_PLAN_BUDGET.operations) && issue(value.issue);
}
function history(value: unknown): value is LocalRelocationPlanHistory {
  if (!value || typeof value !== 'object') return false;
  const data = value as Data;
  if (!isLocalRelocationPlanDatasetId(data.datasetId) || !isLocalRelocationPlanHash(data.snapshotFingerprint) || !integer(data.limit, 1, LOCAL_RELOCATION_PLAN_BUDGET.operations)
    || !array(data.items, data.limit) || !nullableId(data.cursor) || typeof data.hasMore !== 'boolean' || data.hasMore !== (data.cursor !== null)) return false;
  if (data.kind === 'plans') return record(data, ['datasetId', 'kind', 'snapshotFingerprint', 'limit', 'items', 'cursor', 'hasMore']) && data.items.every(historyItem)
    && new Set(data.items.map(entry => (entry as LocalRelocationPlanHistoryItem).planId)).size === data.items.length;
  return data.kind === 'events' && record(data, ['datasetId', 'kind', 'planId', 'snapshotFingerprint', 'limit', 'items', 'cursor', 'hasMore']) && isCollectionId(data.planId)
    && data.items.every(entry => event(entry) && entry.planId === data.planId) && new Set(data.items.map(entry => (entry as LocalRelocationPlanEvent).eventId)).size === data.items.length;
}
export function localRelocationPlanCommandResultSnapshot<C extends LocalRelocationPlanCommand>(command: C, input: unknown): LocalRelocationPlanCommandResults[C] {
  const value = localRelocationDataSnapshot(input);
  if (!isLocalRelocationPlanCommand(command)) return invalid();
  const valid = command === 'localRelocationPlan.chooseTarget' ? value === null || targetChoice(value)
    : command === 'localRelocationPlan.get' ? getResult(value) : command === 'localRelocationPlan.history' ? history(value)
      : receipt(value) && value.command === command;
  if (!valid) return invalid();
  return value as LocalRelocationPlanCommandResults[C];
}
export function isLocalRelocationPlanCommandResult<C extends LocalRelocationPlanCommand>(command: C, input: unknown): input is LocalRelocationPlanCommandResults[C] {
  try { localRelocationPlanCommandResultSnapshot(command, input); return true; } catch { return false; }
}
