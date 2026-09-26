import { computed, nextTick, ref } from 'vue'
import type { RoonLibraryItem } from '@music-bridge/contracts'
import type { SidebarSource, ViewId } from '../../components/navigation.js'
import { useSidebarState } from '../useSidebarState.js'
import type { useAggregatedSearch } from './useAggregatedSearch.js'
import type { useRoonBrowse } from './useRoonBrowse.js'

export interface LibraryJourneyPort {
  hasLikedItems: () => boolean
  isPlaylistReady: () => boolean
  getPlaylistScrollTop: () => number
  setPlaylistScrollTop: (top: number) => void
  loadLiked: () => Promise<void>
  loadPlaylists: () => Promise<void>
  loadPlaylist: (playlistId: string) => Promise<void>
}

export type SearchJourneyPort = Pick<ReturnType<typeof useAggregatedSearch>,
  | 'searchQuery' | 'searchPage' | 'searchSongsOpen' | 'searchScrollTop'
  | 'scheduleSearch' | 'resetSearch'
>

export type BrowseJourneyPort = Pick<ReturnType<typeof useRoonBrowse>,
  | 'roonAlbumsPage' | 'roonAlbumsInitialLoading' | 'roonAlbumsError' | 'loadRoonAlbums'
  | 'roonArtistsPage' | 'roonArtistsInitialLoading' | 'roonArtistsError' | 'loadRoonArtists'
  | 'roonGenresPage' | 'roonGenresInitialLoading' | 'roonGenresError' | 'loadRoonGenres'
  | 'roonPlaylistsPage' | 'roonPlaylistsInitialLoading' | 'roonPlaylistsError' | 'loadRoonPlaylists'
  | 'favoritesPage' | 'favoritesInitialLoading' | 'loadFavorites'
  | 'localAlbumQuery' | 'localArtistQuery' | 'setLocalAlbumQuery' | 'setLocalArtistQuery'
  | 'resetRoonAlbums' | 'resetRoonArtists' | 'invalidateAlbumArtistRequests'
  | 'loadRoonAlbum' | 'loadRoonArtist' | 'loadRoonGenre' | 'loadRoonPlaylist'
  | 'selectedRoonAlbum' | 'selectedRoonArtist' | 'loadRoonEntityFavorite'
  | 'captureDetail' | 'restoreDetail' | 'leaveDetail'
>

export interface PageJourneyOptions {
  search: SearchJourneyPort
  browse: BrowseJourneyPort
  library: LibraryJourneyPort
  onPlayRoonTrack: (item: RoonLibraryItem) => void
  onCloseInspector: () => void
  onClearActionError: () => void
}

