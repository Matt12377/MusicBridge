import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as dto from '@music-bridge/contracts'
import { buildStoragePolicy } from '../../../../apps/desktop/scripts/build-storage-root.mjs'
import { createCollectionRepository, type CollectionRepository } from '../../src/collection/repository.js'
import { authorizeSourceDirectory } from '../../src/recording/source-files.js'
import { createLocalAlbumOwnerService } from '../../src/collection/local-album-browser/owner-port.js'
import type { LocalAlbumLibraryOrganization } from '../../src/collection/local-album-browser/sql-types.js'
import type { ScanPreparedBatch, ScanPreparedItem } from '../../src/collection/local-scan-store.js'
import { readLibraryOperationLine, type LibraryOperationEvent } from '../../src/shared/library-operation-log.js'
import { METADATA_PARSER_VERSION } from '../../src/library/metadata-reader-types.js'
import { captureLocalAlbumQueueWrite, localAlbumScanPoint, localAlbumScanPath } from '../../src/collection/local-album-browser/scan-delta.js'
import { createMBQueueStore, mbQueueMigration } from '../../src/collection/mb-queue-store.js'

const parserVersion = METADATA_PARSER_VERSION
const request = (): dto.LocalAlbumQuery => ({ query: '', rootId: null, filter: 'all', offset: 0, limit: 200 })
const accepted = (relative: string, album = relative.split('/')[0]!, signature = `合成签名-${relative}`): ScanPreparedItem => ({
  relative, signature, parserVersion, outcome: 'accepted', fields: { title: path.posix.basename(relative), artist: '合成艺人', album }, failureCode: null, reused: false,
  readFacts: { technical: { container: 'WAVE', codec: 'PCM', lossless: true, sampleRateHz: 48000, channels: 2, bitsPerSample: 16, durationSeconds: 10, evidence: 'bounded-parser-reported' },
    coverEvidence: [], readEvidence: { bytesRead: 44, readCalls: 1, maxReadBytes: 44, allocationBytes: 44, elapsedMs: 1, wholeAudioHash: false, wholeAudioDecode: false } },
})
const rejected = (relative: string): ScanPreparedItem => ({ relative, signature: `合成拒收-${relative}`, parserVersion, outcome: 'rejected', fields: null, failureCode: 'PARSE_FAILED', reused: false, readFacts: null })
type Owner = ReturnType<typeof createLocalAlbumOwnerService>
type CommitRequest = Parameters<CollectionRepository['localScan']['privateCommitBatch']>[0]
function observe(t: test.TestContext): LibraryOperationEvent[] {
  const events: LibraryOperationEvent[] = []
  t.mock.method(console, 'info', (...args: unknown[]) => {
    for (const line of args) { const value = typeof line === 'string' ? readLibraryOperationLine(line) : null; if (value) events.push(value) }
  })
  return events
}
async function read(owner: Owner, events: LibraryOperationEvent[]) {
  const start = events.length, page = await owner.queryAlbums(request())
  return { page, events: events.slice(start).filter(event => event.action === 'albums.compact-groups') }
}
const codeCount = (events: readonly LibraryOperationEvent[], code: string) => events.filter(event => event.code === code).length

