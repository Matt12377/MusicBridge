import { buildStoragePolicy } from '../../../../apps/desktop/scripts/build-storage-root.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile, lstat, realpath, chmod, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from '../mbrs005/fixture.js';
import { analyzeBoundaries, comparePcm, PCM_MAX_FRAMES, type PcmWindow, type BoundaryTrial } from '../../src/application/pcm-evidence.js';
import { assessAudioQuality, formatCapabilityMatrix, type AudioEvidenceScope } from '../../src/application/audio-quality-evidence.js';
function pcm(bitsPerSample:16|24|32=24,frames=128):PcmWindow {
 const samples=new Int32Array(frames*2);let n=17;
 for(let i=0;i<samples.length;i++){n=(Math.imul(n,1664525)+1013904223)|0;samples[i]=bitsPerSample===16?((n>>>0)%30001)-15000:((n>>>0)%4_000_001)-2_000_000;}
 return {sampleRateHz:96000,channels:2,bitsPerSample,samples};
}
const clone=(v:PcmWindow):PcmWindow=>({...v,samples:Int32Array.from(v.samples)});
const trial=(v:PcmWindow):BoundaryTrial=>({capture:clone(v),native:clone(v),alignmentErrorFrames:0});
async function evidence(name:string,data:unknown,raw?:PcmWindow){
 const root=process.env.MBRS008_PRIVATE_EVIDENCE_ROOT;if(!root)return;
 buildStoragePolicy().check(root,{mustExist:true});const info=await lstat(root);assert.equal(info.isDirectory()&&!info.isSymbolicLink(),true);assert.equal(await realpath(root),root);assert.equal(info.mode&0o777,0o700);assert.equal(typeof process.getuid,'function');assert.equal(info.uid,process.getuid!());
 const directory=path.join(root,'writer');await mkdir(directory,{recursive:true,mode:0o700});
 if(raw)await writeFile(path.join(directory,`${name}.pcm.json`),JSON.stringify({...raw,samples:Array.from(raw.samples),synthetic:true})+'\n',{mode:0o600});
 await writeFile(path.join(directory,`${name}.json`),JSON.stringify({schema:'mbrs008.private-pcm.v1',synthetic:true,realDeviceCapture:'NOT_RUN',data,...(raw?{oracleRef:`${name}.pcm.json`}:{})},null,2)+'\n',{mode:0o600});
}
test('008有效非静音双声道16/24/32-bit逐样本比较，明确整数偏移不会 resample',async()=>{
 const results=[];for(const bits of [16,24,32] as const){const reference=pcm(bits),capture=clone(reference);assert.equal(comparePcm(reference,capture).outcome,'MATCH');const prefix=new Int32Array(reference.samples.length+4);prefix.set(reference.samples,4);const result=comparePcm(reference,{...reference,samples:prefix},2);assert.equal(result.outcome,'MATCH');results.push(result);}
 await evidence('pcm-exact',results,pcm());
});
test('008单个低位改变、左右交换/复制、少帧和增益均不是位精确',()=>{
 const reference=pcm(),one=clone(reference);const bit=one.samples[100];assert.notEqual(bit,undefined);one.samples[100]=bit!^1;assert.equal(comparePcm(reference,one).changedSamples,1);
 const swap=clone(reference),copy=clone(reference),gain=clone(reference);for(let i=0;i<reference.samples.length;i+=2){swap.samples[i]=reference.samples[i+1]!;swap.samples[i+1]=reference.samples[i]!;copy.samples[i+1]=copy.samples[i]!;gain.samples[i]=Math.trunc(gain.samples[i]!/2);}
 for(const changed of [one,swap,copy,gain,{...reference,samples:reference.samples.slice(2)}])assert.equal(comparePcm(reference,changed).outcome,'MISMATCH');
});
test('008全零/恒定/单声道及24容器仅16有效位无法认证有效24位',()=>{
 const reference=pcm();for(const samples of [new Int32Array(256),new Int32Array(256).fill(1),Int32Array.from(reference.samples,n=>n&~255)])assert.equal(comparePcm({...reference,samples},{...reference,samples}).outcome,'INSUFFICIENT');
 const mono=clone(reference);for(let i=0;i<mono.samples.length;i+=2)mono.samples[i+1]=mono.samples[i]!;assert.equal(comparePcm(mono,mono).outcome,'INSUFFICIENT');
});
test('008离线预算65536frames/2ch严格，错rate/depth不转换也不拿DSD当PCM',()=>{
 const reference=pcm();assert.equal(comparePcm(reference,{...reference,sampleRateHz:44100}).outcome,'UNSUPPORTED');assert.equal(comparePcm(reference,{...reference,bitsPerSample:32}).outcome,'UNSUPPORTED');
 assert.equal(comparePcm({...reference,samples:new Int32Array((PCM_MAX_FRAMES+1)*2)},reference).outcome,'INVALID');
 assert.equal(comparePcm({...reference,channels:1} as unknown as PcmWindow,reference).outcome,'INVALID');assert.equal(comparePcm({...reference,bitsPerSample:1} as unknown as PcmWindow,reference).outcome,'INVALID');
});
test('008唯一锚点/同clock三次边界相等，只认证算法不会签live gapless',async()=>{
 const reference=pcm(),result=analyzeBoundaries(reference,64,[trial(reference),trial(reference),trial(reference)]);assert.equal(result.outcome,'MATCH');assert.equal(result.trials.length,3);assert.equal(result.liveGapless,'NOT_TESTED');
 const scope:AudioEvidenceScope={build:'test-build',core:'test-core',zone:'test-zone',outputs:['test-output'],assetId:'test-asset',revision:'1',sourceDigest:'a'.repeat(64),profile:'FMT-04',settingsDigest:'b'.repeat(64)};
 const assessment=assessAudioQuality(scope,[{scope,id:'synthetic-pcm',origin:'synthetic',measurement:{axis:'digital_output',result:comparePcm(reference,reference)}},{scope,id:'synthetic-boundary',origin:'synthetic',measurement:{axis:'gapless',result}}]);assert.equal(assessment.quality.digital_output,'NOT_TESTED');assert.equal(assessment.quality.gapless,'NOT_TESTED');assert.equal(assessment.endToEndBitExact,false);
 await evidence('boundary-exact',{result,assessment,matrix:formatCapabilityMatrix([assessment])},reference);
});
test('008丢帧/插静音/重复/尖峰逐次失败可见，不能三次只选最好',async()=>{
 const reference=pcm(),before=reference.samples.slice(0,128),after=reference.samples.slice(128);
 const insert=(samples:Int32Array):PcmWindow=>({...reference,samples:Int32Array.from([...before,...samples,...after])});
 const silent=insert(new Int32Array(4)),repeat=insert(reference.samples.slice(124,128)),lost={...reference,samples:Int32Array.from([...reference.samples.slice(0,124),...after])},spike=clone(reference);spike.samples[128]=8_000_000;
 const reports=[];for(const capture of [silent,repeat,lost,spike]){const result=analyzeBoundaries(reference,64,[trial(reference),{capture,native:clone(reference),alignmentErrorFrames:0},trial(reference)]);assert.equal(result.outcome,'MISMATCH');assert.equal(result.trials.length,3);reports.push(result);}
 assert.equal(reports[0]!.trials[1]!.insertedSilenceFrames,2);assert.equal(reports[1]!.trials[1]!.repeatedFrames,2);assert.equal(reports[2]!.trials[1]!.lostFrames,2);assert.ok(reports[3]!.trials[1]!.maxAbsoluteDifference>0);
 await evidence('boundary-failures',reports,reference);
});
test('008native基线差异/时钟误差/重复锚点/少重复/跨rate relock不可藏成成功',()=>{
 const reference=pcm(),badNative=clone(reference);const bit=badNative.samples[128];assert.notEqual(bit,undefined);badNative.samples[128]=bit!^1;
 assert.equal(analyzeBoundaries(reference,64,[trial(reference),{capture:clone(reference),native:badNative,alignmentErrorFrames:0},trial(reference)]).outcome,'MISMATCH');
 assert.equal(analyzeBoundaries(reference,64,[trial(reference),{...trial(reference),alignmentErrorFrames:0.1},trial(reference)]).outcome,'INSUFFICIENT');
 assert.equal(analyzeBoundaries(reference,64,[trial(reference),trial(reference)]).outcome,'INVALID');assert.equal(analyzeBoundaries(reference,64,Array.from({length:17},()=>trial(reference))).outcome,'INVALID');
 assert.equal(analyzeBoundaries(reference,64,[trial(reference),{...trial(reference),capture:{...reference,sampleRateHz:44100}},trial(reference)]).outcome,'UNSUPPORTED');
 const repeated=clone(reference);repeated.samples.set(reference.samples.slice(96,112),0);assert.equal(analyzeBoundaries(reference,64,[{capture:repeated,native:clone(reference),alignmentErrorFrames:0},trial(reference),trial(reference)]).outcome,'INSUFFICIENT');
});

