import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, lstat, open, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import * as dto from '@music-bridge/contracts'
import type { CoreSupervisor } from './core-supervisor.js'

interface Binding { mode: 'automatic' | 'manual' | 'unlinked'; remoteId: string | null }
interface StoredProfile { profile: dto.NeteaseArtistProfile; fetchedAtMs: number }
interface State { schema: 1; datasetId: string; bindings: Record<string, Binding>; profiles: Record<string, StoredProfile> }
interface DatasetCache { state: State; write: Promise<void> }
export interface ArtistCatalogService {
  forDataset(datasetId: string): dto.ArtistSearchCatalogPublicApi
  close(): Promise<void>
}
const MAX_CACHE_BYTES = 8 * 1024 * 1024, MAX_PROFILES = 512, MAX_BINDINGS = 10000
const normalized = (value: string): string => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase()
const remoteId = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,19}$/u.test(value)
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const text = (value: unknown, maximum = 256): value is string => typeof value === 'string' && [...value].length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value)
function closed(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  return record(value) && required.every(key => Object.hasOwn(value, key)) && Reflect.ownKeys(value).every(key => typeof key === 'string'
    && [...required, ...optional].includes(key) && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))
}
function failure(code: string, message: string): never { throw Object.assign(new Error(`[${code}] ${message}`), { code }) }
function validProfile(value: unknown): value is dto.NeteaseArtistProfile {
  if (!closed(value, ['id', 'name', 'albumCount', 'trackCount', 'biography'], ['artworkUrl']) || !remoteId(value.id) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 512
    || typeof value.biography !== 'string' || value.biography.length > 20000
    || ![value.albumCount, value.trackCount].every(count => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)) return false
  if (Object.hasOwn(value, 'artworkUrl')) { if (typeof value.artworkUrl !== 'string') return false; try { const url = new URL(value.artworkUrl); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || value.artworkUrl.length > 4096) return false } catch { return false } }
  return true
}
function validState(value: unknown, datasetId: string): value is State {
  if (!closed(value, ['schema', 'datasetId', 'bindings', 'profiles']) || value.schema !== 1 || value.datasetId !== datasetId || !record(value.bindings) || !record(value.profiles)
    || Object.keys(value.bindings).length > MAX_BINDINGS || Object.keys(value.profiles).length > MAX_PROFILES) return false
  return Object.entries(value.bindings).every(([id, binding]) => dto.isLocalArtistId(id) && closed(binding, ['mode', 'remoteId'])
    && (binding.mode === 'unlinked' ? binding.remoteId === null : ['automatic', 'manual'].includes(String(binding.mode)) && remoteId(binding.remoteId)))
    && Object.entries(value.profiles).every(([id, stored]) => remoteId(id) && closed(stored, ['profile', 'fetchedAtMs']) && validProfile(stored.profile)
      && stored.profile.id === id && typeof stored.fetchedAtMs === 'number' && Number.isSafeInteger(stored.fetchedAtMs) && stored.fetchedAtMs >= 0)
}