async function fixture(t: test.TestContext) {
  const storage = buildStoragePolicy(), temporary = storage.check(process.env.TMPDIR!, { mustExist: true })
  const directory = await mkdtemp(path.join(temporary, 'mb-album-scan-delta-')); storage.check(directory, { mustExist: true })
  const sourcePath = path.join(directory, '合成空来源'); await mkdir(sourcePath)
  // 只授权本测试新建的合成空目录，不读取正式曲库、不制造正式Source许可。
  let inject: ((action: string) => void) | undefined, database: DatabaseSync | undefined
  const file = path.join(directory, 'collection.v1.sqlite')
  const repository = createCollectionRepository({ filePath: file, beforeCommit(action) { inject?.(action) } })
  const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(sourcePath))
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' })
  repository.localCatalog.privateRead(db => { database = db })
  const datasetId = randomUUID(), started = repository.localScan.start({ commandId: randomUUID(), datasetId, libraryRootId: root.id, expectedRootRevision: root.revision, parserVersion }).job
  let job = repository.localScan.resume({ commandId: randomUUID(), jobId: started.jobId, expectedRevision: started.jobRevision })
  let organizations: readonly LocalAlbumLibraryOrganization[] = [], coldSequence = 0
  const services: Owner[] = []
  const roots = (): dto.LocalRootView[] => [{ root, label: '合成扫描来源', availability: 'ONLINE' }]
  const ownerFor = (repo: CollectionRepository): Owner => {
    const owner = createLocalAlbumOwnerService({ repository: repo, assertCurrent() {}, readRootViews: async () => roots(),
      readLibraryOrganizations: () => organizations, readArtwork: async () => ({ image: null, status: 'ready' }) })
    services.push(owner); return owner
  }
  const owner = ownerFor(repository)
  t.after(async () => { for (const service of services) service.close(); repository.close(); await rm(directory, { recursive: true, force: true }) })
  const prepare = (items: ScanPreparedItem[], cueItems?: dto.LocalCuePreparedItem[]) => {
    const batch: ScanPreparedBatch = { batchId: randomUUID(), jobId: job.jobId, expectedJobRevision: job.jobRevision, checkpointBefore: job.checkpointRef,
      items, frontier: [''], completed: false, ...(cueItems ? { kind: 'cue-sidecars-v1' as const, cueItems } : {}) }
    repository.localScan.privatePrepareBatch({ commandId: randomUUID(), jobId: job.jobId, batch })
    const commit: CommitRequest = { commandId: randomUUID(), jobId: job.jobId, batchId: batch.batchId, expectedRevision: job.jobRevision }
    return { batch, commit }
  }
  const commit = (prepared: ReturnType<typeof prepare>) => { job = repository.localScan.privateCommitBatch(prepared.commit); return job }
  const submit = (items: ScanPreparedItem[], cueItems?: dto.LocalCuePreparedItem[]) => { const prepared = prepare(items, cueItems); commit(prepared); return prepared }
  async function cold(): Promise<dto.LocalAlbumPage> {
    const copy = path.join(directory, `cold-${++coldSequence}.sqlite`)
    // SQLite自己复制包括WAL中的完整一致快照；独立连接没有原Compact或增量链。
    repository.localCatalog.privateRead(db => db.prepare('VACUUM INTO ?').run(copy))
    const repo = createCollectionRepository({ filePath: copy }), service = ownerFor(repo)
    try { return await service.queryAlbums(request()) } finally { service.close(); repo.close() }
  }
  function cue(relative: string, audio: string, count = 2): dto.LocalCuePreparedItem {
    const state = repository.localScan.privateFileState(root.id, audio)!.value
    const locator = repository.localCatalog.privateAssetLocator(state.assetId!), asset = locator.asset
    return { relative, signature: `合成CUE-${relative}`, parserVersion: 'cue-text-75fps/mbrs003-v1', outcome: 'accepted', failureCode: null,
      reused: false, previousSnapshotId: repository.localScan.privateCueSnapshot(root.id, relative)?.id ?? null,
      result: { status: 'ok', tracks: Array.from({ length: count }, (_, index) => ({ trackNumber: index + 1, fileOrdinal: 1,
        assetReference: { assetId: asset.id, libraryRootId: root.id, sourceRootId: source.id, rootRevision: root.revision, fileRevision: asset.fileRevision,
          locationRevision: asset.locationRevision, relative: locator.relative, signature: state.signature },
        timebase: 'cue-cd-frames', framesPerSecond: 75, index00Frames: null, index01Frames: index * 75, endFrames: null,
        evidence: 'cue-text-declared', playback: 'NOT_VERIFIED' })) } }
  }
  return { directory, repository, root, source, owner, roots, datasetId, prepare, commit, submit, cold, cue,
    get job() { return job }, get database() { return database! },
    inject(value: typeof inject) { inject = value },
    role(role: dto.LocalLibraryRole) { organizations = [{ datasetId, rootId: root.id, sourceRootId: source.id, rootRevision: root.revision,
      bindingRevision: 1, recordSha256: 'a'.repeat(64), role, rootName: '合成艺人', parentName: '合成来源' }] },
  }
}

