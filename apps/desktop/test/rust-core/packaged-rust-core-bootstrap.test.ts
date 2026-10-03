import assert from 'node:assert/strict'
import test, { before } from 'node:test'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFile, chmod, lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createPackagedRustReadonlyFactory, startPackagedRustCoreHost, type PackagedRustCoreHooks } from '../../src/main/packaged-rust-core-bootstrap.js'
import { createRustResourceManifest, RUST_RESOURCE_RELATIVE_ROOT, RUST_BINARY_RELATIVE_PATH } from '../../scripts/rust-native-package.mjs'
import type { runCoreUtilityProcess } from '../../../../packages/bridge-core/src/utility-main.js'

const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
let root: string, resourceFixture: string
before(async () => {
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64')
  const temporary = process.env.TMPDIR
  assert.ok(temporary && path.isAbsolute(temporary), '测试必须显式使用外置临时根。')
  const canonical = await realpath(temporary)
  assert.ok(canonical === '/Volumes/LifeWeave/Developer/CommandLine/tmp' || canonical.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'))
  assert.equal((await lstat(canonical)).dev, (await lstat('/Volumes/LifeWeave')).dev)
  assert.notEqual((await lstat('/Volumes/LifeWeave')).dev, (await lstat('/')).dev)
  root = await mkdtemp(path.join(canonical, 'packaged-bootstrap-'))
  resourceFixture = path.join(root, 'signed-resource-fixture')
  // 此夹具只证明资源准入；真实包内路由另由候选 App Gate 证明。
  const supplied = process.env.MUSIC_BRIDGE_RUST_RESOURCE_TEST_BINARY
  assert.ok(supplied && path.isAbsolute(supplied), '必须显式提供已构建的资源行为测试二进制。')
  assert.equal(await realpath(supplied), supplied)
  const identity = await lstat(supplied)
  assert.ok(identity.isFile() && identity.size <= 64 * 1024 * 1024)
  assert.equal(identity.dev, (await lstat('/Volumes/LifeWeave')).dev)
  await copyFile(supplied, resourceFixture)
  await chmod(resourceFixture, 0o700)
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', resourceFixture], { stdio: 'pipe' })
})

async function fixture(t: test.TestContext) {
  const base = await mkdtemp(path.join(root, 'case-')), resources = path.join(base, 'Resources')
  const directory = path.join(resources, RUST_RESOURCE_RELATIVE_ROOT)
  await mkdir(path.join(directory, 'bin'), { recursive: true, mode: 0o700 })
  const binaryPath = path.join(directory, RUST_BINARY_RELATIVE_PATH)
  await copyFile(resourceFixture, binaryPath); await chmod(binaryPath, 0o700)
  const manifest = await createRustResourceManifest({ binaryPath, sourceCommit: 'a'.repeat(40), sourceSha256: 'b'.repeat(64) })
  const manifestPath = path.join(directory, 'manifest.json'), bytes = JSON.stringify(manifest) + '\n'
  await writeFile(manifestPath, bytes, { mode: 0o600, flag: 'wx' })
  const descriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: resources })
  t.after(() => { if (descriptor) Object.defineProperty(process, 'resourcesPath', descriptor); else Reflect.deleteProperty(process, 'resourcesPath') })
  return { resources, binaryPath, manifestPath, manifest, pin: digest(bytes) }
}

test('可信候选工厂只准入实际 Resources 与独立 pin，固定只读 v2 能力并通知不可变资源', async t => {
  const value = await fixture(t), resources: unknown[] = []
  const observer: NonNullable<PackagedRustCoreHooks['onObservation']> = () => {}
  const result = await createPackagedRustReadonlyFactory(value.pin, { onObservation: observer, onResourceValidated(resource) {
    resources.push(resource); assert.ok(Object.isFrozen(resource)); assert.ok(Object.isFrozen(resource.binary))
  } })()
  assert.deepEqual(result, { binary: { path: value.binaryPath, sha256: value.manifest.binary.sha256 }, snapshotProfile: 'v2-2000', onObservation: observer })
  assert.ok(Object.isFrozen(result)); assert.equal(resources.length, 1)
})

