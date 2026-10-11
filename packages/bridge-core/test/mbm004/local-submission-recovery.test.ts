import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import {
  assertDiagnosticExportSafe,
  isLocalPlayReceipt,
  isRoonDiagnosticStage,
  validateIpcEvent,
  validateIpcResponseForCommand,
  type DiagnosticComponentSnapshot,
  type DiagnosticPlatformInfo,
  type DiagnosticReport,
  type LocalPlayRequest,
  type LocalRoonStartupDiagnostic,
  type PublicBridgeState,
  type TypedIpcEvent,
} from '@music-bridge/contracts';
import { BridgeController } from '../../src/application/bridge-controller.js';
import { LocalSourcePreparationError } from '../../src/application/local-source-resolver.js';
import type { DatasetOwnerEndpoint } from '../../src/collection/dataset-owner-protocol.js';
import { createLocalFavoriteRepository } from '../../src/favorites/repository.js';
import type { NeteasePort } from '../../src/netease/types.js';
import type {
  RoonApiOptions,
  RoonAudioInputPlayOptions,
  RoonCore,
  RoonSdk,
  RoonZoneChangeCallback,
} from '../../src/roon/sdk.js';
import { createBridgeRuntime } from '../../src/runtime.js';
import { StreamGateway } from '../../src/stream/gateway.js';
import { LocalFileSourcePool } from '../../src/stream/local-file-source.js';
import { StreamRegistry } from '../../src/stream/registry.js';
import { eventually } from '../mbrs005/fixture.js';
import { adapterFixture, syntheticPlayRequest, silentLogger, tick } from '../mbrs006/adapter-fixture.js';
import { catalogFixture } from '../mbrs006/catalog-fixture.js';

// 只使用本用例拥有的目录、SQL、SourceTicket、固定 FD 与 loopback HTTP。
// SDK 回调完全受控；这些检查不提供真实 Roon、设备或听感证据。
async function ownerFixture(t: test.TestContext) {
  const catalog = await catalogFixture(t);
  let current = true;
  let captures = 0;
  let queueWrites = 0;
  let captureGate: Promise<void> | undefined;
  const owner: DatasetOwnerEndpoint = {
    prepare: async () => ({ epoch: catalog.epoch, datasetId: catalog.datasetId }),
    dispatch: async () => assert.fail('本地回执与启动检查不得调用数据集普通命令。'),
    commitBoot: async () => {},
    close: async () => {},
    isLocalSourceCurrent: () => current,
    sealLocalSources() { current = false; catalog.tickets.seal(); },
    loadMBQueue: async () => catalog.repository.mbQueue.load(catalog.datasetId),
    saveMBQueue: async request => {
      queueWrites++;
      return catalog.repository.mbQueue.save(request);
    },
    captureLocalSource: async request => {
      captures++;
      if (captureGate) await captureGate;
      return catalog.tickets.capture(request);
    },
    revalidateLocalSource: async ticket => catalog.tickets.revalidate(ticket),
    releaseLocalSource: async ticket => catalog.tickets.release(ticket),
  };
  return {
    ...catalog,
    owner,
    captures: () => captures,
    queueWrites: () => queueWrites,
    setCaptureGate(value?: Promise<void>) { captureGate = value; },
    request(index = 0, action: LocalPlayRequest['action'] = 'PLAY_NOW'): LocalPlayRequest {
      return { ...catalog.requests[index]!, request_id: randomUUID(), action };
    },
  };
}

