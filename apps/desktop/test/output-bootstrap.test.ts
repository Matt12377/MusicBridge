import assert from 'node:assert/strict'
import test from 'node:test'

const load = () => import('../src/main/output-bootstrap.js')
const host = { platform: 'darwin', arch: 'arm64', entryDirectory: '/synthetic/app/dist/main', resourcesDirectory: '/synthetic/resources' }
const hash = 'a'.repeat(64)

test('输出Bootstrap只按固定开发与打包路径定位，不接受自定义helper或设备开关', async () => {
  const { bundledOutputRoot } = await load()
  assert.equal(bundledOutputRoot({}, host), '/synthetic/app/native/output/darwin-arm64')
  assert.equal(bundledOutputRoot({}, { ...host, entryDirectory: '/synthetic/resources/app.asar/dist/main' }), '/synthetic/resources/output/darwin-arm64')
  assert.equal(bundledOutputRoot({ MUSIC_BRIDGE_OUTPUT_HELPER_PATH: '/private/injected', MUSIC_BRIDGE_DEVICE_AUTHORIZED: '1' }, host), '/synthetic/app/native/output/darwin-arm64')
  assert.equal(bundledOutputRoot({}, { ...host, platform: 'linux' }), undefined)
  assert.equal(bundledOutputRoot({}, { ...host, arch: 'x64' }), undefined)
})

test('测试模式默认关闭输出helper，仅双标志显式允许无设备检查', async () => {
  const { bundledOutputRoot } = await load()
  const env = { MUSIC_BRIDGE_CORE_TEST_MODE: '1' }
  for (const patch of [{}, { MUSIC_BRIDGE_UI_E2E: '1' }, { MUSIC_BRIDGE_BUNDLED_OUTPUT_GATE: '1' }, { MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_BUNDLED_CONVERTER_GATE: '1' }]) assert.equal(bundledOutputRoot({ ...env, ...patch }, host), undefined)
  assert.equal(bundledOutputRoot({ ...env, MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_BUNDLED_OUTPUT_GATE: '1' }, host), '/synthetic/app/native/output/darwin-arm64')
})

test('输出Bootstrap只传应用编译pin；缺pin或测试禁用不调用loader，错误静默禁用', async () => {
  const { loadOutputHelperForCore } = await load()
  const calls: unknown[][] = [], pin = { path: '/synthetic/helper', sha256: hash, manifestPath: '/synthetic/manifest', manifestSha256: hash, halAdapterPath: '/synthetic/adapter', halAdapterSha256: hash }
  const loader = async (...args: [string, string | null]) => { calls.push(args); return pin }
  assert.equal(await loadOutputHelperForCore({}, host, null, loader), undefined)
  assert.equal(await loadOutputHelperForCore({ MUSIC_BRIDGE_CORE_TEST_MODE: '1' }, host, hash, loader), undefined)
  assert.deepEqual(calls, [])
  assert.equal(await loadOutputHelperForCore({}, host, hash, loader), pin)
  assert.deepEqual(calls, [['/synthetic/app/native/output/darwin-arm64', hash]])
  assert.equal(await loadOutputHelperForCore({}, host, hash, async () => { throw new Error('/private/helper failure') }), undefined)
})
