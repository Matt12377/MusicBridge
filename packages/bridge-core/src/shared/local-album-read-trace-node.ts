import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { types } from 'node:util'
import { LOCAL_ALBUM_TRACE_PREFIX, LOCAL_ALBUM_TRACE_CODES, LOCAL_ALBUM_TRACE_NAMES, copyLocalAlbumSafeTrace, emptyLocalAlbumTraceMatches,
  localAlbumSafeTraceCode, type LocalAlbumSafeTrace, type LocalAlbumTraceStage, type LocalAlbumTraceCode, type LocalAlbumTraceName, type LocalAlbumTraceMatch } from './library-read-trace.js'

/** Root可将本小块放到Node-only Client既有叶；不允许Preload/Renderer引Node ALS。 */
export interface LocalAlbumNodeContext {
  readonly traceSha256: string
  readonly parentSha256: string | null
  readonly startedAtMs: number
  readonly preloadAssociated: boolean
  stage: LocalAlbumTraceStage
  first: { stage: LocalAlbumTraceStage; code: LocalAlbumTraceCode; name: LocalAlbumTraceName } | null
  matches: LocalAlbumSafeTrace['matches']
  records: number
}
const storage = new AsyncLocalStorage<LocalAlbumNodeContext>()
// 仅诊断输出策略；不增加wire字段、不参与作者/Scope/Source准入。
const failureOnlyContexts = new WeakSet<LocalAlbumNodeContext>()
export function localAlbumTraceSha(id: string): string { return createHash('sha256').update(id, 'utf8').digest('hex') }
export function captureLocalAlbumContext(): LocalAlbumNodeContext | undefined { return storage.getStore() }
export function runLocalAlbumContext<T>(id: string, parentSha256: string | null, stage: LocalAlbumTraceStage, work: () => T, preloadAssociated = false, emitBegin = true): T {
  if (!emitBegin) return runFailureOnlyLocalAlbumContext(id, parentSha256, stage, work, preloadAssociated)
  const context: LocalAlbumNodeContext = { traceSha256: localAlbumTraceSha(id), parentSha256, startedAtMs: performance.now(), preloadAssociated,
    stage, first: null, matches: emptyLocalAlbumTraceMatches(), records: 0 }
  return storage.run(context, () => { emitLocalAlbumNodeTrace('begin'); return work() })
}
/** 新辅助context只在原失败catch输出；诊断SHA/ALS故障不重做或替换原业务工作。 */
function runFailureOnlyLocalAlbumContext<T>(id: string, parentSha256: string | null, stage: LocalAlbumTraceStage, work: () => T, preloadAssociated: boolean): T {
  let outcome: { ok: true; value: T } | { ok: false; error: unknown } | undefined
  const originalWork = (): T => {
    if (outcome) { if (outcome.ok) return outcome.value; throw outcome.error }
    try { const value = work(); outcome = { ok: true, value }; return value }
    catch (error) { outcome = { ok: false, error }; throw error }
  }
  try {
    const context: LocalAlbumNodeContext = { traceSha256: localAlbumTraceSha(id), parentSha256, startedAtMs: performance.now(), preloadAssociated,
      stage, first: null, matches: emptyLocalAlbumTraceMatches(), records: 0 }
    failureOnlyContexts.add(context)
    return storage.run(context, originalWork)
  } catch {
    // 包括ALS退出自身失败：已有原结果/原throw就原样交还；尚未开始时仅执行一次原work。
    return originalWork()
  }
}
/** 异步回复用原pending项持有本context，回调不依赖EventEmitter继承ALS。 */
export function withLocalAlbumContext<T>(context: LocalAlbumNodeContext | undefined, work: () => T): T { return context ? storage.run(context, work) : work() }
export function localAlbumPhase(stage: LocalAlbumTraceStage): void { const context = storage.getStore(); if (context) context.stage = stage }
export function localAlbumMatch(key: LocalAlbumTraceMatch, match: boolean | null): void { const context = storage.getStore(); if (context) context.matches[key] = match }
function safeOwn(error: unknown, key: 'name' | 'code'): unknown {
  if (!error || typeof error !== 'object' || types.isProxy(error)) return undefined
  try { const value = Object.getOwnPropertyDescriptor(error, key); return value && Object.hasOwn(value, 'value') ? value.value : undefined } catch { return undefined }
}
/** 缺原own data code/name就是UNKNOWN；不读message/stack/constructor，不递归展开failure。 */
export function localAlbumSafeError(error: unknown): { code: LocalAlbumTraceCode; name: LocalAlbumTraceName } {
  const code = safeOwn(error, 'code'), name = safeOwn(error, 'name')
  return { code: LOCAL_ALBUM_TRACE_CODES.includes(code as LocalAlbumTraceCode) ? code as LocalAlbumTraceCode : 'UNKNOWN',
    name: LOCAL_ALBUM_TRACE_NAMES.includes(name as LocalAlbumTraceName) ? name as LocalAlbumTraceName : 'UNKNOWN' }
}
export function localAlbumReject(error: unknown, mappedCode: unknown = null): void {
  const context = storage.getStore(); if (!context) return
  context.first ??= { stage: context.stage, ...localAlbumSafeError(error) }
  emitLocalAlbumNodeTrace('reject', mappedCode)
}
/** 已由原response validator核过的wire code；没有Error.name时保持UNKNOWN。 */
export function localAlbumRejectCode(code: unknown, mappedCode: unknown = null): void {
  const context = storage.getStore(); if (!context) return
  context.first ??= { stage: context.stage, code: localAlbumSafeTraceCode(code), name: 'UNKNOWN' }
  emitLocalAlbumNodeTrace('reject', mappedCode)
}
export function localAlbumTerminal(outcome: LocalAlbumSafeTrace['outcome'], mappedCode: unknown = null): LocalAlbumSafeTrace | null {
  const context = storage.getStore(); if (!context) return null
  return copyLocalAlbumSafeTrace({ version: 1, traceSha256: context.traceSha256, parentSha256: context.parentSha256,
    stage: context.stage, firstStage: context.first?.stage ?? null, code: context.first?.code ?? 'UNKNOWN', name: context.first?.name ?? 'UNKNOWN', mappedCode: mappedCode === null ? null : localAlbumSafeTraceCode(mappedCode),
    elapsedMs: Math.max(0, performance.now() - context.startedAtMs), outcome, matches: { ...context.matches }, preloadAssociated: context.preloadAssociated })
}
export function emitLocalAlbumNodeTrace(outcome: LocalAlbumSafeTrace['outcome'], mappedCode: unknown = null): void {
  try {
    const context = storage.getStore(); if (!context || failureOnlyContexts.has(context) && outcome !== 'reject') return
    if (context.records >= 128 || context.records >= 127 && outcome !== 'reject') { droppedRecords++; return }
    const safe = localAlbumTerminal(outcome, mappedCode); if (!safe) return
    // 每个真实请求只由原已有catch记录首拒绝；不建立计时器或授权缓存。
    context.records++
    const line = LOCAL_ALBUM_TRACE_PREFIX + JSON.stringify(safe) + '\n'
    if (line.length <= 2048) { collectLocalAlbumSafeTrace(safe); console.info(line.trimEnd()) }
  } catch { /* 诊断自己的故障不能改变原Promise、原异常或退出。 */ }
}

