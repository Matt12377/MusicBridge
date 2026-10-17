import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { DatabaseSync, StatementSync, type SQLOutputValue } from 'node:sqlite'
import * as dto from '@music-bridge/contracts'
import { createCollectionRepository } from '../src/collection/repository.js'
import { createLocalAlbumOwnerService } from '../src/collection/local-album-browser/owner-port.js'
import { LocalAlbumReadError } from '../src/collection/local-album-browser/grouping.js'
import type { LocalAlbumArtworkReadResult, LocalAlbumNameEnhancementFact } from '../src/collection/local-album-browser/types.js'
import type { LocalAlbumSqlScope } from '../src/collection/local-album-browser/sql-types.js'
import type { ScanPreparedBatch, ScanPreparedItem } from '../src/collection/local-scan-store.js'
import { authorizeSourceDirectory, sourceRootAvailability } from '../src/recording/source-files.js'

/**
 * 本叶通过原Repository、合法catalog/scan API与Owner读链观察真实SQLite。
 * 文件字节及标签/技术/内嵌图描述符是任务自有受控事实，不运行Scanner/Parser或访问用户媒体。
 * native标量、原scan SQL与Owner回复分层计数；不把memo后的codec次数当作SQL只求值一次。
 */
const parserVersion = 'music-metadata-11.15.0/mbrs003-v1'
const albumTitle = '合成扫描专辑'
const query = (changes: Partial<dto.LocalAlbumQuery> = {}): dto.LocalAlbumQuery => ({ query: '', rootId: null, filter: 'all', offset: 0, limit: 200, ...changes })
const artworkRequest = (album: dto.LocalAlbumSummary): dto.LocalAlbumArtworkRequest => ({ albumKey: album.id, rootId: album.rootId, editionId: album.editionId, representativeTrackId: album.representativeTrackId, revision: album.revision })
const errorCode = (code: LocalAlbumReadError['code']) => (error: unknown) => error instanceof LocalAlbumReadError && error.code === code
const fields = (index: number, album = albumTitle): dto.LocalMetadata => ({ title: `合成曲目 ${index}`, artist: '合成艺人', album, year: '2026', disc: '1', track: String(index) })
const countKey = (rootId: unknown, relative: unknown): string => JSON.stringify([rootId, relative])

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

