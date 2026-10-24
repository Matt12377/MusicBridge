import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as dto from '@music-bridge/contracts'
import { createCollectionRepository } from '../../src/collection/repository.js'
import { createLocalAlbumOwnerService } from '../../src/collection/local-album-browser/owner-port.js'
import { createLocalAlbumOwnerRuntime } from '../../src/collection/local-album-browser/owner-runtime.js'
import { isLocalAlbumBackgroundCandidatePage, isLocalAlbumBackgroundCandidateQuery,
  type LocalAlbumBackgroundCandidateQuery } from '../../src/collection/local-album-browser/artwork-background-candidates.js'
import type { LocalAlbumLibraryOrganization } from '../../src/collection/local-album-browser/sql-types.js'
import type { DatasetProjectionPort } from '../../src/collection/dataset-owner-protocol.js'
import { authorizeSourceDirectory } from '../../src/recording/source-files.js'
import { readLibraryOperationLine, type LibraryOperationEvent } from '../../src/shared/library-operation-log.js'
import { libraryRemovalClock } from '../helpers/library-removal-clock.js'

// 仅使用本测试新建的空Source目录、合成目录事实和真实SQLite；不扫描媒体、不连接NAS。
const request = (album: dto.LocalAlbumSummary): dto.LocalAlbumArtworkRequest => ({ albumKey: album.id, rootId: album.rootId,
  editionId: album.editionId, representativeTrackId: album.representativeTrackId, revision: album.revision })
const publicQuery = (rootId: string | null, offset = 0, limit = 50): dto.LocalAlbumQuery => ({ rootId, offset, limit, query: '', filter: 'all' })
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
function observe(t: TestContext): LibraryOperationEvent[] {
  const events: LibraryOperationEvent[] = []
  t.mock.method(console, 'info', (...args: unknown[]) => {
    for (const line of args) { const event = typeof line === 'string' ? readLibraryOperationLine(line) : null; if (event) events.push(event) }
  })
  return events
}
const builds = (events: readonly LibraryOperationEvent[]): number => events.filter(event => event.action === 'albums.compact-groups' && event.code === 'COMPACT_BUILT').length

async function fixture(t: TestContext, count = 63) {
  const temporary = process.env.TMPDIR
  assert.ok(temporary && path.isAbsolute(temporary))
  if (process.platform === 'darwin') assert.ok(path.resolve(temporary).startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'))
  const directory = await mkdtemp(path.join(temporary, 'album-background-candidates-'))
  const repository = createCollectionRepository({ filePath: path.join(directory, 'collection.sqlite') }), datasetId = randomUUID()
  const views: dto.LocalRootView[] = [], organizations: LocalAlbumLibraryOrganization[] = []
  const cleanups: (() => void | Promise<void>)[] = []
  t.after(async () => { for (const close of cleanups.reverse()) await close(); repository.close(); await rm(directory, { recursive: true, force: true }) })
  for (let library = 0; library < 2; library++) {
    const media = path.join(directory, `空来源-${library}`); await mkdir(media)
    const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media))
    const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' })
    views.push({ root, label: `合成根${library}`, availability: 'ONLINE' })
    for (let album = 0; album < (library === 0 ? count : 2); album++) {
      const ordinal = String(album).padStart(3, '0')
      const asset = repository.localCatalog.registerAsset({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision,
        relative: `合成艺人/专辑${ordinal}/CD1/01.wav`, sha256: null, sampleFrames: null, timebaseHz: null })
      const track = repository.localCatalog.createTrack({ commandId: randomUUID(), assetId: asset.id, segment: null })
      repository.localCatalog.observeMetadata({ commandId: randomUUID(), trackId: track.id, source: 'synthetic', parserVersion: 'background-candidates-v1',
        fields: { title: `合成曲目${ordinal}`, artist: '合成艺人', album: `合成专辑${ordinal}` } })
    }
  }
  const states = new Map<string, 'available' | 'missing'>()
  let inventoryRevision = 0, stateReads = 0, frames = 0, inFrame = false, current = true
  let refreshHook: (() => void | Promise<void>) | undefined
  const options = { repository, datasetId,
    assertCurrent() { if (!current) throw new Error('合成Owner身份已撤销。') },
    async readRootViews() { await refreshHook?.(); return views },
    readLibraryOrganizations: () => organizations,
    readArtwork: async () => ({ image: null, status: 'ready' as const }),
    savedArtworkInventory: { revision: () => String(inventoryRevision), read(key: string) { assert.equal(inFrame, true); stateReads++; return states.get(key) ?? null } },
    withArtworkInventoryRead<T>(read: () => T): T { assert.equal(inFrame, false); frames++; inFrame = true; try { return read() } finally { inFrame = false } },
  }
  const owner = createLocalAlbumOwnerService(options); cleanups.push(() => owner.close())
  return { repository, datasetId, views, states, options, owner,
    addCleanup(close: () => void | Promise<void>) { cleanups.push(close) },
    stateReads: () => stateReads, frames: () => frames,
    bumpInventory() { inventoryRevision++ },
    revokeOwner() { current = false },
    refresh(value: typeof refreshHook) { refreshHook = value },
    role(role?: dto.LocalLibraryRole) {
      organizations.length = 0
      if (role) for (const view of views) organizations.push({ datasetId, rootId: view.root.id, sourceRootId: view.root.sourceRootId,
        rootRevision: view.root.revision, bindingRevision: 1, recordSha256: 'a'.repeat(64), role, rootName: '合成艺人', parentName: '合成来源' })
    },
  }
}

