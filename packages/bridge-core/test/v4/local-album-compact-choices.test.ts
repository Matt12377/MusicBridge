import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync, StatementSync } from 'node:sqlite'
import * as dto from '@music-bridge/contracts'
import { buildStoragePolicy } from '../../../../apps/desktop/scripts/build-storage-root.mjs'
import { createCollectionRepository, type CollectionRepository } from '../../src/collection/repository.js'
import { authorizeSourceDirectory } from '../../src/recording/source-files.js'
import { METADATA_PARSER_VERSION } from '../../src/library/metadata-reader-types.js'
import type { ScanPreparedBatch, ScanPreparedItem } from '../../src/collection/local-scan-store.js'
import type { LocalAlbumSqlScope } from '../../src/collection/local-album-browser/sql-types.js'

const choices = `compact_choices AS MATERIALIZED(SELECT root_id,album_key,min(directory) physical_min,max(directory) physical_max,
      coalesce(min(sequence) FILTER(WHERE has_artwork=1),min(sequence)) selected_sequence FROM members GROUP BY root_id,album_key)`
const windows = `compact_members AS MATERIALIZED(SELECT p.*,
      min(directory) OVER(PARTITION BY root_id,album_key) physical_min,max(directory) OVER(PARTITION BY root_id,album_key) physical_max,
      ROW_NUMBER() OVER(PARTITION BY root_id,album_key ORDER BY has_artwork DESC,sequence) artwork_rank FROM members p)`
const newJoin = `FROM group_facts g LEFT JOIN compact_choices c ON c.root_id=g.root_id AND c.album_key=g.album_key
      LEFT JOIN members p ON p.root_id=g.root_id AND p.album_key=g.album_key AND p.sequence=c.selected_sequence`
const oldJoin = 'FROM group_facts g LEFT JOIN compact_members p ON p.root_id=g.root_id AND p.album_key=g.album_key AND p.artwork_rank=1'
const query = (): dto.LocalAlbumQuery => ({ rootId: null, query: '', filter: 'all', offset: 0, limit: 200 })
const request = (album: dto.LocalAlbumSummary): dto.LocalAlbumArtworkRequest => ({ albumKey: album.id, rootId: album.rootId,
  editionId: album.editionId, representativeTrackId: album.representativeTrackId, revision: album.revision })
const identity = (rootId: string, albumKey: string) => JSON.stringify([rootId, albumKey])
const audio = (relative: string, album: string, number: number, embedded = false): ScanPreparedItem => ({
  relative, signature: `合成签名-${relative}`, parserVersion: METADATA_PARSER_VERSION, outcome: 'accepted',
  fields: { title: path.posix.basename(relative), artist: '合成艺人', album, disc: '1', track: String(number) }, failureCode: null, reused: false,
  readFacts: { technical: { container: 'WAVE', codec: 'PCM', lossless: true, sampleRateHz: 48000, channels: 2, bitsPerSample: 16, durationSeconds: 10, evidence: 'bounded-parser-reported' },
    // 本测试只核合成扫描证据的SQL选取，不读取图片或宣称实际图像解码成功。
    coverEvidence: embedded ? [{ mime: 'image/png', bytes: 8, sha256: 'a'.repeat(64), evidence: 'encoded-bytes-magic-and-digest' }] : [],
    readEvidence: { bytesRead: 44, readCalls: 1, maxReadBytes: 44, allocationBytes: 44, elapsedMs: 1, wholeAudioHash: false, wholeAudioDecode: false } },
})

