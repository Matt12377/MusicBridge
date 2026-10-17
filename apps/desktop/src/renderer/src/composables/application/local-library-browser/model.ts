import { emitRendererArtwork, desktopArtworkStarted, desktopArtworkElapsed, desktopArtworkKey } from '../../../../../../../../packages/bridge-core/src/shared/desktop-artwork-trace.js'
import { isCollectionId, isLocalCatalogText, isLocalAlbumSummary, isLocalAlbumPage, isLocalAlbumTrackPage, isLocalAlbumArtworkReply } from '@music-bridge/contracts'
import { LOCAL_ALBUM_STATUSES, type LocalAlbumArtworkRequest, type LocalAlbumArtworkState, type LocalAlbumArtworkWindow, type LocalAlbumBrowserOptions, type LocalAlbumBrowserSnapshot, type LocalAlbumFilter, type LocalAlbumFilterCounts, type LocalAlbumPage, type LocalAlbumQuery, type LocalAlbumReturnTarget, type LocalAlbumSummary, type LocalAlbumTrackItem, type LocalAlbumTrackPage, type LocalAlbumTrackQuery } from './types.js'
export { isLocalAlbumSummary, isLocalAlbumPage, isLocalAlbumTrackItem, isLocalAlbumTrackPage, isLocalAlbumArtworkReply } from '@music-bridge/contracts'
export { localAlbumTrackPresentation } from './presentation.js'

export const LOCAL_ALBUM_PAGE_SIZE = 60
export const LOCAL_ALBUM_TRACK_PAGE_SIZE = 100
export const LOCAL_ALBUM_ARTWORK_CONCURRENCY = 2
export const LOCAL_ALBUM_ARTWORK_CACHE_BYTES = 64 * 1024 * 1024
export const LOCAL_ALBUM_ARTWORK_CACHE_ENTRIES = 128
export const LOCAL_ALBUM_ARTWORK_COUNT_QUIET_MS = 250
export const LOCAL_ALBUM_ARTWORK_COUNT_MAX_WAIT_MS = 1000
const filters = ['all', ...LOCAL_ALBUM_STATUSES] as const
const idleArtwork: LocalAlbumArtworkState = Object.freeze({ status: 'idle', dataUrl: null, error: '', canRetry: false })
const missingArtwork: LocalAlbumArtworkState = Object.freeze({ status: 'missing', dataUrl: null, error: '', canRetry: false })
const unavailableArtwork: LocalAlbumArtworkState = Object.freeze({ status: 'error', dataUrl: null, error: '封面来源暂不可用，请在来源恢复后重试。已保存的封面选择保留。', canRetry: true })
const artworkCountError = '封面计数暂未更新，保留上次确认的数量，请重试。'
const artworkState = (album: LocalAlbumSummary) => album.artworkState ?? (album.artworkAvailable ? 'available' : 'missing')
const emptyCounts = (): LocalAlbumFilterCounts => Object.freeze(Object.fromEntries(filters.map(filter => [filter, 0])) as unknown as LocalAlbumFilterCounts)
const natural = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max
const opaqueIdentity = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,255}$/u.test(value)
const isFilter = (value: unknown): value is LocalAlbumFilter => (filters as readonly unknown[]).includes(value)
const artworkRequest = (album: LocalAlbumSummary): LocalAlbumArtworkRequest => ({ albumKey: album.id, rootId: album.rootId, editionId: album.editionId, representativeTrackId: album.representativeTrackId, revision: album.revision })
const traceKey = (request: LocalAlbumArtworkRequest) => desktopArtworkKey(JSON.stringify([request.albumKey, request.rootId, request.editionId, request.representativeTrackId, request.revision]))
const sameArtworkRequest = (left: LocalAlbumArtworkRequest, right: LocalAlbumArtworkRequest): boolean => left.albumKey === right.albumKey && left.rootId === right.rootId
  && left.editionId === right.editionId && left.representativeTrackId === right.representativeTrackId && left.revision === right.revision
function immutable<T>(value: T): T {
  const copy = structuredClone(value)
  const freeze = (node: unknown): void => { if (node && typeof node === 'object' && !Object.isFrozen(node)) { for (const child of Object.values(node)) freeze(child); Object.freeze(node) } }
  freeze(copy)
  return copy
}
function positiveOption(value: number | undefined, fallback: number, max: number): number { return natural(value, max) && value > 0 ? value : fallback }

