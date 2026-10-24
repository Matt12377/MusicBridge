import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { StatementSync, type DatabaseSync } from 'node:sqlite'
import * as dto from '@music-bridge/contracts'
import { buildStoragePolicy } from '../../../../apps/desktop/scripts/build-storage-root.mjs'
import { createCollectionRepository } from '../../src/collection/repository.js'
import { verifyLocalScanDatabase, type ScanPreparedBatch, type ScanPreparedItem } from '../../src/collection/local-scan-store.js'
import { METADATA_PARSER_VERSION } from '../../src/library/metadata-reader-types.js'
import { authorizeSourceDirectory } from '../../src/recording/source-files.js'

// 原Repository、SQL、账本、事务和Source许可均真实执行；来源只是本测试新建的空目录。
const accepted = (relative: string, signature = `合成签名-${relative}`): ScanPreparedItem => ({ relative, signature,
  parserVersion: METADATA_PARSER_VERSION, outcome: 'accepted', fields: { title: relative, artist: '合成艺人', album: '合成专辑' },
  failureCode: null, reused: false, readFacts: {
    technical: { container: 'WAVE', codec: 'PCM', lossless: true, sampleRateHz: 48_000, channels: 2, bitsPerSample: 16,
      durationSeconds: 20, evidence: 'bounded-parser-reported' }, coverEvidence: [],
    readEvidence: { bytesRead: 44, readCalls: 1, maxReadBytes: 44, allocationBytes: 44, elapsedMs: 1, wholeAudioHash: false, wholeAudioDecode: false },
  } })
const rejected = (relative: string): ScanPreparedItem => ({ relative, signature: `合成拒收-${relative}`, parserVersion: METADATA_PARSER_VERSION,
  outcome: 'rejected', fields: null, failureCode: 'PARSE_FAILED', reused: false, readFacts: null })

