import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { MessageChannel, type Worker } from 'node:worker_threads';
import { DATASET_OWNER_PROTOCOL_VERSION, DatasetOwnerDispatchError, DatasetOwnerTransportError,
  type DatasetOwnerRequest, type OwnedDatasetDomain } from '../../src/collection/dataset-owner-protocol.js';
import { createDatasetOwnerClient } from '../../src/collection/dataset-owner-client.js';
import { attachDatasetOwnerWorkerPort } from '../../src/collection/dataset-owner-worker.js';
import { attachCoreRuntimePort, type CoreRuntimeForIpc } from '../../src/utility-main.js';
import { failureForError } from '../../src/shared/ipc-failure.js';
import { CoreSupervisor, type CoreChildProcess, type CoreMessagePort } from '../../../../apps/desktop/src/main/core-supervisor.js';
import {
  captureDatasetOwnerRequest, captureMobileCorePrivateCall,
  captureMobileCorePrivateReply, captureMobileOwnerPrivateResult,
  readMobileCorePrivateCallForCapture,
} from '../../src/mobile/owner-boundary-capture.js';
import {
  isMobileOwnerPrivateRequest, isMobileOwnerPrivateResult,
  type MobileCorePrivateCall,
} from '../../src/mobile/owner-protocol.js';
import { ownedSealedByteLength } from '../../src/mobile/owned-sealed-bytes.js';
import { MOBILE_AUTH_SEALED_MAX_BYTES, MobileAuthPersistenceError, type MobileOwnerPrivateRequest, type MobileSealedState } from '../../src/mobile/types.js';

const DATASET = '30000000-0000-4000-8000-000000000001', SIZE = 1_999_173;
type Save = Extract<MobileOwnerPrivateRequest, { kind: 'save' | 'playback-save' }>;
const save = (sealed: Uint8Array): Save => ({ kind: 'playback-save', datasetId: DATASET,
  request: { datasetId: DATASET, expectedRevision: 0, commitId: randomUUID(), sealed } });
const call = (request: MobileOwnerPrivateRequest): MobileCorePrivateCall => ({ type: 'mobile-main-request', id: randomUUID(), request });
const owner = (mobile: MobileOwnerPrivateRequest): DatasetOwnerRequest => ({ version: DATASET_OWNER_PROTOCOL_VERSION,
  type: 'request', epoch: randomUUID(), requestId: randomUUID(), sequence: 1, operation: 'mobileMain', expectedDatasetId: DATASET, mobile });
const load: MobileOwnerPrivateRequest = { kind: 'playback-load', datasetId: DATASET };
const state = (sealed: Uint8Array): Extract<MobileSealedState, { kind: 'sealed' }> => ({
  kind: 'sealed', datasetId: DATASET, revision: 1, commitId: randomUUID(), sealed,
});
function scans<T>(work: () => T): { value: T; scans: number } {
  const original = Reflect.ownKeys; let count = 0;
  Reflect.ownKeys = value => { if (value instanceof Uint8Array) count++; return original(value); };
  try { return { value: work(), scans: count }; } finally { Reflect.ownKeys = original; }
}
function saveOf(value: MobileCorePrivateCall | null): Save {
  assert.ok(value); assert.ok(value.request.kind === 'save' || value.request.kind === 'playback-save');
  return value.request;
}

