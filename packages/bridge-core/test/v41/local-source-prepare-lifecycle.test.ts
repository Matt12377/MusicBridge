import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { fstatSync } from 'node:fs';
import promises, { type FileHandle } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { LocalPlayRequest } from '@music-bridge/contracts';
import { BridgeController } from '../../src/application/bridge-controller.js';
import type { PreparedLocalSource } from '../../src/application/local-source-resolver.js';
import type { DatasetOwnerEndpoint } from '../../src/collection/dataset-owner-protocol.js';
import type { NeteasePort } from '../../src/netease/types.js';
import { authorizeSourceDirectory } from '../../src/recording/source-files.js';
import { LocalFileSourcePool, LocalSourcePrepareInterrupted, type AssetLease, type LocalLeaseAuthority } from '../../src/stream/local-file-source.js';
import { LocalSourceFence } from '../../src/stream/local-source-fence.js';
import { physicalResourceLocks } from '../../src/stream/physical-resource-locks.js';
import { StreamRegistry } from '../../src/stream/registry.js';
import { StreamGateway } from '../../src/stream/gateway.js';
import { failureForError } from '../../src/shared/ipc-failure.js';
import { adapterFixture, silentLogger } from '../mbrs006/adapter-fixture.js';
import { copyLocalPlaybackEvidence } from '../../../../apps/desktop/src/main/local-playback-evidence.js';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function turns(predicate: () => boolean, message: string): Promise<void> {
  for (let n = 0; n < 128 && !predicate(); n++) await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(predicate(), message);
}
function observe<T>(work: Promise<T>) {
  const result: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  void work.then(value => { result.value = value; result.settled = true; }, error => { result.error = error; result.settled = true; });
  return result;
}
interface PrepareControl {
  signal?: AbortSignal; deadlineAtMs?: number;
  onStage?(stage: string, phase: 'started' | 'succeeded' | 'failed', error?: unknown): void;
  onQuiet?(quiet: Promise<void>): void;
}
function register(registry: StreamRegistry, descriptor: PreparedLocalSource, authority: LocalLeaseAuthority, control: PrepareControl) {
  // RED 沿真实旧打开链运行；旧实现可忽略新增的私有控制参数。
  const method = registry.registerLocalSource as (source: PreparedLocalSource, owner: LocalLeaseAuthority, format?: string, control?: PrepareControl) => Promise<{ token: string; lease: AssetLease }>;
  return method.call(registry, descriptor, authority, 'wav', control);
}

