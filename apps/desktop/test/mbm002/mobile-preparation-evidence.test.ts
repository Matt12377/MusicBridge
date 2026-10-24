import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { decodeMobileRequest, encodeMobileJsonReply } from '@music-bridge/contracts';
import { createMobileBackend } from '../../src/main/mobile-backend.js';
import { createMobileHttpsServer } from '../../src/main/mobile-https-server.js';
import { loadOrCreateMobileIdentity } from '../../src/main/mobile-tls-identity.js';
import { MainDiagnosticRecorder, writeDiagnosticReport, type DiagnosticReportWriteInput } from '../../src/main/diagnostics.js';
import { createMobileAuthCrypto } from '../../../../packages/bridge-core/src/mobile/auth-crypto.js';
import { isMobileOwnerPrivateResult } from '../../../../packages/bridge-core/src/mobile/owner-protocol.js';
import {
  MobileAuthPersistenceError, MobileServiceError, type MobileOwnerPrivateRequest,
  type MobileOwnerPrivateResult, type MobileSealedState,
} from '../../../../packages/bridge-core/src/mobile/types.js';
import {
  createMobilePreparationProbe, copyMobilePreparationSnapshot, withMobileCapabilityContext,
  closeMobileCapabilityContext, mobilePreparationAsync, mobilePreparationSync, mobileCapabilityRequestSha,
  type MobilePreparationProbe, type MobilePreparationSnapshot, type MobileCapabilityContext,
} from '../../../../packages/bridge-core/src/mobile/capability-trace.js';

