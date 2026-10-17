import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as authority from '../v39-integration-002-admission.mjs';
import { CI_REPORT_MIRROR_ORIGINAL_TESTS } from '../verify-ci-report-mirror.mjs';
import { buildV39Integration002GateSummary } from '../verify-v39-integration-002.mjs';
const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const external='/Volumes/LifeWeave/Developer/CommandLine/tmp';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const oid=bytes=>createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
// Scope395 仅三个已固定sealed4c执行接点，不能从当前Scope扩出其它路径。
const factoryBridgeAuthorization=[
  {
    "path": "apps/desktop/src/main/core-host.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "210b30e9de914239e816ea913937882ac02d421b",
      "bytes": 5033,
      "sha256": "67087bd2418d6e2ecec3a4ea8d8bbf275def6c85cd164353d19fb217cdfb781c"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "apps/desktop/src/main/dataset-owner-bootstrap.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "194335c3921eebac6373a509ca086830a9b54ac6",
      "bytes": 2657,
      "sha256": "5554d606531a6e67c81303c0f1af17080f9e6c7bbe67a9501e75d5207c7c78ab"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "apps/desktop/src/main/dataset-owner-entry.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "ff093376a206ec535a3de4d5dfce801e0d871e05",
      "bytes": 2080,
      "sha256": "b46f34900205ee02b846e0b55f5ce65591f864687d67626fe184192e56ec5e3d"
    },
    "owner": "Root",
    "donor": null
  }
];
export const fixtureEnvironment=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')&&!key.startsWith('GITHUB_')&&!['RUNNER_ENVIRONMENT','NODE_OPTIONS','NODE_PATH'].includes(key)));
Object.assign(fixtureEnvironment,{GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',GIT_NO_LAZY_FETCH:'1',
 GIT_AUTHOR_NAME:'受控Git fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'受控Git fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'});
export function fixtureGit(directory,args,input){const result=spawnSync('git',['--no-replace-objects','-c','core.fsmonitor=false',...args],
 {cwd:directory,env:fixtureEnvironment,input,timeout:10000,killSignal:'SIGKILL',maxBuffer:16777216});
 assert.equal(result.error,undefined);assert.equal(result.signal,null);assert.equal(result.status,0,result.stderr?.toString());return result.stdout.toString('utf8').trim();}
export function privateRoot(label){const base=process.env.TMPDIR??external;
 assert.ok(base.startsWith(external+'/')||base===external||process.env.GITHUB_ACTIONS==='true'&&base.startsWith(process.env.RUNNER_TEMP+'/'));
 assert.equal(realpathSync(base),base);assert.ok(lstatSync(base).isDirectory());return mkdtempSync(path.join(base,'musicbridge-v39-002-'+label+'-'));}
export function writeFixture(directory,name,bytes){mkdirSync(path.dirname(path.join(directory,name)),{recursive:true,mode:0o700});writeFileSync(path.join(directory,name),bytes,{mode:0o600});}
export function replaceTopJson(bytes,key,value){const text=bytes.toString('utf8'),wanted=JSON.stringify(key);let at=1;
 const whitespace=()=>{while(/\s/u.test(text[at]??''))at++;};
 while(at<text.length){whitespace();if(text[at]==='}')break;const begin=at++;let escaped=false;
  while(at<text.length){const char=text[at++];if(escaped){escaped=false;continue;}if(char==='\\'){escaped=true;continue;}if(char==='"')break;}
  const token=text.slice(begin,at);whitespace();assert.equal(text[at++],':');whitespace();const valueStart=at;let depth=0,string=false,escape=false;
  while(at<text.length){const c=text[at];if(string){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')string=false;at++;continue;}
   if(c==='"'){string=true;at++;continue;}if(c==='{'||c==='[')depth++;else if(c==='}'||c===']'){if(depth===0)break;depth--;}
   if(c===','&&depth===0)break;at++;}
  if(token===wanted)return Buffer.from(text.slice(0,valueStart)+JSON.stringify(value,null,2)+text.slice(at));
  if(text[at]===',')at++;
 }throw new Error('受控fixture未找到指定顶层字段。');}
function freezeScope(directory,template,names){const scope=structuredClone(template);scope.frozen=true;scope.executionStatus='READY_FOR_SOURCE';
 scope.finalFiles=[...names].sort().map(name=>{const bytes=readFileSync(path.join(directory,name));return {path:name,mode:'100644',blob:name===authority.V39_INTEGRATION_SCOPE_PATH?null:oid(bytes),
  bytes:bytes.length,sha256:name===authority.V39_INTEGRATION_SCOPE_PATH?null:sha(bytes)};});
 const self=scope.finalFiles.find(row=>row.path===authority.V39_INTEGRATION_SCOPE_PATH);let bytes;
 for(let i=0;i<16;i++){bytes=Buffer.from(JSON.stringify(scope,null,2)+'\n');if(self.bytes===bytes.length)break;self.bytes=bytes.length;}
 assert.equal(self.bytes,bytes.length);writeFixture(directory,authority.V39_INTEGRATION_SCOPE_PATH,bytes);return scope;}
function assertFixtureOriginalParent282(directory){
 const modified=authority.V39_INTEGRATION_AUTHORIZATION.filter(row=>row.status==='M');
 const tree=fixtureGit(directory,['ls-tree',authority.V39_INTEGRATION_BASE,'--',...modified.map(row=>row.path)]);
 const rows=new Map(tree.split('\n').filter(Boolean).map(line=>{const tab=line.indexOf('\t');assert.ok(tab>0);return [line.slice(tab+1),line.slice(0,tab)];}));
 for(const row of modified){assert.ok(row.before&&row.before.mode&&row.before.blob,'M必须保真实4c原件，不能退为null或伪A：'+row.path);
  assert.equal(rows.get(row.path),row.before.mode+' blob '+row.before.blob);
  const file=path.join(directory,row.path);assert.ok(lstatSync(file).isFile()&&!lstatSync(file).isSymbolicLink());const raw=readFileSync(file);
  assert.equal(raw.length,row.before.bytes);assert.equal(sha(raw),row.before.sha256);assert.equal(oid(raw),row.before.blob);}
 for(const row of authority.V39_INTEGRATION_AUTHORIZATION.filter(row=>row.before===null)){
  assert.equal(row.status,'A','null before只能描述真实新增叶');assert.equal(fixtureGit(directory,['ls-tree',authority.V39_INTEGRATION_BASE,'--',row.path]),'');
  assert.equal(existsSync(path.join(directory,row.path)),false,'新增叶在真实4c父树与checkout均必须ABSENT');}
}
let shared;
export function sourceFixture(){if(shared)return shared;
 const root=privateRoot('governance'),directory=path.join(root,'source');
 fixtureGit(root,['clone','--local','--no-hardlinks','--no-checkout',repository,directory]);fixtureGit(directory,['branch','-m','controlled-fixture-original']);fixtureGit(directory,['checkout','-b',authority.V39_INTEGRATION_BRANCH,authority.V39_INTEGRATION_BASE]);
 assertFixtureOriginalParent282(directory);
 const template=JSON.parse(readFileSync(path.join(repository,authority.V39_INTEGRATION_SCOPE_PATH))),names=[];
 for(const row of authority.V39_INTEGRATION_AUTHORIZATION){const file=path.join(repository,row.path);if(!existsSync(file))continue;
  assert.ok(lstatSync(file).isFile()&&!lstatSync(file).isSymbolicLink());const bytes=readFileSync(file);
  if(row.status==='A'||sha(bytes)!==row.before.sha256){writeFixture(directory,row.path,bytes);names.push(row.path);}}
 assert.ok(names.includes(authority.V39_INTEGRATION_SCOPE_PATH));const scope=freezeScope(directory,template,names);
 fixtureGit(directory,['add','--',...names]);fixtureGit(directory,['commit','-m','CONTROLLED_FAKE_ONLY: exact002 Source fixture; no actual software or CI qualification']);
 const source=fixtureGit(directory,['rev-parse','HEAD']);shared={root,directory,source,scope,template,names,
  qualification:'CONTROLLED_FAKE_NOT_CURRENT_SOURCE_NOT_PLATFORM_CI'};return shared;}
export function sourceVariant(change,{branch=authority.V39_INTEGRATION_BRANCH,parent=authority.V39_INTEGRATION_BASE}={}){
 const original=sourceFixture(),root=privateRoot('source-variant'),directory=path.join(root,'repo');
 fixtureGit(root,['clone','--local','--no-hardlinks','--no-checkout',original.directory,directory]);fixtureGit(directory,['branch','-m','controlled-fixture-original']);
 fixtureGit(directory,['checkout','-b',branch,parent]);for(const name of original.names)writeFixture(directory,name,readFileSync(path.join(original.directory,name)));
 change?.(directory);const names=fixtureGit(directory,['diff','--name-only']).split('\n').filter(Boolean);
 const untracked=fixtureGit(directory,['ls-files','--others','--exclude-standard']).split('\n').filter(Boolean);
 fixtureGit(directory,['add','--',...new Set([...names,...untracked])]);fixtureGit(directory,['commit','--allow-empty','-m','CONTROLLED_FAKE_ONLY: mutation; never a published Source']);return directory;}
// 仅复用不可变受控fixture快照作codec输入；各生产准入/变异测试仍每operation实际完整读取。
export function fixtureAdmission(){const fixture=sourceFixture();return fixture.admission??=authority.inspectV39Integration002Admission(fixture.directory,fixtureEnvironment);}
export function rejectSource(directory){assert.throws(()=>authority.inspectV39Integration002Admission(directory,fixtureEnvironment),error=>/^V39_002_/u.test(error.code??''));}
export function tinyTap(names,skipFirst=0){return Buffer.from('TAP version 13\n'+names.map((name,i)=>'ok '+(i+1)+' - '+name+(i<skipFirst?' # SKIP EXACT_PARENT_CURRENT_SOURCE_PRODUCT_EVIDENCE_REUSED_NOT_REPEATED':'')+'\n').join('')+
 '1..'+names.length+'\n# tests '+names.length+'\n# suites 0\n# pass '+(names.length-skipFirst)+'\n# fail 0\n# cancelled 0\n# skipped '+skipFirst+'\n# todo 0\n');}
export function fakeStage(name,names=null,skips=0){const raw=names?tinyTap(names,skips):Buffer.from(name+'=PASS\n'),stderr=Buffer.alloc(0);
 const counts=names?{tests:names.length,suites:0,pass:names.length-skips,fail:0,cancelled:0,skipped:skips,todo:0}:null;
 return {record:{name,passed:true,exitCode:0,signal:null,exitObserved:true,closeObserved:true,rawCaptureComplete:true,
  physicalShutdown:{pidAbsent:true,processGroupAbsent:true},observedDescendantsAbsent:true,observedDescendants:[],
  timedOut:false,overflow:false,spawnFailed:false,interrupted:false,cleanupFailed:false,terminationRequested:false,lingeringOwnedGroup:false,
  descendantScanFailed:false,rawForcedClosed:false,boundedSettleObserved:false,unexpectedPipeHolder:false,durationMs:1,budgetMs:90000,
  raw:{stdout:{path:name+'.stdout.log',bytes:raw.length,sha256:sha(raw)},stderr:{path:name+'.stderr.log',bytes:0,sha256:sha(stderr)}},
  expectedTests:names?.length??null,expectedCaseNames:name==='original-173'||name==='current-composition'?null:names,
  actualCaseNames:names?.map((value,index)=>value+(index<skips?' # SKIP EXACT_PARENT_CURRENT_SOURCE_PRODUCT_EVIDENCE_REUSED_NOT_REPEATED':''))??[],
  testCounts:counts,tapComplete:names!==null,caseNamesMatched:true,fixtureEvidence:'CONTROLLED_FAKE_NOT_PHYSICAL_PRODUCT_EXECUTION'},stdout:raw,stderr};}
const crcTable=Uint32Array.from({length:256},(_v,index)=>{let c=index;for(let bit=0;bit<8;bit++)c=(c>>>1)^((c&1)?0xedb88320:0);return c>>>0;});
export function crc32(bytes){let crc=0xffffffff;for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
export function storedZip(records){let offset=0;const files=[],central=[];for(const row of records){const name=Buffer.from(row.path),crc=crc32(row.bytes),head=Buffer.alloc(30),footer=Buffer.alloc(46);
 head.writeUInt32LE(0x04034b50);head.writeUInt16LE(20,4);head.writeUInt32LE(crc,14);head.writeUInt32LE(row.bytes.length,18);head.writeUInt32LE(row.bytes.length,22);head.writeUInt16LE(name.length,26);
 footer.writeUInt32LE(0x02014b50);footer.writeUInt16LE(20,4);footer.writeUInt16LE(20,6);footer.writeUInt32LE(crc,16);footer.writeUInt32LE(row.bytes.length,20);footer.writeUInt32LE(row.bytes.length,24);footer.writeUInt16LE(name.length,28);footer.writeUInt32LE(offset,42);
 files.push(head,name,row.bytes);central.push(footer,name);offset+=head.length+name.length+row.bytes.length;}
 const index=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(records.length,8);end.writeUInt16LE(records.length,10);end.writeUInt32LE(index.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...files,index,end]);}
const originalArtifactRecords=new Map();
export function recordsOfArtifact(artifact){return originalArtifactRecords.get(artifact.zip.sha256).map(row=>({path:row.path,bytes:Buffer.from(row.bytes)}));}
export function fakeArtifact(records,{id,name,profile,source,head=source,toolContent,auxiliaryContents=[]}){
 const files=records.map(row=>({path:row.path,mode:'100600',bytes:row.bytes.length,sha256:sha(row.bytes)}));
 const manifest={schema:'musicbridge.v39.integration002.archive-manifest.v1',task:authority.V39_INTEGRATION_TASK,profile,sourceSha:source,head,
  cachePolicy:'DECLARED_POSITIVE_FILES_ONLY',completeDeclaredProfile:true,missingDeclaredFiles:[],files,expandedBytes:records.reduce((n,row)=>n+row.bytes.length,0)};
 const manifestRaw=Buffer.from(JSON.stringify(manifest,null,2)+'\n'),all=[...records,{path:'archive-manifest.json',bytes:manifestRaw}],zip=storedZip(all);
 // 真正逐成员读取本次受控完整store ZIP、核local header/长度/CRC，不能拿claimed CRC代替原件。
 let at=0;const members=[];for(const row of all){assert.equal(zip.readUInt32LE(at),0x04034b50);const length=zip.readUInt32LE(at+18),nameSize=zip.readUInt16LE(at+26);
  assert.equal(zip.subarray(at+30,at+30+nameSize).toString(),row.path);const raw=zip.subarray(at+30+nameSize,at+30+nameSize+length);
  assert.deepEqual(raw,row.bytes);assert.equal(crc32(raw),zip.readUInt32LE(at+14));members.push({path:row.path,bytes:raw.length,sha256:sha(raw),crc32:crc32(raw)});at+=30+nameSize+length;}
 originalArtifactRecords.set(sha(zip),records.map(row=>({path:row.path,bytes:Buffer.from(row.bytes)})));
 return {id,name,zip:{path:'controlled-'+id+'.zip',bytes:zip.length,sha256:sha(zip)},members,allMembersBytesAndCrcRead:true,
  expandedBytes:all.reduce((n,row)=>n+row.bytes.length,0),archiveManifest:{entry:'archive-manifest.json',rawBase64:manifestRaw.toString('base64')},
  ...(toolContent?{toolContent}:{}),auxiliaryContents,controlledWholeZipBytes:zip};}
export function toolFixture(source,phase='source',head=source,snapshot){
 const original=sourceFixture(),admission=snapshot??fixtureAdmission();
 const input=admission.sourcePins.find(row=>row.path.endsWith('.ts'))??admission.sourcePins[0],before={identity:{...admission.identity,head,parent:phase==='source'?authority.V39_INTEGRATION_SOURCE_PARENT:source},
  admission:{...admission,headAtAdmission:head,repairRole:phase},currentFiles:admission.currentPins,productInputs:[input],originalTests:CI_REPORT_MIRROR_ORIGINAL_TESTS.map(row=>({...row,mode:'100644'}))};
 const reader={currentWorkerIndependentlyVerified:true,sourceInputsIndependentlyMatchedToActualGit:1,receipt:{sourceInputs:[{path:input.path,bytes:input.bytes,sha256:input.sha256}]}};
 const standardRaw=Buffer.concat([Buffer.from('fresh-contracts-compiler\nfresh-core-compiler\nfresh-fixed-metadata-worker\nelectron-vite build\nbuilt in\n'),
  ...Array.from({length:4},(_v,i)=>tinyTap(['控制合成包'+i]))]);
 const standard={schema:'musicbridge.v39.integration002.standard-verification.v1',status:'PASSED_CURRENT_SOURCE_STANDARD_VERIFICATION',sourceSha:source,
  scopeSha256:admission.scopeSha256,verifyExit:0,teeExit:0,pipelineNaturallyEnded:true,before,after:before,raw:{bytes:standardRaw.length,sha256:sha(standardRaw)},freshReader:reader};
 const names={ 'original-173':Array.from({length:173},(_v,i)=>'CONTROLLED_FAKE_original_'+i),
  'authority-safety':[...authority.V39_INTEGRATION_ADMISSION_CASE_NAMES,...authority.V39_INTEGRATION_REPORT_CASE_NAMES,...authority.V39_INTEGRATION_ARTIFACT_CASE_NAMES],
  'gate-safety':authority.V39_INTEGRATION_GATE_CASE_NAMES,'current-composition':['CONTROLLED_FAKE_current_composition']};
 const stageNames=['original-173','authority-safety','gate-safety',...(phase==='source'?['current-composition']:[]),'control-plane','boundaries','cycles'];
 const captures=stageNames.map(name=>fakeStage(name,names[name]??null,phase==='report'&&name==='gate-safety'?3:0));
 const rows=JSON.parse(readFileSync(path.join(original.directory,authority.V39_INTEGRATION_MATRIX_PATH))).rows.map(row=>({id:row.id,evidenceRefs:[{domain:'current-composition',caseName:'CONTROLLED_FAKE_current_composition'}]}));
 const feature={schema:'musicbridge.v39.integration002.feature-proof.v1',task:authority.V39_INTEGRATION_TASK,sourceSha:source,role:phase,rows,
  matrixPin:admission.sourcePins.find(row=>row.path===authority.V39_INTEGRATION_MATRIX_PATH),historical35And9NotPromotedByToolCount:true};
 const actualBefore=phase==='source'?{...before,freshReader:reader}:before;
 const summary=buildV39Integration002GateSummary({sourceBefore:actualBefore,sourceAfter:actualBefore,stages:captures.map(row=>row.record),featureProof:feature,
  freshReader:phase==='source'?reader:null,standardVerification:phase==='source'?standard:null,startedAtMs:1,finishedAtMs:2,durationMs:1,
  temporaryCleanup:{ownedFreshTemporaryRoot:true,allStageProcessesPhysicallyClosed:true,removed:true,sourceAndEvidenceNeverDeleted:true}});
 const records=[{path:'summary.json',bytes:Buffer.from(JSON.stringify(summary,null,2)+'\n')},{path:'source-before.json',bytes:Buffer.from(JSON.stringify(actualBefore)+'\n')},
  {path:'source-after.json',bytes:Buffer.from(JSON.stringify(actualBefore)+'\n')},{path:'feature-proof.json',bytes:Buffer.from(JSON.stringify(feature)+'\n')},
  ...captures.flatMap(row=>[{path:row.record.name+'.json',bytes:Buffer.from(JSON.stringify(row.record)+'\n')},{path:row.record.name+'.stdout.log',bytes:row.stdout},{path:row.record.name+'.stderr.log',bytes:row.stderr}]),
  ...(phase==='source'?[{path:'fresh-reader.json',bytes:Buffer.from(JSON.stringify(reader)+'\n')},{path:'verify.log',bytes:standardRaw},{path:'standard-verification.json',bytes:Buffer.from(JSON.stringify(standard)+'\n')}]:[])];
 return {summary,records,toolContent:authority.encodeV39Integration002ToolContent(records,phase)};}
/** 只有codec/闭集的受控原件形状；不会运行Native或签发实际媒体/Source资格。 */
export function cueInputFixture(evidencePin,bundles){
 const zero={readers:0,writers:0,resources:0},source=evidencePin('cue-input/inputs/CONTROLLED_FAKE_source.wav','CONTROLLED_FAKE_SOURCE'),operations=[];
 const rawRef=(label)=>{const stdout=evidencePin('cue-input/'+label+'/run.stdout.log',''),stderr=evidencePin('cue-input/'+label+'/run.stderr.log','');
  return {...evidencePin('cue-input/'+label+'/run.json',JSON.stringify({stdout,stderr,exitCode:label.startsWith('bad-input')?1:0,signal:null,pid:1,pidClosed:true,fixture:'CONTROLLED_FAKE_NOT_NATIVE_EXECUTION'})),stdout,stderr};};
 const operation=(label,origin,raw)=>({label,...(raw?{raw}:{}),sourceBefore:origin,sourceAfter:origin,fdsClosed:true,namespaceState:'released',actualCombinedResourceSnapshot:zero});
 const specs=[['flac-s24','flac','s24','flac','s32',24],['alac-s24','mov','s24','alac','s32p',24],['mp3-s24','mp3','s24','mp3','fltp',32],
  ['vorbis-s24','ogg','s24','vorbis','fltp',32],['opus-s24','ogg','s24','opus','fltp',32],['wavpack-s24','wv','s24','wavpack','s32p',24],
  ['pcm-wav-s24','wav','s24','pcm_s24le','s32',24],['pcm-aiff-s24','aiff','s24','pcm_s24be','s32',24],
  ...['wav','aiff'].flatMap(kind=>[['s16','s16',16],['s32','s32',32],['f32','flt',32],['f64','dbl',64]].map(([profile,format,bits])=>
   ['pcm-'+kind+'-'+profile,kind,profile==='f64'?'f64-input-only':profile,'pcm_'+profile+(kind==='aiff'?'be':'le'),format,bits])),
  ['same-stem-wav','wav','s24','pcm_s24le','s32',24],['same-stem-flac','flac','s24','flac','s32',24]];
 const pcm=Buffer.alloc(96000*2*4,32),profiles=specs.map(([id,demuxer,profile,codec,sampleFormat,bitsPerSample])=>{
  const original=id==='same-stem-wav'?'pcm-wav-s24':id==='same-stem-flac'?'flac-s24':id;
  const input=evidencePin('cue-input/inputs/'+(id.startsWith('same-stem-')?'同stem_花.'+(demuxer==='wav'?'wav':'flac'):id+'.input'),'CONTROLLED_FAKE_'+original);
  const decoded=evidencePin('cue-input/outputs/'+id+'.s32le',pcm),probe=rawRef(id+'-probe'),decode=rawRef(id+'-decode');
  const lossy=['mp3-s24','vorbis-s24','opus-s24'].includes(id);operations.push(operation(id+'-probe',input,probe),operation(id+'-decode',input,decode));
  return {id,demuxer,profile,input,decoded,expectedFrames:96000,actualFrames:96000,sampleRate:48000,channels:2,codec,sampleFormat,bitsPerSample,
   eof:true,probe,decode,exactPcm:!lossy,snrDb:lossy?40:null,sourceUnchanged:true};});
 const facts={scope:'SYNTHETIC_REAL_INPUT_PROBE_AND_DECODE_ONLY_NOT_APP_OR_OUTPUT_QUALIFICATION',readerMs:3000,sourceBytesLimit:33554432,
  cueManifest:evidencePin('cue-input/cue-manifest.json','受控合成证据'),tagsManifest:evidencePin('cue-input/tags-manifest.json','受控合成证据')};
 for(const [kind,key]of [['cue','cueManifest'],['tags','tagsManifest']])assert.deepEqual({bytes:facts[key].bytes,sha256:facts[key].sha256},{bytes:bundles[kind].manifest.bytes,sha256:bundles[kind].manifest.sha256});
 for(const row of profiles.filter(row=>!row.id.endsWith('-f64')&&!row.id.startsWith('same-stem-'))){const raw=rawRef(row.id+'-prepare');
  facts[row.id+'-preparation']=raw;operations.push(operation(row.id+'-prepare',source,raw));}
 Object.assign(facts,{sevenDemuxersAndEightInputFamiliesPassed:true,float64IsInputDecoderOnly:true,multiFile:{cueSha256:sha(Buffer.from('CONTROLLED_FAKE_CUE')),
  sourceBindings:Array.from({length:3},(_v,i)=>{const media=profiles.find(row=>row.id===(i<2?'same-stem-wav':'same-stem-flac'));
   return {itemId:'cue-item-album-multi-'+(i+1),albumId:'album-multi',sourceAssetId:i<2?'asset-same-stem-wav':'asset-same-stem-flac',
    libraryRootId:'library-cue-input',sourceRootId:'source-cue-input',sourceReadRevision:sha(Buffer.from(JSON.stringify({source:media.input,probe:media.probe,decoded:media.decoded})))};}),
  ranges:[[0,49280,'01 - 第一轨_花.wav'],[49280,46720,'02 - 第二轨.wav'],[1280,94720,'03 - 第三轨.wav']].map(([startFrame,frameCount,outputName])=>({startFrame,frameCount,outputName}))},
  pureGroupBoundaries:{albums:100,tracksPerAlbum:99,completeOutputs:9900,filesLimit:32,acceptedBytes:33552936,rejectedBytes:33562249,executed9900Outputs:false,snapshotBudgetRaised:false},
  closedRefusals:{fakeNativeBrand:true,fakeOutputQualification:true,weakShape:true,alteredRevisions:true,paths:true,nonIndependentTarget:true,actualSameFileTargetRejectedBeforeNativeSpawn:true,originalPreserved:true},
  failedAudioClosedAndNextValidInputRead:true});
 operations.push(operation('same-file-target',source));for(const label of ['bad-input-probe','bad-input-decode','after-failure-valid-probe'])operations.push(operation(label,source,rawRef(label)));
 const physicalClosure={fdsClosed:true,processesClosed:true,claimsReleased:true,actualResourceSnapshot:zero,observedPidsAbsent:53},body={schema:'musicbridge.v39.cue-input-formats.evidence.v1',source,facts,profiles,operations,
  actualOutputEncoderTagQualificationGranted:false,actualSourceQualificationGranted:false,physicalClosure};
 const raw=Buffer.from(JSON.stringify(body,null,2)+'\n'),record={raw:evidencePin('cue-input/input-formats.json',raw),inputDemuxers:['wav','aiff','flac','mp3','ogg','wv','mov'],
  completeInputProfiles:18,actualOutputEncoderTagQualificationGranted:false,physicalClosure};return {raw,record};
}
/** 纯合成固定编码字节＋数学零PCM，仅构造验证器闭集；FD/PID字段是受控负例夹具，不授任何真实Native资格。 */
function rareInputFixture(evidencePin){
 const seeds=[["ape","ape","ape","s16p",88200,"synthetic-silence-44100-s16-stereo.ape","H4sIAAAAAAAC//N1dFaYxs/AYMLAwCABxCwMEMDDgBtcYFdgYGhgYeiIYGRgBPIFGJgYXNYwMAQA2fZC8XuZoeoAbCGXvVwAAAA="],["tta","tta","tta","s16",88200,"synthetic-silence-44100-s16-stereo.tta","H4sIAAAAAAAC/+3QIQ6CAAAF0A/JxCw0LmAgcAQ32GgUAsW7GCk2k9Hmxoxcxet4BIvxvSO8eT53Rcoc02/JuhTZX5/m2ibPU1K9b2MAAAAAAAAAAAAAAPhpOtS1BQAAAAAAAAAAAIB/Gu6XxxdjLklmRFcAAA=="],["mpc7","mpc","musepack7","s16p",88704,"synthetic-zero-bands-sv7.mpc","H4sIAAAAAAAC//MN0Gb3ZcAEDSCCA5MBZDWMRDkAOtRMECgBAAA="],["mpc8","mpc8","musepack8","s16p",88704,"synthetic-zero-bands-sv8.mpc","H4sIAAAAAAAC//MNcPYO9uBTzWsu4mjdysDAIOAYwMIwiknDwa7MAHt+QbFJAQAA"],["tak","tak","tak","s16p",88200,"synthetic-zero-residuals-44100-s16-stereo.tak","H4sIAAAAAAAC/1XKMUgCAQCF4ddBZIYiulVCXLiYRAQZOoW4aLioCEUQtdUSRBg55iApiAQhGMJx4GRCi4MITkGb1NpWS1NTgzRZQ8P9b/rhexeJo90Zj2T4zIK0k5l31+3k3IJUNCStSLlB8C80tQznSe/3Zf0v0phMLTf0ebkN9UN7dyPoIrTmt6Am9KryAw1DD/UJ3YRu3TxB49CA9w2agL7al9A0dBI6gWah7Yc0dB86XMtDj6GpkQd6Cj2LBaDn0NnHDWgJurq9Dr2Gljpf0Cr0wPyG3kKj3RdoC+qLjKE29GPQhHalisvhe0t9h/8C9tg/hr4CAAA="]];
 const labels=['source-probe','source-decode','flac-encode','tags-write','tags-read','flac-probe','flac-decode'];
 const tags={TITLE:'合成冷门编码静音：雪と花',ARTIST:'合成艺术家 Δ',ALBUM:'独立FLAC回退：测试',DATE:'2026',DISCNUMBER:'2',TRACKNUMBER:'3',
  LYRICS:'[00:00.00]中文歌词\n[00:00.25]日本語の歌詞\n',PICTURE:'5e3d382db4dd83d59aa5742793ad6b7903409e865c83bcbc54835049f043bc15'};
 const stat=(bytes,ino)=>({dev:'1',ino:String(ino),size:String(bytes),mode:'33152',nlink:'1',uid:'501',gid:'20',mtimeNs:'1',ctimeNs:'1'});
 return seeds.map(([id,demuxer,codec,sampleFormat,frames,file,gzip],index)=>{
  const prefix='cue/rare-inputs/'+id+'/',input=evidencePin(prefix+file,gunzipSync(Buffer.from(gzip,'base64'))),sourceStat=stat(input.bytes,100+index);
  const pcm=Buffer.alloc(frames*8),oracle=evidencePin(prefix+'oracle-zero.s32le',pcm),decoded=evidencePin(prefix+'source-decoded.s32le',pcm),outputDecoded=evidencePin(prefix+'flac-decoded.s32le',pcm);
  const output=evidencePin(prefix+'独立回退.flac','CONTROLLED_FAKE_FLAC_OUTPUT'),beforeTags=evidencePin(prefix+'flac-before-tags.flac','CONTROLLED_FAKE_FLAC_BEFORE');
  const operations=labels.map((label,i)=>{const original=i<3?input:label==='tags-write'?beforeTags:output,after=i<3?input:output;
   const stdout=evidencePin(prefix+label+'.stdout.log','CONTROLLED_FAKE_NOT_NATIVE_EXECUTION'),stderr=evidencePin(prefix+label+'.stderr.log','');
   const raw={...evidencePin(prefix+label+'.json',JSON.stringify({exitCode:0,signal:null,pid:index*7+i+1,pidClosed:true,stdout,stderr})),stdout,stderr};
   return {label,exitCode:0,signal:null,pid:index*7+i+1,pidClosed:true,pidObservedAbsent:true,raw,freshSourceFd:true,sourceFdClosed:true,
    actorFdsClosed:label.startsWith('tags-')?true:null,sourceBefore:original,sourceAfter:after,
    sourceStatBefore:i<3?sourceStat:stat(original.bytes,200+index),sourceStatAfter:i<3?sourceStat:stat(after.bytes,200+index)};});
  const fdChecks=[...labels.map(label=>label+'-source'),'source-anchor','source-decoded-target','flac-target','flac-decoded-target'].map((label,i)=>({label,fd:i,error:'EBADF'}));
  const closure={fdsClosed:true,processesClosed:true,claimsReleased:true,revokedClaimsRejected:true,fdChecks,observedPidsAbsent:7,
   actorSnapshots:{cue:{closing:true,running:0,unverified:0,pids:[]},tags:{closing:true,running:0,unverified:0,pids:[]}}};
  const physicalClosure={...closure,raw:evidencePin(prefix+'closure.json',JSON.stringify(closure))};
  const body={id,demuxer,codec,sampleFormat,bitsPerSample:16,expectedFrames:frames,decodedFrames:frames,eof:true,sampleRate:44100,channels:2,
   input,inputAfter:input,sourceStatBefore:sourceStat,sourceStatAfter:sourceStat,sourceUnchanged:true,
   oracle:{...oracle,encoding:'s32le',origin:'mathematical-synthetic-zero-pcm',nativeDecoded:false},decoded,exactPcm:true,output,outputDecoded,
   flac:{format:'flac',profile:'s24',codec:'flac',sampleFormat:'s32',bitsPerSample:24,frames,decodedFrames:frames,sampleRate:44100,channels:2,eof:true,exactPcm:true},
   tagsExpected:tags,tagsActual:tags,operations,physicalClosure};
  return {...body,raw:evidencePin(prefix+'proof.json',JSON.stringify({schema:'musicbridge.v39.cue-rare-input.evidence.v1',...body}))};
 });
}
/** 504正文的受控消费者夹具；全部FD/PID/线程/SQL为数据，不运行或授予Native/Owner资格。 */
function cueNormalOwnerFixture(original,evidencePin){
 const prefix='cue-normal-scan-owner504/',root='/Volumes/LifeWeave/Developer/CommandLine/tmp/CONTROLLED_FAKE_NATIVE/',core=root+'repository/packages/bridge-core',
  uuid=index=>'00000000-0000-4000-8000-'+String(index).padStart(12,'0'),datasetId=uuid(1),epoch=uuid(2),zero={readers:0,writers:0,resources:0},
  json=(name,value)=>evidencePin(prefix+name,JSON.stringify(value,null,2)+'\n'),hash=value=>sha(Buffer.from(JSON.stringify(sorted(value)))),
  sorted=value=>Array.isArray(value)?value.map(sorted):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,sorted(value[key])])):value,
  pinShape=bytes=>({bytes:Buffer.byteLength(bytes),sha256:sha(Buffer.from(bytes))}),stat=(bytes,ino)=>({dev:'1',ino:String(ino),size:String(bytes),mode:'33152',nlink:'1',uid:'501',gid:'20',mtimeNs:'1',ctimeNs:'1'});
 const sourceProof=json('case1-source-proof.json',original),sourceNames=[
  'collection/dataset-owner-worker','collection/dataset-owner-client','collection/dataset-domain','collection/source-writes-authority','collection/repository','recording/backup-workflow-store','stream/physical-resource-locks',
  'recording/source-files','library/metadata-reader','library/metadata-reader-worker','library/metadata-reader-types','library/cue-sidecar-reader','library/cue-sidecar-worker'];
 const sourceInputs=[...sourceNames.map(name=>({path:'packages/bridge-core/src/'+name+'.ts',...pinShape('CONTROLLED_FAKE_SOURCE_'+name)})),{path:'scripts/ci/run-core-tests.mjs',...pinShape('CONTROLLED_FAKE_RUNNER')}],
  stages=['fresh-contracts-compiler','fresh-core-compiler','fresh-fixed-metadata-worker'].map((name,index)=>({name,compilerExit:0,startedMs:1000+index*10,finishedMs:1005+index*10})),
  outputs=[...sourceInputs.filter(row=>row.path.endsWith('.ts')).flatMap(row=>['.js','.js.map','.d.ts'].map(suffix=>({path:row.path.replace('/src/','/dist/').slice(0,-3)+suffix,
    ...pinShape('CONTROLLED_FAKE_COMPILED_'+row.path+suffix),sourcePath:row.path,sourceSha256:row.sha256,mtimeMs:1012}))),
   ...['.mjs','.mjs.map','.meta.json','.build.json'].map(suffix=>({path:'packages/bridge-core/dist/library/metadata-reader-worker.bundle'+suffix,...pinShape('CONTROLLED_FAKE_FIXED_'+suffix),mtimeMs:1022}))],
  preparation={schema:'core-test.reader-preparation.v1',status:'FRESH_READER_PREPARED',sourceInputs,
   toolInputs:['bin/tsc','package.json','lib/tsc.js','lib/_tsc.js'].map(file=>({file:root+'node_modules/typescript/'+file,...pinShape('CONTROLLED_FAKE_TOOL_'+file)})),outputs,stages,
   readerBindingSha256:sha(Buffer.from('CONTROLLED_FAKE_ORIGINAL_READER_BINDING')),inputsUnchanged:true,outputsUnchanged:true},
  originalPreparationReceipt={path:root+'preparation/preparation-receipt.json',...pinShape(JSON.stringify(preparation,null,2)+'\n')},
  binding=(schema,names)=>({schema,compilerExit:0,compilerStartedAtMs:1000,compilerFinishedAtMs:1025,timeBasis:'fresh-native-preparation-run',sourceSha:original.sourceSha,scopeSha256:original.scopeSha256,
   originalPreparationReceipt,originalSingleCompilerIntervalsRetained:true,
   sourceInputs:names.map(file=>({file,...(({path:_path,...pin})=>pin)(sourceInputs.find(row=>row.path==='packages/bridge-core/'+file))})),
   outputs:names.flatMap(file=>['.js','.js.map'].map(suffix=>{const name=file.replace(/^src\//u,'dist/').slice(0,-3)+suffix,row=outputs.find(row=>row.path==='packages/bridge-core/'+name);return {file:name,bytes:row.bytes,sha256:row.sha256};}))}),
  readerBinding={...binding('mbrs003.reader.fresh-build.v2',['src/recording/source-files.ts','src/library/metadata-reader.ts','src/library/metadata-reader-worker.ts','src/library/metadata-reader-types.ts']),
   fixedWorkerBundle:{schema:'mbrs003.metadata-worker.fixed-bundle.v2',startedAtMs:1020,finishedAtMs:1024}},
  cueBinding=binding('mbrs003.cue.fresh-build.v1',['src/library/cue-sidecar-reader.ts','src/library/cue-sidecar-worker.ts']),
  currentBuild=json('current-core-binding.json',{readerBinding,cueBinding,preparation,currentOutputs:outputs.map(({path,bytes,sha256})=>({path,bytes,sha256}))});
 const urls={worker:'file://'+core+'/dist/collection/dataset-owner-worker.js',domain:'file://'+core+'/dist/collection/dataset-domain.js',locks:'file://'+core+'/dist/stream/physical-resource-locks.js'},
  ownerEntry=evidencePin(prefix+'actual-owner-entry.mjs','// CONTROLLED_FAKE_VALIDATOR_ONLY_NEVER_EXECUTED\nconst urls = '+JSON.stringify(urls)+';\n'
   +'attachDatasetOwnerWorkerPort(parentPort, { async prepare() { assert.equal(++factoryCount, 1); const domain = await prepareOwnedDatasetDomain({testMode: false}); await originalClose(); } });\n');
 const families=['vorbis','opus','wavpack','ape','tta','mpc7','mpc8','tak'],inputs=families.map((id,index)=>{
  const origin=['vorbis','opus','wavpack'].includes(id)?original.formats.find(row=>row.id===id).output:original.rareInputs.find(row=>row.id===id).input,
   copy={...origin,path:prefix+'原中文音乐库/正常源-'+id+'/原音频'+path.extname(origin.path)},name=path.posix.basename(copy.path),
   cue=evidencePin(path.posix.dirname(copy.path)+'/原索引.cue','TITLE "正常源-'+id+'"\nPERFORMER "自有艺术家 Δ"\nFILE "'+name+'" WAVE\n  TRACK 01 AUDIO\n    TITLE "第一曲：雪"\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    TITLE "第二曲：花"\n    INDEX 01 00:00:15\n');
  return {id,input:origin,copy,cue,copyStat:stat(copy.bytes,100+index),cueStat:stat(cue.bytes,200+index)};});
 // 只复用受控fixture的原字节，不从魔数或数学oracle签发真实decoder成功。
 // evidencePin的同一Map由auxiliaryFixture持有；参数第三实参从原pin取完整受控字节。
 for(const row of inputs)evidencePin(row.copy.path,evidencePin.read(row.input.path));
 const inputRaw=json('original-copy-inputs.json',inputs),flights=[],events=[],results=[],verification=[],pcmVerification=[],directoryRequests=[],directoryFdChecks=[];
 const physicalPath=absolute=>({path:absolute,dev:'1',ino:String(1000+directoryFdChecks.length),birthtimeNs:'1',mode:'16832',uid:'501',gid:'20'}),ui=(family,command,payload,commandId)=>({family,command,commandId,requestSha256:hash({command,payload})}),
  directory=(kind,choiceId,absolute,currentUi)=>{const binding={datasetId,ownerEpoch:epoch,childGeneration:1,kind,choiceId,revision:sha(Buffer.from(choiceId)),issuedAtMs:2000,expiresAtMs:602000,
   originalUi:ui(kind==='library'?'management':'workbench',kind==='library'?'library.import.prepare':'localWorkbench.cue.target',{},null)};
   directoryRequests.push({version:1,type:'workbench-directory-request',purpose:'WORKBENCH_DIRECTORY',requestId:uuid(500+directoryRequests.length),sequence:directoryRequests.length+1,authorityId:uuid(3),command:'approve',binding,ui:currentUi,expiresAtMs:4000});
   directoryFdChecks.push({choiceId,physical:physicalPath(absolute),error:'EBADF'});return binding;},
  flight=(command,payload,value)=>{const row={command,payload,value,elapsedMs:1};flights.push(row);if(!command.startsWith('library.'))events.push({command,began:3000+events.length*2,finished:3001+events.length*2});return row;};
 flight('library.import.prepare',{}, {choiceId:uuid(4)});const confirm={commandId:uuid(5),choiceId:uuid(4),role:'catalog'};
 flight('library.import.confirm',confirm,{state:'succeeded',libraryIds:[uuid(6)]});directory('library',uuid(4),root+prefix+'原中文音乐库',ui('management','library.import.confirm',confirm,confirm.commandId));
 flight('library.capture',{libraryIds:[uuid(6)]},{libraryIds:[uuid(6)]});flight('library.albums.capture',{albums:[]},{albums:[]});flight('capabilities.read',{}, {capabilities:{'cue-preview':{available:true}}});
 const rows={local_catalog_roots:[{id:uuid(6),source_root_id:uuid(7),data:JSON.stringify({id:uuid(6),sourceRootId:uuid(7),role:'library',revision:'1'})}],local_catalog_assets:[],local_catalog_tracks:[],local_scan_jobs:[{
  id:uuid(8),dataset_id:datasetId,library_root_id:uuid(6),source_root_id:uuid(7),parser_version:'cue-input-scan/v39-v1',data:JSON.stringify({schemaVersion:'1.2',jobId:uuid(8),datasetId,libraryRootId:uuid(6),sourceRootId:uuid(7),rootRevision:'1',jobRevision:'3',checkpointRef:uuid(10),failureCode:null,phase:'completed',progress:{visited:'16',accepted:'16',rejected:'0'}})}],
  local_scan_file_state:[],local_cue_sources:[],local_cue_tracks:[],local_catalog_ledger:[]};
 let eventSerial=700;
 for(const [index,id]of families.entries()){
  const input=inputs[index],spec=['vorbis','opus','wavpack'].includes(id)?original.formats.find(row=>row.id===id):original.rareInputs.find(row=>row.id===id),
   rate=spec.sampleRate,frames=spec.expectedFrames,expectedOutput=index<3?id:'flac',source=root+input.copy.path,outputDirectory=root+prefix+'独立分轨-'+id,
   albumId=uuid(20+index),assetId=uuid(30+index),trackId=uuid(40+index),cueId=uuid(50+index),target={choiceId:uuid(60+index),label:'自有独立输出-'+id,independent:true},
   member={trackId,assetId,fileName:path.posix.basename(input.copy.path),title:null,artist:null,album:null,rootRevision:'1',fileRevision:'1',locationRevision:'1',metadataRevision:'1'},
   album={albumId,readToken:uuid(70+index),revision:'1',rootId:uuid(6),directoryId:uuid(80+index),editionId:null,artistName:'自有艺术家 Δ',albumName:'正常源-'+id,directoryName:'正常源-'+id,manualLocks:{artistName:false,albumName:false},members:[member]},
   assetReference={assetId,libraryRootId:uuid(6),sourceRootId:uuid(7),rootRevision:'1',fileRevision:'1',locationRevision:'1'},
   tracks=[0,1].map(n=>({itemId:'cue-item-'+albumId+'-'+(n+1),albumId,label:n?'第二曲：花':'第一曲：雪',changes:[],sequence:n+1,sourceLabel:member.fileName,
    startFrame:n?rate/5:0,frameCount:n?frames-rate/5:rate/5,sampleRate:rate,outputName:(n+1)+' - 合成_'+id+'.'+({vorbis:'ogg',opus:'opus',wavpack:'wv',flac:'flac'})[expectedOutput],outputFormat:expectedOutput})),
   capture={datasetId,datasetRevision:'1',albums:[album],cueSheets:[{cueId,revision:'1',albumId}],cueOutputs:tracks.map(track=>({itemId:track.itemId,albumId,sourceAssetId:assetId,libraryRootId:uuid(6),sourceRootId:uuid(7),sourceReadRevision:'1'})),
    audio:[{assetReference,sourceLabel:member.fileName,evidence:'audio-pcm-read',readRevision:'1',sampleRate:rate,totalPcmFrames:frames}],target:{...target,revision:sha(Buffer.from(target.choiceId))},
    format:{formatId:expectedOutput,revision:'1',codec:expectedOutput,extension:path.extname(tracks[0].outputName),lossless:index>1,evidence:'encoder-tag-audio-roundtrip',available:true}},
   draft={kind:'cue',scope:'INDEPENDENT_OUTPUT',albumIds:[albumId],state:'ready',blockers:[],items:tracks.map(({itemId,albumId,label,changes})=>({itemId,albumId,label,changes})),sourceDisposition:'retain',target,tracks},
   plan={...draft,datasetId,planId:uuid(90+index),revision:'1',contextFingerprint:hash(capture),expiresAt:new Date(603000).toISOString()};plan.planHash=hash(plan);
  const request={commandId:uuid(100+index),datasetId,planId:plan.planId,kind:'cue',expectedRevision:plan.revision,planHash:plan.planHash,contextFingerprint:plan.contextFingerprint},
   receipt={commandId:request.commandId,datasetId,planId:plan.planId,planHash:plan.planHash,state:'succeeded',items:plan.items.map(item=>({...item,state:'applied',message:null})).map(({changes:_changes,...item})=>item),message:null},
   outputs=tracks.map(track=>evidencePin(prefix+'独立分轨-'+id+'/'+track.outputName,'CONTROLLED_FAKE_NOT_NATIVE_OUTPUT_'+track.outputName)),
   prepared={draft,capture},preview={request:{datasetId,captures:[{albumId,readToken:album.readToken}],cueSelections:[{albumId,cueId}],outputFormat:'auto',target,sourceDisposition:'retain'},target:{target,revision:capture.target.revision}};
  flight('read.resolveCapture',{datasetId,capture:{albumId,readToken:album.readToken}},{datasetId,capture:album,directoryFacts:{files:[{currentRelative:input.copy.path.slice((prefix+'原中文音乐库/').length)}]}});
  flight('cue.preparePreview',preview,prepared);flight('registry.issuePlan',prepared,plan);flight('registry.apply',request,{...receipt,state:'running',items:receipt.items.map(row=>({...row,state:'unknown'}))});flight('registry.readOriginalReceipt',request,receipt);
  directory('cue',target.choiceId,outputDirectory,ui('workbench','localWorkbench.cue.preview',preview.request,null));
  results.push({id,source,demuxer:({vorbis:'ogg',opus:'ogg',wavpack:'wv',mpc7:'mpc',mpc8:'mpc8'})[id]??id,outputDirectory,expectedOutput,request,plan,capture,receipt,outputs});
  const relativeName=input.copy.path.slice((prefix+'原中文音乐库/').length),reference={...assetReference,relative:relativeName,signature:'CONTROLLED_FAKE_SIGNATURE'},cueTracks=[0,1].map(n=>({trackNumber:n+1,fileOrdinal:1,assetReference:reference,timebase:'cue-cd-frames',framesPerSecond:75,index00Frames:null,index01Frames:n?15:0,endFrames:null,evidence:'cue-text-declared',playback:'NOT_VERIFIED'}));
  rows.local_catalog_assets.push({id:assetId,root_id:uuid(6),source_root_id:uuid(7),relative:relativeName,sha256:null,data:JSON.stringify({id:assetId,libraryRootId:uuid(6),sourceRootId:uuid(7),rootRevision:'1',fileRevision:'1',locationRevision:'1',sampleFrames:null,timebaseHz:null})});
  rows.local_catalog_tracks.push({id:trackId,asset_id:assetId,data:JSON.stringify({id:trackId,assetId,selectionRevision:'1',segment:null})});
  const fact={libraryRootId:uuid(6),relative:relativeName,signature:'CONTROLLED_FAKE_SIGNATURE',parserVersion:['tta','tak'].includes(id)?'musicbridge-cue-header/mbrs003-v1':'music-metadata-11.15.0/mbrs003-v4',
   outcome:'accepted',assetId,trackId,failureCode:null,readFacts:{technical:{container:({vorbis:'OGG',opus:'OGG',wavpack:'WAVPACK',ape:'APE',tta:'TTA',mpc7:'MPC',mpc8:'MPC',tak:'TAK'})[id],codec:id,evidence:'bounded-parser-reported'},
    coverEvidence:[],readEvidence:{bytesRead:64,readCalls:1,maxReadBytes:64,allocationBytes:64,elapsedMs:1,wholeAudioHash:false,wholeAudioDecode:false}}};
  rows.local_scan_file_state.push({library_root_id:uuid(6),relative:relativeName,job_id:uuid(8),batch_id:uuid(9),asset_id:assetId,track_id:trackId,data:JSON.stringify(fact)});
  rows.local_cue_sources.push({id:cueId,sidecar_id:uuid(200+index),library_root_id:uuid(6),relative:input.cue.path.slice((prefix+'原中文音乐库/').length),batch_id:uuid(9),data:JSON.stringify({id:cueId,libraryRootId:uuid(6),sourceRootId:uuid(7),item:{outcome:'accepted',result:{status:'ok',tracks:cueTracks}}})});
  rows.local_cue_tracks.push(...cueTracks.map((track,n)=>({snapshot_id:cueId,ordinal:n+1,asset_id:assetId,data:JSON.stringify(track)})));
  const outputRecord={schema:1,request,revision:0,phase:'succeeded',outputRoot:{id:uuid(300+index),path:outputDirectory,dev:'1',ino:'1',authorized:true,label:'受控合成目标'},stageDirectory:'stage-'+request.commandId,
   staged:tracks.map((track,n)=>({itemId:track.itemId,outputName:track.outputName,stageName:'stage-'+n,bytes:outputs[n].bytes,sha256:outputs[n].sha256,dev:'1',ino:String(n+1)})),published:tracks.map(track=>track.itemId),physicalClosed:true,receipt},
   recordRaw=Buffer.from(JSON.stringify(sorted(outputRecord))),common={datasetId,transactionId:uuid(400+index),commandId:request.commandId,expectedRevision:null,revision:0,bytes:recordRaw.length,sha256:sha(recordRaw),chunks:Math.ceil(recordRaw.length/32768)};
  const append=event=>{const raw=JSON.stringify(sorted(event)),fingerprint=sha(Buffer.from(raw));rows.local_catalog_ledger.push({command_id:event.eventId,operation:'local-cue-output-v1',fingerprint,request:raw,result:JSON.stringify(sorted({eventId:event.eventId,eventHash:fingerprint})),created_at:new Date(3000).toISOString()});};
  for(let n=0;n<common.chunks;n++)append({...common,eventId:uuid(eventSerial++),kind:'chunk',index:n,payload:recordRaw.subarray(n*32768,(n+1)*32768).toString('base64')});append({...common,eventId:uuid(eventSerial++),kind:'commit'});
  const rawRun=(name,stdout)=>{const out=evidencePin(prefix+name+'.stdout.log',stdout),err=evidencePin(prefix+name+'.stderr.log',''),raw=json(name+'.json',{exitCode:0,signal:null,pid:2000+verification.length,pidClosed:true,stdout:out,stderr:err});verification.push({...raw,stdout:out,stderr:err});};
  rawRun(id+'-source-decode','');for(const track of tracks){rawRun(id+'-track'+track.sequence+'-probe','frame|nb_samples='+track.frameCount+'\nstream|codec_name='+expectedOutput+'|sample_rate='+rate+'|channels=2|sample_fmt='+(expectedOutput==='flac'?'s32':'fltp')+'|bits_per_raw_sample='+(expectedOutput==='flac'?'24':'0')+'\n');rawRun(id+'-track'+track.sequence+'-decode','');}
  const sourcePcm=Buffer.alloc(frames*8,index<3?64:0);pcmVerification.push({id,sampleRate:rate,channels:2,source:evidencePin(prefix+id+'-source.s32le',sourcePcm),
   tracks:tracks.map((track,n)=>({sequence:track.sequence,startFrame:track.startFrame,frameCount:track.frameCount,outputAudio:outputs[n],decoded:evidencePin(prefix+id+'-track'+track.sequence+'.s32le',sourcePcm.subarray(track.startFrame*8,(track.startFrame+track.frameCount)*8))}))});
 }
 const read=flights.find(row=>row.command==='library.albums.capture');read.payload.albums=results.map(row=>({albumId:row.plan.albumIds[0],rootId:uuid(6),revision:'1'}));
 read.value.albums=results.map(row=>({album:{albumId:row.plan.albumIds[0],rootId:uuid(6)},capture:{albumId:row.plan.albumIds[0],readToken:row.capture.albums[0].readToken},availability:'online',cueSheets:[{cueId:row.capture.cueSheets[0].cueId,eligible:true}]}));
 const registry={schemaVersion:1,datasetId,revision:1,entries:results.map(row=>({plan:row.plan,capture:row.capture,original:row.request,receipt:row.receipt,cancellation:null}))},registryRaw=Buffer.from(JSON.stringify(sorted(registry))),
  common={datasetId,transactionId:uuid(600),expectedRevision:0,revision:1,snapshotHash:sha(registryRaw),bytes:registryRaw.length,chunks:Math.ceil(registryRaw.length/12288)},
  appendRegistry=event=>{const raw=JSON.stringify(sorted(event)),fingerprint=sha(Buffer.from(raw));rows.local_catalog_ledger.push({command_id:event.eventId,operation:'local-workbench-v1',fingerprint,request:raw,result:JSON.stringify(sorted({eventId:event.eventId,eventHash:fingerprint})),created_at:new Date(3000).toISOString()});};
 for(let index=0;index<common.chunks;index++)appendRegistry({...common,eventId:uuid(eventSerial++),kind:'snapshot-chunk',index,payload:registryRaw.subarray(index*12288,(index+1)*12288).toString('base64')});appendRegistry({...common,eventId:uuid(eventSerial++),kind:'snapshot-commit'});
 const authorInitializationFiles=Array.from({length:15},(_v,index)=>{const name=index<5?'rare-inputs/'+families[index+3]+'/proof.json':'CONTROLLED_FAKE-'+index+'.json';
  return evidencePin(prefix+'唯一Owner资料/safety/lyrics-native/cue-qualification-'+epoch+'/cue/'+name,'CONTROLLED_FAKE_FACTORY_BODY_NOT_NATIVE');});
 const ownerRaw={schema:'musicbridge.v39.cue-normal-owner504.raw.v1',testMode:false,factoryCount:1,ownerThreadId:1,factoryStartedNativeProcesses:1,sourcePortClosed:true,parentPortClosed:true,repositoryClosed:true,physical:zero,sqlRows:rows,
  fds:[{serial:1,path:root+'CONTROLLED_FAKE.fd',fd:3,phase:'production-owner-ready',closed:true,error:'EBADF'}],
  processes:['owner-native-first-prepare','registry.apply:'+results[0].request.commandId].map((phase,index)=>({pid:index+1,executable:root+'fixed/bin/ffmpeg',args:['-fd','3','fd:'],phase,closed:true,exitCode:0,signal:null,stdout:'',stderr:'',pidAbsent:true,groupAbsent:true})),
  readerWorkers:Array.from({length:16},(_v,index)=>({entry:core+'/dist/library/'+(index<8?'metadata-reader-worker.bundle.mjs':'cue-sidecar-worker.js'),threadId:index+2,execArgv:[],exitObserved:true,exitCode:0})),
  phaseEvents:[{phase:'owner-native-first-prepare',began:2000,finished:2001,datasetId,epoch,actualFactoryNativeProcesses:1},...events],authorInitializationFiles,
  observations:'只包装真实open/close/spawn并返回原对象，不替Native/Reader/prepare ACK。'},
  owner={raw:json('actual-owner-raw.json',ownerRaw),stdout:evidencePin(prefix+'owner.stdout.log',''),stderr:evidencePin(prefix+'owner.stderr.log',''),exitCode:0},
  summary={schema:'musicbridge.v39.cue-normal-scan-owner504.evidence.v1',sourceSha:original.sourceSha,scopeSha256:original.scopeSha256,caseName:authority.V39_INTEGRATION_NATIVE_CASE_NAMES[2][0],domain:'native',sourceProof,currentBuild,ownerEntry,inputs:inputRaw,owner,
   originalCaptureScope:'8完整专辑/8物理成员/8真实CUE/16声明轨；非Electron Main资格',flights,results,verification,pcmVerification,directoryRequests,directoryFdChecks,producerErrors:[],cold:{nativeReinitialized:false,previewOrApply:false,sameDatasetId:datasetId,rows},
   physical:{actualCombinedTable:zero,sourcePortCloseEvents:['main-source'],admission:{permits:0,revoked:0,watches:0,timers:0,closed:true},verifierFdChecks:64},
   qualifier:{inputOrigin:'本次case1真实资格pins',warmOwnerFirstInitialization:'真实默认factory再次完成该新作者mandatory资格，不从JSON恢复WeakSet',crossRunQualification:false}};
 return {raw:json('normal-scan-entry.json',summary),sourceProof,currentBuild,ownerEntry,owner,sourceSha:original.sourceSha,scopeSha256:original.scopeSha256,caseName:summary.caseName,domain:'native',inputFamilies:families,sameDatasetId:datasetId,
  libraryAlbums:8,libraryMembers:8,cueSources:8,outputTracks:16,sourceUnchanged:true,coldReadOnly:true,nativeQualificationReusedAcrossRun:false,physicalClosure:{ownerNaturalExit:true,actualCombinedTable:zero,mainSourcePortClosed:true}};
}

export function auxiliaryFixture(source,scopeHash,kind,snapshot){const evidence=new Map(),evidencePin=(name,text='受控合成证据')=>{const bytes=Buffer.from(text);evidence.set(name,bytes);return {path:name,bytes:bytes.length,sha256:sha(bytes)};};
 evidencePin.read=name=>evidence.get(name);
 const closure={fdsClosed:true,processesClosed:true,claimsReleased:true};let proof,inputRaw;
 if(kind==='native'){
  const bundle=()=>({manifest:evidencePin('bundle/manifest.json'),programs:[evidencePin('bundle/program')],libraries:[evidencePin('bundle/library')],legal:[evidencePin('bundle/COPYING')]});
  const format=(id,profile,encoder)=>({id,profile,encoder,decoder:id,sampleRate:48000,channels:2,input:evidencePin(id+'/'+profile+'/input'),output:evidencePin(id+'/'+profile+'/output'),decoded:evidencePin(id+'/'+profile+'/decoded'),expectedFrames:24000,decodedFrames:24000,eof:true,sourceUnchanged:true,
   tagsExpected:{title:'合成标题'},tagsActual:{title:'合成标题'},encode:{exitCode:0,signal:null,pidClosed:true,raw:{stdout:evidencePin(id+'/'+profile+'/encode.stdout',''),stderr:evidencePin(id+'/'+profile+'/encode.stderr','')}},
   decode:{exitCode:0,signal:null,pidClosed:true,raw:{stdout:evidencePin(id+'/'+profile+'/decode.stdout',''),stderr:evidencePin(id+'/'+profile+'/decode.stderr','')}},physicalClosure:closure,variants:[]});
  const formats=['flac','alac','mp3','vorbis','opus','wavpack','pcm-wav','pcm-aiff'].map(id=>{const pcm=id.startsWith('pcm-'),end=id==='pcm-aiff'?'be':'le';
   const row=format(id,'s24',pcm?'pcm_s24'+end:({flac:'flac',alac:'alac',mp3:'libmp3lame',vorbis:'libvorbis',opus:'libopus',wavpack:'wavpack'})[id]);
   if(pcm)row.variants=['s16','s32','f32'].map(profile=>format(id,profile,'pcm_'+profile+end));return row;});
  proof={schema:'musicbridge.v39.integration002.native-proof.v1',task:authority.V39_INTEGRATION_TASK,sourceSha:source,scopeSha256:scopeHash,platform:'darwin',architecture:'arm64',bundles:{cue:bundle(),tags:bundle()},formats,
   watcher:{stopAcknowledged:true,invalidationVerified:true,fdsClosed:true,invalidationsObserved:1,callbacksAfterStop:0,raw:evidencePin('watcher/events.log')},lyricsProtectedCopy:Object.fromEntries(['wav','flac'].map(kind=>[kind,{input:evidencePin('lyrics/'+kind+'/input'),output:evidencePin('lyrics/'+kind+'/output'),decodedBefore:evidencePin('lyrics/'+kind+'/decoded-before','samePCM'),decodedAfter:evidencePin('lyrics/'+kind+'/decoded-after','samePCM'),expectedFrames:1,decodedFrames:1,audioUnchanged:true,unselectedMetadataUnchanged:true,rereadVerified:true,sourceUnchanged:true,raw:evidencePin('lyrics/'+kind+'/raw.json'),physicalClosure:closure}])),physicalClosure:closure};
  const input=cueInputFixture(evidencePin,proof.bundles);inputRaw=input.raw;proof=authority.bindV39Integration002CueInputProof({...proof,rareInputs:rareInputFixture(evidencePin),cueInputFormats:input.record},inputRaw);
  proof.cueNormalScanEntry=cueNormalOwnerFixture(proof,evidencePin);
 }else proof={schema:'musicbridge.v39.integration002.capacity-proof.v1',task:authority.V39_INTEGRATION_TASK,sourceSha:source,scopeSha256:scopeHash,changedDomains:['controlled-current-query'],
  datasets:[{id:'synthetic',rows:{catalogTracks:1,assets:1,scanFileState:1,relations:1},identity:{bytes:1,sha256:sha(Buffer.from('x'))},synthetic:true}],
  queries:[{id:'cold',datasetId:'synthetic',cold:true,elapsedMs:1,rssBytes:1,requestDeadlineMs:30000,ownerDeadlineMs:2000,completeGroup:{items:1,bytes:1,truncated:false},raw:evidencePin('query.log'),exitCode:0,signal:null}],
  boundaries:[{id:'catalog-301000-rejected',accepted:false,actualLimit:300000},{id:'whole-group-10000-32mib',accepted:true},{id:'small-group-2048-128kib',accepted:true}],preservedFailures:['SQL548_300K_NOT_PASSED'],inheritedEvidence:[],physicalClosure:{fdsClosed:true,workersClosed:true,claimsReleased:true}};
 const tests=kind==='native'?authority.V39_INTEGRATION_NATIVE_TESTS:authority.V39_INTEGRATION_CAPACITY_TESTS,captures=tests.map((_v,i)=>fakeStage('case-'+(i+1),kind==='native'?authority.V39_INTEGRATION_NATIVE_CASE_NAMES[i]:['CONTROLLED_FAKE_'+kind+'_'+i]));
 const before={admission:snapshot,identity:snapshot.identity,currentFiles:snapshot.currentPins,productInputs:snapshot.sourcePins},summary={schema:'musicbridge.v39.integration002.'+kind+'-gate.v1',sourceSha:source,scopeSha256:scopeHash,
  sourceBefore:before,sourceAfter:before,sourceUnchanged:true,passed:true,failureCode:null,stageMs:180000,effectiveCaptureStageMs:90000,wholeMs:kind==='native'?480000:600000,durationMs:1,
  temporaryCleanup:{ownedFreshTemporaryRoot:true,allStageProcessesPhysicallyClosed:true,removed:true,sourceAndEvidenceNeverDeleted:true},stages:captures.map(row=>row.record),proof,
  ...(kind==='native'?{tests:authority.V39_INTEGRATION_NATIVE_TESTS,caseNames:authority.V39_INTEGRATION_NATIVE_CASE_NAMES,registeredTests:11}: {})};
 const records=[{path:'summary.json',bytes:Buffer.from(JSON.stringify(summary)+'\n')},{path:'source-before.json',bytes:Buffer.from(JSON.stringify(before)+'\n')},{path:'source-after.json',bytes:Buffer.from(JSON.stringify(before)+'\n')},
  {path:kind+'-proof.json',bytes:Buffer.from(JSON.stringify(proof)+'\n')},...(kind==='native'?[{path:'cue-input-formats.json',bytes:inputRaw}]:[]),
  ...captures.flatMap(row=>[{path:row.record.name+'.json',bytes:Buffer.from(JSON.stringify(row.record)+'\n')},{path:row.record.name+'.stdout.log',bytes:row.stdout},{path:row.record.name+'.stderr.log',bytes:row.stderr}])];
 const readBody=ref=>evidence.get(ref.path),bodyRefs=kind==='native'?authority.v39Integration002CueNormalScanBodyRefs(proof,readBody):[];
 return {content:authority.encodeV39Integration002AuxiliaryContent([...records,...bodyRefs.map(ref=>({path:'evidence/'+ref.path,bytes:readBody(ref)}))],kind),records:records.map(row=>({...row,path:kind+'/'+row.path})),
  evidence:[...evidence].map(([name,bytes])=>({path:kind+'/evidence/'+name,bytes})),proof};}
export function sourceCiFixture(source=sourceFixture().source){const snapshot=fixtureAdmission(),scopeHash=snapshot.scopeSha256,
 tool=toolFixture(source,'source',source,snapshot),native=auxiliaryFixture(source,scopeHash,'native',snapshot),capacity=auxiliaryFixture(source,scopeHash,'capacity',snapshot);
 const artifacts=[fakeArtifact([...tool.records,...capacity.records,...capacity.evidence],{id:501,name:'verify-'+source,profile:'verify-source',source,toolContent:tool.toolContent,auxiliaryContents:[capacity.content]}),
  fakeArtifact([{path:'rust/compiler.log',bytes:Buffer.from('CONTROLLED_FAKE_linux')}],{id:502,name:'rust-core-ubuntu-latest-'+source,profile:'rust-linux-source',source}),
  fakeArtifact([{path:'rust/compiler.log',bytes:Buffer.from('CONTROLLED_FAKE_macos')}],{id:503,name:'rust-core-macos-latest-'+source,profile:'rust-macos-source',source}),
  fakeArtifact([{path:'host/compiled',bytes:Buffer.from('CONTROLLED_FAKE_host')}],{id:504,name:'rust-host-compiled-'+source,profile:'rust-host-source',source}),
  fakeArtifact([...native.records,...native.evidence],{id:505,name:'electron-e2e-'+source,profile:'electron-source',source,auxiliaryContents:[native.content]})];
 const now=Date.now(),runs=authority.V39_INTEGRATION_WORKFLOWS.map((file,i)=>({id:101+i,path:file,event:'push',run_attempt:1,head_sha:source,head_branch:authority.V39_INTEGRATION_BRANCH,
  status:'completed',conclusion:'success',repository:{id:authority.V39_INTEGRATION_REPOSITORY_ID},created_at:new Date(now-2000).toISOString(),updated_at:new Date(now-1000).toISOString()}));
 let jobId=201;const job=names=>({id:jobId++,head_sha:source,status:'completed',conclusion:'success',name:'CONTROLLED_FAKE_JOB',steps:names.map(name=>({name,status:'completed',conclusion:'success'}))});
 const proofs=runs.map((run,i)=>({runId:run.id,jobs:i===0?[job([authority.V39_INTEGRATION_GUARD_STEP,authority.V39_INTEGRATION_GATE_STEP,authority.V39_INTEGRATION_CAPACITY_STEP,authority.V39_INTEGRATION_UPLOAD_STEP,
  'Verify platform-independent workspace (typecheck, unit tests, build; no Electron)','Validate control plane','Validate security and product boundaries','Scan workspace import cycles']),job([authority.V39_INTEGRATION_GUARD_STEP,'Production dependency audit'])]:
  i===1?[job([authority.V39_INTEGRATION_GUARD_STEP,'Validate machine control state','Run boundary, loopback, secret and URL/query scans','Scan workspace import cycles','Run directed platform-independent security tests (no Electron)'])]:
  i===2?[job([authority.V39_INTEGRATION_GUARD_STEP,'验证实际 Rust 与 TypeScript 边界','保留编译器、测试及源码与二进制清单']),job([authority.V39_INTEGRATION_GUARD_STEP,'验证实际 Rust 与 TypeScript 边界','保留编译器、测试及源码与二进制清单'])]:
  [job([authority.V39_INTEGRATION_GUARD_STEP,'Build and verify both Rust hosts once in this job','Electron startup, crash/restart, safeStorage vault and credential recovery gates',
   'Electron end-to-end flow (Playwright, production build)','Preserve declared synthetic Rust Host compiled artifacts',authority.V39_INTEGRATION_NATIVE_STEP,authority.V39_INTEGRATION_UPLOAD_STEP])],
  artifacts:artifacts.filter(row=>i===0?row.id===501:i===1?false:i===2?[502,503].includes(row.id):[504,505].includes(row.id)).map(row=>({id:row.id,name:row.name,expired:false,size_in_bytes:row.zip.bytes,digest:'sha256:'+row.zip.sha256}))}));
 const full={schema:'musicbridge.root.v39-integration002.first-natural-ci.v1',status:'SEALED_FIRST_NATURAL_CURRENT_PRODUCT_CI',code:null,phase:'source',task:authority.V39_INTEGRATION_TASK,
  revision:source,branch:authority.V39_INTEGRATION_BRANCH,repositoryId:authority.V39_INTEGRATION_REPOSITORY_ID,recordedAt:new Date(now).toISOString(),before:{head:source,parent:authority.V39_INTEGRATION_SOURCE_PARENT,clean:true},
  after:{head:source,parent:authority.V39_INTEGRATION_SOURCE_PARENT,clean:true},reruns:0,dispatches:0,credentialsOrSignedRedirectArchived:false,runs,proofs,
  logs:proofs.flatMap(row=>row.jobs).map(row=>({jobId:row.id,raw:{bytes:1,sha256:sha(Buffer.from('x'))},download:{httpStatus:200,rawComplete:true}})),
  artifacts:artifacts.map(({controlledWholeZipBytes,...row})=>row),fixtureEvidence:'CONTROLLED_FAKE_NOT_PLATFORM_CI_NOT_PRODUCT_PASS'};
 assert.equal(authority.validateV39Integration002SourceReceipt(full,source),true,'同一生产builder/codec的受控完整Source形状应通过纯消费者，不声明actualSource资格');return full;}
export function reportFixture(ci=sourceCiFixture()){
 const original=sourceFixture(),root=privateRoot('report'),directory=path.join(root,'repo');fixtureGit(root,['clone','--local','--no-hardlinks','--no-checkout',original.directory,directory]);fixtureGit(directory,['branch','-m','controlled-fixture-original']);fixtureGit(directory,['checkout','-b',authority.V39_INTEGRATION_BRANCH,original.source]);
 const identity=authority.v39Integration002ReportIdentity(original.source,ci),state=authority.v39Integration002ReportState(original.source,ci),raw=Buffer.from(JSON.stringify(identity,null,2)+'\n');
 writeFixture(directory,authority.V39_INTEGRATION_CI_EVIDENCE_PATH,raw);writeFixture(directory,'reports/V39-INTEGRATION-002_RESULT.json',raw);
 writeFixture(directory,'reports/V39-INTEGRATION-002_RESULT.md','CONTROLLED_FAKE_ONLY：报告形状fixture，不是当前Source、产品CI、设备或Owner验收。\n');
 const sourceStatus=JSON.parse(readFileSync(path.join(directory,authority.V39_INTEGRATION_STATUS_PATH))),status={...sourceStatus,...state};
 writeFixture(directory,authority.V39_INTEGRATION_STATUS_PATH,JSON.stringify(status,null,2)+'\n');
 writeFixture(directory,'project/STATUS.json',replaceTopJson(readFileSync(path.join(directory,'project/STATUS.json')),'v39Integration',status));
 const planRaw=readFileSync(path.join(directory,'project/POSTRUST_PLAN.json')),plan=JSON.parse(planRaw);
 writeFixture(directory,'project/POSTRUST_PLAN.json',replaceTopJson(planRaw,'integration_tasks',plan.integration_tasks.map(row=>row.id===authority.V39_INTEGRATION_TASK?{...row,source_commit:original.source,source_ci:state.sourceCi,owner_acceptance:'NOT_RUN'}:row)));
 for(const name of ['project/POSTRUST_TODO.md','project/POSTRUST_PROGRESS.md'])writeFixture(directory,name,Buffer.concat([readFileSync(path.join(directory,name)),Buffer.from('\nCONTROLLED_FAKE_ONLY V39-INTEGRATION-002报告fixture。\n')]));
 fixtureGit(directory,['add','--',...authority.V39_INTEGRATION_REPORT_PATHS.map(row=>row.path)]);fixtureGit(directory,['commit','-m','CONTROLLED_FAKE_ONLY: direct report; no published CI or Owner qualification']);return {directory,report:fixtureGit(directory,['rev-parse','HEAD']),source:original.source,ci};}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const names=authority.V39_INTEGRATION_ADMISSION_CASE_NAMES;
 const run=(index,body)=>test(names[index],async()=>{await new Promise(resolve=>setImmediate(resolve));await body();});
 run(0,()=>{const f=sourceFixture(),r=authority.inspectV39Integration002Admission(f.directory,fixtureEnvironment);assert.equal(r.sourceParentSha,authority.V39_INTEGRATION_BASE);
  assert.equal(r.sourceSha,f.source);assert.equal(r.exactSourceFiles,f.names.length);assert.equal(authority.v39Integration002WorkflowOutputs(r).integrationMode,'qualified');});
 run(1,()=>{const f=sourceFixture(),r=authority.inspectV39Integration002WorkflowGuard(f.directory,fixtureEnvironment);assert.equal(r.integrationTask,authority.V39_INTEGRATION_TASK);
  const bytes=readFileSync(path.join(f.directory,'scripts/ci/v39-integration-admission.mjs'));assert.equal(sha(bytes),sha(Buffer.from(fixtureGit(f.directory,['show',authority.V39_INTEGRATION_BASE+':scripts/ci/v39-integration-admission.mjs'])+'\n')));});
 run(2,()=>{rejectSource(sourceVariant(null,{parent:sourceFixture().source}));rejectSource(sourceVariant(null,{branch:'codex/unknown-002'}));
  const f=sourceFixture();assert.throws(()=>authority.inspectV39Integration002Admission(f.directory,{...fixtureEnvironment,GITHUB_SHA:authority.V39_INTEGRATION_BASE}));});
 run(3,()=>{const f=sourceFixture();assert.equal(authority.inspectV39Integration002Admission(f.directory,{...fixtureEnvironment,GIT_DIR:'/other',GIT_WORK_TREE:'/other'}).sourceSha,f.source);
  const d=sourceVariant();writeFixture(d,'.git/shallow',fixtureGit(d,['rev-parse','HEAD'])+'\n');rejectSource(d);});
 run(4,()=>{const f=sourceFixture();assert.equal(authority.V39_INTEGRATION_AUTHORIZATION.length,297);
  const nullAdded=authority.V39_INTEGRATION_AUTHORIZATION.filter(row=>row.before===null);assert.equal(nullAdded.length,2);
  assert.deepEqual(nullAdded.map(row=>row.path).sort(),['packages/bridge-core/test/mbf-local-library-organizations.test.ts','packages/bridge-core/test/mbf-local-source-root-null.test.ts']);
  for(const row of nullAdded){const bad=structuredClone(f.scope);bad.allowedSourceFiles.find(item=>item.path===row.path).status='M';assert.throws(()=>authority.assertV39Integration002Scope(bad));
   const oldObject=structuredClone(f.scope),existing=authority.V39_INTEGRATION_AUTHORIZATION.find(item=>item.status==='M'&&item.before);assert.ok(existing.before);
   oldObject.allowedSourceFiles.find(item=>item.path===row.path).before=structuredClone(existing.before);
   assert.throws(()=>authority.assertV39Integration002Scope(oldObject),error=>error?.code==='V39_002_SCOPE_NOT_FROZEN_OR_AUTHORIZED'&&!(error instanceof TypeError),'null-A不得借已有M原blob冒旧对象');
   const changed=sourceVariant(directory=>chmodSync(path.join(directory,row.path),0o755));
   assert.throws(()=>authority.inspectV39Integration002Admission(changed,fixtureEnvironment),error=>error?.code==='V39_002_SOURCE_BEFORE_DIFF'&&!(error instanceof TypeError));}
  const sourceStore='packages/bridge-core/src/recording/source-store.ts',store=authority.V39_INTEGRATION_AUTHORIZATION.find(row=>row.path===sourceStore);
  assert.equal(store.status,'M');assert.ok(store.before);assert.equal(fixtureGit(f.directory,['ls-tree',authority.V39_INTEGRATION_BASE,'--',sourceStore]),store.before.mode+' blob '+store.before.blob+'\t'+sourceStore);
  const missingModified=sourceVariant(directory=>fixtureGit(directory,['rm','-f','--',sourceStore]));
  assert.throws(()=>authority.inspectV39Integration002Admission(missingModified,fixtureEnvironment),error=>error?.code==='V39_002_DIFF_CLOSEDSET'&&!(error instanceof TypeError));
  for(const expected of factoryBridgeAuthorization){assert.deepEqual(authority.V39_INTEGRATION_AUTHORIZATION.find(row=>row.path===expected.path),expected);
   for(const change of [row=>row.role='ci',row=>row.owner='Wave',row=>row.newMode='100755',row=>row.before.blob='0'.repeat(40),row=>row.before.sha256='0'.repeat(64)]){
    const bad=structuredClone(f.scope);change(bad.allowedSourceFiles.find(row=>row.path===expected.path));assert.throws(()=>authority.assertV39Integration002Scope(bad));}}
  const unknown=structuredClone(f.scope);unknown.finalFiles.push({path:'apps/desktop/src/main/dataset-owner-unregistered.ts',mode:'100644',blob:'0'.repeat(40),bytes:0,sha256:'0'.repeat(64)});
  unknown.finalFiles.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);assert.throws(()=>authority.assertV39Integration002Scope(unknown));
  const item=authority.V39_INTEGRATION_AUTHORIZATION.find(row=>row.status==='M');rejectSource(sourceVariant(d=>writeFixture(d,item.path,'CONTROLLED_FAKE wrong final\n')));
  rejectSource(sourceVariant(d=>writeFixture(d,'unlisted-source-path.txt','不得未授权额外叶\n')));});
 run(5,()=>{const carrier=JSON.parse(readFileSync(path.join(sourceFixture().directory,authority.V39_INTEGRATION_DONOR_PATH)));assert.equal(authority.validateV39Integration002DonorCarrier(carrier),true);
  for(const change of [r=>r.portableGit.blobs.pop(),r=>r.portableGit.commits.reverse(),r=>r.portableGit.blobs[0].rawBase64='AA==',r=>r.portableGit.blobs[0].revision=authority.V39_INTEGRATION_BASE]){const bad=structuredClone(carrier);change(bad);assert.equal(authority.validateV39Integration002DonorCarrier(bad),false);}});
 run(6,()=>{const d=sourceVariant();const original=readFileSync(path.join(d,'scripts/ci/test/tape-catalog-common-admission.test.mjs'));writeFixture(d,'scripts/ci/test/tape-catalog-common-admission.test.mjs',Buffer.concat([original,Buffer.from('\n// 历史body变异\n')]));fixtureGit(d,['add','--','scripts/ci/test/tape-catalog-common-admission.test.mjs']);fixtureGit(d,['commit','-m','CONTROLLED_FAKE_ONLY: historical change']);rejectSource(d);});
 run(7,()=>{const d=sourceVariant(directory=>{const file='project/POSTRUST_PLAN.json',raw=readFileSync(path.join(directory,file));writeFixture(directory,file,raw.toString().replace('"activeTasks": 17','"activeTasks": 18'));});rejectSource(d);});
 run(8,()=>{rejectSource(repository);const f=sourceFixture();writeFixture(f.directory,'dirty-untracked','漂移');rejectSource(f.directory);fixtureGit(f.directory,['add','--','dirty-untracked']);fixtureGit(f.directory,['commit','-m','CONTROLLED_FAKE_ONLY: temporary dirty variant']);
  shared=undefined;sourceFixture();});
 run(9,()=>{const f=sourceFixture(),r=authority.inspectV39Integration002Admission(f.directory,fixtureEnvironment);assert.throws(()=>authority.v39Integration002WorkflowOutputs({...r}));
  assert.throws(()=>authority.v39Integration002WorkflowOutputs({task:authority.V39_INTEGRATION_TASK,passed:true}));});
 run(10,()=>{const ci=sourceCiFixture(),input={task:ci.task,repositoryId:ci.repositoryId,parent:ci.revision,branch:ci.branch,runs:ci.runs,proofs:ci.proofs,now:Date.parse(ci.recordedAt)};
  assert.equal(authority.validateV39Integration002ParentCi(input),true);for(const change of [x=>x.runs.push(x.runs[0]),x=>x.runs[0].run_attempt=2,x=>x.proofs[3].jobs[0].steps.find(row=>row.name===authority.V39_INTEGRATION_NATIVE_STEP).conclusion='skipped',x=>x.now=NaN]){const bad=structuredClone(input);change(bad);assert.equal(authority.validateV39Integration002ParentCi(bad),false);}});
 run(11,()=>{assert.throws(()=>authority.v39Integration002WorkflowOutputs({task:'V39-INTEGRATION-001',repairRole:'source'}));const f=sourceFixture(),guard=authority.inspectV39Integration002WorkflowGuard(f.directory,fixtureEnvironment);assert.equal(guard.productVerificationMode,'fresh-source');});
}
