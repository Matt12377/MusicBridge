import { ref } from 'vue'
import type {
  FavoriteEntityDescriptor, FavoriteKind, FavoritePage, FavoriteRecord,
  PageRequest, RoonLibraryItem, RoonLibraryPage,
} from '@music-bridge/contracts'
import type { MusicBridgePublicApi } from '../../../../preload/api.js'
import type { SidebarSource, ViewId } from '../../components/navigation.js'
import { appendRoonPage, emptyRoonPage } from '../roonLibraryPagination.js'
import { useRoonCollection } from '../useRoonCollection.js'
import { useRoonSearchCollection } from '../useRoonSearchCollection.js'
import { favoriteDescriptorForRoonItem } from '../playbackFavorites.js'

const LIBRARY_PAGE_SIZE = 20
function emptyFavoritePage(limit = LIBRARY_PAGE_SIZE): FavoritePage {
  return { items: [], offset: 0, limit, total: 0, hasMore: false }
}

export interface RoonBrowseOptions {
  api: MusicBridgePublicApi
  formatError: (error: unknown) => string
  onError: (error: unknown) => void
  onToast: (message: string) => void
  getView: () => ViewId
  onDetailOpening: (view: ViewId) => void
  onDetailReady: (view: ViewId, source: SidebarSource) => void
  onNavigateSource: (source: SidebarSource) => void
  onPlayTrack: (item: RoonLibraryItem) => void
}

