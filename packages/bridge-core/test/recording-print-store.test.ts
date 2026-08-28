import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { recordingRecordFixture } from './helpers/recording-record-fixture.js';

const image={dataUrl:'data:image/jpeg;base64,/9j/2Q==',width:1,height:1};
async function fixture(t:test.TestContext,format:'cassette'|'dat'='cassette') {
 const f=await recordingRecordFixture(t,format),db=new DatabaseSync(f.filePath);t.after(()=>db.close());
 return {...f,db};
}
test('首次Cassette Completed原子登记v2与不可变打印事实pending，重复完成不多建且库存守恒',async t=>{
 const f=await fixture(t),pending=await f.readyForFinal();
 const inventory=f.db.prepare('SELECT * FROM inventory_lots').all();await f.attempts.confirm(pending.request);
 const record=JSON.parse(String(f.db.prepare('SELECT data FROM recording_records').get()!.data));
 assert.equal(record.schemaVersion,2);assert.match(record.printRequestId,/^[a-f0-9-]{36}$/);
 const rows=f.db.prepare('SELECT data FROM recording_print_jobs').all();assert.equal(rows.length,1);
 const job=JSON.parse(String(rows[0]!.data));assert.equal(job.state,'pending');assert.equal(job.request.id,record.printRequestId);
 assert.deepEqual(f.db.prepare('SELECT * FROM inventory_lots').all(),inventory);
 await f.attempts.confirm(pending.request);assert.equal(f.db.prepare('SELECT count(*) n FROM recording_print_jobs').get()!.n,1);
});
test('DAT首次Completed仍为v2但无Cassette打印任务',async t=>{
 const f=await fixture(t,'dat'),pending=await f.readyForFinal();await f.attempts.confirm(pending.request);
 const record=JSON.parse(String(f.db.prepare('SELECT data FROM recording_records').get()!.data));
 assert.equal(record.schemaVersion,2);assert.equal(record.printRequestId,null);assert.equal(record.visuals.jCard.reason,'not-applicable');
 assert.equal(f.db.prepare('SELECT count(*) n FROM recording_print_jobs').get()!.n,0);
});
async function service(t:test.TestContext) {
 const f=await fixture(t);const {createRecordingPrintCoordinator}=await import('../src/recording/print-coordinator.js');
 const api=createRecordingPrintCoordinator({store:f.repository.recordingPrints,assertCurrent(){}});t.after(()=>api.close());return {...f,api};
}
test('Artwork明确Master归属、CAS与命令幂等，Completed捕获旧版且后改不漂移',async t=>{
 const f=await service(t),masterVersionId=f.frozenPlan.master.id;
 const request={commandId:randomUUID(),masterVersionId,expectedVersionId:null,image,userConfirmed:true as const};
 const version=f.api.artworkSave(request);assert.deepEqual(f.api.artworkSave(request),version);
 assert.throws(()=>f.api.artworkSave({...request,image:{...image,width:2}}));
 assert.throws(()=>f.api.artworkSave({...request,commandId:randomUUID()}));
 const pending=await f.readyForFinal();await f.attempts.confirm(pending.request);
 const record=JSON.parse(String(f.db.prepare('SELECT data FROM recording_records').get()!.data));
 assert.deepEqual(record.visuals.artwork,{state:'captured',version});
 f.api.artworkSave({...request,commandId:randomUUID(),expectedVersionId:version.id});
 assert.equal(f.api.artworkGet({masterVersionId}).currentVersion!.sequence,2);
 assert.deepEqual(JSON.parse(String(f.db.prepare('SELECT data FROM recording_records').get()!.data)),record);
 const lease=f.api.claim({workerId:randomUUID()}).lease!;assert.deepEqual(lease.artworkImage,image);assert.deepEqual(lease.facts.artwork,record.visuals.artwork);
});
test('失败不回滚Completed；明确重试、私有lease、完成幂等与旧PDF字节保持',async t=>{
 const f=await service(t),pending=await f.readyForFinal();await f.attempts.confirm(pending.request);
 const record=JSON.parse(String(f.db.prepare('SELECT data FROM recording_records').get()!.data));
 const lease=f.api.claim({workerId:randomUUID()}).lease!;assert.equal(f.api.claim({workerId:randomUUID()}).lease,null);
 const identity={leaseId:lease.leaseId,workerId:lease.workerId,jobId:lease.jobId,inputHash:lease.inputHash};
 const failure={...identity,errorCode:'RENDER_FAILED' as const};const failed=f.api.fail(failure);assert.deepEqual(f.api.fail(failure),failed);
 assert.equal(failed.state,'failed');assert.equal(f.attempts.get({attemptId:pending.attempt.id}).attempt!.status,'completed');
 const retry={commandId:randomUUID(),jobId:failed.id,expectedRevision:failed.revision,userConfirmed:true as const};const queued=f.api.retry(retry);assert.deepEqual(f.api.retry(retry),queued);
 const next=f.api.claim({workerId:randomUUID()}).lease!,pdf=Buffer.from('%PDF-1.7\n合成Core边界fixture\n%%EOF\n');
 const complete={leaseId:next.leaseId,workerId:next.workerId,jobId:next.jobId,inputHash:next.inputHash,pdfBase64:pdf.toString('base64'),pdfSha256:createHash('sha256').update(pdf).digest('hex'),preview:image,pageCount:1,rendererVersion:'test-1'};
 assert.throws(()=>f.api.complete({...complete,workerId:randomUUID()}));
 const ready=f.api.complete(complete);assert.equal(ready.state,'ready');assert.deepEqual(f.api.complete(complete),ready);assert.throws(()=>f.api.complete({...complete,pageCount:2}));
 assert.deepEqual(f.api.pdf({recordingId:record.id,artifactId:ready.artifactId!,expectedPdfSha256:complete.pdfSha256}),{artifactId:ready.artifactId,pdfSha256:complete.pdfSha256,size:pdf.length,pdfBase64:complete.pdfBase64});
 assert.equal(f.api.get({recordingId:record.id,artifactId:ready.artifactId!}).facts.recordingContentHash,record.contentHash);
});

