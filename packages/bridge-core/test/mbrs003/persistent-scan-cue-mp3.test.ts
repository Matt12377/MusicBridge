import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile,stat} from 'node:fs/promises';
import {fstatSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {buildStoragePolicy} from '../../../../apps/desktop/scripts/build-storage-root.mjs';
import {audioFixture,loadFreshMetadataReader} from '../helpers/mbrs003-audio-fixtures.js';
import {createCollectionRepository} from '../../src/collection/repository.js';
import {createLocalScanCoordinator} from '../../src/collection/local-scan-coordinator.js';
import {createScanReadAdmission} from '../../src/library/scan-read-admission.js';
import type {DatasetProjectionPort,DatasetProjectionCommand,DatasetProjectionCommandPayloads,DatasetProjectionCommandResults} from '../../src/collection/dataset-owner-protocol.js';
import {authorizeSourceDirectory} from '../../src/recording/source-files.js';
import {parseCueText} from '../../src/library/cue-text-reader.js';
import type {CueSidecarLifecycle} from '../../src/library/cue-sidecar-reader.js';
async function freshCueReader():Promise<typeof import('../../src/library/cue-sidecar-reader.js')> {
  assert.equal(process.versions.node.split('.')[0],'22');
  const declaration=process.env.MBRS003_CUE_BUILD_BINDING;assert.ok(declaration && path.isAbsolute(declaration),'root须提供实际fresh CUE编译身份');
  buildStoragePolicy().check(declaration,{mustExist:true,kind:'file'});
  const binding=JSON.parse(await readFile(declaration,'utf8')) as {schema:string;compilerExit:number;compilerStartedAtMs:number;compilerFinishedAtMs:number;sourceInputs:{file:string;bytes:number;sha256:string}[];outputs:{file:string;bytes:number;sha256:string}[]};
  assert.equal(binding.schema,'mbrs003.cue.fresh-build.v1');assert.equal(binding.compilerExit,0);
  assert.ok(binding.compilerStartedAtMs>0 && binding.compilerFinishedAtMs>=binding.compilerStartedAtMs);assert.equal(binding.sourceInputs.length,2);assert.equal(binding.outputs.length,4);
  const coreRoot=fileURLToPath(new URL('../../',import.meta.url));
  assert.deepEqual(binding.sourceInputs.map(v=>v.file).sort(),['src/library/cue-sidecar-reader.ts','src/library/cue-sidecar-worker.ts']);
  for(const entry of [...binding.sourceInputs,...binding.outputs]) {
    assert.match(entry.file,/^(src|dist)\/library\/cue-sidecar-(reader|worker)\.(ts|js|js.map)$/u);
    const bytes=await readFile(path.join(coreRoot,entry.file));assert.equal(bytes.length,entry.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),entry.sha256);
    if(entry.file.startsWith('dist/')) assert.ok((await stat(path.join(coreRoot,entry.file))).mtimeMs>=binding.compilerStartedAtMs && (await stat(path.join(coreRoot,entry.file))).mtimeMs<=binding.compilerFinishedAtMs);
  }
  const expected=['cue-sidecar-reader','cue-sidecar-worker'].flatMap(n=>['.js','.js.map'].map(s=>'dist/library/'+n+s));
  assert.deepEqual(binding.outputs.map(v=>v.file).sort(),expected.sort());
  for(const stem of ['reader','worker']) {
    const js='dist/library/cue-sidecar-'+stem+'.js',map=JSON.parse(await readFile(path.join(coreRoot,js+'.map'),'utf8')) as {file:string;sourceRoot:string;sources:string[]};
    assert.equal(map.file,path.basename(js));assert.equal(map.sourceRoot,'');assert.equal(map.sources.length,1);assert.equal(path.resolve(path.dirname(path.join(coreRoot,js)),map.sources[0]!),path.join(coreRoot,'src/library/cue-sidecar-'+stem+'.ts'));
  }
  const actual=await import(pathToFileURL(path.join(coreRoot,'dist/library/cue-sidecar-reader.js')).href) as typeof import('../../src/library/cue-sidecar-reader.js');
  assert.equal(typeof actual.createCueSidecarReader,'function','PREPARATION_FAILED: 必须有实际compiled reader export');return actual;
}
function projection(datasetId:string) {
  let busy=false;const context={datasetId,epoch:randomUUID()},admission=createScanReadAdmission({isBusy:()=>busy});
  const port:DatasetProjectionPort={async call<K extends DatasetProjectionCommand>(command:K,payload:DatasetProjectionCommandPayloads[K]):Promise<DatasetProjectionCommandResults[K]> {
    let result:unknown;
    if(command === 'scanReadAcquire') result=admission.acquire(context);
    else if(command === 'scanReadWatchRevocation') result=await admission.watchRevocation(context,(payload as {permitId:string}).permitId);
    else if(command === 'scanReadRelease') result=admission.release(context,(payload as {permitId:string}).permitId);
    else throw new Error('只接实际scanRead admission。');return result as DatasetProjectionCommandResults[K];
  }};return {port,admission,busy(value:boolean){busy=value;admission.observe();}};
}