async function fixture(t: TestContext) {
  const storage = buildStoragePolicy(), temporary = storage.check(process.env.TMPDIR!, { mustExist: true })
  assert.ok(path.resolve(temporary).startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'))
  const directory = await mkdtemp(path.join(temporary, 'mb-scan-one-call-codec-')); storage.check(directory, { mustExist: true })
  const sourceDirectory = path.join(directory, '合成空来源'); await mkdir(sourceDirectory)
  const file = path.join(directory, 'collection.sqlite')
  let fault: ((action: string) => void) | undefined
  const repository = createCollectionRepository({ filePath: file, beforeCommit(action) { fault?.(action) } })
  const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(sourceDirectory))
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' })
  const started = repository.localScan.start({ commandId: randomUUID(), datasetId: randomUUID(), libraryRootId: root.id,
    expectedRootRevision: root.revision, parserVersion: METADATA_PARSER_VERSION }).job
  let job = repository.localScan.resume({ commandId: randomUUID(), jobId: started.jobId, expectedRevision: started.jobRevision })
  let database!: DatabaseSync
  repository.localCatalog.privateRead(db => { database = db })
  const reopened: ReturnType<typeof createCollectionRepository>[] = []
  t.after(async () => { for (const cold of reopened) cold.close(); repository.close(); await rm(directory, { recursive: true, force: true }) })
  function prepare(items: ScanPreparedItem[], cueItems?: dto.LocalCuePreparedItem[], completed = false) {
    const batch: ScanPreparedBatch = { batchId: randomUUID(), jobId: job.jobId, expectedJobRevision: job.jobRevision,
      checkpointBefore: job.checkpointRef, items, frontier: completed ? [] : [''], completed,
      ...(cueItems ? { kind: 'cue-sidecars-v1' as const, cueItems } : {}) }
    repository.localScan.privatePrepareBatch({ commandId: randomUUID(), jobId: job.jobId, batch })
    return { batch, commit: { commandId: randomUUID(), jobId: job.jobId, batchId: batch.batchId, expectedRevision: job.jobRevision } }
  }
  function commit(prepared: ReturnType<typeof prepare>) { job = repository.localScan.privateCommitBatch(prepared.commit); return job }
  function submit(items: ScanPreparedItem[]) { const prepared = prepare(items); commit(prepared); return prepared }
  submit([accepted('专辑/一.wav'), accepted('专辑/二.wav'), rejected('专辑/坏.wav')])
  function cue(relative = '专辑/合成.cue'): dto.LocalCuePreparedItem {
    const tracks: dto.LocalCueTrackFact[] = []
    for (const [fileIndex, audio] of ['专辑/一.wav', '专辑/二.wav'].entries()) {
      const state = repository.localScan.privateCurrentFileState(root.id, audio)!.value
      const locator = repository.localCatalog.privateAssetLocator(state.assetId!), asset = locator.asset
      for (let index = 0; index < (fileIndex === 0 ? 3 : 2); index++) tracks.push({ trackNumber: tracks.length + 1, fileOrdinal: fileIndex + 1,
        assetReference: { assetId: asset.id, libraryRootId: root.id, sourceRootId: source.id, rootRevision: root.revision,
          fileRevision: asset.fileRevision, locationRevision: asset.locationRevision, relative: locator.relative, signature: state.signature },
        timebase: 'cue-cd-frames', framesPerSecond: 75, index00Frames: null, index01Frames: index * 75,
        endFrames: null, evidence: 'cue-text-declared', playback: 'NOT_VERIFIED' })
    }
    return { relative, signature: `合成CUE-${relative}`, parserVersion: 'cue-text-75fps/mbrs003-v1', outcome: 'accepted', failureCode: null,
      reused: false, previousSnapshotId: repository.localScan.privateCueSnapshot(root.id, relative)?.id ?? null, result: { status: 'ok', tracks } }
  }
  function rawStates() { return new Set(database.prepare('SELECT data FROM local_scan_file_state').all().map(row => String(row.data))) }
  function rows() {
    return database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'local_scan_%' OR name LIKE 'local_cue_%' OR name LIKE 'local_catalog_%') ORDER BY name").all()
      .map(row => [row.name, database.prepare(`SELECT * FROM "${String(row.name)}" ORDER BY rowid`).all()])
  }
  return { repository, database, root, source, prepare, commit, submit, cue, rawStates, rows,
    get job() { return job }, inject(value: typeof fault) { fault = value },
    reopen() { repository.close(); const cold = createCollectionRepository({ filePath: file }); reopened.push(cold); return cold } }
}

interface Counters { locators: number; direct: number; asset: number; fallback: number; parses: number }
function observe(t: TestContext) {
  let active: { raw: ReadonlySet<string>; counts: Counters } | undefined, last!: Counters
  const parse = JSON.parse
  t.mock.method(JSON, 'parse', function (text: string, ...rest: unknown[]) {
    if (active?.raw.has(text)) active.counts.parses++
    return Reflect.apply(parse, JSON, [text, ...rest])
  })
  for (const method of ['get', 'all'] as const) {
    const original = StatementSync.prototype[method]
    t.mock.method(StatementSync.prototype, method, function (this: StatementSync, ...bindings: unknown[]) {
      const sql = this.sourceSQL.replace(/\s+/gu, ' ').trim(), counts = active?.counts
      if (counts) {
        if (sql === 'SELECT id FROM local_catalog_assets WHERE root_id=? AND relative=? LIMIT 2') counts.locators++
        if (sql === 'SELECT * FROM local_scan_file_state WHERE library_root_id=? AND relative=?') counts.direct++
        if (sql === 'SELECT root_id,relative FROM local_catalog_assets WHERE id=?') counts.asset++
        if (sql.startsWith('SELECT s.* FROM local_catalog_assets a JOIN local_scan_file_state s ON s.asset_id=a.id')) counts.fallback++
      }
      return Reflect.apply(original, this, bindings)
    })
  }
  return { run<T>(raw: ReadonlySet<string>, operation: () => T) {
    assert.equal(active, undefined)
    last = { locators: 0, direct: 0, asset: 0, fallback: 0, parses: 0 }; active = { raw, counts: last }
    try { return { value: operation(), counts: last } } finally { active = undefined }
  }, get last() { return last } }
}
const direct = (parses = 1): Counters => ({ locators: 1, direct: 1, asset: 1, fallback: 0, parses })

