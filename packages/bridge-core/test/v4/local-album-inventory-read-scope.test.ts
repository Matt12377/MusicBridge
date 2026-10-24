import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as dto from '@music-bridge/contracts'
import { createCollectionRepository } from '../../src/collection/repository.js'
import { createLocalAlbumOwnerRuntime } from '../../src/collection/local-album-browser/owner-runtime.js'
import { createLocalAlbumOwnerService } from '../../src/collection/local-album-browser/owner-port.js'
import { createLocalAlbumArtworkReader } from '../../src/collection/local-album-browser/artwork-read-port.js'
import { createDatasetOwnerReadRevocation } from '../../src/collection/dataset-owner-read-revocation.js'
import { createLocalAlbumArtworkResourceStore, type LocalAlbumArtworkResourceBinding } from '../../src/collection/local-album-browser/artwork-resource-store.js'
import type { LocalAlbumDisplayCacheRecord } from '../../src/collection/local-album-browser/display-cache.js'
import type { LocalAlbumLibraryOrganization } from '../../src/collection/local-album-browser/sql-types.js'
import { authorizeSourceDirectory } from '../../src/recording/source-files.js'

// 仅外置合成资料与真实SQLite；不运行扫描、Rust、Main图像处理，也不接用户库或NAS。
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const sha = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex')
const datasetId = '88888888-8888-4888-8888-000000000002', rootId = '88888888-8888-4888-8888-000000000001'
const jpeg = fs.readFileSync(new URL('../fixtures/mbrs012-source/owned-cover-16.jpg', import.meta.url))
const noImage = { independent: [], embedded: null, unresolved: false, embeddedConfirmed: true, independentOnly: false }
const query: dto.LocalAlbumQuery = { rootId: null, query: '', filter: 'all', offset: 0, limit: 1 }
const request = (album: dto.LocalAlbumSummary): dto.LocalAlbumArtworkRequest => ({ albumKey: album.id, rootId: album.rootId, editionId: album.editionId, representativeTrackId: album.representativeTrackId, revision: album.revision })
const binding = (albumKey = 'directory-one', libraryId = rootId): LocalAlbumArtworkResourceBinding => ({ datasetId, rootId: libraryId, albumKey, authority: hash('合成授权'), membership: hash('合成成员'), editionId: null, representativeTrackId: null })
function record(): LocalAlbumDisplayCacheRecord {
  const info = { mime: 'image/jpeg' as const, bytes: jpeg.length, sha256: sha(jpeg), width: 16, height: 16 }
  return { image: { original: info, display: { ...info, dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}` } },
    evidence: { independent: [{ relative: 'album/cover.jpg', signature: '2:3:4:5:6', size: jpeg.length, included: true }],
      embedded: { relative: 'album/song.wav', signature: '1:2:3:4:5', size: 2048 }, unresolved: false, embeddedConfirmed: false, independentOnly: true } }
}
async function directory(t: TestContext): Promise<string> {
  const temporary = process.env.TMPDIR
  assert.ok(temporary && path.isAbsolute(temporary) && path.resolve(temporary).startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp'))
  const result = await fsp.mkdtemp(path.join(temporary, 'inventory-read-scope-'))
  t.after(() => fsp.rm(result, { recursive: true, force: true }))
  return result
}
async function resourceFixture(t: TestContext) {
  const target = await directory(t), cache = path.join(target, 'cache'), filePath = path.join(cache, 'resources.sqlite')
  const store = createLocalAlbumArtworkResourceStore({ filePath })
  store.put(binding(), record(), () => {})
  store.put(binding('directory-missing'), { image: null, evidence: noImage }, () => {})
  t.after(() => store.close())
  return { target, cache, filePath, store }
}
function observeInventorySql(t: TestContext) {
  let prepares = 0, reads = 0, revisions = 0, blobs = 0
  const original = DatabaseSync.prototype.prepare
  t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    const statement = original.call(this, sql), get = statement.get
    if (sql.includes('metadata,jpeg')) blobs++
    if (sql.includes('LEFT JOIN local_album_artwork_resources')) {
      prepares++
      t.mock.method(statement, 'get', (...args: unknown[]) => { reads++; return Reflect.apply(get, statement, args) })
    } else if (sql === 'SELECT revision FROM local_album_artwork_resource_revision WHERE id=1') {
      t.mock.method(statement, 'get', (...args: unknown[]) => { revisions++; return Reflect.apply(get, statement, args) })
    }
    return statement
  })
  return () => ({ prepares, reads, revisions, blobs })
}

test('库存同步scope：多根available/missing/null每tuple一次SQL，真实revision不memo且文件检查固定前后', async t => {
  const f = await resourceFixture(t), secondRoot = randomUUID()
  f.store.put(binding('directory-other', secondRoot), record(), () => {})
  const metrics = observeInventorySql(t), lstat = t.mock.method(fs, 'lstatSync'), realpath = t.mock.method(fs, 'realpathSync')
  syncBuiltinESMExports()
  t.after(() => { lstat.mock.restore(); realpath.mock.restore(); syncBuiltinESMExports() })
  const expected = [['directory-one', rootId, 'available'], ['directory-missing', rootId, 'missing'], ['directory-unknown', rootId, null], ['directory-other', secondRoot, 'available']] as const
  f.store.withInventoryRead(() => {
    for (let attempt = 0; attempt < 8; attempt++) {
      for (const [key, library, state] of expected) assert.equal(f.store.lookup(datasetId, library, key)?.state ?? null, state)
      assert.match(f.store.revision(), /^\d+$/u)
    }
  })
  assert.deepEqual(metrics(), { prepares: 1, reads: 4, revisions: 10, blobs: 0 })
  assert.equal(lstat.mock.callCount(), 10, '每端目录与DB/journal/WAL/SHM各一次，不能随专辑数增长')
  assert.equal(realpath.mock.callCount(), 2)
})

test('库存同步scope：异常、Promise、thenable和捕获过的嵌套拒绝均清理memo，null不跨操作', async t => {
  const { store } = await resourceFixture(t), failure = new Error('合成回调故障')
  assert.throws(() => store.withInventoryRead(() => { store.lookup(datasetId, rootId, 'new-album'); throw failure }), error => error === failure)
  assert.throws(() => store.withInventoryRead(() => Promise.resolve('迟到值')), { code: 'ARTWORK_INVENTORY_CHANGED' })
  assert.throws(() => store.withInventoryRead(() => ({ then() {} })), { code: 'ARTWORK_INVENTORY_CHANGED' })
  assert.throws(() => store.withInventoryRead(() => { assert.throws(() => store.withInventoryRead(() => 1)); return 2 }), { code: 'ARTWORK_INVENTORY_CHANGED' })
  assert.equal(store.withInventoryRead(() => store.lookup(datasetId, rootId, 'new-album')), null)
  store.put(binding('new-album'), record(), () => {})
  assert.equal(store.withInventoryRead(() => store.lookup(datasetId, rootId, 'new-album'))?.state, 'available')
  const changed = store.withInventoryRead(() => { const entry = store.lookup(datasetId, rootId, 'new-album')!; entry.binding.authority = hash('调用方修改'); return store.lookup(datasetId, rootId, 'new-album')! })
  assert.equal(changed.binding.authority, binding().authority, '调用方不能修改operation保留的绑定')
})

test('库存同步scope：最后lookup后同连接提交revision仍弃整件', async t => {
  const { store } = await resourceFixture(t)
  assert.throws(() => store.withInventoryRead(() => { const result = store.lookup(datasetId, rootId, 'directory-one'); store.put(binding(), record(), () => {}); return result }), { code: 'ARTWORK_INVENTORY_CHANGED' })
  assert.equal(store.withInventoryRead(() => store.lookup(datasetId, rootId, 'directory-one'))?.state, 'available')
})

test('库存同步scope：removeRoot内存先撤销，墓碑事务失败也不能复用刚命中的结果', async t => {
  const { store } = await resourceFixture(t), exec = DatabaseSync.prototype.exec
  const blocked = t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
    if (sql === 'BEGIN IMMEDIATE') throw new Error('合成墓碑提交前故障')
    return exec.call(this, sql)
  })
  assert.throws(() => store.withInventoryRead(() => { const entry = store.lookup(datasetId, rootId, 'directory-one'); assert.throws(() => store.removeRoot(rootId), /合成墓碑/u); return entry }), { code: 'ARTWORK_INVENTORY_CHANGED' })
  blocked.mock.restore()
  assert.equal(store.lookup(datasetId, rootId, 'directory-one'), null)
})

for (const kind of ['external-sqlite', 'file-replace', 'parent-replace', 'symlink', 'hardlink', 'permissions', 'journal-symlink'] as const) {
  test(`库存同步scope：最后lookup后${kind}真实变化不能发布旧结果`, async t => {
    const f = await resourceFixture(t)
    assert.throws(() => f.store.withInventoryRead(() => {
      const result = f.store.lookup(datasetId, rootId, 'directory-one')
      if (kind === 'external-sqlite') {
        const external = new DatabaseSync(f.filePath)
        try { external.exec('UPDATE local_album_artwork_resource_revision SET revision=revision+1') } finally { external.close() }
      } else if (kind === 'file-replace') {
        const copy = path.join(f.target, 'replacement.sqlite'); fs.copyFileSync(f.filePath, copy); fs.renameSync(copy, f.filePath)
      } else if (kind === 'parent-replace') {
        const previous = f.cache + '-old'; fs.renameSync(f.cache, previous); fs.mkdirSync(f.cache, { mode: 0o700 }); fs.copyFileSync(path.join(previous, 'resources.sqlite'), f.filePath)
      } else if (kind === 'symlink') {
        const original = path.join(f.target, 'original.sqlite'); fs.renameSync(f.filePath, original); fs.symlinkSync(original, f.filePath)
      } else if (kind === 'hardlink') fs.linkSync(f.filePath, path.join(f.target, 'hardlink.sqlite'))
      else if (kind === 'permissions') fs.chmodSync(f.filePath, 0o644)
      else { const target = path.join(f.target, 'journal-target'); fs.writeFileSync(target, '合成日志', { mode: 0o600 }); fs.symlinkSync(target, f.filePath + '-journal') }
      return result
    }), { code: 'ARTWORK_INVENTORY_CHANGED' })
  })
}

test('库存同步scope：dangling content_hash仍拒绝，轻量JOIN不读取图片正文', async t => {
  const f = await resourceFixture(t); f.store.close()
  const damage = new DatabaseSync(f.filePath, { enableForeignKeyConstraints: false })
  damage.exec('DELETE FROM local_album_artwork_resources'); damage.close()
  const reopened = createLocalAlbumArtworkResourceStore({ filePath: f.filePath }); t.after(() => reopened.close())
  assert.throws(() => reopened.withInventoryRead(() => reopened.lookup(datasetId, rootId, 'directory-one')), { code: 'ARTWORK_RECORD_INVALID' })
})

async function readerFixture(t: TestContext, physical = false) {
  const target = await directory(t), filePath = physical ? path.join(target, 'collection.sqlite') : ':memory:'
  const repository = createCollectionRepository({ filePath }), currentDataset = randomUUID()
  const views: dto.LocalRootView[] = [], organizations: LocalAlbumLibraryOrganization[] = []
  for (let library = 0; library < 2; library++) {
    const media = path.join(target, `media-${library}`); await fsp.mkdir(media)
    const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media))
    const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' })
    views.push({ root, label: `合成根${library}`, availability: 'ONLINE' })
    for (let album = 0; album < 3; album++) {
      const asset = repository.localCatalog.registerAsset({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision, relative: `album-${album}/song.wav`, sha256: null, sampleFrames: null, timebaseHz: null })
      const track = repository.localCatalog.createTrack({ commandId: randomUUID(), assetId: asset.id, segment: null })
      repository.localCatalog.observeMetadata({ commandId: randomUUID(), trackId: track.id, source: 'synthetic', parserVersion: 'inventory-scope-v1', fields: { title: `合成曲目${album}`, artist: '合成作者', album: `合成专辑${album}` } })
    }
  }
  let organizationReads = 0
  const options = { repository, datasetId: currentDataset, assertCurrent() {}, async readRootViews() { return views },
    readLibraryOrganizations() { organizationReads++; return organizations } }
  const runtime = createLocalAlbumOwnerRuntime(options), reader = runtime.artwork
  t.after(async () => { await runtime.close(); repository.close() })
  const initial = await runtime.localAlbums.queryAlbums({ ...query, limit: 200 })
  assert.equal(initial.total, 6)
  const bindings = new Map<string, LocalAlbumArtworkResourceBinding>(), states = new Map<string, 'available' | 'missing' | null>()
  for (const [index, album] of initial.items.entries()) {
    const root = repository.localCatalog.root(album.rootId), capability = repository.sources.root(root.sourceRootId)
    const detail = repository.localCatalog.trackDetail(album.representativeTrackId!), locator = repository.localCatalog.privateAssetLocator(detail.asset.id)
    const versions = [...new Set(detail.versionTokens.filter(token => token.source === 'album' && (token.kind === 'edition' || token.kind === 'format')).map(token => token.raw))].sort()
    const item: LocalAlbumArtworkResourceBinding = { datasetId: currentDataset, rootId: root.id, albumKey: album.id, editionId: null, representativeTrackId: album.representativeTrackId,
      authority: hash(['local-album-resource-authority-v1', root.id, root.sourceRootId, root.revision, capability.id, capability.path, capability.dev, capability.ino, null]),
      membership: hash(['album-membership-v1', detail.track.id, detail.track.assetId, locator.relative, detail.asset.locationRevision, null, detail.metadata.raw.album?.trim() ?? '', versions]) }
    bindings.set(album.id, item)
    const state = index % 3 === 0 ? 'available' : index % 3 === 1 ? 'missing' : null
    states.set(album.id, state)
    if (state) repository.privateLocalAlbumArtworkResources!.put(item, state === 'available' ? record() : { image: null, evidence: noImage }, () => {})
  }
  return { target, filePath, repository, options, runtime, reader, views, organizations, initial, bindings, states, organizationReads: () => organizationReads }
}

test('Reader库存scope：多组缺绑定亦memo null，组织只读前后两次，membership每tuple一次且零BLOB零NAS', async t => {
  const f = await readerFixture(t), metrics = observeInventorySql(t), before = f.organizationReads()
  const details = t.mock.method(f.repository.localCatalog, 'trackDetail'), sources = t.mock.method(f.repository.sources, 'root')
  const blob = t.mock.method(f.repository.privateLocalAlbumArtworkResources!, 'get', () => { throw new Error('库存不能读BLOB') })
  const sourceFs = t.mock.method(fsp, 'lstat', async () => { throw new Error('库存不能访问NAS或媒体源') }); syncBuiltinESMExports()
  t.after(() => { sourceFs.mock.restore(); syncBuiltinESMExports() })
  f.reader.withInventoryRead(() => {
    for (let repeat = 0; repeat < 5; repeat++) for (const album of f.initial.items) {
      assert.equal(f.reader.cachedState(album.id, album.rootId), f.states.get(album.id))
      assert.equal(f.reader.persistedState(request(album)), f.states.get(album.id))
    }
  })
  assert.equal(metrics().reads, 6); assert.equal(metrics().prepares, 1); assert.equal(metrics().blobs, 0)
  assert.equal(f.organizationReads() - before, 2)
  assert.equal(sources.mock.callCount(), 4, '每根只在起始与末端重新读取Source能力')
  assert.equal(details.mock.callCount(), 6)
  assert.equal(blob.mock.callCount(), 0); assert.equal(sourceFs.mock.callCount(), 0)
})

test('Owner库存scope：完整counts不受可见页限制，与原非scope路径一致，离线持久available继续有效', async t => {
  const f = await readerFixture(t)
  const old = createLocalAlbumOwnerService({ ...f.options, readArtwork: async () => ({ image: null, status: 'source-unavailable' as const }),
    readPreparedArtwork: value => f.reader.persistedState(value) === 'available',
    savedArtworkInventory: { revision: () => f.reader.cacheRevision(), read: (key, library) => f.reader.cachedState(key, library) } })
  t.after(() => old.close())
  for (const filter of ['all', 'has-artwork', 'missing-artwork'] as const) {
    const expected = await old.queryAlbums({ ...query, filter }), actual = await f.runtime.localAlbums.queryAlbums({ ...query, filter })
    assert.deepEqual(actual, expected); assert.equal(actual.items.length, 1)
    assert.equal(actual.counts.all, 6); assert.equal(actual.counts['has-artwork'], 2); assert.equal(actual.counts['missing-artwork'], 2)
    assert.equal(actual.items[0]!.artworkPrepared, f.states.get(actual.items[0]!.id) === 'available')
  }
  for (const view of f.views) view.availability = 'SOURCE_ROOT_OFFLINE'
  const offline = await f.runtime.localAlbums.queryAlbums({ ...query, filter: 'has-artwork', limit: 200 })
  assert.equal(offline.total, 2); assert.ok(offline.items.every(item => item.artworkState === 'available' && item.artworkPrepared === true))
})

test('Reader库存scope：最后命中后真实撤权或组织改变，末端核验弃整件', async t => {
  const f = await readerFixture(t), album = f.initial.items.find(item => f.states.get(item.id) === 'available')!
  assert.throws(() => f.reader.withInventoryRead(() => {
    const result = f.reader.cachedState(album.id, album.rootId), root = f.repository.localCatalog.root(album.rootId)
    f.organizations.push({ datasetId: f.options.datasetId, rootId: root.id, sourceRootId: root.sourceRootId, rootRevision: root.revision, bindingRevision: 1, recordSha256: hash('变化的组织'), role: 'catalog', rootName: '合成根', parentName: '' })
    return result
  }), { code: 'SNAPSHOT_CHANGED' })
  f.organizations.length = 0
  assert.throws(() => f.reader.withInventoryRead(() => {
    const result = f.reader.cachedState(album.id, album.rootId), root = f.repository.localCatalog.root(album.rootId)
    f.repository.sources.revoke({ commandId: randomUUID(), id: root.sourceRootId }); return result
  }), { code: 'SNAPSHOT_CHANGED' })
  assert.equal(f.reader.withInventoryRead(() => f.reader.cachedState(album.id, album.rootId)), null)
})

test('Reader库存scope：removeLibrary的内存封锁早于await和资源墓碑，不能发布旧命中', async t => {
  const f = await readerFixture(t), album = f.initial.items.find(item => f.states.get(item.id) === 'available')!
  const store = f.repository.privateLocalAlbumArtworkResources!, before = store.revision(); let removal: Promise<void> | undefined
  assert.throws(() => f.reader.withInventoryRead(() => {
    const result = f.reader.cachedState(album.id, album.rootId)
    removal = f.reader.removeLibrary(album.rootId)
    assert.equal(store.revision(), before, '此时尚未跨过原removeLibrary的await，不能仅依赖墓碑revision')
    return result
  }), { code: 'SNAPSHOT_CHANGED' })
  assert.ok(removal); await removal
  assert.equal(f.reader.withInventoryRead(() => f.reader.cachedState(album.id, album.rootId)), null)
})

test('Reader库存scope：异常及thenable清理后再读，null不跨操作，同revision不同dataset作者隔离', async t => {
  const f = await readerFixture(t), unknown = f.initial.items.find(item => f.states.get(item.id) === null)!, failure = new Error('合成Reader异常')
  assert.throws(() => f.reader.withInventoryRead(() => { f.reader.cachedState(unknown.id, unknown.rootId); throw failure }), error => error === failure)
  assert.throws(() => f.reader.withInventoryRead(() => Promise.resolve(1)), { code: 'SNAPSHOT_CHANGED' })
  assert.throws(() => f.reader.withInventoryRead(() => ({ then() {} })), { code: 'SNAPSHOT_CHANGED' })
  f.repository.privateLocalAlbumArtworkResources!.put(f.bindings.get(unknown.id)!, record(), () => {})
  assert.equal(f.reader.withInventoryRead(() => f.reader.cachedState(unknown.id, unknown.rootId)), 'available')
  const other = createLocalAlbumArtworkReader({ ...f.options, datasetId: randomUUID() }); t.after(() => other.close())
  assert.equal(other.cacheRevision(), f.reader.cacheRevision())
  assert.equal(other.withInventoryRead(() => other.cachedState(unknown.id, unknown.rootId)), null)
  assert.equal(f.reader.withInventoryRead(() => f.reader.cachedState(unknown.id, unknown.rootId)), 'available')
})

test('Owner库存scope：SQL结束后的最后真实inspect拒绝不能被savedInventory逐项fallback吞掉', async t => {
  const f = await readerFixture(t, true), resourcePath = f.filePath + '.album-artwork-resources.sqlite'
  const persisted = f.reader.persistedState.bind(f.reader); let mutate = true
  t.mock.method(f.reader, 'persistedState', (value: dto.LocalAlbumArtworkRequest) => {
    const result = persisted(value)
    if (mutate) { mutate = false; fs.chmodSync(resourcePath, 0o644) }
    return result
  })
  await assert.rejects(f.runtime.localAlbums.queryAlbums(query), { code: 'SNAPSHOT_CHANGED' })
  assert.equal(mutate, false, '必须在SQL原末屏障后、Owner prepared映射内真实改变文件权限')
  fs.chmodSync(resourcePath, 0o600)
  assert.equal((await f.runtime.localAlbums.queryAlbums(query)).total, 6, '失败scope不能残留旧null或上下文')
})


test('Owner库存scope：开始前资源已不可用时保留音乐与unknown，恢复后重新读取资源', async t => {
  const f = await readerFixture(t, true), resourcePath = f.filePath + '.album-artwork-resources.sqlite'
  fs.chmodSync(resourcePath, 0o644)
  const page = await f.runtime.localAlbums.queryAlbums({ ...query, limit: 200 })
  assert.equal(page.total, 6); assert.equal(page.counts['has-artwork'], 0); assert.equal(page.counts['missing-artwork'], 0)
  assert.ok(page.items.every(item => item.artworkPrepared === false && item.artworkState === 'unknown'))
  fs.chmodSync(resourcePath, 0o600)
  assert.equal((await f.runtime.localAlbums.queryAlbums(query)).counts['has-artwork'], 2)
})

test('Reader库存scope：管理可用性在最后一次命中后撤销，末端不复用authority memo', async t => {
  const f = await readerFixture(t), album = f.initial.items.find(item => f.states.get(item.id) === 'available')!
  let available = true
  t.mock.method(f.repository.localCatalog, 'privateLibraryManagementRootAvailable', () => available)
  assert.throws(() => f.reader.withInventoryRead(() => {
    const result = f.reader.cachedState(album.id, album.rootId); available = false; return result
  }), { code: 'SNAPSHOT_CHANGED' })
  assert.equal(f.reader.withInventoryRead(() => f.reader.cachedState(album.id, album.rootId)), null)
})


test('库存同步scope：起始unavailable固定到操作结束，中途恢复权限仍沿同一错误，下操作实读恢复', async t => {
  const { store, filePath } = await resourceFixture(t)
  fs.chmodSync(filePath, 0o644)
  store.withInventoryRead(() => {
    let initial: unknown
    try { store.revision() } catch (error) { initial = error }
    assert.ok(initial && typeof initial === 'object' && 'code' in initial && initial.code === 'ARTWORK_STORE_UNAVAILABLE')
    fs.chmodSync(filePath, 0o600)
    assert.throws(() => store.lookup(datasetId, rootId, 'directory-one'), error => error === initial)
    assert.throws(() => store.revision(), error => error === initial)
  })
  assert.equal(store.withInventoryRead(() => store.lookup(datasetId, rootId, 'directory-one'))?.state, 'available')
})

/** 使用原scope夹具；guard模拟真实DatasetIdentity首末stat，不给读取Source或图片的许可。 */
function guardedInventoryReader(t: TestContext, f: Awaited<ReturnType<typeof readerFixture>>, assertReadActive?: () => void) {
  let checks = 0
  const expected = f.filePath === ':memory:' ? null : fs.lstatSync(f.filePath, { bigint: true })
  const identityFailure = new Error('合成原工作库文件身份已改变')
  const options = { ...f.options, ...(assertReadActive ? { assertReadActive } : {}), assertCurrent() {
    checks++
    if (!expected) return
    try {
      const actual = fs.lstatSync(f.filePath, { bigint: true })
      if (!actual.isFile() || actual.isSymbolicLink() || actual.nlink !== 1n || fs.realpathSync(f.filePath) !== f.filePath
        || actual.dev !== expected.dev || actual.ino !== expected.ino || actual.birthtimeNs !== expected.birthtimeNs) throw identityFailure
    } catch { throw identityFailure }
  } }
  const reader = createLocalAlbumArtworkReader(options)
  t.after(() => reader.close())
  return { reader, options, identityFailure, checks: () => checks }
}

test('Reader身份scope：稳定SAB作者仅按操作/根实核文件，组数与重复命中不放大guard，Source仍逐根首末实读', async t => {
  const f = await readerFixture(t, true), revocation = createDatasetOwnerReadRevocation()
  const g = guardedInventoryReader(t, f, revocation.assertActive), sources = t.mock.method(f.repository.sources, 'root')
  const blob = t.mock.method(f.repository.privateLocalAlbumArtworkResources!, 'get', () => { throw new Error('库存不能读取图片正文') })
  const costs: number[] = []
  for (const repeats of [1, 40]) {
    const before = g.checks()
    g.reader.withInventoryRead(() => {
      for (let repeat = 0; repeat < repeats; repeat++) for (const album of f.initial.items) {
        assert.equal(g.reader.cachedState(album.id, album.rootId), f.states.get(album.id))
        assert.equal(g.reader.persistedState(request(album)), f.states.get(album.id))
      }
    })
    costs.push(g.checks() - before)
  }
  assert.ok(costs[0]! >= 2, '每操作至少首末真实身份核验')
  assert.equal(costs[0], costs[1], '完整guard不得按G或memo命中次数增长')
  assert.ok(costs.every(count => count <= 2 + 2 * f.views.length), '允许每根原readAuthority首末check，不能退回逐组文件核验')
  assert.equal(sources.mock.callCount(), 4 * f.views.length, '两操作均独立实读每根Source首末；不能跨操作复用许可')
  assert.equal(blob.mock.callCount(), 0)
})

test('Reader身份scope：未安装稳定撤销callback的旧作者保持原逐次完整核验', async t => {
  const f = await readerFixture(t), g = guardedInventoryReader(t, f), album = f.initial.items[0]!
  const before = g.checks()
  g.reader.withInventoryRead(() => { for (let repeat = 0; repeat < 40; repeat++) g.reader.cachedState(album.id, album.rootId) })
  assert.ok(g.checks() - before > 40, '无SAB资格不得借同步scope省略原生命周期/身份guard')
})

for (const stage of ['last-lookup', 'resource-final-inspect', 'main-final-point'] as const) test(`Reader身份scope：${stage}之后真实主库换物仍拒整件，恢复后的下操作重新实核`, async t => {
  const f = await readerFixture(t, true), revocation = createDatasetOwnerReadRevocation(), g = guardedInventoryReader(t, f, revocation.assertActive)
  const album = f.initial.items.find(item => f.states.get(item.id) === 'available')!, held = f.filePath + '.held'
  let swapped = false, restoreHook = () => {}
  const replace = () => {
    if (swapped) return
    fs.renameSync(f.filePath, held); swapped = true
    fs.writeFileSync(f.filePath, '合成替换物，不是原SQLite文件', { mode: 0o600 })
  }
  if (stage === 'resource-final-inspect') {
    const store = f.repository.privateLocalAlbumArtworkResources!, original = store.withInventoryRead.bind(store)
    const hook = t.mock.method(store, 'withInventoryRead', function <T>(read: () => T): T { const result = original(read); replace(); return result })
    restoreHook = () => hook.mock.restore()
  } else if (stage === 'main-final-point') {
    const catalog = f.repository.localCatalog, original = catalog.privateRead.bind(catalog); let frames = 0
    const hook = t.mock.method(catalog, 'privateRead', function <T>(read: (db: DatabaseSync) => T): T {
      const result = original(read)
      if (++frames === 2) replace()
      return result
    })
    restoreHook = () => hook.mock.restore()
  }
  try {
    assert.throws(() => g.reader.withInventoryRead(() => {
      const result = g.reader.cachedState(album.id, album.rootId)
      assert.equal(result, 'available')
      if (stage === 'last-lookup') replace()
      return result
    }), error => error === g.identityFailure)
    assert.equal(swapped, true, '必须真的在指定末核边界替换主库物理路径')
  } finally {
    restoreHook()
    if (swapped) { fs.unlinkSync(f.filePath); fs.renameSync(held, f.filePath) }
  }
  const before = g.checks()
  assert.equal(g.reader.withInventoryRead(() => g.reader.cachedState(album.id, album.rootId)), 'available')
  assert.ok(g.checks() - before >= 2, '失败scope清除，下一操作仍首末真实重核')
})

test('Reader身份scope：命中memo后单向SAB撤销立即拒绝，同操作不得降级成unknown，新代独立闩可读', async t => {
  const f = await readerFixture(t), revocation = createDatasetOwnerReadRevocation(), g = guardedInventoryReader(t, f, revocation.assertActive)
  const album = f.initial.items.find(item => f.states.get(item.id) === 'available')!
  assert.throws(() => g.reader.withInventoryRead(() => {
    const result = g.reader.cachedState(album.id, album.rootId); assert.equal(result, 'available')
    revocation.revoke()
    assert.throws(() => g.reader.cachedState(album.id, album.rootId), { code: 'UNAVAILABLE' })
    return result
  }), { code: 'UNAVAILABLE' })
  assert.throws(() => g.reader.withInventoryRead(() => g.reader.cachedState(album.id, album.rootId)), { code: 'UNAVAILABLE' })
  const next = guardedInventoryReader(t, f, createDatasetOwnerReadRevocation().assertActive)
  assert.equal(next.reader.withInventoryRead(() => next.reader.cachedState(album.id, album.rootId)), 'available')
})

test('Reader身份scope：资源真实末inspect之后才到达的SAB撤销仍拒发布', async t => {
  const f = await readerFixture(t), revocation = createDatasetOwnerReadRevocation(), g = guardedInventoryReader(t, f, revocation.assertActive)
  const store = f.repository.privateLocalAlbumArtworkResources!, original = store.withInventoryRead.bind(store), album = f.initial.items[0]!
  let finished = false
  t.mock.method(store, 'withInventoryRead', function <T>(read: () => T): T { const result = original(read); finished = true; revocation.revoke(); return result })
  assert.throws(() => g.reader.withInventoryRead(() => g.reader.cachedState(album.id, album.rootId)), { code: 'UNAVAILABLE' })
  assert.equal(finished, true, '撤销必须发生在资源scope前后实核全部完成之后')
})

for (const author of ['current', 'active'] as const) test(`Reader身份scope：同步操作中替换${author} callback作者必须拒绝，不能继承原memo`, async t => {
  const f = await readerFixture(t), revocation = createDatasetOwnerReadRevocation(), g = guardedInventoryReader(t, f, revocation.assertActive)
  const album = f.initial.items[0]!, current = g.options.assertCurrent, active = g.options.assertReadActive!
  assert.throws(() => g.reader.withInventoryRead(() => {
    const result = g.reader.cachedState(album.id, album.rootId)
    if (author === 'current') g.options.assertCurrent = () => {}
    else g.options.assertReadActive = () => {}
    assert.throws(() => g.reader.cachedState(album.id, album.rootId), { code: 'SNAPSHOT_CHANGED' })
    return result
  }), { code: 'SNAPSHOT_CHANGED' })
  g.options.assertCurrent = current; g.options.assertReadActive = active
  assert.equal(g.reader.withInventoryRead(() => g.reader.cachedState(album.id, album.rootId)), f.states.get(album.id))
})

test('Reader身份scope：fast路径仍拒Promise/thenable/捕获的nested，异常或null不跨操作保留', async t => {
  const f = await readerFixture(t), revocation = createDatasetOwnerReadRevocation(), g = guardedInventoryReader(t, f, revocation.assertActive)
  const album = f.initial.items.find(item => f.states.get(item.id) === null)!, failure = new Error('合成纯库存回调故障')
  assert.throws(() => g.reader.withInventoryRead(() => { g.reader.cachedState(album.id, album.rootId); throw failure }), error => error === failure)
  assert.throws(() => g.reader.withInventoryRead(() => Promise.resolve(1)), { code: 'SNAPSHOT_CHANGED' })
  assert.throws(() => g.reader.withInventoryRead(() => ({ then() {} })), { code: 'SNAPSHOT_CHANGED' })
  assert.throws(() => g.reader.withInventoryRead(() => {
    g.reader.cachedState(album.id, album.rootId)
    assert.throws(() => g.reader.withInventoryRead(() => 1), { code: 'SNAPSHOT_CHANGED' })
    return '捕获内部错误也不得发布'
  }), { code: 'SNAPSHOT_CHANGED' })
  f.repository.privateLocalAlbumArtworkResources!.put(f.bindings.get(album.id)!, record(), () => {})
  assert.equal(g.reader.withInventoryRead(() => g.reader.cachedState(album.id, album.rootId)), 'available')
})

for (const stop of ['close', 'retire'] as const) test(`Reader身份scope：fast命中后${stop}在await前封锁原结果，不能被guard去重掩盖`, async t => {
  const f = await readerFixture(t), revocation = createDatasetOwnerReadRevocation(), g = guardedInventoryReader(t, f, revocation.assertActive)
  const album = f.initial.items.find(item => f.states.get(item.id) === 'available')!, before = f.repository.privateLocalAlbumArtworkResources!.revision()
  let stopping: Promise<void> | undefined
  assert.throws(() => g.reader.withInventoryRead(() => {
    const result = g.reader.cachedState(album.id, album.rootId); assert.equal(result, 'available')
    stopping = stop === 'close' ? g.reader.close() : g.reader.removeLibrary(album.rootId)
    assert.equal(f.repository.privateLocalAlbumArtworkResources!.revision(), before, '内存封锁必须早于资源墓碑提交')
    return result
  }), stop === 'close' ? /专辑封面读取已停止/u : { code: 'SNAPSHOT_CHANGED' })
  assert.ok(stopping); await stopping
  if (stop === 'close') assert.throws(() => g.reader.withInventoryRead(() => null), /专辑封面读取已停止/u)
  else assert.equal(g.reader.withInventoryRead(() => g.reader.cachedState(album.id, album.rootId)), null)
})

test('Reader身份scope：显式事务仍走原完整guard，不在已受理原子写中插入SAB取消；提交后普通scope拒绝', async t => {
  const f = await readerFixture(t), revocation = createDatasetOwnerReadRevocation(), g = guardedInventoryReader(t, f, revocation.assertActive)
  const album = f.initial.items.find(item => f.states.get(item.id) === 'available')!
  f.repository.localCatalog.privateRead(db => {
    db.exec('CREATE TEMP TABLE inventory_scope_txn_gate(marker INTEGER PRIMARY KEY)')
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec('INSERT INTO inventory_scope_txn_gate VALUES(1)'); revocation.revoke()
      assert.equal(g.reader.withInventoryRead(() => g.reader.cachedState(album.id, album.rootId)), 'available')
      db.exec('INSERT INTO inventory_scope_txn_gate VALUES(2)'); db.exec('COMMIT')
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error }
    assert.equal(db.prepare('SELECT count(*) n FROM inventory_scope_txn_gate').get()!.n, 2)
  })
  assert.throws(() => g.reader.withInventoryRead(() => g.reader.cachedState(album.id, album.rootId)), { code: 'UNAVAILABLE' })
})
