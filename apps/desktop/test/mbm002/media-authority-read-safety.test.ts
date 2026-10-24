import assert from 'node:assert/strict';
import test, { after, type TestContext } from 'node:test';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { request as httpsRequest } from 'node:https';
import type { ClientRequest } from 'node:http';
import threads, { type WorkerOptions } from 'node:worker_threads';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import { IPC_VERSION } from '@music-bridge/contracts';
import { CoreSupervisor, type CoreChildProcess, type CoreMessagePort } from '../../src/main/core-supervisor.js';
import { createMobileHttpsServer } from '../../src/main/mobile-https-server.js';
import { loadOrCreateMobileIdentity } from '../../src/main/mobile-tls-identity.js';
import type { Mobile002Backend, Mobile002BackendReply } from '../../src/main/mobile-playback-backend.js';
import type { MobileContentScope } from '../../../../packages/bridge-core/src/mobile/content-types.js';
import { MobileAuthPersistenceError, MobileServiceError, type MobileOwnerPrivateRequest, type MobileAuthService, type MobileOwnerPrivateResult, type MobilePrincipal,
  type MobileSealedState } from '../../../../packages/bridge-core/src/mobile/types.js';
import type { MobileOwnerSourceRequest, MobileOwnerSourceResult } from '../../../../packages/bridge-core/src/mobile/source-protocol.js';
import type { createMainMobileContentPort } from '../../src/main/mobile-content-port.js';

import { MobilePlaybackError } from '../../../../packages/bridge-core/src/mobile/playback-types.js';
import { withMobileMediaReadBudget, boundedMobileMediaReadRange } from '../../../../packages/bridge-core/src/mobile/media-read-budget.js';

const codecEntry = process.env.MUSIC_BRIDGE_PLAYBACK_CODEC_TEST_ENTRY;
const codecSHA = process.env.MB_MAC69_CODEC_ENTRY_SHA256;
assert.ok(codecEntry?.startsWith('/Volumes/LifeWeave/'));
assert.match(codecSHA ?? '', /^[a-f0-9]{64}$/u);
assert.equal(createHash('sha256').update(readFileSync(codecEntry!)).digest('hex'), codecSHA);
const OriginalWorker = threads.Worker;
let workerCount = 0, workerExits = 0;
// 仅绑定未改的状态codec工厂到已核SHA的真实产物，不替换编码、协议或资源限制。
class BoundCodecWorker extends OriginalWorker {
  constructor(file: string | URL, options?: WorkerOptions) {
    const selected = file instanceof URL && file.pathname.endsWith('/src/main/mobile-playback-state-worker-entry.js');
    if (selected) {
      assert.deepEqual(options?.resourceLimits, { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 });
      assert.deepEqual(options?.execArgv, []); assert.deepEqual(options?.env, {});
    }
    super(selected ? pathToFileURL(codecEntry!) : file, options);
    if (selected) { workerCount++; this.once('exit', () => { workerExits++; }); }
  }
}
(threads as unknown as { Worker: typeof OriginalWorker }).Worker = BoundCodecWorker;
syncBuiltinESMExports();
after(() => {
  (threads as unknown as { Worker: typeof OriginalWorker }).Worker = OriginalWorker;
  syncBuiltinESMExports(); assert.equal(workerCount, workerExits);
  assert.equal(createHash('sha256').update(readFileSync(codecEntry!)).digest('hex'), codecSHA);
});
const { createMobilePlaybackBackend } = await import('../../src/main/mobile-playback-backend.js');

const SERVER = 'server.media-read-budget', DATASET = 'dataset.media-read-budget';
const principal: MobilePrincipal = { serverId: SERVER, datasetId: DATASET, deviceId: 'device.media-read-budget',
  deviceEpoch: 1, generation: 1, accountDomain: `local:${DATASET}`, accessTokenHash: 'b'.repeat(64),
  accessExpiresAt: '2030-01-01T00:00:00.000Z' };
