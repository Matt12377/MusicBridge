import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createCollectionRepository, CollectionError } from '../src/collection/repository.js'
import { verifyLocalCatalogDatabase } from '../src/collection/local-catalog-store.js'
import { albumCatalogRevision, albumScanRevision } from '../src/collection/local-album-browser/owner-store.js'
import { localAlbumScanPath, localAlbumScanPoint } from '../src/collection/local-album-browser/scan-delta.js'
import { METADATA_PARSER_VERSION } from '../src/library/metadata-reader-types.js'
import type { MBQueueRecord } from '@music-bridge/contracts'
import { createLocalAlbumOwnerService } from '../src/collection/local-album-browser/owner-port.js'
import { createLocalWorkbenchReadService, createLocalLibraryManagementRuntime } from '../src/collection/local-library-workbench/read-service.js'
import { createCompletedScanSnapshotView } from '../src/collection/local-scan-snapshot-view.js'
import { createBackupWorkflowStore } from '../src/recording/backup-workflow-store.js'
import { LocalWorkbenchPlanError } from '../src/collection/local-library-workbench/types.js'
import { assertLocalWorkbenchJournalComplete, createLocalWorkbenchSnapshotEvents, emptyLocalWorkbenchJournalProjection,
  localWorkbenchJournalLedgerRow, projectLocalWorkbenchJournalEvent, readLocalWorkbenchJournalEvent } from '../src/collection/local-library-workbench/owner-journal.js'
import { authorizeSourceDirectory } from '../src/recording/source-files.js'
import type { ScanPreparedBatch, ScanPreparedItem } from '../src/collection/local-scan-store.js'

async function fixture(t: test.TestContext, beforeCommit?: (action: string) => void) {
  const temporary = process.env.TMPDIR
  if (!temporary?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/')) throw new Error('修订验证必须采用外置任务临时目录')
  const directory = await mkdtemp(path.join(temporary, 'mbf-album-revision-')), media = path.join(directory, 'media'), file = path.join(directory, 'work.sqlite')
  await mkdir(media)
  const repository = createCollectionRepository({ filePath: file, ...(beforeCommit ? { beforeCommit } : {}) })
  const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media))
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' })
  const asset = repository.localCatalog.registerAsset({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision,
    relative: 'album/song.wav', sha256: null, sampleFrames: null, timebaseHz: null })
  const track = repository.localCatalog.createTrack({ commandId: randomUUID(), assetId: asset.id, segment: null })
  repository.localCatalog.observeMetadata({ commandId: randomUUID(), trackId: track.id, source: 'synthetic', parserVersion: 'mbf-revision-v1',
    fields: { title: '合成歌曲', artist: '合成作者', album: '合成专辑', disc: '1', track: '1', year: '2026' } })
  let closed = false
  const close = () => { if (!closed) { closed = true; repository.close() } }
  t.after(async () => { close(); await rm(directory, { recursive: true }) })
  return { repository, source, root, asset, track, directory, media, file, close }
}

