/**
 * 仅由未打包的隔离 Electron E2E 构建；正式 core.js 不导入本文件。
 * 合成端点和软件驱动只读测试工作库的 WAV，绝不枚举或打开 HAL。
 */
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  RecordingDeviceCandidates, RecordingOutputSelection, RecordingPlanOutputBinding,
  RecordingPlanVersion, SelectRecordingDeviceRequest,
} from '@music-bridge/contracts'
import { attachCoreRuntimePort, type UtilityPort } from '../../../packages/bridge-core/src/utility-main.js'
import { createTestBridgeRuntime } from '../../../packages/bridge-core/src/runtime.js'
import { openCollectionDataset } from '../../../packages/bridge-core/src/recording/restore-dataset-runtime.js'
import { createSyntheticRoonLibrary } from '../../../packages/bridge-core/src/roon/synthetic-library.js'
import type { RecordingDeviceSelectionBroker } from '../../../packages/bridge-core/src/recording/device-selection-broker.js'
import type { GateBAdmissionSource } from '../../../packages/bridge-core/src/recording/gate-b-admission.js'
import type { RecordingAttemptAdmissionProvider } from '../../../packages/bridge-core/src/recording/attempt-coordinator.js'
import { DEVICE_OUTPUT_BACKEND_ID, DEVICE_OUTPUT_BACKEND_VERSION, DEVICE_OUTPUT_DRAIN_ALGORITHM_ID } from '../../../packages/bridge-core/src/recording/device-output-protocol.js'
import { loadBundledConverter } from '../../../packages/bridge-core/src/recording/bundled-converter.js'
import { loadBundledOutputHelper } from '../../../packages/bridge-core/src/recording/bundled-output-helper.js'
import { bundledConverterRoot } from '../src/main/converter-bootstrap.js'
import { loadOutputHelperForCore } from '../src/main/output-bootstrap.js'

declare const __MUSIC_BRIDGE_FFMPEG_MANIFEST_SHA256__: string | null
declare const __MUSIC_BRIDGE_OUTPUT_MANIFEST_SHA256__: string | null

const endpointId = 'synthetic_output'
const fullBinding: RecordingPlanOutputBinding = {
  endpointId, deviceUid: 'synthetic-test-only-output', backendId: DEVICE_OUTPUT_BACKEND_ID,
  backendVersion: DEVICE_OUTPUT_BACKEND_VERSION, bufferFrames: 256,
  configurationFingerprintSha256: 'c'.repeat(64), drainAlgorithmId: DEVICE_OUTPUT_DRAIN_ALGORITHM_ID,
}

function syntheticSelection(binding: RecordingPlanOutputBinding): RecordingDeviceSelectionBroker {
  let selected: RecordingOutputSelection | null = null
  let closed = false
  const current = () => closed || !selected ? null : { ...selected }
  const verify = async (value: RecordingOutputSelection, signal: AbortSignal) => {
    if (closed || signal.aborted || !selected || selected.endpointId !== value.endpointId
      || selected.selectionGeneration !== value.selectionGeneration) throw new Error('合成输出代际已失效')
    return { endpointId, uid: binding.deviceUid, sampleRate: 44100, channelCount: 2 as const,
      format: 'pcm-s16le' as const, physicalFormat: 'pcm-s16le' as const, bufferFrames: binding.bufferFrames,
      backendId: binding.backendId, backendVersion: binding.backendVersion,
      configurationFingerprintSha256: binding.configurationFingerprintSha256,
      selectionGeneration: selected.selectionGeneration, alive: true as const, hasOutput: true as const }
  }
  return {
    async list(): Promise<RecordingDeviceCandidates> {
      if (closed) throw new Error('合成输出目录已关闭')
      return { candidates: [{ endpointId, label: '隔离测试软件端点（无 HAL）', available: true }],
        selected: current(), blockedReason: null, deviceOpened: false, gateB: 'NOT_RUN', formalReady: false }
    },
    async select(request: SelectRecordingDeviceRequest): Promise<RecordingOutputSelection> {
      if (closed || request.endpointId !== endpointId || Object.keys(request).length !== 1) throw new Error('合成端点无效')
      selected = { endpointId, selectionGeneration: randomUUID() }
      return { ...selected }
    },
    verify,
    async binding(value, signal) { await verify(value, signal); return { ...binding } },
    async observeExactForAdmission(uid, signal) {
      const value = current()
      if (!value || uid !== binding.deviceUid) return null
      try { return verify(value, signal) } catch { return null }
    },
    current,
    revoke() { selected = null },
    close() { selected = null; closed = true },
  }
}

function syntheticGateB(device: RecordingDeviceSelectionBroker, binding: RecordingPlanOutputBinding): GateBAdmissionSource {
  return { async verify(plan: RecordingPlanVersion | null, signal: AbortSignal) {
    const selection = device.current(), format = plan?.profileSnapshot.settings.format
    if (signal.aborted || !plan?.outputBinding || !selection || !format
      || plan.outputBinding.endpointId !== selection.endpointId
      || JSON.stringify(plan.outputBinding) !== JSON.stringify(binding)
      || format.outputBackend.id !== DEVICE_OUTPUT_BACKEND_ID || format.outputBackend.version !== DEVICE_OUTPUT_BACKEND_VERSION) return null
    const observed = await device.verify(selection, signal)
    if (format.sampleRate !== observed.sampleRate || format.channelCount !== observed.channelCount
      || format.outputSampleFormat !== observed.format) return null
    return { recordSha256: 'a'.repeat(64), helperSha256: 'b'.repeat(64),
      configurationFingerprintSha256: binding.configurationFingerprintSha256,
      endpointId, uid: binding.deviceUid, selectionGeneration: selection.selectionGeneration,
      validUntil: new Date(Date.now() + 60_000).toISOString(),
      route: { endpointId, uid: binding.deviceUid, sampleRate: observed.sampleRate,
        channelCount: observed.channelCount, format: observed.format,
        physicalFormat: observed.physicalFormat, bufferFrames: binding.bufferFrames },
      drainAlgorithmId: DEVICE_OUTPUT_DRAIN_ALGORITHM_ID,
      drain: { capacityFrames: 512, tailFrames: 512, minimumZeroCallbacks: 1 } }
  } }
}

