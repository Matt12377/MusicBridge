import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import { MessageChannel, type Worker } from 'node:worker_threads';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { decodeMobileRequest } from '@music-bridge/contracts';
import { createMobileBackend } from '../../../apps/desktop/src/main/mobile-backend.js';
import { createMobileHttpsServer } from '../../../apps/desktop/src/main/mobile-https-server.js';
import { loadOrCreateMobileIdentity } from '../../../apps/desktop/src/main/mobile-tls-identity.js';
import { CoreSupervisor, type CoreChildProcess, type CoreMessagePort } from '../../../apps/desktop/src/main/core-supervisor.js';
import { attachCoreRuntimePort, type CoreRuntimeForIpc } from '../src/utility-main.js';
import { createDatasetOwnerClient } from '../src/collection/dataset-owner-client.js';
import { attachDatasetOwnerWorkerPort } from '../src/collection/dataset-owner-worker.js';
import { type OwnedDatasetDomain, DatasetOwnerTransportError, isDatasetOwnerRequest } from '../src/collection/dataset-owner-protocol.js';
import { createMobileOwnerService } from '../src/mobile/owner-service.js';
import type { CollectionRepository } from '../src/collection/repository.js';
import { failureForError } from '../src/shared/ipc-failure.js';
import { MobileAuthPersistenceError, type Mobile001Backend, type MobileOwnerPrivateRequest, type MobileOwnerPrivateResult } from '../src/mobile/types.js';
import { isMobileCorePrivateCall } from '../src/mobile/owner-protocol.js';
import { createMobileContentRpcPort } from '../src/mobile/content-rpc-port.js';
import { captureMobileContentCoreRequest } from '../src/mobile/content-rpc.js';
import { createMobileOwnerLoadTraceProbe, withMobileOwnerLoadTrace, markMobileOwnerLoadTrace,
  MOBILE_OWNER_LOAD_TRACE_PREFIX, copyMobileOwnerLoadCapabilityFrame, copyMobileOwnerLoadTraceFrame } from '../src/mobile/owner-load-trace.js';

const DATASET = '50000000-0000-4000-8000-000000000001';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function strictFrames(lines: string[]) {
  return lines.map(line => {
    assert.ok(line.startsWith(MOBILE_OWNER_LOAD_TRACE_PREFIX)); assert.ok(Buffer.byteLength(line) <= 1024);
    const raw: unknown = JSON.parse(line.slice(MOBILE_OWNER_LOAD_TRACE_PREFIX.length));
    const frame = copyMobileOwnerLoadTraceFrame(raw) ?? copyMobileOwnerLoadCapabilityFrame(raw);
    assert.ok(frame, '混合私有输出不能把新detail误作event，也不能忽略不合法帧。'); return frame;
  });
}
function assertMixedBudget(lines: string[], probe: ReturnType<typeof createMobileOwnerLoadTraceProbe>) {
  const mixed = strictFrames(lines), counts = probe.snapshot();
  assert.equal(counts.records, mixed.length); assert.equal(counts.bytes, lines.reduce((sum, line) => sum + Buffer.byteLength(line), 0));
  assert.ok(counts.records <= 64 && counts.bytes <= 65536);
  for (const [index, frame] of mixed.entries()) if (frame.type === 'mobile-owner-load-trace' && frame.event.stage === 'http.terminal') {
    assert.equal(frame.event.http?.counts?.records, index + 1);
    assert.equal(frame.event.http?.counts?.bytes, lines.slice(0, index + 1).reduce((sum, line) => sum + Buffer.byteLength(line), 0));
    assert.ok((frame.event.http?.counts?.suppressed ?? 0) <= counts.suppressed);
  }
  return counts;
}

/** 仅在本例外置合成目录生成TLS材料，不调用桌面安全存储或读取真实身份。 */
async function syntheticTlsIdentity(t: TestContext, directory: string) {
  const protectionKey = randomBytes(32);
  t.after(() => protectionKey.fill(0));
  const identity = await loadOrCreateMobileIdentity({ directory: path.join(directory, 'synthetic-tls'), hosts: ['127.0.0.1'], secretProtector: {
    encryptString(value) {
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', protectionKey, nonce);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
    },
    decryptString(value) {
      const decipher = createDecipheriv('aes-256-gcm', protectionKey, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
    },
  } });
  t.after(() => identity.authKey.fill(0));
  return identity;
}

function readCapabilities(base: string, ca: string, token: string): Promise<{ status: number; body: Buffer }> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const request = httpsRequest({ hostname: url.hostname, port: url.port, method: 'GET', path: '/mobile/v1/capabilities',
      ca, agent: false, headers: { Host: url.host, Connection: 'close', Authorization: `Bearer ${token}` } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      response.once('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }));
      response.once('error', reject);
      response.once('aborted', () => reject(new Error('合成能力响应已关闭。')));
    });
    request.once('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('合成能力请求等待已结束。')));
    request.end();
  });
}