async function fixture(t: TestContext, options: { tracks?: number; embedded?: boolean; trackNamed?: boolean } = {}) {
  installNativeScanObserver626(t)
  const temporary = process.env.TMPDIR
  if (!temporary?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/')) throw new Error('扫描证据测试必须采用外置任务临时目录。')
  const directory = await mkdtemp(path.join(temporary, 'mbf-scan-evidence-')), media = path.join(directory, '自有合成来源')
  await mkdir(media, { mode: 0o700 })
  const repository = createCollectionRepository({ filePath: path.join(directory, 'work.sqlite') })
  let service: ReturnType<typeof createLocalAlbumOwnerService> | undefined
  t.after(async () => { service?.close(); repository.close(); await rm(directory, { recursive: true, force: true }) })
  const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media))
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' })
  const datasetId = randomUUID(), names: LocalAlbumNameEnhancementFact[] = []
  const cover = await readFile(fileURLToPath(new URL('./fixtures/mbrs012-source/owned-cover-16.jpg', import.meta.url)))
  const coverDigest = createHash('sha256').update(cover).digest('hex')
  assert.equal(cover.length, 960)
  assert.equal(coverDigest, '555f7915442690ccb14754bd0da000ceadfbdcfb50b4e3402f55d4806e3e989d')
  const image: dto.LocalArtworkImage = {
    original: { mime: 'image/jpeg', bytes: cover.length, sha256: coverDigest, width: 16, height: 16 },
    display: { mime: 'image/jpeg', bytes: cover.length, sha256: coverDigest, width: 16, height: 16, dataUrl: `data:image/jpeg;base64,${cover.toString('base64')}` },
  }
  const written = new Set<string>()
  async function ownedFile(relative: string): Promise<void> {
    if (written.has(relative)) return
    const file = path.join(media, relative)
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    await writeFile(file, Buffer.from('MBF owned synthetic bytes; no parser or listening evidence'), { flag: 'wx', mode: 0o600 })
    written.add(relative)
  }
  async function signature(relative: string): Promise<string> {
    const info = await stat(path.join(media, relative), { bigint: true })
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':')
  }
  async function accepted(relative: string, raw: dto.LocalMetadata, embedded = options.embedded ?? true, parser = parserVersion): Promise<ScanPreparedItem> {
    await ownedFile(relative)
    return { relative, signature: await signature(relative), parserVersion: parser, outcome: 'accepted', fields: raw, failureCode: null, reused: false,
      readFacts: {
        technical: { container: 'WAVE', codec: 'PCM', lossless: true, sampleRateHz: 48000, channels: 2, bitsPerSample: 16, durationSeconds: 1, evidence: 'bounded-parser-reported' },
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
    const started = repository.localScan.start({ commandId: randomUUID(), datasetId, libraryRootId: current.id, expectedRootRevision: current.revision, parserVersion: items[0]?.parserVersion ?? parserVersion }).job
    const running = repository.localScan.resume({ commandId: randomUUID(), jobId: started.jobId, expectedRevision: started.jobRevision })
    const batch: ScanPreparedBatch = { batchId: randomUUID(), jobId: running.jobId, expectedJobRevision: running.jobRevision, checkpointBefore: running.checkpointRef,
      items, frontier: [], completed: true, ...(cueItems ? { kind: 'cue-sidecars-v1' as const, cueItems } : {}) }
    repository.localScan.privatePrepareBatch({ commandId: randomUUID(), jobId: running.jobId, batch })
    const completed = repository.localScan.privateCommitBatch({ commandId: randomUUID(), jobId: running.jobId, batchId: batch.batchId, expectedRevision: running.jobRevision })
    assert.equal(completed.phase, 'completed')
  }
  const size = options.tracks ?? 65
  const relatives = Array.from({ length: size }, (_, index) => `扫描目录/${options.trackNamed && index === size - 1 ? 'Track' : ''}${String(index + 1).padStart(3, '0')}.wav`)
  await commit(await Promise.all(relatives.map((relative, index) => accepted(relative, fields(index + 1)))))
  const tracks = relatives.map(relative => {
    const scan = repository.localScan.privateFileState(root.id, relative)!.value
    assert.equal(scan.outcome, 'accepted'); assert.ok(scan.trackId && scan.assetId)
    return { relative, track: repository.localCatalog.track(scan.trackId), asset: repository.localCatalog.asset(scan.assetId), scan }
  })
  async function rootViews(): Promise<dto.LocalRootView[]> {
    return Promise.all(repository.localCatalog.roots().map(async current => ({ root: current, label: '自有合成来源', availability: await sourceRootAvailability(repository.sources.root(current.sourceRootId)) })))
  }
  let artworkReader: () => Promise<LocalAlbumArtworkReadResult> = async () => ({ image: null, status: 'ready' })
  service = createLocalAlbumOwnerService({ repository, assertCurrent() {}, readRootViews: rootViews,
    // NULL只用于验证按需观察与迟到围栏；真实persisted选图由原stage/apply API测试。
    readArtwork: () => artworkReader(), nameEnhancements: { revision: () => createHash('sha256').update(JSON.stringify(names)).digest('hex'), read: () => names } })
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
  const artwork = (album: dto.LocalAlbumSummary) => {
    const body = artworkRequest(album)
    return request('getArtwork', body, () => owner.getArtwork(body))
  }
  function edition(label: string, members: readonly { track: dto.LocalTrack }[]) {
    const value = repository.localCatalog.createEdition({ commandId: randomUUID(), title: '扫描证据发行', edition: label })
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
  return { repository, root, directory, media, coverDigest, image, tracks, names, owner, rootViews, accepted, rejected, commit, signature, ownedFile, edition, manualTrack,
    albums, members, inspect, artwork, setArtworkReader(value: typeof artworkReader) { artworkReader = value } }
}

interface ScanObservation {
  nativeBySource: Record<string, number>
  nativeEvents: { rootId: string; relative: string; ordinal: number }[]
  registrations: { originalArity: number; wrappedArity: number }[]
  scanSqlBySource: Record<string, { locator: number; direct: number; fallback: number }>
  projectionStatements: number
  projectionRows: number
}
type ScanRegistration626 = { originalArity: number; wrappedArity: number }
interface NativeScanObserverState626 {
  owner: TestContext
  observation?: ScanObservation | undefined
  registrations?: Set<ScanRegistration626> | undefined
  active?: { statement: StatementSync; database: DatabaseSync } | undefined
}
let observing = false
let nativeScanObserver626: NativeScanObserverState626 | undefined

function installNativeScanObserver626(t: TestContext): void {
  if (nativeScanObserver626) { assert.equal(nativeScanObserver626.owner, t, 'prototype观测只能复用本测试生命周期'); return }
  const state: NativeScanObserverState626 = { owner: t }
  const owners = new WeakMap<StatementSync, DatabaseSync>()
  const functionDescriptor = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, 'function')!
  const prepareDescriptor = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, 'prepare')!
  const originalFunction = DatabaseSync.prototype.function, originalPrepare = DatabaseSync.prototype.prepare
  const methods = (['get', 'all', 'iterate'] as const).map(method => ({ method, descriptor: Object.getOwnPropertyDescriptor(StatementSync.prototype, method)! }))
  function register(registration: ScanRegistration626): void {
    const observation = state.observation
    if (!observation) return
    assert.ok(state.registrations, '活动window必须保留实际UDF注册集合')
    if (!state.registrations.has(registration)) { state.registrations.add(registration); observation.registrations.push({ ...registration }) }
  }
  const observedFunction = function (this: DatabaseSync, ...args: unknown[]) {
    let registration: ScanRegistration626 | undefined
    if (args[0] === 'mb_album_scan') {
      const database = this, callback = args[args.length - 1]
      assert.equal(typeof callback, 'function')
      const invoke = callback as (rootId: SQLOutputValue, relative: SQLOutputValue) => SQLOutputValue
      assert.equal(invoke.length, 2, '原真实mb_album_scan必须保持二参数SQLite arity')
      // 原二参数callback只查当前活动window，不捕获已完成的observation。
      const counted = function (this: unknown, rootId: SQLOutputValue, relative: SQLOutputValue): SQLOutputValue {
        const observation = state.observation, execution = state.active
        if (observation) {
          if (execution) assert.equal(execution.database, database, '扫描native必须属于原Statement的Database')
          register(registration!)
          const key = countKey(rootId, relative)
          observation.nativeBySource[key] = (observation.nativeBySource[key] ?? 0) + 1
          observation.nativeEvents.push({ rootId: String(rootId), relative: String(relative), ordinal: observation.nativeEvents.length + 1 })
        }
        return Reflect.apply(invoke, this, [rootId, relative]) as SQLOutputValue
      }
      registration = { originalArity: invoke.length, wrappedArity: counted.length }
      assert.equal(registration.wrappedArity, registration.originalArity)
      args[args.length - 1] = counted
    }
    const result = Reflect.apply(originalFunction, this, args)
    if (registration) register(registration)
    return result
  }
  const observedPrepare = function (this: DatabaseSync, ...args: Parameters<DatabaseSync['prepare']>) {
    const statement = Reflect.apply(originalPrepare, this, args) as StatementSync
    // prepare只登记原Statement归属；不把prepare次数冒充SQL执行次数。
    owners.set(statement, this)
    return statement
  }
  Object.defineProperty(observedFunction, 'length', { value: originalFunction.length })
  Object.defineProperty(observedPrepare, 'length', { value: originalPrepare.length })
  assert.equal(observedFunction.length, originalFunction.length); assert.equal(observedPrepare.length, originalPrepare.length)
  const wrapped = methods.map(({ method, descriptor }) => {
    const original = descriptor.value as (...bindings: unknown[]) => unknown
    const observed = function (this: StatementSync, ...bindings: unknown[]) {
      const database = owners.get(this)
      if (!database) return Reflect.apply(original, this, bindings)
      const text = this.sourceSQL.replace(/\s+/gu, ' ').trim(), projection = text.includes('envelope FROM counts')
      const kind = text === 'SELECT id FROM local_catalog_assets WHERE root_id=? AND relative=? LIMIT 2' ? 'locator'
        : text === 'SELECT * FROM local_scan_file_state WHERE library_root_id=? AND relative=?' ? 'direct'
          : text.startsWith('SELECT s.* FROM local_catalog_assets a JOIN local_scan_file_state s ON s.asset_id=a.id') ? 'fallback' : null
      const execution = { statement: this, database }
      function begin(observation: ScanObservation): void {
        if (projection) observation.projectionStatements++
        if (kind) { const key = countKey(bindings[0], bindings[1]); const reads = observation.scanSqlBySource[key] ??= { locator: 0, direct: 0, fallback: 0 }; reads[kind]++ }
      }
      const withinStatement = <V>(action: () => V): V => { const previous = state.active; state.active = execution; try { return action() } finally { state.active = previous } }
      if (method === 'iterate') {
        const iterator = withinStatement(() => Reflect.apply(original, this, bindings)) as Iterator<unknown> & Iterable<unknown>
        const started = new WeakSet<ScanObservation>()
        // 不提前取行或持有window；每个原cursor真实next/return/throw都读取当时活动window。
        const observedIterator: Iterator<unknown> & Iterable<unknown> = new Proxy(iterator, { get(cursor, stepName) {
          if (stepName === Symbol.iterator) return () => observedIterator
          const step = Reflect.get(cursor, stepName, cursor)
          if (typeof step !== 'function') return step
          if (stepName === 'next' || stepName === 'return' || stepName === 'throw') {
            const observedStep = (...args: unknown[]) => {
              const observation = state.observation
              if (stepName === 'next' && observation && !started.has(observation)) { started.add(observation); begin(observation) }
              return withinStatement(() => {
                const result = Reflect.apply(step, cursor, args) as IteratorResult<unknown>
                if (stepName === 'next' && observation && projection && !result.done) observation.projectionRows++
                return result
              })
            }
            Object.defineProperty(observedStep, 'length', { value: step.length }); assert.equal(observedStep.length, step.length)
            return observedStep
          }
          return step.bind(cursor)
        } })
        return observedIterator
      }
      const observation = state.observation
      if (observation) begin(observation)
      return withinStatement(() => {
        const result = Reflect.apply(original, this, bindings)
        if (observation && projection) {
          if (method === 'all') { assert.ok(Array.isArray(result), '原SQLite all必须返回行数组'); observation.projectionRows += result.length }
          else observation.projectionRows += result === undefined ? 0 : 1
        }
        return result
      })
    }
    Object.defineProperty(observed, 'length', { value: original.length }); assert.equal(observed.length, original.length)
    return { method, descriptor, observed }
  })
  nativeScanObserver626 = state
  Object.defineProperty(DatabaseSync.prototype, 'function', { ...functionDescriptor, value: observedFunction })
  Object.defineProperty(DatabaseSync.prototype, 'prepare', { ...prepareDescriptor, value: observedPrepare })
  for (const { method, descriptor, observed } of wrapped) Object.defineProperty(StatementSync.prototype, method, { ...descriptor, value: observed })
  t.after(() => {
    try {
      assert.equal(state.observation, undefined); assert.equal(state.registrations, undefined); assert.equal(state.active, undefined)
      assert.equal(DatabaseSync.prototype.function, observedFunction); assert.equal(DatabaseSync.prototype.prepare, observedPrepare)
      for (const { method, observed } of wrapped) assert.equal(StatementSync.prototype[method], observed)
    } finally {
      Object.defineProperty(DatabaseSync.prototype, 'function', functionDescriptor)
      Object.defineProperty(DatabaseSync.prototype, 'prepare', prepareDescriptor)
      for (const { method, descriptor } of wrapped) Object.defineProperty(StatementSync.prototype, method, descriptor)
      nativeScanObserver626 = undefined; observing = false
    }
  })
}

