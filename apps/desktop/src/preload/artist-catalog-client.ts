import * as dto from '@music-bridge/contracts'
import type { DatasetScope } from './command-outbox-client.js'

type Api = dto.ArtistSearchCatalogPublicApi
type Operation = keyof Api
const invalid = (): never => { throw new Error('[INVALID_IPC_REQUEST] 艺术家或搜索请求与回包无效，请重新读取。') }
const safeFailureCodes = new Set(['AUTH_REQUIRED', 'AUTH_EXPIRED', 'NOT_READY', 'ARTIST_INDEX_PREPARING', 'SOURCE_CHANGED', 'OUTBOX_SCOPE_MISMATCH', 'SNAPSHOT_CHANGED', 'INVALID_IPC_REQUEST', 'INVENTORY_CONFLICT', 'ROON_ZONE_NOT_SELECTED', 'ROON_CORE_NOT_CONNECTED', 'LOCAL_PLAY_REJECTED', 'TIMEOUT', 'CANCELLED', 'ARTIST_CATALOG_UNAVAILABLE'])
const text = (value: unknown, maximum = 256): value is string => typeof value === 'string' && [...value].length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value)
function closed(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && required.every(key => Object.hasOwn(value, key)) && Reflect.ownKeys(value).every(key => typeof key === 'string' && [...required, ...optional].includes(key)
      && Object.getOwnPropertyDescriptor(value, key)?.enumerable && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))
}
function artistBase(value: dto.ArtistCatalogArtist): dto.LocalArtistSummary {
  return { id: value.id, name: value.name, source: value.source, albumCount: value.albumCount, trackCount: value.trackCount,
    ...(Object.hasOwn(value, 'artworkId') ? { artworkId: value.artworkId! } : {}), ...(Object.hasOwn(value, 'linkedNeteaseId') ? { linkedNeteaseId: value.linkedNeteaseId! } : {}) }
}
const denseArray = (value: unknown): value is unknown[] => Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
  && Reflect.ownKeys(value).length === value.length + 1 && Reflect.ownKeys(value).every(key => key === 'length' || typeof key === 'string'
    && /^(0|[1-9][0-9]*)$/u.test(key) && Number(key) < value.length && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))
function artistValid(value: unknown): value is dto.ArtistCatalogArtist {
  if (!closed(value, ['id', 'name', 'source', 'albumCount', 'trackCount'], ['artworkId', 'linkedNeteaseId', 'artworkUrl', 'biography', 'credit', 'linkState'])) return false
  if (!dto.isLocalArtistSummary(artistBase(value as unknown as dto.ArtistCatalogArtist))) return false
  if (value.biography !== undefined && (typeof value.biography !== 'string' || value.biography.length > 20000)
    || value.credit !== undefined && !text(value.credit, 512)
    || value.linkState !== undefined && !['automatic', 'manual', 'unlinked'].includes(String(value.linkState))) return false
  if (value.artworkUrl !== undefined) {
    if (typeof value.artworkUrl !== 'string' || value.artworkUrl.length > 4096) return false
    try { const url = new URL(value.artworkUrl); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false } catch { return false }
  }
  return true
}
function artistPageValid(value: unknown): value is dto.ArtistCatalogPage {
  return closed(value, ['query', 'offset', 'limit', 'total', 'hasMore', 'revision', 'items']) && Array.isArray(value.items) && value.items.every(artistValid)
    && dto.isLocalArtistPage({ ...value, items: value.items.map(artistBase) })
}
function payloadValid(operation: Operation, value: unknown): boolean {
  if (operation === 'listArtists' || operation === 'search') return dto.isArtistQuery(value)
  if (operation === 'listArtistAlbums') return dto.isLocalArtistAlbumsQuery(value)
  if (operation === 'listArtistTracks') return dto.isLocalArtistTracksQuery(value)
  if (operation === 'suggest') return closed(value, ['query']) && text(value.query)
  if (operation === 'getArtist') return closed(value, ['artistId']) && dto.isLocalArtistId(value.artistId)
  if (operation === 'artistMatches') return closed(value, ['artistId'], ['query']) && dto.isLocalArtistId(value.artistId) && (value.query === undefined || text(value.query))
  if (operation === 'bindArtist') return closed(value, ['artistId', 'neteaseArtistId']) && dto.isLocalArtistId(value.artistId)
    && (value.neteaseArtistId === null || typeof value.neteaseArtistId === 'string' && /^[1-9][0-9]{0,19}$/u.test(value.neteaseArtistId))
  return closed(value, ['requestId', 'context', 'startTrackId', 'target', 'action']) && text(value.requestId) && value.requestId.length > 0
    && dto.isLocalSearchPlayContext(value.context) && dto.isCollectionId(value.startTrackId) && dto.isLocalPlayTarget(value.target)
    && (dto.LOCAL_PLAY_ACTIONS as readonly unknown[]).includes(value.action)
}
function resultValid(operation: Operation, value: unknown, payload: Record<string, unknown>): boolean {
  if (operation === 'getArtist' || operation === 'bindArtist') return artistValid(value) && value.source === 'local' && value.id === payload.artistId
  if (operation === 'artistMatches') return denseArray(value) && value.length <= 200 && value.every(item => artistValid(item) && item.source === 'netease' && /^[1-9][0-9]{0,19}$/u.test(item.id))
  if (operation === 'suggest') return closed(value, ['keywords']) && denseArray(value.keywords) && value.keywords.length <= 10 && value.keywords.every(keyword => text(keyword, 200) && keyword.trim())
  if (operation === 'playLocalSelection') return dto.isLocalSourceUnsupported(value) || dto.isLocalPlayAccepted(value) && value.request_id === payload.requestId && value.action === payload.action
  if (operation === 'listArtists') return artistPageValid(value) && value.query === payload.query && value.offset === payload.offset && value.limit === payload.limit
  if (operation === 'listArtistAlbums') return dto.isLocalArtistAlbumsPage(value) && value.artistId === payload.artistId && value.relation === payload.relation && value.offset === payload.offset && value.limit === payload.limit
  if (operation === 'listArtistTracks') return dto.isLocalArtistTracksPage(value) && value.artistId === payload.artistId && value.offset === payload.offset && value.limit === payload.limit
  if (!closed(value, ['query', 'revision', 'artists', 'albums', 'tracks']) || !artistPageValid(value.artists)) return false
  return dto.isLocalArtistSearchResult({ ...value, artists: { ...value.artists, items: value.artists.items.map(artistBase) } })
    && value.query === payload.query && [value.artists, value.albums, value.tracks].every(page => !!page && typeof page === 'object'
      && (page as { offset: unknown }).offset === payload.offset && (page as { limit: unknown }).limit === payload.limit)
}
function notSentReply(value: unknown, datasetId: string, payload: Record<string, unknown>): value is { code: string } {
  return closed(value, ['ok', 'datasetId', 'requestId', 'action', 'code', 'outcome']) && value.ok === false && value.outcome === 'not-sent'
    && value.datasetId === datasetId && value.requestId === payload.requestId && value.action === payload.action
    && typeof value.code === 'string' && safeFailureCodes.has(value.code)
}
function notSentFailure(code: string): Error {
  return Object.assign(new Error(`[${code}] 播放请求尚未发送，请核对当前资料后重新选择歌曲。`), { code, outcome: 'not-sent' as const })
}

