import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import fs from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';
import os from 'node:os';
import { decodeMobileRequest } from '@music-bridge/contracts';
import { createMobileBackend } from '../src/main/mobile-backend.js';
import { MainDiagnosticRecorder, writeDiagnosticReport, type DiagnosticReportWriteInput } from '../src/main/diagnostics.js';
import { createMainMobileContentPort } from '../src/main/mobile-content-port.js';
import { createMobileHttpsServer } from '../src/main/mobile-https-server.js';
import { loadOrCreateMobileIdentity } from '../src/main/mobile-tls-identity.js';
import { createMobileContentRpcPort } from '../../../packages/bridge-core/src/mobile/content-rpc-port.js';
import type { MobileContentCoreRequest, MobileContentMainPrincipal } from '../../../packages/bridge-core/src/mobile/content-rpc.js';
import { MobileAuthPersistenceError, MobileServiceError, type MobileOwnerPrivateRequest,
  type MobileOwnerPrivateResult, type MobileSealedState } from '../../../packages/bridge-core/src/mobile/types.js';
import { MOBILE_CAPABILITY_TRACE_PREFIX, createMobileCapabilityContext, withMobileCapabilityContext,
  closeMobileCapabilityContext, captureMobileCapabilityContext, mobileCapabilityRequestSha,
  createMobileCapabilityTraceCollector, createMobileCapabilityTraceReader,
  snapshotMobileCapabilityTrace, type MobileCapabilityTraceSnapshot } from '../../../packages/bridge-core/src/mobile/capability-trace.js';

