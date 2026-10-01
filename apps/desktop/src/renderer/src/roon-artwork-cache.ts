import { isValidRoonImageBinary, type RoonImageFormat, type RoonImageResult, type RoonImageScale } from '@music-bridge/contracts'
import { artworkError, decodeArtworkUrl, inspectActualArtworkDecode, readArtworkGeometry, type ArtworkGeometry, type ArtworkPriority } from './artwork-image.js'
import { readPublicIpcErrorCode } from './roonLibraryMessages.js'

export interface RoonArtworkRequest { reference: string; width: number; height: number; scale: RoonImageScale; format: RoonImageFormat }
export interface RoonArtworkAcquireOptions { signal?: AbortSignal; priority?: ArtworkPriority }
export interface RoonArtworkLease { readonly url: string; release(): void; invalidate(): void }
export interface RoonArtworkDiagnostics {
  entries: number; cachedEntries: number; compressedBytes: number; decodedBytesEstimate: number
  logicalFlights: number; actualGetImage: number; actualDecode: number; subscribers: number; negativeEntries: number
}
export interface RoonArtworkCacheDependencies {
  getImage?: (reference: string, options: Omit<RoonArtworkRequest, 'reference'>, context?: { signal: AbortSignal; deadlineAtMs: number }) => Promise<RoonImageResult>
  createObjectUrl?: (body: Uint8Array, contentType: string) => string
  revokeObjectUrl?: (url: string) => void
  decodeObjectUrl?: (url: string, priority?: ArtworkPriority) => Promise<void | ArtworkGeometry>
  now?: () => number
  maxEntries?: number; maxRetainedEntries?: number; maxCompressedBytes?: number; maxDecodedBytes?: number
  maxFlights?: number; maxSubscribers?: number; maxNegativeEntries?: number; maxActualGetImage?: number; maxActualDecode?: number
  negativeTtlMs?: number; timeoutMs?: number
}
export interface RoonArtworkCache {
  acquire(request: RoonArtworkRequest, options?: RoonArtworkAcquireOptions): Promise<RoonArtworkLease>
  clear(): void
  subscribeInvalidation(listener: () => void): () => void
  inspect(): Readonly<RoonArtworkDiagnostics>
}
interface ArtworkEntry {
  key: string; generation: number; url: string; bytes: number; decodedBytes: number
  leases: number; cached: boolean; invalid: boolean; revoked: boolean; decoding: boolean; disposed: boolean
}
interface Subscriber { priority: ArtworkPriority; finish(error?: Error, entry?: ArtworkEntry): void }
interface Flight {
  key: string; generation: number; controller: AbortController; deadline: number
  subscribers: Set<Subscriber>; timer: ReturnType<typeof setTimeout> | undefined; resource?: ArtworkEntry
}
interface NegativeEntry { error: Error; bornAt: number; expiresAt: number }
function limit(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError('封面预算无效')
  return value
}
function requestKey(request: RoonArtworkRequest): string {
  if (!/^musicbridge-v2-(?:image|entity)-[0-9a-f-]{36}$/u.test(request.reference)) throw new TypeError('Roon封面引用无效')
  if (!Number.isSafeInteger(request.width) || !Number.isSafeInteger(request.height) || request.width < 16 || request.height < 16 || request.width > 4096 || request.height > 4096 || !['fit', 'fill', 'stretch'].includes(request.scale) || !['image/jpeg', 'image/png'].includes(request.format)) throw new TypeError('Roon封面尺寸或格式无效')
  return JSON.stringify([request.reference, request.width, request.height, request.format, request.scale])
}
const cancelled = () => artworkError('ARTWORK_CANCELLED', '本次封面读取已取消')
const busy = () => artworkError('ARTWORK_BUSY', '封面资源繁忙，请重试')
const timedOut = () => artworkError('ARTWORK_TIMEOUT', '封面读取超时，请重试')
const reserved = (maximum: number) => Math.min(maximum - 1, Math.ceil(maximum * 2 / 32))
function readFailure(cause: unknown): Error {
  const code = readPublicIpcErrorCode(cause)
  // 公开request-failed不证明唯一根因；保守作为临时读取失败，不固化图片negative。
  if (code === 'ROON_LIBRARY_REQUEST_FAILED') return artworkError('ARTWORK_BUSY', '封面暂时无法读取，请重试')
  if (['READ_CANCELLED', 'LIBRARY_READ_CANCELLED', 'CANCELLED', 'ARTWORK_CANCELLED'].includes(code ?? '')) return cancelled()
  if (['READ_DEADLINE', 'LIBRARY_READ_DEADLINE', 'LIBRARY_READ_TIMEOUT', 'TIMEOUT', 'ARTWORK_TIMEOUT'].includes(code ?? '')) return timedOut()
  return cause instanceof Error ? cause : new Error('封面读取失败')
}

