import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { MBQueueRecord } from '@music-bridge/contracts'
import type { ScanPreparedBatch } from '../../src/collection/local-scan-store.js'
import { openCollectionDataset } from '../../src/recording/restore-dataset-runtime.js'
import { authorizeSourceDirectory } from '../../src/recording/source-files.js'

const page = { offset: 0, limit: 1 }
const parserVersion = 'music-metadata-11.15.0/mbrs003-v1'
const catalogPass = 'SELECT rowid AS _ledger_rowid,* FROM local_catalog_ledger ORDER BY rowid'
const scanPass = 'SELECT * FROM local_scan_jobs ORDER BY rowid'
const queuePass = "SELECT sql FROM sqlite_master WHERE type='table' AND name='mb_playback_queue'"
const artworkPass = "SELECT type,name,sql FROM sqlite_schema WHERE tbl_name IN ('local_artwork_candidates','local_artwork_selections','local_artwork_ledger','local_artwork_create_intents') AND name NOT LIKE 'sqlite_%'"
const artworkDrop = 'DROP TABLE local_artwork_selections; DROP TABLE local_artwork_candidates; DROP TABLE local_artwork_ledger; DROP TABLE local_artwork_create_intents;'

async function directory(t: TestContext) {
  const temporary = process.env.TMPDIR
  assert.ok(temporary && path.isAbsolute(temporary))
  if (process.platform === 'darwin') assert.ok(path.resolve(temporary).startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'))
  const value = await mkdtemp(path.join(temporary, 'startup-single-verify-'))
  t.after(() => rm(value, { recursive: true, force: true }))
  return value
}
function inspect<T>(file: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file, { readOnly: true, allowExtension: false })
  try { return read(db) } finally { db.close() }
}
function mutate(file: string, sql: string): void {
  const db = new DatabaseSync(file, { allowExtension: false })
  try { db.exec(sql) } finally { db.close() }
}
function facts(file: string) {
  return inspect(file, db => ({
    version: db.prepare('PRAGMA user_version').get(),
    schema: db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(),
    jobs: db.prepare('SELECT * FROM local_scan_jobs ORDER BY rowid').all(),
    receipts: db.prepare('SELECT * FROM local_scan_receipts ORDER BY rowid').all(),
    batches: db.prepare('SELECT * FROM local_scan_batches ORDER BY rowid').all(),
    checkpoints: db.prepare('SELECT * FROM local_scan_checkpoints ORDER BY rowid').all(),
    files: db.prepare('SELECT * FROM local_scan_file_state ORDER BY rowid').all(),
    tracks: db.prepare('SELECT * FROM local_catalog_tracks ORDER BY rowid').all(),
    sources: db.prepare('SELECT * FROM source_roots ORDER BY rowid').all(),
    queue: db.prepare('SELECT * FROM mb_playback_queue ORDER BY rowid').all(),
  }))
}
async function current(t: TestContext) {
  const root = await directory(t), media = path.join(root, '真实授权合成空目录')
  await mkdir(media)
  const opened = await openCollectionDataset(root)
  t.after(() => opened.close())
  const repository = opened.repository
  repository.receive({ commandId: randomUUID(), model: { brand: '合成', name: '冷启保留', edition: '合成版本', year: 1990, format: 'cassette', tapeType: 'II', identification: 'verified' }, lengthMinutes: 60,
    quantities: { openedBlank: 1, sealedBlank: 0, legacyUsed: 0, unclassified: 0 } })
  const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media))
  const library = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' })
  const started = repository.localScan.start({ commandId: randomUUID(), datasetId: opened.datasetId, libraryRootId: library.id, expectedRootRevision: library.revision, parserVersion }).job
  const job = repository.localScan.resume({ commandId: randomUUID(), jobId: started.jobId, expectedRevision: started.jobRevision })
  const batch: ScanPreparedBatch = { batchId: randomUUID(), jobId: job.jobId, expectedJobRevision: job.jobRevision, checkpointBefore: job.checkpointRef,
    items: [{ relative: '纯合成记录.wav', signature: '1:2:3:4:5', parserVersion, outcome: 'accepted', fields: { title: '原始标签', artist: '合成艺人', album: '合成专辑' }, failureCode: null, reused: false,
      readFacts: { technical: { container: 'WAVE', codec: 'PCM', lossless: true, sampleRateHz: 48000, channels: 2, bitsPerSample: 16, durationSeconds: 1, evidence: 'bounded-parser-reported' }, coverEvidence: [],
        readEvidence: { bytesRead: 44, readCalls: 1, maxReadBytes: 44, allocationBytes: 44, elapsedMs: 1, wholeAudioHash: false, wholeAudioDecode: false } } }], frontier: [''], completed: false }
  repository.localScan.privatePrepareBatch({ commandId: randomUUID(), jobId: job.jobId, batch })
  const running = repository.localScan.privateCommitBatch({ commandId: randomUUID(), jobId: job.jobId, batchId: batch.batchId, expectedRevision: job.jobRevision })
  assert.equal(running.phase, 'running')
  const queue: MBQueueRecord = { schemaVersion: '1.2', datasetId: opened.datasetId, queueId: randomUUID(), revision: '1', currentEntryId: null,
    restartPolicy: { reResolve: true, autoplay: false }, entries: [{ entryId: randomUUID(), entryRevision: '1', source: { kind: 'netease', trackId: '123' }, quality: 'auto' }] }
  repository.mbQueue.save({ expectedRevision: '0', queue })
  const result = { directory: root, file: opened.databaseFile, datasetId: opened.datasetId, job: running, queue }
  opened.close()
  return result
}

