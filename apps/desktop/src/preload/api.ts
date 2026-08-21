import type {
  Page,
  PageRequest,
  PlaylistDetail,
  PlaylistSummary,
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
    onCoreEvent,
  })
}
