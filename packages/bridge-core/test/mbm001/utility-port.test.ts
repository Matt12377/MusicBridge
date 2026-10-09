import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { attachCoreRuntimePort, type CoreRuntimeForIpc, type UtilityPort } from '../../src/utility-main.js';
import { DatasetOwnerTransportError } from '../../src/collection/dataset-owner-protocol.js';
import type { MobileOwnerPrivateRequest, MobileOwnerPrivateResult } from '../../src/mobile/types.js';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
class ControlledPort implements UtilityPort {
  readonly messages: unknown[] = [];
  private listener?: (event: { data: unknown }) => void;
  private pending = new Map<string, (message: unknown) => void>();
  on(_event: 'message', listener: (event: { data: unknown }) => void) { this.listener = listener; }
  start() {}
  postMessage(message: unknown) {
    this.messages.push(message); const id = (message as { id?: string }).id;
    if (id) { this.pending.get(id)?.(message); this.pending.delete(id); }
  }
  send(message: unknown) { this.listener?.({ data: message }); }
  request(message: { id: string }): Promise<unknown> {
    const promise = new Promise(resolve => this.pending.set(message.id, resolve)); this.send(message); return promise;
  }
}
/** 这里只验证真实 utility 私有路由；Owner 和传输端受控，不冒充 App/真实 Owner。 */
function runtime(owner: (request: MobileOwnerPrivateRequest) => Promise<MobileOwnerPrivateResult>, start = async () => {}, shutdown = async () => {}) {
  return { start, shutdown, getState: () => ({ runtime: 'ready', roon: 'disconnected', provider: 'missing', activeStreamCount: 0, activePlaybackPresent: false }),
    datasetOwnerEndpoint: { mobileMain: owner } } as unknown as CoreRuntimeForIpc;
}
const resultOf = (message: unknown) => (message as { result: MobileOwnerPrivateResult }).result;

test('utility启动前不派发；Owner未发送/结果未知保留原certainty且不泄露错误', { timeout: 5000 }, async () => {
  const datasetId = randomUUID(), started = deferred<void>(), port = new ControlledPort(); let calls = 0;
  let outcome: 'not-sent' | 'unknown' | undefined;
  const attached = attachCoreRuntimePort(port, runtime(async request => {
    calls++;
    if (outcome) { const error = new DatasetOwnerTransportError(outcome); error.message = '/private/synthetic-path secret'; throw error; }
    return { kind: 'missing', datasetId: request.datasetId, revision: 0 };
  }, () => started.promise));
  const call = () => ({ type: 'mobile-main-request', id: randomUUID(), request: { kind: 'load', datasetId } });
  assert.deepEqual(resultOf(await port.request(call())), { kind: 'mobile-error', status: 503, code: 'BUSY', retryable: false, outcome: 'not-sent' });
  assert.equal(calls, 0); started.resolve(); await attached;
  for (outcome of ['not-sent', 'unknown'] as const) {
    const reply = await port.request(call());
    assert.deepEqual(resultOf(reply), { kind: 'mobile-error', status: 503, code: 'BUSY', retryable: false, outcome });
    assert.equal(JSON.stringify(reply).includes('/private/'), false); assert.equal(JSON.stringify(reply).includes('secret'), false);
  }
  outcome = undefined;
  assert.deepEqual(resultOf(await port.request(call())), { kind: 'missing', datasetId, revision: 0 }); assert.equal(calls, 3);
  const count = port.messages.length;
  port.send({ ...call(), additionalCapability: 'open-any-file' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(port.messages.length, count); assert.equal(calls, 3);
});

test('utility关闭同步封住新请求，等待真实已派发flight，晚回执结果未知后再关闭Owner', { timeout: 5000 }, async () => {
  const datasetId = randomUUID(), ownerFlight = deferred<MobileOwnerPrivateResult>(), entered = deferred<void>(), port = new ControlledPort();
  let calls = 0, shutdownCalls = 0;
  await attachCoreRuntimePort(port, runtime(async () => { calls++; entered.resolve(); return ownerFlight.promise; }, undefined, async () => { shutdownCalls++; }));
  const call = () => ({ type: 'mobile-main-request', id: randomUUID(), request: { kind: 'load', datasetId } });
  const original = port.request(call()); await entered.promise;
  const shutdown = port.request({ version: 1, id: randomUUID(), command: 'core.shutdown', payload: {} } as { id: string });
  assert.deepEqual(resultOf(await port.request(call())), { kind: 'mobile-error', status: 503, code: 'BUSY', retryable: false, outcome: 'not-sent' });
  assert.equal(calls, 1); assert.equal(shutdownCalls, 0);
  ownerFlight.resolve({ kind: 'missing', datasetId, revision: 0 });
  assert.deepEqual(resultOf(await original), { kind: 'mobile-error', status: 503, code: 'BUSY', retryable: false, outcome: 'unknown' });
  const response = await shutdown as { id: string };
  assert.deepEqual(response, { version: 1, id: response.id, ok: true, result: { stopped: true } });
  assert.equal(shutdownCalls, 1);
});