type Stage = 'inspection' | 'actual'
type Event = { kind: 'prepare' | 'exec' | 'close'; sql: string; connection: DatabaseSync; stage: Stage; transaction: boolean }
/** 保留原生方法的一参形状；只观察真实连接，不替换核验结果或跨连接传证书。 */
function observe(t: TestContext, rejectRecoveryCommit = false, race: { afterInspectionClose?(): void; beforeActualBegin?(): void } = {}) {
  const prepare = DatabaseSync.prototype.prepare, exec = DatabaseSync.prototype.exec, close = DatabaseSync.prototype.close
  const states = new Map<DatabaseSync, { stage: Stage; transaction: boolean }>()
  const events: Event[] = []
  let rejected = false, changedAfterInspection = false, changedBeforeBegin = false
  const execMock = t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
    if (sql === 'PRAGMA busy_timeout=1000') states.set(this, { stage: 'actual', transaction: false })
    if (sql === 'PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;') states.set(this, { stage: 'inspection', transaction: false })
    if (sql === 'PRAGMA busy_timeout=1000') states.set(this, { stage: 'actual', transaction: false })
    const state = states.get(this)
    if (state) {
      events.push({ kind: 'exec', sql, connection: this, ...state })
      if (!changedBeforeBegin && state.stage === 'actual' && sql === 'BEGIN IMMEDIATE') {
        changedBeforeBegin = true
        race.beforeActualBegin?.()
      }
      if (rejectRecoveryCommit && !rejected && state.stage === 'actual' && sql === 'COMMIT'
        && events.some(event => event.connection === this && event.sql.startsWith('UPDATE local_scan_jobs SET data='))) {
        rejected = true
        throw new Error('合成恢复提交故障')
      }
    }
    const value = exec.call(this, sql)
    if (state && (sql === 'BEGIN IMMEDIATE' || sql === 'BEGIN')) state.transaction = true
    else if (state && (sql === 'COMMIT' || sql === 'ROLLBACK')) state.transaction = false
    return value
  })
  const prepareMock = t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    const state = states.get(this)
    if (state) events.push({ kind: 'prepare', sql, connection: this, ...state })
    return prepare.call(this, sql)
  })
  const closeMock = t.mock.method(DatabaseSync.prototype, 'close', function (this: DatabaseSync) {
    const state = states.get(this), value = close.call(this)
    if (state) events.push({ kind: 'close', sql: '', connection: this, ...state })
    if (!changedAfterInspection && state?.stage === 'inspection') {
      changedAfterInspection = true
      race.afterInspectionClose?.()
    }
    return value
  })
  return { events, restore() { closeMock.mock.restore(); prepareMock.mock.restore(); execMock.mock.restore() }, rejected: () => rejected }
}
function points(events: readonly Event[], sql: string, stage: Stage) {
  return events.filter(event => event.kind === 'prepare' && event.sql === sql && event.stage === stage)
}
function commands(events: readonly Event[], sql: string, stage: Stage = 'actual') {
  return events.filter(event => event.kind === 'exec' && event.sql === sql && event.stage === stage)
}

