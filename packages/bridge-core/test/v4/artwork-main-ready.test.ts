import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, open, readFile, rm, writeFile, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { validateIpcRequest } from '@music-bridge/contracts'
import { createCollectionRepository } from '../../src/collection/repository.js'
import { prepareOwnedDatasetDomain, type DatasetDomain } from '../../src/collection/dataset-domain.js'
import { isDatasetCommand, isDatasetWorkbenchRequest, isDatasetWorkbenchOwnerRequest, isDatasetWorkbenchOwnerResult,
  type DatasetWorkbenchExecutionContext, type DatasetProjectionPort, type DatasetProjectionCommand,
  type DatasetProjectionCommandPayloads, type DatasetProjectionCommandResults } from '../../src/collection/dataset-owner-protocol.js'
import { authorizeSourceDirectory } from '../../src/recording/source-files.js'
import { createScanReadAdmission } from '../../src/library/scan-read-admission.js'
import { readLibraryOperationLine } from '../../src/shared/library-operation-log.js'

function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
/** 只控制调度事件轮；真实异步文件操作仍等待原生timer/IO，不能把推进时钟当quiet。 */
function clock(t: TestContext) {
  const nativeTimeout = setTimeout, nativeNow = performance.now.bind(performance)
  let now = 0, monotonic = Math.floor(nativeNow())
  t.mock.method(performance, 'now', () => monotonic)
  type Handle = ReturnType<typeof setTimeout>
  const timers = new Map<Handle, { at: number; callback: () => void }>()
  t.mock.method(globalThis, 'setTimeout', (callback: () => void, delay = 0) => {
    const handle = { unref() { return this } } as unknown as Handle
    timers.set(handle, { at: now + Math.max(1, Number(delay)), callback }); return handle
  })
  t.mock.method(globalThis, 'clearTimeout', (handle: Handle) => { timers.delete(handle) })
  return { timers, async advance(ms: number) {
    now += ms; monotonic += ms
    const due = [...timers].filter(([, value]) => value.at <= now)
    for (const [handle, value] of due) if (timers.delete(handle)) value.callback()
    await turn()
  }, async until(ready: () => boolean) {
    // IO仍用真实单调钟限2秒；不能因调度钟静止而把故障等成无限等待。
    const deadline = nativeNow() + 2000
    while (!ready()) { assert.ok(nativeNow() < deadline, '合成异步IO未在原有界等待内完成'); await new Promise<void>(resolve => nativeTimeout(resolve, 1)) }
    await turn()
  } }
}

