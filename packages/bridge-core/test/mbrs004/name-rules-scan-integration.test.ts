import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, chmod, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { createLocalScanCoordinator } from '../../src/collection/local-scan-coordinator.js';
import { authorizeSourceDirectory } from '../../src/recording/source-files.js';
import { createScanReadAdmission } from '../../src/library/scan-read-admission.js';
import { resolveAlbumNameCandidates, inferAlbumBoundaries } from '../../src/library/local-name-rules.js';
import type { DatasetProjectionPort, DatasetProjectionCommand, DatasetProjectionCommandPayloads, DatasetProjectionCommandResults } from '../../src/collection/dataset-owner-protocol.js';
import type { MetadataReaderPort } from '../../src/library/metadata-reader-types.js';
import { buildStoragePolicy } from '../../../../apps/desktop/scripts/build-storage-root.mjs';

test('MBRS004 AT005/006：关闭AI，实际扫描入库与重扫保留人工名称、发行版成员和CD边界', { timeout: 30_000 }, async t => {
  const policy = buildStoragePolicy(), temporary = policy.check(process.env.TMPDIR!, { mustExist: true });
  const directory = await mkdtemp(path.join(temporary, 'musicbridge-mbrs004-rules-')); await chmod(directory, 0o700);
  const media = path.join(directory, '合成媒体'); await mkdir(media, { mode: 0o700 });
  const bytes = Buffer.from('MBRS004 合成Reader事实，不是可播放音频');
  for (const cd of ['CD1', 'CD2']) { await mkdir(path.join(media, cd), { mode: 0o700 }); await writeFile(path.join(media, cd, '01.wav'), bytes, { flag: 'wx', mode: 0o600 }); }
  const repository = createCollectionRepository({ filePath: path.join(directory, 'collection.v1.sqlite') });
  const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media));
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
  const context = { datasetId: randomUUID(), epoch: randomUUID() }, admission = createScanReadAdmission({ isBusy: () => false });
  const projection: DatasetProjectionPort = { async call<K extends DatasetProjectionCommand>(command: K, payload: DatasetProjectionCommandPayloads[K]): Promise<DatasetProjectionCommandResults[K]> {
    let result: unknown;
    if (command === 'scanReadAcquire') result = admission.acquire(context);
    else if (command === 'scanReadWatchRevocation') result = await admission.watchRevocation(context, (payload as { permitId: string }).permitId);
    else if (command === 'scanReadRelease') result = admission.release(context, (payload as { permitId: string }).permitId);
    else throw new Error('本验收关闭AI和外部投影，只允许实际扫描票据');
    return result as DatasetProjectionCommandResults[K];
  } };
  let reads = 0, changed = false;
  // Reader标签为受控合成事实；coordinator、stat、准入、唯一持久writer均为生产本体。
  const reader: MetadataReaderPort = { async read(input) {
    reads++;
    const updated = changed && input.relative === 'CD1/01.wav';
    return { status: 'ok', parserVersion: 'music-metadata-11.15.0/mbrs003-v4', fields: { title: updated ? '新标签歌曲' : '歌曲 [首版]', artist: '歌手', album: updated ? '专辑 [Remastered]' : '专辑 [首版]' },
      technical: { container: 'WAVE', codec: 'PCM', lossless: true, sampleRateHz: 48000, channels: 2, bitsPerSample: 16, durationSeconds: 1, evidence: 'bounded-parser-reported' }, coverEvidence: [],
      readEvidence: { bytesRead: bytes.length, readCalls: 1, maxReadBytes: bytes.length, allocationBytes: bytes.length, elapsedMs: 1, wholeAudioHash: false, wholeAudioDecode: false } };
  }, async close() {} };
  const coordinator = createLocalScanCoordinator({ repository, datasetId: context.datasetId, assertCurrent: () => { repository.list({ offset: 0, limit: 1 }); }, projection, reader });
  t.after(async () => { await coordinator.close(); admission.close(); repository.close(); });
  const scan = async () => {
    const started = coordinator.start({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision });
    await coordinator.privateWait(started.jobId); assert.equal(coordinator.get(started.jobId).phase, 'completed');
    assert.deepEqual(coordinator.get(started.jobId).progress, { visited: '2', accepted: '2', rejected: '0' });
  };
  await scan(); assert.equal(reads, 2);
  const tracks = repository.localCatalog.pageTracks({ offset: 0, limit: 200 }).items;
  const edition = repository.localCatalog.createEdition({ commandId: randomUUID(), title: '人工专辑', edition: '人工发行版 [首版]' });
  const links = tracks.map((track, index) => repository.localCatalog.linkEditionTrack({ commandId: randomUUID(), editionId: edition.id, trackId: track.id, disc: index + 1, trackNumber: 1, sequence: index + 1 }));
  for (const track of tracks) repository.localCatalog.overrideMetadata({ commandId: randomUUID(), trackId: track.id, expectedRevision: null, fields: { title: '人工歌曲', artist: '人工歌手', album: '人工专辑' } });
  const before = tracks.map(track => repository.localCatalog.metadata(track.id));
  await scan(); assert.equal(reads, 2, '未变文件跳过Reader，AI关闭不妨碍现有增量建库');
  assert.deepEqual(repository.localCatalog.pageTracks({ offset: 0, limit: 200 }).items, tracks);
  assert.deepEqual(repository.localCatalog.editionTracks(edition.id), links);
  assert.deepEqual(tracks.map(track => repository.localCatalog.metadata(track.id)), before);
  const members = tracks.map(track => ({ trackId: track.id, ...repository.localCatalog.metadata(track.id).raw }));
  const input = { artistName: '歌手', albumName: '专辑 [首版]', members, manual: { artistName: '人工歌手', albumName: '人工专辑', boundaryId: edition.id }, aiMode: 'off' as const };
  const names = resolveAlbumNameCandidates(input);
  assert.equal(names.artist.display, '人工歌手'); assert.equal(names.album.display, '人工专辑'); assert.equal(names.manual?.boundaryId, edition.id);
  assert.deepEqual(names.members.map(member => member.trackId), tracks.map(track => track.id));
  assert.ok(names.memberEvidence.every(member => member.album?.raw === '专辑 [首版]' && member.album.versionTokens.some(token => token.raw === '首版')));
  const facts = [{ id: root.id, parentId: null, name: '根', directAudioCount: 0 }, { id: edition.id, parentId: root.id, name: '专辑', directAudioCount: 0 }, ...links.map((link, index) => ({ id: link.id, parentId: edition.id, name: `CD${index + 1}`, directAudioCount: 1 }))];
  assert.deepEqual(inferAlbumBoundaries(facts, root.id).map(candidate => candidate.boundaryId), [edition.id, edition.id]);
  assert.equal(inferAlbumBoundaries(facts, root.id, [{ directoryId: links[0]!.id, boundaryId: edition.id }])[0]?.reason, 'manual');
  // 仅主动改变测试私有副本，让第三次扫描进入新raw观察路径，而非复用旧签名。
  const updatedBytes = Buffer.concat([bytes, Buffer.from(' 合成标签更新')]);
  await writeFile(path.join(media, 'CD1', '01.wav'), updatedBytes); changed = true;
  const changedTrackId = repository.localScan.privateFileState(root.id, 'CD1/01.wav')!.value.trackId!;
  const beforeObservations = repository.localCatalog.observations(changedTrackId).length;
  await scan(); assert.equal(reads, 3, '只有签名变化的CD1重新读取，CD2保持增量复用');
  assert.equal(repository.localCatalog.observations(changedTrackId).length, beforeObservations + 1);
  assert.equal(repository.localCatalog.metadata(changedTrackId).raw.title, '新标签歌曲');
  assert.equal(repository.localCatalog.metadata(changedTrackId).raw.album, '专辑 [Remastered]');
  assert.deepEqual(repository.localCatalog.pageTracks({ offset: 0, limit: 200 }).items, tracks);
  assert.deepEqual(repository.localCatalog.edition(edition.id), edition);
  assert.deepEqual(repository.localCatalog.editionTracks(edition.id), links);
  for (const track of tracks) assert.deepEqual(repository.localCatalog.metadata(track.id).effective, { title: '人工歌曲', artist: '人工歌手', album: '人工专辑' });
  const rescanned = resolveAlbumNameCandidates({ ...input, members: tracks.map(track => ({ trackId: track.id, ...repository.localCatalog.metadata(track.id).raw })) });
  assert.equal(rescanned.album.display, '人工专辑'); assert.equal(rescanned.manual?.boundaryId, edition.id);
  assert.ok(rescanned.memberEvidence.find(member => member.trackId === changedTrackId)?.album?.versionTokens.some(token => token.raw === 'Remastered'));
  for (const cd of ['CD1', 'CD2']) {
    const expected = cd === 'CD1' ? updatedBytes : bytes;
    assert.equal(createHash('sha256').update(await readFile(path.join(media, cd, '01.wav'))).digest('hex'), createHash('sha256').update(expected).digest('hex'));
  }
});

