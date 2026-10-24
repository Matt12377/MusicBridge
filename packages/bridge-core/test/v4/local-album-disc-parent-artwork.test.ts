import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { fstatSync } from 'node:fs'
import fs, { type FileHandle } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import * as dto from '@music-bridge/contracts'
import { createCollectionRepository } from '../../src/collection/repository.js'
import { createLocalAlbumOwnerRuntime } from '../../src/collection/local-album-browser/owner-runtime.js'
import type { LocalAlbumLibraryOrganization } from '../../src/collection/local-album-browser/sql-types.js'
import { localArtworkDiscParentDirectory } from '../../src/library/local-artwork-directory-candidates.js'
import { validLocalAlbumDisplayEvidence } from '../../src/collection/local-album-browser/display-cache.js'
import { isDatasetProjectionPayload, type DatasetProjectionPort } from '../../src/collection/dataset-owner-protocol.js'
import { createScanReadAdmission } from '../../src/library/scan-read-admission.js'
import { authorizeSourceDirectory, sourceRootAvailability } from '../../src/recording/source-files.js'
import { closeRustMediaWorkerPool, getRustMediaWorkerPool } from '../../src/library/rust-media-worker.js'

// 合成目录穿真实Repository/Source/许可/FD/Rust及资源COMMIT；不连接正式音乐库。
after(() => closeRustMediaWorkerPool())
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
const query: dto.LocalAlbumQuery = { query: '', rootId: null, filter: 'all', offset: 0, limit: 200 }
const request = (album: dto.LocalAlbumSummary): dto.LocalAlbumArtworkRequest => ({ albumKey: album.id, rootId: album.rootId,
  editionId: album.editionId, representativeTrackId: album.representativeTrackId, revision: album.revision })
