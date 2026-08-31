import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash, type Hash, type BinaryLike } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import path from 'node:path';
import { createCollectionRepository } from '../src/collection/repository.js';
import { createRecordingAttemptCoordinator } from '../src/recording/attempt-coordinator.js';
import { verifyRecordingAttemptDatabase } from '../src/recording/attempt-integrity.js';
import { recordingAttemptFixture as fixture } from './helpers/recording-attempt-fixture.js';
import type { RecordingAttemptDriver } from '../src/recording/attempt-coordinator.js';
import { createRecordingAttemptStore } from '../src/recording/attempt-store.js';

const page = { offset: 0, limit: 25 };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function rows(filePath: string) {
  const db = new DatabaseSync(filePath, { readOnly: true });
  try { return ['recording_attempts', 'recording_attempt_events', 'recording_attempt_receipts', 'physical_copies', 'inventory_lots', 'inventory_ledger'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]); }
  finally { db.close(); }
}

async function printObjectAuditFixture(t: test.TestContext) {
  const { createCapacityPilot, capacityPdf } = await import('./helpers/recording-capacity-fixture.js');
  const f = await createCapacityPilot(t);
  const pdf = capacityPdf(), counts = { hash: 0, base64: 0 };
  const prototype = Object.getPrototypeOf(createHash('sha256')) as { update: Hash['update'] }, update = prototype.update;
  t.mock.method(prototype, 'update', function(this: Hash, value: BinaryLike, ...rest: unknown[]) {
    if (value instanceof Uint8Array && value.byteLength===pdf.byteLength) ++counts.hash;
    return Reflect.apply(update, this, [value, ...rest]);
  });
  const encode = Buffer.prototype.toString;
  t.mock.method(Buffer.prototype, 'toString', function(this: Buffer, encoding?: BufferEncoding, start?: number, end?: number) {
    if (encoding === 'base64' && this.equals(pdf)) ++counts.base64;
    return encode.call(this, encoding, start, end);
  });
  const {createObjectAuditCertificateManager}=await import('../src/recording/object-audit-certificate.js'),objectCertificates=createObjectAuditCertificateManager();
  const store=createRecordingAttemptStore({read:fn=>fn(f.db),objectCertificates}),runId=randomUUID(),request={commandId:randomUUID(),planVersionId:f.nextPlan.id,planContentHash:f.nextPlan.contentHash,userConfirmed:true} as const;
  const verified=store.capture(request.planVersionId,request.planContentHash),attempt=store.begin(request,verified,runId),anchor={...counts};
  const driver={side:verified.receipt.recipe.side,runId,onEvent:(value:Parameters<typeof store.event>[1])=>store.event(attempt.id,value)};
  const event = (frame: number) => ({ type: 'progress' as const, side: driver.side, runId: driver.runId, at: new Date().toISOString(), sourceFramesRead: frame, submittedFrames: frame, consumedFrames: frame });
  return { f, attempt, driver, store, objectCertificates, counts, pdf, event, anchor };
}
function advanceObjectAuditAttemptToFinal(x:Awaited<ReturnType<typeof printObjectAuditFixture>>){
  let current=x.attempt,runId=x.driver.runId;
  for(let index=0;index<current.sides.length;++index){
    const side=current.sides[index]!,at=new Date().toISOString();
    for(const event of [
      {type:'progress' as const,side:side.side,runId,at,sourceFramesRead:side.frameCount,submittedFrames:side.frameCount,consumedFrames:side.frameCount},
      ...(['source-eof','engine-cutoff','cleanup-quiescent','backend-drained'] as const).map(type=>({type,side:side.side,runId,at})),
    ])current=x.store.event(current.id,event);
    current=x.store.command('confirm',{commandId:randomUUID(),attemptId:current.id,expectedRevision:current.revision,kind:'physical-stop',side:side.side,userConfirmed:true},{type:'confirm',kind:'physical-stop',side:side.side,at:new Date().toISOString()});
    if(index+1<current.sides.length){
      current=x.store.command('confirm',{commandId:randomUUID(),attemptId:current.id,expectedRevision:current.revision,kind:'flip',userConfirmed:true},{type:'confirm',kind:'flip',at:new Date().toISOString()});
      runId=randomUUID();current=x.store.command('beginSide',{commandId:randomUUID(),attemptId:current.id,expectedRevision:current.revision,side:'B',userConfirmed:true},{type:'begin-side',side:'B',runId,at:new Date().toISOString()});
    }
  }
  return x.store.command('confirm',{commandId:randomUUID(),attemptId:current.id,expectedRevision:current.revision,kind:'physical-recording',userConfirmed:true},{type:'confirm',kind:'physical-recording',at:new Date().toISOString()});
}

test('R023对象凭证：Begin全raw锚定后真实progress不再重算未变大对象，公开全审仍保留原SHA', async t => {
  const x = await printObjectAuditFixture(t), encoded = x.pdf.toString('base64'), decoded = x.pdf.toString('latin1');
  const counts = { scans: 0, decode: 0, encode: 0 }, originalTest = RegExp.prototype.test, originalAtob = globalThis.atob, originalBtoa = globalThis.btoa;
  t.mock.method(RegExp.prototype, 'test', function(this: RegExp, value: string) {
    if (value === encoded || typeof value === 'string' && value.startsWith('data:image/jpeg;base64,')) ++counts.scans;
    return originalTest.call(this, value);
  });
  t.mock.method(globalThis, 'atob', (value: string) => { if (value === encoded) ++counts.decode; return originalAtob(value); });
  t.mock.method(globalThis, 'btoa', (value: string) => { if (value === decoded) ++counts.encode; return originalBtoa(value); });
  x.counts.hash = 0;
  x.driver.onEvent(x.event(1));
  assert.equal(x.f.attempts.get({ attemptId: x.attempt.id }).attempt!.sides[0]!.consumedFrames, 1);
  assert.ok(x.anchor.hash > 0, 'Begin必须用真实原字节建立锚点');
  assert.equal(x.counts.hash, 0, '只复用同连接已提交Begin的未变原字节证明');
  assert.deepEqual(counts, { scans: 0, decode: 0, encode: 0 }, '原字节已可校验，不对自己的标准编码重复跑整串guard');
  const { verifyRecordingPrintDatabase } = await import('../src/recording/print-integrity.js');
  verifyRecordingPrintDatabase(x.f.db); assert.ok(x.counts.hash >= 3, '公开全审不读取热凭证');
});

test('R023对象凭证：连续精确progress只复用已提交凭证，完整公开路径仍逐raw重验', async t => {
  const x = await printObjectAuditFixture(t), { verifyRecordingPrintDatabase } = await import('../src/recording/print-integrity.js');
  x.counts.hash=0;x.counts.base64=0;
  verifyRecordingPrintDatabase(x.f.db); const full = { ...x.counts };
  assert.ok(full.hash >= 3, '公开全审保持原始三处实际对象验证');
  x.counts.hash = 0; x.counts.base64 = 0;
  x.driver.onEvent(x.event(1));
  assert.equal(x.f.attempts.get({ attemptId: x.attempt.id }).attempt!.sides[0]!.consumedFrames, 1);
  assert.equal(x.counts.hash, 0, '首progress复用Begin全raw锚点');
  assert.ok(x.counts.base64 < full.base64, '复用已验编码，但原receipt guard/canonical不删');
  x.counts.hash = 0; x.counts.base64 = 0;
  x.driver.onEvent(x.event(2)); assert.equal(x.counts.hash, 0, '仅精确progress成功提交后续签同连接凭证');
  x.counts.hash = 0; verifyRecordingPrintDatabase(x.f.db); assert.equal(x.counts.hash, full.hash, '备份/冷开公开路径没有变成热缓存');
});

test('R023对象凭证：Begin完整结构锚点使progress不再遍历未变Record／Print快照', async t => {
  const x = await printObjectAuditFixture(t), original = x.f.db.prepare.bind(x.f.db);
  const recordSchema = "SELECT sql FROM sqlite_schema WHERE name GLOB 'recording_record*'";
  const printSchema = "SELECT sql FROM sqlite_schema WHERE name GLOB 'recording_print*' OR name GLOB 'master_artwork*'";
  const counts = new Map<string, number>();
  t.mock.method(x.f.db, 'prepare', function(sql: string) {
    if (sql === recordSchema || sql === printSchema) counts.set(sql, (counts.get(sql) ?? 0) + 1);
    return original(sql);
  });

  x.driver.onEvent(x.event(1));

  assert.equal(counts.get(recordSchema) ?? 0, 0, 'Begin已完整核验且环境未变时，progress不得重复遍历Record结构快照');
  assert.equal(counts.get(printSchema) ?? 0, 0, 'Begin已完整核验且环境未变时，progress不得重复遍历Print结构快照');
  assert.equal(x.f.attempts.get({ attemptId: x.attempt.id }).attempt!.sides[0]!.consumedFrames, 1);
});

test('R023对象凭证：Begin的5／6条合法写必须精确声明，未知额外写不能冒充许可分支', async t => {
  const { createCapacityPilot } = await import('./helpers/recording-capacity-fixture.js');
  const f = await createCapacityPilot(t), original = f.db.prepare.bind(f.db);
  const store = createRecordingAttemptStore({ read: fn => fn(f.db) });
  const request = { commandId: randomUUID(), planVersionId: f.nextPlan.id, planContentHash: f.nextPlan.contentHash, userConfirmed: true } as const;
  const verified = store.capture(request.planVersionId, request.planContentHash), runId = randomUUID();
  let injected = false, recordScans = 0;
  t.mock.method(f.db, 'prepare', function(sql: string) {
    const statement = original(sql);
    if (!injected && sql === "SELECT 1 FROM recording_attempts WHERE status='in-progress'") {
      injected = true;
      original('UPDATE physical_copies SET revision=revision WHERE physical_id=?').run(f.nextPlan.physicalCopy.physicalId);
    }
    if (sql === "SELECT sql FROM sqlite_schema WHERE name GLOB 'recording_record*'") ++recordScans;
    return statement;
  });
  const attempt = store.begin(request, verified, runId);
  recordScans = 0;

  store.event(attempt.id, { type: 'progress', side: verified.receipt.recipe.side, runId, at: new Date().toISOString(), sourceFramesRead: 1, submittedFrames: 1, consumedFrames: 1 });

  assert.equal(injected, true);
  assert.equal(recordScans, 1, 'Begin事务多出未知写后不得发布完整结构锚点，下一progress必须回退全审');
});

test('R023对象凭证：无中间写的下一Begin可复用上一提交的完整对象快照',async t=>{
  const x=await printObjectAuditFixture(t);x.f.db.exec('BEGIN IMMEDIATE');
  try{const session=x.objectCertificates.begin(x.f.db,'begin');assert.equal(session.reuseSnapshot(),true,'Begin应接受同连接、同环境、同total_changes的已提交完整快照');}
  finally{x.objectCertificates.clear(x.f.db);x.f.db.exec('ROLLBACK');}
});

test('R023对象凭证：只写Attempt表的停止清理链沿用已提交raw证明', async t => {
  const x = await printObjectAuditFixture(t), identity = { side: x.driver.side, runId: x.driver.runId };
  for (const type of ['engine-cutoff', 'stop-ack'] as const) {
    x.counts.hash = 0;
    x.driver.onEvent({ ...identity, type, at: new Date().toISOString() });
    assert.equal(x.counts.hash, 0, `${type}只追加Attempt事实，不应重算未变对象raw`);
  }
  x.counts.hash = 0;
  x.store.command('stop', { commandId: randomUUID(), attemptId: x.attempt.id }, { type: 'abort', reason: 'user-stop', at: new Date().toISOString() });
  assert.equal(x.counts.hash, 0, 'stop action的abort只追加Attempt事件和回执，不应重算未变对象raw');
  x.counts.hash = 0;
  x.driver.onEvent({ ...identity, type: 'cleanup-quiescent', at: new Date().toISOString() });
  assert.equal(x.counts.hash, 0, '终态后的cleanup-quiescent仍只追加Attempt事实，不应重算未变对象raw');
  const final = x.store.get({ attemptId: x.attempt.id }).attempt!;
  assert.equal(final.status, 'aborted');
  assert.deepEqual(
    { engineCutoff: final.sides[0]!.engineStoppedSubmitting, stopAck: final.sides[0]!.stopAcknowledged, cleanup: final.sides[0]!.cleanupQuiescent, reason: final.reason },
    { engineCutoff: true, stopAck: true, cleanup: true, reason: 'user-stop' },
  );
});

test('R023对象凭证：同步重入清理链先于stop回执时仍逐步沿用raw证明', async t => {
  const x = await printObjectAuditFixture(t), identity = { side: x.driver.side, runId: x.driver.runId };
  for (const type of ['engine-cutoff', 'stop-ack', 'cleanup-quiescent'] as const) {
    x.counts.hash = 0;
    x.driver.onEvent({ ...identity, type, at: new Date().toISOString() });
    assert.equal(x.counts.hash, 0, `${type}同步重入持久化不应重算未变对象raw`);
  }
  x.counts.hash = 0;
  const final = x.store.command('stop', { commandId: randomUUID(), attemptId: x.attempt.id }, { type: 'abort', reason: 'user-stop', at: new Date().toISOString() });
  assert.equal(x.counts.hash, 0, '同步清理链后的stop action/abort回执不应重算未变对象raw');
  assert.deepEqual(
    { status: final.status, engineCutoff: final.sides[0]!.engineStoppedSubmitting, stopAck: final.sides[0]!.stopAcknowledged, cleanup: final.sides[0]!.cleanupQuiescent, reason: final.reason },
    { status: 'aborted', engineCutoff: true, stopAck: true, cleanup: true, reason: 'user-stop' },
  );
});

test('R023对象凭证：Stop批写候选只接受2乘实际event加receipt的精确delta', async t => {
  const x = await printObjectAuditFixture(t), original = x.f.db.prepare.bind(x.f.db); let injected = false;
  t.mock.method(x.f.db, 'prepare', function(sql: string) {
    const statement = original(sql);
    if (!injected && sql === 'SELECT * FROM recording_attempts WHERE id=?') {
      injected = true;
      original('UPDATE physical_copies SET revision=revision WHERE physical_id=?').run(x.attempt.physicalId);
    }
    return statement;
  });
  const at = new Date().toISOString(), identity = { side: x.driver.side, runId: x.driver.runId, at };
  x.counts.hash = 0;
  x.store.stop({ commandId: randomUUID(), attemptId: x.attempt.id }, { type: 'abort', reason: 'user-stop', at },
    [{ ...identity, type: 'engine-cutoff' }, { ...identity, type: 'stop-ack' }]);
  assert.equal(x.counts.hash, 0, '本事务入口仍可使用已提交证明');
  x.counts.hash = 0;
  x.driver.onEvent({ ...identity, type: 'cleanup-quiescent', at: new Date().toISOString() });
  assert.equal(x.counts.hash, 1, '额外同连接写令total_changes超出精确7，候选必须清除并在下一事务全raw');
});

