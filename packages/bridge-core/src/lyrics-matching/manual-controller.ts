import { randomUUID } from 'node:crypto'
import type {
  LocalLyricsMatchCandidate,
  LocalLyricsMatchSnapshot,
} from '@music-bridge/contracts'
import { BridgeError } from '../shared/errors.js'
import { LYRICS_MATCH_ALGORITHM_VERSION, type LyricsCandidate } from './index.js'
import type { LyricsMatchRepository } from './repository.js'
import type { LyricsResolution } from './resolver.js'
import type { LocalTrackSignature } from './signature.js'

const MATCH_SESSION_TTL_MS = 5 * 60_000
const MAX_MANUAL_CANDIDATES = 20

export interface ManualLyricsContext {
  kind: 'local'
  playbackGeneration: number
  cacheKey: string
  signature: LocalTrackSignature
  manualEligible: boolean
  trustedNeteaseTrackId?: string
}

interface CandidateSession {
  id: string
  signatureKey: string
  playbackGeneration: number
  expiresAt: number
  candidates: Map<string, LyricsCandidate>
}

export interface LocalLyricsManualMatchControllerOptions {
  repository: LyricsMatchRepository
  reload: (context: ManualLyricsContext) => Promise<void>
  now?: () => number
  createId?: (kind: 'session' | 'candidate') => string
  onChange?: (snapshot: LocalLyricsMatchSnapshot) => void
}

function hiddenSnapshot(): LocalLyricsMatchSnapshot {
  return { status: 'hidden', candidates: [], canRevoke: false }
}

function cloneSnapshot(snapshot: LocalLyricsMatchSnapshot): LocalLyricsMatchSnapshot {
  return {
    status: snapshot.status,
    candidates: snapshot.candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      title: candidate.title,
      artists: [...candidate.artists],
      ...(candidate.album === undefined ? {} : { album: candidate.album }),
      ...(candidate.durationMs === undefined ? {} : { durationMs: candidate.durationMs }),
    })),
    canRevoke: snapshot.canRevoke,
    ...(snapshot.matchSessionId === undefined ? {} : { matchSessionId: snapshot.matchSessionId }),
  }
}

function sameContext(left: ManualLyricsContext | undefined, right: ManualLyricsContext): boolean {
  return left?.manualEligible === true
    && left.signature.key === right.signature.key
    && left.playbackGeneration === right.playbackGeneration
}

function displayCandidate(candidateId: string, candidate: LyricsCandidate): LocalLyricsMatchCandidate {
  return {
    candidateId,
    title: candidate.title,
    artists: [...candidate.artists],
    ...(candidate.album === undefined ? {} : { album: candidate.album }),
    ...(candidate.durationMs === undefined ? {} : { durationMs: candidate.durationMs }),
  }
}

export class LocalLyricsManualMatchController {
  private readonly now: () => number
  private readonly createId: (kind: 'session' | 'candidate') => string
  private readonly onChange: (snapshot: LocalLyricsMatchSnapshot) => void
  private activeContext: ManualLyricsContext | undefined
  private session: CandidateSession | undefined
  private mutationInFlight = false
  private snapshot: LocalLyricsMatchSnapshot = hiddenSnapshot()

  constructor(private readonly options: LocalLyricsManualMatchControllerOptions) {
    this.now = options.now ?? (() => Date.now())
    this.createId = options.createId ?? ((kind) => `${kind}-${randomUUID()}`)
    this.onChange = options.onChange ?? (() => undefined)
  }

  getSnapshot(): LocalLyricsMatchSnapshot {
    this.expireSessionIfNeeded()
    return cloneSnapshot(this.snapshot)
  }

  observeContext(context: ManualLyricsContext | undefined): void {
    if (!context?.manualEligible) {
      this.activeContext = undefined
      this.session = undefined
      this.publish(hiddenSnapshot())
      return
    }
    if (!sameContext(this.activeContext, context)) {
      this.activeContext = context
      this.session = undefined
      this.publish({ status: 'searching', candidates: [], canRevoke: false })
    }
  }

  observeResolution(context: ManualLyricsContext, resolution: LyricsResolution): void {
    if (!resolution.applied || !sameContext(this.activeContext, context)) return
    if (resolution.status === 'stale') return
    if (resolution.status === 'error') {
      this.session = undefined
      this.publish({
        status: resolution.errorCode === 'provider-unavailable' || resolution.errorCode === 'auth-expired'
          ? 'provider-unavailable'
          : 'network-error',
        candidates: [],
        canRevoke: false,
      })
      return
    }
    if (resolution.match.state === 'CONFIRMED' || resolution.match.state === 'MANUAL') {
      this.session = undefined
      this.publish({
        status: resolution.status === 'resolved' ? 'matched' : 'no-lyrics',
        candidates: [],
        canRevoke: resolution.errorCode !== 'repository-write',
      })
      return
    }
    if (resolution.match.state === 'POSSIBLE' || resolution.match.state === 'AMBIGUOUS') {
      this.publishCandidates(context, resolution.match.clusters.flatMap((cluster) =>
        cluster.candidates.map((entry) => entry.candidate)))
      return
    }
    this.session = undefined
    this.publish({ status: 'no-match', candidates: [], canRevoke: false })
  }

