import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { recordingRecordFixture } from './helpers/recording-record-fixture.js';

const photoImage = { dataUrl: 'data:image/jpeg;base64,/9j/2Q==', width: 1, height: 1 };
function inventory(db: DatabaseSync) {
  return ['inventory_lots', 'physical_sequences', 'inventory_ledger'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}
test('首次Completed同事务生成不可变档案、当前内容与recorded状态，不新增库存或重复登记', async t => {
  const f = await recordingRecordFixture(t), db = new DatabaseSync(f.filePath); t.after(() => db.close());
  const before = inventory(db), { attempt, request } = await f.readyForFinal();
  const completed = await f.attempts.confirm(request); assert.equal(completed.status, 'completed');
  const records = db.prepare('SELECT * FROM recording_records').all(); assert.equal(records.length, 1);
  const record = JSON.parse(String(records[0]!.data));
  assert.deepEqual(record.completion, completed); assert.equal(record.media.snapshotSource, 'completion');
  assert.equal(db.prepare('SELECT usage FROM physical_copies WHERE physical_id=?').get(attempt.physicalId)!.usage, 'recorded');
  const head = JSON.parse(String(db.prepare('SELECT data FROM recording_record_current WHERE physical_id=?').get(attempt.physicalId)!.data));
  assert.equal(head.knowledge.recordingId, record.id); assert.equal(head.knowledge.state, 'confirmed-recording');
  assert.deepEqual(inventory(db), before); assert.deepEqual(await f.attempts.confirm(request), completed);
  assert.equal(db.prepare('SELECT count(*) n FROM recording_records').get()!.n, 1);
  assert.throws(() => db.prepare("UPDATE recording_records SET data='{}'").run());
});

test('照片仅捕获同Physical JPEG，删除原照不改变历史字节或快照', async t => {
  const f = await recordingRecordFixture(t), physicalId = f.frozenPlan.physicalCopy.physicalId, modelId = f.frozenPlan.layout.reservation.modelId;
  f.repository.addPhoto({ commandId: randomUUID(), modelId, image: photoImage });
  const added = f.repository.addPhoto({ commandId: randomUUID(), modelId, physicalId, image: photoImage });
  const pending = await f.readyForFinal(); await f.attempts.confirm(pending.request);
  const db = new DatabaseSync(f.filePath); t.after(() => db.close());
  const data = String(db.prepare('SELECT data FROM recording_records').get()!.data), record = JSON.parse(data);
  assert.equal(record.visuals.photos.attachments.length, 1); assert.equal(record.visuals.photos.attachments[0].sourcePhotoId, added.photoId);
  const bytes = db.prepare('SELECT content FROM recording_record_visuals').get()!.content;
  f.repository.changePhoto({ commandId: randomUUID(), modelId, photoId: added.photoId!, expectedRevision: f.repository.detail(modelId, {offset:0,limit:1}).model.revision, action: 'remove' });
  assert.equal(db.prepare('SELECT data FROM recording_records').get()!.data, data);
  assert.deepEqual(db.prepare('SELECT content FROM recording_record_visuals').get()!.content, bytes);
  const visual = f.repository.recordingRecords.visual({recordingId:record.id,attachmentId:record.visuals.photos.attachments[0].id});
  assert.deepEqual(visual.image,photoImage);
  assert.throws(()=>f.repository.recordingRecords.visual({recordingId:randomUUID(),attachmentId:record.visuals.photos.attachments[0].id}));
});

test('最终确认的提交故障回滚Record/照片/usage/current，原命令可明确重试', async t => {
  const f=await recordingRecordFixture(t), pending=await f.readyForFinal();
  const { createRecordingAttemptStore }=await import('../src/recording/attempt-store.js');
  const db=new DatabaseSync(f.filePath);t.after(()=>db.close());
  let fail=true;
  const store=createRecordingAttemptStore({read:fn=>fn(db),beforeCommit(){if(fail)throw new Error('合成最终提交故障');}});
  const before=db.prepare('SELECT * FROM physical_copies').all(),head=db.prepare('SELECT * FROM recording_record_current').all();
  const event={type:'confirm' as const,kind:'final-verification' as const,at:new Date().toISOString()};
  assert.throws(()=>store.command('confirm',pending.request,event));
  assert.equal(db.prepare('SELECT count(*) n FROM recording_records').get()!.n,0);
  assert.deepEqual(db.prepare('SELECT * FROM physical_copies').all(),before);assert.deepEqual(db.prepare('SELECT * FROM recording_record_current').all(),head);
  assert.equal(store.get({attemptId:pending.attempt.id}).attempt!.status,'in-progress');
  fail=false;assert.equal(store.command('confirm',pending.request,event).status,'completed');
});

test('真实照片超测试收紧预算时整次完成拒绝，不静默丢照或登记成功',async t=>{
  const f=await recordingRecordFixture(t), physicalId=f.frozenPlan.physicalCopy.physicalId,modelId=f.frozenPlan.layout.reservation.modelId;
  f.repository.addPhoto({commandId:randomUUID(),modelId,physicalId,image:photoImage});
  const pending=await f.readyForFinal(),db=new DatabaseSync(f.filePath);t.after(()=>db.close());
  const {createRecordingAttemptStore}=await import('../src/recording/attempt-store.js');
  const store=createRecordingAttemptStore({read:fn=>fn(db),visualBudgetBytes:3});
  assert.throws(()=>store.command('confirm',pending.request,{type:'confirm',kind:'final-verification',at:new Date().toISOString()}));
  assert.equal(store.get({attemptId:pending.attempt.id}).attempt!.status,'in-progress');
  assert.equal(db.prepare('SELECT count(*) n FROM recording_records').get()!.n,0);assert.equal(db.prepare('SELECT count(*) n FROM recording_record_visuals').get()!.n,0);
  assert.equal(db.prepare('SELECT usage FROM physical_copies WHERE physical_id=?').get(physicalId)!.usage,'reserved');
  assert.equal((await f.attempts.confirm(pending.request)).status,'completed');
});

test('Record快照被改后重算自身Hash仍须被独立完成事件绑定拒绝',async t=>{
  const f=await recordingRecordFixture(t),pending=await f.readyForFinal();await f.attempts.confirm(pending.request);
  const db=new DatabaseSync(f.filePath);t.after(()=>db.close());
  const {verifyRecordingRecordDatabase}=await import('../src/recording/record-integrity.js');
  const {mediaFingerprint}=await import('../src/recording/media-store.js');
  verifyRecordingRecordDatabase(db);
  const trigger=String(db.prepare("SELECT sql FROM sqlite_schema WHERE name='recording_records_no_update'").get()!.sql);
  const record=JSON.parse(String(db.prepare('SELECT data FROM recording_records').get()!.data));record.media.descriptor.brand='被篡改品牌';
  const {contentHash:_,...body}=record;record.contentHash=mediaFingerprint(body);
  db.exec('DROP TRIGGER recording_records_no_update');db.prepare('UPDATE recording_records SET data=?').run(JSON.stringify(record));db.exec(trigger);
 assert.throws(()=>verifyRecordingRecordDatabase(db));
});

test('R023 Record完整审计一次读取Attempt物理索引，不按每条Record反复扫描历史表',async t=>{
 const f=await recordingRecordFixture(t),pending=await f.readyForFinal();await f.attempts.confirm(pending.request);
 const db=new DatabaseSync(f.filePath);t.after(()=>db.close());let perRecordScans=0,bulkScans=0;
 const inspected=new Proxy(db,{get(target,key){if(key==='prepare')return (sql:string)=>{
  if(sql==='SELECT id,revision,status FROM recording_attempts WHERE physical_id=? ORDER BY rowid DESC LIMIT 1')++perRecordScans;
  if(sql==='SELECT physical_id,id,revision,status FROM recording_attempts ORDER BY rowid')++bulkScans;
  return target.prepare(sql);
 };const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
 const {verifyRecordingRecordDatabase}=await import('../src/recording/record-integrity.js');verifyRecordingRecordDatabase(inspected);
 assert.equal(perRecordScans,0,'完整审计不得为每条Record反复扫描recording_attempts');assert.equal(bulkScans,1);
});

test('真实新Plan重录准入失败不消费，Begin原子unknown+许可消费；A/B续读使用同一冻结身份',async t=>{
  const f=await recordingRecordFixture(t),pending=await f.readyForFinal();await f.attempts.confirm(pending.request);
  const {createRecordingRecordCoordinator}=await import('../src/recording/record-coordinator.js');
  const {createRecordingAttemptCoordinator}=await import('../src/recording/attempt-coordinator.js');
  const {freezeRerecordPlan}=await import('./helpers/recording-record-fixture.js');
  const records=createRecordingRecordCoordinator({store:f.repository.recordingRecords,assertCurrent(){},assertExecutionIdle:()=>f.attempts.assertExecutionIdle()});t.after(()=>records.close());
  const page={offset:0,limit:25},physicalId=pending.attempt.physicalId;
  const preview=await f.media.preview({draftId:pending.attempt.draftId,spec:f.layout.spec,page});
  const media=await f.media.save({commandId:randomUUID(),draftId:pending.attempt.draftId,expectedDraftRevision:preview.draftRevision,inputFingerprint:preview.inputFingerprint,spec:f.layout.spec});
  const state=records.history({physicalId,page}).state;
  const proposal=records.previewDisposition({physicalId,expectedPhysicalRevision:state.physicalRevision,expectedContentRevision:state.revision,expectedAttempt:{id:state.latestAttempt!.id,revision:state.latestAttempt!.revision},intent:{action:'prepare-rerecord',mediaPlanId:media.id,expectedMediaPlanRevision:media.revision}});
  const prepared=records.applyDisposition({...proposal.request,commandId:randomUUID(),proposalFingerprint:proposal.proposalFingerprint,userConfirmed:true});
  await assert.rejects(f.media.save({commandId:randomUUID(),draftId:pending.attempt.draftId,planId:media.id,expectedRevision:prepared.mediaPlan!.revision,expectedDraftRevision:preview.draftRevision,inputFingerprint:preview.inputFingerprint,spec:f.layout.spec}), '未消费许可的目标规划不能被普通编辑改版后失联');
  assert.throws(()=>f.repository.updateCopy({commandId:randomUUID(),physicalId,expectedRevision:prepared.state.physicalRevision,action:'mark-unavailable'}));
  const {verifyRecordingRecordDatabase}=await import('../src/recording/record-integrity.js');
  const probeDb=new DatabaseSync(f.filePath);
  const trigger=String(probeDb.prepare("SELECT sql FROM sqlite_schema WHERE name='recording_record_permit_media_guard'").get()!.sql);
  probeDb.exec('DROP TRIGGER recording_record_permit_media_guard');probeDb.prepare('UPDATE media_plans SET revision=revision+1 WHERE id=?').run(media.id);probeDb.exec(trigger);
  assert.throws(()=>verifyRecordingRecordDatabase(probeDb),'备份完整性必须拒绝离线篡改造成的许可目标版本失配');
  probeDb.exec('DROP TRIGGER recording_record_permit_media_guard');probeDb.prepare('UPDATE media_plans SET revision=revision-1 WHERE id=?').run(media.id);probeDb.exec(trigger);probeDb.close();
  const frozen=await freezeRerecordPlan(f,prepared.mediaPlan!.id);
  const request={commandId:randomUUID(),planVersionId:frozen.id,planContentHash:frozen.contentHash,userConfirmed:true as const};
  const production=createRecordingAttemptCoordinator({store:f.repository.recordingAttempts});t.after(()=>production.close());
  await assert.rejects(production.begin(request),{code:'BACKEND_NOT_CERTIFIED'});
  assert.deepEqual(records.history({physicalId,page}).state,prepared.state);
  const db=new DatabaseSync(f.filePath);t.after(()=>db.close());
  const oldRecord=String(db.prepare('SELECT data FROM recording_records').get()!.data),before=inventory(db);
  const started=await f.attempts.begin(request);
  const during=records.history({physicalId,page}).state;assert.equal(during.knowledge.state,'unknown');assert.equal(during.activeRerecordPermit,null);
  const permit=JSON.parse(String(db.prepare('SELECT data FROM recording_record_permits WHERE revision=2').get()!.data));
  assert.equal(permit.state,'consumed');assert.equal(permit.attemptId,started.id);assert.equal(permit.planContentHash,frozen.contentHash);
  assert.equal(db.prepare('SELECT data FROM recording_records').get()!.data,oldRecord);assert.deepEqual(inventory(db),before);
  const a=f.starts[2]!,side=started.sides[0]!,identity={side:'A' as const,runId:a.runId,at:new Date().toISOString()};
  a.onEvent({...identity,type:'progress',sourceFramesRead:side.frameCount,submittedFrames:side.frameCount,consumedFrames:side.frameCount});
  for(const type of ['source-eof','engine-cutoff','cleanup-quiescent','backend-drained'] as const)a.onEvent({...identity,type});
  await new Promise<void>(resolve=>setImmediate(resolve));
  let current=f.attempts.get({attemptId:started.id}).attempt!;
  current=await f.attempts.confirm({commandId:randomUUID(),attemptId:current.id,expectedRevision:current.revision,kind:'physical-stop',side:'A',userConfirmed:true});
  current=await f.attempts.confirm({commandId:randomUUID(),attemptId:current.id,expectedRevision:current.revision,kind:'flip',userConfirmed:true});
  const b=await f.attempts.beginSide({commandId:randomUUID(),attemptId:current.id,expectedRevision:current.revision,side:'B',userConfirmed:true});
  assert.equal(b.activeSide,'B');assert.equal(f.starts.length,4);
  await f.attempts.stop({commandId:randomUUID(),attemptId:b.id});
  assert.equal(records.history({physicalId,page}).state.knowledge.state,'unknown');assert.equal(db.prepare('SELECT count(*) n FROM recording_records').get()!.n,1);
});

async function erasedLegacy(t:test.TestContext) {
  const f=await recordingRecordFixture(t),db=new DatabaseSync(f.filePath);t.after(()=>db.close());
  const descriptor=JSON.parse(String(db.prepare('SELECT descriptor FROM collection_models').get()!.descriptor));
  const stock=f.repository.receive({commandId:randomUUID(),model:descriptor,lengthMinutes:60,quantities:{openedBlank:0,sealedBlank:0,legacyUsed:1,unclassified:0}});
  const copy=f.repository.materialize({commandId:randomUUID(),lotId:stock.lotId!,bucket:'legacyUsed',action:'register-legacy'});
  const {createRecordingRecordCoordinator}=await import('../src/recording/record-coordinator.js');
  const records=createRecordingRecordCoordinator({store:f.repository.recordingRecords,assertCurrent(){},assertExecutionIdle(){}});t.after(()=>records.close());
  const state=records.history({physicalId:copy.physicalId!,page:{offset:0,limit:25}}).state;
  const request={physicalId:state.physicalId,expectedPhysicalRevision:state.physicalRevision,expectedContentRevision:state.revision,expectedAttempt:null,intent:{action:'confirm-erased' as const}};
  const proposal=records.previewDisposition(request),erased=records.applyDisposition({...request,commandId:randomUUID(),proposalFingerprint:proposal.proposalFingerprint,userConfirmed:true});
  return {...f,db,records,erased};
}
test('无Attempt的旧录音已擦除认知也不能被普通reserve破坏，拒绝后冷启仍合法',async t=>{
  const f=await erasedLegacy(t),state=f.erased.state;
  assert.throws(()=>f.repository.updateCopy({commandId:randomUUID(),physicalId:state.physicalId,expectedRevision:state.physicalRevision,action:'reserve'}));
  const {createCollectionRepository}=await import('../src/collection/repository.js');
  const reopened=createCollectionRepository({filePath:f.filePath});t.after(()=>reopened.close());
  assert.deepEqual(reopened.recordingRecords.read(db=>reopened.recordingRecords.state(db,state.physicalId)),state);
});
test('普通媒体候选排除需要重录许可的已擦除盘，同SKU其它空白库存仍能预留',async t=>{
  const f=await erasedLegacy(t),page={offset:0,limit:25};
  const preview=await f.media.preview({draftId:f.draft.draftId,spec:f.layout.spec,page});
  const candidate=preview.candidates.items.find(item=>item.skuId===f.frozenPlan.physicalCopy.skuId)!;
  assert.equal(candidate.availableCount,2);
  const saved=await f.media.save({commandId:randomUUID(),draftId:f.draft.draftId,expectedDraftRevision:preview.draftRevision,inputFingerprint:preview.inputFingerprint,spec:f.layout.spec});
  const reserved=await f.media.reserve({commandId:randomUUID(),planId:saved.id,expectedRevision:saved.revision,skuId:candidate.skuId,packaging:'opened',userConfirmed:true});
  assert.notEqual(reserved.reservation!.physicalId,f.erased.state.physicalId);
  assert.equal(f.db.prepare('SELECT usage FROM physical_copies WHERE physical_id=?').get(f.erased.state.physicalId)!.usage,'erased');
});
