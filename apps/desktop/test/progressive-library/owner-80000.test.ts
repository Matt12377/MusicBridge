import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import * as dto from '@music-bridge/contracts'
import { createCollectionRepository } from '../../../../packages/bridge-core/src/collection/repository.js'
import { createLocalAlbumOwnerService } from '../../../../packages/bridge-core/src/collection/local-album-browser/owner-port.js'
import { authorizeSourceDirectory, sourceRootAvailability } from '../../../../packages/bridge-core/src/recording/source-files.js'
import type { ScanPreparedBatch, ScanPreparedItem } from '../../../../packages/bridge-core/src/collection/local-scan-store.js'
import { registerLocalAlbumIpc } from '../../src/main/local-library-workbench/album-ipc.js'
import { createLocalAlbumClient } from '../../src/preload/local-album-client.js'
import { createLocalAlbumBrowserModel } from '../../src/renderer/src/composables/application/local-library-browser/model.js'

// 独立容量Gate，显式执行，不混入每次桌面根目录单元集。
// 真实SQLite/原扫描提交作者/Owner查询/Main与Preload合同/Renderer状态机；IPC投递为受控内存桥。
// 合成prepared metadata不冒充Parser、80,000个媒体文件、Electron实际投递、真实音频或Owner接受。
// 新建的私有SQLite与证据保留在批准的外置TMPDIR，供后续冷启动阶段测量，不打开已有profile。
test('80,000条实际提交记录：扫描尚未完成时首100张可浏览，8000张逐页收敛且成长专辑详情可读', { timeout: 240_000 }, async t => {
  const temporary = process.env.TMPDIR
  assert.ok(temporary && path.isAbsolute(temporary)); assert.equal(await realpath(temporary), temporary)
  assert.ok(temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'))
  const directory = await mkdtemp(path.join(temporary, 'progressive-library-80000-')); await chmod(directory, 0o700)
  const media = path.join(directory, 'owned-empty-source'), file = path.join(directory, 'collection.sqlite')
  await mkdir(media, { mode: 0o700 })
  const repository = createCollectionRepository({ filePath: file }), datasetId = randomUUID()
  const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media))
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' })
  const parserVersion = 'music-metadata-11.15.0/mbrs003-v4'
  const started = repository.localScan.start({ commandId: randomUUID(), datasetId, libraryRootId: root.id, expectedRootRevision: root.revision, parserVersion }).job
  let job = repository.localScan.resume({ commandId: randomUUID(), jobId: started.jobId, expectedRevision: started.jobRevision }), current = true
  const owner = createLocalAlbumOwnerService({ repository, assertCurrent() { assert.equal(current, true) },
    async readRootViews() { return [{ root: repository.localCatalog.root(root.id), label: '合成容量来源', availability: await sourceRootAvailability(repository.sources.root(source.id)) }] },
    async readArtwork() { throw new Error('本Gate不读取媒体或封面') },
  })
  let handler!: (event: {}, value: unknown) => Promise<unknown>, active = 0, maximum = 0, legacyReads = 0, largestPage = 0
  const trusted = Object.freeze({}), calls: { offset: number; limit: number; elapsedMs: number }[] = []
  registerLocalAlbumIpc({ ipcMain: { handle(_channel, callback) { handler = callback } },
    assertTrusted(event) { assert.equal(event, trusted) }, assertDataset(value) { assert.equal(value, datasetId); assert.equal(current, true) },
    async read(body) {
      if (body.command === 'localAlbum.queryVersioned') {
        assert.ok(dto.isLocalAlbumVersionedQuery(body.payload))
        active++; maximum = Math.max(maximum, active); const began = performance.now()
        try { const value = await owner.queryVersionedAlbums(body.payload); largestPage = Math.max(largestPage, value.page.items.length); return value }
        finally { calls.push({ offset: body.payload.offset, limit: body.payload.limit, elapsedMs: performance.now() - began }); active-- }
      }
      if (body.command === 'localAlbum.tracks') return owner.queryAlbumTracks(body.payload)
      throw new Error('容量Gate拒绝其他命令、写操作与新播放route')
    },
  })
  const client = createLocalAlbumClient(async (channel, body) => {
    assert.equal(channel, 'localAlbum:request'); return structuredClone(await handler(trusted, structuredClone(body)))
  }, async () => datasetId)
  const model = createLocalAlbumBrowserModel({ backgroundLoading: false, backgroundArtworkLoading: false, api: {
    async queryAlbums() { legacyReads++; throw new Error('不得降级无版本页') },
    queryVersionedAlbums: request => client.queryLocalAlbumsVersioned!(request),
    queryAlbumTracks: request => client.getLocalAlbumTracks(request),
    async getArtwork() { throw new Error('本Gate没有IMG解码或Source读取资格') },
  } })
  const close = () => { model.dispose(); owner.close(); current = false; repository.close() }
  let closed = false
  t.after(() => { if (!closed) close() })
  const prepared = (album: number, track: number): ScanPreparedItem => {
    const name = `album-${String(album).padStart(5, '0')}`, relative = `${name}/track-${String(track).padStart(2, '0')}.wav`
    return { relative, signature: `controlled-sql-only-${album}-${track}`, parserVersion, outcome: 'accepted',
      fields: { title: `合成曲目${album}-${track}`, artist: '合成艺人', album: name, year: '2026', disc: '1', track: String(track + 1) },
      failureCode: null, reused: false,
      readFacts: { technical: { container: 'WAVE', codec: 'PCM', lossless: true, sampleRateHz: 48000, channels: 2, bitsPerSample: 16, durationSeconds: 10, evidence: 'bounded-parser-reported' },
        coverEvidence: [], readEvidence: { bytesRead: 44, readCalls: 1, maxReadBytes: 44, allocationBytes: 44, elapsedMs: 1, wholeAudioHash: false, wholeAudioDecode: false } } }
  }
  let commits = 0
  const commit = (items: ScanPreparedItem[]) => {
    const batch: ScanPreparedBatch = { batchId: randomUUID(), jobId: job.jobId, expectedJobRevision: job.jobRevision,
      checkpointBefore: job.checkpointRef, items, frontier: [''], completed: false }
    repository.localScan.privatePrepareBatch({ commandId: randomUUID(), jobId: job.jobId, batch })
    job = repository.localScan.privateCommitBatch({ commandId: randomUUID(), jobId: job.jobId, batchId: batch.batchId, expectedRevision: job.jobRevision }); commits++
  }
  commit(Array.from({ length: 100 }, (_, album) => prepared(album, 0)))
  assert.equal(job.phase, 'running'); assert.equal(job.progress.accepted, '100')
  const firstStarted = performance.now(); await model.activate(); const first100Ms = performance.now() - firstStarted
  assert.equal(model.getSnapshot().items.length, 100); assert.ok(first100Ms < 2000, '100条已提交记录到首100张不等待尾部79900条')
  const first = model.getSnapshot().items[0]!
  await model.openAlbum(first)
  assert.equal(model.getSnapshot().trackTotal, 1); assert.equal(job.progress.accepted, '100')
  const refreshes: Promise<void>[] = [], seedStarted = performance.now()
  let batch: ScanPreparedItem[] = []
  for (let index = 0; index < 80_000; index++) {
    const album = Math.floor(index / 10), track = index % 10
    if (album < 100 && track === 0) continue
    batch.push(prepared(album, track))
    if (batch.length === 200) {
      commit(batch); batch = []; refreshes.push(model.refresh())
      if (commits % 20 === 0) await new Promise<void>(resolve => setImmediate(resolve))
    }
  }
  if (batch.length) { commit(batch); refreshes.push(model.refresh()) }
  await Promise.all(refreshes)
  const seed80000Ms = performance.now() - seedStarted, callsAfterCommits = calls.length
  assert.equal(job.phase, 'running'); assert.equal(job.progress.accepted, '80000'); assert.ok(callsAfterCommits <= 10, '401次提交不能制造401轮前缀重读')
  for (let page = 0; page < 100 && model.getSnapshot().hasMore; page++) await model.loadMore()
  assert.equal(model.getSnapshot().hasMore, false); assert.equal(model.getSnapshot().loadMoreError, '')
  if (model.getSnapshot().reconciling) {
    await model.refresh()
    for (let page = 0; page < 100 && model.getSnapshot().hasMore; page++) await model.loadMore()
  }
  const complete = model.getSnapshot()
  assert.equal(complete.reconciling, false); assert.equal(complete.items.length, 8000); assert.equal(complete.total, 8000)
  assert.equal(new Set(complete.items.map(value => value.id)).size, 8000)
  assert.equal(complete.items.reduce((total, value) => total + value.trackCount, 0), 80_000)
  assert.equal(maximum, 1); assert.equal(legacyReads, 0); assert.equal(largestPage, 100); assert.ok(calls.every(call => call.limit <= 100))
  // 用户再次打开旧首屏卡片时读取当前真实详情；成长修订不被旧显示摘要误拒绝，不修改任何队列。
  await model.openAlbum(first); assert.equal(model.getSnapshot().trackTotal, 10); assert.equal(model.getSnapshot().detailError, '')
  repository.localCatalog.privateRead(db => {
    for (const table of ['local_catalog_tracks', 'local_catalog_assets', 'local_scan_file_state']) assert.equal(Number(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n), 80_000)
  })
  close(); closed = true
  const proof = { schemaVersion: 1, stage: 'progressive-library-batches', synthetic: true, database: file, source: media, datasetId,
    libraryRootId: root.id, rows: 80_000, albums: 8000, commits, first100Ms, seed80000Ms, queryCalls: calls.length, callsAfterCommits,
    largestPage, maximumConcurrentGalleryReads: maximum, sqliteBytes: (await stat(file)).size, scanPhaseAtLastRead: job.phase,
    parserExecuted: false, actualElectronTransport: false, actualAudio: false, ownerAccepted: false, result: 'pass', calls }
  await writeFile(path.join(directory, 'proof.json'), JSON.stringify(proof, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  console.info('PROGRESSIVE_LIBRARY_80000_PASS ' + JSON.stringify({ rows: proof.rows, albums: proof.albums, first100Ms, seed80000Ms, queryCalls: proof.queryCalls, commits, largestPage }))
})
