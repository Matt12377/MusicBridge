import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync, StatementSync } from 'node:sqlite'
import * as dto from '@music-bridge/contracts'
import { createLocalAlbumSqlReader } from '../../src/collection/local-album-browser/sql-read.js'
import { LocalAlbumReadError } from '../../src/collection/local-album-browser/grouping.js'
import { extractVersionTokens } from '../../src/library/local-name-rules.js'
import type { LocalAlbumTrackFact } from '../../src/collection/local-album-browser/types.js'
import type { LocalAlbumSqlCodec, LocalAlbumSqlCueStored, LocalAlbumSqlMobileQuery, LocalAlbumSqlScope } from '../../src/collection/local-album-browser/sql-types.js'

const id = (value: number) => `44444444-4444-4444-8444-${String(value).padStart(12, '0')}`
const mobile = (changes: Partial<LocalAlbumSqlMobileQuery> = {}): LocalAlbumSqlMobileQuery => ({
  kind: 'groups', offset: 0, limit: 100, query: '', rootId: null, albumKey: null, trackId: null, editionId: null, groupHash: null, ...changes,
})
const desktop = (): dto.LocalAlbumQuery => ({ query: '', rootId: null, filter: 'all', offset: 0, limit: 100 })

// 使用真实内存SQLite和原SELECT，不接触曲库、文件许可或Native Reader。
function fixture(t: test.TestContext, artwork = false) {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  db.exec(`CREATE TABLE local_catalog_tracks(id TEXT PRIMARY KEY,asset_id TEXT,data TEXT);
    CREATE TABLE local_catalog_assets(id TEXT PRIMARY KEY,root_id TEXT,source_root_id TEXT,relative TEXT,sha256 TEXT,data TEXT);
    CREATE TABLE local_catalog_editions(id TEXT PRIMARY KEY,data TEXT);
    CREATE TABLE local_catalog_edition_tracks(id TEXT PRIMARY KEY,track_id TEXT,edition_id TEXT,data TEXT);
    CREATE TABLE local_catalog_overrides(track_id TEXT PRIMARY KEY,data TEXT);
    CREATE TABLE local_artwork_selections(edition_id TEXT PRIMARY KEY,data TEXT);
    CREATE TABLE local_scan_file_state(library_root_id TEXT,relative TEXT,asset_id TEXT,data TEXT,PRIMARY KEY(library_root_id,relative));
    CREATE TABLE local_cue_sources(library_root_id TEXT,relative TEXT,data TEXT);
    CREATE INDEX mobile_assets_position ON local_catalog_assets(root_id,relative);
    CREATE INDEX mobile_tracks_asset ON local_catalog_tracks(asset_id);
    CREATE INDEX mobile_links_track ON local_catalog_edition_tracks(track_id);`)
  const roots: dto.LocalRootView[] = [1, 2].map(value => ({ root: { id: id(value), sourceRootId: id(100 + value), role: 'library', revision: '1' },
    label: `合成来源${value}`, availability: 'ONLINE' }))
  const facts: LocalAlbumTrackFact[] = [], raw = new Map<string, { ordinal: number; fields: dto.LocalMetadata }>()
  function add(value: number, directory: string, album: string, rootIndex = 0) {
    const view = roots[rootIndex]!, fields = { title: `歌曲${value}`, artist: rootIndex ? '另一艺人' : '本地艺人', album, year: '2026' }
    const fact: LocalAlbumTrackFact = { relative: `${directory}/${value}.flac`, rawMetadata: fields,
      summary: { track: { id: id(1000 + value), assetId: id(10000 + value), selectionRevision: '1', segment: null },
        asset: { id: id(10000 + value), libraryRootId: view.root.id, sourceRootId: view.root.sourceRootId, rootRevision: '1', fileRevision: '1', locationRevision: '1', sampleFrames: null, timebaseHz: null },
        metadata: fields, versionTokens: [] }, hasArtwork: false, artworkState: 'unknown', artworkRevision: null }
    facts.push(fact); raw.set(fact.summary.track.id, { ordinal: facts.length, fields })
    db.prepare('INSERT INTO local_catalog_tracks VALUES(?,?,?)').run(fact.summary.track.id, fact.summary.track.assetId, JSON.stringify(fact.summary.track))
    db.prepare('INSERT INTO local_catalog_assets VALUES(?,?,?,?,?,?)').run(fact.summary.asset.id, view.root.id, view.root.sourceRootId, fact.relative, null, JSON.stringify(fact.summary.asset))
    return fact
  }
  add(1, '一', 'Album 1'); add(2, '二', 'Album 2'); add(3, '二', 'Album 2'); add(4, '十', 'Album 10'); add(5, '另一根', 'Other 3', 1)
  const fields = [...dto.LOCAL_METADATA_TEXT_FIELDS, ...dto.LOCAL_METADATA_ARTIST_FIELDS]
  const source = { projectionSql: `WITH source_full AS(SELECT json_extract(value,'$.trackId') track_id,json_extract(value,'$.ordinal') ordinal,json_extract(value,'$.fields') fields FROM json_each(@sourceRaw)),candidates AS (
    SELECT t.rowid ordinal,t.id,t.asset_id,t.data,a.id asset_record_id,a.root_id,a.source_root_id,a.relative,a.sha256,a.data asset_data,
    ${fields.flatMap(field => [`json_extract(sf.fields,'$.${field}') raw_${field}`, `coalesce(json_extract(v.data,'$.fields.${field}'),json_extract(sf.fields,'$.${field}')) effective_${field}`]).join(',')}
    FROM local_catalog_tracks t JOIN local_catalog_assets a ON a.id=t.asset_id LEFT JOIN local_catalog_overrides v ON v.track_id=t.id LEFT JOIN source_full sf ON sf.track_id=t.id WHERE @root IS NULL OR a.root_id=@root)`,
    sourceLookup: (trackId: string) => raw.get(trackId) }
  const codec: LocalAlbumSqlCodec = {
    track(row) { const value: unknown = JSON.parse(String(row.data)); assert.ok(dto.isLocalTrack(value)); return value },
    asset(row) { const value: unknown = JSON.parse(String(row.data)); assert.ok(dto.isAudioAsset(value)); return value },
    versionTokens(metadata) { return (['title', 'artist', 'album'] as const).flatMap(field => metadata[field] ? extractVersionTokens(metadata[field]!, field) : []).slice(0, 64) },
    boundedRow(row) { for (const value of Object.values(row)) if (typeof value === 'string') assert.ok(Buffer.byteLength(value) <= 65536) },
    scanState: () => null,
    // CUE用例只注入原codec已核的内部事实，不访问真实侧车或文件。
    cue(raw) { return JSON.parse(String(raw)) as LocalAlbumSqlCueStored },
  }
  let artworkRevision = 'artwork-one', artworkState: 'available' | 'missing' | 'unknown' = 'unknown', artworkReads = 0
  const inventory = { revision: () => artworkRevision, read: () => { artworkReads++; return artworkState } }
  const scope: LocalAlbumSqlScope = { revision: 'mobile-scope-one', roots, ...(artwork ? { artworkInventory: inventory } : {}) }
  const makeReader = () => createLocalAlbumSqlReader(db, source, codec, scope)
  let afterRead: ((sql: string, result: unknown) => void) | undefined
  const executions: string[] = [], plans: Array<{ candidate: boolean; details: string[] }> = []
  let recordPlans = false
  const prepare = DatabaseSync.prototype.prepare, owners = new WeakMap<StatementSync, DatabaseSync>()
  const observedPrepare = function (this: DatabaseSync, sql: string) { const statement = prepare.call(this, sql); owners.set(statement, this); return statement }
  Object.defineProperty(observedPrepare, 'length', { value: prepare.length }); t.mock.method(DatabaseSync.prototype, 'prepare', observedPrepare)
  for (const method of ['get', 'all', 'iterate'] as const) {
    const original = StatementSync.prototype[method]
    const observed = function (this: StatementSync, ...bindings: unknown[]) {
      const selected = owners.get(this) === db
      if (selected) executions.push(this.sourceSQL)
      const result = Reflect.apply(original, this, bindings)
      if (selected && recordPlans && method !== 'iterate'
        && (this.sourceSQL.includes('mb_album_mobile_search_candidates') || this.sourceSQL.includes('page_members AS'))) {
        const rows = prepare.call(db, 'EXPLAIN QUERY PLAN ' + this.expandedSQL).all()
        plans.push({ candidate: this.sourceSQL.includes('mb_album_mobile_search_candidates'), details: rows.map(row => String(row.detail)) })
      }
      if (selected && method !== 'iterate') afterRead?.(this.sourceSQL, result)
      return result
    }
    Object.defineProperty(observed, 'length', { value: original.length }); t.mock.method(StatementSync.prototype, method, observed)
  }
  const reader = makeReader()
  return { db, roots, facts, scope, reader, makeReader, add, executions,
    fullReads: () => executions.filter(sql => sql.includes('source_rows AS')).length,
    fullRootReads: () => executions.filter(sql => sql.includes('source_rows AS') && sql.includes('(@root IS NULL OR a.root_id=@root)')).length,
    artworkReads: () => artworkReads,
    reset: () => { executions.length = 0; plans.length = 0 }, plans, recordPlans: () => { recordPlans = true },
    afterRead: (action: ((sql: string, result: unknown) => void) | undefined) => { afterRead = action },
    setArtwork: () => { artworkRevision = 'artwork-two'; artworkState = 'available' },
  }
}