/** 只挂起本测试文件的真实 open 返回或初次 FD stat；不打开用户媒体，不启动 HTTP。 */
async function fixture(t: TestContext, held: 'open' | 'verify' | 'none') {
  const temporary = process.env.TMPDIR;
  assert.ok(typeof temporary === 'string' && temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
  const directory = await promises.mkdtemp(path.join(temporary, 'mousa41-local-source-prepare-'));
  const absolute = path.join(directory, '仅自有测试字节.wav'), bytes = Buffer.from('只读准备生命周期合成字节');
  await promises.writeFile(absolute, bytes, { mode: 0o600, flag: 'wx' });
  const sourceRoot = { id: randomUUID(), ...await authorizeSourceDirectory(directory) }, rootId = randomUUID(), assetId = randomUUID(), trackId = randomUUID();
  const info = await promises.stat(absolute, { bigint: true });
  const descriptor: PreparedLocalSource = { source_kind: 'local_file', status: 'prepared_descriptor', request_id: randomUUID(), action: 'PLAY_NOW',
    target: { core_id: 'synthetic-core', zone_id: 'synthetic-zone' }, facts: {
      sourceRoot, relative: path.basename(absolute), root: { id: rootId, sourceRootId: sourceRoot.id, role: 'library', revision: '1' },
      asset: { id: assetId, libraryRootId: rootId, sourceRootId: sourceRoot.id, rootRevision: '1', fileRevision: '1', locationRevision: '1', sampleFrames: null, timebaseHz: null },
      track: { id: trackId, assetId, selectionRevision: '1', segment: null },
      observation: { signature: [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':'), assetId, trackId, libraryRootId: rootId,
        sourceRootId: sourceRoot.id, rootRevision: '1', fileRevision: '1', locationRevision: '1', selectionRevision: '1' },
    } };
  let clock = 0, owned: FileHandle | undefined, originalFd: number | undefined;
  const gate = deferred(), entered = deferred(), jobs: Promise<unknown>[] = [], leases: AssetLease[] = [];
  const beforeRelease: (() => Promise<unknown> | void)[] = [], close: (() => Promise<unknown>)[] = [];
  const timeouts = new Set<{ at: number; invoke(): void; unref(): unknown }>();
  const nativeTimeout = globalThis.setTimeout, nativeClearTimeout = globalThis.clearTimeout;
  const timeout = t.mock.method(globalThis, 'setTimeout', ((callback: (...args: unknown[]) => void, milliseconds = 0, ...args: unknown[]) => {
    if (milliseconds > 30_000) return nativeTimeout(callback, milliseconds, ...args);
    const token = { at: clock + milliseconds, invoke: () => callback(...args), unref() { return this; } };
    timeouts.add(token); return token;
  }) as unknown as typeof setTimeout);
  const clearTimeout = t.mock.method(globalThis, 'clearTimeout', ((token: unknown) => {
    if (!timeouts.delete(token as never)) nativeClearTimeout(token as ReturnType<typeof setTimeout>);
  }) as typeof globalThis.clearTimeout);
  const monotonic = t.mock.method(performance, 'now', () => clock);
  const originalOpen = promises.open;
  const opening = t.mock.method(promises, 'open', async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === absolute) {
      assert.equal(owned, undefined, '同一次准备只取得一个真实自有 FD。'); owned = handle; originalFd = handle.fd;
      if (held === 'open') { entered.resolve(); await gate.promise; }
      if (held === 'verify') {
        const originalStat = handle.stat.bind(handle); let reads = 0;
        t.mock.method(handle, 'stat', (async (...options: Parameters<typeof originalStat>) => {
          if (++reads === 2) { entered.resolve(); await gate.promise; }
          return originalStat(...options);
        }) as typeof handle.stat);
      }
    }
    return handle;
  });
  syncBuiltinESMExports();
  t.after(async () => {
    for (const operation of beforeRelease) await operation();
    gate.resolve(); await Promise.allSettled(jobs);
    for (const lease of leases) await lease.close();
    for (const operation of close) await operation();
    if (owned && owned.fd !== -1) await owned.close();
    opening.mock.restore(); syncBuiltinESMExports(); timeout.mock.restore(); clearTimeout.mock.restore(); monotonic.mock.restore();
    await promises.rm(directory, { recursive: true, force: true });
  });
  return { descriptor, entered: entered.promise, release: gate.resolve, jobs, leases, beforeRelease, close, now: () => clock,
    advance(milliseconds: number) { clock += milliseconds; for (const token of [...timeouts]) if (token.at <= clock) { timeouts.delete(token); token.invoke(); } },
    timers: () => timeouts.size, assertClosed() { assert.ok(originalFd !== undefined); assert.throws(() => fstatSync(originalFd!), { code: 'EBADF' }); },
    async assertBytesUnchanged() { assert.deepEqual(await promises.readFile(absolute), bytes); } };
}

test('准备期限结束前台等待，迟到 open 静止前保留容量与命名保护', async t => {
  const f = await fixture(t, 'open'), pool = new LocalFileSourcePool({ maxLeases: 1, now: f.now }), registry = new StreamRegistry({ localSourcePool: pool });
  const abort = new AbortController(); f.beforeRelease.push(() => abort.abort()); f.close.push(() => registry.closeLocal());
  let quiet: Promise<void> | undefined;
  const work = register(registry, f.descriptor, { ownerId: 'deadline-owner', attempt: 1, isCurrent: () => !abort.signal.aborted },
    { signal: abort.signal, deadlineAtMs: 30_000, onQuiet: value => { quiet = value; } });
  f.jobs.push(work); void work.then(value => f.leases.push(value.lease), () => {});
  const result = observe(work); await f.entered; f.advance(30_001);
  await turns(() => result.settled, '30 秒准备期限必须结束前台等待，不能等待原 open 返回。');
  assert.equal((result.error as { code?: string })?.code, 'READ_DEADLINE'); assert.ok(quiet);
  const quietResult = observe(quiet); assert.equal(quietResult.settled, false);
  assert.deepEqual(pool.resourceSnapshot(), { openLeases: 0, reservations: 1 });
  assert.ok(physicalResourceLocks.combinedSnapshot().resources > 0, '原命名位保护必须仍在。');
  await assert.rejects(pool.prepare(f.descriptor, { ownerId: 'other-owner', attempt: 1, isCurrent: () => true }), { code: 'CAPACITY' });
  const closing = registry.closeLocal(), closed = observe(closing); f.jobs.push(closing);
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(closed.settled, false);
  f.release(); await quiet; await closing;
  f.assertClosed(); assert.deepEqual(pool.resourceSnapshot(), { openLeases: 0, reservations: 0 });
  assert.equal(physicalResourceLocks.combinedSnapshot().resources, 0); assert.equal(f.timers(), 0); await f.assertBytesUnchanged();
});

