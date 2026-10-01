import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { datasetOwnerEnvironment, parseDatasetOwnerWorkerData } from '../src/main/dataset-owner-bootstrap.js'
import { loadRecordingDependenciesForOwner, type RecordingBootstrapContext } from '../src/main/recording-bootstrap.js'
import { ffmpegBuildPolicy } from '../../../packages/bridge-core/src/recording/ffmpeg-build-policy.js'
import type { GateBCandidateIdentity } from '../../../packages/bridge-core/src/recording/gate-b-admission.js'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const pinNames = ['__MUSIC_BRIDGE_FFMPEG_MANIFEST_SHA256__', '__MUSIC_BRIDGE_OUTPUT_MANIFEST_SHA256__',
  '__MUSIC_BRIDGE_OUTPUT_DEVICE_MANIFEST_SHA256__', '__MUSIC_BRIDGE_OUTPUT_DEVICE_CANDIDATE__'] as const
async function withCompiledPins<T>(pins: Record<(typeof pinNames)[number], unknown>, operation: () => Promise<T>): Promise<T> {
  const before = pinNames.map(name => Object.getOwnPropertyDescriptor(globalThis, name))
  // 直接tsx不经过Vite的编译常量替换；这里只在本测试进程提供合成构建身份。
  for (const name of pinNames) Object.defineProperty(globalThis, name, { value: pins[name], configurable: true })
  try { return await operation() }
  finally {
    pinNames.forEach((name, index) => {
      const descriptor = before[index]
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    })
  }
}

async function nativeFixture(t: test.TestContext, packaged = false) {
  const app = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mbp-008-owner-bootstrap-')))
  t.after(() => rm(app, { recursive: true, force: true }))
  const resourcesDirectory = path.join(app, 'resources')
  const entryDirectory = packaged ? path.join(resourcesDirectory, 'app.asar/dist/main') : path.join(app, 'app/dist/main')
  const packageRoot = (name: string) => packaged ? path.join(resourcesDirectory, name, 'darwin-arm64') : path.join(app, 'app/native', name, 'darwin-arm64')
  const bytes = '合成pin文件，仅作只读装载，不能执行设备或转换任务。'
  const fileHash = digest(bytes)
  async function file(root: string, relative: string) {
    const target = path.join(root, relative)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, bytes, { mode: 0o700 })
    return { path: relative, sha256: fileHash }
  }
  async function manifest(root: string, value: unknown) {
    const text = JSON.stringify(value) + '\n'
    await writeFile(path.join(root, 'manifest.json'), text, { mode: 0o600 })
    return digest(text)
  }
  const converterRoot = packageRoot('ffmpeg')
  const binary = async (relative: string) => ({ ...await file(converterRoot, relative), versionSha256: digest('合成版本身份') })
  const ffmpeg = await binary('bin/ffmpeg'), ffprobe = await binary('bin/ffprobe')
  const dependencies = []
  for (const library of ffmpegBuildPolicy.libraries) dependencies.push({ id: library.id, ...await file(converterRoot, `lib/${library.id}`) })
  const converterHash = await manifest(converterRoot, {
    schemaVersion: 1, platform: 'darwin', arch: 'arm64', minimumMacOS: '13.0', sourceSha256: ffmpegBuildPolicy.source.sha256, license: 'LGPL-2.1-or-later',
    build: { version: '8.1.2', ffmpeg, ffprobe, dependencies, components: ffmpegBuildPolicy.libraries.map(library => ({ name: library.name, version: library.version })) },
  })
  const outputRoot = packageRoot('output')
  const outputHash = await manifest(outputRoot, {
    schemaVersion: 1, platform: 'darwin', arch: 'arm64', protocolVersion: 1, backendId: 'musicbridge-coreaudio-hal', backendVersion: '0.1.0', mode: 'synthetic-only', sourceSha256: 'c'.repeat(64),
    files: { helper: await file(outputRoot, 'bin/output-helper'), halAdapter: await file(outputRoot, 'build/core-audio-adapter.o') },
  })
  const deviceRoot = packageRoot('output-device')
  const deviceHash = await manifest(deviceRoot, {
    schemaVersion: 1, platform: 'darwin', arch: 'arm64', protocolVersion: 1, backendId: 'musicbridge-coreaudio-hal', backendVersion: '0.2.0', mode: 'device',
    drainAlgorithmId: 'hal-sample-zero-cover-v1', sourceSha256: 'd'.repeat(64), files: { helper: await file(deviceRoot, 'bin/output-device-helper') },
  })
  const candidate: GateBCandidateIdentity = { commit: 'a'.repeat(40), tree: 'b'.repeat(40), sourceSha256: 'd'.repeat(64), manifestSha256: deviceHash, helperSha256: fileHash }
  const pins = { __MUSIC_BRIDGE_FFMPEG_MANIFEST_SHA256__: converterHash, __MUSIC_BRIDGE_OUTPUT_MANIFEST_SHA256__: outputHash,
    __MUSIC_BRIDGE_OUTPUT_DEVICE_MANIFEST_SHA256__: deviceHash, __MUSIC_BRIDGE_OUTPUT_DEVICE_CANDIDATE__: candidate }
  const context: RecordingBootstrapContext = { platform: 'darwin', arch: 'arm64', entryDirectory, resourcesDirectory }
  return { context, pins, candidate, fileHash, outputRoot, deviceRoot }
}

