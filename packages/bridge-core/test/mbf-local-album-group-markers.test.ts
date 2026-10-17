import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync, StatementSync, type SQLOutputValue } from 'node:sqlite'
import * as dto from '@music-bridge/contracts'
import { createCollectionRepository, type CollectionRepository } from '../src/collection/repository.js'
import { createLocalAlbumOwnerService } from '../src/collection/local-album-browser/owner-port.js'
import { LocalAlbumReadError } from '../src/collection/local-album-browser/grouping.js'
import type { LocalAlbumNameEnhancementFact } from '../src/collection/local-album-browser/types.js'
import type { ScanPreparedBatch, ScanPreparedItem } from '../src/collection/local-scan-store.js'
import { extractVersionTokens } from '../src/library/local-name-rules.js'
import { authorizeSourceDirectory, sourceRootAvailability } from '../src/recording/source-files.js'

/**
 * 真Repository/合法scan批次/原Owner，不导入旧测试或替换原SQL/codec。
 * 自有文件签名是真stat；初始标签、技术和embedded描述符是受控scan事实，不是Parser/播放证明。
 * key次数在原arity=5的native回调计数；JSON记录每条实际SQLite statement的完整返回行。
 * 可保留同一owned库后由新Source只读冷开复读，逐字节比较原回复及gallery/find/member rows。
 */
const externalTemporaryRoot = '/Volumes/LifeWeave/Developer/CommandLine/tmp/'
const parserVersion = 'music-metadata-11.15.0/mbrs003-v1'
const albumTitle = '分组标记合成专辑'
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const bytesHash = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex')
const parent = (relative: string): string => relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : ''
const fields = (index: number, album = albumTitle): dto.LocalMetadata => ({ title: `普通曲目 ${index}`, artist: '合成艺人', album, year: '2026', disc: '1', track: String(index) })
const query = (changes: Partial<dto.LocalAlbumQuery> = {}): dto.LocalAlbumQuery => ({ query: '', rootId: null, filter: 'all', offset: 0, limit: 200, ...changes })
const code = (value: LocalAlbumReadError['code']) => (error: unknown) => error instanceof LocalAlbumReadError && error.code === value
const versionTokens = (raw: dto.LocalMetadata): dto.VersionNameToken[] => (['title', 'artist', 'album'] as const).flatMap(source => raw[source] ? extractVersionTokens(raw[source]!, source) : []).slice(0, 64)
const albumVersions = (raw: dto.LocalMetadata): string[] => [...new Set(versionTokens(raw).filter(token => token.source === 'album' && (token.kind === 'edition' || token.kind === 'format')).map(token => token.raw))].sort()
const directoryId = (rootId: string, relative: string, raw: dto.LocalMetadata): string => `directory-${hash([rootId, parent(relative), parent(relative) === '' ? '' : raw.album?.trim() ?? '', parent(relative) === '' ? [] : albumVersions(raw)])}`
const tuple = (...values: SQLOutputValue[]): string => JSON.stringify(values)
const replayPath = process.env.MBF_GROUP_MARKERS_REPLAY

let requestSequence = 0
async function request<T>(command: string, body: unknown, action: () => T | Promise<T>): Promise<T> {
  const id = ++requestSequence, start = performance.now()
  process.stdout.write(JSON.stringify({ 事件: '容量请求', 状态: '开始', id, command, request: body }) + '\n')
  let outcome = '通过', publicCode: LocalAlbumReadError['code'] | undefined
  try { return await action() }
  catch (error) { outcome = '失败'; if (error instanceof LocalAlbumReadError) publicCode = error.code; throw error }
  finally { process.stdout.write(JSON.stringify({ 事件: '容量请求', 状态: '结束', id, command, 结果: outcome, 耗时毫秒: performance.now() - start, ...(publicCode ? { code: publicCode } : {}) }) + '\n') }
}

