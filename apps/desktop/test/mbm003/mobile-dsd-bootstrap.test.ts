import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { bundledMobileDsdRoot, type MobileDsdBootstrapContext } from '../../src/main/mobile-dsd-bootstrap.js'
import { datasetOwnerEnvironment } from '../../src/main/dataset-owner-bootstrap.js'

const host: MobileDsdBootstrapContext = {
  platform: 'darwin', arch: 'arm64',
  entryDirectory: '/owned/desktop/dist/main', resourcesDirectory: '/owned/resources',
}

test('003独立开发包与正式资源目录不会取得原录音转换器目录', () => {
  assert.equal(bundledMobileDsdRoot({}, host), '/owned/desktop/native/mobile-ffmpeg/darwin-arm64')
  assert.equal(bundledMobileDsdRoot({}, { ...host, entryDirectory: path.join(host.resourcesDirectory, 'app.asar/dist/main') }),
    '/owned/resources/mobile-ffmpeg/darwin-arm64')
})

test('003实际后端仅Darwin arm64候选，其他平台不补造资格', () => {
  for (const platform of ['linux', 'win32'] as const) assert.equal(bundledMobileDsdRoot({}, { ...host, platform }), undefined)
  assert.equal(bundledMobileDsdRoot({}, { ...host, arch: 'x64' }), undefined)
})

test('003合成Owner默认OFF，仅同次专用受控Gate允许候选目录', () => {
  const base = { MUSIC_BRIDGE_CORE_TEST_MODE: '1' }
  for (const extra of [{}, { MUSIC_BRIDGE_UI_E2E: '1' }, { MUSIC_BRIDGE_MOBILE_DSD_BACKEND_GATE: '1' },
    { MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_BUNDLED_CONVERTER_GATE: '1' }]) {
    assert.equal(bundledMobileDsdRoot({ ...base, ...extra }, host), undefined)
  }
  assert.equal(bundledMobileDsdRoot({ ...base, MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_MOBILE_DSD_BACKEND_GATE: '1' }, host),
    '/owned/desktop/native/mobile-ffmpeg/darwin-arm64')
})

test('003启动路径必须为实际绝对目录，不以环境路径替代', () => {
  assert.equal(bundledMobileDsdRoot({ PATH: '/untrusted', MUSIC_BRIDGE_MOBILE_FFMPEG_ROOT: '/untrusted' }, host),
    '/owned/desktop/native/mobile-ffmpeg/darwin-arm64')
  for (const value of ['relative', '/owned/\0unsafe', `/${'a'.repeat(4096)}`]) {
    assert.equal(bundledMobileDsdRoot({}, { ...host, entryDirectory: value }), undefined)
    assert.equal(bundledMobileDsdRoot({}, { ...host, resourcesDirectory: value }), undefined)
  }
})

test('003Owner环境仅新增专用受控Gate，不传播任意后端路径或录音设备权限', () => {
  const env = datasetOwnerEnvironment({ MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_CORE_TEST_MODE: '1',
    MUSIC_BRIDGE_MOBILE_DSD_BACKEND_GATE: '1', MUSIC_BRIDGE_MOBILE_FFMPEG_ROOT: '/untrusted',
    MUSIC_BRIDGE_OUTPUT_DEVICE_GATE: '1', PROVIDER_TOKEN: 'synthetic-untrusted' })
  assert.deepEqual(env, { MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_CORE_TEST_MODE: '1', MUSIC_BRIDGE_MOBILE_DSD_BACKEND_GATE: '1' })
})
