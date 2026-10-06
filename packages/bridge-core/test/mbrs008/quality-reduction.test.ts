import assert from 'node:assert/strict';
import test from 'node:test';
import { assessAudioQuality, compareSignalPaths, evaluateSettingsRecord, formatCapabilityMatrix, isAudioEvidenceScope, safeFileParameters, untestedAudioQuality, type AudioEvidenceScope, type SignalPathObservation } from '../../src/application/audio-quality-evidence.js';
import { auditHttpBytes } from '../../src/stream/http-byte-evidence.js';
import { gatewayFixture } from '../mbrs005/fixture.js';
const scope:AudioEvidenceScope={build:'test-build-01',core:'test-core',zone:'test-zone',outputs:['test-output'],assetId:'test-asset',revision:'1',sourceDigest:'a'.repeat(64),profile:'FMT-03',settingsDigest:'b'.repeat(64)};
const path=(route:'native'|'direct'):SignalPathObservation=>({route,input:{encoding:'PCM',sampleRateHz:96000,bitsPerSample:24,channels:2},processing:{gainDb:0,volumeLeveling:'DISABLED',loudness:'KNOWN',replayGain:'DISABLED',dsp:[],dsdConversion:'NONE'},output:{encoding:'PCM',sampleRateHz:96000,bitsPerSample:24,channels:2}});
test('008没有证据四轴独立未测；metadata24/96不能认证实际输出或位精确',()=>{
 assert.deepEqual(assessAudioQuality(scope,[]).quality,untestedAudioQuality());assert.equal(assessAudioQuality(scope,[]).endToEndBitExact,false);
 assert.equal(safeFileParameters({container:'WAVE',codec:'PCM',lossless:true,sampleRateHz:96000,channels:2,bitsPerSample:24,durationMs:null,evidence:'bounded-parser-reported'})?.bitsPerSample,24);
 assert.equal(safeFileParameters({codec:'PCM',signalPath:'24/96'}),undefined);
});
test('008真实HTTP审计仅Q1通过；自报绿色和复制JSON不能创建Q1证书或矩阵',async t=>{
 const f=await gatewayFixture(t),result=await auditHttpBytes(f.bytes,async input=>{const r=await fetch(f.url,{method:input.method,headers:input.headers});const headers:Record<string,string>={};r.headers.forEach((value,key)=>headers[key]=value);return {status:r.status,headers,body:new Uint8Array(await r.arrayBuffer())};}),bound={...scope,sourceDigest:result.sourceDigest};
 const good=assessAudioQuality(bound,[{scope:bound,id:'q1',origin:'synthetic',measurement:{axis:'http_bytes',result}}]);assert.equal(good.quality.http_bytes,'SAMPLE_VERIFIED');assert.equal(good.quality.digital_output,'NOT_TESTED');assert.equal(good.endToEndBitExact,false);
 assert.equal(assessAudioQuality(bound,[{scope:bound,id:'forged',origin:'private-record',measurement:{axis:'http_bytes',result:structuredClone(result)}}]).quality.http_bytes,'NOT_TESTED');
 assert.throws(()=>formatCapabilityMatrix([{...good,quality:{...good.quality,gapless:'TEST_CONDITIONS_VERIFIED'}}]));
 const matrix=formatCapabilityMatrix([good]);assert.equal(matrix.length,14);assert.equal(Object.keys(matrix[2]!.evidence[0]!.statusByAxis).length,12);assert.equal(matrix[2]!.evidence[0]!.statusByAxis.http_raw_file,'SOFTWARE_VERIFIED');assert.equal(matrix[2]!.evidence[0]!.statusByAxis.audioinput_play,'NOT_TESTED');
});
test('008build/Core/Zone/output/settings/source revision任一改变不能借旧证据，预算和私密scope拒绝',()=>{
 const result=compareSignalPaths(path('native'),path('direct'),scope,scope);
 for(const patch of [{build:'other-build'},{core:'other-core'},{zone:'other-zone'},{outputs:['other-output']},{settingsDigest:'c'.repeat(64)},{revision:'2'},{assetId:'other-asset'},{sourceDigest:'d'.repeat(64)},{profile:'FMT-04' as const}]){
  const report=assessAudioQuality({...scope,...patch},[{scope,id:'old-A',origin:'synthetic',measurement:{axis:'signal_path',result}}]);assert.equal(report.analyses.signal_path,undefined);assert.deepEqual(report.quality,untestedAudioQuality());
 }
 assert.equal(isAudioEvidenceScope({...scope,path:'/private/source'}),false);assert.equal(isAudioEvidenceScope({...scope,zone:'http://secret'}),false);assert.throws(()=>assessAudioQuality(scope,Array(65).fill({})));
});
test('008合成SignalPath比较有效，但当前live仍未测；增益/ReplayGain/DSP/未知响度不被24/96遮住',()=>{
 const native=path('native'),direct=path('direct');assert.equal(compareSignalPaths(native,direct,scope,scope).outcome,'OBSERVED');
 for(const patch of [{gainDb:-3},{volumeLeveling:'ENABLED' as const},{replayGain:'ENABLED' as const},{dsp:['Resample']}])assert.equal(compareSignalPaths(native,{...direct,processing:{...direct.processing,...patch}},scope,scope).outcome,'MISMATCH');
 assert.equal(compareSignalPaths(native,{...direct,processing:{...direct.processing,loudness:'UNKNOWN'}},scope,scope).outcome,'INSUFFICIENT');
 const reordered:SignalPathObservation={route:'direct',output:{channels:2,bitsPerSample:24,sampleRateHz:96000,encoding:'PCM'},processing:{dsdConversion:'NONE',dsp:[],replayGain:'DISABLED',loudness:'KNOWN',volumeLeveling:'DISABLED',gainDb:0},input:{channels:2,bitsPerSample:24,sampleRateHz:96000,encoding:'PCM'}};assert.equal(compareSignalPaths(native,reordered,scope,scope).outcome,'OBSERVED');
 assert.equal(compareSignalPaths({...native,processing:{...native.processing,dsp:['Gain','Resample']}},{...direct,processing:{...direct.processing,dsp:['Resample','Gain']}},scope,scope).outcome,'MISMATCH');
 const result=compareSignalPaths(native,direct,scope,scope),assessment=assessAudioQuality(scope,[{scope,id:'fake-signal',origin:'synthetic',measurement:{axis:'signal_path',result}}]);assert.equal(assessment.quality.signal_path,'NOT_TESTED');assert.equal(result.liveStatus,'NOT_TESTED');
});
test('008DSD收到/PCM转换/实际输出三段分列，未测不叫DSD直通',()=>{
 const native=path('native'),direct=path('direct');direct.input.encoding='DSD';direct.processing.dsdConversion='PCM';const result=compareSignalPaths(native,direct,scope,scope);
 assert.deepEqual(result.dsd,{received:'DSD',converted:'PCM',output:'PCM'});assert.equal(result.outcome,'MISMATCH');assert.equal(result.liveStatus,'NOT_TESTED');
});
test('008私有设置授权与实际回读记录分开；finally请求或未知初值不算恢复',()=>{
 const record={authorized:true,zone:'test-zone',outputs:['test-output'],before:{'test-output':-30},after:{'test-output':-20},restored:{'test-output':-30},safeMin:-60,safeMax:-10};
 assert.equal(evaluateSettingsRecord(record),'RECORD_CONSISTENT');assert.equal(evaluateSettingsRecord({...record,authorized:false}),'NOT_AUTHORIZED');assert.equal(evaluateSettingsRecord({...record,before:null}),'INSUFFICIENT');assert.equal(evaluateSettingsRecord({...record,restored:null}),'INSUFFICIENT');assert.equal(evaluateSettingsRecord({...record,restored:{'test-output':-20}}),'RESTORE_FAILED');assert.equal(evaluateSettingsRecord({...record,after:{'test-output':0}}),'INSUFFICIENT');
});

