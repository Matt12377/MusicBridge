import { isCollectionId, isPhysicalId, isImportedCollectionDescriptor, isCollectionPhotoImage, type CollectionDescriptor, type CollectionCopy, type CollectionPhotoImage } from './collection.js';
import { isRecordingAttempt, type RecordingAttempt, type RecordingAttemptStatus } from './recording-attempts.js';
import { isRecordingPlanVersion, type RecordingPlanVersion } from './recording-plans.js';
import { isMediaPlan, type MediaPlan } from './media-planning.js';
import type { Page, PageRequest } from './library.js';

export const MAX_RECORDING_RECORD_PAGE_SIZE = 25;
export const MAX_RECORDING_RECORD_METADATA_BYTES = 134_217_728;
export const MAX_RECORDING_RECORD_VISUAL_BYTES = 1_048_576;
export const MAX_RECORDING_RECORD_VISUAL_OBJECT_BYTES = 1_073_741_824;
export const MAX_RECORDING_RECORD_VISUALS = 24;

export type CompletedRecordingAttempt = RecordingAttempt & {
  status:'completed'; phase:'finished'; softwarePlaybackComplete:true;
  endedAt:string; physicalRecordingConfirmedAt:string; finalVerificationCompleteAt:string;
};
export type RecordingMediaSnapshot = {
  modelId:string; lotId:string; skuId:string;
  lengthMinutes:number|null; origin:CollectionCopy['origin'];
} & ({snapshotSource:'completion';descriptor:CollectionDescriptor}
   | {snapshotSource:'legacy-plan-only';descriptor?:never});
export interface RecordingVisualAttachment {
  id:string; recordingId:string; sourcePhotoId:string; physicalId:string;
  role:'photo'; source:'physical-photo'; sha256:string; size:number;
  mimeType:'image/jpeg'; width:number; height:number;
}
export interface RecordingVisualAbsence { state:'not-captured'; reason:'not-provided'|'not-implemented'|'not-applicable' }
export interface RecordingVisualSnapshot {
  artwork:RecordingVisualAbsence; jCard:RecordingVisualAbsence;
  photos:RecordingVisualAbsence|{state:'captured';attachments:readonly RecordingVisualAttachment[]};
}
export interface RecordingRecord {
  schemaVersion:1; id:string; createdAt:string; contentHash:string;
  completion:CompletedRecordingAttempt; media:RecordingMediaSnapshot; visuals:RecordingVisualSnapshot;
}
export interface RecordingRecordSummary {
  id:string; physicalId:string; attemptId:string; planVersionId:string;
  completedAt:string; title:string; format:'cassette'|'dat'; modelId:string;
  mediaBrand:string; mediaSeries:string; artist?:string;
}
export interface RecordingRecordDetail { record:RecordingRecord; plan:RecordingPlanVersion; current:PhysicalRecordingState }
export interface RecordingRecordFilter {
  query?:string; physicalId?:string; masterVersionId?:string; track?:string; artist?:string; master?:string;
  mediaBrand?:string; mediaSeries?:string; equipment?:string; completedFrom?:string; completedTo?:string;
}
export interface ListRecordingRecordsRequest { page:PageRequest; filter?:RecordingRecordFilter }
export interface RecordingRecordIdRequest { id:string }
export interface RecordingVisualRequest { recordingId:string; attachmentId:string }
export interface RecordingVisualResult { recordingId:string; attachmentId:string; sha256:string; image:CollectionPhotoImage }
export interface RecordingAttemptHead { id:string; revision:number; status:RecordingAttemptStatus }
export interface RecordingAttemptRevision { id:string; revision:number }
export type PhysicalRecordingKnowledge =
 | {state:'confirmed-recording';recordingId:string;confirmedAt:string;evidence:
     {kind:'completed-attempt';attemptId:string;revision:number}|{kind:'manual-disposition';dispositionId:string}}
 | {state:'unknown';reason:'unverified'|'new-attempt'|'manual-unknown';since?:string}
 | {state:'erased';confirmedAt:string;dispositionId:string};