function queue(datasetId: string): dto.MBQueueRecord {
  return { schemaVersion: '1.2', datasetId, queueId: randomUUID(), revision: '1', currentEntryId: null,
    restartPolicy: { reResolve: true, autoplay: false },
    entries: [{ entryId: randomUUID(), entryRevision: '1', source: { kind: 'netease', trackId: '123' }, quality: 'auto' }] }
}
const point = (database: DatabaseSync) => { const value = localAlbumScanPoint(database); assert.ok(value); return value }
const empty = { directories: [], cues: [] }
const rawTarget = (value: dto.MBQueueRecord) => ({ datasetId: value.datasetId, queueId: value.queueId, revision: value.revision, data: JSON.stringify(value) })

test('队列Compact空段：null/catalog真实CAS连续三轮保全部卡片/counts/revision，后续真正scan仍接完整dirty链', async t => {
  const events = observe(t)
  for (const role of [null, 'catalog'] as const) {
    const f = await fixture(t)
    if (role) f.role(role)
    f.submit([accepted('稳定/01.wav'), accepted('同目录/01.wav'), rejected('拒收/坏.wav')])
    f.submit([], [f.cue('同目录/disc.cue', '同目录/01.wav')])
    const baseline = await read(f.owner, events)
    assert.equal(codeCount(baseline.events, 'COMPACT_BUILT'), 1)
    let currentQueue = queue(f.datasetId)
    for (let index = 0; index < 3; index++) {
      const expectedRevision = String(index), before = point(f.database)
      if (index) currentQueue = { ...currentQueue, revision: String(index + 1) }
      assert.deepEqual(f.repository.mbQueue.save({ expectedRevision, queue: currentQueue }), currentQueue)
      const after = point(f.database)
      assert.equal(after.changes, before.changes + 1)
      assert.deepEqual(localAlbumScanPath(f.database, before, after), empty)
      const current = await read(f.owner, events)
      assert.equal(codeCount(current.events, 'COMPACT_BUILT'), 0)
      assert.equal(codeCount(current.events, 'COMPACT_SCAN_UNCHANGED'), 1)
      assert.deepEqual(current.page, baseline.page)
      assert.deepEqual(point(f.database), after, '读墙仍须零写入')
    }
    assert.deepEqual(await f.cold(), baseline.page, '独立冷连接核对全部卡片/counts/每张修订')
    f.submit([accepted('同目录/02.wav'), accepted('新增/01.wav')])
    const scanned = await read(f.owner, events)
    assert.equal(codeCount(scanned.events, 'COMPACT_BUILT'), 0)
    assert.equal(codeCount(scanned.events, 'COMPACT_SCAN_DELTA'), 1)
    assert.deepEqual(scanned.page, await f.cold())
  }
})

test('队列Compact空段：提交钩子附加真实写、队列前未知写都不补旧起点，即使最终事实相同', async t => {
  const events = observe(t)
  for (const mode of ['inside', 'before'] as const) {
    const f = await fixture(t); f.submit([accepted('稳定/01.wav')])
    const baseline = await read(f.owner, events), before = point(f.database), value = queue(f.datasetId)
    const unknown = () => f.database.prepare('UPDATE local_scan_jobs SET data=data WHERE id=?').run(f.job.jobId)
    if (mode === 'inside') f.inject(action => { if (action === 'save-mb-queue') unknown() })
    else unknown()
    assert.deepEqual(f.repository.mbQueue.save({ expectedRevision: '0', queue: value }), value)
    f.inject(undefined)
    const after = point(f.database)
    assert.equal(after.changes, before.changes + 2)
    assert.equal(localAlbumScanPath(f.database, before, after), null)
    const rebuilt = await read(f.owner, events)
    assert.equal(codeCount(rebuilt.events, 'COMPACT_SCAN_UNCHANGED'), 0)
    assert.equal(codeCount(rebuilt.events, 'COMPACT_BUILT'), 1)
    assert.deepEqual(rebuilt.page, baseline.page); assert.deepEqual(rebuilt.page, await f.cold())
    const next = { ...value, revision: '2' }, restoredBefore = point(f.database)
    f.repository.mbQueue.save({ expectedRevision: '1', queue: next })
    assert.deepEqual(localAlbumScanPath(f.database, restoredBefore, point(f.database)), empty)
    const restored = await read(f.owner, events)
    assert.equal(codeCount(restored.events, 'COMPACT_BUILT'), 0)
    assert.equal(codeCount(restored.events, 'COMPACT_SCAN_UNCHANGED'), 1)
  }
})