// 原Main/Auth/codec/内容RPC合成链；仅第三例用原TLS工厂与loopback，不连接Provider、真实Owner、数据库或设备。
const SERVER = 'server.capability-fixture', DATASET = '20000000-0000-4000-8000-000000000001';
const ORIGIN = 'https://127.0.0.1:9443';
const principal: MobileContentMainPrincipal = { serverId: SERVER, datasetId: DATASET,
  deviceId: 'device.capability-fixture', deviceEpoch: 1, accessGeneration: 1 };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function allCleanup(steps: readonly (() => unknown | Promise<unknown>)[]): Promise<void> {
  const errors: unknown[] = [];
  for (const step of steps) { try { await step(); } catch (error) { errors.push(error); } }
  if (errors.length) throw new AggregateError(errors, '合成能力诊断资源未完整关闭。', { cause: errors[0] });
}
function trace() {
  const collector = createMobileCapabilityTraceCollector(), reader = createMobileCapabilityTraceReader(collector.record);
  const lines: string[] = [];
  return { collector, lines, write(line: string) { lines.push(line); reader(line.slice(0, 17)); reader(line.slice(17)); } };
}
function input(token: string) {
  const decoded = decodeMobileRequest('getCapabilities', { method: 'GET', path: '/mobile/v1/capabilities',
    headers: [['Authorization', `Bearer ${token}`]], query: [], body: new Uint8Array() },
  { responseOrigin: ORIGIN, requestPath: '/mobile/v1/capabilities' });
  assert.ok(decoded.ok);
  return { operation: 'getCapabilities' as const, request: decoded.value, accessToken: token, signal: new AbortController().signal };
}
async function backendFixture(t: TestContext) {
  const key = new Uint8Array(32).fill(71), calls: MobileContentCoreRequest[] = [], ownerCalls: MobileOwnerPrivateRequest[] = [];
  const stored: { auth: MobileSealedState; playback: MobileSealedState } = {
    auth: { kind: 'missing', datasetId: DATASET, revision: 0 }, playback: { kind: 'missing', datasetId: DATASET, revision: 0 } };
  const state: { init: number; scopes: number; qualifies: number; failNextLoad: unknown;
    failAfterScope: unknown; scopeError: unknown; cancelError: unknown; expectCloseFailure: boolean; qualified: boolean } = { init: 0, scopes: 0, qualifies: 0,
    failNextLoad: undefined, failAfterScope: undefined, scopeError: undefined, cancelError: undefined, expectCloseFailure: false, qualified: true };
  const rpc = createMobileContentRpcPort({
    async initialize() { state.init++; },
    async resolveScope(value) {
      state.scopes++;
      if (state.scopeError !== undefined) throw state.scopeError;
      if (state.failAfterScope !== undefined) { state.failNextLoad = state.failAfterScope; state.failAfterScope = undefined; }
      return { ...value, ownerEpoch: 'owner.capability-fixture', accountDomain: `local:${DATASET}`, providerEpoch: null };
    },
    assertScope() {}, async invalidateDevice() {},
    async neteasePlaybackQualified() { state.qualifies++; return state.qualified; },
    content: { async dispatch() { throw new MobileServiceError(400, 'INVALID_REQUEST'); } },
    async source() { throw new MobileServiceError(400, 'INVALID_REQUEST'); },
  });
  async function owner(request: MobileOwnerPrivateRequest): Promise<MobileOwnerPrivateResult> {
    ownerCalls.push(structuredClone(request));
    if (request.kind === 'load' || request.kind === 'playback-load') {
      if (state.failNextLoad !== undefined) { const error = state.failNextLoad; state.failNextLoad = undefined; throw error; }
      return structuredClone(stored[request.kind === 'load' ? 'auth' : 'playback']);
    }
    if (request.kind === 'save' || request.kind === 'playback-save') {
      const name = request.kind === 'save' ? 'auth' : 'playback', previous = stored[name];
      if (previous.revision !== request.request.expectedRevision) return { kind: 'conflict', datasetId: DATASET, currentRevision: previous.revision };
      stored[name] = { kind: 'sealed', datasetId: DATASET, revision: previous.revision + 1,
        commitId: request.request.commitId, sealed: new Uint8Array(request.request.sealed) };
      return { kind: 'saved', datasetId: DATASET, revision: previous.revision + 1, commitId: request.request.commitId };
    }
    throw new MobileServiceError(400, 'INVALID_REQUEST');
  }
  const service = createMobileBackend({ serverId: SERVER, datasetId: DATASET, authKey: key,
    displayName: '能力诊断合成桥', environment: 'development', requestOwner: owner, assertCurrent() {},
    resizeArtwork() { throw new MobileServiceError(400, 'INVALID_REQUEST'); }, enablePlayback: true, enableContent: true,
    async requestContentRpc(request, signal) {
      calls.push(request);
      if (request.action === 'cancel' && state.cancelError !== undefined) throw state.cancelError;
      return rpc.request(request, signal);
    } });
  service.activatePlayback(ORIGIN);
  t.after(() => allCleanup([() => state.expectCloseFailure ? assert.rejects(service.close(), AggregateError) : service.close(), () => rpc.close(), () => {
    key.fill(0); for (const value of Object.values(stored)) if (value.kind === 'sealed') value.sealed.fill(0);
  }]));
  const permit = await service.auth.issuePairing(), pair = await service.auth.claim({ pairingSecret: permit.pairingSecret,
    installationId: 'installation.capability-fixture', deviceName: '合成手机' }, 'claim.capability-fixture');
  return { service, state, calls, ownerCalls, pair };
}