test('R023对象凭证：stop action必须与abort事件精确结合，类型逃逸失败后清证', async t => {
  const x = await printObjectAuditFixture(t), commandId = randomUUID();
  const escaped = x.event(1) as unknown as Parameters<typeof x.store.command>[2];
  x.counts.hash = 0;
  assert.throws(() => x.store.command('stop', { commandId, attemptId: x.attempt.id }, escaped), { code: 'INVALID_REQUEST' });
  assert.equal(x.counts.hash, 1, 'stop加非abort事件必须走other并完整raw审计');
  assert.equal(x.store.get({ attemptId: x.attempt.id }).attempt!.status, 'in-progress');
  assert.equal(x.f.db.prepare('SELECT 1 FROM recording_attempt_receipts WHERE command_id=?').get(commandId), undefined, '拒绝事务不留回执');
  x.counts.hash = 0;
  x.driver.onEvent(x.event(1));
  assert.equal(x.counts.hash, 1, '拒绝并rollback后不得复活先前对象证明');
});

test('R023对象凭证：普通event/command复用对象证明，完成confirm及失败rollback仍清除', async t => {
  await t.test('backend-drained', async t => {
    const x = await printObjectAuditFixture(t);
    x.counts.hash = 0;
    assert.throws(() => x.driver.onEvent({ type: 'backend-drained', side: x.driver.side, runId: x.driver.runId, at: new Date().toISOString() }));
    assert.equal(x.counts.hash, 0, '普通driver event不应重读历史BLOB');
    x.counts.hash = 0; x.driver.onEvent(x.event(1)); assert.equal(x.counts.hash, 1, '拒绝并rollback后不复活旧证明');
  });
  await t.test('final-verification confirm', async t => {
    const x = await printObjectAuditFixture(t), request = { commandId: randomUUID(), attemptId: x.attempt.id, expectedRevision: x.attempt.revision, kind: 'final-verification', userConfirmed: true } as const;
    x.counts.hash = 0;
    assert.throws(() => x.store.command('confirm', request, { type: 'confirm', kind: request.kind, at: new Date().toISOString() }));
    assert.equal(x.counts.hash, 0, 'final-verification入口复用已提交快照，事务内新增Record/Print仍须在提交前复核');
    x.counts.hash = 0; x.driver.onEvent(x.event(1)); assert.equal(x.counts.hash, 1, '拒绝并rollback后不复活旧证明');
  });
  await t.test('beginSide', async t => {
    const x = await printObjectAuditFixture(t), request = { commandId: randomUUID(), attemptId: x.attempt.id, expectedRevision: x.attempt.revision, side: 'B', userConfirmed: true } as const;
    x.counts.hash = 0;
    assert.throws(() => x.store.command('beginSide', request, { type: 'begin-side', side: 'B', runId: randomUUID(), at: new Date().toISOString() }));
    assert.equal(x.counts.hash, 0, '普通Attempt命令不应重读历史BLOB');
    x.counts.hash = 0; x.driver.onEvent(x.event(1)); assert.equal(x.counts.hash, 1, '拒绝并rollback后不复活旧证明');
  });
});

test('R023对象凭证：成功final-verification精确核验新增Record/Print并向同连接claim发布完整快照', async t => {
  const x=await printObjectAuditFixture(t);let current=advanceObjectAuditAttemptToFinal(x);
  x.counts.hash=0;
  current=x.store.command('confirm',{commandId:randomUUID(),attemptId:current.id,expectedRevision:current.revision,kind:'final-verification',userConfirmed:true},{type:'confirm',kind:'final-verification',at:new Date().toISOString()});
  assert.equal(current.status,'completed');assert.equal(x.counts.hash,0,'final-verification不得重读已由前序同连接事务核验的历史PDF/Artwork BLOB');
  const {createRecordingPrintStore}=await import('../src/recording/print-store.js');
  const prints=createRecordingPrintStore({read:fn=>fn(x.f.db),objectCertificates:x.objectCertificates});
  assert.ok(prints.claim({workerId:randomUUID()}).lease);assert.equal(x.counts.hash,0,'完成事务必须发布包含新Record/Print结构的凭证供紧邻claim复用');
});

test('R023对象凭证：final-verification同事务未知写使完成候选失效并在本次及claim回退全审',async t=>{
  const x=await printObjectAuditFixture(t),original=x.f.db.prepare.bind(x.f.db),beforeFinal=advanceObjectAuditAttemptToFinal(x);let injected=false;
  t.mock.method(x.f.db,'prepare',function(sql:string){
    const statement=original(sql);if(sql!=='INSERT INTO recording_records VALUES(?,?,?,?,?,?)')return statement;
    return new Proxy(statement,{get(item,method){if(method==='run')return (...values:Parameters<typeof statement.run>)=>{
      const result=statement.run(...values);if(!injected){original('UPDATE physical_copies SET revision=revision WHERE physical_id=?').run(beforeFinal.physicalId);injected=true;}return result;
    };const value=Reflect.get(item,method,item);return typeof value==='function'?value.bind(item):value;}});
  });
  x.counts.hash=0;
  const current=x.store.command('confirm',{commandId:randomUUID(),attemptId:beforeFinal.id,expectedRevision:beforeFinal.revision,kind:'final-verification',userConfirmed:true},{type:'confirm',kind:'final-verification',at:new Date().toISOString()});
  assert.equal(current.status,'completed');assert.equal(injected,true);assert.ok(x.counts.hash>0,'精确delta失效后完成事务必须在COMMIT前完整回退');
  const afterFinal=x.counts.hash,{createRecordingPrintStore}=await import('../src/recording/print-store.js');
  const prints=createRecordingPrintStore({read:fn=>fn(x.f.db),objectCertificates:x.objectCertificates});prints.claim({workerId:randomUUID()});
  assert.ok(x.counts.hash>afterFinal,'失效的完成候选不得发布给后续claim');
});

test('R023对象凭证：COMMIT后返回前的外连接提交不能被post-commit计数洗白', async t => {
  const x = await printObjectAuditFixture(t), external = new DatabaseSync(x.f.filePath);
  t.after(() => external.close());
  const exec = x.f.db.exec.bind(x.f.db); let inject = true;
  t.mock.method(x.f.db, 'exec', function(sql: string) {
    const result = exec(sql);
    if (inject && sql === 'COMMIT') {
      inject = false;
      external.prepare('UPDATE physical_copies SET revision=revision+1 WHERE physical_id=?').run(x.attempt.physicalId);
    }
    return result;
  });
  x.counts.hash = 0; x.driver.onEvent(x.event(1)); assert.equal(x.counts.hash, 0);
  x.counts.hash = 0; x.driver.onEvent(x.event(2));
  assert.equal(x.counts.hash, 1, '候选token必须在COMMIT前捕获，外提交令下一事务退回全raw');
});

test('R023对象凭证：同连接未知写、temp对象与关键PRAGMA变化均清除热证明', async t => {
  const x = await printObjectAuditFixture(t);
  x.counts.hash = 0; x.driver.onEvent(x.event(1)); assert.equal(x.counts.hash, 0);
  x.f.db.prepare('UPDATE physical_copies SET revision=revision WHERE physical_id=?').run(x.attempt.physicalId);
  x.counts.hash = 0; x.driver.onEvent(x.event(2)); assert.equal(x.counts.hash, 1, '同连接total_changes变化必须失效');
  x.f.db.exec('CREATE TEMP TABLE object_certificate_probe(value TEXT)');
  x.counts.hash = 0; x.driver.onEvent(x.event(3)); assert.equal(x.counts.hash, 1, 'temp schema不是允许环境');
  x.f.db.exec('DROP TABLE temp.object_certificate_probe; PRAGMA recursive_triggers=ON');
  x.counts.hash = 0; x.driver.onEvent(x.event(4)); assert.equal(x.counts.hash, 1, '关键PRAGMA变化不得复用');
  x.f.db.exec('PRAGMA recursive_triggers=OFF');
  x.counts.hash = 0; x.driver.onEvent(x.event(5)); assert.equal(x.counts.hash, 1, '恢复关键PRAGMA后先建立新证明');
  x.f.db.exec('PRAGMA synchronous=OFF');
  x.counts.hash = 0; x.driver.onEvent(x.event(6)); assert.equal(x.counts.hash, 1, '持久化级别变化不得复用');
  x.f.db.exec('PRAGMA synchronous=FULL');
  x.counts.hash = 0; x.driver.onEvent(x.event(7)); assert.equal(x.counts.hash, 1, '恢复持久化级别仍须重新完整审计');
  x.f.db.exec('CREATE TABLE object_certificate_transient(value TEXT); DROP TABLE object_certificate_transient');
  x.counts.hash = 0; x.driver.onEvent(x.event(8)); assert.equal(x.counts.hash, 1, '瞬时DDL即使恢复最终schema也必须失效');
  x.f.db.exec("ATTACH DATABASE ':memory:' AS object_certificate_extra");
  x.counts.hash = 0; x.driver.onEvent(x.event(9)); assert.equal(x.counts.hash, 1, '附加库改变database_list，保持全raw');
  x.f.db.exec('DETACH DATABASE object_certificate_extra');
});

test('R023对象凭证：user_version改变审计分支时不得沿用旧Print证明', async t => {
  const x=await printObjectAuditFixture(t);
  x.f.db.exec('PRAGMA user_version=20');x.counts.hash=0;
  x.driver.onEvent(x.event(1));assert.equal(x.counts.hash,1,'从21降到20仍须完整核验先前凭证覆盖的Print raw');
  x.f.db.exec('PRAGMA user_version=21');x.counts.hash=0;
  x.driver.onEvent(x.event(2));assert.equal(x.counts.hash,1,'恢复版本后不复活降级前token');
});

test('R023对象凭证：未知写触发器不进入白名单，失败COMMIT与rollback不保留候选', async t => {
  const x = await printObjectAuditFixture(t);
  x.f.db.exec("CREATE TRIGGER object_certificate_unknown AFTER INSERT ON recording_attempt_events BEGIN UPDATE physical_copies SET revision=revision WHERE physical_id=NEW.attempt_id; END");
  x.counts.hash=0;x.driver.onEvent(x.event(1));assert.equal(x.counts.hash,1,'未知trigger令本次退回全raw且不发布');
  x.f.db.exec('DROP TRIGGER object_certificate_unknown');
  x.f.db.exec("CREATE TRIGGER object_certificate_completion_unknown AFTER INSERT ON recording_records BEGIN UPDATE physical_copies SET revision=revision WHERE physical_id=NEW.physical_id; END");
  x.counts.hash=0;x.driver.onEvent(x.event(2));assert.equal(x.counts.hash,1,'completion会写入的Record表存在未知trigger时不得复用热证明');
  x.counts.hash=0;x.driver.onEvent(x.event(3));assert.equal(x.counts.hash,1,'未知completion trigger存在期间不得以一次完整审计重新锚定');
  x.f.db.exec('DROP TRIGGER object_certificate_completion_unknown');
  const exec=x.f.db.exec.bind(x.f.db);let failCommit=true;
  t.mock.method(x.f.db,'exec',function(sql:string){if(failCommit&&sql==='COMMIT')throw new Error('合成COMMIT失败');return exec(sql);});
  x.counts.hash=0;assert.throws(()=>x.driver.onEvent(x.event(4)));assert.equal(x.counts.hash,1);
  failCommit=false;x.counts.hash=0;x.driver.onEvent(x.event(4));assert.equal(x.counts.hash,1,'rollback后只能重新全raw，不能发布失败候选');
});

test('R023对象凭证：SQLite提交篡改实际BLOB后强制全raw并拒绝，修复不复活旧证明', async t => {
  const x=await printObjectAuditFixture(t),sha=createHash('sha256').update(x.pdf).digest('hex');
  const trigger=String(x.f.db.prepare("SELECT sql FROM sqlite_schema WHERE name='recording_print_objects_no_update'").get()!.sql);
  const original=Buffer.from(x.f.db.prepare('SELECT content FROM recording_print_objects WHERE sha256=?').get(sha)!.content as Uint8Array),changed=Buffer.from(original),changedIndex=Math.floor(changed.length/2);changed[changedIndex]=changed[changedIndex]!^1;
  const set=(bytes:Buffer)=>{x.f.db.exec('BEGIN IMMEDIATE; DROP TRIGGER recording_print_objects_no_update');x.f.db.prepare('UPDATE recording_print_objects SET content=? WHERE sha256=?').run(bytes,sha);x.f.db.exec(`${trigger}; COMMIT`);};
  set(changed);x.counts.hash=0;assert.throws(()=>x.driver.onEvent(x.event(1)));assert.ok(x.counts.hash>=1,'失效后读取并hash实际坏字节');
  set(original);x.counts.hash=0;x.driver.onEvent(x.event(1));assert.equal(x.counts.hash,1,'修复提交后重新全raw，不复活旧token');
});

test('R023对象单次审计：小预算退回重算、rollback及第二DB不复用上一调用结果', async t => {
  const x = await printObjectAuditFixture(t), read = <T>(fn: (db: DatabaseSync) => T) => fn(x.f.db);
  const limited = createRecordingAttemptStore({ read, objectAudit: { maxBytes: 1, maxEntries: 1 } });
  x.counts.hash = 0; limited.event(x.attempt.id, x.event(1)); assert.equal(x.counts.hash, 3);
  let fail = true;
  const normal = createRecordingAttemptStore({ read, beforeCommit() { if (fail) throw new Error('合成审计后回滚'); } });
  const before = rows(x.f.filePath); x.counts.hash = 0;
  assert.throws(() => normal.event(x.attempt.id, x.event(2))); assert.equal(x.counts.hash, 1); assert.deepEqual(rows(x.f.filePath), before);
  fail = false; x.counts.hash = 0; normal.event(x.attempt.id, x.event(2)); assert.equal(x.counts.hash, 2,'beforeCommit成功路径在hook前后各做一次冷审计');
  const sharedHooked=createRecordingAttemptStore({read,beforeCommit(){},objectCertificates:x.objectCertificates});
  x.counts.hash=0;sharedHooked.event(x.attempt.id,x.event(3));assert.equal(x.counts.hash,2,'传入enabled shared manager也不能绕过beforeCommit前后冷审计');
  x.counts.hash=0;x.store.event(x.attempt.id,x.event(4));assert.equal(x.counts.hash,1,'beforeCommit store必须清除传入manager的旧候选且不得发布新候选');
  const clone = path.join(x.f.directory, 'object-audit-independent.sqlite'); await backup(x.f.db, clone);
  const other = new DatabaseSync(clone); t.after(() => other.close());
  x.counts.hash = 0; createRecordingAttemptStore({ read: fn => fn(other) }).event(x.attempt.id, x.event(5)); assert.equal(x.counts.hash, 1);
  x.counts.hash = 0; normal.event(x.attempt.id, x.event(5)); assert.equal(x.counts.hash, 2);
});

