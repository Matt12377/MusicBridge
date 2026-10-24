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
import type { ScanPreparedBatch, ScanPreparedItem } from '../../src/collection/local-scan-store.js'
import { createLocalAlbumArtworkReader } from '../../src/collection/local-album-browser/artwork-read-port.js'
import { createLocalAlbumOwnerRuntime } from '../../src/collection/local-album-browser/owner-runtime.js'
import { createLocalAlbumOwnerService } from '../../src/collection/local-album-browser/owner-port.js'
import { createLocalAlbumArtworkMembershipIssuer, readLocalAlbumArtworkMembershipProjection,
  type LocalAlbumArtworkMembershipProjection } from '../../src/collection/local-album-browser/artwork-membership-projection.js'
import { localAlbumScanPoint } from '../../src/collection/local-album-browser/scan-delta.js'
import type { LocalAlbumLibraryOrganization } from '../../src/collection/local-album-browser/sql-types.js'
import type { LocalAlbumArtworkResourceBinding } from '../../src/collection/local-album-browser/artwork-resource-store.js'
import type { LocalAlbumDisplayCacheRecord } from '../../src/collection/local-album-browser/display-cache.js'
import { createDatasetOwnerReadRevocation } from '../../src/collection/dataset-owner-read-revocation.js'
import { authorizeSourceDirectory } from '../../src/recording/source-files.js'