/** 纯只读状态机；各次读取按代际与请求身份提交，迟到回复不覆盖当前页面。 */
export function createLocalAlbumBrowserModel(options: LocalAlbumBrowserOptions) {
  const pageSize = positiveOption(options.pageSize, LOCAL_ALBUM_PAGE_SIZE, 200)
  const trackPageSize = positiveOption(options.trackPageSize, LOCAL_ALBUM_TRACK_PAGE_SIZE, 200)
  const artworkConcurrency = positiveOption(options.artworkConcurrency, LOCAL_ALBUM_ARTWORK_CONCURRENCY, LOCAL_ALBUM_ARTWORK_CONCURRENCY)
  const artworkCacheBytes = positiveOption(options.artworkCacheBytes, LOCAL_ALBUM_ARTWORK_CACHE_BYTES, 64 * 1024 * 1024)
  const artworkCacheEntries = positiveOption(options.artworkCacheEntries, LOCAL_ALBUM_ARTWORK_CACHE_ENTRIES, 128)
  let disposed = false, galleryGeneration = 0, detailGeneration = 0, artworkGeneration = 0, artworkRunning = 0, clock = 0, artworkInvalidationEpoch = 0, artworkRefreshEpoch = 0
  let galleryPending: { generation: number; promise: Promise<void> } | undefined, galleryReadSerial = 0
  let detailPending: { generation: number; promise: Promise<void> } | undefined
  interface ArtworkEntry { request: LocalAlbumArtworkRequest; state: LocalAlbumArtworkState; bytes: number; used: number; refreshEpoch: number; promise?: Promise<void> }
  interface ArtworkJob { entry: ArtworkEntry; generation: number; finish: () => void }
  const artworkCache = new Map<string, ArtworkEntry>(), artworkQueue: ArtworkJob[] = []
  // 真正进行中的读取不属于展示LRU；出窗/淘汰只撤显示引用，实际settle前仍占槽。
  const artworkFlights = new Map<string, ArtworkJob>()
  const galleryAlbums = new Map<string, LocalAlbumSummary>()
  interface ArtworkCountObservation { request: LocalAlbumArtworkRequest; state: 'available' | 'missing'; generation: number; serial: number; scope: Pick<LocalAlbumQuery, 'query' | 'rootId' | 'filter'> }
  const artworkCountObservations = new Map<string, ArtworkCountObservation>()
  let artworkCountTimer: ReturnType<typeof setTimeout> | undefined, artworkCountMaxTimer: ReturnType<typeof setTimeout> | undefined, artworkCountWork: Promise<void> | undefined, artworkCountSerial = 0, galleryArtworkCountSerial = 0
  let artworkWindow: Map<string, { request: LocalAlbumArtworkRequest; priority: number }> | null = null
  let artworkRefreshPending: Promise<void> | undefined
  let artworkDetailRefreshPending: Promise<void> | undefined
  let artworkRefreshGeneration: number | null = null
  let state: LocalAlbumBrowserSnapshot = Object.freeze({ active: false, query: '', rootId: null, filter: 'all', items: Object.freeze([]), total: 0, hasMore: false, counts: emptyCounts(), loaded: false,
    status: 'idle', initialLoading: false, refreshing: false, loadingMore: false, error: '', refreshError: '', loadMoreError: '', stale: false, scrollTop: 0,
    selectedAlbum: null, selectedAlbumIds: Object.freeze([]), tracks: Object.freeze([]), trackTotal: 0, tracksHasMore: false, detailStatus: 'idle', detailLoading: false, detailRefreshing: false, detailLoadingMore: false,
    detailError: '', detailRefreshError: '', detailLoadMoreError: '', detailStale: false, returnTarget: null, artwork: Object.freeze(Object.create(null)) as Readonly<Record<string, LocalAlbumArtworkState>> })
  function publish(patch: Partial<LocalAlbumBrowserSnapshot> = {}): void {
    if (patch.items) { galleryAlbums.clear(); for (const album of patch.items) galleryAlbums.set(album.id, album) }
    const artwork = Object.assign(Object.create(null), Object.fromEntries([...artworkCache].map(([key, entry]) => [key, entry.state]))) as Record<string, LocalAlbumArtworkState>
    state = Object.freeze({ ...state, ...patch, artwork: Object.freeze(artwork) })
    options.onChange?.(state)
  }
  const currentGallery = (generation: number): boolean => state.active && !disposed && generation === galleryGeneration
  const currentDetail = (generation: number, album: LocalAlbumSummary): boolean => state.active && !disposed && generation === detailGeneration
    && state.selectedAlbum?.id === album.id && state.selectedAlbum.rootId === album.rootId
  // 封面实读观测可更新两项显示计数；只有按封面筛选时它们才参与当前集合的成员资格。
  const countsEqual = (left: LocalAlbumFilterCounts, right: LocalAlbumFilterCounts, selectedFilter: LocalAlbumFilter): boolean => filters.every(filter =>
    selectedFilter !== 'has-artwork' && selectedFilter !== 'missing-artwork' && (filter === 'has-artwork' || filter === 'missing-artwork') || left[filter] === right[filter])
  function currentCountObservation(observation: ArtworkCountObservation): LocalAlbumSummary | undefined {
    if (disposed || !state.active || observation.generation !== artworkGeneration || observation.scope.query !== state.query
      || observation.scope.rootId !== state.rootId || observation.scope.filter !== state.filter) return undefined
    const album = galleryAlbums.get(observation.request.albumKey)
    return album && sameArtworkRequest(artworkRequest(album), observation.request) ? album : undefined
  }
  function scheduleArtworkCounts(): void {
    if (disposed || !state.active || artworkCountWork || !artworkCountObservations.size) return
    const flush = (): void => {
      clearTimeout(artworkCountTimer); clearTimeout(artworkCountMaxTimer)
      artworkCountTimer = undefined; artworkCountMaxTimer = undefined
      void flushArtworkCounts()
    }
    // 静默批可合并跨事件循环的图片完成；最大等待独立领取一次，持续完成不重置它。
    clearTimeout(artworkCountTimer)
    artworkCountTimer = setTimeout(flush, LOCAL_ALBUM_ARTWORK_COUNT_QUIET_MS)
    artworkCountMaxTimer ??= setTimeout(flush, LOCAL_ALBUM_ARTWORK_COUNT_MAX_WAIT_MS)
  }
  function observeArtworkCount(request: LocalAlbumArtworkRequest, available: boolean): void {
    const observation: ArtworkCountObservation = { request, state: available ? 'available' : 'missing', generation: artworkGeneration, serial: artworkCountSerial + 1,
      scope: { query: state.query, rootId: state.rootId, filter: state.filter } }
    const album = currentCountObservation(observation)
    if (!album || artworkState(album) === observation.state) return
    artworkCountSerial++; artworkCountObservations.set(request.albumKey, observation); scheduleArtworkCounts()
  }
  async function flushArtworkCounts(): Promise<void> {
    if (artworkCountWork) return artworkCountWork
    const work = (async () => {
      const generation = artworkGeneration
      let serial = galleryReadSerial, detail = detailGeneration
      try {
        // 原分页/详情先提交；在途query可能已含单图观察，不能按旧卡片盲加一次。
        while (state.active && !disposed && generation === artworkGeneration
          && (galleryPending?.generation === galleryGeneration || detailPending?.generation === detailGeneration)) {
          await Promise.all([galleryPending?.generation === galleryGeneration ? galleryPending.promise : undefined,
            detailPending?.generation === detailGeneration ? detailPending.promise : undefined])
        }
        if (!state.active || disposed || generation !== artworkGeneration) return
        const observations = [...artworkCountObservations.values()].filter(value => currentCountObservation(value))
        artworkCountObservations.clear()
        if (!observations.length) return
        serial = galleryReadSerial; detail = detailGeneration
        const observationSerial = artworkCountSerial
        let counts = state.counts, total = state.total
        // 后发的正常gallery已覆盖这批观察时只补旧卡片状态；详情回复没有gallery计数，不能据此吞掉批次。
        if (observations.some(value => value.serial > galleryArtworkCountSerial)) {
          const request: LocalAlbumQuery = { query: state.query, rootId: state.rootId, filter: state.filter, offset: 0, limit: 1 }
          const countStarted = desktopArtworkStarted(); emitRendererArtwork('count-refresh')
          const reply = await options.api.queryAlbums(request)
          emitRendererArtwork('count-refresh', null, { count: 0, elapsedMs: desktopArtworkElapsed(countStarted) })
          if (!isLocalAlbumPage(reply, request)) throw new Error('无效封面计数投影')
          counts = reply.counts; total = reply.total
        }
        if (!state.active || disposed || generation !== artworkGeneration) return
        // 新分页或详情已开始时让新读取先落定；同scope后续批次再收口，不倒写旧计数。
        if (serial !== galleryReadSerial || detail !== detailGeneration || observationSerial !== artworkCountSerial) {
          for (const value of observations) if (currentCountObservation(value) && !artworkCountObservations.has(value.request.albumKey)) artworkCountObservations.set(value.request.albumKey, value)
          return
        }
        const current = observations.filter(value => currentCountObservation(value))
        if (!current.length) return
        const artworkFilter = state.filter === 'has-artwork' || state.filter === 'missing-artwork'
        const membershipChanged = artworkFilter && current.some(value => currentCountObservation(value)!.statuses.includes(state.filter as 'has-artwork' | 'missing-artwork')
          !== (state.filter === (value.state === 'available' ? 'has-artwork' : 'missing-artwork')))
        if (membershipChanged || total !== state.total || !countsEqual(counts, state.counts, 'all')) {
          // 成员资格或其他集合事实变化只重建一次首页；不把失效尾页接到新集合。
          await readGallery('refresh', true); return
        }
        const updates = new Map(current.map(value => [value.request.albumKey, value]))
        const updated = (album: LocalAlbumSummary): LocalAlbumSummary => {
          const value = updates.get(album.id)
          return value && sameArtworkRequest(value.request, artworkRequest(album)) ? immutable({ ...album, artworkAvailable: value.state === 'available', artworkState: value.state,
            statuses: LOCAL_ALBUM_STATUSES.filter(status => status === (value.state === 'available' ? 'has-artwork' : 'missing-artwork')
              || status !== 'has-artwork' && status !== 'missing-artwork' && album.statuses.includes(status)) }) : album
        }
        // 轻量事实随当前gallery保存，和128项图片LRU相互独立；计数只采用同一次权威回复。
        galleryArtworkCountSerial = Math.max(galleryArtworkCountSerial, observationSerial)
        publish({ items: Object.freeze(state.items.map(updated)), selectedAlbum: state.selectedAlbum ? updated(state.selectedAlbum) : null, counts: immutable(counts),
          ...(state.refreshError === artworkCountError ? { stale: false, refreshError: '' } : {}) })
      } catch {
        if (state.active && !disposed && generation === artworkGeneration && serial === galleryReadSerial && detail === detailGeneration) publish({ stale: true,
          ...(!state.refreshError || state.refreshError === artworkCountError ? { refreshError: artworkCountError } : {}) })
      }
    })()
    artworkCountWork = work
    try { await work } finally { if (artworkCountWork === work) artworkCountWork = undefined; scheduleArtworkCounts() }
  }
  function invalidateCachedArtwork(albumKey: string): void { artworkCache.delete(albumKey); artworkFlights.delete(albumKey) }
  /** 每个成功刷新代只恢复原快照项一次；渲染和 LRU 淘汰不重新获得自动资格。 */
  function retryRefreshedUnavailableArtwork(albums: readonly LocalAlbumSummary[], entries: readonly ArtworkEntry[], generation: number): void {
    for (const entry of entries) {
      if (!state.active || disposed || generation !== artworkGeneration) return
      // 显式刷新已经探过的失败不在同一动作内再自动重试；普通恢复刷新仍保原一次资格。
      if (artworkRefreshPending && entry.refreshEpoch === artworkRefreshEpoch
        || artworkDetailRefreshPending && state.selectedAlbum?.id === entry.request.albumKey) continue
      const album = albums.find(value => sameArtworkRequest(entry.request, artworkRequest(value)))
      if (!album || artworkState(album) === 'missing' || artworkState(album) === 'source-unavailable'
        || artworkCache.get(entry.request.albumKey) !== entry || entry.state !== unavailableArtwork) continue
      invalidateCachedArtwork(album.id)
      void ensureArtwork(album)
    }
  }
  function observeRevisions(albums: readonly LocalAlbumSummary[]): void {
    for (const album of albums) { const entry = artworkCache.get(album.id); if (entry && !sameArtworkRequest(entry.request, artworkRequest(album))) invalidateCachedArtwork(album.id) }
  }

  async function readGallery(mode: 'initial' | 'refresh' | 'more', restart = false): Promise<void> {
    if (!state.active || disposed || mode === 'more' && (!state.loaded || !state.hasMore)) return
    if (mode === 'more' && galleryPending?.generation === galleryGeneration) return galleryPending.promise
    galleryReadSerial++
    const generation = mode === 'more' ? galleryGeneration : ++galleryGeneration
    const artworkRetryGeneration = artworkGeneration, unavailableEntries = mode === 'refresh' ? [...artworkCache.values()].filter(entry => entry.state === unavailableArtwork) : []
    const scope = { query: state.query, rootId: state.rootId, filter: state.filter }
    const previousItems = state.items, previousTotal = state.total, previousCounts = state.counts
    const pagesToRefresh = mode === 'refresh' && !restart ? Math.max(1, Math.ceil(previousItems.length / pageSize)) : 1
    publish({ initialLoading: mode === 'initial', refreshing: mode === 'refresh', loadingMore: mode === 'more',
      ...(mode === 'initial' ? { status: 'loading' as const, error: '' } : mode === 'refresh' ? { refreshError: '' } : { loadMoreError: '' }) })
    const promise = (async () => {
      try {
        const collected: LocalAlbumSummary[] = [], seen = new Set(mode === 'more' ? previousItems.map(album => album.id) : [])
        let firstPage: LocalAlbumPage | undefined, lastPage: LocalAlbumPage | undefined, observedBeforePage = 0
        for (let pageIndex = 0; pageIndex < pagesToRefresh; pageIndex++) {
          const request: LocalAlbumQuery = { ...scope, offset: mode === 'more' ? previousItems.length : pageIndex * pageSize, limit: pageSize }
          observedBeforePage = artworkCountSerial
          const reply = await options.api.queryAlbums(request)
          if (!currentGallery(generation)) return
          if (!isLocalAlbumPage(reply, request)) throw new Error('无效专辑投影')
          const page = immutable(reply)
          if (mode === 'more' && (page.total !== previousTotal || !countsEqual(page.counts, previousCounts, scope.filter))) throw new Error('专辑集合已改变')
          if (firstPage && (page.total !== firstPage.total || !countsEqual(page.counts, firstPage.counts, scope.filter))) throw new Error('专辑集合已改变')
          for (const album of page.items) { if (seen.has(album.id)) throw new Error('专辑身份重复'); seen.add(album.id); collected.push(album) }
          firstPage ??= page; lastPage = page
          if (!page.hasMore) break
        }
        if (!currentGallery(generation) || !firstPage || !lastPage) return
        const items = Object.freeze(mode === 'more' ? [...previousItems, ...collected] : collected)
        observeRevisions(items)
        if (artworkRetryGeneration === artworkGeneration) galleryArtworkCountSerial = Math.max(galleryArtworkCountSerial, observedBeforePage)
        publish({ items, total: firstPage.total, hasMore: lastPage.hasMore, counts: lastPage.counts, loaded: true, status: firstPage.total === 0 ? 'empty' : 'ready',
          stale: false, error: '', refreshError: '', loadMoreError: '', ...(restart ? { scrollTop: 0, selectedAlbumIds: Object.freeze([]) } : {}) })
        if (currentGallery(generation)) retryRefreshedUnavailableArtwork(items, unavailableEntries, artworkRetryGeneration)
      } catch {
        if (!currentGallery(generation)) return
        publish(mode === 'initial' ? { status: 'error', loaded: false, error: '专辑暂时无法读取，请重试。已保存的音乐库信息保留。' }
          : mode === 'refresh' ? { stale: true, refreshError: '专辑刷新暂未完成，保留上次成功读取的结果，请重试。' }
            : { loadMoreError: '更多专辑暂时无法读取，请重试。已显示的专辑保留。' })
      } finally {
        if (currentGallery(generation)) publish({ initialLoading: false, refreshing: false, loadingMore: false })
      }
    })()
    const pending = { generation, promise }; galleryPending = pending
    await promise
    if (galleryPending === pending) galleryPending = undefined
  }

  async function readDetail(mode: 'initial' | 'refresh' | 'more'): Promise<void> {
    const album = state.selectedAlbum
    if (!album || !state.active || disposed || mode === 'more' && !state.tracksHasMore) return
    if (mode === 'more' && detailPending?.generation === detailGeneration) return detailPending.promise
    const generation = mode === 'more' ? detailGeneration : ++detailGeneration
    const artworkRetryGeneration = artworkGeneration, unavailableEntries = mode === 'refresh' ? [...artworkCache.values()].filter(entry => entry.state === unavailableArtwork) : []
    const previousTracks = state.tracks, previousTotal = state.trackTotal
    const pagesToRefresh = mode === 'refresh' ? Math.max(1, Math.ceil(previousTracks.length / trackPageSize)) : 1
    publish({ detailLoading: mode === 'initial', detailRefreshing: mode === 'refresh', detailLoadingMore: mode === 'more',
      ...(mode === 'initial' ? { detailStatus: 'loading' as const, detailError: '' } : mode === 'refresh' ? { detailRefreshError: '' } : { detailLoadMoreError: '' }) })
    const promise = (async () => {
      try {
        const collected: LocalAlbumTrackItem[] = [], seen = new Set(mode === 'more' ? previousTracks.map(track => track.facts.track.id) : [])
        let firstPage: LocalAlbumTrackPage | undefined, lastPage: LocalAlbumTrackPage | undefined
        let lastSequence = mode === 'more' ? previousTracks.at(-1)?.sequence : undefined
        for (let pageIndex = 0; pageIndex < pagesToRefresh; pageIndex++) {
          const request: LocalAlbumTrackQuery = { albumKey: album.id, rootId: album.rootId, offset: mode === 'more' ? previousTracks.length : pageIndex * trackPageSize, limit: trackPageSize }
          const reply = await options.api.queryAlbumTracks(request)
          if (!currentDetail(generation, album)) return
          if (!isLocalAlbumTrackPage(reply, request, album)) throw new Error('无效曲目投影')
          const page = immutable(reply)
          if (mode === 'more' && (page.total !== previousTotal || page.album.revision !== album.revision)) throw new Error('曲目集合已改变')
          if (firstPage && (page.total !== firstPage.total || page.album.revision !== firstPage.album.revision)) throw new Error('曲目集合已改变')
          for (const item of page.items) {
            if (seen.has(item.facts.track.id) || lastSequence !== undefined && item.sequence <= lastSequence) throw new Error('曲目身份或顺序重复')
            seen.add(item.facts.track.id); collected.push(item); lastSequence = item.sequence
          }
          firstPage ??= page; lastPage = page
          if (!page.hasMore) break
        }
        if (!currentDetail(generation, album) || !firstPage || !lastPage) return
        observeRevisions([firstPage.album])
        const tracks = Object.freeze(mode === 'more' ? [...previousTracks, ...collected] : collected)
        // 详情可先看到Owner已确认的封面事实，但没有gallery计数；发布前按同五字段排入原批次。
        const detailArtworkState = artworkState(firstPage.album)
        if (detailArtworkState === 'available' || detailArtworkState === 'missing') observeArtworkCount(artworkRequest(firstPage.album), detailArtworkState === 'available')
        const items = Object.freeze(state.items.map(item => item.id === firstPage!.album.id && item.rootId === firstPage!.album.rootId ? firstPage!.album : item))
        publish({ selectedAlbum: firstPage.album, items, tracks, trackTotal: firstPage.total, tracksHasMore: lastPage.hasMore, detailStatus: firstPage.total === 0 ? 'empty' : 'ready',
          detailStale: false, detailError: '', detailRefreshError: '', detailLoadMoreError: '' })
        if (currentDetail(generation, album)) retryRefreshedUnavailableArtwork([firstPage.album], unavailableEntries, artworkRetryGeneration)
      } catch {
        if (!currentDetail(generation, album)) return
        publish(mode === 'initial' ? { detailStatus: 'error', detailError: '专辑曲目暂时无法读取，请重试。已保存的音乐库信息保留。' }
          : mode === 'refresh' ? { detailStale: true, detailRefreshError: '专辑详情刷新暂未完成，保留上次成功读取的信息，请重试。' }
            : { detailLoadMoreError: '更多曲目暂时无法读取，请重试。已显示的曲目保留。' })
      } finally {
        if (currentDetail(generation, album)) publish({ detailLoading: false, detailRefreshing: false, detailLoadingMore: false })
      }
    })()
    const pending = { generation, promise }; detailPending = pending
    await promise
    if (detailPending === pending) detailPending = undefined
  }

  function clearDetail(restoreScroll: boolean): LocalAlbumReturnTarget | null {
    if (disposed) return null
    const target = state.returnTarget
    detailGeneration++
    publish({ selectedAlbum: null, tracks: Object.freeze([]), trackTotal: 0, tracksHasMore: false, detailStatus: 'idle', detailLoading: false, detailRefreshing: false, detailLoadingMore: false,
      detailError: '', detailRefreshError: '', detailLoadMoreError: '', detailStale: false, returnTarget: null, ...(restoreScroll && target ? { scrollTop: target.scrollTop } : {}) })
    return target
  }
  function cancelArtworkRequests(): void {
    artworkGeneration++
    clearTimeout(artworkCountTimer); clearTimeout(artworkCountMaxTimer); artworkCountTimer = undefined; artworkCountMaxTimer = undefined; artworkCountObservations.clear()
    artworkFlights.clear()
    artworkWindow = null
    artworkRefreshPending = undefined
    artworkDetailRefreshPending = undefined
    artworkRefreshGeneration = null
    for (const job of artworkQueue.splice(0)) job.finish()
    for (const [key, entry] of artworkCache) if (entry.state.status === 'loading') artworkCache.delete(key)
  }
  async function resetScope(patch: Pick<Partial<LocalAlbumBrowserSnapshot>, 'query' | 'rootId' | 'filter'>): Promise<void> {
    galleryGeneration++; clearDetail(false); cancelArtworkRequests()
    publish({ ...patch, selectedAlbumIds: Object.freeze([]), items: Object.freeze([]), total: 0, hasMore: false, counts: emptyCounts(), loaded: false, status: 'idle', initialLoading: false, refreshing: false, loadingMore: false,
      error: '', refreshError: '', loadMoreError: '', stale: false, scrollTop: 0 })
    await readGallery('initial')
  }
  /** 同一次页面动作合并搜索、来源与筛选；只建立一个新代际和一次首页请求。 */
  async function setScope(scope: Pick<LocalAlbumQuery, 'query' | 'rootId' | 'filter'>): Promise<void> {
    if (disposed) return
    const keys = ['query','rootId','filter']
    if (!scope || typeof scope !== 'object' || ![Object.prototype,null].includes(Object.getPrototypeOf(scope)) || Reflect.ownKeys(scope).length !== keys.length
      || !keys.every(key => Object.hasOwn(scope,key)) || !Reflect.ownKeys(scope).every(key => typeof key === 'string' && keys.includes(key)
        && Object.getOwnPropertyDescriptor(scope,key)?.enumerable === true && Object.hasOwn(Object.getOwnPropertyDescriptor(scope,key)!, 'value'))) {
      publish({ error: '专辑浏览条件无效，请重新选择。' }); return
    }
    if (!isLocalCatalogText(scope.query, true) || Array.from(scope.query).length > 256) { publish({ error: '搜索最多输入 256 个字符，请缩短后再试。' }); return }
    if (scope.rootId !== null && !isCollectionId(scope.rootId)) { publish({ error: '来源选择无效，请重新选择。' }); return }
    if (!isFilter(scope.filter)) { publish({ error: '筛选条件无效，请重新选择。' }); return }
    const query = scope.query.trim()
    if (query === state.query && scope.rootId === state.rootId && scope.filter === state.filter && (state.loaded || state.initialLoading)) return
    await resetScope({ query, rootId: scope.rootId, filter: scope.filter })
  }
  async function search(query: string): Promise<void> {
    if (disposed) return
    if (!isLocalCatalogText(query, true) || Array.from(query).length > 256) { publish({ error: '搜索最多输入 256 个字符，请缩短后再试。' }); return }
    await setScope({ query, rootId: state.rootId, filter: state.filter })
  }
  async function setFilter(filter: LocalAlbumFilter): Promise<void> {
    if (disposed) return
    if (!isFilter(filter)) { publish({ error: '筛选条件无效，请重新选择。' }); return }
    await setScope({ query: state.query, rootId: state.rootId, filter })
  }
  async function setRoot(rootId: string | null): Promise<void> {
    if (disposed) return
    if (rootId !== null && !isCollectionId(rootId)) { publish({ error: '来源选择无效，请重新选择。' }); return }
    await setScope({ query: state.query, rootId, filter: state.filter })
  }
  async function openAlbum(album: LocalAlbumSummary, position: { scrollTop?: number } = {}): Promise<void> {
    if (!state.active || disposed || !isLocalAlbumSummary(album)) return
    detailGeneration++
    const scrollTop = typeof position.scrollTop === 'number' && Number.isFinite(position.scrollTop) ? Math.max(0, position.scrollTop) : state.scrollTop
    const returnTarget = state.returnTarget ?? Object.freeze({ albumKey: album.id, query: state.query, rootId: state.rootId, filter: state.filter, scrollTop })
    publish({ selectedAlbum: immutable(album), returnTarget, scrollTop, tracks: Object.freeze([]), trackTotal: 0, tracksHasMore: false, detailStatus: 'idle',
      detailError: '', detailRefreshError: '', detailLoadMoreError: '', detailStale: false, detailLoading: false, detailRefreshing: false, detailLoadingMore: false })
    await readDetail('initial')
  }
  /** 工作台原捕获可来自另一页；完整显示投影仍由同一公开读口返回，不能用描述符补造专辑。 */
  async function openAlbumReference(reference: { albumKey: string; rootId: string; revision: string }): Promise<void> {
    if (!state.active || disposed || !opaqueIdentity(reference.albumKey) || !isCollectionId(reference.rootId) || !opaqueIdentity(reference.revision)) return
    const expected = { ...reference }, generation = ++detailGeneration
    const request: LocalAlbumTrackQuery = { albumKey: expected.albumKey, rootId: expected.rootId, offset: 0, limit: trackPageSize }
    publish({ selectedAlbum: null, tracks: Object.freeze([]), trackTotal: 0, tracksHasMore: false, detailStatus: 'loading', detailLoading: true,
      detailError: '', detailRefreshError: '', detailLoadMoreError: '', detailStale: false })
    try {
      const reply = await options.api.queryAlbumTracks(request)
      if (!state.active || disposed || generation !== detailGeneration) return
      if (!isLocalAlbumTrackPage(reply, request, reply.album) || reply.album.revision !== expected.revision) throw new Error('原专辑读取修订已变化')
      const page = immutable(reply), returnTarget = state.returnTarget ?? Object.freeze({ albumKey: page.album.id, query: state.query, rootId: state.rootId, filter: state.filter, scrollTop: state.scrollTop })
      observeRevisions([page.album])
      publish({ selectedAlbum: page.album, tracks: page.items, trackTotal: page.total, tracksHasMore: page.hasMore, returnTarget,
        detailStatus: page.total ? 'ready' : 'empty', detailLoading: false, detailError: '' })
    } catch { if (state.active && !disposed && generation === detailGeneration) publish({ detailStatus: 'error', detailLoading: false, detailError: '此原捕获的曲目暂时无法读取，请核对专辑修订后重试。' }) }
  }
  function setSelectedAlbums(ids: readonly string[]): void {
    if (disposed || ids.length > 100 || new Set(ids).size !== ids.length || ids.some(id => !state.items.some(album => album.id === id))) return
    const current = state.selectedAlbumIds ?? []
    if (current.length === ids.length && current.every((id, index) => id === ids[index])) return
    publish({ selectedAlbumIds: Object.freeze([...ids]) })
  }
  function setScrollTop(scrollTop: number): void { if (!disposed && Number.isFinite(scrollTop)) publish({ scrollTop: Math.max(0, scrollTop) }) }
  async function refresh(revalidateArtwork = false): Promise<void> {
    if (disposed) return
    if (!state.active) { publish({ stale: state.loaded }); return }
    if (artworkRefreshPending) return artworkRefreshPending
    if (!revalidateArtwork) { await readGallery(state.loaded ? 'refresh' : 'initial'); return }
    const window = artworkWindow
    const albums = [...(state.selectedAlbum ? [state.selectedAlbum] : []), ...state.items]
    // 未挂窗口的调用者只校验已有RAM项；正式页面只探测当前可见/近邻，绝不遍历全库I/O。
    const targets = (window ? [...window.values()].map(interest => albums.find(album => sameArtworkRequest(artworkRequest(album), interest.request)))
      : [...artworkCache.values()].map(entry => albums.find(album => sameArtworkRequest(artworkRequest(album), entry.request))))
      .filter((album): album is LocalAlbumSummary => !!album).slice(0, LOCAL_ALBUM_ARTWORK_CACHE_ENTRIES)
    cancelArtworkRequests(); artworkWindow = window; artworkRefreshEpoch++
    const generation = artworkGeneration
    artworkRefreshGeneration = generation
    const work = (async () => {
      publish({ refreshing: true, refreshError: '', artworkInvalidation: Object.freeze({ epoch: ++artworkInvalidationEpoch, albumKey: null }) })
      // 先保住has/missing筛选的原可见成员，探测完才读取本次观察计数。
      await Promise.all(targets.map(album => ensureArtwork(album, true)))
      if (disposed || !state.active || generation !== artworkGeneration) return
      await readGallery(state.loaded ? 'refresh' : 'initial', true)
    })()
    artworkRefreshPending = work
    try { await work } finally { if (artworkRefreshPending === work) artworkRefreshPending = undefined }
  }
  async function refreshAlbum(revalidateArtwork = false): Promise<void> {
    const album = state.selectedAlbum
    if (disposed || !album) return
    if (!state.active) { publish({ detailStale: true }); return }
    if (artworkDetailRefreshPending) return artworkDetailRefreshPending
    if (!revalidateArtwork) { await readDetail(state.detailStatus === 'error' || state.detailStatus === 'idle' ? 'initial' : 'refresh'); return }
    const generation = detailGeneration, imageGeneration = artworkGeneration
    const work = (async () => {
      invalidateCachedArtwork(album.id); publish({ detailRefreshing: true, detailRefreshError: '' })
      await ensureArtwork(album, true)
      if (!currentDetail(generation, album) || imageGeneration !== artworkGeneration) return
      // 旧tuple被原守门拒绝仍继续读取详情；若身份确实更新，只按新五字段再探测一次。
      await readDetail(state.detailStatus === 'error' || state.detailStatus === 'idle' ? 'initial' : 'refresh')
      const latest = state.selectedAlbum
      if (!latest || !currentDetail(generation + 1, latest) || imageGeneration !== artworkGeneration) return
      if (!sameArtworkRequest(artworkRequest(album), artworkRequest(latest))) await ensureArtwork(latest, true)
    })()
    artworkDetailRefreshPending = work
    try { await work } finally { if (artworkDetailRefreshPending === work) artworkDetailRefreshPending = undefined }
  }

  function artworkPriority(request: LocalAlbumArtworkRequest): number {
    if (artworkWindow === null) return 1
    const interest = artworkWindow.get(request.albumKey)
    return interest && sameArtworkRequest(interest.request, request) ? interest.priority : 2
  }
  function setArtworkWindow(window: LocalAlbumArtworkWindow): void {
    if (disposed) return
    const next = new Map<string, { request: LocalAlbumArtworkRequest; priority: number }>()
    for (const [priority, albums] of [window.visible, window.nearby].entries()) {
      for (const album of albums) {
        if (next.size >= LOCAL_ALBUM_ARTWORK_CACHE_ENTRIES) break
        if (!isLocalAlbumSummary(album) || next.has(album.id)) continue
        const current = state.selectedAlbum?.id === album.id ? state.selectedAlbum : galleryAlbums.get(album.id)
        if (current && sameArtworkRequest(artworkRequest(current), artworkRequest(album))) next.set(album.id, { request: artworkRequest(album), priority })
      }
    }
    if (window.visible.length + window.nearby.length > 0 && next.size === 0) return
    if (artworkWindow && next.size === artworkWindow.size && [...next].every(([key, value]) => {
      const previous = artworkWindow!.get(key); return previous?.priority === value.priority && sameArtworkRequest(previous.request, value.request)
    })) return
    artworkWindow = next
    let changed = false
    for (let index = artworkQueue.length - 1; index >= 0; index--) {
      const job = artworkQueue[index]!
      if (artworkPriority(job.entry.request) !== 2) continue
      artworkQueue.splice(index, 1); job.finish()
      if (artworkCache.get(job.entry.request.albumKey) === job.entry) { artworkCache.delete(job.entry.request.albumKey); changed = true }
    }
    // 原读口无物理abort；只撤离窗的展示引用，flight索引继续持有同安全代的读取和结果。
    for (const [key, entry] of artworkCache) if (entry.state.status === 'loading' && artworkPriority(entry.request) === 2) { artworkCache.delete(key); changed = true }
    if (changed) publish()
    pumpArtwork()
  }
  function trimArtworkCache(): void {
    let bytes = [...artworkCache.values()].reduce((total, entry) => total + entry.bytes, 0)
    for (const [key, entry] of [...artworkCache].sort((left, right) => artworkPriority(right[1].request) - artworkPriority(left[1].request) || left[1].used - right[1].used)) {
      if (bytes <= artworkCacheBytes && artworkCache.size <= artworkCacheEntries) break
      if (entry.state.status !== 'loading') { emitRendererArtwork('ram-evict', traceKey(entry.request), { bytes: entry.bytes, reason: 'evicted' }); artworkCache.delete(key); bytes -= entry.bytes }
    }
  }
  function pumpArtwork(): void {
    while (!disposed && state.active && artworkRunning < artworkConcurrency && artworkQueue.length) {
      artworkQueue.sort((left, right) => artworkPriority(left.entry.request) - artworkPriority(right.entry.request))
      const job = artworkQueue.shift()!, entry = job.entry
      if (job.generation !== artworkGeneration || artworkCache.get(entry.request.albumKey) !== entry) { job.finish(); continue }
      artworkRunning++; artworkFlights.set(entry.request.albumKey, job)
      const currentFlight = (): boolean => {
        const album = state.selectedAlbum?.id === entry.request.albumKey ? state.selectedAlbum : galleryAlbums.get(entry.request.albumKey)
        return !disposed && state.active && job.generation === artworkGeneration && artworkFlights.get(entry.request.albumKey) === job
          && entry.refreshEpoch === artworkRefreshEpoch && !!album && sameArtworkRequest(artworkRequest(album), entry.request)
      }
      void (async () => {
        try {
          const readStarted = desktopArtworkStarted(); emitRendererArtwork('request', traceKey(entry.request))
          const reply = await options.api.getArtwork(entry.request)
          emitRendererArtwork('reply', traceKey(entry.request), { elapsedMs: desktopArtworkElapsed(readStarted) })
          if (!currentFlight()) { emitRendererArtwork('late', traceKey(entry.request)); return }
          if (!isLocalAlbumArtworkReply(reply, entry.request)) throw new Error('无效封面投影')
          artworkCache.set(entry.request.albumKey, entry)
          if (reply.status === 'source-unavailable') { entry.state = unavailableArtwork; entry.bytes = 0; entry.promise = undefined; trimArtworkCache(); publish(); return }
          const dataUrl = reply.image?.display.dataUrl ?? null
          const bytes = dataUrl ? dataUrl.length * 2 : 0
          if (bytes > artworkCacheBytes) throw new Error('封面超过显示缓存预算')
          entry.state = dataUrl ? Object.freeze({ status: 'ready', dataUrl, error: '', canRetry: false, ...(reply.image ? { display: Object.freeze({ sha256: reply.image.display.sha256, width: reply.image.display.width, height: reply.image.display.height, bytes: reply.image.display.bytes }) } : {}) }) : missingArtwork
          entry.bytes = bytes; entry.used = ++clock; entry.promise = undefined
          observeArtworkCount(entry.request, dataUrl !== null)
          trimArtworkCache(); publish()
        } catch {
          if (!currentFlight()) { emitRendererArtwork('late', traceKey(entry.request)); return }
          artworkCache.set(entry.request.albumKey, entry)
          entry.state = Object.freeze({ status: 'error', dataUrl: null, error: '封面暂时无法读取，可重试。已保存的封面选择保留。', canRetry: true })
          entry.bytes = 0; entry.promise = undefined; trimArtworkCache(); publish()
        } finally { if (artworkFlights.get(entry.request.albumKey) === job) artworkFlights.delete(entry.request.albumKey); artworkRunning--; job.finish(); pumpArtwork() }
      })()
    }
  }
  function artworkFor(album: LocalAlbumSummary): LocalAlbumArtworkState {
    const entry = artworkCache.get(album.id)
    if (entry && sameArtworkRequest(entry.request, artworkRequest(album))) return entry.state
    return artworkState(album) === 'missing' ? missingArtwork : artworkState(album) === 'source-unavailable' ? unavailableArtwork : idleArtwork
  }
  function ensureArtwork(album: LocalAlbumSummary, explicitRetry = false): Promise<void> {
    if (!state.active || disposed || !isLocalAlbumSummary(album)) return Promise.resolve()
    const original = artworkRequest(album), cached = artworkCache.get(album.id)
    const current = state.selectedAlbum?.id === album.id ? state.selectedAlbum : galleryAlbums.get(album.id)
    if (!explicitRetry && (!current || !sameArtworkRequest(artworkRequest(current), original))) return Promise.resolve()
    if (!explicitRetry && artworkDetailRefreshPending && state.selectedAlbum?.id === album.id && state.selectedAlbum.rootId === album.rootId) return artworkDetailRefreshPending
    if (!explicitRetry && artworkPriority(original) === 2) return Promise.resolve()
    const sameCached = !!cached && sameArtworkRequest(cached.request, original)
    // 既有失败仍走原重试门；刷新代只让未校验的成功/缺图在入窗时获得一次探测资格。
    const revalidate = explicitRetry || artworkRefreshGeneration === artworkGeneration && artworkRefreshEpoch > 0 && (!sameCached && artworkState(album) === 'missing'
      || sameCached && cached.refreshEpoch !== artworkRefreshEpoch && (cached.state.status === 'ready' || cached.state.status === 'missing'))
    const request: LocalAlbumArtworkRequest = revalidate ? { ...original, refresh: true } : original
    const flight = artworkFlights.get(album.id)
    if (flight && flight.generation === artworkGeneration && flight.entry.refreshEpoch === artworkRefreshEpoch
      && sameArtworkRequest(flight.entry.request, request) && (!revalidate || flight.entry.request.refresh === true)) {
      emitRendererArtwork('inflight-join', traceKey(request))
      flight.entry.used = ++clock; artworkCache.set(album.id, flight.entry); trimArtworkCache(); publish()
      return flight.entry.promise ?? Promise.resolve()
    }
    if (sameCached && cached.state.status === 'loading' && (!revalidate || cached.request.refresh === true)) {
      emitRendererArtwork('inflight-join', traceKey(request)); cached.used = ++clock; return cached.promise ?? Promise.resolve()
    }
    // 显式刷新不挂回未经刷新的旧读取；其真实槽位仍由原finally归还。
    if (revalidate && flight) invalidateCachedArtwork(album.id)
    if (sameCached && !revalidate) { emitRendererArtwork('ram-hit', traceKey(original), { bytes: cached.bytes }); cached.used = ++clock; return cached.promise ?? Promise.resolve() }
    if (artworkState(album) === 'missing' && !revalidate) {
      if (cached && sameArtworkRequest(cached.request, request) && cached.state.status === 'missing') return Promise.resolve()
      artworkCache.set(album.id, { request, state: missingArtwork, bytes: 0, used: ++clock, refreshEpoch: artworkRefreshEpoch }); trimArtworkCache(); publish(); return Promise.resolve()
    }
    if (artworkState(album) === 'source-unavailable' && !revalidate) { artworkCache.set(album.id, { request, state: unavailableArtwork, bytes: 0, used: ++clock, refreshEpoch: artworkRefreshEpoch }); trimArtworkCache(); publish(); return Promise.resolve() }
    if ([...artworkCache.values()].filter(entry => entry.state.status === 'loading').length >= artworkCacheEntries) return Promise.resolve()
    let finish!: () => void
    const promise = new Promise<void>(resolve => { finish = resolve })
    const entry: ArtworkEntry = { request, state: Object.freeze({ status: 'loading', dataUrl: null, error: '', canRetry: false }), bytes: 0, used: ++clock, refreshEpoch: artworkRefreshEpoch, promise }
    emitRendererArtwork('queue', traceKey(request)); artworkCache.set(album.id, entry); artworkQueue.push({ entry, generation: artworkGeneration, finish }); trimArtworkCache(); publish(); pumpArtwork()
    return promise
  }
  async function retryArtwork(album: LocalAlbumSummary): Promise<void> {
    if (disposed) return
    const generation = artworkGeneration
    const sourceWasUnavailable = artworkFor(album) === unavailableArtwork
    invalidateCachedArtwork(album.id); publish()
    if (sourceWasUnavailable) await Promise.all([refresh(), state.selectedAlbum?.id === album.id ? refreshAlbum() : Promise.resolve()])
    if (disposed || !state.active || generation !== artworkGeneration) return
    const latest = state.selectedAlbum?.id === album.id ? state.selectedAlbum : state.items.find(item => item.id === album.id && item.rootId === album.rootId) ?? album
    await ensureArtwork(latest, true)
  }
  async function invalidateArtwork(albumKey?: string): Promise<void> {
    if (disposed) return
    if (albumKey !== undefined && !opaqueIdentity(albumKey)) return
    if (albumKey) invalidateCachedArtwork(albumKey)
    else { cancelArtworkRequests(); artworkCache.clear() }
    publish({ artworkInvalidation: Object.freeze({ epoch: ++artworkInvalidationEpoch, albumKey: albumKey ?? null }), stale: state.loaded,
      ...(state.selectedAlbum && (!albumKey || state.selectedAlbum.id === albumKey) ? { detailStale: true } : {}) })
    await Promise.all([refresh(), state.selectedAlbum && (!albumKey || state.selectedAlbum.id === albumKey) ? refreshAlbum() : Promise.resolve()])
  }
  async function activate(): Promise<void> {
    if (disposed || state.active) return
    publish({ active: true })
    await Promise.all([state.loaded ? readGallery('refresh') : readGallery('initial'),
      state.selectedAlbum && (state.detailStale || state.detailStatus === 'idle') ? readDetail(state.detailStatus === 'idle' ? 'initial' : 'refresh') : Promise.resolve()])
  }
  function deactivate(releaseArtwork = false): void {
    if (disposed || !state.active) return
    galleryGeneration++; detailGeneration++; cancelArtworkRequests()
    // 独立页面保留浏览位置，离页释放显示图；两页不能各自占用一份完整封面缓存。
    if (releaseArtwork) artworkCache.clear()
    publish({ active: false, initialLoading: false, refreshing: false, loadingMore: false, detailLoading: false, detailRefreshing: false, detailLoadingMore: false,
      stale: state.stale || state.refreshing, detailStale: state.detailStale || state.detailRefreshing,
      status: state.loaded ? state.status : 'idle', detailStatus: state.detailStatus === 'loading' ? 'idle' : state.detailStatus,
      ...(releaseArtwork ? { artworkInvalidation: Object.freeze({ epoch: ++artworkInvalidationEpoch, albumKey: null }) } : {}) })
  }
  function dispose(): void { if (disposed) return; deactivate(); disposed = true; artworkCache.clear(); publish() }
  return { getSnapshot: () => state, activate, deactivate, dispose, setScope, search, setFilter, setRoot, refresh, loadMore: () => readGallery('more'),
    openAlbum, openAlbumReference, closeAlbum: () => clearDetail(true), refreshAlbum, loadMoreTracks: () => readDetail('more'), setSelectedAlbums, setScrollTop, artworkFor, setArtworkWindow, ensureArtwork, retryArtwork, invalidateArtwork,
    getArtworkCacheUsage: () => ({ entries: artworkCache.size, bytes: [...artworkCache.values()].reduce((total, entry) => total + entry.bytes, 0), running: artworkRunning, queued: artworkQueue.length }) }
}
