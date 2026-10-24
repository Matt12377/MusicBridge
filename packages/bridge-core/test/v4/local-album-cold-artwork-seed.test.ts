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
import { createDatasetOwnerReadRevocation } from '../../src/collection/dataset-owner-read-revocation.js'
import type { ScanPreparedBatch, ScanPreparedItem } from '../../src/collection/local-scan-store.js'
import type { LocalAlbumSqlScope } from '../../src/collection/local-album-browser/sql-types.js'

const target = '目标😀', mainTitle = '目标专辑 [Remastered] [FLAC]'
const parent = (relative: string) => relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : ''
const query = (): dto.LocalAlbumQuery => ({ rootId: null, query: '', filter: 'all', offset: 0, limit: 200 })
const artworkRequest = (album: dto.LocalAlbumSummary): dto.LocalAlbumArtworkRequest => ({ albumKey: album.id, rootId: album.rootId, editionId: album.editionId, representativeTrackId: album.representativeTrackId, revision: album.revision })
const audio = (relative: string, album: string, number: number, embedded = false): ScanPreparedItem => ({
  relative, signature: `合成签名-${relative}`, parserVersion: METADATA_PARSER_VERSION, outcome: 'accepted',
  fields: { title: `原曲目${number}`, artist: '合成艺人', album, disc: '1', track: String(number) }, failureCode: null, reused: false,
  readFacts: { technical: { container: 'WAVE', codec: 'PCM', lossless: true, sampleRateHz: 48000, channels: 2, bitsPerSample: 16, durationSeconds: 10, evidence: 'bounded-parser-reported' },
    coverEvidence: embedded ? [{ mime: 'image/png', bytes: 8, sha256: 'a'.repeat(64), evidence: 'encoded-bytes-magic-and-digest' }] : [],
    readEvidence: { bytesRead: 44, readCalls: 1, maxReadBytes: 44, allocationBytes: 44, elapsedMs: 1, wholeAudioHash: false, wholeAudioDecode: false } },
})
const rejected = (relative: string): ScanPreparedItem => ({ relative, signature: `合成拒收-${relative}`, parserVersion: METADATA_PARSER_VERSION,
  outcome: 'rejected', fields: null, failureCode: 'PARSE_FAILED', reused: false, readFacts: null })
