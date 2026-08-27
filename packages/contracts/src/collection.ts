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
  identification: 'unidentified' | 'candidate' | 'verified';
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
  quantities: CollectionQuantities;
}
export interface CollectionCopy {
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
  modelId: string;
  lotId?: string;
  physicalId?: string;
}
export interface CollectionPublicApi {
  listCollection(page: PageRequest): Promise<Page<CollectionModel>>;
  getCollectionModel(modelId: string, page: PageRequest): Promise<CollectionDetail>;
  receiveCollectionStock(request: CollectionReceiveRequest): Promise<CollectionMutationResult>;
  materializeCollectionCopy(request: CollectionMaterializeRequest): Promise<CollectionMutationResult>;
  updateCollectionCopy(request: CollectionUpdateCopyRequest): Promise<CollectionMutationResult>;
  setCollectionPolicy(request: CollectionPolicyRequest): Promise<CollectionMutationResult>;
}

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
    && ['cassette', 'dat'].includes(String(v.format))
    && (v.format === 'dat' ? v.tapeType === 'dat' : ['I', 'II', 'III', 'IV', 'unknown'].includes(String(v.tapeType)))
    && ['unidentified', 'candidate', 'verified'].includes(String(v.identification))
    && (v.identification !== 'verified' || (typeof v.edition === 'string' && v.edition.trim().length > 0));
}
export function isCollectionQuantities(v: unknown): v is CollectionQuantities {
  return record(v) && keys(v, quantityKeys) && quantityKeys.every(k => integer(v[k]));
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
  return record(v) && keys(v, ['modelId', 'lotId', 'physicalId']) && isCollectionId(v.modelId)
    && (v.lotId === undefined || isCollectionId(v.lotId)) && (v.physicalId === undefined || isPhysicalId(v.physicalId));
}
export function isCollectionModel(v: unknown): v is CollectionModel {
  if (!record(v) || !keys(v, [...descriptorKeys, 'id', 'collectorPolicy', 'minimumSealedReserve', 'revision', 'lengths', 'counts'])) return false;
  const descriptor = Object.fromEntries(descriptorKeys.map(k => [k, v[k]]));
  const countKeys = ['total', 'sealedBlank', 'openedBlank', 'legacyUsed', 'recorded', 'reserved', 'unavailable', 'unknown'];
  if (!record(v.counts) || !keys(v.counts, countKeys) || !countKeys.every(k => integer((v.counts as Record<string, unknown>)[k]))) return false;
  const counts = v.counts as unknown as CollectionCounts;
  return isCollectionDescriptor(descriptor) && isCollectionId(v.id) && policy(v.collectorPolicy)
    && integer(v.minimumSealedReserve) && integer(v.revision, 1)
    && Array.isArray(v.lengths) && v.lengths.length <= 100 && v.lengths.every(length)
    && counts.total === counts.sealedBlank + counts.openedBlank + counts.legacyUsed + counts.recorded + counts.reserved + counts.unavailable + counts.unknown;
}
export function isCollectionPage<T>(v: unknown, item: (v: unknown) => v is T): v is Page<T> {
  return record(v) && keys(v, ['items', 'offset', 'limit', 'total', 'hasMore']) && integer(v.offset)
    && integer(v.limit, 1, 100) && integer(v.total) && Array.isArray(v.items) && v.items.length <= v.limit
    && v.items.every(item) && v.hasMore === (v.offset + v.items.length < v.total);
}
function isCollectionLot(v: unknown): v is CollectionLot {
  return record(v) && keys(v, ['id', 'skuId', 'lengthMinutes', 'quantityAcquired', 'quantities'])
    && isCollectionId(v.id) && isCollectionId(v.skuId) && length(v.lengthMinutes) && integer(v.quantityAcquired, 1)
    && isCollectionQuantities(v.quantities) && Object.values(v.quantities).reduce((sum, n) => sum + n, 0) <= v.quantityAcquired;
}
function isCollectionCopy(v: unknown): v is CollectionCopy {
  return record(v) && keys(v, ['physicalId', 'lotId', 'skuId', 'lengthMinutes', 'packaging', 'usage', 'available', 'origin', 'revision'])
    && isPhysicalId(v.physicalId) && isCollectionId(v.lotId) && isCollectionId(v.skuId) && length(v.lengthMinutes)
    && ['sealed', 'opened', 'unknown'].includes(String(v.packaging)) && ['blank', 'reserved', 'recorded', 'unknown', 'erased'].includes(String(v.usage))
    && typeof v.available === 'boolean' && ['blank-pool', 'legacy-registration', 'unclassified'].includes(String(v.origin)) && integer(v.revision, 1);
}
export function isCollectionDetail(v: unknown): v is CollectionDetail {
  return record(v) && keys(v, ['model', 'lots', 'copies']) && isCollectionModel(v.model)
    && isCollectionPage(v.lots, isCollectionLot) && isCollectionPage(v.copies, isCollectionCopy);
}
