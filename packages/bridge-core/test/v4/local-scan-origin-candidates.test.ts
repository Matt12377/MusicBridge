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
import { verifyLocalScanDatabase, type ScanPreparedBatch, type ScanPreparedItem } from '../../src/collection/local-scan-store.js'
import { authorizeSourceDirectory, sourceRootAvailability } from '../../src/recording/source-files.js'

// 仅自建SQLite及真实授权的空目录；Scan标签和技术事实明确为合成输入，不读取音频、NAS或正式数据。
const parserVersion = 'music-metadata-11.15.0/mbrs003-v1'
const albumTitle = '合成复用参数专辑'
const expected: dto.FileAudioParameters = { container: 'WAVE', codec: 'PCM', lossless: true, sampleRateHz: 48000,
  channels: 2, bitsPerSample: 16, durationMs: 1000, evidence: 'bounded-parser-reported' }
function audio(relative: string, number: number): ScanPreparedItem {
  return { relative, signature: `合成签名-${relative}`, parserVersion, outcome: 'accepted',
    fields: { title: `合成曲目${number}`, artist: '合成艺人', album: albumTitle, disc: '1', track: String(number) },
    failureCode: null, reused: false, readFacts: { technical: { container: 'WAVE', codec: 'PCM', lossless: true,
      sampleRateHz: 48000, channels: 2, bitsPerSample: 16, durationSeconds: 1, evidence: 'bounded-parser-reported' },
    coverEvidence: [], readEvidence: { bytesRead: 44, readCalls: 1, maxReadBytes: 44, allocationBytes: 44,
      elapsedMs: 1, wholeAudioHash: false, wholeAudioDecode: false } } }
}
const reuse = (item: ScanPreparedItem): ScanPreparedItem => ({ ...structuredClone(item), fields: {}, reused: true, readFacts: null })
type Repository = ReturnType<typeof createCollectionRepository>

async function fixture(t: TestContext, count = 11, withCommitFault = false) {
  const temporary = process.env.TMPDIR
  assert.ok(temporary && path.isAbsolute(temporary))
  if (process.platform === 'darwin') assert.ok(path.resolve(temporary).startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'))
  const directory = await mkdtemp(path.join(temporary, 'scan-origin-candidates-'))
  const media = path.join(directory, '合成空来源'), filePath = path.join(directory, 'collection.sqlite')
  await mkdir(media)
  let failCommit = false, commitFaults = 0, beforeQueueCommit: (() => void) | undefined
  const repository = createCollectionRepository({ filePath, ...(withCommitFault ? { beforeCommit(action: string) {
    if (failCommit && action === 'local-scan:commit-batch') { commitFaults++; throw new Error('合成COMMIT前故障') }
    if (action === 'save-mb-queue') beforeQueueCommit?.()
  } } : {}) }), copies = new Set<Repository>()
  const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media))
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' })
  const datasetId = randomUUID()
  let owner: ReturnType<typeof createLocalAlbumOwnerService> | undefined
  t.after(async () => { owner?.close(); for (const copy of copies) copy.close(); repository.close(); await rm(directory, { recursive: true, force: true }) })
  function prepare(items: ScanPreparedItem[]) {
    const current = repository.localCatalog.root(root.id)
    const pending = repository.localScan.start({ commandId: randomUUID(), datasetId, libraryRootId: current.id,
      expectedRootRevision: current.revision, parserVersion }).job
    const job = repository.localScan.resume({ commandId: randomUUID(), jobId: pending.jobId, expectedRevision: pending.jobRevision })
    const batch: ScanPreparedBatch = { batchId: randomUUID(), jobId: job.jobId, expectedJobRevision: job.jobRevision,
      checkpointBefore: job.checkpointRef, items, frontier: [], completed: true }
    repository.localScan.privatePrepareBatch({ commandId: randomUUID(), jobId: job.jobId, batch })
    const commandId = randomUUID()
    return { batch, job, commit() { return repository.localScan.privateCommitBatch({ commandId, jobId: job.jobId,
      batchId: batch.batchId, expectedRevision: job.jobRevision }) } }
  }
  function commit(items: ScanPreparedItem[]) { const staged = prepare(items); assert.equal(staged.commit().phase, 'completed'); return staged.batch }
  const inputs = Array.from({ length: count }, (_, index) => audio(`目标目录/${String(index + 1).padStart(2, '0')}.wav`, index + 1))
  const firstBatch = commit(inputs)
  const records = inputs.map(input => {
    const state = repository.localScan.privateCurrentFileState(root.id, input.relative)
    assert.ok(state?.value.trackId && state.value.assetId)
    return { input, track: repository.localCatalog.track(state.value.trackId), asset: repository.localCatalog.asset(state.value.assetId),
      metadata: repository.localCatalog.metadata(state.value.trackId) }
  })
  const db = repository.localCatalog.privateRead(value => value)
  const read = (index = 0, asset = repository.localCatalog.asset(records[index]!.asset.id)) =>
    repository.localScan.privateDisplayFileParameters(records[index]!.track.id, asset)
  function cold() { verifyLocalScanDatabase(db) }
  function rescan() { return commit(inputs.map(reuse)) }
  owner = createLocalAlbumOwnerService({ repository, assertCurrent() {},
    readRootViews: async () => Promise.all(repository.localCatalog.roots().map(async current => ({ root: current, label: '合成来源',
      availability: await sourceRootAvailability(repository.sources.root(current.sourceRootId)) }))),
    async readArtwork(): Promise<never> { throw new Error('参数Gate不读取图像或音频FD') },
  })
  return { repository, root, source, datasetId, owner, copies, filePath, directory, media, db, inputs, records, firstBatch,
    prepare, commit, cold, rescan, read, commitFaultCount() { return commitFaults }, setCommitFailure(value: boolean) { failCommit = value },
    setQueueCommitHook(hook: () => void) { beforeQueueCommit = hook } }
}

