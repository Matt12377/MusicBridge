import { MOBILE_CODEC_LIMITS, MOBILE_COMMON_SCHEMAS, MOBILE_ID_SCHEMA, isMobileId, isMobileSource, mobileCanonicalJson, mobileDateTime, mobileFailure, mobileInteger, mobileOk, mobileRecord, mobileSchemaSnapshot, mobileUtf8Bytes } from './mobile-common.js';
import type { MobileAudioInfo, MobileCodecLimits, MobileDecodeResult, MobileEmptyRequest, MobileErrorEnvelope, MobileId, MobileProcessing, MobileResourceCodecContext, MobileRevision, MobileSchemaRegistry, MobileSource } from './mobile-common.js';

export interface MobileQualityRequest { profile:'auto' | 'lossless' | 'balanced' | 'data_saver'; allowLossyFallback:boolean; preferredTransport:'auto' | 'file' | 'hls' }
export interface MobileBaseFormatCapability { codec:string; container:string; maxSampleRateHz:number; maxChannels:number }
export interface MobileBitDepthFormatCapability extends MobileBaseFormatCapability { maxBitsPerSample?:number }
export interface MobileBaseResourceRequest { trackId:MobileId; versionId:MobileId; contentRevision:MobileRevision; quality:MobileQualityRequest; formats:MobileBaseFormatCapability[]; acceptedProcessingModes?:('dsd_to_pcm')[] }
export interface MobileBitDepthResourceRequest extends Omit<MobileBaseResourceRequest,'formats'> { formats:MobileBitDepthFormatCapability[] }
export type MobileResourceRequest = MobileBitDepthResourceRequest;
export interface MobileSessionRequest { clientInstanceId:MobileId }
export interface MobileSession { id:MobileId; deviceId:MobileId; createdAt:string; expiresAt:string }
export interface MobileObservation { sequence:number; playerGeneration:number; queueItemId:MobileId; resourceId:MobileId; trackId:MobileId; positionMs:number; state:'ready' | 'playing' | 'paused' | 'buffering' | 'seeking' | 'ended' | 'failed' }
export interface MobileObservationReceipt { acceptedSequence:number; accepted:boolean }
export interface MobileMedia { url:string; transport:'file' | 'hls'; expiresAt:string; durationMs:number; seekable:boolean; actualAudio:MobileAudioInfo }
interface MobileResourceIdentity { id:MobileId; sessionId:MobileId; trackId:MobileId; versionId:MobileId; contentRevision:MobileRevision; sourceAudio:MobileAudioInfo; processing:MobileProcessing; retryAfterMs?:number }
export interface MobileReadyResource extends MobileResourceIdentity { state:'ready'; media:MobileMedia; failure?:never }
export interface MobilePreparingResource extends MobileResourceIdentity { state:'preparing'; media?:never; failure?:never }
export interface MobileFailedResource extends MobileResourceIdentity { state:'failed'; media?:never; failure:MobileErrorEnvelope }
export type MobileResource = MobileReadyResource | MobilePreparingResource | MobileFailedResource;
export type MobileCreateResourceReply = {status:201;body:MobileReadyResource} | {status:202;body:MobilePreparingResource};
export interface MobileGetResourceReply { status:200; body:MobileResource }
export interface MobileResourceSemanticContext extends MobileResourceCodecContext { request:MobileResourceRequest; source:MobileSource; sourceAudio:MobileAudioInfo; expectedResourceId:MobileId | null; hlsAllowed?:boolean; previousResource?:MobileResource }
export interface MobileResourceCommandMap { sessionRequest:MobileSessionRequest; observation:MobileObservation; empty:MobileEmptyRequest }
const formatProperties = {codec:{type:'string',minLength:1,maxLength:40},container:{type:'string',minLength:1,maxLength:40},maxSampleRateHz:{type:'integer',minimum:8000,maximum:768000},maxChannels:{type:'integer',minimum:1,maximum:32}} as const;
const formatRequired = ['codec','container','maxSampleRateHz','maxChannels'] as const;
const processingAcceptance = {type:'array',items:{type:'string',enum:['dsd_to_pcm']},minItems:1,maxItems:1,uniqueItems:true,description:'可选且不可null。客户端仅在已采纳此mode并观察resourceDsdToPcm=true时发送；缺省不接受DSD转换。绑定原幂等正文。'} as const;
export const MOBILE_RESOURCE_SCHEMAS: MobileSchemaRegistry = {
  ...MOBILE_COMMON_SCHEMAS,
  SessionRequest:{type:'object',required:['clientInstanceId'],additionalProperties:false,properties:{clientInstanceId:MOBILE_ID_SCHEMA}},
  Session:{type:'object',required:['id','deviceId','createdAt','expiresAt'],additionalProperties:true,properties:{id:MOBILE_ID_SCHEMA,deviceId:MOBILE_ID_SCHEMA,createdAt:{type:'string',format:'date-time'},expiresAt:{type:'string',format:'date-time'}}},
  QualityRequest:{type:'object',required:['profile','allowLossyFallback','preferredTransport'],additionalProperties:false,properties:{profile:{enum:['auto','lossless','balanced','data_saver']},allowLossyFallback:{type:'boolean'},preferredTransport:{enum:['auto','file','hls']}},allOf:[{if:{properties:{profile:{const:'lossless'}}},then:{properties:{allowLossyFallback:{const:false}}}}]},
  FormatCapability:{type:'object',required:formatRequired,additionalProperties:false,properties:formatProperties},
  FormatCapabilityWithBitDepth:{type:'object',required:formatRequired,additionalProperties:false,properties:{...formatProperties,maxBitsPerSample:{type:'integer',minimum:1,maximum:64}}},
  ResourceRequest:{type:'object',required:['trackId','versionId','contentRevision','quality','formats'],additionalProperties:false,properties:{trackId:MOBILE_ID_SCHEMA,versionId:MOBILE_ID_SCHEMA,contentRevision:MOBILE_ID_SCHEMA,quality:{$ref:'#/components/schemas/QualityRequest'},formats:{type:'array',minItems:1,maxItems:20,items:{$ref:'#/components/schemas/FormatCapability'}},acceptedProcessingModes:processingAcceptance}},
  ResourceRequestWithBitDepth:{type:'object',required:['trackId','versionId','contentRevision','quality','formats'],additionalProperties:false,properties:{trackId:MOBILE_ID_SCHEMA,versionId:MOBILE_ID_SCHEMA,contentRevision:MOBILE_ID_SCHEMA,quality:{$ref:'#/components/schemas/QualityRequest'},formats:{type:'array',minItems:1,maxItems:20,items:{$ref:'#/components/schemas/FormatCapabilityWithBitDepth'}},acceptedProcessingModes:processingAcceptance}},
  Media:{type:'object',required:['url','transport','expiresAt','durationMs','seekable','actualAudio'],additionalProperties:true,properties:{url:{type:'string',format:'uri'},transport:{enum:['file','hls']},expiresAt:{type:'string',format:'date-time'},durationMs:{type:'integer',minimum:0},seekable:{type:'boolean'},actualAudio:{$ref:'#/components/schemas/AudioInfo'}}},
  Resource:{type:'object',required:['id','sessionId','trackId','versionId','contentRevision','state','sourceAudio','processing'],additionalProperties:true,properties:{id:MOBILE_ID_SCHEMA,sessionId:MOBILE_ID_SCHEMA,trackId:MOBILE_ID_SCHEMA,versionId:MOBILE_ID_SCHEMA,contentRevision:MOBILE_ID_SCHEMA,state:{enum:['preparing','ready','failed']},sourceAudio:{$ref:'#/components/schemas/AudioInfo'},processing:{$ref:'#/components/schemas/Processing'},media:{$ref:'#/components/schemas/Media'},retryAfterMs:{type:'integer',minimum:0},failure:{$ref:'#/components/schemas/Error'}},allOf:[{if:{properties:{state:{const:'ready'}}},then:{required:['media'],not:{required:['failure']}},else:{not:{required:['media']}}},{if:{properties:{state:{const:'failed'}}},then:{required:['failure']},else:{not:{required:['failure']}}}]},
  Observation:{type:'object',required:['sequence','playerGeneration','queueItemId','resourceId','trackId','positionMs','state'],additionalProperties:false,properties:{sequence:{type:'integer',minimum:1},playerGeneration:{type:'integer',minimum:0},queueItemId:MOBILE_ID_SCHEMA,resourceId:MOBILE_ID_SCHEMA,trackId:MOBILE_ID_SCHEMA,positionMs:{type:'integer',minimum:0},state:{enum:['ready','playing','paused','buffering','seeking','ended','failed']}}},
  ObservationReceipt:{type:'object',required:['acceptedSequence','accepted'],additionalProperties:true,properties:{acceptedSequence:{type:'integer',minimum:1},accepted:{type:'boolean'}}}
};
export function mobileResourceCodecContextValid(context:MobileResourceCodecContext):boolean {
  if (!context || !context.scope || ![context.scope.serverId,context.scope.deviceId,context.scope.sessionId,context.capabilitySnapshotIdentity].every(isMobileId) || typeof context.resourceFormatBitDepth !== 'boolean' || context.resourceDsdToPcm !== undefined && typeof context.resourceDsdToPcm !== 'boolean' || !['base','1.0.0'].includes(context.capabilityVersion) || (context.resourceFormatBitDepth || context.resourceDsdToPcm === true) && context.capabilityVersion !== '1.0.0' || !mobileDateTime(context.now)) return false;
  try { const origin = new URL(context.responseOrigin); return origin.protocol === 'https:' && !origin.username && !origin.password && origin.origin === context.responseOrigin; } catch { return false; }
}
export function mobileResourceRequestSnapshot(raw:unknown, context:MobileResourceCodecContext, limits:MobileCodecLimits = MOBILE_CODEC_LIMITS):MobileDecodeResult<MobileResourceRequest> {
  if (!mobileResourceCodecContextValid(context)) return mobileFailure('CONTEXT_MISMATCH','capabilities');
  return mobileSchemaSnapshot(MOBILE_RESOURCE_SCHEMAS[context.resourceFormatBitDepth ? 'ResourceRequestWithBitDepth' : 'ResourceRequest']!,raw,MOBILE_RESOURCE_SCHEMAS,limits,'request');
}
export const isMobileQualityRequest = (raw:unknown):raw is MobileQualityRequest => mobileSchemaSnapshot(MOBILE_RESOURCE_SCHEMAS.QualityRequest!,raw,MOBILE_RESOURCE_SCHEMAS, MOBILE_CODEC_LIMITS,'request').ok;
export function mobileResourceResponseSnapshot(raw:unknown,limits:MobileCodecLimits = MOBILE_CODEC_LIMITS):MobileDecodeResult<MobileResource> { return mobileSchemaSnapshot(MOBILE_RESOURCE_SCHEMAS.Resource!,raw,MOBILE_RESOURCE_SCHEMAS,limits); }
export const isMobileResource = (raw:unknown):raw is MobileResource => mobileResourceResponseSnapshot(raw).ok;
export function mobileResourceCommandSnapshot<K extends keyof MobileResourceCommandMap>(kind:K,raw:unknown,limits:MobileCodecLimits = MOBILE_CODEC_LIMITS):MobileDecodeResult<MobileResourceCommandMap[K]> {
  return mobileSchemaSnapshot(MOBILE_RESOURCE_SCHEMAS[{sessionRequest:'SessionRequest',observation:'Observation',empty:'EmptyRequest'}[kind]]!,raw,MOBILE_RESOURCE_SCHEMAS,limits,'request');
}
export function mobileFormatCombinationAccepts(format:MobileBitDepthFormatCapability, actual:MobileAudioInfo):boolean {
  return format.codec === actual.codec && format.container === actual.container
    && (actual.sampleRateHz === undefined || actual.sampleRateHz <= format.maxSampleRateHz) && (actual.channels === undefined || actual.channels <= format.maxChannels)
    && (format.maxBitsPerSample === undefined || actual.bitsPerSample !== undefined && actual.bitsPerSample <= format.maxBitsPerSample);
}
const audioFacts = (a:MobileAudioInfo) => ({codec:a.codec,container:a.container,...(a.sampleRateHz === undefined ? {} : {sampleRateHz:a.sampleRateHz}),...(a.bitsPerSample === undefined ? {} : {bitsPerSample:a.bitsPerSample}),...(a.channels === undefined ? {} : {channels:a.channels}),...(a.bitrateKbps === undefined ? {} : {bitrateKbps:a.bitrateKbps})});
/** DSD时钟是1-bit调制采样率；不能用解码器报告的PCM率替代。 */
export const MOBILE_DSD_SAMPLE_RATES_HZ = [2822400,3072000,5644800,6144000,11289600,12288000,22579200,24576000] as const;
export const MOBILE_DSD_MAX_CHANNELS = 6;
export const MOBILE_DSD_PCM_PROCESSING_REASON = 'DSD整曲转换为24-bit/48kHz PCM并编码独立FLAC。';
export type MobileDsdSourceAudio = MobileAudioInfo & {codec:'dsd';container:'dsf'|'dff';sampleRateHz:number;bitsPerSample:1;channels:number};
export function isMobileDsdSourceAudio(raw:unknown):raw is MobileDsdSourceAudio {
  const captured = mobileSchemaSnapshot<MobileAudioInfo>(MOBILE_COMMON_SCHEMAS.AudioInfo!,raw,MOBILE_COMMON_SCHEMAS);
  if (!captured.ok) return false;
  const audio = captured.value;
  return audio.codec === 'dsd' && ['dsf','dff'].includes(audio.container) && audio.bitsPerSample === 1
    && mobileInteger(audio.sampleRateHz,1) && (MOBILE_DSD_SAMPLE_RATES_HZ as readonly number[]).includes(audio.sampleRateHz)
    && mobileInteger(audio.channels,1,MOBILE_DSD_MAX_CHANNELS);
}
export function mobileDsdProcessingAllowed(resource:MobileResource,context:MobileResourceSemanticContext):boolean {
  const source = resource.sourceAudio;
  const dsd = /^dsd(?:_[a-z_]+)?$/iu.test(source.codec) || /^(?:dsf|dff)$/iu.test(source.container);
  if (!dsd && resource.processing.mode !== 'dsd_to_pcm') return true;
  const captured = mobileResourceRequestSnapshot(context.request,context);
  if (!captured.ok || context.resourceDsdToPcm !== true || context.source !== 'local' || !isMobileDsdSourceAudio(source)
    || resource.processing.mode !== 'dsd_to_pcm' || resource.processing.reason !== MOBILE_DSD_PCM_PROCESSING_REASON) return false;
  const request = captured.value;
  if (request.acceptedProcessingModes?.length !== 1 || request.acceptedProcessingModes[0] !== 'dsd_to_pcm'
    || request.quality.profile !== 'auto' || request.quality.allowLossyFallback || request.quality.preferredTransport !== 'file') return false;
  const target:MobileAudioInfo = {codec:'flac',container:'flac',sampleRateHz:48000,bitsPerSample:24,channels:source.channels};
  // 固定DSD mode的显式采纳证明24-bit同意；base请求仍禁止maxBitsPerSample。
  // formats的codec/container/采样率/声道及已声明位深上限继续独立生效。
  if (!request.formats.some(format => mobileFormatCombinationAccepts(format,target))) return false;
  if (resource.state !== 'ready') return true;
  const actual = resource.media.actualAudio;
  return actual.codec === 'flac' && actual.container === 'flac' && actual.sampleRateHz === 48000
    && actual.bitsPerSample === 24 && actual.channels === source.channels
    && resource.media.transport === 'file' && resource.media.seekable;
}
/** 同资源的票据和缓存命中事实可更新；音频身份、处理解释及已知媒体事实不可漂移。 */
export function mobileResourceStableFactsMatch(before:MobileResource,after:MobileResource):boolean {
  if (before.id !== after.id || before.sessionId !== after.sessionId || before.trackId !== after.trackId
    || before.versionId !== after.versionId || before.contentRevision !== after.contentRevision
    || mobileCanonicalJson(audioFacts(before.sourceAudio)) !== mobileCanonicalJson(audioFacts(after.sourceAudio))
    || before.processing.mode !== after.processing.mode || before.processing.reason !== after.processing.reason) return false;
  if (before.state !== 'ready' || after.state !== 'ready') return true;
  return before.media.durationMs === after.media.durationMs && before.media.seekable === after.media.seekable
    && before.media.transport === after.media.transport
    && mobileCanonicalJson(audioFacts(before.media.actualAudio)) === mobileCanonicalJson(audioFacts(after.media.actualAudio));
}
function validResourceIdentity(resource:MobileResource,context:MobileResourceSemanticContext):boolean {
  if (context.previousResource !== undefined) {
    const previous = mobileResourceResponseSnapshot(context.previousResource);
    if (!previous.ok || !mobileResourceStableFactsMatch(previous.value,resource)) return false;
  }
  return mobileResourceCodecContextValid(context) && isMobileSource(context.source) && resource.sessionId === context.scope.sessionId && resource.trackId === context.request.trackId && resource.versionId === context.request.versionId && resource.contentRevision === context.request.contentRevision
    && (context.expectedResourceId === null || resource.id === context.expectedResourceId) && mobileCanonicalJson(audioFacts(resource.sourceAudio)) === mobileCanonicalJson(audioFacts(context.sourceAudio));
}
export function validateMobileReadyAudio(resource:MobileReadyResource, request:MobileResourceRequest, context:MobileResourceSemanticContext, limits:MobileCodecLimits = MOBILE_CODEC_LIMITS):MobileDecodeResult<MobileReadyResource> {
  const captured = mobileResourceResponseSnapshot(resource,limits); if (!captured.ok) return captured;
  const requested = mobileResourceRequestSnapshot(request,context,limits); if (!requested.ok) return requested;
  const authority = mobileResourceRequestSnapshot(context.request,context,limits); if (!authority.ok) return authority;
  request = requested.value;
  if (captured.value.state !== 'ready' || !validResourceIdentity(captured.value,context) || !mobileDsdProcessingAllowed(captured.value,context) || mobileCanonicalJson(request as unknown as import('./mobile-common.js').MobileJsonValue) !== mobileCanonicalJson(authority.value as unknown as import('./mobile-common.js').MobileJsonValue)) return mobileFailure('CONTEXT_MISMATCH','resource');
  const r = captured.value, source = r.sourceAudio, actual = r.media.actualAudio;
  if (!mobileResourceRequestSnapshot(request,context).ok || !request.formats.some(format => mobileFormatCombinationAccepts(format,actual)) || r.media.transport === 'hls' && context.hlsAllowed !== true || request.quality.preferredTransport === 'file' && r.media.transport !== 'file' || mobileUtf8Bytes(r.processing.reason) > 1024) return mobileFailure('CONTEXT_MISMATCH','format');
  if (source.codec === 'flac' || request.quality.profile === 'lossless') {
    if (source.codec === 'flac' && (request.quality.profile !== 'lossless' || request.quality.allowLossyFallback) || !['flac','alac','pcm_s16le','pcm_s24le','pcm_s32le'].includes(source.codec) || !['flac','alac','pcm_s16le','pcm_s24le','pcm_s32le'].includes(actual.codec)
      || !['direct','remux','lossless_conversion'].includes(r.processing.mode) || !r.media.seekable || ![source.sampleRateHz,source.bitsPerSample,source.channels].every(n => mobileInteger(n,1))
      || source.sampleRateHz !== actual.sampleRateHz || source.bitsPerSample !== actual.bitsPerSample || source.channels !== actual.channels) return mobileFailure('CONTEXT_MISMATCH','lossless');
  }
  try {
    if (mobileUtf8Bytes(r.media.url) > 4096 || /[\u0000-\u0020\u007f\\]/u.test(r.media.url) || !mobileDateTime(r.media.expiresAt) || Date.parse(r.media.expiresAt) <= Date.parse(context.now)) return mobileFailure('CONTEXT_MISMATCH','media');
    const url = new URL(r.media.url), pieces = url.pathname.split('/').map(piece => decodeURIComponent(piece)), query = [...url.searchParams.entries()];
    // 每段只解码一次；原路径也对账，不能让 URL 的点段归一化隐藏穿越。
    const originalPath = /^https:\/\/[^/?#]+(\/[^?#]*)/iu.exec(r.media.url)?.[1];
    const originalPieces = originalPath?.split('/').map(piece => decodeURIComponent(piece));
    if (!originalPieces || originalPieces.length !== pieces.length || originalPieces.some((piece,index) => piece !== pieces[index] || piece.includes('/') || piece === '.' || piece === '..')
      || url.protocol !== 'https:' || url.origin !== context.responseOrigin || url.username || url.password || url.hash || pieces.length !== 6 || pieces.slice(0,5).join('/') !== `/mobile/v1/media/${r.id}`
      || !/^[A-Za-z0-9_.-]{1,160}$/u.test(pieces[5]!) || ['.','..'].includes(pieces[5]!) || query.length !== 1 || query[0]![0] !== 'ticket' || !/^[\x21-\x7e]{16,512}$/u.test(query[0]![1])) return mobileFailure('CONTEXT_MISMATCH','media');
  } catch { return mobileFailure('CONTEXT_MISMATCH','media'); }
  return mobileOk(r);
}
export function validateMobileCreateResourceReply(status:number,raw:unknown,context:MobileResourceSemanticContext,limits:MobileCodecLimits = MOBILE_CODEC_LIMITS):MobileDecodeResult<MobileCreateResourceReply> {
  const result = mobileResourceResponseSnapshot(raw,limits); if (!result.ok) return result;
  if (!validResourceIdentity(result.value,context)) return mobileFailure('SOURCE_CHANGED','resource');
  if (!mobileDsdProcessingAllowed(result.value,context)) return mobileFailure('CONTEXT_MISMATCH','processing');
  if (status === 202 && result.value.state === 'preparing') return mobileOk({status,body:result.value});
  if (status === 201 && result.value.state === 'ready') { const ready = validateMobileReadyAudio(result.value,context.request,context,limits); return ready.ok ? mobileOk({status,body:ready.value}) : ready; }
  return mobileFailure('INVALID_RESPONSE','status');
}
export function validateMobileGetResourceReply(status:number,raw:unknown,context:MobileResourceSemanticContext,limits:MobileCodecLimits = MOBILE_CODEC_LIMITS):MobileDecodeResult<MobileGetResourceReply> {
  const result = mobileResourceResponseSnapshot(raw,limits); if (!result.ok) return result;
  if (status !== 200 || !validResourceIdentity(result.value,context)) return mobileFailure('SOURCE_CHANGED','resource');
  if (!mobileDsdProcessingAllowed(result.value,context)) return mobileFailure('CONTEXT_MISMATCH','processing');
  if (result.value.state === 'ready') { const ready = validateMobileReadyAudio(result.value,context.request,context,limits); return ready.ok ? mobileOk({status:200,body:ready.value}) : ready; }
  return mobileOk({status:200,body:result.value});
}
