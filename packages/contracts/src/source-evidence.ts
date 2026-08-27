import { isCollectionId } from './collection.js';
import { isDraftText } from './master-drafts.js';

export type SourceAcquisition = 'userFileBind' | 'roonDesktopExport';
export type SourceAvailability = 'ONLINE' | 'SOURCE_ROOT_OFFLINE' | 'MISSING' | 'CONTENT_CHANGED' | 'REVOKED';
export interface SourceRoot { id: string; label: string; authorized: boolean; availability: 'ONLINE' | 'SOURCE_ROOT_OFFLINE' | 'REVOKED' }
export interface SourceTechnical { container: string; codec: string; sampleRate: number; channels: number; durationMs: number; bitsPerSample?: number; lossless: boolean; sampleFrames?: number; frameEvidence?: 'container-declared' }
export interface SourceBinding {
  id: string; rootId: string; fileName: string; acquisition: SourceAcquisition;
  verification: 'fileHashVerified'; preservation: 'externalReferenceOnly';
  availability: SourceAvailability; sha256: string; size: number; modifiedAt: string; verifiedAt: string;
  technical: SourceTechnical; userConfirmed: boolean; sourceLockEligible: boolean;
}
export type SourceJobState = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type SourceFailure = 'SOURCE_ROOT_OFFLINE' | 'MISSING' | 'CONTENT_CHANGED' | 'REVOKED' | 'OUTSIDE_ROOT' | 'UNSUPPORTED' | 'LIMIT_EXCEEDED' | 'IO_ERROR' | 'CANCELLED' | 'DRAFT_CHANGED' | 'HASH_MISMATCH';
export interface SourceJob { id: string; draftId: string; trackId: string; rootId: string; state: SourceJobState; bindingId?: string; failure?: SourceFailure }
export interface DraftSourceSnapshot { draftId: string; sourceLockEligible: boolean; tracks: readonly { trackId: string; binding?: SourceBinding; jobs: readonly SourceJob[] }[] }
export interface SourceSelection { commandId: string; draftId: string; trackId: string; rootId: string; acquisition: SourceAcquisition; relocateBindingId?: string }
export interface SourceAction { commandId: string; id: string }
export interface SourceConfirmation extends SourceAction { draftId: string; trackId: string; userConfirmed: true }
export interface RecordingSourcesPublicApi {
  listRecordingSourceRoots(): Promise<{ roots: readonly SourceRoot[] }>;
  chooseRecordingSourceRoot(commandId: string): Promise<SourceRoot | null>;
  revokeRecordingSourceRoot(request: SourceAction): Promise<SourceRoot>;
  chooseRecordingSource(request: SourceSelection): Promise<SourceJob | null>;
  getDraftSources(draftId: string): Promise<DraftSourceSnapshot>;
  getRecordingSourceJob(id: string): Promise<{ job: SourceJob | null }>;
  cancelRecordingSourceJob(request: SourceAction): Promise<SourceJob>;
  recheckRecordingSource(request: SourceConfirmation): Promise<SourceJob>;
  confirmRecordingSource(request: SourceConfirmation): Promise<SourceBinding>;
}
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, list: readonly string[]): boolean => Object.keys(v).every(k => list.includes(k));
const integer = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const one = (v: unknown, list: readonly string[]): boolean => typeof v === 'string' && list.includes(v);
export const isSourceAcquisition = (v: unknown): v is SourceAcquisition => one(v, ['userFileBind', 'roonDesktopExport']);
export const isSourceAction = (v: unknown): v is SourceAction => record(v) && keys(v, ['commandId', 'id']) && isCollectionId(v.commandId) && isCollectionId(v.id);
export const isSourceConfirmation = (v: unknown): v is SourceConfirmation => record(v) && keys(v, ['commandId', 'id', 'draftId', 'trackId', 'userConfirmed']) && ['commandId', 'id', 'draftId', 'trackId'].every(k => isCollectionId(v[k])) && v.userConfirmed === true;
export function isSourceSelection(v: unknown): v is SourceSelection { return record(v) && keys(v, ['commandId', 'draftId', 'trackId', 'rootId', 'acquisition', 'relocateBindingId']) && ['commandId', 'draftId', 'trackId', 'rootId'].every(k => isCollectionId(v[k])) && isSourceAcquisition(v.acquisition) && (v.relocateBindingId === undefined || isCollectionId(v.relocateBindingId)); }
export function isSourceRoot(v: unknown): v is SourceRoot { return record(v) && keys(v, ['id', 'label', 'authorized', 'availability']) && isCollectionId(v.id) && isDraftText(v.label) && typeof v.authorized === 'boolean' && one(v.availability, ['ONLINE', 'SOURCE_ROOT_OFFLINE', 'REVOKED']) && (v.authorized === (v.availability !== 'REVOKED')); }
export function isSourceTechnical(v: unknown): v is SourceTechnical { return record(v) && keys(v, ['container', 'codec', 'sampleRate', 'channels', 'durationMs', 'bitsPerSample', 'lossless', 'sampleFrames', 'frameEvidence']) && isDraftText(v.container) && isDraftText(v.codec) && integer(v.sampleRate, 1, 50_000_000) && integer(v.channels, 1, 64) && integer(v.durationMs, 1, 86_400_000) && (v.bitsPerSample === undefined || integer(v.bitsPerSample, 1, 64)) && typeof v.lossless === 'boolean' && (v.sampleFrames === undefined ? v.frameEvidence === undefined : integer(v.sampleFrames, 1, Number.MAX_SAFE_INTEGER) && v.frameEvidence === 'container-declared' && Math.round(v.sampleFrames / v.sampleRate * 1000) === v.durationMs); }
export function isSourceBinding(v: unknown): v is SourceBinding {
  return record(v) && keys(v, ['id', 'rootId', 'fileName', 'acquisition', 'verification', 'preservation', 'availability', 'sha256', 'size', 'modifiedAt', 'verifiedAt', 'technical', 'userConfirmed', 'sourceLockEligible']) && isCollectionId(v.id) && isCollectionId(v.rootId) && isDraftText(v.fileName) && !/[\/\\]/u.test(v.fileName) && isSourceAcquisition(v.acquisition) && v.verification === 'fileHashVerified' && v.preservation === 'externalReferenceOnly' && one(v.availability, ['ONLINE', 'SOURCE_ROOT_OFFLINE', 'MISSING', 'CONTENT_CHANGED', 'REVOKED']) && typeof v.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(v.sha256) && integer(v.size, 1, 68_719_476_736) && typeof v.modifiedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(v.modifiedAt) && typeof v.verifiedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(v.verifiedAt) && isSourceTechnical(v.technical) && typeof v.userConfirmed === 'boolean' && typeof v.sourceLockEligible === 'boolean' && v.sourceLockEligible === (v.userConfirmed && v.availability === 'ONLINE');
}
export function isSourceJob(v: unknown): v is SourceJob { return record(v) && keys(v, ['id', 'draftId', 'trackId', 'rootId', 'state', 'bindingId', 'failure']) && ['id', 'draftId', 'trackId', 'rootId'].every(k => isCollectionId(v[k])) && one(v.state, ['running', 'completed', 'failed', 'cancelled', 'interrupted']) && (v.bindingId === undefined || isCollectionId(v.bindingId)) && (v.failure === undefined || one(v.failure, ['SOURCE_ROOT_OFFLINE', 'MISSING', 'CONTENT_CHANGED', 'REVOKED', 'OUTSIDE_ROOT', 'UNSUPPORTED', 'LIMIT_EXCEEDED', 'IO_ERROR', 'CANCELLED', 'DRAFT_CHANGED', 'HASH_MISMATCH'])) && (v.state !== 'completed' || isCollectionId(v.bindingId)); }
export function isDraftSourceSnapshot(v: unknown): v is DraftSourceSnapshot { return record(v) && keys(v, ['draftId', 'sourceLockEligible', 'tracks']) && isCollectionId(v.draftId) && typeof v.sourceLockEligible === 'boolean' && Array.isArray(v.tracks) && v.tracks.length <= 200 && v.tracks.every(t => record(t) && keys(t, ['trackId', 'binding', 'jobs']) && isCollectionId(t.trackId) && (t.binding === undefined || isSourceBinding(t.binding)) && Array.isArray(t.jobs) && t.jobs.length <= 20 && t.jobs.every(isSourceJob)) && v.sourceLockEligible === (v.tracks.length > 0 && v.tracks.every(t => (t as {binding?: SourceBinding}).binding?.sourceLockEligible === true)); }
