import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createCollectionRepository } from '../../src/collection/repository.js'
import { verifyLocalScanDatabase, type ScanPreparedBatch, type ScanPreparedItem } from '../../src/collection/local-scan-store.js'
import { authorizeSourceDirectory } from '../../src/recording/source-files.js'
import { readLibraryOperationLine, type LibraryOperationEvent } from '../../src/shared/library-operation-log.js'

// 只使用本测试真实授权的合成空目录与SQLite；没有源音频、NAS或跨调用事实缓存。
const parserVersion = 'music-metadata-11.15.0/mbrs003-v1'
const fileSql = 'SELECT * FROM local_scan_file_state ORDER BY rowid'
const batchSql = "SELECT request,result FROM local_scan_batches WHERE id=? AND job_id=? AND phase='committed'"
const accepted = (relative: string): ScanPreparedItem => ({ relative, signature: `合成签名-${relative}`, parserVersion,
  outcome: 'accepted', fields: { title: relative, artist: '合成艺人', album: '合成专辑' }, failureCode: null, reused: false,
  readFacts: { technical: { container: 'WAVE', codec: 'PCM', lossless: true, sampleRateHz: 48000, channels: 2, bitsPerSample: 16,
    durationSeconds: 1, evidence: 'bounded-parser-reported' }, coverEvidence: [],
    readEvidence: { bytesRead: 44, readCalls: 1, maxReadBytes: 44, allocationBytes: 44, elapsedMs: 1, wholeAudioHash: false, wholeAudioDecode: false } } })

async function fixture(t: TestContext, batches = 3, width = 8) {
  const temporary = process.env.TMPDIR
  assert.ok(temporary && path.isAbsolute(temporary))
  if (process.platform === 'darwin') assert.ok(path.resolve(temporary).startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'))
  const directory = await mkdtemp(path.join(temporary, 'scan-file-state-memo-')), media = path.join(directory, '合成空来源'), filePath = path.join(directory, 'collection.sqlite')
  await mkdir(media)
  const repository = createCollectionRepository({ filePath })
  t.after(async () => { repository.close(); await rm(directory, { recursive: true, force: true }) })
  const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media))
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' })
  const started = repository.localScan.start({ commandId: randomUUID(), datasetId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision, parserVersion }).job
  let job = repository.localScan.resume({ commandId: randomUUID(), jobId: started.jobId, expectedRevision: started.jobRevision })
  const prepared: ScanPreparedBatch[] = []
  for (let index = 0; index < batches; index++) {
    const batch: ScanPreparedBatch = { batchId: randomUUID(), jobId: job.jobId, expectedJobRevision: job.jobRevision, checkpointBefore: job.checkpointRef,
      items: Array.from({ length: width }, (_, item) => accepted(`批${index}/曲${item}.wav`)), frontier: index === batches - 1 ? [] : [''], completed: index === batches - 1 }
    repository.localScan.privatePrepareBatch({ commandId: randomUUID(), jobId: job.jobId, batch })
    job = repository.localScan.privateCommitBatch({ commandId: randomUUID(), jobId: job.jobId, batchId: batch.batchId, expectedRevision: job.jobRevision })
    prepared.push(batch)
  }
  let db!: DatabaseSync
  repository.localCatalog.privateRead(value => { db = value })
  assert.equal(job.phase, 'completed')
  return { repository, filePath, db, root, job, prepared, rows: batches * width,
    verify() { verifyLocalScanDatabase(db) } }
}
function events(t: TestContext): LibraryOperationEvent[] {
  const result: LibraryOperationEvent[] = []
  t.mock.method(console, 'info', (...args: unknown[]) => { for (const line of args) {
    const event = typeof line === 'string' ? readLibraryOperationLine(line) : null; if (event) result.push(event)
  } })
  return result
}
function completion(values: readonly LibraryOperationEvent[]) {
  const found = values.filter(event => event.action === 'scan.verify-file-state.memo' && event.state === 'complete')
  assert.equal(found.length, 1); assert.equal(found[0]!.code, 'BOUNDED_BATCH_JSON'); return found[0]!
}
type BatchRow = { request: string; result: string }
/** 每项仍调用真实SQLite get；仅在指定只读返回值上注入故障，不更换持久Source或validator。 */
function observeFileReads(t: TestContext, database: DatabaseSync, alter?: (row: BatchRow, ordinal: number) => BatchRow) {
  const prepare = DatabaseSync.prototype.prepare
  let readingFiles = false, batchReads = 0, batchPrepares = 0
  const mock = t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    const statement = prepare.call(this, sql)
    if (this !== database) return statement
    if (sql === fileSql) {
      const iterate = statement.iterate
      t.mock.method(statement, 'iterate', function* (...args: unknown[]) {
        readingFiles = true
        try { yield* Reflect.apply(iterate, statement, args) as Iterable<Record<string, unknown>> }
        finally { readingFiles = false }
      })
    } else if (sql === batchSql) {
      batchPrepares++
      const get = statement.get
      t.mock.method(statement, 'get', (...args: unknown[]) => {
        const value = Reflect.apply(get, statement, args)
        if (!readingFiles || value === undefined) return value
        batchReads++
        assert.equal(typeof value.request, 'string'); assert.equal(typeof value.result, 'string')
        return alter ? alter(value as BatchRow, batchReads) : value
      })
    }
    return statement
  })
  return { reads: () => batchReads, prepares: () => batchPrepares, restore: () => mock.mock.restore() }
}