async function controllerFixture(t: test.TestContext, timeout = 500) {
  const f = await ownerFixture(t);
  const pool = new LocalFileSourcePool();
  const registry = new StreamRegistry({ localSourcePool: pool });
  const gateway = new StreamGateway({
    host: '127.0.0.1', port: 0, publicBaseUrl: 'http://127.0.0.1:0',
    registry, logger: silentLogger,
  });
  await gateway.start();
  const sdk = await adapterFixture(timeout, Number(new URL(gateway.iconUrl()).port));
  const diagnostics: LocalRoonStartupDiagnostic[] = [];
  const controller = new BridgeController({
    roon: sdk.adapter, registry, gateway, logger: silentLogger, localSources: f.owner,
    localPlaybackDiagnostics: () => event => diagnostics.push(structuredClone(event)),
    netease: new Proxy({ configured: true }, {
      get(_target, key) {
        if (key === 'configured') return true;
        return () => { throw new Error('本地用例禁止调用云来源或隐式回退。'); };
      },
    }) as NeteasePort,
  });
  t.after(async () => {
    await controller.shutdown();
    await sdk.adapter.shutdown();
    await gateway.stop();
  });
  const sideEffects = () => ({
    captures: f.captures(), queueWrites: f.queueWrites(),
    begins: sdk.sessions.length, plays: sdk.sends.length,
    controls: sdk.controls(), ends: sdk.ends(), tickets: f.tickets.size,
    resources: pool.resourceSnapshot(),
  });
  return { ...f, ...sdk, controller, pool, registry, gateway, diagnostics, sideEffects };
}

function holdPlaying(f: Awaited<ReturnType<typeof controllerFixture>>, t: test.TestContext): void {
  t.mock.method(f.core.services.RoonApiAudioInput, 'play', (
    options: RoonAudioInputPlayOptions,
    callback: (message: unknown, body: unknown) => void,
  ) => { f.sends.push(options); f.plays.push(callback); });
}

function assertClosedDiagnostics(events: readonly LocalRoonStartupDiagnostic[]): void {
  assert.ok(events.every(event => isRoonDiagnosticStage(event.stage)));
  assertDiagnosticExportSafe(JSON.stringify(events));
  assert.doesNotMatch(JSON.stringify(events), /session_id|track_id|media_url|responseBody|stackTrace|privatePath/u);
}

for (const event of ['MediaError', 'SessionEnded', 'ZoneNotFound', 'EndedNaturally', 'StoppedUser'] as const) {
  test(`MBF001-B 当前 ${event} 启动失败的诊断不能因清理会话而误标旧回调`, async t => {
    const sdk = await adapterFixture(500), diagnostics: LocalRoonStartupDiagnostic[] = [];
    t.after(() => sdk.adapter.shutdown());
    t.mock.method(sdk.core.services.RoonApiAudioInput, 'play', (
      options: RoonAudioInputPlayOptions, callback: (message: unknown, body: unknown) => void,
    ) => { sdk.sends.push(options); sdk.plays.push(callback); });
    const work = sdk.adapter.play({ ...syntheticPlayRequest, onLocalSession() {},
      onLocalDiagnostic: diagnostic => diagnostics.push(structuredClone(diagnostic)) });
    void work.catch(() => undefined);
    await eventually(() => sdk.sessions.length === 1, '当前受控 SDK 启动原会话');
    sdk.sessions[0]!('SessionBegan', { session_id: 'synthetic-current-failure-session' });
    await eventually(() => sdk.plays.length === 1, '当前受控 SDK 等待 Playing');
    if (event === 'SessionEnded') sdk.sessions[0]!(event, {});
    else sdk.plays[0]!(event, {});
    await assert.rejects(work);
    const cause = diagnostics.findLast(diagnostic => diagnostic.stage.eventName === event);
    const failure = diagnostics.findLast(diagnostic => diagnostic.event === 'roon_startup_failed');
    assert.equal(cause?.stage.staleCallback, false);
    assert.equal(failure?.stage.staleCallback, false);
    assert.equal(failure?.stage.phase, 'awaiting_playing');
    assertClosedDiagnostics(diagnostics);
  });
}

