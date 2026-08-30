import { isCollectionId } from './collection.js';
import { isRoonAlbumReference, type DigitalRuntime } from './physical-links.js';
import type { Page, PageRequest } from './library.js';

export type DraftProgramType = 'compilation' | 'concert' | 'continuous';
/** 草稿元数据不代表已校验音频，不能充当 Source Lock。 */
export interface DraftTrackMetadata { title: string; artist?: string; album?: string; version?: string; durationMs?: number; discNumber?: number; trackNumber?: number }
export interface MasterDraftTrack { id: string; source: 'roon'; metadata: DraftTrackMetadata }
export interface MasterDraftSummary { id: string; title: string; programType: DraftProgramType; revision: number; status: 'draft'; sourceLockEligible: boolean; trackCount: number; estimatedDurationMs?: number }
export interface MasterDraft extends MasterDraftSummary { tracks: readonly MasterDraftTrack[] }
export interface AppendMasterDraftRequest { commandId: string; draftId?: string; expectedRevision?: number; title?: string; programType?: DraftProgramType; references: readonly string[]; userConfirmed: true }
export interface UpdateMasterDraftRequest { commandId: string; draftId: string; expectedRevision: number; title: string; programType: DraftProgramType; trackIds: readonly string[] }
export interface MasterDraftResult { draftId: string; trackIds: readonly string[] }
export interface MasterDraftsPublicApi {
  listMasterDrafts(page: PageRequest): Promise<Page<MasterDraftSummary>>;
  getMasterDraft(id: string): Promise<MasterDraft>;
  appendMasterDraft(request: AppendMasterDraftRequest): Promise<MasterDraftResult>;
  updateMasterDraft(request: UpdateMasterDraftRequest): Promise<MasterDraftResult>;
  getMasterDraftTrackRuntime(draftId: string, trackId: string): Promise<DigitalRuntime>;
}
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(v).every(k => allowed.includes(k));
export const isDraftText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 240 && !/[\u0000-\u001f\u007f]/u.test(v);
const integer = (v: unknown, min = 1, max = 1_000_000): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
export const isDraftProgramType = (v: unknown): v is DraftProgramType => ['compilation', 'concert', 'continuous'].includes(String(v));
export function isDraftTrackMetadata(v: unknown): v is DraftTrackMetadata {
  return record(v) && keys(v, ['title', 'artist', 'album', 'version', 'durationMs', 'discNumber', 'trackNumber']) && isDraftText(v.title)
    && ['artist', 'album', 'version'].every(k => v[k] === undefined || isDraftText(v[k]))
    && (v.durationMs === undefined || integer(v.durationMs, 1, 86_400_000)) && (v.discNumber === undefined || integer(v.discNumber, 1, 1000)) && (v.trackNumber === undefined || integer(v.trackNumber, 1, 10000));
}
const summaryKeys = ['id', 'title', 'programType', 'revision', 'status', 'sourceLockEligible', 'trackCount', 'estimatedDurationMs'];
function summary(v: Record<string, unknown>): boolean { return isCollectionId(v.id) && isDraftText(v.title) && isDraftProgramType(v.programType) && integer(v.revision) && v.status === 'draft' && typeof v.sourceLockEligible === 'boolean' && integer(v.trackCount, 0, 200) && (v.estimatedDurationMs === undefined || integer(v.estimatedDurationMs, 0, 20_000_000_000)); }
export function isMasterDraftSummary(v: unknown): v is MasterDraftSummary { return record(v) && keys(v, summaryKeys) && summary(v); }
export function isMasterDraft(v: unknown): v is MasterDraft {
  return record(v) && keys(v, [...summaryKeys, 'tracks']) && summary(v) && Array.isArray(v.tracks) && v.tracks.length === v.trackCount && v.tracks.length <= 200
    && v.tracks.every(t => record(t) && keys(t, ['id', 'source', 'metadata']) && isCollectionId(t.id) && t.source === 'roon' && isDraftTrackMetadata(t.metadata))
    && new Set(v.tracks.map(t => (t as MasterDraftTrack).id)).size === v.tracks.length;
}
export function isAppendMasterDraftRequest(v: unknown): v is AppendMasterDraftRequest {
  return record(v) && keys(v, ['commandId', 'draftId', 'expectedRevision', 'title', 'programType', 'references', 'userConfirmed']) && isCollectionId(v.commandId) && v.userConfirmed === true
    && Array.isArray(v.references) && v.references.length > 0 && v.references.length <= 100 && v.references.every(isRoonAlbumReference) && new Set(v.references).size === v.references.length
    && (v.draftId === undefined ? v.expectedRevision === undefined && isDraftText(v.title) && isDraftProgramType(v.programType) : isCollectionId(v.draftId) && integer(v.expectedRevision) && v.title === undefined && v.programType === undefined);
}
export function isUpdateMasterDraftRequest(v: unknown): v is UpdateMasterDraftRequest {
  return record(v) && keys(v, ['commandId', 'draftId', 'expectedRevision', 'title', 'programType', 'trackIds']) && isCollectionId(v.commandId) && isCollectionId(v.draftId) && integer(v.expectedRevision) && isDraftText(v.title) && isDraftProgramType(v.programType)
    && Array.isArray(v.trackIds) && v.trackIds.length <= 200 && v.trackIds.every(isCollectionId) && new Set(v.trackIds).size === v.trackIds.length;
}
export function isMasterDraftResult(v: unknown): v is MasterDraftResult { return record(v) && keys(v, ['draftId', 'trackIds']) && isCollectionId(v.draftId) && Array.isArray(v.trackIds) && v.trackIds.length <= 200 && v.trackIds.every(isCollectionId) && new Set(v.trackIds).size === v.trackIds.length; }