test('完成提交故障同时回滚Record与打印意图；重新确认只建一份',async t=>{
 const f=await fixture(t),pending=await f.readyForFinal();
 const {createRecordingAttemptStore}=await import('../src/recording/attempt-store.js');let fail=true;
 const store=createRecordingAttemptStore({read:fn=>fn(f.db),beforeCommit(){if(fail)throw new Error('合成事务故障');}});
 const event={type:'confirm' as const,kind:'final-verification' as const,at:new Date().toISOString()};
 assert.throws(()=>store.command('confirm',pending.request,event));
 for(const table of ['recording_records','recording_print_requests','recording_print_jobs','recording_print_events'])assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n,0);
 assert.equal(store.get({attemptId:pending.attempt.id}).attempt!.status,'in-progress');
 fail=false;assert.equal(store.command('confirm',pending.request,event).status,'completed');assert.equal(f.db.prepare('SELECT count(*) n FROM recording_print_jobs').get()!.n,1);
});
test('冷启只将rendering恢复pending一次，旧lease不能完成，新lease可领',async t=>{
 const f=await service(t),pending=await f.readyForFinal();await f.attempts.confirm(pending.request);const lease=f.api.claim({workerId:randomUUID()}).lease!;
 const before=f.db.prepare('SELECT data FROM recording_records').get()!.data;
 const {createCollectionRepository}=await import('../src/collection/repository.js');f.repository.close();
 const repo=createCollectionRepository({filePath:f.filePath});t.after(()=>repo.close());const {createRecordingPrintCoordinator}=await import('../src/recording/print-coordinator.js');const api=createRecordingPrintCoordinator({store:repo.recordingPrints,assertCurrent(){}});t.after(()=>api.close());
 const list=api.list({recordingId:lease.facts.recordingId,page:{offset:0,limit:25}});assert.equal(list.items[0]!.state,'pending');assert.equal(list.items[0]!.revision,3);
 assert.throws(()=>api.fail({leaseId:lease.leaseId,workerId:lease.workerId,jobId:lease.jobId,inputHash:lease.inputHash,errorCode:'RENDER_FAILED'}));
 assert.equal(f.db.prepare('SELECT data FROM recording_records').get()!.data,before);assert.equal(api.claim({workerId:randomUUID()}).lease!.jobId,lease.jobId);
});
test('对象/回执测试预算只可下调，失败不留孤儿Artwork或对象；scope与close拒绝写',async t=>{
 const f=await fixture(t),{createRecordingPrintStore}=await import('../src/recording/print-store.js'),{createRecordingPrintCoordinator}=await import('../src/recording/print-coordinator.js');
 const store=createRecordingPrintStore({read:fn=>fn(f.db),objectBudgetBytes:3});
 assert.throws(()=>store.artworkSave({commandId:randomUUID(),masterVersionId:f.frozenPlan.master.id,expectedVersionId:null,image,userConfirmed:true}),{code:'BUDGET_EXCEEDED'});
 for(const table of ['master_artwork_versions','master_artwork_current','recording_print_objects','recording_print_receipts'])assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n,0);
 const api=createRecordingPrintCoordinator({store:f.repository.recordingPrints,assertCurrent(){throw new Error('合成切库拒绝');}});
 assert.throws(()=>api.artworkGet({masterVersionId:f.frozenPlan.master.id}),/合成切库/);api.close();assert.throws(()=>api.claim({workerId:randomUUID()}),{code:'CLOSED'});
});
test('旧v1只显式backfill且保持原Artwork缺失/Record原字节，重复请求不多建',async t=>{
 const {mkdtemp,readFile,rm}=await import('node:fs/promises'),path=await import('node:path'),os=await import('node:os');
 const directory=await mkdtemp(path.join(os.tmpdir(),'musicbridge-print-backfill-'));t.after(()=>rm(directory,{recursive:true,force:true}));const filePath=path.join(directory,'collection.sqlite'),db=new DatabaseSync(filePath);t.after(()=>db.close());
 db.exec(await readFile(new URL('fixtures/collection-schema20-cassette-completed.sql',import.meta.url),'utf8'));const old=String(db.prepare('SELECT data FROM recording_records').get()!.data),record=JSON.parse(old);
 const {createCollectionRepository}=await import('../src/collection/repository.js'),{createRecordingPrintCoordinator}=await import('../src/recording/print-coordinator.js');
 const repository=createCollectionRepository({filePath});t.after(()=>repository.close());const api=createRecordingPrintCoordinator({store:repository.recordingPrints,assertCurrent(){}});t.after(()=>api.close());
 const plan=JSON.parse(String(db.prepare('SELECT data FROM recording_plan_versions WHERE id=?').get(record.completion.planVersionId)!.data));
 api.artworkSave({commandId:randomUUID(),masterVersionId:plan.master.id,expectedVersionId:null,image,userConfirmed:true});
 assert.equal(api.list({recordingId:record.id,page:{offset:0,limit:25}}).total,0);
 const request={commandId:randomUUID(),recordingId:record.id,expectedRecordHash:record.contentHash,templateId:'jp0-basic-v1' as const,userConfirmed:true as const};
 const job=api.request(request);assert.deepEqual(api.request(request),job);assert.deepEqual(api.request({...request,commandId:randomUUID()}),job);
 const lease=api.claim({workerId:randomUUID()}).lease!;assert.deepEqual(lease.facts.artwork,record.visuals.artwork);assert.equal(lease.artworkImage,null);
 assert.equal(db.prepare('SELECT data FROM recording_records').get()!.data,old);assert.equal(api.list({recordingId:record.id,page:{offset:25,limit:1}}).items.length,0);
 const trigger=String(db.prepare("SELECT sql FROM sqlite_schema WHERE name='recording_print_receipts_no_delete'").get()!.sql);db.exec('DROP TRIGGER recording_print_receipts_no_delete');db.prepare("DELETE FROM recording_print_receipts WHERE kind='request'").run();db.exec(trigger);
 const {verifyRecordingPrintDatabase}=await import('../src/recording/print-integrity.js');assert.throws(()=>verifyRecordingPrintDatabase(db),'旧v1补建请求不能没有明确命令回执');
});
test('空队列或已有活动lease的轮询不扫描Artwork/PDF对象、不建立写事务',async t=>{
 const f=await service(t),{createRecordingPrintStore}=await import('../src/recording/print-store.js');const queries:string[]=[];
 const inspected=new Proxy(f.db,{get(target,key){if(key==='prepare')return (sql:string)=>{queries.push(sql);return target.prepare(sql);};if(key==='exec')return (sql:string)=>{queries.push(sql);return target.exec(sql);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
 const store=createRecordingPrintStore({read:fn=>fn(inspected)});
 assert.deepEqual(store.claim({workerId:randomUUID()}),{lease:null});assert.equal(queries.some(sql=>sql.includes('recording_print_objects')||sql.includes('BEGIN')),false);queries.length=0;
 const pending=await f.readyForFinal();await f.attempts.confirm(pending.request);f.api.claim({workerId:randomUUID()});
 assert.deepEqual(store.claim({workerId:randomUUID()}),{lease:null});assert.equal(queries.some(sql=>sql.includes('recording_print_objects')||sql.includes('BEGIN')),false);
});
