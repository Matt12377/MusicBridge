import assert from 'node:assert/strict'
import test, { after } from 'node:test'
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
import { closeRustMediaWorkerPool, getRustMediaWorkerPool } from '../src/library/rust-media-worker.js'
import { LocalAlbumArtworkResourceError } from '../src/collection/local-album-browser/artwork-resource-store.js'

// 合成媒体穿真实Owner/SQLite/Source/许可/Rust规范化；不连接用户音乐库。
after(() => closeRustMediaWorkerPool())
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
function assertImage(image: dto.LocalArtworkImage | null, original: Buffer, size: number): asserts image is dto.LocalArtworkImage {
  assert.ok(image); assert.equal(dto.isLocalArtworkImage(image), true)
  assert.equal(image.original.sha256, sha(original)); assert.equal(image.original.bytes, original.length)
  assert.equal(image.original.width, size); assert.equal(image.original.height, size)
  assert.equal(image.display.width, size); assert.equal(image.display.height, size)
  assert.equal(image.display.sha256, sha(Buffer.from(image.display.dataUrl.slice('data:image/jpeg;base64,'.length), 'base64')))
}
const query = { query: '', rootId: null, filter: 'all' as const, offset: 0, limit: 60 }
const request = (album: dto.LocalAlbumSummary): dto.LocalAlbumArtworkRequest => ({ albumKey: album.id, rootId: album.rootId, editionId: album.editionId, representativeTrackId: album.representativeTrackId, revision: album.revision })
async function fixture(t: test.TestContext, options: { unsupportedAudio?: boolean } = {}) {
  const temporary = process.env.TMPDIR
  if (!temporary?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/')) throw new Error('合成资料须用外置临时目录。')
  const directory = await mkdtemp(path.join(temporary, 'mbf-album-cache-runtime-')), media = path.join(directory, 'media'), work = path.join(directory, 'work.sqlite')
  await mkdir(path.join(media, 'album'), { recursive: true })
  const audio = options.unsupportedAudio ? Buffer.from('unsupported-synthetic-container') : await readFile(new URL('./fixtures/mbrs003/audio/fixtures/core-wav.wav', import.meta.url))
  const png16 = await readFile(new URL('./fixtures/mbrs012-source/owned-cover-16.png', import.meta.url))
  const png32 = await readFile(new URL('./fixtures/mbrs012-source/owned-cover-32.png', import.meta.url))
  await writeFile(path.join(media, 'album/song.wav'), audio); await writeFile(path.join(media, 'album/folder.png'), png16)
  const identities = new Set<string>()
  const register = async (relative: string) => { const info = await stat(path.join(media, relative)); identities.add(`${info.dev}:${info.ino}`) }
  await register('album/song.wav'); await register('album/folder.png')
  const probe = await open(path.join(media, 'album/song.wav'), 'r'), prototype = Object.getPrototypeOf(probe), originalRead = prototype.read; await probe.close()
  let bodyReads = 0, bodyBytes = 0, normalizes = 0, acquires = 0, maximumPermits = 0, displayBusy = false
  const normalizerStarts: number[] = []
  let bodyBlock: { wait: Promise<void>; enter(): void } | undefined
  let onNormalize: (() => Promise<void>) | undefined, onRootRead: (() => Promise<void>) | undefined
  const pool = getRustMediaWorkerPool(), processImage = pool.processImage.bind(pool)
  t.mock.method(pool, 'processImage', async (...args: Parameters<typeof pool.processImage>) => {
    normalizes++; normalizerStarts.push(performance.now()); await onNormalize?.()
    return processImage(...args)
  })
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
    const projection: DatasetProjectionPort = { async call(command, payload) {
      assert.equal(isDatasetProjectionPayload(command, payload), true)
      if (command === 'scanReadStatus') return admission.status(scope) as never
      if (command === 'scanReadAcquire') {
        acquires++; const value = admission.acquire(scope, Object.hasOwn(payload, 'purpose') ? 'local-album-display' : 'scan')
        maximumPermits = Math.max(maximumPermits, admission.resourceCounts().permits); assert.ok(maximumPermits <= 2)
        return value as never
      }
      if (command === 'scanReadWatchRevocation') return admission.watchRevocation(scope, (payload as { permitId: string }).permitId) as never
      if (command === 'scanReadRelease') return admission.release(scope, (payload as { permitId: string }).permitId) as never
      if (command === 'normalizeLocalAlbumArtwork') throw new Error('正式Rust路径不应回退Main规范化。')
      throw new Error('本用例禁止其它投影。')
    } }
    runtime = createLocalAlbumOwnerRuntime({ repository, projection, datasetId: currentDatasetId, assertCurrent() {},
      async readRootViews() { await onRootRead?.(); return [{ root: repository.localCatalog.root(root.id), label: '合成来源', availability: await sourceRootAvailability(repository.sources.root(source.id)) }] } })
  }
  connect()
  t.after(async () => { await runtime.close(); admission.close(); repository.close(); await rm(directory, { recursive: true, force: true }) })
  return { png16, png32, media, register, datasetId,
    get albums() { return runtime.localAlbums }, get reader() { return runtime.artwork }, get repository() { return repository },
    get background() { return runtime.background },
    closeOwner: () => runtime.close(),
    metrics: () => ({ bodyReads, bodyBytes, normalizes, normalizerStarts: [...normalizerStarts], acquires, maximumPermits, permits: admission.resourceCounts().permits }),
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
  const cold = await f.albums.getArtwork(original); assertImage(cold.image, f.png16, 16)
  const afterCold = f.metrics(); assert.equal(afterCold.normalizes, 1); assert.ok(afterCold.bodyBytes > 0); assert.equal(afterCold.permits, 0); assert.equal(afterCold.acquires, 1, '同一次Source许可覆盖读取、规范化与持久资源发布')
  const promoted = await f.albums.queryAlbums(query); assert.equal(promoted.items[0]!.revision, first.revision); assert.equal(promoted.counts['has-artwork'], 1)
  assert.equal((await f.albums.getArtwork(original)).image!.display.sha256, cold.image!.display.sha256)
  assert.equal(f.metrics().bodyReads, afterCold.bodyReads); assert.equal(f.metrics().bodyBytes, afterCold.bodyBytes); assert.equal(f.metrics().normalizes, 1); assert.equal(f.metrics().acquires, afterCold.acquires, '持久资源命中不重新申请源读许可')
  assert.deepEqual(f.repository.readonlySnapshotStamp(), primary)
  await f.reopen(); const reopened = (await f.albums.queryAlbums(query)).items[0]!
  assert.equal(reopened.id, first.id); assert.equal(reopened.revision, first.revision)
  assert.equal((await f.albums.getArtwork(request(reopened))).image!.display.sha256, cold.image!.display.sha256)
  assert.equal(f.metrics().bodyReads, afterCold.bodyReads); assert.equal(f.metrics().bodyBytes, afterCold.bodyBytes); assert.equal(f.metrics().normalizes, 1); assert.equal(f.metrics().permits, 0)
  await f.reopen(true); const separate = (await f.albums.queryAlbums(query)).items[0]!
  await f.albums.getArtwork(request(separate)); assert.equal(f.metrics().normalizes, 2, '不同逻辑dataset不能沿用派生cache')
})

