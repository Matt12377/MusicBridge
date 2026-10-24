import { desktopArtworkKey, desktopArtworkStarted, desktopArtworkElapsed, emitRendererArtwork } from '../../../../../../../../packages/bridge-core/src/shared/desktop-artwork-trace.js'

export const GRID_ARTWORK_COMPRESSED_BYTES = 8 * 1024 * 1024
export const GRID_ARTWORK_DECODED_BYTES = 24 * 1024 * 1024
export const GRID_ARTWORK_ENTRIES = 128
const ALGORITHM = 'grid-jpeg-1', MAX_THUMB_BYTES = 256 * 1024
export interface GridArtworkSource {
  identity: string
  dataUrl: string
  display: { sha256: string; width: number; height: number; bytes: number }
  visible: boolean
}
interface Thumbnail { blob: Blob; width: number; height: number }
interface Candidate { source: GridArtworkSource; key: string; dimension: number }
interface Job extends Candidate { abort: AbortController }
export type GridArtworkView = { status: 'ready'; dataUrl: string } | { status: 'loading' | 'error'; dataUrl: null }
function geometry(source: GridArtworkSource, dimension: number): { width: number; height: number } {
  const scale = Math.min(1, dimension / Math.max(source.display.width, source.display.height))
  return { width: Math.max(1, Math.round(source.display.width * scale)), height: Math.max(1, Math.round(source.display.height * scale)) }
}
function cancelled(signal: AbortSignal): void { if (signal.aborted) throw new Error('网格缩略图已离开当前窗口。') }

/** 只解码Owner已验证的1200显示副本；不读来源、IPC或磁盘，不改详情和选图身份。 */
export async function createBrowserGridThumbnail(source: GridArtworkSource, dimension: number, signal: AbortSignal): Promise<Thumbnail> {
  cancelled(signal)
  const encoded = source.dataUrl.slice('data:image/jpeg;base64,'.length), binary = atob(encoded)
  if (binary.length !== source.display.bytes || binary.length > 1024 * 1024) throw new Error('网格图像副本大小无效。')
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0)), size = geometry(source, dimension)
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }), { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'high' })
  try {
    cancelled(signal)
    if (bitmap.width !== size.width || bitmap.height !== size.height) throw new Error('网格图像尺寸无效。')
    const canvas = new OffscreenCanvas(size.width, size.height), context = canvas.getContext('2d')
    if (!context) throw new Error('网格图像绘制服务不可用。')
    context.drawImage(bitmap, 0, 0)
    try {
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 }); cancelled(signal)
      return { blob, ...size }
    } finally { canvas.width = 1; canvas.height = 1 }
  } finally { bitmap.close() }
}