test('专辑来源修订：真实SQLite中严格复核的纯工作台快照不推进源捕获；旧冷核仍拒绝未登记操作', async t => {
  const f = await fixture(t), datasetId = randomUUID()
  f.close()
  const db = new DatabaseSync(f.file)
  try {
    verifyLocalCatalogDatabase(db)
    const before = albumCatalogRevision(db)
    const facts = () => ['local_catalog_roots', 'local_catalog_assets', 'local_catalog_tracks', 'local_catalog_observations', 'local_catalog_editions', 'local_catalog_edition_tracks']
      .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
    const originalFacts = facts(), projection = emptyLocalWorkbenchJournalProjection(datasetId)
    for (let revision = 1; revision <= 2; revision++) {
      const events = createLocalWorkbenchSnapshotEvents({ schemaVersion: 1, datasetId, revision, entries: [] }, revision - 1)
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const event of events) {
          const row = localWorkbenchJournalLedgerRow(event)
          const inserted = db.prepare('INSERT INTO local_catalog_ledger VALUES(?,?,?,?,?,?)')
            .run(row.command_id!, row.fingerprint!, row.operation!, row.request!, row.result!, row.created_at!)
          const stored = db.prepare('SELECT * FROM local_catalog_ledger WHERE command_id=?').get(event.eventId)!
          projectLocalWorkbenchJournalEvent(projection, readLocalWorkbenchJournalEvent(stored), Number(inserted.lastInsertRowid))
        }
        assertLocalWorkbenchJournalComplete(projection)
        assert.equal(projection.revision, revision)
        db.exec('COMMIT')
      } catch (error) { db.exec('ROLLBACK'); throw error }
      assert.deepEqual(facts(), originalFacts)
      assert.equal(albumCatalogRevision(db), before, '预览与原命令快照不得使原专辑来源修订失效')
    }
    // 当前共享冷核完整认证已登记纯快照；未知操作与损坏摘要仍须拒绝。
    verifyLocalCatalogDatabase(db)
    const malformed = db.prepare("SELECT * FROM local_catalog_ledger WHERE operation='local-workbench-v1' LIMIT 1").get()!
    assert.throws(() => readLocalWorkbenchJournalEvent({ ...malformed, fingerprint: '0'.repeat(64) }), LocalWorkbenchPlanError)
    const unknown = localWorkbenchJournalLedgerRow(createLocalWorkbenchSnapshotEvents({ schemaVersion: 1, datasetId, revision: 3, entries: [] }, 2)[0]!)
    db.prepare('INSERT INTO local_catalog_ledger VALUES(?,?,?,?,?,?)').run(unknown.command_id!, unknown.fingerprint!, 'unregistered-source541-v1', unknown.request!, unknown.result!, unknown.created_at!)
    assert.throws(() => verifyLocalCatalogDatabase(db), /目录.*损坏|事实.*损坏|不一致/u)
  } finally { db.close() }
})

async function commitDirectoryFiles(f: Awaited<ReturnType<typeof fixture>>, relatives: readonly string[], accepted: readonly string[] = []) {
  const items: ScanPreparedItem[] = []
  for (const relative of relatives) {
    const file = path.join(f.media, relative)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, '自有目录捕获测试字节；不作为解析或听感证据')
    const info = await stat(file, { bigint: true }), isAccepted = accepted.includes(relative)
    items.push({ relative, signature: [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':'), parserVersion: 'mbf-directory-index-v1',
      outcome: isAccepted ? 'accepted' : 'rejected', fields: isAccepted ? { title: relative, artist: '自有测试作者', album: '目录索引测试' } : null,
      failureCode: isAccepted ? null : 'UNSUPPORTED', reused: false,
      readFacts: isAccepted ? { technical: { container: 'WAVE', codec: 'PCM', lossless: true, sampleRateHz: 48000, channels: 2, bitsPerSample: 16, durationSeconds: 1, evidence: 'bounded-parser-reported' }, coverEvidence: [], readEvidence: { bytesRead: 1, readCalls: 1, maxReadBytes: 1, allocationBytes: 1, elapsedMs: 1, wholeAudioHash: false, wholeAudioDecode: false } } : null })
  }
  const scan = f.repository.localScan
  const job = scan.start({ commandId: randomUUID(), datasetId: randomUUID(), libraryRootId: f.root.id, expectedRootRevision: f.root.revision, parserVersion: 'mbf-directory-index-v1' }).job
  const running = scan.resume({ commandId: randomUUID(), jobId: job.jobId, expectedRevision: job.jobRevision })
  const batch: ScanPreparedBatch = { batchId: randomUUID(), jobId: job.jobId, expectedJobRevision: running.jobRevision, checkpointBefore: null, items, frontier: [], completed: true }
  scan.privatePrepareBatch({ commandId: randomUUID(), jobId: job.jobId, batch })
  scan.privateCommitBatch({ commandId: randomUUID(), jobId: job.jobId, batchId: batch.batchId, expectedRevision: running.jobRevision })
}