interface OwnedRoot { root: dto.LibraryRoot; media: string; label: string }
interface Member { rootId: string; relative: string; track: dto.LocalTrack; asset: dto.AudioAsset; raw: dto.LocalMetadata }
function ownerFor(repository: CollectionRepository, labels: readonly { rootId: string; label: string }[], names: LocalAlbumNameEnhancementFact[] = []) {
  return createLocalAlbumOwnerService({ repository, assertCurrent() {},
    readRootViews: () => Promise.all(repository.localCatalog.roots().map(async root => ({ root, label: labels.find(value => value.rootId === root.id)!.label, availability: await sourceRootAvailability(repository.sources.root(root.sourceRootId)) }))),
    // 受控NULL只覆盖Core按需观察；这里没有Main图片归一化或真实库读取资格主张。
    readArtwork: async () => ({ image: null, status: 'ready' }), nameEnhancements: { revision: () => hash(names), read: () => names } })
}
async function fixture(t: TestContext) {
  installMarkerObserver(t)
  const temporary = process.env.MBF_GROUP_MARKERS_EVIDENCE_DIR ?? process.env.TMPDIR
  assert.ok(temporary && temporary.startsWith(externalTemporaryRoot), '分组标记测试只采用外置任务临时目录')
  const base = await lstat(temporary); assert.ok(base.isDirectory() && !base.isSymbolicLink()); assert.equal(await realpath(temporary), temporary.replace(/\/$/u, ''))
  const directory = await mkdtemp(path.join(temporary, 'mbf-group-markers-')), filePath = path.join(directory, 'work.sqlite')
  const repository = createCollectionRepository({ filePath }), roots: OwnedRoot[] = [], labels: { rootId: string; label: string }[] = [], names: LocalAlbumNameEnhancementFact[] = []
  let service: ReturnType<typeof createLocalAlbumOwnerService> | undefined, retained = false
  t.after(async () => {
    service?.close(); repository.close()
    if (!retained) { await rm(directory, { recursive: true, force: true }); return }
    // 最后一个原连接关闭后再封印主库，不能把open状态下尚在WAL中的事实当主库身份。
    const [database, manifest, replies, observations] = await Promise.all(['work.sqlite', 'manifest.json', 'expected-replies.json', 'native-observations.json'].map(name => readFile(path.join(directory, name))))
    const seal: ClosedEvidenceSeal = { schema: 'mbf-group-markers.closed-owned-library.v1', owned: true, databaseSha256: bytesHash(database!), manifestSha256: bytesHash(manifest!), resultsSha256: bytesHash(replies!), nativeObservationsSha256: bytesHash(observations!) }
    const sealPath = path.join(directory, 'closed-seal.json'); await writeFile(sealPath, JSON.stringify(seal), { flag: 'wx', mode: 0o600 })
    process.stdout.write(JSON.stringify({ 事件: '同库冷关闭封印', sealPath, ...seal }) + '\n')
  })
  const datasetId = randomUUID(), catalog = repository.localCatalog
  const cover = await readFile(new URL('./fixtures/mbrs012-source/owned-cover-16.jpg', import.meta.url)), coverDigest = bytesHash(cover)
  assert.equal(cover.length, 960); assert.equal(coverDigest, '555f7915442690ccb14754bd0da000ceadfbdcfb50b4e3402f55d4806e3e989d')
  async function addRoot(label: string): Promise<OwnedRoot> {
    const media = path.join(directory, `owned-source-${roots.length + 1}`); await mkdir(media, { mode: 0o700 })
    const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media))
    const root = catalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' }), result = { root, media, label }
    roots.push(result); labels.push({ rootId: root.id, label }); return result
  }
  const root = await addRoot('自有合成来源A'), written = new Set<string>()
  async function ownedFile(source: OwnedRoot, relative: string): Promise<void> {
    const key = tuple(source.root.id, relative); if (written.has(key)) return
    const file = path.join(source.media, relative); await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    await writeFile(file, Buffer.from('MBF owned controlled bytes; no parser or listening evidence'), { flag: 'wx', mode: 0o600 }); written.add(key)
  }
  async function signature(source: OwnedRoot, relative: string): Promise<string> {
    const info = await stat(path.join(source.media, relative), { bigint: true }); return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':')
  }
  async function accepted(source: OwnedRoot, relative: string, raw: dto.LocalMetadata, embedded = true): Promise<ScanPreparedItem> {
    await ownedFile(source, relative)
    return { relative, signature: await signature(source, relative), parserVersion, outcome: 'accepted', fields: raw, failureCode: null, reused: false,
      readFacts: { technical: { container: 'WAVE', codec: 'PCM', lossless: true, sampleRateHz: 48000, channels: 2, bitsPerSample: 16, durationSeconds: 1, evidence: 'bounded-parser-reported' },
        coverEvidence: embedded ? [{ mime: 'image/jpeg', bytes: cover.length, sha256: coverDigest, evidence: 'encoded-bytes-magic-and-digest' }] : [],
        readEvidence: { bytesRead: 44, readCalls: 1, maxReadBytes: 44, allocationBytes: 44, elapsedMs: 1, wholeAudioHash: false, wholeAudioDecode: false } } }
  }
  async function rejected(source: OwnedRoot, relative: string, failureCode: string): Promise<ScanPreparedItem> {
    await ownedFile(source, relative)
    return { relative, signature: await signature(source, relative), parserVersion, outcome: 'rejected', fields: null, failureCode, reused: false, readFacts: null }
  }
  async function commit(source: OwnedRoot, items: ScanPreparedItem[], cueItems?: dto.LocalCuePreparedItem[]): Promise<void> {
    assert.ok(items.length <= 200)
    const current = catalog.root(source.root.id), started = repository.localScan.start({ commandId: randomUUID(), datasetId, libraryRootId: current.id, expectedRootRevision: current.revision, parserVersion }).job
    const running = repository.localScan.resume({ commandId: randomUUID(), jobId: started.jobId, expectedRevision: started.jobRevision })
    const batch: ScanPreparedBatch = { batchId: randomUUID(), jobId: running.jobId, expectedJobRevision: running.jobRevision, checkpointBefore: running.checkpointRef,
      items, frontier: [], completed: true, ...(cueItems ? { kind: 'cue-sidecars-v1' as const, cueItems } : {}) }
    repository.localScan.privatePrepareBatch({ commandId: randomUUID(), jobId: running.jobId, batch })
    assert.equal(repository.localScan.privateCommitBatch({ commandId: randomUUID(), jobId: running.jobId, batchId: batch.batchId, expectedRevision: running.jobRevision }).phase, 'completed')
  }
  async function scan(source: OwnedRoot, values: readonly { relative: string; raw: dto.LocalMetadata; embedded?: boolean }[]): Promise<Member[]> {
    await commit(source, await Promise.all(values.map(value => accepted(source, value.relative, value.raw, value.embedded))))
    return values.map(value => { const state = repository.localScan.privateFileState(source.root.id, value.relative)!.value; assert.ok(state.trackId && state.assetId)
      return { rootId: source.root.id, relative: value.relative, track: catalog.track(state.trackId), asset: catalog.asset(state.assetId), raw: value.raw } })
  }
  async function manual(source: OwnedRoot, relative: string, raw: dto.LocalMetadata): Promise<Member> {
    await ownedFile(source, relative)
    const current = catalog.root(source.root.id), asset = catalog.registerAsset({ commandId: randomUUID(), libraryRootId: current.id, expectedRootRevision: current.revision, relative, sha256: null, sampleFrames: null, timebaseHz: null })
    const track = catalog.createTrack({ commandId: randomUUID(), assetId: asset.id, segment: null })
    catalog.observeMetadata({ commandId: randomUUID(), trackId: track.id, source: 'synthetic', parserVersion, fields: raw })
    return { rootId: source.root.id, relative, track, asset, raw }
  }
  function edition(label: string, members: readonly Member[]) {
    const value = catalog.createEdition({ commandId: randomUUID(), title: '分组标记发行', edition: label })
    const links = members.map((member, index) => catalog.linkEditionTrack({ commandId: randomUUID(), editionId: value.id, trackId: member.track.id, disc: 1, trackNumber: index + 1, sequence: index + 1 }))
    return { value, links }
  }
  service = ownerFor(repository, labels, names); const owner = service
  const albums = (body = query()) => request('queryAlbums', body, () => owner.queryAlbums(body))
  const members = (album: dto.LocalAlbumSummary, offset = 0, limit = 200) => { const body = { albumKey: album.id, rootId: album.rootId, offset, limit }; return request('queryAlbumTracks', body, () => owner.queryAlbumTracks(body)) }
  const inspect = (album: dto.LocalAlbumSummary) => { const body = { albumKey: album.id, rootId: album.rootId, revision: album.revision }; return request('inspectAlbum', body, () => owner.inspectAlbum(body)) }
  return { directory, filePath, datasetId, repository, catalog, root, roots, labels, names, owner, addRoot, ownedFile, signature, accepted, rejected, commit, scan, manual, edition, albums, members, inspect,
    retain() { retained = true } }
}

