import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import type { DatasetOwnerEndpoint } from '../../src/collection/dataset-owner-protocol.js';
import { NeteaseClient } from '../../src/netease/client.js';
import type { NeteaseMobileReadPort } from '../../src/netease/types.js';
import { createMobileContentRuntime } from '../../src/mobile/content-runtime.js';
import { mobileCapabilityRequestSha, snapshotMobileCapabilityTrace } from '../../src/mobile/capability-trace.js';
import type { MobileContentCoreRequest, MobileContentCoreResponse } from '../../src/mobile/content-rpc.js';
import { MobileServiceError } from '../../src/mobile/types.js';

const signal = () => new AbortController().signal;
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function turns() { for (let index = 0; index < 4; index++) await turn(); }
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const unknown = (response: MobileContentCoreResponse) => 'kind' in response && response.kind === 'error' && response.outcome === 'unknown';
function fixture(t: TestContext, options: { ownerWait?: Promise<void>; ownerEntered?(): void; client?: NeteaseMobileReadPort;
  ownerInvalidate?(): Promise<void>; closeFailure?: boolean; release?(): void } = {}) {
  const datasetId = randomUUID(), epoch = randomUUID(), serverId = 'scope.lifecycle.synthetic';
  const calls = { ownerUpdates: 0, ownerDevices: [] as string[], invalidations: 0, accounts: 0, reads: 0 };
  const owner: DatasetOwnerEndpoint = {
    async prepare() { return { datasetId, epoch }; },
    async mobileMain(input) {
      assert.equal(input.kind, 'content');
      if (input.kind !== 'content') throw new Error('本例不执行媒体或其它Owner域。');
      if (input.request.action === 'initialize') return { kind: 'content-initialized', datasetId, ownerEpoch: epoch, serverId };
      if (input.request.action === 'invalidateScope') {
        calls.invalidations++; await options.ownerInvalidate?.();
        return { kind: 'content-scope-invalidated', datasetId, ownerEpoch: epoch, scopeKind: input.request.kind };
      }
      if (input.request.action !== 'updateScope') throw new Error('本例不执行内容或写操作。');
      calls.ownerUpdates++; calls.ownerDevices.push(input.request.scope.deviceId); options.ownerEntered?.(); await options.ownerWait;
      return { kind: 'content-scope-updated', datasetId, ownerEpoch: epoch, scope: input.request.scope };
    },
    async dispatch() { throw new Error('本例不派发普通命令。'); }, async commitBoot() {}, async close() {},
  };
  const client: NeteaseMobileReadPort = options.client ?? {
    configured: false, async mobileAccount() { calls.accounts++; throw new Error('未配置账号不得访问SDK。'); },
    async mobileRead() { calls.reads++; throw new Error('本例不读取Provider。'); },
    onMobileAccountInvalidated: () => () => {}, async awaitMobileQuiet() {},
  };
  const runtime = createMobileContentRuntime({ owner, netease: client, assertCurrent() {} });
  t.after(async () => { options.release?.();
    if (options.closeFailure) await assert.rejects(runtime.close(), (error: unknown) => error instanceof MobileServiceError && error.code === 'BUSY');
    else await runtime.close();
  });
  const packet = () => ({ type: 'mobile-content-core-request' as const, id: randomUUID() });
  const initialize = () => runtime.request({ ...packet(), action: 'initialize', serverId, datasetId, key: new Uint8Array(32).fill(12) }, signal());
  const scope = (device: string): Extract<MobileContentCoreRequest, { action: 'scope' }> => ({ ...packet(), action: 'scope',
    principal: { serverId, datasetId, deviceId: device, deviceEpoch: 1, accessGeneration: 1 } });
  const cancel = (request: MobileContentCoreRequest): Extract<MobileContentCoreRequest, { action: 'cancel' }> => ({ ...packet(), action: 'cancel',
    requestId: request.id, snapshotId: null, scope: null });
  return { runtime, initialize, scope, cancel, calls };
}

