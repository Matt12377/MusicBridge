import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { fstatSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { BridgeController } from '../../src/application/bridge-controller.js';
import { NeteaseClient } from '../../src/netease/client.js';
import { createScanReadAdmission, type ScanReadAdmission } from '../../src/library/scan-read-admission.js';
import type { MetadataReaderLifecycle } from '../../src/library/metadata-reader-types.js';
import { StreamGateway } from '../../src/stream/gateway.js';
import { StreamRegistry } from '../../src/stream/registry.js';
import { createLogger } from '../../src/shared/logger.js';
import type { RoonPort, RoonState, RoonTerminalReason } from '../../src/roon/types.js';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { createLocalScanCoordinator } from '../../src/collection/local-scan-coordinator.js';
import type { DatasetProjectionPort, DatasetProjectionCommand, DatasetProjectionCommandPayloads, DatasetProjectionCommandResults } from '../../src/collection/dataset-owner-protocol.js';
import { authorizeSourceDirectory } from '../../src/recording/source-files.js';
import { audioFixture, loadFreshMetadataReader } from '../helpers/mbrs003-audio-fixtures.js';

const { createMetadataReader } = await loadFreshMetadataReader();
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/** 外部设备端口可合成；Controller、pending/owner/paused及admission本体不替代。 */
class ExternalRoonPort implements RoonPort {
  state: RoonState = { status: 'ready', selectedZoneId: 'zone-synthetic', transportState: 'stopped', canPause: true, canResume: true };
  setTerminalHandler(_handler: (reason: RoonTerminalReason) => void): void {}
  async start(): Promise<void> {} async shutdown(): Promise<void> {}
  async play(): Promise<void> {} async stop(): Promise<void> {}
  async pause(): Promise<void> {} async resume(): Promise<void> {}
  getState(): RoonState { return { ...this.state }; }
}
function controllerCore() {
  const roon = new ExternalRoonPort(), registry = new StreamRegistry(), logger = createLogger('error');
  let admission: ScanReadAdmission | undefined;
  const gateway: StreamGateway = new StreamGateway({ host: '127.0.0.1', port: 0, publicBaseUrl: 'http://127.0.0.1:0', registry, logger });
  const controller = new BridgeController({ netease: new NeteaseClient(undefined), roon, registry, gateway, logger,
    onReadPriorityChanged: () => admission?.observe(),
    roonLibrary: {
      play: async (_reference, _zone, _track, options) => {
        options?.onDispatch?.(); roon.state = { ...roon.state, transportState: 'playing' };
        return { revision: 1, zoneId: 'zone-synthetic', state: 'playing' as const };
      },
      stop: async () => { roon.state = { ...roon.state, transportState: 'stopped' }; },
      pause: async () => { roon.state = { ...roon.state, transportState: 'paused' }; },
      resume: async () => { roon.state = { ...roon.state, transportState: 'playing' }; },
    },
  });
  admission = createScanReadAdmission({ isBusy: () => controller.hasPlaybackOwnership() });
  return { controller, admission,
    play: () => controller.playRoon({ reference: 'trusted-synthetic-track', zoneId: 'zone-synthetic',
      track: { id: '123', title: '合成曲目', artists: ['合成艺人'], album: '合成专辑' } }),
  };
}

async function scanning(t: test.TestContext, admission: ScanReadAdmission, onLifecycle?: (event: MetadataReaderLifecycle) => void) {
  const fixture = await audioFixture(t), relative = path.basename(fixture.entry('core-flac').file);
  const media = path.join(fixture.directory, 'integration-media'); await mkdir(media, { mode: 0o700 });
  await writeFile(path.join(media, relative), await fixture.bytes('core-flac'), { flag: 'wx', mode: 0o600 });
  const repository = createCollectionRepository({ filePath: path.join(fixture.directory, 'integration.sqlite') });
  const context = { epoch: randomUUID(), datasetId: randomUUID() };
  const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media));
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
  const events: MetadataReaderLifecycle[] = [], fdCloseEvidence: Array<{ fd: number; code: string }> = [];
  const permitResults: Array<'granted' | 'deferred'> = [], revocations: string[] = [];
  let releasedTickets = 0;
  // 只使用默认资源预算与固定compiled Worker；observer仅观察／发起实际外部媒体动作。
  const reader = createMetadataReader({ onLifecycle(event) {
    events.push(event);
    if (event.type === 'lease-released') {
      let code = 'FD_STILL_VALID';
      try { fstatSync(event.fd); } catch (error) { code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN'; }
      fdCloseEvidence.push({ fd: event.fd, code });
    }
    onLifecycle?.(event);
  } });
  const projection: DatasetProjectionPort = {
    async call<K extends DatasetProjectionCommand>(command: K, payload: DatasetProjectionCommandPayloads[K]): Promise<DatasetProjectionCommandResults[K]> {
      let result: unknown;
      if (command === 'scanReadAcquire') {
        result = admission.acquire(context);
        permitResults.push((result as { status: 'granted' | 'deferred' }).status);
      } else if (command === 'scanReadWatchRevocation') {
        result = await admission.watchRevocation(context, (payload as { permitId: string }).permitId);
        revocations.push((result as { reason: string }).reason);
      } else if (command === 'scanReadRelease') {
        // release前必须已经真实exit、FileHandle close和read完成；不靠observer名称代替EBADF。
        const expected: number = releasedTickets + 1;
        assert.equal(events.filter(e => e.type === 'worker-exit').length, expected);
        assert.equal(events.filter(e => e.type === 'lease-released').length, expected);
        assert.equal(events.filter(e => e.type === 'read-complete').length, expected);
        assert.equal(fdCloseEvidence.length, expected);
        assert.equal(fdCloseEvidence[expected - 1]!.code, 'EBADF');
        result = admission.release(context, (payload as { permitId: string }).permitId);
        releasedTickets++;
      } else assert.fail('不借用Roon metadata permit或伪造扫描grant');
      return result as DatasetProjectionCommandResults[K];
    },
  };
  const coordinator = createLocalScanCoordinator({ repository, datasetId: context.datasetId, projection, reader,
    assertCurrent: () => { repository.list({ offset: 0, limit: 1 }); },
  });
  function assertQuiet() {
    const starts = events.filter(e => e.type === 'worker-start'), exits = events.filter(e => e.type === 'worker-exit');
    assert.equal(starts.length, exits.length);
    for (const start of starts) {
      assert.ok(start.type === 'worker-start');
      const startIndex: number = events.indexOf(start);
      const exitIndex: number = events.findIndex((exit, index) => index > startIndex && exit.type === 'worker-exit' && exit.threadId === start.threadId && exit.fd === start.fd);
      const releaseIndex: number = events.findIndex((event, index) => index > exitIndex && event.type === 'lease-released' && event.fd === start.fd);
      const completeIndex: number = events.findIndex((event, index) => index > releaseIndex && event.type === 'read-complete');
      assert.equal(exitIndex > startIndex && releaseIndex > exitIndex && completeIndex > releaseIndex, true);
    }
    assert.equal(events.filter(e => e.type === 'lease-acquired').length, fdCloseEvidence.length);
    for (const close of fdCloseEvidence) assert.equal(close.code, 'EBADF');
    assert.equal(releasedTickets, exits.length);
    assert.deepEqual(admission.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: false });
  }
  function assertUntouched(jobId: string) {
    const job = coordinator.get(jobId);
    assert.equal(job.phase, 'paused'); assert.equal(job.failureCode, null);
    assert.deepEqual(job.progress, { visited: '0', accepted: '0', rejected: '0' });
    assert.equal(repository.localScan.privateFileState(root.id, relative), null);
    assert.equal(repository.localScan.privateCheckpoint(jobId), null);
    assert.equal(repository.localScan.privatePreparedBatches(jobId).length, 0);
    assert.equal(repository.localCatalog.pageTracks({ offset: 0, limit: 200 }).total, 0);
    return job;
  }
  async function resume(jobId: string) {
    const paused = coordinator.get(jobId);
    coordinator.resume({ commandId: randomUUID(), jobId, expectedRevision: paused.jobRevision });
    await coordinator.privateWait(jobId);
    const completed = coordinator.get(jobId);
    assert.equal(completed.phase, 'completed');
    assert.deepEqual(completed.progress, { visited: '1', accepted: '1', rejected: '0' });
    const record = repository.localScan.privateFileState(root.id, relative);
    assert.ok(record); assert.equal(record.value.outcome, 'accepted'); assert.equal(record.value.failureCode, null);
    assert.ok(record.value.assetId && record.value.trackId && record.value.readFacts);
    assert.ok(record.value.readFacts.readEvidence.bytesRead > 0);
    assert.equal(repository.localCatalog.pageTracks({ offset: 0, limit: 200 }).total, 1);
    assertQuiet(); await fixture.assertUnchanged();
  }
  return { fixture, coordinator, repository, root, events, permitResults, revocations, assertQuiet, assertUntouched, resume,
    releaseCount: () => releasedTickets,
    start: () => coordinator.start({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision }),
    async close() {
      try {
        await coordinator.close();
        assert.deepEqual(admission.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: false });
      } finally { admission.close(); repository.close(); }
      assert.deepEqual(admission.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: true });
    },
  };
}

