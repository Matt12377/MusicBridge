import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync, StatementSync } from 'node:sqlite'
import * as dto from '@music-bridge/contracts'
import { createLocalAlbumSqlReader } from '../../src/collection/local-album-browser/sql-read.js'
import { LocalAlbumReadError } from '../../src/collection/local-album-browser/grouping.js'
import { readLocalAlbumScanState, readLocalAlbumScanStateProjected, readLocalAlbumCueSnapshot, isScanFileState } from '../../src/collection/local-scan-store.js'
import { extractVersionTokens } from '../../src/library/local-name-rules.js'
import type { ScanFileState } from '../../src/collection/local-scan-facts.js'
import type { LocalAlbumSqlCodec, LocalAlbumSqlMobileQuery, LocalAlbumSqlScope } from '../../src/collection/local-album-browser/sql-types.js'

const id = (n: number) => `55555555-5555-4555-8555-${String(n).padStart(12, '0')}`
const request = (changes: Partial<LocalAlbumSqlMobileQuery> = {}): LocalAlbumSqlMobileQuery => ({
  kind: 'members', offset: 0, limit: 100, query: '', rootId: null, albumKey: null, trackId: null, editionId: null, groupHash: null, ...changes,
})

// 真实内存SQLite、完整DTO/扫描codec及同连接水位；无音频、账号或真实曲库输入。
function fixture(t: test.TestContext, groupCount = 24, members = 5) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close())
  db.exec(`CREATE TABLE local_catalog_tracks(id TEXT PRIMARY KEY,asset_id TEXT,data TEXT);
    CREATE TABLE local_catalog_assets(id TEXT PRIMARY KEY,root_id TEXT,source_root_id TEXT,relative TEXT,sha256 TEXT,data TEXT);
    CREATE INDEX asset_location ON local_catalog_assets(root_id,relative);
    CREATE TABLE local_catalog_editions(id TEXT PRIMARY KEY,data TEXT);
    CREATE TABLE local_catalog_edition_tracks(id TEXT PRIMARY KEY,track_id TEXT,edition_id TEXT,data TEXT);
    CREATE TABLE local_catalog_overrides(track_id TEXT PRIMARY KEY,data TEXT);
    CREATE TABLE local_artwork_selections(edition_id TEXT PRIMARY KEY,data TEXT);
    CREATE TABLE local_scan_file_state(library_root_id TEXT,relative TEXT,asset_id TEXT,track_id TEXT,data TEXT,PRIMARY KEY(library_root_id,relative));
    CREATE TABLE local_cue_sources(library_root_id TEXT,relative TEXT,data TEXT);`)
  const roots: dto.LocalRootView[] = [1, 2].map(n => ({ root: { id: id(n), sourceRootId: id(n + 100), revision: '1', role: 'library' }, label: `合成根${n}`, availability: 'ONLINE' }))
  const raw = new Map<string, { ordinal: number; fields: dto.LocalMetadata }>()
  let next = 0, active = true, afterSource: (() => void) | undefined
  let afterSql: ((sql: string, result: unknown) => void) | undefined
  const counters = { source: 0, track: 0, asset: 0, scan: 0, bounded: 0, barrier: 0 }
  const add = (group: number, index: number, directory = `目录😀${group}`, rootIndex = group % 2) => {
    const n = ++next, root = roots[rootIndex]!.root, track: dto.LocalTrack = { id: id(1000 + n), assetId: id(10000 + n), selectionRevision: '1', segment: null }
    const asset: dto.AudioAsset = { id: track.assetId, libraryRootId: root.id, sourceRootId: root.sourceRootId, rootRevision: '1', fileRevision: '1', locationRevision: '1', sampleFrames: null, timebaseHz: null }
    const fields: dto.LocalMetadata = { title: `原曲${n}`, artist: `合成艺人${group % 3}`, album: `Album ${group}`, year: '2026', disc: '1', track: String(index + 1) }
    const relative = `${directory ? directory + '/' : ''}曲${group}-${index + 1}.flac`
    const state: ScanFileState = { libraryRootId: root.id, relative, signature: `合成签名-${n}`, parserVersion: 'music-metadata-11.15.0/mbrs003-v3', outcome: 'accepted', assetId: asset.id, trackId: track.id, failureCode: null,
      readFacts: { technical: { container: 'FLAC', codec: 'FLAC', lossless: true, sampleRateHz: 48000, channels: 2, bitsPerSample: 24, durationSeconds: 123, evidence: 'bounded-parser-reported' }, coverEvidence: [],
        readEvidence: { bytesRead: 1024, readCalls: 1, maxReadBytes: 1024, allocationBytes: 1024, elapsedMs: 1, wholeAudioHash: false, wholeAudioDecode: false } } }
    assert.ok(isScanFileState(state)); raw.set(track.id, { ordinal: n, fields })
    db.prepare('INSERT INTO local_catalog_tracks VALUES(?,?,?)').run(track.id, asset.id, JSON.stringify(track))
    db.prepare('INSERT INTO local_catalog_assets VALUES(?,?,?,?,?,?)').run(asset.id, root.id, root.sourceRootId, relative, null, JSON.stringify(asset))
    db.prepare('INSERT INTO local_scan_file_state VALUES(?,?,?,?,?)').run(root.id, relative, asset.id, track.id, JSON.stringify(state))
    return { track, asset, relative, fields }
  }
  // 位置约束与原表一致；SQL参数仍由调用方原始私有事实提供。
  for (let group = 0; group < groupCount; group++) for (let n = 0; n < members; n++) add(group, n)
  const names = ['title', 'artist', 'album', 'year', 'disc', 'track'] as const
  const source = { projectionSql: `WITH source_full AS(SELECT json_extract(value,'$.trackId') track_id,json_extract(value,'$.ordinal') ordinal,json_extract(value,'$.fields') fields FROM json_each(@sourceRaw)),candidates AS (
    SELECT t.rowid ordinal,t.id,t.asset_id,t.data,a.id asset_record_id,a.root_id,a.source_root_id,a.relative,a.sha256,a.data asset_data,
    ${names.flatMap(field => [`json_extract(sf.fields,'$.${field}') raw_${field}`, `coalesce(json_extract(v.data,'$.fields.${field}'),json_extract(sf.fields,'$.${field}')) effective_${field}`]).join(',')}
    FROM local_catalog_tracks t JOIN local_catalog_assets a ON a.id=t.asset_id LEFT JOIN local_catalog_overrides v ON v.track_id=t.id LEFT JOIN source_full sf ON sf.track_id=t.id WHERE (@root IS NULL OR a.root_id=@root))`,
    sourceLookup(trackId: string) { counters.source++; afterSource?.(); return raw.get(trackId) } }
  const conflict = (): never => { throw new LocalAlbumReadError('UNAVAILABLE', '合成定位歧义。') }
  const codec: LocalAlbumSqlCodec = {
    track(row) { counters.track++; const v: unknown = JSON.parse(String(row.data)); assert.ok(dto.isLocalTrack(v)); return v },
    asset(row) { counters.asset++; const v: unknown = JSON.parse(String(row.data)); assert.ok(dto.isAudioAsset(v)); return v },
    boundedRow(row) { counters.bounded++; for (const value of Object.values(row)) if (typeof value === 'string') assert.ok(Buffer.byteLength(value) <= 65536) },
    versionTokens(fields) { return (['title', 'artist', 'album'] as const).flatMap(field => fields[field] ? extractVersionTokens(fields[field]!, field) : []).slice(0, 64) },
    scanState(rootId, relative) { counters.scan++; return readLocalAlbumScanState(db, rootId, relative, conflict) },
    scanStateProjected(rootId, relative, data, count, assetRootId, assetRelative) { counters.scan++; return readLocalAlbumScanStateProjected(db, rootId, relative, data, count, assetRootId, assetRelative, conflict) },
    cue: readLocalAlbumCueSnapshot,
  }
  const scope: LocalAlbumSqlScope = { revision: '合成scope'.replace('合成', 'synthetic-'), roots,
    assertReadActive() { counters.barrier++; if (!active) throw new LocalAlbumReadError('UNAVAILABLE', '合成撤销。') } }
  const queries: string[] = [], owners = new WeakMap<StatementSync, DatabaseSync>(), prepare = DatabaseSync.prototype.prepare
  const observedPrepare = function (this: DatabaseSync, sql: string) { const statement = prepare.call(this, sql); owners.set(statement, this); return statement }
  Object.defineProperty(observedPrepare, 'length', { value: prepare.length }); t.mock.method(DatabaseSync.prototype, 'prepare', observedPrepare)
  for (const method of ['get', 'all'] as const) {
    const original = StatementSync.prototype[method]
    const observed = function (this: StatementSync, ...values: unknown[]) {
      const selected = owners.get(this) === db
      if (selected) queries.push(this.sourceSQL)
      const result = Reflect.apply(original, this, values)
      if (selected) afterSql?.(this.sourceSQL, result)
      return result
    }
    Object.defineProperty(observed, 'length', { value: original.length }); t.mock.method(StatementSync.prototype, method, observed)
  }
  const reader = createLocalAlbumSqlReader(db, source, codec, scope)
  return { db, reader, scope, roots, raw, counters, queries, add,
    warm() { reader.queryAlbums({ rootId: null, query: '', filter: 'all', offset: 0, limit: 100 }) },
    reset() { queries.length = 0; for (const key of Object.keys(counters) as (keyof typeof counters)[]) counters[key] = 0 },
    revoke() { active = false }, afterSource(action?: () => void) { afterSource = action },
    afterSql(action?: (sql: string, result: unknown) => void) { afterSql = action },
    makeReader() { return createLocalAlbumSqlReader(db, source, codec, scope) },
    memberQueries() { return queries.filter(sql => sql.includes('page_members AS MATERIALIZED') && sql.includes('source_rows AS MATERIALIZED')) },
  }
}

