import assert from 'node:assert/strict'
import test from 'node:test'

import { NeteaseClient } from '../src/netease/client.js'

test('NeteaseClient adapts QR login API responses and verifies before configuring', async () => {
  const calls: string[] = []
  const api = {
    async song_detail() {
      return { body: { code: 200 } }
    },
    async song_url_v1() {
      return { body: { code: 200 } }
    },
    async login_qr_key() {
      calls.push('key')
      return { body: { code: 200, data: { unikey: 'synthetic-qr-key' } } }
    },
    async login_qr_create() {
      calls.push('create')
      return {
        body: {
          code: 200,
          data: { qrimg: 'data:image/png;base64,synthetic-qr' },
        },
      }
    },
    async login_qr_check() {
      calls.push('check')
      return { body: { code: 803, cookie: 'synthetic-credential' } }
    },
    async login_status(params: Record<string, unknown>) {
      assert.equal(params.cookie, 'synthetic-credential')
      calls.push('status')
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
    async logout(params: Record<string, unknown>) {
      assert.equal(params.cookie, 'synthetic-credential')
      calls.push('logout')
      return { body: { code: 200 } }
    },
  }

  const client = new NeteaseClient(undefined, api)
  assert.equal(client.configured, false)
  assert.deepEqual(await client.createQr(), {
    key: 'synthetic-qr-key',
    qrImage: 'data:image/png;base64,synthetic-qr',
  })
  assert.deepEqual(await client.checkQr('synthetic-qr-key'), {
    code: 803,
    credential: 'synthetic-credential',
  })
  assert.equal(await client.verifyCredential('synthetic-credential'), true)

  client.setCredential('synthetic-credential')
  assert.equal(client.configured, true)
  await client.logout()
  assert.equal(client.configured, false)
  assert.deepEqual(calls, ['key', 'create', 'check', 'status', 'logout'])
})

test('NeteaseClient clears the local session when remote logout fails', async () => {
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
      return { body: { code: 801 } }
    },
    async login_status() {
      return { body: { code: 200, data: { profile: { userId: 1 } } } }
    },
    async logout() {
      throw new Error('synthetic remote logout failure')
    },
  }

  const client = new NeteaseClient('synthetic-credential', api)
  await assert.rejects(() => client.logout())
  assert.equal(client.configured, false)
})

test('NeteaseClient prepares the API runtime before resolving an audio URL', async () => {
  const events: string[] = []
  const api = {
    async song_detail() {
      return { body: { code: 200 } }
    },
    async song_url_v1(params: Record<string, unknown>) {
      events.push(`song_url:${String(params.level)}`)
      return {
        body: {
          code: 200,
          data: [{ id: 303, url: 'https://audio.example.invalid/synthetic.flac', level: 'lossless' }],
        },
      }
    },
    async login_qr_key() {
      return { body: { code: 200, data: { unikey: 'synthetic-qr-key' } } }
    },
    async login_qr_create() {
      return { body: { code: 200, data: { qrimg: 'data:image/png;base64,synthetic-qr' } } }
    },
    async login_qr_check() {
      return { body: { code: 801 } }
    },
    async login_status() {
      return { body: { code: 200, data: { profile: { userId: 1 } } } }
    },
    async logout() {
      return { body: { code: 200 } }
    },
  }

  const client = new NeteaseClient('synthetic-credential', api, async () => {
    events.push('prepare')
  })

  const stream = await client.resolveStream('303', 'lossless')

  assert.equal(stream.upstreamUrl, 'https://audio.example.invalid/synthetic.flac')
  assert.deepEqual(events, ['prepare', 'song_url:lossless'])
})

test('NeteaseClient distinguishes authorized, expired and unavailable credential checks', async () => {
  let mode: 'authorized' | 'expired' | 'unavailable' = 'authorized'
  const api = {
    async song_detail() { return { body: { code: 200 } } },
    async song_url_v1() { return { body: { code: 200 } } },
    async login_qr_key() { return { body: { code: 200, data: { unikey: 'synthetic-key' } } } },
    async login_qr_create() { return { body: { code: 200, data: { qrimg: 'data:image/png;base64,synthetic' } } } },
    async login_qr_check() { return { body: { code: 801 } } },
    async login_status() {
      if (mode === 'unavailable') throw new Error('synthetic network timeout')
      if (mode === 'expired') return { body: { code: 301 } }
      return { body: { data: { code: 200, profile: { userId: 1 } } } }
    },
    async logout() { return { body: { code: 200 } } },
  }
  const client = new NeteaseClient(undefined, api)

  assert.equal(await client.verifyCredentialStatus('fixture-credential'), 'authorized')
  mode = 'expired'
  assert.equal(await client.verifyCredentialStatus('fixture-credential'), 'expired')
  mode = 'unavailable'
  assert.equal(await client.verifyCredentialStatus('fixture-credential'), 'unavailable')
})