test('目录索引捕获：完整成员保持根层级、Unicode和通配符目录边界；移动后按实际asset位置读取', async t => {
  const f = await fixture(t), scan = f.repository.localScan, catalog = f.repository.localCatalog
  await commitDirectoryFiles(f, ['top.wav', 'album/rejected.wav', 'album/accepted.wav', 'album/nested/deep.wav', 'albumish/sibling.wav', '奇%_[]/原曲.wav'], ['album/accepted.wav'])
  const read = (directories: string[], maxFiles = 10000, maxBytes = 32 * 1024 * 1024) => scan.privateWorkbenchDirectoryFacts({
    libraryRootId: f.root.id, expectedRevision: scan.privateAlbumBrowserRevision(), directories, maxFiles, maxBytes })
  assert.deepEqual(read(['']).files.map(file => file.currentRelative), ['top.wav'])
  assert.deepEqual(read(['album']).files.map(file => file.currentRelative), ['album/accepted.wav', 'album/rejected.wav'])
  assert.deepEqual(read(['奇%_[]']).files.map(file => file.currentRelative), ['奇%_[]/原曲.wav'])
  assert.deepEqual(read(['album', 'album/nested', '']).files.map(file => file.currentRelative), ['album/accepted.wav', 'album/nested/deep.wav', 'album/rejected.wav', 'top.wav'])
  const unavailable = (error: unknown) => error instanceof CollectionError && error.code === 'INVENTORY_UNAVAILABLE'
  assert.throws(() => read(['album'], 1), unavailable)
  assert.throws(() => read(['album'], 10000, 1), unavailable)
  const original = scan.privateFileState(f.root.id, 'album/accepted.wav')!
  const asset = catalog.asset(original.value.assetId!)
  catalog.moveAsset({ commandId: randomUUID(), assetId: asset.id, expectedLocationRevision: asset.locationRevision, expectedRootRevision: f.root.revision, relative: 'moved/current.wav' })
  assert.deepEqual(read(['album']).files.map(file => file.currentRelative), ['album/rejected.wav'])
  const moved = read(['moved']).files
  assert.equal(moved.length, 1)
  assert.equal(moved[0]!.currentRelative, 'moved/current.wav')
  assert.equal(moved[0]!.value.relative, 'album/accepted.wav')
  assert.equal(moved[0]!.value.assetId, asset.id)
  assert.equal(moved[0]!.jobId, original.jobId)
})

test('目录索引捕获：复用语句后仍执行当前SQL并拒旧扫描修订，文件与字节预算逐次生效', async t => {
  const f = await fixture(t), scan = f.repository.localScan
  await commitDirectoryFiles(f, ['selected/first.wav'])
  const request = { libraryRootId: f.root.id, expectedRevision: scan.privateAlbumBrowserRevision(), directories: ['selected'], maxFiles: 10000, maxBytes: 32 * 1024 * 1024 }
  const before = scan.privateWorkbenchDirectoryFacts(request)
  assert.deepEqual(scan.privateWorkbenchDirectoryFacts(request), before)
  await commitDirectoryFiles(f, ['selected/second.wav'])
  assert.throws(() => scan.privateWorkbenchDirectoryFacts(request), /扫描事实已变化/u)
  const current = { ...request, expectedRevision: scan.privateAlbumBrowserRevision() }
  assert.deepEqual(scan.privateWorkbenchDirectoryFacts(current).files.map(file => file.currentRelative), ['selected/first.wav', 'selected/second.wav'])
  const unavailable = (error: unknown) => error instanceof CollectionError && error.code === 'INVENTORY_UNAVAILABLE'
  assert.throws(() => scan.privateWorkbenchDirectoryFacts({ ...current, maxFiles: 1 }), unavailable)
  assert.throws(() => scan.privateWorkbenchDirectoryFacts({ ...current, maxBytes: 1 }), unavailable)
})