interface Frame { database: DatabaseSync; legacy: boolean; payloads: Map<string, string>; sql?: string; afterDrain?: () => void }
function instrumentation(t: test.TestContext) {
  const prepare = DatabaseSync.prototype.prepare, iterate = StatementSync.prototype.iterate, owners = new WeakMap<StatementSync, DatabaseSync>()
  let active: Frame | undefined
  const observedPrepare = function (this: DatabaseSync, sql: string) {
    let selected = sql
    if (active?.database === this && active.legacy && sql.includes('/* mb_album_compact_groups */')) {
      // 旧对照只撤回Compact选择段，facts、group、原Source与codec、MAT扫描事实和预算均沿当前真实工厂。
      selected = sql.replace(choices, windows)
        .replace('g.edition_id IS NULL AND c.physical_min=c.physical_max THEN c.physical_min', 'g.edition_id IS NULL AND p.physical_min=p.physical_max THEN p.physical_min')
        .replace(newJoin, oldJoin)
    }
    const statement = prepare.call(this, selected); owners.set(statement, this); return statement
  }
  Object.defineProperty(observedPrepare, 'length', { value: prepare.length })
  t.mock.method(DatabaseSync.prototype, 'prepare', observedPrepare)
  const observedIterate = function (this: StatementSync, ...bindings: unknown[]) {
    const iterator = Reflect.apply(iterate, this, bindings)
    const frame = active
    if (!frame || owners.get(this) !== frame.database || !this.sourceSQL.includes('/* mb_album_compact_groups */')) return iterator
    frame.sql = this.sourceSQL
    return (function* () {
      for (const row of iterator) {
        assert.equal(typeof row.payload, 'string')
        const raw = JSON.parse(String(row.payload)) as Record<string, unknown>, key = identity(String(raw.root_id), String(raw.album_key))
        assert.equal(frame.payloads.has(key), false, '每组必须只输出一个候选，不得因回联members重复')
        frame.payloads.set(key, String(row.payload)); yield row
      }
      frame.afterDrain?.()
    })()
  }
  Object.defineProperty(observedIterate, 'length', { value: iterate.length })
  t.mock.method(StatementSync.prototype, 'iterate', observedIterate)
  return {
    frame(database: DatabaseSync, legacy = false): Frame { return { database, legacy, payloads: new Map() } },
    run<T>(frame: Frame, operation: () => T): T {
      assert.equal(active, undefined); active = frame
      try { return operation() } finally { active = undefined }
    },
  }
}

async function fixture(t: test.TestContext) {
  const storage = buildStoragePolicy(), temporary = storage.check(process.env.TMPDIR!, { mustExist: true })
  const directory = await mkdtemp(path.join(temporary, 'mb-compact-choices-')); storage.check(directory, { mustExist: true })
  const repository = createCollectionRepository({ filePath: path.join(directory, 'collection.sqlite') }), datasetId = randomUUID()
  const roots: dto.LibraryRoot[] = [], cold = new Set<CollectionRepository>(); let sequence = 0
  t.after(async () => { for (const repo of cold) repo.close(); repository.close(); await rm(directory, { recursive: true, force: true }) })
  const state = (root: number, relative: string) => repository.localScan.privateFileState(roots[root]!.id, relative)!.value
  for (let index = 0; index < 2; index++) {
    const media = path.join(directory, `合成空来源${index}`); await mkdir(media)
    // 每个根只授权本测试新建空目录；不用正式来源，也不打开音频或封面。
    const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media))
    const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' }); roots.push(root)
    const started = repository.localScan.start({ commandId: randomUUID(), datasetId, libraryRootId: root.id, expectedRootRevision: root.revision, parserVersion: METADATA_PARSER_VERSION }).job
    let job = repository.localScan.resume({ commandId: randomUUID(), jobId: started.jobId, expectedRevision: started.jobRevision })
    const submit = (items: ScanPreparedItem[], cueItems?: dto.LocalCuePreparedItem[]) => {
      const batch: ScanPreparedBatch = { batchId: randomUUID(), jobId: job.jobId, expectedJobRevision: job.jobRevision, checkpointBefore: job.checkpointRef,
        items, frontier: [''], completed: false, ...(cueItems ? { kind: 'cue-sidecars-v1' as const, cueItems } : {}) }
      repository.localScan.privatePrepareBatch({ commandId: randomUUID(), jobId: job.jobId, batch })
      job = repository.localScan.privateCommitBatch({ commandId: randomUUID(), jobId: job.jobId, batchId: batch.batchId, expectedRevision: job.jobRevision })
    }
    // 故意按非歌曲顺序入库，避免min(rowid)/首个Map成员碰巧通过。
    const items = [audio('有图/03.wav', '有图专辑', 3), audio('有图/01.wav', '有图专辑', 1),
      audio('有图/04.wav', '有图专辑', 4, true), audio('有图/02.wav', '有图专辑', 2, true),
      audio('无图/02.wav', '无图专辑', 2), audio('无图/01.wav', '无图专辑', 1)]
    if (index === 0) items.push(audio('版次甲/01.wav', '原始版次标签', 1), audio('版次乙/02.wav', '原始版次标签', 2, true))
    submit(items)
    if (index === 0) {
      submit([{ relative: '仅拒收/坏.wav', signature: '合成拒收', parserVersion: METADATA_PARSER_VERSION,
        outcome: 'rejected', fields: null, failureCode: 'PARSE_FAILED', reused: false, readFacts: null }])
      submit([], [{ relative: '仅CUE/坏.cue', signature: '合成坏CUE', parserVersion: 'cue-text-75fps/mbrs003-v1',
        outcome: 'rejected', failureCode: 'CUE_PARSE_FAILED', reused: false, previousSnapshotId: null, result: null }])
    }
  }
  const edition = repository.localCatalog.createEdition({ commandId: randomUUID(), title: '跨目录版次', edition: '合成版' })
  repository.localCatalog.linkEditionTrack({ commandId: randomUUID(), editionId: edition.id, trackId: state(0, '版次甲/01.wav').trackId!, disc: 1, trackNumber: 1, sequence: 1 })
  const coveredLink = repository.localCatalog.linkEditionTrack({ commandId: randomUUID(), editionId: edition.id, trackId: state(0, '版次乙/02.wav').trackId!, disc: 1, trackNumber: 2, sequence: 2 })
  function clone(role: dto.LocalLibraryRole | null) {
    const filePath = path.join(directory, `cold-${++sequence}.sqlite`)
    repository.localCatalog.privateRead(db => db.prepare('VACUUM INTO ?').run(filePath))
    const repo = createCollectionRepository({ filePath }); cold.add(repo)
    const database = repo.localCatalog.privateRead(db => db)
    const views: dto.LocalRootView[] = repo.localCatalog.roots().map(root => ({ root, label: '合成扫描来源', availability: 'ONLINE' }))
    const scope: LocalAlbumSqlScope = { revision: `${repo.localCatalog.privateAlbumBrowserRevision()}:${repo.localScan.privateAlbumBrowserRevision()}`, roots: views,
      ...(role === null ? {} : { libraryOrganizations: views.map(({ root }) => ({ datasetId, rootId: root.id, sourceRootId: root.sourceRootId, rootRevision: root.revision,
        bindingRevision: 1, recordSha256: 'a'.repeat(64), role, rootName: '合成根', parentName: '合成来源' })) }) }
    return { repo, database, scope }
  }
  return { repository, roots, state, edition, coveredLink, clone }
}

