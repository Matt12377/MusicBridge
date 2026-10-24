import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import fsp, { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as dto from '@music-bridge/contracts'
import { createCollectionRepository } from '../../src/collection/repository.js'
import { createLocalAlbumOwnerService } from '../../src/collection/local-album-browser/owner-port.js'
import type { ScanPreparedBatch, ScanPreparedItem } from '../../src/collection/local-scan-store.js'
import { authorizeSourceDirectory, sourceRootAvailability } from '../../src/recording/source-files.js'

// 原Repository/Scan/Owner作者和真实SQLite；仅授权本测试新建空目录，所有标签与技术事实明确为合成输入。
const parserVersion = 'music-metadata-11.15.0/mbrs003-v1'
const title = '合成参数专辑'
const expected: dto.FileAudioParameters = { container: 'WAVE', codec: 'PCM', lossless: true, sampleRateHz: 48000,
  channels: 2, bitsPerSample: 16, durationMs: 1000, evidence: 'bounded-parser-reported' }
const audio = (relative: string, index: number, signature = `合成签名-${relative}`): ScanPreparedItem => ({
  relative, signature, parserVersion, outcome: 'accepted', fields: { title: `合成曲目${index}`, artist: '合成艺人', album: title, disc: '1', track: String(index) },
  failureCode: null, reused: false, readFacts: { technical: { container: 'WAVE', codec: 'PCM', lossless: true, sampleRateHz: 48000,
    channels: 2, bitsPerSample: 16, durationSeconds: 1, evidence: 'bounded-parser-reported' }, coverEvidence: [],
    readEvidence: { bytesRead: 44, readCalls: 1, maxReadBytes: 44, allocationBytes: 44, elapsedMs: 1, wholeAudioHash: false, wholeAudioDecode: false } },
})
async function fixture(t: TestContext, count = 11) {
  const temporary = process.env.TMPDIR
  assert.ok(temporary && path.isAbsolute(temporary))
  if (process.platform === 'darwin') assert.ok(path.resolve(temporary).startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'))
  const directory = await mkdtemp(path.join(temporary, 'scan-display-origin-')), media = path.join(directory, '合成空来源'), filePath = path.join(directory, 'collection.sqlite')
  await mkdir(media)
  const repository = createCollectionRepository({ filePath }), copies = new Set<ReturnType<typeof createCollectionRepository>>()
  let owner: ReturnType<typeof createLocalAlbumOwnerService> | undefined
  t.after(async () => { owner?.close(); for (const copy of copies) copy.close(); repository.close(); await rm(directory, { recursive: true, force: true }) })
  const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media))
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' }), datasetId = randomUUID()
  const batches: ScanPreparedBatch[] = []
  function commit(items: ScanPreparedItem[]) {
    const current = repository.localCatalog.root(root.id)
    const pending = repository.localScan.start({ commandId: randomUUID(), datasetId, libraryRootId: current.id, expectedRootRevision: current.revision, parserVersion }).job
    const job = repository.localScan.resume({ commandId: randomUUID(), jobId: pending.jobId, expectedRevision: pending.jobRevision })
    const batch: ScanPreparedBatch = { batchId: randomUUID(), jobId: job.jobId, expectedJobRevision: job.jobRevision,
      checkpointBefore: job.checkpointRef, items, frontier: [], completed: true }
    repository.localScan.privatePrepareBatch({ commandId: randomUUID(), jobId: job.jobId, batch })
    const final = repository.localScan.privateCommitBatch({ commandId: randomUUID(), jobId: job.jobId, batchId: batch.batchId, expectedRevision: job.jobRevision })
    assert.equal(final.phase, 'completed'); batches.push(batch); return batch
  }
  const inputs = Array.from({ length: count }, (_, index) => audio(`目标目录/${String(index + 1).padStart(2, '0')}.wav`, index + 1))
  const firstBatch = commit(inputs)
  // 同根后继批有真实已提交音频事实，不能靠“当前批是全库最后一批”让性能断言虚过。
  for (let index = 0; index < 3; index++) commit([audio(`其它目录${index}/01.wav`, 1)])
  const records = inputs.map(input => {
    const state = repository.localScan.privateCurrentFileState(root.id, input.relative)
    assert.ok(state && state.value.assetId && state.value.trackId)
    return { input, state, track: repository.localCatalog.track(state.value.trackId), asset: repository.localCatalog.asset(state.value.assetId) }
  })
  let db!: DatabaseSync; repository.localCatalog.privateRead(value => { db = value })
  owner = createLocalAlbumOwnerService({ repository, assertCurrent() {},
    readRootViews: async () => Promise.all(repository.localCatalog.roots().map(async current => ({ root: current, label: '合成来源',
      availability: await sourceRootAvailability(repository.sources.root(current.sourceRootId)) }))),
    async readArtwork(): Promise<never> { throw new Error('参数Gate不打开图片或音频FD。') },
  })
  const read = (index = 0, asset = records[index]!.asset) => repository.localScan.privateDisplayFileParameters(records[index]!.track.id, asset)
  return { repository, owner, copies, filePath, media, source, root, db, commit, inputs, firstBatch, batches, records, read }
}

