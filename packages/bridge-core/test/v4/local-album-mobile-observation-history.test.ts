import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { largeMobileFixture, mobileMembers, syntheticId } from './local-album-mobile-large-fixture.js'

test('8.2万轨暖页的已覆盖旧观察不为每个标签重扫一万条后续ledger', { timeout: 120000 }, t => {
  const f = largeMobileFixture({ observations: true }); t.after(() => f.close())
  let ledgerVisits = 0, pointProbes = 0
  // 恒真计数只用于合成SQL工作量；可能影响计划/耗时，不能冒称生产稳态CPU。
  f.db.function('mb_history_visit', { deterministic: false }, (_rowid: unknown) => { ledgerVisits++; return 1 })
  f.db.function('mb_history_point', { deterministic: false }, (_rowid: unknown) => { pointProbes++; return 1 })
  const original = "AND l.operation='observe-metadata'"
  assert.ok(f.source.projectionSql.includes(original))
  f.source.projectionSql = f.source.projectionSql.replaceAll(original, "AND mb_history_visit(l.rowid)=1 AND l.operation='observe-metadata'")
    .replaceAll('WHERE l.rowid>sf.ordinal ORDER BY l.rowid LIMIT 1', 'WHERE l.rowid>sf.ordinal AND mb_history_point(l.rowid)=1 ORDER BY l.rowid LIMIT 1')
  let reader = f.makeReader()
  assert.equal(reader.queryMobile(mobileMembers({ kind: 'groups' })).total, 10000)
  f.reset(); ledgerVisits = 0; pointProbes = 0
  const controlBegan = performance.now(), control = reader.queryMobile(mobileMembers()), controlMs = performance.now() - controlBegan
  const controlVisits = ledgerVisits, controlPoints = pointProbes, controlCounters = { ...f.counters }
  const controlSqlMs = f.queries.filter(q => q.sql.includes('page_members AS MATERIALIZED')).map(q => q.elapsedMs)
  assert.equal(control.total, 82000); assert.equal(control.items.length, 100)
  f.reset(); ledgerVisits = 0; pointProbes = 0
  const repeatedBegan = performance.now(), repeated = reader.queryMobile(mobileMembers()), repeatedMs = performance.now() - repeatedBegan
  assert.deepEqual(repeated, control)
  const repeatedControl = { elapsedMs: repeatedMs, ledgerVisits, pointProbes, counters: { ...f.counters },
    sqlMs: f.queries.filter(q => q.sql.includes('page_members AS MATERIALIZED')).map(q => q.elapsedMs) }
  assert.ok(f.counters.source > 0 && f.counters.track >= 100 && f.counters.scan >= 100, '同参数再次读取也实核Source/codec/scan，不能拿整页结果缓存冒充语句复用')
  // 只有本页100首有被新Source覆盖的旧观察；剩余81900首仍沿原立即命中分布。
  const stale = f.db.prepare('UPDATE local_catalog_observations SET data=? WHERE id=?')
  const insert = f.db.prepare('INSERT INTO local_catalog_ledger(rowid,command_id,fingerprint,operation,request,result,created_at) VALUES(?,?,?,?,?,?,?)')
  f.observe(false); f.db.exec('BEGIN')
  try {
    for (let n = 1; n <= 100; n++) {
      const trackId = syntheticId(1000000 + n), current = f.raw.get(trackId)!
      current.ordinal = 164001
      stale.run(JSON.stringify({ id: syntheticId(3000000 + n), trackId, fields: { ...current.fields, title: `已覆盖旧标题${n}` } }), syntheticId(3000000 + n))
    }
    for (let n = 1; n <= 10000; n++) insert.run(164001 + n, syntheticId(8000000 + n), 'synthetic', 'observe-metadata', '{}', JSON.stringify({ id: syntheticId(9000000 + n) }), '2026-10-21T00:00:00.000Z')
    f.db.exec('COMMIT')
  } catch (error) { f.db.exec('ROLLBACK'); throw error }
  reader = f.makeReader()
  assert.equal(reader.queryMobile(mobileMembers({ kind: 'groups' })).total, 10000)
  f.reset(); f.capturePlan(); ledgerVisits = 0; pointProbes = 0
  const began = performance.now(), actual = reader.queryMobile(mobileMembers()), elapsedMs = performance.now() - began
  assert.deepEqual(actual, control, 'Source覆盖的旧观察不可重新覆盖当前标签，全部DTO和顺序仍相等')
  const plan = f.plan(); assert.ok(plan)
  const details = plan.plan.map(row => String(row.detail))
  t.diagnostic(JSON.stringify({ synthetic: true, sqlOnly: true, tracks: 82000, albums: 10000, roots: 6, rows: 100, suffixRows: 10000,
    control: { elapsedMs: controlMs, ledgerVisits: controlVisits, pointProbes: controlPoints, counters: controlCounters, sqlMs: controlSqlMs },
    repeatedControl,
    coveredHistory: { elapsedMs, ledgerVisits, pointProbes, counters: f.counters,
      sqlMs: f.queries.filter(q => q.sql.includes('page_members AS MATERIALIZED')).map(q => q.elapsedMs),
      correlatedSubqueries: details.filter(detail => detail.includes('CORRELATED SCALAR SUBQUERY')).length,
      ledgerRowidRangeSearches: details.filter(detail => detail.includes('SEARCH l USING INTEGER PRIMARY KEY (rowid>?)')).length,
      firstRowFastPaths: details.filter(detail => detail.includes('CO-ROUTINE first_observation')).length },
    outputSha256: createHash('sha256').update(JSON.stringify(actual)).digest('hex') }))
  assert.ok(f.counters.track >= 100 && f.counters.asset >= 100 && f.counters.scan >= 100 && f.counters.bounded >= 100)
  assert.ok(ledgerVisits <= 10000, '同一暖页最多扫描一次10000条后缀，不能按100个旧观察和各字段重复扫描')
  assert.ok(pointProbes <= 1200, '正向首行证明每字段只实读一行，不能把未命中首行当作负面结论')
  assert.ok(controlVisits <= 1200 && controlPoints <= 1200, '立即命中的原分布不能改为全后缀扫描')
})