const riff = (id: string, body: Buffer): Buffer => {
  const header = Buffer.alloc(8); header.write(id, 0, 'ascii'); header.writeUInt32LE(body.length, 4)
  return Buffer.concat([header, body, Buffer.alloc(body.length % 2)])
}
function wave(embedded?: Buffer): Buffer {
  const fmt = Buffer.from('0100020044ac000010b1020004001000', 'hex')
  const chunks = [riff('fmt ', fmt), riff('data', Buffer.alloc(1764))]
  if (embedded) {
    const body = Buffer.concat([Buffer.from([0]), Buffer.from('image/png\0', 'ascii'), Buffer.from([3, 0]), embedded])
    const frame = Buffer.alloc(10); frame.write('APIC'); frame.writeUInt32BE(body.length, 4)
    const frames = Buffer.concat([frame, body]), tag = Buffer.alloc(10); tag.write('ID3'); tag[3] = 3
    for (let index = 0; index < 4; index++) tag[6 + index] = Math.floor(frames.length / 128 ** (3 - index)) & 127
    chunks.push(riff('ID3 ', Buffer.concat([tag, frames])))
  }
  const body = Buffer.concat([Buffer.from('WAVE'), ...chunks]), header = Buffer.alloc(8)
  header.write('RIFF'); header.writeUInt32LE(body.length, 4)
  return Buffer.concat([header, body])
}
function directoryReads(t: test.TestContext): string[] {
  const calls: string[] = [], original = fs.opendir
  const mocked = t.mock.method(fs, 'opendir', (...args: Parameters<typeof fs.opendir>) => {
    calls.push(String(args[0])); return Reflect.apply(original, fs, args)
  })
  syncBuiltinESMExports()
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports() })
  return calls
}
async function fixture(t: test.TestContext, options: {
  directories?: readonly string[]; images?: Readonly<Record<string, 'parent' | 'child'>>; embedded?: boolean; role?: 'catalog' | 'artist'; rootLeaf?: string
} = {}) {
  const temporary = process.env.TMPDIR
  if (!temporary?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/')) throw new Error('子碟封面Gate必须采用外置临时目录')
  const directory = await fs.mkdtemp(path.join(temporary, 'mb-disc-cover-')), media = path.join(directory, options.rootLeaf ?? 'media'), work = path.join(directory, 'collection.sqlite')
  await fs.mkdir(media)
  const parentImage = await fs.readFile(new URL('../fixtures/mbrs012-source/owned-cover-16.jpg', import.meta.url))
  const childImage = await fs.readFile(new URL('../fixtures/mbrs012-source/owned-cover-32.png', import.meta.url))
  const directories = options.directories ?? ['Album/CD1'], identities = new Map<string, string>(), bodyReads = new Map<string, number>()
  async function register(relative: string) { const info = await fs.stat(path.join(media, relative)); identities.set(`${info.dev}:${info.ino}`, relative) }
  async function writeImage(relative: string, which: 'parent' | 'child' = 'parent') {
    await fs.mkdir(path.dirname(path.join(media, relative)), { recursive: true })
    await fs.writeFile(path.join(media, relative), which === 'parent' ? parentImage : childImage); await register(relative)
  }
  for (const folder of directories) {
    await fs.mkdir(path.join(media, folder), { recursive: true })
    const relative = path.posix.join(folder, 'song.wav')
    await fs.writeFile(path.join(media, relative), wave(options.embedded ? childImage : undefined)); await register(relative)
  }
  for (const [relative, which] of Object.entries(options.images ?? {})) await writeImage(relative, which)
  const probe = await fs.open(path.join(media, directories[0]!, 'song.wav'), 'r'), prototype = Object.getPrototypeOf(probe), read = prototype.read
  await probe.close()
  t.mock.method(prototype, 'read', async function (this: FileHandle, ...args: unknown[]) {
    let relative: string | undefined
    try { const info = fstatSync(this.fd); relative = identities.get(`${info.dev}:${info.ino}`) } catch { /* 非目标FD沿原读取。 */ }
    const result = await Reflect.apply(read, this, args) as Awaited<ReturnType<FileHandle['read']>>
    if (relative) bodyReads.set(relative, (bodyReads.get(relative) ?? 0) + 1)
    return result
  })
  const pool = getRustMediaWorkerPool(), normalize = pool.processImage.bind(pool), embedded = pool.readEmbeddedArtwork.bind(pool)
  let normalized = 0, embeddedReads = 0, acquired = 0, maximum = 0, onNormalize: (() => Promise<void>) | undefined
  t.mock.method(pool, 'processImage', async (...args: Parameters<typeof pool.processImage>) => {
    normalized++; await onNormalize?.(); return normalize(...args)
  })
  t.mock.method(pool, 'readEmbeddedArtwork', (...args: Parameters<typeof pool.readEmbeddedArtwork>) => { embeddedReads++; return embedded(...args) })
  let repository = createCollectionRepository({ filePath: work })
  const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media))
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' })
  const tracks = new Map<string, string>()
  for (const folder of directories) {
    const asset = repository.localCatalog.registerAsset({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision,
      relative: path.posix.join(folder, 'song.wav'), sha256: null, sampleFrames: null, timebaseHz: null })
    const track = repository.localCatalog.createTrack({ commandId: randomUUID(), assetId: asset.id, segment: null })
    tracks.set(folder, track.id)
    repository.localCatalog.observeMetadata({ commandId: randomUUID(), trackId: track.id, source: 'synthetic', parserVersion: 'disc-cover-fixture-v1',
      fields: { title: '合成歌曲', artist: '合成作者', album: `合成专辑 ${folder || '根目录'}` } })
  }
  const datasetId = randomUUID()
  const organizations: readonly LocalAlbumLibraryOrganization[] = options.role ? [{ datasetId, rootId: root.id, sourceRootId: source.id, rootRevision: root.revision,
    bindingRevision: 1, recordSha256: hash('合成组织绑定'), role: options.role, rootName: '合成作者', parentName: '合成来源' }] : []
  let gate: ReturnType<typeof createScanReadAdmission>, runtime: ReturnType<typeof createLocalAlbumOwnerRuntime>
  function connect() {
    gate = createScanReadAdmission({ isBusy: () => false, isDisplayBusy: () => false })
    const scope = { epoch: randomUUID(), datasetId }
    const projection: DatasetProjectionPort = { async call(command, payload) {
      assert.equal(isDatasetProjectionPayload(command, payload), true)
      if (command === 'scanReadStatus') return gate.status(scope) as never
      if (command === 'scanReadAcquire') {
        acquired++; const result = gate.acquire(scope, Object.hasOwn(payload, 'purpose') ? 'local-album-display' : 'scan')
        maximum = Math.max(maximum, gate.resourceCounts().permits); assert.ok(maximum <= 2); return result as never
      }
      if (command === 'scanReadWatchRevocation') return gate.watchRevocation(scope, (payload as { permitId: string }).permitId) as never
      if (command === 'scanReadRelease') return gate.release(scope, (payload as { permitId: string }).permitId) as never
      throw new Error('子碟Gate不得进入额外投影或Main图像fallback')
    } }
    runtime = createLocalAlbumOwnerRuntime({ repository, datasetId, projection, assertCurrent() {}, readLibraryOrganizations: () => organizations,
      async readRootViews() { return [{ root: repository.localCatalog.root(root.id), label: '合成来源',
        availability: await sourceRootAvailability(repository.sources.root(source.id)) }] } })
  }
  connect()
  t.after(async () => { await runtime.close(); gate.close(); repository.close(); await fs.rm(directory, { recursive: true, force: true }) })
  async function albums() { return (await runtime.localAlbums.queryAlbums(query)).items }
  async function requestFor(folder: string) {
    const album = (await albums()).find(value => value.representativeTrackId === tracks.get(folder))
    assert.ok(album); return request(album)
  }
  const resource = (value: dto.LocalAlbumArtworkRequest) => {
    const store = repository.privateLocalAlbumArtworkResources!, mapped = store.lookup(datasetId, root.id, value.albumKey)
    assert.ok(mapped); return { mapped, saved: store.get(mapped.binding)!, store }
  }
  async function legacyMissing(value: dto.LocalAlbumArtworkRequest) {
    const result = await runtime.localAlbums.getArtwork(value); assert.equal(result.status, 'ready'); assert.equal(result.image, null)
    const { mapped, saved, store } = resource(value); assert.equal(saved.state, 'missing')
    const { discoveryPolicy: _policy, ...evidence } = saved.evidence
    store.put(mapped.binding, { image: null, evidence }, () => {})
    assert.equal(validLocalAlbumDisplayEvidence(evidence), true)
  }
  return { directory, media, work, source, root, datasetId, tracks, parentImage, childImage, writeImage, register, albums, requestFor, resource, legacyMissing,
    get repository() { return repository }, get runtime() { return runtime }, get gate() { return gate },
    metrics: () => ({ normalized, embeddedReads, acquired, maximum, bodyReads: Object.fromEntries(bodyReads) }),
    setNormalize(callback: (() => Promise<void>) | undefined) { onNormalize = callback },
    async reopen() { await runtime.close(); gate.close(); repository.close(); repository = createCollectionRepository({ filePath: work }); connect() },
  }
}
function assertQuiet(f: Awaited<ReturnType<typeof fixture>>) {
  assert.deepEqual(f.gate.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: false })
}

