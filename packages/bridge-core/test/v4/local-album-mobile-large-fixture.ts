import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import * as dto from '@music-bridge/contracts'
import { createLocalAlbumSqlReader } from '../../src/collection/local-album-browser/sql-read.js'
import { localCatalogLibraryProjectionSql, localCatalogMigration, verifyLocalCatalogDatabase } from '../../src/collection/local-catalog-store.js'
import { LocalAlbumReadError } from '../../src/collection/local-album-browser/grouping.js'
import { readLocalAlbumScanState, readLocalAlbumScanStateProjected, readLocalAlbumCueSnapshot } from '../../src/collection/local-scan-store.js'
import { extractVersionTokens } from '../../src/library/local-name-rules.js'
import type { ScanFileState } from '../../src/collection/local-scan-facts.js'
import type { LocalAlbumSqlCodec, LocalAlbumSqlMobileQuery, LocalAlbumSqlScope } from '../../src/collection/local-album-browser/sql-types.js'
import type { CollectionRepository } from '../../src/collection/repository.js'
import { createMobileOwnerService } from '../../src/mobile/owner-service.js'
import type { MobileLocalAlbums } from '../../src/mobile/local-album-projection.js'
import type { MobileOwnerCatalogRequest } from '../../src/mobile/types.js'

export const syntheticId = (n: number) => `77777777-7777-4777-8777-${String(n).padStart(12, '0')}`
export const mobileMembers = (changes: Partial<LocalAlbumSqlMobileQuery> = {}): LocalAlbumSqlMobileQuery => ({
  kind: 'members', offset: 0, limit: 100, query: '', rootId: null, albumKey: null, trackId: null, editionId: null, groupHash: null, ...changes,
})

