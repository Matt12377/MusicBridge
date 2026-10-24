import { computed, getCurrentScope, onScopeDispose, shallowRef, watch } from 'vue'
import { logLibraryOperation } from '../../../../../../../packages/bridge-core/src/shared/library-operation-log.js'
import { isLocalAlbumArtworkReply, isLocalAlbumSummary, isLocalAlbumTrackItem, isLocalQueueIdentity } from '@music-bridge/contracts'
import type { LocalAlbumArtworkRequest, LocalAlbumArtworkReply, LocalAlbumSummary, LocalAlbumTrackItem, LocalQueueIdentity, PlaybackSnapshot, TrackSummary } from '@music-bridge/contracts'

const maxAssociations = 128, maxAssociationBytes = 256 * 1024
interface Association { request: Readonly<LocalAlbumArtworkRequest>; bytes: number }
interface DisplayRead { key: string; request: Readonly<LocalAlbumArtworkRequest> }
export interface LocalPlaybackArtworkOptions {
  getDatasetId(): string | null
  isReadReady(): boolean
  getClockIdentity(): string | undefined
  getSnapshot(): PlaybackSnapshot | null
  getTrack(): TrackSummary | undefined
  getOpenedAlbums(): readonly { album: LocalAlbumSummary | null; tracks: readonly LocalAlbumTrackItem[] }[]
  read(request: LocalAlbumArtworkRequest): Promise<LocalAlbumArtworkReply>
}
const identityKey = (identity: LocalQueueIdentity, editionId: string | null): string => JSON.stringify([
  identity.local_track_id, identity.asset_id, identity.asset_revision, identity.selection_revision,
  identity.location_revision, identity.root_revision, editionId,
])
const requestKey = (request: Readonly<LocalAlbumArtworkRequest>): string => JSON.stringify([
  request.albumKey, request.rootId, request.editionId, request.representativeTrackId, request.revision,
])