test('008 R1边界先失败后未知及反向均保留已证失败，矩阵不降未测',()=>{
 const reference=pcm(),bad=clone(reference);const bit=bad.samples[128];assert.notEqual(bit,undefined);bad.samples[128]=bit!^1;
 const failed={capture:bad,native:clone(reference),alignmentErrorFrames:0};
 const unknowns=[{...trial(reference),alignmentErrorFrames:0.1},{...trial(reference),capture:{...reference,sampleRateHz:44100}},{...trial(reference),capture:{...reference,samples:new Int32Array()}}];
 const bound:AudioEvidenceScope={build:'test-build',core:'test-core',zone:'test-zone',outputs:['test-output'],assetId:'test-asset',revision:'1',sourceDigest:'a'.repeat(64),profile:'FMT-04',settingsDigest:'b'.repeat(64)};
 for(const unknown of unknowns)for(const values of [[failed,unknown,trial(reference)],[unknown,failed,trial(reference)]]){
  const result=analyzeBoundaries(reference,64,values);assert.equal(result.outcome,'MISMATCH');assert.ok(result.trials.some(m=>m.changedSamples>0&&m.trialIndex===values.indexOf(failed)));assert.equal(result.issues.length,1);assert.equal(result.issues[0]!.trialIndex,values.indexOf(unknown));assert.equal(Object.isFrozen(result.issues),true);assert.equal(Object.isFrozen(result.issues[0]),true);
  const assessment=assessAudioQuality(bound,[{scope:bound,id:'mixed-boundary',origin:'synthetic',measurement:{axis:'gapless',result}}]);assert.equal(formatCapabilityMatrix([assessment])[3]!.evidence[0]!.statusByAxis.gapless,'SOFTWARE_FAILED');assert.equal(assessment.quality.gapless,'NOT_TESTED');
 }
 const native=clone(reference);native.samples[128]=native.samples[128]!^1;assert.equal(analyzeBoundaries(reference,64,[{capture:clone(reference),native,alignmentErrorFrames:0},unknowns[2]!,trial(reference)]).outcome,'MISMATCH');
});
test('008 R1Q3失败结果不能被改MATCH，裸结果/clone也不被consumer认证',()=>{
 const reference=pcm(),bad=clone(reference);bad.samples[0]=bad.samples[0]!^1;const result=comparePcm(reference,bad);assert.equal(result.outcome,'MISMATCH');
 assert.throws(()=>{result.outcome='MATCH';},TypeError);assert.equal(result.outcome,'MISMATCH');
 const bound:AudioEvidenceScope={build:'test-build',core:'test-core',zone:'test-zone',outputs:['test-output'],assetId:'test-asset',revision:'1',sourceDigest:'a'.repeat(64),profile:'FMT-04',settingsDigest:'b'.repeat(64)};
 for(const value of [structuredClone(result),{outcome:'MATCH'} as unknown as typeof result])assert.equal(assessAudioQuality(bound,[{scope:bound,id:'forged-Q3',origin:'synthetic',measurement:{axis:'digital_output',result:value}}]).analyses.digital_output,undefined);
});
test('008 R1Q4结果/逐次测量深冻结，clone/裸MATCH不代替有效边界原件',()=>{
 const reference=pcm(),result=analyzeBoundaries(reference,64,[trial(reference),trial(reference),trial(reference)]);
 const bound:AudioEvidenceScope={build:'test-build',core:'test-core',zone:'test-zone',outputs:['test-output'],assetId:'test-asset',revision:'1',sourceDigest:'a'.repeat(64),profile:'FMT-04',settingsDigest:'b'.repeat(64)};
 for(const value of [structuredClone(result),{outcome:'MATCH'} as unknown as typeof result])assert.equal(assessAudioQuality(bound,[{scope:bound,id:'forged-Q4',origin:'synthetic',measurement:{axis:'gapless',result:value}}]).analyses.gapless,undefined);
 assert.equal(Object.isFrozen(result),true);assert.equal(Object.isFrozen(result.trials),true);assert.ok(result.trials.every(Object.isFrozen));assert.equal(Object.isFrozen(result.issues),true);
});