function gate() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
async function turns(count = 24) { for (let n = 0; n < count; n++) await new Promise<void>(yes => setImmediate(yes)); }

class ControlledPort implements CoreMessagePort {
  readonly pending = new Map<string, { id: string; request: { kind: string; datasetId: string } }>();
  readonly calls: { id: string; kind: string }[] = [];
  private listener?: (event: { data: unknown }) => void;
  hold = false;
  closed = false;
  entered = gate();
  on(_event: 'message', listener: (event: { data: unknown }) => void) { this.listener = listener; }
  start() {}
  close() { this.closed = true; }
  receive(value: unknown) { this.listener?.({ data: value }); }
  postMessage(value: unknown) {
    if (!value || typeof value !== 'object') return;
    const call = value as { type?: string; id?: string; request?: { kind: string; datasetId: string } };
    if (call.type !== 'mobile-main-request' || !call.id || !call.request) return;
    const captured = { id: call.id, request: structuredClone(call.request) };
    this.calls.push({ id: captured.id, kind: captured.request.kind });
    if (this.hold) { this.pending.set(captured.id, captured); this.entered.resolve(); }
    else queueMicrotask(() => this.reply(captured));
  }
  private reply(call: { id: string; request: { kind: string; datasetId: string } }) {
    this.receive({ type: 'mobile-main-response', id: call.id,
      result: { kind: 'missing', datasetId: call.request.datasetId, revision: 0 } });
  }
  release() { this.hold = false; for (const call of this.pending.values()) this.reply(call); this.pending.clear(); }
  arm() { this.hold = true; }
}
class ControlledChild implements CoreChildProcess {
  private readonly exits: ((code: number) => void)[] = [];
  postMessage(_value: unknown) {}
  once(_event: 'exit', listener: (code: number) => void) { this.exits.push(listener); }
  kill() { this.exit(); return true; }
  exit() { for (const listener of this.exits.splice(0)) listener(0); }
}