test('准备期限固定使用单调时钟，租约注入日历时钟不导致立即超时', async t => {
  const f = await fixture(t, 'none');
  const pool = new LocalFileSourcePool({ now: () => Date.now() }), registry = new StreamRegistry({ localSourcePool: pool });
  f.close.push(() => registry.closeLocal());
  const work = register(registry, f.descriptor, { ownerId: 'calendar-lease-clock', attempt: 1, isCurrent: () => true },
    { deadlineAtMs: f.now() + 30_000 });
  f.jobs.push(work);
  const result = await work;
  f.leases.push(result.lease);
  assert.deepEqual(pool.resourceSnapshot(), { openLeases: 1, reservations: 1 });
  assert.equal(result.lease.state, 'PREPARED');
  await f.assertBytesUnchanged();
});

test('初次 FD 校验中取消立即结束前台，实际 close 前不返回 quiet', async t => {
  const f = await fixture(t, 'verify'), pool = new LocalFileSourcePool({ maxLeases: 1, now: f.now }), registry = new StreamRegistry({ localSourcePool: pool });
  const abort = new AbortController(); f.beforeRelease.push(() => abort.abort()); f.close.push(() => registry.closeLocal());
  let quiet: Promise<void> | undefined;
  const work = register(registry, f.descriptor, { ownerId: 'cancel-owner', attempt: 1, isCurrent: () => !abort.signal.aborted },
    { signal: abort.signal, deadlineAtMs: 30_000, onQuiet: value => { quiet = value; } });
  f.jobs.push(work); void work.then(value => f.leases.push(value.lease), () => {});
  const result = observe(work); await f.entered; abort.abort();
  await turns(() => result.settled, '取消必须结束前台等待，不能等待已挂起的 FD 校验。');
  assert.equal((result.error as { code?: string })?.code, 'READ_CANCELLED'); assert.ok(quiet);
  const quietResult = observe(quiet); assert.equal(quietResult.settled, false);
  assert.deepEqual(pool.resourceSnapshot(), { openLeases: 0, reservations: 1 });
  assert.ok(physicalResourceLocks.combinedSnapshot().resources >= 2, '命名位与真实 inode 保护仍须同时保留。');
  f.release(); await quiet;
  f.assertClosed(); assert.deepEqual(pool.resourceSnapshot(), { openLeases: 0, reservations: 0 });
  assert.equal(physicalResourceLocks.combinedSnapshot().resources, 0); assert.equal(f.timers(), 0); await f.assertBytesUnchanged();
});