test('sealed边界捕获：Core与Owner各冷核一次，下层复用副本而不登记wire', { timeout: 30_000 }, () => {
  const raw = new Uint8Array(SIZE); raw.fill(37);
  const request = save(raw);
  // 原同进程两层调用确实会对同一个未知数组重复完整形状扫描。
  assert.deepEqual(scans(() => isMobileOwnerPrivateRequest(request) && isMobileOwnerPrivateRequest(request)),
    { value: true, scans: 2 });
  const received = scans(() => captureMobileCorePrivateCall(call(request)));
  assert.equal(received.scans, 1);
  const core = saveOf(received.value), coreBytes = core.request.sealed;
  assert.equal(ownedSealedByteLength(raw, MOBILE_AUTH_SEALED_MAX_BYTES), null);
  assert.equal(Object.isExtensible(raw), true);
  assert.equal(ownedSealedByteLength(coreBytes, MOBILE_AUTH_SEALED_MAX_BYTES), SIZE);
  assert.equal(Object.isExtensible(coreBytes), false);
  assert.notEqual(coreBytes.buffer, raw.buffer); assert.deepEqual(coreBytes, raw);
  assert.equal(core.request.commitId, request.request.commitId);
  assert.deepEqual(scans(() => isMobileOwnerPrivateRequest(core) && isMobileOwnerPrivateRequest(core)), { value: true, scans: 0 });
  raw[0] = 18; assert.equal(coreBytes[0], 37); coreBytes[1] = 22; assert.equal(raw[1], 37);

  // 真实structuredClone丢失本进程资格，下一实际边界必须重新完整冷核。
  const wire = structuredClone(owner(core));
  assert.ok(wire.mobile && (wire.mobile.kind === 'save' || wire.mobile.kind === 'playback-save'));
  const wireBytes = wire.mobile.request.sealed;
  assert.equal(ownedSealedByteLength(wireBytes, MOBILE_AUTH_SEALED_MAX_BYTES), null);
  const accepted = scans(() => captureDatasetOwnerRequest(wire)); assert.equal(accepted.scans, 1);
  assert.ok(accepted.value?.mobile && (accepted.value.mobile.kind === 'save' || accepted.value.mobile.kind === 'playback-save'));
  const local = accepted.value.mobile;
  assert.equal(ownedSealedByteLength(wireBytes, MOBILE_AUTH_SEALED_MAX_BYTES), null);
  assert.notEqual(local.request.sealed.buffer, wireBytes.buffer); assert.deepEqual(local.request.sealed, wireBytes);
  assert.deepEqual(scans(() => isMobileOwnerPrivateRequest(local) && isMobileOwnerPrivateRequest(local)), { value: true, scans: 0 });
  wireBytes.fill(0); assert.equal(local.request.sealed[0], 37);
  assert.equal(ownedSealedByteLength(local.request.sealed, SIZE - 1), null);
  const detached = local.request.sealed;
  structuredClone(detached, { transfer: [detached.buffer] });
  assert.equal(ownedSealedByteLength(detached, MOBILE_AUTH_SEALED_MAX_BYTES), null);
  assert.equal(isMobileOwnerPrivateRequest(local), false);
  const backing = new Uint8Array(32); backing.fill(9);
  const view = backing.subarray(7, 19); view.fill(63);
  const viewCopy = saveOf(captureMobileCorePrivateCall(call(save(view)))).request.sealed;
  assert.equal(viewCopy.byteLength, 12); assert.equal(viewCopy.byteOffset, 0);
  assert.equal(viewCopy.buffer.byteLength, 12); assert.deepEqual(viewCopy, new Uint8Array(12).fill(63));
  backing.fill(0); structuredClone(backing, { transfer: [backing.buffer] });
  assert.deepEqual(viewCopy, new Uint8Array(12).fill(63));
  const admittedRaw = new Uint8Array(8), admission = readMobileCorePrivateCallForCapture(call(save(admittedRaw)));
  assert.ok(admission); assert.equal(ownedSealedByteLength(admittedRaw, MOBILE_AUTH_SEALED_MAX_BYTES), null);
  saveOf(admission.capture());
  assert.throws(() => admission.capture(), /只能消费一次/u);
});

