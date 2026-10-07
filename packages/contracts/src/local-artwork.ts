import { isCollectionId } from './collection.js';
import { isLocalCatalogRevision, isLocalCatalogText, isAlbumEdition, type AlbumEdition } from './local-catalog.js';

/** 数字发行选图是独立关系；修订围栏不组成持久身份，图片不参与发行或音质判定。 */
export const LOCAL_ARTWORK_INPUT_BYTES = 4 * 1024 * 1024;
export const LOCAL_ARTWORK_DISPLAY_BYTES = 1024 * 1024;
export const LOCAL_ARTWORK_MAX_CANDIDATES = 4;
export interface LocalArtworkTarget { trackId: string; editionId: string; expectedEditionRevision: string; expectedTrackRevision: string; expectedSourceRevision: string }
export interface LocalArtworkImageInfo { mime: 'image/png' | 'image/jpeg'; bytes: number; sha256: string; width: number; height: number }
export interface LocalArtworkImage { original: LocalArtworkImageInfo; display: LocalArtworkImageInfo & { mime: 'image/jpeg'; dataUrl: string } }
export type LocalArtworkOrigin = 'local-independent' | 'embedded' | 'manual' | 'provider';
export interface CommonsArtworkSource {
  pageId: number; pageRevision: number; fileSha1: string; fileTimestamp: string; title: string; author: string | null;
  descriptionUrl: string; licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/'; policyVersion: '2026-10-07-cc0-only-v1';
}
export interface CoverArtArchiveSource {
  releaseId:string; imageId:string; releaseTitle:string; artist:string; releaseDate:string|null; country:string|null;
  releaseUrl:string; front:boolean; approved:boolean; musicBrainzMetadataLicense:'CC0-core'; imageRights:'unverified';
  imageVariant:'original'; policyVersion:'2026-10-07-caa-personal-v1';
}
export type LocalArtworkRemoteSource = CommonsArtworkSource | CoverArtArchiveSource;
export type LocalArtworkSearchProvider = 'cover-art-archive-v1' | 'commons-cc0-v1';
export interface SearchLocalArtworkCandidates { target:LocalArtworkTarget; query:string; provider?:LocalArtworkSearchProvider }
export interface LocalArtworkCandidate extends LocalArtworkImage {
  id: string; editionId: string; origin: LocalArtworkOrigin; sourceIdentity: string; sourceLabel: string;
  provider: 'local-readonly-v1' | LocalArtworkSearchProvider; license: 'user-supplied' | 'CC0-1.0' | 'rights-unverified'; expiresAt: string; remoteSource?: LocalArtworkRemoteSource;
}
export interface LocalArtworkSelection {
  id: string; editionId: string; revision: string; mode: 'manual' | 'local-default'; candidate: LocalArtworkCandidate | null;
}
export interface LocalArtworkContext {
  trackId: string; trackRevision: string; target: LocalArtworkTarget | null; editions: AlbumEdition[];
  selection: LocalArtworkSelection | null; candidates: LocalArtworkCandidate[];
  remoteProvider: 'off-pending-license' | 'commons-cc0-v1' | 'cover-art-archive-v1' | 'music-and-commons-v1'; sourceFilesWrite: 'OFF'; status: 'ready' | 'missing' | 'source-unavailable';
}
export interface ApplyLocalArtworkSelection {
  commandId: string; target: LocalArtworkTarget; candidateId: string | null; expectedSelectionRevision: string | null;
}
export interface CreateLocalArtworkEdition { commandId: string; trackId: string; expectedTrackRevision: string; title: string }
export interface LocalArtworkPublicApi {
  getLocalArtworkContext(request: { trackId: string; editionId: string | null }): Promise<LocalArtworkContext>;
  findLocalArtworkCandidates(target: LocalArtworkTarget): Promise<LocalArtworkContext>;
  searchLocalArtworkCandidates(request: SearchLocalArtworkCandidates): Promise<LocalArtworkContext>;
  chooseLocalArtworkFile(target: LocalArtworkTarget): Promise<LocalArtworkContext | null>;
  importLocalArtworkBytes(request: { target: LocalArtworkTarget; bytes: Uint8Array }): Promise<LocalArtworkContext>;
  applyLocalArtworkSelection(request: ApplyLocalArtworkSelection): Promise<LocalArtworkSelection>;
  createLocalArtworkEdition(request: CreateLocalArtworkEdition): Promise<AlbumEdition>;
  cancelLocalArtworkLookup(target: LocalArtworkTarget): Promise<void>;
}

