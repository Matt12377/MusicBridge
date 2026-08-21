export interface AppInfo {
  version: string
  buildMode: 'development' | 'production'
  platform: string
}

export interface MusicBridgePublicApi {
  getAppInfo: () => Promise<AppInfo>
}

export const PUBLIC_API_KEYS = ['getAppInfo'] as const

export function createPreloadApi(
  getAppInfo: () => Promise<AppInfo>,
): MusicBridgePublicApi {
  return Object.freeze({ getAppInfo })
}
