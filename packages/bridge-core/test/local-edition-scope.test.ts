import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { Worker } from 'node:worker_threads'
import { isAlbumEdition, validateIpcRequest, type AlbumEdition, type IpcRequest, type LocalPlayRequest, type MBQueueRecord } from '@music-bridge/contracts'
import { BridgeController } from '../src/application/bridge-controller.js'
import { createDatasetOwnerClient } from '../src/collection/dataset-owner-client.js'
import { dispatchDatasetCommand, type DatasetDispatchTarget } from '../src/collection/dataset-dispatch.js'
import { DatasetOwnerDispatchError, isDatasetOwnerRequest, type DatasetOwnerEndpoint, type DatasetOwnerRequest } from '../src/collection/dataset-owner-protocol.js'
import type { LocalSourceCaptureResult } from '../src/collection/local-source-ticket-types.js'
import { createDatasetCommandBoundary } from '../src/recording/dataset-identity.js'
import { failureForError } from '../src/shared/ipc-failure.js'
import type { NeteasePort } from '../src/netease/types.js'
import type { RoonPlayRequest, RoonPort, RoonState } from '../src/roon/types.js'
import { LocalSourceFence } from '../src/stream/local-source-fence.js'
import type { AssetLease, LocalLeaseState } from '../src/stream/local-file-source.js'
import { StreamGateway } from '../src/stream/gateway.js'
import { StreamRegistry } from '../src/stream/registry.js'

/** 仅合成信封运输；dispatch必经生产Node派发器/validator/boundary，不在此手造scope谓词。 */
class ScopedOwnerTransport extends EventEmitter {
  readonly requests: DatasetOwnerRequest[] = []
  readonly dispatches: IpcRequest[] = []
  readonly domainFailures: unknown[] = []
  readonly transportFailures: unknown[] = []
  readonly tasks = new Set<Promise<void>>()
  exits = 0
  constructor(readonly datasetId: string, readonly runtime: DatasetDispatchTarget) { super() }
  postMessage(value: unknown): void {
    assert.ok(isDatasetOwnerRequest(value), '合成运输也使用生产Owner信封validator。')
    const request = structuredClone(value)
    this.requests.push(request)
    const operation = Promise.resolve().then(async (): Promise<unknown> => {
      switch (request.operation) {
        case 'prepare': return { epoch: request.epoch, datasetId: this.datasetId }
        case 'commitBoot': case 'close': return undefined
        case 'dispatch': {
          assert.ok(request.request)
          this.dispatches.push(structuredClone(request.request))
          return dispatchDatasetCommand(this.runtime, request.request)
        }
        default: throw new Error('本夹具不接受其他Owner操作。')
      }
    })
    const delivered = operation.then(result => {
      this.emit('message', { version: 1, epoch: request.epoch, type: 'response', requestId: request.requestId, operation: request.operation, ok: true, result })
      // 仅合成运输的生命周期事件，不冒真实Worker自然退出或FD闭口。
      if (request.operation === 'close') { this.exits++; this.emit('exit', 0) }
    }, error => {
      this.domainFailures.push(error)
      const failure = failureForError(request.request?.id ?? request.requestId, error, request.request?.command ?? 'localCatalog.edition')
      this.emit('message', { version: 1, epoch: request.epoch, type: 'response', requestId: request.requestId, operation: request.operation, ok: false, failure })
    }).catch(error => { this.transportFailures.push(error) })
    this.tasks.add(delivered)
    void delivered.then(() => this.tasks.delete(delivered))
  }
  async quiet(): Promise<void> { await Promise.allSettled([...this.tasks]) }
}

