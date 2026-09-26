import { computed, ref, shallowRef } from 'vue'
import { roonTrackIdFromReference } from '@music-bridge/contracts'
import type {
  FavoriteEntityDescriptor, LocalLyricsMatchSnapshot, LyricsSnapshot, Page, PageRequest,
  PlaybackQualityPreference, PlaybackQueueItem, PlaybackQueueRequestItem, PlaybackSnapshot,
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
  const recentTracks = ref<readonly TrackSummary[]>([])

  let lyricsOperation = 0
  let trackLikeOperation = 0
  let localFavoriteOperation = 0
  let collectionOperation = 0
  let roonPlaybackOperation = 0
  let optimisticRoonTrackId: string | undefined

  function cancelRoonPlaybackPreparation(): void {
    ++roonPlaybackOperation
    optimisticRoonTrackId = undefined
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

  function applyPlaybackState(snapshot: PlaybackSnapshot): void {
    if (disposed) return
    const previousSnapshot = playbackState.value
    const previousTrackId = previousSnapshot?.currentTrack?.id
    const wasPlaying = previousSnapshot?.state === 'playing'
    const previousSource = playbackSource.value
    const previousNeteaseMatch = nativeRoonHasNeteaseMatch.value
    const previousDescriptor = localTrackFavoriteDescriptor.value
    const projected = projectPlaybackSnapshot(previousSnapshot, snapshot)
    if (projected !== previousSnapshot) playbackState.value = projected
    const queueItem = projected.queue.items[projected.queue.index]
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

  function applyNeteasePlayback(snapshot: PlaybackSnapshot): void {
    applyPlaybackState(snapshot)
  }

  async function refreshPlayback(): Promise<void> {
    try {
      applyPlaybackState(await api.getPlaybackState())
    } catch (error) {
      onError(error)
    }
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
    if (playbackStartPending.value) return
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
      applyNeteasePlayback(await api.play(track.id, getSelectedQuality(), rendererClickAtMs))
      if (!getMatchResult(track.id)) onMatchTracks([cloneTrackSummary(track)])
      onEnterNowPlaying()
    } catch (error) {
      onError(error)
    } finally {
      playbackStartPending.value = false
    }
  }

  async function playRoonLibraryTrack(track: RoonLibraryItem): Promise<void> {
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
    clearActionError()
    playbackStartPending.value = true
    const operation = ++roonPlaybackOperation
    // 在进入正在播放页面前捕获原浏览上下文，搜索/单曲入口不借用旧专辑。
    const context = getRoonPlaybackContext()
    const roonTrackId = roonTrackIdFromReference(track.reference)
    optimisticRoonTrackId = roonTrackId
    rememberRoonQueueDescriptor(roonTrackId, track)
    applyPlaybackState(createOptimisticRoonPlayback(track, zoneId, getSelectedQuality()))
    onEnterNowPlaying()
    try {
      const tracks = await collectRoonPlaybackContext(track, context?.page,
        context ? (page) => context.load(context.reference, page) : undefined,
        () => operation === roonPlaybackOperation)
      if (operation !== roonPlaybackOperation) return
      for (const item of tracks) rememberRoonQueueDescriptor(roonTrackIdFromReference(item.reference), item)
      await api.playRoonTrack(track.reference, zoneId, tracks.map((item) => item.reference))
      if (operation !== roonPlaybackOperation) return
      optimisticRoonTrackId = undefined
      applyPlaybackState(await api.getPlaybackState())
    } catch (error) {
      if (operation !== roonPlaybackOperation) return
      optimisticRoonTrackId = undefined
      await refreshPlayback()
      if (operation !== roonPlaybackOperation) return
      onError(error)
    } finally {
      playbackStartPending.value = false
    }
  }

  async function queueRoonLibraryTrack(track: RoonLibraryItem): Promise<void> {
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
      applyPlaybackState(await api.getPlaybackState())
      onToast('已将 Roon 曲目加入队列')
    } catch (error) {
      onError(error)
    }
  }

  async function appendTrack(track: TrackSummary): Promise<void> {
    clearActionError()
    try {
      applyNeteasePlayback(await api.appendQueue(queueItemsForTracks([track])))
      onToast('已加入播放队列')
    } catch (error) {
      onError(error)
    }
  }

  async function insertTrackNext(track: TrackSummary): Promise<void> {
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
        applyPlaybackState(await api.appendQueue(queueItemsForTracks(pendingTracks)))
      }
      while (operation === collectionOperation) {
        const batch = await loader.next()
        if (!batch || operation !== collectionOperation) return
        if (batch.tracks.length > 0) {
          applyPlaybackState(await api.appendQueue(queueItemsForTracks(batch.tracks)))
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
    if (collectionPlaybackStartInFlight || activeCollectionLoader) return
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
    const operation = ++collectionOperation
    activeCollectionLoader?.cancel()
    clearActionError()
    const loader = createProgressiveCollectionLoader(loadPage, LIBRARY_PAGE_SIZE)
    activeCollectionLoader = loader
    try {
      const firstBatch = await loader.next()
      if (operation !== collectionOperation || !firstBatch || firstBatch.tracks.length === 0) return
      applyPlaybackState(await api.appendQueue(queueItemsForTracks(firstBatch.tracks)))
      onToast('已加入播放队列')
      if (firstBatch.hasMore) void continueCollectionQueue(loader, operation)
    } catch (error) {
      if (operation === collectionOperation) onError(error)
    }
  }

  async function playTracks(tracks: readonly TrackSummary[]): Promise<void> {
    if (!tracks.length) return
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
    cancelRoonPlaybackPreparation()
    try {
      if (playbackSource.value === 'roon') {
        await api.stopRoonTransport()
        await refreshPlayback()
        return
      }
      applyNeteasePlayback(await api.stop())
    } catch (error) {
      onError(error)
    }
  }

  async function nextTrack(): Promise<void> {
    cancelRoonPlaybackPreparation()
    try {
      applyNeteasePlayback(await api.next())
    } catch (error) {
      onError(error)
    }
  }

  async function previousTrack(): Promise<void> {
    cancelRoonPlaybackPreparation()
    try {
      applyNeteasePlayback(await api.previous())
    } catch (error) {
      onError(error)
    }
  }

  async function seekPlayback(positionMs: number, settle?: (positionMs?: number) => void): Promise<void> {
    const snapshot = playbackState.value
    const currentTrack = snapshot?.currentTrack
    if (
      !snapshot ||
      !currentTrack ||
      currentTrack.durationMs === undefined ||
      getSelectedZone()?.seekAllowed !== true
    ) { settle?.(); return }
    try {
      const confirmed = await api.seek(Math.round(positionMs))
      settle?.(confirmed.positionMs)
      await refreshPlayback()
    } catch (error) {
      settle?.()
      onError(error)
      await refreshPlayback()
    }
  }


  function acceptPlaybackEvent(snapshot: PlaybackSnapshot): void {
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
    onLyricsChanged, onLocalMatchChanged, initializeLocalLyricsMatch,
    selectLocalLyricsMatch, revokeLocalLyricsMatch, toggleTrackLike, refreshPlayback,
    playTrack, playRoonLibraryTrack, queueRoonLibraryTrack, appendTrack, insertTrackNext,
    replaceAndPlayCollection, appendCollection, playTracks, invalidateCollectionOperation,
    playQueueItem, togglePlayback, stopPlayback, nextTrack, previousTrack, seekPlayback,
    cancelRoonPlaybackPreparation, resetRoonSession, dispose,
  }
}