async function observeNativeScans<T>(action: () => Promise<T>): Promise<{ value: T; observation: ScanObservation }> {
  assert.equal(observing, false, 'prototype观测不得交叠')
  assert.ok(nativeScanObserver626, '必须先沿本测试真实fixture安装观察器')
  const state = nativeScanObserver626
  const observation: ScanObservation = { nativeBySource: {}, nativeEvents: [], registrations: [], scanSqlBySource: {}, projectionStatements: 0, projectionRows: 0 }
  observing = true; state.observation = observation; state.registrations = new Set()
  try { return { value: await action(), observation } }
  finally { state.observation = undefined; state.registrations = undefined; observing = false; assert.equal(state.active, undefined) }
}

test('MBF扫描证据：真实Owner的65轨超过memo容量，同轨增加发行关系不增加成员native求值', { concurrency: false }, async t => {
  const f = await fixture(t), catalog = f.repository.localCatalog, target = f.tracks[64]!
  const editionA = f.edition('原版', f.tracks)
  const rejectedRelative = '独立拒收/unsupported.bin'
  await f.commit([await f.rejected(rejectedRelative)])
  const before = await observeNativeScans(() => f.albums())
  const initial = before.value.items.find(album => album.editionId === editionA.id)!
  assert.equal(initial.trackCount, 65); assert.equal(initial.title, editionA.title); assert.deepEqual(initial.artists, ['合成艺人'])
  assert.equal(initial.year, '2026'); assert.equal(initial.versionLabel, '原版'); assert.equal(initial.artworkState, 'available')
  assert.deepEqual(before.value.counts, { all: 2, 'missing-artwork': 0, 'has-artwork': 1, 'cue-unsplit': 0, 'metadata-issue': 0, 'parse-failed': 0, 'loose-audio': 0, 'track-named-audio': 0, 'missing-lyrics': 0 })
  const tail = await f.members(initial, 64, 1), captured = await f.inspect(initial)
  assert.equal(tail.items[0]!.facts.track.id, target.track.id); assert.equal(tail.items[0]!.sequence, 65); assert.equal(tail.hasMore, false)
  assert.deepEqual(captured.members.map(member => member.fact.summary.track.id), f.tracks.map(value => value.track.id)); assert.equal(captured.members.length, 65)
  assert.deepEqual(captured.issues, []); assert.deepEqual(captured.rejectedFiles, [])
  const editionB = f.edition('再版', [target])
  const after = await observeNativeScans(() => f.albums())
  assert.equal(after.value.total, 3); assert.equal(after.value.counts['has-artwork'], 2)
  assert.deepEqual(after.value.items.find(album => album.editionId === editionA.id), initial, '另一发行关系不改原发行的完整summary/revision')
  for (const [editionId, count] of [[editionA.id, 65], [editionB.id, 1]] as const) {
    const album = after.value.items.find(value => value.editionId === editionId)!
    assert.equal(album.trackCount, count); assert.equal(album.rootId, f.root.id)
    const member = (await f.members(album, count - 1, 1)).items[0]!
    assert.deepEqual(member.facts.track, catalog.track(target.track.id)); assert.deepEqual(member.facts.asset, catalog.asset(target.asset.id))
    assert.deepEqual(member.facts.metadata, catalog.metadata(target.track.id)); assert.equal(member.facts.fileParameters?.sampleRateHz, 48000)
  }
  const zero = after.value.items.find(album => album.trackCount === 0)!, zeroCapture = await f.inspect(zero)
  assert.equal(zero.representativeTrackId, null); assert.deepEqual(zeroCapture.members, []); assert.deepEqual(zeroCapture.issues, [])
  assert.deepEqual(zeroCapture.rejectedFiles!.map(value => value.relative), [rejectedRelative])
  const key = countKey(f.root.id, target.relative), rejectedKey = countKey(f.root.id, rejectedRelative)
  for (const observed of [before.observation, after.observation]) {
    assert.deepEqual(observed.registrations, [{ originalArity: 2, wrappedArity: 2 }])
    assert.equal(observed.projectionStatements, 1); assert.equal(observed.projectionRows, 1)
    assert.ok(observed.nativeBySource[key]! > 0, '必须观测目标轨真实native回调，不能以两个缺失计数相等通过')
    assert.ok(Object.keys(observed.scanSqlBySource).length >= 65, '实际原resolver必须覆盖超过32个互异来源，不只测memo中的头部')
    assert.ok(observed.nativeBySource[rejectedKey]! > 0, 'scan_files拒收链的额外native读取必须记入，不以全request=65冒充成员一次')
  }
  process.stdout.write(JSON.stringify({ 事件: '扫描证据真实分层计数', 基础来源数: 65, 目标轨道: target.track.id, 目标位置: target.relative,
    关系数: { before: 1, after: 2 }, native回调: { before: before.observation.nativeBySource[key], after: after.observation.nativeBySource[key] },
    原scanSQL: { before: before.observation.scanSqlBySource[key], after: after.observation.scanSqlBySource[key] },
    拒收链native额外调用: { before: before.observation.nativeBySource[rejectedKey], after: after.observation.nativeBySource[rejectedKey] },
    全部native计数: { before: before.observation.nativeBySource, after: after.observation.nativeBySource },
    边界: '比较同基础来源的关系扇出；scan_files/CUE及不同SQL statement仍可独立读取。不是性能或300k资格。' }) + '\n')
  // 旧实现在同轨两发行上展开scan_json五个引用；旧memo只合并codec，不能消除native回调增长。
  assert.equal(after.observation.nativeBySource[key], before.observation.nativeBySource[key], '同一基础轨增加发行关系，不应再次求值成员扫描证据；拒收链的独立额外读取保持相同')
})

