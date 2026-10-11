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
  V39_INTEGRATION_SOURCE_CORRECTION_IDENTITY as correction,V39_INTEGRATION_SOURCE_CORRECTION_REF as correctionRef,
  V39_INTEGRATION_SCOPE_PATH as scopePath,V39_INTEGRATION_STATUS_PATH as statusPath,
  V39_INTEGRATION_CI_EVIDENCE_PATH as evidencePath, V39_INTEGRATION_DONOR_PATH as donorPath,
  V39_INTEGRATION_SOURCE_FILES as sourceFiles,V39_INTEGRATION_REPORT_PATHS as reportPaths,
  V39_INTEGRATION_ADMISSION_CASE_NAMES as admissionNames,V39_INTEGRATION_REPORT_CASE_NAMES as reportNames,
  V39_INTEGRATION_GUARD_STEP as guard,V39_INTEGRATION_GATE_STEP as gate,V39_INTEGRATION_UPLOAD_STEP as upload,
  inspectV39IntegrationAdmission,inspectV39IntegrationReportAdmission,inspectV39IntegrationWorkflowGuard,
  v39IntegrationWorkflowOutputs,validateV39IntegrationParentCi,validateV39IntegrationSourceReceipt,
  v39IntegrationPublicSourceCi,v39IntegrationReportIdentity,v39IntegrationReportState,v39IntegrationCanonicalPin,
} from '../v39-integration-admission.mjs';
import { inspectV39IntegrationReportOnly } from '../report-only-v39-integration.mjs';
import { V39_INTEGRATION_TAPE_TESTS,V39_INTEGRATION_SAFETY_CASE_NAMES as integrationNames,
  V39_INTEGRATION_STAGE_NAMES as stageNames } from '../verify-v39-integration.mjs';
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
  if(paths.length)command(directory,['add','--',...paths]);const tree=command(directory,['write-tree']);
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
    const immutableSource=current[0]===sourceParent?null:current[1]===sourceParent?current[0]:current[1];
    if(immutableSource)assert.equal(command(repository,['rev-list','--parents','-n','1',immutableSource]).split(' ')[1],sourceParent);
    for(const relative of sourcePaths){
      const filename=path.join(directory,relative);mkdirSync(path.dirname(filename),{recursive:true,mode:0o700});
      const raw=immutableSource?command(repository,['show',immutableSource+':'+relative],{binary:true}):readFileSync(path.join(repository,relative));
      writeFileSync(filename,raw,{mode:0o644});chmodSync(filename,0o644);
    }
    // 失败Source的30个非修复叶直接继承；只能在本fixture十条闭集中补齐当前开发态。
    jsonEdit('docs/integration/V39-INTEGRATION-001/LOCAL_SOFTWARE_EVIDENCE.json',value=>{value.sourceCorrection=copy(correction);});
    for(const row of deltaFiles){
      if(row.path===scopePath||row.path==='docs/integration/V39-INTEGRATION-001/LOCAL_SOFTWARE_EVIDENCE.json')continue;
      const filename=path.join(directory,row.path);
      if(blob(readFileSync(filename))===row.before.blob){
        assert.notEqual(row.path,'packages/bridge-core/test/rust-core-owner-lifecycle.test.ts','case5必须已有真实修复，不能用空白伪造');
        appendFileSync(filename,row.path.endsWith('.mjs')?'\n// 受控fixture直接修复叶；不代表产品Source。\n':'\n受控fixture直接修复叶；不代表产品Source。\n');
      }
    }
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
function crc32(raw){let value=0xffffffff;for(const byte of raw){value^=byte;for(let i=0;i<8;i++)value=value>>>1^(value&1?0xedb88320:0);}
  return(value^0xffffffff)>>>0;}
function rawPin(name,bytes){return {path:name,bytes:bytes.length,sha256:sha(bytes)};}
function encode(value){return Buffer.from(JSON.stringify(value,null,2)+'\n');}