test('Controller 准备超时或取消不会继续提交 SDK，原 ticket 随底层 quiet 收口', async t => {
  for (const reason of ['deadline', 'cancel'] as const) await t.test(reason === 'deadline' ? '准备超时' : '显式停止取消', async sub => {
    const f = await fixture(sub, 'open'), pool = new LocalFileSourcePool({ maxLeases: 1, now: f.now }), registry = new StreamRegistry({ localSourcePool: pool });
    const sdk = await adapterFixture(50_000), rows: Record<string, unknown>[] = [], fences = new Map<string, LocalSourceFence>();
    const datasetId = randomUUID(), epoch = randomUUID(); let alive = true;
    const localSources = { async prepare() { return { datasetId, epoch }; }, async commitBoot() {}, async close() {},
      async dispatch() { throw new Error('本例不读取额外领域或 Provider。'); }, isLocalSourceCurrent: () => alive,
      sealLocalSources() { alive = false; for (const fence of fences.values()) fence.revoke(); },
      async saveMBQueue(request: { queue: unknown }) { return structuredClone(request.queue); },
      async captureLocalSource() { const fence = LocalSourceFence.create(), ticketId = randomUUID(); fences.set(ticketId, fence);
        return { ticketId, epoch, datasetId, facts: structuredClone(f.descriptor.facts), buffer: fence.buffer, format: 'wav',
          metadata: { id: f.descriptor.facts.track.id, title: '合成曲', artists: ['合成作者'], album: '合成专辑' } }; },
      async releaseLocalSource(ticketId: string) { const fence = fences.get(ticketId); if (fence) { fence.revoke(); fence.assertQuiet(); fences.delete(ticketId); } },
      async revalidateLocalSource(ticketId: string) { return fences.get(ticketId)?.current === true; },
    } as unknown as DatasetOwnerEndpoint;
    const logger = { ...silentLogger, info(event: string, fields?: Record<string, unknown>) {
      if (event === 'local_play_request_guard_evidence') rows.push({ timestamp: new Date().toISOString(), level: 'info', event, ...fields });
    } };
    const gateway = new StreamGateway({ host: '127.0.0.1', port: 0, publicBaseUrl: 'http://127.0.0.1:38502', registry, logger });
    const netease = new Proxy({ configured: false }, { get(target, key) { if (key === 'configured') return target.configured; throw new Error('本例禁止 Provider 调用。'); } }) as unknown as NeteasePort;
    const controller = new BridgeController({ localSources, roon: sdk.adapter, registry, gateway, netease, logger, isLocalPlaybackAllowed: () => true });
    sdk.adapter.setStateHandler(() => controller.syncRoonTransportState());
    f.beforeRelease.push(() => controller.stop()); f.close.push(() => controller.shutdown(), () => sdk.adapter.shutdown(), () => gateway.stop());
    const request: LocalPlayRequest = { schema_version: '1.2', request_id: randomUUID(), route: 'roon_audio_input', source_kind: 'local_file', action: 'PLAY_NOW',
      local_track_id: f.descriptor.facts.track.id, asset_id: f.descriptor.facts.asset.id, expected_asset_revision: '1', target: { ...f.descriptor.target } };
    const work = controller.playLocal(request); f.jobs.push(work); const result = observe(work); await f.entered;
    if (reason === 'deadline') f.advance(30_001); else await controller.stop();
    await turns(() => result.settled, '前台点播必须结束，不能被未静止的源准备或 cleanup 再次卡住。');
    assert.ok(result.error); assert.equal((result.error as { code?: string }).code, reason === 'deadline' ? 'READ_DEADLINE' : 'READ_CANCELLED');
    assert.equal(controller.getPlaybackState().state, reason === 'deadline' ? 'error' : 'idle', '前台不得继续停在准备态。');
    assert.equal(failureForError('synthetic-command', result.error, 'localCatalog.prepare').error.code, reason === 'deadline' ? 'TIMEOUT' : 'CANCELLED');
    assert.equal(controller.getLocalPlayReceipt(request).status, 'rejected', '前台失败必须形成终态回执。');
    const receipt = controller.getLocalPlayReceipt(request);
    if (receipt.status === 'rejected') assert.equal(receipt.reason, reason === 'deadline' ? 'SOURCE_UNAVAILABLE' : 'REQUEST_REJECTED');
    if (reason === 'deadline') {
      assert.equal(controller.getPlaybackState().local?.error_code, 'READ_DEADLINE');
      assert.equal(controller.getPlaybackState().lastIssue?.message, '本地音乐文件准备超时，请检查来源是否可访问后重试。');
    }
    assert.equal(sdk.sessions.length, 0); assert.equal(sdk.sends.length, 0);
    assert.equal(fences.size, 1, '未静止准备仍占用其原 ticket。');
    assert.deepEqual(pool.resourceSnapshot(), { openLeases: 0, reservations: 1 });
    assert.ok(rows.some(row => row.operationStage === 'SOURCE_FD_OPEN' && row.phase === 'started'));
    assert.ok(rows.some(row => row.code === (reason === 'deadline' ? 'READ_DEADLINE' : 'READ_CANCELLED') && row.phase === 'failed'));
    const copied = rows.map(copyLocalPlaybackEvidence); assert.ok(copied.every(Boolean), '固定子阶段必须经过原私有 collector 闭集。');
    const encoded = JSON.stringify(copied);
    for (const forbidden of [f.descriptor.facts.sourceRoot.path, f.descriptor.facts.relative, request.request_id, f.descriptor.facts.observation!.signature]) {
      assert.equal(encoded.includes(forbidden), false, '阶段诊断不得包含路径、原请求身份或物理签名。');
    }
    f.release(); await turns(() => fences.size === 0, '原 I/O 静止后才释放 ticket。');
    assert.equal(sdk.sessions.length, 0); assert.equal(sdk.sends.length, 0); f.assertClosed();
  });
});