interface MarkerStatement {
  id: number; method: 'get' | 'all' | 'iterate'; kind: 'gallery' | 'find' | 'members' | 'other'; sqlSha256: string; rows: number
  nativeByTuple: Record<string, number>; reply: unknown
}
interface MarkerObservation { registrations: { originalArity: number; wrappedArity: number }[]; statements: MarkerStatement[]; events: { statementId: number | null; input: string }[] }
type MarkerRegistration = { originalArity: number; wrappedArity: number }
type MarkerExecution = { statement: StatementSync; database: DatabaseSync; ticket: MarkerStatement }
interface MarkerObserverState {
  owner: TestContext
  observation?: MarkerObservation | undefined
  active?: MarkerExecution | undefined
}
let observing = false
let markerObserver: MarkerObserverState | undefined

function installMarkerObserver(t: TestContext): void {
  if (markerObserver) { assert.equal(markerObserver.owner, t, 'prototype观测只能复用本测试生命周期'); return }
  const state: MarkerObserverState = { owner: t }
  const owners = new WeakMap<StatementSync, DatabaseSync>(), registrations = new WeakMap<DatabaseSync, MarkerRegistration>()
  const functionDescriptor = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, 'function')!, prepareDescriptor = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, 'prepare')!
  const originalFunction = DatabaseSync.prototype.function, originalPrepare = DatabaseSync.prototype.prepare
  const methods = (['get', 'all', 'iterate'] as const).map(method => ({ method, descriptor: Object.getOwnPropertyDescriptor(StatementSync.prototype, method)! }))
  const observedFunction = function (this: DatabaseSync, ...args: unknown[]) {
    let registration: MarkerRegistration | undefined
    if (args[0] === 'mb_album_key') {
      const database = this, invoke = args[args.length - 1] as (...values: SQLOutputValue[]) => SQLOutputValue
      assert.equal(typeof invoke, 'function'); assert.equal(invoke.length, 5, '原mb_album_key必须保持arity=5')
      // 五参数原callback只向本次实际执行分发；旧观察返回后不能再追加后续查询。
      const counted = function (this: unknown, rootId: SQLOutputValue, editionId: SQLOutputValue, directory: SQLOutputValue, album: SQLOutputValue, versions: SQLOutputValue): SQLOutputValue {
        const observation = state.observation, execution = state.active
        if (observation) {
          if (execution) assert.equal(execution.database, database, 'native key必须归属其真实Statement的Database')
          const input = tuple(rootId, editionId, directory, album, versions)
          observation.events.push({ statementId: execution?.ticket.id ?? null, input })
          if (execution) execution.ticket.nativeByTuple[input] = (execution.ticket.nativeByTuple[input] ?? 0) + 1
        }
        return Reflect.apply(invoke, this, [rootId, editionId, directory, album, versions]) as SQLOutputValue
      }
      registration = { originalArity: invoke.length, wrappedArity: counted.length }
      assert.equal(registration.wrappedArity, registration.originalArity)
      args[args.length - 1] = counted
    }
    const value = Reflect.apply(originalFunction, this, args)
    if (registration) registrations.set(this, registration)
    return value
  }
  const observedPrepare = function (this: DatabaseSync, ...args: Parameters<DatabaseSync['prepare']>) {
    const statement = Reflect.apply(originalPrepare, this, args) as StatementSync
    owners.set(statement, this)
    return statement
  }
  Object.defineProperty(observedFunction, 'length', { value: originalFunction.length }); Object.defineProperty(observedPrepare, 'length', { value: originalPrepare.length })
  assert.equal(observedFunction.length, originalFunction.length); assert.equal(observedPrepare.length, originalPrepare.length)
  const wrapped = methods.map(({ method, descriptor }) => {
    const original = descriptor.value as (...bindings: unknown[]) => unknown
    const observed = function (this: StatementSync, ...bindings: unknown[]) {
      const observation = state.observation, database = owners.get(this)
      if (!observation || !database) return Reflect.apply(original, this, bindings)
      // 当前DB复用真实已注册的五参数callback；这里记录元数据，不声称重新注册或求值。
      const registration = registrations.get(database)
      if (registration && observation.registrations.length === 0) observation.registrations.push({ ...registration })
      const sql = this.sourceSQL
      if (!sql.includes('source_rows AS')) return Reflect.apply(original, this, bindings)
      const ticket: MarkerStatement = { id: observation.statements.length + 1, method, kind: sql.includes('envelope FROM counts') ? 'gallery' : sql.includes('SELECT * FROM groups WHERE album_key') ? 'find' : sql.includes('page_members AS') ? 'members' : 'other', sqlSha256: bytesHash(Buffer.from(sql)), rows: 0, nativeByTuple: {}, reply: null }
      observation.statements.push(ticket)
      const execution = { statement: this, database, ticket }
      const withinStatement = <V>(action: () => V): V => { const previous = state.active; state.active = execution; try { return action() } finally { state.active = previous } }
      if (method === 'iterate') {
        // 原native推进只在真实next内发生；不提前耗尽，不在yield之间持有active。
        const iterator = withinStatement(() => Reflect.apply(original, this, bindings)) as Iterator<unknown> & Iterable<unknown>
        const rows: unknown[] = []; ticket.reply = rows
        const observedIterator: Iterator<unknown> & Iterable<unknown> = new Proxy(iterator, { get(cursor, stepName) {
          if (stepName === Symbol.iterator) return () => observedIterator
          const step = Reflect.get(cursor, stepName, cursor)
          if (typeof step !== 'function') return step
          if (stepName === 'next' || stepName === 'return' || stepName === 'throw') {
            const observedStep = (...args: unknown[]) => withinStatement(() => {
              const reply = Reflect.apply(step, cursor, args) as IteratorResult<unknown>
              if (stepName === 'next' && !reply.done) { ticket.rows++; rows.push(reply.value) }
              return reply
            })
            Object.defineProperty(observedStep, 'length', { value: step.length }); assert.equal(observedStep.length, step.length)
            return observedStep
          }
          return step.bind(cursor)
        } })
        return observedIterator
      }
      return withinStatement(() => { const reply = Reflect.apply(original, this, bindings); ticket.reply = reply; if (method === 'all') { assert.ok(Array.isArray(reply)); ticket.rows = reply.length } else ticket.rows = reply === undefined ? 0 : 1; return reply })
    }
    Object.defineProperty(observed, 'length', { value: original.length }); assert.equal(observed.length, original.length)
    return { method, descriptor, observed }
  })
  markerObserver = state
  Object.defineProperty(DatabaseSync.prototype, 'function', { ...functionDescriptor, value: observedFunction })
  Object.defineProperty(DatabaseSync.prototype, 'prepare', { ...prepareDescriptor, value: observedPrepare })
  for (const { method, descriptor, observed } of wrapped) Object.defineProperty(StatementSync.prototype, method, { ...descriptor, value: observed })
  t.after(() => {
    try {
      assert.equal(state.observation, undefined); assert.equal(state.active, undefined)
      assert.equal(DatabaseSync.prototype.function, observedFunction); assert.equal(DatabaseSync.prototype.prepare, observedPrepare)
      for (const { method, observed } of wrapped) assert.equal(StatementSync.prototype[method], observed)
    } finally {
      Object.defineProperty(DatabaseSync.prototype, 'function', functionDescriptor); Object.defineProperty(DatabaseSync.prototype, 'prepare', prepareDescriptor)
      for (const { method, descriptor } of wrapped) Object.defineProperty(StatementSync.prototype, method, descriptor)
      markerObserver = undefined; observing = false
    }
  })
}

