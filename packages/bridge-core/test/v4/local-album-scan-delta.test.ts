import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import * as dto from '@music-bridge/contracts'
import { buildStoragePolicy } from '../../../../apps/desktop/scripts/build-storage-root.mjs'
import { createCollectionRepository, type CollectionRepository } from '../../src/collection/repository.js'
import { authorizeSourceDirectory } from '../../src/recording/source-files.js'
import { createLocalAlbumOwnerService } from '../../src/collection/local-album-browser/owner-port.js'
import type { LocalAlbumLibraryOrganization } from '../../src/collection/local-album-browser/sql-types.js'
import type { ScanPreparedBatch, ScanPreparedItem } from '../../src/collection/local-scan-store.js'
import { readLibraryOperationLine, type LibraryOperationEvent } from '../../src/shared/library-operation-log.js'

const parserVersion = 'music-metadata-11.15.0/mbrs003-v1'
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

test('扫描Compact增量：真实prepare/commit连续3×16新曲只全root构建一次，卡片/counts/revision逐批等于独立冷全量', async t => {
  const events = observe(t), f = await fixture(t)
  f.submit([accepted('稳定/01.wav'), accepted('同目录/01.wav'), accepted('其他/01.wav'), rejected('拒收/损坏.wav')])
  const baseline = await read(f.owner, events), stable = baseline.page.items.find(album => album.title === '稳定')!
  assert.equal(codeCount(baseline.events, 'COMPACT_BUILT'), 1); assert.equal(baseline.page.total, 4)
  let builds = codeCount(baseline.events, 'COMPACT_BUILT')
  for (let batch = 0; batch < 3; batch++) {
    const items = Array.from({ length: 16 }, (_, index) => accepted(`${index % 2 ? '同目录' : `新增${batch}`}/批${batch}-曲${index}.wav`))
    f.submit(items)
    const current = await read(f.owner, events); builds += codeCount(current.events, 'COMPACT_BUILT')
    assert.equal(codeCount(current.events, 'COMPACT_SCAN_DELTA'), 1)
    assert.deepEqual(current.page, await f.cold(), `第${batch + 1}批必须含完整卡片和所有counts，不能只对比total`)
    assert.deepEqual(current.page.items.find(album => album.id === stable.id), stable, '未触及目录的卡片与修订不改变')
    assert.equal(current.page.items.reduce((sum, album) => sum + album.trackCount, 0), 3 + (batch + 1) * 16)
  }
  assert.equal(builds, 1)
  assert.deepEqual(f.job.progress, { visited: '52', accepted: '51', rejected: '1' })
})

test('扫描Compact增量：近期消费者真实70批跨128段滑窗仍只全root构建一次，末轮等于独立冷全量', async t => {
  const events = observe(t), f = await fixture(t)
  f.submit([accepted('稳定/01.wav'), accepted('滑窗/01.wav')])
  const baseline = await read(f.owner, events), stable = baseline.page.items.find(album => album.title === '稳定')!
  assert.equal(codeCount(baseline.events, 'COMPACT_BUILT'), 1)
  let builds = codeCount(baseline.events, 'COMPACT_BUILT'), deltas = 0, last = baseline.page
  for (let batch = 0; batch < 70; batch++) {
    // 每轮均提交真正的新音频事实并立即消费；70×prepare/commit必跨越128段保留窗。
    f.submit([accepted(`滑窗/新曲${batch}.wav`)])
    const current = await read(f.owner, events)
    builds += codeCount(current.events, 'COMPACT_BUILT'); deltas += codeCount(current.events, 'COMPACT_SCAN_DELTA')
    assert.equal(codeCount(current.events, 'COMPACT_BUILT'), 0, `第${batch + 1}批不应因已消费旧段被逐出而全root`)
    assert.equal(codeCount(current.events, 'COMPACT_SCAN_DELTA'), 1)
    assert.equal(current.page.total, 2); assert.equal(current.page.counts.all, 2)
    assert.equal(current.page.items.find(album => album.title === '滑窗')!.trackCount, batch + 2)
    assert.deepEqual(current.page.items.find(album => album.id === stable.id), stable)
    last = current.page
  }
  assert.equal(builds, 1); assert.equal(deltas, 70)
  assert.deepEqual(f.job.progress, { visited: '72', accepted: '72', rejected: '0' })
  assert.deepEqual(last, await f.cold(), '跨窗后仍须完整对齐卡片、全部counts和每张修订')
})

