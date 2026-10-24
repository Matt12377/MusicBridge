import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync, StatementSync } from 'node:sqlite'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import * as dto from '@music-bridge/contracts'
import { createLocalAlbumSqlReader, readWithLocalAlbumSqlErrors, isCurrentLocalAlbumSqlReader } from '../src/collection/local-album-browser/sql-read.js'
import { createLocalAlbumOwnerService } from '../src/collection/local-album-browser/owner-port.js'
import { materializeLocalAlbumQueue } from '../src/collection/mb-queue-materializer.js'
import { MBQueueStoreError } from '../src/collection/mb-queue-store.js'
import { groupLocalAlbumSnapshot, LocalAlbumReadError } from '../src/collection/local-album-browser/grouping.js'
import { extractVersionTokens } from '../src/library/local-name-rules.js'
import type { CollectionRepository } from '../src/collection/repository.js'
import { createCollectionRepository, CollectionError } from '../src/collection/repository.js'
import { authorizeSourceDirectory, sourceRootAvailability } from '../src/recording/source-files.js'
import type { ScanFileState } from '../src/collection/local-scan-facts.js'
import type { LocalAlbumArtworkReadResult, LocalAlbumNameEnhancementFact, LocalAlbumReadSnapshot, LocalAlbumTrackFact } from '../src/collection/local-album-browser/types.js'
import { LOCAL_ALBUM_SQL_ENVELOPE_MAX_BYTES, type LocalAlbumSqlArtworkObservation, type LocalAlbumSqlCodec, type LocalAlbumSqlCueStored, type LocalAlbumSqlScope, type LocalAlbumSqlIssueReadOptions, type LocalAlbumLibraryOrganization } from '../src/collection/local-album-browser/sql-types.js'
import { createBackupWorkflowStore } from '../src/recording/backup-workflow-store.js'
import { createLocalWorkbenchReadService } from '../src/collection/local-library-workbench/read-service.js'
import { createLocalWorkbenchMBOnlyWriter, type LocalWorkbenchMBOnlyWriter } from '../src/collection/local-library-workbench/owner-writer.js'
import { createLocalWorkbenchPlanRegistry } from '../src/collection/local-library-workbench/plan-registry.js'
import { createLocalWorkbenchOwnerPersistence } from '../src/collection/local-library-workbench/owner-journal.js'
import { createCueSyntheticWave } from '../src/library/local-cue-format-qualification.js'
import { readLibraryOperationLine } from '../src/shared/library-operation-log.js'
import { createDatasetOwnerReadRevocation } from '../src/collection/dataset-owner-read-revocation.js'

// 小型真实SQLite与纯分组对照；所有表、身份、扫描和CUE事实均为合成，不读取用户文件。
const id = (n: number) => `22222222-2222-4222-8222-${String(n).padStart(12,'0')}`
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const rootId = id(1), otherRootId = id(2)
const root = (n: number): dto.LocalRootView => ({ root: { id: id(n), sourceRootId: id(100+n), role: 'library', revision: '1' }, label: `合成来源${n}`, availability: 'ONLINE' })
const fields = ['title','artist','album','year','disc','track'] as const
// SQL投影覆盖当前九字段合同；下方旧六字段变更回归仍保留原输入。
const projectionFields = [...dto.LOCAL_METADATA_TEXT_FIELDS, ...dto.LOCAL_METADATA_ARTIST_FIELDS]
const tokens = (raw: dto.LocalMetadata): dto.VersionNameToken[] => (['title','artist','album'] as const).flatMap(field => raw[field] ? extractVersionTokens(raw[field]!,field) : []).slice(0,64)
function track(n: number, relative: string, raw: dto.LocalMetadata = { title: `曲目${n}`, artist: '合成艺人', album: '同名专辑' }, options: { rootId?: string; segmented?: boolean; embedded?: boolean } = {}): LocalAlbumTrackFact {
  const rid = options.rootId ?? rootId, segmented = options.segmented ?? false, state = options.embedded ? 'available' as const : 'unknown' as const
  return { relative, rawMetadata: { ...raw }, summary: { track: { id: id(1000+n), assetId: id(10000+n), selectionRevision: '1', segment: segmented ? { id: id(50000+n), startFrame: '0', endFrameExclusive: '48000', timebaseHz: 48000 } : null },
    asset: { id: id(10000+n), libraryRootId: rid, sourceRootId: rid === rootId ? id(101) : id(102), rootRevision: '1', fileRevision: '1', locationRevision: '1', sampleFrames: segmented ? '96000' : null, timebaseHz: segmented ? 48000 : null }, metadata: { ...raw }, versionTokens: tokens(raw) },
    hasArtwork: state === 'available', artworkState: state, artworkRevision: state === 'available' ? 'embedded-1' : null }
}
const edition = (n: number): dto.AlbumEdition => ({ id: id(20000+n), title: '同名专辑', edition: `发行${n}`, revision: '1' })
const link = (n: number, e: dto.AlbumEdition, t: LocalAlbumTrackFact, sequence = 1): dto.AlbumEditionTrack => ({ id: id(30000+n), editionId: e.id, trackId: t.summary.track.id, disc: 1, trackNumber: sequence, sequence, revision: '1', active: true })
const query = (changes: Partial<dto.LocalAlbumQuery> = {}): dto.LocalAlbumQuery => ({ query: '', rootId: null, filter: 'all', offset: 0, limit: 200, ...changes })
const artworkRequest = (album: dto.LocalAlbumSummary): dto.LocalAlbumArtworkRequest => ({ albumKey: album.id, rootId: album.rootId, editionId: album.editionId, representativeTrackId: album.representativeTrackId, revision: album.revision })
const errorCode = (code: LocalAlbumReadError['code']) => (error: unknown) => error instanceof LocalAlbumReadError && error.code === code
const image = (): dto.LocalArtworkImage => ({ original: { mime: 'image/png', bytes: 4, sha256: 'a'.repeat(64), width: 32, height: 32 }, display: { mime: 'image/jpeg', bytes: 3, sha256: 'b'.repeat(64), width: 16, height: 16, dataUrl: 'data:image/jpeg;base64,/9j/' } })
function cue(n: number, relative: string, assets: readonly LocalAlbumTrackFact[] = []): LocalAlbumSqlCueStored {
  let fileOrdinal = 0, previous = ''
  const tracks: dto.LocalCueTrackFact[] = assets.map((fact,index) => { const asset = fact.summary.asset; if (asset.id !== previous) { fileOrdinal++; previous = asset.id }
    return { trackNumber: index+1, fileOrdinal, assetReference: { assetId: asset.id, libraryRootId: asset.libraryRootId, sourceRootId: asset.sourceRootId, rootRevision: asset.rootRevision, fileRevision: asset.fileRevision, locationRevision: asset.locationRevision, relative: fact.relative, signature: `signature-${asset.id}` },
      timebase: 'cue-cd-frames', framesPerSecond: 75, index00Frames: null, index01Frames: index && assets[index-1]!.summary.asset.id === asset.id ? index*75 : 0, endFrames: null, evidence: 'cue-text-declared', playback: 'NOT_VERIFIED' }
  })
  return { id: id(60000+n), sidecarId: id(61000+n), libraryRootId: rootId, sourceRootId: id(101), rootRevision: '1', item: { relative, signature: `cue-signature-${n}`, parserVersion: 'cue-text-75fps/mbrs003-v1', outcome: tracks.length ? 'accepted' : 'rejected', failureCode: tracks.length ? null : 'CUE_PARSE_FAILED', reused: false, previousSnapshotId: null, result: tracks.length ? { status: 'ok', tracks } : null } }
}
function accepted(fact: LocalAlbumTrackFact): ScanFileState {
  return { libraryRootId: fact.summary.asset.libraryRootId, relative: fact.relative, signature: `signature-${fact.summary.asset.id}`, parserVersion: 'music-metadata-11.15.0/mbrs003-v3', outcome: 'accepted', assetId: fact.summary.asset.id, trackId: fact.summary.track.id, failureCode: null,
    readFacts: { technical: { container: 'FLAC', codec: 'FLAC', lossless: true, sampleRateHz: 48000, channels: 2, bitsPerSample: 24, durationSeconds: 123, evidence: 'bounded-parser-reported' },
      coverEvidence: fact.hasArtwork ? [{ mime: 'image/png', bytes: 4, sha256: 'a'.repeat(64), evidence: 'encoded-bytes-magic-and-digest' }] : [], readEvidence: { bytesRead: 1024, readCalls: 1, maxReadBytes: 1024, allocationBytes: 1024, elapsedMs: 1, wholeAudioHash: false, wholeAudioDecode: false } } }
}
const rejected = (relative: string, failureCode = 'UNSUPPORTED'): ScanFileState => ({ libraryRootId: rootId, relative, signature: `reject-${relative}`, parserVersion: 'music-metadata-11.15.0/mbrs003-v3', outcome: 'rejected', assetId: null, trackId: null, failureCode, readFacts: null })

type SqlReadMethod615 = 'get' | 'all' | 'iterate'
type SqlExecution615 = { statement: StatementSync; database: DatabaseSync; sql: string; method: SqlReadMethod615; phase: 'before' | 'after'; step?: 'next' | 'return' | 'throw' }
type SqlListener615 = (execution: SqlExecution615) => void
let sqlObserver615: { owner: test.TestContext; listeners: Map<DatabaseSync, Set<SqlListener615>> } | undefined

function observeSqlExecutions615(t: test.TestContext, database: DatabaseSync, listener: SqlListener615): void {
  if (!sqlObserver615) {
    const state = { owner: t, listeners: new Map<DatabaseSync, Set<SqlListener615>>() }
    const owners = new WeakMap<StatementSync, DatabaseSync>()
    const prepareDescriptor = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, 'prepare')!
    const originalPrepare = DatabaseSync.prototype.prepare
    const methods = (['get', 'all', 'iterate'] as const).map(method => ({ method, descriptor: Object.getOwnPropertyDescriptor(StatementSync.prototype, method)! }))
    const observedPrepare = function (this: DatabaseSync, ...args: Parameters<DatabaseSync['prepare']>) {
      const statement = Reflect.apply(originalPrepare, this, args) as StatementSync
      owners.set(statement, this)
      return statement
    }
    Object.defineProperty(observedPrepare, 'length', { value: originalPrepare.length }); assert.equal(observedPrepare.length, originalPrepare.length)
    const wrapped = methods.map(({ method, descriptor }) => {
      const original = descriptor.value as (...bindings: unknown[]) => unknown
      const observed = function (this: StatementSync, ...bindings: unknown[]) {
        const db = owners.get(this), listeners = db ? state.listeners.get(db) : undefined
        if (!db || !listeners?.size) return Reflect.apply(original, this, bindings)
        const execution = { statement: this, database: db, sql: this.sourceSQL, method }
        const call = <V>(action: () => V, step?: SqlExecution615['step']): V => {
          for (const listener of listeners) listener({ ...execution, phase: 'before', ...(step ? { step } : {}) })
          const value = action()
          for (const listener of listeners) listener({ ...execution, phase: 'after', ...(step ? { step } : {}) })
          return value
        }
        if (method !== 'iterate') return call(() => Reflect.apply(original, this, bindings))
        const iterator = call(() => Reflect.apply(original, this, bindings)) as Iterator<unknown> & Iterable<unknown>
        // 逐次真实推进原iterator；不提前取行，step事件不重复计算整条SQL执行次数。
        const observedIterator: Iterator<unknown> & Iterable<unknown> = new Proxy(iterator, { get(cursor, stepName) {
          if (stepName === Symbol.iterator) return () => observedIterator
          const step = Reflect.get(cursor, stepName, cursor)
          if (typeof step !== 'function') return step
          if (stepName === 'next' || stepName === 'return' || stepName === 'throw') {
            const observedStep = (...args: unknown[]) => call(() => Reflect.apply(step, cursor, args), stepName)
            Object.defineProperty(observedStep, 'length', { value: step.length }); assert.equal(observedStep.length, step.length)
            return observedStep
          }
          return step.bind(cursor)
        } })
        return observedIterator
      }
      Object.defineProperty(observed, 'length', { value: original.length }); assert.equal(observed.length, original.length)
      return { method, descriptor, observed }
    })
    sqlObserver615 = state
    Object.defineProperty(DatabaseSync.prototype, 'prepare', { ...prepareDescriptor, value: observedPrepare })
    for (const { method, descriptor, observed } of wrapped) Object.defineProperty(StatementSync.prototype, method, { ...descriptor, value: observed })
    t.after(() => {
      try {
        assert.equal(DatabaseSync.prototype.prepare, observedPrepare)
        for (const { method, observed } of wrapped) assert.equal(StatementSync.prototype[method], observed)
      } finally {
        Object.defineProperty(DatabaseSync.prototype, 'prepare', prepareDescriptor)
        for (const { method, descriptor } of wrapped) Object.defineProperty(StatementSync.prototype, method, descriptor)
        sqlObserver615 = undefined
      }
    })
  }
  assert.equal(sqlObserver615.owner, t, 'Statement观察只能注册于本测试生命周期')
  const listeners = sqlObserver615.listeners.get(database) ?? new Set<SqlListener615>()
  assert.equal(listeners.has(listener), false, '不能重复包装同一观察回调')
  listeners.add(listener); sqlObserver615.listeners.set(database, listeners)
}

function fixture(t: test.TestContext, input: { tracks?: readonly LocalAlbumTrackFact[]; roots?: readonly dto.LocalRootView[]; editions?: readonly dto.AlbumEdition[]; links?: readonly dto.AlbumEditionTrack[]; files?: readonly ScanFileState[]; cues?: readonly LocalAlbumSqlCueStored[]; names?: readonly LocalAlbumNameEnhancementFact[]; databasePath?: string } = {}) {
  const db = new DatabaseSync(input.databasePath ?? ':memory:'); t.after(() => { if(db.isOpen)db.close() })
  db.exec(`CREATE TABLE local_catalog_tracks(id TEXT PRIMARY KEY,asset_id TEXT,data TEXT);
    CREATE TABLE local_catalog_assets(id TEXT PRIMARY KEY,root_id TEXT,source_root_id TEXT,relative TEXT,sha256 TEXT,data TEXT);
    CREATE TABLE local_catalog_editions(id TEXT PRIMARY KEY,data TEXT);
    CREATE TABLE local_catalog_edition_tracks(id TEXT PRIMARY KEY,track_id TEXT,edition_id TEXT,data TEXT);
    CREATE TABLE local_catalog_overrides(track_id TEXT PRIMARY KEY,data TEXT);
    CREATE TABLE local_artwork_selections(edition_id TEXT PRIMARY KEY,data TEXT);
    CREATE TABLE local_scan_file_state(library_root_id TEXT,relative TEXT,asset_id TEXT,data TEXT,PRIMARY KEY(library_root_id,relative));
    CREATE TABLE local_cue_sources(library_root_id TEXT,relative TEXT,data TEXT);`)
  const facts = [...input.tracks ?? []], roots = structuredClone(input.roots ?? [root(1),root(2)]), editions = [...input.editions ?? []], links = [...input.links ?? []], cues = [...input.cues ?? []], names = [...input.names ?? []]
  const files = new Map<string,ScanFileState>()
  for (const value of [...facts.map(accepted),...input.files ?? []]) files.set(JSON.stringify([value.libraryRootId,value.relative]),value)
  for (const fact of facts) { const { summary } = fact
    db.prepare('INSERT INTO local_catalog_tracks VALUES(?,?,?)').run(summary.track.id,summary.track.assetId,JSON.stringify(summary.track))
    db.prepare('INSERT INTO local_catalog_assets VALUES(?,?,?,?,?,?)').run(summary.asset.id,summary.asset.libraryRootId,summary.asset.sourceRootId,fact.relative,null,JSON.stringify(summary.asset))
  }
  for (const value of editions) db.prepare('INSERT INTO local_catalog_editions VALUES(?,?)').run(value.id,JSON.stringify(value))
  for (const value of links) db.prepare('INSERT INTO local_catalog_edition_tracks VALUES(?,?,?,?)').run(value.id,value.trackId,value.editionId,JSON.stringify(value))
  for (const value of files.values()) db.prepare('INSERT INTO local_scan_file_state VALUES(?,?,?,?)').run(value.libraryRootId,value.relative,value.assetId,JSON.stringify(value))
  for (const value of cues) { assert.ok(dto.isLocalCuePreparedItem(value.item)); db.prepare('INSERT INTO local_cue_sources VALUES(?,?,?)').run(value.libraryRootId,value.item.relative,JSON.stringify(value)) }
  const raw = new Map(facts.map((fact,index) => [fact.summary.track.id,{ ordinal: index+1, fields: fact.rawMetadata }]))
  const projectionSql = `WITH source_full AS(SELECT json_extract(value,'$.trackId') track_id,json_extract(value,'$.ordinal') ordinal,json_extract(value,'$.fields') fields FROM json_each(@sourceRaw)),candidates AS (
    SELECT t.rowid ordinal,t.id,t.asset_id,t.data,a.id asset_record_id,a.root_id,a.source_root_id,a.relative,a.sha256,a.data asset_data,
    ${projectionFields.flatMap(field => [`json_extract(sf.fields,'$.${field}') raw_${field}`,`coalesce(json_extract(v.data,'$.fields.${field}'),json_extract(sf.fields,'$.${field}')) effective_${field}`]).join(',')}
    FROM local_catalog_tracks t JOIN local_catalog_assets a ON a.id=t.asset_id LEFT JOIN local_catalog_overrides v ON v.track_id=t.id LEFT JOIN source_full sf ON sf.track_id=t.id WHERE @root IS NULL OR a.root_id=@root)`
  let revision = 'catalog-1', sqlReads = 0, trackDecodes = 0, assetDecodes = 0, cueDecodes = 0
  const detailReads: string[] = [], versionReads: dto.LocalMetadata[] = [], sourceLookups: string[] = [], scanReads: { rootId: string; relative: string }[] = []
  observeSqlExecutions615(t, db, execution => {
    if (execution.phase === 'before' && execution.step === undefined && execution.sql.includes('source_rows AS')) sqlReads++
  })
  const codec: LocalAlbumSqlCodec = {
    track(row) { trackDecodes++; const value: unknown = JSON.parse(String(row.data)); if (!dto.isLocalTrack(value) || value.id !== row.id || value.assetId !== row.asset_id) throw new Error('合成轨道事实无效'); return value },
    asset(row) { assetDecodes++; const value: unknown = JSON.parse(String(row.data)); if (!dto.isAudioAsset(value) || value.id !== row.id || value.libraryRootId !== row.root_id || value.sourceRootId !== row.source_root_id) throw new Error('合成资产事实无效'); return value },
    versionTokens(raw) { versionReads.push({ ...raw }); return tokens(raw) },
    boundedRow(row) { for (const value of Object.values(row)) if (typeof value === 'string' && Buffer.byteLength(value)>65536) throw new Error('合成内部字节预算无效') },
    scanState(rid,relative) { scanReads.push({ rootId: rid, relative }); const row = db.prepare('SELECT data FROM local_scan_file_state WHERE library_root_id=? AND relative=?').get(rid,relative); return row ? JSON.parse(String(row.data)) as ScanFileState : null },
    cue(raw) { cueDecodes++; const value = JSON.parse(String(raw)) as LocalAlbumSqlCueStored; if (!dto.isLocalCuePreparedItem(value.item)) throw new Error('合成CUE事实无效'); return value },
  }
  const codecs = new WeakMap<DatabaseSync, LocalAlbumSqlCodec>()
  const codecFor = (database: DatabaseSync): LocalAlbumSqlCodec => {
    let saved = codecs.get(database)
    if (!saved) { saved = { ...codec, scanState(rid,relative) { scanReads.push({ rootId: rid, relative }); const row=database.prepare('SELECT data FROM local_scan_file_state WHERE library_root_id=? AND relative=?').get(rid,relative);return row?JSON.parse(String(row.data)) as ScanFileState:null } }; codecs.set(database, saved) }
    return saved
  }
  let sourceAuthor: { fingerprint: string; lookup: NonNullable<Parameters<typeof createLocalAlbumSqlReader>[1]['sourceLookup']> } | undefined
  const lookupAuthor = () => {
    const fingerprint = hash([...raw])
    if (!sourceAuthor || sourceAuthor.fingerprint !== fingerprint) {
      // 模拟正式Source投影的不可变作者；原raw十二字段改变会产生新函数身份，不能靠稳定lambda隐瞒事实变化。
      const snapshot = new Map([...raw].map(([identity, value]) => [identity, structuredClone(value)]))
      sourceAuthor = { fingerprint, lookup: identity => { sourceLookups.push(identity); return snapshot.get(identity) } }
    }
    return sourceAuthor.lookup
  }
  const readerFor = (database: DatabaseSync, changes: Partial<LocalAlbumSqlScope> = {}, sourceLookup = lookupAuthor(), authorCodec = codecFor(database)) => createLocalAlbumSqlReader(database,{ projectionSql, sourceLookup },authorCodec,{ revision: 'source-1', roots, nameEnhancements: names, ...changes })
  const reader = (changes: Partial<LocalAlbumSqlScope> = {}, sourceLookup?: ReturnType<typeof lookupAuthor>) => readerFor(db,changes,sourceLookup)
  const snapshot = (): LocalAlbumReadSnapshot => ({ revision: 'source-1', roots, tracks: facts, editions, editionLinks: links, nameEnhancements: names,
    rejected: [...files.values()].filter(value=>value.outcome==='rejected').map(value=>({ rootId:value.libraryRootId,relative:value.relative,revision:hash([value.signature,value.parserVersion,value.failureCode,value.readFacts?.coverEvidence??[]]),metadataReadFailed:value.failureCode==='PARSE_FAILED' })),
    cues: cues.map(value=>({ rootId:value.libraryRootId,relative:value.item.relative,revision:hash(value),status:value.item.outcome==='rejected'?'failed':'ready',audioAssetIds:[...new Set(value.item.result?.tracks.map(item=>item.assetReference.assetId)??[])],alreadySplit:value.item.outcome==='accepted'&&new Set(value.item.result!.tracks.map(item=>item.assetReference.assetId)).size===value.item.result!.tracks.length })) })
  const catalog = { roots:()=>roots.map(view=>view.root), privateAlbumBrowserRevision:()=>revision,
    // 纯SQL夹具没有management绑定；可见性只取本夹具实际roots闭集，不声称actualFactory或资源join。
    privateLibraryManagementRootVisible:(identity:string)=>roots.some(view=>view.root.id===identity),
    privateAlbumBrowserQuery:(request:dto.LocalAlbumQuery,scope:LocalAlbumSqlScope)=>reader(scope).queryAlbums(request),
    privateAlbumBrowserMembers:(request:dto.LocalAlbumTrackQuery,scope:LocalAlbumSqlScope)=>reader(scope).queryAlbumMembers(request),
    privateAlbumBrowserIssues:(request:dto.LocalAlbumTrackQuery,scope:LocalAlbumSqlScope,readOptions?:LocalAlbumSqlIssueReadOptions)=>reader(scope).queryAlbumIssues(request,readOptions),
    privateAlbumBrowserArtwork:(request:dto.LocalAlbumArtworkRequest,scope:LocalAlbumSqlScope)=>reader(scope).getArtworkContext(request),
    trackDetail(identity:string):dto.LocalLibraryTrackDetail { detailReads.push(identity); const fact=facts.find(value=>value.summary.track.id===identity)!; const editionIds=links.filter(value=>value.active&&value.trackId===identity).map(value=>value.editionId)
      return { ...structuredClone(fact.summary),metadata:{ raw:{...fact.rawMetadata},effective:{...fact.summary.metadata},override:null },editions:editions.filter(value=>editionIds.includes(value.id)),fileParameters:null } },
  }
  const repository = { localCatalog:catalog,localScan:{ privateAlbumBrowserRevision:()=> 'scan-1',privateDisplayFileParameters:()=>null } } as unknown as CollectionRepository
  const owner = (readArtwork:()=>Promise<LocalAlbumArtworkReadResult>=async()=>({ image:null,status:'ready' }),captureBudget?:{ maxMembers:number;maxBytes:number }) => {
    const service=createLocalAlbumOwnerService({ repository,assertCurrent(){},readRootViews:async()=>roots,readArtwork,...(captureBudget?{captureBudget}:{}) }); t.after(()=>service.close()); return service
  }
  const insertFact = (fact: LocalAlbumTrackFact): void => {
    const { summary } = fact; facts.push(fact); raw.set(summary.track.id, { ordinal: raw.size + 1, fields: fact.rawMetadata })
    db.prepare('INSERT INTO local_catalog_tracks VALUES(?,?,?)').run(summary.track.id, summary.track.assetId, JSON.stringify(summary.track))
    db.prepare('INSERT INTO local_catalog_assets VALUES(?,?,?,?,?,?)').run(summary.asset.id, summary.asset.libraryRootId, summary.asset.sourceRootId, fact.relative, null, JSON.stringify(summary.asset))
    const scan = accepted(fact); files.set(JSON.stringify([scan.libraryRootId, scan.relative]), scan)
    db.prepare('INSERT INTO local_scan_file_state VALUES(?,?,?,?)').run(scan.libraryRootId, scan.relative, scan.assetId, JSON.stringify(scan))
  }
  return { db,reader,readerFor,snapshot,owner,roots,facts,detailReads,versionReads,sourceLookups,scanReads,insertFact,lookupAuthor,codecFor, get sqlReads(){return sqlReads},get trackDecodes(){return trackDecodes},get assetDecodes(){return assetDecodes},get cueDecodes(){return cueDecodes},advanceRevision(){revision='catalog-2'},
    sourceRawReader:()=>createLocalAlbumSqlReader(db,{projectionSql,sourceRaw:JSON.stringify([...raw].map(([trackId,value])=>({trackId,...value})))},codecFor(db),{revision:'source-1',roots,nameEnhancements:names}) }
}
const comparable = (album:dto.LocalAlbumSummary) => { const {revision,...value}=album; return {...value,lyricsPresence:value.lyricsPresence??'unknown'} }
const byIdentity = (albums:readonly dto.LocalAlbumSummary[])=>[...albums].sort((a,b)=>a.id.localeCompare(b.id)).map(comparable)