test('正常只读准备提供固定内部阶段，源身份核验与成功关闭保持完整', async t => {
  const f = await fixture(t, 'none'), pool = new LocalFileSourcePool({ now: f.now }), registry = new StreamRegistry({ localSourcePool: pool });
  f.close.push(() => registry.closeLocal());
  const events: { stage: string; phase: string }[] = [];
  const registration = await register(registry, f.descriptor, { ownerId: 'normal-owner', attempt: 1, isCurrent: () => true },
    { deadlineAtMs: 30_000, onStage: (stage, phase) => { events.push({ stage, phase }); } });
  f.leases.push(registration.lease);
  for (const stage of ['SOURCE_NAMESPACE_CAPTURE', 'SOURCE_NAMESPACE_ACQUIRE', 'SOURCE_NAMED_CHECK', 'SOURCE_FD_OPEN', 'SOURCE_FD_STAT', 'SOURCE_FD_VERIFY']) {
    assert.deepEqual(events.filter(row => row.stage === stage).map(row => row.phase), ['started', 'succeeded'], stage);
  }
  assert.ok(registry.getLocal(registration.token)); assert.equal(f.timers(), 0); await f.assertBytesUnchanged();
  await registry.revokeLocal(registration.token); f.assertClosed(); assert.equal(physicalResourceLocks.combinedSnapshot().resources, 0);
});