test('移动专辑分页复用同屏障已完成摘要，搜索和自然排序不再扫描全库事实', t => {
  const f = fixture(t), expected = f.reader.queryAlbums(desktop())
  assert.deepEqual(expected.items.map(album => album.title), ['Album 1', 'Album 2', 'Album 10', 'Other 3'])
  f.reset()
  const first = f.reader.queryMobile(mobile({ limit: 2 })), next = f.reader.queryMobile(mobile({ offset: 2, limit: 2 }))
  assert.deepEqual([...first.items, ...next.items].map(row => row.album), expected.items)
  const search = f.reader.queryMobile(mobile({ query: 'album 2' }))
  assert.equal(search.total, 1); assert.equal(search.items[0]!.album.title, 'Album 2')
  t.diagnostic(`已有摘要后的三次移动分页/搜索，全库事实SELECT=${f.fullReads()}`)
  assert.equal(f.fullReads(), 0, '已验证摘要存在时，分页与搜索不能重新执行全库事实CTE')
})

test('移动普通分组页只为选中页读取库存，count不遍历离屏库存', t => {
  const f = fixture(t, true); f.reader.queryAlbums(desktop())
  const before = f.artworkReads(), page = f.reader.queryMobile(mobile({ limit: 1 }))
  assert.equal(page.total, 4); assert.equal(page.items.length, 1)
  assert.equal(f.artworkReads() - before, 1, '总数和选页不能使每个离屏组重复读取库存')
})