test('schema34真实非空冷开：三域只在实际同连接写事务完整核验一次，再恢复扫描并保持工作库身份', async t => {
  const f = await current(t)
  for (let attempt = 0; attempt < 2; attempt++) {
    const observed = observe(t), opened = await openCollectionDataset(f.directory)
    try {
      const { events } = observed
      for (const sql of [catalogPass, scanPass, queuePass]) {
        assert.equal(points(events, sql, 'inspection').length, 0)
        const actual = points(events, sql, 'actual')
        assert.equal(actual.length, 1); assert.equal(actual[0]!.transaction, true)
      }
      const connection = points(events, catalogPass, 'actual')[0]!.connection
      assert.equal(points(events, scanPass, 'actual')[0]!.connection, connection)
      assert.equal(points(events, queuePass, 'actual')[0]!.connection, connection)
      assert.equal(points(events, 'PRAGMA integrity_check', 'inspection').length, 1)
      assert.ok(points(events, 'PRAGMA foreign_key_check', 'inspection').length >= 1)
      assert.equal(points(events, artworkPass, 'inspection').length, 1)
      assert.equal(commands(events, 'BEGIN IMMEDIATE').length, 1)
      assert.equal(commands(events, 'COMMIT').length, 1)
      assert.equal(commands(events, 'ROLLBACK').length, 0)
      const commit = events.findIndex(event => event.kind === 'exec' && event.stage === 'actual' && event.sql === 'COMMIT')
      for (const sql of [catalogPass, scanPass, queuePass]) assert.ok(events.indexOf(points(events, sql, 'actual')[0]!) < commit)
      const recovered = opened.repository.localScan.get(f.job.jobId)
      assert.equal(recovered.phase, 'paused'); assert.equal(recovered.jobRevision, (BigInt(f.job.jobRevision) + 1n).toString())
      assert.equal(opened.repository.localCatalog.pageTracks({ offset: 0, limit: 200 }).total, 1)
      assert.deepEqual(opened.repository.mbQueue.load(f.datasetId), f.queue)
      assert.equal(opened.repository.list(page).total, 1)
      assert.equal(opened.datasetId, f.datasetId); assert.equal(opened.databaseFile, f.file)
      assert.equal(opened.store.activations.overview().activeId, null); assert.equal(opened.pendingActivationId, undefined)
      opened.assertIdentity()
    } finally { opened.close(); observed.restore() }
  }
  t.diagnostic('真实SQLite查询标记：每次当前版冷开Catalog/Scan/Queue各1次，均在同一实际连接BEGIN IMMEDIATE内；未复用前次冷开结果。')
})

for (const [name, damage] of [
  ['Catalog实体', "UPDATE local_catalog_tracks SET data='{}'"],
  ['Scan索引', 'DROP INDEX local_scan_batches_job'],
  ['Queue结构', 'ALTER TABLE mb_playback_queue ADD COLUMN injected TEXT'],
] as const) test(`schema34 ${name}损坏：实际完整检查仍拒绝并ROLLBACK，恢复/回执/Source事实不提交`, async t => {
  const f = await current(t)
  mutate(f.file, damage)
  const before = facts(f.file), observed = observe(t)
  await assert.rejects(openCollectionDataset(f.directory))
  observed.restore()
  assert.equal(commands(observed.events, 'BEGIN IMMEDIATE').length, 1)
  assert.equal(commands(observed.events, 'ROLLBACK').length, 1)
  assert.equal(commands(observed.events, 'COMMIT').length, 0)
  assert.equal(points(observed.events, artworkPass, 'inspection').length, 1)
  assert.deepEqual(facts(f.file), before, '失败不提交扫描恢复、数据修补或来源许可变更')
  assert.equal(JSON.parse(String(before.jobs[0]!.data)).phase, 'running')
})