test('MBRS003组合：真实Controller pending撤销Coordinator在途Worker，FD quiet后票据释放且同文件明确恢复', { timeout: 60_000 }, async t => {
  const core = controllerCore(); let first = true, pendingObserved = false, playing: Promise<unknown> | undefined, playFailure: unknown;
  const scan = await scanning(t, core.admission, event => {
    if (first && event.type === 'worker-online') {
      first = false; playing = core.play(); pendingObserved = core.controller.hasPlaybackOwnership(); void playing.catch(error => { playFailure = error; });
    }
  });
  t.after(async () => { try { await scan.close(); } finally { await core.controller.shutdown(); } });
  const job = scan.start(); await scan.coordinator.privateWait(job.jobId);
  assert.equal(first, false, '必须真的启动并online，而不是未打开FD的准备失败');
  assert.equal(pendingObserved, true, 'actual Controller受理pending必须同步繁忙');
  assert.equal(playFailure, undefined); assert.ok(playing); await playing;
  assert.equal(core.controller.hasPlaybackOwnership(), true);
  assert.ok(scan.revocations.includes('media-busy'));
  scan.assertUntouched(job.jobId); scan.assertQuiet();
  assert.equal(scan.events.filter(e => e.type === 'worker-start').length, 1);
  assert.equal(scan.releaseCount(), 1);
  const completion = scan.events.find(e => e.type === 'read-complete');
  assert.ok(completion && completion.type === 'read-complete'); assert.equal(completion.status, 'failure');
  await core.controller.pause(); assert.equal(core.controller.getPlaybackState().state, 'paused');
  const startsBefore: number = scan.events.filter(e => e.type === 'worker-start').length;
  const paused = scan.coordinator.get(job.jobId);
  scan.coordinator.resume({ commandId: randomUUID(), jobId: job.jobId, expectedRevision: paused.jobRevision });
  await scan.coordinator.privateWait(job.jobId);
  scan.assertUntouched(job.jobId);
  assert.equal(scan.events.filter(e => e.type === 'worker-start').length, startsBefore, 'paused ownership期间不新开FD/worker');
  assert.equal(scan.permitResults.at(-1), 'deferred');
  await core.controller.stop(); assert.equal(core.controller.hasPlaybackOwnership(), false);
  await turn(); scan.assertUntouched(job.jobId);
  await scan.resume(job.jobId);
  assert.equal(scan.releaseCount(), 2);
  assert.equal(scan.events.filter(e => e.type === 'worker-start').length, 2);
  // 真软件取消/重读/持久记录证据；不宣称媒体开始前OS绝对零重叠或真实Roon播放。
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
async function stopServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test('MBRS003组合：真实localhost Gateway body占用阻断Coordinator新FD，body结束不自动恢复，显式resume真实入库', { timeout: 60_000 }, async t => {
  const fixture = await audioFixture(t), bytes = await fixture.bytes('core-flac'); assert.ok(bytes.length > 64);
  const held = deferred<ServerResponse>(), idle = deferred<void>(); let upstreamResponse: ServerResponse | undefined;
  const upstream = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/synthetic.flac') { response.writeHead(404); response.end(); return; }
    upstreamResponse = response;
    response.writeHead(200, { 'Content-Type': 'audio/flac', 'Content-Length': bytes.length });
    response.write(bytes.subarray(0, 64)); held.resolve(response);
    // 保留真实HTTP body，直到主测试完成忙时扫描断言；不是任意sleep或busy布尔注入。
  });
  let scan: Awaited<ReturnType<typeof scanning>> | undefined, gateway: StreamGateway | undefined;
  const clientAbort = new AbortController();
  t.after(async () => {
    try { upstreamResponse?.end(); clientAbort.abort(); await gateway?.stop(); }
    finally { try { await stopServer(upstream); } finally { await scan?.close(); } }
  });
  const upstreamBase = await listen(upstream), registry = new StreamRegistry();
  let admission: ScanReadAdmission | undefined;
  const activeGateway: StreamGateway = new StreamGateway({ host: '127.0.0.1', port: 0, publicBaseUrl: 'http://127.0.0.1:0', registry, logger: createLogger('error'),
    fetcher: async (url, init) => {
      assert.equal(url, 'https://cdn.example/musicbridge-synthetic.flac');
      // 唯一被替代的是外部Provider端口：真实fetch明确映射本轮localhost，不DNS/连真实账号。
      return fetch(`${upstreamBase}/synthetic.flac`, { ...init, redirect: 'error' });
    },
    onMediaReadActivityChanged: () => { admission?.observe(); if (activeGateway.getActiveMediaReadCount() === 0) idle.resolve(); },
  });
  gateway = activeGateway;
  admission = createScanReadAdmission({ isBusy: () => activeGateway.getActiveMediaReadCount() > 0 });
  const activeScan = await scanning(t, admission); scan = activeScan;
  await activeGateway.start();
  const registration = registry.register({ metadata: { id: '123', title: '合成曲目', artists: [], album: '合成' }, requestedQuality: 'lossless',
    resolve: async () => ({ trackId: '123', upstreamUrl: 'https://cdn.example/musicbridge-synthetic.flac', requestedQuality: 'lossless', actualQuality: 'lossless', format: 'flac' }),
  });
  const response = await fetch(`${activeGateway.localBaseUrl()}/stream/${registration.token}.flac`, { signal: clientAbort.signal });
  assert.equal(response.status, 200); assert.ok(response.body);
  const stream = response.body.getReader(), first = await stream.read(); assert.equal(first.done, false); assert.ok(first.value && first.value.byteLength > 0);
  await held.promise; assert.equal(activeGateway.getActiveMediaReadCount(), 1);
  const job = activeScan.start(); await activeScan.coordinator.privateWait(job.jobId);
  activeScan.assertUntouched(job.jobId); assert.deepEqual(activeScan.permitResults, ['deferred']);
  assert.equal(activeScan.events.length, 0, '实际HTTP body仍占用时扫描必须在FD/worker前让步');
  assert.equal(activeScan.releaseCount(), 0); assert.equal(admission.resourceCounts().permits, 0);
  assert.equal(activeGateway.getActiveMediaReadCount(), 1);
  const hash = createHash('sha256'); hash.update(first.value); let received: number = first.value.byteLength;
  upstreamResponse!.end(bytes.subarray(64));
  for (;;) { const next = await stream.read(); if (next.done) break; received += next.value.byteLength; hash.update(next.value); }
  await idle.promise;
  assert.equal(received, bytes.length); assert.equal(hash.digest('hex'), createHash('sha256').update(bytes).digest('hex'));
  assert.equal(activeGateway.getActiveMediaReadCount(), 0);
  assert.deepEqual(activeGateway.getDiagnosticResourceCounters(), { listenerCount: 0, timerCount: 0 });
  registry.revoke(registration.token); assert.equal(registry.size, 0);
  await turn(); activeScan.assertUntouched(job.jobId); assert.equal(activeScan.events.length, 0, 'body结束不会偷偷自动resume');
  await activeScan.resume(job.jobId);
  assert.equal(activeScan.releaseCount(), 1); assert.deepEqual(activeScan.permitResults, ['deferred', 'granted']);
  assert.equal(activeScan.events.filter(e => e.type === 'worker-start').length, 1);
  await fixture.assertUnchanged();
  // 此项实测前只能NOT_RUN：body占用→开FD前deferred→显式恢复，不冒称HTTP启动取消已在途短解析的竞速。
});