// 合成端口配合原Main/Auth/Playback/codec；不连接真实Owner、Provider、数据库、设备或原配对。
const SERVER = 'server.preparation-fixture', DATASET = '20000000-0000-4000-8000-000000000001';
const ORIGIN = 'https://127.0.0.1:9443';
const identityInput = () => {
  const decoded = decodeMobileRequest('getServer', { method: 'GET', path: '/mobile/v1/server', headers: [], query: [], body: new Uint8Array() },
    { responseOrigin: ORIGIN, requestPath: '/mobile/v1/server' });
  assert.ok(decoded.ok);
  return { operation: 'getServer' as const, request: decoded.value, accessToken: null, signal: new AbortController().signal };
};
const sessionRequest = () => {
  const body = new Uint8Array(Buffer.from(JSON.stringify({ clientInstanceId: 'client.preparation-fixture' })));
  const decoded = decodeMobileRequest('createSession', { method: 'POST', path: '/mobile/v1/sessions',
    headers: [['Content-Type', 'application/json'], ['Idempotency-Key', 'session.preparation-fixture']], query: [], body },
  { responseOrigin: ORIGIN, requestPath: '/mobile/v1/sessions' });
  assert.ok(decoded.ok); return decoded.value;
};
function context(probe: MobilePreparationProbe, operation: 'getServer' | 'createSession') {
  const id = randomUUID(), signal = new AbortController().signal, value = probe.claim(operation, id, signal);
  assert.ok(value); assert.equal(value.requestSha256, mobileCapabilityRequestSha('http', id));
  return value;
}
function finish(probe: MobilePreparationProbe, value: MobileCapabilityContext, failed = false, status = failed ? 503 : 200) {
  probe.finish(value, { failed, finished: true, httpStatus: status }); closeMobileCapabilityContext(value);
}
function first(probe: MobilePreparationProbe, value: MobileCapabilityContext) {
  return probe.snapshot().scopes.find(row => row.requestSha256 === value.requestSha256)!.trace.firstBusinessFailures[0];
}
async function fixture(t: TestContext) {
  const key = new Uint8Array(32).fill(79), calls: MobileOwnerPrivateRequest[] = [];
  const stored: { auth: MobileSealedState; playback: MobileSealedState } = {
    auth: { kind: 'missing', datasetId: DATASET, revision: 0 }, playback: { kind: 'missing', datasetId: DATASET, revision: 0 },
  };
  const faults: { authLoad?: unknown; playbackLoad?: unknown; save?: 'not-sent' | 'unknown'; current?: unknown; afterSave?: () => void; onPlaybackSave?: () => void } = {};
  async function owner(request: MobileOwnerPrivateRequest): Promise<MobileOwnerPrivateResult> {
    calls.push(structuredClone(request));
    if (request.kind === 'load' || request.kind === 'playback-load') {
      const field = request.kind === 'load' ? 'authLoad' : 'playbackLoad', error = faults[field];
      if (error !== undefined) { delete faults[field]; throw error; }
      return structuredClone(stored[request.kind === 'load' ? 'auth' : 'playback']);
    }
    if (request.kind === 'save' || request.kind === 'playback-save') {
      const field = request.kind === 'save' ? 'auth' : 'playback', previous = stored[field];
      if (field === 'playback') faults.onPlaybackSave?.();
      const failure = field === 'playback' ? faults.save : undefined;
      if (failure === 'not-sent') throw new MobileAuthPersistenceError(failure);
      if (previous.revision !== request.request.expectedRevision) return { kind: 'conflict', datasetId: DATASET, currentRevision: previous.revision };
      stored[field] = { kind: 'sealed', datasetId: DATASET, revision: previous.revision + 1,
        commitId: request.request.commitId, sealed: new Uint8Array(request.request.sealed) };
      if (failure === 'unknown') throw new MobileAuthPersistenceError(failure);
      if (field === 'playback') faults.afterSave?.();
      return { kind: 'saved', datasetId: DATASET, revision: previous.revision + 1, commitId: request.request.commitId };
    }
    throw new MobileServiceError(400, 'INVALID_REQUEST');
  }
  const service = createMobileBackend({ serverId: SERVER, datasetId: DATASET, authKey: key,
    displayName: '准备链合成桥', environment: 'development', requestOwner: owner, assertCurrent() { if (faults.current !== undefined) throw faults.current; },
    resizeArtwork() { throw new MobileServiceError(400, 'INVALID_REQUEST'); }, enablePlayback: true });
  service.activatePlayback(ORIGIN);
  const permit = await service.auth.issuePairing(), pair = await service.auth.claim({ pairingSecret: permit.pairingSecret,
    installationId: 'installation.preparation-fixture', deviceName: '合成手机' }, 'claim.preparation-fixture');
  t.after(async () => {
    delete faults.current; delete faults.afterSave; delete faults.save; delete faults.onPlaybackSave;
    try { await service.close(); } finally { key.fill(0); for (const row of Object.values(stored)) if (row.kind === 'sealed') row.sealed.fill(0); }
  });
  const playbackKey = new Uint8Array(createHmac('sha256', key).update('musicbridge-mobile-playback-v1').digest());
  const crypto = createMobileAuthCrypto(playbackKey); playbackKey.fill(0);
  function seedPlayback(plain: string, corrupt = false) {
    const revision = 1, commitId = '40000000-0000-4000-8000-000000000001';
    const sealed = crypto.seal(Buffer.from(plain), Buffer.from(JSON.stringify(['MBM002_PLAYBACK_STATE_V1', SERVER, DATASET, revision])));
    if (corrupt) sealed[sealed.length - 1] = sealed[sealed.length - 1]! ^ 1;
    stored.playback = { kind: 'sealed', datasetId: DATASET, revision, commitId, sealed };
    const request = { kind: 'playback-load' as const, datasetId: DATASET };
    assert.ok(isMobileOwnerPrivateResult(stored.playback, request));
    assert.equal(isMobileOwnerPrivateResult({ ...stored.playback, commitId: 'commit.preparation-fixture' }, request), false);
  }
  const create = () => service.playbackBackend!.dispatch({ operation: 'createSession', request: sessionRequest(), accessToken: pair.accessToken,
    signal: new AbortController().signal, origin: ORIGIN, headers: [] });
  return { service, stored, faults, calls, seedPlayback, create };
}

