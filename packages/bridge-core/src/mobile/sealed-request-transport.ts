import { types } from 'node:util';
import { isDatasetOwnerRequest, isDatasetOwnerResponse } from '../collection/dataset-owner-protocol.js';
import { isMobileCorePrivateCall, isMobileCorePrivateReply, isMobileOwnerPrivateResult, type MobileCorePrivateCall } from './owner-protocol.js';
import { allocateOwnedSealedBytes } from './owned-sealed-bytes.js';
import { isPlaybackHistoryReply } from './playback-history-protocol.js';
import { MOBILE_AUTH_SEALED_MAX_BYTES, MobileAuthPersistenceError, type MobileOwnerPrivateRequest } from './types.js';

const schema = 'musicbridge.sealed-buffer.v1';
const NativeBytes = Uint8Array;
const arrayLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')!.get!;
const arrayBuffer = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'buffer')!.get!;
const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const nativeSet = Uint8Array.prototype.set;
// 仅用于原完整metadata guard；原save合同没有与sealed实际长度交叉的其他字段。
const metadataBytes = allocateOwnedSealedBytes(1);
const awaitingCapture = new WeakMap<object, { key: 'request' | 'mobile'; wire: unknown }>();
const portValues = new WeakSet<object>();
const historyRequests = new WeakMap<object, { key: 'request' | 'mobile'; buffers: readonly (ArrayBuffer | null)[] }>();
const historyRequestValues = new WeakSet<object>();
const historyReplies = new WeakMap<object, readonly (ArrayBuffer | null)[]>();
const historyReplyValues = new WeakSet<object>();