test('受信任worker启动数据只接受两个有界绝对路径，不从额外数据取得资格', () => {
  const valid = { dataDirectory: '/synthetic/data', resourcesDirectory: '/synthetic/resources' }
  const parsed = parseDatasetOwnerWorkerData(valid)
  assert.deepEqual(parsed, valid)
  assert.notEqual(parsed, valid)
  for (const invalid of [null, [], {}, { ...valid, qualification: true }, { ...valid, dataDirectory: 'relative/data' },
    { ...valid, resourcesDirectory: 'relative/resources' }, { ...valid, dataDirectory: '/synthetic/\0data' },
    { ...valid, resourcesDirectory: '/synthetic/\0resources' }, { ...valid, dataDirectory: '/' + 'x'.repeat(1024) },
    { ...valid, resourcesDirectory: '/' + 'x'.repeat(1024) }, { ...valid, dataDirectory: undefined }]) {
    assert.throws(() => parseDatasetOwnerWorkerData(invalid), /启动身份无效/u)
  }
})

test('worker环境只复制既有12项白名单，凭据、路径覆盖和资格变量不穿过线程边界', () => {
  const allowed = { NODE_ENV: 'test', TMPDIR: '/synthetic/tmp', DEV_BUILD_ROOT: '/synthetic/build', DEV_CACHE_ROOT: '/synthetic/cache', NODE_COMPILE_CACHE: '/synthetic/compile',
    LANG: 'zh_CN.UTF-8', LC_ALL: 'C', TZ: 'Asia/Shanghai', MUSIC_BRIDGE_CORE_TEST_MODE: '1', MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_BUNDLED_CONVERTER_GATE: '1', MUSIC_BRIDGE_BUNDLED_OUTPUT_GATE: '1' }
  const excluded = { NETEASE_COOKIE: '合成凭据', ROON_SESSION_ID: '合成会话', OPENAI_API_KEY: '合成密钥', MUSIC_BRIDGE_DATA_DIRECTORY: '/synthetic/data',
    MUSIC_BRIDGE_DEVICE_AUTHORIZED: '1', MUSIC_BRIDGE_GATE_B_COMPLETE: '1', MUSIC_BRIDGE_OUTPUT_HELPER_PATH: '/synthetic/injected', MUSIC_BRIDGE_FFMPEG_PATH: '/synthetic/injected',
    NODE_OPTIONS: '--inspect', NODE_PATH: '/synthetic/injected', PATH: '/synthetic/injected', HOME: '/synthetic/home' }
  const source = { ...allowed, ...excluded }
  const transferred = datasetOwnerEnvironment(source)
  assert.deepEqual(transferred, allowed)
  source.MUSIC_BRIDGE_CORE_TEST_MODE = '0'
  assert.equal(transferred.MUSIC_BRIDGE_CORE_TEST_MODE, '1')
  assert.deepEqual(datasetOwnerEnvironment({}), {})
})

