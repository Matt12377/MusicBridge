import path from 'node:path'
import type { MobileDsdDomainOptions } from '../../../../packages/bridge-core/src/mobile/prepared-cache-types.js'

declare const __MUSIC_BRIDGE_MOBILE_FFMPEG_MANIFEST_SHA256__: string | null

export interface MobileDsdBootstrapContext {
  platform: NodeJS.Platform
  arch: string
  entryDirectory: string
  resourcesDirectory: string
}

/** 仅使用实际 Owner 启动位置；不接受 Renderer、PATH 或环境中的自定义后端路径。 */
export function bundledMobileDsdRoot(
  env: NodeJS.ProcessEnv,
  context: MobileDsdBootstrapContext,
): string | undefined {
  if (context.platform !== 'darwin' || context.arch !== 'arm64') return undefined
  if (env.MUSIC_BRIDGE_CORE_TEST_MODE === '1'
    && !(env.MUSIC_BRIDGE_UI_E2E === '1' && env.MUSIC_BRIDGE_MOBILE_DSD_BACKEND_GATE === '1')) return undefined
  if (![context.entryDirectory, context.resourcesDirectory].every(directory =>
    path.isAbsolute(directory) && !directory.includes('\0') && directory.length <= 4096)) return undefined
  const packagedEntry = path.join(context.resourcesDirectory, 'app.asar', 'dist', 'main')
  return context.entryDirectory === packagedEntry
    ? path.join(context.resourcesDirectory, 'mobile-ffmpeg', 'darwin-arm64')
    : path.resolve(context.entryDirectory, '../../native/mobile-ffmpeg/darwin-arm64')
}

/** 这里只构造编译锁定配置；实际 converter/cache/源读取资格由同一个 Owner 加载后核验。 */
export function mobileDsdOptionsForOwner(
  env: NodeJS.ProcessEnv,
  context: MobileDsdBootstrapContext,
  dataDirectory: string,
): MobileDsdDomainOptions | undefined {
  const root = bundledMobileDsdRoot(env, context)
  const manifestSha256 = typeof __MUSIC_BRIDGE_MOBILE_FFMPEG_MANIFEST_SHA256__ === 'string'
    ? __MUSIC_BRIDGE_MOBILE_FFMPEG_MANIFEST_SHA256__ : undefined
  if (!root || !manifestSha256 || !/^[a-f0-9]{64}$/u.test(manifestSha256)
    || !path.isAbsolute(dataDirectory) || dataDirectory.includes('\0') || dataDirectory.length > 4096) return undefined
  return { converterDirectory: root, converterManifestSha256: manifestSha256,
    cacheDirectory: path.join(dataDirectory, 'mobile-dsd-cache') }
}
