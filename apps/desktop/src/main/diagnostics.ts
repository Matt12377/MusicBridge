import { randomUUID } from 'node:crypto'
import { chmod, rename, unlink, writeFile } from 'node:fs/promises'

import {
  assertDiagnosticExportSafe,
  buildDiagnosticReport,
  DIAGNOSTIC_RING_LIMIT,
  DiagnosticRingBuffer,
  type DiagnosticComponentSnapshot,
  type DiagnosticPlatformInfo,
  type DiagnosticReport,
  type PublicBridgeState,
  type TypedIpcEvent,
} from '@music-bridge/contracts'

const DEFAULT_HEALTH: PublicBridgeState = {
  runtime: 'starting',
  roon: 'disconnected',
  provider: 'missing',
  activeStreamCount: 0,
  activePlaybackPresent: false,
}

const PLAYBACK_STARTUP_EVENT_RESERVE = 32

export class MainDiagnosticRecorder {
  private readonly buffer: DiagnosticRingBuffer
  private readonly playbackStartupBuffer: DiagnosticRingBuffer
  private readonly limit: number
  private health: PublicBridgeState = DEFAULT_HEALTH

  constructor(limit: number = DIAGNOSTIC_RING_LIMIT) {
    this.limit = limit
    this.buffer = new DiagnosticRingBuffer(limit)
    this.playbackStartupBuffer = new DiagnosticRingBuffer(
      Math.min(limit, PLAYBACK_STARTUP_EVENT_RESERVE),
    )
  }

  recordCoreEvent(event: TypedIpcEvent): void {
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
    this.buffer.record({ component: 'main', level, event, ...fields })
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

export interface DiagnosticReportWriteInput {
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
  const serialized = `${JSON.stringify(report, null, 2)}\n`
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
