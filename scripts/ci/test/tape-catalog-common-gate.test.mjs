import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildStoragePolicy } from '../../../apps/desktop/scripts/build-storage-root.mjs';
import { TAPE_CATALOG_COMMON_TASK as task, TAPE_CATALOG_COMMON_BRANCH as branch,
  TAPE_CATALOG_COMMON_BASE as base } from '../tape-catalog-common-admission.mjs';
import { LOCAL_LIBRARY_SIGNED_STAT_FIX_SCOPE as scope } from '../local-library-signed-stat-fix-admission.mjs';
import { signedStatGateAdmissionRoute, inspectSignedStatGateAdmission } from '../verify-local-library-signed-stat-fix.mjs';
import { tapeCatalogCommonCoexistence, assertTapeCatalogCommonFreshResult } from '../verify-tape-catalog-common.mjs';
import { mobileInputIdentity } from '../verify-mbm000-contract-adoption.mjs';

const rejected=code=>error=>error?.code===code;
const projection=rows=>rows.map(({path,bytes,sha256})=>({path,bytes,sha256}));

/** 自有外置小仓库只测拒绝与分流，不执行编译、产品Gate或App。 */
function probeRepository(t,observedBranch,commonStatus){
  const storage=buildStoragePolicy(),temporary=storage.check(process.env.TMPDIR,{mustExist:true});
  if(!storage.hosted&&!temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/')){
    assert.equal(temporary,'/Volumes/LifeWeave/Developer/CommandLine/tmp','本机测试临时目录必须在外置tmp根。');
  }
  const directory=mkdtempSync(path.join(temporary,'tape-common-gate-'));storage.check(directory,{mustExist:true});
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));
  execFileSync('git',['-c','init.templateDir=','init','--initial-branch='+observedBranch],{
    cwd:directory,env,timeout:10000,maxBuffer:4096,stdio:['ignore','pipe','pipe']});
  execFileSync('git',['-c','user.name=MusicBridge Gate Fixture','-c','user.email=gate-fixture@example.invalid',
    '-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','commit','--allow-empty','-m','合成分流探针'],{
    cwd:directory,env,timeout:10000,maxBuffer:4096,stdio:['ignore','pipe','pipe']});
  mkdirSync(path.join(directory,'project'),{mode:0o700});
  // 原inspector读此精确坏JSON必给SIGNED_STAT_JSON_INVALID，辨认是否意外回落旧准入。
  writeFileSync(path.join(directory,'project/STATUS.json'),'{\n',{flag:'wx',mode:0o600});
  writeFileSync(path.join(directory,'project/POSTRUST_PLAN.json'),'{}\n',{flag:'wx',mode:0o600});
  if(commonStatus!==undefined){mkdirSync(path.join(directory,'docs/tape-catalog-common'),{recursive:true,mode:0o700});
    writeFileSync(path.join(directory,'docs/tape-catalog-common/STATUS.json'),JSON.stringify(commonStatus)+'\n',{flag:'wx',mode:0o600});}
  t.diagnostic('自有分流探针保留：'+directory);
  return directory;
}