/** 压缩Blob LRU与当前窗口的解码引用分别限额；实际浏览器/GPU回收时刻不冒充硬内存测量。 */
export function createGridArtworkCache(options: {
  onChange?(): void
  make?: typeof createBrowserGridThumbnail
  createUrl?(blob: Blob): string
  revokeUrl?(url: string): void
  compressedBytes?: number
  decodedBytes?: number
  entries?: number
} = {}) {
  const bounded = (value: number | undefined, fallback: number) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= fallback ? value : fallback
  const maxBytes = bounded(options.compressedBytes, GRID_ARTWORK_COMPRESSED_BYTES), maxDecoded = bounded(options.decodedBytes, GRID_ARTWORK_DECODED_BYTES)
  const maxEntries = bounded(options.entries, GRID_ARTWORK_ENTRIES), make = options.make ?? createBrowserGridThumbnail
  const createUrl = options.createUrl ?? (blob => URL.createObjectURL(blob)), revokeUrl = options.revokeUrl ?? (url => URL.revokeObjectURL(url))
  const cache = new Map<string, Thumbnail>(), desired = new Map<string, Candidate>(), queue = new Map<string, Candidate>(), failed = new Set<string>()
  const leases = new Map<string, { key: string; url: string; decoded: number }>(), active = new Map<string, Job>()
  let bytes = 0, decoded = 0, windowDecodedBudget = maxDecoded, disposed = false
  const notify = (): void => { if (!disposed) options.onChange?.() }
  function release(identity: string): void {
    const lease = leases.get(identity); if (!lease) return
    leases.delete(identity); decoded -= lease.decoded
    try { revokeUrl(lease.url) } catch { /* 原URL引用已撤销；不再次保留离窗图。 */ }
  }
  function trim(): void {
    for (const [key, item] of cache) {
      if (bytes <= maxBytes && cache.size <= maxEntries) break
      if ([...leases.values()].some(lease => lease.key === key)) continue
      cache.delete(key); bytes -= item.blob.size
      emitRendererArtwork('grid-skip', desktopArtworkKey(key), { reason: 'evicted', bytes: item.blob.size })
    }
  }
  function bind(): void {
    // 可见项总在近邻之前；先释放全部旧引用再绑定，近邻不能挤占新可见项的预算。
    for (const [identity, lease] of leases) if (desired.get(identity)?.key !== lease.key) release(identity)
    // 与持久grid共用一份窗口预算；预算缩小时先保可见，再保较早绑定的引用。
    for (const identity of [...leases.keys()].reverse()) if (decoded > windowDecodedBudget && !desired.get(identity)?.source.visible) release(identity)
    for (const identity of [...leases.keys()].reverse()) if (decoded > windowDecodedBudget) release(identity)
    let needed = 0
    for (const candidate of desired.values()) if (candidate.source.visible && !leases.has(candidate.source.identity)) { const item = cache.get(candidate.key); if (item) needed += item.width * item.height * 4 }
    for (const [identity] of leases) if (decoded + needed > windowDecodedBudget && !desired.get(identity)?.source.visible) release(identity)
    for (const candidate of desired.values()) {
      if (leases.has(candidate.source.identity)) continue
      const thumbnail = cache.get(candidate.key); if (!thumbnail) continue
      const weight = thumbnail.width * thumbnail.height * 4
      if (decoded + weight > windowDecodedBudget) continue
      try { const url = createUrl(thumbnail.blob); leases.set(candidate.source.identity, { key: candidate.key, url, decoded: weight }); decoded += weight }
      catch { failed.add(candidate.key) }
    }
  }
  function pump(): void {
    if (disposed || active.size || !queue.size) return
    const visible = new Set([...desired.values()].filter(value => value.source.visible).map(value => value.key))
    const candidate = [...queue.values()].find(value => visible.has(value.key)) ?? queue.values().next().value
    if (!candidate) return
    queue.delete(candidate.key)
    const job: Job = { ...candidate, abort: new AbortController() }, started = desktopArtworkStarted()
    active.set(job.key, job)
    emitRendererArtwork('grid-create', desktopArtworkKey(job.source.identity))
    void (async () => {
      try {
        const thumbnail = await make(job.source, job.dimension, job.abort.signal)
        if (disposed || job.abort.signal.aborted || ![...desired.values()].some(value => value.key === job.key)) return
        const size = geometry(job.source, job.dimension)
        if (!(thumbnail.blob instanceof Blob) || thumbnail.blob.type !== 'image/jpeg' || !thumbnail.blob.size || thumbnail.blob.size > MAX_THUMB_BYTES
          || thumbnail.blob.size > maxBytes || thumbnail.width !== size.width || thumbnail.height !== size.height) throw new Error('网格缩略图超过展示预算。')
        const previous = cache.get(job.key); if (previous) bytes -= previous.blob.size
        cache.delete(job.key); cache.set(job.key, thumbnail); bytes += thumbnail.blob.size; trim(); if (!cache.has(job.key)) failed.add(job.key); bind()
        emitRendererArtwork('grid-create', desktopArtworkKey(job.source.identity), { count: 0, elapsedMs: desktopArtworkElapsed(started), bytes: thumbnail.blob.size, decodedBytes: decoded })
      } catch {
        if (!disposed && !job.abort.signal.aborted && [...desired.values()].some(value => value.key === job.key)) {
          failed.add(job.key); emitRendererArtwork('grid-skip', desktopArtworkKey(job.source.identity), { reason: 'error', elapsedMs: desktopArtworkElapsed(started) })
        }
      } finally {
        active.delete(job.key); notify(); pump()
      }
    })()
  }
  function setWindow(sources: readonly GridArtworkSource[], requestedDimension = 512, visibleSlots = sources.filter(source => source.visible).length, remainingDecodedBytes = maxDecoded): void {
    if (disposed) return
    const old = new Map(desired), ordered = sources.slice(0, maxEntries).sort((left, right) => Number(right.visible) - Number(left.visible))
    windowDecodedBudget = Number.isSafeInteger(remainingDecodedBytes) && remainingDecodedBytes >= 0 && remainingDecodedBytes <= maxDecoded ? remainingDecodedBytes : maxDecoded
    const visible = Math.max(1, visibleSlots)
    const dimension = [512, 384, 256, 128].find(size => size <= requestedDimension && size * size * 4 * visible <= windowDecodedBudget) ?? 128
    desired.clear()
    for (const source of ordered) {
      if (!source.identity || source.identity.length > 4096 || !/^[0-9a-f]{64}$/u.test(source.display.sha256) || !source.dataUrl.startsWith('data:image/jpeg;base64,')
        || source.dataUrl.length > 24 + 4 * Math.ceil(1024 * 1024 / 3) || !Number.isSafeInteger(source.display.bytes) || source.display.bytes < 1 || source.display.bytes > 1024 * 1024
        || ![source.display.width, source.display.height].every(size => Number.isSafeInteger(size) && size >= 1 && size <= 1200)) continue
      const key = `${source.display.sha256}:${dimension}:${ALGORITHM}`
      desired.set(source.identity, { source, key, dimension })
    }
    const keys = new Set([...desired.values()].map(value => value.key))
    for (const key of queue.keys()) if (!keys.has(key)) queue.delete(key)
    for (const [key, job] of active) if (!keys.has(key)) job.abort.abort()
    for (const key of failed) if (!keys.has(key)) failed.delete(key)
    // 同身份URL保留，避免每完成一张图便让其他可见图重复解码；只撤离窗或变体改变的引用。
    for (const [identity, lease] of leases) if (desired.get(identity)?.key !== lease.key) release(identity)
    for (const candidate of desired.values()) {
      const thumbnail = cache.get(candidate.key), running = active.get(candidate.key)
      if (thumbnail) {
        cache.delete(candidate.key); cache.set(candidate.key, thumbnail)
        if (old.get(candidate.source.identity)?.key !== candidate.key) emitRendererArtwork('grid-hit', desktopArtworkKey(candidate.source.identity), { bytes: thumbnail.blob.size })
      } else if (!failed.has(candidate.key) && (!running || running.abort.signal.aborted)) queue.set(candidate.key, candidate)
    }
    bind(); notify(); pump()
  }
  return {
    setWindow,
    get(identity: string): GridArtworkView {
      const candidate = desired.get(identity), lease = leases.get(identity)
      if (candidate && lease?.key === candidate.key) return { status: 'ready', dataUrl: lease.url }
      return { status: candidate && failed.has(candidate.key) ? 'error' : 'loading', dataUrl: null }
    },
    retry(identity: string): void { const candidate = desired.get(identity); if (candidate) { failed.delete(candidate.key); for (const [id, lease] of leases) if (lease.key === candidate.key) release(id); const old = cache.get(candidate.key); if (old) { cache.delete(candidate.key); bytes -= old.blob.size } } },
    usage: () => ({ entries: cache.size, compressedBytes: bytes, decodedReferenceBytes: decoded, running: active.size, queued: queue.size }),
    dispose(): void { if (disposed) return; disposed = true; for (const job of active.values()) job.abort.abort(); queue.clear(); desired.clear(); failed.clear(); for (const identity of leases.keys()) release(identity); cache.clear(); bytes = 0 },
  }
}
