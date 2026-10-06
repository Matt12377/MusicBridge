import {isolateRestoredDatabase,verifyRestoredDatabaseIsolation} from '../../src/recording/restore-database.js';
import {readBackupIndex} from '../../src/recording/backup-index.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { MBQueueStoreError } from '../../src/collection/mb-queue-store.js';
import { type MBQueueRecord, isMBQueueRecord, mbQueueSerializedBytes, isLocalMBQueueEntryRecord } from '@music-bridge/contracts';
function queue(datasetId = randomUUID(), count = 3): MBQueueRecord {
 return { schemaVersion:'1.2', datasetId, queueId:randomUUID(), revision:'1', currentEntryId:null, restartPolicy:{reResolve:true,autoplay:false},
 entries:Array.from({length:count},()=>({entryId:randomUUID(),entryRevision:'1',source:{kind:'netease' as const,trackId:'123'},quality:'auto' as const})) };
}
test('007 SQLite CAS保存5000独立条目，冷重开仅恢复逻辑记录且无自动播放',async t=>{
 const directory=await mkdtemp(path.join(process.env.TMPDIR!,'mbrs007-queue-')),filePath=path.join(directory,'catalog.sqlite');t.after(()=>rm(directory,{recursive:true,force:true}));
 let repo=createCollectionRepository({filePath});const q=queue(undefined,5000);assert.equal(repo.mbQueue.load(q.datasetId),null);
 const saved=repo.mbQueue.save({expectedRevision:'0',queue:q});assert.equal(saved.entries.length,5000);assert.deepEqual(saved,q);
 assert.throws(()=>repo.mbQueue.save({expectedRevision:'0',queue:q}),error=>error instanceof MBQueueStoreError && error.code==='QUEUE_CONFLICT');
 assert.deepEqual(repo.mbQueue.load(q.datasetId),q);repo.close();repo=createCollectionRepository({filePath});t.after(()=>repo.close());assert.deepEqual(repo.mbQueue.load(q.datasetId),q);
 assert.equal((repo.mbQueue.load(q.datasetId) as MBQueueRecord).restartPolicy.autoplay,false);assert.equal((repo.mbQueue.load(q.datasetId) as MBQueueRecord).restartPolicy.reResolve,true);
 const db=new DatabaseSync(filePath,{readOnly:true});assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,33);db.close();
});
test('007最长合法provider ID的5000项保存与原002最大Unicode意图保守上界；闭合来源拒绝URL/path/token和重复entry及容量截断',()=>{
 const repo=createCollectionRepository({filePath:':memory:'});try {
  const q=queue(undefined,5000);q.entries.forEach(entry=>{if(entry.source.kind === 'netease' || entry.source.kind === 'smart') entry.source.trackId='9'.repeat(128);});
  assert.equal(isMBQueueRecord(q),true);assert.ok(mbQueueSerializedBytes(q)<16*1024*1024);assert.equal(repo.mbQueue.save({expectedRevision:'0',queue:q}).entries.length,5000);
  const source={sourceKind:'local_file' as const,trackId:randomUUID(),assetId:randomUUID(),libraryRootId:randomUUID(),sourceRootId:randomUUID(),rootRevision:'18446744073709551615',fileRevision:'18446744073709551615',locationRevision:'18446744073709551615',selectionRevision:'18446744073709551615',segment:null};
  const conservative=q.entries.map((entry,index)=>({schemaVersion:'1.2',datasetId:q.datasetId,entryId:entry.entryId,queueId:q.queueId,queueRevision:'18446744073709551615',entryRevision:'18446744073709551615',orderIndex:String(index),localSourceSnapshot:source,target:{coreId:'𠮷'.repeat(256),zoneId:'𠮷'.repeat(256)},restartPolicy:{reResolve:true,autoplay:false}}));
  assert.ok(conservative.every(isLocalMBQueueEntryRecord));assert.ok(mbQueueSerializedBytes(conservative)<16*1024*1024);
  assert.equal(isMBQueueRecord({...q,entries:[{...q.entries[0],source:{kind:'netease',trackId:'𠮷'}}]}),false);
  for(const forbidden of ['url','path','token','session','oid']) assert.equal(isMBQueueRecord({...q,[forbidden]:'秘密'}),false);
  assert.equal(isMBQueueRecord({...q,entries:[...q.entries,q.entries[0]]}),false);
  assert.equal(isMBQueueRecord({...q,entries:[q.entries[0],q.entries[0]]}),false);
  assert.equal(isMBQueueRecord({...q,entries:[{...q.entries[0],source:{kind:'netease',trackId:'https://secret.invalid'}}]}),false);
 }finally{repo.close();}
});
test('007保存失败ROLLBACK保留原快照和revision；队列失败不发布新revision',()=>{
 let fail=false;const repo=createCollectionRepository({filePath:':memory:',beforeCommit:op=>{if(op==='save-mb-queue'&&fail)throw new Error('受控提交前失败');}});
 try {const q=queue();repo.mbQueue.save({expectedRevision:'0',queue:q});fail=true;
  assert.throws(()=>repo.mbQueue.save({expectedRevision:'1',queue:{...q,revision:'2',entries:[]}}));assert.deepEqual(repo.mbQueue.load(q.datasetId),q);
 } finally {repo.close();}
});
test('007 schema32旧数据库迁移到33，已有业务表与数据保持',async t=>{
 const directory=await mkdtemp(path.join(process.env.TMPDIR!,'mbrs007-schema-')),filePath=path.join(directory,'catalog.sqlite');t.after(()=>rm(directory,{recursive:true,force:true}));
 const repo=createCollectionRepository({filePath});repo.mbQueue.load(randomUUID());repo.close();const db=new DatabaseSync(filePath);db.exec('DROP TABLE mb_playback_queue; PRAGMA user_version=32');db.close();
 const reopened=createCollectionRepository({filePath});t.after(()=>reopened.close());assert.equal(reopened.mbQueue.load(randomUUID()),null);
 const view=new DatabaseSync(filePath,{readOnly:true});assert.equal(view.prepare('PRAGMA user_version').get()!.user_version,33);assert.ok(view.prepare("SELECT name FROM sqlite_master WHERE name='local_scan_file_state'").get());view.close();
});

