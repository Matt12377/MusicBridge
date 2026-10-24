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
import { MobileServiceError, type MobileAuthService, type MobileOwnerPrivateResult, type MobilePrincipal,
  type MobileSealedState } from '../../../../packages/bridge-core/src/mobile/types.js';
import type { MobileOwnerSourceRequest, MobileOwnerSourceResult } from '../../../../packages/bridge-core/src/mobile/source-protocol.js';
import type { createMainMobileContentPort } from '../../src/main/mobile-content-port.js';

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
  let lastReply: Extract<Mobile002BackendReply, { kind: 'media' }> | undefined;
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
      const block = await read(maxBytes, signal);
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
    controlRead() { return call('GET', '/mobile/v1/server'); }, reply: () => lastReply,
  };
}
function controlledClock(t: TestContext) {
  const base = performance.now(); let elapsed = 0;
  t.mock.method(performance, 'now', () => base + elapsed);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  return { async tick(ms: number) { elapsed += ms; t.mock.timers.tick(ms); await turns(); } };
}

test('M69真实HTTPS：open授权等25s仍只等原Owner RPC，不把暂忙抹成撤销或新读', async t => {
  const f = await fixture(t); f.hold('open'); const clock = controlledClock(t);
  const request = f.request(); await f.owner.entered.promise;
  const before = f.owner.calls.length; await clock.tick(25000);
  const stoppedEarly = request.settled(), callsWhileHeld = f.owner.calls.length;
  f.release(); const result = await request.result;
  assert.equal(stoppedEarly, false, '原媒体授权读仍在总30s内，不应由10s包装提前终止');
  assert.equal(callsWhileHeld, before, '等待只允许原RPC，不能新发Owner读');
  assert.equal(result.status, 206); assert.equal(result.ok, true); assert.deepEqual(result.bytes, Buffer.from(f.data));
});

for (const phase of ['initial', 'before-read', 'after-read', 'before-write'] as const) {
  test(`M69真实HTTPS：${phase}授权等待不算客户端5s闲置且源offset只消费一次`, async t => {
    const f = await fixture(t); f.hold(phase); const clock = controlledClock(t);
    const request = f.request(); await f.owner.entered.promise;
    const before = f.owner.calls.length, readCount = f.reads(); await clock.tick(6500);
    const stoppedEarly = request.settled(); assert.equal(f.owner.calls.length, before);
    assert.equal(f.reads(), readCount, '授权挂起期间不得重放源read');
    f.release(); const result = await request.result;
    assert.equal(stoppedEarly, false, '服务器授权等待不得当作客户端没有消费');
    assert.equal(result.status, 206); assert.equal(result.ok, true); assert.deepEqual(result.bytes, Buffer.from(f.data));
    assert.equal(f.rawReads.length, 4); assert.deepEqual(f.rawReads.map(value => value.start), [0, 65536, 131072, 196608]);
    assert.equal(new Set(f.rawReads.map(value => value.readId)).size, 1);
  });
}

test('M69真实HTTPS：普通GET的Owner读仍10s，不继承媒体30s或自动重试', async t => {
  const f = await fixture(t); f.owner.arm(); const clock = controlledClock(t);
  const request = f.controlRead(); await f.owner.entered.promise;
  const before = f.owner.calls.length; await clock.tick(10001);
  const result = await request.result; assert.equal(result.status, 503); assert.equal(f.owner.calls.length, before);
  f.owner.release();
});
