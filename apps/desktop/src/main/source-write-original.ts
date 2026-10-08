import { types } from 'node:util'
import { LOCAL_ARTWORK_INPUT_BYTES } from '@music-bridge/contracts'

const typedArray = Object.getPrototypeOf(Uint8Array.prototype) as object
const byteLength = Object.getOwnPropertyDescriptor(typedArray, 'byteLength')!.get!
const backing = Object.getOwnPropertyDescriptor(typedArray, 'buffer')!.get!
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get

export class SourceWriteOriginalError extends Error {
  readonly code = 'SOURCE_MATERIAL_UNAVAILABLE'
  constructor() { super('原图暂时无法留存；MB 封面选择仍可保存。') }
}

/** 只复制真实图像视图；传输不携带池内其他字节、共享内存或可调整的缓冲区。 */
export function captureSourceWriteOriginal(value: unknown): Uint8Array {
  try {
    if (types.isProxy(value) || !types.isUint8Array(value)) throw new SourceWriteOriginalError()
    const size = Reflect.apply(byteLength, value, []) as number
    const buffer = Reflect.apply(backing, value, []) as ArrayBuffer
    if (!Number.isSafeInteger(size) || size < 4 || size > LOCAL_ARTWORK_INPUT_BYTES
      || !types.isArrayBuffer(buffer) || resizable && Reflect.apply(resizable, buffer, [])) throw new SourceWriteOriginalError()
    const owned = new Uint8Array(size)
    Reflect.apply(Uint8Array.prototype.set, owned, [value])
    return owned
  } catch { throw new SourceWriteOriginalError() }
}
