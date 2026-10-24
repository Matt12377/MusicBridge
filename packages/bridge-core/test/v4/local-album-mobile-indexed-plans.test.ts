import assert from 'node:assert/strict'
import test from 'node:test'
import { largeMobileFixture, mobileMembers, syntheticId } from './local-album-mobile-large-fixture.js'
import { isMobileOwnerPrivateResult } from '../../src/mobile/owner-protocol.js'
import type { LocalAlbumSqlMobilePage } from '../../src/collection/local-album-browser/sql-types.js'

test('8.2万轨多根暖页只筛本页目录，不重复两遍全域root谓词；Owner双读保完整DTO和事实', { timeout: 120000 }, async t => {
  const f = largeMobileFixture({ observations: true }); t.after(() => f.close())
  assert.equal(f.tracks, 82000); assert.equal(f.warm().total, 10000)
  for (const offset of [0, 4700, 81900, 82000]) {
    f.reset()
    const actual = f.reader.queryMobile(mobileMembers({ offset }))
    assert.equal(actual.total, 82000)
    assert.deepEqual(actual.items.map(row => row.member!.fact.summary.track.id), Array.from({ length: Math.min(100, 82000 - offset) }, (_, i) => syntheticId(1000000 + offset + i + 1)))
    assert.ok((f.udf.mb_album_root ?? 0) <= 1000, '已核少量目录必须由原位置索引定位，不能对82000行再做两遍全域root筛选')
    assert.ok(f.counters.track >= actual.items.length && f.counters.asset >= actual.items.length && f.counters.scan >= actual.items.length && f.counters.bounded >= actual.items.length, '本页完整原codec/扫描证明仍逐行执行')
    for (const barrier of ['SELECT total_changes() changes', 'PRAGMA data_version', 'PRAGMA schema_version']) assert.ok(f.queries.filter(q => q.sql === barrier).length >= 2, '每页仍实读首末SQLite水位')
  }
  f.reset()
  const input = f.ownerRequest({ offset: 4700 }), first = await f.owner.dispatch(input)
  assert.equal(isMobileOwnerPrivateResult(first, input), true); assert.ok('items' in first)
  const secondInput = f.ownerRequest({ offset: 4700, expectedRevision: first.libraryRevision }), second = await f.owner.dispatch(secondInput)
  assert.equal(isMobileOwnerPrivateResult(second, secondInput), true); assert.deepEqual(second, first)
  assert.equal(first.items.length, 100); assert.equal(f.ownerCounters.detail, 200); assert.equal(f.ownerCounters.parameters, 200)
  assert.equal(f.ownerCounters.root, 200); assert.equal(f.ownerCounters.source, 200)
  assert.ok(f.counters.scan >= 200, '第二次Owner读取不能跳过当前事实')
  assert.ok((f.udf.mb_album_root ?? 0) <= 2000)
})

test('索引目录首中尾、中文非BMP和前缀相邻目录逐字段等同原完整SQL', t => {
  const f = largeMobileFixture({ groups: 0 }); t.after(() => f.close())
  for (let group = 0; group < 32; group++) for (let n = 0; n < (group < 3 ? 1 : 5); n++) f.add(group, n,
    group < 3 ? '' : group < 8 ? '共享😀目录' : group % 2 ? `A😀/B${group}` : `A😀/B${group}前缀`)
  const inputs = [0, 2, 97, 100, 146, 148, 180].map(offset => mobileMembers({ offset }))
  const original = inputs.map(input => f.reader.queryMobile(input)); f.warm(); f.reset()
  assert.deepEqual(inputs.map(input => f.reader.queryMobile(input)), original)
  assert.ok(f.queries.some(q => q.sql.includes('mobile_plans AS MATERIALIZED')))
})

