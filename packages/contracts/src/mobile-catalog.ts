import type { LocalLibraryTrackDetail } from './local-catalog.js';
import { MOBILE_CODEC_LIMITS, MOBILE_COMMON_SCHEMAS, MOBILE_ID_SCHEMA, isMobileId, isMobileSource, mobileCanonicalJson, mobileDataSnapshot, mobileFailure, mobileInteger, mobileOk, mobileRecord, mobileSchemaSnapshot, mapMobileFileAudioParameters } from './mobile-common.js';
import type { MobileAudioInfo, MobileCodecLimits, MobileDecodeResult, MobileId, MobileRevision, MobileSchemaRegistry, MobileSource } from './mobile-common.js';

export interface MobileAlbum { id: MobileId; title: string; artists: string[]; source: MobileSource; editionLabel: string; trackCount: number; artworkId?: MobileId }
export interface MobileTrack { id: MobileId; title: string; artists: string[]; albumId: MobileId; source: MobileSource; sourceItemId: MobileId; versionId: MobileId; contentRevision: MobileRevision; editionLabel: string; durationMs: number; audio: MobileAudioInfo; availability: 'available' | 'missing' | 'unavailable'; artworkId?: MobileId }
export interface MobileAlbumPage { items: MobileAlbum[]; nextCursor: string | null; libraryRevision: string }
export interface MobileTrackPage { items: MobileTrack[]; nextCursor: string | null; libraryRevision: string }
export interface MobileSearchQuery { limit?: number; cursor?: string; q?: string; source?: 'all' | MobileSource; albumId?: MobileId }
export interface MobileArtworkQuery { size?: '96' | '256' | '512' }
export interface MobileTrackSelection { trackId: MobileId; source: MobileSource; versionId: MobileId; contentRevision: MobileRevision }
export interface MobileCatalogRequestMap { search: MobileSearchQuery; artwork: MobileArtworkQuery; detail: {id:MobileId} }
export interface MobileCatalogResponseMap { album: MobileAlbum; track: MobileTrack; albumPage: MobileAlbumPage; trackPage: MobileTrackPage }
export const MOBILE_CATALOG_SCHEMAS: MobileSchemaRegistry = {
  ...MOBILE_COMMON_SCHEMAS,
  Album:{type:'object',required:['id','title','artists','source','editionLabel','trackCount'],additionalProperties:true,properties:{id:MOBILE_ID_SCHEMA,title:{type:'string'},artists:{type:'array',items:{type:'string'}},source:{enum:['local','netease']},editionLabel:{type:'string'},artworkId:MOBILE_ID_SCHEMA,trackCount:{type:'integer',minimum:0}}},
  Track:{type:'object',required:['id','title','artists','albumId','source','sourceItemId','versionId','contentRevision','editionLabel','durationMs','audio','availability'],additionalProperties:true,properties:{id:MOBILE_ID_SCHEMA,title:{type:'string'},artists:{type:'array',items:{type:'string'}},albumId:MOBILE_ID_SCHEMA,source:{enum:['local','netease']},sourceItemId:MOBILE_ID_SCHEMA,versionId:MOBILE_ID_SCHEMA,contentRevision:MOBILE_ID_SCHEMA,editionLabel:{type:'string'},durationMs:{type:'integer',minimum:0},artworkId:MOBILE_ID_SCHEMA,audio:{$ref:'#/components/schemas/AudioInfo'},availability:{enum:['available','missing','unavailable']}}},
  AlbumPage:{type:'object',required:['items','nextCursor','libraryRevision'],additionalProperties:true,properties:{items:{type:'array',items:{$ref:'#/components/schemas/Album'}},nextCursor:{type:['string','null']},libraryRevision:{type:'string'}}},
  TrackPage:{type:'object',required:['items','nextCursor','libraryRevision'],additionalProperties:true,properties:{items:{type:'array',items:{$ref:'#/components/schemas/Track'}},nextCursor:{type:['string','null']},libraryRevision:{type:'string'}}},
  MobileSearchQuery:{type:'object',additionalProperties:false,properties:{limit:{type:'integer',minimum:1,maximum:100},cursor:{type:'string'},q:{type:'string',maxLength:200},source:{enum:['all','local','netease']},albumId:MOBILE_ID_SCHEMA}},
  MobileArtworkQuery:{type:'object',additionalProperties:false,properties:{size:{enum:['96','256','512']}}},
  MobileDetailQuery:{type:'object',required:['id'],additionalProperties:false,properties:{id:MOBILE_ID_SCHEMA}}
};
const requestSchemas = {search:'MobileSearchQuery',artwork:'MobileArtworkQuery',detail:'MobileDetailQuery'} as const;
const responseSchemas = {album:'Album',track:'Track',albumPage:'AlbumPage',trackPage:'TrackPage'} as const;
export function mobileCatalogRequestSnapshot<K extends keyof MobileCatalogRequestMap>(kind:K, raw:unknown, limits:MobileCodecLimits = MOBILE_CODEC_LIMITS):MobileDecodeResult<MobileCatalogRequestMap[K]> { return mobileSchemaSnapshot(MOBILE_CATALOG_SCHEMAS[requestSchemas[kind]]!,raw,MOBILE_CATALOG_SCHEMAS,limits,'request'); }
export function mobileCatalogResponseSnapshot<K extends keyof MobileCatalogResponseMap>(kind:K, raw:unknown, limits:MobileCodecLimits = MOBILE_CODEC_LIMITS):MobileDecodeResult<MobileCatalogResponseMap[K]> { return mobileSchemaSnapshot(MOBILE_CATALOG_SCHEMAS[responseSchemas[kind]]!,raw,MOBILE_CATALOG_SCHEMAS,limits); }
export const isMobileTrack = (raw:unknown):raw is MobileTrack => mobileCatalogResponseSnapshot('track',raw).ok;
export const isMobileAlbum = (raw:unknown):raw is MobileAlbum => mobileCatalogResponseSnapshot('album',raw).ok;