async function defaultGetImage(reference: string, options: Omit<RoonArtworkRequest, 'reference'>, context?: { signal: AbortSignal; deadlineAtMs: number }): Promise<RoonImageResult> {
  const api = window.musicBridge
  const readLibrary = api.readLibrary, cancelLibraryRead = api.cancelLibraryRead
  if (!context || typeof readLibrary !== 'function' || typeof cancelLibraryRead !== 'function') return api.getRoonImage(reference, options)
  const readId = crypto.randomUUID()
  const cancel = () => { try { void Promise.resolve(cancelLibraryRead.call(api, readId)).catch(() => undefined) } catch { /* 取消失败不重放读取。 */ } }
  context.signal.addEventListener('abort', cancel, { once: true })
  try {
    if (context.signal.aborted) throw cancelled()
    // 直接等待真实IPC Promise；本地flight结束不代替IPC或下层SDK settlement。
    return await readLibrary.call(api, { id: readId, deadlineAtMs: context.deadlineAtMs, command: 'roon.library.image', payload: { reference, options } }) as RoonImageResult
  } finally { context.signal.removeEventListener('abort', cancel) }
}

export function createRoonArtworkCache(dependencies: RoonArtworkCacheDependencies = {}): RoonArtworkCache {
  const getImage = dependencies.getImage ?? defaultGetImage
  const createUrl = dependencies.createObjectUrl ?? ((body: Uint8Array, contentType: string) => URL.createObjectURL(new Blob([new Uint8Array(body).buffer], { type: contentType })))
  const revokeUrl = dependencies.revokeObjectUrl ?? ((url: string) => URL.revokeObjectURL(url))
  const decode = dependencies.decodeObjectUrl ?? decodeArtworkUrl
  const now = dependencies.now ?? Date.now
  const maxEntries = limit(dependencies.maxEntries, 128), maxResources = limit(dependencies.maxRetainedEntries, 128)
  const maxBytes = limit(dependencies.maxCompressedBytes, 32 * 1024 * 1024), maxDecoded = limit(dependencies.maxDecodedBytes, 96 * 1024 * 1024)
  const maxFlights = limit(dependencies.maxFlights, 32), maxSubscribers = limit(dependencies.maxSubscribers, 256), maxNegative = limit(dependencies.maxNegativeEntries, 128)
  const maxGet = limit(dependencies.maxActualGetImage, 32), maxDecode = limit(dependencies.maxActualDecode, 32)
  const ttl = limit(dependencies.negativeTtlMs, 3000), timeout = limit(dependencies.timeoutMs, 10000)
  const entries = new Map<string, ArtworkEntry>(), resources = new Set<ArtworkEntry>(), pending = new Map<string, Flight>(), negative = new Map<string, NegativeEntry>()
  const listeners = new Set<() => void>()
  let generation = 0, bytes = 0, decodedBytes = 0, subscribers = 0, actualGet = 0, visibleGet = 0, actualDecode = 0, visibleDecode = 0
  const current = (flight: Flight) => flight.generation === generation && pending.get(flight.key) === flight && flight.subscribers.size > 0 && !flight.controller.signal.aborted && now() < flight.deadline
  const priority = (flight: Flight): ArtworkPriority => [...flight.subscribers].some(sub => sub.priority === 'playing') ? 'playing' : 'visible'
  const revoke = (entry: ArtworkEntry) => {
    if (entry.revoked || !entry.url) return
    entry.revoked = true
    revokeUrl(entry.url)
  }
  const dispose = (entry: ArtworkEntry, force = false) => {
    if (force) { entry.invalid = true; entry.cached = false; if (entries.get(entry.key) === entry) entries.delete(entry.key); revoke(entry) }
    if (entry.disposed || entry.decoding || (!force && (entry.cached || entry.leases > 0))) return
    revoke(entry); entry.disposed = true; resources.delete(entry); bytes -= entry.bytes; decodedBytes -= entry.decodedBytes
  }
  const remove = (entry: ArtworkEntry) => {
    if (entries.get(entry.key) === entry) entries.delete(entry.key)
    entry.cached = false; dispose(entry)
  }
  const addNegative = (key: string, error: Error) => {
    const bornAt = now(); negative.delete(key); negative.set(key, { error, bornAt, expiresAt: bornAt + ttl })
    while (negative.size > maxNegative) negative.delete(negative.keys().next().value!)
  }
  const lease = (entry: ArtworkEntry): RoonArtworkLease => {
    if (entry.invalid || entry.revoked || entry.disposed) throw cancelled()
    entry.leases++
    if (entry.cached) { entries.delete(entry.key); entries.set(entry.key, entry) }
    let released = false
    const release = () => { if (released) return; released = true; entry.leases--; dispose(entry) }
    return { url: entry.url, release, invalidate() {
      if (released) return
      const latest = [...resources].filter(resource => resource.key === entry.key).at(-1)
      if (entry.generation === generation && !entry.invalid && latest === entry && !pending.has(entry.key)) addNegative(entry.key, artworkError('ROON_IMAGE_DECODE_FAILED', '封面元素拒绝了已解码图片'))
      dispose(entry, true); release()
    } }
  }
  const retire = (flight: Flight) => {
    if (pending.get(flight.key) === flight) pending.delete(flight.key)
    if (flight.timer !== undefined) clearTimeout(flight.timer)
    flight.timer = undefined; flight.controller.abort()
  }
  const failFlight = (flight: Flight, error: Error) => {
    for (const subscriber of [...flight.subscribers]) subscriber.finish(error)
    retire(flight)
    if (flight.resource) dispose(flight.resource, true)
  }
  const makeResource = (flight: Flight, body: Uint8Array, rgbaBytes: number): ArtworkEntry => {
    if (body.byteLength > maxBytes || rgbaBytes > maxDecoded) throw artworkError('ROON_IMAGE_DECODE_FAILED', '封面超过资源预算')
    while (resources.size >= maxResources || bytes + body.byteLength > maxBytes || decodedBytes + rgbaBytes > maxDecoded) {
      const candidate = [...entries.values()].find(entry => entry.leases === 0 && !entry.decoding)
      if (!candidate) throw busy()
      remove(candidate)
    }
    const entry: ArtworkEntry = { key: flight.key, generation: flight.generation, url: '', bytes: body.byteLength, decodedBytes: rgbaBytes, leases: 0, cached: false, invalid: false, revoked: false, decoding: false, disposed: false }
    resources.add(entry); bytes += entry.bytes; decodedBytes += entry.decodedBytes; flight.resource = entry
    return entry
  }
  const run = async (flight: Flight, request: RoonArtworkRequest) => {
    let entry: ArtworkEntry | undefined
    try {
      if (!current(flight)) throw cancelled()
      const fetchPriority = priority(flight)
      if (actualGet >= maxGet || (fetchPriority === 'visible' && visibleGet >= maxGet - reserved(maxGet))) throw busy()
      actualGet++; if (fetchPriority === 'visible') visibleGet++
      let result: RoonImageResult
      try { result = await getImage(request.reference, { width: request.width, height: request.height, scale: request.scale, format: request.format }, { signal: flight.controller.signal, deadlineAtMs: flight.deadline }) }
      finally { actualGet--; if (fetchPriority === 'visible') visibleGet-- }
      if (!current(flight)) throw cancelled()
      if (!isValidRoonImageBinary(result.contentType, result.body)) throw artworkError('ROON_IMAGE_DECODE_FAILED', '封面二进制校验失败')
      const expected = readArtworkGeometry(result.body, result.contentType)
      entry = makeResource(flight, result.body, expected.rgbaBytes)
      entry.url = createUrl(result.body, result.contentType)
      if (!current(flight) || entry.invalid) throw cancelled()
      const decodePriority = priority(flight)
      if (actualDecode >= maxDecode || (decodePriority === 'visible' && visibleDecode >= maxDecode - reserved(maxDecode))) throw busy()
      actualDecode++; if (decodePriority === 'visible') visibleDecode++; entry.decoding = true
      let observed: void | ArtworkGeometry
      try { observed = await decode(entry.url, decodePriority) }
      catch (cause) { if (cause instanceof Error && 'code' in cause && cause.code === 'ARTWORK_BUSY') throw cause; throw artworkError('ROON_IMAGE_DECODE_FAILED', '封面解码失败') }
      finally { actualDecode--; if (decodePriority === 'visible') visibleDecode--; entry.decoding = false; if (entry.invalid) dispose(entry, true) }
      if (!current(flight) || entry.invalid) throw cancelled()
      if (observed && (observed.width !== expected.width || observed.height !== expected.height)) throw artworkError('ROON_IMAGE_DECODE_FAILED', '封面解码尺寸与编码不一致')
      while (entries.size >= maxEntries) {
        const candidate = [...entries.values()].find(candidate => candidate.leases === 0)
        if (!candidate) break
        remove(candidate)
      }
      if (entries.size < maxEntries) { entry.cached = true; entries.set(entry.key, entry) }
      for (const subscriber of [...flight.subscribers]) subscriber.finish(undefined, entry)
      dispose(entry)
    } catch (cause) {
      const error = readFailure(cause)
      if (current(flight) && !['ARTWORK_CANCELLED', 'ARTWORK_TIMEOUT', 'ARTWORK_BUSY'].includes(String((error as Error & { code?: string }).code))) addNegative(flight.key, error)
      failFlight(flight, error)
      if (entry) dispose(entry, true)
    } finally { retire(flight) }
  }
  return {
    async acquire(request, options = {}) {
      const requested = { ...request }, signal = options.signal
      const key = requestKey(requested), selectedPriority = options.priority ?? 'visible'
      if (!['visible', 'playing'].includes(selectedPriority)) throw new TypeError('封面优先级无效')
      if (signal?.aborted) throw cancelled()
      const cached = entries.get(key); if (cached) return lease(cached)
      const failed = negative.get(key)
      if (failed) { const time = now(); if (failed.bornAt <= time && time < failed.expiresAt) throw failed.error; negative.delete(key) }
      if (subscribers >= maxSubscribers) throw busy()
      let flight = pending.get(key), fresh = false
      if (!flight) {
        const visibleFlights = [...pending.values()].filter(item => priority(item) === 'visible').length
        if (pending.size >= maxFlights || (selectedPriority === 'visible' && visibleFlights >= maxFlights - reserved(maxFlights))) throw busy()
        flight = { key, generation, controller: new AbortController(), deadline: now() + timeout, subscribers: new Set(), timer: undefined }
        pending.set(key, flight); fresh = true
      }
      const owned = flight
      const result = new Promise<RoonArtworkLease>((resolve, reject) => {
        const abort = () => subscriber.finish(cancelled())
        const subscriber: Subscriber = { priority: selectedPriority, finish(error, entry) {
          if (!owned.subscribers.delete(subscriber)) return
          subscribers--; signal?.removeEventListener('abort', abort)
          if (error) reject(error)
          else { try { resolve(lease(entry!)) } catch (cause) { reject(cause) } }
          if (!owned.subscribers.size) { retire(owned); if (error && owned.resource) dispose(owned.resource, true) }
        } }
        subscribers++; owned.subscribers.add(subscriber); signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
      })
      if (fresh) {
        owned.timer = setTimeout(() => failFlight(owned, timedOut()), Math.max(0, owned.deadline - now()))
        void Promise.resolve().then(() => run(owned, requested))
      }
      return result
    },
    clear() {
      generation++; negative.clear()
      for (const flight of [...pending.values()]) failFlight(flight, cancelled())
      for (const entry of [...resources]) dispose(entry, true)
      entries.clear()
      for (const listener of [...listeners]) { try { listener() } catch { /* 一个组件不能阻断其他组件清理。 */ } }
    },
    subscribeInvalidation(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    inspect() { return Object.freeze({ entries: resources.size, cachedEntries: entries.size, compressedBytes: bytes, decodedBytesEstimate: decodedBytes, logicalFlights: pending.size, actualGetImage: actualGet, actualDecode: dependencies.decodeObjectUrl ? actualDecode : inspectActualArtworkDecode(), subscribers, negativeEntries: negative.size }) },
  }
}
export const roonArtworkCache = createRoonArtworkCache()