test('子碟父封面：实际catalog组织四个CD共享父cover，胜过旧embedded，父不枚举且许可与FD真实闭合', { timeout: 30000 }, async t => {
  const listed = directoryReads(t), f = await fixture(t, { directories: ['Album/CD1', 'Album/CD2', 'Album/CD3', 'Album/CD4'],
    images: { 'Album/cover.jpg': 'parent' }, embedded: true, role: 'catalog' })
  const before = f.repository.readonlySnapshotStamp()
  for (const folder of ['Album/CD1', 'Album/CD2', 'Album/CD3', 'Album/CD4']) {
    const value = await f.requestFor(folder), result = await f.runtime.localAlbums.getArtwork(value)
    assert.ok(result.image); assert.equal(result.image.original.sha256, sha(f.parentImage))
    const saved = f.resource(value).saved
    assert.equal(saved.evidence.independent.find(item => item.included)?.relative, 'Album/cover.jpg')
    assert.equal(saved.evidence.discoveryPolicy, 'disc-parent-v1'); assertQuiet(f)
  }
  const metrics = f.metrics(); assert.equal(metrics.embeddedReads, 0); assert.equal(metrics.normalized, 4); assert.equal(metrics.acquired, 4)
  assert.equal(listed.includes(path.join(f.media, 'Album')), false, '父目录只能固定名探查，不得readdir')
  assert.equal(listed.length, 4); assert.deepEqual(f.repository.readonlySnapshotStamp(), before)
})

