import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { largeMobileFixture, mobileMembers, syntheticId } from './local-album-mobile-large-fixture.js'

function addRejectedCue(f: ReturnType<typeof largeMobileFixture>, group = 0): void {
  const root = f.roots[group % f.roots.length]!.root
  const cue = { id: syntheticId(90000 + group), sidecarId: syntheticId(91000 + group), libraryRootId: root.id,
    sourceRootId: root.sourceRootId, rootRevision: '1', item: { relative: `目录😀${group}/原侧车.cue`, signature: '合成侧车',
      parserVersion: 'cue-text-75fps/mbrs003-v1', outcome: 'rejected', failureCode: 'CUE_PARSE_FAILED',
      reused: false, previousSnapshotId: null, result: null } }
  f.db.prepare('INSERT INTO local_cue_sources VALUES(?,?,?)').run(root.id, cue.item.relative, JSON.stringify(cue))
}

test('8.2万轨单个大专辑的100行不再扫描该根全部Source候选', { timeout: 120000 }, t => {
  const f = largeMobileFixture({ observations: true }); t.after(() => f.close())
  const expectedIds = [syntheticId(1000001)]
  for (let index = 1; index < 200; index++) {
    const row = f.add(0, index)
    if (index < 100) expectedIds.push(row.track.id)
  }
  assert.equal(f.warm().total, 10000); f.reset(); f.capturePlan()
  const began = performance.now(), page = f.reader.queryMobile(mobileMembers())
  assert.equal(page.total, 82199); assert.deepEqual(page.items.map(row => row.member!.fact.summary.track.id), expectedIds)
  t.diagnostic(JSON.stringify({ synthetic: true, tracks: page.total, albums: 10000, rows: page.items.length,
    elapsedMs: performance.now() - began, rootCalls: f.udf.mb_album_root ?? 0,
    counters: f.counters, sqlMs: f.queries.filter(q => q.sql.includes('page_members AS MATERIALIZED')).map(q => q.elapsedMs),
    outputSha256: createHash('sha256').update(JSON.stringify(page)).digest('hex') }))
  assert.ok((f.udf.mb_album_root ?? 0) <= 2000, '单目录仍须完整证明，但不能每页再遍历同根所有Source候选')
  assert.ok(f.counters.track >= 100 && f.counters.asset >= 100 && f.counters.scan >= 100 && f.counters.bounded >= 100)
  for (const barrier of ['SELECT total_changes() changes', 'PRAGMA data_version', 'PRAGMA schema_version']) {
    assert.ok(f.queries.filter(q => q.sql === barrier).length >= 2, '首末物理水位仍每次实读')
  }
})

test('8.2万轨已核CUE的双目录合并保留事件与100行完整事实，仅定位本页目录', { timeout: 120000 }, t => {
  const f = largeMobileFixture(); t.after(() => f.close())
  const ids: string[][] = [[syntheticId(1000001)], [syntheticId(1000002)]]
  for (let group = 0; group < 2; group++) for (let index = 1; index < 60; index++) ids[group]!.push(f.add(group, index).track.id)
  addRejectedCue(f)
  assert.equal(f.warm().total, 10000); f.reset()
  const began = performance.now(), page = f.reader.queryMobile(mobileMembers())
  assert.equal(page.total, 82118)
  assert.deepEqual(page.items.map(row => row.member!.fact.summary.track.id), [...ids[0]!, ...ids[1]!.slice(0, 40)])
  assert.ok(page.items.slice(0, 60).every(row => row.album.statuses.includes('cue-unsplit')))
  assert.equal(f.queries.some(q => q.sql.includes('mobile_plans AS MATERIALIZED')), true, '已核同目录CUE仅合并计划，原事实和事件闭包不变')
  t.diagnostic(JSON.stringify({ synthetic: true, tracks: page.total, albums: 10000, rows: page.items.length,
    elapsedMs: performance.now() - began, rootCalls: f.udf.mb_album_root ?? 0, counters: f.counters,
    outputSha256: createHash('sha256').update(JSON.stringify(page)).digest('hex') }))
  assert.ok((f.udf.mb_album_root ?? 0) <= 2000, '含CUE不应退回重复扫描整根Source候选')
  assert.ok(f.counters.track >= 100 && f.counters.asset >= 100 && f.counters.scan >= 100 && f.counters.bounded >= 100)
})

