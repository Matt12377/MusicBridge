import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { EventEmitter } from 'node:events'
import { MessageChannel, type Worker } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as dto from '@music-bridge/contracts'
import { createScanReadAdmission, ScanReadAdmissionError } from '../../src/library/scan-read-admission.js'
import * as protocol from '../../src/collection/dataset-owner-protocol.js'
import type { DatasetProjectionPort, DatasetProjectionCommand, DatasetProjectionCommandPayloads, DatasetProjectionCommandResults, DatasetOwnerIdentity, DatasetOwnerProjectionHandler, OwnedDatasetDomain } from '../../src/collection/dataset-owner-protocol.js'
import { createDatasetOwnerClient } from '../../src/collection/dataset-owner-client.js'
import { attachDatasetOwnerWorkerPort } from '../../src/collection/dataset-owner-worker.js'
import { responseFailure, failureForError } from '../../src/shared/ipc-failure.js'
import { createCollectionRepository } from '../../src/collection/repository.js'
import { createLocalSourceReadProjection } from '../../src/collection/local-source-read-projection.js'
import { createLocalAlbumOwnerRuntime } from '../../src/collection/local-album-browser/owner-runtime.js'
import { createLocalAlbumArtworkBackground } from '../../src/collection/local-album-browser/artwork-background.js'
import { createLocalAlbumArtworkQueue } from '../../src/collection/local-album-browser/artwork-background-queue.js'
import { authorizeSourceDirectory } from '../../src/recording/source-files.js'
import { libraryRemovalClock } from '../helpers/library-removal-clock.js'

const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const request = (album: dto.LocalAlbumSummary): dto.LocalAlbumArtworkRequest => ({ albumKey: album.id, rootId: album.rootId,
  editionId: album.editionId, representativeTrackId: album.representativeTrackId, revision: album.revision })