test('后台候选页：真实Owner公开→私有→公开不切换库存作者、不重建整root，完整counts及跨页身份不变', async t => {
  const events = observe(t), f = await fixture(t), rootId = f.views[0]!.root.id
  const all = await f.owner.queryAlbums(publicQuery(null, 0, 200))
  assert.equal(all.total, 65); assert.equal(builds(events), 1)
  const selected = all.items.filter(item => item.rootId === rootId)
  assert.equal(selected.length, 63)
  for (const [index, album] of selected.entries()) if (index % 3 !== 2) f.states.set(album.id, index % 3 === 0 ? 'available' : 'missing')
  f.bumpInventory()
  const before = await f.owner.queryAlbums(publicQuery(rootId))
  assert.equal(before.counts.all, 63); assert.equal(before.counts['has-artwork'], 21); assert.equal(before.counts['missing-artwork'], 21)
  const stateReads = f.stateReads(), frames = f.frames(), start = events.length
  const collected: dto.LocalAlbumArtworkRequest[] = []
  for (const offset of [0, 50, 100]) {
    const query = { rootId, offset, limit: 50 }
    const page = await f.owner.privateBackgroundCandidates(query, new AbortController().signal)
    assert.equal(isLocalAlbumBackgroundCandidatePage(page, query), true)
    assert.deepEqual(Object.keys(page).sort(), ['rootId','offset','limit','total','hasMore','items'].sort())
    assert.equal(page.total, 63); assert.equal(page.hasMore, offset === 0)
    assert.equal(page.items.length, offset === 0 ? 50 : offset === 50 ? 13 : 0)
    assert.ok(page.items.every(item => item.rootId === rootId)); collected.push(...page.items)
  }
  assert.equal(f.stateReads(), stateReads, '候选页不能对整G调用库存state，也不能回填公开artworkPrepared')
  assert.equal(f.frames() - frames, 3, '每次候选读取仍进入原同步库存scope')
  const after = await f.owner.queryAlbums(publicQuery(rootId, 50))
  assert.deepEqual(after.counts, before.counts, '公开counts必须包含页外的真实available/missing事实')
  assert.deepEqual(collected, [...before.items, ...after.items].map(request))
  assert.equal(builds(events.slice(start)), 0, '同Owner后台发现不能把库存作者切成另一对象并逐出Compact')
  assert.equal(builds(events), 1)
  const timings = events.filter(event => event.action === 'albums.background-candidates')
  assert.equal(timings.length, 3); assert.ok(timings.every(event => event.state === 'complete' && event.code === 'COMPACT_PAGE' && event.elapsedMs! >= 0))
  assert.deepEqual(timings.map(event => event.count), [50, 13, 0])
})

test('后台候选页：未绑定及catalog/artist/album/container组织都复用原groups、排序、根过滤和修订', async t => {
  const f = await fixture(t, 3)
  for (const role of [undefined, 'catalog', 'artist', 'album', 'container'] as const) await t.test(role ?? '旧组织', async () => {
    f.role(role)
    for (const view of f.views) {
      const query = { rootId: view.root.id, offset: 0, limit: 50 }
      const reads = f.stateReads()
      // 先走私有冷路径，不能靠公开页先投影出来的items拼假候选。
      const candidates = await f.owner.privateBackgroundCandidates(query, new AbortController().signal)
      assert.equal(f.stateReads(), reads)
      const page = await f.owner.queryAlbums(publicQuery(view.root.id))
      assert.deepEqual(candidates.items, page.items.map(request)); assert.equal(candidates.total, page.total)
      assert.equal(candidates.hasMore, page.hasMore); assert.ok(candidates.items.every(item => item.rootId === view.root.id))
      if (role === 'album') assert.equal(candidates.total, 1)
    }
  })
})