interface Frame {
  database: DatabaseSync; compactBuilds: number
  artworks: { sql: string; hintDirectory: string | null }[]
  scanReads: { rootId: string; relative: string }[]
  artworkScanReads: { rootId: string; relative: string }[]
  afterArtwork?: () => void
}
/** 仅观察实际SQLite；原UDF、codec、Source账本、扫描定位和结果均不替换。 */
function instrumentation(t: test.TestContext) {
  const prepare = DatabaseSync.prototype.prepare, owners = new WeakMap<StatementSync, DatabaseSync>()
  let active: Frame | undefined, artworkDepth = 0
  const observedPrepare = function (this: DatabaseSync, sql: string) {
    const statement = prepare.call(this, sql); owners.set(statement, this); return statement
  }
  Object.defineProperty(observedPrepare, 'length', { value: prepare.length })
  t.mock.method(DatabaseSync.prototype, 'prepare', observedPrepare)
  const registerFunction = DatabaseSync.prototype.function
  const observedFunction = function (this: DatabaseSync, ...registration: unknown[]) {
    if (registration[0] === 'mb_album_scan_projected') {
      const database = this, action = registration[registration.length - 1]
      assert.equal(typeof action, 'function')
      const observedScan = function (this: unknown, ...values: unknown[]) {
        const frame = active
        if (frame?.database === database) {
          assert.equal(values.length, 6)
          assert.equal(typeof values[0], 'string'); assert.equal(typeof values[1], 'string')
          assert.ok(values[3] === 0 || values[3] === 1 || values[3] === 2)
          const selected = { rootId: String(values[0]), relative: String(values[1]) }
          frame.scanReads.push(selected); if (artworkDepth) frame.artworkScanReads.push(selected)
        }
        // 只观察实际UDF参数；原codec/guard/异常/结果与调用this均继续执行。
        return Reflect.apply(action as (...args: unknown[]) => unknown, this, values)
      }
      Object.defineProperty(observedScan, 'length', { value: (action as Function).length })
      registration[registration.length - 1] = observedScan
    }
    return Reflect.apply(registerFunction, this, registration)
  }
  Object.defineProperty(observedFunction, 'length', { value: registerFunction.length })
  t.mock.method(DatabaseSync.prototype, 'function', observedFunction)
  for (const method of ['get', 'all', 'iterate'] as const) {
    const original = StatementSync.prototype[method]
    const observed = function (this: StatementSync, ...bindings: unknown[]) {
      const frame = active, tracked = !!frame && owners.get(this) === frame.database
      const artwork = tracked && method === 'get' && this.sourceSQL.includes('ORDER BY has_artwork DESC,sequence LIMIT 1)')
      if (tracked) {
        if (method === 'iterate' && this.sourceSQL.includes('/* mb_album_compact_groups */')) frame.compactBuilds++
        if (method === 'get' && this.sourceSQL.replace(/\s+/gu, ' ').trim() === 'SELECT * FROM local_scan_file_state WHERE library_root_id=? AND relative=?') {
          const selected = { rootId: String(bindings[0]), relative: String(bindings[1]) }
          frame.scanReads.push(selected); if (artworkDepth) frame.artworkScanReads.push(selected)
        }
        if (artwork) frame.artworks.push({ sql: this.sourceSQL, hintDirectory: (bindings[0] as Record<string, unknown>).hintDirectory as string | null })
      }
      if (artwork) artworkDepth++
      let result: unknown
      try { result = Reflect.apply(original, this, bindings) } finally { if (artwork) artworkDepth-- }
      if (artwork) frame!.afterArtwork?.()
      return result
    }
    Object.defineProperty(observed, 'length', { value: original.length })
    t.mock.method(StatementSync.prototype, method, observed)
  }
  return {
    frame(database: DatabaseSync): Frame { return { database, compactBuilds: 0, artworks: [], scanReads: [], artworkScanReads: [] } },
    run<T>(frame: Frame, action: () => T): T {
      assert.equal(active, undefined); active = frame
      try { return action() } finally { active = undefined; artworkDepth = 0 }
    },
  }
}
function assertSeed(frame: Frame, rootId: string, directory: string) {
  assert.equal(frame.compactBuilds, 0, '冷单项不能先建整库Compact')
  assert.equal(frame.artworks.length, 1); assert.equal(frame.artworks[0]!.hintDirectory, directory)
  assert.ok(frame.artworks[0]!.sql.includes(directory === '' ? "instr(a.relative,'/')=0" : 'a.relative>=@hintPrefix AND a.relative<@hintUpper'))
  assert.ok(frame.artworkScanReads.length > 0, '窄SQL必须真实调用原Scan状态解析器')
  assert.ok(frame.artworkScanReads.every(item => item.rootId === rootId && parent(item.relative) === directory), '只重算目标根直属目录；完整CUE预核另行实读')
}