test('专辑来源修订：原Owner元数据、完整发行关系、定位和根修订仍拒绝旧真实捕获', async t => {
  const f = await fixture(t), datasetId = randomUUID(), catalog = f.repository.localCatalog
  const roots = async () => [{ root: catalog.root(f.root.id), label: '合成来源', availability: 'ONLINE' as const }]
  const albums = createLocalAlbumOwnerService({ repository: f.repository, assertCurrent() {}, readRootViews: roots,
    async readArtwork() { return { image: null, status: 'source-unavailable' } } })
  const read = createLocalWorkbenchReadService({ datasetId, repository: f.repository, localAlbums: albums, assertCurrent() {}, readRootViews: roots })
  t.after(() => { read.close(); albums.close() })
  async function assertInvalidated(change: () => void) {
    const page = await albums.queryAlbums({ query: '', rootId: f.root.id, filter: 'all', offset: 0, limit: 60 })
    const selected = page.items.find(album => album.representativeTrackId === f.track.id)!
    const snapshot = await read.readAlbums({ albums: [{ albumId: selected.id, rootId: selected.rootId, title: selected.title,
      artist: selected.artists[0] ?? '未知艺人', ...(selected.editionId ? { editionId: selected.editionId } : {}), trackIds: [f.track.id] }] })
    const request = { datasetId, capture: snapshot.albums[0]!.capture }
    await read.resolveCapture(request)
    const before = catalog.privateAlbumBrowserRevision()
    change()
    assert.notEqual(catalog.privateAlbumBrowserRevision(), before)
    await assert.rejects(read.resolveCapture(request), error => error instanceof LocalWorkbenchPlanError && error.code === 'CHANGED')
  }
  await assertInvalidated(() => catalog.overrideMetadata({ commandId: randomUUID(), trackId: f.track.id, expectedRevision: null, fields: { album: '实际目录字段修订' } }))
  const edition = catalog.createEdition({ commandId: randomUUID(), title: '合成发行', edition: '' })
  await assertInvalidated(() => catalog.linkEditionTrack({ commandId: randomUUID(), editionId: edition.id, trackId: f.track.id, disc: 1, trackNumber: 1, sequence: 1 }))
  await assertInvalidated(() => catalog.moveAsset({ commandId: randomUUID(), assetId: f.asset.id, expectedLocationRevision: f.asset.locationRevision,
    expectedRootRevision: f.root.revision, relative: 'album/renamed.wav' }))
  await assertInvalidated(() => catalog.relinkRoot({ commandId: randomUUID(), sourceRootId: f.source.id, role: 'library', rootId: f.root.id, expectedRevision: f.root.revision }))
})

test('来源纯捕获541：真实完整库与专辑捕获入账后原readToken仍能resolve，实际字段变化仍CHANGED', async t => {
  const f = await fixture(t), catalog = f.repository.localCatalog
  const state = createBackupWorkflowStore({ filePath: path.join(f.directory, 'identity541.sqlite') })
  const identity = state.datasetIdentities.bind('default', f.file, false)
  catalog.privateBindWorkbenchDataset(identity)
  const roots = async () => [{ root: catalog.root(f.root.id), label: '原自有来源', availability: 'ONLINE' as const }]
  const albums = createLocalAlbumOwnerService({ repository: f.repository, assertCurrent: () => identity.assertCurrent(), readRootViews: roots,
    async readArtwork() { return { image: null, status: 'source-unavailable' } } })
  const read = createLocalWorkbenchReadService({ datasetId: identity.datasetId, repository: f.repository, localAlbums: albums,
    assertCurrent: () => identity.assertCurrent(), readRootViews: roots })
  const snapshots = createCompletedScanSnapshotView({ repository: f.repository, identity })
  const management = createLocalLibraryManagementRuntime({ identity, catalog, localScan: f.repository.localScan,
    workbench: read, localAlbums: albums, readRootViews: roots, assertAccepting: () => identity.assertCurrent(), completedSnapshots: snapshots })
  try {
    const before = catalog.privateAlbumBrowserRevision()
    const page = await albums.queryAlbums({ query: '', rootId: f.root.id, filter: 'all', offset: 0, limit: 60 })
    const refs = page.items.map(album => ({ albumId: album.id, rootId: album.rootId, revision: album.revision }))
    assert.equal(refs.length, 1)
    const complete = await management.execute('library.capture', { libraryIds: [f.root.id] })
    assert.deepEqual(complete.libraryIds, [f.root.id])
    assert.equal(catalog.privateLibraryManagementRead(identity, 'capture', complete.captureId)!.record.original.albums.length, 1)
    assert.equal(catalog.privateAlbumBrowserRevision(), before, '完整库读取入账不能改变原媒体')
    const selected = await management.execute('library.albums.capture', { albums: refs })
    assert.equal(selected.albums.length, 1)
    const request = { datasetId: identity.datasetId, capture: selected.albums[0]!.capture }
    const resolved = await read.resolveCapture(request)
    assert.equal(resolved.capture.readToken, request.capture.readToken)
    assert.deepEqual(resolved.group.members.map(member => member.fact.summary.track.id), [f.track.id])
    assert.equal(catalog.privateAlbumBrowserRevision(), before, '专辑只读原件入账不能使自身读取失效')
    const again = await read.resolveCapture(request)
    assert.deepEqual(again, resolved)
    catalog.overrideMetadata({ commandId: randomUUID(), trackId: f.track.id, expectedRevision: null, fields: { title: '实际变更后的曲名541' } })
    assert.notEqual(catalog.privateAlbumBrowserRevision(), before)
    await assert.rejects(read.resolveCapture(request), error => error instanceof LocalWorkbenchPlanError && error.code === 'CHANGED')
  } finally {
    await management.close(); read.close(); albums.close(); snapshots.close(); state.close()
  }
})

