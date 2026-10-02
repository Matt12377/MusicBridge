import assert from 'node:assert/strict';
import test from 'node:test';
import { BridgeController } from '../src/application/bridge-controller.js';
import { NeteaseClient } from '../src/netease/client.js';
import type { RoonPlayRequest, RoonPort, RoonState } from '../src/roon/types.js';
import { BridgeError } from '../src/shared/errors.js';
import { createLogger } from '../src/shared/logger.js';
import { StreamGateway } from '../src/stream/gateway.js';
import { StreamRegistry } from '../src/stream/registry.js';

class SyntheticRoon implements RoonPort {
  readonly writes: string[] = [];
  private state: RoonState = { status: 'ready', selectedZoneId: 'synthetic-zone' };
  setTerminalHandler(): void {}
  async start(): Promise<void> {}
  async shutdown(): Promise<void> { await this.stop(); }
  async stop(): Promise<void> { this.state = { ...this.state, status: 'ready', transportState: 'stopped' }; }
  async pause(): Promise<void> { this.state = { ...this.state, status: 'paused', transportState: 'paused' }; }
  async resume(): Promise<void> { this.state = { ...this.state, status: 'playing', transportState: 'playing' }; }
  async play(request: RoonPlayRequest): Promise<void> {
    request.onDispatch?.();
    this.writes.push(request.metadata.id);
    request.onStartupStage?.('roon-session-began');
    this.state = { ...this.state, status: 'playing', transportState: 'playing' };
    request.onStartupStage?.('roon-playing');
  }
  getState(): RoonState { return this.state; }
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, '合成请求未在期限内到达预期阶段');
    await new Promise<void>(resolve => setTimeout(resolve, 1));
  }
}

function makeHarness(heldId: (id: string) => boolean = () => false) {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const metadataRequests: string[] = [];
  const urlRequests: string[] = [];
  let physicalRequests = 0;
  let peakPhysicalRequests = 0;
  let backgroundRequests = 0;
  let peakBackgroundRequests = 0;
  const provider = {
    async song_detail(params: Record<string, unknown>) {
      const id = String(params.ids);
      metadataRequests.push(id);
      physicalRequests++;
      peakPhysicalRequests = Math.max(peakPhysicalRequests, physicalRequests);
      const background = heldId(id);
      if (background) {
        backgroundRequests++;
        peakBackgroundRequests = Math.max(peakBackgroundRequests, backgroundRequests);
      }
      try {
        if (background) await held;
        return { body: { code: 200, songs: [{ id: Number(id), name: '合成曲目',
          ar: [{ name: '合成艺人' }], al: { name: '合成专辑' }, dt: 120_000 }] } };
      } finally {
        physicalRequests--;
        if (background) backgroundRequests--;
      }
    },
    async song_url_v1(params: Record<string, unknown>) {
      const id = String(params.id);
      urlRequests.push(id);
      physicalRequests++;
      peakPhysicalRequests = Math.max(peakPhysicalRequests, physicalRequests);
      try {
        return { body: { code: 200, data: [{ id: Number(id), url: 'https://cdn.example/audio.flac',
          level: 'lossless', type: 'flac', expi: 600 }] } };
      } finally { physicalRequests--; }
    },
    async login_qr_key() { return {}; }, async login_qr_create() { return {}; },
    async login_qr_check() { return {}; }, async login_status() { return {}; }, async logout() { return {}; },
  };
  const netease = new NeteaseClient('synthetic-credential', provider);
  const roon = new SyntheticRoon();
  const registry = new StreamRegistry();
  const gateway = new StreamGateway({ host: '127.0.0.1', port: 0,
    publicBaseUrl: 'http://127.0.0.1:38502', registry, logger: createLogger('error'),
    fetcher: async () => new Response(null, { status: 206 }) });
  const controller = new BridgeController({ netease, roon, registry, gateway, logger: createLogger('error') });
  return { netease, roon, registry, gateway, controller, metadataRequests, urlRequests, release,
    get peakPhysicalRequests() { return peakPhysicalRequests; },
    get peakBackgroundRequests() { return peakBackgroundRequests; },
    async close() { release(); await controller.shutdown(); } };
}

