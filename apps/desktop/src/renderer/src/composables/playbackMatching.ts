import type {
  PlaybackQueueItem,
  PublicTrackMatchResult,
  RoonLibraryItem,
  TrackSummary,
} from '@music-bridge/contracts'

const MAX_MATCH_CONCURRENCY = 8
export const SMART_MATCH_PRELOAD_LIMIT = 8
export const SMART_MATCH_CLICK_WAIT_MS = 300
export const SMART_MATCH_REQUEST_CONCURRENCY = 2

export function tracksForInitialMatching(
  tracks: readonly TrackSummary[],
): readonly TrackSummary[] {
  return tracks.slice(0, SMART_MATCH_PRELOAD_LIMIT)
}

export function shouldPreloadSmartMatches(
  zoneId: string | undefined,
  visible = true,
): boolean {
  return visible && typeof zoneId === 'string' && zoneId.length > 0
}

export function waitForMatchWithinPlaybackBudget(
  pending: Promise<PublicTrackMatchResult>,
  timeoutMs = SMART_MATCH_CLICK_WAIT_MS,
): Promise<PublicTrackMatchResult | undefined> {
  const budget = Number.isFinite(timeoutMs)
    ? Math.min(SMART_MATCH_CLICK_WAIT_MS, Math.max(0, timeoutMs))
    : SMART_MATCH_CLICK_WAIT_MS
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: PublicTrackMatchResult | undefined): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => finish(undefined), budget)
    pending.then(finish, () => finish(undefined))
  })
}

/**
 * Smart Match 的 Main IPC 只接收 Provider TrackSummary 合同字段。
 * 推荐理由和 Roon 运行期图片引用属于展示层扩展，不能穿过严格 IPC 边界。
 */
export function trackSummaryForMatching(track: TrackSummary): TrackSummary {
  return {
    id: track.id,
    title: track.title,
    artists: [...track.artists],
    album: track.album,
    ...(track.durationMs !== undefined ? { durationMs: track.durationMs } : {}),
    ...(track.artworkUrl !== undefined ? { artworkUrl: track.artworkUrl } : {}),
  }
}

export interface MatchRequestScheduler<Input, Output> {
  schedule(input: Input): Promise<Output>
  cancelPending(): void
}

/**
 * 所有页面共用同一个 Roon Browse 并发上限。切换页面时只取消尚未发往
 * Main IPC 的排队项；已经开始的正式请求自行收尾，避免悬空响应。
 */
export function createMatchRequestScheduler<Input, Output>(
  worker: (input: Input) => Promise<Output>,
  concurrency: number,
): MatchRequestScheduler<Input, Output> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > MAX_MATCH_CONCURRENCY) {
    throw new TypeError('Matching concurrency is invalid')
  }
  type Entry = {
    input: Input
    resolve: (value: Output) => void
    reject: (reason: unknown) => void
  }
  let active = 0
  let pending: Entry[] = []

  const pump = (): void => {
    while (active < concurrency && pending.length > 0) {
      const entry = pending.shift()
      if (!entry) return
      active += 1
      void (async () => {
        try {
          entry.resolve(await worker(entry.input))
        } catch (error) {
          entry.reject(error)
        } finally {
          active -= 1
          pump()
        }
      })()
    }
  }

  return {
    schedule(input) {
      return new Promise<Output>((resolve, reject) => {
        pending.push({ input, resolve, reject })
        pump()
      })
    },
    cancelPending() {
      const cancelled = pending
      pending = []
      for (const entry of cancelled) {
        entry.reject(new Error('Smart matching request was superseded'))
      }
    },
  }
}

export async function settledMapWithConcurrency<Input, Output>(
  items: readonly Input[],
  concurrency: number,
  worker: (item: Input, index: number) => Promise<Output>,
): Promise<PromiseSettledResult<Output>[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > MAX_MATCH_CONCURRENCY) {
    throw new TypeError('Matching concurrency is invalid')
  }
  const results = new Array<PromiseSettledResult<Output>>(items.length)
  let nextIndex = 0
  const run = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      const item = items[index]
      if (item === undefined) continue
      try {
        results[index] = { status: 'fulfilled', value: await worker(item, index) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => run()),
  )
  return results
}

export type ImmediatePlaybackSelection =
  | { source: 'netease' }
  | { source: 'roon'; candidate: RoonLibraryItem; zoneId: string }

export function confirmedRoonCandidate(
  match: PublicTrackMatchResult | undefined,
): RoonLibraryItem | undefined {
  return match?.state === 'CONFIRMED' && match.candidate?.kind === 'track'
    ? match.candidate
    : undefined
}

export function nativeRoonQueueItemHasNeteaseIdentity(
  item: PlaybackQueueItem | undefined,
  rememberedMatch: boolean,
): boolean {
  return item?.preferredSource === 'smart' || rememberedMatch
}

/**
 * V1 的立即播放是底线：只有已经缓存的确认匹配才能在点击时选择 Roon，
 * 未知或不确定匹配都先走 Provider，不在当前曲目中途换源。
 */
export function immediatePlaybackSelection(
  match: PublicTrackMatchResult | undefined,
  zoneId: string | undefined,
): ImmediatePlaybackSelection {
  const candidate = confirmedRoonCandidate(match)
  return candidate && zoneId
    ? { source: 'roon', candidate, zoneId }
    : { source: 'netease' }
}

export function queuePreferenceForMatch(
  match: PublicTrackMatchResult | undefined,
): 'smart' | 'netease' {
  return confirmedRoonCandidate(match) ? 'smart' : 'netease'
}
