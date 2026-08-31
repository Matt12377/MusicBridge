import { isCollectionId, isPhysicalId, type CollectionCopy } from './collection.js';
import { isMasterVersion, isLayoutVersion, isVersionHistory, type MasterVersion, type LayoutVersion } from './master-versions.js';
import { isFrozenPrepared, type FrozenPrepared } from './prepared-render.js';
import { isResolvedRecordingSettings, type ResolvedRecordingSettings } from './recording-profile.js';
import { isExecutionAssetRecipe, isExecutionAssetAudio, executionRecipeMode, executionFrameLimit, type ExecutionMode, type ExecutionAssetRecipe, type ExecutionAssetAudio } from './execution-assets.js';
import type { ArchiveSourcePolicy } from './recording-archive.js';

export const MAX_RECORDING_PLAN_VERSIONS = 100;
/** 成功执行音频/谱系及原始Render永久保留；失败取消仅显式清理，完整备份含归档音频，缺依赖不承诺重建。 */
export const RECORDING_RETENTION_POLICY = 'f01-permanent-execution-v1' as const;
export const RECORDING_PREFLIGHT_CATEGORIES = ['versions', 'sources', 'execution', 'archive', 'physical-copy', 'capacity', 'profile', 'backend'] as const;
export type RecordingPreflightCategory = typeof RECORDING_PREFLIGHT_CATEGORIES[number];
export type RecordingPreflightIssue = 'VERSION_MISMATCH' | 'SOURCE_INVALID' | 'EXECUTION_INVALID' | 'ARCHIVE_INVALID' | 'COPY_UNAVAILABLE' | 'CAPACITY_EXCEEDED' | 'PROFILE_MISMATCH' | 'COMPATIBILITY_UNCONFIRMED' | 'BACKEND_NOT_CERTIFIED' | 'NOT_CHECKED' | 'READ_FAILED';

