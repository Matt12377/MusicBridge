import { isCollectionId } from './collection.js';
import { isLocalCatalogRevision, isLocalExactInteger, isLocalCatalogText } from './local-catalog.js';
import { isOrganizerFrozenBody, type LocalOrganizerTarget, type OrganizerFrozenBody } from './local-organizer.js';
import { localSourceWritesCanonical, localSourceWritesDataSnapshot, localSourceWritesRecord, localSourceWritesUtf8Bytes } from './local-source-writes-data.js';

export const LOCAL_SOURCE_WRITES_COMMANDS = ['localSourceWrites.preview', 'localSourceWrites.get', 'localSourceWrites.history', 'localSourceWrites.confirm', 'localSourceWrites.undo', 'localSourceWrites.cancel', 'localSourceWrites.setPolicy'] as const;
export const LOCAL_SOURCE_WRITES_OUTBOX_COMMANDS = ['localSourceWrites.setPolicy', 'localSourceWrites.confirm', 'localSourceWrites.undo'] as const;
export const LOCAL_SOURCE_WRITES_FIELDS = ['title', 'artist', 'album', 'year', 'disc', 'track'] as const;
export const LOCAL_SOURCE_WRITES_RANGES = ['TAGS', 'EMBEDDED_COVER', 'DIRECTORY_COVER'] as const;
export const LOCAL_SOURCE_WRITES_PROFILES = ['NATIVE_FLAC_FIXED_TAG_REGION_V1', 'MPEG1_LAYERIII_ID3V240_FIXED_TAG_REGION_V1'] as const;
export const LOCAL_SOURCE_WRITES_STATES = ['PREVIEWING', 'READY', 'BLOCKED', 'QUEUED', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCEL_REQUESTED', 'CANCELLED', 'RECOVERY_REQUIRED'] as const;
export const LOCAL_SOURCE_WRITES_PHASES = ['PLANNED', 'BACKUP', 'STAGED', 'CAPTURE_INTENT', 'CAPTURED', 'PUBLISH_INTENT', 'PUBLISHED', 'CLEANUP', 'VERIFIED', 'FACTS_COMMITTED', 'QUIET', 'TERMINAL', 'UNKNOWN'] as const;
export const LOCAL_SOURCE_WRITES_ISSUES = ['INVALID_REQUEST', 'DATASET_SCOPE_MISMATCH', 'NOT_FOUND', 'COMMAND_ID_REUSED', 'POLICY_DISABLED', 'POLICY_CHANGED', 'POLICY_DRAINING', 'GRANT_REQUIRED', 'GRANT_MISMATCH', 'GRANT_CONSUMED', 'PLAN_EXPIRED', 'PREVIEW_MISMATCH', 'REVISION_CHANGED', 'SOURCE_OFFLINE', 'SOURCE_REVOKED', 'SOURCE_CHANGED', 'FROZEN_SOURCE', 'ACTIVE_READER', 'UNKNOWN_PROTECTION', 'UNSUPPORTED_FORMAT', 'UNSUPPORTED_TAGS', 'UNSUPPORTED_FIELD', 'FORMAT_NOT_QUALIFIED', 'INSUFFICIENT_PADDING', 'ARTWORK_UNAVAILABLE', 'ARTWORK_CHANGED', 'SHARED_RESOURCE_UNKNOWN', 'HARD_LINKED_SOURCE', 'SEGMENTED_SOURCE', 'FILE_ATTRIBUTES_UNPROVEN', 'BACKUP_UNAVAILABLE', 'BACKUP_INVALID', 'INSUFFICIENT_SPACE', 'NAMESPACE_CONFLICT', 'REPLACEMENT_UNKNOWN', 'COMMIT_UNKNOWN', 'RELEASE_UNKNOWN', 'UNDO_CONFLICT', 'RECOVERY_REQUIRED', 'BUDGET_EXCEEDED', 'REVISION_EXHAUSTED', 'CURSOR_SCOPE_MISMATCH', 'CURSOR_EXPIRED', 'INVENTORY_UNAVAILABLE', 'CANCELLED'] as const;
export const LOCAL_SOURCE_WRITES_BUDGET = Object.freeze({
  operations: 100, requestBytes: 65536, requestNodes: 8192, planBytes: 2097152, publicNodes: 50000,
  headerAndItemAllTextBytes: 65536, phaseAllTextBytes: 16384, phaseEventsPerOperation: 32, phaseEventsPerPlan: 4096,
  terminalReservedEventsPerOperation: 4, terminalReservedEventsPerPlan: 16, journalProjectionBytes: 67108864,
  originalBytes: 4194304, originalMetadataEnvelopeBytes: 16384, retainedOriginalBytes: 67108864, retainedOriginalCount: 128,
  tagRegionBytes: 8388608, tagParts: 4096, sourceFileBytes: 268435456, planPayloadIoBytes: 2147483648, safetyRepositoryBytes: 2147483648,
  previewTtlMs: 600000, pageItems: 100, cursorBytes: 512,
});
export const LOCAL_SOURCE_WRITES_DEFAULT_POLICY = Object.freeze({ enabled: false, revision: '1', draining: false });
export type LocalSourceWritesRange = typeof LOCAL_SOURCE_WRITES_RANGES[number];
export type LocalSourceWritesField = typeof LOCAL_SOURCE_WRITES_FIELDS[number];
export type LocalSourceWritesProfile = typeof LOCAL_SOURCE_WRITES_PROFILES[number];
export type LocalSourceWritesState = typeof LOCAL_SOURCE_WRITES_STATES[number];
export type LocalSourceWritesPhase = typeof LOCAL_SOURCE_WRITES_PHASES[number];
export type LocalSourceWritesIssue = typeof LOCAL_SOURCE_WRITES_ISSUES[number];
export type LocalSourceWritesTarget = LocalOrganizerTarget;
/** remove 删除源标签；旧 011 clear 清除 MB 人工覆盖，两者不互换。 */
export type LocalSourceWritesTagChange = { action: 'set'; value: string } | { action: 'remove' };
export interface LocalSourceWritesArtworkRef { editionId: string; candidateId: string; selectionId: string; expectedSelectionRevision: string; contentRef: string; originalSha256: string }
export type LocalSourceWritesIntent =
  | { kind: 'tags'; target: LocalSourceWritesTarget; fields: Partial<Record<LocalSourceWritesField, LocalSourceWritesTagChange>> }
  | { kind: 'embedded-cover'; target: LocalSourceWritesTarget; artwork: LocalSourceWritesArtworkRef; slot: 'front' }
  | { kind: 'directory-cover'; target: LocalSourceWritesTarget; artwork: LocalSourceWritesArtworkRef; fileName: 'cover.jpg' | 'cover.png' }
  | { kind: 'recovery'; originPlanId: string; expectedOriginViewRevision: string; choiceId: string; recoveryFingerprint: string };
export interface PreviewLocalSourceWrites { datasetId: string; commandId: string; intent: LocalSourceWritesIntent }
export interface ConfirmLocalSourceWrites { datasetId: string; commandId: string; planId: string; expectedViewRevision: string; scope: 'SOURCE_FILES'; range: LocalSourceWritesRange; planHash: string; contextFingerprint: string }
export interface UndoLocalSourceWrites { datasetId: string; commandId: string; planId: string; expectedViewRevision: string; operationIds: string[]; journalFingerprint: string }
export interface CancelLocalSourceWrites { datasetId: string; commandId: string; planId: string; expectedViewRevision: string }
export interface SetLocalSourceWritesPolicy { datasetId: string; commandId: string; expectedPolicyRevision: string; enabled: boolean }
export type LocalSourceWritesReceiptCommand = 'localSourceWrites.preview' | 'localSourceWrites.confirm' | 'localSourceWrites.undo' | 'localSourceWrites.cancel' | 'localSourceWrites.setPolicy';
export type LocalSourceWritesGetSelector = { kind: 'context'; target: LocalSourceWritesTarget | null } | { kind: 'plan'; planId: string } | { kind: 'command'; commandId: string; expectedCommand: LocalSourceWritesReceiptCommand; requestFingerprint: string };
export interface GetLocalSourceWrites { datasetId: string; selector: LocalSourceWritesGetSelector }
export type LocalSourceWritesHistorySelector = { kind: 'plans'; range: LocalSourceWritesRange | 'all' } | { kind: 'events'; planId: string };
export interface HistoryLocalSourceWrites { datasetId: string; selector: LocalSourceWritesHistorySelector; cursor: string | null; limit: number }
export interface LocalSourceWritesPolicy { enabled: boolean; revision: string; draining: boolean }
export interface LocalSourceWritesCapabilities {
  publisherProfile: 'NONATOMIC_QUARANTINE_LINK_V1';
  formats: { profile: LocalSourceWritesProfile; qualified: boolean; tags: boolean; embeddedCover: boolean; fields: LocalSourceWritesField[]; issue: LocalSourceWritesIssue | null }[];
  directoryCover: { qualified: boolean; issue: LocalSourceWritesIssue | null };
}
export interface LocalSourceWritesMaterial { editionId: string; selectionId: string; selectionRevision: string; candidateId: string | null; availability: 'available' | 'reacquire-required' | 'unavailable'; contentRef: string | null; originalSha256: string | null; issue: LocalSourceWritesIssue | null }
export interface LocalSourceWritesContext { datasetId: string; policy: LocalSourceWritesPolicy; capabilities: LocalSourceWritesCapabilities; materials: LocalSourceWritesMaterial[] }
/** 回执保存的是原请求的受理决定；写入结果始终从计划状态读取。 */
export interface LocalSourceWritesReceipt { datasetId: string; commandId: string; command: LocalSourceWritesReceiptCommand; requestFingerprint: string; planId: string | null; jobId: string | null; outcome: 'accepted' | 'rejected'; policy: LocalSourceWritesPolicy | null; issue: LocalSourceWritesIssue | null }
export interface LocalSourceWritesChange { field: LocalSourceWritesField; action: 'set' | 'remove'; before: string[] | null; after: string[] | null }
export interface LocalSourceWritesArtwork extends LocalSourceWritesArtworkRef { mime: 'image/jpeg' | 'image/png'; bytes: number; width: number; height: number; slot: 'front' | 'directory' }
/** 仅逆向材料投影；实际原操作归属、备份内容与完整输出 Hash 仍由 Owner 核实。 */
export interface LocalSourceWritesRestoration {
  originPlanId: string; originOperationId: string;
  kind: 'restore-audio-file' | 'restore-directory-cover' | 'remove-new-directory-cover';
  material: 'verified-backup' | 'verified-absence'; expectedOutputSha256: string | null;
}
export interface LocalSourceWritesItem {
  operationId: string; resourceRef: string; trackId: string; assetId: string; label: string; profile: LocalSourceWritesProfile | null;
  expectedFileRevision: string; currentFileRevision: string; expectedRootRevision: string; expectedLocationRevision: string; expectedSelectionRevision: string;
  changes: LocalSourceWritesChange[]; artwork: LocalSourceWritesArtwork | null;
  restoration?: LocalSourceWritesRestoration;
  state: 'planned' | 'applied' | 'not-written' | 'unknown'; phase: LocalSourceWritesPhase;
  backup: { state: 'not-created' | 'verified' | 'retained' | 'unknown'; bytes: string | null };
  verification: { audio: 'not-applicable' | 'pending' | 'verified' | 'unknown'; unselectedMetadata: 'not-applicable' | 'pending' | 'verified' | 'unknown'; content: 'pending' | 'verified' | 'unknown'; reread: 'pending' | 'verified' | 'unknown' };
  issue: LocalSourceWritesIssue | null;
}
export interface LocalSourceWritesRecoveryChoice { choiceId: string; originPlanId: string; expectedOriginViewRevision: string; recoveryFingerprint: string; action: 'restore-original' | 'complete-publication' | 'finalize-facts' | 'release-protection'; label: string; operationIds: string[] }
export interface LocalSourceWritesPlan {
  version: 1; datasetId: string; planId: string; jobId: string; viewRevision: string; journalSequence: string; scope: 'SOURCE_FILES'; range: LocalSourceWritesRange; state: LocalSourceWritesState;
  createdAt: string; readyAt: string | null; expiresAt: string | null; policyRevision: string; planHash: string | null; contextFingerprint: string | null; journalFingerprint: string;
  summary: string; items: LocalSourceWritesItem[]; issues: LocalSourceWritesIssue[];
  resourceSummary: { resources: number; sharedTargets: number; backupBytes: string | null; spaceVerified: boolean; protection: 'verified' | 'unknown' | 'blocked' };
  undoOf: string | null; recoveryOf: string | null; recoveryChoices: LocalSourceWritesRecoveryChoice[];
}
export type LocalSourceWritesGetResult =
  | { datasetId: string; kind: 'context'; context: LocalSourceWritesContext }
  | { datasetId: string; kind: 'plan'; plan: LocalSourceWritesPlan | null; issue: 'NOT_FOUND' | null }
  | { datasetId: string; kind: 'command'; commandId: string; expectedCommand: LocalSourceWritesReceiptCommand; requestFingerprint: string; receipt: LocalSourceWritesReceipt | null; issue: 'NOT_FOUND' | null };
export interface LocalSourceWritesPlanSummary { planId: string; jobId: string; viewRevision: string; range: LocalSourceWritesRange; state: LocalSourceWritesState; createdAt: string; operations: number; issue: LocalSourceWritesIssue | null }
export interface LocalSourceWritesHistoryEvent { eventId: string; planId: string; journalSequence: string; operationId: string | null; phase: LocalSourceWritesPhase; occurredAt: string; label: string; issue: LocalSourceWritesIssue | null }
export type LocalSourceWritesHistoryPage =
  | { datasetId: string; kind: 'plans'; range: LocalSourceWritesRange | 'all'; snapshotFingerprint: string; limit: number; items: LocalSourceWritesPlanSummary[]; cursor: string | null; hasMore: boolean }
  | { datasetId: string; kind: 'events'; planId: string; snapshotFingerprint: string; limit: number; items: LocalSourceWritesHistoryEvent[]; cursor: string | null; hasMore: boolean };
export interface LocalSourceWritesCommandPayloads {
  'localSourceWrites.preview': PreviewLocalSourceWrites; 'localSourceWrites.get': GetLocalSourceWrites; 'localSourceWrites.history': HistoryLocalSourceWrites;
  'localSourceWrites.confirm': ConfirmLocalSourceWrites; 'localSourceWrites.undo': UndoLocalSourceWrites; 'localSourceWrites.cancel': CancelLocalSourceWrites; 'localSourceWrites.setPolicy': SetLocalSourceWritesPolicy;
}
export interface LocalSourceWritesCommandResults {
  'localSourceWrites.preview': LocalSourceWritesReceipt; 'localSourceWrites.get': LocalSourceWritesGetResult; 'localSourceWrites.history': LocalSourceWritesHistoryPage;
  'localSourceWrites.confirm': LocalSourceWritesReceipt; 'localSourceWrites.undo': LocalSourceWritesReceipt; 'localSourceWrites.cancel': LocalSourceWritesReceipt; 'localSourceWrites.setPolicy': LocalSourceWritesReceipt;
}
export type LocalSourceWritesCommand = keyof LocalSourceWritesCommandPayloads;
export type LocalSourceWritesOutboxCommand = typeof LOCAL_SOURCE_WRITES_OUTBOX_COMMANDS[number];
export interface LocalSourceWritesPublicApi {
  previewLocalSourceWrites(request: PreviewLocalSourceWrites): Promise<LocalSourceWritesReceipt>;
  getLocalSourceWrites(request: GetLocalSourceWrites): Promise<LocalSourceWritesGetResult>;
  listLocalSourceWritesHistory(request: HistoryLocalSourceWrites): Promise<LocalSourceWritesHistoryPage>;
  confirmLocalSourceWrites(request: ConfirmLocalSourceWrites): Promise<LocalSourceWritesReceipt>;
  undoLocalSourceWrites(request: UndoLocalSourceWrites): Promise<LocalSourceWritesReceipt>;
  cancelLocalSourceWrites(request: CancelLocalSourceWrites): Promise<LocalSourceWritesReceipt>;
  setLocalSourceWritesPolicy(request: SetLocalSourceWritesPolicy): Promise<LocalSourceWritesReceipt>;
}

type Data = Record<string, unknown>;
const record = localSourceWritesRecord;
const values = <T extends readonly string[]>(value: unknown, allowed: T): value is T[number] => typeof value === 'string' && (allowed as readonly string[]).includes(value);
export const isLocalSourceWritesDatasetId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
export const isLocalSourceWritesHash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
export const isLocalSourceWritesIssue = (value: unknown): value is LocalSourceWritesIssue => values(value, LOCAL_SOURCE_WRITES_ISSUES);
const issue = (value: unknown): boolean => value === null || isLocalSourceWritesIssue(value);
const date = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const integer = (value: unknown, minimum: number, maximum: number): value is number => typeof value === 'number' && !Object.is(value, -0) && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const array = (value: unknown, maximum = 100): value is unknown[] => Array.isArray(value) && value.length <= maximum;
const ids = (value: unknown, minimum = 1): value is string[] => array(value) && value.length >= minimum && value.every(isCollectionId) && new Set(value).size === value.length;
const label = (value: unknown): value is string => isLocalCatalogText(value) && !/^\s*(?:\/|~[\\/]|[a-z]:[\\/]|file:)/iu.test(value);
const cursor = (value: unknown): value is string | null => value === null || typeof value === 'string' && /^[A-Za-z0-9_-]{1,512}$/u.test(value);
const range = (value: unknown): value is LocalSourceWritesRange => values(value, LOCAL_SOURCE_WRITES_RANGES);
const state = (value: unknown): value is LocalSourceWritesState => values(value, LOCAL_SOURCE_WRITES_STATES);
const phase = (value: unknown): value is LocalSourceWritesPhase => values(value, LOCAL_SOURCE_WRITES_PHASES);
const profile = (value: unknown): value is LocalSourceWritesProfile => values(value, LOCAL_SOURCE_WRITES_PROFILES);
const receiptCommand = (value: unknown): value is LocalSourceWritesReceiptCommand => values(value, ['localSourceWrites.preview', 'localSourceWrites.confirm', 'localSourceWrites.undo', 'localSourceWrites.cancel', 'localSourceWrites.setPolicy'] as const);
function target(value: unknown): value is LocalSourceWritesTarget {
  return record(value, ['mode', 'trackId']) && value.mode === 'single' && isCollectionId(value.trackId)
    || record(value, ['mode', 'editionId']) && value.mode === 'edition' && isCollectionId(value.editionId)
    || record(value, ['mode', 'trackIds']) && value.mode === 'batch' && ids(value.trackIds);
}
function artworkRef(value: unknown): value is LocalSourceWritesArtworkRef {
  return record(value, ['editionId', 'candidateId', 'selectionId', 'expectedSelectionRevision', 'contentRef', 'originalSha256'])
    && [value.editionId, value.candidateId, value.selectionId, value.contentRef].every(isCollectionId) && isLocalCatalogRevision(value.expectedSelectionRevision) && isLocalSourceWritesHash(value.originalSha256);
}
function fields(value: unknown): boolean {
  if (!record(value, [], LOCAL_SOURCE_WRITES_FIELDS) || !Object.keys(value).length) return false;
  return Object.entries(value).every(([field, change]) => {
    if (record(change, ['action']) && change.action === 'remove') return true;
    if (!record(change, ['action', 'value']) || change.action !== 'set' || !isLocalCatalogText(change.value, true)) return false;
    if (field === 'year') return /^\d{4}$/u.test(change.value);
    if (field === 'disc' || field === 'track') return /^(0|[1-9][0-9]*)$/u.test(change.value) && Number(change.value) <= 100000;
    return change.value.trim().length > 0;
  });
}
function intent(value: unknown): value is LocalSourceWritesIntent {
  return record(value, ['kind', 'target', 'fields']) && value.kind === 'tags' && target(value.target) && fields(value.fields)
    || record(value, ['kind', 'target', 'artwork', 'slot']) && value.kind === 'embedded-cover' && target(value.target) && artworkRef(value.artwork) && value.slot === 'front'
    || record(value, ['kind', 'target', 'artwork', 'fileName']) && value.kind === 'directory-cover' && target(value.target) && artworkRef(value.artwork) && (value.fileName === 'cover.jpg' || value.fileName === 'cover.png')
    || record(value, ['kind', 'originPlanId', 'expectedOriginViewRevision', 'choiceId', 'recoveryFingerprint']) && value.kind === 'recovery' && isCollectionId(value.originPlanId) && isLocalCatalogRevision(value.expectedOriginViewRevision) && isCollectionId(value.choiceId) && isLocalSourceWritesHash(value.recoveryFingerprint);
}
function policy(value: unknown): value is LocalSourceWritesPolicy { return record(value, ['enabled', 'revision', 'draining']) && typeof value.enabled === 'boolean' && isLocalCatalogRevision(value.revision) && typeof value.draining === 'boolean' && (!value.draining || !value.enabled); }
function receipt(value: unknown): value is LocalSourceWritesReceipt {
  if (!record(value, ['datasetId', 'commandId', 'command', 'requestFingerprint', 'planId', 'jobId', 'outcome', 'policy', 'issue']) || !isLocalSourceWritesDatasetId(value.datasetId) || !isCollectionId(value.commandId) || !receiptCommand(value.command) || !isLocalSourceWritesHash(value.requestFingerprint) || !issue(value.issue)) return false;
  if (value.outcome === 'rejected') return value.policy === null && value.issue !== null && (value.planId === null && value.jobId === null || isCollectionId(value.planId) && isCollectionId(value.jobId));
  return value.outcome === 'accepted' && value.issue === null && (value.command === 'localSourceWrites.setPolicy' ? value.planId === null && value.jobId === null && policy(value.policy) : isCollectionId(value.planId) && isCollectionId(value.jobId) && value.policy === null);
}
function restoration(value: unknown): value is LocalSourceWritesRestoration {
  if (!record(value, ['originPlanId', 'originOperationId', 'kind', 'material', 'expectedOutputSha256']) || ![value.originPlanId, value.originOperationId].every(isCollectionId)) return false;
  return value.kind === 'remove-new-directory-cover' ? value.material === 'verified-absence' && value.expectedOutputSha256 === null
    : (value.kind === 'restore-audio-file' || value.kind === 'restore-directory-cover') && value.material === 'verified-backup' && isLocalSourceWritesHash(value.expectedOutputSha256);
}
function change(value: unknown, restoreArtist: boolean): value is LocalSourceWritesChange {
  const texts = (input: unknown): boolean => input === null || array(input, 32) && input.length > 0 && input.every(text => isLocalCatalogText(text, true));
  if (!record(value, ['field', 'action', 'before', 'after']) || !values(value.field, LOCAL_SOURCE_WRITES_FIELDS) || !texts(value.before) || !texts(value.after)) return false;
  if (value.action === 'remove') return value.after === null;
  if (value.action !== 'set' || !array(value.after)) return false;
  // 原 artists 多值按原顺序展示，不拆分、不拼接、不规范化；空标签不伪造为有效 artists。
  if (restoreArtist && value.field === 'artist') return value.after.length >= 1 && value.after.length <= 32 && value.after.every(text => isLocalCatalogText(text, true) && text.length > 0);
  return value.after.length === 1 && fields({ [value.field]: { action: 'set', value: value.after[0] } });
}
function artwork(value: unknown): value is LocalSourceWritesArtwork {
  if (!record(value, ['editionId', 'candidateId', 'selectionId', 'expectedSelectionRevision', 'contentRef', 'originalSha256', 'mime', 'bytes', 'width', 'height', 'slot'])) return false;
  const { editionId, candidateId, selectionId, expectedSelectionRevision, contentRef, originalSha256 } = value;
  return artworkRef({ editionId, candidateId, selectionId, expectedSelectionRevision, contentRef, originalSha256 }) && (value.mime === 'image/png' || value.mime === 'image/jpeg')
    && integer(value.bytes, 1, LOCAL_SOURCE_WRITES_BUDGET.originalBytes) && integer(value.width, 1, 4096) && integer(value.height, 1, 4096) && value.width * value.height <= 16777216 && (value.slot === 'front' || value.slot === 'directory');
}
function item(value: unknown, inverseOrigin: string | null, selectedRange: LocalSourceWritesRange): value is LocalSourceWritesItem {
  if (!record(value, ['operationId', 'resourceRef', 'trackId', 'assetId', 'label', 'profile', 'expectedFileRevision', 'currentFileRevision', 'expectedRootRevision', 'expectedLocationRevision', 'expectedSelectionRevision', 'changes', 'artwork', 'state', 'phase', 'backup', 'verification', 'issue'], ['restoration'])) return false;
  const restored = Object.hasOwn(value, 'restoration');
  if (restored && (!inverseOrigin || !restoration(value.restoration) || value.restoration.originPlanId !== inverseOrigin
    || (selectedRange === 'DIRECTORY_COVER' ? value.restoration.kind === 'restore-audio-file' : value.restoration.kind !== 'restore-audio-file'))) return false;
  if (![value.operationId, value.resourceRef, value.trackId, value.assetId].every(isCollectionId) || !label(value.label) || !(value.profile === null || profile(value.profile))
    || ![value.expectedFileRevision, value.currentFileRevision, value.expectedRootRevision, value.expectedLocationRevision, value.expectedSelectionRevision].every(isLocalCatalogRevision)
    || !array(value.changes, 6) || !value.changes.every((entry): entry is LocalSourceWritesChange => change(entry, restored && selectedRange === 'TAGS')) || new Set(value.changes.map(c => c.field)).size !== value.changes.length || !(value.artwork === null || artwork(value.artwork) && value.artwork.expectedSelectionRevision === value.expectedSelectionRevision)
    || !values(value.state, ['planned', 'applied', 'not-written', 'unknown'] as const) || !phase(value.phase) || !issue(value.issue)
    || !record(value.backup, ['state', 'bytes']) || !values(value.backup.state, ['not-created', 'verified', 'retained', 'unknown'] as const) || !(value.backup.bytes === null || isLocalExactInteger(value.backup.bytes))
    || !record(value.verification, ['audio', 'unselectedMetadata', 'content', 'reread']) || ![value.verification.audio, value.verification.unselectedMetadata].every(v => values(v, ['not-applicable', 'pending', 'verified', 'unknown'] as const))
    || ![value.verification.content, value.verification.reread].every(v => values(v, ['pending', 'verified', 'unknown'] as const))) return false;
  if (value.state === 'applied') return value.issue === null && value.phase === 'TERMINAL' && ['verified', 'retained'].includes(value.backup.state as string) && isLocalExactInteger(value.backup.bytes)
    && [value.verification.audio, value.verification.unselectedMetadata].every(v => v === 'verified' || v === 'not-applicable') && value.verification.content === 'verified' && value.verification.reread === 'verified';
  return value.state !== 'unknown' || value.issue !== null;
}
function recoveryChoice(value: unknown, plan: LocalSourceWritesPlan): boolean {
  return record(value, ['choiceId', 'originPlanId', 'expectedOriginViewRevision', 'recoveryFingerprint', 'action', 'label', 'operationIds']) && isCollectionId(value.choiceId)
    && value.originPlanId === plan.planId && value.expectedOriginViewRevision === plan.viewRevision && isLocalSourceWritesHash(value.recoveryFingerprint) && values(value.action, ['restore-original', 'complete-publication', 'finalize-facts', 'release-protection'] as const)
    && label(value.label) && ids(value.operationIds) && value.operationIds.every(id => plan.items.some(candidate => candidate.operationId === id));
}
function plan(value: unknown): value is LocalSourceWritesPlan {
  if (!record(value, ['version', 'datasetId', 'planId', 'jobId', 'viewRevision', 'journalSequence', 'scope', 'range', 'state', 'createdAt', 'readyAt', 'expiresAt', 'policyRevision', 'planHash', 'contextFingerprint', 'journalFingerprint', 'summary', 'items', 'issues', 'resourceSummary', 'undoOf', 'recoveryOf', 'recoveryChoices'])
    || value.version !== 1 || !isLocalSourceWritesDatasetId(value.datasetId) || ![value.planId, value.jobId].every(isCollectionId) || ![value.viewRevision, value.journalSequence, value.policyRevision].every(isLocalCatalogRevision)
    || value.scope !== 'SOURCE_FILES' || !range(value.range) || !state(value.state) || !date(value.createdAt) || !label(value.summary) || !isLocalSourceWritesHash(value.journalFingerprint)
    || !array(value.items)
    || !array(value.issues) || !value.issues.every(isLocalSourceWritesIssue) || new Set(value.issues).size !== value.issues.length
    || !record(value.resourceSummary, ['resources', 'sharedTargets', 'backupBytes', 'spaceVerified', 'protection']) || !integer(value.resourceSummary.resources, 0, 2048) || !integer(value.resourceSummary.sharedTargets, 0, 200)
    || !(value.resourceSummary.backupBytes === null || isLocalExactInteger(value.resourceSummary.backupBytes)) || typeof value.resourceSummary.spaceVerified !== 'boolean' || !values(value.resourceSummary.protection, ['verified', 'unknown', 'blocked'] as const)
    || !(value.undoOf === null || isCollectionId(value.undoOf) && value.undoOf !== value.planId) || !(value.recoveryOf === null || isCollectionId(value.recoveryOf) && value.recoveryOf !== value.planId) || value.undoOf !== null && value.recoveryOf !== null
    || !array(value.recoveryChoices)) return false;
  const inverseOrigin = typeof value.undoOf === 'string' ? value.undoOf : typeof value.recoveryOf === 'string' ? value.recoveryOf : null;
  const selectedRange = value.range;
  if (!value.items.every((entry): entry is LocalSourceWritesItem => item(entry, inverseOrigin, selectedRange))
    || new Set(value.items.map(i => i.operationId)).size !== value.items.length || new Set(value.items.map(i => i.resourceRef)).size !== value.items.length
    || new Set(value.items.map(i => i.assetId)).size !== value.items.length || new Set(value.items.map(i => i.trackId)).size !== value.items.length) return false;
  const restoredItems = value.items.filter(i => i.restoration !== undefined);
  if (new Set(restoredItems.map(i => i.restoration!.originOperationId)).size !== restoredItems.length) return false;
  const captured = value as unknown as LocalSourceWritesPlan;
  if (!value.recoveryChoices.every(choice => recoveryChoice(choice, captured)) || new Set(value.recoveryChoices.map(c => (c as Data).choiceId)).size !== value.recoveryChoices.length) return false;
  const ready = value.readyAt !== null || value.expiresAt !== null || value.planHash !== null || value.contextFingerprint !== null;
  if (ready && (!date(value.readyAt) || !date(value.expiresAt) || !isLocalSourceWritesHash(value.planHash) || !isLocalSourceWritesHash(value.contextFingerprint) || Date.parse(value.readyAt) < Date.parse(value.createdAt) || Date.parse(value.expiresAt) - Date.parse(value.readyAt) !== LOCAL_SOURCE_WRITES_BUDGET.previewTtlMs)) return false;
  if (['READY', 'QUEUED', 'RUNNING', 'COMPLETED', 'PARTIAL', 'RECOVERY_REQUIRED'].includes(value.state) && (!ready || !value.items.length)) return false;
  if (value.state === 'PREVIEWING' && ready || value.recoveryChoices.length && value.state !== 'RECOVERY_REQUIRED') return false;
  if (!value.items.every(i => value.range === 'TAGS' ? i.artwork === null && i.changes.length > 0
    : i.changes.length === 0 && (i.restoration !== undefined ? i.artwork === null : value.undoOf === null && i.artwork !== null && i.artwork.slot === (value.range === 'EMBEDDED_COVER' ? 'front' : 'directory')))) return false;
  if (!value.items.every(i => i.state !== 'applied' || (value.range === 'DIRECTORY_COVER'
    ? i.currentFileRevision === i.expectedFileRevision && i.verification.audio === 'not-applicable' && i.verification.unselectedMetadata === 'not-applicable'
    : i.profile !== null && BigInt(i.currentFileRevision) === BigInt(i.expectedFileRevision) + 1n && i.verification.audio === 'verified' && i.verification.unselectedMetadata === 'verified'))) return false;
  if (value.state === 'READY' && (value.issues.length > 0 || !value.resourceSummary.spaceVerified || value.resourceSummary.protection !== 'verified' || value.resourceSummary.resources < value.items.length || !value.items.every(i => i.state === 'planned' && i.issue === null && (value.range === 'DIRECTORY_COVER' || i.profile !== null)))) return false;
  if (value.state === 'COMPLETED' && (value.issues.length || !value.items.every(i => i.state === 'applied'))) return false;
  if (value.state === 'CANCELLED' && value.items.some(i => i.state === 'applied' || i.state === 'unknown')) return false;
  return localSourceWritesUtf8Bytes(localSourceWritesCanonical(value)) <= LOCAL_SOURCE_WRITES_BUDGET.planBytes;
}
function context(value: unknown): value is LocalSourceWritesContext {
  if (!record(value, ['datasetId', 'policy', 'capabilities', 'materials']) || !isLocalSourceWritesDatasetId(value.datasetId) || !policy(value.policy) || !record(value.capabilities, ['publisherProfile', 'formats', 'directoryCover'])
    || value.capabilities.publisherProfile !== 'NONATOMIC_QUARANTINE_LINK_V1' || !array(value.capabilities.formats, 2) || !array(value.materials)) return false;
  const formats = value.capabilities.formats;
  if (!formats.every(f => record(f, ['profile', 'qualified', 'tags', 'embeddedCover', 'fields', 'issue']) && profile(f.profile) && typeof f.qualified === 'boolean' && typeof f.tags === 'boolean' && typeof f.embeddedCover === 'boolean'
    && array(f.fields, 6) && f.fields.every(field => values(field, LOCAL_SOURCE_WRITES_FIELDS)) && new Set(f.fields).size === f.fields.length && issue(f.issue)
    && (f.qualified ? f.issue === null : f.issue !== null && f.tags === false && f.embeddedCover === false && f.fields.length === 0) && (!f.tags || f.fields.length > 0)) || new Set(formats.map(f => (f as Data).profile)).size !== formats.length) return false;
  const directory = value.capabilities.directoryCover;
  if (!record(directory, ['qualified', 'issue']) || typeof directory.qualified !== 'boolean' || !issue(directory.issue) || (directory.qualified ? directory.issue !== null : directory.issue === null)) return false;
  return value.materials.every(m => record(m, ['editionId', 'selectionId', 'selectionRevision', 'candidateId', 'availability', 'contentRef', 'originalSha256', 'issue']) && [m.editionId, m.selectionId].every(isCollectionId) && isLocalCatalogRevision(m.selectionRevision)
    && (m.candidateId === null || isCollectionId(m.candidateId)) && issue(m.issue) && (m.availability === 'available' ? isCollectionId(m.candidateId) && isCollectionId(m.contentRef) && isLocalSourceWritesHash(m.originalSha256) && m.issue === null : (m.availability === 'reacquire-required' || m.availability === 'unavailable') && m.contentRef === null && m.originalSha256 === null && (m.availability !== 'unavailable' || m.issue !== null)))
    && new Set(value.materials.map(m => (m as Data).editionId)).size === value.materials.length;
}
function getResult(value: unknown): value is LocalSourceWritesGetResult {
  if (!record(value, ['datasetId', 'kind'], ['context', 'plan', 'issue', 'commandId', 'expectedCommand', 'requestFingerprint', 'receipt']) || !isLocalSourceWritesDatasetId(value.datasetId)) return false;
  if (value.kind === 'context') return record(value, ['datasetId', 'kind', 'context']) && context(value.context) && value.context.datasetId === value.datasetId;
  if (value.kind === 'plan') return record(value, ['datasetId', 'kind', 'plan', 'issue']) && (value.plan === null ? value.issue === 'NOT_FOUND' : value.issue === null && plan(value.plan) && value.plan.datasetId === value.datasetId);
  return value.kind === 'command' && record(value, ['datasetId', 'kind', 'commandId', 'expectedCommand', 'requestFingerprint', 'receipt', 'issue']) && isCollectionId(value.commandId) && receiptCommand(value.expectedCommand) && isLocalSourceWritesHash(value.requestFingerprint)
    && (value.receipt === null ? value.issue === 'NOT_FOUND' : value.issue === null && receipt(value.receipt) && value.receipt.datasetId === value.datasetId && value.receipt.commandId === value.commandId && value.receipt.command === value.expectedCommand && value.receipt.requestFingerprint === value.requestFingerprint);
}
function history(value: unknown): value is LocalSourceWritesHistoryPage {
  if (!record(value, ['datasetId', 'kind', 'snapshotFingerprint', 'limit', 'items', 'cursor', 'hasMore'], ['range', 'planId']) || !isLocalSourceWritesDatasetId(value.datasetId) || !isLocalSourceWritesHash(value.snapshotFingerprint)
    || !integer(value.limit, 1, 100) || !array(value.items, value.limit) || !cursor(value.cursor) || typeof value.hasMore !== 'boolean' || value.hasMore !== (value.cursor !== null)) return false;
  if (value.kind === 'plans') return record(value, ['datasetId', 'kind', 'range', 'snapshotFingerprint', 'limit', 'items', 'cursor', 'hasMore']) && (value.range === 'all' || range(value.range))
    && value.items.every(p => record(p, ['planId', 'jobId', 'viewRevision', 'range', 'state', 'createdAt', 'operations', 'issue']) && [p.planId, p.jobId].every(isCollectionId) && isLocalCatalogRevision(p.viewRevision) && range(p.range) && (value.range === 'all' || p.range === value.range) && state(p.state) && date(p.createdAt) && integer(p.operations, 0, 100) && issue(p.issue)) && new Set(value.items.map(p => (p as Data).planId)).size === value.items.length;
  return value.kind === 'events' && record(value, ['datasetId', 'kind', 'planId', 'snapshotFingerprint', 'limit', 'items', 'cursor', 'hasMore']) && isCollectionId(value.planId)
    && value.items.every(e => record(e, ['eventId', 'planId', 'journalSequence', 'operationId', 'phase', 'occurredAt', 'label', 'issue']) && isCollectionId(e.eventId) && e.planId === value.planId && isLocalCatalogRevision(e.journalSequence) && (e.operationId === null || isCollectionId(e.operationId)) && phase(e.phase) && date(e.occurredAt) && label(e.label) && issue(e.issue)) && new Set(value.items.map(e => (e as Data).eventId)).size === value.items.length;
}

export const isLocalSourceWritesCommand = (value: unknown): value is LocalSourceWritesCommand => values(value, LOCAL_SOURCE_WRITES_COMMANDS);
export const isLocalSourceWritesOutboxCommand = (value: unknown): value is LocalSourceWritesOutboxCommand => values(value, LOCAL_SOURCE_WRITES_OUTBOX_COMMANDS);
export function isLocalSourceWritesCommandPayload<C extends LocalSourceWritesCommand>(command: C, input: unknown): input is LocalSourceWritesCommandPayloads[C] {
  try {
    const value = localSourceWritesDataSnapshot(input, LOCAL_SOURCE_WRITES_BUDGET.requestBytes, LOCAL_SOURCE_WRITES_BUDGET.requestNodes);
    if (!record(value, ['datasetId'], ['commandId', 'intent', 'selector', 'cursor', 'limit', 'planId', 'expectedViewRevision', 'scope', 'range', 'planHash', 'contextFingerprint', 'operationIds', 'journalFingerprint', 'expectedPolicyRevision', 'enabled'])) return false;
    if (!isLocalSourceWritesDatasetId(value.datasetId)) return false;
    switch (command) {
      case 'localSourceWrites.preview': return record(value, ['datasetId', 'commandId', 'intent']) && isCollectionId(value.commandId) && intent(value.intent);
      case 'localSourceWrites.confirm': return record(value, ['datasetId', 'commandId', 'planId', 'expectedViewRevision', 'scope', 'range', 'planHash', 'contextFingerprint']) && [value.commandId, value.planId].every(isCollectionId) && isLocalCatalogRevision(value.expectedViewRevision) && value.scope === 'SOURCE_FILES' && range(value.range) && isLocalSourceWritesHash(value.planHash) && isLocalSourceWritesHash(value.contextFingerprint);
      case 'localSourceWrites.undo': return record(value, ['datasetId', 'commandId', 'planId', 'expectedViewRevision', 'operationIds', 'journalFingerprint']) && [value.commandId, value.planId].every(isCollectionId) && isLocalCatalogRevision(value.expectedViewRevision) && ids(value.operationIds) && isLocalSourceWritesHash(value.journalFingerprint);
      case 'localSourceWrites.cancel': return record(value, ['datasetId', 'commandId', 'planId', 'expectedViewRevision']) && [value.commandId, value.planId].every(isCollectionId) && isLocalCatalogRevision(value.expectedViewRevision);
      case 'localSourceWrites.setPolicy': return record(value, ['datasetId', 'commandId', 'expectedPolicyRevision', 'enabled']) && isCollectionId(value.commandId) && isLocalCatalogRevision(value.expectedPolicyRevision) && typeof value.enabled === 'boolean';
      case 'localSourceWrites.get': {
        if (!record(value, ['datasetId', 'selector'])) return false;
        const selector = value.selector;
        return record(selector, ['kind', 'target']) && selector.kind === 'context' && (selector.target === null || target(selector.target))
          || record(selector, ['kind', 'planId']) && selector.kind === 'plan' && isCollectionId(selector.planId)
          || record(selector, ['kind', 'commandId', 'expectedCommand', 'requestFingerprint']) && selector.kind === 'command' && isCollectionId(selector.commandId) && receiptCommand(selector.expectedCommand) && isLocalSourceWritesHash(selector.requestFingerprint);
      }
      case 'localSourceWrites.history': {
        if (!record(value, ['datasetId', 'selector', 'cursor', 'limit']) || !cursor(value.cursor) || !integer(value.limit, 1, 100)) return false;
        const selector = value.selector;
        return record(selector, ['kind', 'range']) && selector.kind === 'plans' && (selector.range === 'all' || range(selector.range)) || record(selector, ['kind', 'planId']) && selector.kind === 'events' && isCollectionId(selector.planId);
      }
      default: return false;
    }
  } catch { return false; }
}
export function isLocalSourceWritesCommandResult<C extends LocalSourceWritesCommand>(command: C, input: unknown): input is LocalSourceWritesCommandResults[C] {
  try {
    const value = localSourceWritesDataSnapshot(input, LOCAL_SOURCE_WRITES_BUDGET.planBytes, LOCAL_SOURCE_WRITES_BUDGET.publicNodes);
    return command === 'localSourceWrites.get' ? getResult(value) : command === 'localSourceWrites.history' ? history(value) : isLocalSourceWritesCommand(command) && receipt(value) && value.command === command;
  } catch { return false; }
}
export function isLocalSourceWritesPlan(input: unknown): input is LocalSourceWritesPlan { try { return plan(localSourceWritesDataSnapshot(input)); } catch { return false; } }
export function isLocalSourceWritesReceipt(input: unknown): input is LocalSourceWritesReceipt { try { return receipt(localSourceWritesDataSnapshot(input, 16384)); } catch { return false; } }
export function isLocalSourceWritesPolicy(input: unknown): input is LocalSourceWritesPolicy { try { return policy(localSourceWritesDataSnapshot(input, 16384)); } catch { return false; } }
export function isLocalSourceWritesIntent(input: unknown): input is LocalSourceWritesIntent { try { return intent(localSourceWritesDataSnapshot(input, 65536, 8192)); } catch { return false; } }
/** Main 与 Owner 对同一纯快照计算原请求指纹；不能使用 Outbox 的另一指纹域替代。 */
export function localSourceWritesRequestCanonical<C extends LocalSourceWritesCommand>(command: C, input: LocalSourceWritesCommandPayloads[C]): string {
  const payload = localSourceWritesDataSnapshot(input, LOCAL_SOURCE_WRITES_BUDGET.requestBytes, LOCAL_SOURCE_WRITES_BUDGET.requestNodes);
  if (!isLocalSourceWritesCommandPayload(command, payload)) throw new Error('源写逻辑请求无效。');
  return localSourceWritesCanonical({ datasetId: (payload as unknown as Data).datasetId, command, payload }, LOCAL_SOURCE_WRITES_BUDGET.requestBytes, LOCAL_SOURCE_WRITES_BUDGET.requestNodes);
}
export interface LocalSourceWritesCompletePlanCapture { body: OrganizerFrozenBody; context: unknown; projection: LocalSourceWritesPlan }
/** 私有正文、完整 context 与公开投影联合限额；此检查不验证 Hash、许可或文件真实性。 */
export function localSourceWritesCompletePlanWithinBudget(input: unknown): input is LocalSourceWritesCompletePlanCapture {
  try {
    // 原冻结正文允许 100 个根映射；公开 DTO 的闭集记录仍保持 32 键上限。
    const captured = localSourceWritesDataSnapshot(input, LOCAL_SOURCE_WRITES_BUDGET.planBytes, 65536, 2048, 100);
    if (!record(captured, ['body', 'context', 'projection']) || !isOrganizerFrozenBody(captured.body) || captured.body.scope !== 'SOURCE_FILES' || !plan(captured.projection)
      || captured.body.created_at !== captured.projection.readyAt || captured.body.operations.length !== captured.projection.items.length) return false;
    const body = captured.body, projection = captured.projection;
    return body.operations.every((operation, index) => {
      const selected = projection.items[index]!;
      if (operation.operation_id !== selected.operationId || operation.target_asset_id !== selected.assetId || operation.expected_asset_revision !== selected.expectedFileRevision
        || body.root_mapping_revisions[operation.root_id] !== selected.expectedRootRevision || operation.kind !== (projection.range === 'TAGS' ? 'WRITE_TAGS' : 'WRITE_COVER')) return false;
      const patch: Record<string, unknown> = {};
      if (projection.range === 'TAGS') {
        const names: Record<LocalSourceWritesField, string> = { title: 'title', artist: 'artists', album: 'album', year: 'date', disc: 'disc_number', track: 'track_number' };
        for (const change of selected.changes) patch[names[change.field]] = change.action === 'remove' ? null : change.field === 'artist' ? change.after : change.field === 'disc' || change.field === 'track' ? Number(change.after![0]) : change.after![0];
      } else patch.artwork_selection_id = selected.restoration !== undefined ? null : selected.artwork!.selectionId;
      return localSourceWritesCanonical(operation.field_patch) === localSourceWritesCanonical(patch);
    });
  } catch { return false; }
}
/** 新行预算计算覆盖所有 TEXT，不只计算 request/result，也不提高旧 catalog 上限。 */
export function localSourceWritesJournalTextWithinBudget(input: unknown, kind: 'header' | 'item' | 'phase'): boolean {
  try {
    if (!['header', 'item', 'phase'].includes(kind)) return false;
    const row = localSourceWritesDataSnapshot(input, 131072);
    return record(row, ['command_id', 'fingerprint', 'operation', 'request', 'result', 'created_at']) && Object.values(row).every(value => typeof value === 'string')
      && Object.values(row).reduce<number>((bytes, value) => bytes + localSourceWritesUtf8Bytes(value as string), 0) <= (kind === 'phase' ? LOCAL_SOURCE_WRITES_BUDGET.phaseAllTextBytes : LOCAL_SOURCE_WRITES_BUDGET.headerAndItemAllTextBytes);
  } catch { return false; }
}
