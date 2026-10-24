import assert from 'node:assert/strict'
import test from 'node:test'
import { largeMobileFixture, mobileMembers, syntheticId } from './local-album-mobile-large-fixture.js'

function addEditions(f: ReturnType<typeof largeMobileFixture>, count: number): void {
  const edition = syntheticId(7100000)
  f.db.prepare('INSERT INTO local_catalog_editions VALUES(?,?)').run(edition, JSON.stringify({ id: edition, title: '仅发行标题命中', edition: '仅发行版本命中', revision: '1' }))
  const insert = f.db.prepare('INSERT INTO local_catalog_edition_tracks VALUES(?,?,?,?)')
  for (let index = 1; index <= count; index++) {
    const id = syntheticId(7200000 + index), trackId = syntheticId(1000000 + index)
    insert.run(id, edition, trackId, JSON.stringify({ id, editionId: edition, trackId, sequence: index, active: true, revision: '1', disc: 1, trackNumber: index }))
  }
}

function planFor(f: ReturnType<typeof largeMobileFixture>, sql: string, query: string): Record<string, unknown>[] {
  const statement = f.db.prepare('EXPLAIN QUERY PLAN ' + sql)
  statement.setAllowUnknownNamedParameters(true)
  return statement.all({ ...mobileMembers({ query }), root: null, sourceRaw: '[]', hintDirectory: null,
    hintPrefix: null, hintUpper: null, cuePayloads: null, names: '[]', artwork: '[]', lyricsRevision: null })
}

function nestedSearchLinkScans(plan: Record<string, unknown>[]): number {
  const rows = new Map(plan.map(row => [Number(row.id), row]))
  return plan.filter(row => {
    if (!/SCAN search_link(?:\s|$)/u.test(String(row.detail))) return false
    let parent = rows.get(Number(row.parent))
    while (parent) {
      if (String(parent.detail).includes('CORRELATED')) return true
      parent = rows.get(Number(parent.parent))
    }
    return false
  }).length
}

test('非空零命中搜索只执行一次完整事实SQL，仍核全scope与首末屏障', { timeout: 120000 }, t => {
  const f = largeMobileFixture({ groups: 2048, singles: 0, members: 2 }); t.after(() => f.close())
  f.warm(); f.reset()
  const page = f.reader.queryMobile(mobileMembers({ query: '合成零命中标记Ω' }))
  assert.equal(page.total, 0); assert.deepEqual(page.items, [])
  const full = f.queries.filter(row => row.sql.includes('source_rows AS MATERIALIZED'))
  t.diagnostic(JSON.stringify({ synthetic: true, tracks: 4096, fullStatements: full.length, counters: f.counters }))
  assert.equal(full.length, 1, '总数已为零，不能再次执行完整事实CTE以取得已证明为空的页')
  for (const barrier of ['SELECT total_changes() changes', 'PRAGMA data_version', 'PRAGMA schema_version']) {
    assert.ok(f.queries.filter(row => row.sql === barrier).length >= 2)
  }
})