test('CD01规则候选：同一多碟目录artist保两边界、album合一边界及名称来源，原音频CUE事实不变', async () => {
  const {discoverAlbumDirectoryCandidates}=await import('../../src/library/local-name-rules.js')
  const root='自有/周杰伦/七里香'
  const input={root,audioPaths:[root+'/CD2/01.wav',root+'/CD1/02.wav',root+'/CD1/01.wav'],
    cuePaths:[root+'/CD1/index.cue',root+'/CD2/index.cue'],directoryPaths:[root,root+'/CD1',root+'/CD2']}
  const before=structuredClone(input)
  const artist=discoverAlbumDirectoryCandidates({...input,role:'artist'})
  const album=discoverAlbumDirectoryCandidates({...input,role:'album'})
  assert.equal(artist.error,null);assert.equal(album.error,null)
  assert.deepEqual(artist.albums.map(value=>[value.boundaryPath,value.artistName,value.albumName,value.relativeAudioPaths,value.relativeCuePaths]),[
    [root+'/CD1','七里香','CD1',['01.wav','02.wav'],['index.cue']],
    [root+'/CD2','七里香','CD2',['01.wav'],['index.cue']],
  ])
  assert.equal(album.albums.length,1)
  assert.deepEqual(album.albums.map(value=>[value.boundaryPath,value.artistName,value.albumName,value.relativeAudioPaths,value.relativeCuePaths]),[
    [root,'周杰伦','七里香',['CD1/01.wav','CD1/02.wav','CD2/01.wav'],['CD1/index.cue','CD2/index.cue']],
  ])
  assert.deepEqual(artist.looseAudioPaths,[]);assert.deepEqual(album.looseAudioPaths,[])
  const originalMembers=input.audioPaths.map((_,index)=>({trackId:'role-track-'+index,artist:'',album:''}))
  const names=resolveAlbumNameCandidates({artistName:album.albums[0]!.artistName,albumName:album.albums[0]!.albumName,
    members:originalMembers,aiMode:'off'})
  assert.equal(names.artist.display,'周杰伦');assert.equal(names.album.display,'七里香')
  assert.deepEqual(names.rawNames,{artistName:'周杰伦',albumName:'七里香'})
  assert.deepEqual(names.members,originalMembers)
  assert.deepEqual(input,before,'角色分析与名称候选不得改写原捕获的路径/CUE/成员事实')
})