test('移动全部歌曲的首末和跨组页与原完整SQL一致，暖摘要后只读取安全目录', t => {
  const f = fixture(t), requests = [0, 1, 2, 3, 4, 5, 8].map(offset => mobile({ kind: 'members', offset, limit: 2 }))
  // 尚无Compact时保留的原完整SQL作为精确行为对照。
  const expected = requests.map(request => f.reader.queryMobile(request))
  f.reader.queryAlbums(desktop()); f.reset()
  const actual = requests.map(request => f.reader.queryMobile(request))
  assert.deepEqual(actual, expected)
  assert.equal(f.fullRootReads(), 0, '完整摘要和全部安全目录hint存在时，不能重新扫描全scope成员')
})

test('非空成员搜索沿热Compact保留原匹配排序分页，零命中不执行全scope事实CTE', t => {
  const f = fixture(t); f.add(6, '二', '同目录另一专辑')
  const overridden = f.facts[2]!
  f.db.prepare('INSERT INTO local_catalog_overrides VALUES(?,?)').run(overridden.summary.track.id,
    JSON.stringify({ fields: { title: '手工改名', artist: '覆盖艺人', album: '覆盖专辑', year: '1999' } }))
  const requests = ['2her', '歌曲3', '手工', '艺人', 'Album 2', '覆盖专辑', '2026', '1999']
    .flatMap(query => [0, 1, 2, 5, 8].map(offset => mobile({ kind: 'members', query, offset, limit: 2 })))
  const expected = requests.map(request => f.reader.queryMobile(request))
  f.reader.queryAlbums(desktop()); const reader = f.makeReader(); f.reset()
  assert.deepEqual(requests.map(request => reader.queryMobile(request)), expected)
  assert.equal(f.fullRootReads(), 0, '热摘要的非空成员搜索不得为匹配和count重建全scope事实')
})

test('成员搜索候选仍守全scope容量和末屏障，失败后不复用半成品', t => {
  const f = fixture(t); f.reader.queryAlbums(desktop())
  const request = mobile({ kind: 'members', query: '2her' })
  f.afterRead((_sql, value) => { if (value && typeof value === 'object' && 'global_total' in value) value.global_total = 300001 })
  assert.throws(() => f.reader.queryMobile(request), { code: 'CONTENT_LIMIT_EXCEEDED' })
  f.afterRead(undefined); let reader = f.makeReader(); reader.queryAlbums(desktop())
  let changed = false
  f.afterRead(sql => { if (!changed && sql.includes('mb_album_mobile_search_candidates')) { changed = true; f.add(6, '新增', '新增专辑') } })
  assert.throws(() => reader.queryMobile(request), { code: 'SNAPSHOT_CHANGED' })
  f.afterRead(undefined); reader = f.makeReader(); f.reset()
  assert.equal(reader.queryMobile(request).total, 0)
  assert.ok(f.fullRootReads() > 0, '末屏障失败必须淘汰原Compact，不能留下成功快路资格')
  reader.queryAlbums(desktop()); reader = f.makeReader(); f.reset()
  assert.equal(reader.queryMobile(request).total, 0); assert.equal(f.fullRootReads(), 0)
})

test('活动发行标题匹配及跨组同轨仍完整回退，不能由目录搜索漏掉关系', t => {
  const f = fixture(t), fact = f.facts[1]!
  for (let value = 0; value < 2; value++) {
    const edition: dto.AlbumEdition = { id: id(9200 + value), title: `发行标题${value}`, edition: '特定版', revision: '1' }
    const link: dto.AlbumEditionTrack = { id: id(9300 + value), editionId: edition.id, trackId: fact.summary.track.id,
      disc: 1, trackNumber: 1, sequence: 1, revision: '1', active: true }
    f.db.prepare('INSERT INTO local_catalog_editions VALUES(?,?)').run(edition.id, JSON.stringify(edition))
    f.db.prepare('INSERT INTO local_catalog_edition_tracks VALUES(?,?,?,?)').run(link.id, link.trackId, link.editionId, JSON.stringify(link))
  }
  const requests = ['发行标题0', '特定版', '歌曲2'].flatMap(query => [0, 1, 2].map(offset => mobile({ kind: 'members', query, offset, limit: 1 })))
  const reader = f.makeReader(), expected = requests.map(request => reader.queryMobile(request))
  assert.deepEqual(expected.slice(0, 3).map(page => page.total), [2, 2, 2])
  reader.queryAlbums(desktop()); const current = f.makeReader(); f.reset()
  assert.deepEqual(requests.map(request => current.queryMobile(request)), expected)
  assert.ok(f.fullRootReads() > 0)
})

test('6005条合成大库搜索只对候选目录取成员，真实query plan走位置索引且超100目录不截断', { timeout: 60_000 }, t => {
  const f = fixture(t)
  for (let value = 6; value <= 6005; value++) f.add(value, `大库/${value % 300}`, `大库专辑${value % 300}`)
  const requests = ['2her', '歌曲6005', '本地艺人'].map(query => mobile({ kind: 'members', query, limit: 2 }))
  const expected = requests.map(request => f.reader.queryMobile(request))
  f.reader.queryAlbums(desktop()); const reader = f.makeReader(); f.reset(); f.recordPlans()
  const started = performance.now()
  assert.deepEqual(requests.slice(0, 2).map(request => reader.queryMobile(request)), expected.slice(0, 2))
  const elapsedMs = Math.round(performance.now() - started)
  assert.equal(f.fullRootReads(), 0)
  const candidates = f.plans.filter(plan => plan.candidate).flatMap(plan => plan.details)
  const members = f.plans.filter(plan => !plan.candidate).flatMap(plan => plan.details)
  assert.ok(candidates.length > 0 && members.length > 0)
  assert.equal(candidates.some(detail => detail.includes('local_scan_file_state')), false, '候选搜索不能为每条离屏曲目核扫描或组装分组')
  assert.ok(members.some(detail => detail.includes('mobile_assets_position') && detail.includes('root_id=?') && detail.includes('relative>?')),
    '真实成员SELECT必须用root/relative索引限定候选物理目录')
  t.diagnostic(JSON.stringify({ 合成曲目: 6005, 零命中及单目录搜索Ms: elapsedMs, 全scope事实SELECT: f.fullRootReads(),
    候选计划: [...new Set(candidates)].slice(0, 20), 成员位置计划: [...new Set(members.filter(detail => detail.includes('mobile_assets_position')))] }))
  f.reset(); assert.deepEqual(reader.queryMobile(requests[2]!), expected[2])
  assert.ok(f.fullRootReads() > 0, '超过有界候选目录范围必须完整回退，不能返回100目录前缀')
})

