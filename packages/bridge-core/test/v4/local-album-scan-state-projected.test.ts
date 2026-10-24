import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync, StatementSync } from 'node:sqlite'
import * as dto from '@music-bridge/contracts'
import { buildStoragePolicy } from '../../../../apps/desktop/scripts/build-storage-root.mjs'
import { createCollectionRepository, type CollectionRepository } from '../../src/collection/repository.js'
import { authorizeSourceDirectory } from '../../src/recording/source-files.js'
import { METADATA_PARSER_VERSION } from '../../src/library/metadata-reader-types.js'
import { readLocalAlbumScanState, readLocalAlbumScanStateProjected, type ScanPreparedBatch, type ScanPreparedItem, type ScanFileState } from '../../src/collection/local-scan-store.js'
import type { LocalAlbumSqlScope } from '../../src/collection/local-album-browser/sql-types.js'

// 对照只撤回本轮固定投影子查询；仍执行真实工厂的原resolver及全部SELECT/guard。
const projectedScanSql = /\(SELECT mb_album_scan_projected\(([^,]+),([^,]+),[\s\S]*?END\)/gu
const query = (rootId: string | null = null): dto.LocalAlbumQuery => ({ rootId, query: '', filter: 'all', offset: 0, limit: 200 })
const artworkRequest = (album: dto.LocalAlbumSummary): dto.LocalAlbumArtworkRequest => ({ albumKey: album.id, rootId: album.rootId,
  editionId: album.editionId, representativeTrackId: album.representativeTrackId, revision: album.revision })
const accepted = (relative: string): ScanPreparedItem => ({ relative, signature: `合成签名-${relative}`, parserVersion: METADATA_PARSER_VERSION,
  outcome: 'accepted', fields: { title: path.posix.basename(relative), artist: '合成艺人', album: relative.split('/')[0]!, track: '1' },
  failureCode: null, reused: false, readFacts: {
    technical: { container: 'WAVE', codec: 'PCM', lossless: true, sampleRateHz: 48000, channels: 2, bitsPerSample: 16, durationSeconds: 10, evidence: 'bounded-parser-reported' },
    coverEvidence: [], readEvidence: { bytesRead: 44, readCalls: 1, maxReadBytes: 44, allocationBytes: 44, elapsedMs: 1, wholeAudioHash: false, wholeAudioDecode: false },
  } })
const rejected = (relative: string): ScanPreparedItem => ({ relative, signature: `合成拒收-${relative}`, parserVersion: METADATA_PARSER_VERSION,
  outcome: 'rejected', fields: null, failureCode: 'PARSE_FAILED', reused: false, readFacts: null })

interface Counters { locatorSelects: number; stateSelects: number; currentAssetSelects: number; stateParses: number }
interface CapturedQuery { sql: string; bindings: unknown[] }
interface Frame {
  database: DatabaseSync; legacy: boolean; rawStates: ReadonlySet<string>; counters: Counters; compact?: CapturedQuery
  afterStateRead?: () => void
}

function instrumentation(t: test.TestContext) {
  const owners = new WeakMap<StatementSync, DatabaseSync>(), prepare = DatabaseSync.prototype.prepare, parse = JSON.parse
  let active: Frame | undefined
  const observedPrepare = function (this: DatabaseSync, sql: string) {
    // 对照组仅撤回本次表达式变更；同一真实工厂、投影、codec、主表和账本仍实际执行。
    const selected = active?.database === this && active.legacy ? sql.replace(projectedScanSql, (_text, root: string, relative: string) => `mb_album_scan(${root},${relative})`) : sql
    const statement = prepare.call(this, selected); owners.set(statement, this); return statement
  }
  Object.defineProperty(observedPrepare, 'length', { value: prepare.length })
  t.mock.method(DatabaseSync.prototype, 'prepare', observedPrepare)
  for (const method of ['get', 'all', 'iterate'] as const) {
    const original = StatementSync.prototype[method]
    const observed = function (this: StatementSync, ...bindings: unknown[]) {
      const frame = active, tracked = !!frame && owners.get(this) === frame.database
      if (tracked) {
        const text = this.sourceSQL.replace(/\s+/gu, ' ').trim()
        if (text === 'SELECT id FROM local_catalog_assets WHERE root_id=? AND relative=? LIMIT 2') frame.counters.locatorSelects++
        if (text === 'SELECT * FROM local_scan_file_state WHERE library_root_id=? AND relative=?') frame.counters.stateSelects++
        if (text === 'SELECT root_id,relative FROM local_catalog_assets WHERE id=?') frame.counters.currentAssetSelects++
        if (method === 'iterate' && this.sourceSQL.includes('/* mb_album_compact_groups */')) {
          frame.compact = { sql: this.sourceSQL, bindings: bindings.map(value => structuredClone(value)) }
        }
      }
      const result = Reflect.apply(original, this, bindings)
      return result
    }
    Object.defineProperty(observed, 'length', { value: original.length })
    t.mock.method(StatementSync.prototype, method, observed)
  }
  const observedParse = function (text: string, ...rest: unknown[]) {
    const matched = !!active?.rawStates.has(text)
    if (matched) active!.counters.stateParses++
    const value = Reflect.apply(parse, JSON, [text, ...rest])
    if (matched) active?.afterStateRead?.()
    return value
  }
  Object.defineProperty(observedParse, 'length', { value: parse.length })
  t.mock.method(JSON, 'parse', observedParse)
  return {
    frame(database: DatabaseSync, rawStates: ReadonlySet<string>, legacy = false): Frame {
      return { database, legacy, rawStates, counters: { locatorSelects: 0, stateSelects: 0, currentAssetSelects: 0, stateParses: 0 } }
    },
    run<T>(frame: Frame, operation: () => T): { value: T; elapsedMs: number } {
      assert.equal(active, undefined); active = frame
      const started = performance.now()
      try { return { value: operation(), elapsedMs: performance.now() - started } } finally { active = undefined }
    },
  }
}

async function fixture(t: test.TestContext) {
  const storage = buildStoragePolicy(), temporary = storage.check(process.env.TMPDIR!, { mustExist: true })
  const directory = await mkdtemp(path.join(temporary, 'mb-scan-state-projected-')); storage.check(directory, { mustExist: true })
  const media = path.join(directory, '合成空来源'); await mkdir(media)
  // Source许可只来自本测试新建空目录；可信批仅写合成目录事实，不读取音频/NAS或运行Reader。
  const repository = createCollectionRepository({ filePath: path.join(directory, 'collection.sqlite') })
  const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media))
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' }), datasetId = randomUUID()
  const started = repository.localScan.start({ commandId: randomUUID(), datasetId, libraryRootId: root.id, expectedRootRevision: root.revision, parserVersion: METADATA_PARSER_VERSION }).job
  let job = repository.localScan.resume({ commandId: randomUUID(), jobId: started.jobId, expectedRevision: started.jobRevision }), sequence = 0
  const cold = new Set<CollectionRepository>()
  t.after(async () => { for (const repo of cold) repo.close(); repository.close(); await rm(directory, { recursive: true, force: true }) })
  function submit(items: ScanPreparedItem[], cueItems?: dto.LocalCuePreparedItem[]) {
    const batch: ScanPreparedBatch = { batchId: randomUUID(), jobId: job.jobId, expectedJobRevision: job.jobRevision, checkpointBefore: job.checkpointRef,
      items, frontier: [''], completed: false, ...(cueItems ? { kind: 'cue-sidecars-v1' as const, cueItems } : {}) }
    repository.localScan.privatePrepareBatch({ commandId: randomUUID(), jobId: job.jobId, batch })
    job = repository.localScan.privateCommitBatch({ commandId: randomUUID(), jobId: job.jobId, batchId: batch.batchId, expectedRevision: job.jobRevision })
  }
  for (let batch = 0; batch < 6; batch++) submit(Array.from({ length: 16 }, (_, index) => accepted(`目录${index % 3}/批${batch}-曲${index}.wav`)))
  submit([rejected('仅拒收/损坏.wav'), rejected('目录0/损坏.wav')])
  const first = repository.localScan.privateFileState(root.id, '目录0/批0-曲0.wav')!.value
  repository.localCatalog.observeMetadata({ commandId: randomUUID(), trackId: first.trackId!, source: 'synthetic', parserVersion: '合成补充观察', fields: { title: '新观察标题' } })
  repository.localCatalog.overrideMetadata({ commandId: randomUUID(), trackId: first.trackId!, expectedRevision: null, fields: { title: '人工覆盖标题' } })
  submit([], [])
  function cue(relative: string, audio: string): dto.LocalCuePreparedItem {
    const state = repository.localScan.privateFileState(root.id, audio)!.value, locator = repository.localCatalog.privateAssetLocator(state.assetId!), asset = locator.asset
    return { relative, signature: `合成CUE-${relative}`, parserVersion: 'cue-text-75fps/mbrs003-v1', outcome: 'accepted', failureCode: null,
      reused: false, previousSnapshotId: null, result: { status: 'ok', tracks: [0, 1].map(index => ({ trackNumber: index + 1, fileOrdinal: 1,
        assetReference: { assetId: asset.id, libraryRootId: root.id, sourceRootId: source.id, rootRevision: root.revision, fileRevision: asset.fileRevision,
          locationRevision: asset.locationRevision, relative: locator.relative, signature: state.signature },
        timebase: 'cue-cd-frames', framesPerSecond: 75, index00Frames: null, index01Frames: index * 75, endFrames: null,
        evidence: 'cue-text-declared', playback: 'NOT_VERIFIED' })) } }
  }
  submit([], [cue('目录1/同目录.cue', '目录1/批0-曲1.wav')])
  submit([], [cue('侧车/跨目录.cue', '目录2/批0-曲2.wav')])
  submit([], [{ relative: '零成员/坏.cue', signature: '合成坏CUE', parserVersion: 'cue-text-75fps/mbrs003-v1', outcome: 'rejected', failureCode: 'CUE_PARSE_FAILED', reused: false, previousSnapshotId: null, result: null }])
  function clone(role: dto.LocalLibraryRole | null = 'catalog') {
    const filePath = path.join(directory, `cold-${++sequence}.sqlite`)
    repository.localCatalog.privateRead(db => db.prepare('VACUUM INTO ?').run(filePath))
    const repo = createCollectionRepository({ filePath }); cold.add(repo)
    // 先完整冷核真实工厂，再开启计数；不能把验证整库的解析量算进查询改善。
    const database = repo.localCatalog.privateRead(db => db)
    const roots: dto.LocalRootView[] = repo.localCatalog.roots().map(value => ({ root: value, label: '合成扫描来源', availability: 'ONLINE' }))
    const scope: LocalAlbumSqlScope = { revision: `${repo.localCatalog.privateAlbumBrowserRevision()}:${repo.localScan.privateAlbumBrowserRevision()}`, roots,
      ...(role === null ? {} : { libraryOrganizations: [{ datasetId, rootId: root.id, sourceRootId: source.id, rootRevision: root.revision,
        bindingRevision: 1, recordSha256: 'a'.repeat(64), role, rootName: '合成根', parentName: '合成来源' }] }) }
    const rawStates = new Set(repo.localCatalog.privateRead(db => db.prepare('SELECT data FROM local_scan_file_state').all().map(row => String(row.data))))
    return { repo, database, scope, rawStates }
  }
  return { repository, root, source, clone, submit }
}

