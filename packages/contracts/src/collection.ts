import type { Page, PageRequest } from './library.js';

export type CollectionFormat = 'cassette' | 'dat';
export type CollectionBucket = 'sealedBlank' | 'openedBlank' | 'legacyUsed' | 'unclassified';
export type CollectorPolicy = 'normal' | 'prefer-opened' | 'preserve-sealed' | 'collector';
export interface CollectionDescriptor {
  brand: string;
  name: string;
  edition: string;
  year: number | null;
  format: CollectionFormat;
  tapeType: 'I' | 'II' | 'III' | 'IV' | 'dat' | 'unknown';
  identification: 'unidentified' | 'partial' | 'candidate' | 'verified';
}
export interface CollectionQuantities {
  sealedBlank: number;
  openedBlank: number;
  legacyUsed: number;
  unclassified: number;
}
export interface CollectionCounts {
  total: number;
  sealedBlank: number;
  openedBlank: number;
  legacyUsed: number;
  recorded: number;
  reserved: number;
  unavailable: number;
  unknown: number;
}
export interface CollectionModel extends CollectionDescriptor {
  featuredPhoto?: CollectionPhoto;
  photoCount?: number;
  id: string;
  collectorPolicy: CollectorPolicy;
  minimumSealedReserve: number;
  revision: number;
  lengths: readonly (number | null)[];
  counts: CollectionCounts;
}
export interface CollectionLot {
  id: string;
  skuId: string;
  lengthMinutes: number | null;
  quantityAcquired: number;
  quantityAdjustment?: number;
  quantities: CollectionQuantities;
}
/** 当前内容认知不是旧档案存在的推论；原实体身份和来源不变。 */
export type PhysicalRecordingSummary = { revision: number } & ({ state: 'confirmed-recording'; recordingId: string } | { state: 'unknown' | 'erased' });
export interface CollectionCopy {
  recordingState?: PhysicalRecordingSummary;
  recordingTitle?: string;
  physicalId: string;
  lotId: string;
  skuId: string;
  lengthMinutes: number | null;
  packaging: 'sealed' | 'opened' | 'unknown';
  usage: 'blank' | 'reserved' | 'recorded' | 'unknown' | 'erased';
  available: boolean;
  origin: 'blank-pool' | 'legacy-registration' | 'unclassified';
  revision: number;
}
export interface CollectionDetail {
  photos?: readonly CollectionPhoto[];
  model: CollectionModel;
  lots: Page<CollectionLot>;
  copies: Page<CollectionCopy>;
}
export interface CollectionReceiveRequest {
  commandId: string;
  model: CollectionDescriptor;
  lengthMinutes: number | null;
  quantities: CollectionQuantities;
}
export interface CollectionMaterializeRequest {
  commandId: string;
  lotId: string;
  bucket: CollectionBucket;
  action: 'identify' | 'open' | 'register-legacy';
}
export interface CollectionUpdateCopyRequest {
  commandId: string;
  physicalId: string;
  expectedRevision: number;
  action: 'reserve' | 'cancel-reservation' | 'mark-unavailable' | 'mark-available';
}
export interface CollectionPolicyRequest {
  commandId: string;
  modelId: string;
  expectedRevision: number;
  collectorPolicy: CollectorPolicy;
  minimumSealedReserve: number;
}
export interface CollectionMutationResult {
  photoId?: string;
  modelId: string;
  lotId?: string;
  physicalId?: string;
}
export interface CollectionPublicApi {
  listCollection(page: PageRequest, filter?: CollectionFilter): Promise<Page<CollectionModel>>;
  pickCollectionPhoto(): Promise<CollectionPhotoImage | null>;
  addCollectionPhoto(request: CollectionAddPhotoRequest): Promise<CollectionMutationResult>;
  getCollectionPhoto(photoId: string): Promise<CollectionPhotoImage>;
  changeCollectionPhoto(request: CollectionChangePhotoRequest): Promise<CollectionMutationResult>;
  getCollectionModel(modelId: string, page: PageRequest): Promise<CollectionDetail>;
  receiveCollectionStock(request: CollectionReceiveRequest): Promise<CollectionMutationResult>;
  materializeCollectionCopy(request: CollectionMaterializeRequest): Promise<CollectionMutationResult>;
  updateCollectionCopy(request: CollectionUpdateCopyRequest): Promise<CollectionMutationResult>;
  setCollectionPolicy(request: CollectionPolicyRequest): Promise<CollectionMutationResult>;
}

