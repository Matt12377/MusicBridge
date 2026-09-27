import { runCoreUtilityProcess } from '../../../../packages/bridge-core/src/utility-main.js'
import { loadBundledConverter } from '../../../../packages/bridge-core/src/recording/bundled-converter.js'
import { bundledConverterRoot } from './converter-bootstrap.js'
import { loadBundledOutputHelper } from '../../../../packages/bridge-core/src/recording/bundled-output-helper.js'
import { loadBundledDeviceOutputHelper } from '../../../../packages/bridge-core/src/recording/bundled-device-output-helper.js'
import type { GateBCandidateIdentity } from '../../../../packages/bridge-core/src/recording/gate-b-admission.js'
import { loadOutputHelperForCore } from './output-bootstrap.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

declare const __MUSIC_BRIDGE_FFMPEG_MANIFEST_SHA256__: string | null
declare const __MUSIC_BRIDGE_OUTPUT_MANIFEST_SHA256__: string | null
declare const __MUSIC_BRIDGE_OUTPUT_DEVICE_MANIFEST_SHA256__: string | null
declare const __MUSIC_BRIDGE_OUTPUT_DEVICE_CANDIDATE__: GateBCandidateIdentity | null

async function loadDeviceOutputHelperForCore() {
  // 测试Core即使旁边有新包也不能借真实HAL枚举；测试开关只收紧，不授予权限。
  if (process.env.MUSIC_BRIDGE_CORE_TEST_MODE === '1' || process.platform !== 'darwin' || process.arch !== 'arm64'
    || __MUSIC_BRIDGE_OUTPUT_DEVICE_MANIFEST_SHA256__ === null) return undefined
  const entryDirectory = path.dirname(fileURLToPath(import.meta.url))
  const packagedEntry = path.join(process.resourcesPath, 'app.asar', 'dist', 'main')
  const root = entryDirectory === packagedEntry
    ? path.join(process.resourcesPath, 'output-device', 'darwin-arm64')
    : path.resolve(entryDirectory, '../../native/output-device/darwin-arm64')
  try { return await loadBundledDeviceOutputHelper(root, __MUSIC_BRIDGE_OUTPUT_DEVICE_MANIFEST_SHA256__) }
  catch {
    console.warn('固定正式设备helper未通过校验；设备输出保持禁用。')
    return undefined
  }
}

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
}, () => loadOutputHelperForCore(process.env, {
  platform: process.platform, arch: process.arch,
  entryDirectory: path.dirname(fileURLToPath(import.meta.url)), resourcesDirectory: process.resourcesPath,
}, __MUSIC_BRIDGE_OUTPUT_MANIFEST_SHA256__, loadBundledOutputHelper),
loadDeviceOutputHelperForCore, __MUSIC_BRIDGE_OUTPUT_DEVICE_CANDIDATE__)