type CueMode = 'same' | 'cross-in' | 'cross-out' | 'unknown'
async function fixture(t: test.TestContext, cueMode: CueMode = 'same') {
  const storage = buildStoragePolicy(), temporary = storage.check(process.env.TMPDIR!, { mustExist: true })
  const directory = await mkdtemp(path.join(temporary, 'mb-members-directory-')); storage.check(directory, { mustExist: true })
  const repository = createCollectionRepository({ filePath: path.join(directory, 'collection.sqlite') }), datasetId = randomUUID()
  const roots: dto.LibraryRoot[] = [], jobs: dto.ScanJobRecord[] = [], copies = new Set<CollectionRepository>(); let sequence = 0
  t.after(async () => { for (const repo of copies) repo.close(); repository.close(); await rm(directory, { recursive: true, force: true }) })
  const state = (root: number, relative: string) => repository.localScan.privateFileState(roots[root]!.id, relative)!.value
  const submit = (root: number, items: ScanPreparedItem[], cueItems?: dto.LocalCuePreparedItem[]) => {
    const job = jobs[root]!
    const batch: ScanPreparedBatch = { batchId: randomUUID(), jobId: job.jobId, expectedJobRevision: job.jobRevision, checkpointBefore: job.checkpointRef,
      items, frontier: [''], completed: false, ...(cueItems ? { kind: 'cue-sidecars-v1' as const, cueItems } : {}) }
    repository.localScan.privatePrepareBatch({ commandId: randomUUID(), jobId: job.jobId, batch })
    jobs[root] = repository.localScan.privateCommitBatch({ commandId: randomUUID(), jobId: job.jobId, batchId: batch.batchId, expectedRevision: job.jobRevision })
  }
  for (let index = 0; index < 2; index++) {
    const media = path.join(directory, `合成空来源${index}`); await mkdir(media)
    // 唯一文件许可来自本测试新建空目录；批次只持久化合成事实，不读取音频或正式来源。
    const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media))
    const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' }); roots.push(root)
    const started = repository.localScan.start({ commandId: randomUUID(), datasetId, libraryRootId: root.id, expectedRootRevision: root.revision, parserVersion: METADATA_PARSER_VERSION }).job
    jobs.push(repository.localScan.resume({ commandId: randomUUID(), jobId: started.jobId, expectedRevision: started.jobRevision }))
    const items = index === 0 ? [audio(`${target}/03.wav`, mainTitle, 3), audio(`${target}/01.wav`, mainTitle, 1),
      audio(`${target}/05.wav`, mainTitle, 5), audio(`${target}/02.wav`, mainTitle, 2, true), audio(`${target}/04.wav`, mainTitle, 4),
      audio(`${target}/另版.wav`, '目标专辑 [SACD]', 9), audio(`${target}/其它标题.wav`, '同目录其它专辑', 8),
      audio(`${target}/子目录/01.wav`, '子目录', 1), audio(`${target}0/01.wav`, '同前缀兄弟', 1),
      audio(`${target}后缀/01.wav`, '同前缀后缀', 1), audio('其它/01.wav', '其它', 1),
      audio('版次甲/01.wav', '原版次标签', 1), audio('版次乙/02.wav', '原版次标签', 2)]
      : [audio(`${target}/01.wav`, mainTitle, 1), audio('外根/01.wav', '外根专辑', 1)]
    submit(index, items)
  }
  submit(0, [rejected(`${target}/坏.wav`), rejected('仅拒收/坏.wav')])
  const first = state(0, `${target}/01.wav`)
  repository.localCatalog.observeMetadata({ commandId: randomUUID(), trackId: first.trackId!, source: 'synthetic', parserVersion: '合成补充观察', fields: { title: '补充观察标题 [Live]' } })
  repository.localCatalog.overrideMetadata({ commandId: randomUUID(), trackId: first.trackId!, expectedRevision: null, fields: { title: '人工覆盖标题' } })
  const cue = (relative: string, audioRelative: string): dto.LocalCuePreparedItem => {
    const selected = state(0, audioRelative), locator = repository.localCatalog.privateAssetLocator(selected.assetId!), asset = locator.asset, root = roots[0]!
    return { relative, signature: `合成CUE-${relative}`, parserVersion: 'cue-text-75fps/mbrs003-v1', outcome: 'accepted', failureCode: null,
      reused: false, previousSnapshotId: null, result: { status: 'ok', tracks: [0, 1].map(index => ({ trackNumber: index + 1, fileOrdinal: 1,
        assetReference: { assetId: asset.id, libraryRootId: root.id, sourceRootId: root.sourceRootId, rootRevision: root.revision,
          fileRevision: asset.fileRevision, locationRevision: asset.locationRevision, relative: locator.relative, signature: selected.signature },
        timebase: 'cue-cd-frames', framesPerSecond: 75, index00Frames: null, index01Frames: index * 75, endFrames: null,
        evidence: 'cue-text-declared', playback: 'NOT_VERIFIED' })) } }
  }
  submit(0, [], [])
  submit(0, [], [cue(cueMode === 'cross-in' ? '侧车/跨目录.cue' : `${target}/disc.cue`, cueMode === 'cross-out' ? '其它/01.wav' : `${target}/01.wav`)])
  submit(0, [], [{ relative: '零成员/坏.cue', signature: '合成坏CUE', parserVersion: 'cue-text-75fps/mbrs003-v1', outcome: 'rejected',
    failureCode: 'CUE_PARSE_FAILED', reused: false, previousSnapshotId: null, result: null }])
  if (cueMode === 'unknown') {
    // 通过原目录命令在同一物理目录移动资产：CUE旧locationRevision不再当前。
    // directory仍等于physical_directory，必须由真实引用闭包的unknown判据阻止缩读。
    const asset = repository.localCatalog.asset(first.assetId!)
    repository.localCatalog.moveAsset({ commandId: randomUUID(), assetId: asset.id, expectedLocationRevision: asset.locationRevision,
      expectedRootRevision: roots[0]!.revision, relative: `${target}/移位.wav` })
  }
  const edition = repository.localCatalog.createEdition({ commandId: randomUUID(), title: '跨目录版次', edition: '合成版' })
  for (const [index, relative] of ['版次甲/01.wav', '版次乙/02.wav'].entries()) repository.localCatalog.linkEditionTrack({
    commandId: randomUUID(), editionId: edition.id, trackId: state(0, relative).trackId!, disc: 1, trackNumber: index + 1, sequence: index + 1,
  })
  function scopeFor(repo: CollectionRepository, role: dto.LocalLibraryRole | null): LocalAlbumSqlScope {
    const views: dto.LocalRootView[] = repo.localCatalog.roots().map(root => ({ root, label: '合成扫描来源', availability: 'ONLINE' }))
    return { revision: `${repo.localCatalog.privateAlbumBrowserRevision()}:${repo.localScan.privateAlbumBrowserRevision()}`, roots: views,
      nameEnhancements: [{ rootId: roots[0]!.id, directory: target, revision: 'fixture-name-1', state: 'failed' }],
      ...(role === null ? {} : { libraryOrganizations: views.map(({ root }) => ({ datasetId, rootId: root.id, sourceRootId: root.sourceRootId,
        rootRevision: root.revision, bindingRevision: 1, recordSha256: 'a'.repeat(64), role, rootName: '合成根', parentName: '合成来源' })) }) }
  }
  function clone(role: dto.LocalLibraryRole | null = 'catalog', options: Pick<LocalAlbumSqlScope, 'assertReadActive' | 'artworkInventory'> = {}) {
    const filePath = path.join(directory, `cold-${++sequence}.sqlite`)
    repository.localCatalog.privateRead(db => db.prepare('VACUUM INTO ?').run(filePath))
    const repo = createCollectionRepository({ filePath }); copies.add(repo)
    // 真实冷工厂先完成原账本/扫描核验；没有共享原连接的Compact、Derived或目录提示。
    const database = repo.localCatalog.privateRead(db => db), scope = { ...scopeFor(repo, role), ...options }
    return { repo, database, scope }
  }
  const list = (role: dto.LocalLibraryRole | null = 'catalog') => repository.localCatalog.privateAlbumBrowserQuery(query(), scopeFor(repository, role))
  const counts = repository.localCatalog.privateRead(db => ({
    sources: Number(db.prepare('SELECT count(*) n FROM source_ledger').get()!.n),
    tracks: Number(db.prepare('SELECT count(*) n FROM local_catalog_tracks').get()!.n),
    observations: Number(db.prepare('SELECT count(*) n FROM local_catalog_observations').get()!.n),
    observeReceipts: Number(db.prepare("SELECT count(*) n FROM local_catalog_ledger WHERE operation='observe-metadata'").get()!.n),
    overrideReceipts: Number(db.prepare("SELECT count(*) n FROM local_catalog_ledger WHERE operation='override-metadata'").get()!.n),
    batches: Number(db.prepare("SELECT count(*) n FROM local_scan_batches WHERE phase='committed'").get()!.n),
  }))
  return { repository, datasetId, roots, jobs, first, edition, clone, list, counts }
}

