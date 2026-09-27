import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
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
async function objectAuditFixture(t:test.TestContext) {
 const f=await service(t),pending=await f.readyForFinal();await f.attempts.confirm(pending.request);
 const {capacityPdf,capacityJpeg}=await import('./helpers/recording-capacity-fixture.js');
 const pdf=capacityPdf({bytes:4096,id:'audit-pdf'}),jpeg=capacityJpeg({bytes:1024,id:'audit-preview'}),lease=f.api.claim({workerId:randomUUID()}).lease!;
 const pdfSha=createHash('sha256').update(pdf).digest('hex'),jpegSha=createHash('sha256').update(jpeg).digest('hex');
 f.api.complete({jobId:lease.jobId,leaseId:lease.leaseId,workerId:lease.workerId,inputHash:lease.inputHash,pdfBase64:pdf.toString('base64'),pdfSha256:pdfSha,
  preview:{dataUrl:`data:image/jpeg;base64,${jpeg.toString('base64')}`,width:1,height:1},pageCount:1,rendererVersion:'audit-test'});
 const {verifyRecordingPrintSnapshot,verifyRecordingPrintDatabase}=await import('../src/recording/print-integrity.js');
 function verify(budget?:Parameters<typeof verifyRecordingPrintSnapshot>[1]){f.db.exec('BEGIN IMMEDIATE');try{verifyRecordingPrintSnapshot(f.db,budget);}finally{f.db.exec('ROLLBACK');}}
 return {...f,pdf,jpeg,pdfSha,jpegSha,verify,verifyFull:()=>verifyRecordingPrintDatabase(f.db)};
}
test('R023对象快照：只允许活动事务且预算只能下调，超小预算仍完整审计',async t=>{
 const f=await objectAuditFixture(t),{verifyRecordingPrintSnapshot}=await import('../src/recording/print-integrity.js');
 assert.throws(()=>verifyRecordingPrintSnapshot(f.db),{code:'INVALID_REQUEST'});
 f.verify({maxBytes:1,maxEntries:1});f.verifyFull();
 for(const budget of [{maxBytes:128*1024**2+1},{maxBytes:0},{maxEntries:1025},{maxEntries:0}])assert.throws(()=>f.verify(budget),{code:'INVALID_REQUEST'});
 const row=f.db.prepare('SELECT content FROM recording_print_objects WHERE sha256=?').get(f.pdfSha)!,trigger=String(f.db.prepare("SELECT sql FROM sqlite_schema WHERE name='recording_print_objects_no_update'").get()!.sql);
 f.db.exec('DROP TRIGGER recording_print_objects_no_update');f.db.prepare('UPDATE recording_print_objects SET content=? WHERE sha256=?').run(Buffer.alloc(f.pdf.length),f.pdfSha);f.db.exec(trigger);
 try{assert.throws(()=>f.verify({maxBytes:1,maxEntries:1}));assert.throws(f.verifyFull);}finally{f.db.exec('DROP TRIGGER recording_print_objects_no_update');f.db.prepare('UPDATE recording_print_objects SET content=? WHERE sha256=?').run(row.content!,f.pdfSha);f.db.exec(trigger);}
 f.verify();
});
test('R023对象快照：同连接和外连接的等长raw/尺寸/mime/回执篡改下一调用均拒绝',async t=>{
 const f=await objectAuditFixture(t),external=new DatabaseSync(f.filePath);t.after(()=>external.close());
 const variants=[
  {db:f.db,table:'recording_print_objects',key:'sha256',id:f.pdfSha,column:'content',value:Buffer.concat([f.pdf.subarray(0,100),Buffer.from([f.pdf[100]!^1]),f.pdf.subarray(101)])},
  {db:external,table:'recording_print_objects',key:'sha256',id:f.jpegSha,column:'content',value:Buffer.concat([f.jpeg.subarray(0,50),Buffer.from([f.jpeg[50]!^1]),f.jpeg.subarray(51)])},
  {db:f.db,table:'recording_print_objects',key:'sha256',id:f.pdfSha,column:'width',value:1},
  {db:external,table:'recording_print_objects',key:'sha256',id:f.pdfSha,column:'mime',value:'image/jpeg'},
  {db:external,table:'recording_print_receipts',key:'id',id:String(f.db.prepare("SELECT id FROM recording_print_receipts WHERE kind='complete'").get()!.id),column:'fingerprint',value:'a'.repeat(64)},
 ];
 for(const item of variants){
  f.verify();const triggerName=`${item.table}_no_update`,trigger=String(item.db.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(triggerName)!.sql),original=item.db.prepare(`SELECT ${item.column} value FROM ${item.table} WHERE ${item.key}=?`).get(item.id)!.value;
  const set=(value:typeof original)=>{item.db.exec('BEGIN IMMEDIATE');item.db.exec(`DROP TRIGGER ${triggerName}`);item.db.prepare(`UPDATE ${item.table} SET ${item.column}=? WHERE ${item.key}=?`).run(value!,item.id);item.db.exec(trigger);item.db.exec('COMMIT');};
  set(item.value);try{assert.throws(()=>f.verify());assert.throws(f.verifyFull);}finally{set(original);}
  f.verify();
 }
});
test('R023对象快照：命中时仍比对当前raw，同一调用内受控变更也不能沿用结果',async t=>{
 const f=await objectAuditFixture(t),{verifyRecordingPrintSnapshot}=await import('../src/recording/print-integrity.js');let reads=0;
 const trigger=String(f.db.prepare("SELECT sql FROM sqlite_schema WHERE name='recording_print_objects_no_update'").get()!.sql);
 const inspected=new Proxy(f.db,{get(target,key){if(key==='prepare')return (sql:string)=>{
  const statement=target.prepare(sql);if(sql!=='SELECT * FROM recording_print_objects WHERE sha256=?')return statement;
  return new Proxy(statement,{get(item,method){if(method==='get')return (...values:SQLInputValue[])=>{
   if(values[0]===f.pdfSha&&++reads===2){target.exec('DROP TRIGGER recording_print_objects_no_update');target.prepare('UPDATE recording_print_objects SET content=? WHERE sha256=?').run(Buffer.alloc(f.pdf.length),f.pdfSha);target.exec(trigger);}
   return statement.get(...values);
  };const value=Reflect.get(item,method,item);return typeof value==='function'?value.bind(item):value;}});
 };const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
 f.db.exec('BEGIN IMMEDIATE');try{assert.throws(()=>verifyRecordingPrintSnapshot(inspected));assert.equal(reads,2);}finally{f.db.exec('ROLLBACK');}
 f.verify();f.verifyFull();
});
test('R023对象快照：缺失/孤儿/截短对象与artifact/receipt关联仍全量拒绝',async t=>{
 const f=await objectAuditFixture(t),{verifyRecordingPrintSnapshot}=await import('../src/recording/print-integrity.js');
 const changes=[
  ()=>{f.db.exec('DROP TRIGGER recording_print_objects_no_delete');f.db.prepare('DELETE FROM recording_print_objects WHERE sha256=?').run(f.pdfSha);f.db.exec(objectDelete);},
  ()=>{const bytes=Buffer.from('%PDF-1.7\nOrphan\n%%EOF\n');f.db.prepare("INSERT INTO recording_print_objects VALUES(?,'application/pdf',?,NULL,NULL)").run(createHash('sha256').update(bytes).digest('hex'),bytes);},
  ()=>{f.db.exec('DROP TRIGGER recording_print_objects_no_update');f.db.prepare('UPDATE recording_print_objects SET content=? WHERE sha256=?').run(f.pdf.subarray(0,-1),f.pdfSha);f.db.exec(objectUpdate);},
  ()=>{f.db.exec('DROP TRIGGER recording_print_artifacts_no_update');f.db.exec("UPDATE recording_print_artifacts SET data=json_set(data,'$.rendererVersion','changed')");f.db.exec(artifactUpdate);},
  ()=>{f.db.exec('DROP TRIGGER recording_print_receipts_no_delete');f.db.exec("DELETE FROM recording_print_receipts WHERE kind='complete'");f.db.exec(receiptDelete);},
 ];
 const schema=(name:string)=>String(f.db.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(name)!.sql);
 const objectDelete=schema('recording_print_objects_no_delete'),objectUpdate=schema('recording_print_objects_no_update'),artifactUpdate=schema('recording_print_artifacts_no_update'),receiptDelete=schema('recording_print_receipts_no_delete');
 // 仅故障构造关闭外键写保护；验证器的foreign_key_check仍必须发现缺引用，最后恢复原保护。
 f.db.exec('PRAGMA foreign_keys=OFF');
 try{for(const change of changes){f.db.exec('BEGIN IMMEDIATE');try{change();assert.throws(()=>verifyRecordingPrintSnapshot(f.db));assert.throws(f.verifyFull);}finally{f.db.exec('ROLLBACK');}f.verify();}}
 finally{f.db.exec('PRAGMA foreign_keys=ON');}
});
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

test('同录音可新建两个冻结设计版本，不覆盖完成时请求/旧PDF；失败只重试原job',async t=>{
 const f=await service(t),pending=await f.readyForFinal();await f.attempts.confirm(pending.request);
 const record=JSON.parse(String(f.db.prepare('SELECT data FROM recording_records').get()!.data));
 const {RECORDING_PRINT_GEOMETRY}=await import('@music-bridge/contracts');
 const design={schemaVersion:1 as const,geometry:structuredClone(RECORDING_PRINT_GEOMETRY),coverTitle:'版本一封面',spineText:'版本一脊',artworkSource:'recording-snapshot' as const,qr:'none' as const};
 const base={recordingId:record.id,expectedRecordHash:record.contentHash,templateId:'jp0-basic-v1' as const,userConfirmed:true as const,mode:'new-version' as const};
 const firstRequest={...base,commandId:randomUUID(),design},first=f.api.request(firstRequest);
 assert.deepEqual(f.api.request(firstRequest),first);assert.equal(first.request.origin,'manual-version');assert.equal(first.request.design?.coverTitle,'版本一封面');
 const second=f.api.request({...base,commandId:randomUUID(),design:{...design,coverTitle:'版本二封面'}});
 assert.notEqual(first.id,second.id);assert.notEqual(first.request.id,second.request.id);assert.notEqual(first.request.inputHash,second.request.inputHash);
 const list=f.api.list({recordingId:record.id,page:{offset:0,limit:25}});assert.equal(list.total,3);assert.equal(list.items.filter(job=>job.request.origin==='completion').length,1);
 const auto=f.api.claim({workerId:randomUUID()}).lease!;assert.equal(auto.design,undefined);
 f.api.fail({leaseId:auto.leaseId,workerId:auto.workerId,jobId:auto.jobId,inputHash:auto.inputHash,errorCode:'RENDER_FAILED'});
 const manual=f.api.claim({workerId:randomUUID()}).lease!;assert.deepEqual(manual.design,design);
 const failed=f.api.fail({leaseId:manual.leaseId,workerId:manual.workerId,jobId:manual.jobId,inputHash:manual.inputHash,errorCode:'LAYOUT_OVERFLOW'});
 const retry=f.api.retry({commandId:randomUUID(),jobId:failed.id,expectedRevision:failed.revision,userConfirmed:true});
 assert.equal(retry.id,first.id);assert.equal(retry.request.id,first.request.id);assert.equal(f.db.prepare('SELECT count(*) n FROM recording_print_requests').get()!.n,3);
});

test('新模板选图只在确认请求事务入对象，领用冻结图片，手工回执设计与闭包不可冒充',async t=>{
 const f=await service(t),pending=await f.readyForFinal();await f.attempts.confirm(pending.request);
 const record=JSON.parse(String(f.db.prepare('SELECT data FROM recording_records').get()!.data));
 const {RECORDING_PRINT_GEOMETRY,RECORDING_PRINT_DESIGN_TEMPLATE_ID}=await import('@music-bridge/contracts');
 const imageBytes=Buffer.from(image.dataUrl.slice(23),'base64'),sha256=createHash('sha256').update(imageBytes).digest('hex');
 const geometry={...structuredClone(RECORDING_PRINT_GEOMETRY),coverMm:70,widthMm:108.1,widthPt:Number((108.1*72/25.4).toFixed(2)),insideFoldMm:[70,82.7] as const};
 const design={schemaVersion:2 as const,geometry,coverTitle:'选图版本',spineText:'只改排版',image:{source:'selected-image' as const,object:{sha256,size:imageBytes.length,width:1,height:1}},qr:'recording-summary' as const};
 const base={commandId:randomUUID(),recordingId:record.id,expectedRecordHash:record.contentHash,templateId:RECORDING_PRINT_DESIGN_TEMPLATE_ID,userConfirmed:true as const,mode:'new-version' as const,design,designImage:image};
 const originalObjects=Number(f.db.prepare('SELECT count(*) n FROM recording_print_objects').get()!.n);
 assert.throws(()=>f.api.request({...base,design:{...design,image:{source:'selected-image' as const,object:{...design.image.object,sha256:'a'.repeat(64)}}}}),{code:'INVALID_REQUEST'});
 assert.equal(f.db.prepare('SELECT count(*) n FROM recording_print_objects').get()!.n,originalObjects);
 const job=f.api.request(base);assert.deepEqual(f.api.request(base),job);
 assert.equal(job.request.templateId,RECORDING_PRINT_DESIGN_TEMPLATE_ID);
 assert.equal(f.db.prepare('SELECT count(*) n FROM recording_print_objects').get()!.n,originalObjects+1);
 const receipt=f.db.prepare("SELECT * FROM recording_print_receipts WHERE kind='request' AND json_extract(result,'$.id')=?").get(job.id)!;
 assert.equal(String(receipt.request).includes('data:image'),false,'回执不重复写选图 base64');
 const auto=f.api.claim({workerId:randomUUID()}).lease!;f.api.fail({leaseId:auto.leaseId,workerId:auto.workerId,jobId:auto.jobId,inputHash:auto.inputHash,errorCode:'RENDER_FAILED'});
 const selected=f.api.claim({workerId:randomUUID()}).lease!;assert.deepEqual(selected.designImage,image);assert.deepEqual(selected.design,design);
 const pdf=Buffer.from('%PDF-1.7\n合成多页对象\n%%EOF\n'),pdfSha256=createHash('sha256').update(pdf).digest('hex');
 const ready=f.api.complete({leaseId:selected.leaseId,workerId:selected.workerId,jobId:selected.jobId,inputHash:selected.inputHash,pdfBase64:pdf.toString('base64'),pdfSha256,preview:image,pagePreviews:[image,image],pageCount:2,rendererVersion:'jc-design-test'});
 const printed=f.api.get({recordingId:record.id,artifactId:ready.artifactId!});assert.deepEqual(printed.artifact.geometry,geometry);assert.deepEqual(printed.design,design);assert.equal(printed.previewPages?.length,2);
 assert.equal(f.db.prepare('SELECT data FROM recording_records WHERE id=?').get(record.id)!.data,JSON.stringify(record));
 const {verifyRecordingPrintDatabase}=await import('../src/recording/print-integrity.js');verifyRecordingPrintDatabase(f.db);
 const {mediaFingerprint}=await import('../src/recording/media-store.js');
 const changed=JSON.parse(String(receipt.request));changed.design.coverTitle='伪造的回执设计';
 const updateTrigger=String(f.db.prepare("SELECT sql FROM sqlite_schema WHERE name='recording_print_receipts_no_update'").get()!.sql);
 f.db.exec('DROP TRIGGER recording_print_receipts_no_update');
 f.db.prepare('UPDATE recording_print_receipts SET request=?,fingerprint=? WHERE id=?').run(JSON.stringify(changed),mediaFingerprint({...changed,designImage:image}),receipt.id!);
 f.db.exec(updateTrigger);assert.throws(()=>verifyRecordingPrintDatabase(f.db),'回执设计不同于冻结请求应拒绝');
 f.db.exec('DROP TRIGGER recording_print_receipts_no_update');f.db.prepare('UPDATE recording_print_receipts SET request=?,fingerprint=? WHERE id=?').run(receipt.request!,receipt.fingerprint!,receipt.id!);f.db.exec(updateTrigger);
 verifyRecordingPrintDatabase(f.db);
 const trigger=String(f.db.prepare("SELECT sql FROM sqlite_schema WHERE name='recording_print_receipts_no_delete'").get()!.sql);
 f.db.exec('DROP TRIGGER recording_print_receipts_no_delete');f.db.prepare("DELETE FROM recording_print_receipts WHERE kind='request' AND json_extract(result,'$.id')=?").run(job.id);f.db.exec(trigger);
 assert.throws(()=>verifyRecordingPrintDatabase(f.db),'手工新版本缺明确回执应失败');
});

test('24页预览仅把Hash/尺寸摘要写回执，真实对象与指纹同请求验证且预算有界',async t=>{
 const f=await service(t),pending=await f.readyForFinal();await f.attempts.confirm(pending.request);
 const {capacityPdf,capacityJpeg}=await import('./helpers/recording-capacity-fixture.js');
 const lease=f.api.claim({workerId:randomUUID()}).lease!,pdf=capacityPdf({bytes:4096,id:'many-pages'});
 const pagePreviews=Array.from({length:24},(_,index)=>({dataUrl:`data:image/jpeg;base64,${capacityJpeg({bytes:24_000,id:`page-${index}`}).toString('base64')}`,width:1,height:1}));
 const complete={leaseId:lease.leaseId,workerId:lease.workerId,jobId:lease.jobId,inputHash:lease.inputHash,pdfBase64:pdf.toString('base64'),pdfSha256:createHash('sha256').update(pdf).digest('hex'),preview:pagePreviews[0]!,pagePreviews,pageCount:24,rendererVersion:'paged-budget-test'};
 const ready=f.api.complete(complete);assert.deepEqual(f.api.complete(complete),ready);
 const receipt=f.db.prepare("SELECT request FROM recording_print_receipts WHERE kind='complete'").get()!;
 assert.ok(Buffer.byteLength(String(receipt.request))<10_000,'回执只留24页Hash/尺寸摘要');assert.equal(String(receipt.request).includes('data:image'),false);
 const summary=JSON.parse(String(receipt.request)).pagePreviews;assert.equal(summary.length,24);assert.match(summary[23].sha256,/^[a-f0-9]{64}$/);
 const result=f.api.get({recordingId:lease.facts.recordingId,artifactId:ready.artifactId!});assert.equal(result.previewPages?.length,24);assert.equal(result.artifact.previewPages?.length,24);
 const {verifyRecordingPrintDatabase}=await import('../src/recording/print-integrity.js');verifyRecordingPrintDatabase(f.db);
 assert.throws(()=>f.api.complete({...complete,pagePreviews:[...pagePreviews.slice(0,23),pagePreviews[0]!]}),{code:'COMMAND_CONFLICT'});
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

test('R023对象凭证：claim完整审计后complete只读取本轮新对象，不重读历史Artwork原字节',async t=>{
 const f=await service(t),masterVersionId=f.frozenPlan.master.id;
 const artwork=f.api.artworkSave({commandId:randomUUID(),masterVersionId,expectedVersionId:null,image,userConfirmed:true});
 const pending=await f.readyForFinal();await f.attempts.confirm(pending.request);
 const reads=new Map<string,number>(),inspected=new Proxy(f.db,{get(target,key){
  if(key==='prepare')return (sql:string)=>{
   const statement=target.prepare(sql);if(sql!=='SELECT * FROM recording_print_objects WHERE sha256=?')return statement;
   return new Proxy(statement,{get(item,method){if(method==='get')return (...values:SQLInputValue[])=>{
    const sha=String(values[0]);reads.set(sha,(reads.get(sha)??0)+1);return statement.get(...values);
   };const value=Reflect.get(item,method,item);return typeof value==='function'?value.bind(item):value;}});
  };
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});
 const {createRecordingPrintStore}=await import('../src/recording/print-store.js'),{createObjectAuditCertificateManager}=await import('../src/recording/object-audit-certificate.js');
 const objectCertificates=createObjectAuditCertificateManager(),claimStore=createRecordingPrintStore({read:fn=>fn(inspected),objectCertificates});
 const lease=claimStore.claim({workerId:randomUUID()}).lease!;assert.ok(lease);
 const artworkReadsAfterClaim=reads.get(artwork.sha256)??0;assert.ok(artworkReadsAfterClaim>0,'首次claim必须真实读取历史Artwork');
 const {capacityPdf,capacityJpeg}=await import('./helpers/recording-capacity-fixture.js');
 const pdf=capacityPdf({bytes:4096,id:'shared-certificate-pdf'}),preview=capacityJpeg({bytes:1024,id:'shared-certificate-preview'}),pdfSha256=createHash('sha256').update(pdf).digest('hex'),previewSha256=createHash('sha256').update(preview).digest('hex');
 const completeStore=createRecordingPrintStore({read:fn=>fn(inspected),objectCertificates});
 completeStore.complete({jobId:lease.jobId,leaseId:lease.leaseId,workerId:lease.workerId,inputHash:lease.inputHash,pdfBase64:pdf.toString('base64'),pdfSha256,
  preview:{dataUrl:`data:image/jpeg;base64,${preview.toString('base64')}`,width:1,height:1},pageCount:1,rendererVersion:'object-certificate-test'});
 assert.equal(reads.get(artwork.sha256),artworkReadsAfterClaim,'complete不得重读已由同连接claim完整核验的历史Artwork BLOB');
 assert.ok((reads.get(pdfSha256)??0)>0);assert.ok((reads.get(previewSha256)??0)>0);
});

test('R023对象凭证：complete同事务额外写使精确delta失效并在本次及重放恢复完整审计',async t=>{
 const f=await service(t),masterVersionId=f.frozenPlan.master.id;
 const artwork=f.api.artworkSave({commandId:randomUUID(),masterVersionId,expectedVersionId:null,image,userConfirmed:true});
 const pending=await f.readyForFinal();await f.attempts.confirm(pending.request);
 let injected=false;
 const reads=new Map<string,number>(),inspected=new Proxy(f.db,{get(target,key){
  if(key==='prepare')return (sql:string)=>{const statement=target.prepare(sql);
   if(sql==='SELECT * FROM recording_print_objects WHERE sha256=?')return new Proxy(statement,{get(item,method){if(method==='get')return (...values:SQLInputValue[])=>{const sha=String(values[0]);reads.set(sha,(reads.get(sha)??0)+1);return statement.get(...values);};const value=Reflect.get(item,method,item);return typeof value==='function'?value.bind(item):value;}});
   if(sql==='INSERT INTO recording_print_artifacts VALUES(?,?,?,?,?)')return new Proxy(statement,{get(item,method){if(method==='run')return (...values:SQLInputValue[])=>{const result=statement.run(...values);if(!injected){target.prepare('UPDATE physical_copies SET revision=revision WHERE physical_id=?').run(pending.attempt.physicalId);injected=true;}return result;};const value=Reflect.get(item,method,item);return typeof value==='function'?value.bind(item):value;}});
   return statement;};
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});
 const {createRecordingPrintStore}=await import('../src/recording/print-store.js'),{createObjectAuditCertificateManager}=await import('../src/recording/object-audit-certificate.js'),objectCertificates=createObjectAuditCertificateManager();
 const store=createRecordingPrintStore({read:fn=>fn(inspected),objectCertificates}),lease=store.claim({workerId:randomUUID()}).lease!;
 const before=reads.get(artwork.sha256)??0;assert.ok(before>0);
 const {capacityPdf,capacityJpeg}=await import('./helpers/recording-capacity-fixture.js');
 const pdf=capacityPdf({bytes:4096,id:'same-transaction-invalidated-pdf'}),preview=capacityJpeg({bytes:1024,id:'same-transaction-invalidated-preview'}),pdfSha256=createHash('sha256').update(pdf).digest('hex');
 const completeRequest={jobId:lease.jobId,leaseId:lease.leaseId,workerId:lease.workerId,inputHash:lease.inputHash,pdfBase64:pdf.toString('base64'),pdfSha256,
  preview:{dataUrl:`data:image/jpeg;base64,${preview.toString('base64')}`,width:1,height:1},pageCount:1,rendererVersion:'object-certificate-test'};
 store.complete(completeRequest);assert.equal(injected,true);
 const afterComplete=reads.get(artwork.sha256)??0;assert.ok(afterComplete>before,'同事务未知写使complete候选失效后必须立即完整读取历史Artwork');
 store.complete(completeRequest);
 assert.ok((reads.get(artwork.sha256)??0)>afterComplete,'失效候选不得发布；幂等重放必须从完整审计重新建立事实');
});

test('R023对象凭证：claim同事务额外写使精确delta失效且complete不能继承该候选',async t=>{
 const f=await service(t),masterVersionId=f.frozenPlan.master.id;
 const artwork=f.api.artworkSave({commandId:randomUUID(),masterVersionId,expectedVersionId:null,image,userConfirmed:true});
 const pending=await f.readyForFinal();await f.attempts.confirm(pending.request);
 let injected=false,recordSnapshotScans=0;
 const reads=new Map<string,number>(),inspected=new Proxy(f.db,{get(target,key){
  if(key==='prepare')return (sql:string)=>{const statement=target.prepare(sql);
   if(sql==="SELECT sql FROM sqlite_schema WHERE name GLOB 'recording_record*'")recordSnapshotScans+=1;
   if(sql==='SELECT * FROM recording_print_objects WHERE sha256=?')return new Proxy(statement,{get(item,method){if(method==='get')return (...values:SQLInputValue[])=>{const sha=String(values[0]);reads.set(sha,(reads.get(sha)??0)+1);return statement.get(...values);};const value=Reflect.get(item,method,item);return typeof value==='function'?value.bind(item):value;}});
   if(sql==='INSERT INTO recording_print_events VALUES(?,?,?,?,?,?)')return new Proxy(statement,{get(item,method){if(method==='run')return (...values:SQLInputValue[])=>{const result=statement.run(...values);if(!injected){target.prepare('UPDATE physical_copies SET revision=revision WHERE physical_id=?').run(pending.attempt.physicalId);injected=true;}return result;};const value=Reflect.get(item,method,item);return typeof value==='function'?value.bind(item):value;}});
   return statement;};
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});
 const {createRecordingPrintStore}=await import('../src/recording/print-store.js'),{createObjectAuditCertificateManager}=await import('../src/recording/object-audit-certificate.js'),objectCertificates=createObjectAuditCertificateManager();
 const store=createRecordingPrintStore({read:fn=>fn(inspected),objectCertificates}),lease=store.claim({workerId:randomUUID()}).lease!;
 assert.equal(injected,true);assert.ok(recordSnapshotScans>=2,'claim必须执行事务前完整审计和delta失效后的提交前回退审计');
 const afterClaim=reads.get(artwork.sha256)??0;assert.ok(afterClaim>0);
 const {capacityPdf,capacityJpeg}=await import('./helpers/recording-capacity-fixture.js');
 const pdf=capacityPdf({bytes:4096,id:'claim-invalidated-pdf'}),preview=capacityJpeg({bytes:1024,id:'claim-invalidated-preview'}),pdfSha256=createHash('sha256').update(pdf).digest('hex');
 store.complete({jobId:lease.jobId,leaseId:lease.leaseId,workerId:lease.workerId,inputHash:lease.inputHash,pdfBase64:pdf.toString('base64'),pdfSha256,
  preview:{dataUrl:`data:image/jpeg;base64,${preview.toString('base64')}`,width:1,height:1},pageCount:1,rendererVersion:'object-certificate-test'});
 assert.ok((reads.get(artwork.sha256)??0)>afterClaim,'claim失效候选不得被complete继承');
});

test('R023原字节格式：PDF标准编码与旧公开guard在头尾白字符和大小边界逐项等价',async()=>{
 const {isRecordingPrintPdfBytes}=await import('../src/recording/object-format-integrity.js');
 const {isRecordingPrintPdfBase64,MAX_RECORDING_PRINT_PDF_BYTES}=await import('@music-bridge/contracts');
 const cases=[Buffer.alloc(0),Buffer.from('%PDF-%%EOF'),Buffer.from('%PDF-1\n%%EOF'),Buffer.from('x%PDF-1\n%%EOF'),Buffer.from('%pdf-1\n%%EOF'),Buffer.from('%PDF-1\n%%EO'),Buffer.from('%PDF-1\n%%EOF\r\n\t ')];
 for(let byte=0;byte<256;byte++)cases.push(Buffer.concat([Buffer.from('%PDF-1\n%%EOF'),Buffer.from([byte])]));
 for(const bytes of cases)assert.equal(isRecordingPrintPdfBytes(bytes),isRecordingPrintPdfBase64(bytes.toString('base64')),bytes.toString('hex'));
 for(const size of [MAX_RECORDING_PRINT_PDF_BYTES-1,MAX_RECORDING_PRINT_PDF_BYTES,MAX_RECORDING_PRINT_PDF_BYTES+1]){
  const bytes=Buffer.alloc(size,32);bytes.write('%PDF-');bytes.write('%%EOF',size-5);
  assert.equal(isRecordingPrintPdfBytes(bytes),isRecordingPrintPdfBase64(bytes.toString('base64')),String(size));
 }
});
test('R023原字节格式：JPEG保持Collection编码上限和Artwork实际大小的不同边界',async()=>{
 const {isCollectionPhotoBytes,isMasterArtworkBytes}=await import('../src/recording/object-format-integrity.js');
 const c=await import('@music-bridge/contracts');
 for(const size of [0,1,2,3,4,5,6,c.MAX_COLLECTION_PHOTO_BYTES-1,c.MAX_COLLECTION_PHOTO_BYTES,c.MAX_COLLECTION_PHOTO_BYTES+1,c.MAX_COLLECTION_PHOTO_BYTES+2,c.MAX_COLLECTION_PHOTO_BYTES+3]){
  const bytes=Buffer.alloc(size);for(let index=0;index<Math.min(3,size);index++)bytes[index]=[255,216,255][index]!;
  const value={dataUrl:'data:image/jpeg;base64,'+bytes.toString('base64'),width:1,height:1200};
  assert.equal(isCollectionPhotoBytes(bytes,1,1200),c.isCollectionPhotoImage(value),'Collection '+size);
  assert.equal(isMasterArtworkBytes(bytes,1,1200),c.isMasterArtworkImage(value),'Artwork '+size);
 }
 for(const prefix of [[254,216,255],[255,217,255],[255,216,254],[255,216,255]])for(const width of [0,1,1200,1201,1.1,'1',null,NaN]){
  const bytes=Buffer.from([...prefix,217]),value={dataUrl:'data:image/jpeg;base64,'+bytes.toString('base64'),width,height:1};
  assert.equal(isCollectionPhotoBytes(bytes,width,1),c.isCollectionPhotoImage(value));assert.equal(isMasterArtworkBytes(bytes,width,1),c.isMasterArtworkImage(value));
 }
});

test('R023原字节格式：真实对象自洽SHA也不能绕过格式和mime/尺寸验证',async t=>{
 const {printObject}=await import('../src/recording/print-integrity.js'),db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec('CREATE TABLE recording_print_objects(sha256 TEXT,mime TEXT,content BLOB,width INTEGER,height INTEGER) STRICT');
 for(const item of [
  {bytes:Buffer.from('not PDF but correct SHA'),mime:'application/pdf',width:null,height:null,ok:false},
  {bytes:Buffer.from('%PDF-1\n%%EOF\v'),mime:'application/pdf',width:null,height:null,ok:false},
  {bytes:Buffer.from('%PDF-1\n%%EOF\n'),mime:'application/pdf',width:1,height:null,ok:false},
  {bytes:Buffer.from([255,216,254,217]),mime:'image/jpeg',width:1,height:1,ok:false},
  {bytes:Buffer.from([255,216,255,217]),mime:'image/jpeg',width:1201,height:1,ok:false},
  {bytes:Buffer.from([255,216,255,217]),mime:'image/jpeg',width:1,height:1,ok:true},
  {bytes:Buffer.from('%PDF-1\n%%EOF\r\n'),mime:'application/pdf',width:null,height:null,ok:true},
 ]){
  const sha=createHash('sha256').update(item.bytes).digest('hex');db.prepare('DELETE FROM recording_print_objects').run();db.prepare('INSERT INTO recording_print_objects VALUES(?,?,?,?,?)').run(sha,item.mime,item.bytes,item.width,item.height);
  if(item.ok)assert.deepEqual(printObject(db,sha).bytes,item.bytes);else assert.throws(()=>printObject(db,sha));
 }
});
test('R023原字节格式：字段拆分仍完整绑定真实对象、lease和原请求fingerprint',async t=>{
 const f=await objectAuditFixture(t),{mediaFingerprint}=await import('../src/recording/media-store.js');
 f.api.artworkSave({commandId:randomUUID(),masterVersionId:f.frozenPlan.master.id,expectedVersionId:null,image,userConfirmed:true});
 const complete=f.db.prepare("SELECT * FROM recording_print_receipts WHERE kind='complete'").get()!,artwork=f.db.prepare("SELECT * FROM recording_print_receipts WHERE kind='artwork'").get()!;
 const material=(kind:string)=>kind==='complete'?{pdfBase64:f.pdf.toString('base64'),preview:{dataUrl:'data:image/jpeg;base64,'+f.jpeg.toString('base64'),width:1,height:1}}:{image};
 const trigger=String(f.db.prepare("SELECT sql FROM sqlite_schema WHERE name='recording_print_receipts_no_update'").get()!.sql);
 for(const row of [complete,artwork]){
  const request=JSON.parse(String(row.request));assert.equal(mediaFingerprint({...request,...material(String(row.kind))}),row.fingerprint,'仍逐字节使用历史原canonical');
  const variants=row.kind==='complete'?[{pageCount:0},{rendererVersion:'bad\n'},{workerId:randomUUID()},{pdfSha256:'a'.repeat(64)},{trusted:true}]:[{userConfirmed:false},{commandId:randomUUID()},{expectedVersionId:randomUUID()},{trusted:true}];
  for(const patch of variants){
   const changed={...request,...patch};f.db.exec('BEGIN IMMEDIATE');
   try{
    f.db.exec('DROP TRIGGER recording_print_receipts_no_update');f.db.prepare('UPDATE recording_print_receipts SET request=?,fingerprint=? WHERE id=?').run(JSON.stringify(changed),mediaFingerprint({...changed,...material(String(row.kind))}),row.id!);f.db.exec(trigger);
    const {verifyRecordingPrintSnapshot}=await import('../src/recording/print-integrity.js');assert.throws(()=>verifyRecordingPrintSnapshot(f.db));assert.throws(f.verifyFull);
   }finally{f.db.exec('ROLLBACK');}
  }
 }
 f.verify();f.verifyFull();assert.deepEqual(f.db.prepare("SELECT * FROM recording_print_receipts WHERE kind='complete'").get(),complete);
});