test('MBF持久封面Runtime：普通浏览复用持久图，显式刷新才探测原地替换与高优先图修复', async t => {
  const f = await fixture(t), album = (await f.albums.queryAlbums(query)).items[0]!, original = request(album)
  await f.albums.getArtwork(original); assert.equal(f.metrics().normalizes, 1)
  await writeFile(path.join(f.media, 'album/folder.png'), f.png32)
  const beforeRefresh = f.metrics(); assertImage((await f.albums.getArtwork(original)).image, f.png16, 16)
  assert.deepEqual(f.metrics(), beforeRefresh, '普通读不因源文件变化重复抽图')
  assertImage((await f.albums.getArtwork({ ...original, refresh: true })).image, f.png32, 32); assert.equal(f.metrics().normalizes, 2)
  await writeFile(path.join(f.media, 'album/cover.png'), Buffer.from('合成坏图')); await f.register('album/cover.png')
  assertImage((await f.albums.getArtwork({ ...original, refresh: true })).image, f.png32, 32)
  assert.equal(f.metrics().normalizes, 3, '高优先坏图可回退已完整解码的合法folder图，不得选中坏图')
  const warm = f.metrics(); await f.albums.getArtwork(original); assert.equal(f.metrics().bodyReads, warm.bodyReads); assert.equal(f.metrics().normalizes, warm.normalizes)
  await writeFile(path.join(f.media, 'album/cover.png'), f.png16)
  assertImage((await f.albums.getArtwork({ ...original, refresh: true })).image, f.png16, 16); assert.equal(f.metrics().normalizes, 4); assert.equal(f.metrics().permits, 0)
})