test('MBF001-B 未提交请求只返回 missing：零来源捕获、FD、SDK 和 SQL 队列写入', async t => {
  const f = await controllerFixture(t);
  const before = f.sideEffects();
  for (const action of ['PLAY_NOW', 'APPEND_MB_QUEUE', 'PLAY_NEXT_MB_QUEUE'] as const) {
    const request = f.request(0, action);
    for (let index = 0; index < 4; index++) {
      const receipt = f.controller.getLocalPlayReceipt(request);
      assert.deepEqual(receipt, { status: 'missing', request_id: request.request_id, action });
      assert.equal(isLocalPlayReceipt(receipt), true);
    }
  }
  assert.deepEqual(f.sideEffects(), before);
  assert.equal(f.controller.getPlaybackState().queue.items.length, 0);
  assert.equal(f.repository.mbQueue.load(f.datasetId), null);
  assert.equal(f.diagnostics.length, 0);
});

test('MBF001-B 原提交 pending 只读查询；同 request_id 的错误 body 拒绝且没有副作用', async t => {
  const f = await controllerFixture(t);
  let release!: () => void;
  f.setCaptureGate(new Promise<void>(resolve => { release = resolve; }));
  const request = f.request();
  const work = f.controller.playLocal(request);
  void work.catch(() => undefined);
  try {
    await eventually(() => f.captures() === 1, '原请求进入受控 Owner 捕获等待');
    const before = f.sideEffects();
    const queueBefore = structuredClone(f.controller.getPlaybackState().queue);
    const pending = { status: 'pending', request_id: request.request_id, action: request.action };
    assert.deepEqual(f.controller.getLocalPlayReceipt(structuredClone(request)), pending);
    const detached = f.controller.getLocalPlayReceipt(request);
    detached.action = 'APPEND_MB_QUEUE';
    assert.deepEqual(f.controller.getLocalPlayReceipt(request), pending);
    for (const changed of [
      { ...request, action: 'APPEND_MB_QUEUE' as const },
      { ...request, expected_asset_revision: '999' },
      { ...request, local_track_id: f.requests[1]!.local_track_id },
      { ...request, target: { ...request.target, zone_id: 'another-synthetic-zone' } },
      { ...request, asset_id: f.requests[1]!.asset_id },
    ]) assert.throws(() => f.controller.getLocalPlayReceipt(changed));
    assert.throws(() => f.controller.getLocalPlayReceipt({ ...request, privatePath: f.media } as LocalPlayRequest));
    assert.deepEqual(f.sideEffects(), before);
    assert.deepEqual(f.controller.getPlaybackState().queue, queueBefore);

    release(); f.setCaptureGate();
    await eventually(() => f.sessions.length === 1, '原提交释放后仅派发一次 begin');
    f.sessions[0]!('SessionBegan', { session_id: 'pending-original-session' });
    const accepted = await work;
    const settled = { status: 'received', request_id: request.request_id, action: request.action, result: accepted };
    assert.deepEqual(f.controller.getLocalPlayReceipt(request), settled);
    const received = f.controller.getLocalPlayReceipt(request);
    assert.equal(received.status, 'received');
    if (received.status === 'received' && received.result.status === 'accepted') received.result.request_id = '改动副本';
    assert.deepEqual(f.controller.getLocalPlayReceipt(request), settled);
    assert.equal(f.sessions.length, 1);
    assert.equal(f.queueWrites(), 1);
  } finally {
    release(); f.setCaptureGate();
    await work.catch(() => undefined);
  }
});

