import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdir,readFile } from 'node:fs/promises';
import path from 'node:path';
import { authorizeSourceDirectory } from '../src/recording/source-files.js';
import { restoreArchiveBackup,verifyRestoredArchive } from '../src/recording/restore-package.js';
import { randomUUID, createHash } from 'node:crypto';
import { recordingRecordFixture } from './helpers/recording-record-fixture.js';
import { readBackupIndex } from '../src/recording/backup-index.js';
import { isolateRestoredDatabase, verifyRestoredDatabaseIsolation } from '../src/recording/restore-database.js';
import { verifyRecordingRecordDatabase } from '../src/recording/record-integrity.js';

test('schema20完整备份保留Record/照片字节与首完成事实，隔离恢复幂等不补登记',async t=>{
  const f=await recordingRecordFixture(t,'dat'),modelId=f.frozenPlan.layout.reservation.modelId,physicalId=f.frozenPlan.physicalCopy.physicalId;
  f.repository.addPhoto({commandId:randomUUID(),modelId,physicalId,image:{dataUrl:'data:image/jpeg;base64,/9j/2Q==',width:1,height:1}});
  const pending=await f.readyForFinal();await f.attempts.confirm(pending.request);
  readBackupIndex(f.filePath);
  const backup=await f.api.createArchiveBackup(f.backupRequest);
  const verified=await f.api.verifyArchiveBackup(backup.directory,f.backupRequest.signal);
  const source=new DatabaseSync(f.filePath,{readOnly:true});
  const before=source.prepare('SELECT * FROM recording_records').all(),photos=source.prepare('SELECT * FROM recording_record_visuals').all();source.close();
  const target=path.join(f.directory,'Record隔离恢复');await mkdir(target);
  const restored=await restoreArchiveBackup({backup:backup.directory,destination:{...await authorizeSourceDirectory(target),id:randomUUID()},protectedRoots:[...f.repository.sources.roots(),...f.repository.preparations.destinations(),f.root.root],id:randomUUID(),userConfirmed:true,signal:f.backupRequest.signal});
  assert.equal((await verifyRestoredArchive(restored.directory,f.backupRequest.signal)).contentIncluded,true);
  const restoredPath=path.join(restored.directory.path,'database','collection.sqlite');
  isolateRestoredDatabase(restoredPath);verifyRestoredDatabaseIsolation(restoredPath);readBackupIndex(restoredPath);
  const after=new DatabaseSync(restoredPath,{readOnly:true});verifyRecordingRecordDatabase(after);
  assert.deepEqual(after.prepare('SELECT * FROM recording_records').all(),before);assert.deepEqual(after.prepare('SELECT * FROM recording_record_visuals').all(),photos);after.close();
  assert.deepEqual(await f.api.verifyArchiveBackup(backup.directory,f.backupRequest.signal),verified);
});

test('损坏照片或档案头恢复trigger后仍拒绝只读校验，isolate拒绝时文件字节不改',async t=>{
  const f=await recordingRecordFixture(t),pending=await f.readyForFinal();await f.attempts.confirm(pending.request);
  const db=new DatabaseSync(f.filePath);db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const trigger=String(db.prepare("SELECT sql FROM sqlite_schema WHERE name='recording_record_current_no_delete'").get()!.sql);
  db.exec('DROP TRIGGER recording_record_current_no_delete; DELETE FROM recording_record_current;');db.exec(trigger);db.close();
  const digest=async()=>createHash('sha256').update(await readFile(f.filePath)).digest('hex'),before=await digest();
  assert.throws(()=>readBackupIndex(f.filePath));assert.throws(()=>isolateRestoredDatabase(f.filePath));assert.equal(await digest(),before);
});