/** 人物资料与人工关联独立按数据集保存；不触碰音频源文件、原曲库标签或凭据。 */
export function createArtistCatalogService(options: { supervisor: Pick<CoreSupervisor, 'request'>; directory: string; now?: () => number }): ArtistCatalogService {
  const now = options.now ?? Date.now, datasets = new Map<string, Promise<DatasetCache>>(), versions = new Map<string, number>()
  const active = new Set<Promise<unknown>>()
  let closing = false, closeFlight: Promise<void> | undefined
  const cacheDirectory = (datasetId: string) => path.join(options.directory, createHash('sha256').update(datasetId).digest('hex'))
  async function current(datasetId: string): Promise<void> {
    if (closing) return failure('NOT_READY', '艺术家目录正在关闭。')
    const context = await options.supervisor.request('commandOutbox.context', {}, datasetId)
    if (closing) return failure('NOT_READY', '艺术家目录正在关闭。')
    if (context.datasetId !== datasetId) return failure('SOURCE_CHANGED', '当前音乐库已改变，请重新读取。')
  }
  async function read<C extends dto.IpcCommand>(datasetId: string, command: C, payload: dto.IpcCommandPayloads[C]): Promise<dto.IpcCommandResults[C]> {
    await current(datasetId)
    const result = await options.supervisor.request(command, payload, datasetId)
    await current(datasetId)
    return result
  }
  async function cache(datasetId: string): Promise<DatasetCache> {
    const existing = datasets.get(datasetId)
    if (existing) return existing
    const operation = (async () => {
      const directory = cacheDirectory(datasetId)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const information = await lstat(directory)
      if (!information.isDirectory() || information.isSymbolicLink()) return failure('ARTIST_CATALOG_UNAVAILABLE', '艺术家缓存目录不可用。')
      let state: State = { schema: 1, datasetId, bindings: {}, profiles: {} }
      let file: Awaited<ReturnType<typeof open>> | undefined
      try {
        file = await open(path.join(directory, 'catalog.v1.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
        const information = await file.stat()
        if (!information.isFile() || information.size > MAX_CACHE_BYTES) return failure('ARTIST_CATALOG_UNAVAILABLE', '艺术家缓存超过读取范围。')
        const value: unknown = JSON.parse(await file.readFile('utf8'))
        if (!validState(value, datasetId)) return failure('ARTIST_CATALOG_UNAVAILABLE', '艺术家缓存尚未通过校验，请保留原资料。')
        state = value
      } catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error }
      finally { await file?.close() }
      await current(datasetId)
      return { state, write: Promise.resolve() }
    })()
    datasets.set(datasetId, operation)
    void operation.catch(() => { if (datasets.get(datasetId) === operation) datasets.delete(datasetId) })
    return operation
  }
  async function update(datasetId: string, entry: DatasetCache, edit: (next: State) => void): Promise<void> {
    const task = entry.write.catch(() => {}).then(async () => {
      await current(datasetId)
      const next = structuredClone(entry.state); edit(next)
      const ordered = Object.entries(next.profiles).sort((left, right) => right[1].fetchedAtMs - left[1].fetchedAtMs)
      next.profiles = Object.fromEntries(ordered.slice(0, MAX_PROFILES))
      if (!validState(next, datasetId)) return failure('ARTIST_CATALOG_UNAVAILABLE', '艺术家资料超过保存范围。')
      const body = JSON.stringify(next)
      if (Buffer.byteLength(body) > MAX_CACHE_BYTES) return failure('ARTIST_CATALOG_UNAVAILABLE', '艺术家资料超过保存预算。')
      const directory = cacheDirectory(datasetId), temporary = path.join(directory, `.catalog-${randomUUID()}.json`)
      let file: Awaited<ReturnType<typeof open>> | undefined
      try {
        file = await open(temporary, 'wx', 0o600); await file.writeFile(body, 'utf8'); await file.sync(); await file.close(); file = undefined
        await current(datasetId)
        await rename(temporary, path.join(directory, 'catalog.v1.json'))
        entry.state = next
        await current(datasetId)
      } finally { await file?.close(); await unlink(temporary).catch(error => { if (error?.code !== 'ENOENT') throw error }) }
    })
    entry.write = task; await task
  }
  function enrich(artist: dto.LocalArtistSummary, state: State): dto.ArtistCatalogArtist {
    const binding = state.bindings[artist.id], result: dto.ArtistCatalogArtist = { ...artist, linkState: binding?.mode ?? 'unlinked' }
    delete result.linkedNeteaseId
    if (!binding?.remoteId) return result
    result.linkedNeteaseId = binding.remoteId
    const stored = state.profiles[binding.remoteId]
    if (stored) {
      if (stored.profile.artworkUrl) result.artworkUrl = stored.profile.artworkUrl
      if (stored.profile.biography) result.biography = stored.profile.biography
      result.credit = '人物资料来自网易云'
    }
    return result
  }
  async function remoteProfile(datasetId: string, id: string): Promise<dto.NeteaseArtistProfile> {
    const profile = await read(datasetId, 'library.artistProfile', { artistId: id })
    if (!validProfile(profile) || profile.id !== id) return failure('ARTIST_CATALOG_UNAVAILABLE', '艺术家资料回包无效。')
    return profile
  }
  async function optionalProfileRead<T>(work: () => Promise<T>): Promise<T | undefined> {
    try { return await work() } catch (error) {
      const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined
      // 线上资料暂缺不阻断本地详情；原数据集与生命周期错误仍须让调用者看见。
      if (['SOURCE_CHANGED', 'SNAPSHOT_CHANGED', 'OUTBOX_SCOPE_MISMATCH', 'NOT_READY', 'CANCELLED'].includes(String(code))) throw error
      return undefined
    }
  }
  async function candidates(datasetId: string, query: string): Promise<{ items: readonly dto.ArtistSummary[]; complete: boolean }> {
    const result: dto.ArtistSummary[] = [], seen = new Set<string>()
    for (let offset = 0; offset < 200; offset += 50) {
      const page = await read(datasetId, 'library.searchArtists', { query, page: { offset, limit: 50 } })
      if (page.offset !== offset || page.limit !== 50) return failure('ARTIST_CATALOG_UNAVAILABLE', '艺术家候选分页无效。')
      for (const item of page.items) {
        if (!remoteId(item.id) || !dto.isLocalCatalogText(item.name)) return failure('ARTIST_CATALOG_UNAVAILABLE', '艺术家候选身份无效。')
        if (!seen.has(item.id)) { seen.add(item.id); result.push(item) }
      }
      if (!page.hasMore) return { items: result, complete: true }
      if (!page.items.length) return { items: result, complete: false }
    }
    return { items: result, complete: false }
  }
  const versionKey = (datasetId: string, artistId: string) => `${datasetId}:${artistId}`
  async function resolveArtist(datasetId: string, artistId: string): Promise<dto.ArtistCatalogArtist> {
    const artist = await read(datasetId, 'localArtist.get', { artistId }), entry = await cache(datasetId)
    const version = versions.get(versionKey(datasetId, artistId)) ?? 0, binding = entry.state.bindings[artistId]
    if (binding?.mode === 'unlinked') return enrich(artist, entry.state)
    if (binding?.remoteId) {
      const boundId = binding.remoteId, stored = entry.state.profiles[boundId]
      if (!stored || now() - stored.fetchedAtMs > 24 * 60 * 60 * 1000) {
        const profile = await optionalProfileRead(() => remoteProfile(datasetId, boundId))
        if (profile) await update(datasetId, entry, next => { next.profiles[profile.id] = { profile, fetchedAtMs: now() } })
      }
      return enrich(artist, entry.state)
    }
    const found = await optionalProfileRead(() => candidates(datasetId, artist.name))
    if (!found) return enrich(artist, entry.state)
    const exact = found.items.filter(candidate => normalized(candidate.name) === normalized(artist.name))
    if (!found.complete || exact.length !== 1 || !remoteId(exact[0]!.id)) return enrich(artist, entry.state)
    const selected = exact[0]!
    const [albums, tracks, remoteAlbums, remoteTracks, profile] = await Promise.all([
      read(datasetId, 'localArtist.albums', { artistId, relation: 'albums', offset: 0, limit: 200 }),
      read(datasetId, 'localArtist.tracks', { artistId, offset: 0, limit: 200 }),
      optionalProfileRead(() => read(datasetId, 'library.artistAlbums', { artistId: selected.id, page: { offset: 0, limit: 100 } })),
      optionalProfileRead(() => read(datasetId, 'library.artist', { artistId: selected.id, page: { offset: 0, limit: 100 } })),
      optionalProfileRead(() => remoteProfile(datasetId, selected.id)),
    ])
    if (!profile || !remoteAlbums || !remoteTracks) return enrich(artist, entry.state)
    if (normalized(profile.name) !== normalized(artist.name)) return enrich(artist, entry.state)
    if (albums.revision !== tracks.revision) return failure('SOURCE_CHANGED', '本地艺术家作品已改变，请重新读取。')
    const albumNames = new Set(albums.items.map(item => normalized(item.title)).filter(Boolean))
    const trackNames = new Set(tracks.items.map(item => normalized(item.metadata.title ?? '')).filter(Boolean))
    const matchedAlbums = new Set(remoteAlbums.items.map(item => normalized(item.name)).filter(name => albumNames.has(name)))
    const matchedTracks = new Set(remoteTracks.tracks.items.map(item => normalized(item.title)).filter(name => trackNames.has(name)))
    if (!(matchedAlbums.size >= 1 && matchedTracks.size >= 1 || matchedTracks.size >= 2)) return enrich(artist, entry.state)
    const final = await read(datasetId, 'localArtist.tracks', { artistId, offset: 0, limit: 1 })
    if (final.revision !== tracks.revision) return failure('SOURCE_CHANGED', '本地作品在关联前已经变化。')
    await update(datasetId, entry, next => {
      if ((versions.get(versionKey(datasetId, artistId)) ?? 0) !== version || next.bindings[artistId]?.mode === 'manual' || next.bindings[artistId]?.mode === 'unlinked') return
      next.bindings[artistId] = { mode: 'automatic', remoteId: profile.id }
      next.profiles[profile.id] = { profile, fetchedAtMs: now() }
    })
    return enrich(artist, entry.state)
  }
  function run<T>(datasetId: string, work: () => Promise<T>): Promise<T> {
    if (closing) return Promise.reject(Object.assign(new Error('[NOT_READY] 艺术家目录正在关闭。'), { code: 'NOT_READY' }))
    const operation = (async () => { await current(datasetId); const result = await work(); await current(datasetId); return structuredClone(result) })()
    active.add(operation); void operation.then(() => active.delete(operation), () => active.delete(operation))
    return operation
  }
  function input<P, R>(datasetId: string, value: P, valid: (value: unknown) => boolean, work: (value: P) => Promise<R>): Promise<R> {
    if (!valid(value)) return Promise.reject(Object.assign(new Error('[INVALID_IPC_REQUEST] 艺术家或搜索请求无效。'), { code: 'INVALID_IPC_REQUEST' }))
    // 身份等待之前固定输入，调用者随后改动表单不能改写原请求。
    const captured = structuredClone(value)
    return run(datasetId, () => work(captured))
  }
  function forDataset(datasetId: string): dto.ArtistSearchCatalogPublicApi {
    if (closing) return failure('NOT_READY', '艺术家目录正在关闭。')
    if (!dto.isCommandOutboxDatasetId(datasetId)) return failure('INVALID_IPC_REQUEST', '音乐库身份无效。')
    return {
      listArtists: value => input(datasetId, value, dto.isArtistQuery, async request => {
        const result = await read(datasetId, 'localArtist.list', request), entry = await cache(datasetId)
        return { ...result, items: result.items.map(item => enrich(item, entry.state)) }
      }),
      getArtist: value => input(datasetId, value, request => closed(request, ['artistId']) && dto.isLocalArtistId(request.artistId), async request => {
        return resolveArtist(datasetId, request.artistId)
      }),
      listArtistAlbums: value => input(datasetId, value, dto.isLocalArtistAlbumsQuery, request => read(datasetId, 'localArtist.albums', request)),
      listArtistTracks: value => input(datasetId, value, dto.isLocalArtistTracksQuery, request => read(datasetId, 'localArtist.tracks', request)),
      search: value => input(datasetId, value, dto.isArtistQuery, async request => {
        const result = await read(datasetId, 'localArtist.search', request), entry = await cache(datasetId)
        return { ...result, artists: { ...result.artists, items: result.artists.items.map(item => enrich(item, entry.state)) } }
      }),
      suggest: value => input(datasetId, value, request => closed(request, ['query']) && text(request.query), request => read(datasetId, 'library.searchSuggestions', request)),
      artistMatches: value => input(datasetId, value, request => closed(request, ['artistId'], ['query']) && dto.isLocalArtistId(request.artistId)
        && (request.query === undefined || text(request.query)), async request => {
        const local = await read(datasetId, 'localArtist.get', { artistId: request.artistId })
        const result = await candidates(datasetId, request.query?.trim() || local.name)
        return result.items.map(item => ({ id: item.id, name: item.name, source: 'netease' as const, albumCount: item.albumCount ?? 0, trackCount: item.trackCount ?? 0,
          ...(item.artworkUrl ? { artworkUrl: item.artworkUrl } : {}) }))
      }),
      bindArtist: value => input(datasetId, value, request => closed(request, ['artistId', 'neteaseArtistId']) && dto.isLocalArtistId(request.artistId)
        && (request.neteaseArtistId === null || remoteId(request.neteaseArtistId)), async request => {
        const key = versionKey(datasetId, request.artistId), version = (versions.get(key) ?? 0) + 1; versions.set(key, version)
        const artist = await read(datasetId, 'localArtist.get', { artistId: request.artistId }), entry = await cache(datasetId)
        const profile = request.neteaseArtistId === null ? null : await remoteProfile(datasetId, request.neteaseArtistId)
        await update(datasetId, entry, next => {
          if (versions.get(key) !== version) return failure('SOURCE_CHANGED', '艺术家关联已有更新，请先重新读取。')
          next.bindings[artist.id] = profile ? { mode: 'manual', remoteId: profile.id } : { mode: 'unlinked', remoteId: null }
          if (profile) next.profiles[profile.id] = { profile, fetchedAtMs: now() }
        })
        return enrich(artist, entry.state)
      }),
      playLocalSelection: async value => {
        let sent = false
        try { return await input(datasetId, value, request => closed(request, ['requestId', 'context', 'startTrackId', 'target', 'action'])
        && text(request.requestId) && request.requestId.length > 0 && dto.isLocalSearchPlayContext(request.context) && dto.isLocalPlayTarget(request.target)
        && dto.isCollectionId(request.startTrackId) && (dto.LOCAL_PLAY_ACTIONS as readonly unknown[]).includes(request.action), async request => {
        let chosen: dto.LocalArtistTrackItem | undefined, total: number | undefined
        for (let offset = 0; ; offset += 200) {
          const result = request.context.kind === 'artist'
            ? await read(datasetId, 'localArtist.tracks', { artistId: request.context.artistId, offset, limit: 200 })
            : (await read(datasetId, 'localArtist.search', { query: request.context.query, offset, limit: 200 })).tracks
          if (result.revision !== request.context.revision || result.offset !== offset || result.limit !== 200 || total !== undefined && total !== result.total) return failure('SOURCE_CHANGED', '原歌曲集合已经变化，请重新读取。')
          total = result.total
          if (request.action === 'PLAY_NOW' && total > dto.MAX_PLAYBACK_QUEUE_ITEMS) return failure('INVENTORY_CONFLICT', '完整歌曲集合超过队列容量，请缩小范围。')
          chosen ??= result.items.find(item => item.track.id === request.startTrackId)
          if (chosen && request.action !== 'PLAY_NOW') break
          if (!result.hasMore) break
          if (!result.items.length) return failure('SOURCE_CHANGED', '原歌曲集合没有取得完整分页。')
        }
        if (!chosen || !total) return failure('SOURCE_CHANGED', '所选歌曲已不在原集合中。')
        const payload: dto.LocalPlayRequest = { schema_version: '1.2', request_id: request.requestId, route: 'roon_audio_input', source_kind: 'local_file', local_track_id: chosen.track.id,
          asset_id: chosen.asset.id, expected_asset_revision: chosen.asset.fileRevision, target: { ...request.target }, action: request.action,
          ...(request.action === 'PLAY_NOW' ? { context: { ...request.context } } : {}) }
        if (!dto.isLocalPlayRequest(payload)) return failure('INVALID_IPC_REQUEST', '本地点播身份无效。')
        await current(datasetId)
        // 只在真正调用原播放命令前标记；预读失败不得冒充已派发或未知受理。
        sent = true
        const result = await options.supervisor.request('localCatalog.prepare', payload, datasetId)
        await current(datasetId)
        return result
      }) } catch (error) {
        const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined
        const message = error instanceof Error ? error.message : '本地播放请求尚未发送。'
        if (sent) throw Object.assign(new Error(message), { code: typeof code === 'string' ? code : 'ARTIST_CATALOG_UNAVAILABLE' })
        throw Object.assign(new Error(message), { code: typeof code === 'string' ? code : 'ARTIST_CATALOG_UNAVAILABLE', outcome: 'not-sent' as const })
      } },
    }
  }
  return { forDataset, close() { if (closeFlight) return closeFlight; closing = true; closeFlight = (async () => { await Promise.allSettled([...active]); const entries = await Promise.allSettled([...datasets.values()]); await Promise.allSettled(entries.filter((entry): entry is PromiseFulfilledResult<DatasetCache> => entry.status === 'fulfilled').map(entry => entry.value.write)); datasets.clear(); versions.clear() })(); return closeFlight } }
}
