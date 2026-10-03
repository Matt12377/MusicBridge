import assert from 'node:assert/strict'
import test from 'node:test'
import { runRustOfflineCandidateProtocol } from '../helpers/rust-offline-candidate-protocol.js'

for (const [name, value] of [['空值', null], ['任意环境开关', { env: {} }], ['本机用户证据路径', {
  resourcesDirectory: '/Users/yihe/Library/Application Support/MusicBridge', expectedManifestSha256: 'a'.repeat(64),
  evidenceDirectory: '/Users/yihe/protocol' }], ['未知binary选项', { resourcesDirectory: '/任意', expectedManifestSha256: 'a'.repeat(64), evidenceDirectory: '/任意', binary: {} }]] as const) {
  test(`协议拒绝${name}，不创建目录或启动进程`, async () => {
    await assert.rejects(runRustOfflineCandidateProtocol(value), /候选协议配置未准入/u)
  })
}

import { before } from 'node:test'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, lstat, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRustResourceManifest } from '../../scripts/rust-native-package.mjs'

const external = '/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-011-3samm9m1'
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
let fixtureRoot: string
before(async () => {
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64')
  assert.ok(process.versions.node.startsWith('22.'))
  assert.notEqual((await lstat('/Volumes/LifeWeave')).dev, (await lstat('/')).dev)
  assert.equal(await realpath(external), external)
  fixtureRoot = await mkdtemp(path.join(external, 'c-protocol-behavior-'))
})
async function actualFixture() {
  const source = process.env.MUSIC_BRIDGE_RUST_RESOURCE_TEST_BINARY
  assert.ok(source && source.startsWith(external + '/') && await realpath(source) === source,
    '真实协议行为测试必须显式提供fresh011二进制；缺失失败，不下载、不skip。')
  const directory = await mkdtemp(path.join(fixtureRoot, 'resource-'))
  const resourcesDirectory = path.join(directory, 'ProtocolFixture.app/Contents/Resources')
  const native = path.join(resourcesDirectory, 'rust-core/darwin-arm64')
  await mkdir(path.join(native, 'bin'), { recursive: true, mode: 0o700 })
  const binaryPath = path.join(native, 'bin/musicbridge-rust-core')
  await copyFile(source, binaryPath, constants.COPYFILE_EXCL); await chmod(binaryPath, 0o700)
  const sign = spawnSync('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', binaryPath], { encoding: 'utf8' })
  assert.equal(sign.status, 0, sign.stderr); assert.equal(sign.signal, null)
  const manifest = await createRustResourceManifest({ binaryPath, sourceCommit: 'ed40e39c39db908200e946c0c13dcfc1ddc0a206', sourceSha256: 'b'.repeat(64) })
  const bytes = JSON.stringify(manifest) + '\n'
  await writeFile(path.join(native, 'manifest.json'), bytes, { flag: 'wx', mode: 0o600 })
  return { directory, native, binaryPath, options: { resourcesDirectory, expectedManifestSha256: hash(bytes), evidenceDirectory: path.join(directory, 'protocol') } }
}

test('fresh011实际签后资源→原Node两库原子快照→原Rust协议，完整DTO及每个资源自然退出', async () => {
  const fixture = await actualFixture(), report = await runRustOfflineCandidateProtocol(fixture.options)
  assert.equal(report.modelCount, 100); assert.equal(report.comparisons.length, 56)
  assert.deepEqual(report.nodeSessions.map(session => session.exitCode), [0, 0])
  assert.deepEqual(report.rust.exit, { code: 0, signal: null }); assert.equal(report.rust.killCalls, 0)
  assert.deepEqual(report.rust.acknowledgements.map((reply: any) => reply.operation), ['prepare', 'commitBoot', ...Array.from({ length: 56 }, () => 'dispatch'), 'close'])
  assert.ok(report.rust.acknowledgements.every((reply: any) => reply.protocolVersion === 2 && reply.ok === true))
  assert.deepEqual(report.databasesBefore, report.databasesAfter); assert.equal(report.closedDatabases.length, 4)
  assert.equal(report.forcedCleanup, false); assert.equal(report.ownerAcceptance, 'NOT_RUN')
  assert.equal(report.evidence.sha256, hash(await readFile(report.evidence.path)))
  assert.equal(report.packagedRustMainCoreRoute, 'NOT_IN_SCOPE')
})

test('仓库根cwd调用真实协议helper仍从桌面依赖定位Worker加载器', async () => {
  const fixture = await actualFixture()
  const helper = new URL('../helpers/rust-offline-candidate-protocol.ts', import.meta.url).href
  const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e',
    `const {runRustOfflineCandidateProtocol}=await import(${JSON.stringify(helper)}); const report=await runRustOfflineCandidateProtocol(${JSON.stringify(fixture.options)}); console.log(JSON.stringify({modelCount:report.modelCount,nodeExits:report.nodeSessions.map(session=>session.exitCode),rustExit:report.rust.exit,comparisons:report.comparisons.length}));`],
  { cwd: fileURLToPath(new URL('../../../..', import.meta.url)), encoding: 'utf8', timeout: 30000,
    env: { TMPDIR: process.env.TMPDIR, DEV_BUILD_ROOT: process.env.DEV_BUILD_ROOT, DEV_CACHE_ROOT: process.env.DEV_CACHE_ROOT } })
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr); assert.equal(result.signal, null)
  assert.deepEqual(JSON.parse(result.stdout.trim()), { modelCount: 100, nodeExits: [0, 0], rustExit: { code: 0, signal: null }, comparisons: 56 })
})

test('固定manifest pin漂移拒绝于创建合成目录和进程之前', async () => {
  const fixture = await actualFixture()
  await assert.rejects(runRustOfflineCandidateProtocol({ ...fixture.options, expectedManifestSha256: 'c'.repeat(64) }))
  await assert.rejects(lstat(fixture.options.evidenceDirectory), { code: 'ENOENT' })
})
test('已有证据目录拒绝复用，保留原字节', async () => {
  const fixture = await actualFixture()
  await mkdir(fixture.options.evidenceDirectory, { mode: 0o700 })
  const marker = path.join(fixture.options.evidenceDirectory, '保留.txt')
  await writeFile(marker, '旧证据保留', { flag: 'wx', mode: 0o600 })
  await assert.rejects(runRustOfflineCandidateProtocol(fixture.options), { code: 'EEXIST' })
  assert.equal(await readFile(marker, 'utf8'), '旧证据保留')
})
test('协议配置拒绝访问器/Proxy/隐藏字段，不执行其代码', async () => {
  let calls = 0
  const value = { resourcesDirectory: '/任意', expectedManifestSha256: 'a'.repeat(64), evidenceDirectory: '/任意' }
  Object.defineProperty(value, 'resourcesDirectory', { enumerable: true, get() { calls++; return '/任意' } })
  await assert.rejects(runRustOfflineCandidateProtocol(value), /候选协议配置未准入/u)
  await assert.rejects(runRustOfflineCandidateProtocol(new Proxy({}, { ownKeys() { calls++; return [] } })), /候选协议配置未准入/u)
  assert.equal(calls, 0)
})