function explain(cold: ReturnType<Awaited<ReturnType<typeof fixture>>['clone']>, captured: CapturedQuery) {
  return cold.repo.localCatalog.privateRead(db => {
    const statement = db.prepare(`EXPLAIN QUERY PLAN ${captured.sql}`)
    statement.setAllowUnknownNamedParameters(true)
    return Reflect.apply(statement.all, statement, captured.bindings) as Record<string, unknown>[]
  })
}
function assertProjectedIndexes(plan: readonly Record<string, unknown>[]) {
  for (const alias of ['scan_projection_state', 'scan_projection_locator', 'scan_projection_asset']) {
    assert.ok(plan.some(row => String(row.detail).includes(`SEARCH ${alias} `) && /USING.*INDEX/u.test(String(row.detail))),
      `${alias}必须使用原索引逐项实读，不能每曲全表扫描`)
    assert.equal(plan.some(row => String(row.detail).startsWith(`SCAN ${alias}`)), false)
  }
}

test('扫描状态SQL投影：真实96曲/ledger/CUE下完整卡片、counts及修订等于原resolver，嵌套JS SELECT减少', async t => {
  const observed = instrumentation(t), f = await fixture(t)
  const actual = f.repository.localCatalog.privateRead(db => ({
    observations: Number(db.prepare('SELECT count(*) n FROM local_catalog_observations').get()!.n),
    receipts: Number(db.prepare("SELECT count(*) n FROM local_catalog_ledger WHERE operation='observe-metadata'").get()!.n),
  }))
  assert.equal(actual.observations, 97); assert.equal(actual.receipts, 97)
  for (const role of [null, 'catalog'] as const) {
    const baseline = f.clone(role), current = f.clone(role)
    const beforeFrame = observed.frame(baseline.database, baseline.rawStates, true), afterFrame = observed.frame(current.database, current.rawStates)
    const before = observed.run(beforeFrame, () => baseline.repo.localCatalog.privateAlbumBrowserQuery(query(), baseline.scope))
    const after = observed.run(afterFrame, () => current.repo.localCatalog.privateAlbumBrowserQuery(query(), current.scope))
    assert.deepEqual(after.value, before.value, '卡片、所有counts、原修订和代表成员必须完全相同')
    assert.ok(after.value.items.some(album => album.trackCount === 0 && album.statuses.includes('metadata-issue')))
    assert.ok(after.value.items.some(album => album.trackCount === 0 && album.statuses.includes('cue-unsplit')))
    assert.ok(afterFrame.counters.stateSelects < beforeFrame.counters.stateSelects)
    assert.equal(afterFrame.counters.stateParses, beforeFrame.counters.stateParses, '只省去跨JS查询，不能省略原状态闭集/字节校验')
    assert.ok(beforeFrame.counters.stateSelects >= 96)
    assert.ok(afterFrame.counters.stateSelects <= 4, '只有原CUE核验仍允许原scanState嵌套点读')
    assert.ok(afterFrame.compact?.sql.includes('mb_album_scan_projected('))
    assert.equal(beforeFrame.compact?.sql.includes('mb_album_scan_projected('), false, '旧对照必须实际撤回投影快路')
    assert.ok(afterFrame.counters.locatorSelects < beforeFrame.counters.locatorSelects)
    assert.ok(afterFrame.counters.currentAssetSelects < beforeFrame.counters.currentAssetSelects)
    assert.ok(afterFrame.compact); assertProjectedIndexes(explain(current, afterFrame.compact))
    for (const album of after.value.items) {
      const expected = baseline.repo.localCatalog.privateAlbumBrowserArtwork(artworkRequest(album), baseline.scope)
      const result = current.repo.localCatalog.privateAlbumBrowserArtwork(artworkRequest(album), current.scope)
      assert.deepEqual(result, expected, '同目录及跨目录CUE、零成员和人工覆盖不改变当前图源或原字段')
    }
    t.diagnostic(JSON.stringify({ role, before: { ...beforeFrame.counters, elapsedMs: before.elapsedMs }, after: { ...afterFrame.counters, elapsedMs: after.elapsedMs } }))
  }
})

