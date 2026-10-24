import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync, StatementSync } from 'node:sqlite'
import * as dto from '@music-bridge/contracts'
import { createCollectionRepository } from '../../src/collection/repository.js'
import { createBackupWorkflowStore } from '../../src/recording/backup-workflow-store.js'
import { createDatasetDomain, type DatasetDomain, type DatasetDomainOptions } from '../../src/collection/dataset-domain.js'
import { createLocalAlbumOwnerRuntime } from '../../src/collection/local-album-browser/owner-runtime.js'
import { createDatasetOwnerReadRevocation } from '../../src/collection/dataset-owner-read-revocation.js'
import { authorizeSourceDirectory } from '../../src/recording/source-files.js'
import type { DatasetIdentity } from '../../src/recording/dataset-identity.js'
import { METADATA_PARSER_VERSION } from '../../src/library/metadata-reader-types.js'
import type { ScanPreparedBatch, ScanPreparedItem } from '../../src/collection/local-scan-store.js'
import type { LocalLyricsInventoryRecord } from '../../src/collection/local-library-workbench/owner-journal.js'

const query: dto.LocalAlbumQuery = { rootId: null, query: '', filter: 'all', offset: 0, limit: 200 }
const accepted = (relative: string): ScanPreparedItem => ({ relative, signature: `合成签名-${relative}`, parserVersion: METADATA_PARSER_VERSION,
  outcome: 'accepted', fields: { title: relative, artist: '合成艺人', album: '同一专辑' }, failureCode: null, reused: false,
  readFacts: { technical: { container: 'WAVE', codec: 'PCM', lossless: true, sampleRateHz: 48000, channels: 2, bitsPerSample: 16, durationSeconds: 10, evidence: 'bounded-parser-reported' },
    coverEvidence: [], readEvidence: { bytesRead: 44, readCalls: 1, maxReadBytes: 44, allocationBytes: 44, elapsedMs: 1, wholeAudioHash: false, wholeAudioDecode: false } } })
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