test('扫描Compact增量：标签改组删除旧组，拒收与零曲CUE fallback均按原facts完整重建脏目录', async t => {
  const events = observe(t), f = await fixture(t)
  f.submit([accepted('改组/01.wav', '旧专辑'), accepted('稳定/01.wav')]); f.submit([], [])
  const before = await read(f.owner, events), old = before.page.items.find(album => album.title === '旧专辑')!
  f.submit([accepted('改组/01.wav', '新专辑', '新文件签名'), rejected('仅拒收/损坏.wav')])
  const changed = await read(f.owner, events)
  assert.equal(codeCount(changed.events, 'COMPACT_SCAN_DELTA'), 1)
  assert.ok(!changed.page.items.some(album => album.id === old.id)); assert.ok(changed.page.items.some(album => album.title === '新专辑'))
  assert.deepEqual(changed.page, await f.cold())
  f.submit([], [{ relative: '仅CUE/损坏.cue', signature: '合成失败CUE', parserVersion: 'cue-text-75fps/mbrs003-v1', outcome: 'rejected', failureCode: 'CUE_PARSE_FAILED', reused: false, previousSnapshotId: null, result: null }])
  const cue = await read(f.owner, events)
  assert.equal(codeCount(cue.events, 'COMPACT_SCAN_DELTA'), 1)
  assert.ok(cue.page.items.some(album => album.title === '仅CUE' && album.trackCount === 0 && album.statuses.includes('cue-unsplit')))
  assert.deepEqual(cue.page, await f.cold())
})

test('扫描Compact增量：当前及新增同目录CUE完整核引用后局部更新，跨目录CUE与其后续影响回原root', async t => {
  const events = observe(t), f = await fixture(t)
  f.submit([accepted('CUE/整轨.wav'), accepted('稳定/01.wav')]); f.submit([], [])
  const baseline = await read(f.owner, events); assert.equal(codeCount(baseline.events, 'COMPACT_BUILT'), 1)
  f.submit([], [f.cue('CUE/disc.cue', 'CUE/整轨.wav')])
  const added = await read(f.owner, events)
  assert.equal(codeCount(added.events, 'COMPACT_SCAN_DELTA'), 1); assert.deepEqual(added.page, await f.cold())
  assert.ok(added.page.items.find(album => album.title === 'CUE')!.statuses.includes('cue-unsplit'))
  f.submit([accepted('CUE/新曲.wav')])
  const existing = await read(f.owner, events)
  assert.equal(codeCount(existing.events, 'COMPACT_SCAN_DELTA'), 1); assert.deepEqual(existing.page, await f.cold())
  f.submit([], [f.cue('侧车/跨目录.cue', 'CUE/整轨.wav')])
  const crossed = await read(f.owner, events)
  assert.equal(codeCount(crossed.events, 'COMPACT_SCAN_DELTA'), 0); assert.equal(codeCount(crossed.events, 'COMPACT_BUILT'), 1)
  assert.deepEqual(crossed.page, await f.cold())
  f.submit([accepted('CUE/后续.wav')])
  const later = await read(f.owner, events)
  assert.equal(codeCount(later.events, 'COMPACT_SCAN_DELTA'), 0); assert.equal(codeCount(later.events, 'COMPACT_BUILT'), 1)
  assert.deepEqual(later.page, await f.cold())
})

test('扫描Compact增量：实际scope的catalog角色可局部，artist/album角色或活动edition均回原root', async t => {
  const events = observe(t)
  for (const mode of ['catalog', 'artist', 'album', 'edition'] as const) {
    const f = await fixture(t); f.submit([accepted('原目录/01.wav')])
    if (mode === 'edition') {
      const edition = f.repository.localCatalog.createEdition({ commandId: randomUUID(), title: '合成发行', edition: '' })
      const trackId = f.repository.localScan.privateFileState(f.root.id, '原目录/01.wav')!.value.trackId!
      f.repository.localCatalog.linkEditionTrack({ commandId: randomUUID(), editionId: edition.id, trackId, disc: 1, trackNumber: 1, sequence: 1 })
    } else f.role(mode)
    await read(f.owner, events); f.submit([accepted('新目录/01.wav')])
    const current = await read(f.owner, events)
    assert.equal(codeCount(current.events, 'COMPACT_SCAN_DELTA'), mode === 'catalog' ? 1 : 0, mode)
    assert.equal(codeCount(current.events, 'COMPACT_BUILT'), mode === 'catalog' ? 0 : 1, mode)
    assert.deepEqual(current.page, await f.cold(), mode)
  }
})