test('移动冷读只构建一次完整摘要，后续分页及多根选择复用同一结果', t => {
  const f = fixture(t), first = f.reader.queryMobile(mobile({ limit: 1 }))
  assert.equal(first.total, 4)
  assert.equal(f.reader.queryMobile(mobile({ rootId: f.roots[0]!.root.id })).total, 3)
  assert.equal(f.reader.queryMobile(mobile({ rootId: f.roots[1]!.root.id })).items[0]!.album.title, 'Other 3')
  t.diagnostic(`移动冷读与随后两次选根，全库事实SELECT=${f.fullReads()}`)
  assert.equal(f.fullReads(), 1, '同屏障只允许一次完整摘要构建，不能为count和page分别重建')
})

test('单根移动页先核完整scope摘要，真实目录变更后重新构建并保留完整总数', t => {
  const f = fixture(t)
  assert.equal(f.reader.queryMobile(mobile({ rootId: f.roots[0]!.root.id })).total, 3)
  f.reset(); assert.equal(f.reader.queryMobile(mobile()).total, 4); assert.equal(f.fullReads(), 0)
  f.add(6, '零', 'Album 0'); f.scope.revision = 'mobile-scope-two'
  const reader = f.makeReader(); f.reset()
  const changed = reader.queryMobile(mobile())
  assert.equal(changed.total, 5); assert.equal(changed.items[0]!.album.title, 'Album 0'); assert.equal(f.fullReads(), 1)
})

test('带trackId的分组筛选和成员事实保持原SQL关系，不借摘要猜测成员', t => {
  const f = fixture(t); f.reader.queryAlbums(desktop()); f.reset()
  const fact = f.facts[1]!, page = f.reader.queryMobile(mobile({ trackId: fact.summary.track.id }))
  assert.equal(page.total, 1); assert.equal(page.items[0]!.album.title, 'Album 2'); assert.equal(page.items[0]!.album.trackCount, 2)
  assert.equal(f.fullReads(), 2, '成员存在条件继续使用原完整成员CTE')
  const members = f.reader.queryMobile(mobile({ kind: 'members', rootId: fact.summary.asset.libraryRootId, albumKey: page.items[0]!.album.id, trackId: fact.summary.track.id }))
  assert.equal(members.total, 1); assert.equal(members.items[0]!.member!.fact.summary.track.id, fact.summary.track.id)
})

test('canonical单曲定位先借当前完整摘要，再由原目录成员SQL核验trackId关系', t => {
  const f = fixture(t), fact = f.facts[1]!
  const all = f.reader.queryMobile(mobile({ kind: 'members' })), selected = all.items.find(row => row.member?.fact.summary.track.id === fact.summary.track.id)!
  const request = mobile({ kind: 'members', trackId: fact.summary.track.id, groupHash: selected.groupHash, limit: 2 })
  const expected = f.reader.queryMobile(request)
  assert.equal(expected.total, 1); assert.equal(expected.items[0]!.album.trackCount, 2)
  f.reader.queryAlbums(desktop()); const reader = f.makeReader(); f.reset()
  assert.deepEqual(reader.queryMobile(request), expected)
  t.diagnostic(`canonical单曲首次定位，全scope事实SELECT=${f.fullRootReads()}`)
  assert.equal(f.fullRootReads(), 0, '首个canonical单曲请求不能依赖执行两次全库CTE后才产生的精确缓存')
})

test('单曲快路保留过滤后的分页，同目录错分组和另一根的真实track均不能冒充成员', t => {
  const f = fixture(t), other = f.add(6, '二', '同目录另一专辑'), fact = f.facts[1]!
  const all = f.reader.queryMobile(mobile({ kind: 'members' })), selected = all.items.find(row => row.member?.fact.summary.track.id === fact.summary.track.id)!
  const otherRoot = all.items.find(row => row.album.rootId === f.roots[1]!.root.id)!
  const requests = [
    mobile({ kind: 'members', trackId: fact.summary.track.id, groupHash: selected.groupHash, limit: 1 }),
    mobile({ kind: 'members', trackId: fact.summary.track.id, rootId: selected.album.rootId, albumKey: selected.album.id, limit: 2 }),
    mobile({ kind: 'members', trackId: fact.summary.track.id, groupHash: selected.groupHash, offset: 1, limit: 2 }),
    mobile({ kind: 'members', trackId: other.summary.track.id, groupHash: selected.groupHash, limit: 2 }),
    mobile({ kind: 'members', trackId: fact.summary.track.id, groupHash: otherRoot.groupHash, limit: 2 }),
    mobile({ kind: 'members', trackId: id(99999), groupHash: selected.groupHash, limit: 2 }),
  ]
  const expected = requests.map(request => f.reader.queryMobile(request))
  assert.deepEqual(expected.map(page => page.total), [1, 1, 1, 0, 0, 0]); assert.equal(expected[2]!.items.length, 0)
  f.reader.queryAlbums(desktop()); const reader = f.makeReader(); f.reset()
  assert.deepEqual(requests.map(request => reader.queryMobile(request)), expected)
  assert.equal(f.fullRootReads(), 0)
})