test('冷专辑SQL：零成员与越界空页保留原组和total，成员和封面各只展开一次CTE', t => {
  const f = fixture(t, { tracks: [track(1, '有效/01.flac')], files: [rejected('拒收/01.bin', 'PARSE_FAILED')], cues: [cue(1, '零轨CUE/album.cue')] })
  const reader = f.reader(), albums = reader.queryAlbums(query()).items
  assert.equal(albums.filter(album => album.trackCount === 0).length, 2)
  for (const album of albums) {
    for (const offset of [0, 1, 200]) {
      const before = f.sqlReads, decodes = f.trackDecodes
      const page = reader.queryAlbumMembers({ albumKey: album.id, rootId, offset, limit: 200 })
      assert.equal(f.sqlReads - before, 1, '冷成员页只共享一次原groups/members，不另查find')
      assert.deepEqual(page.album, album); assert.equal(page.total, album.trackCount)
      assert.equal(page.items.length, offset === 0 ? album.trackCount : 0); assert.equal(page.hasMore, false)
      assert.equal(f.trackDecodes - decodes, page.items.length, '空成员占位不得送入原Track解码')
    }
    const before = f.sqlReads, context = reader.getArtworkContext(artworkRequest(album))
    assert.equal(f.sqlReads - before, 0, '同完整屏障的紧凑卡片只提供图源索引，不再次展开全库groups/members')
    assert.deepEqual(context.album, album); assert.equal(context.representative === null, album.trackCount === 0)
  }
  assert.throws(() => reader.queryAlbumMembers({ albumKey: albums[0]!.id, rootId: otherRootId, offset: 0, limit: 1 }), errorCode('SNAPSHOT_CHANGED'))
})

test('冷专辑SQL：库存状态仅在同run有界复用，unknown哨兵与inventory变化均不跨屏障', t => {
  const f = fixture(t, { tracks: [track(1, '甲/01.flac'), track(2, '乙/01.flac'), track(3, '丙/01.flac')] })
  let revision = 'artwork-1', state: 'available' | 'missing' | 'unknown' = 'unknown', changeDuringRead = false
  const persisted: string[] = [], reads: string[] = []
  const inventory = { revision: () => revision,
    readPersisted(albumKey: string, rid: string): 'available' | 'missing' | null {
      persisted.push(JSON.stringify([rid, albumKey]))
      if (changeDuringRead) { changeDuringRead = false; revision = 'artwork-4' }
      return state === 'unknown' ? null : state
    },
    read(albumKey: string, rid: string) { reads.push(JSON.stringify([rid, albumKey])); return state },
  }
  const assertOnce = (expectedReads: number, groups = 3): void => {
    assert.equal(persisted.length, groups); assert.equal(new Set(persisted).size, groups)
    assert.equal(reads.length, expectedReads); assert.equal(new Set(reads).size, expectedReads)
    persisted.length = 0; reads.length = 0
  }
  const reader = f.reader({ artworkInventory: inventory }), album = reader.queryAlbums(query()).items[0]!
  assertOnce(3); assert.equal(album.artworkState, 'unknown')
  const request = artworkRequest(album), members = { albumKey: album.id, rootId, offset: 0, limit: 1 }
  assert.equal(reader.getArtworkContext(request).album.artworkState, 'unknown'); assertOnce(1, 1)
  assert.equal(reader.queryAlbumMembers(members).album.artworkState, 'unknown'); assertOnce(1, 1)
  state = 'available'; revision = 'artwork-2'
  assert.throws(() => reader.getArtworkContext(request), errorCode('SNAPSHOT_CHANGED'))
  assert.equal(persisted.length, 0)
  const available = f.reader({ artworkInventory: inventory })
  assert.equal(available.getArtworkContext(request).album.artworkState, 'available'); assertOnce(0, 1)
  state = 'missing'; revision = 'artwork-3'
  const missing = f.reader({ artworkInventory: inventory })
  assert.equal(missing.queryAlbumMembers(members).album.artworkState, 'missing'); assertOnce(0)
  changeDuringRead = true
  assert.throws(() => missing.getArtworkContext(request), errorCode('SNAPSHOT_CHANGED'))
  persisted.length = 0; reads.length = 0
  assert.equal(f.reader({ artworkInventory: inventory }).getArtworkContext(request).album.artworkState, 'missing'); assertOnce(0, 1)
})

test('冷专辑SQL：上下文耗时仅输出闭集阶段与派生命中状态，不携带源事实', t => {
  const f = fixture(t, { tracks: [track(1, '私有目录/01.flac', { title: '私有曲名', artist: '私有艺人', album: '私有专辑' })] })
  const reader = f.reader(), album = reader.queryAlbums(query()).items[0]!, request = { albumKey: album.id, rootId, offset: 0, limit: 1 }
  const lines: string[] = [], original = console.info
  console.info = (...values: unknown[]) => { for (const value of values) if (typeof value === 'string') lines.push(value) }
  t.after(() => { console.info = original })
  reader.queryAlbumMembers(request); reader.getArtworkContext(artworkRequest(album))
  reader.queryAlbumIssues(request)
  reader.queryAlbumMembers(request); reader.getArtworkContext(artworkRequest(album))
  assert.throws(() => reader.getArtworkContext({ ...artworkRequest(album), revision: 'stale' }), errorCode('SNAPSHOT_CHANGED'))
  const events = lines.map(readLibraryOperationLine).filter(value => value?.action === 'albums.members-page' || value?.action === 'albums.artwork-context')
  assert.equal(events.length, 5)
  assert.deepEqual(events.map(event => [event!.action, event!.state]), [
    ['albums.members-page', 'miss'], ['albums.artwork-context', 'hit'], ['albums.members-page', 'hit'], ['albums.artwork-context', 'hit'], ['albums.artwork-context', 'error'],
  ])
  for (const event of events) {
    assert.equal(event!.part, 'cache'); assert.ok(Number.isFinite(event!.elapsedMs) && event!.elapsedMs! >= 0)
    assert.ok(['DERIVED_HIT', 'DERIVED_MISS', 'COMPACT_HIT', 'DIRECTORY_HINT', 'NOT_CHECKED'].includes(event!.code!))
    assert.equal(event!.id, undefined)
  }
  assert.equal(lines.some(line => /私有目录|私有曲名|私有艺人|私有专辑/u.test(line)), false)
})

test('精确页缓存：同屏障重复请求只聚合一次，原guard与前后屏障每次执行且返回值隔离', t => {
  const f = fixture(t, { tracks: [track(1, '甲/01.flac', undefined, { embedded: true }), track(2, '乙/01.flac')] })
  const reader = f.reader(), request = query({ rootId, limit: 1 })
  let guards = 0, barriers = 0, authorized = true
  observeSqlExecutions615(t, f.db, execution => {
    if (execution.phase === 'before' && execution.step === undefined && execution.sql === 'SELECT total_changes() changes') barriers++
  })
  const denied = new Error('合成原guard已撤权')
  const guarded = () => readWithLocalAlbumSqlErrors(<V>(action: (db: DatabaseSync) => V): V => {
    guards++; if (!authorized) throw denied; return action(f.db)
  }, () => reader.queryAlbums(request))
  const first = guarded(), original = structuredClone(first), reads = f.sqlReads
  Object.assign(first.counts, { all: 999 }); first.items[0]!.title = '不能污染缓存'
  ;(first.items[0]!.artists as string[]).push('不能污染艺人')
  const second = guarded()
  assert.deepEqual(second, original); assert.notEqual(first, second); assert.notEqual(first.items[0], second.items[0])
  assert.equal(f.sqlReads, reads, '相同请求命中后不能再次执行完整groups SQL')
  assert.equal(guards, 2); assert.equal(barriers, 4, '命中仍须读取本次前后两份SQL水位')
  second.items[0]!.title = '第二次回复也不能污染缓存'; assert.deepEqual(guarded(), original)
  authorized = false; assert.throws(guarded, error => error === denied); assert.equal(guards, 4)
})

test('精确页缓存：分页搜索筛选和根构成完整请求键，确认空结果也可复用', t => {
  const f = fixture(t, { tracks: [track(1, '甲/01.flac', { title: '甲曲目', artist: '合成艺人', album: '甲专辑' }, { embedded: true }), track(2, '乙/01.flac'), track(3, '外库/01.flac', undefined, { rootId: otherRootId })] })
  const reader = f.reader()
  let pageReads = 0
  observeSqlExecutions615(t, f.db, execution => { if (execution.phase === 'before' && execution.step === undefined && execution.sql.includes('envelope FROM counts')) pageReads++ })
  const requests = [query({ limit: 1 }), query({ limit: 2 }), query({ offset: 1, limit: 1 }), query({ rootId, limit: 1 }),
    query({ rootId: otherRootId, limit: 1 }), query({ query: '甲专辑', limit: 1 }), query({ filter: 'has-artwork', limit: 1 }), query({ query: '确认没有此专辑', limit: 1 })]
  for (const request of requests) {
    const before = pageReads, page = reader.queryAlbums(request)
    assert.equal(pageReads, before + 1, '每个不同完整请求必须独立读取实际分页SQL，不能误用另一请求的公开页')
    assert.ok(dto.isLocalAlbumPage(page, request)); assert.deepEqual(reader.queryAlbums({ ...request }), page)
    assert.equal(pageReads, before + 1, '相同值的新请求对象仍应复用精确页')
  }
  assert.equal(f.sqlReads, 1, '同完整屏障各页、搜索、筛选和根复用一份覆盖全根的紧凑groups')
})

test('精确页缓存：catalog及scan写入和rollback及schema水位变化均丢弃旧页', t => {
  const value = track(1, '原组/01.flac'), f = fixture(t, { tracks: [value] }), reader = f.reader(), request = query()
  const first = reader.queryAlbums(request)
  const reread = () => { const before = f.sqlReads, page = reader.queryAlbums(request); assert.equal(f.sqlReads, before + 1); return page }
  f.db.exec('BEGIN IMMEDIATE')
  f.db.prepare('INSERT INTO local_catalog_overrides VALUES(?,?)').run(value.summary.track.id, JSON.stringify({ trackId: value.summary.track.id, revision: '1', fields: { album: '仅事务内' } }))
  assert.equal(reread().items[0]!.title, '仅事务内')
  f.db.exec('ROLLBACK'); assert.deepEqual(reread(), first)
  const scanning = accepted({ ...value, hasArtwork: true }); scanning.signature += '-新扫描'
  f.db.prepare('UPDATE local_scan_file_state SET data=? WHERE library_root_id=? AND relative=?').run(JSON.stringify(scanning), rootId, value.relative)
  const scanned = reread(); assert.equal(scanned.items[0]!.artworkState, 'available'); assert.notEqual(scanned.items[0]!.revision, first.items[0]!.revision)
  f.db.exec('CREATE TABLE unrelated_page_cache_fence(id TEXT)'); assert.deepEqual(reread(), scanned)
})

