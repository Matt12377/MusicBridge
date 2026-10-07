import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { MessageChannel, Worker } from 'node:worker_threads';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { isAlbumEdition, isLocalArtworkContext, isLocalArtworkSelection, type IpcCommand, type IpcRequest, type IpcResponse, type LocalArtworkImage } from '@music-bridge/contracts';
import { createCollectionRepository } from '../src/collection/repository.js';
import { createLocalArtworkService } from '../src/collection/local-artwork-service.js';
import { dispatchDatasetCommand, dispatchInternalDatasetCommand } from '../src/collection/dataset-dispatch.js';
import { createDatasetCommandBoundary } from '../src/recording/dataset-identity.js';
import { authorizeSourceDirectory } from '../src/recording/source-files.js';
import { createDatasetOwnerClient } from '../src/collection/dataset-owner-client.js';
import { createTestBridgeRuntime } from '../src/runtime.js';
import { attachCoreRuntimePort } from '../src/utility-main.js';

async function fixture(t: test.TestContext) {
  const temporary = process.env.TMPDIR;
  assert.ok(temporary && path.isAbsolute(temporary));
  if (process.platform === 'darwin' && !(process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted')) assert.ok(temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
  const parent = await mkdtemp(path.join(temporary, 'artwork-dispatch-')), sourcePath = path.join(parent, 'source');
  await mkdir(sourcePath);
  const collection = createCollectionRepository({ filePath: path.join(parent, 'collection.sqlite') });
  const assertCurrent = () => { collection.list({ offset: 0, limit: 1 }); };
  const localArtwork = createLocalArtworkService({ repository: collection, assertCurrent }), datasetId = randomUUID();
  const runtime = { collection, localArtwork, commandOutbox: createDatasetCommandBoundary({ datasetId, assertCurrent }) };
  t.after(async () => { await localArtwork.close(); collection.close(); await rm(parent, { recursive: true, force: true }); });
  const root = collection.sources.authorize(randomUUID(), await authorizeSourceDirectory(sourcePath));
  const library = collection.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: root.id, role: 'library' });
  const asset = collection.localCatalog.registerAsset({ commandId: randomUUID(), libraryRootId: library.id, expectedRootRevision: library.revision, relative: 'track.flac', sha256: null, sampleFrames: null, timebaseHz: null });
  const track = collection.localCatalog.createTrack({ commandId: randomUUID(), assetId: asset.id, segment: null });
  const edition = collection.localCatalog.createEdition({ commandId: randomUUID(), title: '分发通路合成发行', edition: '' });
  collection.localCatalog.linkEditionTrack({ commandId: randomUUID(), editionId: edition.id, trackId: track.id, disc: 1, trackNumber: 1, sequence: 1 });
  const payload = { trackId: track.id, editionId: edition.id }, target = collection.localArtwork.context(payload).target!;
  const request = (command: IpcCommand, body: unknown, scope: string | undefined = datasetId): IpcRequest => ({ version: 1, id: randomUUID(), command, payload: body, ...(scope ? { expectedDatasetId: scope } : {}) });
  const bytes = Buffer.from([255, 216, 3, 255, 217]), sha256 = createHash('sha256').update(bytes).digest('hex');
  // 此可信 Main 副本仅检验正式分发/SQLite；不作为 native 图片解码证据。
  const image: LocalArtworkImage = { original: { mime: 'image/jpeg', bytes: bytes.length, sha256, width: 1, height: 1 }, display: { mime: 'image/jpeg', bytes: bytes.length, sha256, width: 1, height: 1, dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}` } };
  return { collection, localArtwork, runtime, datasetId, track, asset, edition, payload, target, request, image };
}

test('封面正式分发可读上下文、私有暂存，并通过 outbox 执行保存与确切重放', async t => {
  const f = await fixture(t), before = f.collection.localCatalog.trackDetail(f.track.id);
  const view = await dispatchDatasetCommand(f.runtime, f.request('localArtwork.context', f.payload));
  assert.ok(isLocalArtworkContext(view)); assert.deepEqual(view.target, f.target);
  const staged = await dispatchInternalDatasetCommand(f.runtime, f.request('localArtwork.stage', { target: f.target, origin: 'manual', sourceIdentity: 'a'.repeat(64), sourceLabel: '合成手选', image: f.image }));
  assert.ok(isLocalArtworkContext(staged)); assert.equal(staged.selection, null);
  const body = { commandId: randomUUID(), target: f.target, candidateId: staged.candidates[0]!.id, expectedSelectionRevision: null };
  const outbox = f.request('commandOutbox.execute', { datasetId: f.datasetId, command: 'localArtwork.apply', payload: body });
  const saved = await dispatchDatasetCommand(f.runtime, outbox) as { command: string; result: unknown };
  assert.equal(saved.command, 'localArtwork.apply'); assert.ok(isLocalArtworkSelection(saved.result));
  assert.deepEqual(await dispatchDatasetCommand(f.runtime, outbox), saved);
  assert.deepEqual(f.collection.localArtwork.context(f.payload).selection, saved.result);
  assert.deepEqual(f.collection.localCatalog.trackDetail(f.track.id), before);
});

test('封面内部命令经真实 Utility 端口及 owner 线程往返，公开或坏请求仍拒绝', { timeout: 20_000 }, async t => {
  const temporary = process.env.TMPDIR;
  assert.ok(temporary && path.isAbsolute(temporary));
  const directory = await mkdtemp(path.join(temporary, 'artwork-owner-routing-')), media = path.join(directory, 'media');
  await mkdir(media);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = createCollectionRepository({ filePath: path.join(directory, 'collection.v1.sqlite') });
  let trackId: string, editionId: string;
  try {
    const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media));
    const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
    const asset = repository.localCatalog.registerAsset({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision,
      relative: '合成未读取.flac', sha256: null, sampleFrames: null, timebaseHz: null });
    const track = repository.localCatalog.createTrack({ commandId: randomUUID(), assetId: asset.id, segment: null });
    const edition = repository.localCatalog.createEdition({ commandId: randomUUID(), title: '真实线程的合成发行', edition: '' });
    repository.localCatalog.linkEditionTrack({ commandId: randomUUID(), editionId: edition.id, trackId: track.id, disc: 1, trackNumber: 1, sequence: 1 });
    trackId = track.id; editionId = edition.id;
  } finally { repository.close(); }
  // 沿用实际领域 worker；继承门禁的 import 围栏，不能让子线程绕过测试网络限制。
  const imports: string[] = [];
  for (let index = 0; index < process.execArgv.length; index++) {
    const argument = process.execArgv[index]!;
    if (argument === '--import') { imports.push(argument, process.execArgv[++index]!); }
    else if (argument.startsWith('--import=')) imports.push(argument);
  }
  if (!imports.some(value => value.includes('tsx'))) imports.push('--import', 'tsx');
  const worker = new Worker(new URL('./helpers/dataset-owner-domain-fixture.ts', import.meta.url), { execArgv: imports, workerData: { dataDirectory: directory } });
  const reasons: string[] = [], endpoint = createDatasetOwnerClient({ worker, onFatal: reason => reasons.push(reason),
    projection: async command => { assert.equal(command, 'scanReadAcquire'); return { status: 'deferred' } as never; } });
  const identity = await endpoint.prepare(), runtime = createTestBridgeRuntime({ datasetOwnerEndpoint: endpoint }), ports = new MessageChannel();
  t.after(() => { ports.port1.close(); ports.port2.close(); });
  t.after(() => runtime.shutdown());
  await attachCoreRuntimePort({ on: (_event, listener) => ports.port1.on('message', data => listener({ data })), start() { ports.port1.start(); },
    postMessage: value => ports.port1.postMessage(value) }, runtime, { beforeReady: () => endpoint.commitBoot() });
  const request = (command: IpcCommand, payload: unknown): IpcRequest => ({ version: 1, id: randomUUID(), command, payload, expectedDatasetId: identity.datasetId });
  const rpc = (message: IpcRequest): Promise<IpcResponse> => new Promise(resolve => {
    const listener = (value: IpcResponse) => { if (value.id !== message.id) return; ports.port2.off('message', listener); resolve(value); };
    ports.port2.on('message', listener); ports.port2.postMessage(message);
  });
  const cancellation = request('localArtwork.cancelLookup', { lookupId: randomUUID() });
  const cancelled = await rpc(cancellation); assert.equal(cancelled.ok, true);
  if (cancelled.ok) assert.deepEqual(cancelled.result, { cancelled: false });
  await assert.rejects(endpoint.dispatch(cancellation), '内部命令不能经公开 owner 入口进入');
  const context = await endpoint.dispatch(request('localArtwork.context', { trackId, editionId }));
  assert.ok(isLocalArtworkContext(context)); assert.ok(context.target);
  const read = await rpc(request('localArtwork.readCandidates', { target: context.target, lookupId: randomUUID() }));
  assert.equal(read.ok, true); if (read.ok) assert.deepEqual(read.result, { status: 'source-unavailable', items: [] });
  // 可信展示副本只检验 SQLite 和路由，native 解码由独立门禁及 App 实操验证。
  const bytes = Buffer.from([255, 216, 3, 255, 217]), sha256 = createHash('sha256').update(bytes).digest('hex');
  const image: LocalArtworkImage = { original: { mime: 'image/jpeg', bytes: bytes.length, sha256, width: 1, height: 1 },
    display: { mime: 'image/jpeg', bytes: bytes.length, sha256, width: 1, height: 1, dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}` } };
  const staged = await rpc(request('localArtwork.stage', { target: context.target, origin: 'manual', sourceIdentity: 'a'.repeat(64), sourceLabel: '线程测试手选', image }));
  assert.equal(staged.ok, true); if (staged.ok) { assert.ok(isLocalArtworkContext(staged.result)); assert.equal(staged.result.candidates.length, 1); assert.equal(staged.result.selection, null); }
  const malformed = await rpc(request('localArtwork.cancelLookup', { lookupId: randomUUID(), url: 'http://127.0.0.1/' }));
  assert.equal(malformed.ok, false); if (!malformed.ok) assert.equal(malformed.error.code, 'INVALID_IPC_REQUEST');
  const wrongScope = await rpc({ ...cancellation, id: randomUUID(), expectedDatasetId: randomUUID() });
  assert.equal(wrongScope.ok, false); if (!wrongScope.ok) assert.equal(wrongScope.error.code, 'OUTBOX_SCOPE_MISMATCH');
  const exit = once(worker, 'exit'); await runtime.shutdown(); assert.deepEqual(await exit, [0]); assert.deepEqual(reasons, []);
});