for (const size of [9, 20]) {
  test(`生产请求层与Controller整合：${size}项冷队列背景仍等待时当前歌曲已播放`, async () => {
    const h = makeHarness(id => id !== '8100');
    try {
      await h.controller.replaceQueue(Array.from({ length: size }, (_, i) => ({ trackId: String(8100 + i) })), 0);
      assert.equal(h.controller.getPlaybackState().state, 'playing');
      assert.equal(h.controller.getPlaybackState().currentTrack?.id, '8100');
      assert.equal(h.metadataRequests[0], '8100');
      assert.equal(h.urlRequests[0], '8100');
      assert.deepEqual(h.roon.writes, ['8100']);
      assert.ok(h.peakBackgroundRequests <= 2, `后台物理峰值 ${h.peakBackgroundRequests}`);
      assert.ok(h.peakPhysicalRequests <= 8);
    } finally { await h.close(); }
  });
}

test('生产请求层与Controller整合：9次快切等待真实额度释放后最后一首成功', async () => {
  const h = makeHarness();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  // 延迟放在 SDK 内才能检验物理额度；重新使用同一正式请求层建立探针。
  const requests: string[] = [];
  let physical = 0;
  let peak = 0;
  const provider = {
    async song_detail(params: Record<string, unknown>) {
      const id = String(params.ids); requests.push(id); physical++; peak = Math.max(peak, physical);
      try {
        await held;
        return { body: { code: 200, songs: [{ id: Number(id), name: '合成曲目',
          ar: [{ name: '合成艺人' }], al: { name: '合成专辑' }, dt: 120_000 }] } };
      } finally { physical--; }
    },
    async song_url_v1(params: Record<string, unknown>) {
      return { body: { code: 200, data: [{ id: Number(params.id), url: 'https://cdn.example/audio.flac',
        level: 'lossless', type: 'flac', expi: 600 }] } };
    },
    async login_qr_key() { return {}; }, async login_qr_create() { return {}; },
    async login_qr_check() { return {}; }, async login_status() { return {}; }, async logout() { return {}; },
  };
  const controller = new BridgeController({ netease: new NeteaseClient('synthetic-credential', provider),
    roon: h.roon, registry: h.registry, gateway: h.gateway, logger: createLogger('error') });
  const results: Array<Promise<unknown>> = [];
  try {
    for (let i = 0; i < 8; i++) {
      results.push(controller.replaceQueue([{ trackId: String(8200 + i) }]).catch(error => error));
      await waitFor(() => requests.length === i + 1);
    }
    let settled = false;
    const latest = controller.replaceQueue([{ trackId: '8208' }]).finally(() => { settled = true; });
    results.push(latest);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, false, '第9首应等待实际在途结束，不能立即预算失败');
    assert.equal(requests.length, 8);
    const cancelled = await Promise.all(results.slice(0, 8));
    assert.ok(cancelled.every(error => error instanceof BridgeError && error.details?.reason === 'operation_cancelled'));
    release();
    await latest;
    assert.equal(peak, 8);
    assert.equal(controller.getPlaybackState().state, 'playing');
    assert.equal(controller.getPlaybackState().currentTrack?.id, '8208');
    assert.deepEqual(h.roon.writes, ['8208']);
  } finally {
    release(); await Promise.allSettled(results); await controller.shutdown(); await h.close();
  }
});