// 只用外置合成目录、真实Repository/账本、原DatasetIdentityStore和真实SAB；不接Native、Provider、正式库或NAS。
async function fixture(t: TestContext, count = 12) {
  const temporary = process.env.TMPDIR
  assert.ok(temporary && path.isAbsolute(temporary) && path.resolve(temporary).startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp'))
  const directory = await mkdtemp(path.join(temporary, 'lyrics-inventory-scope-')), media = path.join(directory, '合成空来源')
  await mkdir(media)
  const filePath = path.join(directory, 'collection.sqlite'), repository = createCollectionRepository({ filePath })
  repository.localCatalog.roots()
  const maintenance = createBackupWorkflowStore({ filePath: path.join(directory, 'maintenance.sqlite') })
  const actualIdentity = maintenance.datasetIdentities.bind('default', filePath, false)
  let identityChecks = 0
  const identity: DatasetIdentity = { datasetId: actualIdentity.datasetId, assertCurrent() { identityChecks++; actualIdentity.assertCurrent() } }
  repository.localCatalog.privateBindWorkbenchDataset(identity)
  const datasetId = identity.datasetId, source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media))
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' })
  const started = repository.localScan.start({ commandId: randomUUID(), datasetId, libraryRootId: root.id, expectedRootRevision: root.revision, parserVersion: METADATA_PARSER_VERSION }).job
  let job = repository.localScan.resume({ commandId: randomUUID(), jobId: started.jobId, expectedRevision: started.jobRevision })
  const items = Array.from({ length: count }, (_, index) => accepted(`同目录/曲${index}.wav`))
  const batch: ScanPreparedBatch = { batchId: randomUUID(), jobId: job.jobId, expectedJobRevision: job.jobRevision, checkpointBefore: job.checkpointRef, items, frontier: [], completed: true }
  repository.localScan.privatePrepareBatch({ commandId: randomUUID(), jobId: job.jobId, batch })
  job = repository.localScan.privateCommitBatch({ commandId: randomUUID(), jobId: job.jobId, batchId: batch.batchId, expectedRevision: job.jobRevision })
  assert.equal(job.phase, 'completed')
  const rows = items.map(item => {
    const state = repository.localScan.privateFileState(root.id, item.relative)!.value, asset = repository.localCatalog.asset(state.assetId!)
    return { trackId: state.trackId!, rootId: root.id, fileRevision: asset.fileRevision }
  })
  const inventory: LocalLyricsInventoryRecord = { scope: { datasetId, libraryId: root.id, albumId: randomUUID(), captureId: randomUUID() },
    captureFingerprint: 'a'.repeat(64), revision: 0, observations: rows.map((row, index) => ({ trackId: row.trackId, fileRevision: row.fileRevision,
      lrc: index % 3 === 0 ? 'true' : index % 3 === 1 ? 'false' : 'unknown', embedded: index % 3 === 2 ? 'unknown' : 'false' })) }
  repository.localCatalog.privateLyricsCompareAndSwap(datasetId, 'inventory', inventory, null)
  const database = repository.localCatalog.privateRead(db => db), gate = createDatasetOwnerReadRevocation()
  const domains: DatasetDomain[] = [], runtimes: ReturnType<typeof createLocalAlbumOwnerRuntime>[] = []
  const views: dto.LocalRootView[] = [{ root, label: source.label, availability: 'ONLINE' }]
  const read = (index = 0, requestedDataset = datasetId) => {
    const row = rows[index]!
    return repository.localCatalog.privateLyricsInventoryRead(requestedDataset, row.trackId, row.rootId, row.fileRevision)
  }
  const scope = <T>(operation: () => T, active: (() => void) | undefined = gate.assertActive): T =>
    repository.localCatalog.privateWithLyricsInventoryRead(datasetId, operation, active)
  const legacy = () => {
    const runtime = createLocalAlbumOwnerRuntime({ repository, datasetId, assertCurrent: () => identity.assertCurrent(), readRootViews: async () => views,
      readLibraryOrganizations: () => [], lyricsInventory: { revision: () => repository.localCatalog.privateLyricsInventoryRevision(datasetId),
        read: (trackId, rootId, fileRevision) => repository.localCatalog.privateLyricsInventoryRead(datasetId, trackId, rootId, fileRevision) } })
    runtimes.push(runtime); return runtime
  }
  const domain = (active = true) => {
    const options: DatasetDomainOptions = { collectionRepository: repository, backupWorkflowStore: maintenance, collectionDatasetIdentity: identity,
      localSourceEpoch: randomUUID(), ...(active ? { assertAlbumReadActive: gate.assertActive } : {}) }
    const owner = createDatasetDomain(options); domains.push(owner); return { owner, options }
  }
  t.after(async () => {
    try { for (const owner of domains) await owner.close(); for (const runtime of runtimes) await runtime.close() }
    finally { repository.close(); maintenance.close(); await rm(directory, { recursive: true, force: true }) }
  })
  return { directory, filePath, repository, maintenance, actualIdentity, identity, datasetId, database, source, root, job, rows, inventory, gate, read, scope, domain, legacy,
    checks: () => identityChecks }
}

test('歌词同步scope：128曲真实库存与原逐项结果一致，实际FS身份仅首末两次、SQL次数不随曲目增长', async t => {
  const f = await fixture(t, 128), expected = f.rows.map((_row, index) => f.read(index)), get = StatementSync.prototype.get
  let sql = 0
  const measured = t.mock.method(StatementSync.prototype, 'get', function (this: StatementSync, ...args: unknown[]) { sql++; return Reflect.apply(get, this, args) })
  const before = f.checks(), stamp = f.repository.readonlySnapshotStamp(); sql = 0
  const result = f.scope(() => f.rows.map((_row, index) => f.read(index)))
  const actualSql = sql
  assert.deepEqual(result, expected)
  assert.equal(f.checks() - before, 2, '两次都调用原真实DatasetIdentity.assertCurrent，不是伪造成功guard')
  assert.ok(actualSql < 16, `真实scope只允许首末点/审计查询，实际${actualSql}次`)
  assert.deepEqual(f.repository.readonlySnapshotStamp(), stamp)
  measured.mock.restore()
  const beforeOutside = f.checks(); assert.equal(f.read(), expected[0]); assert.equal(f.checks(), beforeOutside + 1)
  const beforeNext = f.checks(); assert.deepEqual(f.scope(() => [f.read()]), [expected[0]]); assert.equal(f.checks(), beforeNext + 2)
  const wrong = f.rows[0]!
  assert.equal(f.scope(() => f.repository.localCatalog.privateLyricsInventoryRead(f.datasetId, wrong.trackId, wrong.rootId, '999999')), 'unknown')
})