export interface PhysicalRecordingState {
  physicalId:string; revision:number; physicalRevision:number; knowledge:PhysicalRecordingKnowledge;
  latestAttempt:RecordingAttemptHead|null; activeRerecordPermit:RerecordPermit|null;
}
export type PhysicalRecordingDispositionIntent =
 | {action:'mark-content-unknown'}
 | {action:'confirm-current-recording';recordingId:string}
 | {action:'prepare-rerecord';mediaPlanId:string;expectedMediaPlanRevision:number}
 | {action:'cancel-rerecord';permitId:string}
 | {action:'confirm-erased'};
export interface PreviewPhysicalRecordingDispositionRequest {
  physicalId:string;expectedPhysicalRevision:number;expectedContentRevision:number;
  expectedAttempt:RecordingAttemptRevision|null;intent:PhysicalRecordingDispositionIntent;
}
export type PhysicalRecordingDispositionEffect = 'content-unknown'|'content-confirmed'|'rerecord-reserved'|'rerecord-cancelled'|'erased-confirmed';
export interface PhysicalRecordingDispositionProposal {
  request:PreviewPhysicalRecordingDispositionRequest;checkedAt:string;proposalFingerprint:string;
  before:PhysicalRecordingState;effect:PhysicalRecordingDispositionEffect;outputWillStart:false;
}
export interface ApplyPhysicalRecordingDispositionRequest extends PreviewPhysicalRecordingDispositionRequest {
  commandId:string;proposalFingerprint:string;userConfirmed:true;
}
export interface PhysicalRecordingDisposition {
  id:string;physicalId:string;createdAt:string;intent:PhysicalRecordingDispositionIntent;
  beforeContentRevision:number;afterContentRevision:number;beforePhysicalRevision:number;afterPhysicalRevision:number;
  observedAttempt:RecordingAttemptRevision|null;permitId?:string;
}
export interface ApplyPhysicalRecordingDispositionResult {
  disposition:PhysicalRecordingDisposition;state:PhysicalRecordingState;mediaPlan?:MediaPlan;
}
export type RerecordPermit = {
  id:string;physicalId:string;dispositionId:string;createdAt:string;
  mediaPlanId:string;mediaPlanRevision:number;contentRevision:number;physicalRevision:number;
  precedingAttempt:RecordingAttemptRevision|null;
} & (
  {state:'available'}
 | {state:'consumed';attemptId:string;planVersionId:string;planContentHash:string;consumedAt:string}
 | {state:'revoked';dispositionIdOfRevocation:string;revokedAt:string}
);
export interface PhysicalRecordingHistoryRequest { physicalId:string;page:PageRequest }
export type PhysicalRecordingHistoryItem =
 | {kind:'attempt';id:string;createdAt:string;attempt:RecordingAttempt;recordingId?:string}
 | {kind:'disposition';id:string;createdAt:string;disposition:PhysicalRecordingDisposition};