test('多目录100行只物化一次原成员事实，输出和完整SQL逐字段相同', t => {
  const f = fixture(t), input = request(), expected = f.reader.queryMobile(input)
  f.warm(); f.reset()
  const actual = f.reader.queryMobile(input)
  assert.deepEqual(actual, expected)
  const calls = f.memberQueries()
  assert.equal(calls.length, 1, '同页不能对每个目录重复执行完整事实CTE')
  assert.equal((calls[0]!.match(/source_rows AS MATERIALIZED/gu) ?? []).length, 1, '不能把多份原CTE拼成一次UNION冒充单次物化')
  assert.ok(f.counters.track >= 100 && f.counters.asset >= 100 && f.counters.scan >= 100 && f.counters.bounded >= 100, '当页完整codec和扫描事实仍须逐行执行')
  assert.ok(f.counters.barrier > 0, '每次仍完整检查读取作者与首末水位')
})

test('跨根首中尾和空页、同目录多组及根目录散曲均保持完整SQL顺序', t => {
  const f = fixture(t, 0)
  for (let group = 0; group < 28; group++) for (let n = 0; n < 5; n++) f.add(group, n, group < 2 ? '' : group < 6 ? '共享目录' : `组合😀${group}`)
  const inputs = [0, 3, 97, 100, 138, 140, 160].map(offset => request({ offset }))
  const expected = inputs.map(input => f.reader.queryMobile(input))
  f.warm(); f.reset()
  assert.deepEqual(inputs.map(input => f.reader.queryMobile(input)), expected)
  assert.ok(f.queries.some(sql => sql.includes('mobile_plans AS MATERIALIZED')))
  for (const name of ['SELECT total_changes() changes', 'PRAGMA data_version', 'PRAGMA schema_version']) {
    assert.ok(f.queries.filter(sql => sql === name).length >= inputs.length * 2, '每页仍逐次实读首末完整SQLite水位')
  }
})

