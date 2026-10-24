import { GRID_ARTWORK_DECODED_BYTES } from './grid-artwork-cache.js'
import type { LocalAlbumArtworkState } from './types.js'

/** 整个兴趣窗口一起选择展示路径，避免持久图与旧缩图缓存各自领取一份解码预算。 */
export function canDisplayPersistentGridArtwork(images: readonly LocalAlbumArtworkState[]): boolean {
  let decodedBytes = 0, hasReadyImage = false
  for (const image of images) {
    if (image.status !== 'ready' || !image.dataUrl) continue
    const grid = image.grid
    if (!grid || ![grid.width, grid.height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 512)) return false
    hasReadyImage = true
    decodedBytes += grid.width * grid.height * 4
    if (decodedBytes > GRID_ARTWORK_DECODED_BYTES) return false
  }
  return hasReadyImage
}
