import { types } from 'node:util';
import { MOBILE_AUTH_SEALED_MAX_BYTES, MobileAuthPersistenceError } from './types.js';

const NativeBytes = Uint8Array, owned = new WeakSet<object>();
const typedArray = Object.getPrototypeOf(NativeBytes.prototype) as object;
const byteLength = Object.getOwnPropertyDescriptor(typedArray, 'byteLength')!.get!;
const byteBuffer = Object.getOwnPropertyDescriptor(typedArray, 'buffer')!.get!;
/** 只按长度自分配，不接受raw、品牌字段、生产回调或任意对象登记。 */
export function allocateOwnedSealedBytes(length: number): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(length) || length < 1 || length > MOBILE_AUTH_SEALED_MAX_BYTES) throw new MobileAuthPersistenceError('not-sent');
  const value = new NativeBytes(length);
  // 在暴露前固定原生索引形状；数据仍可填充、复制及清零。
  Object.preventExtensions(value); owned.add(value); return value;
}
/** 本realm的结构证明，绝不代表授权或字节内容不可变；每次重核原生存储和预算。 */
export function ownedSealedByteLength(value: unknown, maximum: number): number | null {
  try {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MOBILE_AUTH_SEALED_MAX_BYTES
      || value === null || typeof value !== 'object' || !owned.has(value) || types.isProxy(value)
      || Object.getPrototypeOf(value) !== NativeBytes.prototype || Object.isExtensible(value)) return null;
    const length = Reflect.apply(byteLength, value, []) as number, buffer = Reflect.apply(byteBuffer, value, []) as unknown;
    return Number.isSafeInteger(length) && length > 0 && length <= maximum && types.isArrayBuffer(buffer) ? length : null;
  } catch { return null; }
}