/** 原Main监督器、Utility入口与Owner消息边界；真实MessageChannel、原文件store，领域及进程退出受控。 */
class LoopPort implements CoreMessagePort {
  peer!: LoopPort;
  listener?: (event: { data: unknown }) => void;
  closed = false;
  failReply = false;
  readonly sent: unknown[] = [];
  on(_event: 'message', listener: (event: { data: unknown }) => void) { this.listener = listener; }
  start() {}
  close() { this.closed = true; }
  postMessage(value: unknown) {
    if (this.failReply && (value as { type?: unknown }).type === 'mobile-main-response') throw new Error('合成回包出口失败，正文不得进入诊断');
    const copy = structuredClone(value); this.sent.push(copy);
    queueMicrotask(() => { if (!this.closed && !this.peer.closed) this.peer.listener?.({ data: copy }); });
  }
}
async function fixture(t: TestContext, enabled: boolean) {
  const parent = process.env.TMPDIR;
  assert.ok(typeof parent === 'string' && parent.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
  const directory = fs.mkdtempSync(path.join(parent, 'owner-load-flow-')); fs.chmodSync(directory, 0o700);
  const channels = new MessageChannel(), worker = new EventEmitter();
  Object.assign(worker, { postMessage(value: unknown) { channels.port1.postMessage(value); } });
  channels.port1.on('message', value => worker.emit('message', value));
  channels.port1.once('close', () => worker.emit('exit', 0));
  const owner = createMobileOwnerService({ collection: { privateMobileDataDirectory: () => directory } as unknown as CollectionRepository,
    datasetId: DATASET, ownerEpoch: 'owner.synthetic.trace', assertCurrent() {} });
  let calls = 0, shutdowns = 0, kills = 0;
  let held: ReturnType<typeof deferred<MobileOwnerPrivateResult>> | undefined;
  const entered = deferred<void>();
  const domain: OwnedDatasetDomain = {
    datasetId: DATASET, async dispatch() { return undefined; }, commitBoot() {},
    async mobileMain(request) { calls++; entered.resolve(); return held ? held.promise : owner.dispatch(request); },
    async close(before) { await before?.(); },
    failureForError(id, error, command) { return failureForError(id, error, command ?? 'commandOutbox.context'); },
  };
  attachDatasetOwnerWorkerPort(channels.port2, { async prepare() { return domain; } });
  const reasons: string[] = [];
  const endpoint = createDatasetOwnerClient({ worker: worker as unknown as Worker, onFatal: reason => reasons.push(reason) });
  await endpoint.prepare(); await endpoint.commitBoot();
  const ports: LoopPort[] = [];
  const contentCalls = { initialize: 0, scope: 0 };
  const rpc = createMobileContentRpcPort({
    async initialize() { contentCalls.initialize++; },
    async resolveScope(value) { contentCalls.scope++; return { ...value, ownerEpoch: 'owner.synthetic.trace', accountDomain: `local:${DATASET}`, providerEpoch: null }; },
    assertScope() {}, async invalidateDevice() {}, async neteasePlaybackQualified() { return false; },
    content: { async dispatch() { throw new Error('本例不执行内容查询'); } }, async source() { throw new Error('本例不读取媒体'); },
  });
  const child = { stdout: new EventEmitter(), stderr: new EventEmitter(), exits: [] as Array<(code: number) => void>,
    once(_event: 'exit', fn: (code: number) => void) { this.exits.push(fn); },
    exit(code: number) { for (const fn of this.exits.splice(0)) fn(code); },
    kill() { kills++; this.exit(0); return true; },
    postMessage(_value: unknown, transferred?: CoreMessagePort[]) { void attachCoreRuntimePort(transferred![0]!, runtime); },
  };
  const runtime = { async start() {},
    async shutdown() { shutdowns++; await rpc.close(); await endpoint.close(); setImmediate(() => child.exit(0)); },
    getState: () => ({ runtime: 'ready', roon: 'disconnected', provider: 'missing', activeStreamCount: 0, activePlaybackPresent: false }),
    datasetOwnerEndpoint: endpoint,
    mobileContentRpc: rpc.request,
  } as unknown as CoreRuntimeForIpc;
  const supervisor = new CoreSupervisor({ entryPath: '/synthetic/owner-trace-core.js', cwd: '/synthetic', startupTimeoutMs: 1000,
    requestTimeoutMs: 1000, dependencies: { fork: () => child as CoreChildProcess,
      createChannel() { const a = new LoopPort(), b = new LoopPort(); a.peer = b; b.peer = a; ports.push(a, b); return { port1: a, port2: b }; } } });
  await supervisor.start();
  const lines: string[] = [], probe = createMobileOwnerLoadTraceProbe({ enabled, sink: line => { lines.push(line); } });
  t.after(async () => {
    held?.resolve({ kind: 'missing', datasetId: DATASET, revision: 0 });
    await supervisor.shutdown(); channels.port1.close(); channels.port2.close();
    fs.rmSync(directory, { recursive: true, force: true });
    assert.equal(shutdowns, 1); assert.equal(kills, 0); assert.deepEqual(reasons, []);
  });
  return { supervisor, probe, lines, ports, entered, contentCalls, counts: () => calls,
    hold() { held = deferred<MobileOwnerPrivateResult>(); return held; },
    frames: () => strictFrames(lines).filter(frame => frame.type === 'mobile-owner-load-trace'),
    details: () => strictFrames(lines).filter(frame => frame.type === 'mobile-owner-load-capability'),
    request: () => ({ kind: 'load', datasetId: DATASET } as const), directory };
}

async function httpFixture(t: TestContext, enabled: boolean) {
  const h = await fixture(t, enabled), identity = await syntheticTlsIdentity(t, h.directory);
  const service = createMobileBackend({ serverId: identity.serverId, datasetId: DATASET, authKey: identity.authKey,
    displayName: '合成首鉴权桥', environment: 'development', assertCurrent() {}, resizeArtwork() { throw new Error('本例不读封面'); },
    enablePlayback: true, enableContent: true, requestOwner: request => h.supervisor.requestMobileMain(request),
    requestContentRpc: (request, signal) => h.supervisor.requestMobileContentMain(request, signal) });
  let dispatched = 0, beforeSend = 0;
  const backend: Mobile001Backend = { async dispatch(input) {
    dispatched++;
    const reply = await service.backend.dispatch(input);
    return { ...reply, beforeSend: async () => { beforeSend++; await reply.beforeSend?.(); } };
  } };
  const server = createMobileHttpsServer({ tls: { key: identity.privateKeyPEM, cert: identity.certificatePEM },
    host: '127.0.0.1', port: 0, backend, ownerLoadTraceProbe: h.probe });
  const close = async () => {
    const failures: unknown[] = [];
    for (const close of [() => server.close(), () => service.close()]) { try { await close(); } catch (error) { failures.push(error); } }
    if (failures.length) throw new AggregateError(failures, '合成首鉴权HTTP及业务未完全关闭。', { cause: failures[0] });
  };
  try {
    const listening = await server.start(); service.activatePlayback(listening.baseUrl);
    const permit = await service.auth.issuePairing();
    const pair = await service.auth.claim({ pairingSecret: permit.pairingSecret, installationId: 'installation.http-first-auth',
      deviceName: '合成首鉴权设备' }, 'claim.http-first-auth');
    return { h, identity, pair, listening, close, counts: () => ({ dispatched, beforeSend }) };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], '合成HTTP准备及收口失败。', { cause: error }); }
    throw error;
  }
}

