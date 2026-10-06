import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { buildStoragePolicy } from '../../../apps/desktop/scripts/build-storage-root.mjs';
import { assertFinalScope, discoverNestedTests, makeReaderBinding, makeCueBinding, makeStartupBinding, capture, stageExecutionCaptured, stagePassed, createBudget } from '../verify-mbrs003-scan.mjs';
import { validateScaleObservation, readSnapshot04LoadEvidence } from '../mbrs003-scale-receipts.mjs';
import { parseTestCounts } from '../verify-mbrs001-offline.mjs';

function temporary() {
  const policy = buildStoragePolicy(), base = policy.check(process.env.TMPDIR,{ mustExist:true });
  const directory = mkdtempSync(path.join(base,'mbrs003-gate-unit-')); chmodSync(directory,0o700); policy.check(directory,{ mustExist:true });
  return directory;
}
function scope() {
  return { schema:'mbrs003.scan-gate-scope.v2',status:'FINAL_NESTED_SOFTWARE_FROZEN',implementationComplete:true,countsConfirmed:true,groups:[
    {name:'contract',directory:'packages/contracts',layer:'UNIT',expectedTests:1,tests:['test/mbrs003/a.test.ts']},
    {name:'unit',directory:'packages/bridge-core',layer:'UNIT',expectedTests:1,tests:['test/mbrs003/b.test.ts']},
    {name:'reader',directory:'packages/bridge-core',layer:'COMPILED_READER',expectedTests:1,tests:['test/mbrs003/c.test.ts']},
    {name:'priority',directory:'packages/bridge-core',layer:'PRIORITY_INTEGRATION',expectedTests:1,tests:['test/mbrs003/d.test.ts']},
    {name:'desktop',directory:'apps/desktop',layer:'UNIT',expectedTests:1,tests:['test/mbrs003/e.test.ts']},
  ] };
}
const inventory = s => s.groups.flatMap(g=>g.tests.map(t=>`${g.directory}/${t}`)).sort();
test('003 Gate未完成/expected0不准入，不能用当前局部用例总和启用', () => {
  const s=scope();s.implementationComplete=false;assert.throws(()=>assertFinalScope(s,inventory(s)),e=>e.code==='IMPLEMENTATION_OR_SCOPE_INCOMPLETE');
  s.implementationComplete=true;s.groups[0].expectedTests=0;assert.throws(()=>assertFinalScope(s,inventory(s)),e=>e.code==='FROZEN_TEST_GROUP_INVALID');
});
test('003 Gate nested inventory必须闭集、唯一、所有层齐，不遗漏新leaf', () => {
  const s=scope();assert.equal(assertFinalScope(s,inventory(s)).length,5);
  assert.throws(()=>assertFinalScope(s,[...inventory(s),'packages/bridge-core/test/mbrs003/omitted.test.ts']),e=>e.code==='NESTED_TEST_INVENTORY_MISMATCH');
  s.groups[1].tests=['test/mbrs003/d.test.ts'];assert.throws(()=>assertFinalScope(s,inventory(s)),e=>e.code==='NESTED_TEST_INVENTORY_MISMATCH');
});
test('003 Gate filesystem实际发现深层测试，不依赖test/*.test.ts或Git ignore', () => {
  const root=temporary(),relative='packages/bridge-core/test/mbrs003/deeper/hidden.test.ts';mkdirSync(path.dirname(path.join(root,relative)),{recursive:true,mode:0o700});
  writeFileSync(path.join(root,relative),'合成测试原件\n',{flag:'wx',mode:0o600});
  const desktop='apps/desktop/test/mbrs003/deeper/front.test.ts';mkdirSync(path.dirname(path.join(root,desktop)),{recursive:true,mode:0o700});
  writeFileSync(path.join(root,desktop),'合成Desktop nested原件\n',{flag:'wx',mode:0o600});
  assert.deepEqual(discoverNestedTests(root),[desktop,relative].sort());
});
test('003 Gate TAP6字段唯一、非零固定数，重复summary拒绝', () => {
  const raw='# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
  assert.equal(parseTestCounts(raw).tests,2);assert.equal(parseTestCounts(raw+'# tests 2\n'),null);assert.equal(parseTestCounts(raw.replace('# pass 2','# pass x')),null);
});
test('003 Gate Reader4/8动态源输出绑定拒绝旧source摘要', () => {
  const paths=['src/recording/source-files.ts','src/library/metadata-reader.ts','src/library/metadata-reader-worker.ts','src/library/metadata-reader-types.ts'];
  const sources=paths.map((p,i)=>({path:'packages/bridge-core/'+p,bytes:i+1,sha256:String(i).repeat(64)}));
  const core={compilerExit:0,compilerStartedAtMs:1,compilerFinishedAtMs:2,outputs:sources.flatMap(s=>['.js','.js.map'].map(suffix=>({path:s.path.replace('/src/','/dist/').slice(0,-3)+suffix,bytes:5,sha256:'f'.repeat(64),sourceSha256:s.sha256})))};
  const result=makeReaderBinding(sources,core);assert.equal(result.sourceInputs.length,4);assert.equal(result.outputs.length,8);assert.equal(result.sourceInputs[0].sha256,sources[0].sha256);
  core.outputs[0].sourceSha256='e'.repeat(64);assert.throws(()=>makeReaderBinding(sources,core),e=>e.code==='READER_FRESH_OUTPUT_SOURCE_MISMATCH');
});
test('003 Gate真实Node child close0和私有allowlist日志，不能只读exit事件', async () => {
  const run=temporary(),runs=[],result=await capture(run,{name:'small-child',directory:'packages/bridge-core',args:['-e','process.stdout.write("private-hidden-diagnostic\\n")']},process.env,createBudget(),runs);
  assert.equal(result.exitCode,0);assert.equal(result.closeObserved,true);assert.equal(result.signal,null);assert.equal(stageExecutionCaptured(result),true);assert.equal(stagePassed(result),true);
  assert.equal(readFileSync(path.join(run,result.log),'utf8').includes('private-hidden-diagnostic'),false);assert.equal(result.capturedRawSha256.length,64);
});
test('003 Gate日志已存在触发wx失败仍保留实际child0/close/raw摘要，并明确FAIL', async () => {
  const run=temporary();writeFileSync(path.join(run,'log-eio.log'),'不可覆盖原件\n',{flag:'wx',mode:0o600});
  const result=await capture(run,{name:'log-eio',directory:'packages/bridge-core',args:['-e','process.stdout.write("safe-fixture\\n")']},process.env,createBudget(),[]);
  assert.equal(result.exitCode,0);assert.equal(result.closeObserved,true);assert.equal(result.logWriteFailed,true);assert.equal(result.logFailureCode,'PRIVATE_LOG_WRITE_FAILED');
  assert.equal(stageExecutionCaptured(result),true);assert.equal(stagePassed(result),false);assert.equal(typeof result.redactedLogRecovery,'string');assert.equal(result.capturedRawSha256.length,64);
  assert.equal(readFileSync(path.join(run,'log-eio.log'),'utf8'),'不可覆盖原件\n');
});
test('003 Gate软件预算终止仅自己的POSIX group，并等真实child close', async () => {
  const run=temporary(),budget={check(){},remainingMs(){return 5;}};
  const result=await capture(run,{name:'own-timeout',directory:'packages/bridge-core',args:['-e','setInterval(()=>{},1000)']},process.env,budget,[]);
  assert.equal(result.timedOut,true);assert.equal(result.gateBudgetTimedOut,true);assert.equal(result.closeObserved,true);assert.equal(result.signal,'SIGKILL');
  assert.equal(result.groupTerminationFailed,false);assert.equal(Number.isInteger(result.ownedProcessGroupId) && result.ownedProcessGroupId>0,true);assert.equal(stagePassed(result),false);
});

