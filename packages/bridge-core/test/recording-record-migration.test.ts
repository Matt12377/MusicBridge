import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCollectionRepository } from '../src/collection/repository.js';

function facts(db: DatabaseSync) {
  return db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB 'recording_record*' AND name NOT GLOB 'recording_print*' AND name NOT GLOB 'master_artwork*' ORDER BY name").all()
    .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]);
}

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-task075-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'collection.sqlite'), db = new DatabaseSync(filePath);
  db.exec(await readFile(new URL('fixtures/collection-schema19.sql', import.meta.url), 'utf8'));
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 19);
  const before = facts(db); db.close();
  return { filePath, before };
}

test('真实schema19旧事实迁移到21逐列不变，新Record表为空且外键有效', async t => {
  const f = await fixture(t), repository = createCollectionRepository({ filePath: f.filePath });
  t.after(() => repository.close()); repository.list({ offset: 0, limit: 1 });
  const db = new DatabaseSync(f.filePath, { readOnly: true }); t.after(() => db.close());
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 21);
  assert.deepEqual(facts(db), f.before);
  for (const table of ['recording_records', 'recording_record_events', 'recording_record_receipts', 'recording_record_visuals', 'recording_record_current', 'recording_record_permits']) assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n, 0);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('schema21提交前故障整体回滚到19，重试不能丢失旧历史', async t => {
  const f = await fixture(t), failed = createCollectionRepository({ filePath: f.filePath, beforeCommit(action) { if (action === 'migrate-recording-records') throw new Error('合成迁移提交故障'); } });
  t.after(() => failed.close());
  assert.throws(() => failed.list({ offset: 0, limit: 1 })); failed.close();
  const db = new DatabaseSync(f.filePath, { readOnly: true });
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 19);
  assert.deepEqual(facts(db), f.before);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name GLOB 'recording_record*'").get()!.n, 0); db.close();
  const retried = createCollectionRepository({ filePath: f.filePath }); t.after(() => retried.close());
  retried.list({ offset: 0, limit: 1 });
  const after = new DatabaseSync(f.filePath, { readOnly: true }); t.after(() => after.close());
  assert.equal(after.prepare('PRAGMA user_version').get()!.user_version, 21); assert.deepEqual(facts(after), f.before);
});

test('旧19真实Completed只从首完成事件和冻结Plan补档案，不回填其后照片且旧表逐列守恒',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'musicbridge-task075-legacy-record-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const filePath=path.join(directory,'collection.sqlite'),db=new DatabaseSync(filePath);
  db.exec(await readFile(new URL('fixtures/collection-schema19-completed.sql',import.meta.url),'utf8'));
  const before=facts(db);assert.equal(db.prepare('SELECT count(*) n FROM collection_photos').get()!.n,1);db.close();
  const repository=createCollectionRepository({filePath});repository.list({offset:0,limit:1});repository.close();
  const after=new DatabaseSync(filePath,{readOnly:true});t.after(()=>after.close());
  assert.deepEqual(facts(after),before);
  const record=JSON.parse(String(after.prepare('SELECT data FROM recording_records').get()!.data));
  assert.equal(record.media.snapshotSource,'legacy-plan-only');assert.equal('descriptor' in record.media,false);
  assert.deepEqual(record.visuals,{artwork:{state:'not-captured',reason:'not-provided'},jCard:{state:'not-captured',reason:'not-provided'},photos:{state:'not-captured',reason:'not-provided'}});
  assert.equal(after.prepare('SELECT count(*) n FROM recording_record_visuals').get()!.n,0);
  assert.equal(after.prepare('SELECT usage FROM physical_copies').get()!.usage,'reserved');
  const again=createCollectionRepository({filePath});again.list({offset:0,limit:1});again.close();
  assert.equal(after.prepare('SELECT count(*) n FROM recording_records').get()!.n,1);
});

test('损坏旧19事件不能迁移补出合法档案，拒绝并保留旧schema与所有表事实',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'musicbridge-task075-invalid19-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const filePath=path.join(directory,'collection.sqlite'),db=new DatabaseSync(filePath);
  db.exec(await readFile(new URL('fixtures/collection-schema19-completed.sql',import.meta.url),'utf8'));
  const trigger=String(db.prepare("SELECT sql FROM sqlite_schema WHERE name='recording_attempt_events_no_update'").get()!.sql);
  db.exec('DROP TRIGGER recording_attempt_events_no_update');db.prepare("UPDATE recording_attempt_events SET data=json_set(data,'$.event.runId',?) WHERE revision=1").run('00000000-0000-4000-8000-000000000000');db.exec(trigger);
  const before=facts(db);db.close();
  const repository=createCollectionRepository({filePath});assert.throws(()=>repository.list({offset:0,limit:1}));repository.close();
  const after=new DatabaseSync(filePath,{readOnly:true});t.after(()=>after.close());
  assert.equal(after.prepare('PRAGMA user_version').get()!.user_version,19);assert.deepEqual(facts(after),before);
  assert.equal(after.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='recording_records'").get()!.n,0);
});
