import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, symlink, writeFile, link } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { createRustResourceManifest, validateRustNativeDirectory, stageRustNativeResource,
  RUST_RESOURCE_RELATIVE_ROOT, RUST_BINARY_RELATIVE_PATH, type RustResourceManifest } from '../../scripts/rust-native-package.mjs'

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const sourceCommit = 'e'.repeat(40), sourceSha256 = 'a'.repeat(64)
let suiteRoot: string, signedBinary: string, pinnedManifest: RustResourceManifest
before(async () => {
  assert.equal(process.platform, 'darwin', '本专项必须在真实 macOS 运行，不以 skip 替代。')
  assert.equal(process.arch, 'arm64', '本专项必须在真实 arm64 运行。')
  const tmp = await realpath(os.tmpdir())
  assert.ok(tmp.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'))
  assert.notEqual((await lstat('/Volumes/LifeWeave')).dev, (await lstat('/')).dev)
  const input = process.env.MUSIC_BRIDGE_RUST_RESOURCE_TEST_BINARY
  assert.ok(input && path.isAbsolute(input), '专项必须明确提供既有真实 Rust binary，不下载或编译替代。')
  suiteRoot = await mkdtemp(path.join(tmp, 'rust-native-a-'))
  signedBinary = path.join(suiteRoot, 'signed-rust-fixture')
  await copyFile(input, signedBinary); await chmod(signedBinary, 0o700)
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', signedBinary], { stdio: 'pipe' })
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', signedBinary], { stdio: 'pipe' })
  // codesign display 的材料在 stderr；使用 spawnSync 保留，不从测试程序注入验证器。
  const { spawnSync } = await import('node:child_process')
  const display = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', signedBinary], { encoding: 'utf8' })
  assert.equal(display.status, 0)
  const cdHash = /^CDHash=([a-f0-9]{40})$/m.exec(display.stderr)?.[1]
  assert.ok(cdHash); assert.match(display.stderr, /^Signature=adhoc$/m)
  const bytes = await readFile(signedBinary)
  pinnedManifest = { schemaVersion: 1, kind: 'musicbridge-rust-readonly-resource', platform: 'darwin', arch: 'arm64', protocolVersion: 2,
    source: { commit: sourceCommit, sha256: sourceSha256 }, binary: { relativePath: 'bin/musicbridge-rust-core', sha256: sha(bytes), size: bytes.length, cdHash } }
})
async function fixture() {
  const parent = await mkdtemp(path.join(suiteRoot, 'case-')), directory = path.join(parent, 'resource')
  await mkdir(path.join(directory, 'bin'), { recursive: true, mode: 0o700 })
  const binaryPath = path.join(directory, RUST_BINARY_RELATIVE_PATH)
  await copyFile(signedBinary, binaryPath); await chmod(binaryPath, 0o700)
  const manifest = structuredClone(pinnedManifest)
  const pin = await save(directory, manifest)
  return { parent, directory, binaryPath, manifest, pin }
}
async function save(directory: string, manifest: unknown) {
  const bytes = JSON.stringify(manifest) + '\n'
  await writeFile(path.join(directory, 'manifest.json'), bytes, { mode: 0o600 }); return sha(bytes)
}
async function rejected(input: Parameters<typeof validateRustNativeDirectory>[0]) {
  await assert.rejects(validateRustNativeDirectory(input), error => error instanceof Error && /^Rust 资源/.test(error.message))
}
test('真实签后薄 arm64 清单创建与目录准入，固定路径不漂移', async () => {
  const x = await fixture()
  assert.equal(RUST_RESOURCE_RELATIVE_ROOT, 'rust-core/darwin-arm64'); assert.equal(RUST_BINARY_RELATIVE_PATH, 'bin/musicbridge-rust-core')
  assert.deepEqual(await createRustResourceManifest({ binaryPath: x.binaryPath, sourceCommit, sourceSha256 }), x.manifest)
  const checked = await validateRustNativeDirectory({ directory: x.directory, expectedManifestSha256: x.pin })
  assert.deepEqual(checked, { manifest: x.manifest, manifestSha256: x.pin, binaryPath: x.binaryPath, binarySha256: x.manifest.binary.sha256, cdHash: x.manifest.binary.cdHash })
})
const manifestChanges: [string, (m: any) => void][] = [
  ['未知顶层键', m => { m.extra = 1 }], ['缺少来源', m => { delete m.source }], ['错误schema', m => { m.schemaVersion = 2 }],
  ['错误kind', m => { m.kind = 'other' }], ['错误平台', m => { m.platform = 'linux' }], ['错误架构', m => { m.arch = 'x64' }],
  ['错误协议', m => { m.protocolVersion = 1 }], ['未知source键', m => { m.source.path = '/secret' }], ['非法commit', m => { m.source.commit = 'x'.repeat(40) }],
  ['非法source摘要', m => { m.source.sha256 = 'A'.repeat(64) }], ['未知binary键', m => { m.binary.extra = true }],
  ['路径穿越', m => { m.binary.relativePath = '../musicbridge-rust-core' }], ['错误binary摘要', m => { m.binary.sha256 = '0'.repeat(64) }],
  ['错误binary大小', m => { m.binary.size++ }], ['小数大小', m => { m.binary.size = 1.5 }], ['非法CDHash', m => { m.binary.cdHash = 'x'.repeat(40) }],
  ['错配CDHash', m => { m.binary.cdHash = '0'.repeat(40) }],
]
for (const [name, change] of manifestChanges) test(`即使重新pin也拒绝${name}`, async () => {
  const x = await fixture(); change(x.manifest); await rejected({ directory: x.directory, expectedManifestSha256: await save(x.directory, x.manifest) })
})
test('邻接清单更新不能代替独立构建pin', async () => { const x = await fixture(); x.manifest.source.commit = 'b'.repeat(40); await save(x.directory, x.manifest); await rejected({ directory: x.directory, expectedManifestSha256: x.pin }) })
test('重复JSON键即使独立pin匹配仍拒绝', async () => { const x = await fixture(); const bytes = JSON.stringify(x.manifest).replace('"schemaVersion":1', '"schemaVersion":2,"schemaVersion":1'); await writeFile(path.join(x.directory, 'manifest.json'), bytes); await rejected({ directory: x.directory, expectedManifestSha256: sha(bytes) }) })
test('未知调用配置不能取得准入', async () => { const x = await fixture(); await rejected({ directory: x.directory, expectedManifestSha256: x.pin, allowUnsigned: true } as any) })
for (const [platform, arch] of [['linux', 'arm64'], ['darwin', 'x64'], ['darwin', 'universal']]) test(`拒绝${platform}/${arch}`, async () => { const x = await fixture(); await rejected({ directory: x.directory, expectedManifestSha256: x.pin, platform, arch }) })
for (const name of ['root', 'bin', 'binary', 'manifest']) test(`拒绝${name}组可写`, async () => {
  const x = await fixture(), file = name === 'root' ? x.directory : name === 'bin' ? path.join(x.directory, 'bin') : name === 'binary' ? x.binaryPath : path.join(x.directory, 'manifest.json')
  await chmod(file, name === 'root' || name === 'bin' || name === 'binary' ? 0o770 : 0o660); await rejected({ directory: x.directory, expectedManifestSha256: x.pin })
})
test('拒绝无执行权限', async () => { const x = await fixture(); await chmod(x.binaryPath, 0o600); await rejected({ directory: x.directory, expectedManifestSha256: x.pin }) })
for (const where of ['root', 'bin', 'binary', 'manifest', 'ancestor']) test(`拒绝${where}符号链接`, async () => {
  const x = await fixture(); let directory = x.directory
  if (where === 'ancestor') { const alias = path.join(suiteRoot, `alias-${path.basename(x.parent)}`); await symlink(x.parent, alias); directory = path.join(alias, 'resource') }
  else { const target = where === 'root' ? x.directory : where === 'bin' ? path.join(x.directory, 'bin') : where === 'binary' ? x.binaryPath : path.join(x.directory, 'manifest.json'); await rename(target, target + '.original'); await symlink(target + '.original', target) }
  await rejected({ directory, expectedManifestSha256: x.pin })
})
for (const where of ['root', 'bin']) test(`拒绝${where}额外资源`, async () => { const x = await fixture(); await writeFile(path.join(x.directory, ...(where === 'bin' ? ['bin'] : []), 'extra'), 'extra'); await rejected({ directory: x.directory, expectedManifestSha256: x.pin }) })
test('拒绝binary硬链接', async () => { const x = await fixture(); await link(x.binaryPath, path.join(x.parent, 'hardlink')); await rejected({ directory: x.directory, expectedManifestSha256: x.pin }) })
test('不信任清单arm64：实际x64 header拒绝', async () => { const x = await fixture(); const b = await readFile(x.binaryPath); b.writeUInt32LE(0x01000007, 4); await writeFile(x.binaryPath, b); x.manifest.binary.sha256 = sha(b); await rejected({ directory: x.directory, expectedManifestSha256: await save(x.directory, x.manifest) }) })
test('拒绝fat/universal header', async () => { const x = await fixture(); const b = await readFile(x.binaryPath); b.writeUInt32BE(0xcafebabe, 0); await writeFile(x.binaryPath, b); x.manifest.binary.sha256 = sha(b); await rejected({ directory: x.directory, expectedManifestSha256: await save(x.directory, x.manifest) }) })
test('签后内容被修改且重新pin仍拒绝实际签名', async () => { const x = await fixture(); const b = await readFile(x.binaryPath); b[4096] ^= 1; await writeFile(x.binaryPath, b); x.manifest.binary.sha256 = sha(b); await rejected({ directory: x.directory, expectedManifestSha256: await save(x.directory, x.manifest) }) })
test('移除签名且重新pin仍拒绝', async () => { const x = await fixture(); execFileSync('/usr/bin/codesign', ['--remove-signature', x.binaryPath]); const b = await readFile(x.binaryPath); x.manifest.binary.sha256 = sha(b); x.manifest.binary.size = b.length; await rejected({ directory: x.directory, expectedManifestSha256: await save(x.directory, x.manifest) }) })
test('create拒绝未知配置、坏来源身份及未签文件，不隐式签名', async () => {
  const x = await fixture()
  for (const fields of [{ extra: true }, { sourceCommit: 'x' }, { sourceSha256: 'x' }]) await assert.rejects(createRustResourceManifest({ binaryPath: x.binaryPath, sourceCommit, sourceSha256, ...fields } as any))
  execFileSync('/usr/bin/codesign', ['--remove-signature', x.binaryPath]); const before = sha(await readFile(x.binaryPath))
  await assert.rejects(createRustResourceManifest({ binaryPath: x.binaryPath, sourceCommit, sourceSha256 })); assert.equal(sha(await readFile(x.binaryPath)), before)
})
test('stage只建立固定新资源根且复制后真实复验', async () => {
  const x = await fixture(), resourcesDirectory = path.join(x.parent, 'Resources'); await mkdir(resourcesDirectory, { mode: 0o700 })
  const result = await stageRustNativeResource({ sourceDirectory: x.directory, resourcesDirectory, expectedManifestSha256: x.pin })
  assert.equal(result.binaryPath, path.join(resourcesDirectory, RUST_RESOURCE_RELATIVE_ROOT, RUST_BINARY_RELATIVE_PATH)); assert.deepEqual(result.manifest, x.manifest)
  assert.deepEqual(await readFile(result.binaryPath), await readFile(x.binaryPath))
  await assert.rejects(stageRustNativeResource({ sourceDirectory: x.directory, resourcesDirectory, expectedManifestSha256: x.pin }))
  assert.equal(sha(await readFile(result.binaryPath)), x.manifest.binary.sha256)
})
test('stage源未准入或目的组可写时不创建root', async () => {
  const x = await fixture(), resourcesDirectory = path.join(x.parent, 'Resources'); await mkdir(resourcesDirectory, { mode: 0o700 })
  await assert.rejects(stageRustNativeResource({ sourceDirectory: x.directory, resourcesDirectory, expectedManifestSha256: '0'.repeat(64) }))
  await assert.rejects(lstat(path.join(resourcesDirectory, RUST_RESOURCE_RELATIVE_ROOT)), { code: 'ENOENT' })
  await chmod(resourcesDirectory, 0o770); await assert.rejects(stageRustNativeResource({ sourceDirectory: x.directory, resourcesDirectory, expectedManifestSha256: x.pin }))
  await assert.rejects(lstat(path.join(resourcesDirectory, RUST_RESOURCE_RELATIVE_ROOT)), { code: 'ENOENT' })
})
test('准入拒绝访问器和原型配置，且不求值访问器', async () => {
  const x = await fixture(); let calls = 0
  const getter = { get directory() { calls++; return x.directory }, expectedManifestSha256: x.pin }
  await rejected(getter); assert.equal(calls, 0)
  await rejected(Object.assign(Object.create({ inherited: true }), { directory: x.directory, expectedManifestSha256: x.pin }))
})
test('异步准入绑定调用时参数，后续调用方修改不切换资源身份', async () => {
  const x = await fixture(), input = { directory: x.directory, expectedManifestSha256: x.pin }
  const pending = validateRustNativeDirectory(input); input.directory = '/unknown'; input.expectedManifestSha256 = '0'.repeat(64)
  assert.equal((await pending).binaryPath, x.binaryPath)
})
test('stage拒绝Resources父链接与已有固定root，不改已有资源', async () => {
  const x = await fixture(), resources = path.join(x.parent, 'Resources'); await mkdir(resources, { mode: 0o700 })
  const alias = path.join(x.parent, 'Resources-alias'); await symlink(resources, alias)
  await assert.rejects(stageRustNativeResource({ sourceDirectory: x.directory, resourcesDirectory: alias, expectedManifestSha256: x.pin }))
  await mkdir(path.join(resources, RUST_RESOURCE_RELATIVE_ROOT), { recursive: true, mode: 0o700 })
  const marker = path.join(resources, RUST_RESOURCE_RELATIVE_ROOT, 'keep'); await writeFile(marker, '原文件')
  await assert.rejects(stageRustNativeResource({ sourceDirectory: x.directory, resourcesDirectory: resources, expectedManifestSha256: x.pin }))
  assert.equal(await readFile(marker, 'utf8'), '原文件')
})
test('stage未知字段与源内部目的拒绝且无复制', async () => {
  const x = await fixture()
  await assert.rejects(stageRustNativeResource({ sourceDirectory: x.directory, resourcesDirectory: x.parent, expectedManifestSha256: x.pin, allowOverwrite: true } as any))
  await assert.rejects(stageRustNativeResource({ sourceDirectory: x.directory, resourcesDirectory: x.directory, expectedManifestSha256: x.pin }))
  await assert.rejects(lstat(path.join(x.directory, RUST_RESOURCE_RELATIVE_ROOT)), { code: 'ENOENT' })
})