test('非空搜索的发行候选只建一次集合，不按每首歌相关扫描发行关系', { timeout: 120000 }, t => {
  const count = 1024, query = '合成零命中标记Ω'
  const f = largeMobileFixture({ groups: count, singles: 0, members: 1 }); t.after(() => f.close())
  addEditions(f, count); f.warm(); f.reset()
  let visits = 0
  // 只在合成fixture计数；同时另核未插入计数器的原SQL计划，不能将注入后的耗时当生产CPU。
  f.db.function('mb70_link_visit', { deterministic: false }, (id: unknown) => { visits++; return String(id) })
  const prepare = f.db.prepare
  f.db.prepare = function (sql: string) {
    return prepare.call(this, sql.includes('JOIN source_metadata mobile_metadata')
      ? sql.replaceAll('search_link.track_id', 'mb70_link_visit(search_link.track_id)') : sql)
  }
  const page = f.makeReader().queryMobile(mobileMembers({ query }))
  assert.equal(page.total, 0); assert.deepEqual(page.items, [])
  const selected = f.queries.find(row => row.sql.includes('global_total') && row.sql.includes('JOIN source_metadata mobile_metadata'))!
  assert.ok(selected)
  const original = selected.sql.replaceAll('mb70_link_visit(search_link.track_id)', 'search_link.track_id')
  const plan = planFor(f, original, query), correlatedScans = nestedSearchLinkScans(plan)
  t.diagnostic(JSON.stringify({ synthetic: true, tracks: count, activeEditionLinks: count, visits, correlatedScans,
    searchPlan: plan.filter(row => /search_link|SUBQUERY/u.test(String(row.detail))) }))
  assert.equal(correlatedScans, 0, '原SQL计划不能在每首歌的相关子查询内扫描发行关系表')
  assert.ok(visits <= count * 2, '候选集合最多按完整SQL次数线性读取，不能变成轨数乘发行关系数')
})

test('raw/effective及发行标题版本的搜索域、分页和重复关系均保留', t => {
  const f = largeMobileFixture({ groups: 8, singles: 0, members: 2 }); t.after(() => f.close())
  addEditions(f, 4)
  const first = syntheticId(1000001)
  f.raw.get(first)!.fields.title = '原始独占标签'
  f.db.prepare('INSERT INTO local_catalog_overrides VALUES(?,?)').run(first, JSON.stringify({ trackId: first, revision: '1', fields: { title: '覆盖独占标签' } }))
  const reader = f.makeReader()
  for (const query of ['原始独占标签', '覆盖独占标签']) {
    const page = reader.queryMobile(mobileMembers({ query }))
    assert.equal(page.total, 1); assert.equal(page.items[0]!.member!.fact.summary.track.id, first)
  }
  for (const query of ['仅发行标题命中', '仅发行版本命中']) {
    const page = reader.queryMobile(mobileMembers({ query, offset: 1, limit: 2 }))
    assert.equal(page.total, 4); assert.equal(page.items.length, 2)
    assert.deepEqual(page.items.map(row => row.member!.fact.summary.track.id), [syntheticId(1000002), syntheticId(1000003)])
    assert.equal(reader.queryMobile(mobileMembers({ query, offset: 4 })).items.length, 0)
  }
  f.db.prepare('UPDATE local_catalog_edition_tracks SET data=json_set(data,\'$.active\',0) WHERE track_id=?').run(first)
  const next = f.makeReader().queryMobile(mobileMembers({ query: '仅发行标题命中' }))
  assert.equal(next.total, 3); assert.ok(next.items.every(row => row.member!.fact.summary.track.id !== first))
})

test('重复候选ID不会放大原活动发行成员，失活关系不再参与匹配', t => {
  const f = largeMobileFixture({ groups: 8, singles: 0, members: 1 }); t.after(() => f.close())
  addEditions(f, 8)
  const id = syntheticId(7300000), link = syntheticId(7300001), first = syntheticId(1000001)
  f.db.prepare('INSERT INTO local_catalog_editions VALUES(?,?)').run(id, JSON.stringify({ id, title: '仅发行标题命中', edition: '仅发行版本命中', revision: '1' }))
  f.db.prepare('INSERT INTO local_catalog_edition_tracks VALUES(?,?,?,?)').run(link, id, first,
    JSON.stringify({ id: link, editionId: id, trackId: first, sequence: 1, active: true, revision: '1', disc: 1, trackNumber: 1 }))
  const page = f.makeReader().queryMobile(mobileMembers({ query: '仅发行标题命中' }))
  assert.equal(page.total, 9)
  assert.equal(page.items.filter(row => row.member!.fact.summary.track.id === first).length, 2)
  assert.equal(new Set(page.items.map(row => row.member!.fact.summary.track.id)).size, 8)
})