test('Owner load串联：原Main/Core/Owner边界及真实store读取完整落点，默认关闭不添私有字段或事件', async t => {
  for (const enabled of [false, true]) {
    const sub = await t.test(enabled ? '显式本地旁注' : '普通模式', async t => {
      const h = await fixture(t, enabled), context = h.probe.claim();
      const value = await withMobileOwnerLoadTrace(context, () => h.supervisor.requestMobileMain(h.request()));
      assert.deepEqual(value, { kind: 'missing', datasetId: DATASET, revision: 0 }); assert.equal(h.counts(), 1);
      await turn();
      const call = h.ports[1]!.sent.find(value => (value as { type?: unknown }).type === 'mobile-main-request') as Record<string, unknown>;
      assert.equal(Object.hasOwn(call, 'ownerLoadTrace'), enabled);
      if (!enabled) { assert.equal(h.lines.length, 0); return; }
      const stages = h.frames().map(frame => frame.event.stage);
      for (const stage of ['main.post', 'core.receive', 'owner.client.post', 'owner.receive', 'owner.load', 'core.post', 'main.capture']) {
        assert.ok(stages.includes(stage as typeof stages[number]), stage);
      }
      for (const [stage, outcome] of [['main.post', 'begin'], ['core.receive', 'ok'], ['owner.client.post', 'begin'],
        ['owner.receive', 'ok'], ['owner.load', 'begin'], ['owner.load', 'ok'], ['core.post', 'ok'], ['main.capture', 'ok']]) {
        assert.ok(h.frames().some(frame => frame.event.stage === stage && frame.event.outcome === outcome), `${stage}/${outcome}`);
      }
      assert.equal(h.frames().every(frame => frame.event.ordinal === 1), true);
      assert.equal(h.lines.join('').includes(DATASET), false); assert.equal(h.lines.join('').includes(h.directory), false);
      assert.equal(h.lines.join('').includes(String(call.id)), false); assert.equal(h.probe.snapshot().records <= 64, true);
    });
    void sub;
  }
});

