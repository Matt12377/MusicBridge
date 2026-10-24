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
import { createLocalAlbumOwnerService } from '../../src/collection/local-album-browser/owner-port.js'
import { materializeLocalAlbumQueue } from '../../src/collection/mb-queue-materializer.js'
import { isLocalAlbumQueueSnapshot } from '../../src/collection/local-album-browser/owner-protocol.js'

const target = '目标😀', mainTitle = '目标专辑 [Remastered] [FLAC]'
const parent = (relative: string) => relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : ''
const query = (): dto.LocalAlbumQuery => ({ rootId: null, query: '', filter: 'all', offset: 0, limit: 200 })
const request = (album: dto.LocalAlbumSummary, offset = 0): dto.LocalAlbumTrackQuery => ({ rootId: album.rootId, albumKey: album.id, offset, limit: 2 })
const audio = (relative: string, album: string, number: number, embedded = false): ScanPreparedItem => ({
  relative, signature: `合成签名-${relative}`, parserVersion: METADATA_PARSER_VERSION, outcome: 'accepted',
  fields: { title: `原曲目${number}`, artist: '合成艺人', album, disc: '1', track: String(number) }, failureCode: null, reused: false,
  readFacts: { technical: { container: 'WAVE', codec: 'PCM', lossless: true, sampleRateHz: 48000, channels: 2, bitsPerSample: 16, durationSeconds: 10, evidence: 'bounded-parser-reported' },
    coverEvidence: embedded ? [{ mime: 'image/png', bytes: 8, sha256: 'a'.repeat(64), evidence: 'encoded-bytes-magic-and-digest' }] : [],
    readEvidence: { bytesRead: 44, readCalls: 1, maxReadBytes: 44, allocationBytes: 44, elapsedMs: 1, wholeAudioHash: false, wholeAudioDecode: false } },
})
const rejected = (relative: string): ScanPreparedItem => ({ relative, signature: `合成拒收-${relative}`, parserVersion: METADATA_PARSER_VERSION,
  outcome: 'rejected', fields: null, failureCode: 'PARSE_FAILED', reused: false, readFacts: null })