/** 闭集验证先检查描述符，避免 getter、隐藏键和 symbol 在克隆前被执行或抹掉。 */
export function isLocalArtworkRecord(v: unknown, names: readonly string[]): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return false;
  const keys = Reflect.ownKeys(v);
  return keys.length === names.length && keys.every(k => typeof k === 'string' && names.includes(k)
    && Object.getOwnPropertyDescriptor(v, k)?.enumerable === true && Object.hasOwn(Object.getOwnPropertyDescriptor(v, k)!, 'value'));
}
const int = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= max;
/** IPC数组也按自有数据描述符核验，拒绝稀疏数组与索引getter。 */
function denseArray(v: unknown, max: number): v is unknown[] {
  if (!Array.isArray(v) || v.length > max || Object.getPrototypeOf(v) !== Array.prototype || Reflect.ownKeys(v).length !== v.length + 1) return false;
  for (let i = 0; i < v.length; i++) { const d = Object.getOwnPropertyDescriptor(v,String(i)); if (!d?.enumerable || !Object.hasOwn(d,'value')) return false; }
  return true;
}
export function isLocalArtworkQuery(v: unknown): v is string { return typeof v === 'string' && v === v.trim() && v.length >= 1 && v.length <= 80 && !/[\u0000-\u001f\u007f]|:\/\//u.test(v); }
export function isCommonsArtworkSource(v: unknown): v is CommonsArtworkSource {
  if (!isLocalArtworkRecord(v,['pageId','pageRevision','fileSha1','fileTimestamp','title','author','descriptionUrl','licenseUrl','policyVersion'])
    || !int(v.pageId,Number.MAX_SAFE_INTEGER) || !int(v.pageRevision,Number.MAX_SAFE_INTEGER) || typeof v.fileSha1 !== 'string' || !/^[a-f0-9]{40}$/u.test(v.fileSha1)
    || typeof v.fileTimestamp !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u.test(v.fileTimestamp) || !Number.isFinite(Date.parse(v.fileTimestamp))
    || !isLocalCatalogText(v.title) || !v.title.startsWith('File:') || v.author !== null && !isLocalCatalogText(v.author)
    || v.licenseUrl !== 'https://creativecommons.org/publicdomain/zero/1.0/' || v.policyVersion !== '2026-10-07-cc0-only-v1' || typeof v.descriptionUrl !== 'string' || v.descriptionUrl.length > 2048) return false;
  try { const u = new URL(v.descriptionUrl); return u.protocol === 'https:' && u.hostname === 'commons.wikimedia.org' && !u.username && !u.password && !u.port && !u.search && !u.hash && /^\/wiki\/File(?::|%3A)/iu.test(u.pathname); } catch { return false; }
}
export function isCoverArtArchiveSource(v:unknown):v is CoverArtArchiveSource {
  return isLocalArtworkRecord(v,['releaseId','imageId','releaseTitle','artist','releaseDate','country','releaseUrl','front','approved','musicBrainzMetadataLicense','imageRights','imageVariant','policyVersion'])
    && typeof v.releaseId==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(v.releaseId) && typeof v.imageId==='string' && /^\d{1,20}$/u.test(v.imageId) && isLocalCatalogText(v.releaseTitle) && isLocalCatalogText(v.artist,true)
    && (v.releaseDate===null || typeof v.releaseDate==='string' && /^\d{4}(?:-\d\d(?:-\d\d)?)?$/u.test(v.releaseDate))
    && (v.country===null || typeof v.country==='string' && /^[A-Z]{2}$/u.test(v.country)) && v.releaseUrl===`https://musicbrainz.org/release/${v.releaseId}`
    && typeof v.front==='boolean' && typeof v.approved==='boolean' && v.musicBrainzMetadataLicense==='CC0-core' && v.imageRights==='unverified' && v.imageVariant==='original' && v.policyVersion==='2026-10-07-caa-personal-v1';
}
export function isLocalArtworkRemoteSource(v:unknown):v is LocalArtworkRemoteSource { return isCommonsArtworkSource(v) || isCoverArtArchiveSource(v); }
export function isLocalArtworkSearchRequest(v:unknown):v is SearchLocalArtworkCandidates {
  return (isLocalArtworkRecord(v,['target','query']) || isLocalArtworkRecord(v,['target','query','provider'])) && isLocalArtworkTarget(v.target) && isLocalArtworkQuery(v.query)
    && (!Object.hasOwn(v,'provider') || v.provider==='commons-cc0-v1' || v.provider==='cover-art-archive-v1');
}
export function isLocalArtworkTarget(v: unknown): v is LocalArtworkTarget {
  return isLocalArtworkRecord(v, ['trackId', 'editionId', 'expectedEditionRevision', 'expectedTrackRevision', 'expectedSourceRevision'])
    && isCollectionId(v.trackId) && isCollectionId(v.editionId) && isLocalCatalogRevision(v.expectedEditionRevision) && isLocalCatalogRevision(v.expectedTrackRevision) && typeof v.expectedSourceRevision === 'string' && /^[a-f0-9]{64}$/u.test(v.expectedSourceRevision);
}
function info(v: unknown, display = false): v is LocalArtworkImageInfo {
  return isLocalArtworkRecord(v, display ? ['mime', 'bytes', 'sha256', 'width', 'height', 'dataUrl'] : ['mime', 'bytes', 'sha256', 'width', 'height'])
    && (display ? v.mime === 'image/jpeg' : v.mime === 'image/png' || v.mime === 'image/jpeg')
    && int(v.bytes, display ? LOCAL_ARTWORK_DISPLAY_BYTES : LOCAL_ARTWORK_INPUT_BYTES)
    && typeof v.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(v.sha256) && int(v.width, display ? 1200 : 4096) && int(v.height, display ? 1200 : 4096)
    && v.width * v.height <= 16 * 1024 * 1024
    && (!display || typeof v.dataUrl === 'string' && v.dataUrl.length <= 23 + 4 * Math.ceil(LOCAL_ARTWORK_DISPLAY_BYTES / 3)
      && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/u.test(v.dataUrl) && v.dataUrl.length - 23 === 4 * Math.ceil(v.bytes / 3));
}
export function isLocalArtworkImage(v: unknown): v is LocalArtworkImage {
  return isLocalArtworkRecord(v, ['original', 'display']) && info(v.original) && info(v.display, true);
}
export function isLocalArtworkCandidate(v: unknown): v is LocalArtworkCandidate {
  return (isLocalArtworkRecord(v, ['id', 'editionId', 'origin', 'sourceIdentity', 'sourceLabel', 'provider', 'license', 'expiresAt', 'original', 'display']) || isLocalArtworkRecord(v, ['id', 'editionId', 'origin', 'sourceIdentity', 'sourceLabel', 'provider', 'license', 'expiresAt', 'original', 'display','remoteSource']))
    && isCollectionId(v.id) && isCollectionId(v.editionId) && ['local-independent', 'embedded', 'manual','provider'].includes(v.origin as string)
    && typeof v.sourceIdentity === 'string' && /^[a-f0-9]{64}$/u.test(v.sourceIdentity) && isLocalCatalogText(v.sourceLabel)
    && (v.origin === 'provider' ? (v.provider === 'commons-cc0-v1' && v.license === 'CC0-1.0' && isCommonsArtworkSource(v.remoteSource) || v.provider==='cover-art-archive-v1' && v.license==='rights-unverified' && isCoverArtArchiveSource(v.remoteSource)) : v.provider === 'local-readonly-v1' && v.license === 'user-supplied' && !Object.hasOwn(v,'remoteSource')) && typeof v.expiresAt === 'string'
    && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(v.expiresAt) && Number.isFinite(Date.parse(v.expiresAt))
    && info(v.original) && info(v.display, true);
}
export function isLocalArtworkSelection(v: unknown): v is LocalArtworkSelection {
  return isLocalArtworkRecord(v, ['id', 'editionId', 'revision', 'mode', 'candidate']) && isCollectionId(v.id) && isCollectionId(v.editionId)
    && isLocalCatalogRevision(v.revision) && (v.mode === 'manual' || v.mode === 'local-default')
    && (v.candidate === null || isLocalArtworkCandidate(v.candidate) && v.candidate.editionId === v.editionId);
}
export function isLocalArtworkContext(v: unknown): v is LocalArtworkContext {
  return isLocalArtworkRecord(v, ['trackId', 'trackRevision', 'target', 'editions', 'selection', 'candidates', 'remoteProvider', 'sourceFilesWrite', 'status'])
    && isCollectionId(v.trackId) && isLocalCatalogRevision(v.trackRevision) && denseArray(v.editions,200) && v.editions.every(isAlbumEdition)
    && (v.target === null || isLocalArtworkTarget(v.target) && v.target.trackId === v.trackId && v.target.expectedTrackRevision === v.trackRevision
      && v.editions.some(e => e.id === (v.target as LocalArtworkTarget).editionId && e.revision === (v.target as LocalArtworkTarget).expectedEditionRevision))
    && (v.selection === null || isLocalArtworkSelection(v.selection) && v.target !== null && v.selection.editionId === (v.target as LocalArtworkTarget).editionId)
    && denseArray(v.candidates,LOCAL_ARTWORK_MAX_CANDIDATES) && v.candidates.every(c => isLocalArtworkCandidate(c) && v.target !== null && c.editionId === (v.target as LocalArtworkTarget).editionId)
    && new Set(v.candidates.map(c => (c as LocalArtworkCandidate).id)).size === v.candidates.length && ['off-pending-license','commons-cc0-v1','cover-art-archive-v1','music-and-commons-v1'].includes(v.remoteProvider as string) && v.sourceFilesWrite === 'OFF'
    && ['ready', 'missing', 'source-unavailable'].includes(v.status as string);
}
export function isApplyLocalArtworkSelection(v: unknown): v is ApplyLocalArtworkSelection {
  return isLocalArtworkRecord(v, ['commandId', 'target', 'candidateId', 'expectedSelectionRevision']) && isCollectionId(v.commandId)
    && isLocalArtworkTarget(v.target) && (v.candidateId === null || isCollectionId(v.candidateId))
    && (v.expectedSelectionRevision === null || isLocalCatalogRevision(v.expectedSelectionRevision));
}
export function isCreateLocalArtworkEdition(v: unknown): v is CreateLocalArtworkEdition {
  return isLocalArtworkRecord(v, ['commandId', 'trackId', 'expectedTrackRevision', 'title']) && isCollectionId(v.commandId)
    && isCollectionId(v.trackId) && isLocalCatalogRevision(v.expectedTrackRevision) && isLocalCatalogText(v.title);
}

export interface LocalArtworkCommandPayloads {
  'localArtwork.context': { trackId: string; editionId: string | null };
  'localArtwork.apply': ApplyLocalArtworkSelection;
  'localArtwork.createEdition': CreateLocalArtworkEdition;
  /** 只有可信 Main 已完整解码的副本可进入 owner，公开通道没有此命令。 */
  'localArtwork.stage': { target: LocalArtworkTarget; origin: LocalArtworkOrigin; sourceIdentity: string; sourceLabel: string; image: LocalArtworkImage; remoteSource?: LocalArtworkRemoteSource };
  'localArtwork.readCandidates': { target: LocalArtworkTarget; lookupId: string };
  'localArtwork.cancelLookup': { lookupId: string };
}
export interface LocalArtworkSourceCopies { status: 'ready' | 'source-unavailable'; items: Array<{ origin: 'local-independent' | 'embedded'; sourceIdentity: string; sourceLabel: string; base64: string }> }
export interface LocalArtworkCommandResults {
  'localArtwork.context': LocalArtworkContext;
  'localArtwork.apply': LocalArtworkSelection;
  'localArtwork.createEdition': AlbumEdition;
  'localArtwork.stage': LocalArtworkContext;
  'localArtwork.readCandidates': LocalArtworkSourceCopies;
  'localArtwork.cancelLookup': { cancelled: boolean };
}
export const LOCAL_ARTWORK_COMMANDS = ['localArtwork.context', 'localArtwork.apply', 'localArtwork.createEdition', 'localArtwork.stage', 'localArtwork.readCandidates', 'localArtwork.cancelLookup'] as const;
export type LocalArtworkCommand = typeof LOCAL_ARTWORK_COMMANDS[number];
export function isLocalArtworkCommand(v: unknown): v is LocalArtworkCommand { return LOCAL_ARTWORK_COMMANDS.includes(v as LocalArtworkCommand); }
export type LocalArtworkInternalCommand = 'localArtwork.stage' | 'localArtwork.readCandidates' | 'localArtwork.cancelLookup';
export function isLocalArtworkInternalCommand(v: unknown): v is LocalArtworkInternalCommand { return v === 'localArtwork.stage' || v === 'localArtwork.readCandidates' || v === 'localArtwork.cancelLookup'; }
export function isLocalArtworkCommandPayload(c: LocalArtworkCommand, v: unknown): boolean {
  switch (c) {
    case 'localArtwork.context': return isLocalArtworkRecord(v, ['trackId', 'editionId']) && isCollectionId(v.trackId) && (v.editionId === null || isCollectionId(v.editionId));
    case 'localArtwork.apply': return isApplyLocalArtworkSelection(v);
    case 'localArtwork.createEdition': return isCreateLocalArtworkEdition(v);
    case 'localArtwork.readCandidates': return isLocalArtworkRecord(v, ['target', 'lookupId']) && isLocalArtworkTarget(v.target) && isCollectionId(v.lookupId);
    case 'localArtwork.cancelLookup': return isLocalArtworkRecord(v, ['lookupId']) && isCollectionId(v.lookupId);
    case 'localArtwork.stage': return (isLocalArtworkRecord(v, ['target', 'origin', 'sourceIdentity', 'sourceLabel', 'image']) || isLocalArtworkRecord(v, ['target', 'origin', 'sourceIdentity', 'sourceLabel', 'image','remoteSource'])) && isLocalArtworkTarget(v.target)
      && ['local-independent', 'embedded', 'manual','provider'].includes(v.origin as string) && (v.origin === 'provider' ? isLocalArtworkRemoteSource(v.remoteSource) : !Object.hasOwn(v,'remoteSource')) && typeof v.sourceIdentity === 'string' && /^[a-f0-9]{64}$/u.test(v.sourceIdentity)
      && isLocalCatalogText(v.sourceLabel) && isLocalArtworkImage(v.image);
  }
}
export function isLocalArtworkCommandResult(c: LocalArtworkCommand, v: unknown): boolean {
  switch (c) {
    case 'localArtwork.context': case 'localArtwork.stage': return isLocalArtworkContext(v);
    case 'localArtwork.apply': return isLocalArtworkSelection(v);
    case 'localArtwork.createEdition': return isAlbumEdition(v);
    case 'localArtwork.cancelLookup': return isLocalArtworkRecord(v, ['cancelled']) && typeof v.cancelled === 'boolean';
    case 'localArtwork.readCandidates': return isLocalArtworkRecord(v, ['status', 'items']) && (v.status === 'ready' || v.status === 'source-unavailable') && denseArray(v.items,4)
      && v.items.every(item => isLocalArtworkRecord(item, ['origin', 'sourceIdentity', 'sourceLabel', 'base64'])
        && (item.origin === 'local-independent' || item.origin === 'embedded') && typeof item.sourceIdentity === 'string' && /^[a-f0-9]{64}$/u.test(item.sourceIdentity)
        && isLocalCatalogText(item.sourceLabel) && typeof item.base64 === 'string' && item.base64.length <= 4 * Math.ceil(LOCAL_ARTWORK_INPUT_BYTES / 3) && /^[A-Za-z0-9+/]+={0,2}$/u.test(item.base64))
      && v.items.reduce<number>((n, item) => n + (item as { base64: string }).base64.length, 0) <= 4 * Math.ceil(8 * 1024 * 1024 / 3);
  }
}
