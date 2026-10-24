import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { StatementSync } from 'node:sqlite'
import { buildStoragePolicy } from '../../../../apps/desktop/scripts/build-storage-root.mjs'
import { CollectionError, createCollectionRepository } from '../../src/collection/repository.js'
import { readLocalAlbumScanState, type ScanPreparedBatch, type ScanPreparedItem } from '../../src/collection/local-scan-store.js'
import { authorizeSourceDirectory } from '../../src/recording/source-files.js'
import { METADATA_PARSER_VERSION } from '../../src/library/metadata-reader-types.js'

const audio = (relative: string): ScanPreparedItem => ({ relative, signature: `合成签名-${relative}`, parserVersion: METADATA_PARSER_VERSION,
  outcome: 'accepted', fields: { title: '合成曲目', artist: '合成艺人', album: '合成专辑' }, failureCode: null, reused: false,
  readFacts: { technical: { container: 'WAVE', codec: 'PCM', lossless: true, sampleRateHz: 48000, channels: 2, bitsPerSample: 16, durationSeconds: 10, evidence: 'bounded-parser-reported' },
    coverEvidence: [], readEvidence: { bytesRead: 44, readCalls: 1, maxReadBytes: 44, allocationBytes: 44, elapsedMs: 1, wholeAudioHash: false, wholeAudioDecode: false } } })

async function fixture(t: test.TestContext) {
  const storage = buildStoragePolicy(), temporary = storage.check(process.env.TMPDIR!, { mustExist: true })
  const directory = await mkdtemp(path.join(temporary, 'mb-scan-state-resolve-')); storage.check(directory, { mustExist: true })
  const sourcePath = path.join(directory, '合成空来源'); await mkdir(sourcePath)
  const repository = createCollectionRepository({ filePath: path.join(directory, 'collection.sqlite') })
  t.after(async () => { repository.close(); await rm(directory, { recursive: true, force: true }) })
  // Source许可只授权本测试新建空目录；扫描批及账本是真实合成事实，没有正式数据或音频Reader。
  const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(sourcePath))
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' })
  const started = repository.localScan.start({ commandId: randomUUID(), datasetId: randomUUID(), libraryRootId: root.id,
    expectedRootRevision: root.revision, parserVersion: METADATA_PARSER_VERSION }).job
  const job = repository.localScan.resume({ commandId: randomUUID(), jobId: started.jobId, expectedRevision: started.jobRevision })
  const batch: ScanPreparedBatch = { batchId: randomUUID(), jobId: job.jobId, expectedJobRevision: job.jobRevision, checkpointBefore: job.checkpointRef,
    items: [audio('旧址/音频.wav'), audio('稳定/第二.wav'), { relative: '拒收/损坏.wav', signature: '合成拒收签名', parserVersion: METADATA_PARSER_VERSION,
      outcome: 'rejected', fields: null, failureCode: 'PARSE_FAILED', reused: false, readFacts: null }], frontier: [''], completed: false }
  repository.localScan.privatePrepareBatch({ commandId: randomUUID(), jobId: job.jobId, batch })
  repository.localScan.privateCommitBatch({ commandId: randomUUID(), jobId: job.jobId, batchId: batch.batchId, expectedRevision: job.jobRevision })
  const initial = repository.localScan.privateFileState(root.id, '旧址/音频.wav')!.value
  function rawStates(): ReadonlySet<string> {
    return new Set(repository.localCatalog.privateRead(db => db.prepare('SELECT data FROM local_scan_file_state').all().map(row => String(row.data))))
  }
  const read = (relative: string) => repository.localCatalog.privateRead(db => readLocalAlbumScanState(db, root.id, relative,
    message => { throw new CollectionError('INVENTORY_CONFLICT', message) }))
  return { repository, root, initial, rawStates, read }
}

interface Counters { locators: number; direct: number; asset: number; fallback: number; stateParses: number }
function instrumentation(t: test.TestContext) {
  let active: { raw: ReadonlySet<string>; counters: Counters } | undefined, last: Counters | undefined
  const parse = JSON.parse
  const observedParse = function (text: string, ...rest: unknown[]) {
    if (active?.raw.has(text)) active.counters.stateParses++
    return Reflect.apply(parse, JSON, [text, ...rest])
  }
  Object.defineProperty(observedParse, 'length', { value: parse.length })
  t.mock.method(JSON, 'parse', observedParse)
  for (const method of ['all', 'get'] as const) {
    const original = StatementSync.prototype[method]
    const observed = function (this: StatementSync, ...bindings: unknown[]) {
      const counters = active?.counters, sql = this.sourceSQL.replace(/\s+/gu, ' ').trim()
      if (counters) {
        if (sql === 'SELECT id FROM local_catalog_assets WHERE root_id=? AND relative=? LIMIT 2') counters.locators++
        if (sql === 'SELECT * FROM local_scan_file_state WHERE library_root_id=? AND relative=?') counters.direct++
        if (sql === 'SELECT root_id,relative FROM local_catalog_assets WHERE id=?') counters.asset++
        if (sql.startsWith('SELECT s.* FROM local_catalog_assets a JOIN local_scan_file_state s ON s.asset_id=a.id')) counters.fallback++
      }
      return Reflect.apply(original, this, bindings)
    }
    Object.defineProperty(observed, 'length', { value: original.length })
    t.mock.method(StatementSync.prototype, method, observed)
  }
  return {
    run<T>(raw: ReadonlySet<string>, operation: () => T): { value: T; counters: Counters } {
      assert.equal(active, undefined)
      const counters: Counters = { locators: 0, direct: 0, asset: 0, fallback: 0, stateParses: 0 }
      last = counters; active = { raw, counters }
      try { return { value: operation(), counters } } finally { active = undefined }
    },
    get last() { return last! },
  }
}