export interface CollectionFilter { query?: string; brand?: string; decade?: number | 'unknown' }
export interface CollectionPhoto {
  id: string;
  modelId: string;
  physicalId?: string;
  width: number;
  height: number;
  source: 'user-photo';
}
export interface CollectionPhotoImage { dataUrl: string; width: number; height: number }
export interface CollectionAddPhotoRequest { commandId: string; modelId: string; physicalId?: string; image: CollectionPhotoImage }
export interface CollectionChangePhotoRequest { commandId: string; modelId: string; photoId: string; expectedRevision: number; action: 'feature' | 'remove' }
export const MAX_COLLECTION_PHOTO_BYTES = 1_048_576;
export const MAX_COLLECTION_PHOTOS_PER_MODEL = 24;

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(v).every(k => allowed.includes(k));
const integer = (v: unknown, min = 0, max = 1_000_000): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const text = (v: unknown, empty = false): v is string => typeof v === 'string' && v.length <= 120 && (empty || v.trim().length > 0) && !/[\u0000-\u001f\u007f]/u.test(v);
export const isCollectionId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(v);
export const isPhysicalId = (v: unknown): v is string => typeof v === 'string' && /^MB-[CD]-\d{5,9}$/u.test(v);
const length = (v: unknown): v is number | null => v === null || integer(v, 1, 360);
const policy = (v: unknown): v is CollectorPolicy => ['normal', 'prefer-opened', 'preserve-sealed', 'collector'].includes(String(v));
const descriptorKeys = ['brand', 'name', 'edition', 'year', 'format', 'tapeType', 'identification'];
const quantityKeys = ['sealedBlank', 'openedBlank', 'legacyUsed', 'unclassified'] as const;

