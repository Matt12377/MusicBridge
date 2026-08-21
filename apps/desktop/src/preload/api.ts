import type {
  Page,
  PageRequest,
  PlaylistDetail,
  PlaylistSummary,
  LyricsSnapshot,
  PlaybackQueueItem,
  PlaybackQuality,
  PlaybackSnapshot,
  PublicAuthState,
  PublicBridgeState,
  TrackSummary,
  TypedIpcEvent,
} from '@music-bridge/contracts'

export interface AppInfo {
  version: string
  buildMode: 'development' | 'production'
  platform: string
}

export interface MusicBridgePublicApi {
  getAppInfo: () => Promise<AppInfo>
  getCoreHealth: () => Promise<PublicBridgeState>
  getCoreState: () => Promise<PublicBridgeState>
  pingCore: () => Promise<{ pong: true }>
  getAuthState: () => Promise<PublicAuthState>
  beginQrLogin: () => Promise<PublicAuthState>
  pollQrLogin: (challengeId: string) => Promise<PublicAuthState>
  cancelQrLogin: (challengeId: string) => Promise<PublicAuthState>
  logout: () => Promise<PublicAuthState>
  searchTracks: (query: string, page: PageRequest) => Promise<Page<TrackSummary>>
  getLikedTracks: (page: PageRequest) => Promise<Page<TrackSummary>>
  getUserPlaylists: () => Promise<readonly PlaylistSummary[]>
  getPlaylist: (playlistId: string, page: PageRequest) => Promise<PlaylistDetail>
  getLyrics: (trackId: string) => Promise<LyricsSnapshot>
  getPlaybackState: () => Promise<PlaybackSnapshot>
  play: (trackId: string, quality: PlaybackQuality) => Promise<PlaybackSnapshot>
  stop: () => Promise<PlaybackSnapshot>
  next: () => Promise<PlaybackSnapshot>
  previous: () => Promise<PlaybackSnapshot>
  replaceQueue: (items: readonly PlaybackQueueItem[], index: number) => Promise<PlaybackSnapshot>
  onCoreEvent: (listener: (event: TypedIpcEvent) => void) => () => void
}

export const PUBLIC_API_KEYS = [
  'getAppInfo',
  'getCoreHealth',
  'getCoreState',
  'pingCore',
  'getAuthState',
  'beginQrLogin',
  'pollQrLogin',
  'cancelQrLogin',
  'logout',
  'searchTracks',
  'getLikedTracks',
  'getUserPlaylists',
  'getPlaylist',
  'getLyrics',
  'getPlaybackState',
  'play',
  'stop',
  'next',
  'previous',
  'replaceQueue',
  'onCoreEvent',
] as const

export function createPreloadApi(
  getAppInfo: () => Promise<AppInfo>,
  getCoreHealth: () => Promise<PublicBridgeState>,
  getCoreState: () => Promise<PublicBridgeState>,
  pingCore: () => Promise<{ pong: true }>,
  getAuthState: () => Promise<PublicAuthState>,
  beginQrLogin: () => Promise<PublicAuthState>,
  pollQrLogin: (challengeId: string) => Promise<PublicAuthState>,
  cancelQrLogin: (challengeId: string) => Promise<PublicAuthState>,
  logout: () => Promise<PublicAuthState>,
  searchTracks: (query: string, page: PageRequest) => Promise<Page<TrackSummary>>,
  getLikedTracks: (page: PageRequest) => Promise<Page<TrackSummary>>,
  getUserPlaylists: () => Promise<readonly PlaylistSummary[]>,
  getPlaylist: (playlistId: string, page: PageRequest) => Promise<PlaylistDetail>,
  getLyrics: (trackId: string) => Promise<LyricsSnapshot>,
  getPlaybackState: () => Promise<PlaybackSnapshot>,
  play: (trackId: string, quality: PlaybackQuality) => Promise<PlaybackSnapshot>,
  stop: () => Promise<PlaybackSnapshot>,
  next: () => Promise<PlaybackSnapshot>,
  previous: () => Promise<PlaybackSnapshot>,
  replaceQueue: (items: readonly PlaybackQueueItem[], index: number) => Promise<PlaybackSnapshot>,
  onCoreEvent: (listener: (event: TypedIpcEvent) => void) => () => void,
): MusicBridgePublicApi {
  return Object.freeze({
    getAppInfo,
    getCoreHealth,
    getCoreState,
    pingCore,
    getAuthState,
    beginQrLogin,
    pollQrLogin,
    cancelQrLogin,
    logout,
    searchTracks,
    getLikedTracks,
    getUserPlaylists,
    getPlaylist,
    getLyrics,
    getPlaybackState,
    play,
    stop,
    next,
    previous,
    replaceQueue,
    onCoreEvent,
  })
}
