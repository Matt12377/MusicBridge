import { copyMobileRangeWindowSnapshot, type MobileRangeWindowSnapshot } from '../../../../packages/bridge-core/src/mobile/range-window-observer.js'
import { randomUUID } from 'node:crypto'
import { writeSync } from 'node:fs'
import { chmod, rename, unlink, writeFile } from 'node:fs/promises'
import { types as nodeTypes } from 'node:util'

import {
  assertDiagnosticExportSafe,
  buildDiagnosticReport,
  DIAGNOSTIC_RING_LIMIT,
  DiagnosticRingBuffer,
  PerformanceTraceRecorder,
  type DiagnosticComponentSnapshot,
  type DiagnosticPlatformInfo,
  type DiagnosticReport,
  type PublicBridgeState,
  type TypedIpcEvent,
} from '@music-bridge/contracts'

import { copyDesktopArtworkEvidence } from '../../../../packages/bridge-core/src/shared/desktop-artwork-trace-node.js'
import type { DesktopArtworkSnapshot } from '../../../../packages/bridge-core/src/shared/desktop-artwork-trace.js'
import { copyLocalAlbumReadTraceSnapshot, type LocalAlbumReadTraceSnapshot } from '../shared/library-read-trace.js'
import { copyLocalPlaybackEvidence, type LocalPlaybackEvidenceRecord } from './local-playback-evidence.js'
import { copyMobileCapabilityTraceSnapshot, copyMobilePreparationSnapshot, type MobileCapabilityTraceSnapshot, type MobilePreparationSnapshot } from '../../../../packages/bridge-core/src/mobile/capability-trace.js'
import { copyMobileRangeTimingSnapshot, type MobileRangeTimingSnapshot } from './mobile-range-timing.js'

const DEFAULT_HEALTH: PublicBridgeState = {
  runtime: 'starting',
  roon: 'disconnected',
  provider: 'missing',
  activeStreamCount: 0,
  activePlaybackPresent: false,
}

const PLAYBACK_STARTUP_EVENT_RESERVE = 32
const SHUTDOWN_STAGE_PREFIX = 'MUSICBRIDGE_SHUTDOWN_STAGE '
// 闭集26个phase及其清理错误共用单行；4KiB足够，超界整条丢弃而不截断JSON。
const SHUTDOWN_STAGE_MAX_BYTES = 4 * 1024
const SHUTDOWN_EVENTS = ['local_workbench_shutdown_phase_start', 'local_workbench_shutdown_phase_settled',
  'local_workbench_shutdown_failure', 'local_workbench_shutdown_cleanup_failure', 'local_workbench_shutdown_not_verified'] as const
const SHUTDOWN_PHASES = ['stop_display', 'seal_artwork_ipc', 'seal_source_writes_ipc', 'seal_relocation_ipc', 'remote_stop', 'mobile_close',
  'prepare_name', 'prepare_lyrics', 'prepare_reads', 'prepare_normalizer', 'owner_shutdown', 'join_name', 'join_lyrics_grant',
  'join_lyrics_provider', 'join_directory', 'join_readers', 'revoke_author', 'close_management', 'close_legacy', 'close_assembly',
  'close_lyrics_main', 'close_lyrics_provider', 'close_name', 'core_shutdown_complete', 'close_outbox', 'flush_core_evidence'] as const
const SHUTDOWN_CODES = ['NOT_READY', 'OUTBOX_SCOPE_MISMATCH', 'TIMEOUT', 'INVALID_IPC_RESPONSE', 'INTERNAL_ERROR', 'CHANGED', 'CLOSED', 'UNKNOWN'] as const
type ShutdownEvent = typeof SHUTDOWN_EVENTS[number]
type ShutdownPhase = typeof SHUTDOWN_PHASES[number]
type ShutdownCode = typeof SHUTDOWN_CODES[number]
type ShutdownFailure = Readonly<{ phase: ShutdownPhase; code: ShutdownCode }>
/** 仅Main内部测试注入；不接收Renderer或Core配置。 */
interface ShutdownStageTraceOptions { sink?(line: string): void; now?(): number; utcNow?(): number; stdoutFd?: number }