interface FixtureOptions { formal?: boolean; count?: 1 | 2; returnedEdition?: 'wrong-id' | 'old-revision' }
async function editionScopeFixture(t: test.TestContext, options: FixtureOptions = {}) {
  let controller: BridgeController | undefined, endpoint: ReturnType<typeof createDatasetOwnerClient> | undefined
  let gateway: StreamGateway | undefined, transport: ScopedOwnerTransport | undefined
  const failures: unknown[] = [], fatalReasons: string[] = []
  const fences = new Map<string, LocalSourceFence>(), leases = new Map<string, AssetLease>()
  const restores: Array<() => void> = []
  // 在第一次组件初始化/await前注册，所有阶段独立收集清理错误。
  t.after(async () => {
    const close = async (operation: () => unknown) => { try { await operation() } catch (error) { failures.push(error) } }
    await close(() => controller?.shutdown())
    await close(() => endpoint?.close())
    await close(() => transport?.quiet())
    for (const lease of leases.values()) await close(() => lease.close())
    for (const fence of fences.values()) { await close(() => fence.revoke()); await close(() => fence.assertQuiet()) }
    await close(() => gateway?.stop())
    await close(() => assert.equal(fences.size, 0, '原Controller须交还本例所有合成capture。'))
    for (const lease of leases.values()) await close(() => assert.equal(lease.state, 'CLOSED'))
    await close(() => assert.deepEqual(fatalReasons, []))
    if (transport) {
      await close(() => assert.deepEqual(transport!.transportFailures, []))
      await close(() => assert.equal(transport!.tasks.size, 0))
      await close(() => assert.equal(transport!.exits, 1))
      await close(() => assert.equal(transport!.requests.filter(request => request.operation === 'close').length, 1))
    }
    for (const restore of restores) await close(restore)
    if (failures.length) throw new AggregateError(failures, '发行scope合成组件未全部收口。', { cause: failures[0] })
  })

  const datasetId = randomUUID(), rootId = randomUUID(), sourceRootId = randomUUID()
  const edition: AlbumEdition = { id: randomUUID(), title: '合成正式发行', edition: '合成版本', revision: '1' }
  const returnedEdition = options.returnedEdition === 'wrong-id' ? { ...edition, id: randomUUID() }
    : options.returnedEdition === 'old-revision' ? { ...edition, revision: '2' } : edition
  assert.ok(isAlbumEdition(edition)); assert.ok(isAlbumEdition(returnedEdition))
  const scopeInputs: string[] = [], repositoryReads: string[] = []
  let identityChecks = 0
  const boundary = createDatasetCommandBoundary({ datasetId, assertCurrent() { identityChecks++ } })
  const runtime: DatasetDispatchTarget = {
    commandOutbox: { context: () => boundary.context(), assertScope(expected) { scopeInputs.push(expected); boundary.assertScope(expected) } },
    collection: { localCatalog: { edition(id: string) { repositoryReads.push(id); return structuredClone(returnedEdition) } } } as unknown as NonNullable<DatasetDispatchTarget['collection']>,
  }
  transport = new ScopedOwnerTransport(datasetId, runtime)
  endpoint = createDatasetOwnerClient({ worker: transport as unknown as Worker, onFatal: reason => fatalReasons.push(reason) })
  const identity = await endpoint.prepare()
  await endpoint.commitBoot()
  const facts = Array.from({ length: options.count ?? 1 }, (): LocalSourceCaptureResult['facts'] => {
    const trackId = randomUUID(), assetId = randomUUID()
    return { track: { id: trackId, assetId, selectionRevision: '1', segment: null },
      asset: { id: assetId, libraryRootId: rootId, sourceRootId, rootRevision: '1', fileRevision: '1', locationRevision: '1', sampleFrames: null, timebaseHz: null },
      root: { id: rootId, sourceRootId, role: 'library', revision: '1' },
      sourceRoot: { id: sourceRootId, path: '/synthetic-edition-scope', dev: '1', ino: '2', authorized: true, label: '合成目录' }, relative: `synthetic-${trackId}.wav` }
  })
  const formal = options.formal !== false
  const source = (f: LocalSourceCaptureResult['facts']) => ({ kind: 'local_file' as const,
    snapshot: { sourceKind: 'local_file' as const, trackId: f.track.id, assetId: f.asset.id, libraryRootId: rootId, sourceRootId, rootRevision: '1', fileRevision: '1', locationRevision: '1', selectionRevision: '1', segment: null },
    edition: formal ? { id: edition.id, revision: edition.revision } : null })
  const sent: IpcRequest[] = [], plays: RoonPlayRequest[] = [], captureSelections: LocalPlayRequest[] = []
  let prepareCalls = 0, captures = 0, releases = 0, saves = 0, materializations = 0, registrations = 0
  const localSources: DatasetOwnerEndpoint = {
    ...endpoint,
    async prepare() { prepareCalls++; return endpoint!.prepare() },
    dispatch(request) { sent.push(structuredClone(request)); return endpoint!.dispatch(request) },
    async saveMBQueue(request) { saves++; return structuredClone(request.queue) as MBQueueRecord },
    async readLocalAlbum(request) {
      assert.equal(request.command, 'localAlbum.materializeQueue')
      if (request.command !== 'localAlbum.materializeQueue') throw new Error('本例仅物化原专辑队列。')
      materializations++
      assert.ok(request.payload.selection.album)
      return { album: structuredClone(request.payload.selection.album), sources: facts.map(source), edition: formal ? structuredClone(edition) : null, startIndex: 0 }
    },
    async captureLocalSource(selection) {
      const captured = facts.find(f => f.track.id === selection.local_track_id && f.asset.id === selection.asset_id)
      assert.ok(captured, '只接本例两首以内的原曲目。')
      captures++; captureSelections.push(structuredClone(selection))
      const fence = LocalSourceFence.create(), ticketId = `synthetic-scope-ticket-${captures}`
      fences.set(ticketId, fence)
      return { ticketId, epoch: identity.epoch, datasetId, buffer: fence.buffer, facts: structuredClone(captured), format: 'wav',
        metadata: { id: captured.track.id, title: '合成曲目', artists: ['合成作者'], album: '合成正式发行' } }
    },
    async releaseLocalSource(ticketId) {
      const fence = fences.get(ticketId)
      if (!fence) return
      releases++; fence.revoke(); fence.assertQuiet(); fences.delete(ticketId)
    },
    async revalidateLocalSource(ticketId) { return fences.get(ticketId)?.current === true },
  }
  const registry = new StreamRegistry()
  gateway = new StreamGateway({ host: '127.0.0.1', port: 0, publicBaseUrl: 'http://127.0.0.1:38502', registry,
    logger: { debug() {}, info() {}, warn() {}, error() {} } })
  const register = t.mock.method(registry, 'registerLocalSource', async () => {
    registrations++; let state: LocalLeaseState = 'PREPARED'
    const lease = { size: 1, get state() { return state }, confirmSession() { state = 'ACTIVE' }, renew() {}, pause() { state = 'PAUSED' }, async close() { state = 'CLOSED' } } as unknown as AssetLease
    const token = `synthetic-scope-owned-${registrations}`; leases.set(token, lease)
    return { token, lease }
  })
  const revoke = t.mock.method(registry, 'revokeLocal', async (token: string) => { await leases.get(token)?.close() })
  const media = t.mock.method(gateway, 'localStreamUrl', () => 'http://127.0.0.1:38502/synthetic-edition-scope')
  restores.push(() => register.mock.restore(), () => revoke.mock.restore(), () => media.mock.restore())
  const state: RoonState = { status: 'ready', selectedZoneId: 'synthetic-scope-zone' }
  const roon: RoonPort = {
    setTerminalHandler() {}, async start() {}, async shutdown() {}, async pause() {}, async resume() {}, async stop() {},
    getState: () => ({ ...state }),
    captureLocalTarget: () => ({ target: { core_id: 'synthetic-scope-core', zone_id: 'synthetic-scope-zone' }, isCurrent: () => true }),
    async play(request) { plays.push(request); request.onDispatch?.() },
  }
  const netease = new Proxy({ configured: false }, { get(target, key) { if (key === 'configured') return target.configured; throw new Error('本地发行scope不得走Provider兜底。') } }) as unknown as NeteasePort
  controller = new BridgeController({ localSources, roon, registry, gateway, netease, isLocalPlaybackAllowed: () => true,
    logger: { debug() {}, info() {}, warn() {}, error() {} } })
  const request = (): LocalPlayRequest => ({ schema_version: '1.2', request_id: randomUUID(), route: 'roon_audio_input', source_kind: 'local_file',
    local_track_id: facts[0]!.track.id, asset_id: facts[0]!.asset.id, expected_asset_revision: '1', action: 'PLAY_NOW',
    target: { core_id: 'synthetic-scope-core', zone_id: 'synthetic-scope-zone' },
    album: { datasetId, albumKey: 'synthetic-scope-album', rootId, revision: 'album-1', kind: formal ? 'edition' : 'source-directory', editionId: formal ? edition.id : null, trackCount: facts.length } })
  const confirmPlaying = () => {
    const play = plays.at(-1); assert.ok(play?.onLocalSession)
    const observation = { generation: 1, isConfirmed: () => true, isOwned: () => true }
    play.onLocalSession({ ...observation, event: 'SESSION', sessionId: 'synthetic-scope-session' })
    play.onLocalSession({ ...observation, event: 'PLAYING' })
  }
  return { controller, endpoint, transport, datasetId, edition, sent, scopeInputs, repositoryReads, plays, request, confirmPlaying, captureSelections,
    counts: () => ({ prepareCalls, captures, releases, saves, materializations, registrations, identityChecks }) }
}

