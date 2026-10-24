import { computed, reactive, ref, shallowRef } from 'vue'
import type { LocalArtistSummary, LocalSearchPlayContext } from '@music-bridge/contracts'
import type { SidebarSearchSuggestion } from '../../components/sidebar/sidebar-search-model.js'
import { readPublicIpcErrorCode } from '../../roonLibraryMessages.js'
import { catalogPreparationMessage, createCatalogPreparationWaiters } from './catalog-preparation-wait.js'
import { catalogKinds, catalogSources, groupCatalogArtists, interleaveCatalogItems, localArtistItem, mergeCatalogPage,
  type CatalogCategory, type CatalogItem, type CatalogKind, type CatalogPage, type CatalogSource } from './catalog-presentation.js'

export interface CatalogArtistProfile {
  artist: LocalArtistSummary
  artworkUrl?: string
  biography?: string
  credit?: string
  linkState?: string
}
export interface CatalogDataPort {
  search(source: CatalogSource, kind: CatalogKind, query: string, page: { offset: number; limit: number }): Promise<CatalogPage>
  suggest(query: string): Promise<readonly string[]>
  artists(query: string, page: { offset: number; limit: number }): Promise<CatalogPage>
  artist(artistId: string): Promise<CatalogArtistProfile>
  artistAlbums(artistId: string, relation: 'albums' | 'appearsOn', page: { offset: number; limit: number }): Promise<CatalogPage>
  artistTracks(artistId: string, page: { offset: number; limit: number }): Promise<CatalogPage>
  remoteDetail(item: CatalogItem, page: { offset: number; limit: number }): Promise<CatalogPage>
  artistMatches(artistId: string, query: string): Promise<readonly CatalogItem[]>
  bindArtist(artistId: string, neteaseArtistId: string | null): Promise<CatalogArtistProfile>
}
export interface CatalogSection {
  items: CatalogItem[]
  loading: boolean
  preparing: boolean
  error: string
  hasMore: boolean
  total?: number
  nextOffset: number
  revision?: string
  /** 详情重读保留实际请求类型，失败重试与离页恢复不能把首页刷新变成续页。 */
  readOperation?: 'refresh' | 'append'
}
export interface CatalogDetail {
  item: CatalogItem
  profile: CatalogArtistProfile | null
  profileLoading: boolean
  profilePreparing: boolean
  profileError: string
  albums: CatalogSection
  appearsOn: CatalogSection
  tracks: CatalogSection
}
/** 仅同一 Renderer 的一次返回路径；不持有来源权限，也不重放查询或写操作。 */
export interface CatalogReturnLocation {
  label: string
  isCurrent(): boolean
  restore(): boolean
}
export function emptyCatalogSection(): CatalogSection { return { items: [], loading: false, preparing: false, error: '', hasMore: false, nextOffset: 0 } }
export function catalogFailureMessage(error: unknown): string {
  const code = readPublicIpcErrorCode(error), message = error instanceof Error ? error.message : ''
  if (code === 'ARTIST_INDEX_WAIT_LIMIT') return 'Mac仍在准备本地艺术家与搜索，请稍后重试。'
  if (code === 'AUTH_REQUIRED' || message === 'Provider login required') return '请先登录音乐服务，再读取这个来源。'
  if (code === 'AUTH_EXPIRED' || message === 'Provider session expired') return '音乐服务登录已过期，请重新登录。'
  if (code === 'SOURCE_CHANGED' || code === 'SNAPSHOT_CHANGED' || code === 'DATASET_CHANGED') return '资料已经变化，请重新读取后继续。'
  if (code === 'ROON_NOT_PAIRED' || code === 'ROON_CORE_NOT_CONNECTED' || code === 'ROON_LIBRARY_UNAVAILABLE') return 'Roon 尚未连接，请检查 Core 后重试。'
  if (code === 'NOT_READY') return '音乐库尚未就绪，请稍后重新读取。'
  if (code === 'TIMEOUT') return '读取超时，请重试这个来源。'
  return '这个来源暂时不可用，请重试。'
}
function cells() { return Object.fromEntries(catalogSources.map(source => [source, Object.fromEntries(catalogKinds.map(kind => [kind, emptyCatalogSection()]))])) as Record<CatalogSource, Record<CatalogKind, CatalogSection>> }