// 只记录原SQL是否真的执行；不改任何返回行或Source资格，也不绑定新的内部缓存函数名。
function observe(t: TestContext, database: DatabaseSync) {
  const prepare = DatabaseSync.prototype.prepare
  const counts = { history: 0, coldBatches: 0, pointReads: 0, ledgerProbes: 0, ledgerRows: 0 }
  const mocked = t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    const statement = prepare.call(this, sql)
    if (this !== database) return statement
    const origin = sql.includes('FROM local_scan_batches b') && sql.includes('json_each(b.result')
    const point = /\b(?:b\.)?id\s*=\s*(?:@|:|\$|\?)/u.test(sql)
    const history = origin && !point
    const cold = sql.includes('FROM local_scan_batches ORDER BY rowid')
    for (const method of ['get', 'all', 'iterate'] as const) {
      const run = statement[method]
      t.mock.method(statement, method, (...args: unknown[]) => {
        if (history) counts.history++
        if (cold) counts.coldBatches++
        if (sql.includes('FROM local_scan_batches') && point) counts.pointReads++
        return Reflect.apply(run, statement, args)
      })
    }
    if (sql === 'SELECT result FROM local_catalog_ledger WHERE command_id IN (?,?)') {
      const all = statement.all
      t.mock.method(statement, 'all', (...args: unknown[]) => {
        const rows = Reflect.apply(all, statement, args)
        counts.ledgerProbes++; counts.ledgerRows += rows.length
        return rows
      })
    }
    return statement
  })
  return { counts, restore() { mocked.mock.restore() } }
}
async function boundary(t: TestContext, withCommitFault = false) {
  const f = await fixture(t, 1, withCommitFault)
  // 原始资产作者 + 199个无新资产账本的fresh = 正好200候选；reused本身不占候选。
  for (let index = 0; index < 199; index++) f.commit([structuredClone(f.inputs[0]!)])
  f.rescan(); f.cold()
  assert.deepEqual(f.read(), expected)
  return f
}
function rawCommitResult(f: Awaited<ReturnType<typeof fixture>>, staged: ReturnType<typeof f.prepare>) {
  const current = f.repository.localScan.privateCurrentFileState(f.root.id, f.inputs[0]!.relative)
  assert.ok(current)
  return { job: { ...staged.job, jobRevision: (BigInt(staged.job.jobRevision) + 1n).toString(), phase: 'completed',
    checkpointRef: randomUUID(), progress: { visited: '1', accepted: '1', rejected: '0' } }, files: [current.value] }
}

