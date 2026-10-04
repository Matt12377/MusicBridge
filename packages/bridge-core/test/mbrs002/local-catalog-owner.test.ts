import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { isAlbumEdition, isLibraryRoot, isAudioAsset, isLocalTrack, isLocalCatalogReceipt, type IpcRequest, type IpcCommand, type LocalCatalogOperation, type LocalCatalogReceipt, type LocalCatalogCommandPayloads, type SourceRoot, type LibraryRoot, type AudioAsset, type LocalTrack } from '@music-bridge/contracts';
import { createDatasetOwnerClient } from '../../src/collection/dataset-owner-client.js';
import { dispatchDatasetCommand, dispatchInternalDatasetCommand } from '../../src/collection/dataset-dispatch.js';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { createDatasetCommandBoundary } from '../../src/recording/dataset-identity.js';
import { authorizeSourceDirectory } from '../../src/recording/source-files.js';
import { DatasetOwnerTransportError, isDatasetOwnerResponse, ownerRecord, type DatasetOwnerRequest, type DatasetOwnerResponse } from '../../src/collection/dataset-owner-protocol.js';
import { buildStoragePolicy } from '../../../../apps/desktop/scripts/build-storage-root.mjs';

const cleanupOwners = new Map<string, Array<() => Promise<void>>>();
async function directory(t: test.TestContext): Promise<string> {
  const storage = buildStoragePolicy(), temporary = storage.check(process.env.TMPDIR!, {mustExist:true});
  const value = await mkdtemp(path.join(temporary,'musicbridge-local-owner-')); storage.check(value,{mustExist:true});
  t.after(async () => { for (const close of cleanupOwners.get(value) ?? []) await close(); cleanupOwners.delete(value); await rm(value,{recursive:true,force:true}); }); return value;
}
function request(command: IpcCommand, payload: unknown, datasetId?: string): IpcRequest {
  return {version:1,id:randomUUID(),command,payload,...(datasetId === undefined ? {} : {expectedDatasetId:datasetId})};
}
function owner(t: test.TestContext, dataDirectory: string, crashAfterLocalCommand?: string) {
  const worker = new Worker(new URL('../helpers/dataset-owner-domain-fixture.ts',import.meta.url),{execArgv:['--import','tsx'],workerData:{dataDirectory,...(crashAfterLocalCommand ? {crashAfterLocalCommand} : {})}});
  const fatal: string[] = [], endpoint = createDatasetOwnerClient({worker,onFatal: reason => fatal.push(reason)});
  const close = async () => { if (worker.threadId !== -1) await endpoint.close().catch(() => worker.terminate()); };
  const handlers = cleanupOwners.get(dataDirectory) ?? []; handlers.push(close); cleanupOwners.set(dataDirectory,handlers);
  t.after(close);
  return {worker,endpoint,fatal};
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string,unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
function fingerprint(operation: LocalCatalogOperation, payload: unknown): string { return createHash('sha256').update(canonical([operation,payload])).digest('hex'); }
async function seededOwner(t: test.TestContext) {
  const parent = await directory(t), f = owner(t,parent), identity = await f.endpoint.prepare();
  const sourcePath = path.join(parent,'合成授权'); await mkdir(sourcePath);
  const source = await f.endpoint.dispatch(request('recordingSources.authorize',{commandId:randomUUID(),absolutePath:sourcePath},identity.datasetId)) as SourceRoot;
  const root = await f.endpoint.dispatchInternal!(request('localCatalog.registerRoot',{commandId:randomUUID(),sourceRootId:source.id,role:'library'},identity.datasetId)) as LibraryRoot;
  const assetPayload = {commandId:randomUUID(),libraryRootId:root.id,expectedRootRevision:'1',relative:'合成/一.flac',sha256:'a'.repeat(64),sampleFrames:'96000',timebaseHz:48000};
  const asset = await f.endpoint.dispatchInternal!(request('localCatalog.registerAsset',assetPayload,identity.datasetId)) as AudioAsset;
  assert.ok(isLibraryRoot(root)); assert.ok(isAudioAsset(asset));
  return {...f,parent,identity,source,root,asset,assetPayload};
}

test('MBRS002 B2 owner：真实单作者根资产片段发行版raw人工覆盖与闭集公开读', {timeout:30_000}, async t => {
  const f = await seededOwner(t), call = (command:IpcCommand,payload:unknown) => f.endpoint.dispatch(request(command,payload,f.identity.datasetId));
  const track = await call('localCatalog.createTrack',{commandId:randomUUID(),assetId:f.asset.id,segment:{startFrame:'0',endFrameExclusive:'48000',timebaseHz:48000}}) as LocalTrack;
  assert.ok(isLocalTrack(track)); assert.ok(track.segment);
  const raw = {commandId:randomUUID(),trackId:track.id,source:'synthetic',parserVersion:'fixture-1',fields:{title:'原始',artist:'合成艺人'}};
  await f.endpoint.dispatchInternal!(request('localCatalog.observeMetadata',raw,f.identity.datasetId));
  await call('localCatalog.overrideMetadata',{commandId:randomUUID(),trackId:track.id,expectedRevision:null,fields:{title:'人工'}});
  const edition = await call('localCatalog.createEdition',{commandId:randomUUID(),title:'合成发行版',edition:'版本甲'});
  assert.ok(isAlbumEdition(edition));
  await call('localCatalog.linkEditionTrack',{commandId:randomUUID(),editionId:edition.id,trackId:track.id,disc:1,trackNumber:1,sequence:1});
  assert.deepEqual(await call('localCatalog.track',{trackId:track.id}),track);
  assert.deepEqual(await call('localCatalog.asset',{assetId:f.asset.id}),f.asset);
  assert.deepEqual(await call('localCatalog.root',{rootId:f.root.id}),f.root);
  assert.deepEqual(await call('localCatalog.roots',{}),[f.root]);
  assert.equal((await call('localCatalog.pageTracks',{offset:0,limit:1}) as {total:number}).total,1);
  assert.deepEqual(await call('localCatalog.edition',{editionId:edition.id}),edition);
  assert.equal((await call('localCatalog.editionTracks',{editionId:edition.id}) as unknown[]).length,1);
  assert.equal((await call('localCatalog.observations',{trackId:track.id}) as unknown[]).length,1);
  const metadata = await call('localCatalog.metadata',{trackId:track.id}) as {raw:unknown;effective:unknown};
  assert.deepEqual(metadata.raw,raw.fields); assert.deepEqual(metadata.effective,{title:'人工',artist:'合成艺人'});
  assert.ok(!JSON.stringify([f.root,f.asset,track,metadata]).includes('合成/一.flac'));
  assert.ok(!JSON.stringify([f.root,f.asset,track,metadata]).includes(f.parent));
  await f.endpoint.close();
});

test('MBRS002 B2 owner：普通client实际拒六个可信命令及定位注入，私有请求仍核原scope', {timeout:30_000}, async t => {
  const f = await seededOwner(t);
  const values: Partial<LocalCatalogCommandPayloads> = {
    'localCatalog.registerRoot':{commandId:randomUUID(),sourceRootId:f.source.id,role:'library'},
    'localCatalog.relinkRoot':{commandId:randomUUID(),sourceRootId:f.source.id,role:'library',rootId:f.root.id,expectedRevision:'1'},
    'localCatalog.registerAsset':f.assetPayload,
    'localCatalog.moveAsset':{commandId:randomUUID(),assetId:f.asset.id,expectedLocationRevision:'1',expectedRootRevision:'1',relative:'合成/二.flac'},
    'localCatalog.replaceAsset':{...f.assetPayload,commandId:randomUUID(),assetId:f.asset.id,expectedFileRevision:'1',expectedLocationRevision:'1'},
    'localCatalog.observeMetadata':{commandId:randomUUID(),trackId:randomUUID(),source:'synthetic',parserVersion:'fixture-1',fields:{title:'合成'}},
  };
  for (const [command,payload] of Object.entries(values)) await assert.rejects(f.endpoint.dispatch(request(command as IpcCommand,payload,f.identity.datasetId)), error => typeof error === 'object' && error !== null && 'failure' in error);
  await assert.rejects(f.endpoint.dispatch(request('localCatalog.createTrack',{commandId:randomUUID(),assetId:f.asset.id,segment:null,relative:'注入'},f.identity.datasetId)));
  await assert.rejects(f.endpoint.dispatchInternal!(request('localCatalog.moveAsset',values['localCatalog.moveAsset'],randomUUID())));
  assert.deepEqual(await f.endpoint.dispatch(request('localCatalog.asset',{assetId:f.asset.id},f.identity.datasetId)),f.asset);
  assert.equal((await f.endpoint.dispatch(request('localCatalog.pageTracks',{offset:0,limit:1},f.identity.datasetId)) as {total:number}).total,0);
  await f.endpoint.close();
});

test('MBRS002 B2 dispatcher：真实repository普通入口与内部入口拒越权、缺scope和额外字段', async t => {
  const parent = await directory(t), collection = createCollectionRepository({filePath:path.join(parent,'collection.sqlite')});
  t.after(() => collection.close()); const datasetId = randomUUID();
  const runtime = {collection,commandOutbox:createDatasetCommandBoundary({datasetId,assertCurrent(){ collection.list({offset:0,limit:1}); }})};
  const sourcePath = path.join(parent,'合成许可'); await mkdir(sourcePath);
  const source = collection.sources.authorize(randomUUID(),await authorizeSourceDirectory(sourcePath));
  const rootPayload = {commandId:randomUUID(),sourceRootId:source.id,role:'library'};
  await assert.rejects(dispatchDatasetCommand(runtime,request('localCatalog.registerRoot',rootPayload,datasetId)));
  await assert.rejects(dispatchInternalDatasetCommand(runtime,request('localCatalog.registerRoot',rootPayload)));
  const root = await dispatchInternalDatasetCommand(runtime,request('localCatalog.registerRoot',rootPayload,datasetId)); assert.ok(isLibraryRoot(root));
  for (const req of [request('localCatalog.roots',{}),request('localCatalog.roots',{},randomUUID()),request('localCatalog.roots',{path:'私有'},datasetId),{...request('localCatalog.roots',{},datasetId),trusted:true}]) await assert.rejects(dispatchDatasetCommand(runtime,req));
  assert.deepEqual(collection.localCatalog.roots(),[root]); collection.close();
});

test('MBRS002 B2 scope：真实两个owner拒旧库读写回执且关闭封锁新请求', {timeout:30_000}, async t => {
  const oneParent = await directory(t), twoParent = await directory(t), one = owner(t,oneParent), two = owner(t,twoParent);
  const a = await one.endpoint.prepare(), b = await two.endpoint.prepare(); assert.notEqual(a.datasetId,b.datasetId);
  const payload = {commandId:randomUUID(),title:'旧库请求',edition:''};
  for (const [command,p] of [['localCatalog.roots',{}],['localCatalog.createEdition',payload],['localCatalog.receipt',{commandId:payload.commandId,operation:'create-edition',fingerprint:fingerprint('create-edition',payload)}]] as const) {
    await assert.rejects(two.endpoint.dispatch(request(command,p,a.datasetId)), error => typeof error === 'object' && error !== null && 'failure' in error && (error.failure as {error:{code:string}}).error.code === 'OUTBOX_SCOPE_MISMATCH');
  }
  const accepted = two.endpoint.dispatch(request('localCatalog.createEdition',payload,b.datasetId));
  const closing = two.endpoint.close();
  await assert.rejects(two.endpoint.dispatch(request('localCatalog.createEdition',payload,b.datasetId)), error => error instanceof DatasetOwnerTransportError && error.outcome === 'not-sent');
  await assert.rejects(two.endpoint.dispatchInternal!(request('localCatalog.registerRoot',{commandId:randomUUID(),sourceRootId:randomUUID(),role:'library'},b.datasetId)), error => error instanceof DatasetOwnerTransportError && error.outcome === 'not-sent');
  const committed = await accepted; assert.ok(isAlbumEdition(committed));
  await closing; assert.equal(two.worker.threadId,-1);
  const cold = createCollectionRepository({filePath:path.join(twoParent,'collection.v1.sqlite')});
  try { assert.deepEqual(cold.localCatalog.receipt(payload.commandId)?.result,committed); } finally { cold.close(); }
  assert.deepEqual(await one.endpoint.dispatch(request('localCatalog.roots',{},a.datasetId)),[]);
  await one.endpoint.close();
});

function rawRpc(worker: Worker, message: DatasetOwnerRequest): Promise<DatasetOwnerResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(deadline); worker.off('message', receive); worker.off('error', failed); worker.off('exit', exited);
    };
    const fail = (detail: string) => { if (settled) return; settled = true; cleanup(); reject(new Error(`合成owner ${message.operation}请求失败：${detail}`)); };
    const receive = (value: unknown) => {
      if (!ownerRecord(value) || value.epoch !== message.epoch) return;
      if (value.type === 'fatal') { fail('当前epoch报告fatal'); return; }
      if (value.type !== 'response' || value.requestId !== message.requestId) return;
      if (!isDatasetOwnerResponse(value) || value.operation !== message.operation) { fail('当前请求回执协议无效'); return; }
      if (settled) return; settled = true; cleanup(); resolve(value);
    };
    const failed = () => fail('实际Worker error事件');
    const exited = (code: number) => fail(`实际Worker在回执前退出，code=${code}`);
    // 请求期限只作失败收口；不以sleep、轮询或时间长短证明业务行为。
    const deadline = setTimeout(() => fail('有界请求期限到达，未收到回执'), 10_000);
    worker.on('message', receive); worker.on('error', failed); worker.on('exit', exited);
    if (worker.threadId === -1) { fail('实际Worker已退出，未发送'); return; }
    try { worker.postMessage(message); } catch { fail('实际Worker发送失败'); }
  });
}
test('MBRS002 B2 worker：实际私有port普通dispatch拒可信观察，旧epoch不推进序列或业务', {timeout:30_000}, async t => {
  const dataDirectory = await directory(t), worker = new Worker(new URL('../helpers/dataset-owner-domain-fixture.ts',import.meta.url),{execArgv:['--import','tsx'],workerData:{dataDirectory}});
  t.after(() => worker.threadId !== -1 ? worker.terminate() : undefined);
  const epoch = randomUUID(); let sequence = 0;
  const envelope = (operation:DatasetOwnerRequest['operation'],inner?:IpcRequest): DatasetOwnerRequest => ({version:1,type:'request',epoch,requestId:randomUUID(),sequence:++sequence,operation,...(inner ? {request:inner}: {})});
  const prepared = await rawRpc(worker,envelope('prepare')); assert.equal(prepared.ok,true); if (!prepared.ok) assert.fail('owner准备失败');
  const datasetId = (prepared.result as {datasetId:string}).datasetId;
  const id = randomUUID();
  const trusted: Partial<LocalCatalogCommandPayloads> = {
    'localCatalog.registerRoot':{commandId:id,sourceRootId:id,role:'library'},
    'localCatalog.relinkRoot':{commandId:id,sourceRootId:id,role:'library',rootId:id,expectedRevision:'1'},
    'localCatalog.registerAsset':{commandId:id,libraryRootId:id,expectedRootRevision:'1',relative:'合成.flac',sha256:null,sampleFrames:null,timebaseHz:null},
    'localCatalog.moveAsset':{commandId:id,assetId:id,expectedLocationRevision:'1',expectedRootRevision:'1',relative:'改名.flac'},
    'localCatalog.replaceAsset':{commandId:id,libraryRootId:id,expectedRootRevision:'1',relative:'合成.flac',sha256:null,sampleFrames:null,timebaseHz:null,assetId:id,expectedFileRevision:'1',expectedLocationRevision:'1'},
    'localCatalog.observeMetadata':{commandId:id,trackId:id,source:'synthetic',parserVersion:'fixture-1',fields:{title:'合成'}},
  };
  for (const [command,payload] of Object.entries(trusted)) {
    const rejected = await rawRpc(worker,envelope('dispatch',request(command as IpcCommand,payload,datasetId)));
    assert.equal(rejected.ok,false,command); if (rejected.ok) assert.fail('普通port接受可信观察'); assert.equal(rejected.failure.error.code,'INVALID_IPC_REQUEST');
  }
  const injected = await rawRpc(worker,envelope('dispatch',request('localCatalog.createEdition',{commandId:id,title:'合成',edition:'',relative:'私有'},datasetId)));
  assert.equal(injected.ok,false); if (injected.ok) assert.fail('普通port接受额外定位'); assert.equal(injected.failure.error.code,'INVALID_IPC_REQUEST');
  const sequenceBeforeOldEpoch = sequence;
  worker.postMessage({version:1,type:'request',epoch:randomUUID(),requestId:randomUUID(),sequence:9000,operation:'dispatch',request:request('localCatalog.createEdition',{commandId:randomUUID(),title:'旧epoch',edition:''},datasetId)} satisfies DatasetOwnerRequest);
  assert.equal(sequence,sequenceBeforeOldEpoch,'旧epoch合成消息不得推进当前客户端序号');
  const payload = {commandId:randomUUID(),title:'当前epoch',edition:''};
  const freshRequest = envelope('dispatch',request('localCatalog.createEdition',payload,datasetId)); assert.equal(freshRequest.sequence,sequenceBeforeOldEpoch+1);
  const fresh = await rawRpc(worker,freshRequest); assert.equal(fresh.ok,true); if (!fresh.ok) assert.fail('旧epoch污染当前序列'); assert.ok(isAlbumEdition(fresh.result));
  const exit = once(worker,'exit'); const closed = await rawRpc(worker,envelope('close')); assert.equal(closed.ok,true); await exit;
  const cold = createCollectionRepository({filePath:path.join(dataDirectory,'collection.v1.sqlite')});
  try { assert.deepEqual(cold.localCatalog.receipt(payload.commandId)?.result,fresh.result); }
  finally { cold.close(); }
  const db = new DatabaseSync(path.join(dataDirectory,'collection.v1.sqlite'),{readOnly:true});
  try { assert.equal(db.prepare('SELECT count(*) n FROM local_catalog_editions').get()!.n,1); assert.equal(db.prepare('SELECT count(*) n FROM local_catalog_ledger').get()!.n,1); }
  finally { db.close(); }
});