test('schema34实际扫描恢复已执行但COMMIT失败：整笔回滚，下一次仍完整核验并只恢复一次', async t => {
  const f = await current(t), before = facts(f.file), observed = observe(t, true)
  await assert.rejects(openCollectionDataset(f.directory))
  observed.restore()
  assert.equal(observed.rejected(), true)
  assert.ok(observed.events.some(event => event.stage === 'actual' && event.kind === 'prepare' && event.sql.startsWith('UPDATE local_scan_jobs SET data=')))
  assert.equal(commands(observed.events, 'ROLLBACK').length, 1)
  assert.deepEqual(facts(f.file), before)
  const opened = await openCollectionDataset(f.directory)
  try {
    assert.equal(opened.datasetId, f.datasetId); opened.assertIdentity()
    const recovered = opened.repository.localScan.get(f.job.jobId)
    assert.equal(recovered.phase, 'paused'); assert.equal(recovered.jobRevision, (BigInt(f.job.jobRevision) + 1n).toString())
    assert.equal(opened.store.activations.overview().activeId, null)
  } finally { opened.close() }
})

for (const [name, damage] of [
  ['录音分页', 'DROP INDEX idx_recordpage_completed'],
  ['Artwork', 'DROP TRIGGER local_artwork_ledger_no_update'],
] as const) test(`schema34保留${name}前置只读门禁：损坏在实际写连接之前拒绝`, async t => {
  const f = await current(t)
  mutate(f.file, damage)
  const before = facts(f.file), observed = observe(t)
  await assert.rejects(openCollectionDataset(f.directory))
  observed.restore()
  assert.equal(commands(observed.events, 'BEGIN IMMEDIATE').length, 0)
  assert.equal(points(observed.events, catalogPass, 'actual').length, 0)
  assert.equal(points(observed.events, 'PRAGMA integrity_check', 'inspection').length, 1)
  assert.deepEqual(facts(f.file), before)
})

async function legacy(t: TestContext, version: 31 | 32 | 33) {
  if (version === 31) {
    const root = await directory(t), file = path.join(root, 'collection.v1.sqlite')
    await writeFile(file, await readFile(new URL('../mbrs003/fixtures/schema31-nonempty-local.sqlite', import.meta.url)), { flag: 'wx', mode: 0o600 })
    return { directory: root, file }
  }
  // 与既有Queue迁移Gate相同：仅去掉该版本尚不存在的域，不伪造领域DDL。
  const f = await current(t)
  mutate(f.file, artworkDrop + (version === 32 ? 'DROP TABLE mb_playback_queue;' : '') + `PRAGMA user_version=${version}`)
  return { directory: f.directory, file: f.file }
}
for (const version of [31, 32, 33] as const) test(`真实schema${version}仍先完整只读预检，再独立迁移与实际恢复事务`, async t => {
  const f = await legacy(t, version), observed = observe(t), opened = await openCollectionDataset(f.directory)
  try {
    const { events } = observed
    assert.equal(points(events, catalogPass, 'inspection').length, 1)
    assert.equal(points(events, scanPass, 'inspection').length, version >= 32 ? 1 : 0)
    assert.equal(points(events, queuePass, 'inspection').length, version >= 33 ? 1 : 0)
    const migration = events.findIndex(event => event.stage === 'actual' && event.kind === 'exec' && event.sql === 'BEGIN IMMEDIATE')
    for (const event of events.filter(event => event.stage === 'inspection')) assert.ok(events.indexOf(event) < migration)
    assert.equal(commands(events, 'BEGIN IMMEDIATE').length, 2)
    assert.equal(commands(events, 'COMMIT').length, 2)
    assert.equal(commands(events, 'ROLLBACK').length, 0)
    assert.equal(inspect(f.file, db => db.prepare('PRAGMA user_version').get()?.user_version), 34)
    assert.ok(opened.repository.list(page).total > 0); opened.assertIdentity()
  } finally { opened.close(); observed.restore() }
})