test('移动准备首因：原身份读取与发送前拒绝保留安全首错及请求散列，会话未入场不冒成功', { concurrency: false }, async t => {
  const ordinary: { body: Buffer; calls: string[] }[] = [];
  for (const enabled of [false, true]) {
    const base = await fixture(t), observation = createMobilePreparationProbe({ enabled }); observation.arm();
    const own = observation.claim('getServer', randomUUID(), new AbortController().signal);
    const reply = await withMobileCapabilityContext(own, () => base.service.backend.dispatch(identityInput()));
    await withMobileCapabilityContext(own, () => reply.beforeSend!());
    if (own) finish(observation, own);
    ordinary.push({ body: Buffer.from(reply.body), calls: base.calls.map(row => row.kind) });
  }
  assert.deepEqual(ordinary[0], ordinary[1]);
  const f = await fixture(t), probe = createMobilePreparationProbe({ enabled: true }); probe.arm();
  const denied = new MobileAuthPersistenceError('not-sent'), value = context(probe, 'getServer');
  f.faults.authLoad = denied;
  await assert.rejects(withMobileCapabilityContext(value, () => f.service.backend.dispatch(identityInput())), { code: 'BUSY' });
  finish(probe, value, true);
  assert.equal(first(probe, value)?.stage, 'preparation.auth.owner-load');
  assert.equal(first(probe, value)?.outcome, 'not-sent');
  assert.equal(first(probe, value)?.name, 'UNKNOWN');
  assert.equal(probe.snapshot().sessionClaimed, false);
  assert.equal(f.calls.filter(row => row.kind.startsWith('playback-')).length, 0);

  const g = await fixture(t), aliveProbe = createMobilePreparationProbe({ enabled: true }); aliveProbe.arm();
  const alive = context(aliveProbe, 'getServer'), request = identityInput();
  const reply = await withMobileCapabilityContext(alive, () => g.service.backend.dispatch(request));
  const body = Buffer.from(reply.body), error = new MobileAuthPersistenceError('unknown'); g.faults.authLoad = error;
  await assert.rejects(withMobileCapabilityContext(alive, () => reply.beforeSend!()), failure => failure === error);
  finish(aliveProbe, alive, true);
  assert.equal(first(aliveProbe, alive)?.stage, 'main.beforeSend.alive');
  assert.equal(first(aliveProbe, alive)?.outcome, 'unknown');
  assert.deepEqual(Buffer.from(reply.body), body);
  assert.equal(copyMobilePreparationSnapshot(aliveProbe.snapshot())?.scopes.length, 1);
});

test('移动准备首因：原Owner回执后解密及状态拒绝、提交不确定和已保存后回包失败分别归因', { concurrency: false }, async t => {
  // 原wire只接受精确Uint8Array；保留Buffer负例，不能用放宽codec掩盖夹具问题。
  const rejectedBuffer = decodeMobileRequest('createSession', { method: 'POST', path: '/mobile/v1/sessions',
    headers: [['Content-Type', 'application/json'], ['Idempotency-Key', 'session.preparation-fixture']], query: [],
    body: Buffer.from(JSON.stringify({ clientInstanceId: 'client.preparation-fixture' })) },
  { responseOrigin: ORIGIN, requestPath: '/mobile/v1/sessions' });
  assert.equal(rejectedBuffer.ok, false);
  for (const scenario of ['decrypt', 'json', 'state', 'load', 'not-sent', 'unknown', 'after-ack'] as const) {
    const f = await fixture(t), probe = createMobilePreparationProbe({ enabled: true }); probe.arm();
    if (scenario === 'decrypt') f.seedPlayback('{}', true);
    if (scenario === 'json') f.seedPlayback('{');
    if (scenario === 'state') f.seedPlayback('{}');
    if (scenario === 'load') f.faults.playbackLoad = new MobileAuthPersistenceError('not-sent');
    if (scenario === 'not-sent' || scenario === 'unknown') f.faults.save = scenario;
    const currentError = new MobileServiceError(503, 'BUSY');
    const value = context(probe, 'createSession');
    if (scenario === 'after-ack') {
      const reply = await withMobileCapabilityContext(value, f.create);
      assert.ok(reply.kind === 'buffered'); assert.equal(reply.status, 201);
      f.faults.current = currentError;
      const body = Buffer.from(reply.body);
      await assert.rejects(withMobileCapabilityContext(value, () => reply.beforeSend!()), failure => failure === currentError);
      assert.deepEqual(Buffer.from(reply.body), body);
    } else await assert.rejects(withMobileCapabilityContext(value, f.create), { code: 'BUSY' });
    finish(probe, value, true);
    const expected = scenario === 'decrypt' ? 'preparation.playback.decrypt'
      : scenario === 'json' || scenario === 'state' ? 'preparation.playback.state'
      : scenario === 'load' ? 'preparation.playback.owner-load'
      : scenario === 'after-ack' ? 'preparation.main.beforeSend.current' : 'preparation.playback.owner-save';
    assert.equal(first(probe, value)?.stage, expected, scenario);
    if (scenario === 'load' || scenario === 'not-sent' || scenario === 'unknown') assert.equal(first(probe, value)?.outcome, scenario === 'load' ? 'not-sent' : scenario);
    const saves = f.calls.filter(row => row.kind === 'playback-save');
    assert.equal(saves.length, ['not-sent', 'unknown', 'after-ack'].includes(scenario) ? 1 : 0);
    const snapshot = f.service.playbackSnapshot()!;
    assert.equal(snapshot.pendingPersistence, scenario === 'unknown');
    assert.equal(snapshot.receipts, scenario === 'after-ack' ? 1 : 0);
    if (scenario === 'after-ack' || scenario === 'unknown') assert.equal(f.stored.playback.kind, 'sealed');
    const rows = probe.snapshot().scopes[0]!.trace.records;
    if (['decrypt', 'json', 'state'].includes(scenario)) assert.ok(rows.some(row => row.stage === 'preparation.playback.owner-load' && row.phase === 'ok'));
    if (scenario === 'after-ack') assert.ok(rows.some(row => row.stage === 'preparation.playback.ack' && row.phase === 'ok'));
    delete f.faults.current;
  }
});

