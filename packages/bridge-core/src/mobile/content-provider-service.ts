import { createHash } from 'node:crypto';
import {
  MOBILE_COMMON_SCHEMAS, MOBILE_CONTENT_SCHEMAS, MOBILE_CONTENT_RESPONSE_NAMES, MOBILE_OPERATION_TABLE,
  mobileCanonicalJson, mobileDataSnapshot, mobileInteger, mobileProjectSchema, mobileRecord, mobileSchemaSnapshot,
  validateMobileContentIdentity,
} from '@music-bridge/contracts';
import type { MobileContentReadContext, MobileContentResponseMap, MobileJsonValue } from '@music-bridge/contracts';
import { createMobileContentCursorCodec } from './content-cursor.js';
import { captureMobileContentReply } from './content-protocol.js';
import type { MobileContentOperation, MobileContentPageScope, MobileContentPort, MobileContentServiceInput, MobileContentSnapshot } from './content-types.js';
import { assertMobileNeteaseAccount, captureMobileNeteaseScope, mobileNeteaseId } from './netease-source-types.js';
import type { MobileNeteaseAccount, MobileNeteaseScope } from './netease-source-types.js';
import { MobileServiceError } from './types.js';

export const MOBILE_NETEASE_CONTENT_OPERATIONS = ['getNeteaseDailyRecommendations','getNeteaseLikedPlaylist','listNeteaseLikedPlaylistTracks',
  'listNeteaseRecommendedPlaylists','listNeteaseNewAlbums','listNeteaseCharts','getNeteaseDiscoveryCollectionTracks','getNeteasePersonalFM'] as const;
export type MobileNeteaseContentOperation = typeof MOBILE_NETEASE_CONTENT_OPERATIONS[number];
export interface MobileNeteaseContentProviderRequest {
  operation: MobileNeteaseContentOperation; scope: MobileNeteaseScope;
  request: MobileContentServiceInput<MobileNeteaseContentOperation>['request'];
  offset: number; limit: number; expectedRevision: string | null; signal: AbortSignal;
}
export interface MobileNeteaseContentProviderFacts {
  account: MobileNeteaseAccount;
  /** 完整 DTO 捕获后才可使用；上游 continuation 不进入公开字段。 */
  body: unknown; context: MobileContentReadContext; nextOffset: number | null;
}
export interface MobileNeteaseContentProviderPort { read(input: MobileNeteaseContentProviderRequest): Promise<MobileNeteaseContentProviderFacts> }
const names = {getNeteaseDailyRecommendations:'dailyRecommendationFeed',getNeteaseLikedPlaylist:'neteaseLikedPlaylist',
  listNeteaseLikedPlaylistTracks:'neteaseLikedPlaylistTrackPage',listNeteaseRecommendedPlaylists:'discoveryCollectionPage',
  listNeteaseNewAlbums:'discoveryAlbumPage',listNeteaseCharts:'discoveryCollectionPage',getNeteaseDiscoveryCollectionTracks:'discoveryCollectionTrackPage',getNeteasePersonalFM:'discoveryFMFeed'} as const;
