import assert from 'node:assert/strict'
import test from 'node:test'

import { BridgeError } from '../src/shared/errors.js'
import { loadConfig } from '../src/config/config.js'

test('local-core keeps the formal loopback defaults and ignores no remote settings', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    NETEASE_DEFAULT_QUALITY: 'lossless',
  })

  assert.equal(config.mode, 'local-core')
  assert.equal(config.controlHost, '127.0.0.1')
  assert.equal(config.controlPort, 38501)
  assert.equal(config.streamHost, '127.0.0.1')
  assert.equal(config.streamPort, 38502)
  assert.equal(config.publicStreamBaseUrl, 'http://127.0.0.1:38502')
  assert.equal(config.remoteStreamPort, undefined)
})

test('local-core accepts an explicitly configured loopback Roon Core websocket', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    ROON_CORE_HOST: '127.0.0.1',
    ROON_CORE_PORT: '9330',
    NETEASE_DEFAULT_QUALITY: 'lossless',
  })

  assert.equal(config.mode, 'local-core')
  assert.equal(config.roonCoreHost, '127.0.0.1')
  assert.equal(config.roonCorePort, 9330)
})

test('local-core rejects a non-loopback Roon Core websocket host', () => {
  assert.throws(
    () => loadConfig({
      NODE_ENV: 'test',
      ROON_CORE_HOST: '192.168.1.20',
      ROON_CORE_PORT: '9330',
    }),
    (error: unknown) => error instanceof BridgeError && error.code === 'CONFIG_INVALID',
  )
})

test('remote-core-development fixes local Core ports and publishes only the selected bounded remote port', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    MUSIC_BRIDGE_REMOTE_CORE_MODE: 'remote-core-development',
    MUSIC_BRIDGE_REMOTE_STREAM_PORT: '38513',
    BRIDGE_CONTROL_HOST: '127.0.0.1',
    BRIDGE_CONTROL_PORT: '38501',
    BRIDGE_STREAM_HOST: '127.0.0.1',
    BRIDGE_STREAM_PORT: '38502',
    BRIDGE_PUBLIC_STREAM_BASE_URL: 'http://127.0.0.1:38513',
    ROON_CORE_HOST: '127.0.0.1',
    ROON_CORE_PORT: '19330',
    NETEASE_DEFAULT_QUALITY: 'lossless',
  })

  assert.deepEqual(config, {
    mode: 'remote-core-development',
    controlHost: '127.0.0.1',
    controlPort: 38501,
    streamHost: '127.0.0.1',
    streamPort: 38502,
    publicStreamBaseUrl: 'http://127.0.0.1:38513',
    remoteStreamPort: 38513,
    roonCoreHost: '127.0.0.1',
    roonCorePort: 19330,
    defaultQuality: 'lossless',
    logLevel: 'info',
  })
})

test('remote-core-development rejects non-loopback or unbounded public settings', () => {
  const cases = [
    {
      MUSIC_BRIDGE_REMOTE_CORE_MODE: 'remote-core-development',
      MUSIC_BRIDGE_REMOTE_STREAM_PORT: '38520',
      BRIDGE_PUBLIC_STREAM_BASE_URL: 'http://127.0.0.1:38520',
    },
    {
      MUSIC_BRIDGE_REMOTE_CORE_MODE: 'remote-core-development',
      MUSIC_BRIDGE_REMOTE_STREAM_PORT: '38512',
      BRIDGE_CONTROL_HOST: '0.0.0.0',
      BRIDGE_PUBLIC_STREAM_BASE_URL: 'http://127.0.0.1:38512',
    },
    {
      MUSIC_BRIDGE_REMOTE_CORE_MODE: 'remote-core-development',
      MUSIC_BRIDGE_REMOTE_STREAM_PORT: '38512',
      BRIDGE_PUBLIC_STREAM_BASE_URL: 'http://192.168.1.10:38512',
    },
  ]

  for (const env of cases) {
    assert.throws(
      () => loadConfig({ NODE_ENV: 'test', ...env }),
      (error: unknown) => error instanceof BridgeError && error.code === 'CONFIG_INVALID',
    )
  }
})
