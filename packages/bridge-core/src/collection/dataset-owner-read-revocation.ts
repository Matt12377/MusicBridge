import { types } from 'node:util'
import { LocalAlbumReadError } from './local-album-browser/grouping.js'

export const DATASET_OWNER_READ_REVOCATION_BYTES = Int32Array.BYTES_PER_ELEMENT

/** 仅可信组合层共享的单向撤销闩；不代表任务结束、FD静止或Source许可。 */
export function isDatasetOwnerReadRevocationBuffer(value: unknown): value is SharedArrayBuffer {
  return types.isSharedArrayBuffer(value) && value.byteLength === DATASET_OWNER_READ_REVOCATION_BYTES
    && Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'growable')?.get?.call(value) !== true
}

export function createDatasetOwnerReadRevocation(buffer = new SharedArrayBuffer(DATASET_OWNER_READ_REVOCATION_BYTES)) {
  if (!isDatasetOwnerReadRevocationBuffer(buffer)) throw new Error('专辑读取撤销闩身份无效。')
  const state = new Int32Array(buffer)
  return Object.freeze({
    buffer,
    revoke(): void { Atomics.store(state, 0, 1) },
    assertActive(): void {
      if (Atomics.load(state, 0) !== 0) throw new LocalAlbumReadError('UNAVAILABLE', '专辑读取已撤销，正在等待原资源关闭。')
    },
  })
}
