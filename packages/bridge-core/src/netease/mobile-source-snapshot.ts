import { createHmac } from 'node:crypto';
import { mobileDataSnapshot, mobileInteger, mobileRecord, mobileUtf8Bytes } from '@music-bridge/contracts';
import type { MobileTrackSelection } from '@music-bridge/contracts';
import { captureMobileNeteaseSelection } from '../mobile/netease-catalog-service.js';
import { captureMobileNeteaseAccount, mobileNeteaseId, MOBILE_NETEASE_DURATION_TOLERANCE_MS } from '../mobile/netease-source-types.js';
import type { MobileNeteaseAccount, MobileNeteaseObservedAudio, MobileNeteaseTrackFacts } from '../mobile/netease-source-types.js';
import { MobileServiceError } from '../mobile/types.js';

const invalid=():never=>{throw new MobileServiceError(409,'SOURCE_CHANGED');};
function providerId(value:unknown):string{
  if(typeof value==='string'&&/^[1-9][0-9]{0,31}(?![\s\S])/u.test(value))return value;
  if(mobileInteger(value,1))return String(value);return invalid();
}
function label(value:unknown):string{
  if(typeof value!=='string'||!value.trim()||mobileUtf8Bytes(value)>1024||/[\u0000-\u001f\u007f-\u009f]/u.test(value))return invalid();return value;
}
/** 当前实际 account ID 的稳定不透明映射；key 来自可信 Main，不包含凭据。 */
export function createMobileNeteaseAccountMapper(options:{serverId:string;datasetId:string;key:Uint8Array}){
  if(!mobileNeteaseId(options.serverId)||!mobileNeteaseId(options.datasetId)||!(options.key instanceof Uint8Array)
    ||options.key.byteLength!==32||!(options.key.buffer instanceof ArrayBuffer))return invalid();
  const key=Buffer.from(options.key),serverId=options.serverId,datasetId=options.datasetId;
  return{capture(rawProviderAccountId:unknown,providerEpoch:string):Readonly<MobileNeteaseAccount>{
    if(!mobileNeteaseId(providerEpoch))return invalid();const id=providerId(rawProviderAccountId);
    const accountDomain='nc:'+createHmac('sha256',key).update('MusicBridge:MBM004:NETEASE_ACCOUNT:1\0')
      .update(JSON.stringify([serverId,datasetId,id])).digest('hex');
    return Object.freeze({accountDomain,providerEpoch});
  }};
}
/** 保留真实 song_detail 的 id/name/ar/al/dt；旧 parse 的 Unknown Artist/Album 不用于手机事实。 */
export function captureMobileNeteaseSongSnapshot(rawSong:unknown,binding:{account:MobileNeteaseAccount;selection:MobileTrackSelection;
  sourceItemId:string;albumId:string;providerAlbumId:string;editionLabel:string;observed:MobileNeteaseObservedAudio;
  availability:'available'|'missing'|'unavailable';artworkId?:string}):MobileNeteaseTrackFacts{
  const c=mobileDataSnapshot({song:rawSong,binding});if(!c.ok||!mobileRecord(c.value)||!mobileRecord(c.value.song)||!mobileRecord(c.value.binding))return invalid();
  const song=c.value.song,b=c.value.binding as unknown as typeof binding,selection=captureMobileNeteaseSelection(b.selection),account=captureMobileNeteaseAccount(b.account);
  if(providerId(song.id)!==b.sourceItemId||!mobileNeteaseId(b.albumId)||!mobileNeteaseId(b.sourceItemId)
    ||!['available','missing','unavailable'].includes(b.availability)||typeof b.editionLabel!=='string'||mobileUtf8Bytes(b.editionLabel)>1024
    ||/[\u0000-\u001f\u007f-\u009f]/u.test(b.editionLabel)||b.artworkId!==undefined&&!mobileNeteaseId(b.artworkId))return invalid();
  if(!mobileRecord(song.al)||providerId(song.al.id)!==b.providerAlbumId||!Array.isArray(song.ar)||song.ar.length>32||song.ar.length===0)return invalid();
  const artists=song.ar.map(artist=>mobileRecord(artist)?label(artist.name):invalid()),title=label(song.name);
  if(!mobileRecord(b.observed)||!mobileRecord(b.observed.audio)||!mobileInteger(song.dt,1)||!mobileInteger(b.observed.size,1)
    ||!['audio/flac','audio/mpeg'].includes(b.observed.contentType)||typeof b.observed.headerSha256!=='string'
    ||!/^[a-f0-9]{64}(?![\s\S])/u.test(b.observed.headerSha256))return invalid();
  const audio=b.observed.audio;
  if(!Reflect.ownKeys(audio).every(k=>typeof k==='string'&&['codec','container','sampleRateHz','bitsPerSample','channels','bitrateKbps'].includes(k))
    ||!mobileInteger(audio.sampleRateHz,8000,768000)||!mobileInteger(audio.channels,1,32)
    ||audio.codec==='flac'&&(audio.container!=='flac'||!mobileInteger(audio.bitsPerSample,4,32))
    ||audio.codec!=='flac'&&audio.codec!=='mp3')return invalid();
  const observedDuration=b.observed.durationMs;
  if(audio.codec==='flac'?(b.observed.contentType!=='audio/flac'||!mobileInteger(observedDuration,1)
      ||Math.abs(observedDuration-song.dt)>MOBILE_NETEASE_DURATION_TOLERANCE_MS):
    b.observed.contentType!=='audio/mpeg'||audio.container!=='mp3'||observedDuration!==null||audio.bitsPerSample!==undefined)return invalid();
  const durationMs=observedDuration??song.dt;
  return Object.freeze({account,track:Object.freeze({id:selection.trackId,source:'netease' as const,sourceItemId:b.sourceItemId,albumId:b.albumId,
    title,artists:Object.freeze(artists) as unknown as string[],versionId:selection.versionId,contentRevision:selection.contentRevision,
    editionLabel:b.editionLabel,durationMs,audio:Object.freeze({...audio}),availability:b.availability,...(b.artworkId?{artworkId:b.artworkId}:{})})});
}
