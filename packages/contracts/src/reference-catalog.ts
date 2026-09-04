import { isCollectionId, isCollectionPhotoImage, type CollectionPhotoImage } from './collection.js';

export const MAX_REFERENCE_SOURCE_PACK_BYTES = 1_048_576;
/** 带图目录修订与原始文字资料分别限额，避免放大原文入口。 */
export const MAX_REFERENCE_REVISION_BYTES = 4 * 1024 * 1024;
export const MAX_CATALOG_REFERENCES = 2_000;
export const MAX_CATALOG_MATCHES = 5_000;
export interface CanonicalReference {
  referenceId: string; bookId: string; brand: string; series: string; edition: string; model: string;
  lengths: readonly number[]; iec: 'I' | 'II' | 'III' | 'IV' | 'dat' | 'unknown'; era: string | null;
  image: { kind: 'none' } | { kind: 'reference'; image: CollectionPhotoImage; caption: string };
  pages: readonly string[]; notes: string; confidence: 'high' | 'medium' | 'low' | 'unknown';
}
export interface SourcePack { schemaVersion: 1; bookId: string; title: string; sourceVersion: string; items: readonly CanonicalReference[] }
export interface ReferenceSourceVersion { id: string; bookId: string; title: string; sourceVersion: string; packHash: string; itemCount: number; createdAt: string }
export interface ReferenceSourceDetail { source: ReferenceSourceVersion; rawPack: string }
export interface RegisterReferenceSourceRequest { commandId: string; rawPack: string; packHash: string; userConfirmed: true }
export interface ReferenceSourceListRequest { bookId?: string; offset: number; limit: number }
export interface ReferenceSourcePage { items: readonly ReferenceSourceVersion[]; total: number; offset: number; limit: number }
export interface CatalogIdRequest { id: string }
export interface CatalogMapping { fromReferenceIds: readonly string[]; toReferenceIds: readonly string[] }
export interface PreviewCatalogRevisionRequest { sourceId: string; expectedCurrentRevisionId: string | null; items: readonly CanonicalReference[]; mappings: readonly CatalogMapping[] }
export interface PublishCatalogRevisionRequest extends PreviewCatalogRevisionRequest { commandId: string; baselineFingerprint: string; userConfirmed: true }
export interface CatalogRevision {
  id: string; bookId: string; sourceId: string; packHash: string; sequence: number; previousRevisionId: string | null;
  items: readonly CanonicalReference[]; mappings: readonly CatalogMapping[]; createdAt: string;
}
export interface CatalogRevisionSummary extends Omit<CatalogRevision, 'items' | 'mappings'> { itemCount: number }
/** Missing 只能是用户明确的未匹配声明，不能从候选或缺少信息推断。 */
export type CatalogMatch =
  | { referenceId: string; modelId: string; status: 'confirmed' | 'candidate' | 'needs-review'; availability: 'unknown' }
  | { referenceId: string; modelId: null; status: 'unmatched'; availability: 'missing' | 'unknown' };
