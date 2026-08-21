import { randomUUID } from 'node:crypto'

export type QrLoginStatus =
  | 'idle'
  | 'creating'
  | 'waiting'
  | 'scanned'
  | 'authorized'
  | 'expired'
  | 'cancelled'
  | 'error'

export interface PublicQrLoginState {
  status: QrLoginStatus
  challengeId?: string
  qrImage?: string
  expiresAt?: number
}

export interface QrLoginCheckResult {
  code: number
  credential?: string
}

export interface QrLoginProvider {
  createQr(): Promise<{ key: string; qrImage: string }>
  checkQr(key: string): Promise<QrLoginCheckResult>
  verifyCredential(credential: string): Promise<boolean>
  logout(): Promise<void>
}

export interface QrLoginMachineOptions {
  now?: () => number
  challengeId?: () => string
  ttlMs?: number
}

interface ActiveChallenge {
  generation: number
  challengeId: string
  key: string
  qrImage: string
  expiresAt: number
  cancelled: boolean
  terminal: boolean
  pollPromise?: Promise<QrLoginPollResult>
}

export interface QrLoginPollResult {
  state: PublicQrLoginState
  credential?: string
}

function publicState(state: PublicQrLoginState): PublicQrLoginState {
  return { ...state }
}

function isUsableQrImage(value: string): boolean {
  return value.length > 0 && value.length <= 2 * 1024 * 1024 && value.startsWith('data:image/')
}

export class QrLoginStateMachine {
  private readonly now: () => number
  private readonly createChallengeId: () => string
  private readonly ttlMs: number
  private active: ActiveChallenge | undefined
  private generation = 0
  private state: PublicQrLoginState = { status: 'idle' }

  constructor(
    private readonly provider: QrLoginProvider,
    options: QrLoginMachineOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.createChallengeId = options.challengeId ?? randomUUID
    this.ttlMs = options.ttlMs ?? 180_000
  }

  getState(): PublicQrLoginState {
    return publicState(this.state)
  }

  async begin(): Promise<PublicQrLoginState> {
    const generation = this.generation + 1
    this.generation = generation
    this.active = undefined
    this.state = { status: 'creating' }

    try {
      const qr = await this.provider.createQr()
      if (
        generation !== this.generation ||
        qr.key.trim().length === 0 ||
        !isUsableQrImage(qr.qrImage)
      ) {
        this.state = { status: 'error' }
        return this.getState()
      }
      const challengeId = this.createChallengeId()
      const expiresAt = this.now() + this.ttlMs
      this.active = {
        generation,
        challengeId,
        key: qr.key,
        qrImage: qr.qrImage,
        expiresAt,
        cancelled: false,
        terminal: false,
      }
      this.state = { status: 'waiting', challengeId, qrImage: qr.qrImage, expiresAt }
      return this.getState()
    } catch {
      if (generation === this.generation) {
        this.active = undefined
        this.state = { status: 'error' }
      }
      return this.getState()
    }
  }

  async poll(challengeId: string): Promise<QrLoginPollResult> {
    const active = this.active
    if (!active || active.challengeId !== challengeId) {
      return { state: this.getState() }
    }
    if (active.cancelled || active.terminal) {
      return { state: this.getState() }
    }
    if (this.now() >= active.expiresAt) {
      active.terminal = true
      this.state = { status: 'expired' }
      return { state: this.getState() }
    }
    if (active.pollPromise) return active.pollPromise

    const pending = this.pollActive(active)
    active.pollPromise = pending
    try {
      return await pending
    } finally {
      if (this.active === active) delete active.pollPromise
    }
  }

  cancel(challengeId: string): PublicQrLoginState {
    const active = this.active
    if (!active || active.challengeId !== challengeId || active.terminal) {
      return this.getState()
    }
    active.cancelled = true
    active.terminal = true
    this.state = { status: 'cancelled' }
    return this.getState()
  }

  async logout(): Promise<PublicQrLoginState> {
    this.generation += 1
    if (this.active) {
      this.active.cancelled = true
      this.active.terminal = true
    }
    this.active = undefined
    try {
      await this.provider.logout()
      this.state = { status: 'idle' }
    } catch {
      this.state = { status: 'error' }
    }
    return this.getState()
  }

  markAuthorized(): PublicQrLoginState {
    this.active = undefined
    this.generation += 1
    this.state = { status: 'authorized' }
    return this.getState()
  }

  markMissing(): PublicQrLoginState {
    this.active = undefined
    this.generation += 1
    this.state = { status: 'idle' }
    return this.getState()
  }

  markExpired(): PublicQrLoginState {
    this.active = undefined
    this.generation += 1
    this.state = { status: 'expired' }
    return this.getState()
  }

  private async pollActive(active: ActiveChallenge): Promise<QrLoginPollResult> {
    let result: QrLoginCheckResult
    try {
      result = await this.provider.checkQr(active.key)
    } catch {
      if (active.cancelled || this.active !== active) return { state: { status: 'cancelled' } }
      active.terminal = true
      this.state = { status: 'error' }
      return { state: this.getState() }
    }

    if (active.cancelled || this.active !== active) {
      return { state: { status: 'cancelled' } }
    }
    if (this.now() >= active.expiresAt) {
      active.terminal = true
      this.state = { status: 'expired' }
      return { state: this.getState() }
    }

    switch (result.code) {
      case 800:
        active.terminal = true
        this.state = { status: 'expired' }
        return { state: this.getState() }
      case 801:
        this.state = {
          status: 'waiting',
          challengeId: active.challengeId,
          qrImage: active.qrImage,
          expiresAt: active.expiresAt,
        }
        return { state: this.getState() }
      case 802:
        this.state = {
          status: 'scanned',
          challengeId: active.challengeId,
          qrImage: active.qrImage,
          expiresAt: active.expiresAt,
        }
        return { state: this.getState() }
      case 803:
        return this.authorize(active, result.credential)
      default:
        active.terminal = true
        this.state = { status: 'error' }
        return { state: this.getState() }
    }
  }

  private async authorize(
    active: ActiveChallenge,
    credential: string | undefined,
  ): Promise<QrLoginPollResult> {
    if (
      !credential ||
      credential.trim().length === 0 ||
      credential.length > 64 * 1024 ||
      /[\r\n]/.test(credential)
    ) {
      active.terminal = true
      this.state = { status: 'error' }
      return { state: this.getState() }
    }

    let verified = false
    try {
      verified = await this.provider.verifyCredential(credential)
    } catch {
      verified = false
    }
    if (active.cancelled || this.active !== active) {
      return { state: { status: 'cancelled' } }
    }
    if (!verified) {
      active.terminal = true
      this.state = { status: 'error' }
      return { state: this.getState() }
    }

    active.terminal = true
    this.state = { status: 'authorized' }
    return { state: this.getState(), credential }
  }
}
