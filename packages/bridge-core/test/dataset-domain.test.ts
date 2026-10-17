import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { IpcRequest, PhysicalLinkResult, MasterDraftResult } from '@music-bridge/contracts';
import { createCollectionRepository } from '../src/collection/repository.js';
import { createBackupWorkflowStore } from '../src/recording/backup-workflow-store.js';
import { createDatasetDomain, createTestDatasetDomain, prepareOwnedDatasetDomain, createCollectionRoonProjectionPort } from '../src/collection/dataset-domain.js';
import type { DatasetProjectionPort, DatasetProjectionCommand, DatasetProjectionCommandPayloads } from '../src/collection/dataset-owner-protocol.js';
import { createSyntheticRoonLibrary } from '../src/roon/synthetic-library.js';
import { recordingPlanFixture } from './helpers/recording-plan-fixture.js';
import type { RecordingAttemptDriverRequest } from '../src/recording/attempt-coordinator.js';

const page = { offset: 0, limit: 20 };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function projectionPort(handler: (command: DatasetProjectionCommand, payload: DatasetProjectionCommandPayloads[DatasetProjectionCommand]) => Promise<unknown>): DatasetProjectionPort {
  return { call: handler as DatasetProjectionPort['call'] };
}
async function projectionFixture(t: test.TestContext) {
  const library = createSyntheticRoonLibrary();
  const albums = await library.browseAlbums(page);
  const tracks = await Promise.all(albums.items.map(album => library.browseAlbum(album.reference, page)));
  const calls: DatasetProjectionCommand[] = [];
  let offline = false;
  const port = projectionPort(async (command, payload) => {
    calls.push(command);
    if (offline) throw new Error('合成媒体库已断开');
    if (command === 'captureAlbumMetadata') return { scope: 'library-generation-1', projectionId: randomUUID(), metadata: library.getAlbumSnapshot((payload as { reference: string }).reference) };
    if (command === 'captureTrackMetadataBatch') return { scope: 'library-generation-1', projectionId: randomUUID(), metadata: (payload as { references: readonly string[] }).references.map(reference => library.getTrackSnapshot(reference)) };
    if (command === 'acquirePermit') return { ...payload, permitId: randomUUID() };
    if (command === 'releasePermit') return { released: true };
    const browse = payload as { query: string; page: typeof page };
    return browse.query.trim() ? library.searchLibrary(browse.query, browse.page, 'album') : library.browseAlbums(browse.page);
  });
  const collection = createCollectionRepository({ filePath: ':memory:' }), maintenance = createBackupWorkflowStore({ filePath: ':memory:' });
  const domain = createDatasetDomain({ collectionRepository: collection, backupWorkflowStore: maintenance, projection: port });
  t.after(() => domain.close());
  const request = (command: IpcRequest['command'], payload: unknown): IpcRequest => ({ version: 1, id: randomUUID(), command, payload, expectedDatasetId: domain.datasetId }) as IpcRequest;
  return { domain, collection, maintenance, library, albums, tracks, calls, request, offline: () => { offline = true; } };
}

test('owner异步关联仍使用原幂等收据；断开媒体库后的重放不索取新元数据或许可', async t => {
  const f = await projectionFixture(t);
  const command = f.request('physicalLinks.register', { commandId: randomUUID(), reference: f.albums.items[0]!.reference, physicalAbsenceConfirmed: true, userConfirmed: true });
  const result = await f.domain.dispatch(command) as PhysicalLinkResult;
  assert.ok(result.digitalId);
  assert.deepEqual(f.calls, ['captureAlbumMetadata', 'acquirePermit', 'releasePermit']);
  const stored = f.collection.links.digitalDetail(result.digitalId!);
  assert.equal(stored.album.metadata.title, '关联验收专辑');
  assert.doesNotMatch(JSON.stringify(stored), /musicbridge-v2|synthetic-private|itemKey/u);
  f.offline();
  assert.deepEqual(await f.domain.dispatch(command), result);
  assert.deepEqual(f.calls, ['captureAlbumMetadata', 'acquirePermit', 'releasePermit']);
  await assert.rejects(f.domain.dispatch({ ...command, expectedDatasetId: randomUUID() }), /工作库/u);
  assert.equal(f.collection.links.digitalList(page).total, 1);
});