export interface PhysicalRecordingHistory { state:PhysicalRecordingState;entries:Page<PhysicalRecordingHistoryItem> }
export type RecordingRecordsPage = Page<RecordingRecordSummary>;
export interface RecordingRecordsPublicApi {
  listRecordingRecords(request:ListRecordingRecordsRequest):Promise<RecordingRecordsPage>;
  getRecordingRecord(id:string):Promise<{record:RecordingRecordDetail|null}>;
  getRecordingRecordVisual(request:RecordingVisualRequest):Promise<RecordingVisualResult>;
  getPhysicalRecordingHistory(request:PhysicalRecordingHistoryRequest):Promise<PhysicalRecordingHistory>;
  previewPhysicalRecordingDisposition(request:PreviewPhysicalRecordingDispositionRequest):Promise<PhysicalRecordingDispositionProposal>;
  applyPhysicalRecordingDisposition(request:ApplyPhysicalRecordingDispositionRequest):Promise<ApplyPhysicalRecordingDispositionResult>;
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(v).every(k => allowed.includes(k));
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const uuid = (v: unknown): v is string => typeof v === 'string' && v.length === 36 && isCollectionId(v);
const physical = (v: unknown): v is string => typeof v === 'string' && v.trim() === v && isPhysicalId(v);
const hash = (v: unknown): v is string => typeof v === 'string' && v.length === 64 && /^[a-f0-9]{64}$/u.test(v);
const date = (v: unknown): v is string => typeof v === 'string' && v.length === 24 && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const text = (v: unknown, empty = false): v is string => typeof v === 'string' && v.length <= 240 && (empty || v.trim().length > 0) && !/[\u0000-\u001f\u007f]/u.test(v);
const page = (v: unknown): v is PageRequest => record(v) && keys(v, ['offset', 'limit']) && integer(v.offset, 0, 1_000_000) && integer(v.limit, 1, MAX_RECORDING_RECORD_PAGE_SIZE);
const attemptRevision = (v: unknown): v is RecordingAttemptRevision => record(v) && keys(v, ['id', 'revision']) && uuid(v.id) && integer(v.revision, 1);
const attemptHead = (v: unknown): v is RecordingAttemptHead => record(v) && keys(v, ['id', 'revision', 'status']) && uuid(v.id) && integer(v.revision, 1) && ['in-progress', 'completed', 'aborted', 'failed', 'interrupted'].includes(String(v.status));
const sameAttempt = (a: RecordingAttemptRevision | null, b: RecordingAttemptRevision | null): boolean => a === null ? b === null : b !== null && a.id === b.id && a.revision === b.revision;
const sameFormat = (id: string, format: 'cassette' | 'dat'): boolean => id.startsWith(format === 'cassette' ? 'MB-C-' : 'MB-D-');
function boundedPage<T>(v: unknown, item: (v: unknown) => v is T, identity: (v: T) => string): v is Page<T> {
  if (!record(v) || !keys(v, ['items', 'offset', 'limit', 'total', 'hasMore']) || !page({ offset: v.offset, limit: v.limit }) || !integer(v.total)
    || !Array.isArray(v.items) || v.items.length > MAX_RECORDING_RECORD_PAGE_SIZE || v.items.length > Number(v.limit) || !v.items.every(item)) return false;
  return v.items.length <= Math.max(0, v.total - Number(v.offset)) && new Set(v.items.map(identity)).size === v.items.length && v.hasMore === (Number(v.offset) + v.items.length < v.total);
}
const absence = (v: unknown): v is RecordingVisualAbsence => record(v) && keys(v, ['state', 'reason']) && v.state === 'not-captured' && ['not-provided', 'not-implemented', 'not-applicable'].includes(String(v.reason));
export function isRecordingVisualAttachment(v: unknown): v is RecordingVisualAttachment {
  return record(v) && keys(v, ['id', 'recordingId', 'sourcePhotoId', 'physicalId', 'role', 'source', 'sha256', 'size', 'mimeType', 'width', 'height'])
    && uuid(v.id) && uuid(v.recordingId) && uuid(v.sourcePhotoId) && physical(v.physicalId) && v.role === 'photo' && v.source === 'physical-photo'
    && hash(v.sha256) && integer(v.size, 4, MAX_RECORDING_RECORD_VISUAL_BYTES) && v.mimeType === 'image/jpeg' && integer(v.width, 1, 1200) && integer(v.height, 1, 1200);
}
function visuals(v: unknown, recordingId: string, physicalId: string, legacy: boolean): v is RecordingVisualSnapshot {
  if (!record(v) || !keys(v, ['artwork', 'jCard', 'photos']) || !absence(v.artwork) || !absence(v.jCard)) return false;
  if (legacy) return v.artwork.reason === 'not-provided' && v.jCard.reason === 'not-provided' && absence(v.photos) && v.photos.reason === 'not-provided';
  if (absence(v.photos)) return true;
  if (!record(v.photos) || !keys(v.photos, ['state', 'attachments']) || v.photos.state !== 'captured' || !Array.isArray(v.photos.attachments)
    || v.photos.attachments.length < 1 || v.photos.attachments.length > MAX_RECORDING_RECORD_VISUALS || !v.photos.attachments.every(isRecordingVisualAttachment)) return false;
  const items = v.photos.attachments;
  return items.every(item => item.recordingId === recordingId && item.physicalId === physicalId) && new Set(items.map(item => item.id)).size === items.length
    && new Set(items.map(item => item.sourcePhotoId)).size === items.length;
}
function media(v: unknown): v is RecordingMediaSnapshot {
  return record(v) && keys(v, ['modelId', 'lotId', 'skuId', 'lengthMinutes', 'origin', 'snapshotSource', 'descriptor']) && uuid(v.modelId) && uuid(v.lotId) && uuid(v.skuId)
    && (v.lengthMinutes === null || integer(v.lengthMinutes, 1, 360)) && ['blank-pool', 'legacy-registration', 'unclassified'].includes(String(v.origin))
    && (v.snapshotSource === 'completion' ? isImportedCollectionDescriptor(v.descriptor) : v.snapshotSource === 'legacy-plan-only' && v.descriptor === undefined);
}
/** 结构有效只表示完成档案格式；不能替代受信任的完成事件或新的输出准入。 */
export function isRecordingRecord(v: unknown): v is RecordingRecord {
  if (!record(v) || !keys(v, ['schemaVersion', 'id', 'createdAt', 'contentHash', 'completion', 'media', 'visuals']) || v.schemaVersion !== 1 || !uuid(v.id) || !date(v.createdAt) || !hash(v.contentHash)
    || !isRecordingAttempt(v.completion) || v.completion.status !== 'completed' || !v.completion.endedAt || v.createdAt < v.completion.endedAt || !media(v.media)) return false;
  const format = v.completion.sides[0]?.side === 'Program' ? 'dat' : 'cassette';
  return sameFormat(v.completion.physicalId, format) && (v.media.snapshotSource === 'legacy-plan-only' || v.media.descriptor.format === format)
    && visuals(v.visuals, v.id, v.completion.physicalId, v.media.snapshotSource === 'legacy-plan-only');
}
export function isRecordingRecordSummary(v: unknown): v is RecordingRecordSummary {
  return record(v) && keys(v, ['id', 'physicalId', 'attemptId', 'planVersionId', 'completedAt', 'title', 'format', 'modelId', 'mediaBrand', 'mediaSeries', 'artist'])
    && ['id', 'attemptId', 'planVersionId', 'modelId'].every(k => uuid(v[k])) && physical(v.physicalId) && date(v.completedAt) && text(v.title)
    && (v.format === 'cassette' || v.format === 'dat') && sameFormat(v.physicalId, v.format) && text(v.mediaBrand, true) && text(v.mediaSeries, true) && (v.artist === undefined || text(v.artist));
}
export function isRecordingRecordDetail(v: unknown): v is RecordingRecordDetail {
  if (!record(v) || !keys(v, ['record', 'plan', 'current']) || !isRecordingRecord(v.record) || !isRecordingPlanVersion(v.plan) || !isPhysicalRecordingState(v.current)) return false;
  const { completion, media } = v.record, plan = v.plan;
  return completion.planVersionId === plan.id && completion.planContentHash === plan.contentHash && completion.draftId === plan.draftId && completion.executionAssetId === plan.execution.assetId
    && completion.physicalId === plan.physicalCopy.physicalId && v.current.physicalId === completion.physicalId && media.modelId === plan.layout.reservation.modelId
    && media.lotId === plan.physicalCopy.lotId && media.skuId === plan.physicalCopy.skuId && media.origin === plan.physicalCopy.origin && media.lengthMinutes === plan.physicalCopy.lengthMinutes
    && completion.sides.length === plan.execution.audio.length && completion.sides.every((side, index) => {
      const audio = plan.execution.audio[index]!;
      return side.side === audio.recipe.side && side.frameCount === audio.audio.frameCount && side.recipeHash === audio.recipeHash && side.audioSha256 === audio.audio.sha256 && side.pcmSha256 === audio.audio.pcmSha256;
    });
}
export function isRecordingRecordsPage(v: unknown): v is RecordingRecordsPage { return boundedPage(v, isRecordingRecordSummary, item => item.id); }
export function isListRecordingRecordsRequest(v: unknown): v is ListRecordingRecordsRequest {
  if (!record(v) || !keys(v, ['page', 'filter']) || !page(v.page)) return false;
  if (v.filter === undefined) return true;
  const f = v.filter;
  return record(f) && keys(f, ['query', 'physicalId', 'masterVersionId', 'track', 'artist', 'master', 'mediaBrand', 'mediaSeries', 'equipment', 'completedFrom', 'completedTo'])
    && ['query', 'track', 'artist', 'master', 'mediaBrand', 'mediaSeries', 'equipment'].every(k => f[k] === undefined || text(f[k], true))
    && (f.physicalId === undefined || physical(f.physicalId)) && (f.masterVersionId === undefined || uuid(f.masterVersionId))
    && (f.completedFrom === undefined || date(f.completedFrom)) && (f.completedTo === undefined || date(f.completedTo))
    && (f.completedFrom === undefined || f.completedTo === undefined || String(f.completedFrom) <= String(f.completedTo));
}
export function isRecordingRecordIdRequest(v: unknown): v is RecordingRecordIdRequest { return record(v) && keys(v, ['id']) && uuid(v.id); }
export function isRecordingVisualRequest(v: unknown): v is RecordingVisualRequest { return record(v) && keys(v, ['recordingId', 'attachmentId']) && uuid(v.recordingId) && uuid(v.attachmentId); }
export function isRecordingVisualResult(v: unknown): v is RecordingVisualResult { return record(v) && keys(v, ['recordingId', 'attachmentId', 'sha256', 'image']) && uuid(v.recordingId) && uuid(v.attachmentId) && hash(v.sha256) && isCollectionPhotoImage(v.image); }
function knowledge(v: unknown): v is PhysicalRecordingKnowledge {
  if (!record(v)) return false;
  if (v.state === 'unknown') return keys(v, ['state', 'reason', 'since']) && ['unverified', 'new-attempt', 'manual-unknown'].includes(String(v.reason)) && (v.since === undefined || date(v.since));
  if (v.state === 'erased') return keys(v, ['state', 'confirmedAt', 'dispositionId']) && date(v.confirmedAt) && uuid(v.dispositionId);
  if (v.state !== 'confirmed-recording' || !keys(v, ['state', 'recordingId', 'confirmedAt', 'evidence']) || !uuid(v.recordingId) || !date(v.confirmedAt) || !record(v.evidence)) return false;
  const e = v.evidence;
  return e.kind === 'completed-attempt' ? keys(e, ['kind', 'attemptId', 'revision']) && uuid(e.attemptId) && integer(e.revision, 1)
    : e.kind === 'manual-disposition' && keys(e, ['kind', 'dispositionId']) && uuid(e.dispositionId);
}
export function isRerecordPermit(v: unknown): v is RerecordPermit {
  if (!record(v) || !uuid(v.id) || !physical(v.physicalId) || !uuid(v.dispositionId) || !date(v.createdAt) || !uuid(v.mediaPlanId)
    || !integer(v.mediaPlanRevision, 1) || !integer(v.contentRevision, 1) || !integer(v.physicalRevision, 1) || !(v.precedingAttempt === null || attemptRevision(v.precedingAttempt))) return false;
  const common = ['id', 'physicalId', 'dispositionId', 'createdAt', 'mediaPlanId', 'mediaPlanRevision', 'contentRevision', 'physicalRevision', 'precedingAttempt', 'state'];
  if (v.state === 'available') return keys(v, common);
  if (v.state === 'consumed') return keys(v, [...common, 'attemptId', 'planVersionId', 'planContentHash', 'consumedAt']) && uuid(v.attemptId) && uuid(v.planVersionId) && hash(v.planContentHash) && date(v.consumedAt) && v.consumedAt >= v.createdAt && (!v.precedingAttempt || v.attemptId !== v.precedingAttempt.id);
  return v.state === 'revoked' && keys(v, [...common, 'dispositionIdOfRevocation', 'revokedAt']) && uuid(v.dispositionIdOfRevocation) && v.dispositionIdOfRevocation !== v.dispositionId && date(v.revokedAt) && v.revokedAt >= v.createdAt;
}
export function isPhysicalRecordingState(v: unknown): v is PhysicalRecordingState {
  if (!record(v) || !keys(v, ['physicalId', 'revision', 'physicalRevision', 'knowledge', 'latestAttempt', 'activeRerecordPermit']) || !physical(v.physicalId)
    || !integer(v.revision) || !integer(v.physicalRevision, 1) || !knowledge(v.knowledge) || !(v.latestAttempt === null || attemptHead(v.latestAttempt))
    || !(v.activeRerecordPermit === null || isRerecordPermit(v.activeRerecordPermit))) return false;
  if (v.revision === 0 && (v.knowledge.state !== 'unknown' || v.knowledge.reason !== 'unverified' || v.activeRerecordPermit !== null)) return false;
  const p = v.activeRerecordPermit;
  return p === null || p.state === 'available' && p.physicalId === v.physicalId && p.contentRevision === v.revision && p.physicalRevision === v.physicalRevision;
}
export function isPhysicalRecordingDispositionIntent(v: unknown): v is PhysicalRecordingDispositionIntent {
  if (!record(v)) return false;
  if (v.action === 'mark-content-unknown' || v.action === 'confirm-erased') return keys(v, ['action']);
  if (v.action === 'confirm-current-recording') return keys(v, ['action', 'recordingId']) && uuid(v.recordingId);
  if (v.action === 'prepare-rerecord') return keys(v, ['action', 'mediaPlanId', 'expectedMediaPlanRevision']) && uuid(v.mediaPlanId) && integer(v.expectedMediaPlanRevision, 1);
  return v.action === 'cancel-rerecord' && keys(v, ['action', 'permitId']) && uuid(v.permitId);
}
const requestKeys = ['physicalId', 'expectedPhysicalRevision', 'expectedContentRevision', 'expectedAttempt', 'intent'];
function dispositionRequest(v: Record<string, unknown>): boolean { return physical(v.physicalId) && integer(v.expectedPhysicalRevision, 1) && integer(v.expectedContentRevision) && (v.expectedAttempt === null || attemptRevision(v.expectedAttempt)) && isPhysicalRecordingDispositionIntent(v.intent); }
export function isPreviewPhysicalRecordingDispositionRequest(v: unknown): v is PreviewPhysicalRecordingDispositionRequest { return record(v) && keys(v, requestKeys) && dispositionRequest(v); }
export function isApplyPhysicalRecordingDispositionRequest(v: unknown): v is ApplyPhysicalRecordingDispositionRequest { return record(v) && keys(v, [...requestKeys, 'commandId', 'proposalFingerprint', 'userConfirmed']) && dispositionRequest(v) && uuid(v.commandId) && hash(v.proposalFingerprint) && v.userConfirmed === true; }
const effects: Record<PhysicalRecordingDispositionIntent['action'], PhysicalRecordingDispositionEffect> = { 'mark-content-unknown': 'content-unknown', 'confirm-current-recording': 'content-confirmed', 'prepare-rerecord': 'rerecord-reserved', 'cancel-rerecord': 'rerecord-cancelled', 'confirm-erased': 'erased-confirmed' };
export function isPhysicalRecordingDispositionProposal(v: unknown): v is PhysicalRecordingDispositionProposal {
  if (!record(v) || !keys(v, ['request', 'checkedAt', 'proposalFingerprint', 'before', 'effect', 'outputWillStart']) || !isPreviewPhysicalRecordingDispositionRequest(v.request)
    || !date(v.checkedAt) || !hash(v.proposalFingerprint) || !isPhysicalRecordingState(v.before) || v.outputWillStart !== false) return false;
  const r = v.request, b = v.before;
  return r.physicalId === b.physicalId && r.expectedPhysicalRevision === b.physicalRevision && r.expectedContentRevision === b.revision && sameAttempt(r.expectedAttempt, b.latestAttempt) && effects[r.intent.action] === v.effect
    && (r.intent.action !== 'cancel-rerecord' || b.activeRerecordPermit?.id === r.intent.permitId);
}
export function isPhysicalRecordingDisposition(v: unknown): v is PhysicalRecordingDisposition {
  if (!record(v) || !keys(v, ['id', 'physicalId', 'createdAt', 'intent', 'beforeContentRevision', 'afterContentRevision', 'beforePhysicalRevision', 'afterPhysicalRevision', 'observedAttempt', 'permitId'])
    || !uuid(v.id) || !physical(v.physicalId) || !date(v.createdAt) || !isPhysicalRecordingDispositionIntent(v.intent) || !integer(v.beforeContentRevision) || !integer(v.afterContentRevision, 1)
    || v.afterContentRevision !== v.beforeContentRevision + 1 || !integer(v.beforePhysicalRevision, 1) || !integer(v.afterPhysicalRevision, v.beforePhysicalRevision, v.beforePhysicalRevision + 1)
    || !(v.observedAttempt === null || attemptRevision(v.observedAttempt))) return false;
  return v.intent.action === 'prepare-rerecord' || v.intent.action === 'cancel-rerecord' ? uuid(v.permitId) && (v.intent.action !== 'cancel-rerecord' || v.permitId === v.intent.permitId) : v.permitId === undefined;
}
export function isApplyPhysicalRecordingDispositionResult(v: unknown): v is ApplyPhysicalRecordingDispositionResult {
  if (!record(v) || !keys(v, ['disposition', 'state', 'mediaPlan']) || !isPhysicalRecordingDisposition(v.disposition) || !isPhysicalRecordingState(v.state)) return false;
  const d = v.disposition, s = v.state, k = s.knowledge;
  if (d.physicalId !== s.physicalId || d.afterContentRevision !== s.revision || d.afterPhysicalRevision !== s.physicalRevision || !sameAttempt(d.observedAttempt, s.latestAttempt)) return false;
  if (d.intent.action === 'prepare-rerecord') {
    const p = s.activeRerecordPermit, m = v.mediaPlan;
    return !!p && p.id === d.permitId && p.dispositionId === d.id && p.mediaPlanId === d.intent.mediaPlanId && sameAttempt(p.precedingAttempt, d.observedAttempt)
      && isMediaPlan(m) && m.id === d.intent.mediaPlanId && m.revision === d.intent.expectedMediaPlanRevision + 1 && m.revision === p.mediaPlanRevision && m.reservation?.physicalId === s.physicalId;
  }
  if (s.activeRerecordPermit !== null) return false;
  if (d.intent.action === 'cancel-rerecord') return isMediaPlan(v.mediaPlan) && v.mediaPlan.reservation === undefined;
  if (v.mediaPlan !== undefined) return false;
  if (d.intent.action === 'mark-content-unknown') return k.state === 'unknown' && k.reason === 'manual-unknown' && k.since === d.createdAt;
  if (d.intent.action === 'confirm-erased') return k.state === 'erased' && k.dispositionId === d.id && k.confirmedAt === d.createdAt;
  return k.state === 'confirmed-recording' && k.recordingId === d.intent.recordingId && k.confirmedAt === d.createdAt && k.evidence.kind === 'manual-disposition' && k.evidence.dispositionId === d.id;
}
export function isPhysicalRecordingHistoryRequest(v: unknown): v is PhysicalRecordingHistoryRequest { return record(v) && keys(v, ['physicalId', 'page']) && physical(v.physicalId) && page(v.page); }
function historyItem(v: unknown): v is PhysicalRecordingHistoryItem {
  if (!record(v) || !uuid(v.id) || !date(v.createdAt)) return false;
  if (v.kind === 'attempt') return keys(v, ['kind', 'id', 'createdAt', 'attempt', 'recordingId']) && isRecordingAttempt(v.attempt) && v.attempt.id === v.id && v.attempt.createdAt === v.createdAt && (v.recordingId === undefined || uuid(v.recordingId) && v.attempt.status === 'completed');
  return v.kind === 'disposition' && keys(v, ['kind', 'id', 'createdAt', 'disposition']) && isPhysicalRecordingDisposition(v.disposition) && v.disposition.id === v.id && v.disposition.createdAt === v.createdAt;
}
export function isPhysicalRecordingHistory(v: unknown): v is PhysicalRecordingHistory {
  return record(v) && keys(v, ['state', 'entries']) && isPhysicalRecordingState(v.state) && boundedPage(v.entries, historyItem, item => `${item.kind}:${item.id}`)
    && v.entries.items.every(item => (item.kind === 'attempt' ? item.attempt.physicalId : item.disposition.physicalId) === (v.state as PhysicalRecordingState).physicalId);
}
