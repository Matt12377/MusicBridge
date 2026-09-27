import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { MediaDistributionSpec, RecordingRecord } from '@music-bridge/contracts';
import { recordingPlanFixture } from './helpers/recording-plan-fixture.js';
import { createRecordingRecordCoordinator } from '../src/recording/record-coordinator.js';
import type { RecordingRecordStore } from '../src/recording/record-store.js';
import { buildRecordPageSearch, formalRecordingMusicSelect, recordingRecordSummary } from '../src/recording/record-projections.js';
import { insertRecordingRecordPageSearch, migrateRecordingRecordPageSearch } from '../src/recording/record-page-index.js';
import { mediaFingerprint } from '../src/recording/media-store.js';
import { freezeMediaDistribution, verifyFrozenDistribution } from '../src/recording/version-distribution.js';

test('R33 搜索投影按 SQL 字面过滤，默认及筛选列表都只解析当页 Record/Plan', async t => {
  const f = await recordingPlanFixture(t);
  const plan = await f.plans.freeze(await f.planRequest());
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE recording_records(id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, data TEXT NOT NULL) STRICT');
  db.exec('CREATE TABLE recording_plan_versions(id TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT');
  db.prepare('INSERT INTO recording_plan_versions VALUES(?,?)').run(plan.id, JSON.stringify(plan));
  migrateRecordingRecordPageSearch(db);

  const ids = Array.from({ length: 6 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
  const source = new Map<string, RecordingRecord>();
  for (const [index, id] of ids.entries()) {
    const physicalId = `MB-C-${String(index + 1).padStart(5, '0')}`;
    const record = { id, contentHash: 'a'.repeat(64), completion: { id: randomUUID(), physicalId,
      planVersionId: plan.id, endedAt: index >= 4 ? '2026-09-27T12:00:00.000Z' : `2026-09-${String(20 + index).padStart(2, '0')}T12:00:00.000Z` },
    media: { modelId: plan.layout.reservation.modelId, descriptor: { brand: index === 0 ? 'Mix%_Ω' : index === 1 ? 'MixABΩ' : '合成品牌', name: '测试系列' } } } as unknown as RecordingRecord;
    source.set(id, record);
    db.prepare('INSERT INTO recording_records VALUES(?,?,?)').run(id, plan.id, '{}');
    insertRecordingRecordPageSearch(db, record, plan);
  }

  const sql: string[] = [], readIds: string[] = [];
  const observedDb = new Proxy(db, { get(target, property) {
    if (property === 'prepare') return (statement: string) => { sql.push(statement); return target.prepare(statement); };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const store = { read: <T>(fn: (database: DatabaseSync) => T) => fn(observedDb),
    record: (_database: DatabaseSync, id: string) => { readIds.push(id); return source.get(id) ?? null; } } as unknown as RecordingRecordStore;
  const records = createRecordingRecordCoordinator({ store, assertCurrent() {}, assertExecutionIdle() {} });
  t.after(() => records.close());
  const page = { offset: 1, limit: 2 };

  const all = records.list({ page });
  assert.equal(all.total, 6);
  assert.deepEqual(all.items.map(item => item.id), [ids[4], ids[3]]);
  assert.deepEqual(readIds, [ids[4], ids[3]], '默认列表不得解析前置/后续 Record');
  assert.equal(sql.filter(statement => statement === 'SELECT data FROM recording_plan_versions WHERE id=?').length, 2);
  const defaultPageSql = sql.find(statement => statement.includes('ORDER BY s.completed_at DESC,s.record_id DESC LIMIT ? OFFSET ?'))!;
  const planDetails = db.prepare(`EXPLAIN QUERY PLAN ${defaultPageSql}`).all(page.limit, page.offset).map(row => String(row.detail));
  assert.ok(planDetails.some(detail => detail.includes('idx_recordpage_search_completed')), planDetails.join('\n'));
  assert.ok(planDetails.every(detail => !detail.includes('TEMP B-TREE')), planDetails.join('\n'));

  readIds.length = 0; sql.length = 0;
  const filtered = records.list({ page: { offset: 0, limit: 1 }, filter: { mediaBrand: 'MIX%_ω' } });
  assert.equal(filtered.total, 1);
  assert.deepEqual(filtered.items.map(item => item.id), [ids[0]]);
  assert.deepEqual(readIds, [ids[0]], '筛选不得先解析不匹配的 Record');
  assert.equal(sql.filter(statement => statement === 'SELECT data FROM recording_plan_versions WHERE id=?').length, 1);
  assert.equal(records.list({ page: { offset: 0, limit: 1 }, filter: { mediaBrand: 'MIXABω' } }).items[0]?.id, ids[1]);
  assert.equal(records.list({ page: { offset: 0, limit: 1 }, filter: { query: '1' } }).items[0]?.physicalId, 'MB-C-00001');
  assert.equal(records.list({ page: { offset: 0, limit: 1 }, filter: { query: 'Mix%_Ω' } }).items[0]?.id, ids[0]);
  assert.equal(records.list({ page: { offset: 0, limit: 1 }, filter: { query: 'not-found' } }).total, 0);
});

test('R33 投影持有不可变 Record/Plan 摘要及本盘艺术家展示字段', async t => {
  const f = await recordingPlanFixture(t);
  const plan = await f.plans.freeze(await f.planRequest());
  const record = { id: randomUUID(), contentHash: 'a'.repeat(64), completion: { id: randomUUID(), physicalId: plan.physicalCopy.physicalId,
    planVersionId: plan.id, endedAt: '2026-09-27T12:00:00.000Z' }, media: { descriptor: { brand: 'TDK', name: 'SA' } } } as unknown as RecordingRecord;
  const search = buildRecordPageSearch(record, plan);
  assert.equal(search.record_id, record.id);
  assert.equal(search.physical_id, record.completion.physicalId);
  assert.equal(search.master_version_id, plan.master.id);
  assert.equal(search.record_content_hash, record.contentHash);
  assert.equal(search.plan_content_hash, plan.contentHash);
  assert.equal(search.artist_display, '');
  assert.ok(search.track_text.includes('合成曲目 1'));
  assert.ok(search.query_text.includes('tdk sa'));
});

test('R33 分盘检索只使用冻结分布所选曲目，异盘艺术家不影响本盘展示', async t => {
  const f = await recordingPlanFixture(t);
  const original = await f.plans.freeze(await f.planRequest());
  const content = { ...original.master.content, tracks: original.master.content.tracks.map((track, index) => ({
    ...track, metadata: { ...track.metadata, artist: index < 2 ? '本盘甲' : '异盘乙' },
  })) };
  const master = { ...original.master, content, contentHash: mediaFingerprint(content) };
  const ids = content.tracks.map(track => track.trackId);
  const distribution: MediaDistributionSpec = { schemaVersion: 1, groupId: randomUUID(), segmentIndex: 0,
    segmentSpecs: [{ trackIds: ids.slice(0, 2) }, { trackIds: ids.slice(2) }] };
  const emptyB = { ...original.layout.timeline.sides[1]!, leadInFrames: 0, tailFrames: 0, totalFrames: 0, tracks: [] };
  const timeline = { ...original.layout.timeline, sides: [original.layout.timeline.sides[0]!, emptyB] };
  const layout = { ...original.layout, spec: { ...original.layout.spec, distribution }, timeline,
    timelineHash: mediaFingerprint(timeline), distribution: freezeMediaDistribution(master, distribution)! };
  const plan = { ...original, master, layout };
  assert.deepEqual(verifyFrozenDistribution(master, layout)?.trackIds, ids.slice(0, 2));
  const record = { id: randomUUID(), contentHash: 'a'.repeat(64), completion: { id: randomUUID(),
    physicalId: plan.physicalCopy.physicalId, planVersionId: plan.id, endedAt: '2026-09-27T12:00:00.000Z' },
    media: { modelId: plan.layout.reservation.modelId, descriptor: { brand: 'TDK', name: 'SA' } } } as unknown as RecordingRecord;
  const projected = buildRecordPageSearch(record, plan);
  assert.equal(projected.artist_display, '本盘甲');
  assert.equal(recordingRecordSummary(record, plan).artist, '本盘甲');
  assert.ok(projected.track_text.includes('合成曲目 1') && projected.track_text.includes('合成曲目 2'));
  assert.ok(!projected.track_text.includes('合成曲目 3'));
  assert.ok(!projected.artist_text.includes('异盘乙'));
  assert.ok(!projected.query_text.includes('异盘乙'));
  assert.throws(() => buildRecordPageSearch(record, { ...plan, layout: { ...layout,
    distribution: { ...layout.distribution, distributionHash: '0'.repeat(64) } } }));
});

test('R33 实体音乐列表 SQL 对同母版各盘采用各自 artist_display，unknown 不泄露旧内容', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE physical_copies(physical_id TEXT PRIMARY KEY,lot_id TEXT);
      CREATE TABLE inventory_lots(id TEXT PRIMARY KEY,sku_id TEXT);
      CREATE TABLE collection_skus(id TEXT PRIMARY KEY,model_id TEXT);
      CREATE TABLE collection_models(id TEXT PRIMARY KEY,descriptor TEXT);
      CREATE TABLE recording_record_current(physical_id TEXT PRIMARY KEY,data TEXT);
      CREATE TABLE recording_records(id TEXT PRIMARY KEY,physical_id TEXT,plan_id TEXT);
      CREATE TABLE recording_plan_versions(id TEXT PRIMARY KEY,data TEXT);
      CREATE TABLE recordpage_search(record_id TEXT PRIMARY KEY,artist_display TEXT);
      INSERT INTO collection_models VALUES('model','{"format":"cassette"}');
      INSERT INTO collection_skus VALUES('sku','model');
      INSERT INTO inventory_lots VALUES('lot','sku');
      INSERT INTO recording_plan_versions VALUES('same-master','{"master":{"title":"同一母版旧标题"}}');`);
    const copies = [
      { id: 'MB-C-00001', record: 'record-a', artist: '本盘甲', state: 'confirmed-recording' },
      { id: 'MB-C-00002', record: 'record-b', artist: '异盘乙', state: 'confirmed-recording' },
      { id: 'MB-C-00003', record: 'record-c', artist: '旧艺人丙', state: 'unknown' },
    ];
    for (const copy of copies) {
      db.prepare('INSERT INTO physical_copies VALUES(?,?)').run(copy.id, 'lot');
      db.prepare('INSERT INTO recording_records VALUES(?,?,?)').run(copy.record, copy.id, 'same-master');
      db.prepare('INSERT INTO recordpage_search VALUES(?,?)').run(copy.record, copy.artist);
      db.prepare('INSERT INTO recording_record_current VALUES(?,?)').run(copy.id, JSON.stringify({ knowledge: {
        state: copy.state, recordingId: copy.record,
      } }));
    }
    const rows = db.prepare(`SELECT id,title,artist FROM (${formalRecordingMusicSelect}) ORDER BY id`).all();
    assert.deepEqual(rows.map(row => [row.id, row.title, row.artist]), [
      ['MB-C-00001', '同一母版旧标题', '本盘甲'],
      ['MB-C-00002', '同一母版旧标题', '异盘乙'],
      ['MB-C-00003', '当前内容待核实', ''],
    ]);
    const matching = (query: string) => db.prepare(`SELECT id FROM (${formalRecordingMusicSelect}) WHERE instr(lower(title || ' ' || artist),?)>0 ORDER BY id`)
      .all(query.toLowerCase()).map(row => String(row.id));
    assert.deepEqual(matching('本盘甲'), ['MB-C-00001']);
    assert.deepEqual(matching('异盘乙'), ['MB-C-00002']);
    assert.deepEqual(matching('旧艺人丙'), []);
    assert.deepEqual(matching('当前内容待核实'), ['MB-C-00003']);
  } finally { db.close(); }
});
