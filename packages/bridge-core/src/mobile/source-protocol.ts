import { isMobileId, isMobileAudioInfo, isMobileProcessing, isMobileDsdSourceAudio, MOBILE_DSD_PCM_PROCESSING_REASON } from '@music-bridge/contracts';
import type { MobilePlaybackPreparedSource, MobilePlaybackPreparingSource, MobilePlaybackSourceRequest } from './source-types.js';

/** 仅 Main→Core→原 Owner；不经 Renderer、不接收路径或 FD。 */
export type MobileOwnerSourceRequest =
  | { operation: 'prepare'; selection: MobilePlaybackSourceRequest }
  | { operation: 'status'; handle: string }
  | { operation: 'capabilities' }
  | { operation: 'verify' | 'renew' | 'release'; handle: string }
  | { operation: 'read'; handle: string; readId: string; start: number; maxBytes: number }
  | { operation: 'close-read'; handle: string; readId: string };
export type MobileOwnerSourceResult =
  | { kind: 'mobile-source-prepared'; source: MobilePlaybackPreparedSource }
  | { kind: 'mobile-source-preparing'; source: MobilePlaybackPreparingSource }
  | { kind: 'mobile-source-capabilities'; resourceDsdToPcm: boolean }
  | { kind: 'mobile-source-read'; handle: string; readId: string; start: number; bytes: Uint8Array }
  | { kind: 'mobile-source-ack'; operation: 'verify' | 'renew' | 'release' | 'close-read'; handle: string; readId: string | null; quiet: boolean };
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(v);
const integer = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): v is number => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
const typedArray = Object.getPrototypeOf(Uint8Array.prototype) as object;
const byteLength = Object.getOwnPropertyDescriptor(typedArray, 'byteLength')!.get!;
const byteBuffer = Object.getOwnPropertyDescriptor(typedArray, 'buffer')!.get!;
function chunk(v: unknown, maximum: number): v is Uint8Array {
  if (!(v instanceof Uint8Array) || Object.getPrototypeOf(v) !== Uint8Array.prototype) return false;
  const size = byteLength.call(v) as number;
  return size <= maximum && !(byteBuffer.call(v) instanceof SharedArrayBuffer)
    && Reflect.ownKeys(v).every(k => typeof k === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(k) && Number(k) < size);
}
function closed(v: unknown, names: readonly string[]): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return false;
  const ds = Object.getOwnPropertyDescriptors(v);
  return Reflect.ownKeys(ds).length === names.length && names.every(k => ds[k]?.enumerable && Object.hasOwn(ds[k]!, 'value'));
}
function audio(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const ds = Object.getOwnPropertyDescriptors(v), allowed = ['codec','container','sampleRateHz','bitsPerSample','channels','bitrateKbps'];
  return Reflect.ownKeys(ds).every(k => typeof k === 'string' && allowed.includes(k) && ds[k]?.enumerable && Object.hasOwn(ds[k]!, 'value')) && isMobileAudioInfo(v);
}
export function isMobileOwnerSourceRequest(v: unknown): v is MobileOwnerSourceRequest {
  try {
    if (closed(v, ['operation']) && v.operation === 'capabilities') return true;
    if (closed(v, ['operation','handle']) && v.operation === 'status') return uuid(v.handle);
    if (closed(v, ['operation','selection']) && v.operation === 'prepare') {
      const s = v.selection;
      if (!s || typeof s !== 'object') return false;
      const extra = Object.hasOwn(s, 'acceptedProcessingModes') ? ['acceptedProcessingModes','preparationWindow','dsdTarget'] : [];
      if (!closed(s, ['resourceId','trackId','versionId','contentRevision',...extra]) || !uuid(s.resourceId)
        || !isMobileId(s.trackId) || !isMobileId(s.versionId) || !isMobileId(s.contentRevision)) return false;
      if (!extra.length) return true;
      return Array.isArray(s.acceptedProcessingModes) && Object.getPrototypeOf(s.acceptedProcessingModes) === Array.prototype
        && Reflect.ownKeys(s.acceptedProcessingModes).length === 2 && Object.hasOwn(s.acceptedProcessingModes, '0')
        && Object.getOwnPropertyDescriptor(s.acceptedProcessingModes, '0')?.value === 'dsd_to_pcm'
        && closed(s.preparationWindow, ['resourceCreatedAtMs','resourceExpiresAtMs','sessionExpiresAtMs','remainingPreparationMs'])
        && integer(s.preparationWindow.resourceCreatedAtMs, 0) && integer(s.preparationWindow.resourceExpiresAtMs, 0)
        && integer(s.preparationWindow.sessionExpiresAtMs, 0) && integer(s.preparationWindow.remainingPreparationMs, 1, 240_000)
        && s.preparationWindow.resourceExpiresAtMs > s.preparationWindow.resourceCreatedAtMs
        && s.preparationWindow.sessionExpiresAtMs >= s.preparationWindow.resourceExpiresAtMs
        && closed(s.dsdTarget,['maxChannels','accepts24Bit48KhzFlac']) && integer(s.dsdTarget.maxChannels,0,32) && typeof s.dsdTarget.accepts24Bit48KhzFlac==='boolean';
    }
    if (closed(v, ['operation','handle']) && typeof v.operation === 'string' && ['verify','renew','release'].includes(v.operation)) return uuid(v.handle);
    if (closed(v, ['operation','handle','readId']) && v.operation === 'close-read') return uuid(v.handle) && uuid(v.readId);
    return closed(v, ['operation','handle','readId','start','maxBytes']) && v.operation === 'read' && uuid(v.handle) && uuid(v.readId)
      && integer(v.start, 0) && integer(v.maxBytes, 1, 64 * 1024);
  } catch { return false; }
}
export function isMobileOwnerSourceResult(v: unknown, request: MobileOwnerSourceRequest): v is MobileOwnerSourceResult {
  try {
    if (request.operation === 'capabilities') return closed(v, ['kind','resourceDsdToPcm']) && v.kind === 'mobile-source-capabilities' && typeof v.resourceDsdToPcm === 'boolean';
    if (request.operation === 'prepare' || request.operation === 'status') {
      const handle = request.operation === 'prepare' ? request.selection.resourceId : request.handle;
      if (closed(v, ['kind','source']) && v.kind === 'mobile-source-preparing') return closed(v.source, ['handle','preparing','sourceAudio','processing','durationMs','seekable'])
        && v.source.handle === handle && v.source.preparing === true && audio(v.source.sourceAudio) && isMobileDsdSourceAudio(v.source.sourceAudio)
        && closed(v.source.processing, ['mode','reason','fromPreparedCache']) && v.source.processing.mode === 'dsd_to_pcm'
        && v.source.processing.reason === MOBILE_DSD_PCM_PROCESSING_REASON && v.source.processing.fromPreparedCache === false
        && integer(v.source.durationMs, 0) && v.source.seekable === true;
      return closed(v, ['kind','source']) && v.kind === 'mobile-source-prepared'
      && closed(v.source, ['handle','sourceAudio','actualAudio','processing','contentType','size','durationMs','seekable'])
      && v.source.handle === handle && audio(v.source.sourceAudio) && audio(v.source.actualAudio)
      && closed(v.source.processing, ['mode','reason','fromPreparedCache']) && isMobileProcessing(v.source.processing)
      && typeof v.source.contentType === 'string' && ['audio/wav','audio/mp4','audio/mpeg','audio/aiff','audio/flac'].includes(v.source.contentType)
      && integer(v.source.size, 1) && integer(v.source.durationMs, 0) && v.source.seekable === true;
    }
    if (request.operation === 'read') return closed(v, ['kind','handle','readId','start','bytes']) && v.kind === 'mobile-source-read'
      && v.handle === request.handle && v.readId === request.readId && v.start === request.start
      && chunk(v.bytes, request.maxBytes);
    return closed(v, ['kind','operation','handle','readId','quiet']) && v.kind === 'mobile-source-ack'
      && v.operation === request.operation && v.handle === request.handle
      && v.readId === (request.operation === 'close-read' ? request.readId : null) && v.quiet === true;
  } catch { return false; }
}