export function useCatalogExperience(port: CatalogDataPort) {
  let disposed = false, generation = 0, previewGeneration = 0, detailGeneration = 0, artistGeneration = 0, matchGeneration = 0
  const waiters = createCatalogPreparationWaiters()
  let workspace: { mode: 'artists' | 'search'; token: symbol } | undefined
  const sourceEpoch = { local: 0, netease: 0, roon: 0 }
  const searchReadEpoch = { local: 0, netease: 0, roon: 0 }
  const query = ref(''), draft = ref(''), category = ref<CatalogCategory>('all'), sourceFilter = ref<CatalogSource | 'all'>('all')
  const searchSections = reactive(cells())
  const library = reactive(emptyCatalogSection()), artistQuery = ref('')
  const artistSource = ref<'local' | 'roon'>('local')
  const detail = shallowRef<CatalogDetail | null>(null)
  const previewSections = reactive(cells()), previewQuery = ref(''), previewKeywords = ref<readonly string[]>([]), previewPending = ref(0), previewErrors = ref(0)
  const previewPreparing = reactive({ artists: false, albums: false, tracks: false })
  const previewPreparationExpired = ref(false)
  const bindingOpen = ref(false), matches = shallowRef<readonly CatalogItem[]>([]), matchQuery = ref(''), matchesLoading = ref(false), matchError = ref(''), bindingBusy = ref(false), bindingError = ref('')
  const matchesPreparing = ref(false)
  const uncertainBindings = new Set<string>(), pendingBindings = new Set<string>()
  const uncertainBindingMessage = '关联结果尚未确认。请先重新读取艺术家资料，再决定下一步。'
  const previewItemByKey = new Map<string, CatalogItem>()
  const suggestions = computed<SidebarSearchSuggestion[]>(() => {
    previewItemByKey.clear()
    const entries = interleaveCatalogItems(catalogSources.map(source => catalogKinds.flatMap(kind => previewSections[source][kind].items.slice(0, 1)))).slice(0, 9)
    const result: SidebarSearchSuggestion[] = entries.map(item => {
      previewItemByKey.set(item.key, item)
      return { key: item.key, source: item.source, kind: item.kind === 'artists' ? 'artist' : item.kind === 'albums' ? 'album' : 'track', title: item.title, subtitle: item.subtitle, artworkUrl: item.artworkUrl, artworkReference: item.artworkReference }
    })
    for (const keyword of previewKeywords.value.filter(value => value.trim() && value.trim() !== previewQuery.value).slice(0, 2)) result.push({ key: `keyword:${keyword}`, kind: 'keyword', source: 'netease', title: keyword, subtitle: '搜索建议' })
    return result
  })
  const previewMessage = computed(() => Object.values(previewPreparing).some(Boolean) ? catalogPreparationMessage
    : previewPreparationExpired.value ? 'Mac仍在准备本地艺术家与搜索，请稍后重试。' : previewErrors.value ? '部分来源暂时不可用，仍可查看全部结果。' : '')
  const selectedSources = computed(() => sourceFilter.value === 'all' ? catalogSources : [sourceFilter.value])
  const visibleItems = (kind: CatalogKind) => interleaveCatalogItems(selectedSources.value.map(source => searchSections[source][kind].items))
  const artistCards = computed(() => groupCatalogArtists(visibleItems('artists'), selectedSources.value))
  const albumItems = computed(() => visibleItems('albums'))
  const trackItems = computed(() => visibleItems('tracks'))
  const libraryCards = computed(() => groupCatalogArtists(library.items))

  function publish(section: CatalogSection, page: CatalogPage, append = false): void {
    if (append && section.revision && page.revision && section.revision !== page.revision) throw new Error('查询资料已经变化，请重新读取。')
    const next = page.nextOffset ?? page.offset + page.items.length
    if (page.hasMore && next <= page.offset) throw new Error('后续页面没有取得进展，请重新读取。')
    section.items = append ? mergeCatalogPage(section.items, page) : [...page.items]
    section.total = page.total; section.hasMore = page.hasMore; section.nextOffset = next; section.revision = page.revision; section.error = ''
  }
  function resetSections(target: ReturnType<typeof cells>): void { for (const source of catalogSources) for (const kind of catalogKinds) Object.assign(target[source][kind], emptyCatalogSection()) }
  async function readSearch(source: CatalogSource, kind: CatalogKind, append = false): Promise<void> {
    const section = searchSections[source][kind]
    if (disposed || section.loading || append && !section.hasMore || !query.value) return
    const current = generation, epoch = sourceEpoch[source], readEpoch = searchReadEpoch[source], selectedQuery = query.value, offset = append ? section.nextOffset : 0
    const valid = () => !disposed && current === generation && epoch === sourceEpoch[source] && readEpoch === searchReadEpoch[source] && selectedQuery === query.value
    section.loading = true; section.error = ''
    try {
      const page = await waiters.read({ scope: 'search', source, current: valid, preparing: value => { section.preparing = value },
        operation: () => port.search(source, kind, selectedQuery, { offset, limit: 24 }) })
      if (!page || !valid()) return
      publish(section, page, append)
    } catch (error) { if (valid()) section.error = catalogFailureMessage(error) }
    finally { if (valid()) section.loading = false }
  }
  async function search(value: string): Promise<void> {
    waiters.cancel('search'); invalidatePreview(value)
    generation++; query.value = value.trim(); draft.value = value; category.value = 'all'; sourceFilter.value = 'all'; closeDetail(); resetSections(searchSections)
    if (!query.value || disposed) return
    await Promise.allSettled(catalogSources.flatMap(source => catalogKinds.map(kind => readSearch(source, kind))))
  }
  function invalidatePreview(value = ''): void {
    waiters.cancel('preview'); Object.assign(previewPreparing, { artists: false, albums: false, tracks: false })
    previewPreparationExpired.value = false
    previewGeneration++; previewQuery.value = ''; previewPending.value = 0; previewErrors.value = 0; previewKeywords.value = []; resetSections(previewSections); draft.value = value
  }
  async function preview(value: string): Promise<void> {
    const q = value.trim()
    if (!q || disposed || q === previewQuery.value) return
    waiters.cancel('preview'); Object.assign(previewPreparing, { artists: false, albums: false, tracks: false })
    previewPreparationExpired.value = false
    const current = ++previewGeneration; previewQuery.value = q; previewErrors.value = 0; previewKeywords.value = []; resetSections(previewSections)
    previewPending.value = catalogSources.length * catalogKinds.length + 1
    const read = async (source: CatalogSource, kind: CatalogKind) => {
      const epoch = sourceEpoch[source]
      try {
        const page = await waiters.read({ scope: 'preview', source, current: () => !disposed && current === previewGeneration && epoch === sourceEpoch[source],
          preparing: value => { if (source === 'local') previewPreparing[kind] = value },
          operation: () => port.search(source, kind, q, { offset: 0, limit: 3 }) })
        if (page && !disposed && current === previewGeneration && epoch === sourceEpoch[source]) publish(previewSections[source][kind], page)
      } catch (error) {
        if (!disposed && current === previewGeneration) {
          if (readPublicIpcErrorCode(error) === 'ARTIST_INDEX_WAIT_LIMIT') previewPreparationExpired.value = true
          else previewErrors.value++
        }
      }
      finally { if (!disposed && current === previewGeneration) previewPending.value-- }
    }
    const keywords = async () => {
      const epoch = sourceEpoch.netease
      try { const result = await port.suggest(q); if (!disposed && current === previewGeneration && epoch === sourceEpoch.netease) previewKeywords.value = result }
      catch { /* 联想词失败不影响真实实体结果。 */ }
      finally { if (!disposed && current === previewGeneration) previewPending.value-- }
    }
    await Promise.allSettled([...catalogSources.flatMap(source => catalogKinds.map(kind => read(source, kind))), keywords()])
  }
  function previewItem(key: string): CatalogItem | undefined { return previewItemByKey.get(key) }
  function localPlaybackContext(item: CatalogItem, selectedQuery: string): LocalSearchPlayContext | undefined {
    const selected = detail.value
    if (selected?.item.identity.type === 'local-artist' && selected.tracks.revision && selected.tracks.items.some(value => value.key === item.key)) {
      return { kind: 'artist', artistId: selected.item.identity.value.id, revision: selected.tracks.revision }
    }
    const section = selectedQuery === query.value && searchSections.local.tracks.items.some(value => value.key === item.key) ? searchSections.local.tracks
      : selectedQuery === previewQuery.value && previewSections.local.tracks.items.some(value => value.key === item.key) ? previewSections.local.tracks : undefined
    return section?.revision ? { kind: 'search', query: selectedQuery, revision: section.revision } : undefined
  }

  async function loadArtists(value = artistQuery.value, append = false): Promise<void> {
    if (disposed || append && (library.loading || !library.hasMore)) return
    if (!append) { waiters.cancel('library'); artistGeneration++; artistQuery.value = value; Object.assign(library, emptyCatalogSection()) }
    const current = artistGeneration, selectedQuery = artistQuery.value.trim(), offset = append ? library.nextOffset : 0
    library.loading = true; library.error = ''
    try {
      const page = await waiters.read({ scope: 'library', source: 'local', current: () => !disposed && current === artistGeneration,
        preparing: value => { library.preparing = value }, operation: () => port.artists(selectedQuery, { offset, limit: 48 }) })
      if (page && !disposed && current === artistGeneration) publish(library, page, append)
    }
    catch (error) { if (!disposed && current === artistGeneration) library.error = catalogFailureMessage(error) }
    finally { if (!disposed && current === artistGeneration) library.loading = false }
  }
  function closeDetail(): void { waiters.cancel('detail'); waiters.cancel('matches'); detailGeneration++; detail.value = null; bindingOpen.value = false; matchGeneration++; matches.value = []; matchesLoading.value = false; matchesPreparing.value = false; bindingError.value = ''; bindingBusy.value = false }
  function captureReturnLocation(mode: 'artists' | 'search'): CatalogReturnLocation {
    const selected = detail.value, selectedQuery = query.value, selectedArtistQuery = artistQuery.value
    const selectedCategory = category.value, selectedSource = sourceFilter.value, selectedArtistSource = artistSource.value
    const epoch = selected ? sourceEpoch[selected.item.source] : null
    const pendingProfile = selected?.profileLoading ?? false
    const pendingSections = (['albums', 'appearsOn', 'tracks'] as const).filter(kind => selected?.[kind].loading)
    let available = true, restoredEpoch: Record<CatalogSource, number> | undefined
    const isCurrent = () => !disposed && query.value === selectedQuery
      && (mode !== 'artists' || artistQuery.value === selectedArtistQuery)
      && category.value === selectedCategory && sourceFilter.value === selectedSource && artistSource.value === selectedArtistSource
      && (!restoredEpoch || catalogSources.every(source => sourceEpoch[source] === restoredEpoch![source]))
    return {
      label: selected ? `返回${selected.item.title}` : mode === 'search' ? '返回搜索结果' : '返回艺术家',
      isCurrent,
      restore() {
        if (!available || !isCurrent()) return false
        available = false
        category.value = selectedCategory; sourceFilter.value = selectedSource; artistSource.value = selectedArtistSource
        closeDetail()
        restoredEpoch = { ...sourceEpoch }
        // 失效来源不能借返回路径复活；原列表/搜索的错误和水位继续由当前模型管理。
        if (!selected || sourceEpoch[selected.item.source] !== epoch) return true
        const resumeProfile = pendingProfile && selected.profileLoading
        const resumeSections = pendingSections.filter(kind => selected[kind].loading)
        selected.profileLoading = false; selected.profilePreparing = false
        for (const kind of ['albums', 'appearsOn', 'tracks'] as const) { selected[kind].loading = false; selected[kind].preparing = false }
        detail.value = selected
        if (selected.item.identity.type === 'local-artist') {
          const id = selected.item.identity.value.id
          bindingBusy.value = pendingBindings.has(id); bindingError.value = uncertainBindings.has(id) ? uncertainBindingMessage : ''
        }
        // 已加载的分页与 nextOffset 留在原对象；只恢复离页时尚未完成的只读项。
        for (const kind of resumeSections) void readDetailSection(kind, selected[kind].readOperation === 'append')
        if (resumeProfile) void refreshProfile()
        return true
      },
    }
  }
  function publishProfile(selected: CatalogDetail, profile: CatalogArtistProfile): void {
    selected.profile = profile; selected.item = localArtistItem(profile.artist, profile.artworkUrl)
    const replace = (items: CatalogItem[]) => items.map(item => item.key === selected.item.key ? selected.item : item)
    library.items = replace(library.items); searchSections.local.artists.items = replace(searchSections.local.artists.items)
    previewSections.local.artists.items = replace(previewSections.local.artists.items)
  }
  async function readDetailSection(kind: 'albums' | 'appearsOn' | 'tracks', append = false): Promise<void> {
    const selected = detail.value, current = detailGeneration
    if (!selected || disposed) return
    const section = selected[kind]
    if (section.loading || append && (!section.hasMore || section.readOperation === 'refresh' && !!section.error)) return
    section.readOperation = append ? 'append' : 'refresh'
    section.loading = true; section.error = ''
    try {
      const identity = selected.item.identity, page = { offset: append ? section.nextOffset : 0, limit: 24 }
      const result = await waiters.read({ scope: 'detail', source: selected.item.source,
        current: () => !disposed && current === detailGeneration && detail.value === selected, preparing: value => { section.preparing = value },
        operation: () => identity.type === 'local-artist' ? kind === 'tracks' ? port.artistTracks(identity.value.id, page)
          : port.artistAlbums(identity.value.id, kind, page) : port.remoteDetail(selected.item, page) })
      if (result && !disposed && current === detailGeneration && detail.value === selected) publish(section, result, append)
    } catch (error) { if (!disposed && current === detailGeneration) section.error = catalogFailureMessage(error) }
    finally { if (!disposed && current === detailGeneration) section.loading = false }
  }
  async function openDetail(item: CatalogItem): Promise<void> {
    closeDetail(); const current = detailGeneration
    const selected: CatalogDetail = reactive({ item, profile: null, profileLoading: item.identity.type === 'local-artist', profilePreparing: false, profileError: '', albums: emptyCatalogSection(), appearsOn: emptyCatalogSection(), tracks: emptyCatalogSection() })
    detail.value = selected
    const work: Promise<unknown>[] = [readDetailSection('tracks')]
    if (item.identity.type === 'local-artist') {
      const id = item.identity.value.id
      bindingBusy.value = pendingBindings.has(id)
      bindingError.value = uncertainBindings.has(id) ? uncertainBindingMessage : ''
      work.push(readDetailSection('albums'), readDetailSection('appearsOn'), (async () => {
        try {
          const profile = await waiters.read({ scope: 'detail', source: 'local', current: () => !disposed && current === detailGeneration,
            preparing: value => { selected.profilePreparing = value }, operation: () => port.artist(id) })
          if (profile && !disposed && current === detailGeneration) { publishProfile(selected, profile); if (!pendingBindings.has(id)) { uncertainBindings.delete(id); bindingError.value = '' } }
        }
        catch (error) { if (!disposed && current === detailGeneration) selected.profileError = catalogFailureMessage(error) }
        finally { if (!disposed && current === detailGeneration) selected.profileLoading = false }
      })())
    }
    await Promise.allSettled(work)
  }
  async function loadMatches(value = matchQuery.value): Promise<void> {
    const selected = detail.value
    if (!selected || selected.item.identity.type !== 'local-artist' || disposed) return
    waiters.cancel('matches')
    const id = selected.item.identity.value.id, current = ++matchGeneration
    matchQuery.value = value; matchesLoading.value = true; matchError.value = ''; matches.value = []
    try {
      const result = await waiters.read({ scope: 'matches', source: 'local', current: () => !disposed && current === matchGeneration && bindingOpen.value,
        preparing: value => { matchesPreparing.value = value }, operation: () => port.artistMatches(id, value.trim()) })
      if (result && !disposed && current === matchGeneration && bindingOpen.value) matches.value = result
    }
    catch (error) { if (!disposed && current === matchGeneration) matchError.value = catalogFailureMessage(error) }
    finally { if (!disposed && current === matchGeneration) matchesLoading.value = false }
  }
  function openBinding(): void { const selected = detail.value; if (selected?.item.identity.type !== 'local-artist') return; bindingOpen.value = true; matchQuery.value = selected.item.title; void loadMatches() }
  function closeBinding(): void { if (bindingBusy.value) return; waiters.cancel('matches'); bindingOpen.value = false; matchGeneration++; matchesLoading.value = false; matchesPreparing.value = false }
  async function bind(neteaseId: string | null): Promise<void> {
    const selected = detail.value, current = detailGeneration
    if (!selected || selected.item.identity.type !== 'local-artist' || bindingBusy.value || bindingError.value) return
    const id = selected.item.identity.value.id
    if (pendingBindings.has(id) || uncertainBindings.has(id)) return
    pendingBindings.add(id); uncertainBindings.add(id)
    bindingBusy.value = true; bindingError.value = ''
    try {
      const profile = await port.bindArtist(id, neteaseId)
      uncertainBindings.delete(id)
      if (disposed || current !== detailGeneration) return
      publishProfile(selected, profile)
      bindingOpen.value = false
    } catch { if (!disposed && current === detailGeneration) bindingError.value = uncertainBindingMessage }
    finally {
      pendingBindings.delete(id)
      if (!disposed && detail.value?.item.identity.type === 'local-artist' && detail.value.item.identity.value.id === id) {
        bindingBusy.value = false; bindingError.value = uncertainBindings.has(id) ? uncertainBindingMessage : ''
      }
    }
  }
  async function refreshProfile(): Promise<void> {
    const selected = detail.value, current = detailGeneration
    if (!selected || selected.item.identity.type !== 'local-artist' || bindingBusy.value) return
    const id = selected.item.identity.value.id
    selected.profileLoading = true
    try {
      const profile = await waiters.read({ scope: 'detail', source: 'local', current: () => !disposed && current === detailGeneration,
        preparing: value => { selected.profilePreparing = value }, operation: () => port.artist(id) })
      if (profile && !disposed && current === detailGeneration) { publishProfile(selected, profile); uncertainBindings.delete(id); bindingError.value = ''; selected.profileError = '' }
    } catch (error) { if (!disposed && current === detailGeneration) selected.profileError = catalogFailureMessage(error) }
    finally { if (!disposed && current === detailGeneration) selected.profileLoading = false }
  }
  function invalidateSource(source: CatalogSource): void {
    waiters.cancel(undefined, source)
    sourceEpoch[source]++
    for (const kind of catalogKinds) { Object.assign(searchSections[source][kind], emptyCatalogSection(), { error: query.value ? '来源已变化，请重新读取。' : '' }); Object.assign(previewSections[source][kind], emptyCatalogSection()) }
    if (source === 'netease') previewKeywords.value = []
    if (source === 'local') { previewPreparationExpired.value = false; Object.assign(previewPreparing, { artists: false, albums: false, tracks: false }); artistGeneration++; Object.assign(library, emptyCatalogSection()); if (detail.value?.item.source === 'local') closeDetail() }
    else if (detail.value?.item.source === source) closeDetail()
  }
  function stopArtists(): void { waiters.cancel('library'); artistGeneration++; library.loading = false; library.preparing = false }
  function stopWorkspaceReads(mode: 'artists' | 'search'): void {
    if (mode === 'artists') stopArtists()
    else { waiters.cancel('search'); generation++; for (const source of catalogSources) for (const kind of catalogKinds) { searchSections[source][kind].loading = false; searchSections[source][kind].preparing = false } }
  }
  function activateWorkspace(mode: 'artists' | 'search', token: symbol): void {
    if (workspace && workspace.mode !== mode) stopWorkspaceReads(workspace.mode)
    workspace = { mode, token }
  }
  function suspendWorkspace(mode: 'artists' | 'search', token?: symbol): void {
    // Vue旧页面的unmounted可晚于新页面setup，旧清理不能取消新页面的读取或详情。
    if (token && workspace?.token !== token) return
    stopWorkspaceReads(mode); workspace = undefined; closeDetail()
  }
  function resumeSearch(): void { if (query.value && !disposed) for (const source of selectedSources.value) for (const kind of catalogKinds) if (!searchSections[source][kind].items.length && !searchSections[source][kind].error) void readSearch(source, kind) }
  function selectSource(source: CatalogSource | 'all'): void {
    sourceFilter.value = source
    for (const hidden of catalogSources) if (source !== 'all' && source !== hidden) {
      waiters.cancel('search', hidden); searchReadEpoch[hidden]++
      for (const kind of catalogKinds) { searchSections[hidden][kind].loading = false; searchSections[hidden][kind].preparing = false }
    }
    resumeSearch()
  }
  function dispose(): void { disposed = true; generation++; previewGeneration++; detailGeneration++; artistGeneration++; matchGeneration++; waiters.dispose() }
  return { query, draft, category, sourceFilter, artistSource, searchSections, selectedSources, artistCards, albumItems, trackItems, library, artistQuery, libraryCards,
    detail, suggestions, previewPending, previewMessage, previewKeywords, bindingOpen, matches, matchQuery, matchesLoading, matchesPreparing, matchError, bindingBusy, bindingError, preparationMessage: catalogPreparationMessage,
    search, readSearch, preview, invalidatePreview, previewItem, localPlaybackContext, loadArtists, stopArtists, activateWorkspace, suspendWorkspace, resumeSearch, selectSource, captureReturnLocation, closeDetail, openDetail, readDetailSection, openBinding, closeBinding, loadMatches, bind, refreshProfile, invalidateSource, dispose }
}
