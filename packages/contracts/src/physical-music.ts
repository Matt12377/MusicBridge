import { isCollectionId, isPhysicalId, isCollectionPhotoImage, isPhysicalRecordingSummary, type PhysicalRecordingSummary, type CollectionPhotoImage } from './collection.js';
import type { Page, PageRequest } from './library.js';

export interface MusicTrack { title: string; artist: string; position: number; disc?: number; side?: 'A' | 'B'; durationSeconds?: number }
export interface MusicContent { title: string; artist: string; tracks: readonly MusicTrack[]; year?: number; edition?: string; notes?: string; storage?: string }
export interface CommercialRelease extends MusicContent {
  format: 'cd' | 'cassette'; quantity: number; completeness: 'basic' | 'partial' | 'verified';
  label?: string; catalogNumber?: string; barcode?: string; region?: string; discCount?: number;
  packaging?: string; condition?: string; purchaseInfo?: string; tapeType?: 'I' | 'II' | 'III' | 'IV' | 'unknown';
  noiseReduction?: string; tapeCondition?: string; jCardCondition?: string; caseCondition?: string;
}
export type MusicKind = 'cd' | 'cassette' | 'personal-cassette' | 'personal-dat';
export interface MusicEntry { id: string; kind: MusicKind; title: string; artist: string; quantity: number; revision: number; contentStatus: 'commercial' | 'legacy' | 'missing' | 'formal' | 'formal-current-unknown'; modelId?: string; photo?: MusicPhoto; recordingState?: PhysicalRecordingSummary }
export interface MusicPhoto { id: string; releaseId: string; width: number; height: number; source: 'user-photo' }
export interface MusicDetail { entry: MusicEntry; release?: CommercialRelease; recording?: MusicContent; photos: readonly MusicPhoto[]; formal?: PhysicalRecordingSummary }
/** 商业发行原有 quantity 不变；只有明确逐件操作才赋予永久身份。 */
export interface CommercialCopyDetails { location?: string; condition?: string; purchaseInfo?: string }
export interface CommercialCopy { id: string; releaseId: string; assignedAt: string; revision: number; details: CommercialCopyDetails; photoIds: readonly string[] }
export interface CommercialCopiesSnapshot { releaseId: string; quantity: number; assignedCount: number; poolCount: number; photoAssignments: readonly { photoId: string; copyId: string }[]; copies: Page<CommercialCopy> }
export interface MaterializeCommercialCopyRequest { commandId: string; releaseId: string; expectedRevision: number; userConfirmed: true }
export interface SaveCommercialCopyDetailsRequest { commandId: string; copyId: string; expectedRevision: number; details: CommercialCopyDetails; userConfirmed: true }
export interface AssignCommercialCopyPhotoRequest { commandId: string; copyId: string; photoId: string; expectedRevision: number; action: 'attach' | 'detach'; userConfirmed: true }
export interface MusicFilter { query?: string; kind?: MusicKind }
export interface SaveReleaseRequest { commandId: string; id?: string; expectedRevision?: number; release: CommercialRelease }
export interface SaveLegacyRequest { commandId: string; physicalId: string; expectedRevision: number; content: MusicContent }
export interface MusicMutationResult { id: string; photoId?: string; copyId?: string }
export interface AddMusicPhotoRequest { commandId: string; id: string; image: CollectionPhotoImage }
export interface RemoveMusicPhotoRequest { commandId: string; id: string; photoId: string; expectedRevision: number }
export interface PhysicalMusicPublicApi {
  listPhysicalMusic(page: PageRequest, filter?: MusicFilter): Promise<Page<MusicEntry>>;
  getPhysicalMusic(id: string): Promise<MusicDetail>;
  getCommercialCopies(releaseId: string, page: PageRequest): Promise<CommercialCopiesSnapshot>;
  savePhysicalRelease(request: SaveReleaseRequest): Promise<MusicMutationResult>;
  materializeCommercialCopy(request: MaterializeCommercialCopyRequest): Promise<MusicMutationResult>;
  saveCommercialCopyDetails(request: SaveCommercialCopyDetailsRequest): Promise<MusicMutationResult>;
  assignCommercialCopyPhoto(request: AssignCommercialCopyPhotoRequest): Promise<MusicMutationResult>;
  saveLegacyRecording(request: SaveLegacyRequest): Promise<MusicMutationResult>;
  addPhysicalMusicPhoto(request: AddMusicPhotoRequest): Promise<MusicMutationResult>;
  getPhysicalMusicPhoto(photoId: string): Promise<CollectionPhotoImage>;
  removePhysicalMusicPhoto(request: RemoveMusicPhotoRequest): Promise<MusicMutationResult>;
}
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(v).every(k => allowed.includes(k));
const text = (v: unknown, empty = false, max = 240): v is string => typeof v === 'string' && v.length <= max && (empty || v.trim().length > 0) && !/[\u0000-\u001f\u007f]/u.test(v);
const integer = (v: unknown, min = 1, max = 1_000_000): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
export const isMusicId = (v: unknown): v is string => isCollectionId(v) || isPhysicalId(v);
const kinds = ['cd', 'cassette', 'personal-cassette', 'personal-dat'];
const contentKeys = ['title', 'artist', 'tracks', 'year', 'edition', 'notes', 'storage'];
const releaseStrings = ['label', 'catalogNumber', 'barcode', 'region', 'packaging', 'condition', 'purchaseInfo', 'noiseReduction', 'tapeCondition', 'jCardCondition', 'caseCondition'];
function content(v: Record<string, unknown>): boolean {
  return text(v.title) && text(v.artist) && (v.year === undefined || integer(v.year, 1900, 2200))
    && ['edition', 'storage', 'notes'].every(k => v[k] === undefined || text(v[k], true, k === 'notes' ? 2000 : 240))
    && Array.isArray(v.tracks) && v.tracks.length <= 200 && v.tracks.every(t => record(t) && keys(t, ['title', 'artist', 'position', 'disc', 'side', 'durationSeconds'])
      && text(t.title) && text(t.artist, true) && integer(t.position, 1, 200)
      && (t.disc === undefined || integer(t.disc, 1, 100)) && (t.side === undefined || ['A', 'B'].includes(String(t.side)))
      && (t.durationSeconds === undefined || integer(t.durationSeconds, 1, 86400)))
    && new Set((v.tracks as MusicTrack[]).map(t => `${t.disc ?? 1}:${t.side ?? ''}:${t.position}`)).size === v.tracks.length;
}
export function isMusicContent(v: unknown): v is MusicContent { return record(v) && keys(v, contentKeys) && content(v); }
export function isCommercialRelease(v: unknown): v is CommercialRelease {
  return record(v) && keys(v, [...contentKeys, ...releaseStrings, 'format', 'quantity', 'completeness', 'discCount', 'tapeType']) && content(v)
    && ['cd', 'cassette'].includes(String(v.format)) && integer(v.quantity, 1, 10000) && ['basic', 'partial', 'verified'].includes(String(v.completeness))
    && releaseStrings.every(k => v[k] === undefined || text(v[k], true)) && (v.discCount === undefined || integer(v.discCount, 1, 100))
    && (v.tapeType === undefined || ['I', 'II', 'III', 'IV', 'unknown'].includes(String(v.tapeType)))
    && (v.completeness !== 'verified' || text(v.edition))
    && (v.tracks as MusicTrack[]).every(t => v.format === 'cd' ? t.side === undefined && (t.disc ?? 1) <= Number(v.discCount ?? 1) : t.side !== undefined && t.disc === undefined);
}
export function isMusicFilter(v: unknown): v is MusicFilter { return record(v) && keys(v, ['query', 'kind']) && (v.query === undefined || text(v.query, true)) && (v.kind === undefined || kinds.includes(String(v.kind))); }
export function isSaveReleaseRequest(v: unknown): v is SaveReleaseRequest { return record(v) && keys(v, ['commandId', 'id', 'expectedRevision', 'release']) && isCollectionId(v.commandId) && isCommercialRelease(v.release) && (v.id === undefined ? v.expectedRevision === undefined : isCollectionId(v.id) && integer(v.expectedRevision)); }
export function isMaterializeCommercialCopyRequest(v: unknown): v is MaterializeCommercialCopyRequest { return record(v) && keys(v, ['commandId', 'releaseId', 'expectedRevision', 'userConfirmed']) && isCollectionId(v.commandId) && isCollectionId(v.releaseId) && integer(v.expectedRevision) && v.userConfirmed === true; }
export function isCommercialCopyDetails(v: unknown): v is CommercialCopyDetails { return record(v) && keys(v, ['location', 'condition', 'purchaseInfo']) && ['location', 'condition', 'purchaseInfo'].every(key => v[key] === undefined || text(v[key], true, key === 'purchaseInfo' ? 1000 : 240)); }
export function isSaveCommercialCopyDetailsRequest(v: unknown): v is SaveCommercialCopyDetailsRequest { return record(v) && keys(v, ['commandId', 'copyId', 'expectedRevision', 'details', 'userConfirmed']) && isCollectionId(v.commandId) && isCollectionId(v.copyId) && integer(v.expectedRevision) && isCommercialCopyDetails(v.details) && v.userConfirmed === true; }
export function isAssignCommercialCopyPhotoRequest(v: unknown): v is AssignCommercialCopyPhotoRequest { return record(v) && keys(v, ['commandId', 'copyId', 'photoId', 'expectedRevision', 'action', 'userConfirmed']) && isCollectionId(v.commandId) && isCollectionId(v.copyId) && isCollectionId(v.photoId) && integer(v.expectedRevision) && ['attach', 'detach'].includes(String(v.action)) && v.userConfirmed === true; }
export function isSaveLegacyRequest(v: unknown): v is SaveLegacyRequest { return record(v) && keys(v, ['commandId', 'physicalId', 'expectedRevision', 'content']) && isCollectionId(v.commandId) && isPhysicalId(v.physicalId) && integer(v.expectedRevision) && isMusicContent(v.content); }
export function isMusicMutationResult(v: unknown): v is MusicMutationResult { return record(v) && keys(v, ['id', 'photoId', 'copyId']) && isMusicId(v.id) && (v.photoId === undefined || isCollectionId(v.photoId)) && (v.copyId === undefined || isCollectionId(v.copyId)); }
export function isCommercialCopy(v: unknown): v is CommercialCopy { return record(v) && keys(v, ['id', 'releaseId', 'assignedAt', 'revision', 'details', 'photoIds']) && isCollectionId(v.id) && isCollectionId(v.releaseId) && typeof v.assignedAt === 'string' && !Number.isNaN(Date.parse(v.assignedAt))
  && integer(v.revision) && isCommercialCopyDetails(v.details) && Array.isArray(v.photoIds) && v.photoIds.length <= 24 && v.photoIds.every(isCollectionId) && new Set(v.photoIds).size === v.photoIds.length; }