test('已核同目录CUE可合并，搜索、单曲和单组保留原资格与逐目录路径', t => {
  const f = fixture(t, 8, 3), root = f.roots[0]!.root
  const cue = { id: id(90000), sidecarId: id(90001), libraryRootId: root.id, sourceRootId: root.sourceRootId, rootRevision: '1',
    item: { relative: '目录😀0/原侧车.cue', signature: '合成侧车签名', parserVersion: 'cue-text-75fps/mbrs003-v1', outcome: 'rejected', failureCode: 'CUE_PARSE_FAILED', reused: false, previousSnapshotId: null, result: null } }
  f.db.prepare('INSERT INTO local_cue_sources VALUES(?,?,?)').run(root.id, cue.item.relative, JSON.stringify(cue))
  const input = request(), expected = f.reader.queryMobile(input)
  f.warm(); f.reset()
  assert.deepEqual(f.reader.queryMobile(input), expected)
  assert.equal(f.memberQueries().length, 1)
  assert.equal(f.queries.some(sql => sql.includes('mobile_plans AS MATERIALIZED')), true, '已核同目录CUE仍经原事实CTE和事件闭包，仅合并同页计划')
  const search = request({ query: '原曲1' }), expectedSearch = f.reader.queryMobile(search)
  f.reset(); assert.deepEqual(f.reader.queryMobile(search), expectedSearch)
  assert.equal(f.queries.some(sql => sql.includes('mobile_plans AS MATERIALIZED')), false)
  const row = expected.items[0]!
  for (const selected of [request({ rootId: row.album.rootId, albumKey: row.album.id }),
    request({ rootId: row.album.rootId, trackId: row.member!.fact.summary.track.id, groupHash: row.groupHash, limit: 2 })]) {
    const original = f.reader.queryMobile(selected)
    f.reset(); assert.deepEqual(f.reader.queryMobile(selected), original)
    assert.equal(f.queries.some(sql => sql.includes('mobile_plans AS MATERIALIZED')), false)
  }
})

