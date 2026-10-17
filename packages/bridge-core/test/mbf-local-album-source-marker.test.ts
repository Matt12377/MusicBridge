import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync, StatementSync, type SQLOutputValue } from 'node:sqlite'
import { MessageChannel } from 'node:worker_threads'
import * as dto from '@music-bridge/contracts'
import { createCollectionRepository, type CollectionRepository } from '../src/collection/repository.js'
import { createLocalAlbumOwnerService } from '../src/collection/local-album-browser/owner-port.js'
import { LocalAlbumReadError } from '../src/collection/local-album-browser/grouping.js'
import type { LocalAlbumArtworkReadResult, LocalAlbumNameEnhancementFact } from '../src/collection/local-album-browser/types.js'
import type { ScanPreparedBatch, ScanPreparedItem } from '../src/collection/local-scan-store.js'
import { createLocalSourceWritesService } from '../src/collection/local-source-writes-service.js'
import { createSourceWritesMainActor } from '../src/collection/source-writes-authority.js'
import { sourceWritesHash, type SourceWriteFileFact } from '../src/collection/local-source-writes-journal.js'
import { authorizeSourceDirectory, sourceRootAvailability } from '../src/recording/source-files.js'

/**
 * 原Repository/Owner与真实SQLite native回调；不使用简化projection或手填fullRaw。
 * 初始scan标签/技术事实为受控输入，文件签名来自自有副本；不运行Scanner/Reader。
 * SourceWrites正例则由原服务真实预览、grant、发布、写后parser和原guard产生facts。
 * 这只证明受控读写行为及求值次数，不证明300k性能、Main/native解码或用户媒体验收。
 */
const parserVersion = 'music-metadata-11.15.0/mbrs003-v1'
const albumTitle = '来源标记合成专辑'
const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
const fields = (index: number, album = albumTitle): dto.LocalMetadata => ({ title: `合成曲目 ${index}`, artist: '合成艺人', album, year: '2026', disc: '1', track: String(index) })
const query = (changes: Partial<dto.LocalAlbumQuery> = {}): dto.LocalAlbumQuery => ({ query: '', rootId: null, filter: 'all', offset: 0, limit: 200, ...changes })
const artworkRequest = (album: dto.LocalAlbumSummary): dto.LocalAlbumArtworkRequest => ({ albumKey: album.id, rootId: album.rootId, editionId: album.editionId, representativeTrackId: album.representativeTrackId, revision: album.revision })
const errorCode = (code: LocalAlbumReadError['code']) => (error: unknown) => error instanceof LocalAlbumReadError && error.code === code

let requestSequence = 0
async function request<T>(command: string, body: unknown, action: () => T | Promise<T>): Promise<T> {
  const id = ++requestSequence, started = performance.now()
  process.stdout.write(JSON.stringify({ 事件: '容量请求', 状态: '开始', id, command, request: body }) + '\n')
  let outcome = '通过', publicCode: LocalAlbumReadError['code'] | undefined
  try { return await action() }
  catch (error) {
    outcome = '失败'
    if (error instanceof LocalAlbumReadError && ['INVALID_REQUEST', 'SNAPSHOT_CHANGED', 'CONTENT_LIMIT_EXCEEDED', 'UNAVAILABLE'].includes(error.code)) publicCode = error.code
    throw error
  }
  finally { process.stdout.write(JSON.stringify({ 事件: '容量请求', 状态: '结束', id, command, 结果: outcome, 耗时毫秒: performance.now() - started, ...(publicCode ? { code: publicCode } : {}) }) + '\n') }
}

function ownerFor(repository: CollectionRepository, names: LocalAlbumNameEnhancementFact[] = [], readArtwork: () => Promise<LocalAlbumArtworkReadResult> = async () => ({ image: null, status: 'ready' })) {
  return createLocalAlbumOwnerService({ repository, assertCurrent() {},
    readRootViews: () => Promise.all(repository.localCatalog.roots().map(async root => ({ root, label: '自有合成来源', availability: await sourceRootAvailability(repository.sources.root(root.sourceRootId)) }))),
    readArtwork, nameEnhancements: { revision: () => hash(JSON.stringify(names)), read: () => names } })
}