test('队列Compact空段：CAS拒绝不写，rollback不发布；回滚水位完整重建后下一真实CAS可恢复', async t => {
  const events = observe(t), f = await fixture(t); f.submit([accepted('稳定/01.wav')])
  const value = queue(f.datasetId)
  f.repository.mbQueue.save({ expectedRevision: '0', queue: value })
  const baseline = await read(f.owner, events), beforeRejected = point(f.database)
  assert.throws(() => f.repository.mbQueue.save({ expectedRevision: '0', queue: value }))
  assert.deepEqual(point(f.database), beforeRejected)
  const rejectedRead = await read(f.owner, events)
  assert.equal(codeCount(rejectedRead.events, 'COMPACT_BUILT'), 0)
  const next = { ...value, revision: '2' }, beforeRollback = point(f.database)
  f.inject(action => { if (action === 'save-mb-queue') throw new Error('合成队列提交前回滚') })
  assert.throws(() => f.repository.mbQueue.save({ expectedRevision: '1', queue: next }))
  f.inject(undefined)
  assert.deepEqual(f.repository.mbQueue.load(f.datasetId), value)
  assert.equal(localAlbumScanPath(f.database, beforeRollback, point(f.database)), null)
  const rolledBack = await read(f.owner, events)
  assert.equal(codeCount(rolledBack.events, 'COMPACT_BUILT'), 1)
  assert.equal(codeCount(rolledBack.events, 'COMPACT_SCAN_UNCHANGED'), 0)
  assert.deepEqual(rolledBack.page, baseline.page)
  const restoredBefore = point(f.database)
  assert.deepEqual(f.repository.mbQueue.save({ expectedRevision: '1', queue: next }), next)
  assert.deepEqual(localAlbumScanPath(f.database, restoredBefore, point(f.database)), empty)
  const restored = await read(f.owner, events)
  assert.equal(codeCount(restored.events, 'COMPACT_BUILT'), 0)
  assert.equal(codeCount(restored.events, 'COMPACT_SCAN_UNCHANGED'), 1)
  assert.deepEqual(restored.page, await f.cold())
})