/** 同一数据集的专用接口；原payload与返回scope分别校验，不在失败后重放invoke。 */
export function createArtistCatalogClient(invoke: (channel: string, value: unknown) => Promise<unknown>, scope: DatasetScope): Api {
  async function request<K extends Operation>(operation: K, payload: Parameters<Api[K]>[0]): Promise<Awaited<ReturnType<Api[K]>>> {
    let invoked = false, confirmedNotSent = false
    try {
      if (!payloadValid(operation, payload)) return invalid()
      const copied = structuredClone(payload)
      const datasetId = await scope()
      if (!dto.isCommandOutboxDatasetId(datasetId)) return invalid()
      invoked = true
      const result = await invoke('artistCatalog:request', { datasetId, operation, payload: copied })
      const notSent = operation === 'playLocalSelection' && notSentReply(result, datasetId, copied as unknown as Record<string, unknown>)
      confirmedNotSent = notSent
      try {
        if (await scope() !== datasetId) throw new Error('[SOURCE_CHANGED] 当前音乐库已改变，请重新读取。')
      } catch (error) { if (notSent) throw notSentFailure('SOURCE_CHANGED'); throw error }
      if (notSent) throw notSentFailure((result as { code: string }).code)
      if (!resultValid(operation, result, copied as unknown as Record<string, unknown>)) return invalid()
      return result as Awaited<ReturnType<Api[K]>>
    } catch (error) {
      if (operation === 'playLocalSelection' && !invoked) {
        const original = error instanceof Error ? error : new Error('[INVALID_IPC_REQUEST] 播放准备尚未完成。')
        throw Object.assign(original, { outcome: 'not-sent' as const })
      }
      if (operation === 'playLocalSelection' && !confirmedNotSent && error && typeof error === 'object' && Object.getOwnPropertyDescriptor(error, 'outcome')?.value === 'not-sent') {
        // 只有原闭集回执能证明Main未派发；传输异常上的自定义属性不是证据。
        throw new Error(error instanceof Error ? error.message : '[ARTIST_CATALOG_UNAVAILABLE] 原播放结果尚未确认。')
      }
      throw error
    }
  }
  return { listArtists: value => request('listArtists', value), getArtist: value => request('getArtist', value), listArtistAlbums: value => request('listArtistAlbums', value),
    listArtistTracks: value => request('listArtistTracks', value), search: value => request('search', value), suggest: value => request('suggest', value),
    artistMatches: value => request('artistMatches', value), bindArtist: value => request('bindArtist', value), playLocalSelection: value => request('playLocalSelection', value) }
}