test('sealed边界捕获：Owner回包与Main回包冷核后独立持有，clone再次失去资格', () => {
  const raw = new Uint8Array(64); raw.fill(81); const result = state(raw);
  const fromOwner = scans(() => captureMobileOwnerPrivateResult(result, load)); assert.equal(fromOwner.scans, 1);
  assert.ok(fromOwner.value && 'kind' in fromOwner.value && fromOwner.value.kind === 'sealed');
  const core = fromOwner.value;
  assert.notEqual(core.sealed.buffer, raw.buffer); assert.deepEqual(core.sealed, raw);
  assert.deepEqual(scans(() => isMobileOwnerPrivateResult(core, load) && isMobileOwnerPrivateResult(core, load)), { value: true, scans: 0 });
  assert.equal(ownedSealedByteLength(raw, MOBILE_AUTH_SEALED_MAX_BYTES), null);
  const originalCall = call(load), wire = structuredClone({ type: 'mobile-main-response' as const, id: originalCall.id, result: core });
  assert.equal(ownedSealedByteLength(wire.result.sealed, MOBILE_AUTH_SEALED_MAX_BYTES), null);
  const fromCore = scans(() => captureMobileCorePrivateReply(wire, originalCall)); assert.equal(fromCore.scans, 1);
  assert.ok(fromCore.value && 'kind' in fromCore.value.result && fromCore.value.result.kind === 'sealed');
  const main = fromCore.value.result;
  assert.equal(main.commitId, result.commitId); assert.equal(main.revision, result.revision);
  assert.notEqual(main.sealed.buffer, wire.result.sealed.buffer); assert.deepEqual(main.sealed, wire.result.sealed);
  assert.deepEqual(scans(() => isMobileOwnerPrivateResult(main, load) && isMobileOwnerPrivateResult(main, load)), { value: true, scans: 0 });
  wire.result.sealed.fill(0); raw.fill(0); assert.equal(main.sealed[0], 81); assert.equal(core.sealed[0], 81);
  assert.equal(captureMobileCorePrivateReply(wire, { ...originalCall, id: randomUUID() }), null);
  const changedScope = { ...load, datasetId: 'wrong.dataset' };
  assert.equal(captureMobileOwnerPrivateResult(core, changedScope), null);
});

test('sealed边界捕获：拒绝恶意数组及错误闭集，不能先清洗或跨边界恢复品牌', () => {
  let getters = 0;
  const extra = new Uint8Array(8); Object.defineProperty(extra, 'extra', { value: true });
  const symbol = new Uint8Array(8); Object.defineProperty(symbol, Symbol('extra'), { value: true });
  const accessor = new Uint8Array(8);
  Object.defineProperty(accessor, 'extra', { get() { getters++; return true; } });
  const proxy = new Proxy(new Uint8Array(8), { getPrototypeOf() { getters++; throw new Error('不得执行'); } });
  const detached = new Uint8Array(8); structuredClone(detached, { transfer: [detached.buffer] });
  class ForeignBytes extends Uint8Array {}
  for (const raw of [extra, symbol, accessor, proxy, detached, new Uint8Array(new SharedArrayBuffer(8)),
    Object.create(Uint8Array.prototype) as Uint8Array, Buffer.alloc(8), new ForeignBytes(8), new Uint8Array(0),
    new Uint8Array(MOBILE_AUTH_SEALED_MAX_BYTES + 1)]) {
    const request = save(raw), value = state(raw), original = call(load);
    assert.equal(captureMobileCorePrivateCall(call(request)), null);
    assert.equal(captureDatasetOwnerRequest(owner(request)), null);
    assert.equal(captureMobileOwnerPrivateResult(value, load), null);
    assert.equal(captureMobileCorePrivateReply({ type: 'mobile-main-response', id: original.id, result: value }, original), null);
  }
  assert.equal(getters, 0);
  const request = save(new Uint8Array(8)), original = call(request);
  assert.equal(captureMobileCorePrivateCall({ ...original, extra: true }), null);
  assert.equal(captureMobileCorePrivateCall(call({ ...request, extra: true } as unknown as MobileOwnerPrivateRequest)), null);
  assert.equal(captureMobileCorePrivateCall(call({ ...request, request: { ...request.request, extra: true } } as unknown as MobileOwnerPrivateRequest)), null);
  const getter = save(new Uint8Array(8));
  Object.defineProperty(getter.request, 'sealed', { enumerable: true, get() { getters++; return new Uint8Array(8); } });
  assert.equal(captureMobileCorePrivateCall(call(getter)), null); assert.equal(getters, 0);
  assert.equal(captureDatasetOwnerRequest({ ...owner(request), expectedDatasetId: 'wrong.dataset' }), null);
  assert.equal(captureMobileCorePrivateCall(call({ ...request, request: { ...request.request, expectedRevision: -1 } })), null);
  assert.equal(captureMobileCorePrivateCall(call({ ...request, request: { ...request.request, commitId: 'forged' } })), null);
  assert.equal(captureMobileOwnerPrivateResult({ ...state(new Uint8Array(8)), extra: true }, load), null);
  assert.equal(captureMobileOwnerPrivateResult({ ...state(new Uint8Array(8)), revision: 0 }, load), null);
});

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('实际入站请求未收口。')), 1500);
  })]); } finally { if (timer) clearTimeout(timer); }
}
async function captureFault<T>(kind: 'allocation' | 'copy', work: () => Promise<T>): Promise<T> {
  const prevent = Object.preventExtensions, apply = Reflect.apply, nativeSet = Uint8Array.prototype.set;
  let injected = 0;
  Object.preventExtensions = <V>(value: V): V => {
    if (kind === 'allocation' && value instanceof Uint8Array && injected++ === 0) throw new Error('合成捕获分配失败。');
    return prevent(value);
  };
  Reflect.apply = ((target: Function, receiver: unknown, args: ArrayLike<unknown>): unknown => {
    if (kind === 'copy' && target === nativeSet && receiver instanceof Uint8Array && injected++ === 0) throw new Error('合成捕获复制失败。');
    return apply(target, receiver, args);
  }) as typeof Reflect.apply;
  try { const value = await bounded(work()); assert.equal(injected, 1); return value; }
  finally { Object.preventExtensions = prevent; Reflect.apply = apply; }
}