test('扫描状态单次解析：direct一次parse仍执行原三SELECT，每次调用均返回独立新状态', async t => {
  const f = await fixture(t), observed = instrumentation(t), raw = f.rawStates()
  const first = observed.run(raw, () => f.read('旧址/音频.wav'))
  assert.deepEqual(first.value, f.initial)
  assert.deepEqual(first.counters, { locators: 1, direct: 1, asset: 1, fallback: 0, stateParses: 1 })
  assert.ok(first.value); first.value.signature = '调用方修改'
  const second = observed.run(raw, () => f.read('旧址/音频.wav'))
  assert.deepEqual(second.value, f.initial); assert.notEqual(second.value, first.value)
  assert.deepEqual(second.counters, first.counters, '不允许跨call缓存原row、解析对象或定位核验')
  const rejected = observed.run(raw, () => f.read('拒收/损坏.wav'))
  assert.equal(rejected.value!.outcome, 'rejected'); assert.equal(rejected.value!.assetId, null)
  assert.deepEqual(rejected.counters, { locators: 1, direct: 1, asset: 0, fallback: 0, stateParses: 1 })
})

test('扫描状态单次解析：真实move后按asset-only原回退，旧位置失效且不重写state.relative', async t => {
  const f = await fixture(t), observed = instrumentation(t), asset = f.repository.localCatalog.asset(f.initial.assetId!)
  f.repository.localCatalog.moveAsset({ commandId: randomUUID(), assetId: asset.id, expectedRootRevision: f.root.revision,
    expectedLocationRevision: asset.locationRevision, relative: '搬家/新位置.wav' })
  const raw = f.rawStates(), moved = observed.run(raw, () => f.read('搬家/新位置.wav'))
  assert.deepEqual(moved.value, f.initial); assert.equal(moved.value!.relative, '旧址/音频.wav')
  assert.deepEqual(moved.counters, { locators: 1, direct: 1, asset: 0, fallback: 1, stateParses: 1 })
  const old = observed.run(raw, () => f.read('旧址/音频.wav'))
  assert.equal(old.value, null)
  assert.deepEqual(old.counters, { locators: 1, direct: 1, asset: 1, fallback: 0, stateParses: 1 })
})

test('扫描状态单次解析：真实replace每次回核当前asset，路径歧义仍在解析前拒绝', async t => {
  const f = await fixture(t), observed = instrumentation(t), asset = f.repository.localCatalog.asset(f.initial.assetId!)
  const replaced = f.repository.localCatalog.replaceAsset({ commandId: randomUUID(), libraryRootId: f.root.id, expectedRootRevision: f.root.revision,
    assetId: asset.id, expectedFileRevision: asset.fileRevision, expectedLocationRevision: asset.locationRevision,
    relative: '旧址/音频.wav', sha256: null, sampleFrames: null, timebaseHz: null })
  assert.notEqual(replaced.fileRevision, asset.fileRevision)
  const raw = f.rawStates(), actual = observed.run(raw, () => f.read('旧址/音频.wav'))
  assert.deepEqual(actual.value, f.initial, '这里只保持原定位resolver语义，不额外改变扫描签名或文件替换政策')
  assert.deepEqual(actual.counters, { locators: 1, direct: 1, asset: 1, fallback: 0, stateParses: 1 })
  f.repository.localCatalog.registerAsset({ commandId: randomUUID(), libraryRootId: f.root.id, expectedRootRevision: f.root.revision,
    relative: '旧址/音频.wav', sha256: null, sampleFrames: null, timebaseHz: null })
  assert.throws(() => observed.run(raw, () => f.read('旧址/音频.wav')), /当前位置有多个独立资产/u)
  assert.deepEqual(observed.last, { locators: 1, direct: 0, asset: 0, fallback: 0, stateParses: 0 })
})
