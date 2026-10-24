import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { decodeMobileRequest } from '@music-bridge/contracts';
import { createMainMobileContentPort } from '../src/main/mobile-content-port.js';
import { createMobileBackend } from '../src/main/mobile-backend.js';
import { mobileContentRpcFailure, type MobileContentCoreRequest, type MobileContentCoreResponse } from '../../../packages/bridge-core/src/mobile/content-rpc.js';
import { createMobileCapabilityContext, closeMobileCapabilityContext, selectMobileCapabilityTraceBranch,
  snapshotMobileCapabilityTrace, withMobileCapabilityContext } from '../../../packages/bridge-core/src/mobile/capability-trace.js';
import { isMobileOwnerPrivateResult } from '../../../packages/bridge-core/src/mobile/owner-protocol.js';
import { MobileAuthPersistenceError, MobileServiceError, type MobileOwnerPrivateRequest,
  type MobileOwnerPrivateResult, type MobileSealedState } from '../../../packages/bridge-core/src/mobile/types.js';

const DATASET = '50000000-0000-4000-8000-000000000032', SERVER = 'close.diagnostic.synthetic', ORIGIN = 'https://127.0.0.1:9443';
const signal = () => new AbortController().signal;
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function turns() { for (let index = 0; index < 4; index++) await turn(); }
function context() {
  const lines: string[] = [], value = createMobileCapabilityContext(randomUUID(), 'main', 'http', null, signal(), line => lines.push(line)); assert.ok(value);
  return { value, lines, rows: () => selectMobileCapabilityTraceBranch(snapshotMobileCapabilityTrace(), value.requestSha256) };
}
function assertUnknown(error: unknown) {
  assert.ok(error instanceof MobileServiceError); assert.equal(error.status, 503); assert.equal(error.code, 'BUSY');
  assert.equal(Object.getOwnPropertyDescriptor(error, 'outcome')?.value, 'unknown'); return true;
}
function controlledRpc() {
  const calls: MobileContentCoreRequest[] = [];
  const requestRpc = async (request: MobileContentCoreRequest): Promise<MobileContentCoreResponse> => {
    calls.push(request);
    if (request.action === 'initialize') return { type: 'mobile-content-core-response', id: request.id, action: 'initialize', ok: true };
    if (request.action === 'scope' || request.action === 'cancel') return mobileContentRpcFailure(request, new MobileAuthPersistenceError('unknown'));
    throw new Error('本例不执行内容、Source或网络请求。');
  };
  return { calls, requestRpc };
}