const traceRing: LocalAlbumSafeTrace[] = []
const firstRejects = new Map<string, LocalAlbumSafeTrace>()
let droppedRecords = 0
/** 仅证据缓存；不能参与任何Author/SQL/Source/DTO准入。 */
export function collectLocalAlbumSafeTrace(value: unknown): void {
  try {
    const safe = copyLocalAlbumSafeTrace(value); if (!safe) return
    traceRing.push(safe); if (traceRing.length > 256) { traceRing.shift(); droppedRecords++ }
    if (safe.outcome === 'reject' && !firstRejects.has(safe.traceSha256)) {
      if (firstRejects.size >= 64) { firstRejects.delete(firstRejects.keys().next().value!); droppedRecords++ }
      firstRejects.set(safe.traceSha256, safe)
    }
  } catch { /* 不改变原请求。 */ }
}
export function snapshotLocalAlbumReadTrace(): { schema: 'v39.local-album-safe-trace.v1'; records: LocalAlbumSafeTrace[]; firstRejects: LocalAlbumSafeTrace[]; droppedRecords: number } {
  return { schema: 'v39.local-album-safe-trace.v1', records: traceRing.flatMap(value => { const copy = copyLocalAlbumSafeTrace(value); return copy ? [copy] : [] }),
    firstRejects: [...firstRejects.values()].flatMap(value => { const copy = copyLocalAlbumSafeTrace(value); return copy ? [copy] : [] }), droppedRecords }
}
export function localAlbumLink(id: string, stage: LocalAlbumTraceStage): void {
  try {
    const context = storage.getStore(); if (!context) return
    const safe = copyLocalAlbumSafeTrace({ ...localAlbumTerminal('begin'), traceSha256: localAlbumTraceSha(id), parentSha256: context.traceSha256, stage });
    if (safe) { collectLocalAlbumSafeTrace(safe); console.info(LOCAL_ALBUM_TRACE_PREFIX + JSON.stringify(safe)) }
  } catch { /* 因果旁注不改变发送。 */ }
}