test('零命中省略页SQL后仍拒绝同读内水位变化和撤销', t => {
  for (const kind of ['physical', 'scope', 'revoke'] as const) {
    const f = largeMobileFixture({ groups: 16, singles: 0, members: 2 }); t.after(() => f.close())
    f.warm(); f.reset(); let once = false
    f.afterSql(sql => {
      if (once || !sql.includes('global_total') || !sql.includes('source_rows AS MATERIALIZED')) return
      once = true
      if (kind === 'scope') f.scope.revision = '合成查询中变更'
      else if (kind === 'revoke') f.revoke()
      else f.add(100, 0, '合成新增目录')
    })
    assert.throws(() => f.reader.queryMobile(mobileMembers({ query: '合成零命中标记Ω' })),
      { code: kind === 'revoke' ? 'UNAVAILABLE' : 'SNAPSHOT_CHANGED' })
  }
})

test('8.2万轨非空零命中只物化一份完整事实，工作量不随空页再倍增', { timeout: 120000 }, t => {
  const f = largeMobileFixture(); t.after(() => f.close())
  assert.equal(f.warm().total, 10000); f.reset()
  const began = performance.now(), page = f.reader.queryMobile(mobileMembers({ query: '合成零命中标记Ω' }))
  assert.equal(page.total, 0); assert.deepEqual(page.items, [])
  const full = f.queries.filter(row => row.sql.includes('source_rows AS MATERIALIZED'))
  t.diagnostic(JSON.stringify({ synthetic: true, tracks: 82000, albums: 10000, fullStatements: full.length,
    elapsedMs: performance.now() - began, counters: f.counters }))
  assert.equal(full.length, 1)
  assert.ok(f.counters.source <= 82000 * 2, '只核一份当前完整来源，不能为已知空页重复读取')
})

test('非空搜索每份事实SQL仅计算一次Source字段，跨界访问不超过2N', t => {
  const count = 1024, f = largeMobileFixture({ groups: count, singles: 0, members: 1 }); t.after(() => f.close())
  f.warm(); f.reset()
  const page = f.reader.queryMobile(mobileMembers({ query: '合成零命中标记Ω' }))
  assert.equal(page.total, 0); assert.deepEqual(page.items, [])
  t.diagnostic(JSON.stringify({ synthetic: true, tracks: count, sourceCalls: f.counters.source,
    ordinalCalls: f.udf.mb_album_source_ordinal ?? 0, fieldsCalls: f.udf.mb_album_source_fields ?? 0 }))
  assert.ok(f.counters.source >= count, '每次仍实际读取当前Source，不能把结果缓存当减少跨界')
  assert.ok(f.counters.source <= count * 2, '一个Source位置和一份完整字段足够，不能为12个表达式重复跨入JS序列化')
})

test('带结果搜索的count和page各自只读取一份Source，原排序与事实仍返回', t => {
  const count = 1024, f = largeMobileFixture({ groups: count, singles: 0, members: 1 }); t.after(() => f.close())
  f.warm(); f.reset()
  const page = f.reader.queryMobile(mobileMembers({ query: '原曲1', limit: 10 }))
  assert.ok(page.total > 10); assert.equal(page.items.length, 10)
  const full = f.queries.filter(row => row.sql.includes('source_rows AS MATERIALIZED'))
  assert.equal(full.length, 2)
  t.diagnostic(JSON.stringify({ synthetic: true, tracks: count, fullStatements: full.length, sourceCalls: f.counters.source,
    ordinalCalls: f.udf.mb_album_source_ordinal ?? 0, fieldsCalls: f.udf.mb_album_source_fields ?? 0 }))
  assert.ok(f.counters.source >= count * full.length)
  assert.ok(f.counters.source <= count * 2 * full.length)
  assert.ok(f.counters.track >= 10 && f.counters.asset >= 10 && f.counters.scan >= 10)
})
