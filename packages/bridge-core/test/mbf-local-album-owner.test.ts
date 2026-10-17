import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm, rename } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as dto from '@music-bridge/contracts'
import { createCollectionRepository } from '../src/collection/repository.js'
import { createLocalAlbumOwnerService } from '../src/collection/local-album-browser/owner-port.js'
import { createLocalAlbumArtworkReader } from '../src/collection/local-album-browser/artwork-read-port.js'
import { createScanReadAdmission } from '../src/library/scan-read-admission.js'
import { authorizeSourceDirectory, sourceRootAvailability } from '../src/recording/source-files.js'
import type { DatasetProjectionPort } from '../src/collection/dataset-owner-protocol.js'
import { captureLocalAlbumContext, runLocalAlbumContext, localAlbumReject, localAlbumTerminal, localAlbumTraceSha, collectLocalAlbumSafeTrace, snapshotLocalAlbumReadTrace, type LocalAlbumNodeContext } from '../src/shared/local-album-read-trace-node.js'
import { LOCAL_ALBUM_TRACE_PREFIX, copyLocalAlbumSafeTrace, readLocalAlbumSafeTraceLine, createLocalAlbumSafeTraceReader, copyLocalAlbumReadTraceSnapshot, type LocalAlbumSafeTrace } from '../src/shared/library-read-trace.js'

const query: dto.LocalAlbumQuery = { query: '', rootId: null, filter: 'all', offset: 0, limit: 60 }
async function fixture(t: test.TestContext, expectedArtworkCloseFailure?: RegExp, isBusy: () => boolean = () => false) {
  const temporary = process.env.TMPDIR
  if (!temporary?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/')) throw new Error('合成测试必须采用外置任务临时目录')
  const directory = await mkdtemp(path.join(temporary, 'mbf-album-owner-')), media = path.join(directory, 'media'), file = path.join(directory, 'work.sqlite')
  await mkdir(path.join(media, 'one'), { recursive: true }); await mkdir(path.join(media, 'two'), { recursive: true })
  const audio = await readFile(new URL('./fixtures/mbrs003/audio/fixtures/core-wav.wav', import.meta.url))
  const png = await readFile(new URL('./fixtures/mbrs003/audio/inputs/cover-small.png', import.meta.url))
  assert.equal(createHash('sha256').update(audio).digest('hex'), 'cc1eaac76af6c2b237f97c908202e3ded3b1aff6d7052bf20846a487243e5340')
  assert.equal(createHash('sha256').update(png).digest('hex'), '243ddd560483dfae4f0ac0cce1e922a7828baab254b6df5d3402d0fec4f06e45')
  for (const dir of ['one', 'two']) { await writeFile(path.join(media, dir, 'song.wav'), audio); await writeFile(path.join(media, dir, 'cover.png'), png) }
  const repository = createCollectionRepository({ filePath: file }), source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media))
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' })
  const tracks = ['one', 'two'].map(dir => {
    const asset = repository.localCatalog.registerAsset({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision,
      relative: `${dir}/song.wav`, sha256: null, sampleFrames: null, timebaseHz: null })
    const track = repository.localCatalog.createTrack({ commandId: randomUUID(), assetId: asset.id, segment: null })
    repository.localCatalog.observeMetadata({ commandId: randomUUID(), trackId: track.id, source: 'synthetic', parserVersion: 'mbf-synthetic-v1', fields: { title: '合成歌曲', artist: '合成作者', album: '同名合成专辑' } })
    return track
  })
  const scope = { epoch: randomUUID(), datasetId: randomUUID() }, admission = createScanReadAdmission({ isBusy })
  const projection: DatasetProjectionPort = { async call(command, payload) {
    if (command === 'scanReadAcquire') return admission.acquire(scope) as never
    if (command === 'scanReadWatchRevocation') return admission.watchRevocation(scope, (payload as { permitId: string }).permitId) as never
    if (command === 'scanReadRelease') return admission.release(scope, (payload as { permitId: string }).permitId) as never
    throw new Error('本用例不调用Main图像解码')
  } }
  const artwork = createLocalAlbumArtworkReader({ repository, projection, assertCurrent() {} })
  const albums = createLocalAlbumOwnerService({ repository, assertCurrent() {},
    async readRootViews() { return [{ root: repository.localCatalog.root(root.id), label: '合成来源', availability: await sourceRootAvailability(repository.sources.root(root.sourceRootId)) }] },
    async readArtwork() { return { image: null, status: 'source-unavailable' } },
  })
  t.after(async () => {
    try { if (expectedArtworkCloseFailure) await assert.rejects(artwork.close(), expectedArtworkCloseFailure); else await artwork.close() }
    finally { albums.close(); admission.close(); repository.close(); await rm(directory, { recursive: true }) }
  })
  return { repository, root, tracks, albums, artwork, directory, media, file, png, admission, projection, scope }
}
function rows(file: string) {
  const db = new DatabaseSync(file, { readOnly: true })
  try { return ['local_catalog_ledger', 'local_catalog_editions', 'local_catalog_edition_tracks', 'local_artwork_candidates', 'local_artwork_selections', 'local_scan_jobs']
    .map(table => [table, Number(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n)]) }
  finally { db.close() }
}

