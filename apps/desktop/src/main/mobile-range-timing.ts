import { createHash } from 'node:crypto'
import { types } from 'node:util'

const SCHEMA = 'mb.mobile-range-timing.v1' as const
const stages = ['open', 'initial-authority', 'read', 'before-write-authority', 'write', 'eof-read', 'close-wait', 'actual-close', 'sender-failure', 'http-terminal'] as const
const codes = ['NONE', 'UNKNOWN', 'INVALID_REPLY', 'INVALID_LIMITS', 'ABORTED', 'PEER_CLOSED', 'ESTABLISH_TIMEOUT', 'IDLE_TIMEOUT',
  'TICKET_EXPIRED', 'AUTHORITY_CHECK_FAILED', 'READER_FAILED', 'INVALID_CHUNK', 'EARLY_EOF', 'OVERFLOW', 'WRITE_FAILED',
  'RELEASE_FAILED', 'RELEASE_TIMEOUT', 'BUSY', 'UNAUTHORIZED', 'SOURCE_CHANGED', 'RESOURCE_REVOKED', 'RESOURCE_RELEASED',
  'RESOURCE_BUSY', 'TICKET_INVALID', 'TICKET_REVOKED', 'INVALID_REQUEST'] as const
type Stage = typeof stages[number]
type Quiet = 'not-checked' | 'pending' | 'confirmed' | 'failed'
type Outcome = 'ok' | 'reject' | 'aborted'
export interface MobileRangeTimingRecord {
  stage: Stage; ordinal: number; startMs: number; elapsedMs: number; durationMs: number; bytes: number
  outcome: Outcome; code: typeof codes[number]; quiet: Quiet; role: 'business' | 'cleanup'
}
export interface MobileRangeTimingSnapshot {
  schema: typeof SCHEMA; claimed: boolean; requestSha256: string | null; epochMs: number | null
  httpStatus: number | null; expectedBodyBytes: number | null; records: MobileRangeTimingRecord[]
  firstBusinessFailure: MobileRangeTimingRecord | null; firstCleanupFailure: MobileRangeTimingRecord | null
  droppedRecords: number; clockFault: boolean; terminal: boolean
}
export interface MobileRangeTimingSpan { readonly stage: Stage; readonly ordinal: number }
export interface MobileRangeTimingContext {
  start(stage: Stage, ordinal?: number): MobileRangeTimingSpan | undefined
  end(span: MobileRangeTimingSpan | undefined, result?: { bytes?: number; quiet?: Quiet }): void
  reject(span: MobileRangeTimingSpan | undefined, error: unknown, quiet?: Quiet): void
  reply(status: number, expectedBodyBytes: number): void
  captureFailure(error: unknown, role: 'business' | 'cleanup'): void
  finish(outcome: 'ok' | 'reject', error?: unknown): void
}
export interface MobileRangeTimingProbe {
  claim(input: { requestId: string; method: string; operation: string; range?: string | undefined; ifRange?: string | undefined }): MobileRangeTimingContext | undefined
  snapshot(): MobileRangeTimingSnapshot
}
const integer = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max
const choice = <T extends string>(value: unknown, values: readonly T[]): value is T => typeof value === 'string' && values.includes(value as T)
function closed(raw: unknown, keys: readonly string[]): raw is Record<string, unknown> {
  try {
    if (!raw || typeof raw !== 'object' || types.isProxy(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return false
    const fields = Object.getOwnPropertyDescriptors(raw)
    return Reflect.ownKeys(fields).length === keys.length && keys.every(key => fields[key]?.enumerable === true && Object.hasOwn(fields[key]!, 'value'))
  } catch { return false }
}
function copyRecord(raw: unknown): MobileRangeTimingRecord | null {
  if (!closed(raw, ['stage', 'ordinal', 'startMs', 'elapsedMs', 'durationMs', 'bytes', 'outcome', 'code', 'quiet', 'role'])
    || !choice(raw.stage, stages) || !integer(raw.ordinal, 64) || !integer(raw.startMs) || !integer(raw.elapsedMs)
    || !integer(raw.durationMs) || raw.elapsedMs < raw.startMs || !integer(raw.bytes, 262144)
    || !choice(raw.outcome, ['ok', 'reject', 'aborted']) || !choice(raw.code, codes)
    || !choice(raw.quiet, ['not-checked', 'pending', 'confirmed', 'failed']) || !choice(raw.role, ['business', 'cleanup'])
    || (raw.outcome === 'ok') !== (raw.code === 'NONE')
    || (raw.stage === 'actual-close' || raw.stage === 'close-wait') && raw.role !== 'cleanup'
    || raw.stage !== 'actual-close' && raw.stage !== 'close-wait' && raw.stage !== 'sender-failure' && raw.stage !== 'http-terminal' && raw.role !== 'business') return null
  return { ...raw } as unknown as MobileRangeTimingRecord
}
/** 仅私有导出使用；额外字段、代理、访问器或无界数组整件拒绝。 */
export function copyMobileRangeTimingSnapshot(raw: unknown): MobileRangeTimingSnapshot | null {
  try {
    if (!closed(raw, ['schema', 'claimed', 'requestSha256', 'epochMs', 'httpStatus', 'expectedBodyBytes', 'records', 'firstBusinessFailure',
      'firstCleanupFailure', 'droppedRecords', 'clockFault', 'terminal']) || raw.schema !== SCHEMA || typeof raw.claimed !== 'boolean'
      || raw.requestSha256 !== null && (typeof raw.requestSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(raw.requestSha256))
      || raw.epochMs !== null && !integer(raw.epochMs) || raw.httpStatus !== null && (!integer(raw.httpStatus, 599) || raw.httpStatus < 100)
      || raw.expectedBodyBytes !== null && !integer(raw.expectedBodyBytes) || !integer(raw.droppedRecords)
      || typeof raw.clockFault !== 'boolean' || typeof raw.terminal !== 'boolean'
      || !Array.isArray(raw.records) || types.isProxy(raw.records) || raw.records.length > 40
      || Reflect.ownKeys(raw.records).length !== raw.records.length + 1) return null
    const records: MobileRangeTimingRecord[] = []
    for (let index = 0; index < raw.records.length; index++) {
      const field = Object.getOwnPropertyDescriptor(raw.records, String(index))
      if (!field?.enumerable || !Object.hasOwn(field, 'value')) return null
      const row = copyRecord(field.value); if (!row) return null; records.push(row)
    }
    const firstBusinessFailure = raw.firstBusinessFailure === null ? null : copyRecord(raw.firstBusinessFailure)
    const firstCleanupFailure = raw.firstCleanupFailure === null ? null : copyRecord(raw.firstCleanupFailure)
    if (raw.firstBusinessFailure !== null && (!firstBusinessFailure || firstBusinessFailure.role !== 'business' || firstBusinessFailure.outcome === 'ok')
      || raw.firstCleanupFailure !== null && (!firstCleanupFailure || firstCleanupFailure.role !== 'cleanup' || firstCleanupFailure.outcome === 'ok')) return null
    if (raw.claimed !== (raw.requestSha256 !== null) || !raw.claimed && (records.length > 0 || raw.terminal
      || raw.epochMs !== null || raw.httpStatus !== null || raw.expectedBodyBytes !== null || firstBusinessFailure || firstCleanupFailure)) return null
    return { schema: SCHEMA, claimed: raw.claimed, requestSha256: raw.requestSha256 as string | null, epochMs: raw.epochMs as number | null,
      httpStatus: raw.httpStatus as number | null, expectedBodyBytes: raw.expectedBodyBytes as number | null, records,
      firstBusinessFailure, firstCleanupFailure, droppedRecords: raw.droppedRecords, clockFault: raw.clockFault, terminal: raw.terminal }
  } catch { return null }
}
/** 单进程只领一次；关闭时不读诊断时钟、不建请求上下文，也不介入原业务调用。 */
export function createMobileRangeTimingProbe(options: {
  enabled?: boolean; now?(): number; epochNow?(): number; sink?(record: Readonly<MobileRangeTimingRecord>): void
} = {}): MobileRangeTimingProbe {
  const state: MobileRangeTimingSnapshot = { schema: SCHEMA, claimed: false, requestSha256: null, epochMs: null,
    httpStatus: null, expectedBodyBytes: null, records: [], firstBusinessFailure: null, firstCleanupFailure: null,
    droppedRecords: 0, clockFault: false, terminal: false }
  const now = (): number | undefined => {
    try { const value = (options.now ?? (() => performance.now()))(); if (Number.isFinite(value) && value >= 0) return value } catch { /* 时钟失败只丢诊断。 */ }
    state.clockFault = true; return undefined
  }
  return {
    claim(input) {
      try {
        if (options.enabled !== true || state.claimed || input.method !== 'GET' || input.operation !== 'getMediaAsset' || input.ifRange !== undefined
          || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(input.requestId)) return undefined
        const match = typeof input.range === 'string' && /^bytes=(0|[1-9][0-9]*)-(0|[1-9][0-9]*)$/u.exec(input.range)
        if (!match) return undefined
        const start = Number(match[1]), end = Number(match[2])
        if (!integer(start) || !integer(end) || end < start || end - start + 1 !== 262144) return undefined
        state.claimed = true
        state.requestSha256 = createHash('sha256').update('MusicBridge:mobile-range-timing:1\0' + input.requestId).digest('hex')
        try { const value = (options.epochNow ?? Date.now)(); if (integer(value)) state.epochMs = value; else state.clockFault = true } catch { state.clockFault = true }
        const origin = now(), spans = new WeakMap<MobileRangeTimingSpan, { started: number | undefined; ended: boolean }>()
        let quiet: Quiet = 'not-checked', terminalRole: 'business' | 'cleanup' = 'business'
        const context: MobileRangeTimingContext = {
          start(stage, ordinal = 0) {
            try {
              if (!choice(stage, stages) || !integer(ordinal, 64) || state.terminal && stage !== 'actual-close' && stage !== 'close-wait') return undefined
              const span = Object.freeze({ stage, ordinal }); spans.set(span, { started: now(), ended: false }); return span
            } catch { return undefined }
          },
          end(span, result = {}) { append(span, 'ok', undefined, result.bytes ?? 0, result.quiet ?? 'not-checked') },
          reject(span, error, resultQuiet = 'not-checked') { append(span, 'reject', error, 0, resultQuiet) },
          reply(status, expectedBodyBytes) { try { if (integer(status, 599) && status >= 100 && integer(expectedBodyBytes)) { state.httpStatus = status; state.expectedBodyBytes = expectedBodyBytes } } catch { /* 只读旁注。 */ } },
          captureFailure(error, role) {
            try {
              if (state.terminal || !choice(role, ['business', 'cleanup'])) return
              // 由原异常捕获点指定来源；关闭失败不能改变此前捕获的首业务异常归属。
              terminalRole = role
              append(context.start('sender-failure'), 'reject', error, 0, 'not-checked', role)
            } catch { /* 归属旁注不改变原异常。 */ }
          },
          finish(outcome, error) {
            try { if (state.terminal) return; append(terminal, outcome, error, 0, quiet); state.terminal = true } catch { /* 不改变原HTTP终态。 */ }
          },
        }
        function append(span: MobileRangeTimingSpan | undefined, outcome: Outcome, error: unknown, bytes: number, resultQuiet: Quiet, explicitRole?: 'business' | 'cleanup'): void {
          try {
            if (!span) return
            const owned = spans.get(span); if (!owned || owned.ended) return; owned.ended = true
            const ended = now(), began = owned.started
            if (origin === undefined || began === undefined || ended === undefined || began < origin || ended < began) { state.clockFault = true; state.droppedRecords++; return }
            const role = explicitRole ?? (span.stage === 'actual-close' || span.stage === 'close-wait'
              ? 'cleanup' : span.stage === 'http-terminal' ? terminalRole : 'business')
            let code: unknown
            if (error && typeof error === 'object' && !types.isProxy(error)) {
              const field = Object.getOwnPropertyDescriptor(error, 'code'); if (field && Object.hasOwn(field, 'value')) code = field.value
            }
            const row = copyRecord({ stage: span.stage, ordinal: span.ordinal, startMs: Math.floor(began - origin), elapsedMs: Math.floor(ended - origin),
              durationMs: Math.floor(ended - began), bytes, outcome: code === 'ABORTED' ? 'aborted' : outcome,
              code: outcome === 'ok' ? 'NONE' : choice(code, codes) && code !== 'NONE' ? code : 'UNKNOWN', quiet: resultQuiet, role })
            if (!row) { state.droppedRecords++; return }
            if (span.stage === 'actual-close') quiet = resultQuiet
            const first = outcome !== 'ok' && (role === 'business' ? state.firstBusinessFailure === null : state.firstCleanupFailure === null)
            if (first) { if (role === 'business') state.firstBusinessFailure = row; else state.firstCleanupFailure = row }
            if (state.records.length >= 40 || state.records.length >= 36 && !first && span.stage !== 'http-terminal' && span.stage !== 'actual-close') { state.droppedRecords++; return }
            const frozen = Object.freeze(row); state.records.push(frozen)
            try { options.sink?.(frozen) } catch { /* sink失效不重放业务或替换原异常。 */ }
          } catch { /* 旁注不能影响原请求。 */ }
        }
        const terminal = context.start('http-terminal')
        return context
      } catch { return undefined }
    },
    snapshot() { return { ...state, records: state.records.map(row => ({ ...row })),
      firstBusinessFailure: state.firstBusinessFailure ? { ...state.firstBusinessFailure } : null,
      firstCleanupFailure: state.firstCleanupFailure ? { ...state.firstCleanupFailure } : null } },
  }
}