async function fixture(t: TestContext, options: { tracks?: number; embedded?: boolean; trackNamed?: boolean } = {}) {
  installNativeSourceObserver(t)
  const temporary = process.env.TMPDIR
  if (!temporary?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/')) throw new Error('来源标记测试必须采用外置任务临时目录。')
  const directory = await mkdtemp(path.join(temporary, 'mbf-source-marker-')), media = path.join(directory, '自有合成来源'), filePath = path.join(directory, 'work.sqlite')
  await mkdir(media, { mode: 0o700 })
  const repository = createCollectionRepository({ filePath }), extraClosers: (() => Promise<void>)[] = []
  let closed = false, service: ReturnType<typeof createLocalAlbumOwnerService> | undefined
  async function close(): Promise<void> {
    if (closed) return
    closed = true
    try { for (const closer of [...extraClosers].reverse()) await closer() }
    finally { service?.close(); repository.close() }
  }
  t.after(async () => { try { await close() } finally { await rm(directory, { recursive: true, force: true }) } })
  const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media))
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' })
  const datasetId = randomUUID(), names: LocalAlbumNameEnhancementFact[] = [], written = new Set<string>()
  const cover = await readFile(new URL('./fixtures/mbrs012-source/owned-cover-16.jpg', import.meta.url)), coverDigest = hash(cover)
  assert.equal(cover.length, 960); assert.equal(coverDigest, '555f7915442690ccb14754bd0da000ceadfbdcfb50b4e3402f55d4806e3e989d')
  const image: dto.LocalArtworkImage = {
    original: { mime: 'image/jpeg', bytes: cover.length, sha256: coverDigest, width: 16, height: 16 },
    display: { mime: 'image/jpeg', bytes: cover.length, sha256: coverDigest, width: 16, height: 16, dataUrl: `data:image/jpeg;base64,${cover.toString('base64')}` },
  }
  async function ownedFile(relative: string, bytes = Buffer.from('MBF owned synthetic bytes; no parser or listening evidence')): Promise<void> {
    if (written.has(relative)) return
    const file = path.join(media, relative)
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    await writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); written.add(relative)
  }
  async function signature(relative: string): Promise<string> {
    const info = await stat(path.join(media, relative), { bigint: true })
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':')
  }
  async function accepted(relative: string, raw: dto.LocalMetadata, embedded = options.embedded ?? true, container: 'WAVE' | 'FLAC' = 'WAVE'): Promise<ScanPreparedItem> {
    await ownedFile(relative)
    return { relative, signature: await signature(relative), parserVersion, outcome: 'accepted', fields: raw, failureCode: null, reused: false,
      readFacts: {
        technical: { container, codec: container === 'FLAC' ? 'FLAC' : 'PCM', lossless: true, sampleRateHz: 48000, channels: 2, bitsPerSample: 16, durationSeconds: 1, evidence: 'bounded-parser-reported' },
        coverEvidence: embedded ? [{ mime: 'image/jpeg', bytes: cover.length, sha256: coverDigest, evidence: 'encoded-bytes-magic-and-digest' }] : [],
        readEvidence: { bytesRead: 44, readCalls: 1, maxReadBytes: 44, allocationBytes: 44, elapsedMs: 1, wholeAudioHash: false, wholeAudioDecode: false },
      } }
  }
  async function rejected(relative: string, failureCode = 'UNSUPPORTED'): Promise<ScanPreparedItem> {
    await ownedFile(relative)
    return { relative, signature: await signature(relative), parserVersion, outcome: 'rejected', fields: null, failureCode, reused: false, readFacts: null }
  }
  async function commit(items: ScanPreparedItem[], cueItems?: dto.LocalCuePreparedItem[]): Promise<void> {
    assert.ok(items.length <= 200)
    const current = repository.localCatalog.root(root.id)
    const started = repository.localScan.start({ commandId: randomUUID(), datasetId, libraryRootId: current.id, expectedRootRevision: current.revision, parserVersion }).job
    const running = repository.localScan.resume({ commandId: randomUUID(), jobId: started.jobId, expectedRevision: started.jobRevision })
    const batch: ScanPreparedBatch = { batchId: randomUUID(), jobId: running.jobId, expectedJobRevision: running.jobRevision, checkpointBefore: running.checkpointRef,
      items, frontier: [], completed: true, ...(cueItems ? { kind: 'cue-sidecars-v1' as const, cueItems } : {}) }
    repository.localScan.privatePrepareBatch({ commandId: randomUUID(), jobId: running.jobId, batch })
    assert.equal(repository.localScan.privateCommitBatch({ commandId: randomUUID(), jobId: running.jobId, batchId: batch.batchId, expectedRevision: running.jobRevision }).phase, 'completed')
  }
  function scanned(relative: string) {
    const scan = repository.localScan.privateFileState(root.id, relative)!.value
    assert.equal(scan.outcome, 'accepted'); assert.ok(scan.trackId && scan.assetId)
    return { relative, track: repository.localCatalog.track(scan.trackId), asset: repository.localCatalog.asset(scan.assetId), scan }
  }
  const size = options.tracks ?? 65
  const relatives = Array.from({ length: size }, (_, index) => `来源目录/${options.trackNamed && index === size - 1 ? 'Track' : ''}${String(index + 1).padStart(3, '0')}.wav`)
  await commit(await Promise.all(relatives.map((relative, index) => accepted(relative, fields(index + 1)))))
  const tracks = relatives.map(scanned)
  let artworkReader: () => Promise<LocalAlbumArtworkReadResult> = async () => ({ image: null, status: 'ready' })
  service = ownerFor(repository, names, () => artworkReader())
  const owner = service
  const albums = (body = query()) => request('queryAlbums', body, () => owner.queryAlbums(body))
  const members = (album: dto.LocalAlbumSummary, offset = 0, limit = 200) => {
    const body = { albumKey: album.id, rootId: album.rootId, offset, limit }
    return request('queryAlbumTracks', body, () => owner.queryAlbumTracks(body))
  }
  const inspect = (album: dto.LocalAlbumSummary) => {
    const body = { albumKey: album.id, rootId: album.rootId, revision: album.revision }
    return request('inspectAlbum', body, () => owner.inspectAlbum(body))
  }
  const artwork = (album: dto.LocalAlbumSummary) => request('getArtwork', artworkRequest(album), () => owner.getArtwork(artworkRequest(album)))
  function edition(label: string, members: readonly { track: dto.LocalTrack }[]) {
    const value = repository.localCatalog.createEdition({ commandId: randomUUID(), title: '来源标记发行', edition: label })
    for (const [index, member] of members.entries()) repository.localCatalog.linkEditionTrack({ commandId: randomUUID(), editionId: value.id, trackId: member.track.id, disc: 1, trackNumber: index + 1, sequence: index + 1 })
    return value
  }
  async function manualTrack(relative: string, raw: dto.LocalMetadata) {
    await ownedFile(relative)
    const current = repository.localCatalog.root(root.id)
    const asset = repository.localCatalog.registerAsset({ commandId: randomUUID(), libraryRootId: current.id, expectedRootRevision: current.revision, relative, sha256: null, sampleFrames: null, timebaseHz: null })
    const track = repository.localCatalog.createTrack({ commandId: randomUUID(), assetId: asset.id, segment: null })
    repository.localCatalog.observeMetadata({ commandId: randomUUID(), trackId: track.id, source: 'synthetic', parserVersion, fields: raw })
    return { relative, asset, track }
  }
  async function ownedFlac() {
    const manifestBytes = await readFile(new URL('./fixtures/mbrs012-source/manifest.json', import.meta.url))
    assert.equal(hash(manifestBytes), '5a3621481eb22801c020589b393c3a1ffa32e3d132766ea6e8db6e33fa47714b')
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as { synthetic: boolean; allContentOwned: boolean; realLibraryUsed: boolean; files: { file: string; bytes: number; sha256: string }[] }
    assert.equal(manifest.synthetic, true); assert.equal(manifest.allContentOwned, true); assert.equal(manifest.realLibraryUsed, false)
    const entry = manifest.files.find(value => value.file === 'owned-stereo-fixed-tags.flac')!, relative = '真实受控写回/owned-stereo-fixed-tags.flac'
    assert.ok(entry)
    const bytes = await readFile(new URL('./fixtures/mbrs012-source/owned-stereo-fixed-tags.flac', import.meta.url))
    assert.equal(bytes.length, entry.bytes); assert.equal(hash(bytes), entry.sha256)
    await ownedFile(relative, bytes)
    const raw: dto.LocalMetadata = { title: '合成写回样本', artist: '测试艺人', album: '有限写回测试', year: '2026', disc: '1', track: '2' }
    await commit([await accepted(relative, raw, false, 'FLAC')])
    return { ...scanned(relative), bytes, raw }
  }
  return { repository, datasetId, root, directory, filePath, media, coverDigest, image, tracks, names, owner, accepted, rejected, commit, signature, ownedFile, scanned, edition, manualTrack, ownedFlac,
    albums, members, inspect, artwork, close, addCloser(value: () => Promise<void>) { extraClosers.push(value) }, setArtworkReader(value: typeof artworkReader) { artworkReader = value } }
}