async function observeMarkers<T>(action: () => Promise<T>): Promise<{ value: T; observation: MarkerObservation }> {
  assert.equal(observing, false, 'prototype观测不得交叠')
  assert.ok(markerObserver, '必须先沿当前真实测试生命周期安装观察器')
  const state = markerObserver, observation: MarkerObservation = { registrations: [], statements: [], events: [] }
  observing = true; state.observation = observation
  try { return { value: await action(), observation } }
  finally { assert.equal(state.active, undefined); state.observation = undefined; observing = false }
}

function report(label: string, observation: MarkerObservation): void {
  process.stdout.write(JSON.stringify({ 事件: '分组标记native计数', label, registrations: observation.registrations, statements: observation.statements.map(({ reply: _reply, ...value }) => value), events: observation.events,
    边界: '每实际SQL statement的原native调用；不把memo/codec/小库耗时当作300k资格。完整rows另存同库工件。' }) + '\n')
}
function assertBound(observation: MarkerObservation, maximum: number): void {
  assert.ok(observation.registrations.length > 0); assert.ok(observation.registrations.every(value => value.originalArity === 5 && value.wrappedArity === 5))
  assert.equal(observation.events.some(event => event.statementId === null), false)
  for (const statement of observation.statements) assert.ok(Object.values(statement.nativeByTuple).reduce((sum, value) => sum + value, 0) <= maximum, `statement ${statement.id}/${statement.kind} 不应重复求值成员分组标记`)
}