export function isCommercialCopiesSnapshot(v: unknown): v is CommercialCopiesSnapshot {
  if (!record(v) || !keys(v, ['releaseId', 'quantity', 'assignedCount', 'poolCount', 'photoAssignments', 'copies']) || !isCollectionId(v.releaseId) || !integer(v.quantity, 1, 10000)
    || !integer(v.assignedCount, 0, 10000) || !integer(v.poolCount, 0, 10000) || v.quantity !== v.assignedCount + v.poolCount || !record(v.copies)) return false;
  const copies = v.copies;
  return Array.isArray(v.photoAssignments) && v.photoAssignments.length <= 24 && v.photoAssignments.every(item => record(item) && keys(item, ['photoId', 'copyId']) && isCollectionId(item.photoId) && isCollectionId(item.copyId))
    && new Set(v.photoAssignments.map(item => item.photoId)).size === v.photoAssignments.length
    && integer(copies.offset, 0) && integer(copies.limit, 1, 100) && integer(copies.total, 0, 10000) && copies.total === v.assignedCount
    && typeof copies.hasMore === 'boolean' && Array.isArray(copies.items) && copies.items.length <= copies.limit && copies.items.every(copy => isCommercialCopy(copy) && copy.releaseId === v.releaseId);
}
export function isAddMusicPhotoRequest(v: unknown): v is AddMusicPhotoRequest { return record(v) && keys(v, ['commandId', 'id', 'image']) && isCollectionId(v.commandId) && isCollectionId(v.id) && isCollectionPhotoImage(v.image); }
export function isRemoveMusicPhotoRequest(v: unknown): v is RemoveMusicPhotoRequest { return record(v) && keys(v, ['commandId', 'id', 'photoId', 'expectedRevision']) && isCollectionId(v.commandId) && isCollectionId(v.id) && isCollectionId(v.photoId) && integer(v.expectedRevision); }
export function isMusicPhoto(v: unknown): v is MusicPhoto { return record(v) && keys(v, ['id', 'releaseId', 'width', 'height', 'source']) && isCollectionId(v.id) && isCollectionId(v.releaseId) && integer(v.width, 1, 1200) && integer(v.height, 1, 1200) && v.source === 'user-photo'; }
export function isMusicEntry(v: unknown): v is MusicEntry {
  if (!record(v) || !keys(v, ['id', 'kind', 'title', 'artist', 'quantity', 'revision', 'contentStatus', 'modelId', 'photo', 'recordingState']) || !text(v.title) || !integer(v.quantity, 1, 10000) || !integer(v.revision)) return false;
  if (v.contentStatus === 'formal' || v.contentStatus === 'formal-current-unknown') return text(v.artist, true) && ['personal-cassette', 'personal-dat'].includes(String(v.kind))
    && typeof v.id === 'string' && v.id.trim() === v.id && isPhysicalId(v.id) && v.id.startsWith(v.kind === 'personal-dat' ? 'MB-D-' : 'MB-C-') && isCollectionId(v.modelId) && v.quantity === 1 && v.photo === undefined
    && isPhysicalRecordingSummary(v.recordingState) && (v.contentStatus === 'formal' ? v.recordingState.state === 'confirmed-recording' : v.recordingState.state !== 'confirmed-recording');
  if (!text(v.artist) || v.recordingState !== undefined) return false;
  return ['cd', 'cassette'].includes(String(v.kind)) ? isCollectionId(v.id) && v.contentStatus === 'commercial' && v.modelId === undefined && (v.photo === undefined || isMusicPhoto(v.photo) && v.photo.releaseId === v.id)
    : ['personal-cassette', 'personal-dat'].includes(String(v.kind)) && isPhysicalId(v.id) && isCollectionId(v.modelId) && v.quantity === 1 && ['missing', 'legacy'].includes(String(v.contentStatus)) && v.photo === undefined;
}
export function isMusicDetail(v: unknown): v is MusicDetail {
  if (!record(v) || !keys(v, ['entry', 'release', 'recording', 'photos', 'formal']) || !isMusicEntry(v.entry) || !Array.isArray(v.photos) || v.photos.length > 24) return false;
  if (v.entry.contentStatus === 'formal' || v.entry.contentStatus === 'formal-current-unknown') {
    const current = v.entry.recordingState;
    return v.release === undefined && v.recording === undefined && v.photos.length === 0 && isPhysicalRecordingSummary(v.formal) && !!current
      && current.state === v.formal.state && current.revision === v.formal.revision && (current.state !== 'confirmed-recording' || v.formal.state === 'confirmed-recording' && current.recordingId === v.formal.recordingId);
  }
  return v.formal === undefined && v.photos.every(p => isMusicPhoto(p) && p.releaseId === (v.entry as MusicEntry).id)
    && (v.entry.contentStatus === 'commercial' ? isCommercialRelease(v.release) && v.release.format === v.entry.kind && v.recording === undefined
      : v.release === undefined && v.photos.length === 0 && (v.entry.contentStatus === 'legacy' ? isMusicContent(v.recording) : v.recording === undefined));
}