async function fixture(t: TestContext) {
  const temporary = process.env.TMPDIR
  assert.ok(temporary && path.isAbsolute(temporary))
  if (process.platform === 'darwin') assert.ok(path.resolve(temporary).startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'))
  const directory = await mkdtemp(path.join(temporary, 'artwork-admission-')), datasetId = randomUUID(), rootId = randomUUID()
  const queue = createLocalAlbumArtworkQueue({ filePath: path.join(directory, 'queue.sqlite') })
  assert.equal(queue.available, true)
  const view: dto.LocalRootView = { root: { id: rootId, sourceRootId: randomUUID(), revision: '1', role: 'library' }, label: '合成来源', availability: 'ONLINE' }
  const albums: dto.LocalAlbumSummary[] = Array.from({ length: 3 }, (_, index) => ({ id: `directory-${String(index + 1).repeat(64)}`,
    rootId, kind: 'source-directory', editionId: null, title: `合成专辑${index}`, artists: [], year: null, versionLabel: null,
    sourceLabel: '合成来源', trackCount: 1, representativeTrackId: randomUUID(), revision: String(index + 4).repeat(64),
    artworkAvailable: false, artworkState: 'unknown', statuses: [] }))
  t.after(async () => { queue.close(); await rm(directory, { recursive: true, force: true }) })
  return { directory, datasetId, rootId, queue, view, albums }
}

/** 提取实际Utility的完整project函数；不复制scan分支，不启动Electron、Rust或真实媒体服务。 */
async function utilityRoute(admission: ReturnType<typeof createScanReadAdmission>) {
  const file = new URL('../../src/utility-main.ts', import.meta.url), source = await readFile(file, 'utf8')
  const ast = ts.createSourceFile(file.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS), found: ts.Expression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'project' && node.initializer
      && node.initializer.getText(ast).includes("command === 'scanReadAcquire'")) found.push(node.initializer)
    ts.forEachChild(node, visit)
  }
  visit(ast); assert.equal(found.length, 1, '必须提取当前生产Utility实际投影作者')
  const context = { ownerIdentity: undefined as DatasetOwnerIdentity | undefined,
    runtime: { getDatasetScanReadAdmission: () => admission }, isDatasetProjectionPayload: protocol.isDatasetProjectionPayload,
    isDatasetNameProviderCommand: protocol.isDatasetNameProviderCommand, isDatasetLyricsProviderCommand: protocol.isDatasetLyricsProviderCommand,
    DatasetOwnerDispatchError: protocol.DatasetOwnerDispatchError, responseFailure,
    projectionGateway: { handler() { throw new Error('状态探针不得进入Roon投影。') } },
    api: undefined as DatasetOwnerProjectionHandler | undefined }
  const compiled = ts.transpileModule(`globalThis.api = ${found[0]!.getText(ast)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS }, fileName: file.pathname,
  }).outputText
  runInNewContext(compiled, context, { filename: '真实utility-main.project.ts' })
  assert.equal(typeof context.api, 'function')
  return { route: context.api!, bind(identity: DatasetOwnerIdentity) { context.ownerIdentity = { ...identity } } }
}

test('只读scan状态：实时busy/closed/原槽位，零grant/revoke/release，原display与Acquire仍各自重新决定', async () => {
  let busy = true
  const gate = createScanReadAdmission({ isBusy: () => busy, isDisplayBusy: () => false }), context = { datasetId: randomUUID(), epoch: randomUUID() }
  assert.deepEqual(gate.status(context), { status: 'deferred' }); assert.equal(gate.resourceCounts().permits, 0)
  busy = false; assert.deepEqual(gate.status(context), { status: 'ready' })
  const first = gate.acquire(context), second = gate.acquire(context)
  assert.equal(first.status, 'granted'); assert.equal(second.status, 'granted')
  if (first.status !== 'granted' || second.status !== 'granted') assert.fail('合成原许可未授予')
  const watch = gate.watchRevocation(context, first.permitId)
  const before = gate.resourceCounts(); busy = true
  assert.deepEqual(gate.status(context), { status: 'deferred' }); assert.deepEqual(gate.resourceCounts(), before, '只读状态不撤销已有flight或假收quiet')
  busy = false; gate.release(context, first.permitId); assert.deepEqual(await watch, { reason: 'permit-released' })
  assert.deepEqual(gate.status(context), { status: 'ready' }); gate.release(context, second.permitId)
  busy = true
  const display = gate.acquire(context, 'local-album-display'); assert.equal(display.status, 'granted')
  if (display.status === 'granted') gate.release(context, display.permitId)
  busy = false; assert.deepEqual(gate.status(context), { status: 'ready' }); busy = true
  assert.deepEqual(gate.acquire(context), { status: 'deferred' }, '先前ready不能代替本次原Acquire')
  gate.close(); assert.deepEqual(gate.status(context), { status: 'deferred' })
  assert.throws(() => gate.status({ datasetId: '无效', epoch: context.epoch }), ScanReadAdmissionError)
  assert.deepEqual(gate.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: true })
})

test('只读scan状态：私有空正文与单字段结果闭集；不进入公开IPC、不接受display或票据夹带', () => {
  assert.equal(protocol.isDatasetProjectionPayload('scanReadStatus', {}), true)
  const getter = Object.defineProperty({}, 'purpose', { enumerable: true, get() { assert.fail('不可读取payload getter') } })
  for (const value of [null, [], { purpose: 'local-album-display' }, { permitId: randomUUID() }, { state: 'ready' }, getter,
    Object.create({ purpose: 'local-album-display' }), new Proxy({}, {})]) assert.equal(protocol.isDatasetProjectionPayload('scanReadStatus', value), false)
  assert.equal(protocol.isDatasetProjectionResult('scanReadStatus', { status: 'ready' }), true)
  assert.equal(protocol.isDatasetProjectionResult('scanReadStatus', { status: 'deferred' }), true)
  const resultGetter = Object.defineProperty({}, 'status', { enumerable: true, get() { assert.fail('不可读取结果getter') } })
  for (const value of [{ status: 'granted' }, { status: 'ready', permitId: randomUUID() }, {}, resultGetter])
    assert.equal(protocol.isDatasetProjectionResult('scanReadStatus', value), false)
  assert.equal(protocol.isDatasetCommand('scanReadStatus'), false)
  assert.equal(dto.validateIpcRequest({ version: 1, id: randomUUID(), command: 'scanReadStatus', payload: {} }).ok, false)
})

test('实际Utility+Client+Worker+来源队列：新状态经过真实反向帧闭环，每次重读且原epoch/dataset拒绝不旁路', async t => {
  let busy = true
  const admission = createScanReadAdmission({ isBusy: () => busy }), utility = await utilityRoute(admission), channel = new MessageChannel()
  const datasetId = randomUUID(), observed: string[] = [], reasons: unknown[] = [], packets: unknown[] = []
  let epoch: string = randomUUID(), projector!: DatasetProjectionPort
  class PortWorker extends EventEmitter { postMessage(value: unknown) { channel.port1.postMessage(value) } }
  const worker = new PortWorker()
  channel.port1.on('message', value => { packets.push(value); worker.emit('message', value) })
  channel.port1.once('close', () => worker.emit('exit', 0))
  let shared: ReturnType<typeof createLocalSourceReadProjection>
  const domain: OwnedDatasetDomain = { datasetId, commitBoot() {}, async dispatch() { throw new Error('本测试无mutation') },
    async workbenchContext() { const result = await shared.port.call('scanReadStatus', {}); observed.push(result.status); return { epoch, datasetId, ready: true } },
    async dispatchWorkbench() { throw new Error('状态读取不得派发公开mutation') },
    async dispatchWorkbenchOwner() { throw new Error('状态读取不得派发Owner mutation') },
    async closeWorkbench() { shared.seal() },
    async close(before) { await before?.(); await shared.close() }, failureForError }
  attachDatasetOwnerWorkerPort(channel.port2, { async prepare(actualEpoch, projection) {
    epoch = actualEpoch; projector = projection
    shared = createLocalSourceReadProjection({ projection: projector, assertCurrent() {} }); return domain
  } })
  const endpoint = createDatasetOwnerClient({ worker: worker as unknown as Worker, projection: utility.route, onFatal: reason => reasons.push(reason) })
  t.after(async () => { try { await endpoint.close() } finally { channel.port1.close(); channel.port2.close(); admission.close() } })
  const identity = await endpoint.prepare(); utility.bind(identity); await endpoint.commitBoot()
  assert.equal((await endpoint.workbenchContext!()).ready, true); assert.deepEqual(observed, ['deferred'])
  busy = false; await endpoint.workbenchContext!(); assert.deepEqual(observed, ['deferred', 'ready'])
  assert.equal(packets.filter(value => protocol.isDatasetOwnerProjectionRequest(value) && value.command === 'scanReadStatus').length, 2)
  assert.deepEqual(shared!.inspect(), { active: 0, pending: 0, closed: false, fatal: false })
  assert.equal(admission.resourceCounts().permits, 0); assert.deepEqual(reasons, [])
  for (const scope of [{ ...identity, epoch: randomUUID() }, { ...identity, datasetId: randomUUID() }]) {
    await assert.rejects(utility.route('scanReadStatus', {}, scope), error => error instanceof protocol.DatasetOwnerDispatchError && error.failure.error.code === 'NOT_READY')
  }
  const invalidPayload: unknown = { purpose: 'local-album-display' }
  await assert.rejects(utility.route('scanReadStatus', invalidPayload as DatasetProjectionCommandPayloads['scanReadStatus'], identity))
  assert.equal(admission.resourceCounts().permits, 0)
})

test('后台busy全局背压：真实持久complete/missing不复核不改写，千次单步也只每秒探针一次，idle后原断点继续', async t => {
  const f = await fixture(t), time = libraryRemovalClock(t), context = { datasetId: f.datasetId, epoch: randomUUID() }
  let busy = true, probes = 0, roots = 0, resources = 0, discoveries = 0, reads = 0
  const gate = createScanReadAdmission({ isBusy: () => busy })
  f.queue.recover(f.datasetId)
  f.queue.enqueue(f.datasetId, f.albums.map(request)); const done = f.queue.claim(f.datasetId)!; assert.equal(f.queue.complete(done), true)
  const before = f.queue.inspect(f.datasetId)
  const background = createLocalAlbumArtworkBackground({ datasetId: f.datasetId, queue: f.queue, assertCurrent() {},
    async readAdmission() { probes++; return gate.status(context).status },
    async readRootViews() { roots++; return [f.view] }, readRevision: () => '合成同一水位',
    readPersistedArtwork() { resources++; return 'missing' },
    async queryCandidates(query) { discoveries++; return { ...query, total: f.albums.length, hasMore: false, items: f.albums.map(request) } },
    async getArtwork(value) { reads++; return { ...value, image: null, status: 'ready' } },
  })
  try {
    background.start()
    for (let index = 0; index < 1000; index++) await background.runPending()
    assert.equal(probes, 1); assert.deepEqual([roots, resources, discoveries, reads], [0, 0, 0, 0]); assert.deepEqual(f.queue.inspect(f.datasetId), before)
    time.elapse(999); await background.runPending(); assert.equal(probes, 1)
    time.elapse(1); await background.runPending(); assert.equal(probes, 2); assert.deepEqual(f.queue.inspect(f.datasetId), before)
    busy = false; time.elapse(1000); await background.runPending()
    assert.equal(probes, 3); assert.equal(roots, 1); assert.equal(resources, 1); assert.equal(discoveries, 1); assert.equal(reads, 1)
    assert.equal(f.queue.inspect(f.datasetId).complete, 2); assert.equal(gate.resourceCounts().permits, 0)
  } finally { await background.close(); gate.close() }
})

test('后台busy不取消已在途flight：原signal和许可保持到实际返回，下一项等idle；关闭中的迟到status不入场', async t => {
  const f = await fixture(t), time = libraryRemovalClock(t), context = { datasetId: f.datasetId, epoch: randomUUID() }, entered = deferred(), release = deferred()
  let busy = false, probes = 0, reads = 0, signal: AbortSignal | undefined
  const gate = createScanReadAdmission({ isBusy: () => busy })
  const background = createLocalAlbumArtworkBackground({ datasetId: f.datasetId, queue: f.queue, assertCurrent() {},
    async readAdmission() { probes++; return gate.status(context).status }, async readRootViews() { return [f.view] }, readRevision: () => '合成水位',
    async queryCandidates(query) { return { ...query, total: f.albums.length, hasMore: false, items: f.albums.map(request) } },
    async getArtwork(value, read) {
      reads++; signal = read.signal
      const grant = gate.acquire(context); assert.equal(grant.status, 'granted'); if (grant.status !== 'granted') assert.fail('原许可未授予')
      entered.resolve(); await release.promise; gate.release(context, grant.permitId)
      return { ...value, image: null, status: 'ready' }
    },
  })
  background.start(); const flight = background.runPending()
  try {
    await entered.promise; busy = true; const same = background.runPending(); await nextTurn()
    assert.equal(signal!.aborted, false); assert.equal(probes, 1); assert.equal(reads, 1); assert.equal(gate.resourceCounts().permits, 1)
    assert.equal(f.queue.inspect(f.datasetId).running, 1)
    release.resolve(); await Promise.all([flight, same]); assert.equal(gate.resourceCounts().permits, 0)
    await background.runPending(); assert.equal(probes, 2); assert.equal(reads, 1); assert.equal(f.queue.inspect(f.datasetId).complete, 1)
    busy = false; time.elapse(1000); await background.runPending(); assert.equal(reads, 2)
  } finally { release.resolve(); await flight; await background.close(); gate.close() }
  const held = deferred(); let enteredStatus = false, afterCloseRoots = 0
  const later = createLocalAlbumArtworkBackground({ datasetId: f.datasetId, queue: f.queue, assertCurrent() {},
    async readAdmission() { enteredStatus = true; await held.promise; return 'ready' },
    async readRootViews() { afterCloseRoots++; return [f.view] }, readRevision: () => '合成水位',
    async queryCandidates(query) { return { ...query, total: 0, hasMore: false, items: [] } },
    async getArtwork(value) { return { ...value, image: null, status: 'ready' } },
  })
  later.start(); const pending = later.runPending(); assert.equal(enteredStatus, true)
  const closing = later.close(); held.resolve(); await Promise.all([pending, closing]); assert.equal(afterCloseRoots, 0)
})

test('真实Owner Runtime忙时不进根/SQL/资源/claim，前台页仍可读；idle后Acquire真实竞态拒绝仍不写missing', async t => {
  const f = await fixture(t), media = path.join(f.directory, '空Source'); await mkdir(media)
  const repository = createCollectionRepository({ filePath: path.join(f.directory, 'collection.sqlite') })
  const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media))
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' })
  for (let index = 0; index < 2; index++) {
    const asset = repository.localCatalog.registerAsset({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision,
      relative: `合成专辑${index}/01.wav`, sha256: null, sampleFrames: null, timebaseHz: null })
    const track = repository.localCatalog.createTrack({ commandId: randomUUID(), assetId: asset.id, segment: null })
    repository.localCatalog.observeMetadata({ commandId: randomUUID(), trackId: track.id, source: 'synthetic', parserVersion: 'admission-gate-v1', fields: { title: '合成曲目', album: `合成专辑${index}` } })
  }
  const time = libraryRemovalClock(t), context = { datasetId: f.datasetId, epoch: randomUUID() }
  let busy = true, roots = 0, statuses = 0, acquires = 0
  const gate = createScanReadAdmission({ isBusy: () => busy, isDisplayBusy: () => false }), utility = await utilityRoute(gate); utility.bind(context)
  const projection: DatasetProjectionPort = { async call<C extends DatasetProjectionCommand>(command: C, payload: DatasetProjectionCommandPayloads[C]): Promise<DatasetProjectionCommandResults[C]> {
    if (command === 'scanReadStatus') statuses++
    if (command === 'scanReadAcquire') { acquires++; busy = true }
    return await utility.route(command, payload, context) as DatasetProjectionCommandResults[C]
  } }
  const shared = createLocalSourceReadProjection({ projection, assertCurrent() {} })
  const runtime = createLocalAlbumOwnerRuntime({ repository, projection: shared.port, datasetId: f.datasetId, assertCurrent() {},
    async readRootViews() { roots++; return [{ root: repository.localCatalog.root(root.id), label: '合成来源', availability: 'ONLINE' }] } })
  const candidates = t.mock.method(repository.localCatalog, 'privateAlbumBrowserBackgroundCandidates'), contexts = t.mock.method(repository.localCatalog, 'privateAlbumBrowserArtwork')
  const observations = t.mock.method(repository.privateLocalAlbumArtworkObservations!, 'put'), background = runtime.background; assert.ok(background)
  try {
    const stamp = repository.readonlySnapshotStamp(); background.start()
    for (let index = 0; index < 100; index++) await background.runPending()
    assert.equal(statuses, 1); assert.equal(roots, 0); assert.equal(candidates.mock.callCount(), 0); assert.equal(contexts.mock.callCount(), 0); assert.equal(acquires, 0)
    assert.equal(observations.mock.callCount(), 0); assert.deepEqual(repository.readonlySnapshotStamp(), stamp)
    const page = await runtime.localAlbums.queryAlbums({ rootId: root.id, offset: 0, limit: 50, filter: 'all', query: '' })
    assert.equal(page.total, 2); assert.equal(statuses, 1, '只读status只约束后台，不拦截前台')
    busy = false; time.elapse(1001); await background.runPending()
    assert.equal(statuses, 2); assert.equal(candidates.mock.callCount(), 1); assert.equal(contexts.mock.callCount(), 1); assert.equal(acquires, 1)
    assert.equal(observations.mock.callCount(), 0); assert.equal(background.inspect().complete, 0); assert.equal(background.inspect().pending, 2)
    await background.runPending(); assert.equal(statuses, 3); assert.equal(contexts.mock.callCount(), 1)
    assert.deepEqual(shared.inspect(), { active: 0, pending: 0, closed: false, fatal: false }); assert.equal(gate.resourceCounts().permits, 0)
  } finally { await runtime.close(); await shared.close(); gate.close(); repository.close() }
})