// 原自有SQLite上验证缓存边界；额外测试表不代表媒体/Source作者或运行资格。
test('专辑水位缓存：非事务命中仍核SQL屏障，事务/写入/外部提交/模式变化和关闭均不复用旧结果', async t => {
  const f = await fixture(t); f.close()
  const db = new DatabaseSync(f.file), external = new DatabaseSync(f.file)
  let aggregations = 0, changeDuringRead = false
  const prepare = db.prepare.bind(db)
  Object.defineProperty(db, 'prepare', { value(sql: string) {
    const statement = prepare(sql)
    if (sql.startsWith('SELECT count(*) n, coalesce(max(rowid),0) last')) {
      const get = statement.get.bind(statement)
      Object.defineProperty(statement, 'get', { value(...args: Parameters<typeof get>) {
        aggregations++; const value = get(...args)
        if (changeDuringRead) { changeDuringRead = false; db.exec('CREATE TABLE owned_cache_mid_read(value TEXT)') }
        return value
      } })
    }
    return statement
  } })
  try {
    verifyLocalCatalogDatabase(db)
    const revision = albumCatalogRevision(db), first = aggregations
    assert.ok(first > 0); assert.equal(albumCatalogRevision(db), revision); assert.equal(aggregations, first)
    db.exec('BEGIN'); assert.equal(albumCatalogRevision(db), revision); const transactionFirst = aggregations
    assert.ok(transactionFirst > first); assert.equal(albumCatalogRevision(db), revision); assert.ok(aggregations > transactionFirst)
    db.exec('ROLLBACK'); assert.equal(albumCatalogRevision(db), revision)
    db.exec('CREATE TABLE owned_cache_changes(value TEXT)'); assert.equal(albumCatalogRevision(db), revision)
    let before = aggregations; db.exec("INSERT INTO owned_cache_changes VALUES('同连接真实写入')")
    assert.equal(albumCatalogRevision(db), revision); assert.ok(aggregations > before)
    before = aggregations; external.exec("INSERT INTO owned_cache_changes VALUES('另一连接真实提交')")
    assert.equal(albumCatalogRevision(db), revision); assert.ok(aggregations > before)
    db.exec("INSERT INTO owned_cache_changes VALUES('使本轮不能命中')"); changeDuringRead = true
    assert.throws(() => albumCatalogRevision(db), /读取期间SQL已变化/u)
    assert.equal(albumCatalogRevision(db), revision)
  } finally { external.close(); db.close() }
  assert.throws(() => albumCatalogRevision(db))
})