export function isCollectionDescriptor(v: unknown): v is CollectionDescriptor {
  return record(v) && keys(v, descriptorKeys) && text(v.brand) && text(v.name) && text(v.edition, true)
    && (v.year === null || integer(v.year, 1900, 2200))
    && typeof v.format === 'string' && ['cassette', 'dat'].includes(v.format)
    && (v.format === 'dat' ? v.tapeType === 'dat' : typeof v.tapeType === 'string' && ['I', 'II', 'III', 'IV', 'unknown'].includes(v.tapeType))
    && typeof v.identification === 'string' && ['unidentified', 'candidate', 'verified'].includes(v.identification)
    && (v.identification !== 'verified' || (typeof v.edition === 'string' && v.edition.trim().length > 0));
}
export function isCollectionQuantities(v: unknown): v is CollectionQuantities {
  return record(v) && keys(v, quantityKeys) && quantityKeys.every(k => integer(v[k]));
}
/** 导入与读取允许真实空字段；手工 receive 仍使用严格描述验证器。 */
export function isImportedCollectionDescriptor(v: unknown): v is CollectionDescriptor {
  if (isCollectionDescriptor(v)) return true;
  return record(v) && keys(v, descriptorKeys) && text(v.brand, true) && text(v.name, true) && text(v.edition, true)
    && (v.year === null || integer(v.year, 1900, 2200)) && (v.format === 'cassette' || v.format === 'dat')
    && (v.format === 'dat' ? v.tapeType === 'dat' : typeof v.tapeType === 'string' && ['I', 'II', 'III', 'IV', 'unknown'].includes(v.tapeType))
    && typeof v.identification === 'string' && ['unidentified', 'partial', 'candidate'].includes(v.identification);
}
export function isCollectionReceiveRequest(v: unknown): v is CollectionReceiveRequest {
  return record(v) && keys(v, ['commandId', 'model', 'lengthMinutes', 'quantities'])
    && isCollectionId(v.commandId) && isCollectionDescriptor(v.model) && length(v.lengthMinutes)
    && isCollectionQuantities(v.quantities)
    && Object.values(v.quantities).reduce((sum, n) => sum + n, 0) > 0
    && Object.values(v.quantities).reduce((sum, n) => sum + n, 0) <= 10_000;
}
export function isCollectionMaterializeRequest(v: unknown): v is CollectionMaterializeRequest {
  if (!record(v) || !keys(v, ['commandId', 'lotId', 'bucket', 'action']) || !isCollectionId(v.commandId) || !isCollectionId(v.lotId)) return false;
  return (v.bucket === 'legacyUsed' && v.action === 'register-legacy')
    || (v.bucket === 'sealedBlank' && ['identify', 'open'].includes(String(v.action)))
    || (['openedBlank', 'unclassified'].includes(String(v.bucket)) && v.action === 'identify');
}
export function isCollectionUpdateCopyRequest(v: unknown): v is CollectionUpdateCopyRequest {
  return record(v) && keys(v, ['commandId', 'physicalId', 'expectedRevision', 'action'])
    && isCollectionId(v.commandId) && isPhysicalId(v.physicalId) && integer(v.expectedRevision, 1)
    && ['reserve', 'cancel-reservation', 'mark-unavailable', 'mark-available'].includes(String(v.action));
}
export function isCollectionPolicyRequest(v: unknown): v is CollectionPolicyRequest {
  return record(v) && keys(v, ['commandId', 'modelId', 'expectedRevision', 'collectorPolicy', 'minimumSealedReserve'])
    && isCollectionId(v.commandId) && isCollectionId(v.modelId) && integer(v.expectedRevision, 1)
    && policy(v.collectorPolicy) && integer(v.minimumSealedReserve);
}
export function isCollectionMutationResult(v: unknown): v is CollectionMutationResult {
  return record(v) && keys(v, ['modelId', 'lotId', 'physicalId', 'photoId']) && isCollectionId(v.modelId)
    && (v.photoId === undefined || isCollectionId(v.photoId))
    && (v.lotId === undefined || isCollectionId(v.lotId)) && (v.physicalId === undefined || isPhysicalId(v.physicalId));
}
export function isCollectionModel(v: unknown): v is CollectionModel {
  if (!record(v) || !keys(v, [...descriptorKeys, 'id', 'collectorPolicy', 'minimumSealedReserve', 'revision', 'lengths', 'counts', 'featuredPhoto', 'photoCount'])) return false;
  if (v.photoCount !== undefined && !integer(v.photoCount, 0, MAX_COLLECTION_PHOTOS_PER_MODEL)) return false;
  if (v.featuredPhoto !== undefined && (!isCollectionPhoto(v.featuredPhoto) || v.featuredPhoto.modelId !== v.id)) return false;
  const descriptor = Object.fromEntries(descriptorKeys.map(k => [k, v[k]]));
  const countKeys = ['total', 'sealedBlank', 'openedBlank', 'legacyUsed', 'recorded', 'reserved', 'unavailable', 'unknown'];
  if (!record(v.counts) || !keys(v.counts, countKeys) || !countKeys.every(k => integer((v.counts as Record<string, unknown>)[k]))) return false;
  const counts = v.counts as unknown as CollectionCounts;
  return isImportedCollectionDescriptor(descriptor) && isCollectionId(v.id) && policy(v.collectorPolicy)
    && integer(v.minimumSealedReserve) && integer(v.revision, 1)
    && Array.isArray(v.lengths) && v.lengths.length <= 100 && v.lengths.every(length)
    && counts.total === counts.sealedBlank + counts.openedBlank + counts.legacyUsed + counts.recorded + counts.reserved + counts.unavailable + counts.unknown;
}
export function isCollectionPage<T>(v: unknown, item: (v: unknown) => v is T): v is Page<T> {
  return record(v) && keys(v, ['items', 'offset', 'limit', 'total', 'hasMore']) && integer(v.offset)
    && integer(v.limit, 1, 100) && integer(v.total) && Array.isArray(v.items) && v.items.length <= v.limit
    && v.items.every(item) && v.hasMore === (v.offset + v.items.length < v.total);
}
export function isCollectionLot(v: unknown): v is CollectionLot {
  return record(v) && keys(v, ['id', 'skuId', 'lengthMinutes', 'quantityAcquired', 'quantityAdjustment', 'quantities'])
    && isCollectionId(v.id) && isCollectionId(v.skuId) && length(v.lengthMinutes) && integer(v.quantityAcquired, 1)
    && (v.quantityAdjustment === undefined || integer(v.quantityAdjustment, -1_000_000, 1_000_000))
    && v.quantityAcquired + (v.quantityAdjustment ?? 0) >= 0
    && isCollectionQuantities(v.quantities) && Object.values(v.quantities).reduce((sum, n) => sum + n, 0) <= v.quantityAcquired + (v.quantityAdjustment ?? 0);
}
export function isPhysicalRecordingSummary(v: unknown): v is PhysicalRecordingSummary {
  return record(v) && keys(v, ['revision', 'state', 'recordingId']) && integer(v.revision, 0, Number.MAX_SAFE_INTEGER)
    && (v.state === 'confirmed-recording' ? v.revision >= 1 && typeof v.recordingId === 'string' && v.recordingId.length === 36 && isCollectionId(v.recordingId)
      : (v.state === 'unknown' || v.state === 'erased' && v.revision >= 1) && v.recordingId === undefined);
}
function isCollectionCopy(v: unknown): v is CollectionCopy {
  return record(v) && keys(v, ['physicalId', 'lotId', 'skuId', 'lengthMinutes', 'packaging', 'usage', 'available', 'origin', 'revision', 'recordingTitle', 'recordingState'])
    && (v.recordingState === undefined || isPhysicalRecordingSummary(v.recordingState) && (v.recordingState.state === 'confirmed-recording' || v.recordingTitle === undefined))
    && (v.recordingTitle === undefined || ((v.usage === 'recorded' || record(v.recordingState) && v.recordingState.state === 'confirmed-recording' && (v.usage === 'reserved' || v.usage === 'unknown')) && typeof v.recordingTitle === 'string' && v.recordingTitle.length > 0 && v.recordingTitle.length <= 240 && !/[\u0000-\u001f\u007f]/u.test(v.recordingTitle)))
    && isPhysicalId(v.physicalId) && isCollectionId(v.lotId) && isCollectionId(v.skuId) && length(v.lengthMinutes)
    && ['sealed', 'opened', 'unknown'].includes(String(v.packaging)) && ['blank', 'reserved', 'recorded', 'unknown', 'erased'].includes(String(v.usage))
    && typeof v.available === 'boolean' && ['blank-pool', 'legacy-registration', 'unclassified'].includes(String(v.origin)) && integer(v.revision, 1);
}
export function isCollectionDetail(v: unknown): v is CollectionDetail {
  return record(v) && keys(v, ['model', 'lots', 'copies', 'photos']) && isCollectionModel(v.model)
    && (v.photos === undefined || (Array.isArray(v.photos) && v.photos.length <= MAX_COLLECTION_PHOTOS_PER_MODEL && v.photos.every(p => isCollectionPhoto(p) && p.modelId === (v.model as CollectionModel).id)))
    && isCollectionPage(v.lots, isCollectionLot) && isCollectionPage(v.copies, isCollectionCopy);
}

