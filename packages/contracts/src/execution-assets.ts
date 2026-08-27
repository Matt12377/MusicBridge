import { isCollectionId } from './collection.js';
import { isDraftText } from './master-drafts.js';
import { isExecutionRecipe, isExecutionAudioReceipt, type ExecutionRecipe, type ExecutionAudioReceipt } from './execution-audio.js';
import { isResolvedRecordingSettings, type ResolvedRecordingSettings } from './recording-profile.js';

export interface ExecutionSelection { layoutVersionId: string; mode: 'direct' | 'prepared-reference'; preparedVersionId?: string; destinationId: string; sessionRevision: number }
export interface PreviewExecutionRequest extends ExecutionSelection { readId: string }
export interface StartExecutionRequest extends ExecutionSelection { commandId: string; proposalFingerprint: string; userConfirmed: true }
export interface ExecutionProposal extends ExecutionSelection {
  draftId: string; masterVersionId: string; settings: ResolvedRecordingSettings; recipes: readonly ExecutionRecipe[];
  destinationLabel: string; audioBytesToWrite: number; referencedAudioBytes: number; proposalFingerprint: string;
  retentionPolicy: 'unresolved-no-automatic-deletion'; formalReady: false;
}
export type ExecutionJobFailure = 'SOURCE_INVALID' | 'DESTINATION_INVALID' | 'INPUT_CHANGED' | 'CONVERSION_REQUIRED' | 'IO_ERROR' | 'DISK_FULL' | 'CANCELLED' | 'ASSET_INVALID';
export interface ExecutionJob {
  id: string; draftId: string; layoutVersionId: string; destinationId: string; profileVersionId: string;
  mode: 'direct' | 'prepared-reference'; state: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  completedSides: number; totalSides: number; assetId?: string; failure?: ExecutionJobFailure;
}
/** 只保存当次发布事实；当前文件是否可用须重新验证，发布不等于正式录音就绪。 */
export interface ExecutionAsset {
  id: string; draftId: string; masterVersionId: string; layoutVersionId: string; destinationId: string;
  mode: 'direct' | 'prepared-reference'; preparedVersionId?: string;
  settings: ResolvedRecordingSettings; recipes: readonly ExecutionRecipe[]; audio: readonly ExecutionAudioReceipt[];
  manifestHash: string; createdAt: string; state: 'verified-at-publication';
  retentionPolicy: 'unresolved-no-automatic-deletion'; formalReady: false;
}
export interface ExecutionHistory { draftId: string; assets: readonly ExecutionAsset[]; jobs: readonly ExecutionJob[] }
export interface ExecutionAssetCheck { assetId: string; state: 'verified' | 'unavailable'; checkedAt: string; reason?: 'DESTINATION_INVALID' | 'ASSET_INVALID'; formalReady: false }
export interface VerifyExecutionRequest { assetId: string; readId: string }
export interface RecordingExecutionPublicApi {
  listExecutionAssets(draftId: string): Promise<ExecutionHistory>;
  previewExecutionAsset(request: PreviewExecutionRequest): Promise<ExecutionProposal>;
  startExecutionAsset(request: StartExecutionRequest): Promise<ExecutionJob>;
  getExecutionJob(id: string): Promise<{ job: ExecutionJob | null }>;
  cancelExecutionJob(request: { commandId: string; id: string }): Promise<ExecutionJob>;
  cancelExecutionRead(id: string): Promise<{ cancelled: true }>;
  verifyExecutionAsset(request: VerifyExecutionRequest): Promise<ExecutionAssetCheck>;
}
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(v).every(k => allowed.includes(k));
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const date = (v: unknown): boolean => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(v);
const selectedKeys = ['layoutVersionId','mode','preparedVersionId','destinationId','sessionRevision'];
function selected(v: Record<string, unknown>): boolean { return isCollectionId(v.layoutVersionId) && isCollectionId(v.destinationId) && integer(v.sessionRevision, 1) && (v.mode === 'direct' ? v.preparedVersionId === undefined : v.mode === 'prepared-reference' && isCollectionId(v.preparedVersionId)); }
export function isPreviewExecutionRequest(v: unknown): v is PreviewExecutionRequest { return record(v) && keys(v, [...selectedKeys,'readId']) && selected(v) && isCollectionId(v.readId); }
export function isStartExecutionRequest(v: unknown): v is StartExecutionRequest { return record(v) && keys(v, [...selectedKeys,'commandId','proposalFingerprint','userConfirmed']) && selected(v) && isCollectionId(v.commandId) && hash(v.proposalFingerprint) && v.userConfirmed === true; }
function canonical(v: unknown): string { if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`; if (record(v)) return `{${Object.entries(v).sort(([a],[b]) => a.localeCompare(b)).map(([k,value]) => `${JSON.stringify(k)}:${canonical(value)}`).join(',')}}`; return JSON.stringify(v); }
function material(v: Record<string, unknown>): boolean {
  if (!isCollectionId(v.draftId) || !isCollectionId(v.masterVersionId) || !isCollectionId(v.layoutVersionId) || !isResolvedRecordingSettings(v.settings) || !Array.isArray(v.recipes) || !v.recipes.every(isExecutionRecipe) || !((v.recipes.length === 1 && v.recipes[0]?.side === 'Program') || (v.recipes.length === 2 && v.recipes[0]?.side === 'A' && v.recipes[1]?.side === 'B')) || v.retentionPolicy !== 'unresolved-no-automatic-deletion' || v.formalReady !== false) return false;
  const settings = v.settings;
  return v.recipes.every(r => r.masterVersionId === v.masterVersionId && r.layoutVersionId === v.layoutVersionId && r.contentHash === (v.recipes as ExecutionRecipe[])[0]!.contentHash && r.plannedTimelineHash === (v.recipes as ExecutionRecipe[])[0]!.plannedTimelineHash && r.mode === v.mode && r.prepared?.id === v.preparedVersionId && canonical(r.format) === canonical(settings.format));
}
export function executionAudioSize(recipe: ExecutionRecipe): number { if (!recipe.totalFrames) return 0; const data = recipe.totalFrames * recipe.format.channelCount * Number(recipe.format.outputSampleFormat.slice(5,7)) / 8; return 44 + data + data % 2; }
export function isExecutionProposal(v: unknown): v is ExecutionProposal {
  if (!record(v) || !keys(v, [...selectedKeys,'draftId','masterVersionId','settings','recipes','destinationLabel','audioBytesToWrite','referencedAudioBytes','proposalFingerprint','retentionPolicy','formalReady']) || !selected(v) || !material(v) || !isDraftText(v.destinationLabel) || !integer(v.audioBytesToWrite) || !integer(v.referencedAudioBytes) || !hash(v.proposalFingerprint)) return false;
  const recipes = v.recipes as readonly ExecutionRecipe[];
  return v.mode === 'direct' ? v.referencedAudioBytes === 0 && v.audioBytesToWrite === recipes.reduce((n,r) => n + executionAudioSize(r), 0) : v.audioBytesToWrite === 0 && v.referencedAudioBytes === recipes.reduce((n,r) => n + r.segments.reduce((size,s) => size + (s.kind === 'render' ? s.input.size : 0), 0), 0);
}
export function isExecutionJob(v: unknown): v is ExecutionJob {
  if (!record(v) || !keys(v, ['id','draftId','layoutVersionId','destinationId','profileVersionId','mode','state','completedSides','totalSides','assetId','failure']) || !['id','draftId','layoutVersionId','destinationId','profileVersionId'].every(k => isCollectionId(v[k])) || !(v.mode === 'direct' || v.mode === 'prepared-reference') || !integer(v.totalSides, 1, 2) || !integer(v.completedSides, 0, v.totalSides)) return false;
  if (v.state === 'completed') return isCollectionId(v.assetId) && v.completedSides === v.totalSides && v.failure === undefined;
  if (v.assetId !== undefined) return false;
  if (v.state === 'failed') return typeof v.failure === 'string' && ['SOURCE_INVALID','DESTINATION_INVALID','INPUT_CHANGED','CONVERSION_REQUIRED','IO_ERROR','DISK_FULL','ASSET_INVALID'].includes(v.failure);
  if (v.state === 'cancelled') return v.failure === 'CANCELLED';
  return (v.state === 'running' || v.state === 'interrupted') && v.failure === undefined;
}
export function isExecutionAsset(v: unknown): v is ExecutionAsset {
  if (!record(v) || !keys(v, ['id','draftId','masterVersionId','layoutVersionId','destinationId','mode','preparedVersionId','settings','recipes','audio','manifestHash','createdAt','state','retentionPolicy','formalReady']) || !isCollectionId(v.id) || !isCollectionId(v.destinationId) || !material(v) || !Array.isArray(v.audio) || !v.audio.length || v.audio.length > 2 || !v.audio.every(isExecutionAudioReceipt) || !hash(v.manifestHash) || !date(v.createdAt) || v.state !== 'verified-at-publication') return false;
  const recipes = (v.recipes as readonly ExecutionRecipe[]).filter(r => r.totalFrames > 0);
  return v.audio.length === recipes.length && v.audio.every((receipt,i) => canonical(receipt.recipe) === canonical(recipes[i]));
}
export function isExecutionHistory(v: unknown): v is ExecutionHistory {
  if (!record(v) || !keys(v, ['draftId','assets','jobs']) || !isCollectionId(v.draftId) || !Array.isArray(v.assets) || v.assets.length > 100 || !v.assets.every(isExecutionAsset) || !Array.isArray(v.jobs) || v.jobs.length > 1000 || !v.jobs.every(isExecutionJob)) return false;
  const assets = v.assets;
  return [...assets,...v.jobs].every(i => i.draftId === v.draftId) && new Set(assets.map(a => a.id)).size === assets.length && new Set(v.jobs.map(j => j.id)).size === v.jobs.length && v.jobs.every(j => j.state !== 'completed' || assets.some(a => a.id === j.assetId && a.layoutVersionId === j.layoutVersionId && a.destinationId === j.destinationId && a.mode === j.mode && a.settings.profile.id === j.profileVersionId));
}
export function isExecutionAssetCheck(v: unknown): v is ExecutionAssetCheck { return record(v) && keys(v, ['assetId','state','checkedAt','reason','formalReady']) && isCollectionId(v.assetId) && date(v.checkedAt) && v.formalReady === false && (v.state === 'verified' ? v.reason === undefined : v.state === 'unavailable' && (v.reason === 'DESTINATION_INVALID' || v.reason === 'ASSET_INVALID')); }

export function isVerifyExecutionRequest(v: unknown): v is VerifyExecutionRequest { return record(v) && keys(v, ['assetId','readId']) && isCollectionId(v.assetId) && isCollectionId(v.readId); }