test('真实owner loader保留开发与打包固定路径和编译pin，并透传原GateB candidate', async t => {
  for (const packaged of [false, true]) {
    const fixture = await nativeFixture(t, packaged)
    await withCompiledPins(fixture.pins, async () => {
      const loaded = await loadRecordingDependenciesForOwner({ MUSIC_BRIDGE_DEVICE_AUTHORIZED: '1', MUSIC_BRIDGE_OUTPUT_HELPER_PATH: '/synthetic/injected' }, fixture.context)
      assert.equal(loaded.recordingConverter?.identity.binarySha256, fixture.fileHash)
      assert.equal(loaded.recordingOutputHelper?.path, path.join(fixture.outputRoot, 'bin/output-helper'))
      assert.equal(loaded.recordingOutputHelper?.manifestSha256, fixture.pins.__MUSIC_BRIDGE_OUTPUT_MANIFEST_SHA256__)
      assert.equal(loaded.recordingDeviceOutputHelper?.path, path.join(fixture.deviceRoot, 'bin/output-device-helper'))
      assert.equal(loaded.recordingDeviceOutputHelper?.manifestSha256, fixture.pins.__MUSIC_BRIDGE_OUTPUT_DEVICE_MANIFEST_SHA256__)
      assert.equal(loaded.recordingGateBCandidate, fixture.candidate)
    })
  }
})

test('合成开关只允许无设备双gate装载，真实HAL pin始终禁用；平台不符也禁用', async t => {
  const fixture = await nativeFixture(t)
  await withCompiledPins(fixture.pins, async () => {
    for (const patch of [{}, { MUSIC_BRIDGE_UI_E2E: '1' }, { MUSIC_BRIDGE_BUNDLED_CONVERTER_GATE: '1', MUSIC_BRIDGE_BUNDLED_OUTPUT_GATE: '1' }]) {
      const loaded = await loadRecordingDependenciesForOwner({ MUSIC_BRIDGE_CORE_TEST_MODE: '1', MUSIC_BRIDGE_DEVICE_AUTHORIZED: '1', ...patch }, fixture.context)
      assert.equal(loaded.recordingConverter, undefined)
      assert.equal(loaded.recordingOutputHelper, undefined)
      assert.equal(loaded.recordingDeviceOutputHelper, undefined)
    }
    const enabled = await loadRecordingDependenciesForOwner({ MUSIC_BRIDGE_CORE_TEST_MODE: '1', MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_BUNDLED_CONVERTER_GATE: '1', MUSIC_BRIDGE_BUNDLED_OUTPUT_GATE: '1', MUSIC_BRIDGE_DEVICE_AUTHORIZED: '1' }, fixture.context)
    assert.ok(enabled.recordingConverter)
    assert.ok(enabled.recordingOutputHelper)
    assert.equal(enabled.recordingDeviceOutputHelper, undefined)
    for (const context of [{ ...fixture.context, platform: 'linux' as const }, { ...fixture.context, arch: 'x64' }]) {
      const loaded = await loadRecordingDependenciesForOwner({}, context)
      assert.equal(loaded.recordingConverter, undefined)
      assert.equal(loaded.recordingOutputHelper, undefined)
      assert.equal(loaded.recordingDeviceOutputHelper, undefined)
    }
  })
})

test('缺编译pin或pin不匹配不晚绑定本地清单，GateB candidate不从环境补造', async t => {
  const fixture = await nativeFixture(t)
  await withCompiledPins({ __MUSIC_BRIDGE_FFMPEG_MANIFEST_SHA256__: null, __MUSIC_BRIDGE_OUTPUT_MANIFEST_SHA256__: null, __MUSIC_BRIDGE_OUTPUT_DEVICE_MANIFEST_SHA256__: null, __MUSIC_BRIDGE_OUTPUT_DEVICE_CANDIDATE__: null }, async () => {
    assert.deepEqual(await loadRecordingDependenciesForOwner({ MUSIC_BRIDGE_DEVICE_AUTHORIZED: '1', MUSIC_BRIDGE_GATE_B_COMPLETE: '1' }, fixture.context), { recordingGateBCandidate: null })
  })
  await withCompiledPins({ ...fixture.pins, __MUSIC_BRIDGE_OUTPUT_DEVICE_MANIFEST_SHA256__: '0'.repeat(64) }, async () => {
    const loaded = await loadRecordingDependenciesForOwner({}, fixture.context)
    assert.equal(loaded.recordingDeviceOutputHelper, undefined)
    assert.equal(loaded.recordingGateBCandidate, fixture.candidate)
  })
})
