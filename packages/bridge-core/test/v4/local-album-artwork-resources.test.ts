import assert from 'node:assert/strict'
import test, { after, type TestContext } from 'node:test'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as dto from '@music-bridge/contracts'
import { createCollectionRepository } from '../../src/collection/repository.js'
import type { DatasetProjectionPort, DatasetProjectionCommandResults } from '../../src/collection/dataset-owner-protocol.js'
import { createLocalAlbumArtworkReader } from '../../src/collection/local-album-browser/artwork-read-port.js'
import { createLocalAlbumOwnerService } from '../../src/collection/local-album-browser/owner-port.js'
import { createLocalAlbumArtworkResourceStore, LocalAlbumArtworkResourceError, type LocalAlbumArtworkResourceBinding } from '../../src/collection/local-album-browser/artwork-resource-store.js'
import type { LocalAlbumDisplayCacheRecord } from '../../src/collection/local-album-browser/display-cache.js'
import { groupLocalAlbumSnapshot } from '../../src/collection/local-album-browser/grouping.js'
import type { LocalAlbumArtworkReadContext } from '../../src/collection/local-album-browser/types.js'
import { authorizeSourceDirectory, readonlySourceCandidateMetadata } from '../../src/recording/source-files.js'
import { closeRustMediaWorkerPool, getRustMediaWorkerPool } from '../../src/library/rust-media-worker.js'
import { createScanReadAdmission } from '../../src/library/scan-read-admission.js'

after(() => closeRustMediaWorkerPool())