test('owner一次选曲批次保持顺序并拒绝重复引用，公开草稿仍无运行引用；重放不依赖媒体库', async t => {
  const f = await projectionFixture(t), first = f.tracks[0]!.items[0]!, second = f.tracks[1]!.items[0]!;
  const command = f.request('recordingDrafts.append', { commandId: randomUUID(), title: '异步精选', programType: 'compilation', references: [second.reference, first.reference], userConfirmed: true });
  await assert.rejects(f.domain.dispatch({ ...command, payload: { ...(command.payload as object), references: [second.reference, second.reference] } }), /选曲请求无效/u);
  assert.deepEqual(f.calls, []);
  const saved = await f.domain.dispatch(command) as MasterDraftResult;
  const snapshot = f.collection.drafts.detail(saved.draftId);
  assert.deepEqual(snapshot.tracks.map(track => track.metadata.title), ['另一首合成曲目', '合成关联曲目']);
  assert.equal(snapshot.sourceLockEligible, false);
  assert.doesNotMatch(JSON.stringify(snapshot), /musicbridge-v2|synthetic-private|itemKey/u);
  assert.deepEqual(f.calls, ['captureTrackMetadataBatch', 'acquirePermit', 'releasePermit']);
  f.offline(); assert.deepEqual(await f.domain.dispatch(command), saved);
  assert.deepEqual(f.calls, ['captureTrackMetadataBatch', 'acquirePermit', 'releasePermit']);
});

test('许可失效阻断消费，事务消费失败仍释放已取得许可', async () => {
  const events: string[] = [];
  const port = projectionPort(async (command, payload) => {
    events.push(command);
    if (command === 'captureAlbumMetadata') return { scope: 'current', projectionId: randomUUID(), metadata: { title: '合成' } };
    if (command === 'acquirePermit') return { ...payload, permitId: randomUUID() };
    if (command === 'releasePermit') return { released: true };
    throw new Error('本例没有其他投影');
  });
  const projection = createCollectionRoonProjectionPort(port, () => {});
  await assert.rejects(projection.projectAlbum('合成引用', () => { throw new Error('合成CAS冲突'); }), /CAS/u);
  assert.deepEqual(events, ['captureAlbumMetadata', 'acquirePermit', 'releasePermit']);
  let consumed = false;
  const unavailable = createCollectionRoonProjectionPort(projectionPort(async command => {
    if (command === 'captureAlbumMetadata') return { scope: 'expired', projectionId: randomUUID(), metadata: { title: '旧快照' } };
    throw new Error('媒体库代际已失效');
  }), () => {});
  await assert.rejects(unavailable.projectAlbum('合成引用', () => { consumed = true; }), /代际/u);
  assert.equal(consumed, false);
});

test('关闭时封住迟到元数据写入，并等待旧dispatch真正结束后才关闭两库', async t => {
  const captureEntered = deferred<void>(), finishCapture = deferred<void>();
  const collection = createCollectionRepository({ filePath: ':memory:' }), maintenance = createBackupWorkflowStore({ filePath: ':memory:' });
  const domain = createDatasetDomain({ collectionRepository: collection, backupWorkflowStore: maintenance, projection: projectionPort(async command => {
    if (command === 'captureAlbumMetadata') { captureEntered.resolve(); await finishCapture.promise; return { scope: 'old', projectionId: randomUUID(), metadata: { title: '不应写入' } }; }
    throw new Error('关闭后不得再索取许可');
  }) });
  t.after(() => domain.close());
  const library = createSyntheticRoonLibrary(), reference = (await library.browseAlbums(page)).items[0]!.reference;
  const pending = domain.dispatch({ version: 1, id: randomUUID(), command: 'physicalLinks.register', payload: { commandId: randomUUID(), reference, physicalAbsenceConfirmed: true, userConfirmed: true }, expectedDatasetId: domain.datasetId });
  const rejected = assert.rejects(pending, /关闭/u);
  await captureEntered.promise;
  let closed = false;
  const closing = domain.close(async () => { assert.equal(collection.links.digitalList(page).total, 0); maintenance.overview(); }).then(() => { closed = true; });
  await domain.backups.close();
  assert.equal(closed, false);
  assert.equal(collection.links.digitalList(page).total, 0);
  maintenance.overview();
  await assert.rejects(domain.dispatch({ version: 1, id: randomUUID(), command: 'commandOutbox.context', payload: {} }), /关闭/u);
  finishCapture.resolve(); await rejected; await closing;
  assert.throws(() => collection.list(page)); assert.throws(() => maintenance.overview());
});