type HoldPhase = 'open' | 'initial' | 'before-read' | 'after-read' | 'before-write';
interface ClientResult { ok: boolean; status: number; bytes: Buffer }
/** 真实TLS入口、Main/Service组合、Supervisor原RPC和真实codec线程；只替换Owner/源的叶端口。 */
async function fixture(t: TestContext) {
  assert.ok(process.env.TMPDIR?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
  const directory = mkdtempSync(path.join(process.env.TMPDIR!, 'mac69-media-budget-')), key = randomBytes(32);
  const owner = new ControlledPort(), child = new ControlledChild();
  const supervisor = new CoreSupervisor({ entryPath: path.join(directory, 'not-executed-core.cjs'), cwd: directory,
    requestTimeoutMs: 2000, startupTimeoutMs: 2000, dependencies: {
      createChannel: () => ({ port1: new ControlledPort(), port2: owner }), fork: () => child,
    } });
  const started = supervisor.start();
  owner.receive({ version: IPC_VERSION, event: 'core.ready', payload: { state: {
    runtime: 'ready', roon: 'disconnected', provider: 'missing', activeStreamCount: 0, activePlaybackPresent: false,
  } } });
  await started;
  const data = Uint8Array.from({ length: 262144 }, (_, n) => n % 251);
  const scope: Readonly<MobileContentScope> = { serverId: SERVER, datasetId: DATASET, deviceId: principal.deviceId,
    deviceEpoch: 1, accessGeneration: 1, ownerEpoch: 'owner.media-read-budget', providerEpoch: null,
    accountDomain: principal.accountDomain };
  let stored: MobileSealedState = { kind: 'missing', datasetId: DATASET, revision: 0 };
  let holdPhase: HoldPhase | undefined, phaseArmed = false, revoked = false, sourceHeld = false;
  let gateRead = gate(), readEntered = gate(), closingReads = 0, reads = 0, authCalls = 0;
  let lastReply: Extract<Mobile002BackendReply, { kind: 'media' }> | undefined, readFailure: unknown;
  const rawReads: { readId: string; start: number; maxBytes: number }[] = [];
  const armOwner = () => { if (!phaseArmed) { phaseArmed = true; owner.arm(); } };
  const auth = { async authenticate() { return { ...principal }; }, async assertCurrent() {
    if (revoked) throw new MobileServiceError(403, 'DEVICE_REVOKED');
  }, async assertDeviceCurrent(deviceId: string, epoch: number) {
    authCalls++; assert.equal(deviceId, principal.deviceId); assert.equal(epoch, 1);
    if (revoked) throw new MobileServiceError(403, 'DEVICE_REVOKED');
    await supervisor.requestMobileMain({ kind: 'load', datasetId: DATASET });
    if (revoked) throw new MobileServiceError(403, 'DEVICE_REVOKED');
  } } as unknown as MobileAuthService;
  const content = { async scopeForIdentity() { return { scope, neteasePlayback: false }; },
    async source(actual: Readonly<MobileContentScope>, request: MobileOwnerSourceRequest, signal: AbortSignal) {
      assert.deepEqual(actual, scope); signal.throwIfAborted(); let result: MobileOwnerSourceResult;
      if (request.operation === 'prepare') {
        const audio = { codec: 'flac', container: 'flac', sampleRateHz: 48000, bitsPerSample: 24, channels: 2 };
        result = { kind: 'mobile-source-prepared', source: { handle: request.selection.resourceId,
          sourceAudio: audio, actualAudio: { ...audio }, processing: { mode: 'direct', reason: '合成原字节', fromPreparedCache: false },
          contentType: 'audio/flac', size: data.length, durationMs: 4000, seekable: true } };
      } else if (request.operation === 'read') {
        reads++; rawReads.push({ readId: request.readId, start: request.start, maxBytes: request.maxBytes });
        if (sourceHeld) { readEntered.resolve(); await gateRead.promise; }
        signal.throwIfAborted();
        result = { kind: 'mobile-source-read', handle: request.handle, readId: request.readId, start: request.start,
          bytes: data.slice(request.start, request.start + request.maxBytes) };
        if (holdPhase === 'after-read') armOwner();
      } else if (request.operation === 'capabilities') result = { kind: 'mobile-source-capabilities', resourceDsdToPcm: false };
      else if (request.operation === 'status') throw new Error('本例不准备DSD。');
      else {
        if (request.operation === 'close-read') closingReads++;
        result = { kind: 'mobile-source-ack', operation: request.operation, handle: request.handle,
          readId: request.operation === 'close-read' ? request.readId : null, quiet: true };
      }
      return { source: 'local', result };
    } } satisfies Pick<ReturnType<typeof createMainMobileContentPort>, 'scopeForIdentity' | 'source'>;
  const handle = createMobilePlaybackBackend({ serverId: SERVER, datasetId: DATASET, authKey: key, auth, assertCurrent() {},
    contentPort: content as unknown as ReturnType<typeof createMainMobileContentPort>,
    async requestOwner(request): Promise<MobileOwnerPrivateResult> {
      if (request.kind === 'playback-load') return structuredClone(stored);
      if (request.kind === 'playback-activity') return { kind: 'playback-activity', datasetId: DATASET,
        ownerEpoch: '11111111-1111-4111-8111-111111111111', operation: request.request.operation,
        leaseId: '22222222-2222-4222-8222-222222222222' };
      assert.equal(request.kind, 'playback-save'); if (request.kind !== 'playback-save') throw new Error('无关Owner写入');
      assert.equal(request.request.expectedRevision, stored.revision);
      stored = { kind: 'sealed', datasetId: DATASET, revision: stored.revision + 1,
        commitId: request.request.commitId, sealed: new Uint8Array(request.request.sealed) };
      return { kind: 'saved', datasetId: DATASET, revision: stored.revision, commitId: stored.commitId };
    } });
  const identity = await loadOrCreateMobileIdentity({ directory: path.join(directory, 'tls'), hosts: ['127.0.0.1'], secretProtector: {
    encryptString(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]); },
    decryptString(value) { const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(-16)); return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString('utf8'); },
  } });
  const playback: Mobile002Backend = { ...handle.backend, async dispatch(input) {
    if (input.operation === 'getMediaAsset' && holdPhase === 'open') armOwner();
    const value = await handle.backend.dispatch(input);
    if (value.kind !== 'media') return value;
    const read = value.reader.read.bind(value.reader);
    const observed = { ...value, reader: { close: value.reader.close.bind(value.reader), async read(maxBytes: number, signal: AbortSignal) {
      if (holdPhase === 'before-read') armOwner();
      const block = await read(maxBytes, signal).catch(error => { readFailure = error; throw error; });
      if (block && holdPhase === 'before-write') armOwner();
      return block;
    } } };
    lastReply = observed;
    if (holdPhase === 'initial') armOwner();
    return observed;
  } };
  const server = createMobileHttpsServer({ host: '127.0.0.1', port: 0,
    tls: { key: identity.privateKeyPEM, cert: identity.certificatePEM }, playback,
    backend: { async dispatch() {
      await supervisor.requestMobileMain({ kind: 'load', datasetId: DATASET });
      const bytes = Buffer.from(JSON.stringify({ serverId: SERVER, displayName: '合成目录', contractVersion: '0.1.0', environment: 'development' }));
      return { status: 200, headers: [['Content-Type', 'application/json'], ['Content-Length', String(bytes.length)]], body: bytes };
    } } });
  const listening = await server.start(); handle.activate(listening.baseUrl);
  const activeClients = new Set<ClientRequest>();
  t.after(async () => {
    t.mock.restoreAll(); t.mock.timers.reset(); owner.release(); sourceHeld = false; gateRead.resolve();
    for (const request of activeClients) request.destroy(); await turns();
    await server.close(); await handle.close(); child.exit(); key.fill(0); rmSync(directory, { recursive: true, force: true });
  });
  function call(method: string, target: string, body?: unknown, range?: string) {
    const endpoint = new URL(listening.baseUrl), bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    let request!: ClientRequest, settled = false;
    const result = new Promise<ClientResult>(resolve => {
      let status = 0; const chunks: Buffer[] = [];
      const finish = (ok: boolean) => { if (!settled) { settled = true; activeClients.delete(request);
        resolve({ ok, status, bytes: Buffer.concat(chunks) }); } };
      request = httpsRequest({ hostname: '127.0.0.1', port: endpoint.port, path: target, method,
        ca: identity.certificatePEM, agent: false, headers: { Host: endpoint.host, Connection: 'close',
          ...(range ? { Range: range } : {}), ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length),
            'Idempotency-Key': method === 'POST' && target.endsWith('/sessions') ? 'session.media-read-budget' : 'resource.media-read-budget' } : {}),
          ...(method === 'POST' ? { Authorization: 'Bearer synthetic.access' } : {}) } }, response => {
        status = response.statusCode ?? 0; response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.once('end', () => finish(true)); response.once('error', () => finish(false)); response.once('aborted', () => finish(false));
      });
      activeClients.add(request); request.once('error', () => finish(false)); request.end(bytes);
    });
    return { result, settled: () => settled, cancel: () => request.destroy() };
  }
  const sessionReply = await call('POST', '/mobile/v1/sessions', { clientInstanceId: 'client.media-read-budget' }).result;
  assert.equal(sessionReply.status, 201); const session = JSON.parse(sessionReply.bytes.toString()) as { id: string };
  const resourceReply = await call('POST', `/mobile/v1/sessions/${session.id}/resources`, {
    trackId: 'track.media-read-budget', versionId: 'version.media-read-budget', contentRevision: 'revision.media-read-budget',
    quality: { profile: 'lossless', allowLossyFallback: false, preferredTransport: 'file' },
    formats: [{ codec: 'flac', container: 'flac', maxSampleRateHz: 48000, maxBitsPerSample: 24, maxChannels: 2 }],
  }).result;
  assert.equal(resourceReply.status, 201); const resource = JSON.parse(resourceReply.bytes.toString()) as { media: { url: string } };
  const mediaURL = new URL(resource.media.url);
  return { owner, supervisor, child, data, reads: () => reads, authCalls: () => authCalls, closingReads: () => closingReads, rawReads,
    hold(phase: HoldPhase) { holdPhase = phase; phaseArmed = false; }, release() { holdPhase = undefined; owner.release(); },
    revoke() { revoked = true; }, sourceHold() { sourceHeld = true; gateRead = gate(); readEntered = gate(); },
    sourceEntered: () => readEntered.promise, sourceRelease() { sourceHeld = false; gateRead.resolve(); },
    request(range = 'bytes=0-262143') { return call('GET', mediaURL.pathname + mediaURL.search, undefined, range); },
    head() { return call('HEAD', mediaURL.pathname + mediaURL.search); },
    snapshot: () => handle.snapshot(), readFailure: () => readFailure,
    controlRead() { return call('GET', '/mobile/v1/server'); }, reply: () => lastReply,
  };
}
function controlledClock(t: TestContext, wallAdvance = 0) {
  const base = performance.now(); let elapsed = 0;
  t.mock.method(performance, 'now', () => base + elapsed);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() + wallAdvance });
  return { async tick(ms: number) { elapsed += ms; t.mock.timers.tick(ms); await turns(); } };
}