function persistentRows(file:string) {
  const db=new DatabaseSync(file,{readOnly:true,allowExtension:false});
  try {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version,32);
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check,'ok');assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name GLOB 'local_catalog_*' OR name GLOB 'local_scan_*' OR name GLOB 'local_cue_*') ORDER BY name").all()
      .map(row=>[row.name,db.prepare('SELECT * FROM "'+String(row.name)+'" ORDER BY rowid').all()]);
  } finally {db.close();}
}
test('正常真实MP3入库后实际FILE MP3 sidecar持久关联75fps声明并冷开保持原音频ID/raw和账本',async t=>{
  const f=await audioFixture(t),media=path.join(f.directory,'mp3-cue-media');await mkdir(media,{mode:0o700});
  const body='TITLE "MP3声明专辑"\nFILE "disc.mp3" MP3\n TRACK 01 AUDIO\n INDEX 00 00:01:00\n INDEX 01 00:01:01\n';
  await writeFile(path.join(media,'disc.cue'),body,{flag:'wx',mode:0o600});
  await writeFile(path.join(media,'disc.mp3'),await f.bytes('core-mp3'),{flag:'wx',mode:0o600});
  const file=path.join(f.directory,'mp3-cue.sqlite'),repo=createCollectionRepository({filePath:file}),datasetId=randomUUID();
  const source=repo.sources.authorize(randomUUID(),await authorizeSourceDirectory(media)),root=repo.localCatalog.registerRoot({commandId:randomUUID(),sourceRootId:source.id,role:'library'});
  const p=projection(datasetId),events:CueSidecarLifecycle[]=[];
  const coordinator=createLocalScanCoordinator({repository:repo,datasetId,assertCurrent:()=>{},projection:p.port,
    reader:(await loadFreshMetadataReader()).createMetadataReader(),cueReader:(await freshCueReader()).createCueSidecarReader({onLifecycle:event=>events.push(event)})});
  t.after(async()=>{try{await coordinator.close();}finally{p.admission.close();repo.close();}});
  const pending=coordinator.start({commandId:randomUUID(),libraryRootId:root.id,expectedRootRevision:root.revision});await coordinator.privateWait(pending.jobId);
  const job=coordinator.get(pending.jobId);assert.equal(job.phase,'completed');assert.equal(job.progress.visited,'2');
  // 正控制必须先证明原正常MP3扫描已由真实Reader落库，不以伪造技术事实绕过MP3解析。
  const state=repo.localScan.privateFileState(root.id,'disc.mp3');assert.ok(state);assert.equal(state.value.outcome,'accepted');assert.ok(state.value.readFacts);
  const observed=f.entry('core-mp3').observedAudio;assert.ok(observed);assert.equal(state.value.readFacts.technical.container,'MPEG');assert.equal(state.value.readFacts.technical.sampleRateHz,observed.sampleRate);
  assert.equal(state.value.readFacts.readEvidence.wholeAudioHash,false);assert.equal(state.value.readFacts.readEvidence.wholeAudioDecode,false);
  const tracks=repo.localCatalog.pageTracks({offset:0,limit:200}).items;assert.equal(tracks.length,1);const track=tracks[0]!,asset=repo.localCatalog.asset(track.assetId);
  assert.equal(track.id,state.value.trackId);assert.equal(asset.id,state.value.assetId);assert.equal(track.segment,null);assert.equal(repo.localCatalog.privateAssetHasExactEvidence(asset.id),false);assert.equal(asset.sampleFrames,null);assert.equal(asset.timebaseHz,null);
  const raw=repo.localCatalog.metadata(track.id),expectedTags=f.entry('core-mp3').expectedTags;assert.ok(expectedTags);assert.equal(raw.raw.title,expectedTags.title);assert.equal(raw.raw.artist,expectedTags.artist);assert.equal(raw.raw.album,expectedTags.album);
  const reference={assetId:asset.id,libraryRootId:root.id,sourceRootId:source.id,rootRevision:root.revision,fileRevision:asset.fileRevision,locationRevision:asset.locationRevision,relative:'disc.mp3',signature:state.value.signature};
  assert.equal(parseCueText(body,new Map([['disc.mp3',[reference]]])).status,'ok','原纯parser合法MP3正控制');
  const started=events.find(event=>event.type==='worker-start');assert.ok(started);assert.equal(events.filter(event=>event.type==='worker-start').length,1);
  const exit=events.findIndex(event=>event.type==='worker-exit'),release=events.findIndex(event=>event.type==='lease-released');assert.ok(exit>=0 && release>exit);assert.throws(()=>fstatSync(started.fd),{code:'EBADF'});assert.equal(p.admission.resourceCounts().permits,0);
  const saved=repo.localScan.privateCueSnapshot(root.id,'disc.cue');assert.ok(saved);
  // 唯一首个产品目标：full02字符类漏MP3导致已读sidecar落UNBOUND_FILE，而音频及FD正控制先成立。
  assert.equal(saved.item.outcome,'accepted','正常MP3唯一绑定的FILE MP3必须持久关联，不能误判UNBOUND_FILE');
  assert.equal(saved.item.failureCode,null);assert.ok(saved.item.result);assert.deepEqual(saved.item.result.tracks[0]!.assetReference,reference);
  assert.equal(saved.item.result.tracks[0]!.index00Frames,75);assert.equal(saved.item.result.tracks[0]!.index01Frames,76);assert.equal(saved.item.result.tracks[0]!.timebase,'cue-cd-frames');assert.equal(saved.item.result.tracks[0]!.framesPerSecond,75);assert.equal(saved.item.result.tracks[0]!.endFrames,null);assert.equal(saved.item.result.tracks[0]!.evidence,'cue-text-declared');assert.equal(saved.item.result.tracks[0]!.playback,'NOT_VERIFIED');
  assert.deepEqual(job.progress,{visited:'2',accepted:'2',rejected:'0'});const rows=persistentRows(file);
  await coordinator.close();p.admission.close();repo.close();
  const cold=createCollectionRepository({filePath:file});
  try {assert.deepEqual(cold.localScan.privateCueSnapshot(root.id,'disc.cue'),saved);assert.deepEqual(cold.localCatalog.pageTracks({offset:0,limit:200}).items,[track]);assert.deepEqual(cold.localCatalog.asset(asset.id),asset);assert.deepEqual(cold.localCatalog.metadata(track.id),raw);assert.deepEqual(cold.localScan.privateFileState(root.id,'disc.mp3'),state);assert.deepEqual(cold.sources.root(source.id),source);}
  finally {cold.close();}
  assert.deepEqual(persistentRows(file),rows);assert.equal(await readFile(path.join(media,'disc.cue'),'utf8'),body);assert.deepEqual(await readFile(path.join(media,'disc.mp3')),await f.bytes('core-mp3'));
});