test('MBF持久封面Runtime：Rust规范化期间来源换图及许可撤销均拒绝，恢复后才持久复用', async t => {
  const f = await fixture(t), album = (await f.albums.queryAlbums(query)).items[0]!, original = request(album)
  f.setNormalize(async () => { f.setNormalize(undefined); await writeFile(path.join(f.media, 'album/folder.png'), f.png32) })
  await assert.rejects(f.albums.getArtwork(original), { code: 'UNAVAILABLE' })
  assert.equal(f.metrics().permits, 0); assert.equal(f.metrics().normalizes, 1)
  f.setNormalize(async () => { f.setNormalize(undefined); f.setDisplayBusy(true) })
  await assert.rejects(f.albums.getArtwork(original), { code: 'UNAVAILABLE' })
  assert.equal(f.metrics().normalizes, 2); assert.equal(f.metrics().permits, 0)
  const rejected = await f.albums.queryAlbums(query)
  assert.equal(rejected.counts['has-artwork'], 0); assert.equal(rejected.counts['missing-artwork'], 0); assert.equal(rejected.items[0]!.artworkState, 'unknown')
  f.setDisplayBusy(false)
  const good = await f.albums.getArtwork(original); assertImage(good.image, f.png32, 32); assert.equal(f.metrics().normalizes, 3); assert.equal(f.metrics().permits, 0)
  const saved = f.metrics(); await f.reopen(); const reopened = (await f.albums.queryAlbums(query)).items[0]!
  assertImage((await f.albums.getArtwork(request(reopened))).image, f.png32, 32)
  assert.deepEqual(f.metrics(), saved, '已撤销请求不留下持久成功；恢复后的有效结果才可跨Owner零读取复用')
})

// 虚拟performance时钟仅推进阶段耗时，不真实等待两秒；Date/Source内容及许可仍用正式实现。
test('MBF持久封面Runtime期限：Owner入口耗时计入Source与Rust规范化，过期成功不落盘', async t => {
  const f = await fixture(t), album = (await f.albums.queryAlbums(query)).items[0]!, original = request(album)
  const started = performance.now(); let clock = started
  t.mock.method(performance, 'now', () => clock)
  f.setRootRead(async () => { f.setRootRead(undefined); clock = started + 1000 })
  f.setNormalize(async () => { f.setNormalize(undefined); clock = started + 2001 })
  await assert.rejects(f.albums.getArtwork(original), { code: 'UNAVAILABLE' })
  assert.equal(f.metrics().normalizerStarts[0], started + 1000, '进入Rust前仍沿用Owner入口已消耗的读取时钟')
  assert.equal(f.metrics().normalizes, 1); assert.equal(f.metrics().acquires, 1, 'Owner原期限已过不得发布或另开第二张票据')
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
  const refreshed = await f.albums.getArtwork(refreshedRequest); assertImage(refreshed.image, f.png16, 16); assert.equal(Object.hasOwn(refreshed, 'refresh'), false)
  assert.equal(dto.isLocalAlbumArtworkReply(refreshed, refreshedRequest), true); assert.equal(dto.isLocalAlbumArtworkReply({ ...refreshed, refresh: true }, refreshedRequest), false)
  const current = await f.albums.queryAlbums(query); assert.equal(current.counts['missing-artwork'], 0); assert.equal(current.counts['has-artwork'], 1)
  assert.equal(current.items[0]!.revision, album.revision); assert.deepEqual(f.repository.readonlySnapshotStamp(), primary)
})