test('持久封面资源：绑定存在但图片行丢失时，轻量状态必须拒绝冒充可用', async t => {
  const target = await directory(t), filePath = path.join(target, 'missing-content.sqlite')
  const store = createLocalAlbumArtworkResourceStore({ filePath })
  store.put(binding(), record(), () => {}); store.close()
  const damage = new DatabaseSync(filePath, { enableForeignKeyConstraints: false })
  damage.exec('DELETE FROM local_album_artwork_resources'); damage.close()
  const reopened = createLocalAlbumArtworkResourceStore({ filePath }); t.after(() => reopened.close())
  assert.throws(() => reopened.lookup(datasetId, rootId, binding().albumKey), { code: 'ARTWORK_RECORD_INVALID' })
})
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const sha = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex')
const rootId = '88888888-8888-4888-8888-000000000001', datasetId = '88888888-8888-4888-8888-000000000002'
const jpeg = readFileSync(new URL('../fixtures/mbrs012-source/owned-cover-16.jpg', import.meta.url))
function record(relative = 'album/song.wav', signature = '1:2:3:4:5'): LocalAlbumDisplayCacheRecord {
  const info = { mime: 'image/jpeg' as const, bytes: jpeg.length, sha256: sha(jpeg), width: 16, height: 16 }
  return { image: { original: info, display: { ...info, dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}` } }, grid: { ...info, dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}` },
    evidence: { independent: [{ relative: `${path.posix.dirname(relative)}/cover.jpg`.replace(/^\.\//u, ''), signature: '2:3:4:5:6', size: jpeg.length, included: true }],
      embedded: { relative, signature, size: 2048 }, unresolved: false, embeddedConfirmed: false, independentOnly: true } }
}
const binding = (albumKey = 'directory-one'): LocalAlbumArtworkResourceBinding => ({ datasetId, rootId, albumKey, authority: hash('授权'), membership: hash('成员'), editionId: null, representativeTrackId: null })
async function directory(t: TestContext) {
  const temporary = process.env.TMPDIR
  assert.ok(temporary && path.isAbsolute(temporary) && path.resolve(temporary).startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp'))
  const target = await fs.mkdtemp(path.join(temporary, 'artwork-resource-test-'))
  t.after(() => fs.rm(target, { recursive: true, force: true }))
  return target
}

test('持久封面资源：内容去重与来源证据分开，重开保留图片和网格及权限隔离', async t => {
  const target = await directory(t), filePath = path.join(target, 'resources.sqlite'), first = record(), second = record('other/song.wav', '9:8:7:6:5')
  const store = createLocalAlbumArtworkResourceStore({ filePath })
  store.put(binding(), first, () => {})
  store.put(binding('directory-two'), second, () => {})
  const revision = store.revision(); store.close()
  const inspect = new DatabaseSync(filePath, { readOnly: true })
  assert.equal(inspect.prepare('SELECT count(*) n FROM local_album_artwork_resources').get()!.n, 1)
  assert.equal(inspect.prepare('SELECT count(*) n FROM local_album_artwork_bindings').get()!.n, 2)
  assert.equal(String(inspect.prepare('SELECT metadata FROM local_album_artwork_resources').get()!.metadata).includes('evidence'), false)
  inspect.close()
  const reopened = createLocalAlbumArtworkResourceStore({ filePath }); t.after(() => reopened.close())
  assert.deepEqual(reopened.get(binding())?.record, first)
  assert.deepEqual(reopened.get(binding('directory-two'))?.record, second)
  assert.equal(reopened.revision(), revision)
  assert.equal(reopened.get({ ...binding(), datasetId: randomUUID() }), null)
  assert.equal(reopened.get({ ...binding(), rootId: randomUUID() }), null)
  assert.equal(reopened.get({ ...binding(), authority: hash('另一授权') }), null)
  assert.equal(reopened.get({ ...binding(), membership: hash('另一成员') }), null)
})

test('持久封面资源：容量、迟到seal和撤根失败必须拒绝，已有资源不因失败丢失', async t => {
  const target = await directory(t), filePath = path.join(target, 'resources.sqlite'), store = createLocalAlbumArtworkResourceStore({ filePath, maxEntries: 1 })
  const first = record(); store.put(binding(), first, () => {})
  assert.throws(() => store.put(binding('directory-two'), first, () => {}), { code: 'ARTWORK_STORE_FULL' })
  const failure = new Error('仅合成seal失效')
  assert.throws(() => store.put(binding(), first, () => { throw failure }), error => error === failure)
  assert.deepEqual(store.get(binding())?.record, first)
  store.removeRoot(rootId)
  assert.throws(() => store.put(binding(), first, () => {}), { code: 'ARTWORK_ROOT_RETIRED' })
  store.close()
  const reopened = createLocalAlbumArtworkResourceStore({ filePath, maxEntries: 1 }); t.after(() => reopened.close())
  assert.equal(reopened.lookup(datasetId, rootId, binding().albumKey), null)
  assert.throws(() => reopened.get(binding()), { code: 'ARTWORK_ROOT_RETIRED' })
})

test('持久封面资源：明确missing可保存，损坏SHA/尺寸不能落盘或冒充命中', async t => {
  const target = await directory(t), filePath = path.join(target, 'resources.sqlite'), store = createLocalAlbumArtworkResourceStore({ filePath })
  const bad = record(); bad.image.display.sha256 = '0'.repeat(64)
  assert.throws(() => store.put(binding(), bad, () => {}), { code: 'ARTWORK_RECORD_INVALID' })
  const evidence = { independent: [], embedded: null, unresolved: false, embeddedConfirmed: true, independentOnly: false }
  store.put(binding(), { image: null, evidence }, () => {})
  assert.equal(store.get(binding())?.state, 'missing')
  store.put(binding('directory-two'), record(), () => {}); store.close()
  const corrupt = new DatabaseSync(filePath)
  const bytes = Buffer.from(corrupt.prepare('SELECT jpeg FROM local_album_artwork_resources').get()!.jpeg as Uint8Array); bytes[10] = bytes[10]! ^ 1
  corrupt.prepare('UPDATE local_album_artwork_resources SET jpeg=?').run(bytes); corrupt.close()
  const reopened = createLocalAlbumArtworkResourceStore({ filePath }); t.after(() => reopened.close())
  assert.throws(() => reopened.get(binding('directory-two')), { code: 'ARTWORK_RECORD_INVALID' })
  assert.equal(reopened.get(binding())?.state, 'missing')
})

async function readerFixture(t: TestContext) {
  const target = await directory(t), media = path.join(target, 'media'), filePath = path.join(target, 'collection.sqlite')
  await fs.mkdir(media, { mode: 0o700 })
  const audio = Buffer.alloc(44 + 1764); audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8)
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(2, 22); audio.writeUInt32LE(44100, 24); audio.writeUInt32LE(176400, 28)
  audio.writeUInt16LE(4, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(1764, 40)
  await fs.writeFile(path.join(media, 'song.wav'), audio); await fs.writeFile(path.join(media, 'cover.jpg'), jpeg)
  const repository = createCollectionRepository({ filePath }), source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media))
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' })
  const asset = repository.localCatalog.registerAsset({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision, relative: 'song.wav', sha256: null, sampleFrames: null, timebaseHz: null })
  const track = repository.localCatalog.createTrack({ commandId: randomUUID(), assetId: asset.id, segment: null })
  repository.localCatalog.observeMetadata({ commandId: randomUUID(), trackId: track.id, source: 'synthetic', parserVersion: 'resource-v1', fields: { title: '自有静音', artist: '合成艺人', album: '合成专辑' } })
  const scope = { epoch: randomUUID(), datasetId: randomUUID() }, gate = createScanReadAdmission({ isBusy: () => false, isDisplayBusy: () => false })
  let acquired = 0, maximum = 0
  const purposes: unknown[] = []
  const projection: DatasetProjectionPort = { async call(command, payload) {
    let result: unknown
    if (command === 'scanReadAcquire') { purposes.push(payload); result = gate.acquire(scope, (payload as { purpose?: 'local-album-display' }).purpose ?? 'scan'); acquired++; maximum = Math.max(maximum, gate.resourceCounts().permits) }
    else if (command === 'scanReadWatchRevocation') result = await gate.watchRevocation(scope, (payload as { permitId: string }).permitId)
    else if (command === 'scanReadRelease') result = gate.release(scope, (payload as { permitId: string }).permitId)
    else throw new Error('测试不能进入额外投影。')
    return result as DatasetProjectionCommandResults[typeof command]
  } }
  const reader = createLocalAlbumArtworkReader({ repository, projection, datasetId: scope.datasetId, assertCurrent() {} })
  t.after(async () => { await reader.close(); gate.close(); repository.close() })
  const detail = repository.localCatalog.trackDetail(track.id), fact = { relative: 'song.wav', summary: { track: detail.track, asset: detail.asset, metadata: detail.metadata.effective, versionTokens: detail.versionTokens }, rawMetadata: detail.metadata.raw, hasArtwork: true, artworkRevision: null }
  const grouped = groupLocalAlbumSnapshot({ revision: hash('合成快照'), roots: [{ root, label: '合成根', availability: 'ONLINE' }], tracks: [fact], editions: [], editionLinks: [], rejected: [], cues: [], nameEnhancements: [] })
  const album = grouped.groups[0]!.summary
  const request: dto.LocalAlbumArtworkRequest = { albumKey: album.id, rootId: root.id, editionId: null, representativeTrackId: track.id, revision: album.revision }
  const context: LocalAlbumArtworkReadContext = { album, directory: '', representative: fact, artworkSourceRevision: hash('合成来源') }
  return { target, media, filePath, repository, source, root, track, scope, gate, reader, request, context, purposes, acquired: () => acquired, maximum: () => maximum }
}

test('生产Reader：冷读返回前已可靠保存，离线/重开/快照变化仍零NAS零许可读取，撤权即拒绝', { timeout: 15000 }, async t => {
  const f = await readerFixture(t), result = await f.reader.readSources({ request: f.request, context: f.context }, randomUUID(), undefined, undefined, 'display')
  assert.ok(result.image); assert.ok(result.grid); assert.equal(f.acquired(), 1, '落盘不能再申请第二轮源许可')
  assert.equal(f.reader.cachedState(f.request.albumKey, f.root.id), 'available')
  await fs.rename(f.media, f.media + '-offline')
  const failed = t.mock.method(fs, 'lstat', async () => { throw new Error('热读不应访问源文件系统') }); syncBuiltinESMExports()
  const before = f.acquired()
  try {
    const cached = f.reader.readCached({ ...f.request, revision: hash('另一次扫描进度') })
    assert.deepEqual(cached?.image, result.image); assert.deepEqual(cached?.grid, result.grid); assert.equal(f.acquired(), before); assert.equal(failed.mock.callCount(), 0)
    const second = createCollectionRepository({ filePath: f.filePath })
    const reader = createLocalAlbumArtworkReader({ repository: second, datasetId: f.scope.datasetId, assertCurrent() {} })
    try { assert.deepEqual(reader.readCached(f.request)?.image, result.image) } finally { await reader.close(); second.close() }
    f.repository.sources.revoke({ commandId: randomUUID(), id: f.source.id })
    assert.equal(f.reader.readCached(f.request), null)
    assert.equal(f.reader.cachedState(f.request.albumKey, f.root.id), null)
  } finally { failed.mock.restore(); syncBuiltinESMExports() }
  assert.deepEqual(f.gate.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: false })
})

test('生产Reader：旧显示缓存用可信精确来源key迁移，源离线也可复用且旧副库保留', { timeout: 15000 }, async t => {
  const f = await readerFixture(t), old = record('song.wav', (await readonlySourceCandidateMetadata(f.source, 'song.wav')).signature)
  old.evidence.embedded!.size = (await fs.stat(path.join(f.media, 'song.wav'))).size
  const observed = await readonlySourceCandidateMetadata(f.source, 'cover.jpg'); old.evidence = { ...old.evidence, independent: [{ relative: 'cover.jpg', signature: observed.signature, size: observed.size, included: true }] }
  const key = hash(['local-album-display-rust-grid-v3', f.scope.datasetId, f.context.artworkSourceRevision, f.root, f.source, f.request.albumKey, f.request.rootId, f.request.editionId, f.request.representativeTrackId, ''])
  const legacy = f.repository.privateLocalAlbumDisplayCache!; legacy.put(key, f.root.id, old)
  const before = await fs.readFile(f.filePath + '.album-display-cache.sqlite')
  await fs.rename(f.media, f.media + '-offline')
  const result = await f.reader.readSources({ request: f.request, context: f.context }, randomUUID(), undefined, undefined, 'display')
  assert.deepEqual(result.image, old.image); assert.equal(f.acquired(), 0)
  assert.deepEqual(f.reader.readCached(f.request)?.image, old.image)
  assert.deepEqual(await fs.readFile(f.filePath + '.album-display-cache.sqlite'), before)
})

test('生产Reader：持久写失败向上抛且FD/许可已关闭，不能返回成功或missing', { timeout: 15000 }, async t => {
  const f = await readerFixture(t), store = f.repository.privateLocalAlbumArtworkResources!
  const failure = t.mock.method(store, 'put', () => { throw new LocalAlbumArtworkResourceError('ARTWORK_STORE_FULL') })
  await assert.rejects(f.reader.readSources({ request: f.request, context: f.context }, randomUUID(), undefined, undefined, 'background'), { code: 'ARTWORK_STORE_FULL' })
  assert.equal(f.reader.readCached(f.request), null); assert.equal(f.reader.cachedState(f.request.albumKey, f.root.id), null)
  assert.deepEqual(f.gate.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: false })
  assert.deepEqual(f.purposes, [{}], '后台必须使用普通scan许可')
  failure.mock.restore()
})