test('Owner load首次能力链：内容initialize和scope返回后，发送前原存活load及再次鉴权均完成', { timeout: 5000 }, async t => {
  const h = await fixture(t, true), key = new Uint8Array(32).fill(41), origin = 'https://127.0.0.1:9443';
  const service = createMobileBackend({ serverId: 'server.owner-load-fixture', datasetId: DATASET, authKey: key,
    displayName: '合成能力桥', environment: 'development', assertCurrent() {}, resizeArtwork() { throw new Error('本例不读封面'); },
    enablePlayback: true, enableContent: true, requestOwner: request => h.supervisor.requestMobileMain(request),
    requestContentRpc: (request, signal) => h.supervisor.requestMobileContentMain(request, signal) });
  try {
    service.activatePlayback(origin);
    const permit = await service.auth.issuePairing();
    const pair = await service.auth.claim({ pairingSecret: permit.pairingSecret, installationId: 'installation.owner-load-fixture', deviceName: '合成设备' }, 'claim.owner-load-fixture');
    const decoded = decodeMobileRequest('getCapabilities', { method: 'GET', path: '/mobile/v1/capabilities',
      headers: [['Authorization', `Bearer ${pair.accessToken}`]], query: [], body: new Uint8Array() },
    { responseOrigin: origin, requestPath: '/mobile/v1/capabilities' });
    assert.ok(decoded.ok);
    const reply = await service.backend.dispatch({ operation: 'getCapabilities', request: decoded.value, accessToken: pair.accessToken, signal: new AbortController().signal });
    assert.deepEqual(h.contentCalls, { initialize: 1, scope: 1 });
    const before = h.counts(), context = h.probe.claim();
    await withMobileOwnerLoadTrace(context, () => reply.beforeSend!());
    assert.equal(h.counts() - before, 2, '原alive load与auth-current load均保留，不能用诊断删检查');
    assert.deepEqual(h.contentCalls, { initialize: 1, scope: 2 });
    assert.equal(reply.status, 200); assert.ok(h.frames().some(frame => frame.event.stage === 'owner.load' && frame.event.outcome === 'ok'));
    assert.equal(h.lines.join('').includes(pair.accessToken), false); assert.equal(h.lines.join('').includes(pair.refreshToken), false);
  } finally { await service.close(); key.fill(0); }
});

