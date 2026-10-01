import { computed, ref, shallowRef } from 'vue'
import { roonTrackIdFromReference } from '@music-bridge/contracts'
import type {
  FavoriteEntityDescriptor, LocalLyricsMatchSnapshot, LyricsSnapshot, Page, PageRequest,
  PlaybackQualityPreference, PlaybackQueueItem, PlaybackQueueRequestItem, PlaybackSnapshot,
  PlaybackEventProtocolAck, PlaybackStreamSnapshot, PlaybackStreamState, PlaybackStreamProgress,
  PublicRoonZone, PublicTrackMatchResult, RoonLibraryItem, RoonLibraryPage, TrackSummary,
} from '@music-bridge/contracts'
import type { MusicBridgePublicApi } from '../../../../preload/api.js'
import type { ZoneLifecycleStatus } from '../../zone-lifecycle.js'
import {
  createProgressiveCollectionLoader, selectInitialCollectionPlayback,
  type CollectionPageLoader, type ProgressiveCollectionLoader,
} from '../collectionQueue.js'
import {
  confirmedRoonCandidate, immediatePlaybackSelection, nativeRoonQueueItemHasNeteaseIdentity,
  queuePreferenceForMatch, waitForMatchWithinPlaybackBudget,
} from '../playbackMatching.js'
import { resolveFavoriteToggle } from '../playbackFavorites.js'
import { createOptimisticRoonPlayback } from '../../roon-playback-optimism.js'
import { collectRoonPlaybackContext } from '../../roon-context-queue.js'
import { projectPlaybackSnapshot } from './playbackSnapshot.js'
import { createPlaybackStreamReducer, type PlaybackStreamApplication } from './playbackStreamReducer.js'

const LIBRARY_PAGE_SIZE = 20
const MAX_ROON_QUEUE_DESCRIPTORS = 256

export interface RoonPlaybackContext {
  page: RoonLibraryPage
  reference: string
  load: (reference: string, page: PageRequest) => Promise<RoonLibraryPage>
}

export interface PlaybackSessionOptions {
  api: MusicBridgePublicApi
  getSelectedZone: () => PublicRoonZone | undefined
  getZoneLifecycleStatus: () => ZoneLifecycleStatus
  getSelectedQuality: () => PlaybackQualityPreference
  getMatchResult: (trackId: string) => PublicTrackMatchResult | undefined
  getPendingMatch: (trackId: string) => Promise<PublicTrackMatchResult> | undefined
  onMatchTracks: (tracks: readonly TrackSummary[]) => void
  getRoonPlaybackContext: () => RoonPlaybackContext | undefined
  /** 关闭时保留完整读取的旧播放路径；正式能力由Core响应句柄决定。 */
  roonContextPlaybackEnabled?: boolean
  resolveFavoriteDescriptor: (item: RoonLibraryItem) => FavoriteEntityDescriptor
  onEnterNowPlaying: () => void
  clearActionError: () => void
  onActionMessage: (message: string) => void
  onError: (error: unknown) => void
  onToast: (message: string) => void
}

function emptyLyricsSnapshot(status: LyricsSnapshot['status'] = 'idle'): LyricsSnapshot {
  return { status, lines: [], activeLineIndex: -1, timingSource: 'static' }
}

function emptyLocalLyricsMatchSnapshot(): LocalLyricsMatchSnapshot {
  return { status: 'hidden', candidates: [], canRevoke: false }
}

