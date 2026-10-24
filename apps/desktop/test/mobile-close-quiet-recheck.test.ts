import assert from 'node:assert/strict';
import test from 'node:test';
import { createMainMobileContentPort } from '../src/main/mobile-content-port.js';
import { createMobileContentRpcPort } from '../../../packages/bridge-core/src/mobile/content-rpc-port.js';
import { mobileContentRpcFailure, type MobileContentCoreRequest, type MobileContentCoreResponse } from '../../../packages/bridge-core/src/mobile/content-rpc.js';
import { MobileAuthPersistenceError, MobileServiceError } from '../../../packages/bridge-core/src/mobile/types.js';

const SERVER = 'quiet.recheck.synthetic', DATASET = '50000000-0000-4000-8000-000000000032';
const principal = { serverId: SERVER, datasetId: DATASET, deviceId: 'quiet.recheck.device', deviceEpoch: 1, accessGeneration: 1 };
const signal = () => new AbortController().signal;
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const unknown = (error: unknown) => error instanceof MobileServiceError && error.code === 'BUSY'
  && Object.getOwnPropertyDescriptor(error, 'outcome')?.value === 'unknown';

test('关闭复核：首取消结果未知后，仅真实Core对同目标的quiet ACK可闭合，不重放业务', async t => {
  const calls: MobileContentCoreRequest[] = [], entered = deferred(), release = deferred();
  let businessCalls = 0, cancelCalls = 0;
  const core = createMobileContentRpcPort({ initialize: async () => {}, invalidateDevice: async () => {},
    resolveScope: async () => { businessCalls++; throw new MobileAuthPersistenceError('unknown'); },
    assertScope: () => {}, source: async () => { throw new Error('本例不读取媒体。'); },
    content: { dispatch: async () => { throw new Error('本例不发送业务内容。'); } } });
  const port = createMainMobileContentPort({ serverId: SERVER, datasetId: DATASET, key: new Uint8Array(32).fill(7),
    assertCurrent() {}, requestRpc: async (request, owned) => {
      calls.push(request);
      if (request.action === 'cancel') {
        cancelCalls++;
        // 首次控制回应不确定，不能推断Core已静止，也不能永久缓存成关闭必败。
        if (cancelCalls === 1) return mobileContentRpcFailure(request, new MobileAuthPersistenceError('unknown'));
        entered.resolve(); await release.promise;
      }
      return core.request(request, owned);
    } });
  t.after(async () => { release.resolve(); await core.close(); });
  await assert.rejects(port.scopeForIdentity(principal, signal()), unknown);
  await turn();
  let settled = false;
  const first = port.close(), outcome = first.then(() => { settled = true; return 'quiet'; }, () => { settled = true; return 'failed'; });
  assert.equal(port.close(), first);
  await turn(); await turn();
  assert.equal(cancelCalls, 2, '关闭只对原取消目标复核一次，不永久重抛历史失败。');
  await entered.promise;
  assert.equal(settled, false, '没有真实ACK时不能授quiet。');
  release.resolve();
  assert.equal(await outcome, 'quiet');
  assert.equal(businessCalls, 1);
  assert.deepEqual(calls.map(value => value.action), ['initialize', 'scope', 'cancel', 'cancel']);
  const cancellations = calls.filter((value): value is Extract<MobileContentCoreRequest, { action: 'cancel' }> => value.action === 'cancel');
  assert.equal(cancellations[0]!.requestId, cancellations[1]!.requestId);
  assert.equal(cancellations[0]!.snapshotId, cancellations[1]!.snapshotId);
  assert.deepEqual(cancellations[0]!.scope, cancellations[1]!.scope);
  assert.notEqual(cancellations[0]!.id, cancellations[1]!.id);
});

test('关闭复核：持续未知或错绑定的ACK仍失败，不循环重试、不改原业务结果', async t => {
  for (const mode of ['unknown', 'wrong-target'] as const) await t.test(mode, async () => {
    const calls: MobileContentCoreRequest[] = [];
    let cancelCalls = 0;
    const port = createMainMobileContentPort({ serverId: SERVER, datasetId: DATASET, key: new Uint8Array(32).fill(8),
      assertCurrent() {}, requestRpc: async request => {
        calls.push(request);
        if (request.action === 'initialize') return { type: 'mobile-content-core-response', id: request.id, action: 'initialize', ok: true };
        if (request.action === 'scope') return mobileContentRpcFailure(request, new MobileAuthPersistenceError('unknown'));
        if (request.action !== 'cancel') throw new Error('本例不发送业务内容。');
        cancelCalls++;
        if (mode === 'unknown' || cancelCalls === 1) return mobileContentRpcFailure(request, new MobileAuthPersistenceError('unknown'));
        return { type: 'mobile-content-core-response', id: request.id, action: 'cancel', kind: 'cancelled',
          requestId: 'wrong.target', snapshotId: request.snapshotId, quiet: true } as MobileContentCoreResponse;
      } });
    await assert.rejects(port.scopeForIdentity(principal, signal()), unknown); await turn();
    const closing = port.close(); await assert.rejects(closing); assert.equal(port.close(), closing);
    assert.equal(cancelCalls, 2);
    assert.equal(calls.filter(value => value.action === 'scope').length, 1);
  });
});

