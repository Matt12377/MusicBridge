import { runCoreUtilityProcess } from '../../../../packages/bridge-core/src/utility-main.js'
import { loadBundledConverter } from '../../../../packages/bridge-core/src/recording/bundled-converter.js'
import { bundledConverterRoot } from './converter-bootstrap.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

declare const __MUSIC_BRIDGE_FFMPEG_MANIFEST_SHA256__: string | null

void runCoreUtilityProcess(process.env, async () => {
  const root = bundledConverterRoot(process.env, {
    platform: process.platform, arch: process.arch,
    entryDirectory: path.dirname(fileURLToPath(import.meta.url)), resourcesDirectory: process.resourcesPath,
  })
  if (!root) return undefined
  try { return await loadBundledConverter(root, __MUSIC_BRIDGE_FFMPEG_MANIFEST_SHA256__) }
  catch {
    // 转换器不准入不能破坏既有播放；不向 Renderer 或日志暴露私有构建路径。
    console.warn('固定音频转换器未通过校验；转换操作保持禁用。')
    return undefined
  }
})
