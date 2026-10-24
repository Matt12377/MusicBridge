import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { IPC_VERSION } from '@music-bridge/contracts';
import { CoreSupervisor, type CoreChildProcess, type CoreMessagePort } from '../../src/main/core-supervisor.js';
import { createMobileBackend } from '../../src/main/mobile-backend.js';
import { isMobileCorePrivateCall, type MobileCorePrivateCall } from '../../../../packages/bridge-core/src/mobile/owner-protocol.js';
import { attachMobileSealedCoreReceiver, captureMobileSealedRequestFromPort,
  encodeMobileSealedCoreReply } from '../../../../packages/bridge-core/src/mobile/sealed-request-transport.js';
import { withMobileMediaReadBudget } from '../../../../packages/bridge-core/src/mobile/media-read-budget.js';
import { MobileAuthPersistenceError, MobileServiceError, type MobileOwnerPrivateResult,
  type MobileSealedState } from '../../../../packages/bridge-core/src/mobile/types.js';

const DATASET = 'dataset.mac71-cancellation', SERVER = 'server.mac71-cancellation';
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
async function turns(count = 8) { for (let n = 0; n < count; n++) await new Promise<void>(yes => setImmediate(yes)); }
function serviceFailure(error: unknown, status = 503, code = 'BUSY'): boolean {
  assert.ok(error instanceof MobileServiceError); assert.equal(error.status, status); assert.equal(error.code, code); return true;
}
function resultFailure(error: unknown) {
  return error instanceof MobileServiceError ? { status: error.status, code: error.code, retryable: error.retryable }
    : { type: error instanceof Error ? error.name : '非错误对象' };
}

/** 仅模拟端口另一端的RAM Owner；Main、Auth、预算与密文端口编码均使用真实实现。 */
class OwnerPort implements CoreMessagePort {
  private listener?: (event: { data: unknown }) => void;
  private incoming!: (event: { data: unknown }) => void;
  child?: SimulatedChild;
  hold = false;
  entered = deferred();
  readonly pending = new Map<string, MobileCorePrivateCall>();
  readonly calls: MobileCorePrivateCall[] = [];
  stored: MobileSealedState = { kind: 'missing', datasetId: DATASET, revision: 0 };
  badCiphertext = false;
  constructor() {
    attachMobileSealedCoreReceiver({ on: (_event, listener) => { this.incoming = listener; } }, event => {
      if (!isMobileCorePrivateCall(event.data)) return;
      const original = captureMobileSealedRequestFromPort(event.data) ?? event.data;
      assert.ok(isMobileCorePrivateCall(original));
      const call = structuredClone(original); this.calls.push(call);
      if (this.hold && call.request.kind === 'load') { this.pending.set(call.id, call); this.entered.resolve(); }
      else queueMicrotask(() => this.reply(call));
    });
  }
  on(_event: 'message', listener: (event: { data: unknown }) => void) { this.listener = listener; }
  start() {}
  close() {}
  receive(value: unknown) { this.listener?.({ data: structuredClone(value) }); }
  postMessage(value: unknown) {
    const message = value as { version?: unknown; id?: unknown; command?: unknown; type?: unknown };
    if (message.version === IPC_VERSION && message.command === 'core.shutdown' && typeof message.id === 'string') {
      queueMicrotask(() => {
        this.receive({ version: IPC_VERSION, id: message.id, ok: true, result: { stopped: true } });
        queueMicrotask(() => this.child?.exit());
      });
    } else this.incoming({ data: structuredClone(value) });
  }
  reply(call: MobileCorePrivateCall) {
    let result: MobileOwnerPrivateResult;
    if (call.request.kind === 'load') {
      result = this.badCiphertext && this.stored.kind === 'sealed'
        ? { ...this.stored, sealed: new Uint8Array(64).fill(91) } : structuredClone(this.stored);
    } else if (call.request.kind === 'save') {
      const input = call.request.request;
      assert.equal(input.expectedRevision, this.stored.revision);
      this.stored = { kind: 'sealed', datasetId: DATASET, revision: input.expectedRevision + 1,
        commitId: input.commitId, sealed: new Uint8Array(input.sealed) };
      result = { kind: 'saved', datasetId: DATASET, revision: this.stored.revision, commitId: input.commitId };
    } else throw new Error('合成Owner不接纳范围外请求。');
    this.receive(encodeMobileSealedCoreReply({ type: 'mobile-main-response', id: call.id, result }, call));
    this.pending.delete(call.id);
  }
  release() { this.hold = false; for (const call of [...this.pending.values()]) this.reply(call); }
  get loads() { return this.calls.filter(call => call.request.kind === 'load').length; }
}
/** 纯内存生命周期对象；不会创建或结束操作系统进程。 */
class SimulatedChild implements CoreChildProcess {
  private listeners: ((code: number) => void)[] = [];
  postMessage(_value: unknown) {}
  once(_event: 'exit', listener: (code: number) => void) { this.listeners.push(listener); }
  kill() { this.exit(); return true; }
  exit() { for (const listener of this.listeners.splice(0)) listener(0); }
}
function ready(port: OwnerPort) {
  port.receive({ version: IPC_VERSION, event: 'core.ready', payload: { state: {
    runtime: 'ready', roon: 'disconnected', provider: 'missing', activeStreamCount: 0, activePlaybackPresent: false,
  } } });
}
async function fixture(t: TestContext) {
  const ports: OwnerPort[] = [], children: SimulatedChild[] = [];
  const supervisor = new CoreSupervisor({ entryPath: '/synthetic/mac71/core.cjs', cwd: '/synthetic/mac71',
    requestTimeoutMs: 500, startupTimeoutMs: 2000, dependencies: {
      createChannel() { const port = new OwnerPort(); ports.push(port); return { port1: new OwnerPort(), port2: port }; },
      fork() { const child = new SimulatedChild(); children.push(child); return child; },
    } });
  const started = supervisor.start();
  ports[0]!.child = children[0]!; ready(ports[0]!); await started;
  const handle = createMobileBackend({ serverId: SERVER, datasetId: DATASET, authKey: new Uint8Array(32).fill(71),
    displayName: '合成取消边界', environment: 'development', requestOwner: request => supervisor.requestMobileMain(request),
    assertCurrent() {}, resizeArtwork() { throw new Error('本测试不读取图片。'); } });
  t.after(async () => { for (const port of ports) port.release(); await handle.close(); await supervisor.shutdown(); });
  async function pair() {
    const permit = await handle.auth.issuePairing();
    const tokens = await handle.auth.claim({ pairingSecret: permit.pairingSecret, installationId: 'installation.mac71', deviceName: '合成设备' }, 'pair.mac71');
    const principal = await handle.auth.authenticate(tokens.accessToken);
    return { ...tokens, deviceEpoch: principal.deviceEpoch };
  }
  return { supervisor, handle, ports, children, owner: ports[0]!, pair };
}
function media<T>(controller: AbortController, work: () => T): T {
  return withMobileMediaReadBudget(performance.now() + 30_000, controller.signal, work);
}
async function assertRecovered(t: TestContext, f: Awaited<ReturnType<typeof fixture>>, deviceId: string, epoch: number) {
  const before = f.owner.loads;
  const recovered = await f.handle.auth.assertDeviceCurrent(deviceId, epoch).then(() => true, error => error as unknown);
  t.diagnostic(JSON.stringify({ freshOwnerLoads: f.owner.loads - before,
    independentAuthorization: recovered === true ? '成功' : resultFailure(recovered) }));
  assert.equal(recovered, true, '取消只能拒绝当前媒体请求，独立授权必须重读Owner并恢复。');
  assert.equal(f.owner.loads, before + 1, '独立授权不得借缓存或fatal短路。');
}

