import { isCollectionId } from './collection.js';

/** 短时另存目标只给 Renderer 一个不含绝对路径的句柄；关闭窗口、切库或过期即失效。 */
export interface PreparationZipTarget { id: string; label: string; expiresAt: string }
export interface PreviewPreparationZipRequest { workspaceId: string; targetId: string }
export interface PreparationZipProposal {
  workspaceId: string; draftId: string; masterVersionId: string; layoutVersionId: string;
  targetId: string; targetLabel: string; manifestHash: string; fileCount: number; sourceBytes: number;
  proposalFingerprint: string; executionReady: false;
}
export interface StartPreparationZipRequest extends PreviewPreparationZipRequest { commandId: string; proposalFingerprint: string; userConfirmed: true }
/** 只读核对原命令；不能凭任务号或相似目标推断一次请求已被接受。 */
export type PreparationZipReceiptRequest =
  | { kind: 'start'; request: StartPreparationZipRequest }
  | { kind: 'cancel'; request: { commandId: string; id: string } };
export type PreparationZipReceipt =
  | { status: 'accepted'; job: PreparationZipJob }
  | { status: 'not-accepted' | 'unknown'; job: null };
export type PreparationZipFailure = 'WORKSPACE_INVALID' | 'TARGET_INVALID' | 'CONTENT_CHANGED' | 'DISK_FULL' | 'IO_ERROR' | 'CANCELLED' | 'RECOVERY_REQUIRED';
export interface PreparationZipJob {
  id: string; workspaceId: string; draftId: string; state: 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  targetLabel: string; fileCount: number; completedFiles: number; zipSha256?: string; zipBytes?: number;
  failure?: PreparationZipFailure;
}
export interface PreparationZipHistory { draftId: string; jobs: readonly PreparationZipJob[] }
export interface PreparationZipPublicApi {
  choosePreparationZipTarget(workspaceId: string): Promise<PreparationZipTarget | null>;
  previewPreparationZip(request: PreviewPreparationZipRequest): Promise<PreparationZipProposal>;
  startPreparationZip(request: StartPreparationZipRequest): Promise<PreparationZipJob>;
  listPreparationZips(draftId: string): Promise<PreparationZipHistory>;
  getPreparationZipJob(id: string): Promise<{ job: PreparationZipJob | null }>;
  getPreparationZipReceipt(request: PreparationZipReceiptRequest): Promise<PreparationZipReceipt>;
  cancelPreparationZipJob(request: { commandId: string; id: string }): Promise<PreparationZipJob>;
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(v).every(k => allowed.includes(k));
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const integer = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const iso = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(v) && Number.isFinite(Date.parse(v));
const label = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 240 && !/[\u0000-\u001f\u007f]/u.test(v);
export function isPreparationZipTarget(v: unknown): v is PreparationZipTarget {
  return record(v) && keys(v, ['id','label','expiresAt']) && isCollectionId(v.id) && label(v.label) && iso(v.expiresAt);
}
export function isPreviewPreparationZipRequest(v: unknown): v is PreviewPreparationZipRequest {
  return record(v) && keys(v, ['workspaceId','targetId']) && isCollectionId(v.workspaceId) && isCollectionId(v.targetId);
}
export function isPreparationZipProposal(v: unknown): v is PreparationZipProposal {
  return record(v) && keys(v, ['workspaceId','draftId','masterVersionId','layoutVersionId','targetId','targetLabel','manifestHash','fileCount','sourceBytes','proposalFingerprint','executionReady']) &&
    [v.workspaceId,v.draftId,v.masterVersionId,v.layoutVersionId,v.targetId].every(isCollectionId) && label(v.targetLabel) && hash(v.manifestHash) && hash(v.proposalFingerprint) &&
    integer(v.fileCount, 1, 210) && integer(v.sourceBytes, 1, 200 * 68_719_476_736) && v.executionReady === false;
}
export function isStartPreparationZipRequest(v: unknown): v is StartPreparationZipRequest {
  return record(v) && keys(v, ['workspaceId','targetId','commandId','proposalFingerprint','userConfirmed']) &&
    isCollectionId(v.workspaceId) && isCollectionId(v.targetId) && isCollectionId(v.commandId) && hash(v.proposalFingerprint) && v.userConfirmed === true;
}
export function isPreparationZipReceiptRequest(v: unknown): v is PreparationZipReceiptRequest {
  if (!record(v) || !keys(v, ['kind','request']) || !record(v.request)) return false;
  if (v.kind === 'start') return isStartPreparationZipRequest(v.request);
  return v.kind === 'cancel' && keys(v.request, ['commandId','id']) && isCollectionId(v.request.commandId) && isCollectionId(v.request.id);
}
export function isPreparationZipJob(v: unknown): v is PreparationZipJob {
  if (!record(v) || !keys(v, ['id','workspaceId','draftId','state','targetLabel','fileCount','completedFiles','zipSha256','zipBytes','failure']) ||
    !isCollectionId(v.id) || !isCollectionId(v.workspaceId) || !isCollectionId(v.draftId) || !label(v.targetLabel) ||
    !integer(v.fileCount, 1, 210) || !integer(v.completedFiles, 0, v.fileCount)) return false;
  if (v.state === 'completed') return v.completedFiles === v.fileCount && hash(v.zipSha256) && integer(v.zipBytes, 1, Number.MAX_SAFE_INTEGER) && v.failure === undefined;
  if (v.zipSha256 !== undefined || v.zipBytes !== undefined) return false;
  if (v.state === 'failed') return ['WORKSPACE_INVALID','TARGET_INVALID','CONTENT_CHANGED','DISK_FULL','IO_ERROR','RECOVERY_REQUIRED'].includes(String(v.failure));
  if (v.state === 'cancelled') return v.failure === 'CANCELLED';
  return ['running','cancelling','interrupted'].includes(String(v.state)) && v.failure === undefined;
}
export function isPreparationZipReceipt(v: unknown): v is PreparationZipReceipt {
  if (!record(v) || !keys(v, ['status','job'])) return false;
  return v.status === 'accepted' ? isPreparationZipJob(v.job) : (v.status === 'not-accepted' || v.status === 'unknown') && v.job === null;
}
export function isPreparationZipHistory(v: unknown): v is PreparationZipHistory {
  return record(v) && keys(v, ['draftId','jobs']) && isCollectionId(v.draftId) && Array.isArray(v.jobs) && v.jobs.length <= 1000 && v.jobs.every(isPreparationZipJob) && v.jobs.every(j => j.draftId === v.draftId) && new Set(v.jobs.map(j => j.id)).size === v.jobs.length;
}