test('扫描状态SQL投影：真实move后asset-only回退、旧位置null及无扫描新曲仍等于原resolver', async t => {
  const observed = instrumentation(t), f = await fixture(t)
  const state = f.repository.localScan.privateFileState(f.root.id, '目录0/批0-曲0.wav')!.value
  const asset = f.repository.localCatalog.asset(state.assetId!)
  f.repository.localCatalog.moveAsset({ commandId: randomUUID(), assetId: asset.id, expectedLocationRevision: asset.locationRevision,
    expectedRootRevision: f.root.revision, relative: '搬家/新位置.wav' })
  const replacement = f.repository.localCatalog.registerAsset({ commandId: randomUUID(), libraryRootId: f.root.id, expectedRootRevision: f.root.revision,
    relative: '目录0/批0-曲0.wav', sha256: null, sampleFrames: null, timebaseHz: null })
  f.repository.localCatalog.createTrack({ commandId: randomUUID(), assetId: replacement.id, segment: null })
  const baseline = f.clone(), current = f.clone()
  const before = observed.run(observed.frame(baseline.database, baseline.rawStates, true), () => baseline.repo.localCatalog.privateAlbumBrowserQuery(query(), baseline.scope)).value
  const after = observed.run(observed.frame(current.database, current.rawStates), () => current.repo.localCatalog.privateAlbumBrowserQuery(query(), current.scope)).value
  assert.deepEqual(after, before)
  assert.ok(after.items.some(album => album.representativeTrackId === state.trackId))
})