// 与冻结RED共享同形真实组合，但独立文件允许补充安全边界；不改RED原断言或生产测试接口。
function ownerRead(f: Awaited<ReturnType<typeof fixture>>, controller: AbortController, request: MobileOwnerPrivateRequest = { kind: 'load', datasetId: DATASET }) {
  return withMobileMediaReadBudget(performance.now() + 30_000, controller.signal,
    () => f.supervisor.requestMobileMain(request));
}

test('M69总截止：open等20秒后initial再等，入口30秒不能按阶段重置且晚reply不发字节', async t => {
  const f = await fixture(t); f.hold('open'); const clock = controlledClock(t);
  const request = f.request(); await f.owner.entered.promise;
  await clock.tick(20_000); assert.equal(request.settled(), false);
  f.release(); f.owner.entered = gate(); f.hold('initial'); await f.owner.entered.promise;
  const calls = f.owner.calls.length; await clock.tick(10_001);
  assert.equal((await request.result).ok, false); assert.equal(f.reads(), 0);
  assert.equal(f.owner.calls.length, calls, '总截止不新发授权或重放媒体');
  assert.equal(f.owner.pending.size, 1, 'HTTP停止不代表原Owner已quiet');
  assert.equal(f.snapshot()?.readers, 1, 'held原授权未收口不能归还reader');
  f.release(); await turns(); assert.equal(f.snapshot()?.readers, 0); assert.equal(f.reads(), 0);
});

