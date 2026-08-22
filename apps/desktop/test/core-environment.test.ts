import assert from 'node:assert/strict'
import test from 'node:test'

import { buildCoreEnvironment } from '../src/main/core-environment.js'

test('Core environment keeps only runtime keys and test-only probes', () => {
  const environment: Record<string, string | undefined> = buildCoreEnvironment({
    PATH: '/synthetic/path',
    HOME: '/synthetic/home',
    MUSIC_BRIDGE_UNRELATED_SECRET_CANARY: 'synthetic-canary',
    NETEASE_COOKIE: 'synthetic-credential',
    NODE_OPTIONS: '--require synthetic',
    ELECTRON_RUN_AS_NODE: '1',
    BRIDGE_CONTROL_PORT: '38501',
    NETEASE_DEFAULT_QUALITY: 'lossless',
    LOG_LEVEL: 'info',
    MUSIC_BRIDGE_CORE_CRASH_DELAY_MS: '250',
  }, {
    startupTest: true,
    uiE2e: false,
    coreCrashGate: true,
  })

  assert.deepEqual(environment, {
    NODE_ENV: 'test',
    BRIDGE_CONTROL_PORT: '38501',
    NETEASE_DEFAULT_QUALITY: 'lossless',
    LOG_LEVEL: 'info',
    MUSIC_BRIDGE_CORE_TEST_MODE: '1',
    MUSIC_BRIDGE_CORE_CRASH_PROBE: '1',
    MUSIC_BRIDGE_CORE_CRASH_DELAY_MS: '250',
  })
  assert.equal(Object.hasOwn(environment, 'MUSIC_BRIDGE_UNRELATED_SECRET_CANARY'), false)
  assert.equal(Object.hasOwn(environment, 'NETEASE_COOKIE'), false)
  assert.equal(Object.hasOwn(environment, 'NODE_OPTIONS'), false)
  assert.equal(Object.hasOwn(environment, 'ELECTRON_RUN_AS_NODE'), false)
})

test('Core environment exposes only the bounded Roon Time gate path when explicitly enabled', () => {
  const gatePath = '/tmp/musicbridge-roon-time-gate-test.jsonl'
  const environment = buildCoreEnvironment({
    MUSIC_BRIDGE_ROON_TIME_GATE: '1',
    MUSIC_BRIDGE_ROON_TIME_GATE_PATH: gatePath,
  }, {
    startupTest: false,
    uiE2e: false,
    coreCrashGate: false,
    roonTimeGate: true,
  })

  assert.deepEqual(environment, {
    MUSIC_BRIDGE_ROON_TIME_GATE: '1',
    MUSIC_BRIDGE_ROON_TIME_GATE_PATH: gatePath,
  })
})
