import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {chmod,lstat,mkdir,readFile,writeFile} from 'node:fs/promises';
import {fstatSync} from 'node:fs';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {audioFixture,loadFreshMetadataReader,sha256} from '../helpers/mbrs003-audio-fixtures.js';
import {authorizeSourceDirectory} from '../../src/recording/source-files.js';
import {createCollectionRepository} from '../../src/collection/repository.js';
import {createLocalScanCoordinator} from '../../src/collection/local-scan-coordinator.js';
import {createScanReadAdmission} from '../../src/library/scan-read-admission.js';
import type {DatasetProjectionPort,DatasetProjectionCommand,DatasetProjectionCommandPayloads,DatasetProjectionCommandResults} from '../../src/collection/dataset-owner-protocol.js';
import type {MetadataReaderLifecycle,MetadataReaderPort,MetadataReadResult} from '../../src/library/metadata-reader-types.js';

function same(a:unknown,b:unknown){assert.equal(isDeepStrictEqual(a,b),true,'合成逻辑事实必须精确保持');}
// 只打开此test自建的合成DB只读连接以数实体，不seed、不改变任何SQL行。
function counts(file:string){const db=new DatabaseSync(file,{readOnly:true,allowExtension:false});try{return {
  assets:Number(db.prepare('SELECT count(*) n FROM local_catalog_assets').get()!.n),
  tracks:Number(db.prepare('SELECT count(*) n FROM local_catalog_tracks').get()!.n),
};}finally{db.close();}}

