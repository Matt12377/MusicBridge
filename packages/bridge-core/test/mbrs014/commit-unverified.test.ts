import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { lstat } from 'node:fs/promises';
import { preparationFixture } from '../helpers/preparation-fixture.js';
import { SourcePublicationUnverified } from '../../src/recording/source-files.js';
import { physicalResourceLocks,PhysicalResourceBusy } from '../../src/stream/physical-resource-locks.js';

test('014 未知COMMIT：已提交后连接报错仍封口，不能伪fail或释放真实源claim',async t=>{
  let inject=false;const original=DatabaseSync.prototype.exec;
  const f=await preparationFixture(t,{beforeCommit(action){if(action==='freeze-master-versions')inject=true;}});
  DatabaseSync.prototype.exec=function(sql:string){if(inject&&sql==='COMMIT'){inject=false;original.call(this,sql);throw new Error('合成提交回报丢失');}return original.call(this,sql);};
  let retained:SourcePublicationUnverified|undefined;
  try {
    await f.freeze();await assert.rejects(f.versions.idle(),SourcePublicationUnverified);
    try{await f.versions.close();}catch(error){assert.ok(error instanceof SourcePublicationUnverified);retained=error;}
    assert.ok(retained);assert.equal(retained.reason,'COMMIT_UNVERIFIED');assert.equal(retained.claims?.state,'unverified');
    const stat=await lstat(f.file,{bigint:true});assert.throws(()=>physicalResourceLocks.acquireWrite([{dev:String(stat.dev),ino:String(stat.ino)}]),PhysicalResourceBusy);
    await assert.rejects(retained.claims!.release());assert.equal(physicalResourceLocks.snapshot().resources,1);
    const db=new DatabaseSync(f.filePath,{readOnly:true});try{assert.equal(db.prepare('SELECT count(*) n FROM master_versions').get()!.n,1);assert.equal(JSON.parse(String(db.prepare('SELECT data FROM version_jobs').get()!.data)).public.state,'completed');}finally{db.close();}
  } finally {
    DatabaseSync.prototype.exec=original;
    // 测试已直接对账确认COMMIT。仅关闭自建FD；产品claim仍保留到此隔离测试进程退出，绝不伪签释放。
    if(retained)for(const file of retained.files)await file.handle.close();
    const close=f.versions.close;f.versions.close=async()=>{try{await close();}catch(error){if(error!==retained)throw error;}};
  }
});