/** 原Main监督器和Core入站函数，受控Owner依赖；每跳使用真实structuredClone。 */
class LoopPort implements CoreMessagePort {
  peer!: LoopPort;
  listener?: (event: { data: unknown }) => void;
  closed = false;
  on(_event: 'message', listener: (event: { data: unknown }) => void): void { this.listener = listener; }
  start(): void {}
  close(): void { this.closed = true; }
  postMessage(value: unknown): void {
    const copy = structuredClone(value);
    queueMicrotask(() => { if (!this.closed && !this.peer.closed) this.peer.listener?.({ data: copy }); });
  }
}
async function mainCoreFixture() {
  let ownerCalls = 0, shutdowns = 0, kills = 0;
  const child = {
    stdout: new EventEmitter(), stderr: new EventEmitter(), exits: [] as Array<(code: number) => void>,
    once(_event: 'exit', callback: (code: number) => void) { this.exits.push(callback); },
    exit(code: number) { for (const callback of this.exits.splice(0)) callback(code); },
    kill() { kills++; this.exit(0); return true; },
    postMessage(_value: unknown, ports?: CoreMessagePort[]) { void attachCoreRuntimePort(ports![0]!, runtime); },
  };
  const runtime = {
    start: async () => {}, shutdown: async () => { shutdowns++; setImmediate(() => child.exit(0)); },
    getState: () => ({ runtime: 'ready', roon: 'ready', provider: 'missing', activeStreamCount: 0, activePlaybackPresent: false }),
    datasetOwnerEndpoint: { async mobileMain(request: MobileOwnerPrivateRequest) {
      ownerCalls++;
      if (request.kind === 'playback-load') return state(new Uint8Array(64).fill(11));
      assert.ok(request.kind === 'save' || request.kind === 'playback-save');
      return { kind: 'saved', datasetId: DATASET, revision: request.request.expectedRevision + 1, commitId: request.request.commitId };
    } },
  } as unknown as CoreRuntimeForIpc;
  const supervisor = new CoreSupervisor({ entryPath: '/synthetic/capture-core.js', cwd: '/synthetic',
    startupTimeoutMs: 1000, requestTimeoutMs: 1000, dependencies: {
      fork() { return child as CoreChildProcess; },
      createChannel() { const port1 = new LoopPort(), port2 = new LoopPort(); port1.peer = port2; port2.peer = port1; return { port1, port2 }; },
    } });
  await bounded(supervisor.start());
  return { supervisor, counts: () => ({ ownerCalls, shutdowns, kills }) };
}