test('队列Compact空段：外部data_version、schema跳转和Source撤销都不能借后续CAS跨越', async t => {
  const events = observe(t)
  for (const mode of ['external', 'schema', 'source'] as const) {
    const f = await fixture(t); f.submit([accepted('稳定/01.wav')])
    await read(f.owner, events)
    const before = point(f.database)
    if (mode === 'external') {
      const external = new DatabaseSync(path.join(f.directory, 'collection.v1.sqlite'))
      try { assert.equal(external.prepare("UPDATE physical_sequences SET next_value=next_value+1 WHERE format='cassette'").run().changes, 1) }
      finally { external.close() }
      assert.notEqual(point(f.database).version, before.version, '外部fixture必须真改变data_version')
    } else if (mode === 'schema') {
      f.database.exec('CREATE INDEX test_queue_revision ON mb_playback_queue(revision)')
      assert.notEqual(point(f.database).schema, before.schema)
    } else {
      f.repository.sources.revoke({ commandId: randomUUID(), id: f.source.id })
      assert.equal(f.repository.sources.root(f.source.id).authorized, false)
    }
    const value = queue(f.datasetId), actualBeforeQueue = point(f.database)
    f.repository.mbQueue.save({ expectedRevision: '0', queue: value })
    assert.deepEqual(localAlbumScanPath(f.database, actualBeforeQueue, point(f.database)), empty, '只证明最近这次实际CAS')
    assert.equal(localAlbumScanPath(f.database, before, point(f.database)), null, '不能把最近后缀当跨越旧未知起点的证明')
    // Source完整撤销由原root/certificate处理；这里不伪造ONLINE许可来要求返回内容。
    if (mode === 'source') continue
    if (mode === 'external') {
      await assert.rejects(f.owner.queryAlbums(request()), { code: 'UNAVAILABLE' }, '原Catalog凭证遇外部data_version必须要求重新冷核，空span无权续凭证')
      continue
    }
    const current = await read(f.owner, events)
    assert.equal(codeCount(current.events, 'COMPACT_BUILT'), 1)
    assert.equal(codeCount(current.events, 'COMPACT_SCAN_UNCHANGED'), 0)
    assert.deepEqual(current.page, await f.cold())
  }
})

test('队列Compact空段：成功span不能越过同一原Owner的歌词代次或另一个Owner作者', async t => {
  const events = observe(t), f = await fixture(t); f.submit([accepted('稳定/01.wav')])
  let lyricsRevision = 'lyrics-1'
  const lyricsInventory = { revision: () => lyricsRevision, read: () => 'unknown' as const }
  const makeOwner = () => createLocalAlbumOwnerService({ repository: f.repository, assertCurrent() {}, readRootViews: async () => f.roots(),
    lyricsInventory, readArtwork: async () => ({ image: null, status: 'ready' }) })
  const owner = makeOwner(); t.after(() => owner.close())
  const baseline = await read(owner, events), value = queue(f.datasetId), before = point(f.database)
  f.repository.mbQueue.save({ expectedRevision: '0', queue: value })
  assert.deepEqual(localAlbumScanPath(f.database, before, point(f.database)), empty)
  lyricsRevision = 'lyrics-2'
  const changed = await read(owner, events)
  assert.equal(codeCount(changed.events, 'COMPACT_BUILT'), 1)
  assert.equal(codeCount(changed.events, 'COMPACT_SCAN_UNCHANGED'), 0)
  assert.notEqual(changed.page.items[0]!.revision, baseline.page.items[0]!.revision)
  const next = { ...value, revision: '2' }
  f.repository.mbQueue.save({ expectedRevision: '1', queue: next })
  const replacement = makeOwner(); t.after(() => replacement.close())
  const replaced = await read(replacement, events)
  assert.equal(codeCount(replaced.events, 'COMPACT_BUILT'), 1)
  assert.equal(codeCount(replaced.events, 'COMPACT_SCAN_UNCHANGED'), 0)
  assert.deepEqual(replaced.page, changed.page)
})

test('队列Compact空段：没有原Owner品牌的scope仍守完整物理屏障', async t => {
  const events = observe(t), f = await fixture(t); f.submit([accepted('稳定/01.wav')])
  const scope = () => ({ revision: `${f.repository.localCatalog.privateAlbumBrowserRevision()}-${f.repository.localScan.privateAlbumBrowserRevision()}`, roots: f.roots() })
  const baseline = f.repository.localCatalog.privateAlbumBrowserQuery(request(), scope()), value = queue(f.datasetId), before = point(f.database)
  f.repository.mbQueue.save({ expectedRevision: '0', queue: value })
  assert.deepEqual(localAlbumScanPath(f.database, before, point(f.database)), empty)
  const start = events.length, current = f.repository.localCatalog.privateAlbumBrowserQuery(request(), scope())
  const observed = events.slice(start)
  assert.equal(codeCount(observed, 'COMPACT_BUILT'), 1)
  assert.equal(codeCount(observed, 'COMPACT_SCAN_UNCHANGED'), 0)
  assert.deepEqual(current, baseline)
})