import {once as cd01Once} from 'node:events'
/** CD01组件：测试Domain只注入真实fresh Reader；唯一Scanner正常写同SQL，冷Worker仍走默认工厂；不授Main/Native资格。 */
async function cd01RoleFixture(t:import('node:test').TestContext,role:import('@music-bridge/contracts').LocalLibraryRole|null,
  rootNames:readonly [string,string],relatives:readonly string[]) {
  const {createBackupWorkflowStore}=await import('../../src/recording/backup-workflow-store.js')
  const {createTestDatasetDomain}=await import('../../src/collection/dataset-domain.js')
  const {createCueSyntheticWave}=await import('../../src/library/local-cue-format-qualification.js')
  const {loadFreshMetadataReader}=await import('../helpers/mbrs003-audio-fixtures.js')
  const {localLibraryManagementDigest}=await import('../../src/collection/local-library-workbench/owner-journal.js')
  const {fstatSync}=await import('node:fs')
  const policy=buildStoragePolicy(),temporary=policy.check(process.env.TMPDIR!,{mustExist:true})
  const directory=await mkdtemp(path.join(temporary,'musicbridge-cd01-role-'));await chmod(directory,0o700)
  const media=path.join(directory,...rootNames);await mkdir(media,{recursive:true,mode:0o700})
  const bytes=createCueSyntheticWave(4800).wave
  for(const relative of relatives){await mkdir(path.dirname(path.join(media,relative)),{recursive:true,mode:0o700});await writeFile(path.join(media,relative),bytes,{flag:'wx',mode:0o600})}
  const file=path.join(directory,'collection.v1.sqlite'),repository=createCollectionRepository({filePath:file}),state=createBackupWorkflowStore({filePath:path.join(directory,'backup-maintenance.v1.sqlite')})
  repository.localCatalog.roots();const identity=state.datasetIdentities.bind('default',file,true),epoch=randomUUID()
  repository.localCatalog.privateBindWorkbenchDataset(identity)
  const source=repository.sources.authorize(randomUUID(),await authorizeSourceDirectory(media)),root=repository.localCatalog.registerRoot({commandId:randomUUID(),sourceRootId:source.id,role:'library'})
  function bind(selected:import('@music-bridge/contracts').LocalLibraryRole){
    const commandId=randomUUID(),old=repository.localCatalog.privateLibraryManagementRead(identity,'binding',root.id)
    const original={command:'library.import.confirm' as const,request:{commandId,choiceId:randomUUID(),role:selected}}
    const operation:import('../../src/collection/local-library-workbench/owner-journal.js').LocalLibraryManagementOperationRecord={schema:1,kind:'operation',datasetId:identity.datasetId,key:commandId,revision:1,original,originalSha256:localLibraryManagementDigest(original),receipt:{commandId,kind:'library.import.confirm',state:'succeeded',libraryIds:[root.id],message:null}}
    const binding:import('../../src/collection/local-library-workbench/owner-journal.js').LocalLibraryManagementBindingRecord={schema:1,kind:'binding',datasetId:identity.datasetId,key:root.id,revision:(old?.record.revision??0)+1,libraryId:root.id,sourceRootId:root.sourceRootId,rootRevision:root.revision,role:selected,name:rootNames[1],active:true,watchEnabled:false,operationId:commandId}
    return repository.localCatalog.privateLibraryManagementCompareAndSwap(identity,[{record:operation,expectedRevision:null},{record:binding,expectedRevision:old?.record.revision??null}])
  }
  if(role!==null)bind(role)
  const admission=createScanReadAdmission({isBusy:()=>false}),context={datasetId:identity.datasetId,epoch}
  const projection:DatasetProjectionPort={async call<K extends DatasetProjectionCommand>(command:K,payload:DatasetProjectionCommandPayloads[K]):Promise<DatasetProjectionCommandResults[K]>{
    let result:unknown
    if(command==='scanReadAcquire')result=admission.acquire(context)
    else if(command==='scanReadWatchRevocation')result=await admission.watchRevocation(context,(payload as {permitId:string}).permitId)
    else if(command==='scanReadRelease')result=admission.release(context,(payload as {permitId:string}).permitId)
    else throw new Error('CD01正常扫描只消费原实际扫描准入，不提供外部Provider或Source写许可。')
    return result as DatasetProjectionCommandResults[K]
  }}
  const {createCompletedScanSnapshotView}=await import('../../src/collection/local-scan-snapshot-view.js')
  const completed=createCompletedScanSnapshotView({repository,identity})
  let domain:ReturnType<typeof createTestDatasetDomain>|undefined,closed=false
  const close=async()=>{if(closed)return;if(domain)await domain.close();else{repository.close();state.close()}completed.close();admission.close();closed=true}
  t.after(close)
  const lifecycle:import('../../src/library/metadata-reader-types.js').MetadataReaderLifecycle[]=[],fdClosed:string[]=[]
  const {createMetadataReader}=await loadFreshMetadataReader()
  const reader=createMetadataReader({onLifecycle(event){lifecycle.push(event);if(event.type==='lease-released'){
    try{fstatSync(event.fd);fdClosed.push('STILL_OPEN')}catch(error){fdClosed.push((error as NodeJS.ErrnoException).code??'UNKNOWN')}}}})
  const domainOptions={collectionRepository:repository,backupWorkflowStore:state,collectionDatasetIdentity:identity,localSourceEpoch:epoch,projection,scanMetadataReader:reader}
  domain=createTestDatasetDomain(domainOptions)
  await domain.prepareWorkbench();assert.ok(domain.dispatchWorkbenchOwner);assert.ok(domain.localAlbums)
  const scanner=domain.localScan
  const started=scanner.start({commandId:randomUUID(),libraryRootId:root.id,expectedRootRevision:root.revision});await scanner.privateWait(started.jobId)
  assert.equal(scanner.get(started.jobId).phase,'completed');assert.deepEqual(scanner.get(started.jobId).progress,{visited:String(relatives.length),accepted:String(relatives.length),rejected:'0'})
  assert.ok(completed.load(root.id).lastSuccess)
  const exits=lifecycle.filter((event):event is Extract<import('../../src/library/metadata-reader-types.js').MetadataReaderLifecycle,{type:'worker-exit'}>=>event.type==='worker-exit')
  assert.equal(exits.length,relatives.length);assert.ok(exits.every(event=>event.exitCode===0));assert.deepEqual(fdClosed,relatives.map(()=>'EBADF'))
  const tracks=repository.localCatalog.queryTracks({rootId:root.id,query:'',offset:0,limit:200}).items
  assert.equal(tracks.length,relatives.length)
  for(const relative of relatives){const scanned=repository.localScan.privateFileState(root.id,relative);assert.equal(scanned?.value.outcome,'accepted');assert.ok(scanned?.value.assetId&&scanned.value.trackId);assert.equal(scanned.value.readFacts?.technical.container,'WAVE')}
  const raw=tracks.map(item=>repository.localCatalog.metadata(item.track.id)),rootBefore=repository.localCatalog.root(root.id),sourceBefore=repository.sources.root(source.id)
  const query=()=>domain!.localAlbums!.queryAlbums({rootId:root.id,query:'',filter:'all',offset:0,limit:200})
  async function capture(album:import('@music-bridge/contracts').LocalAlbumSummary){
    const group=await domain!.localAlbums!.inspectAlbum({albumKey:album.id,rootId:root.id,revision:album.revision}),request={albums:[{albumId:album.id,rootId:root.id,title:album.title,artist:album.artists[0]??'',trackIds:group.members.map(item=>item.fact.summary.track.id)}]}
    const value=await domain!.dispatchWorkbenchOwner!({command:'read.albums',payload:request},{identity:context,signal:new AbortController().signal,deadlineAtMs:performance.now()+2000})
    const dto=await import('@music-bridge/contracts');assert.ok(dto.isLocalWorkbenchReadback(value,request));assert.equal(value.albums.length,1)
    const reference={datasetId:identity.datasetId,capture:value.albums[0]!.capture},resolved=await domain!.dispatchWorkbenchOwner!({command:'read.resolveCapture',payload:reference},{identity:context,signal:new AbortController().signal,deadlineAtMs:performance.now()+2000})
    const {isDatasetWorkbenchOwnerResult}=await import('../../src/collection/dataset-owner-protocol.js')
    assert.ok(isDatasetWorkbenchOwnerResult('read.resolveCapture',resolved,reference,identity.datasetId));return {reference,resolved,snapshot:value.albums[0]!}
  }
  async function unchanged(){assert.deepEqual(repository.localCatalog.root(root.id),rootBefore);assert.deepEqual(repository.sources.root(source.id),sourceBefore);assert.deepEqual(tracks.map(item=>repository.localCatalog.metadata(item.track.id)),raw)
    for(const relative of relatives)assert.deepEqual(await readFile(path.join(media,relative)),bytes)}
  async function cold(){
    await unchanged();await close()
    const {Worker}=await import('node:worker_threads'),{createDatasetOwnerClient}=await import('../../src/collection/dataset-owner-client.js')
    const factoryCount=new Int32Array(new SharedArrayBuffer(4)),fatals:string[]=[]
    const script=`import {parentPort,workerData} from 'node:worker_threads';\nimport {attachDatasetOwnerWorkerPort} from ${JSON.stringify(new URL('../../src/collection/dataset-owner-worker.ts',import.meta.url).href)};\nimport {prepareOwnedDatasetDomain} from ${JSON.stringify(new URL('../../src/collection/dataset-domain.ts',import.meta.url).href)};\nattachDatasetOwnerWorkerPort(parentPort,{async prepare(epoch,projection){const domain=await prepareOwnedDatasetDomain({dataDirectory:workerData.directory,epoch,testMode:false,projection});if(Atomics.add(new Int32Array(workerData.factoryCount),0,1)!==0)throw new Error('CD01冷Owner工厂不能重复创建。');return domain;}});`
    const worker=new Worker(new URL('data:text/javascript,'+encodeURIComponent(script)),{execArgv:['--import','tsx'],workerData:{directory,factoryCount:factoryCount.buffer}}),endpoint=createDatasetOwnerClient({worker,onFatal:reason=>fatals.push(reason)}),exit=cd01Once(worker,'exit')
    void exit.catch(()=>undefined)
    t.after(async()=>{if(worker.threadId!==-1){const code=await worker.terminate();t.diagnostic(`CD01失败清理terminate=${code}，不计自然关闭。`)}})
    const current=await endpoint.prepare();assert.equal(current.datasetId,identity.datasetId);await endpoint.commitBoot()
    assert.ok(endpoint.readLocalAlbum)
    const dto=await import('@music-bridge/contracts'),request={rootId:root.id,query:'',filter:'all' as const,offset:0,limit:200},page=await endpoint.readLocalAlbum({command:'localAlbum.query',payload:request})
    assert.ok(dto.isLocalAlbumPage(page,request));assert.equal(Atomics.load(factoryCount,0),1)
    await endpoint.close();assert.deepEqual(await exit,[0]);assert.equal(worker.threadId,-1);assert.deepEqual(fatals,[])
    return page
  }
  return {repository,identity,epoch,domain,root,tracks,bind,query,capture,unchanged,cold}
}