test('查询内观察集合按每个Source序号核原先后，逐字段/null/override/无SF等同旧投影', t => {
  function pages(legacyProjection: boolean) {
    const f = largeMobileFixture({ groups: 24, singles: 0, members: 5, observations: true, legacyProjection }); t.after(() => f.close())
    const observe = f.db.prepare('INSERT INTO local_catalog_observations VALUES(?,?,?)')
    const event = f.db.prepare('INSERT INTO local_catalog_ledger(rowid,command_id,fingerprint,operation,request,result,created_at) VALUES(?,?,?,?,?,?,?)')
    let serial = 0
    const add = (n: number, ordinal: number, fields: Record<string, string | null>, operation = 'observe-metadata', sameId = true) => {
      const id = syntheticId(5000000 + ++serial), trackId = syntheticId(1000000 + n)
      observe.run(id, trackId, JSON.stringify({ id, trackId, fields }))
      event.run(ordinal, syntheticId(6000000 + serial), 'synthetic', operation, '{}', JSON.stringify({ id: sameId ? id : syntheticId(7000000 + serial) }), '2026-10-21T00:00:00.000Z')
    }
    for (let n = 1; n <= 8; n++) {
      const anchor = 1000 + n * 20
      f.raw.get(syntheticId(1000000 + n))!.ordinal = anchor
      add(n, anchor - 1, { title: `Source前${n}`, artist: '不应覆盖当前来源' })
      add(n, anchor, { album: '与Source同时也不能覆盖' })
      add(n, anchor + 2, { title: `较后ledger先插入${n}` })
      add(n, anchor + 1, { title: `观察后插入${n}` })
      add(n, anchor + 3, { artist: `原观察艺人${n}` })
      add(n, anchor + 4, { album: `原观察专辑${n}` })
      add(n, anchor + 5, { title: '其他operation不能充作观察' }, 'override-metadata')
      add(n, anchor + 6, { title: '其他result id不能充作观察' }, 'observe-metadata', false)
      if (n === 1 || n === 4) add(n, anchor + 7, { title: null, artist: null })
    }
    // SQL层显式null仍按原COALESCE语义；这不是准许持久DTO写入null字段。
    f.db.prepare('INSERT INTO local_catalog_overrides VALUES(?,?)').run(syntheticId(1000001),
      JSON.stringify({ trackId: syntheticId(1000001), revision: '1', fields: { title: '手动标题', artist: null } }))
    f.db.prepare('INSERT INTO local_catalog_overrides VALUES(?,?)').run(syntheticId(1000002),
      JSON.stringify({ trackId: syntheticId(1000002), revision: '1', fields: null }))
    f.raw.delete(syntheticId(1000003))
    const reader = f.makeReader(), inputs = [mobileMembers(), mobileMembers({ offset: 100 }), mobileMembers({ query: '观察', limit: 30 })]
    const cold = inputs.map(input => reader.queryMobile(input))
    reader.queryMobile(mobileMembers({ kind: 'groups' })); f.reset()
    const warm = inputs.map(input => reader.queryMobile(input))
    assert.deepEqual(warm, cold, 'Source集合不改变冷完整SQL与暖目录计划的语义')
    const rows = cold.flatMap(page => page.items).filter(row => row.member !== null)
    const first = rows.find(row => row.member!.fact.summary.track.id === syntheticId(1000001))!.member!.fact
    assert.equal(first.rawMetadata.title, '原曲1'); assert.equal(first.rawMetadata.artist, '合成艺人0')
    assert.equal(first.summary.metadata.title, '手动标题'); assert.equal(first.summary.metadata.artist, '合成艺人0')
    assert.equal(rows.find(row => row.member!.fact.summary.track.id === syntheticId(1000002))!.member!.fact.rawMetadata.title, '观察后插入2')
    assert.equal(rows.find(row => row.member!.fact.summary.track.id === syntheticId(1000003))!.member!.fact.rawMetadata.title, '其他result id不能充作观察')
    assert.ok(f.counters.track >= 100 && f.counters.asset >= 100 && f.counters.scan >= 100 && f.counters.bounded >= 100)
    return { cold, warm }
  }
  assert.deepEqual(pages(false), pages(true), '使用真实生产SQL常量与冻结旧表达式逐字段差分')
})