test('origin候选：重扫复用11曲后实际Owner三页仍逐项核ledger且不枚举全根历史', async t => {
  const f = await fixture(t)
  for (let index = 0; index < 3; index++) f.commit([audio(`其它目录${index}/01.wav`, 1)])
  const batch = f.rescan()
  for (const record of f.records) {
    const row = f.db.prepare('SELECT job_id,batch_id,data FROM local_scan_file_state WHERE library_root_id=? AND relative=?').get(f.root.id, record.input.relative)
    assert.equal(row?.batch_id, batch.batchId); assert.equal(row?.job_id, batch.jobId)
    assert.equal(JSON.parse(String(row?.data)).assetId, record.asset.id)
  }
  f.cold()
  const albums = await f.owner.queryAlbums({ query: '', rootId: f.root.id, filter: 'all', offset: 0, limit: 200 })
  const album = albums.items.find(item => item.trackCount === 11); assert.ok(album)
  const observed = observe(t, f.db), root = f.repository.sources.root
  let sourceChecks = 0, opened = 0
  t.mock.method(f.repository.sources, 'root', (id: string) => { sourceChecks++; return root(id) })
  const open = t.mock.method(fsp, 'open', async () => { opened++; throw new Error('参数读取不可分配源FD') })
  syncBuiltinESMExports(); t.after(() => { open.mock.restore(); syncBuiltinESMExports() })
  const before = f.db.prepare('SELECT total_changes() n').get()!.n, ids: string[] = []
  for (const offset of [0,4,8]) {
    const page = await f.owner.queryAlbumTracks({ albumKey: album.id, rootId: album.rootId, offset, limit: 4 })
    assert.equal(page.total, 11); assert.equal(page.hasMore, offset + page.items.length < 11)
    for (const item of page.items) { ids.push(item.facts.track.id); assert.deepEqual(item.facts.fileParameters, expected) }
  }
  assert.deepEqual(ids, f.records.map(record => record.track.id)); assert.equal(new Set(ids).size, 11)
  assert.equal(observed.counts.history, 0); assert.equal(observed.counts.coldBatches, 0)
  assert.ok(observed.counts.pointReads >= 11); assert.equal(observed.counts.ledgerProbes, 11); assert.equal(observed.counts.ledgerRows, 11)
  assert.ok(sourceChecks >= 11); assert.equal(opened, 0); assert.equal(f.db.prepare('SELECT total_changes() n').get()!.n, before)
  for (const record of f.records) assert.deepEqual(f.repository.localCatalog.metadata(record.track.id), record.metadata)
})

test('origin候选：无资产子账本fresh仍计入最新200，作者位于第200可见、第201不可见', async t => {
  const f = await fixture(t, 1)
  for (let index = 0; index < 198; index++) f.commit([structuredClone(f.inputs[0]!)])
  f.rescan(); f.cold()
  const observed = observe(t, f.db)
  assert.deepEqual(f.read(), expected); assert.equal(observed.counts.ledgerProbes, 199)
  observed.restore()
  f.commit([structuredClone(f.inputs[0]!)]); f.rescan(); f.cold()
  const at200 = observe(t, f.db)
  assert.deepEqual(f.read(), expected); assert.equal(at200.counts.ledgerProbes, 200); assert.equal(at200.counts.history, 0)
  at200.restore()
  f.commit([structuredClone(f.inputs[0]!)]); f.rescan(); f.cold()
  const at201 = observe(t, f.db)
  assert.equal(f.read(), null); assert.equal(at201.counts.ledgerProbes, 200); assert.equal(at201.counts.ledgerRows, 0)
  assert.equal(at201.counts.history, 0, '完整候选索引截在原200处，不能继续检索第201个旧作者')
})

