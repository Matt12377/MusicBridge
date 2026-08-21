import type {
  PublicAuthState,
  PublicBridgeState,
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
    onCoreEvent,
  })
}
