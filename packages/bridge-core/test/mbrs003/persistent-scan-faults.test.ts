import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {chmod,lstat,mkdir,readFile,rename,utimes,writeFile} from 'node:fs/promises';
import {fstatSync,renameSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {audioFixture,loadFreshMetadataReader,sha256} from '../helpers/mbrs003-audio-fixtures.js';
import {authorizeSourceDirectory,readonlySourceCandidateMetadata} from '../../src/recording/source-files.js';
import {createCollectionRepository} from '../../src/collection/repository.js';
import {createLocalScanCoordinator} from '../../src/collection/local-scan-coordinator.js';
import {createScanReadAdmission} from '../../src/library/scan-read-admission.js';
import type {DatasetProjectionPort,DatasetProjectionCommand,DatasetProjectionCommandPayloads,DatasetProjectionCommandResults} from '../../src/collection/dataset-owner-protocol.js';
import type {MetadataReaderLifecycle,MetadataReaderPort,MetadataReadInput,MetadataReadResult} from '../../src/library/metadata-reader-types.js';

// 所有媒体是独立自有合成copy；普通文件操作控制真实故障，不返回FakeReader结果。
async function fixture(t:test.TestContext,ids:readonly string[],hooks?:{beforeRead?(input:MetadataReadInput):void|Promise<void>;onLifecycle?(event:MetadataReaderLifecycle):void}) {
  const original=await audioFixture(t),directory=path.join(original.directory,'fault-media');await mkdir(directory,{mode:0o700});
  const copies=new Map<string,{id:string;bytes:Buffer}>();
  async function copy(id:string,relative=path.basename(original.entry(id).file)) {
    const bytes=await original.bytes(id);await writeFile(path.join(directory,relative),bytes,{flag:'wx',mode:0o600});
    const info=await lstat(path.join(directory,relative));assert.equal(info.nlink,1);assert.equal(info.mode&0o777,0o600);copies.set(relative,{id,bytes});return relative;
  }
  for(const id of ids)await copy(id);
  const datasetId=randomUUID(),repository=createCollectionRepository({filePath:path.join(original.directory,'faults.sqlite')});
  const cap=repository.sources.authorize(randomUUID(),await authorizeSourceDirectory(directory));
  const root=repository.localCatalog.registerRoot({commandId:randomUUID(),sourceRootId:cap.id,role:'library'});
  const events:MetadataReaderLifecycle[]=[],results:Array<{relative:string;result:MetadataReadResult}>=[];let observationError:unknown;
  const actual=(await loadFreshMetadataReader()).createMetadataReader({onLifecycle(event){events.push(event);try{if(event.type==='lease-released')assert.throws(()=>fstatSync(event.fd),{code:'EBADF'});hooks?.onLifecycle?.(event);}catch(error){observationError??=error;}}});
  const reader:MetadataReaderPort={async read(input,signal){await hooks?.beforeRead?.(input);const result=await actual.read(input,signal);results.push({relative:input.relative,result});return result;},close:()=>actual.close()};
  const admission=createScanReadAdmission({isBusy:()=>false}),context={epoch:randomUUID(),datasetId};
  const projection:DatasetProjectionPort={async call<K extends DatasetProjectionCommand>(name:K,payload:DatasetProjectionCommandPayloads[K]):Promise<DatasetProjectionCommandResults[K]>{
    let value:unknown;switch(name){case 'scanReadAcquire':value=admission.acquire(context);break;
      case 'scanReadWatchRevocation':value=await admission.watchRevocation(context,(payload as {permitId:string}).permitId);break;
      case 'scanReadRelease':value=admission.release(context,(payload as {permitId:string}).permitId);break;
      default:throw new Error('合成fault仅调用真实admission三私有接点。');}return value as DatasetProjectionCommandResults[K];}};
  const coordinator=createLocalScanCoordinator({repository,datasetId,assertCurrent(){repository.list({offset:0,limit:1});},projection,reader});
  let closed=false;
  async function close(){if(closed)return;await coordinator.close();admission.close();assert.equal(admission.resourceCounts().permits,0);assert.equal(admission.resourceCounts().watches,0);repository.close();closed=true;}
  t.after(close);
  async function scan(){const job=coordinator.start({commandId:randomUUID(),libraryRootId:root.id,expectedRootRevision:root.revision});await coordinator.privateWait(job.jobId);return coordinator.get(job.jobId);}
  function quiet(){if(observationError)throw observationError;const starts=events.filter(e=>e.type==='worker-start');
    for(const start of starts){if(start.type!=='worker-start')continue;const from=events.indexOf(start),exit=events.findIndex((e,i)=>i>from&&e.type==='worker-exit'&&e.threadId===start.threadId);
      assert(exit>from);const release=events.findIndex((e,i)=>i>exit&&e.type==='lease-released'&&e.fd===start.fd);assert(release>exit);
      const complete=events.findIndex((e,i)=>i>release&&e.type==='read-complete');assert(complete>release);}
    assert.equal(starts.length,events.filter(e=>e.type==='worker-exit').length);
    assert.equal(events.filter(e=>e.type==='lease-acquired').length,events.filter(e=>e.type==='lease-released').length);
    // FD可能后续被复用；这里在lease-released事件处采样的状态另由EBADF观察者证明。
    assert.equal(admission.resourceCounts().permits,0);
    for(const {result}of results)if(result.readEvidence){assert.equal(result.readEvidence.wholeAudioHash,false);assert.equal(result.readEvidence.wholeAudioDecode,false);}}
  async function byteHold(){await original.assertUnchanged();for(const [relative,item]of copies){const info=await lstat(path.join(directory,relative));assert.equal(info.nlink,1);assert.equal(sha256(await readFile(path.join(directory,relative))),sha256(item.bytes));}}
  t.after(byteHold);
  return {...original,directory,copy,copies,repository,root,cap,coordinator,scan,quiet,byteHold,events,results,
    observeClose(event:MetadataReaderLifecycle){if(event.type==='lease-released')assert.throws(()=>fstatSync(event.fd),{code:'EBADF'});}};
}
function same(a:unknown,b:unknown){assert.equal(isDeepStrictEqual(a,b),true,'合成持久逻辑对象必须精确保持');}
async function seeded(t:test.TestContext,hooks?:Parameters<typeof fixture>[2]) {
  const f=await fixture(t,['core-flac'],hooks);const first=await f.scan();assert.equal(first.phase,'completed');assert.equal(first.progress.accepted,'1');
  const track=f.repository.localCatalog.pageTracks({offset:0,limit:1}).items[0]!;
  const commandId=randomUUID();f.repository.localCatalog.overrideMetadata({commandId,trackId:track.id,expectedRevision:null,fields:{title:'合成手动名称保持'}});
  const before={track,asset:f.repository.localCatalog.asset(track.assetId),metadata:f.repository.localCatalog.metadata(track.id),observations:f.repository.localCatalog.observations(track.id),receipt:f.repository.localCatalog.receipt(commandId)};
  function preserve(){same(f.repository.localCatalog.track(track.id),before.track);same(f.repository.localCatalog.asset(track.assetId),before.asset);same(f.repository.localCatalog.metadata(track.id),before.metadata);same(f.repository.localCatalog.observations(track.id),before.observations);same(f.repository.localCatalog.receipt(commandId),before.receipt);}
  return {...f,track,before,preserve};
}

test('MBRS003 faults：合法FLAC封面/MP3与原截断坏项混合仍逐项完成且全部源字节守恒',{timeout:60_000},async t=>{
  let observe!:(event:MetadataReaderLifecycle)=>void;const f=await fixture(t,['core-flac','core-mp3','truncated-flac'],{onLifecycle:e=>observe?.(e)});observe=f.observeClose;
  const job=await f.scan();assert.equal(job.phase,'completed');same(job.progress,{visited:'3',accepted:'2',rejected:'1'});
  assert.equal(f.repository.localCatalog.pageTracks({offset:0,limit:200}).total,2);
  const bad=f.repository.localScan.privateFileState(f.root.id,path.basename(f.entry('truncated-flac').file))!.value;
  assert.equal(bad.outcome,'rejected');assert.equal(bad.trackId,null);assert.equal(bad.assetId,null);
  const observed=f.results.find(r=>r.relative===path.basename(f.entry('truncated-flac').file))!.result;assert.equal(observed.status,'failure');
  if(observed.status!=='failure')throw new Error('原截断夹具不能假成功');assert(['PARSE_FAILED','UNSUPPORTED'].includes(observed.code));assert.equal(bad.failureCode,observed.code);
  const flac=f.repository.localScan.privateFileState(f.root.id,path.basename(f.entry('core-flac').file))!.value;assert(flac.readFacts);
  assert(flac.readFacts.coverEvidence.some(c=>c.sha256===f.entry('core-flac').expectedCover!.sha256));
  assert.equal(f.repository.localCatalog.metadata(flac.trackId!).raw.title,f.entry('core-flac').expectedTags!.title);
  f.quiet();await f.byteHold();
});

test('MBRS003 faults：真实文件EACCES保留旧ID/raw/manual并继续新增可读项',{timeout:60_000},async t=>{
  assert(typeof process.getuid==='function'&&process.getuid()>0,'权限fault要求普通用户，root身份不能冒充EACCES');
  let observe!:(event:MetadataReaderLifecycle)=>void;const f=await seeded(t,{onLifecycle:e=>observe?.(e)});observe=f.observeClose;
  const relative=path.basename(f.entry('core-flac').file),target=path.join(f.directory,relative);await f.copy('core-mp3','added-readable.mp3');
  try{await chmod(target,0o000);await assert.rejects(readFile(target),{code:'EACCES'});
    const job=await f.scan();assert.equal(job.phase,'completed');same(job.progress,{visited:'2',accepted:'1',rejected:'1'});
    const state=f.repository.localScan.privateFileState(f.root.id,relative)!.value;assert.equal(state.failureCode,'IO_ERROR');assert.equal(state.trackId,f.track.id);assert.equal(state.assetId,f.track.assetId);
    assert.equal(f.repository.localCatalog.pageTracks({offset:0,limit:200}).total,2);f.preserve();f.quiet();
    assert(f.results.some(r=>r.relative==='added-readable.mp3'&&r.result.status==='ok'),'新增可读项必须真实Reader接受');
  }finally{await chmod(target,0o600);}await f.byteHold();
});

test('MBRS003 faults：真实自有根暂时离线只暂停且恢复后未变源不重解析',{timeout:60_000},async t=>{
  let observe!:(event:MetadataReaderLifecycle)=>void;const f=await seeded(t,{onLifecycle:e=>observe?.(e)});observe=f.observeClose;
  const moved=path.join(path.dirname(f.directory),'fault-media-temporarily-offline');let paused:Awaited<ReturnType<typeof f.scan>>|undefined;
  const reads=f.results.length;
  try{await rename(f.directory,moved);paused=await f.scan();assert.equal(paused.phase,'paused');same(paused.progress,{visited:'0',accepted:'0',rejected:'0'});assert.equal(f.results.length,reads);f.preserve();}
  finally{await rename(moved,f.directory);}
  assert(paused);f.coordinator.resume({commandId:randomUUID(),jobId:paused.jobId,expectedRevision:paused.jobRevision});await f.coordinator.privateWait(paused.jobId);
  assert.equal(f.coordinator.get(paused.jobId).phase,'completed');assert.equal(f.results.length,reads);f.preserve();f.quiet();await f.byteHold();
});

test('MBRS003 faults：真实SourceStore撤销拒绝新start且旧曲目/raw/手动回执完整保持',{timeout:60_000},async t=>{
  let observe!:(event:MetadataReaderLifecycle)=>void;const f=await seeded(t,{onLifecycle:e=>observe?.(e)});observe=f.observeClose;
  const jobs=f.coordinator.page({offset:0,limit:200}),reads=f.results.length;
  f.repository.sources.revoke({commandId:randomUUID(),id:f.cap.id});assert.equal(f.repository.sources.root(f.cap.id).authorized,false);
  assert.throws(()=>f.coordinator.start({commandId:randomUUID(),libraryRootId:f.root.id,expectedRootRevision:f.root.revision}));
  same(f.coordinator.page({offset:0,limit:200}),jobs);assert.equal(f.results.length,reads);assert.equal(f.repository.localCatalog.pageTracks({offset:0,limit:200}).total,1);
  f.preserve();f.quiet();await f.byteHold();
});

test('MBRS003 faults：发现后真实文件消失仍提交另一可读项，不伪造missing签名',{timeout:60_000},async t=>{
  let f!:Awaited<ReturnType<typeof fixture>>,movedRelative:string|undefined,controlled=false;let observe!:(event:MetadataReaderLifecycle)=>void;
  const isolated=()=>path.join(path.dirname(f.directory),'discovered-missing-quarantine.wav');
  f=await fixture(t,['core-wav','core-mp3'],{onLifecycle:e=>observe?.(e),async beforeRead(input){if(controlled)return;controlled=true;
    // Walk已发现同批两relative；透明port只变自有FS，实际结果全部来自compiled Reader。
    movedRelative=[...f.copies.keys()].find(relative=>relative!==input.relative);assert(movedRelative);renameSync(path.join(f.directory,movedRelative),isolated());
    await assert.rejects(readonlySourceCandidateMetadata(input.root,movedRelative),{code:'MISSING'});}});observe=f.observeClose;
  let retainedTrackId:string|undefined;
  try{const job=await f.scan();assert.equal(controlled,true);assert.equal(f.results.length,1);assert.equal(f.results[0]!.result.status,'ok');
    assert.equal(job.phase,'completed','单文件MISSING不能使其它有效项整批丢弃');
    same(job.progress,{visited:'1',accepted:'1',rejected:'0'});assert.equal(f.repository.localCatalog.pageTracks({offset:0,limit:200}).total,1);
    assert.equal(f.repository.localScan.privateFileState(f.root.id,movedRelative!),null,'未取得stat不持久化虚构signature/asset');retainedTrackId=f.repository.localCatalog.pageTracks({offset:0,limit:1}).items[0]!.id;f.quiet();
  }finally{if(movedRelative)await rename(isolated(),path.join(f.directory,movedRelative));}
  const reads=f.results.length,recovered=await f.scan();assert.equal(recovered.phase,'completed');same(recovered.progress,{visited:'2',accepted:'2',rejected:'0'});assert.equal(f.results.length-reads,1);
  const tracks=f.repository.localCatalog.pageTracks({offset:0,limit:200});assert.equal(tracks.total,2);assert(tracks.items.some(track=>track.id===retainedTrackId));f.quiet();await f.byteHold();
});

test('MBRS003 faults：实际Worker启动后合法音频改变先CONTENT_CHANGED再重读，稳定ID/manual保持',{timeout:60_000},async t=>{
  let f!:Awaited<ReturnType<typeof seeded>>,armed=false,changed=false;let observationError:unknown;let observe!:(event:MetadataReaderLifecycle)=>void;let replacement!:Buffer;
  f=await seeded(t,{onLifecycle(event){try{observe?.(event);if(armed&&!changed&&event.type==='worker-start'){changed=true;writeFileSync(path.join(f.directory,path.basename(f.entry('core-flac').file)),replacement);}}catch(error){observationError??=error;}}});observe=f.observeClose;
  const relative=path.basename(f.entry('core-flac').file),target=path.join(f.directory,relative),original=await readFile(target);replacement=await f.bytes('core-mp3');
  try{const stat=await lstat(target);await utimes(target,stat.atime,new Date(stat.mtimeMs+2000));armed=true;
    const job=await f.scan();if(observationError)throw observationError;assert.equal(changed,true);assert.equal(job.phase,'completed');same(job.progress,{visited:'1',accepted:'1',rejected:'0'});
    assert(f.results.some(r=>r.relative===relative&&r.result.status==='failure'&&r.result.code==='CONTENT_CHANGED'));
    const state=f.repository.localScan.privateFileState(f.root.id,relative)!.value;assert.equal(state.outcome,'accepted');assert.equal(state.trackId,f.track.id);assert.equal(state.assetId,f.track.assetId);
    assert.equal(f.repository.localCatalog.pageTracks({offset:0,limit:200}).total,1);const metadata=f.repository.localCatalog.metadata(f.track.id);
    assert.equal(metadata.raw.title,f.entry('core-mp3').expectedTags!.title);assert.equal(metadata.effective.title,'合成手动名称保持');same(metadata.override,f.before.metadata.override);
    assert.equal(state.readFacts!.technical.container,'MPEG');assert.equal(sha256(await readFile(target)),sha256(replacement));f.quiet();
  }finally{await writeFile(target,original);}await f.byteHold();
});
