import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { createActualMobileNeteasePorts } from '../src/netease/mobile-actual-ports.js';
import type { NeteaseMobileAccountInvalidation, NeteaseMobileReadPort } from '../src/netease/types.js';
import { createMobileContentRuntime } from '../src/mobile/content-runtime.js';
import type { MobileContentCoreRequest, MobileContentCoreResponse } from '../src/mobile/content-rpc.js';
import type { DatasetOwnerEndpoint } from '../src/collection/dataset-owner-protocol.js';
import { createMobileAuthService } from '../src/mobile/auth-service.js';
import {
  MOBILE_AUTH_MAX_RECEIPTS, MOBILE_AUTH_STATE_MAX_BYTES, MobileServiceError,
  type MobileAuthCrypto, type MobileAuthPersistence, type MobileSealedState,
} from '../src/mobile/types.js';

// 本文件只使用合成端口和内存状态，不访问设备、真实账号、磁盘曲库或外网。
const START = 1_700_000_000_000;
const identity = { serverId: 'server.multi-device.synthetic', datasetId: 'dataset.multi-device.synthetic',
  ownerEpoch: 'owner.multi-device.synthetic' };
const signal = () => new AbortController().signal;
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function turns() { for (let index = 0; index < 4; index++) await turn(); }
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const busy = (error: unknown) => error instanceof MobileServiceError && error.status === 503 && error.code === 'BUSY';
const denied = (error: unknown) => error instanceof MobileServiceError && error.status === 401 && error.code === 'UNAUTHORIZED';

