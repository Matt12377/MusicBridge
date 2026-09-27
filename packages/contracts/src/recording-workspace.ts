import { isCollectionId, isPhysicalId } from './collection.js';

export type RecordingWorkspacePagePosition = 'my-work' | 'workbench' | 'source' | 'media' | 'versions' | 'logic' | 'prepared' | 'assets' | 'plan' | 'archive' | 'backup';
export interface RecordingWorkspaceSelection {
  planId?: string;
  layoutId?: string;
  path?: 'direct' | 'logic' | 'prep';
  preparationId?: string;
  preparedId?: string;
  selectedPhysicalId?: string;
}
export interface RecordingWorkspaceStaleReason {
  field: 'draft' | keyof RecordingWorkspaceSelection;
  reason: 'draft-changed' | 'missing' | 'different-draft' | 'plan-changed' | 'reservation-changed' | 'copy-unavailable';
}
/** 草稿相关的用户工作位置，不是录音计划、预留或已完成事实。 */
export interface RecordingWorkspaceContext {
  draftId: string;
  draftRevision: number;
  contextRevision: number;
  selection: RecordingWorkspaceSelection;
  pagePosition: RecordingWorkspacePagePosition;
  staleReasons: readonly RecordingWorkspaceStaleReason[];
}
export interface PutRecordingWorkspaceContextRequest {
  commandId: string;
  draftId: string;
  expectedDraftRevision: number;
  /** 0 仅用于该草稿尚无持久工作上下文。 */
  expectedContextRevision: number;
  selection: RecordingWorkspaceSelection;
  pagePosition: RecordingWorkspacePagePosition;
}
export interface RecordingWorkspacePublicApi {
  getRecordingWorkspaceContext(draftId: string): Promise<RecordingWorkspaceContext | null>;
  putRecordingWorkspaceContext(request: PutRecordingWorkspaceContextRequest): Promise<RecordingWorkspaceContext>;
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(v).every(k => allowed.includes(k));
const integer = (v: unknown, min = 0): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
const pagePositions: readonly string[] = ['my-work', 'workbench', 'source', 'media', 'versions', 'logic', 'prepared', 'assets', 'plan', 'archive', 'backup'];
const fields: readonly string[] = ['draft', 'planId', 'layoutId', 'path', 'preparationId', 'preparedId', 'selectedPhysicalId'];
const reasons: readonly string[] = ['draft-changed', 'missing', 'different-draft', 'plan-changed', 'reservation-changed', 'copy-unavailable'];
export const isRecordingWorkspacePagePosition = (v: unknown): v is RecordingWorkspacePagePosition => typeof v === 'string' && pagePositions.includes(v);
export function isRecordingWorkspaceSelection(v: unknown): v is RecordingWorkspaceSelection {
  return record(v) && keys(v, ['planId', 'layoutId', 'path', 'preparationId', 'preparedId', 'selectedPhysicalId'])
    && ['planId', 'layoutId', 'preparationId', 'preparedId'].every(k => v[k] === undefined || isCollectionId(v[k]))
    && (v.path === undefined || ['direct', 'logic', 'prep'].includes(String(v.path)))
    && (v.selectedPhysicalId === undefined || isPhysicalId(v.selectedPhysicalId));
}
export function isPutRecordingWorkspaceContextRequest(v: unknown): v is PutRecordingWorkspaceContextRequest {
  return record(v) && keys(v, ['commandId', 'draftId', 'expectedDraftRevision', 'expectedContextRevision', 'selection', 'pagePosition'])
    && isCollectionId(v.commandId) && isCollectionId(v.draftId) && integer(v.expectedDraftRevision, 1)
    && integer(v.expectedContextRevision) && isRecordingWorkspaceSelection(v.selection) && isRecordingWorkspacePagePosition(v.pagePosition);
}
export function isRecordingWorkspaceContext(v: unknown): v is RecordingWorkspaceContext {
  return record(v) && keys(v, ['draftId', 'draftRevision', 'contextRevision', 'selection', 'pagePosition', 'staleReasons'])
    && isCollectionId(v.draftId) && integer(v.draftRevision, 1) && integer(v.contextRevision, 1)
    && isRecordingWorkspaceSelection(v.selection) && isRecordingWorkspacePagePosition(v.pagePosition)
    && Array.isArray(v.staleReasons) && v.staleReasons.length <= 8
    && v.staleReasons.every(item => record(item) && keys(item, ['field', 'reason']) && fields.includes(String(item.field)) && reasons.includes(String(item.reason)));
}