test('MBF001-B 已受理 UNKNOWN 的回执查询不重发；晚 Session 仅调和原 attempt，旧回调不覆盖 B', async t => {
  const f = await controllerFixture(t, 20);
  const request = f.request();
  const accepted = await f.controller.playLocal(request);
  const unknown = f.controller.getPlaybackState();
  assert.equal(unknown.local?.phase, 'SUBMISSION_UNKNOWN');
  assert.equal(unknown.local?.delivery_state, 'UNKNOWN');
  const attempt = unknown.local!.attempt_id;
  const receipt = { status: 'received', request_id: request.request_id, action: request.action, result: accepted };
  const before = f.sideEffects();
  for (let index = 0; index < 16; index++) assert.deepEqual(f.controller.getLocalPlayReceipt(request), receipt);
  assert.deepEqual(f.sideEffects(), before);
  assert.equal(f.controller.getPlaybackState().queue.items.length, 1);
  const timeout = f.diagnostics.find(event => event.event === 'roon_session_timeout');
  assert.equal(timeout?.stage.phase, 'awaiting_session');
  assert.ok(timeout!.stage.elapsedMs >= 10);
  assert.equal(timeout?.stage.staleCallback, false);

  f.sessions[0]!('SessionBegan', { session_id: 'late-original-session' });
  await tick();
  assert.equal(f.controller.getPlaybackState().local?.attempt_id, attempt);
  assert.equal(f.controller.getPlaybackState().local?.phase, 'PLAYING');
  assert.equal(f.sessions.length, 1);
  assert.equal(f.sends.length, 1);
  f.sessions[0]!('SessionBegan', { session_id: 'duplicate-original-session' });
  assert.equal(f.sends.length, 1);

  const second = f.request(1);
  const secondWork = f.controller.playLocal(second);
  await eventually(() => f.sessions.length === 2, 'B 的独立原提交发起唯一新会话');
  f.sessions[1]!('SessionBegan', { session_id: 'current-B-session' });
  await secondWork;
  const current = f.controller.getPlaybackState();
  assert.notEqual(current.local?.attempt_id, attempt);
  f.sessions[0]!('SessionEnded', {});
  f.plays[0]!('Playing', { privatePath: f.media });
  await tick();
  assert.equal(f.controller.getPlaybackState().local?.attempt_id, current.local?.attempt_id);
  assert.equal(f.controller.getPlaybackState().currentTrack?.id, second.local_track_id);
  assert.equal(f.controller.getPlaybackState().local?.phase, 'PLAYING');
  const afterOldCallbacks = f.sideEffects();
  assert.deepEqual(f.controller.getLocalPlayReceipt(request), receipt);
  assert.deepEqual(f.sideEffects(), afterOldCallbacks);
  assert.ok(f.diagnostics.some(event => event.stage.staleCallback));
  assertClosedDiagnostics(f.diagnostics);
});

test('MBF001-B SDK 明确拒绝保存 MEDIA_ERROR 回执，原始路径、URL 和错误栈没有进入公开结果', async t => {
  const f = await controllerFixture(t);
  const request = f.request();
  const work = f.controller.playLocal(request);
  void work.catch(() => undefined);
  await eventually(() => f.sessions.length === 1, '原本地会话已派发');
  f.sessions[0]!('InvalidRequest', {
    error_message: 'invalid icon /Users/synthetic/private.wav https://synthetic.invalid/media?token=hidden',
    privatePath: f.media, session_id: 'private-rejected-session',
    stackTrace: 'synthetic stack at private-owner',
  });
  await assert.rejects(work, { code: 'ROON_MEDIA_ERROR' });
  const expected = { status: 'rejected', request_id: request.request_id, action: request.action, reason: 'MEDIA_ERROR' };
  assert.deepEqual(f.controller.getLocalPlayReceipt(request), expected);
  assert.equal(isLocalPlayReceipt(expected), true);
  assert.equal(f.controller.getPlaybackState().local?.phase, 'FAILED');
  await eventually(() => f.pool.resourceSnapshot().openLeases === 0, '失败后固定 FD 已关闭');
  const before = f.sideEffects();
  for (let index = 0; index < 4; index++) assert.deepEqual(f.controller.getLocalPlayReceipt(request), expected);
  assert.deepEqual(f.sideEffects(), before);
  assert.equal(f.sessions.length, 1);
  assert.equal(f.sends.length, 0);
  assert.equal(f.controls(), 0);
  assert.equal(f.diagnostics.find(event => event.stage.eventName === 'InvalidRequest')?.stage.errorClass, 'invalid_icon');
  assert.ok(f.diagnostics.some(event => event.event === 'roon_startup_failed'));
  assertClosedDiagnostics(f.diagnostics);
  const serialized = JSON.stringify(f.controller.getLocalPlayReceipt(request));
  assert.doesNotMatch(serialized, /https?:\/\/|\/Users\/|stack|private|session_id/u);
  assert.ok(!serialized.includes(f.media));
});