test('007隔离恢复scope变化只返回需核对摘要、保留原记录；显式新queueId按旧revision CAS覆盖',async t=>{
 const directory=await mkdtemp(path.join(process.env.TMPDIR!,'mbrs007-restore-')),filePath=path.join(directory,'original.sqlite'),copy=path.join(directory,'restored.sqlite');t.after(()=>rm(directory,{recursive:true,force:true}));
 const repo=createCollectionRepository({filePath}),q=queue();repo.mbQueue.save({expectedRevision:'0',queue:q});repo.close();
 await copyFile(filePath,copy);readBackupIndex(copy);isolateRestoredDatabase(copy);verifyRestoredDatabaseIsolation(copy);
 const restored=createCollectionRepository({filePath:copy});t.after(()=>restored.close());const id=randomUUID(),saved=restored.mbQueue.load(id)!;
 assert.deepEqual(saved,{status:'NEEDS_REVIEW',queueId:q.queueId,revision:'1'});assert.deepEqual(restored.mbQueue.load(q.datasetId),q);
 assert.throws(()=>restored.mbQueue.save({expectedRevision:'1',queue:{...q,datasetId:id,revision:'2'}}));
 const fresh={...queue(id),revision:'2'};assert.deepEqual(restored.mbQueue.save({expectedRevision:'1',queue:fresh}),fresh);assert.deepEqual(restored.mbQueue.load(id),fresh);
});

test('007缺表或DDL损坏仍严格冷开拒绝，不将SQLite/schema故障降级为逻辑UNAVAILABLE',async t=>{
 const directory=await mkdtemp(path.join(process.env.TMPDIR!,'mbrs007-bad-schema-')),file=path.join(directory,'collection.sqlite');t.after(()=>rm(directory,{recursive:true,force:true}));
 const repo=createCollectionRepository({filePath:file});repo.mbQueue.load(randomUUID());repo.close();const db=new DatabaseSync(file);db.exec('DROP TABLE mb_playback_queue');db.close();
 const reopened=createCollectionRepository({filePath:file});try{assert.throws(()=>reopened.list({offset:0,limit:1}));}finally{reopened.close();}
});
