import type { Page } from './library.js';
import { isCollectionId } from './collection.js';
import { isCatalogCompletion, isCatalogSnapshotEntry, isReferenceCatalogKey, MAX_CATALOG_REFERENCES, MAX_CATALOG_MATCHES, type CatalogCompletion, type CatalogMatch } from './reference-catalog.js';

export const MAX_WANT_TARGETS_PER_REFERENCE = 100;
export const MAX_COLLECTION_PROGRESS_WANTS = 5_000;
export const MAX_COLLECTION_PROGRESS_BYTES = 8 * 1024 * 1024;
export type WantPriority = 'low' | 'normal' | 'high';
/** 保留精确输入，不按币种推断小数位，不计算汇率。 */
export interface WantPriceTarget { currency: string; amount: string }
export interface WantTargetFields {
  priority: WantPriority; preferredCondition: string; notes: string; targetLengthMinutes: number | null;
  packagingTarget: string; priceTarget: WantPriceTarget | null;
}
export interface WantEntry extends WantTargetFields {
  id: string; version: number; active: boolean; bookId: string; revisionId: string; referenceId: string;
  brand: string; series: string; model: string; edition: string; createdAt: string; updatedAt: string;
}
/** 待复核是读取时对当前目录的判断，不改写持久版本或旧回执。 */
export interface WantEntryView { entry: WantEntry; needsReview: boolean }
export interface CollectionProgressPageRequest { offset: number; limit: number }
export interface ListWantEntriesRequest { page: CollectionProgressPageRequest; bookId?: string; revisionId?: string; referenceId?: string; active?: boolean }
export interface SaveWantEntryRequest extends WantTargetFields { commandId: string; id: string | null; expectedVersion: number; revisionId: string; referenceId: string; userConfirmed: true }
export interface CancelWantEntryRequest { commandId: string; id: string; expectedVersion: number; userConfirmed: true }
export interface GetWantEntryHistoryRequest { id: string; page: CollectionProgressPageRequest }
export type WantEntriesPage = Page<WantEntryView>;
export type WantEntryHistory = Page<WantEntry>;
export interface WantTargetSummary extends Omit<WantTargetFields, 'notes'> { id: string; version: number }
export interface CollectionLengthQuantity { lengthMinutes: number; quantity: number }
export interface CollectionModelLengths { modelId: string; modelRevision: number; total: number; lengths: readonly CollectionLengthQuantity[]; unknownLengthQty: number }
export interface GetCollectionModelLengthsRequest { modelId: string }
export interface CollectionProgressCounts extends CatalogCompletion { wanted: number; wantTargetCount: number }
export interface CollectionProgressBrand { brand: string; counts: CollectionProgressCounts }
export interface CollectionProgressSeries { brand: string; series: string; counts: CollectionProgressCounts }
export interface CollectionProgressEntry {
  referenceId: string; brand: string; series: string; model: string; edition: string;
  state: 'owned' | 'missing' | 'unknown'; matches: readonly CatalogMatch[]; stockCount: number;
  knownLengths: readonly number[]; ownedLengths: readonly CollectionLengthQuantity[]; unknownLengthQty: number;
  extraLengths: readonly CollectionLengthQuantity[]; allKnownLengthsOwned: boolean; wantedTargets: readonly WantTargetSummary[];
}
export interface CollectionProgressMetrics {
  bookId: string; revisionId: string; catalogSequence: number; matchVersion: number; metricsVersion: 1;
  fingerprint: string; overall: CollectionProgressCounts; brands: readonly CollectionProgressBrand[];
  series: readonly CollectionProgressSeries[]; historicalWantedCount: number;
}
/** 即便 revision 不是当前 head，这仍是当前库存事实，不是过去的快照。 */
export interface CollectionProgress extends CollectionProgressMetrics { facts: 'current'; isCurrentRevision: boolean; entries: Page<CollectionProgressEntry> }
export interface GetCollectionProgressRequest { revisionId: string; page: CollectionProgressPageRequest }
export interface CaptureCollectionProgressRequest { commandId: string; revisionId: string; expectedFingerprint: string; userConfirmed: true }
export interface CollectionProgressSnapshotSummary extends CollectionProgressMetrics { id: string; createdAt: string }
/** Core 持久化与备份核验使用完整快照；公开详情始终分页。 */
export interface CollectionProgressSnapshot extends CollectionProgressSnapshotSummary { entries: readonly CollectionProgressEntry[] }
export interface CollectionProgressSnapshotDetail { snapshot: CollectionProgressSnapshotSummary; entries: Page<CollectionProgressEntry> }
/** 请求 limit 是上限；历史列表可因字节预算减小返回 limit，调用方按实际页前进并保存回退位置。 */
export interface ListCollectionProgressSnapshotsRequest { bookId?: string; revisionId?: string; page: CollectionProgressPageRequest }
export interface GetCollectionProgressSnapshotRequest { id: string; page: CollectionProgressPageRequest }
export type CollectionProgressSnapshotsPage = Page<CollectionProgressSnapshotSummary>;
export interface CollectionProgressPublicApi {
  listWantEntries(request: ListWantEntriesRequest): Promise<WantEntriesPage>;
  saveWantEntry(request: SaveWantEntryRequest): Promise<WantEntry>;
  cancelWantEntry(request: CancelWantEntryRequest): Promise<WantEntry>;
  getWantEntryHistory(request: GetWantEntryHistoryRequest): Promise<WantEntryHistory>;
  getCollectionProgress(request: GetCollectionProgressRequest): Promise<CollectionProgress>;
  captureCollectionProgress(request: CaptureCollectionProgressRequest): Promise<CollectionProgressSnapshotSummary>;
  listCollectionProgressSnapshots(request: ListCollectionProgressSnapshotsRequest): Promise<CollectionProgressSnapshotsPage>;
  getCollectionProgressSnapshot(request: GetCollectionProgressSnapshotRequest): Promise<CollectionProgressSnapshotDetail>;
  getCollectionModelLengths(request: GetCollectionModelLengthsRequest): Promise<CollectionModelLengths>;
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(v).every(key => allowed.includes(key));
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const text = (v: unknown, max: number, empty = false): v is string => typeof v === 'string' && v.length <= max && (empty || v.trim().length > 0) && !/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(v);
const notes = (v: unknown): v is string => typeof v === 'string' && v.length <= 4000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\uD800-\uDFFF]/u.test(v);
const length = (v: unknown): v is number => integer(v, 1, 360);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/u.test(v);
const timestamp = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const unique = (values: readonly unknown[]): boolean => new Set(values).size === values.length;
const array = <T>(v: unknown, guard: (v: unknown) => v is T, max: number): v is T[] => Array.isArray(v) && v.length <= max && Array.from(v).every(guard);
const budget = (v: unknown): boolean => { try { return new TextEncoder().encode(JSON.stringify(v)).byteLength <= MAX_COLLECTION_PROGRESS_BYTES; } catch { return false; } };
const priority = (v: unknown): v is WantPriority => v === 'low' || v === 'normal' || v === 'high';
const labels = (v: Record<string, unknown>): boolean => text(v.brand, 120) && text(v.series, 120, true) && text(v.model, 120) && text(v.edition, 120, true);
const labelKeys = ['brand', 'series', 'model', 'edition'];
const targetKeys = ['priority', 'preferredCondition', 'notes', 'targetLengthMinutes', 'packagingTarget', 'priceTarget'];