for (const [version, damage] of [
  [31, 'DROP INDEX local_catalog_tracks_asset'],
  [32, 'DROP INDEX local_scan_batches_job'],
  [33, 'ALTER TABLE mb_playback_queue ADD COLUMN injected TEXT'],
] as const) test(`schema${version}领域损坏仍在迁移前拒绝，旧版本和数据库原字节保留`, async t => {
  const f = await legacy(t, version)
  mutate(f.file, damage)
  const before = await readFile(f.file), observed = observe(t)
  await assert.rejects(openCollectionDataset(f.directory))
  observed.restore()
  assert.equal(commands(observed.events, 'BEGIN IMMEDIATE').length, 0)
  assert.equal(inspect(f.file, db => db.prepare('PRAGMA user_version').get()?.user_version), version)
  assert.deepEqual(await readFile(f.file), before)
})


for (const when of ['after-inspection', 'before-write-lock'] as const) test(`schema34真实双连接版本变化（${when}）：拒绝迁移，保留另一连接提交，实际连接关闭`, async t => {
  const f = await current(t), original = facts(f.file)
  let changed = 0
  const change = () => { changed++; mutate(f.file, 'PRAGMA user_version=33') }
  const observed = observe(t, false, when === 'after-inspection' ? { afterInspectionClose: change } : { beforeActualBegin: change })
  await assert.rejects(openCollectionDataset(f.directory))
  observed.restore()
  assert.equal(changed, 1, '真实第二连接已提交版本变化；没有伪造get返回值')
  assert.equal(points(observed.events, catalogPass, 'actual').length, 0)
  assert.equal(points(observed.events, scanPass, 'actual').length, 0)
  assert.equal(points(observed.events, queuePass, 'actual').length, 0)
  assert.equal(commands(observed.events, 'COMMIT').length, 0)
  assert.equal(observed.events.filter(event => event.kind === 'close' && event.stage === 'actual').length, 1)
  if (when === 'after-inspection') {
    assert.equal(commands(observed.events, 'BEGIN IMMEDIATE').length, 0)
    assert.equal(commands(observed.events, 'ROLLBACK').length, 0)
    assert.equal(observed.events.some(event => event.kind === 'exec' && event.stage === 'actual' && event.sql.includes('journal_mode')), false)
  } else {
    assert.equal(commands(observed.events, 'BEGIN IMMEDIATE').length, 1)
    assert.equal(commands(observed.events, 'ROLLBACK').length, 1)
    assert.equal(points(observed.events, 'PRAGMA user_version', 'actual').length, 2)
  }
  const after = facts(f.file)
  assert.equal(after.version?.user_version, 33)
  assert.deepEqual({ ...after, version: original.version }, original, '除外部显式版本提交，业务事实与DDL均不变；不能独立提交任何迁移')
})

test('schema34预检后另一连接篡改Catalog：实际连接重读真实行拒绝，不能复用只读预检证书', async t => {
  const f = await current(t)
  let before!: ReturnType<typeof facts>
  const observed = observe(t, false, { afterInspectionClose() {
    mutate(f.file, "UPDATE local_catalog_tracks SET data='{}'")
    before = facts(f.file)
  } })
  await assert.rejects(openCollectionDataset(f.directory))
  observed.restore()
  assert.ok(before)
  assert.equal(points(observed.events, catalogPass, 'actual').length, 1)
  assert.equal(commands(observed.events, 'BEGIN IMMEDIATE').length, 1)
  assert.equal(commands(observed.events, 'ROLLBACK').length, 1)
  assert.equal(commands(observed.events, 'COMMIT').length, 0)
  assert.deepEqual(facts(f.file), before)
})
