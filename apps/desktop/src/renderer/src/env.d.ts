import type { MobileConnectionPublicApi } from '../../shared/mobile-settings.js'
import type { MusicBridgePublicApi } from '../../preload/api.js'
import type { ArtistSearchCatalogPublicApi } from '@music-bridge/contracts'

declare global {
  interface Window {
    musicBridge: MusicBridgePublicApi
    musicBridgeMobile?: MobileConnectionPublicApi
    musicBridgeCatalog?: ArtistSearchCatalogPublicApi
  }
}

export {}