for (const kind of ['source', 'internal'] as const) {
  test(`MBF001-B ${kind} 捕获失败保存闭集回执，查询不重新捕获且不暴露 Error 内容`, async t => {
    const f = await controllerFixture(t);
    const failure = kind === 'source' ? new LocalSourcePreparationError('FACTS_CHANGED') : new Error('合成内部失败');
    failure.message = `/Users/synthetic/private.wav https://synthetic.invalid/audio?token=hidden ${f.media}`;
    failure.stack = 'synthetic private stack';
    t.mock.method(f.tickets, 'capture', () => { throw failure; });
    const request = f.request();
    await assert.rejects(f.controller.playLocal(request));
    const expected = {
      status: 'rejected', request_id: request.request_id, action: request.action,
      reason: kind === 'source' ? 'SOURCE_UNAVAILABLE' : 'INTERNAL_ERROR',
    };
    const before = f.sideEffects();
    assert.deepEqual(f.controller.getLocalPlayReceipt(request), expected);
    assert.deepEqual(f.controller.getLocalPlayReceipt(request), expected);
    assert.deepEqual(f.sideEffects(), before);
    assert.equal(f.captures(), 1);
    assert.equal(f.queueWrites(), 0);
    assert.equal(f.sessions.length, 0);
    assert.deepEqual(f.pool.resourceSnapshot(), { openLeases: 0, reservations: 0 });
    assert.equal(isLocalPlayReceipt(expected), true);
    assert.doesNotMatch(JSON.stringify(expected), /https?:\/\/|\/Users\/|stack|private/u);
  });
}

test('MBF001-B 256 个原回执保留；第 257 个新提交拒绝，读取 missing 不挤掉既有身份', async t => {
  const f = await controllerFixture(t);
  t.mock.method(f.tickets, 'capture', () => { throw new LocalSourcePreparationError('FACTS_CHANGED'); });
  const requests = Array.from({ length: 256 }, () => f.request());
  for (const request of requests) await assert.rejects(f.controller.playLocal(request));
  const first = f.controller.getLocalPlayReceipt(requests[0]!);
  const last = f.controller.getLocalPlayReceipt(requests[255]!);
  assert.equal(first.status, 'rejected');
  assert.equal(last.status, 'rejected');
  const extra = f.request();
  await assert.rejects(f.controller.playLocal(extra), { code: 'BAD_REQUEST', httpStatus: 429 });
  const before = f.sideEffects();
  assert.deepEqual(f.controller.getLocalPlayReceipt(extra), { status: 'missing', request_id: extra.request_id, action: extra.action });
  assert.deepEqual(f.controller.getLocalPlayReceipt(requests[0]!), first);
  assert.deepEqual(f.controller.getLocalPlayReceipt(requests[255]!), last);
  await assert.rejects(f.controller.playLocal(requests[0]!));
  assert.deepEqual(f.sideEffects(), before);
  assert.equal(f.captures(), 256);
  assert.equal(f.queueWrites(), 0);
  assert.equal(f.controller.getPlaybackState().queue.items.length, 0);
});