test('008 R1默认矩阵14行12轴显式未测，精确CUE独立不支持',()=>{
 const matrix=formatCapabilityMatrix([]);assert.equal(matrix.length,14);
 for(const row of matrix){const statuses=(row as unknown as {statusByAxis:Record<string,string>}).statusByAxis;assert.equal(typeof statuses,'object');assert.equal(Object.keys(statuses).length,12);for(const [axis,value] of Object.entries(statuses))assert.equal(value,row.id==='FMT-14'&&axis==='exact_segment'?'UNSUPPORTED':'NOT_TESTED');}
});
test('008 R1Q2 native/direct必须分别同源Core Zone settings revision，单scope不能自证配对',()=>{
 const compare=compareSignalPaths as (a:SignalPathObservation,b:SignalPathObservation,aScope:AudioEvidenceScope,bScope:AudioEvidenceScope)=>ReturnType<typeof compareSignalPaths>;
 for(const patch of [{zone:'other-zone'},{core:'other-core'},{revision:'2'},{sourceDigest:'c'.repeat(64)},{settingsDigest:'c'.repeat(64)}])assert.equal(compare(path('native'),path('direct'),scope,{...scope,...patch}).outcome,'INSUFFICIENT');
 assert.equal(compare(path('native'),path('direct'),scope,scope).outcome,'OBSERVED');
 assert.equal(compareSignalPaths(path('native'),path('direct')).outcome,'INSUFFICIENT');
});
test('008 R1Q2裸结果与JSON克隆不能注册OBSERVED，受控结果与DSD叶冻结',()=>{
 const result=compareSignalPaths(path('native'),path('direct'),scope,scope),clone=structuredClone(result);
 for(const value of [clone,{outcome:'OBSERVED'} as unknown as typeof result])assert.equal(assessAudioQuality(scope,[{scope,id:'forged-Q2',origin:'synthetic',measurement:{axis:'signal_path',result:value}}]).analyses.signal_path,undefined);
 assert.equal(result.outcome,'OBSERVED');assert.equal(Object.isFrozen(result),true);assert.equal(Object.isFrozen(result.dsd),true);assert.equal(Object.isFrozen(result.scope),true);assert.equal(Object.isFrozen(result.scope!.outputs),true);
});

test('008 R1Q2真实工厂原件可消费，但不能用另一assessment scope重新包装',()=>{
 const result=compareSignalPaths(path('native'),path('direct'),scope,scope);
 const good=assessAudioQuality(scope,[{scope,id:'paired-Q2',origin:'synthetic',measurement:{axis:'signal_path',result}}]);
 assert.equal(good.analyses.signal_path,'OBSERVED');assert.equal(good.quality.signal_path,'NOT_TESTED');assert.equal(good.endToEndBitExact,false);
 for(const patch of [{zone:'other-zone'},{core:'other-core'},{revision:'2'},{settingsDigest:'c'.repeat(64)}]){
  const other={...scope,...patch},bad=assessAudioQuality(other,[{scope:other,id:'retagged-Q2',origin:'synthetic',measurement:{axis:'signal_path',result}}]);
  assert.equal(bad.analyses.signal_path,undefined);assert.ok(bad.limitations.includes('Signal Path原件配对scope不匹配'));assert.deepEqual(bad.quality,untestedAudioQuality());
 }
});