test('003 Gate CUE2/4绑定动态当前源码与fresh JS/map，不复用metadata4/8代替', () => {
  const paths=['src/library/cue-sidecar-reader.ts','src/library/cue-sidecar-worker.ts'];
  const sources=paths.map((p,i)=>({path:'packages/bridge-core/'+p,bytes:i+1,sha256:String(i).repeat(64)}));
  const core={compilerExit:0,compilerStartedAtMs:1,compilerFinishedAtMs:2,outputs:sources.flatMap(s=>['.js','.js.map'].map(suffix=>({path:s.path.replace('/src/','/dist/').slice(0,-3)+suffix,bytes:5,sha256:'f'.repeat(64),sourceSha256:s.sha256})))};
  const result=makeCueBinding(sources,core);assert.equal(result.schema,'mbrs003.cue.fresh-build.v1');assert.equal(result.sourceInputs.length,2);assert.equal(result.outputs.length,4);
  core.outputs[0].sourceSha256='a'.repeat(64);assert.throws(()=>makeCueBinding(sources,core),e=>e.code==='READER_FRESH_OUTPUT_SOURCE_MISMATCH');
});
// 以下是后验validator单位输入，不是运行规模扫描或制造负载PASS收据。
function observation(count=100000) {
  const names=['first-pause-after-real-committed-batches','cold-reopen-explicit-resume-then-terminal-cancel','new-job-after-cancel-completes-first-corpus','unchanged-incremental-no-reparse','one-stat-signature-change-one-real-reparse'];
  return {schema:'mbrs003.digital-audio-scale-observation.v3',status:'SOFTWARE_SCALE_OBSERVED',rehearsal:false,count,timedOut:false,safeError:null,lifecycleFailure:null,maxMilliseconds:1000,scanElapsedMs:500,independentPostHashElapsedMs:100,
    metrics:{readerCalls:count,ok:count,failures:0,workerStarts:count,workerExits:count,fdReleased:count,wholeAudioHashFalse:count,wholeAudioDecodeFalse:count,peakReaderFD:1,peakWorker:1,maxBatch:200,preparedFrontierMaximum:100,catalogPageMaximum:200,
      stages:names.map((name,i)=>({name,phase:['paused','cancelled','completed','completed','completed'][i],progress:{visited:String(i===0?400:i===1?800:count),accepted:String(i===0?400:i===1?800:count),rejected:'0'},delta:{readerCalls:i===3?0:i===4?1:400}})),
      catalogIdentityChecks:Object.fromEntries(['first','unchanged','oneChanged'].map(k=>[k,{items:count,digest:'f'.repeat(64)}])),
      cancelledColdPersistence:{jobExact:true,receiptExact:true,checkpointExact:true,noAutomaticRead:true},newJobAfterCancel:{different:true,jobId:'next',previousJobId:'previous'},
      quietCloses:Array.from({length:3},()=>({coordinatorJoined:true,contextClosed:true}))}};
}
test('003 Gate规模后验拒20 smoke、运行中与预算停止，不从声明升级负载PASS', () => {
  assert.equal(validateScaleObservation(observation(),100000).count,100000);
  assert.throws(()=>validateScaleObservation(observation(20),20),e=>e.code==='SCAN_LOAD_RESULT_INVALID');
  const s=observation();s.status='RUNNING';assert.throws(()=>validateScaleObservation(s,100000),e=>e.code==='SCAN_LOAD_RESULT_INVALID');
  s.status='INCOMPLETE_BUDGET_STOPPED';s.timedOut=true;assert.throws(()=>validateScaleObservation(s,100000),e=>e.code==='SCAN_LOAD_RESULT_INVALID');
});
test('003 Gate规模结果必须FD-worker quiet、未变零解析、分页200及稳定catalog身份同时有效', () => {
  for (const mutate of [s=>s.metrics.workerExits--,s=>s.metrics.stages[3].delta.readerCalls=1,s=>s.metrics.catalogPageMaximum=201,s=>s.metrics.catalogIdentityChecks.unchanged.digest='a'.repeat(64),s=>s.metrics.quietCloses[0].contextClosed=false]) {
    const s=observation();mutate(s);assert.throws(()=>validateScaleObservation(s,100000),e=>e.code==='SCAN_LOAD_RESULT_INVALID');
  }
});
test('003 Gate缺终结适配或RUNNING/NOT_STARTED profile在任何文件读取前明确INCOMPLETE', () => {
  const storage={check(){assert.fail('未终结不能读收据或执行产品');}},budget={check(){}};
  assert.throws(()=>readSnapshot04LoadEvidence(null,{storage},budget),e=>e.code==='SCAN_LOAD_TERMINAL_ADAPTER_MISSING');
  assert.throws(()=>readSnapshot04LoadEvidence({schema:'mbrs003.scan-load-receipts.v1',status:'ROOT_TERMINAL_RECEIPTS_FROZEN',profiles:[{count:100000,state:'RUNNING'},{count:300000,state:'NOT_STARTED'}]},{storage},budget),e=>e.code==='SCAN_LOAD_PROFILE_NOT_TERMINAL');
});