export function useRoonBrowse(options: RoonBrowseOptions) {
  const { api, formatError, onError, onToast, getView,
    onDetailOpening, onDetailReady, onNavigateSource, onPlayTrack } = options

  const {
    query: localAlbumQuery,
    setQuery: setLocalAlbumQuery,
    page: roonAlbumsPage,
    initialLoading: roonAlbumsInitialLoading,
    loadingMore: roonAlbumsLoadingMore,
    loadMoreError: roonAlbumsLoadMoreError,
    error: roonAlbumsError,
    load: loadRoonAlbums,
    loadMore: loadMoreRoonAlbums,
    retry: retryRoonAlbums,
    reset: resetRoonAlbums,
  } = useRoonSearchCollection(
    'album',
    (page) => api.listRoonAlbums(page),
    (query, page, kind) => api.searchRoonLibrary(query, page, kind),
    (error) => formatError(error),
  )
  const {
    query: localArtistQuery,
    setQuery: setLocalArtistQuery,
    page: roonArtistsPage,
    initialLoading: roonArtistsInitialLoading,
    loadingMore: roonArtistsLoadingMore,
    loadMoreError: roonArtistsLoadMoreError,
    error: roonArtistsError,
    load: loadRoonArtists,
    loadMore: loadMoreRoonArtists,
    retry: retryRoonArtists,
    reset: resetRoonArtists,
  } = useRoonSearchCollection(
    'artist',
    (page) => api.listRoonArtists(page),
    (query, page, kind) => api.searchRoonLibrary(query, page, kind),
    (error) => formatError(error),
  )
  const {
    page: roonGenresPage,
    initialLoading: roonGenresInitialLoading,
    loadingMore: roonGenresLoadingMore,
    loadMoreError: roonGenresLoadMoreError,
    error: roonGenresError,
    load: loadRoonGenres,
    loadMore: loadMoreRoonGenres,
    retry: retryRoonGenres,
    reset: resetRoonGenres,
  } = useRoonCollection(
    (page) => api.listRoonGenres(page),
    (error) => formatError(error),
  )
  const {
    page: roonPlaylistsPage,
    initialLoading: roonPlaylistsInitialLoading,
    loadingMore: roonPlaylistsLoadingMore,
    loadMoreError: roonPlaylistsLoadMoreError,
    error: roonPlaylistsError,
    load: loadRoonPlaylists,
    loadMore: loadMoreRoonPlaylists,
    retry: retryRoonPlaylists,
    reset: resetRoonPlaylists,
  } = useRoonCollection(
    (page) => api.listRoonPlaylists(page),
    (error) => formatError(error),
  )
  const favoriteKind = ref<FavoriteKind>('track')
  const favoriteResolutionEpoch = ref(0)
  const resolvedFavoriteDescriptors = new Map<string, FavoriteEntityDescriptor>()

  function localFavoriteDescriptor(item: RoonLibraryItem): FavoriteEntityDescriptor {
    return resolvedFavoriteDescriptors.get(item.reference) ?? favoriteDescriptorForRoonItem(item)
  }
  const favoritesPage = ref<FavoritePage>(emptyFavoritePage())
  const favoritesInitialLoading = ref(false)
  const favoritesLoadingMore = ref(false)
  const favoritesLoadMoreError = ref<string | null>(null)
  const favoritesError = ref<string | null>(null)
  const selectedRoonAlbum = ref<RoonLibraryItem | null>(null)
  const roonAlbumFavoriteState = ref<'idle' | 'loading' | 'liked' | 'not-liked' | 'error'>('idle')
  const selectedRoonAlbumPage = ref<RoonLibraryPage>(emptyRoonPage())
  const roonAlbumInitialLoading = ref(false)
  const roonAlbumLoadingMore = ref(false)
  const roonAlbumLoadMoreError = ref<string | null>(null)
  const roonAlbumError = ref<string | null>(null)
  const selectedRoonArtist = ref<RoonLibraryItem | null>(null)
  const roonArtistFavoriteState = ref<'idle' | 'loading' | 'liked' | 'not-liked' | 'error'>('idle')
  const selectedRoonArtistPage = ref<RoonLibraryPage>(emptyRoonPage())
  const roonArtistInitialLoading = ref(false)
  const roonArtistLoadingMore = ref(false)
  const roonArtistLoadMoreError = ref<string | null>(null)
  const roonArtistError = ref<string | null>(null)
  const selectedRoonGenre = ref<RoonLibraryItem | null>(null)
  const selectedRoonGenrePage = ref<RoonLibraryPage>(emptyRoonPage())
  const roonGenreInitialLoading = ref(false)
  const roonGenreLoadingMore = ref(false)
  const roonGenreLoadMoreError = ref<string | null>(null)
  const roonGenreError = ref<string | null>(null)
  const selectedRoonPlaylist = ref<RoonLibraryItem | null>(null)
  const selectedRoonPlaylistPage = ref<RoonLibraryPage>(emptyRoonPage())
  const roonPlaylistInitialLoading = ref(false)
  const roonPlaylistLoadingMore = ref(false)
  const roonPlaylistLoadMoreError = ref<string | null>(null)
  const roonPlaylistError = ref<string | null>(null)

  let favoritesRequestGeneration = 0
  let roonAlbumRequestGeneration = 0
  let roonArtistRequestGeneration = 0
  let roonGenreRequestGeneration = 0
  let roonPlaylistRequestGeneration = 0
  let entityFavoriteOperation = 0

  async function loadRoonAlbum(
    reference: string,
    page: PageRequest = { offset: 0, limit: 24 },
  ): Promise<void> {
    const album = [
      ...roonAlbumsPage.value.items,
      ...selectedRoonArtistPage.value.items,
      ...selectedRoonGenrePage.value.items,
    ].find((item) => item.reference === reference)
    if (album && album.kind === 'album') {
      selectedRoonAlbum.value = album
      void loadRoonEntityFavorite(album, 'album')
    }
    const initial = page.offset === 0
    if (initial) {
      onDetailOpening('roon-album-detail')
      roonAlbumRequestGeneration += 1
      roonAlbumInitialLoading.value = true
      roonAlbumLoadMoreError.value = null
      roonAlbumError.value = null
      selectedRoonAlbumPage.value = emptyRoonPage(page.limit)
    } else {
      if (roonAlbumLoadingMore.value) return
      roonAlbumLoadingMore.value = true
      roonAlbumLoadMoreError.value = null
    }
    const generation = roonAlbumRequestGeneration
    try {
      const result = await api.getRoonAlbumTracks(reference, page)
      if (generation !== roonAlbumRequestGeneration) return
      selectedRoonAlbumPage.value = initial ? result : appendRoonPage(selectedRoonAlbumPage.value, result)
      roonAlbumInitialLoading.value = false
      roonAlbumLoadingMore.value = false
      roonAlbumError.value = null
      onDetailReady('roon-album-detail', { type: 'roon-album', reference })
    } catch (error) {
      if (generation !== roonAlbumRequestGeneration) return
      if (initial) {
        roonAlbumInitialLoading.value = false
        roonAlbumError.value = formatError(error)
      } else {
        roonAlbumLoadingMore.value = false
        roonAlbumLoadMoreError.value = '加载失败，点击重试'
      }
    }
  }

  async function loadRoonArtist(
    reference: string,
    page: PageRequest = { offset: 0, limit: 24 },
  ): Promise<void> {
    const artist = roonArtistsPage.value.items.find((item) => item.reference === reference)
    if (artist && artist.kind === 'artist') {
      selectedRoonArtist.value = artist
      void loadRoonEntityFavorite(artist, 'artist')
    }
    const initial = page.offset === 0
    if (initial) {
      onDetailOpening('roon-artist-detail')
      roonArtistRequestGeneration += 1
      roonArtistInitialLoading.value = true
      roonArtistLoadMoreError.value = null
      roonArtistError.value = null
      selectedRoonArtistPage.value = emptyRoonPage(page.limit)
    } else {
      if (roonArtistLoadingMore.value) return
      roonArtistLoadingMore.value = true
      roonArtistLoadMoreError.value = null
    }
    const generation = roonArtistRequestGeneration
    try {
      const result = await api.getRoonArtistAlbums(reference, page)
      if (generation !== roonArtistRequestGeneration) return
      selectedRoonArtistPage.value = initial ? result : appendRoonPage(selectedRoonArtistPage.value, result)
      roonArtistInitialLoading.value = false
      roonArtistLoadingMore.value = false
      roonArtistError.value = null
      onDetailReady('roon-artist-detail', { type: 'roon-artist', reference })
    } catch (error) {
      if (generation !== roonArtistRequestGeneration) return
      if (initial) {
        roonArtistInitialLoading.value = false
        roonArtistError.value = formatError(error)
      } else {
        roonArtistLoadingMore.value = false
        roonArtistLoadMoreError.value = '加载失败，点击重试'
      }
    }
  }

  async function loadRoonGenre(
    reference: string,
    page: PageRequest = { offset: 0, limit: 24 },
  ): Promise<void> {
    const genre = roonGenresPage.value.items.find((item) => item.reference === reference)
    if (genre?.kind === 'genre') selectedRoonGenre.value = genre
    const initial = page.offset === 0
    if (initial) {
      roonGenreRequestGeneration += 1
      roonGenreInitialLoading.value = true
      roonGenreLoadMoreError.value = null
      roonGenreError.value = null
      selectedRoonGenrePage.value = emptyRoonPage(page.limit)
    } else {
      if (roonGenreLoadingMore.value) return
      roonGenreLoadingMore.value = true
      roonGenreLoadMoreError.value = null
    }
    const generation = roonGenreRequestGeneration
    try {
      const result = await api.getRoonGenreItems(reference, page)
      if (generation !== roonGenreRequestGeneration) return
      selectedRoonGenrePage.value = initial ? result : appendRoonPage(selectedRoonGenrePage.value, result)
      roonGenreInitialLoading.value = false
      roonGenreLoadingMore.value = false
      roonGenreError.value = null
      onDetailReady('roon-genre-detail', { type: 'roon-genre', reference })
    } catch (error) {
      if (generation !== roonGenreRequestGeneration) return
      if (initial) {
        roonGenreInitialLoading.value = false
        roonGenreError.value = formatError(error)
      } else {
        roonGenreLoadingMore.value = false
        roonGenreLoadMoreError.value = '加载失败，点击重试'
      }
    }
  }

  async function loadRoonPlaylist(
    reference: string,
    page: PageRequest = { offset: 0, limit: 24 },
  ): Promise<void> {
    const playlist = roonPlaylistsPage.value.items.find((item) => item.reference === reference)
    if (playlist?.kind === 'playlist') selectedRoonPlaylist.value = playlist
    const initial = page.offset === 0
    if (initial) {
      roonPlaylistRequestGeneration += 1
      roonPlaylistInitialLoading.value = true
      roonPlaylistLoadMoreError.value = null
      roonPlaylistError.value = null
      selectedRoonPlaylistPage.value = emptyRoonPage(page.limit)
    } else {
      if (roonPlaylistLoadingMore.value) return
      roonPlaylistLoadingMore.value = true
      roonPlaylistLoadMoreError.value = null
    }
    const generation = roonPlaylistRequestGeneration
    try {
      const result = await api.getRoonPlaylistTracks(reference, page)
      if (generation !== roonPlaylistRequestGeneration) return
      selectedRoonPlaylistPage.value = initial ? result : appendRoonPage(selectedRoonPlaylistPage.value, result)
      roonPlaylistInitialLoading.value = false
      roonPlaylistLoadingMore.value = false
      roonPlaylistError.value = null
      onDetailReady('roon-playlist-detail', { type: 'roon-playlist', reference })
    } catch (error) {
      if (generation !== roonPlaylistRequestGeneration) return
      if (initial) {
        roonPlaylistInitialLoading.value = false
        roonPlaylistError.value = formatError(error)
      } else {
        roonPlaylistLoadingMore.value = false
        roonPlaylistLoadMoreError.value = '加载失败，点击重试'
      }
    }
  }

  function roonAlbumPageAt(offset: number): void {
    const album = selectedRoonAlbum.value
    if (album) void loadRoonAlbum(album.reference, { offset, limit: selectedRoonAlbumPage.value.limit })
  }

  function roonArtistPageAt(offset: number): void {
    const artist = selectedRoonArtist.value
    if (artist) void loadRoonArtist(artist.reference, { offset, limit: selectedRoonArtistPage.value.limit })
  }

  function roonGenrePageAt(offset: number): void {
    const genre = selectedRoonGenre.value
    if (genre) void loadRoonGenre(genre.reference, { offset, limit: selectedRoonGenrePage.value.limit })
  }

  function roonPlaylistPageAt(offset: number): void {
    const playlist = selectedRoonPlaylist.value
    if (playlist) void loadRoonPlaylist(playlist.reference, { offset, limit: selectedRoonPlaylistPage.value.limit })
  }

  async function loadRoonEntityFavorite(
    item: RoonLibraryItem,
    kind: 'album' | 'artist',
  ): Promise<void> {
    const operation = ++entityFavoriteOperation
    const state = kind === 'album' ? roonAlbumFavoriteState : roonArtistFavoriteState
    state.value = 'loading'
    try {
      const result = await api.checkFavorite(localFavoriteDescriptor(item))
      if (operation !== entityFavoriteOperation) return
      state.value = result.favorite ? 'liked' : 'not-liked'
    } catch (error) {
      if (operation === entityFavoriteOperation) state.value = 'error'
      onError(error)
    }
  }

  async function toggleRoonEntityFavorite(kind: 'album' | 'artist'): Promise<void> {
    const item = kind === 'album' ? selectedRoonAlbum.value : selectedRoonArtist.value
    const state = kind === 'album' ? roonAlbumFavoriteState : roonArtistFavoriteState
    if (!item || item.kind !== kind || state.value === 'loading') return
    const operation = ++entityFavoriteOperation
    const nextFavorite = state.value !== 'liked'
    state.value = 'loading'
    try {
      const result = await api.setFavorite(
        localFavoriteDescriptor(item),
        nextFavorite,
      )
      if (operation !== entityFavoriteOperation) return
      state.value = result.favorite ? 'liked' : 'not-liked'
      const label = kind === 'album' ? '专辑' : '艺术家'
      onToast(nextFavorite ? `已加入本地${label}收藏` : `已取消本地${label}收藏`)
    } catch (error) {
      if (operation === entityFavoriteOperation) state.value = 'error'
      onError(error)
    }
  }

  async function loadFavorites(
    kind: FavoriteKind = favoriteKind.value,
    page: PageRequest = { offset: 0, limit: LIBRARY_PAGE_SIZE },
  ): Promise<void> {
    const initial = page.offset === 0
    if (initial) {
      favoriteKind.value = kind
      favoritesRequestGeneration += 1
      favoritesInitialLoading.value = true
      favoritesLoadMoreError.value = null
      favoritesError.value = null
      favoritesPage.value = emptyFavoritePage(page.limit)
    } else {
      if (favoritesLoadingMore.value || kind !== favoriteKind.value) return
      favoritesLoadingMore.value = true
      favoritesLoadMoreError.value = null
    }
    const generation = favoritesRequestGeneration
    try {
      const result = await api.listFavorites(kind, page)
      if (generation !== favoritesRequestGeneration || kind !== favoriteKind.value) return
      favoritesPage.value = initial ? result : {
        ...result,
        items: [...favoritesPage.value.items, ...result.items.filter((item) => !favoritesPage.value.items.some((existing) => existing.favoriteId === item.favoriteId))],
      }
      favoritesInitialLoading.value = false
      favoritesLoadingMore.value = false
      favoritesError.value = null
    } catch (error) {
      if (generation !== favoritesRequestGeneration || kind !== favoriteKind.value) return
      if (initial) {
        favoritesInitialLoading.value = false
        favoritesError.value = formatError(error)
      } else {
        favoritesLoadingMore.value = false
        favoritesLoadMoreError.value = '加载失败，点击重试'
      }
    }
  }

  function setFavoriteKind(kind: FavoriteKind): void {
    if (favoriteKind.value === kind && favoritesPage.value.items.length) return
    void loadFavorites(kind)
  }

  function openFavorite(item: RoonLibraryItem, record: FavoriteRecord): void {
    const { favoriteId: _id, createdAt: _created, updatedAt: _updated, ...descriptor } = record
    // 继续使用原收藏描述操作关系，避免搜索与详情的元数据差异产生重复收藏。
    resolvedFavoriteDescriptors.set(item.reference, descriptor)
    if (resolvedFavoriteDescriptors.size > 1000) resolvedFavoriteDescriptors.delete(resolvedFavoriteDescriptors.keys().next().value!)
    if (item.kind === 'track') { onPlayTrack(item); return }
    if (item.kind === 'album') selectedRoonAlbum.value = item
    if (item.kind === 'artist') selectedRoonArtist.value = item
    if (item.kind === 'album' || item.kind === 'artist') void loadRoonEntityFavorite(item, item.kind)
    onNavigateSource({ type: item.kind === 'album' ? 'roon-album' : 'roon-artist', reference: item.reference })
  }

  const removingFavorites = new Set<string>()
  async function removeFavorite(record: FavoriteRecord): Promise<void> {
    if (removingFavorites.has(record.favoriteId)) return
    removingFavorites.add(record.favoriteId)
    try {
      const { favoriteId: _id, createdAt: _created, updatedAt: _updated, ...descriptor } = record
      await api.setFavorite(descriptor, false)
      if (getView() === 'roon-favorites' && favoriteKind.value === record.kind) await loadFavorites(record.kind)
      onToast('已取消收藏')
    } catch (error) { onError(error) }
    finally { removingFavorites.delete(record.favoriteId) }
  }

  function favoritesPageAt(offset: number): void {
    void loadFavorites(favoriteKind.value, { offset, limit: favoritesPage.value.limit })
  }

  function retryFavorites(): void {
    void loadFavorites(favoriteKind.value)
  }

  function retryRoonAlbum(): void {
    const album = selectedRoonAlbum.value
    if (album) void loadRoonAlbum(album.reference)
  }

  function refreshVisibleRoonCollection(): void {
    if (getView() === 'roon-favorites') favoriteResolutionEpoch.value += 1
    if (getView() === 'roon-albums' && !roonAlbumsInitialLoading.value) void loadRoonAlbums()
    if (getView() === 'roon-artists' && !roonArtistsInitialLoading.value) void loadRoonArtists()
    if (getView() === 'roon-genres' && !roonGenresInitialLoading.value) void loadRoonGenres()
    if (getView() === 'roon-playlists' && !roonPlaylistsInitialLoading.value) void loadRoonPlaylists()
  }


  function invalidateAlbumArtistRequests(): void {
    roonAlbumRequestGeneration += 1
    roonArtistRequestGeneration += 1
  }

  function leaveDetail(): void {
    invalidateAlbumArtistRequests()
    entityFavoriteOperation += 1
    roonAlbumInitialLoading.value = false
    roonAlbumLoadingMore.value = false
    roonArtistInitialLoading.value = false
    roonArtistLoadingMore.value = false
  }

  function invalidateDetailRequests(): void {
    leaveDetail()
    roonGenreRequestGeneration += 1
    roonPlaylistRequestGeneration += 1
    roonGenreInitialLoading.value = false
    roonGenreLoadingMore.value = false
    roonPlaylistInitialLoading.value = false
    roonPlaylistLoadingMore.value = false
  }

  function captureDetail() {
    return {
      album: selectedRoonAlbum.value, albumPage: selectedRoonAlbumPage.value,
      albumError: roonAlbumError.value, albumFavorite: roonAlbumFavoriteState.value,
      albumLoadMoreError: roonAlbumLoadMoreError.value, albumPending: roonAlbumInitialLoading.value,
      artist: selectedRoonArtist.value, artistPage: selectedRoonArtistPage.value,
      artistError: roonArtistError.value, artistFavorite: roonArtistFavoriteState.value,
      artistLoadMoreError: roonArtistLoadMoreError.value, artistPending: roonArtistInitialLoading.value,
    }
  }

  function restoreDetail(snapshot: ReturnType<typeof captureDetail>): void {
    selectedRoonAlbum.value = snapshot.album
    selectedRoonAlbumPage.value = snapshot.albumPage
    roonAlbumError.value = snapshot.albumError
    roonAlbumFavoriteState.value = snapshot.albumFavorite
    roonAlbumLoadMoreError.value = snapshot.albumLoadMoreError
    selectedRoonArtist.value = snapshot.artist
    selectedRoonArtistPage.value = snapshot.artistPage
    roonArtistError.value = snapshot.artistError
    roonArtistFavoriteState.value = snapshot.artistFavorite
    roonArtistLoadMoreError.value = snapshot.artistLoadMoreError
  }

  function resetSession(): void {
    resolvedFavoriteDescriptors.clear()
    favoriteResolutionEpoch.value += 1
    resetRoonAlbums()
    resetRoonArtists()
    resetRoonGenres()
    resetRoonPlaylists()
    invalidateDetailRequests()
    selectedRoonAlbum.value = null
    selectedRoonAlbumPage.value = emptyRoonPage()
    roonAlbumLoadMoreError.value = null
    roonAlbumError.value = null
    roonAlbumFavoriteState.value = 'idle'
    selectedRoonArtist.value = null
    selectedRoonArtistPage.value = emptyRoonPage()
    roonArtistLoadMoreError.value = null
    roonArtistError.value = null
    roonArtistFavoriteState.value = 'idle'
    selectedRoonGenre.value = null
    selectedRoonGenrePage.value = emptyRoonPage()
    roonGenreLoadMoreError.value = null
    roonGenreError.value = null
    selectedRoonPlaylist.value = null
    selectedRoonPlaylistPage.value = emptyRoonPage()
    roonPlaylistLoadMoreError.value = null
    roonPlaylistError.value = null
    favoritesRequestGeneration += 1
    favoritesInitialLoading.value = false
    favoritesLoadingMore.value = false
  }

  function dispose(): void {
    resetSession()
  }

  return {
    localAlbumQuery, setLocalAlbumQuery, roonAlbumsPage, roonAlbumsInitialLoading,
    roonAlbumsLoadingMore, roonAlbumsLoadMoreError, roonAlbumsError, loadRoonAlbums,
    loadMoreRoonAlbums, retryRoonAlbums, resetRoonAlbums,
    localArtistQuery, setLocalArtistQuery, roonArtistsPage, roonArtistsInitialLoading,
    roonArtistsLoadingMore, roonArtistsLoadMoreError, roonArtistsError, loadRoonArtists,
    loadMoreRoonArtists, retryRoonArtists, resetRoonArtists,
    roonGenresPage, roonGenresInitialLoading, roonGenresLoadingMore,
    roonGenresLoadMoreError, roonGenresError, loadRoonGenres, loadMoreRoonGenres,
    retryRoonGenres, resetRoonGenres,
    roonPlaylistsPage, roonPlaylistsInitialLoading, roonPlaylistsLoadingMore,
    roonPlaylistsLoadMoreError, roonPlaylistsError, loadRoonPlaylists,
    loadMoreRoonPlaylists, retryRoonPlaylists, resetRoonPlaylists,
    favoriteKind, favoriteResolutionEpoch, favoritesPage, favoritesInitialLoading,
    favoritesLoadingMore, favoritesLoadMoreError, favoritesError,
    selectedRoonAlbum, roonAlbumFavoriteState, selectedRoonAlbumPage,
    roonAlbumInitialLoading, roonAlbumLoadingMore, roonAlbumLoadMoreError, roonAlbumError,
    selectedRoonArtist, roonArtistFavoriteState, selectedRoonArtistPage,
    roonArtistInitialLoading, roonArtistLoadingMore, roonArtistLoadMoreError, roonArtistError,
    selectedRoonGenre, selectedRoonGenrePage, roonGenreInitialLoading,
    roonGenreLoadingMore, roonGenreLoadMoreError, roonGenreError,
    selectedRoonPlaylist, selectedRoonPlaylistPage, roonPlaylistInitialLoading,
    roonPlaylistLoadingMore, roonPlaylistLoadMoreError, roonPlaylistError,
    resolveFavoriteDescriptor: localFavoriteDescriptor, loadRoonAlbum, loadRoonArtist,
    loadRoonGenre, loadRoonPlaylist, roonAlbumPageAt, roonArtistPageAt,
    roonGenrePageAt, roonPlaylistPageAt, loadRoonEntityFavorite,
    toggleRoonEntityFavorite, loadFavorites, setFavoriteKind, openFavorite,
    removeFavorite, favoritesPageAt, retryFavorites, retryRoonAlbum,
    refreshVisibleRoonCollection, invalidateAlbumArtistRequests, leaveDetail,
    invalidateDetailRequests, captureDetail,
    restoreDetail, resetSession, dispose,
  }
}
