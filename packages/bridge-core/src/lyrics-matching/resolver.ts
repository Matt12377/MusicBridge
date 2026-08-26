import type { LyricsSnapshot, Page, PageRequest, TrackSummary } from '@music-bridge/contracts'
import { BridgeError } from '../shared/errors.js'
import { emptyLyricsSnapshot } from '../netease/lyrics.js'
import { toUniqueLyricsCandidates } from './candidate-cluster.js'
import {
  LYRICS_MATCH_ALGORITHM_VERSION,
  lyricsMatchResultBrand,
  matchLyricsRecording,
  type LyricsCandidate,
  type LyricsMatchResult,
  type LyricsMatchState,
  type LyricsRecordingIdentity,
} from './index.js'
import type { LyricsMatchRepository, PersistedLyricsMatchRecord } from './repository.js'
import type { LocalTrackSignature } from './signature.js'

export interface LyricsResolverProvider {
  readonly configured: boolean
  searchTracks(query: string, page: PageRequest): Promise<Page<TrackSummary>>
  getLyrics(trackId: string): Promise<LyricsSnapshot>
}

export type LyricsResolutionStatus = 'resolved' | 'unavailable' | 'error' | 'stale'

export interface LyricsResolution {
  status: LyricsResolutionStatus
  match: LyricsMatchResult
  lyrics?: LyricsSnapshot
  neteaseTrackId?: string
  applied: boolean
  errorCode?: 'provider-unavailable' | 'auth-expired' | 'network' | 'repository-write' | 'invalid-request'
}

export interface ActiveLyricsResolutionRequest {
  signature: LocalTrackSignature
  playbackGeneration: number
  trustedNeteaseTrackId?: string
}

function identityOf(signature: LocalTrackSignature): LyricsRecordingIdentity {
  const value = signature.canonical
  return {
    title: value.title,
    artists: value.artists,
    ...(value.album === null ? {} : { album: value.album }),
    ...(value.durationMs === null ? {} : { durationMs: value.durationMs }),
    ...(value.version === null ? {} : { version: value.version }),
  }
}

function candidateOf(signature: LocalTrackSignature, trackId: string): LyricsCandidate {
  return { trackId, ...identityOf(signature) }
}

function linkedMatch(
  signature: LocalTrackSignature,
  trackId: string,
  state: Extract<LyricsMatchState, 'CONFIRMED' | 'MANUAL'>,
  evidence: string,
): LyricsMatchResult {
  const candidate = candidateOf(signature, trackId)
  const scored = { candidate, score: 1, evidence: [evidence] }
  return {
    [lyricsMatchResultBrand]: true,
    state,
    algorithmVersion: LYRICS_MATCH_ALGORITHM_VERSION,
    evidence: [evidence],
    candidates: [scored],
    clusters: [{ key: `${evidence}:${trackId}`, score: 1, evidence: [evidence], candidates: [scored] }],
    candidate,
  }
}

function repositoryMatch(signature: LocalTrackSignature, record: PersistedLyricsMatchRecord): LyricsMatchResult {
  return linkedMatch(signature, record.neteaseTrackId, record.source, `repository-${record.source.toLowerCase()}`)
}

function boundedErrorCode(error: unknown): NonNullable<LyricsResolution['errorCode']> {
  if (error instanceof BridgeError && error.code === 'AUTH_EXPIRED') return 'auth-expired'
  if (error instanceof BridgeError && error.code === 'NETEASE_NOT_CONFIGURED') return 'provider-unavailable'
  return 'network'
}

export class LyricsMatchResolver {
  private static readonly NEGATIVE_CACHE_TTL_MS = 30_000
  private resolverGeneration = 0
  private activeKey: string | undefined
  private activePromise: Promise<LyricsResolution> | undefined
  private readonly onActiveResult: (result: LyricsResolution) => void
  private readonly now: () => number
  private readonly negativeCache = new Map<string, { expiresAt: number; result: LyricsResolution }>()

  constructor(private readonly options: {
    provider: LyricsResolverProvider
    repository: LyricsMatchRepository
    onActiveResult?: (result: LyricsResolution) => void
    now?: () => number
  }) {
    this.onActiveResult = options.onActiveResult ?? (() => undefined)
    this.now = options.now ?? (() => Date.now())
  }

  resolveActive(request: ActiveLyricsResolutionRequest): Promise<LyricsResolution> {
    const requestKey = [request.playbackGeneration, request.signature.key, request.trustedNeteaseTrackId ?? ''].join(':')
    if (this.activeKey === requestKey && this.activePromise) return this.activePromise
    const generation = ++this.resolverGeneration
    this.activeKey = requestKey
    const promise = this.resolve(request).then((resolved) => {
      const current = generation === this.resolverGeneration && this.activeKey === requestKey
      if (!current) return { ...resolved, status: 'stale' as const, applied: false }
      const applied = { ...resolved, applied: true }
      try { this.onActiveResult(applied) } catch { /* observer failure cannot change resolution */ }
      return applied
    })
    this.activePromise = promise
    void promise.then(() => {
      if (generation === this.resolverGeneration) this.activePromise = undefined
    }, () => {
      if (generation === this.resolverGeneration) this.activePromise = undefined
    })
    return promise
  }