async function auditFixture(t: test.TestContext) {
  const f = await fixture(t), attempt = await f.attempts.begin(f.beginRequest()), driver = f.starts[0]!;
  for (let frame = 1; frame <= 3; ++frame) driver.onEvent({ type: 'progress', side: 'A', runId: driver.runId, at: new Date().toISOString(), sourceFramesRead: frame, submittedFrames: frame, consumedFrames: frame });
  const db = new DatabaseSync(f.filePath); t.after(() => db.close());
  const oldEvent = String(db.prepare('SELECT data FROM recording_attempt_events WHERE attempt_id=? AND revision=2').get(attempt.id)!.data);
  const planData = String(db.prepare('SELECT data FROM recording_plan_versions WHERE id=?').get(attempt.planVersionId)!.data);
  const receipt = db.prepare('SELECT request,result FROM recording_attempt_receipts WHERE attempt_id=? ORDER BY rowid LIMIT 1').get(attempt.id)!;
  const receiptRequest = String(receipt.request), receiptResult = String(receipt.result);
  const counts = { event: 0, plan: 0, receiptRequest: 0, receiptResult: 0 }, parse = JSON.parse;
  t.mock.method(JSON, 'parse', (text: string, reviver?: (key: string, value: unknown) => unknown) => {
    if (text === oldEvent) counts.event++;
    if (text === planData) counts.plan++;
    if (text === receiptRequest) counts.receiptRequest++;
    if (text === receiptResult) counts.receiptResult++;
    return parse(text, reviver);
  });
  const read = <T>(fn: (database: DatabaseSync) => T) => fn(db);
  const noChange = { type: 'progress' as const, side: 'A' as const, runId: driver.runId, at: new Date().toISOString(), sourceFramesRead: 3, submittedFrames: 3, consumedFrames: 3 };
  return { f, attempt, db, read, counts, noChange };
}

test('R023回执前缀：每事务仍读完整raw，命中后跳过旧JSON／关系重放且任一tuple变化拒绝', async t => {
  const f = await auditFixture(t), { createRecordingAttemptAudit } = await import('../src/recording/attempt-integrity.js');
  const audit = createRecordingAttemptAudit();
  audit.verify(f.db);
  assert.ok(f.counts.receiptRequest > 0 && f.counts.receiptResult > 0, '首轮必须完整解析并重放旧回执');
  f.counts.receiptRequest = 0; f.counts.receiptResult = 0;
  audit.verify(f.db);
  assert.deepEqual({ request: f.counts.receiptRequest, result: f.counts.receiptResult }, { request: 0, result: 0 }, 'raw tuple精确命中后不再解析／重放旧回执');

  const pragma = Number(f.db.prepare('PRAGMA recursive_triggers').get()!.recursive_triggers), changedPragma = pragma ? 0 : 1;
  f.db.exec(`PRAGMA recursive_triggers=${changedPragma}`);
  f.counts.receiptRequest = 0; f.counts.receiptResult = 0; audit.verify(f.db);
  assert.ok(f.counts.receiptRequest > 0 && f.counts.receiptResult > 0, '关键环境变化必须退回完整回执审计');
  f.db.exec(`PRAGMA recursive_triggers=${pragma}`);

  const clone = path.join(f.f.directory, 'receipt-prefix-independent.sqlite'); await backup(f.db, clone);
  const other = new DatabaseSync(clone); t.after(() => other.close());
  f.counts.receiptRequest = 0; f.counts.receiptResult = 0; audit.verify(other);
  assert.ok(f.counts.receiptRequest > 0 && f.counts.receiptResult > 0, '同一audit实例的第二DB不得复用第一DB证明');

  const limited = createRecordingAttemptAudit({ maxBytes: 1, maxEntries: 1 });
  limited.verify(f.db); f.counts.receiptRequest = 0; f.counts.receiptResult = 0; limited.verify(f.db);
  assert.ok(f.counts.receiptRequest > 0 && f.counts.receiptResult > 0, '缓存预算不足只能退回完整审计');

  const trigger = String(f.db.prepare("SELECT sql FROM sqlite_schema WHERE name='recording_attempt_receipts_no_update'").get()!.sql);
  const fingerprint = String(f.db.prepare('SELECT fingerprint FROM recording_attempt_receipts WHERE attempt_id=? ORDER BY rowid LIMIT 1').get(f.attempt.id)!.fingerprint);
  f.db.exec('DROP TRIGGER recording_attempt_receipts_no_update');
  f.db.prepare('UPDATE recording_attempt_receipts SET fingerprint=? WHERE attempt_id=?').run('b'.repeat(64), f.attempt.id);
  f.db.exec(trigger);
  assert.throws(() => audit.verify(f.db), '完整fresh raw读取必须发现旧前缀任一字段变化并退回全审拒绝');
  f.db.exec('DROP TRIGGER recording_attempt_receipts_no_update');
  f.db.prepare('UPDATE recording_attempt_receipts SET fingerprint=? WHERE attempt_id=?').run(fingerprint, f.attempt.id);
  f.db.exec(trigger);
  f.counts.receiptRequest = 0; f.counts.receiptResult = 0;
  audit.verify(f.db);
  assert.ok(f.counts.receiptRequest > 0 && f.counts.receiptResult > 0, '异常清缓存后必须重新完整解析／重放');

  const appendedCommand = randomUUID();
  f.db.prepare('INSERT INTO recording_attempt_receipts SELECT ?,fingerprint,request,attempt_id,revision,result FROM recording_attempt_receipts WHERE attempt_id=? ORDER BY rowid LIMIT 1').run(appendedCommand, f.attempt.id);
  assert.throws(() => audit.verify(f.db), '追加尾部不能借旧prefix放行，新增row仍须完整DTO、fingerprint与关系审计');
  const deleteTrigger = String(f.db.prepare("SELECT sql FROM sqlite_schema WHERE name='recording_attempt_receipts_no_delete'").get()!.sql);
  f.db.exec('DROP TRIGGER recording_attempt_receipts_no_delete');
  f.db.prepare('DELETE FROM recording_attempt_receipts WHERE command_id=?').run(appendedCommand);
  f.db.exec(deleteTrigger);

  audit.verify(f.db);
  const originalReceipt = f.db.prepare('SELECT command_id,fingerprint,request,attempt_id,revision,result FROM recording_attempt_receipts WHERE attempt_id=? ORDER BY rowid LIMIT 1').get(f.attempt.id)!;
  f.db.exec('DROP TRIGGER recording_attempt_receipts_no_delete');
  f.db.prepare('DELETE FROM recording_attempt_receipts WHERE command_id=?').run(originalReceipt.command_id!);
  f.db.exec(deleteTrigger);
  assert.throws(() => audit.verify(f.db), '旧prefix删行必须退回全审并由孤儿约束拒绝');
  f.db.prepare('INSERT INTO recording_attempt_receipts VALUES(?,?,?,?,?,?)').run(originalReceipt.command_id!, originalReceipt.fingerprint!, originalReceipt.request!, originalReceipt.attempt_id!, originalReceipt.revision!, originalReceipt.result!);
  audit.verify(f.db);
});

test('R023增量：热审计逐原始内容命中后不重算旧事件和Plan，公共完整验证仍重算', async t => {
  const f = await auditFixture(t), store = createRecordingAttemptStore({ read: f.read });
  store.event(f.attempt.id, f.noChange); const first = { ...f.counts };
  assert.ok(first.event > 0); assert.ok(first.plan > 0);
  f.counts.event = 0; f.counts.plan = 0;
  store.event(f.attempt.id, f.noChange);
  assert.equal(f.counts.event, 0, '旧progress既非当前头也非命令回执依赖，热命中不再JSON解析／重演');
  assert.ok(f.counts.plan < first.plan, '仅复用验证器内Plan解析，实际事件应用仍核当前Plan');
  const advanced = { ...f.noChange, sourceFramesRead: 4, submittedFrames: 4, consumedFrames: 4 };
  const next = store.event(f.attempt.id, advanced); f.counts.event = 0;
  assert.deepEqual(store.event(f.attempt.id, advanced), next); assert.equal(f.counts.event, 0, '真实追加的尾部重新验证，原前缀仍可复用');
  f.counts.event = 0; verifyRecordingAttemptDatabase(f.db);
  assert.equal(f.counts.event, 1, '备份／冷开使用的公开完整核验不得命中热缓存');
});