test('协调器关闭后仍保留真实两库直到本地收口回调完成，最终自然close释放连接', async t => {
  const collection = createCollectionRepository({ filePath: ':memory:' }), maintenance = createBackupWorkflowStore({ filePath: ':memory:' });
  const domain = createTestDatasetDomain({ collectionRepository: collection, backupWorkflowStore: maintenance });
  const entered = deferred<void>(), resume = deferred<void>();
  t.after(() => domain.close());
  const closing = domain.close(async () => { entered.resolve(); await resume.promise; });
  await entered.promise;
  assert.equal(collection.list(page).total, 0); assert.equal(maintenance.overview().jobs.length, 0);
  assert.throws(() => domain.assertOpen(), /关闭/u);
  resume.resolve(); await closing; await domain.close();
  assert.throws(() => collection.list(page)); assert.throws(() => maintenance.overview());
});

test('生产owner在同一持久dataset重启后沿用身份与业务数据；testMode不会取得真实输出资格', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mbp-008-owned-dataset-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const unavailable = projectionPort(async () => { throw new Error('本例无真实Roon'); });
  const first = await prepareOwnedDatasetDomain({ dataDirectory: directory, epoch: randomUUID(), testMode: true, projection: unavailable });
  t.after(() => first.close());
  const identity = first.datasetId;
  first.collection.receive({ commandId: randomUUID(), model: { brand: '合成', name: 'owner持久化', edition: '测试', year: 1990, format: 'cassette', tapeType: 'II', identification: 'verified' }, lengthMinutes: 60, quantities: { openedBlank: 1, sealedBlank: 0, legacyUsed: 0, unclassified: 0 } });
  await first.commitBoot(); await first.close();
  const second = await prepareOwnedDatasetDomain({ dataDirectory: directory, epoch: randomUUID(), testMode: true, projection: unavailable });
  t.after(() => second.close());
  assert.equal(second.datasetId, identity); assert.equal(second.collection.list(page).total, 1);
  assert.equal(second.recordingDeviceSelection, undefined);
  await second.commitBoot(); await second.close();
});

test('owner关闭录音时真实输入释放与quiet屏障仍能持久化，关闭标记只阻断新派发', async t => {
  const f = await recordingPlanFixture(t, false, { format: 'dat' });
  const frozen = await f.plans.freeze(await f.planRequest());
  let stops = 0, closes = 0;
  const maintenance = createBackupWorkflowStore({ filePath: ':memory:' });
  const domain = createTestDatasetDomain({ collectionRepository: f.repository, backupWorkflowStore: maintenance, closeConnections() { maintenance.close(); }, recordingAttemptAdmissionProvider: {
    async authorize() {}, async start() { return { async stop() { ++stops; }, async close() { ++closes; } }; },
  } });
  f.registerDependentCleanup(() => domain.close());
  const attempt = await domain.recordingAttempts.begin({ commandId: randomUUID(), planVersionId: frozen.id, planContentHash: frozen.contentHash, userConfirmed: true });
  await domain.close(async () => {
    const rows = f.repository.recordingAttempts.outputRunRecoveryRows();
    assert.equal(rows.length, 1); assert.equal(rows[0]!.attemptId, attempt.id); assert.equal(rows[0]!.quietPersisted, true);
    assert.equal(f.repository.recordingAttempts.get({ attemptId: attempt.id }).attempt!.status, 'interrupted');
  });
  assert.equal(stops, 1); assert.equal(closes, 1);
});