const pages = new Set<MobileNeteaseContentOperation>(['listNeteaseLikedPlaylistTracks','listNeteaseRecommendedPlaylists','listNeteaseNewAlbums','listNeteaseCharts','getNeteaseDiscoveryCollectionTracks']);
const contextKeys = ['serverId','deviceId','accountDomain','source','revision','limit','pageOffset','albumId','playlistId','collectionId','kind','collection','previousIdentities','previousCursors','cursorFacts','sort','trackAlbums','playlistFirstTracks','selection'];
const fail = (code:'BUSY'|'SOURCE_CHANGED'|'INVALID_REQUEST'|'UNSUPPORTED_FORMAT'):never=>{throw new MobileServiceError(code==='BUSY'?503:code==='INVALID_REQUEST'?400:409,code);};
function freeze<T>(value:T):T {if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
/** 无安装真实 adapter 的副作用；能力由后续可信组合根单独声明。 */
export function createMobileContentProviderService(options:{provider:MobileNeteaseContentProviderPort;cursorKey:Uint8Array;now?:()=>number;assertCurrent(scope:MobileNeteaseScope):Promise<void>}):MobileContentPort&{close():void}{
  const cursor=createMobileContentCursorCodec({key:options.cursorKey,...(options.now?{now:options.now}:{})});
  let closed=false;
  async function current(scope:MobileNeteaseScope,signal:AbortSignal){if(closed)return fail('BUSY');signal.throwIfAborted();await options.assertCurrent(scope);signal.throwIfAborted();if(closed)return fail('BUSY');}
  return{async dispatch<O extends MobileContentOperation>(input:MobileContentServiceInput<O>):Promise<MobileContentSnapshot<O>>{
    if(closed)return fail('BUSY');
    if(!(MOBILE_NETEASE_CONTENT_OPERATIONS as readonly string[]).includes(input.operation))return fail('UNSUPPORTED_FORMAT');
    const operation=input.operation as MobileNeteaseContentOperation,scope=captureMobileNeteaseScope(input.scope),signal=input.signal;
    const captured=mobileDataSnapshot(input.request,undefined,'request');
    if(!captured.ok||!mobileRecord(captured.value))return fail('INVALID_REQUEST');
    const requestValue=captured.value;
    if(Reflect.ownKeys(requestValue).length!==4||!['path','pathParameters','query','body'].every(k=>Object.hasOwn(requestValue,k)))return fail('INVALID_REQUEST');
    const request=requestValue as unknown as MobileNeteaseContentProviderRequest['request'];
    const table=MOBILE_OPERATION_TABLE[operation];
    const queryResult=mobileSchemaSnapshot(table.querySchema,request.query,MOBILE_COMMON_SCHEMAS,undefined,'request');
    if(!queryResult.ok||request.body!==null||!mobileRecord(request.pathParameters))return fail('INVALID_REQUEST');
    const paramKeys=Reflect.ownKeys(request.pathParameters);
    if(operation==='getNeteaseDiscoveryCollectionTracks'?
      paramKeys.length!==1||!mobileNeteaseId(request.pathParameters.collectionId)||request.path!==table.path.replace('{collectionId}',encodeURIComponent(request.pathParameters.collectionId)):
      paramKeys.length!==0||request.path!==table.path)return fail('INVALID_REQUEST');
    const q=request.query,limit=q.limit===undefined?20:q.limit;
    if(!mobileInteger(limit,1,100))return fail('INVALID_REQUEST');
    const parentId=operation==='listNeteaseLikedPlaylistTracks'?q.playlistId as string:operation==='getNeteaseDiscoveryCollectionTracks'?request.pathParameters.collectionId!:null;
    const kind=operation==='getNeteaseDiscoveryCollectionTracks'?q.kind as 'playlist'|'chart':null;
    const filter={...q};delete filter.cursor;
    const pageQuery:MobileContentPageScope={scope,operation,source:'netease',parentId,kind,filterHash:createHash('sha256').update(mobileCanonicalJson(filter)).digest('hex'),sort:'provider-order',limit};
    const claim=typeof q.cursor==='string'?cursor.open(q.cursor,pageQuery):null;
    const offset=claim?.offset??0,expectedRevision=claim?.revision??(typeof q.playlistRevision==='string'?q.playlistRevision:typeof q.collectionRevision==='string'?q.collectionRevision:null);
    if(typeof q.accountDomain==='string'&&q.accountDomain!==scope.accountDomain)return fail('SOURCE_CHANGED');
    await current(scope,signal);let raw:MobileNeteaseContentProviderFacts;
    try{raw=await options.provider.read({operation,scope,request:freeze(request),offset,limit,expectedRevision,signal});}
    catch(e){signal.throwIfAborted();if(e instanceof MobileServiceError)throw e;return fail('BUSY');}
    await current(scope,signal);
    const snapshot=mobileDataSnapshot(raw);
    if(!snapshot.ok||!mobileRecord(snapshot.value))return fail('BUSY');
    const value=snapshot.value;
    if(Reflect.ownKeys(value).length!==4||!['account','body','context','nextOffset'].every(k=>Object.hasOwn(value,k)))return fail('BUSY');
    assertMobileNeteaseAccount(scope,value.account);
    if(!mobileRecord(value.context)||!Reflect.ownKeys(value.context).every(k=>typeof k==='string'&&contextKeys.includes(k)))return fail('BUSY');
    const context=value.context as unknown as MobileContentReadContext;
    if(context.serverId!==scope.serverId||context.deviceId!==scope.deviceId||context.accountDomain!==scope.accountDomain||context.source!=='netease'
      ||!mobileNeteaseId(context.revision)||expectedRevision!==null&&context.revision!==expectedRevision)return fail('SOURCE_CHANGED');
    if(pages.has(operation)&&(context.limit!==limit||context.pageOffset!==offset)
      ||operation==='listNeteaseLikedPlaylistTracks'&&context.playlistId!==parentId
      ||operation==='getNeteaseDiscoveryCollectionTracks'&&(context.collectionId!==parentId||context.kind!==kind))return fail('SOURCE_CHANGED');
    const body=value.body;
    if(!mobileRecord(body)||pages.has(operation)&&body.nextCursor!==null
      ||value.nextOffset!==null&&(!pages.has(operation)||!mobileInteger(value.nextOffset,offset+1)||!Array.isArray(body.items)||body.items.length===0||value.nextOffset!==offset+body.items.length))return fail('BUSY');
    const name=names[operation];
    const nextCursor=pages.has(operation)&&value.nextOffset!==null?cursor.issue({query:pageQuery,revision:context.revision,offset:value.nextOffset as number}):null;
    const projected=mobileProjectSchema(MOBILE_CONTENT_SCHEMAS[MOBILE_CONTENT_RESPONSE_NAMES[name]]!,
      pages.has(operation)?{...body,nextCursor}:body,MOBILE_CONTENT_SCHEMAS);
    const valid=validateMobileContentIdentity(name,projected as MobileContentResponseMap[typeof name],context);
    if(!valid.ok)return fail(valid.issue.code==='SOURCE_CHANGED'||valid.issue.code==='CONTEXT_MISMATCH'?'SOURCE_CHANGED':'BUSY');
    const publicBody=valid.value as unknown as Record<string,MobileJsonValue>;
    // 上下文携带本域游标证明，而非上游任意 continuation。
    const outgoing:MobileContentReadContext={...context,...(pages.has(operation)?{sort:'provider-order',cursorFacts:{serverId:scope.serverId,deviceId:scope.deviceId,accountDomain:scope.accountDomain,revision:context.revision,sort:'provider-order',parentId,source:'netease'}}:{})};
    const checked=captureMobileContentReply(operation,request,scope,{status:200,category:'success',body:publicBody},outgoing);
    const result={operation:input.operation,scope,reply:checked.reply,context:checked.context,
      async beforeSend(){await current(scope,signal);}};
    return result as unknown as MobileContentSnapshot<O>;
  },close(){closed=true;cursor.close();}};
}