/** 仅供纯收据守门负例的合成结构；没有编译或执行，不能作为软件通过证据。 */
function receiptFixture(){
  const sourcePins=scope.productPins.map(row=>({path:row.path,...row.after,gitBlob:'a'.repeat(40)}));
  const admitted={task,localLibraryFixTask:scope.task,signedStatFreshSoftwareGateRequired:true,
    baseSha:base,headAtAdmission:'b'.repeat(40),sourcePins,
    closure:{phase:'SOURCE',sourceSha:'b'.repeat(40),reportSha:null,commits:['b'.repeat(40)],baseSha:base}};
  const counts=n=>({tests:n,pass:n,fail:0,cancelled:0,skipped:0,todo:0});
  const clean={exitCode:0,signal:null,closeObserved:true,exitObserved:true,rawCaptureComplete:true,
    timedOut:false,overflow:false,captureFailed:false,preparationFailed:false,groupTerminationFailed:false};
  const leaves=scope.tests.map(row=>({...row,caseNames:Array.from({length:row.expectedTests},(_,i)=>row.file+' case '+i)}));
  const behavior=leaves.map(row=>{
    const directory=row.file.startsWith('apps/desktop/')?'apps/desktop':'packages/bridge-core';
    const name=(directory==='apps/desktop'?'desktop-':'core-')+path.basename(row.file,'.test.ts');
    return {...clean,name,directory,expectedTests:row.expectedTests,testCounts:counts(row.expectedTests),
      tapPlanComplete:true,tapStatusesClean:true,expectedCaseNames:[...row.caseNames],actualCaseNames:[...row.caseNames]};});
  const outputs=scope.productPins.flatMap(row=>['.js','.js.map','.d.ts'].map(suffix=>({
    path:row.path.replace('/src/','/dist/').slice(0,-3)+suffix,bytes:17,sha256:'c'.repeat(64),
    sourcePath:row.path,sourceSha256:row.after.sha256})));
  const allOutputs=[...outputs,...['.mjs','.mjs.map','.meta.json','.build.json'].map(suffix=>({
    path:'packages/bridge-core/dist/library/metadata-reader-worker.bundle'+suffix,bytes:19,sha256:'e'.repeat(64)}))];
  const summary={schema:'musicbridge.tape-catalog-common.signed-stat-software-gate.v1',task,
    localLibraryFixTask:scope.task,signedStatFreshSoftwareGateRequired:true,baseSha:base,headAtRun:admitted.headAtAdmission,
    admission:structuredClone(admitted),success:true,state:'COMMON_SIGNED_STAT_SOFTWARE_ONLY_PASS',
    sourceInputsUnchanged:true,compiledOutputsUnchanged:true,expectedStages:9,completedStages:9,expectedBehaviorTests:80,
    exactCurrentProductSourceFiles:12,exactCurrentCompatibilityFiles:6,failures:[],behaviorCounts:counts(80),
    runs:[{...clean,name:'fresh-core-preparation',directory:'.',expectedTests:null},...behavior],
    selectedTestLeaves:leaves,sourceInputs:projection(sourcePins),sourceInputIdentity:mobileInputIdentity(sourcePins),
    currentCoreAndWorker:{mode:'fresh',originalCompilerExecutionRepeated:true,reusedCoreAndWorkerKeepExactOriginalMtime:false,
      productSourcesReinterpretedOrNormalized:false,readerBindingInverted:false,
      stages:['fresh-contracts-compiler','fresh-core-compiler','fresh-fixed-metadata-worker'].map(name=>({name,compilerExit:0})),
      exactSignedStatProductSources:scope.productPins.map(row=>({path:row.path,...row.after})),productionOutputs:outputs,
      originalCompilerOutputs:structuredClone(allOutputs),currentOutputRows:projection(allOutputs),currentOutputCount:40,
      currentOutputIdentity:mobileInputIdentity(allOutputs)},
    oldGatesRerun:false,oldExecutionRelabeledCurrent:false,sourceIdentitySignPreserved:true,readerBindingInverted:false};
  return {admitted,summary};
}

test('组合Gate入口：只有精确新branch或独立新task标记触发完整组合准入',()=>{
  assert.equal(signedStatGateAdmissionRoute(branch,null),'VALIDATE_TAPE_CATALOG_COMMON');
  assert.equal(signedStatGateAdmissionRoute('codex/else',{task}),'VALIDATE_TAPE_CATALOG_COMMON');
  for(const value of ['codex/else',branch+'/suffix','',null]){
    assert.equal(signedStatGateAdmissionRoute(value,{task:scope.task}),'ORIGINAL_SIGNED_STAT_INSPECTOR');
  }
});

test('组合Gate真实分流：新branch遇缺Scope或错误task的仓库必须完整准入拒绝，不能回落',t=>{
  for(const status of [undefined,{task},{task:scope.task}]){
    const directory=probeRepository(t,branch,status);
    assert.throws(()=>inspectSignedStatGateAdmission(directory,process.env),error=>/^TAPE_COMMON_/u.test(error?.code??''));
  }
});

test('组合Gate真实分流：独立新task留在错误branch仍强制完整准入并拒绝',t=>{
  const directory=probeRepository(t,'codex/else',{task});
  assert.throws(()=>inspectSignedStatGateAdmission(directory,process.env),error=>/^TAPE_COMMON_/u.test(error?.code??''));
});