/** 元数据也只读自有data属性；未知字段、Proxy和accessor不能进入日志或触发getter。 */
function lifecycleFields(value: unknown): { code?: string; state?: string } | null {
  try {
    if (!value || typeof value !== 'object' || nodeTypes.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null
    const copy: { code?: string; state?: string } = {}
    for (const key of Reflect.ownKeys(value)) {
      if (key !== 'code' && key !== 'state') return null
      const field = Object.getOwnPropertyDescriptor(value, key)
      if (!field?.enumerable || !Object.hasOwn(field, 'value') || typeof field.value !== 'string') return null
      copy[key] = field.value
    }
    return copy
  } catch { return null }
}

export class MainDiagnosticRecorder {
  readonly performance = new PerformanceTraceRecorder({ component: 'main', enabled: process.env.MUSIC_BRIDGE_PERFORMANCE_TRACE === '1' })
  private readonly buffer: DiagnosticRingBuffer
  private readonly playbackStartupBuffer: DiagnosticRingBuffer
  private readonly limit: number
  private health: PublicBridgeState = DEFAULT_HEALTH
  private readonly shutdownTrace: Required<Omit<ShutdownStageTraceOptions, 'stdoutFd'>>
  private readonly shutdownPhaseStarts = new Map<ShutdownPhase, number>()
  private readonly shutdownStates = new Map<ShutdownPhase, 'pending' | 'completed' | 'failed'>()
  private readonly shutdownCleanupFailures = new Map<ShutdownPhase, ShutdownCode>()
  private shutdownFirstFailure: ShutdownFailure | undefined
  private shutdownStartedAt: number | undefined

  constructor(limit: number = DIAGNOSTIC_RING_LIMIT, shutdownTrace: ShutdownStageTraceOptions = {}) {
    this.limit = limit
    this.buffer = new DiagnosticRingBuffer(limit)
    this.playbackStartupBuffer = new DiagnosticRingBuffer(
      Math.min(limit, PLAYBACK_STARTUP_EVENT_RESERVE),
    )
    const stdoutFd = shutdownTrace.stdoutFd ?? 1
    // 同步OS写错由recordShutdownStage捕获，不经stdout异步error事件；不重写、不fsync。
    this.shutdownTrace = { sink: shutdownTrace.sink ?? (line => { writeSync(stdoutFd, line) }),
      now: shutdownTrace.now ?? (() => performance.now()), utcNow: shutdownTrace.utcNow ?? (() => Date.now()) }
  }

  recordCoreEvent(event: TypedIpcEvent): void {
    this.performance.increment('eventCount')
    if (
      event.event === 'core.ready' ||
      event.event === 'core.health' ||
      event.event === 'roon.changed'
    ) {
      this.health = { ...event.payload.state }
    }
    const state =
      event.event === 'core.ready' ||
      event.event === 'core.health' ||
      event.event === 'roon.changed'
        ? event.payload.state.runtime
        : undefined
    this.buffer.record({
      component: 'main',
      level: 'info',
      event: event.event,
      ...(state ? { state } : {}),
    })
  }

  recordLifecycle(
    event: string,
    level: 'info' | 'warn' | 'error' = 'info',
    fields: { code?: string; state?: string } = {},
  ): void {
    if (typeof event !== 'string' || !['info', 'warn', 'error'].includes(level)) return
    const captured = lifecycleFields(fields)
    if (!captured) return
    const shutdown = (SHUTDOWN_EVENTS as readonly string[]).includes(event)
    if (event.startsWith('local_workbench_shutdown_') && !shutdown) return
    if (shutdown) {
      const phaseEvent = event !== 'local_workbench_shutdown_not_verified'
      const failure = event !== 'local_workbench_shutdown_phase_start' && event !== 'local_workbench_shutdown_phase_settled'
      if (level !== (failure ? 'error' : 'info') || Object.keys(captured).length !== (phaseEvent && failure ? 2 : 1)
        || phaseEvent && !(SHUTDOWN_PHASES as readonly unknown[]).includes(captured.state)
        || !phaseEvent && Object.hasOwn(captured, 'state')
        || failure && !(SHUTDOWN_CODES as readonly unknown[]).includes(captured.code)
        || !failure && Object.hasOwn(captured, 'code')) return
    }
    this.buffer.record({ component: 'main', level, event, ...captured })
    if (shutdown) this.recordShutdownStage(event as ShutdownEvent, captured)
  }

  /** 私有wrapper旁注；只记录原回调观察，不查询Core、不授关闭成功，也不增加timer。 */
  private recordShutdownStage(event: ShutdownEvent, fields: { code?: string; state?: string }): void {
    try {
      const now = this.shutdownTrace.now(), utc = this.shutdownTrace.utcNow()
      if (!Number.isFinite(now) || now < 0 || now > Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(utc) || utc < 0) return
      const at = new Date(utc).toISOString()
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(at)) return
      this.shutdownStartedAt ??= now
      const phase = fields.state as ShutdownPhase | undefined, code = fields.code as ShutdownCode | undefined
      const status = event === 'local_workbench_shutdown_phase_start' ? 'pending' : event === 'local_workbench_shutdown_phase_settled' ? 'completed' : 'failed'
      if (phase) {
        if (status === 'pending') this.shutdownPhaseStarts.set(phase, now)
        // Main catch会重报历史首错；它不能覆盖该phase重试后真正取得的成功收据。
        if (event !== 'local_workbench_shutdown_failure' || !this.shutdownFirstFailure) this.shutdownStates.set(phase, status)
        if (event === 'local_workbench_shutdown_failure') this.shutdownFirstFailure ??= Object.freeze({ phase, code: code! })
        if (event === 'local_workbench_shutdown_cleanup_failure' && !this.shutdownCleanupFailures.has(phase)) this.shutdownCleanupFailures.set(phase, code!)
      }
      const started = phase ? this.shutdownPhaseStarts.get(phase) : this.shutdownStartedAt
      const elapsedMs = started === undefined || now < started ? null : Math.floor(now - started)
      const row = { schema: 'musicbridge.shutdown-stage.v1', component: 'main', at, event, phase: phase ?? null, status, elapsedMs,
        code: code ?? null, failureKind: event === 'local_workbench_shutdown_failure' ? 'first' : event === 'local_workbench_shutdown_cleanup_failure' ? 'cleanup' : null,
        pending: SHUTDOWN_PHASES.filter(phase => this.shutdownStates.get(phase) === 'pending'),
        completed: SHUTDOWN_PHASES.filter(phase => this.shutdownStates.get(phase) === 'completed'),
        failed: SHUTDOWN_PHASES.filter(phase => this.shutdownStates.get(phase) === 'failed'),
        firstFailure: this.shutdownFirstFailure ?? null,
        cleanupFailures: [...this.shutdownCleanupFailures].map(([phase, code]) => ({ phase, code })) }
      const line = SHUTDOWN_STAGE_PREFIX + JSON.stringify(row) + '\n'
      if (Buffer.byteLength(line, 'utf8') > SHUTDOWN_STAGE_MAX_BYTES) return
      this.shutdownTrace.sink(line)
    } catch { /* sink/clock失败不得改变原退出、收口Promise或公开诊断合同。 */ }
  }

  recordPlaybackStartup(rendererClickAtMs: number, mainReceivedAtMs = Date.now()): void {
    const receivedAtMs = Math.max(rendererClickAtMs, mainReceivedAtMs)
    this.playbackStartupBuffer.record({
      at: new Date(rendererClickAtMs).toISOString(),
      component: 'main',
      level: 'info',
      event: 'playback_renderer_click',
      durationMs: 0,
    })
    this.playbackStartupBuffer.record({
      at: new Date(receivedAtMs).toISOString(),
      component: 'main',
      level: 'info',
      event: 'playback_main_ipc_received',
      durationMs: receivedAtMs - rendererClickAtMs,
    })
  }

  snapshot(health: PublicBridgeState = this.health): DiagnosticComponentSnapshot {
    const playbackStartupTimeline = this.playbackStartupBuffer.snapshot()
    const generalLimit = Math.max(0, this.limit - playbackStartupTimeline.length)
    const generalTimeline =
      generalLimit === 0 ? [] : this.buffer.snapshot().slice(-generalLimit)
    const timeline = [...generalTimeline, ...playbackStartupTimeline].sort((left, right) =>
      left.at.localeCompare(right.at),
    )

    return {
      ...(this.performance.isEnabled() ? { performance: this.performance.snapshot() } : {}),
      component: 'main',
      health: { ...health },
      timeline,
      memory: {
        rssBytes: process.memoryUsage().rss,
        heapUsedBytes: process.memoryUsage().heapUsed,
        heapTotalBytes: process.memoryUsage().heapTotal,
        externalBytes: process.memoryUsage().external,
      },
      counters: {
        queueItemCount: 0,
        activeStreamCount: health.activeStreamCount,
        activePlaybackCount: health.activePlaybackPresent ? 1 : 0,
        activeSessionCount: 0,
        activeTokenCount: 0,
        listenerCount: 0,
        timerCount: 0,
      },
      latency: {},
      gates: [
        { name: 'main-startup', status: health.runtime === 'ready' ? 'pass' : 'not-run' },
        { name: 'renderer-cleanup', status: 'not-run' },
        { name: 'secret-scan', status: 'not-run' },
      ],
    }
  }
}

