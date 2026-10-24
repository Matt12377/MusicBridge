import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import * as dto from '@music-bridge/contracts'
import { createCollectionRepository } from '../../src/collection/repository.js'
import { createLocalAlbumArtworkReader } from '../../src/collection/local-album-browser/artwork-read-port.js'
import { createLocalAlbumOwnerService } from '../../src/collection/local-album-browser/owner-port.js'
import { createLocalAlbumArtworkQueue } from '../../src/collection/local-album-browser/artwork-background-queue.js'
import { authorizeSourceDirectory } from '../../src/recording/source-files.js'
import { readLibraryOperationLine } from '../../src/shared/library-operation-log.js'

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const bytes = readFileSync(new URL('../fixtures/mbrs012-source/owned-cover-16.jpg', import.meta.url))
const info = { mime: 'image/jpeg' as const, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), width: 16, height: 16 }
const image: dto.LocalArtworkImage = { original: info, display: { ...info, dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}` } }

async function fixture(t: TestContext) {
  const temporary = process.env.TMPDIR
  assert.ok(temporary && path.isAbsolute(temporary) && path.resolve(temporary).startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'))
  const directory = await fs.mkdtemp(path.join(temporary, 'selected-artwork-')), media = path.join(directory, 'media'), filePath = path.join(directory, 'collection.sqlite')
  await fs.mkdir(media, { mode: 0o700 })
  const repository = createCollectionRepository({ filePath }), datasetId = randomUUID()
  const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media))
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' })
  const asset = repository.localCatalog.registerAsset({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision,
    relative: 'never-read.flac', sha256: null, sampleFrames: null, timebaseHz: null })
  const track = repository.localCatalog.createTrack({ commandId: randomUUID(), assetId: asset.id, segment: null })
  repository.localCatalog.observeMetadata({ commandId: randomUUID(), trackId: track.id, source: 'synthetic', parserVersion: 'manual-cache-v1', fields: { title: '合成曲目', album: '合成手选专辑' } })
  const edition = repository.localCatalog.createEdition({ commandId: randomUUID(), title: '合成手选专辑', edition: '' })
  repository.localCatalog.linkEditionTrack({ commandId: randomUUID(), editionId: edition.id, trackId: track.id, disc: 1, trackNumber: 1, sequence: 1 })
  const target = repository.localArtwork.context({ trackId: track.id, editionId: edition.id }).target!
  const candidate = repository.localArtwork.stage({ target, origin: 'manual', sourceIdentity: hash('自有合成图片'), sourceLabel: '自有合成图片', image }).candidates[0]!
  const selection = repository.localArtwork.apply({ commandId: randomUUID(), target, candidateId: candidate.id, expectedSelectionRevision: null })
  const reader = createLocalAlbumArtworkReader({ repository, datasetId, assertCurrent() {} })
  t.after(async () => { await reader.close(); repository.close(); await fs.rm(directory, { recursive: true, force: true }) })
  const request: dto.LocalAlbumArtworkRequest = { albumKey: `edition-${hash([root.id, edition.id])}`, rootId: root.id,
    editionId: edition.id, representativeTrackId: track.id, revision: hash('合成快照') }
  return { directory, media, filePath, repository, datasetId, source, root, asset, track, edition, selection, reader, request }
}

test('持久手选封面：无派生绑定仍可离线冷读，主库副本和源事实保持不变', async t => {
  const f = await fixture(t), store = f.repository.privateLocalAlbumArtworkResources!
  assert.equal(store.lookup(f.datasetId, f.root.id, f.request.albumKey), null)
  const before = f.repository.readonlySnapshotStamp(), detail = f.repository.localCatalog.trackDetail(f.track.id)
  await fs.rename(f.media, f.media + '-offline')
  const sourceRead = t.mock.method(fs, 'lstat', async () => { throw new Error('持久手选读取不能访问源目录。') }); syncBuiltinESMExports()
  try {
    assert.deepEqual(f.reader.readCached(f.request), { image, status: 'ready' })
    assert.equal(f.reader.persistedState(f.request), 'available')
    const reopened = createCollectionRepository({ filePath: f.filePath })
    const cold = createLocalAlbumArtworkReader({ repository: reopened, datasetId: f.datasetId, assertCurrent() {} })
    try {
      assert.deepEqual(cold.readCached({ ...f.request, revision: hash('冷开新快照'), variant: 'grid' }), { image, status: 'ready' })
      assert.equal(cold.persistedState(f.request), 'available')
      assert.equal(reopened.privateLocalAlbumArtworkResources!.lookup(f.datasetId, f.root.id, f.request.albumKey), null, '手选副本不能伪造NAS派生绑定或来源证据。')
    } finally { await cold.close(); reopened.close() }
    assert.equal(sourceRead.mock.callCount(), 0)
    assert.deepEqual(f.repository.readonlySnapshotStamp(), before)
    assert.deepEqual(f.repository.localCatalog.trackDetail(f.track.id), detail)
    assert.deepEqual(f.repository.localArtwork.context({ trackId: f.track.id, editionId: f.edition.id }).selection, f.selection)
  } finally { sourceRead.mock.restore(); syncBuiltinESMExports() }
})

test('持久手选封面：Owner五元prepared投影、网格回退与完成队列对账形成闭环', async t => {
  const f = await fixture(t), prepared: dto.LocalAlbumArtworkRequest[] = []
  let rootReads = 0
  const service = createLocalAlbumOwnerService({ repository: f.repository, datasetId: f.datasetId, assertCurrent() {},
    async readRootViews() { rootReads++; return [{ root: f.root, label: '合成离线音乐库', availability: 'SOURCE_ROOT_OFFLINE' }] },
    readCachedArtwork: request => f.reader.readCached(request),
    readPreparedArtwork(request) { prepared.push(request); return f.reader.persistedState(request) === 'available' },
    savedArtworkInventory: { revision: () => f.reader.cacheRevision(), read: (albumKey, rootId) => f.reader.cachedState(albumKey, rootId) },
    async readArtwork() { throw new Error('已有手选副本不能再进入来源读取。') },
  })
  t.after(() => service.close())
  const page = await service.queryAlbums({ query: '', rootId: null, filter: 'all', offset: 0, limit: 60 })
  assert.equal(page.total, 1)
  const album = page.items[0]!, request = { albumKey: album.id, rootId: album.rootId, editionId: album.editionId,
    representativeTrackId: album.representativeTrackId, revision: album.revision }
  assert.equal(album.artworkPrepared, true); assert.deepEqual(prepared, [request])
  const viewsBefore = rootReads
  for (const value of [request, { ...request, variant: 'grid' as const }]) {
    const reply = await service.getArtwork(value)
    assert.ok(dto.isLocalAlbumArtworkReply(reply, value)); assert.deepEqual(reply.image, image); assert.equal(reply.grid, undefined)
  }
  assert.equal(rootReads, viewsBefore, '本地手选快速回复不做源可用性探测。')
  const queue = createLocalAlbumArtworkQueue({ filePath: path.join(f.directory, 'manual-queue.sqlite') }); t.after(() => queue.close())
  queue.recover(f.datasetId); queue.enqueue(f.datasetId, [request]); assert.equal(queue.complete(queue.claim(f.datasetId)!), true)
  for (let round = 0; round < 3; round++) {
    const result = queue.reconcileCompleted(f.datasetId, null, [f.root.id], value => { assert.deepEqual(value, request); return f.reader.persistedState(value) })
    assert.equal(result.checked, 1); assert.equal(result.requeued, 0); assert.equal(result.done, true)
  }
  assert.deepEqual(queue.inspect(f.datasetId), { mode: 'running', pending: 0, running: 0, complete: 1 })
  assert.equal(f.repository.privateLocalAlbumArtworkResources!.lookup(f.datasetId, f.root.id, request.albumKey), null)
})

test('持久手选封面：优先于默认派生资源，伪造专辑/轨道/根与已撤权均闭集拒绝', async t => {
  const f = await fixture(t), store = f.repository.privateLocalAlbumArtworkResources!
  const lookup = t.mock.method(store, 'lookup', () => { throw new Error('已选副本优先级必须高于默认派生资源。') })
  try {
    assert.deepEqual(f.reader.readCached(f.request)?.image, image)
    assert.equal(f.reader.persistedState(f.request), 'available'); assert.equal(lookup.mock.callCount(), 0)
  } finally { lookup.mock.restore() }
  const otherAsset = f.repository.localCatalog.registerAsset({ commandId: randomUUID(), libraryRootId: f.root.id, expectedRootRevision: f.root.revision,
    relative: 'non-member.flac', sha256: null, sampleFrames: null, timebaseHz: null })
  const nonMember = f.repository.localCatalog.createTrack({ commandId: randomUUID(), assetId: otherAsset.id, segment: null })
  const otherMedia = path.join(f.directory, 'other-media'); await fs.mkdir(otherMedia)
  const otherSource = f.repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(otherMedia))
  const otherRoot = f.repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: otherSource.id, role: 'library' })
  const context = t.mock.method(f.repository.localArtwork, 'context', f.repository.localArtwork.context)
  for (const request of [
    { ...f.request, albumKey: `directory-${hash('伪造专辑')}` },
    { ...f.request, albumKey: `edition-${hash('另一发行')}` },
    { ...f.request, representativeTrackId: randomUUID() },
    { ...f.request, representativeTrackId: nonMember.id },
    { ...f.request, editionId: randomUUID() },
    { ...f.request, rootId: randomUUID() },
    { ...f.request, rootId: otherRoot.id, albumKey: `edition-${hash([otherRoot.id, f.edition.id])}` },
  ]) {
    assert.equal(f.reader.readCached(request), null); assert.equal(f.reader.persistedState(request), null)
  }
  assert.equal(context.mock.callCount(), 0, '未核实真实专辑、轨道及授权前不能借读取手选副本。')
  context.mock.restore()
  f.repository.sources.revoke({ commandId: randomUUID(), id: f.source.id })
  assert.equal(f.reader.readCached(f.request), null); assert.equal(f.reader.persistedState(f.request), null)
})

test('持久手选封面：损坏主库选图记录失效并记录闭集错误，不能冒充missing或回落默认图', async t => {
  const f = await fixture(t)
  f.repository.localCatalog.privateRead(damage => {
    const selected = JSON.parse(String(damage.prepare('SELECT data FROM local_artwork_selections WHERE edition_id=?').get(f.edition.id)!.data)) as dto.LocalArtworkSelection
    selected.candidate!.display.sha256 = '0'.repeat(64)
    damage.prepare('UPDATE local_artwork_selections SET data=? WHERE edition_id=?').run(JSON.stringify(selected), f.edition.id)
  })
  const logged = t.mock.method(console, 'info', (..._args: unknown[]) => {})
  const fallback = t.mock.method(f.repository.privateLocalAlbumArtworkResources!, 'lookup', () => { throw new Error('损坏手选图不能回落默认资源。') })
  try {
    assert.equal(f.reader.readCached(f.request), null); assert.equal(f.reader.persistedState(f.request), null)
    assert.equal(fallback.mock.callCount(), 0)
    const events = logged.mock.calls.flatMap(call => typeof call.arguments[0] === 'string' ? [readLibraryOperationLine(call.arguments[0])] : [])
    assert.equal(events.filter(event => event?.action === 'artwork.selection-invalid' && event.code === 'ARTWORK_RECORD_INVALID').length, 1)
  } finally { fallback.mock.restore(); logged.mock.restore() }
})

test('持久封面状态：严格DTO先于字段读取，已关闭与过期Owner仍抛生命周期错误', async t => {
  const f = await fixture(t)
  for (const invalid of [null, {}, { ...f.request, extra: true }, { ...f.request, variant: 'unknown' }]) {
    assert.equal(f.reader.persistedState(invalid as dto.LocalAlbumArtworkRequest), null)
    assert.equal(f.reader.readCached(invalid as dto.LocalAlbumArtworkRequest), null)
  }
  const expired = new Error('合成Owner已过期。'), stale = createLocalAlbumArtworkReader({ repository: f.repository, datasetId: f.datasetId, assertCurrent() { throw expired } })
  assert.throws(() => stale.persistedState(null as unknown as dto.LocalAlbumArtworkRequest), error => error === expired)
  await stale.close(); await f.reader.close()
  assert.throws(() => f.reader.persistedState(f.request), /已停止/u)
})
