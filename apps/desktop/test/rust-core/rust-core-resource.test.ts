import assert from 'node:assert/strict'
import test, { before } from 'node:test'
import { constants } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { resolveRustCoreResource, type RustCoreResourceOptions } from '../../src/main/rust-core-resource.js'
import { createRustResourceManifest, RUST_RESOURCE_RELATIVE_ROOT, RUST_BINARY_RELATIVE_PATH } from '../../scripts/rust-native-package.mjs'

const stage = '/Volumes/LifeWeave/Developer/CommandLine/tmp'
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
let root: string, signedBinary: string

before(async () => {
  assert.equal(process.platform, 'darwin', '资源行为测试必须在实际 macOS 执行，不能 skip。')
  assert.equal(process.arch, 'arm64', '资源行为测试必须在实际 arm64 执行，不能 skip。')
  assert.equal(await realpath(stage), stage, '夹具根必须是外置真实路径。')
  assert.equal((await lstat(stage)).dev, (await lstat('/Volumes/LifeWeave')).dev)
  assert.notEqual((await lstat('/Volumes/LifeWeave')).dev, (await lstat('/')).dev, 'LifeWeave 必须确实挂载外置卷。')
  const source = process.env.MUSIC_BRIDGE_RUST_RESOURCE_TEST_BINARY
  assert.ok(source && path.isAbsolute(source), '必须显式给出已构建的测试 Rust 二进制，不下载或回落。')
  assert.equal(await realpath(source), source)
  assert.ok((await lstat(source)).isFile())
  root = await mkdtemp(path.join(stage, 'mb-rust-resource-behavior-'))
  signedBinary = path.join(root, 'signed-fixture')
  await copyFile(source, signedBinary, constants.COPYFILE_EXCL)
  await chmod(signedBinary, 0o700)
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', signedBinary], { stdio: 'pipe', timeout: 10_000 })
})

async function fixture() {
  const base = await mkdtemp(path.join(root, 'case-')), resourcesDirectory = path.join(base, 'Resources')
  const directory = path.join(resourcesDirectory, RUST_RESOURCE_RELATIVE_ROOT)
  await mkdir(path.join(directory, 'bin'), { recursive: true, mode: 0o700 })
  const binaryPath = path.join(directory, RUST_BINARY_RELATIVE_PATH)
  await copyFile(signedBinary, binaryPath, constants.COPYFILE_EXCL)
  await chmod(binaryPath, 0o700)
  const manifest = await createRustResourceManifest({ binaryPath, sourceCommit: 'a'.repeat(40), sourceSha256: 'b'.repeat(64) })
  const manifestPath = path.join(directory, 'manifest.json'), bytes = JSON.stringify(manifest) + '\n'
  await writeFile(manifestPath, bytes, { flag: 'wx', mode: 0o600 })
  return { base, directory, binaryPath, manifestPath, manifest,
    options: { resourcesDirectory, expectedManifestSha256: digest(bytes) } }
}
const resolveUnknown = (options: unknown) => resolveRustCoreResource(options as RustCoreResourceOptions)

test('可信独立 pin 定位实际 Resources 下签后资源，返回完整且不可变身份', async () => {
  const value = await fixture(), result = await resolveRustCoreResource(value.options)
  assert.deepEqual(result, { binary: { path: value.binaryPath, sha256: value.manifest.binary.sha256 },
    manifestSha256: value.options.expectedManifestSha256, manifest: value.manifest })
  for (const object of [result, result.binary, result.manifest, result.manifest.binary, result.manifest.source]) assert.ok(Object.isFrozen(object))
  assert.throws(() => Object.assign(result.binary, { path: '/任意路径' }), TypeError)
})

