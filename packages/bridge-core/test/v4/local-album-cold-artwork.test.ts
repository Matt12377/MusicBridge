import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as dto from '@music-bridge/contracts'
import { createCollectionRepository, type CollectionRepository } from '../../src/collection/repository.js'
import { createLocalAlbumOwnerRuntime } from '../../src/collection/local-album-browser/owner-runtime.js'
import type { LocalAlbumSqlScope } from '../../src/collection/local-album-browser/sql-types.js'
import type { DatasetProjectionPort } from '../../src/collection/dataset-owner-protocol.js'
import { createScanReadAdmission } from '../../src/library/scan-read-admission.js'
import { authorizeSourceDirectory } from '../../src/recording/source-files.js'
import { readLibraryOperationLine, type LibraryOperationEvent } from '../../src/shared/library-operation-log.js'

// 真实Source许可仅来自本测试新建空目录；没有音频、NAS、Rust或图像替身。
const request = (album: dto.LocalAlbumSummary): dto.LocalAlbumArtworkRequest => ({ albumKey: album.id, rootId: album.rootId,
  editionId: album.editionId, representativeTrackId: album.representativeTrackId, revision: album.revision })
function observe(t: TestContext): LibraryOperationEvent[] {
  const events: LibraryOperationEvent[] = []
  t.mock.method(console, 'info', (...args: unknown[]) => { for (const line of args) {
    const event = typeof line === 'string' ? readLibraryOperationLine(line) : null; if (event) events.push(event)
  } })
  return events
}
const builds = (events: readonly LibraryOperationEvent[]) => events.filter(event => event.action === 'albums.compact-groups' && event.code === 'COMPACT_BUILT').length

async function fixture(t: TestContext, role?: 'container') {
  const temporary = process.env.TMPDIR
  assert.ok(temporary && path.isAbsolute(temporary))
  if (process.platform === 'darwin') assert.ok(path.resolve(temporary).startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'))
  const directory = await mkdtemp(path.join(temporary, 'cold-artwork-')), filePath = path.join(directory, 'collection.sqlite'), datasetId = randomUUID()
  const opened = new Set<{ repository: CollectionRepository; runtime: ReturnType<typeof createLocalAlbumOwnerRuntime>; gate: ReturnType<typeof createScanReadAdmission> }>()
  async function close(value: typeof opened extends Set<infer V> ? V : never) {
    if (!opened.delete(value)) return
    try { await value.runtime.close() } finally { value.gate.close(); value.repository.close() }
  }
  t.after(async () => { for (const value of [...opened]) await close(value); await rm(directory, { recursive: true, force: true }) })
  function open() {
    let admissionBusy = false
    const repository = createCollectionRepository({ filePath }), gate = createScanReadAdmission({ isBusy: () => admissionBusy, isDisplayBusy: () => false })
    const purposes: string[] = [], context = { datasetId, epoch: randomUUID() }
    const views = (): dto.LocalRootView[] => repository.localCatalog.roots().map(root => ({ root, label: '合成来源', availability: 'ONLINE' }))
    const projection: DatasetProjectionPort = { async call(command, payload) {
      // 原用例继续验证真实Acquire忙时拒绝：当次探针空闲，返回后再发生播放竞态。
      if (command === 'scanReadStatus') { admissionBusy = false; const result = gate.status(context); admissionBusy = true; return result as never }
      if (command === 'scanReadAcquire') {
        const purpose = Object.hasOwn(payload, 'purpose') ? 'local-album-display' : 'scan'; purposes.push(purpose)
        return gate.acquire(context, purpose) as never
      }
      throw new Error('播放繁忙时，冷缓存构建不能申请源FD、图像解码或其它投影命令。')
    } }
    const organizations = () => role ? views().map(({ root }) => ({ datasetId, rootId: root.id, sourceRootId: root.sourceRootId,
      rootRevision: root.revision, bindingRevision: 1, recordSha256: 'a'.repeat(64), role, rootName: '合成根', parentName: '合成来源' })) : []
    const runtime = createLocalAlbumOwnerRuntime({ repository, projection, datasetId, assertCurrent() {}, readRootViews: async () => views(), readLibraryOrganizations: organizations })
    const value = { repository, runtime, gate, views, purposes, organizations }; opened.add(value); return value
  }
  const initial = open()
  for (let library = 0; library < 2; library++) {
    const media = path.join(directory, `空来源${library}`); await mkdir(media)
    const source = initial.repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media))
    const root = initial.repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' })
    for (let album = 0; album < 3; album++) {
      const asset = initial.repository.localCatalog.registerAsset({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision,
        relative: `合成专辑${album}/01.wav`, sha256: null, sampleFrames: null, timebaseHz: null })
      const track = initial.repository.localCatalog.createTrack({ commandId: randomUUID(), assetId: asset.id, segment: null })
      initial.repository.localCatalog.observeMetadata({ commandId: randomUUID(), trackId: track.id, source: 'synthetic', parserVersion: 'cold-artwork-v1',
        fields: { title: '合成歌曲', artist: '合成艺人', album: `合成专辑${album}` } })
    }
  }
  const page = await initial.runtime.localAlbums.queryAlbums({ rootId: null, query: '', filter: 'all', offset: 0, limit: 200 })
  assert.equal(page.total, 6)
  const buckets = initial.views().map(view => page.items.filter(album => album.rootId === view.root.id).map(request))
  const requests = Array.from({ length: 3 }, (_, index) => buckets.map(bucket => bucket[index]!)).flat()
  const queue = initial.repository.privateLocalAlbumArtworkQueue; assert.ok(queue)
  queue.enqueue(datasetId, requests)
  const revision = `${initial.repository.localCatalog.privateAlbumBrowserRevision()}:${initial.repository.localScan.privateAlbumBrowserRevision()}`
  for (const view of initial.views()) {
    const cursor = queue.cursor(datasetId, view.root.id, `${view.root.sourceRootId}:${view.root.revision}`, revision)
    assert.equal(queue.advance(datasetId, view.root.id, cursor, { offset: 3, done: true }, 3, revision), true)
  }
  queue.setMode(datasetId, 'paused'); await close(initial)
  return { open, close, datasetId, requests, page, revision }
}