test('能力诊断：原初始化并发等待和拒绝缓存绑定首次RPC，复用不增发也不换原错误', { concurrency: false }, async t => {
  const entered = deferred(), release = deferred(), reused = deferred(), output = trace();
  const calls: MobileContentCoreRequest[] = [], keys: Uint8Array[] = [];
  const denied = new MobileAuthPersistenceError('not-sent');
  let initializes = 0;
  const rpc = createMobileContentRpcPort({
    async initialize(value) { initializes++; keys.push(value.key); entered.resolve(); await release.promise; throw denied; },
    async resolveScope(value) { return { ...value, ownerEpoch: 'owner.capability-fixture', accountDomain: `local:${DATASET}`, providerEpoch: null }; },
    assertScope() {}, async invalidateDevice() {}, content: { async dispatch() { throw denied; } }, async source() { throw denied; },
  });
  const port = createMainMobileContentPort({ serverId: SERVER, datasetId: DATASET, key: new Uint8Array(32).fill(73), assertCurrent() {},
    async requestRpc(request, signal) { calls.push(request); return rpc.request(request, signal); } });
  const contexts = Array.from({ length: 3 }, () => createMobileCapabilityContext(randomUUID(), 'main', 'http', null, undefined, line => {
    output.write(line);
    const row = output.collector.snapshot().records.at(-1);
    if (row?.initState === 'reuse-pending') reused.resolve();
  }));
  t.after(() => allCleanup([() => release.resolve(), () => port.close(), () => rpc.close(),
    () => contexts.forEach(closeMobileCapabilityContext)]));
  const first = withMobileCapabilityContext(contexts[0], () => port.scopeForIdentity(principal, new AbortController().signal));
  const firstError = first.then(() => { throw new Error('原初始化应拒绝。'); }, (error: unknown) => error);
  await entered.promise;
  const second = withMobileCapabilityContext(contexts[1], () => port.scopeForIdentity(principal, new AbortController().signal));
  const secondError = second.then(() => { throw new Error('并发等待应复用原拒绝。'); }, (error: unknown) => error);
  await reused.promise; release.resolve();
  const a = await firstError, b = await secondError;
  const c = await withMobileCapabilityContext(contexts[2], () => port.scopeForIdentity(principal, new AbortController().signal))
    .then(() => { throw new Error('原拒绝缓存不得自动重试。'); }, (error: unknown) => error);
  assert.ok(a instanceof MobileServiceError); assert.equal(a.code, 'BUSY');
  assert.equal(Object.getOwnPropertyDescriptor(a, 'outcome')?.value, 'not-sent');
  assert.equal(a, b); assert.equal(a, c); assert.equal(initializes, 1); assert.equal(calls.length, 1);
  assert.equal(calls[0]!.action, 'initialize'); assert.equal(keys.every(key => key.every(byte => byte === 0)), true);
  const initHash = mobileCapabilityRequestSha('content', calls[0]!.id), rows = output.collector.snapshot().records;
  assert.ok(initHash);
  assert.ok(rows.some(row => row.requestSha256 === initHash && row.parentSha256 === contexts[0]!.requestSha256 && row.stage === 'content.rpc.initialize'));
  for (const [index, state] of ['new-pending', 'reuse-pending', 'reuse-rejected'].entries()) {
    assert.ok(rows.some(row => row.requestSha256 === contexts[index]!.requestSha256 && row.initState === state && row.relatedSha256 === initHash));
  }
  assert.equal(rows.filter(row => row.component === 'main' && row.stage === 'content.rpc.initialize' && row.phase === 'begin').length, 1);
  assert.equal(output.lines.join('').includes(calls[0]!.id), false);
});