  async select(matchSessionId: string, candidateId: string): Promise<LocalLyricsMatchSnapshot> {
    this.requireMutationIdle()
    const context = this.requireActiveContext()
    const session = this.session
    if (!session || session.id !== matchSessionId
      || session.signatureKey !== context.signature.key
      || session.playbackGeneration !== context.playbackGeneration) {
      throw new BridgeError('BAD_REQUEST', 'Lyrics match session is not current', { httpStatus: 409 })
    }
    if (session.expiresAt <= this.now()) {
      this.session = undefined
      this.publish({ status: 'no-match', candidates: [], canRevoke: false })
      throw new BridgeError('BAD_REQUEST', 'Lyrics match session expired', { httpStatus: 409 })
    }
    const candidate = session.candidates.get(candidateId)
    if (!candidate) {
      throw new BridgeError('BAD_REQUEST', 'Lyrics candidate is not allowlisted', { httpStatus: 400 })
    }
    this.mutationInFlight = true
    try {
      await this.options.repository.set({
        signature: context.signature,
        neteaseTrackId: candidate.trackId,
        source: 'MANUAL',
        algorithmVersion: LYRICS_MATCH_ALGORITHM_VERSION,
      })
      if (!sameContext(this.activeContext, context)) {
        await this.options.repository.delete(context.signature.key).catch(() => undefined)
        throw new BridgeError('BAD_REQUEST', 'Lyrics match session is no longer current', { httpStatus: 409 })
      }
      this.session = undefined
      this.publish({ status: 'searching', candidates: [], canRevoke: true })
      await this.options.reload(context)
      return this.getSnapshot()
    } finally {
      this.mutationInFlight = false
    }
  }

  async revoke(): Promise<LocalLyricsMatchSnapshot> {
    this.requireMutationIdle()
    const context = this.requireActiveContext()
    this.mutationInFlight = true
    try {
      const record = await this.options.repository.get(context.signature.key, LYRICS_MATCH_ALGORITHM_VERSION)
      if (!sameContext(this.activeContext, context)) {
        throw new BridgeError('BAD_REQUEST', 'Lyrics match session is no longer current', { httpStatus: 409 })
      }
      if (!record) {
        throw new BridgeError('BAD_REQUEST', 'No lyrics match to revoke', { httpStatus: 409 })
      }
      await this.options.repository.delete(context.signature.key)
      if (!sameContext(this.activeContext, context)) {
        throw new BridgeError('BAD_REQUEST', 'Lyrics match session is no longer current', { httpStatus: 409 })
      }
      this.session = undefined
      this.publish({ status: 'searching', candidates: [], canRevoke: false })
      await this.options.reload(context)
      return this.getSnapshot()
    } finally {
      this.mutationInFlight = false
    }
  }

  private requireMutationIdle(): void {
    if (this.mutationInFlight) {
      throw new BridgeError('BAD_REQUEST', 'Lyrics match mutation is already pending', { httpStatus: 409 })
    }
  }

  private publishCandidates(context: ManualLyricsContext, candidates: readonly LyricsCandidate[]): void {
    const members = new Map<string, LyricsCandidate>()
    const display: LocalLyricsMatchCandidate[] = []
    const seenTrackIds = new Set<string>()
    for (const candidate of candidates) {
      if (seenTrackIds.has(candidate.trackId)) continue
      seenTrackIds.add(candidate.trackId)
      const candidateId = this.createId('candidate')
      members.set(candidateId, candidate)
      display.push(displayCandidate(candidateId, candidate))
      if (display.length >= MAX_MANUAL_CANDIDATES) break
    }
    if (display.length === 0) {
      this.session = undefined
      this.publish({ status: 'no-match', candidates: [], canRevoke: false })
      return
    }
    const matchSessionId = this.createId('session')
    this.session = {
      id: matchSessionId,
      signatureKey: context.signature.key,
      playbackGeneration: context.playbackGeneration,
      expiresAt: this.now() + MATCH_SESSION_TTL_MS,
      candidates: members,
    }
    this.publish({
      status: 'needs-choice',
      matchSessionId,
      candidates: display,
      canRevoke: false,
    })
  }

  private requireActiveContext(): ManualLyricsContext {
    if (!this.activeContext?.manualEligible) {
      throw new BridgeError('BAD_REQUEST', 'Local lyrics matching is not available', { httpStatus: 409 })
    }
    return this.activeContext
  }

  private expireSessionIfNeeded(): void {
    if (!this.session || this.session.expiresAt > this.now()) return
    this.session = undefined
    this.publish({ status: 'no-match', candidates: [], canRevoke: false })
  }

  private publish(snapshot: LocalLyricsMatchSnapshot): void {
    const previous = JSON.stringify(this.snapshot)
    this.snapshot = cloneSnapshot(snapshot)
    if (JSON.stringify(this.snapshot) !== previous) this.onChange(cloneSnapshot(this.snapshot))
  }
}