test('精确页缓存：外部commit由data_version失效，命中后水位变化仍拒绝本次返回', async t => {
  const temporary = process.env.TMPDIR; assert.ok(temporary && path.isAbsolute(temporary))
  if (process.platform === 'darwin') assert.ok(temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'))
  const directory = await mkdtemp(path.join(temporary, 'album-page-cache-')), file = path.join(directory, 'synthetic.sqlite')
  const value = track(1, '连接/01.flac'), f = fixture(t, { tracks: [value], databasePath: file }), reader = f.reader(), request = query()
  const other = new DatabaseSync(file)
  t.after(async () => { if (other.isOpen) other.close(); if (f.db.isOpen) f.db.close(); await rm(directory, { recursive: true }) })
  const first = reader.queryAlbums(request), before = f.sqlReads
  other.prepare('INSERT INTO local_catalog_overrides VALUES(?,?)').run(value.summary.track.id, JSON.stringify({ trackId: value.summary.track.id, revision: '1', fields: { album: '其它连接提交' } }))
  const current = reader.queryAlbums(request); assert.equal(f.sqlReads, before + 1); assert.equal(current.items[0]!.title, '其它连接提交'); assert.notEqual(current.items[0]!.revision, first.items[0]!.revision)
  let barriers = 0, changed = false
  observeSqlExecutions615(t, f.db, execution => {
    if (execution.phase === 'before' && execution.step === undefined && execution.sql === 'SELECT total_changes() changes' && ++barriers === 2) {
      changed = true
      f.db.prepare('UPDATE local_catalog_overrides SET data=? WHERE track_id=?').run(JSON.stringify({ trackId: value.summary.track.id, revision: '2', fields: { album: '返回前改变' } }), value.summary.track.id)
    }
  })
  assert.throws(() => reader.queryAlbums(request), errorCode('SNAPSHOT_CHANGED')); assert.equal(changed, true)
  const afterFailure = f.sqlReads; assert.equal(reader.queryAlbums(request).items[0]!.title, '返回前改变'); assert.equal(f.sqlReads, afterFailure + 1)
})

test('精确页缓存：root授权与组织及来源scope变化拒旧页，新作者读取当前组织', t => {
  const f = fixture(t, { tracks: [track(1, '甲/01.flac'), track(2, '乙/01.flac')] }), request = query({ rootId })
  const organizations: LocalAlbumLibraryOrganization[] = [{ datasetId: id(900), rootId, sourceRootId: id(101), rootRevision: '1', bindingRevision: 1, recordSha256: 'a'.repeat(64), role: 'artist', rootName: '合成艺人', parentName: '合成父目录' }]
  const reader = f.reader({ libraryOrganizations: organizations }); assert.equal(reader.queryAlbums(request).total, 2)
  organizations[0]!.role = 'album'; organizations[0]!.bindingRevision = 2
  assert.throws(() => reader.queryAlbums(request), errorCode('SNAPSHOT_CHANGED'))
  const organized = f.reader({ libraryOrganizations: organizations }); assert.equal(organized.queryAlbums(request).total, 1)
  f.roots[0]!.availability = 'REVOKED'; assert.throws(() => organized.queryAlbums(request), errorCode('SNAPSHOT_CHANGED'))
  assert.equal(f.reader({ libraryOrganizations: organizations }).queryAlbums(request).items[0]!.artworkState, 'source-unavailable')
  f.roots[0]!.availability = 'ONLINE'
  const current = f.reader(), original = current.queryAlbums(request), reads = f.sqlReads
  assert.deepEqual(f.reader({ revision: 'source-2' }).queryAlbums(request).items.map(item => item.id), original.items.map(item => item.id)); assert.equal(f.sqlReads, reads + 1)
  f.roots[0]!.root.revision = '2'; assert.throws(() => current.queryAlbums(request), errorCode('SNAPSHOT_CHANGED'))
  assert.equal(f.reader().queryAlbums(request).items.length, 2)
})

test('精确页缓存：歌词与封面inventory修订和不同作者不能继承旧页', t => {
  const f = fixture(t, { tracks: [track(1, '库存/01.flac')] }), request = query()
  let lyricsState: 'unknown' | 'false' | 'true' = 'unknown', lyricsRevision = 'lyrics-1'
  const lyricsInventory = { revision: () => lyricsRevision, read: () => lyricsState }, reader = f.reader({ lyricsInventory })
  assert.equal(reader.queryAlbums(request).items[0]!.lyricsPresence, 'unknown'); const before = f.sqlReads
  lyricsState = 'false'; lyricsRevision = 'lyrics-2'; assert.equal(reader.queryAlbums(request).items[0]!.lyricsPresence, 'false'); assert.equal(f.sqlReads, before + 1)
  const beforeOther = f.sqlReads
  assert.equal(f.reader({ lyricsInventory: { revision: () => lyricsRevision, read: () => 'true' } }).queryAlbums(request).items[0]!.lyricsPresence, 'true'); assert.equal(f.sqlReads, beforeOther + 1)
  let artworkState: 'available' | 'missing' | 'unknown' = 'unknown', artworkRevision = 'artwork-1'
  const artworkInventory = { revision: () => artworkRevision, read: () => artworkState }, artwork = f.reader({ artworkInventory })
  assert.equal(artwork.queryAlbums(request).items[0]!.artworkState, 'unknown')
  artworkState = 'available'; artworkRevision = 'artwork-2'; assert.throws(() => artwork.queryAlbums(request), errorCode('SNAPSHOT_CHANGED'))
  assert.equal(f.reader({ artworkInventory }).queryAlbums(request).items[0]!.artworkState, 'available')
  assert.equal(f.reader({ artworkInventory: { revision: () => artworkRevision, read: () => 'missing' } }).queryAlbums(request).items[0]!.artworkState, 'missing')
})

test('精确页缓存：最多8页按最近使用淘汰，超界后仍返回完整counts与合法页', t => {
  const f = fixture(t, { tracks: Array.from({ length: 10 }, (_, index) => track(index + 1, `目录${index}/01.flac`)) }), reader = f.reader()
  let pageReads = 0
  observeSqlExecutions615(t, f.db, execution => { if (execution.phase === 'before' && execution.step === undefined && execution.sql.includes('envelope FROM counts')) pageReads++ })
  const requests = Array.from({ length: 9 }, (_, offset) => query({ limit: 1, offset }))
  for (const request of requests.slice(0, 8)) assert.equal(reader.queryAlbums(request).total, 10)
  const before = pageReads; reader.queryAlbums(requests[0]!); assert.equal(pageReads, before, '第1页命中晋升为最近使用')
  reader.queryAlbums(requests[8]!); assert.equal(pageReads, before + 1)
  reader.queryAlbums(requests[0]!); reader.queryAlbums(requests[7]!); assert.equal(pageReads, before + 1)
  const evicted = reader.queryAlbums(requests[1]!); assert.equal(pageReads, before + 2); assert.equal(evicted.items.length, 1); assert.equal(evicted.counts.all, 10)
  assert.equal(f.sqlReads, 1, '公开页淘汰后可重新分页紧凑groups，不能因此重建全成员')
})

test('精确页缓存：4MiB编码字节先于8页触发淘汰，不改变原2MiB单页预算', t => {
  const values = Array.from({ length: 800 }, (_, index) => track(index + 1, `合成组${Math.floor(index / 8)}/${index % 8 + 1}.flac`, { title: `曲目${index + 1}`, artist: `${index % 8}${'艺'.repeat(511)}`, album: `合成专辑${Math.floor(index / 8)}` }))
  const f = fixture(t, { tracks: values }), reader = f.reader()
  let pageReads = 0
  observeSqlExecutions615(t, f.db, execution => { if (execution.phase === 'before' && execution.step === undefined && execution.sql.includes('envelope FROM counts')) pageReads++ })
  const requests = ['', '合成', '专辑', '成专'].map(queryText => query({ query: queryText, limit: 100 }))
  let combinedBytes = 0
  for (const request of requests) { const page = reader.queryAlbums(request); assert.equal(page.total, 100); assert.equal(page.items.length, 100); const bytes = Buffer.byteLength(JSON.stringify(page)); assert.ok(bytes < LOCAL_ALBUM_SQL_ENVELOPE_MAX_BYTES); combinedBytes += bytes }
  assert.ok(combinedBytes > 4 * 1024 * 1024, '夹具4页真实公开JSON已超过缓存字节预算')
  const before = pageReads; reader.queryAlbums(requests[3]!); assert.equal(pageReads, before, '最新合法大页仍可复用')
  const evicted = reader.queryAlbums(requests[0]!); assert.equal(pageReads, before + 1, '不足8页时也必须淘汰超字节上限的最旧页'); assert.equal(evicted.counts.all, 100)
})

test('播放物化定向SQL：真实冷Owner保205成员及完整问题和拒收事实且不构造全库索引', async t => {
  const values = Array.from({ length: 205 }, (_, index) => track(index+1, `目标/${String(index+1).padStart(3,'0')}.flac`, { artist: '合成艺人', album: '目标专辑', track: String(index+1) }))
  const outside = track(801, '其它/001.flac'), foreign = track(802, '目标/001.flac', { artist: '合成艺人', album: '目标专辑', track: '1' }, { rootId: otherRootId })
  const files = Array.from({ length: 205 }, (_, index) => rejected(`目标/rejected-${String(index+1).padStart(3,'0')}.bin`, index === 0 ? 'PARSE_FAILED' : 'UNSUPPORTED'))
  const f = fixture(t, { tracks: [outside, ...values, foreign], files }), service = f.owner()
  let derivedReads = 0
  observeSqlExecutions615(t, f.db, execution => {
    if (execution.phase === 'before' && execution.step === undefined && execution.sql.includes('mb_album_derived_snapshot')) derivedReads++
  })
  const album = (await service.queryAlbums(query())).items.find(value => value.rootId === rootId && value.representativeTrackId === values[0]!.summary.track.id)!
  assert.ok(album); assert.equal(album.kind, 'source-directory'); assert.equal(album.trackCount, 205)
  assert.equal(derivedReads, 0, '物化前未用问题读取或inspect预热同一DB')
  const expected = groupLocalAlbumSnapshot(f.snapshot()).groups.find(value => value.summary.id === album.id && value.summary.rootId === rootId)!
  assert.ok(expected); assert.equal(expected.members.length, 205); assert.ok(expected.issues.length > 200); assert.equal(expected.rejectedFiles!.length, 205)
  // 端口实读同一SQLite当前行；只合成来源授权，不开启文件、票据或媒体请求。
  const repository = { localCatalog: {
    track(identity: string) { const row = f.db.prepare('SELECT data FROM local_catalog_tracks WHERE id=?').get(identity); assert.ok(row); const value: unknown = JSON.parse(String(row.data)); assert.ok(dto.isLocalTrack(value)); return value },
    asset(identity: string) { const row = f.db.prepare('SELECT data FROM local_catalog_assets WHERE id=?').get(identity); assert.ok(row); const value: unknown = JSON.parse(String(row.data)); assert.ok(dto.isAudioAsset(value)); return value },
    root(identity: string) { const value = f.roots.find(view => view.root.id === identity); assert.ok(value); return structuredClone(value.root) },
  }, sources: { root(identity: string) { const value = f.roots.find(view => view.root.sourceRootId === identity); assert.ok(value); return { id: identity, authorized: true } } } } as unknown as CollectionRepository
  const anchor = expected.members[200]!.fact.summary, datasetId = id(900001)
  const selection: dto.LocalPlayRequest = { schema_version: '1.2', request_id: id(900002), route: 'roon_audio_input', source_kind: 'local_file',
    local_track_id: anchor.track.id, asset_id: anchor.asset.id, expected_asset_revision: anchor.asset.fileRevision,
    target: { core_id: 'synthetic-core', zone_id: 'synthetic-zone' }, action: 'PLAY_NOW',
    album: { datasetId, albumKey: album.id, rootId: album.rootId, revision: album.revision, kind: album.kind, editionId: album.editionId, trackCount: album.trackCount } }
  let captured: Awaited<ReturnType<typeof service.inspectAlbum>> | undefined, inspectCalls = 0
  const albums = { async inspectAlbum(request: Parameters<typeof service.inspectAlbum>[0]) { inspectCalls++; captured = await service.inspectAlbum(request); return captured } }
  const result = await materializeLocalAlbumQueue(repository, albums, selection, datasetId, Date.now()+2000, () => {})
  assert.equal(inspectCalls, 1); assert.ok(captured)
  assert.equal(derivedReads, 0, '真正冷物化的首页及后续问题/拒收页均不得主动构造全库派生')
  assert.equal(result.sources.length, 205); assert.equal(result.startIndex, 200)
  assert.deepEqual(result.sources.map(value => value.snapshot.trackId), expected.members.map(value => value.fact.summary.track.id))
  assert.equal(new Set(result.sources.map(value => value.snapshot.trackId)).size, 205)
  assert.ok(result.sources.every(value => value.snapshot.libraryRootId === rootId && value.snapshot.sourceRootId === id(101)))
  assert.ok(result.sources.every(value => value.snapshot.trackId !== outside.summary.track.id && value.snapshot.trackId !== foreign.summary.track.id))
  const sorted = (items: readonly unknown[]) => items.map(value => JSON.stringify(value)).sort()
  assert.deepEqual(sorted(captured.issues), sorted(expected.issues)); assert.deepEqual(sorted(captured.rejectedFiles!), sorted(expected.rejectedFiles!))
  assert.equal(Object.isFrozen(captured.members[204]!.fact.summary.asset), true); assert.equal(f.detailReads.length, 0)
  await assert.rejects(service.inspectAlbum({ albumKey: album.id, rootId: otherRootId, revision: album.revision }), errorCode('SNAPSHOT_CHANGED'))
  await assert.rejects(materializeLocalAlbumQueue(repository, albums, selection, datasetId, Date.now()-1, () => {}), error => error instanceof MBQueueStoreError && error.code === 'QUEUE_CONFLICT')
  assert.equal(inspectCalls, 1, '过期请求在Owner读取前仍按原期限拒绝')
})

test('专辑定向SQL：冷详情和单图不构造全库索引，合法热缓存与原屏障同结果', t => {
  const first = track(71, '目标/01.flac', { title: '第一首', artist: '合成艺人', album: '目标专辑', track: '1' })
  const covered = track(72, '目标/02.flac', { title: '第二首', artist: '合成艺人', album: '目标专辑', track: '2' }, { embedded: true })
  const tail = track(73, '目标/03.flac', { title: '第三首', artist: '合成艺人', album: '目标专辑', track: '3' })
  const f = fixture(t, { tracks: [track(74, '其它/01.flac'), first, covered, tail,
    track(75, '目标/00.flac', undefined, { rootId: otherRootId, embedded: true })] }), reader = f.reader()
  let derivedReads = 0
  observeSqlExecutions615(t, f.db, execution => {
    if (execution.phase === 'before' && execution.step === undefined && execution.sql.includes('mb_album_derived_snapshot')) derivedReads++
  })
  const albums = reader.queryAlbums(query()), album = albums.items.find(item => item.representativeTrackId === first.summary.track.id)!
  assert.ok(album); assert.equal(album.trackCount, 3)
  const request = { albumKey: album.id, rootId, offset: 0, limit: 1 }, imageRequest = artworkRequest(album)
  let before = f.sqlReads
  const head = reader.queryAlbumMembers(request); assert.equal(f.sqlReads - before, 1)
  before = f.sqlReads
  const last = reader.queryAlbumMembers({ ...request, offset: 2 }); assert.equal(f.sqlReads - before, 1)
  before = f.sqlReads
  const imageContext = reader.getArtworkContext(imageRequest); assert.equal(f.sqlReads - before, 0)
  assert.equal(derivedReads, 0, '普通冷详情/尾页/单图不能主动执行全库group/member/issues/rejected派生')
  assert.equal(head.total, 3); assert.equal(head.hasMore, true); assert.equal(head.items[0]!.fact.summary.track.id, first.summary.track.id)
  assert.equal(last.total, 3); assert.equal(last.hasMore, false); assert.equal(last.items[0]!.fact.summary.track.id, tail.summary.track.id)
  assert.deepEqual(imageContext.album, album); assert.equal(imageContext.representative!.summary.track.id, covered.summary.track.id)
  assert.equal(imageContext.representative!.summary.asset.libraryRootId, rootId)
  assert.throws(() => reader.getArtworkContext({ ...imageRequest, revision: 'synthetic-old-revision' }), errorCode('SNAPSHOT_CHANGED'))
  assert.throws(() => reader.getArtworkContext({ ...imageRequest, editionId: id(90001) }), errorCode('SNAPSHOT_CHANGED'))
  assert.throws(() => reader.getArtworkContext({ ...imageRequest, representativeTrackId: covered.summary.track.id }), errorCode('SNAPSHOT_CHANGED'))
  reader.queryAlbumIssues(request)
  assert.equal(derivedReads, 1, '只有显式问题读取才按原逻辑构造完整派生')
  assert.deepEqual(reader.queryAlbumMembers(request), head); assert.deepEqual(reader.queryAlbumMembers({ ...request, offset: 2 }), last)
  assert.deepEqual(reader.getArtworkContext(imageRequest), imageContext); assert.equal(derivedReads, 1)
  f.db.prepare('UPDATE local_catalog_tracks SET data=? WHERE id=?').run(JSON.stringify({ ...covered.summary.track, selectionRevision: '2' }), covered.summary.track.id)
  assert.throws(() => reader.getArtworkContext(imageRequest), errorCode('SNAPSHOT_CHANGED'))
  const revised = reader.queryAlbums(query()).items.find(item => item.id === album.id)!, current = reader.getArtworkContext(artworkRequest(revised))
  assert.notEqual(revised.revision, album.revision); assert.equal(current.representative!.summary.track.selectionRevision, '2'); assert.equal(derivedReads, 1)
  f.roots[0]!.availability = 'REVOKED'
  assert.throws(() => reader.queryAlbumMembers(request), errorCode('SNAPSHOT_CHANGED'))
})

test('426 SQL派生：同连接完整全组索引跨读操作复用，原事实按实际ID重读且返回值不能污染缓存', t=>{
  const values=Array.from({length:36},(_,n)=>track(n+1,`完整${Math.floor(n/3)}/${n%3+1}.flac`,{artist:'合成艺人',album:`专辑${Math.floor(n/3)}`})),f=fixture(t,{tracks:values})
  const albums=f.reader().queryAlbums(query()).items,before=f.sqlReads
  f.reader().queryAlbumIssues({albumKey:albums[0]!.id,rootId:albums[0]!.rootId,offset:0,limit:200})
  for(const album of albums){
    const request={albumKey:album.id,rootId:album.rootId,offset:0,limit:200},page=f.reader().queryAlbumMembers(request)
    assert.equal(page.total,3);assert.equal(page.items.length,3);assert.deepEqual(page.album,album)
    const issues=f.reader().queryAlbumIssues(request);assert.equal(issues.total,3);assert.equal(issues.rejectedTotal,0)
    page.album.title='不能污染原组';page.items[0]!.fact.rawMetadata.artist='不能污染原字段'
    const first=issues.items[0]!;assert.equal(first.kind,'missing-metadata');if(first.kind==='missing-metadata')Reflect.set(first.fields,first.fields.length,'artist')
    const repeated=f.reader().queryAlbumMembers(request),again=f.reader().queryAlbumIssues(request)
    assert.deepEqual(repeated.album,album);assert.equal(repeated.items[0]!.fact.rawMetadata.artist,'合成艺人')
    assert.deepEqual(again.items[0],{kind:'missing-metadata',trackId:repeated.items[0]!.fact.summary.track.id,fields:['title']})
  }
  assert.equal(f.sqlReads-before,2,'显式issue先走原target核验再构造一次完整派生，十二个target复用此完整索引')
  assert.equal(f.trackDecodes,72,'每次详情仍实读当页的原track行，缓存不替代DTO与Source事实核验')
})

test('426 SQL派生：同连接写入与rollback及schema变化废弃完整索引，损坏原行仍失败',t=>{
  const a=track(1,'原组/01.flac'),f=fixture(t,{tracks:[a]}),album=f.reader().queryAlbums(query()).items[0]!,r=f.reader(),request={albumKey:album.id,rootId,offset:0,limit:1}
  r.queryAlbumIssues(request)
  const first=r.queryAlbumMembers(request),initial=f.sqlReads
  f.db.exec('BEGIN IMMEDIATE');f.db.prepare('INSERT INTO local_catalog_overrides VALUES(?,?)').run(a.summary.track.id,JSON.stringify({trackId:a.summary.track.id,revision:'1',fields:{title:'仅事务内'}}))
  assert.equal(r.queryAlbumMembers(request).items[0]!.fact.summary.metadata.title,'仅事务内')
  assert.equal(f.sqlReads-initial,1)
  r.queryAlbumIssues(request);const beforeRollback=f.sqlReads
  f.db.exec('ROLLBACK');const restored=r.queryAlbumMembers(request)
  assert.deepEqual(restored,first);assert.equal(f.sqlReads-beforeRollback,1,'rollback不能复用事务内真实完整索引，仍走一次完整组与当页SQL')
  r.queryAlbumIssues(request);const beforeSchema=f.sqlReads
  f.db.exec('CREATE TABLE unrelated_derived_fence(id TEXT)');assert.deepEqual(r.queryAlbumMembers(request),first);assert.equal(f.sqlReads-beforeSchema,1)
  f.db.prepare('UPDATE local_catalog_tracks SET data=? WHERE id=?').run('{损坏原行',a.summary.track.id)
  assert.throws(()=>r.queryAlbumMembers(request),errorCode('UNAVAILABLE'))
})

test('426 SQL派生：歌词实际revision及root作者scope均入屏障，不以相同revision的其它inventory对象继承',t=>{
  const a=track(1,'歌词组/01.flac'),f=fixture(t,{tracks:[a]}),album=f.reader().queryAlbums(query()).items[0]!,request={albumKey:album.id,rootId,offset:0,limit:1}
  let state:'unknown'|'false'|'true'='unknown',revision='lyrics-1'
  const inventory={revision:()=>revision,read:()=>state},r=f.reader({lyricsInventory:inventory})
  r.queryAlbumIssues(request)
  assert.equal(r.queryAlbumMembers(request).album.lyricsPresence,'unknown');const before=f.sqlReads
  state='false';revision='lyrics-2';const missing=r.queryAlbumMembers(request);assert.equal(missing.album.lyricsPresence,'false');assert.ok(missing.album.statuses.includes('missing-lyrics'))
  assert.equal(f.sqlReads-before,1);r.queryAlbumIssues(request);const beforePresent=f.sqlReads
  state='true';revision='lyrics-3';assert.equal(r.queryAlbumMembers(request).album.lyricsPresence,'true');assert.equal(f.sqlReads-beforePresent,1)
  r.queryAlbumIssues(request);const beforeOtherInventory=f.sqlReads
  const other={revision:()=>revision,read:()=>'false' as const};assert.equal(f.reader({lyricsInventory:other}).queryAlbumMembers(request).album.lyricsPresence,'false')
  assert.equal(f.sqlReads-beforeOtherInventory,1,'相同revision的另一个inventory不能复用当前真实完整索引')
  f.roots[0]!.availability='REVOKED';const offline=f.reader({lyricsInventory:inventory}).queryAlbumMembers(request)
  assert.equal(offline.album.lyricsPresence,'unknown');assert.ok(!offline.album.statuses.includes('missing-lyrics'))
  assert.throws(()=>r.queryAlbumMembers(request),errorCode('SNAPSHOT_CHANGED'),'已持有scope不能静默替换根许可状态')
  f.roots[0]!.availability='ONLINE';const changedScope=f.reader({revision:'source-2',lyricsInventory:inventory}).queryAlbumMembers(request)
  assert.equal(changedScope.album.lyricsPresence,'true')
  const source=f.sourceRawReader();source.queryAlbumMembers(request);source.queryAlbumIssues(request);a.rawMetadata.title='当前原Source字段'
  assert.equal(f.sourceRawReader().queryAlbumMembers(request).items[0]!.fact.rawMetadata.title,'当前原Source字段','完整sourceRaw编码不同不能继承旧组事实')
})

test('426 SQL派生：外部连接commit的data_version和cold新连接均不能继承旧组',async t=>{
  const temp=await mkdtemp(path.join(process.env.TMPDIR!,'core426-sql-')),file=path.join(temp,'synthetic.sqlite'),a=track(1,'连接组/01.flac'),f=fixture(t,{tracks:[a],databasePath:file})
  t.after(async()=>{if(f.db.isOpen)f.db.close();await rm(temp,{recursive:true,force:true})})
  const album=f.reader().queryAlbums(query()).items[0]!,request={albumKey:album.id,rootId,offset:0,limit:1},r=f.reader()
  r.queryAlbumIssues(request)
  const first=r.queryAlbumMembers(request)
  const other=new DatabaseSync(file);t.after(()=>{if(other.isOpen)other.close()})
  other.prepare('INSERT INTO local_catalog_overrides VALUES(?,?)').run(a.summary.track.id,JSON.stringify({trackId:a.summary.track.id,revision:'1',fields:{title:'另一真实连接'}}))
  const actual=r.queryAlbumMembers(request);assert.equal(actual.items[0]!.fact.summary.metadata.title,'另一真实连接');assert.notEqual(actual.album.revision,first.album.revision)
  other.close();f.db.close();const cold=new DatabaseSync(file);t.after(()=>{if(cold.isOpen)cold.close()})
  assert.deepEqual(f.readerFor(cold).queryAlbumMembers(request),actual);cold.close()
  const fresh=fixture(t,{tracks:[track(1,'连接组/01.flac',{title:'完全不同DB',artist:'合成艺人',album:'同名专辑'})]})
  assert.equal(fresh.reader().queryAlbumMembers(request).items[0]!.fact.rawMetadata.title,'完全不同DB','同scope及相同total_changes不赋予另一DatabaseSync缓存资格')
})

test('426 SQL派生：当页原SQL变化中止返回并丢弃索引，重新读取只给当前完整事实',t=>{
  const a=track(1,'中途组/01.flac'),f=fixture(t,{tracks:[a]}),album=f.reader().queryAlbums(query()).items[0]!,request={albumKey:album.id,rootId,offset:0,limit:1},r=f.reader()
  r.queryAlbumIssues(request);r.queryAlbumMembers(request);const prepare=f.db.prepare.bind(f.db);let once=true
  observeSqlExecutions615(t, f.db, execution => {
    if (execution.method === 'all' && execution.phase === 'after' && execution.step === undefined && execution.sql.includes('FROM page_members p') && !execution.sql.includes('source_rows AS') && once) {
      once = false
      prepare('INSERT INTO local_catalog_overrides VALUES(?,?)').run(a.summary.track.id,JSON.stringify({trackId:a.summary.track.id,revision:'1',fields:{title:'操作中改变'}}))
    }
  })
  assert.throws(()=>r.queryAlbumMembers(request),errorCode('SNAPSHOT_CHANGED'))
  assert.equal(once, false, 'cached Statement实际all返回后必须执行原SQL mutation')
  assert.equal(r.queryAlbumMembers(request).items[0]!.fact.summary.metadata.title,'操作中改变')
})

test('426 SQL派生：超缓存预算整件放弃而不截断合法页，后续原组与所有counts保持',t=>{
  const deep=Array.from({length:19},()=>'a'.repeat(200)).join('/'),values=Array.from({length:2000},(_,n)=>track(n+1,`${deep}/大组${Math.floor(n/10)}/${n%10+1}.flac`,{title:`曲目${n+1}`,artist:'合成艺人',album:`专辑${Math.floor(n/10)}`})),f=fixture(t,{tracks:values})
  const albums=f.reader().queryAlbums(query({limit:1,offset:199}));assert.equal(albums.total,200);assert.equal(albums.counts.all,200)
  const album=albums.items[0]!,request={albumKey:album.id,rootId,offset:9,limit:1}
  f.reader().queryAlbumIssues(request)
  const before=f.sqlReads,first=f.reader().queryAlbumMembers(request)
  assert.equal(first.total,10);assert.equal(first.items.length,1);assert.equal(first.hasMore,false);assert.equal(f.sqlReads-before,1,'显式派生整件超界后只共享一次原完整组及成员SQL')
  const beforeAgain=f.sqlReads,again=f.reader().queryAlbumMembers({...request,offset:0,limit:200});assert.equal(again.items.length,10);assert.deepEqual(again.items.at(-1),first.items[0])
  assert.equal(f.sqlReads-beforeAgain,1,'同屏障整件不可缓存时直接执行一次原完整SQL，不重复读出失败缓存前缀')
  assert.equal(f.reader().queryAlbums(query({offset:200,limit:1})).total,200)
})

test('MBF SQL V2：完整counts和当页只构造一次groups，超尾空页仍保留搜索与七类counts',t=>{
  const values=Array.from({length:12},(_,index)=>track(index+1,`目录${index}/01.flac`,{title:`曲目${index}`,artist:'合成艺人',album:`专辑${index}`,year:'2026'})),f=fixture(t,{tracks:values})
  const before=f.sqlReads,page=f.reader().queryAlbums(query({offset:7,limit:3}))
  assert.equal(f.sqlReads-before,1,'一次gallery只能构造一次完整groups，不能counts/items各跑一套')
  assert.equal(page.total,12);assert.equal(page.counts.all,12);assert.equal(page.items.length,3);assert.equal(f.trackDecodes,0);assert.equal(f.assetDecodes,0)
  const empty=f.reader().queryAlbums(query({query:'专辑',offset:100,limit:3}));assert.equal(empty.items.length,0);assert.equal(empty.total,12);assert.equal(empty.counts.all,12)
  const repeated=f.reader().queryAlbums(query({offset:7,limit:3}));assert.deepEqual(repeated.items,page.items)
})

test('MBF SQL V2：版本memo按album与剩余64cap保留合法title/artist反例和分组身份',t=>{
  const album='同名专辑 2026 SACD',values=[track(1,'同目录/01.flac',{title:'普通曲目',artist:'普通艺人',album}),track(2,'同目录/02.flac',{title:'SACD '.repeat(70).trim(),artist:'普通艺人',album}),track(3,'同目录/03.flac',{title:'普通曲目',artist:'SACD '.repeat(70).trim(),album}),track(4,'同目录/04.flac',{title:'SACD '.repeat(63).trim(),artist:'普通艺人',album})],f=fixture(t,{tracks:values})
  const page=f.reader().queryAlbums(query()),pure=groupLocalAlbumSnapshot(f.snapshot())
  assert.deepEqual(byIdentity(page.items),byIdentity(pure.groups.map(value=>value.summary)))
  const versionLabel=(raw:dto.LocalMetadata)=>[...new Set(tokens(raw).filter(token=>token.source==='album'&&(token.kind==='edition'||token.kind==='format')).map(token=>token.raw))].sort().join(' · ')||null
  assert.equal(page.items.length,new Set(values.map(value=>versionLabel(value.rawMetadata))).size)
  assert.equal(page.items.find(value=>value.representativeTrackId===values[0]!.summary.track.id)!.versionLabel,versionLabel(values[0]!.rawMetadata),'沿用原codec完整token标签，不能硬编码简化版本')
  assert.equal(versionLabel(values[1]!.rawMetadata),null);assert.equal(versionLabel(values[2]!.rawMetadata),null)
  assert.equal(page.items.find(value=>value.versionLabel===null)!.trackCount,values.filter(value=>versionLabel(value.rawMetadata)===null).length)
  assert.ok(f.versionReads.some(value=>value.album!==undefined));assert.ok(f.versionReads.filter(value=>value.album!==undefined).every(value=>value.title===undefined&&value.artist===undefined),'album解析应复用，不能每轨用唯一title作整包版本缓存key')
  assert.equal(f.versionReads.filter(value=>value.album===album).length,1,'同album的完整tokens只解析一次，剩余cap仍分别派生')
})

test('MBF SQL V2：2MiB是公开当页包的UTF8预算，合法源行不被64KiB误拒绝且超包整页拒绝',t=>{
  const values=Array.from({length:1600},(_,index)=>track(index+1,`合成组${Math.floor(index/8)}/${index%8+1}.flac`,{title:`曲目${index+1}`,artist:`${index%8}${'艺'.repeat(511)}`,album:`合成专辑${Math.floor(index/8)}`})),f=fixture(t,{tracks:values})
  const small=f.reader().queryAlbums(query({limit:1}));assert.equal(small.total,200);assert.equal(small.items[0]!.artists.length,8)
  assert.ok(Buffer.byteLength(JSON.stringify(small),'utf8')>8*1024);assert.ok(Buffer.byteLength(JSON.stringify(small),'utf8')<65536)
  const wider=f.reader().queryAlbums(query({limit:6}));assert.ok(Buffer.byteLength(JSON.stringify(wider),'utf8')>65536);assert.equal(wider.items.length,6,'原64KiB限制适用于源行，不适用于合法派生页')
  assert.throws(()=>f.reader().queryAlbums(query({limit:200})),error=>{
    assert.ok(error instanceof LocalAlbumReadError);assert.equal(error.code,'CONTENT_LIMIT_EXCEEDED');assert.match(error.message,/未返回截断内容/u);return true
  })
  assert.equal(f.reader().queryAlbums(query({limit:1,offset:199})).items.length,1,'超包失败不改变来源、卡片数或后续读取')
})

test('MBF SQL V2：envelope在JSON.parse前核UTF8字节，损坏超包不会误映射为UNAVAILABLE',t=>{
  const f=fixture(t,{tracks:[track(1,'合成目录/01.flac')]}),prepare=f.db.prepare.bind(f.db),raw='中'.repeat(Math.floor(LOCAL_ALBUM_SQL_ENVELOPE_MAX_BYTES/3)+1)
  assert.ok(raw.length<LOCAL_ALBUM_SQL_ENVELOPE_MAX_BYTES);assert.ok(Buffer.byteLength(raw,'utf8')>LOCAL_ALBUM_SQL_ENVELOPE_MAX_BYTES)
  f.db.prepare=text=>{
    const statement=prepare(text)
    if(text.includes('envelope FROM counts')){
      const get=statement.get.bind(statement)
      statement.get=((...args:Parameters<typeof statement.get>)=>({...get(...args),envelope:raw})) as unknown as typeof statement.get
    }
    return statement
  }
  assert.throws(()=>f.reader().queryAlbums(query()),errorCode('CONTENT_LIMIT_EXCEEDED'))
})

test('MBF SQL V2：紧凑成员hash保留全部十二标签、轨道资产、关系与扫描修订，卡片身份保持',t=>{
  const value=track(1,'原目录/01.flac'),e=edition(1),relation=link(1,e,value),f=fixture(t,{tracks:[value],editions:[e],links:[relation]})
  let previous=f.reader().queryAlbums(query()).items[0]!
  const changed=()=>{const current=f.reader().queryAlbums(query()).items[0]!;assert.equal(current.id,previous.id);assert.notEqual(current.revision,previous.revision);previous=current}
  for(const field of fields){value.rawMetadata[field]=field==='disc'||field==='track'?'2':`原${field}变化`;changed()}
  const effective:dto.LocalMetadata={}
  for(const [index,field] of fields.entries()){
    effective[field]=field==='disc'||field==='track'?'3':`有效${field}变化`
    f.db.prepare('INSERT INTO local_catalog_overrides VALUES(?,?) ON CONFLICT(track_id) DO UPDATE SET data=excluded.data').run(value.summary.track.id,JSON.stringify({trackId:value.summary.track.id,revision:String(index+1),fields:effective}));changed()
  }
  const trackData=JSON.parse(String(f.db.prepare('SELECT data FROM local_catalog_tracks WHERE id=?').get(value.summary.track.id)!.data)) as dto.LocalTrack
  trackData.selectionRevision='2';f.db.prepare('UPDATE local_catalog_tracks SET data=? WHERE id=?').run(JSON.stringify(trackData),trackData.id);changed()
  const assetData=JSON.parse(String(f.db.prepare('SELECT data FROM local_catalog_assets WHERE id=?').get(value.summary.asset.id)!.data)) as dto.AudioAsset
  assetData.fileRevision='2';f.db.prepare('UPDATE local_catalog_assets SET data=? WHERE id=?').run(JSON.stringify(assetData),assetData.id);changed()
  relation.revision='2';f.db.prepare('UPDATE local_catalog_edition_tracks SET data=? WHERE id=?').run(JSON.stringify(relation),relation.id);changed()
  const scanning=accepted(value);scanning.signature+='-changed';f.db.prepare('UPDATE local_scan_file_state SET data=? WHERE library_root_id=? AND relative=?').run(JSON.stringify(scanning),rootId,value.relative);changed()
  const members=f.reader().queryAlbumMembers({albumKey:previous.id,rootId,offset:0,limit:1})
  assert.deepEqual(members.items[0]!.fact.rawMetadata,value.rawMetadata);assert.deepEqual(members.items[0]!.fact.summary.metadata,effective)
  assert.equal(members.items[0]!.fact.summary.track.selectionRevision,'2');assert.equal(members.items[0]!.fact.summary.asset.fileRevision,'2');assert.equal(members.items[0]!.editionLink!.revision,'2')
})

test('MBF SQL：散落组超过32艺人与长版本只汇总卡片，详情仍保留原40份事实', t=>{
  const values=Array.from({length:40},(_,index)=>track(index+1,`${index+1}.flac`,{title:`曲目${index+1}`,artist:`艺人${index+1}`,album:`专辑${index+1} ${index+1}${'x'.repeat(32)}版`}))
  const f=fixture(t,{tracks:values}),album=f.reader().queryAlbums(query()).items[0]!,pure=groupLocalAlbumSnapshot(f.snapshot()).groups[0]!
  assert.deepEqual(comparable(album),comparable(pure.summary));assert.deepEqual(album.artists,['多位艺人']);assert.equal(album.versionLabel,'多个版本')
  const page=f.reader().queryAlbumMembers({albumKey:album.id,rootId,offset:0,limit:200});assert.equal(new Set(page.items.map(value=>value.fact.summary.metadata.artist)).size,40)
  assert.equal(new Set(page.items.map(value=>value.fact.summary.versionTokens.find(token=>token.kind==='edition')!.raw)).size,40)
})

test('MBF SQL：同名不同根/原版本/目录与多发行关系按纯分组身份对照，不读取全库DTO或改表', t=>{
  const a=track(1,'甲/01.flac'),b=track(2,'乙/01.flac'),c=track(3,'甲/01.flac',undefined,{rootId:otherRootId}),d=track(4,'乙/02.flac',{title:'曲目4',artist:'合成艺人',album:'同名专辑 SACD'}),e=track(5,'发行/01.flac'),g=track(6,'发行/01.flac',undefined,{rootId:otherRootId}),loose=track(7,'Track01.flac'),first=edition(1),second=edition(2)
  const f=fixture(t,{tracks:[a,b,c,d,e,g,loose],editions:[first,second],links:[link(1,first,e),link(2,second,e),link(3,first,g)]}), before=f.db.prepare('SELECT total_changes() n').get()!.n
  const page=f.reader().queryAlbums(query()),pure=groupLocalAlbumSnapshot(f.snapshot())
  assert.deepEqual(byIdentity(page.items),byIdentity(pure.groups.map(value=>value.summary)));assert.equal(page.total,8)
  assert.equal(f.trackDecodes,0,'统计/画廊只聚合SQLite原投影，不构造全库LocalTrack');assert.equal(f.assetDecodes,0)
  assert.deepEqual(byIdentity(f.sourceRawReader().queryAlbums(query()).items),byIdentity(page.items),'原sourceRaw和原sourceLookup水位一致')
  assert.equal(f.db.prepare('SELECT total_changes() n').get()!.n,before)
  assert.doesNotMatch(JSON.stringify(page),/甲\/01|乙\/01|relative|asset_data/u)
})

test('MBF SQL：完整七类counts、确认空、根与搜索范围对照；unknown不计缺图', t=>{
  const available=track(1,'有图/01.flac',undefined,{embedded:true}),missing=track(2,'缺图/01.flac'),named=track(3,'AI/Track02.flac'),loose=track(4,'single.flac'),unknown=track(5,'未知/01.flac')
  const f=fixture(t,{tracks:[available,missing,named,loose,unknown],files:[rejected('读失败/01.bin','PARSE_FAILED'),rejected('普通拒收/01.bin')],cues:[cue(1,'CUE/album.cue')],names:[{rootId,directory:'AI',revision:'name-1',state:'failed'},{rootId,directory:'普通拒收',revision:'name-2',state:'cancelled'}]})
  const before=f.reader().queryAlbums(query()),target=before.items.find(value=>value.representativeTrackId===missing.summary.track.id)!,observation:LocalAlbumSqlArtworkObservation={albumKey:target.id,rootId,sourceRevision:'source-1',state:'missing',revision:'observed-1'}
  const result=f.reader({artworkObservations:[observation]}).queryAlbums(query({filter:'missing-artwork'})),snapshot=f.snapshot();snapshot.tracks=snapshot.tracks.map(value=>value===missing?{...value,artworkState:'missing'}:value)
  const pure=groupLocalAlbumSnapshot(snapshot),counts=Object.fromEntries(['all',...dto.LOCAL_ALBUM_STATUSES].map(status=>[status,status==='all'?pure.groups.length:pure.groups.filter(group=>group.summary.statuses.includes(status as dto.LocalAlbumStatus)).length]))
  assert.deepEqual(result.counts,counts);assert.equal(result.total,1);assert.equal(result.items[0]!.artworkState,'missing');assert.equal(result.items[0]!.id,target.id);assert.equal(result.items[0]!.revision,target.revision,'只读缺图观测不改变来源身份')
  assert.equal(before.counts['missing-artwork'],0);assert.equal(result.counts['parse-failed'],1);assert.equal(result.counts['metadata-issue'],1);assert.equal(result.counts['cue-unsplit'],1)
  assert.equal(f.reader().queryAlbums(query({rootId:otherRootId})).total,0)
  const empty=f.reader().queryAlbums(query({query:'没有这个合成专辑'}));assert.equal(empty.total,0);assert.equal(empty.hasMore,false);assert.deepEqual(empty.items,[])
  assert.equal(f.reader().queryAlbums(query({query:'有图/01.flac'})).total,0)
})

test('MBF SQL：非首成员页≤200只解码当页，混合CUE关系一次查询并保留真实分段和曲序', t=>{
  const values=Array.from({length:205},(_,index)=>track(index+1,`混合/${index+1}.flac`,{title:`曲目${index+1}`,artist:'合成艺人',album:'混合专辑',track:String(index+1)},index===203?{segmented:true}:{})),a=values[201]!,b=values[203]!
  const f=fixture(t,{tracks:values,cues:[cue(1,'混合/album.cue',[a,a,b])]}),album=f.reader().queryAlbums(query()).items[0]!,before=f.sqlReads,decodes=f.trackDecodes
  const page=f.reader().queryAlbumMembers({albumKey:album.id,rootId,offset:200,limit:200}),pure=groupLocalAlbumSnapshot(f.snapshot()).groups[0]!
  assert.equal(page.items.length,5);assert.equal(page.total,205);assert.equal(page.hasMore,false);assert.equal(f.trackDecodes-decodes,5)
  assert.equal(f.sqlReads-before,1,'冷页的原组与当页CUE共享一次SQL，不能按200个成员重跑全库CTE')
  assert.deepEqual(page.items.map(value=>value.fact.summary.track.id),pure.members.slice(200).map(value=>value.fact.summary.track.id))
  assert.deepEqual(page.items.map(value=>value.statuses),pure.members.slice(200).map(value=>value.statuses));assert.ok(page.items[1]!.statuses.includes('cue-unsplit'));assert.ok(!page.items[3]!.statuses.includes('cue-unsplit'))
  assert.deepEqual(page.items[3]!.fact.summary.track.segment,b.summary.track.segment)
  for (const offset of [205, 206]) {
    const beforeEmpty = f.sqlReads, beforeDecodes = f.trackDecodes
    const empty = f.reader().queryAlbumMembers({ albumKey: album.id, rootId, offset, limit: 200 })
    assert.equal(f.sqlReads - beforeEmpty, 1); assert.equal(f.trackDecodes, beforeDecodes)
    assert.equal(empty.total, 205); assert.equal(empty.hasMore, false); assert.deepEqual(empty.items, [])
  }
})

test('MBF SQL：零轨CUE/拒收归属与全部rejected分页保持，普通拒收不伪装AI失败', t=>{
  const a=track(1,'混合/01.flac',{title:'甲',artist:'艺人',album:'原甲'}),b=track(2,'混合/02.flac',{title:'乙',artist:'艺人',album:'原乙'}),f=fixture(t,{tracks:[a,b],files:[rejected('混合/a.bin'),rejected('混合/b.bin','PARSE_FAILED')],cues:[cue(1,'CUE-only/album.cue')]})
  const albums=f.reader().queryAlbums(query()).items,pure=groupLocalAlbumSnapshot(f.snapshot())
  assert.deepEqual(byIdentity(albums),byIdentity(pure.groups.map(value=>value.summary)))
  const independent=albums.find(value=>value.trackCount===0&&value.title==='混合')!,request={albumKey:independent.id,rootId,offset:0,limit:1},first=f.reader().queryAlbumIssues(request),second=f.reader().queryAlbumIssues({...request,offset:1})
  assert.equal(first.rejectedTotal,2);assert.deepEqual([...first.rejectedFiles,...second.rejectedFiles].map(value=>value.relative),['混合/a.bin','混合/b.bin'])
  for(const album of albums.filter(value=>value.trackCount>0))assert.equal(f.reader().queryAlbumIssues({...request,albumKey:album.id}).rejectedTotal,0)
  assert.equal(independent.statuses.includes('parse-failed'),false);assert.equal(independent.statuses.includes('metadata-issue'),true)
  const zero=albums.find(value=>value.title==='CUE-only')!,context=f.reader().getArtworkContext(artworkRequest(zero));assert.equal(context.directory,'CUE-only');assert.equal(context.representative,null)
  assert.equal(f.reader().queryAlbumMembers({...request,albumKey:zero.id}).items.length,0);assert.equal(zero.representativeTrackId,null)
})

test('MBF SQL：组修订绑定真实元数据/关系与CUE，旧身份和闭集范围拒绝且不泄露内部原因', t=>{
  const a=track(1,'目录/01.flac'),e=edition(1),f=fixture(t,{tracks:[a],editions:[e],links:[link(1,e,a)]}),first=f.reader().queryAlbums(query()).items[0]!
  f.db.prepare('INSERT INTO local_catalog_overrides VALUES(?,?)').run(a.summary.track.id,JSON.stringify({trackId:a.summary.track.id,revision:'1',fields:{album:'MB更正标题'}}))
  const second=f.reader().queryAlbums(query()).items[0]!;assert.equal(first.id,second.id);assert.notEqual(first.revision,second.revision)
  const member=f.reader().queryAlbumMembers({albumKey:first.id,rootId,offset:0,limit:1}).items[0]!;assert.equal(member.fact.rawMetadata.album,'同名专辑');assert.equal(member.fact.summary.metadata.album,'MB更正标题')
  assert.throws(()=>f.reader().getArtworkContext(artworkRequest(first)),errorCode('SNAPSHOT_CHANGED'));assert.throws(()=>f.reader().queryAlbums(query({limit:201})),errorCode('INVALID_REQUEST'))
  assert.throws(()=>f.reader().queryAlbumMembers({albumKey:first.id,rootId:otherRootId,offset:0,limit:1}),errorCode('SNAPSHOT_CHANGED'))
  let getters=0;const malicious=Object.defineProperty({revision:'source-1',roots:f.roots},'nameEnhancements',{enumerable:true,get(){getters++;return[]}})
  assert.throws(()=>createLocalAlbumSqlReader(f.db,{projectionSql:'不应执行'},{} as LocalAlbumSqlCodec,malicious as LocalAlbumSqlScope),errorCode('UNAVAILABLE'));assert.equal(getters,0)
  const wrong:LocalAlbumSqlArtworkObservation={albumKey:second.id,rootId,sourceRevision:'stale',state:'missing',revision:'art-1'};assert.throws(()=>f.reader({artworkObservations:[wrong]}),errorCode('UNAVAILABLE'))
})

test('MBF SQL Owner：实际按需缺图下一query进入筛选；同次回复不自失效，离线/源修订清除证据', async t=>{
  const f=fixture(t,{tracks:[track(1,'目录/01.flac')]}),service=f.owner(),first=(await service.queryAlbums(query())).items[0]!,request=artworkRequest(first)
  const reply=await service.getArtwork(request);assert.equal(reply.image,null);assert.equal(reply.status,'ready');assert.equal(reply.revision,first.revision)
  await service.getArtwork(request)
  const missing=await service.queryAlbums(query({filter:'missing-artwork'}));assert.equal(missing.total,1);assert.equal(missing.items[0]!.artworkState,'missing');assert.equal(missing.items[0]!.revision,first.revision, '只读缺图观测不改变来源身份')
  assert.equal((await service.getArtwork(request)).status,'ready')
  f.roots[0]!.availability='SOURCE_ROOT_OFFLINE';const offline=await service.queryAlbums(query());assert.equal(offline.counts['missing-artwork'],0);assert.equal(offline.items[0]!.artworkState,'source-unavailable')
  f.roots[0]!.availability='ONLINE';assert.equal((await service.queryAlbums(query())).items[0]!.artworkState,'unknown')
  const current=(await service.queryAlbums(query())).items[0]!;await service.getArtwork(artworkRequest(current));f.advanceRevision();assert.equal((await service.queryAlbums(query())).counts['missing-artwork'],0)
})

test('MBF SQL Owner：按需图可更新has筛选，来源不可用不会缓存missing；await之后invalidate/close丢弃', async t=>{
  const f=fixture(t,{tracks:[track(1,'目录/01.flac')]}),available=f.owner(async()=>({image:image(),status:'ready'})),first=(await available.queryAlbums(query())).items[0]!
  assert.equal((await available.getArtwork(artworkRequest(first))).image!.display.mime,'image/jpeg');assert.equal((await available.queryAlbums(query({filter:'has-artwork'}))).total,1)
  const offline=f.owner(async()=>({image:null,status:'source-unavailable'})),unknown=(await offline.queryAlbums(query())).items[0]!;assert.equal((await offline.getArtwork(artworkRequest(unknown))).status,'source-unavailable');assert.equal((await offline.queryAlbums(query())).counts['missing-artwork'],0)
  for(const close of [false,true]){
    let resolve!:(value:LocalAlbumArtworkReadResult)=>void;const waiting=new Promise<LocalAlbumArtworkReadResult>(accept=>{resolve=accept}),late=f.owner(async()=>waiting),album=(await late.queryAlbums(query())).items[0]!,task=late.getArtwork(artworkRequest(album))
    await new Promise<void>(accept=>setImmediate(accept));if(close)late.close();else late.invalidate();resolve({image:null,status:'ready'});await assert.rejects(task,errorCode('SNAPSHOT_CHANGED'))
  }
})

test('MBF SQL Owner：inspect捕获完整205成员和拒收事实冻结，预算超限整组拒绝；详情仅实读当页ID', async t=>{
  const values=Array.from({length:205},(_,index)=>track(index+1,`目录/${index+1}.flac`,{title:`曲目${index+1}`,artist:'合成艺人',album:'同名专辑',track:String(index+1)})),f=fixture(t,{tracks:values,files:[rejected('目录/read-failed.bin','PARSE_FAILED'),rejected('目录/unsupported.bin')]}),service=f.owner(),album=(await service.queryAlbums(query())).items[0]!
  const inspected=await service.inspectAlbum({albumKey:album.id,rootId,revision:album.revision});assert.equal(inspected.members.length,205);assert.equal(inspected.rejectedFiles!.length,2);assert.equal(Object.isFrozen(inspected.members[0]!.fact.summary.asset),true);assert.equal(f.detailReads.length,0)
  assert.equal(inspected.issues.filter(value=>value.kind==='metadata-read-failed').length,1)
  const page=await service.queryAlbumTracks({albumKey:album.id,rootId,offset:200,limit:200});assert.deepEqual(f.detailReads,values.slice(200).map(value=>value.summary.track.id));assert.equal(page.items.length,5)
  await assert.rejects(service.inspectAlbum({albumKey:album.id,rootId,revision:'stale'}),errorCode('SNAPSHOT_CHANGED'))
  const memberBound=f.owner(undefined,{maxMembers:206,maxBytes:32*1024*1024}),bytesBound=f.owner(undefined,{maxMembers:10000,maxBytes:100})
  assert.equal((await memberBound.queryAlbums(query())).total,1,'计划预算不限制普通browse')
  await assert.rejects(memberBound.inspectAlbum({albumKey:album.id,rootId}),errorCode('CONTENT_LIMIT_EXCEEDED'));await assert.rejects(bytesBound.inspectAlbum({albumKey:album.id,rootId}),errorCode('CONTENT_LIMIT_EXCEEDED'))
})

test('MBF SQL：原guard内只封送实际闭集code，未知与原预算异常保持原guard处理', t=>{
  const f=fixture(t),originalMapped=new Error('原guard的安全未知错误'),seen:unknown[]=[]
  const guarded=<V>(action:(db:DatabaseSync)=>V):V=>{try{return action(f.db)}catch(error){seen.push(error);throw originalMapped}}
  for(const code of ['INVALID_REQUEST','SNAPSHOT_CHANGED','CONTENT_LIMIT_EXCEEDED','UNAVAILABLE'] as const){
    assert.throws(()=>readWithLocalAlbumSqlErrors(guarded,()=>{throw new LocalAlbumReadError(code,'不应外送的合成内部原因')}),error=>{
      assert.ok(error instanceof LocalAlbumReadError);assert.equal(error.code,code);assert.doesNotMatch(error.message,/内部原因/u);return true
    })
  }
  assert.equal(seen.length,0)
  for(const original of [new Error('合成未知内部原因'),Object.assign(new Error('合成原作者预算拒绝'),{domain:'local_catalog_tracks',actual:300001,limit:300000})]){
    assert.throws(()=>readWithLocalAlbumSqlErrors(guarded,()=>{throw original}),error=>error===originalMapped);assert.equal(seen.at(-1),original)
  }
})

test('MBF SQL 原guard接入：真实Repository在缺图观察后保留稳定来源封面请求，原未知错误仍安全拒绝',async t=>{
  const temporary=process.env.TMPDIR
  if(!temporary?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'))throw new Error('本测试须使用外置任务临时目录。')
  const directory=await mkdtemp(path.join(temporary,'mbf-album-sql-guard-')),sourceDir=path.join(directory,'自有合成来源')
  await mkdir(sourceDir)
  let unknownFailure=false,artworkCalls=0
  const repository=createCollectionRepository({filePath:path.join(directory,'work.sqlite'),beforeCommit(){if(unknownFailure)throw new Error('合成内部 file: 原因不应公开')}})
  let service:ReturnType<typeof createLocalAlbumOwnerService>|undefined
  t.after(async()=>{service?.close();repository.close();await rm(directory,{recursive:true,force:true})})
  const source=repository.sources.authorize(id(910001),await authorizeSourceDirectory(sourceDir)),root=repository.localCatalog.registerRoot({commandId:id(910002),sourceRootId:source.id,role:'library'})
  const asset=repository.localCatalog.registerAsset({commandId:id(910003),libraryRootId:root.id,expectedRootRevision:root.revision,relative:'合成目录/01.flac',sha256:null,sampleFrames:null,timebaseHz:null})
  const track=repository.localCatalog.createTrack({commandId:id(910004),assetId:asset.id,segment:null})
  repository.localCatalog.observeMetadata({commandId:id(910005),trackId:track.id,source:'synthetic',parserVersion:'mbf-guard-synthetic-v1',fields:{title:'合成曲目',artist:'合成艺人',album:'合成专辑'}})
  // NULL仅是受控读图替身；这里验证真实原guard适配，不冒充源目录读图或播放证据。
  service=createLocalAlbumOwnerService({repository,assertCurrent(){},readRootViews:async()=>[{root:repository.localCatalog.root(root.id),label:'自有合成来源',availability:await sourceRootAvailability(repository.sources.root(source.id))}],readArtwork:async()=>{artworkCalls++;return{image:null,status:'ready'}}})
  const before=(await service.queryAlbums(query())).items[0]!,old=artworkRequest(before)
  await service.getArtwork(old);assert.equal(artworkCalls,1)
  const missing=await service.queryAlbums(query({filter:'missing-artwork'}));assert.equal(missing.total,1);assert.equal(missing.items[0]!.revision,before.revision)
  assert.equal((await service.getArtwork(old)).status,'ready');assert.equal(artworkCalls,1,'已有缺图观测无需重复读取源')
  await assert.rejects(service.getArtwork({...old,revision:'synthetic-stale-source'}),errorCode('SNAPSHOT_CHANGED'));assert.equal(artworkCalls,1)
  await assert.rejects(service.getArtwork({...artworkRequest(missing.items[0]!),rootId:id(910006)}),errorCode('SNAPSHOT_CHANGED'));assert.equal(artworkCalls,1)
  unknownFailure=true
  try{assert.throws(()=>repository.localCatalog.createEdition({commandId:id(910007),title:'应回滚的合成发行',edition:''}),error=>{assert.ok(error instanceof CollectionError);assert.equal(error.code,'INVENTORY_UNAVAILABLE');assert.doesNotMatch(error.message,/file:|合成内部/u);return true})}
  finally{unknownFailure=false}
  assert.equal(repository.localCatalog.receipt(id(910007)),null)
})


/** CD31只创建自己的SQLite和合成WAV；真实同SQL作者不等于完整Main工厂、Parser、Native或真实模型。 */
async function cd31NameOwner(t: test.TestContext) {
  const temporary = process.env.TMPDIR
  assert.ok(temporary && path.isAbsolute(temporary), '名称作者候选必须使用明确任务临时根。')
  if (process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted') {
    const runner = process.env.RUNNER_TEMP
    assert.ok(runner && temporary.startsWith(runner + path.sep), 'CI名称夹具只允许当前runner临时根。')
  } else assert.ok(temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'), '本机名称夹具必须使用外置任务临时根。')
  const directory = await mkdtemp(path.join(temporary, 'mbf-cd31-name-')), sourceDirectory = path.join(directory, '自有来源')
  await mkdir(sourceDirectory); await mkdir(path.join(sourceDirectory, '原目录'))
  const wave = createCueSyntheticWave().wave, sourceFile = path.join(sourceDirectory, '原目录', '01.wav')
  await writeFile(sourceFile, wave, { flag: 'wx', mode: 0o600 })
  const file = path.join(directory, 'catalog.sqlite'), identityFile = path.join(directory, 'identity.sqlite')
  let repository = createCollectionRepository({ filePath: file }), identities = createBackupWorkflowStore({ filePath: identityFile })
  repository.localCatalog.roots()
  let identity = identities.datasetIdentities.bind('default', file, false)
  repository.localCatalog.privateBindWorkbenchDataset(identity)
  const datasetId = identity.datasetId, source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(sourceDirectory))
  const library = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' })
  const asset = repository.localCatalog.registerAsset({ commandId: randomUUID(), libraryRootId: library.id, expectedRootRevision: library.revision,
    relative: '原目录/01.wav', sha256: createHash('sha256').update(wave).digest('hex'), sampleFrames: null, timebaseHz: null })
  const track = repository.localCatalog.createTrack({ commandId: randomUUID(), assetId: asset.id, segment: null })
  repository.localCatalog.observeMetadata({ commandId: randomUUID(), trackId: track.id, source: 'synthetic', parserVersion: 'cd31-owned-facts-v1',
    fields: { title: '原曲目', artist: '合成歌手 [FLAC]', album: '夜航 [Remastered] [FLAC]', year: '1989', disc: '1', track: '1' } })
  async function compose() {
    const boundIdentity = identity
    const roots = async (): Promise<readonly dto.LocalRootView[]> => [{ root: repository.localCatalog.root(library.id), label: 'CD31自有合成来源',
      availability: await sourceRootAvailability(repository.sources.root(source.id)) }]
    const albums = createLocalAlbumOwnerService({ repository, assertCurrent: () => boundIdentity.assertCurrent(), readRootViews: roots,
      readArtwork: async () => { assert.fail('名称行为不应启动封面读取。') } })
    let author: LocalWorkbenchMBOnlyWriter
    const read = createLocalWorkbenchReadService({ datasetId, repository, localAlbums: albums, assertCurrent: () => boundIdentity.assertCurrent(), readRootViews: roots,
      readNameSources: fact => author.readNameSources(fact), readOverrideAuthor: fact => author.readOverrideAuthor(fact), readAuthorRevision: () => author.readAuthorRevision() })
    author = createLocalWorkbenchMBOnlyWriter({ identity: boundIdentity, catalog: repository.localCatalog, read, assertAccepting: () => boundIdentity.assertCurrent() })
    const registry = await createLocalWorkbenchPlanRegistry({ datasetId, persistence: createLocalWorkbenchOwnerPersistence(datasetId, repository.localCatalog), writer: author.writer })
    return { albums, read, author, registry }
  }
  let actors = await compose(), open = true
  async function close() {
    if (!open) return
    await actors.author.close(); actors.read.close(); actors.albums.close(); repository.close(); identities.close(); open = false
  }
  t.after(async () => { await close(); assert.deepEqual(await readFile(sourceFile), wave); await rm(directory, { recursive: true, force: false }) })
  async function visible() {
    const page = await actors.albums.queryAlbums(query({ rootId: library.id })), album = page.items[0]!
    assert.equal(page.total, 1); assert.equal(album.representativeTrackId, track.id)
    const members = await actors.albums.queryAlbumTracks({ albumKey: album.id, rootId: album.rootId, offset: 0, limit: 100 })
    assert.equal(members.total, 1)
    return { albumId: album.id, displayTitle: album.title, displayArtists: album.artists, metadata: repository.localCatalog.metadata(track.id),
      sourceVersions: members.items[0]!.facts.versionTokens, observations: repository.localCatalog.observations(track.id), asset: repository.localCatalog.asset(asset.id) }
  }
  async function preview() {
    const page = await actors.albums.queryAlbums(query({ rootId: library.id })), album = page.items[0]!
    const publicRead = await actors.read.readAlbumTargets({ albums: [{ albumId: album.id, rootId: album.rootId, revision: album.revision }] })
    const reference = publicRead.albums[0]!.capture
    const prepared = await actors.read.prepareNameSuggestion({ datasetId, capture: reference, backend: 'ollama' })
    const result = await actors.read.completeNameSuggestion(prepared.preparationId, { backend: 'ollama', content: JSON.stringify({ artistName: '合成歌手', albumName: '夜航', reason: '技术展示清洗，Remastered与原年份仍留在来源事实。' }) })
    if (result.status !== 'ready') assert.fail('真实原捕获未返回名称候选。')
    const request: dto.LocalWorkbenchAiPreviewRequest = { datasetId, captures: [reference], selections: [{ albumId: album.id, candidateId: result.candidate.candidateId }] }
    const frozen = await actors.read.prepareNamePreview(request), plan = await actors.registry.issuePlan(frozen.draft, frozen.capture)
    assert.equal(plan.scope, 'MB_ONLY'); assert.equal(plan.kind, 'ai'); assert.equal(plan.state, 'ready')
    return { request, reference, result, frozen, plan }
  }
  function ledger() {
    assert.ok(repository.privateMobileCatalogAccess)
    return repository.privateMobileCatalogAccess(db => db.prepare('SELECT rowid AS sequence,command_id,fingerprint,operation,request,result,created_at FROM local_catalog_ledger ORDER BY rowid').all())
  }
  return { datasetId, library, track, sourceFile, wave, visible, preview, ledger, get actors() { return actors },
    async cold() { await close(); repository = createCollectionRepository({ filePath: file }); repository.localCatalog.roots(); identities = createBackupWorkflowStore({ filePath: identityFile });
      identity = identities.datasetIdentities.bind('default', file, false); assert.equal(identity.datasetId, datasetId); repository.localCatalog.privateBindWorkbenchDataset(identity); actors = await compose(); open = true } }
}

test('CD31真实SQL名称建议及冷计划历史零展示更改，明确原capture的AI apply仅改MB effective且保raw版本和旧hash', async t => {
  const f = await cd31NameOwner(t), before = await f.visible(), originalLedger = f.ledger(), originalLedgerHash = hash(originalLedger)
  assert.equal(before.displayTitle, '夜航 [Remastered] [FLAC]'); assert.equal(before.metadata.override, null)
  assert.ok(before.sourceVersions.some(token => token.kind === 'edition' && token.raw === 'Remastered'))
  const first = await f.preview(), historicalPlan = structuredClone(first.plan), historicalCapture = structuredClone(first.frozen.capture)
  assert.deepEqual(await f.visible(), before)
  assert.deepEqual(f.ledger().slice(0, originalLedger.length), originalLedger); assert.equal(hash(f.ledger().slice(0, originalLedger.length)), originalLedgerHash)
  const saved = f.actors.registry.inspect().entries.find(entry => entry.plan.planId === first.plan.planId)!
  assert.equal(saved.original, null); assert.equal(saved.receipt, null); assert.deepEqual(saved.capture, historicalCapture)
  await f.cold()
  assert.deepEqual(await f.visible(), before); assert.deepEqual(f.actors.registry.getPlan(first.plan.planId), historicalPlan)
  assert.deepEqual(f.actors.registry.inspect().entries.find(entry => entry.plan.planId === first.plan.planId)!.capture, historicalCapture)
  const next = await f.preview()
  assert.deepEqual(await f.visible(), before)
  // 只有原Owner内部AI预览route可产生品牌；测试不以JSON或假caller自签来源。
  f.actors.author.originRoutes.registerAiPreviewPlan(next.plan.planId)
  const apply: dto.LocalWorkbenchApplyRequest = { commandId: randomUUID(), datasetId: f.datasetId, planId: next.plan.planId, expectedRevision: next.plan.revision,
    planHash: next.plan.planHash, contextFingerprint: next.plan.contextFingerprint, kind: 'ai' }
  assert.equal((await f.actors.registry.apply(apply)).state, 'succeeded')
  const after = await f.visible()
  assert.equal(after.albumId, before.albumId); assert.equal(after.displayTitle, '夜航'); assert.deepEqual(after.displayArtists, ['合成歌手'])
  assert.deepEqual(after.metadata.raw, before.metadata.raw); assert.deepEqual(after.metadata.effective, { ...before.metadata.raw, artist: '合成歌手', album: '夜航' })
  assert.deepEqual(after.sourceVersions, before.sourceVersions); assert.deepEqual(after.observations, before.observations); assert.deepEqual(after.asset, before.asset)
  assert.deepEqual(f.actors.registry.getPlan(first.plan.planId), historicalPlan)
  assert.deepEqual(f.actors.registry.inspect().entries.find(entry => entry.plan.planId === first.plan.planId)!.capture, historicalCapture)
  assert.equal(hash(f.ledger().slice(0, originalLedger.length)), originalLedgerHash); assert.deepEqual(await readFile(f.sourceFile), f.wave)
  const receipt = await f.actors.registry.readOriginalReceipt(apply); assert.equal(receipt?.state, 'succeeded')
  const afterLedger = f.ledger(); assert.deepEqual(await f.actors.registry.apply(apply), receipt); assert.deepEqual(f.ledger(), afterLedger)
  t.diagnostic('本例使用实际同SQL作者、原capture、Registry及MB_ONLY内部AI品牌；未执行Main、模型、Parser、Native或源写。')
})

test('CD31真实SQL错capture或改原hash零派写，未注册AI品牌的合法计划也不能保存名称', async t => {
  const f = await cd31NameOwner(t), before = await f.visible(), prepared = await f.preview(), frozenPlan = structuredClone(prepared.plan), ledger = f.ledger()
  await assert.rejects(f.actors.read.prepareNamePreview({ ...prepared.request, captures: [{ ...prepared.reference, readToken: randomUUID() }] }))
  const original: dto.LocalWorkbenchApplyRequest = { commandId: randomUUID(), datasetId: f.datasetId, planId: prepared.plan.planId, expectedRevision: prepared.plan.revision,
    planHash: prepared.plan.planHash, contextFingerprint: prepared.plan.contextFingerprint, kind: 'ai' }
  await assert.rejects(f.actors.registry.apply({ ...original, planHash: '0'.repeat(64) }))
  await assert.rejects(f.actors.registry.apply({ ...original, contextFingerprint: '0'.repeat(64) }))
  assert.deepEqual(await f.visible(), before); assert.deepEqual(f.ledger(), ledger); assert.deepEqual(f.actors.registry.getPlan(prepared.plan.planId), frozenPlan)
  // 显式apply仍需真实AI origin；缺该内部品牌只能记not-written，不能借合法body变作者。
  const rejected = await f.actors.registry.apply(original)
  assert.equal(rejected.state, 'failed'); assert.ok(rejected.items.every(item => item.state === 'not-written'))
  assert.deepEqual(await f.visible(), before); assert.deepEqual(f.actors.registry.getPlan(prepared.plan.planId), frozenPlan)
  assert.deepEqual(await readFile(f.sourceFile), f.wave)
  t.diagnostic('错原captured lease/hash与缺真实内部AI route分别验证；不把字符串合法或函数存在当保存授权。')
})

test('613 SQL封面源成员：同组后续有图成员用于原物理来源，公开代表与完整成员不变', t => {
  const first = track(1, '甲/01.flac', { title: '甲一', artist: '甲艺人', album: '甲专辑', track: '1' })
  const covered = track(2, '甲/02.flac', { title: '甲二', artist: '甲艺人', album: '甲专辑', track: '2' }, { embedded: true })
  const otherAlbum = track(3, '乙/01.flac', { title: '乙一', artist: '乙艺人', album: '乙专辑', track: '1' }, { embedded: true })
  const otherLibrary = track(4, '甲/00.flac', { title: '别库', artist: '甲艺人', album: '甲专辑', track: '1' }, { rootId: otherRootId, embedded: true })
  const f = fixture(t, { tracks: [otherLibrary, otherAlbum, first, covered], cues: [cue(1, '甲/album.cue', [first, first, covered])] })
  for (const makeReader of [() => f.reader(), () => f.sourceRawReader()]) {
    const reader = makeReader()
    const albums = reader.queryAlbums(query()), album = albums.items.find(item => item.rootId === rootId && item.title === '甲专辑')!
    assert.ok(album); assert.equal(album.trackCount, 2); assert.equal(album.artworkAvailable, true)
    assert.equal(album.representativeTrackId, first.summary.track.id)
    const beforeDecodes = f.trackDecodes, context = reader.getArtworkContext(artworkRequest(album))
    assert.equal(f.trackDecodes - beforeDecodes, 1, '选定来源仍通过当前SQLite实际track行解码')
    assert.deepEqual(context.album, album); assert.equal(context.directory, '甲')
    assert.equal(context.representative!.summary.track.id, covered.summary.track.id)
    assert.equal(context.representative!.summary.asset.id, covered.summary.asset.id)
    assert.equal(context.representative!.summary.asset.libraryRootId, rootId)
    assert.equal(context.representative!.relative, covered.relative); assert.equal(context.representative!.hasArtwork, true)
    const page = reader.queryAlbumMembers({ albumKey: album.id, rootId, offset: 0, limit: 200 })
    assert.equal(page.total, 2); assert.equal(page.hasMore, false); assert.deepEqual(page.album, album)
    assert.deepEqual(page.items.map(item => item.fact.summary.track.id), [first.summary.track.id, covered.summary.track.id])
    assert.deepEqual(page.items.map(item => item.fact.summary.asset.id), [first.summary.asset.id, covered.summary.asset.id])
    assert.equal(page.items[0]!.fact.hasArtwork, false); assert.equal(page.items[1]!.fact.hasArtwork, true)
    assert.deepEqual(page.items.map(item => item.statuses.includes('cue-unsplit')), [true, true])
    assert.deepEqual(reader.queryAlbums(query()), albums, '图源选择不能改公开tuple、修订、分页或counts')
    context.representative!.relative = '不能污染原来源.flac'; context.representative!.summary.track.selectionRevision = '2'
    context.album.title = '不能污染原专辑'
    const repeated = reader.getArtworkContext(artworkRequest(album))
    assert.deepEqual(repeated.album, album); assert.equal(repeated.representative!.relative, covered.relative)
    assert.equal(repeated.representative!.summary.track.selectionRevision, covered.summary.track.selectionRevision)
    assert.throws(() => reader.getArtworkContext({ ...artworkRequest(album), rootId: otherRootId }), errorCode('SNAPSHOT_CHANGED'))
    assert.throws(() => reader.getArtworkContext({ ...artworkRequest(album), representativeTrackId: covered.summary.track.id }), errorCode('SNAPSHOT_CHANGED'))
  }
  t.diagnostic('真实自有SQLite与SourceSynthetic：只证明内部原图源成员选择，不执行FD、Native、图像解码、Main或普通App。')
})

test('613 SQL封面源成员：MB保存优先且无匹配证据不伪图，零轨CUE保持原目录读取', t => {
  const first = track(10, '发行/01.flac'), covered = track(11, '发行/02.flac', undefined, { embedded: true }), e = edition(10)
  const f = fixture(t, { tracks: [first, covered], editions: [e], links: [link(10, e, first, 1), link(11, e, covered, 2)] })
  const before = f.reader().queryAlbums(query()).items[0]!
  assert.equal(f.reader().getArtworkContext(artworkRequest(before)).representative!.summary.track.id, covered.summary.track.id)
  const saved: dto.LocalArtworkSelection = { id: id(70001), editionId: e.id, revision: '1', mode: 'manual', candidate: {
    ...image(), id: id(70002), editionId: e.id, origin: 'manual', sourceIdentity: hash(['合成MB副本', e.id]), sourceLabel: '合成已保存副本',
    provider: 'local-readonly-v1', license: 'user-supplied', expiresAt: '2050-01-01T00:00:00.000Z',
  } }
  assert.ok(dto.isLocalArtworkSelection(saved))
  f.db.prepare('INSERT INTO local_artwork_selections VALUES(?,?)').run(e.id, JSON.stringify(saved))
  assert.throws(() => f.reader().getArtworkContext(artworkRequest(before)), errorCode('SNAPSHOT_CHANGED'))
  const current = f.reader().queryAlbums(query()).items[0]!, selected = f.reader().getArtworkContext(artworkRequest(current))
  assert.equal(current.id, before.id); assert.equal(current.representativeTrackId, first.summary.track.id)
  assert.notEqual(current.revision, before.revision); assert.equal(selected.representative!.summary.track.id, first.summary.track.id)
  assert.equal(selected.representative!.hasArtwork, true, '同发行原MB选择使原首成员保持，不能为了后续内嵌图抢走优先级')
  f.db.prepare('UPDATE local_artwork_selections SET data=? WHERE edition_id=?').run(JSON.stringify({ ...saved, revision: '2', candidate: null }), e.id)
  assert.throws(() => f.reader().getArtworkContext(artworkRequest(current)), errorCode('SNAPSHOT_CHANGED'))
  const removed = f.reader().queryAlbums(query()).items[0]!
  assert.equal(f.reader().getArtworkContext(artworkRequest(removed)).representative!.summary.track.id, covered.summary.track.id)

  const unknownFirst = track(20, '无证据/01.flac'), unknownNext = track(21, '无证据/02.flac')
  const unrelated = track(22, '无证据/00.flac', undefined, { rootId: otherRootId, embedded: true })
  const mismatched = { ...accepted(track(21, unknownNext.relative, undefined, { embedded: true })), assetId: unrelated.summary.asset.id, trackId: unrelated.summary.track.id }
  const unknown = fixture(t, { tracks: [unknownFirst, unknownNext, unrelated], files: [mismatched], cues: [cue(20, 'CUE-only/album.cue')] })
  const albums = unknown.reader().queryAlbums(query()), album = albums.items.find(item => item.representativeTrackId === unknownFirst.summary.track.id)!
  assert.equal(album.artworkAvailable, false)
  const context = unknown.reader().getArtworkContext(artworkRequest(album))
  assert.equal(context.representative!.summary.track.id, unknownFirst.summary.track.id); assert.equal(context.representative!.hasArtwork, false)
  const observedReader = unknown.reader({ artworkObservations: [{ albumKey: album.id, rootId, sourceRevision: 'source-1', state: 'available', revision: 'observed-1' }] })
  const observed = observedReader.queryAlbums(query()).items.find(item => item.id === album.id)!
  assert.equal(observed.artworkAvailable, true)
  const withoutSource = observedReader.getArtworkContext(artworkRequest(observed))
  assert.equal(withoutSource.representative!.summary.track.id, unknownFirst.summary.track.id)
  assert.equal(withoutSource.representative!.hasArtwork, false, '组展示available不提供不存在的成员图源事实')
  const zero = albums.items.find(item => item.title === 'CUE-only')!, zeroContext = unknown.reader().getArtworkContext(artworkRequest(zero))
  assert.equal(zero.trackCount, 0); assert.equal(zero.representativeTrackId, null)
  assert.equal(zeroContext.directory, 'CUE-only'); assert.equal(zeroContext.representative, null)
})

test('613 SQL封面源成员：全成员派生超预算后独立紧凑卡片仍选择当前有图成员并保全部尾成员', t => {
  // 沿原426缓存超界夹具；不提高缓存/读取上限，不注入假的iterator、成员或SQL结果。
  const deep = Array.from({ length: 19 }, () => 'a'.repeat(200)).join('/')
  const values = Array.from({ length: 2000 }, (_, n) => track(n + 1, `${deep}/大组${Math.floor(n / 10)}/${n % 10 + 1}.flac`,
    { title: `曲目${n + 1}`, artist: '合成艺人', album: `专辑${Math.floor(n / 10)}`, track: String(n % 10 + 1) }, { embedded: n % 10 === 9 }))
  const f = fixture(t, { tracks: values }), albums = f.reader().queryAlbums(query({ limit: 1, offset: 199 }))
  assert.equal(albums.total, 200); assert.equal(albums.counts.all, 200)
  const album = albums.items[0]!
  f.reader().queryAlbumIssues({ albumKey: album.id, rootId, offset: 0, limit: 1 })
  const before = f.sqlReads, context = f.reader().getArtworkContext(artworkRequest(album))
  assert.equal(f.sqlReads - before, 0, '全成员派生超界不影响独立紧凑卡片；只按唯一当前图源索引实读原行')
  const page = f.reader().queryAlbumMembers({ albumKey: album.id, rootId, offset: 0, limit: 200 })
  assert.equal(page.total, 10); assert.equal(page.items.length, 10); assert.equal(page.hasMore, false)
  assert.equal(album.representativeTrackId, page.items[0]!.fact.summary.track.id)
  assert.equal(page.items[0]!.fact.hasArtwork, false); assert.equal(page.items.at(-1)!.fact.hasArtwork, true)
  assert.deepEqual(context.album, album); assert.equal(context.representative!.summary.track.id, page.items.at(-1)!.fact.summary.track.id)
  assert.equal(context.representative!.summary.asset.libraryRootId, rootId)
  const tail = f.reader().queryAlbumMembers({ albumKey: album.id, rootId, offset: 9, limit: 1 })
  assert.deepEqual(tail.items, page.items.slice(9)); assert.equal(tail.total, 10); assert.equal(tail.hasMore, false)
  assert.deepEqual(f.reader().queryAlbums(query({ limit: 1, offset: 199 })), albums)
})

test('613 SQL封面源成员：当前源行、元数据与读取前后屏障实际变化仍拒旧tuple', t => {
  const first = track(30, '当前/01.flac'), covered = track(31, '当前/02.flac', undefined, { embedded: true }), f = fixture(t, { tracks: [first, covered] })
  const before = f.reader().queryAlbums(query()).items[0]!, original = artworkRequest(before)
  assert.equal(f.reader().getArtworkContext(original).representative!.summary.track.id, covered.summary.track.id)
  f.db.prepare('UPDATE local_catalog_tracks SET data=? WHERE id=?').run(JSON.stringify({ ...covered.summary.track, selectionRevision: '2' }), covered.summary.track.id)
  assert.throws(() => f.reader().getArtworkContext(original), errorCode('SNAPSHOT_CHANGED'))
  const revised = f.reader().queryAlbums(query()).items[0]!, revisionContext = f.reader().getArtworkContext(artworkRequest(revised))
  assert.equal(revisionContext.representative!.summary.track.selectionRevision, '2')
  assert.equal(revised.representativeTrackId, first.summary.track.id); assert.equal(revised.id, before.id)
  f.db.prepare('INSERT INTO local_catalog_overrides VALUES(?,?)').run(covered.summary.track.id, JSON.stringify({ trackId: covered.summary.track.id, revision: '1', fields: { title: '真实MB更正' } }))
  assert.throws(() => f.reader().getArtworkContext(artworkRequest(revised)), errorCode('SNAPSHOT_CHANGED'))
  const latest = f.reader().queryAlbums(query()).items[0]!, read = f.reader(), request = artworkRequest(latest)
  read.queryAlbumIssues({ albumKey: latest.id, rootId, offset: 0, limit: 1 })
  const live = read.getArtworkContext(request)
  assert.equal(live.representative!.rawMetadata.title, covered.rawMetadata.title)
  assert.equal(live.representative!.summary.metadata.title, '真实MB更正')
  assert.throws(() => read.getArtworkContext({ ...request, revision: '0'.repeat(64) }), errorCode('SNAPSHOT_CHANGED'))
  read.queryAlbumIssues({ albumKey: latest.id, rootId, offset: 0, limit: 1 })
  let mutate = true
  observeSqlExecutions615(t, f.db, execution => {
    if (!mutate || execution.phase !== 'after' || execution.step !== undefined || execution.method !== 'all' || !execution.sql.includes('json_each(@memberPage)')) return
    mutate = false
    f.db.prepare('UPDATE local_catalog_tracks SET data=? WHERE id=?').run(JSON.stringify({ ...covered.summary.track, selectionRevision: '3' }), covered.summary.track.id)
  })
  assert.throws(() => read.getArtworkContext(request), errorCode('SNAPSHOT_CHANGED'))
  assert.equal(mutate, false, '必须在原实际indexedRows返回后发生真实SQL变动，再由末屏障拒绝')
  const rootReader = f.reader(), rootAlbum = rootReader.queryAlbums(query()).items[0]!
  f.roots[0]!.root.revision = '2'
  assert.throws(() => rootReader.getArtworkContext(artworkRequest(rootAlbum)), errorCode('SNAPSHOT_CHANGED'))
})


// 合成Owner与真实SQLite链；读取发现更新展示，不改变来源身份。
test('MBF连续浏览来源修订：187项读图晋升后旧页原tuple可复用，真实成员变更仍拒绝', async t => {
  const values = Array.from({ length: 187 }, (_, index) => track(index + 1, `分页${String(index + 1).padStart(3, '0')}/01.flac`, { title: '合成曲目', artist: '合成艺人', album: `专辑${String(index + 1).padStart(3, '0')}` }))
  const f = fixture(t, { tracks: values }); let reads = 0
  const service = f.owner(async () => { reads++; return { image: image(), status: 'ready' } })
  const firstRequest = query({ limit: 60 }), first = await service.queryAlbums(firstRequest), target = first.items[0]!, original = artworkRequest(target)
  assert.equal(first.items.length, 60); assert.equal(first.total, 187); assert.equal(first.counts['has-artwork'], 0)
  assert.equal((await service.getArtwork(original)).image!.display.sha256, image().display.sha256)
  const second = await service.queryAlbums(query({ limit: 60, offset: 60 }))
  assert.equal(second.items.length, 60); assert.equal(second.total, 187); assert.equal(second.counts['has-artwork'], 1)
  const returned = await service.getArtwork(original)
  assert.equal(returned.revision, target.revision); assert.equal(returned.image!.display.sha256, image().display.sha256); assert.equal(reads, 2)
  const current = await service.queryAlbums(firstRequest)
  assert.equal(current.items[0]!.revision, target.revision); assert.equal(current.items[0]!.artworkState, 'available')
  const member = values.find(value => value.summary.track.id === target.representativeTrackId)!
  f.db.prepare('UPDATE local_catalog_tracks SET data=? WHERE id=?').run(JSON.stringify({ ...member.summary.track, selectionRevision: '2' }), member.summary.track.id)
  await assert.rejects(service.getArtwork(original), errorCode('SNAPSHOT_CHANGED')); assert.equal(reads, 2, '真实成员修订拒绝发生在读图作者之前')
  const changed = (await service.queryAlbums(firstRequest)).items.find(value => value.id === target.id)!
  assert.notEqual(changed.revision, target.revision)
  await assert.rejects(service.getArtwork({ ...artworkRequest(changed), rootId: otherRootId }), errorCode('SNAPSHOT_CHANGED')); assert.equal(reads, 2)
})

const parentForTest = (relative: string): string => relative.slice(0, relative.lastIndexOf('/'))

test('SQL紧凑卡片：单根全集跨页复用且读图只查当前三ID候选，不保全成员或调用其它来源', t => {
  const values = Array.from({ length: 36 }, (_, index) => track(index + 1, `组${Math.floor(index / 3)}/${index % 3 + 1}.flac`,
    { title: `曲目${index}`, artist: '合成艺人', album: `专辑${Math.floor(index / 3)}`, track: String(index % 3 + 1) }, { embedded: index % 3 === 2 }))
  const f = fixture(t, { roots: [root(1)], tracks: values }); let compactBuilds = 0, fullMembers = 0
  observeSqlExecutions615(t, f.db, execution => {
    if (execution.phase !== 'before' || execution.step !== undefined) return
    if (execution.sql.includes('mb_album_compact_groups')) compactBuilds++
    if (execution.sql.includes('mb_album_derived_snapshot')) fullMembers++
  })
  const reader = f.reader(), first = reader.queryAlbums(query({ limit: 4 })), original = structuredClone(first)
  const second = f.reader().queryAlbums(query({ rootId, offset: 4, limit: 4 }))
  assert.equal(first.total, 12); assert.equal(second.total, 12); assert.equal(compactBuilds, 1)
  first.items[0]!.title = '不能污染紧凑卡片'
  assert.deepEqual(reader.queryAlbums(query({ limit: 4 })), original)
  f.sourceLookups.length = 0; const before = f.trackDecodes
  for (const album of [...original.items, ...second.items]) {
    const context = f.reader().getArtworkContext(artworkRequest(album))
    const source = values.find(value => value.summary.track.id === album.representativeTrackId)!
    const covered = values.find(value => parentForTest(value.relative) === parentForTest(source.relative) && value.hasArtwork)!
    assert.equal(context.representative!.summary.track.id, covered.summary.track.id)
    assert.equal(context.album.representativeTrackId, source.summary.track.id)
  }
  assert.equal(f.trackDecodes - before, 8); assert.equal(fullMembers, 0); assert.equal(compactBuilds, 1)
  const expected = [...original.items, ...second.items].map(album => values.find(value => value.relative.startsWith(parentForTest(values.find(item => item.summary.track.id === album.representativeTrackId)!.relative) + '/') && value.hasArtwork)!.summary.track.id)
  assert.deepEqual([...new Set(f.sourceLookups)].sort(), expected.sort(), '索引重读的ordinal和原字段只能来自每组实际被选中的那一轨')
})

test('SQL根入口：source标记、扫描和CUE先限实际root，单根紧凑结果不能冒充多根全集', t => {
  const local = track(1, '本根/01.flac'), foreign = track(2, '外根/01.flac', { title: '外根曲目', artist: '外根艺人', album: '外根专辑' }, { rootId: otherRootId })
  const foreignCue = { ...cue(5, '外根/album.cue', [foreign]), libraryRootId: otherRootId, sourceRootId: id(102) }
  const f = fixture(t, { tracks: [local, foreign], cues: [foreignCue], files: [rejected('本根/rejected.bin')] }), reader = f.reader()
  const only = reader.queryAlbums(query({ rootId }))
  assert.equal(only.items.length, 1); assert.equal(only.total, 1)
  assert.deepEqual([...new Set(f.sourceLookups)], [local.summary.track.id]); assert.ok(f.scanReads.every(value => value.rootId === rootId))
  const before = f.sqlReads, all = reader.queryAlbums(query())
  assert.equal(f.sqlReads, before + 1); assert.equal(all.total, 2)
  assert.deepEqual(byIdentity(all.items), byIdentity(groupLocalAlbumSnapshot(f.snapshot()).groups.map(value => value.summary)))
  const beforeSubset = f.sqlReads, subset = reader.queryAlbums(query({ rootId: otherRootId }))
  assert.equal(subset.total, 1); assert.equal(f.sqlReads, beforeSubset, '已确认全根紧凑结果可以再筛其中一个根')
})

test('SQL目录提示：扫描批次变化后重算整个当前目录，新成员及有图成员不沿用旧清单', t => {
  const first = track(1, '目标/01.flac', { title: '第一首', artist: '合成艺人', album: '目标专辑', track: '1' })
  const other = track(2, '其它/01.flac', { title: '其它曲目', artist: '其它艺人', album: '其它专辑' })
  const f = fixture(t, { tracks: [first, other] }), album = f.reader().queryAlbums(query()).items.find(value => value.representativeTrackId === first.summary.track.id)!
  f.db.prepare('UPDATE local_catalog_tracks SET data=? WHERE id=?').run(JSON.stringify({ ...other.summary.track, selectionRevision: '2' }), other.summary.track.id)
  f.sourceLookups.length = 0; f.versionReads.length = 0
  const stable = f.reader().getArtworkContext(artworkRequest(album))
  assert.deepEqual(stable.album, album); assert.deepEqual([...new Set(f.sourceLookups)], [first.summary.track.id])
  assert.ok(f.versionReads.every(value => value.album !== other.rawMetadata.album))
  const covered = track(3, '目标/02.flac', { title: '新发现', artist: '合成艺人', album: '目标专辑', track: '2' }, { embedded: true })
  f.insertFact(covered)
  assert.throws(() => f.reader().getArtworkContext(artworkRequest(album)), errorCode('SNAPSHOT_CHANGED'))
  const current = f.reader().queryAlbums(query()).items.find(value => value.id === album.id)!
  assert.equal(current.trackCount, 2); assert.notEqual(current.revision, album.revision)
  f.db.prepare('UPDATE local_catalog_tracks SET data=? WHERE id=?').run(JSON.stringify({ ...other.summary.track, selectionRevision: '3' }), other.summary.track.id)
  f.sourceLookups.length = 0
  const live = f.reader().getArtworkContext(artworkRequest(current))
  assert.equal(live.representative!.summary.track.id, covered.summary.track.id)
  assert.deepEqual(new Set(f.sourceLookups), new Set([first.summary.track.id, covered.summary.track.id]))
  assert.deepEqual(f.sourceRawReader().getArtworkContext(artworkRequest(current)), live, '旧sourceRaw原字段路径与lookup窄读保持同一当前事实')
  f.db.prepare('UPDATE local_catalog_assets SET relative=?,data=? WHERE id=?').run('搬走/02.flac', JSON.stringify({ ...covered.summary.asset, locationRevision: '2' }), covered.summary.asset.id)
  assert.throws(() => f.reader().getArtworkContext(artworkRequest(current)), errorCode('SNAPSHOT_CHANGED'))
})

test('SQL目录提示：同目录CUE保持原修订，跨目录双向引用与fallback疑点回全root', t => {
  for (const direction of ['同目录', '外侧引用目标', '目标侧引用其它'] as const) {
    const target = track(1, '目标/01.flac', { title: '目标曲目', artist: '合成艺人', album: '' }), other = track(2, '其它/01.flac')
    const selectedCue = direction === '同目录' ? cue(1, '目标/album.cue', [target])
      : direction === '外侧引用目标' ? cue(1, '前置/album.cue', [target]) : cue(1, '目标/album.cue', [other])
    const f = fixture(t, { tracks: [target, other], cues: [selectedCue, cue(2, '零成员/album.cue')] })
    const album = f.reader().queryAlbums(query()).items.find(value => value.representativeTrackId === target.summary.track.id)!
    const before = f.reader().getArtworkContext(artworkRequest(album))
    f.db.prepare('UPDATE local_catalog_tracks SET data=? WHERE id=?').run(JSON.stringify({ ...other.summary.track, selectionRevision: '2' }), other.summary.track.id)
    f.sourceLookups.length = 0
    const after = f.reader().getArtworkContext(artworkRequest(album))
    assert.deepEqual(after, before, direction)
    assert.deepEqual(new Set(f.sourceLookups), new Set(direction === '同目录' ? [target.summary.track.id] : [target.summary.track.id, other.summary.track.id]), direction)
    if (direction === '外侧引用目标') assert.equal(after.directory, '前置', '原group.directory保留跨目录CUE最小目录，不拿它当物理提示')
  }
})

test('SQL目录提示：零成员、组织角色、跨目录edition和换角色均保原全root路径', t => {
  for (const role of [null, 'catalog', 'artist', 'album', 'container'] as const) {
    const a = track(1, '甲/01.flac'), b = track(2, '乙/01.flac'), f = fixture(t, { tracks: [a, b], cues: [cue(1, '零成员/album.cue')] })
    const organizations: LocalAlbumLibraryOrganization[] = role === null ? [] : [{ datasetId: id(900), rootId, sourceRootId: id(101), rootRevision: '1', bindingRevision: 1, recordSha256: 'a'.repeat(64), role, rootName: '合成根', parentName: '合成父目录' }]
    const albums = f.reader({ libraryOrganizations: organizations }).queryAlbums(query()).items
    const album = role === null || role === 'catalog' ? albums.find(value => value.trackCount === 0)! : albums.find(value => value.trackCount > 0)!
    f.db.exec('CREATE TABLE current_hint_fence(id TEXT)'); f.sourceLookups.length = 0
    const context = f.reader({ libraryOrganizations: organizations }).getArtworkContext(artworkRequest(album))
    assert.deepEqual(context.album, album); assert.deepEqual(new Set(f.sourceLookups), new Set([a.summary.track.id, b.summary.track.id]), String(role))
  }
  const a = track(10, '甲/01.flac'), b = track(11, '乙/01.flac'), outside = track(12, '其它/01.flac'), e = edition(1)
  const f = fixture(t, { tracks: [a, b, outside], editions: [e], links: [link(1, e, a), link(2, e, b, 2)] })
  const album = f.reader().queryAlbums(query()).items.find(value => value.editionId === e.id)!
  f.db.exec('CREATE TABLE edition_hint_fence(id TEXT)'); f.sourceLookups.length = 0
  assert.equal(f.reader().getArtworkContext(artworkRequest(album)).album.trackCount, 2)
  assert.deepEqual(new Set(f.sourceLookups), new Set([a.summary.track.id, b.summary.track.id, outside.summary.track.id]))
  const plain = fixture(t, { tracks: [track(20, '甲/01.flac'), track(21, '乙/01.flac')] }), old = plain.reader().queryAlbums(query()).items[0]!
  const organization: LocalAlbumLibraryOrganization = { datasetId: id(900), rootId, sourceRootId: id(101), rootRevision: '1', bindingRevision: 1, recordSha256: 'a'.repeat(64), role: 'artist', rootName: '合成根', parentName: '合成父目录' }
  plain.sourceLookups.length = 0
  assert.throws(() => plain.reader({ libraryOrganizations: [organization] }).getArtworkContext(artworkRequest(old)), errorCode('SNAPSHOT_CHANGED'))
  assert.equal(new Set(plain.sourceLookups).size, 2, '旧catalog提示不能被新artist角色继承')
})

test('SQL紧凑卡片：读原图源行后的真实变化仍拒绝，并丢弃本次缓存', t => {
  const first = track(1, '目标/01.flac'), covered = track(2, '目标/02.flac', undefined, { embedded: true }), f = fixture(t, { tracks: [first, covered] })
  const album = f.reader().queryAlbums(query()).items[0]!, reader = f.reader(); let changed = false
  observeSqlExecutions615(t, f.db, execution => {
    if (changed || execution.phase !== 'after' || execution.step !== undefined || execution.method !== 'all' || !execution.sql.includes('json_each(@memberPage)')) return
    changed = true
    f.db.prepare('UPDATE local_catalog_tracks SET data=? WHERE id=?').run(JSON.stringify({ ...covered.summary.track, selectionRevision: '2' }), covered.summary.track.id)
  })
  assert.throws(() => reader.getArtworkContext(artworkRequest(album)), errorCode('SNAPSHOT_CHANGED')); assert.equal(changed, true)
  assert.throws(() => f.reader().getArtworkContext(artworkRequest(album)), errorCode('SNAPSHOT_CHANGED'))
  const current = f.reader().queryAlbums(query()).items[0]!, context = f.reader().getArtworkContext(artworkRequest(current))
  assert.equal(context.representative!.summary.track.selectionRevision, '2'); assert.notEqual(current.revision, album.revision)
})

test('SQL紧凑卡片：超过一万成员仍只保每组一个图源，不触发原全成员派生预算', t => {
  const values = Array.from({ length: 10_001 }, (_, index) => track(index + 1, `大专辑/${index + 1}.flac`,
    { title: '合成曲目', artist: '合成艺人', album: '合成大专辑', track: String(index + 1) }, { embedded: index === 10_000 }))
  const f = fixture(t, { tracks: values, roots: [root(1)] }); let fullMembers = 0
  observeSqlExecutions615(t, f.db, execution => { if (execution.phase === 'before' && execution.step === undefined && execution.sql.includes('mb_album_derived_snapshot')) fullMembers++ })
  const page = f.reader().queryAlbums(query({ limit: 1 })); assert.equal(page.total, 1); assert.equal(page.items[0]!.trackCount, 10_001)
  const before = f.sqlReads; f.sourceLookups.length = 0
  const context = f.reader().getArtworkContext(artworkRequest(page.items[0]!))
  assert.equal(context.representative!.summary.track.id, values.at(-1)!.summary.track.id)
  assert.deepEqual(new Set(f.sourceLookups), new Set([values.at(-1)!.summary.track.id])); assert.equal(f.trackDecodes, 1)
  assert.equal(f.sqlReads, before); assert.equal(fullMembers, 0)
})

test('SQL紧凑卡片：真实字符串超预算整件弃用，同屏障后页不重试且完整counts和冷图保留', t => {
  const deep = Array.from({ length: 19 }, () => 'a'.repeat(200)).join('/')
  const values = Array.from({ length: 2400 }, (_, index) => track(index + 1, `${deep}/组${index}/01.flac`, { title: '合成曲目', artist: '合成艺人', album: `专辑${index}` }))
  const f = fixture(t, { tracks: values, roots: [root(1)] }), reader = f.reader(); let builds = 0
  const events: ReturnType<typeof readLibraryOperationLine>[] = [], info = console.info
  console.info = (...args: unknown[]) => { for (const line of args) if (typeof line === 'string') events.push(readLibraryOperationLine(line)) }
  t.after(() => { console.info = info })
  observeSqlExecutions615(t, f.db, execution => { if (execution.phase === 'before' && execution.step === undefined && execution.sql.includes('mb_album_compact_groups')) builds++ })
  const first = reader.queryAlbums(query({ limit: 1 })), tail = reader.queryAlbums(query({ offset: 2399, limit: 1 })), empty = reader.queryAlbums(query({ offset: 2400, limit: 1 }))
  for (const page of [first, tail, empty]) { assert.equal(page.total, 2400); assert.equal(page.counts.all, 2400); assert.ok(dto.isLocalAlbumPage(page, page)) }
  assert.equal(first.items.length, 1); assert.equal(tail.items.length, 1); assert.equal(empty.items.length, 0); assert.equal(builds, 1)
  assert.ok(events.some(event => event?.action === 'albums.compact-groups' && event.code === 'CAPACITY' && event.state === 'skipped'))
  const before = f.sqlReads, context = reader.getArtworkContext(artworkRequest(tail.items[0]!))
  assert.equal(f.sqlReads, before + 1, '无成功完整紧凑结果时，单图冷读仍只有一套完整原目标CTE')
  assert.deepEqual(context.album, tail.items[0]); assert.equal(context.representative!.summary.asset.libraryRootId, rootId)
})

test('SQL实际作者：同DB同物理水位的不同Source或codec不继承Derived/Compact，旧reader拒绝新UDF', t => {
  const fact = track(1, '目录/01.flac'), f = fixture(t, { tracks: [fact] }), lookup = f.lookupAuthor(), first = f.reader({}, lookup)
  const original = first.queryAlbums(query()).items[0]!
  first.queryAlbumIssues({ albumKey: original.id, rootId, offset: 0, limit: 1 })
  const otherLookup: typeof lookup = identity => { const value = lookup(identity); return value ? { ...value, fields: { ...value.fields, title: '另一真实Source作者' } } : undefined }
  const second = f.reader({}, otherLookup)
  assert.throws(() => first.getArtworkContext(artworkRequest(original)), errorCode('SNAPSHOT_CHANGED'), '只安装新UDF还未query，旧reader也必须在读取前拒绝')
  const revised = second.queryAlbums(query()).items[0]!
  assert.notEqual(revised.revision, original.revision); assert.equal(revised.id, original.id)
  assert.equal(second.getArtworkContext(artworkRequest(revised)).representative!.rawMetadata.title, '另一真实Source作者')
  assert.throws(() => second.getArtworkContext(artworkRequest(original)), errorCode('SNAPSHOT_CHANGED'))
  const before = f.sqlReads, codec = { ...f.codecFor(f.db), versionTokens: (metadata: dto.LocalMetadata) => tokens(metadata) }
  const third = f.readerFor(f.db, {}, otherLookup, codec), same = third.queryAlbums(query()).items[0]!
  assert.equal(f.sqlReads, before + 1, '相同输出的不同codec作者也重新核当前结构')
  assert.deepEqual(same, revised)
  assert.throws(() => second.getArtworkContext(artworkRequest(revised)), errorCode('SNAPSHOT_CHANGED'))
})

test('SQL实际作者：原行返回后换装Source仍由末屏障拒绝，同函数变事实必须推进原scope', t => {
  const fact = track(1, '目录/01.flac'), f = fixture(t, { tracks: [fact] }), lookup = f.lookupAuthor()
  let title = '第一作者事实'
  const mutableLookup: typeof lookup = identity => { const value = lookup(identity); return value ? { ...value, fields: { ...value.fields, title } } : undefined }
  const reader = f.reader({}, mutableLookup), album = reader.queryAlbums(query()).items[0]!
  let replaced = false
  const changedLookup: typeof lookup = identity => lookup(identity)
  observeSqlExecutions615(t, f.db, execution => {
    if (replaced || execution.phase !== 'after' || execution.step !== undefined || execution.method !== 'all' || !execution.sql.includes('json_each(@memberPage)')) return
    replaced = true; f.reader({}, changedLookup)
  })
  assert.throws(() => reader.getArtworkContext(artworkRequest(album)), errorCode('SNAPSHOT_CHANGED')); assert.equal(replaced, true)
  title = '同函数的新事实'
  const advanced = f.reader({ revision: 'source-2' }, mutableLookup), current = advanced.queryAlbums(query()).items[0]!
  assert.notEqual(current.revision, album.revision)
  assert.equal(advanced.getArtworkContext(artworkRequest(current)).representative!.rawMetadata.title, title)
})

test('SQL结构与当前状态：逐张库存修订只重算overlay，来源封面证据不被missing覆盖丢失', t => {
  const first = track(1, '甲/01.flac', undefined, { embedded: true }), second = track(2, '乙/01.flac'), third = track(3, '丙/01.flac')
  const f = fixture(t, { tracks: [first, second, third], cues: [cue(1, '甲/album.cue', [first])] }), lookup = f.lookupAuthor()
  const states = new Map<string, 'available' | 'missing'>(), reads: string[] = []; let revision = 'resource-1', builds = 0
  const inventory = { revision: () => revision, readPersisted: (key: string) => { reads.push(key); return states.get(key) ?? null }, read: () => 'unknown' as const }
  observeSqlExecutions615(t, f.db, execution => { if (execution.phase === 'before' && execution.step === undefined && execution.sql.includes('mb_album_compact_groups')) builds++ })
  let currentReader = f.reader({ artworkInventory: inventory }, lookup), initial = currentReader.queryAlbums(query())
  const target = initial.items.find(item => item.representativeTrackId === first.summary.track.id)!, initiallyUnknown = initial.items.find(item => item.representativeTrackId === second.summary.track.id)!
  assert.equal(target.artworkAvailable, true); assert.equal(initiallyUnknown.artworkState, 'unknown')
  const cueReads = f.cueDecodes
  for (const [index, state] of (['missing', 'available', 'unknown', 'missing', 'unknown'] as const).entries()) {
    if (state === 'unknown') states.delete(target.id); else states.set(target.id, state)
    states.set(initiallyUnknown.id, index % 2 ? 'missing' : 'available'); revision = `resource-${index + 2}`
    currentReader = f.reader({ artworkInventory: inventory }, lookup); reads.length = 0
    const context = currentReader.getArtworkContext(artworkRequest(target))
    assert.equal(context.album.revision, target.revision)
    assert.equal(context.album.artworkAvailable, state !== 'missing', '库存回unknown后仍使用真实成员嵌图证据')
    assert.equal(context.album.statuses.includes('missing-artwork'), state === 'missing')
    assert.deepEqual(new Set(reads), new Set([target.id]), '单图只overlay本组，不能为一个context读全库状态')
    const page = currentReader.queryAlbums(query()), has = page.items.filter(item => item.artworkAvailable).length, missing = page.items.filter(item => item.statuses.includes('missing-artwork')).length
    assert.equal(page.counts['has-artwork'], has); assert.equal(page.counts['missing-artwork'], missing)
    assert.equal(currentReader.queryAlbums(query({ filter: 'has-artwork' })).total, has)
    assert.equal(currentReader.queryAlbums(query({ filter: 'missing-artwork' })).total, missing)
  }
  assert.equal(builds, 1); assert.equal(f.cueDecodes, cueReads)
  const replacement = { revision: () => revision, read: () => 'missing' as const }, previousReader = currentReader
  const differentAuthor = f.reader({ artworkInventory: replacement }, lookup), page = differentAuthor.queryAlbums(query())
  assert.equal(page.counts['missing-artwork'], 3, '同revision但不同inventory对象必须读取新实际状态')
  assert.throws(() => previousReader.getArtworkContext(artworkRequest(target)), errorCode('SNAPSHOT_CHANGED'))
})

test('SQL物理目录范围：根目录、Unicode与非BMP只取直属项，排除同前缀兄弟及更深子目录', t => {
  for (const directory of ['', '目标😀', '目录e\u0301/唱片']) {
    const relative = directory ? `${directory}/01.flac` : '01.flac'
    const first = track(1, relative, { title: '目标曲目', artist: '合成艺人', album: '目标专辑' })
    const nested = track(2, `${directory ? directory + '/' : ''}子目录/01.flac`), sibling = track(3, `${directory || '根'}0/01.flac`)
    const similar = track(4, `${directory || '根'}后缀/01.flac`), foreign = track(5, relative, undefined, { rootId: otherRootId })
    const f = fixture(t, { tracks: [first, nested, sibling, similar, foreign], files: [rejected(`${directory ? directory + '/' : ''}reject.bin`), rejected(`${directory ? directory + '/' : ''}子目录/reject.bin`)] })
    const album = f.reader().queryAlbums(query()).items.find(value => value.representativeTrackId === first.summary.track.id)!
    f.db.prepare('UPDATE local_catalog_tracks SET data=? WHERE id=?').run(JSON.stringify({ ...nested.summary.track, selectionRevision: '2' }), nested.summary.track.id)
    f.sourceLookups.length = 0; f.scanReads.length = 0; let actualSql = ''
    observeSqlExecutions615(t, f.db, execution => { if (execution.phase === 'before' && execution.step === undefined && execution.sql.includes('current_group AS')) actualSql = execution.sql })
    const context = f.reader().getArtworkContext(artworkRequest(album))
    assert.deepEqual(context.album, album); assert.deepEqual(new Set(f.sourceLookups), new Set([first.summary.track.id]))
    assert.ok(f.scanReads.every(value => value.rootId === rootId && (value.relative.includes('/') ? parentForTest(value.relative) : '') === directory))
    assert.equal(actualSql.includes('mb_album_parent(a.relative)=@hintDirectory'), false)
    assert.ok(directory ? actualSql.includes('a.relative>=@hintPrefix AND a.relative<@hintUpper') : actualSql.includes("instr(a.relative,'/')=0"))
  }
})

test('SQL完整CUE大库：4104目录与61560个合成WAV资产引用跨库存修订只核一次，签名改变仍拒旧tuple', t => {
  const directoryCount = 4104, perDirectory = 15
  const values = Array.from({ length: directoryCount * perDirectory }, (_, index) => {
    const group = Math.floor(index / perDirectory), number = index % perDirectory + 1
    return track(index + 1, `CUE组${String(group).padStart(4, '0')}/${String(number).padStart(2, '0')}.wav`, { title: '合成曲目', artist: '合成艺人', album: `专辑${group}`, track: String(number) })
  })
  const cues = Array.from({ length: directoryCount }, (_, index) => cue(index + 1, `CUE组${String(index).padStart(4, '0')}/album.cue`, values.slice(index * perDirectory, (index + 1) * perDirectory)))
  const f = fixture(t, { tracks: values, cues, roots: [root(1)] }), lookup = f.lookupAuthor()
  const states = new Map<string, 'available' | 'missing'>(); let revision = 'resource-1', compactBuilds = 0, cueBuilds = 0
  const inventory = { revision: () => revision, read: (key: string) => states.get(key) ?? 'unknown' as const }
  observeSqlExecutions615(t, f.db, execution => {
    if (execution.phase !== 'before' || execution.step !== undefined) return
    if (execution.sql.includes('mb_album_compact_groups')) compactBuilds++
    if (execution.method === 'iterate' && execution.sql.startsWith('SELECT rowid cue_rowid')) cueBuilds++
  })
  const first = f.reader({ artworkInventory: inventory }, lookup).queryAlbums(query({ limit: 10 }))
  assert.equal(first.total, directoryCount); assert.equal(first.counts['cue-unsplit'], 0)
  assert.equal(f.cueDecodes, directoryCount, '每项CUE的61560个原asset/scan引用均已实际校验一次')
  for (const [index, album] of first.items.entries()) {
    revision = `resource-${index + 2}`; states.set(album.id, index % 2 ? 'missing' : 'available')
    const reader = f.reader({ artworkInventory: inventory }, lookup), context = reader.getArtworkContext(artworkRequest(album))
    assert.equal(context.album.artworkState, index % 2 ? 'missing' : 'available'); assert.equal(context.album.revision, album.revision)
    const page = reader.queryAlbums(query({ limit: 10 }))
    assert.equal(page.total, directoryCount); assert.equal(page.counts['has-artwork'], Math.floor(index / 2) + 1); assert.equal(page.counts['missing-artwork'], Math.floor((index + 1) / 2))
  }
  assert.equal(compactBuilds, 1); assert.equal(cueBuilds, 1); assert.equal(f.cueDecodes, directoryCount)
  const target = first.items[0]!, source = values.find(value => value.summary.track.id === target.representativeTrackId)!, directory = parentForTest(source.relative)
  const originalCue = cues.find(value => parentForTest(value.item.relative) === directory)!
  f.db.prepare('UPDATE local_cue_sources SET data=? WHERE library_root_id=? AND relative=?').run(JSON.stringify({ ...originalCue, item: { ...originalCue.item, signature: 'changed-cue-signature' } }), rootId, originalCue.item.relative)
  assert.throws(() => f.reader({ artworkInventory: inventory }, lookup).getArtworkContext(artworkRequest(target)), errorCode('SNAPSHOT_CHANGED'))
  assert.equal(cueBuilds, 2); assert.equal(f.cueDecodes, directoryCount * 2)
  t.diagnostic('自有SQLite的4104组/61560引用只证明缓存容量、当前库存与失效，不冒充NAS或正式5分钟扫描。')
})

test('SQL CUE预算：真实长payload超界整件弃用，换库存作者不重试同结构投影且不丢尾CUE', t => {
  const deep = Array.from({ length: 19 }, () => 'a'.repeat(200)).join('/')
  const cues = Array.from({ length: 1100 }, (_, index) => cue(index + 1, `${deep}/零轨${index}/album.cue`)), f = fixture(t, { cues, roots: [root(1)] }), lookup = f.lookupAuthor()
  let projectionReads = 0
  observeSqlExecutions615(t, f.db, execution => { if (execution.phase === 'before' && execution.step === undefined && execution.method === 'iterate' && execution.sql.startsWith('SELECT rowid cue_rowid')) projectionReads++ })
  const first = f.reader({ artworkInventory: { revision: () => 'one', read: () => 'unknown' } }, lookup).queryAlbums(query({ offset: 1099, limit: 1 }))
  assert.equal(first.total, 1100); assert.equal(first.items.length, 1); assert.equal(first.items[0]!.trackCount, 0)
  const next = f.reader({ artworkInventory: { revision: () => 'two', read: () => 'missing' } }, lookup).queryAlbums(query({ offset: 1099, limit: 1 }))
  assert.equal(next.total, 1100); assert.equal(next.counts['missing-artwork'], 1100); assert.equal(next.items[0]!.id, first.items[0]!.id)
  assert.equal(projectionReads, 1, '相同结构的超界哨兵不能因库存或reader对象变化每次重建')
})


/** 闭集原因只观察原logger；不访问私有缓存，也不把同code异常冒充请求claim。 */
function claimCacheEvents(t: test.TestContext) {
  const events: NonNullable<ReturnType<typeof readLibraryOperationLine>>[] = []
  t.mock.method(console, 'info', (...args: unknown[]) => { for (const line of args) {
    const event = typeof line === 'string' ? readLibraryOperationLine(line) : null
    if (event) events.push(event)
  } })
  return events
}
for (const mode of ['compact','derived'] as const) test(`旧封面claim：${mode}拒绝revision/edition/representative错配，真实末屏障后保留已核三层缓存`, t => {
  const events = claimCacheEvents(t), fact = track(1, '目录/01.flac'), f = fixture(t, { tracks: [fact], cues: [cue(1, '目录/disc.cue', [fact])] })
  const reader = f.reader(), album = reader.queryAlbums(query()).items[0]!, member = { albumKey: album.id, rootId: album.rootId, offset: 0, limit: 1 }
  if (mode === 'derived') reader.queryAlbumIssues(member)
  let compactBuilds = 0, derivedBuilds = 0
  observeSqlExecutions615(t, f.db, execution => {
    if (execution.phase !== 'before' || execution.step !== undefined) return
    if (execution.sql.includes('mb_album_compact_groups')) compactBuilds++
    if (execution.sql.includes('mb_album_derived_snapshot')) derivedBuilds++
  })
  const cueDecodes = f.cueDecodes
  for (const mismatch of [{ revision: '0'.repeat(64) }, { editionId: id(900001) }, { representativeTrackId: id(900002) }]) {
    assert.throws(() => reader.getArtworkContext({ ...artworkRequest(album), ...mismatch }), errorCode('SNAPSHOT_CHANGED'))
    assert.equal(isCurrentLocalAlbumSqlReader(f.db, reader), true)
  }
  reader.queryAlbums(query({ filter: 'cue-unsplit' }))
  if (mode === 'derived') reader.queryAlbumIssues(member)
  assert.equal(reader.getArtworkContext(artworkRequest(album)).album.revision, album.revision)
  assert.equal(compactBuilds, 0); assert.equal(derivedBuilds, 0); assert.equal(f.cueDecodes, cueDecodes)
  assert.equal(events.filter(value => value.code === 'ARTWORK_CLAIM_STALE').length, 3)
  assert.equal(events.some(value => value.action === 'albums.read-cache.evict'), false)
})

for (const mode of ['同code异常','真实SQL异常'] as const) test(`旧封面claim反例：${mode}仍整件失效，不按公开SNAPSHOT_CHANGED保留`, t => {
  const events = claimCacheEvents(t), f = fixture(t, { tracks: [track(1, '目录/01.flac')] }), reader = f.reader()
  const album = reader.queryAlbums(query()).items[0]!; let armed = true
  observeSqlExecutions615(t, f.db, execution => {
    if (!armed || execution.phase !== 'before' || execution.step !== undefined || execution.method !== 'get' || !execution.sql.includes('SELECT * FROM groups')) return
    armed = false
    if (mode === '同code异常') throw new LocalAlbumReadError('SNAPSHOT_CHANGED', '合成SQL链同code异常。')
    f.db.prepare('SELECT value FROM synthetic_missing_claim_table').get()
  })
  assert.throws(() => reader.getArtworkContext({ ...artworkRequest(album), revision: '0'.repeat(64) }), errorCode(mode === '同code异常' ? 'SNAPSHOT_CHANGED' : 'UNAVAILABLE'))
  assert.equal(armed, false); assert.equal(isCurrentLocalAlbumSqlReader(f.db, reader), false)
  assert.ok(events.some(value => value.action === 'albums.read-cache.evict' && value.code === 'READ_FAILED'))
  assert.equal(events.some(value => value.code === 'ARTWORK_CLAIM_STALE'), false)
  const start = events.length; f.reader().queryAlbums(query())
  assert.equal(events.slice(start).filter(value => value.code === 'COMPACT_BUILT').length, 1)
})

for (const mode of ['主库物理水位','Source实际作者','末屏障SQL失败'] as const) test(`旧封面claim末屏障：${mode}改变仍失效，不能把claim错配当可信快照`, t => {
  const events = claimCacheEvents(t), fact = track(1, '目录/01.flac'), f = fixture(t, { tracks: [fact] }), lookup = f.lookupAuthor(), reader = f.reader({}, lookup)
  const album = reader.queryAlbums(query()).items[0]!; let armed = true, barriers = 0
  const replacement: typeof lookup = identity => lookup(identity)
  observeSqlExecutions615(t, f.db, execution => {
    if (!armed || execution.phase !== 'before' || execution.step !== undefined || execution.method !== 'get') return
    if (mode === '末屏障SQL失败') {
      if (execution.sql !== 'SELECT total_changes() changes' || ++barriers !== 2) return
      armed = false; throw new Error('合成真实末屏障失败。')
    }
    if (!execution.sql.includes('SELECT * FROM groups')) return
    armed = false
    if (mode === '主库物理水位') f.db.prepare('UPDATE local_catalog_tracks SET data=? WHERE id=?').run(JSON.stringify({ ...fact.summary.track, selectionRevision: '2' }), fact.summary.track.id)
    else f.reader({}, replacement)
  })
  assert.throws(() => reader.getArtworkContext({ ...artworkRequest(album), revision: '0'.repeat(64) }), errorCode(mode === '末屏障SQL失败' ? 'UNAVAILABLE' : 'SNAPSHOT_CHANGED'))
  assert.equal(armed, false); assert.equal(isCurrentLocalAlbumSqlReader(f.db, reader), false)
  const expected = mode === '主库物理水位' ? 'READ_BARRIER_CHANGED' : 'READ_BARRIER_FAILED'
  assert.ok(events.some(value => value.action === 'albums.read-cache.evict' && value.code === expected))
  assert.equal(events.some(value => value.code === 'ARTWORK_CLAIM_STALE'), false)
  const start = events.length; f.reader({}, mode === 'Source实际作者' ? replacement : lookup).queryAlbums(query())
  assert.equal(events.slice(start).filter(value => value.code === 'COMPACT_BUILT').length, 1)
})


for (const mode of ['compact','derived','cold-sql'] as const) test(`旧封面缺组claim：${mode}确认0行仍拒绝，但末屏障成功不丢当前reader/结构`, t => {
  const events = claimCacheEvents(t), fact = track(1, '当前/01.flac'), f = fixture(t, { tracks: [fact], cues: [cue(1, '当前/disc.cue', [fact, fact])] })
  let reader = f.reader(); const album = reader.queryAlbums(query()).items[0]!
  if (mode === 'derived') reader.queryAlbumIssues({ albumKey: album.id, rootId: album.rootId, offset: 0, limit: 1 })
  if (mode === 'cold-sql') reader = f.reader({ revision: 'source-absent-current' })
  const stale = { ...artworkRequest(album), albumKey: `directory-${'f'.repeat(64)}` }, start = events.length
  for (let duplicate = 0; duplicate < 2; duplicate++) {
    assert.throws(() => reader.getArtworkContext(stale), errorCode('SNAPSHOT_CHANGED'))
    assert.equal(isCurrentLocalAlbumSqlReader(f.db, reader), true)
  }
  const rejected = events.slice(start)
  assert.equal(rejected.filter(value => value.code === 'ARTWORK_CLAIM_STALE').length, 2)
  assert.equal(rejected.some(value => value.action === 'albums.read-cache.evict'), false)
  assert.equal(rejected.filter(value => value.code === 'COMPACT_BUILT').length, mode === 'cold-sql' ? 1 : 0)
  const beforeQuery = events.length, current = reader.queryAlbums(query({ filter: 'cue-unsplit' }))
  assert.equal(current.total, 1)
  assert.equal(events.slice(beforeQuery).filter(value => value.code === 'COMPACT_BUILT').length, 0)
})

for (const mode of ['tracks-find','未知root'] as const) test(`旧封面缺组claim边界：${mode}不取得artwork私有保留资格`, t => {
  const events = claimCacheEvents(t), f = fixture(t, { tracks: [track(1, '当前/01.flac')] }), reader = f.reader()
  const album = reader.queryAlbums(query()).items[0]!
  reader.queryAlbumIssues({ albumKey: album.id, rootId: album.rootId, offset: 0, limit: 1 })
  const stale = { ...artworkRequest(album), albumKey: `directory-${'f'.repeat(64)}` }, start = events.length
  assert.throws(() => mode === 'tracks-find'
    ? reader.queryAlbumMembers({ albumKey: stale.albumKey, rootId: stale.rootId, offset: 0, limit: 1 })
    : reader.getArtworkContext({ ...stale, rootId: id(990003) }), errorCode('SNAPSHOT_CHANGED'))
  assert.equal(isCurrentLocalAlbumSqlReader(f.db, reader), false)
  assert.equal(events.slice(start).some(value => value.code === 'ARTWORK_CLAIM_STALE'), false)
  assert.ok(events.slice(start).some(value => value.action === 'albums.read-cache.evict' && value.code === 'READ_FAILED'))
})

for (const mode of ['实物水位改变','Source作者改变','SQL异常'] as const) test(`旧封面SQL零行反例：${mode}仍全失效`, t => {
  const events = claimCacheEvents(t), fact = track(1, '当前/01.flac'), f = fixture(t, { tracks: [fact] }), lookup = f.lookupAuthor()
  const album = f.reader({}, lookup).queryAlbums(query()).items[0]!
  // 原已核目录hint继续优先；将实际资产移出该目录，使原claim的窄范围查询真实返回0行。
  f.db.prepare('UPDATE local_catalog_assets SET relative=? WHERE id=?').run('移出目录/01.flac', fact.summary.asset.id)
  const reader = f.reader({ revision: 'source-zero-current' }, lookup)
  const replacement: typeof lookup = identity => lookup(identity)
  let armed = true
  observeSqlExecutions615(t, f.db, execution => {
    if (!armed || execution.step !== undefined || execution.method !== 'get' || !execution.sql.includes('current_group AS')) return
    if (mode === 'SQL异常' && execution.phase === 'before') { armed = false; throw new Error('合成目标SQL异常，不是0行。') }
    if (mode === 'SQL异常' || execution.phase !== 'after') return
    armed = false
    if (mode === '实物水位改变') f.db.prepare('UPDATE local_catalog_tracks SET data=? WHERE id=?').run(JSON.stringify({ ...fact.summary.track, selectionRevision: '2' }), fact.summary.track.id)
    else f.reader({ revision: 'source-zero-current' }, replacement)
  })
  const start = events.length
  assert.throws(() => reader.getArtworkContext(artworkRequest(album)), errorCode(mode === 'SQL异常' ? 'UNAVAILABLE' : 'SNAPSHOT_CHANGED'))
  assert.equal(armed, false); assert.equal(isCurrentLocalAlbumSqlReader(f.db, reader), false)
  const expected = mode === '实物水位改变' ? 'READ_BARRIER_CHANGED' : mode === 'Source作者改变' ? 'READ_BARRIER_FAILED' : 'READ_FAILED'
  assert.ok(events.slice(start).some(value => value.action === 'albums.read-cache.evict' && value.code === expected))
  assert.equal(events.slice(start).some(value => value.code === 'ARTWORK_CLAIM_STALE'), false)
})


// 独立覆盖有序纯输出索引；继续用本文件真实SQLite/原codec与实际SQL执行观察。
test('有序页索引：405组首屏全量核验，后续200组与末页仅重读实际页的库存', t => {
  const values = Array.from({ length: 405 }, (_,index) => track(index+1, `索引${index+1}/01.flac`, { title:'合成曲目',artist:'合成艺人',album:`专辑${index+1}` }))
  const f = fixture(t,{tracks:values}), reads: string[] = []
  const inventory = { revision: () => 'inventory-stable', read(key:string,rid:string) { reads.push(JSON.stringify([rid,key])); return 'unknown' as const } }
  const reader = f.reader({artworkInventory:inventory}), first = reader.queryAlbums(query())
  assert.equal(first.total,405);assert.equal(first.items.length,200);assert.equal(reads.length,405)
  const all = new Set(first.items.map(item=>item.id));reads.length=0
  const second = reader.queryAlbums(query({offset:200}))
  assert.equal(second.total,405);assert.deepEqual(second.counts,first.counts);assert.equal(second.items.length,200)
  assert.equal(reads.length,200,'不能为新offset再次调用全405组库存');assert.equal(new Set(reads).size,200)
  for (const item of second.items) {assert.equal(all.has(item.id),false);all.add(item.id)}
  reads.length=0;const last=reader.queryAlbums(query({offset:400}))
  assert.equal(last.total,405);assert.deepEqual(last.counts,first.counts);assert.equal(last.items.length,5);assert.equal(last.hasMore,false)
  assert.equal(reads.length,5);for(const item of last.items){assert.equal(all.has(item.id),false);all.add(item.id)}
  assert.equal(all.size,405);reads.length=0
  const empty=reader.queryAlbums(query({offset:600}));assert.equal(empty.total,405);assert.deepEqual(empty.counts,first.counts);assert.deepEqual(empty.items,[]);assert.equal(reads.length,0)
  assert.equal(f.sqlReads,1,'各offset均不可重建全成员结构')
})

test('有序页索引：多根搜索和筛选复用完整自然序及counts，回复修改不污染后页', t => {
  const values=Array.from({length:67},(_,index)=>track(index+1,`系列${index+1}/01.flac`,{title:'合成曲目',artist:index%2?'甲艺人':'乙艺人',album:`专辑${index+1}`},{rootId:index%4===0?otherRootId:rootId}))
  const f=fixture(t,{tracks:values}),reads:string[]=[]
  const inventory={revision:()=> 'mixed-stable',read(key:string,rid:string){reads.push(JSON.stringify([rid,key]));return (key.charCodeAt(key.length-1)%3===0?'available':key.charCodeAt(key.length-1)%3===1?'missing':'unknown') as 'available'|'missing'|'unknown'}}
  const reader=f.reader({artworkInventory:inventory})
  for(const changes of [{},{rootId},{rootId:otherRootId},{query:'专辑1'},{filter:'has-artwork' as const},{filter:'missing-artwork' as const},{filter:'cue-unsplit' as const},{query:'不存在的查询'}]){
    const full=reader.queryAlbums(query({...changes,limit:200})),expected=structuredClone(full)
    Object.assign(full.counts,{all:99999});if(full.items[0]){full.items[0].title='不可污染';(full.items[0].artists as string[]).push('不可污染')}
    reads.length=0;const request=query({...changes,offset:3,limit:7}),page=reader.queryAlbums(request)
    assert.deepEqual(page.counts,expected.counts);assert.equal(page.total,expected.total);assert.deepEqual(page.items,expected.items.slice(3,10));assert.equal(page.hasMore,3+page.items.length<expected.total)
    assert.equal(reads.length,page.items.length,'筛选全集counts不能迫使后页再次遍历所有根')
    assert.ok(dto.isLocalAlbumPage(page,request));assert.deepEqual(reader.queryAlbums({...request}),page)
  }
})

test('有序页索引：真实库存SQLite持续commit严格失效，收尾稳定后才按页复用', t => {
  const f=fixture(t,{tracks:Array.from({length:41},(_,index)=>track(index+1,`库存${index+1}/01.flac`))}),resource=new DatabaseSync(':memory:')
  t.after(()=>resource.close());resource.exec("CREATE TABLE inventory(state TEXT);INSERT INTO inventory VALUES('unknown')")
  let reads=0
  const inventory={revision:()=>`resource-${resource.prepare('SELECT total_changes() n').get()!.n}`,read(){reads++;return resource.prepare('SELECT state FROM inventory').get()!.state as 'available'|'missing'|'unknown'}}
  let reader=f.reader({artworkInventory:inventory});reader.queryAlbums(query({limit:4}));assert.equal(reads,41)
  for(let tick=0;tick<3;tick++){
    const state=tick%2?'missing':'available';resource.prepare('UPDATE inventory SET state=?').run(state)
    assert.throws(()=>reader.queryAlbums(query({offset:4+tick*4,limit:4})),errorCode('SNAPSHOT_CHANGED'))
    reader=f.reader({artworkInventory:inventory});reads=0
    const page=reader.queryAlbums(query({offset:4+tick*4,limit:4}));assert.equal(reads,41,'新库存水位必须重新求完整counts')
    assert.equal(page.counts['has-artwork'],state==='available'?41:0);assert.equal(page.counts['missing-artwork'],state==='missing'?41:0)
    assert.ok(page.items.every(item=>item.artworkState===state))
  }
  reads=0;const settled=reader.queryAlbums(query({offset:28,limit:5}));assert.equal(reads,5);assert.equal(settled.counts['has-artwork'],41)
})

test('有序页索引：主库write、事务rollback与schema改变均完整重算counts后重新分页', t => {
  const values=Array.from({length:19},(_,index)=>track(index+1,`主库${index+1}/01.flac`)),f=fixture(t,{tracks:values})
  let reads=0;const inventory={revision:()=> 'same-resource',read(){reads++;return 'unknown' as const}},reader=f.reader({artworkInventory:inventory})
  reader.queryAlbums(query({limit:2}));assert.equal(reads,19)
  const target=values[0]!.summary.track.id
  const changed=()=>{reads=0;const page=reader.queryAlbums(query({offset:3,limit:2}));assert.equal(reads,19);assert.equal(page.total,19);assert.equal(page.counts.all,19);return page}
  f.db.prepare('INSERT INTO local_catalog_overrides VALUES(?,?)').run(target,JSON.stringify({trackId:target,revision:'1',fields:{album:'新标题'}}));changed()
  f.db.exec('BEGIN IMMEDIATE');f.db.prepare('UPDATE local_catalog_overrides SET data=? WHERE track_id=?').run(JSON.stringify({trackId:target,revision:'2',fields:{album:'事务内标题'}}),target);changed()
  f.db.exec('ROLLBACK');changed()
  f.db.exec('CREATE TABLE ordered_page_schema_fence(id TEXT)');changed()
  reads=0;reader.queryAlbums(query({offset:5,limit:2}));assert.equal(reads,2)
})

test('有序页索引：另一真实SQLite连接commit由data_version丢弃全集纯输出', async t => {
  const temporary=process.env.TMPDIR;assert.ok(temporary&&path.isAbsolute(temporary));if(process.platform==='darwin')assert.ok(temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'))
  const directory=await mkdtemp(path.join(temporary,'ordered-album-pages-')),file=path.join(directory,'synthetic.sqlite')
  const values=Array.from({length:13},(_,index)=>track(index+1,`外部${index+1}/01.flac`)),f=fixture(t,{tracks:values,databasePath:file}),other=new DatabaseSync(file)
  t.after(async()=>{if(other.isOpen)other.close();if(f.db.isOpen)f.db.close();await rm(directory,{recursive:true})})
  let reads=0;const reader=f.reader({artworkInventory:{revision:()=> 'same-inventory',read(){reads++;return 'unknown' as const}}})
  const before=reader.queryAlbums(query({limit:1}));assert.equal(reads,13)
  const target=values[0]!.summary.track.id;other.prepare('INSERT INTO local_catalog_overrides VALUES(?,?)').run(target,JSON.stringify({trackId:target,revision:'1',fields:{album:'另一连接的新标题'}}))
  reads=0;const current=reader.queryAlbums(query({offset:2,limit:2}));assert.equal(reads,13);assert.equal(current.counts.all,before.counts.all)
  reads=0;reader.queryAlbums(query({offset:5,limit:2}));assert.equal(reads,2)
})

test('有序页索引：构造后的真实末水位变化拒绝整次返回且不发布半索引', t => {
  const values=Array.from({length:17},(_,index)=>track(index+1,`末核${index+1}/01.flac`)),f=fixture(t,{tracks:values})
  let reads=0,barriers=0,mutate=true
  const reader=f.reader({artworkInventory:{revision:()=> 'stable-inventory',read(){reads++;return 'unknown' as const}}})
  observeSqlExecutions615(t,f.db,execution=>{
    if(mutate&&execution.phase==='before'&&execution.step===undefined&&execution.sql==='SELECT total_changes() changes'&&++barriers===2){
      mutate=false;const target=values[0]!.summary.track.id;f.db.prepare('INSERT INTO local_catalog_overrides VALUES(?,?)').run(target,JSON.stringify({trackId:target,revision:'1',fields:{album:'末核改变'}}))
    }
  })
  assert.throws(()=>reader.queryAlbums(query({limit:2})),errorCode('SNAPSHOT_CHANGED'));assert.equal(mutate,false)
  reads=0;const fresh=reader.queryAlbums(query({offset:3,limit:2}));assert.equal(fresh.total,17);assert.equal(reads,17,'失败操作绝不可留下只需两组的有序索引')
  reads=0;reader.queryAlbums(query({offset:6,limit:2}));assert.equal(reads,2)
})

test('有序页索引：组织、根授权和Source作者变化不得沿用旧索引', t => {
  const f=fixture(t,{tracks:Array.from({length:9},(_,index)=>track(index+1,`组织${index+1}/01.flac`))})
  const organizations:LocalAlbumLibraryOrganization[]=[{datasetId:id(900),rootId,sourceRootId:id(101),rootRevision:'1',bindingRevision:1,recordSha256:'a'.repeat(64),role:'catalog',rootName:'合成根',parentName:'合成父目录'}]
  const old=f.reader({libraryOrganizations:organizations});assert.equal(old.queryAlbums(query({rootId,limit:1})).total,9)
  organizations[0]!.role='album';organizations[0]!.bindingRevision=2
  assert.throws(()=>old.queryAlbums(query({rootId,offset:2,limit:1})),errorCode('SNAPSHOT_CHANGED'))
  const organized=f.reader({libraryOrganizations:organizations});assert.equal(organized.queryAlbums(query({rootId,limit:1})).total,1)
  f.roots[0]!.availability='REVOKED';assert.throws(()=>organized.queryAlbums(query({rootId,offset:1,limit:1})),errorCode('SNAPSHOT_CHANGED'))
  const revoked=f.reader({libraryOrganizations:organizations});assert.equal(revoked.queryAlbums(query({rootId,limit:1})).items[0]!.artworkState,'source-unavailable')
  f.roots[0]!.availability='ONLINE';const original=f.reader();assert.equal(original.queryAlbums(query({limit:1})).total,9)
  const replacement=f.reader({revision:'source-next'});assert.equal(replacement.queryAlbums(query({offset:3,limit:1})).total,9)
  assert.throws(()=>original.queryAlbums(query({offset:4,limit:1})),errorCode('SNAPSHOT_CHANGED'))
})

for(const failure of ['sql','revocation'] as const)test(`有序页索引：${failure==='sql'?'未知SQL异常':'真实撤销末检查'}不能保留旧计数或跳过下一次完整核验`,t=>{
  const f=fixture(t,{tracks:Array.from({length:37},(_,index)=>track(index+1,`拒绝${index+1}/01.flac`))})
  let reads=0,inject=false
  const revocation=createDatasetOwnerReadRevocation(),inventory={revision:()=> 'same-resource',read(){reads++;return 'unknown' as const}}
  let reader=f.reader({assertReadActive:revocation.assertActive,artworkInventory:inventory})
  reader.queryAlbums(query({limit:1}));assert.equal(reads,37)
  observeSqlExecutions615(t,f.db,execution=>{
    if(inject&&execution.step===undefined&&execution.sql.includes('public_page AS')&&execution.phase===(failure==='sql'?'before':'after')){
      inject=false;if(failure==='sql')throw new Error('合成真实SQL失败');revocation.revoke()
    }
  })
  inject=true;assert.throws(()=>reader.queryAlbums(query({offset:2,limit:1})),errorCode('UNAVAILABLE'));assert.equal(inject,false)
  if(failure==='revocation'){
    assert.throws(()=>reader.queryAlbums(query({offset:3,limit:1})),errorCode('UNAVAILABLE'),'单向旧闩永不重启')
    reader=f.reader({assertReadActive:createDatasetOwnerReadRevocation().assertActive,artworkInventory:inventory})
  }
  reads=0;assert.equal(reader.queryAlbums(query({offset:3,limit:1})).total,37);assert.equal(reads,37)
  reads=0;reader.queryAlbums(query({offset:4,limit:1}));assert.equal(reads,1)
})

test('CD01问题单读：多role冷SQL保完整多碟名称CUE与拒收归属，每页只执行一次真实CTE', async t => {
  for (const role of [null, 'catalog', 'album', 'artist', 'container'] as const) await t.test(role ?? '无绑定', st => {
    const a=track(1,'专辑甲/CD1/01.flac',{artist:'合成艺人',album:'专辑甲',track:'1'}),b=track(2,'专辑甲/CD2/02.flac',{title:'曲目2',album:'专辑甲',track:'2'}),
      c=track(3,'专辑乙/01.flac',{artist:'合成艺人',album:'专辑乙'}),loose=track(4,'散落.flac'),foreign=track(5,'专辑甲/CD1/01.flac',undefined,{rootId:otherRootId})
    const f=fixture(st,{tracks:[a,b,c,loose,foreign],files:[rejected('专辑甲/CD1/read-failed.bin','PARSE_FAILED'),rejected('孤立/unsupported.bin')],
      cues:[cue(1,'专辑甲/CD2/album.cue',[b,b]),cue(2,'零轨/album.cue')],names:[{rootId,directory:'专辑甲/CD1',revision:'name-current',state:'failed'}]})
    const organizations:LocalAlbumLibraryOrganization[]=role===null?[]:[{datasetId:id(900),rootId,sourceRootId:id(101),rootRevision:'1',bindingRevision:1,recordSha256:'a'.repeat(64),role,rootName:'合成艺人 25张',parentName:'合成父目录'}]
    const scope={libraryOrganizations:organizations},lookup=f.lookupAuthor()
    // 参考来自原派生分支的真实SQLite；冷读换回原Source作者，不替换任何SELECT结果。
    const reference=f.reader(scope,identity=>lookup(identity)),albums=reference.queryAlbums(query({rootId})).items
    const expected=albums.map(album=>({album,page:reference.queryAlbumIssues({albumKey:album.id,rootId,offset:0,limit:200})}))
    assert.ok(expected.length>0);assert.ok(expected.some(value=>value.page.items.length>0));assert.ok(expected.some(value=>value.page.rejectedTotal>0))
    if(role===null||role==='catalog')assert.ok(expected.some(value=>value.album.trackCount===0),'保留实际零成员CUE与拒收组')
    let pageReads=0,derivedReads=0
    observeSqlExecutions615(st,f.db,execution=>{
      if(execution.phase!=='before'||execution.step!==undefined)return
      if(execution.sql.includes('mb_album_issues_page'))pageReads++
      if(execution.sql.includes('mb_album_derived_snapshot'))derivedReads++
    })
    const cold=f.reader(scope)
    for(const value of expected){
      const request={albumKey:value.album.id,rootId,offset:0,limit:200},before=f.sqlReads
      f.sourceLookups.length=0
      const actual=cold.queryAlbumIssues(request,{buildDerivedIndex:false})
      assert.deepEqual(actual,value.page);assert.equal(f.sqlReads-before,1,'目标存在性、summary、两个total及两类页共享一次原SQL')
      assert.ok([a,b,c,loose].every(fact=>f.sourceLookups.includes(fact.summary.track.id)),'结构化与未知闭包仍读取所选根的完整原Source范围')
      assert.equal(f.sourceLookups.includes(foreign.summary.track.id),false,'相同目录的另一根不能混入本次问题页')
      Reflect.set(actual,'total',-1);Reflect.set(actual.items,'length',0);Reflect.set(actual.rejectedFiles,'length',0)
      const repeatedBefore=f.sqlReads
      assert.deepEqual(cold.queryAlbumIssues(request,{buildDerivedIndex:false}),value.page)
      assert.equal(f.sqlReads-repeatedBefore,1,'重复调用仍实际重读，不复用可被调用方修改的旧DTO')
    }
    assert.equal(pageReads,expected.length*2);assert.equal(derivedReads,0,'冷问题读取不得创建全库派生索引')
  })
})

test('CD01问题单读：205成员与205拒收的多role分页保完整排序总数及越界空页', async t => {
  for(const role of ['catalog','album','artist'] as const)await t.test(role,st=>{
    const values=Array.from({length:205},(_,index)=>track(index+1,`专辑/CD1/${String(index+1).padStart(3,'0')}.flac`,{artist:'合成艺人',album:'专辑',track:String(index+1)}))
    const files=Array.from({length:205},(_,index)=>rejected(`专辑/CD1/rejected-${String(index+1).padStart(3,'0')}.bin`,index===0?'PARSE_FAILED':'UNSUPPORTED'))
    const f=fixture(st,{tracks:values,files}),scope={libraryOrganizations:[{datasetId:id(900),rootId,sourceRootId:id(101),rootRevision:'1',bindingRevision:1,recordSha256:'a'.repeat(64),role,rootName:'合成艺人',parentName:'合成父目录'}] satisfies LocalAlbumLibraryOrganization[]},lookup=f.lookupAuthor()
    const reference=f.reader(scope,identity=>lookup(identity)),album=reference.queryAlbums(query({rootId})).items.find(value=>value.representativeTrackId===values[0]!.summary.track.id)!
    assert.ok(album);assert.equal(album.trackCount,205)
    const request={albumKey:album.id,rootId,offset:0,limit:200},first=reference.queryAlbumIssues(request),last=reference.queryAlbumIssues({...request,offset:200})
    assert.equal(first.total,206);assert.equal(first.rejectedTotal,205)
    const issues=[...first.items,...last.items],rejectedFiles=[...first.rejectedFiles,...last.rejectedFiles]
    assert.equal(issues.length,206);assert.equal(rejectedFiles.length,205)
    assert.deepEqual(issues.flatMap(value=>value.kind==='missing-metadata'?[value.trackId]:[]),values.map(value=>value.summary.track.id))
    assert.deepEqual(rejectedFiles.map(value=>value.relative),files.map(value=>value.relative))
    let derivedReads=0
    observeSqlExecutions615(st,f.db,execution=>{if(execution.phase==='before'&&execution.step===undefined&&execution.sql.includes('mb_album_derived_snapshot'))derivedReads++})
    const cold=f.reader(scope)
    for(const offset of [0,200,205,206,999]){
      const before=f.sqlReads,page=cold.queryAlbumIssues({...request,offset},{buildDerivedIndex:false})
      assert.deepEqual(page,{total:206,items:issues.slice(offset,offset+200),rejectedTotal:205,rejectedFiles:rejectedFiles.slice(offset,offset+200)})
      assert.equal(f.sqlReads-before,1,'非首批与确认空页仍用一次完整目标SELECT，不把页长冒充total')
    }
    assert.equal(derivedReads,0)
  })
})

test('CD01问题单读：缺目标与错根仍拒绝，真实重复发行关系不能绕过完整summary验证', t => {
  const a=track(1,'发行/01.flac',{artist:'合成艺人',album:'发行专辑'}),e=edition(1),first=link(1,e,a),f=fixture(t,{tracks:[a],editions:[e],links:[first]})
  const album=f.reader().queryAlbums(query()).items[0]!,request={albumKey:album.id,rootId,offset:0,limit:200}
  assert.throws(()=>f.reader().queryAlbumIssues({...request,albumKey:'directory-'+'f'.repeat(64)},{buildDerivedIndex:false}),errorCode('SNAPSHOT_CHANGED'))
  assert.throws(()=>f.reader().queryAlbumIssues({...request,rootId:otherRootId},{buildDerivedIndex:false}),errorCode('SNAPSHOT_CHANGED'))
  assert.equal(f.reader().queryAlbumIssues(request,{buildDerivedIndex:false}).total,1)
  const duplicate=link(2,e,a,2)
  f.db.prepare('INSERT INTO local_catalog_edition_tracks VALUES(?,?,?,?)').run(duplicate.id,duplicate.trackId,duplicate.editionId,JSON.stringify(duplicate))
  assert.throws(()=>f.reader().queryAlbumIssues(request,{buildDerivedIndex:false}),errorCode('UNAVAILABLE'),'同track重复active关系必须由track_count/distinct_tracks完整summary校验拒绝')
})

test('CD01问题单读：实际SELECT后DML元数据DDL根role名称Source或取消变化拒绝整页', async t => {
  for(const mode of ['未知DML','元数据','DDL','根授权','role','名称','Source作者','取消'] as const)await t.test(mode,st=>{
    const a=track(1,'专辑/CD1/01.flac',{artist:'合成艺人',album:'专辑'}),f=fixture(st,{tracks:[a]})
    const organizations:LocalAlbumLibraryOrganization[]=[{datasetId:id(900),rootId,sourceRootId:id(101),rootRevision:'1',bindingRevision:1,recordSha256:'a'.repeat(64),role:'artist',rootName:'合成艺人',parentName:'合成父目录'}]
    const names:LocalAlbumNameEnhancementFact[]=[],revocation=createDatasetOwnerReadRevocation(),scope={libraryOrganizations:organizations,nameEnhancements:names,assertReadActive:revocation.assertActive}
    const album=f.reader(scope).queryAlbums(query({rootId})).items[0]!,request={albumKey:album.id,rootId,offset:0,limit:200},reader=f.reader(scope),lookup=f.lookupAuthor()
    let armed=true,pageReads=0
    observeSqlExecutions615(st,f.db,execution=>{
      if(execution.step!==undefined||execution.method!=='get'||!execution.sql.includes('mb_album_issues_page'))return
      if(execution.phase==='before'){pageReads++;return}
      if(!armed)return;armed=false
      if(mode==='未知DML')f.db.prepare('UPDATE local_catalog_tracks SET data=data WHERE id=?').run(a.summary.track.id)
      else if(mode==='元数据')f.db.prepare('INSERT INTO local_catalog_overrides VALUES(?,?)').run(a.summary.track.id,JSON.stringify({trackId:a.summary.track.id,revision:'1',fields:{title:'新的有效标题'}}))
      else if(mode==='DDL')f.db.exec('CREATE TABLE cd01_issues_external_fence(id TEXT)')
      else if(mode==='根授权')f.roots[0]!.availability='REVOKED'
      else if(mode==='role'){organizations[0]!.role='album';organizations[0]!.bindingRevision=2}
      else if(mode==='名称')names.push({rootId,directory:'专辑/CD1',revision:'new-name',state:'failed'})
      else if(mode==='Source作者')f.reader(scope,identity=>lookup(identity))
      else revocation.revoke()
    })
    assert.throws(()=>reader.queryAlbumIssues(request,{buildDerivedIndex:false}),errorCode(mode==='取消'?'UNAVAILABLE':'SNAPSHOT_CHANGED'))
    assert.equal(armed,false,'变更必须发生在真实SQLite SELECT完成后、原末屏障之前');assert.equal(pageReads,1)
    assert.equal(isCurrentLocalAlbumSqlReader(f.db,reader),false,'失败整页不得留下当前Reader或半成品资格')
    if(mode==='取消'){
      assert.throws(()=>reader.queryAlbumIssues(request,{buildDerivedIndex:false}),errorCode('UNAVAILABLE'),'旧单向撤销闩不得恢复')
      assert.equal(pageReads,1,'已撤销的原闩在SQL发送前拒绝')
    }
    const fresh=f.reader(mode==='取消'?{...scope,assertReadActive:createDatasetOwnerReadRevocation().assertActive}:scope)
    const current=fresh.queryAlbums(query({rootId})).items.find(value=>value.representativeTrackId===a.summary.track.id)!,before=f.sqlReads
    assert.ok(current)
    const page=fresh.queryAlbumIssues({...request,albumKey:current.id},{buildDerivedIndex:false})
    assert.ok(page.items.some(value=>value.kind==='missing-metadata'&&value.trackId===a.summary.track.id));assert.equal(f.sqlReads-before,1)
  })
})

test('CD01问题单读：不同DB及原Source字段更新不能复用上一页问题DTO', t => {
  const a=track(1,'相同目录/01.flac',{artist:'合成艺人',album:'同名专辑'}),f=fixture(t,{tracks:[a]})
  const album=f.reader().queryAlbums(query()).items[0]!,request={albumKey:album.id,rootId,offset:0,limit:200},old=f.reader()
  assert.equal(old.queryAlbumIssues(request,{buildDerivedIndex:false}).total,1)
  a.rawMetadata.title='原Source已补齐'
  const fresh=f.reader();assert.throws(()=>old.queryAlbumIssues(request,{buildDerivedIndex:false}),errorCode('SNAPSHOT_CHANGED'))
  assert.equal(fresh.queryAlbumIssues(request,{buildDerivedIndex:false}).total,0)
  const other=fixture(t,{tracks:[track(1,'相同目录/01.flac',{artist:'另一DB艺人',album:'同名专辑'})]})
  const otherAlbum=other.reader().queryAlbums(query()).items[0]!;assert.equal(otherAlbum.id,album.id)
  assert.equal(other.reader().queryAlbumIssues({...request,albumKey:otherAlbum.id},{buildDerivedIndex:false}).total,1)
})