type RevisionPair = { catalog: string; scan: string }
const queueRevisionPoint = (db: DatabaseSync) => { const value = localAlbumScanPoint(db); assert.ok(value); return value }
const emptyQueueRevisionPath = { directories: [], cues: [] }
function queueRevisionRecord(datasetId = randomUUID()): MBQueueRecord {
  return { schemaVersion: '1.2', datasetId, queueId: randomUUID(), revision: '1', currentEntryId: null,
    restartPolicy: { reResolve: true, autoplay: false },
    entries: [{ entryId: randomUUID(), entryRevision: '1', source: { kind: 'netease', trackId: '123' }, quality: 'auto' }] }
}
function coldRevisionPair(file: string): RevisionPair {
  const db = new DatabaseSync(file)
  try { return { catalog: albumCatalogRevision(db), scan: albumScanRevision(db) } } finally { db.close() }
}
function queueRevisionProbe(f: Awaited<ReturnType<typeof fixture>>) {
  const db = f.repository.localCatalog.privateRead(value => value)
  const calls = { catalog: 0, scan: 0, barrier: 0 }
  let afterNextSchemaRead: (() => void) | undefined
  const prepare = db.prepare.bind(db)
  Object.defineProperty(db, 'prepare', { configurable: true, value(sql: string) {
    const statement = prepare(sql)
    const aggregate = sql.startsWith('SELECT count(*) n, coalesce(max(rowid),0) last FROM ')
    const barrier = sql === 'SELECT total_changes() n' || sql === 'PRAGMA data_version' || sql === 'PRAGMA schema_version'
    if (aggregate || barrier) {
      const get = statement.get.bind(statement)
      Object.defineProperty(statement, 'get', { value(...args: Parameters<typeof get>) {
        if (aggregate) calls[/FROM (?:local_scan_|local_cue_sources)/u.test(sql) ? 'scan' : 'catalog']++
        if (barrier) calls.barrier++
        const value = get(...args)
        if (sql === 'PRAGMA schema_version' && afterNextSchemaRead) {
          const change = afterNextSchemaRead; afterNextSchemaRead = undefined; change()
        }
        return value
      } })
    }
    return statement
  } })
  return {
    db, calls, snapshot: () => ({ ...calls }),
    read: (): RevisionPair => ({ catalog: albumCatalogRevision(db), scan: albumScanRevision(db) }),
    guarded: (): RevisionPair => ({ catalog: f.repository.localCatalog.privateAlbumBrowserRevision(), scan: f.repository.localScan.privateAlbumBrowserRevision() }),
    afterNextSchemaRead(change: () => void) { afterNextSchemaRead = change },
  }
}
function assertRevisionRecomputed(probe: ReturnType<typeof queueRevisionProbe>, before: { catalog: number; scan: number }) {
  assert.ok(probe.calls.catalog > before.catalog, 'catalog必须重新执行原实际聚合')
  assert.ok(probe.calls.scan > before.scan, 'scan必须重新执行原实际聚合')
}
function assertRevisionNotRecomputed(probe: ReturnType<typeof queueRevisionProbe>, before: { catalog: number; scan: number; barrier: number }) {
  assert.equal(probe.calls.catalog, before.catalog, '原队列精确提交不重算catalog聚合')
  assert.equal(probe.calls.scan, before.scan, '原队列精确提交不重算scan聚合')
  assert.ok(probe.calls.barrier > before.barrier, '命中仍执行实际SQL首末屏障')
}

test('队列修订续用：真实Repository连续CAS保catalog与scan原值和零聚合重算，每次仍有真实屏障', async t => {
  const f = await fixture(t), probe = queueRevisionProbe(f), baseline = probe.guarded(), initial = queueRevisionRecord()
  assert.ok(probe.calls.catalog > 0); assert.ok(probe.calls.scan > 0)
  for (let index = 0; index < 3; index++) {
    const before = queueRevisionPoint(probe.db), value = { ...initial, revision: String(index + 1) }
    assert.deepEqual(f.repository.mbQueue.save({ expectedRevision: String(index), queue: value }), value)
    const after = queueRevisionPoint(probe.db), calls = probe.snapshot()
    assert.equal(after.changes, before.changes + 1)
    assert.deepEqual(localAlbumScanPath(probe.db, before, after, { queueOnly: true }), emptyQueueRevisionPath)
    assert.deepEqual(probe.guarded(), baseline)
    assertRevisionNotRecomputed(probe, calls)
    assert.deepEqual(queueRevisionPoint(probe.db), after, '读取两个修订不得写入主库')
  }
  assert.deepEqual(coldRevisionPair(f.file), baseline, '独立冷连接必须得到相同两个修订')
})