function rawGroup(frame: Frame, album: dto.LocalAlbumSummary): Record<string, unknown> {
  const encoded = frame.payloads.get(identity(album.rootId, album.id)); assert.ok(encoded)
  return JSON.parse(encoded) as Record<string, unknown>
}

test('Compact选择：真实Repository多根/非首有图/全无图/跨目录edition/零成员与旧三窗口逐字节等价', async t => {
  const observed = instrumentation(t), f = await fixture(t)
  for (const role of [null, 'catalog'] as const) {
    const baseline = f.clone(role), current = f.clone(role), before = observed.frame(baseline.database, true), after = observed.frame(current.database)
    const oldPage = observed.run(before, () => baseline.repo.localCatalog.privateAlbumBrowserQuery(query(), baseline.scope))
    const page = observed.run(after, () => current.repo.localCatalog.privateAlbumBrowserQuery(query(), current.scope))
    assert.deepEqual(page, oldPage, '全部卡片/counts/revision/公开代表均保原结果')
    assert.deepEqual(after.payloads, before.payloads, '每组原JSON payload、physical_directory和三ID索引必须逐字节相同')
    assert.ok(before.sql?.includes('compact_members AS MATERIALIZED')); assert.ok(after.sql?.includes('compact_choices AS MATERIALIZED'))
    assert.equal(after.sql?.includes('artwork_rank'), false)
    for (const album of page.items) {
      assert.deepEqual(current.repo.localCatalog.privateAlbumBrowserArtwork(request(album), current.scope),
        baseline.repo.localCatalog.privateAlbumBrowserArtwork(request(album), baseline.scope))
      if (album.trackCount === 0) {
        assert.equal(rawGroup(after, album).artwork_index, null); assert.equal(rawGroup(after, album).physical_directory, null)
      }
    }
    assert.equal(page.items.filter(album => album.trackCount === 0).length, 2)
    for (const [index, root] of f.roots.entries()) {
      const covered = page.items.find(album => album.rootId === root.id && album.title === '有图专辑')!
      const empty = page.items.find(album => album.rootId === root.id && album.title === '无图专辑')!
      assert.equal(covered.representativeTrackId, f.state(index, '有图/01.wav').trackId, '公开代表仍按原歌曲sequence')
      assert.equal(current.repo.localCatalog.privateAlbumBrowserArtwork(request(covered), current.scope).representative!.summary.track.id,
        f.state(index, '有图/02.wav').trackId, '两个有图成员只取最小sequence，不能误取第一轨或入库首轨')
      assert.equal(current.repo.localCatalog.privateAlbumBrowserArtwork(request(empty), current.scope).representative!.summary.track.id,
        f.state(index, '无图/01.wav').trackId, '全无图回到全组最小sequence')
      assert.equal(rawGroup(after, covered).physical_directory, '有图')
    }
    const edition = page.items.find(album => album.editionId === f.edition.id)!
    assert.equal(edition.trackCount, 2); assert.equal(rawGroup(after, edition).distinct_tracks, 2)
    assert.equal(rawGroup(after, edition).physical_directory, null)
    assert.deepEqual(rawGroup(after, edition).artwork_index, { id: f.state(0, '版次乙/02.wav').trackId,
      asset_record_id: f.state(0, '版次乙/02.wav').assetId, relation_id: f.coveredLink.id })
  }
})