test('冷封面：真实持久done+pending重开保持暂停，恢复后双根交替只读各自目录，不借用前台Source豁免', async t => {
  const f = await fixture(t), events = observe(t), cold = f.open(), queue = cold.repository.privateLocalAlbumArtworkQueue!
  const publicQuery = t.mock.method(cold.repository.localCatalog, 'privateAlbumBrowserQuery', () => { throw new Error('冷恢复不能靠先打开公开页暖缓存。') })
  const candidates = t.mock.method(cold.repository.localCatalog, 'privateAlbumBrowserBackgroundCandidates', () => { throw new Error('已完成发现不能重放候选页来掩盖冷上下文缺口。') })
  const contexts = t.mock.method(cold.repository.localCatalog, 'privateAlbumBrowserArtwork')
  const background = cold.runtime.background; assert.ok(background)
  background.start(); await background.runPending()
  assert.equal(queue.mode(f.datasetId), 'paused'); assert.equal(contexts.mock.callCount(), 0); assert.equal(builds(events), 0)
  background.resume()
  for (let index = 0; index < f.requests.length; index++) await background.runPending()
  assert.equal(publicQuery.mock.callCount(), 0); assert.equal(candidates.mock.callCount(), 0)
  assert.equal(contexts.mock.callCount(), 6)
  assert.deepEqual(contexts.mock.calls.map(call => request(call.result!.album)), f.requests)
  assert.equal(builds(events), 0, '合资格冷单项从当前原成员证明目录，不应先建全集')
  const reads = events.filter(event => event.action === 'albums.artwork-context')
  assert.equal(reads.length, 6); assert.ok(reads.every(event => event.code === 'DIRECTORY_SEED' && event.state === 'miss'))
  assert.deepEqual(cold.purposes, Array(6).fill('scan'))
  assert.deepEqual(cold.gate.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: false })
  assert.equal(queue.inspect(f.datasetId).pending, 6); assert.equal(queue.inspect(f.datasetId).complete, 0)
  for (const view of cold.views()) {
    const cursor = queue.cursor(f.datasetId, view.root.id, `${view.root.sourceRootId}:${view.root.revision}`, f.revision)
    assert.equal(cursor.done, true); assert.equal(cursor.offset, 3); assert.equal(cursor.code, 'CURSOR_CONTINUE')
  }
  await background.pause(); assert.equal(queue.mode(f.datasetId), 'paused')
})

