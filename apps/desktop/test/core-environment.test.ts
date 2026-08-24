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

test('Core environment exposes only bounded synthetic account modes to UI E2E', () => {
  const environment = buildCoreEnvironment({
    MUSIC_BRIDGE_SYNTHETIC_ACCOUNT_MODE: 'profile-unavailable',
  }, {
    startupTest: false,
    uiE2e: true,
    coreCrashGate: false,
  })

  assert.equal(environment.MUSIC_BRIDGE_SYNTHETIC_ACCOUNT_MODE, 'profile-unavailable')
  assert.equal(buildCoreEnvironment({
    MUSIC_BRIDGE_SYNTHETIC_ACCOUNT_MODE: 'profile-unavailable',
  }, {
    startupTest: false,
    uiE2e: false,
    coreCrashGate: false,
  }).MUSIC_BRIDGE_SYNTHETIC_ACCOUNT_MODE, undefined)
})

test('remote Core mode is injected only through explicit bounded Main options', () => {
  const environment = buildCoreEnvironment({
    MUSIC_BRIDGE_REMOTE_CORE_MODE: 'remote-core-development',
    MUSIC_BRIDGE_REMOTE_STREAM_PORT: '38519',
    BRIDGE_CONTROL_HOST: '0.0.0.0',
    BRIDGE_CONTROL_PORT: '40001',
    BRIDGE_STREAM_HOST: '192.168.1.20',
    BRIDGE_STREAM_PORT: '40002',
    BRIDGE_PUBLIC_STREAM_BASE_URL: 'http://192.168.1.20:40002',
  }, {
    startupTest: false,
    uiE2e: false,
    coreCrashGate: false,
    remoteCoreMode: 'remote-core-development',
    remoteStreamPort: 38519,
  })

  assert.deepEqual(environment, {
    BRIDGE_CONTROL_HOST: '127.0.0.1',
    BRIDGE_CONTROL_PORT: '38501',
    BRIDGE_STREAM_HOST: '127.0.0.1',
    BRIDGE_STREAM_PORT: '38502',
    BRIDGE_PUBLIC_STREAM_BASE_URL: 'http://127.0.0.1:38519',
    MUSIC_BRIDGE_REMOTE_CORE_MODE: 'remote-core-development',
    MUSIC_BRIDGE_REMOTE_STREAM_PORT: '38519',
    ROON_CORE_HOST: '127.0.0.1',
    ROON_CORE_PORT: '19330',
  })
})

test('remote Core mode rejects a port outside the bounded reverse-forward range', () => {
  assert.throws(() => buildCoreEnvironment({}, {
    startupTest: false,
    uiE2e: false,
    coreCrashGate: false,
    remoteCoreMode: 'remote-core-development',
    remoteStreamPort: 38520,
  }))
})