test('MBF001-B 实际本地 SDK 阶段携带当前 phase、elapsed 和真实 HTTP gateway 状态，Time 不占诊断', async t => {
  const f = await controllerFixture(t);
  holdPlaying(f, t);
  const request = f.request();
  const work = f.controller.playLocal(request);
  void work.catch(() => undefined);
  await eventually(() => f.sessions.length === 1, '生产 Adapter 已 begin_session');
  const begin = f.diagnostics.find(event => event.event === 'roon_begin_session_requested');
  assert.equal(begin?.stage.phase, 'awaiting_session');
  assert.equal(begin?.stage.gatewayStage, 'none');
  f.sessions[0]!('SessionBegan', { session_id: 'owned-byte-session' });
  await eventually(() => f.sends.length === 1, '生产 Adapter 已提交本地播放 URL');
  assert.equal(f.controller.getPlaybackState().local?.phase, 'AWAITING_ROON');
  const response = await fetch(f.sends[0]!.media_url);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes);
  await eventually(() => f.gateway.getActiveMediaReadCount() === 0, '真实 HTTP 字节读已结束');
  assert.equal(f.controller.getPlaybackState().local?.phase, 'AWAITING_ROON');
  assert.equal(f.controller.getLocalPlayReceipt(request).status, 'pending');
  assert.equal(f.queueWrites(), 1);
  f.plays[0]!('Playing', { privatePath: f.media, session_id: 'owned-byte-session' });
  await work;
  const stages = f.diagnostics.filter(event => event.event === 'roon_play_event');
  assert.equal(stages.at(-1)?.stage.phase, 'awaiting_playing');
  assert.equal(stages.at(-1)?.stage.eventName, 'Playing');
  assert.equal(stages.at(-1)?.stage.gatewayStage, 'completed');
  assert.equal(stages.at(-1)?.stage.staleCallback, false);
  assert.ok(stages.at(-1)!.stage.elapsedMs >= begin!.stage.elapsedMs);
  assert.equal(f.diagnostics.find(event => event.event === 'roon_session_event')?.stage.phase, 'awaiting_session');
  assert.equal(f.diagnostics.find(event => event.event === 'roon_session_began')?.stage.phase, 'awaiting_playing');
  assert.equal(f.diagnostics.find(event => event.event === 'roon_play_requested')?.stage.phase, 'awaiting_playing');
  const count = f.diagnostics.length;
  for (let index = 0; index < 32; index++) f.plays[0]!('Time', { seek_position_ms: index, privatePath: f.media });
  assert.equal(f.diagnostics.length, count);
  f.plays[0]!('synthetic-private-event', { privatePath: f.media });
  assert.equal(f.diagnostics.at(-1)?.stage.eventName, 'Unknown');
  assert.equal(f.controller.getPlaybackState().local?.phase, 'PLAYING');
  assert.equal(f.sessions.length, 1);
  assert.equal(f.sends.length, 1);
  assertClosedDiagnostics(f.diagnostics);
});

test('MBF001-B 等 Playing 超时保留原受理结果，诊断明确 awaiting_playing 而非会话阶段', async t => {
  const f = await controllerFixture(t, 20);
  holdPlaying(f, t);
  const request = f.request();
  const work = f.controller.playLocal(request);
  await eventually(() => f.sessions.length === 1, '原请求开始会话');
  f.sessions[0]!('SessionBegan', { session_id: 'awaiting-playing-session' });
  const accepted = await work;
  assert.equal(f.controller.getPlaybackState().local?.phase, 'SUBMISSION_UNKNOWN');
  assert.deepEqual(f.controller.getLocalPlayReceipt(request), {
    status: 'received', request_id: request.request_id, action: request.action, result: accepted,
  });
  const timeout = f.diagnostics.find(event => event.event === 'roon_session_timeout');
  assert.equal(timeout?.stage.phase, 'awaiting_playing');
  assert.equal(timeout?.stage.gatewayStage, 'none');
  assert.equal(timeout?.stage.staleCallback, false);
  assert.ok(timeout!.stage.elapsedMs >= 10);
  assert.equal(f.diagnostics.find(event => event.event === 'roon_startup_failed')?.stage.phase, 'awaiting_playing');
  const before = f.sideEffects();
  f.controller.getLocalPlayReceipt(request);
  assert.deepEqual(f.sideEffects(), before);
  assertClosedDiagnostics(f.diagnostics);
});