test('扫描状态SQL投影：解析后库存修订改变，末屏障拒绝且下一次必须重建Compact', async t => {
  const observed = instrumentation(t), f = await fixture(t), cold = f.clone()
  let revision = 'fixture-resource-one', armed = true
  const inventory = { revision: () => revision, read: () => 'unknown' as const }
  const scope: LocalAlbumSqlScope = { ...cold.scope, artworkInventory: inventory }
  const firstFrame = observed.frame(cold.database, cold.rawStates)
  firstFrame.afterStateRead = () => { if (armed) { armed = false; revision = 'fixture-resource-two' } }
  assert.throws(() => observed.run(firstFrame, () => cold.repo.localCatalog.privateAlbumBrowserQuery(query(), scope)), { code: 'SNAPSHOT_CHANGED' })
  assert.equal(armed, false)
  const nextFrame = observed.frame(cold.database, cold.rawStates)
  const next = observed.run(nextFrame, () => cold.repo.localCatalog.privateAlbumBrowserQuery(query(), scope))
  assert.ok(next.value.items.length > 0); assert.ok(nextFrame.counters.stateParses > 0); assert.ok(nextFrame.compact)
})

// 下面只核纯resolver，使用内存合成表；不声称Source许可或Owner生命周期证据。
function resolverFixture(t: test.TestContext) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close())
  db.exec(`CREATE TABLE local_catalog_assets(id TEXT PRIMARY KEY,root_id TEXT,relative TEXT);
    CREATE INDEX locator ON local_catalog_assets(root_id,relative);
    CREATE TABLE local_scan_file_state(library_root_id TEXT,relative TEXT,asset_id TEXT,track_id TEXT,data TEXT,PRIMARY KEY(library_root_id,relative));
    CREATE INDEX state_asset ON local_scan_file_state(asset_id);`)
  const root = randomUUID(), asset = randomUUID(), track = randomUUID(), item = accepted('原址/音频.wav')
  const state: ScanFileState = { libraryRootId: root, relative: item.relative, signature: item.signature, parserVersion: item.parserVersion,
    outcome: 'accepted', assetId: asset, trackId: track, failureCode: null, readFacts: item.readFacts }
  db.prepare('INSERT INTO local_catalog_assets VALUES(?,?,?)').run(asset,root,state.relative)
  function insert(value: ScanFileState, raw = JSON.stringify(value)) {
    db.prepare('INSERT INTO local_scan_file_state VALUES(?,?,?,?,?)').run(value.libraryRootId,value.relative,value.assetId,value.trackId,raw)
  }
  insert(state)
  const conflict = (message: string): never => { throw new Error(message) }
  const original = (relative: string) => readLocalAlbumScanState(db,root,relative,conflict)
  const projected = (relative: string) => {
    // 参数仅来自当前连接实际SELECT；生产表达式另由上面真实Reader与EXPLAIN覆盖。
    const row = db.prepare(`SELECT d.data,
      (SELECT count(*) FROM (SELECT 1 FROM local_catalog_assets x WHERE x.root_id=@root AND x.relative=@relative LIMIT 2)) locator_count,
      a.root_id asset_root,a.relative asset_relative FROM (SELECT 1) anchor
      LEFT JOIN local_scan_file_state d ON d.library_root_id=@root AND d.relative=@relative
      LEFT JOIN local_catalog_assets a ON a.id=CASE WHEN json_valid(d.data) THEN json_extract(d.data,'$.assetId') END`).get({root,relative})!
    return readLocalAlbumScanStateProjected(db,root,relative,row.data,row.locator_count,row.asset_root,row.asset_relative,conflict)
  }
  return { db,root,asset,track,state,insert,original,projected }
}
function outcome(operation: () => unknown): unknown {
  try { return { value: operation() } }
  catch (error) { assert.ok(error instanceof Error); return { error: { name: error.name, message: error.message } } }
}

