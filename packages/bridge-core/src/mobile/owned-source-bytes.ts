import { types } from 'node:util';

const NativeBytes = Uint8Array, owned = new WeakSet<object>(), maximumBytes = 64 * 1024;
const typedArray = Object.getPrototypeOf(NativeBytes.prototype) as object;
const byteLength = Object.getOwnPropertyDescriptor(typedArray, 'byteLength')!.get!;
const byteBuffer = Object.getOwnPropertyDescriptor(typedArray, 'buffer')!.get!;
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')!.get!;
const detached = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'detached')!.get!;

/** 只分配原64KiB预算内的新存储；不接受raw、外部buffer或品牌登记。 */
export function allocateOwnedSourceBytes(length: number): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(length) || length < 0 || length > maximumBytes) throw new RangeError('媒体块超过原64KiB预算。');
  const value = new NativeBytes(length);
  Object.preventExtensions(value); owned.add(value); return value;
}

/** 只证明本realm自分配的索引形状；内容可变，不能代表内容身份、授权或水位。 */
export function ownedSourceByteLength(value: unknown, maximum: number): number | null {
  try {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > maximumBytes
      || !value || typeof value !== 'object' || !owned.has(value) || types.isProxy(value)
      || Object.getPrototypeOf(value) !== NativeBytes.prototype || Object.isExtensible(value)) return null;
    const length = Reflect.apply(byteLength, value, []) as number, buffer = Reflect.apply(byteBuffer, value, []) as unknown;
    // 真空buffer合法；transfer后的零长度不能冒充EOF，也不跨resize保留资格。
    if (!types.isArrayBuffer(buffer) || Reflect.apply(resizable, buffer, []) !== false
      || Reflect.apply(detached, buffer, []) !== false) return null;
    return Number.isSafeInteger(length) && length >= 0 && length <= maximum ? length : null;
  } catch { return null; }
}