/** 只补播放器显示；关联来自已打开专辑的真实成员，图片仍由原Owner五元组读口核验。 */
export function useLocalPlaybackArtwork(options: LocalPlaybackArtworkOptions) {
  const associations = new Map<string, Association>(), activeKey = shallowRef<string | null>(null)
  const display = shallowRef<{ key: string; trackId: string; dataUrl: string } | null>(null)
  let dataset: string | null = null, bytes = 0, disposed = false, protectedIdentity: string | null = null
  let running: Promise<void> | null = null, queued: DisplayRead | null = null, scheduled = false
  let observedWait: string | null = null
  function waiting(code: string): null {
    if (code !== observedWait) {
      observedWait = code
      logLibraryOperation('ui', 'playback.artwork', 'skipped', { code, count: associations.size })
    }
    return null
  }
  let previousOpened: readonly { album: LocalAlbumSummary | null; tracks: readonly LocalAlbumTrackItem[] }[] = []
  function resetDataset(): void {
    const next = options.getDatasetId()
    if (next === dataset) return
    dataset = next; associations.clear(); bytes = 0; protectedIdentity = null; queued = null; activeKey.value = null; display.value = null; previousOpened = []
  }
  function currentIdentity(): string | null {
    const snapshot = options.getSnapshot(), local = snapshot?.local, track = options.getTrack()
    const item = snapshot?.queue.items[snapshot.queue.index]
    if (!dataset || !snapshot || snapshot.source !== 'local_file' || !track || !local || !item || !isLocalQueueIdentity(item.local)
      || item.trackId !== track.id || local.local_track_id !== track.id || item.local.local_track_id !== track.id
      || local.asset_id !== item.local.asset_id || local.asset_revision !== item.local.asset_revision
      || local.target.zone_id !== snapshot.selectedZoneId) return null
    return identityKey(item.local, item.edition?.id ?? null)
  }
  function remember(album: LocalAlbumSummary, member: LocalAlbumTrackItem): void {
    if (!dataset || !isLocalAlbumSummary(album) || !isLocalAlbumTrackItem(member) || member.facts.asset.libraryRootId !== album.rootId
      || album.editionId !== null && !member.facts.editions.some(edition => edition.id === album.editionId)) return
    const { track, asset } = member.facts
    const identity: LocalQueueIdentity = { local_track_id: track.id, asset_id: asset.id, asset_revision: asset.fileRevision,
      selection_revision: track.selectionRevision, location_revision: asset.locationRevision, root_revision: asset.rootRevision }
    if (!isLocalQueueIdentity(identity)) return
    const key = identityKey(identity, album.editionId), request = Object.freeze({ albumKey: album.id, rootId: album.rootId,
      editionId: album.editionId, representativeTrackId: album.representativeTrackId, revision: album.revision })
    const size = 2 * (key.length + JSON.stringify(request).length), previous = associations.get(key)
    if (size > maxAssociationBytes) return
    if (previous) { bytes -= previous.bytes; associations.delete(key) }
    while (associations.size && (associations.size >= maxAssociations || bytes + size > maxAssociationBytes)) {
      let oldest = associations.keys().next().value!
      if (oldest === protectedIdentity) {
        const protectedValue = associations.get(oldest)!; associations.delete(oldest); associations.set(oldest, protectedValue)
        if (associations.size === 1) return
        oldest = associations.keys().next().value!
      }
      bytes -= associations.get(oldest)!.bytes; associations.delete(oldest)
    }
    associations.set(key, { request, bytes: size }); bytes += size
  }
  function desired(): DisplayRead | null {
    resetDataset()
    if (!options.isReadReady()) return waiting('PLAYBACK_NOT_READY')
    if (!dataset) return waiting('DATASET_NOT_READY')
    const clock = options.getClockIdentity(), identity = currentIdentity()
    if (!clock || !identity) return waiting(!clock ? 'CLOCK_NOT_READY' : 'LOCAL_IDENTITY_NOT_READY')
    protectedIdentity = identity
    let association = associations.get(identity)
    if (!association) {
      // 当前曲可能在有界历史窗口之外，只从仍打开的真实成员里补精确身份，不按名称猜测。
      for (const opened of options.getOpenedAlbums()) if (opened.album) for (const member of opened.tracks) {
        if (member.facts.track.id === options.getTrack()?.id) remember(opened.album, member)
      }
      association = associations.get(identity)
    }
    if (!association) return waiting('ALBUM_ASSOCIATION_MISSING')
    observedWait = null
    return { request: association.request, key: JSON.stringify([dataset, clock, identity, requestKey(association.request)]) }
  }
  function schedulePump(): void {
    if (disposed || scheduled || running || !queued) return
    scheduled = true
    // Clock与快照由原session同栈顺序更新；只合并装饰请求，失效与撤旧图仍同步。
    queueMicrotask(() => { scheduled = false; pump() })
  }
  function pump(): void {
    if (disposed || running || !queued) return
    const read = queued; queued = null
    if (activeKey.value !== read.key || desired()?.key !== read.key) { reconcile(); return }
    const task = (async () => {
      const started = performance.now()
      logLibraryOperation('ui', 'playback.artwork', 'start')
      try {
        const reply = await options.read({ ...read.request })
        if (disposed || activeKey.value !== read.key || desired()?.key !== read.key) return
        if (!isLocalAlbumArtworkReply(reply, read.request)) throw new Error('本地播放封面回复身份无效。')
        // 原display编码上限为1MiB；只保当前一张，绝不放进Core队列或扩大全墙LRU。
        display.value = reply.image ? { key: read.key, trackId: options.getTrack()!.id, dataUrl: reply.image.display.dataUrl } : null
        logLibraryOperation('ui', 'playback.artwork', 'complete', { elapsedMs: performance.now() - started, count: reply.image ? 1 : 0 })
      } catch {
        logLibraryOperation('ui', 'playback.artwork', 'error', { elapsedMs: performance.now() - started })
      }
    })()
    running = task
    void task.finally(() => { if (running === task) running = null; schedulePump() })
  }
  function reconcile(): void {
    if (disposed) return
    const read = desired(), key = read?.key ?? null
    if (key === activeKey.value) return
    activeKey.value = key; display.value = null; queued = read; schedulePump()
  }
  const stopOpened = watch(() => [options.getDatasetId(), options.getOpenedAlbums()] as const, () => {
    resetDataset()
    const opened = options.getOpenedAlbums()
    if (opened.length !== previousOpened.length || opened.some((value, index) => value.album !== previousOpened[index]?.album || value.tracks !== previousOpened[index]?.tracks)) {
      protectedIdentity = currentIdentity()
      for (const value of opened) if (value.album) for (const member of value.tracks) remember(value.album, member)
      previousOpened = opened.map(value => ({ album: value.album, tracks: value.tracks }))
    }
    reconcile()
  }, { immediate: true, flush: 'sync' })
  const stopPlayback = watch(() => [options.getSnapshot(), options.getClockIdentity(), options.isReadReady(), options.getTrack()] as const, reconcile, { immediate: true, flush: 'sync' })
  const currentTrack = computed(() => {
    const track = options.getTrack(), image = display.value
    return track && image && image.key === activeKey.value && image.trackId === track.id && !track.artworkUrl && !track.artworkReference
      ? { ...track, artworkUrl: image.dataUrl } : track
  })
  function dispose(): void { if (disposed) return; disposed = true; stopOpened(); stopPlayback(); queued = null; associations.clear(); bytes = 0; activeKey.value = null; display.value = null; previousOpened = [] }
  if (getCurrentScope()) onScopeDispose(dispose)
  return { currentTrack, dispose, getAssociationUsage: () => ({ entries: associations.size, bytes, active: running ? 1 : 0, pending: queued ? 1 : 0 }) }
}