function invalid(): never { throw new MobileAuthPersistenceError('not-sent'); }
function data(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return invalid();
  const field = Object.getOwnPropertyDescriptor(value, key);
  if (!field || !Object.hasOwn(field, 'value')) return invalid();
  return field.value;
}
function replace(value: unknown, key: string, replacement: unknown): object {
  data(value, key);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  // 必须保留全部原字段、原型和描述符；不得先重建闭集清洗攻击输入。
  descriptors[key] = { ...descriptors[key], value: replacement };
  return Object.create(Object.getPrototypeOf(value), descriptors) as object;
}
function savePath(value: unknown, outerKey: 'request' | 'mobile'): { mobile: object; request: object; sealed: unknown } | null {
  const mobile = data(value, outerKey), kind = data(mobile, 'kind');
  if (kind !== 'save' && kind !== 'playback-save') return null;
  const request = data(mobile, 'request');
  return { mobile: mobile as object, request: request as object, sealed: data(request, 'sealed') };
}
function replacing(value: unknown, key: 'request' | 'mobile', path: NonNullable<ReturnType<typeof savePath>>, sealed: unknown): object {
  return replace(value, key, replace(path.mobile, 'request', replace(path.request, 'sealed', sealed)));
}
function wireBytes(value: Uint8Array): object {
  // 发送前已完成原完整guard；只复制当前view，不借用底层多余区间或转移原账本存储。
  const length = Reflect.apply(arrayLength, value, []) as number;
  const copy = new NativeBytes(value);
  const buffer = Reflect.apply(arrayBuffer, copy, []) as ArrayBuffer;
  return { schema, buffer, byteOffset: 0, byteLength: length };
}
function verifiedBuffer(value: unknown, maximum = MOBILE_AUTH_SEALED_MAX_BYTES): ArrayBuffer {
  if (!value || typeof value !== 'object' || types.isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  const fields = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(fields);
  if (keys.length !== 4 || !['schema', 'buffer', 'byteOffset', 'byteLength'].every(key => fields[key]?.enumerable === true && Object.hasOwn(fields[key]!, 'value'))
    || fields.schema!.value !== schema || fields.byteOffset!.value !== 0) return invalid();
  const buffer: unknown = fields.buffer!.value;
  if (!buffer || typeof buffer !== 'object' || types.isProxy(buffer) || !types.isArrayBuffer(buffer)
    || Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype || Reflect.ownKeys(buffer).length !== 0) return invalid();
  const length = Reflect.apply(bufferLength, buffer, []) as number;
  if (!Number.isSafeInteger(length) || length < 1 || length > maximum || fields.byteLength!.value !== length
    || resizable && Reflect.apply(resizable, buffer, []) !== false) return invalid();
  return buffer;
}
type ByteMap = (value: unknown, maximum: number) => unknown;
function historyArray(raw: unknown, map: (value: unknown) => unknown): unknown[] {
  if (!Array.isArray(raw) || types.isProxy(raw) || Object.getPrototypeOf(raw) !== Array.prototype
    || raw.length > 64 || Reflect.ownKeys(raw).length !== raw.length + 1) return invalid();
  const out: unknown[] = [];
  for (let i = 0; i < raw.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, String(i));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return invalid();
    out.push(map(descriptor.value));
  }
  return out;
}
/** 只替换已知二进制字段；原对象所有其他字段/描述符始终留给完整guard。 */
function historyRequestBytes(raw: unknown, map: ByteMap): object {
  const op = data(raw, 'op');
  if (op === 'stage') {
    const locators = historyArray(data(raw, 'locators'), locator => replace(locator, 'sealed', map(data(locator, 'sealed'), 256 * 1024)));
    return replace(raw, 'locators', locators);
  }
  if (op === 'commit') {
    const next = data(raw, 'next'), hot = data(next, 'hot');
    const mappedHot = data(hot, 'kind') === 'sealed' ? replace(hot, 'sealed', map(data(hot, 'sealed'), MOBILE_AUTH_SEALED_MAX_BYTES)) : hot;
    return replace(raw, 'next', replace(replace(next, 'sealedHead', map(data(next, 'sealedHead'), 256 * 1024)), 'hot', mappedHot));
  }
  return raw as object;
}
function historyResultBytes(raw: unknown, map: ByteMap): object {
  const kind = data(raw, 'kind');
  if (kind === 'loaded') {
    const hot = data(raw, 'hot'), head = data(raw, 'sealedHead');
    const mappedHot = data(hot, 'kind') === 'sealed' ? replace(hot, 'sealed', map(data(hot, 'sealed'), MOBILE_AUTH_SEALED_MAX_BYTES)) : hot;
    return replace(replace(raw, 'hot', mappedHot), 'sealedHead', head === null ? null : map(head, 256 * 1024));
  }
  if (kind === 'proof') {
    const locator = data(raw, 'locator'), archive = data(raw, 'archive');
    return replace(replace(raw, 'locator', locator === null ? null : replace(locator, 'sealed', map(data(locator, 'sealed'), 256 * 1024))),
      'archive', archive === null ? null : replace(archive, 'sealed', map(data(archive, 'sealed'), MOBILE_AUTH_SEALED_MAX_BYTES)));
  }
  return raw as object;
}
function ownedBuffer(buffer: ArrayBuffer | null, value: unknown): Uint8Array {
  const bytes = buffer === null ? value as Uint8Array : new Uint8Array(buffer);
  const length = Reflect.apply(arrayLength, bytes, []) as number, owned = allocateOwnedSealedBytes(length);
  Reflect.apply(nativeSet, owned, [bytes]); return owned;
}
function decodeHistoryRequest(value: unknown, key: 'request' | 'mobile', guard: (value: unknown) => boolean): unknown {
  const mobile = data(value, key);
  if (data(mobile, 'kind') !== 'playback-history') return value;
  const request = data(mobile, 'request'), buffers: (ArrayBuffer | null)[] = [];
  let total = 0, wire = false;
  const mapped = historyRequestBytes(request, (bytes, maximum) => {
    if (types.isUint8Array(bytes)) { buffers.push(null); return bytes; }
    const buffer = verifiedBuffer(bytes, maximum); buffers.push(buffer); total += buffer.byteLength; wire = true;
    return metadataBytes;
  });
  if (!wire) return value;
  if (data(request, 'op') === 'stage' && total > 256 * 1024) return invalid();
  const logical = replace(value, key, replace(mobile, 'request', mapped));
  if (!guard(logical)) return value;
  historyRequests.set(logical, { key, buffers }); historyRequestValues.add(logical); return logical;
}
function decode(value: unknown, key: 'request' | 'mobile', guard: (value: unknown) => boolean): unknown {
  try {
    if (data(data(value, key), 'kind') === 'playback-history') return decodeHistoryRequest(value, key, guard);
    const path = savePath(value, key); if (!path || types.isUint8Array(path.sealed)) return value;
    verifiedBuffer(path.sealed);
    // 只有sealed换为本地占位；其他原metadata仍完整经过原guard，坏scope/闭集不得先分配大副本。
    const logical = replacing(value, key, path, metadataBytes);
    if (!guard(logical)) return value;
    awaitingCapture.set(logical, { key, wire: path.sealed }); portValues.add(logical);
    return logical;
  } catch { return value; }
}