test('观察集合不越过本次Source变化与末SQL水位，失败后仍重新读取', t => {
  for (const legacyProjection of [true, false]) {
    const f = largeMobileFixture({ groups: 24, singles: 0, members: 5, observations: true, legacyProjection }); t.after(() => f.close())
    f.warm(); f.reset(); let changed = false
    f.afterSource(() => {
      if (changed) return
      changed = true
      const current = f.raw.get(syntheticId(1000001))!
      f.db.prepare('INSERT INTO local_catalog_ledger(rowid,command_id,fingerprint,operation,request,result,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(1000, syntheticId(9900000), 'synthetic', 'source-writes', '{}', '{}', '2026-10-21T00:00:00.000Z')
      current.ordinal = 1000; current.fields = { ...current.fields, title: '本次Source改变' }
    })
    assert.throws(() => f.reader.queryMobile(mobileMembers()), { code: 'SNAPSHOT_CHANGED' })
    f.afterSource(); const reader = f.makeReader(), expected = reader.queryMobile(mobileMembers())
    reader.queryMobile(mobileMembers({ kind: 'groups' })); f.reset()
    assert.deepEqual(reader.queryMobile(mobileMembers()), expected)
    assert.ok(f.counters.source > 0 && f.counters.scan >= 100)
  }
})