test('组合Gate真实分流：无组合标记沿旧inspector，伪env或任意io字段不能选择新路径',t=>{
  const directory=probeRepository(t,'codex/else',{task:'OTHER_TASK'});
  assert.throws(()=>inspectSignedStatGateAdmission(directory,{...process.env,GITHUB_HEAD_REF:branch,GITHUB_REF_NAME:branch,
    TAPE_CATALOG_COMMON_TASK:task,MUSIC_BRIDGE_TAPE_CATALOG_COMMON:'true'},
  {inspectTapeCatalogCommonAdmission:()=>({task})}),rejected('SIGNED_STAT_JSON_INVALID'));
});

test('组合Gate共存：52个CFA整件路径与12个FD产品不相交，任何FD整件漂移拒绝',()=>{
  const {admitted}=receiptFixture(),result=tapeCatalogCommonCoexistence(admitted);
  assert.deepEqual(result.intersectingProductPaths,[]);assert.equal(result.tapeCatalogSourceFiles,52);
  assert.equal(result.signedStatProductFiles,12);assert.equal(result.appLaunchesByThisGate,0);
  assert.equal(result.formalArchiveImportsByThisGate,0);assert.equal(result.ordinarySourceMediaWritesByThisGate,0);
  assert.equal(result.referenceInventoryTransactionAndAssetChecks,'SEPARATE_STANDARD_VERIFICATION_REQUIRED');
  for(const field of ['bytes','sha256']){const changed=structuredClone(admitted);
    changed.sourcePins[0][field]=field==='bytes'?changed.sourcePins[0].bytes+1:'0'.repeat(64);
    assert.throws(()=>tapeCatalogCommonCoexistence(changed),rejected('TAPE_COMMON_SIGNED_STAT_PRODUCT_DRIFT'));}
  assert.throws(()=>tapeCatalogCommonCoexistence({task:scope.task}),rejected('TAPE_COMMON_GATE_ADMISSION_REQUIRED'));
});

test('组合Gate纯收据守门：可评估合成结构，但旧task、旧HEAD或换标签旧closure一律拒绝',()=>{
  const {admitted,summary}=receiptFixture();assert.equal(assertTapeCatalogCommonFreshResult(summary,admitted).tests,80);
  for(const work of [s=>{s.task=scope.task;},s=>{s.schema='musicbridge.local-library-signed-stat-fix.software-gate.v1';},
    s=>{s.headAtRun='d'.repeat(40);},s=>{s.admission.closure.sourceSha='d'.repeat(40);},
    s=>{s.admission.sourcePins[0].sha256='d'.repeat(64);}]){const changed=structuredClone(summary);work(changed);
    assert.throws(()=>assertTapeCatalogCommonFreshResult(changed,admitted),rejected('TAPE_COMMON_CURRENT_EXECUTION_IDENTITY_REQUIRED'));}
  assert.throws(()=>assertTapeCatalogCommonFreshResult(summary,{...admitted,signedStatFreshSoftwareGateRequired:false}),
    rejected('TAPE_COMMON_GATE_ADMISSION_REQUIRED'));
});

test('组合Gate纯收据守门：80例必须完整TAP及exit/close/raw，跳过、缺段和截断不能算通过',()=>{
  const {admitted,summary}=receiptFixture();
  assert.notEqual(summary.runs[1].expectedCaseNames,summary.runs[1].actualCaseNames);
  assert.notEqual(summary.runs[1].expectedCaseNames,summary.selectedTestLeaves[0].caseNames);
  for(const work of [s=>{s.behaviorCounts.skipped=1;},s=>{s.runs.pop();},s=>{s.runs[1].exitObserved=false;},
    s=>{s.runs[1].closeObserved=false;},s=>{s.runs[1].rawCaptureComplete=false;},s=>{s.runs[1].exitCode=1;},
    s=>{s.runs[1].tapPlanComplete=false;},s=>{s.runs[1].actualCaseNames.pop();},s=>{s.compiledOutputsUnchanged=false;},
    s=>{s.runs[1].expectedCaseNames.pop();s.runs[1].actualCaseNames.pop();},
    s=>{s.runs[1].expectedCaseNames.pop();s.runs[1].actualCaseNames.pop();s.selectedTestLeaves[0].caseNames.pop();},
    s=>{s.runs[1].expectedTests--;s.runs[1].testCounts={tests:4,pass:4,fail:0,cancelled:0,skipped:0,todo:0};
      s.runs[1].expectedCaseNames.pop();s.runs[1].actualCaseNames.pop();},
    s=>{s.runs[1].name='core-other-file';},s=>{s.runs[1].directory='apps/desktop';},
    s=>{[s.runs[1],s.runs[2]]=[s.runs[2],s.runs[1]];}]){
    const changed=structuredClone(summary);work(changed);
    assert.throws(()=>assertTapeCatalogCommonFreshResult(changed,admitted),rejected('TAPE_COMMON_FRESH_TAP_INCOMPLETE'));
  }
});

