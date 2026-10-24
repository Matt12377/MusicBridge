import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import * as dto from '@music-bridge/contracts'
import { largeMobileFixture, mobileMembers, syntheticId } from './local-album-mobile-large-fixture.js'

type Fixture = ReturnType<typeof largeMobileFixture>
type Audio = ReturnType<Fixture['add']>
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const members = (f: Fixture) => f.queries.filter(row => row.sql.includes('page_members AS MATERIALIZED'))

function addCue(f: Fixture, group: number, audio?: Audio, sidecarGroup = group, suffix = '') {
  const root = f.roots[group % f.roots.length]!.root
  const state = audio ? JSON.parse(String(f.db.prepare('SELECT data FROM local_scan_file_state WHERE library_root_id=? AND relative=?').get(root.id, audio.relative)!.data)) : null
  const item: dto.LocalCuePreparedItem = { relative: `目录😀${sidecarGroup}/原侧车${suffix}.cue`, signature: '合成CUE签名',
    parserVersion: 'cue-text-75fps/mbrs003-v1', outcome: audio ? 'accepted' : 'rejected', failureCode: audio ? null : 'CUE_PARSE_FAILED',
    reused: false, previousSnapshotId: null, result: audio ? { status: 'ok', tracks: [{ trackNumber: 1, fileOrdinal: 1,
      assetReference: { assetId: audio.asset.id, libraryRootId: root.id, sourceRootId: root.sourceRootId, rootRevision: root.revision,
        fileRevision: audio.asset.fileRevision, locationRevision: audio.asset.locationRevision, relative: audio.relative, signature: state.signature },
      timebase: 'cue-cd-frames', framesPerSecond: 75, index00Frames: null, index01Frames: 0, endFrames: null,
      evidence: 'cue-text-declared', playback: 'NOT_VERIFIED' }] } : null }
  assert.ok(dto.isLocalCuePreparedItem(item), '夹具必须先通过原CUE合同')
  const rowOrdinal = Number(f.db.prepare('SELECT coalesce(max(rowid),0)+1 n FROM local_cue_sources').get()!.n)
  const cue = { id: syntheticId(900000 + rowOrdinal), sidecarId: syntheticId(910000 + rowOrdinal), libraryRootId: root.id,
    sourceRootId: root.sourceRootId, rootRevision: root.revision, item }
  f.db.prepare('INSERT INTO local_cue_sources VALUES(?,?,?)').run(root.id, item.relative, JSON.stringify(cue))
  return cue
}

for (const plans of [8, 85]) test(`已核同目录CUE的${plans}计划只物化一次，完整100行和原SQL一致`, t => {
    const f = largeMobileFixture({ groups: 0, roots: 1 }); t.after(() => f.close())
    for (let group = 0; group < plans; group++) {
      const count = plans === 8 ? group < 4 ? 13 : 12 : group === 0 || group === 1 || group === 84 ? 6 : 1
      for (let n = 0; n < count; n++) f.add(group, n)
      if (plans === 8 || group >= 2 && group < 84) addCue(f, group)
    }
    const input = mobileMembers(), expected = f.reader.queryMobile(input)
    assert.equal(expected.items.length, 100); assert.equal(expected.total, 100)
    f.warm(); f.reset()
    const actual = f.reader.queryMobile(input), calls = members(f)
    assert.deepEqual(actual, expected)
    t.diagnostic(JSON.stringify({ plans, memberCteCalls: calls.length, rows: actual.items.length,
      outputSha256: digest(actual), counters: { ...f.counters } }))
    assert.equal(calls.length, 1, `原${plans}计划阶跃不能每目录重跑完整CTE`)
    assert.ok(calls[0]!.sql.includes('mobile_plans AS MATERIALIZED'))
    assert.equal((calls[0]!.sql.match(/source_rows AS MATERIALIZED/gu) ?? []).length, 1)
    assert.ok(actual.items.some(row => row.album.statuses.includes('cue-unsplit')), '被拒CUE事件仍进入原组状态')
    assert.ok(f.counters.source >= 100 && f.counters.track >= 100 && f.counters.asset >= 100 && f.counters.scan >= 100)
    for (const barrier of ['SELECT total_changes() changes', 'PRAGMA data_version', 'PRAGMA schema_version'])
      assert.ok(f.queries.filter(row => row.sql === barrier).length >= 2, '每页仍实读首末水位')
})

