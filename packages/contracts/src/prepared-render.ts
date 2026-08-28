import { isCollectionId } from './collection.js';
import { isDraftText } from './master-drafts.js';
import { isVersionTimeline, type VersionTimeline } from './master-versions.js';

export type RenderSide = 'A' | 'B' | 'Program';
/** 原始 Render 的字节身份；文件名和工作区回执都不能代替此证据。 */
export interface RawRenderAsset {
  id: string; side: RenderSide; sha256: string; size: number; format: 'wav';
  sampleRate: number; channelLayout: 'mono' | 'stereo'; totalFrames: number; createdAt: string;
  creationTimeEvidence: 'filesystem-birthtime' | 'first-observed';
}
export interface RenderMarker {
  trackId: string; exactSourceSha256: string; actualStartFrame: number; actualEndFrame: number;
  actualGapToNextFrames: number; confirmationMethod: 'manual' | 'automatic-candidate'; userConfirmed: boolean;
}
export interface RenderTimelineSide {
  name: RenderSide; renderAssetId: string | null; renderFileHash: string | null; sampleRate: number;
  channelLayout: 'mono' | 'stereo' | 'none'; totalFrames: number; markers: readonly RenderMarker[];
}
export interface RenderTimeline { timebase: 'sample-frames'; sides: readonly RenderTimelineSide[] }
export type RenderConformanceStatus = 'MATCHED' | 'ACCEPTED_VARIANCE' | 'REQUIRES_NEW_LAYOUT' | 'REQUIRES_NEW_MASTER' | 'REJECTED';
export type RenderConformanceReason = 'INVALID_TIMELINE' | 'RENDER_IDENTITY_MISMATCH' | 'MARKERS_UNCONFIRMED' | 'CONTENT_OR_ORDER_CHANGED' | 'SIDE_OR_STRUCTURE_CHANGED' | 'CAPACITY_EXCEEDED' | 'VARIANCE_NOT_ACCEPTED' | 'TIMING_VARIANCE';
export interface RenderConformance { status: RenderConformanceStatus; policy: 'one-render-frame-v1'; reasons: readonly RenderConformanceReason[] }
export interface RenderAssessment { timeline: RenderTimeline; structureChanged: boolean; contentIdentityChanged?: boolean; acceptVariance: boolean; varianceReason: string }
export interface FrozenPrepared {
  id: string; draftId: string; sequence: number; preparationId: string; importJobId: string;
  masterVersionId: string; layoutVersionId: string; contentHash: string; plannedTimelineHash: string;
  plannedTimeline: VersionTimeline; renderTimeline: RenderTimeline; renderTimelineHash: string;
  assets: readonly RawRenderAsset[]; conformance: RenderConformance; varianceReason: string;
  daw: string; processingLineage: string; createdAt: string; transitionRenderingMode: 'Baked Into Render';
  status: 'frozen'; executionReady: false;
}
export interface PreparedHistory { draftId: string; preps: readonly FrozenPrepared[]; jobs: readonly PreparedImportJob[] }
export interface PreparedImportJob {
  id: string; draftId: string; preparationId: string; destinationId: string;
  state: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'; completedFiles: number; totalFiles: number;
  assets?: readonly RawRenderAsset[]; manifestHash?: string;
  failure?: 'SOURCE_INVALID' | 'DESTINATION_INVALID' | 'IO_ERROR' | 'DISK_FULL' | 'CANCELLED';
}
export interface PreparedSelection { id: string; preparationId: string; side: RenderSide; label: string; authorized: boolean }
export interface SelectPreparedRequest { commandId: string; preparationId: string; side: RenderSide }
export interface PreviewPreparedImportRequest { preparationId: string; destinationId: string; selectionIds: readonly string[] }
export interface StartPreparedImportRequest extends PreviewPreparedImportRequest { commandId: string; proposalFingerprint: string; userConfirmed: true }
export interface PreparedImportProposal extends PreviewPreparedImportRequest { draftId: string; masterVersionId: string; layoutVersionId: string; assets: readonly RawRenderAsset[]; bytes: number; destinationLabel: string; storagePolicy: 'separate-retained-originals-v1'; proposalFingerprint: string; executionReady: false }
export interface ReviewPreparedRequest { importJobId: string; assessment: RenderAssessment; daw: string; processingLineage: string }
export interface FreezePreparedRequest extends ReviewPreparedRequest { commandId: string; proposalFingerprint: string; userConfirmed: true }
export interface PreparedReview { draftId: string; preparationId: string; masterVersionId: string; layoutVersionId: string; plannedTimeline: VersionTimeline; assets: readonly RawRenderAsset[]; conformance: RenderConformance; proposalFingerprint: string; executionReady: false }
export interface PreparedPublicApi {
  listPrepared(draftId: string): Promise<PreparedHistory>;
  listPreparedSelections(preparationId: string): Promise<{ selections: readonly PreparedSelection[] }>;
  choosePreparedRender(request: SelectPreparedRequest): Promise<PreparedSelection | null>;
  revokePreparedSelection(request: { commandId: string; id: string }): Promise<PreparedSelection>;
  /** 一次确认的文件撤权先整体持久化，最多 A/B/Program 三项。 */
  revokePreparedSelections(requests: readonly { commandId: string; id: string }[]): Promise<readonly PreparedSelection[]>;
  previewPreparedImport(request: PreviewPreparedImportRequest): Promise<PreparedImportProposal>;
  startPreparedImport(request: StartPreparedImportRequest): Promise<PreparedImportJob>;
  getPreparedImportJob(id: string): Promise<{ job: PreparedImportJob | null }>;
  cancelPreparedImport(request: { commandId: string; id: string }): Promise<PreparedImportJob>;
  reviewPrepared(request: ReviewPreparedRequest): Promise<PreparedReview>;
  freezePrepared(request: FreezePreparedRequest): Promise<FrozenPrepared>;
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(v).every(k => allowed.includes(k));
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const date = (v: unknown): boolean => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(v);
export const isRenderSide = (v: unknown): v is RenderSide => v === 'A' || v === 'B' || v === 'Program';
export function isRawRenderAsset(v: unknown): v is RawRenderAsset {
  return record(v) && keys(v, ['id','side','sha256','size','format','sampleRate','channelLayout','totalFrames','createdAt','creationTimeEvidence']) && isCollectionId(v.id) && isRenderSide(v.side) && hash(v.sha256) && integer(v.size, 1, 68_719_476_736) && v.format === 'wav' && integer(v.sampleRate, 8000, 384000) && (v.channelLayout === 'mono' || v.channelLayout === 'stereo') && integer(v.totalFrames, 1) && date(v.createdAt) && ['filesystem-birthtime','first-observed'].includes(String(v.creationTimeEvidence));
}
export function isRenderTimeline(v: unknown): v is RenderTimeline {
  if (!record(v) || !keys(v, ['timebase','sides']) || v.timebase !== 'sample-frames' || !Array.isArray(v.sides) || v.sides.length < 1 || v.sides.length > 2) return false;
  if (!(v.sides.length === 1 && v.sides[0]?.name === 'Program' || v.sides.length === 2 && v.sides[0]?.name === 'A' && v.sides[1]?.name === 'B')) return false;
  let count = 0;
  return v.sides.every(s => {
    if (record(s) && s.totalFrames === 0) return keys(s, ['name','renderAssetId','renderFileHash','sampleRate','channelLayout','totalFrames','markers']) && s.name === 'B' && s.renderAssetId === null && s.renderFileHash === null && integer(s.sampleRate, 8000, 384000) && s.channelLayout === 'none' && Array.isArray(s.markers) && s.markers.length === 0;
    if (!record(s) || !keys(s, ['name','renderAssetId','renderFileHash','sampleRate','channelLayout','totalFrames','markers']) || !isCollectionId(s.renderAssetId) || !hash(s.renderFileHash) || !integer(s.sampleRate, 8000, 384000) || !['mono','stereo'].includes(String(s.channelLayout)) || !integer(s.totalFrames, 1) || !Array.isArray(s.markers) || s.markers.length > 200) return false;
    count += s.markers.length;
    return s.markers.every((m, i) => {
      if (!record(m) || !keys(m, ['trackId','exactSourceSha256','actualStartFrame','actualEndFrame','actualGapToNextFrames','confirmationMethod','userConfirmed']) || !isCollectionId(m.trackId) || !hash(m.exactSourceSha256) || !integer(m.actualStartFrame, 0, s.totalFrames as number) || !integer(m.actualEndFrame, 1, s.totalFrames as number) || m.actualEndFrame <= m.actualStartFrame || !integer(m.actualGapToNextFrames, 0, s.totalFrames as number) || !['manual','automatic-candidate'].includes(String(m.confirmationMethod)) || typeof m.userConfirmed !== 'boolean') return false;
      const next = (s.markers as unknown[])[i + 1];
      return next === undefined ? m.actualGapToNextFrames === 0 : record(next) && integer(next.actualStartFrame) && next.actualStartFrame >= m.actualEndFrame && next.actualStartFrame - m.actualEndFrame === m.actualGapToNextFrames;
    });
  }) && count >= 1 && count <= 200;
}
export function isRenderAssessment(v: unknown): v is RenderAssessment {
  return record(v) && keys(v, ['timeline','structureChanged','contentIdentityChanged','acceptVariance','varianceReason']) && isRenderTimeline(v.timeline) && typeof v.structureChanged === 'boolean' && (v.contentIdentityChanged === undefined || typeof v.contentIdentityChanged === 'boolean') && typeof v.acceptVariance === 'boolean' && typeof v.varianceReason === 'string' && (v.varianceReason === '' || isDraftText(v.varianceReason));
}
export function isRenderConformance(v: unknown): v is RenderConformance {
  if (!record(v) || !keys(v, ['status','policy','reasons']) || v.policy !== 'one-render-frame-v1' || !['MATCHED','ACCEPTED_VARIANCE','REQUIRES_NEW_LAYOUT','REQUIRES_NEW_MASTER','REJECTED'].includes(String(v.status)) || !Array.isArray(v.reasons) || v.reasons.length > 8 || new Set(v.reasons).size !== v.reasons.length) return false;
  return v.status === 'MATCHED' ? v.reasons.length === 0 : v.reasons.length >= 1 && v.reasons.every(r => ['INVALID_TIMELINE','RENDER_IDENTITY_MISMATCH','MARKERS_UNCONFIRMED','CONTENT_OR_ORDER_CHANGED','SIDE_OR_STRUCTURE_CHANGED','CAPACITY_EXCEEDED','VARIANCE_NOT_ACCEPTED','TIMING_VARIANCE'].includes(String(r)));
}
function assets(v: unknown): v is RawRenderAsset[] { return Array.isArray(v) && v.length >= 1 && v.length <= 2 && v.every(isRawRenderAsset) && new Set(v.map(a => a.id)).size === v.length && (v.length === 1 ? ['Program','A'].includes(v[0]!.side) : v[0]!.side === 'A' && v[1]!.side === 'B'); }
export function isPreparedImportJob(v: unknown): v is PreparedImportJob {
  if (!record(v) || !keys(v, ['id','draftId','preparationId','destinationId','state','completedFiles','totalFiles','assets','manifestHash','failure']) || !['id','draftId','preparationId','destinationId'].every(k => isCollectionId(v[k])) || !integer(v.totalFiles, 1, 2) || !integer(v.completedFiles, 0, v.totalFiles)) return false;
  if (v.state === 'completed') return v.completedFiles === v.totalFiles && assets(v.assets) && v.assets.length === v.totalFiles && hash(v.manifestHash) && v.failure === undefined;
  if (v.assets !== undefined || v.manifestHash !== undefined) return false;
  if (v.state === 'failed') return ['SOURCE_INVALID','DESTINATION_INVALID','IO_ERROR','DISK_FULL'].includes(String(v.failure));
  if (v.state === 'cancelled') return v.failure === 'CANCELLED';
  return ['running','interrupted'].includes(String(v.state)) && v.failure === undefined;
}
export function isFrozenPrepared(v: unknown): v is FrozenPrepared {
  if (!record(v) || !keys(v, ['id','draftId','sequence','preparationId','importJobId','masterVersionId','layoutVersionId','contentHash','plannedTimelineHash','plannedTimeline','renderTimeline','renderTimelineHash','assets','conformance','varianceReason','daw','processingLineage','createdAt','transitionRenderingMode','status','executionReady']) || !['id','draftId','preparationId','importJobId','masterVersionId','layoutVersionId'].every(k => isCollectionId(v[k])) || !integer(v.sequence, 1, 100) || !['contentHash','plannedTimelineHash','renderTimelineHash'].every(k => hash(v[k])) || !isVersionTimeline(v.plannedTimeline) || !isRenderTimeline(v.renderTimeline) || !assets(v.assets) || !isRenderConformance(v.conformance) || !['MATCHED','ACCEPTED_VARIANCE'].includes(v.conformance.status) || typeof v.varianceReason !== 'string' || !(v.varianceReason === '' || isDraftText(v.varianceReason)) || v.conformance.status === 'ACCEPTED_VARIANCE' && !v.varianceReason.trim() || !isDraftText(v.daw) || !isDraftText(v.processingLineage) || !date(v.createdAt) || v.transitionRenderingMode !== 'Baked Into Render' || v.status !== 'frozen' || v.executionReady !== false) return false;
  const raw = v.assets, planned = v.plannedTimeline;
  return v.renderTimeline.sides.filter(s => s.totalFrames > 0).length === raw.length && v.renderTimeline.sides.length === planned.sides.length && v.renderTimeline.sides.every((s, i) => {
    if (s.name !== planned.sides[i]!.name) return false;
    if (s.totalFrames === 0) return planned.sides[i]!.tracks.length === 0 && planned.sides[i]!.totalFrames === 0 && s.sampleRate === planned.sampleRate;
    const a = raw.find(a => a.side === s.name);
    return a !== undefined && s.renderAssetId === a.id && s.renderFileHash === a.sha256 && s.sampleRate === a.sampleRate && s.channelLayout === a.channelLayout && s.totalFrames === a.totalFrames && s.markers.length === planned.sides[i]!.tracks.length && s.markers.every((m, j) => m.userConfirmed && m.confirmationMethod === 'manual' && m.trackId === planned.sides[i]!.tracks[j]!.trackId);
  });
}
export function isPreparedHistory(v: unknown): v is PreparedHistory {
  if (!record(v) || !keys(v, ['draftId','preps','jobs']) || !isCollectionId(v.draftId) || !Array.isArray(v.preps) || v.preps.length > 100 || !v.preps.every(isFrozenPrepared) || !Array.isArray(v.jobs) || v.jobs.length > 1000 || !v.jobs.every(isPreparedImportJob)) return false;
  const jobs = v.jobs;
  return [...v.preps, ...jobs].every(p => p.draftId === v.draftId) && new Set(v.preps.map(p => p.id)).size === v.preps.length && new Set(jobs.map(j => j.id)).size === jobs.length && v.preps.every(p => jobs.some(j => j.id === p.importJobId && j.state === 'completed' && j.preparationId === p.preparationId && JSON.stringify(j.assets) === JSON.stringify(p.assets)));
}
export function isPreparedSelection(v: unknown): v is PreparedSelection { return record(v) && keys(v, ['id','preparationId','side','label','authorized']) && isCollectionId(v.id) && isCollectionId(v.preparationId) && isRenderSide(v.side) && isDraftText(v.label) && v.label.length <= 240 && typeof v.authorized === 'boolean'; }
export function isSelectPreparedRequest(v: unknown): v is SelectPreparedRequest { return record(v) && keys(v, ['commandId','preparationId','side']) && isCollectionId(v.commandId) && isCollectionId(v.preparationId) && isRenderSide(v.side); }
export function isPreviewPreparedImportRequest(v: unknown): v is PreviewPreparedImportRequest { return record(v) && keys(v, ['preparationId','destinationId','selectionIds']) && isCollectionId(v.preparationId) && isCollectionId(v.destinationId) && Array.isArray(v.selectionIds) && v.selectionIds.length >= 1 && v.selectionIds.length <= 2 && v.selectionIds.every(isCollectionId) && new Set(v.selectionIds).size === v.selectionIds.length; }
export function isStartPreparedImportRequest(v: unknown): v is StartPreparedImportRequest { return record(v) && keys(v, ['preparationId','destinationId','selectionIds','commandId','proposalFingerprint','userConfirmed']) && isPreviewPreparedImportRequest({ preparationId: v.preparationId, destinationId: v.destinationId, selectionIds: v.selectionIds }) && isCollectionId(v.commandId) && hash(v.proposalFingerprint) && v.userConfirmed === true; }
export function isPreparedImportProposal(v: unknown): v is PreparedImportProposal { return record(v) && keys(v, ['preparationId','destinationId','selectionIds','draftId','masterVersionId','layoutVersionId','assets','bytes','destinationLabel','storagePolicy','proposalFingerprint','executionReady']) && isPreviewPreparedImportRequest({ preparationId: v.preparationId, destinationId: v.destinationId, selectionIds: v.selectionIds }) && ['draftId','masterVersionId','layoutVersionId'].every(k => isCollectionId(v[k])) && assets(v.assets) && v.assets.length === (v.selectionIds as string[]).length && v.assets.every((a, i) => a.id === (v.selectionIds as string[])[i]) && integer(v.bytes, 1, 137_438_953_472) && v.bytes === v.assets.reduce((sum, a) => sum + a.size, 0) && isDraftText(v.destinationLabel) && v.destinationLabel.length <= 240 && v.storagePolicy === 'separate-retained-originals-v1' && hash(v.proposalFingerprint) && v.executionReady === false; }
export function isReviewPreparedRequest(v: unknown): v is ReviewPreparedRequest { return record(v) && keys(v, ['importJobId','assessment','daw','processingLineage']) && isCollectionId(v.importJobId) && isRenderAssessment(v.assessment) && isDraftText(v.daw) && isDraftText(v.processingLineage); }
export function isFreezePreparedRequest(v: unknown): v is FreezePreparedRequest { return record(v) && keys(v, ['importJobId','assessment','daw','processingLineage','commandId','proposalFingerprint','userConfirmed']) && isReviewPreparedRequest({ importJobId: v.importJobId, assessment: v.assessment, daw: v.daw, processingLineage: v.processingLineage }) && isCollectionId(v.commandId) && hash(v.proposalFingerprint) && v.userConfirmed === true; }
export function isPreparedReview(v: unknown): v is PreparedReview { return record(v) && keys(v, ['draftId','preparationId','masterVersionId','layoutVersionId','plannedTimeline','assets','conformance','proposalFingerprint','executionReady']) && ['draftId','preparationId','masterVersionId','layoutVersionId'].every(k => isCollectionId(v[k])) && isVersionTimeline(v.plannedTimeline) && assets(v.assets) && isRenderConformance(v.conformance) && hash(v.proposalFingerprint) && v.executionReady === false; }