test('能力诊断：原Main认证与发送前首拒保持错误身份，sink故障不改成功或资格调用次数', { concurrency: false }, async t => {
  const f = await backendFixture(t), output = trace(), contexts: ReturnType<typeof createMobileCapabilityContext>[] = [];
  const context = (sink = output.write) => { const value = createMobileCapabilityContext(randomUUID(), 'main', 'http', null, undefined, sink); contexts.push(value); return value; };
  t.after(() => contexts.forEach(closeMobileCapabilityContext));
  const authError = new MobileServiceError(503, 'BUSY'), auth = t.mock.method(f.service.auth, 'authenticate', async () => { throw authError; });
  const broken = context(() => { throw new Error('合成sink故障'); });
  await assert.rejects(withMobileCapabilityContext(broken, () => f.service.backend.dispatch(input(f.pair.accessToken))), error => error === authError);
  assert.equal(auth.mock.callCount(), 1); assert.equal(f.calls.length, 0); auth.mock.restore();
  assert.equal(snapshotMobileCapabilityTrace().firstBusinessFailures.find(row => row.requestSha256 === broken!.requestSha256)?.stage, 'main.auth');
  const aliveError = new MobileServiceError(503, 'BUSY'), failed = context();
  const reply = await withMobileCapabilityContext(failed, () => f.service.backend.dispatch(input(f.pair.accessToken)));
  const body = Buffer.from(reply.body); f.state.failNextLoad = aliveError;
  await assert.rejects(withMobileCapabilityContext(failed, () => reply.beforeSend!()), error => error === aliveError);
  assert.equal(f.state.scopes, 1); assert.equal(f.state.qualifies, 1); assert.deepEqual(Buffer.from(reply.body), body);
  assert.equal(output.collector.snapshot().firstBusinessFailures.find(row => row.requestSha256 === failed!.requestSha256)?.stage, 'main.beforeSend.alive');
  for (const sink of [output.write, () => { throw new Error('成功路径合成sink故障'); }]) {
    const current = context(sink), before: number = f.state.scopes;
    const good = await withMobileCapabilityContext(current, () => f.service.backend.dispatch(input(f.pair.accessToken)));
    await withMobileCapabilityContext(current, () => good.beforeSend!());
    assert.equal(good.status, 200); assert.equal(f.state.scopes - before, 2);
    const value: unknown = JSON.parse(Buffer.from(good.body).toString('utf8'));
    assert.deepEqual(value, { contractVersion: '0.1.0', localPlayback: true, neteasePlayback: false,
      transcoding: false, hls: false, preparedVariants: false, qualityProfiles: ['auto', 'lossless'], maxConcurrentSessions: 2 });
  }
  assert.equal(f.state.init, 1); assert.equal(f.state.scopes, 5); assert.equal(f.state.qualifies, 5);
  assert.equal(f.calls.filter(call => call.action === 'initialize').length, 1);
  assert.equal(f.ownerCalls.some(call => call.kind === 'media-source'), false);
  const rows = output.collector.snapshot().records;
  for (const stage of ['main.auth', 'main.initial-qualification', 'main.encode', 'main.beforeSend.alive', 'main.beforeSend.qualification', 'main.beforeSend.auth']) {
    assert.ok(rows.some(row => row.stage === stage && row.phase === 'ok'), stage);
  }
  // 原业务UNKNOWN触发原cancel；清理拒绝保留为独立role，不能覆写业务首拒或假造quiet。
  const unknown = context(); f.state.scopeError = new MobileAuthPersistenceError('unknown');
  f.state.cancelError = new MobileServiceError(503, 'RESOURCE_BUSY'); f.state.expectCloseFailure = true;
  await assert.rejects(withMobileCapabilityContext(unknown, () => f.service.backend.dispatch(input(f.pair.accessToken))), error => {
    assert.ok(error instanceof MobileServiceError); assert.equal(error.code, 'BUSY');
    assert.equal(Object.getOwnPropertyDescriptor(error, 'outcome')?.value, 'unknown'); return true;
  });
  const closing = f.service.close(); assert.equal(f.service.close(), closing);
  await assert.rejects(closing, error => {
    assert.ok(error instanceof AggregateError);
    assert.ok(error.errors.some(value => value instanceof MobileServiceError && value.code === 'RESOURCE_BUSY')); return true;
  });
  const final = output.collector.snapshot();
  assert.equal(final.firstBusinessFailures.find(row => row.requestSha256 === unknown!.requestSha256)?.stage, 'main.initial-qualification');
  const scope = [...f.calls].reverse().find(call => call.action === 'scope'), cancel = f.calls.find(call => call.action === 'cancel');
  assert.ok(scope && cancel?.action === 'cancel'); assert.equal(cancel.requestId, scope.id);
  const cleanupHash = mobileCapabilityRequestSha('content', cancel.id);
  assert.ok(final.cleanupFailures.some(row => row.requestSha256 === cleanupHash && row.parentSha256 === unknown!.requestSha256 && row.stage === 'content.rpc.cancel'));
  assert.equal(final.firstBusinessFailures.some(row => row.requestSha256 === cleanupHash), false);
  assert.equal(f.calls.filter(call => call.action === 'cancel').length, 1);
});

