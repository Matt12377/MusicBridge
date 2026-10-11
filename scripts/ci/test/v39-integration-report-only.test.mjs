import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStoragePolicy } from '../../../apps/desktop/scripts/build-storage-root.mjs';
import {
  V39_INTEGRATION_TASK as task, V39_INTEGRATION_BRANCH as branch, V39_INTEGRATION_BASE as base,
  V39_INTEGRATION_SOURCE_PARENT as sourceParent,V39_INTEGRATION_SOURCE_DELTA_FILES as deltaFiles,
  V39_INTEGRATION_FAILED_SOURCE1 as failedSource1,V39_INTEGRATION_FAILED_SOURCE2 as failedSource2,
  V39_INTEGRATION_FAILED_SOURCE2_PINS as source2Pins,
  V39_INTEGRATION_SOURCE_CORRECTION_IDENTITY as correction,V39_INTEGRATION_SOURCE_CORRECTION_REF as correctionRef,
  V39_INTEGRATION_SCOPE_PATH as scopePath,V39_INTEGRATION_STATUS_PATH as statusPath,
  V39_INTEGRATION_CI_EVIDENCE_PATH as evidencePath, V39_INTEGRATION_DONOR_PATH as donorPath,
  V39_INTEGRATION_SOURCE_FILES as sourceFiles,V39_INTEGRATION_REPORT_PATHS as reportPaths,
  V39_INTEGRATION_ADMISSION_CASE_NAMES as admissionNames,V39_INTEGRATION_REPORT_CASE_NAMES as reportNames,
  V39_INTEGRATION_GUARD_STEP as guard,V39_INTEGRATION_GATE_STEP as gate,V39_INTEGRATION_UPLOAD_STEP as upload,
  inspectV39IntegrationAdmission,inspectV39IntegrationReportAdmission,inspectV39IntegrationWorkflowGuard,
  v39IntegrationWorkflowOutputs,validateV39IntegrationParentCi,validateV39IntegrationSourceReceipt,
  v39IntegrationPublicSourceCi,v39IntegrationReportIdentity,v39IntegrationReportState,v39IntegrationCanonicalPin,
  encodeV39IntegrationToolContent,decodeV39IntegrationToolContent,v39IntegrationSourceSummary,
  validateV39IntegrationReportToolContent,
} from '../v39-integration-admission.mjs';
import { inspectV39IntegrationReportOnly } from '../report-only-v39-integration.mjs';
import { V39_INTEGRATION_TAPE_TESTS,V39_INTEGRATION_SAFETY_CASE_NAMES as integrationNames,
  V39_INTEGRATION_STAGE_NAMES as stageNames, V39_INTEGRATION_EXPORT_ROOT_FILES,
  buildV39IntegrationGateSummary,inspectV39IntegrationSafetyRaw,V39_INTEGRATION_REPORT_SKIP } from '../verify-v39-integration.mjs';
const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const sourcePaths=sourceFiles.map(row=>row.path);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const blob=bytes=>createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
const record=filename=>JSON.parse(readFileSync(filename));
const copy=value=>structuredClone(value);
const rejected=error=>/^V39_/u.test(error?.code??'');
const environment=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')&&!key.startsWith('GITHUB_')));
const gitEnv={...environment,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_OPTIONAL_LOCKS:'0',
  GIT_TERMINAL_PROMPT:'0',GIT_NO_LAZY_FETCH:'1'};
