import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { fstatSync } from 'node:fs'
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { type LocalAlbumArtworkReply, type LocalAlbumArtworkRequest, type LocalAlbumSummary, type LocalRootView } from '@music-bridge/contracts'
import { createLocalAlbumArtworkQueue, type LocalAlbumArtworkQueue } from '../../src/collection/local-album-browser/artwork-background-queue.js'
import { createLocalAlbumArtworkBackground, type ArtworkBackgroundReadOptions } from '../../src/collection/local-album-browser/artwork-background.js'
import { createCollectionRepository } from '../../src/collection/repository.js'
import { createLocalAlbumOwnerRuntime } from '../../src/collection/local-album-browser/owner-runtime.js'
import { createScanReadAdmission } from '../../src/library/scan-read-admission.js'
import { authorizeSourceDirectory } from '../../src/recording/source-files.js'
import type { DatasetProjectionPort } from '../../src/collection/dataset-owner-protocol.js'

const revision = (value: string) => createHash('sha256').update(value).digest('hex')
const request = (album: LocalAlbumSummary): LocalAlbumArtworkRequest => ({ albumKey: album.id, rootId: album.rootId,
  editionId: album.editionId, representativeTrackId: album.representativeTrackId, revision: album.revision })
const ready = (value: LocalAlbumArtworkRequest): LocalAlbumArtworkReply => ({ ...value, image: null, status: 'ready' })
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
function backgroundClock(t: TestContext) {
  let now = 1_800_000_000_000
  type Handle = ReturnType<typeof setTimeout>
  const timers = new Map<Handle, { at: number; callback: (...args: any[]) => void; args: any[] }>()
  t.mock.method(Date, 'now', () => now)
  t.mock.method(globalThis, 'setTimeout', (callback: (...args: any[]) => void, delay = 0, ...args: any[]) => {
    const handle = { unref() { return this } } as unknown as Handle
    timers.set(handle, { at: now + Math.max(1, Number(delay)), callback, args }); return handle
  })
  t.mock.method(globalThis, 'clearTimeout', (handle: Handle) => { timers.delete(handle) })
  return { timers, async advance(ms: number) {
    now += ms
    // 只执行进入这一事件轮前已到期的timer，新补位必须等下一轮，不能递归清空任务。
    const due = [...timers].filter(([, value]) => value.at <= now).sort((left, right) => left[1].at - right[1].at)
    for (const [handle, value] of due) { if (!timers.delete(handle)) continue; value.callback(...value.args) }
    await new Promise<void>(resolve => setImmediate(resolve))
  } }
}
async function fixture(t: TestContext) {
  const temporary = process.env.TMPDIR
  assert.ok(temporary && path.isAbsolute(temporary))
  if (process.platform === 'darwin') assert.ok(temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'))
  const directory = await mkdtemp(path.join(temporary, 'artwork-background-')), file = path.join(directory, 'queue.sqlite')
  const queues: LocalAlbumArtworkQueue[] = []
  t.after(async () => { for (const queue of queues) queue.close(); await rm(directory, { recursive: true }) })
  const datasetId = randomUUID(), rootId = randomUUID()
  const view: LocalRootView = { root: { id: rootId, sourceRootId: randomUUID(), revision: '1', role: 'library' }, label: '合成音乐库', availability: 'ONLINE' }
  const albums = (count: number): LocalAlbumSummary[] => Array.from({ length: count }, (_, index) => ({
    id: `directory-${revision(String(index))}`, rootId, kind: 'source-directory', editionId: null, title: `合成专辑${index}`,
    artists: [], year: null, versionLabel: null, trackCount: 1, representativeTrackId: randomUUID(),
    revision: revision(`album-${index}`), artworkAvailable: false, artworkState: 'unknown', statuses: [],
  }))
  return { datasetId, rootId, view, albums, directory,
    open() { const queue = createLocalAlbumArtworkQueue({ filePath: file }); assert.equal(queue.available, true); queues.push(queue); return queue },
  }
}
function scheduler(t: TestContext, queue: LocalAlbumArtworkQueue, f: Awaited<ReturnType<typeof fixture>>, albums: LocalAlbumSummary[],
  read: (value: LocalAlbumArtworkRequest, options: ArtworkBackgroundReadOptions) => Promise<LocalAlbumArtworkReply> = async value => ready(value),
  readRootSourceRevision?: (rootId: string) => string | null,
  readPersistedArtwork?: (value: LocalAlbumArtworkRequest) => 'available' | 'missing' | null,
  discovery?: { revision(): string; afterPage?(offset: number): void | Promise<void>; isForegroundBusy?(): boolean }) {
  const pages: number[] = [], reads: string[] = []
  const worker = createLocalAlbumArtworkBackground({ datasetId: f.datasetId, queue, assertCurrent() {},
    readRootViews: async () => [f.view], readRevision: discovery?.revision ?? (() => 'catalog-v1'),
    ...(readRootSourceRevision ? { readRootSourceRevision } : {}),
    ...(readPersistedArtwork ? { readPersistedArtwork } : {}),
    ...(discovery?.isForegroundBusy ? { isForegroundBusy: discovery.isForegroundBusy } : {}),
    async queryCandidates(query, signal) {
      assert.equal(signal.aborted, false)
      pages.push(query.offset)
      const items = albums.slice(query.offset, query.offset + query.limit)
      const page = { ...query, total: albums.length, hasMore: query.offset + items.length < albums.length, items: items.map(request) }
      await discovery?.afterPage?.(query.offset)
      return page
    },
    async getArtwork(value, options) {
      assert.equal(options.purpose, 'background'); assert.equal(options.signal.aborted, false)
      reads.push(value.albumKey); return read(value, options)
    },
  })
  t.after(() => worker.close())
  return { worker, pages, reads }
}

test('前台让步：前台在途只推迟新后台入场，恢复后原断点与持久补齐继续', async t => {
  const f = await fixture(t), albums = f.albums(2), queue = f.open()
  let busy = true
  const run = scheduler(t, queue, f, albums, undefined, undefined, undefined,
    { revision: () => 'foreground-yield-v1', isForegroundBusy: () => busy })
  run.worker.start(); await run.worker.runPending()
  assert.deepEqual(run.pages, []); assert.deepEqual(run.reads, [])
  assert.equal(queue.inspect(f.datasetId).pending, 0)
  busy = false; await run.worker.runPending()
  assert.deepEqual(run.pages, [0]); assert.equal(run.reads.length, 1)
  assert.equal(queue.inspect(f.datasetId).complete, 1)
  await run.worker.runPending(); assert.equal(queue.inspect(f.datasetId).complete, 2)
})

test('前台让步：已领取的实际读取不被取消或冒充quiet，后续任务等待前台结束', async t => {
  const f = await fixture(t), albums = f.albums(2), queue = f.open(), entered = deferred(), release = deferred()
  let busy = false, signal: AbortSignal | undefined
  const run = scheduler(t, queue, f, albums, async (value, read) => {
    signal = read.signal; entered.resolve(); await release.promise; return ready(value)
  }, undefined, undefined, { revision: () => 'foreground-yield-v1', isForegroundBusy: () => busy })
  run.worker.start(); const flight = run.worker.runPending(); await entered.promise
  busy = true; const sameFlight = run.worker.runPending()
  assert.equal(signal?.aborted, false); assert.equal(queue.inspect(f.datasetId).running, 1)
  release.resolve(); await Promise.all([flight, sameFlight])
  assert.equal(queue.inspect(f.datasetId).running, 0); assert.equal(queue.inspect(f.datasetId).complete, 1)
  await run.worker.runPending(); assert.equal(run.reads.length, 1)
  busy = false; await run.worker.runPending(); assert.equal(run.reads.length, 2)
  assert.equal(queue.inspect(f.datasetId).complete, 2)
})

test('前台让步：候选发现await期间进入前台，尚未领取的Source任务保留到恢复', async t => {
  const f = await fixture(t), albums = f.albums(1), queue = f.open()
  let busy = false
  const run = scheduler(t, queue, f, albums, undefined, undefined, undefined,
    { revision: () => 'foreground-yield-v1', isForegroundBusy: () => busy, afterPage() { busy = true } })
  run.worker.start(); await run.worker.runPending()
  assert.deepEqual(run.pages, [0]); assert.deepEqual(run.reads, [])
  assert.equal(queue.inspect(f.datasetId).pending, 1); assert.equal(queue.inspect(f.datasetId).running, 0)
  busy = false; await run.worker.runPending()
  assert.equal(run.reads.length, 1); assert.equal(queue.inspect(f.datasetId).complete, 1)
})

test('后台队列冷恢复保留任务与显式暂停/取消，旧领取令牌不能完成新修订', async t => {
  const f = await fixture(t), albums = f.albums(2), queue = f.open()
  queue.recover(f.datasetId); queue.enqueue(f.datasetId, albums.map(request))
  const old = queue.claim(f.datasetId)!
  queue.setMode(f.datasetId, 'paused'); queue.close()
  const reopened = f.open()
  assert.equal(reopened.recover(f.datasetId), 1)
  assert.equal(reopened.mode(f.datasetId), 'paused'); assert.equal(reopened.claim(f.datasetId), null)
  assert.equal(reopened.complete(old), false)
  reopened.setMode(f.datasetId, 'running')
  const current = reopened.claim(f.datasetId)!
  assert.notEqual(current.token, old.token)
  reopened.enqueue(f.datasetId, [{ ...current.request, revision: revision('new') }])
  assert.equal(reopened.complete(current), false, '新修订入队必须撤销旧异步完成资格。')
  reopened.setMode(f.datasetId, 'cancelled'); reopened.close()
  const cancelled = f.open(); cancelled.recover(f.datasetId)
  assert.equal(cancelled.mode(f.datasetId), 'cancelled'); assert.equal(cancelled.claim(f.datasetId), null)
})

test('后台不依赖页面可见性，分页发现全部专辑且冷开沿断点继续、不重做完成项', async t => {
  const f = await fixture(t), albums = f.albums(123), queue = f.open()
  const first = scheduler(t, queue, f, albums)
  first.worker.start(); await first.worker.runPending()
  assert.deepEqual(first.pages, [0]); assert.equal(queue.inspect(f.datasetId).pending, 49)
  await first.worker.close(); queue.close()
  const reopened = f.open(), cold = scheduler(t, reopened, f, albums)
  cold.worker.start()
  for (let index = 0; index < 130 && reopened.inspect(f.datasetId).complete < albums.length; index++) await cold.worker.runPending()
  assert.deepEqual(cold.pages, [50, 100])
  assert.equal(reopened.inspect(f.datasetId).complete, 123)
  assert.equal(new Set([...first.reads, ...cold.reads]).size, 123)
  assert.equal(first.reads.length + cold.reads.length, 123)
  await cold.worker.close(); reopened.close()
  const thirdQueue = f.open(), third = scheduler(t, thirdQueue, f, albums)
  third.worker.start(); await third.worker.runPending()
  assert.equal(third.reads.length, 0); assert.equal(third.pages.length, 0)
})

test('后台成功后下一事件轮补位，每轮只发现50项并消费一项，不同步递归或重入', async t => {
  const f = await fixture(t), queue = f.open(), time = backgroundClock(t)
  let active = 0, maximum = 0
  const run = scheduler(t, queue, f, f.albums(123), async value => {
    active++; maximum = Math.max(maximum, active)
    try { await Promise.resolve(); return ready(value) } finally { active-- }
  })
  run.worker.start(); await time.advance(149)
  assert.deepEqual(run.pages, []); assert.deepEqual(run.reads, [])
  await time.advance(1)
  assert.deepEqual(run.pages, [0]); assert.equal(run.reads.length, 1); assert.equal(queue.inspect(f.datasetId).pending, 49)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(run.reads.length, 1, '即使本地图立即命中也必须先让出事件轮')
  await time.advance(1)
  assert.deepEqual(run.pages, [0, 50]); assert.equal(run.reads.length, 2, '无需再等人为50ms')
  await time.advance(1)
  assert.deepEqual(run.pages, [0, 50, 100]); assert.equal(run.reads.length, 3)
  assert.equal(maximum, 1); assert.equal(time.timers.size, 1)
  await run.worker.close(); assert.equal(time.timers.size, 0)
})

test('后台下一轮调度仍尊重失败not_before、空闲30秒和队列错误5秒，不形成热循环', async t => {
  for (const kind of ['snapshot', 'source', 'queue'] as const) await t.test(kind, async sub => {
    const f = await fixture(sub), queue = f.open(), time = backgroundClock(sub)
    let reads = 0, pages = 0
    const run = scheduler(sub, queue, f, f.albums(1), async value => {
      if (++reads === 1) {
        if (kind === 'source') return { ...value, image: null, status: 'source-unavailable' }
        if (kind === 'snapshot') throw Object.assign(new Error('合成快照变化。'), { code: 'SNAPSHOT_CHANGED' })
      }
      return ready(value)
    }, undefined, undefined, { revision: () => 'catalog-stable', afterPage() {
      if (++pages === 1 && kind === 'queue') throw new Error('合成查询存储暂不可用。')
    } })
    run.worker.start(); await time.advance(150)
    if (kind === 'queue') {
      assert.equal(reads, 0); await time.advance(4999); assert.equal(pages, 1)
      await time.advance(1); assert.equal(pages, 2); assert.equal(reads, 1)
    } else {
      await time.advance(1); await time.advance(1)
      assert.equal(reads, 1); assert.ok(run.pages.length <= 2, '快照拒绝最多补扫一次')
      await time.advance(29_997)
      assert.equal(reads, 1, '冷却和idle期间不能持续派发或忙等')
      await time.advance(3)
      assert.equal(reads, 2); assert.equal(queue.inspect(f.datasetId).complete, 1)
    }
    await run.worker.close(); assert.equal(time.timers.size, 0)
  })
})

test('两事件轮之间暂停或关闭撤掉补位，在途真实FD未quiet时不消费下一项', async t => {
  for (const action of ['pause', 'close'] as const) for (const held of [false, true]) await t.test(`${action}-${held ? '在途' : '两轮之间'}`, async sub => {
    const f = await fixture(sub), queue = f.open(), time = backgroundClock(sub), entered = deferred(), exited = deferred()
    const source = path.join(f.directory, 'synthetic-artwork-source.bin')
    await writeFile(source, Buffer.from('合成有界读取'))
    let fd: number | undefined, signal: AbortSignal | undefined
    const run = scheduler(sub, queue, f, f.albums(3), async (value, read) => {
      if (!held) return ready(value)
      const handle = await open(source, 'r'); fd = handle.fd; signal = read.signal; entered.resolve()
      try { await exited.promise; await handle.read(Buffer.alloc(1), 0, 1, 0); return ready(value) }
      finally { await handle.close() }
    })
    let stopping: Promise<void> | undefined
    try {
      run.worker.start(); await time.advance(150)
      if (held) await entered.promise
      let stopped = false
      stopping = run.worker[action]().then(() => { stopped = true })
      await time.advance(30_000)
      assert.equal(run.reads.length, 1); assert.equal(time.timers.size, 0)
      if (held) {
        assert.equal(signal?.aborted, true); assert.equal(stopped, false)
        assert.ok(fd !== undefined); assert.ok(fstatSync(fd).isFile(), '真实读取未终结前FD仍由原读者持有')
        exited.resolve(); await stopping
        assert.throws(() => fstatSync(fd!), { code: 'EBADF' })
        assert.equal(queue.inspect(f.datasetId).complete, 0, '取消后迟到ready不能完成任务')
      } else { await stopping; assert.equal(queue.inspect(f.datasetId).complete, 1) }
      await time.advance(1); assert.equal(run.reads.length, 1)
    } finally { exited.resolve(); await stopping; await run.worker.close() }
  })
})

test('扫描每页提交新修订仍持续向后，首轮有界，稳定后仅一轮补齐插入首页的新专辑', async t => {
  const f = await fixture(t), all = f.albums(176), albums = all.slice(0, 101), queue = f.open()
  let version = 0, changed = () => {}
  const run = scheduler(t, queue, f, albums, undefined, () => 'scan-one:scanning', undefined, {
    revision: () => `catalog-${version}`,
    afterPage() {
      if (version >= 3) return
      // 查询返回前插入排序前缀，既改变修订，也会使仅向后的一轮漏掉新条目。
      albums.unshift(...all.slice(101 + version * 25, 126 + version * 25)); version++; changed()
    },
  })
  changed = () => run.worker.notifyChanged(f.rootId, 'scan-one:scanning')
  run.worker.start()
  for (let n = 0; n < 3; n++) await run.worker.runPending()
  assert.deepEqual(run.pages, [0, 50, 100], '每批新修订不能把正在发现的一轮推回首页')
  for (let n = 0; n < 190 && queue.inspect(f.datasetId).complete < albums.length; n++) await run.worker.runPending()
  assert.deepEqual(run.pages, [0, 50, 100, 0, 50, 100, 150], '变动合并成稳定后的完整补扫，首轮不追逐新增尾部')
  assert.equal(queue.inspect(f.datasetId).complete, 176)
  assert.equal(new Set(run.reads).size, 176); assert.equal(run.reads.length, 176)
  await run.worker.runPending(); assert.equal(run.pages.length, 7, '完成后没有自发的首页循环')
})

test('扫描终态通知即使全库修订未再变化也发现最后新增专辑并保留补齐语义', async t => {
  const f = await fixture(t), all = f.albums(2), albums = all.slice(0, 1), queue = f.open()
  let source = 'scan-one:scanning'
  const run = scheduler(t, queue, f, albums, undefined, () => source)
  run.worker.start(); await run.worker.runPending()
  assert.equal(queue.inspect(f.datasetId).complete, 1)
  albums.push(all[1]!); source = 'scan-one:completed'; run.worker.notifyChanged(f.rootId, source)
  await run.worker.runPending(); await run.worker.runPending(); await run.worker.runPending()
  assert.deepEqual(run.pages, [0, 0]); assert.equal(queue.inspect(f.datasetId).complete, 2)
  assert.equal(run.reads.length, 3, '终态仍按原语义重验该源，不能为了减少读取跳过最终补图')
  assert.ok(run.reads.includes(all[1]!.id))
})

test('dirty与发现断点可靠落盘，暂停冷开不自动跑，恢复先续原轮再补扫', async t => {
  const f = await fixture(t), all = f.albums(124), albums = all.slice(0, 123), queue = f.open()
  let version = 'catalog-first'
  const first = scheduler(t, queue, f, albums, undefined, undefined, undefined, { revision: () => version })
  first.worker.start(); await first.worker.runPending()
  albums.unshift(all[123]!); version = 'catalog-next'
  await first.worker.runPending(); assert.deepEqual(first.pages, [0, 50])
  await first.worker.pause(); await first.worker.close(); queue.close()
  const reopened = f.open(), cold = scheduler(t, reopened, f, albums, undefined, undefined, undefined, { revision: () => version })
  cold.worker.start(); await cold.worker.runPending()
  assert.deepEqual(cold.pages, []); assert.deepEqual(cold.reads, [])
  cold.worker.resume(); await cold.worker.runPending()
  assert.deepEqual(cold.pages, [100], '冷开不能因全库revision变化丢掉原轮向后断点')
  for (let n = 0; n < 135 && reopened.inspect(f.datasetId).complete < albums.length; n++) await cold.worker.runPending()
  assert.deepEqual(cold.pages, [100, 0, 50, 100])
  assert.equal(reopened.inspect(f.datasetId).complete, 124)
  assert.equal(new Set([...first.reads, ...cold.reads]).size, 124)
})

test('当轮目录上界固定且目录缩小能结束，变动后的最终补扫不被空尾页卡住', async t => {
  const f = await fixture(t), albums = f.albums(123), queue = f.open()
  let version = 'catalog-before-delete'
  const run = scheduler(t, queue, f, albums, undefined, undefined, undefined, { revision: () => version })
  run.worker.start(); await run.worker.runPending()
  albums.splice(45); version = 'catalog-after-delete'
  await run.worker.runPending(); await run.worker.runPending()
  assert.deepEqual(run.pages, [0, 50, 0], '空尾页结束旧轮，随后完整发现当前目录')
  for (let n = 0; n < 55; n++) await run.worker.runPending()
  assert.deepEqual(run.pages, [0, 50, 0])
})

test('快照变化不无限回首页，同一水位最多补扫一次，失败重试遵守逐次冷却', async t => {
  const f = await fixture(t), albums = f.albums(1), queue = f.open()
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const run = scheduler(t, queue, f, albums, async () => { throw Object.assign(new Error('合成快照已变化。'), { code: 'SNAPSHOT_CHANGED' }) })
  run.worker.start(); await run.worker.runPending()
  for (let n = 0; n < 20; n++) await run.worker.runPending()
  assert.deepEqual(run.pages, [0, 0]); assert.equal(run.reads.length, 1)
  now += 5000; await run.worker.runPending()
  assert.equal(run.reads.length, 2)
  for (let n = 0; n < 20; n++) await run.worker.runPending()
  assert.deepEqual(run.pages, [0, 0], '相同快照拒绝不能每次重启完整发现')
  albums[0] = { ...albums[0]!, revision: revision('scan-next-album-revision') }
  run.worker.prioritize(albums); await run.worker.runPending()
  assert.equal(run.reads.length, 2, '新专辑修订不能清掉前一失败的冷却')
  now += 9999; await run.worker.runPending(); assert.equal(run.reads.length, 2)
  now++; await run.worker.runPending(); assert.equal(run.reads.length, 3)
  assert.deepEqual(run.pages, [0, 0])
})

test('同源新五元身份撤旧令牌但保留冷却与次数，冷开不清零，真实来源换代才重置', async t => {
  const f = await fixture(t), album = f.albums(1)[0]!, queue = f.open()
  queue.recover(f.datasetId); queue.enqueue(f.datasetId, [request(album)])
  const first = queue.claim(f.datasetId, 1000)!
  assert.equal(first.attempts, 1); assert.equal(queue.retry(first, 10_000), true)
  const next = { ...request(album), revision: revision('next-batch'), representativeTrackId: randomUUID() }
  queue.enqueue(f.datasetId, [next], 1000)
  assert.equal(queue.claim(f.datasetId, 9999), null)
  const second = queue.claim(f.datasetId, 10_000)!
  assert.equal(second.attempts, 2); assert.deepEqual(second.request, next)
  assert.equal(queue.complete(first), false); queue.retry(second, 30_000); queue.close()
  const cold = f.open(); cold.recover(f.datasetId)
  const thirdRequest = { ...next, revision: revision('another-batch') }
  cold.enqueue(f.datasetId, [thirdRequest]); assert.equal(cold.claim(f.datasetId, 29_999), null)
  const third = cold.claim(f.datasetId, 30_000)!
  assert.equal(third.attempts, 3)
  assert.equal(cold.refreshRoot(f.datasetId, f.rootId, 'new-source:scanning'), true)
  assert.equal(cold.complete(third), false)
  const fresh = cold.claim(f.datasetId, 30_001)!
  assert.equal(fresh.attempts, 1); assert.equal(fresh.request.refresh, true)
  const sameRevisionNewTrack = { ...thirdRequest, representativeTrackId: randomUUID() }
  cold.enqueue(f.datasetId, [sameRevisionNewTrack])
  assert.equal(cold.complete(fresh), false, '五元身份中的代表曲目改变也须撤销旧领取')
  const changedTrack = cold.claim(f.datasetId, 30_001)!
  assert.equal(changedTrack.request.representativeTrackId, sameRevisionNewTrack.representativeTrackId)
  assert.equal(changedTrack.attempts, 2)
})

test('源暂不可读的三十秒冷却不被同一扫描批次的新专辑修订清零', async t => {
  const f = await fixture(t), albums = f.albums(1), queue = f.open()
  let now = Date.now(), version = 'catalog-first', attempts = 0
  t.mock.method(Date, 'now', () => now)
  const run = scheduler(t, queue, f, albums, async value => ++attempts === 1
    ? { ...value, image: null, status: 'source-unavailable' } : ready(value), () => 'scan-one:scanning', undefined, { revision: () => version })
  run.worker.start(); await run.worker.runPending()
  albums[0] = { ...albums[0]!, revision: revision('new-tags-during-unavailable') }; version = 'catalog-next'
  run.worker.notifyChanged(f.rootId, 'scan-one:scanning')
  for (let n = 0; n < 10; n++) await run.worker.runPending()
  assert.equal(run.reads.length, 1); assert.equal(queue.inspect(f.datasetId).complete, 0)
  now += 29_999; await run.worker.runPending(); assert.equal(run.reads.length, 1)
  now++; await run.worker.runPending()
  assert.equal(run.reads.length, 2); assert.equal(queue.inspect(f.datasetId).complete, 1)
})

test('相同扫描通知不打断在途源读，真实新来源代次同步撤资格并等待原读取退出', async t => {
  const f = await fixture(t), albums = f.albums(1), queue = f.open(), entered = deferred(), exited = deferred()
  let sourceRevision = 'scan-one:scanning', signal: AbortSignal | undefined
  const requests: LocalAlbumArtworkRequest[] = []
  const run = scheduler(t, queue, f, albums, async (value, options) => {
    requests.push(value)
    if (requests.length === 1) { signal = options.signal; entered.resolve(); await exited.promise }
    return ready(value)
  }, () => sourceRevision)
  run.worker.start(); const processing = run.worker.runPending(); await entered.promise
  run.worker.notifyChanged(f.rootId, sourceRevision)
  assert.equal(signal?.aborted, false); assert.equal(queue.inspect(f.datasetId).running, 1)
  sourceRevision = 'scan-two:scanning'; run.worker.notifyChanged(f.rootId, sourceRevision)
  assert.equal(signal?.aborted, true)
  assert.deepEqual(queue.inspect(f.datasetId), { mode: 'running', pending: 1, running: 0, complete: 0 })
  let settled = false; void processing.then(() => { settled = true })
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(settled, false)
  exited.resolve(); await processing
  assert.equal(queue.inspect(f.datasetId).complete, 0, '旧代次迟到ready不能冒充新来源已落盘')
  await run.worker.runPending()
  assert.equal(requests.length, 2); assert.equal(requests[1]!.refresh, true)
  assert.equal(queue.inspect(f.datasetId).complete, 1)
})

test('根重关联或根revision变化立即撤旧令牌与冷却，独立于全库修订', async t => {
  const f = await fixture(t), album = f.albums(1)[0]!, queue = f.open()
  queue.recover(f.datasetId)
  queue.cursor(f.datasetId, f.rootId, `${f.view.root.sourceRootId}:1`, 'catalog-same')
  queue.enqueue(f.datasetId, [request(album)])
  const first = queue.claim(f.datasetId, 1000)!
  queue.retry(first, 60_000)
  f.view.root.sourceRootId = randomUUID()
  const relinked = queue.cursor(f.datasetId, f.rootId, `${f.view.root.sourceRootId}:1`, 'catalog-same')
  assert.equal(relinked.code, 'ROOT_CHANGED'); assert.equal(relinked.offset, 0)
  const fresh = queue.claim(f.datasetId, 1001)!
  assert.equal(fresh.attempts, 1); assert.equal(fresh.request.refresh, true)
  f.view.root.revision = '2'
  queue.cursor(f.datasetId, f.rootId, `${f.view.root.sourceRootId}:2`, 'catalog-same')
  assert.equal(queue.complete(fresh), false)
  assert.equal(queue.claim(f.datasetId, 1002)!.attempts, 1)
})

test('旧opaque游标保守首轮且保控制状态，新私有游标闭集有界、不更改schema', async t => {
  const f = await fixture(t), albums = f.albums(123), queue = f.open()
  queue.recover(f.datasetId); queue.setMode(f.datasetId, 'paused'); queue.close()
  const legacy = new DatabaseSync(path.join(f.directory, 'queue.sqlite'))
  legacy.prepare('INSERT INTO artwork_queue_cursors VALUES(?,?,?,100,1)').run(f.datasetId, f.rootId, `${f.view.root.sourceRootId}:1:catalog-v1`)
  const schema = legacy.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all(); legacy.close()
  const reopened = f.open(), run = scheduler(t, reopened, f, albums)
  run.worker.start(); await run.worker.runPending(); assert.deepEqual(run.pages, [])
  run.worker.resume(); await run.worker.runPending(); assert.deepEqual(run.pages, [0])
  const inspect = new DatabaseSync(path.join(f.directory, 'queue.sqlite'))
  try {
    assert.deepEqual(inspect.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all(), schema)
    const row = inspect.prepare('SELECT revision FROM artwork_queue_cursors WHERE dataset_id=? AND root_id=?').get(f.datasetId, f.rootId)!
    const encoded = String(row.revision), state = JSON.parse(encoded) as Record<string, unknown>
    assert.ok(encoded.length <= 512); assert.equal(state.v, 2); assert.equal(state.end, 123)
    assert.deepEqual(Object.keys(state).sort(), ['dirty', 'end', 'identity', 'retryRevision', 'revision', 'v'])
    inspect.prepare('UPDATE artwork_queue_cursors SET revision=?,offset=100,done=1 WHERE dataset_id=? AND root_id=?').run(JSON.stringify({ ...state, extra: true }), f.datasetId, f.rootId)
    const conservative = reopened.cursor(f.datasetId, f.rootId, `${f.view.root.sourceRootId}:1`, 'catalog-v1')
    assert.equal(conservative.offset, 0); assert.equal(conservative.done, false, '未知私有字段不得沿用旧断点')
    inspect.prepare('UPDATE artwork_queue_cursors SET revision=? WHERE dataset_id=? AND root_id=?').run('x'.repeat(513), f.datasetId, f.rootId)
    assert.throws(() => reopened.cursor(f.datasetId, f.rootId, `${f.view.root.sourceRootId}:1`, 'catalog-v1'), { code: 'ARTWORK_QUEUE_UNAVAILABLE' })
  } finally { inspect.close() }
})

test('已完成队列冷开对账：资源库重建后离屏补齐全部资源，每轮最多核对50项', async t => {
  const f = await fixture(t), albums = f.albums(123), queue = f.open(), first = scheduler(t, queue, f, albums)
  first.worker.start()
  for (let index = 0; index < 130 && queue.inspect(f.datasetId).complete < albums.length; index++) await first.worker.runPending()
  assert.equal(queue.inspect(f.datasetId).complete, albums.length)
  await first.worker.close(); queue.close()
  // 独立资源库重建，但持久队列与来源代次均保持；从未打开任何页面。
  const persisted = new Map<string, 'available' | 'missing'>(), reopened = f.open()
  let checked = 0
  const cold = scheduler(t, reopened, f, albums, async value => { persisted.set(value.albumKey, 'missing'); return ready(value) }, undefined,
    value => { checked++; return persisted.get(value.albumKey) ?? null })
  cold.worker.start(); await cold.worker.runPending()
  assert.equal(checked, 50, '启动只读取第一批本地资源状态，不能把complete当作资源仍存在')
  for (let index = 0; index < 130 && persisted.size < albums.length; index++) {
    const before = checked
    await cold.worker.runPending()
    assert.ok(checked - before <= 50, '每轮资源状态对账必须有界')
  }
  assert.equal(persisted.size, albums.length); assert.equal(cold.reads.length, albums.length)
  assert.equal(new Set(cold.reads).size, albums.length, '同一对账轮不能反复重排刚修复的资源')
  assert.deepEqual(cold.pages, [], '资源恢复不必重做已经完成的目录发现')
  assert.equal(reopened.inspect(f.datasetId).complete, albums.length)
})

test('已完成队列冷开对账：完整图片与已确认missing均不重读源，状态故障不冒充资源缺失', async t => {
  const f = await fixture(t), albums = f.albums(3), queue = f.open(), first = scheduler(t, queue, f, albums)
  first.worker.start()
  for (let index = 0; index < albums.length; index++) await first.worker.runPending()
  await first.worker.close()
  let checked = 0, fail = true
  const cold = scheduler(t, queue, f, albums, async () => { throw new Error('有效资源和对账故障均不能触发源读取。') }, undefined,
    value => { checked++; if (fail) throw new Error('合成本地资源状态暂不可用。'); return value.albumKey === albums[0]!.id ? 'missing' : 'available' })
  cold.worker.start(); await cold.worker.runPending()
  assert.ok(checked > 0); assert.deepEqual(queue.inspect(f.datasetId), { mode: 'running', pending: 0, running: 0, complete: 3 })
  fail = false; checked = 0
  for (let index = 0; index < 5; index++) await cold.worker.runPending()
  assert.equal(checked, 3, '健康资源只做一轮本地检查，不随每轮调度重复探测')
  assert.deepEqual(cold.reads, []); assert.deepEqual(cold.pages, [])
})

test('已完成队列冷开对账：显式暂停与取消不检查或复活完成项，仅恢复后补缺', async t => {
  for (const mode of ['paused', 'cancelled'] as const) {
    const f = await fixture(t), albums = f.albums(1), queue = f.open()
    queue.recover(f.datasetId); queue.enqueue(f.datasetId, albums.map(request)); const old = queue.claim(f.datasetId)!
    assert.equal(queue.complete(old), true); queue.setMode(f.datasetId, mode); queue.close()
    const reopened = f.open(), persisted = new Set<string>(); let checked = 0
    const cold = scheduler(t, reopened, f, albums, async value => { persisted.add(value.albumKey); return ready(value) }, undefined,
      value => { checked++; return persisted.has(value.albumKey) ? 'available' : null })
    cold.worker.start(); await cold.worker.runPending()
    assert.equal(checked, 0); assert.deepEqual(cold.reads, []); assert.equal(reopened.inspect(f.datasetId).mode, mode)
    cold.worker.resume(); await cold.worker.runPending()
    assert.ok(checked > 0); assert.equal(cold.reads.length, 1); assert.equal(reopened.complete(old), false)
    assert.deepEqual(reopened.inspect(f.datasetId), { mode: 'running', pending: 0, running: 0, complete: 1 })
    await cold.worker.close()
  }
})

test('完成项对账只重排当前complete，旧领取完成或重试不能改写新领取，撤根不复活', async t => {
  const f = await fixture(t), albums = f.albums(2), queue = f.open()
  queue.recover(f.datasetId); queue.enqueue(f.datasetId, albums.map(request))
  const old = queue.claim(f.datasetId)!, running = queue.claim(f.datasetId)!
  queue.complete(old)
  const result = queue.reconcileCompleted(f.datasetId, null, [f.rootId], () => null)
  assert.equal(result.checked, 1); assert.equal(result.requeued, 1)
  assert.equal(queue.complete(old), false); assert.equal(queue.retry(old, 0), false)
  assert.equal(queue.complete(running), true, '对账不能撤销原在途领取')
  const current = queue.claim(f.datasetId)!
  assert.equal(current.id, old.id); assert.notEqual(current.token, old.token)
  assert.equal(queue.complete(old), false); assert.equal(queue.retry(old, 0), false)
  assert.equal(queue.complete(current), true)
  queue.removeRoot(f.datasetId, f.rootId)
  let checked = 0
  assert.equal(queue.reconcileCompleted(f.datasetId, null, [f.rootId], () => { checked++; return null }).requeued, 0)
  assert.equal(checked, 0); assert.equal(queue.complete(current), false)
})

test('完成项对账本地状态中途故障整批回滚，不把未知状态降成缺失', async t => {
  const f = await fixture(t), albums = f.albums(3), queue = f.open()
  queue.recover(f.datasetId); queue.enqueue(f.datasetId, albums.map(request))
  for (let index = 0; index < albums.length; index++) queue.complete(queue.claim(f.datasetId)!)
  let checked = 0
  assert.throws(() => queue.reconcileCompleted(f.datasetId, null, [f.rootId], () => {
    if (++checked === 2) throw new Error('合成本地状态读取中断。')
    return null
  }), /合成本地状态读取中断/u)
  assert.equal(checked, 2); assert.deepEqual(queue.inspect(f.datasetId), { mode: 'running', pending: 0, running: 0, complete: 3 })
  for (const mode of ['paused', 'cancelled'] as const) {
    queue.setMode(f.datasetId, mode); checked = 0
    const result = queue.reconcileCompleted(f.datasetId, null, [f.rootId], () => { checked++; return null })
    assert.equal(result.requeued, 0); assert.equal(checked, 0); assert.equal(queue.inspect(f.datasetId).mode, mode)
  }
})

test('完成项本地状态定期复核：健康轮后保持安静，资源随后缺失可在下一轮离屏修复', async t => {
  const f = await fixture(t), albums = f.albums(1), queue = f.open(), first = scheduler(t, queue, f, albums)
  first.worker.start(); await first.worker.runPending(); await first.worker.close()
  let now = Date.now(), persisted = true, checked = 0
  t.mock.method(Date, 'now', () => now)
  const cold = scheduler(t, queue, f, albums, async value => { persisted = true; return ready(value) }, undefined,
    () => { checked++; return persisted ? 'available' : null })
  cold.worker.start(); await cold.worker.runPending()
  assert.equal(checked, 1); assert.equal(cold.reads.length, 0)
  persisted = false; await cold.worker.runPending()
  assert.equal(checked, 1); assert.equal(cold.reads.length, 0, '健康轮后不能在每次调度重新检查整库')
  now += 5 * 60_000; await cold.worker.runPending()
  assert.equal(checked, 2); assert.equal(cold.reads.length, 1); assert.equal(persisted, true)
})

test('旧队列补装完成项索引保留人工暂停与旧任务，不重建任务身份', async t => {
  const f = await fixture(t), albums = f.albums(1), queue = f.open()
  queue.recover(f.datasetId); queue.enqueue(f.datasetId, albums.map(request)); const claim = queue.claim(f.datasetId)!
  queue.complete(claim); queue.setMode(f.datasetId, 'paused'); queue.close()
  const legacy = new DatabaseSync(path.join(f.directory, 'queue.sqlite'))
  legacy.exec('DROP INDEX artwork_queue_completed'); legacy.close()
  const reopened = f.open(); reopened.recover(f.datasetId)
  assert.deepEqual(reopened.inspect(f.datasetId), { mode: 'paused', pending: 0, running: 0, complete: 1 })
  reopened.setMode(f.datasetId, 'running')
  assert.equal(reopened.reconcileCompleted(f.datasetId, null, [f.rootId], () => null).requeued, 1)
  assert.equal(reopened.claim(f.datasetId)?.id, claim.id, '索引升级和资源重排均保留原逻辑任务身份')
})

test('前台可见专辑先于已发现后台项，源变更通知显式重验该库旧结果', async t => {
  const f = await fixture(t), albums = f.albums(110), queue = f.open(), requests: LocalAlbumArtworkRequest[] = []
  const run = scheduler(t, queue, f, albums, async value => { requests.push(value); return ready(value) })
  run.worker.start(); await run.worker.runPending()
  run.worker.prioritize([albums[99]!]); await run.worker.runPending()
  assert.equal(run.reads[1], albums[99]!.id)
  for (let index = 0; index < 115 && queue.inspect(f.datasetId).complete < albums.length; index++) await run.worker.runPending()
  const before = run.reads.length
  albums[0] = { ...albums[0]!, revision: revision('committed-new-tags') }
  run.worker.notifyChanged(f.rootId); await run.worker.runPending()
  assert.equal(run.reads.length, before + 1); assert.equal(run.reads.at(-1), albums[99]!.id)
  await run.worker.runPending()
  assert.equal(run.reads.at(-1), albums[0].id); assert.equal(requests.at(-1)?.revision, albums[0].revision)
  assert.equal(requests.at(-1)?.refresh, true)
  assert.equal(queue.inspect(f.datasetId).complete, 2); assert.equal(queue.inspect(f.datasetId).pending, 108)
})

test('图片源变更即使音频修订不变也持久重排，仅影响同根且同扫描代次幂等', async t => {
  const f = await fixture(t), albums = f.albums(2), queue = f.open(), otherRoot = randomUUID()
  const other = { ...albums[0]!, rootId: otherRoot }
  queue.recover(f.datasetId); queue.enqueue(f.datasetId, [...albums, other].map(request))
  for (let n = 0; n < 3; n++) assert.equal(queue.complete(queue.claim(f.datasetId)!), true)
  assert.equal(queue.refreshRoot(f.datasetId, f.rootId, 'scan-one:scanning'), true)
  assert.deepEqual(queue.inspect(f.datasetId), { mode: 'running', pending: 2, running: 0, complete: 1 })
  const first = queue.claim(f.datasetId)!
  assert.equal(first.request.refresh, true); assert.equal(first.request.rootId, f.rootId)
  queue.complete(first)
  assert.equal(queue.refreshRoot(f.datasetId, f.rootId, 'scan-one:scanning'), false)
  assert.deepEqual(queue.inspect(f.datasetId), { mode: 'running', pending: 1, running: 0, complete: 2 })
  queue.close()
  const cold = f.open(); cold.recover(f.datasetId)
  assert.equal(cold.refreshRoot(f.datasetId, f.rootId, 'scan-one:scanning'), false)
  const pending = cold.claim(f.datasetId)!
  assert.equal(pending.request.refresh, true); cold.complete(pending)
  assert.equal(cold.refreshRoot(f.datasetId, f.rootId, 'scan-one:completed'), true)
  assert.deepEqual(cold.inspect(f.datasetId), { mode: 'running', pending: 2, running: 0, complete: 1 })
})

test('主库扫描已提交但通知尚未处理便中断，冷开从原批次代次补足源图重验', async t => {
  const f = await fixture(t), albums = f.albums(1), queue = f.open()
  queue.recover(f.datasetId); queue.enqueue(f.datasetId, albums.map(request)); queue.refreshRoot(f.datasetId, f.rootId, 'old-scan:completed')
  queue.complete(queue.claim(f.datasetId)!); queue.close()
  const reopened = f.open(), requests: LocalAlbumArtworkRequest[] = []
  const cold = scheduler(t, reopened, f, albums, async value => { requests.push(value); return ready(value) }, () => 'new-scan:completed')
  cold.worker.start(); await cold.worker.runPending()
  assert.equal(requests.length, 1); assert.equal(requests[0]!.refresh, true)
  assert.equal(reopened.inspect(f.datasetId).complete, 1)
  await cold.worker.runPending(); assert.equal(requests.length, 1)
})

test('NAS离线只保留待办，在线后继续，不能把离线当作已确认无图', async t => {
  const f = await fixture(t), albums = f.albums(3), queue = f.open(), run = scheduler(t, queue, f, albums)
  f.view.availability = 'SOURCE_ROOT_OFFLINE'
  run.worker.start(); await run.worker.runPending()
  assert.equal(run.reads.length, 0); assert.equal(queue.inspect(f.datasetId).pending, 3); assert.equal(queue.inspect(f.datasetId).complete, 0)
  f.view.availability = 'ONLINE'
  for (let index = 0; index < 3; index++) await run.worker.runPending()
  assert.equal(queue.inspect(f.datasetId).complete, 3)
})

test('资源尚未持久完成或落盘失败时队列不得完成，关闭须等待真正读取退出', async t => {
  const f = await fixture(t), albums = f.albums(1), queue = f.open(), entered = deferred(), exited = deferred(), aborted = deferred()
  const run = scheduler(t, queue, f, albums, async (value, options) => {
    options.signal.addEventListener('abort', aborted.resolve, { once: true }); entered.resolve()
    await exited.promise; return ready(value)
  })
  run.worker.start(); const processing = run.worker.runPending(); await entered.promise
  assert.equal(queue.inspect(f.datasetId).running, 1); assert.equal(queue.inspect(f.datasetId).complete, 0)
  let closed = false
  const closing = run.worker.close().then(() => { closed = true })
  await aborted.promise; await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(closed, false)
  exited.resolve(); await processing; await closing
  assert.equal(queue.inspect(f.datasetId).pending, 1); assert.equal(queue.inspect(f.datasetId).complete, 0)
  const retry = scheduler(t, queue, f, albums, async () => { throw new Error('合成资源COMMIT失败。') })
  retry.worker.start(); await retry.worker.runPending()
  assert.equal(queue.inspect(f.datasetId).pending, 1); assert.equal(queue.inspect(f.datasetId).complete, 0)
})

test('明确移除根目录取消并等待在途任务，墓碑阻止迟到完成及冷启动重新入队', async t => {
  const f = await fixture(t), albums = f.albums(1), queue = f.open(), entered = deferred(), exited = deferred(), aborted = deferred()
  const run = scheduler(t, queue, f, albums, async (value, options) => {
    options.signal.addEventListener('abort', aborted.resolve, { once: true }); entered.resolve()
    await exited.promise; return ready(value)
  })
  run.worker.start(); const processing = run.worker.runPending(); await entered.promise
  let removed = false
  const removing = run.worker.removeRoot(f.rootId).then(() => { removed = true })
  await aborted.promise; assert.equal(removed, false)
  exited.resolve(); await processing; await removing
  assert.deepEqual(queue.inspect(f.datasetId), { mode: 'running', pending: 0, running: 0, complete: 0 })
  await run.worker.close(); queue.close()
  const reopened = f.open(), cold = scheduler(t, reopened, f, albums)
  cold.worker.start(); cold.worker.prioritize(albums); await cold.worker.runPending()
  assert.equal(cold.reads.length, 0); assert.equal(cold.pages.length, 0); assert.equal(reopened.inspect(f.datasetId).pending, 0)
})

test('后台显式暂停、取消在冷开后不自动运行，只有显式恢复才消费任务', async t => {
  const f = await fixture(t), albums = f.albums(2), queue = f.open(), first = scheduler(t, queue, f, albums)
  first.worker.start(); first.worker.prioritize(albums); await first.worker.pause(); await first.worker.close(); queue.close()
  const reopened = f.open(), cold = scheduler(t, reopened, f, albums)
  cold.worker.start(); await cold.worker.runPending(); assert.equal(cold.reads.length, 0)
  await cold.worker.cancel(); await cold.worker.close(); reopened.close()
  const cancelledQueue = f.open(), cancelled = scheduler(t, cancelledQueue, f, albums)
  cancelled.worker.start(); await cancelled.worker.runPending(); assert.equal(cancelled.reads.length, 0)
  cancelled.worker.resume(); await cancelled.worker.runPending(); await cancelled.worker.runPending()
  assert.equal(cancelledQueue.inspect(f.datasetId).complete, 2)
})

test('生产Owner后台播放繁忙时整轮让步，不借前台display豁免、不领取Source或写missing', async t => {
  const f = await fixture(t), media = path.join(f.directory, 'media')
  await mkdir(media)
  const wav = Buffer.alloc(48)
  wav.write('RIFF'); wav.writeUInt32LE(40, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(192000, 28)
  wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(4, 40)
  await writeFile(path.join(media, 'sample.wav'), wav)
  const repository = createCollectionRepository({ filePath: path.join(f.directory, 'collection.sqlite') })
  const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media))
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' })
  const asset = repository.localCatalog.registerAsset({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision,
    relative: 'sample.wav', sha256: null, sampleFrames: null, timebaseHz: null })
  const track = repository.localCatalog.createTrack({ commandId: randomUUID(), assetId: asset.id, segment: null })
  repository.localCatalog.observeMetadata({ commandId: randomUUID(), trackId: track.id, source: 'synthetic', parserVersion: 'background-fixture-v1', fields: { title: '合成歌曲', album: '合成专辑' } })
  const gate = createScanReadAdmission({ isBusy: () => true, isDisplayBusy: () => false })
  const context = { datasetId: f.datasetId, epoch: randomUUID() }, purposes: string[] = []; let probes = 0
  const projection: DatasetProjectionPort = { async call(command, payload) {
    if (command === 'scanReadStatus') { probes++; return gate.status(context) as never }
    if (command === 'scanReadAcquire') {
      const purpose = (payload as { purpose?: 'local-album-display' }).purpose
      purposes.push(purpose ?? 'scan'); return gate.acquire(context, purpose) as never
    }
    throw new Error('播放繁忙的合成后台任务不能读取源文件或调用图像解码。')
  } }
  const runtime = createLocalAlbumOwnerRuntime({ repository, projection, datasetId: f.datasetId, assertCurrent() {},
    async readRootViews() { return [{ root, label: '合成音乐库', availability: 'ONLINE' }] },
  })
  try {
    const before = repository.readonlySnapshotStamp()
    assert.ok(runtime.background)
    runtime.background.start(); await runtime.background.runPending()
    assert.equal(probes, 1); assert.deepEqual(purposes, [])
    assert.equal(runtime.background.inspect().pending, 0); assert.equal(runtime.background.inspect().complete, 0)
    assert.equal(gate.resourceCounts().permits, 0)
    assert.deepEqual(repository.readonlySnapshotStamp(), before)
  } finally { await runtime.close(); gate.close(); repository.close() }
})