test('扫描冷核memo：多文件真实批每行实读batch，24行只解析3对JSON，同连接再核不跨调用复用', async t => {
  const f = await fixture(t), logged = events(t), reads = observeFileReads(t, f.db)
  const before = f.db.prepare('SELECT total_changes() n').get()!.n
  f.verify()
  assert.equal(reads.reads(), 24)
  assert.equal(reads.prepares(), 1, 'checkpoint与24行state共用本次核验的一条batch语句，但不复用读取结果')
  const first = completion(logged)
  assert.equal(first.total, 24); assert.equal(first.count, 3); assert.equal(first.active, 3)
  assert.ok(first.bytes! > 0 && first.bytes! <= 32 * 1024 * 1024)
  let checkpoints = 0
  logged.length = 0; verifyLocalScanDatabase(f.db, () => { checkpoints++ })
  assert.equal(reads.reads(), 48); assert.equal(completion(logged).count, 3)
  assert.equal(reads.prepares(), 2, '下一次完整核验必须重新准备语句，不跨调用保留')
  assert.equal(f.db.prepare('SELECT total_changes() n').get()!.n, before, 'memo及诊断不能写数据库')
  assert.ok(checkpoints > 0, '带取消检查点仍须逐行实读与重建本次memo')
  t.diagnostic('24项仍有24次真实batch点读，每次verify只解析3对batch JSON；count不是源读取次数。')
})

test('扫描冷核memo：真实关闭重开仍完整验证并重建局部memo，保留原job/checkpoint/raw事实', async t => {
  const f = await fixture(t), expected = structuredClone(f.job)
  f.repository.close()
  const logged = events(t), reopened = createCollectionRepository({ filePath: f.filePath })
  try {
    assert.deepEqual(reopened.localScan.get(expected.jobId), expected)
    const value = completion(logged); assert.equal(value.total, 24); assert.equal(value.count, 3)
    assert.equal(reopened.localCatalog.pageTracks({ offset: 0, limit: 200 }).total, 24)
  } finally { reopened.close() }
})

for (const changed of ['request', 'result'] as const) test(`扫描冷核memo：同batch中途${changed}原文变化仍重新验证并拒绝篡改`, async t => {
  const f = await fixture(t, 1, 4)
  let altered = false
  observeFileReads(t, f.db, (row, ordinal) => {
    if (ordinal !== 2) return row
    altered = true
    const value = JSON.parse(row[changed])
    // 篡改已过的第一项，本次第二项的find/对照仍相同；必须重跑整份原guard才能拒绝。
    if (changed === 'request') value.items[0].readFacts.readEvidence.wholeAudioHash = true
    else value.files[0].trackId = null
    return { ...row, [changed]: JSON.stringify(value) }
  })
  assert.throws(() => f.verify()); assert.equal(altered, true)
})