test('Owner load HTTP首鉴权失败：真实HTTPS入口携带全链诊断且默认关闭不改变原错误', { timeout: 15_000, concurrency: false }, async t => {
  for (const enabled of [true, false]) await t.test(enabled ? '显式诊断' : '独立默认关闭', async t => {
    const f = await httpFixture(t, enabled), { h, identity, pair, listening } = f;
    try {
      const authFile = path.join(h.directory, 'mobile-devices', 'device-state.v1.sealed.json');
      assert.equal(fs.lstatSync(authFile).isFile(), true);
      const original = fs.readFileSync(authFile);
      const broken = '{"synthetic-auth-envelope":';
      fs.writeFileSync(authFile, broken, { flag: 'w' });
      const callsBefore = h.counts(), messagesBefore = h.ports[1]!.sent.length;
      assert.equal(h.probe.snapshot().claimed, 0);
      // 不在测试外层手动包ALS；原HTTP工厂必须覆盖dispatch中的首个auth load。
      const result = await readCapabilities(listening.baseUrl, identity.certificatePEM, pair.accessToken);
      assert.equal(result.status, 503);
      const body = JSON.parse(result.body.toString('utf8')) as { error: { code: string; message: string; requestId: string; retryable: boolean } };
      assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message', 'requestId', 'retryable']);
      assert.equal(body.error.code, 'BUSY'); assert.equal(body.error.message, '服务忙，请稍后重试。');
      assert.equal(body.error.retryable, true, 'Owner尚未返回认证状态的not-sent纯读错误只拒绝本次，下一请求仍须完整重读');
      assert.deepEqual(f.counts(), { dispatched: 1, beforeSend: 0 });
      assert.equal(h.counts() - callsBefore, 1, '首鉴权失败只能调用一次原load，不能重试或进入后续存活检查');
      assert.deepEqual(h.contentCalls, { initialize: 0, scope: 0 });
      assert.equal(fs.readFileSync(authFile, 'utf8'), broken, '诊断不能修复或改写原坏密文文件');
      await turn();
      const calls = h.ports[1]!.sent.slice(messagesBefore).filter(isMobileCorePrivateCall);
      assert.equal(calls.length, 1); assert.equal(calls[0]!.request.kind, 'load');
      const frames = h.frames();
      assert.equal(Object.hasOwn(calls[0]!, 'ownerLoadTrace'), enabled,
        `首鉴权原load的诊断资格必须沿HTTP dispatch传播；实际为${frames.map(frame => `${frame.event.stage}/${frame.event.outcome}`).join(',')}`);
      if (!enabled) {
        assert.equal(frames.length, 0); assert.equal(h.details().length, 0); assert.equal(h.lines.length, 0); assert.equal(h.probe.snapshot().claimed, 0);
      } else {
        assert.equal(h.probe.snapshot().claimed, 1);
        for (const stage of ['http.dispatch', 'main.auth', 'main.post', 'core.receive', 'owner.receive', 'owner.load', 'http.failure', 'http.terminal']) {
          assert.ok(frames.some(frame => frame.event.stage === stage), `首鉴权失败必须记录${stage}；实际为${frames.map(frame => `${frame.event.stage}/${frame.event.outcome}`).join(',')}`);
        }
        assert.equal(frames.every(frame => frame.event.ordinal === 1), true);
        assert.ok(frames.some(frame => frame.event.stage === 'owner.load' && frame.event.outcome === 'not-sent'));
        assert.equal(frames.some(frame => ['http.before-send.alive', 'main.initial-qualification', 'main.encode',
          'main.before-send.qualification', 'main.before-send.auth'].includes(frame.event.stage)), false);
        const terminal = frames.filter(frame => frame.event.stage === 'http.terminal');
        assert.equal(terminal.length, 1); assert.equal(terminal[0]!.event.outcome, 'error');
        assert.deepEqual({ ...terminal[0]!.event.http, counts: undefined }, {
          status: 503, aborted: false, headersSent: true, writableFinished: true, counts: undefined,
        });
        const budget = assertMixedBudget(h.lines, h.probe); assert.ok(budget.ordinaryRecords <= 28);
        assert.ok(h.details().every(frame => frame.ordinal === 1));
        for (const value of [DATASET, h.directory, authFile, broken, pair.accessToken, pair.refreshToken, body.error.requestId,
          calls[0]!.id, identity.privateKeyPEM]) assert.equal(h.lines.join('').includes(value), false);
      }
      // 不用首个失败回包替代下一次认证；坏外层仍存在时，每个HTTP请求都必须重新到真实Owner读取。
      const repeatBefore = h.counts(), repeatMessagesBefore = h.ports[1]!.sent.length;
      const repeated = await readCapabilities(listening.baseUrl, identity.certificatePEM, pair.accessToken);
      assert.equal(repeated.status, 503);
      const repeatedBody = JSON.parse(repeated.body.toString('utf8')) as typeof body;
      assert.deepEqual(Object.keys(repeatedBody.error).sort(), ['code', 'message', 'requestId', 'retryable']);
      assert.equal(repeatedBody.error.code, 'BUSY'); assert.equal(repeatedBody.error.message, '服务忙，请稍后重试。');
      assert.equal(repeatedBody.error.retryable, true);
      assert.equal(h.counts() - repeatBefore, 1); assert.deepEqual(f.counts(), { dispatched: 2, beforeSend: 0 });
      assert.deepEqual(h.contentCalls, { initialize: 0, scope: 0 });
      assert.equal(fs.readFileSync(authFile, 'utf8'), broken, '重复鉴权失败也不能重建、修复或覆盖坏文件');
      await turn();
      const repeatedCalls = h.ports[1]!.sent.slice(repeatMessagesBefore).filter(isMobileCorePrivateCall);
      assert.equal(repeatedCalls.length, 1); assert.equal(repeatedCalls[0]!.request.kind, 'load');
      fs.writeFileSync(authFile, original, { flag: 'w' });
      const recoveredBefore = h.counts(), recoveredMessagesBefore = h.ports[1]!.sent.length;
      const recovered = await readCapabilities(listening.baseUrl, identity.certificatePEM, pair.accessToken);
      assert.equal(recovered.status, 200, '纯读not-sent没有接受过坏状态；恢复原字节后同一token必须经fresh load重新鉴权');
      assert.equal(h.counts() - recoveredBefore, 3, '恢复仍保留首鉴权、alive、发送前末鉴权三次真实load');
      assert.deepEqual(f.counts(), { dispatched: 3, beforeSend: 1 });
      assert.deepEqual(h.contentCalls, { initialize: 1, scope: 2 });
      assert.deepEqual(fs.readFileSync(authFile), original, '恢复读取不能旋转身份或写入新的认证状态');
      await turn();
      const recoveredCalls = h.ports[1]!.sent.slice(recoveredMessagesBefore).filter(isMobileCorePrivateCall);
      assert.equal(recoveredCalls.length, 3); assert.equal(recoveredCalls.every(call => call.request.kind === 'load'), true);
    } finally { await f.close(); }
  });
});