export function isWantPriceTarget(v: unknown): v is WantPriceTarget {
  return record(v) && keys(v, ['currency', 'amount']) && typeof v.currency === 'string' && /^[A-Z]{3}$/u.test(v.currency)
    && typeof v.amount === 'string' && /^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,4})?$/u.test(v.amount) && /[1-9]/u.test(v.amount);
}
function targetFields(v: Record<string, unknown>, withNotes = true): boolean {
  return priority(v.priority) && text(v.preferredCondition, 200, true) && (!withNotes || notes(v.notes))
    && (v.targetLengthMinutes === null || length(v.targetLengthMinutes)) && text(v.packagingTarget, 200, true)
    && (v.priceTarget === null || isWantPriceTarget(v.priceTarget));
}
export function isWantEntry(v: unknown): v is WantEntry {
  return record(v) && keys(v, ['id', 'version', 'active', 'bookId', 'revisionId', 'referenceId', ...labelKeys, ...targetKeys, 'createdAt', 'updatedAt'])
    && isCollectionId(v.id) && integer(v.version, 1) && typeof v.active === 'boolean' && isReferenceCatalogKey(v.bookId) && isCollectionId(v.revisionId)
    && isReferenceCatalogKey(v.referenceId) && labels(v) && targetFields(v) && timestamp(v.createdAt) && timestamp(v.updatedAt) && v.updatedAt >= v.createdAt;
}
export function isWantEntryView(v: unknown): v is WantEntryView { return record(v) && keys(v, ['entry', 'needsReview']) && isWantEntry(v.entry) && typeof v.needsReview === 'boolean'; }
export function isCollectionProgressPageRequest(v: unknown): v is CollectionProgressPageRequest { return record(v) && keys(v, ['offset', 'limit']) && integer(v.offset) && integer(v.limit, 1, 25); }
export function isListWantEntriesRequest(v: unknown): v is ListWantEntriesRequest {
  return record(v) && keys(v, ['page', 'bookId', 'revisionId', 'referenceId', 'active']) && isCollectionProgressPageRequest(v.page)
    && (v.bookId === undefined || isReferenceCatalogKey(v.bookId)) && (v.revisionId === undefined || isCollectionId(v.revisionId))
    && (v.referenceId === undefined || isReferenceCatalogKey(v.referenceId)) && (v.active === undefined || typeof v.active === 'boolean');
}
export function isSaveWantEntryRequest(v: unknown): v is SaveWantEntryRequest {
  return record(v) && keys(v, ['commandId', 'id', 'expectedVersion', 'revisionId', 'referenceId', ...targetKeys, 'userConfirmed'])
    && isCollectionId(v.commandId) && (v.id === null ? v.expectedVersion === 0 : isCollectionId(v.id) && integer(v.expectedVersion, 1))
    && isCollectionId(v.revisionId) && isReferenceCatalogKey(v.referenceId) && targetFields(v) && v.userConfirmed === true;
}
export function isCancelWantEntryRequest(v: unknown): v is CancelWantEntryRequest { return record(v) && keys(v, ['commandId', 'id', 'expectedVersion', 'userConfirmed']) && isCollectionId(v.commandId) && isCollectionId(v.id) && integer(v.expectedVersion, 1) && v.userConfirmed === true; }
export function isGetWantEntryHistoryRequest(v: unknown): v is GetWantEntryHistoryRequest { return record(v) && keys(v, ['id', 'page']) && isCollectionId(v.id) && isCollectionProgressPageRequest(v.page); }
export function isWantTargetSummary(v: unknown): v is WantTargetSummary { return record(v) && keys(v, ['id', 'version', ...targetKeys.filter(key => key !== 'notes')]) && isCollectionId(v.id) && integer(v.version, 1) && targetFields(v, false); }
export function isCollectionLengthQuantity(v: unknown): v is CollectionLengthQuantity { return record(v) && keys(v, ['lengthMinutes', 'quantity']) && length(v.lengthMinutes) && integer(v.quantity, 1); }
function lengthQuantities(v: unknown): v is CollectionLengthQuantity[] { return array(v, isCollectionLengthQuantity, 360) && unique(v.map(item => item.lengthMinutes)); }
export function isCollectionModelLengths(v: unknown): v is CollectionModelLengths {
  return record(v) && keys(v, ['modelId', 'modelRevision', 'total', 'lengths', 'unknownLengthQty']) && isCollectionId(v.modelId) && integer(v.modelRevision, 1)
    && integer(v.total) && integer(v.unknownLengthQty) && lengthQuantities(v.lengths) && v.lengths.reduce((sum, item) => sum + item.quantity, v.unknownLengthQty) === v.total;
}
export function isGetCollectionModelLengthsRequest(v: unknown): v is GetCollectionModelLengthsRequest { return record(v) && keys(v, ['modelId']) && isCollectionId(v.modelId); }
const catalogCountKeys = ['total', 'owned', 'missing', 'unknown', 'candidate', 'needsReview'] as const;
const countKeys = [...catalogCountKeys, 'wanted', 'wantTargetCount'] as const;
export function isCollectionProgressCounts(v: unknown): v is CollectionProgressCounts {
  return record(v) && keys(v, countKeys) && isCatalogCompletion(Object.fromEntries(catalogCountKeys.map(key => [key, v[key]])))
    && integer(v.wanted, 0, Number(v.total)) && integer(v.wantTargetCount, 0, MAX_COLLECTION_PROGRESS_WANTS)
    && (v.wanted === 0 ? v.wantTargetCount === 0 : v.wantTargetCount >= v.wanted && v.wantTargetCount <= v.wanted * MAX_WANT_TARGETS_PER_REFERENCE);
}
export function isCollectionProgressBrand(v: unknown): v is CollectionProgressBrand { return record(v) && keys(v, ['brand', 'counts']) && text(v.brand, 120) && isCollectionProgressCounts(v.counts); }
export function isCollectionProgressSeries(v: unknown): v is CollectionProgressSeries { return record(v) && keys(v, ['brand', 'series', 'counts']) && text(v.brand, 120) && text(v.series, 120, true) && isCollectionProgressCounts(v.counts); }
export function isCollectionProgressEntry(v: unknown): v is CollectionProgressEntry {
  if (!record(v) || !keys(v, ['referenceId', ...labelKeys, 'state', 'matches', 'stockCount', 'knownLengths', 'ownedLengths', 'unknownLengthQty', 'extraLengths', 'allKnownLengthsOwned', 'wantedTargets'])
    || !labels(v) || !isCatalogSnapshotEntry({ referenceId: v.referenceId, state: v.state, matches: v.matches, stockCount: v.stockCount })
    || !array(v.knownLengths, length, 32) || !unique(v.knownLengths) || !lengthQuantities(v.ownedLengths) || !lengthQuantities(v.extraLengths) || !integer(v.unknownLengthQty)
    || !array(v.wantedTargets, isWantTargetSummary, MAX_WANT_TARGETS_PER_REFERENCE) || !unique(v.wantedTargets.map(item => item.id))) return false;
  const { knownLengths, ownedLengths, extraLengths } = v;
  return ownedLengths.every(item => knownLengths.includes(item.lengthMinutes)) && extraLengths.every(item => !knownLengths.includes(item.lengthMinutes))
    && [...ownedLengths, ...extraLengths].reduce((sum, item) => sum + item.quantity, v.unknownLengthQty) === v.stockCount
    && v.allKnownLengthsOwned === (knownLengths.length > 0 && knownLengths.every(minutes => ownedLengths.some(item => item.lengthMinutes === minutes)));
}
const metricsKeys = ['bookId', 'revisionId', 'catalogSequence', 'matchVersion', 'metricsVersion', 'fingerprint', 'overall', 'brands', 'series', 'historicalWantedCount'];
const sameCounts = (a: CollectionProgressCounts, b: CollectionProgressCounts): boolean => countKeys.every(key => a[key] === b[key]);
function sumCounts(values: readonly CollectionProgressCounts[]): CollectionProgressCounts { return Object.fromEntries(countKeys.map(key => [key, values.reduce((sum, value) => sum + value[key], 0)])) as unknown as CollectionProgressCounts; }
function metricsFields(v: Record<string, unknown>): v is Record<string, unknown> & CollectionProgressMetrics {
  if (!isReferenceCatalogKey(v.bookId) || !isCollectionId(v.revisionId) || !integer(v.catalogSequence, 1) || !integer(v.matchVersion) || v.metricsVersion !== 1 || !hash(v.fingerprint)
    || !isCollectionProgressCounts(v.overall) || !array(v.brands, isCollectionProgressBrand, MAX_CATALOG_REFERENCES) || !array(v.series, isCollectionProgressSeries, MAX_CATALOG_REFERENCES)
    || !integer(v.historicalWantedCount) || !unique(v.brands.map(group => group.brand)) || !unique(v.series.map(group => JSON.stringify([group.brand, group.series])))) return false;
  const { brands, series } = v;
  return sameCounts(v.overall, sumCounts(brands.map(group => group.counts))) && sameCounts(v.overall, sumCounts(series.map(group => group.counts)))
    && series.every(group => brands.some(brand => brand.brand === group.brand))
    && brands.every(brand => sameCounts(brand.counts, sumCounts(series.filter(group => group.brand === brand.brand).map(group => group.counts))));
}
function page<T>(v: unknown, guard: (v: unknown) => v is T): v is Page<T> {
  return record(v) && keys(v, ['items', 'total', 'offset', 'limit', 'hasMore']) && integer(v.total) && integer(v.offset) && integer(v.limit, 1, 25)
    && array(v.items, guard, v.limit) && v.items.length === Math.min(v.limit, Math.max(0, v.total - v.offset))
    && v.hasMore === (v.offset + v.items.length < v.total) && budget(v);
}
function countsFromEntries(entries: readonly CollectionProgressEntry[]): CollectionProgressCounts {
  return { total: entries.length, owned: entries.filter(entry => entry.state === 'owned').length, missing: entries.filter(entry => entry.state === 'missing').length,
    unknown: entries.filter(entry => entry.state === 'unknown').length, candidate: entries.filter(entry => entry.state === 'unknown' && entry.matches.some(match => match.status === 'candidate')).length,
    needsReview: entries.filter(entry => entry.state === 'unknown' && entry.matches.some(match => match.status === 'needs-review')).length,
    wanted: entries.filter(entry => entry.wantedTargets.length > 0).length, wantTargetCount: entries.reduce((sum, entry) => sum + entry.wantedTargets.length, 0) };
}
function entrySet(entries: readonly CollectionProgressEntry[]): boolean {
  const matches = entries.flatMap(entry => entry.matches), wanted = entries.flatMap(entry => entry.wantedTargets);
  return unique(entries.map(entry => entry.referenceId)) && matches.length <= MAX_CATALOG_MATCHES && unique(matches.filter(match => match.status === 'confirmed').map(match => match.modelId))
    && wanted.length <= MAX_COLLECTION_PROGRESS_WANTS && unique(wanted.map(target => target.id));
}
function completeEntries(metrics: CollectionProgressMetrics, entries: readonly CollectionProgressEntry[]): boolean {
  return entries.length === metrics.overall.total && sameCounts(metrics.overall, countsFromEntries(entries))
    && metrics.brands.every(group => sameCounts(group.counts, countsFromEntries(entries.filter(entry => entry.brand === group.brand))))
    && metrics.series.every(group => sameCounts(group.counts, countsFromEntries(entries.filter(entry => entry.brand === group.brand && entry.series === group.series))));
}
function progressPage(metrics: CollectionProgressMetrics, v: unknown): v is Page<CollectionProgressEntry> {
  if (!page(v, isCollectionProgressEntry) || v.total !== metrics.overall.total || !entrySet(v.items)
    || !v.items.every(entry => metrics.brands.some(group => group.brand === entry.brand) && metrics.series.some(group => group.brand === entry.brand && group.series === entry.series))) return false;
  return v.offset !== 0 || v.items.length !== v.total || completeEntries(metrics, v.items);
}
export function isWantEntriesPage(v: unknown): v is WantEntriesPage { return page(v, isWantEntryView) && unique(v.items.map(item => item.entry.id)); }
export function isWantEntryHistory(v: unknown): v is WantEntryHistory { return page(v, isWantEntry) && unique(v.items.map(item => item.version)) && new Set(v.items.map(item => item.id)).size <= 1; }
export function isCollectionProgress(v: unknown): v is CollectionProgress { return record(v) && keys(v, [...metricsKeys, 'facts', 'isCurrentRevision', 'entries']) && metricsFields(v) && v.facts === 'current' && typeof v.isCurrentRevision === 'boolean' && progressPage(v, v.entries) && budget(v); }
export function isGetCollectionProgressRequest(v: unknown): v is GetCollectionProgressRequest { return record(v) && keys(v, ['revisionId', 'page']) && isCollectionId(v.revisionId) && isCollectionProgressPageRequest(v.page); }
export function isCaptureCollectionProgressRequest(v: unknown): v is CaptureCollectionProgressRequest { return record(v) && keys(v, ['commandId', 'revisionId', 'expectedFingerprint', 'userConfirmed']) && isCollectionId(v.commandId) && isCollectionId(v.revisionId) && hash(v.expectedFingerprint) && v.userConfirmed === true; }
const snapshotKeys = [...metricsKeys, 'id', 'createdAt'];
function snapshotFields(v: Record<string, unknown>): v is Record<string, unknown> & CollectionProgressSnapshotSummary { return metricsFields(v) && isCollectionId(v.id) && timestamp(v.createdAt); }
export function isCollectionProgressSnapshotSummary(v: unknown): v is CollectionProgressSnapshotSummary { return record(v) && keys(v, snapshotKeys) && snapshotFields(v) && budget(v); }
export function isCollectionProgressSnapshot(v: unknown): v is CollectionProgressSnapshot { return record(v) && keys(v, [...snapshotKeys, 'entries']) && snapshotFields(v) && array(v.entries, isCollectionProgressEntry, MAX_CATALOG_REFERENCES) && entrySet(v.entries) && completeEntries(v, v.entries) && budget(v); }
export function isCollectionProgressSnapshotDetail(v: unknown): v is CollectionProgressSnapshotDetail { return record(v) && keys(v, ['snapshot', 'entries']) && isCollectionProgressSnapshotSummary(v.snapshot) && progressPage(v.snapshot, v.entries) && budget(v); }
export function isListCollectionProgressSnapshotsRequest(v: unknown): v is ListCollectionProgressSnapshotsRequest { return record(v) && keys(v, ['bookId', 'revisionId', 'page']) && (v.bookId === undefined || isReferenceCatalogKey(v.bookId)) && (v.revisionId === undefined || isCollectionId(v.revisionId)) && isCollectionProgressPageRequest(v.page); }
export function isGetCollectionProgressSnapshotRequest(v: unknown): v is GetCollectionProgressSnapshotRequest { return record(v) && keys(v, ['id', 'page']) && isCollectionId(v.id) && isCollectionProgressPageRequest(v.page); }
export function isCollectionProgressSnapshotsPage(v: unknown): v is CollectionProgressSnapshotsPage { return page(v, isCollectionProgressSnapshotSummary) && unique(v.items.map(item => item.id)); }