test('MBRS003 permission recovery：真实EACCES恢复后显式重扫只保留一份资产曲目与原ID/manual',{timeout:60_000},async t=>{
  assert(typeof process.getuid==='function'&&process.getuid()>0,'权限恢复必须以普通UID取得真实EACCES');
  const original=await audioFixture(t),directory=path.join(original.directory,'permission-recovery-media');await mkdir(directory,{mode:0o700});
  const relative='permission-recovery-core.flac',target=path.join(directory,relative),bytes=await original.bytes('core-flac');
  await writeFile(target,bytes,{flag:'wx',mode:0o600});const beforeFile=await lstat(target);assert.equal(beforeFile.nlink,1);assert.equal(beforeFile.mode&0o777,0o600);
  const file=path.join(original.directory,'permission-recovery.sqlite'),repository=createCollectionRepository({filePath:file});
  const capability=repository.sources.authorize(randomUUID(),await authorizeSourceDirectory(directory));
  const root=repository.localCatalog.registerRoot({commandId:randomUUID(),sourceRootId:capability.id,role:'library'}),datasetId=randomUUID();
  const events:MetadataReaderLifecycle[]=[],results:MetadataReadResult[]=[];let observationError:unknown;
  const actual=(await loadFreshMetadataReader()).createMetadataReader({onLifecycle(event){events.push(event);try{
    if(event.type==='lease-released')assert.throws(()=>fstatSync(event.fd),{code:'EBADF'});
  }catch(error){observationError??=error;}}});
  const reader:MetadataReaderPort={async read(input,signal){const result=await actual.read(input,signal);results.push(result);return result;},close:()=>actual.close()};
  const context={epoch:randomUUID(),datasetId},admission=createScanReadAdmission({isBusy:()=>false});
  const projection:DatasetProjectionPort={async call<K extends DatasetProjectionCommand>(name:K,payload:DatasetProjectionCommandPayloads[K]):Promise<DatasetProjectionCommandResults[K]>{
    let value:unknown;switch(name){case 'scanReadAcquire':value=admission.acquire(context);break;
      case 'scanReadWatchRevocation':value=await admission.watchRevocation(context,(payload as {permitId:string}).permitId);break;
      case 'scanReadRelease':value=admission.release(context,(payload as {permitId:string}).permitId);break;
      default:throw new Error('权限恢复合成测试仅连接真实扫描admission三接点。');}return value as DatasetProjectionCommandResults[K];}};
  const coordinator=createLocalScanCoordinator({repository,datasetId,assertCurrent(){repository.list({offset:0,limit:1});},projection,reader});
  t.after(async()=>{await chmod(target,0o600);await coordinator.close();admission.close();assert.equal(admission.resourceCounts().permits,0);assert.equal(admission.resourceCounts().watches,0);repository.close();
    assert.equal(sha256(await readFile(target)),sha256(bytes));assert.equal((await lstat(target)).nlink,1);await original.assertUnchanged();});
  async function scan(){const job=coordinator.start({commandId:randomUUID(),libraryRootId:root.id,expectedRootRevision:root.revision});await coordinator.privateWait(job.jobId);return coordinator.get(job.jobId);}
  function quiet(){if(observationError)throw observationError;const starts=events.filter(e=>e.type==='worker-start');
    for(const start of starts){if(start.type!=='worker-start')continue;const from=events.indexOf(start),exit=events.findIndex((e,i)=>i>from&&e.type==='worker-exit'&&e.threadId===start.threadId);assert(exit>from);
      const release=events.findIndex((e,i)=>i>exit&&e.type==='lease-released'&&e.fd===start.fd);assert(release>exit);
      assert(events.findIndex((e,i)=>i>release&&e.type==='read-complete')>release);}
    assert.equal(starts.length,events.filter(e=>e.type==='worker-exit').length);assert.equal(events.filter(e=>e.type==='lease-acquired').length,events.filter(e=>e.type==='lease-released').length);
    assert.equal(admission.resourceCounts().permits,0);for(const result of results)if(result.readEvidence){assert.equal(result.readEvidence.wholeAudioHash,false);assert.equal(result.readEvidence.wholeAudioDecode,false);}}

  const first=await scan();assert.equal(first.phase,'completed');same(first.progress,{visited:'1',accepted:'1',rejected:'0'});same(counts(file),{assets:1,tracks:1});
  const track=repository.localCatalog.pageTracks({offset:0,limit:1}).items[0]!,asset=repository.localCatalog.asset(track.assetId);
  const manualCommand=randomUUID();repository.localCatalog.overrideMetadata({commandId:manualCommand,trackId:track.id,expectedRevision:null,fields:{title:'权限恢复仍保留手动名称'}});
  const metadata=repository.localCatalog.metadata(track.id),manualReceipt=repository.localCatalog.receipt(manualCommand),observations=repository.localCatalog.observations(track.id);
  assert.equal(metadata.raw.title,original.entry('core-flac').expectedTags!.title);quiet();

  try{await chmod(target,0o000);await assert.rejects(readFile(target),{code:'EACCES'});
    const blocked=await scan();assert.equal(blocked.phase,'completed');same(blocked.progress,{visited:'1',accepted:'0',rejected:'1'});
    assert.equal(results.at(-1)!.status,'failure');const last=results.at(-1)!;if(last.status!=='failure')throw new Error('真实权限拒绝不应成功');assert.equal(last.code,'IO_ERROR');
    same(counts(file),{assets:1,tracks:1});same(repository.localCatalog.track(track.id),track);same(repository.localCatalog.asset(track.assetId),asset);
    same(repository.localCatalog.metadata(track.id),metadata);same(repository.localCatalog.observations(track.id),observations);same(repository.localCatalog.receipt(manualCommand),manualReceipt);quiet();
  }finally{await chmod(target,0o600);}
  assert.equal((await lstat(target)).mode&0o777,0o600);assert.equal(sha256(await readFile(target)),sha256(bytes));
  const calls=results.length,workerStarts=events.filter(e=>e.type==='worker-start').length;
  // 明确新command、新job，真实重解析恢复；不是重放老start回执或SQL重建实体。
  const recovered=await scan();assert.equal(recovered.phase,'completed');assert.notEqual(recovered.jobId,first.jobId);same(recovered.progress,{visited:'1',accepted:'1',rejected:'0'});
  assert.equal(results.length-calls,1,'恢复后的唯一源确实重入Reader');assert.equal(results.at(-1)!.status,'ok');
  assert.equal(events.filter(e=>e.type==='worker-start').length-workerStarts,1);quiet();
  same(counts(file),{assets:1,tracks:1});const page=repository.localCatalog.pageTracks({offset:0,limit:200});assert.equal(page.total,1);assert.equal(page.items[0]!.id,track.id);assert.equal(page.items[0]!.assetId,asset.id);
  const restoredAsset=repository.localCatalog.asset(asset.id);assert.equal(restoredAsset.id,asset.id);assert.equal(restoredAsset.libraryRootId,asset.libraryRootId);assert.equal(restoredAsset.sourceRootId,asset.sourceRootId);
  // chmod会改变stat签名，fileRevision可以增加；不能把正确修订递增误判为身份丢失。
  assert(BigInt(restoredAsset.fileRevision)>=BigInt(asset.fileRevision));same(repository.localCatalog.track(track.id),track);
  same(repository.localCatalog.metadata(track.id),metadata);same(repository.localCatalog.receipt(manualCommand),manualReceipt);
  const restoredObservations=repository.localCatalog.observations(track.id);assert(restoredObservations.length>=observations.length);same(restoredObservations.slice(0,observations.length),observations);
  const state=repository.localScan.privateFileState(root.id,relative)!.value;assert.equal(state.outcome,'accepted');assert.equal(state.trackId,track.id);assert.equal(state.assetId,asset.id);assert.equal(state.failureCode,null);
  assert(state.readFacts?.coverEvidence.some(c=>c.sha256===original.entry('core-flac').expectedCover!.sha256));
  const unchangedCalls=results.length,unchanged=await scan();assert.equal(unchanged.phase,'completed');assert.equal(results.length,unchangedCalls,'恢复后再次未变增量不重复解析');same(counts(file),{assets:1,tracks:1});
  assert.equal(sha256(await readFile(target)),sha256(bytes));assert.equal((await lstat(target)).ino,beforeFile.ino);await original.assertUnchanged();quiet();
});
