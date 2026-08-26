import type { RoonPlaybackObservation } from './types.js'
import { BridgeError } from '../shared/errors.js'

function normalizedTrackIdentity(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLocaleLowerCase('en-US')
    .replace(
      /^(?:\d{1,3}\s*[-–—]\s*\d{1,3}|\d{1,3}\s*(?:[.．、:：)]|[-–—]))\s+/u,
      '',
    )
}

export function confirmRoonTrackActionAfterExactMatchFailure(options: {
  zoneId: string
  afterRevision: number
  expectedTrack: { title: string }
  latest?: RoonPlaybackObservation
  actionOutcome: 'accepted' | 'confirmation-required' | void
  exactMatchError: unknown
}): RoonPlaybackObservation {
  const latest = options.latest
  if (
    latest?.zoneId === options.zoneId
    && latest.revision > options.afterRevision
    && latest.state === 'playing'
    && latest.nowPlaying?.title !== undefined
    && normalizedTrackIdentity(latest.nowPlaying.title)
      === normalizedTrackIdentity(options.expectedTrack.title)
  ) {
    return latest
  }
  if (options.actionOutcome === 'confirmation-required') {
    throw new BridgeError('ROON_TIMEOUT', 'Roon track action could not be confirmed', {
      httpStatus: 502,
      cause: options.exactMatchError,
      details: { stage: 'post-action-confirmation' },
    })
  }
  throw options.exactMatchError
}
