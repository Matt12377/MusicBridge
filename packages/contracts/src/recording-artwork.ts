import { isCollectionPhotoImage, type CollectionPhotoImage } from './collection.js';

export const MAX_MASTER_ARTWORK_VERSIONS = 100;
export const MAX_MASTER_ARTWORK_BYTES = 1_048_576;
export interface MasterArtworkVersion {
  id: string; masterVersionId: string; sequence: number; createdAt: string;
  sha256: string; size: number; width: number; height: number; mimeType: 'image/jpeg';
}
export type RecordingArtworkSnapshot =
  | { state: 'not-captured'; reason: 'not-provided' | 'not-implemented' | 'not-applicable' }
  | { state: 'captured'; version: MasterArtworkVersion };
export interface GetMasterArtworkRequest { masterVersionId: string; versionId?: string }
export interface PickMasterArtworkRequest { masterVersionId: string }
export interface SaveMasterArtworkRequest { commandId: string; masterVersionId: string; expectedVersionId: string | null; image: CollectionPhotoImage; userConfirmed: true }
export interface MasterArtworkResult { masterVersionId: string; currentVersion: MasterArtworkVersion | null; version: MasterArtworkVersion | null; image: CollectionPhotoImage | null }
export type PickMasterArtworkResult = { state: 'cancelled' } | { state: 'selected'; masterVersionId: string; image: CollectionPhotoImage };

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(v).every(k => allowed.includes(k));
const uuid = (v: unknown): v is string => typeof v === 'string' && v.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && v.length === 64 && /^[a-f0-9]{64}$/u.test(v);
const integer = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const date = (v: unknown): v is string => typeof v === 'string' && v.length === 24 && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
export function recordingArtworkImageBytes(image: CollectionPhotoImage): number {
  const base64 = image.dataUrl.slice(23);
  return base64.length / 4 * 3 - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
}
export function isMasterArtworkImage(v: unknown): v is CollectionPhotoImage { return isCollectionPhotoImage(v) && recordingArtworkImageBytes(v) <= MAX_MASTER_ARTWORK_BYTES; }
export function isMasterArtworkVersion(v: unknown): v is MasterArtworkVersion {
  return record(v) && keys(v, ['id', 'masterVersionId', 'sequence', 'createdAt', 'sha256', 'size', 'width', 'height', 'mimeType']) && uuid(v.id) && uuid(v.masterVersionId)
    && integer(v.sequence, 1, MAX_MASTER_ARTWORK_VERSIONS) && date(v.createdAt) && hash(v.sha256) && integer(v.size, 4, MAX_MASTER_ARTWORK_BYTES)
    && integer(v.width, 1, 1200) && integer(v.height, 1, 1200) && v.mimeType === 'image/jpeg';
}
export function isRecordingArtworkSnapshot(v: unknown): v is RecordingArtworkSnapshot {
  if (!record(v)) return false;
  if (v.state === 'captured') return keys(v, ['state', 'version']) && isMasterArtworkVersion(v.version);
  return keys(v, ['state', 'reason']) && v.state === 'not-captured' && (v.reason === 'not-provided' || v.reason === 'not-implemented' || v.reason === 'not-applicable');
}
export function isGetMasterArtworkRequest(v: unknown): v is GetMasterArtworkRequest { return record(v) && keys(v, ['masterVersionId', 'versionId']) && uuid(v.masterVersionId) && (v.versionId === undefined || uuid(v.versionId)); }
export function isPickMasterArtworkRequest(v: unknown): v is PickMasterArtworkRequest { return record(v) && keys(v, ['masterVersionId']) && uuid(v.masterVersionId); }
export function isSaveMasterArtworkRequest(v: unknown): v is SaveMasterArtworkRequest {
  return record(v) && keys(v, ['commandId', 'masterVersionId', 'expectedVersionId', 'image', 'userConfirmed']) && uuid(v.commandId) && uuid(v.masterVersionId)
    && (v.expectedVersionId === null || uuid(v.expectedVersionId)) && isMasterArtworkImage(v.image) && v.userConfirmed === true;
}
export function isMasterArtworkResult(v: unknown): v is MasterArtworkResult {
  if (!record(v) || !keys(v, ['masterVersionId', 'currentVersion', 'version', 'image']) || !uuid(v.masterVersionId)) return false;
  if (v.currentVersion !== null && (!isMasterArtworkVersion(v.currentVersion) || v.currentVersion.masterVersionId !== v.masterVersionId)) return false;
  if (v.version === null) return v.image === null;
  return isMasterArtworkVersion(v.version) && v.version.masterVersionId === v.masterVersionId && v.currentVersion !== null
    && v.currentVersion.sequence >= v.version.sequence && (v.currentVersion.sequence !== v.version.sequence || Object.entries(v.currentVersion).every(([key, value]) => value === (v.version as MasterArtworkVersion)[key as keyof MasterArtworkVersion]))
    && isMasterArtworkImage(v.image) && v.image.width === v.version.width && v.image.height === v.version.height && recordingArtworkImageBytes(v.image) === v.version.size;
}
export function isPickMasterArtworkResult(v: unknown): v is PickMasterArtworkResult {
  return record(v) && (v.state === 'cancelled' ? keys(v, ['state']) : v.state === 'selected' && keys(v, ['state', 'masterVersionId', 'image']) && uuid(v.masterVersionId) && isMasterArtworkImage(v.image));
}