test('扫描单call codec：私有读取复用已核state，重复调用仍实读三SELECT且不复用对象', async t => {
  const f = await fixture(t), observed = observe(t), raw = f.rawStates()
  const first = observed.run(raw, () => f.repository.localScan.privateCurrentFileState(f.root.id, '专辑/一.wav'))
  assert.deepEqual(first.counts, direct()); assert.ok(first.value)
  const expected = structuredClone(first.value); first.value.value.signature = '调用者临时修改'
  const second = observed.run(raw, () => f.repository.localScan.privateCurrentFileState(f.root.id, '专辑/一.wav'))
  assert.deepEqual(second.value, expected); assert.notEqual(second.value!.value, first.value.value); assert.deepEqual(second.counts, direct())
  const source = observed.run(raw, () => f.repository.localScan.privateSourceWriteFileState(f.root.id, '专辑/一.wav'))
  assert.deepEqual(source.counts, direct()); assert.deepEqual(source.value!.value, expected.value)
  assert.equal(source.value!.data, JSON.stringify(expected.value)); assert.ok(dto.isCollectionId(source.value!.batchId))
  const refused = observed.run(raw, () => f.repository.localScan.privateCurrentFileState(f.root.id, '专辑/坏.wav'))
  assert.deepEqual(refused.counts, { locators: 1, direct: 1, asset: 0, fallback: 0, parses: 1 })
  assert.equal(refused.value!.value.outcome, 'rejected'); assert.equal(refused.value!.value.assetId, null)
})

test('扫描单call codec：CUE绑定及完整目录保拒收事实，原定位SELECT不减少', async t => {
  const f = await fixture(t), observed = observe(t), raw = f.rawStates()
  const bound = observed.run(raw, () => f.repository.localScan.privateCueAssociation(f.root.id, '专辑/一.wav'))
  assert.equal(bound.value.status, 'bound'); assert.deepEqual(bound.counts, { ...direct(), locators: 2 })
  const refused = observed.run(raw, () => f.repository.localScan.privateCueAssociation(f.root.id, '专辑/坏.wav'))
  assert.deepEqual(refused.value, { status: 'unbound' }); assert.equal(refused.counts.parses, 0)
  const revision = f.repository.localScan.privateAlbumBrowserRevision()
  const result = observed.run(raw, () => f.repository.localScan.privateWorkbenchDirectoryFacts({ expectedRevision: revision,
    libraryRootId: f.root.id, directories: ['专辑'], maxFiles: 200, maxBytes: 1024 * 1024 }))
  assert.deepEqual(result.counts, { locators: 3, direct: 3, asset: 2, fallback: 0, parses: 3 })
  assert.equal(result.value.files.length, 3); assert.equal(result.value.cues.length, 0)
  assert.equal(result.value.files.find(file => file.currentRelative === '专辑/坏.wav')!.value.outcome, 'rejected')
  for (const file of result.value.files) assert.deepEqual(file.value, f.repository.localScan.privateFileState(f.root.id, file.currentRelative)!.value)
})

