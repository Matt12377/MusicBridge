import type { PublicBridgeState, TypedIpcEvent } from '@music-bridge/contracts'

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
  onCoreEvent: (listener: (event: TypedIpcEvent) => void) => () => void
}

export const PUBLIC_API_KEYS = [
  'getAppInfo',
  'getCoreHealth',
  'getCoreState',
  'pingCore',
  'onCoreEvent',
] as const

export function createPreloadApi(
  getAppInfo: () => Promise<AppInfo>,
  getCoreHealth: () => Promise<PublicBridgeState>,
  getCoreState: () => Promise<PublicBridgeState>,
  pingCore: () => Promise<{ pong: true }>,
  onCoreEvent: (listener: (event: TypedIpcEvent) => void) => () => void,
): MusicBridgePublicApi {
  return Object.freeze({
    getAppInfo,
    getCoreHealth,
    getCoreState,
    pingCore,
    onCoreEvent,
  })
}