type ReadCommand = { command: 'queryAlbums'; body: dto.LocalAlbumQuery } | { command: 'queryAlbumTracks'; body: dto.LocalAlbumTrackQuery } | { command: 'inspectAlbum'; body: { albumKey: string; rootId: string; revision: string } }
async function captureReads(owner: ReturnType<typeof createLocalAlbumOwnerService>, reads: readonly ReadCommand[]) {
  const results: unknown[] = [], observations: MarkerObservation[] = []
  for (const read of reads) {
    const observed = await observeMarkers(() => request<unknown>(read.command, read.body, () => {
      if (read.command === 'queryAlbums') return owner.queryAlbums(read.body)
      if (read.command === 'queryAlbumTracks') return owner.queryAlbumTracks(read.body)
      return owner.inspectAlbum(read.body)
    }))
    results.push({ command: read.command, body: read.body, reply: observed.value, sqlReplies: observed.observation.statements.map(value => ({ kind: value.kind, method: value.method, reply: value.reply })) })
    observations.push(observed.observation)
  }
  return { bytes: Buffer.from(JSON.stringify(results)), observations }
}
interface EvidenceManifest {
  schema: 'mbf-group-markers.same-owned-library.v1'; owned: true; datasetId: string; databasePath: string; labels: { rootId: string; label: string }[]; names: LocalAlbumNameEnhancementFact[]
  catalogRevision: string; scanRevision: string; resultsSha256: string; reads: ReadCommand[]
}
interface ClosedEvidenceSeal {
  schema: 'mbf-group-markers.closed-owned-library.v1'; owned: true
  databaseSha256: string; manifestSha256: string; resultsSha256: string; nativeObservationsSha256: string
}
async function saveEvidence(f: Awaited<ReturnType<typeof fixture>>, reads: ReadCommand[]): Promise<void> {
  if (!process.env.MBF_GROUP_MARKERS_EVIDENCE_DIR) return
  const catalogRevision = f.catalog.privateAlbumBrowserRevision(), scanRevision = f.repository.localScan.privateAlbumBrowserRevision(), captured = await captureReads(f.owner, reads)
  assert.equal(f.catalog.privateAlbumBrowserRevision(), catalogRevision); assert.equal(f.repository.localScan.privateAlbumBrowserRevision(), scanRevision)
  const manifest: EvidenceManifest = { schema: 'mbf-group-markers.same-owned-library.v1', owned: true, datasetId: f.datasetId, databasePath: f.filePath, labels: f.labels, names: f.names, catalogRevision, scanRevision, resultsSha256: bytesHash(captured.bytes), reads }
  await writeFile(path.join(f.directory, 'expected-replies.json'), captured.bytes, { flag: 'wx', mode: 0o600 })
  await writeFile(path.join(f.directory, 'native-observations.json'), JSON.stringify(captured.observations), { flag: 'wx', mode: 0o600 })
  const manifestPath = path.join(f.directory, 'manifest.json'); await writeFile(manifestPath, JSON.stringify(manifest), { flag: 'wx', mode: 0o600 }); f.retain()
  process.stdout.write(JSON.stringify({ 事件: '同库分组工件已保留', manifestPath, resultsSha256: manifest.resultsSha256, manifestSha256: bytesHash(await readFile(manifestPath)), 原库水位: { catalogRevision, scanRevision } }) + '\n')
}