// 仅新建外置合成目录、真实SQLite和原prepare/commit；不启动Worker或Main，不读音频/NAS。
const parserVersion = 'music-metadata-11.15.0/mbrs003-v1'
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const query: dto.LocalAlbumQuery = { query: '', rootId: null, filter: 'all', offset: 0, limit: 200 }
const request = (album: dto.LocalAlbumSummary): dto.LocalAlbumArtworkRequest => ({ albumKey: album.id, rootId: album.rootId,
  editionId: album.editionId, representativeTrackId: album.representativeTrackId, revision: album.revision })
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
    evidence: { independent: [{ relative: 'album/cover.jpg', signature: '2:3:4:5:6', size: jpeg.length, included: true }], embedded: null,
      unresolved: false, embeddedConfirmed: true, independentOnly: true } }
}
async function fixture(t: TestContext, role?: dto.LocalLibraryRole) {
  const temporary = process.env.TMPDIR
  assert.ok(temporary && path.isAbsolute(temporary) && path.resolve(temporary).startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp'))
  const directory = await fsp.mkdtemp(path.join(temporary, 'album-membership-projected-')), filePath = path.join(directory, 'collection.sqlite')
  const repository = createCollectionRepository({ filePath }), datasetId = randomUUID(), revocation = createDatasetOwnerReadRevocation()
  const views: dto.LocalRootView[] = [], organizations: LocalAlbumLibraryOrganization[] = [], jobs = new Map<number, dto.ScanJobRecord>()
  const database = repository.localCatalog.privateRead(db => db)
  const submit = (library: number, items: ScanPreparedItem[], cueItems?: dto.LocalCuePreparedItem[]) => {
    const job = jobs.get(library)!
    const batch: ScanPreparedBatch = { batchId: randomUUID(), jobId: job.jobId, expectedJobRevision: job.jobRevision, checkpointBefore: job.checkpointRef,
      items, frontier: [''], completed: false, ...(cueItems ? { kind: 'cue-sidecars-v1' as const, cueItems } : {}) }
    repository.localScan.privatePrepareBatch({ commandId: randomUUID(), jobId: job.jobId, batch })
    jobs.set(library, repository.localScan.privateCommitBatch({ commandId: randomUUID(), jobId: job.jobId, batchId: batch.batchId, expectedRevision: job.jobRevision }))
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
  const options = { repository, datasetId, assertCurrent() {}, assertReadActive: revocation.assertActive,
    async readRootViews() { return views }, readLibraryOrganizations() { return organizations } }
  const runtime = createLocalAlbumOwnerRuntime(options), legacyReader = createLocalAlbumArtworkReader(options)
  const legacy = createLocalAlbumOwnerService({ ...options, readArtwork: async () => ({ image: null, status: 'source-unavailable' as const }),
    readPreparedArtwork: value => legacyReader.persistedState(value) === 'available',
    withArtworkInventoryRead: read => legacyReader.withInventoryRead(read),
    savedArtworkInventory: { revision: () => legacyReader.cacheRevision(), read: (albumKey, rootId) => legacyReader.cachedState(albumKey, rootId) } })
  const extraRuntimes: ReturnType<typeof createLocalAlbumOwnerRuntime>[] = []
  t.after(async () => {
    for (const extra of extraRuntimes) await extra.close()
    legacy.close(); await legacyReader.close(); await runtime.close(); repository.close()
    await fsp.rm(directory, { recursive: true, force: true })
  })
  // 先把原Compact真实建热，但没有持久图记录，不能顺便暖出旧membership memo。
  const raw = await runtime.localAlbums.queryAlbums(query)
  assert.equal(raw.total, role === 'album' ? 2 : 6)
  const states = new Map<string, 'available' | 'missing'>(), bindings = new Map<string, LocalAlbumArtworkResourceBinding>()
  function install(album: dto.LocalAlbumSummary, state: 'available' | 'missing') {
    const root = repository.localCatalog.root(album.rootId), capability = repository.sources.root(root.sourceRootId)
    const detail = repository.localCatalog.trackDetail(album.representativeTrackId!), locator = repository.localCatalog.privateAssetLocator(detail.asset.id)
    const organization = organizations.find(item => item.rootId === root.id)
    const versions = [...new Set(detail.versionTokens.filter(token => token.source === 'album' && (token.kind === 'edition' || token.kind === 'format')).map(token => token.raw))].sort()
    const binding: LocalAlbumArtworkResourceBinding = { datasetId, rootId: root.id, albumKey: album.id, editionId: album.editionId, representativeTrackId: album.representativeTrackId,
      authority: hash(['local-album-resource-authority-v1', root.id, root.sourceRootId, root.revision, capability.id, capability.path, capability.dev, capability.ino,
        organization ? [organization.sourceRootId, organization.rootRevision, organization.role, organization.bindingRevision, organization.recordSha256] : null]),
      membership: hash(['album-membership-v1', detail.track.id, detail.track.assetId, locator.relative, detail.asset.locationRevision, album.editionId, detail.metadata.raw.album?.trim() ?? '', versions]) }
    repository.privateLocalAlbumArtworkResources!.put(binding, state === 'available' ? record() : { image: null, evidence: noImage }, () => {})
    states.set(album.id, state); bindings.set(album.id, binding)
    return detail
  }
  for (const [index, album] of raw.items.entries()) if (index % 3 !== 2) install(album, index % 3 === 0 ? 'available' : 'missing')
  return { repository, filePath, database, options, runtime, reader: runtime.artwork, legacyReader, legacy, views, organizations,
    raw, states, bindings, revocation, submit, install,
    extraRuntime() { const other = createLocalAlbumOwnerRuntime(options); extraRuntimes.push(other); return other },
    album(library: number, index: number) {
      const state = repository.localScan.privateFileState(views[library]!.root.id, `album-${index}/01.wav`)!.value
      return raw.items.find(album => album.representativeTrackId === state.trackId)!
    } }
}


// 原Owner在SQL之后仍逐页执行readPreparedArtwork全核；这里只计本次优化承诺的全G SQL overlay。
// 不禁用页面强校验，也不把它的真实详情读取误算成投影失效。
function observeOverlay(t: TestContext, f: Awaited<ReturnType<typeof fixture>>) {
  const details = t.mock.method(f.repository.localCatalog, 'trackDetail'), reads: string[][] = []
  const queryAlbums = f.repository.localCatalog.privateAlbumBrowserQuery
  t.mock.method(f.repository.localCatalog, 'privateAlbumBrowserQuery', (...args: Parameters<typeof queryAlbums>) => {
    const start = details.mock.callCount()
    try { return queryAlbums(...args) }
    finally { reads.push(details.mock.calls.slice(start).map(call => call.arguments[0])) }
  })
  return { details, reads }
}

test('成员投影：Compact已热后的首全G库存零trackDetail，首末Root/Source真读且不读图片或媒体', async t => {
  const f = await fixture(t, 'catalog'), observed = observeOverlay(t, f), sources = t.mock.method(f.repository.sources, 'root')
  const blob = t.mock.method(f.repository.privateLocalAlbumArtworkResources!, 'get', () => { throw new Error('库存不能读取图片字节') })
  const media = t.mock.method(fsp, 'lstat', async () => { throw new Error('库存不能读取媒体来源') })
  syncBuiltinESMExports(); t.after(() => { media.mock.restore(); syncBuiltinESMExports() })
  const actual = await f.runtime.localAlbums.queryAlbums({ ...query, limit: 1 })
  assert.deepEqual(observed.reads, [[]], '4份持久资源均须在全G overlay消费原同run投影，不允许靠热membership掩盖首读')
  assert.equal(observed.details.mock.callCount(), actual.items.length, 'SQL后可见页原readPreparedArtwork全核仍逐项执行')
  assert.equal(sources.mock.callCount(), 4, '两根Source起始与末端均须实读')
  assert.equal(blob.mock.callCount(), 0); assert.equal(media.mock.callCount(), 0)
  assert.equal(actual.counts.all, 6); assert.equal(actual.counts['has-artwork'], 2); assert.equal(actual.counts['missing-artwork'], 2)
  const expected = await f.legacy.queryAlbums({ ...query, limit: 1 })
  assert.equal(observed.reads[1]!.length, 4, '对照真实原Reader，确认全G overlay这些持久记录本来确需完整成员查询')
  assert.deepEqual(actual, expected)
})

for (const role of [undefined, 'catalog', 'artist', 'album'] as const) {
  test(`成员投影：${role ?? 'null'}组织的全counts/所有filter/查询/根/分页与原Reader完全等价`, async t => {
    const f = await fixture(t, role)
    const requests: dto.LocalAlbumQuery[] = [
      ...(['all', ...dto.LOCAL_ALBUM_STATUSES] as const).map(filter => ({ ...query, filter, limit: 1 })),
      { ...query, query: '合成', rootId: f.views[0]!.root.id, offset: 1, limit: 1 },
      { ...query, offset: 1, limit: 2 },
    ]
    for (const value of requests) {
      const expected = await f.legacy.queryAlbums(value), actual = await f.runtime.localAlbums.queryAlbums(value)
      assert.deepEqual(actual, expected, `${role ?? 'null'}:${JSON.stringify(value)}`)
      assert.equal(dto.isLocalAlbumPage(actual, value), true)
      assert.ok(actual.items.every(item => !('membership_digest' in item) && !('membership' in item)), '纯摘要不能穿进公开DTO')
    }
    for (const view of f.views) view.availability = 'SOURCE_ROOT_OFFLINE'
    assert.deepEqual(await f.runtime.localAlbums.queryAlbums(query), await f.legacy.queryAlbums(query), '源离线仍可显示原合法持久图，不能当作已撤权')
  })
}

test('成员投影：排序新增真实代表后旧资源代表仍完整核验，不能丢失合法旧图', async t => {
  const f = await fixture(t, 'catalog'), album = f.raw.items.find(item => f.states.get(item.id) === 'available')!
  const library = f.views.findIndex(view => view.root.id === album.rootId), root = f.views[library]!.root
  const oldDetail = f.repository.localCatalog.trackDetail(album.representativeTrackId!), old = f.repository.localCatalog.privateAssetLocator(oldDetail.asset.id)
  assert.equal(old.asset.libraryRootId, root.id)
  f.submit(library, [accepted(`${path.posix.dirname(old.relative)}/00.wav`, oldDetail.metadata.raw.album!)])
  const observed = observeOverlay(t, f)
  const actual = await f.runtime.localAlbums.queryAlbums(query), current = actual.items.find(item => item.id === album.id)!
  assert.notEqual(current.representativeTrackId, album.representativeTrackId)
  assert.equal(current.artworkAvailable, true); assert.equal(current.artworkState, 'available')
  assert.deepEqual(observed.reads, [[album.representativeTrackId!]], '只有不匹配的旧代表须走原全G overlay完整成员读取')
  assert.equal(current.artworkPrepared, false, '当前代表的强准备证明不能冒充旧代表绑定；原SQL可用事实仍保留')
  assert.equal(f.reader.withInventoryRead(() => f.reader.cachedState(album.id, album.rootId)), 'available')
  assert.equal(f.reader.withInventoryRead(() => f.reader.persistedState(request(album))), 'available', '原旧tuple的真实持久证明仍有效')
  assert.deepEqual(actual, await f.legacy.queryAlbums(query))
})

test('成员投影：活动edition保持原完整详情核验，不以null发行摘要代替关系', async t => {
  const f = await fixture(t, 'catalog'), original = f.raw.items.find(item => f.states.get(item.id) === 'available')!
  const edition = f.repository.localCatalog.createEdition({ commandId: randomUUID(), title: '合成发行', edition: '合成版本' })
  f.repository.localCatalog.linkEditionTrack({ commandId: randomUUID(), editionId: edition.id, trackId: original.representativeTrackId!, disc: 1, trackNumber: 1, sequence: 1 })
  const page = await f.runtime.localAlbums.queryAlbums(query), album = page.items.find(item => item.editionId === edition.id)!
  assert.ok(album); f.install(album, 'available')
  const observed = observeOverlay(t, f)
  const actual = await f.runtime.localAlbums.queryAlbums(query)
  assert.deepEqual(observed.reads, [[original.representativeTrackId!]], '发行在全G overlay仍须实读原详情，其他null组只能用投影')
  assert.ok(observed.details.mock.callCount() > observed.reads[0]!.length, '原页面准备/选图检查必须保留真实详情读取')
  assert.equal(actual.items.find(item => item.id === album.id)!.artworkPrepared, true)
  assert.deepEqual(actual, await f.legacy.queryAlbums(query))
})

test('成员投影：根目录及title优先64词预算与原raw album成员公式一致', async t => {
  const f = await fixture(t, 'catalog'), versioned = accepted('版本目录/01.wav', '版本专辑 (Deluxe Edition) [FLAC]')
  versioned.fields = { title: '[FLAC] '.repeat(65).trim(), artist: '合成艺人', album: '版本专辑 (Deluxe Edition) [FLAC]' }
  f.submit(0, [accepted('根曲.wav', '根层专辑 (Deluxe Edition) [FLAC]'), versioned])
  const page = await f.runtime.localAlbums.queryAlbums(query)
  for (const relative of ['根曲.wav', '版本目录/01.wav']) {
    const state = f.repository.localScan.privateFileState(f.views[0]!.root.id, relative)!.value
    const album = page.items.find(item => item.representativeTrackId === state.trackId)!
    assert.ok(album); const detail = f.install(album, 'available')
    if (relative.includes('/')) assert.equal(detail.versionTokens.filter(token => token.source === 'album').length, 0, 'title先耗完原64项预算，album不得重新获得预算')
  }
  const observed = observeOverlay(t, f), actual = await f.runtime.localAlbums.queryAlbums(query)
  assert.deepEqual(observed.reads, [[]], '根目录及原64词均由SQL投影精确覆盖，不得重读成员详情')
  assert.equal(observed.details.mock.callCount(), actual.items.length, '公开页当前成员的原准备证明仍全核')
  assert.deepEqual(actual, await f.legacy.queryAlbums(query))
})

for (const kind of ['source-revoke', 'metadata', 'resource', 'organization', 'owner-revoke'] as const) {
  test(`成员投影：${kind}发生在真实UDF命中后仍须被原末屏障拒绝`, async t => {
    const f = await fixture(t, 'catalog'), original = f.reader.cachedStateProjected, album = f.raw.items.find(item => f.states.get(item.id) === 'available')!
    let changed = false
    const hook = t.mock.method(f.reader, 'cachedStateProjected', (proof: LocalAlbumArtworkMembershipProjection) => {
      const value = original(proof)
      if (!changed && value !== undefined) {
        changed = true
        if (kind === 'source-revoke') f.repository.sources.revoke({ commandId: randomUUID(), id: f.views[0]!.root.sourceRootId })
        else if (kind === 'metadata') f.repository.localCatalog.overrideMetadata({ commandId: randomUUID(), trackId: album.representativeTrackId!, expectedRevision: null, fields: { title: '命中后的真实变化' } })
        else if (kind === 'resource') f.repository.privateLocalAlbumArtworkResources!.put(f.bindings.get(album.id)!, { image: null, evidence: noImage }, () => {})
        else if (kind === 'organization') f.organizations[0] = { ...f.organizations[0]!, bindingRevision: 2, recordSha256: hash('命中后组织变化') }
        else f.revocation.revoke()
      }
      return value
    })
    await assert.rejects(f.runtime.localAlbums.queryAlbums(query), { code: kind === 'owner-revoke' ? 'UNAVAILABLE' : 'SNAPSHOT_CHANGED' })
    assert.equal(changed, true, '故障必须由真实投影回调触发，不能提前失败而误绿')
    hook.mock.restore()
    if (kind !== 'owner-revoke') assert.deepEqual(await f.runtime.localAlbums.queryAlbums(query), await f.legacy.queryAlbums(query), '失败scope不能发布部分结果或热摘要')
  })
}

test('成员投影：捕获真实UDF证书在回调后、另一scope及await后均不能重放', async t => {
  const f = await fixture(t, 'catalog'), original = f.reader.cachedStateProjected, captured: LocalAlbumArtworkMembershipProjection[] = []
  const hook = t.mock.method(f.reader, 'cachedStateProjected', (proof: LocalAlbumArtworkMembershipProjection) => {
    assert.ok(readLocalAlbumArtworkMembershipProjection(proof))
    captured.push(proof); return original(proof)
  })
  const actual = await f.runtime.localAlbums.queryAlbums(query)
  assert.ok(captured.length >= actual.total)
  hook.mock.restore()
  for (const proof of captured) {
    assert.equal(readLocalAlbumArtworkMembershipProjection(proof), undefined)
    assert.equal(f.reader.withInventoryRead(() => original(proof)), undefined)
  }
  await Promise.resolve()
  assert.equal(f.reader.withInventoryRead(() => original(captured[0]!)), undefined)
  assert.equal(f.reader.withInventoryRead(() => original(Object.freeze({}))), undefined)
})

test('成员投影：原连接/物理点/作者精确绑定，事务、坏摘要、关闭issuer和异步逃逸不能授予快路', async t => {
  const f = await fixture(t), binding = [...f.bindings.values()][0]!, point = localAlbumScanPoint(f.database)!, author = Object.freeze({})
  const fact = { albumKey: binding.albumKey, rootId: binding.rootId, editionId: null, representativeTrackId: binding.representativeTrackId!, membership: binding.membership } as const
  const issuer = createLocalAlbumArtworkMembershipIssuer(f.database, point, author), other = new DatabaseSync(':memory:')
  t.after(() => { issuer.close(); other.close() })
  assert.equal(issuer.read(fact, proof => readLocalAlbumArtworkMembershipProjection(proof, author, f.database, point)?.membership), fact.membership)
  assert.equal(issuer.read(fact, proof => readLocalAlbumArtworkMembershipProjection(proof, {}, f.database, point)), undefined)
  assert.equal(issuer.read(fact, proof => readLocalAlbumArtworkMembershipProjection(proof, author, other, point)), undefined)
  assert.equal(issuer.read(fact, proof => readLocalAlbumArtworkMembershipProjection(proof, author, f.database, { ...point, changes: point.changes + 1 })), undefined)
  for (const invalid of [{ ...fact, membership: '0'.repeat(63) }, { ...fact, albumKey: 'x'.repeat(257) }, { ...fact, rootId: 'x'.repeat(129) }]) {
    assert.equal(issuer.read(invalid, () => assert.fail('无效内部摘要不能调用快路')), undefined)
  }
  f.database.exec('BEGIN IMMEDIATE')
  try { assert.equal(issuer.read(fact, () => assert.fail('事务中不能消费投影')), undefined) } finally { f.database.exec('ROLLBACK') }
  const late = issuer.read(fact, async proof => { assert.ok(readLocalAlbumArtworkMembershipProjection(proof)); await Promise.resolve(); return readLocalAlbumArtworkMembershipProjection(proof) })
  assert.equal(await late, undefined)
  issuer.close(); assert.equal(issuer.read(fact, () => assert.fail('已封口issuer不得再签发')), undefined)
})

test('成员投影：Reader拒另一DB或不同物理点，不能仅凭64hex摘要跳过原scope', async t => {
  const f = await fixture(t), binding = [...f.bindings.values()][0]!, point = localAlbumScanPoint(f.database)!
  const fact = { albumKey: binding.albumKey, rootId: binding.rootId, editionId: null, representativeTrackId: binding.representativeTrackId!, membership: binding.membership } as const
  const other = new DatabaseSync(':memory:'), owner = Object.freeze({})
  const wrongDatabase = createLocalAlbumArtworkMembershipIssuer(other, point, owner)
  const wrongPoint = createLocalAlbumArtworkMembershipIssuer(f.database, { ...point, changes: point.changes + 1 }, owner)
  t.after(() => { wrongDatabase.close(); wrongPoint.close(); other.close() })
  for (const issuer of [wrongDatabase, wrongPoint]) assert.equal(issuer.read(fact, proof => f.reader.withInventoryRead(() => f.reader.cachedStateProjected(proof))), undefined)
})

test('成员投影：额外64hex计入原Compact容量，超预算回退完整SQL且负资格不逐页重试', async t => {
  const f = await fixture(t, 'catalog'), expected = await f.legacy.queryAlbums(query), other = f.extraRuntime(), bytes = Buffer.byteLength
  let metered = 0, compactions = 0
  const prepare = DatabaseSync.prototype.prepare
  t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    if (this === f.database && sql.includes('/* mb_album_compact_groups */')) compactions++
    return prepare.call(this, sql)
  })
  const budget = t.mock.method(Buffer, 'byteLength', (value: unknown, ...rest: unknown[]) => {
    if (typeof value === 'string' && value.includes('"membership_digest":"') && value.includes('"artwork_index":')) { metered++; return 17 * 1024 * 1024 }
    return Reflect.apply(bytes, Buffer, [value, ...rest])
  })
  assert.deepEqual(await other.localAlbums.queryAlbums(query), expected)
  const second = await other.localAlbums.queryAlbums({ ...query, offset: 1, limit: 1 })
  assert.deepEqual(second.items, expected.items.slice(1, 2)); assert.deepEqual(second.counts, expected.counts)
  assert.equal(metered, 1, '原容量计量必须包含成员摘要，而不是额外无预算旁缓存')
  assert.equal(compactions, 1, '同物理点的容量失败须保原有界负资格，不能每页重建')
  budget.mock.restore()
})