function runtimeSdkFixture() {
  let apiOptions!: RoonApiOptions;
  let zones!: RoonZoneChangeCallback;
  const sessions: Array<(message: unknown, body: unknown) => void> = [];
  const plays: Array<(message: unknown, body: unknown) => void> = [];
  const sends: RoonAudioInputPlayOptions[] = [];
  const core: RoonCore = {
    core_id: 'synthetic-core', display_name: '受控运行时 Core',
    services: {
      RoonApiAudioInput: {
        begin_session(_options, callback) {
          sessions.push(callback);
          return { end_session(done) { done('SessionEnded', {}); } };
        },
        update_transport_controls(_options, callback) { callback('Success', {}); },
        play(options, callback) { sends.push(options); plays.push(callback); },
      },
      RoonApiTransport: {
        subscribe_zones(callback) { zones = callback; },
        control(_zone, _control, callback) { callback(false); },
        seek(_zone, _how, _seconds, callback) { callback(false); },
      },
    },
  };
  const sdk = {
    audioInputService: class {}, transportService: class {},
    createApi(options: RoonApiOptions) {
      apiOptions = options;
      return { load_config() {}, save_config() {}, init_services() {}, start_discovery() {}, stop_discovery() {}, disconnect_all() {} };
    },
    createSettings() { return {}; },
    createStatus() { return { set_status() {} }; },
  } as unknown as RoonSdk;
  return {
    sdk, sessions, plays, sends,
    pair() {
      apiOptions.core_paired(core);
      zones('Subscribed', { zones: [{
        zone_id: 'synthetic-zone', display_name: '受控运行时 Zone',
        outputs: [{ output_id: 'synthetic-output' }], state: 'stopped',
        is_pause_allowed: true, is_play_allowed: true, is_seek_allowed: true,
      }] });
    },
  };
}

async function unusedPortPair(): Promise<[number, number]> {
  const servers = [createServer(), createServer()] as const;
  try {
    await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    })));
    const ports = servers.map(server => {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      return address.port;
    });
    return [ports[0]!, ports[1]!];
  } finally {
    await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    })));
  }
}

interface MainDiagnosticsModule {
  MainDiagnosticRecorder: new () => {
    recordCoreEvent(event: TypedIpcEvent): void;
    snapshot(health?: PublicBridgeState): DiagnosticComponentSnapshot;
  };
  writeDiagnosticReport(outputPath: string, input: {
    platform: DiagnosticPlatformInfo;
    main: DiagnosticComponentSnapshot;
    core: DiagnosticComponentSnapshot;
  }): Promise<void>;
}