test('生产Reader：明确刷新真正探源，离线失败保留旧好图，专辑分组字段改变后旧绑定miss', { timeout: 15000 }, async t => {
  const f = await readerFixture(t), result = await f.reader.readSources({ request: f.request, context: f.context }, randomUUID(), undefined, undefined, 'display')
  assert.ok(result.image)
  assert.equal(f.reader.readCached({ ...f.request, refresh: true }), null)
  await fs.rename(f.media, f.media + '-offline')
  const refreshed = await f.reader.readSources({ request: { ...f.request, refresh: true }, context: f.context }, randomUUID(), undefined, performance.now() + 10000, 'background')
  assert.equal(refreshed.copies.status, 'source-unavailable')
  assert.deepEqual(f.reader.readCached(f.request)?.image, result.image, '失败不能覆盖已经保存的好图或误记missing')
  f.repository.localCatalog.observeMetadata({ commandId: randomUUID(), trackId: f.track.id, source: 'synthetic', parserVersion: 'resource-v2', fields: { title: '自有静音', artist: '合成艺人', album: '已改变的专辑分组' } })
  assert.equal(f.reader.readCached(f.request), null)
  assert.equal(f.reader.cachedState(f.request.albumKey, f.root.id), null)
})

test('生产Reader：撤根等待在途任务收口，迟到图不能重新绑定，许可全部释放', { timeout: 15000 }, async t => {
  const f = await readerFixture(t), pool = getRustMediaWorkerPool(), processImage = pool.processImage.bind(pool)
  let entered = false, release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const blocked = t.mock.method(pool, 'processImage', async (...args: Parameters<typeof pool.processImage>) => { entered = true; await barrier; return processImage(...args) })
  const work = f.reader.readSources({ request: f.request, context: f.context }, randomUUID(), undefined, undefined, 'display')
  const settled = work.then(() => 'unexpected-success', () => 'rejected')
  try {
    for (let attempt = 0; !entered && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(entered, true)
    let removed = false
    const removal = f.reader.removeLibrary(f.root.id).then(() => { removed = true })
    await new Promise(resolve => setImmediate(resolve)); assert.equal(removed, false)
    release(); await removal
    assert.equal(await settled, 'rejected')
    assert.equal(f.reader.readCached(f.request), null)
    assert.deepEqual(f.gate.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: false })
  } finally { release(); await settled; blocked.mock.restore() }
})