export interface RecordingPlanSelection { assetId: string; archiveOperationId: string }
/** 当前明确Session的完整参数副本，永久嵌入所属计划；不是对历史执行资产设置的更新。 */
export interface RecordingProfileSnapshot { sessionRevision: number; settings: ResolvedRecordingSettings }
export interface RecordingPlanExecution {
  assetId: string; manifestHash: string; mode: ExecutionMode; compiledSettings: ResolvedRecordingSettings;
  recipes: readonly ExecutionAssetRecipe[]; audio: readonly ExecutionAssetAudio[];
}
export interface RecordingPlanArchive {
  operationId: string; rootId: string; sourcePolicy: ArchiveSourcePolicy; manifestHash: string;
  phase: 'FINALIZED'; objectCount: number; copyBytes: number;
}
export interface RecordingPlanMaterial {
  master: MasterVersion; layout: LayoutVersion; prepared?: FrozenPrepared; execution: RecordingPlanExecution;
  physicalCopy: CollectionCopy; mediaPlanRevision: number; profileSnapshot: RecordingProfileSnapshot; archive: RecordingPlanArchive;
  retentionPolicy: typeof RECORDING_RETENTION_POLICY; onlineFallback: false; formalReady: false;
}
export interface RecordingPlanProposal extends RecordingPlanMaterial { draftId: string; selection: RecordingPlanSelection; checkedAt: string; proposalFingerprint: string }
/** 身份冻结不授予执行许可；当前没有Start，后续须重做Preflight及后端认证。 */
export interface RecordingPlanVersion extends RecordingPlanMaterial { id: string; draftId: string; sequence: number; parentId?: string; createdAt: string; contentHash: string; status: 'frozen' }
export interface RecordingPlanHistory { draftId: string; versions: readonly RecordingPlanVersion[] }
export interface RecordingPlanHistoryRequest { draftId: string }
export interface RecordingPlanIdRequest { id: string }
export interface PreviewRecordingPlanRequest { readId: string; selection: RecordingPlanSelection }
export interface FreezeRecordingPlanRequest { commandId: string; selection: RecordingPlanSelection; proposalFingerprint: string; userConfirmed: true }
export interface RecordingPreflightRequest { readId: string; planVersionId: string }
export interface RecordingPreflightCheck { category: RecordingPreflightCategory; state: 'passed' | 'blocked' | 'not-run'; code?: RecordingPreflightIssue }
/** 最新只读检查不充当永久许可；Gate B尚未运行，不能由Renderer提交认证。 */
export interface RecordingPreflightResult { planVersionId: string; checkedAt: string; state: 'blocked'; gateB: 'NOT_RUN'; checks: readonly RecordingPreflightCheck[]; formalReady: false }
export interface RecordingPlansPublicApi {
  listRecordingPlans(draftId: string): Promise<RecordingPlanHistory>;
  getRecordingPlanVersion(id: string): Promise<{ plan: RecordingPlanVersion | null }>;
  previewRecordingPlan(request: PreviewRecordingPlanRequest): Promise<RecordingPlanProposal>;
  freezeRecordingPlan(request: FreezeRecordingPlanRequest): Promise<RecordingPlanVersion>;
  preflightRecordingPlan(request: RecordingPreflightRequest): Promise<RecordingPreflightResult>;
  cancelRecordingPlanRead(id: string): Promise<{ cancelled: true }>;
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(v).every(k => allowed.includes(k));
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const date = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]));
  return record(a) && record(b) && Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => Object.hasOwn(b, k) && same(v, b[k]));
}
export function isRecordingPlanSelection(v: unknown): v is RecordingPlanSelection { return record(v) && keys(v, ['assetId', 'archiveOperationId']) && isCollectionId(v.assetId) && isCollectionId(v.archiveOperationId); }
export function isRecordingPlanHistoryRequest(v: unknown): v is RecordingPlanHistoryRequest { return record(v) && keys(v, ['draftId']) && isCollectionId(v.draftId); }
export function isRecordingPlanIdRequest(v: unknown): v is RecordingPlanIdRequest { return record(v) && keys(v, ['id']) && isCollectionId(v.id); }
export function isPreviewRecordingPlanRequest(v: unknown): v is PreviewRecordingPlanRequest { return record(v) && keys(v, ['readId', 'selection']) && isCollectionId(v.readId) && isRecordingPlanSelection(v.selection); }
export function isFreezeRecordingPlanRequest(v: unknown): v is FreezeRecordingPlanRequest { return record(v) && keys(v, ['commandId', 'selection', 'proposalFingerprint', 'userConfirmed']) && isCollectionId(v.commandId) && isRecordingPlanSelection(v.selection) && hash(v.proposalFingerprint) && v.userConfirmed === true; }
export function isRecordingPreflightRequest(v: unknown): v is RecordingPreflightRequest { return record(v) && keys(v, ['readId', 'planVersionId']) && isCollectionId(v.readId) && isCollectionId(v.planVersionId); }
export function isRecordingProfileSnapshot(v: unknown): v is RecordingProfileSnapshot { return record(v) && keys(v, ['sessionRevision', 'settings']) && integer(v.sessionRevision, 1) && isResolvedRecordingSettings(v.settings); }
export function isRecordingPlanArchive(v: unknown): v is RecordingPlanArchive {
  return record(v) && keys(v, ['operationId', 'rootId', 'sourcePolicy', 'manifestHash', 'phase', 'objectCount', 'copyBytes']) && isCollectionId(v.operationId) && isCollectionId(v.rootId) && (v.sourcePolicy === 'reference-dependent' || v.sourcePolicy === 'preserve-exact-sources') && hash(v.manifestHash) && v.phase === 'FINALIZED' && integer(v.objectCount, 1, 1000) && integer(v.copyBytes, 1, 1_099_511_627_776);
}
export function isRecordingPlanExecution(v: unknown): v is RecordingPlanExecution {
  if (!record(v) || !keys(v, ['assetId', 'manifestHash', 'mode', 'compiledSettings', 'recipes', 'audio']) || !isCollectionId(v.assetId) || !hash(v.manifestHash) || !isResolvedRecordingSettings(v.compiledSettings) || !Array.isArray(v.recipes) || !v.recipes.every(isExecutionAssetRecipe) || !Array.isArray(v.audio) || !v.audio.every(isExecutionAssetAudio)) return false;
  const recipes = v.recipes, audio = v.audio, settings = v.compiledSettings;
  if (!(recipes.length === 1 && recipes[0]?.side === 'Program' || recipes.length === 2 && recipes[0]?.side === 'A' && recipes[1]?.side === 'B')) return false;
  const first = recipes[0]!, nonempty = recipes.filter(r => executionFrameLimit(r) > 0);
  return recipes.every(r => executionRecipeMode(r) === v.mode && same(r.format, settings.format) && r.masterVersionId === first.masterVersionId && r.layoutVersionId === first.layoutVersionId && r.contentHash === first.contentHash && r.plannedTimelineHash === first.plannedTimelineHash && same(r.prepared, first.prepared))
    && audio.length === nonempty.length && audio.length >= 1 && audio.every((a, i) => same(a.recipe, nonempty[i]));
}

