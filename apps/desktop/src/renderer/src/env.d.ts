import type { MobileConnectionPublicApi } from '../../shared/mobile-settings.js'
import type { MusicBridgePublicApi } from '../../preload/api.js'

declare global {
  interface Window {
    musicBridge: MusicBridgePublicApi
    musicBridgeMobile?: MobileConnectionPublicApi
  }
}

export {}