// 预期连接先从原全根SQL建立完整Compact；待测连接从未读公开页、成员、问题或封面。
function expectedContext(f: Awaited<ReturnType<typeof fixture>>, role: dto.LocalLibraryRole | null, album: dto.LocalAlbumSummary, observed: ReturnType<typeof instrumentation>) {
  const full = f.clone(role), frame = observed.frame(full.database)
  observed.run(frame, () => full.repo.localCatalog.privateAlbumBrowserQuery(query(), full.scope))
  assert.equal(frame.compactBuilds, 1)
  assert.ok(frame.scanReads.some(item => item.relative === '其它/01.wav'), '预期必须实际完整读取页外目录')
  return full.repo.localCatalog.privateAlbumBrowserArtwork(artworkRequest(album), full.scope)
}

test('冷封面seed：真实Source/Scan、同目录多标签版本及根目录组均等于独立全根，不建Compact；非首曲内嵌图仍正确选取', async t => {
  const observed = instrumentation(t), f = await fixture(t)
  const job = f.jobs[0]!, batch: ScanPreparedBatch = { batchId: randomUUID(), jobId: job.jobId, expectedJobRevision: job.jobRevision,
    checkpointBefore: job.checkpointRef, items: [audio('根曲甲.wav', '根标签甲', 1), audio('根曲乙.wav', '根标签乙', 2)], frontier: [''], completed: false }
  f.repository.localScan.privatePrepareBatch({ commandId: randomUUID(), jobId: job.jobId, batch })
  f.jobs[0] = f.repository.localScan.privateCommitBatch({ commandId: randomUUID(), jobId: job.jobId, batchId: batch.batchId, expectedRevision: job.jobRevision })
  for (const role of [null, 'catalog'] as const) {
    const selected = f.list(role).items.filter(album => [mainTitle, '目标专辑 [SACD]', '同目录其它专辑', '散落音频'].includes(album.title))
    assert.equal(selected.length, 5, '三组同目录、一组外根同名和一组根目录都须覆盖')
    for (const album of selected) {
      const expected = expectedContext(f, role, album, observed), cold = f.clone(role), frame = observed.frame(cold.database)
      const stamp = cold.repo.readonlySnapshotStamp()
      const actual = observed.run(frame, () => cold.repo.localCatalog.privateAlbumBrowserArtwork(artworkRequest(album), cold.scope))
      assert.deepEqual(actual, expected); assertSeed(frame, album.rootId, album.title === '散落音频' ? '' : target)
      assert.deepEqual(cold.repo.readonlySnapshotStamp(), stamp, 'seed与原目录重算只能读取原库')
      if (album.rootId === f.roots[0]!.id && album.title === mainTitle) {
        assert.equal(actual.representative!.relative, `${target}/02.wav`)
        assert.notEqual(actual.representative!.summary.track.id, album.representativeTrackId, '展示图源不能被seed的代表曲目替代')
        assert.ok(actual.album.statuses.includes('parse-failed')); assert.ok(actual.album.statuses.includes('cue-unsplit'))
        assert.ok(frame.artworkScanReads.some(item => item.relative === `${target}/坏.wav`), '同目录拒收与名称/CUE事件仍进原修订')
      }
      const again = observed.frame(cold.database)
      assert.deepEqual(observed.run(again, () => cold.repo.localCatalog.privateAlbumBrowserArtwork(artworkRequest(album), cold.scope)), expected)
      assertSeed(again, album.rootId, album.title === '散落音频' ? '' : target)
    }
  }
})