export function isCollectionFilter(v: unknown): v is CollectionFilter {
  return record(v) && keys(v, ['query', 'brand', 'decade'])
    && (v.query === undefined || text(v.query, true)) && (v.brand === undefined || text(v.brand, true))
    && (v.decade === undefined || v.decade === 'unknown' || (integer(v.decade, 1900, 2200) && v.decade % 10 === 0));
}
export function isCollectionPhoto(v: unknown): v is CollectionPhoto {
  return record(v) && keys(v, ['id', 'modelId', 'physicalId', 'width', 'height', 'source']) && isCollectionId(v.id) && isCollectionId(v.modelId)
    && (v.physicalId === undefined || isPhysicalId(v.physicalId)) && integer(v.width, 1, 1200) && integer(v.height, 1, 1200) && v.source === 'user-photo';
}
/** 图像容器与原字节校验共用尺寸规则；此谓词不证明图像内容有效。 */
export function isCollectionPhotoDimensions(width: unknown, height: unknown): boolean { return integer(width, 1, 1200) && integer(height, 1, 1200); }
export function isCollectionPhotoImage(v: unknown): v is CollectionPhotoImage {
  return record(v) && keys(v, ['dataUrl', 'width', 'height']) && isCollectionPhotoDimensions(v.width, v.height)
    && typeof v.dataUrl === 'string' && v.dataUrl.length <= 23 + Math.ceil(MAX_COLLECTION_PHOTO_BYTES / 3) * 4
    && /^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]*={0,2}$/u.test(v.dataUrl) && (v.dataUrl.length - 23) % 4 === 0;
}
export function isCollectionAddPhotoRequest(v: unknown): v is CollectionAddPhotoRequest {
  return record(v) && keys(v, ['commandId', 'modelId', 'physicalId', 'image']) && isCollectionId(v.commandId) && isCollectionId(v.modelId)
    && (v.physicalId === undefined || isPhysicalId(v.physicalId)) && isCollectionPhotoImage(v.image);
}
export function isCollectionChangePhotoRequest(v: unknown): v is CollectionChangePhotoRequest {
  return record(v) && keys(v, ['commandId', 'modelId', 'photoId', 'expectedRevision', 'action'])
    && isCollectionId(v.commandId) && isCollectionId(v.modelId) && isCollectionId(v.photoId) && integer(v.expectedRevision, 1)
    && (v.action === 'feature' || v.action === 'remove');
}
