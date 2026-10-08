import { isCollectionId } from './collection.js';
import { isFileAudioParameters, type FileAudioParameters } from './audio-quality.js';
import type { VersionNameToken } from './local-name-rules.js';

/** 本地目录只公开稳定身份及修订；文件位置和读取能力留在原工作库作者内部。 */
export type LocalCatalogRevision = string;
export type LibraryRootRole = 'library' | 'recording-reference';
export interface LibraryRoot { id: string; sourceRootId: string; role: LibraryRootRole; revision: LocalCatalogRevision }
export interface AudioAsset {
  id: string; libraryRootId: string; sourceRootId: string; rootRevision: LocalCatalogRevision;
  fileRevision: LocalCatalogRevision; locationRevision: LocalCatalogRevision;
  sampleFrames: string | null; timebaseHz: number | null;
}
export interface LocalTrackSegment { id: string; startFrame: string; endFrameExclusive: string; timebaseHz: number }
export interface LocalTrack { id: string; assetId: string; selectionRevision: LocalCatalogRevision; segment: LocalTrackSegment | null }
export interface AlbumEdition { id: string; title: string; edition: string; revision: LocalCatalogRevision }
export interface AlbumEditionTrack {
  id: string; editionId: string; trackId: string; disc: number; trackNumber: number; sequence: number;
  revision: LocalCatalogRevision; active: boolean;
}
export interface LocalMetadata { title?: string; artist?: string; album?: string; year?: string; disc?: string; track?: string }
export interface LocalMetadataObservation {
  id: string; trackId: string; revision: LocalCatalogRevision; source: 'tag' | 'synthetic'; parserVersion: string; fields: LocalMetadata;
}
/** 人工说明及分组建议只属于MB；不会生成发行身份或源标签。 */
export interface LocalGroupingSuggestion { editionId: string; expectedRevision: string; reason: string }
export interface LocalMetadataAnnotations { versionDescription?: string; groupingSuggestions?: LocalGroupingSuggestion[] }
export interface LocalMetadataOverride { trackId: string; revision: LocalCatalogRevision; fields: LocalMetadata; annotations?: LocalMetadataAnnotations }
export const LOCAL_CATALOG_OPERATIONS = [
  'register-root', 'relink-root', 'register-asset', 'move-asset', 'replace-asset',
  'create-track', 'select-asset', 'create-edition', 'link-edition-track', 'remove-edition-track',
  'observe-metadata', 'override-metadata',
] as const;
export type LocalCatalogOperation = typeof LOCAL_CATALOG_OPERATIONS[number];
export type LocalCatalogResult = LibraryRoot | AudioAsset | LocalTrack | AlbumEdition | AlbumEditionTrack | LocalMetadataObservation | LocalMetadataOverride;
export interface LocalCatalogReceipt { commandId: string; operation: LocalCatalogOperation; fingerprint: string; result: LocalCatalogResult }

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean =>
  required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const unsigned64 = 18_446_744_073_709_551_615n;