test('Print关闭失败仍停止原Attempt输入与后继资源，收口后拒绝成功并保留两库；失败关闭不重试', async t => {
  const f = await recordingPlanFixture(t, false, { format: 'dat' });
  const frozen = await f.plans.freeze(await f.planRequest());
  const maintenance = createBackupWorkflowStore({ filePath: ':memory:' });
  f.registerDependentCleanup(async () => { maintenance.close(); });
  let stops = 0, closes = 0, connectionCloses = 0, barrierReached = false;
  let input: RecordingAttemptDriverRequest['input'] | undefined;
  const domain = createTestDatasetDomain({ collectionRepository: f.repository, backupWorkflowStore: maintenance,
    closeConnections() { ++connectionCloses; }, recordingAttemptAdmissionProvider: {
      async authorize() {}, async start(request) { input = request.input; return { async stop() { ++stops; }, async close() { ++closes; } }; },
    },
  });
  const originalPrintClose = domain.recordingPrints.close;
  f.registerDependentCleanup(async () => { originalPrintClose(); });
  const failure = new Error('合成Print关闭故障');
  const printClose = t.mock.method(domain.recordingPrints, 'close', async () => { throw failure; });
  const attempt = await domain.recordingAttempts.begin({ commandId: randomUUID(), planVersionId: frozen.id, planContentHash: frozen.contentHash, userConfirmed: true });
  const closing = domain.close(async () => { barrierReached = true; assert.equal(f.repository.recordingAttempts.outputRunRecoveryRows()[0]!.quietPersisted, true); });
  await assert.rejects(closing, error => error === failure);
  assert.equal(stops, 1); assert.equal(closes, 1); assert.equal(barrierReached, true); assert.equal(connectionCloses, 0);
  assert.equal(f.repository.recordingAttempts.get({ attemptId: attempt.id }).attempt!.status, 'interrupted');
  assert.ok(input);
  await assert.rejects(input.consumer.readFrames(0, 1), error => error instanceof Error && 'code' in error && error.code === 'LEASE_CLOSED');
  await assert.rejects(domain.sources.authorize(randomUUID(), f.directory), /源文件操作无效/u);
  assert.throws(domain.assertOpen, /关闭/u);
  assert.ok(f.repository.list(page).total > 0); maintenance.overview();
  assert.equal(domain.close(), closing, '重放失败close必须沿用原Promise，不能再次清理原scope');
  await assert.rejects(domain.close(), error => error === failure);
  assert.equal(printClose.mock.callCount(), 1); assert.equal(stops, 1); assert.equal(closes, 1);
});

import {createHash as artwork715Hash} from 'node:crypto';
import {mkdir as artwork715Mkdir,open as artwork715Open,readFile as artwork715ReadFile,stat as artwork715Stat,writeFile as artwork715WriteFile,type FileHandle} from 'node:fs/promises';
import * as artwork715Dto from '@music-bridge/contracts';
import {authorizeSourceDirectory as artwork715Authorize} from '../src/recording/source-files.js';
import {LocalAlbumReadError as artwork715ReadError} from '../src/collection/local-album-browser/grouping.js';
import {readLocalEmbeddedArtwork as artwork715Embedded} from '../src/library/local-artwork-embedded-reader.js';
import {createScanReadAdmission as artwork715Admission} from '../src/library/scan-read-admission.js';
import type {ScanPreparedItem} from '../src/collection/local-scan-store.js';
import type {ScanReadFacts} from '../src/collection/local-scan-facts.js';
import {localLibraryManagementDigest as artwork715Digest,type LocalLibraryManagementOperationRecord,type LocalLibraryManagementBindingRecord} from '../src/collection/local-library-workbench/owner-journal.js';
import type {DatasetWorkbenchOwnerCommand,DatasetWorkbenchOwnerPayloads,DatasetWorkbenchOwnerResults,DatasetWorkbenchOwnerRequest,DatasetProjectionCommandResults,DatasetWorkbenchExecutionContext} from '../src/collection/dataset-owner-protocol.js';

