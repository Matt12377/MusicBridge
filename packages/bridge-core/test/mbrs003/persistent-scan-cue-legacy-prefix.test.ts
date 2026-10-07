import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,lstat} from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {audioFixture,loadFreshMetadataReader} from '../helpers/mbrs003-audio-fixtures.js';
import {createCollectionRepository} from '../../src/collection/repository.js';
import {createLocalScanCoordinator} from '../../src/collection/local-scan-coordinator.js';
import {createScanReadAdmission} from '../../src/library/scan-read-admission.js';
import type {DatasetProjectionPort,DatasetProjectionCommand,DatasetProjectionCommandPayloads,DatasetProjectionCommandResults} from '../../src/collection/dataset-owner-protocol.js';
import {authorizeSourceDirectory} from '../../src/recording/source-files.js';
import {isLocalScanPreparedBatch} from '@music-bridge/contracts';
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

function sql(file:string) {
  const db=new DatabaseSync(file,{readOnly:true,allowExtension:false});
  try {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version,34);assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check,'ok');assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    return {tables:db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(),batches:db.prepare('SELECT * FROM local_scan_batches ORDER BY rowid').all(),receipts:db.prepare('SELECT * FROM local_scan_receipts ORDER BY rowid').all(),checkpoints:db.prepare('SELECT * FROM local_scan_checkpoints ORDER BY rowid').all(),ledger:db.prepare('SELECT * FROM local_catalog_ledger ORDER BY rowid').all()};
  } finally {db.close();}
}
test('真实旧七字段checkpoint含合法CUE前缀目录且200音频跨批时保持旧路径解释与原回执',async t=>{
  const f=await audioFixture(t),media=path.join(f.directory,'legacy-prefix-media');await mkdir(media,{mode:0o700});
  await mkdir(path.join(media,'A'),{mode:0o700});await mkdir(path.join(media,'~cue-v1','Z'),{recursive:true,mode:0o700});
  const bytes=await f.bytes('core-wav');
  for(let i=0;i<200;i++) await writeFile(path.join(media,'A','track-'+String(i).padStart(3,'0')+'.wav'),bytes,{flag:'wx',mode:0o600});
  await writeFile(path.join(media,'~cue-v1','Z','last.wav'),bytes,{flag:'wx',mode:0o600});
  const named=await lstat(path.join(media,'~cue-v1','Z'));assert.equal(named.isDirectory() && !named.isSymbolicLink(),true);
  const file=path.join(f.directory,'legacy-prefix.sqlite'),datasetId=randomUUID();let repo=createCollectionRepository({filePath:file});
  t.after(()=>repo.close());
  const source=repo.sources.authorize(randomUUID(),await authorizeSourceDirectory(media)),root=repo.localCatalog.registerRoot({commandId:randomUUID(),sourceRootId:source.id,role:'library'});
  const created=repo.localScan.start({commandId:randomUUID(),datasetId,libraryRootId:root.id,expectedRootRevision:root.revision,parserVersion:'music-metadata-11.15.0/mbrs003-v1'}).job;
  const running=repo.localScan.resume({commandId:randomUUID(),jobId:created.jobId,expectedRevision:created.jobRevision});
  // 原七键API真实prepare/commit产生旧checkpoint，frontier文字就是合法relative目录，不是新JSON token。
  const legacy={batchId:randomUUID(),jobId:running.jobId,expectedJobRevision:running.jobRevision,checkpointBefore:null,items:[],frontier:['A','~cue-v1/Z'],completed:false};
  assert.equal(isLocalScanPreparedBatch(legacy),true);assert.deepEqual(Object.keys(legacy).sort(),['batchId','jobId','expectedJobRevision','checkpointBefore','items','frontier','completed'].sort());
  const prepareCommand=randomUUID(),commitCommand=randomUUID();repo.localScan.privatePrepareBatch({commandId:prepareCommand,jobId:running.jobId,batch:legacy});
  const committed=repo.localScan.privateCommitBatch({commandId:commitCommand,jobId:running.jobId,batchId:legacy.batchId,expectedRevision:running.jobRevision});
  const paused=repo.localScan.pause({commandId:randomUUID(),jobId:running.jobId,expectedRevision:committed.jobRevision});
  const old=sql(file);assert.equal(old.tables.length,117);assert.deepEqual(repo.localScan.privateCheckpoint(running.jobId)!.frontier,['A','~cue-v1/Z']);assert.equal(repo.localScan.privateCueAwareCheckpoint(running.jobId),false);
  const legacyRow=old.batches.find(row=>row.id===legacy.batchId)!;assert.deepEqual(JSON.parse(String(legacyRow.request)),legacy);assert.equal(JSON.parse(String(legacyRow.result)).kind,undefined);
  const oldPrepare=old.receipts.find(row=>row.command_id===prepareCommand)!,oldCommit=old.receipts.find(row=>row.command_id===commitCommand)!,oldCheckpoint=old.checkpoints.find(row=>row.batch_id===legacy.batchId)!;
  repo.close();repo=createCollectionRepository({filePath:file});assert.deepEqual(repo.localScan.privateCheckpoint(running.jobId)!.frontier,['A','~cue-v1/Z']);assert.equal(repo.localScan.privateCueAwareCheckpoint(running.jobId),false);
  const p=projection(datasetId);let reads=0;
  const reader=(await loadFreshMetadataReader()).createMetadataReader({onLifecycle:event=>{if(event.type==='worker-start') reads++;}});
  const coordinator=createLocalScanCoordinator({repository:repo,datasetId,assertCurrent:()=>{},projection:p.port,reader});
  t.after(async()=>{try{await coordinator.close();}finally{p.admission.close();}});
  coordinator.resume({commandId:randomUUID(),jobId:paused.jobId,expectedRevision:paused.jobRevision});await coordinator.privateWait(paused.jobId);
  const job=coordinator.get(paused.jobId);
  // 首批200个普通WAV已由真实Reader/原writer成功；不能以准备失败、缺符号或假file-state作RED。
  assert.ok(reads>=200);const first=repo.localCatalog.pageTracks({offset:0,limit:200});assert.equal(first.items.length,200);assert.ok(first.total>=200);
  for(let i=0;i<200;i++) {const state=repo.localScan.privateFileState(root.id,'A/track-'+String(i).padStart(3,'0')+'.wav');assert.ok(state && state.value.readFacts);assert.equal(state.value.outcome,'accepted');assert.equal(state.value.readFacts.technical.container,'WAVE');assert.equal(state.value.readFacts.readEvidence.wholeAudioHash,false);}
  const beforeTarget=sql(file);assert.deepEqual(beforeTarget.batches.find(row=>row.id===legacy.batchId),legacyRow);assert.deepEqual(beforeTarget.receipts.find(row=>row.command_id===prepareCommand),oldPrepare);assert.deepEqual(beforeTarget.receipts.find(row=>row.command_id===commitCommand),oldCommit);assert.deepEqual(beforeTarget.checkpoints.find(row=>row.batch_id===legacy.batchId),oldCheckpoint);
  assert.equal(job.phase,'completed','旧真实~cue-v1/Z目录必须沿原path继续扫描，不能因未访问frontier前缀误tag失败');
  assert.deepEqual(job.progress,{visited:'201',accepted:'201',rejected:'0'});assert.equal(reads,201);assert.equal(repo.localCatalog.pageTracks({offset:0,limit:200}).total,201);
  const last=repo.localScan.privateFileState(root.id,'~cue-v1/Z/last.wav');assert.ok(last && last.value.assetId && last.value.trackId);assert.equal(last.value.outcome,'accepted');assert.equal(repo.localScan.privateCueAwareCheckpoint(job.jobId),false);
  const all=[...repo.localCatalog.pageTracks({offset:0,limit:200}).items,...repo.localCatalog.pageTracks({offset:200,limit:200}).items];assert.equal(new Set(all.map(v=>v.id)).size,201);assert.equal(new Set(all.map(v=>v.assetId)).size,201);for(const track of all) assert.equal(track.segment,null);
  const complete=sql(file);assert.equal(complete.tables.length,117);assert.equal(complete.tables.some(row=>String(row.name).startsWith('local_cue_')),false);
  for(const row of complete.batches) assert.equal(JSON.parse(String(row.request)).kind,undefined,'无CUE实际发现时原音频批不得升级tag');
  await coordinator.close();assert.equal(p.admission.resourceCounts().permits,0);p.admission.close();repo.close();
  const cold=createCollectionRepository({filePath:file});try {assert.deepEqual(cold.localScan.get(job.jobId),job);assert.deepEqual(cold.localScan.privateFileState(root.id,'~cue-v1/Z/last.wav'),last);assert.equal(cold.localCatalog.pageTracks({offset:0,limit:200}).total,201);assert.equal(cold.localScan.privateCueAwareCheckpoint(job.jobId),false);}finally{cold.close();}
  assert.deepEqual(sql(file),complete);
});
