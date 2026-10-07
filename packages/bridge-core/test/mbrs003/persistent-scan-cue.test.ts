import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile,stat,open,symlink,link,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {buildStoragePolicy} from '../../../../apps/desktop/scripts/build-storage-root.mjs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {fstatSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {audioFixture,loadFreshMetadataReader} from '../helpers/mbrs003-audio-fixtures.js';
import {authorizeSourceDirectory,readonlySourceCandidateMetadata} from '../../src/recording/source-files.js';
import {createCollectionRepository,CollectionError} from '../../src/collection/repository.js';
import {createLocalScanCoordinator} from '../../src/collection/local-scan-coordinator.js';
import {createScanReadAdmission} from '../../src/library/scan-read-admission.js';
import type {DatasetProjectionPort,DatasetProjectionCommand,DatasetProjectionCommandPayloads,DatasetProjectionCommandResults} from '../../src/collection/dataset-owner-protocol.js';
import {isLocalScanCommandPayload,type LocalCuePreparedItem} from '@music-bridge/contracts';
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
async function unit(t:test.TestContext,body:string,onLifecycle?:(event:CueSidecarLifecycle)=>void,beforeCommit?:(action:string)=>void) {
  const f=await audioFixture(t),media=path.join(f.directory,'cue-media');await mkdir(media,{mode:0o700});
  // sidecar先创建，不能用目录枚举顺序假定音频已提交。
  await writeFile(path.join(media,'disc.cue'),body,{flag:'wx',mode:0o600});await writeFile(path.join(media,'disc.wav'),await f.bytes('core-wav'),{flag:'wx',mode:0o600});
  const file=path.join(f.directory,'cue.sqlite'),datasetId=randomUUID();const repo=createCollectionRepository({filePath:file,...(beforeCommit ? {beforeCommit}:{})});
  const source=repo.sources.authorize(randomUUID(),await authorizeSourceDirectory(media));const root=repo.localCatalog.registerRoot({commandId:randomUUID(),sourceRootId:source.id,role:'library'}),p=projection(datasetId);
  const cue=(await freshCueReader()).createCueSidecarReader(onLifecycle ? {onLifecycle} : {}),reader=(await loadFreshMetadataReader()).createMetadataReader();
  const coordinator=createLocalScanCoordinator({repository:repo,datasetId,assertCurrent:()=>{},projection:p.port,reader,cueReader:cue});
  t.after(async()=>{await coordinator.close().catch(()=>undefined);p.admission.close();repo.close();});return {...f,file,media,repo,root,source,p,coordinator,cue,datasetId};
}
const valid='TITLE "专辑"\nFILE "disc.wav" WAVE\n TRACK 01 AUDIO\n TITLE "CUE文本标题"\n INDEX 00 00:01:00\n INDEX 01 00:01:01\n TRACK 02 AUDIO\n INDEX 01 00:02:00\n';
async function scan(u:Awaited<ReturnType<typeof unit>>) {const job=u.coordinator.start({commandId:randomUUID(),libraryRootId:u.root.id,expectedRootRevision:u.root.revision});await u.coordinator.privateWait(job.jobId);return u.coordinator.get(job.jobId);}
async function cueOnly(u:Awaited<ReturnType<typeof unit>>) {
  const created=u.repo.localScan.start({commandId:randomUUID(),datasetId:u.datasetId,libraryRootId:u.root.id,expectedRootRevision:u.root.revision,parserVersion:'music-metadata-11.15.0/mbrs003-v1'}).job;
  const running=u.repo.localScan.resume({commandId:randomUUID(),jobId:created.jobId,expectedRevision:created.jobRevision});
  const frontier=['~cue-v1/'+Buffer.from(JSON.stringify({relative:'',skip:0,signature:null})).toString('base64url')],batch={batchId:randomUUID(),jobId:created.jobId,expectedJobRevision:running.jobRevision,checkpointBefore:null,items:[],frontier,completed:false,kind:'cue-sidecars-v1' as const,cueItems:[]};
  u.repo.localScan.privatePrepareBatch({commandId:randomUUID(),jobId:created.jobId,batch});const committed=u.repo.localScan.privateCommitBatch({commandId:randomUUID(),jobId:created.jobId,batchId:batch.batchId,expectedRevision:running.jobRevision});
  const paused=u.repo.localScan.pause({commandId:randomUUID(),jobId:created.jobId,expectedRevision:committed.jobRevision});u.coordinator.resume({commandId:randomUUID(),jobId:created.jobId,expectedRevision:paused.jobRevision});await u.coordinator.privateWait(created.jobId);assert.equal(u.coordinator.get(created.jobId).phase,'completed');
}
function facts(file:string) {const db=new DatabaseSync(file,{readOnly:true,allowExtension:false});try{return {version:db.prepare('PRAGMA user_version').get()?.user_version,names:db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(),jobs:db.prepare('SELECT * FROM local_scan_jobs ORDER BY rowid').all(),batches:db.prepare('SELECT * FROM local_scan_batches ORDER BY rowid').all(),receipts:db.prepare('SELECT * FROM local_scan_receipts ORDER BY rowid').all(),checkpoints:db.prepare('SELECT * FROM local_scan_checkpoints ORDER BY rowid').all(),ledger:db.prepare('SELECT * FROM local_catalog_ledger ORDER BY rowid').all(),integrity:db.prepare('PRAGMA integrity_check').get(),fk:db.prepare('PRAGMA foreign_key_check').all()};}finally{db.close();}}
test('真实Root CUE先发现仍持久关联75fps声明，冷开与未变增量保留ID/raw/manual',async t=>{
  const events:CueSidecarLifecycle[]=[];let revoke=true,u!:Awaited<ReturnType<typeof unit>>;
  u=await unit(t,valid,event=>{events.push(event);if(event.type === 'worker-start' && revoke){revoke=false;u.p.busy(true);}});let job=await scan(u);
  assert.equal(job.phase,'paused');assert.deepEqual(job.progress,{visited:'1',accepted:'1',rejected:'0'});assert.equal(u.repo.localScan.privateCueSnapshot(u.root.id,'disc.cue'),null);
  const fd=events.find(e=>e.type === 'worker-start')!.fd;assert.throws(()=>fstatSync(fd),{code:'EBADF'});assert.equal(events.at(-1)!.type,'lease-released');assert.equal(u.p.admission.resourceCounts().permits,0);
  u.p.busy(false);u.coordinator.resume({commandId:randomUUID(),jobId:job.jobId,expectedRevision:job.jobRevision});await u.coordinator.privateWait(job.jobId);job=u.coordinator.get(job.jobId);
  assert.equal(job.phase,'completed');assert.deepEqual(job.progress,{visited:'2',accepted:'2',rejected:'0'});
  const saved=u.repo.localScan.privateCueSnapshot(u.root.id,'disc.cue');assert.ok(saved && saved.item.result);assert.equal(saved.item.result.tracks[0]!.index01Frames,76);assert.equal(saved.item.result.tracks[0]!.index00Frames,75);
  assert.equal(saved.item.result.tracks[1]!.index01Frames,150);for(const track of saved.item.result.tracks){assert.equal(track.timebase,'cue-cd-frames');assert.equal(track.framesPerSecond,75);assert.equal(track.endFrames,null);assert.equal(track.playback,'NOT_VERIFIED');}
  const track=u.repo.localCatalog.pageTracks({offset:0,limit:200}).items[0]!;assert.equal(track.segment,null);const locator=u.repo.localCatalog.privateAssetLocator(track.assetId);assert.equal(locator.asset.sampleFrames,null);assert.equal(locator.asset.timebaseHz,null);
  const beforeRaw=u.repo.localCatalog.metadata(track.id);u.repo.localCatalog.overrideMetadata({commandId:randomUUID(),trackId:track.id,expectedRevision:null,fields:{title:'人工标题'}});const manual=u.repo.localCatalog.metadata(track.id);
  const ledger=facts(u.file).ledger,reads=events.filter(e=>e.type === 'worker-start').length;assert.equal(reads,2);
  const second=await scan(u);assert.equal(second.phase,'completed');assert.equal(u.repo.localScan.privateCueSnapshot(u.root.id,'disc.cue')!.id,saved.id);assert.equal(events.filter(e=>e.type === 'worker-start').length,reads);
  assert.deepEqual(facts(u.file).ledger,ledger);assert.deepEqual(u.repo.localCatalog.metadata(track.id),manual);assert.equal(u.repo.localCatalog.pageTracks({offset:0,limit:200}).items.length,1);assert.ok(beforeRaw);
  await u.coordinator.close();u.repo.close();const cold=createCollectionRepository({filePath:u.file});try{assert.deepEqual(cold.localScan.privateCueSnapshot(u.root.id,'disc.cue'),saved);assert.deepEqual(cold.localCatalog.metadata(track.id),manual);}finally{cold.close();}
  assert.equal(await readFile(path.join(u.media,'disc.cue'),'utf8'),valid);assert.deepEqual(facts(u.file).fk,[]);assert.equal(facts(u.file).integrity?.integrity_check,'ok');
});