test('003 Gate启动链6输入/10JS-map只绑定fixture源码，拒旧输出或遗漏真实fixture', () => {
  const paths=['src/utility-main.ts','src/rust-core/optional-readonly-manager.ts','src/collection/dataset-owner-client.ts','src/collection/dataset-domain.ts','src/collection/dataset-owner-worker.ts'];
  const sources=paths.map((p,i)=>({path:'packages/bridge-core/'+p,bytes:i+1,sha256:String(i).repeat(64)}));
  const fixture={path:'packages/bridge-core/test/helpers/dataset-owner-fixture.ts',bytes:9,sha256:'9'.repeat(64)};
  const core={compilerExit:0,compilerStartedAtMs:1,compilerFinishedAtMs:2,outputs:sources.flatMap(s=>['.js','.js.map'].map(suffix=>({path:s.path.replace('/src/','/dist/').slice(0,-3)+suffix,bytes:5,sha256:'f'.repeat(64),sourceSha256:s.sha256})))};
  const result=makeStartupBinding([...sources,fixture],core);
  assert.equal(result.schema,'mbrs003.utility-startup.fresh-build.v1');assert.equal(result.sourceInputs.length,6);assert.equal(result.outputs.length,10);
  assert.deepEqual(result.sourceInputs.at(-1),{file:'test/helpers/dataset-owner-fixture.ts',bytes:fixture.bytes,sha256:fixture.sha256});
  assert.equal(result.outputs.some(x=>x.file.includes('fixture')),false);
  assert.throws(()=>makeStartupBinding(sources,core),e=>e.code==='READER_SOURCE_MISSING');
  core.outputs[0].sourceSha256='e'.repeat(64);assert.throws(()=>makeStartupBinding([...sources,fixture],core),e=>e.code==='READER_FRESH_OUTPUT_SOURCE_MISMATCH');
});
