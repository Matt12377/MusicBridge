/** Main与资料库Owner共用同一图片预算与Rust处理入口，避免两边重复解码。 */
export { normalizeLocalArtwork, normalizeLocalArtworkInWorker, readLocalArtworkFile, LocalArtworkImageError } from '../../../../packages/bridge-core/src/library/artwork-image.js'
export type { NormalizedLocalArtwork } from '../../../../packages/bridge-core/src/library/artwork-image.js'