function accountFixture(t: TestContext) {
  let now = START, hold: ReturnType<typeof deferred> | undefined, nextFailure: unknown;
  let accountId = '700', epoch = 1;
  const providerEpoch = () => `provider.multi-device.synthetic.${epoch}`;
  const pending = new Set<Promise<unknown>>();
  const pendingBySignal = new WeakMap<AbortSignal, Set<Promise<unknown>>>();
  const listeners = new Set<(event: NeteaseMobileAccountInvalidation) => void>();
  const releases = new Set<() => void>();
  const state = { calls: 0, reads: 0, sdkAborted: 0 };
  const client: NeteaseMobileReadPort = {
    configured: true,
    async mobileAccount(options) {
      state.calls++;
      const captured = { accountId, providerEpoch: providerEpoch() }, failure = nextFailure;
      nextFailure = undefined;
      // 合成SDK忽略物理abort；本地等待仍应立即拒绝，quiet独立等待原始工作真实落定。
      const work = Promise.resolve(hold?.promise).then(() => {
        if (failure !== undefined) throw failure;
        return captured;
      });
      const ownedSignal = options?.signal, owned = ownedSignal ? pendingBySignal.get(ownedSignal) ?? new Set<Promise<unknown>>() : undefined;
      pending.add(work);
      if (ownedSignal && owned) { owned.add(work); pendingBySignal.set(ownedSignal, owned); }
      const settled = () => { pending.delete(work); owned?.delete(work); };
      void work.then(settled, settled);
      return new Promise<typeof captured>((resolve, reject) => {
        let finished = false;
        const finish = (error: unknown, value?: typeof captured) => {
          if (finished) return; finished = true; ownedSignal?.removeEventListener('abort', cancel);
          if (error !== undefined) reject(error); else resolve(value!);
        };
        const cancel = () => { state.sdkAborted++; finish(new MobileServiceError(503, 'BUSY')); };
        ownedSignal?.addEventListener('abort', cancel, { once: true });
        if (ownedSignal?.aborted) cancel();
        void work.then(value => finish(undefined, value), error => finish(error));
      });
    },
    async mobileRead() { state.reads++; throw new Error('本例不允许读取目录或网络素材。'); },
    onMobileAccountInvalidated(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async awaitMobileQuiet(ownedSignal) {
      let owned: Set<Promise<unknown>> | undefined;
      while ((owned = ownedSignal ? pendingBySignal.get(ownedSignal) : pending)?.size) await Promise.allSettled([...owned]);
    },
  };
  const actual = createActualMobileNeteasePorts({ client, ...identity,
    identityKey32: new Uint8Array(32).fill(31), now: () => now, assertCurrent: async () => {},
    fetch: async () => { throw new Error('本例禁止音频网络。'); },
    artworkFetch: async () => { throw new Error('本例禁止图片网络。'); },
  });
  t.after(async () => { for (const release of releases) release(); await actual.close(); });
  return { actual, state, advance: (ms: number) => { now += ms; },
    async quiet() { await client.awaitMobileQuiet(); await turns(); },
    block() { hold = deferred(); releases.add(hold.resolve); return hold; },
    failNext(error: unknown) { nextFailure = error; },
    invalidate(nextAccountId = '701') {
      const previousProviderEpoch = providerEpoch(); accountId = nextAccountId; epoch++;
      const nextProviderEpoch = providerEpoch();
      for (const listener of listeners) listener({ previousProviderEpoch, nextProviderEpoch });
    } };
}

for (const expired of [false, true]) test(`4.1双设备账号并发：${expired ? 'TTL过期' : '冷启动'}只读取一次共享Provider身份`, async t => {
  const f = accountFixture(t);
  if (expired) { assert.ok(await f.actual.account.current(signal())); f.advance(10_001); }
  const before = f.state.calls, held = f.block();
  const first = f.actual.account.current(signal()), second = f.actual.account.current(signal());
  await turns();
  const started = f.state.calls - before;
  held.resolve();
  const [one, two] = await Promise.all([first, second]);
  assert.ok(one); assert.deepEqual(two, one);
  // 修复前这里应复现2次：缓存只覆盖已完成请求，两个设备同时穿过冷缓存。
  assert.equal(started, 1, '同一Provider代际的并发读取不能重复占用播放优先级SDK槽位。');
  assert.equal(f.state.reads, 0);
});

test('4.1双设备账号取消：一台退出等待不能撤销另一台或污染共享缓存', async t => {
  const f = accountFixture(t), held = f.block(), firstController = new AbortController();
  const first = f.actual.account.current(firstController.signal);
  const second = f.actual.account.current(signal());
  let firstFinished = false, secondFinished = false;
  void first.then(() => { firstFinished = true; }, () => { firstFinished = true; });
  void second.then(() => { secondFinished = true; }, () => { secondFinished = true; });
  const results = Promise.allSettled([first, second]);
  await turns(); firstController.abort(); await turns();
  assert.equal(firstFinished, true, '设备A的取消必须立即结束本地等待，不能拖到B的SDK返回。');
  assert.equal(secondFinished, false, '设备B必须继续等待同一代际的真实身份。');
  assert.equal(f.state.sdkAborted, 0, '还有B订阅时，不能把A的取消传给共享SDK signal。');
  held.resolve();
  const [one, two] = await results;
  assert.equal(one.status, 'rejected'); assert.equal(two.status, 'fulfilled');
  if (two.status !== 'fulfilled') throw new Error('另一设备必须取得真实合成身份。');
  assert.ok(two.value);
  const completedCalls = f.state.calls;
  assert.deepEqual(await f.actual.account.current(signal()), two.value);
  assert.equal(f.state.calls, completedCalls, '取消设备不得清空另一设备已经确认的同代缓存。');
});

test('4.1双设备账号全取消：最后等待者撤回SDK，原物理quiet前不能创建重复flight', async t => {
  const f = accountFixture(t), held = f.block(), firstController = new AbortController(), secondController = new AbortController();
  const first = f.actual.account.current(firstController.signal), second = f.actual.account.current(secondController.signal);
  const cancelled = Promise.allSettled([first, second]);
  let cancelledFinished = false;
  void cancelled.then(() => { cancelledFinished = true; });
  await turns(); assert.equal(f.state.calls, 1);
  firstController.abort(); await turns(); assert.equal(f.state.sdkAborted, 0);
  secondController.abort();
  await turns(); assert.equal(cancelledFinished, true, '两台取消都必须立即结束本地等待，不能把物理quiet转嫁给UI。');
  const oldResults = await cancelled;
  assert.ok(oldResults.every(value => value.status === 'rejected'));
  await turns(); assert.equal(f.state.sdkAborted, 1, '最后等待者退出后必须实际撤回共享SDK等待。');
  const later = Promise.allSettled([f.actual.account.current(signal())]);
  await turns(); assert.equal(f.state.calls, 1, '本地取消已完成仍不等于原SDK物理quiet。');
  held.resolve();
  const [after] = await later;
  assert.ok(after);
  if (after.status === 'rejected') assert.ok(busy(after.reason));
  else assert.ok(after.value);
  await f.quiet();
  assert.ok(await f.actual.account.current(signal()));
  assert.equal(f.state.calls, 2, 'quiet后只新增一轮读取；不能复用全取消的旧响应或复制新flight。');
});

test('4.1双设备账号换代：旧late响应不能回填缓存，新代际读取恢复且两台共用新值', async t => {
  const f = accountFixture(t), held = f.block();
  const oldFirst = f.actual.account.current(signal()), oldSecond = f.actual.account.current(signal());
  const oldResults = Promise.allSettled([oldFirst, oldSecond]);
  await turns(); f.invalidate(); await turns(); held.resolve();
  assert.ok((await oldResults).every(value => value.status === 'rejected'));
  const before = f.state.calls;
  const [one, two] = await Promise.all([f.actual.account.current(signal()), f.actual.account.current(signal())]);
  assert.ok(one); assert.deepEqual(two, one);
  assert.equal(f.state.calls - before, 1, '新代际并发订阅必须独立于旧flight且只发一次SDK。');
  const calls = f.state.calls;
  assert.deepEqual(await f.actual.account.current(signal()), one); assert.equal(f.state.calls, calls);
});

test('4.1双设备账号失败恢复：一轮临时失败不缓存拒绝，下一轮共享真实成功', async t => {
  const f = accountFixture(t), held = f.block(); f.failNext(new MobileServiceError(503, 'BUSY'));
  const failed = Promise.allSettled([f.actual.account.current(signal()), f.actual.account.current(signal())]);
  await turns(); held.resolve();
  assert.ok((await failed).every(value => value.status === 'rejected'));
  const before = f.state.calls;
  const [one, two] = await Promise.all([f.actual.account.current(signal()), f.actual.account.current(signal())]);
  assert.ok(one); assert.deepEqual(two, one);
  assert.equal(f.state.calls - before, 1);
});

function scopeFixture(t: TestContext) {
  const datasetId = randomUUID(), epoch = randomUUID(), serverId = identity.serverId;
  const held = deferred(), entered = deferred();
  const state = { blockDevice: '', ownerDevices: [] as string[], invalidatedDevices: [] as string[] };
  const owner: DatasetOwnerEndpoint = {
    async prepare() { return { datasetId, epoch }; },
    async mobileMain(input) {
      if (input.kind !== 'content') throw new Error('本例不打开媒体源或认证文件。');
      if (input.request.action === 'initialize') return { kind: 'content-initialized', datasetId, ownerEpoch: epoch, serverId };
      if (input.request.action === 'updateScope') {
        state.ownerDevices.push(input.request.scope.deviceId);
        if (input.request.scope.deviceId === state.blockDevice) { entered.resolve(); await held.promise; }
        return { kind: 'content-scope-updated', datasetId, ownerEpoch: epoch, scope: input.request.scope };
      }
      if (input.request.action === 'invalidateScope' && input.request.kind === 'device') {
        state.invalidatedDevices.push(input.request.deviceId);
        return { kind: 'content-scope-invalidated', datasetId, ownerEpoch: epoch, scopeKind: 'device' };
      }
      throw new Error('本例只核Scope登记与撤销。');
    },
    async dispatch() { throw new Error('本例不派发数据库命令。'); }, async commitBoot() {}, async close() {},
  };
  const offline: NeteaseMobileReadPort = { configured: false,
    async mobileAccount() { throw new Error('未配置Provider不得访问SDK。'); },
    async mobileRead() { throw new Error('未配置Provider不得读取素材。'); },
    onMobileAccountInvalidated: () => () => {}, async awaitMobileQuiet() {} };
  const runtime = createMobileContentRuntime({ owner, netease: offline, assertCurrent() {} });
  const base = () => ({ type: 'mobile-content-core-request' as const, id: randomUUID() });
  const scope = (deviceId: string, accessGeneration = 1): Extract<MobileContentCoreRequest, { action: 'scope' }> => ({
    ...base(), action: 'scope', principal: { serverId, datasetId, deviceId, deviceEpoch: 1, accessGeneration },
  });
  t.after(async () => { held.resolve(); await runtime.close(); });
  return { runtime, state, held, entered, scope, base, datasetId, serverId,
    initialize: () => runtime.request({ ...base(), action: 'initialize', serverId, datasetId,
      key: new Uint8Array(32).fill(19) }, signal()) };
}
function scopeResponse(response: MobileContentCoreResponse) {
  assert.ok(response.action === 'scope' && response.kind === 'scope'); return response.scope;
}

test('4.1双设备Scope：刷新和撤销第一台后第二台仍能取得当前Scope', async t => {
  const f = scopeFixture(t); await f.initialize();
  const first = scopeResponse(await f.runtime.request(f.scope('device.first.synthetic'), signal()));
  const second = scopeResponse(await f.runtime.request(f.scope('device.second.synthetic'), signal()));
  const refreshed = scopeResponse(await f.runtime.request(f.scope(first.deviceId, 2), signal()));
  assert.equal(refreshed.accessGeneration, 2);
  assert.deepEqual(scopeResponse(await f.runtime.request(f.scope(second.deviceId), signal())), second);
  const revoked = await f.runtime.request({ ...f.base(), action: 'invalidate-device', serverId: f.serverId,
    datasetId: f.datasetId, deviceId: first.deviceId, deviceEpoch: first.deviceEpoch }, signal());
  assert.ok('ok' in revoked && revoked.ok);
  assert.deepEqual(f.state.invalidatedDevices, [first.deviceId]);
  assert.deepEqual(scopeResponse(await f.runtime.request(f.scope(second.deviceId), signal())), second);
});

test('4.1双设备Scope队头行为：已发Owner工作未静止时第二台排队，取消排队目标不取消其他设备', async t => {
  const f = scopeFixture(t); await f.initialize(); f.state.blockDevice = 'device.owner-held.synthetic';
  const first = f.runtime.request(f.scope(f.state.blockDevice), signal()); await f.entered.promise;
  const queued = f.scope('device.withdrawn.synthetic'), controller = new AbortController();
  const withdrawn = f.runtime.request(queued, controller.signal);
  let nextFinished = false;
  const next = f.runtime.request(f.scope('device.other.synthetic'), signal()).then(value => { nextFinished = true; return value; });
  await turns();
  assert.equal(nextFinished, false, '现有serialScope是全局队列；此处仅刻画队头阻塞，不冒充已修复或真实超时。');
  assert.deepEqual(f.state.ownerDevices, [f.state.blockDevice]);
  controller.abort();
  const failed = await withdrawn; assert.ok('kind' in failed && failed.kind === 'error');
  const cancelled = await f.runtime.request({ ...f.base(), action: 'cancel', requestId: queued.id, snapshotId: null, scope: null }, signal());
  assert.ok(cancelled.action === 'cancel' && cancelled.kind === 'cancelled' && cancelled.quiet);
  f.held.resolve(); scopeResponse(await first); scopeResponse(await next);
  assert.deepEqual(f.state.ownerDevices, [f.state.blockDevice, 'device.other.synthetic']);
});

function authFixture(t: TestContext) {
  const key = randomBytes(32), aad = (revision: number) => Buffer.from(JSON.stringify([
    'MBM001_AUTH_STATE_V1', identity.serverId, identity.datasetId, revision,
  ]));
  const crypto: MobileAuthCrypto = {
    seal(plain, associated) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(associated);
      const body = Buffer.concat([cipher.update(plain), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    open(sealed, associated) {
      const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12)); decipher.setAAD(associated);
      decipher.setAuthTag(sealed.subarray(12, 28));
      return Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]);
    },
  };
  let stored: MobileSealedState = { kind: 'missing', datasetId: identity.datasetId, revision: 0 }, now = START;
  const state = { saves: 0 };
  const persistence: MobileAuthPersistence = {
    async load() { return stored.kind === 'missing' ? { ...stored } : { ...stored, sealed: new Uint8Array(stored.sealed) }; },
    async save(request) {
      if (stored.revision !== request.expectedRevision) return { kind: 'conflict', datasetId: identity.datasetId, currentRevision: stored.revision };
      stored = { kind: 'sealed', datasetId: identity.datasetId, revision: request.expectedRevision + 1,
        commitId: request.commitId, sealed: new Uint8Array(request.sealed) }; state.saves++;
      return { kind: 'saved', datasetId: stored.datasetId, revision: stored.revision, commitId: stored.commitId };
    },
  };
  const auth = createMobileAuthService({ persistence, crypto, serverId: identity.serverId, datasetId: identity.datasetId,
    displayName: '合成双设备', environment: 'development', now: () => now });
  t.after(async () => { await auth.close(); key.fill(0); });
  async function pair(installationId: string) {
    const permit = await auth.issuePairing();
    return auth.claim({ pairingSecret: permit.pairingSecret, installationId, deviceName: installationId }, `pair.${installationId}`);
  }
  return { auth, pair, state, advance: (ms: number) => { now += ms; },
    populateHistoricalReceipts() {
      assert.equal(stored.kind, 'sealed'); if (stored.kind !== 'sealed') throw new Error('合成状态尚未持久化。');
      const opened = crypto.open(stored.sealed, aad(stored.revision));
      const plain = JSON.parse(Buffer.from(opened).toString('utf8')) as {
        clockFloor: number; devices: Record<string, unknown>[]; receipts: Record<string, unknown>[];
      };
      opened.fill(0);
      const originals = plain.receipts.filter(receipt => receipt.operation === 'refreshToken'); assert.equal(originals.length, 2);
      const digest = (label: string) => createHash('sha256').update(label).digest('hex');
      function receipt(index: number): Record<string, unknown> {
        const original = originals[index % 2]!, pair = original.tokenPair as Record<string, unknown>;
        const at = START + (Math.floor(index / 2) + 1) * 15 * 60_000;
        return { ...original, generation: Math.floor(index / 2) + 2, issuedAt: new Date(at).toISOString(),
          commitId: `synthetic.commit.${String(index).padStart(6, '0')}`,
          originHash: digest(`synthetic.origin.${index}`), keyHash: digest(`synthetic.key.${index}`),
          fingerprint: digest(`synthetic.body.${index}`), tokenPair: { ...pair,
            accessToken: digest(`synthetic.access.${index}`).slice(0, 32),
            refreshToken: digest(`synthetic.refresh.${index}`).slice(0, 32),
            accessExpiresAt: new Date(at + 15 * 60_000).toISOString(),
            refreshExpiresAt: new Date(at + 30 * 24 * 60 * 60_000).toISOString() } };
      }
      // 先用等长行估算，再精确靠近2MiB；不做4096次保存，也不制造超过冷核字节上限的坏密文。
      plain.receipts = [];
      const baseBytes = Buffer.byteLength(JSON.stringify(plain)), rowBytes = Buffer.byteLength(JSON.stringify(receipt(2000))) + 1;
      const estimate = Math.min(MOBILE_AUTH_MAX_RECEIPTS, Math.floor((MOBILE_AUTH_STATE_MAX_BYTES - baseBytes - 512) / rowBytes));
      plain.receipts = Array.from({ length: estimate }, (_, index) => receipt(index));
      const at = START + (Math.ceil(estimate / 2) + 2) * 15 * 60_000;
      now = at; plain.clockFloor = at;
      for (const device of plain.devices) {
        device.generation = estimate + 3; device.issuedAt = new Date(at).toISOString();
        device.accessExpiresAt = new Date(at + 15 * 60_000).toISOString();
        device.refreshExpiresAt = new Date(at + 30 * 24 * 60 * 60_000).toISOString();
      }
      while (Buffer.byteLength(JSON.stringify(plain)) > MOBILE_AUTH_STATE_MAX_BYTES) plain.receipts.pop();
      while (plain.receipts.length < MOBILE_AUTH_MAX_RECEIPTS) {
        plain.receipts.push(receipt(plain.receipts.length));
        if (Buffer.byteLength(JSON.stringify(plain)) > MOBILE_AUTH_STATE_MAX_BYTES) { plain.receipts.pop(); break; }
      }
      const latest = START + (Math.ceil(plain.receipts.length / 2) + 2) * 15 * 60_000;
      now = latest; plain.clockFloor = latest;
      for (const device of plain.devices) {
        device.generation = Math.ceil(plain.receipts.length / 2) + 2;
        device.issuedAt = new Date(latest).toISOString();
        device.accessExpiresAt = new Date(latest + 15 * 60_000).toISOString();
        device.refreshExpiresAt = new Date(latest + 30 * 24 * 60 * 60_000).toISOString();
      }
      const bytes = Buffer.from(JSON.stringify(plain));
      try { stored = { ...stored, sealed: crypto.seal(bytes, aad(stored.revision)) }; } finally { bytes.fill(0); }
      return { count: plain.receipts.length, byteLength: Buffer.byteLength(JSON.stringify(plain)) };
    } };
}

