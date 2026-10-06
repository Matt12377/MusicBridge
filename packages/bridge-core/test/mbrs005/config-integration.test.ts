import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import type { LocalPlayRequest } from '@music-bridge/contracts';
import { createTrustedLocalMediaNetwork, isTrustedLocalMediaNetwork, loadConfig } from '../../src/config/config.js';
import { StreamGateway } from '../../src/stream/gateway.js';
import { StreamRegistry } from '../../src/stream/registry.js';
import { createLogger } from '../../src/shared/logger.js';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { createLocalScanCoordinator } from '../../src/collection/local-scan-coordinator.js';
import { createScanReadAdmission } from '../../src/library/scan-read-admission.js';
import type { DatasetProjectionPort, DatasetProjectionCommand, DatasetProjectionCommandPayloads, DatasetProjectionCommandResults } from '../../src/collection/dataset-owner-protocol.js';
import { prepareLocalSourceReadonly } from '../../src/application/local-source-resolver.js';
import { fixture, authority } from './fixture.js';

test('AT05 受信媒体接口配置与身份校验：默认关闭、伪造/公网/广域监听/非法公告均拒绝', async () => {
  const input = { bindAddress: '192.168.1.20', port: 38512, advertisedBaseUrl: 'http://192.168.1.20:38512', allowedPeers: ['192.168.1.30'] };
  const config = createTrustedLocalMediaNetwork(input); assert.equal(isTrustedLocalMediaNetwork(config), true); assert.equal(isTrustedLocalMediaNetwork(input), false);
  assert.equal(Object.isFrozen(config), true); assert.equal(Object.isFrozen(config.allowedPeers), true); assert.equal(isTrustedLocalMediaNetwork(structuredClone(config)), false);
  for (const patch of [{ bindAddress: '0.0.0.0' }, { bindAddress: '8.8.8.8' }, { bindAddress: '127.0.0.1' }, { allowedPeers: ['8.8.8.8'] }, { allowedPeers: [] }, { port: 0 },
    { advertisedBaseUrl: 'https://192.168.1.20:38512' }, { advertisedBaseUrl: 'http://user:password@192.168.1.20:38512' }, { advertisedBaseUrl: 'http://192.168.1.21:38512' },
    { advertisedBaseUrl: 'http://192.168.1.20:38512/path' }, { advertisedBaseUrl: 'http://192.168.1.20:38512/?token=x' }, { advertisedBaseUrl: 'http://192.168.1.20:38512/#x' }]) {
    assert.throws(() => createTrustedLocalMediaNetwork({ ...input, ...patch }));
  }
  const registry = new StreamRegistry(), gateway = new StreamGateway({ host: '127.0.0.1', port: 0, publicBaseUrl: 'http://127.0.0.1:0', registry, logger: createLogger('error'), localMediaNetwork: input });
  await assert.rejects(gateway.start(), /未经可信启动/u); await gateway.stop();
  const defaults = loadConfig({ BRIDGE_LOCAL_MEDIA_LAN: 'true' }); assert.equal(defaults.controlHost, '127.0.0.1'); assert.equal(defaults.streamHost, '127.0.0.1'); assert.equal(Object.hasOwn(defaults, 'localMediaNetwork'), false);
  assert.throws(() => loadConfig({ BRIDGE_CONTROL_HOST: '0.0.0.0' })); assert.throws(() => loadConfig({ BRIDGE_STREAM_HOST: '192.168.1.20' }));
  // 这里只验证准入接口；不在本任务执行真实LAN监听或Roon访问。
});