test('scope取消：尚未开始的串行任务可撤回，quiet不等待无关前驱Owner工作', async t => {
  const entered = deferred(), release = deferred();
  const f = fixture(t, { ownerWait: release.promise, ownerEntered: () => entered.resolve(), release: () => release.resolve() });
  await f.initialize();
  const firstRequest = f.scope('scope.first.device'), first = f.runtime.request(firstRequest, signal());
  await entered.promise;
  const request = f.scope('scope.queued.device'), controller = new AbortController();
  const second = f.runtime.request(request, controller.signal); await turns();
  const hash = mobileCapabilityRequestSha('content', request.id);
  assert.ok(snapshotMobileCapabilityTrace().records.some(row => row.requestSha256 === hash && row.stage === 'core.scope.queue' && row.phase === 'begin'));
  controller.abort(); assert.ok(unknown(await second));
  let quiet = false;
  const cancelling = f.runtime.request(f.cancel(request), signal()).then(response => { quiet = 'kind' in response && response.kind === 'cancelled'; return response; });
  await turns();
  assert.equal(quiet, true, '目标尚未开始，不得让其取消依赖无关前驱完成。');
  assert.equal(f.calls.ownerUpdates, 1, '被撤回的目标不能迟到调用Owner。');
  release.resolve(); await Promise.all([first, cancelling]); await turns();
  assert.equal(f.calls.ownerUpdates, 1);
});

test('scope取消：已发出的Owner工作不得因abort提前quiet，原工作落定后才可复核', async t => {
  const entered = deferred(), release = deferred();
  const f = fixture(t, { ownerWait: release.promise, ownerEntered: () => entered.resolve(), release: () => release.resolve() });
  await f.initialize();
  const request = f.scope('scope.active.device'), controller = new AbortController();
  const pending = f.runtime.request(request, controller.signal); await entered.promise;
  controller.abort(); assert.ok(unknown(await pending));
  const cancelController = new AbortController(); let settled = false;
  const cancelling = f.runtime.request(f.cancel(request), cancelController.signal).then(response => { settled = true; return response; });
  await turns(); assert.equal(settled, false, '原Owner仍在执行，不能提前ACK。');
  cancelController.abort(); assert.ok(unknown(await cancelling));
  release.resolve(); await turns();
  const checked = await f.runtime.request(f.cancel(request), signal());
  assert.ok('kind' in checked && checked.kind === 'cancelled' && checked.quiet);
  assert.equal(f.calls.ownerUpdates, 1);
});

test('scope取消：撤回中间排队项不改变其余请求的Owner执行顺序', async t => {
  const entered = deferred(), release = deferred();
  const f = fixture(t, { ownerWait: release.promise, ownerEntered: () => entered.resolve(), release: () => release.resolve() });
  await f.initialize();
  const first = f.runtime.request(f.scope('scope.fifo.first'), signal()); await entered.promise;
  const controller = new AbortController(), middleRequest = f.scope('scope.fifo.middle');
  const middle = f.runtime.request(middleRequest, controller.signal);
  const last = f.runtime.request(f.scope('scope.fifo.last'), signal()); await turns();
  controller.abort(); assert.ok(unknown(await middle));
  const cancelled = await f.runtime.request(f.cancel(middleRequest), signal());
  assert.ok('kind' in cancelled && cancelled.kind === 'cancelled' && cancelled.quiet);
  assert.deepEqual(f.calls.ownerDevices, ['scope.fifo.first']);
  release.resolve();
  for (const result of await Promise.all([first, last])) assert.ok('kind' in result && result.kind === 'scope');
  assert.deepEqual(f.calls.ownerDevices, ['scope.fifo.first', 'scope.fifo.last']);
});

test('scope取消：等待旧provider屏障且尚未开始的请求可撤回，不把旧工作当成自身工作', async t => {
  const entered = deferred(), release = deferred();
  const f = fixture(t, { ownerWait: release.promise, ownerEntered: () => entered.resolve(), release: () => release.resolve() });
  await f.initialize();
  const firstRequest = f.scope('scope.provider.predecessor'), first = f.runtime.request(firstRequest, signal());
  await entered.promise;
  const provider = f.runtime.providerChanged(); await turns();
  const request = f.scope('scope.provider.waiter'), controller = new AbortController();
  const second = f.runtime.request(request, controller.signal); await turns();
  const hash = mobileCapabilityRequestSha('content', request.id), observed = snapshotMobileCapabilityTrace().records;
  assert.ok(observed.some(row => row.requestSha256 === hash && row.stage === 'core.scope.provider-tail' && row.phase === 'begin'));
  assert.equal(observed.some(row => row.requestSha256 === hash && row.stage === 'core.scope.account.first'), false);
  controller.abort(); assert.ok(unknown(await second));
  let quiet = false;
  const cancelling = f.runtime.request(f.cancel(request), signal()).then(response => { quiet = 'kind' in response && response.kind === 'cancelled'; return response; });
  await turns(); assert.equal(quiet, true, '未进入实际工作，不应把旧provider屏障算作目标资源。');
  assert.equal(f.calls.ownerUpdates, 1);
  release.resolve(); await Promise.all([first, provider, cancelling]);
  assert.equal(f.calls.ownerUpdates, 1);
});