if (replayPath) {
  test('MBF分组标记：同库只读冷开逐字节复读gallery/find/member/inspect及digest', { concurrency: false }, async t => {
    installMarkerObserver(t)
    assert.ok(path.isAbsolute(replayPath) && replayPath.startsWith(externalTemporaryRoot)); assert.equal(path.basename(replayPath), 'manifest.json')
    const info = await lstat(replayPath); assert.ok(info.isFile() && !info.isSymbolicLink()); assert.equal(await realpath(replayPath), replayPath)
    const directory = path.dirname(replayPath), manifestBytes = await readFile(replayPath), manifest = JSON.parse(manifestBytes.toString('utf8')) as EvidenceManifest
    assert.equal(manifest.schema, 'mbf-group-markers.same-owned-library.v1'); assert.equal(manifest.owned, true); assert.equal(manifest.databasePath, path.join(directory, 'work.sqlite'))
    const expected = await readFile(path.join(directory, 'expected-replies.json')); assert.equal(bytesHash(expected), manifest.resultsSha256)
    const seal = JSON.parse((await readFile(path.join(directory, 'closed-seal.json'))).toString('utf8')) as ClosedEvidenceSeal
    assert.equal(seal.schema, 'mbf-group-markers.closed-owned-library.v1'); assert.equal(seal.owned, true)
    assert.equal(bytesHash(manifestBytes), seal.manifestSha256); assert.equal(bytesHash(expected), seal.resultsSha256)
    assert.equal(bytesHash(await readFile(path.join(directory, 'native-observations.json'))), seal.nativeObservationsSha256)
    const beforeDatabaseSha256 = bytesHash(await readFile(manifest.databasePath)); assert.equal(beforeDatabaseSha256, seal.databaseSha256)
    const repository = createCollectionRepository({ filePath: manifest.databasePath }), owner = ownerFor(repository, manifest.labels, manifest.names)
    let captured: Awaited<ReturnType<typeof captureReads>> | undefined
    try {
      assert.equal(repository.localCatalog.privateAlbumBrowserRevision(), manifest.catalogRevision); assert.equal(repository.localScan.privateAlbumBrowserRevision(), manifest.scanRevision)
      const actual = await captureReads(owner, manifest.reads)
      assert.deepEqual(actual.bytes, expected, '同一合法库与相同原requests的完整Owner回复及原SQLite返回rows必须逐字节相同，含原revision/digest和排序')
      assert.equal(repository.localCatalog.privateAlbumBrowserRevision(), manifest.catalogRevision); assert.equal(repository.localScan.privateAlbumBrowserRevision(), manifest.scanRevision)
      captured = actual
    }
    finally { owner.close(); repository.close() }
    assert.ok(captured)
    const afterDatabaseSha256 = bytesHash(await readFile(manifest.databasePath)), result = { resultsSha256: bytesHash(captured.bytes), beforeDatabaseSha256, afterDatabaseSha256, observations: captured.observations }
    const resultPath = path.join(directory, `replay-${randomUUID()}.json`); await writeFile(resultPath, JSON.stringify(result), { flag: 'wx', mode: 0o600 })
    process.stdout.write(JSON.stringify({ 事件: '同库逐字节复读结果', resultPath, resultSha256: bytesHash(await readFile(resultPath)), resultsSha256: result.resultsSha256, beforeDatabaseSha256, afterDatabaseSha256, 完整回复一致: true, 原业务水位未变: true, 数据库文件字节未变: beforeDatabaseSha256 === afterDatabaseSha256 }) + '\n')
  })
} else {
  test('MBF分组标记：65目录真实Owner每statement key只求值一次，null与多links保留完整成员及排序', { concurrency: false }, async t => {
    const f = await fixture(t), records = await f.scan(f.root, Array.from({ length: 65 }, (_, index) => ({ relative: `目录${String(index + 1).padStart(3, '0')}/01.wav`, raw: fields(index + 1) })))
    const initial = await observeMarkers(() => f.albums(query({ limit: 2 }))), full = await f.albums(), ids = records.map(value => directoryId(value.rootId, value.relative, value.raw)).sort()
    const counts: dto.LocalAlbumFilterCounts = { all: 65, 'missing-artwork': 0, 'has-artwork': 65, 'cue-unsplit': 0, 'metadata-issue': 0, 'parse-failed': 0, 'loose-audio': 0, 'track-named-audio': 0, 'missing-lyrics': 0 }
    assert.deepEqual(full.counts, counts); assert.deepEqual(initial.value.counts, counts); assert.equal(initial.value.total, 65); assert.equal(initial.value.items.length, 2)
    assert.deepEqual(full.items.map(value => value.id), ids); assert.deepEqual(initial.value.items, full.items.slice(0, 2)); assert.deepEqual(await f.albums(), full)
    const second = await f.albums(query({ offset: 2, limit: 2 })); assert.deepEqual(second.items, full.items.slice(2, 4)); assert.deepEqual(second.counts, counts)
    const emptyGallery = await f.albums(query({ offset: 200, limit: 2 })); assert.deepEqual(emptyGallery.items, []); assert.deepEqual(emptyGallery.counts, counts)
    const unlinked = records[64]!, unlinkedAlbum = full.items.find(value => value.representativeTrackId === unlinked.track.id)!
    const noRelation = await observeMarkers(() => f.members(unlinkedAlbum)), noRelationCapture = await observeMarkers(() => f.inspect(unlinkedAlbum))
    assert.equal(noRelation.value.items[0]!.facts.track.id, unlinked.track.id); assert.deepEqual(noRelation.value.items[0]!.facts.metadata, f.catalog.metadata(unlinked.track.id))
    assert.equal(noRelationCapture.value.members[0]!.editionLink, null); assert.deepEqual(noRelationCapture.value.members[0]!.fact.rawMetadata, unlinked.raw); assert.deepEqual(noRelationCapture.value.issues, [])
    const a = f.edition('原版', records.slice(0, 64)), afterA = await observeMarkers(() => f.albums()), albumA = afterA.value.items.find(value => value.editionId === a.value.id)!
    assert.equal(afterA.value.total, 2); assert.equal(albumA.trackCount, 64); assert.equal(albumA.id, `edition-${hash([f.root.root.id, a.value.id])}`)
    assert.deepEqual(afterA.value.items.find(value => value.id === unlinkedAlbum.id), unlinkedAlbum)
    const tail = await observeMarkers(() => f.members(albumA, 62, 2)), capturedA = await observeMarkers(() => f.inspect(albumA))
    assert.deepEqual(tail.value.items.map(value => value.facts.track.id), records.slice(62, 64).map(value => value.track.id)); assert.equal(tail.value.hasMore, false)
    assert.deepEqual(tail.value.items.map(value => value.sequence), [63, 64]); assert.deepEqual((await f.members(albumA, 64, 2)).items, [])
    assert.deepEqual(capturedA.value.members.map(value => value.fact.summary.track.id), records.slice(0, 64).map(value => value.track.id)); assert.deepEqual(capturedA.value.issues, []); assert.deepEqual(capturedA.value.rejectedFiles, [])
    for (const [index, member] of capturedA.value.members.entries()) { assert.deepEqual(member.fact.rawMetadata, records[index]!.raw); assert.deepEqual(member.fact.summary.metadata, records[index]!.raw); assert.deepEqual(member.editionLink, a.links[index]); assert.equal(member.sequence, index + 1) }
    const target = records[63]!, b = f.edition('再版', [target]), afterB = await observeMarkers(() => f.albums()), albumB = afterB.value.items.find(value => value.editionId === b.value.id)!
    assert.equal(afterB.value.total, 3); assert.equal(afterB.value.counts['has-artwork'], 3); assert.equal(albumB.trackCount, 1)
    assert.deepEqual(afterB.value.items.find(value => value.id === albumA.id), albumA); assert.deepEqual(await f.inspect(albumA), capturedA.value)
    const targetMember = (await f.members(albumB)).items[0]!
    assert.deepEqual(targetMember.facts.track, f.catalog.track(target.track.id)); assert.deepEqual(targetMember.facts.asset, f.catalog.asset(target.asset.id)); assert.deepEqual(targetMember.facts.metadata, f.catalog.metadata(target.track.id)); assert.equal(targetMember.facts.fileParameters?.sampleRateHz, 48000)
    const duplicate = f.catalog.linkEditionTrack({ commandId: randomUUID(), editionId: a.value.id, trackId: target.track.id, disc: 1, trackNumber: 65, sequence: 65 })
    assert.equal(duplicate.active, true)
    await assert.rejects(f.albums(), code('UNAVAILABLE')); await assert.rejects(f.members(albumA), code('UNAVAILABLE'))
    f.catalog.removeEditionTrack({ commandId: randomUUID(), id: duplicate.id, expectedRevision: duplicate.revision })
    assert.deepEqual(await f.albums(), afterB.value, '恢复active闭集后不能改变原完整成员hash；不能去重合法关系把distinct冲突伪装成成功')
    const finalAlbums = afterB.value.items, reads: ReadCommand[] = [
      { command: 'queryAlbums', body: query() }, { command: 'queryAlbums', body: query({ offset: 1, limit: 1 }) }, { command: 'queryAlbums', body: query({ offset: 200, limit: 2 }) },
      ...dto.LOCAL_ALBUM_STATUSES.map(filter => ({ command: 'queryAlbums' as const, body: query({ filter }) })),
      { command: 'queryAlbumTracks', body: { albumKey: albumA.id, rootId: albumA.rootId, offset: 62, limit: 2 } }, { command: 'queryAlbumTracks', body: { albumKey: albumA.id, rootId: albumA.rootId, offset: 64, limit: 2 } },
      ...finalAlbums.map(album => ({ command: 'queryAlbumTracks' as const, body: { albumKey: album.id, rootId: album.rootId, offset: 0, limit: 200 } })),
      ...finalAlbums.map(album => ({ command: 'inspectAlbum' as const, body: { albumKey: album.id, rootId: album.rootId, revision: album.revision } })),
    ]
    // 在RED次数断言前保留完整真实回复和合法库，GREEN独立进程可以复读同一事实。
    await saveEvidence(f, reads)
    for (const [label, observed] of [['初始65目录gallery', initial], ['null成员find/page', noRelation], ['null完整inspect', noRelationCapture], ['64成员发行gallery', afterA], ['发行尾页find/page', tail], ['发行完整inspect', capturedA], ['同轨多links gallery', afterB]] as const) report(label, observed.observation)
    assert.deepEqual(initial.observation.statements.map(value => value.kind), ['gallery']); assert.equal(initial.observation.statements[0]!.rows, 1)
    const expectedInputs = records.map(value => tuple(value.rootId, null, parent(value.relative), value.raw.album!, JSON.stringify(albumVersions(value.raw))))
    assert.deepEqual(Object.keys(initial.observation.statements[0]!.nativeByTuple).sort(), [...expectedInputs].sort(), 'limit=2仍必须涵盖完整65基础身份，不能早LIMIT或只测memo头部')
    for (const input of expectedInputs) assert.equal(initial.observation.statements[0]!.nativeByTuple[input], 1, '每条实际gallery SQL的唯一成员key只求值一次；旧window partition与输出展开应形成有效RED')
    for (const observed of [initial, noRelation, noRelationCapture, afterA, tail, capturedA]) assertBound(observed.observation, 65)
    assertBound(afterB.observation, 66)
  })

  test('MBF分组标记：原64-token预算与raw覆盖、多根/发行分隔、七filters及零轨事实保持原Owner语义', { concurrency: false }, async t => {
    const f = await fixture(t), album = '同名专辑 2026 SACD', raws = [fields(1, album), { ...fields(2, album), title: 'SACD '.repeat(70).trim() }, { ...fields(3, album), artist: 'SACD '.repeat(70).trim() }, { ...fields(4, album), title: 'SACD '.repeat(63).trim() }]
    const records = await f.scan(f.root, raws.map((raw, index) => ({ relative: `版本目录/${index === 2 ? 'Track003' : String(index + 1).padStart(2, '0')}.wav`, raw })))
    const first = await f.albums(), expectedIds = [...new Set(records.map(value => directoryId(value.rootId, value.relative, value.raw)))]
    assert.equal(first.total, expectedIds.length); assert.deepEqual(first.items.map(value => value.id).sort(), expectedIds.sort())
    for (const summary of first.items) {
      const raw = records.find(value => value.track.id === summary.representativeTrackId)!.raw
      assert.equal(summary.versionLabel, albumVersions(raw).join(' · ') || null)
      const capture = await f.inspect(summary)
      for (const member of capture.members) { assert.equal(member.editionLink, null); assert.deepEqual(member.fact.summary.versionTokens, versionTokens(f.catalog.metadata(member.fact.summary.track.id).raw)) }
    }
    assert.deepEqual(albumVersions(raws[1]!), []); assert.deepEqual(albumVersions(raws[2]!), [])
    const otherRoot = await f.addRoot('自有合成来源B'), other = (await f.scan(otherRoot, [{ relative: records[0]!.relative, raw: raws[0]! }]))[0]!
    const separated = await f.albums(), sourceA = separated.items.find(value => value.id === directoryId(records[0]!.rootId, records[0]!.relative, raws[0]!))!, sourceB = separated.items.find(value => value.rootId === otherRoot.root.id)!
    assert.notEqual(sourceA.id, sourceB.id); assert.equal(sourceA.title, sourceB.title); assert.equal(sourceA.versionLabel, sourceB.versionLabel)
    const target = records[0]!, a = f.edition('共同发行', [target, other]), editionPage = await f.albums(), splitA = editionPage.items.find(value => value.editionId === a.value.id && value.rootId === f.root.root.id)!, splitB = editionPage.items.find(value => value.editionId === a.value.id && value.rootId === otherRoot.root.id)!
    assert.notEqual(splitA.id, splitB.id); assert.equal(splitA.trackCount, 1); assert.equal(splitB.trackCount, 1)
    const overrideFields: dto.LocalMetadata = { title: '', artist: 'MB覆盖艺人', album: '', year: '2030', disc: '2', track: '9' }
    const override = f.catalog.overrideMetadata({ commandId: randomUUID(), trackId: target.track.id, expectedRevision: null, fields: overrideFields })
    f.catalog.observeMetadata({ commandId: randomUUID(), trackId: target.track.id, source: 'tag', parserVersion, fields: { title: '被MB遮盖的普通新raw标题', year: '2027' } })
    const changed = (await f.albums()).items.find(value => value.id === splitA.id)!, raw = { ...raws[0], title: '被MB遮盖的普通新raw标题', year: '2027' }
    assert.notEqual(changed.revision, splitA.revision); await assert.rejects(f.inspect(splitA), code('SNAPSHOT_CHANGED'))
    const member = (await f.members(changed)).items[0]!, captured = await f.inspect(changed)
    assert.deepEqual(member.facts.metadata, { raw, override, effective: { ...raw, ...overrideFields } }); assert.deepEqual(member.facts.metadata, f.catalog.metadata(target.track.id))
    assert.deepEqual(member.facts.versionTokens, versionTokens(raw)); assert.deepEqual(captured.members[0]!.fact.rawMetadata, raw); assert.deepEqual(captured.members[0]!.fact.summary.metadata, { ...raw, ...overrideFields })
    const b = f.edition('另一发行', [target]), fanout = await f.albums()
    assert.deepEqual(fanout.items.find(value => value.id === changed.id), changed); assert.equal(fanout.items.find(value => value.editionId === b.value.id)!.trackCount, 1)
    const loose = (await f.scan(f.root, [{ relative: 'Track004.wav', raw: fields(5, '散落合成专辑'), embedded: false }]))[0]!
    await f.commit(f.root, [await f.rejected(f.root, '元数据失败/01.bin', 'PARSE_FAILED'), await f.rejected(f.root, '普通拒收/01.bin', 'UNSUPPORTED')])
    const unknown = await f.manual(f.root, '待探测/01.wav', fields(6, '等待封面合成专辑')), cueRelative = '零轨CUE/album.cue'; await f.ownedFile(f.root, cueRelative)
    await f.commit(f.root, [], [{ relative: cueRelative, signature: await f.signature(f.root, cueRelative), parserVersion: 'cue-text-75fps/mbrs003-v1', outcome: 'rejected', failureCode: 'CUE_PARSE_FAILED', reused: false, previousSnapshotId: null, result: null }])
    f.names.push({ rootId: f.root.root.id, directory: '元数据失败', revision: 'controlled-name-failed-v1', state: 'failed' }, { rootId: f.root.root.id, directory: '普通拒收', revision: 'controlled-name-cancelled-v1', state: 'cancelled' })
    const beforeMissing = await f.albums(), awaiting = beforeMissing.items.find(value => value.representativeTrackId === unknown.track.id)!
    assert.equal(awaiting.artworkState, 'unknown')
    const artwork = { albumKey: awaiting.id, rootId: awaiting.rootId, editionId: awaiting.editionId, representativeTrackId: awaiting.representativeTrackId, revision: awaiting.revision }
    assert.equal((await request('getArtwork', artwork, () => f.owner.getArtwork(artwork))).image, null)
    const all = await f.albums(), unlinkedGroups = new Set(records.slice(1).map(value => directoryId(value.rootId, value.relative, value.raw))).size
    const expected: dto.LocalAlbumFilterCounts = { all: 8 + unlinkedGroups, 'missing-artwork': 1, 'has-artwork': 3 + unlinkedGroups, 'cue-unsplit': 1, 'metadata-issue': 1, 'parse-failed': 1, 'loose-audio': 1, 'track-named-audio': 2, 'missing-lyrics': 0 }
    assert.deepEqual(all.counts, expected); assert.equal(all.total, expected.all)
    const page = await f.albums(query({ limit: 2 })), next = await f.albums(query({ offset: 2, limit: 2 })), empty = await f.albums(query({ offset: 200, limit: 2 }))
    assert.deepEqual(page.items, all.items.slice(0, 2)); assert.deepEqual(next.items, all.items.slice(2, 4)); assert.deepEqual(empty.items, []); assert.deepEqual(empty.counts, expected)
    for (const filter of dto.LOCAL_ALBUM_STATUSES) { const filtered = await f.albums(query({ filter })); assert.equal(filtered.total, expected[filter]); assert.deepEqual(filtered.counts, expected); assert.ok(filtered.items.every(value => value.statuses.includes(filter))) }
    const onlyB = await f.albums(query({ rootId: otherRoot.root.id })); assert.deepEqual(onlyB.items, [all.items.find(value => value.id === splitB.id)!]); assert.equal(onlyB.counts.all, 1); assert.equal(onlyB.counts['has-artwork'], 1)
    assert.equal(all.items.find(value => value.representativeTrackId === loose.track.id)!.artworkState, 'unknown')
    const cue = await f.inspect(all.items.find(value => value.statuses.includes('cue-unsplit'))!); assert.equal(cue.summary.trackCount, 0); assert.equal(cue.summary.representativeTrackId, null); assert.deepEqual(cue.members, []); assert.deepEqual(cue.issues, [{ kind: 'cue', relative: cueRelative, status: 'failed' }])
    const failed = await f.inspect(all.items.find(value => value.statuses.includes('metadata-issue'))!); assert.deepEqual(failed.members, []); assert.deepEqual(failed.rejectedFiles!.map(value => value.relative), ['元数据失败/01.bin']); assert.ok(failed.issues.some(value => value.kind === 'metadata-read-failed')); assert.ok(failed.issues.some(value => value.kind === 'name-enhancement-failed'))
    assert.deepEqual(await f.albums(), all, '所有筛选和详情读取后，原完整摘要/成员digest/counts/排序必须稳定')
  })
}
