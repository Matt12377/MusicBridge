import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { randomUUID, createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdtemp, mkdir, open, realpath, stat, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { MessageChannel, type MessagePort } from 'node:worker_threads'
import * as dto from '@music-bridge/contracts'
import { createCollectionRepository } from '../../src/collection/repository.js'
import { createBackupWorkflowStore } from '../../src/recording/backup-workflow-store.js'
import { authorizeSourceDirectory, sourceRootAvailability } from '../../src/recording/source-files.js'
import { createLocalAlbumOwnerService } from '../../src/collection/local-album-browser/owner-port.js'
import { createLocalWorkbenchReadService, createLocalLibraryManagementRuntime } from '../../src/collection/local-library-workbench/read-service.js'
import { createLocalWorkbenchLyricsService } from '../../src/collection/local-library-workbench/lyrics-service.js'
import { localLibraryManagementDigest } from '../../src/collection/local-library-workbench/owner-journal.js'
import { localLyricsIntentFingerprint } from '../../src/collection/local-library-lyrics/save-coordinator.js'
import { LocalLyricsError, type LocalLyricsJobRecord, type LocalLyricsJobEntry, type LocalLyricsSaveRecord, type LocalLyricsProtectedSavePort, type LocalLyricsProviderTransportPort } from '../../src/collection/local-library-lyrics/types.js'
import type { ScanPreparedItem } from '../../src/collection/local-scan-store.js'
import { createCueSyntheticWave } from '../../src/library/local-cue-format-qualification.js'

const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
function gate(held = false) {
  const value = deferred<void>()
  if (!held) value.resolve(undefined)
  return { promise: value.promise, release() { value.resolve(undefined) } }
}

// 测试只创建自己的SQLite、合成WAV和只读FD；不调用Parser、Native、Provider、源写许可或用户资料。
// MessagePort用于核实际close事件，不宣称这就是完整Main→Owner的2000ms dispatch资格。
async function privateDirectory() {
  const temporary = process.env.TMPDIR
  assert.ok(temporary && path.isAbsolute(temporary), '必须由Gate提供明确临时根。')
  const canonical = await realpath(temporary)
  if (process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted') {
    const runner = process.env.RUNNER_TEMP
    assert.ok(runner && canonical.startsWith(await realpath(runner) + path.sep), 'CI临时根必须归属当前runner。')
  } else {
    assert.ok(canonical.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'), '本机临时根必须位于外置LifeWeave。')
    assert.notEqual((await stat('/Volumes/LifeWeave')).dev, (await stat('/')).dev, '外置卷必须实际挂载。')
  }
  return mkdtemp(path.join(canonical, 'v39-lyrics-composition454-'))
}

async function readActors(directory: string, held: { join?: boolean; providers?: boolean; writer?: boolean } = {}) {
  const file = path.join(directory, '只读租约.txt')
  await writeFile(file, '只读租约；不是歌词writer或Native输出。', { flag: 'wx', mode: 0o600 })
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  const channel = new MessageChannel(), ports = [channel.port1, channel.port2] as const
  const closedPorts = new Set<MessagePort>()
  for (const port of ports) port.once('close', () => closedPorts.add(port))
  const joinGate = gate(held.join), providerGate = gate(held.providers), writerGate = gate(held.writer)
  const joined = deferred<void>(), providerClosing = deferred<void>(), writerClosing = deferred<void>()
  const calls = { provider: 0, write: 0, retryWrite: 0, original: 0, join: [] as string[], providerClose: 0, writerClose: 0, fdCloses: 0, portCloses: 0 }
  let fdClosed = false, fdClose: Promise<void> | undefined, portClose: Promise<void> | undefined
  const closeFd = (): Promise<void> => {
    if (!fdClose) fdClose = (async () => {
      await fd.close(); calls.fdCloses++
      await assert.rejects(fd.stat(), error => (error as NodeJS.ErrnoException).code === 'EBADF')
      fdClosed = true
    })()
    return fdClose
  }
  const closePorts = (): Promise<void> => {
    if (!portClose) portClose = Promise.all(ports.map(port => new Promise<void>((resolve, reject) => {
      if (closedPorts.has(port)) { resolve(); return }
      const timer = setTimeout(() => reject(new Error('测试自有MessagePort关闭事件未到达。')), 2000)
      port.once('close', () => { clearTimeout(timer); resolve() })
      port.close()
    }))).then(() => { calls.portCloses++; assert.equal(closedPorts.size, 2) })
    return portClose
  }
  let providerClose: Promise<void> | undefined, writerClose: Promise<void> | undefined
  const providers: LocalLyricsProviderTransportPort & { close(): Promise<void> } = {
    async request() { calls.provider++; throw new Error('原结果检查不得调用新Provider。') },
    async join() { await closePorts() },
    close() {
      calls.providerClose++; providerClosing.resolve(undefined)
      providerClose ??= (async () => { await providerGate.promise; await closePorts() })()
      return providerClose
    },
  }
  const writer: LocalLyricsProtectedSavePort & { close(): Promise<void> } = {
    async write() { calls.write++; throw new Error('原结果检查不得新写或申请grant。') },
    async retryFailed() { calls.retryWrite++; throw new Error('UNKNOWN不得重新申请写许可。') },
    async readOriginal(_kind, _intent, _selected) { calls.original++; return null },
    async join(commandId) {
      calls.join.push(commandId); joined.resolve(undefined)
      await joinGate.promise; await closeFd()
    },
    close() {
      calls.writerClose++; writerClosing.resolve(undefined)
      writerClose ??= (async () => { await writerGate.promise; await closeFd() })()
      return writerClose
    },
  }
  return { providers, writer, calls, fd, joined: joined.promise, providerClosing: providerClosing.promise, writerClosing: writerClosing.promise,
    joinGate, providerGate, writerGate, fdClosed: () => fdClosed, portClosed: () => closedPorts.size === 2,
    releaseAll() { joinGate.release(); providerGate.release(); writerGate.release() } }
}

async function fixture(t: TestContext, held: Parameters<typeof readActors>[1] = {}) {
  const directory = await privateDirectory(), sourceDirectory = path.join(directory, '合成来源'), stage = path.join(directory, 'stage')
  await mkdir(sourceDirectory, { mode: 0o700 }); await mkdir(stage, { mode: 0o700 })
  const wave = createCueSyntheticWave(), names = ['甲/01.wav', '甲/02.wav', '乙/03.wav']
  for (const name of names) {
    await mkdir(path.dirname(path.join(sourceDirectory, name)), { recursive: true, mode: 0o700 })
    await writeFile(path.join(sourceDirectory, name), wave.wave, { flag: 'wx', mode: 0o600 })
  }
  const file = path.join(directory, 'catalog.sqlite'), stateFile = path.join(directory, 'identity.sqlite')
  let repository = createCollectionRepository({ filePath: file, stagingRoot: stage }), state = createBackupWorkflowStore({ filePath: stateFile })
  repository.localCatalog.roots()
  let identity = state.datasetIdentities.bind('default', file, false)
  repository.localCatalog.privateBindWorkbenchDataset(identity)
  const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(sourceDirectory))
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' })
  assert.notEqual(root.id, source.id)
  const parserVersion = 'controlled-composition454-prepared-metadata', items: ScanPreparedItem[] = []
  for (const [index, relative] of names.entries()) {
    const info = await stat(path.join(sourceDirectory, relative), { bigint: true })
    items.push({ relative, signature: [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':'), parserVersion, outcome: 'accepted',
      fields: { title: '歌曲' + index, artist: '合成艺人', album: relative.startsWith('甲/') ? '甲专辑' : '乙专辑', disc: '1', track: String(index + 1) },
      failureCode: null, reused: false,
      readFacts: { technical: { container: 'WAVE', codec: 'PCM', lossless: true, sampleRateHz: wave.sampleRate, channels: 2, bitsPerSample: 24,
        durationSeconds: wave.frames / wave.sampleRate, evidence: 'bounded-parser-reported' }, coverEvidence: [],
        readEvidence: { bytesRead: 44, readCalls: 1, maxReadBytes: 44, allocationBytes: 44, elapsedMs: 1, wholeAudioHash: false, wholeAudioDecode: false } } })
  }
  const started = repository.localScan.start({ commandId: randomUUID(), datasetId: identity.datasetId, libraryRootId: root.id, expectedRootRevision: root.revision, parserVersion }).job
  const running = repository.localScan.resume({ commandId: randomUUID(), jobId: started.jobId, expectedRevision: started.jobRevision })
  const batch = { batchId: randomUUID(), jobId: started.jobId, expectedJobRevision: running.jobRevision, checkpointBefore: running.checkpointRef, items, frontier: [], completed: true }
  repository.localScan.privatePrepareBatch({ commandId: randomUUID(), jobId: started.jobId, batch })
  repository.localScan.privateCommitBatch({ commandId: randomUUID(), jobId: started.jobId, batchId: batch.batchId, expectedRevision: running.jobRevision })
  const unchanged = { queryCapture: 0, queryPreparation: 0, inventory: 0, snapshot: 0, coverWrite: 0 }
  function unexpected(label: keyof typeof unchanged): never { unchanged[label]++; throw new Error('原结果检查不应开始新工作：' + label) }
  async function assembled(resources: Awaited<ReturnType<typeof readActors>>) {
    const epoch = randomUUID(), check = () => identity.assertCurrent()
    const views = async (): Promise<readonly dto.LocalRootView[]> => [{ root: repository.localCatalog.root(root.id), label: '自有合成来源', availability: await sourceRootAvailability(repository.sources.root(source.id)) }]
    const owner = createLocalAlbumOwnerService({ repository, assertCurrent: check, readRootViews: views,
      async readArtwork() { throw new Error('此组合不读取封面或图搜。') } })
    const workbench = createLocalWorkbenchReadService({ datasetId: identity.datasetId, repository, localAlbums: owner, readRootViews: views, assertCurrent: check })
    const management = createLocalLibraryManagementRuntime({ identity, catalog: repository.localCatalog, localScan: repository.localScan, workbench,
      localAlbums: owner, readRootViews: views, assertAccepting: check,
      completedSnapshots: { load() { throw new Error('此组合不重载扫描快照。') }, retry() { throw new Error('此组合不重试扫描。') } } })
    const runtime = createLocalWorkbenchLyricsService({ identity, ownerEpoch: epoch, catalog: repository.localCatalog, workbench,
      library: management.lyricsLibraryAuthor, providers: resources.providers, writer: resources.writer, assertAccepting: check,
      observeOriginalCapture() { unexpected('queryCapture') }, prepareQuery() { unexpected('queryPreparation') },
      cover: { async save() { unexpected('coverWrite') }, async readOriginal() { return 'not-requested' }, async hasPending() { return false } },
      inventoryPhysical: { async inspect() { unexpected('inventory') }, async snapshot() { unexpected('snapshot') } } })
    return { epoch, owner, workbench, management, runtime, resources }
  }
  let authors = await assembled(await readActors(directory, held))
  const page = await authors.owner.queryAlbums({ rootId: root.id, query: '', filter: 'all', offset: 0, limit: 200 })
  assert.equal(page.total, 2); assert.equal(page.items.reduce((n, album) => n + album.trackCount, 0), 3)
  const complete = await authors.management.execute('library.capture', { libraryIds: [root.id] })
  const library = complete.lyricsLibraries[0]!
  const entries: LocalLyricsJobEntry[] = []
  const captures = [] as Awaited<ReturnType<typeof authors.management.readFrozenAlbum>>[]
  for (const album of page.items) {
    const readback = await authors.management.execute('library.album.capture', { albumId: album.id, rootId: root.id, revision: album.revision })
    const scope = { datasetId: identity.datasetId, libraryId: root.id, albumId: album.id, captureId: readback.albums[0]!.capture.readToken }
    assert.notEqual(scope.captureId, library.captureId)
    const original = await authors.management.readFrozenAlbum(scope); captures.push(original)
    assert.equal(original.resolved.capture.members.length, album.trackCount)
    entries.push({ scope, state: entries.length ? 'review' : 'unknown', sessionId: randomUUID(), saveRequest: null,
      unresolved: entries.length ? 'review' : 'unknown', sidecars: 0, embedded: 0 })
  }
  const entry = entries[0]!, original = captures[0]!, request = { sessionId: entry.sessionId!, commandId: randomUUID(), embed: false }
  entry.saveRequest = request
  const selected = original.resolved.capture.members.map(member => {
    assert.ok(member.trackId && member.fileRevision && member.locationRevision && member.metadataRevision)
    const body = '[00:00.00]原选择歌词\n'
    return { track: { trackId: member.trackId, title: member.title ?? '', artist: member.artist ?? '', album: member.album ?? '', language: '', version: 'unknown' as const,
      durationMs: Math.round(wave.frames / wave.sampleRate * 1000), wholeTrack: false, format: 'wav' as const, rootRevision: member.rootRevision,
      fileRevision: member.fileRevision, locationRevision: member.locationRevision, metadataRevision: member.metadataRevision, lrc: 'false' as const, embedded: 'false' as const },
      candidateId: randomUUID(), source: 'lrclib' as const, body, sha256: createHash('sha256').update(body).digest('hex') }
  })
  // 保存正文摘要使用歌词原SHA规则；这里仅登记原UNKNOWN账，不调用writer。
  const draft = { request, scope: entry.scope, captureFingerprint: localLibraryManagementDigest([authors.epoch, original.resolved.datasetRevision, original.resolved.capture]), selected }
  const save: LocalLyricsSaveRecord = { intent: { ...draft, fingerprint: localLyricsIntentFingerprint(draft) }, revision: 0, physicalClosed: false, discarded: false,
    receipt: { commandId: request.commandId, sessionId: request.sessionId, state: 'unknown', cover: 'not-requested', snapshot: 'not-requested',
      tracks: selected.map(value => ({ trackId: value.track.trackId, lrc: 'unknown', embed: 'not-requested' })) } }
  repository.localCatalog.privateLyricsCompareAndSwap(identity.datasetId, 'save', save, null)
  const job: LocalLyricsJobRecord = { snapshot: { jobId: randomUUID(), library, state: 'unknown', totalAlbums: 2, processedAlbums: 2, savedAlbums: 0,
    reviewAlbumIds: [entries[1]!.scope.albumId], failedAlbumIds: [], unknownAlbumIds: [entry.scope.albumId], sidecars: 0, embedded: 0, inspectionFailures: 0, revision: 0 },
    entries, enumerationComplete: true, embed: false, watermark: complete.revision, deadlineAtMs: performance.now() + 480000 }
  repository.localCatalog.privateLyricsCompareAndSwap(identity.datasetId, 'job', job, null)
  const totalChanges = () => {
    assert.ok(repository.privateMobileCatalogAccess)
    return repository.privateMobileCatalogAccess(db => Number(db.prepare('SELECT total_changes() AS n').get()!.n))
  }
  const noNewWork = () => {
    assert.deepEqual(unchanged, { queryCapture: 0, queryPreparation: 0, inventory: 0, snapshot: 0, coverWrite: 0 })
    assert.deepEqual([authors.resources.calls.provider, authors.resources.calls.write, authors.resources.calls.retryWrite], [0, 0, 0])
  }
  async function retire() {
    authors.resources.releaseAll(); await authors.runtime.close(); await authors.management.close(); authors.workbench.close(); authors.owner.close()
    repository.close(); state.close()
  }
  let closed = false
  async function shutdown() {
    if (closed) return
    await retire(); closed = true
    for (const name of names) assert.deepEqual(await readFile(path.join(sourceDirectory, name)), wave.wave)
  }
  t.after(shutdown)
  return { directory, file, root, source, library, entry, job, save, complete, captures, unchanged, totalChanges, noNewWork, shutdown,
    get identity() { return identity }, get repository() { return repository }, get authors() { return authors },
    async cold(nextHeld: Parameters<typeof readActors>[1] = {}) {
      const previous = identity.datasetId; await retire()
      repository = createCollectionRepository({ filePath: file, stagingRoot: stage }); state = createBackupWorkflowStore({ filePath: stateFile })
      repository.localCatalog.roots(); identity = state.datasetIdentities.bind('default', file, false); repository.localCatalog.privateBindWorkbenchDataset(identity)
      assert.equal(identity.datasetId, previous)
      const actorDirectory = await mkdtemp(path.join(directory, 'cold-actors-'))
      authors = await assembled(await readActors(actorDirectory, nextHeld))
    } }
}

test('002歌词组合：同Owner完整捕获与原entry分域，冷SQL读口保原scope/session/saveRequest且零新工作', async t => {
  const f = await fixture(t)
  const inspect = async () => {
    const original = f.repository.localCatalog.privateLyricsRecord(f.identity.datasetId, 'job', f.job.snapshot.jobId), changes = f.totalChanges()
    const record = f.repository.localCatalog.privateLibraryManagementRead(f.identity, 'capture', f.library.captureId)!
    assert.equal(record.record.original.albums.length, 2)
    assert.equal(record.record.original.albums.reduce((n, album) => n + album.resolved.capture.members.length, 0), 3)
    for (const entry of f.job.entries) {
      const snapshot = await f.authors.runtime.execute('localLyrics.job.read', { jobId: f.job.snapshot.jobId, albumId: entry.scope.albumId })
      assert.deepEqual(snapshot, { ...f.job.snapshot, originalEntry: { scope: entry.scope, sessionId: entry.sessionId, saveRequest: entry.saveRequest } })
      assert.notEqual(snapshot!.originalEntry!.scope.captureId, snapshot!.library.captureId)
      assert.notEqual(snapshot!.originalEntry!.scope.libraryId, f.source.id)
      const frozen = await f.authors.management.readFrozenAlbum(snapshot!.originalEntry!.scope)
      assert.deepEqual(frozen, f.captures.find(capture => capture.resolved.capture.albumId === entry.scope.albumId))
    }
    assert.deepEqual(await f.authors.runtime.execute('localLyrics.job.read', { jobId: f.job.snapshot.jobId, albumId: 'missing-album' }), { ...f.job.snapshot, originalEntry: null })
    assert.deepEqual(f.repository.localCatalog.privateLyricsRecord(f.identity.datasetId, 'job', f.job.snapshot.jobId), original)
    assert.equal(f.totalChanges(), changes); f.noNewWork()
  }
  await inspect(); await f.cold(); await inspect()
  await assert.rejects(f.authors.runtime.execute('localLyrics.session.read', { sessionId: f.entry.sessionId! }), error => error instanceof LocalLyricsError && error.code === 'NOT_FOUND')
  f.noNewWork()
  t.diagnostic('实际同SQLite/物理DatasetIdentity与歌词工厂只读；未恢复内存session，未执行Native、SourceWrites或完整Main dispatch。')
})

test('002歌词组合：冷UNKNOWN原command等实际FD join，空运行Map与错session不能重签或恢复源写', async t => {
  const f = await fixture(t); await f.cold({ join: true })
  const request = f.entry.saveRequest!, before = f.repository.localCatalog.privateLyricsRecord(f.identity.datasetId, 'save', request.commandId)
  await f.authors.runtime.service.saves.wait(request.commandId)
  assert.equal(f.authors.resources.fdClosed(), false, '空协调Map不是原外部作者已关闭的证据。')
  await assert.rejects(f.authors.runtime.execute('localLyrics.receipt', { sessionId: randomUUID(), commandId: request.commandId }), error => error instanceof LocalLyricsError && error.code === 'CONFLICT')
  await assert.rejects(f.authors.runtime.execute('localLyrics.save', { ...request, sessionId: randomUUID() }), error => error instanceof LocalLyricsError && error.code === 'CONFLICT')
  await assert.rejects(f.authors.runtime.execute('localLyrics.job.retry', { jobId: f.job.snapshot.jobId, albumIds: [f.entry.scope.albumId] }), error => error instanceof LocalLyricsError && error.code === 'INVALID')
  assert.deepEqual(f.authors.resources.calls.join, [])
  let settled = false
  const receipt = f.authors.runtime.execute('localLyrics.receipt', { sessionId: request.sessionId, commandId: request.commandId }).then(value => { settled = true; return value })
  try {
    await f.authors.resources.joined; await nextTurn()
    assert.equal(settled, false); assert.ok((await f.authors.resources.fd.stat()).isFile())
    assert.deepEqual(f.authors.resources.calls.join, [request.commandId])
    assert.deepEqual(f.repository.localCatalog.privateLyricsRecord(f.identity.datasetId, 'save', request.commandId), before)
    f.noNewWork(); f.authors.resources.joinGate.release()
    const result = await receipt
    assert.equal(result!.state, 'unknown'); assert.equal(result!.sessionId, request.sessionId); assert.equal(result!.commandId, request.commandId)
    assert.equal(f.authors.resources.fdClosed(), true)
    const after = f.repository.localCatalog.privateLyricsRecord(f.identity.datasetId, 'save', request.commandId) as LocalLyricsSaveRecord
    assert.deepEqual(after.intent, f.save.intent); assert.equal(after.physicalClosed, true); assert.equal(after.revision, f.save.revision + 1)
    assert.deepEqual(f.repository.localCatalog.privateLyricsRecord(f.identity.datasetId, 'job', f.job.snapshot.jobId), f.job)
    const joins = f.authors.resources.calls.join.length
    assert.equal((await f.authors.runtime.execute('localLyrics.save.retry', { sessionId: request.sessionId, commandId: request.commandId })).state, 'unknown')
    assert.equal(f.authors.resources.calls.join.length, joins); f.noNewWork()
  } finally { f.authors.resources.joinGate.release(); await receipt }
  t.diagnostic('真实FD只属于测试只读端口；此例证明原回执协调等待join和原正文保持，不签真实SourceFiles/Native/Main grant资格。')
})

test('002歌词组合：实际歌词factory关闭等待已装配端口和FD，空job/sessionMap不提前收口', async t => {
  const f = await fixture(t, { providers: true, writer: true }), resources = f.authors.resources
  let settled = false
  const closing = f.authors.runtime.close().then(() => { settled = true })
  try {
    await Promise.all([resources.providerClosing, resources.writerClosing]); await nextTurn()
    assert.equal(settled, false); assert.equal(resources.portClosed(), false); assert.ok((await resources.fd.stat()).isFile())
    await assert.rejects(f.authors.runtime.execute('localLyrics.job.read', { jobId: f.job.snapshot.jobId }), error => error instanceof LocalLyricsError && error.code === 'CLOSED')
    resources.providerGate.release(); await nextTurn()
    assert.equal(settled, false, 'Provider关闭不代表独立writer只读FD已经关闭。')
    resources.writerGate.release(); await closing
    assert.equal(resources.portClosed(), true); assert.equal(resources.fdClosed(), true)
    assert.equal(resources.calls.portCloses, 1); assert.equal(resources.calls.fdCloses, 1)
    assert.deepEqual(await f.repository.localCatalog.privateLyricsRecord(f.identity.datasetId, 'job', f.job.snapshot.jobId), f.job)
    assert.ok(f.repository.localCatalog.roots().length > 0, 'SQLite仍归外层同Owner，不被歌词子factory擅自关闭。')
    f.noNewWork(); await f.authors.runtime.close()
    assert.equal(resources.calls.portCloses, 1); assert.equal(resources.calls.fdCloses, 1)
  } finally { resources.releaseAll(); await closing }
  t.diagnostic('实际子factory协调和Node资源关闭；完整Root SourceSafety/SQL/Native关闭顺序及Main2000ms另由Root验证。')
})