test('Compact选择：同轨重复活动关系仍由原summary闭集拒绝，新选择不能掩盖未知结果', async t => {
  const observed = instrumentation(t), f = await fixture(t)
  f.repository.localCatalog.linkEditionTrack({ commandId: randomUUID(), editionId: f.edition.id,
    trackId: f.state(0, '版次乙/02.wav').trackId!, disc: 1, trackNumber: 3, sequence: 3 })
  for (const legacy of [true, false]) {
    const cold = f.clone('catalog'), frame = observed.frame(cold.database, legacy)
    assert.throws(() => observed.run(frame, () => cold.repo.localCatalog.privateAlbumBrowserQuery(query(), cold.scope)), { code: 'UNAVAILABLE' })
  }
})

test('Compact选择：artist/album/container的原组织边界与目录min/max仍等于旧三窗口', async t => {
  const observed = instrumentation(t), f = await fixture(t)
  for (const role of ['artist', 'album', 'container'] as const) {
    const baseline = f.clone(role), current = f.clone(role), before = observed.frame(baseline.database, true), after = observed.frame(current.database)
    const expected = observed.run(before, () => baseline.repo.localCatalog.privateAlbumBrowserQuery(query(), baseline.scope))
    const page = observed.run(after, () => current.repo.localCatalog.privateAlbumBrowserQuery(query(), current.scope))
    assert.deepEqual(page, expected); assert.deepEqual(after.payloads, before.payloads)
    for (const album of page.items) assert.deepEqual(current.repo.localCatalog.privateAlbumBrowserArtwork(request(album), current.scope),
      baseline.repo.localCatalog.privateAlbumBrowserArtwork(request(album), baseline.scope))
  }
})

test('Compact选择：实际SQL产完后末屏障变化仍拒绝并清缓存，后次重新完整构建', async t => {
  const observed = instrumentation(t), f = await fixture(t), cold = f.clone('catalog')
  let revision = 'fixture-resource-one'
  const inventory = { revision: () => revision, read: () => 'unknown' as const }
  const scope: LocalAlbumSqlScope = { ...cold.scope, artworkInventory: inventory }, first = observed.frame(cold.database)
  first.afterDrain = () => { revision = 'fixture-resource-two' }
  assert.throws(() => observed.run(first, () => cold.repo.localCatalog.privateAlbumBrowserQuery(query(), scope)), { code: 'SNAPSHOT_CHANGED' })
  assert.ok(first.payloads.size > 0, '必须在实际SQL已产出完整结果后才触发原末屏障')
  const next = observed.frame(cold.database)
  const page = observed.run(next, () => cold.repo.localCatalog.privateAlbumBrowserQuery(query(), scope))
  assert.equal(next.payloads.size, page.total); assert.ok(next.sql?.includes('compact_choices AS MATERIALIZED'))
})