test('CD01真实Owner：单张专辑角色正常Reader扫描多碟后完整合组和目录名称捕获，冷默认Worker保留同身份',{timeout:30_000},async t=>{
  const f=await cd01RoleFixture(t,'album',['周杰伦','七里香'],['CD2/02.wav','CD1/01.wav','散落.wav']),page=await f.query()
  assert.equal(page.total,1);assert.equal(page.counts.all,1);assert.equal(page.items[0]!.title,'七里香');assert.deepEqual(page.items[0]!.artists,['周杰伦']);assert.equal(page.items[0]!.trackCount,3)
  assert.equal(page.items[0]!.statuses.includes('loose-audio'),false)
  const captured=await f.capture(page.items[0]!);assert.equal(captured.resolved.capture.artistName,'周杰伦');assert.equal(captured.resolved.capture.albumName,'七里香');assert.deepEqual(captured.snapshot.searchNames?.original,{artist:'周杰伦',title:'七里香'});assert.deepEqual(captured.snapshot.searchNames?.cleaned,{artist:'周杰伦',title:'七里香'})
  assert.deepEqual(new Set(captured.resolved.group.members.map(item=>item.fact.relative)),new Set(['CD2/02.wav','CD1/01.wav','散落.wav']))
  assert.deepEqual(new Set(captured.resolved.capture.members.map(item=>item.trackId)),new Set(f.tracks.map(item=>item.track.id)));assert.ok(captured.resolved.capture.members.every(member=>member.scan?.failureCode===null));assert.equal(captured.resolved.directoryFacts.files.length,3);assert.ok(page.items.every(album=>album.editionId===null))
  const cold=await f.cold();assert.deepEqual(cold,page)
})