test('origin候选：prepared不能提前成为origin；真实同签名/新签名提交后不复用旧参数或旧asset', async t => {
  const f = await fixture(t, 1); f.rescan(); f.cold(); assert.deepEqual(f.read(), expected)
  const fresh = structuredClone(f.inputs[0]!); assert.ok(fresh.readFacts); fresh.readFacts.technical.durationSeconds = 2
  const staged = f.prepare([fresh]); assert.deepEqual(f.read(), expected)
  assert.equal(staged.commit().phase, 'completed')
  assert.deepEqual(f.read(), { ...expected, durationMs: 2000 }, '技术参数来自当前真实批，不能缓存旧origin的readFacts')
  const changed = structuredClone(fresh); changed.signature += '-新签名'; assert.ok(changed.readFacts); changed.readFacts.technical.durationSeconds = 3
  const replacement = f.prepare([changed]); assert.deepEqual(f.read(), { ...expected, durationMs: 2000 })
  assert.equal(replacement.commit().phase, 'completed')
  assert.equal(f.read(0, f.records[0]!.asset), null)
  assert.deepEqual(f.read(), { ...expected, durationMs: 3000 })
})

test('origin候选：第201候选所在事务真实回滚后不发布；同一原批重试COMMIT才更新名额', async t => {
  const f = await boundary(t, true), staged = f.prepare([structuredClone(f.inputs[0]!)])
  f.setCommitFailure(true)
  // Repository会把非公开内部错误映射为库存不可用；用真实hook计数证明故障确实抵达COMMIT前。
  try { assert.throws(() => staged.commit(), /库存暂时不可用/u); assert.equal(f.commitFaultCount(), 1) } finally { f.setCommitFailure(false) }
  assert.equal(f.db.prepare('SELECT phase FROM local_scan_batches WHERE id=?').get(staged.batch.batchId)?.phase, 'prepared')
  assert.equal(f.repository.localScan.privateCurrentFileState(f.root.id, f.inputs[0]!.relative)?.value.signature, f.inputs[0]!.signature)
  assert.deepEqual(f.read(), expected, '回滚留下的total_changes变化不能发布第201候选')
  assert.equal(staged.commit().phase, 'completed')
  assert.equal(f.read(), null, '实际COMMIT后原作者已经落在原200候选范围之外')
})

test('origin候选：未知prepared到committed不增batch总数也必须撤资格，回原200查询', async t => {
  const f = await boundary(t), staged = f.prepare([structuredClone(f.inputs[0]!)])
  const before = f.db.prepare('SELECT count(*) n FROM local_scan_batches').get()!.n
  assert.deepEqual(f.read(), expected)
  // 仅自有库故意绕过作者；原immutable触发器允许这一次phase转换，冷核仍会拒绝缺失checkpoint/commit receipt。
  assert.equal(f.db.prepare("UPDATE local_scan_batches SET phase='committed',result=? WHERE id=?")
    .run(JSON.stringify(rawCommitResult(f, staged)), staged.batch.batchId).changes, 1)
  assert.equal(f.db.prepare('SELECT count(*) n FROM local_scan_batches').get()!.n, before)
  const observed = observe(t, f.db)
  assert.equal(f.read(), null); assert.ok(observed.counts.history > 0, '总batch数未变也不能续用未知phase写入前的候选')
})

test('origin候选：未知新增批次不改变目标state，也必须按原200候选拒绝旧作者', async t => {
  const f = await boundary(t), staged = f.prepare([structuredClone(f.inputs[0]!)])
  const batchId = randomUUID(), value = { ...staged.batch, batchId }
  f.db.prepare('INSERT INTO local_scan_batches(id,job_id,fingerprint,request,phase,result) VALUES(?,?,?,?,?,?)')
    .run(batchId, value.jobId, 'f'.repeat(64), JSON.stringify(value), 'committed', JSON.stringify(rawCommitResult(f, staged)))
  const observed = observe(t, f.db)
  assert.equal(f.read(), null); assert.ok(observed.counts.history > 0)
})