/** 按 referenceId 整体替换；合并迁移可保留多个 model，但只贡献一个 canonical。 */
export interface SetCatalogMatchRequest { commandId: string; revisionId: string; expectedMatchVersion: number; match: CatalogMatch; userConfirmed: true }
export interface CatalogCompletion { total: number; owned: number; missing: number; unknown: number; candidate: number; needsReview: number }
export interface CatalogSnapshotEntry { referenceId: string; state: 'owned' | 'missing' | 'unknown'; matches: readonly CatalogMatch[]; stockCount: number }
export interface CatalogSnapshot { id: string; bookId: string; revisionId: string; matchVersion: number; createdAt: string; counts: CatalogCompletion; entries: readonly CatalogSnapshotEntry[] }
export type CatalogSnapshotSummary = Omit<CatalogSnapshot, 'entries'>;
export interface CatalogRevisionDetail {
  revision: CatalogRevision; matches: readonly CatalogMatch[]; matchVersion: number; snapshot: CatalogSnapshot;
  currentCounts: CatalogCompletion; currentEntries: readonly CatalogSnapshotEntry[];
}
export interface CatalogRevisionDelta {
  addedReferenceIds: readonly string[]; removedReferenceIds: readonly string[]; retainedReferenceIds: readonly string[];
  merged: number; split: number; before: CatalogCompletion | null; after: CatalogCompletion;
}
export interface CatalogRevisionPreview { baselineFingerprint: string; expectedCurrentRevisionId: string | null; counts: CatalogCompletion; entries: readonly CatalogSnapshotEntry[]; delta: CatalogRevisionDelta }
export interface CatalogHistoryRequest { bookId: string; offset: number; limit: number }
export interface CatalogHistory {
  bookId: string; currentRevisionId: string | null; revisions: readonly CatalogRevisionSummary[]; snapshots: readonly CatalogSnapshotSummary[];
  total: number; offset: number; limit: number;
}
export interface ReferenceCatalogPublicApi {
  registerReferenceSource(request: RegisterReferenceSourceRequest): Promise<ReferenceSourceVersion>;
  listReferenceSources(request: ReferenceSourceListRequest): Promise<ReferenceSourcePage>;
  getReferenceSource(request: CatalogIdRequest): Promise<ReferenceSourceDetail>;
  previewCatalogRevision(request: PreviewCatalogRevisionRequest): Promise<CatalogRevisionPreview>;
  publishCatalogRevision(request: PublishCatalogRevisionRequest): Promise<CatalogRevisionDetail>;
  getCatalogRevision(request: CatalogIdRequest): Promise<CatalogRevisionDetail>;
  setCatalogMatch(request: SetCatalogMatchRequest): Promise<CatalogRevisionDetail>;
  getCatalogSnapshot(request: CatalogIdRequest): Promise<CatalogSnapshot>;
  getCatalogHistory(request: CatalogHistoryRequest): Promise<CatalogHistory>;
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(v).every(k => allowed.includes(k));
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const text = (v: unknown, max = 120, empty = false): v is string => typeof v === 'string' && v.length <= max && (empty || v.trim().length > 0) && !/[\u0000-\u001f\u007f]/u.test(v);
export const isReferenceCatalogKey = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/u.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/u.test(v);
const timestamp = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(v) && Number.isFinite(Date.parse(v));
const nullableId = (v: unknown): v is string | null => v === null || isCollectionId(v);
function array<T>(v: unknown, guard: (v: unknown) => v is T, max: number, min = 0): v is T[] {
  return Array.isArray(v) && v.length >= min && v.length <= max && Array.from(v).every(guard);
}
const unique = (v: readonly unknown[]): boolean => new Set(v).size === v.length;
const referenceKeys = (v: unknown): v is string[] => array(v, isReferenceCatalogKey, MAX_CATALOG_REFERENCES) && unique(v);
function boundedJson(v: unknown, limit = MAX_REFERENCE_SOURCE_PACK_BYTES): boolean {
  try { return new TextEncoder().encode(JSON.stringify(v)).byteLength <= limit; } catch { return false; }
}
const itemKeys = ['referenceId', 'bookId', 'brand', 'series', 'edition', 'model', 'lengths', 'iec', 'era', 'image', 'pages', 'notes', 'confidence'];
export function isCanonicalReference(v: unknown): v is CanonicalReference {
  if (!record(v) || !keys(v, itemKeys) || !isReferenceCatalogKey(v.referenceId) || !isReferenceCatalogKey(v.bookId)
    || !text(v.brand) || !text(v.series, 120, true) || !text(v.edition, 120, true) || !text(v.model)
    || !array(v.lengths, (n): n is number => integer(n, 1, 360), 32)
    || typeof v.iec !== 'string' || !['I', 'II', 'III', 'IV', 'dat', 'unknown'].includes(v.iec) || !(v.era === null || text(v.era))
    || !array(v.pages, (p): p is string => text(p, 40), 100) || !text(v.notes, 2_000, true)
    || typeof v.confidence !== 'string' || !['high', 'medium', 'low', 'unknown'].includes(v.confidence) || !record(v.image)) return false;
  return v.image.kind === 'none' ? keys(v.image, ['kind'])
    : v.image.kind === 'reference' && keys(v.image, ['kind', 'image', 'caption']) && isCollectionPhotoImage(v.image.image) && text(v.image.caption, 240);
}
/** 身份不含页码、时长与参考图；这些不能增加收藏分母。 */
function identity(item: CanonicalReference): string {
  return JSON.stringify([item.bookId, item.brand, item.series, item.edition, item.model, item.iec, item.era]
    .map(v => typeof v === 'string' ? v.normalize('NFKC').trim().toLowerCase() : v));
}
function metadata(item: CanonicalReference): string {
  const image = item.image.kind === 'none' ? ['none'] : ['reference', item.image.image.dataUrl, item.image.image.width, item.image.image.height, item.image.caption];
  return JSON.stringify([identity(item), image, item.notes, item.confidence]);
}
/** 只归并同身份重复页；冲突不得通过挑选第一条悄悄丢失事实。 */
export function normalizeReferenceItems(value: unknown): CanonicalReference[] | null {
  if (!array(value, isCanonicalReference, MAX_CATALOG_REFERENCES, 1)) return null;
  const byId = new Map<string, CanonicalReference>(), byIdentity = new Map<string, string>();
  for (const item of value) {
    const key = identity(item), priorIdentityId = byIdentity.get(key), prior = byId.get(item.referenceId);
    if (priorIdentityId !== undefined && priorIdentityId !== item.referenceId || prior && metadata(prior) !== metadata(item)) return null;
    byIdentity.set(key, item.referenceId);
    byId.set(item.referenceId, { ...item, image: structuredClone(item.image), lengths: [...new Set([...(prior?.lengths ?? []), ...item.lengths])].sort((a, b) => a - b), pages: [...new Set([...(prior?.pages ?? []), ...item.pages])].sort() });
  }
  const result = [...byId.values()];
  return result.every(isCanonicalReference) ? result : null;
}
export function isSourcePack(v: unknown): v is SourcePack {
  return record(v) && keys(v, ['schemaVersion', 'bookId', 'title', 'sourceVersion', 'items']) && v.schemaVersion === 1
    && isReferenceCatalogKey(v.bookId) && text(v.title, 240) && text(v.sourceVersion) && array(v.items, isCanonicalReference, MAX_CATALOG_REFERENCES, 1)
    && v.items.every(item => item.bookId === v.bookId) && normalizeReferenceItems(v.items) !== null && boundedJson(v);
}
/** Hash/保存均由调用方使用原文；仅解析副本容忍首 BOM。 */
export function parseReferenceSourcePack(rawPack: unknown): SourcePack | null {
  if (typeof rawPack !== 'string' || rawPack.length > MAX_REFERENCE_SOURCE_PACK_BYTES) return null;
  const bytes = new TextEncoder().encode(rawPack);
  if (bytes.byteLength > MAX_REFERENCE_SOURCE_PACK_BYTES || new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) !== rawPack) return null;
  try { const value: unknown = JSON.parse(rawPack.startsWith('\uFEFF') ? rawPack.slice(1) : rawPack); return isSourcePack(value) ? value : null; } catch { return null; }
}
export function isRegisterReferenceSourceRequest(v: unknown): v is RegisterReferenceSourceRequest {
  return record(v) && keys(v, ['commandId', 'rawPack', 'packHash', 'userConfirmed']) && isCollectionId(v.commandId) && hash(v.packHash) && v.userConfirmed === true && parseReferenceSourcePack(v.rawPack) !== null;
}
const sourceKeys = ['id', 'bookId', 'title', 'sourceVersion', 'packHash', 'itemCount', 'createdAt'];
export function isReferenceSourceVersion(v: unknown): v is ReferenceSourceVersion {
  return record(v) && keys(v, sourceKeys) && isCollectionId(v.id) && isReferenceCatalogKey(v.bookId) && text(v.title, 240) && text(v.sourceVersion)
    && hash(v.packHash) && integer(v.itemCount, 1, MAX_CATALOG_REFERENCES) && timestamp(v.createdAt);
}
export function isReferenceSourceDetail(v: unknown): v is ReferenceSourceDetail {
  if (!record(v) || !keys(v, ['source', 'rawPack']) || !isReferenceSourceVersion(v.source)) return false;
  const pack = parseReferenceSourcePack(v.rawPack);
  return pack !== null && pack.bookId === v.source.bookId && pack.title === v.source.title && pack.sourceVersion === v.source.sourceVersion && normalizeReferenceItems(pack.items)?.length === v.source.itemCount;
}
const paging = (v: Record<string, unknown>): boolean => integer(v.offset, 0, 1_000_000) && integer(v.limit, 1, 25);
export function isReferenceSourceListRequest(v: unknown): v is ReferenceSourceListRequest { return record(v) && keys(v, ['bookId', 'offset', 'limit']) && (v.bookId === undefined || isReferenceCatalogKey(v.bookId)) && paging(v); }
export function isReferenceSourcePage(v: unknown): v is ReferenceSourcePage {
  return record(v) && keys(v, ['items', 'total', 'offset', 'limit']) && paging(v) && integer(v.total) && array(v.items, isReferenceSourceVersion, 25)
    && v.items.length <= (v.limit as number) && unique(v.items.map(i => i.id)) && v.items.length <= v.total;
}
export function isCatalogIdRequest(v: unknown): v is CatalogIdRequest { return record(v) && keys(v, ['id']) && isCollectionId(v.id); }
export function isCatalogHistoryRequest(v: unknown): v is CatalogHistoryRequest { return record(v) && keys(v, ['bookId', 'offset', 'limit']) && isReferenceCatalogKey(v.bookId) && paging(v); }
export function isCatalogMapping(v: unknown): v is CatalogMapping {
  return record(v) && keys(v, ['fromReferenceIds', 'toReferenceIds']) && referenceKeys(v.fromReferenceIds) && referenceKeys(v.toReferenceIds)
    && v.fromReferenceIds.length > 0 && v.toReferenceIds.length > 0 && (v.fromReferenceIds.length === 1 || v.toReferenceIds.length === 1);
}
function mappings(v: unknown): v is CatalogMapping[] {
  return array(v, isCatalogMapping, MAX_CATALOG_REFERENCES) && unique(v.flatMap(m => m.fromReferenceIds)) && unique(v.flatMap(m => m.toReferenceIds));
}
function canonicalItems(v: unknown): v is CanonicalReference[] {
  return array(v, isCanonicalReference, MAX_CATALOG_REFERENCES, 1) && unique(v.map(i => i.referenceId)) && unique(v.map(identity))
    && v.every(i => i.bookId === v[0]?.bookId && unique(i.lengths) && unique(i.pages)) && boundedJson(v, MAX_REFERENCE_REVISION_BYTES);
}
const previewKeys = ['sourceId', 'expectedCurrentRevisionId', 'items', 'mappings'];
function previewFields(v: Record<string, unknown>): boolean {
  return isCollectionId(v.sourceId) && nullableId(v.expectedCurrentRevisionId) && canonicalItems(v.items) && mappings(v.mappings)
    && v.mappings.every(m => m.toReferenceIds.every(id => (v.items as CanonicalReference[]).some(i => i.referenceId === id))) && boundedJson(v, MAX_REFERENCE_REVISION_BYTES);
}
export function isPreviewCatalogRevisionRequest(v: unknown): v is PreviewCatalogRevisionRequest { return record(v) && keys(v, previewKeys) && previewFields(v); }
export function isPublishCatalogRevisionRequest(v: unknown): v is PublishCatalogRevisionRequest {
  return record(v) && keys(v, [...previewKeys, 'commandId', 'baselineFingerprint', 'userConfirmed']) && previewFields(v) && isCollectionId(v.commandId) && hash(v.baselineFingerprint) && v.userConfirmed === true;
}
const revisionKeys = ['id', 'bookId', 'sourceId', 'packHash', 'sequence', 'previousRevisionId', 'createdAt'];
function revisionFields(v: Record<string, unknown>): boolean {
  return isCollectionId(v.id) && isReferenceCatalogKey(v.bookId) && isCollectionId(v.sourceId) && hash(v.packHash) && integer(v.sequence, 1) && nullableId(v.previousRevisionId) && timestamp(v.createdAt);
}
export function isCatalogRevision(v: unknown): v is CatalogRevision {
  return record(v) && keys(v, [...revisionKeys, 'items', 'mappings']) && revisionFields(v) && canonicalItems(v.items) && v.items.every(i => i.bookId === v.bookId) && mappings(v.mappings)
    && v.mappings.every(m => m.toReferenceIds.every(id => (v.items as CanonicalReference[]).some(i => i.referenceId === id)));
}
export function isCatalogRevisionSummary(v: unknown): v is CatalogRevisionSummary { return record(v) && keys(v, [...revisionKeys, 'itemCount']) && revisionFields(v) && integer(v.itemCount, 1, MAX_CATALOG_REFERENCES); }
export function isCatalogMatch(v: unknown): v is CatalogMatch {
  if (!record(v) || !keys(v, ['referenceId', 'modelId', 'status', 'availability']) || !isReferenceCatalogKey(v.referenceId)) return false;
  return v.status === 'unmatched' ? v.modelId === null && typeof v.availability === 'string' && ['missing', 'unknown'].includes(v.availability)
    : typeof v.status === 'string' && ['confirmed', 'candidate', 'needs-review'].includes(v.status) && isCollectionId(v.modelId) && v.availability === 'unknown';
}
export function isSetCatalogMatchRequest(v: unknown): v is SetCatalogMatchRequest {
  return record(v) && keys(v, ['commandId', 'revisionId', 'expectedMatchVersion', 'match', 'userConfirmed']) && isCollectionId(v.commandId) && isCollectionId(v.revisionId)
    && integer(v.expectedMatchVersion) && isCatalogMatch(v.match) && v.userConfirmed === true;
}
const completionKeys = ['total', 'owned', 'missing', 'unknown', 'candidate', 'needsReview'] as const;
export function isCatalogCompletion(v: unknown): v is CatalogCompletion {
  return record(v) && keys(v, completionKeys) && completionKeys.every(k => integer(v[k], 0, MAX_CATALOG_REFERENCES))
    && v.total === (v.owned as number) + (v.missing as number) + (v.unknown as number) && (v.candidate as number) <= (v.unknown as number) && (v.needsReview as number) <= (v.unknown as number);
}
function matches(v: unknown): v is CatalogMatch[] {
  return array(v, isCatalogMatch, MAX_CATALOG_MATCHES) && unique(v.map(m => JSON.stringify([m.referenceId, m.modelId])))
    && unique(v.filter(m => m.status === 'confirmed').map(m => m.modelId));
}
export function isCatalogSnapshotEntry(v: unknown): v is CatalogSnapshotEntry {
  if (!record(v) || !keys(v, ['referenceId', 'state', 'matches', 'stockCount']) || !isReferenceCatalogKey(v.referenceId) || !integer(v.stockCount) || !matches(v.matches)
    || !v.matches.every(m => m.referenceId === v.referenceId) || v.matches.some(m => m.status === 'unmatched') && v.matches.length !== 1) return false;
  const confirmed = v.matches.some(m => m.status === 'confirmed');
  const expected = confirmed && v.stockCount > 0 ? 'owned' : v.matches.some(m => m.availability === 'missing') ? 'missing' : 'unknown';
  return v.state === expected && (confirmed || v.stockCount === 0);
}
function completionEntries(counts: unknown, entries: unknown): entries is CatalogSnapshotEntry[] {
  if (!isCatalogCompletion(counts) || !array(entries, isCatalogSnapshotEntry, MAX_CATALOG_REFERENCES) || !unique(entries.map(e => e.referenceId)) || !matches(entries.flatMap(e => e.matches))) return false;
  return counts.total === entries.length && counts.owned === entries.filter(e => e.state === 'owned').length
    && counts.missing === entries.filter(e => e.state === 'missing').length && counts.unknown === entries.filter(e => e.state === 'unknown').length
    && counts.candidate === entries.filter(e => e.state === 'unknown' && e.matches.some(m => m.status === 'candidate')).length
    && counts.needsReview === entries.filter(e => e.state === 'unknown' && e.matches.some(m => m.status === 'needs-review')).length;
}
const snapshotKeys = ['id', 'bookId', 'revisionId', 'matchVersion', 'createdAt', 'counts'];
function snapshotFields(v: Record<string, unknown>): boolean { return isCollectionId(v.id) && isReferenceCatalogKey(v.bookId) && isCollectionId(v.revisionId) && integer(v.matchVersion) && timestamp(v.createdAt) && isCatalogCompletion(v.counts); }
export function isCatalogSnapshot(v: unknown): v is CatalogSnapshot { return record(v) && keys(v, [...snapshotKeys, 'entries']) && snapshotFields(v) && completionEntries(v.counts, v.entries); }
export function isCatalogSnapshotSummary(v: unknown): v is CatalogSnapshotSummary { return record(v) && keys(v, snapshotKeys) && snapshotFields(v); }
const matchFacts = (value: readonly CatalogMatch[]): string => JSON.stringify(value.map(m => JSON.stringify([m.referenceId, m.modelId, m.status, m.availability])).sort());
export function isCatalogRevisionDetail(v: unknown): v is CatalogRevisionDetail {
  return record(v) && keys(v, ['revision', 'matches', 'matchVersion', 'snapshot', 'currentCounts', 'currentEntries']) && isCatalogRevision(v.revision) && matches(v.matches) && integer(v.matchVersion)
    && isCatalogSnapshot(v.snapshot) && v.snapshot.bookId === v.revision.bookId && v.snapshot.revisionId === v.revision.id && v.snapshot.matchVersion <= v.matchVersion
    && v.snapshot.entries.length === v.revision.items.length && v.snapshot.entries.every(e => (v.revision as CatalogRevision).items.some(i => i.referenceId === e.referenceId))
    && completionEntries(v.currentCounts, v.currentEntries) && v.currentEntries.length === v.revision.items.length
    && v.currentEntries.every(e => (v.revision as CatalogRevision).items.some(i => i.referenceId === e.referenceId))
    && matchFacts(v.matches) === matchFacts(v.currentEntries.flatMap(e => e.matches));
}
export function isCatalogRevisionDelta(v: unknown): v is CatalogRevisionDelta {
  return record(v) && keys(v, ['addedReferenceIds', 'removedReferenceIds', 'retainedReferenceIds', 'merged', 'split', 'before', 'after'])
    && referenceKeys(v.addedReferenceIds) && referenceKeys(v.removedReferenceIds) && referenceKeys(v.retainedReferenceIds)
    && unique([...v.addedReferenceIds, ...v.removedReferenceIds, ...v.retainedReferenceIds]) && integer(v.merged, 0, MAX_CATALOG_REFERENCES) && integer(v.split, 0, MAX_CATALOG_REFERENCES)
    && (v.before === null || isCatalogCompletion(v.before)) && isCatalogCompletion(v.after);
}
export function isCatalogRevisionPreview(v: unknown): v is CatalogRevisionPreview {
  return record(v) && keys(v, ['baselineFingerprint', 'expectedCurrentRevisionId', 'counts', 'entries', 'delta']) && hash(v.baselineFingerprint) && nullableId(v.expectedCurrentRevisionId)
    && completionEntries(v.counts, v.entries) && isCatalogRevisionDelta(v.delta) && completionKeys.every(k => (v.counts as CatalogCompletion)[k] === (v.delta as CatalogRevisionDelta).after[k]);
}
export function isCatalogHistory(v: unknown): v is CatalogHistory {
  return record(v) && keys(v, ['bookId', 'currentRevisionId', 'revisions', 'snapshots', 'total', 'offset', 'limit']) && isReferenceCatalogKey(v.bookId) && nullableId(v.currentRevisionId) && paging(v) && integer(v.total)
    && array(v.revisions, isCatalogRevisionSummary, 25) && v.revisions.length <= (v.limit as number) && v.revisions.length <= v.total && unique(v.revisions.map(r => r.id)) && v.revisions.every(r => r.bookId === v.bookId)
    && array(v.snapshots, isCatalogSnapshotSummary, 75) && unique(v.snapshots.map(s => s.id)) && v.snapshots.every(s => s.bookId === v.bookId && (v.revisions as CatalogRevisionSummary[]).some(r => r.id === s.revisionId));
}