test('扫描Compact增量：beforeCommit未知实际写即弃链，即使action及最终业务内容相同也完整重建', async t => {
  const events = observe(t), f = await fixture(t)
  f.submit([accepted('稳定/01.wav')]); await read(f.owner, events)
  let injected = 0
  f.inject(action => {
    if (action === 'local-scan:commit-batch') {
      // 有实际写入但最终JSON不变，不能凭action或业务结果掩盖未知写集。
      f.database.prepare('UPDATE local_scan_jobs SET data=data WHERE id=?').run(f.job.jobId); injected++
    }
  })
  f.submit([accepted('新目录/01.wav')]); f.inject(undefined)
  const current = await read(f.owner, events)
  assert.equal(injected, 1); assert.equal(codeCount(current.events, 'COMPACT_SCAN_DELTA'), 0); assert.equal(codeCount(current.events, 'COMPACT_BUILT'), 1)
  assert.deepEqual(current.page, await f.cold())
})

test('扫描Compact增量：rollback不发布；原批重试可恢复局部；receipt重放不新增写或修订', async t => {
  const events = observe(t), f = await fixture(t)
  f.submit([accepted('稳定/01.wav')]); const baseline = await read(f.owner, events)
  const prepared = f.prepare([accepted('新目录/01.wav')])
  const jobBefore = structuredClone(f.job)
  f.inject(action => { if (action === 'local-scan:commit-batch') throw new Error('合成提交前回滚') })
  assert.throws(() => f.commit(prepared)); f.inject(undefined)
  assert.deepEqual(f.repository.localScan.get(f.job.jobId), jobBefore)
  assert.equal(f.repository.localScan.receipt(prepared.commit.commandId), null)
  const rolledBack = await read(f.owner, events)
  assert.deepEqual(rolledBack.page, baseline.page); assert.equal(codeCount(rolledBack.events, 'COMPACT_SCAN_DELTA'), 0)
  assert.equal(codeCount(rolledBack.events, 'COMPACT_BUILT'), 1)
  f.commit(prepared)
  const committed = await read(f.owner, events)
  assert.equal(codeCount(committed.events, 'COMPACT_SCAN_DELTA'), 1); assert.deepEqual(committed.page, await f.cold())
  const beforePoint = f.database.prepare('SELECT total_changes() n').get()?.n
  assert.deepEqual(f.repository.localScan.privateCommitBatch(structuredClone(prepared.commit)), f.job)
  assert.equal(f.database.prepare('SELECT total_changes() n').get()?.n, beforePoint)
  const replayed = await read(f.owner, events)
  assert.deepEqual(replayed.page, committed.page); assert.equal(codeCount(replayed.events, 'COMPACT_BUILT'), 0); assert.equal(codeCount(replayed.events, 'COMPACT_SCAN_DELTA'), 0)
})

test('扫描Compact增量：滑窗逐出旧起点后129段未消费读者仍完整回退，不把后缀当none证明', async t => {
  const events = observe(t), f = await fixture(t)
  f.submit([accepted('稳定/01.wav')]); const baseline = await read(f.owner, events)
  for (let index = 0; index < 129; index++) f.prepare([])
  const current = await read(f.owner, events)
  assert.deepEqual(current.page, baseline.page); assert.deepEqual(current.page, await f.cold())
  assert.equal(codeCount(current.events, 'COMPACT_SCAN_UNCHANGED'), 0); assert.equal(codeCount(current.events, 'COMPACT_BUILT'), 1)
})