const membersCte = 'page_members AS MATERIALIZED(SELECT * FROM members WHERE album_key=@albumKey AND root_id=@rootId ORDER BY sequence LIMIT @limit OFFSET @offset)'
interface Frame {
  database: DatabaseSync; members: { sql: string; hintDirectory: string | null }[]
  scanReads: { rootId: string; relative: string }[]; locatorReads: number; assetReads: number; compactBuilds: number
  issueQueries: { sql: string; hintDirectory: string | null }[]; afterIssues?: () => void
  afterMembers?: () => void
}
/** 只包住实际SQLite调用；不替换SQL、UDF、codec、Source投影、返回行或原扫描解析器。 */
function instrumentation(t: test.TestContext) {
  const prepare = DatabaseSync.prototype.prepare, owners = new WeakMap<StatementSync, DatabaseSync>()
  let active: Frame | undefined
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
          frame.scanReads.push({ rootId: String(values[0]), relative: String(values[1]) })
          // 这些参数已由同一原SELECT完成LIMIT 2位置读和asset主键联接；统计事实读而非仅Node get。
          frame.locatorReads++
          if (typeof values[4] === 'string' && typeof values[5] === 'string') frame.assetReads++
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
      const isMembers = tracked && method === 'all' && this.sourceSQL.includes(membersCte)
      const isIssues = tracked && (this.sourceSQL.endsWith('SELECT * FROM groups WHERE album_key=@albumKey AND root_id=@rootId')
        || this.sourceSQL.includes('issues AS(SELECT p.album_key') || this.sourceSQL.includes('rejected_files AS(SELECT r.*'))
      if (tracked) {
        const text = this.sourceSQL.replace(/\s+/gu, ' ').trim()
        if (method === 'get' && text === 'SELECT * FROM local_scan_file_state WHERE library_root_id=? AND relative=?') {
          frame.scanReads.push({ rootId: String(bindings[0]), relative: String(bindings[1]) })
        }
        if (method === 'all' && text === 'SELECT id FROM local_catalog_assets WHERE root_id=? AND relative=? LIMIT 2') frame.locatorReads++
        if (method === 'get' && text === 'SELECT root_id,relative FROM local_catalog_assets WHERE id=?') frame.assetReads++
        if (method === 'iterate' && this.sourceSQL.includes('/* mb_album_compact_groups */')) frame.compactBuilds++
        if (isIssues) { const params = bindings[0] as Record<string, unknown>; frame.issueQueries.push({ sql: this.sourceSQL, hintDirectory: params.hintDirectory as string | null }) }
        if (isMembers) {
          const params = bindings[0] as Record<string, unknown>
          assert.ok(params && typeof params === 'object')
          assert.ok(params.hintDirectory === null || typeof params.hintDirectory === 'string')
          frame.members.push({ sql: this.sourceSQL, hintDirectory: params.hintDirectory as string | null })
        }
      }
      const result = Reflect.apply(original, this, bindings)
      // 真正.all完成后才撤销/改变作者；故不能靠SQL尚未开始的早拒绝通过末屏障测试。
      if (isMembers) frame!.afterMembers?.()
      if (isIssues && frame!.issueQueries.length === 5) frame!.afterIssues?.()
      return result
    }
    Object.defineProperty(observed, 'length', { value: original.length })
    t.mock.method(StatementSync.prototype, method, observed)
  }
  return {
    frame(database: DatabaseSync): Frame { return { database, members: [], issueQueries: [], scanReads: [], locatorReads: 0, assetReads: 0, compactBuilds: 0 } },
    run<T>(frame: Frame, action: () => T): T {
      assert.equal(active, undefined); active = frame
      try { return action() } finally { active = undefined }
    },
    async runAsync<T>(frame: Frame, action: () => Promise<T>): Promise<T> {
      assert.equal(active, undefined); active = frame
      try { return await action() } finally { active = undefined }
    },
  }
}
function assertScoped(frame: Frame, rootId: string) {
  assert.equal(frame.members.length, 1); assert.equal(frame.members[0]!.hintDirectory, target)
  assert.ok(frame.members[0]!.sql.includes('a.relative>=@hintPrefix AND a.relative<@hintUpper'))
  assert.equal(frame.compactBuilds, 0, '详情不得为缩读主动新建全库Compact')
  assert.ok(frame.scanReads.length > 0 && frame.locatorReads > 0 && frame.assetReads > 0, '必须经过实际Scan resolver的原位置/状态/资产SELECT')
  assert.ok(frame.scanReads.every(read => read.rootId === rootId && parent(read.relative) === target), '只读目标root的直属目录，不能含相似前缀、子目录或外根')
}
function assertFull(frame: Frame, rootId: string) {
  assert.equal(frame.members.length, 1); assert.equal(frame.members[0]!.hintDirectory, null)
  assert.ok(frame.members[0]!.sql.includes('(@hintDirectory IS NULL OR mb_album_parent(a.relative)=@hintDirectory)'))
  assert.ok(frame.scanReads.some(read => read.rootId === rootId && read.relative === '其它/01.wav'), '回退必须实际读取不相交目录，不能只改日志或SQL标记')
  assert.ok(frame.scanReads.every(read => read.rootId === rootId), '全根回退也不能越过请求root')
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

// 冷预期连接从不先queryAlbums/Artwork/Issues；详情必须实际走原全根CTE。
function members(cold: ReturnType<Awaited<ReturnType<typeof fixture>>['clone']>, album: dto.LocalAlbumSummary, offset = 0) {
  return cold.repo.localCatalog.privateAlbumBrowserMembers(request(album, offset), cold.scope)
}

test('详情目录：真实Source账本/Scan批下null与catalog同目录多专辑版本逐页等于独立冷全根，仅实读直属目录', async t => {
  const observed = instrumentation(t), f = await fixture(t)
  assert.equal(f.counts.sources, 2); assert.equal(f.counts.tracks, 15)
  assert.equal(f.counts.observations, 16); assert.equal(f.counts.observeReceipts, 16); assert.equal(f.counts.overrideReceipts, 1)
  assert.ok(f.counts.batches >= 6)
  for (const role of [null, 'catalog'] as const) {
    const albums = f.list(role), selected = albums.items.filter(album => album.rootId === f.roots[0]!.id
      && [mainTitle, '目标专辑 [SACD]', '同目录其它专辑'].includes(album.title))
    assert.equal(selected.length, 3, '同目录必须保留按原标题和版本分开的三个组')
    const cold = f.clone(role), warm = f.clone(role)
    const warmFrame = observed.frame(warm.database)
    assert.deepEqual(observed.run(warmFrame, () => warm.repo.localCatalog.privateAlbumBrowserQuery(query(), warm.scope)), albums)
    assert.equal(warmFrame.compactBuilds, 1)
    for (const album of selected) {
      for (const offset of album.title === mainTitle ? [0, 2, 4, 6] : [0, 2]) {
        const before = observed.frame(cold.database), after = observed.frame(warm.database)
        const expected = observed.run(before, () => members(cold, album, offset))
        assertFull(before, album.rootId)
        const actual = observed.run(after, () => members(warm, album, offset))
        assertScoped(after, album.rootId); assert.deepEqual(actual, expected, `role=${String(role)} title=${album.title} offset=${offset}`)
        assert.ok(after.scanReads.some(read => read.relative === `${target}/坏.wav`), '目录拒收也须实际重核，不只读当页或目标组曲目')
        assert.ok(actual.album.statuses.includes('parse-failed')); assert.equal(actual.total, album.trackCount)
        if (offset >= album.trackCount) { assert.deepEqual(actual.items, []); assert.equal(actual.hasMore, false) }
        if (album.title === mainTitle && offset === 0) {
          const first = actual.items.find(item => item.fact.summary.track.id === f.first.trackId)!
          assert.ok(first); assert.equal(first.fact.rawMetadata.title, '补充观察标题 [Live]')
          assert.equal(first.fact.summary.metadata.title, '人工覆盖标题')
          assert.ok(first.statuses.includes('cue-unsplit'), '真实同目录重复资产CUE保持原未拆轨状态')
        }
      }
    }
  }
})

test('详情目录：跨目录CUE两个方向与同目录陈旧实际引用均保原全根，结果不变', async t => {
  const observed = instrumentation(t)
  for (const mode of ['cross-in', 'cross-out', 'unknown'] as const) {
    const f = await fixture(t, mode), album = f.list().items.find(album => album.rootId === f.roots[0]!.id && album.title === mainTitle)!
    assert.ok(album)
    const cold = f.clone(), warm = f.clone(), before = observed.frame(cold.database)
    const expected = observed.run(before, () => members(cold, album)); assertFull(before, album.rootId)
    warm.repo.localCatalog.privateAlbumBrowserQuery(query(), warm.scope)
    const after = observed.frame(warm.database), actual = observed.run(after, () => members(warm, album))
    assertFull(after, album.rootId); assert.deepEqual(actual, expected, mode)
    if (mode === 'unknown') assert.equal(actual.directory, target, '同目录unknown不能靠directory不相等的别支拒绝碰巧通过')
  }
})

test('详情目录：跨目录edition、artist/album/container及零成员继续全根，不能缩掉关系或目录事件', async t => {
  const observed = instrumentation(t), f = await fixture(t)
  for (const mode of ['edition', 'artist', 'album', 'container', 'zero'] as const) {
    const role = mode === 'edition' || mode === 'zero' ? 'catalog' : mode
    const page = f.list(role), album = page.items.find(album => album.rootId === f.roots[0]!.id
      && (mode === 'edition' ? album.editionId === f.edition.id : mode === 'zero' ? album.trackCount === 0 : album.editionId === null && album.trackCount > 0))!
    assert.ok(album)
    const cold = f.clone(role), warm = f.clone(role), before = observed.frame(cold.database)
    const expected = observed.run(before, () => members(cold, album)); assertFull(before, album.rootId)
    warm.repo.localCatalog.privateAlbumBrowserQuery(query(), warm.scope)
    const after = observed.frame(warm.database), actual = observed.run(after, () => members(warm, album))
    assertFull(after, album.rootId); assert.deepEqual(actual, expected, mode)
    if (mode === 'edition') assert.equal(actual.total, 2)
    if (mode === 'zero') { assert.equal(actual.total, 0); assert.deepEqual(actual.items, []) }
  }
})

test('详情目录：未知实际物理写使暖Compact失效，即使数据内容相同也回原全根', async t => {
  const observed = instrumentation(t), f = await fixture(t)
  const album = f.list().items.find(album => album.rootId === f.roots[0]!.id && album.title === mainTitle)!
  const cold = f.clone(), warm = f.clone(), expected = observed.run(observed.frame(cold.database), () => members(cold, album))
  warm.repo.localCatalog.privateAlbumBrowserQuery(query(), warm.scope)
  const before = Number(warm.database.prepare('SELECT total_changes() n').get()!.n)
  warm.database.prepare('UPDATE local_scan_jobs SET data=data WHERE id=?').run(f.jobs[0]!.jobId)
  assert.equal(Number(warm.database.prepare('SELECT total_changes() n').get()!.n), before + 1)
  const frame = observed.frame(warm.database), actual = observed.run(frame, () => members(warm, album))
  assertFull(frame, album.rootId); assert.deepEqual(actual, expected)
})

test('详情目录：真实窄SQL返回后SAB撤销或库存代次改变，末屏障拒绝并清缓存；恢复须新闩与重建', async t => {
  const observed = instrumentation(t), f = await fixture(t)
  const album = f.list().items.find(album => album.rootId === f.roots[0]!.id && album.title === mainTitle)!
  for (const mode of ['SAB', '库存代次'] as const) {
    const revocation = createDatasetOwnerReadRevocation(); let revision = 'resource-1'
    const inventory = { revision: () => revision, read: () => 'unknown' as const }
    const options = { assertReadActive: revocation.assertActive, artworkInventory: inventory }
    const cold = f.clone('catalog', options), warm = f.clone('catalog', options)
    const expected = observed.run(observed.frame(cold.database), () => members(cold, album))
    warm.repo.localCatalog.privateAlbumBrowserQuery(query(), warm.scope)
    const failure = observed.frame(warm.database); let injected = 0
    failure.afterMembers = () => { injected++; if (mode === 'SAB') revocation.revoke(); else revision = 'resource-2' }
    assert.throws(() => observed.run(failure, () => members(warm, album)), { code: mode === 'SAB' ? 'UNAVAILABLE' : 'SNAPSHOT_CHANGED' })
    assert.equal(injected, 1); assertScoped(failure, album.rootId)
    if (mode === 'SAB') {
      assert.equal(Atomics.load(new Int32Array(revocation.buffer), 0), 1)
      assert.throws(() => members(warm, album), { code: 'UNAVAILABLE' })
    }
    const fresh = createDatasetOwnerReadRevocation(), next = { ...warm, scope: { ...warm.scope, assertReadActive: fresh.assertActive } }
    const rebuild = observed.frame(warm.database)
    observed.run(rebuild, () => next.repo.localCatalog.privateAlbumBrowserQuery(query(), next.scope))
    assert.equal(rebuild.compactBuilds, 1, '失败不能保留已核位置缓存或仅换scope后直接复用')
    const success = observed.frame(warm.database), actual = observed.run(success, () => members(next, album))
    assertScoped(success, album.rootId); assert.deepEqual(actual, expected)
    if (mode === 'SAB') assert.equal(Atomics.load(new Int32Array(revocation.buffer), 0), 1, '新读者不能复位旧闩')
  }
})


function issues(cold: ReturnType<Awaited<ReturnType<typeof fixture>>['clone']>, album: dto.LocalAlbumSummary, offset = 0) {
  return cold.repo.localCatalog.privateAlbumBrowserIssues(request(album, offset), cold.scope, { buildDerivedIndex: false })
}
function assertIssueReads(frame: Frame, rootId: string, scoped: boolean) {
  assert.equal(frame.issueQueries.length, 5, '原group/find、issues count/page与rejected count/page全部实读，不能删检查')
  assert.ok(frame.issueQueries.every(item => item.hintDirectory === (scoped ? target : null)))
  assert.equal(frame.compactBuilds, 0, 'issues和物化不得主动建立全库Compact或以新缓存替代本次原行核验')
  assert.ok(frame.scanReads.length > 0 && frame.locatorReads > 0 && frame.assetReads > 0)
  if (scoped) {
    assert.ok(frame.issueQueries.every(item => item.sql.includes('a.relative>=@hintPrefix AND a.relative<@hintUpper')))
    assert.ok(frame.scanReads.every(read => read.rootId === rootId && parent(read.relative) === target))
    assert.ok(frame.scanReads.some(read => read.relative === `${target}/坏.wav`), '同目录拒收原事实也必须核验')
  } else {
    assert.ok(frame.scanReads.some(read => read.rootId === rootId && read.relative === '其它/01.wav'))
    assert.ok(frame.scanReads.every(read => read.rootId === rootId))
  }
}

test('完整问题目录：真实Scan/CUE/覆盖/名称失败的全部issues和拒收逐页等于冷全根，暖后五条原SQL都只读同物理目录', async t => {
  const observed = instrumentation(t), f = await fixture(t)
  for (const role of [null, 'catalog'] as const) {
    const selected = f.list(role).items.filter(album => album.rootId === f.roots[0]!.id
      && [mainTitle, '目标专辑 [SACD]', '同目录其它专辑'].includes(album.title))
    assert.equal(selected.length, 3)
    const cold = f.clone(role), warm = f.clone(role)
    warm.repo.localCatalog.privateAlbumBrowserQuery(query(), warm.scope)
    for (const album of selected) for (const offset of [0, 2, 20]) {
      const before = observed.frame(cold.database), after = observed.frame(warm.database)
      const expected = observed.run(before, () => issues(cold, album, offset)); assertIssueReads(before, album.rootId, false)
      const actual = observed.run(after, () => issues(warm, album, offset)); assertIssueReads(after, album.rootId, true)
      assert.deepEqual(actual, expected)
      if (offset >= actual.total) assert.deepEqual(actual.items, [])
      if (offset >= actual.rejectedTotal) assert.deepEqual(actual.rejectedFiles, [])
    }
  }
})

test('完整问题目录：跨目录/陈旧CUE、edition、组织边界和零成员继续全根；未知写也不得借旧Compact', async t => {
  const observed = instrumentation(t)
  for (const mode of ['cross-in', 'cross-out', 'unknown', 'edition', 'artist', 'album', 'container', 'zero', 'write'] as const) {
    const f = await fixture(t, mode === 'cross-in' || mode === 'cross-out' || mode === 'unknown' ? mode : 'same')
    const role = mode === 'artist' || mode === 'album' || mode === 'container' ? mode : 'catalog'
    const selected = f.list(role).items.find(album => album.rootId === f.roots[0]!.id
      && (mode === 'edition' ? album.editionId === f.edition.id : mode === 'zero' ? album.trackCount === 0
        : ['artist', 'album', 'container'].includes(mode) ? album.editionId === null && album.trackCount > 0 : album.title === mainTitle))!
    assert.ok(selected)
    const cold = f.clone(role), warm = f.clone(role), expected = issues(cold, selected)
    warm.repo.localCatalog.privateAlbumBrowserQuery(query(), warm.scope)
    if (mode === 'write') warm.database.prepare('UPDATE local_scan_jobs SET data=data WHERE id=?').run(f.jobs[0]!.jobId)
    const frame = observed.frame(warm.database), actual = observed.run(frame, () => issues(warm, selected))
    assertIssueReads(frame, selected.rootId, false); assert.deepEqual(actual, expected, mode)
  }
})

test('完整问题目录：最后一条拒收原SQL返回后SAB撤销或库存换代，原run末屏障不得发布结果', async t => {
  const observed = instrumentation(t), f = await fixture(t), album = f.list().items.find(album => album.rootId === f.roots[0]!.id && album.title === mainTitle)!
  for (const mode of ['SAB', '库存代次'] as const) {
    const revocation = createDatasetOwnerReadRevocation(); let revision = 'resource-1'
    const warm = f.clone('catalog', { assertReadActive: revocation.assertActive, artworkInventory: { revision: () => revision, read: () => 'unknown' as const } })
    warm.repo.localCatalog.privateAlbumBrowserQuery(query(), warm.scope)
    const frame = observed.frame(warm.database); let injected = 0
    frame.afterIssues = () => { injected++; if (mode === 'SAB') revocation.revoke(); else revision = 'resource-2' }
    assert.throws(() => observed.run(frame, () => issues(warm, album)), { code: mode === 'SAB' ? 'UNAVAILABLE' : 'SNAPSHOT_CHANGED' })
    assertIssueReads(frame, album.rootId, true); assert.equal(injected, 1)
    if (mode === 'SAB') assert.equal(Atomics.load(new Int32Array(revocation.buffer), 0), 1)
  }
})

test('专辑队列物化：真实Owner.inspectAlbum保完整issues/拒收且五条SQL均缩读，全部逻辑曲目顺序等于独立冷捕获', async t => {
  const observed = instrumentation(t), f = await fixture(t), cold = f.clone(), warm = f.clone()
  const makeOwner = (copy: typeof warm) => {
    const owner = createLocalAlbumOwnerService({ repository: copy.repo, datasetId: f.datasetId, assertCurrent: () => {},
      readRootViews: async () => copy.scope.roots, readArtwork: async () => { throw new Error('队列物化不得读取封面或持有Source票据') },
      nameEnhancements: { revision: () => 'name-revision-1', read: () => copy.scope.nameEnhancements ?? [] },
      readLibraryOrganizations: () => copy.scope.libraryOrganizations ?? [] })
    t.after(() => owner.close()); return owner
  }
  const coldOwner = makeOwner(cold), owner = makeOwner(warm), page = await owner.queryAlbums(query())
  const album = page.items.find(album => album.rootId === f.roots[0]!.id && album.title === mainTitle)!
  assert.ok(album)
  const expected = await coldOwner.inspectAlbum({ albumKey: album.id, rootId: album.rootId, revision: album.revision })
  assert.ok(expected.issues.length > 0, '名称/CUE问题真实保留，不能用members-only伪装完整inspect')
  const selection: dto.LocalPlayRequest = { schema_version: '1.2', request_id: randomUUID(), route: 'roon_audio_input', source_kind: 'local_file',
    local_track_id: f.first.trackId!, asset_id: f.first.assetId!, expected_asset_revision: f.repository.localCatalog.asset(f.first.assetId!).fileRevision,
    target: { core_id: 'synthetic-core', zone_id: 'synthetic-zone' }, action: 'PLAY_NOW',
    album: { datasetId: f.datasetId, albumKey: album.id, rootId: album.rootId, revision: album.revision, kind: album.kind, editionId: album.editionId, trackCount: album.trackCount } }
  const frame = observed.frame(warm.database)
  const actual = await observed.runAsync(frame, () => materializeLocalAlbumQueue(warm.repo, owner, selection, f.datasetId, Date.now() + 2000, () => {}))
  assert.ok(isLocalAlbumQueueSnapshot(actual, selection)); assertScoped(frame, album.rootId); assertIssueReads(frame, album.rootId, true)
  assert.deepEqual(actual.sources.map(source => source.snapshot.trackId), expected.members.map(member => member.fact.summary.track.id))
  assert.equal(actual.startIndex, expected.members.findIndex(member => member.fact.summary.track.id === selection.local_track_id))
  assert.deepEqual(actual.album, selection.album); assert.equal(actual.edition, null)
})