test('扫描状态SQL投影：正常direct与无asset拒收每次原guard解析，不保留调用方可变对象', t => {
  const f = resolverFixture(t), first = f.projected(f.state.relative)
  assert.deepEqual(first,f.original(f.state.relative)); assert.ok(first)
  first.signature = '调用方改变'
  assert.deepEqual(f.projected(f.state.relative),f.state)
  const reject: ScanFileState = { ...f.state,relative:'拒收/坏.wav',outcome:'rejected',assetId:null,trackId:null,failureCode:'PARSE_FAILED',readFacts:null }
  f.insert(reject)
  assert.deepEqual(f.projected(reject.relative),f.original(reject.relative)); assert.deepEqual(f.projected(reject.relative),reject)
  assert.equal(f.projected('不存在.wav'),null)
})

test('扫描状态SQL投影：同位置两个资产先于损坏direct解析拒绝，不让快路自动合并', t => {
  const f = resolverFixture(t)
  f.db.prepare('INSERT INTO local_catalog_assets VALUES(?,?,?)').run(randomUUID(),f.root,f.state.relative)
  f.db.prepare('UPDATE local_scan_file_state SET data=?').run('不是JSON')
  const actual = outcome(() => f.projected(f.state.relative))
  assert.deepEqual(actual,outcome(() => f.original(f.state.relative)))
  assert.match(JSON.stringify(actual),/当前位置有多个独立资产/u)
})