test('origin候选：INSERT OR REPLACE保持批次数/schema/data水位时，total_changes仍撤销旧候选', async t => {
  const f = await boundary(t), unrelated = f.commit([audio('其它目录/01.wav', 1)])
  assert.deepEqual(f.read(), expected)
  assert.equal(f.db.prepare('PRAGMA recursive_triggers').get()!.recursive_triggers, 0)
  const count = f.db.prepare('SELECT count(*) n FROM local_scan_batches').get()!.n
  const schema = f.db.prepare('PRAGMA schema_version').get()!.schema_version
  const version = f.db.prepare('PRAGMA data_version').get()!.data_version
  const changes = f.db.prepare('SELECT total_changes() n').get()!.n
  const oldRow = f.db.prepare('SELECT rowid,request,result FROM local_scan_batches WHERE id=?').get(unrelated.batchId)
  assert.ok(oldRow)
  const request = JSON.parse(String(oldRow.request)), result = JSON.parse(String(oldRow.result))
  request.items = [structuredClone(f.inputs[0]!)]
  result.files = [f.repository.localScan.privateCurrentFileState(f.root.id, f.inputs[0]!.relative)!.value]
  // 仅自有库破坏未知写：删除触发器不会因默认recursive_triggers=OFF而保护REPLACE。
  // 原无关批变成目标第201候选，其子账本仍是其它资产，不能提前过滤这个不证明的候选。
  assert.equal(f.db.prepare('INSERT OR REPLACE INTO local_scan_batches(id,job_id,fingerprint,request,phase,result) VALUES(?,?,?,?,?,?)')
    .run(unrelated.batchId, unrelated.jobId, 'f'.repeat(64), JSON.stringify(request), 'committed', JSON.stringify(result)).changes, 1)
  assert.equal(f.db.prepare('SELECT count(*) n FROM local_scan_batches').get()!.n, count)
  assert.equal(f.db.prepare('PRAGMA schema_version').get()!.schema_version, schema)
  assert.equal(f.db.prepare('PRAGMA data_version').get()!.data_version, version)
  assert.notEqual(f.db.prepare('SELECT total_changes() n').get()!.n, changes)
  assert.notEqual(f.db.prepare('SELECT rowid FROM local_scan_batches WHERE id=?').get(unrelated.batchId)?.rowid, oldRow.rowid)
  const observed = observe(t, f.db)
  assert.equal(f.read(), null); assert.ok(observed.counts.history > 0)
})

test('origin候选：未知DDL只撤索引并回原SQL，不能把额外index当成业务拒绝', async t => {
  const f = await fixture(t, 1); f.rescan(); f.cold(); assert.deepEqual(f.read(), expected)
  f.db.exec('CREATE INDEX synthetic_origin_candidate_extra ON local_scan_batches(fingerprint)')
  const observed = observe(t, f.db)
  assert.deepEqual(f.read(), expected); assert.ok(observed.counts.history > 0)
})

test('origin候选：同连接无关真实DML也撤索引并回原SQL，未知变化不能凭结构水位续用', async t => {
  const f = await fixture(t, 1); f.rescan(); f.cold(); assert.deepEqual(f.read(), expected)
  const before = f.db.prepare('SELECT total_changes() n').get()!.n
  assert.equal(f.db.prepare("UPDATE physical_sequences SET next_value=next_value+1 WHERE format='cassette'").run().changes, 1)
  assert.notEqual(f.db.prepare('SELECT total_changes() n').get()!.n, before)
  const observed = observe(t, f.db)
  assert.deepEqual(f.read(), expected); assert.ok(observed.counts.history > 0); assert.equal(observed.counts.coldBatches, 0)
  assert.equal(observed.counts.ledgerRows, 1)
})