test('Owner load HTTP坏AEAD：合法外层读取成功后永久锁闭，恢复原字节也不进入内容服务', { timeout: 15_000, concurrency: false }, async t => {
  for (const enabled of [true, false]) await t.test(enabled ? '显式诊断' : '独立默认关闭', async t => {
    const f = await httpFixture(t, enabled), { h, identity, pair, listening } = f;
    try {
      const authFile = path.join(h.directory, 'mobile-devices', 'device-state.v1.sealed.json');
      const original = fs.readFileSync(authFile), envelope = JSON.parse(original.toString('utf8')) as { sealed: string; sha256: string };
      const sealed = Buffer.from(envelope.sealed, 'base64');
      assert.ok(sealed.length > 28); assert.equal(createHash('sha256').update(sealed).digest('hex'), envelope.sha256);
      // 外层校验和匹配损坏后的密文，确保真实Owner成功返回封套，失败确实落到Main的AEAD认证。
      sealed[28] = sealed[28]! ^ 1;
      const damaged = Buffer.from(JSON.stringify({ ...envelope, sealed: sealed.toString('base64'),
        sha256: createHash('sha256').update(sealed).digest('hex') }) + '\n');
      fs.writeFileSync(authFile, damaged, { flag: 'w' });
      async function refused() {
        const result = await readCapabilities(listening.baseUrl, identity.certificatePEM, pair.accessToken);
        assert.equal(result.status, 503);
        const body = JSON.parse(result.body.toString('utf8')) as { error: { code: string; message: string; requestId: string; retryable: boolean } };
        assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message', 'requestId', 'retryable']);
        assert.equal(body.error.code, 'BUSY'); assert.equal(body.error.message, '服务忙，请稍后重试。');
        assert.equal(body.error.retryable, false, '已经收到封套后的AEAD失败仍须永久锁闭，不能当作Owner读暂错');
      }
      const callsBefore = h.counts(), messagesBefore = h.ports[1]!.sent.length;
      await refused();
      assert.equal(h.counts() - callsBefore, 1); assert.deepEqual(f.counts(), { dispatched: 1, beforeSend: 0 });
      assert.deepEqual(h.contentCalls, { initialize: 0, scope: 0 });
      assert.deepEqual(fs.readFileSync(authFile), damaged, '失败鉴权不能修复或改写损坏密文');
      await turn();
      const calls = h.ports[1]!.sent.slice(messagesBefore).filter(isMobileCorePrivateCall);
      assert.equal(calls.length, 1); assert.equal(calls[0]!.request.kind, 'load');
      if (enabled) assert.ok(h.frames().some(frame => frame.event.stage === 'owner.load' && frame.event.outcome === 'ok'), '真实封套已通过Owner读取，不能误测成外层文件读失败');
      else { assert.equal(h.lines.length, 0); assert.equal(h.probe.snapshot().claimed, 0); }
      fs.writeFileSync(authFile, original, { flag: 'w' });
      const lockedBefore = h.counts(), lockedMessagesBefore = h.ports[1]!.sent.length;
      await refused();
      assert.equal(h.counts(), lockedBefore, '同一auth实例已经fatal；原字节恢复不能触发新的Owner读取或恢复旧授权');
      assert.deepEqual(f.counts(), { dispatched: 2, beforeSend: 0 });
      assert.deepEqual(h.contentCalls, { initialize: 0, scope: 0 });
      assert.deepEqual(fs.readFileSync(authFile), original);
      await turn();
      assert.equal(h.ports[1]!.sent.slice(lockedMessagesBefore).filter(isMobileCorePrivateCall).length, 0);
      for (const value of [DATASET, h.directory, authFile, pair.accessToken, pair.refreshToken, identity.privateKeyPEM]) assert.equal(h.lines.join('').includes(value), false);
    } finally { await f.close(); }
  });
});

