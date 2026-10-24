import { isCollectionId, isLocalAlbumArtworkRequest, type LocalAlbumArtworkRequest } from '@music-bridge/contracts'
import { Buffer } from 'node:buffer'

/** 仅Owner后台队列调用；没有query/filter或封面状态，不是LocalAlbumPage，也不进入IPC。 */
export interface LocalAlbumBackgroundCandidateQuery { rootId: string; offset: number; limit: number }
export interface LocalAlbumBackgroundCandidatePage extends LocalAlbumBackgroundCandidateQuery {
  total: number; hasMore: boolean; items: readonly LocalAlbumArtworkRequest[]
}
export const LOCAL_ALBUM_BACKGROUND_CANDIDATE_BYTES = 64 * 1024
const closed = (value: unknown, names: readonly string[]): value is Record<string, unknown> => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).length === names.length
  && names.every(name => { const descriptor = Object.getOwnPropertyDescriptor(value, name); return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value') })
const natural = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
export function isLocalAlbumBackgroundCandidateQuery(value: unknown): value is LocalAlbumBackgroundCandidateQuery {
  return closed(value, ['rootId','offset','limit']) && isCollectionId(value.rootId) && natural(value.offset)
    && natural(value.limit) && value.limit >= 1 && value.limit <= 50
}
export function isLocalAlbumBackgroundCandidatePage(value: unknown, request: LocalAlbumBackgroundCandidateQuery): value is LocalAlbumBackgroundCandidatePage {
  if (!isLocalAlbumBackgroundCandidateQuery(request) || !closed(value, ['rootId','offset','limit','total','hasMore','items']) || value.rootId !== request.rootId || value.offset !== request.offset
    || value.limit !== request.limit || !natural(value.total) || !Array.isArray(value.items) || Object.getPrototypeOf(value.items) !== Array.prototype
    || value.items.length !== Math.min(request.limit, Math.max(0, value.total - request.offset))
    || value.hasMore !== (request.offset + value.items.length < value.total)) return false
  const items = value.items
  if (Reflect.ownKeys(items).length !== items.length + 1
    || !Reflect.ownKeys(items).every(key => key === 'length' || typeof key === 'string' && /^(0|[1-9][0-9]*)$/u.test(key)
      && Number(key) < items.length && Object.getOwnPropertyDescriptor(items, key)?.enumerable === true
      && Object.hasOwn(Object.getOwnPropertyDescriptor(items, key)!, 'value'))
    || !items.every((item, index) => Object.hasOwn(items, index)
    && closed(item, ['albumKey','rootId','editionId','representativeTrackId','revision']) && isLocalAlbumArtworkRequest(item) && item.rootId === request.rootId)
    || new Set(items.map(item => item.albumKey)).size !== items.length) return false
  try { return Buffer.byteLength(JSON.stringify(value)) <= LOCAL_ALBUM_BACKGROUND_CANDIDATE_BYTES } catch { return false }
}
