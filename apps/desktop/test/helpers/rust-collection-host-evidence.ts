import { readRustElectronHostsReceipt } from '../../../../scripts/ci/rust-electron-host-receipt.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RustReadonlyCoreDatasetOwnerStatus } from '../../../../packages/bridge-core/src/rust-core/core-dataset-owner.js'

export interface HostObservation { sequence: number; elapsedMs: number; event: string; [key: string]: unknown }
export interface HostSnapshot { rustConfigured: boolean; configuredModels: number; observations: HostObservation[]; controller?: RustReadonlyCoreDatasetOwnerStatus }
export interface BuildManifest { schemaVersion: number; task: string; sourceSha: string; sourceAggregateSha256: string; binaryPath: string; binarySha256: string; artifacts: { path: string; sha256: string; bytes: number }[]; sources: { path: string; sha256: string }[] }
export const buildRoot = process.env.MUSIC_BRIDGE_RUST_COLLECTION_HOST_BUILD_ROOT ?? ''
if (process.env.MUSIC_BRIDGE_RUST_HOSTS_RECEIPT) {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
  const receipt = readRustElectronHostsReceipt(process.env.MUSIC_BRIDGE_RUST_HOSTS_RECEIPT, repositoryRoot)
  assert.equal(buildRoot, receipt.collectionHostBuildRoot)
}
assert.ok(path.isAbsolute(buildRoot), '主机集成必须提供本轮外置编译树；不得 skip。')
export const manifestPath = path.join(buildRoot, 'artifact-manifest.json')
export const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BuildManifest
assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.task, 'RUST-009')
export const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')
assert.equal(sha256(manifest.binaryPath), manifest.binarySha256)
for (const artifact of manifest.artifacts) assert.equal(sha256(path.join(buildRoot, artifact.path)), artifact.sha256, `编译产物身份变化：${artifact.path}`)
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
for (const source of manifest.sources) assert.equal(sha256(path.join(repository, source.path)), source.sha256, `编译后源码身份变化：${source.path}`)
assert.equal(createHash('sha256').update(JSON.stringify(manifest.sources)).digest('hex'), manifest.sourceAggregateSha256)
export const manifestSha256 = sha256(manifestPath)
export async function until(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 30_000) {
  const deadline = performance.now() + timeoutMs
  while (!await check()) { if (performance.now() >= deadline) throw new Error(`宿主未到达：${label}`); await new Promise(resolve => setTimeout(resolve, 10)) }
}
export const count = (snapshot: HostSnapshot, event: string) => snapshot.observations.filter(value => value.event === event).length
export function dispatchCounts(snapshot: HostSnapshot) {
  const values = snapshot.observations
  const nodeReadonly = Object.fromEntries(['collection.detail', 'collection.copy', 'collection.photo', 'referenceCatalog.sources', 'referenceCatalog.history', 'referenceCatalog.revision', 'commandOutbox.context', 'collectionProgress.modelLengths']
    .map(command => [command, values.filter(value => value.event === 'node.dispatch' && value.command === command).length]))
  return { nodeReadonly, nodeList: values.filter(value => value.event === 'node.dispatch' && value.command === 'collection.list').length,
    rustListAcks: values.filter(value => value.event === 'rust.frame' && value.operation === 'dispatch' && value.ok === true).length,
    publicListRequests: values.filter(value => value.event === 'core.publicRequest' && value.command === 'collection.list').length,
    publicNullClaimReplies: values.filter(value => value.event === 'core.publicReply' && value.command === 'recordingPrintWorker.claim' && value.leaseNull).length,
    oracleCounting: '私有raw Node SQLite参照独立调用，不混入被测公开分派计数' }
}
export function naturalResources(snapshot: HostSnapshot, children: number, largeModels?: number) {
  const observations = snapshot.observations
  for (const name of ['node.spawn', 'node.prepare', 'node.boot', 'node.bootComplete', 'node.close', 'node.closed', 'node.exit']) assert.equal(count(snapshot, name), 1, name)
  assert.equal(observations.find(value => value.event === 'node.exit')!.code, 0)
  assert.equal(count(snapshot, 'rust.spawn'), children); assert.equal(count(snapshot, 'rust.exit'), children)
  const childResources = observations.filter(value => value.event === 'rust.spawn').map(spawn => {
    assert.equal(spawn.liveChildren, 1)
    const frames = observations.filter(value => value.event === 'rust.frame' && value.pid === spawn.pid)
    const ack = (operation: string) => frames.filter(value => value.operation === operation && value.ok === true)
    for (const operation of ['prepare', 'commitBoot', 'close']) assert.equal(ack(operation).length, 1, operation)
    assert.equal(ack('appendSnapshot').length, largeModels === undefined ? 0 : Math.ceil(largeModels / 128))
    assert.ok(ack('prepare')[0]!.sequence < ack('commitBoot')[0]!.sequence)
    assert.ok(ack('appendSnapshot').every(value => value.sequence < ack('commitBoot')[0]!.sequence))
    const exit = observations.find(value => value.event === 'rust.exit' && value.pid === spawn.pid)!
    assert.equal(exit.code, 0); assert.equal(exit.signal, null); assert.equal(exit.liveChildren, 0)
    assert.ok(ack('commitBoot')[0]!.sequence < ack('close')[0]!.sequence && ack('close')[0]!.sequence < exit.sequence)
    return { pid: spawn.pid, prepareAcks: 1, appendAcks: ack('appendSnapshot').length, bootAcks: 1, closeAcks: 1,
      exitCode: exit.code, signal: exit.signal, spawnSequence: spawn.sequence, exitSequence: exit.sequence }
  })
  const node = observations.find(value => value.event === 'node.spawn')!
  return { nodeSpawn: 1, nodeThreadId: node.threadId, nodeHostPid: node.hostPid, nodeVersion: node.nodeVersion,
    nodePrepare: 1, nodeBoot: 1, nodeClose: 1, nodeExit0: 1, rustSpawn: children, rustExit0: children, childResources, forcedCleanup: false }
}
export function scrubbedEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'DEV_BUILD_ROOT', 'DEV_CACHE_ROOT', 'NODE_COMPILE_CACHE', 'DISPLAY', 'ELECTRON_CACHE', 'electron_config_cache', 'XDG_CACHE_HOME', 'ELECTRON_SKIP_BINARY_DOWNLOAD']) {
    if (process.env[key] !== undefined) result[key] = process.env[key]
  }
  return { ...result, ...extra, NODE_ENV: 'test', MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_CORE_TEST_MODE: '1', MUSIC_BRIDGE_UI_E2E_OFFLINE: '1' }
}