test('物理水位/Source/权限在本次查询内变化仍整页拒绝，失败不保留部分结果', t => {
  for (const kind of ['physical', 'scope', 'revoke'] as const) {
    const f = largeMobileFixture({ groups: 24, singles: 0, members: 5 }); t.after(() => f.close())
    f.warm(); f.reset(); let once = false
    if (kind === 'revoke') f.afterSource(() => f.revoke())
    else f.afterSql(sql => { if (!once && sql.includes('mobile_plans AS MATERIALIZED')) { once = true
      if (kind === 'scope') f.scope.revision = 'scope-changed-during-read'
      else f.add(500, 0, '新目录')
    } })
    assert.throws(() => f.reader.queryMobile(mobileMembers()), { code: kind === 'revoke' ? 'UNAVAILABLE' : 'SNAPSHOT_CHANGED' })
    if (kind !== 'revoke') {
      f.afterSql(); f.scope.revision = 'scope-new-reader'; const next = f.makeReader(), input = mobileMembers()
      const expected = next.queryMobile(input); next.queryMobile({ ...input, kind: 'groups' })
      assert.deepEqual(next.queryMobile(input), expected)
    }
  }
})

test('含拒收扫描事件和同位置多资产时保留原负面事实与拒绝语义', t => {
  const f = largeMobileFixture({ groups: 24, singles: 0, members: 5 }); t.after(() => f.close())
  const selected = f.db.prepare('SELECT library_root_id,relative,data FROM local_scan_file_state ORDER BY relative LIMIT 1').get()!
  assert.ok(typeof selected.library_root_id === 'string' && typeof selected.relative === 'string')
  const raw = JSON.parse(String(selected.data)); raw.outcome = 'rejected'; raw.assetId = null; raw.trackId = null; raw.readFacts = null; raw.failureCode = 'PARSE_FAILED'
  f.db.prepare('INSERT INTO local_scan_file_state VALUES(?,?,?,?,?)').run(selected.library_root_id, String(selected.relative).replace(/[^/]+$/u, '拒收文件.flac'), null, null, JSON.stringify({ ...raw, relative: String(selected.relative).replace(/[^/]+$/u, '拒收文件.flac') }))
  const input = mobileMembers(), expected = f.reader.queryMobile(input); f.warm(); f.reset()
  assert.deepEqual(f.reader.queryMobile(input), expected)
  const asset = f.db.prepare('SELECT * FROM local_catalog_assets ORDER BY relative LIMIT 1').get()!, clone = JSON.parse(String(asset.data)); clone.id = syntheticId(9900000)
  assert.ok(typeof asset.root_id === 'string' && typeof asset.source_root_id === 'string' && typeof asset.relative === 'string')
  f.db.prepare('INSERT INTO local_catalog_assets VALUES(?,?,?,?,?,?)').run(clone.id, asset.root_id, asset.source_root_id, asset.relative, null, JSON.stringify(clone))
  const next = f.makeReader(); assert.throws(() => next.queryMobile(input), { code: 'UNAVAILABLE' })
})

test('已核同目录CUE可合并、artist/album仍fallback，同一SQL作者失效不复用旧页', t => {
  for (const role of ['cue', 'artist', 'album'] as const) {
    const f = largeMobileFixture({ groups: 16, singles: 0, members: 3 }); t.after(() => f.close())
    const root = f.roots[0]!.root
    if (role === 'cue') {
      const cue = { id: syntheticId(90000), sidecarId: syntheticId(90001), libraryRootId: root.id, sourceRootId: root.sourceRootId, rootRevision: '1', item: {
        relative: '目录😀0/原侧车.cue', signature: '合成侧车', parserVersion: 'cue-text-75fps/mbrs003-v1', outcome: 'rejected', failureCode: 'CUE_PARSE_FAILED', reused: false, previousSnapshotId: null, result: null } }
      f.db.prepare('INSERT INTO local_cue_sources VALUES(?,?,?)').run(root.id, cue.item.relative, JSON.stringify(cue))
    } else f.scope.libraryOrganizations = [{ datasetId: syntheticId(900), rootId: root.id, sourceRootId: root.sourceRootId, rootRevision: '1', bindingRevision: 1, recordSha256: 'a'.repeat(64), role, rootName: '合成组织', parentName: '合成上层' }]
    const next = f.makeReader(), input = mobileMembers(), expected: LocalAlbumSqlMobilePage = next.queryMobile(input)
    next.queryMobile({ ...input, kind: 'groups' }); f.reset()
    assert.deepEqual(next.queryMobile(input), expected)
    assert.equal(f.queries.some(q => q.sql.includes('mobile_plans AS MATERIALIZED')), role === 'cue')
    f.scope.revision = 'changed-author'; assert.throws(() => next.queryMobile(input), { code: 'SNAPSHOT_CHANGED' })
  }
})