test('缺少唯一分组和非空搜索的单曲请求仍整件回退原完整SQL', t => {
  const f = fixture(t), fact = f.facts[1]!, requests = [
    mobile({ kind: 'members', trackId: fact.summary.track.id, limit: 2 }),
    mobile({ kind: 'members', trackId: fact.summary.track.id, query: '歌曲2', limit: 2 }),
  ]
  const expected = requests.map(request => f.reader.queryMobile(request))
  f.reader.queryAlbums(desktop()); const reader = f.makeReader(); f.reset()
  assert.deepEqual(requests.map(request => reader.queryMobile(request)), expected)
  assert.equal(f.fullRootReads(), 4, '单曲ID本身不能给整个scope或多个分组提供目录授权')
})

test('单曲候选仍受未知CUE、发行和artist组织守卫约束，不从摘要冒领目录能力', t => {
  for (const reason of ['cue', 'edition', 'artist']) {
    const f = fixture(t), root = f.roots[0]!.root, fact = f.facts[1]!
    if (reason === 'cue') {
      const cue = { id: id(8300), sidecarId: id(8301), libraryRootId: root.id, sourceRootId: root.sourceRootId, rootRevision: root.revision,
        item: { relative: '二/未知.cue', outcome: 'accepted', result: { tracks: [{ assetReference: { libraryRootId: root.id,
          sourceRootId: root.sourceRootId, rootRevision: root.revision, assetId: id(99990), relative: '未知/音频.flac',
          fileRevision: '1', locationRevision: '1', signature: 'synthetic-signature' } }] } } }
      f.db.prepare('INSERT INTO local_cue_sources VALUES(?,?,?)').run(root.id, cue.item.relative, JSON.stringify(cue))
    } else if (reason === 'edition') {
      const edition: dto.AlbumEdition = { id: id(9100), title: '合成发行', edition: '合成版', revision: '1' }
      const link: dto.AlbumEditionTrack = { id: id(9101), editionId: edition.id, trackId: fact.summary.track.id,
        disc: 1, trackNumber: 1, sequence: 1, revision: '1', active: true }
      f.db.prepare('INSERT INTO local_catalog_editions VALUES(?,?)').run(edition.id, JSON.stringify(edition))
      f.db.prepare('INSERT INTO local_catalog_edition_tracks VALUES(?,?,?,?)').run(link.id, link.trackId, link.editionId, JSON.stringify(link))
    } else {
      f.scope.libraryOrganizations = [{ datasetId: id(7000), rootId: root.id, sourceRootId: root.sourceRootId, rootRevision: root.revision,
        bindingRevision: 1, recordSha256: 'c'.repeat(64), role: 'artist', rootName: '合成艺人', parentName: '合成来源' }]
    }
    const reader = f.makeReader(), all = reader.queryMobile(mobile({ kind: 'members' }))
    const selected = all.items.find(row => row.member?.fact.summary.track.id === fact.summary.track.id)!
    const request = mobile({ kind: 'members', trackId: fact.summary.track.id, groupHash: selected.groupHash, limit: 2 })
    const expected = reader.queryMobile(request)
    reader.queryAlbums(desktop()); const current = f.makeReader(); f.reset()
    assert.deepEqual(current.queryMobile(request), expected)
    assert.equal(f.fullRootReads(), 2, `${reason}不得绕过原currentMemberHint的拒绝`)
  }
})

test('单曲目录快路仍检查全scope容量和原末屏障，不返回失败读取留下的精确页', t => {
  const f = fixture(t), fact = f.facts[0]!, group = f.reader.queryMobile(mobile({ limit: 1 })).items[0]!
  const request = mobile({ kind: 'members', trackId: fact.summary.track.id, groupHash: group.groupHash, limit: 2 })
  f.afterRead((_sql, result) => { if (result && typeof result === 'object' && 'global_total' in result) (result as { global_total: number }).global_total = 300001 })
  assert.throws(() => f.reader.queryMobile(request), { code: 'CONTENT_LIMIT_EXCEEDED' })
  f.afterRead(undefined); const reader = f.makeReader(); reader.queryAlbums(desktop())
  f.afterRead(sql => { if (sql.includes('page_members AS') && sql.includes('a.relative>=@hintPrefix')) f.scope.revision = 'changed-during-exact-member' })
  assert.throws(() => reader.queryMobile(request), { code: 'SNAPSHOT_CHANGED' })
  f.afterRead(undefined); const current = f.makeReader(); f.reset()
  assert.equal(current.queryMobile(request).total, 1); assert.equal(f.fullRootReads(), 2, '末屏障失败的Compact和精确页必须整体淘汰')
})

test('移动页末屏障变化仍拒绝，下一次不能复用失败读取留下的缓存', t => {
  const f = fixture(t); f.reader.queryAlbums(desktop())
  f.afterRead(sql => { if (sql.includes('mobile_page_groups AS')) f.scope.revision = 'mobile-scope-two' })
  assert.throws(() => f.reader.queryMobile(mobile()), { code: 'SNAPSHOT_CHANGED' })
  f.afterRead(undefined); const reader = f.makeReader(); f.reset()
  assert.equal(reader.queryMobile(mobile()).total, 4); assert.equal(f.fullReads(), 1)
})