test('MBF持久封面独立来源：内嵌容器不支持时合法独立图仍可跨Owner复用，未伪造内嵌确认', async t => {
  const f = await fixture(t, { unsupportedAudio: true }), album = (await f.albums.queryAlbums(query)).items[0]!, original = request(album)
  const cold = await f.albums.getArtwork(original); assertImage(cold.image, f.png16, 16); assert.equal(f.metrics().normalizes, 1)
  const before = f.metrics(); assert.ok(before.bodyReads > 0); assert.equal(before.acquires, 1); assert.equal(before.permits, 0)
  await f.reopen(); const reopened = (await f.albums.queryAlbums(query)).items[0]!
  assert.equal((await f.albums.getArtwork(request(reopened))).image!.display.sha256, cold.image!.display.sha256)
  assert.equal(f.metrics().normalizes, 1); assert.equal(f.metrics().bodyReads, before.bodyReads); assert.equal(f.metrics().bodyBytes, before.bodyBytes); assert.equal(f.metrics().permits, 0)
})

test('MBF持久封面容量：资源存储容量不足拒绝而不确认缺图，恢复后真实重读并可跨Owner复用', async t => {
  const f = await fixture(t), album = (await f.albums.queryAlbums(query)).items[0]!, original = request(album)
  const store = f.repository.privateLocalAlbumArtworkResources!, primary = f.repository.readonlySnapshotStamp()
  const full = t.mock.method(store, 'put', () => { throw new LocalAlbumArtworkResourceError('ARTWORK_STORE_FULL') })
  try {
    await assert.rejects(f.albums.getArtwork(original), { code: 'UNAVAILABLE' })
    assert.equal(f.metrics().normalizes, 1); assert.ok(f.metrics().bodyBytes > 0)
    assert.ok(f.metrics().maximumPermits <= 2); assert.equal(f.metrics().permits, 0)
    const failed = await f.albums.queryAlbums(query)
    assert.equal(failed.counts['has-artwork'], 0); assert.equal(failed.counts['missing-artwork'], 0)
    assert.equal(failed.items[0]!.artworkState, 'unknown'); assert.deepEqual(f.repository.readonlySnapshotStamp(), primary)
  } finally { full.mock.restore() }
  assertImage((await f.albums.getArtwork(original)).image, f.png16, 16)
  assert.equal(f.metrics().normalizes, 2)
  // 原四项在途保护继续走真实读取；所有明确刷新共用两条许可，不再依赖已删除的四项显示证明缓存。
  const blocked = f.pauseBody(), concurrent = Array.from({ length: 4 }, () => f.albums.getArtwork({ ...original, refresh: true }))
  let entered = false; void blocked.entered.then(() => { entered = true })
  for (const work of concurrent) void work.catch(() => {})
  try {
    for (let attempt = 0; attempt < 100 && (!entered || f.metrics().maximumPermits < 2); attempt++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(entered, true); assert.equal(f.metrics().maximumPermits, 2)
    blocked.release()
    for (const result of await Promise.all(concurrent)) assertImage(result.image, f.png16, 16)
    assert.equal(f.metrics().normalizes, 6); assert.equal(f.metrics().permits, 0)
  } finally { blocked.release(); await Promise.allSettled(concurrent) }
  const repaired = f.metrics(); await f.reopen()
  const reopened = (await f.albums.queryAlbums(query)).items[0]!
  assertImage((await f.albums.getArtwork(request(reopened))).image, f.png16, 16)
  assert.deepEqual(f.metrics(), repaired, '失败不得伪造成功；恢复后才取得可跨Owner复用的持久图')
})


test('MBF持久封面关闭：Rust规范化await期间Owner关闭后旧回复不能落盘，重建仍需冷读取', async t => {
  const f = await fixture(t), album = (await f.albums.queryAlbums(query)).items[0]!, original = request(album)
  let closing: Promise<void> | undefined
  f.setNormalize(async () => { f.setNormalize(undefined); closing = f.closeOwner() })
  await assert.rejects(f.albums.getArtwork(original), { code: 'UNAVAILABLE' })
  await closing
  assert.equal(f.metrics().normalizes, 1); assert.equal(f.metrics().permits, 0)
  await f.reopen(); const reopened = (await f.albums.queryAlbums(query)).items[0]!; await f.albums.getArtwork(request(reopened))
  assert.equal(f.metrics().normalizes, 2, 'Owner关闭后不能发布旧请求的持久成功图')
  const before = f.metrics(); await f.albums.getArtwork(request(reopened)); assert.equal(f.metrics().normalizes, 2); assert.equal(f.metrics().bodyReads, before.bodyReads)
})


// 本组验证计数事实连续性；复用同一真实Owner/SQL/Source/Rust夹具。
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
  assert.equal(cold.status, 'ready'); assertImage(cold.image, f.png16, 16)
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

test('MBF封面计数：持久资源可独立重建计数，旧观察未写入也不必再次取图晋升', async t => {
  const f = await fixture(t), album = (await f.albums.queryAlbums(query)).items[0]!, observations = f.repository.privateLocalAlbumArtworkObservations
  assert.ok(observations)
  // 只禁用旧观察put；真实冷读与资源落盘仍走生产链，重建不能靠第二次读图补计数。
  const noObservation = t.mock.method(observations, 'put', () => false)
  let expectedSha: string
  try {
    const cold = await f.albums.getArtwork(request(album)); assert.equal(cold.status, 'ready'); assert.ok(cold.image)
    expectedSha = cold.image.display.sha256
  } finally { noObservation.mock.restore() }
  await f.reopen()
  const oldCacheOnly = await f.albums.queryAlbums(query)
  assert.equal(oldCacheOnly.counts['has-artwork'], 1, '已校验且落盘的资源本身是可重建的封面事实，不依赖旧观察数组。')
  const resourceRevision = f.albums.getCacheInfo().revision; assert.ok(resourceRevision)
  assert.equal(f.repository.privateLocalAlbumArtworkObservations!.read(f.datasetId, resourceRevision).length, 0)
  const beforeHit = f.metrics(), hit = await f.albums.getArtwork(request(oldCacheOnly.items[0]!))
  assert.equal(hit.status, 'ready'); assert.equal(hit.image!.display.sha256, expectedSha)
  const afterHit = f.metrics()
  assert.equal(afterHit.bodyReads, beforeHit.bodyReads); assert.equal(afterHit.bodyBytes, beforeHit.bodyBytes)
  assert.equal(afterHit.normalizes, beforeHit.normalizes); assert.equal(afterHit.acquires, beforeHit.acquires)
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
  assertImage(repaired.image, f.png16, 16)
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

test('MBF封面计数：普通失效及标题修订保留持久图，专辑归属变化、工作库切换与撤权不复用', async t => {
  const f = await fixture(t), album = (await f.albums.queryAlbums(query)).items[0]!
  await f.albums.getArtwork(request(album)); assert.equal((await f.albums.queryAlbums(query)).counts['has-artwork'], 1)
  const beforeInvalidate = f.metrics(), primary = f.repository.readonlySnapshotStamp(), revision = f.albums.getCacheInfo().revision
  f.albums.invalidate()
  const invalidated = await f.albums.queryAlbums(query)
  assert.equal(f.albums.getCacheInfo().revision, revision); assert.equal(invalidated.items[0]!.revision, album.revision)
  assert.deepEqual(f.repository.readonlySnapshotStamp(), primary, '显式失效时原catalog/scan水位尚未推进。')
  assert.equal(invalidated.counts['has-artwork'], 1); assert.equal(invalidated.counts['missing-artwork'], 0); assert.equal(invalidated.items[0]!.artworkState, 'available')
  await f.reopen()
  const notResurrected = await f.albums.queryAlbums(query)
  assert.equal(notResurrected.counts['has-artwork'], 1); assert.equal(notResurrected.items[0]!.artworkState, 'available')
  assert.equal(f.albums.getCacheInfo().revision, revision); assert.deepEqual(f.metrics(), beforeInvalidate)
  await f.albums.getArtwork(request(notResurrected.items[0]!)); assert.equal((await f.albums.queryAlbums(query)).counts['has-artwork'], 1)
  f.repository.localCatalog.observeMetadata({ commandId: randomUUID(), trackId: album.representativeTrackId!, source: 'synthetic', parserVersion: 'album-cache-v2', fields: { title: '合成曲目修订', artist: 'AC/DC', album: '合成专辑' } })
  const changed = await f.albums.queryAlbums(query)
  assert.notEqual(changed.items[0]!.revision, album.revision); assert.equal(changed.counts['has-artwork'], 1)
  assert.equal(changed.counts['missing-artwork'], 0); assert.equal(changed.items[0]!.artworkState, 'available')
  await f.albums.getArtwork(request(changed.items[0]!)); assert.equal((await f.albums.queryAlbums(query)).counts['has-artwork'], 1)
  f.repository.localCatalog.observeMetadata({ commandId: randomUUID(), trackId: album.representativeTrackId!, source: 'synthetic', parserVersion: 'album-cache-v3', fields: { title: '合成曲目修订', artist: 'AC/DC', album: '新的合成专辑归属' } })
  const regrouped = await f.albums.queryAlbums(query)
  assert.equal(regrouped.counts['has-artwork'], 0); assert.equal(regrouped.items[0]!.artworkState, 'unknown')
  await f.albums.getArtwork(request(regrouped.items[0]!)); assert.equal((await f.albums.queryAlbums(query)).counts['has-artwork'], 1)
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


test('MBF封面计数：原期限后的Rust回复被拒绝且不持久，后续有效读取才允许补齐', async t => {
  const f = await fixture(t), initial = await f.albums.queryAlbums(query), album = initial.items[0]!, primary = f.repository.readonlySnapshotStamp()
  assert.equal(initial.counts['has-artwork'], 0)
  let clock = performance.now()
  const virtualClock = t.mock.method(performance, 'now', () => clock)
  try {
    const startedA = clock
    f.setRootRead(async () => { f.setRootRead(undefined); clock = startedA + 1000 })
    f.setNormalize(async () => { f.setNormalize(undefined); clock = startedA + 2001 })
    await assert.rejects(f.albums.getArtwork(request(album)), { code: 'UNAVAILABLE' })
    assert.equal(f.metrics().normalizerStarts.at(-1), startedA + 1000)
    assert.equal(f.metrics().acquires, 1); assert.equal(f.metrics().permits, 0)
    assert.equal(f.albums.getCacheInfo().observationCount, 0, '已过期Rust结果不取得可用观察或持久资源。')
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
    // 同一Owner B再遇一次迟到也不晋升；随后有效同图才允许补写持久事实。
    const startedB = clock
    f.setRootRead(async () => { f.setRootRead(undefined); clock = startedB + 1000 })
    f.setNormalize(async () => { f.setNormalize(undefined); clock = startedB + 2001 })
    await assert.rejects(f.albums.getArtwork(request(firstB.items[0]!)), { code: 'UNAVAILABLE' })
    assert.equal(f.metrics().normalizerStarts.at(-1), startedB + 1000)
    assert.equal((await f.albums.queryAlbums(query)).counts['has-artwork'], 0)
    const onTimeB = await f.albums.getArtwork(request(firstB.items[0]!))
    assert.equal(onTimeB.status, 'ready'); assertImage(onTimeB.image, f.png16, 16)
    assert.equal((await f.albums.queryAlbums(query)).counts['has-artwork'], 1)
    assert.equal(f.metrics().permits, 0)
    const afterOnTimeB = f.metrics(); assert.deepEqual(f.repository.readonlySnapshotStamp(), primaryB)
    await f.reopen()
    const primaryC = f.repository.readonlySnapshotStamp()
    const firstC = await f.albums.queryAlbums({ ...query, filter: 'has-artwork' })
    assert.equal(firstC.total, 1); assert.equal(firstC.counts['has-artwork'], 1); assert.equal(firstC.items[0]!.id, album.id)
    assert.deepEqual(f.metrics(), afterOnTimeB); assert.deepEqual(f.repository.readonlySnapshotStamp(), primaryC)
  } finally { f.setRootRead(undefined); f.setNormalize(undefined); virtualClock.mock.restore() }
})


test('MBF Runtime纯查询：已启动且暂停的真实后台队列不因all/filter/count/空页读取而写入，前台仍可独立冷读', async t => {
  const f = await fixture(t), background = f.background, queue = f.repository.privateLocalAlbumArtworkQueue
  assert.ok(background); assert.ok(queue)
  // started=true使旧prioritize副作用真实可达；立即pause清除timer，避免异步发现替读页写队列。
  background.start(); await background.pause()
  const enqueue = t.mock.method(queue, 'enqueue'), primary = f.repository.readonlySnapshotStamp(), queued = queue.inspect(f.datasetId), before = f.metrics()
  assert.deepEqual(queued, { mode: 'paused', pending: 0, running: 0, complete: 0 })
  const first = await f.albums.queryAlbums(query)
  assert.equal(first.total, 1); assert.equal(first.items[0]!.artworkState, 'unknown')
  for (const value of [
    { ...query, limit: 1 },
    { ...query, offset: 1, limit: 1 },
    { ...query, filter: 'has-artwork' as const },
    { ...query, filter: 'missing-artwork' as const },
  ]) assert.equal(dto.isLocalAlbumPage(await f.albums.queryAlbums(value), value), true)
  assert.equal(enqueue.mock.callCount(), 0, '读取专辑和计数不能把整页任务写成priority1000，也不能对空页开写事务')
  assert.deepEqual(queue.inspect(f.datasetId), queued); assert.deepEqual(f.metrics(), before)
  assert.deepEqual(f.repository.readonlySnapshotStamp(), primary)
  assert.equal(Object.hasOwn(f.albums, 'privateBackgroundCandidates'), false)
  // 前台直接走原display Source读口，不依赖上述页面查询替它排高优先后台任务。
  const cold = await f.albums.getArtwork(request(first.items[0]!)); assertImage(cold.image, f.png16, 16)
  assert.equal(f.metrics().normalizes, 1); assert.equal(f.metrics().acquires, 1); assert.ok(f.metrics().bodyBytes > 0)
  assert.ok(f.metrics().maximumPermits <= 2); assert.equal(f.metrics().permits, 0)
  assert.equal(enqueue.mock.callCount(), 0); assert.deepEqual(queue.inspect(f.datasetId), queued)
  assert.deepEqual(f.repository.readonlySnapshotStamp(), primary)
})

test('MBF Runtime纯查询：Core无公开页也可独立发现并持久补齐，前台与重建Owner继续零Source命中', async t => {
  const f = await fixture(t), background = f.background, queue = f.repository.privateLocalAlbumArtworkQueue
  assert.ok(background); assert.ok(queue)
  const primary = f.repository.readonlySnapshotStamp(), enqueue = t.mock.method(queue, 'enqueue')
  const publicQuery = t.mock.method(f.repository.localCatalog, 'privateAlbumBrowserQuery', () => { throw new Error('独立Core补齐不能借公开专辑页预热或排队。') })
  try {
    background.start(); await background.runPending(); await background.pause()
    assert.equal(publicQuery.mock.callCount(), 0)
    assert.equal(enqueue.mock.callCount(), 1); assert.equal(enqueue.mock.calls[0]!.arguments[1].length, 1)
    assert.equal(enqueue.mock.calls[0]!.arguments[2], 100, 'Core首批仍由原50项候选链按其100优先级入队')
    assert.deepEqual(queue.inspect(f.datasetId), { mode: 'paused', pending: 0, running: 0, complete: 1 })
    assert.equal(f.metrics().normalizes, 1); assert.equal(f.metrics().acquires, 1); assert.ok(f.metrics().bodyBytes > 0)
    assert.ok(f.metrics().maximumPermits <= 2); assert.equal(f.metrics().permits, 0)
  } finally { publicQuery.mock.restore() }
  const saved = f.metrics(), page = await f.albums.queryAlbums(query)
  assert.equal(page.counts['has-artwork'], 1); assert.equal(page.items[0]!.artworkPrepared, true)
  assertImage((await f.albums.getArtwork(request(page.items[0]!))).image, f.png16, 16)
  assert.deepEqual(f.metrics(), saved); assert.equal(enqueue.mock.callCount(), 1, '公开页和持久图命中不回填队列优先级')
  assert.deepEqual(f.repository.readonlySnapshotStamp(), primary)
  const trackId = page.items[0]!.representativeTrackId!
  const savedTrack = f.repository.localCatalog.trackDetail(trackId)
  await f.reopen()
  const reopenedPrimary = f.repository.readonlySnapshotStamp()
  const restored = await f.albums.queryAlbums(query)
  assert.equal(restored.counts['has-artwork'], 1); assert.equal(restored.items[0]!.artworkPrepared, true)
  assertImage((await f.albums.getArtwork(request(restored.items[0]!))).image, f.png16, 16)
  assert.deepEqual(f.metrics(), saved, 'Core原COMMIT持久成功可跨Owner读取，不靠Renderer全库hydrate补齐')
  assert.deepEqual(f.repository.localCatalog.trackDetail(trackId), savedTrack, '重开后持久音乐事实不变')
  assert.deepEqual(f.repository.readonlySnapshotStamp(), reopenedPrimary, '新连接的total_changes从零起算，读取不能增加它')
})