test('M69取消：HTTP断开后Owner原Promise/reader保持，晚授权不能写入已取消响应', async t => {
  const f = await fixture(t); f.hold('initial'); const request = f.request(); await f.owner.entered.promise;
  request.cancel(); assert.equal((await request.result).ok, false); await turns();
  assert.equal(f.owner.pending.size, 1); assert.equal(f.snapshot()?.readers, 1); assert.equal(f.reads(), 0);
  f.release(); await turns(); assert.equal(f.snapshot()?.readers, 0); assert.equal(f.reads(), 0);
});

test('M69真实I/O：只对content.source一次读限5秒，忽略abort的原读未结束仍占reader且不重放', async t => {
  const f = await fixture(t); f.sourceHold(); const clock = controlledClock(t);
  const request = f.request(); await f.sourceEntered();
  try {
    await clock.tick(5_001); assert.equal((await request.result).ok, false); assert.equal(f.reads(), 1);
    const failure = f.readFailure(); assert.ok(failure instanceof MobilePlaybackError);
    assert.equal(failure.status, 429); assert.equal(failure.code, 'RESOURCE_BUSY');
    assert.equal(failure.retryable, true); assert.equal(failure.retryAfterMs, 1000);
    assert.equal(f.snapshot()?.readers, 1, '5秒race不能把原I/O当静止');
    assert.equal(f.rawReads[0]?.start, 0);
  } finally { f.sourceRelease(); await turns(); }
  assert.equal(f.snapshot()?.readers, 0); assert.equal(f.reads(), 1);
  const recovered = await f.request().result;
  assert.equal(recovered.ok, true); assert.deepEqual(recovered.bytes, Buffer.from(f.data));
});