test('后台候选页：公开purpose=background仍保原公开counts路径，runtime只向队列闭包交付私有方法', async t => {
  const f = await fixture(t, 2), rootId = f.views[0]!.root.id
  const privateRead = t.mock.method(f.repository.localCatalog, 'privateAlbumBrowserBackgroundCandidates')
  const publicRead = t.mock.method(f.repository.localCatalog, 'privateAlbumBrowserQuery')
  const publicPage = await f.owner.queryAlbums(publicQuery(rootId), { purpose: 'background', signal: new AbortController().signal })
  assert.equal(dto.isLocalAlbumPage(publicPage, publicQuery(rootId)), true)
  assert.equal(publicRead.mock.callCount(), 1); assert.equal(privateRead.mock.callCount(), 0)
  privateRead.mock.restore(); publicRead.mock.restore()
  const queue = f.repository.privateLocalAlbumArtworkQueue; assert.ok(queue)
  const original = f.repository.localCatalog.privateAlbumBrowserBackgroundCandidates
  let candidates = 0, projections = 0
  const query = t.mock.method(f.repository.localCatalog, 'privateAlbumBrowserBackgroundCandidates', (value: Parameters<typeof original>[0], scope: Parameters<typeof original>[1]) => {
    const page = original.call(f.repository.localCatalog, value, scope); candidates++
    queue.setMode(f.datasetId, 'paused'); return page
  })
  const forbidden = t.mock.method(f.repository.localCatalog, 'privateAlbumBrowserQuery', () => { throw new Error('后台发现不能退回公开封面/counts查询。') })
  const projection: DatasetProjectionPort = { async call(command) { if (command === 'scanReadStatus') return { status: 'ready' } as never; projections++; throw new Error('发现候选身份不能申请Source读许可或解码图片。') } }
  const runtime = createLocalAlbumOwnerRuntime({ ...f.options, projection })
  f.addCleanup(() => runtime.close())
  assert.equal(Object.hasOwn(runtime.localAlbums, 'privateBackgroundCandidates'), false)
  assert.ok(runtime.background); runtime.background.start(); await runtime.background.runPending()
  assert.equal(candidates, 1); assert.equal(forbidden.mock.callCount(), 0); assert.equal(projections, 0)
  assert.equal(queue.inspect(f.datasetId).pending, 0, '发现返回后显式暂停仍在enqueue前生效')
  query.mock.restore(); forbidden.mock.restore()
})

test('后台候选页：实际SQL末屏障拒绝读取中库存revision变化，Owner seal拒绝完成后的旧代次', async t => {
  const f = await fixture(t, 2), query = { rootId: f.views[0]!.root.id, offset: 0, limit: 50 }
  const prepare = DatabaseSync.prototype.prepare
  let injected = false
  const changed = t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    const statement = prepare.call(this, sql), get = statement.get
    if (sql.includes('page_rows AS MATERIALIZED') && sql.includes("'albumKey'")) t.mock.method(statement, 'get', (...args: unknown[]) => {
      const row = Reflect.apply(get, statement, args)
      if (!injected) { injected = true; f.bumpInventory() }
      return row
    })
    return statement
  })
  await assert.rejects(f.owner.privateBackgroundCandidates(query, new AbortController().signal), { code: 'SNAPSHOT_CHANGED' })
  assert.equal(injected, true); changed.mock.restore()
  const original = f.repository.localCatalog.privateAlbumBrowserBackgroundCandidates
  const stale = t.mock.method(f.repository.localCatalog, 'privateAlbumBrowserBackgroundCandidates', (value: Parameters<typeof original>[0], scope: Parameters<typeof original>[1]) => {
    const page = original.call(f.repository.localCatalog, value, scope); f.owner.invalidate(); return page
  })
  await assert.rejects(f.owner.privateBackgroundCandidates(query, new AbortController().signal), { code: 'SNAPSHOT_CHANGED' })
  stale.mock.restore()
  assert.equal((await f.owner.privateBackgroundCandidates(query, new AbortController().signal)).total, 2)
})

test('后台候选页：等待原refresh期间取消/关闭不越过SQL，撤销Owner身份仍拒绝', async t => {
  for (const control of ['abort', 'close', 'identity'] as const) await t.test(control, async child => {
    const f = await fixture(child, 1), entered = deferred(), release = deferred()
    child.after(() => release.resolve())
    f.refresh(async () => { entered.resolve(); await release.promise })
    const sql = child.mock.method(f.repository.localCatalog, 'privateAlbumBrowserBackgroundCandidates')
    const controller = new AbortController()
    const pending = f.owner.privateBackgroundCandidates({ rootId: f.views[0]!.root.id, offset: 0, limit: 50 }, controller.signal)
    const rejected = assert.rejects(pending)
    await entered.promise
    if (control === 'abort') controller.abort()
    else if (control === 'close') f.owner.close()
    else f.revokeOwner()
    release.resolve(); await rejected
    assert.equal(sql.mock.callCount(), 0)
  })
})

