import assert from 'node:assert/strict';import test from 'node:test';import {DatabaseSync} from 'node:sqlite';import {mkdtemp,readFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {createCollectionRepository} from '../src/collection/repository.js';
const facts=(db:DatabaseSync,names:string[])=>names.map(name=>[name,db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]);
async function fixture(t:test.TestContext){const directory=await mkdtemp(path.join(os.tmpdir(),'musicbridge-print-migration-'));t.after(()=>rm(directory,{recursive:true,force:true}));const filePath=path.join(directory,'collection.sqlite'),db=new DatabaseSync(filePath);db.exec(await readFile(new URL('fixtures/collection-schema20-completed.sql',import.meta.url),'utf8'));assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,20);const names=db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all().map(r=>String(r.name));const before=facts(db,names);db.close();return {filePath,names,before};}
test('真实20旧v1档案及全部旧列迁移24不变、不自动backfill',async t=>{const f=await fixture(t),repo=createCollectionRepository({filePath:f.filePath});t.after(()=>repo.close());repo.list({offset:0,limit:1});const db=new DatabaseSync(f.filePath);t.after(()=>db.close());assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,24);assert.deepEqual(facts(db,f.names),f.before);assert.equal(db.prepare('SELECT count(*) n FROM recording_print_jobs').get()!.n,0);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);});
test('21迁移提交故障回滚全部新表与schema，原20事实逐列保持后可重试',async t=>{const f=await fixture(t),repo=createCollectionRepository({filePath:f.filePath,beforeCommit(action){if(action==='migrate-recording-prints')throw new Error('合成迁移失败');}});assert.throws(()=>repo.list({offset:0,limit:1}));repo.close();const db=new DatabaseSync(f.filePath);assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,20);assert.deepEqual(facts(db,f.names),f.before);assert.equal(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name LIKE 'recording_print%'").get()!.n,0);db.close();const retry=createCollectionRepository({filePath:f.filePath});retry.list({offset:0,limit:1});retry.close();});
test('损坏旧20当前内容不能先迁移为21再报错，拒绝时schema和旧列保持',async t=>{
 const f=await fixture(t),db=new DatabaseSync(f.filePath);const trigger=String(db.prepare("SELECT sql FROM sqlite_schema WHERE name='recording_record_current_no_delete'").get()!.sql);db.exec('DROP TRIGGER recording_record_current_no_delete;DELETE FROM recording_record_current;');db.exec(trigger);const before=facts(db,f.names);db.close();
 const repo=createCollectionRepository({filePath:f.filePath});assert.throws(()=>repo.list({offset:0,limit:1}));repo.close();const after=new DatabaseSync(f.filePath);t.after(()=>after.close());assert.equal(after.prepare('PRAGMA user_version').get()!.user_version,20);assert.deepEqual(facts(after,f.names),before);
});
test('22→23仅移除每录音唯一约束，旧请求/事件/回执原字节保留且回滚可恢复',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'musicbridge-print-version-migration-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const filePath=path.join(directory,'collection.sqlite'),initial=new DatabaseSync(filePath);
 initial.exec(await readFile(new URL('fixtures/collection-schema20-cassette-completed.sql',import.meta.url),'utf8'));initial.close();
 const repository=createCollectionRepository({filePath});repository.list({offset:0,limit:1});
 const db=new DatabaseSync(filePath),record=JSON.parse(String(db.prepare('SELECT data FROM recording_records').get()!.data));
 repository.recordingPrints.request({commandId:'11111111-1111-4111-8111-111111111111',recordingId:record.id,expectedRecordHash:record.contentHash,templateId:'jp0-basic-v1',userConfirmed:true});repository.close();
 const {legacyPrintSchema,verifyRecordingPrintDatabase}=await import('../src/recording/print-integrity.js');
 const {migrateRecordingPrintVersions}=await import('../src/recording/print-store.js');
 const requestRows=db.prepare('SELECT * FROM recording_print_requests').all();
 const before={requests:requestRows,jobs:db.prepare('SELECT * FROM recording_print_jobs').all(),events:db.prepare('SELECT * FROM recording_print_events').all(),receipts:db.prepare('SELECT * FROM recording_print_receipts').all()};
 db.exec('PRAGMA foreign_keys=OFF;BEGIN IMMEDIATE;DROP TABLE recording_print_requests');
 db.exec(legacyPrintSchema.find(sql=>sql.startsWith('CREATE TABLE recording_print_requests('))!);
 for(const row of requestRows)db.prepare('INSERT INTO recording_print_requests VALUES(?,?,?,?)').run(String(row.id),String(row.recording_id),String(row.data),String(row.facts));
 for(const sql of legacyPrintSchema.filter(sql=>sql.startsWith('CREATE TRIGGER recording_print_requests_')))db.exec(sql);
 db.exec('PRAGMA user_version=22;COMMIT;PRAGMA foreign_keys=ON');verifyRecordingPrintDatabase(db);
 const legacySql=String(db.prepare("SELECT sql FROM sqlite_schema WHERE name='recording_print_requests'").get()!.sql);
 db.exec('PRAGMA foreign_keys=OFF;BEGIN IMMEDIATE');migrateRecordingPrintVersions(db);assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,23);db.exec('ROLLBACK;PRAGMA foreign_keys=ON');
 assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,22);assert.equal(db.prepare("SELECT sql FROM sqlite_schema WHERE name='recording_print_requests'").get()!.sql,legacySql);assert.deepEqual(db.prepare('SELECT * FROM recording_print_requests').all(),before.requests);
 db.exec('PRAGMA foreign_keys=OFF;BEGIN IMMEDIATE');migrateRecordingPrintVersions(db);db.exec('COMMIT;PRAGMA foreign_keys=ON');
 assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,23);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);verifyRecordingPrintDatabase(db);
 assert.deepEqual(db.prepare('SELECT * FROM recording_print_requests').all(),before.requests);assert.deepEqual(db.prepare('SELECT * FROM recording_print_jobs').all(),before.jobs);assert.deepEqual(db.prepare('SELECT * FROM recording_print_events').all(),before.events);assert.deepEqual(db.prepare('SELECT * FROM recording_print_receipts').all(),before.receipts);
 assert.equal(db.prepare("SELECT count(*) n FROM pragma_index_list('recording_print_requests') WHERE origin='u'").get()!.n,0);
 db.close();
});