/** 只观测实际SQL的执行及返回行；不替换事实、不伪造Source或降低任何validator。 */
function observe(t: TestContext, database: DatabaseSync) {
  const prepare = DatabaseSync.prototype.prepare
  const counts = { direct: 0, history: 0, directRows: 0, historyRows: 0, ledgerRows: 0 }
  let directSql = '', directBindings: Record<string, string> | undefined
  const mocked = t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    const statement = prepare.call(this, sql)
    if (this !== database) return statement
    if (sql.includes("JOIN json_each(b.result,'$.files') f") && sql.includes('FROM local_scan_batches b')) {
      const iterate = statement.iterate, direct = /\bb\.id\s*=\s*@batch\b/u.test(sql)
      t.mock.method(statement, 'iterate', function* (...args: unknown[]) {
        if (direct) { counts.direct++; directSql = sql; directBindings = args[0] as Record<string, string> }
        else counts.history++
        for (const row of Reflect.apply(iterate, statement, args) as Iterable<Record<string, unknown>>) {
          if (direct) counts.directRows++; else counts.historyRows++
          yield row
        }
      })
    }
    if (sql === 'SELECT result FROM local_catalog_ledger WHERE command_id IN (?,?)') {
      const all = statement.all
      t.mock.method(statement, 'all', (...args: unknown[]) => { const rows = Reflect.apply(all, statement, args); counts.ledgerRows += rows.length; return rows })
    }
    return statement
  })
  return { counts, restore: () => mocked.mock.restore(), plan() {
    assert.ok(directSql && directBindings)
    return prepare.call(database, 'EXPLAIN QUERY PLAN ' + directSql).all(directBindings).map(row => String(row.detail))
  } }
}

test('详情参数：实际Owner三页11曲各核真实资产子账本，只点读当前批，不再逐曲枚举全根历史', async t => {
  const f = await fixture(t), observed = observe(t, f.db), sourceRoot = f.repository.sources.root
  let sourceChecks = 0, opened = 0
  t.mock.method(f.repository.sources, 'root', (id: string) => { sourceChecks++; return sourceRoot(id) })
  const open = t.mock.method(fsp, 'open', async () => { opened++; throw new Error('详情参数不得打开源FD。') })
  syncBuiltinESMExports(); t.after(() => { open.mock.restore(); syncBuiltinESMExports() })
  const albums = await f.owner.queryAlbums({ query: '', rootId: f.root.id, filter: 'all', offset: 0, limit: 200 })
  const album = albums.items.find(value => value.trackCount === 11); assert.ok(album)
  const totalChanges = f.db.prepare('SELECT total_changes() n').get()!.n
  const ids: string[] = []
  for (const offset of [0,4,8]) {
    const page = await f.owner.queryAlbumTracks({ albumKey: album.id, rootId: album.rootId, offset, limit: 4 })
    assert.equal(page.total, 11); assert.equal(page.hasMore, offset + page.items.length < 11)
    for (const item of page.items) { ids.push(item.facts.track.id); assert.deepEqual(item.facts.fileParameters, expected) }
  }
  assert.deepEqual(ids, f.records.map(value => value.track.id)); assert.equal(new Set(ids).size, 11)
  assert.equal(observed.counts.direct, 11); assert.equal(observed.counts.directRows, 11)
  assert.equal(observed.counts.history, 0); assert.equal(observed.counts.historyRows, 0)
  assert.equal(observed.counts.ledgerRows, 11, '每首仍实读原register/replace资产子账本，不能拿state或batch身份代替')
  assert.ok(sourceChecks >= 11); assert.equal(opened, 0)
  const plan = observed.plan(); assert.ok(plan.some(value => /SEARCH b USING INDEX .*\(id=\?\)/u.test(value)), JSON.stringify(plan))
  assert.ok(plan.every(value => !/^SCAN b(?:\s|$)/u.test(value)), JSON.stringify(plan))
  assert.equal(f.db.prepare('SELECT total_changes() n').get()!.n, totalChanges)
  t.diagnostic('11首均有真实主键origin、Source与资产ledger核验；没有历史全根origin查询，也不分配音频FD。')
})

