import type {
  AlbumDetail,
  AlbumSummary,
  ArtistDetail,
  ArtistSummary,
  Page,
  PageRequest,
  PlaylistDetail,
  PlaylistSummary,
  LyricsSnapshot,
  PlaybackQueueRequestItem,
  PlaybackQualityPreference,
  PlaybackSnapshot,
  PublicAuthState,
  PublicAccountState,
  PublicBridgeState,
  PublicRoonZone,
  RoonImageOptions,
  RoonImageResult,
  RoonLibraryPage,
  RemoteCoreTunnelState,
  DailyRecommendationsSnapshot,
  FavoriteEntityDescriptor,
  FavoriteKind,
  FavoritePage,
  FavoriteRecord,
  TrackSummary,
  PublicTrackMatchResult,
  PublicAggregatedSearchResult,
  TypedIpcEvent,
} from '@music-bridge/contracts'

export type AppCommand = 'show-queue'

export interface AppInfo {
  version: string
  buildMode: 'development' | 'production'
  platform: string
}

export const DEFAULT_REMOTE_CORE_STATE: RemoteCoreTunnelState = {
  mode: 'local-core',
  status: 'idle',
  localStreamPort: 38502,
  remoteHealth: 'unavailable',
  autoReconnect: false,
}

export interface MusicBridgePublicApi {
  getAppInfo: () => Promise<AppInfo>
  getCoreHealth: () => Promise<PublicBridgeState>
  getCoreState: () => Promise<PublicBridgeState>
  pingCore: () => Promise<{ pong: true }>
  exportDiagnostics: () => Promise<{ exported: boolean }>
  getAuthState: () => Promise<PublicAuthState>
  beginQrLogin: () => Promise<PublicAuthState>
  pollQrLogin: (challengeId: string) => Promise<PublicAuthState>
  cancelQrLogin: (challengeId: string) => Promise<PublicAuthState>
  logout: () => Promise<PublicAuthState>
  getAccountState: () => Promise<PublicAccountState>
  refreshAccountProfile: () => Promise<PublicAccountState>
  searchTracks: (query: string, page: PageRequest) => Promise<Page<TrackSummary>>
  searchArtists: (query: string, page: PageRequest) => Promise<Page<ArtistSummary>>
  searchAlbums: (query: string, page: PageRequest) => Promise<Page<AlbumSummary>>
  getArtist: (artistId: string, page: PageRequest) => Promise<ArtistDetail>
  getAlbum: (albumId: string, page: PageRequest) => Promise<AlbumDetail>
  getLikedTracks: (page: PageRequest) => Promise<Page<TrackSummary>>
  getTrackLikeStatus: (trackId: string) => Promise<{ liked: boolean }>
  setTrackLiked: (trackId: string, liked: boolean) => Promise<{ liked: boolean }>
  matchLibraryTrack: (track: TrackSummary) => Promise<PublicTrackMatchResult>
  aggregateSearch: (query: string, page: PageRequest) => Promise<PublicAggregatedSearchResult>
  seek: (positionMs: number) => Promise<{ positionMs: number }>
  getUserPlaylists: () => Promise<readonly PlaylistSummary[]>
  getPlaylist: (playlistId: string, page: PageRequest) => Promise<PlaylistDetail>
  getDailyRecommendations: () => Promise<DailyRecommendationsSnapshot>
  listFavorites: (kind: FavoriteKind | undefined, page: PageRequest) => Promise<FavoritePage>
  checkFavorite: (descriptor: FavoriteEntityDescriptor) => Promise<{ favorite: boolean }>
  setFavorite: (descriptor: FavoriteEntityDescriptor, favorite: boolean) => Promise<{ favorite: boolean; item?: FavoriteRecord }>
  listZones: () => Promise<{ zones: readonly PublicRoonZone[] }>
  selectZone: (zoneId: string) => Promise<PublicBridgeState>
  listRoonAlbums: (page: PageRequest) => Promise<RoonLibraryPage>
  listRoonArtists: (page: PageRequest) => Promise<RoonLibraryPage>
  listRoonGenres: (page: PageRequest) => Promise<RoonLibraryPage>
  listRoonPlaylists: (page: PageRequest) => Promise<RoonLibraryPage>
  getRoonAlbumTracks: (reference: string, page: PageRequest) => Promise<RoonLibraryPage>
  getRoonArtistAlbums: (reference: string, page: PageRequest) => Promise<RoonLibraryPage>
  getRoonGenreItems: (reference: string, page: PageRequest) => Promise<RoonLibraryPage>
  getRoonPlaylistTracks: (reference: string, page: PageRequest) => Promise<RoonLibraryPage>
  searchRoonLibrary: (query: string, page: PageRequest) => Promise<RoonLibraryPage>
  getRoonImage: (reference: string, options?: RoonImageOptions) => Promise<RoonImageResult>
  playRoonTrack: (reference: string, zoneId: string) => Promise<{ started: true }>
  queueRoonTrack: (reference: string, zoneId: string) => Promise<{ queued: true }>
  stopRoonTransport: () => Promise<{ stopped: true }>
  getLyrics: (trackId: string) => Promise<LyricsSnapshot>
  getPlaybackState: () => Promise<PlaybackSnapshot>
  play: (
    trackId: string,
    quality: PlaybackQualityPreference,
    rendererClickAtMs?: number,
  ) => Promise<PlaybackSnapshot>
  pause: () => Promise<PlaybackSnapshot>
  resume: () => Promise<PlaybackSnapshot>
  stop: () => Promise<PlaybackSnapshot>
  next: () => Promise<PlaybackSnapshot>
  previous: () => Promise<PlaybackSnapshot>
  playQueueIndex: (index: number) => Promise<PlaybackSnapshot>
  replaceQueue: (items: readonly PlaybackQueueRequestItem[], index: number) => Promise<PlaybackSnapshot>
  appendQueue: (items: readonly PlaybackQueueRequestItem[]) => Promise<PlaybackSnapshot>
  insertNext: (items: readonly PlaybackQueueRequestItem[]) => Promise<PlaybackSnapshot>
  onCoreEvent: (listener: (event: TypedIpcEvent) => void) => () => void
  onAppCommand: (listener: (command: AppCommand) => void) => () => void
  getRemoteCoreState: () => Promise<RemoteCoreTunnelState>
  startRemoteCore: () => Promise<RemoteCoreTunnelState>
  stopRemoteCore: () => Promise<RemoteCoreTunnelState>
  reconnectRemoteCore: () => Promise<RemoteCoreTunnelState>
  onRemoteCoreEvent: (listener: (state: RemoteCoreTunnelState) => void) => () => void
}