test('队列修订续用：未知前置写及同事务附加写均缺完整queue链并重算，后续新精确CAS可恢复命中', async t => {
  for (const mode of ['before', 'inside'] as const) {
    let injected: (() => void) | undefined
    const f = await fixture(t, action => { if (action === 'save-mb-queue') injected?.() })
    const probe = queueRevisionProbe(f)
    probe.db.exec('CREATE TABLE queue_revision_noise(n INTEGER NOT NULL); INSERT INTO queue_revision_noise VALUES(0)')
    const baseline = probe.guarded(), initial = queueRevisionRecord(), before = queueRevisionPoint(probe.db)
    const change = () => { probe.db.exec('UPDATE queue_revision_noise SET n=n+1') }
    if (mode === 'before') change(); else injected = change
    f.repository.mbQueue.save({ expectedRevision: '0', queue: initial }); injected = undefined
    const after = queueRevisionPoint(probe.db), calls = probe.snapshot()
    assert.equal(after.changes, before.changes + 2)
    assert.equal(localAlbumScanPath(probe.db, before, after, { queueOnly: true }), null)
    assert.deepEqual(probe.guarded(), baseline); assertRevisionRecomputed(probe, calls)
    assert.deepEqual(coldRevisionPair(f.file), baseline)
    const restored = queueRevisionPoint(probe.db)
    f.repository.mbQueue.save({ expectedRevision: '1', queue: { ...initial, revision: '2' } })
    const nextCalls = probe.snapshot()
    assert.deepEqual(localAlbumScanPath(probe.db, restored, queueRevisionPoint(probe.db), { queueOnly: true }), emptyQueueRevisionPath)
    assert.deepEqual(probe.guarded(), baseline); assertRevisionNotRecomputed(probe, nextCalls)
  }
})

test('队列修订续用：真实空扫描commit虽无dirty目录仍推进scan修订，不可借普通空span续用', async t => {
  const f = await fixture(t), scan = f.repository.localScan, probe = queueRevisionProbe(f)
  const started = scan.start({ commandId: randomUUID(), datasetId: randomUUID(), libraryRootId: f.root.id,
    expectedRootRevision: f.root.revision, parserVersion: METADATA_PARSER_VERSION }).job
  const running = scan.resume({ commandId: randomUUID(), jobId: started.jobId, expectedRevision: started.jobRevision })
  const batch: ScanPreparedBatch = { batchId: randomUUID(), jobId: running.jobId, expectedJobRevision: running.jobRevision,
    checkpointBefore: running.checkpointRef, items: [], frontier: [], completed: true }
  scan.privatePrepareBatch({ commandId: randomUUID(), jobId: running.jobId, batch })
  const baseline = probe.guarded(), before = queueRevisionPoint(probe.db)
  const committed = scan.privateCommitBatch({ commandId: randomUUID(), jobId: running.jobId, batchId: batch.batchId, expectedRevision: running.jobRevision })
  assert.equal(committed.phase, 'completed')
  const after = queueRevisionPoint(probe.db), calls = probe.snapshot()
  assert.ok(after.changes > before.changes)
  assert.deepEqual(localAlbumScanPath(probe.db, before, after), emptyQueueRevisionPath, '原Compact语义的空目录证明仍成立')
  assert.equal(localAlbumScanPath(probe.db, before, after, { queueOnly: true }), null, '普通scan空span不具备queue-only资格')
  const current = probe.guarded()
  assert.equal(current.catalog, baseline.catalog); assert.notEqual(current.scan, baseline.scan)
  assertRevisionRecomputed(probe, calls); assert.deepEqual(current, coldRevisionPair(f.file))
})

test('队列修订续用：真实回滚不发布queue-only段，回滚写仍使旧物理起点失效', async t => {
  let fail = false
  const f = await fixture(t, action => { if (action === 'save-mb-queue' && fail) throw new CollectionError('INVENTORY_CONFLICT', '合成队列提交前故障') })
  const probe = queueRevisionProbe(f), initial = queueRevisionRecord()
  f.repository.mbQueue.save({ expectedRevision: '0', queue: initial })
  const baseline = probe.guarded(), before = queueRevisionPoint(probe.db)
  fail = true
  assert.throws(() => f.repository.mbQueue.save({ expectedRevision: '1', queue: { ...initial, revision: '2' } }),
    error => error instanceof CollectionError && error.code === 'INVENTORY_CONFLICT')
  fail = false
  const after = queueRevisionPoint(probe.db), calls = probe.snapshot()
  assert.equal(after.changes, before.changes + 1, 'SQLite回滚不撤销total_changes累计值')
  assert.deepEqual(f.repository.mbQueue.load(initial.datasetId), initial, '原队列仍完整保留')
  assert.equal(localAlbumScanPath(probe.db, before, after, { queueOnly: true }), null)
  assert.deepEqual(probe.guarded(), baseline); assertRevisionRecomputed(probe, calls)
  assert.deepEqual(coldRevisionPair(f.file), baseline)
})