/** 只有合成行；表/位置索引和Source原raw/effective表达式均对应生产作者。 */
export function largeMobileFixture(options: { groups?: number; members?: number; singles?: number; roots?: number;
  readerFactory?: typeof createLocalAlbumSqlReader; observations?: boolean; legacyProjection?: boolean; auditedHistory?: boolean; databasePath?:string } = {}) {
  const db = new DatabaseSync(options.databasePath??':memory:')
  if(options.auditedHistory){
    db.exec('PRAGMA foreign_keys=ON;CREATE TABLE source_roots(id TEXT PRIMARY KEY) STRICT;')
    db.exec(localCatalogMigration)
    db.exec('CREATE INDEX local_scan_catalog_locator ON local_catalog_assets(root_id,relative);')
  }else db.exec(`CREATE TABLE local_catalog_tracks(id TEXT PRIMARY KEY,asset_id TEXT NOT NULL,data TEXT NOT NULL) STRICT;
    CREATE INDEX local_catalog_tracks_asset ON local_catalog_tracks(asset_id);
    CREATE TABLE local_catalog_assets(id TEXT PRIMARY KEY,root_id TEXT NOT NULL,source_root_id TEXT NOT NULL,relative TEXT NOT NULL,sha256 TEXT,data TEXT NOT NULL) STRICT;
    CREATE INDEX local_scan_catalog_locator ON local_catalog_assets(root_id,relative);
    CREATE TABLE local_catalog_editions(id TEXT PRIMARY KEY,data TEXT NOT NULL) STRICT;
    CREATE TABLE local_catalog_edition_tracks(id TEXT PRIMARY KEY,edition_id TEXT NOT NULL,track_id TEXT NOT NULL,data TEXT NOT NULL) STRICT;
    CREATE UNIQUE INDEX local_catalog_edition_sequence ON local_catalog_edition_tracks(edition_id,json_extract(data,'$.sequence')) WHERE json_extract(data,'$.active')=1;
    CREATE TABLE local_catalog_observations(id TEXT PRIMARY KEY,track_id TEXT NOT NULL,data TEXT NOT NULL) STRICT;
    CREATE INDEX local_catalog_observations_track ON local_catalog_observations(track_id);
    CREATE TABLE local_catalog_ledger(command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,operation TEXT NOT NULL,request TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
    CREATE TABLE local_catalog_overrides(track_id TEXT PRIMARY KEY,data TEXT NOT NULL) STRICT;`)
  db.exec(`CREATE TABLE local_artwork_selections(edition_id TEXT PRIMARY KEY,data TEXT NOT NULL) STRICT;
    CREATE TABLE local_scan_file_state(library_root_id TEXT NOT NULL,relative TEXT NOT NULL,asset_id TEXT,track_id TEXT,data TEXT NOT NULL,PRIMARY KEY(library_root_id,relative)) STRICT;
    CREATE INDEX local_scan_state_asset ON local_scan_file_state(asset_id);
    CREATE TABLE local_cue_sources(library_root_id TEXT NOT NULL,relative TEXT NOT NULL,data TEXT NOT NULL) STRICT;`)
  const roots: dto.LocalRootView[] = Array.from({ length: options.roots ?? 6 }, (_, n) => ({ root: { id: syntheticId(n + 1), sourceRootId: syntheticId(n + 101), revision: '1', role: 'library' }, label: `合成根${n + 1}`, availability: 'ONLINE' }))
  const raw = new Map<string, { ordinal: number; fields: dto.LocalMetadata }>()
  const counters = { source: 0, track: 0, asset: 0, scan: 0, bounded: 0, barrier: 0 }
  const udf: Record<string, number> = {}, queries: { sql: string; method: string; elapsedMs: number }[] = []
  let afterSql: ((sql: string) => void) | undefined, afterSource: (() => void) | undefined, active = true, next = 0, observing = false
  let targetPlan: { sql: string; plan: Record<string, unknown>[] } | undefined, capturePlan = false
  const nativePrepare = db.prepare, nativeFunction = db.function
  db.prepare = function (sql: string) {
    const statement = nativePrepare.call(db, sql)
    for (const method of ['all', 'get'] as const) {
      const run = statement[method]
      Object.defineProperty(statement, method, { value: function (...values: unknown[]) {
        const began = performance.now(), result = Reflect.apply(run, statement, values)
        if (observing) {
          queries.push({ sql, method, elapsedMs: performance.now() - began })
          if (capturePlan && sql.includes('page_members AS MATERIALIZED')) {
            const explain = nativePrepare.call(db, 'EXPLAIN QUERY PLAN ' + sql); explain.setAllowUnknownNamedParameters(true)
            targetPlan = { sql, plan: Reflect.apply(explain.all, explain, values) }; capturePlan = false
          }
          afterSql?.(sql)
        }
        return result
      } })
    }
    return statement
  }
  db.function = function (name: string, settings: Parameters<DatabaseSync['function']>[1], fn: (...args: never[]) => unknown) {
    const observed = function (...args: never[]) { if (observing) udf[name] = (udf[name] ?? 0) + 1; return Reflect.apply(fn, undefined, args) }
    Object.defineProperty(observed, 'length', { value: fn.length })
    return Reflect.apply(nativeFunction, db, [name, settings, observed])
  } as DatabaseSync['function']
  const insertTrack = nativePrepare.call(db, 'INSERT INTO local_catalog_tracks VALUES(?,?,?)')
  const insertAsset = nativePrepare.call(db, 'INSERT INTO local_catalog_assets VALUES(?,?,?,?,?,?)')
  const insertScan = nativePrepare.call(db, 'INSERT INTO local_scan_file_state VALUES(?,?,?,?,?)')
  const insertObservation = nativePrepare.call(db, 'INSERT INTO local_catalog_observations VALUES(?,?,?)')
  const insertLedger = nativePrepare.call(db, 'INSERT INTO local_catalog_ledger(rowid,command_id,fingerprint,operation,request,result,created_at) VALUES(?,?,?,?,?,?,?)')
  let ledgerSequence=0
  const canonical=(value:unknown):string=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value!==null&&typeof value==='object'?`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical((value as Record<string,unknown>)[key])}`).join(',')}}`:JSON.stringify(value)
  const appendLegal=(operation:string,request:Record<string,unknown>,result:unknown)=>{
    const commandId=syntheticId(400000000+ ++ledgerSequence),body={commandId,...request}
    insertLedger.run(ledgerSequence,commandId,createHash('sha256').update(canonical([operation,body])).digest('hex'),operation,JSON.stringify(body),JSON.stringify(result),'2026-10-21T00:00:00.000Z')
    return ledgerSequence
  }
  if(options.auditedHistory)for(const view of roots){
    nativePrepare.call(db,'INSERT INTO source_roots VALUES(?)').run(view.root.sourceRootId)
    nativePrepare.call(db,'INSERT INTO local_catalog_roots VALUES(?,?,?)').run(view.root.id,view.root.sourceRootId,JSON.stringify(view.root))
    appendLegal('register-root',{sourceRootId:view.root.sourceRootId,role:'library'},view.root)
  }
  const add = (group: number, index: number, directory = `目录😀${group}`, rootIndex = group % roots.length) => {
    const n = ++next, root = roots[rootIndex]!.root
    const track: dto.LocalTrack = { id: syntheticId(1000000 + n), assetId: syntheticId(2000000 + n), selectionRevision: '1', segment: null }
    const asset: dto.AudioAsset = { id: track.assetId, libraryRootId: root.id, sourceRootId: root.sourceRootId, rootRevision: '1', fileRevision: '1', locationRevision: '1', sampleFrames: null, timebaseHz: null }
    const fields: dto.LocalMetadata = { title: `原曲${n}`, artist: `合成艺人${group % 3}`, album: `Album ${group}`, year: '2026', disc: '1', track: String(index + 1) }
    const relative = `${directory ? directory + '/' : ''}曲${group}-${index + 1}.flac`
    const state: ScanFileState = { libraryRootId: root.id, relative, signature: `合成签名-${n}`, parserVersion: 'music-metadata-11.15.0/mbrs003-v3', outcome: 'accepted', assetId: asset.id, trackId: track.id, failureCode: null,
      readFacts: { technical: { container: 'FLAC', codec: 'FLAC', lossless: true, sampleRateHz: 48000, channels: 2, bitsPerSample: 24, durationSeconds: 123, evidence: 'bounded-parser-reported' }, coverEvidence: [],
        readEvidence: { bytesRead: 1024, readCalls: 1, maxReadBytes: 1024, allocationBytes: 1024, elapsedMs: 1, wholeAudioHash: false, wholeAudioDecode: false } } }
    raw.set(track.id, { ordinal: options.observations ? n * 2 : n, fields })
    insertAsset.run(asset.id, root.id, root.sourceRootId, relative, null, JSON.stringify(asset)); insertTrack.run(track.id, asset.id, JSON.stringify(track)); insertScan.run(root.id, relative, asset.id, track.id, JSON.stringify(state))
    if(options.auditedHistory){
      appendLegal('register-asset',{libraryRootId:root.id,expectedRootRevision:'1',relative,sha256:null,sampleFrames:null,timebaseHz:null},asset)
      raw.get(track.id)!.ordinal=appendLegal('create-track',{assetId:asset.id,segment:null},track)
    }
    if (options.observations) {
      const observation = { id: syntheticId(3000000 + n), trackId: track.id, fields, ...(options.auditedHistory?{revision:'1',source:'synthetic',parserVersion:'synthetic-history-v1'}:{}) }
      insertObservation.run(observation.id, track.id, JSON.stringify(observation))
      if(options.auditedHistory)appendLegal('observe-metadata',{trackId:track.id,source:'synthetic',parserVersion:'synthetic-history-v1',fields},observation)
      else insertLedger.run(n * 2 + 1, syntheticId(4000000 + n), 'synthetic', 'observe-metadata', '{}', JSON.stringify(observation), '2026-10-21T00:00:00.000Z')
    }
    return { track, asset, relative, fields }
  }
  db.exec('BEGIN')
  try { for (let group = 0; group < (options.groups ?? 10000); group++) for (let n = 0; n < (group < (options.singles ?? 1000) ? 1 : options.members ?? 9); n++) add(group, n); db.exec('COMMIT') }
  catch (error) { db.exec('ROLLBACK'); db.close(); throw error }
  const fields = ['title', 'artist', 'album', 'year', 'disc', 'track'] as const
  const libraryRaw = (field: string) => `COALESCE((SELECT json_extract(o.data,'$.fields.${field}') FROM local_catalog_observations o WHERE o.track_id=t.id AND json_type(o.data,'$.fields.${field}') IS NOT NULL AND (sf.ordinal IS NULL OR EXISTS(SELECT 1 FROM local_catalog_ledger l WHERE l.rowid>sf.ordinal AND l.operation='observe-metadata' AND json_extract(l.result,'$.id')=o.id)) ORDER BY o.rowid DESC LIMIT 1),json_extract(sf.fields,'$.${field}'))`
  const legacyProjection = `WITH source_full AS (SELECT CAST(json_extract(value,'$.trackId') AS TEXT) track_id,CAST(json_extract(value,'$.ordinal') AS INTEGER) ordinal,json_extract(value,'$.fields') fields FROM json_each(@sourceRaw)),candidates AS (SELECT t.rowid ordinal,t.id,t.asset_id,t.data,a.id asset_record_id,a.root_id,a.source_root_id,a.relative,a.sha256,a.data asset_data,
  ${fields.flatMap(field => [`${libraryRaw(field)} raw_${field}`, `COALESCE(json_extract(v.data,'$.fields.${field}'),${libraryRaw(field)}) effective_${field}`]).join(',')}
  FROM local_catalog_tracks t JOIN local_catalog_assets a ON a.id=t.asset_id LEFT JOIN local_catalog_overrides v ON v.track_id=t.id LEFT JOIN source_full sf ON sf.track_id=t.id WHERE (@root IS NULL OR a.root_id=@root))`
  const source = { projectionSql: options.legacyProjection ? legacyProjection : localCatalogLibraryProjectionSql,
    sourceLookup(trackId: string) { counters.source++; afterSource?.(); return raw.get(trackId) } }
  const conflict = (): never => { throw new LocalAlbumReadError('UNAVAILABLE', '合成定位歧义。') }
  const codec: LocalAlbumSqlCodec = {
    track(row) { counters.track++; const value: unknown = JSON.parse(String(row.data)); assert.ok(dto.isLocalTrack(value)); return value },
    asset(row) { counters.asset++; const value: unknown = JSON.parse(String(row.data)); assert.ok(dto.isAudioAsset(value)); return value },
    boundedRow(row) { counters.bounded++; for (const value of Object.values(row)) if (typeof value === 'string') assert.ok(Buffer.byteLength(value) <= 65536) },
    versionTokens(metadata) { return (['title', 'artist', 'album'] as const).flatMap(field => metadata[field] ? extractVersionTokens(metadata[field]!, field) : []).slice(0, 64) },
    scanState(rootId, relative) { counters.scan++; return readLocalAlbumScanState(db, rootId, relative, conflict) },
    scanStateProjected(rootId, relative, data, count, assetRootId, assetRelative) { counters.scan++; return readLocalAlbumScanStateProjected(db, rootId, relative, data, count, assetRootId, assetRelative, conflict) },
    cue: readLocalAlbumCueSnapshot,
  }
  const scope: LocalAlbumSqlScope = { revision: 'synthetic-scope-one', roots,
    assertReadActive() { counters.barrier++; if (!active) throw new LocalAlbumReadError('UNAVAILABLE', '合成撤销。') } }
  const makeReader = () => (options.readerFactory ?? createLocalAlbumSqlReader)(db, source, codec, scope)
  const reader = makeReader()
  const ownerCounters = { detail: 0, parameters: 0, current: 0, root: 0, source: 0 }
  const parameters: dto.FileAudioParameters = { container: 'FLAC', codec: 'flac', lossless: true, sampleRateHz: 48000, channels: 2, bitsPerSample: 24, durationMs: 123000, evidence: 'bounded-parser-reported' }
  const detail = (trackId: string): dto.LocalLibraryTrackDetail => {
    ownerCounters.detail++
    const row = nativePrepare.call(db, 'SELECT t.data track_data,a.data asset_data FROM local_catalog_tracks t JOIN local_catalog_assets a ON a.id=t.asset_id WHERE t.id=?').get(trackId)
    assert.ok(row); const track = JSON.parse(String(row.track_data)) as dto.LocalTrack, asset = JSON.parse(String(row.asset_data)) as dto.AudioAsset, metadata = raw.get(trackId)!.fields
    return { track, asset, metadata: { raw: metadata, effective: metadata, override: null }, editions: [], versionTokens: codec.versionTokens(metadata), fileParameters: parameters }
  }
  const collection = { localCatalog: { trackDetail: detail,
    root(rootId: string) { ownerCounters.root++; return roots.find(v => v.root.id === rootId)!.root } },
    sources: { root(sourceRootId: string) { ownerCounters.source++; assert.ok(roots.some(v => v.root.sourceRootId === sourceRootId)); return { authorized: active } } },
    localScan: { privateDisplayFileParameters() { ownerCounters.parameters++; return parameters }, privateWithDisplayFileParametersRead<T>(read: () => T) { return read() } },
  } as unknown as CollectionRepository
  const localAlbums = { privateMobile: { async refresh() { scope.assertReadActive!() }, revision() { return scope.revision },
    current(request: LocalAlbumSqlMobileQuery) { return reader.queryMobile(request) } }, async getArtwork() { throw new Error('合成目录性能测试不读取媒体或封面。') } } as unknown as MobileLocalAlbums
  const datasetId = syntheticId(900), owner = createMobileOwnerService({ collection, localAlbums, datasetId, ownerEpoch: syntheticId(901),
    assertCurrent() { ownerCounters.current++; scope.assertReadActive!() } })
  const ownerRequest = (changes: Partial<MobileOwnerCatalogRequest> = {}) => ({ kind: 'catalog' as const, datasetId, request: {
    operation: 'listTracks' as const, serverId: 'server.synthetic', offset: 0, limit: 100, q: '', albumId: null, itemId: null, expectedRevision: null, ...changes,
  } })
  return { db, reader, scope, roots, raw, source, codec, counters, udf, queries, add, makeReader,
    appendLegal, verifyHistory(){assert.equal(options.auditedHistory,true);verifyLocalCatalogDatabase(db)},
    owner, ownerRequest, ownerCounters,
    warm() { return reader.queryMobile(mobileMembers({ kind: 'groups' })) },
    reset() { queries.length = 0; for (const key of Object.keys(counters) as (keyof typeof counters)[]) counters[key] = 0; for (const key of Object.keys(udf)) delete udf[key]; observing = true },
    observe(value: boolean) { observing = value }, plan() { return targetPlan }, capturePlan() { capturePlan = true },
    afterSql(action?: (sql: string) => void) { afterSql = action }, afterSource(action?: () => void) { afterSource = action }, revoke() { active = false }, close() { db.close() }, tracks: next,
  }
}