async function finiteTurns(predicate: () => boolean, message: string): Promise<void> {
  for (let turn = 0; turn < 32; turn++) { if (predicate()) return; await new Promise<void>(resolve => setImmediate(resolve)) }
  assert.ok(predicate(), message)
}

function assertScopedRead(f: Awaited<ReturnType<typeof editionScopeFixture>>, index: number): void {
  const request = f.sent[index]; assert.ok(request)
  assert.equal(validateIpcRequest(request).ok, true, '原Controller发行读必须被生产validator接纳，缺scope不能由fake返回成功。')
  assert.equal(request.command, 'localCatalog.edition'); assert.equal(request.expectedDatasetId, f.datasetId)
  assert.deepEqual(request.payload, { editionId: f.edition.id })
  assert.deepEqual(f.transport.dispatches[index], request, '原信封进入实际Node派发入口，不能重写或补造scope。')
  assert.equal(f.scopeInputs[index], f.datasetId); assert.equal(f.repositoryReads[index], f.edition.id)
}

test('发行读取scope：非空正式发行经生产Node边界受理且不额外prepare', async t => {
  const f = await editionScopeFixture(t), request = f.request(), work = f.controller.playLocal(request)
  assert.equal(f.controller.playLocal(request), work)
  const outcome = await work.then(result => ({ ok: true as const, result }), error => ({ ok: false as const, error }))
  assert.equal(f.sent.length, 1); assertScopedRead(f, 0)
  if (!outcome.ok) throw outcome.error
  assert.deepEqual(outcome.result, { status: 'accepted', request_id: request.request_id, action: 'PLAY_NOW' })
  assert.equal(f.plays.length, 1); assert.equal(f.controller.getPlaybackState().local?.phase, 'AWAITING_ROON')
  assert.equal(f.controller.getPlaybackState().currentTrack?.version, f.edition.edition)
  assert.deepEqual(f.counts(), { prepareCalls: 1, captures: 2, releases: 1, saves: 1, materializations: 1, registrations: 1, identityChecks: 1 })
  assert.equal(f.controller.getLocalPlayReceipt(request).status, 'received')
})