test('MBRS002 B2 receipt：实际owner只查询回执不重执行业务，完整请求指纹冲突保留旧事实', {timeout:30_000}, async t => {
  const parent = await directory(t), f = owner(t,parent), identity = await f.endpoint.prepare();
  const payload = {commandId:randomUUID(),title:'回执查询',edition:'甲'}, write = request('localCatalog.createEdition',payload,identity.datasetId);
  const result = await f.endpoint.dispatch(write);
  const query = {commandId:payload.commandId,operation:'create-edition' as const,fingerprint:fingerprint('create-edition',payload)};
  const receipt = await f.endpoint.dispatch(request('localCatalog.receipt',query,identity.datasetId)); assert.ok(isLocalCatalogReceipt(receipt)); assert.deepEqual(receipt.result,result);
  assert.deepEqual(await f.endpoint.dispatch(request('localCatalog.receipt',query,identity.datasetId)),receipt);
  await assert.rejects(f.endpoint.dispatch(request('localCatalog.receipt',{...query,fingerprint:fingerprint('create-edition',{...payload,title:'换标题'})},identity.datasetId)));
  await assert.rejects(f.endpoint.dispatch(request('localCatalog.createEdition',{...payload,title:'换标题'},identity.datasetId)));
  assert.deepEqual(await f.endpoint.dispatch(write),result);
  assert.equal(await f.endpoint.dispatch(request('localCatalog.receipt',{...query,commandId:randomUUID()},identity.datasetId)),null);
  await f.endpoint.close();
  const db = new DatabaseSync(path.join(parent,'collection.v1.sqlite'),{readOnly:true});
  try { assert.equal(db.prepare('SELECT count(*) n FROM local_catalog_editions').get()!.n,1); assert.equal(db.prepare('SELECT count(*) n FROM local_catalog_ledger').get()!.n,1); }
  finally { db.close(); }
});
