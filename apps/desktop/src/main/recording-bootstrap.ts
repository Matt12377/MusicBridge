import { loadBundledConverter } from '../../../../packages/bridge-core/src/recording/bundled-converter.js'
import { loadBundledOutputHelper } from '../../../../packages/bridge-core/src/recording/bundled-output-helper.js'
import { loadBundledDeviceOutputHelper } from '../../../../packages/bridge-core/src/recording/bundled-device-output-helper.js'
import type { FfmpegConverter } from '../../../../packages/bridge-core/src/recording/audio-converter.js'
import type { PinnedOutputHelper } from '../../../../packages/bridge-core/src/recording/bundled-output-helper.js'
import type { PinnedDeviceOutputHelper } from '../../../../packages/bridge-core/src/recording/bundled-device-output-helper.js'
import type { GateBCandidateIdentity } from '../../../../packages/bridge-core/src/recording/gate-b-admission.js'
import { bundledConverterRoot } from './converter-bootstrap.js'
import { loadOutputHelperForCore } from './output-bootstrap.js'
import path from 'node:path'

declare const __MUSIC_BRIDGE_FFMPEG_MANIFEST_SHA256__: string | null
declare const __MUSIC_BRIDGE_OUTPUT_MANIFEST_SHA256__: string | null
declare const __MUSIC_BRIDGE_OUTPUT_DEVICE_MANIFEST_SHA256__: string | null
declare const __MUSIC_BRIDGE_OUTPUT_DEVICE_CANDIDATE__: GateBCandidateIdentity | null

export interface RecordingBootstrapContext {
  platform: NodeJS.Platform
  arch: string
  entryDirectory: string
  resourcesDirectory: string
}
export interface OwnerRecordingDependencies {
  recordingConverter?: FfmpegConverter
  recordingOutputHelper?: PinnedOutputHelper
  recordingDeviceOutputHelper?: PinnedDeviceOutputHelper
  recordingGateBCandidate: GateBCandidateIdentity | null
}

async function loadDeviceOutputHelperForOwner(env: NodeJS.ProcessEnv, context: RecordingBootstrapContext) {
  // 合成所有者即使旁边有设备包也不能取得真实HAL权限。
  if (env.MUSIC_BRIDGE_CORE_TEST_MODE === '1' || context.platform !== 'darwin' || context.arch !== 'arm64'
    || __MUSIC_BRIDGE_OUTPUT_DEVICE_MANIFEST_SHA256__ === null) return undefined
  const packagedEntry = path.join(context.resourcesDirectory, 'app.asar', 'dist', 'main')
  const root = context.entryDirectory === packagedEntry
    ? path.join(context.resourcesDirectory, 'output-device', 'darwin-arm64')
    : path.resolve(context.entryDirectory, '../../native/output-device/darwin-arm64')
  try { return await loadBundledDeviceOutputHelper(root, __MUSIC_BRIDGE_OUTPUT_DEVICE_MANIFEST_SHA256__) }
  catch {
    console.warn('固定正式设备helper未通过校验；设备输出保持禁用。')
    return undefined
  }
}

// 工厂及原生资源在实际拥有数据集的线程中创建，不通过MessagePort传函数或FD。
export async function loadRecordingDependenciesForOwner(
  env: NodeJS.ProcessEnv,
  context: RecordingBootstrapContext,
): Promise<OwnerRecordingDependencies> {
  let recordingConverter: FfmpegConverter | undefined
  const root = bundledConverterRoot(env, context)
  if (root) {
    try { recordingConverter = await loadBundledConverter(root, __MUSIC_BRIDGE_FFMPEG_MANIFEST_SHA256__) }
    catch {
      console.warn('固定音频转换器未通过校验；转换操作保持禁用。')
    }
  }
  const recordingOutputHelper = await loadOutputHelperForCore(env, context,
    __MUSIC_BRIDGE_OUTPUT_MANIFEST_SHA256__, loadBundledOutputHelper)
  const recordingDeviceOutputHelper = await loadDeviceOutputHelperForOwner(env, context)
  return {
    ...(recordingConverter ? { recordingConverter } : {}),
    ...(recordingOutputHelper ? { recordingOutputHelper } : {}),
    ...(recordingDeviceOutputHelper ? { recordingDeviceOutputHelper } : {}),
    recordingGateBCandidate: __MUSIC_BRIDGE_OUTPUT_DEVICE_CANDIDATE__ ?? null,
  }
}