test('两通道均忙时旧关闭失败不能毒化新点播，健康通道静止后按原身份进入真实准备与受控 SDK', async t => {
  const f = await fixture(t, 'none'), pool = new LocalFileSourcePool({ maxLeases: 2, now: f.now }), registry = new StreamRegistry({ localSourcePool: pool });
  const healthyQuiet = deferred(), oldCloseError = new Error('受控旧通道关闭未核实');
  const failedQuiet = Promise.reject(oldCloseError); void failedQuiet.catch(() => undefined);
  const sdk = await adapterFixture(50_000), fences = new Map<string, LocalSourceFence>(), captured: string[] = [];
  const datasetId = randomUUID(), epoch = randomUUID(); let alive = true, waitingForLane = false;
  const localSources = { async prepare() { return { datasetId, epoch }; }, async commitBoot() {}, async close() {},
    async dispatch() { throw new Error('本例禁止额外领域或 Provider 调用。'); }, isLocalSourceCurrent: () => alive,
    sealLocalSources() { alive = false; for (const fence of fences.values()) fence.revoke(); },
    async saveMBQueue(request: { queue: unknown }) { return structuredClone(request.queue); },
    async captureLocalSource() { const fence = LocalSourceFence.create(), ticketId = randomUUID(); fences.set(ticketId, fence); captured.push(ticketId);
      return { ticketId, epoch, datasetId, facts: structuredClone(f.descriptor.facts), buffer: fence.buffer, format: 'wav',
        metadata: { id: f.descriptor.facts.track.id, title: '合成曲', artists: ['合成作者'], album: '合成专辑' } }; },
    async releaseLocalSource(ticketId: string) { const fence = fences.get(ticketId); if (fence) { fence.revoke(); fence.assertQuiet(); fences.delete(ticketId); } },
    async revalidateLocalSource(ticketId: string) { return fences.get(ticketId)?.current === true; },
  } as unknown as DatasetOwnerEndpoint;
  const logger = { ...silentLogger, info(event: string, fields?: Record<string, unknown>) {
    if (event === 'local_play_request_guard_evidence' && fields?.operationStage === 'SECOND_FACTS' && fields.phase === 'started' && captured.length === 5) waitingForLane = true;
  } };
  const gateway = new StreamGateway({ host: '127.0.0.1', port: 0, publicBaseUrl: 'http://127.0.0.1:38502', registry, logger });
  await gateway.start();
  const netease = new Proxy({ configured: false }, { get(target, key) { if (key === 'configured') return target.configured; throw new Error('本例禁止 Provider 调用。'); } }) as unknown as NeteasePort;
  const controller = new BridgeController({ localSources, roon: sdk.adapter, registry, gateway, netease, logger, isLocalPlaybackAllowed: () => true });
  sdk.adapter.setStateHandler(() => controller.syncRoonTransportState());
  f.beforeRelease.push(() => { healthyQuiet.resolve(); return controller.stop(); });
  f.close.push(async () => { await controller.shutdown();
    // 前两次仅注入端口失败，没有真实 FD 或 claim；测试退出时收回自有合成 ticket。
    for (const fence of fences.values()) { fence.revoke(); fence.assertQuiet(); } fences.clear();
  }, () => sdk.adapter.shutdown(), () => gateway.stop());
  const originalRegister = registry.registerLocalSource.bind(registry), lanes: { ownerId: string; attempt: number }[] = [];
  t.mock.method(registry, 'registerLocalSource', async (...args: Parameters<typeof originalRegister>) => {
    lanes.push({ ownerId: args[1].ownerId, attempt: args[1].attempt });
    if (lanes.length <= 2) {
      // 只注入资源收尾状态；第三次沿真实 Pool、命名保护、FD 和 Registry 完整准备。
      const quiet = lanes.length === 1 ? failedQuiet : healthyQuiet.promise;
      args[3]?.onQuiet?.(quiet); throw new LocalSourcePrepareInterrupted('READ_DEADLINE', quiet);
    }
    const registration = await originalRegister(...args); f.leases.push(registration.lease); return registration;
  });
  const request = (): LocalPlayRequest => ({ schema_version: '1.2', request_id: randomUUID(), route: 'roon_audio_input', source_kind: 'local_file', action: 'PLAY_NOW',
    local_track_id: f.descriptor.facts.track.id, asset_id: f.descriptor.facts.asset.id, expected_asset_revision: '1', target: { ...f.descriptor.target } });
  for (let n = 0; n < 2; n++) {
    const work = controller.playLocal(request()); f.jobs.push(work); await assert.rejects(work, { code: 'READ_DEADLINE' });
  }
  assert.equal(captured.length, 4); assert.equal(fences.size, 2); assert.notEqual(lanes[0]!.ownerId, lanes[1]!.ownerId);
  const next = request(), work = controller.playLocal(next), result = observe(work); f.jobs.push(work);
  await turns(() => waitingForLane, '新点播已完成原捕获与队列持久化，正在等待原通道收尾。');
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(result.settled, false, '旧通道关闭失败不能让新点播提前继承旧错误；仍须等待健康通道。');
  assert.equal(lanes.length, 2); assert.equal(sdk.sessions.length, 0); assert.equal(sdk.sends.length, 0);
  assert.ok(fences.has(captured[1]!)); assert.ok(fences.has(captured[3]!), '健康通道 quiet 前仍持有原 ticket。');
  healthyQuiet.resolve();
  await turns(() => sdk.sessions.length === 1, '健康通道实际静止后，新点播可完成真实只读准备并开始唯一受控会话。');
  assert.equal(lanes[2]!.ownerId, lanes[1]!.ownerId, '复用已静止的健康通道，失败通道继续占用。');
  assert.ok(lanes[2]!.attempt > lanes[1]!.attempt); assert.ok(fences.has(captured[1]!)); assert.equal(fences.has(captured[3]!), false);
  sdk.sessions[0]!('SessionBegan', { session_id: 'healthy-lane-session' });
  assert.deepEqual(await work, { status: 'accepted', request_id: next.request_id, action: next.action });
  assert.equal(controller.getPlaybackState().local?.phase, 'PLAYING'); assert.equal(sdk.sends.length, 1);
  await controller.stop(); await turns(() => pool.resourceSnapshot().reservations === 0, '真实新 FD 已关闭，原失败合成通道仍不被当作释放。');
  f.assertClosed(); assert.equal(fences.size, 1); assert.ok(fences.has(captured[1]!)); await f.assertBytesUnchanged();
});