/** 只能消费当前实际port listener登记的对象；未知raw返回null，迟到/重复捕获必须拒绝。 */
export function captureMobileSealedRequestFromPort(value: object): object | null {
  if (historyRequestValues.has(value)) {
    const pending = historyRequests.get(value); historyRequests.delete(value);
    if (!pending) return invalid();
    const mobile = data(value, pending.key); let index = 0;
    const request = historyRequestBytes(data(mobile, 'request'), bytes => {
      if (index >= pending.buffers.length) return invalid();
      return ownedBuffer(pending.buffers[index++]!, bytes);
    });
    if (index !== pending.buffers.length) return invalid();
    return replace(value, pending.key, replace(mobile, 'request', request));
  }
  if (!portValues.has(value)) return null;
  const pending = awaitingCapture.get(value); awaitingCapture.delete(value);
  if (!pending) return invalid();
  const buffer = verifiedBuffer(pending.wire), path = savePath(value, pending.key);
  if (!path) return invalid();
  const length = Reflect.apply(bufferLength, buffer, []) as number;
  const owned = allocateOwnedSealedBytes(length);
  Reflect.apply(nativeSet, owned, [new Uint8Array(buffer)]);
  return replacing(value, pending.key, path, owned);
}

/** 仅可信发送组合调用；未知Uint8Array先沿原完整guard，wire不是自报owned资格。 */
export function encodeMobileSealedCoreRequest(value: unknown): unknown {
  try {
    const mobile = data(value, 'request');
    if (data(mobile, 'kind') === 'playback-history') {
      if (!isMobileCorePrivateCall(value)) return invalid();
      return replace(value, 'request', replace(mobile, 'request', historyRequestBytes(data(mobile, 'request'), bytes => wireBytes(bytes as Uint8Array))));
    }
    const path = savePath(value, 'request'); if (!path) return value;
    if (!isMobileCorePrivateCall(value)) return invalid();
    return replacing(value, 'request', path, wireBytes(path.sealed as Uint8Array));
  } catch { return invalid(); }
}
/** 原Owner完整envelope/expectedDataset/sequence合同不变。 */
export function encodeMobileSealedOwnerRequest(value: unknown): unknown {
  // 其他Owner命令没有mobile字段，完全保留原路径。
  if (types.isProxy(value)) return invalid();
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'mobile')) return value;
  try {
    const mobile = data(value, 'mobile');
    if (data(mobile, 'kind') === 'playback-history') {
      if (!isDatasetOwnerRequest(value)) return invalid();
      return replace(value, 'mobile', replace(mobile, 'request', historyRequestBytes(data(mobile, 'request'), bytes => wireBytes(bytes as Uint8Array))));
    }
    const path = savePath(value, 'mobile'); if (!path) return value;
    if (!isDatasetOwnerRequest(value)) return invalid();
    return replacing(value, 'mobile', path, wireBytes(path.sealed as Uint8Array));
  } catch { return invalid(); }
}