test('队列修订续用：显式事务内每次重算且不发布，事务外回到原冷算点', async t => {
  const f = await fixture(t), probe = queueRevisionProbe(f), baseline = probe.guarded(), initial = queueRevisionRecord()
  f.repository.mbQueue.save({ expectedRevision: '0', queue: initial })
  probe.db.exec('BEGIN')
  try {
    let calls = probe.snapshot(); assert.deepEqual(probe.guarded(), baseline); assertRevisionRecomputed(probe, calls)
    calls = probe.snapshot(); assert.deepEqual(probe.guarded(), baseline); assertRevisionRecomputed(probe, calls)
  } finally { probe.db.exec('ROLLBACK') }
  const calls = probe.snapshot(); assert.deepEqual(probe.guarded(), baseline); assertRevisionRecomputed(probe, calls)
})

test('队列修订续用：另一连接真实内容提交及schema变化仍使原hash缓存重算', async t => {
  for (const mode of ['external', 'schema'] as const) {
    const f = await fixture(t), probe = queueRevisionProbe(f)
    probe.db.exec('CREATE TABLE queue_revision_external(n INTEGER NOT NULL); INSERT INTO queue_revision_external VALUES(0)')
    const baseline = probe.read(), before = queueRevisionPoint(probe.db)
    if (mode === 'external') {
      const external = new DatabaseSync(f.file)
      try { external.exec('UPDATE queue_revision_external SET n=n+1') } finally { external.close() }
      assert.notEqual(queueRevisionPoint(probe.db).version, before.version, '必须是真实data_version前推')
    } else {
      probe.db.exec('CREATE TABLE queue_revision_schema(value TEXT)')
      assert.notEqual(queueRevisionPoint(probe.db).schema, before.schema, '必须是真实schema_version前推')
    }
    // 本项隔离owner-store纯hash；公开catalog原certificate对外部库变化的拒绝由原Gate保留。
    const calls = probe.snapshot(); assert.deepEqual(probe.read(), baseline); assertRevisionRecomputed(probe, calls)
    assert.deepEqual(coldRevisionPair(f.file), baseline)
  }
})

test('队列修订续用：129次不消费逐出起点必须重算，近期逐次consumer跨窗仍无聚合重算', async t => {
  const f = await fixture(t), probe = queueRevisionProbe(f), baseline = probe.guarded(), initial = queueRevisionRecord()
  const before = queueRevisionPoint(probe.db)
  for (let index = 0; index < 129; index++) f.repository.mbQueue.save({ expectedRevision: String(index), queue: { ...initial, revision: String(index + 1) } })
  assert.equal(localAlbumScanPath(probe.db, before, queueRevisionPoint(probe.db), { queueOnly: true }), null)
  let calls = probe.snapshot(); assert.deepEqual(probe.guarded(), baseline); assertRevisionRecomputed(probe, calls)
  for (let index = 129; index < 269; index++) {
    f.repository.mbQueue.save({ expectedRevision: String(index), queue: { ...initial, revision: String(index + 1) } })
    calls = probe.snapshot(); assert.deepEqual(probe.guarded(), baseline); assertRevisionNotRecomputed(probe, calls)
  }
  assert.deepEqual(coldRevisionPair(f.file), baseline)
})

test('队列修订续用：可命中queue链时首屏障末端发生真实DML仍由末屏障拒绝，失败不得发布', async t => {
  const f = await fixture(t), probe = queueRevisionProbe(f), initial = queueRevisionRecord()
  probe.db.exec('CREATE TABLE queue_revision_midread(n INTEGER NOT NULL); INSERT INTO queue_revision_midread VALUES(0)')
  const baseline = probe.guarded()
  f.repository.mbQueue.save({ expectedRevision: '0', queue: initial })
  probe.afterNextSchemaRead(() => { probe.db.exec('UPDATE queue_revision_midread SET n=n+1') })
  assert.throws(() => probe.read(), /读取期间SQL已变化/u)
  const calls = probe.snapshot(); assert.deepEqual(probe.guarded(), baseline); assertRevisionRecomputed(probe, calls)
  assert.deepEqual(coldRevisionPair(f.file), baseline)
})