export function usePageJourney(options: PageJourneyOptions) {
  const { search, browse, library, onPlayRoonTrack, onCloseInspector, onClearActionError } = options
  const currentView = ref<ViewId>('home')
  const nowPlayingReturnView = ref<ViewId>('home')
  const sidebar = useSidebarState()
  const searchReturnSource = ref<SidebarSource>({ type: 'home' })
  const roonSearchOrigin = ref(false)
  const contentScroll = ref<HTMLElement | null>(null)

  function enterNowPlaying(): void {
    if (currentView.value !== 'now-playing') {
      nowPlayingReturnView.value = currentView.value
      if (currentView.value === 'playlist-detail') {
        library.setPlaylistScrollTop(contentScroll.value?.scrollTop ?? 0)
      }
    }
    currentView.value = 'now-playing'
    onCloseInspector()
  }

  function exitNowPlaying(): void {
    const destination = nowPlayingReturnView.value
    currentView.value = destination === 'now-playing' ? 'home' : destination
    onCloseInspector()
    if (currentView.value === 'playlist-detail') {
      void nextTick(() => contentScroll.value?.scrollTo({ top: library.getPlaylistScrollTop() }))
    }
  }

  function navigate(view: ViewId, rememberSearch = true): void {
    if (view === 'now-playing') {
      enterNowPlaying()
      return
    }
    if (rememberSearch && view !== currentView.value && !view.endsWith('-detail') && view !== 'queue') {
      rememberSearchPage()
      leaveSearchPage()
      if (view === 'home' && restoreSearchPage({ type: 'home' })) return
    }
    currentView.value = view
    if (view !== 'queue') onCloseInspector()
    onClearActionError()
    if (view === 'search' && search.searchQuery.value.trim()) search.scheduleSearch()
    if (view === 'liked') {
      sidebar.setActiveSource({ type: 'liked' })
    }
    if (view === 'playlists') {
      sidebar.setActiveSource({ type: 'playlists' })
    }
    if (view === 'roon-albums') {
      sidebar.setActiveSource({ type: 'roon-albums' })
      if (!browse.roonAlbumsPage.value.items.length && !browse.roonAlbumsInitialLoading.value) void browse.loadRoonAlbums()
    }
    if (view === 'roon-favorites') {
      sidebar.setActiveSource({ type: 'roon-favorites' })
      if (!browse.favoritesInitialLoading.value && !browse.favoritesPage.value.items.length) void browse.loadFavorites()
    }
    if (view === 'home') {
      sidebar.setActiveSource({ type: 'home' })
    }
    if (view === 'liked' && !library.hasLikedItems()) {
      void library.loadLiked()
    }
    if (view === 'playlists' && !library.isPlaylistReady()) {
      void library.loadPlaylists()
    }
  }

  function viewForSource(source: SidebarSource): ViewId {
    switch (source.type) {
      case 'home':
        return 'home'
      case 'collection':
        return 'collection'
      case 'recording':
        return 'recording'
      case 'liked':
        return 'liked'
      case 'playlists':
        return 'playlists'
      case 'playlist':
        return 'playlist-detail'
      case 'roon-albums':
        return 'roon-albums'
      case 'roon-artists':
        return 'roon-artists'
      case 'roon-genres':
        return 'roon-genres'
      case 'roon-playlists':
        return 'roon-playlists'
      case 'roon-favorites':
        return 'roon-favorites'
      case 'roon-album':
        return 'roon-album-detail'
      case 'roon-artist':
        return 'roon-artist-detail'
      case 'roon-genre':
        return 'roon-genre-detail'
      case 'roon-playlist':
        return 'roon-playlist-detail'
    }
  }

  // 只保留本次会话的视图选择，不承载库存、曲目或持久化数据。
  const collectionView = ref<'tapes' | 'music'>('tapes')

  function openTapeCollection(): void {
    collectionView.value = 'tapes'
    navigateSource({ type: 'collection' })
  }

  function navigateSource(source: SidebarSource): void {
    if (source.type === 'roon-album' || source.type === 'roon-artist') rememberRoonDetailParent()
    else {
      rememberSearchPage()
      leaveSearchPage()
      if (restoreSearchPage(source)) return
    }
    localSearchOrigin.value = source.type === 'roon-album' || source.type === 'roon-artist'
      ? localSearchScope.value : null
    browse.invalidateAlbumArtistRequests()
    sidebar.setActiveSource(source)
    navigate(viewForSource(source), false)
    if (source.type === 'playlist') void library.loadPlaylist(source.playlistId)
    if (source.type === 'roon-albums') {
      if (!browse.roonAlbumsInitialLoading.value && (!browse.roonAlbumsPage.value.items.length || browse.roonAlbumsError.value)) void browse.loadRoonAlbums()
    }
    if (source.type === 'roon-artists') {
      if (!browse.roonArtistsInitialLoading.value && (!browse.roonArtistsPage.value.items.length || browse.roonArtistsError.value)) void browse.loadRoonArtists()
    }
    if (source.type === 'roon-genres') {
      if (!browse.roonGenresInitialLoading.value && (!browse.roonGenresPage.value.items.length || browse.roonGenresError.value)) void browse.loadRoonGenres()
    }
    if (source.type === 'roon-playlists') {
      if (!browse.roonPlaylistsInitialLoading.value && (!browse.roonPlaylistsPage.value.items.length || browse.roonPlaylistsError.value)) void browse.loadRoonPlaylists()
    }
    if (source.type === 'roon-favorites') void browse.loadFavorites()
    if (source.type === 'roon-album') void browse.loadRoonAlbum(source.reference)
    if (source.type === 'roon-artist') void browse.loadRoonArtist(source.reference)
    if (source.type === 'roon-genre') void browse.loadRoonGenre(source.reference)
    if (source.type === 'roon-playlist') void browse.loadRoonPlaylist(source.reference)
  }

  function clearSearch(): void {
    rememberedSearchPage = undefined
    if (localSearchScope.value) { updateSearchQuery(''); return }
    if (currentView.value !== 'search' && search.searchQuery.value.length === 0 && search.searchPage.value.items.length === 0) return
    search.resetSearch()
    const source = searchReturnSource.value
    sidebar.setActiveSource(source)
    currentView.value = viewForSource(source)
    if (source.type === 'liked' && !library.hasLikedItems()) void library.loadLiked()
    if (source.type === 'playlists' && !library.isPlaylistReady()) void library.loadPlaylists()
  }

  const localSearchOrigin = ref<'album' | 'artist' | null>(null)
  const localSearchScope = computed(() => {
    if (currentView.value === 'roon-albums') return 'album'
    if (currentView.value === 'roon-artists') return 'artist'
    if (currentView.value === 'roon-album-detail' || currentView.value === 'roon-artist-detail') return localSearchOrigin.value
    return null
  })
  const sidebarSearchQuery = computed(() => localSearchScope.value === 'album' ? browse.localAlbumQuery.value
    : localSearchScope.value === 'artist' ? browse.localArtistQuery.value
    : currentView.value === 'search' || roonSearchOrigin.value ? search.searchQuery.value : '')
  const sidebarSearchLabel = computed(() => localSearchScope.value === 'album' ? '搜索本地专辑'
    : localSearchScope.value === 'artist' ? '搜索本地艺术家' : '搜索歌曲或歌手')

  const roonDetailParents = ref<Array<{
    view: ViewId
    source: SidebarSource
    scrollTop: number
    searchOrigin: boolean
    localOrigin: 'album' | 'artist' | null
  }>>([])
  const roonDetailBackLabel = computed(() => {
    const parent = roonDetailParents.value.at(-1)
    if (parent?.view === 'roon-artist-detail') return browse.selectedRoonArtist.value?.title ?? '艺术家'
    if (parent?.view === 'roon-artists') return '艺术家'
    if (parent?.view === 'roon-albums') return '专辑'
    if (parent?.view === 'roon-favorites') return '收藏'
    if (parent?.view === 'roon-genre-detail') return '流派'
    if (parent?.view === 'search') return '搜索结果'
    return '本地音乐库'
  })

  function rememberRoonDetailParent(): void {
    roonDetailParents.value.push({
      view: currentView.value, source: sidebar.activeSource.value,
      scrollTop: contentScroll.value?.scrollTop ?? 0,
      searchOrigin: roonSearchOrigin.value, localOrigin: localSearchScope.value,
    })
  }

  // 只暂存当前搜索路径；在其他页面发起新搜索后，这份路径才失效。
  let rememberedSearchPage: { source: SidebarSource; restore: () => void } | undefined

  function rememberSearchPage(): void {
    const scope = localSearchScope.value
    const query = scope === 'album' ? browse.localAlbumQuery.value
      : scope === 'artist' ? browse.localArtistQuery.value
      : currentView.value === 'search' || roonSearchOrigin.value ? search.searchQuery.value : ''
    if (!query.trim()) return
    const source: SidebarSource = scope ? { type: scope === 'album' ? 'roon-albums' : 'roon-artists' }
      : searchReturnSource.value
    const view = currentView.value
    const activeSource = sidebar.activeSource.value
    const scrollTop = contentScroll.value?.scrollTop ?? 0
    const parents = [...roonDetailParents.value]
    const searchOrigin = roonSearchOrigin.value
    const localOrigin = localSearchOrigin.value
    const details = browse.captureDetail()
    rememberedSearchPage = { source, restore: () => {
      browse.restoreDetail(details)
      roonDetailParents.value = [...parents]
      roonSearchOrigin.value = searchOrigin
      localSearchOrigin.value = localOrigin
      currentView.value = view
      sidebar.setActiveSource(activeSource)
      if (view === 'roon-album-detail' && details.albumPending && details.album) void browse.loadRoonAlbum(details.album.reference)
      if (view === 'roon-artist-detail' && details.artistPending && details.artist) void browse.loadRoonArtist(details.artist.reference)
      resumeRoonDetailFavorite()
      void nextTick(() => contentScroll.value?.scrollTo({ top: scrollTop }))
    } }
  }

  function leaveSearchPage(): void {
    browse.leaveDetail()
    roonDetailParents.value = []
    roonSearchOrigin.value = false
    localSearchOrigin.value = null
  }

  function restoreSearchPage(source: SidebarSource): boolean {
    if (!rememberedSearchPage || JSON.stringify(rememberedSearchPage.source) !== JSON.stringify(source)) return false
    rememberedSearchPage.restore()
    return true
  }

  function resumeRoonDetailFavorite(): void {
    if (currentView.value === 'roon-album-detail' && browse.selectedRoonAlbum.value) {
      void browse.loadRoonEntityFavorite(browse.selectedRoonAlbum.value, 'album')
    } else if (currentView.value === 'roon-artist-detail' && browse.selectedRoonArtist.value) {
      void browse.loadRoonEntityFavorite(browse.selectedRoonArtist.value, 'artist')
    }
  }

  function discardPageSearch(): void {
    rememberedSearchPage = undefined
    roonDetailParents.value = []
    localSearchOrigin.value = null
    if (browse.localAlbumQuery.value) { browse.localAlbumQuery.value = ''; browse.resetRoonAlbums() }
    if (browse.localArtistQuery.value) { browse.localArtistQuery.value = ''; browse.resetRoonArtists() }
    search.resetSearch()
  }

  function returnFromRoonDetail(fallback: 'album' | 'artist'): void {
    const parent = roonDetailParents.value.pop()
    if (!parent) {
      navigateSource({ type: fallback === 'album' ? 'roon-albums' : 'roon-artists' })
      return
    }
    // 返回父层不走侧栏切页流程；既不跳过艺术家，也不被迟到的详情响应带回去。
    browse.invalidateAlbumArtistRequests()
    currentView.value = parent.view
    if (parent.view === 'roon-favorites') void browse.loadFavorites()
    sidebar.setActiveSource(parent.source)
    roonSearchOrigin.value = parent.searchOrigin
    localSearchOrigin.value = parent.localOrigin
    resumeRoonDetailFavorite()
    void nextTick(() => contentScroll.value?.scrollTo({ top: parent.scrollTop }))
  }

  function updateSearchQuery(query: string): void {
    const scope = localSearchScope.value
    const origin = currentView.value === 'search' || roonSearchOrigin.value
      ? searchReturnSource.value : sidebar.activeSource.value
    discardPageSearch()
    if (scope) {
      browse.invalidateAlbumArtistRequests()
      if (scope === 'album') browse.setLocalAlbumQuery(query)
      else browse.setLocalArtistQuery(query)
      currentView.value = scope === 'album' ? 'roon-albums' : 'roon-artists'
      sidebar.setActiveSource({ type: scope === 'album' ? 'roon-albums' : 'roon-artists' })
      localSearchOrigin.value = null
      void nextTick(() => contentScroll.value?.scrollTo({ top: 0 }))
      return
    }
    searchReturnSource.value = origin
    search.searchQuery.value = query
    if (!query.trim()) {
      clearSearch()
      return
    }
    currentView.value = 'search'
    search.scheduleSearch()
    search.searchScrollTop.value = 0
    void nextTick(() => contentScroll.value?.scrollTo({ top: 0 }))
  }


  function returnToSearch(): void {
    browse.invalidateAlbumArtistRequests()
    if (!roonSearchOrigin.value) search.searchSongsOpen.value = false
    roonSearchOrigin.value = false
    currentView.value = 'search'
    sidebar.setActiveSource(searchReturnSource.value)
    void nextTick(() => contentScroll.value?.scrollTo({ top: search.searchScrollTop.value }))
  }


  function selectAggregatedRoonItem(item: RoonLibraryItem): void {
    if (currentView.value !== 'search' && !roonSearchOrigin.value) {
      if (item.kind === 'album') navigateSource({ type: 'roon-album', reference: item.reference })
      else if (item.kind === 'artist') navigateSource({ type: 'roon-artist', reference: item.reference })
      else if (item.kind === 'track') onPlayRoonTrack(item)
      return
    }
    if (!roonSearchOrigin.value) search.searchScrollTop.value = contentScroll.value?.scrollTop ?? 0
    if (item.kind !== 'track') { rememberRoonDetailParent(); roonSearchOrigin.value = true }
    if (item.kind === 'track') {
      onPlayRoonTrack(item)
      return
    }
    if (item.kind === 'album') {
      browse.selectedRoonAlbum.value = item
      void browse.loadRoonEntityFavorite(item, 'album')
      void browse.loadRoonAlbum(item.reference)
      return
    }
    if (item.kind === 'artist') {
      browse.selectedRoonArtist.value = item
      void browse.loadRoonEntityFavorite(item, 'artist')
      void browse.loadRoonArtist(item.reference)
    }
  }

  function resetRoonPath(): void {
    rememberedSearchPage = undefined
    roonDetailParents.value = []
    localSearchOrigin.value = null
    const activeSource = sidebar.activeSource.value
    const staleAlbumContext = activeSource.type === 'roon-album'
      || currentView.value === 'roon-album-detail'
      || nowPlayingReturnView.value === 'roon-album-detail'
    const staleArtistContext = activeSource.type === 'roon-artist'
      || currentView.value === 'roon-artist-detail'
      || nowPlayingReturnView.value === 'roon-artist-detail'
    const staleGenreContext = activeSource.type === 'roon-genre'
      || currentView.value === 'roon-genre-detail'
      || nowPlayingReturnView.value === 'roon-genre-detail'
    const stalePlaylistContext = activeSource.type === 'roon-playlist'
      || currentView.value === 'roon-playlist-detail'
      || nowPlayingReturnView.value === 'roon-playlist-detail'
    let fallbackView: ViewId | undefined
    if (staleAlbumContext) {
      sidebar.setActiveSource({ type: 'roon-albums' })
      fallbackView = 'roon-albums'
    } else if (staleArtistContext) {
      sidebar.setActiveSource({ type: 'roon-artists' })
      fallbackView = 'roon-artists'
    } else if (staleGenreContext) {
      sidebar.setActiveSource({ type: 'roon-genres' })
      fallbackView = 'roon-genres'
    } else if (stalePlaylistContext) {
      sidebar.setActiveSource({ type: 'roon-playlists' })
      fallbackView = 'roon-playlists'
    }
    if (fallbackView && currentView.value.endsWith('-detail')) currentView.value = fallbackView
    if (fallbackView && nowPlayingReturnView.value.endsWith('-detail')) nowPlayingReturnView.value = fallbackView
    if (searchReturnSource.value.type === 'roon-album') searchReturnSource.value = { type: 'roon-albums' }
    else if (searchReturnSource.value.type === 'roon-artist') searchReturnSource.value = { type: 'roon-artists' }
    else if (searchReturnSource.value.type === 'roon-genre') searchReturnSource.value = { type: 'roon-genres' }
    else if (searchReturnSource.value.type === 'roon-playlist') searchReturnSource.value = { type: 'roon-playlists' }
  }

  function resetPrivatePath(): void {
    rememberedSearchPage = undefined
    roonDetailParents.value = []
    roonSearchOrigin.value = false
    localSearchOrigin.value = null
  }

  function setDetailView(view: ViewId, source?: SidebarSource): void {
    currentView.value = view
    if (source) sidebar.setActiveSource(source)
  }

  function dispose(): void {
    resetPrivatePath()
  }

  return {
    currentView, nowPlayingReturnView, sidebar, searchReturnSource, roonSearchOrigin,
    contentScroll, collectionView, localSearchOrigin, localSearchScope,
    sidebarSearchQuery, sidebarSearchLabel, roonDetailParents, roonDetailBackLabel,
    isImmersiveNowPlaying: computed(() => currentView.value === 'now-playing'),
    enterNowPlaying, exitNowPlaying, navigate, navigateSource, viewForSource,
    openTapeCollection, clearSearch, updateSearchQuery, rememberSearchPage,
    leaveSearchPage, restoreSearchPage, discardPageSearch, returnFromRoonDetail,
    returnToSearch, selectAggregatedRoonItem, resetRoonPath, resetPrivatePath,
    setDetailView, dispose,
  }
}