interface HttpResult { status: number; body: Buffer }
function read(base: string, target: string, ca: string, token?: string): Promise<HttpResult> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const request = httpsRequest({ hostname: url.hostname, port: url.port, method: 'GET', path: target, ca, agent: false,
      headers: { Host: url.host, Connection: 'close', ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      response.once('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }));
      response.once('error', reject); response.once('aborted', () => reject(new Error('合成HTTPS响应已关闭。')));
    });
    request.once('error', reject); request.setTimeout(5000, () => request.destroy(new Error('合成HTTPS等待已结束。'))); request.end();
  });
}
test('能力诊断：真实HTTPS仅普通capabilities激活，原安全回执nonce可联通Main与RPC父链', { concurrency: false }, async t => {
  const f = await backendFixture(t), output = trace(), original = fs.writeSync;
  const write = t.mock.method(fs, 'writeSync', (...args: unknown[]): number => {
    const [fd, data] = args;
    if (fd === 1 && typeof data === 'string' && data.startsWith(MOBILE_CAPABILITY_TRACE_PREFIX)) { output.write(data); return Buffer.byteLength(data); }
    return Reflect.apply(original, fs, args) as number;
  });
  syncBuiltinESMExports();
  let directory = '', server: ReturnType<typeof createMobileHttpsServer> | undefined;
  t.after(() => allCleanup([() => server?.close(), () => { write.mock.restore(); syncBuiltinESMExports(); },
    async () => { if (directory) await rm(directory, { recursive: true, force: true }); }]));
  const parent = process.env.TMPDIR ?? (process.platform === 'darwin' ? '/Volumes/LifeWeave/Developer/CommandLine/tmp' : os.tmpdir());
  if (process.platform === 'darwin' && !parent.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/')) throw new Error('合成TLS材料必须使用外置目录。');
  directory = await mkdtemp(path.join(parent, 'mobile-capability-diagnostics-'));
  const key = randomBytes(32);
  const identity = await loadOrCreateMobileIdentity({ directory: path.join(directory, 'identity'), hosts: ['127.0.0.1'], secretProtector: {
    encryptString(value) { const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]); },
    decryptString(value) { const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8'); },
  } });
  t.after(() => { key.fill(0); identity.authKey.fill(0); });
  server = createMobileHttpsServer({ tls: { key: identity.privateKeyPEM, cert: identity.certificatePEM }, host: '127.0.0.1', port: 0, backend: f.service.backend });
  const listening = await server.start();
  const none = output.collector.snapshot().records.length;
  assert.equal((await read(listening.baseUrl, '/mobile/v1/server', identity.certificatePEM)).status, 200);
  assert.equal(output.collector.snapshot().records.length, none);
  const good = await read(listening.baseUrl, '/mobile/v1/capabilities', identity.certificatePEM, f.pair.accessToken);
  assert.equal(good.status, 200); assert.equal(f.state.init, 1); assert.equal(f.state.scopes, 2);
  const failed = new MobileServiceError(503, 'BUSY'); f.state.failAfterScope = failed;
  const bad = await read(listening.baseUrl, '/mobile/v1/capabilities', identity.certificatePEM, f.pair.accessToken);
  assert.equal(bad.status, 503);
  const body = JSON.parse(bad.body.toString('utf8')) as { error: { code: string; message: string; requestId: string; retryable: boolean } };
  assert.equal(body.error.code, 'BUSY'); assert.equal(body.error.retryable, false);
  assert.equal(body.error.message, '服务忙，请稍后重试。');
  assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message', 'requestId', 'retryable']);
  const httpHash = mobileCapabilityRequestSha('http', body.error.requestId), rows = output.collector.snapshot().records;
  assert.ok(httpHash);
  assert.equal(output.collector.snapshot().firstBusinessFailures.find(row => row.component === 'main' && row.requestSha256 === httpHash)?.stage, 'main.beforeSend.alive');
  assert.ok(rows.some(row => row.requestSha256 === httpHash && row.stage === 'http.failure' && row.phase === 'reject'));
  assert.ok(rows.some(row => row.component === 'main' && row.parentSha256 === httpHash && row.stage === 'content.rpc.scope'));
  const init = f.calls.find(call => call.action === 'initialize'); assert.ok(init);
  assert.ok(rows.some(row => row.requestSha256 === httpHash && row.initState === 'reuse-fulfilled' && row.relatedSha256 === mobileCapabilityRequestSha('content', init.id)));
  assert.equal(f.calls.filter(call => call.action === 'initialize').length, 1); assert.equal(f.state.scopes, 3);
  assert.equal(captureMobileCapabilityContext(), undefined);
  const text = output.lines.join('');
  for (const value of [f.pair.accessToken, f.pair.refreshToken, body.error.requestId, directory, listening.baseUrl, init.id]) assert.equal(text.includes(value), false);
  assert.equal(rows.every(row => /^[a-f0-9]{64}$/u.test(row.requestSha256)), true);
  const before = rows.length;
  assert.equal((await read(listening.baseUrl, '/mobile/v1/server', identity.certificatePEM)).status, 200);
  assert.equal(output.collector.snapshot().records.length, before);
});


