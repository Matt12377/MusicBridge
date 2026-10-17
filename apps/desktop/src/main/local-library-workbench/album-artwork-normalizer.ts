import * as dto from '@music-bridge/contracts'
import type { PhotoDecoderImage } from '../collection-photos.js'
import { LocalArtworkImageError } from '../local-artwork-image.js'
import { normalizeImportedLocalArtwork, type LocalArtworkImportNormalizer, type LocalArtworkNormalizationContext } from './artwork-import-normalizer.js'

export interface LocalAlbumArtworkNormalizationResult { image: dto.LocalArtworkImage | null; status: 'ready' | 'source-unavailable' }
const isSourceCopies = (value: unknown): value is dto.LocalArtworkSourceCopies => dto.isLocalArtworkCommandResult('localArtwork.readCandidates', value)

/** 原只读来源副本经过 Main 真实解码；不暂存候选、不创建发行、不改变手选封面。 */
export function createLocalAlbumArtworkNormalizer(decode: (bytes: Uint8Array) => PhotoDecoderImage, normalizer?: Pick<LocalArtworkImportNormalizer, 'normalize'>) {
  return async (copies: unknown, context?: LocalArtworkNormalizationContext): Promise<LocalAlbumArtworkNormalizationResult> => {
    const current = async (): Promise<void> => {
      if (!context) {
        if (normalizer) throw new Error('专辑封面异步解码缺少原读取上下文。')
        return
      }
      if (context.signal.aborted || !Number.isFinite(context.deadlineAtMs) || performance.now() >= context.deadlineAtMs) {
        const error = new Error('专辑封面原读取期限已到。'); error.name = 'AbortError'; throw error
      }
      await context.assertCurrent?.()
      if (context.signal.aborted || performance.now() >= context.deadlineAtMs) {
        const error = new Error('专辑封面原读取期限已到。'); error.name = 'AbortError'; throw error
      }
    }
    await current()
    if (!isSourceCopies(copies)) throw new Error('专辑封面只读副本无效。')
    if (copies.status === 'source-unavailable') return { image: null, status: 'source-unavailable' }
    if (!copies.items.length) return { image: null, status: 'ready' }
    let total = 0
    const inputs = copies.items.map(item => {
      const bytes = Buffer.from(item.base64, 'base64')
      if (!bytes.length || bytes.toString('base64') !== item.base64 || bytes.length > dto.LOCAL_ARTWORK_INPUT_BYTES
        || (total += bytes.length) > 8 * 1024 * 1024) throw new Error('专辑封面只读字节超过预算或编码无效。')
      return bytes
    })
    for (const bytes of inputs) {
      try {
        await current()
        const image = (normalizer && context ? await normalizer.normalize(bytes, context) : normalizeImportedLocalArtwork(bytes, decode)).image
        await current()
        if (!dto.isLocalArtworkImage(image)) throw new Error('封面展示副本无效。')
        return { image, status: 'ready' }
      } catch (error) {
        if (!(error instanceof LocalArtworkImageError)) throw error
        await current()
      }
    }
    throw new Error('来源中有图片，但未能生成可用封面；请选择另一张图片。')
  }
}