test('发行读取scope：缺scope不发Node，跨库经真实boundary拒绝且零SDK', async t => {
  const f = await editionScopeFixture(t), bare: IpcRequest = { version: 1, id: randomUUID(), command: 'localCatalog.edition', payload: { editionId: f.edition.id } }
  assert.equal(validateIpcRequest(bare).ok, false)
  await assert.rejects(f.endpoint.dispatch(bare), error => error instanceof DatasetOwnerDispatchError && error.failure.error.code === 'INVALID_IPC_REQUEST')
  assert.equal(f.transport.dispatches.length, 0); assert.deepEqual(f.repositoryReads, []); assert.equal(f.plays.length, 0)
  const foreign = { ...bare, id: randomUUID(), expectedDatasetId: randomUUID() }
  assert.equal(validateIpcRequest(foreign).ok, true)
  await assert.rejects(f.endpoint.dispatch(foreign), error => error instanceof DatasetOwnerDispatchError && error.failure.error.code === 'OUTBOX_SCOPE_MISMATCH')
  assert.deepEqual(f.transport.dispatches, [foreign]); assert.deepEqual(f.scopeInputs, [foreign.expectedDatasetId])
  assert.deepEqual(f.repositoryReads, []); assert.equal(f.counts().identityChecks, 0); assert.equal(f.plays.length, 0); assert.equal(f.counts().registrations, 0)
})

