import { ref } from 'vue'
import { createLibraryReadScope, isLibraryReadCancelled } from '../libraryReadScope.js'
import type {
  FavoriteEntityDescriptor, FavoriteKind, FavoritePage, FavoriteRecord,
  PageRequest, RoonLibraryItem, RoonLibraryPage,
} from '@music-bridge/contracts'
import type { MusicBridgePublicApi } from '../../../../preload/api.js'
import type { SidebarSource, ViewId } from '../../components/navigation.js'
import { appendRoonPage, emptyRoonPage, readRoonDatasetPage, RoonPageEpochChanged } from '../roonLibraryPagination.js'
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

  let disposed = false, sessionEpoch = 0
  const catalogReads = createLibraryReadScope(api)
  const detailReads = { album: createLibraryReadScope(api), artist: createLibraryReadScope(api), genre: createLibraryReadScope(api), playlist: createLibraryReadScope(api) }
  const entityFavoriteReads = createLibraryReadScope(api), favoriteReads = createLibraryReadScope(api)
  type DetailKind = keyof typeof detailReads
  const detailRequests: Partial<Record<DetailKind, { reference: string; page: PageRequest }>> = {}
  const detailTargets: typeof detailRequests = {}
  const detailRebases: Record<DetailKind, number> = { album: 0, artist: 0, genre: 0, playlist: 0 }
  const invalidDetailEpochs = new Set<string>()
  function invalidateDetailEpoch(page: RoonLibraryPage): void {
    if (!page.sourceEpoch) return
    if (invalidDetailEpochs.size >= 64) invalidDetailEpochs.delete(invalidDetailEpochs.values().next().value!)
    invalidDetailEpochs.add(page.sourceEpoch)
  }
  let pendingFavorite: { kind: FavoriteKind; page: PageRequest } | undefined
  const albumCollection = useRoonSearchCollection('album',
    (page, context) => catalogReads.read('roon.library.albums', { page }, () => api.listRoonAlbums(page), context),
    (query, page, kind, context) => catalogReads.read('roon.library.search', { query, page, kind }, () => api.searchRoonLibrary(query, page, kind), context), formatError)
  const artistCollection = useRoonSearchCollection('artist',
    (page, context) => catalogReads.read('roon.library.artists', { page }, () => api.listRoonArtists(page), context),
    (query, page, kind, context) => catalogReads.read('roon.library.search', { query, page, kind }, () => api.searchRoonLibrary(query, page, kind), context), formatError)
  const genreCollection = useRoonCollection((page, context) => catalogReads.read('roon.library.genres', { page }, () => api.listRoonGenres(page), context), formatError)
  const playlistCollection = useRoonCollection((page, context) => catalogReads.read('roon.library.playlists', { page }, () => api.listRoonPlaylists(page), context), formatError)
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
  } = albumCollection
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
  } = artistCollection
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
  } = genreCollection
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
  } = playlistCollection
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
    resume = false,
  ): Promise<void> {
    if (disposed) return
    const initial = page.offset === 0
    if (!initial && detailTargets.album?.reference !== reference) {
      roonAlbumLoadMoreError.value = '读取目标已变化，请重新读取。'
      return
    }
    const album = [
      ...roonAlbumsPage.value.items,
      ...selectedRoonArtistPage.value.items,
      ...selectedRoonGenrePage.value.items,
    ].find((item) => item.reference === reference)
    if (album && album.kind === 'album') {
      selectedRoonAlbum.value = album
    }
    if (initial && selectedRoonAlbum.value?.reference !== reference) selectedRoonAlbum.value = null
    if (initial) {
      if (!resume) detailRebases.album = 0
      onDetailOpening('roon-album-detail')
      roonAlbumRequestGeneration += 1
      detailReads.album.cancelAll()
      roonAlbumLoadingMore.value = false
      roonAlbumInitialLoading.value = true
      roonAlbumLoadMoreError.value = null
      roonAlbumError.value = null
      selectedRoonAlbumPage.value = emptyRoonPage(page.limit)
      // 目标页先取得读取所有权；收藏入口的原描述继续用于关系核对。
      if (selectedRoonAlbum.value?.reference === reference) void loadRoonEntityFavorite(selectedRoonAlbum.value, 'album')
    } else {
      if (roonAlbumLoadingMore.value) return
      roonAlbumLoadingMore.value = true
      roonAlbumLoadMoreError.value = null
    }
    const generation = roonAlbumRequestGeneration
    detailRequests.album = { reference, page: { ...page } }
    detailTargets.album = detailRequests.album
    try {
      const result = await readRoonDatasetPage(initial ? undefined : selectedRoonAlbumPage.value, page,
        target => detailReads.album.read('roon.library.album', { reference, page: target }, () => api.getRoonAlbumTracks(reference, target)),
        () => generation === roonAlbumRequestGeneration,
        detailRebases.album === 0 ? () => {
          detailRebases.album++
          invalidateDetailEpoch(selectedRoonAlbumPage.value)
          detailRequests.album = { reference, page: { offset: 0, limit: page.limit } }
          detailTargets.album = detailRequests.album
        } : undefined)
      if (!result || generation !== roonAlbumRequestGeneration) return
      delete detailRequests.album
      selectedRoonAlbumPage.value = initial || result.restarted ? result.page : appendRoonPage(selectedRoonAlbumPage.value, result.page)
      roonAlbumInitialLoading.value = false
      roonAlbumLoadingMore.value = false
      roonAlbumError.value = null
      onDetailReady('roon-album-detail', { type: 'roon-album', reference })
    } catch (error) {
      if (generation !== roonAlbumRequestGeneration) return
      if (isLibraryReadCancelled(error)) { roonAlbumInitialLoading.value = false; roonAlbumLoadingMore.value = false; return }
      delete detailRequests.album
      if (initial) {
        roonAlbumInitialLoading.value = false
        roonAlbumError.value = formatError(error)
      } else {
        roonAlbumLoadingMore.value = false
        roonAlbumLoadMoreError.value = error instanceof RoonPageEpochChanged ? '读取上下文反复变化，请重新读取。' : '加载失败，点击重试'
      }
    }
  }

  async function loadRoonArtist(
    reference: string,
    page: PageRequest = { offset: 0, limit: 24 },
    resume = false,
  ): Promise<void> {
    if (disposed) return
    const initial = page.offset === 0
    if (!initial && detailTargets.artist?.reference !== reference) {
      roonArtistLoadMoreError.value = '读取目标已变化，请重新读取。'
      return
    }
    const artist = roonArtistsPage.value.items.find((item) => item.reference === reference)
    if (artist && artist.kind === 'artist') {
      selectedRoonArtist.value = artist
    }
    if (initial && selectedRoonArtist.value?.reference !== reference) selectedRoonArtist.value = null
    if (initial) {
      if (!resume) detailRebases.artist = 0
      onDetailOpening('roon-artist-detail')
      roonArtistRequestGeneration += 1
      detailReads.artist.cancelAll()
      roonArtistLoadingMore.value = false
      roonArtistInitialLoading.value = true
      roonArtistLoadMoreError.value = null
      roonArtistError.value = null
      selectedRoonArtistPage.value = emptyRoonPage(page.limit)
      if (selectedRoonArtist.value?.reference === reference) void loadRoonEntityFavorite(selectedRoonArtist.value, 'artist')
    } else {
      if (roonArtistLoadingMore.value) return
      roonArtistLoadingMore.value = true
      roonArtistLoadMoreError.value = null
    }
    const generation = roonArtistRequestGeneration
    detailRequests.artist = { reference, page: { ...page } }
    detailTargets.artist = detailRequests.artist
    try {
      const result = await readRoonDatasetPage(initial ? undefined : selectedRoonArtistPage.value, page,
        target => detailReads.artist.read('roon.library.artist', { reference, page: target }, () => api.getRoonArtistAlbums(reference, target)),
        () => generation === roonArtistRequestGeneration,
        detailRebases.artist === 0 ? () => {
          detailRebases.artist++
          invalidateDetailEpoch(selectedRoonArtistPage.value)
          detailRequests.artist = { reference, page: { offset: 0, limit: page.limit } }
          detailTargets.artist = detailRequests.artist
        } : undefined)
      if (!result || generation !== roonArtistRequestGeneration) return
      delete detailRequests.artist
      selectedRoonArtistPage.value = initial || result.restarted ? result.page : appendRoonPage(selectedRoonArtistPage.value, result.page)
      roonArtistInitialLoading.value = false
      roonArtistLoadingMore.value = false
      roonArtistError.value = null
      onDetailReady('roon-artist-detail', { type: 'roon-artist', reference })
    } catch (error) {
      if (generation !== roonArtistRequestGeneration) return
      if (isLibraryReadCancelled(error)) { roonArtistInitialLoading.value = false; roonArtistLoadingMore.value = false; return }
      delete detailRequests.artist
      if (initial) {
        roonArtistInitialLoading.value = false
        roonArtistError.value = formatError(error)
      } else {
        roonArtistLoadingMore.value = false
        roonArtistLoadMoreError.value = error instanceof RoonPageEpochChanged ? '读取上下文反复变化，请重新读取。' : '加载失败，点击重试'
      }
    }
  }

  async function loadRoonGenre(
    reference: string,
    page: PageRequest = { offset: 0, limit: 24 },
    resume = false,
  ): Promise<void> {
    if (disposed) return
    const initial = page.offset === 0
    if (!initial && detailTargets.genre?.reference !== reference) {
      roonGenreLoadMoreError.value = '读取目标已变化，请重新读取。'
      return
    }
    const genre = roonGenresPage.value.items.find((item) => item.reference === reference)
    if (genre?.kind === 'genre') selectedRoonGenre.value = genre
    if (initial && selectedRoonGenre.value?.reference !== reference) selectedRoonGenre.value = null
    if (initial) {
      if (!resume) detailRebases.genre = 0
      roonGenreRequestGeneration += 1
      detailReads.genre.cancelAll()
      roonGenreLoadingMore.value = false
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
    detailRequests.genre = { reference, page: { ...page } }
    detailTargets.genre = detailRequests.genre
    try {
      const result = await readRoonDatasetPage(initial ? undefined : selectedRoonGenrePage.value, page,
        target => detailReads.genre.read('roon.library.genre', { reference, page: target }, () => api.getRoonGenreItems(reference, target)),
        () => generation === roonGenreRequestGeneration,
        detailRebases.genre === 0 ? () => {
          detailRebases.genre++
          invalidateDetailEpoch(selectedRoonGenrePage.value)
          detailRequests.genre = { reference, page: { offset: 0, limit: page.limit } }
          detailTargets.genre = detailRequests.genre
        } : undefined)
      if (!result || generation !== roonGenreRequestGeneration) return
      delete detailRequests.genre
      selectedRoonGenrePage.value = initial || result.restarted ? result.page : appendRoonPage(selectedRoonGenrePage.value, result.page)
      roonGenreInitialLoading.value = false
      roonGenreLoadingMore.value = false
      roonGenreError.value = null
      onDetailReady('roon-genre-detail', { type: 'roon-genre', reference })
    } catch (error) {
      if (generation !== roonGenreRequestGeneration) return
      if (isLibraryReadCancelled(error)) { roonGenreInitialLoading.value = false; roonGenreLoadingMore.value = false; return }
      delete detailRequests.genre
      if (initial) {
        roonGenreInitialLoading.value = false
        roonGenreError.value = formatError(error)
      } else {
        roonGenreLoadingMore.value = false
        roonGenreLoadMoreError.value = error instanceof RoonPageEpochChanged ? '读取上下文反复变化，请重新读取。' : '加载失败，点击重试'
      }
    }
  }

  async function loadRoonPlaylist(
    reference: string,
    page: PageRequest = { offset: 0, limit: 24 },
    resume = false,
  ): Promise<void> {
    if (disposed) return
    const initial = page.offset === 0
    if (!initial && detailTargets.playlist?.reference !== reference) {
      roonPlaylistLoadMoreError.value = '读取目标已变化，请重新读取。'
      return
    }
    const playlist = roonPlaylistsPage.value.items.find((item) => item.reference === reference)
    if (playlist?.kind === 'playlist') selectedRoonPlaylist.value = playlist
    if (initial && selectedRoonPlaylist.value?.reference !== reference) selectedRoonPlaylist.value = null
    if (initial) {
      if (!resume) detailRebases.playlist = 0
      roonPlaylistRequestGeneration += 1
      detailReads.playlist.cancelAll()
      roonPlaylistLoadingMore.value = false
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
    detailRequests.playlist = { reference, page: { ...page } }
    detailTargets.playlist = detailRequests.playlist
    try {
      const result = await readRoonDatasetPage(initial ? undefined : selectedRoonPlaylistPage.value, page,
        target => detailReads.playlist.read('roon.library.playlist', { reference, page: target }, () => api.getRoonPlaylistTracks(reference, target)),
        () => generation === roonPlaylistRequestGeneration,
        detailRebases.playlist === 0 ? () => {
          detailRebases.playlist++
          invalidateDetailEpoch(selectedRoonPlaylistPage.value)
          detailRequests.playlist = { reference, page: { offset: 0, limit: page.limit } }
          detailTargets.playlist = detailRequests.playlist
        } : undefined)
      if (!result || generation !== roonPlaylistRequestGeneration) return
      delete detailRequests.playlist
      selectedRoonPlaylistPage.value = initial || result.restarted ? result.page : appendRoonPage(selectedRoonPlaylistPage.value, result.page)
      roonPlaylistInitialLoading.value = false
      roonPlaylistLoadingMore.value = false
      roonPlaylistError.value = null
      onDetailReady('roon-playlist-detail', { type: 'roon-playlist', reference })
    } catch (error) {
      if (generation !== roonPlaylistRequestGeneration) return
      if (isLibraryReadCancelled(error)) { roonPlaylistInitialLoading.value = false; roonPlaylistLoadingMore.value = false; return }
      delete detailRequests.playlist
      if (initial) {
        roonPlaylistInitialLoading.value = false
        roonPlaylistError.value = formatError(error)
      } else {
        roonPlaylistLoadingMore.value = false
        roonPlaylistLoadMoreError.value = error instanceof RoonPageEpochChanged ? '读取上下文反复变化，请重新读取。' : '加载失败，点击重试'
      }
    }
  }

  function roonAlbumPageAt(offset: number): void {
    const reference = selectedRoonAlbum.value?.reference ?? detailTargets.album?.reference
    if (reference) void loadRoonAlbum(reference, { offset, limit: selectedRoonAlbumPage.value.limit })
  }

  function roonArtistPageAt(offset: number): void {
    const reference = selectedRoonArtist.value?.reference ?? detailTargets.artist?.reference
    if (reference) void loadRoonArtist(reference, { offset, limit: selectedRoonArtistPage.value.limit })
  }

  function roonGenrePageAt(offset: number): void {
    const reference = selectedRoonGenre.value?.reference ?? detailTargets.genre?.reference
    if (reference) void loadRoonGenre(reference, { offset, limit: selectedRoonGenrePage.value.limit })
  }

  function roonPlaylistPageAt(offset: number): void {
    const reference = selectedRoonPlaylist.value?.reference ?? detailTargets.playlist?.reference
    if (reference) void loadRoonPlaylist(reference, { offset, limit: selectedRoonPlaylistPage.value.limit })
  }

  async function loadRoonEntityFavorite(
    item: RoonLibraryItem,
    kind: 'album' | 'artist',
  ): Promise<void> {
    if (disposed) return
    const operation = ++entityFavoriteOperation
    entityFavoriteReads.cancelAll()
    const state = kind === 'album' ? roonAlbumFavoriteState : roonArtistFavoriteState
    state.value = 'loading'
    try {
      const result = await entityFavoriteReads.read('favorites.check', { descriptor: localFavoriteDescriptor(item) }, () => api.checkFavorite(localFavoriteDescriptor(item)))
      if (operation !== entityFavoriteOperation) return
      state.value = result.favorite ? 'liked' : 'not-liked'
    } catch (error) {
      if (operation !== entityFavoriteOperation) return
      if (isLibraryReadCancelled(error)) { state.value = 'idle'; return }
      state.value = 'error'
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
    if (disposed) return
    const initial = page.offset === 0
    if (initial) {
      favoriteKind.value = kind
      favoritesRequestGeneration += 1
      favoriteReads.cancelAll()
      favoritesLoadingMore.value = false
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
    pendingFavorite = { kind, page: { ...page } }
    try {
      const result = await favoriteReads.read('favorites.list', { kind, page }, () => api.listFavorites(kind, page))
      if (generation !== favoritesRequestGeneration || kind !== favoriteKind.value) return
      pendingFavorite = undefined
      favoritesPage.value = initial ? result : {
        ...result,
        items: [...favoritesPage.value.items, ...result.items.filter((item) => !favoritesPage.value.items.some((existing) => existing.favoriteId === item.favoriteId))],
      }
      favoritesInitialLoading.value = false
      favoritesLoadingMore.value = false
      favoritesError.value = null
    } catch (error) {
      if (generation !== favoritesRequestGeneration || kind !== favoriteKind.value) return
      if (isLibraryReadCancelled(error)) { favoritesInitialLoading.value = false; favoritesLoadingMore.value = false; return }
      pendingFavorite = undefined
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
    const reference = selectedRoonAlbum.value?.reference ?? detailTargets.album?.reference
    if (reference) void loadRoonAlbum(reference)
  }

  function refreshVisibleRoonCollection(): void {
    if (getView() === 'roon-favorites') favoriteResolutionEpoch.value += 1
    if (getView() === 'roon-albums' && !roonAlbumsInitialLoading.value) void loadRoonAlbums()
    if (getView() === 'roon-artists' && !roonArtistsInitialLoading.value) void loadRoonArtists()
    if (getView() === 'roon-genres' && !roonGenresInitialLoading.value) void loadRoonGenres()
    if (getView() === 'roon-playlists' && !roonPlaylistsInitialLoading.value) void loadRoonPlaylists()
  }


  function invalidateDetailRequests(): void {
    roonAlbumRequestGeneration += 1
    roonArtistRequestGeneration += 1
    roonGenreRequestGeneration += 1
    roonPlaylistRequestGeneration += 1
    for (const scope of Object.values(detailReads)) scope.cancelAll()
    roonAlbumInitialLoading.value = false; roonAlbumLoadingMore.value = false
    roonArtistInitialLoading.value = false; roonArtistLoadingMore.value = false
    roonGenreInitialLoading.value = false; roonGenreLoadingMore.value = false
    roonPlaylistInitialLoading.value = false; roonPlaylistLoadingMore.value = false
  }

  // 旧调用名保留，所有详情一起换代，避免流派或歌单的旧回执重新导航。
  function invalidateAlbumArtistRequests(): void { invalidateDetailRequests() }
  function leaveDetail(): void {
    invalidateDetailRequests()
    entityFavoriteOperation += 1
    entityFavoriteReads.cancelAll()
  }

  function suspendPageReads(destination: ViewId): void {
    const collections = { 'roon-albums': albumCollection, 'roon-artists': artistCollection, 'roon-genres': genreCollection, 'roon-playlists': playlistCollection }
    for (const [view, collection] of Object.entries(collections)) if (view !== destination) collection.suspend()
    if (destination !== 'roon-favorites') {
      favoritesRequestGeneration += 1
      favoriteReads.cancelAll()
      favoritesInitialLoading.value = false; favoritesLoadingMore.value = false
    }
    leaveDetail()
  }

  async function resumePageReads(view: ViewId): Promise<void> {
    if (disposed) return
    if (view === 'roon-albums') await albumCollection.resume()
    else if (view === 'roon-artists') await artistCollection.resume()
    else if (view === 'roon-genres') await genreCollection.resume()
    else if (view === 'roon-playlists') await playlistCollection.resume()
    else if (view === 'roon-favorites' && pendingFavorite && !favoritesInitialLoading.value && !favoritesLoadingMore.value) await loadFavorites(pendingFavorite.kind, pendingFavorite.page)
  }

  function resumeDetail(view: ViewId): void {
    const detailKinds: Partial<Record<ViewId, DetailKind>> = { 'roon-album-detail': 'album', 'roon-artist-detail': 'artist', 'roon-genre-detail': 'genre', 'roon-playlist-detail': 'playlist' }
    const kind = detailKinds[view]
    if (!kind || disposed) return
    const request = detailRequests[kind]
    if (!request) return
    const load = { album: loadRoonAlbum, artist: loadRoonArtist, genre: loadRoonGenre, playlist: loadRoonPlaylist }[kind]
    void load(request.reference, request.page, true)
  }

  function captureDetail() {
    return {
      epoch: sessionEpoch, rebases: { ...detailRebases }, requests: { ...detailRequests }, targets: { ...detailTargets },
      album: selectedRoonAlbum.value, albumPage: selectedRoonAlbumPage.value,
      albumError: roonAlbumError.value, albumFavorite: roonAlbumFavoriteState.value,
      albumLoadMoreError: roonAlbumLoadMoreError.value, albumPending: roonAlbumInitialLoading.value,
      artist: selectedRoonArtist.value, artistPage: selectedRoonArtistPage.value,
      artistError: roonArtistError.value, artistFavorite: roonArtistFavoriteState.value,
      artistLoadMoreError: roonArtistLoadMoreError.value, artistPending: roonArtistInitialLoading.value,
      genre: selectedRoonGenre.value, genrePage: selectedRoonGenrePage.value, genreError: roonGenreError.value, genreLoadMoreError: roonGenreLoadMoreError.value,
      playlist: selectedRoonPlaylist.value, playlistPage: selectedRoonPlaylistPage.value, playlistError: roonPlaylistError.value, playlistLoadMoreError: roonPlaylistLoadMoreError.value,
    }
  }

  function restoreDetail(snapshot: ReturnType<typeof captureDetail>): void {
    if (snapshot.epoch !== sessionEpoch) return
    leaveDetail()
    for (const kind of Object.keys(detailReads) as DetailKind[]) { delete detailRequests[kind]; if (snapshot.requests[kind]) detailRequests[kind] = snapshot.requests[kind] }
    for (const kind of Object.keys(detailReads) as DetailKind[]) { delete detailTargets[kind]; if (snapshot.targets[kind]) detailTargets[kind] = snapshot.targets[kind] }
    selectedRoonAlbum.value = snapshot.album; selectedRoonAlbumPage.value = snapshot.albumPage
    roonAlbumError.value = snapshot.albumError; roonAlbumFavoriteState.value = snapshot.albumFavorite
    roonAlbumLoadMoreError.value = snapshot.albumLoadMoreError
    selectedRoonArtist.value = snapshot.artist; selectedRoonArtistPage.value = snapshot.artistPage
    roonArtistError.value = snapshot.artistError; roonArtistFavoriteState.value = snapshot.artistFavorite
    roonArtistLoadMoreError.value = snapshot.artistLoadMoreError
    selectedRoonGenre.value = snapshot.genre; selectedRoonGenrePage.value = snapshot.genrePage
    roonGenreError.value = snapshot.genreError; roonGenreLoadMoreError.value = snapshot.genreLoadMoreError
    selectedRoonPlaylist.value = snapshot.playlist; selectedRoonPlaylistPage.value = snapshot.playlistPage
    roonPlaylistError.value = snapshot.playlistError; roonPlaylistLoadMoreError.value = snapshot.playlistLoadMoreError
    const pages = { album: selectedRoonAlbumPage, artist: selectedRoonArtistPage, genre: selectedRoonGenrePage, playlist: selectedRoonPlaylistPage }
    for (const kind of Object.keys(detailReads) as DetailKind[]) {
      detailRebases[kind] = snapshot.rebases[kind]
      const page = pages[kind].value
      const target = detailTargets[kind]
      if (!page.sourceEpoch || !invalidDetailEpochs.has(page.sourceEpoch) || !target) continue
      pages[kind].value = emptyRoonPage(page.limit)
      // 父页只恢复目标与滚动位置；失效快照不与新页混合。
      detailRequests[kind] = { reference: target.reference, page: { offset: 0, limit: page.limit } }
      detailRebases[kind] = Math.max(1, detailRebases[kind])
    }
  }

  function resetSession(): void {
    sessionEpoch += 1
    invalidDetailEpochs.clear()
    for (const kind of Object.keys(detailReads) as DetailKind[]) detailRebases[kind] = 0
    leaveDetail()
    favoriteReads.cancelAll()
    catalogReads.cancelAll()
    pendingFavorite = undefined
    for (const kind of Object.keys(detailReads) as DetailKind[]) { delete detailRequests[kind]; delete detailTargets[kind] }
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
    disposed = true
    resetSession()
    for (const collection of [albumCollection, artistCollection, genreCollection, playlistCollection]) collection.dispose()
    for (const scope of [catalogReads, favoriteReads, entityFavoriteReads, ...Object.values(detailReads)]) scope.dispose()
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
    restoreDetail, resumeDetail, suspendPageReads, resumePageReads, resetSession, dispose,
  }
}