test('成员快页保持root、album、edition和hash筛选及原自然排序', t => {
  const f = fixture(t)
  f.add(6, '二', 'Album 2'); f.add(10, '二', 'Album 2'); f.add(12, '二', 'Album 2')
  const all = f.reader.queryMobile(mobile({ kind: 'members' })), chosen = all.items.find(row => row.album.title === 'Album 2')!
  const requests = [
    mobile({ kind: 'members', rootId: f.roots[0]!.root.id, offset: 1, limit: 4 }),
    mobile({ kind: 'members', rootId: f.roots[1]!.root.id, limit: 1 }),
    mobile({ kind: 'members', rootId: chosen.album.rootId, albumKey: chosen.album.id, offset: 1, limit: 3 }),
    mobile({ kind: 'members', groupHash: chosen.groupHash, offset: 2, limit: 2 }),
    mobile({ kind: 'members', rootId: f.roots[1]!.root.id, groupHash: chosen.groupHash }),
    mobile({ kind: 'members', editionId: id(99999) }),
  ]
  const expected = requests.map(request => f.reader.queryMobile(request))
  const groups = f.reader.queryAlbums(desktop()); assert.deepEqual(groups.items.map(row => row.title), ['Album 1', 'Album 2', 'Album 10', 'Other 3'])
  f.reset(); assert.deepEqual(requests.map(request => f.reader.queryMobile(request)), expected)
  assert.equal(f.fullRootReads(), 0)
  assert.equal(expected[3]!.items.length, 2); assert.equal(expected[4]!.total, 0); assert.equal(expected[5]!.total, 0)
})

test('零成员组不占歌曲偏移，但仍计入全scope分组容量', t => {
  const f = fixture(t)
  f.scope.nameEnhancements = [{ rootId: f.roots[0]!.root.id, directory: '空组', state: 'failed', revision: 'failed-one' }]
  const reader = f.makeReader(), request = mobile({ kind: 'members', offset: 1, limit: 3 })
  const expected = reader.queryMobile(request), groups = reader.queryAlbums(desktop()), empty = groups.items.find(row => row.trackCount === 0)!
  assert.ok(empty); assert.equal(groups.total, 5)
  f.reset(); assert.deepEqual(reader.queryMobile(request), expected)
  assert.equal(reader.queryMobile(mobile({ kind: 'members', rootId: empty.rootId, albumKey: empty.id })).total, 0)
  assert.equal(f.fullRootReads(), 0)
  f.afterRead((_sql, result) => {
    if (result && typeof result === 'object' && 'global_total' in result) (result as { global_total: number }).global_total = 300001
  })
  assert.throws(() => reader.queryMobile(request), { code: 'CONTENT_LIMIT_EXCEEDED' })
})

test('任一待读组含发行关系则整页回退，不先拼接安全目录的部分结果', t => {
  const f = fixture(t), edition: dto.AlbumEdition = { id: id(9000), title: 'Album 3 Edition', edition: '合成版', revision: '1' }
  const link: dto.AlbumEditionTrack = { id: id(9001), editionId: edition.id, trackId: f.facts[1]!.summary.track.id,
    disc: 1, trackNumber: 1, sequence: 1, revision: '1', active: true }
  f.db.prepare('INSERT INTO local_catalog_editions VALUES(?,?)').run(edition.id, JSON.stringify(edition))
  f.db.prepare('INSERT INTO local_catalog_edition_tracks VALUES(?,?,?,?)').run(link.id, link.trackId, link.editionId, JSON.stringify(link))
  const requests = [mobile({ kind: 'members', limit: 5 }), mobile({ kind: 'members', editionId: edition.id, limit: 1 })]
  const expected = requests.map(request => f.reader.queryMobile(request))
  f.reader.queryAlbums(desktop()); f.reset()
  assert.deepEqual(requests.map(request => f.reader.queryMobile(request)), expected)
  assert.equal(f.fullRootReads(), 4)
  assert.equal(f.executions.some(sql => sql.includes('page_members AS') && sql.includes('a.relative>=@hintPrefix')), false)
})

test('artist组织角色不能冒用单目录闭包，整页维持原完整SQL', t => {
  const f = fixture(t), root = f.roots[0]!.root
  f.scope.libraryOrganizations = [{ datasetId: id(7000), rootId: root.id, sourceRootId: root.sourceRootId, rootRevision: root.revision,
    bindingRevision: 1, recordSha256: 'a'.repeat(64), role: 'artist', rootName: '合成艺人', parentName: '合成来源' }]
  const reader = f.makeReader(), request = mobile({ kind: 'members' }), expected = reader.queryMobile(request)
  reader.queryAlbums(desktop()); f.reset()
  assert.deepEqual(reader.queryMobile(request), expected); assert.equal(f.fullRootReads(), 2)
})

test('当前catalog组织和完整CUE闭包保持原歌曲页，首屏无需回退全根', t => {
  const f = fixture(t), root = f.roots[0]!.root
  f.scope.libraryOrganizations = [{ datasetId: id(7000), rootId: root.id, sourceRootId: root.sourceRootId, rootRevision: root.revision,
    bindingRevision: 1, recordSha256: 'b'.repeat(64), role: 'catalog', rootName: '合成曲库', parentName: '合成来源' }]
  const cue = { id: id(8200), sidecarId: id(8201), libraryRootId: root.id, sourceRootId: root.sourceRootId, rootRevision: root.revision,
    item: { relative: '一/合成.cue', outcome: 'rejected', result: null } }
  f.db.prepare('INSERT INTO local_cue_sources VALUES(?,?,?)').run(root.id, cue.item.relative, JSON.stringify(cue))
  const reader = f.makeReader(), request = mobile({ kind: 'members', limit: 50 }), expected = reader.queryMobile(request)
  reader.queryAlbums(desktop()); f.reset()
  assert.deepEqual(reader.queryMobile(request), expected)
  assert.equal(f.fullRootReads(), 0, 'catalog角色不会因启用组织事实而丢失原目录闭包')
})