test('正常对照：真实Main/Auth配对后每次设备授权重读RAM Owner', async t => {
  const f = await fixture(t), pair = await f.pair(); await assertRecovered(t, f, pair.deviceId, pair.deviceEpoch);
});

test('发送前取消只拒绝本次GET Range授权，下一独立授权仍重读Owner成功', async t => {
  const f = await fixture(t), pair = await f.pair(), controller = new AbortController(), before = f.owner.loads;
  controller.abort(new DOMException('合成Range已取消。', 'AbortError'));
  await assert.rejects(media(controller, () => f.handle.auth.assertDeviceCurrent(pair.deviceId, pair.deviceEpoch)), serviceFailure);
  assert.equal(f.owner.loads, before, '发送前取消不得提交Owner请求。');
  await assertRecovered(t, f, pair.deviceId, pair.deviceEpoch);
});

test('已发送load迟到回包后取消只拒绝原请求，后续独立授权仍重读Owner成功', async t => {
  const f = await fixture(t), pair = await f.pair(), controller = new AbortController();
  f.owner.hold = true;
  let settled = false;
  const pending = media(controller, () => f.handle.auth.assertDeviceCurrent(pair.deviceId, pair.deviceEpoch))
    .then(() => { settled = true; return null; }, error => { settled = true; return error as unknown; });
  await f.owner.entered.promise; controller.abort(new DOMException('合成Range已取消。', 'AbortError'));
  await turns(); assert.equal(settled, false, '取消不代表原Owner物理请求已经settle。');
  assert.equal(f.owner.pending.size, 1); f.owner.release(); serviceFailure(await pending);
  assert.equal(f.owner.pending.size, 0); await assertRecovered(t, f, pair.deviceId, pair.deviceEpoch);
});