/** 真正OwnedDomain/双SQLite/实际授权空目录；音频仅为目录事实，不读取或伪造源许可。 */
async function fixture(t: TestContext, albums = 1, holdAcquire = false) {
  const temporary = process.env.TMPDIR
  assert.ok(temporary && path.isAbsolute(temporary))
  if (process.platform === 'darwin') assert.ok(path.resolve(temporary).startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'))
  const directory = await mkdtemp(path.join(temporary, 'artwork-main-ready-')), media = path.join(directory, '自有合成空目录')
  await mkdir(media)
  const heldPath = path.join(directory, '反向回调自有文件.bin')
  await writeFile(heldPath, Buffer.from([0x17]))
  const seed = createCollectionRepository({ filePath: path.join(directory, 'collection.v1.sqlite') })
  const source = seed.sources.authorize(randomUUID(), await authorizeSourceDirectory(media))
  const root = seed.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' })
  try {
    for (let index = 0; index < albums; index++) {
      const asset = seed.localCatalog.registerAsset({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision,
        relative: `专辑${index}/合成记录.wav`, sha256: null, sampleFrames: null, timebaseHz: null })
      const track = seed.localCatalog.createTrack({ commandId: randomUUID(), assetId: asset.id, segment: null })
      seed.localCatalog.observeMetadata({ commandId: randomUUID(), trackId: track.id, source: 'synthetic', parserVersion: 'main-ready-gate-v1',
        fields: { title: '合成歌曲', artist: '合成作者', album: `专辑${index}` } })
    }
  } finally { seed.close() }
  let admissionBusy = false
  const admission = createScanReadAdmission({ isBusy: () => admissionBusy })
  const entered = deferred(), released = deferred()
  let domain!: DatasetDomain, epoch = randomUUID(), held: FileHandle | undefined, heldClosed = false, acquireEntered = false
  const offsets: number[] = [], purposes: string[] = []
  let recoveries = 0, terminals = 0
  t.mock.method(console, 'info', (...args: unknown[]) => {
    for (const raw of args) {
      const event = typeof raw === 'string' ? readLibraryOperationLine(raw) : null
      if (event?.action === 'artwork.background.item' && ['complete', 'error', 'skipped', 'cancelled'].includes(event.state)) terminals++
    }
  })
  const projection: DatasetProjectionPort = {
    async call<C extends DatasetProjectionCommand>(command: C, payload: DatasetProjectionCommandPayloads[C]): Promise<DatasetProjectionCommandResults[C]> {
      // 原ACK/close Gate保留Acquire在途与拒绝路径；探针完成后才进入busy竞态。
      if (command === 'scanReadStatus') { admissionBusy = false; const result = admission.status({ epoch, datasetId: domain.datasetId }); admissionBusy = true; return result as DatasetProjectionCommandResults[C] }
      if (command !== 'scanReadAcquire') throw new Error('本Gate不批准Source读取、图像归一化或其它反向命令。')
      const purpose = (payload as DatasetProjectionCommandPayloads['scanReadAcquire']).purpose
      purposes.push(purpose ?? 'scan')
      if (holdAcquire) {
        held = await open(heldPath, 'r')
        try {
          assert.equal((await held.read(Buffer.alloc(1), 0, 1, 0)).bytesRead, 1)
          acquireEntered = true; entered.resolve(); await released.promise
          assert.equal((await held.read(Buffer.alloc(1), 0, 1, 0)).bytesRead, 1)
        } finally { await held.close(); heldClosed = true }
      }
      const result: unknown = admission.acquire({ epoch, datasetId: domain.datasetId }, purpose)
      return result as DatasetProjectionCommandResults[C]
    },
  }
  async function assemble() {
    domain = await prepareOwnedDatasetDomain({ dataDirectory: directory, epoch, testMode: true, projection })
    const catalog = domain.collection.localCatalog, original = catalog.privateAlbumBrowserBackgroundCandidates
    t.mock.method(catalog, 'privateAlbumBrowserBackgroundCandidates', (request: Parameters<typeof original>[0], scope: Parameters<typeof original>[1]) => {
      offsets.push(request.offset); return original.call(catalog, request, scope)
    })
    const queue = domain.collection.privateLocalAlbumArtworkQueue!
    assert.ok(queue?.available)
    const recover = queue.recover
    t.mock.method(queue, 'recover', (datasetId: string) => { recoveries++; return recover.call(queue, datasetId) })
  }
  await assemble()
  t.after(async () => {
    released.resolve()
    try { await domain.close() } finally { admission.close(); await rm(directory, { recursive: true, force: true }) }
  })
  const context = (): DatasetWorkbenchExecutionContext => ({ identity: { datasetId: domain.datasetId, epoch }, signal: new AbortController().signal, deadlineAtMs: performance.now() + 2000 })
  return { root, offsets, purposes, entered: entered.promise, release: () => released.resolve(),
    get domain() { return domain }, get queue() { return domain.collection.privateLocalAlbumArtworkQueue! },
    get recoveries() { return recoveries }, get terminals() { return terminals }, get held() { return held }, get heldClosed() { return heldClosed }, get acquireEntered() { return acquireEntered },
    context, async ack(value = context()) { return domain.dispatchWorkbenchOwner!({ command: 'lifecycle.mainReady', payload: {} }, value) },
    async reopen() { const id = domain.datasetId; await domain.close(); epoch = randomUUID(); await assemble(); assert.equal(domain.datasetId, id) },
  }
}

test('Main-ready仅原Owner私有空正文闭集，公开IPC/普通context或capabilities不获得启动语义', () => {
  const request = { command: 'lifecycle.mainReady', payload: {} }
  assert.equal(isDatasetWorkbenchOwnerRequest(request), true)
  for (const payload of [{ datasetId: randomUUID() }, { purpose: 'background' }, { path: '合成非法字段' }, [], null])
    assert.equal(isDatasetWorkbenchOwnerRequest({ ...request, payload }), false)
  assert.equal(isDatasetWorkbenchOwnerResult('lifecycle.mainReady', true, {}, randomUUID()), true)
  for (const result of [false, null, {}, { ready: true }]) assert.equal(isDatasetWorkbenchOwnerResult('lifecycle.mainReady', result, {}, randomUUID()), false)
  assert.equal(isDatasetCommand('lifecycle.mainReady'), false)
  assert.equal(validateIpcRequest({ version: 1, id: '合成公开请求', ...request }).ok, false)
  assert.equal(isDatasetWorkbenchRequest({ family: 'lifecycle', ...request }), false)
})

test('真实OwnedDomain commit/context/前台页不抢跑；同代并发ACK只恢复一次、只启单个后台flight', async t => {
  const f = await fixture(t), time = clock(t)
  await assert.rejects(f.ack(), { code: 'INVENTORY_UNAVAILABLE' })
  await f.domain.commitBoot()
  await f.domain.workbenchContext!(); await f.domain.workbenchReadIdentity!()
  await f.domain.dispatchWorkbenchOwner!({ command: 'capabilities.read', payload: {} }, f.context())
  const page = await f.domain.localAlbums!.queryAlbums({ rootId: f.root.id, query: '', filter: 'all', offset: 0, limit: 50 })
  assert.equal(page.total, 1)
  await time.advance(1000)
  assert.deepEqual(f.offsets, []); assert.deepEqual(f.purposes, []); assert.equal(f.recoveries, 0)
  assert.deepEqual(await Promise.all([f.ack(), f.ack(), f.ack()]), [true, true, true])
  assert.equal(f.recoveries, 1)
  await time.advance(150); await time.until(() => f.terminals === 1)
  assert.deepEqual(f.offsets, [0]); assert.deepEqual(f.purposes, ['scan'])
  assert.equal(f.queue.inspect(f.domain.datasetId).complete, 0, '实际Core busy拒绝不能伪报封面完成')
  await f.domain.closeWorkbench!(); await time.advance(10_000)
  assert.deepEqual(f.offsets, [0]); assert.equal(f.recoveries, 1)
})

test('真实OwnedDomain无人打开本地页，ACK后按50分页发现全部123项，Source仍由原busy准入拒绝', async t => {
  const f = await fixture(t, 123), time = clock(t)
  await f.domain.commitBoot(); await f.ack()
  for (let round = 0; round < 3; round++) {
    await time.advance(round === 0 ? 150 : 1); await time.until(() => f.terminals === round + 1)
  }
  assert.deepEqual(f.offsets, [0, 50, 100])
  const counts = f.queue.inspect(f.domain.datasetId)
  assert.equal(counts.pending + counts.running + counts.complete, 123)
  assert.equal(counts.complete, 0); assert.deepEqual(f.purposes, ['scan', 'scan', 'scan'])
  t.diagnostic('本Gate证明实际Owner无需页面即可发现全集且不借display许可；封面真实持久完成由原后台资源Gate另验。')
})

for (const mode of ['paused', 'cancelled'] as const) test(`真实OwnedDomain ${mode}冷开后ACK保留偏好且零读取`, async t => {
  const f = await fixture(t), time = clock(t)
  await f.domain.commitBoot(); f.queue.setMode(f.domain.datasetId, mode)
  await f.reopen(); await f.domain.commitBoot(); await f.ack(); await f.ack(); await time.advance(1000)
  assert.equal(f.queue.inspect(f.domain.datasetId).mode, mode)
  assert.deepEqual(f.offsets, []); assert.deepEqual(f.purposes, []); assert.equal(f.recoveries, 1)
})

test('真实Owner的ACK保原epoch/dataset、取消与期限门禁，workbench关闭后不再启后台', async t => {
  const f = await fixture(t), time = clock(t)
  await f.domain.commitBoot()
  const aborted = new AbortController(); aborted.abort()
  for (const context of [
    { ...f.context(), identity: { ...f.context().identity, datasetId: randomUUID() } },
    { ...f.context(), identity: { ...f.context().identity, epoch: randomUUID() } },
    { ...f.context(), signal: aborted.signal }, { ...f.context(), deadlineAtMs: performance.now() - 1 },
  ]) await assert.rejects(f.ack(context), { code: 'INVENTORY_UNAVAILABLE' })
  await f.domain.closeWorkbench!(); await assert.rejects(f.ack(), { code: 'NOT_READY' })
  await time.advance(1000); assert.deepEqual(f.offsets, []); assert.deepEqual(f.purposes, [])
  await f.domain.close(); await assert.rejects(f.ack(), { code: 'INVENTORY_UNAVAILABLE' })
})

test('closeWorkbench同步封后台，真实反向回调FD未闭时不得完成，join后不补下一轮SQL', async t => {
  const f = await fixture(t, 1, true), time = clock(t)
  await f.domain.commitBoot(); await f.ack(); await time.advance(150); await time.until(() => f.acquireEntered)
  assert.ok(f.held); assert.equal(f.heldClosed, false)
  let completed = false
  const closing = f.domain.closeWorkbench!().then(() => { completed = true })
  await turn(); assert.equal(completed, false)
  assert.equal((await f.held.stat()).isFile(), true)
  await assert.rejects(f.ack(), { code: 'NOT_READY' })
  await time.advance(10_000); assert.equal(completed, false); assert.deepEqual(f.offsets, [0])
  f.release(); await closing
  assert.equal(f.heldClosed, true); await assert.rejects(f.held.stat(), { code: 'EBADF' })
  const counts = f.queue.inspect(f.domain.datasetId)
  assert.equal(counts.complete, 0); assert.equal(counts.pending, 1)
  await time.advance(10_000); assert.deepEqual(f.offsets, [0]); assert.deepEqual(f.purposes, ['scan'])
})

test('实际closeWorkbench函数：后台close失败仍逐项收口后续作者，保留失败且不改队列偏好', async () => {
  const source = await readFile(new URL('../../src/collection/dataset-domain.ts', import.meta.url), 'utf8')
  const begin = source.indexOf('  function closeWorkbench(): Promise<void> {'), end = source.indexOf('\n  function readLyricsGrantOriginal(', begin)
  assert.ok(begin >= 0 && end > begin)
  const events: string[] = [], life = new AbortController(), failure = new Error('合成后台关闭失败')
  life.signal.addEventListener('abort', () => events.push('abort'), { once: true })
  const closer = (name: string) => ({ async close() { events.push(name) } })
  const context: Record<string, unknown> = {
    workbenchClose: undefined, workbenchLife: life, albumRuntime: { background: { async close() { assert.equal(life.signal.aborted, true); events.push('background'); throw failure } } },
    workbenchPreparation: Promise.resolve(), libraryManagement: closer('management'), libraryWatch: closer('watch'), lyricsRuntime: closer('lyrics'),
    lyricsNative: undefined, lyricsTags: undefined, cueActor: undefined, cueNative: undefined, cueTags: undefined,
    cuePreparations: new Map(), directoryClosures: new Map(), roleProbeFlights: new Set(), workbenchRegistry: Promise.resolve(),
    workbenchWriter: closer('writer'), workbenchRead: closer('read'), roleProbeUnknown: new Map(), roleProbeFds: new Set(), approvedDirectories: new Map(),
    workbenchRecoveryFailure: null, options: {}, api: undefined,
  }
  runInNewContext(ts.transpileModule(source.slice(begin, end) + '\nglobalThis.api = closeWorkbench;', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, context)
  const close = context.api as () => Promise<void>, one = close(), two = close()
  assert.equal(one, two); assert.deepEqual(events.slice(0, 2), ['abort', 'background'])
  await assert.rejects(one, (error: unknown) => {
    assert.ok(error && typeof error === 'object' && 'errors' in error)
    assert.deepEqual(Array.from(error.errors as Iterable<unknown>), [failure]); return true
  })
  assert.deepEqual(events, ['abort', 'background', 'management', 'watch', 'lyrics', 'writer', 'read'])
})