test('CD01真实Owner：歌手目录按正常扫描的专辑CD边界分组，散落成员保留且缺标签名称不冒人工或AI',{timeout:30_000},async t=>{
  const f=await cd01RoleFixture(t,'artist',['自有','周杰伦 25张'],['七里香/CD1/FLAC/01.wav','七里香/CD2/FLAC/02.wav','八度空间/01.wav','散落.wav']),page=await f.query()
  assert.equal(page.total,3);assert.deepEqual(new Set(page.items.map(album=>album.title)),new Set(['七里香','八度空间','散落音频']))
  const album=page.items.find(item=>item.title==='七里香')!;assert.equal(album.trackCount,2);assert.deepEqual(album.artists,['周杰伦'])
  const captured=await f.capture(album);assert.deepEqual(captured.snapshot.searchNames?.original,{artist:'周杰伦',title:'七里香'});assert.deepEqual(captured.snapshot.searchNames?.cleaned,{artist:'周杰伦',title:'七里香'});assert.ok(captured.resolved.capture.members.every(member=>member.scan?.failureCode===null));assert.equal(captured.resolved.directoryFacts.files.length,2);assert.equal(captured.resolved.capture.artistName,'周杰伦');assert.equal(captured.resolved.capture.albumName,'七里香');assert.equal(captured.resolved.capture.manualLocks?.artistName,false);assert.equal(captured.resolved.capture.manualLocks?.albumName,false)
  assert.ok(captured.resolved.capture.members.every(member=>member.trackId!==null&&f.repository.localCatalog.metadata(member.trackId).raw.artist===undefined))
  const ids=new Set<string>();for(const item of page.items){const group=await f.domain.localAlbums!.inspectAlbum({albumKey:item.id,rootId:f.root.id});for(const member of group.members){assert.equal(ids.has(member.fact.summary.track.id),false);ids.add(member.fact.summary.track.id)}}assert.deepEqual(ids,new Set(f.tracks.map(item=>item.track.id)))
  const cold=await f.cold();assert.deepEqual(cold,page)
})