for (const damage of ['ledger-shape','ledger-asset','origin-result','origin-request','origin-job'] as const) test(`origin候选：已命中后同连接${damage}篡改仍核原行并拒绝`, async t => {
  const f = await fixture(t, 1), record = f.records[0]!
  f.rescan(); f.cold(); assert.deepEqual(f.read(), expected)
  const observed = observe(t, f.db)
  if (damage === 'ledger-shape' || damage === 'ledger-asset') {
    const row = f.db.prepare("SELECT command_id,result FROM local_catalog_ledger WHERE operation='register-asset' AND json_extract(result,'$.id')=?").get(record.asset.id)
    assert.ok(row); const value = JSON.parse(String(row.result))
    if (damage === 'ledger-shape') value.unknownField = true
    else value.fileRevision = (BigInt(value.fileRevision) + 1n).toString()
    f.db.exec('DROP TRIGGER local_catalog_ledger_no_update')
    f.db.prepare('UPDATE local_catalog_ledger SET result=? WHERE command_id=?').run(JSON.stringify(value), String(row.command_id))
    if (damage === 'ledger-shape') assert.throws(() => f.read())
    else assert.equal(f.read(), null)
  } else if (damage === 'origin-result' || damage === 'origin-request') {
    f.db.exec('DROP TRIGGER local_scan_batches_immutable')
    const field = damage === 'origin-result' ? 'result' : 'request'
    const row = f.db.prepare(`SELECT ${field} value FROM local_scan_batches WHERE id=?`).get(f.firstBatch.batchId)
    assert.ok(row); const value = JSON.parse(String(row.value))
    if (damage === 'origin-result') value.files[0].signature += '-篡改'
    else value.items[0].signature += '-篡改'
    f.db.prepare(`UPDATE local_scan_batches SET ${field}=? WHERE id=?`).run(JSON.stringify(value), f.firstBatch.batchId)
    assert.equal(f.read(), null, '原JSON谓词必须重核，不能把候选index当成阳性证明')
  } else {
    const row = f.db.prepare('SELECT data FROM local_scan_jobs WHERE id=?').get(f.firstBatch.jobId)
    assert.ok(row); const value = JSON.parse(String(row.data)); value.rootRevision = '999'
    f.db.prepare('UPDATE local_scan_jobs SET data=? WHERE id=?').run(JSON.stringify(value), f.firstBatch.jobId)
    assert.equal(f.read(), null, '原job source/root修订必须重核，不能用冷核保存的job对象')
  }
  assert.ok(observed.counts.history > 0, '未知写入后只沿原历史证明，不续用已命中的候选')
})

test('origin候选：外部data_version变化且目标state不变仍拒绝，坏历史在真实重开完整核验也拒绝', async t => {
  const f = await fixture(t, 1); f.rescan(); f.cold(); assert.deepEqual(f.read(), expected)
  const stateSql = 'SELECT data FROM local_scan_file_state WHERE library_root_id=? AND relative=?'
  const beforeState = f.db.prepare(stateSql).get(f.root.id, f.inputs[0]!.relative)!.data
  const version = f.db.prepare('PRAGMA data_version').get()!.data_version
  const external = new DatabaseSync(f.filePath)
  try {
    external.exec('PRAGMA foreign_keys=ON')
    external.prepare("INSERT INTO local_scan_batches(id,job_id,fingerprint,request,phase,result) VALUES(?,?,?,'{','committed','{')")
      .run(randomUUID(), f.firstBatch.jobId, 'f'.repeat(64))
  } finally { external.close() }
  assert.notEqual(f.db.prepare('PRAGMA data_version').get()!.data_version, version)
  assert.equal(f.db.prepare(stateSql).get(f.root.id, f.inputs[0]!.relative)!.data, beforeState)
  assert.throws(() => f.read())
  f.owner.close(); f.repository.close()
  const reopened = createCollectionRepository({ filePath: f.filePath }); f.copies.add(reopened)
  assert.throws(() => reopened.localCatalog.roots())
})