test('歌词同步scope：无SAB或原显式事务都保逐曲真实guard，事务中不新增SAB撤销调用', async t => {
  const f = await fixture(t, 16), beforeLegacy = f.checks()
  assert.equal(f.repository.localCatalog.privateWithLyricsInventoryRead(f.datasetId, () => f.rows.map((_row, index) => f.read(index))).length, 16)
  assert.equal(f.checks() - beforeLegacy, 18)
  let activeCalls = 0
  f.gate.revoke()
  const beforeTransaction = f.checks()
  f.database.exec('BEGIN')
  try {
    const values = f.scope(() => f.rows.map((_row, index) => f.read(index)), () => { activeCalls++; f.gate.assertActive() })
    assert.equal(values.length, 16); assert.equal(activeCalls, 0)
    assert.equal(f.checks() - beforeTransaction, 18)
  } finally { f.database.exec('ROLLBACK') }
})

test('歌词同步scope：Promise/thenable与已捕获nested或wrong-dataset拒绝整件，晚到async读取不借旧frame', async t => {
  const f = await fixture(t), hold = deferred()
  let continuation!: Promise<dto.LocalLyricsPresence>
  assert.throws(() => f.scope(() => { continuation = (async () => { f.read(); await hold.promise; return f.read() })(); return continuation }))
  const beforeLate = f.checks(); hold.resolve(); assert.equal(await continuation, 'true'); assert.equal(f.checks(), beforeLate + 1)
  assert.throws(() => f.scope(() => ({ then() {} })))
  assert.throws(() => f.scope(() => { assert.throws(() => f.scope(() => 1)); return '不得发布' }))
  assert.throws(() => f.scope(() => { assert.throws(() => f.read(0, randomUUID())); return '不得发布' }))
  assert.equal(f.scope(() => f.read()), 'true', '拒绝后的下一同步操作仍重新首末核验')
})

test('歌词同步scope：真实SAB中途或最后读取后撤销，捕获内部错误也不能发布旧结果', async t => {
  for (const middle of [true, false]) {
    const f = await fixture(t)
    assert.throws(() => f.scope(() => {
      const first = f.read(); f.gate.revoke()
      if (middle) assert.throws(() => f.read(1))
      return first
    }))
  }
})

test('歌词同步scope：最后lookup后未知DML、rollback或schema变化都由真实末点拒绝', async t => {
  for (const mode of ['write', 'rollback', 'schema'] as const) {
    const f = await fixture(t), before = f.database.prepare('SELECT total_changes() n').get()!.n
    let published = false
    assert.throws(() => {
      f.scope(() => {
        const result = f.read()
        if (mode === 'schema') f.database.exec('CREATE INDEX synthetic_scope_job ON local_scan_jobs(dataset_id,id)')
        else {
          if (mode === 'rollback') f.database.exec('BEGIN IMMEDIATE')
          f.database.prepare('UPDATE local_scan_jobs SET data=data WHERE id=?').run(f.job.jobId)
          if (mode === 'rollback') f.database.exec('ROLLBACK')
        }
        return result
      })
      published = true
    })
    assert.equal(published, false)
    if (mode !== 'schema') assert.equal(Number(f.database.prepare('SELECT total_changes() n').get()!.n), Number(before) + 1)
  }
})

test('歌词同步scope：实际Source撤权和歌词journal提交发生在最后lookup后仍整件拒绝', async t => {
  for (const mode of ['source', 'lyrics'] as const) {
    const f = await fixture(t)
    assert.throws(() => f.scope(() => {
      const old = f.read()
      if (mode === 'source') f.repository.sources.revoke({ commandId: randomUUID(), id: f.source.id })
      else f.repository.localCatalog.privateLyricsCompareAndSwap(f.datasetId, 'inventory', { ...f.inventory, revision: 1,
        observations: f.inventory.observations.map(row => ({ ...row, lrc: 'false', embedded: 'false' })) }, 0)
      return old
    }))
    if (mode === 'source') assert.equal(f.repository.sources.root(f.source.id).authorized, false)
    else { assert.equal(f.read(), 'false'); assert.equal(f.scope(() => f.read()), 'false') }
  }
})