test('生产请求层与Controller整合：旧预检实际撤销且迟到响应不能写入Roon', async () => {
  const h = makeHarness();
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const begun = new Promise<void>(resolve => { entered = resolve; });
  const signals: AbortSignal[] = [];
  const gateway = new StreamGateway({ host: '127.0.0.1', port: 0,
    publicBaseUrl: 'http://127.0.0.1:38502', registry: h.registry, logger: createLogger('error'),
    fetcher: async (_url, init) => {
      assert.ok(init.signal); signals.push(init.signal);
      if (signals.length === 1) { entered(); await held; }
      return new Response(null, { status: 206 });
    } });
  const controller = new BridgeController({ netease: h.netease, roon: h.roon,
    registry: h.registry, gateway, logger: createLogger('error') });
  const old = controller.replaceQueue([{ trackId: '8300' }]).catch(error => error);
  try {
    await begun;
    await controller.replaceQueue([{ trackId: '8301' }]);
    const result = await old;
    assert.ok(result instanceof BridgeError && result.details?.reason === 'operation_cancelled');
    assert.equal(signals[0]?.aborted, true);
    assert.deepEqual(h.roon.writes, ['8301']);
    release();
    await waitFor(() => gateway.getDiagnosticResourceCounters().timerCount === 0);
    assert.deepEqual(h.roon.writes, ['8301']);
    assert.equal(gateway.getDiagnosticResourceCounters().listenerCount, 1, '只保留当前歌曲的流观察器');
  } finally { release(); await old; await controller.shutdown(); await h.close(); }
});

test('生产请求层与Controller整合：离开41项旧队列后不继续派发旧补全', async () => {
  const oldMetadata = (id: string) => Number(id) > 8400 && Number(id) < 8441;
  const h = makeHarness(oldMetadata);
  try {
    await h.controller.replaceQueue(Array.from({ length: 41 }, (_, i) => ({ trackId: String(8400 + i) })), 0);
    await waitFor(() => h.metadataRequests.filter(oldMetadata).length === 2);
    const before = h.metadataRequests.filter(oldMetadata).length;
    await h.controller.replaceQueue([{ trackId: '8500' }], 0);
    assert.equal(h.controller.getPlaybackState().currentTrack?.id, '8500');
    h.release();
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(h.metadataRequests.filter(oldMetadata).length, before, '迟到SDK回包不能启动旧队列后继补全');
    assert.equal(h.controller.getPlaybackState().queue.items.length, 1);
    assert.equal(h.controller.getPlaybackState().queue.items[0]?.trackId, '8500');
    assert.deepEqual(h.roon.writes, ['8400', '8500']);
    assert.ok(h.peakBackgroundRequests <= 2);
    assert.ok(h.peakPhysicalRequests <= 8);
  } finally { await h.close(); }
});

test('生产请求层与Controller整合：后台等待队列满时仍为当前曲元数据及URL保留位置', async () => {
  const h = makeHarness(id => Number(id) >= 8600 && Number(id) < 8608);
  const blockers = Array.from({ length: 8 }, (_, i) => h.netease.getTrack(String(8600 + i), { priority: 'playback' }));
  const blockedResults = Promise.allSettled(blockers);
  let background: Array<Promise<unknown>> = [];
  let latest: Promise<unknown> | undefined;
  try {
    await waitFor(() => h.metadataRequests.length === 8);
    background = Array.from({ length: 31 }, (_, i) => h.netease.getTrack(String(8700 + i), { priority: 'background' }).catch(error => error));
    latest = h.controller.replaceQueue([{ trackId: '8800' }], 0).catch(error => error);
    await new Promise<void>(resolve => setImmediate(resolve));
    h.release();
    const result = await latest;
    assert.ok(!(result instanceof Error), '当前曲两份工作不能被后台占满等待队列而拒绝');
    assert.equal(h.controller.getPlaybackState().state, 'playing');
    assert.equal(h.controller.getPlaybackState().currentTrack?.id, '8800');
    assert.deepEqual(h.roon.writes, ['8800']);
    assert.ok(h.peakPhysicalRequests <= 8);
  } finally { h.release(); await blockedResults; await Promise.allSettled(background); await latest; await h.close(); }
});
