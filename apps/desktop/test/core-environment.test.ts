import assert from 'node:assert/strict'
import test from 'node:test'

import { buildCoreEnvironment } from '../src/main/core-environment.js'
import { bundledConverterRoot } from '../src/main/converter-bootstrap.js'

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

test('Main injects only its prepared userData data directory for Core persistence', () => {
  const environment = buildCoreEnvironment({
    MUSIC_BRIDGE_DATA_DIRECTORY: '/tmp/untrusted-parent-directory',
  }, {
    startupTest: false,
    uiE2e: false,
    coreCrashGate: false,
    dataDirectory: '/tmp/musicbridge-owner-user-data/data',
  })

  assert.deepEqual(environment, {
    MUSIC_BRIDGE_DATA_DIRECTORY: '/tmp/musicbridge-owner-user-data/data',
  })
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

test('Core environment exposes only the bounded Roon Browse gate path when explicitly enabled', () => {
  const gatePath = '/tmp/musicbridge-roon-browse-gate-test.jsonl'
  const environment = buildCoreEnvironment({
    MUSIC_BRIDGE_ROON_BROWSE_GATE: '1',
    MUSIC_BRIDGE_ROON_BROWSE_GATE_PATH: gatePath,
  }, {
    startupTest: false,
    uiE2e: false,
    coreCrashGate: false,
    roonBrowseGate: true,
  })

  assert.deepEqual(environment, {
    MUSIC_BRIDGE_ROON_BROWSE_GATE: '1',
    MUSIC_BRIDGE_ROON_BROWSE_GATE_PATH: gatePath,
  })
})

test('Core environment exposes only the bounded Roon Image gate path when explicitly enabled', () => {
  const gatePath = '/tmp/musicbridge-roon-image-gate-test.jsonl'
  const environment = buildCoreEnvironment({
    MUSIC_BRIDGE_ROON_IMAGE_GATE: '1',
    MUSIC_BRIDGE_ROON_IMAGE_GATE_PATH: gatePath,
  }, {
    startupTest: false,
    uiE2e: false,
    coreCrashGate: false,
    roonImageGate: true,
  })

  assert.deepEqual(environment, {
    MUSIC_BRIDGE_ROON_IMAGE_GATE: '1',
    MUSIC_BRIDGE_ROON_IMAGE_GATE_PATH: gatePath,
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

test('remote Core mode can use the explicitly selected secondary loopback port pair', () => {
  const environment = buildCoreEnvironment({
    MUSIC_BRIDGE_REMOTE_LOCAL_PORT_PROFILE: 'secondary',
  }, {
    startupTest: false,
    uiE2e: false,
    coreCrashGate: false,
    remoteCoreMode: 'remote-core-development',
    remoteStreamPort: 38519,
  })

  assert.equal(environment.BRIDGE_CONTROL_PORT, '38601')
  assert.equal(environment.BRIDGE_STREAM_PORT, '38602')
  assert.equal(environment.BRIDGE_PUBLIC_STREAM_BASE_URL, 'http://127.0.0.1:38519')
})

test('remote Core mode rejects an unknown local port profile', () => {
  assert.throws(() => buildCoreEnvironment({
    MUSIC_BRIDGE_REMOTE_LOCAL_PORT_PROFILE: 'unbounded',
  }, {
    startupTest: false,
    uiE2e: false,
    coreCrashGate: false,
    remoteCoreMode: 'remote-core-development',
    remoteStreamPort: 38519,
  }))
})

test('合成 Roon 目录仅在明确 UI E2E 环境透传，正常运行忽略该开关', () => {
  const parent = { MUSIC_BRIDGE_SYNTHETIC_ROON_LIBRARY: '1' };
  assert.equal(buildCoreEnvironment(parent, { startupTest: false, uiE2e: false, coreCrashGate: false }).MUSIC_BRIDGE_SYNTHETIC_ROON_LIBRARY, undefined);
  assert.equal(buildCoreEnvironment(parent, { startupTest: false, uiE2e: true, coreCrashGate: false }).MUSIC_BRIDGE_SYNTHETIC_ROON_LIBRARY, '1');
});

test('打包转换器合成 Gate 只在显式桌面 E2E 模式转发，不允许生产环境或任意路径', () => {
  const parent = { MUSIC_BRIDGE_BUNDLED_CONVERTER_GATE: '1', MUSIC_BRIDGE_FFMPEG_PATH: '/untrusted/ffmpeg' }
  for (const uiE2e of [false,true]) {
    const env = buildCoreEnvironment(parent, { startupTest: false, uiE2e, coreCrashGate: false })
    assert.equal(env.MUSIC_BRIDGE_BUNDLED_CONVERTER_GATE, uiE2e ? '1' : undefined)
    assert.equal(env.MUSIC_BRIDGE_FFMPEG_PATH, undefined)
  }
})

test('无设备输出包Gate只向明确UI E2E转发，忽略路径和设备授权环境输入', () => {
  for (const uiE2e of [false, true]) {
    const env = buildCoreEnvironment({ MUSIC_BRIDGE_BUNDLED_OUTPUT_GATE: '1', MUSIC_BRIDGE_OUTPUT_PATH: '/untrusted', MUSIC_BRIDGE_OUTPUT_DEVICE_AUTHORIZED: '1' }, { startupTest: false, uiE2e, coreCrashGate: false })
    assert.equal(env.MUSIC_BRIDGE_BUNDLED_OUTPUT_GATE, uiE2e ? '1' : undefined)
    assert.equal(env.MUSIC_BRIDGE_OUTPUT_PATH, undefined); assert.equal(env.MUSIC_BRIDGE_OUTPUT_DEVICE_AUTHORIZED, undefined)
  }
})

test('转换器只从固定开发或 ASAR 资源目录加载，普通合成测试不启用原生后端', () => {
  const host = { platform: 'darwin', arch: 'arm64', entryDirectory: '/workspace/apps/desktop/dist/main', resourcesDirectory: '/Applications/Music Bridge.app/Contents/Resources' }
  assert.equal(bundledConverterRoot({}, host), '/workspace/apps/desktop/native/ffmpeg/darwin-arm64')
  assert.equal(bundledConverterRoot({}, { ...host, entryDirectory: host.resourcesDirectory + '/app.asar/dist/main' }), host.resourcesDirectory + '/ffmpeg/darwin-arm64')
  assert.equal(bundledConverterRoot({}, { ...host, arch: 'x64' }), undefined)
  assert.equal(bundledConverterRoot({}, { ...host, platform: 'linux' }), undefined)
  const testEnv = { MUSIC_BRIDGE_CORE_TEST_MODE: '1' }
  assert.equal(bundledConverterRoot(testEnv, host), undefined)
  assert.equal(bundledConverterRoot({ ...testEnv, MUSIC_BRIDGE_BUNDLED_CONVERTER_GATE: '1' }, host), undefined)
  assert.equal(bundledConverterRoot({ ...testEnv, MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_BUNDLED_CONVERTER_GATE: '1', MUSIC_BRIDGE_FFMPEG_PATH: '/untrusted' }, host), '/workspace/apps/desktop/native/ffmpeg/darwin-arm64')
})