test('封面分发的读取/取消/建立发行各有处理，越权或旧工作库不能推进保存', async t => {
  const f = await fixture(t), lookupId = randomUUID();
  assert.deepEqual(await dispatchInternalDatasetCommand(f.runtime, f.request('localArtwork.readCandidates', { target: f.target, lookupId })), { status: 'source-unavailable', items: [] });
  assert.deepEqual(await dispatchInternalDatasetCommand(f.runtime, f.request('localArtwork.cancelLookup', { lookupId })), { cancelled: false });
  const created = await dispatchDatasetCommand(f.runtime, f.request('localArtwork.createEdition', { commandId: randomUUID(), trackId: f.track.id, expectedTrackRevision: f.track.selectionRevision, title: '另一个独立发行' }));
  assert.ok(isAlbumEdition(created)); assert.notEqual(created.id, f.edition.id);
  assert.equal(f.collection.localCatalog.editionTracks(created.id)[0]!.trackId, f.track.id);
  for (const command of ['localArtwork.stage', 'localArtwork.readCandidates', 'localArtwork.cancelLookup'] as const) {
    const body = command === 'localArtwork.stage' ? { target: f.target, origin: 'manual', sourceIdentity: 'a'.repeat(64), sourceLabel: '合成', image: f.image } : command === 'localArtwork.readCandidates' ? { target: f.target, lookupId } : { lookupId };
    await assert.rejects(dispatchDatasetCommand(f.runtime, f.request(command, body)));
  }
  const unscoped: IpcRequest = { version: 1, id: randomUUID(), command: 'localArtwork.context', payload: f.payload };
  for (const request of [f.request('localArtwork.context', f.payload, randomUUID()), unscoped, f.request('localArtwork.context', { ...f.payload, path: '私有注入' })]) {
    await assert.rejects(dispatchDatasetCommand(f.runtime, request));
  }
  assert.equal(f.collection.localArtwork.context(f.payload).selection, null);
});