export function isLocalExactInteger(v: unknown): v is string {
  return typeof v === 'string' && /^(0|[1-9][0-9]*)$/u.test(v) && v.length <= 20 && BigInt(v) <= unsigned64;
}
export function isLocalCatalogRevision(v: unknown): v is LocalCatalogRevision { return isLocalExactInteger(v) && v !== '0'; }
export function isLocalCatalogText(v: unknown, allowEmpty = false): v is string {
  return typeof v === 'string' && v.length <= 512 && (allowEmpty || v.trim().length > 0)
    && !/[\u0000-\u001f\u007f]/u.test(v)
    // URI 必含字面分隔符；凭据独立检查，两个分支都保留原 Unicode 忽略大小写规则。
    && !/(?:bearer|cookie|token|session[_-]?(?:id|handle))\s*[:=]/iu.test(v)
    && (!v.includes('://') || !/[a-z][a-z0-9+.-]*:\/\//iu.test(v));
}
export function isLibraryRootRole(v: unknown): v is LibraryRootRole { return v === 'library' || v === 'recording-reference'; }
export function isLibraryRoot(v: unknown): v is LibraryRoot {
  return record(v) && keys(v, ['id', 'sourceRootId', 'role', 'revision']) && isCollectionId(v.id)
    && isCollectionId(v.sourceRootId) && isLibraryRootRole(v.role) && isLocalCatalogRevision(v.revision);
}
const timebase = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= 1_000_000_000;
export function isAudioAsset(v: unknown): v is AudioAsset {
  return record(v) && keys(v, ['id', 'libraryRootId', 'sourceRootId', 'rootRevision', 'fileRevision', 'locationRevision', 'sampleFrames', 'timebaseHz'])
    && isCollectionId(v.id) && isCollectionId(v.libraryRootId) && isCollectionId(v.sourceRootId)
    && isLocalCatalogRevision(v.rootRevision) && isLocalCatalogRevision(v.fileRevision) && isLocalCatalogRevision(v.locationRevision)
    && ((v.sampleFrames === null && v.timebaseHz === null) || (isLocalExactInteger(v.sampleFrames) && v.sampleFrames !== '0' && timebase(v.timebaseHz)));
}
export function isLocalTrackSegment(v: unknown): v is LocalTrackSegment {
  return record(v) && keys(v, ['id', 'startFrame', 'endFrameExclusive', 'timebaseHz']) && isCollectionId(v.id)
    && isLocalExactInteger(v.startFrame) && isLocalExactInteger(v.endFrameExclusive)
    && BigInt(v.startFrame) < BigInt(v.endFrameExclusive) && timebase(v.timebaseHz);
}
export function isLocalTrack(v: unknown): v is LocalTrack {
  return record(v) && keys(v, ['id', 'assetId', 'selectionRevision', 'segment']) && isCollectionId(v.id)
    && isCollectionId(v.assetId) && isLocalCatalogRevision(v.selectionRevision) && (v.segment === null || isLocalTrackSegment(v.segment));
}
export function isAlbumEdition(v: unknown): v is AlbumEdition {
  return record(v) && keys(v, ['id', 'title', 'edition', 'revision']) && isCollectionId(v.id)
    && isLocalCatalogText(v.title) && isLocalCatalogText(v.edition, true) && isLocalCatalogRevision(v.revision);
}
const ordinal = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= 1_000_000;
export function isAlbumEditionTrack(v: unknown): v is AlbumEditionTrack {
  return record(v) && keys(v, ['id', 'editionId', 'trackId', 'disc', 'trackNumber', 'sequence', 'revision', 'active'])
    && isCollectionId(v.id) && isCollectionId(v.editionId) && isCollectionId(v.trackId) && ordinal(v.disc)
    && ordinal(v.trackNumber) && ordinal(v.sequence) && isLocalCatalogRevision(v.revision) && typeof v.active === 'boolean';
}
export function isLocalMetadata(v: unknown): v is LocalMetadata {
  return record(v) && keys(v, [], ['title', 'artist', 'album', 'year', 'disc', 'track']) && Object.values(v).every(value => isLocalCatalogText(value, true));
}
export function isLocalMetadataObservation(v: unknown): v is LocalMetadataObservation {
  return record(v) && keys(v, ['id', 'trackId', 'revision', 'source', 'parserVersion', 'fields']) && isCollectionId(v.id)
    && isCollectionId(v.trackId) && isLocalCatalogRevision(v.revision) && (v.source === 'tag' || v.source === 'synthetic')
    && isLocalCatalogText(v.parserVersion) && isLocalMetadata(v.fields) && Object.keys(v.fields).length > 0;
}
export function isLocalMetadataOverride(v: unknown): v is LocalMetadataOverride {
  return record(v) && keys(v, ['trackId', 'revision', 'fields'], ['annotations']) && isCollectionId(v.trackId) && isLocalCatalogRevision(v.revision) && isLocalMetadata(v.fields)
    && (!Object.hasOwn(v, 'annotations') || isLocalMetadataAnnotations(v.annotations));
}
export function isLocalMetadataAnnotations(v: unknown): v is LocalMetadataAnnotations {
  const closed = (value: unknown, names: readonly string[]): value is Record<string, unknown> => record(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).every(k => typeof k === 'string' && names.includes(k)
      && Object.getOwnPropertyDescriptor(value, k)?.enumerable === true && Object.hasOwn(Object.getOwnPropertyDescriptor(value, k)!, 'value'));
  if (!closed(v, ['versionDescription', 'groupingSuggestions'])) return false;
  if (Object.hasOwn(v, 'versionDescription') && !isLocalCatalogText(v.versionDescription, true)) return false;
  if (!Object.hasOwn(v, 'groupingSuggestions')) return true;
  const values = v.groupingSuggestions;
  return libraryArray(values, 8) && values.every(s => closed(s, ['editionId', 'expectedRevision', 'reason']) && Reflect.ownKeys(s).length === 3
    && isCollectionId(s.editionId) && isLocalCatalogRevision(s.expectedRevision) && isLocalCatalogText(s.reason))
    && new Set(values.map(s => (s as LocalGroupingSuggestion).editionId)).size === values.length;
}
export function isLocalCatalogResult(operation: LocalCatalogOperation, v: unknown): v is LocalCatalogResult {
  switch (operation) {
    case 'register-root': case 'relink-root': return isLibraryRoot(v);
    case 'register-asset': case 'move-asset': case 'replace-asset': return isAudioAsset(v);
    case 'create-track': case 'select-asset': return isLocalTrack(v);
    case 'create-edition': return isAlbumEdition(v);
    case 'link-edition-track': case 'remove-edition-track': return isAlbumEditionTrack(v);
    case 'observe-metadata': return isLocalMetadataObservation(v);
    case 'override-metadata': return isLocalMetadataOverride(v);
  }
}
export function isLocalCatalogReceipt(v: unknown): v is LocalCatalogReceipt {
  return record(v) && keys(v, ['commandId', 'operation', 'fingerprint', 'result']) && isCollectionId(v.commandId)
    && (LOCAL_CATALOG_OPERATIONS as readonly unknown[]).includes(v.operation) && typeof v.fingerprint === 'string'
    && /^[a-f0-9]{64}$/u.test(v.fingerprint) && isLocalCatalogResult(v.operation as LocalCatalogOperation, v.result);
}


/** 普通逻辑写只接受现有身份；可信定位和raw观察采用专用内部入口。 */
interface CatalogCommand { commandId: string }
export interface RegisterLibraryRootRequest extends CatalogCommand { sourceRootId: string; role: LibraryRootRole }
export interface RelinkLibraryRootRequest extends RegisterLibraryRootRequest { rootId: string; expectedRevision: string }
export interface RegisterAudioAssetRequest extends CatalogCommand { libraryRootId: string; expectedRootRevision: string; relative: string; sha256: string | null; sampleFrames: string | null; timebaseHz: number | null }
export interface MoveAudioAssetRequest extends CatalogCommand { assetId: string; expectedLocationRevision: string; expectedRootRevision: string; relative: string }
export interface ReplaceAudioAssetRequest extends RegisterAudioAssetRequest { assetId: string; expectedFileRevision: string; expectedLocationRevision: string }
export interface CreateLocalTrackRequest extends CatalogCommand { assetId: string; segment: Omit<LocalTrackSegment, 'id'> | null }
export interface SelectLocalAssetRequest extends CatalogCommand { trackId: string; expectedSelectionRevision: string; assetId: string }
export interface CreateAlbumEditionRequest extends CatalogCommand { title: string; edition: string }
export interface LinkEditionTrackRequest extends CatalogCommand { editionId: string; trackId: string; disc: number; trackNumber: number; sequence: number }
export interface RemoveEditionTrackRequest extends CatalogCommand { id: string; expectedRevision: string }
export interface ObserveLocalMetadataRequest extends CatalogCommand { trackId: string; source: 'tag' | 'synthetic'; parserVersion: string; fields: LocalMetadata }
export interface OverrideLocalMetadataRequest extends CatalogCommand { trackId: string; expectedRevision: string | null; fields: LocalMetadata; annotations?: LocalMetadataAnnotations }
export interface LocalMetadataView { raw: LocalMetadata; override: LocalMetadataOverride | null; effective: LocalMetadata }
/** 查询只携带本地逻辑对象；名字证据不生成发行身份，详情不携带定位或读票据。 */
export interface LocalLibraryQuery { query: string; rootId: string | null; offset: number; limit: number }
export interface LocalLibraryTrackSummary { track: LocalTrack; asset: AudioAsset; metadata: LocalMetadata; versionTokens: VersionNameToken[] }
export interface LocalLibraryQueryPage extends LocalLibraryQuery { total: number; hasMore: boolean; items: LocalLibraryTrackSummary[] }
export interface LocalLibraryTrackDetail {
  track: LocalTrack; asset: AudioAsset; metadata: LocalMetadataView; versionTokens: VersionNameToken[];
  editions: AlbumEdition[]; fileParameters: FileAudioParameters | null;
}
const libraryClosed = (v: Record<string, unknown>, names: readonly string[]): boolean => Reflect.ownKeys(v).length === names.length
  && names.every(k => Object.prototype.propertyIsEnumerable.call(v, k) && Object.hasOwn(Object.getOwnPropertyDescriptor(v, k)!, 'value'));
const libraryArray = (v: unknown, max: number): v is unknown[] => Array.isArray(v) && Object.getPrototypeOf(v) === Array.prototype
  && v.length <= max && Reflect.ownKeys(v).length === v.length + 1 && Reflect.ownKeys(v).every(k => k === 'length'
    || typeof k === 'string' && /^(0|[1-9][0-9]*)$/u.test(k) && Number(k) < v.length
      && Object.prototype.propertyIsEnumerable.call(v, k) && Object.hasOwn(Object.getOwnPropertyDescriptor(v, k)!, 'value'));
const libraryMetadata = (v: unknown): v is LocalMetadata => record(v) && Reflect.ownKeys(v).every(k => typeof k === 'string'
  && ['title', 'artist', 'album', 'year', 'disc', 'track'].includes(k) && Object.prototype.propertyIsEnumerable.call(v, k) && Object.hasOwn(Object.getOwnPropertyDescriptor(v, k)!, 'value')) && isLocalMetadata(v);
const libraryIdentity = (v: Record<string, unknown>): boolean => record(v.track) && libraryClosed(v.track, ['id', 'assetId', 'selectionRevision', 'segment'])
  && (v.track.segment === null || record(v.track.segment) && libraryClosed(v.track.segment, ['id', 'startFrame', 'endFrameExclusive', 'timebaseHz']))
  && isLocalTrack(v.track) && record(v.asset) && libraryClosed(v.asset, ['id', 'libraryRootId', 'sourceRootId', 'rootRevision', 'fileRevision', 'locationRevision', 'sampleFrames', 'timebaseHz']) && isAudioAsset(v.asset) && v.track.assetId === v.asset.id;
const libraryTokens = (v: unknown): v is VersionNameToken[] => libraryArray(v, 64) && v.every(token => record(token)
  && libraryClosed(token, ['raw', 'source', 'kind', 'start', 'end']) && isLocalCatalogText(token.raw)
  && ['title', 'artist', 'album'].includes(String(token.source)) && ['edition', 'format', 'disc', 'year'].includes(String(token.kind))
  && Number.isSafeInteger(token.start) && Number.isSafeInteger(token.end) && Number(token.start) >= 0 && Number(token.end) > Number(token.start) && Number(token.end) <= 1024);
export function isLocalLibraryQuery(v: unknown): v is LocalLibraryQuery {
  return record(v) && libraryClosed(v, ['query', 'rootId', 'offset', 'limit']) && isLocalCatalogText(v.query, true) && Array.from(v.query).length <= 256
    && (v.rootId === null || isCollectionId(v.rootId)) && Number.isSafeInteger(v.offset) && Number(v.offset) >= 0 && Number.isSafeInteger(v.limit) && Number(v.limit) >= 1 && Number(v.limit) <= 200;
}
export function isLocalLibraryTrackSummary(v: unknown): v is LocalLibraryTrackSummary {
  return record(v) && libraryClosed(v, ['track', 'asset', 'metadata', 'versionTokens']) && libraryIdentity(v) && libraryMetadata(v.metadata) && libraryTokens(v.versionTokens);
}
export function isLocalLibraryQueryPage(v: unknown): v is LocalLibraryQueryPage {
  return record(v) && libraryClosed(v, ['query', 'rootId', 'offset', 'limit', 'total', 'hasMore', 'items'])
    && isLocalLibraryQuery({ query: v.query, rootId: v.rootId, offset: v.offset, limit: v.limit }) && Number.isSafeInteger(v.total) && Number(v.total) >= 0
    && libraryArray(v.items, Number(v.limit)) && v.items.every(isLocalLibraryTrackSummary) && v.items.length === Math.min(Number(v.limit), Math.max(0, Number(v.total) - Number(v.offset)))
    && v.hasMore === (Number(v.offset) + v.items.length < Number(v.total)) && new TextEncoder().encode(JSON.stringify(v)).byteLength <= 2 * 1024 * 1024;
}
export function isLocalLibraryTrackDetail(v: unknown): v is LocalLibraryTrackDetail {
  return record(v) && libraryClosed(v, ['track', 'asset', 'metadata', 'versionTokens', 'editions', 'fileParameters']) && libraryIdentity(v)
    && record(v.metadata) && libraryClosed(v.metadata, ['raw', 'override', 'effective']) && libraryMetadata(v.metadata.raw) && libraryMetadata(v.metadata.effective)
    && (v.metadata.override === null || record(v.metadata.override) && libraryClosed(v.metadata.override, ['trackId', 'revision', 'fields', ...(Object.hasOwn(v.metadata.override, 'annotations') ? ['annotations'] : [])])
      && libraryMetadata(v.metadata.override.fields) && isLocalMetadataOverride(v.metadata.override) && v.metadata.override.trackId === (v.track as LocalTrack).id) && isLocalMetadataView(v.metadata)
    && libraryTokens(v.versionTokens) && libraryArray(v.editions, 200) && v.editions.every(e => record(e) && libraryClosed(e, ['id', 'title', 'edition', 'revision']) && isAlbumEdition(e))
    && (v.fileParameters === null || record(v.fileParameters) && libraryClosed(v.fileParameters, ['container', 'codec', 'lossless', 'sampleRateHz', 'channels', 'bitsPerSample', 'durationMs', 'evidence']) && isFileAudioParameters(v.fileParameters)) && new TextEncoder().encode(JSON.stringify(v)).byteLength <= 2 * 1024 * 1024;
}
export interface LocalCatalogReceiptRequest { commandId: string; operation: LocalCatalogOperation; fingerprint: string }
export interface LocalCatalogCommandPayloads {
  'localCatalog.registerRoot': RegisterLibraryRootRequest;
  'localCatalog.relinkRoot': RelinkLibraryRootRequest;
  'localCatalog.registerAsset': RegisterAudioAssetRequest;
  'localCatalog.moveAsset': MoveAudioAssetRequest;
  'localCatalog.replaceAsset': ReplaceAudioAssetRequest;
  'localCatalog.createTrack': CreateLocalTrackRequest;
  'localCatalog.selectAsset': SelectLocalAssetRequest;
  'localCatalog.createEdition': CreateAlbumEditionRequest;
  'localCatalog.linkEditionTrack': LinkEditionTrackRequest;
  'localCatalog.removeEditionTrack': RemoveEditionTrackRequest;
  'localCatalog.observeMetadata': ObserveLocalMetadataRequest;
  'localCatalog.overrideMetadata': OverrideLocalMetadataRequest;
  'localCatalog.root': { rootId: string };
  'localCatalog.roots': Record<string, never>;
  'localCatalog.asset': { assetId: string };
  'localCatalog.track': { trackId: string };
  'localCatalog.pageTracks': { offset: number; limit: number };
  'localCatalog.edition': { editionId: string };
  'localCatalog.editionTracks': { editionId: string };
  'localCatalog.observations': { trackId: string };
  'localCatalog.metadata': { trackId: string };
  'localCatalog.receipt': LocalCatalogReceiptRequest;
}
export interface LocalCatalogCommandResults {
  'localCatalog.registerRoot': LibraryRoot; 'localCatalog.relinkRoot': LibraryRoot;
  'localCatalog.registerAsset': AudioAsset; 'localCatalog.moveAsset': AudioAsset; 'localCatalog.replaceAsset': AudioAsset;
  'localCatalog.createTrack': LocalTrack; 'localCatalog.selectAsset': LocalTrack;
  'localCatalog.createEdition': AlbumEdition;
  'localCatalog.linkEditionTrack': AlbumEditionTrack; 'localCatalog.removeEditionTrack': AlbumEditionTrack;
  'localCatalog.observeMetadata': LocalMetadataObservation; 'localCatalog.overrideMetadata': LocalMetadataOverride;
  'localCatalog.root': LibraryRoot; 'localCatalog.roots': LibraryRoot[];
  'localCatalog.asset': AudioAsset; 'localCatalog.track': LocalTrack;
  'localCatalog.pageTracks': import('./library.js').Page<LocalTrack>;
  'localCatalog.edition': AlbumEdition; 'localCatalog.editionTracks': AlbumEditionTrack[];
  'localCatalog.observations': LocalMetadataObservation[]; 'localCatalog.metadata': LocalMetadataView;
  'localCatalog.receipt': LocalCatalogReceipt | null;
}
/** 新增只读投影独立扩展，原22个目录合同及其穷举映射保持可用。 */
export interface LocalLibraryReadCommandPayloads {
  'localCatalog.queryTracks': LocalLibraryQuery;
  'localCatalog.trackDetail': { trackId: string };
}
export interface LocalLibraryReadCommandResults {
  'localCatalog.queryTracks': LocalLibraryQueryPage;
  'localCatalog.trackDetail': LocalLibraryTrackDetail;
}
type CatalogPayloads = LocalCatalogCommandPayloads & LocalLibraryReadCommandPayloads;
type CatalogResults = LocalCatalogCommandResults & LocalLibraryReadCommandResults;
export const LOCAL_CATALOG_WRITE_OPERATIONS = {
  'localCatalog.registerRoot': 'register-root', 'localCatalog.relinkRoot': 'relink-root',
  'localCatalog.registerAsset': 'register-asset', 'localCatalog.moveAsset': 'move-asset', 'localCatalog.replaceAsset': 'replace-asset',
  'localCatalog.createTrack': 'create-track', 'localCatalog.selectAsset': 'select-asset',
  'localCatalog.createEdition': 'create-edition', 'localCatalog.linkEditionTrack': 'link-edition-track', 'localCatalog.removeEditionTrack': 'remove-edition-track',
  'localCatalog.observeMetadata': 'observe-metadata', 'localCatalog.overrideMetadata': 'override-metadata',
} as const satisfies Record<string, LocalCatalogOperation>;
export const LOCAL_CATALOG_COMMANDS = [
  'localCatalog.registerRoot', 'localCatalog.relinkRoot', 'localCatalog.registerAsset', 'localCatalog.moveAsset', 'localCatalog.replaceAsset',
  'localCatalog.createTrack', 'localCatalog.selectAsset', 'localCatalog.createEdition', 'localCatalog.linkEditionTrack', 'localCatalog.removeEditionTrack',
  'localCatalog.observeMetadata', 'localCatalog.overrideMetadata',
  'localCatalog.root', 'localCatalog.roots', 'localCatalog.asset', 'localCatalog.track', 'localCatalog.pageTracks',
  'localCatalog.edition', 'localCatalog.editionTracks', 'localCatalog.observations', 'localCatalog.metadata', 'localCatalog.receipt',
] as const;
export const LOCAL_LIBRARY_READ_COMMANDS = ['localCatalog.queryTracks', 'localCatalog.trackDetail'] as const;
export type LocalCatalogCommand = keyof CatalogPayloads;
export const LOCAL_CATALOG_INTERNAL_COMMANDS = ['localCatalog.registerRoot', 'localCatalog.relinkRoot', 'localCatalog.registerAsset', 'localCatalog.moveAsset', 'localCatalog.replaceAsset', 'localCatalog.observeMetadata'] as const;
export type LocalCatalogInternalCommand = typeof LOCAL_CATALOG_INTERNAL_COMMANDS[number];
export const LOCAL_CATALOG_OUTBOX_COMMANDS = ['localCatalog.createTrack', 'localCatalog.selectAsset', 'localCatalog.createEdition', 'localCatalog.linkEditionTrack', 'localCatalog.removeEditionTrack', 'localCatalog.overrideMetadata'] as const;
export function isLocalCatalogCommand(command: unknown): command is LocalCatalogCommand { return typeof command === 'string' && ((LOCAL_CATALOG_COMMANDS as readonly string[]).includes(command) || (LOCAL_LIBRARY_READ_COMMANDS as readonly string[]).includes(command)); }
export function isLocalCatalogInternalCommand(command: unknown): command is LocalCatalogInternalCommand { return typeof command === 'string' && (LOCAL_CATALOG_INTERNAL_COMMANDS as readonly string[]).includes(command); }
const relative = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096
  && !/[\u0000-\u001f\u007f\\:]/u.test(v) && !v.startsWith('/') && v.split('/').every(part => part !== '' && part !== '.' && part !== '..');
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
export function isLocalCatalogCommandPayload<C extends LocalCatalogCommand>(command: C, v: unknown): v is CatalogPayloads[C] {
  if (!record(v)) return false;
  const id = (key: string): boolean => isCollectionId(v[key]), revision = (key: string): boolean => isLocalCatalogRevision(v[key]);
  const assetKeys = ['commandId', 'libraryRootId', 'expectedRootRevision', 'relative', 'sha256', 'sampleFrames', 'timebaseHz'];
  const assetValues = (): boolean => id('libraryRootId') && revision('expectedRootRevision') && relative(v.relative) && (v.sha256 === null || hash(v.sha256))
    && ((v.sampleFrames === null && v.timebaseHz === null) || isLocalExactInteger(v.sampleFrames) && v.sampleFrames !== '0' && timebase(v.timebaseHz));
  if (Object.hasOwn(LOCAL_CATALOG_WRITE_OPERATIONS, command) && !id('commandId')) return false;
  switch (command) {
    case 'localCatalog.registerRoot': return keys(v, ['commandId','sourceRootId','role']) && id('sourceRootId') && isLibraryRootRole(v.role);
    case 'localCatalog.relinkRoot': return keys(v, ['commandId','sourceRootId','role','rootId','expectedRevision']) && id('sourceRootId') && isLibraryRootRole(v.role) && id('rootId') && revision('expectedRevision');
    case 'localCatalog.registerAsset': return keys(v, assetKeys) && assetValues();
    case 'localCatalog.replaceAsset': return keys(v, [...assetKeys,'assetId','expectedFileRevision','expectedLocationRevision']) && assetValues() && id('assetId') && revision('expectedFileRevision') && revision('expectedLocationRevision');
    case 'localCatalog.moveAsset': return keys(v, ['commandId','assetId','expectedLocationRevision','expectedRootRevision','relative']) && id('assetId') && revision('expectedLocationRevision') && revision('expectedRootRevision') && relative(v.relative);
    case 'localCatalog.createTrack': return keys(v, ['commandId','assetId','segment']) && id('assetId') && (v.segment === null || record(v.segment) && keys(v.segment, ['startFrame','endFrameExclusive','timebaseHz']) && isLocalTrackSegment({id: v.assetId, ...v.segment}));
    case 'localCatalog.selectAsset': return keys(v, ['commandId','trackId','expectedSelectionRevision','assetId']) && id('trackId') && revision('expectedSelectionRevision') && id('assetId');
    case 'localCatalog.createEdition': return keys(v, ['commandId','title','edition']) && isLocalCatalogText(v.title) && isLocalCatalogText(v.edition, true);
    case 'localCatalog.linkEditionTrack': return keys(v, ['commandId','editionId','trackId','disc','trackNumber','sequence']) && id('editionId') && id('trackId') && ordinal(v.disc) && ordinal(v.trackNumber) && ordinal(v.sequence);
    case 'localCatalog.removeEditionTrack': return keys(v, ['commandId','id','expectedRevision']) && id('id') && revision('expectedRevision');
    case 'localCatalog.observeMetadata': return keys(v, ['commandId','trackId','source','parserVersion','fields']) && id('trackId') && (v.source === 'tag' || v.source === 'synthetic') && isLocalCatalogText(v.parserVersion) && isLocalMetadata(v.fields) && Object.keys(v.fields).length > 0;
    case 'localCatalog.overrideMetadata': return keys(v, ['commandId','trackId','expectedRevision','fields'], ['annotations']) && id('trackId') && (v.expectedRevision === null || revision('expectedRevision')) && isLocalMetadata(v.fields) && (!Object.hasOwn(v, 'annotations') || isLocalMetadataAnnotations(v.annotations));
    case 'localCatalog.root': return keys(v, ['rootId']) && id('rootId');
    case 'localCatalog.roots': return keys(v, []);
    case 'localCatalog.asset': return keys(v, ['assetId']) && id('assetId');
    case 'localCatalog.trackDetail': return libraryClosed(v, ['trackId']) && id('trackId');
    case 'localCatalog.queryTracks': return isLocalLibraryQuery(v);
    case 'localCatalog.track': case 'localCatalog.observations': case 'localCatalog.metadata': return keys(v, ['trackId']) && id('trackId');
    case 'localCatalog.edition': case 'localCatalog.editionTracks': return keys(v, ['editionId']) && id('editionId');
    case 'localCatalog.pageTracks': return keys(v, ['offset','limit']) && typeof v.offset === 'number' && Number.isSafeInteger(v.offset) && v.offset >= 0 && typeof v.limit === 'number' && Number.isSafeInteger(v.limit) && v.limit > 0 && v.limit <= 200;
    case 'localCatalog.receipt': return keys(v, ['commandId','operation','fingerprint']) && id('commandId') && (LOCAL_CATALOG_OPERATIONS as readonly unknown[]).includes(v.operation) && hash(v.fingerprint);
  }
  return false;
}
export function isLocalCatalogCommandResult<C extends LocalCatalogCommand>(command: C, v: unknown): v is CatalogResults[C] {
  if (Object.hasOwn(LOCAL_CATALOG_WRITE_OPERATIONS, command)) return isLocalCatalogResult(LOCAL_CATALOG_WRITE_OPERATIONS[command as keyof typeof LOCAL_CATALOG_WRITE_OPERATIONS], v);
  switch (command) {
    case 'localCatalog.root': return isLibraryRoot(v);
    case 'localCatalog.roots': return Array.isArray(v) && v.length <= 100 && v.every(isLibraryRoot);
    case 'localCatalog.asset': return isAudioAsset(v);
    case 'localCatalog.queryTracks': return isLocalLibraryQueryPage(v);
    case 'localCatalog.trackDetail': return isLocalLibraryTrackDetail(v);
    case 'localCatalog.track': return isLocalTrack(v);
    case 'localCatalog.edition': return isAlbumEdition(v);
    case 'localCatalog.editionTracks': return Array.isArray(v) && v.length <= 200 && v.every(isAlbumEditionTrack);
    case 'localCatalog.observations': return Array.isArray(v) && v.length <= 200 && v.every(isLocalMetadataObservation);
    case 'localCatalog.metadata': return isLocalMetadataView(v);
    case 'localCatalog.receipt': return v === null || isLocalCatalogReceipt(v);
    case 'localCatalog.pageTracks': return record(v) && keys(v, ['offset','limit','total','items','hasMore']) && isLocalCatalogCommandPayload('localCatalog.pageTracks', {offset:v.offset,limit:v.limit})
      && typeof v.total === 'number' && Number.isSafeInteger(v.total) && v.total >= 0 && Array.isArray(v.items) && v.items.length <= Number(v.limit) && v.items.every(isLocalTrack)
      && v.items.length <= Math.max(0, v.total - Number(v.offset)) && v.hasMore === (Number(v.offset) + v.items.length < v.total);
  }
  return false;
}

function isLocalMetadataView(v: unknown): v is LocalMetadataView {
  if (!record(v) || !keys(v, ['raw','override','effective']) || !isLocalMetadata(v.raw) || !(v.override === null || isLocalMetadataOverride(v.override)) || !isLocalMetadata(v.effective)) return false;
  const expected = {...v.raw, ...(v.override?.fields ?? {})}, actual = v.effective;
  return Object.keys(expected).length === Object.keys(actual).length && (Object.keys(expected) as (keyof LocalMetadata)[]).every(key => expected[key] === actual[key]);
}
