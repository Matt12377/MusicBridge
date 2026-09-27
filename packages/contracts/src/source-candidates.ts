import { isCollectionId } from './collection.js';
import { isSourceAction, isSourceSelection, type SourceAction, type SourceJob, type SourceSelection } from './source-evidence.js';

/** 候选只是路径/文件名线索，不能作为已验证源或版本对应的证据。 */
export interface SourceCandidate {
  id: string;
  fileName: string;
  relativeLabel: string;
  extension: 'wav' | 'wave' | 'flac' | 'aiff' | 'aif';
  size: number;
  modifiedAt: string;
}
export type SourceCandidateScanState = 'running' | 'completed' | 'truncated' | 'cancelled' | 'failed';
export type SourceCandidateStopReason = 'ENTRY_LIMIT' | 'DEPTH_LIMIT' | 'RESULT_LIMIT' | 'TIME_LIMIT' | 'IO_ERROR' | 'ROOT_CHANGED' | 'DRAFT_CHANGED';
export interface SourceCandidateScan {
  id: string;
  rootId: string;
  draftId: string;
  trackId: string;
  expectedDraftRevision: number;
  state: SourceCandidateScanState;
  scannedEntries: number;
  skippedSymlinks: number;
  skippedUnreadable: number;
  stopReason?: SourceCandidateStopReason;
  candidates: readonly SourceCandidate[];
}
export interface StartSourceCandidateScan { commandId: string; rootId: string; draftId: string; trackId: string; expectedDraftRevision: number }
export interface SelectSourceCandidate extends SourceSelection { candidate: NonNullable<SourceSelection['candidate']> }
export interface SourceCandidatesPublicApi {
  startRecordingSourceCandidateScan(request: StartSourceCandidateScan): Promise<SourceCandidateScan>;
  getRecordingSourceCandidateScan(id: string): Promise<{ scan: SourceCandidateScan | null }>;
  cancelRecordingSourceCandidateScan(request: SourceAction): Promise<SourceCandidateScan>;
  selectRecordingSourceCandidate(request: SelectSourceCandidate): Promise<SourceJob>;
}
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(v).every(key => allowed.includes(key));
const revision = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= 1_000_000;
const date = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(v) && Number.isFinite(Date.parse(v));
const safeLabel = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 240 && !/[\u0000-\u001f\u007f]/u.test(v) && !v.startsWith('/') && !v.startsWith('\\');
export function isStartSourceCandidateScan(v: unknown): v is StartSourceCandidateScan {
  return record(v) && keys(v, ['commandId', 'rootId', 'draftId', 'trackId', 'expectedDraftRevision'])
    && ['commandId', 'rootId', 'draftId', 'trackId'].every(key => isCollectionId(v[key])) && revision(v.expectedDraftRevision);
}
export function isSelectSourceCandidate(v: unknown): v is SelectSourceCandidate { return isSourceSelection(v) && v.candidate !== undefined; }
export function isSourceCandidate(v: unknown): v is SourceCandidate {
  return record(v) && keys(v, ['id', 'fileName', 'relativeLabel', 'extension', 'size', 'modifiedAt'])
    && isCollectionId(v.id) && safeLabel(v.fileName) && !/[\\/]/u.test(v.fileName) && safeLabel(v.relativeLabel)
    && ['wav', 'wave', 'flac', 'aiff', 'aif'].includes(String(v.extension))
    && typeof v.size === 'number' && Number.isSafeInteger(v.size) && v.size >= 1 && v.size <= 68_719_476_736 && date(v.modifiedAt);
}
export function isSourceCandidateScan(v: unknown): v is SourceCandidateScan {
  return record(v) && keys(v, ['id', 'rootId', 'draftId', 'trackId', 'expectedDraftRevision', 'state', 'scannedEntries', 'skippedSymlinks', 'skippedUnreadable', 'stopReason', 'candidates'])
    && ['id', 'rootId', 'draftId', 'trackId'].every(key => isCollectionId(v[key])) && revision(v.expectedDraftRevision)
    && ['running', 'completed', 'truncated', 'cancelled', 'failed'].includes(String(v.state))
    && [v.scannedEntries, v.skippedSymlinks, v.skippedUnreadable].every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= 3000)
    && (v.stopReason === undefined || ['ENTRY_LIMIT', 'DEPTH_LIMIT', 'RESULT_LIMIT', 'TIME_LIMIT', 'IO_ERROR', 'ROOT_CHANGED', 'DRAFT_CHANGED'].includes(String(v.stopReason)))
    && Array.isArray(v.candidates) && v.candidates.length <= 200 && v.candidates.every(isSourceCandidate)
    && new Set(v.candidates.map(item => item.id)).size === v.candidates.length
    && (v.state !== 'completed' || v.stopReason === undefined)
    && (v.state !== 'truncated' || v.stopReason !== undefined);
}
export { isSourceAction };