/** 游标认证由 001 提供；此函数只比较已经认证的同一快照事实。 */
export interface MobileCursorFacts { serverId:MobileId; deviceId:MobileId; accountDomain:MobileId; source:'all' | MobileSource; libraryRevision:string; sort:string; filter:string; albumId:MobileId | null }
export interface MobileCatalogReadContext extends MobileCursorFacts { limit:number; previousIds:readonly string[]; previousCursors:readonly string[]; cursorFacts:MobileCursorFacts | null }
export function mobileCursorScopeMatches(facts:MobileCursorFacts, context:MobileCursorFacts):boolean {
  return isMobileId(facts.serverId) && isMobileId(facts.deviceId) && isMobileId(facts.accountDomain) && ['all','local','netease'].includes(facts.source)
    && ['serverId','deviceId','accountDomain','source','libraryRevision','sort','filter','albumId'].every(key => facts[key as keyof MobileCursorFacts] === context[key as keyof MobileCursorFacts]);
}
export function validateMobileCatalogPage<T extends MobileAlbumPage | MobileTrackPage>(page:T, context:MobileCatalogReadContext):MobileDecodeResult<T> {
  const snapshot = mobileDataSnapshot(page); if (!snapshot.ok || !mobileRecord(snapshot.value) || !Array.isArray(snapshot.value.items)) return mobileFailure('INVALID_RESPONSE','page');
  const kind = snapshot.value.items.some(item => mobileRecord(item) && Object.hasOwn(item,'versionId')) ? 'trackPage' : 'albumPage';
  const captured = mobileCatalogResponseSnapshot(kind,snapshot.value); if (!captured.ok) return captured; page = captured.value as T;
  if (!mobileInteger(context.limit,1,100) || page.libraryRevision !== context.libraryRevision || context.cursorFacts !== null && !mobileCursorScopeMatches(context.cursorFacts,context)) return mobileFailure('SOURCE_CHANGED','page');
  if (page.items.length > context.limit || page.nextCursor !== null && (!page.nextCursor || context.previousCursors.includes(page.nextCursor) || page.items.length === 0)) return mobileFailure('CONTEXT_MISMATCH','cursor');
  const ids = page.items.map(item => `${item.source}:${item.id}`);
  if (new Set(ids).size !== ids.length || ids.some(id => context.previousIds.includes(id)) || page.items.some(item => context.source !== 'all' && item.source !== context.source || context.albumId !== null && 'albumId' in item && item.albumId !== context.albumId)) return mobileFailure('CONTEXT_MISMATCH','items');
  return mobileOk(captured.value as T);
}