test('同目录多组共用CUE行号闭包，多个原CUE事件不被payload集合去重', t => {
  const f = largeMobileFixture({ groups: 0, roots: 1 }); t.after(() => f.close())
  for (let group = 0; group < 12; group++) for (let n = 0; n < 2; n++) f.add(group, n, group < 8 ? '目录😀0' : `目录😀${group}`)
  addCue(f, 0); addCue(f, 0, undefined, 0, '-第二原记录')
  const original = f.reader.queryMobile(mobileMembers())
  const originalGroups = f.reader.queryMobile(mobileMembers({ kind: 'groups' }))
  f.warm(); f.reset()
  const actual = f.reader.queryMobile(mobileMembers())
  assert.deepEqual(actual, original); assert.equal(members(f).length, 1)
  assert.deepEqual(f.reader.queryMobile(mobileMembers({ kind: 'groups' })), originalGroups)
  assert.ok(originalGroups.items.some(row => row.album.trackCount === 0 && row.album.statuses.includes('cue-unsplit')),
    '同目录有多个真实组时，原失败CUE属于额外事件组，不能伪分配给所有成员')
})

test('已核真实引用保留同目录CUE事实，跨目录和未决引用仍回原路径', t => {
  for (const kind of ['same', 'cross', 'unresolved'] as const) {
    const f = largeMobileFixture({ groups: 0, roots: 1 }); t.after(() => f.close())
    let audio: Audio | undefined
    for (let group = 0; group < 12; group++) for (let n = 0; n < 3; n++) { const row = f.add(group, n); if (group === 0 && n === 0) audio = row }
    assert.ok(audio)
    const cue = addCue(f, 0, audio, kind === 'cross' ? 1 : 0)
    if (kind === 'unresolved') {
      cue.item.result!.tracks[0]!.assetReference.signature = '合成已变化签名'
      f.db.prepare('UPDATE local_cue_sources SET data=? WHERE relative=?').run(JSON.stringify(cue), cue.item.relative)
    }
    const expected = f.reader.queryMobile(mobileMembers()); f.warm(); f.reset()
    assert.deepEqual(f.reader.queryMobile(mobileMembers()), expected)
    assert.equal(f.queries.some(row => row.sql.includes('mobile_plans AS MATERIALIZED')), kind === 'same')
  }
})

test('CUE批量读取的撤销、scope、SQL变更与codec错误均拒绝整页', t => {
  for (const change of ['revoke', 'scope', 'sql', 'codec'] as const) {
    const f = largeMobileFixture({ groups: 12, singles: 0, members: 3, roots: 1 }); t.after(() => f.close())
    addCue(f, 0)
    let rejectCodec = false, codecFailures = 0
    if (change === 'codec') { const read = f.codec.track; f.codec.track = row => { if (rejectCodec) { codecFailures++; throw new Error('合成原codec拒绝') }; return read(row) } }
    const reader = f.makeReader(); reader.queryMobile(mobileMembers({ kind: 'groups' })); f.reset()
    if (change === 'revoke') f.afterSource(() => f.revoke())
    else if (change === 'codec') rejectCodec = true
    else f.afterSql(sql => { if (sql.includes('mobile_plans AS MATERIALIZED')) {
      if (change === 'scope') f.scope.revision = 'changed-cue-scope'
      else f.add(99, 0)
    } })
    assert.throws(() => reader.queryMobile(mobileMembers()), { code: change === 'revoke' || change === 'codec' ? 'UNAVAILABLE' : 'SNAPSHOT_CHANGED' })
    if (change === 'codec') assert.ok(codecFailures > 0, '原codec必须实际执行且失败不能发布半页')
    if (change !== 'revoke') {
      rejectCodec = false; f.afterSql(); f.afterSource(); f.scope.revision = 'after-failed-cue-read'
      const next = f.makeReader(), expected = next.queryMobile(mobileMembers())
      next.queryMobile(mobileMembers({ kind: 'groups' })); assert.deepEqual(next.queryMobile(mobileMembers()), expected)
    }
  }
})

test('CUE并集与plans合计超过原2MiB即完整回退，不返回截断闭包', t => {
  const f = largeMobileFixture({ groups: 2, singles: 0, members: 2, roots: 1 }); t.after(() => f.close())
  for (let n = 0; n < 1500; n++) addCue(f, 0, undefined, 0, String(n) + '长'.repeat(500))
  const input = mobileMembers(), expected = f.reader.queryMobile(input)
  f.warm(); f.reset()
  assert.deepEqual(f.reader.queryMobile(input), expected)
  assert.equal(f.queries.some(row => row.sql.includes('mobile_plans AS MATERIALIZED')), false)
  assert.equal(members(f).length, 2)
})

test('损坏CUE原行仍被原codec拒绝，不因批量或旧Compact忽略', t => {
  const f = largeMobileFixture({ groups: 12, singles: 0, members: 3, roots: 1 }); t.after(() => f.close())
  const cue = addCue(f, 0); f.warm()
  f.db.prepare('UPDATE local_cue_sources SET data=? WHERE relative=?').run(JSON.stringify({ ...cue, unrecognized: true }), cue.item.relative)
  assert.throws(() => f.reader.queryMobile(mobileMembers()))
  const fresh = f.makeReader(); assert.throws(() => fresh.queryMobile(mobileMembers()))
})