test('扫描冷核memo：逻辑JSON相等但原文不同也不能复用，恢复原文后再核仍正确', async t => {
  const f = await fixture(t, 1, 4), logged = events(t)
  observeFileReads(t, f.db, (row, ordinal) => ordinal === 2 ? { ...row, request: row.request + ' ' } : row)
  f.verify()
  assert.equal(completion(logged).count, 3, '原文→带空白原文→原文必须分别通过原parse与guard')
})

test('扫描冷核memo：超分配预算不留对象，每行回原完整parse且不截断合法批', async t => {
  const f = await fixture(t, 1, 4), logged = events(t), padding = ' '.repeat(1024 * 1024)
  observeFileReads(t, f.db, row => ({ request: row.request + padding, result: row.result + padding }))
  f.verify()
  const value = completion(logged)
  assert.equal(value.total, 4); assert.equal(value.count, 4); assert.equal(value.active, 0); assert.equal(value.bytes, 0)
  const fallback = logged.find(event => event.action === 'scan.verify-file-state.memo' && event.code === 'CAPACITY')
  assert.equal(fallback?.count, 4)
})

test('扫描冷核memo：64项LRU逐出后旧batch尾文件重新解析，所有130项仍完整核验', async t => {
  const f = await fixture(t, 65, 2)
  // 只调整本合成state表的遍历次序；数据、batch、receipt和关联关系完全不改。
  f.db.prepare('UPDATE local_scan_file_state SET rowid=1000000 WHERE library_root_id=? AND relative=?').run(f.root.id, f.prepared[0]!.items[1]!.relative)
  const logged = events(t), reads = observeFileReads(t, f.db)
  f.verify()
  const value = completion(logged)
  assert.equal(reads.reads(), 130); assert.equal(value.total, 130); assert.equal(value.count, 66); assert.equal(value.active, 64)
  assert.equal(reads.prepares(), 1, '130行逐项实读仍只准备一条batch语句，JSON memo逐出不能造成语句重新准备')
  assert.ok(value.bytes! <= 32 * 1024 * 1024)
})

test('扫描冷核memo：按分配总额逐出仍保完整结果，峰值不越32MiB', async t => {
  const f = await fixture(t, 6, 2), logged = events(t), padding = ' '.repeat(256 * 1024)
  observeFileReads(t, f.db, row => ({ request: row.request + padding, result: row.result + padding }))
  f.verify()
  const value = completion(logged)
  assert.equal(value.total, 12); assert.equal(value.count, 6)
  assert.ok(value.active! >= 1 && value.active! <= 3); assert.ok(value.bytes! > 0 && value.bytes! <= 32 * 1024 * 1024)
})

test('扫描冷核memo：原文件state被篡改仍拒绝，不能拿已核batch覆盖真实state', async t => {
  const f = await fixture(t, 1, 4), row = f.db.prepare('SELECT library_root_id,relative,data FROM local_scan_file_state ORDER BY rowid LIMIT 1').get()!
  const state = JSON.parse(String(row.data)); state.signature += '-篡改'
  f.db.prepare('UPDATE local_scan_file_state SET data=? WHERE library_root_id=? AND relative=?').run(JSON.stringify(state), String(row.library_root_id), String(row.relative))
  assert.throws(() => f.verify())
})

test('扫描冷核memo：外部真实提交即使不变更batch文本，末scanDataVersion仍拒绝旧核验', async t => {
  const f = await fixture(t, 1, 4), external = new DatabaseSync(f.filePath), before = f.db.prepare('PRAGMA data_version').get()!.data_version
  t.after(() => external.close())
  let committed = false
  observeFileReads(t, f.db, row => {
    if (!committed) { committed = true; external.prepare("UPDATE physical_sequences SET next_value=next_value+1 WHERE format='cassette'").run() }
    return row
  })
  assert.throws(() => f.verify()); assert.equal(committed, true)
  assert.notEqual(f.db.prepare('PRAGMA data_version').get()!.data_version, before)
})