test('组合Gate纯收据守门：缺Source输入、改用旧Worker或未实际编译的输出闭集拒绝',()=>{
  const {admitted,summary}=receiptFixture();
  for(const work of [s=>{s.sourceInputs.pop();},s=>{s.sourceInputIdentity='0'.repeat(64);},s=>{s.selectedTestLeaves[0].expectedTests++;}]){
    const changed=structuredClone(summary);work(changed);
    assert.throws(()=>assertTapeCatalogCommonFreshResult(changed,admitted),rejected('TAPE_COMMON_CURRENT_SOURCE_CLOSURE_INCOMPLETE'));
  }
  for(const work of [s=>{s.currentCoreAndWorker.mode='reused';},s=>{s.currentCoreAndWorker.originalCompilerExecutionRepeated=false;},
    s=>{s.currentCoreAndWorker.stages[2].compilerExit=1;},s=>{s.currentCoreAndWorker.productionOutputs.pop();},
    s=>{s.currentCoreAndWorker.currentOutputRows=[];s.currentCoreAndWorker.currentOutputCount=0;
      s.currentCoreAndWorker.currentOutputIdentity=mobileInputIdentity([]);},
    s=>{s.currentCoreAndWorker.currentOutputIdentity='0'.repeat(64);},s=>{s.oldExecutionRelabeledCurrent=true;},
    s=>{s.currentCoreAndWorker.productSourcesReinterpretedOrNormalized=true;},s=>{s.sourceIdentitySignPreserved=false;}]){
    const changed=structuredClone(summary);work(changed);
    assert.throws(()=>assertTapeCatalogCommonFreshResult(changed,admitted),rejected('TAPE_COMMON_FRESH_COMPILER_CLOSURE_REQUIRED'));
  }
});

test('组合Gate纯收据守门：36个FD产物及4个Worker产物任一缺失或第三版hash均拒绝',()=>{
  const {admitted,summary}=receiptFixture();
  for(let index=0;index<40;index++){
    const missing=structuredClone(summary);missing.currentCoreAndWorker.currentOutputRows.splice(index,1);
    missing.currentCoreAndWorker.currentOutputCount--;missing.currentCoreAndWorker.currentOutputIdentity=mobileInputIdentity(missing.currentCoreAndWorker.currentOutputRows);
    assert.throws(()=>assertTapeCatalogCommonFreshResult(missing,admitted),rejected('TAPE_COMMON_FRESH_COMPILER_CLOSURE_REQUIRED'));
    const third=structuredClone(summary);third.currentCoreAndWorker.currentOutputRows[index].sha256='f'.repeat(64);
    third.currentCoreAndWorker.currentOutputIdentity=mobileInputIdentity(third.currentCoreAndWorker.currentOutputRows);
    assert.throws(()=>assertTapeCatalogCommonFreshResult(third,admitted),rejected('TAPE_COMMON_FRESH_COMPILER_CLOSURE_REQUIRED'));
  }
  for(let index=0;index<36;index++){
    const changed=structuredClone(summary);changed.currentCoreAndWorker.productionOutputs[index].sha256='f'.repeat(64);
    assert.throws(()=>assertTapeCatalogCommonFreshResult(changed,admitted),rejected('TAPE_COMMON_FRESH_COMPILER_CLOSURE_REQUIRED'));
  }
});