test('旧五表32原事实兼容，CUE原子扩展与提交fault回滚，冷prepared变更显式abandon重读',async t=>{
  let fail:string|undefined;const u=await unit(t,valid,undefined,action=>{if(action === fail) throw new Error('合成单次提交故障');});
  const oldList=u.repo.list({offset:0,limit:1});assert.equal(facts(u.file).version,34);assert.equal(facts(u.file).names.filter(r=>String(r.name).startsWith('local_cue_')).length,0);
  await u.coordinator.close();u.repo.close();const cold=createCollectionRepository({filePath:u.file});assert.deepEqual(cold.list({offset:0,limit:1}),oldList);cold.close();
  // 独立私有副本：partial扩展不得被cold-open悄悄补修；future35仍拒绝。
  const partial=path.join(u.directory,'partial32.sqlite'),future=path.join(u.directory,'future35.sqlite');await copyFile(u.file,partial);await copyFile(u.file,future);
  const partialDb=new DatabaseSync(partial,{allowExtension:false});partialDb.exec('CREATE TABLE local_cue_sources(id TEXT PRIMARY KEY,sidecar_id TEXT NOT NULL,library_root_id TEXT NOT NULL REFERENCES local_catalog_roots(id),relative TEXT NOT NULL,batch_id TEXT NOT NULL REFERENCES local_scan_batches(id),data TEXT NOT NULL) STRICT');partialDb.close();
  const invalid=createCollectionRepository({filePath:partial});assert.throws(()=>invalid.list({offset:0,limit:1}));invalid.close();
  const inspection=new DatabaseSync(partial,{readOnly:true,allowExtension:false});assert.equal(inspection.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name IN ('local_cue_sources','local_cue_tracks')").get()?.n,1);inspection.close();
  const futureDb=new DatabaseSync(future,{allowExtension:false});futureDb.exec('PRAGMA user_version=35');futureDb.close();const newer=createCollectionRepository({filePath:future});assert.throws(()=>newer.list({offset:0,limit:1}));newer.close();

  // 实际新repo延续原五表32，可信批准备故障不能留下半张CUE表。
  const injected:string[]=[];const repo=createCollectionRepository({filePath:u.file,beforeCommit:action=>{if(action === fail){injected.push(action);throw new Error('合成提交故障');}}});t.after(()=>repo.close());
  const created=repo.localScan.start({commandId:randomUUID(),datasetId:u.datasetId,libraryRootId:u.root.id,expectedRootRevision:u.root.revision,parserVersion:'music-metadata-11.15.0/mbrs003-v1'}).job;
  const job=repo.localScan.resume({commandId:randomUUID(),jobId:created.jobId,expectedRevision:created.jobRevision});const stat=await readonlySourceCandidateMetadata(u.source,'disc.cue');
  const item:LocalCuePreparedItem={relative:'disc.cue',signature:stat.signature,parserVersion:'cue-text-75fps/mbrs003-v1',outcome:'rejected',failureCode:'UNBOUND_FILE',reused:false,previousSnapshotId:null,result:null};
  const batch={batchId:randomUUID(),jobId:job.jobId,expectedJobRevision:job.jobRevision,checkpointBefore:null,items:[],frontier:[],completed:true,kind:'cue-sidecars-v1' as const,cueItems:[item]};
  const before=facts(u.file);fail='local-scan:prepare-batch';assert.throws(()=>repo.localScan.privatePrepareBatch({commandId:randomUUID(),jobId:job.jobId,batch}),(error:unknown)=>error instanceof CollectionError && error.code === 'INVENTORY_UNAVAILABLE' && error.message === '库存暂时不可用，请重试；现有数据不会被自动清除。');assert.deepEqual(injected,['local-scan:prepare-batch']);assert.deepEqual(facts(u.file),before);
  fail=undefined;repo.localScan.privatePrepareBatch({commandId:randomUUID(),jobId:job.jobId,batch});const prepared=facts(u.file);
  fail='local-scan:commit-batch';assert.throws(()=>repo.localScan.privateCommitBatch({commandId:randomUUID(),jobId:job.jobId,batchId:batch.batchId,expectedRevision:job.jobRevision}),(error:unknown)=>error instanceof CollectionError && error.code === 'INVENTORY_UNAVAILABLE' && error.message === '库存暂时不可用，请重试；现有数据不会被自动清除。');assert.deepEqual(injected,['local-scan:prepare-batch','local-scan:commit-batch']);assert.deepEqual(facts(u.file),prepared);assert.equal(repo.localScan.privateCueSnapshot(u.root.id,'disc.cue'),null);
  fail=undefined;await writeFile(path.join(u.media,'disc.cue'),valid+'REM 外部更改\n');repo.close();
  const restarted=createCollectionRepository({filePath:u.file});t.after(()=>restarted.close());const paused=restarted.localScan.get(job.jobId);assert.equal(paused.phase,'paused');
  const running=restarted.localScan.resume({commandId:randomUUID(),jobId:job.jobId,expectedRevision:paused.jobRevision});const original=restarted.localScan.privatePreparedBatches(job.jobId)[0]!;
  assert.deepEqual(original,batch);assert.notEqual((await readonlySourceCandidateMetadata(u.source,'disc.cue')).signature,item.signature);
  const p=projection(u.datasetId),coordinator=createLocalScanCoordinator({repository:restarted,datasetId:u.datasetId,assertCurrent:()=>{},projection:p.port,reader:(await loadFreshMetadataReader()).createMetadataReader(),cueReader:(await freshCueReader()).createCueSidecarReader()});
  await assert.rejects(()=>coordinator.prepareBatch({commandId:randomUUID(),jobId:job.jobId,batch:{...batch,batchId:randomUUID(),expectedJobRevision:running.jobRevision}}),/checkpoint\/receipt来源/);
  await assert.rejects(()=>coordinator.commitBatch({commandId:randomUUID(),jobId:job.jobId,batchId:batch.batchId,expectedRevision:running.jobRevision}),/事实已改变/);assert.deepEqual(restarted.localScan.privatePreparedBatches(job.jobId)[0],batch);
  restarted.localScan.privateAbandonBatch({commandId:randomUUID(),jobId:job.jobId,batchId:batch.batchId,expectedRevision:running.jobRevision,reason:'CONTENT_CHANGED'});assert.deepEqual(restarted.localScan.privatePreparedBatches(job.jobId),[]);
  const pausedAgain=restarted.localScan.pause({commandId:randomUUID(),jobId:job.jobId,expectedRevision:running.jobRevision});coordinator.resume({commandId:randomUUID(),jobId:job.jobId,expectedRevision:pausedAgain.jobRevision});await coordinator.privateWait(job.jobId);assert.equal(coordinator.get(job.jobId).phase,'completed');assert.equal(restarted.localScan.privateCueSnapshot(u.root.id,'disc.cue')!.item.outcome,'accepted');await coordinator.close();p.admission.close();
});

test('CUE零多候选与路径边界明确拒绝，闭集事实不伪造音频或播放segment',async t=>{
  const u=await unit(t,valid.replace('disc.wav','missing.wav')),first=await scan(u);assert.equal(first.phase,'completed');let saved=u.repo.localScan.privateCueSnapshot(u.root.id,'disc.cue')!;assert.equal(saved.item.failureCode,'UNBOUND_FILE');assert.equal(u.repo.localCatalog.pageTracks({offset:0,limit:200}).items.length,1);
  await writeFile(path.join(u.media,'other.wav'),await u.bytes('core-wav'),{flag:'wx',mode:0o600});
  const multi='FILE "disc.wav" WAVE\n TRACK 01 AUDIO\n INDEX 01 00:01:01\nFILE "other.wav" WAVE\n TRACK 02 AUDIO\n INDEX 01 00:00:01\n';await writeFile(path.join(u.media,'disc.cue'),multi);const paired=await scan(u);assert.equal(paired.phase,'completed');
  const pairs=u.repo.localScan.privateCueSnapshot(u.root.id,'disc.cue')!.item.result!.tracks;assert.deepEqual(pairs.map(v=>[v.fileOrdinal,v.index01Frames]),[[1,76],[2,1]]);assert.notEqual(pairs[0]!.assetReference.assetId,pairs[1]!.assetReference.assetId);for(const v of pairs) assert.equal(v.endFrames,null);
  // 只在相同受权relative已有两个独立资产时记录歧义，不选择第一个。
  u.repo.localCatalog.registerAsset({commandId:randomUUID(),libraryRootId:u.root.id,expectedRootRevision:u.root.revision,relative:'disc.wav',sha256:null,sampleFrames:null,timebaseHz:null});await writeFile(path.join(u.media,'disc.cue'),valid);await cueOnly(u);
  saved=u.repo.localScan.privateCueSnapshot(u.root.id,'disc.cue')!;assert.equal(saved.item.failureCode,'AMBIGUOUS_FILE');assert.equal(u.repo.localCatalog.pageTracks({offset:0,limit:200}).items.length,2);
  await writeFile(path.join(u.media,'disc.cue'),valid.replace('disc.wav','../disc.wav'));await cueOnly(u);assert.equal(u.repo.localScan.privateCueSnapshot(u.root.id,'disc.cue')!.item.outcome,'rejected');
  const cue=u.repo.localScan.privateCueSnapshot(u.root.id,'disc.cue')!.item;const candidate={batchId:randomUUID(),jobId:first.jobId,expectedJobRevision:'1',checkpointBefore:null,items:[],frontier:[],completed:true,kind:'cue-sidecars-v1',cueItems:[cue]};assert.equal(isLocalScanCommandPayload('localScan.prepareBatch',{commandId:randomUUID(),jobId:first.jobId,batch:candidate}),true);
  const hidden={...cue};Object.defineProperty(hidden,'absolutePath',{value:'/untrusted'});assert.equal(isLocalScanCommandPayload('localScan.prepareBatch',{commandId:randomUUID(),jobId:first.jobId,batch:{...candidate,cueItems:[hidden]}}),false);
  const symbol={...cue,[Symbol('session')]:'secret'};assert.equal(isLocalScanCommandPayload('localScan.prepareBatch',{commandId:randomUUID(),jobId:first.jobId,batch:{...candidate,cueItems:[symbol]}}),false);
  const proto=Object.assign(Object.create({generation:1}),cue);assert.equal(isLocalScanCommandPayload('localScan.prepareBatch',{commandId:randomUUID(),jobId:first.jobId,batch:{...candidate,cueItems:[proto]}}),false);
  for(const track of u.repo.localCatalog.pageTracks({offset:0,limit:200}).items) assert.equal(track.segment,null);
});
