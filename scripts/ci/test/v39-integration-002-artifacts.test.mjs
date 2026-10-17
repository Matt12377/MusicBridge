import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { chmodSync,mkdirSync,readFileSync,symlinkSync,writeFileSync } from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import { buildStoragePolicy } from '../../../apps/desktop/scripts/build-storage-root.mjs';
import * as authority from '../v39-integration-002-admission.mjs';
import { collectV39Integration002DeclaredTree,copyV39Integration002ArtifactFile,selectV39Integration002ArtifactFiles } from '../prepare-v39-integration-002-artifacts.mjs';
import { V39_INTEGRATION002_COMPOSITION_TESTS } from '../verify-v39-integration-002.mjs';
import { privateRoot,writeFixture,fakeArtifact,toolFixture,sourceFixture,auxiliaryFixture } from './v39-integration-002-admission.test.mjs';
export const artifactBehaviors=[
 ()=>{const root=privateRoot('artifact-cache');for(const name of ['real.log','cache/npm/package.json','node_modules/dependency/index.js','.git/config','tmp/runner.log'])writeFixture(root,name,'实际合成文件\n');
  const selected=collectV39Integration002DeclaredTree(root,name=>/\.log$/u.test(name));assert.deepEqual(selected.map(row=>row.relative),['real.log']);},
 ()=>{const root=privateRoot('artifact-copy'),source=path.join(root,'source.bin'),target=path.join(root,'stage/program');writeFileSync(source,Buffer.from('完整Unicode字节：合成程序\0尾部'),{mode:0o700});chmodSync(source,0o700);
  const state={files:[],expandedBytes:0},row=copyV39Integration002ArtifactFile(source,target,'program',state);assert.equal(row.mode,'100700');assert.deepEqual(readFileSync(source),readFileSync(target));assert.equal(state.expandedBytes,row.bytes);},
 ()=>{const root=privateRoot('artifact-bad'),source=path.join(root,'actual');writeFixture(root,'actual','原件');symlinkSync(source,path.join(root,'link'));
  const state={files:[],expandedBytes:0};assert.throws(()=>copyV39Integration002ArtifactFile(path.join(root,'link'),path.join(root,'stage/link'),'link',state));
  assert.throws(()=>copyV39Integration002ArtifactFile(source,path.join(root,'stage/out'),'../out',state));copyV39Integration002ArtifactFile(source,path.join(root,'stage/a'),'a',state);
  assert.throws(()=>copyV39Integration002ArtifactFile(source,path.join(root,'stage/b'),'a',state));},
 ()=>{const root=privateRoot('artifact-roots'),source=path.join(root,'source'),report=path.join(root,'report');mkdirSync(source,{mode:0o700});mkdirSync(report,{mode:0o700});
  for(const name of authority.v39Integration002ToolRootNames('source'))writeFixture(source,name,'source '+name);for(const name of authority.v39Integration002ToolRootNames('report'))writeFixture(report,name,'report '+name);
  const storage=buildStoragePolicy();const s=selectV39Integration002ArtifactFiles({profile:'verify-source',softwareRoot:source},storage),r=selectV39Integration002ArtifactFiles({profile:'verify-report',softwareRoot:report},storage);
  assert.equal(s.selected.length,28);assert.deepEqual(s.missing,['capacity/ROOT']);assert.equal(r.selected.length,22);assert.deepEqual(r.missing,[]);},
 ()=>{const root=privateRoot('artifact-proofs'),snapshot=authority.inspectV39Integration002Admission(sourceFixture().directory),native=auxiliaryFixture(sourceFixture().source,snapshot.scopeSha256,'native',snapshot),
  capacity=auxiliaryFixture(sourceFixture().source,snapshot.scopeSha256,'capacity',snapshot);assert.equal(native.records.length,23);assert.equal(capacity.records.length,10);
  const inputTest='packages/bridge-core/test/v39/local-cue-input-formats.test.ts';assert.equal(authority.V39_INTEGRATION_NATIVE_TESTS.length,6);
  assert.equal(authority.V39_INTEGRATION_NATIVE_TESTS.at(-1),inputTest);assert.equal(V39_INTEGRATION002_COMPOSITION_TESTS.includes(inputTest),false);
  assert.equal(authority.V39_INTEGRATION_NATIVE_CASE_NAMES.flat().length,11);assert.equal(authority.V39_INTEGRATION_CUE_INPUT_CASE_NAMES.length,6);
  const inputRaw=native.records.find(row=>row.path==='native/cue-input-formats.json').bytes,input=JSON.parse(inputRaw);
  assert.equal(authority.validateV39Integration002CueInputFormats(native.proof.cueInputFormats,inputRaw),true);
  assert.deepEqual(native.proof.cueInputFormats.sourceRefs,authority.v39Integration002CueInputSourceRefs(inputRaw));
  const inputMutation=change=>{const bad=structuredClone(input);change(bad);const raw=Buffer.from(JSON.stringify(bad)),proof=structuredClone(native.proof);
   proof.cueInputFormats.raw={...proof.cueInputFormats.raw,bytes:raw.length,sha256:createHash('sha256').update(raw).digest('hex')};
   return {proof:authority.bindV39Integration002CueInputProof(proof,raw),raw};};
  for(const change of [value=>{value.facts.readerMs=3001;},value=>{value.facts.sourceBytesLimit++;},value=>{value.profiles.pop();},
   value=>{value.profiles.find(row=>row.id==='pcm-wav-f64').profile='f64-output';},value=>{value.operations.pop();},
   value=>{value.facts.multiFile.sourceBindings[0].sourceReadRevision='0'.repeat(64);},value=>{value.physicalClosure.claimsReleased=false;},
   value=>{value.actualOutputEncoderTagQualificationGranted=true;},value=>{value.facts.pureGroupBoundaries.executed9900Outputs=true;}]){
   const bad=inputMutation(change);assert.equal(authority.validateV39Integration002CueInputFormats(bad.proof.cueInputFormats,bad.raw),false);}
  const missingRefs=structuredClone(native.proof.cueInputFormats);missingRefs.sourceRefs.pop();assert.equal(authority.validateV39Integration002CueInputFormats(missingRefs,inputRaw),false);
  const artifact=fakeArtifact([...native.records,...native.evidence],{id:902,name:'electron-e2e-'+sourceFixture().source,profile:'electron-source',source:sourceFixture().source,auxiliaryContents:[native.content]});
  assert.equal(authority.validateV39Integration002AuxiliaryArtifact(artifact,'native',sourceFixture().source,snapshot.scopeSha256),true);
  const rareInputRaw=native.records.find(row=>row.path==='native/cue-input-formats.json').bytes;
  const lookup=pin=>native.evidence.some(row=>row.path==='native/evidence/'+pin.path&&row.bytes.length===pin.bytes&&createHash('sha256').update(row.bytes).digest('hex')===pin.sha256);
  const readBody=pin=>native.evidence.find(row=>row.path==='native/evidence/'+pin.path)?.bytes;
  assert.equal(authority.validateV39Integration002NativeProof(native.proof,sourceFixture().source,snapshot.scopeSha256,lookup,rareInputRaw,readBody),true);
  for(const [index,change] of [value=>{value.rareInputs.pop();},value=>{value.rareInputs[2].codec='mpc7';},value=>{value.rareInputs[3].codec='mpc8';},
   value=>{value.rareInputs[2].decodedFrames=88200;},value=>{value.rareInputs[3].sampleFormat='fltp';value.rareInputs[3].bitsPerSample=32;},
   value=>{value.rareInputs[0].decoded={...value.rareInputs[0].oracle};delete value.rareInputs[0].decoded.encoding;delete value.rareInputs[0].decoded.origin;delete value.rareInputs[0].decoded.nativeDecoded;},
   value=>{delete value.rareInputs[4].tagsActual.PICTURE;},value=>{value.rareInputs[1].sourceStatAfter={...value.rareInputs[1].sourceStatAfter,ino:'999'};},
   value=>{value.rareInputs[0].physicalClosure.fdChecks[0].error='UNCONFIRMED';},value=>{value.rareInputs[4].operations[0].pidObservedAbsent=false;},
   value=>{value.rareInputs[0].physicalClosure.claimsReleased=false;},value=>{delete value.rareInputs[0].operations[0].raw.stderr;}].entries()){
   const bad=structuredClone(native.proof);change(bad);assert.equal(authority.validateV39Integration002NativeProof(bad,sourceFixture().source,snapshot.scopeSha256,lookup,rareInputRaw,readBody),false,'冷门Native变异拒绝 '+index);
  }
  const missing=native.proof.rareInputs[4].operations[6].raw.stderr.path;
  assert.equal(authority.validateV39Integration002NativeProof(native.proof,sourceFixture().source,snapshot.scopeSha256,pin=>pin.path!==missing&&lookup(pin),rareInputRaw,readBody),false);
  // 追加在原第5flat内；原499五rare的13项负例与全部原case名称保持。
  const normal=native.proof.cueNormalScanEntry,normalBody=JSON.parse(readBody(normal.raw));
  const normalChange=(change,changeOwner,changeBuild)=>{
   const proof=structuredClone(native.proof),body=structuredClone(normalBody),overrides=new Map(),put=(ref,value)=>{
    const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n'),pin={path:ref.path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};overrides.set(pin.path,bytes);return pin;};
   if(changeOwner){const value=JSON.parse(readBody(normal.owner.raw));changeOwner(value,body);const ref=put(normal.owner.raw,value);body.owner.raw=ref;proof.cueNormalScanEntry.owner.raw=ref;}
   if(changeBuild){const value=JSON.parse(readBody(normal.currentBuild));changeBuild(value);const ref=put(normal.currentBuild,value);body.currentBuild=ref;proof.cueNormalScanEntry.currentBuild=ref;}
   change?.(body);proof.cueNormalScanEntry.raw=put(normal.raw,body);
   return {proof,read:pin=>overrides.get(pin.path)??readBody(pin),lookup:pin=>overrides.has(pin.path)?overrides.get(pin.path).length===pin.bytes&&createHash('sha256').update(overrides.get(pin.path)).digest('hex')===pin.sha256:lookup(pin)};
  };
  const validateNormal=bad=>authority.validateV39Integration002NativeProof(bad.proof,sourceFixture().source,snapshot.scopeSha256,bad.lookup,rareInputRaw,bad.read);
  for(const [index,change]of [value=>{value.sourceSha='0'.repeat(40);},value=>{value.qualifier.crossRunQualification=true;},value=>{value.flights[0].elapsedMs=2000;},
   value=>{value.results[0].request.commandId='00000000-0000-4000-8000-999999999999';},value=>{value.results[0].receipt.items.pop();},
   value=>{value.results[0].plan.tracks[1].startFrame++;},value=>{value.cold.nativeReinitialized=true;},value=>{value.cold.rows.local_scan_jobs[0].dataset_id='00000000-0000-4000-8000-999999999999';},
   value=>{value.directoryFdChecks[0].error='UNCONFIRMED';},value=>{value.directoryRequests[1].binding.ownerEpoch='00000000-0000-4000-8000-999999999999';},
   value=>{value.verification.pop();},value=>{value.pcmVerification.pop();},value=>{value.pcmVerification[0].tracks[1].frameCount--;},
   value=>{value.pcmVerification[0].tracks[0].outputAudio=value.results[1].outputs[0];},value=>{value.physical.verifierFdChecks=63;},value=>{value.physical.admission.permits=1;}].entries())
    assert.equal(validateNormal(normalChange(change)),false,'正常Owner正文语义变异拒绝 '+index);
  for(const [index,change]of [value=>{value.testMode=true;},value=>{value.factoryCount=2;},value=>{value.ownerThreadId=0;},value=>{value.sourcePortClosed=false;},
   value=>{value.parentPortClosed=false;},value=>{value.repositoryClosed=false;},value=>{value.fds[0].error='UNCONFIRMED';},value=>{value.readerWorkers[0].exitObserved=false;},
   value=>{value.readerWorkers[0].entry='CONTROLLED_FAKE_worker';},
   value=>{value.readerWorkers[0].entry=value.readerWorkers[0].entry.replace('/packages/bridge-core/','/wrong-root/packages/bridge-core/');},
   value=>{value.readerWorkers[0].entry=value.readerWorkers[0].entry.replace(/metadata-reader-worker\.bundle\.mjs$/u,'metadata-reader.js');},
   value=>{value.processes[0].groupAbsent=false;},value=>{value.processes[0].pidAbsent=false;}].entries())
    assert.equal(validateNormal(normalChange(null,change)),false,'原Owner完整raw语义变异拒绝 '+index);
  assert.equal(validateNormal(normalChange(null,value=>{for(const worker of value.readerWorkers)worker.entry=pathToFileURL(worker.entry).href;})),true,'实际Worker规范file URL与原compiled根逐件相等');
  for(const [index,change]of [value=>{value.readerBinding.sourceSha='0'.repeat(40);},value=>{value.readerBinding.timeBasis='UNKNOWN_JSON_RESTORED';},
   value=>{value.cueBinding.compilerFinishedAtMs++;},value=>{value.currentOutputs[0].sha256='0'.repeat(64);},value=>{value.preparation.outputs.pop();}].entries())
    assert.equal(validateNormal(normalChange(null,null,change)),false,'fresh compiled快照身份变异拒绝 '+index);
  // 冷rows两边同时污染并重hash，仍须由实际job/Asset/CUE/原ledger语义拒绝，不能只比较JSON相等。
  const bothCold=normalChange(null,(value,body)=>{value.sqlRows.local_scan_jobs[0].parser_version='music-metadata-11.15.0/mbrs003-v4';body.cold.rows=structuredClone(value.sqlRows);});
  assert.equal(validateNormal(bothCold),false);
  const rawMissing=normal.owner.raw.path;
  assert.equal(authority.validateV39Integration002NativeProof(native.proof,sourceFixture().source,snapshot.scopeSha256,lookup,rareInputRaw),false,'boolean lookup不能代替正文');
  assert.equal(authority.validateV39Integration002NativeProof(native.proof,sourceFixture().source,snapshot.scopeSha256,lookup,rareInputRaw,pin=>pin.path===rawMissing?undefined:readBody(pin)),false);
  assert.equal(authority.validateV39Integration002NativeProof(native.proof,sourceFixture().source,snapshot.scopeSha256,lookup,rareInputRaw,pin=>pin.path===rawMissing?Buffer.from('unknown JSON'):readBody(pin)),false);
  const framed=authority.decodeV39Integration002AuxiliaryContent(native.content).rootRecords,refs=authority.v39Integration002CueNormalScanBodyRefs(native.proof,readBody);
  assert.equal(framed.size,23+refs.length);for(const ref of refs)assert.deepEqual(framed.get('evidence/'+ref.path),readBody(ref));
  assert.throws(()=>authority.encodeV39Integration002AuxiliaryContent(native.records.map(row=>({path:row.path.slice('native/'.length),bytes:row.bytes})),'native'),'仅member pins、缺正文frame应拒绝');
  const records=[...framed].map(([path,bytes])=>({path,bytes}));assert.throws(()=>authority.encodeV39Integration002AuxiliaryContent(records.filter(row=>row.path!=='evidence/'+rawMissing),'native'));
  assert.throws(()=>authority.encodeV39Integration002AuxiliaryContent([...records,{path:'evidence/UNKNOWN_UNREFERENCED.json',bytes:Buffer.from('{}')}],'native'));
  // 正确SHA重新绑定的PCM坏数据也要失败，不能靠hash mismatch捕获这项回归。
  for(const id of ['ape','vorbis']){const pcmBad=normalChange(body=>{const row=body.pcmVerification.find(row=>row.id===id),pin=row.tracks[0].decoded,bytes=Buffer.from(readBody(pin));if(id==='ape')bytes.writeInt32LE(1,0);else bytes.fill(0);
   const changed={...pin,sha256:createHash('sha256').update(bytes).digest('hex')};row.tracks[0].decoded=changed;body.__controlledBadPcm={pin:changed,bytes:bytes.toString('base64')};});
  const badBody=JSON.parse(pcmBad.read(pcmBad.proof.cueNormalScanEntry.raw)),extra=badBody.__controlledBadPcm;delete badBody.__controlledBadPcm;
  const rebound=Buffer.from(JSON.stringify(badBody,null,2)+'\n');pcmBad.proof.cueNormalScanEntry.raw={...pcmBad.proof.cueNormalScanEntry.raw,bytes:rebound.length,sha256:createHash('sha256').update(rebound).digest('hex')};
  const originalRead=pcmBad.read,originalLookup=pcmBad.lookup;pcmBad.read=pin=>pin.path===extra.pin.path?Buffer.from(extra.bytes,'base64'):pin.path===pcmBad.proof.cueNormalScanEntry.raw.path?rebound:originalRead(pin);
  pcmBad.lookup=pin=>pin.path===extra.pin.path||pin.path===pcmBad.proof.cueNormalScanEntry.raw.path||originalLookup(pin);assert.equal(validateNormal(pcmBad),false,id==='ape'?'完整范围等值拒绝坏PCM':'Vorbis低于18dB拒绝');}


  for(const row of native.records)writeFixture(root,row.path.slice('native/'.length),row.bytes);for(const row of native.evidence)writeFixture(root,row.path.slice('native/'.length),row.bytes);
  const streams=native.proof.formats[0].encode.raw,parentRaw=Buffer.from(JSON.stringify({stdout:streams.stdout,stderr:streams.stderr}));
  writeFixture(root,'evidence/raw/encode.json',parentRaw);native.proof.formats[0].encode.raw={path:'raw/encode.json',bytes:parentRaw.length,
   sha256:createHash('sha256').update(parentRaw).digest('hex'),...streams};writeFixture(root,'native-proof.json',JSON.stringify(native.proof));
  const selected=selectV39Integration002ArtifactFiles({profile:'electron-source',nativeRoot:root},buildStoragePolicy());
  assert.ok(selected.selected.some(row=>row.relative==='native/cue-input-formats.json'));
  for(const ref of native.proof.cueInputFormats.sourceRefs)assert.ok(selected.selected.some(row=>row.relative==='native/evidence/'+ref.path));
  const decoded=input.profiles[0].decoded,decodedBytes=readFileSync(path.join(root,'evidence',decoded.path));writeFixture(root,'evidence/'+decoded.path,'坏完整PCM原件');
  assert.throws(()=>selectV39Integration002ArtifactFiles({profile:'electron-source',nativeRoot:root},buildStoragePolicy()));writeFixture(root,'evidence/'+decoded.path,decodedBytes);
  assert.ok(selected.selected.some(row=>row.relative==='native/evidence/lyrics/wav/decoded-before'));assert.ok(selected.selected.some(row=>row.relative==='native/evidence/watcher/events.log'));
  for(const name of ['raw/encode.json',streams.stdout.path,streams.stderr.path])assert.ok(selected.selected.some(row=>row.relative==='native/evidence/'+name));
  writeFixture(root,'evidence/'+streams.stdout.path,'坏嵌套stdout');assert.throws(()=>selectV39Integration002ArtifactFiles({profile:'electron-source',nativeRoot:root},buildStoragePolicy()));
  writeFixture(root,'evidence/'+streams.stdout.path,Buffer.alloc(streams.stdout.bytes));
  writeFixture(root,'evidence/watcher/events.log','坏真实原件');assert.throws(()=>selectV39Integration002ArtifactFiles({profile:'electron-source',nativeRoot:root},buildStoragePolicy()));},
 ()=>{const root=privateRoot('artifact-missing');writeFixture(root,'summary.json','明确失败');const result=selectV39Integration002ArtifactFiles({profile:'verify-report',softwareRoot:root},buildStoragePolicy());
  assert.equal(result.selected.length,1);assert.ok(result.missing.length>0);assert.ok(result.missing.includes('gate-safety.stderr.log'));},
 ()=>{const f=sourceFixture(),tool=toolFixture(f.source),artifact=fakeArtifact(tool.records,{id:900,name:'verify-'+f.source,profile:'verify-source',source:f.source,toolContent:tool.toolContent});
  assert.equal(authority.validateV39Integration002ArchiveManifest(artifact,f.source,'verify-source'),true);const bad=structuredClone({...artifact,controlledWholeZipBytes:undefined});delete bad.controlledWholeZipBytes;
  bad.members.push({path:'cache/extra',bytes:1,sha256:'0'.repeat(64),crc32:0});bad.expandedBytes++;assert.equal(authority.validateV39Integration002ArchiveManifest(bad,f.source,'verify-source'),false);},
 ()=>{const root=privateRoot('artifact-legal'),source=path.join(root,'bundle');for(const name of ['legal/ffmpeg/COPYING.LGPLv2.1','legal/ffmpeg/ffmpeg-8.1.2.tar.xz','lib/libavcodec.62.dylib','bin/ffmpeg'])writeFixture(source,name,'实际合成许可或产物 '+name);
  const chosen=collectV39Integration002DeclaredTree(source,()=>true);assert.equal(chosen.length,4);assert.ok(chosen.some(row=>row.relative.endsWith('.tar.xz')));
  const state={files:[],expandedBytes:0};for(const row of chosen)copyV39Integration002ArtifactFile(row.path,path.join(root,'stage',row.relative),row.relative,state);assert.equal(state.files.length,4);}
];
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))for(const [index,body]of artifactBehaviors.entries())test(authority.V39_INTEGRATION_ARTIFACT_CASE_NAMES[index],async()=>{await new Promise(resolve=>setImmediate(resolve));await body();});
