import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { fstatSync } from 'node:fs'
import { mkdtemp, mkdir, open, readFile, rm, stat, unlink, writeFile, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import * as dto from '@music-bridge/contracts'
import { createCollectionRepository } from '../src/collection/repository.js'
import { createLocalAlbumOwnerRuntime } from '../src/collection/local-album-browser/owner-runtime.js'
import { isDatasetProjectionPayload, type DatasetProjectionPort } from '../src/collection/dataset-owner-protocol.js'
import { createScanReadAdmission } from '../src/library/scan-read-admission.js'
import { authorizeSourceDirectory, sourceRootAvailability } from '../src/recording/source-files.js'

// 真实Owner/SQLite/Source/许可；规范化器是合成映射，不是Native解码或真实音乐库证明。
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const query = { query: '', rootId: null, filter: 'all' as const, offset: 0, limit: 60 }
const request = (album: dto.LocalAlbumSummary): dto.LocalAlbumArtworkRequest => ({ albumKey: album.id, rootId: album.rootId, editionId: album.editionId, representativeTrackId: album.representativeTrackId, revision: album.revision })
async function fixture(t: test.TestContext, options: { unsupportedAudio?: boolean } = {}) {
  const temporary = process.env.TMPDIR
  if (!temporary?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/')) throw new Error('合成资料须用外置临时目录。')
  const directory = await mkdtemp(path.join(temporary, 'mbf-album-cache-runtime-')), media = path.join(directory, 'media'), work = path.join(directory, 'work.sqlite')
  await mkdir(path.join(media, 'album'), { recursive: true })
  const audio = options.unsupportedAudio ? Buffer.from('unsupported-synthetic-container') : await readFile(new URL('./fixtures/mbrs003/audio/fixtures/core-wav.wav', import.meta.url))
  const png16 = await readFile(new URL('./fixtures/mbrs012-source/owned-cover-16.png', import.meta.url)), jpg16 = await readFile(new URL('./fixtures/mbrs012-source/owned-cover-16.jpg', import.meta.url))
  const png32 = await readFile(new URL('./fixtures/mbrs012-source/owned-cover-32.png', import.meta.url)), jpg32 = await readFile(new URL('./fixtures/mbrs012-source/owned-cover-32.jpg', import.meta.url))
  await writeFile(path.join(media, 'album/song.wav'), audio); await writeFile(path.join(media, 'album/folder.png'), png16)
  const identities = new Set<string>()
  const register = async (relative: string) => { const info = await stat(path.join(media, relative)); identities.add(`${info.dev}:${info.ino}`) }
  await register('album/song.wav'); await register('album/folder.png')
  const probe = await open(path.join(media, 'album/song.wav'), 'r'), prototype = Object.getPrototypeOf(probe), originalRead = prototype.read; await probe.close()
  let bodyReads = 0, bodyBytes = 0, normalizes = 0, acquires = 0, maximumPermits = 0, displayBusy = false
  const normalizerDeadlines: number[] = []
  let bodyBlock: { wait: Promise<void>; enter(): void } | undefined
  let onNormalize: (() => Promise<void>) | undefined, onRootRead: (() => Promise<void>) | undefined
  t.mock.method(prototype, 'read', async function (this: FileHandle, ...args: unknown[]) {
    let observed = false
    try { const info = fstatSync(this.fd); observed = identities.has(`${info.dev}:${info.ino}`) } catch { /* 非目标FD保原行为。 */ }
    if (observed && bodyBlock) { bodyBlock.enter(); await bodyBlock.wait }
    const result = await Reflect.apply(originalRead, this, args) as Awaited<ReturnType<FileHandle['read']>>
    if (observed) { bodyReads++; bodyBytes += result.bytesRead }
    return result
  })
  let repository = createCollectionRepository({ filePath: work })
  const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media))
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' })
  const asset = repository.localCatalog.registerAsset({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision, relative: 'album/song.wav', sha256: null, sampleFrames: null, timebaseHz: null })
  const track = repository.localCatalog.createTrack({ commandId: randomUUID(), assetId: asset.id, segment: null })
  repository.localCatalog.observeMetadata({ commandId: randomUUID(), trackId: track.id, source: 'synthetic', parserVersion: 'album-cache-v1', fields: { title: '合成曲目', artist: 'AC/DC', album: '合成专辑' } })
  const datasetId = randomUUID()
  let admission: ReturnType<typeof createScanReadAdmission>, runtime: ReturnType<typeof createLocalAlbumOwnerRuntime>
  function connect(currentDatasetId = datasetId) {
    admission = createScanReadAdmission({ isBusy: () => false, isDisplayBusy: () => displayBusy })
    const scope = { epoch: randomUUID(), datasetId: currentDatasetId }
    const projection: DatasetProjectionPort = { async call(command, payload, read) {
      assert.equal(isDatasetProjectionPayload(command, payload), true)
      if (command === 'scanReadAcquire') {
        acquires++; const value = admission.acquire(scope, Object.hasOwn(payload, 'purpose') ? 'local-album-display' : 'scan')
        maximumPermits = Math.max(maximumPermits, admission.resourceCounts().permits); assert.ok(maximumPermits <= 2)
        return value as never
      }
      if (command === 'scanReadWatchRevocation') return admission.watchRevocation(scope, (payload as { permitId: string }).permitId) as never
      if (command === 'scanReadRelease') return admission.release(scope, (payload as { permitId: string }).permitId) as never
      if (command === 'normalizeLocalAlbumArtwork') {
        assert.ok(read && typeof read.deadlineAtMs === 'number' && Number.isFinite(read.deadlineAtMs), 'Owner原剩余期限必须透传到Main投影')
        normalizerDeadlines.push(read.deadlineAtMs)
        normalizes++; await onNormalize?.()
        const copies = (payload as { copies: dto.LocalArtworkSourceCopies }).copies
        for (const item of copies.items) {
          const input = Buffer.from(item.base64, 'base64'), size = input.equals(png16) || input.equals(jpg16) ? 16 : input.equals(png32) || input.equals(jpg32) ? 32 : 0
          if (!size) continue
          const jpeg = size === 16 ? jpg16 : jpg32
          const image: dto.LocalArtworkImage = { original: { mime: input.equals(png16) || input.equals(png32) ? 'image/png' : 'image/jpeg', bytes: input.length, sha256: sha(input), width: size, height: size }, display: { mime: 'image/jpeg', bytes: jpeg.length, sha256: sha(jpeg), width: size, height: size, dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}` } }
          assert.equal(dto.isLocalArtworkImage(image), true); return { image, status: 'ready' } as never
        }
        throw new Error('合成规范化器没有可解码的候选。')
      }
      throw new Error('本用例禁止其它投影。')
    } }
    runtime = createLocalAlbumOwnerRuntime({ repository, projection, datasetId: currentDatasetId, assertCurrent() {},
      async readRootViews() { await onRootRead?.(); return [{ root: repository.localCatalog.root(root.id), label: '合成来源', availability: await sourceRootAvailability(repository.sources.root(source.id)) }] } })
  }
  connect()
  t.after(async () => { await runtime.close(); admission.close(); repository.close(); await rm(directory, { recursive: true, force: true }) })
  return { png16, png32, jpg16, jpg32, media, register,
    get albums() { return runtime.localAlbums }, get reader() { return runtime.artwork }, get repository() { return repository },
    closeOwner: () => runtime.close(),
    metrics: () => ({ bodyReads, bodyBytes, normalizes, normalizerDeadlines: [...normalizerDeadlines], acquires, maximumPermits, permits: admission.resourceCounts().permits }),
    pauseBody() {
      let release!: () => void, enter!: () => void
      const wait = new Promise<void>(resolve => { release = resolve }), entered = new Promise<void>(resolve => { enter = resolve })
      bodyBlock = { wait, enter }; return { entered, release() { bodyBlock = undefined; release() } }
    },
    setRootRead(action: (() => Promise<void>) | undefined) { onRootRead = action },
    setNormalize(action: (() => Promise<void>) | undefined) { onNormalize = action }, setDisplayBusy(value: boolean) { displayBusy = value; admission.observe() },
    async reopen(changeDataset = false) { await runtime.close(); admission.close(); repository.close(); repository = createCollectionRepository({ filePath: work }); connect(changeDataset ? randomUUID() : datasetId) },
  }
}

test('MBF持久封面Runtime：观察晋升及重建Owner后命中同SHA，正文读取与规范化均为零且主库水位不变', async t => {
  const f = await fixture(t), first = (await f.albums.queryAlbums(query)).items[0]!, original = request(first), primary = f.repository.readonlySnapshotStamp()
  const cold = await f.albums.getArtwork(original); assert.equal(cold.image!.display.sha256, sha(f.jpg16))
  const afterCold = f.metrics(); assert.equal(afterCold.normalizes, 1); assert.ok(afterCold.bodyBytes > 0); assert.equal(afterCold.permits, 0); assert.equal(afterCold.acquires, 2, '首次put确认仍用原总两槽内短票据')
  const promoted = await f.albums.queryAlbums(query); assert.equal(promoted.items[0]!.revision, first.revision); assert.equal(promoted.counts['has-artwork'], 1)
  assert.equal((await f.albums.getArtwork(original)).image!.display.sha256, cold.image!.display.sha256)
  assert.equal(f.metrics().bodyReads, afterCold.bodyReads); assert.equal(f.metrics().bodyBytes, afterCold.bodyBytes); assert.equal(f.metrics().normalizes, 1); assert.equal(f.metrics().acquires, 3, 'cache hit只走一张原display票据')
  assert.deepEqual(f.repository.readonlySnapshotStamp(), primary)
  await f.reopen(); const reopened = (await f.albums.queryAlbums(query)).items[0]!
  assert.equal(reopened.id, first.id); assert.equal(reopened.revision, first.revision)
  assert.equal((await f.albums.getArtwork(request(reopened))).image!.display.sha256, cold.image!.display.sha256)
  assert.equal(f.metrics().bodyReads, afterCold.bodyReads); assert.equal(f.metrics().bodyBytes, afterCold.bodyBytes); assert.equal(f.metrics().normalizes, 1); assert.equal(f.metrics().permits, 0)
  await f.reopen(true); const separate = (await f.albums.queryAlbums(query)).items[0]!
  await f.albums.getArtwork(request(separate)); assert.equal(f.metrics().normalizes, 2, '不同逻辑dataset不能沿用派生cache')
})

test('MBF持久封面Runtime：独立图原地替换及更高优先坏图修复都使旧缓存失效', async t => {
  const f = await fixture(t), album = (await f.albums.queryAlbums(query)).items[0]!, original = request(album)
  await f.albums.getArtwork(original); assert.equal(f.metrics().normalizes, 1)
  await writeFile(path.join(f.media, 'album/folder.png'), f.png32)
  assert.equal((await f.albums.getArtwork(original)).image!.display.sha256, sha(f.jpg32)); assert.equal(f.metrics().normalizes, 2)
  await writeFile(path.join(f.media, 'album/cover.png'), Buffer.from('合成坏图')); await f.register('album/cover.png')
  assert.equal((await f.albums.getArtwork(original)).image!.display.sha256, sha(f.jpg32)); assert.equal(f.metrics().normalizes, 3)
  const warm = f.metrics(); await f.albums.getArtwork(original); assert.equal(f.metrics().bodyReads, warm.bodyReads); assert.equal(f.metrics().normalizes, warm.normalizes)
  await writeFile(path.join(f.media, 'album/cover.png'), f.png16)
  assert.equal((await f.albums.getArtwork(original)).image!.display.sha256, sha(f.jpg16)); assert.equal(f.metrics().normalizes, 4); assert.equal(f.metrics().permits, 0)
})

test('MBF持久封面Runtime：Main解码期间换图拒绝旧证明，验证许可不足只跳过put且不清主库', async t => {
  const f = await fixture(t), album = (await f.albums.queryAlbums(query)).items[0]!, original = request(album)
  f.setNormalize(async () => { f.setNormalize(undefined); await writeFile(path.join(f.media, 'album/folder.png'), f.png32) })
  await assert.rejects(f.albums.getArtwork(original), (error: unknown) => error instanceof Error && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'SNAPSHOT_CHANGED')
  assert.equal(f.metrics().permits, 0); assert.equal(f.metrics().normalizes, 1)
  f.setNormalize(async () => { f.setNormalize(undefined); f.setDisplayBusy(true) })
  const good = await f.albums.getArtwork(original); assert.equal(good.image!.display.sha256, sha(f.jpg32)); assert.equal(f.metrics().normalizes, 2); assert.equal(f.metrics().permits, 0)
  f.setDisplayBusy(false); await f.reopen(); const reopened = (await f.albums.queryAlbums(query)).items[0]!
  await f.albums.getArtwork(request(reopened)); assert.equal(f.metrics().normalizes, 3, '来源变更和deferred短验证都不能写入ready持久证据')
  const saved = f.metrics(); await f.albums.getArtwork(request(reopened)); assert.equal(f.metrics().normalizes, 3); assert.equal(f.metrics().bodyReads, saved.bodyReads); assert.equal(f.metrics().permits, 0)
})

// 虚拟performance时钟仅推进阶段耗时，不真实等待两秒；Date/Source内容及许可仍用正式实现。
test('MBF持久封面Runtime期限：Owner入口耗时计入首次Source和短验证，过期成功不落盘', async t => {
  const f = await fixture(t), album = (await f.albums.queryAlbums(query)).items[0]!, original = request(album)
  const started = performance.now(); let clock = started
  t.mock.method(performance, 'now', () => clock)
  f.setRootRead(async () => { f.setRootRead(undefined); clock = started + 1000 })
  f.setNormalize(async () => { f.setNormalize(undefined); clock = started + 2001 })
  const image = await f.albums.getArtwork(original)
  assert.equal(f.metrics().normalizerDeadlines[0], started + 2000, 'Main收到Owner入口期限，不能从Source阶段另起两秒')
  assert.equal(image.image!.display.sha256, sha(f.jpg16)); assert.equal(f.metrics().normalizes, 1); assert.equal(f.metrics().acquires, 1, 'Owner原期限已过，不能为落盘再开第二张票据')
  assert.equal(f.metrics().permits, 0)
  await f.reopen(); const reopened = (await f.albums.queryAlbums(query)).items[0]!
  await f.albums.getArtwork(request(reopened)); assert.equal(f.metrics().normalizes, 2, '若错误地从Source阶段重开两秒，上一请求会留下错误的持久命中')
  const saved = f.metrics(); await f.albums.getArtwork(request(reopened)); assert.equal(f.metrics().normalizes, 2); assert.equal(f.metrics().bodyReads, saved.bodyReads); assert.equal(f.metrics().permits, 0)
})


test('MBF持久封面刷新：仅新增独立cover后显式刷新重探missing，普通查询保省读且主库不变', async t => {
  const f = await fixture(t); await unlink(path.join(f.media, 'album/folder.png'))
  const album = (await f.albums.queryAlbums(query)).items[0]!, original = request(album), primary = f.repository.readonlySnapshotStamp()
  assert.equal((await f.albums.getArtwork(original)).image, null); assert.equal(f.metrics().normalizes, 0)
  const missing = (await f.albums.queryAlbums(query)).items[0]!; assert.equal(missing.artworkState, 'missing'); assert.equal(missing.revision, album.revision)
  await writeFile(path.join(f.media, 'album/cover.png'), f.png16); await f.register('album/cover.png')
  const before = f.metrics(); assert.equal((await f.albums.getArtwork(original)).image, null); assert.equal(f.metrics().bodyReads, before.bodyReads)
  assert.equal(dto.isLocalAlbumArtworkRequest({ ...original, refresh: false }), false); assert.equal(dto.isLocalAlbumArtworkRequest({ ...original, refresh: undefined }), false)
  const refreshedRequest = { ...original, refresh: true as const }; assert.equal(dto.isLocalAlbumArtworkRequest(refreshedRequest), true)
  const refreshed = await f.albums.getArtwork(refreshedRequest); assert.equal(refreshed.image!.display.sha256, sha(f.jpg16)); assert.equal(Object.hasOwn(refreshed, 'refresh'), false)
  assert.equal(dto.isLocalAlbumArtworkReply(refreshed, refreshedRequest), true); assert.equal(dto.isLocalAlbumArtworkReply({ ...refreshed, refresh: true }, refreshedRequest), false)
  const current = await f.albums.queryAlbums(query); assert.equal(current.counts['missing-artwork'], 0); assert.equal(current.counts['has-artwork'], 1)
  assert.equal(current.items[0]!.revision, album.revision); assert.deepEqual(f.repository.readonlySnapshotStamp(), primary)
})

test('MBF持久封面独立来源：内嵌容器不支持时合法独立图仍可跨Owner复用，未伪造内嵌确认', async t => {
  const f = await fixture(t, { unsupportedAudio: true }), album = (await f.albums.queryAlbums(query)).items[0]!, original = request(album)
  const cold = await f.albums.getArtwork(original); assert.equal(cold.image!.display.sha256, sha(f.jpg16)); assert.equal(f.metrics().normalizes, 1)
  const before = f.metrics(); assert.ok(before.bodyReads > 0); assert.equal(before.acquires, 2); assert.equal(before.permits, 0)
  await f.reopen(); const reopened = (await f.albums.queryAlbums(query)).items[0]!
  assert.equal((await f.albums.getArtwork(request(reopened))).image!.display.sha256, cold.image!.display.sha256)
  assert.equal(f.metrics().normalizes, 1); assert.equal(f.metrics().bodyReads, before.bodyReads); assert.equal(f.metrics().bodyBytes, before.bodyBytes); assert.equal(f.metrics().permits, 0)
})

test('MBF持久封面可选容量：原Reader四项在途占满时跳过落盘确认，好图回复不被缓存容量改错', async t => {
  const f = await fixture(t), album = (await f.albums.queryAlbums(query)).items[0]!, original = request(album)
  const detail = f.repository.localCatalog.trackDetail(album.representativeTrackId!), locator = f.repository.localCatalog.privateAssetLocator(detail.asset.id)
  const target = { request: original, context: { album, directory: path.posix.dirname(locator.relative), representative: { relative: locator.relative, summary: { track: detail.track, asset: detail.asset, metadata: detail.metadata.effective, versionTokens: detail.versionTokens }, rawMetadata: detail.metadata.raw, hasArtwork: false, artworkRevision: null } } }
  const tasks: Promise<unknown>[] = []; let release = () => {}
  t.after(async () => { release(); await Promise.allSettled(tasks) })
  f.setNormalize(async () => {
    f.setNormalize(undefined); const gate = f.pauseBody(); release = gate.release
    for (let index = 0; index < 4; index++) { const job = f.reader.readSources(target, randomUUID(), undefined, undefined, 'display'); tasks.push(job); void job.catch(() => {}) }
    await gate.entered
  })
  try {
    const good = await f.albums.getArtwork(original); assert.equal(good.image!.display.sha256, sha(f.jpg16)); assert.equal(f.metrics().normalizes, 1)
    assert.ok(f.metrics().maximumPermits <= 2); release(); const results = await Promise.allSettled(tasks); assert.ok(results.every(result => result.status === 'fulfilled')); assert.equal(f.metrics().permits, 0)
  } finally { release(); await Promise.allSettled(tasks) }
  await f.reopen(); const reopened = (await f.albums.queryAlbums(query)).items[0]!; await f.albums.getArtwork(request(reopened))
  assert.equal(f.metrics().normalizes, 2, '可选本地容量不足不得发布持久成功记录')
})


test('MBF持久封面关闭：Main规范化await期间Owner关闭后旧回复不能落盘，重建仍需冷读取', async t => {
  const f = await fixture(t), album = (await f.albums.queryAlbums(query)).items[0]!, original = request(album)
  f.setNormalize(async () => { f.setNormalize(undefined); await f.closeOwner() })
  await assert.rejects(f.albums.getArtwork(original), (error: unknown) => error instanceof Error && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'SNAPSHOT_CHANGED')
  assert.equal(f.metrics().normalizes, 1); assert.equal(f.metrics().permits, 0)
  await f.reopen(); const reopened = (await f.albums.queryAlbums(query)).items[0]!; await f.albums.getArtwork(request(reopened))
  assert.equal(f.metrics().normalizes, 2, 'Owner关闭后不能发布旧请求的持久成功图')
  const before = f.metrics(); await f.albums.getArtwork(request(reopened)); assert.equal(f.metrics().normalizes, 2); assert.equal(f.metrics().bodyReads, before.bodyReads)
})


// 本组只验证计数事实连续性；原真实Owner/SQL/Source夹具及既有八例保持不变。
test('MBF封面计数：冷读后不查询即重建，513条事实穿真实Owner与SQL仍正确计数筛选', async t => {
  const f = await fixture(t), observations = f.repository.privateLocalAlbumArtworkObservations
  assert.ok(observations)
  const scopes: Array<{ datasetId: string; sourceRevision: string }> = [], originalRead = observations.read.bind(observations)
  const observedRead = t.mock.method(observations, 'read', (datasetId: string, sourceRevision: string) => {
    scopes.push({ datasetId, sourceRevision }); return originalRead(datasetId, sourceRevision)
  })
  let initial: dto.LocalAlbumPage
  try { initial = await f.albums.queryAlbums(query) } finally { observedRead.mock.restore() }
  const scope = scopes.at(-1); assert.ok(scope); assert.equal(f.albums.getCacheInfo().revision, scope.sourceRevision)
  const album = initial.items[0]!, original = request(album)
  assert.equal(initial.counts['has-artwork'], 0); assert.equal(initial.counts['missing-artwork'], 0)
  const primary = f.repository.readonlySnapshotStamp(), cold = await f.albums.getArtwork(original)
  assert.equal(cold.status, 'ready'); assert.equal(cold.image!.display.sha256, sha(f.jpg16))
  // 成功后完全不经Owner query，原观察就必须已持久；其余512项无真实专辑，不能增加SQL计数。
  const confirmed = observations.read(scope.datasetId, scope.sourceRevision)
  assert.equal(confirmed.length, 1); assert.equal(confirmed[0]!.albumKey, album.id); assert.equal(confirmed[0]!.state, 'available')
  for (let index = 0; index < 512; index++) assert.equal(observations.put(scope.datasetId, {
    albumKey: `0.synthetic-unmatched-count-${index}`, rootId: album.rootId, sourceRevision: scope.sourceRevision, state: 'available', revision: sha(Buffer.from(`synthetic-count-${index}`)),
  }), true)
  assert.equal(observations.read(scope.datasetId, scope.sourceRevision).length, 513)
  const beforeReopen = f.metrics(); assert.ok(beforeReopen.bodyReads > 0); assert.equal(beforeReopen.normalizes, 1); assert.equal(beforeReopen.permits, 0)
  assert.deepEqual(f.repository.readonlySnapshotStamp(), primary)
  await f.reopen()
  const primaryB = f.repository.readonlySnapshotStamp()
  const promoted = await f.albums.queryAlbums(query), present = await f.albums.queryAlbums({ ...query, filter: 'has-artwork' })
  assert.equal(promoted.counts['has-artwork'], 1, '513条私有事实必须穿真实Owner/SQL，不能塞入旧512数组或数入未匹配键。')
  assert.equal(promoted.counts['missing-artwork'], 0); assert.equal(promoted.items[0]!.artworkState, 'available')
  assert.equal(present.total, 1); assert.deepEqual(present.items.map(item => item.id), [album.id])
  assert.equal(f.repository.privateLocalAlbumArtworkObservations!.read(scope.datasetId, scope.sourceRevision).length, 513)
  assert.deepEqual(f.metrics(), beforeReopen, '冷读成功后首次重建查询不能以再次读图补计数。')
  assert.deepEqual(f.repository.readonlySnapshotStamp(), primaryB)
  await f.reopen()
  const primaryC = f.repository.readonlySnapshotStamp()
  const restored = await f.albums.queryAlbums(query), filtered = await f.albums.queryAlbums({ ...query, filter: 'has-artwork' })
  assert.equal(restored.counts['has-artwork'], 1); assert.equal(restored.items[0]!.revision, album.revision)
  assert.equal(filtered.total, 1); assert.deepEqual(filtered.items.map(item => item.id), [album.id])
  assert.equal((await f.albums.queryAlbums({ ...query, filter: 'missing-artwork' })).total, 0)
  assert.deepEqual(f.metrics(), beforeReopen); assert.deepEqual(f.repository.readonlySnapshotStamp(), primaryC)
})

test('MBF封面计数：旧display缓存命中走真实晋升，下一次重建前不读图也保留计数', async t => {
  const f = await fixture(t), album = (await f.albums.queryAlbums(query)).items[0]!, observations = f.repository.privateLocalAlbumArtworkObservations
  assert.ok(observations)
  // 只模拟旧版本没有新观察记录；真实冷读与display副库写入仍走原生产链。
  const noObservation = t.mock.method(observations, 'put', () => false)
  let expectedSha: string
  try {
    const cold = await f.albums.getArtwork(request(album)); assert.equal(cold.status, 'ready'); assert.ok(cold.image)
    expectedSha = cold.image.display.sha256
  } finally { noObservation.mock.restore() }
  await f.reopen()
  const oldCacheOnly = await f.albums.queryAlbums(query)
  assert.equal(oldCacheOnly.counts['has-artwork'], 0, '旧display副库本身不能伪造未签发的观察。')
  const beforeHit = f.metrics(), hit = await f.albums.getArtwork(request(oldCacheOnly.items[0]!))
  assert.equal(hit.status, 'ready'); assert.equal(hit.image!.display.sha256, expectedSha)
  const afterHit = f.metrics()
  assert.equal(afterHit.bodyReads, beforeHit.bodyReads); assert.equal(afterHit.bodyBytes, beforeHit.bodyBytes)
  assert.equal(afterHit.normalizes, beforeHit.normalizes); assert.equal(afterHit.acquires, beforeHit.acquires + 1)
  assert.equal(afterHit.permits, 0)
  const promoted = await f.albums.queryAlbums({ ...query, filter: 'has-artwork' })
  assert.equal(promoted.counts['has-artwork'], 1); assert.equal(promoted.total, 1); assert.equal(promoted.items[0]!.id, album.id)
  await f.reopen()
  const restored = await f.albums.queryAlbums({ ...query, filter: 'has-artwork' })
  assert.equal(restored.counts['has-artwork'], 1); assert.equal(restored.total, 1); assert.equal(restored.items[0]!.id, album.id)
  assert.deepEqual(f.metrics(), afterHit, '真实hit晋升后，重建计数无需第二次读图。')
})

test('MBF封面计数：忙碌和规范化拒绝不记missing，真实无图及显式修复跨Owner保留', async t => {
  const f = await fixture(t), album = (await f.albums.queryAlbums(query)).items[0]!, original = request(album)
  f.setDisplayBusy(true)
  try { const busy = await f.albums.getArtwork(original); assert.equal(busy.status, 'source-unavailable'); assert.equal(busy.image, null) }
  finally { f.setDisplayBusy(false) }
  f.setNormalize(async () => { throw new Error('合成规范化拒绝。') })
  try { await assert.rejects(f.albums.getArtwork(original), (error: unknown) => error instanceof Error && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'UNAVAILABLE') }
  finally { f.setNormalize(undefined) }
  const unconfirmed = await f.albums.queryAlbums(query)
  assert.equal(unconfirmed.counts['has-artwork'], 0); assert.equal(unconfirmed.counts['missing-artwork'], 0); assert.equal(unconfirmed.items[0]!.artworkState, 'unknown')
  const beforeReopen = f.metrics(); assert.equal(beforeReopen.permits, 0)
  await f.reopen()
  const stillUnknown = await f.albums.queryAlbums(query)
  assert.equal(stillUnknown.counts['has-artwork'], 0); assert.equal(stillUnknown.counts['missing-artwork'], 0)
  assert.equal(stillUnknown.items[0]!.artworkState, 'unknown'); assert.deepEqual(f.metrics(), beforeReopen)
  await unlink(path.join(f.media, 'album/folder.png'))
  const absent = await f.albums.getArtwork(request(stillUnknown.items[0]!)); assert.equal(absent.status, 'ready'); assert.equal(absent.image, null)
  const missing = await f.albums.queryAlbums({ ...query, filter: 'missing-artwork' })
  assert.equal(missing.total, 1); assert.equal(missing.counts['missing-artwork'], 1); assert.equal(missing.items[0]!.id, album.id)
  const afterMissing = f.metrics(); await f.reopen()
  const restoredMissing = await f.albums.queryAlbums({ ...query, filter: 'missing-artwork' })
  assert.equal(restoredMissing.total, 1); assert.equal(restoredMissing.counts['missing-artwork'], 1)
  assert.equal(restoredMissing.items[0]!.artworkState, 'missing'); assert.deepEqual(f.metrics(), afterMissing)
  await writeFile(path.join(f.media, 'album/cover.png'), f.png16); await f.register('album/cover.png')
  const repaired = await f.albums.getArtwork({ ...request(restoredMissing.items[0]!), refresh: true })
  assert.equal(repaired.image!.display.sha256, sha(f.jpg16))
  const afterRepair = f.metrics(); await f.reopen()
  const restoredRepair = await f.albums.queryAlbums({ ...query, filter: 'has-artwork' })
  assert.equal(restoredRepair.total, 1); assert.equal(restoredRepair.counts['missing-artwork'], 0)
  assert.equal(restoredRepair.items[0]!.artworkState, 'available'); assert.deepEqual(f.metrics(), afterRepair)
  f.setDisplayBusy(true)
  try {
    const busyRefresh = await f.albums.getArtwork({ ...request(restoredRepair.items[0]!), refresh: true })
    assert.equal(busyRefresh.status, 'source-unavailable'); assert.equal(busyRefresh.image, null)
  } finally { f.setDisplayBusy(false) }
  const knownAfterBusy = await f.albums.queryAlbums(query)
  assert.equal(knownAfterBusy.counts['has-artwork'], 1); assert.equal(knownAfterBusy.counts['missing-artwork'], 0)
  assert.equal(knownAfterBusy.items[0]!.artworkState, 'available')
  const afterBusyRefresh = f.metrics(); await f.reopen()
  const restoredAfterBusy = await f.albums.queryAlbums(query)
  assert.equal(restoredAfterBusy.counts['has-artwork'], 1); assert.equal(restoredAfterBusy.counts['missing-artwork'], 0)
  assert.equal(restoredAfterBusy.items[0]!.artworkState, 'available'); assert.deepEqual(f.metrics(), afterBusyRefresh)
  // 换成另一份自有PNG令旧display证据miss，确保下面真实进入规范化拒绝分支。
  await writeFile(path.join(f.media, 'album/cover.png'), f.png32); await f.register('album/cover.png')
  const beforeRejectedRefresh = f.metrics()
  f.setNormalize(async () => { throw new Error('已有available后的合成刷新拒绝。') })
  try {
    await assert.rejects(f.albums.getArtwork({ ...request(restoredAfterBusy.items[0]!), refresh: true }),
      (error: unknown) => error instanceof Error && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'UNAVAILABLE')
  } finally { f.setNormalize(undefined) }
  assert.equal(f.metrics().normalizes, beforeRejectedRefresh.normalizes + 1)
  const knownAfterReject = await f.albums.queryAlbums(query)
  assert.equal(knownAfterReject.counts['has-artwork'], 1); assert.equal(knownAfterReject.counts['missing-artwork'], 0)
  assert.equal(knownAfterReject.items[0]!.artworkState, 'available')
  const afterRejectedRefresh = f.metrics(); await f.reopen()
  const restoredAfterReject = await f.albums.queryAlbums({ ...query, filter: 'has-artwork' })
  assert.equal(restoredAfterReject.total, 1); assert.equal(restoredAfterReject.counts['has-artwork'], 1)
  assert.equal(restoredAfterReject.counts['missing-artwork'], 0); assert.equal(restoredAfterReject.items[0]!.artworkState, 'available')
  assert.deepEqual(f.metrics(), afterRejectedRefresh)
})

test('MBF封面计数：来源修订及工作库切换不复用旧观察，原来源撤权后不保留available', async t => {
  const f = await fixture(t), album = (await f.albums.queryAlbums(query)).items[0]!
  await f.albums.getArtwork(request(album)); assert.equal((await f.albums.queryAlbums(query)).counts['has-artwork'], 1)
  const beforeInvalidate = f.metrics(), primary = f.repository.readonlySnapshotStamp(), revision = f.albums.getCacheInfo().revision
  f.albums.invalidate()
  const invalidated = await f.albums.queryAlbums(query)
  assert.equal(f.albums.getCacheInfo().revision, revision); assert.equal(invalidated.items[0]!.revision, album.revision)
  assert.deepEqual(f.repository.readonlySnapshotStamp(), primary, '显式失效时原catalog/scan水位尚未推进。')
  assert.equal(invalidated.counts['has-artwork'], 0); assert.equal(invalidated.counts['missing-artwork'], 0); assert.equal(invalidated.items[0]!.artworkState, 'unknown')
  await f.reopen()
  const notResurrected = await f.albums.queryAlbums(query)
  assert.equal(notResurrected.counts['has-artwork'], 0); assert.equal(notResurrected.items[0]!.artworkState, 'unknown')
  assert.equal(f.albums.getCacheInfo().revision, revision); assert.deepEqual(f.metrics(), beforeInvalidate)
  await f.albums.getArtwork(request(notResurrected.items[0]!)); assert.equal((await f.albums.queryAlbums(query)).counts['has-artwork'], 1)
  f.repository.localCatalog.observeMetadata({ commandId: randomUUID(), trackId: album.representativeTrackId!, source: 'synthetic', parserVersion: 'album-cache-v2', fields: { title: '合成曲目修订', artist: 'AC/DC', album: '合成专辑' } })
  const changed = await f.albums.queryAlbums(query)
  assert.notEqual(changed.items[0]!.revision, album.revision); assert.equal(changed.counts['has-artwork'], 0)
  assert.equal(changed.counts['missing-artwork'], 0); assert.equal(changed.items[0]!.artworkState, 'unknown')
  await f.albums.getArtwork(request(changed.items[0]!)); assert.equal((await f.albums.queryAlbums(query)).counts['has-artwork'], 1)
  const beforeDatasetChange = f.metrics(); await f.reopen(true)
  const separate = await f.albums.queryAlbums(query)
  assert.equal(separate.counts['has-artwork'], 0); assert.equal(separate.counts['missing-artwork'], 0)
  assert.equal(separate.items[0]!.artworkState, 'unknown'); assert.deepEqual(f.metrics(), beforeDatasetChange)
  await f.albums.getArtwork(request(separate.items[0]!)); assert.equal((await f.albums.queryAlbums(query)).counts['has-artwork'], 1)
  const root = f.repository.localCatalog.root(album.rootId)
  f.repository.sources.revoke({ commandId: randomUUID(), id: root.sourceRootId })
  const revoked = await f.albums.queryAlbums(query)
  assert.equal(revoked.counts['has-artwork'], 0); assert.equal(revoked.counts['missing-artwork'], 0)
  assert.equal(revoked.items[0]!.artworkState, 'source-unavailable')
  const beforeRevokedReopen = f.metrics(); await f.reopen()
  const restored = await f.albums.queryAlbums(query)
  assert.equal(restored.counts['has-artwork'], 0); assert.equal(restored.items[0]!.artworkState, 'source-unavailable')
  assert.deepEqual(f.metrics(), beforeRevokedReopen)
})


test('MBF封面计数：原期限后的迟到ready不持久，同Owner后续有效同值读取仍可补持久', async t => {
  const f = await fixture(t), initial = await f.albums.queryAlbums(query), album = initial.items[0]!, primary = f.repository.readonlySnapshotStamp()
  assert.equal(initial.counts['has-artwork'], 0)
  let clock = performance.now()
  const virtualClock = t.mock.method(performance, 'now', () => clock)
  try {
    const startedA = clock
    f.setRootRead(async () => { f.setRootRead(undefined); clock = startedA + 1000 })
    f.setNormalize(async () => { f.setNormalize(undefined); clock = startedA + 2001 })
    const lateA = await f.albums.getArtwork(request(album))
    assert.equal(lateA.status, 'ready'); assert.equal(lateA.image!.display.sha256, sha(f.jpg16))
    assert.equal(f.metrics().normalizerDeadlines.at(-1), startedA + 2000)
    assert.equal(f.metrics().acquires, 1); assert.equal(f.metrics().permits, 0)
    assert.equal(f.albums.getCacheInfo().observationCount, 1, '迟到ready仍保当前Owner的观察，不能改原公开成功合同。')
    const afterLateA = f.metrics()
    assert.deepEqual(f.repository.readonlySnapshotStamp(), primary)
    // Owner A迟到后不query即关闭；Owner B首次查询只能读持久事实，不能靠图像补计数。
    await f.reopen()
    const primaryB = f.repository.readonlySnapshotStamp()
    const firstB = await f.albums.queryAlbums(query)
    assert.equal(firstB.counts['has-artwork'], 0); assert.equal(firstB.counts['missing-artwork'], 0)
    assert.equal(firstB.items[0]!.artworkState, 'unknown')
    assert.equal((await f.albums.queryAlbums({ ...query, filter: 'has-artwork' })).total, 0)
    assert.deepEqual(f.metrics(), afterLateA); assert.deepEqual(f.repository.readonlySnapshotStamp(), primaryB)
    // 在同一Owner B内再留下迟到RAM事实，随后有效同图必须补写，不能因equal跳过put。
    const startedB = clock
    f.setRootRead(async () => { f.setRootRead(undefined); clock = startedB + 1000 })
    f.setNormalize(async () => { f.setNormalize(undefined); clock = startedB + 2001 })
    const lateB = await f.albums.getArtwork(request(firstB.items[0]!))
    assert.equal(lateB.status, 'ready'); assert.equal(lateB.image!.display.sha256, lateA.image!.display.sha256)
    assert.equal(f.metrics().normalizerDeadlines.at(-1), startedB + 2000)
    assert.equal((await f.albums.queryAlbums(query)).counts['has-artwork'], 1)
    const onTimeB = await f.albums.getArtwork(request(firstB.items[0]!))
    assert.equal(onTimeB.status, 'ready'); assert.equal(onTimeB.image!.display.sha256, lateB.image!.display.sha256)
    assert.equal(f.metrics().permits, 0)
    const afterOnTimeB = f.metrics(); assert.deepEqual(f.repository.readonlySnapshotStamp(), primaryB)
    await f.reopen()
    const primaryC = f.repository.readonlySnapshotStamp()
    const firstC = await f.albums.queryAlbums({ ...query, filter: 'has-artwork' })
    assert.equal(firstC.total, 1); assert.equal(firstC.counts['has-artwork'], 1); assert.equal(firstC.items[0]!.id, album.id)
    assert.deepEqual(f.metrics(), afterOnTimeB); assert.deepEqual(f.repository.readonlySnapshotStamp(), primaryC)
  } finally { f.setRootRead(undefined); f.setNormalize(undefined); virtualClock.mock.restore() }
})
