import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import * as dto from '@music-bridge/contracts'
import { createCollectionRepository } from '../../src/collection/repository.js'
import { LocalCatalogBudgetError, verifyLocalCatalogDatabase } from '../../src/collection/local-catalog-store.js'
import { createLocalAlbumOwnerService } from '../../src/collection/local-album-browser/owner-port.js'
import { createBackupWorkflowStore, type BackupWorkflowStore } from '../../src/recording/backup-workflow-store.js'
import type { DatasetIdentity } from '../../src/recording/dataset-identity.js'
import { authorizeSourceDirectory, sourceRootAvailability } from '../../src/recording/source-files.js'
import type { ScanPreparedBatch, ScanPreparedItem } from '../../src/collection/local-scan-store.js'

// 草案只创建任务自有SQLite/合成prepared metadata，不运行Parser、用户扫描、Provider或播放。
export const capacityLimits = Object.freeze({ wholeMs: 600000, requestMs: 30000, ownerMs: 2000,
  catalogRows: 300000, privateItems: 10000, privateBytes: 33554432, publicItems: 2048, publicBytes: 131072 })
export function capacityRoot(): string {
  const root = process.env.MB_V39_CAPACITY_PROOF_DIR
  assert.ok(root && path.isAbsolute(root) && realpathSync(root) === root && lstatSync(root).isDirectory())
  assert.match(process.env.MB_V39_SOURCE_SHA ?? '', /^[a-f0-9]{40}$/u)
  assert.match(process.env.MB_V39_SCOPE_SHA256 ?? '', /^[a-f0-9]{64}$/u)
  assert.equal(process.env.MB_V39_OWNER_DEADLINE_MS, '2000'); assert.equal(process.env.MB_V39_REQUEST_DEADLINE_MS, '30000')
  return root
}
export function capacityCheck(): void {
  const deadline = Number(process.env.MB_V39_GATE_DEADLINE)
  assert.ok(Number.isFinite(deadline) && Date.now() < deadline, '容量整域600秒期限必须仍未耗尽')
}
export function capacityPin(relative: string, bytes: Buffer): { path: string; bytes: number; sha256: string } {
  return { path: relative, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}
export function capacityEvidence(relative: string, value: unknown) {
  const file = path.join(capacityRoot(), relative); assert.ok(file.startsWith(capacityRoot() + path.sep))
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n'); assert.ok(bytes.length <= 16777216)
  writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 }); return capacityPin(relative, bytes)
}
export function capacityMerge(update: Record<string, unknown>): void {
  const root = capacityRoot(), file = path.join(root, 'proof.json'), temporary = path.join(root, '.proof-' + randomUUID() + '.json')
  let previous: Record<string, unknown> = {}
  try { previous = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (Object.keys(previous).length) {
    assert.equal(previous.sourceSha, process.env.MB_V39_SOURCE_SHA); assert.equal(previous.scopeSha256, process.env.MB_V39_SCOPE_SHA256)
  }
  const value = { schema: 'musicbridge.v39.integration002.capacity-proof.v1', task: 'V39-INTEGRATION-002',
    sourceSha: process.env.MB_V39_SOURCE_SHA, scopeSha256: process.env.MB_V39_SCOPE_SHA256,
    changedDomains: ['current-album-sql', 'current-whole-group-workbench-journal'], datasets: [], queries: [], boundaries: [],
    preservedFailures: ['SQL548_300K_NOT_PASSED'], inheritedEvidence: [], ...previous, ...update }
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); renameSync(temporary, file)
}
export function capacityWhole(file: string): { bytes: number; sha256: string } {
  assert.equal(realpathSync(file), file); const handle = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { const before = fstatSync(handle, { bigint: true }); assert.ok(before.isFile() && before.size <= 4n * 1024n ** 3n)
    const hash = createHash('sha256'), buffer = Buffer.alloc(65536); let count = 0
    for (;;) { capacityCheck(); const size = readSync(handle, buffer, 0, buffer.length, null); if (!size) break; hash.update(buffer.subarray(0, size)); count += size }
    const after = fstatSync(handle, { bigint: true }), named = lstatSync(file, { bigint: true })
    for (const key of ['dev','ino','size','mtimeNs','ctimeNs'] as const) { assert.equal(after[key], before[key]); assert.equal(named[key], before[key]) }
    assert.equal(BigInt(count), before.size); return { bytes: count, sha256: hash.digest('hex') }
  } finally { closeSync(handle) }
}
export interface CapacityCorpus { file: string; state: string; media: string; rootId: string; datasetId: string }
export function capacityCorpus(): CapacityCorpus {
  const raw = JSON.parse(readFileSync(path.join(capacityRoot(), 'album-capacity/corpus.json'), 'utf8')) as CapacityCorpus & { sourceSha: string; scopeSha256: string }
  assert.equal(raw.sourceSha, process.env.MB_V39_SOURCE_SHA); assert.equal(raw.scopeSha256, process.env.MB_V39_SCOPE_SHA256)
  for (const file of [raw.file, raw.state, raw.media]) assert.ok(file.startsWith(capacityRoot() + '/album-capacity/'))
  return raw
}
export interface CapacityOwner extends Omit<CapacityCorpus, 'state'> {
  repository: ReturnType<typeof createCollectionRepository>
  state: BackupWorkflowStore
  identity: DatasetIdentity
  owner: ReturnType<typeof createLocalAlbumOwnerService>
  close(): void
}
export async function openCapacityOwner(): Promise<CapacityOwner> {
  const corpus = capacityCorpus(), repository = createCollectionRepository({ filePath: corpus.file })
  const state = createBackupWorkflowStore({ filePath: corpus.state }); let closed = false
  try {
    repository.localCatalog.roots(); const identity = state.datasetIdentities.bind('default', corpus.file, false)
    assert.equal(identity.datasetId, corpus.datasetId); repository.localCatalog.privateBindWorkbenchDataset(identity)
    const check = () => { assert.equal(closed, false); identity.assertCurrent() }
    const owner = createLocalAlbumOwnerService({ repository, assertCurrent: check,
      readRootViews: async () => Promise.all(repository.localCatalog.roots().map(async root => ({ root,
        label: '任务自有300k合成SQL库', availability: await sourceRootAvailability(repository.sources.root(root.sourceRootId)) }))),
      readArtwork: async () => ({ image: null, status: 'ready' }) })
    return { ...corpus, repository, state, identity, owner,
      close() { owner.close(); repository.close(); state.close(); closed = true
        assert.throws(() => repository.localCatalog.roots()); assert.throws(() => state.overview()) } }
  } catch (error) { repository.close(); state.close(); throw error }
}
export async function capacityRequest<T>(id: string, cold: boolean, action: () => T | Promise<T>, group: (result: T) => { items: number; bytes: number; truncated: false }) {
  capacityCheck(); const began = performance.now(); const result = await action(); const elapsedMs = performance.now() - began; capacityCheck()
  assert.ok(elapsedMs <= capacityLimits.requestMs); assert.ok(elapsedMs <= capacityLimits.ownerMs, '原Owner2000ms期限不能由30秒请求域替代')
  const completeGroup = group(result); assert.ok(completeGroup.items <= 10000 && completeGroup.bytes <= 33554432)
  const record = { id, datasetId: capacityCorpus().datasetId, cold, elapsedMs, rssBytes: process.memoryUsage().rss,
    requestDeadlineMs: 30000, ownerDeadlineMs: 2000, completeGroup, exitCode: 0, signal: null }
  const raw = capacityEvidence('album-capacity/requests/' + id + '.json', record)
  return { result, query: { ...record, raw } }
}
const query: dto.LocalAlbumQuery = { query: '', rootId: null, filter: 'all', offset: 0, limit: 200 }
function relative(index: number): string {
  const directory = index < 10000 ? 'whole-10000' : index < 12048 ? 'small-2048' : 'other-' + Math.floor((index - 12048) / 10000)
  return directory + '/' + String(index).padStart(6, '0') + '.wav'
}
async function seedCorpus(): Promise<void> {
  const root = capacityRoot(), directory = path.join(root, 'album-capacity'); mkdirSync(directory, { mode: 0o700 })
  const file = path.join(directory, 'library.sqlite'), stateFile = path.join(directory, 'dataset-identity.sqlite'), media = path.join(directory, 'owned-source')
  mkdirSync(media, { mode: 0o700 }); const repository = createCollectionRepository({ filePath: file }), state = createBackupWorkflowStore({ filePath: stateFile })
  try {
    const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media))
    const library = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' })
    const identity = state.datasetIdentities.bind('default', file, false); repository.localCatalog.privateBindWorkbenchDataset(identity)
    const parserVersion = 'music-metadata-11.15.0/mbrs003-v4'
    let job = repository.localScan.start({ commandId: randomUUID(), datasetId: identity.datasetId,
      libraryRootId: library.id, expectedRootRevision: library.revision, parserVersion }).job
    job = repository.localScan.resume({ commandId: randomUUID(), jobId: job.jobId, expectedRevision: job.jobRevision })
    for (let offset = 0; offset < 300000; offset += 200) {
      capacityCheck(); const items: ScanPreparedItem[] = Array.from({ length: Math.min(200, 300000 - offset) }, (_value, delta) => {
        const index = offset + delta, name = relative(index), directoryName = name.slice(0, name.indexOf('/'))
        return { relative: name, signature: 'controlled-sql-only-' + index, parserVersion, outcome: 'accepted',
          fields: { title: '合成曲目' + index, artist: '合成艺人', album: directoryName, year: '2026', disc: '1', track: String(index + 1) },
          failureCode: null, reused: false, readFacts: null }
      })
      const batch: ScanPreparedBatch = { batchId: randomUUID(), jobId: job.jobId, expectedJobRevision: job.jobRevision,
        checkpointBefore: job.checkpointRef, items, frontier: [], completed: offset + items.length === 300000 }
      repository.localScan.privatePrepareBatch({ commandId: randomUUID(), jobId: job.jobId, batch })
      job = repository.localScan.privateCommitBatch({ commandId: randomUUID(), jobId: job.jobId, batchId: batch.batchId, expectedRevision: job.jobRevision })
      if ((offset + items.length) % 50000 === 0) process.stdout.write(JSON.stringify({ syntheticPreparedRows: offset + items.length, parserExecuted: false }) + '\n')
    }
    assert.equal(job.phase, 'completed')
    repository.localCatalog.privateRead(db => {
      assert.equal(Number(db.prepare('SELECT count(*) n FROM local_catalog_tracks').get()!.n), 300000)
      assert.equal(Number(db.prepare('SELECT count(*) n FROM local_catalog_assets').get()!.n), 300000)
      assert.equal(Number(db.prepare('SELECT count(*) n FROM local_scan_file_state').get()!.n), 300000)
    })
    capacityEvidence('album-capacity/corpus.json', { file, state: stateFile, media, rootId: library.id, datasetId: identity.datasetId,
      sourceSha: process.env.MB_V39_SOURCE_SHA, scopeSha256: process.env.MB_V39_SCOPE_SHA256,
      suppliedPreparedMetadataIsControlled: true, actualParserAudioProviderUserDataEvidence: false })
  } finally { repository.close(); state.close() }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  test('002容量：真实300k全部SQL成员计数及当前Owner冷暖查询不以20000样本代替', async () => {
    await seedCorpus(); const queries = [], live = await openCapacityOwner()
    try { for (const cold of [true, false]) { const observed = await capacityRequest(cold ? 'catalog-cold' : 'catalog-warm', cold, () => live.owner.queryAlbums(query), result => ({ items: result.items.length, bytes: Buffer.byteLength(JSON.stringify(result)), truncated: false }))
        assert.equal(observed.result.total, 31); assert.equal(observed.result.counts.all, 31)
        assert.equal(observed.result.items.reduce((n, album) => n + album.trackCount, 0), 300000)
        assert.ok(observed.result.items.some(album => album.trackCount === 10000)); assert.ok(observed.result.items.some(album => album.trackCount === 2048)); queries.push(observed.query)
      }
    } finally { live.close() }
    const corpus = capacityCorpus(), witness = capacityEvidence('album-capacity/database-identity.json', { actualClosedSqliteWhole: capacityWhole(corpus.file),
      physicalDatasetStoreWhole: capacityWhole(corpus.state), rows: { catalogTracks: 300000, assets: 300000, scanFileState: 300000, relations: 0 },
      largeDatabaseBytesAreHashedSameFdIn64KiBChunks: true, rawBudgetNotRaised: true })
    capacityMerge({ datasets: [{ id: corpus.datasetId, synthetic: true, identity: witness,
      rows: { catalogTracks: 300000, assets: 300000, scanFileState: 300000, relations: 0 } }], queries })
  })
  test('002容量：真实301000曲目整组预算先拒绝并保留原300k数据', () => {
    const corpus = capacityCorpus(), db = new DatabaseSync(corpus.file, { allowExtension: false })
    try {
      const asset = String(db.prepare('SELECT asset_id FROM local_catalog_tracks LIMIT 1').get()!.asset_id)
      db.exec('BEGIN IMMEDIATE')
      try { const insert = db.prepare('INSERT INTO local_catalog_tracks VALUES(?,?,?)')
        for (let i = 0; i < 1000; i++) { const id = '99000000-0000-4000-8000-' + String(i).padStart(12, '0')
          insert.run(id, asset, JSON.stringify({ id, assetId: asset, selectionRevision: '1', segment: null })) }
        assert.equal(Number(db.prepare('SELECT count(*) n FROM local_catalog_tracks').get()!.n), 301000)
        assert.throws(() => verifyLocalCatalogDatabase(db), error => error instanceof LocalCatalogBudgetError && error.actual === 301000 && error.limit === 300000)
      } finally { db.exec('ROLLBACK') }
      assert.equal(Number(db.prepare('SELECT count(*) n FROM local_catalog_tracks').get()!.n), 300000)
    } finally { db.close(); assert.throws(() => db.prepare('SELECT 1')) }
    const raw = capacityEvidence('album-capacity/catalog-301000-rejected.json', { actualInputRows: 301000, actualLimit: 300000, rejected: true, rollbackRows: 300000 })
    capacityMerge({ boundaries: [{ id: 'catalog-301000-rejected', accepted: false, actualLimit: 300000, actualRows: 301000, raw }] })
  })
}