function copy(v: unknown): v is CollectionCopy {
  return record(v) && keys(v, ['physicalId', 'lotId', 'skuId', 'lengthMinutes', 'packaging', 'usage', 'available', 'origin', 'revision'])
    && isPhysicalId(v.physicalId) && isCollectionId(v.lotId) && isCollectionId(v.skuId) && integer(v.lengthMinutes, 1, 360)
    && (v.packaging === 'opened' || v.packaging === 'sealed') && v.usage === 'reserved' && typeof v.available === 'boolean'
    && (v.origin === 'blank-pool' || v.origin === 'legacy-registration' || v.origin === 'unclassified') && integer(v.revision, 1);
}
const materialKeys = ['master', 'layout', 'prepared', 'execution', 'physicalCopy', 'mediaPlanRevision', 'profileSnapshot', 'archive', 'retentionPolicy', 'onlineFallback', 'formalReady'];
function material(v: Record<string, unknown>): v is Record<string, unknown> & RecordingPlanMaterial {
  if (!isMasterVersion(v.master) || !isLayoutVersion(v.layout) || !isRecordingPlanExecution(v.execution) || !isRecordingProfileSnapshot(v.profileSnapshot) || !isRecordingPlanArchive(v.archive) || !copy(v.physicalCopy) || !integer(v.mediaPlanRevision, 1) || v.retentionPolicy !== RECORDING_RETENTION_POLICY || v.onlineFallback !== false || v.formalReady !== false) return false;
  const master = v.master, layout = v.layout, execution = v.execution, snapshot = v.profileSnapshot, physical = v.physicalCopy;
  if (!isVersionHistory({ draftId: master.draftId, masters: [master], layouts: [layout], jobs: [] })) return false;
  if (physical.physicalId !== layout.reservation.physicalId || physical.skuId !== layout.reservation.skuId || physical.packaging !== layout.reservation.packaging || physical.lengthMinutes !== layout.lengthMinutes) return false;
  if (!same(snapshot.settings.format, execution.compiledSettings.format) || !same(snapshot.settings.profile, execution.compiledSettings.profile)) return false;
  const preparedMode = execution.mode === 'prepared-reference' || execution.mode === 'prepared-derivative';
  if (preparedMode) {
    if (!isFrozenPrepared(v.prepared)) return false;
    const prepared = v.prepared;
    if (prepared.draftId !== master.draftId || prepared.masterVersionId !== master.id || prepared.layoutVersionId !== layout.id || prepared.contentHash !== master.contentHash || prepared.plannedTimelineHash !== layout.timelineHash || !same(prepared.plannedTimeline, layout.timeline)) return false;
    if (!prepared.renderTimeline.sides.every(side => side.markers.every(marker => master.content.tracks.some(track => track.trackId === marker.trackId && track.source.sha256 === marker.exactSourceSha256)))) return false;
  } else if (v.prepared !== undefined) return false;
  const prepared = v.prepared as FrozenPrepared | undefined;
  return execution.recipes.length === layout.timeline.sides.length && execution.recipes.every((r, i) => {
    if (!(r.masterVersionId === master.id && r.layoutVersionId === layout.id && r.contentHash === master.contentHash && r.plannedTimelineHash === layout.timelineHash
    && r.side === layout.timeline.sides[i]?.name && r.capacityFrames === layout.lengthMinutes * 60 * r.format.sampleRate / (layout.spec.format === 'cassette' ? 2 : 1)
    && r.prepared?.id === prepared?.id && r.prepared?.renderTimelineHash === prepared?.renderTimelineHash
    && (executionFrameLimit(r) === 0) === (layout.timeline.sides[i]?.totalFrames === 0))) return false;
    const segments = r.segments.filter(s => s.kind !== 'silence');
    if (prepared) {
      if (executionFrameLimit(r) === 0) return segments.length === 0;
      const raw = prepared.assets.find(asset => asset.side === r.side);
      return raw !== undefined && segments.length === 1 && segments.every(s => {
        if (s.kind !== 'render') return false;
        const input = 'input' in s ? s.input : s.conversion.input;
        return s.renderAssetId === raw.id && input.sha256 === raw.sha256 && input.size === raw.size;
      });
    }
    const tracks = layout.timeline.sides[i]!.tracks;
    return segments.length === tracks.length && segments.every((s, j) => {
      if (s.kind !== 'source' || s.trackId !== tracks[j]?.trackId) return false;
      const source = master.content.tracks.find(track => track.trackId === s.trackId)?.source;
      const input = 'input' in s ? s.input : s.conversion.input;
      return source !== undefined && input.sha256 === source.sha256 && input.size === source.size;
    });
  });
}
export function isRecordingPlanMaterial(v: unknown): v is RecordingPlanMaterial { return record(v) && keys(v, materialKeys) && material(v); }
export function isRecordingPlanProposal(v: unknown): v is RecordingPlanProposal {
  return record(v) && keys(v, [...materialKeys, 'draftId', 'selection', 'checkedAt', 'proposalFingerprint']) && material(v)
    && v.draftId === v.master.draftId && isRecordingPlanSelection(v.selection) && v.selection.assetId === v.execution.assetId
    && v.selection.archiveOperationId === v.archive.operationId && date(v.checkedAt) && hash(v.proposalFingerprint);
}
export function isRecordingPlanVersion(v: unknown): v is RecordingPlanVersion {
  return record(v) && keys(v, [...materialKeys, 'id', 'draftId', 'sequence', 'parentId', 'createdAt', 'contentHash', 'status']) && material(v)
    && isCollectionId(v.id) && v.draftId === v.master.draftId && integer(v.sequence, 1, MAX_RECORDING_PLAN_VERSIONS)
    && (v.sequence === 1 ? v.parentId === undefined : isCollectionId(v.parentId) && v.parentId !== v.id)
    && date(v.createdAt) && hash(v.contentHash) && v.status === 'frozen';
}
export function isRecordingPlanHistory(v: unknown): v is RecordingPlanHistory {
  if (!record(v) || !keys(v, ['draftId', 'versions']) || !isCollectionId(v.draftId) || !Array.isArray(v.versions) || v.versions.length > MAX_RECORDING_PLAN_VERSIONS || !v.versions.every(isRecordingPlanVersion)) return false;
  const versions = v.versions;
  return new Set(versions.map(p => p.id)).size === versions.length && versions.every((p, i) => p.draftId === v.draftId && p.sequence === versions.length - i && (p.sequence === 1 || p.parentId === versions[i + 1]?.id));
}
const issuesByCategory: Record<RecordingPreflightCategory, readonly RecordingPreflightIssue[]> = {
  versions: ['VERSION_MISMATCH'], sources: ['SOURCE_INVALID'], execution: ['EXECUTION_INVALID'], archive: ['ARCHIVE_INVALID'],
  'physical-copy': ['COPY_UNAVAILABLE'], capacity: ['CAPACITY_EXCEEDED', 'COMPATIBILITY_UNCONFIRMED'],
  profile: ['PROFILE_MISMATCH', 'COMPATIBILITY_UNCONFIRMED'], backend: ['BACKEND_NOT_CERTIFIED'],
};
export function isRecordingPreflightCheck(v: unknown): v is RecordingPreflightCheck {
  if (!record(v) || !keys(v, ['category', 'state', 'code']) || !(RECORDING_PREFLIGHT_CATEGORIES as readonly unknown[]).includes(v.category)) return false;
  const category = v.category as RecordingPreflightCategory;
  if (category === 'backend') return v.state === 'not-run' && v.code === 'BACKEND_NOT_CERTIFIED';
  if (v.state === 'passed') return v.code === undefined;
  if (v.state === 'not-run') return v.code === 'NOT_CHECKED';
  return v.state === 'blocked' && (v.code === 'READ_FAILED' || issuesByCategory[category].includes(v.code as RecordingPreflightIssue));
}
export function isRecordingPreflightResult(v: unknown): v is RecordingPreflightResult {
  return record(v) && keys(v, ['planVersionId', 'checkedAt', 'state', 'gateB', 'checks', 'formalReady'])
    && isCollectionId(v.planVersionId) && date(v.checkedAt) && v.state === 'blocked' && v.gateB === 'NOT_RUN' && v.formalReady === false
    && Array.isArray(v.checks) && v.checks.length === RECORDING_PREFLIGHT_CATEGORIES.length && v.checks.every(isRecordingPreflightCheck)
    && new Set(v.checks.map(c => c.category)).size === RECORDING_PREFLIGHT_CATEGORIES.length;
}