test('4.1双设备认证：相同刷新key跨设备隔离，刷新及退出不能废掉另一设备token', async t => {
  const f = authFixture(t), one = await f.pair('installation.first'), two = await f.pair('installation.second');
  const oldOne = await f.auth.authenticate(one.accessToken), oldTwo = await f.auth.authenticate(two.accessToken);
  const first = await f.auth.refresh({ refreshToken: one.refreshToken }, 'same.refresh.key');
  await assert.rejects(f.auth.assertCurrent(oldOne), denied); await f.auth.assertCurrent(oldTwo);
  const second = await f.auth.refresh({ refreshToken: two.refreshToken }, 'same.refresh.key');
  assert.equal(first.deviceId, one.deviceId); assert.equal(second.deviceId, two.deviceId);
  assert.notEqual(first.accessToken, second.accessToken);
  await f.auth.logout(await f.auth.authenticate(first.accessToken));
  const currentTwo = await f.auth.authenticate(second.accessToken); await f.auth.assertCurrent(currentTwo);
  await f.auth.assertDeviceCurrent(second.deviceId, 1);
});

test('4.1双设备长期容量复现：30天历史先占满2MiB字节预算，两台正常refresh都返回BUSY', async t => {
  const f = authFixture(t), one = await f.pair('installation.first'), two = await f.pair('installation.second');
  const first = await f.auth.refresh({ refreshToken: one.refreshToken }, 'first.rotate');
  const second = await f.auth.refresh({ refreshToken: two.refreshToken }, 'second.rotate');
  const history = f.populateHistoricalReceipts();
  assert.ok(history.count < MOBILE_AUTH_MAX_RECEIPTS, '默认token回执在4096条数上限前先受到2MiB预算限制。');
  assert.ok(history.byteLength <= MOBILE_AUTH_STATE_MAX_BYTES);
  assert.ok(history.count * 15 * 60_000 / 2 < 30 * 24 * 60 * 60_000,
    '两台每15分钟刷新，旧记录仍未达到30天清理期。');
  f.advance(15 * 60_000 + 1);
  const saves = f.state.saves;
  await assert.rejects(f.auth.refresh({ refreshToken: first.refreshToken }, 'first.next'), busy);
  await assert.rejects(f.auth.refresh({ refreshToken: second.refreshToken }, 'second.next'), busy);
  assert.equal(f.state.saves, saves, '容量拒绝必须保持原持久状态，不能偷偷重签或补写。');
  await assert.rejects(f.auth.authenticate(first.accessToken), denied);
  await assert.rejects(f.auth.authenticate(second.accessToken), denied);
  assert.ok(await f.auth.serverInfo(), '这是可读取的合法满容量状态，不是密文校验fatal。');
});