test('MBF扫描证据：真实Owner完整七类counts、零轨issues、搜索和跨页；unknown按需缺图后才计数', { concurrency: false }, async t => {
  const f = await fixture(t, { tracks: 3, trackNamed: true })
  await f.commit([await f.accepted('Track004.wav', fields(4, '散落原标签'), false), await f.rejected('元数据失败/01.bin', 'PARSE_FAILED'), await f.rejected('普通拒收/01.bin')])
  const unknown = await f.manualTrack('待探测/01.wav', fields(5, '尚未探测专辑'))
  const cueRelative = '空CUE/album.cue'; await f.ownedFile(cueRelative)
  await f.commit([], [{ relative: cueRelative, signature: await f.signature(cueRelative), parserVersion: 'cue-text-75fps/mbrs003-v1', outcome: 'rejected', failureCode: 'CUE_PARSE_FAILED', reused: false, previousSnapshotId: null, result: null }])
  f.names.push({ rootId: f.root.id, directory: '元数据失败', revision: 'synthetic-name-failed-v1', state: 'failed' }, { rootId: f.root.id, directory: '普通拒收', revision: 'synthetic-name-cancelled-v1', state: 'cancelled' })
  const all = await f.albums()
  const expected: dto.LocalAlbumFilterCounts = { all: 6, 'missing-artwork': 0, 'has-artwork': 1, 'cue-unsplit': 1, 'metadata-issue': 1, 'parse-failed': 1, 'loose-audio': 1, 'track-named-audio': 2, 'missing-lyrics': 0 }
  assert.deepEqual(all.counts, expected); assert.equal(all.total, 6)
  const scope: LocalAlbumSqlScope = { revision: f.owner.getCacheInfo().revision!, roots: await f.rootViews(), nameEnhancements: f.names }
  const privatePage = await request('privateAlbumBrowserQuery', query(), () => f.repository.localCatalog.privateAlbumBrowserQuery(query(), scope))
  assert.deepEqual(privatePage, all, 'Owner必须消费原guarded SQL真实页，不用另一个toy投影补齐结果')
  const a = await f.albums(query({ limit: 2 })), b = await f.albums(query({ offset: 2, limit: 2 })), aAgain = await f.albums(query({ limit: 2 }))
  assert.deepEqual(a, aAgain); assert.deepEqual(a.items, all.items.slice(0, 2)); assert.deepEqual(b.items, all.items.slice(2, 4)); assert.deepEqual(a.counts, expected)
  const empty = await f.albums(query({ offset: 200, limit: 2 })); assert.deepEqual(empty.items, []); assert.equal(empty.total, 6); assert.deepEqual(empty.counts, expected)
  const searched = await f.albums(query({ query: albumTitle })); assert.equal(searched.total, 1); assert.equal(searched.items[0]!.trackCount, 3)
  for (const status of dto.LOCAL_ALBUM_STATUSES) {
    const filtered = await f.albums(query({ filter: status }))
    assert.equal(filtered.total, expected[status]); assert.deepEqual(filtered.counts, expected); assert.ok(filtered.items.every(album => album.statuses.includes(status)))
  }
  const failures = all.items.find(album => album.statuses.includes('metadata-issue'))!, failedCapture = await f.inspect(failures)
  assert.equal(failures.trackCount, 0); assert.equal(failures.representativeTrackId, null)
  assert.deepEqual(failedCapture.members, []); assert.ok(failedCapture.issues.some(issue => issue.kind === 'metadata-read-failed' && issue.relative === '元数据失败/01.bin'))
  assert.ok(failedCapture.issues.some(issue => issue.kind === 'name-enhancement-failed')); assert.deepEqual(failedCapture.rejectedFiles!.map(value => value.relative), ['元数据失败/01.bin'])
  const cue = all.items.find(album => album.statuses.includes('cue-unsplit'))!, cueCapture = await f.inspect(cue)
  assert.deepEqual(cueCapture.issues, [{ kind: 'cue', relative: cueRelative, status: 'failed' }]); assert.deepEqual(cueCapture.members, [])
  const awaiting = all.items.find(album => album.representativeTrackId === unknown.track.id)!
  assert.equal(awaiting.artworkState, 'unknown'); assert.deepEqual((await f.artwork(awaiting)).image, null)
  const missing = await f.albums(query({ filter: 'missing-artwork' })), confirmed = missing.items[0]!
  assert.equal(missing.total, 1); assert.equal(confirmed.id, awaiting.id); assert.equal(confirmed.artworkState, 'missing'); assert.notEqual(confirmed.revision, awaiting.revision)
  await assert.rejects(f.artwork(awaiting), errorCode('SNAPSHOT_CHANGED'))
  f.repository.localCatalog.observeMetadata({ commandId: randomUUID(), trackId: f.tracks[0]!.track.id, source: 'tag', parserVersion, fields: { title: '独立来源水位变化' } })
  const refreshed = await f.albums(); assert.equal(refreshed.counts['missing-artwork'], 0); assert.equal(refreshed.items.find(album => album.id === awaiting.id)!.artworkState, 'unknown')
  await assert.rejects(f.artwork(confirmed), errorCode('SNAPSHOT_CHANGED'))
})

