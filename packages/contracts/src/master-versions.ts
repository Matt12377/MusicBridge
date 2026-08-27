import type { DraftProgramType, DraftTrackMetadata } from './master-drafts.js';
import type { SourceBinding, SourceTechnical } from './source-evidence.js';
import type { MediaLayoutSpec, MediaReservation } from './media-planning.js';

/** 内容身份不包含文件路径、定位编号或校验时间；重新定位相同内容不会生成另一母版。 */
export interface MasterContentTrack {
  trackId: string; metadata: DraftTrackMetadata;
  source: { sha256: string; size: number; technical: SourceTechnical & { sampleFrames: number; frameEvidence: 'container-declared' } };
  transitionAfterMs: number; keepWithNext: boolean;
}
export interface MasterContent { programType: DraftProgramType; tracks: readonly MasterContentTrack[] }
export interface VersionTimelineTrack { trackId: string; sourceBindingId: string; sourceSampleRate: number; sourceFrames: number; startFrame: number; endFrame: number; gapAfterFrames: number }
export interface VersionTimelineSide { name: 'A' | 'B' | 'Program'; capacityFrames: number; leadInFrames: number; tailFrames: number; totalFrames: number; tracks: readonly VersionTimelineTrack[] }
/** 规划帧数不证明任何解码器、SRC 或输出设备已通过认证。 */
export interface VersionTimeline { timebase: 'sample-frames'; sampleRate: number; rounding: 'nearest-half-up-v1'; sides: readonly VersionTimelineSide[] }
export interface VersionMaterial { content: MasterContent; contentHash: string; timeline: VersionTimeline; timelineHash: string; executionReady: false }
export interface MasterVersion { id: string; draftId: string; sequence: number; parentId?: string; title: string; createdAt: string; content: MasterContent; contentHash: string; sourceEvidence: readonly { trackId: string; binding: SourceBinding }[]; status: 'frozen' }
export interface LayoutVersion { id: string; draftId: string; masterVersionId: string; sequence: number; parentId?: string; planId: string; createdAt: string; spec: MediaLayoutSpec; lengthMinutes: number; reservation: MediaReservation; timeline: VersionTimeline; timelineHash: string; status: 'frozen'; executionReady: false }
export interface PreviewVersionsRequest { planId: string; sampleRate: number }
export interface FreezeVersionsRequest extends PreviewVersionsRequest { commandId: string; proposalFingerprint: string; userConfirmed: true }
export type VersionFailure = 'SOURCE_INVALID' | 'INPUT_CHANGED' | 'IO_ERROR' | 'CANCELLED';
export interface VersionJob { id: string; draftId: string; planId: string; state: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'; masterVersionId?: string; layoutVersionId?: string; failure?: VersionFailure }
export interface VersionHistory { draftId: string; masters: readonly MasterVersion[]; layouts: readonly LayoutVersion[]; jobs: readonly VersionJob[] }
export interface VersionProposal extends VersionMaterial { draftId: string; planId: string; proposalFingerprint: string; masterAction: 'create' | 'reuse'; existingMasterId?: string; previousMasterId?: string; lengthMinutes: number; reservation: MediaReservation }
export interface MasterVersionsPublicApi {
  listMasterVersions(draftId: string): Promise<VersionHistory>;
  previewMasterVersions(request: PreviewVersionsRequest): Promise<VersionProposal>;
  freezeMasterVersions(request: FreezeVersionsRequest): Promise<VersionJob>;
  getMasterVersionJob(id: string): Promise<{ job: VersionJob | null }>;
  cancelMasterVersionJob(request: { commandId: string; id: string }): Promise<VersionJob>;
}

import { isCollectionId, isPhysicalId } from './collection.js';
import { isDraftProgramType, isDraftText, isDraftTrackMetadata } from './master-drafts.js';
import { isSourceBinding, isSourceTechnical } from './source-evidence.js';
import { isMediaLayoutSpec } from './media-planning.js';
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(v).every(k => allowed.includes(k));
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const date = (v: unknown): boolean => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(v);
const rate = (v: unknown): v is number => integer(v, 8000, 384000);
export function isPreviewVersionsRequest(v: unknown): v is PreviewVersionsRequest { return record(v) && keys(v, ['planId','sampleRate']) && isCollectionId(v.planId) && rate(v.sampleRate); }
export function isFreezeVersionsRequest(v: unknown): v is FreezeVersionsRequest { return record(v) && keys(v, ['planId','sampleRate','commandId','proposalFingerprint','userConfirmed']) && isCollectionId(v.planId) && rate(v.sampleRate) && isCollectionId(v.commandId) && hash(v.proposalFingerprint) && v.userConfirmed === true; }
export function isVersionJob(v: unknown): v is VersionJob {
  if (!record(v) || !keys(v, ['id','draftId','planId','state','masterVersionId','layoutVersionId','failure']) || !['id','draftId','planId'].every(k => isCollectionId(v[k]))) return false;
  if (v.state === 'completed') return isCollectionId(v.masterVersionId) && isCollectionId(v.layoutVersionId) && v.failure === undefined;
  if (v.masterVersionId !== undefined || v.layoutVersionId !== undefined) return false;
  if (v.state === 'failed') return ['SOURCE_INVALID','INPUT_CHANGED','IO_ERROR'].includes(String(v.failure));
  if (v.state === 'cancelled') return v.failure === 'CANCELLED';
  return ['running','interrupted'].includes(String(v.state)) && v.failure === undefined;
}
function contentTrack(v: unknown): v is MasterContentTrack {
  return record(v) && keys(v, ['trackId','metadata','source','transitionAfterMs','keepWithNext']) && isCollectionId(v.trackId) && isDraftTrackMetadata(v.metadata) && integer(v.transitionAfterMs, 0, 60000) && typeof v.keepWithNext === 'boolean' && record(v.source) && keys(v.source, ['sha256','size','technical']) && hash(v.source.sha256) && integer(v.source.size, 1, 68719476736) && isSourceTechnical(v.source.technical) && v.source.technical.sampleFrames !== undefined && v.source.technical.frameEvidence === 'container-declared';
}
export function isMasterContent(v: unknown): v is MasterContent { return record(v) && keys(v, ['programType','tracks']) && isDraftProgramType(v.programType) && Array.isArray(v.tracks) && v.tracks.length >= 1 && v.tracks.length <= 200 && v.tracks.every(contentTrack) && new Set(v.tracks.map(t => t.trackId)).size === v.tracks.length; }
export function isVersionTimeline(v: unknown): v is VersionTimeline {
  if (!record(v) || !keys(v, ['timebase','sampleRate','rounding','sides']) || v.timebase !== 'sample-frames' || !rate(v.sampleRate) || v.rounding !== 'nearest-half-up-v1' || !Array.isArray(v.sides)) return false;
  const sampleRate = v.sampleRate;
  if (!((v.sides.length === 1 && v.sides[0]?.name === 'Program') || (v.sides.length === 2 && v.sides[0]?.name === 'A' && v.sides[1]?.name === 'B'))) return false;
  const ids = new Set<string>();
  return v.sides.every(side => {
    if (!record(side) || !keys(side, ['name','capacityFrames','leadInFrames','tailFrames','totalFrames','tracks']) || !integer(side.capacityFrames, 1) || !integer(side.totalFrames, 0, side.capacityFrames) || !integer(side.leadInFrames) || !integer(side.tailFrames) || !Array.isArray(side.tracks) || side.tracks.length > 200) return false;
    let cursor = side.leadInFrames;
    for (const [index, track] of side.tracks.entries()) {
      if (!record(track) || !keys(track, ['trackId','sourceBindingId','sourceSampleRate','sourceFrames','startFrame','endFrame','gapAfterFrames']) || !isCollectionId(track.trackId) || !isCollectionId(track.sourceBindingId) || ids.has(track.trackId) || !integer(track.sourceSampleRate, 1, 50000000) || !integer(track.sourceFrames, 1) || !integer(track.startFrame) || !integer(track.endFrame) || !integer(track.gapAfterFrames) || track.startFrame !== cursor || (index === side.tracks.length - 1 && track.gapAfterFrames !== 0)) return false;
      const sourceRate = BigInt(track.sourceSampleRate), expected = Number((BigInt(track.sourceFrames) * BigInt(sampleRate) * 2n + sourceRate) / (2n * sourceRate));
      if (expected < 1 || track.endFrame - track.startFrame !== expected || track.gapAfterFrames > sampleRate * 60) return false;
      cursor = track.endFrame + track.gapAfterFrames; ids.add(track.trackId);
    }
    return side.tracks.length ? cursor + side.tailFrames === side.totalFrames : side.totalFrames === 0 && side.leadInFrames === 0 && side.tailFrames === 0;
  }) && ids.size >= 1 && ids.size <= 200;
}
function material(v: Record<string, unknown>): boolean {
  if (!isMasterContent(v.content) || !isVersionTimeline(v.timeline) || !hash(v.contentHash) || !hash(v.timelineHash) || v.executionReady !== false) return false;
  const tracks = v.timeline.sides.flatMap(s => s.tracks);
  return tracks.length === v.content.tracks.length && v.content.tracks.every((track, i) => tracks[i]?.trackId === track.trackId && tracks[i]?.sourceFrames === track.source.technical.sampleFrames && tracks[i]?.sourceSampleRate === track.source.technical.sampleRate);
}
function reservation(v: unknown): v is MediaReservation { return record(v) && keys(v, ['physicalId','modelId','skuId','packaging']) && isPhysicalId(v.physicalId) && isCollectionId(v.modelId) && isCollectionId(v.skuId) && ['opened','sealed'].includes(String(v.packaging)); }
export function isVersionProposal(v: unknown): v is VersionProposal {
  return record(v) && keys(v, ['content','contentHash','timeline','timelineHash','executionReady','draftId','planId','proposalFingerprint','masterAction','existingMasterId','previousMasterId','lengthMinutes','reservation']) && material(v) && isCollectionId(v.draftId) && isCollectionId(v.planId) && hash(v.proposalFingerprint) && (v.masterAction === 'reuse' ? isCollectionId(v.existingMasterId) : v.masterAction === 'create' && v.existingMasterId === undefined) && (v.previousMasterId === undefined || isCollectionId(v.previousMasterId)) && integer(v.lengthMinutes, 1, 360) && reservation(v.reservation);
}
export function isMasterVersion(v: unknown): v is MasterVersion {
  if (!record(v) || !keys(v, ['id','draftId','sequence','parentId','title','createdAt','content','contentHash','sourceEvidence','status']) || !isCollectionId(v.id) || !isCollectionId(v.draftId) || !integer(v.sequence, 1, 100) || (v.parentId !== undefined && (!isCollectionId(v.parentId) || v.parentId === v.id)) || !isDraftText(v.title) || !date(v.createdAt) || !hash(v.contentHash) || !isMasterContent(v.content) || v.status !== 'frozen' || !Array.isArray(v.sourceEvidence) || v.sourceEvidence.length !== v.content.tracks.length) return false;
  const content = v.content;
  return v.sourceEvidence.every((e, i) => record(e) && keys(e, ['trackId','binding']) && e.trackId === content.tracks[i]!.trackId && isSourceBinding(e.binding) && e.binding.sourceLockEligible && e.binding.sha256 === content.tracks[i]!.source.sha256 && e.binding.technical.sampleFrames === content.tracks[i]!.source.technical.sampleFrames);
}
export function isLayoutVersion(v: unknown): v is LayoutVersion {
  if (!record(v) || !keys(v, ['id','draftId','masterVersionId','sequence','parentId','planId','createdAt','spec','lengthMinutes','reservation','timeline','timelineHash','status','executionReady']) || !['id','draftId','masterVersionId','planId'].every(k => isCollectionId(v[k])) || !integer(v.sequence, 1, 100) || (v.parentId !== undefined && (!isCollectionId(v.parentId) || v.parentId === v.id)) || !date(v.createdAt) || !isMediaLayoutSpec(v.spec) || !integer(v.lengthMinutes, 1, 360) || !reservation(v.reservation) || !isVersionTimeline(v.timeline) || !hash(v.timelineHash) || v.status !== 'frozen' || v.executionReady !== false) return false;
  const capacity = v.lengthMinutes * 60 * v.timeline.sampleRate / (v.spec.format === 'cassette' ? 2 : 1);
  return (v.spec.format === 'cassette' ? v.timeline.sides.length === 2 && v.timeline.sides[0]!.tracks.length === v.spec.splitAfter : v.timeline.sides.length === 1) && v.timeline.sides.every(s => s.capacityFrames === capacity);
}
export function isVersionHistory(v: unknown): v is VersionHistory {
  if (!record(v) || !keys(v, ['draftId','masters','layouts','jobs']) || !isCollectionId(v.draftId) || !Array.isArray(v.masters) || v.masters.length > 100 || !v.masters.every(isMasterVersion) || !Array.isArray(v.layouts) || v.layouts.length > 100 || !v.layouts.every(isLayoutVersion) || !Array.isArray(v.jobs) || v.jobs.length > 1000 || !v.jobs.every(isVersionJob)) return false;
  const masters = v.masters, layouts = v.layouts;
  return [...masters, ...layouts, ...v.jobs].every(item => item.draftId === v.draftId) && new Set(masters.map(m => m.id)).size === masters.length && new Set(layouts.map(l => l.id)).size === layouts.length && layouts.every(l => masters.some(m => m.id === l.masterVersionId && material({ content: m.content, contentHash: m.contentHash, timeline: l.timeline, timelineHash: l.timelineHash, executionReady: false }))) && v.jobs.every(j => j.state !== 'completed' || masters.some(m => m.id === j.masterVersionId) && layouts.some(l => l.id === j.layoutVersionId && l.masterVersionId === j.masterVersionId));
}