test('详情参数：同签名fresh即使沿用资产仍更新当前batch，缺新资产作者时回原历史，reused也完整追溯', async t => {
  const f = await fixture(t, 3), original = f.records[0]!, fresh = structuredClone(original.input)
  assert.ok(fresh.readFacts); fresh.readFacts.technical.durationSeconds = 2
  const next = f.commit([fresh])
  const current = f.repository.localScan.privateCurrentFileState(f.root.id, fresh.relative)!
  assert.equal(f.db.prepare('SELECT batch_id FROM local_scan_file_state WHERE library_root_id=? AND relative=?').get(f.root.id, fresh.relative)?.batch_id, next.batchId)
  assert.equal(current.jobId, next.jobId); assert.equal(current.value.assetId, original.asset.id)
  const observed = observe(t, f.db)
  assert.deepEqual(f.read(), { ...expected, durationMs: 2000 }); assert.equal(observed.counts.direct, 1); assert.equal(observed.counts.history, 1)
  const reused: ScanPreparedItem = { ...fresh, fields: {}, reused: true, readFacts: null }
  const reusedBatch = f.commit([reused])
  assert.equal(f.db.prepare('SELECT batch_id FROM local_scan_file_state WHERE library_root_id=? AND relative=?').get(f.root.id, fresh.relative)?.batch_id, reusedBatch.batchId)
  observed.counts.direct = observed.counts.history = 0
  assert.deepEqual(f.read(), { ...expected, durationMs: 2000 }); assert.equal(observed.counts.direct, 0); assert.equal(observed.counts.history, 1)
  assert.equal(f.repository.localCatalog.asset(original.asset.id).fileRevision, original.asset.fileRevision)
})

test('详情参数：无新资产作者的同签名fresh历史仍保原200候选上限，不能以当前state绕过旧预算', async t => {
  const f = await fixture(t, 1), original = f.records[0]!
  for (let index = 0; index < 201; index++) f.commit([structuredClone(original.input)])
  const observed = observe(t, f.db)
  assert.equal(f.read(), null)
  assert.equal(observed.counts.direct, 1); assert.equal(observed.counts.history, 1); assert.equal(observed.counts.historyRows, 200)
  // 新签名经原作者真正替换资产后，最新批的真实子账本成为当前证明，参数恢复但仍不使用旧asset。
  const changed = structuredClone(original.input); changed.signature += '-新修订'
  f.commit([changed]); const current = f.repository.localCatalog.asset(original.asset.id)
  assert.equal(f.read(), null); assert.deepEqual(f.read(0, current), expected)
})

test('详情参数：官方替换/重新扫描后每次重读修订，旧asset或新asset无当前解析证明时都不能借旧参数', async t => {
  const f = await fixture(t, 2), original = f.records[0]!
  assert.deepEqual(f.read(), expected)
  const replacement = f.repository.localCatalog.replaceAsset({ commandId: randomUUID(), assetId: original.asset.id,
    expectedFileRevision: original.asset.fileRevision, expectedLocationRevision: original.asset.locationRevision,
    libraryRootId: f.root.id, expectedRootRevision: f.root.revision, relative: original.input.relative, sha256: null, sampleFrames: null, timebaseHz: null })
  assert.equal(f.read(), null); assert.equal(f.read(0, replacement), null)
  const changed = structuredClone(original.input); changed.signature += '-新读取'; assert.ok(changed.readFacts); changed.readFacts.technical.sampleRateHz = 96000
  f.commit([changed]); const latest = f.repository.localCatalog.asset(original.asset.id)
  assert.equal(f.read(), null); assert.deepEqual(f.read(0, latest), { ...expected, sampleRateHz: 96000 })
})

for (const failure of ['signature','readFacts','batch-request','batch-result','ledger'] as const) test(`详情参数：实际目标${failure}损坏仍拒绝，不能让当前批快路冒充证明`, async t => {
  const f = await fixture(t, 2), target = f.records[0]!
  assert.deepEqual(f.read(), expected)
  if (failure === 'signature' || failure === 'readFacts') {
    const row = f.db.prepare('SELECT data FROM local_scan_file_state WHERE library_root_id=? AND relative=?').get(f.root.id, target.input.relative)!
    const value = JSON.parse(String(row.data))
    if (failure === 'signature') value.signature += '-篡改'
    else value.readFacts.technical.durationSeconds = 99
    f.db.prepare('UPDATE local_scan_file_state SET data=? WHERE library_root_id=? AND relative=?').run(JSON.stringify(value), f.root.id, target.input.relative)
    assert.equal(f.read(), null)
  } else if (failure === 'batch-request' || failure === 'batch-result') {
    // 只破坏本测试自有SQLite；正式不可变触发器不允许此写法。读链仍须拒绝真实损坏行。
    f.db.exec('DROP TRIGGER local_scan_batches_immutable')
    if (failure === 'batch-request') {
      const value = { ...f.firstBatch, unknownField: true }
      f.db.prepare('UPDATE local_scan_batches SET request=? WHERE id=?').run(JSON.stringify(value), f.firstBatch.batchId)
      assert.throws(() => f.read())
    } else {
      const row = f.db.prepare('SELECT result FROM local_scan_batches WHERE id=?').get(f.firstBatch.batchId)!, value = JSON.parse(String(row.result))
      value.files[0].assetId = randomUUID()
      f.db.prepare('UPDATE local_scan_batches SET result=? WHERE id=?').run(JSON.stringify(value), f.firstBatch.batchId)
      assert.equal(f.read(), null)
    }
  } else {
    const row = f.db.prepare("SELECT command_id,result FROM local_catalog_ledger WHERE operation='register-asset' AND json_extract(result,'$.id')=?").get(target.asset.id)!
    assert.ok(row); const value = { ...JSON.parse(String(row.result)), unknownField: true }
    f.db.exec('DROP TRIGGER local_catalog_ledger_no_update')
    f.db.prepare('UPDATE local_catalog_ledger SET result=? WHERE command_id=?').run(JSON.stringify(value), String(row.command_id))
    assert.throws(() => f.read())
  }
})

