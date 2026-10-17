import { types } from 'node:util'
import { captureLocalAlbumContext } from './local-album-read-trace-node.js'
import { copyDesktopArtworkEvent, copyDesktopArtworkSnapshot, DESKTOP_ARTWORK_PREFIX, DESKTOP_ARTWORK_STAGES, desktopArtworkTraceEnabled,
  readDesktopArtworkLine, type DesktopArtworkEvent, type DesktopArtworkMetrics, type DesktopArtworkSnapshot, type DesktopArtworkStage } from './desktop-artwork-trace.js'
export { desktopArtworkStarted, desktopArtworkElapsed, desktopArtworkKey } from './desktop-artwork-trace.js'

/** 单独的有限数字观察，不改变原 trace 的256环/64首拒预算。 */
export function createDesktopArtworkCollector(enabled: boolean) {
  const records: DesktopArtworkEvent[] = [], totals = Object.fromEntries(DESKTOP_ARTWORK_STAGES.map(stage => [stage, 0])) as Record<DesktopArtworkStage, number>
  let droppedRecords = 0, totalsComplete = true
  function collect(value: unknown): void {
    if (!enabled || !safeData(value)) return
    try {
      const safe = copyDesktopArtworkEvent(value); if (!safe) return
      if (safe.stage === 'observer-truncated') { droppedRecords = Math.min(Number.MAX_SAFE_INTEGER, droppedRecords + 1); totalsComplete = false }
      totals[safe.stage] = Math.min(Number.MAX_SAFE_INTEGER, totals[safe.stage] + safe.count)
      records.push(safe)
      if (records.length > 512) { records.shift(); droppedRecords = Math.min(Number.MAX_SAFE_INTEGER, droppedRecords + 1) }
    } catch { /* 收集失败不能影响原业务。 */ }
  }
  return { collect, snapshot(): DesktopArtworkSnapshot { return { schema: 'desktop-artwork.v1', records: records.map(row => ({ ...row })), totals: { ...totals }, droppedRecords, truncated: droppedRecords > 0, totalsComplete } } }
}
function safeData(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== 'object') return true
  if (depth > 5 || types.isProxy(value)) return false
  try {
    if (![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value))) return false
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors)
    if (keys.length > 514) return false
    return keys.every(key => { const item = descriptors[key as string]; return !!item && Object.hasOwn(item, 'value') && safeData(item.value, depth + 1) })
  } catch { return false }
}
export function copyDesktopArtworkEvidence(value: unknown): DesktopArtworkSnapshot | null { return safeData(value) ? copyDesktopArtworkSnapshot(value) : null }
const collector = createDesktopArtworkCollector(desktopArtworkTraceEnabled)
export const collectDesktopArtwork = collector.collect
export const snapshotDesktopArtwork = collector.snapshot
const emissions = new Map<string, number>()
let emitted = 0, truncated = false
export function noteDesktopArtwork(stage: DesktopArtworkStage, keySha256: string | null = null, metrics: DesktopArtworkMetrics = {}, origin: 'main' | 'core' = 'core'): void {
  if (!desktopArtworkTraceEnabled) return
  try {
    const safe = copyDesktopArtworkEvent({ version: 1, origin, stage, keySha256, requestSha256: captureLocalAlbumContext()?.traceSha256 ?? null,
      atMs: Date.now(), elapsedMs: 0, bytes: 0, decodedBytes: 0, count: 1, reason: 'none', code: 'UNKNOWN', ...metrics })
    if (!safe || truncated) return
    const key = `${safe.requestSha256 ?? keySha256 ?? 'none'}:${stage}`, prior = emissions.get(key) ?? 0
    if (emitted >= 8192 || prior >= 8 && (safe.requestSha256 !== null || keySha256 !== null) || !emissions.has(key) && emissions.size >= 2048) {
      truncated = true
      const end: DesktopArtworkEvent = { ...safe, stage: 'observer-truncated', reason: 'capacity', count: 1 }
      collector.collect(end); console.info(DESKTOP_ARTWORK_PREFIX + JSON.stringify(end)); return
    }
    emissions.set(key, prior + 1); emitted++
    collector.collect(safe); console.info(DESKTOP_ARTWORK_PREFIX + JSON.stringify(safe))
  } catch { /* 计时/编码/sink自己的异常不改变原返回或throw。 */ }
}
export function createDesktopArtworkReader(consume: (value: DesktopArtworkEvent) => void): (chunk: string) => void {
  let pending = '', discard = false
  return chunk => {
    if (!desktopArtworkTraceEnabled) return
    // 每行最多1536；超界行丢弃到换行，不能从尾部伪造新记录。
    for (const part of chunk.split(/(?<=\n)/u)) {
      if (!discard) pending += part
      if (pending.length > 1536) { discard = true; pending = '' }
      if (!part.endsWith('\n')) continue
      if (!discard) { const safe = readDesktopArtworkLine(pending.trimEnd()); if (safe) { try { consume(safe) } catch { /* 旁注失败不影响stdout消费。 */ } } }
      pending = ''; discard = false
    }
  }
}
