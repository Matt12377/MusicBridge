import assert from 'node:assert/strict'
import test from 'node:test'

import { NeteaseClient } from '../src/netease/client.js'
import {
  QrLoginStateMachine,
  type QrLoginProvider,
} from '../src/netease/qr-login.js'

function makeProvider(): QrLoginProvider & {
  checks: number[]
  verifyCalls: string[]
  logoutCalls: number
  nextCheck: () => Promise<{ code: number; credential?: string }>
} {
  const checks: number[] = []
  const verifyCalls: string[] = []
  let logoutCalls = 0
  let nextCheck: () => Promise<{ code: number; credential?: string }> = async () => ({ code: 801 })
  return {
    checks,
    verifyCalls,
    get logoutCalls() {
      return logoutCalls
    },
    set nextCheck(value: () => Promise<{ code: number; credential?: string }>) {
      nextCheck = value
    },
    async createQr() {
      return {
        key: 'provider-key-hidden-from-public-state',
        qrImage: 'data:image/png;base64,synthetic-qr',
      }
    },
    async checkQr(key: string) {
      assert.equal(key, 'provider-key-hidden-from-public-state')
      checks.push(checks.length + 1)
      return nextCheck()
    },
    async verifyCredential(credential: string) {
      verifyCalls.push(credential)
      return credential === 'fixture-credential'
    },
    async logout() {
      logoutCalls += 1
    },
  }
}

test('QR begin exposes an opaque challenge and image without the provider key', async () => {
  const provider = makeProvider()
  const machine = new QrLoginStateMachine(provider, {
    now: () => 1_000,
    challengeId: () => 'challenge-1',
    ttlMs: 30_000,
  })

  const state = await machine.begin()

  assert.deepEqual(state, {
    status: 'waiting',
    challengeId: 'challenge-1',
    qrImage: 'data:image/png;base64,synthetic-qr',
    expiresAt: 31_000,
  })
  assert.doesNotMatch(JSON.stringify(state), /provider-key-hidden/)
})

test('QR poll maps waiting, scanned, then verified authorization and returns credential once', async () => {
  const provider = makeProvider()
  let pollCount = 0
  provider.nextCheck = async () => {
    pollCount += 1
    if (pollCount === 1) return { code: 801 }
    if (pollCount === 2) return { code: 802 }
    return { code: 803, credential: 'fixture-credential' }
  }
  const machine = new QrLoginStateMachine(provider, {
    now: () => 1_000,
    challengeId: () => 'challenge-2',
  })
  await machine.begin()

  assert.deepEqual((await machine.poll('challenge-2')).state, {
    status: 'waiting',
    challengeId: 'challenge-2',
    qrImage: 'data:image/png;base64,synthetic-qr',
    expiresAt: 181_000,
  })
  assert.equal((await machine.poll('challenge-2')).state.status, 'scanned')
  const authorized = await machine.poll('challenge-2')
  assert.deepEqual(authorized.state, { status: 'authorized' })
  assert.equal(authorized.credential, 'fixture-credential')
  assert.deepEqual(await machine.poll('challenge-2'), { state: { status: 'authorized' } })
  assert.deepEqual(provider.verifyCalls, ['fixture-credential'])
  assert.doesNotMatch(JSON.stringify(authorized.state), /fixture-credential/)
})

test('QR 803 with the real login_status wrapper reaches authorized', async () => {
  const api = {
    async song_detail() {
      return { body: { code: 200 } }
    },
    async song_url_v1() {
      return { body: { code: 200 } }
    },
    async login_qr_key() {
      return { body: { code: 200, data: { unikey: 'synthetic-qr-key' } } }
    },
    async login_qr_create() {
      return {
        body: {
          code: 200,
          data: { qrimg: 'data:image/png;base64,synthetic-qr' },
        },
      }
    },
    async login_qr_check() {
      return { body: { code: 803, cookie: 'synthetic-credential' } }
    },
    async login_status() {
      return {
        body: {
          data: {
            code: 200,
            profile: { userId: 1 },
            account: { id: 1 },
          },
        },
      }
    },
    async logout() {
      return { body: { code: 200 } }
    },
  }
  const machine = new QrLoginStateMachine(new NeteaseClient(undefined, api), {
    challengeId: () => 'challenge-real-login-status',
  })

  await machine.begin()
  assert.deepEqual(await machine.poll('challenge-real-login-status'), {
    state: { status: 'authorized' },
    credential: 'synthetic-credential',
  })
})

test('QR expiration and cancellation fail closed without verifying credentials', async () => {
  const provider = makeProvider()
  let now = 1_000
  const machine = new QrLoginStateMachine(provider, {
    now: () => now,
    challengeId: () => 'challenge-3',
    ttlMs: 10,
  })
  await machine.begin()
  now = 1_011
  assert.deepEqual(await machine.poll('challenge-3'), { state: { status: 'expired' } })
  assert.deepEqual(provider.verifyCalls, [])

  await machine.begin()
  assert.deepEqual(machine.cancel('challenge-3'), { status: 'cancelled' })
  assert.deepEqual(await machine.poll('challenge-3'), { state: { status: 'cancelled' } })
})

test('QR polling cancellation wins when the provider response arrives late', async () => {
  const provider = makeProvider()
  let resolveCheck: ((value: { code: number; credential?: string }) => void) | undefined
  provider.nextCheck = () =>
    new Promise((resolve) => {
      resolveCheck = resolve
    })
  const machine = new QrLoginStateMachine(provider, {
    now: () => 1_000,
    challengeId: () => 'challenge-4',
  })
  await machine.begin()
  const pending = machine.poll('challenge-4')
  assert.deepEqual(machine.cancel('challenge-4'), { status: 'cancelled' })
  resolveCheck?.({ code: 803, credential: 'fixture-credential' })

  assert.deepEqual(await pending, { state: { status: 'cancelled' } })
  assert.deepEqual(provider.verifyCalls, [])
})

test('QR logout clears the provider session and returns idle', async () => {
  const provider = makeProvider()
  const machine = new QrLoginStateMachine(provider)

  assert.deepEqual(await machine.logout(), { status: 'idle' })
  assert.equal(provider.logoutCalls, 1)
})

test('QR machine exposes an expired state when the provider session is rejected', () => {
  const provider = makeProvider()
  const machine = new QrLoginStateMachine(provider)

  machine.markAuthorized()
  assert.deepEqual(machine.markExpired(), { status: 'expired' })
  assert.deepEqual(machine.getState(), { status: 'expired' })
})