test('扫描Compact增量：无Owner私有品牌的旧scope保持原完整物理屏障，不借用扫描增量', async t => {
  const events = observe(t), f = await fixture(t)
  const unbranded = () => ({ revision: `${f.repository.localCatalog.privateAlbumBrowserRevision()}-${f.repository.localScan.privateAlbumBrowserRevision()}`, roots: f.roots() })
  f.submit([accepted('稳定/01.wav')]); f.repository.localCatalog.privateAlbumBrowserQuery(request(), unbranded())
  f.submit([accepted('新目录/01.wav')]); const start = events.length
  const current = f.repository.localCatalog.privateAlbumBrowserQuery(request(), unbranded()), observed = events.slice(start)
  assert.equal(codeCount(observed, 'COMPACT_SCAN_DELTA'), 0); assert.equal(codeCount(observed, 'COMPACT_BUILT'), 1)
  assert.deepEqual(current, await f.cold())
})


test('旧封面claim与连续扫描：每批先拒绝旧claim，完整末屏障后保留Compact/CUE增量，不触发整root', async t => {
  const events = observe(t), f = await fixture(t)
  f.submit([accepted('目标/01.wav'), accepted('稳定/01.wav')])
  f.submit([], [f.cue('目标/disc.cue', '目标/01.wav')])
  const baseline = await read(f.owner, events); let previous = baseline.page.items.find(album => album.title === '目标')!
  assert.ok(previous); assert.equal(codeCount(baseline.events, 'COMPACT_BUILT'), 1)
  for (let index = 0; index < 3; index++) {
    f.submit([accepted(`目标/新增${index}.wav`), accepted(`新目录${index}/01.wav`)])
    const staleStart = events.length
    const stale = { albumKey: previous.id, rootId: previous.rootId, revision: previous.revision,
      editionId: previous.editionId, representativeTrackId: previous.representativeTrackId }
    for (let duplicate = 0; duplicate < 2; duplicate++) await assert.rejects(f.owner.getArtwork(stale), { code: 'SNAPSHOT_CHANGED' })
    const rejected = events.slice(staleStart)
    assert.equal(codeCount(rejected, 'ARTWORK_CLAIM_STALE'), 2)
    assert.equal(codeCount(rejected, 'COMPACT_BUILT'), 0)
    const current = await read(f.owner, events)
    assert.equal(codeCount(current.events, 'COMPACT_BUILT'), 0)
    assert.deepEqual(current.page, await f.cold(), '完整卡片/counts/revision仍等于独立冷全量')
    previous = current.page.items.find(album => album.id === previous.id)!
    assert.ok(previous); assert.equal(previous.trackCount, index + 2)
  }
})


test('扫描重分组后的旧claim缺组：多次拒绝仍保当前Compact/CUE，下一批不退回整root', async t => {
  const events = observe(t), f = await fixture(t)
  f.submit([accepted('改组/01.wav', '旧专辑'), accepted('稳定/01.wav')])
  const baseline = await read(f.owner, events), previous = baseline.page.items.find(album => album.title === '旧专辑')!
  assert.ok(previous); assert.equal(codeCount(baseline.events, 'COMPACT_BUILT'), 1)
  f.submit([accepted('改组/01.wav', '新专辑', '真实替换后的合成签名')])
  const start = events.length, stale = { albumKey: previous.id, rootId: previous.rootId, editionId: previous.editionId,
    representativeTrackId: previous.representativeTrackId, revision: previous.revision }
  for (let duplicate = 0; duplicate < 3; duplicate++) await assert.rejects(f.owner.getArtwork(stale), { code: 'SNAPSHOT_CHANGED' })
  const rejected = events.slice(start)
  assert.equal(codeCount(rejected, 'ARTWORK_CLAIM_STALE'), 3)
  assert.equal(codeCount(rejected, 'COMPACT_SCAN_DELTA'), 1); assert.equal(codeCount(rejected, 'COMPACT_BUILT'), 0)
  assert.equal(rejected.some(event => event.action === 'albums.read-cache.evict'), false)
  const current = await read(f.owner, events)
  assert.equal(codeCount(current.events, 'COMPACT_BUILT'), 0)
  assert.equal(current.page.items.some(album => album.id === previous.id), false)
  assert.ok(current.page.items.some(album => album.title === '新专辑'))
  assert.deepEqual(current.page, await f.cold())
  f.submit([accepted('改组/02.wav', '新专辑')])
  const next = await read(f.owner, events)
  assert.equal(codeCount(next.events, 'COMPACT_SCAN_DELTA'), 1); assert.equal(codeCount(next.events, 'COMPACT_BUILT'), 0)
  assert.deepEqual(next.page, await f.cold(), '后继增量还须有原CUE投影作者，不能只保Compact而丢CUE')
})