for (const failure of [false, true]) test(`scope取消：全部撤回订阅后仍等待原Provider围栏${failure ? '并保留其失败' : '再允许活跃订阅继续'}`, async t => {
  const entered = deferred(), release = deferred();
  const client: NeteaseMobileReadPort = {
    configured: true, async mobileAccount() { return { accountId: '700', providerEpoch: 'scope.provider.synthetic' }; },
    async mobileRead() { throw new Error('本例不读取Provider。'); }, onMobileAccountInvalidated: () => () => {}, async awaitMobileQuiet() {},
  };
  const f = fixture(t, { client, closeFailure: failure, release: () => release.resolve(), async ownerInvalidate() {
    entered.resolve(); await release.promise; if (failure) throw new Error('合成Provider围栏失败。');
  } });
  await f.initialize();
  const original = await f.runtime.request(f.scope('scope.provider.registered'), signal());
  assert.ok('kind' in original && original.kind === 'scope');
  // 预先接住失败，避免测试自身制造未处理拒绝；不改变原providerTail结果。
  const provider = f.runtime.providerChanged().then(() => ({ ok: true }), () => ({ ok: false }));
  await entered.promise;
  for (let index = 0; index < 20; index++) {
    const request = f.scope('scope.provider.withdrawn'), controller = new AbortController();
    const pending = f.runtime.request(request, controller.signal); await turns();
    controller.abort(); assert.ok(unknown(await pending));
    const cancelled = await f.runtime.request(f.cancel(request), signal());
    assert.ok('kind' in cancelled && cancelled.kind === 'cancelled' && cancelled.quiet);
  }
  assert.equal(f.calls.ownerUpdates, 1); assert.equal(f.calls.invalidations, 1);
  let finished = false;
  if (failure) {
    const closing = f.runtime.close().then(() => { finished = true; return false; }, () => { finished = true; return true; });
    await turns(); assert.equal(finished, false, '零订阅不代表原Provider工作或Runtime已quiet。');
    release.resolve(); assert.equal(await closing, true); assert.deepEqual(await provider, { ok: false });
  } else {
    const active = f.runtime.request(f.scope('scope.provider.active'), signal()).then(value => { finished = true; return value; });
    await turns(); assert.equal(finished, false, '未取消的请求必须继续等待原围栏。');
    release.resolve(); assert.deepEqual(await provider, { ok: true });
    const result = await active; assert.ok('kind' in result && result.kind === 'scope');
    assert.deepEqual(f.calls.ownerDevices, ['scope.provider.registered', 'scope.provider.active']);
  }
  assert.equal(f.calls.invalidations, 1);
});

test('scope取消：真实Client封本地SDK等待后scope可quiet，物理SDK的quiet仍独立等待', async t => {
  const entered = deferred(), sdk = deferred<unknown>(); let sdkCalls = 0;
  const unexpected = async (): Promise<never> => { throw new Error('合成账号不得调用其它SDK接口。'); };
  const client = new NeteaseClient('synthetic-scope-lifecycle-cookie', {
    song_detail: unexpected, song_url_v1: unexpected, login_qr_key: unexpected, login_qr_create: unexpected,
    login_qr_check: unexpected, login_status: unexpected, logout: unexpected,
    async user_account() { sdkCalls++; entered.resolve(); return sdk.promise; },
  }, async () => {});
  const release = () => sdk.resolve({ status: 200, body: { code: 200, account: { id: '123456789' } } });
  const f = fixture(t, { client, release }); await f.initialize();
  const request = f.scope('scope.account.device'), controller = new AbortController();
  const pending = f.runtime.request(request, controller.signal); await entered.promise;
  controller.abort(); assert.ok(unknown(await pending));
  const cancelled = await f.runtime.request(f.cancel(request), signal());
  assert.ok('kind' in cancelled && cancelled.kind === 'cancelled' && cancelled.quiet);
  let physicallyQuiet = false;
  const physical = client.awaitMobileQuiet().then(() => { physicallyQuiet = true; });
  await turns(); assert.equal(physicallyQuiet, false);
  assert.equal(sdkCalls, 1); assert.equal(f.calls.ownerUpdates, 0);
  release(); await physical;
});