export interface PrivateDiagnosticEvidence {
  version: 1
  localAlbum: LocalAlbumReadTraceSnapshot
  desktopArtwork?: DesktopArtworkSnapshot
  localPlayback: readonly LocalPlaybackEvidenceRecord[]
  mobileCapability?: MobileCapabilityTraceSnapshot
  mobileRangeTiming?: MobileRangeTimingSnapshot
  mobileRangeWindow?: MobileRangeWindowSnapshot
  mobilePreparation?: MobilePreparationSnapshot
}

export interface DiagnosticReportWriteInput {
  privateEvidence?: PrivateDiagnosticEvidence
  rendererPerformance?: NonNullable<DiagnosticReport['rendererPerformance']>
  platform: DiagnosticPlatformInfo
  main: DiagnosticComponentSnapshot
  core: DiagnosticComponentSnapshot
  gates?: DiagnosticReport['gates']
}

export async function writeDiagnosticReport(
  outputPath: string,
  input: DiagnosticReportWriteInput,
): Promise<void> {
  const report = buildDiagnosticReport(input)
  let privateEvidence: PrivateDiagnosticEvidence | undefined
  if (input.privateEvidence) {
    const localAlbum = copyLocalAlbumReadTraceSnapshot(input.privateEvidence.localAlbum)
    const desktopArtwork = input.privateEvidence.desktopArtwork === undefined ? undefined : copyDesktopArtworkEvidence(input.privateEvidence.desktopArtwork)
    const localPlayback = input.privateEvidence.localPlayback.map(copyLocalPlaybackEvidence)
    const mobileCapability = input.privateEvidence.mobileCapability === undefined ? undefined : copyMobileCapabilityTraceSnapshot(input.privateEvidence.mobileCapability)
    const mobileRangeTiming = input.privateEvidence.mobileRangeTiming === undefined ? undefined : copyMobileRangeTimingSnapshot(input.privateEvidence.mobileRangeTiming)
    const mobileRangeWindow = input.privateEvidence.mobileRangeWindow === undefined ? undefined : copyMobileRangeWindowSnapshot(input.privateEvidence.mobileRangeWindow)
    const mobilePreparation = input.privateEvidence.mobilePreparation === undefined ? undefined : copyMobilePreparationSnapshot(input.privateEvidence.mobilePreparation)
    if (input.privateEvidence.version !== 1 || !localAlbum || localPlayback.length > 256 || localPlayback.some(row => row === null) || mobileCapability === null || mobileRangeTiming === null || mobileRangeWindow === null || mobilePreparation === null || desktopArtwork === null) {
      throw new Error('私有诊断记录未通过安全闭集核验。')
    }
    privateEvidence = { version: 1, ...(desktopArtwork ? { desktopArtwork } : {}), localAlbum, localPlayback: localPlayback as LocalPlaybackEvidenceRecord[], ...(mobileCapability ? { mobileCapability } : {}), ...(mobileRangeTiming ? { mobileRangeTiming } : {}), ...(mobileRangeWindow ? { mobileRangeWindow } : {}), ...(mobilePreparation ? { mobilePreparation } : {}) }
  }
  // 私有文件补充证据保留原公开导出回复，仍经过全件secret-scan及0600原子写入。
  const serialized = `${JSON.stringify(privateEvidence ? { ...report, privateEvidence } : report, null, 2)}\n`
  assertDiagnosticExportSafe(serialized)
  const temporaryPath = `${outputPath}.tmp-${randomUUID()}`
  try {
    await writeFile(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600 })
    await chmod(temporaryPath, 0o600)
    await rename(temporaryPath, outputPath)
  } finally {
    await unlink(temporaryPath).catch(() => undefined)
  }
}