const artwork715Sha=(bytes:Uint8Array)=>artwork715Hash('sha256').update(bytes).digest('hex');
/** 只改测试自有副本的PICTURE元数据，保留原STREAMINFO、其余metadata与原音频载荷。 */
function artwork715WithoutPicture(source:Buffer):Buffer {
  assert.equal(source.toString('ascii',0,4),'fLaC');let offset=4,last=false;const blocks:Buffer[]=[];
  while(!last){assert.ok(offset+4<=source.length);const first=source[offset]!,length=source.readUIntBE(offset+1,3),end=offset+4+length;
    assert.ok(end<=source.length);last=(first&128)!==0;if((first&127)!==6){const block=Buffer.from(source.subarray(offset,end));block[0]=first&127;blocks.push(block);}offset=end;}
  assert.ok(blocks.length>0);const finalBlock=blocks.at(-1)!;finalBlock[0]=finalBlock[0]!|128;
  return Buffer.concat([source.subarray(0,4),...blocks,source.subarray(offset)]);
}
async function artwork715Display():Promise<artwork715Dto.LocalArtworkImage> {
  const bytes=await artwork715ReadFile(new URL('./fixtures/mbrs012-source/owned-cover-16.jpg',import.meta.url));
  assert.equal(bytes.length,960);assert.equal(artwork715Sha(bytes),'555f7915442690ccb14754bd0da000ceadfbdcfb50b4e3402f55d4806e3e989d');
  const image:artwork715Dto.LocalArtworkImage={original:{mime:'image/jpeg',bytes:bytes.length,sha256:artwork715Sha(bytes),width:16,height:16},
    display:{mime:'image/jpeg',bytes:bytes.length,sha256:artwork715Sha(bytes),width:16,height:16,dataUrl:'data:image/jpeg;base64,'+bytes.toString('base64')}};
  assert.ok(artwork715Dto.isLocalArtworkImage(image));return image;
}
/** 两轨来自已封自有FLAC；hasArtwork由实际提取的coverEvidence经原scan SQL产生。 */
async function artworkDomainFixture715(t:test.TestContext,coveredIndex:number=1){
  const temporary=process.env.TMPDIR;assert.ok(temporary?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
  const directory=await mkdtemp(path.join(temporary!,'artwork-domain715-')),media=path.join(directory,'source'),albumDirectory=path.join(media,'两轨专辑');
  await artwork715Mkdir(albumDirectory,{recursive:true,mode:0o700});await artwork715Mkdir(path.join(directory,'staging'),{mode:0o700});
  const rawManifest=await artwork715ReadFile(new URL('./fixtures/mbrs003/audio/manifest.json',import.meta.url));assert.equal(artwork715Sha(rawManifest),'5e4157b8fa3428a82def6c128e5e60dce3cc90186b804d835c9be8e957c8feb1');
  const manifest=JSON.parse(rawManifest.toString('utf8')) as {synthetic:boolean;files:{id:string;file:string;bytes:number;sha256:string;expectedTags?:{title:string;artist:string;album:string};expectedCover?:{sha256:string}}[]};
  assert.equal(manifest.synthetic,true);const entry=manifest.files.find(value=>value.id==='core-flac')!;assert.ok(entry);
  const sealed=await artwork715ReadFile(new URL('./fixtures/mbrs003/audio/'+entry.file,import.meta.url));assert.equal(sealed.length,entry.bytes);assert.equal(artwork715Sha(sealed),entry.sha256);
  const withoutPicture=artwork715WithoutPicture(sealed),originals=[coveredIndex===0?sealed:withoutPicture,coveredIndex===1?sealed:withoutPicture];
  const relativeNames=['两轨专辑/01.flac','两轨专辑/02.flac'];
  for(const [index,bytes] of originals.entries())await artwork715WriteFile(path.join(media,relativeNames[index]!),bytes,{flag:'wx',mode:0o600});
  const file=path.join(directory,'collection.sqlite'),repository=createCollectionRepository({filePath:file,stagingRoot:path.join(directory,'staging')}),maintenance=createBackupWorkflowStore({filePath:path.join(directory,'maintenance.sqlite')});
  repository.localCatalog.roots();const identity=maintenance.datasetIdentities.bind('default',file,false);repository.localCatalog.privateBindWorkbenchDataset(identity);
  const importId=randomUUID(),source=repository.sources.authorize(importId,await artwork715Authorize(media)),root=repository.localCatalog.registerRoot({commandId:importId,sourceRootId:source.id,role:'library'});
  const otherMedia=path.join(directory,'other-source');await artwork715Mkdir(otherMedia,{mode:0o700});
  const otherImportId=randomUUID(),otherSource=repository.sources.authorize(otherImportId,await artwork715Authorize(otherMedia)),otherRoot=repository.localCatalog.registerRoot({commandId:otherImportId,sourceRootId:otherSource.id,role:'library'});
  const items:ScanPreparedItem[]=[];
  for(const [index,relative] of relativeNames.entries()){
    const absolute=path.join(media,relative),handle=await artwork715Open(absolute,'r'),originalRead=handle.read.bind(handle);let bytesRead=0,readCalls=0,maxReadBytes=0,allocationBytes=0;
    handle.read=(async(buffer:Buffer,offset:number,length:number,position:number)=>{const result=await originalRead(buffer,offset,length,position);bytesRead+=result.bytesRead;readCalls++;maxReadBytes=Math.max(maxReadBytes,length);allocationBytes+=buffer.length;return result;}) as FileHandle['read'];
    const began=performance.now();let pictures:Awaited<ReturnType<typeof artwork715Embedded>>;
    try{pictures=await artwork715Embedded(handle,originals[index]!.length,new AbortController().signal);}finally{await handle.close();}
    assert.equal(pictures.length,index===coveredIndex?1:0);
    if(pictures.length)assert.equal(artwork715Sha(pictures[0]!.bytes),entry.expectedCover!.sha256);
    const streamInfo=originals[index]!.subarray(8,42),packed=streamInfo.readBigUInt64BE(10),sampleRate=Number(packed>>44n&0xfffffn),channels=Number(packed>>41n&7n)+1,bits=Number(packed>>36n&31n)+1,samples=Number(packed&0xfffffffffn);
    const readFacts:ScanReadFacts={technical:{container:'FLAC',codec:'FLAC',lossless:true,sampleRateHz:sampleRate,channels,bitsPerSample:bits,durationSeconds:samples/sampleRate,evidence:'bounded-parser-reported'},
      coverEvidence:pictures.map(picture=>({mime:'image/png' as const,bytes:picture.bytes.length,sha256:artwork715Sha(picture.bytes),evidence:'encoded-bytes-magic-and-digest' as const})),
      readEvidence:{bytesRead,readCalls,maxReadBytes,allocationBytes,elapsedMs:Math.floor(performance.now()-began),wholeAudioHash:false,wholeAudioDecode:false}};
    const info=await artwork715Stat(absolute,{bigint:true});items.push({relative,signature:[info.dev,info.ino,info.size,info.mtimeNs,info.ctimeNs].join(':'),parserVersion:'actual-flac-embedded715',outcome:'accepted',fields:{...entry.expectedTags},failureCode:null,reused:false,readFacts});
  }
  const started=repository.localScan.start({commandId:randomUUID(),datasetId:identity.datasetId,libraryRootId:root.id,expectedRootRevision:root.revision,parserVersion:'actual-flac-embedded715'}).job;
  const running=repository.localScan.resume({commandId:randomUUID(),jobId:started.jobId,expectedRevision:started.jobRevision});
  repository.localCatalog.privateScanSettingsStore(identity).freeze(identity,{schema:1,datasetId:identity.datasetId,eventId:randomUUID(),commandId:randomUUID(),kind:'launch',frozen:{jobId:running.jobId,settingsRevision:'1',albumConcurrency:12,readerConcurrency:1}});
  const batch={batchId:randomUUID(),jobId:running.jobId,expectedJobRevision:running.jobRevision,checkpointBefore:running.checkpointRef,items,frontier:[],completed:true};
  repository.localScan.privatePrepareBatch({commandId:randomUUID(),jobId:running.jobId,batch});repository.localScan.privateCommitBatch({commandId:randomUUID(),jobId:running.jobId,batchId:batch.batchId,expectedRevision:running.jobRevision});
  const original:LocalLibraryManagementOperationRecord['original']={command:'library.import.confirm',request:{commandId:importId,choiceId:randomUUID(),role:'catalog'}};
  const operation:LocalLibraryManagementOperationRecord={schema:1,kind:'operation',datasetId:identity.datasetId,key:importId,revision:1,original,originalSha256:artwork715Digest(original),receipt:{commandId:importId,kind:'library.import.confirm',state:'succeeded',libraryIds:[root.id],message:null}};
  const binding:LocalLibraryManagementBindingRecord={schema:1,kind:'binding',datasetId:identity.datasetId,key:root.id,revision:1,libraryId:root.id,sourceRootId:source.id,rootRevision:root.revision,role:'catalog',name:'两轨自有测试库',active:true,watchEnabled:false,operationId:importId};
  repository.localCatalog.privateLibraryManagementCompareAndSwap(identity,[{record:operation,expectedRevision:null},{record:binding,expectedRevision:null}]);
  const epoch=randomUUID(),scope={epoch,datasetId:identity.datasetId},admission=artwork715Admission({isBusy:()=>false}),display=await artwork715Display(),normalizedOriginals:string[]=[];
  const projection:DatasetProjectionPort={async call<C extends DatasetProjectionCommand>(command:C,payload:DatasetProjectionCommandPayloads[C]):Promise<DatasetProjectionCommandResults[C]>{
    let result:unknown;
    if(command==='scanReadAcquire')result=admission.acquire(scope);
    else if(command==='scanReadWatchRevocation')result=await admission.watchRevocation(scope,(payload as {permitId:string}).permitId);
    else if(command==='scanReadRelease')result=admission.release(scope,(payload as {permitId:string}).permitId);
    else if(command==='normalizeLocalAlbumArtwork'){
      const copies=(payload as {copies:artwork715Dto.LocalArtworkSourceCopies}).copies,copy=copies.items[0];assert.ok(copy,'有图路径必须实际取得原编码图');
      const bytes=Buffer.from(copy.base64,'base64');normalizedOriginals.push(artwork715Sha(bytes));assert.equal(artwork715Sha(bytes),entry.expectedCover!.sha256);
      const normalized:DatasetProjectionCommandResults['normalizeLocalAlbumArtwork']={image:{original:{mime:'image/png',bytes:bytes.length,sha256:artwork715Sha(bytes),width:16,height:16},display:display.display},status:'ready'};
      result=normalized;
    }else throw new Error('Domain封面用例只允许原扫描准入及展示归一化投影');
    return result as DatasetProjectionCommandResults[C];
  }};
  const domain=createDatasetDomain({collectionRepository:repository,backupWorkflowStore:maintenance,collectionDatasetIdentity:identity,localSourceEpoch:epoch,projection});
  t.after(async()=>{try{await domain.close();admission.close();for(const [index,relative] of relativeNames.entries())assert.deepEqual(await artwork715ReadFile(path.join(media,relative)),originals[index]);}finally{await rm(directory,{recursive:true,force:true});}});
  await domain.localSourceWrites.prepareRecoveryProtection();await domain.localRelocationPlans.prepareRecoveryProtection();await domain.prepareWorkbench();await domain.commitBoot?.();
  const albums=domain.localAlbums!;assert.ok(albums);const list=await albums.queryAlbums({rootId:root.id,query:'',filter:'all',offset:0,limit:20});assert.equal(list.total,1);const summary=list.items[0]!;
  const group=await albums.inspectAlbum({albumKey:summary.id,rootId:root.id,revision:summary.revision});assert.equal(group.members.length,2);assert.deepEqual(group.members.map(member=>member.fact.hasArtwork),[coveredIndex===0,coveredIndex===1]);
  const first=group.members[0]!.fact.summary.track.id;assert.equal(summary.representativeTrackId,first);
  const artworkRequest:artwork715Dto.LocalAlbumArtworkRequest={albumKey:summary.id,rootId:summary.rootId,editionId:summary.editionId,representativeTrackId:summary.representativeTrackId,revision:summary.revision};
  const readRequest:artwork715Dto.LocalWorkbenchReadRequest={albums:[{albumId:summary.id,rootId:root.id,title:summary.title,artist:summary.artists.join(' / '),trackIds:group.members.map(member=>member.fact.summary.track.id)}]};
  const context=():DatasetWorkbenchExecutionContext=>({identity:scope,signal:new AbortController().signal,deadlineAtMs:performance.now()+2000});
  const owner=async<C extends DatasetWorkbenchOwnerCommand>(command:C,payload:DatasetWorkbenchOwnerPayloads[C]):Promise<DatasetWorkbenchOwnerResults[C]>=>domain.dispatchWorkbenchOwner!({command,payload} as DatasetWorkbenchOwnerRequest,context()) as Promise<DatasetWorkbenchOwnerResults[C]>;
  return {domain,repository,root,otherRoot,summary,group,artworkRequest,readRequest,owner,display,normalizedOriginals,expectedCoverSha:entry.expectedCover!.sha256};
}

test('Domain封面B：首无图次内嵌图，墙与首次详情同预览且public代表tuple不变',async t=>{
  const f=await artworkDomainFixture715(t),tuple=structuredClone(f.artworkRequest);
  const detail=await f.owner('read.albums',f.readRequest);assert.ok(artwork715Dto.isLocalWorkbenchReadback(detail));assert.equal(detail.albums[0]!.currentArtwork?.previewUrl,f.display.display.dataUrl);
  const wall=await f.domain.localAlbums!.getArtwork(f.artworkRequest);assert.ok(artwork715Dto.isLocalAlbumArtworkReply(wall,f.artworkRequest));assert.ok(wall.image);assert.equal(wall.image.original.sha256,f.expectedCoverSha);
  assert.equal(detail.albums[0]!.currentArtwork?.previewUrl,wall.image.display.dataUrl);assert.deepEqual(f.artworkRequest,tuple);
  const after=await f.domain.localAlbums!.inspectAlbum({albumKey:f.summary.id,rootId:f.root.id,revision:f.summary.revision});assert.equal(after.summary.id,f.summary.id);assert.equal(after.summary.representativeTrackId,f.group.members[0]!.fact.summary.track.id);assert.equal(after.summary.rootId,f.root.id);assert.equal(after.summary.revision,f.summary.revision);
});

test('Domain封面B：显式artwork.readLocal独立取得次轨原图并与墙和详情一致',async t=>{
  const f=await artworkDomainFixture715(t),read=await f.owner('read.albums',f.readRequest),reference={datasetId:f.domain.datasetId,capture:read.albums[0]!.capture};
  const copies=await f.owner('artwork.readLocal',reference);assert.equal(copies.status,'ready');assert.equal(copies.items.length,1);assert.equal(copies.items[0]!.origin,'embedded');assert.equal(artwork715Sha(Buffer.from(copies.items[0]!.base64,'base64')),f.expectedCoverSha);
  const wall=await f.domain.localAlbums!.getArtwork(f.artworkRequest);assert.ok(wall.image);assert.equal(wall.image.original.sha256,f.expectedCoverSha);assert.equal(read.albums[0]!.currentArtwork?.previewUrl,wall.image.display.dataUrl);
});

test('Domain封面B：无内嵌图仍用原public代表fallback实读缺图，不改身份',async t=>{
  for(const coveredIndex of [-1,0]){
    const f=await artworkDomainFixture715(t,coveredIndex),read=await f.owner('read.albums',f.readRequest),copies=await f.owner('artwork.readLocal',{datasetId:f.domain.datasetId,capture:read.albums[0]!.capture});
    assert.equal(copies.status,'ready');
    if(coveredIndex<0){assert.deepEqual(copies.items,[]);assert.equal(read.albums[0]!.currentArtwork,null);assert.equal(f.normalizedOriginals.length,0);}
    else{assert.equal(copies.items.length,1);assert.equal(artwork715Sha(Buffer.from(copies.items[0]!.base64,'base64')),f.expectedCoverSha);assert.equal(read.albums[0]!.currentArtwork?.previewUrl,f.display.display.dataUrl);}
    assert.equal(f.summary.representativeTrackId,f.group.members[0]!.fact.summary.track.id);assert.equal(f.artworkRequest.rootId,f.root.id);
  }
});

test('Domain封面B：同作者身份错Root或旧revision在读图前拒绝',async t=>{
  const f=await artworkDomainFixture715(t),before=f.normalizedOriginals.length;
  const changed=(error:unknown)=>error instanceof artwork715ReadError && error.code==='SNAPSHOT_CHANGED';
  await assert.rejects(f.domain.localAlbums!.getArtwork({...f.artworkRequest,rootId:f.otherRoot.id}),changed);
  await assert.rejects(f.owner('read.albums',{albums:[{...f.readRequest.albums[0]!,rootId:f.otherRoot.id}]}),changed);
  await assert.rejects(f.domain.localAlbums!.getArtwork({...f.artworkRequest,revision:f.artworkRequest.revision+'-stale'}),changed);
  assert.equal(f.normalizedOriginals.length,before);assert.equal(f.group.members[1]!.fact.hasArtwork,true);assert.equal(f.artworkRequest.rootId,f.root.id);
});
