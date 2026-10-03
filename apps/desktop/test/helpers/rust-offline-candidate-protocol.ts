import assert from 'node:assert/strict'
import childProcess, { type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { types } from 'node:util'
import { Worker } from 'node:worker_threads'
import type { CollectionFilter, IpcRequest } from '@music-bridge/contracts'
import { resolveRustCoreResource } from '../../src/main/rust-core-resource.js'
import { createDatasetOwnerClient } from '../../../../packages/bridge-core/src/collection/dataset-owner-client.js'
import { seedRustCollection } from '../../../../packages/bridge-core/test/helpers/rust-core-collection-fixture.js'
import { createRustReadonlyDatasetEndpoint, RustSidecarError } from '../../../../packages/bridge-core/src/rust-core/readonly-sidecar.js'

export interface RustOfflineCandidateProtocolOptions {
  resourcesDirectory: string
  expectedManifestSha256: string
  evidenceDirectory: string
}
export const OFFLINE_PROTOCOL_FILTERS: readonly CollectionFilter[] = Object.freeze([
  {}, { query: '%' }, { query: '_' }, { query: '全角Ｆ' }, { query: 'É' }, { brand: 'TDK' },
  { brand: '中文品牌🎵' }, { decade: 'unknown' }, { decade: 1990 }, { stockState: 'blank' },
  { stockState: 'recorded' }, { stockState: 'needs-review' }, { stockState: 'identified' },
  { query: '合成', decade: 1900, stockState: 'needs-review' },
])
const external = '/Volumes/LifeWeave/Developer/CommandLine/tmp'
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const reject = (): never => { throw Object.assign(new Error('候选协议配置未准入。'), { code: 'RUST_OFFLINE_PROTOCOL_REJECTED' }) }
let active = false
function optionsFor(value: unknown): RustOfflineCandidateProtocolOptions {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) reject()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(value as object).length !== 3 || !['resourcesDirectory', 'expectedManifestSha256', 'evidenceDirectory'].every(key => {
    const field = descriptors[key]; return field?.enumerable && Object.hasOwn(field, 'value') && typeof field.value === 'string'
  })) reject()
  const copy = Object.fromEntries(Object.entries(descriptors).map(([key, field]) => [key, field.value])) as unknown as RustOfflineCandidateProtocolOptions
  for (const file of [copy.resourcesDirectory, copy.evidenceDirectory]) {
    if (!file.startsWith(external + '/') || path.resolve(file) !== file || file.includes('\0') || file.length > 1024) reject()
  }
  if (!copy.resourcesDirectory.endsWith('.app/Contents/Resources') || !/^[a-f0-9]{64}$/u.test(copy.expectedManifestSha256)) reject()
  return copy
}
function ipc(command: IpcRequest['command'], payload: unknown, datasetId: string): IpcRequest {
  return { version: 1, id: randomUUID(), command, payload, expectedDatasetId: datasetId }
}