test('冷封面预算：超界全弃且保完整fallback，热根/冷根交替不重复尝试同一全集分配', async t => {
  const f = await fixture(t, 'container'), cold = f.open(), events = observe(t), prepare = DatabaseSync.prototype.prepare
  let allocations = 0
  // 受控SQL输出故障只放大派生行；真实Source、主表、公开结果及预算常量均不改。
  t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    const statement = prepare.call(this, sql), iterate = statement.iterate
    if (sql.includes('/* mb_album_compact_groups */')) t.mock.method(statement, 'iterate', function* (...args: unknown[]) {
      allocations++
      const rows = Reflect.apply(iterate, statement, args) as Iterable<Record<string, unknown>>
      for (const row of rows) yield { ...row, payload: String(row.payload) + ' '.repeat(17 * 1024 * 1024) }
    })
    return statement
  })
  const scope: LocalAlbumSqlScope = { revision: 'cold-budget-v1', roots: cold.views(), libraryOrganizations: cold.organizations() }
  for (const value of f.requests) {
    const context = cold.repository.localCatalog.privateAlbumBrowserArtwork(value, scope)
    assert.deepEqual(request(context.album), value); assert.equal(context.representative!.summary.track.id, value.representativeTrackId)
  }
  assert.equal(allocations, 1, '负资格只按同一完整结构/实际作者复用，不能每claim分配超界全集')
  assert.equal(builds(events), 0)
  assert.equal(events.filter(event => event.action === 'albums.compact-groups' && event.code === 'CAPACITY').length, 6)
  assert.ok(events.filter(event => event.action === 'albums.artwork-context').every(event => event.code === 'DERIVED_MISS'))
  t.diagnostic('超预算仍需完整目标SQL；本Gate不把该fallback宣称为大库性能修复。')
})

test('冷封面末屏障：冷构建后库存作者revision改变仍整件失效，下一次必须重新构建', async t => {
  const f = await fixture(t, 'container'), cold = f.open(), events = observe(t), prepare = DatabaseSync.prototype.prepare
  let revision = 'inventory-one', armed = true
  const inventory = { revision: () => revision, read: () => 'unknown' as const }
  const scope: LocalAlbumSqlScope = { revision: 'cold-barrier-v1', roots: cold.views(), artworkInventory: inventory, libraryOrganizations: cold.organizations() }
  t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    const statement = prepare.call(this, sql), iterate = statement.iterate
    if (sql.includes('/* mb_album_compact_groups */')) t.mock.method(statement, 'iterate', function* (...args: unknown[]) {
      yield* Reflect.apply(iterate, statement, args) as Iterable<Record<string, unknown>>
      if (armed) { armed = false; revision = 'inventory-two' }
    })
    return statement
  })
  assert.throws(() => cold.repository.localCatalog.privateAlbumBrowserArtwork(f.requests[0]!, scope), { code: 'SNAPSHOT_CHANGED' })
  assert.equal(armed, false)
  assert.ok(events.some(event => event.action === 'albums.read-cache.evict' && event.code === 'READ_BARRIER_FAILED'))
  const start = events.length
  assert.deepEqual(request(cold.repository.localCatalog.privateAlbumBrowserArtwork(f.requests[0]!, scope).album), f.requests[0])
  assert.equal(builds(events.slice(start)), 1, '末核失败不能遗留刚刚构建的Compact给后续读取')
})