test('子碟父封面：子目录独立图优先，父不存在才回原embedded，available跨重开继续零源读取', { timeout: 30000 }, async t => {
  const f = await fixture(t, { directories: ['Album/CD1', 'NoParent/CD2'], embedded: true,
    images: { 'Album/cover.jpg': 'parent', 'Album/CD1/cover.png': 'child' } })
  const child = await f.requestFor('Album/CD1'), own = await f.runtime.localAlbums.getArtwork(child)
  assert.ok(own.image); assert.equal(own.image.original.sha256, sha(f.childImage)); assert.equal(f.metrics().bodyReads['Album/cover.jpg'] ?? 0, 0)
  assert.equal(f.metrics().embeddedReads, 0)
  const embedded = await f.requestFor('NoParent/CD2'), fallback = await f.runtime.localAlbums.getArtwork(embedded)
  assert.ok(fallback.image); assert.equal(fallback.image.original.sha256, sha(f.childImage)); assert.equal(f.metrics().embeddedReads, 1)
  assert.equal(f.resource(embedded).saved.evidence.independent.some(item => item.included), false)
  const before = f.metrics(), stable = f.resource(child).saved
  await f.reopen()
  assert.deepEqual((await f.runtime.localAlbums.getArtwork(child)).image, own.image)
  assert.deepEqual(f.resource(child).saved, stable); assert.deepEqual(f.metrics(), before); assertQuiet(f)
})

test('子碟父封面：严格disc名、普通版本目录、已逻辑上提目录及Source根边界都不继续上爬', { timeout: 30000 }, async t => {
  for (const value of ['', '.', 'Album', 'Album/CD1 Deluxe', 'Album/WAV', 'Album/Version1', '../CD1', '/CD1', 'Album/CD1/']) assert.equal(localArtworkDiscParentDirectory(value), null)
  assert.equal(localArtworkDiscParentDirectory('Album/CD1'), 'Album'); assert.equal(localArtworkDiscParentDirectory('CD1'), '')
  const f = await fixture(t, { directories: ['Album/Version1'], images: { 'Album/cover.jpg': 'parent' } })
  assert.equal((await f.runtime.localAlbums.getArtwork(await f.requestFor('Album/Version1'))).image, null)
  assert.equal(f.metrics().bodyReads['Album/cover.jpg'] ?? 0, 0); assertQuiet(f)
  const artist = await fixture(t, { directories: ['Album/CD1'], images: { 'cover.jpg': 'parent' }, role: 'artist' })
  const selected = await artist.requestFor('Album/CD1')
  assert.equal((await artist.runtime.localAlbums.getArtwork(selected)).image, null)
  assert.equal(artist.metrics().bodyReads['cover.jpg'] ?? 0, 0, '已聚合到Album的context不得再爬到艺人根')
  const bounded = await fixture(t, { directories: [''], rootLeaf: 'CD1' })
  await fs.writeFile(path.join(bounded.directory, 'cover.jpg'), bounded.parentImage)
  assert.equal((await bounded.runtime.localAlbums.getArtwork(await bounded.requestFor(''))).image, null)
  assertQuiet(artist); assertQuiet(bounded)
})