test('关闭诊断：真实port保留cleanup UNKNOWN及同closeFlight，开关只控制关联与旁注', async t => {
  for (const enabled of [false, true]) await t.test(String(enabled), async child => {
    const trace = context(), transport = controlledRpc();
    const port = createMainMobileContentPort({ serverId: SERVER, datasetId: DATASET, key: new Uint8Array(32).fill(3),
      privateCloseDiagnostics: enabled, assertCurrent() {}, requestRpc: transport.requestRpc });
    child.after(() => closeMobileCapabilityContext(trace.value));
    await assert.rejects(withMobileCapabilityContext(trace.value, () => port.scopeForIdentity({ serverId: SERVER, datasetId: DATASET,
      deviceId: 'close.synthetic.device', deviceEpoch: 1, accessGeneration: 1 }, signal())), assertUnknown);
    await turns();
    assert.equal(port.getCloseDiagnosticContext(), enabled ? trace.value : undefined);
    // 原HTTP已结束，cleanup角色仍能沿原关联观察；不重新认证或触发第二次scope。
    closeMobileCapabilityContext(trace.value);
    const first = withMobileCapabilityContext(port.getCloseDiagnosticContext(), () => port.close());
    assert.equal(port.close(), first);
    let failure: unknown; try { await first; } catch (error) { failure = error; }
    assertUnknown(failure); await assert.rejects(port.close(), error => error === failure);
    assert.deepEqual(transport.calls.map(request => request.action), ['initialize', 'scope', 'cancel', 'cancel']);
    const rows = trace.rows().filter(row => row.stage.startsWith('main.close.'));
    if (!enabled) assert.deepEqual(rows, []);
    else {
      const failed = rows.find(row => row.stage === 'main.close.content.cleanup' && row.phase === 'reject'); assert.ok(failed);
      assert.equal(failed.role, 'cleanup'); assert.equal(failed.code, 'BUSY'); assert.equal(failed.name, 'UNKNOWN'); assert.equal(failed.outcome, 'unknown');
      assert.ok(rows.some(row => row.stage === 'main.close.content.cleanup' && row.phase === 'begin'));
      assert.equal(rows.some(row => row.stage === 'main.close.content.deadline'), false, '立即拒绝不能伪报期限耗尽。');
    }
    assert.doesNotMatch(trace.lines.join(''), /message|stack|Bearer|pairingSecret|accessToken|\/private\//u);
  });
});

test('关闭诊断：原在途cancel未落定保active和原生deadline，迟到quiet不重写原拒绝Promise', async t => {
  const trace = context();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const calls: MobileContentCoreRequest[] = [];
  const port = createMainMobileContentPort({ serverId: SERVER, datasetId: DATASET, key: new Uint8Array(32).fill(4), privateCloseDiagnostics: true,
    requestMs: 10_000, closeMs: 20, assertCurrent() {}, requestRpc: async request => {
      calls.push(request);
      if (request.action === 'initialize') return { type: 'mobile-content-core-response', id: request.id, action: 'initialize', ok: true };
      if (request.action === 'scope') return mobileContentRpcFailure(request, new MobileAuthPersistenceError('unknown'));
      if (request.action === 'cancel') { await held; return { type: 'mobile-content-core-response', id: request.id, action: 'cancel',
        kind: 'cancelled', requestId: request.requestId, snapshotId: request.snapshotId, quiet: true }; }
      throw new Error('本例不读取来源。');
    } });
  t.after(async () => { release(); await turns(); closeMobileCapabilityContext(trace.value); });
  await assert.rejects(withMobileCapabilityContext(trace.value, () => port.scopeForIdentity({ serverId: SERVER, datasetId: DATASET,
    deviceId: 'close.synthetic.device', deviceEpoch: 1, accessGeneration: 1 }, signal())), assertUnknown);
  await turns();
  const first = withMobileCapabilityContext(port.getCloseDiagnosticContext(), () => port.close());
  const rejected = assert.rejects(first, error => error instanceof MobileAuthPersistenceError && error.outcome === 'unknown');
  await turns();
  assert.ok(trace.rows().some(row => row.stage === 'main.close.content.active' && row.phase === 'begin'));
  // 原生timer保留真实ALS调度；不让MockTimers.tick的人造上下文替代生产回调。
  await rejected;
  const deadline = trace.rows().find(row => row.stage === 'main.close.content.deadline' && row.phase === 'reject'); assert.ok(deadline);
  assert.equal(deadline.role, 'cleanup'); assert.equal(deadline.outcome, 'unknown'); assert.equal(deadline.name, 'UNKNOWN'); assert.equal(deadline.code, 'UNKNOWN');
  assert.equal(port.close(), first);
  release(); await turns();
  await assert.rejects(port.close(), error => error instanceof MobileAuthPersistenceError && error.outcome === 'unknown');
  assert.equal(calls.filter(request => request.action === 'cancel').length, 1);
});

test('关闭诊断：真实backend五子阶段顺序可见，AggregateError与后续close失败保持原义', async t => {
  for (const enabled of [false, true]) await t.test(String(enabled), async child => {
    const trace = context(), transport = controlledRpc(), authKey = new Uint8Array(32).fill(5);
    let stored: MobileSealedState = { kind: 'missing', datasetId: DATASET, revision: 0 };
    const service = createMobileBackend({ serverId: SERVER, datasetId: DATASET, authKey, displayName: '合成关闭诊断', environment: 'development',
      enableContent: true, enablePlayback: true, privateCloseDiagnostics: enabled, assertCurrent() {}, resizeArtwork: value => value,
      requestContentRpc: transport.requestRpc,
      async requestOwner(request: MobileOwnerPrivateRequest): Promise<MobileOwnerPrivateResult> {
        let result: MobileOwnerPrivateResult;
        if (request.kind === 'load') result = structuredClone(stored);
        else if (request.kind === 'playback-load') result = { kind: 'missing', datasetId: DATASET, revision: 0 };
        else if (request.kind === 'save') {
          assert.equal(stored.revision, request.request.expectedRevision);
          stored = { kind: 'sealed', datasetId: DATASET, revision: stored.revision + 1, commitId: request.request.commitId, sealed: new Uint8Array(request.request.sealed) };
          result = { kind: 'saved', datasetId: DATASET, revision: stored.revision, commitId: request.request.commitId };
        } else throw new Error('本例不调用播放写入、Source、Provider或DB。');
        assert.ok(isMobileOwnerPrivateResult(result, request)); return result;
      } });
    child.after(() => { closeMobileCapabilityContext(trace.value); authKey.fill(0); if (stored.kind === 'sealed') stored.sealed.fill(0); });
    service.activatePlayback(ORIGIN);
    const ticket = await service.auth.issuePairing(), pair = await service.auth.claim({ pairingSecret: ticket.pairingSecret,
      installationId: 'close.diagnostic.synthetic.installation', deviceName: '合成手机' }, 'close.synthetic.claim');
    const decoded = decodeMobileRequest('getCapabilities', { method: 'GET', path: '/mobile/v1/capabilities',
      headers: [['Authorization', `Bearer ${pair.accessToken}`]], query: [], body: new Uint8Array() },
    { responseOrigin: ORIGIN, requestPath: '/mobile/v1/capabilities' }); assert.ok(decoded.ok);
    await assert.rejects(withMobileCapabilityContext(trace.value, () => service.backend.dispatch({ operation: 'getCapabilities',
      request: decoded.value, accessToken: pair.accessToken, signal: signal() })), assertUnknown);
    await turns();
    assert.equal(service.getCloseDiagnosticContext(), enabled ? trace.value : undefined);
    closeMobileCapabilityContext(trace.value);
    const first = service.close(), second = service.close(); assert.equal(first, second);
    let failure: unknown; try { await first; } catch (error) { failure = error; }
    assert.ok(failure instanceof AggregateError); assert.equal(failure.errors.length, 1); assertUnknown(failure.errors[0]);
    await assert.rejects(service.close(), error => error === failure);
    assert.deepEqual(transport.calls.map(request => request.action), ['initialize', 'scope', 'cancel', 'cancel']);
    const rows = trace.rows().filter(row => row.stage.startsWith('main.close.'));
    if (!enabled) assert.deepEqual(rows, []);
    else {
      const expected = ['main.close.content-backend', 'main.close.playback', 'main.close.revocations', 'main.close.content-port', 'main.close.auth'];
      assert.deepEqual(rows.filter(row => row.phase === 'begin' && expected.includes(row.stage)).map(row => row.stage), expected);
      for (const stage of expected) assert.ok(rows.some(row => row.stage === stage && row.phase === (stage === 'main.close.content-port' ? 'reject' : 'ok')));
      for (const stage of ['main.close.content.cleanup', 'main.close.content-port']) {
        const failed = rows.find(row => row.stage === stage && row.phase === 'reject'); assert.ok(failed);
        assert.equal(failed.code, 'BUSY'); assert.equal(failed.name, 'UNKNOWN'); assert.equal(failed.outcome, 'unknown'); assert.equal(failed.role, 'cleanup');
      }
      assert.equal(rows.some(row => row.stage === 'main.close.content.deadline'), false);
    }
    assert.doesNotMatch(trace.lines.join(''), /message|stack|Bearer|pairingSecret|accessToken|\/private\//u);
  });
});
