import assert from 'node:assert/strict'
import test from 'node:test'

import { createPreloadApi, PUBLIC_API_KEYS } from '../src/preload/api.js'

test('Preload exposes only getAppInfo', async () => {
  const appInfo = {
    version: '0.1.0-poc.1',
    buildMode: 'development' as const,
    platform: 'darwin',
  }
  const api = createPreloadApi(async () => appInfo)

  assert.deepEqual(PUBLIC_API_KEYS, ['getAppInfo'])
  assert.deepEqual(Object.keys(api), ['getAppInfo'])
  assert.equal(Object.isFrozen(api), true)
  assert.deepEqual(await api.getAppInfo(), appInfo)
})
