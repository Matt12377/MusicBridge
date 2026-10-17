import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { fstatSync } from 'node:fs'
import { mkdtemp, mkdir, open, readFile, rm, stat, writeFile, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as dto from '@music-bridge/contracts'
import { createCollectionRepository } from '../src/collection/repository.js'
import { createLocalAlbumOwnerService } from '../src/collection/local-album-browser/owner-port.js'
import { createLocalAlbumArtworkReader } from '../src/collection/local-album-browser/artwork-read-port.js'
import type { LocalAlbumArtworkReadContext } from '../src/collection/local-album-browser/types.js'
import { isDatasetProjectionPayload, type DatasetProjectionPort } from '../src/collection/dataset-owner-protocol.js'
import { createScanReadAdmission } from '../src/library/scan-read-admission.js'
import { authorizeSourceDirectory, sourceRootAvailability } from '../src/recording/source-files.js'
import { createBridgeRuntime } from '../src/runtime.js'
import { RoonAudioInputAdapter } from '../src/roon/adapter.js'
import type { RoonSdk } from '../src/roon/sdk.js'
import type { RoonState } from '../src/roon/types.js'
import { StreamGateway } from '../src/stream/gateway.js'
import { ControlServer } from '../src/control/server.js'
import { createLocalFavoriteRepository } from '../src/favorites/repository.js'
import { createLogger } from '../src/shared/logger.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
function authorRows(file: string) {
  const database = new DatabaseSync(file, { readOnly: true })
  try {
    return ['local_catalog_ledger', 'local_catalog_editions', 'local_artwork_candidates', 'local_artwork_selections']
      .map(table => [table, Number(database.prepare(`SELECT count(*) n FROM ${table}`).get()!.n)])
  } finally { database.close() }
}
function target(repository: ReturnType<typeof createCollectionRepository>, album: dto.LocalAlbumSummary) {
  const detail = repository.localCatalog.trackDetail(album.representativeTrackId!)
  const locator = repository.localCatalog.privateAssetLocator(detail.asset.id)
  const request: dto.LocalAlbumArtworkRequest = { albumKey: album.id, rootId: album.rootId, editionId: album.editionId,
    representativeTrackId: album.representativeTrackId, revision: album.revision }
  const context: LocalAlbumArtworkReadContext = { album, directory: path.posix.dirname(locator.relative), representative: {
    relative: locator.relative, summary: { track: detail.track, asset: detail.asset, metadata: detail.metadata.effective, versionTokens: detail.versionTokens },
    rawMetadata: detail.metadata.raw, hasArtwork: false, artworkRevision: null } }
  return { request, context }
}

test('DISPLAY_PURPOSE原Reader：冷PNG显示可读，candidate仍拒；混合两槽与重获用途保留，真FD闭后释放', { timeout: 10_000 }, async t => {
  const temporary = process.env.TMPDIR
  if (!temporary?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/')) throw new Error('合成资料必须使用外置临时目录')
  const directory = await mkdtemp(path.join(temporary, 'mbf-display-purpose-')), media = path.join(directory, 'media'), file = path.join(directory, 'work.sqlite')
  let repository: ReturnType<typeof createCollectionRepository> | undefined
  let artwork: ReturnType<typeof createLocalAlbumArtworkReader> | undefined
  let albums: ReturnType<typeof createLocalAlbumOwnerService> | undefined
  let admission: ReturnType<typeof createScanReadAdmission> | undefined
  let releaseHeld = () => {}, onDeferred: (() => void) | undefined, beforeRelease: (() => void) | undefined
  const tasks: Promise<unknown>[] = []
  t.after(async () => {
    const failures: unknown[] = []
    const cleanup: Array<() => void | Promise<void>> = [
      () => releaseHeld(),
      async () => {
        const settled = await Promise.allSettled(tasks)
        for (const result of settled) if (result.status === 'rejected') failures.push(result.reason)
      },
      () => artwork?.close(),
      () => albums?.close(),
      () => admission?.close(),
      () => repository?.close(),
      () => rm(directory, { recursive: true, force: true }),
    ]
    for (const close of cleanup) {
      try { await close() } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, '合成读取或资源清理未全部确认', { cause: failures[0] })
  })
  const audio = await readFile(new URL('./fixtures/mbrs003/audio/fixtures/core-wav.wav', import.meta.url))
  const png = await readFile(new URL('./fixtures/mbrs003/audio/inputs/cover-small.png', import.meta.url))
  assert.equal(createHash('sha256').update(audio).digest('hex'), 'cc1eaac76af6c2b237f97c908202e3ded3b1aff6d7052bf20846a487243e5340')
  assert.equal(createHash('sha256').update(png).digest('hex'), '243ddd560483dfae4f0ac0cce1e922a7828baab254b6df5d3402d0fec4f06e45')
  for (const name of ['one', 'two']) {
    await mkdir(path.join(media, name), { recursive: true })
    await writeFile(path.join(media, name, 'song.wav'), audio)
    await writeFile(path.join(media, name, 'cover.png'), png)
  }
  repository = createCollectionRepository({ filePath: file })
  const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media))
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' })
  const tracks = ['one', 'two'].map(name => {
    const asset = repository!.localCatalog.registerAsset({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision,
      relative: `${name}/song.wav`, sha256: null, sampleFrames: null, timebaseHz: null })
    const track = repository!.localCatalog.createTrack({ commandId: randomUUID(), assetId: asset.id, segment: null })
    repository!.localCatalog.observeMetadata({ commandId: randomUUID(), trackId: track.id, source: 'synthetic', parserVersion: 'display-purpose-v1',
      fields: { title: '合成歌曲', artist: '合成作者', album: '合成专辑' } })
    return track
  })
  const scope = { epoch: randomUUID(), datasetId: randomUUID() }, acquires: Array<{ payload: unknown; status: string }> = []
  let scanBusy = true
  admission = createScanReadAdmission({ isBusy: () => scanBusy, isDisplayBusy: () => false })
  const projection: DatasetProjectionPort = { async call(command, payload) {
    assert.equal(isDatasetProjectionPayload(command, payload), true)
    if (command === 'scanReadAcquire') {
      const purpose = Object.hasOwn(payload, 'purpose') ? (payload as { purpose: 'local-album-display' }).purpose : 'scan'
      const result = admission!.acquire(scope, purpose)
      acquires.push({ payload: structuredClone(payload), status: result.status })
      if (result.status === 'deferred') onDeferred?.()
      return result as never
    }
    if (command === 'scanReadWatchRevocation') return admission!.watchRevocation(scope, (payload as { permitId: string }).permitId) as never
    if (command === 'scanReadRelease') {
      beforeRelease?.()
      return admission!.release(scope, (payload as { permitId: string }).permitId) as never
    }
    throw new Error('本用例只验证原来源读取，不冒Main解码')
  } }
  artwork = createLocalAlbumArtworkReader({ repository, projection, assertCurrent() {} })
  albums = createLocalAlbumOwnerService({ repository, assertCurrent() {},
    async readRootViews() { return [{ root: repository!.localCatalog.root(root.id), label: '合成来源', availability: await sourceRootAvailability(repository!.sources.root(root.sourceRootId)) }] },
    async readArtwork() { throw new Error('本用例不替代正式readSources') },
  })
  const page = await albums.queryAlbums({ query: '', rootId: null, filter: 'all', offset: 0, limit: 60 })
  const left = target(repository, page.items.find(item => item.representativeTrackId === tracks[0]!.id)!)
  const right = target(repository, page.items.find(item => item.representativeTrackId === tracks[1]!.id)!)
  const before = authorRows(file)
  assert.equal(before.find(([name]) => name === 'local_artwork_selections')?.[1], 0)
  const read = (value: typeof left, mode: 'candidate' | 'display') => {
    const task = artwork!.readSources(value, randomUUID(), undefined, undefined, mode)
    tasks.push(task); void task.catch(() => {})
    return task
  }
  const denied = await read(left, 'candidate')
  assert.deepEqual(denied, { image: null, copies: { status: 'source-unavailable', items: [] } })
  assert.deepEqual(acquires, [{ payload: {}, status: 'deferred' }])
  const cold = await read(left, 'display')
  assert.equal(cold.copies.status, 'ready')
  assert.ok(cold.copies.items.some(copy => Buffer.from(copy.base64, 'base64').equals(png)))
  assert.deepEqual(acquires.at(-1), { payload: { purpose: 'local-album-display' }, status: 'granted' })
  assert.deepEqual(authorRows(file), before)

  // 同一Map中先有扫描票，再持实际封面FD；第二显示只能等原FD和票据真正释放。
  scanBusy = false
  const external = admission.acquire(scope)
  assert.equal(external.status, 'granted'); if (external.status !== 'granted') assert.fail('扫描票未建立')
  const externalWatch = admission.watchRevocation(scope, external.permitId)
  const cover = path.join(media, 'one', 'cover.png')
  const identities = await Promise.all((['one', 'two'] as const).map(async name => {
    const value = await stat(path.join(media, name, 'cover.png'))
    return { name, dev: value.dev, ino: value.ino }
  }))
  const probe = await open(cover, 'r')
  const prototype = Object.getPrototypeOf(probe), originalRead = prototype.read
  await probe.close()
  const entered = deferred(), continueRead = deferred(), deferredRead = deferred()
  const held: Array<{ handle: FileHandle; fd: number }> = []
  const observedCovers = new Map<FileHandle, { name: 'one' | 'two'; handle: FileHandle; fd: number }>()
  const coversCheckedAtRelease: string[][] = []
  let holdOnce = true, releasesChecked = 0
  releaseHeld = continueRead.resolve
  t.mock.method(prototype, 'read', async function (this: FileHandle, ...args: unknown[]) {
    let identity: typeof identities[number] | undefined
    try {
      const current = fstatSync(this.fd)
      identity = identities.find(value => current.dev === value.dev && current.ino === value.ino)
    } catch { /* 非目标FS继续原read，不由观察者改写其结果。 */ }
    if (!identity) return Reflect.apply(originalRead, this, args)
    if (!observedCovers.has(this)) observedCovers.set(this, { name: identity.name, handle: this, fd: this.fd })
    if (holdOnce && identity.name === 'one') {
      holdOnce = false; held.push({ handle: this, fd: this.fd }); entered.resolve(); await continueRead.promise
    }
    return Reflect.apply(originalRead, this, args)
  })
  const acquireStart = acquires.length, first = read(left, 'display')
  await Promise.race([entered.promise, first.then(() => assert.fail('未进入真实封面FD'))])
  const heldCover = held[0]; assert.ok(heldCover)
  assert.equal(heldCover.handle.fd, heldCover.fd); assert.ok(fstatSync(heldCover.fd).isFile())
  assert.equal(admission.resourceCounts().permits, 2)
  onDeferred = deferredRead.resolve
  const second = read(right, 'display')
  await Promise.race([deferredRead.promise, second.then(() => assert.fail('第二显示没有等待原许可'))])
  scanBusy = true; admission.observe()
  assert.deepEqual(await externalWatch, { reason: 'media-busy' })
  assert.equal(admission.resourceCounts().permits, 2)
  assert.equal(admission.resourceCounts().revoked, 1)
  beforeRelease = () => {
    for (const observed of observedCovers.values()) {
      assert.equal(observed.handle.fd, -1)
      assert.throws(() => fstatSync(observed.fd), (error: NodeJS.ErrnoException) => error.code === 'EBADF')
    }
    coversCheckedAtRelease.push([...observedCovers.values()].map(value => value.name).sort())
    releasesChecked++
  }
  continueRead.resolve()
  const results = await Promise.all([first, second])
  assert.ok(results.every(value => value.copies.status === 'ready' && value.copies.items.some(copy => Buffer.from(copy.base64, 'base64').equals(png))))
  assert.deepEqual(acquires.slice(acquireStart), [
    { payload: { purpose: 'local-album-display' }, status: 'granted' },
    { payload: { purpose: 'local-album-display' }, status: 'deferred' },
    { payload: { purpose: 'local-album-display' }, status: 'granted' },
  ])
  assert.equal(releasesChecked, 2)
  assert.equal(observedCovers.size, 2)
  assert.deepEqual([...observedCovers.values()].map(value => value.name).sort(), ['one', 'two'])
  assert.deepEqual(coversCheckedAtRelease, [['one'], ['one', 'two']])
  admission.release(scope, external.permitId)
  assert.deepEqual(admission.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: false })
  assert.deepEqual(authorRows(file), before)
  assert.deepEqual(await readFile(cover), png)
  assert.deepEqual(await readFile(path.join(media, 'one', 'song.wav')), audio)
})