test('单目录/CUE/直属散曲和负面扫描事件逐字段等同完整SQL，组织仍走原路径', t => {
  for (const role of ['plain', 'cue', 'artist', 'album'] as const) {
    const f = largeMobileFixture({ groups: 0 }); t.after(() => f.close())
    for (let group = 0; group < 18; group++) for (let index = 0; index < 7; index++) f.add(group, index,
      group < 2 ? '' : group < 4 ? '共享😀目录' : group % 2 ? `A😀/B${group}` : `A😀/B${group}前缀`)
    if (role === 'cue') addRejectedCue(f, 5)
    if (role === 'artist' || role === 'album') {
      const root = f.roots[0]!.root
      f.scope.libraryOrganizations = [{ datasetId: syntheticId(900), rootId: root.id, sourceRootId: root.sourceRootId,
        rootRevision: '1', bindingRevision: 1, recordSha256: 'a'.repeat(64), role, rootName: '合成组织', parentName: '合成上层' }]
    }
    const first = f.db.prepare('SELECT * FROM local_scan_file_state ORDER BY relative LIMIT 1').get()!
    assert.equal(typeof first.library_root_id, 'string')
    if (typeof first.library_root_id !== 'string') throw new Error('合成扫描根身份无效')
    const raw = JSON.parse(String(first.data)), relative = String(first.relative).replace(/[^/]+$/u, '拒收文件.flac')
    f.db.prepare('INSERT INTO local_scan_file_state VALUES(?,?,?,?,?)').run(first.library_root_id, relative, null, null,
      JSON.stringify({ ...raw, relative, outcome: 'rejected', assetId: null, trackId: null, readFacts: null, failureCode: 'PARSE_FAILED' }))
    const reader = f.makeReader(), firstGroup = reader.queryMobile(mobileMembers()).items[0]!
    const inputs = [mobileMembers({ offset: 0 }), mobileMembers({ offset: 2, limit: 3 }), mobileMembers({ offset: 100 }),
      mobileMembers({ offset: 126 }), mobileMembers({ rootId: firstGroup.album.rootId, albumKey: firstGroup.album.id, limit: 5 }),
      mobileMembers({ trackId: syntheticId(1000001), limit: 1 }), mobileMembers({ query: '原曲1', limit: 5 })]
    // 新reader尚无Compact，先留原完整事实SQL结果；不能把相同优化结果互相比作差分。
    const original = inputs.map(input => reader.queryMobile(input))
    reader.queryMobile(mobileMembers({ kind: 'groups' })); f.reset()
    assert.deepEqual(inputs.map(input => reader.queryMobile(input)), original)
    if (role === 'artist' || role === 'album') assert.equal(f.queries.some(q => q.sql.includes('mobile_directory_assets AS MATERIALIZED')), false)
  }
})

test('目录回退仍执行每次Source和首末水位；变化/撤销/codec失败整页拒绝且不缓存失败', t => {
  for (const failure of ['physical', 'scope', 'revoke', 'codec'] as const) {
    const f = largeMobileFixture({ groups: 3, singles: 0, members: 120 }); t.after(() => f.close())
    let once = false, failCodec = false
    if (failure === 'codec') {
      const original = f.codec.track
      // 先安装本次真实作者；不能换作者后误把原围栏拒绝当作codec抛错覆盖。
      f.codec.track = row => { if (failCodec && !once) { once = true; throw new Error('合成codec拒绝') }; return original(row) }
    }
    const initial = f.makeReader()
    initial.queryMobile(mobileMembers({ kind: 'groups' })); f.reset()
    if (failure === 'revoke') f.afterSource(() => f.revoke())
    else if (failure === 'codec') failCodec = true
    else f.afterSql(sql => {
      if (!once && sql.includes('page_members AS MATERIALIZED')) {
        once = true
        if (failure === 'physical') f.add(50, 0, '后来目录')
        else f.scope.revision = 'scope-changed-during-read'
      }
    })
    assert.throws(() => initial.queryMobile(mobileMembers()), {
      code: failure === 'revoke' || failure === 'codec' ? 'UNAVAILABLE' : 'SNAPSHOT_CHANGED',
    })
    if (failure === 'codec') assert.equal(once, true, '必须真正执行codec注入失败，而非被作者变化先行拦截')
    if (failure === 'revoke') continue
    f.afterSql(); f.scope.revision = 'scope-new-reader'
    const reader = f.makeReader(), expected = reader.queryMobile(mobileMembers())
    reader.queryMobile(mobileMembers({ kind: 'groups' })); f.reset()
    assert.deepEqual(reader.queryMobile(mobileMembers()), expected)
    assert.ok(f.counters.source > 0 && f.counters.scan >= 100, '失败后的新读取仍读取当前Source与逐行扫描事实')
  }
})