test('未知CUE引用拒绝目录快页；已知失败侧车仍沿完整目录闭包核验', t => {
  for (const unknown of [false, true]) {
    const f = fixture(t), root = f.roots[0]!.root
    const cue = { id: id(8100), sidecarId: id(8101), libraryRootId: root.id, sourceRootId: root.sourceRootId, rootRevision: root.revision,
      item: { relative: '一/合成.cue', outcome: unknown ? 'accepted' : 'rejected', result: unknown ? { tracks: [{ assetReference: {
        libraryRootId: root.id, sourceRootId: root.sourceRootId, rootRevision: root.revision, assetId: id(99990), relative: '未知/音频.flac',
        fileRevision: '1', locationRevision: '1', signature: 'synthetic-signature' } }] } : null } }
    f.db.prepare('INSERT INTO local_cue_sources VALUES(?,?,?)').run(root.id, cue.item.relative, JSON.stringify(cue))
    const request = mobile({ kind: 'members', rootId: root.id }), expected = f.reader.queryMobile(request)
    f.reader.queryAlbums(desktop()); f.reset()
    assert.deepEqual(f.reader.queryMobile(request), expected)
    assert.equal(f.fullRootReads(), unknown ? 2 : 0)
  }
})

test('成员局部读取期间变化和撤销仍拒绝整页，失败不留下可返回的部分页', t => {
  const f = fixture(t); f.reader.queryAlbums(desktop())
  f.afterRead(sql => { if (sql.includes('page_members AS') && (sql.includes('a.relative>=@hintPrefix') || sql.includes('mobile_plans AS MATERIALIZED'))) f.scope.revision = 'changed-during-members' })
  assert.throws(() => f.reader.queryMobile(mobile({ kind: 'members' })), { code: 'SNAPSHOT_CHANGED' })
  f.afterRead(undefined); let active = true
  f.scope.assertReadActive = () => { if (!active) throw new LocalAlbumReadError('UNAVAILABLE', '合成撤销。') }
  const reader = f.makeReader(); reader.queryAlbums(desktop()); active = false
  assert.throws(() => reader.queryMobile(mobile({ kind: 'members' })), { code: 'UNAVAILABLE' })
})

test('移动阶段只记录固定路径与安全计数，成功及拒绝都留下耗时', t => {
  const events: Record<string, unknown>[] = []
  t.mock.method(console, 'info', (line: unknown) => {
    if (typeof line === 'string' && line.startsWith('[MB_LIBRARY_OPERATION] ')) events.push(JSON.parse(line.slice(23)))
  })
  const f = fixture(t); f.reader.queryAlbums(desktop())
  f.reader.queryMobile(mobile({ limit: 1 })); f.reader.queryMobile(mobile({ kind: 'members', limit: 1 }))
  f.reader.queryMobile(mobile({ kind: 'members', query: '歌曲2', limit: 1 }))
  f.reader.queryMobile(mobile({ kind: 'members', trackId: f.facts[1]!.summary.track.id, query: '歌曲2', limit: 1 }))
  f.scope.revision = 'changed-before-mobile'
  assert.throws(() => f.reader.queryMobile(mobile({ kind: 'members' })), { code: 'SNAPSHOT_CHANGED' })
  const mobileEvents = events.filter(row => row.action === 'albums.mobile-groups' || row.action === 'albums.mobile-members')
  assert.deepEqual(mobileEvents.slice(0, 4).map(row => row.code), ['COMPACT_FAST', 'DIRECTORY_FAST', 'SEARCH_DIRECTORY_FAST', 'FULL_FALLBACK'])
  assert.equal(mobileEvents[4]!.state, 'error')
  // 初屏障先拒绝时尚未读取请求kind；NOT_CHECKED不能冒称已经进入members业务阶段。
  assert.equal(mobileEvents[4]!.action, 'albums.mobile-groups'); assert.equal(mobileEvents[4]!.code, 'NOT_CHECKED')
  for (const event of mobileEvents) {
    assert.ok(Number.isFinite(event.elapsedMs)); assert.equal('id' in event, false)
    assert.ok(Object.keys(event).every(key => ['version','part','action','state','atMs','slow','message','code','elapsedMs','total','count'].includes(key)))
  }
})

test('封面库存变化只更新当前overlay，完整scope重核后可复用结构摘要', t => {
  const f = fixture(t, true); f.reader.queryAlbums(desktop()); f.setArtwork()
  const reader = f.makeReader(); f.reset()
  // 库存正常换代后先读歌曲，不能依赖另一次groups请求替它重新暖摘要。
  const members = reader.queryMobile(mobile({ kind: 'members' }))
  assert.ok(members.items.every(row => row.album.artworkAvailable && row.album.artworkState === 'available'))
  assert.equal(f.fullRootReads(), 0, '库存修订变化仍允许复用同结构屏障的摘要与目录闭包')
  const page = reader.queryMobile(mobile())
  assert.ok(page.items.every(row => row.album.artworkAvailable && row.album.artworkState === 'available'))
  assert.equal(f.fullRootReads(), 0, '库存展示变化不应重新扫描全scope结构事实')
})