test('子碟父封面：子目录截断或非固定名歧义不能被父图掩盖，也不落missing', { timeout: 30000 }, async t => {
  for (const mode of ['truncated', 'ambiguous'] as const) {
    const f = await fixture(t, { images: { 'Album/cover.jpg': 'parent' } })
    if (mode === 'truncated') {
      for (let index = 0; index < 512; index++) await fs.writeFile(path.join(f.media, 'Album/CD1', `note-${index}.txt`), '合成目录预算项')
    } else {
      await f.writeImage('Album/CD1/a.jpg'); await f.writeImage('Album/CD1/b.jpg')
    }
    const value = await f.requestFor('Album/CD1'), result = await f.runtime.localAlbums.getArtwork(value)
    assert.equal(result.image, null); assert.equal(result.status, 'source-unavailable')
    assert.equal(f.metrics().bodyReads['Album/cover.jpg'] ?? 0, 0)
    assert.equal(f.repository.privateLocalAlbumArtworkResources!.lookup(f.datasetId, f.root.id, value.albumKey), null)
    assertQuiet(f)
  }
})

test('子碟父封面：仅旧CDnegative自动重探，旧available与普通negative完整保留，overlay不新增逐组详情读', { timeout: 30000 }, async t => {
  const f = await fixture(t, { directories: ['Album/CD1', 'Stable', 'Ordinary'], images: { 'Stable/cover.png': 'child' }, role: 'catalog' })
  const cd = await f.requestFor('Album/CD1'), ordinary = await f.requestFor('Ordinary'), stable = await f.requestFor('Stable')
  await f.legacyMissing(cd); await f.legacyMissing(ordinary)
  const good = await f.runtime.localAlbums.getArtwork(stable); assert.ok(good.image)
  const goodSaved = f.resource(stable).saved, ordinarySaved = f.resource(ordinary).saved
  await f.reopen(); await f.writeImage('Album/cover.jpg')
  const catalog = f.repository.localCatalog, detail = catalog.trackDetail.bind(catalog), queryAlbums = catalog.privateAlbumBrowserQuery.bind(catalog)
  let detailReads = 0
  const overlayReads: number[] = []
  const spy = t.mock.method(catalog, 'trackDetail', (...args: Parameters<typeof detail>) => { detailReads++; return detail(...args) })
  const querySpy = t.mock.method(catalog, 'privateAlbumBrowserQuery', (...args: Parameters<typeof queryAlbums>) => {
    const start = detailReads
    try { return queryAlbums(...args) } finally { overlayReads.push(detailReads - start) }
  })
  try {
    // 真SQL仍处理全部三份持久库存；只返回一张，单独保留SQL后的原当页prepared强核。
    const page = await f.runtime.localAlbums.queryAlbums({ ...query, limit: 1 })
    assert.equal(page.counts.all, 3); assert.equal(page.items.length, 1)
    assert.deepEqual(overlayReads, [0], '旧CD策略提示不得把全G projected overlay变回逐组详情读取')
    assert.equal(detailReads, page.items.length, 'SQL后当页原readPreparedArtwork强核仍逐项执行')
  } finally { querySpy.mock.restore(); spy.mock.restore() }
  assert.equal(f.runtime.artwork.needsDiscParentReprobe(cd), true)
  assert.equal(f.runtime.artwork.needsDiscParentReprobe(ordinary), false); assert.equal(f.runtime.artwork.needsDiscParentReprobe(stable), false)
  const before = f.metrics(), repaired = await f.runtime.localAlbums.getArtwork(cd)
  assert.ok(repaired.image); assert.equal(repaired.image.original.sha256, sha(f.parentImage))
  assert.equal(f.metrics().acquired, before.acquired + 1); assert.equal(f.runtime.artwork.needsDiscParentReprobe(cd), false)
  assert.deepEqual(f.resource(stable).saved, goodSaved); assert.deepEqual(f.resource(ordinary).saved, ordinarySaved)
  const afterRepair = f.metrics(); await f.reopen()
  assert.deepEqual((await f.runtime.localAlbums.getArtwork(cd)).image, repaired.image); assert.deepEqual(f.metrics(), afterRepair)
  assert.equal(f.resource(cd).saved.evidence.discoveryPolicy, 'disc-parent-v1'); assertQuiet(f)
})