for (const phase of ['发送前', '迟到回包后'] as const) test(`${phase}30秒预算过期仍仅为本次暂错，独立授权恢复`, async t => {
  const f = await fixture(t), pair = await f.pair(), controller = new AbortController();
  let clock = 1000; const mock = t.mock.method(performance, 'now', () => clock);
  const deadline = clock + 30_000;
  let pending: Promise<unknown>;
  if (phase === '发送前') {
    pending = withMobileMediaReadBudget(deadline, controller.signal, () => {
      clock = deadline + 1;
      return f.handle.auth.assertDeviceCurrent(pair.deviceId, pair.deviceEpoch);
    }).then(() => null, error => error as unknown);
  } else {
    f.owner.hold = true;
    pending = withMobileMediaReadBudget(deadline, controller.signal,
      () => f.handle.auth.assertDeviceCurrent(pair.deviceId, pair.deviceEpoch)).then(() => null, error => error as unknown);
    await f.owner.entered.promise; clock = deadline + 1; f.owner.release();
  }
  const error = await pending; serviceFailure(error); assert.ok(error instanceof MobileServiceError && error.retryable);
  mock.mock.restore(); await assertRecovered(t, f, pair.deviceId, pair.deviceEpoch);
});

test('32个原Owner物理槽不因取消或未知id回包释放，只在同actor有效原reply后接纳新请求', async t => {
  const f = await fixture(t); f.owner.hold = true;
  const controllers = Array.from({ length: 32 }, () => new AbortController());
  const values = controllers.map(controller => media(controller, () => f.supervisor.requestMobileMain({ kind: 'load', datasetId: DATASET }))
    .then(result => result, error => error as unknown));
  assert.equal(f.owner.calls.length, 32); controllers[0]!.abort(new DOMException('合成取消。', 'AbortError'));
  await turns(); assert.equal(f.owner.pending.size, 32);
  const blocked = () => assert.rejects(media(new AbortController(), () => f.supervisor.requestMobileMain({ kind: 'load', datasetId: DATASET })),
    error => error instanceof MobileAuthPersistenceError && error.outcome === 'not-sent');
  await blocked();
  f.owner.receive({ type: 'mobile-main-response', id: '不存在的原请求', result: { kind: 'missing', datasetId: DATASET, revision: 0 } });
  await blocked(); assert.equal(f.owner.calls.length, 32);
  f.owner.reply(f.owner.calls[0]!); await values[0];
  const extra = media(new AbortController(), () => f.supervisor.requestMobileMain({ kind: 'load', datasetId: DATASET }));
  assert.equal(f.owner.calls.length, 33); f.owner.release(); await Promise.all(values); await extra;
});

test('旧generation伪造新id回包不得完成或释放新actor的Owner读取', async t => {
  const f = await fixture(t), old = f.owner;
  const restarting = f.supervisor.restart(); await turns();
  assert.equal(f.ports.length, 2); const current = f.ports[1]!;
  current.child = f.children[1]!; ready(current); await restarting;
  current.hold = true;
  let settled = false;
  const pending = media(new AbortController(), () => f.supervisor.requestMobileMain({ kind: 'load', datasetId: DATASET }))
    .then(value => { settled = true; return value; });
  await current.entered.promise;
  old.receive({ type: 'mobile-main-response', id: current.calls[0]!.id, result: { kind: 'missing', datasetId: DATASET, revision: 0 } });
  await turns(); assert.equal(settled, false); assert.equal(current.pending.size, 1);
  current.release(); const result = await pending; assert.ok('kind' in result); assert.equal(result.kind, 'missing');
});

test('真实撤销保持403 DEVICE_REVOKED，不因媒体读暂态放宽', async t => {
  const f = await fixture(t), pair = await f.pair(); await f.handle.auth.revokeDevice(pair.deviceId);
  await assert.rejects(media(new AbortController(), () => f.handle.auth.assertDeviceCurrent(pair.deviceId, pair.deviceEpoch)),
    error => serviceFailure(error, 403, 'DEVICE_REVOKED'));
});

test('真实密文认证损坏仍锁闭，恢复Owner旧密文不能绕过fatal', async t => {
  const f = await fixture(t), pair = await f.pair(); f.owner.badCiphertext = true;
  const error = await f.handle.auth.assertDeviceCurrent(pair.deviceId, pair.deviceEpoch).then(() => null, error => error as unknown);
  serviceFailure(error); assert.ok(error instanceof MobileServiceError && !error.retryable);
  f.owner.badCiphertext = false; const before = f.owner.loads;
  await assert.rejects(f.handle.auth.assertDeviceCurrent(pair.deviceId, pair.deviceEpoch), serviceFailure);
  assert.equal(f.owner.loads, before, '真实密文损坏fatal不得改为重读后放行。');
});