test('冷封面seed边界：跨入/跨出/陈旧CUE、edition、artist/album/container及零成员保持完整全根回退', async t => {
  const observed = instrumentation(t)
  for (const mode of ['cross-in', 'cross-out', 'unknown', 'edition', 'artist', 'album', 'container', 'zero'] as const) {
    const f = await fixture(t, mode === 'cross-in' || mode === 'cross-out' || mode === 'unknown' ? mode : 'same')
    const role = mode === 'artist' || mode === 'album' || mode === 'container' ? mode : 'catalog'
    const album = f.list(role).items.find(album => album.rootId === f.roots[0]!.id
      && (mode === 'edition' ? album.editionId === f.edition.id : mode === 'zero' ? album.trackCount === 0
        : ['artist', 'album', 'container'].includes(mode) ? album.editionId === null && album.trackCount > 0 : album.title === mainTitle))!
    assert.ok(album)
    const expected = expectedContext(f, role, album, observed), cold = f.clone(role), frame = observed.frame(cold.database)
    const actual = observed.run(frame, () => cold.repo.localCatalog.privateAlbumBrowserArtwork(artworkRequest(album), cold.scope))
    assert.deepEqual(actual, expected, mode); assert.equal(frame.compactBuilds, 1, mode)
    assert.deepEqual(frame.artworks, [], '不合资格不能偷偷缩掉跨目录关系或事件')
    assert.ok(frame.scanReads.some(item => item.rootId === album.rootId && item.relative === '其它/01.wav'))
  }
})