test('sealed捕获故障收口：实际Core与Main入站明确完成请求，原pending和shutdown不悬挂', { timeout: 20_000 }, async () => {
  for (const at of ['core', 'main'] as const) for (const fault of ['allocation', 'copy'] as const) {
    const h = await mainCoreFixture();
    try {
      await captureFault(fault, async () => {
        if (at === 'core') {
          const result = await h.supervisor.requestMobileMain(save(new Uint8Array(64)));
          assert.ok('kind' in result && result.kind === 'mobile-error');
          assert.equal(result.status, 503); assert.equal(result.outcome, 'not-sent');
        } else await assert.rejects(h.supervisor.requestMobileMain(load), error =>
          error instanceof MobileAuthPersistenceError && error.outcome === 'unknown');
      });
      assert.equal((h.supervisor as unknown as { mobilePending: Map<string, unknown> }).mobilePending.size, 0);
      assert.equal(h.counts().ownerCalls, at === 'core' ? 0 : 1);
    } finally { await bounded(h.supervisor.shutdown()); }
    assert.equal(h.counts().shutdowns, 1); assert.equal(h.counts().kills, 0);
  }
});

/** 原Owner client和worker-port函数＋真实MessageChannel；领域受控，不启动Worker进程或数据库。 */
async function ownerFixture(t: TestContext) {
  const ports = new MessageChannel(), worker = new EventEmitter();
  let calls = 0, closes = 0, mappedNotSent = 0;
  const reasons: string[] = [];
  let domainClosed!: () => void;
  const closed = new Promise<void>(resolve => { domainClosed = resolve; });
  Object.assign(worker, { postMessage(value: unknown) { ports.port1.postMessage(value); } });
  ports.port1.on('message', value => worker.emit('message', value));
  ports.port1.once('close', () => worker.emit('exit', 0));
  const domain: OwnedDatasetDomain = {
    datasetId: DATASET, async dispatch() { return undefined; }, commitBoot() {},
    async mobileMain(request) {
      calls++;
      if (request.kind === 'playback-load') return state(new Uint8Array(64).fill(28));
      assert.ok(request.kind === 'save' || request.kind === 'playback-save');
      return { kind: 'saved', datasetId: DATASET, revision: request.request.expectedRevision + 1, commitId: request.request.commitId };
    },
    async close(before) { await before?.(); closes++; domainClosed(); },
    failureForError(id, error, command) {
      if (error instanceof DatasetOwnerTransportError) { assert.equal(error.outcome, 'not-sent'); mappedNotSent++; }
      return failureForError(id, error, command ?? 'commandOutbox.context');
    },
  };
  attachDatasetOwnerWorkerPort(ports.port2, { async prepare() { return domain; } });
  const endpoint = createDatasetOwnerClient({ worker: worker as unknown as Worker, onFatal: reason => reasons.push(reason) });
  t.after(async () => { ports.port1.close(); ports.port2.close(); await bounded(closed); });
  await bounded(endpoint.prepare()); await bounded(endpoint.commitBoot());
  return { endpoint, reasons, counts: () => ({ calls, closes, mappedNotSent }), closed, ports };
}

test('sealed捕获故障收口：实际Owner与client入站拒绝并沿原close/fatal结束', { timeout: 20_000 }, async t => {
  for (const at of ['owner', 'client'] as const) for (const fault of ['allocation', 'copy'] as const) {
    const h = await ownerFixture(t);
    await captureFault(fault, async () => {
      if (at === 'owner') await assert.rejects(h.endpoint.mobileMain!(save(new Uint8Array(64))), DatasetOwnerDispatchError);
      else await assert.rejects(h.endpoint.mobileMain!(load), error => error instanceof DatasetOwnerTransportError && error.outcome === 'unknown');
    });
    assert.equal(h.counts().calls, at === 'owner' ? 0 : 1);
    assert.equal(h.counts().mappedNotSent, at === 'owner' ? 1 : 0);
    if (at === 'owner') {
      await bounded(h.endpoint.close()); assert.deepEqual(h.reasons, []);
    } else {
      assert.deepEqual(h.reasons, ['protocol-failure']);
      await assert.rejects(h.endpoint.mobileMain!(load), error => error instanceof DatasetOwnerTransportError && error.outcome === 'not-sent');
      await assert.rejects(h.endpoint.close(), DatasetOwnerTransportError);
      h.ports.port1.close(); await bounded(h.closed);
    }
    await turn(); assert.equal(h.counts().closes, 1);
  }
});