type SourceFunction = 'ordinal' | 'fields'
interface SourceStatement {
  id: number
  method: 'get' | 'all' | 'iterate'
  kind: 'gallery' | 'find' | 'members' | 'derived' | 'indexed-members' | 'other'
  sqlSha256: string
  rows: number
  nativeByTrack: Record<string, { ordinal: number; fields: number }>
}
interface SourceObservation {
  registrations: { name: string; originalArity: number; wrappedArity: number }[]
  statements: SourceStatement[]
  nativeEvents: { statementId: number | null; trackId: string; name: SourceFunction }[]
}
type SourceRegistration = { name: string; originalArity: number; wrappedArity: number }
type SourceExecution = { statement: StatementSync; database: DatabaseSync; ticket: SourceStatement }
let observing = false
interface NativeSourceObserverState {
  owner: TestContext
  observation?: SourceObservation | undefined
  active?: SourceExecution | undefined
}
let nativeSourceObserver: NativeSourceObserverState | undefined

function installNativeSourceObserver(t: TestContext): void {
  if (nativeSourceObserver) { assert.equal(nativeSourceObserver.owner, t, 'prototype观测只能复用本测试生命周期'); return }
  const state: NativeSourceObserverState = { owner: t }
  const owners = new WeakMap<StatementSync, DatabaseSync>()
  const registrations = new WeakMap<DatabaseSync, Map<SourceFunction, SourceRegistration>>()
  const functionDescriptor = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, 'function')!
  const prepareDescriptor = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, 'prepare')!
  const originalFunction = DatabaseSync.prototype.function, originalPrepare = DatabaseSync.prototype.prepare
  const methods = (['get', 'all', 'iterate'] as const).map(method => ({ method, descriptor: Object.getOwnPropertyDescriptor(StatementSync.prototype, method)! }))
  const observedFunction = function (this: DatabaseSync, ...args: unknown[]) {
    const name = args[0] === 'mb_album_source_ordinal' ? 'ordinal' : args[0] === 'mb_album_source_fields' ? 'fields' : null
    let registered: SourceRegistration | undefined
    if (name) {
      const database = this, callback = args[args.length - 1]
      assert.equal(typeof callback, 'function')
      const invoke = callback as (value: SQLOutputValue) => SQLOutputValue
      assert.equal(invoke.length, 1, '原source标量必须保持一参数SQLite arity')
      // 回调只分发至正在执行的观察上下文；复用reader不能写回已完成的旧观察结果。
      const counted = function (this: unknown, value: SQLOutputValue): SQLOutputValue {
        const observation = state.observation, execution = state.active
        if (observation) {
          const trackId = String(value)
          if (execution) assert.equal(execution.database, database, 'native回调必须属于该真实Statement的Database')
          observation.nativeEvents.push({ statementId: execution?.ticket.id ?? null, trackId, name })
          if (execution) { const count = execution.ticket.nativeByTrack[trackId] ??= { ordinal: 0, fields: 0 }; count[name]++ }
        }
        return Reflect.apply(invoke, this, [value]) as SQLOutputValue
      }
      const registration = { name: String(args[0]), originalArity: invoke.length, wrappedArity: counted.length }
      assert.equal(registration.wrappedArity, registration.originalArity)
      registered = registration
      args[args.length - 1] = counted
    }
    const value = Reflect.apply(originalFunction, this, args)
    if (name && registered) {
      const current = registrations.get(this) ?? new Map<SourceFunction, SourceRegistration>()
      current.set(name, registered); registrations.set(this, current)
    }
    return value
  }
  const observedPrepare = function (this: DatabaseSync, ...args: Parameters<DatabaseSync['prepare']>) {
    const statement = Reflect.apply(originalPrepare, this, args) as StatementSync
    owners.set(statement, this)
    return statement
  }
  Object.defineProperty(observedFunction, 'length', { value: originalFunction.length })
  Object.defineProperty(observedPrepare, 'length', { value: originalPrepare.length })
  assert.equal(observedFunction.length, originalFunction.length); assert.equal(observedPrepare.length, originalPrepare.length)
  const wrapped = methods.map(({ method, descriptor }) => {
    const original = descriptor.value as (...bindings: unknown[]) => unknown
    const observed = function (this: StatementSync, ...bindings: unknown[]) {
      const observation = state.observation, database = owners.get(this)
      if (!observation || !database) return Reflect.apply(original, this, bindings)
      const sql = this.sourceSQL
      const projection = sql.includes('mb_album_source_ordinal') || sql.includes('mb_album_source_fields')
      if (!projection) return Reflect.apply(original, this, bindings)
      // 每次真实执行单独分配ticket；prepare仅登记原Statement归属，缓存命中同样经过这里。
      const ticket: SourceStatement = { id: observation.statements.length + 1, method,
        kind: sql.includes('mb_album_derived_snapshot') ? 'derived' : sql.includes('page_members AS MATERIALIZED') && sql.includes('FROM json_each(@memberPage)') ? 'indexed-members' : sql.includes('envelope FROM counts') ? 'gallery' : sql.includes('SELECT * FROM groups WHERE album_key') ? 'find' : sql.includes('page_members AS') ? 'members' : 'other',
        sqlSha256: hash(sql), rows: 0, nativeByTrack: {} }
      observation.statements.push(ticket)
      for (const registration of registrations.get(database)?.values() ?? [])
        if (!observation.registrations.some(saved => saved.name === registration.name)) observation.registrations.push({ ...registration })
      const execution = { statement: this, database, ticket }
      const withinStatement = <V>(action: () => V): V => { const previous = state.active; state.active = execution; try { return action() } finally { state.active = previous } }
      if (method === 'iterate') {
        const iterator = withinStatement(() => Reflect.apply(original, this, bindings)) as Iterator<unknown> & Iterable<unknown>
        // 不提前取行；yield之间不占active，每个真实next/return/throw单独进入原ticket。
        const observedIterator: Iterator<unknown> & Iterable<unknown> = new Proxy(iterator, { get(cursor, stepName) {
          if (stepName === Symbol.iterator) return () => observedIterator
          const step = Reflect.get(cursor, stepName, cursor)
          if (typeof step !== 'function') return step
          if (stepName === 'next' || stepName === 'return' || stepName === 'throw') {
            const observedStep = (...args: unknown[]) => withinStatement(() => {
              const result = Reflect.apply(step, cursor, args) as IteratorResult<unknown>
              if (stepName === 'next' && !result.done) ticket.rows++
              return result
            })
            Object.defineProperty(observedStep, 'length', { value: step.length }); assert.equal(observedStep.length, step.length)
            return observedStep
          }
          return step.bind(cursor)
        } })
        return observedIterator
      }
      return withinStatement(() => {
        const result = Reflect.apply(original, this, bindings)
        if (method === 'all') { assert.ok(Array.isArray(result)); ticket.rows = result.length }
        else ticket.rows = result === undefined ? 0 : 1
        return result
      })
    }
    Object.defineProperty(observed, 'length', { value: original.length }); assert.equal(observed.length, original.length)
    return { method, descriptor, observed }
  })
  nativeSourceObserver = state
  Object.defineProperty(DatabaseSync.prototype, 'function', { ...functionDescriptor, value: observedFunction })
  Object.defineProperty(DatabaseSync.prototype, 'prepare', { ...prepareDescriptor, value: observedPrepare })
  for (const { method, descriptor, observed } of wrapped) Object.defineProperty(StatementSync.prototype, method, { ...descriptor, value: observed })
  t.after(() => {
    try {
      assert.equal(state.observation, undefined); assert.equal(state.active, undefined)
      assert.equal(DatabaseSync.prototype.function, observedFunction); assert.equal(DatabaseSync.prototype.prepare, observedPrepare)
      for (const { method, observed } of wrapped) assert.equal(StatementSync.prototype[method], observed)
    } finally {
      Object.defineProperty(DatabaseSync.prototype, 'function', functionDescriptor)
      Object.defineProperty(DatabaseSync.prototype, 'prepare', prepareDescriptor)
      for (const { method, descriptor } of wrapped) Object.defineProperty(StatementSync.prototype, method, descriptor)
      nativeSourceObserver = undefined; observing = false
    }
  })
}

