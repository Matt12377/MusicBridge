import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as dto from '@music-bridge/contracts'
import { createCollectionRepository } from '../../src/collection/repository.js'
import { sourceWritesProjectionForDatabase } from '../../src/collection/local-catalog-store.js'
import type { ScanPreparedBatch, ScanPreparedItem } from '../../src/collection/local-scan-store.js'
import { createLocalAlbumArtworkReader } from '../../src/collection/local-album-browser/artwork-read-port.js'
import { createLocalAlbumOwnerRuntime } from '../../src/collection/local-album-browser/owner-runtime.js'
import type { LocalAlbumLibraryOrganization } from '../../src/collection/local-album-browser/sql-types.js'
import type { LocalAlbumArtworkResourceBinding } from '../../src/collection/local-album-browser/artwork-resource-store.js'
import type { LocalAlbumDisplayCacheRecord } from '../../src/collection/local-album-browser/display-cache.js'
import { authorizeSourceDirectory } from '../../src/recording/source-files.js'

// 仅外置合成目录、真实SQLite及原scan prepare/commit；不启动扫描worker，不读真实音频/NAS。
const parserVersion = 'music-metadata-11.15.0/mbrs003-v1'
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const query: dto.LocalAlbumQuery = { query: '', rootId: null, filter: 'all', offset: 0, limit: 200 }
const request = (album: dto.LocalAlbumSummary): dto.LocalAlbumArtworkRequest => ({ albumKey: album.id, rootId: album.rootId, editionId: album.editionId, representativeTrackId: album.representativeTrackId, revision: album.revision })
const accepted = (relative: string, album: string, signature = `合成签名-${relative}`): ScanPreparedItem => ({
  relative, signature, parserVersion, outcome: 'accepted', fields: { title: path.posix.basename(relative), artist: '合成艺人', album }, failureCode: null, reused: false,
  readFacts: { technical: { container: 'WAVE', codec: 'PCM', lossless: true, sampleRateHz: 48000, channels: 2, bitsPerSample: 16, durationSeconds: 10, evidence: 'bounded-parser-reported' },
    coverEvidence: [], readEvidence: { bytesRead: 44, readCalls: 1, maxReadBytes: 44, allocationBytes: 44, elapsedMs: 1, wholeAudioHash: false, wholeAudioDecode: false } },
})
const noImage = { independent: [], embedded: null, unresolved: false, embeddedConfirmed: true, independentOnly: false }
function record(): LocalAlbumDisplayCacheRecord {
  const jpeg = fs.readFileSync(new URL('../fixtures/mbrs012-source/owned-cover-16.jpg', import.meta.url))
  const info = { mime: 'image/jpeg' as const, bytes: jpeg.length, sha256: createHash('sha256').update(jpeg).digest('hex'), width: 16, height: 16 }
  return { image: { original: info, display: { ...info, dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}` } },
    evidence: { independent: [{ relative: 'album/cover.jpg', signature: '2:3:4:5:6', size: jpeg.length, included: true }], embedded: null, unresolved: false, embeddedConfirmed: true, independentOnly: true } }
}

async function fixture(t: TestContext, role?: dto.LocalLibraryRole) {
  const temporary = process.env.TMPDIR
  assert.ok(temporary && path.isAbsolute(temporary) && path.resolve(temporary).startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp'))
  const directory = await fsp.mkdtemp(path.join(temporary, 'album-membership-cache-')), filePath = path.join(directory, 'collection.sqlite')
  const repository = createCollectionRepository({ filePath }), datasetId = randomUUID()
  const views: dto.LocalRootView[] = [], organizations: LocalAlbumLibraryOrganization[] = [], jobs = new Map<number, dto.ScanJobRecord>()
  let database!: DatabaseSync, coldSequence = 0
  repository.localCatalog.privateRead(db => { database = db })
  const prepare = (library: number, items: ScanPreparedItem[], cueItems?: dto.LocalCuePreparedItem[]) => {
    const job = jobs.get(library)!
    const batch: ScanPreparedBatch = { batchId: randomUUID(), jobId: job.jobId, expectedJobRevision: job.jobRevision, checkpointBefore: job.checkpointRef,
      items, frontier: [''], completed: false, ...(cueItems ? { kind: 'cue-sidecars-v1' as const, cueItems } : {}) }
    repository.localScan.privatePrepareBatch({ commandId: randomUUID(), jobId: job.jobId, batch })
    return { commandId: randomUUID(), jobId: job.jobId, batchId: batch.batchId, expectedRevision: job.jobRevision }
  }
  const submit = (library: number, items: ScanPreparedItem[], cueItems?: dto.LocalCuePreparedItem[]) => {
    const commit = prepare(library, items, cueItems), job = repository.localScan.privateCommitBatch(commit)
    jobs.set(library, job); return commit
  }
  for (let library = 0; library < 2; library++) {
    const media = path.join(directory, `media-${library}`); await fsp.mkdir(media)
    const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media))
    const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' })
    views.push({ root, label: `合成根${library}`, availability: 'ONLINE' })
    if (role) organizations.push({ datasetId, rootId: root.id, sourceRootId: source.id, rootRevision: root.revision, role,
      bindingRevision: 1, recordSha256: hash(['合成组织', library]), rootName: `合成根${library}`, parentName: '合成来源' })
    const started = repository.localScan.start({ commandId: randomUUID(), datasetId, libraryRootId: root.id, expectedRootRevision: root.revision, parserVersion }).job
    jobs.set(library, repository.localScan.resume({ commandId: randomUUID(), jobId: started.jobId, expectedRevision: started.jobRevision }))
    submit(library, Array.from({ length: 3 }, (_, index) => accepted(`album-${index}/01.wav`, `合成专辑${index}`)))
  }
  const options = { repository, datasetId, assertCurrent() {}, async readRootViews() { return views }, readLibraryOrganizations() { return organizations } }
  const runtime = createLocalAlbumOwnerRuntime(options), reader = runtime.artwork
  t.after(async () => { await runtime.close(); repository.close(); await fsp.rm(directory, { recursive: true, force: true }) })
  const raw = await runtime.localAlbums.queryAlbums(query)
  assert.equal(raw.total, role === 'album' ? 2 : 6)
  const states = new Map<string, 'available' | 'missing'>(), bindings = new Map<string, LocalAlbumArtworkResourceBinding>(), byPath = new Map<string, dto.LocalAlbumSummary>()
  for (const [index, album] of raw.items.entries()) {
    const root = repository.localCatalog.root(album.rootId), capability = repository.sources.root(root.sourceRootId)
    const detail = repository.localCatalog.trackDetail(album.representativeTrackId!), locator = repository.localCatalog.privateAssetLocator(detail.asset.id)
    const organization = organizations.find(item => item.rootId === root.id)
    const versions = [...new Set(detail.versionTokens.filter(token => token.source === 'album' && (token.kind === 'edition' || token.kind === 'format')).map(token => token.raw))].sort()
    const binding: LocalAlbumArtworkResourceBinding = { datasetId, rootId: root.id, albumKey: album.id, editionId: null, representativeTrackId: album.representativeTrackId,
      authority: hash(['local-album-resource-authority-v1', root.id, root.sourceRootId, root.revision, capability.id, capability.path, capability.dev, capability.ino,
        organization ? [organization.sourceRootId, organization.rootRevision, organization.role, organization.bindingRevision, organization.recordSha256] : null]),
      membership: hash(['album-membership-v1', detail.track.id, detail.track.assetId, locator.relative, detail.asset.locationRevision, null, detail.metadata.raw.album?.trim() ?? '', versions]) }
    const state = index % 2 ? 'missing' : 'available'
    repository.privateLocalAlbumArtworkResources!.put(binding, state === 'available' ? record() : { image: null, evidence: noImage }, () => {})
    states.set(album.id, state); bindings.set(album.id, binding); byPath.set(JSON.stringify([root.id, locator.relative]), album)
  }
  const initial = await runtime.localAlbums.queryAlbums(query)
  const readAll = (target = reader) => target.withInventoryRead(() => initial.items.map(album => target.cachedState(album.id, album.rootId)))
  function cue(relative: string, audio: string): dto.LocalCuePreparedItem {
    const root = views[0]!.root, state = repository.localScan.privateFileState(root.id, audio)!.value
    const locator = repository.localCatalog.privateAssetLocator(state.assetId!), asset = locator.asset
    return { relative, signature: `合成CUE-${randomUUID()}`, parserVersion: 'cue-text-75fps/mbrs003-v1', outcome: 'accepted', failureCode: null, reused: false,
      previousSnapshotId: repository.localScan.privateCueSnapshot(root.id, relative)?.id ?? null,
      result: { status: 'ok', tracks: [{ trackNumber: 1, fileOrdinal: 1,
        assetReference: { assetId: asset.id, libraryRootId: root.id, sourceRootId: root.sourceRootId, rootRevision: root.revision, fileRevision: asset.fileRevision,
          locationRevision: asset.locationRevision, relative: locator.relative, signature: state.signature },
        timebase: 'cue-cd-frames', framesPerSecond: 75, index00Frames: null, index01Frames: 0, endFrames: null, evidence: 'cue-text-declared', playback: 'NOT_VERIFIED' }] } }
  }
  async function cold() {
    const copy = path.join(directory, `cold-${++coldSequence}.sqlite`)
    repository.localCatalog.privateRead(db => db.prepare('VACUUM INTO ?').run(copy))
    // 资源库使用DELETE journal；同步操作完成后复制已提交文件，独立冷作者不持有旧memo或delta。
    fs.copyFileSync(filePath + '.album-artwork-resources.sqlite', copy + '.album-artwork-resources.sqlite')
    fs.chmodSync(copy + '.album-artwork-resources.sqlite', 0o600)
    const otherRepository = createCollectionRepository({ filePath: copy }), other = createLocalAlbumOwnerRuntime({ ...options, repository: otherRepository })
    try { return await other.localAlbums.queryAlbums(query) } finally { await other.close(); otherRepository.close() }
  }
  return { repository, options, reader, runtime, initial, states, bindings, views, organizations, database, filePath, jobs, prepare, submit, cue, cold, readAll,
    album(library: number, index: number) { return byPath.get(JSON.stringify([views[library]!.root.id, `album-${index}/01.wav`]))! },
    page() { return runtime.localAlbums.queryAlbums(query) } }
}

function observeDetails(t: TestContext, f: Awaited<ReturnType<typeof fixture>>) {
  const details = t.mock.method(f.repository.localCatalog, 'trackDetail')
  return {
    read(target = f.reader) { const start = details.mock.callCount(), states = f.readAll(target); return { states, ids: details.mock.calls.slice(start).map(call => call.arguments[0]).sort() } },
    get count() { return details.mock.callCount() },
  }
}

for (const role of [undefined, 'catalog', 'artist', 'album'] as const) {
  test(`成员摘要缓存：实际${role ?? 'null'}角色同点复用资格与原SQL一致，Root/Source每scope仍首末实读`, async t => {
    const f = await fixture(t, role), observed = observeDetails(t, f), source = t.mock.method(f.repository.sources, 'root')
    assert.equal(observed.read().ids.length, f.initial.items.length, '实际方法作者变化后首轮必须全部冷核')
    const before = source.mock.callCount(), next = observed.read(), reusable = role === undefined || role === 'catalog'
    assert.deepEqual(next.states, f.initial.items.map(album => f.states.get(album.id)))
    assert.equal(next.ids.length, reusable ? 0 : f.initial.items.length)
    assert.equal(source.mock.callCount() - before, 4, '两个根的首末Source能力均必须真读，不能随成员cache命中消失')
    assert.deepEqual(await f.page(), await f.cold())
  })
}

test('成员摘要缓存：catalog真实连续3×16新曲只冷核同目录，未动根/目录热，卡片counts修订均等于独立冷全量', async t => {
  const f = await fixture(t, 'catalog'), observed = observeDetails(t, f), affected = f.album(0, 0), stable = f.album(1, 2)
  observed.read(); assert.equal(observed.read().ids.length, 0)
  const before = await f.page(), stableCard = before.items.find(album => album.id === stable.id)
  for (let batch = 0; batch < 3; batch++) {
    f.submit(0, Array.from({ length: 16 }, (_, index) => accepted(`album-0/批${batch}-${index}.wav`, '合成专辑0')))
    assert.deepEqual(observed.read().ids, [affected.representativeTrackId!])
    const page = await f.page()
    assert.deepEqual(page, await f.cold(), `第${batch + 1}批必须对齐完整卡片/counts/修订`)
    assert.deepEqual(page.items.find(album => album.id === stable.id), stableCard)
    assert.equal(page.items.find(album => album.id === affected.id)!.trackCount, 1 + (batch + 1) * 16)
  }
})

test('成员摘要缓存：同文件真实重写改组，旧绑定失效且只冷核脏目录，其他根保持热', async t => {
  const f = await fixture(t, 'catalog'), observed = observeDetails(t, f), affected = f.album(0, 0)
  observed.read(); f.submit(0, [accepted('album-0/01.wav', '重写后的专辑', '合成改写后的文件签名')])
  const changed = observed.read()
  assert.deepEqual(changed.ids, [affected.representativeTrackId!])
  assert.equal(changed.states[f.initial.items.findIndex(album => album.id === affected.id)], null)
  const page = await f.page(); assert.ok(!page.items.some(album => album.id === affected.id))
  assert.ok(page.items.some(album => album.title === '重写后的专辑'))
  assert.deepEqual(page, await f.cold())
})

test('成员摘要缓存：catalog根目录及原title优先64版本词预算均精确符合SQL组名', async t => {
  const f = await fixture(t, 'catalog'), versioned = accepted('版本目录/01.wav', '版本专辑 (Deluxe Edition) [FLAC]')
  versioned.fields = { title: '[FLAC] '.repeat(65).trim(), artist: '合成艺人', album: '版本专辑 (Deluxe Edition) [FLAC]' }
  f.submit(0, [accepted('根曲.wav', '根层专辑 (Deluxe Edition) [FLAC]'), versioned])
  const page = await f.page(), trackIds = ['根曲.wav', '版本目录/01.wav'].map(relative => f.repository.localScan.privateFileState(f.views[0]!.root.id, relative)!.value.trackId!)
  const albums = trackIds.map(trackId => page.items.find(album => album.representativeTrackId === trackId)!)
  assert.ok(albums.every(Boolean)); assert.deepEqual(page, await f.cold())
  const details = t.mock.method(f.repository.localCatalog, 'trackDetail')
  const read = () => f.reader.withInventoryRead(() => albums.map(album => f.reader.persistedState(request(album))))
  assert.deepEqual(read(), [null, null]); assert.equal(details.mock.callCount(), 2)
  assert.deepEqual(read(), [null, null]); assert.equal(details.mock.callCount(), 2, '只有精确原group key证明成功才能跨scope省详情')
})

test('成员摘要缓存：真实跨目录CUE提交只冷侧车和引用目录，cue-aware批的audio items仍全部剔除', async t => {
  const f = await fixture(t, 'catalog')
  f.submit(0, [], []) // 首次CUE schema建表是完整屏障；测试测已建立schema后的真实CUE段。
  const observed = observeDetails(t, f); observed.read(); assert.equal(observed.read().ids.length, 0)
  f.submit(0, [], [f.cue('album-1/disc.cue', 'album-0/01.wav')])
  assert.deepEqual(observed.read().ids, [f.album(0, 0).representativeTrackId!, f.album(0, 1).representativeTrackId!].sort())
  assert.equal(observed.read().ids.length, 0)
  assert.deepEqual(await f.page(), await f.cold())
  f.submit(0, [accepted('album-2/新曲.wav', '合成专辑2')], [])
  assert.deepEqual(observed.read().ids, [f.album(0, 2).representativeTrackId!])
  assert.deepEqual(await f.page(), await f.cold())
})

test('成员摘要缓存：override未知写全冷；活动edition每次实读，不能借旧null绑定或伪造albumKey复用', async t => {
  const f = await fixture(t, 'catalog'), observed = observeDetails(t, f), album = f.album(0, 0)
  observed.read()
  f.repository.localCatalog.overrideMetadata({ commandId: randomUUID(), trackId: album.representativeTrackId!, expectedRevision: null, fields: { title: '人工覆盖标题' } })
  assert.equal(observed.read().ids.length, 6); assert.equal(observed.read().ids.length, 0)
  assert.deepEqual(await f.page(), await f.cold())
  const edition = f.repository.localCatalog.createEdition({ commandId: randomUUID(), title: '合成发行', edition: '' })
  f.repository.localCatalog.linkEditionTrack({ commandId: randomUUID(), editionId: edition.id, trackId: album.representativeTrackId!, disc: 1, trackNumber: 1, sequence: 1 })
  assert.equal(observed.read().ids.length, 6)
  const next = observed.read(); assert.deepEqual(next.ids, [album.representativeTrackId!])
  assert.equal(next.states[f.initial.items.findIndex(item => item.id === album.id)], null)
  assert.deepEqual(await f.page(), await f.cold())
  const other = f.album(1, 0), bad = { ...request(other), albumKey: `directory-${hash('伪造组名')}` }
  for (let attempt = 0; attempt < 2; attempt++) {
    const start = observed.count
    assert.equal(f.reader.withInventoryRead(() => f.reader.persistedState(bad)), null)
    assert.equal(observed.count - start, 1, '成功读出详情也必须精确证明原SQL albumKey才能跨scope保留')
  }
})

test('成员摘要缓存：连续empty prepare跨滑窗可热，129段未消费缺起点则完整冷核，不借后缀证明', async t => {
  const f = await fixture(t), observed = observeDetails(t, f); observed.read()
  for (let index = 0; index < 70; index++) { f.prepare(0, []); assert.equal(observed.read().ids.length, 0) }
  for (let index = 0; index < 129; index++) f.prepare(0, [])
  assert.equal(observed.read().ids.length, 6)
  assert.equal(observed.read().ids.length, 0)
  assert.deepEqual(await f.page(), await f.cold())
})

for (const kind of ['unknown-write', 'rollback', 'schema', 'transaction', 'external-data-version'] as const) {
  test(`成员摘要缓存：${kind}实际物理变化不复用旧摘要`, async t => {
    const f = await fixture(t), observed = observeDetails(t, f); observed.read(); assert.equal(observed.read().ids.length, 0)
    if (kind === 'schema') f.database.exec('CREATE TABLE membership_cache_probe(value INTEGER)')
    else if (kind === 'external-data-version') {
      const external = new DatabaseSync(f.filePath)
      const before = f.database.prepare('PRAGMA data_version').get()!.data_version
      try { external.prepare("UPDATE local_scan_jobs SET data=json_set(data,'$.jobRevision','999999') WHERE id=?").run(f.jobs.get(0)!.jobId) } finally { external.close() }
      assert.notEqual(f.database.prepare('PRAGMA data_version').get()!.data_version, before, '外部连接必须真正改变内容并前推data_version')
      assert.throws(() => observed.read(), '实际catalog guard必须先拒绝外部连接写后的失效凭证，不能返回热摘要')
      return
    } else {
      if (kind === 'rollback' || kind === 'transaction') f.database.exec('BEGIN IMMEDIATE')
      f.database.prepare('UPDATE local_scan_jobs SET data=data WHERE id=?').run(f.jobs.get(0)!.jobId)
      if (kind === 'rollback') f.database.exec('ROLLBACK')
    }
    assert.equal(observed.read().ids.length, 6)
    if (kind === 'transaction') { assert.equal(observed.read().ids.length, 6); f.database.exec('ROLLBACK'); assert.equal(observed.read().ids.length, 6) }
    else assert.equal(observed.read().ids.length, 0)
  })
}

test('成员摘要缓存：实际Source投影作者换代即使物理点相同也全部冷核；新Reader不承接旧实例缓存', async t => {
  const f = await fixture(t, 'catalog'), observed = observeDetails(t, f); observed.read(); assert.equal(observed.read().ids.length, 0)
  const before = sourceWritesProjectionForDatabase(f.database)!.fullRaw
  f.repository.localCatalog.privateSourceWritesTransaction(() => {})
  assert.notEqual(sourceWritesProjectionForDatabase(f.database)!.fullRaw, before)
  assert.equal(observed.read().ids.length, 6); assert.equal(observed.read().ids.length, 0)
  const coldReader = createLocalAlbumArtworkReader(f.options)
  try { assert.equal(observed.read(coldReader).ids.length, 6); assert.equal(observed.read(coldReader).ids.length, 0) } finally { await coldReader.close() }
})

test('成员摘要缓存：末端实际主库变化弃整scope，失败后不能发布部分摘要', async t => {
  const f = await fixture(t, 'catalog'), observed = observeDetails(t, f), album = f.album(0, 0)
  observed.read(); assert.equal(observed.read().ids.length, 0)
  assert.throws(() => f.reader.withInventoryRead(() => {
    const value = f.reader.cachedState(album.id, album.rootId)
    f.repository.localCatalog.overrideMetadata({ commandId: randomUUID(), trackId: album.representativeTrackId!, expectedRevision: null, fields: { title: '末端真实改变' } })
    return value
  }), { code: 'SNAPSHOT_CHANGED' })
  assert.equal(observed.read().ids.length, 6)
  assert.deepEqual(await f.page(), await f.cold())
})

test('成员摘要缓存：热命中后真实Source撤权与内存retire均被原末授权屏障拒绝', async t => {
  for (const kind of ['source-revoke', 'retire'] as const) {
    const f = await fixture(t, 'catalog'), observed = observeDetails(t, f), album = f.album(0, 0)
    observed.read(); assert.equal(observed.read().ids.length, 0)
    let removal: Promise<void> | undefined
    assert.throws(() => f.reader.withInventoryRead(() => {
      const value = f.reader.cachedState(album.id, album.rootId)
      if (kind === 'source-revoke') f.repository.sources.revoke({ commandId: randomUUID(), id: f.views[0]!.root.sourceRootId })
      else removal = f.reader.removeLibrary(album.rootId)
      return value
    }), { code: 'SNAPSHOT_CHANGED' })
    if (removal) await removal
    const after = observed.read()
    assert.equal(after.states[f.initial.items.findIndex(item => item.id === album.id)], null)
    assert.equal(after.ids.length, 3, '失效scope清掉保留池后，另一未撤销root也须重新冷核')
  }
})

test('成员摘要缓存：编码预算不足保留原结果并持续冷读，恢复预算后才可热命中', async t => {
  const f = await fixture(t, 'catalog'), observed = observeDetails(t, f), bytes = Buffer.byteLength
  // 只把成员摘要候选的编码计量提高；真实DB内容及原row预算计量保持不变。
  const budget = t.mock.method(Buffer, 'byteLength', (value: unknown, ...rest: unknown[]) =>
    typeof value === 'string' && value.startsWith('["[') && value.includes('\\"directory-') ? 8 * 1024 * 1024 : Reflect.apply(bytes, Buffer, [value, ...rest]))
  assert.equal(observed.read().ids.length, 6)
  const next = observed.read(); assert.equal(next.ids.length, 6); assert.deepEqual(next.states, f.initial.items.map(album => f.states.get(album.id)))
  budget.mock.restore()
  assert.equal(observed.read().ids.length, 6); assert.equal(observed.read().ids.length, 0)
})