test('子碟父封面：新策略确证missing跨重开不反复重探，未知策略标记仍被原codec拒绝', { timeout: 30000 }, async t => {
  const f = await fixture(t), value = await f.requestFor('Album/CD1')
  const result = await f.runtime.localAlbums.getArtwork(value); assert.equal(result.image, null); assert.equal(result.status, 'ready')
  const saved = f.resource(value).saved
  assert.equal(saved.evidence.discoveryPolicy, 'disc-parent-v1'); assert.equal(f.runtime.artwork.needsDiscParentReprobe(value), false)
  assert.equal(validLocalAlbumDisplayEvidence({ ...saved.evidence, discoveryPolicy: 'unregistered-policy' }), false)
  assert.equal(validLocalAlbumDisplayEvidence({ ...saved.evidence, discoveryPolicy: null }), false)
  assert.equal(validLocalAlbumDisplayEvidence({ ...saved.evidence, extra: true }), false)
  const before = f.metrics(); await f.reopen()
  assert.equal(f.runtime.artwork.needsDiscParentReprobe(value), false)
  assert.equal((await f.runtime.localAlbums.getArtwork(value)).image, null); assert.deepEqual(f.metrics(), before); assertQuiet(f)
})

test('子碟父封面：父图symlink或规范化期间真实改签名均拒绝发布，原FD/许可仍归还', { timeout: 30000 }, async t => {
  for (const mode of ['symlink', 'change'] as const) {
    const f = await fixture(t)
    if (mode === 'symlink') {
      const outside = path.join(f.directory, 'outside.jpg'); await fs.writeFile(outside, f.parentImage)
      await fs.symlink(outside, path.join(f.media, 'Album/cover.jpg'))
    } else {
      await f.writeImage('Album/cover.jpg')
      f.setNormalize(async () => { f.setNormalize(undefined); await f.writeImage('Album/cover.jpg', 'child') })
    }
    const value = await f.requestFor('Album/CD1')
    await assert.rejects(f.runtime.localAlbums.getArtwork(value))
    assert.equal(f.repository.privateLocalAlbumArtworkResources!.lookup(f.datasetId, f.root.id, value.albumKey), null)
    assertQuiet(f)
  }
})

test('子碟父封面：原有界completed对账仅重排旧CDnegative，实际后台读补图后跨轮不再重排', { timeout: 30000 }, async t => {
  const f = await fixture(t, { directories: ['Album/CD1', 'Stable'], images: { 'Stable/cover.png': 'child' } })
  const cd = await f.requestFor('Album/CD1'), stable = await f.requestFor('Stable')
  await f.legacyMissing(cd); assert.ok((await f.runtime.localAlbums.getArtwork(stable)).image)
  const queue = f.repository.privateLocalAlbumArtworkQueue!; queue.recover(f.datasetId); queue.enqueue(f.datasetId, [cd, stable], 10)
  for (let index = 0; index < 2; index++) { const claim = queue.claim(f.datasetId, Date.now(), [f.root.id]); assert.ok(claim); assert.equal(queue.complete(claim), true) }
  await f.writeImage('Album/cover.jpg')
  const before = f.metrics(), reconciled = queue.reconcileCompleted(f.datasetId, null, [f.root.id], value => f.runtime.artwork.persistedState(value))
  assert.equal(reconciled.checked, 2); assert.equal(reconciled.requeued, 1); assert.equal(reconciled.done, true)
  assert.deepEqual(f.metrics(), before, '本地对账不能申请Source许可或读取源正文')
  assert.deepEqual(queue.inspect(f.datasetId), { mode: 'running', pending: 1, running: 0, complete: 1 })
  const claim = queue.claim(f.datasetId, Date.now(), [f.root.id]); assert.ok(claim); assert.equal(claim.request.albumKey, cd.albumKey)
  const result = await f.runtime.localAlbums.getArtwork(claim.request, { purpose: 'background' })
  assert.ok(result.image); assert.equal(result.image.original.sha256, sha(f.parentImage)); assert.equal(queue.complete(claim), true)
  assert.equal(queue.reconcileCompleted(f.datasetId, null, [f.root.id], value => f.runtime.artwork.persistedState(value)).requeued, 0)
  assertQuiet(f)
})