export const PUBLIC_API_KEYS = [
  'getAppInfo',
  'getCoreHealth',
  'getCoreState',
  'pingCore',
  'exportDiagnostics',
  'getAuthState',
  'beginQrLogin',
  'pollQrLogin',
  'cancelQrLogin',
  'logout',
  'getAccountState',
  'refreshAccountProfile',
  'searchTracks',
  'searchArtists',
  'searchAlbums',
  'getArtist',
  'getAlbum',
  'getLikedTracks',
  'getTrackLikeStatus',
  'setTrackLiked',
  'matchLibraryTrack',
  'aggregateSearch',
  'seek',
  'getUserPlaylists',
  'getPlaylist',
  'getDailyRecommendations',
  'listFavorites',
  'checkFavorite',
  'setFavorite',
  'listZones',
  'selectZone',
  'listRoonAlbums',
  'listRoonArtists',
  'listRoonGenres',
  'listRoonPlaylists',
  'getRoonAlbumTracks',
  'getRoonArtistAlbums',
  'getRoonGenreItems',
  'getRoonPlaylistTracks',
  'searchRoonLibrary',
  'getRoonImage',
  'playRoonTrack',
  'queueRoonTrack',
  'stopRoonTransport',
  'getLyrics',
  'getPlaybackState',
  'play',
  'pause',
  'resume',
  'stop',
  'next',
  'previous',
  'playQueueIndex',
  'replaceQueue',
  'appendQueue',
  'insertNext',
  'onCoreEvent',
  'onAppCommand',
  'getRemoteCoreState',
  'startRemoteCore',
  'stopRemoteCore',
  'reconnectRemoteCore',
  'onRemoteCoreEvent',
] as const

