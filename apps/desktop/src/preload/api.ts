import type {
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
  TrackSummary,
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
  getLikedTracks: (page: PageRequest) => Promise<Page<TrackSummary>>
  getUserPlaylists: () => Promise<readonly PlaylistSummary[]>
  getPlaylist: (playlistId: string, page: PageRequest) => Promise<PlaylistDetail>
  getDailyRecommendations: () => Promise<DailyRecommendationsSnapshot>
  listZones: () => Promise<{ zones: readonly PublicRoonZone[] }>
  selectZone: (zoneId: string) => Promise<PublicBridgeState>
  listRoonAlbums: (page: PageRequest) => Promise<RoonLibraryPage>
  getRoonAlbumTracks: (reference: string, page: PageRequest) => Promise<RoonLibraryPage>
  getRoonImage: (reference: string, options?: RoonImageOptions) => Promise<RoonImageResult>
  getLyrics: (trackId: string) => Promise<LyricsSnapshot>
  getPlaybackState: () => Promise<PlaybackSnapshot>
  play: (trackId: string, quality: PlaybackQualityPreference) => Promise<PlaybackSnapshot>
  stop: () => Promise<PlaybackSnapshot>
  next: () => Promise<PlaybackSnapshot>
  previous: () => Promise<PlaybackSnapshot>
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
  'getLikedTracks',
  'getUserPlaylists',
  'getPlaylist',
  'getDailyRecommendations',
  'listZones',
  'selectZone',
  'listRoonAlbums',
  'getRoonAlbumTracks',
  'getRoonImage',
  'getLyrics',
  'getPlaybackState',
  'play',
  'stop',
  'next',
  'previous',
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
  play: (trackId: string, quality: PlaybackQualityPreference) => Promise<PlaybackSnapshot>,
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
  listRoonAlbums: (_page: PageRequest) => Promise<RoonLibraryPage> = async () => {
    throw new Error('Roon Library API is unavailable')
  },
  getRoonAlbumTracks: (_reference: string, _page: PageRequest) => Promise<RoonLibraryPage> = async () => {
    throw new Error('Roon Library API is unavailable')
  },
  getRoonImage: (_reference: string, _options?: RoonImageOptions) => Promise<RoonImageResult> = async () => {
    throw new Error('Roon Library API is unavailable')
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
    getLikedTracks,
    getUserPlaylists,
    getPlaylist,
    getDailyRecommendations,
    listZones,
    selectZone,
    listRoonAlbums,
    getRoonAlbumTracks,
    getRoonImage,
    getLyrics,
    getPlaybackState,
    play,
    stop,
    next,
    previous,
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