test('详情参数：真实双连接插入坏后继历史且保目标state不变，当前data_version撤销快路并在重开完整核验拒绝', async t => {
  const f = await fixture(t, 2), target = f.records[0]!
  assert.deepEqual(f.read(), expected)
  const before = f.db.prepare('PRAGMA data_version').get()!.data_version
  const originalState = f.db.prepare('SELECT data FROM local_scan_file_state WHERE library_root_id=? AND relative=?').get(f.root.id, target.input.relative)?.data
  assert.equal(typeof originalState, 'string')
  const external = new DatabaseSync(f.filePath)
  try {
    external.exec('PRAGMA foreign_keys=ON')
    external.prepare("INSERT INTO local_scan_batches(id,job_id,fingerprint,request,phase,result) VALUES(?,?,?,'{','committed','{')")
      .run(randomUUID(), f.firstBatch.jobId, 'f'.repeat(64))
  } finally { external.close() }
  assert.notEqual(f.db.prepare('PRAGMA data_version').get()!.data_version, before)
  assert.equal(f.db.prepare('SELECT data FROM local_scan_file_state WHERE library_root_id=? AND relative=?').get(f.root.id, target.input.relative)?.data, originalState)
  assert.throws(() => f.read(), '不能在目标数据未变化时忽略外部追加的未知历史')
  f.repository.close()
  const reopened = createCollectionRepository({ filePath: f.filePath }); f.copies.add(reopened)
  assert.throws(() => reopened.localCatalog.roots(), '新Owner仍完整核验，坏批次不能进入新作者')
})

test('详情参数：原foreign_keys约束失效、Source撤销及root重关联仍拒绝旧证明', async t => {
  const f = await fixture(t, 2)
  assert.deepEqual(f.read(), expected)
  f.db.exec('PRAGMA foreign_keys=OFF')
  try { assert.throws(() => f.read()) } finally { f.db.exec('PRAGMA foreign_keys=ON') }
  assert.deepEqual(f.read(), expected)
  const replacementDirectory = path.join(path.dirname(f.media), '合成另一空来源'); await mkdir(replacementDirectory)
  const second = f.repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(replacementDirectory))
  f.repository.localCatalog.relinkRoot({ commandId: randomUUID(), rootId: f.root.id, expectedRevision: f.root.revision, sourceRootId: second.id, role: 'library' })
  assert.equal(f.read(), null)
  f.repository.sources.revoke({ commandId: randomUUID(), id: second.id }); assert.equal(f.read(), null)
})

test('详情参数：真实关闭重开后原job/batch/raw与技术事实不变，没有跨连接或跨调用证书复用', async t => {
  const f = await fixture(t, 3), target = f.records[0]!, state = f.repository.localScan.privateCurrentFileState(f.root.id, target.input.relative)!
  assert.deepEqual(f.read(), expected); f.repository.close()
  const reopened = createCollectionRepository({ filePath: f.filePath }); f.copies.add(reopened)
  reopened.localCatalog.roots()
  const db = reopened.localCatalog.privateRead(value => value), observed = observe(t, db)
  const before = db.prepare('SELECT total_changes() n').get()!.n
  const asset = reopened.localCatalog.asset(target.asset.id)
  assert.deepEqual(reopened.localScan.privateCurrentFileState(f.root.id, target.input.relative), state)
  for (let index = 0; index < 2; index++) assert.deepEqual(reopened.localScan.privateDisplayFileParameters(target.track.id, asset), expected)
  assert.equal(observed.counts.direct, 2); assert.equal(observed.counts.history, 0); assert.equal(observed.counts.ledgerRows, 2)
  assert.equal(db.prepare('SELECT total_changes() n').get()!.n, before)
})
