import { types } from 'node:util';
import { isDatasetOwnerRequest, type DatasetOwnerRequest } from '../collection/dataset-owner-protocol.js';
import {
  isMobileCorePrivateCall, isMobileCorePrivateReply, isMobileOwnerPrivateResult,
  type MobileCorePrivateCall, type MobileCorePrivateReply,
} from './owner-protocol.js';
import { allocateOwnedSealedBytes } from './owned-sealed-bytes.js';
import type { MobileOwnerPrivateRequest, MobileOwnerPrivateResult, MobileSealedSave } from './types.js';

const typedArray = Object.getPrototypeOf(Uint8Array.prototype) as object;
const byteLength = Object.getOwnPropertyDescriptor(typedArray, 'byteLength')!.get!;
const setBytes = Uint8Array.prototype.set;

function data(value: object, key: PropertyKey): unknown {
  if (types.isProxy(value)) throw new Error('移动私有捕获不接受代理。');
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('移动私有捕获必须使用数据字段。');
  return descriptor.value;
}
function replaceData<T extends object, K extends keyof T>(value: T, key: K, replacement: T[K]): T {
  data(value, key);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  // 保留全部原字段与描述符，绝不通过重建闭集来清洗原输入的额外字段。
  descriptors[key] = { ...descriptors[key], value: replacement };
  return Object.create(Object.getPrototypeOf(value), descriptors) as T;
}
/** 仅下面完整guard已通过的同步分支可调用；不登记原对象，也不跨await借用其存储。 */
function copySealed(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const length = Reflect.apply(byteLength, value, []) as number;
  const copy = allocateOwnedSealedBytes(length);
  Reflect.apply(setBytes, copy, [value]);
  return copy;
}
function capturedRequest(value: MobileOwnerPrivateRequest): MobileOwnerPrivateRequest {
  const kind = data(value, 'kind');
  if (kind !== 'save' && kind !== 'playback-save') return value;
  const save = value as Extract<MobileOwnerPrivateRequest, { kind: 'save' | 'playback-save' }>;
  const request = data(save, 'request') as MobileSealedSave;
  const captured = replaceData(request, 'sealed', copySealed(data(request, 'sealed') as Uint8Array));
  return replaceData(save, 'request', captured);
}
function capturedResult(value: MobileOwnerPrivateResult, request: MobileOwnerPrivateRequest): MobileOwnerPrivateResult {
  if ((request.kind === 'load' || request.kind === 'playback-load') && data(value, 'kind') === 'sealed') {
    const sealed = value as Extract<MobileOwnerPrivateResult, { kind: 'sealed' }>;
    return replaceData(sealed, 'sealed', copySealed(data(sealed, 'sealed') as Uint8Array));
  }
  return value;
}

interface GuardedBoundary<T> { readonly value: T; capture(): T }
function boundary<T>(value: T, copy: (value: T) => T): GuardedBoundary<T> {
  let consumed = false;
  return Object.freeze({ value, capture() {
    if (consumed) throw new Error('移动私有捕获只能消费一次。');
    consumed = true;
    return copy(value);
  } });
}
/** 只供当前同步入站控制流使用；先核原信封，再经原准入检查，期间不得await。 */
export function readMobileCorePrivateCallForCapture(value: unknown): GuardedBoundary<MobileCorePrivateCall> | null {
  try {
    if (types.isProxy(value) || !isMobileCorePrivateCall(value)) return null;
    return boundary(value, call => replaceData(call, 'request', capturedRequest(data(call, 'request') as MobileOwnerPrivateRequest)));
  } catch { return null; }
}
/** Owner的原epoch/sequence/boot/dataset检查先于capture；原字节不登记资格。 */
export function readDatasetOwnerRequestForCapture(value: unknown): GuardedBoundary<DatasetOwnerRequest> | null {
  try {
    if (types.isProxy(value) || !isDatasetOwnerRequest(value)) return null;
    return boundary(value, request => data(request, 'operation') !== 'mobileMain' ? request
      : replaceData(request, 'mobile', capturedRequest(data(request, 'mobile') as MobileOwnerPrivateRequest)));
  } catch { return null; }
}

/** Main→Core：先校验原完整消息，再取得本进程独占的密文字节。 */
export function captureMobileCorePrivateCall(value: unknown): MobileCorePrivateCall | null {
  try { return readMobileCorePrivateCallForCapture(value)?.capture() ?? null; } catch { return null; }
}
/** Core→Owner：保留原Owner完整envelope、scope及mobile检查，不跳过真实入站边界。 */
export function captureDatasetOwnerRequest(value: unknown): DatasetOwnerRequest | null {
  try { return readDatasetOwnerRequestForCapture(value)?.capture() ?? null; } catch { return null; }
}
/** Owner→Core：调用者仍先核原Owner envelope/epoch/request，再完整校验本结果。 */
export function captureMobileOwnerPrivateResult(value: unknown, request: MobileOwnerPrivateRequest): MobileOwnerPrivateResult | null {
  try {
    if (types.isProxy(value) || !isMobileOwnerPrivateResult(value, request)) return null;
    return capturedResult(value, request);
  } catch { return null; }
}
/** Core→Main：先核完整原回复及原call身份，品牌只属于随后新分配的本地副本。 */
export function captureMobileCorePrivateReply(value: unknown, call: MobileCorePrivateCall): MobileCorePrivateReply | null {
  try {
    if (types.isProxy(value) || !isMobileCorePrivateReply(value, call)) return null;
    return replaceData(value, 'result', capturedResult(data(value, 'result') as MobileOwnerPrivateResult, call.request));
  } catch { return null; }
}