for (const extra of ['binary', 'platform', 'arch', 'env', 'snapshotProfile', 'validator', 'onRustReadonlyCoreController']) {
  test(`资源解析拒绝额外配置 ${extra}，有效资源也不能扩大能力`, async () => {
    const value = await fixture()
    await assert.rejects(resolveUnknown({ ...value.options, [extra]: '未授权' }), /Rust 资源配置无效/u)
  })
}
test('资源配置拒绝 Symbol、访问器、Proxy 和自定义原型，不执行其 getter', async () => {
  const value = await fixture(), symbol = Symbol('额外配置')
  await assert.rejects(resolveUnknown({ ...value.options, [symbol]: true }), /Rust 资源配置无效/u)
  let calls = 0
  const getter = { ...value.options }
  Object.defineProperty(getter, 'resourcesDirectory', { enumerable: true, get() { calls++; return value.options.resourcesDirectory } })
  await assert.rejects(resolveUnknown(getter), /Rust 资源配置无效/u)
  await assert.rejects(resolveUnknown(new Proxy(value.options, { get(target, key) { calls++; return Reflect.get(target, key) } })), /Rust 资源配置无效/u)
  await assert.rejects(resolveUnknown(Object.assign(Object.create({ inherited: true }), value.options)), /Rust 资源配置无效/u)
  assert.equal(calls, 0)
})
test('资源配置拒绝缺字段、非字符串、非法摘要及非对象', async () => {
  const value = await fixture()
  for (const candidate of [null, [], undefined, {}, { resourcesDirectory: value.options.resourcesDirectory },
    { ...value.options, expectedManifestSha256: 'A'.repeat(64) }, { ...value.options, expectedManifestSha256: 'a'.repeat(63) },
    { ...value.options, expectedManifestSha256: 0 }, { ...value.options, resourcesDirectory: 0 }]) {
    await assert.rejects(resolveUnknown(candidate), /Rust 资源配置无效/u)
  }
})
test('独立 pin 不接受旁边新清单，不重新推定当前可信身份', async () => {
  const value = await fixture()
  await assert.rejects(resolveRustCoreResource({ ...value.options, expectedManifestSha256: 'c'.repeat(64) }))
  await writeFile(value.manifestPath, JSON.stringify({ ...value.manifest, source: { ...value.manifest.source, commit: 'd'.repeat(40) } }) + '\n')
  await assert.rejects(resolveRustCoreResource(value.options))
})
test('首次 await 前固定可信字段，调用方变更不能替换在途资源或 pin', async () => {
  const value = await fixture(), expectedPath = value.binaryPath, expectedPin = value.options.expectedManifestSha256
  const resolving = resolveRustCoreResource(value.options)
  value.options.resourcesDirectory = path.join(value.base, '不存在的资源')
  value.options.expectedManifestSha256 = 'e'.repeat(64)
  const result = await resolving
  assert.equal(result.binary.path, expectedPath)
  assert.equal(result.manifestSha256, expectedPin)
  await assert.rejects(resolveRustCoreResource(value.options))
})
test('开发二进制环境变量不选择资源，也不能覆盖独立可信 pin', async () => {
  const value = await fixture(), keys = ['MUSIC_BRIDGE_RUST_BINARY', 'MUSIC_BRIDGE_RUST_SHA256'] as const
  const originals = keys.map(key => process.env[key])
  try {
    process.env.MUSIC_BRIDGE_RUST_BINARY = '/任意外置二进制'
    process.env.MUSIC_BRIDGE_RUST_SHA256 = value.manifest.binary.sha256
    assert.equal((await resolveRustCoreResource(value.options)).binary.path, value.binaryPath)
    await assert.rejects(resolveRustCoreResource({ ...value.options, expectedManifestSha256: 'f'.repeat(64) }))
  } finally {
    keys.forEach((key, index) => { if (originals[index] === undefined) delete process.env[key]; else process.env[key] = originals[index] })
  }
})
test('Resources 必须是规范绝对真实路径，拒绝相对、别名、空字节和过长路径', async () => {
  const value = await fixture()
  for (const resourcesDirectory of ['Resources', '', `${value.options.resourcesDirectory}/`,
    `${value.base}/./Resources`, `${value.base}/Resources/../Resources`, `${value.options.resourcesDirectory}\0`, `/${'a'.repeat(1024)}`]) {
    await assert.rejects(resolveRustCoreResource({ ...value.options, resourcesDirectory }), /Rust 资源路径未准入/u)
  }
})
test('拒绝不存在或非目录的 Resources，不自动创建或回落', async () => {
  const value = await fixture(), absent = path.join(value.base, '不存在')
  await assert.rejects(resolveRustCoreResource({ ...value.options, resourcesDirectory: absent }), /Rust 资源路径未准入/u)
  await assert.rejects(lstat(absent), { code: 'ENOENT' })
  await assert.rejects(resolveRustCoreResource({ ...value.options, resourcesDirectory: value.binaryPath }), /Rust 资源路径未准入/u)
})
test('有效资源经 Resources 根链接或任一父目录链接仍拒绝', async () => {
  const value = await fixture(), rootLink = path.join(value.base, '资源链接'), parentLink = path.join(root, '父目录链接-' + path.basename(value.base))
  await symlink(value.options.resourcesDirectory, rootLink)
  await symlink(value.base, parentLink)
  for (const resourcesDirectory of [rootLink, path.join(parentLink, 'Resources')]) {
    await assert.rejects(resolveRustCoreResource({ ...value.options, resourcesDirectory }), /Rust 资源路径未准入/u)
  }
})
test('Resources 根组或其他用户可写时拒绝，即使资源签名和 pin 有效', async () => {
  const value = await fixture()
  for (const mode of [0o720, 0o702]) {
    await chmod(value.options.resourcesDirectory, mode)
    await assert.rejects(resolveRustCoreResource(value.options), /Rust 资源路径未准入/u)
  }
  await chmod(value.options.resourcesDirectory, 0o700)
  assert.equal((await resolveRustCoreResource(value.options)).binary.path, value.binaryPath)
})
test('实际 Host 非 darwin-arm64 时拒绝；公开配置不能伪造平台', async () => {
  const value = await fixture()
  for (const [key, host] of [['platform', 'linux'], ['arch', 'x64']] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(process, key)!
    try {
      Object.defineProperty(process, key, { ...descriptor, value: host })
      await assert.rejects(resolveRustCoreResource(value.options), /Rust 资源只支持 macOS arm64/u)
    } finally { Object.defineProperty(process, key, descriptor) }
  }
})
test('签后二进制摘要漂移及普通可执行权限丢失沿共享准入拒绝', async () => {
  const changed = await fixture(), bytes = await readFile(changed.binaryPath)
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1
  await writeFile(changed.binaryPath, bytes)
  await assert.rejects(resolveRustCoreResource(changed.options))
  const permission = await fixture()
  await chmod(permission.binaryPath, 0o600)
  await assert.rejects(resolveRustCoreResource(permission.options))
})
test('有效资源中多文件、资源链接和 bin 链接不准入', async () => {
  const extra = await fixture()
  await writeFile(path.join(extra.directory, '多余文件'), '多余')
  await assert.rejects(resolveRustCoreResource(extra.options))
  const linked = await fixture(), alias = path.join(linked.base, 'linked-Resources')
  await mkdir(path.join(alias, 'rust-core'), { recursive: true, mode: 0o700 })
  await symlink(linked.directory, path.join(alias, 'rust-core', 'darwin-arm64'))
  await assert.rejects(resolveRustCoreResource({ ...linked.options, resourcesDirectory: alias }))
  const binLinked = await fixture(), binResources = path.join(binLinked.base, 'bin-linked-Resources')
  const binDirectory = path.join(binResources, RUST_RESOURCE_RELATIVE_ROOT)
  await mkdir(binDirectory, { recursive: true, mode: 0o700 })
  await copyFile(binLinked.manifestPath, path.join(binDirectory, 'manifest.json'), constants.COPYFILE_EXCL)
  await symlink(path.join(binLinked.directory, 'bin'), path.join(binDirectory, 'bin'))
  await assert.rejects(resolveRustCoreResource({ ...binLinked.options, resourcesDirectory: binResources }))
  const missing = await fixture()
  await writeFile(missing.manifestPath, JSON.stringify({ ...missing.manifest, binary: { ...missing.manifest.binary, relativePath: '../musicbridge-rust-core' } }) + '\n')
  const pin = digest(await readFile(missing.manifestPath))
  await assert.rejects(resolveRustCoreResource({ ...missing.options, expectedManifestSha256: pin }))
})