test('发行读取scope：scope已通过仍拒错发行id或旧revision，零租约及SDK', async t => {
  for (const returnedEdition of ['wrong-id', 'old-revision'] as const) {
    const f = await editionScopeFixture(t, { returnedEdition }), request = f.request()
    await assert.rejects(f.controller.playLocal(request), { code: 'BAD_REQUEST', httpStatus: 409 })
    assert.equal(f.sent.length, 1); assertScopedRead(f, 0)
    assert.equal(f.plays.length, 0); assert.equal(f.counts().registrations, 0); assert.equal(f.counts().captures, 1)
    assert.deepEqual(f.controller.getLocalPlayReceipt(request), { status: 'rejected', request_id: request.request_id, action: 'PLAY_NOW', reason: 'REQUEST_REJECTED' })
  }
})

test('发行读取scope：null发行保原本地成功且不prepare额外身份或dispatch发行读', async t => {
  const f = await editionScopeFixture(t, { formal: false }), request = f.request()
  assert.deepEqual(await f.controller.playLocal(request), { status: 'accepted', request_id: request.request_id, action: 'PLAY_NOW' })
  assert.deepEqual(f.sent, []); assert.deepEqual(f.transport.dispatches, []); assert.deepEqual(f.scopeInputs, []); assert.deepEqual(f.repositoryReads, [])
  assert.equal(f.plays.length, 1); assert.equal(f.counts().prepareCalls, 1); assert.equal(f.counts().captures, 2); assert.equal(f.counts().registrations, 1)
})

test('发行读取scope：公开确认playing后原NEXT预检复用同一真实scope边界', async t => {
  const f = await editionScopeFixture(t, { count: 2 }), request = f.request()
  await f.controller.playLocal(request); assertScopedRead(f, 0)
  f.confirmPlaying()
  await finiteTurns(() => f.controller.getPlaybackState().queue.items[1]?.preflight?.state === 'PREPARED', '原紧邻NEXT须真实完成其生产helper与scope边界。')
  assert.equal(f.controller.getPlaybackState().local?.phase, 'PLAYING'); assert.equal(f.sent.length, 2); assertScopedRead(f, 1)
  assert.equal(f.counts().prepareCalls, 1); assert.equal(f.counts().materializations, 1); assert.equal(f.counts().saves, 1)
  assert.equal(f.counts().captures, 3); assert.equal(f.counts().registrations, 2); assert.equal(f.plays.length, 1, 'NEXT预检不另派发SDK。')
})
