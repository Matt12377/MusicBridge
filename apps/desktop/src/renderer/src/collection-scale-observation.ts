import { nextTick } from 'vue'

declare const __MUSIC_BRIDGE_COLLECTION_SCALE_DIAGNOSTICS__: boolean
const enabled = typeof __MUSIC_BRIDGE_COLLECTION_SCALE_DIAGNOSTICS__ === 'boolean' && __MUSIC_BRIDGE_COLLECTION_SCALE_DIAGNOSTICS__
export const COLLECTION_SCALE_RENDERER_PREFIX = 'RUST015_EVIDENCE '
const operations = new Set(['navigate', 'next', 'previous', 'workload', 'target', 'clear', 'detail-open', 'detail-close', 'policy-open', 'policy-save', 'settings-open', 'settings-close', 'readonly-on', 'readonly-off', 'refresh'])
const workloads = new Set(['all', 'brand-stock', 'literal', 'unicode', 'decade', 'empty'])
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value)
export interface CollectionScaleAction { kind: 'rust015-dom-action'; actionId: string; operation: string; workload?: string; iteration?: number; mode?: 'node' | 'rust' }
export function isCollectionScaleAction(value: unknown): value is CollectionScaleAction {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const record = value as Record<string, unknown>, keys = Reflect.ownKeys(record)
    if (!keys.every(key => typeof key === 'string' && Object.getOwnPropertyDescriptor(record, key)?.enumerable && Object.hasOwn(Object.getOwnPropertyDescriptor(record, key)!, 'value'))) return false
    return keys.every(key => ['kind', 'actionId', 'operation', 'workload', 'iteration', 'mode'].includes(key as string))
    && record.kind === 'rust015-dom-action' && uuid(record.actionId) && typeof record.operation === 'string' && operations.has(record.operation)
    && (record.workload === undefined || typeof record.workload === 'string' && workloads.has(record.workload))
    && (record.iteration === undefined || Number.isSafeInteger(record.iteration) && Number(record.iteration) >= -1 && Number(record.iteration) <= 9)
    && (record.mode === undefined || record.mode === 'node' || record.mode === 'rust')
  } catch { return false }
}
let sequence = 0, observationSequence = 0
const origin = enabled ? performance.now() : 0
let context: { action: CollectionScaleAction; started: number; triggered?: number; triggerSequence?: number; triggerDomEvent?: 'click' | 'input' | 'change' | 'submit' } | undefined
let activation: { target: Element; form: HTMLFormElement | null; actionId: string; started: number } | undefined
const seen = new Set<string>()
let activeReads = 0
const catalogOrdinals = new Map<string, number>()
function emit(event: string, data: Record<string, unknown>): void {
  if (!enabled) return
  try { console.info(COLLECTION_SCALE_RENDERER_PREFIX + JSON.stringify({ schemaVersion: 1, actor: 'renderer', pid: 0, sequence: ++sequence, elapsedMs: performance.now() - origin, event, data })) } catch { /* 观察异常由证据拒绝，不阻断业务。 */ }
}
if (enabled && typeof document !== 'undefined') {
  // 仅接收固定驱动的关联元数据；没有 API、store 调用或能力选择。
  document.addEventListener('musicbridge:collection-scale-action', event => {
    const value = (event as CustomEvent<unknown>).detail
    if (!isCollectionScaleAction(value) || seen.has(value.actionId) || activeReads > 0) { emit('renderer.observationRejected', { reason: 'ACTION_CONTEXT' }); return }
    seen.add(value.actionId); context = { action: { ...value }, started: performance.now() }
    activation = undefined
    emit('renderer.actionContext', { ...value, mechanism: 'fixed-dom', isTrusted: false })
  })
  for (const name of ['click', 'input', 'change', 'submit'] as const) document.addEventListener(name, event => {
    const target = event.target
    if (!(target instanceof Element) || !target.closest('#collection-panel-tapes,#collection-filters,[aria-label="Rust 收藏查询"],#settings-tab-application,[aria-label="实物收藏"],[aria-label="打开设置"]')) return
    // .click() 激活的原 input/change/submit 可以为 trusted；它们仍属于同一同步激活链。
    const linkedActivation = name !== 'click' && activation !== undefined && context?.action.actionId === activation.actionId && performance.now() - activation.started <= 100
      && (target === activation.target || name === 'submit' && target === activation.form)
    if (!context || performance.now() - context.started > 30_000 || event.isTrusted && !linkedActivation) context = { action: { kind: 'rust015-dom-action', actionId: crypto.randomUUID(), operation: 'navigate' }, started: performance.now() }
    if (name === 'click') {
      const own = { target, form: (target as HTMLButtonElement | HTMLInputElement).form ?? target.closest('form'), actionId: context.action.actionId, started: performance.now() }
      activation = own
      // 只关联当前 JS turn；之后的新人工动作不能沿用此前工程动作身份。
      queueMicrotask(() => { if (activation === own) activation = undefined })
    }
    context.triggered = performance.now()
    context.triggerSequence = sequence + 1; context.triggerDomEvent = name
    emit('renderer.trigger', { ...context.action, domEvent: name, isTrusted: event.isTrusted, target: target.tagName, durationMs: performance.now() - context.started })
  }, true)
  emit('renderer.diagnosticsInstalled', { clock: 'renderer.performance.now', paintScope: 'nextTick-and-two-animation-frames' })
}
export interface CollectionScaleReadObservation { observationId: string; action: CollectionScaleAction | null; started: number; generation: number; layer: 'catalog' | 'detail' | 'refresh' | 'control'; request: Record<string, unknown>; triggerSequence: number | null; triggerDomEvent: 'click' | 'input' | 'change' | 'submit' | null; catalogOrdinal: number | null }
export function beginCollectionScaleRead(layer: CollectionScaleReadObservation['layer'], generation: number, request: Record<string, unknown>): CollectionScaleReadObservation | undefined {
  if (!enabled) return undefined
  try {
    const action = context && performance.now() - context.started < 30_000 ? { ...context.action } : null
    const catalogOrdinal = action && layer === 'catalog' ? (catalogOrdinals.get(action.actionId) ?? 0) + 1 : null
    if (catalogOrdinal !== null) catalogOrdinals.set(action!.actionId, catalogOrdinal)
    const value = { observationId: `renderer-${++observationSequence}`, action, started: context?.triggered ?? performance.now(), layer, generation, request: structuredClone(request), triggerSequence: context?.triggerSequence ?? null, triggerDomEvent: context?.triggerDomEvent ?? null, catalogOrdinal }
    if (request.operation !== 'status') activeReads++
    emit('renderer.begin', { ...value, started: undefined, actionId: action?.actionId ?? null, startScope: context?.triggered === undefined ? 'original-load-initiation' : 'original-dom-trigger' })
    return value
  } catch { emit('renderer.observationRejected', { reason: 'BEGIN' }); return undefined }
}
export function observeCollectionScaleInvoke<T>(work: Promise<T>, observation?: CollectionScaleReadObservation): Promise<T> {
  if (!observation) return work
  const started = performance.now()
  void work.then(result => emit('renderer.invokeReply', { ...fields(observation), durationMs: performance.now() - started, result }), () => emit('renderer.invokeRejected', { ...fields(observation), durationMs: performance.now() - started })).catch(() => {})
  return work
}
function fields(value: CollectionScaleReadObservation): Record<string, unknown> { return { observationId: value.observationId, actionId: value.action?.actionId ?? null, ...value.action, layer: value.layer, generation: value.generation, request: value.request, triggerSequence: value.triggerSequence, triggerDomEvent: value.triggerDomEvent, catalogOrdinal: value.catalogOrdinal } }
export function finishCollectionScaleRead(observation: CollectionScaleReadObservation | undefined, accepted: boolean, result?: unknown, stillCurrent: () => boolean = () => true): void {
  if (!observation) return
  if (observation.request.operation !== 'status') activeReads = Math.max(0, activeReads - 1)
  emit(accepted ? 'renderer.commit' : 'renderer.discarded', { ...fields(observation), durationMs: performance.now() - observation.started, ...(accepted ? { result } : {}) })
  if (!accepted) return
  void nextTick().then(() => {
    if (!stillCurrent()) { emit('renderer.discarded', { ...fields(observation), phase: 'nextTick', durationMs: performance.now() - observation.started }); return }
    emit('renderer.nextTick', { ...fields(observation), durationMs: performance.now() - observation.started })
    requestAnimationFrame(() => requestAnimationFrame(() => { if (stillCurrent()) emit('renderer.paint', { ...fields(observation), durationMs: performance.now() - observation.started, scope: 'paint-opportunity-after-latest-commit' }); else emit('renderer.discarded', { ...fields(observation), phase: 'paint', durationMs: performance.now() - observation.started }) }))
  }).catch(() => emit('renderer.observationRejected', { reason: 'PAINT', ...fields(observation) }))
}