test('DISPLAY_PURPOSE真实runtime：冷idle无Zone可读，playing/paused保显示，loading失观测与closing拒绝', async t => {
  let state: RoonState = { status: 'discovering' }, notify = () => {}, mediaReads = 0
  // 只隔离外部Roon、监听与媒体忙采样；生产runtime、Controller和admission保持真实组合。
  t.mock.method(StreamGateway.prototype, 'start', async () => undefined)
  t.mock.method(StreamGateway.prototype, 'getActiveMediaReadCount', () => mediaReads)
  t.mock.method(ControlServer.prototype, 'start', async () => undefined)
  t.mock.method(RoonAudioInputAdapter.prototype, 'start', async () => undefined)
  t.mock.method(RoonAudioInputAdapter.prototype, 'shutdown', async () => undefined)
  t.mock.method(RoonAudioInputAdapter.prototype, 'getState', () => ({ ...state }))
  t.mock.method(RoonAudioInputAdapter.prototype, 'getSelectedZonePlaybackState', () => state.transportState)
  t.mock.method(RoonAudioInputAdapter.prototype, 'setStateHandler', (handler: () => void) => { notify = handler })
  const sdk: RoonSdk = { audioInputService: class {}, transportService: class {},
    createApi() { assert.fail('禁止真实Roon连接') }, createSettings() { assert.fail('禁止真实Roon设置') }, createStatus() { assert.fail('禁止真实Roon状态写入') } }
  const runtime = createBridgeRuntime({ env: { LOG_LEVEL: 'error', BRIDGE_CONTROL_HOST: '127.0.0.1', BRIDGE_STREAM_HOST: '127.0.0.1' },
    favoriteRepository: createLocalFavoriteRepository(), roonSdk: sdk, logger: createLogger('error') })
  t.after(() => runtime.shutdown())
  const admission = runtime.getDatasetScanReadAdmission?.(); assert.ok(admission)
  const scope = { epoch: randomUUID(), datasetId: randomUUID() }
  const display = () => admission.acquire(scope, 'local-album-display')
  const granted = () => {
    const value = display(); assert.equal(value.status, 'granted')
    if (value.status !== 'granted') assert.fail('显示许可未发出')
    return value.permitId
  }
  assert.deepEqual(display(), { status: 'deferred' })
  await runtime.start()
  const cold = granted(); admission.release(scope, cold)
  state = { status: 'ready' }; notify()
  const noZone = granted(); admission.release(scope, noZone)
  state = { status: 'ready', selectedZoneId: 'zone-display' }; notify()
  assert.deepEqual(display(), { status: 'deferred' })
  state = { ...state, transportState: 'playing' }; mediaReads = 1; notify()
  const playing = granted(), playingWatch = admission.watchRevocation(scope, playing)
  assert.deepEqual(admission.acquire(scope), { status: 'deferred' })
  state = { ...state, transportState: 'paused' }; notify()
  assert.equal(admission.resourceCounts().revoked, 0)
  admission.release(scope, playing); assert.deepEqual(await playingWatch, { reason: 'permit-released' })
  const paused = granted(), loadingWatch = admission.watchRevocation(scope, paused)
  state = { ...state, transportState: 'loading' }; notify()
  assert.deepEqual(await loadingWatch, { reason: 'media-busy' })
  assert.equal(admission.resourceCounts().permits, 1)
  assert.deepEqual(display(), { status: 'deferred' }); admission.release(scope, paused)
  state = { status: 'error' }; notify()
  assert.deepEqual(display(), { status: 'deferred' })
  assert.deepEqual(admission.acquire(scope), { status: 'deferred' })
  state = { status: 'ready', selectedZoneId: 'zone-display', transportState: 'stopped' }; mediaReads = 0; notify()
  const stopped = granted(); admission.release(scope, stopped)
  const scan = admission.acquire(scope); assert.equal(scan.status, 'granted')
  if (scan.status === 'granted') admission.release(scope, scan.permitId)
  state = { status: 'discovering' }; notify()
  assert.deepEqual(display(), { status: 'deferred' })
  state = { status: 'ready', selectedZoneId: 'zone-display', transportState: 'paused' }; notify()
  const closing = granted(), closingWatch = admission.watchRevocation(scope, closing)
  await runtime.shutdown()
  assert.deepEqual(await closingWatch, { reason: 'admission-closed' })
  assert.equal(admission.resourceCounts().permits, 1)
  assert.deepEqual(display(), { status: 'deferred' }); admission.release(scope, closing)
  assert.deepEqual(admission.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: true })
})