test('扫描单call codec：原音频复用批每个previous只解析一次，原资产、metadata和readFacts保留', async t => {
  const f = await fixture(t), raw = f.rawStates(), observed = observe(t)
  const states = ['专辑/一.wav', '专辑/二.wav'].map(relative => f.repository.localScan.privateCurrentFileState(f.root.id, relative)!.value)
  const catalogBefore = f.repository.localCatalog.pageTracks({ offset: 0, limit: 200 })
  const items: ScanPreparedItem[] = states.map(state => ({ relative: state.relative, signature: state.signature,
    parserVersion: state.parserVersion, outcome: 'accepted', fields: {}, failureCode: null, reused: true, readFacts: null }))
  const prepared = f.prepare([...items, rejected('专辑/坏.wav')])
  const result = observed.run(raw, () => f.commit(prepared))
  // 三次resolver原行实读之外，提交还逐项读取before及写后audit行，三类SELECT全部保留。
  assert.deepEqual(result.counts, { locators: 3, direct: 9, asset: 2, fallback: 0, parses: 3 })
  assert.deepEqual(result.value.progress, { visited: '6', accepted: '4', rejected: '2' })
  assert.deepEqual(f.repository.localCatalog.pageTracks({ offset: 0, limit: 200 }), catalogBefore)
  for (const state of states) assert.deepEqual(f.repository.localScan.privateCurrentFileState(f.root.id, state.relative)!.value, state)
  f.repository.localCatalog.privateRead(db => verifyLocalScanDatabase(db))
})

test('扫描单call codec：五个真实CUE track各解析一次并保完整snapshot、receipt重放与冷重开', async t => {
  const f = await fixture(t), cue = f.cue(), prepared = f.prepare([], [cue], true), raw = f.rawStates(), observed = observe(t)
  const beforeStates = f.database.prepare('SELECT * FROM local_scan_file_state ORDER BY rowid').all()
  const result = observed.run(raw, () => f.commit(prepared))
  assert.deepEqual(result.counts, { locators: 5, direct: 5, asset: 5, fallback: 0, parses: 5 })
  assert.equal(result.value.phase, 'completed'); assert.deepEqual(result.value.progress, { visited: '4', accepted: '3', rejected: '1' })
  assert.deepEqual(f.repository.localScan.privateCueSnapshot(f.root.id, cue.relative)!.item, cue)
  assert.equal(f.database.prepare('SELECT count(*) n FROM local_cue_tracks').get()!.n, 5)
  assert.deepEqual(f.database.prepare('SELECT * FROM local_scan_file_state ORDER BY rowid').all(), beforeStates)
  assert.ok(f.repository.localCatalog.pageTracks({ offset: 0, limit: 200 }).items.every(track => track.segment === null))
  const changes = f.database.prepare('SELECT total_changes() n').get()!.n, receipt = f.repository.localScan.receipt(prepared.commit.commandId)
  const replay = observed.run(raw, () => f.repository.localScan.privateCommitBatch(structuredClone(prepared.commit)))
  assert.deepEqual(replay.value, result.value); assert.deepEqual(replay.counts, { locators: 0, direct: 0, asset: 0, fallback: 0, parses: 0 })
  assert.equal(f.database.prepare('SELECT total_changes() n').get()!.n, changes)
  f.repository.localCatalog.privateRead(db => verifyLocalScanDatabase(db))
  const cold = f.reopen()
  assert.deepEqual(cold.localScan.get(result.value.jobId), result.value)
  assert.deepEqual(cold.localScan.receipt(prepared.commit.commandId), receipt)
  assert.deepEqual(cold.localScan.privateCueSnapshot(f.root.id, cue.relative)!.item, cue)
  t.diagnostic('同一有效CUE引用的原state JSON.parse由3次降至1次；五track仍各执行定位、state、asset三SELECT，不跨track去重。')
})