test('扫描状态SQL投影：asset已移动、旧direct失效、两候选歧义及新rowid遮蔽均沿原回退', t => {
  const f = resolverFixture(t), moved = '新址/音频.wav'
  f.db.prepare('UPDATE local_catalog_assets SET relative=? WHERE id=?').run(moved,f.asset)
  assert.deepEqual(f.projected(moved),f.original(moved)); assert.equal(f.projected(moved)!.relative,f.state.relative)
  assert.equal(f.projected(f.state.relative),null)
  const newer = { ...f.state,relative:'第二旧址/音频.wav',signature:'较新同track' }; f.insert(newer)
  assert.deepEqual(f.projected(moved),f.original(moved)); assert.deepEqual(f.projected(moved),newer)
  f.insert({ ...f.state,relative:'另一曲旧址/音频.wav',trackId:randomUUID() })
  const actual = outcome(() => f.projected(moved))
  assert.deepEqual(actual,outcome(() => f.original(moved))); assert.match(JSON.stringify(actual),/多个独立资产或曲目候选/u)
})

test('扫描状态SQL投影：坏JSON、额外字段与超过64KiB均维持原拒绝，不能由定位投影替代guard', t => {
  const f = resolverFixture(t)
  for (const raw of ['不是JSON',JSON.stringify({...f.state,unknown:true}),JSON.stringify({...f.state,signature:'x'.repeat(65_536)})]) {
    f.db.prepare('UPDATE local_scan_file_state SET data=?').run(raw)
    const actual = outcome(() => f.projected(f.state.relative))
    assert.deepEqual(actual,outcome(() => f.original(f.state.relative))); assert.ok(actual && typeof actual==='object' && 'error' in actual)
  }
})