test('MBF扫描证据：真实部分raw历史和MB override完整保留；原扫描签名/解析器/封面变化拒旧捕获', { concurrency: false }, async t => {
  const f = await fixture(t, { tracks: 2 }), target = f.tracks[1]!, catalog = f.repository.localCatalog, edition = f.edition('事实版本', [target])
  const initial = (await f.albums()).items.find(album => album.editionId === edition.id)!
  catalog.observeMetadata({ commandId: randomUUID(), trackId: target.track.id, source: 'tag', parserVersion, fields: { artist: '后来的原艺人' } })
  const override = catalog.overrideMetadata({ commandId: randomUUID(), trackId: target.track.id, expectedRevision: null, fields: { title: 'MB更正题名', album: 'MB更正专辑', year: '2030', disc: '2', track: '9' } })
  const current = (await f.albums()).items.find(album => album.editionId === edition.id)!
  assert.equal(current.id, initial.id); assert.notEqual(current.revision, initial.revision); assert.deepEqual(current.artists, ['后来的原艺人']); assert.equal(current.year, '2030')
  const member = (await f.members(current)).items[0]!, raw = { ...fields(2), artist: '后来的原艺人' }
  assert.deepEqual(member.facts.metadata.raw, raw); assert.deepEqual(member.facts.metadata.override, override); assert.deepEqual(member.facts.metadata.effective, { ...raw, ...override.fields })
  assert.deepEqual(member.facts, { ...catalog.trackDetail(target.track.id), fileParameters: member.facts.fileParameters }); assert.equal(catalog.observations(target.track.id).length, 2)
  await assert.rejects(f.inspect(initial), errorCode('SNAPSHOT_CHANGED')); await assert.rejects(f.artwork(initial), errorCode('SNAPSHOT_CHANGED'))
  // raw值被override遮盖，仍须进入原完整source digest；不是只hash卡片显示字段。
  catalog.observeMetadata({ commandId: randomUUID(), trackId: target.track.id, source: 'tag', parserVersion, fields: { title: '被MB字段遮盖的新原题名' } })
  const rawChanged = (await f.albums()).items.find(album => album.id === current.id)!
  assert.notEqual(rawChanged.revision, current.revision); assert.equal((await f.members(rawChanged)).items[0]!.facts.metadata.effective.title, 'MB更正题名')
  await assert.rejects(f.inspect(current), errorCode('SNAPSHOT_CHANGED'))
  const beforeScan = f.repository.localScan.privateAlbumBrowserRevision()
  await f.commit([await f.accepted(target.relative, {}, false)])
  assert.notEqual(f.repository.localScan.privateAlbumBrowserRevision(), beforeScan)
  const noCover = (await f.albums()).items.find(album => album.id === current.id)!
  assert.equal(noCover.artworkState, 'unknown'); assert.equal(noCover.artworkAvailable, false); assert.notEqual(noCover.revision, rawChanged.revision)
  const state = f.repository.localScan.privateFileState(f.root.id, target.relative)!.value
  assert.equal(state.signature, target.scan.signature); assert.equal(state.parserVersion, parserVersion); assert.deepEqual(state.readFacts!.coverEvidence, [])
  const noCoverMember = (await f.members(noCover)).items[0]!
  assert.equal(noCoverMember.facts.asset.id, target.asset.id); assert.equal(noCoverMember.facts.asset.fileRevision, target.asset.fileRevision, '相同签名/解析器下仅扫描封面事实改变，不靠资产修订变化代验')
  await assert.rejects(f.inspect(rawChanged), errorCode('SNAPSHOT_CHANGED'))
  await f.commit([await f.accepted(target.relative, {}, false, 'music-metadata-11.15.0/mbrs003-v2')])
  const parserChanged = (await f.albums()).items.find(album => album.id === current.id)!
  const parserState = f.repository.localScan.privateFileState(f.root.id, target.relative)!.value
  assert.equal(parserState.parserVersion, 'music-metadata-11.15.0/mbrs003-v2'); assert.notEqual(parserChanged.revision, noCover.revision)
  await assert.rejects(f.inspect(noCover), errorCode('SNAPSHOT_CHANGED'))
  await writeFile(path.join(f.media, target.relative), Buffer.from(' owned signature revision'), { flag: 'a' })
  await f.commit([await f.accepted(target.relative, {}, false, 'music-metadata-11.15.0/mbrs003-v2')])
  const signatureChanged = (await f.albums()).items.find(album => album.id === current.id)!
  assert.notEqual(f.repository.localScan.privateFileState(f.root.id, target.relative)!.value.signature, parserState.signature)
  assert.notEqual(signatureChanged.revision, parserChanged.revision); assert.equal(signatureChanged.id, parserChanged.id)
  await assert.rejects(f.inspect(parserChanged), errorCode('SNAPSHOT_CHANGED'))
})

