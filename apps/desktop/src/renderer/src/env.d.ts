import type { MusicBridgePublicApi } from '../../preload/api.js'

declare global {
  interface Window {
    musicBridge: MusicBridgePublicApi
  }
}

export {}