test('旧缓存迁移索引：仅同根/目录/代表文件真实签名的闭集证据可复用', async t => {
  const f = await readerFixture(t), legacy = f.repository.privateLocalAlbumDisplayCache!, old = record('album/song.wav', '1:2:3:4:5')
  legacy.put(hash('旧key'), f.root.id, old)
  assert.deepEqual(legacy.findTrusted(f.root.id, { relative: 'album/song.wav', signature: '1:2:3:4:5', directory: 'album' }), old)
  assert.equal(legacy.findTrusted(f.root.id, { relative: 'album/song.wav', signature: '已改变签名', directory: 'album' }), null)
  assert.equal(legacy.findTrusted(f.root.id, { relative: 'other/song.wav', signature: '1:2:3:4:5', directory: 'other' }), null)
  assert.equal(legacy.findTrusted(randomUUID(), { relative: 'album/song.wav', signature: '1:2:3:4:5', directory: 'album' }), null)
})

test('Owner资源副库故障：专辑查询保留音乐，封面读取明确UNAVAILABLE且不误记missing', { timeout: 15000 }, async t => {
  for (const code of ['ARTWORK_STORE_UNAVAILABLE', 'ARTWORK_RECORD_INVALID'] as const) {
    const f = await readerFixture(t), store = f.repository.privateLocalAlbumArtworkResources!
    const failure = new LocalAlbumArtworkResourceError(code)
    const revision = t.mock.method(store, 'revision', () => { throw failure })
    const lookup = t.mock.method(store, 'lookup', () => { throw failure })
    const service = createLocalAlbumOwnerService({ repository: f.repository, datasetId: f.scope.datasetId, assertCurrent() {},
      async readRootViews() { return [{ root: f.root, label: '合成音乐库', availability: 'ONLINE' }] },
      readCachedArtwork: request => f.reader.readCached(request),
      savedArtworkInventory: { revision: () => f.reader.cacheRevision(), read: (albumKey, root) => f.reader.cachedState(albumKey, root) },
      async readArtwork() { throw new Error('资源库故障不能静默进入源读取或写missing。') },
    })
    try {
      const page = await service.queryAlbums({ query: '', rootId: null, filter: 'all', offset: 0, limit: 60 })
      assert.equal(page.total, 1); assert.equal(page.items.length, 1); assert.equal(page.items[0]!.artworkPrepared, false)
      const album = page.items[0]!
      await assert.rejects(service.getArtwork({ albumKey: album.id, rootId: album.rootId, editionId: album.editionId,
        representativeTrackId: album.representativeTrackId, revision: album.revision }), { code: 'UNAVAILABLE' })
      assert.equal(f.acquired(), 0)
      assert.equal(service.getCacheInfo().observationCount, 0)
    } finally { service.close(); revision.mock.restore(); lookup.mock.restore() }
  }
})