test('局部单项和成员筛选仍检查全scope专辑容量，30万上限不因结果少而绕过', t => {
  const f = fixture(t), fact = f.facts[1]!, totals: number[] = []
  let injected = 300_001
  f.afterRead((sql, result) => {
    if (!sql.includes('SELECT count(*) total') || !result || typeof result !== 'object' || !('total' in result)) return
    // 先执行原真实count，核实它覆盖两根而非局部过滤；只替换计数事实避免分配30万份DTO。
    const row = result as Record<string, unknown>
    totals.push(Number(row.global_total)); row.global_total = injected
  })
  const requests = [mobile({ rootId: f.roots[1]!.root.id, limit: 1 }), mobile({ trackId: fact.summary.track.id, limit: 1 }),
    mobile({ kind: 'members', rootId: fact.summary.asset.libraryRootId, trackId: fact.summary.track.id, limit: 1 })]
  for (const request of requests) assert.throws(() => f.makeReader().queryMobile(request), { code: 'CONTENT_LIMIT_EXCEEDED' })
  assert.deepEqual(totals, [4, 4, 4], 'global_total必须来自整个scope的分组，不能沿单根或trackId过滤')
  injected = 300_000
  assert.equal(f.makeReader().queryMobile(requests[0]!).total, 1, '边界等于30万仍允许返回完整合法页')
})


test('移动权威修订首行在同水位复用，仍跨完整屏障并隔离调用者对象', t => {
  const f = fixture(t), request = mobile({ limit: 1 })
  const first = f.reader.queryMobile(request), expected = structuredClone(first)
  Reflect.set(first.items[0]!.album, 'title', '调用者不能修改缓存')
  f.reset()
  assert.deepEqual(f.reader.queryMobile(request), expected)
  assert.equal(f.executions.filter(sql => sql.includes('FROM json_each(@compactRows)')).length, 0,
    '同一修订的权威检查不再逐次物化全库分组')
  assert.ok(f.executions.length > 0, '命中缓存也必须实际读取原SQLite水位')
  f.add(6, '新增目录', 'New album')
  const changed = f.reader.queryMobile(request)
  assert.equal(changed.total, expected.total + 1)
})

test('修订首行缓存保留库存变化、读取末屏障和撤销的拒绝', t => {
  const f = fixture(t, true), request = mobile({ limit: 1 })
  f.reader.queryMobile(request)
  f.setArtwork()
  assert.throws(() => f.reader.queryMobile(request), { code: 'SNAPSHOT_CHANGED' })
  const reader = f.makeReader(), changed = reader.queryMobile(request)
  assert.equal(changed.items[0]!.album.artworkAvailable, true)
  let once = false
  f.afterRead(sql => {
    if (!once && sql === 'SELECT total_changes() changes') {
      once = true; f.scope.revision = 'changed-during-cached-read'
    }
  })
  assert.throws(() => reader.queryMobile(request), { code: 'SNAPSHOT_CHANGED' })
  f.afterRead(undefined)
  let active = true
  f.scope.assertReadActive = () => { if (!active) throw new LocalAlbumReadError('UNAVAILABLE', '合成撤销。') }
  const current = f.makeReader(); current.queryMobile(request); active = false
  assert.throws(() => current.queryMobile(request), { code: 'UNAVAILABLE' })
})

test('手机连续分页只建立一次完整有序摘要，后续页仍逐次检查水位', t => {
  const f = fixture(t); f.reader.queryAlbums(desktop())
  const expected = f.reader.queryMobile(mobile())
  f.reset()
  const first = f.reader.queryMobile(mobile({ limit: 2 }))
  const firstScans = f.executions.filter(sql => sql.includes('FROM json_each(@compactRows)') && sql.includes('SELECT count(*) total')).length
  f.reset()
  const second = f.reader.queryMobile(mobile({ limit: 2, offset: 2 }))
  assert.deepEqual([...first.items, ...second.items], expected.items)
  assert.ok(firstScans <= 1)
  assert.equal(f.executions.filter(sql => sql.includes('FROM json_each(@compactRows)') && sql.includes('SELECT count(*) total')).length, 0,
    '第二页不能再次物化整库摘要来重新计数')
  assert.ok(f.executions.includes('SELECT total_changes() changes'), '有序位置缓存不能替代新鲜水位检查')
})

test('手机歌曲偏移复用同一SQLite顺序，跨组页不再展开全库摘要', t => {
  const f = fixture(t), expected = f.reader.queryMobile(mobile({ kind: 'members' }))
  f.reader.queryAlbums(desktop())
  f.reader.queryMobile(mobile({ kind: 'members', limit: 2 }))
  f.reset()
  const page = f.reader.queryMobile(mobile({ kind: 'members', offset: 2, limit: 3 }))
  assert.deepEqual(page.items, expected.items.slice(2, 5))
  assert.equal(page.total, 5)
  assert.equal(f.executions.filter(sql => sql.includes('FROM json_each(@compactRows)')).length, 0)
  assert.ok(f.executions.some(sql => sql.includes('page_members AS')), '真实成员关系仍由原SQL读取')
})

test('手机有序位置索引在末屏障失败后不发布，数据变化后重建新总数', t => {
  const f = fixture(t); f.reader.queryAlbums(desktop())
  let once = false
  f.afterRead(sql => {
    if (!once && sql.includes('mobile_page_groups AS')) { once = true; f.add(6, '新增', 'Album 6') }
  })
  assert.throws(() => f.reader.queryMobile(mobile({ limit: 2 })), { code: 'SNAPSHOT_CHANGED' })
  f.afterRead(undefined)
  const reader = f.makeReader(), first = reader.queryMobile(mobile({ limit: 2 }))
  assert.equal(first.total, 5)
  const remaining = reader.queryMobile(mobile({ limit: 100, offset: 2 }))
  assert.equal(remaining.total, 5)
  assert.deepEqual([...first.items, ...remaining.items].map(row => row.album.title), ['Album 1', 'Album 2', 'Album 6', 'Album 10', 'Other 3'])
})