  async prefetch(signatures: readonly LocalTrackSignature[]): Promise<void> {
    const queue = [...signatures.slice(0, 2)]
    await Promise.all(Array.from({ length: Math.min(2, queue.length) }, async () => {
      while (queue.length > 0) {
        const signature = queue.shift()
        if (signature) await this.resolve({ signature, playbackGeneration: -1 })
      }
    }))
  }

  cancelActive(): void {
    this.resolverGeneration += 1
    this.activeKey = undefined
    this.activePromise = undefined
  }

  private async resolve(request: ActiveLyricsResolutionRequest): Promise<LyricsResolution> {
    const none = () => matchLyricsRecording(identityOf(request.signature), [])
    if (!this.options.provider.configured) {
      return { status: 'error', match: none(), lyrics: emptyLyricsSnapshot('error'), applied: false, errorCode: 'provider-unavailable' }
    }
    try {
      if (request.trustedNeteaseTrackId) {
        if (!/^[1-9][0-9]{0,19}$/u.test(request.trustedNeteaseTrackId)) {
          return {
            status: 'error', match: none(), lyrics: emptyLyricsSnapshot('error'),
            applied: false, errorCode: 'invalid-request',
          }
        }
        const match = linkedMatch(request.signature, request.trustedNeteaseTrackId, 'CONFIRMED', 'trusted-netease-link')
        return this.loadConfirmed(request.signature, request.trustedNeteaseTrackId, match, true)
      }
      const stored = await this.options.repository.get(request.signature.key, LYRICS_MATCH_ALGORITHM_VERSION)
      if (stored) {
        await this.options.repository.touch(request.signature.key).catch(() => undefined)
        return this.loadConfirmed(request.signature, stored.neteaseTrackId, repositoryMatch(request.signature, stored), false)
      }
      const cached = this.negativeCache.get(request.signature.key)
      if (cached && cached.expiresAt > this.now()) return { ...cached.result, applied: false }
      if (cached) this.negativeCache.delete(request.signature.key)
      const identity = identityOf(request.signature)
      const primaryArtist = identity.artists[0] ?? ''
      const tracks: TrackSummary[] = []
      const first = await this.options.provider.searchTracks(`${identity.title} ${primaryArtist}`.trim(), { offset: 0, limit: 20 })
      tracks.push(...first.items.slice(0, 20))
      let match = matchLyricsRecording(identity, toUniqueLyricsCandidates(tracks))
      if (match.state !== 'CONFIRMED' && identity.album) {
        const second = await this.options.provider.searchTracks(
          `${identity.title} ${primaryArtist} ${identity.album}`.trim(),
          { offset: 0, limit: 20 },
        )
        tracks.push(...second.items.slice(0, 20))
        match = matchLyricsRecording(identity, toUniqueLyricsCandidates(tracks))
      }
      if (match.state !== 'CONFIRMED' || !match.candidate) {
        const unavailable: LyricsResolution = {
          status: 'unavailable', match, lyrics: emptyLyricsSnapshot('unavailable'), applied: false,
        }
        this.writeNegative(request.signature.key, unavailable)
        return unavailable
      }
      return this.loadConfirmed(request.signature, match.candidate.trackId, match, true)
    } catch (error) {
      const failed: LyricsResolution = {
        status: 'error', match: none(), lyrics: emptyLyricsSnapshot('error'), applied: false, errorCode: boundedErrorCode(error),
      }
      this.writeNegative(request.signature.key, failed)
      return failed
    }
  }

  private async loadConfirmed(
    signature: LocalTrackSignature,
    trackId: string,
    match: LyricsMatchResult,
    persist: boolean,
  ): Promise<LyricsResolution> {
    let repositoryWriteFailed = false
    if (persist) {
      await this.options.repository.set({
        signature,
        neteaseTrackId: trackId,
        source: 'CONFIRMED',
        algorithmVersion: LYRICS_MATCH_ALGORITHM_VERSION,
      }).catch(() => { repositoryWriteFailed = true })
    }
    try {
      const lyrics = await this.options.provider.getLyrics(trackId)
      const status = lyrics.status === 'ready' || lyrics.status === 'instrumental' ? 'resolved' : 'unavailable'
      return {
        status,
        match,
        lyrics,
        neteaseTrackId: trackId,
        applied: false,
        ...(repositoryWriteFailed ? { errorCode: 'repository-write' as const } : {}),
      }
    } catch (error) {
      return {
        status: 'error',
        match,
        lyrics: emptyLyricsSnapshot('error'),
        neteaseTrackId: trackId,
        applied: false,
        errorCode: repositoryWriteFailed ? 'repository-write' : boundedErrorCode(error),
      }
    }
  }

  private writeNegative(signatureKey: string, result: LyricsResolution): void {
    this.negativeCache.delete(signatureKey)
    this.negativeCache.set(signatureKey, {
      expiresAt: this.now() + LyricsMatchResolver.NEGATIVE_CACHE_TTL_MS,
      result: { ...result, applied: false },
    })
    while (this.negativeCache.size > 128) {
      const oldest = this.negativeCache.keys().next().value
      if (oldest === undefined) break
      this.negativeCache.delete(oldest)
    }
  }
}