test('扫描单call codec：beforeCommit故障完整回滚，原prepared五track重试才发布checkpoint和回执', async t => {
  const f = await fixture(t), cue = f.cue(), prepared = f.prepare([], [cue]), before = f.rows(), job = structuredClone(f.job)
  const observed = observe(t), raw = f.rawStates()
  f.inject(action => { if (action === 'local-scan:commit-batch') throw new Error('合成CUE提交前故障') })
  assert.throws(() => observed.run(raw, () => f.commit(prepared)))
  assert.deepEqual(observed.last, { locators: 5, direct: 5, asset: 5, fallback: 0, parses: 5 })
  f.inject(undefined)
  assert.deepEqual(f.rows(), before); assert.deepEqual(f.repository.localScan.get(job.jobId), job)
  assert.equal(f.repository.localScan.receipt(prepared.commit.commandId), null); assert.equal(f.repository.localScan.privateCueSnapshot(f.root.id, cue.relative), null)
  assert.deepEqual(f.repository.localScan.privatePreparedBatches(job.jobId), [prepared.batch])
  const committed = observed.run(raw, () => f.commit(prepared))
  assert.equal(committed.counts.parses, 5); assert.notEqual(committed.value.checkpointRef, job.checkpointRef)
  assert.deepEqual(f.repository.localScan.privateCueSnapshot(f.root.id, cue.relative)!.item, cue)
  f.repository.localCatalog.privateRead(db => verifyLocalScanDatabase(db))
})

test('扫描单call codec：迟到CUE签名或资产修订失配仍回滚，来源撤销不能提交原prepared批', async t => {
  for (const mode of ['signature', 'fileRevision', 'source'] as const) await t.test(mode, async child => {
    const f = await fixture(child), cue = f.cue()
    // 同一FILE的所有track必须持有一致引用，先通过原DTO，再触发真实提交时的过期事实拒绝。
    for (const track of cue.result!.tracks.filter(track => track.fileOrdinal === 1)) {
      if (mode === 'signature') track.assetReference.signature = '合成已过时签名'
      if (mode === 'fileRevision') track.assetReference.fileRevision = '999999'
    }
    const prepared = f.prepare([], [cue])
    if (mode === 'source') f.repository.sources.revoke({ commandId: randomUUID(), id: f.source.id })
    const before = f.rows(), job = structuredClone(f.job)
    assert.throws(() => f.commit(prepared), mode === 'source' ? /许可|授权/u : /CUE关联/u)
    assert.deepEqual(f.rows(), before); assert.deepEqual(f.repository.localScan.get(job.jobId), job)
    assert.equal(f.repository.localScan.receipt(prepared.commit.commandId), null); assert.equal(f.repository.localScan.privateCueSnapshot(f.root.id, cue.relative), null)
  })
})

test('扫描单call codec：移动后沿原asset回退，路径歧义仍在解析前拒绝', async t => {
  const f = await fixture(t), initial = f.repository.localScan.privateCurrentFileState(f.root.id, '专辑/一.wav')!, asset = f.repository.localCatalog.asset(initial.value.assetId!)
  f.repository.localCatalog.moveAsset({ commandId: randomUUID(), assetId: asset.id, expectedRootRevision: f.root.revision,
    expectedLocationRevision: asset.locationRevision, relative: '搬家/一.wav' })
  const observed = observe(t), raw = f.rawStates()
  const moved = observed.run(raw, () => f.repository.localScan.privateCurrentFileState(f.root.id, '搬家/一.wav'))
  assert.deepEqual(moved.value, initial); assert.deepEqual(moved.counts, { locators: 1, direct: 1, asset: 0, fallback: 1, parses: 1 })
  assert.equal(f.repository.localScan.privateCurrentFileState(f.root.id, '专辑/一.wav'), null)
  f.repository.localCatalog.registerAsset({ commandId: randomUUID(), libraryRootId: f.root.id, expectedRootRevision: f.root.revision,
    relative: '搬家/一.wav', sha256: null, sampleFrames: null, timebaseHz: null })
  assert.throws(() => observed.run(raw, () => f.repository.localScan.privateCurrentFileState(f.root.id, '搬家/一.wav')), /多个独立资产/u)
  assert.deepEqual(observed.last, { locators: 1, direct: 0, asset: 0, fallback: 0, parses: 0 })
})
