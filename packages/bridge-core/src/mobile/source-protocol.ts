import { isMobileId, isMobileAudioInfo, isMobileProcessing } from '@music-bridge/contracts';
import type { MobilePlaybackPreparedSource, MobilePlaybackSourceRequest } from './source-types.js';

/** 仅 Main→Core→原 Owner；不经 Renderer、不接收路径或 FD。 */
export type MobileOwnerSourceRequest =
  | { operation: 'prepare'; selection: MobilePlaybackSourceRequest }
  | { operation: 'verify' | 'renew' | 'release'; handle: string }
  | { operation: 'read'; handle: string; readId: string; start: number; maxBytes: number }
  | { operation: 'close-read'; handle: string; readId: string };
export type MobileOwnerSourceResult =
  | { kind: 'mobile-source-prepared'; source: MobilePlaybackPreparedSource }
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
    if (closed(v, ['operation','selection']) && v.operation === 'prepare') return closed(v.selection, ['resourceId','trackId','versionId','contentRevision'])
      && uuid(v.selection.resourceId) && isMobileId(v.selection.trackId) && isMobileId(v.selection.versionId) && isMobileId(v.selection.contentRevision);
    if (closed(v, ['operation','handle']) && typeof v.operation === 'string' && ['verify','renew','release'].includes(v.operation)) return uuid(v.handle);
    if (closed(v, ['operation','handle','readId']) && v.operation === 'close-read') return uuid(v.handle) && uuid(v.readId);
    return closed(v, ['operation','handle','readId','start','maxBytes']) && v.operation === 'read' && uuid(v.handle) && uuid(v.readId)
      && integer(v.start, 0) && integer(v.maxBytes, 1, 64 * 1024);
  } catch { return false; }
}
export function isMobileOwnerSourceResult(v: unknown, request: MobileOwnerSourceRequest): v is MobileOwnerSourceResult {
  try {
    if (request.operation === 'prepare') return closed(v, ['kind','source']) && v.kind === 'mobile-source-prepared'
      && closed(v.source, ['handle','sourceAudio','actualAudio','processing','contentType','size','durationMs','seekable'])
      && v.source.handle === request.selection.resourceId && audio(v.source.sourceAudio) && audio(v.source.actualAudio)
      && closed(v.source.processing, ['mode','reason','fromPreparedCache']) && isMobileProcessing(v.source.processing)
      && typeof v.source.contentType === 'string' && ['audio/wav','audio/mp4','audio/mpeg','audio/aiff','audio/flac'].includes(v.source.contentType)
      && integer(v.source.size, 1) && integer(v.source.durationMs, 0) && v.source.seekable === true;
    if (request.operation === 'read') return closed(v, ['kind','handle','readId','start','bytes']) && v.kind === 'mobile-source-read'
      && v.handle === request.handle && v.readId === request.readId && v.start === request.start
      && chunk(v.bytes, request.maxBytes);
    return closed(v, ['kind','operation','handle','readId','quiet']) && v.kind === 'mobile-source-ack'
      && v.operation === request.operation && v.handle === request.handle
      && v.readId === (request.operation === 'close-read' ? request.readId : null) && v.quiet === true;
  } catch { return false; }
}
