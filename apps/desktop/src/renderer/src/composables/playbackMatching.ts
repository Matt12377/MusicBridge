import type {
  PlaybackQueueItem,
  PublicTrackMatchResult,
  RoonLibraryItem,
} from '@music-bridge/contracts'

const MAX_MATCH_CONCURRENCY = 8

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