/** 仅受控验证器调用；Rust 真实路径来自最终 Resources 的独立签后 pin。 */
export async function runRustOfflineCandidateProtocol(supplied: unknown) {
  const options = optionsFor(supplied)
  if (active) throw new Error('候选协议验证正在运行，不能并发接管进程观察。')
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || !process.versions.node.startsWith('22.')) reject()
  if ((await lstat('/Volumes/LifeWeave')).dev === (await lstat('/')).dev) reject()
  if (await realpath(path.dirname(options.evidenceDirectory)) !== path.dirname(options.evidenceDirectory)) reject()
  await access(path.dirname(options.evidenceDirectory), constants.W_OK)
  // 所有准入和路径词法检查先完成；不创建真实用户路径，也不复用旧证据目录。
  const resource = await resolveRustCoreResource({ resourcesDirectory: options.resourcesDirectory, expectedManifestSha256: options.expectedManifestSha256 })
  await mkdir(options.evidenceDirectory, { mode: 0o700 })
  const dataDirectory = path.join(options.evidenceDirectory, 'synthetic-data')
  await mkdir(dataDirectory, { mode: 0o700 })
  active = true
  const nodeSessions: Array<Record<string, any>> = [], failures: string[] = []
  const openOwners: ReturnType<typeof createDatasetOwnerClient>[] = []
  const workerExits: Promise<number>[] = []
  let rust: ReturnType<typeof createRustReadonlyDatasetEndpoint> | undefined
  let rustChild: ChildProcessWithoutNullStreams | undefined
  const rustAcknowledgements: unknown[] = [], rustRequests: unknown[] = []
  let rustExit: { code: number | null; signal: NodeJS.Signals | null } | undefined
  let rustKillCalls = 0, raw = '', requestRaw = ''
  const originalSpawn = childProcess.spawn
  let observingSpawn = false
  function ownerSession(role: string) {
    const worker = new Worker(new URL('../../../../packages/bridge-core/test/helpers/dataset-owner-domain-fixture.ts', import.meta.url), {
      execArgv: ['--import', import.meta.resolve('tsx')], env: { TMPDIR: process.env.TMPDIR, DEV_BUILD_ROOT: process.env.DEV_BUILD_ROOT,
        DEV_CACHE_ROOT: process.env.DEV_CACHE_ROOT }, workerData: { dataDirectory, signals: new SharedArrayBuffer(12) },
    })
    const record: Record<string, any> = { role, threadId: worker.threadId, identity: null, acknowledgements: [], exitCode: null, closeRequested: false }
    nodeSessions.push(record)
    worker.on('message', message => {
      if (message?.type === 'response' && ['prepare', 'commitBoot', 'exportVersionedCollectionSnapshot', 'close'].includes(message.operation)) {
        record.acknowledgements.push({ operation: message.operation, requestId: message.requestId, epoch: message.epoch, ok: message.ok })
      }
    })
    workerExits.push(new Promise(resolve => worker.once('exit', code => { record.exitCode = code; resolve(code) })))
    const owner = createDatasetOwnerClient({ worker, onFatal: reason => failures.push(reason) }); openOwners.push(owner)
    return { owner, record }
  }
  const closeOwner = async (session: ReturnType<typeof ownerSession>) => {
    session.record.closeRequested = true; await session.owner.close(); assert.equal(session.record.exitCode, 0)
  }
  // WAL 包含未 checkpoint 的实际写入；动态锁页 -shm 不属于数据库内容身份。
  const databaseIdentity = async () => Promise.all(['collection.v1.sqlite', 'collection.v1.sqlite-wal',
    'backup-maintenance.v1.sqlite', 'backup-maintenance.v1.sqlite-wal'].map(async name => {
    const file = path.join(dataDirectory, name)
    try {
      const info = await lstat(file), bytes = await readFile(file)
      assert.ok(info.isFile() && !info.isSymbolicLink() && await realpath(file) === file)
      return { name, exists: true, size: bytes.length, sha256: digest(bytes) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !name.endsWith('-wal')) throw error
      return { name, exists: false, size: 0, sha256: null }
    }
  }))
  try {
    const initialization = ownerSession('initialize')
    initialization.record.identity = await initialization.owner.prepare(); await initialization.owner.commitBoot()
    await closeOwner(initialization)
    seedRustCollection(path.join(dataDirectory, 'collection.v1.sqlite'), 100)
    const querying = ownerSession('query')
    querying.record.identity = await querying.owner.prepare(); await querying.owner.commitBoot()
    const exported = await querying.owner.exportVersionedCollectionSnapshot()
    assert.equal(exported.snapshot.models.length, 100)
    assert.deepEqual(exported.version, await querying.owner.getCollectionSnapshotVersion())
    const before = await databaseIdentity()
    // 原 sidecar 没有观察器参数；限定当前单次同步 spawn 的旁路观测，立即恢复原函数。
    childProcess.spawn = ((...args: Parameters<typeof originalSpawn>) => {
      assert.equal(args[0], resource.binary.path, '只观察最终 Resources 的固定 Rust')
      const child = originalSpawn(...args) as ChildProcessWithoutNullStreams; rustChild = child
      const kill = child.kill.bind(child)
      child.kill = (...values) => { rustKillCalls++; return kill(...values) }
      child.once('close', (code, signal) => { rustExit = { code, signal } })
      child.stdout.on('data', chunk => {
        raw += String(chunk); assert.ok(Buffer.byteLength(raw) <= 4 * 1024 * 1024)
        let at: number
        while ((at = raw.indexOf('\n')) >= 0) { rustAcknowledgements.push(JSON.parse(raw.slice(0, at))); raw = raw.slice(at + 1) }
      })
      const write = child.stdin.write.bind(child.stdin)
      child.stdin.write = ((chunk: any, ...values: any[]) => {
        requestRaw += String(chunk)
        let at: number
        while ((at = requestRaw.indexOf('\n')) >= 0) { rustRequests.push(JSON.parse(requestRaw.slice(0, at))); requestRaw = requestRaw.slice(at + 1) }
        return (write as any)(chunk, ...values)
      }) as typeof child.stdin.write
      return child
    }) as typeof originalSpawn
    observingSpawn = true
    rust = createRustReadonlyDatasetEndpoint({ binary: resource.binary, snapshot: exported.snapshot, onFatal: reason => failures.push(reason) })
    const preparing = rust.prepare()
    childProcess.spawn = originalSpawn; observingSpawn = false
    assert.ok(rustChild, '实际 Rust 必须同步经原 sidecar 创建')
    assert.deepEqual(await preparing, { epoch: exported.snapshot.epoch, datasetId: exported.snapshot.datasetId })
    await rust.commitBoot()
    const comparisons = []
    for (const filter of OFFLINE_PROTOCOL_FILTERS) for (const offset of [0, 31, 99, 100]) {
      const request = ipc('collection.list', { page: { offset, limit: 25 }, filter }, exported.snapshot.datasetId)
      const expected = await querying.owner.dispatch(request), actual = await rust.dispatch(request)
      assert.deepEqual(actual, expected, '包内实际 Rust 必须保持 Node 完整 DTO')
      comparisons.push({ request, expected, actual })
    }
    const writeRequest = ipc('collection.setPolicy', { commandId: randomUUID(), modelId: exported.snapshot.models[0]!.id,
      expectedRevision: exported.snapshot.models[0]!.revision, collectorPolicy: 'collector', minimumSealedReserve: 1 }, exported.snapshot.datasetId)
    await assert.rejects(rust.dispatch(writeRequest), error => error instanceof RustSidecarError && error.code === 'UNSUPPORTED_COMMAND')
    assert.deepEqual(await querying.owner.getCollectionSnapshotVersion(), exported.version)
    const after = await databaseIdentity()
    assert.deepEqual(after, before, '只读查询及Rust写拒绝不能修改Node两库')
    await rust.close(); assert.deepEqual(rustExit, { code: 0, signal: null }); assert.equal(rustKillCalls, 0)
    await closeOwner(querying); assert.deepEqual(failures, [])
    const closedDatabases = await databaseIdentity()
    const afterResource = await resolveRustCoreResource({ resourcesDirectory: options.resourcesDirectory, expectedManifestSha256: options.expectedManifestSha256 })
    assert.deepEqual(afterResource, resource)
    const report = { schemaVersion: 1, task: 'RUST-011', kind: 'external-node-to-packaged-rust-protocol', state: 'PASS',
      resourcesDirectory: options.resourcesDirectory, evidenceDirectory: options.evidenceDirectory,
      manifestSha256: resource.manifestSha256, binary: resource.binary, modelCount: 100, snapshot: exported,
      nodeSessions, databasesBefore: before, databasesAfter: after, closedDatabases, comparisons, writeRejection: { request: writeRequest, code: 'UNSUPPORTED_COMMAND' },
      rust: { pid: rustChild.pid, spawnPath: resource.binary.path, requests: rustRequests, acknowledgements: rustAcknowledgements,
        exit: rustExit, killCalls: rustKillCalls }, forcedCleanup: false, ownerAcceptance: 'NOT_RUN', packagedRustMainCoreRoute: 'NOT_IN_SCOPE' }
    const file = path.join(options.evidenceDirectory, 'protocol-report.json'), bytes = JSON.stringify(report, null, 2) + '\n'
    await writeFile(file, bytes, { flag: 'wx', mode: 0o600 })
    return { ...report, evidence: { path: file, sha256: digest(bytes) } }
  } catch (error) {
    await rust?.close().catch(() => undefined)
    for (const owner of openOwners) await owner.close().catch(() => undefined)
    // Worker 错误通常先于 exit；短暂等待实际退出事件，不制造成功或强制终止。
    await Promise.all(workerExits.map(async exited => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 1000) })]) }
      finally { if (timer) clearTimeout(timer) }
    }))
    await writeFile(path.join(options.evidenceDirectory, 'protocol-failure.json'), JSON.stringify({ state: 'FAIL', nodeSessions,
      rustExit: rustExit ?? null, rustKillCalls, failures, reason: error instanceof RustSidecarError ? error.code : 'PROTOCOL_VALIDATION_FAILED' }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    throw error
  } finally {
    if (observingSpawn) childProcess.spawn = originalSpawn
    active = false
  }
}
