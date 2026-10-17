import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { DatasetOwnerEndpoint } from '../../src/collection/dataset-owner-protocol.js';
import type { NeteaseMobileReadPort } from '../../src/netease/types.js';
import { createMobileContentRuntime } from '../../src/mobile/content-runtime.js';
import { MobileContentPersistenceError } from '../../src/mobile/content-owner-store.js';
import { MobileServiceError } from '../../src/mobile/types.js';
import type { MobileContentCoreResponse } from '../../src/mobile/content-rpc.js';
import { mobileCapabilityRequestSha, snapshotMobileCapabilityTrace } from '../../src/mobile/capability-trace.js';

// 真实runtime/RPC/账号适配器；Owner与账号SDK是有限合成端口，不访问DB、Provider或HTTP。
function fixture(t: TestContext, options: {
  initializeOwner?: () => Promise<void>;
  account?: NeteaseMobileReadPort['mobileAccount'];
  release?(): void;
} = {}) {
  const datasetId = randomUUID(), epoch = randomUUID(), serverId = 'capability.synthetic.server';
  const key = new Uint8Array(32).fill(7);
  const calls = { prepare: 0, initialize: 0, update: 0, account: 0, read: 0, quiet: 0 };
  const owner: DatasetOwnerEndpoint = {
    async prepare() { calls.prepare++; return { datasetId, epoch }; },
    async mobileMain(request) {
      assert.equal(request.kind, 'content'); assert.equal(request.datasetId, datasetId);
      if (request.kind !== 'content') throw new Error('本例不应读取媒体或其他Owner域。');
      if (request.request.action === 'initialize') {
        calls.initialize++; assert.equal(request.request.serverId, serverId);
        assert.equal(request.request.datasetId, datasetId);
        await options.initializeOwner?.();
        return { kind: 'content-initialized', serverId, datasetId, ownerEpoch: epoch };
      }
      if (request.request.action === 'updateScope') calls.update++;
      throw new Error('早拒前不应调用Owner更新或内容读取。');
    },
    async dispatch() { throw new Error('本例不应派发普通命令。'); },
    async commitBoot() {}, async close() {},
  };
  const netease: NeteaseMobileReadPort = {
    configured: options.account !== undefined,
    async mobileAccount(input) {
      calls.account++;
      if (!options.account) throw new MobileServiceError(401, 'UNAUTHORIZED');
      return options.account(input);
    },
    async mobileRead() { calls.read++; throw new Error('本例不应发送Provider请求。'); },
    onMobileAccountInvalidated: () => () => undefined,
    async awaitMobileQuiet() { calls.quiet++; },
  };
  const runtime = createMobileContentRuntime({ owner, netease, assertCurrent() {} });
  t.after(async () => {
    options.release?.();
    try { await runtime.close(); } finally { key.fill(0); }
  });
  const initialize = (id = randomUUID()) => runtime.request({ type: 'mobile-content-core-request', id,
    action: 'initialize', serverId, datasetId, key: new Uint8Array(key) }, new AbortController().signal);
  return { runtime, initialize, calls, serverId, datasetId };
}
function failed(response: MobileContentCoreResponse, id: string, action: 'initialize' | 'scope', outcome: 'not-sent' | null) {
  assert.deepEqual(response, { type: 'mobile-content-core-response', id, action,
    kind: 'error', status: 503, code: 'BUSY', retryable: false, outcome });
}
function rows(id: string) {
  const sha = mobileCapabilityRequestSha('content', id); assert.ok(sha);
  const snapshot = snapshotMobileCapabilityTrace();
  return { sha, records: snapshot.records.filter(row => row.component === 'core' && row.requestSha256 === sha),
    first: snapshot.firstBusinessFailures.filter(row => row.component === 'core' && row.requestSha256 === sha),
    cleanup: snapshot.cleanupFailures.filter(row => row.component === 'core' && row.requestSha256 === sha) };
}

