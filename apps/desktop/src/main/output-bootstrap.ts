import path from 'node:path'

interface OutputHost { platform: string; arch: string; entryDirectory: string; resourcesDirectory: string }

/** 固定路径只来自Core宿主；测试开关仅允许无设备helper，不授予硬件访问。 */
export function bundledOutputRoot(env: NodeJS.ProcessEnv, host: OutputHost): string | undefined {
  if (host.platform !== 'darwin' || host.arch !== 'arm64') return undefined
  if (env.MUSIC_BRIDGE_CORE_TEST_MODE === '1' && !(env.MUSIC_BRIDGE_UI_E2E === '1' && env.MUSIC_BRIDGE_BUNDLED_OUTPUT_GATE === '1')) return undefined
  const packagedEntry = path.join(host.resourcesDirectory, 'app.asar', 'dist', 'main')
  return host.entryDirectory === packagedEntry
    ? path.join(host.resourcesDirectory, 'output', 'darwin-arm64')
    : path.resolve(host.entryDirectory, '../../native/output/darwin-arm64')
}

export async function loadOutputHelperForCore<T>(env: NodeJS.ProcessEnv, host: OutputHost, expectedHash: string | null, loader: (root: string, expectedHash: string | null) => Promise<T | undefined>): Promise<T | undefined> {
  const root = bundledOutputRoot(env, host)
  if (!root || expectedHash === null) return undefined
  try { return await loader(root, expectedHash) }
  catch {
    // 无设备检查禁用不影响既有播放，不记录私有路径或加载异常。
    return undefined
  }
}