async function observeNativeSources<T>(action: () => Promise<T>): Promise<{ value: T; observation: SourceObservation }> {
  assert.equal(observing, false, 'prototype观测不得交叠')
  assert.ok(nativeSourceObserver, '必须先沿本测试真实fixture安装观察器')
  const state = nativeSourceObserver, observation: SourceObservation = { registrations: [], statements: [], nativeEvents: [] }
  observing = true; state.observation = observation
  try { return { value: await action(), observation } }
  finally { assert.equal(state.active, undefined); state.observation = undefined; observing = false }
}

function report(label: string, observation: SourceObservation): void {
  process.stdout.write(JSON.stringify({ 事件: '来源标记native分层计数', label, ...observation, 边界: '按每条真实Owner SQL statement观测；不将memo、计划位置或小库耗时当作性能资格。' }) + '\n')
}
type ExpectedSourceStatement = { kind: SourceStatement['kind']; method: SourceStatement['method']; rows: number; trackIds: readonly string[] }
function assertOneMarker(observation: SourceObservation, expected: readonly ExpectedSourceStatement[]): void {
  assert.ok(expected.length > 0, '不能把未观测的Source native当0次通过')
  assert.deepEqual(observation.statements.map(({ kind, method, rows }) => ({ kind, method, rows })), expected.map(({ kind, method, rows }) => ({ kind, method, rows })))
  assert.equal(observation.nativeEvents.some(event => event.statementId === null), false, '所有source回调都应归属其实际SQL statement')
  for (const name of ['mb_album_source_ordinal', 'mb_album_source_fields']) assert.ok(observation.registrations.some(value => value.name === name), '两原native标量均须真实注册并观测')
  assert.ok(observation.registrations.every(value => value.originalArity === 1 && value.wrappedArity === 1))
  assert.equal(observation.nativeEvents.length, expected.reduce((sum, statement) => sum + statement.trackIds.length, 0), '不能遗漏或增加未归属的实际native事件')
  for (const [index, statement] of observation.statements.entries()) {
    const trackIds = expected[index]!.trackIds
    assert.deepEqual(Object.keys(statement.nativeByTrack).sort(), [...trackIds].sort(), '完整派生核全部65身份；索引页核原当页实际ID闭集')
    const events = observation.nativeEvents.filter(event => event.statementId === statement.id)
    assert.equal(events.length, trackIds.length)
    for (const trackId of trackIds) {
      assert.equal(statement.nativeByTrack[trackId]?.ordinal, 1, `statement ${statement.id}/${statement.kind} 的基础来源标记应只求值一次`)
      assert.equal(statement.nativeByTrack[trackId]?.fields, 0, '完整六raw存在时fields必须保留惰性，不能物化所有fullRaw JSON')
      assert.equal(events.filter(event => event.trackId === trackId && event.name === 'ordinal').length, 1)
    }
  }
}

test('MBF来源标记：真实Owner的65基础轨每SQL只求值一次，fields惰性且同轨多发行保留完整事实', { concurrency: false }, async t => {
  const f = await fixture(t), catalog = f.repository.localCatalog, target = f.tracks[64]!, editionA = f.edition('原版', f.tracks)
  const before = await observeNativeSources(() => f.albums()), initial = before.value.items.find(album => album.editionId === editionA.id)!
  assert.equal(initial.trackCount, 65); assert.equal(initial.title, editionA.title); assert.deepEqual(initial.artists, ['合成艺人'])
  assert.equal(initial.year, '2026'); assert.equal(initial.versionLabel, '原版'); assert.equal(initial.artworkState, 'available')
  assert.deepEqual(before.value.counts, { all: 1, 'missing-artwork': 0, 'has-artwork': 1, 'cue-unsplit': 0, 'metadata-issue': 0, 'parse-failed': 0, 'loose-audio': 0, 'track-named-audio': 0, 'missing-lyrics': 0 })
  const tail = await observeNativeSources(() => f.members(initial, 64, 1)), captured = await f.inspect(initial)
  assert.equal(tail.value.items.length, 1); assert.equal(tail.value.hasMore, false); assert.equal(tail.value.items[0]!.sequence, 65)
  assert.deepEqual(tail.value.items[0]!.facts.track, catalog.track(target.track.id)); assert.deepEqual(tail.value.items[0]!.facts.asset, catalog.asset(target.asset.id))
  assert.deepEqual(tail.value.items[0]!.facts.metadata, catalog.metadata(target.track.id)); assert.equal(tail.value.items[0]!.facts.fileParameters?.sampleRateHz, 48000)
  assert.deepEqual(captured.members.map(member => member.fact.summary.track.id), f.tracks.map(value => value.track.id))
  assert.deepEqual(captured.issues, []); assert.deepEqual(captured.rejectedFiles, [])
  for (const [index, member] of captured.members.entries()) {
    assert.deepEqual(member.fact.rawMetadata, fields(index + 1)); assert.deepEqual(member.fact.summary.metadata, fields(index + 1))
    assert.equal(member.editionLink?.editionId, editionA.id); assert.equal(member.sequence, index + 1)
  }
  const editionB = f.edition('再版', [target]), after = await observeNativeSources(() => f.albums())
  assert.equal(after.value.total, 2); assert.equal(after.value.counts['has-artwork'], 2)
  assert.deepEqual(after.value.items.find(album => album.editionId === editionA.id), initial, '额外发行关系不改原发行summary和完整member digest/revision')
  const reissue = after.value.items.find(album => album.editionId === editionB.id)!
  assert.equal(reissue.trackCount, 1); assert.equal(reissue.representativeTrackId, target.track.id)
  assert.deepEqual((await f.members(reissue)).items[0]!.facts.metadata, catalog.metadata(target.track.id))
  report('65轨原关系gallery', before.observation); report('65轨冷目标find与实际尾页', tail.observation); report('65轨多发行gallery', after.observation)
  const ids = f.tracks.map(value => value.track.id)
  // 冷目标的find与members各覆盖65基础来源；尾页只输出第65轨，每条真实SQL的ordinal仍各求值一次。
  assertOneMarker(before.observation, [{ kind: 'gallery', method: 'get', rows: 1, trackIds: ids }])
  assertOneMarker(after.observation, [{ kind: 'gallery', method: 'get', rows: 1, trackIds: ids }])
  assertOneMarker(tail.observation, [
    { kind: 'find', method: 'get', rows: 1, trackIds: ids },
    { kind: 'members', method: 'all', rows: 1, trackIds: ids },
  ])
  assert.deepEqual(after.observation.statements[0]!.nativeByTrack, before.observation.statements[0]!.nativeByTrack)
})