test('二进制与清单重新匹配摘要仍必须通过真实签名，不能将无签名资源准入', async () => {
  const value = await fixture()
  execFileSync('/usr/bin/codesign', ['--remove-signature', value.binaryPath], { stdio: 'pipe', timeout: 10_000 })
  const bytes = await readFile(value.binaryPath)
  const manifest = { ...value.manifest, binary: { ...value.manifest.binary, sha256: digest(bytes), size: bytes.length } }
  const manifestBytes = JSON.stringify(manifest) + '\n'
  await writeFile(value.manifestPath, manifestBytes)
  await assert.rejects(resolveRustCoreResource({ ...value.options, expectedManifestSha256: digest(manifestBytes) }))
})
test('真实签名 x64 与 universal Mach-O 即使摘要匹配也拒绝，不降级架构', async () => {
  for (const universal of [false, true]) {
    const value = await fixture()
    if (universal) await copyFile('/usr/bin/true', value.binaryPath)
    else execFileSync('/usr/bin/lipo', ['/usr/bin/true', '-thin', 'x86_64', '-output', value.binaryPath], { stdio: 'pipe', timeout: 10_000 })
    await chmod(value.binaryPath, 0o700)
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', value.binaryPath], { stdio: 'pipe', timeout: 10_000 })
    const bytes = await readFile(value.binaryPath)
    const display = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', value.binaryPath], { encoding: 'utf8', timeout: 10_000 })
    assert.equal(display.status, 0)
    const cdHash = /^CDHash=([a-f0-9]{40})$/mu.exec(display.stderr)?.[1]
    assert.ok(cdHash, '架构拒绝夹具也须绑定实际签后 CDHash。')
    const manifest = { ...value.manifest, binary: { ...value.manifest.binary, sha256: digest(bytes), size: bytes.length, cdHash } }
    const manifestBytes = JSON.stringify(manifest) + '\n'
    await writeFile(value.manifestPath, manifestBytes)
    await assert.rejects(resolveRustCoreResource({ ...value.options, expectedManifestSha256: digest(manifestBytes) }))
  }
})