test('能力诊断：原私有导出保留合法帧及旧证据，毒字段与getter整件拒绝且零新文件', { concurrency: false }, async t => {
  const f = await backendFixture(t), output = trace(), context = createMobileCapabilityContext(randomUUID(), 'main', 'http', null, undefined, output.write);
  const parent = process.env.TMPDIR ?? (process.platform === 'darwin' ? '/Volumes/LifeWeave/Developer/CommandLine/tmp' : os.tmpdir());
  if (process.platform === 'darwin' && !parent.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/')) throw new Error('合成导出必须使用外置临时目录。');
  const directory = await mkdtemp(path.join(parent, 'mobile-capability-export-'));
  t.after(() => allCleanup([() => closeMobileCapabilityContext(context), () => rm(directory, { recursive: true, force: true })]));
  const reply = await withMobileCapabilityContext(context, () => f.service.backend.dispatch(input(f.pair.accessToken)));
  await withMobileCapabilityContext(context, () => reply.beforeSend!()); closeMobileCapabilityContext(context);
  const mobileCapability = output.collector.snapshot(); assert.ok(mobileCapability.records.length > 0);
  const localAlbum = { schema: 'v39.local-album-safe-trace.v1' as const, records: [], firstRejects: [], droppedRecords: 7 };
  const media = { timestamp: '2026-10-16T05:00:00.000Z', level: 'info', event: 'local_playback_media_evidence', schemaVersion: 1, component: 'gateway',
    diagnosticId: 'diag-local-' + 'a'.repeat(64), stage: 'transfer-terminal', currentOwned: true, staleCallback: false,
    requestSequence: 1, method: 'GET', routeClass: 'local-file', rangeClass: 'none', outcome: 'body-completed', statusCode: 200,
    pipelineBodyBytesObserved: 100, observedBytesCapped: false, responseFinished: true, elapsedMs: 10, completedPipelineBodyBytes: 100 };
  const recorder = new MainDiagnosticRecorder(), writeInput: DiagnosticReportWriteInput = {
    platform: { platform: 'darwin', arch: 'arm64', appVersion: '0.1.0-beta.2', electronVersion: '43.4.0', nodeVersion: '22.23.2' },
    main: recorder.snapshot(), core: { ...recorder.snapshot(), component: 'core' },
    privateEvidence: { version: 1, localAlbum, localPlayback: [media], mobileCapability },
  };
  const accepted = path.join(directory, 'accepted.json');
  await writeDiagnosticReport(accepted, writeInput);
  const original = await readFile(accepted), report = JSON.parse(original.toString('utf8')) as { privateEvidence: unknown };
  assert.equal((await stat(accepted)).mode & 0o777, 0o600);
  assert.deepEqual(report.privateEvidence, { version: 1, localAlbum, localPlayback: [media], mobileCapability });
  let getterCalls = 0;
  const row = mobileCapability.records[0]!;
  const injected = { ...mobileCapability, records: [{ ...row, privatePayload: '不可导出的额外正文' }] };
  const getter = { ...mobileCapability, records: [Object.defineProperty({ ...row }, 'stage', {
    enumerable: true, get() { getterCalls++; throw new Error('不能执行诊断getter。'); },
  })] };
  for (const [index, invalid] of [injected, getter].entries()) {
    const rejected = path.join(directory, `rejected-${index}.json`);
    await assert.rejects(writeDiagnosticReport(rejected, { ...writeInput,
      privateEvidence: { version: 1, localAlbum, localPlayback: [media], mobileCapability: invalid as unknown as MobileCapabilityTraceSnapshot },
    }), /安全闭集/);
    await assert.rejects(stat(rejected), { code: 'ENOENT' });
    assert.deepEqual(await readFile(accepted), original);
  }
  assert.equal(getterCalls, 0); assert.deepEqual(await readdir(directory), ['accepted.json']);
});