test('Owner load HTTP完整成功：工厂保留三次原load及发送前检查，28加12输出预算与默认关闭等价', { timeout: 15_000, concurrency: false }, async t => {
  for (const enabled of [true, false]) await t.test(enabled ? '显式诊断' : '独立默认关闭', async t => {
    const f = await httpFixture(t, enabled), { h, identity, pair, listening } = f;
    try {
      const callsBefore = h.counts(), messagesBefore = h.ports[1]!.sent.length;
      const result = await readCapabilities(listening.baseUrl, identity.certificatePEM, pair.accessToken);
      assert.equal(result.status, 200);
      assert.deepEqual(JSON.parse(result.body.toString('utf8')), { contractVersion: '0.1.0', localPlayback: true,
        neteasePlayback: false, transcoding: false, hls: false, preparedVariants: false,
        qualityProfiles: ['auto', 'lossless'], maxConcurrentSessions: 2 });
      assert.deepEqual(f.counts(), { dispatched: 1, beforeSend: 1 });
      assert.equal(h.counts() - callsBefore, 3, '原首鉴权、alive、末鉴权三次load均须真实往返');
      assert.deepEqual(h.contentCalls, { initialize: 1, scope: 2 });
      await turn();
      const calls = h.ports[1]!.sent.slice(messagesBefore).filter(isMobileCorePrivateCall);
      assert.equal(calls.length, 3); assert.equal(calls.every(call => call.request.kind === 'load'), true);
      const contentRequests = h.ports[1]!.sent.slice(messagesBefore)
        .filter(value => (value as { type?: unknown }).type === 'mobile-content-core-request').map(captureMobileContentCoreRequest);
      assert.deepEqual(contentRequests.map(request => request.action), ['initialize', 'scope', 'scope'], '三次原内容RPC必须真实发出，不能用旁注条数代替调用数。');
      const frames = h.frames();
      assert.equal(calls.every(call => Object.hasOwn(call, 'ownerLoadTrace') === enabled), true,
        `三次原load均须继承同一HTTP context；实际资格为${calls.map(call => Object.hasOwn(call, 'ownerLoadTrace')).join(',')}`);
      if (!enabled) {
        assert.equal(frames.length, 0); assert.equal(h.details().length, 0); assert.equal(h.lines.length, 0); assert.equal(h.probe.snapshot().claimed, 0);
      } else {
        assert.equal(h.probe.snapshot().claimed, 1); assert.equal(frames.every(frame => frame.event.ordinal === 1), true);
        const budget = assertMixedBudget(h.lines, h.probe); assert.ok(budget.ordinaryRecords <= 28);
        for (const outcome of ['begin', 'ok']) {
          const published = frames.filter(frame => frame.event.stage === 'owner.load' && frame.event.outcome === outcome).length;
          assert.ok(published > 0 && published <= calls.length);
          if (published !== calls.length) assert.ok(budget.suppressed > 0, '真实三次load已核；旁注省略必须明确计数。');
        }
        for (const [stage, outcome] of [['http.receive', 'ok'], ['http.dispatch', 'begin'],
          ['main.auth', 'begin'], ['main.auth', 'ok'], ['main.initial-qualification', 'begin'],
          ['main.content.initialize', 'begin'], ['main.content.scope', 'begin']]) {
          assert.ok(frames.some(frame => frame.event.stage === stage && frame.event.outcome === outcome), `${stage}/${outcome}`);
        }
        for (const stage of ['main.content.initialize', 'main.content.scope']) {
          const published = frames.filter(frame => frame.event.stage === stage).length;
          assert.ok(published > 0 && published <= 2);
          if (published !== 2) assert.ok(budget.suppressed > 0);
        }
        const terminal = frames.filter(frame => frame.event.stage === 'http.terminal');
        assert.equal(terminal.length, 1); assert.equal(terminal[0]!.event.outcome, 'ok');
        assert.deepEqual({ ...terminal[0]!.event.http, counts: undefined }, {
          status: 200, aborted: false, headersSent: true, writableFinished: true, counts: undefined,
        });
        assert.ok(budget.suppressed > 0); assert.ok(h.details().every(frame => frame.ordinal === 1));
        for (const value of [DATASET, h.directory, pair.accessToken, pair.refreshToken, identity.privateKeyPEM,
          ...calls.map(call => call.id)]) assert.equal(h.lines.join('').includes(value), false);
      }
    } finally { await f.close(); }
  });
});