test('MBF来源标记：部分历史、六effective与空字符串override保持原facts及raw遮盖水位', { concurrency: false }, async t => {
  const f = await fixture(t, { tracks: 2 }), target = f.tracks[1]!, catalog = f.repository.localCatalog, edition = f.edition('历史事实', [target])
  const initial = (await f.albums()).items.find(album => album.editionId === edition.id)!
  catalog.observeMetadata({ commandId: randomUUID(), trackId: target.track.id, source: 'tag', parserVersion, fields: { artist: '锚前部分新艺人', year: '2027' } })
  const commandId = randomUUID(), overlay: dto.LocalMetadata = { title: '', artist: 'MB艺人', album: '', year: '2030', disc: '2', track: '9' }
  const override = catalog.overrideMetadata({ commandId, trackId: target.track.id, expectedRevision: null, fields: overlay })
  const observed = await observeNativeSources(() => f.albums()), current = observed.value.items.find(album => album.editionId === edition.id)!
  const raw = { ...fields(2), artist: '锚前部分新艺人', year: '2027' }, effective = { ...raw, ...overlay }
  assert.equal(current.id, initial.id); assert.notEqual(current.revision, initial.revision); assert.deepEqual(current.artists, ['MB艺人']); assert.equal(current.year, '2030')
  const item = (await f.members(current)).items[0]!, capture = await f.inspect(current)
  assert.deepEqual(item.facts.metadata, { raw, override, effective }); assert.deepEqual(item.facts.metadata, catalog.metadata(target.track.id))
  assert.deepEqual(capture.members[0]!.fact.rawMetadata, raw); assert.deepEqual(capture.members[0]!.fact.summary.metadata, effective)
  assert.equal(item.facts.metadata.effective.title, ''); assert.equal(item.facts.metadata.effective.album, '')
  assert.deepEqual(catalog.privateWorkbenchMetadataProvenance([target.track.id]), [{ trackId: target.track.id, override: { commandId, revision: override.revision, fields: overlay } }])
  await assert.rejects(f.inspect(initial), errorCode('SNAPSHOT_CHANGED')); await assert.rejects(f.artwork(initial), errorCode('SNAPSHOT_CHANGED'))
  catalog.observeMetadata({ commandId: randomUUID(), trackId: target.track.id, source: 'synthetic', parserVersion, fields: { title: '被空override遮盖的新raw标题' } })
  const changed = (await f.albums()).items.find(album => album.id === current.id)!
  assert.notEqual(changed.revision, current.revision); assert.equal(changed.title, current.title)
  const changedMember = (await f.members(changed)).items[0]!
  assert.equal(changedMember.facts.metadata.effective.title, ''); assert.equal(changedMember.facts.metadata.raw.title, '被空override遮盖的新raw标题')
  await assert.rejects(f.inspect(current), errorCode('SNAPSHOT_CHANGED'))
  const watermark = catalog.privateAlbumBrowserRevision(), previousObservation = catalog.observations(target.track.id).at(-1)!
  const sameObservation = catalog.observeMetadata({ commandId: randomUUID(), trackId: target.track.id, source: 'tag', parserVersion, fields: { title: '被空override遮盖的新raw标题' } })
  const sameValues = (await f.albums()).items.find(album => album.id === current.id)!
  assert.notEqual(sameObservation.revision, previousObservation.revision); assert.notEqual(catalog.privateAlbumBrowserRevision(), watermark)
  assert.deepEqual(sameValues, changed, '原group按完整成员值hash；相同值观察推进全局lease，不改变原group显示值digest语义')
  assert.deepEqual((await f.members(sameValues)).items[0]!.facts.metadata.effective, changedMember.facts.metadata.effective)
  report('部分历史和空字符串override', observed.observation)
})