test('冷封面seed不信请求：五元组错配、外根或非代表成员均拒绝；实际当前组重算后才可返回', async t => {
  const observed = instrumentation(t), f = await fixture(t)
  const album = f.list().items.find(album => album.rootId === f.roots[0]!.id && album.title === mainTitle)!
  const expected = expectedContext(f, 'catalog', album, observed), value = artworkRequest(album)
  const wrong: dto.LocalAlbumArtworkRequest[] = [
    { ...value, albumKey: `directory-${'b'.repeat(64)}` }, { ...value, rootId: f.roots[1]!.id },
    { ...value, editionId: f.edition.id }, { ...value, representativeTrackId: expected.representative!.summary.track.id },
    { ...value, revision: 'f'.repeat(64) },
  ]
  for (const request of wrong) {
    const cold = f.clone(), frame = observed.frame(cold.database)
    assert.throws(() => observed.run(frame, () => cold.repo.localCatalog.privateAlbumBrowserArtwork(request, cold.scope)), { code: 'SNAPSHOT_CHANGED' })
    const current = observed.frame(cold.database)
    assert.deepEqual(observed.run(current, () => cold.repo.localCatalog.privateAlbumBrowserArtwork(value, cold.scope)), expected)
    // 错请求的完整冷集合可以沿原拒绝末屏障保留；没有完整集合时仍须实际重算当前目录。
    if (!frame.compactBuilds) assertSeed(current, album.rootId, target)
  }
})

test('冷封面seed末屏障：实际目录SQL完成后SAB撤销或库存作者变化不得发布，后续仍重新实读', async t => {
  const observed = instrumentation(t), f = await fixture(t)
  const album = f.list().items.find(album => album.rootId === f.roots[0]!.id && album.title === mainTitle)!
  const expected = expectedContext(f, 'catalog', album, observed)
  for (const mode of ['SAB', '库存作者'] as const) {
    const revocation = createDatasetOwnerReadRevocation(); let revision = 'inventory-one'
    const inventory = { revision: () => revision, read: () => 'unknown' as const }
    const cold = f.clone('catalog', { assertReadActive: revocation.assertActive, artworkInventory: inventory }), frame = observed.frame(cold.database)
    let injected = 0
    frame.afterArtwork = () => { injected++; if (mode === 'SAB') revocation.revoke(); else revision = 'inventory-two' }
    assert.throws(() => observed.run(frame, () => cold.repo.localCatalog.privateAlbumBrowserArtwork(artworkRequest(album), cold.scope)),
      { code: mode === 'SAB' ? 'UNAVAILABLE' : 'SNAPSHOT_CHANGED' })
    assert.equal(injected, 1); assertSeed(frame, album.rootId, target)
    const next = { ...cold.scope, assertReadActive: createDatasetOwnerReadRevocation().assertActive }, recovered = observed.frame(cold.database)
    assert.deepEqual(observed.run(recovered, () => cold.repo.localCatalog.privateAlbumBrowserArtwork(artworkRequest(album), next)), expected)
    assertSeed(recovered, album.rootId, target)
    if (mode === 'SAB') assert.equal(Atomics.load(new Int32Array(revocation.buffer), 0), 1)
  }
})