test('专辑私有计时：原Owner与SQL冷热路径同SHA且旁注故障保原首错与返回', async t => {
  // 仅合成Owner/SQLite计时链；不证明Worker投递、真实目录或普通App延迟首因。
  const originalInfo = console.info, outerContext = captureLocalAlbumContext(), restorations: Array<() => void> = []
  t.after(() => {
    const errors: unknown[] = []
    try { console.info = originalInfo } catch (error) { errors.push(error) }
    for (const restore of restorations) try { restore() } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, '专辑私有计时测试恢复未全部确认。', { cause: errors[0] })
  })
  const f = await fixture(t), catalog = f.repository.localCatalog, before = rows(f.file)
  const originalQuery = catalog.privateAlbumBrowserQuery, originalMembers = catalog.privateAlbumBrowserMembers, originalArtwork = catalog.privateAlbumBrowserArtwork
  restorations.push(() => { catalog.privateAlbumBrowserQuery = originalQuery }, () => { catalog.privateAlbumBrowserMembers = originalMembers }, () => { catalog.privateAlbumBrowserArtwork = originalArtwork })
  let queryCalls = 0, memberCalls = 0, artworkCalls = 0, portError: unknown, sinkFailures = 0, failSink = false
  let memberScope: Parameters<typeof originalMembers>[1] | undefined
  catalog.privateAlbumBrowserQuery = (request, scope) => {
    queryCalls++; assert.equal(captureLocalAlbumContext()?.stage, 'owner.sql'); return originalQuery.call(catalog, request, scope)
  }
  catalog.privateAlbumBrowserMembers = (request, scope) => {
    memberCalls++; memberScope = scope; assert.equal(captureLocalAlbumContext()?.stage, 'owner.sql')
    try { return originalMembers.call(catalog, request, scope) } catch (error) { portError = error; throw error }
  }
  catalog.privateAlbumBrowserArtwork = (request, scope) => {
    artworkCalls++; assert.equal(captureLocalAlbumContext()?.stage, 'owner.sql'); return originalArtwork.call(catalog, request, scope)
  }
  const emitted: Array<{ trace: LocalAlbumSafeTrace; context: LocalAlbumNodeContext | undefined; stage: string | undefined; raw: string }> = []
  const timingStages = ['owner.sql.albums', 'owner.sql.tracks', 'owner.sql.artwork', 'sql.run.enter', 'sql.derived', 'owner.return', 'worker.await', 'worker.post'] as const
  console.info = (...args: unknown[]) => {
    const raw = args[0]; assert.equal(args.length, 1); assert.equal(typeof raw, 'string')
    const trace = readLocalAlbumSafeTraceLine(raw); assert.ok(trace)
    const context = captureLocalAlbumContext(); emitted.push({ trace, context, stage: context?.stage, raw: raw as string })
    if (failSink && timingStages.some(stage => stage === trace.stage)) { sinkFailures++; throw new Error('合成私有计时输出失败') }
  }
  const parent = localAlbumTraceSha(randomUUID()), ids = Array.from({ length: 6 }, () => randomUUID())
  const invoke = <T>(index: number, work: () => Promise<T>) => runLocalAlbumContext(ids[index]!, parent, 'worker.read', async () => {
    const context = captureLocalAlbumContext(); assert.ok(context)
    const value = await work()
    assert.equal(captureLocalAlbumContext(), context); assert.equal(context.first, null)
    assert.ok(['owner.dto', 'owner.artwork', 'owner.seal'].includes(context.stage)); return value
  }, true)
  const page = await invoke(0, () => f.albums.queryAlbums(query)), album = page.items[0]!
  const tracks: dto.LocalAlbumTrackQuery = { albumKey: album.id, rootId: album.rootId, offset: 0, limit: 100 }
  failSink = true
  const first = await invoke(1, () => f.albums.queryAlbumTracks(tracks))
  failSink = false
  const repeated = await invoke(2, () => f.albums.queryAlbumTracks(tracks)); assert.deepEqual(repeated, first)
  const artwork = await invoke(3, () => f.albums.getArtwork({ albumKey: album.id, rootId: album.rootId, editionId: album.editionId,
    representativeTrackId: album.representativeTrackId, revision: album.revision }))
  assert.equal(artwork.status, 'source-unavailable'); assert.equal(artwork.image, null)
  // 显式问题读取复用真实Owner传入的原scope；普通公有详情/单图不再主动构造全组索引。
  const capturedScope = memberScope; assert.ok(capturedScope)
  runLocalAlbumContext(ids[5]!, parent, 'owner.sql', () => {
    const context = captureLocalAlbumContext(); assert.ok(context)
    const issues = catalog.privateAlbumBrowserIssues(tracks, capturedScope)
    assert.deepEqual(catalog.privateAlbumBrowserIssues(tracks, capturedScope), issues)
    assert.equal(context.stage, 'owner.sql'); assert.equal(context.first, null)
  }, true)
  failSink = true
  await assert.rejects(runLocalAlbumContext(ids[4]!, parent, 'worker.read', async () => {
    const context = captureLocalAlbumContext(); assert.ok(context)
    try { await f.albums.queryAlbumTracks({ ...tracks, albumKey: 'synthetic-missing-album' }); assert.fail('不存在的原SQL专辑必须拒绝') }
    catch (error) {
      assert.equal(error, portError); assert.ok(context.first); assert.equal(context.stage, 'owner.sql'); assert.equal(context.first.stage, 'owner.sql')
      assert.equal(context.first.code, 'SNAPSHOT_CHANGED'); throw error
    }
  }, true), error => error === portError)
  assert.equal(queryCalls, 1); assert.equal(memberCalls, 3); assert.equal(artworkCalls, 1); assert.ok(sinkFailures > 0)
  const tracesFor = (index: number) => emitted.filter(row => row.trace.traceSha256 === localAlbumTraceSha(ids[index]!)).map(row => row.trace)
  for (const row of emitted) {
    assert.equal(row.stage, row.trace.stage); assert.equal(row.context?.traceSha256, row.trace.traceSha256)
    assert.equal(row.trace.parentSha256, parent); assert.ok(row.raw.length <= 2048)
    assert.equal(row.raw.includes(f.media), false); assert.equal(row.raw.includes('合成私有计时输出失败'), false)
    for (const id of ids) assert.equal(row.raw.includes(id), false)
  }
  for (const [index, kind] of [[0, 'albums'], [1, 'tracks'], [2, 'tracks'], [3, 'artwork']] as const) {
    const traces = tracesFor(index), sql = traces.filter(row => row.stage === `owner.sql.${kind}`)
    assert.deepEqual(sql.map(row => row.outcome), ['begin', 'ok']); assert.equal(traces.filter(row => row.stage === 'sql.run.enter').length, 1)
    assert.equal(traces.filter(row => row.stage === 'owner.return').length, 1); assert.ok(traces.every(row => row.firstStage === null))
  }
  const albumTraces = tracesFor(0), dtoIndex = albumTraces.findIndex(row => row.stage === 'owner.dto')
  assert.ok(dtoIndex >= 0); assert.equal(albumTraces[dtoIndex + 1]?.stage, 'owner.return')
  assert.ok(albumTraces[dtoIndex + 1]!.elapsedMs >= albumTraces[dtoIndex]!.elapsedMs)
  for (const index of [0, 1, 2, 3]) assert.equal(tracesFor(index).filter(row => row.stage === 'sql.derived').length, 0)
  assert.deepEqual(tracesFor(5).filter(row => row.stage === 'sql.derived').map(row => row.outcome), ['begin', 'ok'])
  assert.equal(tracesFor(4).filter(row => row.stage === 'owner.sql.tracks' && row.outcome === 'ok' || row.stage === 'owner.return').length, 0)
  assert.equal(tracesFor(4).find(row => row.outcome === 'reject')?.firstStage, 'owner.sql')
  const sample = emitted[0]!.trace
  for (const stage of timingStages) assert.ok(copyLocalAlbumSafeTrace({ ...sample, stage }))
  // 与Main原stdout接线相同的生产reader→collector→snapshot；不启动Main或真实Worker。
  // 六个Owner/SQL阶段来自上面实际emitter；两个Worker枚举只验证该运输闭集，非Worker执行证据。
  const pipeline = [...emitted.map(row => row.trace), ...(['worker.await', 'worker.post'] as const).map(stage => ({ ...sample, stage }))]
  const received: LocalAlbumSafeTrace[] = [], consume = createLocalAlbumSafeTraceReader(safe => { received.push(safe); collectLocalAlbumSafeTrace(safe) })
  for (const trace of pipeline) {
    const line = LOCAL_ALBUM_TRACE_PREFIX + JSON.stringify(trace) + '\n'; consume(line.slice(0, 17)); consume(line.slice(17))
  }
  assert.deepEqual(received, pipeline)
  const collected = snapshotLocalAlbumReadTrace(); assert.ok(copyLocalAlbumReadTraceSnapshot(collected))
  assert.deepEqual(collected.records.slice(-pipeline.length), pipeline)
  assert.ok(timingStages.every(stage => collected.records.some(row => row.stage === stage)))
  assert.equal(collected.firstRejects.find(row => row.traceSha256 === localAlbumTraceSha(ids[4]!))?.firstStage, 'owner.sql')
  for (const injected of [{ ...sample, stage: 'sql.derived.injected' }, { ...sample, path: 'private-path' }, { ...sample, request: { cookie: 'private-cookie' } }]) {
    assert.equal(copyLocalAlbumSafeTrace(injected), null); assert.equal(readLocalAlbumSafeTraceLine(LOCAL_ALBUM_TRACE_PREFIX + JSON.stringify(injected)), null)
    const line = LOCAL_ALBUM_TRACE_PREFIX + JSON.stringify(injected) + '\n', beforeRejected = snapshotLocalAlbumReadTrace(), accepted = received.length
    consume(line.slice(0, 11)); consume(line.slice(11))
    assert.equal(received.length, accepted); assert.deepEqual(snapshotLocalAlbumReadTrace(), beforeRejected)
  }
  // 毒行确实经过分块入口后，下一条合法记录仍按原管道交付；不靠dropped增量猜测拒绝是否执行。
  const tail = pipeline.at(-1)!, tailLine = LOCAL_ALBUM_TRACE_PREFIX + JSON.stringify(tail) + '\n'
  consume(tailLine.slice(0, 7)); consume(tailLine.slice(7)); assert.equal(received.length, pipeline.length + 1)
  assert.deepEqual(snapshotLocalAlbumReadTrace().records.at(-1), tail)
  assert.equal(captureLocalAlbumContext(), outerContext); assert.deepEqual(rows(f.file), before)
})

test('专辑原作者：同名不同目录独立，分页回读原trackId；浏览不创建发行、不扫描、不写封面', async t => {
  const f = await fixture(t), before = rows(f.file), page = await f.albums.queryAlbums(query)
  assert.equal(page.total, 2); assert.notEqual(page.items[0]!.id, page.items[1]!.id)
  for (const album of page.items) {
    assert.equal(album.editionId, null); assert.equal(album.artworkState, 'unknown'); assert.ok(!album.statuses.includes('missing-artwork'))
    const result = await f.albums.queryAlbumTracks({ albumKey: album.id, rootId: album.rootId, offset: 0, limit: 100 })
    assert.equal(result.total, 1); assert.equal(result.items[0]!.facts.track.id, album.representativeTrackId)
  }
  assert.deepEqual(rows(f.file), before)
  assert.ok(!JSON.stringify(page).includes(f.media)); assert.ok(!JSON.stringify(page).includes('song.wav'))
})

test('专辑原作者：覆盖字段更新后摘要刷新，离线保留浏览且不冒充ONLINE', async t => {
  const f = await fixture(t), before = await f.albums.queryAlbums(query), selected = before.items[0]!
  f.repository.localCatalog.overrideMetadata({ commandId: randomUUID(), trackId: selected.representativeTrackId!, expectedRevision: null,
    fields: { album: '合成展示修订' } })
  const after = await f.albums.queryAlbums(query)
  assert.equal(after.items.find(album => album.id === selected.id)?.title, '合成展示修订')
  await rename(f.media, path.join(f.directory, 'offline'))
  const offline = await f.albums.queryAlbums(query)
  assert.equal(offline.total, 2); assert.ok(offline.items.every(album => album.artworkState === 'source-unavailable'))
})

test('专辑只读图：无发行也实读独立PNG，保留源字节与作者表，目录/根切换拒绝旧捕获', async t => {
  const f = await fixture(t), page = await f.albums.queryAlbums(query), album = page.items[0]!, detail = f.repository.localCatalog.trackDetail(album.representativeTrackId!)
  const locator = f.repository.localCatalog.privateAssetLocator(detail.asset.id)
  const request: dto.LocalAlbumArtworkRequest = { albumKey: album.id, rootId: album.rootId, editionId: album.editionId, representativeTrackId: album.representativeTrackId, revision: album.revision }
  const context = { album, directory: path.posix.dirname(locator.relative), representative: { relative: locator.relative,
    summary: { track: detail.track, asset: detail.asset, metadata: detail.metadata.effective, versionTokens: detail.versionTokens }, rawMetadata: detail.metadata.raw, hasArtwork: false, artworkRevision: null } }
  const before = rows(f.file), result = await f.artwork.readSources({ request, context }, randomUUID())
  assert.equal(result.image, null); assert.equal(result.copies.status, 'ready')
  const copy = result.copies.items.find(item => item.origin === 'local-independent'); assert.ok(copy)
  assert.deepEqual(Buffer.from(copy.base64, 'base64'), f.png); assert.deepEqual(rows(f.file), before)
  assert.deepEqual(await readFile(path.join(f.media, context.directory, 'cover.png')), f.png)
  await f.artwork.revalidate(copy.sourceIdentity)
  await writeFile(path.join(f.media, context.directory, 'cover.png'), Buffer.concat([f.png, Buffer.from([1])]))
  await assert.rejects(f.artwork.revalidate(copy.sourceIdentity), /已改变/u)
  await assert.rejects(f.artwork.readSources({ request, context: { ...context, directory: '../other' } }, randomUUID()), /身份无效/u)
})

