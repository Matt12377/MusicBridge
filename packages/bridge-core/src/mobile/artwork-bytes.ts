import { types } from 'node:util';
import { MobileServiceError } from './types.js';

export const MOBILE_ARTWORK_INPUT_MAX_BYTES = 4 * 1024 * 1024;
const owned = new WeakSet<object>(), native = Uint8Array;
const prototype = Object.getPrototypeOf(native.prototype) as object;
const lengthOf = Object.getOwnPropertyDescriptor(prototype, 'byteLength')!.get!;
const bufferOf = Object.getOwnPropertyDescriptor(prototype, 'buffer')!.get!;
/** 专用图片二进制边界；只给本次自分配副本资格，不改变任何通用guard。 */
export function captureMobileArtworkBytes(raw: unknown): Uint8Array<ArrayBuffer> {
  try {
    if (types.isProxy(raw) || !(raw instanceof native) || Object.getPrototypeOf(raw) !== native.prototype) throw 0;
    const length = Reflect.apply(lengthOf, raw, []) as number, buffer = Reflect.apply(bufferOf, raw, []) as unknown;
    if (!Number.isSafeInteger(length) || length < 8 || length > MOBILE_ARTWORK_INPUT_MAX_BYTES || !types.isArrayBuffer(buffer)) throw 0;
    if (owned.has(raw) && !Object.isExtensible(raw)) return raw as Uint8Array<ArrayBuffer>;
    // 原生非Shared typed-array每个有效索引均为不可删除的自有键；多一个符号/隐藏属性也拒绝。
    if (Reflect.ownKeys(raw).length !== length) throw 0;
    const copy = new native(length); Object.preventExtensions(copy); native.prototype.set.call(copy, raw); owned.add(copy);
    return copy;
  } catch { throw new MobileServiceError(503, 'BUSY'); }
}
