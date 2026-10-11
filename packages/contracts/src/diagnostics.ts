import { copyPerformanceTraceSnapshot } from './performance.js'
import type { PublicBridgeState } from './state.js'

export const DIAGNOSTIC_SCHEMA_VERSION = 1 as const
export const DIAGNOSTIC_RING_LIMIT = 200 as const

export type DiagnosticComponent = 'main' | 'core'
export type DiagnosticLevel = 'info' | 'warn' | 'error'
export type DiagnosticGateStatus = 'pass' | 'fail' | 'not-run'
export const ROON_DIAGNOSTIC_EVENTS = ['SessionBegan','SessionEnded','InvalidRequest','Playing','Paused','EndedNaturally','StoppedUser','MediaError','ZoneNotFound','OutputNotFound','Error','ConnectionError','ConnectionLost','Unknown'] as const
export const ROON_DIAGNOSTIC_ERROR_CLASSES = ['missing_required_field','invalid_zone','invalid_icon','unknown_service','unsupported','other','none'] as const
export const ROON_DIAGNOSTIC_GATEWAY_STAGES = ['none','headers','streaming','completed','aborted','error'] as const
export interface RoonDiagnosticStage {
  phase: 'awaiting_session' | 'awaiting_playing'
  eventName?: typeof ROON_DIAGNOSTIC_EVENTS[number]
  elapsedMs: number
  gatewayStage: typeof ROON_DIAGNOSTIC_GATEWAY_STAGES[number]
  errorClass: typeof ROON_DIAGNOSTIC_ERROR_CLASSES[number]
  staleCallback: boolean
}
export interface LocalRoonStartupDiagnostic {
  event: 'roon_begin_session_requested' | 'roon_session_event' | 'roon_session_began' | 'roon_play_requested' | 'roon_play_event' | 'roon_session_timeout' | 'roon_startup_failed'
  stage: RoonDiagnosticStage
}
export function isRoonDiagnosticStage(value: unknown): value is RoonDiagnosticStage {
  if(!value || typeof value!=='object' || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value)))return false
  const v=value as Record<string,unknown>
  const keys=['phase','elapsedMs','gatewayStage','errorClass','staleCallback',...(Object.hasOwn(v,'eventName')?['eventName']:[])]
  return Reflect.ownKeys(v).length===keys.length && Reflect.ownKeys(v).every(k=>typeof k==='string' && keys.includes(k) && Object.getOwnPropertyDescriptor(v,k)?.enumerable===true && Object.hasOwn(Object.getOwnPropertyDescriptor(v,k)!,'value'))
    && (v.phase==='awaiting_session' || v.phase==='awaiting_playing')
    && typeof v.elapsedMs==='number' && Number.isSafeInteger(v.elapsedMs) && v.elapsedMs>=0 && v.elapsedMs<=86400000
    && (ROON_DIAGNOSTIC_GATEWAY_STAGES as readonly unknown[]).includes(v.gatewayStage)
    && (ROON_DIAGNOSTIC_ERROR_CLASSES as readonly unknown[]).includes(v.errorClass) && typeof v.staleCallback==='boolean'
    && (!Object.hasOwn(v,'eventName') || (ROON_DIAGNOSTIC_EVENTS as readonly unknown[]).includes(v.eventName))
}

export interface DiagnosticTimelineEvent {
  at: string
  component: DiagnosticComponent
  level: DiagnosticLevel
  event: string
  code?: string
  diagnosticId?: string
  state?: string
  durationMs?: number
  roonStage?: RoonDiagnosticStage
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
  performance?: import('./performance.js').PerformanceTraceSnapshot
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
  rendererPerformance?: import('./performance.js').PerformanceTraceSnapshot
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
    ...(isRoonDiagnosticStage(event.roonStage) ? { roonStage: { ...event.roonStage } } : {}),
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
  rendererPerformance?: import('./performance.js').PerformanceTraceSnapshot
  platform: DiagnosticPlatformInfo
  main: DiagnosticComponentSnapshot
  core: DiagnosticComponentSnapshot
  gates?: readonly DiagnosticGateResult[]
  generatedAt?: string
}): DiagnosticReport {
  const rendererPerformance = copyPerformanceTraceSnapshot(input.rendererPerformance)
  const { performance: originalMainPerformance, ...main } = input.main
  const { performance: originalCorePerformance, ...core } = input.core
  const mainPerformance = copyPerformanceTraceSnapshot(originalMainPerformance)
  const corePerformance = copyPerformanceTraceSnapshot(originalCorePerformance)
  const report: DiagnosticReport = {
    ...(rendererPerformance ? { rendererPerformance } : {}),
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    platform: { ...input.platform },
    main: {
      ...main,
      ...(mainPerformance ? { performance: mainPerformance } : {}),
      timeline: input.main.timeline.map(copyEvent),
      gates: input.main.gates.map((gate) => ({ ...gate })),
    },
    core: {
      ...core,
      ...(corePerformance ? { performance: corePerformance } : {}),
      timeline: input.core.timeline.map(copyEvent),
      gates: input.core.gates.map((gate) => ({ ...gate })),
    },
    gates: (input.gates ?? []).map((gate) => ({ ...gate })),
  }
  assertDiagnosticExportSafe(JSON.stringify(report))
  return report
}