test('队列Compact空段：129次未消费完整段逐出旧起点，旧读者仍全量回退', async t => {
  const events = observe(t), f = await fixture(t); f.submit([accepted('稳定/01.wav')])
  const baseline = await read(f.owner, events), initial = queue(f.datasetId), before = point(f.database)
  for (let index = 0; index < 129; index++) f.repository.mbQueue.save({ expectedRevision: String(index), queue: { ...initial, revision: String(index + 1) } })
  assert.equal(localAlbumScanPath(f.database, before, point(f.database)), null)
  const current = await read(f.owner, events)
  assert.equal(codeCount(current.events, 'COMPACT_BUILT'), 1)
  assert.equal(codeCount(current.events, 'COMPACT_SCAN_UNCHANGED'), 0)
  assert.deepEqual(current.page, baseline.page); assert.deepEqual(current.page, await f.cold())
})

test('队列Compact证明：实际总增量恰1且原行相同，但被trigger忽略的statement.changes=0不得发布', t => {
  const database = new DatabaseSync(':memory:'); t.after(() => database.close())
  database.exec(mbQueueMigration)
  const store = createMBQueueStore({ read: work => work(database), onFatal() { assert.fail('不应触发fatal') } })
  const value = queue(randomUUID()); store.save({ expectedRevision: '0', queue: value })
  database.exec('CREATE TABLE synthetic_extra(n INTEGER NOT NULL); INSERT INTO synthetic_extra VALUES(0)')
  database.exec('CREATE TRIGGER synthetic_queue_skip BEFORE UPDATE ON mb_playback_queue BEGIN UPDATE synthetic_extra SET n=n+1; SELECT RAISE(IGNORE); END')
  const before = point(database), proof = captureLocalAlbumQueueWrite(database, rawTarget(value))
  database.exec('BEGIN IMMEDIATE')
  const result = database.prepare('UPDATE mb_playback_queue SET data=data WHERE slot=1').run()
  assert.equal(result.changes, 0)
  assert.equal(point(database).changes, before.changes + 1)
  proof.approve(result.changes); database.exec('COMMIT'); proof.publish()
  assert.deepEqual(store.load(value.datasetId), value)
  assert.equal(localAlbumScanPath(database, before, point(database)), null)
})

test('队列Compact证明：actual statement一行但完整JSON/身份列与原期望不同，不发布；事务内起点也无资格', t => {
  const database = new DatabaseSync(':memory:'); t.after(() => database.close())
  database.exec(mbQueueMigration)
  const store = createMBQueueStore({ read: work => work(database), onFatal() { assert.fail('不应触发fatal') } })
  const value = queue(randomUUID()); store.save({ expectedRevision: '0', queue: value })
  const before = point(database), expected = { ...value, revision: '2' }, actual = { ...expected, queueId: randomUUID() }
  const proof = captureLocalAlbumQueueWrite(database, rawTarget(expected))
  database.exec('BEGIN IMMEDIATE')
  const write = database.prepare('UPDATE mb_playback_queue SET queue_id=?,revision=?,data=? WHERE slot=1').run(actual.queueId, actual.revision, JSON.stringify(actual))
  assert.equal(write.changes, 1)
  proof.approve(write.changes); database.exec('COMMIT'); proof.publish()
  assert.deepEqual(store.load(value.datasetId), actual)
  assert.equal(localAlbumScanPath(database, before, point(database)), null)
  const transactionBefore = point(database), next = { ...actual, revision: '3' }
  database.exec('BEGIN IMMEDIATE')
  const nested = captureLocalAlbumQueueWrite(database, rawTarget(next))
  const nestedWrite = database.prepare('UPDATE mb_playback_queue SET revision=?,data=? WHERE slot=1').run(next.revision, JSON.stringify(next))
  nested.approve(nestedWrite.changes); database.exec('COMMIT'); nested.publish()
  assert.equal(localAlbumScanPath(database, transactionBefore, point(database)), null)
})
