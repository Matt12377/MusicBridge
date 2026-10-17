import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync, StatementSync } from 'node:sqlite'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import * as dto from '@music-bridge/contracts'
import { createLocalAlbumSqlReader, readWithLocalAlbumSqlErrors } from '../src/collection/local-album-browser/sql-read.js'
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
import { LOCAL_ALBUM_SQL_ENVELOPE_MAX_BYTES, type LocalAlbumSqlArtworkObservation, type LocalAlbumSqlCodec, type LocalAlbumSqlCueStored, type LocalAlbumSqlScope, type LocalAlbumSqlIssueReadOptions } from '../src/collection/local-album-browser/sql-types.js'
import { createBackupWorkflowStore } from '../src/recording/backup-workflow-store.js'
import { createLocalWorkbenchReadService } from '../src/collection/local-library-workbench/read-service.js'
import { createLocalWorkbenchMBOnlyWriter, type LocalWorkbenchMBOnlyWriter } from '../src/collection/local-library-workbench/owner-writer.js'
import { createLocalWorkbenchPlanRegistry } from '../src/collection/local-library-workbench/plan-registry.js'
import { createLocalWorkbenchOwnerPersistence } from '../src/collection/local-library-workbench/owner-journal.js'
import { createCueSyntheticWave } from '../src/library/local-cue-format-qualification.js'