test('008 R1私有证据Hosted只准RUNNER_TEMP专用树，拒绝外逃/755/符号链',async t=>{
 const f=await fixture(t),runner=path.join(f.directory,'runner'),allowed=path.join(runner,'musicbridge-audio','private'),escape=path.join(f.directory,'outside-runner'),link=path.join(runner,'musicbridge-link');
 await mkdir(allowed,{recursive:true,mode:0o700});await mkdir(escape,{mode:0o700});await symlink(allowed,link);
 const keys=['GITHUB_ACTIONS','RUNNER_ENVIRONMENT','RUNNER_TEMP','MBRS008_PRIVATE_EVIDENCE_ROOT'] as const,saved=new Map(keys.map(key=>[key,process.env[key]]));
 try{process.env.GITHUB_ACTIONS='true';process.env.RUNNER_ENVIRONMENT='github-hosted';process.env.RUNNER_TEMP=runner;
  process.env.MBRS008_PRIVATE_EVIDENCE_ROOT=allowed;await evidence('hosted-admitted',{synthetic:true});
  process.env.MBRS008_PRIVATE_EVIDENCE_ROOT=escape;await assert.rejects(evidence('hosted-escape',{}));
  process.env.MBRS008_PRIVATE_EVIDENCE_ROOT=allowed;await chmod(allowed,0o755);await assert.rejects(evidence('hosted-not-private',{}));await chmod(allowed,0o700);
  process.env.MBRS008_PRIVATE_EVIDENCE_ROOT=link;await assert.rejects(evidence('hosted-link',{}));
 }finally{await chmod(allowed,0o700);for(const key of keys){const value=saved.get(key);if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