test('origin候选：真实关闭重开重建本连接候选，11项ID/raw/批次与原技术事实不变', async t => {
  const f = await fixture(t), batch = f.rescan(); f.cold()
  const states = f.records.map(record => f.repository.localScan.privateCurrentFileState(f.root.id, record.input.relative))
  for (let index = 0; index < 11; index++) assert.deepEqual(f.read(index), expected)
  f.owner.close(); f.repository.close()
  const reopened = createCollectionRepository({ filePath: f.filePath }); f.copies.add(reopened)
  reopened.localCatalog.roots()
  const db = reopened.localCatalog.privateRead(value => value), before = db.prepare('SELECT total_changes() n').get()!.n
  const observed = observe(t, db)
  for (const [index, record] of f.records.entries()) {
    assert.deepEqual(reopened.localScan.privateCurrentFileState(f.root.id, record.input.relative), states[index])
    assert.deepEqual(reopened.localCatalog.track(record.track.id), record.track)
    assert.deepEqual(reopened.localCatalog.asset(record.asset.id), record.asset)
    assert.deepEqual(reopened.localCatalog.metadata(record.track.id), record.metadata)
    assert.equal(db.prepare('SELECT batch_id FROM local_scan_file_state WHERE library_root_id=? AND relative=?').get(f.root.id, record.input.relative)?.batch_id, batch.batchId)
    assert.deepEqual(reopened.localScan.privateDisplayFileParameters(record.track.id, reopened.localCatalog.asset(record.asset.id)), expected)
  }
  assert.equal(observed.counts.history, 0); assert.equal(observed.counts.coldBatches, 0); assert.equal(observed.counts.ledgerRows, 11)
  assert.equal(db.prepare('SELECT total_changes() n').get()!.n, before)
})

test('origin候选：真实队列一行CAS提交保留纯候选，COMMIT前未知附加写则撤销', async t => {
  const f = await fixture(t, 1, true); f.rescan(); f.cold()
  const queue: dto.MBQueueRecord = { schemaVersion: '1.2', datasetId: f.datasetId, queueId: randomUUID(), revision: '1', currentEntryId: null,
    restartPolicy: { reResolve: true, autoplay: false }, entries: [{ entryId: randomUUID(), entryRevision: '1', source: { kind: 'netease', trackId: '123' }, quality: 'auto' }] }
  const observed = observe(t, f.db), before = Number(f.db.prepare('SELECT total_changes() n').get()!.n)
  assert.deepEqual(f.repository.mbQueue.save({ expectedRevision: '0', queue }), queue)
  assert.equal(Number(f.db.prepare('SELECT total_changes() n').get()!.n), before + 1)
  assert.deepEqual(f.read(), expected); assert.equal(observed.counts.history, 0)
  f.setQueueCommitHook(() => { f.db.prepare("UPDATE physical_sequences SET next_value=next_value+1 WHERE format='cassette'").run() })
  const next = { ...queue, revision: '2' }
  assert.deepEqual(f.repository.mbQueue.save({ expectedRevision: '1', queue: next }), next)
  assert.deepEqual(f.read(), expected); assert.equal(observed.counts.history, 1, '未知附加DML不能借队列成功续接索引')
})

test('origin候选：未知写后后台分段重建完整集合，期间让出事件循环且读取零写入', async t => {
  const f = await boundary(t)
  f.db.prepare("UPDATE physical_sequences SET next_value=next_value+1 WHERE format='cassette'").run()
  const before = f.db.prepare('SELECT total_changes() n').get()!.n
  let ticks = 0, stopped = false
  const tick = () => { if (!stopped) { ticks++; setImmediate(tick) } }
  setImmediate(tick)
  try { await f.repository.localScan.privateWarmDisplayFileParameters() } finally { stopped = true }
  assert.ok(ticks > 1, '不能以一个同步大遍历阻塞前台')
  const observed = observe(t, f.db)
  assert.deepEqual(f.read(), expected); assert.equal(observed.counts.history, 0); assert.equal(observed.counts.ledgerProbes, 200)
  assert.equal(f.db.prepare('SELECT total_changes() n').get()!.n, before)
})

test('origin候选：后台分段期间真实新提交使整件弃，不发布前缀；安静后重建才可命中', async t => {
  const f = await fixture(t, 1); f.rescan(); f.cold()
  f.db.prepare("UPDATE physical_sequences SET next_value=next_value+1 WHERE format='cassette'").run()
  const warming = f.repository.localScan.privateWarmDisplayFileParameters()
  f.commit([audio('新目录/01.wav', 1)])
  await warming
  const observed = observe(t, f.db)
  assert.deepEqual(f.read(), expected); assert.equal(observed.counts.history, 1)
  await f.repository.localScan.privateWarmDisplayFileParameters()
  observed.counts.history = 0
  assert.deepEqual(f.read(), expected); assert.equal(observed.counts.history, 0)
})