test('候选host同步原样转交第九可信工厂，创建时不读取资源、不创建Owner', async t => {
  const value = await fixture(t), calls: Parameters<typeof runCoreUtilityProcess>[] = []
  let validated = 0
  const env = { MUSIC_BRIDGE_DATA_DIRECTORY: path.join(root, 'unused-data'), MUSIC_BRIDGE_RUST_BINARY: '/合成任意外置binary',
    MUSIC_BRIDGE_RUST_SHA256: 'c'.repeat(64), MUSIC_BRIDGE_RUST_ENABLED: '0', MUSIC_BRIDGE_RUST_SNAPSHOT_PROFILE: 'v3-5000' }
  const controller: NonNullable<PackagedRustCoreHooks['onRustReadonlyCoreController']> = () => {}
  let resolveRun!: () => void
  const promise = new Promise<void>(resolve => { resolveRun = resolve })
  const started = startPackagedRustCoreHost(value.pin, { env, onRustReadonlyCoreController: controller,
    onResourceValidated() { validated++ }, dependencies: { runCoreUtilityProcess: (...args) => { calls.push(args); return promise } } })
  assert.equal(started, promise); assert.equal(calls.length, 1); assert.equal(validated, 0)
  assert.equal(calls[0]!.length, 9); assert.equal(calls[0]![0], env); assert.equal(calls[0]![6], undefined); assert.equal(calls[0]![7], controller)
  assert.equal((await calls[0]![8]!()).binary.path, value.binaryPath)
  assert.equal(validated, 1); resolveRun(); await started
})

test('环境/参数/附加hooks不能选择资源根、binary、pin或large profile', async t => {
  const value = await fixture(t)
  const hooks = { env: { MUSIC_BRIDGE_RESOURCES_DIRECTORY: '/合成其他Resources', MUSIC_BRIDGE_RUST_BINARY: '/合成其他binary',
    MUSIC_BRIDGE_RUST_MANIFEST_SHA256: 'f'.repeat(64), MUSIC_BRIDGE_RUST_SNAPSHOT_PROFILE: 'v3-5000' },
    resourcesDirectory: '/合成其他Resources', binary: { path: '/合成其他binary' }, expectedManifestSha256: 'f'.repeat(64), snapshotProfile: 'v3-5000' }
  const result = await createPackagedRustReadonlyFactory(value.pin, hooks)()
  assert.equal(result.binary.path, value.binaryPath); assert.equal(result.snapshotProfile, 'v2-2000')
  await assert.rejects(createPackagedRustReadonlyFactory('f'.repeat(64), hooks)())
})

test('factory固定创建时的观察函数，外部变更不能替换在途hooks', async t => {
  const value = await fixture(t)
  const observed: NonNullable<PackagedRustCoreHooks['onObservation']> = () => {}
  let notifications = 0
  const hooks: PackagedRustCoreHooks = { onObservation: observed, onResourceValidated() { notifications++ } }
  const factory = createPackagedRustReadonlyFactory(value.pin, hooks)
  hooks.onObservation = () => { throw new Error('不能替换观察者') }
  hooks.onResourceValidated = () => { throw new Error('不能替换通知') }
  assert.equal((await factory()).onObservation, observed); assert.equal(notifications, 1)
})

for (const mode of ['throw', 'promise'] as const) {
  test(`资源通知 ${mode} 不能阻塞或扩大准入`, async t => {
    const value = await fixture(t)
    const callback = (() => { if (mode === 'throw') throw new Error('合成通知故障'); return Promise.reject(new Error('迟到合成通知故障')) }) as (resource: unknown) => void
    await assert.rejects(createPackagedRustReadonlyFactory(value.pin, { onResourceValidated: callback })())
  })
}

test('邻近清单更换后拒绝原编译pin，不重新读取可信pin、不发validated', async t => {
  const value = await fixture(t)
  let notifications = 0
  const factory = createPackagedRustReadonlyFactory(value.pin, { onResourceValidated() { notifications++ } })
  await writeFile(value.manifestPath, JSON.stringify({ ...value.manifest, source: { ...value.manifest.source, commit: 'd'.repeat(40) } }) + '\n')
  await assert.rejects(factory()); assert.equal(notifications, 0)
})

test('候选固定编译pin，正常入口默认关闭并惰性附加固定只读manager', async () => {
  const candidate = await readFile(new URL('../../src/main/packaged-rust-core-entry.ts', import.meta.url), 'utf8')
  const production = await readFile(new URL('../../src/main/core-entry.ts', import.meta.url), 'utf8')
  assert.match(candidate, /installPackagedRouteCoreObserver\('rust'\)/u)
  assert.match(candidate, /startPackagedRustCoreHost\(__MUSIC_BRIDGE_RUST_MANIFEST_SHA256__, hooks\)/u)
  assert.doesNotMatch(candidate, /process\.env|process\.argv|utilityProcess\.fork/u)
  assert.match(production, /createOptionalRustReadonlyManager/u)
  assert.match(production, /createPackagedRustReadonlyFactory\(__MUSIC_BRIDGE_RUST_MANIFEST_SHA256__, hooks\)/u)
  assert.match(production, /void runDesktopCoreHost\(\{ optionalReadonlyManager: manager/u)
  assert.doesNotMatch(production, /process\.env|process\.argv|startPackagedRustCoreHost/u)
})