test('CD01真实Owner：旧catalog和container及无绑定完整成员不变，角色绑定换代拒绝旧capture而不改Source或标签',{timeout:30_000},async t=>{
  const f=await cd01RoleFixture(t,null,['自有','旧库'],['CD1/01.wav','CD2/02.wav','散落.wav']),legacy=await f.query();assert.equal(legacy.total,3)
  const projection=(page:import('@music-bridge/contracts').LocalAlbumPage)=>page.items.map(({revision,...album})=>album)
  f.bind('catalog');const catalog=await f.query();assert.deepEqual(projection(catalog),projection(legacy))
  const before=await f.capture(catalog.items[0]!),operation=f.bind('container'),container=await f.query();assert.deepEqual(projection(container),projection(catalog))
  assert.notEqual(container.items[0]!.revision,catalog.items[0]!.revision);assert.ok(operation.records.some(record=>record.record.kind==='binding'&&record.record.role==='container'))
  await assert.rejects(f.domain.localAlbums!.inspectAlbum({albumKey:catalog.items[0]!.id,rootId:f.root.id,revision:catalog.items[0]!.revision}),error=>error instanceof Error&&'code'in error&&error.code==='SNAPSHOT_CHANGED')
  assert.throws(()=>f.domain.dispatchWorkbenchOwner!({command:'read.resolveCapture',payload:before.reference},{identity:{datasetId:f.identity.datasetId,epoch:randomUUID()},signal:new AbortController().signal,deadlineAtMs:performance.now()+2000}),error=>error instanceof Error&&'code'in error&&error.code==='INVENTORY_UNAVAILABLE')
  // 原合法作者仍须拒旧token，不能以另一个epoch的上游拒绝替代。
  await assert.rejects(f.domain.dispatchWorkbenchOwner!({command:'read.resolveCapture',payload:before.reference},{identity:{datasetId:f.identity.datasetId,epoch:f.epoch},signal:new AbortController().signal,deadlineAtMs:performance.now()+2000}),error=>error instanceof Error&&'code'in error&&error.code==='CHANGED')
  await f.unchanged();const cold=await f.cold();assert.deepEqual(cold,container)
})