interface CorePort { on(event: 'message', listener: (event: { data: unknown }) => void): unknown }
interface OwnerPort { on(event: 'message', listener: (value: unknown) => void): unknown; off(event: 'message', listener: (value: unknown) => void): unknown }
/** 来源只来自组合根已绑定的实际Main私有port；没有公开的raw解码/登记品牌入口。 */
export function attachMobileSealedCoreReceiver(port: CorePort, listener: (event: { data: unknown }) => void): void {
  port.on('message', event => {
    const value = decode(event.data, 'request', isMobileCorePrivateCall);
    try { listener(value === event.data ? event : { data: value }); }
    finally { if (value && typeof value === 'object') { awaitingCapture.delete(value); historyRequests.delete(value); } }
  });
}
/** 来源只来自原Owner Worker端口，原handler继续检查epoch/sequence/boot与关闭状态。 */
export function attachMobileSealedOwnerReceiver(port: OwnerPort, listener: (value: unknown) => void): () => void {
  const receive = (value: unknown) => {
    const logical = decode(value, 'mobile', isDatasetOwnerRequest);
    try { listener(logical); }
    finally { if (logical && typeof logical === 'object') { awaitingCapture.delete(logical); historyRequests.delete(logical); } }
  };
  port.on('message', receive);
  return () => { port.off('message', receive); };
}