test('合并读取期间scope和数据变化仍拒绝整页，失败不会留下部分缓存', t => {
  const f = fixture(t); f.warm(); f.reset()
  f.afterSql(sql => { if (sql.includes('mobile_plans AS MATERIALIZED')) f.scope.revision = 'changed-in-plan-read' })
  assert.throws(() => f.reader.queryMobile(request()), { code: 'SNAPSHOT_CHANGED' })
  f.afterSql(); f.scope.revision = 'new-current-scope'
  const next = f.makeReader(), expected = next.queryMobile(request())
  next.queryAlbums({ rootId: null, query: '', filter: 'all', offset: 0, limit: 100 })
  assert.deepEqual(next.queryMobile(request()), expected)
  let changed = false
  f.afterSql(sql => {
    if (!changed && sql.includes('mobile_plans AS MATERIALIZED')) { changed = true; f.add(99, 0, '后来新目录') }
  })
  assert.throws(() => next.queryMobile(request()), { code: 'SNAPSHOT_CHANGED' })
})

test('每行codec仍复核撤销，错误不发布半页且保留全scope容量', t => {
  const f = fixture(t); f.warm()
  f.afterSource(() => f.revoke())
  assert.throws(() => f.reader.queryMobile(request()), { code: 'UNAVAILABLE' })
  const g = fixture(t); g.warm()
  g.afterSql((_sql, value) => { if (value && typeof value === 'object' && 'global_total' in value) (value as { global_total: number }).global_total = 300001 })
  assert.throws(() => g.reader.queryMobile(request()), { code: 'CONTENT_LIMIT_EXCEEDED' })
})

test('合法长目录超过私有plans文本预算时完整回原路径，回包无外部别名', t => {
  const f = fixture(t, 0), directory = '😀'.repeat(1950)
  for (let group = 0; group < 100; group++) f.add(group, 0, directory + group)
  const expected = f.reader.queryMobile(request())
  f.warm(); f.reset()
  const actual = f.reader.queryMobile(request())
  assert.deepEqual(actual, expected)
  assert.equal(f.queries.some(sql => sql.includes('mobile_plans AS MATERIALIZED')), false)
  assert.equal(f.memberQueries().length, 100, '超新私有预算只退出优化，原完整100行路径不得裁剪')
  actual.items[0]!.album.title = '外部修改'
  assert.deepEqual(f.reader.queryMobile(request()), expected)
})
