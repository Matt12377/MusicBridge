import { isCollectionId } from './collection.js';
import { isDraftText } from './master-drafts.js';

export interface PreviewPreparationRequest { layoutVersionId: string; destinationId: string }
export interface StartPreparationRequest extends PreviewPreparationRequest { commandId: string; proposalFingerprint: string; userConfirmed: true }
export interface PreparationDestination { id: string; label: string; authorized: boolean }
export interface PreparationProposal { draftId: string; masterVersionId: string; layoutVersionId: string; destinationId: string; contentHash: string; timelineHash: string; trackCount: number; bytes: number; proposalFingerprint: string; executionReady: false }
export type PreparationFailure = 'SOURCE_INVALID' | 'DESTINATION_INVALID' | 'IO_ERROR' | 'DISK_FULL' | 'CANCELLED';
export interface PreparationJob { id: string; draftId: string; layoutVersionId: string; destinationId: string; state: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'; completedTracks: number; totalTracks: number; workspaceId?: string; failure?: PreparationFailure }
/** 完成只证明导出时副本完整；用户可以编辑，后续 PREP 导入必须独立验证。 */
export interface PreparationWorkspace { id: string; draftId: string; masterVersionId: string; layoutVersionId: string; destinationId: string; createdAt: string; manifestHash: string; trackCount: number; bytes: number; kind: 'logic-working-copy'; executionReady: false }
export interface PreparationHistory { draftId: string; workspaces: readonly PreparationWorkspace[]; jobs: readonly PreparationJob[] }
export interface PreparationPublicApi {
  listPreparationDestinations(): Promise<{ destinations: readonly PreparationDestination[] }>;
  choosePreparationDestination(commandId: string): Promise<PreparationDestination | null>;
  revokePreparationDestination(request: { commandId: string; id: string }): Promise<PreparationDestination>;
  listPreparations(draftId: string): Promise<PreparationHistory>;
  previewPreparation(request: PreviewPreparationRequest): Promise<PreparationProposal>;
  startPreparation(request: StartPreparationRequest): Promise<PreparationJob>;
  getPreparationJob(id: string): Promise<{ job: PreparationJob | null }>;
  cancelPreparationJob(request: { commandId: string; id: string }): Promise<PreparationJob>;
  openPreparationWorkspace(id: string): Promise<{ opened: true }>;
}
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(v).every(k => allowed.includes(k));
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
export function isPreparationDestination(v: unknown): v is PreparationDestination { return record(v) && keys(v, ['id','label','authorized']) && isCollectionId(v.id) && isDraftText(v.label) && v.label.length <= 240 && typeof v.authorized === 'boolean'; }
export function isPreviewPreparationRequest(v: unknown): v is PreviewPreparationRequest { return record(v) && keys(v, ['layoutVersionId', 'destinationId']) && isCollectionId(v.layoutVersionId) && isCollectionId(v.destinationId); }
export function isStartPreparationRequest(v: unknown): v is StartPreparationRequest { return record(v) && keys(v, ['layoutVersionId', 'destinationId', 'commandId', 'proposalFingerprint', 'userConfirmed']) && isCollectionId(v.layoutVersionId) && isCollectionId(v.destinationId) && isCollectionId(v.commandId) && typeof v.proposalFingerprint === 'string' && /^[a-f0-9]{64}$/u.test(v.proposalFingerprint) && v.userConfirmed === true; }
export function isPreparationProposal(v: unknown): v is PreparationProposal {
  return record(v) && keys(v, ['draftId','masterVersionId','layoutVersionId','destinationId','contentHash','timelineHash','trackCount','bytes','proposalFingerprint','executionReady']) && ['draftId','masterVersionId','layoutVersionId','destinationId'].every(k => isCollectionId(v[k])) && hash(v.contentHash) && hash(v.timelineHash) && hash(v.proposalFingerprint) && integer(v.trackCount, 1, 200) && integer(v.bytes, 1, 200 * 68_719_476_736) && v.executionReady === false;
}
export function isPreparationJob(v: unknown): v is PreparationJob {
  if (!record(v) || !keys(v, ['id','draftId','layoutVersionId','destinationId','state','completedTracks','totalTracks','workspaceId','failure']) || !['id','draftId','layoutVersionId','destinationId'].every(k => isCollectionId(v[k])) || !integer(v.totalTracks, 1, 200) || !integer(v.completedTracks, 0, v.totalTracks)) return false;
  if (v.state === 'completed') return isCollectionId(v.workspaceId) && v.completedTracks === v.totalTracks && v.failure === undefined;
  if (v.workspaceId !== undefined) return false;
  if (v.state === 'failed') return ['SOURCE_INVALID','DESTINATION_INVALID','IO_ERROR','DISK_FULL'].includes(String(v.failure));
  if (v.state === 'cancelled') return v.failure === 'CANCELLED';
  return ['running','interrupted'].includes(String(v.state)) && v.failure === undefined;
}
export function isPreparationWorkspace(v: unknown): v is PreparationWorkspace {
  return record(v) && keys(v, ['id','draftId','masterVersionId','layoutVersionId','destinationId','createdAt','manifestHash','trackCount','bytes','kind','executionReady']) && ['id','draftId','masterVersionId','layoutVersionId','destinationId'].every(k => isCollectionId(v[k])) && typeof v.createdAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(v.createdAt) && hash(v.manifestHash) && integer(v.trackCount, 1, 200) && integer(v.bytes, 1, 200 * 68_719_476_736) && v.kind === 'logic-working-copy' && v.executionReady === false;
}
export function isPreparationHistory(v: unknown): v is PreparationHistory {
  if (!record(v) || !keys(v, ['draftId','workspaces','jobs']) || !isCollectionId(v.draftId) || !Array.isArray(v.workspaces) || v.workspaces.length > 100 || !v.workspaces.every(isPreparationWorkspace) || !Array.isArray(v.jobs) || v.jobs.length > 1000 || !v.jobs.every(isPreparationJob)) return false;
  const workspaces = v.workspaces;
  return [...workspaces, ...v.jobs].every(item => item.draftId === v.draftId) && new Set(workspaces.map(w => w.id)).size === workspaces.length && new Set(v.jobs.map(j => j.id)).size === v.jobs.length && v.jobs.every(j => j.state !== 'completed' || workspaces.some(w => w.id === j.workspaceId && w.layoutVersionId === j.layoutVersionId && w.destinationId === j.destinationId));
}