test('后台候选页：闭集参数不接受公开filter/query或超50页；reply不能夹带counts、错根或稀疏项', async t => {
  const f = await fixture(t, 1), query = { rootId: f.views[0]!.root.id, offset: 0, limit: 50 }
  const invalid: unknown[] = [{ ...query, query: '' }, { ...query, filter: 'all' }, { ...query, limit: 51 }, { ...query, limit: 0 },
    { ...query, offset: -1 }, { ...query, rootId: null }, { ...query, offset: Number.MAX_SAFE_INTEGER + 1 }]
  for (const value of invalid) {
    assert.equal(isLocalAlbumBackgroundCandidateQuery(value), false)
    await assert.rejects(f.owner.privateBackgroundCandidates(value as LocalAlbumBackgroundCandidateQuery, new AbortController().signal), { code: 'INVALID_REQUEST' })
  }
  const page = await f.owner.privateBackgroundCandidates(query, new AbortController().signal)
  assert.equal(isLocalAlbumBackgroundCandidatePage(page, query), true)
  assert.equal(isLocalAlbumBackgroundCandidatePage({ ...page, counts: { all: 1 } }, query), false)
  assert.equal(isLocalAlbumBackgroundCandidatePage({ ...page, items: [{ ...page.items[0]!, rootId: f.views[1]!.root.id }] }, query), false)
  assert.equal(isLocalAlbumBackgroundCandidatePage({ ...page, items: new Array(1) }, query), false)
  assert.equal(isLocalAlbumBackgroundCandidatePage({ ...page, hasMore: true }, query), false)
  const signal = new AbortController(); signal.abort()
  await assert.rejects(f.owner.privateBackgroundCandidates(query, signal.signal))
})


test('完整捕获前台让步：真实runtime.inspectAlbum等待refresh时后台不发现、不领取；完成后原quiet期结束才继续', async t => {
  const f = await fixture(t, 2), time = libraryRemovalClock(t), entered = deferred(), release = deferred()
  const album = (await f.owner.queryAlbums(publicQuery(null, 0, 200))).items[0]!
  const queue = f.repository.privateLocalAlbumArtworkQueue; assert.ok(queue); queue.setMode(f.datasetId, 'paused')
  let projections = 0, held = false
  const projection: DatasetProjectionPort = { async call(command) { if (command === 'scanReadStatus') return { status: 'ready' } as never; projections++; throw new Error('本测试只验证发现让步，不读取Source。') } }
  const runtime = createLocalAlbumOwnerRuntime({ ...f.options, projection }); f.addCleanup(() => runtime.close())
  const background = runtime.background; assert.ok(background); background.start()
  const original = f.repository.localCatalog.privateAlbumBrowserBackgroundCandidates
  const candidates = t.mock.method(f.repository.localCatalog, 'privateAlbumBrowserBackgroundCandidates', (request: Parameters<typeof original>[0], scope: Parameters<typeof original>[1]) => {
    const result = original.call(f.repository.localCatalog, request, scope); queue.setMode(f.datasetId, 'paused'); return result
  })
  f.refresh(async () => { if (!held) { held = true; entered.resolve(); await release.promise } })
  const pending = runtime.localAlbums.inspectAlbum({ rootId: album.rootId, albumKey: album.id, revision: album.revision })
  try {
    await entered.promise; background.resume(); await background.runPending()
    assert.equal(candidates.mock.callCount(), 0); assert.equal(projections, 0)
    assert.deepEqual(queue.inspect(f.datasetId), { mode: 'running', pending: 0, running: 0, complete: 0 })
    release.resolve()
    const captured = await pending
    const { artworkPrepared: _prepared, ...expectedAlbum } = album
    assert.deepEqual(captured.summary, expectedAlbum); assert.equal(captured.members.length, album.trackCount)
    await background.runPending(); assert.equal(candidates.mock.callCount(), 0, '完整捕获返回后仍保原100ms前台quiet')
    time.elapse(101); await background.runPending()
    assert.equal(candidates.mock.callCount(), 1); assert.equal(projections, 0)
    assert.equal(queue.mode(f.datasetId), 'paused', '真实候选返回后暂停，不能继续领取Source任务')
  } finally { release.resolve(); await pending.catch(() => {}) }
})
