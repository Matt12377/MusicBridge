import { mobileCatalogResponseSnapshot, mobileContentResponseSnapshot, mobileDataSnapshot, mobileInteger, mobileRecord, mobileTrackSelectionEquals, mobileUtf8Bytes } from '@music-bridge/contracts';
import type { MobileAudioInfo, MobileTrack, MobileTrackSelection, MobileUIAlbumRecord } from '@music-bridge/contracts';
import { assertMobileNeteaseAccount, captureMobileNeteaseScope, mobileNeteaseId } from './netease-source-types.js';
import type { MobileNeteaseCatalogPort, MobileNeteaseCatalogResolver, MobileNeteaseScope } from './netease-source-types.js';
import { MobileServiceError } from './types.js';

const fail = (code: 'BUSY' | 'SOURCE_CHANGED' | 'INVALID_REQUEST'): never => { throw new MobileServiceError(code==='BUSY'?503:code==='INVALID_REQUEST'?400:409,code); };
const trackKeys=['id','title','artists','albumId','source','sourceItemId','versionId','contentRevision','editionLabel','durationMs','audio','availability','artworkId'];
const albumKeys=['id','title','artists','source','editionLabel','trackCount','artworkId','year','audioFormat','addedAt'];
function known(value: Record<string,unknown>, names: readonly string[]): boolean {return Reflect.ownKeys(value).every(k=>typeof k==='string'&&names.includes(k));}
function text(value:unknown,empty=false):boolean{return typeof value==='string'&&(empty||value.trim().length>0)&&mobileUtf8Bytes(value)<=1024&&!/[\u0000-\u001f\u007f-\u009f]/u.test(value);}
function metadata(value:Record<string,unknown>):boolean{return text(value.title)&&text(value.editionLabel,true)&&Array.isArray(value.artists)&&value.artists.length<=32&&value.artists.every(v=>text(v));}
function audio(raw:MobileAudioInfo):boolean {
  if(!known(raw as unknown as Record<string,unknown>,['codec','container','sampleRateHz','bitsPerSample','channels','bitrateKbps']))return false;
  return mobileInteger(raw.sampleRateHz,8000,768000)&&mobileInteger(raw.channels,1,32)
    &&(raw.codec!=='flac'||raw.container==='flac'&&mobileInteger(raw.bitsPerSample,4,32));
}
function frozen<T>(v:T):Readonly<T>{if(v&&typeof v==='object'){for(const child of Object.values(v))frozen(child);Object.freeze(v);}return v;}
export function captureMobileNeteaseSelection(raw:unknown):Readonly<MobileTrackSelection>{
  const c=mobileDataSnapshot(raw);if(!c.ok||!mobileRecord(c.value))return fail('INVALID_REQUEST');const value=c.value;
  if(Reflect.ownKeys(value).length!==4||value.source!=='netease'
    ||!['trackId','versionId','contentRevision'].every(k=>mobileNeteaseId(value[k])))return fail('INVALID_REQUEST');
  return frozen(value as unknown as MobileTrackSelection);
}
/** 精确 metadata 端口的有限投影；无真实 backend 资格时不把目录信息升成可播。 */
export function createMobileNeteaseCatalogService(options:{port:MobileNeteaseCatalogPort;assertCurrent(scope:MobileNeteaseScope):Promise<void>;playbackQualified?:()=>boolean}):MobileNeteaseCatalogResolver{
  async function current(scope:MobileNeteaseScope,signal:AbortSignal){signal.throwIfAborted();await options.assertCurrent(scope);signal.throwIfAborted();}
  async function read(scope:MobileNeteaseScope,signal:AbortSignal,run:()=>Promise<unknown>){await current(scope,signal);let raw:unknown;
    try{raw=await run();}catch(e){if(e instanceof MobileServiceError)throw e;signal.throwIfAborted();return fail('BUSY');}
    await current(scope,signal);const c=mobileDataSnapshot(raw);if(!c.ok||!mobileRecord(c.value))return fail('BUSY');return c.value;
  }
  return{
    async resolveTrack(rawScope,rawSelection,signal){const scope=captureMobileNeteaseScope(rawScope),selection=captureMobileNeteaseSelection(rawSelection);
      const value=await read(scope,signal,()=>options.port.track(scope,selection,signal));
      if(Reflect.ownKeys(value).length!==2||!Object.hasOwn(value,'track')||!Object.hasOwn(value,'account'))return fail('BUSY');
      assertMobileNeteaseAccount(scope,value.account);const result=mobileCatalogResponseSnapshot('track',value.track);
      if(!result.ok||!known(result.value as unknown as Record<string,unknown>,trackKeys)||!metadata(result.value as unknown as Record<string,unknown>))return fail('BUSY');
      const t=result.value;
      if(t.source!=='netease'||!mobileTrackSelectionEquals(selection,{trackId:t.id,source:t.source,versionId:t.versionId,contentRevision:t.contentRevision}))return fail('SOURCE_CHANGED');
      if(![t.id,t.albumId,t.sourceItemId,t.versionId,t.contentRevision].every(mobileNeteaseId)||t.artworkId!==undefined&&!mobileNeteaseId(t.artworkId)
        ||!audio(t.audio))return fail('BUSY');
      const track:MobileTrack={...t,availability:t.availability==='available'&&options.playbackQualified?.()!==true?'unavailable':t.availability};
      return frozen(track);
    },
    async resolveAlbum(rawScope,albumId,signal){const scope=captureMobileNeteaseScope(rawScope);if(!mobileNeteaseId(albumId))return fail('INVALID_REQUEST');
      const value=await read(scope,signal,()=>options.port.album(scope,albumId,signal));
      if(Reflect.ownKeys(value).length!==2||!Object.hasOwn(value,'album')||!Object.hasOwn(value,'account'))return fail('BUSY');
      assertMobileNeteaseAccount(scope,value.account);const result=mobileContentResponseSnapshot('uiAlbum',value.album);
      if(!result.ok||!known(result.value as unknown as Record<string,unknown>,albumKeys)||!metadata(result.value as unknown as Record<string,unknown>))return fail('BUSY');
      if(result.value.source!=='netease'||result.value.id!==albumId)return fail('SOURCE_CHANGED');return frozen(result.value as MobileUIAlbumRecord);
    },
  };
}