test('MBF001-B 真实 Runtime→受控 SDK→Main 文件导出保留阶段；独立 50 环与通用 150 合并有界', async t => {
  const f = await ownerFixture(t);
  const sdk = runtimeSdkFixture();
  const [controlPort, streamPort] = await unusedPortPair();
  // 动态源模块避免把 Desktop 源码加入 Bridge Core 的 TypeScript rootDir。
  const mainModule = await import(new URL('../../../../apps/desktop/src/main/diagnostics.ts', import.meta.url).href) as MainDiagnosticsModule;
  const main = new mainModule.MainDiagnosticRecorder();
  const events: TypedIpcEvent[] = [];
  const runtime = createBridgeRuntime({
    env: {
      BRIDGE_CONTROL_HOST: '127.0.0.1', BRIDGE_CONTROL_PORT: String(controlPort),
      BRIDGE_STREAM_HOST: '127.0.0.1', BRIDGE_STREAM_PORT: String(streamPort),
    },
    datasetOwnerEndpoint: f.owner, roonSdk: sdk.sdk, logger: silentLogger,
    favoriteRepository: createLocalFavoriteRepository(), playbackEventProtocol: 'compact-v1',
    onEvent(event) { events.push(event); main.recordCoreEvent(event); },
  });
  t.after(() => runtime.shutdown());
  await runtime.start();
  sdk.pair();
  await runtime.selectZone('synthetic-zone');
  const first = f.request();
  const firstWork = runtime.playbackPlayLocal!(first);
  await eventually(() => sdk.sessions.length === 1, '运行时原本地提交已 begin');
  sdk.sessions[0]!('SessionBegan', { session_id: 'runtime-first-session' });
  await eventually(() => sdk.sends.length === 1, '运行时已派发真实本地 HTTP 地址');
  const firstResponse = await fetch(sdk.sends[0]!.media_url);
  const firstBody = await firstResponse.arrayBuffer();
  assert.deepEqual(Buffer.from(firstBody), f.bytes);
  sdk.plays[0]!('Playing', {});
  await firstWork;
  const firstId = runtime.getDiagnostics().timeline.find(event => event.roonStage)?.diagnosticId;
  assert.ok(firstId);
  assert.equal(runtime.getLocalPlayReceipt!(first).status, 'received');

  const second = f.request(1);
  const secondWork = runtime.playbackPlayLocal!(second);
  await eventually(() => sdk.sessions.length === 2, '第二原提交获得独立阶段身份');
  sdk.sessions[1]!('SessionBegan', { session_id: 'runtime-second-session' });
  await eventually(() => sdk.plays.length === 2, '第二原提交进入 Playing 等待');
  sdk.plays[1]!('Playing', {});
  await secondWork;
  const secondId = runtime.getDiagnostics().timeline.filter(event => event.roonStage).at(-1)?.diagnosticId;
  assert.ok(secondId);
  assert.notEqual(secondId, firstId);

  for (let index = 0; index < 60; index++) sdk.plays[1]!(index % 2 === 0 ? 'Paused' : 'Playing', {});
  sdk.plays[0]!('Playing', { privatePath: f.media, stackTrace: 'synthetic old callback stack' });
  const beforeGeneralFlood = runtime.getDiagnostics().timeline.filter(event => event.roonStage);
  assert.equal(beforeGeneralFlood.length, 50);
  assert.equal(beforeGeneralFlood.at(-1)?.diagnosticId, firstId);
  assert.equal(beforeGeneralFlood.at(-1)?.roonStage?.staleCallback, true);
  assert.equal(runtime.getPlaybackState().local?.request_id, second.request_id);
  assert.equal(runtime.getPlaybackState().local?.phase, 'PLAYING');
  const captures = f.captures(), writes = f.queueWrites();
  // 空队列在原 Controller 入口同步拒绝，填充真实通用诊断且不触发来源或设备 I/O。
  for (let index = 0; index < 225; index++) await assert.rejects(runtime.replacePlaybackQueue([], 0));
  for (let index = 0; index < 256; index++) sdk.plays[1]!('Time', { seek_position_ms: index, privatePath: f.media });
  const core = runtime.getDiagnostics();
  const local = core.timeline.filter(event => event.roonStage);
  const general = core.timeline.filter(event => !event.roonStage);
  assert.deepEqual(local, beforeGeneralFlood);
  assert.equal(local.length, 50);
  assert.equal(general.length, 150);
  assert.equal(core.timeline.length, 200);
  assert.ok(general.every(event => event.event === 'queue_replace_failed'));
  assert.equal(f.captures(), captures);
  assert.equal(f.queueWrites(), writes);
  assert.equal(sdk.sessions.length, 2);
  assert.equal(sdk.sends.length, 2);
  assert.equal(validateIpcResponseForCommand({ version: 1, id: 'runtime-diagnostics', ok: true, result: core }, 'core.getDiagnostics').ok, true);
  assert.ok(events.every(event => validateIpcEvent(event).ok));
  assert.ok(local.every(event => isRoonDiagnosticStage(event.roonStage)));

  const output = path.join(f.directory, 'mbf001-diagnostics.json');
  await mainModule.writeDiagnosticReport(output, {
    platform: { platform: 'darwin', arch: 'arm64', appVersion: '0.1.0-beta.2', electronVersion: '43.4.0', nodeVersion: '22.23.2' },
    main: main.snapshot(runtime.getHealth()), core,
  });
  const serialized = await readFile(output, 'utf8');
  const report = JSON.parse(serialized) as DiagnosticReport;
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  assert.equal(report.core.timeline.length, 200);
  assert.ok(report.main.timeline.length <= 200);
  assert.deepEqual(report.core.timeline.filter(event => event.roonStage), local);
  assertDiagnosticExportSafe(serialized);
  assert.ok(!serialized.includes(f.media));
  assert.doesNotMatch(serialized, /runtime-first-session|runtime-second-session|https?:\/\/|\/Users\/|stackTrace|privatePath/u);
  await runtime.shutdown();
});
