import path from 'node:path'

interface ConverterHost {
  platform: string
  arch: string
  entryDirectory: string
  resourcesDirectory: string
}

/** 参数仅由 Core 入口构造，不从 Renderer、工作目录或自定义环境路径推导。 */
export function bundledConverterRoot(env: NodeJS.ProcessEnv, host: ConverterHost): string | undefined {
  if (host.platform !== 'darwin' || host.arch !== 'arm64') return undefined
  if (env.MUSIC_BRIDGE_CORE_TEST_MODE === '1'
    && !(env.MUSIC_BRIDGE_UI_E2E === '1' && env.MUSIC_BRIDGE_BUNDLED_CONVERTER_GATE === '1')) return undefined
  const packagedEntry = path.join(host.resourcesDirectory, 'app.asar', 'dist', 'main')
  return host.entryDirectory === packagedEntry
    ? path.join(host.resourcesDirectory, 'ffmpeg', 'darwin-arm64')
    : path.resolve(host.entryDirectory, '../../native/ffmpeg/darwin-arm64')
}