test('M69票期：原票只余5秒时先于新30秒截止撤资格，晚Owner回包不复活字节', async t => {
  const f = await fixture(t); f.hold('initial'); const clock = controlledClock(t, 55_000);
  const request = f.request(); await f.owner.entered.promise; await clock.tick(5_001);
  assert.equal(f.reads(), 0); assert.equal(f.snapshot()?.readers, 1);
  assert.ok(f.reply()!.ticketExpiresAtMs < Date.now(), '发送端原票绝对期限已过而入口总预算尚未耗尽');
  f.release(); const result = await request.result;
  assert.notEqual(result.status, 206); assert.equal(f.reads(), 0);
  await turns(); assert.equal(f.snapshot()?.readers, 0);
});

test('M69撤销：预算内真实DEVICE_REVOKED仍拒绝，不能把等待成功当权限或发送旧块', async t => {
  const f = await fixture(t); f.hold('after-read'); const request = f.request(); await f.owner.entered.promise;
  assert.equal(f.reads(), 1); f.revoke(); f.release(); const result = await request.result;
  assert.equal(result.ok, false); assert.equal(result.bytes.length, 0); assert.equal(f.reads(), 1);
  await turns(); assert.equal(f.snapshot()?.readers, 0);
});

for (const kind of ['playback-load', 'save', 'playback-save'] as const) {
  test(`M69非媒体授权：即使ALS存在，${kind}仍原10秒UNKNOWN且不重发`, async t => {
    const f = await fixture(t); f.owner.arm(); const clock = controlledClock(t), controller = new AbortController();
    const request: MobileOwnerPrivateRequest = kind === 'playback-load' ? { kind, datasetId: DATASET }
      : { kind, datasetId: DATASET, request: { datasetId: DATASET, expectedRevision: 0,
        commitId: '11111111-1111-4111-8111-111111111111', sealed: new Uint8Array(32) } };
    const result = ownerRead(f, controller, request).then(() => ({ success: true, error: undefined }), error => ({ success: false, error }));
    await f.owner.entered.promise; const calls = f.owner.calls.length; await clock.tick(10_001);
    const outcome = await result; assert.equal(outcome.success, false);
    assert.ok(outcome.error instanceof MobileAuthPersistenceError); assert.equal(outcome.error.outcome, 'unknown');
    assert.equal(f.owner.calls.length, calls); f.owner.release();
  });
}

