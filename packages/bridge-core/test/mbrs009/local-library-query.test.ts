import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { catalogFixture,parserVersion } from '../mbrs006/catalog-fixture.js';
import {dispatchDatasetCommand} from '../../src/collection/dataset-dispatch.js';
import { createDatasetOwnerClient } from '../../src/collection/dataset-owner-client.js';
import { attachCoreRuntimePort } from '../../src/utility-main.js';
import { buildStoragePolicy } from '../../../../apps/desktop/scripts/build-storage-root.mjs';
import { isAudioAsset, isLibraryRoot, isLocalTrack, validateIpcResponseForCommand, type IpcCommand, type IpcResponse, type SourceRoot, type LocalLibraryTrackDetail } from '@music-bridge/contracts';
test('009原作者有界分页搜索，保留同名文件身份和字面通配符', async t => {
  const f = await catalogFixture(t), catalog = f.repository.localCatalog as any;
  for (let i = 0; i < 205; i++) {
    const asset = catalog.registerAsset({ commandId: randomUUID(), libraryRootId: f.root.id, expectedRootRevision: '1', relative: `合成${i}.wav`, sha256: null, sampleFrames: null, timebaseHz: null });
    const track = catalog.createTrack({ commandId: randomUUID(), assetId: asset.id, segment: null });
    catalog.observeMetadata({ commandId: randomUUID(), trackId: track.id, source: 'synthetic', parserVersion: '009-test', fields: { title: '同名 %_ 专辑', artist: '作者', album: '发行 1999' } });
  }
  const pages = [0, 100, 200].map(offset => catalog.queryTracks({ query: '%_', rootId: null, offset, limit: 100 }));
  assert.deepEqual(pages.map(p => p.items.length), [100, 100, 5]);
  assert.equal(pages[0].total, 205); assert.equal(pages[2].hasMore, false);
  assert.equal(new Set(pages.flatMap(p => p.items.map((item: any) => item.track.id))).size, 205);
  assert.equal(catalog.queryTracks({ query: "' OR 1=1 --", rootId: null, offset: 0, limit: 100 }).total, 0);
  assert.throws(() => catalog.queryTracks({ query: '', rootId: null, offset: 0, limit: 201 }));
});
test('009覆盖与原始名称都可搜索，详情保留原始/覆盖/生效分层且不造版本身份', async t => {
  const f = await catalogFixture(t), catalog = f.repository.localCatalog as any, track = f.tracks[0]!;
  catalog.overrideMetadata({ commandId: randomUUID(), trackId: track.id, expectedRevision: null, fields: { title: '显示名（重制版）' } });
  for (const query of ['显示名', '一.wav']) assert.equal(catalog.queryTracks({ query, rootId: f.root.id, offset: 0, limit: 100 }).items[0].track.id, track.id);
  const detail = catalog.trackDetail(track.id);
  assert.equal(detail.metadata.raw.title, '一.wav'); assert.equal(detail.metadata.effective.title, '显示名（重制版）');
  assert.equal(detail.metadata.override.fields.title, '显示名（重制版）'); assert.deepEqual(detail.editions, []);
  assert.doesNotMatch(JSON.stringify(detail), /relative|signature|absolutePath|session_id/u);
});
test('009只读发现已有发行关系，不把其他同名发行混入', async t => {
  const f = await catalogFixture(t), catalog = f.repository.localCatalog as any;
  const edition = catalog.createEdition({ commandId: randomUUID(), title: '同名发行', edition: '首版' });
  catalog.createEdition({ commandId: randomUUID(), title: '同名发行', edition: '重制' });
  catalog.linkEditionTrack({ commandId: randomUUID(), editionId: edition.id, trackId: f.tracks[0]!.id, disc: 1, trackNumber: 1, sequence: 1 });
  assert.deepEqual(catalog.trackDetail(f.tracks[0]!.id).editions, [edition]);
});
test('009MB_ONLY更名不改原文件bytes、asset或曲目身份', async t => {
  const f = await catalogFixture(t), track = f.tracks[0]!, before = await readFile(path.join(f.media, '一.wav'));
  const asset = f.repository.localCatalog.asset(track.assetId);
  f.repository.localCatalog.overrideMetadata({ commandId: randomUUID(), trackId: track.id, expectedRevision: null, fields: { title: '仅展示名' } });
  assert.deepEqual(await readFile(path.join(f.media, '一.wav')), before);
  assert.deepEqual(f.repository.localCatalog.asset(track.assetId), asset);
  assert.deepEqual(f.repository.localCatalog.track(track.id), track);
});
test('009详情参数只读当前扫描事实，增量重读仍保留已证实参数，资产修订改变则未知', async t => {
  const f=await catalogFixture(t),track=f.tracks[0]!,read=async()=>await dispatchDatasetCommand({collection:f.repository,commandOutbox:{assertScope:(value:string)=>assert.equal(value,f.datasetId)} as any},{version:1,id:randomUUID(),command:'localCatalog.trackDetail',payload:{trackId:track.id},expectedDatasetId:f.datasetId}) as LocalLibraryTrackDetail;
  const before=await read();assert.equal(before.fileParameters?.sampleRateHz,48000);assert.equal(before.fileParameters?.bitsPerSample,16);
  (await f.commit(['一.wav'])).apply();assert.equal((await read()).fileParameters?.sampleRateHz,48000);
  const state=f.repository.localScan.privateCurrentFileState(f.root.id,'一.wav')!.value;
  const pending=f.repository.localScan.start({commandId:randomUUID(),datasetId:f.datasetId,libraryRootId:f.root.id,expectedRootRevision:f.root.revision,parserVersion}).job;
  const running=f.repository.localScan.resume({commandId:randomUUID(),jobId:pending.jobId,expectedRevision:pending.jobRevision});
  const batch={batchId:randomUUID(),jobId:running.jobId,expectedJobRevision:running.jobRevision,checkpointBefore:running.checkpointRef,items:[{relative:'一.wav',signature:state.signature,parserVersion,outcome:'accepted' as const,fields:{},failureCode:null,reused:true,readFacts:null}],frontier:[],completed:true};
  f.repository.localScan.privatePrepareBatch({commandId:randomUUID(),jobId:running.jobId,batch});f.repository.localScan.privateCommitBatch({commandId:randomUUID(),jobId:running.jobId,batchId:batch.batchId,expectedRevision:running.jobRevision});assert.equal((await read()).fileParameters?.sampleRateHz,48000);
  const asset=f.repository.localCatalog.asset(track.assetId);
  f.repository.localCatalog.replaceAsset({commandId:randomUUID(),assetId:asset.id,expectedFileRevision:asset.fileRevision,expectedLocationRevision:asset.locationRevision,libraryRootId:f.root.id,expectedRootRevision:f.root.revision,relative:'一.wav',sha256:null,sampleFrames:null,timebaseHz:null});
  const changed=await read();assert.equal(changed.fileParameters,null);assert.doesNotMatch(JSON.stringify(changed),/signature|relative|absolutePath|ticketId/u);assert.equal(changed.track.id,track.id);assert.equal(f.tickets.size,0);
});
test('009真实Core端口沿唯一Dataset Owner Worker读取有界页与详情并拒旧scope', { timeout: 30_000 }, async t => {
  const storage = buildStoragePolicy(), temporary = storage.check(process.env.TMPDIR!, { mustExist: true });
  const directory = await mkdtemp(path.join(temporary, 'mbrs009-owner-')), media = path.join(directory, '合成授权目录'); await mkdir(media);
  const worker = new Worker(new URL('../helpers/dataset-owner-domain-fixture.ts', import.meta.url), { execArgv: ['--import', new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url).href], workerData: { dataDirectory: directory } });
  const endpoint = createDatasetOwnerClient({ worker });
  t.after(async () => { if (worker.threadId !== -1) await endpoint.close().catch(() => worker.terminate()); await rm(directory, { recursive: true, force: true }); });
  const identity = await endpoint.prepare(), request = (command: IpcCommand, payload: unknown, datasetId = identity.datasetId) => ({ version: 1 as const, id: randomUUID(), command, payload, expectedDatasetId: datasetId });
  const source = await endpoint.dispatch(request('recordingSources.authorize', { commandId: randomUUID(), absolutePath: media })) as SourceRoot;
  const root = await endpoint.dispatchInternal!(request('localCatalog.registerRoot', { commandId: randomUUID(), sourceRootId: source.id, role: 'library' })); assert.ok(isLibraryRoot(root));
  const asset = await endpoint.dispatchInternal!(request('localCatalog.registerAsset', { commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision, relative: '合成.wav', sha256: null, sampleFrames: null, timebaseHz: null })); assert.ok(isAudioAsset(asset));
  const track = await endpoint.dispatch(request('localCatalog.createTrack', { commandId: randomUUID(), assetId: asset.id, segment: null })); assert.ok(isLocalTrack(track));
  await endpoint.dispatchInternal!(request('localCatalog.observeMetadata', { commandId: randomUUID(), trackId: track.id, source: 'synthetic', parserVersion: '009-owner-test', fields: { title: '真实单作者合成曲目', artist: '合成作者' } }));
  let listener!: (event: { data: unknown }) => void;
  const waiting = new Map<string, (response: IpcResponse) => void>();
  const port = { on(_event: string, fn: typeof listener) { listener = fn; }, start() {}, postMessage(value: unknown) { const response = value as IpcResponse; if (response.id) waiting.get(response.id)?.(response); } };
  await attachCoreRuntimePort(port, { datasetOwnerEndpoint: endpoint, start: async () => {}, getState: () => ({}) } as any);
  const read = (command: IpcCommand, payload: unknown, datasetId = identity.datasetId) => new Promise<IpcResponse>((resolve, reject) => {
    const value = request(command, payload, datasetId), timer = setTimeout(() => { waiting.delete(value.id); reject(new Error('合成Core查询超出有界期限')); }, 10_000);
    waiting.set(value.id, response => { clearTimeout(timer); waiting.delete(value.id); resolve(response); }); listener({ data: value });
  });
  const query = { query: '单作者', rootId: root.id, offset: 0, limit: 100 }, page = await read('localCatalog.queryTracks', query);
  assert.equal(page.ok, true); const checkedPage = validateIpcResponseForCommand(page, 'localCatalog.queryTracks'); assert.equal(checkedPage.ok, true);
  assert.equal((page as any).result.total, 1); assert.equal((page as any).result.items[0].track.id, track.id);
  const detail = await read('localCatalog.trackDetail', { trackId: track.id }); assert.equal(detail.ok, true); assert.equal(validateIpcResponseForCommand(detail, 'localCatalog.trackDetail').ok, true); assert.equal((detail as any).result.fileParameters, null);
  assert.equal((await read('localCatalog.queryTracks', query, randomUUID())).ok, false);
  assert.equal((await read('localCatalog.trackDetail', { trackId: track.id, absolutePath: media })).ok, false);
  assert.doesNotMatch(JSON.stringify([page, detail]), /absolutePath|signature|relative|ticketId/u);
});