test('专辑已选图：原候选的图像字段在来源离线时仍可读取，读取不改原选择', async t => {
  const f = await fixture(t), track = f.tracks[0]!
  const jpeg = await readFile(new URL('./fixtures/mbrs012-source/owned-cover-16.jpg', import.meta.url))
  const digest = '555f7915442690ccb14754bd0da000ceadfbdcfb50b4e3402f55d4806e3e989d'
  assert.equal(jpeg.length, 960); assert.equal(createHash('sha256').update(jpeg).digest('hex'), digest)
  const info = { mime: 'image/jpeg' as const, bytes: jpeg.length, sha256: digest, width: 16, height: 16 }
  const image: dto.LocalArtworkImage = { original: info, display: { ...info, dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}` } }
  const edition = f.repository.localCatalog.createEdition({ commandId: randomUUID(), title: '合成已选图专辑', edition: '' })
  f.repository.localCatalog.linkEditionTrack({ commandId: randomUUID(), editionId: edition.id, trackId: track.id, disc: 1, trackNumber: 1, sequence: 1 })
  const target = f.repository.localArtwork.context({ trackId: track.id, editionId: edition.id }).target!
  const candidate = f.repository.localArtwork.stage({ target, origin: 'manual', sourceIdentity: digest, sourceLabel: '自有合成图片', image }).candidates[0]!
  const selection = f.repository.localArtwork.apply({ commandId: randomUUID(), target, candidateId: candidate.id, expectedSelectionRevision: null })
  await rename(f.media, path.join(f.directory, 'offline'))
  const page = await f.albums.queryAlbums(query), album = page.items.find(item => item.editionId === edition.id)!
  assert.ok(album); assert.equal(album.artworkState, 'available')
  const detail = f.repository.localCatalog.trackDetail(track.id), locator = f.repository.localCatalog.privateAssetLocator(detail.asset.id)
  const request: dto.LocalAlbumArtworkRequest = { albumKey: album.id, rootId: album.rootId, editionId: edition.id, representativeTrackId: track.id, revision: album.revision }
  const context = { album, directory: path.posix.dirname(locator.relative), representative: { relative: locator.relative,
    summary: { track: detail.track, asset: detail.asset, metadata: detail.metadata.effective, versionTokens: detail.versionTokens }, rawMetadata: detail.metadata.raw, hasArtwork: true, artworkRevision: selection.revision } }
  const before = rows(f.file), result = await f.artwork.readSources({ request, context }, randomUUID())
  assert.deepEqual(result, { image, copies: { status: 'ready', items: [] } }); assert.deepEqual(rows(f.file), before)
  assert.deepEqual(f.repository.localArtwork.context({ trackId: track.id, editionId: edition.id }).selection, selection)
})


// 组件行为：原Source许可、合成SQLite和真实只读FD；不证明Native解码、默认Owner或真实App。
import { open, type FileHandle } from 'node:fs/promises'
import { closeSync, fstatSync, openSync } from 'node:fs'
import type { LocalAlbumArtworkReadContext } from '../src/collection/local-album-browser/types.js'
import type { DatasetProjectionCommandResults } from '../src/collection/dataset-owner-protocol.js'
function albumArtworkTarget(f: Awaited<ReturnType<typeof fixture>>, album: dto.LocalAlbumSummary): { request: dto.LocalAlbumArtworkRequest; context: LocalAlbumArtworkReadContext } {
  const detail = f.repository.localCatalog.trackDetail(album.representativeTrackId!), locator = f.repository.localCatalog.privateAssetLocator(detail.asset.id)
  return { request: { albumKey: album.id, rootId: album.rootId, editionId: album.editionId, representativeTrackId: album.representativeTrackId, revision: album.revision },
    context: { album, directory: path.posix.dirname(locator.relative), representative: { relative: locator.relative,
      summary: { track: detail.track, asset: detail.asset, metadata: detail.metadata.effective, versionTokens: detail.versionTokens }, rawMetadata: detail.metadata.raw, hasArtwork: false, artworkRevision: null } } }
}
function releaseGate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
// 证明绑定原FileHandle的真实close；旧FD整数随后可以被独立SQLite或其他文件复用。
function observeActualFileClose(handle: FileHandle) {
  const ownDescriptor = Object.getOwnPropertyDescriptor(handle, 'close'), fd = handle.fd, opened = fstatSync(fd, { bigint: true })
  const identity = { dev: opened.dev, ino: opened.ino }
  let owner: object | null = handle, closeDescriptor: PropertyDescriptor | undefined
  while (owner && !closeDescriptor) { closeDescriptor = Object.getOwnPropertyDescriptor(owner, 'close'); owner = Object.getPrototypeOf(owner) as object | null }
  assert.ok(closeDescriptor && Object.hasOwn(closeDescriptor, 'value') && typeof closeDescriptor.value === 'function')
  const nativeClose = closeDescriptor.value as (this: FileHandle, ...args: unknown[]) => Promise<void>
  let completed = false, proofFailure: unknown, restored = false
  function observedClose(this: FileHandle, ...args: unknown[]): Promise<void> {
    const work = Reflect.apply(nativeClose, this, args) as Promise<void>
    return work.then(() => {
      if (completed) return
      completed = true
      try {
        assert.equal(handle.fd, -1)
        assert.throws(() => fstatSync(fd), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'EBADF')
      } catch (error) { proofFailure = error }
    })
  }
  Object.defineProperty(observedClose, 'length', { value: nativeClose.length }); Object.defineProperty(observedClose, 'name', { value: nativeClose.name })
  Object.defineProperty(handle, 'close', { ...(ownDescriptor ?? { configurable: true, enumerable: false, writable: true }), value: observedClose })
  return { fd, identity,
    assertClosed() {
      if (proofFailure !== undefined) throw proofFailure
      assert.equal(completed, true, '原native close尚未成功完成。'); assert.equal(handle.fd, -1)
      let current: { dev: bigint; ino: bigint }
      try { const stat = fstatSync(fd, { bigint: true }); current = stat }
      catch (error) { if (error instanceof Error && 'code' in error && error.code === 'EBADF') return; throw error }
      assert.notDeepEqual({ dev: current.dev, ino: current.ino }, identity, '旧FD仍指向原来源，不能当作不同文件复用。')
    },
    restore() {
      if (restored) return
      if (ownDescriptor) Object.defineProperty(handle, 'close', ownDescriptor)
      else assert.equal(Reflect.deleteProperty(handle, 'close'), true)
      assert.deepEqual(Object.getOwnPropertyDescriptor(handle, 'close'), ownDescriptor); restored = true
    } }
}
async function holdActualCoverReads(f: Awaited<ReturnType<typeof fixture>>, wanted = 2) {
  const probe = await open(path.join(f.media, 'one', 'cover.png'), 'r'), prototype = Object.getPrototypeOf(probe) as object
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'read')!; assert.equal(typeof descriptor.value, 'function'); await probe.close()
  const nativeRead = descriptor.value as (this: FileHandle, ...args: unknown[]) => Promise<unknown>, reached = releaseGate()
  const held: Array<{ handle: FileHandle; fd: number; gate: ReturnType<typeof releaseGate>; close: ReturnType<typeof observeActualFileClose> }> = []; let sourceReads = 0, released = false
  function observedRead(this: FileHandle, ...args: unknown[]): Promise<unknown> {
    const work = Reflect.apply(nativeRead, this, args) as Promise<unknown>, buffer = args[0]
    if (!(buffer instanceof Uint8Array) || buffer.byteLength !== f.png.length) return work
    return work.then(async result => {
      if (!Buffer.from(buffer).equals(f.png)) return result
      sourceReads++
      if (held.length < wanted) {
        const gate = releaseGate(), close = observeActualFileClose(this); held.push({ handle: this, fd: this.fd, gate, close }); if (held.length === wanted) reached.resolve()
        if (!released) await gate.promise
      }
      return result
    })
  }
  Object.defineProperty(observedRead, 'length', { value: descriptor.value.length }); Object.defineProperty(observedRead, 'name', { value: descriptor.value.name })
  Object.defineProperty(prototype, 'read', { ...descriptor, value: observedRead })
  let restored = false
  return { held, reached: reached.promise, sourceReads: () => sourceReads,
    releaseAll() { released = true; for (const row of held) row.gate.resolve() },
    restore() {
      if (restored) return
      const errors: unknown[] = []
      try { Object.defineProperty(prototype, 'read', descriptor); assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, 'read'), descriptor) } catch (error) { errors.push(error) }
      for (const row of held) { try { row.close.restore() } catch (error) { errors.push(error) } }
      if (errors.length) throw new AggregateError(errors, '真实FD观察器未全部恢复。', { cause: errors[0] })
      restored = true
    } }
}
function observeActualAdmission(f: Awaited<ReturnType<typeof fixture>>) {
  const original = f.projection.call.bind(f.projection), deferred = releaseGate(), events: Array<{ command: string; status?: string; atMs: number }> = []
  f.projection.call = async (command, payload) => {
    const value = await original(command, payload), atMs = performance.now()
    if (command === 'scanReadAcquire') { const status = (value as DatasetProjectionCommandResults['scanReadAcquire']).status; events.push({ command, status, atMs }); if (status === 'deferred') deferred.resolve() }
    else if (command === 'scanReadRelease') events.push({ command, atMs })
    return value
  }
  return { events, deferred: deferred.promise, acquires: () => events.filter(row => row.command === 'scanReadAcquire').map(row => row.status), restore() { f.projection.call = original } }
}
function assertActualCoverFdsClosed(held: Awaited<ReturnType<typeof holdActualCoverReads>>, wanted = 2): void {
  assert.equal(held.held.length, wanted)
  for (const row of held.held) row.close.assertClosed()
}

test('专辑真实FD闭口证明：未关闭源拒绝，原close完成后不同文件复用仍可核验', async t => {
  assert.ok(process.env.TMPDIR?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'))
  const directory = await mkdtemp(path.join(process.env.TMPDIR!, 'mbf-cover-fd-proof-'))
  let source: FileHandle | undefined, proof: ReturnType<typeof observeActualFileClose> | undefined, replacementFd: number | undefined
  t.after(async () => {
    const errors: unknown[] = []
    try { if (replacementFd !== undefined) closeSync(replacementFd) } catch (error) { errors.push(error) }
    try { if (source && source.fd !== -1) await source.close() } catch (error) { errors.push(error) }
    try { proof?.restore() } catch (error) { errors.push(error) }
    try { await rm(directory, { recursive: true }) } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, '真实FD闭口证明测试未全部收口。', { cause: errors[0] })
  })
  const originalFile = path.join(directory, 'source.bin'), replacementFile = path.join(directory, 'replacement.bin')
  await writeFile(originalFile, '合成来源'); await writeFile(replacementFile, '独立替代文件')
  source = await open(originalFile, 'r'); proof = observeActualFileClose(source)
  const opened = fstatSync(proof.fd, { bigint: true }); assert.deepEqual({ dev: opened.dev, ino: opened.ino }, proof.identity)
  assert.throws(() => proof!.assertClosed(), /原native close尚未成功完成/u)
  await source.close(); proof.assertClosed()
  replacementFd = openSync(replacementFile, 'r'); assert.equal(replacementFd, proof.fd, '控制例必须实际复用原FD整数。')
  const replacement = fstatSync(replacementFd, { bigint: true }); assert.notDeepEqual({ dev: replacement.dev, ino: replacement.ino }, proof.identity)
  proof.assertClosed(); assert.equal(source.fd, -1)
})

test('专辑许可旁注：原ALS与许可返回值关联，正常无许可及后续拒绝恢复原stage', async t => {
  // 仅诊断行为：合成忙碌输入、真实Admission和readSources；不重证runtime机制或Main解码。
  const originalInfo = console.info, outerContext = captureLocalAlbumContext()
  let restoreProjection = () => {}, busy = false, failSink = false, sinkFailures = 0
  t.after(async () => {
    const errors: unknown[] = []
    try { console.info = originalInfo } catch (error) { errors.push(error) }
    try { await restoreProjection() } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, '专辑许可旁注测试恢复未全部确认。', { cause: errors[0] })
  })
  const f = await fixture(t, undefined, () => busy), page = await f.albums.queryAlbums(query), target = albumArtworkTarget(f, page.items[0]!), before = rows(f.file)
  const acquired: Array<{ before: LocalAlbumNodeContext | undefined; after: LocalAlbumNodeContext | undefined; stage: string | undefined;
    value: DatasetProjectionCommandResults['scanReadAcquire']; snapshot: DatasetProjectionCommandResults['scanReadAcquire'] }> = []
  const originalCall = f.projection.call
  restoreProjection = () => { f.projection.call = originalCall }
  f.projection.call = async (command, payload) => {
    const context = captureLocalAlbumContext(), value = await originalCall.call(f.projection, command, payload)
    if (command === 'scanReadAcquire') {
      const result = value as DatasetProjectionCommandResults['scanReadAcquire']
      acquired.push({ before: context, after: captureLocalAlbumContext(), stage: captureLocalAlbumContext()?.stage, value: result, snapshot: structuredClone(result) })
    }
    return value as never
  }
  const emitted: Array<{ args: unknown[]; context: LocalAlbumNodeContext | undefined; stage: string | undefined }> = []
  const sinkError = new Error('合成诊断输出失败，不得进入业务结果')
  console.info = (...args: unknown[]) => {
    const context = captureLocalAlbumContext(); emitted.push({ args, context, stage: context?.stage })
    if (failSink && typeof args[0] === 'string' && args[0].includes('"stage":"localAlbum.artwork.')) { sinkFailures++; throw sinkError }
  }
  const grantedId = randomUUID(), deferredId = randomUUID(), parentSha = localAlbumTraceSha(randomUUID())
  let grantedContext: LocalAlbumNodeContext | undefined, deferredContext: LocalAlbumNodeContext | undefined
  const granted = await runLocalAlbumContext(grantedId, parentSha, 'owner.artwork', async () => {
    grantedContext = captureLocalAlbumContext(); assert.ok(grantedContext)
    const result = await f.artwork.readSources(target, grantedId, undefined, undefined, 'display')
    assert.equal(captureLocalAlbumContext(), grantedContext); assert.equal(grantedContext.stage, 'owner.artwork'); assert.equal(grantedContext.first, null)
    assert.equal(localAlbumTerminal('ok')?.stage, 'owner.artwork')
    return result
  }, true)
  assert.equal(granted.copies.status, 'ready'); assert.equal(granted.image, null)
  const png = granted.copies.items.find(item => item.origin === 'local-independent'); assert.ok(png)
  assert.deepEqual(Buffer.from(png.base64, 'base64'), f.png)
  busy = true; failSink = true
  const businessError = Object.assign(new Error('合成后续业务拒绝，不应出现在旁注'), { name: 'LocalAlbumReadError', code: 'SNAPSHOT_CHANGED' })
  await assert.rejects(runLocalAlbumContext(deferredId, parentSha, 'owner.artwork', async () => {
    deferredContext = captureLocalAlbumContext(); assert.ok(deferredContext)
    const result = await f.artwork.readSources(target, deferredId, undefined, undefined, 'display')
    assert.deepEqual(result, { image: null, copies: { status: 'source-unavailable', items: [] } })
    assert.equal(captureLocalAlbumContext(), deferredContext); assert.equal(deferredContext.stage, 'owner.artwork'); assert.equal(deferredContext.first, null)
    // 原正常读取完成后的调用方拒绝；不注入新的Source/Native故障。
    try { throw businessError } catch (error) {
      localAlbumReject(error, 'UNAVAILABLE')
      const terminal = localAlbumTerminal('reject', 'UNAVAILABLE'); assert.ok(terminal)
      assert.equal(terminal.stage, 'owner.artwork'); assert.equal(terminal.firstStage, 'owner.artwork'); assert.equal(terminal.code, 'SNAPSHOT_CHANGED')
      throw error
    }
  }, true), error => error === businessError)
  assert.equal(captureLocalAlbumContext(), outerContext); assert.equal(sinkFailures, 2)
  assert.deepEqual(acquired.map(row => row.value.status), ['granted', 'deferred'])
  for (const [index, context] of [grantedContext, deferredContext].entries()) {
    assert.ok(context); assert.equal(acquired[index]!.before, context); assert.equal(acquired[index]!.after, context)
    assert.equal(acquired[index]!.stage, 'owner.artwork'); assert.deepEqual(acquired[index]!.value, acquired[index]!.snapshot)
    assert.equal(context.traceSha256, localAlbumTraceSha(index === 0 ? grantedId : deferredId)); assert.equal(context.parentSha256, parentSha)
  }
  const traces = emitted.map(row => {
    assert.equal(row.args.length, 1); const line = row.args[0]; assert.equal(typeof line, 'string')
    assert.ok((line as string).startsWith(LOCAL_ALBUM_TRACE_PREFIX)); assert.ok((line as string).length <= 2048)
    const safe = copyLocalAlbumSafeTrace(JSON.parse((line as string).slice(LOCAL_ALBUM_TRACE_PREFIX.length))); assert.ok(safe)
    assert.equal(row.stage, safe.stage); assert.equal(row.context?.traceSha256, safe.traceSha256); assert.equal(safe.parentSha256, parentSha); assert.equal(safe.preloadAssociated, true)
    return safe
  })
  const permitNotes = traces.filter(row => row.stage.startsWith('localAlbum.artwork.'))
  assert.deepEqual(permitNotes.map(row => [row.stage, row.traceSha256]), [
    ['localAlbum.artwork.permit-granted', localAlbumTraceSha(grantedId)],
    ['localAlbum.artwork.permit-deferred', localAlbumTraceSha(deferredId)],
    ['localAlbum.artwork.no-permit-unavailable', localAlbumTraceSha(deferredId)],
  ])
  assert.ok(permitNotes.every(row => row.outcome === 'ok' && row.firstStage === null && row.code === 'UNKNOWN' && row.name === 'UNKNOWN'))
  const rejected = traces.filter(row => row.outcome === 'reject'); assert.equal(rejected.length, 1)
  assert.equal(rejected[0]!.traceSha256, localAlbumTraceSha(deferredId)); assert.equal(rejected[0]!.firstStage, 'owner.artwork')
  const raw = emitted.map(row => row.args[0]).join('\n')
  for (const privateText of [grantedId, deferredId, f.media, businessError.message, sinkError.message]) assert.equal(raw.includes(privateText), false)
  assert.deepEqual(f.admission.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: false }); assert.deepEqual(rows(f.file), before)
})

test('专辑临时许可：真实两票FD未退出时第三请求deferred，原释放后一次再准入并保源与SQL', async t => {
  let held: Awaited<ReturnType<typeof holdActualCoverReads>> | undefined
  t.after(() => { held?.releaseAll(); held?.restore() })
  const f = await fixture(t), observed = observeActualAdmission(f); t.after(observed.restore)
  held = await holdActualCoverReads(f)
  const page = await f.albums.queryAlbums(query), left = albumArtworkTarget(f, page.items[0]!), right = albumArtworkTarget(f, page.items[1]!), before = rows(f.file)
  const firstId = randomUUID(), first = f.artwork.readSources(left, firstId), second = f.artwork.readSources(right, randomUUID())
  await Promise.race([held.reached, Promise.all([first, second]).then(() => { throw new Error('未形成两个真实读取FD活动窗口。') })])
  assert.equal(f.admission.resourceCounts().permits, 2); assert.ok(held.held.every(row => row.fd >= 0 && row.handle.fd === row.fd))
  assert.throws(() => f.artwork.readSources(left, firstId), /请求已满或身份无效/u)
  const beganAtMs = performance.now(), third = f.artwork.readSources(left, randomUUID(), new AbortController().signal, beganAtMs + 2000)
  await observed.deferred; assert.deepEqual(observed.acquires(), ['granted', 'granted', 'deferred']); assert.equal(held.sourceReads(), 2)
  held.releaseAll(); const results = await Promise.all([first, second, third])
  assert.ok(performance.now() < beganAtMs + 2000); assert.deepEqual(observed.acquires(), ['granted', 'granted', 'deferred', 'granted'])
  const granted = observed.events.filter(row => row.command === 'scanReadAcquire' && row.status === 'granted').at(-1)!
  assert.ok(observed.events.some(row => row.command === 'scanReadRelease' && row.atMs <= granted.atMs))
  for (const result of results) { assert.equal(result.copies.status, 'ready'); assert.deepEqual(Buffer.from(result.copies.items.find(row => row.origin === 'local-independent')!.base64, 'base64'), f.png) }
  assertActualCoverFdsClosed(held); assert.equal(f.admission.resourceCounts().permits, 0); assert.equal(f.admission.resourceCounts().watches, 0)
  assert.deepEqual(rows(f.file), before); for (const dir of ['one', 'two']) assert.deepEqual(await readFile(path.join(f.media, dir, 'cover.png')), f.png)
})

test('专辑临时许可：等待取消不续准入，过期与外部持票仍不可用且不读取新FD', async t => {
  let held: Awaited<ReturnType<typeof holdActualCoverReads>> | undefined
  t.after(() => { held?.releaseAll(); held?.restore() })
  const f = await fixture(t), observed = observeActualAdmission(f); t.after(observed.restore); held = await holdActualCoverReads(f)
  const page = await f.albums.queryAlbums(query), left = albumArtworkTarget(f, page.items[0]!), right = albumArtworkTarget(f, page.items[1]!), before = rows(f.file)
  const first = f.artwork.readSources(left, randomUUID()), second = f.artwork.readSources(right, randomUUID())
  await Promise.race([held.reached, Promise.all([first, second]).then(() => { throw new Error('未形成两个真实读取FD活动窗口。') })])
  const stop = new AbortController(), waiting = f.artwork.readSources(left, randomUUID(), stop.signal, performance.now() + 2000)
  await observed.deferred; stop.abort(); assert.equal((await waiting).copies.status, 'source-unavailable')
  assert.deepEqual(observed.acquires(), ['granted', 'granted', 'deferred']); assert.equal(held.sourceReads(), 2); assert.equal(f.admission.resourceCounts().permits, 2)
  held.releaseAll(); await Promise.all([first, second]); assertActualCoverFdsClosed(held); assert.equal(f.admission.resourceCounts().permits, 0)
  const acquiredBefore = observed.acquires().length, readBefore = held.sourceReads()
  assert.equal((await f.artwork.readSources(left, randomUUID(), undefined, performance.now() - 1)).copies.status, 'source-unavailable')
  const alreadyStopped = new AbortController(); alreadyStopped.abort(); assert.equal((await f.artwork.readSources(left, randomUUID(), alreadyStopped.signal)).copies.status, 'source-unavailable')
  assert.equal(observed.acquires().length, acquiredBefore); assert.equal(held.sourceReads(), readBefore)
  const external = [f.admission.acquire(f.scope), f.admission.acquire(f.scope)]; assert.ok(external.every(row => row.status === 'granted'))
  assert.equal((await f.artwork.readSources(left, randomUUID(), new AbortController().signal, performance.now() + 2000)).copies.status, 'source-unavailable')
  assert.equal(observed.acquires().length, acquiredBefore + 1); assert.equal(held.sourceReads(), readBefore)
  for (const permit of external) { assert.equal(permit.status, 'granted'); if (permit.status === 'granted') f.admission.release(f.scope, permit.permitId) }
  assert.equal(f.admission.resourceCounts().permits, 0); assert.deepEqual(rows(f.file), before)
})

test('专辑临时许可：原库撤销取消等待与活动读取，真实FD闭后不重获许可或写作者表', async t => {
  let held: Awaited<ReturnType<typeof holdActualCoverReads>> | undefined
  t.after(() => { held?.releaseAll(); held?.restore() })
  const f = await fixture(t), observed = observeActualAdmission(f); t.after(observed.restore); held = await holdActualCoverReads(f)
  const page = await f.albums.queryAlbums(query), left = albumArtworkTarget(f, page.items[0]!), right = albumArtworkTarget(f, page.items[1]!), before = rows(f.file)
  const first = f.artwork.readSources(left, randomUUID()), second = f.artwork.readSources(right, randomUUID())
  await Promise.race([held.reached, Promise.all([first, second]).then(() => { throw new Error('未形成两个真实读取FD活动窗口。') })])
  const third = f.artwork.readSources(left, randomUUID(), new AbortController().signal, performance.now() + 2000), joined = Promise.allSettled([first, second, third])
  await observed.deferred; const removing = f.artwork.removeLibrary(f.root.id)
  await assert.rejects(third, /已撤销/u); assert.equal(held.sourceReads(), 2); assert.deepEqual(observed.acquires(), ['granted', 'granted', 'deferred'])
  held.releaseAll(); await removing; const settled = await joined; assert.ok(settled.every(row => row.status === 'rejected'))
  assertActualCoverFdsClosed(held); assert.equal(f.admission.resourceCounts().permits, 0); assert.equal(f.admission.resourceCounts().watches, 0)
  await assert.rejects(f.artwork.readSources(left, randomUUID()), /已撤销/u); assert.deepEqual(rows(f.file), before)
})


test('专辑临时许可：真实FD关闭但release回声失败仍fatal，等待者不得被改成可用或继续准入', async t => {
  let held: Awaited<ReturnType<typeof holdActualCoverReads>> | undefined
  t.after(() => { held?.releaseAll(); held?.restore() })
  const f = await fixture(t, /资源关闭未确认/u), actual = f.projection.call.bind(f.projection); let loseReply = true
  // 实际Admission先release；仅丢弃本次传输回声，不假造任何FD关闭或许可成功。
  f.projection.call = async (command, payload) => {
    const result = await actual(command, payload)
    if (command === 'scanReadRelease' && loseReply) { loseReply = false; throw new Error('合成许可释放回声丢失') }
    return result
  }
  const observed = observeActualAdmission(f); t.after(observed.restore); held = await holdActualCoverReads(f)
  const page = await f.albums.queryAlbums(query), left = albumArtworkTarget(f, page.items[0]!), right = albumArtworkTarget(f, page.items[1]!), before = rows(f.file)
  const first = f.artwork.readSources(left, randomUUID()), second = f.artwork.readSources(right, randomUUID())
  await Promise.race([held.reached, Promise.all([first, second]).then(() => { throw new Error('未形成两个真实读取FD活动窗口。') })])
  const third = f.artwork.readSources(left, randomUUID(), new AbortController().signal, performance.now() + 2000), joined = Promise.allSettled([first, second, third])
  await observed.deferred; held.releaseAll(); await assert.rejects(third, /读取已停止/u)
  const settled = await joined; assert.equal(settled[0]!.status, 'rejected'); assert.equal(settled[2]!.status, 'rejected')
  assert.deepEqual(observed.acquires(), ['granted', 'granted', 'deferred']); assertActualCoverFdsClosed(held)
  assert.equal(f.admission.resourceCounts().permits, 0); assert.equal(f.admission.resourceCounts().watches, 0)
  await assert.rejects(f.artwork.close(), /资源关闭未确认/u); assert.throws(() => f.artwork.readSources(left, randomUUID()), /读取已停止/u)
  assert.deepEqual(rows(f.file), before)
})


test('专辑临时许可：同原单调截止贯穿迟到授票与FD读取回核发布，超期不返回可用图', async t => {
  for (const boundary of ['grant', 'read', 'release'] as const) {
    let held: Awaited<ReturnType<typeof holdActualCoverReads>> | undefined
    t.after(() => { held?.releaseAll(); held?.restore() })
    const f = await fixture(t), page = await f.albums.queryAlbums(query), target = albumArtworkTarget(f, page.items[0]!), before = rows(f.file)
    held = await holdActualCoverReads(f, 1)
    const original = f.projection.call.bind(f.projection); t.after(() => { f.projection.call = original })
    let delayedAtMs: number | undefined, deadlineAtMs = 0, delayUsed = false
    const deadlineReached = () => new Promise<void>(resolve => setTimeout(resolve, Math.max(1, Math.ceil(deadlineAtMs - performance.now()) + 1)))
    // 只让本次真实单调截止经过；不改时钟、不增加期限，不伪造许可/FD或Native结果。
    f.projection.call = async (command, payload) => {
      const result = await original(command, payload)
      if (!delayUsed && (boundary === 'grant' && command === 'scanReadAcquire' && (result as DatasetProjectionCommandResults['scanReadAcquire']).status === 'granted'
        || boundary === 'release' && command === 'scanReadRelease')) {
        delayUsed = true; delayedAtMs = performance.now(); await deadlineReached()
      }
      return result
    }
    const acceptedAtMs = performance.now(); deadlineAtMs = acceptedAtMs + 500
    const reading = f.artwork.readSources(target, randomUUID(), new AbortController().signal, deadlineAtMs)
    const rejected = assert.rejects(reading, /取消或超时/u)
    if (boundary === 'grant') {
      // 截止已过后解除合成屏障，旧实现的错误迟到FD也必须能自然收口。
      await deadlineReached(); held.releaseAll()
    } else if (boundary === 'read') {
      await Promise.race([held.reached, reading.then(() => { throw new Error('未形成真实期限内读取FD窗口。') })])
      delayedAtMs = performance.now(); assert.ok(delayedAtMs < deadlineAtMs); await deadlineReached(); held.releaseAll()
    } else if (boundary === 'release') {
      await Promise.race([held.reached, reading.then(() => { throw new Error('未形成真实期限内读取FD窗口。') })]); held.releaseAll()
    }
    await rejected
    assert.ok(performance.now() >= deadlineAtMs); assert.ok(delayedAtMs !== undefined && delayedAtMs < deadlineAtMs, '必须确实跨越该原期限，不把前置失败当边界覆盖')
    if (boundary === 'grant') { assert.equal(held.sourceReads(), 0); assert.equal(held.held.length, 0) }
    else assertActualCoverFdsClosed(held, 1)
    assert.equal(f.admission.resourceCounts().permits, 0); assert.equal(f.admission.resourceCounts().watches, 0); assert.equal(f.admission.resourceCounts().timers, 0)
    assert.deepEqual(rows(f.file), before); assert.deepEqual(await readFile(path.join(f.media, target.context.directory!, 'cover.png')), f.png)
  }
})

// 组件回归：65个自有单封面目录、原Source授权/SQLite/实际reader/两票Admission与真实FD；不授Main解码或默认Owner资格。
async function displaySourceFixture(t: test.TestContext) {
  const f = await fixture(t), audio = await readFile(new URL('./fixtures/mbrs003/audio/fixtures/core-wav.wav', import.meta.url))
  const picture = await readFile(new URL('./fixtures/mbrs012-source/owned-cover-16.jpg', import.meta.url))
  const digest = '555f7915442690ccb14754bd0da000ceadfbdcfb50b4e3402f55d4806e3e989d'
  assert.equal(picture.length, 960); assert.equal(createHash('sha256').update(picture).digest('hex'), digest)
  const directories = ['one', 'two', ...Array.from({ length: 63 }, (_, index) => `self-${String(index + 3).padStart(2, '0')}`)]
  for (const [index, directory] of directories.entries()) {
    if (index < 2) await rm(path.join(f.media, directory, 'cover.png'))
    else {
      await mkdir(path.join(f.media, directory)); await writeFile(path.join(f.media, directory, 'song.wav'), audio)
      const asset = f.repository.localCatalog.registerAsset({ commandId: randomUUID(), libraryRootId: f.root.id, expectedRootRevision: f.root.revision,
        relative: `${directory}/song.wav`, sha256: null, sampleFrames: null, timebaseHz: null })
      const track = f.repository.localCatalog.createTrack({ commandId: randomUUID(), assetId: asset.id, segment: null })
      f.repository.localCatalog.observeMetadata({ commandId: randomUUID(), trackId: track.id, source: 'synthetic', parserVersion: 'mbf-synthetic-v1',
        fields: { title: '合成歌曲', artist: '合成作者', album: '同名合成专辑' } })
    }
    await writeFile(path.join(f.media, directory, 'cover.jpg'), picture)
  }
  const page = await f.albums.queryAlbums({ ...query, limit: 200 })
  assert.equal(page.total, 65); assert.equal(page.items.length, 65); assert.equal(new Set(page.items.map(album => album.id)).size, 65)
  assert.ok(page.items.every(album => album.editionId === null && album.trackCount === 1))
  const targets = page.items.map(album => albumArtworkTarget(f, album))
  assert.deepEqual(targets.map(target => target.context.directory).sort(), [...directories].sort())
  const info = { mime: 'image/jpeg' as const, bytes: picture.length, sha256: digest, width: 16, height: 16 }
  // 已有合法JPEG的DTO夹具只用于原SQL存储行为；不是对Main/nativeImage规范化的替代证明。
  const image: dto.LocalArtworkImage = { original: info, display: { ...info, dataUrl: `data:image/jpeg;base64,${picture.toString('base64')}` } }
  assert.ok(dto.isLocalArtworkImage(image))
  return { ...f, audio, picture, directories, targets, image }
}
async function observeDisplaySourceFds(f: Awaited<ReturnType<typeof displaySourceFixture>>, holdFirst = false) {
  const probe = await open(path.join(f.media, 'one', 'cover.jpg'), 'r'), prototype = Object.getPrototypeOf(probe) as object
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'read')!; assert.equal(typeof descriptor.value, 'function'); await probe.close()
  const actualRead = descriptor.value as (this: FileHandle, ...args: unknown[]) => Promise<unknown>
  const observed: Array<{ handle: FileHandle; fd: number }> = [], errors: unknown[] = [], reached = releaseGate(), release = releaseGate()
  let checked = 0, restored = false, released = false
  const replacement = { read(this: FileHandle, ...args: unknown[]): Promise<unknown> {
    const work = Reflect.apply(actualRead, this, args) as Promise<unknown>, bytes = args[0]
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== f.picture.length) return work
    const record = (): boolean => {
      if (!Buffer.from(bytes).equals(f.picture)) return false
      const row = { handle: this, fd: this.fd }; observed.push(row)
      const stat = fstatSync(row.fd); assert.ok(row.fd >= 0 && stat.isFile()); assert.equal(stat.size, f.picture.length)
      if (observed.length === 1) reached.resolve()
      return true
    }
    if (holdFirst) return work.then(async result => { if (record() && observed.length === 1 && !released) await release.promise; return result })
    // 被动观察保原读取Promise；只在该真实读取回包时记录原FD，不制造或替换关闭回声。
    void work.then(() => { record() }, () => {}).catch(error => { errors.push(error) })
    return work
  } }.read
  Object.defineProperty(replacement, 'length', { value: descriptor.value.length }); Object.defineProperty(replacement, 'name', { value: descriptor.value.name })
  assert.equal(replacement.length, descriptor.value.length); assert.equal(replacement.name, descriptor.value.name)
  Object.defineProperty(prototype, 'read', { ...descriptor, value: replacement })
  return { observed, reached: reached.promise,
    releaseAll() { released = true; release.resolve() },
    assertClosedSinceLast() {
      assert.deepEqual(errors, []); const fresh = observed.slice(checked); assert.equal(fresh.length, 1)
      // 在任何下一次open之前逐件核数值FD，避免复用数值把真正关闭判断掩盖。
      for (const row of fresh) { assert.equal(row.handle.fd, -1); assert.throws(() => fstatSync(row.fd), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'EBADF') }
      checked = observed.length
      const resources = f.admission.resourceCounts(); assert.equal(resources.permits, 0); assert.equal(resources.watches, 0); assert.equal(resources.timers, 0)
    },
    restore() { if (restored) return; restored = true; Object.defineProperty(prototype, 'read', descriptor); assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, 'read'), descriptor) },
  }
}
async function readDisplaySource(f: Awaited<ReturnType<typeof displaySourceFixture>>, target: ReturnType<typeof albumArtworkTarget>,
  observed: Awaited<ReturnType<typeof observeDisplaySourceFds>>, mode: 'candidate' | 'display' = 'candidate') {
  const beganAtMs = performance.now()
  let result: Awaited<ReturnType<typeof f.artwork.readSources>>
  try { result = await f.artwork.readSources(target, randomUUID(), new AbortController().signal, beganAtMs + 2000, mode) }
  finally { observed.assertClosedSinceLast() }
  assert.ok(performance.now() < beganAtMs + 2000); assert.equal(result.image, null); assert.equal(result.copies.status, 'ready'); assert.equal(result.copies.items.length, 1)
  const copy = result.copies.items[0]!; assert.equal(copy.origin, 'local-independent'); assert.equal(copy.sourceLabel, 'cover.jpg')
  assert.deepEqual(Buffer.from(copy.base64, 'base64'), f.picture); return copy
}
async function assertDisplaySourcesUnchanged(f: Awaited<ReturnType<typeof displaySourceFixture>>) {
  for (const directory of f.directories) {
    assert.deepEqual(await readFile(path.join(f.media, directory, 'cover.jpg')), f.picture)
    assert.deepEqual(await readFile(path.join(f.media, directory, 'song.wav')), f.audio)
  }
}

test('专辑显示瞬时：满64候选后65目录仍实读显示，原候选回核与MB_ONLY存储保留且候选上限不增', async t => {
  let observed: Awaited<ReturnType<typeof observeDisplaySourceFds>> | undefined
  t.after(() => { observed?.releaseAll(); observed?.restore() })
  const f = await displaySourceFixture(t), before = rows(f.file); observed = await observeDisplaySourceFds(f)
  const retained: dto.LocalArtworkSourceCopies['items'] = []
  for (const target of f.targets.slice(0, 64)) retained.push(await readDisplaySource(f, target, observed))
  assert.equal(new Set(retained.map(copy => copy.sourceIdentity)).size, 64)
  await assert.rejects(readDisplaySource(f, f.targets[64]!, observed), /缓存已满/u)
  const displayed: dto.LocalArtworkSourceCopies['items'] = []
  for (const target of f.targets) displayed.push(await readDisplaySource(f, target, observed, 'display'))
  assert.equal(displayed.length, 65); assert.equal(new Set(displayed.map(copy => copy.sourceIdentity)).size, 65)
  for (const [index, copy] of retained.entries()) { assert.equal(displayed[index]!.sourceIdentity, copy.sourceIdentity); await f.artwork.revalidate(copy.sourceIdentity) }
  await assert.rejects(f.artwork.revalidate(displayed[64]!.sourceIdentity), /捕获已过期/u)
  await assert.rejects(readDisplaySource(f, f.targets[64]!, observed), /缓存已满/u)
  assert.equal(observed.observed.length, 131); assert.deepEqual(rows(f.file), before)
  const trackId = f.targets[0]!.request.representativeTrackId!, copy = retained[0]!
  const edition = f.repository.localCatalog.createEdition({ commandId: randomUUID(), title: '自有原候选保存', edition: '' })
  f.repository.localCatalog.linkEditionTrack({ commandId: randomUUID(), editionId: edition.id, trackId, disc: 1, trackNumber: 1, sequence: 1 })
  // 原显式候选在65次显示后仍经过同reader真实Source签名回核，再进原SQL stage/apply；不授Native或Source写资格。
  await f.artwork.revalidate(copy.sourceIdentity)
  const target = f.repository.localArtwork.context({ trackId, editionId: edition.id }).target!
  const candidate = f.repository.localArtwork.stage({ target, origin: copy.origin, sourceIdentity: copy.sourceIdentity, sourceLabel: copy.sourceLabel, image: f.image }).candidates[0]!
  const command = { commandId: randomUUID(), target, candidateId: candidate.id, expectedSelectionRevision: null }
  const selection = f.repository.localArtwork.apply(command)
  assert.equal(selection.candidate?.id, candidate.id); assert.equal(selection.candidate?.sourceIdentity, copy.sourceIdentity)
  assert.deepEqual(f.repository.localArtwork.apply(command), selection)
  assert.deepEqual(f.repository.localArtwork.context({ trackId, editionId: edition.id }).selection, selection)
  assert.equal(rows(f.file).find(row => row[0] === 'local_scan_jobs')![1], before.find(row => row[0] === 'local_scan_jobs')![1])
  await assertDisplaySourcesUnchanged(f)
})

test('专辑显示瞬时：65显示不发布长期捕获，之后仍可保留64显式候选而第65按原上限拒绝', async t => {
  let observed: Awaited<ReturnType<typeof observeDisplaySourceFds>> | undefined
  t.after(() => { observed?.releaseAll(); observed?.restore() })
  const f = await displaySourceFixture(t), before = rows(f.file); observed = await observeDisplaySourceFds(f)
  for (const target of f.targets) {
    const displayed = await readDisplaySource(f, target, observed, 'display')
    await assert.rejects(f.artwork.revalidate(displayed.sourceIdentity), /捕获已过期/u)
  }
  const retained: dto.LocalArtworkSourceCopies['items'] = []
  for (const target of f.targets.slice(0, 64)) retained.push(await readDisplaySource(f, target, observed))
  for (const copy of retained) await f.artwork.revalidate(copy.sourceIdentity)
  await assert.rejects(readDisplaySource(f, f.targets[64]!, observed), /缓存已满/u)
  assert.equal(observed.observed.length, 130); assert.deepEqual(rows(f.file), before); await assertDisplaySourcesUnchanged(f)
})

test('专辑显示瞬时：满64候选时display活动FD取消与close都真闭许可，取消不清原待保存候选', async t => {
  let observed: Awaited<ReturnType<typeof observeDisplaySourceFds>> | undefined
  t.after(() => { observed?.releaseAll(); observed?.restore() })
  const f = await displaySourceFixture(t), before = rows(f.file); observed = await observeDisplaySourceFds(f)
  const retained: dto.LocalArtworkSourceCopies['items'] = []
  for (const target of f.targets.slice(0, 64)) retained.push(await readDisplaySource(f, target, observed))
  observed.restore()
  for (const boundary of ['cancel', 'close'] as const) {
    observed = await observeDisplaySourceFds(f, true)
    const lookupId = randomUUID(), beganAtMs = performance.now()
    const reading = f.artwork.readSources(f.targets[64]!, lookupId, new AbortController().signal, beganAtMs + 2000, 'display')
    const rejected = assert.rejects(reading, /取消或超时|读取已停止/u)
    await Promise.race([observed.reached, reading.then(() => { throw new Error('未形成本次display真实FD活动窗口。') })])
    assert.equal(observed.observed.length, 1); const active = observed.observed[0]!
    assert.equal(active.handle.fd, active.fd); assert.ok(fstatSync(active.fd).isFile()); assert.equal(f.admission.resourceCounts().permits, 1)
    let closing: Promise<void> | undefined
    if (boundary === 'cancel') f.artwork.cancel(lookupId)
    else closing = f.artwork.close()
    observed.releaseAll(); await rejected; await closing; observed.assertClosedSinceLast()
    assert.ok(performance.now() < beganAtMs + 2000)
    if (boundary === 'cancel') for (const copy of retained) await f.artwork.revalidate(copy.sourceIdentity)
    else { await assert.rejects(f.artwork.revalidate(retained[0]!.sourceIdentity), /读取已停止/u); assert.throws(() => f.artwork.readSources(f.targets[0]!, randomUUID()), /读取已停止/u) }
    observed.restore(); assert.deepEqual(rows(f.file), before)
  }
  await assertDisplaySourcesUnchanged(f)
})

// LP950：沿原Repository/permit/FD入口验证目录发现，不导入新helper来制造RED。
async function ownedJpeg950() {
  const bytes = await readFile(new URL('./fixtures/mbrs012-source/owned-cover-16.jpg', import.meta.url))
  assert.equal(bytes.length, 960)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '555f7915442690ccb14754bd0da000ceadfbdcfb50b4e3402f55d4806e3e989d')
  return bytes
}

test('LP950：原专辑入口发现唯一R-jpg，真实原字节/捕获修订与作者表均受原守门', async t => {
  const f = await fixture(t), album = (await f.albums.queryAlbums(query)).items[0]!, target = albumArtworkTarget(f, album)
  const albumDirectory = target.context.directory; assert.ok(albumDirectory !== null)
  const directory = path.join(f.media, albumDirectory), picture = await ownedJpeg950(), file = path.join(directory, 'R-1954762-test.jpg')
  await rm(path.join(directory, 'cover.png')); await writeFile(file, picture, { flag: 'wx', mode: 0o600 })
  const audio = await readFile(path.join(directory, 'song.wav')), before = rows(f.file)
  const result = await f.artwork.readSources(target, randomUUID())
  assert.equal(result.copies.status, 'ready'); assert.equal(dto.isLocalArtworkCommandResult('localArtwork.readCandidates', result.copies), true)
  const copy = result.copies.items.find(item => item.origin === 'local-independent'); assert.ok(copy)
  assert.equal(copy.sourceLabel, 'R-1954762-test.jpg'); assert.deepEqual(Buffer.from(copy.base64, 'base64'), picture)
  await f.artwork.revalidate(copy.sourceIdentity)
  assert.deepEqual(await readFile(file), picture); assert.deepEqual(await readFile(path.join(directory, 'song.wav')), audio)
  assert.deepEqual(rows(f.file), before); assert.equal(f.admission.resourceCounts().permits, 0)
  await writeFile(file, Buffer.concat([picture, Buffer.from([1])]))
  await assert.rejects(f.artwork.revalidate(copy.sourceIdentity), /已改变/u)
})

test('LP950：坏固定名仍保后续原图，父/邻目录不借用，多非标图不任选或报确认无图', async t => {
  const f = await fixture(t), album = (await f.albums.queryAlbums(query)).items[0]!, target = albumArtworkTarget(f, album)
  const albumDirectory = target.context.directory; assert.ok(albumDirectory !== null)
  const directory = path.join(f.media, albumDirectory), picture = await ownedJpeg950(), before = rows(f.file)
  const damaged = Buffer.from('自有损坏图片，不是可解码图像')
  await writeFile(path.join(directory, 'cover.jpg'), damaged, { flag: 'wx' })
  const fixed = await f.artwork.readSources(target, randomUUID())
  const independent = fixed.copies.items.filter(item => item.origin === 'local-independent')
  assert.deepEqual(independent.map(item => item.sourceLabel), ['cover.jpg', 'cover.png'])
  assert.deepEqual(Buffer.from(independent[0]!.base64, 'base64'), damaged)
  assert.deepEqual(Buffer.from(independent[1]!.base64, 'base64'), f.png)
  assert.equal(fixed.copies.status, 'ready', '保留真实副本让原Main继续解码回退，不能把坏首图吞为empty')
  await rm(path.join(directory, 'cover.png')); await writeFile(path.join(directory, 'R-recovery.jpg'), picture, { flag: 'wx' })
  const fallback = await f.artwork.readSources(target, randomUUID())
  assert.deepEqual(fallback.copies.items.map(item => item.sourceLabel), ['cover.jpg', 'R-recovery.jpg'])
  assert.deepEqual(Buffer.from(fallback.copies.items[1]!.base64, 'base64'), picture, '首个固定名损坏时仍向原Main提供唯一安全后续副本')
  await rm(path.join(directory, 'cover.jpg')); await rm(path.join(directory, 'R-recovery.jpg'))
  await writeFile(path.join(f.media, 'R-parent.jpg'), picture, { flag: 'wx' })
  const isolated = await f.artwork.readSources(target, randomUUID())
  assert.equal(isolated.copies.items.some(item => item.origin === 'local-independent'), false)
  await writeFile(path.join(directory, 'R-first.jpg'), picture, { flag: 'wx' })
  await writeFile(path.join(directory, 'R-second.png'), f.png, { flag: 'wx' })
  const ambiguous = await f.artwork.readSources(target, randomUUID())
  assert.equal(ambiguous.copies.status, 'source-unavailable'); assert.deepEqual(ambiguous.copies.items, [])
  assert.deepEqual(rows(f.file), before); assert.equal(f.admission.resourceCounts().permits, 0)
})

test('LP950：目录512项截断不推断唯一图，固定名直读不受枚举上限或顺序阻挡', async t => {
  const f = await fixture(t), album = (await f.albums.queryAlbums(query)).items[0]!, target = albumArtworkTarget(f, album)
  const albumDirectory = target.context.directory; assert.ok(albumDirectory !== null)
  const directory = path.join(f.media, albumDirectory), picture = await ownedJpeg950(), before = rows(f.file)
  await rm(path.join(directory, 'cover.png'))
  for (let index = 0; index < 512; index++) await writeFile(path.join(directory, `owned-${index}.txt`), '', { flag: 'wx' })
  await writeFile(path.join(directory, 'R-only.jpg'), picture, { flag: 'wx' })
  const bounded = await f.artwork.readSources(target, randomUUID())
  assert.equal(bounded.copies.status, 'source-unavailable'); assert.deepEqual(bounded.copies.items, [])
  await writeFile(path.join(directory, 'cover.jpg'), picture, { flag: 'wx' })
  const fixed = await f.artwork.readSources(target, randomUUID())
  assert.equal(fixed.copies.status, 'ready'); assert.equal(fixed.copies.items[0]!.sourceLabel, 'cover.jpg')
  assert.deepEqual(Buffer.from(fixed.copies.items[0]!.base64, 'base64'), picture)
  assert.deepEqual(rows(f.file), before); assert.equal(f.admission.resourceCounts().permits, 0)
})

test('LP950：真实目录close拒绝保原permit和fatal，不发布ready或empty', async t => {
  const f = await fixture(t, /资源关闭未确认/u), album = (await f.albums.queryAlbums(query)).items[0]!, target = albumArtworkTarget(f, album)
  const albumDirectory = target.context.directory; assert.ok(albumDirectory !== null)
  const directory = path.join(f.media, albumDirectory), picture = await ownedJpeg950(), before = rows(f.file)
  await rm(path.join(directory, 'cover.png')); await writeFile(path.join(directory, 'R-only.jpg'), picture, { flag: 'wx' })
  const { Dir } = await import('node:fs'), { MetadataLeaseReleaseError } = await import('../src/recording/source-files.js')
  const original = Dir.prototype.close; let held: import('node:fs').Dir | undefined, armed = true, failures = 0
  const complete = (owner: import('node:fs').Dir, callback: (error?: unknown) => void): void => {
    if (armed && owner.path === directory) { held = owner; failures++; queueMicrotask(() => callback(new Error('自有目录close拒绝'))); return }
    Reflect.apply(original, owner, [callback])
  }
  const replacement = function(this: import('node:fs').Dir, callback?: (error?: unknown) => void): Promise<void> | void {
    if (callback) { complete(this, callback); return }
    return new Promise<void>((resolve, reject) => complete(this, error => error ? reject(error) : resolve()))
  } as typeof Dir.prototype.close
  const mocked = t.mock.method(Dir.prototype, 'close', replacement)
  try {
    await assert.rejects(f.artwork.readSources(target, randomUUID()), MetadataLeaseReleaseError)
    assert.equal(failures, 1); assert.ok(held)
    assert.equal(f.admission.resourceCounts().permits, 1, '实际close未确认前原读许可不得释放')
    assert.equal(f.admission.resourceCounts().watches, 1)
    assert.deepEqual(rows(f.file), before)
    assert.throws(() => f.artwork.readSources(target, randomUUID()), /读取已停止/u)
  } finally {
    armed = false; mocked.mock.restore()
    if (held) {
      await new Promise<void>((resolve, reject) => Reflect.apply(original, held!, [(error?: unknown) => error ? reject(error) : resolve()]))
      await assert.rejects(async () => { await held!.read() }, { code: 'ERR_DIR_CLOSED' })
    }
  }
})


test('LP950-r2：大小写固定名同物理别名不占第二槽，坏图后仍交唯一R-jpg给原Main回退', async t => {
  const f = await fixture(t), album = (await f.albums.queryAlbums(query)).items[0]!, target = albumArtworkTarget(f, album)
  const albumDirectory = target.context.directory; assert.ok(albumDirectory !== null)
  const directory = path.join(f.media, albumDirectory), upper = path.join(directory, 'Cover.JPG'), lower = path.join(directory, 'cover.jpg')
  const { stat } = await import('node:fs/promises'), damaged = Buffer.from('自有坏固定图原字节'), picture = await ownedJpeg950()
  await rm(path.join(directory, 'cover.png')); await writeFile(upper, damaged, { flag: 'wx', mode: 0o600 })
  const nativeAlias = await stat(lower, { bigint: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  // 原Source要求nlink=1；只接受卷自然大小写别名，不用hardlink或symlink造替身。
  if (nativeAlias === null) { t.skip('当前自有卷区分大小写，本物理别名case未取得资格'); return }
  const actual = await stat(upper, { bigint: true })
  assert.equal(nativeAlias.dev, actual.dev); assert.equal(nativeAlias.ino, actual.ino)
  assert.equal(nativeAlias.nlink, 1n); assert.equal(actual.nlink, 1n)
  t.diagnostic('自有卷自然大小写别名：实核同dev/ino且nlink=1')
  const file = path.join(directory, 'R-unique.jpg'); await writeFile(file, picture, { flag: 'wx', mode: 0o600 })
  const before = rows(f.file), audio = await readFile(path.join(directory, 'song.wav')), result = await f.artwork.readSources(target, randomUUID())
  const independent = result.copies.items.filter(item => item.origin === 'local-independent')
  assert.equal(result.copies.status, 'ready'); assert.equal(independent.length, 2)
  assert.equal(independent[0]!.sourceLabel, 'Cover.JPG', '固定名先恢复实际basename，原strict metadata/FD仍核规范路径')
  assert.deepEqual(Buffer.from(independent[0]!.base64, 'base64'), damaged)
  const fallback = independent.find(item => item.sourceLabel === 'R-unique.jpg'); assert.ok(fallback, '同一坏图的大小写别名不得挡住唯一有效后续图片')
  assert.deepEqual(Buffer.from(fallback.base64, 'base64'), picture); assert.notEqual(fallback.sourceIdentity, independent[0]!.sourceIdentity)
  assert.deepEqual(await readFile(upper), damaged); assert.deepEqual(await readFile(lower), damaged); assert.deepEqual(await readFile(file), picture)
  assert.deepEqual(await readFile(path.join(directory, 'song.wav')), audio); assert.deepEqual(rows(f.file), before)
  assert.deepEqual(f.admission.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: false })
})

test('LP950-r3：固定名大小写恢复不授权跨父目录符号链接，原Source错误和许可闭口保留', async t => {
  const f = await fixture(t), album = (await f.albums.queryAlbums(query)).items[0]!, target = albumArtworkTarget(f, album)
  const albumDirectory = target.context.directory; assert.ok(albumDirectory !== null)
  const directory = path.join(f.media, albumDirectory), picture = await ownedJpeg950(), parentFile = path.join(f.media, 'R-parent-950.jpg')
  const { symlink } = await import('node:fs/promises'), { SourceFileError } = await import('../src/recording/source-files.js')
  await rm(path.join(directory, 'cover.png')); await writeFile(parentFile, picture, { flag: 'wx', mode: 0o600 })
  const link = path.join(directory, 'cover.jpg'); await symlink(parentFile, link)
  const before = rows(f.file), audio = await readFile(path.join(directory, 'song.wav'))
  await assert.rejects(f.artwork.readSources(target, randomUUID()), (error: unknown) => error instanceof SourceFileError && error.code === 'OUTSIDE_ROOT')
  assert.deepEqual(f.admission.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: false })
  await rm(link)
  const isolated = await f.artwork.readSources(target, randomUUID())
  assert.equal(isolated.copies.items.some(item => item.origin === 'local-independent'), false, '父目录真实图片不能借作当前专辑候选')
  assert.deepEqual(await readFile(parentFile), picture); assert.deepEqual(await readFile(path.join(directory, 'song.wav')), audio)
  assert.deepEqual(rows(f.file), before); assert.deepEqual(f.admission.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: false })
})
