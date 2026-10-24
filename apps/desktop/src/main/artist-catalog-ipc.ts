import * as dto from '@music-bridge/contracts'
import type { ArtistCatalogService } from './artist-catalog-service.js'

const operations = ['listArtists', 'getArtist', 'listArtistAlbums', 'listArtistTracks', 'search', 'suggest', 'artistMatches', 'bindArtist', 'playLocalSelection'] as const
type Operation = typeof operations[number]
const text = (value: unknown, maximum = 256): value is string => typeof value === 'string' && [...value].length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value)
function closed(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && required.every(key => Object.hasOwn(value, key)) && Reflect.ownKeys(value).every(key => typeof key === 'string' && [...required, ...optional].includes(key)
      && Object.getOwnPropertyDescriptor(value, key)?.enumerable && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))
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
function safeError(error: unknown): Error & { code: string } {
  const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined
  const messages: Record<string, string> = {
    AUTH_REQUIRED: '请先登录音乐服务。', AUTH_EXPIRED: '音乐服务登录已过期，请重新登录。',
    NOT_READY: '音乐库尚未就绪，请稍后重新读取。', SOURCE_CHANGED: '当前音乐库或资料已经变化，请重新读取。',
    ARTIST_INDEX_PREPARING: '正在准备本地艺术家与搜索，可继续使用其他页面。',
    OUTBOX_SCOPE_MISMATCH: '当前音乐库已经变化，请重新读取。', SNAPSHOT_CHANGED: '歌曲集合已经变化，请重新读取。',
    INVALID_IPC_REQUEST: '艺术家或搜索请求无效，请重新读取。', INVENTORY_CONFLICT: '原音乐库状态或集合范围已改变，请重新选择。',
    ROON_ZONE_NOT_SELECTED: '请先选择 Roon 播放目标。', ROON_CORE_NOT_CONNECTED: 'Roon Core 尚未连接。',
    LOCAL_PLAY_REJECTED: '原本地点播请求未受理，请核对歌曲和播放目标。',
    TIMEOUT: '艺术家或搜索读取超时，请重试。', CANCELLED: '本次艺术家读取已取消。',
    ARTIST_CATALOG_UNAVAILABLE: '艺术家资料暂时不可用，原本地音乐与关联保留。',
  }
  const selected = typeof code === 'string' && Object.hasOwn(messages, code) ? code : 'ARTIST_CATALOG_UNAVAILABLE'
  return Object.assign(new Error(`[${selected}] ${messages[selected]}`), { code: selected })
}

/** 一个固定操作闭集；没有通用Core命令、文件路径或任意Provider转发。 */
export function installArtistCatalogHandlers<E>(options: {
  handle(channel: string, handler: (event: E, value?: unknown) => unknown): void
  requireTrusted(event: E): void
  service: ArtistCatalogService
}): void {
  options.handle('artistCatalog:request', async (event, raw) => {
    options.requireTrusted(event)
    if (!closed(raw, ['datasetId', 'operation', 'payload']) || !dto.isCommandOutboxDatasetId(raw.datasetId)
      || typeof raw.operation !== 'string' || !(operations as readonly string[]).includes(raw.operation)
      || !payloadValid(raw.operation as Operation, raw.payload)) throw new Error('[INVALID_IPC_REQUEST] 艺术家或搜索请求无效。')
    const value = structuredClone(raw), operation = value.operation as Operation
    let invoked = false
    try {
      const api = options.service.forDataset(value.datasetId as string)
      invoked = true
      return await (api[operation] as (payload: never) => Promise<unknown>)(value.payload as never)
    } catch (error) {
      const safe = safeError(error), outcome = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'outcome')?.value : undefined
      if (operation === 'playLocalSelection' && (!invoked || outcome === 'not-sent')) {
        const payload = value.payload as unknown as dto.ArtistCatalogPlayRequest
        return { ok: false, datasetId: value.datasetId, requestId: payload.requestId, action: payload.action, code: safe.code, outcome: 'not-sent' }
      }
      throw safe
    }
  })
}