test('MBF来源标记：真实Owner七类counts、空页和零CUE；scan与手选封面变化保持原修订围栏', { concurrency: false }, async t => {
  const f = await fixture(t, { tracks: 3, trackNamed: true }), catalog = f.repository.localCatalog
  await f.commit([await f.accepted('Track004.wav', fields(4, '散落原标签'), false), await f.rejected('元数据失败/01.bin', 'PARSE_FAILED'), await f.rejected('普通拒收/01.bin')])
  const unknown = await f.manualTrack('待探测/01.wav', fields(5, '尚未探测专辑')), cueRelative = '空CUE/album.cue'
  await f.ownedFile(cueRelative)
  await f.commit([], [{ relative: cueRelative, signature: await f.signature(cueRelative), parserVersion: 'cue-text-75fps/mbrs003-v1', outcome: 'rejected', failureCode: 'CUE_PARSE_FAILED', reused: false, previousSnapshotId: null, result: null }])
  f.names.push({ rootId: f.root.id, directory: '元数据失败', revision: 'synthetic-name-failed-v1', state: 'failed' }, { rootId: f.root.id, directory: '普通拒收', revision: 'synthetic-name-cancelled-v1', state: 'cancelled' })
  const all = await f.albums(), expected: dto.LocalAlbumFilterCounts = { all: 6, 'missing-artwork': 0, 'has-artwork': 1, 'cue-unsplit': 1, 'metadata-issue': 1, 'parse-failed': 1, 'loose-audio': 1, 'track-named-audio': 2, 'missing-lyrics': 0 }
  assert.deepEqual(all.counts, expected); assert.equal(all.total, 6)
  const a = await f.albums(query({ limit: 2 })), b = await f.albums(query({ offset: 2, limit: 2 })), again = await f.albums(query({ limit: 2 }))
  assert.deepEqual(a, again); assert.deepEqual(a.items, all.items.slice(0, 2)); assert.deepEqual(b.items, all.items.slice(2, 4))
  const empty = await f.albums(query({ offset: 200, limit: 2 })); assert.deepEqual(empty.items, []); assert.deepEqual(empty.counts, expected); assert.equal(empty.total, 6)
  for (const filter of dto.LOCAL_ALBUM_STATUSES) {
    const page = await f.albums(query({ filter })); assert.equal(page.total, expected[filter]); assert.deepEqual(page.counts, expected); assert.ok(page.items.every(album => album.statuses.includes(filter)))
  }
  const failed = await f.inspect(all.items.find(album => album.statuses.includes('metadata-issue'))!)
  assert.equal(failed.summary.trackCount, 0); assert.deepEqual(failed.members, [])
  assert.ok(failed.issues.some(issue => issue.kind === 'metadata-read-failed')); assert.ok(failed.issues.some(issue => issue.kind === 'name-enhancement-failed'))
  assert.deepEqual(failed.rejectedFiles!.map(value => value.relative), ['元数据失败/01.bin'])
  const cue = await f.inspect(all.items.find(album => album.statuses.includes('cue-unsplit'))!)
  assert.equal(cue.summary.representativeTrackId, null); assert.deepEqual(cue.members, []); assert.deepEqual(cue.issues, [{ kind: 'cue', relative: cueRelative, status: 'failed' }])
  const awaiting = all.items.find(album => album.representativeTrackId === unknown.track.id)!
  assert.equal(awaiting.artworkState, 'unknown'); assert.equal((await f.artwork(awaiting)).image, null)
  const confirmed = (await f.albums(query({ filter: 'missing-artwork' }))).items[0]!
  assert.equal(confirmed.id, awaiting.id); assert.equal(confirmed.artworkState, 'missing'); assert.notEqual(confirmed.revision, awaiting.revision)
  const scanAlbum = all.items.find(album => album.representativeTrackId === f.tracks[0]!.track.id)!
  await f.commit(await Promise.all(f.tracks.map((value, index) => f.accepted(value.relative, fields(index + 1), false))))
  const noEmbedded = (await f.albums()).items.find(album => album.id === scanAlbum.id)!
  assert.equal(noEmbedded.artworkState, 'unknown'); assert.notEqual(noEmbedded.revision, scanAlbum.revision)
  await assert.rejects(f.inspect(scanAlbum), errorCode('SNAPSHOT_CHANGED'))
  await assert.rejects(f.artwork(confirmed), errorCode('SNAPSHOT_CHANGED'))
  const target = f.tracks[0]!, edition = f.edition('手选封面', [target]), before = (await f.albums()).items.find(album => album.editionId === edition.id)!
  const context = f.repository.localArtwork.context({ trackId: target.track.id, editionId: edition.id }); assert.ok(context.target)
  const staged = f.repository.localArtwork.stage({ target: context.target, origin: 'manual', sourceIdentity: f.coverDigest, sourceLabel: '自有合成图片', image: f.image })
  const selection = f.repository.localArtwork.apply({ commandId: randomUUID(), target: context.target, candidateId: staged.candidates[0]!.id, expectedSelectionRevision: null })
  const selected = (await f.albums()).items.find(album => album.id === before.id)!
  assert.equal(selected.artworkState, 'available'); assert.notEqual(selected.revision, before.revision)
  const nextTarget = f.repository.localArtwork.context({ trackId: target.track.id, editionId: edition.id }).target!
  const repeated = f.repository.localArtwork.apply({ commandId: randomUUID(), target: nextTarget, candidateId: staged.candidates[0]!.id, expectedSelectionRevision: selection.revision })
  assert.notEqual(repeated.revision, selection.revision); assert.equal(repeated.candidate!.display.sha256, selection.candidate!.display.sha256)
  const current = (await f.albums()).items.find(album => album.id === selected.id)!
  assert.notEqual(current.revision, selected.revision); await assert.rejects(f.artwork(selected), errorCode('SNAPSHOT_CHANGED'))
  let enter!: () => void, resolve!: (result: LocalAlbumArtworkReadResult) => void
  const entered = new Promise<void>(accept => { enter = accept }), blocked = new Promise<LocalAlbumArtworkReadResult>(accept => { resolve = accept })
  f.setArtworkReader(async () => { enter(); return blocked })
  const waiting = f.artwork(current), completed = waiting.then(() => ({ stage: 'completed' as const }), (error: unknown) => ({ stage: 'rejected' as const, error }))
  const signal = await Promise.race([entered.then(() => ({ stage: 'entered' as const })), completed])
  if (signal.stage === 'rejected') throw signal.error
  assert.equal(signal.stage, 'entered', '必须实际进入Owner读器，不能用setImmediate或提前成功代替')
  const watermark = catalog.privateAlbumBrowserRevision()
  catalog.createEdition({ commandId: randomUUID(), title: '真实全局水位变化', edition: '' })
  assert.notEqual(catalog.privateAlbumBrowserRevision(), watermark)
  resolve({ image: null, status: 'ready' }); await assert.rejects(waiting, errorCode('SNAPSHOT_CHANGED'))
  assert.equal(f.owner.getCacheInfo().observationCount, 0)
})

