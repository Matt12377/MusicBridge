import { onUnmounted, ref, watch, type Ref } from 'vue'
import type { FavoriteKind, FavoriteRecord } from '@music-bridge/contracts'
import type { MusicBridgePublicApi } from '../../../preload/api.js'
import { createLibraryReadScope } from './libraryReadScope.js'
import { resolveFavorite, type FavoriteResolution } from './favoriteResolution.js'
const MAX_ENTRIES = 128, MAX_BYTES = 2 * 1024 * 1024, TTL_MS = 15_000
export function favoriteResolutionKey(scope: string, kind: FavoriteKind, record: FavoriteRecord): string {
  return JSON.stringify([scope, kind, record.favoriteId, record.createdAt, record.updatedAt, record.kind, record.title, record.subtitle, record.artist, record.album, record.durationMs, record.trackNumber, record.discNumber, record.year, record.version])
}
/** 只保当前窗口待处理集合；结果是短租期纯值，取消不会把离窗结果暖入池。 */
export function useFavoriteWindowResolution(windowItems: Readonly<Ref<readonly FavoriteRecord[]>>, getScope: () => string, getKind: () => FavoriteKind, api: MusicBridgePublicApi, now = Date.now) {
  const reader = createLibraryReadScope(api), version = ref(0), resolving = ref<string | null>(null)
  const pool = new Map<string, { result: FavoriteResolution; at: number; bytes: number }>()
  let retainedBytes = 0, disposed = false, generation = 0, running = false, scope = getScope(), kind = getKind(), timer: ReturnType<typeof setTimeout> | undefined
  let current = new Map<string, FavoriteRecord>(), active: { key: string; generation: number; abort: AbortController } | undefined
  const attempted = new Map<string, number>()
  function cached(key: string): FavoriteResolution | undefined {
    const entry = pool.get(key); if (!entry) return undefined
    const age = now() - entry.at
    if (age < 0 || age >= TTL_MS) { pool.delete(key); retainedBytes -= entry.bytes; return undefined }
    return entry.result
  }
  function result(record: FavoriteRecord): FavoriteResolution | undefined { void version.value; return cached(favoriteResolutionKey(getScope(), getKind(), record)) }
  function put(key: string, value: FavoriteResolution): void {
    let bytes = new TextEncoder().encode(JSON.stringify([key, value])).byteLength
    if (bytes > MAX_BYTES) { value = { state: 'error', message: '匹配结果过大，请从本地资料库选择。' }; bytes = new TextEncoder().encode(JSON.stringify([key, value])).byteLength }
    const old = pool.get(key); if (old) { retainedBytes -= old.bytes; pool.delete(key) }
    while (pool.size >= MAX_ENTRIES || retainedBytes + bytes > MAX_BYTES) {
      const victim = [...pool.keys()].find(candidate => !current.has(candidate)) ?? pool.keys().next().value
      if (!victim) break
      retainedBytes -= pool.get(victim)!.bytes; pool.delete(victim)
    }
    pool.set(key, { result: JSON.parse(JSON.stringify(value)) as FavoriteResolution, at: now(), bytes }); retainedBytes += bytes; version.value++
  }
  function armExpiry(): void {
    if (timer) clearTimeout(timer); timer = undefined
    let remaining = Infinity
    for (const key of current.keys()) { const entry = pool.get(key); if (entry) remaining = Math.min(remaining, Math.max(0, TTL_MS - (now() - entry.at))) }
    if (Number.isFinite(remaining)) timer = setTimeout(() => { attempted.clear(); version.value++; void pump() }, remaining + 1)
  }
  async function pump(): Promise<void> {
    if (running || disposed) return
    running = true
    try {
      while (!disposed) {
        const next = [...current].find(([key]) => !cached(key) && !attempted.has(key)); if (!next) break
        const [key, record] = next, owner = { key, generation, abort: new AbortController() }; active = owner; attempted.set(key, now()); resolving.value = record.favoriteId
        const valid = () => !disposed && active === owner && generation === owner.generation && current.has(key) && scope === getScope() && kind === getKind() && !owner.abort.signal.aborted
        const deadlineAtMs = now() + 10_000
        const value = await resolveFavorite(record,
          (query, page, entityKind) => reader.read('roon.library.search', { query, page, kind: entityKind }, () => api.searchRoonLibrary(query, page, entityKind), { signal: owner.abort.signal, deadlineAtMs }), valid,
          (reference, page) => reader.read('roon.library.album', { reference, page }, () => api.getRoonAlbumTracks(reference, page), { signal: owner.abort.signal, deadlineAtMs }))
        if (valid()) put(key, value)
        if (active === owner) { active = undefined; resolving.value = null }
      }
    } finally { running = false; if (!disposed) armExpiry() }
  }
  function synchronize(): void {
    const newScope = getScope(), newKind = getKind()
    if (newScope !== scope || newKind !== kind) { generation++; active?.abort.abort(); reader.cancelAll(); pool.clear(); retainedBytes = 0; attempted.clear(); scope = newScope; kind = newKind; version.value++ }
    const next = new Map(windowItems.value.map(record => [favoriteResolutionKey(scope, kind, record), record]))
    if (active && !next.has(active.key)) active.abort.abort()
    current = next
    for (const [key, at] of attempted) if (!current.has(key) || (active?.key !== key && (now() - at < 0 || now() - at >= TTL_MS))) attempted.delete(key)
    void pump()
  }
  function retry(record: FavoriteRecord): void {
    const key = favoriteResolutionKey(getScope(), getKind(), record); if (!current.has(key)) return
    const entry = pool.get(key); if (entry) { pool.delete(key); retainedBytes -= entry.bytes }
    attempted.delete(key); version.value++; void pump()
  }
  watch(() => [windowItems.value, getScope(), getKind()] as const, synchronize, { immediate: true, flush: 'sync' })
  onUnmounted(() => { disposed = true; generation++; active?.abort.abort(); reader.dispose(); if (timer) clearTimeout(timer); pool.clear(); current.clear(); retainedBytes = 0 })
  return { result, retry, resolving, stats: () => ({ entries: pool.size, bytes: retainedBytes, pending: active ? 1 : 0, queued: current.size }) }
}