test('关闭复核：真实Core的原scope仍在途时不提前授quiet，原flight结束后才确认', async t => {
  const release = deferred(), firstCancelReturned = deferred(), recheckEntered = deferred();
  let businessCalls = 0, cancelCalls = 0;
  const scope = { ...principal, ownerEpoch: 'quiet.owner', accountDomain: `local:${DATASET}`, providerEpoch: null };
  const core = createMobileContentRpcPort({ requestMs: 50, initialize: async () => {}, invalidateDevice: async () => {},
    resolveScope: async () => { businessCalls++; await release.promise; return scope; },
    assertScope: () => {}, source: async () => { throw new Error('本例不读取媒体。'); },
    content: { dispatch: async () => { throw new Error('本例不发送业务内容。'); } } });
  const port = createMainMobileContentPort({ serverId: SERVER, datasetId: DATASET, key: new Uint8Array(32).fill(9),
    requestMs: 1000, assertCurrent() {}, requestRpc: async (request, owned) => {
      let ordinal = 0;
      if (request.action === 'cancel') {
        ordinal = ++cancelCalls;
        if (ordinal === 2) recheckEntered.resolve();
      }
      const response = await core.request(request, owned);
      if (ordinal === 1) firstCancelReturned.resolve();
      return response;
    } });
  t.after(async () => { release.resolve(); await core.close(); });
  await assert.rejects(port.scopeForIdentity(principal, signal()), unknown);
  await firstCancelReturned.promise; await turn();
  let settled = false;
  const closing = port.close(), outcome = closing.then(() => { settled = true; return 'quiet'; }, () => { settled = true; return 'failed'; });
  await recheckEntered.promise;
  await turn();
  assert.equal(settled, false);
  assert.equal(businessCalls, 1);
  release.resolve();
  assert.equal(await outcome, 'quiet');
  assert.equal(cancelCalls, 2);
});

test('关闭复核：原close期限已失败后，迟到原flight不得再发新的控制请求', async t => {
  const release = deferred(); let cancels = 0;
  const port = createMainMobileContentPort({ serverId: SERVER, datasetId: DATASET, key: new Uint8Array(32).fill(10),
    requestMs: 10, closeMs: 10, assertCurrent() {}, requestRpc: async request => {
      if (request.action === 'initialize') return { type: 'mobile-content-core-response', id: request.id, action: 'initialize', ok: true };
      if (request.action === 'scope') await release.promise;
      if (request.action === 'cancel') cancels++;
      return mobileContentRpcFailure(request, new MobileAuthPersistenceError('unknown'));
    } });
  t.after(() => release.resolve());
  await assert.rejects(port.scopeForIdentity(principal, signal()), unknown);
  const closing = port.close(); await assert.rejects(closing);
  assert.equal(cancels, 1);
  release.resolve(); await turn(); await turn();
  assert.equal(cancels, 1, '原期限失败后不得因迟到flight再派生控制请求。');
  assert.equal(port.close(), closing);
});

test('关闭复核：事件循环阻塞使timer迟到时，超过原绝对期限的ACK仍拒绝', async () => {
  let cancels = 0;
  const port = createMainMobileContentPort({ serverId: SERVER, datasetId: DATASET, key: new Uint8Array(32).fill(11),
    requestMs: 1000, closeMs: 5, assertCurrent() {}, requestRpc: async request => {
      if (request.action === 'initialize') return { type: 'mobile-content-core-response', id: request.id, action: 'initialize', ok: true };
      if (request.action === 'scope') return mobileContentRpcFailure(request, new MobileAuthPersistenceError('unknown'));
      if (request.action !== 'cancel') throw new Error('本例不发送其它请求。');
      if (++cancels === 1) return mobileContentRpcFailure(request, new MobileAuthPersistenceError('unknown'));
      // 合成不可抢占的同步工作，保证Promise微任务先于已到期的timer执行。
      const end = performance.now() + 20; while (performance.now() < end) { /* 仅此受控期限反例使用。 */ }
      return { type: 'mobile-content-core-response', id: request.id, action: 'cancel', kind: 'cancelled',
        requestId: request.requestId, snapshotId: request.snapshotId, quiet: true };
    } });
  await assert.rejects(port.scopeForIdentity(principal, signal()), unknown); await turn();
  const closing = port.close();
  await assert.rejects(closing, error => error instanceof MobileAuthPersistenceError && error.outcome === 'unknown');
  assert.equal(port.close(), closing); assert.equal(cancels, 2);
});
