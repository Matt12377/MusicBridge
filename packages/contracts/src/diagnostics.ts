import type { PublicBridgeState } from './state.js'

export const DIAGNOSTIC_SCHEMA_VERSION = 1 as const
export const DIAGNOSTIC_RING_LIMIT = 200 as const

export type DiagnosticComponent = 'main' | 'core'
export type DiagnosticLevel = 'info' | 'warn' | 'error'
export type DiagnosticGateStatus = 'pass' | 'fail' | 'not-run'

export interface DiagnosticTimelineEvent {
  at: string
  component: DiagnosticComponent
  level: DiagnosticLevel
  event: string
  code?: string
  diagnosticId?: string
  state?: string
  durationMs?: number
}

export interface DiagnosticMemorySummary {
  rssBytes: number
  heapUsedBytes: number
  heapTotalBytes: number
  externalBytes: number
}

export interface DiagnosticResourceCounters {
  queueItemCount: number
  activeStreamCount: number
  activePlaybackCount: number
  activeSessionCount: number
  activeTokenCount: number
  listenerCount: number
  timerCount: number
}

export interface DiagnosticLatencySummary {
  startupMs?: number
  lastPlayMs?: number
}

export interface DiagnosticGateResult {
  name: string
  status: DiagnosticGateStatus
}

export interface DiagnosticComponentSnapshot {
  component: DiagnosticComponent
  health: PublicBridgeState
  timeline: readonly DiagnosticTimelineEvent[]
  memory: DiagnosticMemorySummary
  counters: DiagnosticResourceCounters
  latency: DiagnosticLatencySummary
  gates: readonly DiagnosticGateResult[]
}

export interface DiagnosticPlatformInfo {
  platform: string
  arch: string
  appVersion: string
  electronVersion: string
  nodeVersion: string
}

export interface DiagnosticReport {
  schemaVersion: typeof DIAGNOSTIC_SCHEMA_VERSION
  generatedAt: string
  platform: DiagnosticPlatformInfo
  main: DiagnosticComponentSnapshot
  core: DiagnosticComponentSnapshot
  gates: readonly DiagnosticGateResult[]
}

export type DiagnosticRecordInput = Omit<DiagnosticTimelineEvent, 'at'> & {
  at?: string
}

function copyEvent(event: DiagnosticTimelineEvent): DiagnosticTimelineEvent {
  return {
    at: event.at,
    component: event.component,
    level: event.level,
    event: event.event,
    ...(event.code ? { code: event.code } : {}),
    ...(event.diagnosticId ? { diagnosticId: event.diagnosticId } : {}),
    ...(event.state ? { state: event.state } : {}),
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
  }
}

export class DiagnosticRingBuffer {
  private readonly events: DiagnosticTimelineEvent[] = []

  constructor(private readonly limit: number = DIAGNOSTIC_RING_LIMIT) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new RangeError('Diagnostic ring limit is invalid')
    }
  }

  record(input: DiagnosticRecordInput): void {
    const event = copyEvent({
      ...input,
      at: input.at ?? new Date().toISOString(),
    })
    this.events.push(event)
    while (this.events.length > this.limit) this.events.shift()
  }

  snapshot(): readonly DiagnosticTimelineEvent[] {
    return this.events.map(copyEvent)
  }

  clear(): void {
    this.events.length = 0
  }
}

const SECRET_PATTERNS = [
  /(?:NETEASE_COOKIE|MUSIC_U|__csrf)\s*["':=]/i,
  /(?:Cookie|Authorization)\s*:/i,
  /\bBearer\s+\S+/i,
  /"(?:token|credential|cookie|authorization|bearer)"\s*:\s*"[^"\n]+"/i,
  /\btoken\s*[:=]\s*\S+/i,
  /"(?:trackId|zoneId|roonId|account|profile)"\s*:/i,
  /https?:\/\//i,
  /[?&][A-Za-z0-9_-]+=\S*/,
  /(?:\/Users\/|\/home\/|[A-Za-z]:\\)/i,
  /(?:stackTrace|stacktrace)\s*["':=]/i,
]

export function assertDiagnosticExportSafe(serialized: string): void {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(serialized))) {
    throw new Error('Diagnostic export rejected by secret scan')
  }
}

export function buildDiagnosticReport(input: {
  platform: DiagnosticPlatformInfo
  main: DiagnosticComponentSnapshot
  core: DiagnosticComponentSnapshot
  gates?: readonly DiagnosticGateResult[]
  generatedAt?: string
}): DiagnosticReport {
  const report: DiagnosticReport = {
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    platform: { ...input.platform },
    main: {
      ...input.main,
      timeline: input.main.timeline.map(copyEvent),
      gates: input.main.gates.map((gate) => ({ ...gate })),
    },
    core: {
      ...input.core,
      timeline: input.core.timeline.map(copyEvent),
      gates: input.core.gates.map((gate) => ({ ...gate })),
    },
    gates: (input.gates ?? []).map((gate) => ({ ...gate })),
  }
  assertDiagnosticExportSafe(JSON.stringify(report))
  return report
}