// 小型真实SQLite与纯分组对照；所有表、身份、扫描和CUE事实均为合成，不读取用户文件。
const id = (n: number) => `22222222-2222-4222-8222-${String(n).padStart(12,'0')}`
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const rootId = id(1), otherRootId = id(2)
const root = (n: number): dto.LocalRootView => ({ root: { id: id(n), sourceRootId: id(100+n), role: 'library', revision: '1' }, label: `合成来源${n}`, availability: 'ONLINE' })
const fields = ['title','artist','album','year','disc','track'] as const
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
    ${fields.flatMap(field => [`json_extract(sf.fields,'$.${field}') raw_${field}`,`coalesce(json_extract(v.data,'$.fields.${field}'),json_extract(sf.fields,'$.${field}')) effective_${field}`]).join(',')}
    FROM local_catalog_tracks t JOIN local_catalog_assets a ON a.id=t.asset_id LEFT JOIN local_catalog_overrides v ON v.track_id=t.id LEFT JOIN source_full sf ON sf.track_id=t.id WHERE @root IS NULL OR a.root_id=@root)`
  let revision = 'catalog-1', sqlReads = 0, trackDecodes = 0, assetDecodes = 0
  const detailReads: string[] = [], versionReads: dto.LocalMetadata[] = []
  observeSqlExecutions615(t, db, execution => {
    if (execution.phase === 'before' && execution.step === undefined && execution.sql.includes('source_rows AS')) sqlReads++
  })
  const codec: LocalAlbumSqlCodec = {
    track(row) { trackDecodes++; const value: unknown = JSON.parse(String(row.data)); if (!dto.isLocalTrack(value) || value.id !== row.id || value.assetId !== row.asset_id) throw new Error('合成轨道事实无效'); return value },
    asset(row) { assetDecodes++; const value: unknown = JSON.parse(String(row.data)); if (!dto.isAudioAsset(value) || value.id !== row.id || value.libraryRootId !== row.root_id || value.sourceRootId !== row.source_root_id) throw new Error('合成资产事实无效'); return value },
    versionTokens(raw) { versionReads.push({ ...raw }); return tokens(raw) },
    boundedRow(row) { for (const value of Object.values(row)) if (typeof value === 'string' && Buffer.byteLength(value)>65536) throw new Error('合成内部字节预算无效') },
    scanState(rid,relative) { const row = db.prepare('SELECT data FROM local_scan_file_state WHERE library_root_id=? AND relative=?').get(rid,relative); return row ? JSON.parse(String(row.data)) as ScanFileState : null },
    cue(raw) { const value = JSON.parse(String(raw)) as LocalAlbumSqlCueStored; if (!dto.isLocalCuePreparedItem(value.item)) throw new Error('合成CUE事实无效'); return value },
  }
  const readerFor = (database: DatabaseSync, changes: Partial<LocalAlbumSqlScope> = {}) => createLocalAlbumSqlReader(database,{ projectionSql, sourceLookup: identity => raw.get(identity) },{ ...codec, scanState(rid,relative) { const row=database.prepare('SELECT data FROM local_scan_file_state WHERE library_root_id=? AND relative=?').get(rid,relative);return row?JSON.parse(String(row.data)) as ScanFileState:null } },{ revision: 'source-1', roots, nameEnhancements: names, ...changes })
  const reader = (changes: Partial<LocalAlbumSqlScope> = {}) => readerFor(db,changes)
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
  return { db,reader,readerFor,snapshot,owner,roots,facts,detailReads,versionReads, get sqlReads(){return sqlReads},get trackDecodes(){return trackDecodes},get assetDecodes(){return assetDecodes},advanceRevision(){revision='catalog-2'},
    sourceRawReader:()=>createLocalAlbumSqlReader(db,{projectionSql,sourceRaw:JSON.stringify([...raw].map(([trackId,value])=>({trackId,...value})))},codec,{revision:'source-1',roots,nameEnhancements:names}) }
}
const comparable = (album:dto.LocalAlbumSummary) => { const {revision,...value}=album; return {...value,lyricsPresence:value.lyricsPresence??'unknown'} }
const byIdentity = (albums:readonly dto.LocalAlbumSummary[])=>[...albums].sort((a,b)=>a.id.localeCompare(b.id)).map(comparable)

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
  const head = reader.queryAlbumMembers(request), last = reader.queryAlbumMembers({ ...request, offset: 2 }), imageContext = reader.getArtworkContext(imageRequest)
  assert.equal(derivedReads, 0, '普通冷详情/尾页/单图不能主动执行全库group/member/issues/rejected派生')
  assert.equal(head.total, 3); assert.equal(head.hasMore, true); assert.equal(head.items[0]!.fact.summary.track.id, first.summary.track.id)
  assert.equal(last.total, 3); assert.equal(last.hasMore, false); assert.equal(last.items[0]!.fact.summary.track.id, tail.summary.track.id)
  assert.deepEqual(imageContext.album, album); assert.equal(imageContext.representative!.summary.track.id, covered.summary.track.id)
  assert.equal(imageContext.representative!.summary.asset.libraryRootId, rootId)
  assert.throws(() => reader.getArtworkContext({ ...imageRequest, revision: 'synthetic-old-revision' }), errorCode('SNAPSHOT_CHANGED'))
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
  assert.equal(f.sqlReads-initial,2)
  r.queryAlbumIssues(request);const beforeRollback=f.sqlReads
  f.db.exec('ROLLBACK');const restored=r.queryAlbumMembers(request)
  assert.deepEqual(restored,first);assert.equal(f.sqlReads-beforeRollback,2,'rollback不能复用事务内真实完整索引，仍走原find和当页SQL')
  r.queryAlbumIssues(request);const beforeSchema=f.sqlReads
  f.db.exec('CREATE TABLE unrelated_derived_fence(id TEXT)');assert.deepEqual(r.queryAlbumMembers(request),first);assert.equal(f.sqlReads-beforeSchema,2)
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
  assert.equal(f.sqlReads-before,2);r.queryAlbumIssues(request);const beforePresent=f.sqlReads
  state='true';revision='lyrics-3';assert.equal(r.queryAlbumMembers(request).album.lyricsPresence,'true');assert.equal(f.sqlReads-beforePresent,2)
  r.queryAlbumIssues(request);const beforeOtherInventory=f.sqlReads
  const other={revision:()=>revision,read:()=>'false' as const};assert.equal(f.reader({lyricsInventory:other}).queryAlbumMembers(request).album.lyricsPresence,'false')
  assert.equal(f.sqlReads-beforeOtherInventory,2,'相同revision的另一个inventory不能复用当前真实完整索引')
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
  assert.equal(first.total,10);assert.equal(first.items.length,1);assert.equal(first.hasMore,false);assert.equal(f.sqlReads-before,2,'显式派生整件超界后直接走原完整find及原成员SQL')
  const beforeAgain=f.sqlReads,again=f.reader().queryAlbumMembers({...request,offset:0,limit:200});assert.equal(again.items.length,10);assert.deepEqual(again.items.at(-1),first.items[0])
  assert.equal(f.sqlReads-beforeAgain,2,'同屏障整件不可缓存时直接执行原完整SQL，不重复读出失败缓存前缀')
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
  assert.deepEqual(result.counts,counts);assert.equal(result.total,1);assert.equal(result.items[0]!.artworkState,'missing');assert.notEqual(result.items[0]!.revision,target.revision)
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
  assert.equal(f.sqlReads-before,2,'冷页仅原find与当页CUE SQL；不能按200个成员重跑全库CTE')
  assert.deepEqual(page.items.map(value=>value.fact.summary.track.id),pure.members.slice(200).map(value=>value.fact.summary.track.id))
  assert.deepEqual(page.items.map(value=>value.statuses),pure.members.slice(200).map(value=>value.statuses));assert.ok(page.items[1]!.statuses.includes('cue-unsplit'));assert.ok(!page.items[3]!.statuses.includes('cue-unsplit'))
  assert.deepEqual(page.items[3]!.fact.summary.track.segment,b.summary.track.segment)
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

test('613 SQL封面源成员：超派生预算后的原完整CTE仍选择同组有图成员并保全部尾成员', t => {
  // 沿原426缓存超界夹具；不提高缓存/读取上限，不注入假的iterator、成员或SQL结果。
  const deep = Array.from({ length: 19 }, () => 'a'.repeat(200)).join('/')
  const values = Array.from({ length: 2000 }, (_, n) => track(n + 1, `${deep}/大组${Math.floor(n / 10)}/${n % 10 + 1}.flac`,
    { title: `曲目${n + 1}`, artist: '合成艺人', album: `专辑${Math.floor(n / 10)}`, track: String(n % 10 + 1) }, { embedded: n % 10 === 9 }))
  const f = fixture(t, { tracks: values }), albums = f.reader().queryAlbums(query({ limit: 1, offset: 199 }))
  assert.equal(albums.total, 200); assert.equal(albums.counts.all, 200)
  const album = albums.items[0]!
  f.reader().queryAlbumIssues({ albumKey: album.id, rootId, offset: 0, limit: 1 })
  const before = f.sqlReads, context = f.reader().getArtworkContext(artworkRequest(album))
  assert.equal(f.sqlReads - before, 2, '显式完整派生超界后必须实际走原find和原CTE图源SQL，不能拿索引前缀冒全集')
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
