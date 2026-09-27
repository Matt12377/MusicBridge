import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { recordingRecordFixture } from './helpers/recording-record-fixture.js';
import { migrateRecordingRecordPageSearch, verifyRecordingRecordPageSearch } from '../src/recording/record-page-index.js';

test('schema28 已有 Record 回填逐行计字节，不每行全表 SUM，原 Record/Plan 字节不变', async t => {
  const f = await recordingRecordFixture(t);
  const pending = await f.readyForFinal();
  assert.equal((await f.attempts.confirm(pending.request)).status, 'completed');
  const db = new DatabaseSync(f.filePath, { enableForeignKeyConstraints: true, allowExtension: false });
  t.after(() => db.close());
  const recordBytes = db.prepare('SELECT data FROM recording_records ORDER BY id').all().map(row => row.data);
  const planBytes = db.prepare('SELECT data FROM recording_plan_versions ORDER BY id').all().map(row => row.data);
  assert.equal(recordBytes.length, 1);
  db.exec('DROP TABLE recordpage_search; PRAGMA user_version=28');
  const prepared: string[] = [];
  const observed = new Proxy(db, { get(target, property) {
    if (property === 'prepare') return (sql: string) => { prepared.push(sql); return target.prepare(sql); };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  db.exec('BEGIN IMMEDIATE');
  try { migrateRecordingRecordPageSearch(observed); db.exec('COMMIT'); }
  catch (error) { db.exec('ROLLBACK'); throw error; }
  assert.equal(prepared.filter(sql => /\bsum\s*\(/iu.test(sql)).length, 0, '回填应累计逐行字节，不反复扫描已插入投影');
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 29);
  assert.deepEqual(db.prepare('SELECT data FROM recording_records ORDER BY id').all().map(row => row.data), recordBytes);
  assert.deepEqual(db.prepare('SELECT data FROM recording_plan_versions ORDER BY id').all().map(row => row.data), planBytes);
  verifyRecordingRecordPageSearch(db);
  assert.equal(db.prepare('SELECT count(*) AS n FROM recordpage_search').get()?.n, recordBytes.length);
});