test('移动准备首因：成功能力回包才开启窗口，保留会话资格与迟到首错，诊断故障不改业务及私有导出', { concurrency: false }, async t => {
  // 使用原真实一秒sweep，不能用会丢失AsyncResource继承关系的mock timer证明ALS隔离。
  let authoritativeNow = Date.now();
  const clock = t.mock.method(Date, 'now', () => authoritativeNow);
  const background = await fixture(t), backgroundProbe = createMobilePreparationProbe({ enabled: true }); backgroundProbe.arm();
  const backgroundContext = context(backgroundProbe, 'createSession');
  await withMobileCapabilityContext(backgroundContext, background.create);
  const recordsBeforeSweep = backgroundProbe.snapshot().scopes[0]!.trace.records.length;
  let sawSweep!: () => void;
  const sweep = new Promise<void>(resolve => { sawSweep = resolve; });
  background.faults.onPlaybackSave = sawSweep; background.faults.save = 'not-sent';
  authoritativeNow += 1_800_001;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([sweep, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('原sweep未到达合成存储')), 3_000); })]);
    await new Promise<void>(resolve => setImmediate(resolve));
    const rowsAfterSweep = backgroundProbe.snapshot().scopes[0]!.trace.records.length;
    finish(backgroundProbe, backgroundContext);
    const rowsAfterTerminal = backgroundProbe.snapshot().scopes[0]!.trace.records.length;
    let releaseClosed!: () => void;
    const closedWork = new Promise<void>(resolve => { releaseClosed = resolve; });
    const direct = withMobileCapabilityContext(backgroundContext, () => mobilePreparationAsync('preparation.playback.expire-save', () => closedWork));
    assert.deepEqual({ saves: background.calls.filter(row => row.kind === 'playback-save').length,
      first: first(backgroundProbe, backgroundContext), sweepAddedRows: rowsAfterSweep !== recordsBeforeSweep,
      closedAddedRows: backgroundProbe.snapshot().scopes[0]!.trace.records.length !== rowsAfterTerminal,
      pending: backgroundProbe.snapshot().scopes[0]!.workPending, originalPromise: direct === closedWork },
    { saves: 2, first: undefined, sweepAddedRows: false, closedAddedRows: false, pending: false, originalPromise: true });
    releaseClosed(); await direct;
  } finally { if (timeout) clearTimeout(timeout); clock.mock.restore(); await background.service.close(); }
  let clockCalls = 0;
  const off = createMobilePreparationProbe({ now() { clockCalls++; throw new Error('关闭窗口不读时钟'); } });
  off.arm(); assert.equal(off.claim('getServer', randomUUID(), new AbortController().signal), undefined);
  assert.equal(off.snapshot().armed, false); assert.equal(clockCalls, 0);
  const probe = createMobilePreparationProbe({ enabled: true });
  assert.equal(probe.claim('getServer', randomUUID(), new AbortController().signal), undefined); probe.arm();
  const identities = Array.from({ length: 8 }, () => context(probe, 'getServer'));
  assert.equal(probe.claim('getServer', randomUUID(), new AbortController().signal), undefined);
  const session = context(probe, 'createSession'); finish(probe, session, false, 201);
  const denied = new MobileAuthPersistenceError('unknown');
  assert.throws(() => withMobileCapabilityContext(identities[0], () => mobilePreparationSync('preparation.auth.owner-load', () => { throw denied; })), failure => failure === denied);
  for (const value of identities) finish(probe, value, value === identities[0]);
  assert.equal(probe.snapshot().identityClaims, 8); assert.equal(probe.snapshot().identityDropped, 1);
  assert.equal(probe.snapshot().truncated, true);
  assert.equal(probe.snapshot().sessionClaimed, true); assert.equal(first(probe, identities[0]!)?.outcome, 'unknown');
  assert.ok(copyMobilePreparationSnapshot(probe.snapshot()));

  const lateProbe = createMobilePreparationProbe({ enabled: true, sink() { throw new Error('不可影响业务的sink'); } }); lateProbe.arm();
  const late = context(lateProbe, 'createSession'); let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const pending = withMobileCapabilityContext(late, () => mobilePreparationAsync('preparation.main.control', async () => { await gate; throw denied; }));
  const observed = assert.rejects(pending, failure => failure === denied);
  finish(lateProbe, late, true);
  assert.equal(lateProbe.snapshot().scopes[0]!.workPending, true);
  assert.equal(late.closed, false); release(); await observed;
  assert.equal(first(lateProbe, late)?.stage, 'preparation.main.control'); assert.equal(late.closed, true);
  assert.equal(lateProbe.snapshot().scopes[0]!.workPending, false);
  let ticks = 0;
  const failedClock = createMobilePreparationProbe({ enabled: true, now() { if (ticks++ > 0) throw new Error('诊断时钟故障'); return 0; } }); failedClock.arm();
  const timed = context(failedClock, 'getServer');
  assert.equal(withMobileCapabilityContext(timed, () => mobilePreparationSync('preparation.auth.envelope', () => 7)), 7);
  finish(failedClock, timed); assert.equal(failedClock.snapshot().scopes[0]!.clockFault, true);
  assert.ok(failedClock.snapshot().scopes[0]!.trace.droppedRecords > 0);
  assert.equal(failedClock.snapshot().truncated, true);
  const capped = createMobilePreparationProbe({ enabled: true }); capped.arm(); const cap = context(capped, 'getServer');
  withMobileCapabilityContext(cap, () => { for (let index = 0; index < 120; index++) mobilePreparationSync('preparation.auth.envelope', () => undefined); });
  assert.throws(() => withMobileCapabilityContext(cap, () => mobilePreparationSync('preparation.auth.capture', () => { throw denied; })), failure => failure === denied);
  finish(capped, cap, true); assert.ok(capped.snapshot().scopes[0]!.trace.droppedRecords > 0); assert.equal(first(capped, cap)?.stage, 'preparation.auth.capture');
  let getters = 0;
  const hostile = Object.defineProperty({}, 'code', { get() { getters++; throw new Error('不能执行异常getter'); } });
  const hostileProbe = createMobilePreparationProbe({ enabled: true }); hostileProbe.arm(); const hostileContext = context(hostileProbe, 'getServer');
  assert.throws(() => withMobileCapabilityContext(hostileContext, () => mobilePreparationSync('preparation.auth.capture', () => { throw hostile; })), failure => failure === hostile);
  finish(hostileProbe, hostileContext, true); assert.equal(getters, 0); assert.equal(first(hostileProbe, hostileContext)?.code, 'UNKNOWN');

  const parent = process.env.TMPDIR ?? '/Volumes/LifeWeave/Developer/CommandLine/tmp';
  if (!parent.startsWith('/Volumes/LifeWeave/Developer/CommandLine/')) throw new Error('合成材料必须存于外置LifeWeave。');
  const directory = await mkdtemp(path.join(parent, 'mobile-preparation-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = randomBytes(32), tls = await loadOrCreateMobileIdentity({ directory: path.join(directory, 'identity'), hosts: ['127.0.0.1'], secretProtector: {
    encryptString(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]); },
    decryptString(value) { const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8'); },
  } });
  const wireProbe = createMobilePreparationProbe({ enabled: true }); let uiFails = true, badReply = false, posts = 0;
  const server = createMobileHttpsServer({ tls: { key: tls.privateKeyPEM, cert: tls.certificatePEM }, host: '127.0.0.1', port: 0, preparationProbe: wireProbe,
    backend: { async dispatch() { if (badReply) return { status: 200, headers: [], body: new Uint8Array([1]) }; throw new MobileServiceError(503, 'BUSY'); } },
    playback: { async resourceCapabilities() { throw new MobileServiceError(400, 'INVALID_REQUEST'); }, async dispatch() {
      posts++; if (posts === 1) throw new MobileServiceError(401, 'UNAUTHORIZED'); throw denied;
    } },
    dsd: { async dispatch() {
      if (uiFails) throw new MobileServiceError(503, 'BUSY');
      const encoded = encodeMobileJsonReply('getUIContentCapabilities', { status: 200, category: 'success', body: {
        version: '1.0.0', addedAlbums: 'unsupported', neteaseDailyRecommendations: 'unsupported', lyrics: 'unsupported',
        resourceFormatBitDepth: true, resourceDsdToPcm: false,
      } }, { responseOrigin: ORIGIN, requestPath: '/mobile/v1/ui/capabilities' }); assert.ok(encoded.ok); return encoded.value;
    } },
  });
  const listening = await server.start(); t.after(async () => { await server.close(); key.fill(0); });
  async function request(target: string, post = false) {
    return new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
      const body = post ? Buffer.from(JSON.stringify({ clientInstanceId: 'client.preparation-fixture' })) : undefined;
      const req = httpsRequest(new URL(target, listening.baseUrl), { method: post ? 'POST' : 'GET', rejectUnauthorized: false,
        headers: { ...(body ? { 'Content-Type': 'application/json', 'Content-Length': body.length, 'Idempotency-Key': 'session.preparation-fixture' } : {}) } }, response => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.once('end', () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks) })); response.once('error', reject);
      }); req.once('error', reject); req.end(body);
    });
  }
  assert.equal((await request('/mobile/v1/ui/capabilities')).status, 503); assert.equal(wireProbe.snapshot().armed, false);
  uiFails = false; assert.equal((await request('/mobile/v1/ui/capabilities')).status, 200); assert.equal(wireProbe.snapshot().armed, true);
  badReply = true; const identityFailure = await request('/mobile/v1/server'); assert.equal(identityFailure.status, 503);
  assert.equal(wireProbe.snapshot().scopes[0]!.trace.firstBusinessFailures[0]?.stage, 'preparation.http.capture');
  const intermediate = await request('/mobile/v1/sessions', true); assert.equal(intermediate.status, 401); assert.equal(posts, 1);
  assert.equal(wireProbe.snapshot().scopes[1]!.terminal, 'intermediate');
  const sessionFailure = await request('/mobile/v1/sessions', true); assert.equal(sessionFailure.status, 503); assert.equal(posts, 2);
  const resources = await Promise.all(Array.from({ length: 3 }, () => request('/mobile/v1/sessions/session.preparation-fixture/resources', true)));
  assert.deepEqual(resources.map(value => value.status), [400, 400, 400]); assert.equal(posts, 2);
  const wire = wireProbe.snapshot(); assert.equal(wire.scopes.length, 3); assert.equal(wire.scopes[2]!.terminal, 'reject');
  assert.equal(wire.resourceScopes.length, 2); assert.equal(wire.resourceClaims, 2); assert.equal(wire.resourceDropped, 1);
  for (const resource of wire.resourceScopes) {
    assert.equal(resource.trace.firstBusinessFailures[0]?.stage, 'preparation.http.resource-capabilities');
    assert.equal(resource.trace.firstBusinessFailures[0]?.code, 'INVALID_REQUEST'); assert.equal(resource.httpStatus, 400);
    assert.ok(resource.trace.records.some(row => row.stage === 'preparation.http.terminal' && row.phase === 'ok'));
  }
  assert.equal(wire.scopes[2]!.trace.firstBusinessFailures[0]?.outcome, 'unknown');
  assert.equal(wire.scopes[1]!.intentSha256, wire.scopes[2]!.intentSha256); assert.ok(wire.sessionIntentSha256);
  const identityNonce = JSON.parse(identityFailure.body.toString('utf8')).error.requestId as string;
  const sessionNonce = JSON.parse(sessionFailure.body.toString('utf8')).error.requestId as string;
  assert.equal(wire.scopes[0]!.requestSha256, mobileCapabilityRequestSha('http', identityNonce));
  assert.equal(wire.scopes[2]!.requestSha256, mobileCapabilityRequestSha('http', sessionNonce));
  const intermediateNonce = JSON.parse(intermediate.body.toString('utf8')).error.requestId as string;
  assert.equal(wire.scopes[1]!.requestSha256, mobileCapabilityRequestSha('http', intermediateNonce));
  const isolated = createMobilePreparationProbe({ enabled: true }); isolated.arm();
  const original = context(isolated, 'createSession'); isolated.associateSession(original, 'original.intent'); finish(isolated, original, true, 401);
  const other = context(isolated, 'createSession'); isolated.associateSession(other, 'other.intent'); finish(isolated, other, true);
  assert.equal(isolated.snapshot().scopes.length, 1); assert.equal(isolated.snapshot().discardedScopes, 1);
  assert.equal(isolated.snapshot().truncated, true); assert.ok(copyMobilePreparationSnapshot(isolated.snapshot()));
  const recorder = new MainDiagnosticRecorder(), input: DiagnosticReportWriteInput = {
    platform: { platform: 'darwin', arch: 'arm64', appVersion: '0.1.0-beta.2', electronVersion: '43.4.0', nodeVersion: '22.23.2' },
    main: recorder.snapshot(), core: { ...recorder.snapshot(), component: 'core' },
    privateEvidence: { version: 1, localAlbum: { schema: 'v39.local-album-safe-trace.v1', records: [], firstRejects: [], droppedRecords: 0 }, localPlayback: [], mobilePreparation: wire },
  };
  const file = path.join(directory, 'accepted.json'); await writeDiagnosticReport(file, input);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const text = await readFile(file, 'utf8'); assert.deepEqual(JSON.parse(text).privateEvidence.mobilePreparation, wire);
  assert.equal(text.includes(identityNonce), false); assert.equal(text.includes(sessionNonce), false); assert.equal(text.includes(intermediateNonce), false);
  assert.doesNotMatch(text, /pairingSecret|accessToken|sealed|私密正文|client\.preparation-fixture/u);
  const poison = { ...wire, privatePayload: '私密正文' };
  const getter = Object.defineProperty({ ...wire }, 'scopes', { enumerable: true, get() { getters++; throw new Error('禁止getter'); } });
  const proxy = new Proxy(wire, { ownKeys() { getters++; throw new Error('禁止代理'); } });
  for (const invalid of [poison, getter, proxy]) {
    assert.equal(copyMobilePreparationSnapshot(invalid), null);
    await assert.rejects(writeDiagnosticReport(path.join(directory, 'rejected.json'), { ...input,
      privateEvidence: { ...input.privateEvidence!, mobilePreparation: invalid as MobilePreparationSnapshot } }), /安全闭集/);
  }
  assert.equal(getters, 0); assert.deepEqual((await readdir(directory)).sort(), ['accepted.json', 'identity']);
});