test(admissionNames[0],t=>{
  const f=fixture(t),result=inspectV39IntegrationAdmission(f.directory,environment);
  assert.equal(result.sourceSha,f.source);assert.equal(result.sourceParentSha,sourceParent);assert.equal(result.exactSourceFiles,40);assert.equal(result.exactSourceDeltaFiles,10);
  assert.equal(result.failedSource1Preserved,true);assert.deepEqual(result.sourceCorrection,correction);
  assert.equal(result.sourceCorrectionSha256,correctionRef.canonical.sha256);
  assert.equal(result.exactReportFiles,0);assert.equal(result.sealedBaselinePreserved,true);assert.equal(result.offlineTapeDonorVerified,true);
  assert.equal(result.currentProductSoftwareRequired,true);assert.deepEqual(result.sourcePins,sourcePaths.map(pin));
  const output=v39IntegrationWorkflowOutputs(result);assert.equal(output.integrationMode,'qualified');
  assert.equal(output.integrationRole,'source');assert.equal(output.productVerificationMode,'fresh-source');
  assert.equal(command(directory,['rev-list','--parents','-n','1',f.source]),f.source+' '+sourceParent);
});
test(admissionNames[1],t=>{
  fixture(t);
  jsonEdit(scopePath,value=>{value.frozen=false;value.executionStatus='DEVELOPMENT_IN_PROGRESS';});
  commitWorking([scopePath]);assert.throws(()=>inspectV39IntegrationAdmission(directory,environment),rejected);
  fixture(t);jsonEdit(statusPath,value=>{value.software='PASSED';value.sourceCi='PASS';});repin(statusPath);
  assert.throws(()=>inspectV39IntegrationAdmission(directory,environment),rejected);
});
test(admissionNames[2],t=>{
  fixture(t);
  const merged=commitTree(directory,sourceTree,[sourceParent,'0dffccb0b351e994ee19e0840e12f88481956c6f'],'受控Fake多父Source');
  checkout(merged);assert.throws(()=>inspectV39IntegrationAdmission(directory,environment),rejected);
  checkout(sourceParent);assert.throws(()=>inspectV39IntegrationAdmission(directory,environment),error=>error.code==='V39_INTEGRATION_FAILED_SOURCE1_CANNOT_QUALIFY');
  checkout(commitTree(directory,sourceTree,[base],'受控Fake错误累计基线直父'));
  assert.throws(()=>inspectV39IntegrationAdmission(directory,environment),rejected);
  checkout(commitTree(directory,sourceTree,[syntheticSource],'受控Fake任意中间父'));
  assert.throws(()=>inspectV39IntegrationAdmission(directory,environment),rejected);
  checkout(syntheticSource,'codex/v39-integration-002');
  assert.throws(()=>inspectV39IntegrationWorkflowGuard(directory,environment),rejected);
  fixture(t);assert.throws(()=>inspectV39IntegrationAdmission(directory,{...hosted(syntheticSource),GITHUB_SHA:base}),rejected);
});
test(admissionNames[3],t=>{
  fixture(t);writeFileSync(path.join(directory,'v39-outside-scope.txt'),'受控Fake第41路径\n');
  commitWorking(['v39-outside-scope.txt']);assert.throws(()=>inspectV39IntegrationAdmission(directory,environment),rejected);
  fixture(t);command(directory,['rm','--','packages/contracts/src/reference-catalog.ts']);commitWorking([]);
  assert.throws(()=>inspectV39IntegrationAdmission(directory,environment),rejected);
  fixture(t);command(directory,['mv','--','reports/TAPE_CATALOG_HISTORY_COMPAT_RESULT.md','reports/v39-renamed.md']);
  commitWorking([]);
  assert.throws(()=>inspectV39IntegrationAdmission(directory,environment),rejected);
  fixture(t);chmodSync(path.join(directory,'scripts/ci/v39-integration-admission.mjs'),0o755);
  commitWorking(['scripts/ci/v39-integration-admission.mjs']);assert.throws(()=>inspectV39IntegrationAdmission(directory,environment),rejected);
});
test(admissionNames[4],t=>{
  fixture(t);appendFileSync(path.join(directory,'tasks/V39-INTEGRATION-001.md'),'\n未更新冻结pin的漂移\n');
  commitWorking(['tasks/V39-INTEGRATION-001.md']);assert.throws(()=>inspectV39IntegrationAdmission(directory,environment),rejected);
  fixture(t);jsonEdit(scopePath,value=>{value.finalFiles.find(row=>row.path===scopePath).bytes--;});
  commitWorking([scopePath]);assert.throws(()=>inspectV39IntegrationAdmission(directory,environment),rejected);
  fixture(t);freezeScope(value=>{value.finalFiles.find(row=>row.path==='tasks/V39-INTEGRATION-001.md').blob=null;});
  commitWorking([scopePath]);assert.throws(()=>inspectV39IntegrationAdmission(directory,environment),rejected);
});
test(admissionNames[5],t=>{
  fixture(t);const original='docs/postrust/MBM-004/SOURCE_CORRECTION.json';
  const raw=readFileSync(path.join(directory,original));appendFileSync(path.join(directory,original),'\n');
  commitWorking([original]);assert.throws(()=>inspectV39IntegrationAdmission(directory,environment),rejected);
  fixture(t);assert.deepEqual(readFileSync(path.join(directory,original)),raw);
  jsonEdit(scopePath,value=>{value.allowedSourceFiles[0].before.sha256='0'.repeat(64);});
  commitWorking([scopePath]);assert.throws(()=>inspectV39IntegrationAdmission(directory,environment),rejected);
  fixture(t);jsonEdit(scopePath,value=>{value.sourceDeltaFiles[0].before.blob='0'.repeat(40);});
  commitWorking([scopePath]);assert.throws(()=>inspectV39IntegrationAdmission(directory,environment),rejected);
  fixture(t);jsonEdit('docs/integration/V39-INTEGRATION-001/LOCAL_SOFTWARE_EVIDENCE.json',value=>{
    value.sourceCorrection.source1FirstNaturalCi.failures[0].conclusion='success';
  });repin('docs/integration/V39-INTEGRATION-001/LOCAL_SOFTWARE_EVIDENCE.json');
  assert.throws(()=>inspectV39IntegrationAdmission(directory,environment),rejected);
});
test(admissionNames[6],t=>{
  fixture(t);const before=numericTokens(readFileSync(path.join(directory,'project/STATUS.json'),'utf8')).get(protectedMtimePointer);
  assert.ok(before&&BigInt(before.raw)>2n**53n);mutateMtime();repin('project/STATUS.json');
  assert.throws(()=>inspectV39IntegrationAdmission(directory,environment),rejected);
  fixture(t);jsonEdit('project/POSTRUST_PLAN.json',value=>{value.acceptance_cases[0].title+='非法重写原验收';});repin('project/POSTRUST_PLAN.json');
  assert.throws(()=>inspectV39IntegrationAdmission(directory,environment),rejected);
});
test(admissionNames[7],t=>{
  fixture(t);jsonEdit(donorPath,value=>{value.gitObjectEvidence.objects.pop();});repin(donorPath);
  assert.throws(()=>inspectV39IntegrationAdmission(directory,environment),rejected);
  fixture(t);jsonEdit(donorPath,value=>{value.gitObjectEvidence.objects[0].rawBase64=Buffer.from('篡改Git raw对象').toString('base64');});repin(donorPath);
  assert.throws(()=>inspectV39IntegrationAdmission(directory,environment),rejected);
  fixture(t);appendFileSync(path.join(directory,'packages/contracts/src/reference-catalog.ts'),'\n// 非原donor新增字节\n');
  repin('packages/contracts/src/reference-catalog.ts');
  assert.throws(()=>inspectV39IntegrationAdmission(directory,environment),rejected);
});
test(admissionNames[8],t=>{
  fixture(t);const dirty=path.join(directory,'v39-owned-dirty.txt');writeFileSync(dirty,'受控Fake dirty\n');
  assert.throws(()=>inspectV39IntegrationAdmission(directory,environment),rejected);rmSync(dirty);
  assert.throws(()=>inspectV39IntegrationAdmission(directory,{...environment,GIT_OBJECT_DIRECTORY:path.join(root,'foreign')}),rejected);
  const shallow=path.join(directory,'.git/shallow');writeFileSync(shallow,base+'\n');
  assert.throws(()=>inspectV39IntegrationAdmission(directory,environment),rejected);rmSync(shallow);
  command(directory,['update-index','--skip-worktree','--','project/STATUS.json']);
  assert.throws(()=>inspectV39IntegrationAdmission(directory,environment),rejected);
  command(directory,['update-index','--no-skip-worktree','--','project/STATUS.json']);
  command(directory,['replace',base,syntheticSource]);assert.throws(()=>inspectV39IntegrationAdmission(directory,environment),rejected);
  command(directory,['replace','-d',base]);
});
test(admissionNames[9],t=>{
  fixture(t);const real=inspectV39IntegrationAdmission(directory,environment);
  assert.throws(()=>v39IntegrationWorkflowOutputs(copy(real)),rejected);
  assert.throws(()=>v39IntegrationWorkflowOutputs({...real}),rejected);
  appendFileSync(path.join(directory,'tasks/V39-INTEGRATION-001.md'),'\n输出前身份变动\n');
  assert.throws(()=>v39IntegrationWorkflowOutputs(real),rejected);
  fixture(t);assert.equal(v39IntegrationWorkflowOutputs(inspectV39IntegrationAdmission(directory,environment)).integrationMode,'qualified');
});