/** 稳定映射来自同一 Owner 注册；位置／根修订不用于重造内容身份。 */
export interface MobileCatalogIdentityBinding {
  localTrackId:string; assetId:string; fileRevision:string; selectionRevision:string; segmentId:string | null;
  editionId:string; editionRevision:string; trackId:MobileId; sourceItemId:MobileId; albumId:MobileId; versionId:MobileId; contentRevision:MobileRevision;
}
export interface MobileCatalogProjection { title:string; artists:string[]; editionLabel:string; availability:MobileTrack['availability']; artworkId?:MobileId }
export type MobileAlbumProjection = MobileAlbum;
export function mapLocalDetailToMobileTrack(raw:LocalLibraryTrackDetail, binding:MobileCatalogIdentityBinding, projection:MobileCatalogProjection):MobileDecodeResult<MobileTrack> {
  const captured = mobileDataSnapshot(raw); if (!captured.ok || !mobileRecord(captured.value)) return mobileFailure('INVALID_RESPONSE','detail');
  const detail = captured.value as unknown as LocalLibraryTrackDetail;
  if (!detail.track || !detail.asset || !Array.isArray(detail.editions) || !detail.fileParameters || detail.fileParameters.durationMs === null
    || detail.track.id !== binding.localTrackId || detail.asset.id !== binding.assetId || detail.track.assetId !== binding.assetId || detail.asset.fileRevision !== binding.fileRevision
    || detail.track.selectionRevision !== binding.selectionRevision || (detail.track.segment?.id ?? null) !== binding.segmentId
    || !detail.editions.some(e => e.id === binding.editionId && e.revision === binding.editionRevision)
    || ![binding.trackId,binding.sourceItemId,binding.albumId,binding.versionId,binding.contentRevision].every(isMobileId)) return mobileFailure('CONTEXT_MISMATCH','mapping');
  const audio = mapMobileFileAudioParameters(detail.fileParameters); if (!audio.ok) return audio;
  const projected = mobileDataSnapshot(projection); if (!projected.ok || !mobileRecord(projected.value)) return mobileFailure('INVALID_RESPONSE','projection');
  const p = projected.value as unknown as MobileCatalogProjection;
  return mobileCatalogResponseSnapshot('track',{id:binding.trackId,title:p.title,artists:p.artists,albumId:binding.albumId,source:'local',sourceItemId:binding.sourceItemId,versionId:binding.versionId,contentRevision:binding.contentRevision,editionLabel:p.editionLabel,durationMs:detail.fileParameters.durationMs,audio:audio.value,availability:p.availability,...(p.artworkId === undefined ? {} : {artworkId:p.artworkId})});
}
export function mapMobileAlbum(projection:MobileAlbumProjection):MobileDecodeResult<MobileAlbum> {
  const result = mobileCatalogResponseSnapshot('album',projection); if (!result.ok) return result;
  const a = result.value;
  return mobileOk({id:a.id,title:a.title,artists:a.artists,source:a.source,editionLabel:a.editionLabel,trackCount:a.trackCount,...(a.artworkId === undefined ? {} : {artworkId:a.artworkId})});
}
export function mobileTrackSelectionEquals(a:MobileTrackSelection,b:MobileTrackSelection):boolean {
  return isMobileSource(a.source) && [a.trackId,a.versionId,a.contentRevision].every(isMobileId) && a.trackId === b.trackId && a.source === b.source && a.versionId === b.versionId && a.contentRevision === b.contentRevision;
}
export function mobileTrackIdentity(track:MobileTrack):string { return mobileCanonicalJson({source:track.source,trackId:track.id,versionId:track.versionId,contentRevision:track.contentRevision}); }