test('MBF扫描证据：同source资产移动复用原旧位置resolver；另一轨资产的embedded不能越过track匹配', { concurrency: false }, async t => {
  const f = await fixture(t, { tracks: 2 }), target = f.tracks[1]!, other = f.tracks[0]!, catalog = f.repository.localCatalog
  const edition = f.edition('移动与选择', [target]), before = (await f.albums()).items.find(album => album.editionId === edition.id)!
  const movedRelative = '移动后/02.wav'; await mkdir(path.dirname(path.join(f.media, movedRelative)), { recursive: true })
  await rename(path.join(f.media, target.relative), path.join(f.media, movedRelative))
  const moved = catalog.moveAsset({ commandId: randomUUID(), assetId: target.asset.id, expectedLocationRevision: target.asset.locationRevision, expectedRootRevision: catalog.root(f.root.id).revision, relative: movedRelative })
  const observed = await observeNativeScans(() => f.albums()), current = observed.value.items.find(album => album.editionId === edition.id)!
  assert.equal(current.id, before.id); assert.notEqual(current.revision, before.revision); assert.equal(current.artworkState, 'available')
  assert.equal(f.repository.localScan.privateFileState(f.root.id, movedRelative), null)
  assert.equal(f.repository.localScan.privateFileState(f.root.id, target.relative)!.value.assetId, moved.id)
  assert.ok(observed.observation.scanSqlBySource[countKey(f.root.id, movedRelative)]!.fallback > 0, '必须走原当前locator→同asset/track的历史位置回溯，不用direct-only替身')
  const member = (await f.members(current)).items[0]!
  assert.equal(member.facts.track.id, target.track.id); assert.deepEqual(member.facts.asset, moved)
  assert.equal((await f.inspect(current)).members[0]!.fact.relative, movedRelative)
  await assert.rejects(f.artwork(before), errorCode('SNAPSHOT_CHANGED'))
  catalog.selectAsset({ commandId: randomUUID(), trackId: target.track.id, expectedSelectionRevision: catalog.track(target.track.id).selectionRevision, assetId: other.asset.id })
  const selected = (await f.albums()).items.find(album => album.editionId === edition.id)!
  assert.equal(selected.id, current.id); assert.equal(selected.artworkState, 'unknown'); assert.equal(selected.artworkAvailable, false)
  assert.ok(!selected.statuses.includes('has-artwork') && !selected.statuses.includes('missing-artwork'))
  const selectedMember = (await f.members(selected)).items[0]!
  assert.equal(selectedMember.facts.asset.id, other.asset.id); assert.equal(selectedMember.facts.track.id, target.track.id); assert.equal(selectedMember.facts.fileParameters, null)
  assert.equal(f.repository.localScan.privateFileState(f.root.id, other.relative)!.value.trackId, other.track.id)
  await assert.rejects(f.inspect(current), errorCode('SNAPSHOT_CHANGED'))
})