test('MBM能力诊断：Core初始化原拒绝缓存复用pending和rejected且不重发', async t => {
  let entered!: () => void, release!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const original = new MobileContentPersistenceError('not-sent');
  const f = fixture(t, { release, async initializeOwner() { entered(); await held; throw original; } });
  const firstId = randomUUID(), pendingId = randomUUID(), rejectedId = randomUUID();
  const first = f.initialize(firstId); await enteredPromise;
  const pending = f.initialize(pendingId);
  // 原第二次execute已排入微任务；只推进该队列，不等待真实计时器或调大期限。
  await Promise.resolve();
  assert.ok(rows(pendingId).records.some(row => row.stage === 'core.rpc.initialize.cache'
    && row.initState === 'reuse-pending' && row.relatedSha256 === rows(firstId).sha));
  release();
  failed(await first, firstId, 'initialize', 'not-sent');
  failed(await pending, pendingId, 'initialize', 'not-sent');
  failed(await f.initialize(rejectedId), rejectedId, 'initialize', 'not-sent');
  assert.deepEqual(f.calls, { prepare: 1, initialize: 1, update: 0, account: 0, read: 0, quiet: 0 });
  const firstTrace = rows(firstId), rejectedTrace = rows(rejectedId);
  for (const state of ['new-pending', 'rejected']) assert.ok(firstTrace.records.some(row =>
    row.stage === 'core.rpc.initialize.cache' && row.initState === state && row.relatedSha256 === firstTrace.sha));
  assert.equal(firstTrace.first.length, 1);
  assert.equal(firstTrace.first[0]!.stage, 'core.initialize.owner.initialize');
  assert.equal(firstTrace.first[0]!.code, 'BUSY'); assert.equal(firstTrace.first[0]!.outcome, 'not-sent');
  assert.equal(firstTrace.first[0]!.aborted, false);
  assert.ok(rejectedTrace.records.some(row => row.stage === 'core.rpc.initialize.cache'
    && row.initState === 'reuse-rejected' && row.relatedSha256 === firstTrace.sha));
  for (const id of [pendingId, rejectedId]) {
    const trace = rows(id);
    assert.equal(trace.records.some(row => row.stage.startsWith('core.initialize.')), false);
    assert.equal(trace.first.length, 1); assert.equal(trace.first[0]!.stage, 'core.rpc.initialize.wait');
    assert.equal(trace.cleanup.length, 0);
  }
  await f.runtime.close();
  assert.deepEqual(f.calls, { prepare: 1, initialize: 1, update: 0, account: 0, read: 0, quiet: 0 });
});

test('MBM能力诊断：首次scope账号早拒保原阶段且不调用Owner更新与后续资格', async t => {
  const original = new MobileServiceError(503, 'BUSY');
  const f = fixture(t, { async account() { throw original; } });
  const firstId = randomUUID(), reusedId = randomUUID(), scopeId = randomUUID();
  assert.deepEqual(await f.initialize(firstId), { type: 'mobile-content-core-response', id: firstId, action: 'initialize', ok: true });
  assert.deepEqual(await f.initialize(reusedId), { type: 'mobile-content-core-response', id: reusedId, action: 'initialize', ok: true });
  const reused = rows(reusedId);
  assert.ok(reused.records.some(row => row.stage === 'core.rpc.initialize.cache'
    && row.initState === 'reuse-fulfilled' && row.relatedSha256 === rows(firstId).sha));
  const response = await f.runtime.request({ type: 'mobile-content-core-request', id: scopeId, action: 'scope',
    principal: { serverId: f.serverId, datasetId: f.datasetId, deviceId: 'capability.synthetic.device',
      deviceEpoch: 1, accessGeneration: 1 } }, new AbortController().signal);
  failed(response, scopeId, 'scope', null);
  assert.deepEqual(f.calls, { prepare: 1, initialize: 1, update: 0, account: 1, read: 0, quiet: 0 });
  const trace = rows(scopeId);
  assert.equal(trace.first.length, 1); assert.equal(trace.first[0]!.stage, 'core.scope.account.first');
  assert.equal(trace.first[0]!.code, 'BUSY'); assert.equal(trace.first[0]!.aborted, false);
  assert.ok(trace.records.some(row => row.stage === 'core.scope.provider-tail' && row.phase === 'ok'));
  assert.ok(trace.records.some(row => row.stage === 'core.rpc.scope.resolve' && row.phase === 'reject'));
  assert.equal(trace.records.some(row => ['core.scope.queue', 'core.scope.account.second', 'core.scope.owner.update',
    'core.scope.assert', 'core.assert.account', 'core.rpc.scope.assert.before', 'core.rpc.scope.qualified',
    'core.rpc.scope.assert.after'].includes(row.stage)), false);
  assert.equal(trace.cleanup.length, 0);
  await f.runtime.close();
  assert.deepEqual(f.calls, { prepare: 1, initialize: 1, update: 0, account: 1, read: 0, quiet: 1 });
});