export function usePlaybackSession(options: PlaybackSessionOptions) {
  const {
    api, getSelectedZone, getZoneLifecycleStatus, getSelectedQuality,
    getMatchResult, getPendingMatch, onMatchTracks, getRoonPlaybackContext,
    resolveFavoriteDescriptor, onEnterNowPlaying, clearActionError, onActionMessage, onError, onToast,
  } = options

  const playbackState = shallowRef<PlaybackSnapshot | null>(null)
  const playbackStartPending = ref(false)
  const stream = createPlaybackStreamReducer()
  let streamMode: 'unknown' | 'legacy' | 'compact' = typeof api.getPlaybackStreamSnapshot === 'function' ? 'unknown' : 'legacy'
  let streamLifecycle = 0, seekOperation = 0, automaticAttemptUsed = false
  let recoveryToken = {}
  let syncFlight: Promise<void> | undefined
  let pendingSeek: { target: number; acknowledged: boolean; isCurrent: () => boolean; settle?: (position?: number) => void; timer?: ReturnType<typeof setTimeout> } | undefined
  const playbackSyncStatus = ref<'ready' | 'syncing' | 'error' | 'suspended'>(streamMode === 'legacy' ? 'ready' : 'syncing')
  const playbackClockIdentity = ref<string | undefined>()
  const playbackViewState = computed(() => {
    const value = playbackState.value
    return !value || playbackSyncStatus.value === 'ready' ? value : {
      ...value, canNext: false, canPrevious: false, canStop: false, canPause: false, canResume: false,
    }
  })
  const playbackSource = ref<'roon' | 'netease'>('netease')
  const nativeRoonHasNeteaseMatch = ref(false)
  const lyricsSnapshot = shallowRef<LyricsSnapshot>(emptyLyricsSnapshot())
  const localLyricsMatchState = shallowRef<LocalLyricsMatchSnapshot>(emptyLocalLyricsMatchSnapshot())
  const localLyricsMatchBusy = ref(false)
  const localLyricsMatchError = ref(false)
  let localLyricsMatchRevision = 0
  const trackLikeState = ref<'idle' | 'loading' | 'liked' | 'not-liked' | 'error'>('idle')
  const neteaseTrackLiked = ref<boolean | null>(null)
  const localTrackFavoriteState = ref<'idle' | 'loading' | 'liked' | 'not-liked' | 'error'>('idle')
  const localTrackFavoriteDescriptor = ref<FavoriteEntityDescriptor | null>(null)
  const roonQueueDescriptors = new Map<string, RoonLibraryItem>()
  const roonQueueNeteaseMatches = new Set<string>()

  function rememberRoonQueueDescriptor(
    trackId: string,
    item: RoonLibraryItem,
    linkedToNetease = false,
  ): void {
    roonQueueDescriptors.set(trackId, item)
    if (linkedToNetease) roonQueueNeteaseMatches.add(trackId)
    else roonQueueNeteaseMatches.delete(trackId)
    while (roonQueueDescriptors.size > MAX_ROON_QUEUE_DESCRIPTORS) {
      const oldest = roonQueueDescriptors.keys().next().value
      if (oldest === undefined) break
      roonQueueDescriptors.delete(oldest)
      roonQueueNeteaseMatches.delete(oldest)
    }
  }

  function rememberPublishedRoonItem(item: PlaybackQueueItem | undefined): void {
    const descriptor = item?.roonItem
    if (!item || !descriptor || descriptor.kind !== 'track' || item.preferredSource !== 'roon') return
    try {
      if (roonTrackIdFromReference(descriptor.reference) !== item.trackId) return
    } catch { return }
    rememberRoonQueueDescriptor(item.trackId, descriptor)
  }
  const recentTracks = ref<readonly TrackSummary[]>([])

  let lyricsOperation = 0
  let trackLikeOperation = 0
  let localFavoriteOperation = 0
  let collectionOperation = 0
  let roonPlaybackOperation = 0
  let pendingRoonPlaybackOperation: number | undefined
  let optimisticRoonTrackId: string | undefined
  let retryStopSource: 'roon' | 'netease' | undefined

  function cancelRoonPlaybackPreparation(): void {
    ++roonPlaybackOperation
    optimisticRoonTrackId = undefined
    if (pendingRoonPlaybackOperation !== undefined) {
      pendingRoonPlaybackOperation = undefined
      playbackStartPending.value = false
    }
  }
  let activeCollectionLoader: ProgressiveCollectionLoader | undefined
  let collectionPlaybackStartInFlight = false
  let disposed = false
  const currentTrack = computed(() => playbackState.value?.currentTrack)

  async function loadLyrics(trackId: string): Promise<void> {
    const operation = ++lyricsOperation
    lyricsSnapshot.value = emptyLyricsSnapshot('loading')
    try {
      const snapshot = await api.getLyrics(trackId)
      if (operation !== lyricsOperation || playbackState.value?.currentTrack?.id !== trackId) return
      lyricsSnapshot.value = snapshot
    } catch {
      if (operation === lyricsOperation) lyricsSnapshot.value = emptyLyricsSnapshot('error')
    }
  }

  async function selectLocalLyricsMatch(matchSessionId: string, candidateId: string): Promise<void> {
    if (localLyricsMatchBusy.value) return
    const revision = localLyricsMatchRevision
    localLyricsMatchBusy.value = true
    localLyricsMatchError.value = false
    try {
      const state = await api.selectLocalLyricsMatch(matchSessionId, candidateId)
      if (localLyricsMatchRevision === revision) localLyricsMatchState.value = state
    } catch (error) {
      if (localLyricsMatchRevision === revision) {
        localLyricsMatchError.value = true
        onError(error)
      }
    } finally {
      localLyricsMatchBusy.value = false
    }
  }

  async function revokeLocalLyricsMatch(): Promise<void> {
    if (localLyricsMatchBusy.value) return
    const revision = localLyricsMatchRevision
    localLyricsMatchBusy.value = true
    localLyricsMatchError.value = false
    try {
      const state = await api.revokeLocalLyricsMatch()
      if (localLyricsMatchRevision === revision) localLyricsMatchState.value = state
    } catch (error) {
      if (localLyricsMatchRevision === revision) {
        localLyricsMatchError.value = true
        onError(error)
      }
    } finally {
      localLyricsMatchBusy.value = false
    }
  }

  function resetLocalTrackFavorite(): void {
    localFavoriteOperation += 1
    localTrackFavoriteDescriptor.value = null
    localTrackFavoriteState.value = 'idle'
  }

  function sameFavoriteDescriptor(left: FavoriteEntityDescriptor | null, right: FavoriteEntityDescriptor | null): boolean {
    if (left === right) return true
    if (!left || !right) return false
    return left.kind === right.kind && left.title === right.title
      && left.subtitle === right.subtitle && left.artist === right.artist
      && left.album === right.album && left.durationMs === right.durationMs
      && left.trackNumber === right.trackNumber && left.discNumber === right.discNumber
      && left.year === right.year && left.version === right.version
  }

  // Vue 的深 ref 会把 DTO 包成 Proxy；跨 contextBridge 前只复制合同内的标量字段。
  function plainFavoriteDescriptor(descriptor: FavoriteEntityDescriptor): FavoriteEntityDescriptor {
    return {
      kind: descriptor.kind,
      title: descriptor.title,
      ...(descriptor.subtitle !== undefined ? { subtitle: descriptor.subtitle } : {}),
      ...(descriptor.artist !== undefined ? { artist: descriptor.artist } : {}),
      ...(descriptor.album !== undefined ? { album: descriptor.album } : {}),
      ...(descriptor.durationMs !== undefined ? { durationMs: descriptor.durationMs } : {}),
      ...(descriptor.trackNumber !== undefined ? { trackNumber: descriptor.trackNumber } : {}),
      ...(descriptor.discNumber !== undefined ? { discNumber: descriptor.discNumber } : {}),
      ...(descriptor.year !== undefined ? { year: descriptor.year } : {}),
      ...(descriptor.version !== undefined ? { version: descriptor.version } : {}),
    }
  }

  function isCurrentFavoriteContext(
    trackId: string,
    source: 'roon' | 'netease',
    nativeMatch: boolean,
    descriptor: FavoriteEntityDescriptor | null,
    operation: number,
  ): boolean {
    return !disposed
      && trackLikeOperation === operation
      && currentTrack.value?.id === trackId
      && playbackSource.value === source
      && nativeRoonHasNeteaseMatch.value === nativeMatch
      && localTrackFavoriteDescriptor.value === descriptor
  }

  async function loadTrackLikeStatus(trackId: string): Promise<void> {
    const operation = ++trackLikeOperation
    const source = playbackSource.value
    const nativeMatch = nativeRoonHasNeteaseMatch.value
    const isRoonPlayback = source === 'roon'
    const hasNeteaseIdentity = !isRoonPlayback || nativeMatch
    const descriptor = isRoonPlayback ? localTrackFavoriteDescriptor.value : null
    trackLikeState.value = 'loading'
    neteaseTrackLiked.value = null
    if (descriptor) {
      localFavoriteOperation += 1
      localTrackFavoriteState.value = 'loading'
    } else {
      localTrackFavoriteState.value = 'idle'
    }
    try {
      const [neteaseResult, localResult] = await Promise.all([
        hasNeteaseIdentity
          ? api.getTrackLikeStatus(trackId)
          : Promise.resolve(undefined),
        descriptor
          ? api.checkFavorite(plainFavoriteDescriptor(descriptor))
          : Promise.resolve(undefined),
      ])
      if (!isCurrentFavoriteContext(trackId, source, nativeMatch, descriptor, operation)) return
      const neteaseLiked = neteaseResult?.liked ?? false
      const localLiked = localResult?.favorite ?? false
      neteaseTrackLiked.value = hasNeteaseIdentity ? neteaseLiked : null
      if (descriptor) localTrackFavoriteState.value = localLiked ? 'liked' : 'not-liked'
      trackLikeState.value = (isRoonPlayback ? localLiked || neteaseLiked : neteaseLiked)
        ? 'liked'
        : 'not-liked'
    } catch {
      if (isCurrentFavoriteContext(trackId, source, nativeMatch, descriptor, operation)) {
        trackLikeState.value = 'error'
        if (descriptor) localTrackFavoriteState.value = 'error'
      }
    }
  }

  async function toggleTrackLike(): Promise<void> {
    const trackId = currentTrack.value?.id
    const descriptor = localTrackFavoriteDescriptor.value
    const source = playbackSource.value
    const nativeMatch = nativeRoonHasNeteaseMatch.value
    const isRoonPlayback = source === 'roon'
    const hasNeteaseIdentity = !isRoonPlayback || nativeMatch
    if (
      !trackId ||
      trackLikeState.value === 'loading' ||
      (!hasNeteaseIdentity && !descriptor)
    ) return
    const desiredLike = (): boolean | null => resolveFavoriteToggle({
      netease: hasNeteaseIdentity
        ? { available: true, liked: neteaseTrackLiked.value }
        : { available: false },
      local: descriptor
        ? {
          available: true,
          liked: localTrackFavoriteState.value === 'liked'
            ? true
            : localTrackFavoriteState.value === 'not-liked' ? false : null,
        }
        : { available: false },
    })
    let nextLiked = desiredLike()
    if (trackLikeState.value === 'error' || nextLiked === null) {
      // 每次点击至多重读一次；写入回执失败后也不能沿用可能过期的旧状态。
      const refresh = loadTrackLikeStatus(trackId)
      const refreshOperation = trackLikeOperation
      await refresh
      if (!isCurrentFavoriteContext(trackId, source, nativeMatch, descriptor, refreshOperation)) return
      nextLiked = desiredLike()
      if (trackLikeState.value === 'error') return
    }
    if (nextLiked === null) return
    const operation = ++trackLikeOperation
    trackLikeState.value = 'loading'
    localTrackFavoriteState.value = descriptor ? 'loading' : 'idle'
    try {
      const [neteaseResult, localResult] = await Promise.all([
        hasNeteaseIdentity
          ? api.setTrackLiked(trackId, nextLiked)
          : Promise.resolve(undefined),
        descriptor
          ? api.setFavorite(plainFavoriteDescriptor(descriptor), nextLiked)
          : Promise.resolve(undefined),
      ])
      if (!isCurrentFavoriteContext(trackId, source, nativeMatch, descriptor, operation)) return
      neteaseTrackLiked.value = neteaseResult?.liked ?? null
      if (descriptor) localTrackFavoriteState.value = nextLiked ? 'liked' : 'not-liked'
      trackLikeState.value = nextLiked ? 'liked' : 'not-liked'
      if (isRoonPlayback && hasNeteaseIdentity && descriptor) {
        onToast(nextLiked ? '已同步网易云与本地收藏' : '已取消网易云与本地收藏')
      } else if (isRoonPlayback && hasNeteaseIdentity) {
        onToast(nextLiked ? '已加入网易云喜欢的音乐' : '已取消网易云喜欢')
      } else if (isRoonPlayback) {
        onToast(nextLiked ? '已加入本地收藏' : '已取消本地收藏')
      } else {
        onToast(nextLiked ? '已加入网易云喜欢的音乐' : '已取消网易云喜欢')
      }
    } catch (error) {
      if (!isCurrentFavoriteContext(trackId, source, nativeMatch, descriptor, operation)) return
      trackLikeState.value = 'error'
      if (descriptor) localTrackFavoriteState.value = 'error'
      onError(error)
    }
  }

  function commitPlaybackState(snapshot: PlaybackSnapshot): void {
    if (disposed) return
    const previousSnapshot = playbackState.value
    const previousTrackId = previousSnapshot?.currentTrack?.id
    const wasPlaying = previousSnapshot?.state === 'playing'
    const previousSource = playbackSource.value
    const previousNeteaseMatch = nativeRoonHasNeteaseMatch.value
    const previousDescriptor = localTrackFavoriteDescriptor.value
    const projected = projectPlaybackSnapshot(previousSnapshot, snapshot)
    if (projected !== previousSnapshot) playbackState.value = projected
    if (projected.queue !== previousSnapshot?.queue) {
      for (const item of projected.queue.items) rememberPublishedRoonItem(item)
    }
    const queueItem = projected.queue.items[projected.queue.index]
    // 当前曲目最后登记，完整手动队列超过描述符缓存时仍保留收藏和重播身份。
    rememberPublishedRoonItem(queueItem)
    const nextSource = projected.source ?? queueItem?.resolvedSource
    if (nextSource !== undefined) {
      const sourceChanged = playbackSource.value !== nextSource
      playbackSource.value = nextSource
      if (nextSource === 'roon') {
        const trackId = projected.currentTrack?.id ?? ''
        const localItem = projected.currentTrack
          ? roonQueueDescriptors.get(projected.currentTrack.id)
          : undefined
        const rememberedNeteaseMatch = roonQueueNeteaseMatches.has(trackId)
        const hasNeteaseIdentity = nativeRoonQueueItemHasNeteaseIdentity(queueItem, rememberedNeteaseMatch)
        if (nativeRoonHasNeteaseMatch.value !== hasNeteaseIdentity) nativeRoonHasNeteaseMatch.value = hasNeteaseIdentity
        if (localItem) {
          const descriptor = resolveFavoriteDescriptor(localItem)
          if (!sameFavoriteDescriptor(localTrackFavoriteDescriptor.value, descriptor)) {
            localTrackFavoriteDescriptor.value = descriptor
          }
        } else if (localTrackFavoriteDescriptor.value || localTrackFavoriteState.value !== 'idle') {
          resetLocalTrackFavorite()
        }
        if (sourceChanged) {
          neteaseTrackLiked.value = null
          trackLikeState.value = 'idle'
        }
      } else if (sourceChanged || !projected.currentTrack) {
        nativeRoonHasNeteaseMatch.value = false
        if (localTrackFavoriteDescriptor.value || localTrackFavoriteState.value !== 'idle') resetLocalTrackFavorite()
        neteaseTrackLiked.value = null
      }
    } else if (!projected.currentTrack) {
      playbackSource.value = 'netease'
      nativeRoonHasNeteaseMatch.value = false
      if (localTrackFavoriteDescriptor.value || localTrackFavoriteState.value !== 'idle') resetLocalTrackFavorite()
      neteaseTrackLiked.value = null
    }
    // 队列外 Roon 曲目只有观测身份，不能把它放进会按网易云 ID 再次播放的最近列表。
    const replayableTrack = projected.source !== 'roon' || nativeRoonHasNeteaseMatch.value
      || (projected.currentTrack !== undefined && roonQueueDescriptors.has(projected.currentTrack.id))
    if (projected.state === 'playing' && projected.currentTrack && replayableTrack && (!wasPlaying || previousTrackId !== projected.currentTrack.id)) {
      recentTracks.value = [
        projected.currentTrack,
        ...recentTracks.value.filter((track) => track.id !== projected.currentTrack?.id),
      ].slice(0, 6)
    }
    const trackId = projected.currentTrack?.id
    const identityChanged = trackId !== previousTrackId
      || playbackSource.value !== previousSource
      || nativeRoonHasNeteaseMatch.value !== previousNeteaseMatch
      || !sameFavoriteDescriptor(previousDescriptor, localTrackFavoriteDescriptor.value)
    if (trackId && identityChanged) {
      if (playbackSource.value !== 'roon' || nativeRoonHasNeteaseMatch.value) void loadLyrics(trackId)
      else {
        // 原生 Roon 的歌词由 Core 事件推送；事件可能先于播放快照到达。
        lyricsOperation += 1
      }
      void loadTrackLikeStatus(trackId)
    } else if (!trackId && previousTrackId) {
      lyricsOperation += 1
      lyricsSnapshot.value = emptyLyricsSnapshot()
      trackLikeOperation += 1
      trackLikeState.value = 'idle'
      neteaseTrackLiked.value = null
      if (localTrackFavoriteDescriptor.value || localTrackFavoriteState.value !== 'idle') resetLocalTrackFavorite()
    }
  }

  function clearPendingSeek(): void {
    if (pendingSeek?.timer !== undefined) clearTimeout(pendingSeek.timer)
    pendingSeek = undefined
  }
  function confirmPendingSeek(): void {
    const pending = pendingSeek
    if (!pending) return
    if (!pending.isCurrent()) { clearPendingSeek(); return }
    const observed = stream.snapshot?.positionMs
    if (!pending.acknowledged || observed === undefined || Math.abs(observed - pending.target) > 1000) return
    clearPendingSeek(); pending.settle?.(observed)
  }

  function applyStreamApplication(application: PlaybackStreamApplication | undefined, fromRecovery = false): void {
    if (!application || disposed) return
    if (application.kind === 'full' && !fromRecovery) {
      // 新权威基准已完成恢复：旧读取仍接住回执，但失去回写资格。
      recoveryToken = {}; syncFlight = undefined; automaticAttemptUsed = false
    }
    const owner = application.stamp
    playbackClockIdentity.value = JSON.stringify([owner.coreInstanceId, owner.generation, owner.selectedZoneId, owner.trackId, owner.source])
    if (application.kind === 'progress') {
      // prepare显示独立于权威基准；旧owner进度不能写到乐观新曲上。
      if (optimisticRoonTrackId === undefined && playbackState.value && playbackState.value.positionMs !== application.snapshot.positionMs) {
        playbackState.value = { ...playbackState.value, positionMs: application.snapshot.positionMs }
      }
    } else {
      optimisticRoonTrackId = undefined
      commitPlaybackState(application.snapshot)
    }
    confirmPendingSeek()
  }

  function applyPlaybackState(snapshot: PlaybackSnapshot): void {
    if (disposed) return
    if (streamMode === 'legacy') { commitPlaybackState(snapshot); return }
    if (snapshot.stream) {
      const { stream: stamp, ...value } = snapshot
      applyStreamApplication(stream.full({ stamp, snapshot: value }))
      if (!stream.desynced) playbackSyncStatus.value = 'ready'
    } else stream.markDesynced()
    if (stream.desynced) void synchronizePlayback()
  }

  function applyNeteasePlayback(snapshot: PlaybackSnapshot): void { applyPlaybackState(snapshot) }

  async function synchronizePlayback(explicit = false): Promise<void> {
    if (disposed || playbackSyncStatus.value === 'suspended') return
    if (syncFlight) return syncFlight
    if (explicit) automaticAttemptUsed = false
    if (automaticAttemptUsed) return
    automaticAttemptUsed = true
    const lifecycle = streamLifecycle
    const token = recoveryToken
    playbackSyncStatus.value = 'syncing'
    stream.beginSeed()
    const work = (async () => {
      try {
        const envelope = await api.getPlaybackStreamSnapshot()
        if (disposed || lifecycle !== streamLifecycle || token !== recoveryToken) return
        if (envelope === null) {
          if (streamMode === 'compact') throw new Error('紧凑播放基准缺失，请重试同步。')
          streamMode = 'legacy'
          const value = await api.getPlaybackState()
          if (disposed || lifecycle !== streamLifecycle || token !== recoveryToken) return
          commitPlaybackState(value); playbackSyncStatus.value = 'ready'; automaticAttemptUsed = false
          return
        }
        if (streamMode === 'compact' && envelope.stamp.coreInstanceId !== stream.instance) throw new Error('播放实例已变化，请重试同步。')
        if (streamMode !== 'compact') { streamMode = 'compact'; stream.authorize(envelope.stamp.coreInstanceId, true) }
        applyStreamApplication(stream.endSeed(envelope), true)
        playbackSyncStatus.value = stream.desynced ? 'error' : 'ready'
        if (stream.desynced) onActionMessage('播放状态尚未同步，请重试读取。')
        if (!stream.desynced) automaticAttemptUsed = false
      } catch (error) {
        if (disposed || lifecycle !== streamLifecycle || token !== recoveryToken) return
        stream.failSeed(); playbackSyncStatus.value = 'error'; onError(error)
      }
    })()
    syncFlight = work
    try { await work } finally { if (syncFlight === work) syncFlight = undefined }
  }

  async function initializePlaybackStream(): Promise<void> {
    if (streamMode === 'legacy') { await refreshPlayback(); return }
    await synchronizePlayback()
  }
  async function retryPlaybackSync(): Promise<void> {
    if (streamMode === 'legacy') { await refreshPlayback(); return }
    await synchronizePlayback(true)
  }
  function acceptPlaybackReady(ack?: PlaybackEventProtocolAck): void {
    if (disposed) return
    if (ack && streamMode === 'compact' && stream.instance === ack.coreInstanceId && playbackSyncStatus.value !== 'suspended') return
    ++streamLifecycle; ++seekOperation; clearPendingSeek(); syncFlight = undefined; automaticAttemptUsed = false
    cancelRoonPlaybackPreparation()
    if (!ack) {
      streamMode = 'legacy'; stream.suspend(); playbackClockIdentity.value = undefined; playbackSyncStatus.value = 'syncing'
      const lifecycle = streamLifecycle
      // legacy构造快照可能早于ready；新的可信route仍需一次只读初始事实。
      queueMicrotask(() => { if (!disposed && lifecycle === streamLifecycle) void refreshPlayback() })
      return
    }
    streamMode = 'compact'; stream.authorize(ack.coreInstanceId); playbackSyncStatus.value = 'syncing'
    // Main同步ready+seed先取得完整基准；缺seed才使用唯一自动恢复机会。
    queueMicrotask(() => { if (!disposed && stream.instance === ack.coreInstanceId && stream.desynced) void synchronizePlayback() })
  }
  function suspendPlaybackStream(): void {
    if (disposed) return
    ++streamLifecycle; ++seekOperation; clearPendingSeek(); syncFlight = undefined; automaticAttemptUsed = false
    stream.suspend(); playbackSyncStatus.value = 'suspended'; playbackClockIdentity.value = undefined
    cancelRoonPlaybackPreparation()
  }
  function acceptPlaybackStreamEvent(event: { event: 'playback.snapshot'; payload: PlaybackStreamSnapshot } | { event: 'playback.state'; payload: PlaybackStreamState } | { event: 'playback.progress'; payload: PlaybackStreamProgress }): void {
    if (disposed || playbackSyncStatus.value === 'suspended' || streamMode === 'legacy') return
    if (streamMode === 'unknown') {
      // 暂存不是授权；只有当前Main route的seed/ready才建立instance。
      if (syncFlight) {
        if (event.event === 'playback.snapshot') {
          const { queue, ...state } = event.payload.snapshot
          stream.delta({ kind: 'state', stamp: event.payload.stamp, state, queue })
        } else if (event.event === 'playback.state') stream.delta({ kind: 'state', ...event.payload })
        else stream.delta({ kind: 'progress', ...event.payload })
      }
      return
    }
    if (event.payload.stamp.coreInstanceId !== stream.instance) return
    const application = event.event === 'playback.snapshot' ? stream.full(event.payload)
      : event.event === 'playback.state' ? stream.delta({ kind: 'state', ...event.payload })
      : stream.delta({ kind: 'progress', ...event.payload })
    applyStreamApplication(application)
    if (stream.desynced) void synchronizePlayback()
    else if (application) { playbackSyncStatus.value = 'ready'; automaticAttemptUsed = false }
  }
  async function refreshPlayback(): Promise<void> { await refreshPlaybackWhileCurrent(() => !disposed) }
  async function refreshPlaybackWhileCurrent(isCurrent: () => boolean): Promise<void> {
    if (streamMode !== 'legacy') { if (isCurrent()) await synchronizePlayback(); return }
    const lifecycle = streamLifecycle
    try {
      const snapshot = await api.getPlaybackState()
      if (isCurrent() && lifecycle === streamLifecycle) { commitPlaybackState(snapshot); playbackSyncStatus.value = 'ready' }
    } catch (error) {
      if (isCurrent() && lifecycle === streamLifecycle) {
        if (playbackSyncStatus.value !== 'ready') playbackSyncStatus.value = 'error'
        onError(error)
      }
    }
  }

  function playbackCommandsReady(): boolean {
    if (playbackSyncStatus.value === 'ready') return true
    onActionMessage('播放状态正在同步，请稍候或重试读取。'); return false
  }

  function queueItemsForTracks(tracks: readonly TrackSummary[]): PlaybackQueueRequestItem[] {
    return tracks.map((track) => {
      const match = getMatchResult(track.id)
      const candidate = confirmedRoonCandidate(match)
      if (candidate) rememberRoonQueueDescriptor(track.id, candidate, true)
      return {
        trackId: track.id,
        qualityPreference: getSelectedQuality(),
        preferredSource: queuePreferenceForMatch(match),
      }
    })
  }

  function cloneTrackSummary(track: TrackSummary): TrackSummary {
    return {
      id: track.id,
      title: track.title,
      artists: [...track.artists],
      album: track.album,
      ...(track.durationMs !== undefined ? { durationMs: track.durationMs } : {}),
      ...(track.artworkUrl !== undefined ? { artworkUrl: track.artworkUrl } : {}),
      ...(track.artworkReference !== undefined
        ? { artworkReference: track.artworkReference }
        : {}),
    }
  }

  async function playTrack(track: TrackSummary): Promise<void> {
    if (!playbackCommandsReady()) return
    if (playbackStartPending.value) return
    invalidateCollectionOperation()
    retryStopSource = undefined
    const trace = api.performanceDiagnostics?.begin('playback')
    let traceOutcome: 'ok' | 'error' = 'ok'
    cancelRoonPlaybackPreparation()
    const rendererClickAtMs = Date.now()
    playbackStartPending.value = true
    clearActionError()
    onToast('正在准备')
    try {
      const zoneId = getSelectedZone()?.zoneId
      const cachedMatch = getMatchResult(track.id)
      const pendingMatch = zoneId && !cachedMatch
        ? getPendingMatch(track.id)
        : undefined
      const match = cachedMatch
        ?? (pendingMatch ? await waitForMatchWithinPlaybackBudget(pendingMatch) : undefined)
      const selection = immediatePlaybackSelection(
        match,
        zoneId,
      )
      if (selection.source === 'roon') {
        rememberRoonQueueDescriptor(track.id, selection.candidate, true)
        api.performanceDiagnostics?.use(trace)
        const snapshot = await api.replaceQueue([{
          trackId: track.id,
          qualityPreference: getSelectedQuality(),
          preferredSource: 'smart',
        }], 0)
        applyPlaybackState(snapshot)
        onToast(snapshot.source === 'roon' ? '已使用 Roon 本地版本播放' : '本地版本不可用，已使用网易云播放')
        onEnterNowPlaying()
        return
      }
      api.performanceDiagnostics?.use(trace)
      applyNeteasePlayback(await api.play(track.id, getSelectedQuality(), rendererClickAtMs))
      if (!getMatchResult(track.id)) onMatchTracks([cloneTrackSummary(track)])
      onEnterNowPlaying()
    } catch (error) {
      traceOutcome = 'error'
      onError(error)
    } finally {
      api.performanceDiagnostics?.end(trace, traceOutcome)
      playbackStartPending.value = false
    }
  }

  async function playRoonLibraryTrack(track: RoonLibraryItem): Promise<void> {
    if (!playbackCommandsReady()) return
    if (playbackStartPending.value) return
    const zoneId = getSelectedZone()?.zoneId ?? playbackState.value?.selectedZoneId
    if (!zoneId) {
      if (getZoneLifecycleStatus() === 'loading') {
        onActionMessage('正在读取播放设备，请稍候。')
        return
      }
      onError({ code: 'ROON_ZONE_NOT_SELECTED' })
      return
    }
    const trace = api.performanceDiagnostics?.begin('playback')
    let traceOutcome: 'ok' | 'error' | 'cancelled' = 'ok'
    invalidateCollectionOperation()
    retryStopSource = undefined
    clearActionError()
    playbackStartPending.value = true
    const operation = ++roonPlaybackOperation
    pendingRoonPlaybackOperation = operation
    // 在进入正在播放页面前捕获原浏览上下文，搜索/单曲入口不借用旧专辑。
    const context = getRoonPlaybackContext()
    const roonTrackId = roonTrackIdFromReference(track.reference)
    optimisticRoonTrackId = roonTrackId
    rememberRoonQueueDescriptor(roonTrackId, track)
    commitPlaybackState(createOptimisticRoonPlayback(track, zoneId, getSelectedQuality()))
    onEnterNowPlaying()
    try {
      if (operation !== roonPlaybackOperation || disposed) return
      const handle = options.roonContextPlaybackEnabled !== false
        && context?.page.items.some(item => item.kind === 'track' && item.reference === track.reference)
        ? context.page.playbackContextHandle : undefined
      if (handle !== undefined) {
        for (const item of context!.page.items) {
          if (item.kind === 'track') rememberRoonQueueDescriptor(roonTrackIdFromReference(item.reference), item)
        }
        rememberRoonQueueDescriptor(roonTrackId, track)
        api.performanceDiagnostics?.use(trace)
        // 句柄由Core校验；过期或无效时不能静默降级到另一个队列。
        await api.playRoonTrack(track.reference, zoneId, undefined, handle)
      } else {
        const tracks = await collectRoonPlaybackContext(track, context?.page,
          context ? (page) => { api.performanceDiagnostics?.use(trace); return context.load(context.reference, page) } : undefined,
          () => operation === roonPlaybackOperation)
        if (operation !== roonPlaybackOperation) return
        for (const item of tracks) rememberRoonQueueDescriptor(roonTrackIdFromReference(item.reference), item)
        api.performanceDiagnostics?.use(trace)
        await api.playRoonTrack(track.reference, zoneId, tracks.map((item) => item.reference))
      }
      if (operation !== roonPlaybackOperation) return
      optimisticRoonTrackId = undefined
      await refreshPlaybackWhileCurrent(() => operation === roonPlaybackOperation && !disposed)
    } catch (error) {
      traceOutcome = operation === roonPlaybackOperation ? 'error' : 'cancelled'
      if (operation !== roonPlaybackOperation) return
      optimisticRoonTrackId = undefined
      await refreshPlaybackWhileCurrent(() => operation === roonPlaybackOperation && !disposed)
      if (operation !== roonPlaybackOperation) return
      onError(error)
    } finally {
      api.performanceDiagnostics?.end(trace, operation === roonPlaybackOperation ? traceOutcome : 'cancelled')
      if (pendingRoonPlaybackOperation === operation) {
        pendingRoonPlaybackOperation = undefined
        playbackStartPending.value = false
      }
    }
  }

  async function queueRoonLibraryTrack(track: RoonLibraryItem): Promise<void> {
    if (!playbackCommandsReady()) return
    const zoneId = getSelectedZone()?.zoneId ?? playbackState.value?.selectedZoneId
    if (!zoneId) {
      if (getZoneLifecycleStatus() === 'loading') {
        onActionMessage('正在读取播放设备，请稍候。')
        return
      }
      onError({ code: 'ROON_ZONE_NOT_SELECTED' })
      return
    }
    clearActionError()
    try {
      const roonTrackId = roonTrackIdFromReference(track.reference)
      rememberRoonQueueDescriptor(roonTrackId, track)
      await api.queueRoonTrack(track.reference, zoneId)
      await refreshPlayback()
      onToast('已将 Roon 曲目加入队列')
    } catch (error) {
      onError(error)
    }
  }

  async function appendTrack(track: TrackSummary): Promise<void> {
    if (!playbackCommandsReady()) return
    clearActionError()
    try {
      applyNeteasePlayback(await api.appendQueue(queueItemsForTracks([track])))
      onToast('已加入播放队列')
    } catch (error) {
      onError(error)
    }
  }

  async function insertTrackNext(track: TrackSummary): Promise<void> {
    if (!playbackCommandsReady()) return
    clearActionError()
    try {
      applyNeteasePlayback(await api.insertNext(queueItemsForTracks([track])))
      onToast('将在下一首播放')
    } catch (error) {
      onError(error)
    }
  }

  function invalidateCollectionOperation(): void {
    collectionOperation += 1
    activeCollectionLoader?.cancel()
    activeCollectionLoader = undefined
    collectionPlaybackStartInFlight = false
  }

  async function continueCollectionQueue(
    loader: ProgressiveCollectionLoader,
    operation: number,
    pendingTracks: readonly TrackSummary[] = [],
  ): Promise<void> {
    try {
      if (pendingTracks.length > 0 && operation === collectionOperation) {
        const snapshot = await api.appendQueue(queueItemsForTracks(pendingTracks))
        if (operation !== collectionOperation || disposed) return
        applyPlaybackState(snapshot)
      }
      while (operation === collectionOperation) {
        const batch = await loader.next()
        if (!batch || operation !== collectionOperation) return
        if (batch.tracks.length > 0) {
          const snapshot = await api.appendQueue(queueItemsForTracks(batch.tracks))
          if (operation !== collectionOperation || disposed) return
          applyPlaybackState(snapshot)
        }
        if (!batch.hasMore) return
      }
    } catch (error) {
      // 后续分页失败不能终止已经开始的歌曲；只报告可重试的局部错误。
      if (operation === collectionOperation) onError(error)
    } finally {
      if (activeCollectionLoader === loader) activeCollectionLoader = undefined
    }
  }

  async function replaceAndPlayCollection(
    loadPage: CollectionPageLoader,
    selectedTrackId?: string,
    initialPage?: Page<TrackSummary>,
    openNowPlaying = true,
  ): Promise<void> {
    if (!playbackCommandsReady()) return
    if (collectionPlaybackStartInFlight) return
    invalidateCollectionOperation()
    retryStopSource = undefined
    cancelRoonPlaybackPreparation()
    collectionPlaybackStartInFlight = true
    const operation = ++collectionOperation
    clearActionError()
    const loader = createProgressiveCollectionLoader(loadPage, LIBRARY_PAGE_SIZE, initialPage)
    activeCollectionLoader = loader
    try {
      const firstBatch = await loader.next()
      if (operation !== collectionOperation || !firstBatch || firstBatch.tracks.length === 0) {
        if (operation === collectionOperation) collectionPlaybackStartInFlight = false
        return
      }
      const initial = selectInitialCollectionPlayback(firstBatch.tracks, selectedTrackId)
      const snapshot = await api.replaceQueue(
        queueItemsForTracks(initial.tracks),
        initial.index,
      )
      if (operation !== collectionOperation) return
      applyPlaybackState(snapshot)
      if (openNowPlaying) onEnterNowPlaying()
      collectionPlaybackStartInFlight = false
      if (firstBatch.hasMore) {
        void continueCollectionQueue(loader, operation)
      } else {
        activeCollectionLoader = undefined
      }
    } catch (error) {
      if (operation === collectionOperation) onError(error)
      if (operation === collectionOperation) {
        collectionPlaybackStartInFlight = false
        activeCollectionLoader = undefined
      }
    } finally {
      if (operation === collectionOperation && collectionPlaybackStartInFlight && activeCollectionLoader !== loader) {
        collectionPlaybackStartInFlight = false
      }
    }
  }

  async function appendCollection(loadPage: CollectionPageLoader): Promise<void> {
    if (!playbackCommandsReady()) return
    invalidateCollectionOperation()
    const operation = ++collectionOperation
    clearActionError()
    const loader = createProgressiveCollectionLoader(loadPage, LIBRARY_PAGE_SIZE)
    activeCollectionLoader = loader
    let continuing = false
    try {
      const firstBatch = await loader.next()
      if (operation !== collectionOperation || !firstBatch || firstBatch.tracks.length === 0) return
      const snapshot = await api.appendQueue(queueItemsForTracks(firstBatch.tracks))
      if (operation !== collectionOperation || disposed) return
      applyPlaybackState(snapshot)
      onToast('已加入播放队列')
      if (firstBatch.hasMore) {
        continuing = true
        void continueCollectionQueue(loader, operation)
      }
      else if (activeCollectionLoader === loader) activeCollectionLoader = undefined
    } catch (error) {
      if (operation === collectionOperation) onError(error)
    } finally {
      if (!continuing && operation === collectionOperation && activeCollectionLoader === loader) {
        activeCollectionLoader = undefined
      }
    }
  }

  async function playTracks(tracks: readonly TrackSummary[]): Promise<void> {
    if (!playbackCommandsReady()) return
    if (!tracks.length) return
    invalidateCollectionOperation()
    retryStopSource = undefined
    cancelRoonPlaybackPreparation()
    clearActionError()
    try {
      applyPlaybackState(await api.replaceQueue(queueItemsForTracks(tracks), 0))
      onEnterNowPlaying()
    } catch (error) {
      onError(error)
    }
  }


  async function playQueueItem(_item: PlaybackQueueItem, index: number): Promise<void> {
    if (!playbackCommandsReady()) return
    const items = playbackState.value?.queue.items
    if (!items?.[index]) return
    cancelRoonPlaybackPreparation()
    try {
      applyPlaybackState(await api.playQueueIndex(index))
      onEnterNowPlaying()
    } catch (error) {
      onError(error)
    }
  }

  async function togglePlayback(): Promise<void> {
    if (!playbackCommandsReady()) return
    const snapshot = playbackState.value
    if (!snapshot) return
    if (snapshot.state === 'playing' && snapshot.canPause) {
      try {
        applyPlaybackState(await api.pause())
      } catch (error) {
        onError(error)
      }
      return
    }
    if (snapshot.state === 'paused' && snapshot.canResume) {
      try {
        applyPlaybackState(await api.resume())
      } catch (error) {
        onError(error)
      }
      return
    }
    if (snapshot.state === 'idle' && currentTrack.value) {
      await playTrack(currentTrack.value)
    }
  }

  async function stopPlayback(): Promise<void> {
    if (!playbackCommandsReady()) return
    await stopPlaybackForSource(playbackSource.value)
  }

  async function stopPlaybackForSource(source: 'roon' | 'netease'): Promise<void> {
    invalidateCollectionOperation()
    const operation = collectionOperation
    cancelRoonPlaybackPreparation()
    clearActionError()
    try {
      if (source === 'roon') {
        await api.stopRoonTransport()
        if (operation !== collectionOperation || disposed) return
        await refreshPlaybackWhileCurrent(() => operation === collectionOperation && !disposed)
        retryStopSource = undefined
        return
      }
      const snapshot = await api.stop()
      if (operation !== collectionOperation || disposed) return
      applyNeteasePlayback(snapshot)
      retryStopSource = undefined
    } catch (error) {
      if (operation !== collectionOperation || disposed) return
      retryStopSource = source
      onError(error)
    }
  }

  async function retryLastPlaybackAction(): Promise<void> {
    if (retryStopSource || (playbackState.value?.state === 'error' && playbackState.value.canStop)) {
      await stopPlaybackForSource(retryStopSource ?? playbackSource.value)
      return
    }
    const track = currentTrack.value
    if (track && playbackSource.value === 'roon') {
      const item = roonQueueDescriptors.get(track.id)
      if (item) await playRoonLibraryTrack(item)
      else await refreshPlayback()
    } else if (track) await playTrack(track)
    else await refreshPlayback()
  }

  async function nextTrack(): Promise<void> {
    if (!playbackCommandsReady()) return
    cancelRoonPlaybackPreparation()
    try {
      applyNeteasePlayback(await api.next())
    } catch (error) {
      onError(error)
    }
  }

  async function previousTrack(): Promise<void> {
    if (!playbackCommandsReady()) return
    cancelRoonPlaybackPreparation()
    try {
      applyNeteasePlayback(await api.previous())
    } catch (error) {
      onError(error)
    }
  }

  async function seekPlayback(positionMs: number, settle?: (positionMs?: number) => void): Promise<void> {
    const snapshot = playbackState.value, track = snapshot?.currentTrack
    if (!snapshot || !track || track.durationMs === undefined || getSelectedZone()?.seekAllowed !== true
      || playbackSyncStatus.value !== 'ready') { settle?.(); return }
    clearPendingSeek()
    const operation = ++seekOperation, lifecycle = streamLifecycle, owner = playbackClockIdentity.value
    const zone = getSelectedZone()?.zoneId, source = snapshot.source
    const isCurrent = () => !disposed && operation === seekOperation && lifecycle === streamLifecycle
      && owner === playbackClockIdentity.value && playbackState.value?.currentTrack?.id === track.id
      && playbackState.value?.source === source && getSelectedZone()?.zoneId === zone
    const pending = { target: Math.round(positionMs), acknowledged: false, isCurrent, settle } as NonNullable<typeof pendingSeek>
    if (streamMode === 'compact') pendingSeek = pending
    try {
      const confirmed = await api.seek(pending.target)
      if (!isCurrent()) return
      if (streamMode === 'legacy') settle?.(confirmed.positionMs)
      else {
        pending.acknowledged = true
        // SDK ACK可仍携旧位置；只有已接纳的同owner观测能收起草稿。
        confirmPendingSeek()
        if (pendingSeek === pending) {
          pending.timer = setTimeout(() => {
            if (pendingSeek !== pending) return
            clearPendingSeek()
            if (isCurrent()) { settle?.(); onActionMessage('尚未收到拖动位置确认，请重试。') }
          }, 5000)
          ;(pending.timer as unknown as { unref?: () => void }).unref?.()
        }
      }
      await refreshPlayback()
    } catch (error) {
      if (!isCurrent()) return
      clearPendingSeek(); settle?.(); onError(error); await refreshPlayback()
    }
  }


  function acceptPlaybackEvent(snapshot: PlaybackSnapshot): void {
    if (streamMode !== 'legacy') return
    if (
      optimisticRoonTrackId !== undefined
      && !(snapshot.state === 'playing' && snapshot.source === 'roon'
        && snapshot.currentTrack?.id === optimisticRoonTrackId)
    ) return
    optimisticRoonTrackId = undefined
    applyPlaybackState(snapshot)
  }

  function onLyricsChanged(snapshot: LyricsSnapshot): void {
    if (disposed) return
    lyricsOperation += 1
    lyricsSnapshot.value = snapshot
  }

  function onLocalMatchChanged(snapshot: LocalLyricsMatchSnapshot): void {
    localLyricsMatchRevision += 1
    localLyricsMatchState.value = snapshot
    localLyricsMatchError.value = false
  }

  async function initializeLocalLyricsMatch(): Promise<void> {
    const revision = localLyricsMatchRevision
    try {
      const state = await api.getLocalLyricsMatch()
      if (revision === localLyricsMatchRevision) localLyricsMatchState.value = state
    } catch {
      if (revision === localLyricsMatchRevision) localLyricsMatchState.value = emptyLocalLyricsMatchSnapshot()
    }
  }

  function resetRoonSession(): void {
    retryStopSource = undefined
    invalidateCollectionOperation()
    cancelRoonPlaybackPreparation()
    roonQueueDescriptors.clear()
    roonQueueNeteaseMatches.clear()
    nativeRoonHasNeteaseMatch.value = false
    neteaseTrackLiked.value = null
    trackLikeOperation += 1
    trackLikeState.value = 'idle'
    resetLocalTrackFavorite()
  }

  function dispose(): void {
    suspendPlaybackStream()
    disposed = true
    resetRoonSession()
    invalidateCollectionOperation()
    lyricsOperation += 1
    trackLikeOperation += 1
    localFavoriteOperation += 1
    localLyricsMatchRevision += 1
  }

  return {
    playbackState, playbackStartPending, playbackSource, nativeRoonHasNeteaseMatch,
    lyricsSnapshot, localLyricsMatchState, localLyricsMatchBusy, localLyricsMatchError,
    trackLikeState, neteaseTrackLiked, localTrackFavoriteState, localTrackFavoriteDescriptor,
    currentTrack, recentTracks, applyPlaybackState, acceptPlaybackEvent,
    playbackSyncStatus, playbackViewState, playbackClockIdentity, initializePlaybackStream, retryPlaybackSync, acceptPlaybackReady, acceptPlaybackStreamEvent, suspendPlaybackStream,
    onLyricsChanged, onLocalMatchChanged, initializeLocalLyricsMatch,
    selectLocalLyricsMatch, revokeLocalLyricsMatch, toggleTrackLike, refreshPlayback,
    playTrack, playRoonLibraryTrack, queueRoonLibraryTrack, appendTrack, insertTrackNext,
    replaceAndPlayCollection, appendCollection, playTracks, invalidateCollectionOperation,
    playQueueItem, togglePlayback, stopPlayback, retryLastPlaybackAction, nextTrack, previousTrack, seekPlayback,
    cancelRoonPlaybackPreparation, resetRoonSession, dispose,
  }
}