// reply资格仅存在于本模块绑定的同步端口回调；不接受外部对象自报owned。
const awaitingReplyCapture = new WeakMap<object, unknown>();
const replyPortValues = new WeakSet<object>();
function loadRequest(request: MobileOwnerPrivateRequest): boolean {
  return request.kind === 'load' || request.kind === 'playback-load';
}
function plainFields(value: unknown, required: readonly string[], optional: readonly string[] = []): boolean {
  if (!value || typeof value !== 'object' || types.isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const fields = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(fields);
  return keys.length >= required.length && keys.length <= required.length + optional.length
    && required.every(key => Object.hasOwn(fields, key))
    && keys.every(key => typeof key === 'string' && (required.includes(key) || optional.includes(key))
      && fields[key]?.enumerable === true && Object.hasOwn(fields[key]!, 'value'));
}
function replyEnvelope(value: unknown, kind: 'owner' | 'core'): boolean {
  return kind === 'owner'
    ? plainFields(value, ['version', 'epoch', 'type', 'requestId', 'operation', 'ok', 'result'], ['failure'])
      && isDatasetOwnerResponse(value) && value.operation === 'mobileMain' && value.ok === true
    : plainFields(value, ['type', 'id', 'result']) && data(value, 'type') === 'mobile-main-response';
}
function encodeReply(value: unknown, request: MobileOwnerPrivateRequest, kind: 'owner' | 'core'): unknown {
  if (request.kind === 'playback-history') {
    try {
      if (!replyEnvelope(value, kind) || !isMobileOwnerPrivateResult(data(value, 'result'), request)) return invalid();
      return replace(value, 'result', historyResultBytes(data(value, 'result'), bytes => wireBytes(bytes as Uint8Array)));
    } catch { return invalid(); }
  }
  if (!loadRequest(request)) return value;
  try {
    const result = data(value, 'result');
    // 原missing/error回复没有二进制，完全保留旧路径。
    if (data(result, 'kind') !== 'sealed') return value;
    if (!replyEnvelope(value, kind) || !isMobileOwnerPrivateResult(result, request)) return invalid();
    return replace(value, 'result', replace(result, 'sealed', wireBytes(data(result, 'sealed') as Uint8Array)));
  } catch { return invalid(); }
}
/** Owner出站仍核原完整load结果；新wire只属于同代私有端口，不改变持久格式。 */
export function encodeMobileSealedOwnerReply(value: unknown, request: MobileOwnerPrivateRequest): unknown {
  return encodeReply(value, request, 'owner');
}
/** Core出站保留原call id/result绑定；不转移原账本或已发布state的buffer。 */
export function encodeMobileSealedCoreReply(value: unknown, call: MobileCorePrivateCall): unknown {
  if (loadRequest(call.request) || call.request.kind === 'playback-history') {
    try { if (!isMobileCorePrivateReply(value, call)) return invalid(); }
    catch { return invalid(); }
  }
  return encodeReply(value, call.request, 'core');
}
function decodeReply(value: unknown, kind: 'owner' | 'core'): unknown {
  try {
    // 原外部Uint8Array不登记；只能原guard完整校验，不能借listener升级资格。
    if (!replyEnvelope(value, kind)) return value;
    const result = data(value, 'result');
    if (['loaded', 'proof'].includes(data(result, 'kind') as string)) {
      const buffers: (ArrayBuffer | null)[] = []; let wire = false;
      const mapped = historyResultBytes(result, (bytes, maximum) => {
        if (types.isUint8Array(bytes)) { buffers.push(null); return bytes; }
        buffers.push(verifiedBuffer(bytes, maximum)); wire = true; return metadataBytes;
      });
      if (!wire || !isPlaybackHistoryReply(mapped)) return value;
      const logical = replace(value, 'result', mapped);
      historyReplies.set(mapped, buffers); historyReplyValues.add(mapped); return logical;
    }
    if (data(result, 'kind') !== 'sealed') return value;
    const wire = data(result, 'sealed');
    if (types.isUint8Array(wire)) return value;
    verifiedBuffer(wire);
    const logicalResult = replace(result, 'sealed', metadataBytes);
    // 此处只做shape资格；原handler仍在capture前核真实pending/dataset/epoch/关闭状态。
    const request = { kind: 'load' as const, datasetId: data(logicalResult, 'datasetId') as string };
    if (!isMobileOwnerPrivateResult(logicalResult, request)) return value;
    const logical = replace(value, 'result', logicalResult);
    if (kind === 'core') {
      const call = { type: 'mobile-main-request' as const, id: data(logical, 'id') as string, request };
      if (!isMobileCorePrivateCall(call) || !isMobileCorePrivateReply(logical, call)) return value;
    }
    awaitingReplyCapture.set(logicalResult, wire); replyPortValues.add(logicalResult);
    return logical;
  } catch { return value; }
}
/** 只能在实际listener同步消费一次；原metadata与真正request的完整guard由调用者先后保留。 */
export function captureMobileSealedReplyFromPort(value: object): object | null {
  if (historyReplyValues.has(value)) {
    const buffers = historyReplies.get(value); historyReplies.delete(value);
    if (!buffers) return invalid();
    let index = 0;
    const result = historyResultBytes(value, bytes => {
      if (index >= buffers.length) return invalid();
      return ownedBuffer(buffers[index++]!, bytes);
    });
    if (index !== buffers.length) return invalid();
    return result;
  }
  if (!replyPortValues.has(value)) return null;
  const wire = awaitingReplyCapture.get(value); awaitingReplyCapture.delete(value);
  if (wire === undefined) return invalid();
  const buffer = verifiedBuffer(wire), length = Reflect.apply(bufferLength, buffer, []) as number;
  const owned = allocateOwnedSealedBytes(length);
  Reflect.apply(nativeSet, owned, [new Uint8Array(buffer)]);
  return replace(value, 'sealed', owned);
}
function clearReply(value: unknown): void {
  try {
    const result = data(value, 'result');
    if (result && typeof result === 'object') { awaitingReplyCapture.delete(result); historyReplies.delete(result); }
  } catch { /* 未登记的非reply消息不参与新路径。 */ }
}
/** 只连接原Owner Worker出站listener；不持久保存raw对象或底层buffer。 */
export function attachMobileSealedOwnerReplyReceiver(port: OwnerPort, listener: (value: unknown) => void): () => void {
  const receive = (value: unknown) => {
    const logical = decodeReply(value, 'owner');
    try { listener(logical); } finally { clearReply(logical); }
  };
  port.on('message', receive);
  return () => port.off('message', receive);
}
/** 只连接原Main私有Core端口；原attempt/current和pending验证仍在原handler。 */
export function attachMobileSealedCoreReplyReceiver(port: CorePort, listener: (event: { data: unknown }) => void): void {
  port.on('message', event => {
    const logical = decodeReply(event.data, 'core');
    try { listener(logical === event.data ? event : { data: logical }); }
    finally { clearReply(logical); }
  });
}