test('歌词同步scope：外部SQLite、实际文件替换或新增hardlink在末尾都不能发布', async t => {
  for (const mode of ['external', 'replace', 'hardlink'] as const) {
    const f = await fixture(t), held = path.join(f.directory, 'held.sqlite'), link = path.join(f.directory, 'hardlink.sqlite')
    let changed = false
    try {
      assert.throws(() => f.scope(() => {
        const result = f.read()
        if (mode === 'external') {
          const before = f.database.prepare('PRAGMA data_version').get()!.data_version, external = new DatabaseSync(f.filePath)
          try { external.prepare("UPDATE physical_sequences SET next_value=next_value+1 WHERE format='cassette'").run() } finally { external.close() }
          assert.notEqual(f.database.prepare('PRAGMA data_version').get()!.data_version, before)
        } else if (mode === 'replace') {
          const replacement = path.join(f.directory, 'replacement.sqlite')
          fs.copyFileSync(f.filePath, replacement); fs.renameSync(f.filePath, held); fs.renameSync(replacement, f.filePath); changed = true
        } else { fs.linkSync(f.filePath, link); changed = true }
        return result
      }))
    } finally {
      if (changed && mode === 'replace') { fs.rmSync(f.filePath); fs.renameSync(held, f.filePath) }
      if (changed && mode === 'hardlink') fs.rmSync(link)
    }
  }
})

test('歌词同步scope：同对象换identity方法作者与最后guard附加真实DML均拒绝', async t => {
  const f = await fixture(t), original = f.identity.assertCurrent
  try {
    assert.throws(() => f.scope(() => { const result = f.read(); f.identity.assertCurrent = () => f.actualIdentity.assertCurrent(); return result }))
  } finally { f.identity.assertCurrent = original }
  assert.equal(f.scope(() => f.read()), 'true')
  let calls = 0
  assert.throws(() => f.scope(() => f.read(), () => {
    f.gate.assertActive()
    if (++calls === 4) f.database.prepare('UPDATE local_scan_jobs SET data=data WHERE id=?').run(f.job.jobId)
  }))
  assert.equal(calls, 4, '未知DML安排在末点前最后一次真实guard，不能靠中间read检查碰巧捕获')
})

test('歌词同步scope：实际Domain与Owner SQL接线处理16/96曲，输出等于旧guard，身份成本为常数', async t => {
  const measurements: { reads: number; identities: number }[] = []
  for (const count of [16, 96]) {
    const f = await fixture(t, count), expected = await f.legacy().localAlbums.queryAlbums(query), { owner } = f.domain()
    const original = f.repository.localCatalog.privateLyricsInventoryRead
    let reads = 0
    const observed = t.mock.method(f.repository.localCatalog, 'privateLyricsInventoryRead', (...args: Parameters<typeof original>) => { reads++; return original(...args) })
    const before = f.checks(), actual = await owner.localAlbums!.queryAlbums(query)
    measurements.push({ reads, identities: f.checks() - before })
    assert.deepEqual(actual, expected)
    assert.equal(actual.items[0]!.trackCount, count)
    assert.ok(reads >= count, '仍经实际Domain→原SQL UDF→Catalog读取全部当前歌词，不替换生产函数')
    observed.mock.restore()
  }
  assert.ok(measurements[1]!.identities <= measurements[0]!.identities + 16,
    `多80曲不能多80次FS身份检查：${JSON.stringify(measurements)}`)
})

test('歌词同步scope：实际Domain无SAB保旧逐曲guard，关闭或安装回调作者变化拒绝当前读取', async t => {
  const legacy = await fixture(t, 24), noLatch = legacy.domain(false).owner, legacyBefore = legacy.checks()
  await noLatch.localAlbums!.queryAlbums(query)
  assert.ok(legacy.checks() - legacyBefore >= 24)
  for (const mode of ['close', 'author'] as const) {
    const f = await fixture(t, 24), { owner, options } = f.domain(), original = f.repository.localCatalog.privateLyricsInventoryRead
    let reads = 0, closing: Promise<void> | undefined
    const observed = t.mock.method(f.repository.localCatalog, 'privateLyricsInventoryRead', (...args: Parameters<typeof original>) => {
      const result = original(...args)
      if (++reads === 24) {
        if (mode === 'close') closing = owner.close()
        else options.assertAlbumReadActive = () => f.gate.assertActive()
      }
      return result
    })
    await assert.rejects(owner.localAlbums!.queryAlbums(query))
    observed.mock.restore()
    if (closing) await closing
  }
})