test('R023 Attempt追加凭证：第二个真实progress只审fresh头、Plan和单条新尾，失效及公开入口仍全审', async t => {
  const f = await auditFixture(t), store = createRecordingAttemptStore({ read: f.read });
  const original = f.db.prepare.bind(f.db);
  const calls = new Map<string, { get: number; all: number; iterate: number; rows: number }>();
  const stat = (sql: string) => {
    const known = calls.get(sql);
    if (known) return known;
    const created = { get: 0, all: 0, iterate: 0, rows: 0 };
    calls.set(sql, created);
    return created;
  };
  t.mock.method(f.db, 'prepare', function(sql: string) {
    const statement = original(sql);
    return new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === 'get' || property === 'all') return (...args: unknown[]) => {
          ++stat(sql)[property];
          const result = Reflect.apply(value as (...values: unknown[]) => unknown, target, args);
          if (property === 'all' && Array.isArray(result)) stat(sql).rows += result.length;
          return result;
        };
        if (property === 'iterate') return (...args: unknown[]) => {
          ++stat(sql).iterate;
          const source = Reflect.apply(value as (...values: unknown[]) => Iterable<Record<string, unknown>>, target, args);
          return (function*() {
            for (const row of source) { ++stat(sql).rows; yield row; }
          })();
        };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
  const fullBudgetSql = [
    'SELECT count(*) n,COALESCE(sum(length(CAST(data AS BLOB))),0) bytes FROM recording_attempts',
    'SELECT count(*) n,COALESCE(sum(length(CAST(data AS BLOB))),0) bytes FROM recording_attempt_events',
    'SELECT count(*) n,COALESCE(sum(length(CAST(request AS BLOB))+length(CAST(result AS BLOB))),0) bytes FROM recording_attempt_receipts',
  ] as const;
  const oldEventsSql = 'SELECT * FROM recording_attempt_events WHERE attempt_id=? ORDER BY revision';
  const newTailSql = 'SELECT * FROM recording_attempt_events WHERE attempt_id=? AND revision>? ORDER BY revision LIMIT 5';
  const receiptsSql = 'SELECT command_id,fingerprint,request,attempt_id,revision,result FROM recording_attempt_receipts ORDER BY rowid';
  const receiptTailSql = 'SELECT command_id,fingerprint,request,attempt_id,revision,result FROM recording_attempt_receipts WHERE rowid>? ORDER BY rowid LIMIT 2';
  const receiptSummarySql = 'SELECT count(*) n,COALESCE(max(rowid),0) rowid FROM recording_attempt_receipts';
  const fullBudgetCalls = () => fullBudgetSql.reduce((sum, sql) => sum + stat(sql).get, 0);
  const progress = (frame: number) => ({ ...f.noChange, sourceFramesRead: frame, submittedFrames: frame, consumedFrames: frame });

  store.event(f.attempt.id, progress(4));
  assert.equal(fullBudgetCalls(), 3, '首个advancing progress允许一次完整三表审计来建立已提交追加凭证');
  assert.equal(stat(oldEventsSql).iterate, 1, '首个advancing progress完整核验旧event链');
  assert.equal(stat(receiptsSql).all, 1, '首个advancing progress完整核验旧receipt集合');

  calls.clear();
  store.event(f.attempt.id, progress(5));
  assert.deepEqual({
    fullCountAndSum: fullBudgetCalls(),
    oldEventOrderByRevision: stat(oldEventsSql).iterate,
    completeReceiptSet: stat(receiptsSql).all,
    completeReceiptCount: stat(receiptSummarySql).get,
    freshHead: stat('SELECT * FROM recording_attempts WHERE id=?').get >= 1,
    freshPlan: stat('SELECT data FROM recording_plan_versions WHERE id=?').get >= 1,
    fullForeignKeyCheck: stat('PRAGMA foreign_key_check').get,
    newEventTail: { calls: stat(newTailSql).iterate, rows: stat(newTailSql).rows },
    newReceiptTail: { calls: stat(receiptTailSql).all, rows: stat(receiptTailSql).rows },
  }, {
    fullCountAndSum: 0,
    oldEventOrderByRevision: 0,
    completeReceiptSet: 0,
    completeReceiptCount: 0,
    freshHead: true,
    freshPlan: true,
    fullForeignKeyCheck: 0,
    newEventTail: { calls: 1, rows: 1 },
    newReceiptTail: { calls: 1, rows: 0 },
  }, '第二个advancing progress必须消费同DB／环境／预算的已提交追加凭证，不再枚举旧集合');

  calls.clear();
  verifyRecordingAttemptDatabase(f.db);
  assert.equal(fullBudgetCalls(), 3, '公共verify始终执行三表完整计数和字节审计');
  assert.equal(stat(oldEventsSql).iterate, 1, '公共verify始终重放完整event链');
  assert.equal(stat(receiptsSql).all, 1, '公共verify始终核验完整receipt集合');
  assert.equal(stat('PRAGMA foreign_key_check').get, 1, '公共verify始终执行完整外键核验');

  const exec = f.db.exec.bind(f.db); let failCommit = true;
  t.mock.method(f.db, 'exec', function(sql: string) {
    if (failCommit && sql === 'COMMIT') throw new Error('合成COMMIT失败');
    return exec(sql);
  });
  calls.clear();
  assert.throws(() => store.event(f.attempt.id, progress(6)));
  failCommit = false; calls.clear();
  store.event(f.attempt.id, progress(6));
  assert.equal(fullBudgetCalls(), 3, 'rollback清除候选追加凭证，下一事务必须恢复完整三表审计');
  assert.equal(stat(oldEventsSql).iterate, 1, 'rollback后下一事务必须恢复完整event链审计');
  assert.equal(stat(receiptsSql).all, 1, 'rollback后下一事务必须恢复完整receipt集合审计');
  assert.equal(stat('PRAGMA foreign_key_check').get, 3, 'rollback后下一事务必须恢复Attempt、Record与Print三层完整外键核验');
});

test('R023 Attempt冷开凭证：已完整核验的空闲库只审Begin与Stop新增尾部', async t => {
  const { createCapacityPilot } = await import('./helpers/recording-capacity-fixture.js');
  const f = await createCapacityPilot(t), original = DatabaseSync.prototype.prepare;
  const calls = new Map<string, { get: number; all: number; iterate: number; rows: number }>();
  const stat = (sql: string) => {
    const known = calls.get(sql);
    if (known) return known;
    const created = { get: 0, all: 0, iterate: 0, rows: 0 };
    calls.set(sql, created);
    return created;
  };
  t.mock.method(DatabaseSync.prototype, 'prepare', function(this: DatabaseSync, sql: string) {
    const statement = original.call(this, sql);
    return new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === 'get' || property === 'all') return (...args: unknown[]) => {
          ++stat(sql)[property];
          const result = Reflect.apply(value as (...values: unknown[]) => unknown, target, args);
          if (property === 'all' && Array.isArray(result)) stat(sql).rows += result.length;
          return result;
        };
        if (property === 'iterate') return (...args: unknown[]) => {
          ++stat(sql).iterate;
          const source = Reflect.apply(value as (...values: unknown[]) => Iterable<Record<string, unknown>>, target, args);
          return (function*() {
            for (const row of source) { ++stat(sql).rows; yield row; }
          })();
        };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
  const repository = createCollectionRepository({ filePath: f.filePath });
  t.after(() => repository.close());
  const fullBudgetSql = [
    'SELECT count(*) n,COALESCE(sum(length(CAST(data AS BLOB))),0) bytes FROM recording_attempts',
    'SELECT count(*) n,COALESCE(sum(length(CAST(data AS BLOB))),0) bytes FROM recording_attempt_events',
    'SELECT count(*) n,COALESCE(sum(length(CAST(request AS BLOB))+length(CAST(result AS BLOB))),0) bytes FROM recording_attempt_receipts',
  ] as const;
  const attemptRootsSql = 'SELECT * FROM recording_attempts ORDER BY id';
  const oldEventsSql = 'SELECT * FROM recording_attempt_events WHERE attempt_id=? ORDER BY revision';
  const receiptsSql = 'SELECT command_id,fingerprint,request,attempt_id,revision,result FROM recording_attempt_receipts ORDER BY rowid';
  const fullBudgetCalls = () => fullBudgetSql.reduce((sum, sql) => sum + stat(sql).get, 0);

  repository.recordingPlans.version({ id: f.nextPlan.id });
  assert.equal(fullBudgetCalls(), 3, 'repository冷开仍必须恰好执行一次Attempt三表完整审计');
  assert.ok(stat(attemptRootsSql).rows > 0, '计数器必须实际观察到repository冷开的Attempt根集合');
  assert.ok(stat(oldEventsSql).rows > 0, 'repository冷开仍必须重放既有event链');
  assert.equal(stat(receiptsSql).all, 1, 'repository冷开仍必须核验完整receipt集合');
  assert.ok(stat(receiptsSql).rows > 0, '计数器必须实际观察到repository冷开的完整receipt集合');

  calls.clear();
  const request = { commandId: randomUUID(), planVersionId: f.nextPlan.id, planContentHash: f.nextPlan.contentHash, userConfirmed: true } as const;
  const verified = repository.recordingAttempts.capture(request.planVersionId, request.planContentHash);
  const runId = randomUUID(), attempt = repository.recordingAttempts.begin(request, verified, runId);
  assert.deepEqual({ fullCountAndSum: fullBudgetCalls(), attemptRoots: stat(attemptRootsSql).rows,
    oldEventOrderByRevision: stat(oldEventsSql).rows, completeReceiptSet: stat(receiptsSql).rows },
  { fullCountAndSum: 0, attemptRoots: 0, oldEventOrderByRevision: 0, completeReceiptSet: 0 },
  'cold-open idle证书必须让Begin只核新head/event/receipt，不枚举历史Attempt集合');

  calls.clear();
  const at = new Date().toISOString(), identity = { side: verified.receipt.recipe.side, runId, at };
  const stopped = repository.recordingAttempts.stop(
    { commandId: randomUUID(), attemptId: attempt.id },
    { type: 'abort', reason: 'user-stop', at },
    [{ ...identity, type: 'engine-cutoff' }, { ...identity, type: 'stop-ack' }],
  );
  assert.equal(stopped.status, 'aborted');
  assert.deepEqual({
    fullCountAndSum: fullBudgetCalls(),
    attemptRoots: stat(attemptRootsSql).rows,
    oldEventOrderByRevision: stat(oldEventsSql).rows,
    completeReceiptSet: stat(receiptsSql).rows,
  }, {
    fullCountAndSum: 0,
    attemptRoots: 0,
    oldEventOrderByRevision: 0,
    completeReceiptSet: 0,
  }, 'active证书必须精确验证2条同步清理事实、abort与receipt，不得再次枚举历史Attempt集合');

  for (const late of [
    { ...identity, type: 'engine-cutoff' as const },
    { ...identity, type: 'cleanup-quiescent' as const, runId: randomUUID() },
    { ...identity, type: 'cleanup-quiescent' as const, side: 'B' as const },
  ]) {
    calls.clear();
    const unchanged = repository.recordingAttempts.event(attempt.id, late);
    assert.equal(unchanged.revision, stopped.revision);
    assert.deepEqual({ fullCountAndSum: fullBudgetCalls(), attemptRoots: stat(attemptRootsSql).rows,
      oldEventOrderByRevision: stat(oldEventsSql).rows, completeReceiptSet: stat(receiptsSql).rows },
    { fullCountAndSum: 0, attemptRoots: 0, oldEventOrderByRevision: 0, completeReceiptSet: 0 },
    'terminal证书必须有界核验重复事实和错误输出身份，并保持原终态不变');
  }

  calls.clear();
  const cleaned = repository.recordingAttempts.event(attempt.id, { ...identity, type: 'cleanup-quiescent' });
  assert.equal(cleaned.status, 'aborted');
  assert.equal(cleaned.reason, 'user-stop');
  assert.equal(cleaned.sides[0]!.cleanupQuiescent, true);
  assert.deepEqual({
    fullCountAndSum: fullBudgetCalls(),
    attemptRoots: stat(attemptRootsSql).rows,
    oldEventOrderByRevision: stat(oldEventsSql).rows,
    completeReceiptSet: stat(receiptsSql).rows,
  }, {
    fullCountAndSum: 0,
    attemptRoots: 0,
    oldEventOrderByRevision: 0,
    completeReceiptSet: 0,
  }, 'terminal证书必须精确验证迟到cleanup事实，不得再次枚举历史Attempt集合');
});

test('R023 terminal凭证：事件kind与头表列必须逐项绑定replay结果', async t => {
  const { createRecordingAttemptAudit, attemptPlan, replayAttemptEvent, MAX_ATTEMPT_DATABASE_BYTES } = await import('../src/recording/attempt-integrity.js');
  const { mediaFingerprint } = await import('../src/recording/media-store.js');

  async function rejectedCandidate(st: test.TestContext, mutation: 'wrong-kind' | 'head-column'): Promise<void> {
    const f = await auditFixture(st), audit = createRecordingAttemptAudit();
    const store = createRecordingAttemptStore({ read: f.read, attemptAudit: audit });
    store.event(f.attempt.id, f.noChange);
    const at = new Date().toISOString();
    const stopped = store.stop({ commandId: randomUUID(), attemptId: f.attempt.id }, { type: 'abort', reason: 'user-stop', at }, []);
    assert.equal(stopped.status, 'aborted');

    f.db.exec('BEGIN IMMEDIATE');
    try {
      const session = audit.beginAppend(f.db, true, MAX_ATTEMPT_DATABASE_BYTES, 'terminal-event');
      const event = { type: 'cleanup-quiescent' as const, side: 'A' as const, runId: f.noChange.runId, at };
      const after = replayAttemptEvent(stopped.id, attemptPlan(f.db, stopped.planVersionId), stopped, event);
      const previousHash = String(f.db.prepare('SELECT event_hash FROM recording_attempt_events WHERE attempt_id=? AND revision=?').get(stopped.id, stopped.revision)!.event_hash);
      const data = { event, after }, encoded = JSON.stringify(data);
      const eventHash = mediaFingerprint({ id: stopped.id, revision: after.revision, previousHash, data });
      f.db.prepare('UPDATE recording_attempts SET status=?,revision=?,data=? WHERE id=?')
        .run(mutation === 'head-column' ? 'failed' : after.status, after.revision, JSON.stringify(after), stopped.id);
      f.db.prepare('INSERT INTO recording_attempt_events VALUES(?,?,?,?,?,?)')
        .run(stopped.id, after.revision, mutation === 'wrong-kind' ? 'progress' : event.type, encoded, previousHash, eventHash);
      session.expectMutationDelta(2);
      assert.throws(() => session.candidate(), '未知kind或非归一化head列不得获得terminal候选凭证');
    } finally {
      if (f.db.isTransaction) f.db.exec('ROLLBACK');
      audit.clear(f.db);
    }
  }

  await t.test('cleanup body不能配错event kind', st => rejectedCandidate(st, 'wrong-kind'));
  await t.test('head列不能与合法JSON head分离', st => rejectedCandidate(st, 'head-column'));
});

test('R023 Attempt冷开凭证：beforeCommit、同连接写与rollback均强制恢复完整审计', async t => {
  const { createCapacityPilot } = await import('./helpers/recording-capacity-fixture.js');
  const f = await createCapacityPilot(t);
  const fullBudgetSql = [
    'SELECT count(*) n,COALESCE(sum(length(CAST(data AS BLOB))),0) bytes FROM recording_attempts',
    'SELECT count(*) n,COALESCE(sum(length(CAST(data AS BLOB))),0) bytes FROM recording_attempt_events',
    'SELECT count(*) n,COALESCE(sum(length(CAST(request AS BLOB))+length(CAST(result AS BLOB))),0) bytes FROM recording_attempt_receipts',
  ] as const;
  const attemptRootsSql = 'SELECT * FROM recording_attempts ORDER BY id';
  const oldEventsSql = 'SELECT * FROM recording_attempt_events WHERE attempt_id=? ORDER BY revision';
  const receiptsSql = 'SELECT command_id,fingerprint,request,attempt_id,revision,result FROM recording_attempt_receipts ORDER BY rowid';

  async function coldClone(st: test.TestContext, label: string, beforeCommit?: (action: string) => void) {
    const filePath = path.join(f.directory, `${label}.sqlite`); await backup(f.db, filePath);
    const originalPrepare = DatabaseSync.prototype.prepare;
    const calls = new Map<string, { get: number; all: number; iterate: number; rows: number }>();
    const stat = (sql: string) => {
      const known = calls.get(sql);
      if (known) return known;
      const created = { get: 0, all: 0, iterate: 0, rows: 0 };
      calls.set(sql, created); return created;
    };
    let target: DatabaseSync | undefined, captureTarget = false;
    st.mock.method(DatabaseSync.prototype, 'prepare', function(this: DatabaseSync, sql: string) {
      if (captureTarget && !target) target = this;
      const statement = originalPrepare.call(this, sql);
      if (this !== target) return statement;
      return new Proxy(statement, {
        get(statementTarget, property) {
          const value = Reflect.get(statementTarget, property, statementTarget);
          if (property === 'get' || property === 'all') return (...args: unknown[]) => {
            ++stat(sql)[property];
            const result = Reflect.apply(value as (...values: unknown[]) => unknown, statementTarget, args);
            if (property === 'all' && Array.isArray(result)) stat(sql).rows += result.length;
            return result;
          };
          if (property === 'iterate') return (...args: unknown[]) => {
            ++stat(sql).iterate;
            const source = Reflect.apply(value as (...values: unknown[]) => Iterable<Record<string, unknown>>, statementTarget, args);
            return (function*() { for (const row of source) { ++stat(sql).rows; yield row; } })();
          };
          return typeof value === 'function' ? value.bind(statementTarget) : value;
        },
      });
    });
    const repository = createCollectionRepository({ filePath, ...(beforeCommit ? { beforeCommit } : {}) });
    st.after(() => repository.close());
    captureTarget = true;
    try { repository.recordingPlans.version({ id: f.nextPlan.id }); }
    finally { captureTarget = false; }
    assert.ok(target, '必须捕获clone repository的内部DatabaseSync连接');
    assert.ok(stat(attemptRootsSql).rows > 0 && stat(oldEventsSql).rows > 0 && stat(receiptsSql).rows > 0,
      '每个失效子例必须先观察到真实cold-open完整历史，避免计数器假绿');
    calls.clear();
    const assertFullAudit = (message: string) => assert.deepEqual({
      fullCountAndSum: fullBudgetSql.reduce((sum, sql) => sum + stat(sql).get, 0),
      attemptRoots: stat(attemptRootsSql).rows > 0,
      oldEvents: stat(oldEventsSql).rows > 0,
      receiptCalls: stat(receiptsSql).all,
      receiptRows: stat(receiptsSql).rows > 0,
    }, {
      fullCountAndSum: 3,
      attemptRoots: true,
      oldEvents: true,
      receiptCalls: 1,
      receiptRows: true,
    }, message);
    return { repository, calls, target, originalPrepare, assertFullAudit };
  }

  await t.test('no-op beforeCommit不消费cold-open idle证书', async st => {
    const x = await coldClone(st, 'attempt-cold-before-commit', () => {});
    const request = { commandId: randomUUID(), planVersionId: f.nextPlan.id, planContentHash: f.nextPlan.contentHash, userConfirmed: true } as const;
    const verified = x.repository.recordingAttempts.capture(request.planVersionId, request.planContentHash); x.calls.clear();
    const attempt = x.repository.recordingAttempts.begin(request, verified, randomUUID());
    assert.equal(attempt.status, 'in-progress');
    x.assertFullAudit('配置任意beforeCommit时，Begin必须忽略repository cold-open证书并完整审计');
  });

  await t.test('cold-open后同连接额外写使Begin退回完整审计', async st => {
    const x = await coldClone(st, 'attempt-cold-same-connection-write');
    const request = { commandId: randomUUID(), planVersionId: f.nextPlan.id, planContentHash: f.nextPlan.contentHash, userConfirmed: true } as const;
    const verified = x.repository.recordingAttempts.capture(request.planVersionId, request.planContentHash); x.calls.clear();
    const originalExec = DatabaseSync.prototype.exec; let inject = true, injectedChanges = 0;
    st.mock.method(DatabaseSync.prototype, 'exec', function(this: DatabaseSync, sql: string) {
      const result = originalExec.call(this, sql);
      if (inject && this === x.target && sql === 'BEGIN IMMEDIATE') {
        inject = false;
        injectedChanges = Number(x.originalPrepare.call(this, 'UPDATE physical_copies SET revision=revision WHERE physical_id=?').run(f.nextPlan.physicalCopy.physicalId).changes);
      }
      return result;
    });
    const attempt = x.repository.recordingAttempts.begin(request, verified, randomUUID());
    assert.equal(attempt.status, 'in-progress'); assert.equal(inject, false); assert.equal(injectedChanges, 1);
    x.assertFullAudit('同一DatabaseSync的额外total_changes必须令Begin拒绝idle证书并完整审计');
  });

  await t.test('Begin COMMIT失败后重试不复活cold-open候选', async st => {
    const x = await coldClone(st, 'attempt-cold-commit-rollback');
    const request = { commandId: randomUUID(), planVersionId: f.nextPlan.id, planContentHash: f.nextPlan.contentHash, userConfirmed: true } as const;
    const verified = x.repository.recordingAttempts.capture(request.planVersionId, request.planContentHash), runId = randomUUID(); x.calls.clear();
    const originalExec = DatabaseSync.prototype.exec; let failCommit = true;
    st.mock.method(DatabaseSync.prototype, 'exec', function(this: DatabaseSync, sql: string) {
      if (failCommit && this === x.target && sql === 'COMMIT') { failCommit = false; throw new Error('合成Begin COMMIT失败'); }
      return originalExec.call(this, sql);
    });
    assert.throws(() => x.repository.recordingAttempts.begin(request, verified, runId));
    x.calls.clear();
    const attempt = x.repository.recordingAttempts.begin(request, verified, runId);
    assert.equal(attempt.status, 'in-progress'); assert.equal(failCommit, false);
    x.assertFullAudit('失败COMMIT及rollback必须清除cold-open候选，重试只能从完整审计重新锚定');
  });
});

test('R023 Attempt追加凭证：候选单次消费且只能在原事务COMMIT后即时发布', async t => {
  const f = await auditFixture(t), { createRecordingAttemptAudit } = await import('../src/recording/attempt-integrity.js');
  const audit = createRecordingAttemptAudit(), original = f.db.prepare.bind(f.db), counts = new Map<string, number>();
  const fullBudgetSql = new Set([
    'SELECT count(*) n,COALESCE(sum(length(CAST(data AS BLOB))),0) bytes FROM recording_attempts',
    'SELECT count(*) n,COALESCE(sum(length(CAST(data AS BLOB))),0) bytes FROM recording_attempt_events',
    'SELECT count(*) n,COALESCE(sum(length(CAST(request AS BLOB))+length(CAST(result AS BLOB))),0) bytes FROM recording_attempt_receipts',
  ]);
  t.mock.method(f.db, 'prepare', function(sql: string) { counts.set(sql, (counts.get(sql) ?? 0) + 1); return original(sql); });
  const fullBudgetCalls = () => [...counts.entries()].filter(([sql]) => fullBudgetSql.has(sql)).reduce((sum, [, count]) => sum + count, 0);

  f.db.exec('BEGIN IMMEDIATE');
  const premature = audit.beginAppend(f.db, true), prematureCandidate = premature.candidate();
  assert.ok(prematureCandidate); assert.throws(() => premature.candidate(), '同一session的candidate不得二次消费');
  audit.publish(f.db, prematureCandidate);
  f.db.exec('COMMIT');

  counts.clear(); f.db.exec('BEGIN IMMEDIATE');
  const committed = audit.beginAppend(f.db, true);
  assert.equal(fullBudgetCalls(), 3, '事务内提前publish必须拒绝，下一事务重新完整审计');
  const committedCandidate = committed.candidate(); f.db.exec('COMMIT'); audit.publish(f.db, committedCandidate);

  counts.clear(); f.db.exec('BEGIN IMMEDIATE');
  const reused = audit.beginAppend(f.db, true);
  assert.equal(fullBudgetCalls(), 0, '同一事务候选只有在成功COMMIT后即时publish才可供下一事务复用');
  const reusedCandidate = reused.candidate(); f.db.exec('COMMIT'); audit.publish(f.db, reusedCandidate);
});

test('R023热审计：同一事务按SQL只prepare一次且每个Plan仍至少fresh读取一次', async t => {
  const f = await auditFixture(t), { createRecordingAttemptAudit } = await import('../src/recording/attempt-integrity.js');
  const audit = createRecordingAttemptAudit();
  audit.verify(f.db);
  const original = f.db.prepare.bind(f.db), counts = new Map<string, number>();
  t.mock.method(f.db, 'prepare', function(sql: string) {
    counts.set(sql, (counts.get(sql) ?? 0) + 1);
    return original(sql);
  });
  audit.verify(f.db);
  assert.equal(counts.get('SELECT data FROM recording_plan_versions WHERE id=?'), 1, '同一txn内重复Plan关系复用statement与已fresh读取值');
  assert.equal(counts.get('SELECT command_id,fingerprint,request,attempt_id,revision,result FROM recording_attempt_receipts ORDER BY rowid'), 1, 'receipt原始row set仍完整fresh读取一次');
  assert.equal(counts.get('SELECT data FROM recording_attempt_events WHERE attempt_id=? AND revision=?') ?? 0, 0, '旧receipt raw tuple命中后跳过结果／基线关系重放');
});

test('R023预算凭证：审计基线免重复SUM，任意钩子／同连接写只能退回fresh预算', async t => {
  const f = await auditFixture(t), counts = new Map<string, number>(), original = f.db.prepare.bind(f.db);
  const store = createRecordingAttemptStore({ read: f.read });
  store.event(f.attempt.id, { ...f.noChange, sourceFramesRead: 4, submittedFrames: 4, consumedFrames: 4 });
  t.mock.method(f.db, 'prepare', function(sql: string) {
    counts.set(sql, (counts.get(sql) ?? 0) + 1);
    return original(sql);
  });
  store.event(f.attempt.id, { ...f.noChange, sourceFramesRead: 5, submittedFrames: 5, consumedFrames: 5 });
  const attemptBudgetSql = new Set([
    'SELECT count(*) n,COALESCE(sum(length(CAST(data AS BLOB))),0) bytes FROM recording_attempts',
    'SELECT count(*) n,COALESCE(sum(length(CAST(data AS BLOB))),0) bytes FROM recording_attempt_events',
    'SELECT count(*) n,COALESCE(sum(length(CAST(request AS BLOB))+length(CAST(result AS BLOB))),0) bytes FROM recording_attempt_receipts',
  ]);
  const attemptFallbackSumSql = new Set([
    'SELECT COALESCE(sum(length(CAST(data AS BLOB))),0) bytes FROM recording_attempts',
    'SELECT COALESCE(sum(length(CAST(data AS BLOB))),0) bytes FROM recording_attempt_events',
    'SELECT COALESCE(sum(length(CAST(request AS BLOB))+length(CAST(result AS BLOB))),0) bytes FROM recording_attempt_receipts',
  ]);
  const budgetReads = [...counts.entries()].filter(([sql]) => attemptBudgetSql.has(sql));
  assert.deepEqual(budgetReads, [], '已提交Attempt追加凭证必须携带精确预算基线，连续progress不再全表聚合');
  assert.equal([...counts.entries()].filter(([sql]) => attemptFallbackSumSql.has(sql)).reduce((sum, [, count]) => sum + count, 0), 0, '有效凭证不在reserveBudget重复SUM');
  assert.equal(counts.get('SELECT count(*) n FROM recording_attempt_events') ?? 0, 0);
  assert.equal(counts.get('SELECT count(*) n FROM recording_attempt_receipts') ?? 0, 0);

  counts.clear();
  const hooked = createRecordingAttemptStore({ read: f.read, beforeCommit() {} });
  hooked.event(f.attempt.id, { ...f.noChange, sourceFramesRead: 6, submittedFrames: 6, consumedFrames: 6 });
  assert.equal([...counts.entries()].filter(([sql]) => attemptFallbackSumSql.has(sql)).reduce((sum, [, count]) => sum + count, 0), 3, '任意beforeCommit钩子禁用凭证并回退原fresh SUM');
  counts.clear(); store.event(f.attempt.id, { ...f.noChange, sourceFramesRead: 6, submittedFrames: 6, consumedFrames: 6 });

  counts.clear(); let inject = true;
  t.mock.restoreAll();
  t.mock.method(f.db, 'prepare', function(sql: string) {
    counts.set(sql, (counts.get(sql) ?? 0) + 1);
    if (inject && sql === 'SELECT * FROM recording_attempts WHERE id=?') {
      inject = false;
      original('UPDATE physical_copies SET revision=revision WHERE physical_id=?').run(f.attempt.physicalId);
    }
    return original(sql);
  });
  store.event(f.attempt.id, { ...f.noChange, sourceFramesRead: 7, submittedFrames: 7, consumedFrames: 7 });
  assert.deepEqual([...attemptBudgetSql].map(sql => counts.get(sql) ?? 0), [1, 1, 1], '同连接未知写使写戳失效，提交前必须完整reconciliation三表预算');
  assert.equal(counts.get('SELECT * FROM recording_attempt_events WHERE attempt_id=? ORDER BY revision') ?? 0, 1, 'reconciliation必须恢复完整event链审计');
  assert.equal(counts.get('SELECT command_id,fingerprint,request,attempt_id,revision,result FROM recording_attempt_receipts ORDER BY rowid') ?? 0, 1, 'reconciliation必须恢复完整receipt审计');
  assert.equal([...counts.entries()].filter(([sql]) => attemptFallbackSumSql.has(sql)).reduce((sum, [, count]) => sum + count, 0), 0, '完整reconciliation已产生fresh预算token，不再执行第二轮裸SUM');
});

test('R023预算凭证：rollback、第二DB和硬边界均不能借用审计基线', async t => {
  const f = await auditFixture(t), { createRecordingAttemptAudit } = await import('../src/recording/attempt-integrity.js'), audit = createRecordingAttemptAudit();
  f.db.exec('BEGIN IMMEDIATE'); const rolledBack = audit.verify(f.db); f.db.exec('ROLLBACK');
  f.db.exec('BEGIN IMMEDIATE');
  try { assert.equal(audit.reserve(f.db, rolledBack, { addedBytes: 0, eventEntries: 0, receiptEntries: 0, emergency: false, maximumBytes: 128 * 1024 * 1024 }), false, '即使调用方漏掉clear，rollback也销毁本次事务token'); }
  finally { f.db.exec('ROLLBACK'); }

  f.db.exec('BEGIN IMMEDIATE'); const committed = audit.verify(f.db); f.db.exec('COMMIT');
  f.db.exec('BEGIN IMMEDIATE');
  try { assert.equal(audit.reserve(f.db, committed, { addedBytes: 0, eventEntries: 0, receiptEntries: 0, emergency: false, maximumBytes: 128 * 1024 * 1024 }), false, '空事务COMMIT后即使写戳未变也不能跨txn复用token'); }
  finally { f.db.exec('ROLLBACK'); }

  const clone = path.join(f.f.directory, 'attempt-budget-independent.sqlite'); await backup(f.db, clone);
  const other = new DatabaseSync(clone); t.after(() => other.close());
  f.db.exec('BEGIN IMMEDIATE'); const firstDb = audit.verify(f.db);
  other.exec('BEGIN IMMEDIATE');
  try { assert.equal(audit.reserve(other, firstDb, { addedBytes: 0, eventEntries: 0, receiptEntries: 0, emergency: false, maximumBytes: 128 * 1024 * 1024 }), false, '第二DatabaseSync不能消费第一DB token'); }
  finally { other.exec('ROLLBACK'); f.db.exec('ROLLBACK'); audit.clear(f.db); }

  f.db.exec('BEGIN IMMEDIATE');
  try {
    const valid = audit.verify(f.db, 80 * 1024);
    assert.equal(audit.reserve(f.db, valid, { addedBytes: 0, eventEntries: 0, receiptEntries: 0, emergency: false, maximumBytes: 80 * 1024 }), true, '绑定后的合法收紧预算仍可消费');
    const negative = audit.verify(f.db, 80 * 1024);
    assert.equal(audit.reserve(f.db, negative, { addedBytes: -1, eventEntries: 0, receiptEntries: 0, emergency: false, maximumBytes: 80 * 1024 }), false, '负addedBytes属于不确定输入，只能回退fresh预算');
    const mismatched = audit.verify(f.db, 80 * 1024);
    assert.equal(audit.reserve(f.db, mismatched, { addedBytes: 0, eventEntries: 0, receiptEntries: 0, emergency: false, maximumBytes: 128 * 1024 * 1024 }), false, '调用方不能在消费时放宽token绑定的最大预算');
    const oversized = audit.verify(f.db);
    assert.equal(audit.reserve(f.db, oversized, { addedBytes: 0, eventEntries: 0, receiptEntries: 0, emergency: false, maximumBytes: 128 * 1024 * 1024 + 1 }), false, '超过产品硬上限的maximumBytes必须回退');
  } finally { f.db.exec('ROLLBACK'); audit.clear(f.db); }

  f.db.exec('BEGIN IMMEDIATE'); const boundary = audit.verify(f.db);
  try {
    assert.throws(() => audit.reserve(f.db, boundary, { addedBytes: 128 * 1024 * 1024, eventEntries: 0, receiptEntries: 0, emergency: true, maximumBytes: 128 * 1024 * 1024 }), { code: 'BUDGET_EXCEEDED' }, '凭证只省重复读取，不放宽原硬字节上限');
  } finally { f.db.exec('ROLLBACK'); audit.clear(f.db); }

  f.db.exec('BEGIN IMMEDIATE');
  try {
    const batch = audit.verify(f.db);
    assert.equal(audit.reserve(f.db, batch, { addedBytes: 0, eventEntries: 4, receiptEntries: 1, emergency: true, maximumBytes: 128 * 1024 * 1024 }), true, 'Stop批次最多一次预留四个event和一个receipt');
    const overflow = audit.verify(f.db);
    assert.equal(audit.reserve(f.db, overflow, { addedBytes: 0, eventEntries: 5, receiptEntries: 1, emergency: true, maximumBytes: 128 * 1024 * 1024 } as never), false, 'eventEntries超过4只能拒绝，不得回退为无界批次');
  } finally { f.db.exec('ROLLBACK'); audit.clear(f.db); }
});

test('R023增量：同连接与第二连接篡改原事件／Plan／回执时热缓存拒绝，修复后重新全算', async t => {
  const f = await auditFixture(t), store = createRecordingAttemptStore({ read: f.read }), external = new DatabaseSync(f.f.filePath);
  t.after(() => external.close());
  const variants = [
    { db: f.db, table: 'recording_attempt_events', key: 'attempt_id', id: f.attempt.id, column: 'data', where: ' AND revision=2', changed: (raw: string) => raw.replace('"type":"progress"', '"type":"source-eof"') },
    { db: external, table: 'recording_attempt_events', key: 'attempt_id', id: f.attempt.id, column: 'event_hash', where: ' AND revision=2', changed: () => 'a'.repeat(64) },
    { db: external, table: 'recording_plan_versions', key: 'id', id: f.attempt.planVersionId, column: 'data', where: '', changed: (raw: string) => { const value = JSON.parse(raw); value.master.title += '合成变化'; return JSON.stringify(value); } },
    { db: f.db, table: 'recording_attempt_receipts', key: 'attempt_id', id: f.attempt.id, column: 'fingerprint', where: '', changed: () => 'b'.repeat(64) },
  ];
  for (const variant of variants) {
    store.event(f.attempt.id, f.noChange);
    const triggerName = `${variant.table}_no_update`, trigger = String(variant.db.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(triggerName)!.sql);
    const original = String(variant.db.prepare(`SELECT ${variant.column} value FROM ${variant.table} WHERE ${variant.key}=?${variant.where}`).get(variant.id)!.value);
    const changed = variant.changed(original); assert.notEqual(changed, original);
    const set = (value: string) => { variant.db.exec('BEGIN IMMEDIATE'); variant.db.exec(`DROP TRIGGER ${triggerName}`); variant.db.prepare(`UPDATE ${variant.table} SET ${variant.column}=? WHERE ${variant.key}=?${variant.where}`).run(value, variant.id); variant.db.exec(trigger); variant.db.exec('COMMIT'); };
    set(changed);
    assert.throws(() => store.event(f.attempt.id, f.noChange)); assert.throws(() => verifyRecordingAttemptDatabase(f.db));
    set(original); f.counts.event = 0;
    store.event(f.attempt.id, f.noChange); assert.equal(f.counts.event, 1, '异常后清缓存，不借旧证书跳过重新核验');
  }
});

test('R023增量：schema回写版本号仍拒绝，事务rollback后缓存清除且不预测尾部', async t => {
  const f = await auditFixture(t); let fail = false;
  const store = createRecordingAttemptStore({ read: f.read, beforeCommit() { if (fail) throw new Error('合成回滚'); } });
  store.event(f.attempt.id, f.noChange);
  const trigger = String(f.db.prepare("SELECT sql FROM sqlite_schema WHERE name='recording_attempt_events_no_update'").get()!.sql);
  const schemaVersion = Number(f.db.prepare('PRAGMA schema_version').get()!.schema_version);
  f.db.exec('DROP TRIGGER recording_attempt_events_no_update'); f.db.exec(`PRAGMA schema_version=${schemaVersion}`);
  assert.throws(() => store.event(f.attempt.id, f.noChange));
  f.db.exec(trigger); store.event(f.attempt.id, f.noChange);
  const before = rows(f.f.filePath); fail = true;
  assert.throws(() => store.event(f.attempt.id, { ...f.noChange, sourceFramesRead: 4, submittedFrames: 4, consumedFrames: 4 }));
  assert.deepEqual(rows(f.f.filePath), before);
  fail = false; f.counts.event = 0; f.counts.receiptRequest = 0; f.counts.receiptResult = 0;
  store.event(f.attempt.id, f.noChange); assert.equal(f.counts.event, 1);
  assert.ok(f.counts.receiptRequest > 0 && f.counts.receiptResult > 0, 'rollback清除回执证明，下一事务重新全审');
  f.counts.event = 0; store.event(f.attempt.id, f.noChange); assert.equal(f.counts.event, 0);
});

test('R023增量：实例隔离和收紧缓存预算只退回全审，不放宽持久预算', async t => {
  const f = await auditFixture(t), first = createRecordingAttemptStore({ read: f.read });
  first.event(f.attempt.id, f.noChange); first.event(f.attempt.id, f.noChange);
  f.counts.event = 0; createRecordingAttemptStore({ read: f.read }).event(f.attempt.id, f.noChange); assert.equal(f.counts.event, 1);
  const options = { read: f.read, audit: { maxBytes: 1, maxEntries: 1 } }, limited = createRecordingAttemptStore(options);
  limited.event(f.attempt.id, f.noChange); f.counts.event = 0; f.counts.receiptRequest = 0; f.counts.receiptResult = 0;
  limited.event(f.attempt.id, f.noChange); assert.equal(f.counts.event, 1);
  assert.ok(f.counts.receiptRequest > 0 && f.counts.receiptResult > 0, 'receipt raw超出缓存预算时每次完整重放');
});

test('R023增量：原始行集出现非正revision不能被尾部查询遗漏', async t => {
  const f = await auditFixture(t), store = createRecordingAttemptStore({ read: f.read });
  store.event(f.attempt.id, f.noChange);
  f.db.exec('PRAGMA ignore_check_constraints=ON');
  f.db.prepare('INSERT INTO recording_attempt_events SELECT attempt_id,0,kind,data,previous_hash,event_hash FROM recording_attempt_events WHERE attempt_id=? AND revision=2').run(f.attempt.id);
  f.db.exec('PRAGMA ignore_check_constraints=OFF');
  try {
    assert.throws(() => store.event(f.attempt.id, f.noChange));
    assert.throws(() => verifyRecordingAttemptDatabase(f.db));
  } finally {
    const trigger = String(f.db.prepare("SELECT sql FROM sqlite_schema WHERE name='recording_attempt_events_no_delete'").get()!.sql);
    f.db.exec('DROP TRIGGER recording_attempt_events_no_delete');
    f.db.prepare('DELETE FROM recording_attempt_events WHERE attempt_id=? AND revision=0').run(f.attempt.id); f.db.exec(trigger);
  }
});

test('R023增量：其他模块合法写不误报，当前实体与预留约束仍每次fresh检查', async t => {
  const f = await auditFixture(t), store = createRecordingAttemptStore({ read: f.read });
  store.event(f.attempt.id, f.noChange);
  f.f.repository.updateCopy({ commandId: randomUUID(), physicalId: f.attempt.physicalId, expectedRevision: f.f.frozenPlan.physicalCopy.revision, action: 'mark-unavailable' });
  f.counts.event = 0; store.event(f.attempt.id, f.noChange); assert.equal(f.counts.event, 0);
  const copy = f.db.prepare('SELECT usage,reserved_from FROM physical_copies WHERE physical_id=?').get(f.attempt.physicalId)!;
  const triggers = ['recording_attempt_copy_no_blank', 'recording_record_content_copy_guard'].map(name => ({ name, sql: String(f.db.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(name)!.sql) }));
  for (const trigger of triggers) f.db.exec(`DROP TRIGGER ${trigger.name}`);
  f.db.prepare("UPDATE physical_copies SET usage='blank',reserved_from=NULL WHERE physical_id=?").run(f.attempt.physicalId);
  for (const trigger of triggers) f.db.exec(trigger.sql);
  assert.throws(() => store.event(f.attempt.id, f.noChange));
  for (const trigger of triggers) f.db.exec(`DROP TRIGGER ${trigger.name}`);
  f.db.prepare('UPDATE physical_copies SET usage=?,reserved_from=? WHERE physical_id=?').run(copy.usage!, copy.reserved_from!, f.attempt.physicalId);
  for (const trigger of triggers) f.db.exec(trigger.sql);
  store.event(f.attempt.id, f.noChange);
  const reservation = f.db.prepare('SELECT * FROM media_reservations WHERE physical_id=?').get(f.attempt.physicalId)!;
  const protection = String(f.db.prepare("SELECT sql FROM sqlite_schema WHERE name='recording_attempt_reservation_no_delete'").get()!.sql);
  f.db.exec('DROP TRIGGER recording_attempt_reservation_no_delete');
  f.db.prepare('DELETE FROM media_reservations WHERE physical_id=?').run(f.attempt.physicalId); f.db.exec(protection);
  try { assert.throws(() => store.event(f.attempt.id, f.noChange)); }
  finally { f.db.prepare(`INSERT INTO media_reservations(${Object.keys(reservation).join(',')}) VALUES(${Object.keys(reservation).map(() => '?').join(',')})`).run(...Object.values(reservation)); }
});

test('R023：合法Stop进入同步持久审计前已发出abort并调用自建driver.stop', async t => {
  const f = await fixture(t), original = f.repository.recordingAttempts;
  let signal: AbortSignal | undefined, stopCalls = 0;
  let atPersistence: { aborted: boolean; stopCalls: number } | undefined;
  const cleanupPersistence: { type: string; aborted: boolean; stopCalls: number }[] = [];
  const coordinator = createRecordingAttemptCoordinator({
    store: { ...original, stop(request, event, observedCleanup) {
      atPersistence = { aborted: signal?.aborted ?? false, stopCalls };
      cleanupPersistence.push(...observedCleanup.map(value => ({ type: value.type, aborted: signal?.aborted ?? false, stopCalls })));
      return original.stop(request, event, observedCleanup);
    }, event(attemptId, event) {
      return original.event(attemptId, event);
    } },
    admissionProvider: { async authorize() {}, async start(request) {
      signal = request.signal;
      request.signal.addEventListener('abort', () => {
        for (const type of ['engine-cutoff', 'stop-ack', 'cleanup-quiescent'] as const) {
          request.onEvent({ type, side: request.side, runId: request.runId, at: new Date().toISOString() });
        }
      }, { once: true });
      return { async stop() { ++stopCalls; }, async close() {} };
    } },
  });
  t.after(() => coordinator.close());
  const attempt = await coordinator.begin(f.beginRequest());
  await coordinator.stop({ commandId: randomUUID(), attemptId: attempt.id });
  assert.deepEqual(atPersistence, { aborted: true, stopCalls: 1 });
  assert.deepEqual(cleanupPersistence, ['engine-cutoff', 'stop-ack', 'cleanup-quiescent'].map(type => ({ type, aborted: true, stopCalls: 1 })));
  const final = coordinator.get({ attemptId: attempt.id }).attempt!;
  assert.equal(final.reason, 'user-stop');
  assert.equal(final.sides[0]!.engineStoppedSubmitting, true);
  assert.equal(final.sides[0]!.stopAcknowledged, true);
  assert.equal(final.sides[0]!.cleanupQuiescent, true);
});

test('R023 Stop批写：同步终止事实、abort与命令回执只提交一个事务', async t => {
  const f = await fixture(t), original = f.repository.recordingAttempts;
  let eventTransactions = 0, commandTransactions = 0;
  const coordinator = createRecordingAttemptCoordinator({ store: { ...original,
    event(attemptId, event) { ++eventTransactions; return original.event(attemptId, event); },
    command(action, request, event) { ++commandTransactions; return original.command(action, request, event); },
  },
    admissionProvider: { async authorize() {}, async start(request) {
      request.signal.addEventListener('abort', () => {
        for (const type of ['stop-ack', 'engine-cutoff', 'cleanup-quiescent'] as const) {
          request.onEvent({ type, side: request.side, runId: request.runId, at: new Date().toISOString() });
        }
      }, { once: true });
      return { async stop() {}, async close() {} };
    } },
  });
  t.after(() => coordinator.close());
  const attempt = await coordinator.begin(f.beginRequest());
  eventTransactions = 0; commandTransactions = 0;
  const stopped = await coordinator.stop({ commandId: randomUUID(), attemptId: attempt.id });
  assert.equal(stopped.status, 'aborted');
  assert.deepEqual(stopped.sides.map(side => ({ cutoff: side.engineStoppedSubmitting, ack: side.stopAcknowledged, cleanup: side.cleanupQuiescent })),
    [{ cutoff: true, ack: true, cleanup: true }, { cutoff: false, ack: false, cleanup: false }]);
  assert.deepEqual({ eventTransactions, commandTransactions }, { eventTransactions: 0, commandTransactions: 0 }, 'Stop须经独立窄批API一次提交，不能逐event再command');
  const db = new DatabaseSync(f.filePath, { readOnly: true }); t.after(() => db.close());
  assert.deepEqual(db.prepare('SELECT kind FROM recording_attempt_events WHERE attempt_id=? ORDER BY revision').all(attempt.id).map(row => row.kind),
    ['begin', 'stop-ack', 'engine-cutoff', 'cleanup-quiescent', 'abort'], '批内按首次到达顺序追加，abort固定在真实清理事实之后');
});

test('R023：提前派发停止仍须拒绝旧scope、错误目标与复用冲突命令，重放不重复停止', async t => {
  const f = await fixture(t); let scope = true, stops = 0, signal: AbortSignal | undefined;
  const coordinator = createRecordingAttemptCoordinator({ store: f.repository.recordingAttempts,
    assertCurrent() { if (!scope) throw new Error('合成旧scope'); },
    admissionProvider: { async authorize() {}, async start(request) {
      signal = request.signal; return { async stop() { ++stops; }, async close() {} };
    } },
  });
  t.after(() => coordinator.close());
  const begin = f.beginRequest(), attempt = await coordinator.begin(begin);
  await assert.rejects(coordinator.stop({ commandId: begin.commandId, attemptId: attempt.id }), { code: 'COMMAND_CONFLICT' });
  await assert.rejects(coordinator.stop({ commandId: randomUUID(), attemptId: randomUUID() }), { code: 'ATTEMPT_NOT_FOUND' });
  scope = false;
  await assert.rejects(coordinator.stop({ commandId: randomUUID(), attemptId: attempt.id }), /合成旧scope/);
  assert.equal(stops, 0); assert.equal(signal?.aborted, false);
  scope = true;
  const stop = { commandId: randomUUID(), attemptId: attempt.id }, result = await coordinator.stop(stop);
  assert.equal(result.status, 'aborted');
  assert.deepEqual(await coordinator.stop(stop), result); assert.equal(stops, 1);
});

test('R023：driver.stop同步重入事件不抢占用户停止终态，清理证据保留且不重复stop', async t => {
  const f = await fixture(t); let stops = 0;
  const coordinator = createRecordingAttemptCoordinator({ store: f.repository.recordingAttempts,
    admissionProvider: { async authorize() {}, async start(request) {
      return { async stop() {
        ++stops; const identity = { side: request.side, runId: request.runId, at: new Date().toISOString() };
        request.onEvent({ ...identity, type: 'engine-cutoff' });
        request.onEvent({ ...identity, type: 'interrupt', reason: 'backend-failure' });
      }, async close() {} };
    } },
  });
  t.after(() => coordinator.close());
  const attempt = await coordinator.begin(f.beginRequest());
  await coordinator.stop({ commandId: randomUUID(), attemptId: attempt.id });
  await new Promise<void>(resolve => setImmediate(resolve));
  const result = coordinator.get({ attemptId: attempt.id }).attempt!;
  assert.equal(result.status, 'aborted'); assert.equal(result.reason, 'user-stop');
  assert.equal(result.sides[0]!.engineStoppedSubmitting, true); assert.equal(stops, 1);
});

test('R023 Stop批写：不等待或伪造异步ACK，迟到ACK与真实close清理仍独立持久化', async t => {
  const f = await fixture(t), stopEntered = deferred<void>(), allowAck = deferred<void>();
  let signal: AbortSignal | undefined;
  const coordinator = createRecordingAttemptCoordinator({ store: f.repository.recordingAttempts,
    admissionProvider: { async authorize() {}, async start(request) {
      signal = request.signal;
      return { async stop() { stopEntered.resolve(); await allowAck.promise; request.onEvent({ type: 'stop-ack', side: request.side, runId: request.runId, at: new Date().toISOString() }); },
        async close() { request.onEvent({ type: 'cleanup-quiescent', side: request.side, runId: request.runId, at: new Date().toISOString() }); } };
    } },
  });
  t.after(() => coordinator.close());
  const attempt = await coordinator.begin(f.beginRequest()), stopPromise = coordinator.stop({ commandId: randomUUID(), attemptId: attempt.id });
  await stopEntered.promise;
  const stopped = await stopPromise;
  assert.ok(signal?.aborted); assert.equal(stopped.status, 'aborted');
  assert.equal(stopped.sides[0]!.stopAcknowledged, false); assert.equal(stopped.sides[0]!.cleanupQuiescent, false);
  allowAck.resolve(); await coordinator.close();
  const final = f.repository.recordingAttempts.get({ attemptId: attempt.id }).attempt!;
  assert.equal(final.sides[0]!.stopAcknowledged, true); assert.equal(final.sides[0]!.cleanupQuiescent, true);
});

test('生产未认证Begin固定拒绝，正式历史/账本/库存均不写且不调用驱动', async t => {
  const f = await fixture(t), coordinator = createRecordingAttemptCoordinator({ store: f.repository.recordingAttempts });
  t.after(() => coordinator.close()); const before = rows(f.filePath);
  await assert.rejects(coordinator.begin(f.beginRequest()), { code: 'BACKEND_NOT_CERTIFIED' });
  assert.deepEqual(rows(f.filePath), before); assert.equal(f.starts.length, 0);
});

test('同命令同body返回原回执且不重启输出，异body拒绝；并发Begin只准一个', async t => {
  const f = await fixture(t), request = f.beginRequest();
  const [a, b] = await Promise.all([f.attempts.begin(request), f.attempts.begin(request)]);
  assert.deepEqual(a, b); assert.equal(f.starts.length, 1);
  await assert.rejects(f.attempts.begin({ ...request, planContentHash: 'a'.repeat(64) }), { code: 'COMMAND_CONFLICT' });
  await assert.rejects(f.attempts.begin(f.beginRequest()), { code: 'ATTEMPT_CONFLICT' });
  const stopped = await f.attempts.stop({ commandId: randomUUID(), attemptId: a.id });
  assert.equal(stopped.status, 'aborted');
  assert.deepEqual(await f.attempts.begin(request), a, '原命令永久返回原结果，不把后来终态回填到开始回执');
  assert.equal(f.starts.length, 1);
});

test('停止回执不伪造驱动ACK/排空，迟到成功和旧runId不能覆盖首个终态', async t => {
  const f = await fixture(t), a = await f.attempts.begin(f.beginRequest()), driver = f.starts[0]!;
  const request = { commandId: randomUUID(), attemptId: a.id }, stopped = await f.attempts.stop(request);
  assert.equal(stopped.sides[0]!.stopAcknowledged, false); assert.equal(stopped.sides[0]!.backendDrained, false);
  driver.onEvent({ type: 'backend-drained', side: 'A', runId: driver.runId, at: new Date().toISOString() });
  driver.onEvent({ type: 'interrupt', reason: 'device-lost', side: 'A', runId: randomUUID(), at: new Date().toISOString() });
  assert.deepEqual(await f.attempts.stop(request), stopped);
  assert.equal(f.attempts.get({ attemptId: a.id }).attempt!.reason, 'user-stop');
  assert.equal(f.attempts.get({ attemptId: a.id }).attempt!.softwarePlaybackComplete, false);
});

test('命令确认CAS与事务提交故障不留下孤立event/head/receipt', async t => {
  const f = await fixture(t), a = await f.attempts.begin(f.beginRequest());
  await assert.rejects(f.attempts.confirm({ commandId: randomUUID(), attemptId: a.id, expectedRevision: a.revision + 1, kind: 'physical-stop', side: 'A', userConfirmed: true }), { code: 'VERSION_MISMATCH' });
  const repository = createCollectionRepository({ filePath: f.filePath, beforeCommit(action) { if (action === 'attempt-stop') throw new Error('合成提交故障'); } });
  t.after(() => repository.close());
  // 新连接先执行冷启中断；此后的命令事务仍须完全回滚。
  repository.recordingAttempts.list({ page }); const before = rows(f.filePath);
  assert.throws(() => repository.recordingAttempts.command('stop', { commandId: randomUUID(), attemptId: a.id }, { type: 'abort', reason: 'user-stop', at: new Date().toISOString() }));
  assert.deepEqual(rows(f.filePath), before);
});

test('冷启将未结束Attempt仅中断一次，恢复不调用任何driver且不伪造cleanup', async t => {
  const f = await fixture(t), a = await f.attempts.begin(f.beginRequest());
  const first = createCollectionRepository({ filePath: f.filePath });
  const recovered = first.recordingAttempts.get({ attemptId: a.id }).attempt!;
  assert.equal(recovered.status, 'interrupted'); assert.equal(recovered.reason, 'app-restarted');
  assert.equal(recovered.sides[0]!.cleanupQuiescent, false); first.close();
  const second = createCollectionRepository({ filePath: f.filePath }); t.after(() => second.close());
  assert.deepEqual(second.recordingAttempts.get({ attemptId: a.id }).attempt, recovered);
  assert.equal(f.starts.length, 1);
});

test('开始后的实体不能从规划或手工释放为空白，库存数量不变', async t => {
  const f = await fixture(t), before = f.repository.list(page).items[0]!.counts;
  const a = await f.attempts.begin(f.beginRequest()); await f.attempts.stop({ commandId: randomUUID(), attemptId: a.id });
  assert.throws(() => f.repository.media.release({ commandId: randomUUID(), planId: f.plan.id, expectedRevision: f.plan.revision, userConfirmed: true }));
  assert.throws(() => f.repository.updateCopy({ commandId: randomUUID(), physicalId: a.physicalId, expectedRevision: f.frozenPlan.physicalCopy.revision, action: 'cancel-reservation' }));
  assert.deepEqual(f.repository.list(page).items[0]!.counts, before);
});

test('只读完整性核验拒绝篡改head，冷启不得把坏历史修成合法Interrupted', async t => {
  const f = await fixture(t), a = await f.attempts.begin(f.beginRequest());
  const db = new DatabaseSync(f.filePath); t.after(() => db.close()); verifyRecordingAttemptDatabase(db);
  db.prepare("UPDATE recording_attempts SET data=json_set(data,'$.revision',99) WHERE id=?").run(a.id);
  assert.throws(() => verifyRecordingAttemptDatabase(db)); const before = rows(f.filePath);
  const invalid = createCollectionRepository({ filePath: f.filePath }); t.after(() => invalid.close());
  assert.throws(() => invalid.recordingAttempts.list({ page })); assert.deepEqual(rows(f.filePath), before);
});

test('DAT独立Program身份固定；分页与越界保留正确total', async t => {
  const f = await fixture(t, 'dat'), a = await f.attempts.begin(f.beginRequest());
  assert.deepEqual(a.sides.map(side => side.side), ['Program']); assert.equal(f.starts[0]!.side, 'Program');
  const result = f.attempts.list({ page: { offset: 10, limit: 1 }, draftId: a.draftId });
  assert.deepEqual(result, { items: [], offset: 10, limit: 1, total: 1, hasMore: false });
  await assert.rejects(f.attempts.beginSide({ commandId: randomUUID(), attemptId: a.id, expectedRevision: a.revision, side: 'B', userConfirmed: true }));
});

test('已打开库中合法形状的head篡改也必须拒读，不能仅靠DTO结构校验', async t => {
  const f = await fixture(t), a = await f.attempts.begin(f.beginRequest());
  const db = new DatabaseSync(f.filePath); t.after(() => db.close());
  db.prepare("UPDATE recording_attempts SET data=json_set(data,'$.updatedAt','2099-01-01T00:00:00.000Z') WHERE id=?").run(a.id);
  assert.throws(() => f.attempts.get({ attemptId: a.id }));
});

test('close先到后start迟到成功必须拒绝原Promise，并关闭该迟到handle', async t => {
  const f = await fixture(t), entered = deferred<void>(), handle = deferred<RecordingAttemptDriver>();
  let stops = 0, closes = 0;
  const coordinator = createRecordingAttemptCoordinator({ store: f.repository.recordingAttempts, admissionProvider: { async authorize() {}, start() { entered.resolve(); return handle.promise; } } });
  const pending = coordinator.begin(f.beginRequest()); await entered.promise;
  const rejected = assert.rejects(pending, { code: 'CLOSED' }), closing = coordinator.close();
  handle.resolve({ async stop() { ++stops; }, async close() { ++closes; } });
  await rejected; await closing; assert.equal(stops, 1); assert.equal(closes, 1);
  assert.equal(f.repository.recordingAttempts.list({ page }).items[0]!.status, 'interrupted');
});

test('stop已到终态后close不再写recover，driver只停止关闭一次', async t => {
  const f = await fixture(t), original = f.repository.recordingAttempts;
  const closeEntered = deferred<void>(), allowClose = deferred<void>();
  const auditDb = new DatabaseSync(f.filePath), prepare = auditDb.prepare.bind(auditDb), scans = new Map<string, number>();
  t.after(() => auditDb.close());
  t.mock.method(auditDb, 'prepare', function(sql: string) {
    scans.set(sql, (scans.get(sql) ?? 0) + 1);
    return prepare(sql);
  });
  const fullBudgetSql = [
    'SELECT count(*) n,COALESCE(sum(length(CAST(data AS BLOB))),0) bytes FROM recording_attempts',
    'SELECT count(*) n,COALESCE(sum(length(CAST(data AS BLOB))),0) bytes FROM recording_attempt_events',
    'SELECT count(*) n,COALESCE(sum(length(CAST(request AS BLOB))+length(CAST(result AS BLOB))),0) bytes FROM recording_attempt_receipts',
  ] as const;
  const oldEventsSql = 'SELECT * FROM recording_attempt_events WHERE attempt_id=? ORDER BY revision';
  const receiptsSql = 'SELECT command_id,fingerprint,request,attempt_id,revision,result FROM recording_attempt_receipts ORDER BY rowid';
  let auditOnGet = false, recoverCalls = 0, stops = 0, closes = 0;
  const coordinator = createRecordingAttemptCoordinator({
    store: { ...original, get(request) {
      if (auditOnGet) verifyRecordingAttemptDatabase(auditDb);
      return original.get(request);
    }, event(attemptId, event) {
      if (event.type === 'recover') ++recoverCalls;
      return original.event(attemptId, event);
    } },
    admissionProvider: { async authorize() {}, async start() {
      return { async stop() { ++stops; }, async close() { ++closes; closeEntered.resolve(); await allowClose.promise; } };
    } },
  });
  const attempt = await coordinator.begin(f.beginRequest());
  const stopped = await coordinator.stop({ commandId: randomUUID(), attemptId: attempt.id });
  await closeEntered.promise;
  assert.equal(stopped.status, 'aborted');
  scans.clear(); auditOnGet = true;
  const closing = coordinator.close(), recoverCallsAtClose = recoverCalls;
  allowClose.resolve(); await closing;
  assert.deepEqual({
    fullCountAndSum: fullBudgetSql.reduce((sum, sql) => sum + (scans.get(sql) ?? 0), 0),
    oldEventScans: scans.get(oldEventsSql) ?? 0,
    completeReceiptScans: scans.get(receiptsSql) ?? 0,
    recoverCalls: recoverCallsAtClose,
    stops,
    closes,
  }, {
    fullCountAndSum: 0,
    oldEventScans: 0,
    completeReceiptScans: 0,
    recoverCalls: 0,
    stops: 1,
    closes: 1,
  }, '终态Stop已给出持久状态，close不得再经store.get触发大历史完整审计，也不得写recover');
});

test('活动Attempt直接close恰好写一次recover，driver只停止关闭一次', async t => {
  const f = await fixture(t), original = f.repository.recordingAttempts;
  let recoverCalls = 0, stops = 0, closes = 0;
  const coordinator = createRecordingAttemptCoordinator({
    store: { ...original, event(attemptId, event) {
      if (event.type === 'recover') ++recoverCalls;
      return original.event(attemptId, event);
    } },
    admissionProvider: { async authorize() {}, async start() {
      return { async stop() { ++stops; }, async close() { ++closes; } };
    } },
  });
  const attempt = await coordinator.begin(f.beginRequest());
  await coordinator.close();
  assert.deepEqual({ recoverCalls, stops, closes }, { recoverCalls: 1, stops: 1, closes: 1 });
  assert.equal(original.get({ attemptId: attempt.id }).attempt!.status, 'interrupted');
});

test('stop先到不遗失晚返回handle，terminal但close未完成仍阻断新Begin', async t => {
  const f = await fixture(t), entered = deferred<void>(), handle = deferred<RecordingAttemptDriver>(), closedHandle = deferred<void>();
  let stops = 0, closes = 0;
  const coordinator = createRecordingAttemptCoordinator({ store: f.repository.recordingAttempts, admissionProvider: { async authorize() {}, start() { entered.resolve(); return handle.promise; } } });
  t.after(() => coordinator.close());
  const pending = coordinator.begin(f.beginRequest()); await entered.promise;
  const a = coordinator.list({ page }).items[0]!;
  await coordinator.stop({ commandId: randomUUID(), attemptId: a.id });
  handle.resolve({ async stop() { ++stops; }, async close() { ++closes; await closedHandle.promise; } });
  await pending;
  await assert.rejects(coordinator.begin(f.beginRequest()), { code: 'ATTEMPT_CONFLICT' });
  closedHandle.resolve(); await coordinator.close(); assert.equal(stops, 1); assert.equal(closes, 1);
});

test('准入期间切库或close使迟到成功失效，不留Attempt且零driver调用', async t => {
  for (const mode of ['scope', 'close'] as const) {
    const f = await fixture(t), entered = deferred<void>(), admitted = deferred<void>(); let current = true, starts = 0;
    const coordinator = createRecordingAttemptCoordinator({ store: f.repository.recordingAttempts, assertCurrent() { if (!current) throw new Error('合成旧工作库'); }, admissionProvider: {
      async authorize() { entered.resolve(); await admitted.promise; }, async start() { ++starts; return { async stop() {}, async close() {} }; },
    } });
    const pending = coordinator.begin(f.beginRequest()); await entered.promise;
    const rejected = assert.rejects(pending); let closing: Promise<void> | undefined;
    if (mode === 'scope') current = false; else closing = coordinator.close();
    admitted.resolve(); await rejected; await closing; await coordinator.close();
    assert.equal(starts, 0); assert.equal(f.repository.recordingAttempts.list({ page }).total, 0);
  }
});

test('start未产生进度即失败保存Failed，不能与已输出中断混淆', async t => {
  const f = await fixture(t), coordinator = createRecordingAttemptCoordinator({ store: f.repository.recordingAttempts, admissionProvider: { async authorize() {}, async start() { throw new Error('合成启动失败'); } } });
  await assert.rejects(coordinator.begin(f.beginRequest()), { code: 'BACKEND_FAILURE' });
  const a = f.repository.recordingAttempts.list({ page }).items[0]!;
  assert.equal(a.status, 'failed'); assert.equal(a.reason, 'backend-start-failed');
  await coordinator.close().catch(() => undefined);
});

test('时钟回拨不能挡住明确Stop，安全事件时间不得早于既有事实', async t => {
  const f = await fixture(t), a = await f.attempts.begin(f.beginRequest()), driver = f.starts[0]!;
  driver.onEvent({ type: 'progress', side: 'A', runId: driver.runId, at: '2099-01-01T00:00:00.000Z', sourceFramesRead: 1, submittedFrames: 1, consumedFrames: 0 });
  const stopped = await f.attempts.stop({ commandId: randomUUID(), attemptId: a.id });
  assert.equal(stopped.status, 'aborted'); assert.equal(stopped.updatedAt, '2099-01-01T00:00:00.000Z');
});

test('R023 Stop批写：abort时间不早于批内driver清理事实', async t => {
  const f = await fixture(t), future = '2099-02-03T04:05:06.000Z';
  const coordinator = createRecordingAttemptCoordinator({ store: f.repository.recordingAttempts,
    admissionProvider: { async authorize() {}, async start(request) {
      request.signal.addEventListener('abort', () => request.onEvent({ type: 'engine-cutoff', side: request.side, runId: request.runId, at: future }), { once: true });
      return { async stop() {}, async close() {} };
    } },
  });
  t.after(() => coordinator.close());
  const attempt = await coordinator.begin(f.beginRequest()), stopped = await coordinator.stop({ commandId: randomUUID(), attemptId: attempt.id });
  assert.equal(stopped.updatedAt, future); assert.equal(stopped.endedAt, future);
  const db = new DatabaseSync(f.filePath, { readOnly: true }); t.after(() => db.close());
  const tail = db.prepare('SELECT data FROM recording_attempt_events WHERE attempt_id=? ORDER BY revision DESC LIMIT 2').all(attempt.id)
    .map(row => { const value = (JSON.parse(String(row.data)) as { event: { type: string; at: string } }).event; return { type: value.type, at: value.at }; });
  assert.deepEqual(tail, [{ type: 'abort', at: future }, { type: 'engine-cutoff', at: future }]);
});

test('停止写入故障也必须停止自建driver，不能因事务失败继续输出', async t => {
  const f = await fixture(t); let failStop = false, stops = 0, closes = 0;
  const repository = createCollectionRepository({ filePath: f.filePath, beforeCommit(action) { if (failStop && action === 'attempt-stop') throw new Error('合成停止写入故障'); } });
  t.after(() => repository.close());
  const coordinator = createRecordingAttemptCoordinator({ store: repository.recordingAttempts, admissionProvider: { async authorize() {}, async start(request) { return { async stop() {
    ++stops; const identity = { side: request.side, runId: request.runId, at: new Date().toISOString() };
    request.onEvent({ ...identity, type: 'engine-cutoff' }); request.onEvent({ ...identity, type: 'stop-ack' });
  }, async close() { ++closes; } }; } } });
  t.after(() => coordinator.close()); const a = await coordinator.begin(f.beginRequest()); failStop = true;
  await assert.rejects(coordinator.stop({ commandId: randomUUID(), attemptId: a.id }));
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(stops, 1); assert.equal(closes, 1);
  assert.equal(coordinator.get({ attemptId: a.id }).attempt!.status, 'interrupted');
  const db = new DatabaseSync(f.filePath, { readOnly: true }); t.after(() => db.close());
  const kinds = db.prepare('SELECT kind FROM recording_attempt_events WHERE attempt_id=? ORDER BY revision').all(a.id).map(row => row.kind);
  assert.equal(kinds.includes('engine-cutoff'), false); assert.equal(kinds.includes('stop-ack'), false); assert.equal(kinds.includes('abort'), false);
  assert.equal(db.prepare('SELECT 1 FROM recording_attempt_receipts WHERE json_extract(request,\'$.action\')=\'stop\' AND attempt_id=?').get(a.id), undefined);
});

test('旧Attempt终态仍保护同一实体，新Begin不能无核实重录', async t => {
  const f = await fixture(t), a = await f.attempts.begin(f.beginRequest());
  await f.attempts.stop({ commandId: randomUUID(), attemptId: a.id });
  await new Promise<void>(resolve => setImmediate(resolve));
  await assert.rejects(f.attempts.begin(f.beginRequest()), { code: 'COPY_UNAVAILABLE' }); assert.equal(f.starts.length, 1);
});

test('只向下收紧存储预算，进度耗尽时仍保留一次安全Interrupted空间', async t => {
  const f = await fixture(t), db = new DatabaseSync(f.filePath); t.after(() => db.close());
  const store = createRecordingAttemptStore({ read: fn => fn(db), databaseBudgetBytes: 80 * 1024 });
  const coordinator = createRecordingAttemptCoordinator({ store, admissionProvider: f.provider }); t.after(() => coordinator.close());
  const a = await coordinator.begin(f.beginRequest()), driver = f.starts[0]!;
  for (let frame = 1; frame < 100 && store.get({ attemptId: a.id }).attempt!.status === 'in-progress'; ++frame) driver.onEvent({ type: 'progress', side: 'A', runId: driver.runId, at: new Date().toISOString(), sourceFramesRead: frame, submittedFrames: frame, consumedFrames: frame });
  const final = store.get({ attemptId: a.id }).attempt!;
  assert.equal(final.status, 'interrupted'); assert.equal(final.softwarePlaybackComplete, false);
  verifyRecordingAttemptDatabase(db); assert.equal(store.list({ page }).total, 1);
});

test('driver close永不完成时close有界失败，历史不伪造静止或排空', async t => {
  const f = await fixture(t), never = new Promise<void>(() => {});
  const coordinator = createRecordingAttemptCoordinator({ store: f.repository.recordingAttempts, closeTimeoutMs: 25, admissionProvider: { async authorize() {}, async start() { return { async stop() {}, close: () => never }; } } });
  const a = await coordinator.begin(f.beginRequest()); await assert.rejects(coordinator.close(), { code: 'BACKEND_FAILURE' });
  const after = f.repository.recordingAttempts.get({ attemptId: a.id }).attempt!;
  assert.equal(after.status, 'interrupted'); assert.equal(after.sides[0]!.cleanupQuiescent, false); assert.equal(after.sides[0]!.backendDrained, false);
  await assert.rejects(coordinator.begin(f.beginRequest()), { code: 'CLOSED' });
});

test('真实A/B冻结资产到三层完成的持久链：翻面确认不输出，B必须新边界', async t => {
  const f = await fixture(t), initial = await f.attempts.begin(f.beginRequest());
  assert.deepEqual(initial.sides.map(side => side.side), ['A', 'B']);
  async function completeSide(index: number) {
    const driver = f.starts[index]!, side = driver.attempt.sides.find(value => value.side === driver.side)!;
    const identity = { side: driver.side, runId: driver.runId, at: new Date().toISOString() };
    driver.onEvent({ ...identity, type: 'progress', sourceFramesRead: side.frameCount, submittedFrames: side.frameCount, consumedFrames: side.frameCount });
    driver.onEvent({ ...identity, type: 'source-eof' });
    assert.equal(f.attempts.get({ attemptId: initial.id }).attempt!.status, 'in-progress');
    driver.onEvent({ ...identity, type: 'engine-cutoff' }); driver.onEvent({ ...identity, type: 'backend-drained' });
    await new Promise<void>(resolve => setImmediate(resolve));
    const current = f.attempts.get({ attemptId: initial.id }).attempt!;
    return f.attempts.confirm({ commandId: randomUUID(), attemptId: current.id, expectedRevision: current.revision, kind: 'physical-stop', side: driver.side, userConfirmed: true });
  }
  const a = await completeSide(0); assert.equal(a.phase, 'awaiting-flip'); assert.equal(f.starts.length, 1);
  const flip = await f.attempts.confirm({ commandId: randomUUID(), attemptId: a.id, expectedRevision: a.revision, kind: 'flip', userConfirmed: true });
  assert.equal(f.starts.length, 1);
  await f.attempts.beginSide({ commandId: randomUUID(), attemptId: a.id, expectedRevision: flip.revision, side: 'B', userConfirmed: true });
  assert.equal(f.starts.length, 2); assert.notEqual(f.starts[0]!.runId, f.starts[1]!.runId);
  const b = await completeSide(1); assert.equal(b.softwarePlaybackComplete, true); assert.equal(b.status, 'in-progress');
  const physical = await f.attempts.confirm({ commandId: randomUUID(), attemptId: b.id, expectedRevision: b.revision, kind: 'physical-recording', userConfirmed: true });
  assert.equal(physical.status, 'in-progress');
  const final = await f.attempts.confirm({ commandId: randomUUID(), attemptId: b.id, expectedRevision: physical.revision, kind: 'final-verification', userConfirmed: true });
  assert.equal(final.status, 'completed');
  const db = new DatabaseSync(f.filePath, { readOnly: true }); t.after(() => db.close()); verifyRecordingAttemptDatabase(db);
});

test('持久化开始边界失败零driver；start同步事件到达时头和原命令回执已经存在', async t => {
  const f = await fixture(t); let failBegin = true, starts = 0;
  const repository = createCollectionRepository({ filePath: f.filePath, beforeCommit(action) { if (failBegin && action === 'attempt-begin') throw new Error('合成开始提交故障'); } });
  t.after(() => repository.close());
  const coordinator = createRecordingAttemptCoordinator({ store: repository.recordingAttempts, admissionProvider: { async authorize() {}, async start(request) {
    ++starts; assert.equal(repository.recordingAttempts.get({ attemptId: request.attempt.id }).attempt!.revision, 1);
    request.onEvent({ type: 'progress', side: request.side, runId: request.runId, at: new Date().toISOString(), sourceFramesRead: 1, submittedFrames: 1, consumedFrames: 0 });
    return { async stop() {}, async close() {} };
  } } });
  t.after(() => coordinator.close()); const request = f.beginRequest();
  await assert.rejects(coordinator.begin(request)); assert.equal(starts, 0); assert.equal(repository.recordingAttempts.list({ page }).total, 0);
  failBegin = false; const result = await coordinator.begin(request);
  assert.equal(starts, 1); assert.equal(result.revision, 1); assert.equal(repository.recordingAttempts.get({ attemptId: result.id }).attempt!.revision, 2);
  assert.deepEqual(await coordinator.begin(request), result);
});

test('只锁活动Attempt所选规划，其他实体仍可规划预留，终态不永久锁草稿编辑', async t => {
  const f = await fixture(t), a = await f.attempts.begin(f.beginRequest());
  const preview = await f.media.preview({ draftId: a.draftId, spec: f.layout.spec, page });
  const request = { draftId: a.draftId, expectedDraftRevision: preview.draftRevision, inputFingerprint: preview.inputFingerprint, spec: f.layout.spec };
  await assert.rejects(f.media.save({ ...request, commandId: randomUUID(), planId: f.plan.id, expectedRevision: f.plan.revision }));
  const other = await f.media.save({ ...request, commandId: randomUUID() });
  const reserved = await f.media.reserve({ commandId: randomUUID(), planId: other.id, expectedRevision: other.revision, skuId: f.plan.reservation!.skuId, packaging: 'opened', userConfirmed: true });
  assert.notEqual(reserved.reservation!.physicalId, a.physicalId);
  await f.attempts.stop({ commandId: randomUUID(), attemptId: a.id });
  const edited = await f.media.save({ ...request, commandId: randomUUID(), planId: f.plan.id, expectedRevision: f.plan.revision });
  assert.equal(edited.revision, f.plan.revision + 1); assert.equal(edited.reservation!.physicalId, a.physicalId);
});