let root,directory,syntheticSource,sourceTree,cachedReceipt;
function command(dir,args,{input,binary=false,allowFailure=false}={}){
  const result=spawnSync('git',['--no-replace-objects','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null',
    '-c','commit.gpgsign=false',...args],{cwd:dir,env:gitEnv,input,encoding:binary?undefined:'utf8',
      timeout:10000,killSignal:'SIGKILL',maxBuffer:16*1024*1024,stdio:['pipe','pipe','pipe']});
  assert.equal(result.error,undefined);assert.equal(result.signal,null);
  if(!allowFailure)assert.equal(result.status,0,String(result.stderr));
  return allowFailure?result:binary?result.stdout:result.stdout.trim();
}
function commitTree(dir,tree,parents,message){
  return command(dir,['-c','user.name=MusicBridge CI Fixture','-c','user.email=ci-fixture@example.invalid',
    'commit-tree',tree,...parents.flatMap(parent=>['-p',parent])],{input:message+'\n'});
}
function checkout(head,observedBranch=branch){command(directory,['checkout','-f','-B',observedBranch,head,'--']);}
function commitWorking(paths,parents=[sourceParent]){
  command(directory,['add','--',...paths]);const tree=command(directory,['write-tree']);
  const head=commitTree(directory,tree,parents,'受控Fake准入变异；不代表当前产品或真实CI');
  checkout(head);return head;
}
/** 原旧JSON的数字literal按pointer保留，避免36处unsafe integer被fixture重序列化舍入。 */
function numericTokens(text){
  const tokens=new Map();let at=0;const number=/-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/yu;
  const space=()=>{while([' ','\t','\r','\n'].includes(text[at]))at++;};
  const string=()=>{const start=at;assert.equal(text[at++],'"');while(at<text.length){const c=text[at++];
    if(c==='\\')at++;else if(c==='"')return text.slice(start,at);}assert.fail('fixture JSON不完整');};
  const escape=key=>key.replace(/~/gu,'~0').replace(/\//gu,'~1');
  function value(pointer,depth){
    assert.ok(depth<=128);space();const first=text[at];
    if(first==='{'){at++;space();if(text[at]==='}'){at++;return;}for(;;){
      space();const key=JSON.parse(string());space();assert.equal(text[at++],':');
      value(pointer+'/'+escape(key),depth+1);space();const sep=text[at++];if(sep==='}')return;assert.equal(sep,',');}}
    if(first==='['){at++;space();if(text[at]===']'){at++;return;}let index=0;for(;;){
      value(pointer+'/'+index++,depth+1);space();const sep=text[at++];if(sep===']')return;assert.equal(sep,',');}}
    if(first==='"'){string();return;}
    for(const literal of ['true','false','null'])if(text.startsWith(literal,at)){at+=literal.length;return;}
    const start=at;number.lastIndex=at;assert.ok(number.exec(text));at=number.lastIndex;
    tokens.set(pointer,{start,end:at,raw:text.slice(start,at)});
  }
  value('',0);space();assert.equal(at,text.length);return tokens;
}
const atPointer=(value,pointer)=>pointer.split('/').slice(1).reduce((v,k)=>v?.[k.replace(/~1/gu,'/').replace(/~0/gu,'~')],value);
function jsonEdit(relative,edit){
  const filename=path.join(directory,relative),before=readFileSync(filename,'utf8'),value=JSON.parse(before);
  edit(value);const text=JSON.stringify(value,null,2)+'\n',old=numericTokens(before),changes=[];
  for(const [pointer,next]of numericTokens(text)){const prior=old.get(pointer);
    if(prior&&prior.raw!==next.raw&&typeof atPointer(value,pointer)==='number'
      &&Object.is(atPointer(value,pointer),Number(prior.raw)))changes.push({...next,replacement:prior.raw});}
  let result='',cursor=0;for(const change of changes.sort((a,b)=>a.start-b.start)){
    result+=text.slice(cursor,change.start)+change.replacement;cursor=change.end;}
  writeFileSync(filename,result+text.slice(cursor));return value;
}
function pin(relative){const bytes=readFileSync(path.join(directory,relative));return {path:relative,mode:'100644',blob:blob(bytes),bytes:bytes.length,sha256:sha(bytes)};}
function freezeScope(edit=()=>{}){
  const scope=record(path.join(directory,scopePath));
  scope.frozen=true;scope.executionStatus='READY_FOR_SOURCE';scope.currentPhase='SOURCE_FREEZE';
  scope.allowedSourceFiles=copy(sourceFiles);scope.sourceParentSha=sourceParent;
  scope.sourceDeltaFiles=copy(deltaFiles);scope.sourceCorrection=copy(correctionRef);
  scope.orderedPhases=scope.orderedPhases.map(row=>({...row,implementation:'COMPLETE'}));
  scope.finalFiles=sourcePaths.map(relative=>relative===scopePath?{path:relative,mode:'100644',blob:null,bytes:1,sha256:null}:pin(relative));
  edit(scope);const self=scope.finalFiles.find(row=>row.path===scopePath);
  for(let tries=0;tries<8;tries++){const bytes=Buffer.from(JSON.stringify(scope,null,2)+'\n');if(self.bytes===bytes.length)break;self.bytes=bytes.length;}
  const bytes=Buffer.from(JSON.stringify(scope,null,2)+'\n');assert.equal(self.bytes,bytes.length);
  writeFileSync(path.join(directory,scopePath),bytes);
}
function fixture(t){
  if(!root){
    const storage=buildStoragePolicy(),temporary=storage.check(process.env.TMPDIR,{mustExist:true});
    if(!storage.hosted){assert.ok(temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
      assert.notEqual(statSync('/Volumes/LifeWeave').dev,statSync('/').dev);}
    root=mkdtempSync(path.join(temporary,'v39-ci-fixture-'));storage.check(root,{mustExist:true});
    directory=path.join(root,'source');
    command(root,['-c','protocol.file.allow=always','clone','--no-local','--no-hardlinks','--no-checkout','--',repository,directory]);
    checkout(sourceParent);
    const current=command(repository,['rev-list','--parents','-n','1','HEAD']).split(' ');
    assert.equal(current.length,2);
    assert.notEqual(current[0],sourceParent,'未提交Source3不能从dirty WIP构造准入正例');
    assert.equal(command(repository,['status','--porcelain=v1','--untracked-files=all']),'');
    const immutableSource=current[1]===sourceParent?current[0]:current[1];
    assert.deepEqual(command(repository,['rev-list','--parents','-n','1',immutableSource]).split(' '),[immutableSource,sourceParent]);
    for(const relative of sourcePaths){
      const filename=path.join(directory,relative);mkdirSync(path.dirname(filename),{recursive:true,mode:0o700});
      const raw=command(repository,['show',immutableSource+':'+relative],{binary:true});
      writeFileSync(filename,raw,{mode:0o644});chmodSync(filename,0o644);
    }
    // 只消费实际已提交Source3；32个历史叶原样继承，不能以fixture空白补造21条修复。
    jsonEdit('docs/integration/V39-INTEGRATION-001/LOCAL_SOFTWARE_EVIDENCE.json',value=>{value.sourceCorrection=copy(correction);});
    for(const row of deltaFiles)if(row.path!==scopePath)
      assert.notEqual(blob(readFileSync(path.join(directory,row.path))),row.before.blob,'本轮直接修复叶必须来自实际Source3：'+row.path);
    freezeScope();
    syntheticSource=commitWorking(sourcePaths);sourceTree=command(directory,['rev-parse','HEAD^{tree}']);
    assert.equal(command(directory,['rev-parse','--path-format=absolute','--git-common-dir']),path.join(directory,'.git'));
    assert.equal(existsSync(path.join(directory,'.git/objects/info/alternates')),false);
  }
  checkout(syntheticSource);
  assert.equal(command(directory,['status','--porcelain=v1','--untracked-files=all']),'');
  t.diagnostic('受控Fake actual Git='+directory+' Source='+syntheticSource+'；只证明准入规则，不是平台CI。');
  return {directory,source:syntheticSource,root};
}
function repin(relative){freezeScope();return commitWorking([relative,scopePath]);}
function hosted(head){return {...environment,GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_EVENT_NAME:'push',
  GITHUB_API_URL:'https://api.github.com',GITHUB_REPOSITORY:'Matt12377/MusicBridge',GITHUB_REF_NAME:branch,GITHUB_SHA:head};}
const protectedMtimePointer='/postRustPersistentIncrementalScan20261004/latestVerifiedProgress/evidenceRefs/actualReadonlyInputConfig/mtimeNs';
function mutateMtime(){
  const filename=path.join(directory,'project/STATUS.json'),text=readFileSync(filename,'utf8'),token=numericTokens(text).get(protectedMtimePointer);
  assert.ok(token);const next=(BigInt(token.raw)+1n).toString();assert.equal(Number(token.raw),Number(next));
  writeFileSync(filename,text.slice(0,token.start)+next+text.slice(token.end));return token.raw;
}
const fixtureCrcTable=Uint32Array.from({length:256},(_unused,index)=>{let value=index;
  for(let bit=0;bit<8;bit++)value=value>>>1^(value&1?0xedb88320:0);return value>>>0;});
function crc32(raw){let value=0xffffffff;for(const byte of raw)value=fixtureCrcTable[(value^byte)&255]^(value>>>8);
  return(value^0xffffffff)>>>0;}
function rawPin(name,bytes){return {path:name,bytes:bytes.length,sha256:sha(bytes)};}
function encode(value){return Buffer.from(JSON.stringify(value,null,2)+'\n');}

function syntheticParentCi(source){
  const workflows=['verify','security','rust-core','electron-e2e'];
  const jobNames=[['verify','dependency-audit'],['static-security'],['rust-core (ubuntu-latest)','rust-core (macos-latest)'],['macos-electron-gate']];
  const skipped=new Set(['CI报告元数据精确身份与原软件复用准入','CI修复精确身份与原软件复用准入','复用165已封存产品软件证据',
    '验证报告CI准入正负例','CI报告镜像历史对象修复工具 Gate','CI报告元数据修复工具 Gate',
    '保留本次CI修复工具证据','保留本次CI报告元数据工具证据','Preserve full verification log','复用本次精确父Source产品软件证据']);
  const steps=(file,id)=>{
    const lines=readFileSync(path.join(repository,'.github/workflows/'+file+'.yml'),'utf8').split('\n'),start=lines.indexOf('  '+id+':');
    assert.ok(start>=0);let end=start+1;while(end<lines.length&&!/^  [a-z][a-z0-9-]*:/u.test(lines[end]))end++;
    return lines.slice(start,end).map(line=>/^      - name: (.+)$/u.exec(line)?.[1]).filter(Boolean)
      .map(name=>({name,status:'completed',conclusion:skipped.has(name)?'skipped':'success'}));
  };
  const runs=workflows.map((file,i)=>({id:982100+i,path:'.github/workflows/'+file+'.yml',
    repository:{id:1340424953,full_name:'Matt12377/MusicBridge'},head_repository:{id:1340424953,full_name:'Matt12377/MusicBridge'},
    head_sha:source,head_branch:branch,event:'push',run_attempt:1,status:'completed',conclusion:'success'}));
  const names=[['verify-'+source],[],['rust-core-ubuntu-latest-'+source,'rust-core-macos-latest-'+source],['rust-host-compiled-'+source,'electron-e2e-'+source]];
  const proofs=runs.map((run,i)=>({runId:run.id,jobs:jobNames[i].map((name,ordinal)=>({
    id:run.id*10+ordinal,name,run_id:run.id,head_sha:source,status:'completed',conclusion:'success',
    steps:steps(workflows[i],i===2?'rust-core':name),
  })),artifacts:names[i].map((name,j)=>({id:772100+i*10+j,name,expired:false,size_in_bytes:1,digest:'sha256:'+'d'.repeat(64),
    expires_at:'2099-01-01T00:00:00Z',workflow_run:{id:run.id,head_sha:source,repository_id:1340424953,head_repository_id:1340424953}}))}));
  return {task,repositoryId:1340424953,parent:source,branch,runs,proofs,now:Date.parse('2026-10-11T00:00:00Z')};
}
function counts(tests){return {tests,suites:0,pass:tests,fail:0,cancelled:0,skipped:0,todo:0};}
function tap(names){return Buffer.from('TAP version 13\n'+names.map((name,i)=>'ok '+(i+1)+' - '+name+'\n').join('')
  +'1..'+names.length+'\n'+Object.entries(counts(names.length)).map(([key,n])=>'# '+key+' '+n+'\n').join(''));}
function fakeStage(name,names,raw){
  return {name,passed:true,exitCode:0,signal:null,timedOut:false,overflow:false,cleanupFailed:false,exitObserved:true,
    closeObserved:true,spawnFailed:false,interrupted:false,lingeringOwnedGroup:false,physicalShutdown:{pidAbsent:true,processGroupAbsent:true},
    observedDescendantsAbsent:true,observedDescendants:[],descendantScanFailed:false,rawForcedClosed:false,boundedSettleObserved:false,
    unexpectedPipeHolder:false,terminationRequested:false,rawCaptureComplete:true,
    rawCaptureScope:'FULL_SEPARATE_STDOUT_STDERR_BYTES_UNTIL_CLOSE_WITH_FIXED_BOUNDS',durationMs:1,budgetMs:90000,
    expectedTests:names?names.length:null,expectedCaseNames:name==='original-173'?null:names,actualCaseNames:names??[],
    testCounts:names?counts(names.length):null,tapComplete:true,caseNamesMatched:true,
    raw:{stdout:rawPin(name+'.stdout.log',raw),stderr:rawPin(name+'.stderr.log',Buffer.alloc(0))}};
}
/** 五个ZIP的字节/CRC/成员清单确实由本函数写成受控合成ZIP；没有编译Rust或运行产品。 */
function zipOf(entries){
  const locals=[],central=[];let offset=0;
  for(const [name,raw]of entries){const filename=Buffer.from(name),crc=crc32(raw),local=Buffer.alloc(30),cd=Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt32LE(crc,14);
    local.writeUInt32LE(raw.length,18);local.writeUInt32LE(raw.length,22);local.writeUInt16LE(filename.length,26);
    cd.writeUInt32LE(0x02014b50);cd.writeUInt16LE(20,4);cd.writeUInt16LE(20,6);cd.writeUInt32LE(crc,16);
    cd.writeUInt32LE(raw.length,20);cd.writeUInt32LE(raw.length,24);cd.writeUInt16LE(filename.length,28);cd.writeUInt32LE(offset,42);
    locals.push(local,filename,raw);central.push(cd,filename);offset+=local.length+filename.length+raw.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.size,8);
  end.writeUInt16LE(entries.size,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,directory,end]);
}
function buildReceipt(){
  if(cachedReceipt)return copy(cachedReceipt);
  const admission=inspectV39IntegrationAdmission(directory,environment),pins=sourcePaths.map(pin);
  const productInputs=pins.filter(row=>row.path.startsWith('packages/')||row.path.startsWith('apps/'));
  const identity={head:syntheticSource,parent:sourceParent,branch,tree:sourceTree,status:'',gitDir:path.join(directory,'.git'),commonDir:path.join(directory,'.git')};
  const bare={identity,admission,currentFiles:pins,productInputs};
  const output=Buffer.from('受控Fake compiler输出，不是当前compiler资格\n');
  const outputs=[{...rawPin('packages/bridge-core/dist/library/metadata-reader-worker.bundle.cjs',output),mode:'100644',blob:blob(output)}];
  const binding={schema:'受控Fake reader binding',source:'synthetic-only'},bindingBytes=encode(binding);
  const readerReceipt={schema:'core-test.reader-preparation.v1',status:'FRESH_READER_PREPARED',inputsUnchanged:true,outputsUnchanged:true,
    readerBindingSha256:sha(bindingBytes),sourceInputs:productInputs.map(({path,bytes,sha256})=>({path,bytes,sha256})),
    toolInputs:[rawPin('scripts/ci/run-core-tests.mjs',Buffer.from('受控Fake'))],outputs:outputs.map(({path,bytes,sha256})=>({path,bytes,sha256})),
    stages:['fresh-contracts-compiler','fresh-core-compiler','fresh-fixed-metadata-worker'].map(name=>({name,compilerExit:0,startedMs:1,finishedMs:2}))};
  const reader={receipt:readerReceipt,binding,receiptPin:rawPin(path.join(root,'fake-reader.json'),encode(readerReceipt)),
    bindingPin:rawPin(path.join(root,'fake-binding.json'),bindingBytes),fixedWorkerReceipt:{schema:'受控Fake Worker'},
    fixedWorkerReceiptPin:rawPin(path.join(root,'fake-worker.json'),Buffer.from('受控Fake')),
    currentOutputs:outputs,sourceInputsIndependentlyMatchedToActualGit:productInputs.length,currentOutputBytesChecked:true,
    preparationIntervalsClaimedOnlyForTheirOriginalStages:true,currentWorkerIndependentlyVerified:true};
  const sourceBefore={...bare,freshReader:reader},stageRaw=new Map(),stages=stageNames.map(name=>{
    const names=name==='original-173'?Array.from({length:173},(_,i)=>'受控Fake原173 '+i)
      :name==='tape-74'?V39_INTEGRATION_TAPE_TESTS.flatMap(row=>row.expectedCaseNames)
        :name==='integration-safety'?[...integrationNames]:name==='admission-safety'?[...admissionNames,...reportNames]:null;
    const stdout=names?tap(names):Buffer.from(name==='control-plane'?'CONTROL_PLANE=PASS\n':'受控Fake '+name+'=PASS\n');
    stageRaw.set(name+'.stdout.log',stdout);stageRaw.set(name+'.stderr.log',Buffer.alloc(0));
    return fakeStage(name,names,stdout);
  });
  const standardRaw=Buffer.from('fresh-contracts-compiler\nfresh-core-compiler\nfresh-fixed-metadata-worker\nelectron-vite build\nbuilt in\n'
    +Array.from({length:4},(_,i)=>tap(['受控Fake标准TAP '+i]).toString()).join(''));
  const standardReceipt={schema:'musicbridge.v39.integration.standard-verification.v1',status:'PASSED_CURRENT_SOURCE_STANDARD_VERIFICATION',
    task,sourceSha:syntheticSource,scopeSha256:admission.scopeSha256,startedAtMs:1,finishedAtMs:2,before:bare,after:bare,
    verifyExit:0,teeExit:0,pipelineNaturallyEnded:true,physicalClosureClaim:'NATURAL_PNPM_AND_TEE_PIPELINE_EXIT_NOT_TOOL_GATE_PID_ATTESTATION',
    raw:rawPin(path.join(root,'fake-verify.log'),standardRaw),complete:true,tapRuns:Array.from({length:4},()=>counts(1)),
    totals:{tests:4,suites:0,pass:4,fail:0,cancelled:0,skipped:0,todo:0},skippedCases:[],
    typesTestsAndBuildsNaturallySucceeded:true,mergedStandardRaw:true,freshReader:reader};
  const standardBytes=encode(standardReceipt);
  const standardVerification={status:standardReceipt.status,receipt:standardReceipt,
    receiptPin:rawPin(path.join(root,'fake-standard-verification.json'),standardBytes),
    artifactRaw:rawPin('verify.log',standardRaw),artifactReceipt:rawPin('standard-verification.json',standardBytes)};
  const summary=buildV39IntegrationGateSummary({sourceBefore,sourceAfter:sourceBefore,freshReader:reader,standardVerification,stages,
    startedAtMs:1,finishedAtMs:11,durationMs:10,failureCode:null,artifactFiles:[...V39_INTEGRATION_EXPORT_ROOT_FILES],
    temporaryCleanup:{ownedFreshTemporaryRoot:true,allStageProcessesPhysicallyClosed:true,removed:true,sourceAndEvidenceNeverDeleted:true}});
  const rootRecords=new Map([['summary.json',encode(summary)],['source-before.json',encode(sourceBefore)],['source-after.json',encode(sourceBefore)],
    ['fresh-reader.json',encode(reader)],['verify.log',standardRaw],['standard-verification.json',standardBytes],
    ['integration-case-proof.json',encode({schema:'musicbridge.v39.integration.current-composition-cases.v1',role:'source',sourceSha:syntheticSource,
      raw:stages.find(row=>row.name==='integration-safety').raw.stdout,...inspectV39IntegrationSafetyRaw(stageRaw.get('integration-safety.stdout.log'),'source'),
      sourceControlledProductCases:3,inheritedSourceProductCases:0,actualDeviceProviderAudioOwnerAcceptance:'NOT_RUN'})],...stageRaw]);
  for(const stage of stages)rootRecords.set(stage.name+'.json',encode(stage));
  assert.equal(rootRecords.size,28);
  const proof=syntheticParentCi(syntheticSource),artifacts=[];
  for(const platform of proof.proofs.flatMap(row=>row.artifacts)){
    const verify=platform.name==='verify-'+syntheticSource;
    const entries=verify?rootRecords:new Map([['synthetic-product-role.json',encode({sourceSha:syntheticSource,role:platform.name,controlledFake:true})]]);
    const bytes=zipOf(entries);platform.size_in_bytes=bytes.length;platform.digest='sha256:'+sha(bytes);
    const zipPath=path.join(root,platform.name+'.zip');writeFileSync(zipPath,bytes);
    const artifact={id:platform.id,name:platform.name,zip:rawPin(zipPath,bytes),members:[...entries].map(([path,raw])=>({...rawPin(path,raw),crc32:crc32(raw)})),
      expandedBytes:[...entries.values()].reduce((total,raw)=>total+raw.length,0),allMembersBytesAndCrcRead:true,
      credentialsArchived:false,signedRedirectArchived:false,authorizationForwardedAcrossHosts:false};
    if(verify)artifact.toolContent=encodeV39IntegrationToolContent([...rootRecords].map(([path,bytes])=>({path,bytes})),'source');
    artifacts.push(artifact);
  }
  const logs=proof.proofs.flatMap(p=>p.jobs.map(job=>({runId:p.runId,jobId:job.id,jobName:job.name,
    raw:rawPin(path.join(root,job.id+'.log'),Buffer.from('受控Fake 当前producer日志\n')),
    redirectLocationArchived:false,credentialsArchived:false,authorizationForwardedAcrossHosts:false})));
  cachedReceipt={schema:'musicbridge.root.v39-integration.first-natural-ci.v1',status:'SEALED_FIRST_NATURAL_CURRENT_PRODUCT_CI',phase:'source',
    task,revision:syntheticSource,branch,repository:'Matt12377/MusicBridge',repositoryId:1340424953,code:null,before:{head:syntheticSource,parent:sourceParent,
      tree:sourceTree,status:'',branch},after:{head:syntheticSource,parent:sourceParent,tree:sourceTree,status:'',branch},compiledAndApp:'PASSED_CURRENT_SOURCE',
    runs:proof.runs,proofs:proof.proofs,logs,artifacts,reruns:0,dispatches:0,credentialsOrSignedRedirectArchived:false,
    realApplicationServiceDeviceAudio:'NOT_RUN',ownerAcceptance:'NOT_RUN',recordedAt:'2026-10-11T00:00:00Z'};
  assert.equal(validateV39IntegrationSourceReceipt(cachedReceipt,syntheticSource),true,'受控正例完整Source producer/whole-root收据必须按真实合同通过');
  return copy(cachedReceipt);
}
function report(t){
  fixture(t);const full=buildReceipt(),identity=v39IntegrationReportIdentity(syntheticSource,full),state=v39IntegrationReportState(syntheticSource,full);
  for(const relative of ['reports/V39-INTEGRATION-001_RESULT.json',evidencePath]){
    mkdirSync(path.dirname(path.join(directory,relative)),{recursive:true});writeFileSync(path.join(directory,relative),encode(identity));
  }
  writeFileSync(path.join(directory,'reports/V39-INTEGRATION-001_RESULT.md'),
    '受控Fake仅证明准入。\nSource '+syntheticSource+'\nBase '+base+'\n'+evidencePath+'\nreal/Owner NOT_RUN\n');
  jsonEdit(statusPath,value=>Object.assign(value,state));
  jsonEdit('project/STATUS.json',value=>Object.assign(value.v39Integration,{status:state.state,phase:state.phase,sourceCommit:state.sourceCommit,
    reportCommit:null,software:state.software,sourceCi:state.sourceCi,reportCi:'NOT_RUN'}));
  jsonEdit('project/POSTRUST_PLAN.json',value=>Object.assign(value.integration_tasks[0],{status:state.state,source_commit:syntheticSource,
    report_commit:null,validation_status:state.software,source_ci:state.sourceCi,report_ci:'NOT_RUN'}));
  for(const relative of ['project/POSTRUST_TODO.md','project/POSTRUST_PROGRESS.md'])appendFileSync(path.join(directory,relative),'\n受控Fake Report '+syntheticSource+'\n');
  const head=commitWorking(reportPaths,[syntheticSource]);
  return {directory,source:syntheticSource,head,full};
}
function apiFor(full,{mutate=()=>{},onCall=()=>{}}={}){
  return async endpoint=>{
    onCall(endpoint);
    if(endpoint==='')return {id:1340424953,full_name:'Matt12377/MusicBridge',private:false};
    if(endpoint.startsWith('/actions/runs?')){const result={total_count:4,workflow_runs:copy(full.runs)};mutate(result,endpoint);return result;}
    const m=/^\/actions\/runs\/(\d+)\/(attempts\/1\/jobs|artifacts)\?per_page=100$/u.exec(endpoint);assert.ok(m,endpoint);
    const proof=full.proofs.find(row=>row.runId===Number(m[1]));assert.ok(proof);
    const result=m[2]==='artifacts'?{total_count:proof.artifacts.length,artifacts:copy(proof.artifacts)}
      :{total_count:proof.jobs.length,jobs:copy(proof.jobs)};mutate(result,endpoint);return result;
  };
}
function rebuildTool(full,mutate){
  const artifact=full.artifacts.find(row=>row.name==='verify-'+syntheticSource),decoded=decodeV39IntegrationToolContent(artifact.toolContent),summary=copy(decoded.summary);
  mutate(summary);const roots=decoded.rootRecords;
  roots.set('summary.json',encode(summary));roots.set('source-before.json',encode(summary.sourceBefore));roots.set('source-after.json',encode(summary.sourceAfter));
  for(const stage of summary.stages)roots.set(stage.name+'.json',encode(stage));
  artifact.toolContent=encodeV39IntegrationToolContent([...roots].map(([path,bytes])=>({path,bytes})),'source');
  artifact.members=[...roots].map(([path,raw])=>({...rawPin(path,raw),crc32:crc32(raw)}));
  artifact.expandedBytes=[...roots.values()].reduce((total,raw)=>total+raw.length,0);
  const bytes=zipOf(roots);artifact.zip=rawPin(artifact.zip.path,bytes);
  const platform=full.proofs.flatMap(p=>p.artifacts).find(row=>row.id===artifact.id);platform.size_in_bytes=bytes.length;platform.digest='sha256:'+sha(bytes);
  return full;
}
function controlledReportTool(full,head){
  const admission=inspectV39IntegrationReportAdmission(directory,hosted(head));
  const identity={head,parent:syntheticSource,branch,tree:command(directory,['rev-parse','HEAD^{tree}']),status:'',
    gitDir:path.join(directory,'.git'),commonDir:path.join(directory,'.git')};
  const currentFiles=[...new Set([...sourcePaths,...reportPaths])].sort().map(pin),sourceBefore={identity,admission,currentFiles,
    productInputs:currentFiles.filter(row=>row.path.startsWith('apps/')||row.path.startsWith('packages/'))};
  const source=decodeV39IntegrationToolContent(full.artifacts.find(row=>row.name==='verify-'+syntheticSource).toolContent);
  const roots=new Map(),stages=source.summary.stages.filter(row=>row.name!=='tape-74').map(row=>{
    const stage=copy(row),name=stage.name;
    let stdout=source.rootRecords.get(name+'.stdout.log');
    if(name==='integration-safety'){
      stdout=Buffer.from('TAP version 13\n'+integrationNames.map((name,i)=>'ok '+(i+1)+' - '+name
        +(i<3?' # SKIP '+V39_INTEGRATION_REPORT_SKIP:'')+'\n').join('')+'1..10\n'
        +Object.entries({...counts(10),pass:7,skipped:3}).map(([key,n])=>'# '+key+' '+n+'\n').join(''));
      stage.expectedTests=null;stage.expectedCaseNames=null;stage.testCounts=null;
      stage.actualCaseNames=integrationNames.map((name,i)=>name+(i<3?' # SKIP '+V39_INTEGRATION_REPORT_SKIP:''));
      stage.raw.stdout=rawPin(name+'.stdout.log',stdout);
    }
    roots.set(name+'.json',encode(stage));roots.set(name+'.stdout.log',stdout);roots.set(name+'.stderr.log',Buffer.alloc(0));return stage;
  });
  const artifactFiles=V39_INTEGRATION_EXPORT_ROOT_FILES.filter(name=>!['fresh-reader.json','verify.log','standard-verification.json'].includes(name)
    &&!name.startsWith('tape-74.'));
  const summary=buildV39IntegrationGateSummary({sourceBefore,sourceAfter:sourceBefore,freshReader:null,
    standardVerification:{status:'NOT_REPEATED_EXACT_PARENT_CURRENT_PRODUCT_REUSE',sourceSha:syntheticSource,
      currentReportStandardRepeated:false,parentSourceReceiptValidatedByActualAdmission:true},stages,
    startedAtMs:1,finishedAtMs:11,durationMs:10,failureCode:null,artifactFiles,
    temporaryCleanup:{ownedFreshTemporaryRoot:true,allStageProcessesPhysicallyClosed:true,removed:true,sourceAndEvidenceNeverDeleted:true}});
  roots.set('summary.json',encode(summary));roots.set('source-before.json',encode(sourceBefore));roots.set('source-after.json',encode(sourceBefore));
  roots.set('integration-case-proof.json',encode({schema:'musicbridge.v39.integration.current-composition-cases.v1',role:'report',sourceSha:syntheticSource,
    raw:stages.find(row=>row.name==='integration-safety').raw.stdout,...inspectV39IntegrationSafetyRaw(roots.get('integration-safety.stdout.log'),'report'),
    sourceControlledProductCases:0,inheritedSourceProductCases:3,actualDeviceProviderAudioOwnerAcceptance:'NOT_RUN'}));
  assert.equal(roots.size,22);const bytes=zipOf(roots),zipPath=path.join(root,'controlled-report-tool-'+head+'.zip');writeFileSync(zipPath,bytes);
  const toolContent=encodeV39IntegrationToolContent([...roots].map(([path,bytes])=>({path,bytes})),'report');
  const artifact={name:'verify-'+head,zip:rawPin(zipPath,bytes),members:[...roots].map(([path,raw])=>({...rawPin(path,raw),crc32:crc32(raw)})),toolContent};
  assert.equal(validateV39IntegrationReportToolContent(artifact,syntheticSource,head),true,'同一真实builder的Report22/203注册200pass3继承skip格式必须可消费');
  return artifact;
}

test(reportNames[0],async t=>{
  const f=fixture(t);let calls=0;
  const result=await inspectV39IntegrationReportOnly(hosted(f.source),f.directory,async()=>{calls++;assert.fail('Source不得访问报告API');});
  assert.equal(result.mode,'full');assert.equal(result.productResultsReused,false);assert.equal(calls,0);
  assert.equal(result.reason,'V39_CURRENT_SOURCE_REQUIRES_FRESH_PRODUCT_SOFTWARE');
});
test(reportNames[1],t=>{
  const f=report(t),result=inspectV39IntegrationReportAdmission(f.directory,hosted(f.head));
  const tool=controlledReportTool(f.full,f.head);
  const wrong=copy(tool);wrong.toolContent.phase='source';
  assert.equal(validateV39IntegrationReportToolContent(wrong,f.source,f.head),false);
  assert.equal(result.sourceSha,f.source);assert.equal(result.sourceParentSha,sourceParent);assert.equal(result.repairRole,'report');
  assert.equal(result.exactSourceFiles,52);assert.equal(result.exactSourceDeltaFiles,20);
  assert.equal(result.failedSource1Preserved,true);assert.equal(result.failedSource2Preserved,true);assert.deepEqual(result.sourceCorrection,correction);
  assert.equal(result.sourceCorrectionSha256,correctionRef.canonical.sha256);assert.equal(result.exactReportFiles,8);assert.deepEqual(result.sourcePins,sourcePaths.map(relative=>{
    const raw=command(directory,['show',f.source+':'+relative],{binary:true});return {path:relative,mode:'100644',blob:blob(raw),bytes:raw.length,sha256:sha(raw)};
  }));
  const output=v39IntegrationWorkflowOutputs(result);assert.equal(output.productVerificationMode,'exact-parent-current-product-reuse');
  assert.equal(output.integrationRole,'report');
  const machine=record(path.join(directory,'project/STATUS.json')).v39Integration;
  assert.equal(/https?:\/\//u.test(JSON.stringify(machine)),false);
  assert.equal(machine.sourceCi.artifacts.length,5);assert.ok(machine.sourceCi.artifacts.every(row=>row.memberManifest.count>0));
});
test(reportNames[2],async t=>{
  const f=report(t);writeFileSync(path.join(directory,'reports/v39-ninth-report.json'),'{}\n');
  commitWorking(['reports/v39-ninth-report.json'],[f.source]);let calls=0;
  assert.throws(()=>inspectV39IntegrationReportAdmission(directory,environment),rejected);
  const denied=await inspectV39IntegrationReportOnly(hosted(command(directory,['rev-parse','HEAD'])),directory,async()=>{calls++;assert.fail();});
  assert.equal(denied.mode,'full');assert.equal(calls,0);
  report(t);appendFileSync(path.join(directory,'packages/contracts/src/reference-catalog.ts'),'\n// Report非法产品字节\n');
  commitWorking(['packages/contracts/src/reference-catalog.ts'],[syntheticSource]);
  assert.throws(()=>inspectV39IntegrationReportAdmission(directory,environment),rejected);
});
test(reportNames[3],t=>{
  const f=report(t);mutateMtime();commitWorking(['project/STATUS.json'],[f.source]);
  assert.throws(()=>inspectV39IntegrationReportAdmission(directory,environment),error=>error.code==='V39_REPORT_STATUS_OUTSIDE_DOMAIN');
  report(t);jsonEdit('project/POSTRUST_PLAN.json',value=>{value.integration_execution_schedule.remaining_sequence[1]='MBRS-016';});
  commitWorking(['project/POSTRUST_PLAN.json'],[syntheticSource]);
  assert.throws(()=>inspectV39IntegrationReportAdmission(directory,environment),error=>error.code==='V39_REPORT_PLAN_OUTSIDE_DOMAIN');
});
test(reportNames[4],t=>{
  fixture(t);const full=buildReceipt();
  for(const old of [failedSource1,failedSource2,base,'16507120ab52d4843012e6888ad521138d8336d6','d3d86c6db8d27485d2d763b81cd5e8925ee15af6']){
    const data=copy(full);data.revision=old;assert.equal(validateV39IntegrationSourceReceipt(data,old),false);
  }
  const wrong=copy(full);wrong.compiledAndApp='SKIPPED_REUSED_S165';
  assert.equal(validateV39IntegrationSourceReceipt(wrong,syntheticSource),false);
  assert.throws(()=>v39IntegrationReportIdentity(syntheticSource,wrong),rejected);
});
test(reportNames[5],t=>{
  fixture(t);const full=buildReceipt();
  assert.equal(validateV39IntegrationParentCi({task,repositoryId:1340424953,parent:syntheticSource,branch,
    runs:full.runs,proofs:full.proofs,now:Date.parse(full.recordedAt)}),true);
  assert.equal(full.proofs.flatMap(row=>row.jobs).length,6);assert.equal(full.artifacts.length,5);
  for(const mutate of [
    d=>d.proofs[0].artifacts.pop(),d=>d.runs[1].head_repository.id++,d=>d.proofs[2].jobs[0].head_sha=base,
    d=>d.artifacts[3].zip.sha256='1'.repeat(64),d=>d.proofs[3].artifacts[0].workflow_run.id++,
    d=>d.artifacts[4].allMembersBytesAndCrcRead=false,d=>d.artifacts[1].members[0].path='../escaped',
  ]){const data=copy(full);mutate(data);assert.equal(validateV39IntegrationSourceReceipt(data,syntheticSource),false);}
});
test(reportNames[6],t=>{
  fixture(t);const full=buildReceipt();
  for(const mutate of [
    d=>d.runs[0].run_attempt=2,d=>d.runs[3].conclusion='failure',d=>d.proofs[0].jobs[0].conclusion='failure',
    d=>d.runs.push(copy(d.runs[0])),d=>d.proofs[2].jobs.push(copy(d.proofs[2].jobs[0])),
    d=>d.proofs[0].jobs[0].steps.find(row=>row.name==='Verify platform-independent workspace (typecheck, unit tests, build; no Electron)').conclusion='skipped',
    d=>d.proofs[3].jobs[0].steps.find(row=>row.name==='Electron end-to-end flow (Playwright, production build)').conclusion='skipped',
    d=>d.proofs[0].jobs[0].steps.find(row=>row.name==='复用165已封存产品软件证据').conclusion='success',
  ]){const data=copy(full);mutate(data);assert.equal(validateV39IntegrationSourceReceipt(data,syntheticSource),false);}
});
test(reportNames[7],t=>{
  fixture(t);const full=buildReceipt();
  assert.equal(validateV39IntegrationSourceReceipt(full,syntheticSource),true);
  const summaryOnly=copy(full);summaryOnly.artifacts[0].toolContent.result={passed:false};
  assert.equal(validateV39IntegrationSourceReceipt(summaryOnly,syntheticSource),false);
  const invalidBase64=copy(full);invalidBase64.artifacts[0].toolContent.rootArchive.gzip.base64+='\n';
  assert.equal(validateV39IntegrationSourceReceipt(invalidBase64,syntheticSource),false);
  for(const mutate of [
    s=>s.limits.wholeMs++,s=>s.durationMs=480000,s=>s.stages[3].timedOut=true,s=>s.stages[3].terminationRequested=true,
    s=>s.stages[3].physicalShutdown.processGroupAbsent=false,s=>s.stages[3].observedDescendantsAbsent=false,
    s=>s.stages[3].rawForcedClosed=true,s=>s.stages[3].descendantScanFailed=true,s=>s.stages[3].unexpectedPipeHolder=true,
    s=>s.stages[3].testCounts.skipped=1,s=>s.temporaryCleanup.removed=false,s=>s.sourceBefore.freshReader.currentWorkerIndependentlyVerified=false,
    s=>s.standardVerification.receipt.tapRuns.pop(),
    s=>s.failedSource1Preserved=false,s=>s.failedSource2Preserved=false,
    s=>s.sourceBefore.admission.failedSource2Preserved=false,
    s=>s.sourceCorrection.source1FirstNaturalCi.sourceCiQualified=true,
    s=>s.sourceCorrection.failedSource2.originalCorrectionCanonical.sha256='f'.repeat(64),
    s=>s.sourceCorrection.source2FirstNaturalCi.successJobs=6,
    s=>s.sourceCorrection.source2ElectronFailure.wholeZipSha256Verified=true,
    s=>s.sourceCorrection.source2ElectronFailure.allMembersBytesAndCrcRead=true,
    s=>s.sourceBefore.admission.exactSourceFiles=53,
    s=>s.sourceBefore.admission.exactSourceDeltaFiles=21,s=>s.sourceParentSha=base,
  ])assert.equal(validateV39IntegrationSourceReceipt(rebuildTool(copy(full),mutate),syntheticSource),false);
  const roots=copy(full);roots.artifacts[0].toolContent.rootArchive.entries.pop();
  assert.equal(validateV39IntegrationSourceReceipt(roots,syntheticSource),false);
  const expanded=copy(full);expanded.artifacts[0].toolContent.rootArchive.rawBytes=67108865;
  assert.equal(validateV39IntegrationSourceReceipt(expanded,syntheticSource),false);
  const crc=copy(full);crc.artifacts[0].members[0].crc32^=1;
  assert.equal(validateV39IntegrationSourceReceipt(crc,syntheticSource),false);
  const compressed=copy(full),archive=compressed.artifacts[0].toolContent.rootArchive,raw=Buffer.from(archive.gzip.base64,'base64');
  raw[raw.length-1]^=1;archive.gzip.base64=raw.toString('base64');archive.gzip.sha256=sha(raw);
  assert.equal(validateV39IntegrationSourceReceipt(compressed,syntheticSource),false);
  const decoded=decodeV39IntegrationToolContent(full.artifacts[0].toolContent);
  assert.deepEqual(decoded.summary,v39IntegrationSourceSummary(full));
  assert.equal(decoded.rootRecords.size,28);
  for(const member of full.artifacts[0].members){const bytes=decoded.rootRecords.get(member.path);
    assert.equal(bytes.length,member.bytes);assert.equal(sha(bytes),member.sha256);assert.equal(crc32(bytes),member.crc32);}
});
test(reportNames[8],async t=>{
  const f=report(t);let calls=0;
  const passed=await inspectV39IntegrationReportOnly(hosted(f.head),f.directory,apiFor(f.full,{onCall:()=>calls++}));
  assert.equal(passed.mode,'report-only');assert.equal(passed.reason,'EXACT_PARENT_CURRENT_PRODUCT_CI_SUCCESS');
  assert.equal(passed.productResultsReused,true);assert.equal(passed.currentProductTestsRepeated,false);
  assert.equal(passed.artifactContentDownloaded,false);assert.equal(calls,10);
  const changed=await inspectV39IntegrationReportOnly(hosted(f.head),f.directory,apiFor(f.full,{mutate:(value,endpoint)=>{
    if(endpoint.endsWith('/artifacts?per_page=100')&&value.artifacts.length)value.artifacts[0].digest='sha256:'+'0'.repeat(64);}}));
  assert.equal(changed.mode,'full');assert.equal(changed.productResultsReused,false);
});
test(reportNames[9],async t=>{
  const f=report(t);let calls=0;
  const local=await inspectV39IntegrationReportOnly({...hosted(f.head),RUNNER_ENVIRONMENT:'self-hosted'},f.directory,async()=>{calls++;assert.fail();});
  assert.equal(local.mode,'full');assert.equal(calls,0);
  const failure=await inspectV39IntegrationReportOnly(hosted(f.head),f.directory,async()=>{throw new Error('受控API失败');});
  assert.equal(failure.mode,'full');assert.equal(failure.productResultsReused,false);
  checkout(f.head,'codex/unknown-v39');
  const unknown=await inspectV39IntegrationReportOnly({...hosted(f.head),GITHUB_REF_NAME:'codex/unknown-v39'},f.directory,async()=>{calls++;assert.fail();});
  assert.equal(unknown.mode,'full');assert.equal(calls,0);
});