function syntheticAttemptProvider(device: RecordingDeviceSelectionBroker, gateB: GateBAdmissionSource, binding: RecordingPlanOutputBinding): RecordingAttemptAdmissionProvider {
  return {
    async authorize({ plan, side, signal }) {
      signal.throwIfAborted()
      if (!plan.outputBinding || JSON.stringify(plan.outputBinding) !== JSON.stringify(binding)
        || !plan.execution.audio.some(item => item.recipe.side === side)
        || !device.current() || !await gateB.verify(plan, signal)) throw new Error('合成计划身份不匹配')
    },
    async start(request) {
      let stopped = false, cutoff = false
      const emit = (type: 'engine-cutoff' | 'stop-ack' | 'cleanup-quiescent') =>
        request.onEvent({ type, side: request.side, runId: request.runId, at: new Date().toISOString() })
      const stop = () => {
        stopped = true
        if (!cutoff) { cutoff = true; emit('engine-cutoff'); emit('stop-ack'); emit('cleanup-quiescent') }
      }
      const running = (async () => {
        let read = 0
        while (read < request.input.audio.frameCount && !stopped && !request.signal.aborted) {
          request.input.checkOperation()
          const chunk = await request.input.consumer.readFrames(read, Math.min(4096, request.input.audio.frameCount - read))
          if (!chunk.frames || !chunk.bytes.length) throw new Error('合成只读输入缺失')
          read += chunk.frames
          request.onEvent({ type: 'progress', side: request.side, runId: request.runId,
            at: new Date().toISOString(), sourceFramesRead: read, submittedFrames: read, consumedFrames: read })
        }
        if (stopped || request.signal.aborted) return
        request.onEvent({ type: 'source-eof', side: request.side, runId: request.runId, at: new Date().toISOString() })
        stop()
        request.onEvent({ type: 'backend-drained', side: request.side, runId: request.runId, at: new Date().toISOString() })
      })()
      void running.catch(() => { if (!stopped && !request.signal.aborted) request.onEvent({ type: 'interrupt',
        side: request.side, runId: request.runId, at: new Date().toISOString(), reason: 'source-read-failed' }) })
      return { async stop() { stop() }, async close() { await running } }
    },
  }
}

interface ParentPortLike { once(event: 'message', listener: (message: { ports?: readonly UtilityPort[] }) => void): unknown }
/** 两个构建入口以静态参数分权；正式Core与生产环境均没有选择器。 */
export function startPrivateTestCore(mode: 'plan-only' | 'full-synthetic'): void {
  const parent = (process as typeof process & { parentPort?: ParentPortLike }).parentPort
  if (process.env.MUSIC_BRIDGE_UI_E2E !== '1' || process.env.MUSIC_BRIDGE_CORE_TEST_MODE !== '1' || !parent) {
    process.exitCode = 1
    return
  }
  parent.once('message', message => {
  void (async () => {
    const port = message.ports?.[0], dataDirectory = process.env.MUSIC_BRIDGE_DATA_DIRECTORY
    if (!port || !dataDirectory || !path.isAbsolute(dataDirectory)) throw new Error('隔离测试工作库缺失')
    const dataset = await openCollectionDataset(dataDirectory)
    try {
      const device = syntheticSelection(fullBinding)
      const gateB = mode === 'full-synthetic' ? syntheticGateB(device, fullBinding) : undefined
      const entryDirectory = path.dirname(fileURLToPath(import.meta.url))
      const converterRoot = bundledConverterRoot(process.env, { platform: process.platform, arch: process.arch,
        entryDirectory, resourcesDirectory: process.resourcesPath })
      const converter = converterRoot && __MUSIC_BRIDGE_FFMPEG_MANIFEST_SHA256__
        ? await loadBundledConverter(converterRoot, __MUSIC_BRIDGE_FFMPEG_MANIFEST_SHA256__) : undefined
      const outputHelper = await loadOutputHelperForCore(process.env, { platform: process.platform,
        arch: process.arch, entryDirectory, resourcesDirectory: process.resourcesPath },
      __MUSIC_BRIDGE_OUTPUT_MANIFEST_SHA256__, loadBundledOutputHelper)
      const runtime = createTestBridgeRuntime({ collectionDatasetIdentity: { datasetId: dataset.datasetId,
        assertCurrent: () => dataset.assertIdentity() }, collectionRepository: dataset.repository,
        backupWorkflowStore: dataset.store, backupPrivateRoot: dataset.privateRoot,
        ...(dataset.contentBinding ? { backupContentBinding: dataset.contentBinding } : {}),
        ...(converter ? { recordingConverter: converter } : {}),
        ...(outputHelper ? { recordingOutputHelper: outputHelper } : {}),
        recordingPlanDeviceSelection: device,
        ...(gateB ? { recordingPlanGateB: gateB,
          recordingAttemptAdmissionProvider: syntheticAttemptProvider(device, gateB, fullBinding) } : {}),
        roonLibrary: createSyntheticRoonLibrary(), authorized: true })
      await attachCoreRuntimePort(port, runtime, { exitAfterShutdown: true, beforeReady: () => dataset.commit() })
    } catch (error) { dataset.fail(); dataset.close(); throw error }
  })().catch(() => { process.exit(1) })
  })
}