test('MBF扫描证据：真实persisted选图revision与异步期间原ledger水位均拒旧封面回复', { concurrency: false }, async t => {
  const f = await fixture(t, { tracks: 1, embedded: false }), target = f.tracks[0]!, edition = f.edition('手选封面', [target])
  const before = (await f.albums()).items.find(album => album.editionId === edition.id)!
  assert.equal(before.artworkState, 'unknown')
  const context = f.repository.localArtwork.context({ trackId: target.track.id, editionId: edition.id }); assert.ok(context.target)
  const staged = f.repository.localArtwork.stage({ target: context.target, origin: 'manual', sourceIdentity: f.coverDigest, sourceLabel: '自有合成图片', image: f.image })
  const candidate = staged.candidates[0]!
  const first = f.repository.localArtwork.apply({ commandId: randomUUID(), target: context.target, candidateId: candidate.id, expectedSelectionRevision: null })
  const selected = (await f.albums()).items.find(album => album.editionId === edition.id)!
  assert.equal(selected.artworkState, 'available'); assert.notEqual(selected.revision, before.revision); await assert.rejects(f.artwork(before), errorCode('SNAPSHOT_CHANGED'))
  const currentTarget = f.repository.localArtwork.context({ trackId: target.track.id, editionId: edition.id }).target!
  const second = f.repository.localArtwork.apply({ commandId: randomUUID(), target: currentTarget, candidateId: candidate.id, expectedSelectionRevision: first.revision })
  assert.notEqual(second.revision, first.revision); assert.equal(second.candidate!.display.sha256, first.candidate!.display.sha256)
  const sameImageNewVersion = (await f.albums()).items.find(album => album.editionId === edition.id)!
  assert.notEqual(sameImageNewVersion.revision, selected.revision, '同图片内容再次明确应用仍保留真实selection revision')
  await assert.rejects(f.artwork(selected), errorCode('SNAPSHOT_CHANGED'))
  let resolve!: (result: LocalAlbumArtworkReadResult) => void, enter!: () => void, reads = 0
  const blocked = new Promise<LocalAlbumArtworkReadResult>(accept => { resolve = accept })
  const entered = new Promise<void>(accept => { enter = accept })
  f.setArtworkReader(async () => { reads++; enter(); return blocked })
  const waiting = f.artwork(sameImageNewVersion)
  // 实际availability包含异步文件系统检查，setImmediate不能证明读器已进入。
  // 原请求提前失败必须原样暴露；提前成功也不能被当作进入信号。
  const completed = waiting.then(() => ({ stage: 'completed' as const }), (error: unknown) => ({ stage: 'rejected' as const, error }))
  const firstSignal = await Promise.race([entered.then(() => ({ stage: 'entered' as const })), completed])
  if (firstSignal.stage === 'rejected') throw firstSignal.error
  assert.equal(firstSignal.stage, 'entered', '必须实际进入原Owner封面读器，不能用请求提前完成冒充迟到围栏')
  assert.equal(reads, 1)
  const beforeWatermark = f.repository.localCatalog.privateAlbumBrowserRevision()
  f.repository.localCatalog.createEdition({ commandId: randomUUID(), title: '只推进真实来源水位的独立发行', edition: '' })
  assert.notEqual(f.repository.localCatalog.privateAlbumBrowserRevision(), beforeWatermark)
  resolve({ image: null, status: 'ready' })
  await assert.rejects(waiting, errorCode('SNAPSHOT_CHANGED'))
  assert.equal(f.owner.getCacheInfo().observationCount, 0)
  const after = (await f.albums()).items.find(album => album.editionId === edition.id)!
  assert.equal(after.artworkState, 'available'); assert.equal(after.revision, sameImageNewVersion.revision, '无成员的独立发行未伪造本组事实变化；迟到拒绝来自全局lease')
})
