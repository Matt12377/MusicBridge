import assert from 'node:assert/strict'
import test from 'node:test'

import type { PublicAuthState, PublicBridgeState } from '@music-bridge/contracts'
import { createPreloadApi, PUBLIC_API_KEYS } from '../src/preload/api.js'

test('Preload exposes only sanitized business methods', async () => {
  const appInfo = {
    version: '0.1.0-poc.1',
    buildMode: 'development' as const,
    platform: 'darwin',
  }
  const state: PublicBridgeState = {
    runtime: 'ready',
    roon: 'paired',
    provider: 'missing',
    activeStreamCount: 0,
    activePlaybackPresent: false,
  }
  const authState: PublicAuthState = { status: 'idle' }
  const api = createPreloadApi(
    async () => appInfo,
    async () => state,
    async () => state,
    async () => ({ pong: true as const }),
    async () => authState,
    async () => authState,
    async () => authState,
    async () => authState,
    async () => authState,
    () => () => undefined,
  )

  assert.deepEqual(PUBLIC_API_KEYS, [
    'getAppInfo',
    'getCoreHealth',
    'getCoreState',
    'pingCore',
    'getAuthState',
    'beginQrLogin',
    'pollQrLogin',
    'cancelQrLogin',
    'logout',
    'onCoreEvent',
  ])
  assert.deepEqual(Object.keys(api), [
    'getAppInfo',
    'getCoreHealth',
    'getCoreState',
    'pingCore',
    'getAuthState',
    'beginQrLogin',
    'pollQrLogin',
    'cancelQrLogin',
    'logout',
    'onCoreEvent',
  ])
  assert.equal(Object.isFrozen(api), true)
  assert.deepEqual(await api.getAppInfo(), appInfo)
  assert.deepEqual(await api.getCoreHealth(), state)
  assert.deepEqual(await api.getCoreState(), state)
  assert.deepEqual(await api.pingCore(), { pong: true })
  assert.deepEqual(await api.getAuthState(), authState)
  assert.deepEqual(await api.beginQrLogin(), authState)
  assert.deepEqual(await api.pollQrLogin('challenge-1'), authState)
  assert.deepEqual(await api.cancelQrLogin('challenge-1'), authState)
  assert.deepEqual(await api.logout(), authState)
})