test('Owner load准入：临时ordinal不放宽原请求、跨库、额外字段或访问器；仅load可携带', () => {
  const call = { type: 'mobile-main-request', id: randomUUID(), request: { kind: 'load', datasetId: DATASET } };
  assert.equal(isMobileCorePrivateCall(call), true); assert.equal(isMobileCorePrivateCall({ ...call, ownerLoadTrace: 1 }), true);
  for (const bad of [0, 9, -1, 1.5, NaN, '1', undefined]) assert.equal(isMobileCorePrivateCall({ ...call, ownerLoadTrace: bad }), false);
  assert.equal(isMobileCorePrivateCall({ ...call, ownerLoadTrace: 1, body: '不得接收' }), false);
  assert.equal(isMobileCorePrivateCall({ ...call, ownerLoadTrace: 1, request: { kind: 'playback-load', datasetId: DATASET } }), false);
  let reads = 0;
  assert.equal(isMobileCorePrivateCall({ ...call, get ownerLoadTrace() { reads++; return 1; } }), false); assert.equal(reads, 0);
  const owner = { version: 1, epoch: randomUUID(), type: 'request', requestId: randomUUID(), sequence: 1,
    operation: 'mobileMain', expectedDatasetId: DATASET, mobile: call.request, ownerLoadTrace: 1 };
  assert.equal(isDatasetOwnerRequest(owner), true);
  assert.equal(isDatasetOwnerRequest({ ...owner, expectedDatasetId: randomUUID() }), false);
  assert.equal(isDatasetOwnerRequest({ ...owner, mobile: { kind: 'playback-load', datasetId: DATASET } }), false);
});

test('Owner load回包出口故障：保留原10秒未知结果，明确Core post失败与Main timeout，不自动重试', { timeout: 15_000 }, async t => {
  const h = await fixture(t, true), context = h.probe.claim(); h.ports[0]!.failReply = true;
  const started = performance.now();
  await assert.rejects(withMobileOwnerLoadTrace(context, () => h.supervisor.requestMobileMain(h.request())),
    error => error instanceof MobileAuthPersistenceError && error.outcome === 'unknown');
  assert.ok(performance.now() - started >= 9900); assert.equal(h.counts(), 1);
  assert.ok(h.frames().some(frame => frame.event.stage === 'core.post' && frame.event.outcome === 'post-failed'));
  assert.ok(h.frames().some(frame => frame.event.stage === 'main.timeout' && frame.event.outcome === 'timeout'));
  assert.equal(h.frames().some(frame => frame.event.stage === 'main.capture'), false);
  h.ports[0]!.failReply = false;
});

test('Owner load关闭与迟到：在途结果保持未知，关闭后回包不能恢复旧pending或跳过Owner关闭', { timeout: 5000 }, async t => {
  const h = await fixture(t, true), held = h.hold(), context = h.probe.claim();
  const original = withMobileOwnerLoadTrace(context, () => h.supervisor.requestMobileMain(h.request()));
  const rejected = assert.rejects(original, error => error instanceof MobileAuthPersistenceError && error.outcome === 'unknown');
  await h.entered.promise;
  const shutdown = h.supervisor.shutdown(); held.resolve({ kind: 'missing', datasetId: DATASET, revision: 0 });
  await rejected; await shutdown;
  assert.equal(h.counts(), 1);
  assert.ok(h.frames().some(frame => frame.event.stage === 'main.close' && frame.event.role === 'cleanup'));
  assert.equal((h.supervisor as unknown as { mobilePending: Map<string, unknown> }).mobilePending.size, 0);
  await assert.rejects(withMobileOwnerLoadTrace(context, () => h.supervisor.requestMobileMain(h.request())),
    error => error instanceof MobileAuthPersistenceError && error.outcome === 'not-sent');
});