test('AT01/12 原SQLite唯一catalog→只读resolver→生产Registry/固定FD真实HTTP，事实变化撤销', async t => {
  const f = await fixture(t), repository = createCollectionRepository({ filePath: path.join(f.directory, 'catalog.sqlite') }); t.after(() => repository.close());
  const { id: _, ...capability } = f.descriptor.facts.sourceRoot;
  const source = repository.sources.authorize(randomUUID(), capability), catalog = repository.localCatalog;
  const root = catalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
  const context = { datasetId: randomUUID(), epoch: randomUUID() }, admission = createScanReadAdmission({ isBusy: () => false });
  const projection: DatasetProjectionPort = { async call<K extends DatasetProjectionCommand>(command: K, payload: DatasetProjectionCommandPayloads[K]): Promise<DatasetProjectionCommandResults[K]> {
    let result: unknown;
    if (command === 'scanReadAcquire') result = admission.acquire(context);
    else if (command === 'scanReadWatchRevocation') result = await admission.watchRevocation(context, (payload as { permitId: string }).permitId);
    else if (command === 'scanReadRelease') result = admission.release(context, (payload as { permitId: string }).permitId);
    else throw new Error('合成本地扫描只允许现有读取票据。');
    return result as DatasetProjectionCommandResults[K];
  } };
  // 元数据结果明确由受控Reader注入；目录stat、扫描Owner、SQLite事实与后续HTTP均为现有实际通路。
  const scanner = createLocalScanCoordinator({ repository, datasetId: context.datasetId, projection, assertCurrent() {}, reader: {
    async read() { return { status: 'ok' as const, parserVersion: 'music-metadata-11.15.0/mbrs003-v1' as const, fields: { title: '合成原始字节' },
      technical: { container: 'WAVE' as const, codec: 'PCM', lossless: true, sampleRateHz: 48000, channels: 2, bitsPerSample: 16, durationSeconds: 1, evidence: 'bounded-parser-reported' as const }, coverEvidence: [],
      readEvidence: { bytesRead: 4, readCalls: 1, maxReadBytes: 4, allocationBytes: 4, elapsedMs: 1, wholeAudioHash: false as const, wholeAudioDecode: false as const } }; }, async close() {} } });
  t.after(async () => { await scanner.close(); admission.close(); }); const job = scanner.start({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision }); await scanner.privateWait(job.jobId);
  assert.equal(scanner.get(job.jobId).phase, 'completed'); const tracks = catalog.pageTracks({ offset: 0, limit: 10 }); assert.equal(tracks.total, 1);
  const track = tracks.items[0]!, asset = catalog.asset(track.assetId);
  const request: LocalPlayRequest = { schema_version: '1.2', route: 'roon_audio_input', source_kind: 'local_file', request_id: randomUUID(), local_track_id: track.id, asset_id: asset.id, expected_asset_revision: asset.fileRevision, target: f.descriptor.target, action: 'PLAY_NOW' };
  const prepared = prepareLocalSourceReadonly(request, repository, { captureCurrentTarget: () => ({ target: request.target, isCurrent: () => true }) }); assert.ok('source_kind' in prepared);
  assert.equal(prepared.facts.observation?.signature, repository.localScan.privateCurrentFileState(root.id, f.descriptor.facts.relative)?.value.signature);
  const registry = new StreamRegistry(), gateway = new StreamGateway({ host: '127.0.0.1', port: 0, publicBaseUrl: 'http://127.0.0.1:0', registry, logger: createLogger('error') });
  await gateway.start(); t.after(() => gateway.stop());
  const current = () => catalog.asset(asset.id).locationRevision === prepared.facts.asset.locationRevision && catalog.track(track.id).selectionRevision === prepared.facts.track.selectionRevision && repository.sources.root(source.id).authorized;
  const registration = await registry.registerLocalSource(prepared, { ...authority(), isCurrent: current });
  const url = gateway.localStreamUrl(registration.token), response = await fetch(url, { headers: { Range: 'bytes=1-7' } });
  assert.equal(response.status, 206); assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes.subarray(1, 8));
  assert.equal(JSON.stringify(catalog.asset(asset.id)).includes(f.descriptor.facts.relative), false);
  catalog.moveAsset({ commandId: randomUUID(), assetId: asset.id, expectedRootRevision: root.revision, expectedLocationRevision: asset.locationRevision, relative: '新的位置.wav' });
  const denied = await fetch(url); assert.equal(denied.status, 409); assert.equal(await denied.text(), ''); await registration.lease.close();
  assert.equal(registration.lease.state, 'CLOSED'); assert.equal(registration.lease.revisions.locationRevision, '1'); assert.equal(catalog.asset(asset.id).locationRevision, '2');
});

test('AT07 停止与异步prepare竞争不能留下可见token/FD，关闭后Registry拒绝新准备', async t => {
  const f = await fixture(t), registry = new StreamRegistry();
  const pending = registry.registerLocalSource(f.descriptor, authority()).catch(error => error);
  await registry.closeLocal(); const result = await pending; assert.ok(result instanceof Error);
  await assert.rejects(registry.registerLocalSource(f.descriptor, authority(2)), /已关闭/u);
});