test('生产Reader：八个冷读有界排队仅两槽，排队取消不取许可，缓存读取绕过源槽', { timeout: 15000 }, async t => {
  const f = await readerFixture(t), pool = getRustMediaWorkerPool(), processImage = pool.processImage.bind(pool)
  let release!: () => void, entered = 0
  const barrier = new Promise<void>(resolve => { release = resolve })
  const blocked = t.mock.method(pool, 'processImage', async (...args: Parameters<typeof pool.processImage>) => { entered++; await barrier; return processImage(...args) })
  const work = Array.from({ length: 8 }, () => f.reader.readSources({ request: { ...f.request, refresh: true }, context: f.context }, randomUUID(), undefined, performance.now() + 10000, 'background'))
  try {
    for (let attempt = 0; entered < 2 && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(entered, 2); assert.equal(f.acquired(), 2)
    const cancelled = new AbortController(), pending = f.reader.readSources({ request: f.request, context: f.context }, randomUUID(), cancelled.signal, performance.now() + 10000, 'background')
    cancelled.abort(); assert.equal((await pending).copies.status, 'source-unavailable'); assert.equal(f.acquired(), 2)
    release()
    const results = await Promise.all(work)
    assert.ok(results.every(result => result.image && result.grid)); assert.equal(f.maximum(), 2); assert.equal(f.acquired(), 8)
    assert.ok(f.reader.readCached(f.request)?.image); assert.equal(f.acquired(), 8)
  } finally { release(); await Promise.allSettled(work); blocked.mock.restore() }
})
