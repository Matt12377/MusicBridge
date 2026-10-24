import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { IpcCommand, IpcRequest, SourceRoot, LibraryRoot, LocalPlayRequest, LocalTrack, ScanJobRecord } from '@music-bridge/contracts';
import { createDatasetOwnerClient } from '../../src/collection/dataset-owner-client.js';
import { isDatasetOwnerRequest, type DatasetProjectionCommandResults } from '../../src/collection/dataset-owner-protocol.js';
import { createScanReadAdmission } from '../../src/library/scan-read-admission.js';
import { LocalSourceFence } from '../../src/stream/local-source-fence.js';
import { buildStoragePolicy } from '../../../../apps/desktop/scripts/build-storage-root.mjs';

test('本地LRC私有操作闭合同：只接收原ticket和同dataset，不接路径/Provider/额外字段', () => {
  const request = { version: 1, type: 'request', epoch: randomUUID(), requestId: randomUUID(), sequence: 1,
    operation: 'readLocalSourceLyrics', expectedDatasetId: randomUUID(), local: { ticketId: randomUUID() } };
  assert.equal(isDatasetOwnerRequest(request), true);
  for (const value of [{ ...request, local: { ...request.local, relative: '任意.lrc' } }, { ...request, local: { ...request.local, providerId: '123' } },
    { ...request, local: { selection: {} } }, { ...request, local: { ticketId: '' } }, { ...request, expectedDatasetId: undefined },
    { ...request, request: { version: 1, id: 'fake', command: 'lyrics.get', payload: { trackId: '123' } } }]) assert.equal(isDatasetOwnerRequest(value), false);
});

test('真实Owner Worker/SQLite：扫描UUID→既有播放ticket→同stem歌词；旁置变化不缓存，撤权/close后拒绝', { timeout: 30_000 }, async t => {
  const storage = buildStoragePolicy(), directory = await mkdtemp(path.join(storage.check(process.env.TMPDIR!, { mustExist: true }), 'local-lrc-owner-'));
  const media = path.join(directory, '合成媒体'); await mkdir(media); await writeFile(path.join(media, '一.wav'), Buffer.from('owned synthetic audio bytes'));
  await writeFile(path.join(media, '一.lrc'), '[00:00.00]\n[00:01.00]原旁置正文\n[00:03.00]');
  const worker = new Worker(new URL('./owner-worker.ts', import.meta.url), { execArgv: ['--import', 'tsx'], workerData: { dataDirectory: path.join(directory, 'data') } });
  const admission = createScanReadAdmission({ isBusy: () => false }), fatals: string[] = [];
  const endpoint = createDatasetOwnerClient({ worker, onFatal: reason => fatals.push(reason), projection: async (command, payload, context) => {
    const scope = { epoch: context.epoch, datasetId: context.datasetId! };
    if (command === 'scanReadAcquire') return admission.acquire(scope) as DatasetProjectionCommandResults[typeof command];
    if (command === 'scanReadWatchRevocation') return await admission.watchRevocation(scope, (payload as { permitId: string }).permitId) as DatasetProjectionCommandResults[typeof command];
    if (command === 'scanReadRelease') return admission.release(scope, (payload as { permitId: string }).permitId) as DatasetProjectionCommandResults[typeof command];
    throw new Error('本地LRC Gate不启动Provider或外部服务');
  } });
  t.after(async () => { await endpoint.close().catch(() => worker.terminate()); admission.close(); await rm(directory, { recursive: true, force: true }); });
  const identity = await endpoint.prepare(); await endpoint.commitBoot();
  const request = (command: IpcCommand, payload: unknown): IpcRequest => ({ version: 1, id: randomUUID(), command, payload, expectedDatasetId: identity.datasetId });
  const source = await endpoint.dispatch(request('recordingSources.authorize', { commandId: randomUUID(), absolutePath: media })) as SourceRoot;
  const root = await endpoint.dispatchInternal!(request('localCatalog.registerRoot', { commandId: randomUUID(), sourceRootId: source.id, role: 'library' })) as LibraryRoot;
  let job = await endpoint.dispatch(request('localScan.start', { commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision })) as ScanJobRecord;
  const deadline = performance.now() + 3000;
  while (job.phase !== 'completed' && performance.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 10)); job = await endpoint.dispatch(request('localScan.get', { jobId: job.jobId })) as ScanJobRecord; }
  assert.equal(job.phase, 'completed'); assert.equal(job.progress.accepted, '1');
  const track = (await endpoint.dispatch(request('localCatalog.pageTracks', { offset: 0, limit: 1 })) as { items: LocalTrack[] }).items[0]!;
  const selection: LocalPlayRequest = { schema_version: '1.2', request_id: randomUUID(), route: 'roon_audio_input', source_kind: 'local_file',
    local_track_id: track.id, asset_id: track.assetId, expected_asset_revision: '1', target: { core_id: 'synthetic-core', zone_id: 'synthetic-zone' }, action: 'PLAY_NOW' };
  const capture = await endpoint.captureLocalSource!(selection), fence = new LocalSourceFence(capture.buffer);
  assert.equal(capture.facts.root.role, 'library'); assert.equal(capture.facts.track.id, track.id); assert.equal(capture.datasetId, identity.datasetId);
  const first = await endpoint.readLocalSourceLyrics!(capture.ticketId); assert.equal(first.status, 'ready'); assert.equal(first.lines[0]?.text, '原旁置正文'); assert.equal(first.source, undefined); assert.equal(fence.references, 0);
  await writeFile(path.join(media, '一.lrc'), '[00:01.00]真实替换旁置正文');
  const next = await endpoint.readLocalSourceLyrics!(capture.ticketId); assert.equal(next.lines[0]?.text, '真实替换旁置正文'); assert.equal(fence.current, true); assert.equal(fence.references, 0);
  await assert.rejects(endpoint.readLocalSourceLyrics!(randomUUID()));
  await endpoint.dispatch(request('recordingSources.revoke', { commandId: randomUUID(), id: source.id }));
  assert.equal(fence.current, false); await assert.rejects(endpoint.readLocalSourceLyrics!(capture.ticketId));
  await endpoint.releaseLocalSource!(capture.ticketId); await endpoint.close(); assert.deepEqual(fatals, []);
  await assert.rejects(endpoint.readLocalSourceLyrics!(capture.ticketId));
});