test('M69准入：取消/截止后32个原load仍占32槽，第33不得进入；真实原回包才归还', async t => {
  const f = await fixture(t); f.owner.arm(); const clock = controlledClock(t), controller = new AbortController();
  let settled = 0;
  const requests = Array.from({ length: 32 }, () => ownerRead(f, controller).then(
    () => { settled++; return 'success'; }, () => { settled++; return 'failed'; }));
  await turns(); assert.equal(f.owner.pending.size, 32); controller.abort(); await clock.tick(30_001);
  assert.equal(settled, 0, '不能用截止包装让原RPC假quiet');
  const calls = f.owner.calls.length;
  await assert.rejects(f.supervisor.requestMobileMain({ kind: 'load', datasetId: DATASET }),
    error => error instanceof MobileAuthPersistenceError && error.outcome === 'not-sent');
  assert.equal(f.owner.calls.length, calls); f.owner.release();
  assert.deepEqual(await Promise.all(requests), Array(32).fill('failed'));
  const next = await f.supervisor.requestMobileMain({ kind: 'load', datasetId: DATASET });
  assert.ok('kind' in next); assert.equal(next.kind, 'missing');
});

test('M69坏回包：匹配ID但多余字段不证明quiet，不释放32槽；确认原child退出后才收口', async t => {
  const f = await fixture(t); f.owner.arm(); const controller = new AbortController();
  let settled = 0;
  const requests = Array.from({ length: 32 }, () => ownerRead(f, controller).then(
    () => { settled++; return 'success'; }, () => { settled++; return 'failed'; }));
  await turns(); const first = f.owner.pending.values().next().value; assert.ok(first);
  f.owner.receive({ type: 'mobile-main-response', id: first.id,
    result: { kind: 'missing', datasetId: DATASET, revision: 0 }, extra: true }); await turns();
  assert.equal(settled, 0);
  await assert.rejects(f.supervisor.requestMobileMain({ kind: 'load', datasetId: DATASET }),
    error => error instanceof MobileAuthPersistenceError && error.outcome === 'not-sent');
  f.child.exit(); assert.deepEqual(await Promise.all(requests), Array(32).fill('failed'));
});

for (const form of ['head', 'oversize', 'open-ended', 'no-range'] as const) {
  test(`M69窄范围：${form}不采用媒体30秒，原10秒授权界限保持`, async t => {
    const f = await fixture(t); f.owner.arm(); const clock = controlledClock(t);
    const request = form === 'head' ? f.head() : f.request(form === 'oversize' ? 'bytes=0-262144' : form === 'open-ended' ? 'bytes=0-' : '');
    await f.owner.entered.promise; const calls = f.owner.calls.length; await clock.tick(10_001);
    const result = await request.result; assert.equal(result.status, 429, '父Core媒体establishment总10秒先给RESOURCE_BUSY'); assert.equal(f.owner.calls.length, calls);
    f.owner.release();
  });
}

test('M69请求形状：只接原安全整数闭合Range且至多256KiB，未放宽公有解析', () => {
  assert.equal(boundedMobileMediaReadRange('bytes=0-262143'), true);
  assert.equal(boundedMobileMediaReadRange('bytes=10-10'), true);
  for (const raw of ['bytes=0-262144', 'bytes=1-0', 'bytes=0-', 'bytes=-1', 'bytes=0-1,3-4',
    'bytes=0-9007199254740992', 'bytes=1-2\n', 'bytes=+1-2', 'bytes=0-1 '.repeat(20)])
    assert.equal(boundedMobileMediaReadRange(raw), false);
});

test('M69原入口：未过闭集guard的null/getter/Proxy不得读取kind、投递或建立媒体预算', async t => {
  const f = await fixture(t), controller = new AbortController(); let evaluated = 0;
  const getter = Object.defineProperty({ datasetId: DATASET }, 'kind', { enumerable: true,
    get() { evaluated++; return 'load'; } });
  const proxy = new Proxy({ kind: 'load', datasetId: DATASET }, { get() { evaluated++; throw new Error('禁止触发未知入口'); } });
  const calls = f.owner.calls.length;
  for (const value of [null, getter, proxy]) await assert.rejects(
    ownerRead(f, controller, value as unknown as MobileOwnerPrivateRequest),
    error => error instanceof MobileAuthPersistenceError && error.outcome === 'not-sent');
  assert.equal(evaluated, 0); assert.equal(f.owner.calls.length, calls);
});
