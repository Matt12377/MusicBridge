import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import { MessageChannel, type Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CoreSupervisor, type CoreChildProcess, type CoreMessagePort } from '../../../../apps/desktop/src/main/core-supervisor.js';
import { attachCoreRuntimePort, type CoreRuntimeForIpc } from '../../src/utility-main.js';
import { createDatasetOwnerClient } from '../../src/collection/dataset-owner-client.js';
import { attachDatasetOwnerWorkerPort } from '../../src/collection/dataset-owner-worker.js';
import type { OwnedDatasetDomain } from '../../src/collection/dataset-owner-protocol.js';
import { createMobileOwnerService } from '../../src/mobile/owner-service.js';
import { allocateOwnedSealedBytes } from '../../src/mobile/owned-sealed-bytes.js';
import type { CollectionRepository } from '../../src/collection/repository.js';
import { MobileAuthPersistenceError, type MobileOwnerPrivateRequest } from '../../src/mobile/types.js';
import { failureForError } from '../../src/shared/ipc-failure.js';
import { encodeMobileSealedCoreRequest } from '../../src/mobile/sealed-request-transport.js';

const DATASET = '50000000-0000-4000-8000-000000000038';
class NativePort implements CoreMessagePort {
  constructor(readonly port: MessageChannel['port1']) {}
  on(_event: 'message', listener: (event: { data: unknown }) => void) { this.port.on('message', data => listener({ data })); }
  start() { this.port.start(); }
  close() { this.port.close(); }
  postMessage(value: unknown) { this.port.postMessage(value); }
}
async function fixture(t: TestContext) {
  assert.ok(process.env.TMPDIR?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
  const directory = fs.mkdtempSync(path.join(process.env.TMPDIR!, 'sealed-transport-')); fs.chmodSync(directory, 0o700);
  const ownerChannel = new MessageChannel(), worker = new EventEmitter(), reasons: string[] = [];
  Object.assign(worker, { postMessage(value: unknown) { ownerChannel.port1.postMessage(value); } });
  ownerChannel.port1.on('message', value => worker.emit('message', value));
  ownerChannel.port1.once('close', () => worker.emit('exit', 0));
  const owner = createMobileOwnerService({ collection: { privateMobileDataDirectory: () => directory } as unknown as CollectionRepository,
    datasetId: DATASET, ownerEpoch: 'owner.synthetic.transport', assertCurrent() {} });
  let calls = 0, shutdowns = 0, kills = 0, release: (() => void) | undefined, entered: (() => void) | undefined;
  let held: Promise<void> | undefined;
  const domain: OwnedDatasetDomain = { datasetId: DATASET, async dispatch() {}, commitBoot() {},
    async mobileMain(request) { calls++; if (held) { entered?.(); await held; } return owner.dispatch(request); },
    async close(before) { await before?.(); }, failureForError(id, error, command) { return failureForError(id, error, command ?? 'commandOutbox.context'); } };
  attachDatasetOwnerWorkerPort(ownerChannel.port2, { async prepare() { return domain; } });
  const endpoint = createDatasetOwnerClient({ worker: worker as unknown as Worker, onFatal: reason => reasons.push(reason) });
  await endpoint.prepare(); await endpoint.commitBoot();
  const channels: MessageChannel[] = [], child = { stdout: new EventEmitter(), stderr: new EventEmitter(), exits: [] as Array<(code: number) => void>,
    once(_event: 'exit', fn: (code: number) => void) { this.exits.push(fn); }, exit(code: number) { for (const fn of this.exits.splice(0)) fn(code); },
    kill() { kills++; this.exit(0); return true; },
    postMessage(_value: unknown, transferred?: CoreMessagePort[]) { void attachCoreRuntimePort(transferred![0]!, runtime); } };
  const runtime = { async start() {}, async shutdown() { shutdowns++; await endpoint.close(); setImmediate(() => child.exit(0)); },
    getState: () => ({ runtime: 'ready', roon: 'disconnected', provider: 'missing', activeStreamCount: 0, activePlaybackPresent: false }), datasetOwnerEndpoint: endpoint } as unknown as CoreRuntimeForIpc;
  const supervisor = new CoreSupervisor({ entryPath: '/synthetic/transport-core.js', cwd: '/synthetic', startupTimeoutMs: 2000,
    requestTimeoutMs: 1000, dependencies: { fork: () => child as CoreChildProcess, createChannel() {
      const c = new MessageChannel(); channels.push(c); return { port1: new NativePort(c.port1), port2: new NativePort(c.port2) }; } } });
  await supervisor.start();
  t.after(async () => { release?.(); await supervisor.shutdown(); ownerChannel.port1.close(); ownerChannel.port2.close();
    for (const c of channels) { c.port1.close(); c.port2.close(); }
    fs.rmSync(directory, { recursive: true, force: true }); assert.equal(shutdowns, 1); assert.equal(kills, 0); assert.deepEqual(reasons, []); });
  return { supervisor, rawCorePort: channels[0]!.port2, calls: () => calls, hold() {
    held = new Promise<void>(yes => { release = () => { held = undefined; yes(); }; });
    return { entered: new Promise<void>(yes => { entered = yes; }), release: () => release?.() };
  } };
}
function request(bytes: Uint8Array, revision = 0): MobileOwnerPrivateRequest {
  return { kind: 'playback-save', datasetId: DATASET, request: { datasetId: DATASET, expectedRevision: revision, commitId: randomUUID(), sealed: bytes } };
}
for (const size of [32768, 524288, 4194304]) test(`M38两跳真实MessageChannel：${size}字节原文件CAS落盘且不枚举任何字节key`, { timeout: 20000 }, async t => {
  const f = await fixture(t), bytes = allocateOwnedSealedBytes(size); bytes.fill(38);
  const r = request(bytes), original = Reflect.ownKeys; let scans = 0;
  Reflect.ownKeys = value => { if (value instanceof Uint8Array) scans++; return original(value); };
  let saved: Awaited<ReturnType<typeof f.supervisor.requestMobileMain>>;
  try { saved = await f.supervisor.requestMobileMain(r); } finally { Reflect.ownKeys = original; }
  assert.ok('kind' in saved); assert.equal(saved.kind, 'saved'); assert.equal(f.calls(), 1); assert.equal(scans, 0, '合格私有传输不再在两跳对每字节生成key。');
  bytes.fill(0);
  const loaded = await f.supervisor.requestMobileMain({ kind: 'playback-load', datasetId: DATASET });
  assert.ok('kind' in loaded); assert.equal(loaded.kind, 'sealed'); if (loaded.kind !== 'sealed') throw new Error('原Owner没有确认保存。');
  assert.equal(loaded.revision, 1); assert.equal(loaded.sealed.byteLength, size); assert.ok(loaded.sealed.every(value => value === 38));
  const conflict = await f.supervisor.requestMobileMain(request(allocateOwnedSealedBytes(1), 0));
  assert.ok('kind' in conflict); assert.equal(conflict.kind, 'conflict');
});
test('M38两跳别名：原请求在异步Owner待命期间被清零，不改变已发送并落盘的字节', async t => {
  const f = await fixture(t), hold = f.hold(), bytes = allocateOwnedSealedBytes(524288); bytes.fill(73);
  const r = request(bytes), pending = f.supervisor.requestMobileMain(r); await hold.entered; bytes.fill(0); hold.release();
  const saved = await pending; assert.ok('kind' in saved); assert.equal(saved.kind, 'saved');
  const loaded = await f.supervisor.requestMobileMain({ kind: 'playback-load', datasetId: DATASET });
  assert.ok('kind' in loaded); assert.equal(loaded.kind, 'sealed'); if (loaded.kind !== 'sealed') throw new Error('原Owner没有确认保存。');
  assert.ok(loaded.sealed.every(value => value === 73)); assert.equal(f.calls(), 2);
});
test('M38关闭保原UNKNOWN：迟到自有save只提交一次，关闭前不早报quiet或重发', async t => {
  const f = await fixture(t), hold = f.hold(), bytes = allocateOwnedSealedBytes(32768);
  const pending = f.supervisor.requestMobileMain(request(bytes)); const rejected = assert.rejects(pending,
    error => error instanceof MobileAuthPersistenceError && error.outcome === 'unknown');
  await hold.entered; let closed = false; const close = f.supervisor.shutdown().then(() => { closed = true; });
  await new Promise<void>(done => setImmediate(done)); assert.equal(closed, false); hold.release(); await rejected; await close;
  assert.equal(f.calls(), 1); assert.equal(closed, true);
});
test('M38原Core32槽先于大副本：第33个4MiB包明确not-sent，零actual owned大分配且原flight保留', async t => {
  const f = await fixture(t), hold = f.hold();
  const pending = Array.from({ length: 32 }, () => f.supervisor.requestMobileMain(request(allocateOwnedSealedBytes(8))));
  const all = Promise.allSettled(pending); await hold.entered;
  for (let n = 0; n < 200 && f.calls() !== 32; n++) await new Promise<void>(done => setImmediate(done));
  assert.equal(f.calls(), 32);
  const id = randomUUID(), encoded = encodeMobileSealedCoreRequest({ type: 'mobile-main-request', id, request: request(allocateOwnedSealedBytes(4194304)) });
  let resolve!: (value: unknown) => void; const result = new Promise<unknown>(yes => { resolve = yes; });
  const receive = (value: unknown) => { if (value && typeof value === 'object' && 'id' in value && value.id === id) resolve(value); };
  f.rawCorePort.on('message', receive);
  const prevent = Object.preventExtensions; let largeAllocations = 0;
  Object.preventExtensions = <T>(value: T): T => { if (value instanceof Uint8Array && value.byteLength === 4194304) largeAllocations++; return prevent(value); };
  try { f.rawCorePort.postMessage(encoded);
    const response = await Promise.race([result, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(Error('原Core未明确拒绝超额包。')), 2000); timer.unref(); })]);
    assert.ok(response && typeof response === 'object' && 'result' in response);
    assert.deepEqual(response.result, { kind: 'mobile-error', status: 503, code: 'BUSY', retryable: false, outcome: 'not-sent' });
    assert.equal(largeAllocations, 0); assert.equal(f.calls(), 32);
  } finally { Object.preventExtensions = prevent; f.rawCorePort.off('message', receive); hold.release(); await all; }
});