test('MBF来源标记：原SourceWrites真实plan/grant/commit的非空及空fullRaw、锚后观察和override/provenance', { concurrency: false }, async t => {
  const f = await fixture(t, { tracks: 65 }), target = await f.ownedFlac(), catalog = f.repository.localCatalog, edition = f.edition('源写回事实', [target])
  const initial = (await f.albums()).items.find(album => album.editionId === edition.id)!, beforeAsset = catalog.asset(target.asset.id)
  const api = createLocalSourceWritesService({ repository: f.repository, datasetId: f.datasetId, ownerEpoch: randomUUID(), assertCurrent() { catalog.root(f.root.id) } })
  const channel = new MessageChannel(), actor = createSourceWritesMainActor(channel.port1)
  f.addCloser(async () => { try { await api.close() } finally { channel.port1.close(); channel.port2.close() } })
  await api.prepareRecoveryProtection()
  function policy(): dto.LocalSourceWritesPolicy {
    const context = api.get({ datasetId: f.datasetId, selector: { kind: 'context', target: null } }); assert.equal(context.kind, 'context'); assert.ok(context.kind === 'context')
    return context.context.policy
  }
  assert.equal(policy().enabled, false, '原默认OFF必须保留；只启用这个新owned repository的局部policy')
  assert.equal(api.setPolicy({ datasetId: f.datasetId, commandId: randomUUID(), expectedPolicyRevision: policy().revision, enabled: true }).outcome, 'accepted')
  function plan(id: string): dto.LocalSourceWritesPlan {
    const result = api.get({ datasetId: f.datasetId, selector: { kind: 'plan', planId: id } }); assert.equal(result.kind, 'plan'); assert.ok(result.kind === 'plan' && result.plan)
    return result.plan
  }
  async function waitPlan(id: string, predicate: (value: dto.LocalSourceWritesPlan) => boolean): Promise<dto.LocalSourceWritesPlan> {
    const deadline = Date.now() + 20000
    for (;;) {
      const value = plan(id)
      if (predicate(value)) return value
      if (Date.now() >= deadline) assert.fail(`等待原SourceWrites状态超界：${value.state}/${value.issues.join(',')}`)
      await new Promise<void>(resolve => setTimeout(resolve, 10))
    }
  }
  async function publish(patch: Extract<dto.LocalSourceWritesIntent, { kind: 'tags' }>['fields']): Promise<{ plan: dto.LocalSourceWritesPlan; fact: SourceWriteFileFact }> {
    const beforeBytes = await readFile(path.join(f.media, target.relative))
    const intent: dto.LocalSourceWritesIntent = { kind: 'tags', target: { mode: 'single', trackId: target.track.id }, fields: patch }
    const ready = await request('SourceWrites.preview', { targetTrackId: target.track.id }, async () => {
      const receipt = api.preview({ datasetId: f.datasetId, commandId: randomUUID(), intent }); assert.equal(receipt.outcome, 'accepted'); assert.ok(receipt.planId)
      const value = await waitPlan(receipt.planId, value => value.state !== 'PREVIEWING'); assert.equal(value.state, 'READY', value.issues.join(',')); return value
    })
    assert.ok(ready.planHash && ready.contextFingerprint)
    const confirm: dto.ConfirmLocalSourceWrites = { datasetId: f.datasetId, commandId: randomUUID(), planId: ready.planId, expectedViewRevision: ready.viewRevision, scope: 'SOURCE_FILES', range: ready.range, planHash: ready.planHash, contextFingerprint: ready.contextFingerprint }
    const completed = await request('SourceWrites.executeGranted', { planId: ready.planId }, async () => {
      const challenge = api.challenge({ datasetId: f.datasetId, confirm }, actor)
      assert.equal(api.executeGranted({ datasetId: f.datasetId, confirm, grant: challenge.grant }, actor).outcome, 'accepted')
      const value = await waitPlan(ready.planId, value => ['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED', 'RECOVERY_REQUIRED'].includes(value.state))
      assert.equal(value.state, 'COMPLETED', value.issues.join(',')); return value
    })
    const fact = catalog.privateSourceWritesRead(view => {
      const stored = view.projection.plans.get(completed.planId); assert.ok(stored)
      const facts = stored.events.filter(event => event.kind === 'facts'); assert.equal(facts.length, 1)
      const event = facts[0]!; assert.equal(event.kind, 'facts'); assert.ok(event.kind === 'facts')
      assert.ok(stored.events.some(event => event.kind === 'phase' && event.fact.phase === 'PUBLISH_INTENT'))
      return event.fact
    })
    const { fingerprint, ...proof } = fact.rawProof
    assert.equal(proof.parserVersion, 'music-metadata-11.15.0/source-writes-full-v1'); assert.equal(proof.sourceSha256, fact.observation.sha256)
    assert.equal(proof.signature, fact.observation.signature); assert.equal(proof.fileRevision, fact.afterAsset.fileRevision); assert.equal(fingerprint, sourceWritesHash({ proof, fullRaw: fact.fullRaw }))
    assert.deepEqual(fact.affectedTrackIds, [target.track.id]); assert.equal(fact.afterAsset.id, beforeAsset.id)
    const anchor = catalog.privateSourceWritesRead(view => view.projection.fullRaw.get(target.track.id)); assert.ok(anchor)
    assert.deepEqual(anchor.fields, fact.fullRaw); assert.ok(anchor.ledgerOrdinal > 0)
    assert.deepEqual(await readFile(fact.backup.path), beforeBytes, '每次真实发布备份都与发布前独立读取字节一致')
    assert.equal(hash(await readFile(path.join(f.media, target.relative))), fact.observation.sha256)
    return { plan: completed, fact }
  }
  // 两次均经真实publisher提交；不append ready/facts，不填fullRaw Map或简化journal。
  const partial = await publish({ title: { action: 'set', value: '源完整锚题名' }, album: { action: 'set', value: '源完整锚专辑' }, artist: { action: 'remove' }, year: { action: 'remove' }, disc: { action: 'remove' }, track: { action: 'remove' } })
  const expectedRaw = { title: '源完整锚题名', album: '源完整锚专辑' }
  assert.deepEqual(partial.fact.fullRaw, expectedRaw); assert.notEqual(partial.fact.afterAsset.fileRevision, beforeAsset.fileRevision)
  assert.deepEqual(catalog.trackDetail(target.track.id).metadata.raw, expectedRaw)
  const positive = await observeNativeSources(() => f.albums()), anchored = positive.value.items.find(album => album.editionId === edition.id)!
  assert.notEqual(anchored.revision, initial.revision); assert.deepEqual(anchored.artists, []); assert.equal(anchored.year, null)
  const originalMember = (await f.members(anchored)).items[0]!
  assert.deepEqual(originalMember.facts.metadata.raw, expectedRaw); assert.deepEqual(originalMember.facts.metadata.effective, expectedRaw)
  assert.equal(originalMember.facts.asset.fileRevision, partial.fact.afterAsset.fileRevision)
  const capture = await f.inspect(anchored); assert.deepEqual(capture.members[0]!.fact.rawMetadata, expectedRaw); assert.deepEqual(capture.members[0]!.fact.summary.metadata, expectedRaw)
  assert.ok(capture.issues.some(issue => issue.kind === 'missing-metadata' && issue.trackId === target.track.id && issue.fields.includes('artist')))
  assert.ok(positive.observation.statements[0]!.nativeByTrack[target.track.id]!.fields > 0, '缺字段fullRaw真实回退必须经过原native fields，不能制造一个空Map正分支')
  await assert.rejects(f.inspect(initial), errorCode('SNAPSHOT_CHANGED')); report('原SourceWrites非空fullRaw缺字段惰性回退', positive.observation)
  const partialAnchor = catalog.privateSourceWritesRead(view => structuredClone(view.projection.fullRaw.get(target.track.id))); assert.ok(partialAnchor)
  const beforePartialObservation = catalog.privateAlbumBrowserRevision()
  catalog.observeMetadata({ commandId: randomUUID(), trackId: target.track.id, source: 'tag', parserVersion, fields: { artist: '非空锚后艺人', year: '2028' } })
  const mergedRaw = { ...expectedRaw, artist: '非空锚后艺人', year: '2028' }
  assert.notEqual(catalog.privateAlbumBrowserRevision(), beforePartialObservation)
  assert.deepEqual(catalog.metadata(target.track.id), { raw: mergedRaw, override: null, effective: mergedRaw })
  assert.deepEqual(catalog.privateSourceWritesRead(view => view.projection.fullRaw.get(target.track.id)), partialAnchor, '部分观察不改原fullRaw字段或ledgerOrdinal；未提供的title/album仍由真实非空锚点补齐')
  const merged = (await f.albums()).items.find(album => album.id === anchored.id)!
  assert.notEqual(merged.revision, anchored.revision); assert.deepEqual(merged.artists, ['非空锚后艺人']); assert.equal(merged.year, '2028')
  const mergedMember = (await f.members(merged)).items[0]!, mergedCapture = await f.inspect(merged)
  assert.deepEqual(mergedMember.facts.metadata, catalog.metadata(target.track.id)); assert.deepEqual(mergedMember.facts.metadata.raw, mergedRaw)
  assert.deepEqual(mergedCapture.members[0]!.fact.rawMetadata, mergedRaw); assert.deepEqual(mergedCapture.members[0]!.fact.summary.metadata, mergedRaw)
  await assert.rejects(f.inspect(anchored), errorCode('SNAPSHOT_CHANGED'))
  const removed = await publish({ title: { action: 'remove' }, artist: { action: 'remove' }, album: { action: 'remove' }, year: { action: 'remove' }, disc: { action: 'remove' }, track: { action: 'remove' } })
  assert.deepEqual(removed.fact.fullRaw, {}); assert.deepEqual(catalog.trackDetail(target.track.id).metadata.raw, {})
  const emptyAnchor = catalog.privateSourceWritesRead(view => view.projection.fullRaw.get(target.track.id)); assert.ok(emptyAnchor); assert.deepEqual(emptyAnchor.fields, {})
  const empty = (await f.albums()).items.find(album => album.id === anchored.id)!
  assert.notEqual(empty.revision, anchored.revision); assert.deepEqual((await f.members(empty)).items[0]!.facts.metadata.raw, {})
  await assert.rejects(f.inspect(anchored), errorCode('SNAPSHOT_CHANGED'))
  catalog.observeMetadata({ commandId: randomUUID(), trackId: target.track.id, source: 'tag', parserVersion, fields: { artist: '锚后新艺人', year: '2027' } })
  const afterRaw = { artist: '锚后新艺人', year: '2027' }, after = (await f.albums()).items.find(album => album.id === anchored.id)!
  assert.deepEqual(catalog.metadata(target.track.id).raw, afterRaw); assert.deepEqual(after.artists, ['锚后新艺人']); assert.equal(after.year, '2027')
  const firstCommand = randomUUID(), firstOverride = catalog.overrideMetadata({ commandId: firstCommand, trackId: target.track.id, expectedRevision: null, fields: { title: '', artist: 'MB覆盖艺人', album: '' } })
  const overridden = (await f.albums()).items.find(album => album.id === anchored.id)!
  assert.notEqual(overridden.revision, after.revision); assert.deepEqual((await f.members(overridden)).items[0]!.facts.metadata.effective, { ...afterRaw, ...firstOverride.fields })
  assert.deepEqual(catalog.privateWorkbenchMetadataProvenance([target.track.id]), [{ trackId: target.track.id, override: { commandId: firstCommand, revision: firstOverride.revision, fields: firstOverride.fields } }])
  const clearedCommand = randomUUID(), cleared = catalog.overrideMetadata({ commandId: clearedCommand, trackId: target.track.id, expectedRevision: firstOverride.revision, fields: {} })
  const restored = (await f.albums()).items.find(album => album.id === anchored.id)!
  assert.notEqual(restored.revision, overridden.revision); assert.deepEqual((await f.members(restored)).items[0]!.facts.metadata, { raw: afterRaw, override: cleared, effective: afterRaw })
  assert.deepEqual(catalog.privateWorkbenchMetadataProvenance([target.track.id]), [{ trackId: target.track.id, override: { commandId: clearedCommand, revision: cleared.revision, fields: {} } }])
  assert.equal(catalog.observations(target.track.id).length, 3, '锚前原观察仍保留历史，不能删除历史记录来实现fullRaw删除语义')
  assert.equal(api.setPolicy({ datasetId: f.datasetId, commandId: randomUUID(), expectedPolicyRevision: policy().revision, enabled: false }).outcome, 'accepted'); assert.equal(policy().enabled, false)
  const revision = restored.revision, asset = catalog.asset(target.asset.id)
  await f.close()
  const cold = createCollectionRepository({ filePath: f.filePath }), coldOwner = ownerFor(cold)
  try {
    assert.deepEqual(cold.localCatalog.asset(target.asset.id), asset); assert.deepEqual(cold.localCatalog.metadata(target.track.id), { raw: afterRaw, override: cleared, effective: afterRaw })
    const coldAnchor = cold.localCatalog.privateSourceWritesRead(view => view.projection.fullRaw.get(target.track.id)); assert.ok(coldAnchor); assert.deepEqual(coldAnchor.fields, {}); assert.equal(coldAnchor.ledgerOrdinal, emptyAnchor.ledgerOrdinal)
    assert.deepEqual(cold.localCatalog.privateWorkbenchMetadataProvenance([target.track.id]), [{ trackId: target.track.id, override: { commandId: clearedCommand, revision: cleared.revision, fields: {} } }])
    const page = await request('queryAlbums.cold', query(), () => coldOwner.queryAlbums(query())), album = page.items.find(value => value.editionId === edition.id)!
    assert.equal(album.revision, revision)
    const body = { albumKey: album.id, rootId: album.rootId, offset: 0, limit: 1 }, member = await request('queryAlbumTracks.cold', body, () => coldOwner.queryAlbumTracks(body))
    assert.deepEqual(member.items[0]!.facts.metadata, cold.localCatalog.metadata(target.track.id)); assert.equal(member.items[0]!.facts.track.id, target.track.id)
  }
  finally { coldOwner.close(); cold.close() }
})