export function createPreloadApi(
  getAppInfo: () => Promise<AppInfo>,
  getCoreHealth: () => Promise<PublicBridgeState>,
  getCoreState: () => Promise<PublicBridgeState>,
  pingCore: () => Promise<{ pong: true }>,
  exportDiagnostics: () => Promise<{ exported: boolean }>,
  getAuthState: () => Promise<PublicAuthState>,
  beginQrLogin: () => Promise<PublicAuthState>,
  pollQrLogin: (challengeId: string) => Promise<PublicAuthState>,
  cancelQrLogin: (challengeId: string) => Promise<PublicAuthState>,
  logout: () => Promise<PublicAuthState>,
  getAccountState: () => Promise<PublicAccountState>,
  refreshAccountProfile: () => Promise<PublicAccountState>,
  searchTracks: (query: string, page: PageRequest) => Promise<Page<TrackSummary>>,
  getLikedTracks: (page: PageRequest) => Promise<Page<TrackSummary>>,
  getUserPlaylists: () => Promise<readonly PlaylistSummary[]>,
  getPlaylist: (playlistId: string, page: PageRequest) => Promise<PlaylistDetail>,
  getDailyRecommendations: () => Promise<DailyRecommendationsSnapshot>,
  listZones: () => Promise<{ zones: readonly PublicRoonZone[] }>,
  selectZone: (zoneId: string) => Promise<PublicBridgeState>,
  getLyrics: (trackId: string) => Promise<LyricsSnapshot>,
  getPlaybackState: () => Promise<PlaybackSnapshot>,
  play: (
    trackId: string,
    quality: PlaybackQualityPreference,
    rendererClickAtMs?: number,
  ) => Promise<PlaybackSnapshot>,
  pause: () => Promise<PlaybackSnapshot>,
  resume: () => Promise<PlaybackSnapshot>,
  stop: () => Promise<PlaybackSnapshot>,
  next: () => Promise<PlaybackSnapshot>,
  previous: () => Promise<PlaybackSnapshot>,
  replaceQueue: (items: readonly PlaybackQueueRequestItem[], index: number) => Promise<PlaybackSnapshot>,
  appendQueue: (items: readonly PlaybackQueueRequestItem[]) => Promise<PlaybackSnapshot>,
  insertNext: (items: readonly PlaybackQueueRequestItem[]) => Promise<PlaybackSnapshot>,
  onCoreEvent: (listener: (event: TypedIpcEvent) => void) => () => void,
  onAppCommand: (listener: (command: AppCommand) => void) => () => void,
  getRemoteCoreState: () => Promise<RemoteCoreTunnelState> = async () => DEFAULT_REMOTE_CORE_STATE,
  startRemoteCore: () => Promise<RemoteCoreTunnelState> = async () => DEFAULT_REMOTE_CORE_STATE,
  stopRemoteCore: () => Promise<RemoteCoreTunnelState> = async () => DEFAULT_REMOTE_CORE_STATE,
  reconnectRemoteCore: () => Promise<RemoteCoreTunnelState> = async () => DEFAULT_REMOTE_CORE_STATE,
  onRemoteCoreEvent: (
    _listener: (state: RemoteCoreTunnelState) => void,
  ) => (() => void) = () => () => undefined,
  searchArtists: (_query: string, page: PageRequest) => Promise<Page<ArtistSummary>> = async (_query, page) => ({
    items: [],
    offset: page.offset,
    limit: page.limit,
    total: 0,
    hasMore: false,
  } satisfies Page<ArtistSummary>),
  searchAlbums: (_query: string, page: PageRequest) => Promise<Page<AlbumSummary>> = async (_query, page) => ({
    items: [],
    offset: page.offset,
    limit: page.limit,
    total: 0,
    hasMore: false,
  } satisfies Page<AlbumSummary>),
  getArtist: (_artistId: string, page: PageRequest) => Promise<ArtistDetail> = async (_artistId, page) => ({
    id: '1',
    name: '未知艺人',
    tracks: { items: [], offset: page.offset, limit: page.limit, total: 0, hasMore: false },
  }),
  getAlbum: (_albumId: string, page: PageRequest) => Promise<AlbumDetail> = async (_albumId, page) => ({
    id: '1',
    name: '未知专辑',
    artistName: '未知艺人',
    tracks: { items: [], offset: page.offset, limit: page.limit, total: 0, hasMore: false },
  }),
  listRoonAlbums: (_page: PageRequest) => Promise<RoonLibraryPage> = async () => {
    throw new Error('Roon Library API is unavailable')
  },
  listRoonArtists: (_page: PageRequest) => Promise<RoonLibraryPage> = async () => {
    throw new Error('Roon Library API is unavailable')
  },
  listRoonGenres: (_page: PageRequest) => Promise<RoonLibraryPage> = async () => {
    throw new Error('Roon Library API is unavailable')
  },
  listRoonPlaylists: (_page: PageRequest) => Promise<RoonLibraryPage> = async () => {
    throw new Error('Roon Library API is unavailable')
  },
  getRoonAlbumTracks: (_reference: string, _page: PageRequest) => Promise<RoonLibraryPage> = async () => {
    throw new Error('Roon Library API is unavailable')
  },
  getRoonArtistAlbums: (_reference: string, _page: PageRequest) => Promise<RoonLibraryPage> = async () => {
    throw new Error('Roon Library API is unavailable')
  },
  getRoonGenreItems: (_reference: string, _page: PageRequest) => Promise<RoonLibraryPage> = async () => {
    throw new Error('Roon Library API is unavailable')
  },
  getRoonPlaylistTracks: (_reference: string, _page: PageRequest) => Promise<RoonLibraryPage> = async () => {
    throw new Error('Roon Library API is unavailable')
  },
  searchRoonLibrary: (_query: string, _page: PageRequest) => Promise<RoonLibraryPage> = async () => {
    throw new Error('Roon Library API is unavailable')
  },
  getRoonImage: (_reference: string, _options?: RoonImageOptions) => Promise<RoonImageResult> = async () => {
    throw new Error('Roon Library API is unavailable')
  },
  playRoonTrack: (_reference: string, _zoneId: string) => Promise<{ started: true }> = async () => {
    throw new Error('Roon Library API is unavailable')
  },
  queueRoonTrack: (_reference: string, _zoneId: string) => Promise<{ queued: true }> = async () => {
    throw new Error('Roon Library API is unavailable')
  },
  listFavorites: (_kind: FavoriteKind | undefined, _page: PageRequest) => Promise<FavoritePage> = async () => {
    throw new Error('Local favorites API is unavailable')
  },
  checkFavorite: (_descriptor: FavoriteEntityDescriptor) => Promise<{ favorite: boolean }> = async () => {
    throw new Error('Local favorites API is unavailable')
  },
  setFavorite: (_descriptor: FavoriteEntityDescriptor, _favorite: boolean) => Promise<{ favorite: boolean; item?: FavoriteRecord }> = async () => {
    throw new Error('Local favorites API is unavailable')
  },
  getTrackLikeStatus: (_trackId: string) => Promise<{ liked: boolean }> = async () => {
    throw new Error('NetEase like API is unavailable')
  },
  setTrackLiked: (_trackId: string, _liked: boolean) => Promise<{ liked: boolean }> = async () => {
    throw new Error('NetEase like API is unavailable')
  },
  matchLibraryTrack: (_track: TrackSummary) => Promise<PublicTrackMatchResult> = async () => {
    throw new Error('Roon matching API is unavailable')
  },
  aggregateSearch: (_query: string, _page: PageRequest) => Promise<PublicAggregatedSearchResult> = async () => {
    throw new Error('Aggregated search API is unavailable')
  },
  seek: (_positionMs: number) => Promise<{ positionMs: number }> = async () => {
    throw new Error('Roon Transport seek API is unavailable')
  },
  stopRoonTransport: () => Promise<{ stopped: true }> = async () => {
    throw new Error('Roon Transport stop API is unavailable')
  },
  playQueueIndex: (_index: number) => Promise<PlaybackSnapshot> = async () => {
    throw new Error('Queue index API is unavailable')
  },
): MusicBridgePublicApi {
  return Object.freeze({
    getAppInfo,
    getCoreHealth,
    getCoreState,
    pingCore,
    exportDiagnostics,
    getAuthState,
    beginQrLogin,
    pollQrLogin,
    cancelQrLogin,
    logout,
    getAccountState,
    refreshAccountProfile,
    searchTracks,
    searchArtists,
    searchAlbums,
    getArtist,
    getAlbum,
    getLikedTracks,
    getTrackLikeStatus,
    setTrackLiked,
    matchLibraryTrack,
    aggregateSearch,
    seek,
    getUserPlaylists,
    getPlaylist,
    getDailyRecommendations,
    listFavorites,
    checkFavorite,
    setFavorite,
    listZones,
    selectZone,
    listRoonAlbums,
    listRoonArtists,
    listRoonGenres,
    listRoonPlaylists,
    getRoonAlbumTracks,
    getRoonArtistAlbums,
    getRoonGenreItems,
    getRoonPlaylistTracks,
    searchRoonLibrary,
    getRoonImage,
    playRoonTrack,
    queueRoonTrack,
    stopRoonTransport,
    getLyrics,
    getPlaybackState,
    play,
    pause,
    resume,
    stop,
    next,
    previous,
    playQueueIndex,
    replaceQueue,
    appendQueue,
    insertNext,
    onCoreEvent,
    onAppCommand,
    getRemoteCoreState,
    startRemoteCore,
    stopRemoteCore,
    reconnectRemoteCore,
    onRemoteCoreEvent,
  })
}
