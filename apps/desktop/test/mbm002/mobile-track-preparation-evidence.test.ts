import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { AsyncResource } from 'node:async_hooks';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { encodeMobileJsonReply, type MobileTrack } from '@music-bridge/contracts';
import {
  createMobilePreparationProbe, copyMobilePreparationSnapshot, createMobileCapabilityContext,
  createMobileCapabilityTraceReader, captureMobileCapabilityContext, closeMobileCapabilityContext,
  mobileCapabilityRequestSha, mobileCapabilitySync, mobileCapabilityAsync, mobileCapabilityReject,
  mobilePreparationSync, snapshotMobileCapabilityTrace, withMobileCapabilityContext,
  MOBILE_CAPABILITY_TRACE_PREFIX, type MobilePreparationProbe, type MobilePreparationSnapshot,
  type MobileCapabilityContext, type MobileCapabilityStage,
} from '../../../../packages/bridge-core/src/mobile/capability-trace.js';
import { createMobileContentRpcPort } from '../../../../packages/bridge-core/src/mobile/content-rpc-port.js';
import { createMobileNeteaseArtwork } from '../../../../packages/bridge-core/src/netease/mobile-artwork.js';
import { mobileContentTrackFingerprint, type MobileContentCoreRequest } from '../../../../packages/bridge-core/src/mobile/content-rpc.js';
import type { MobileContentScope } from '../../../../packages/bridge-core/src/mobile/content-types.js';
import { MobileServiceError } from '../../../../packages/bridge-core/src/mobile/types.js';
import { createMainMobileContentPort } from '../../src/main/mobile-content-port.js';
import { createMobileHttpsServer } from '../../src/main/mobile-https-server.js';
import { loadOrCreateMobileIdentity } from '../../src/main/mobile-tls-identity.js';
import { MainDiagnosticRecorder, writeDiagnosticReport, type DiagnosticReportWriteInput } from '../../src/main/diagnostics.js';

const scope: MobileContentScope = { serverId: 'server.track-fixture', datasetId: 'dataset.track-fixture',
  deviceId: 'device.track-fixture', deviceEpoch: 1, accessGeneration: 1, ownerEpoch: 'owner.track-fixture',
  accountDomain: 'account.track-fixture', providerEpoch: 'provider.track-fixture' };
const principal = { serverId: scope.serverId, datasetId: scope.datasetId, deviceId: scope.deviceId,
  deviceEpoch: scope.deviceEpoch, accountDomain: scope.accountDomain, generation: 1,
  accessTokenHash: 'a'.repeat(64), accessExpiresAt: '2030-01-01T00:00:00.000Z' };
const track: MobileTrack = { id: 'nt:synthetic:1', source: 'netease', sourceItemId: '1', albumId: 'na:synthetic:1',
  title: '合成曲目正文不进入诊断', artists: ['合成艺人正文'], versionId: 'nv:synthetic:1', contentRevision: 'nr:synthetic:1',
  editionLabel: '', durationMs: 1000, availability: 'available',
  audio: { codec: 'flac', container: 'flac', sampleRateHz: 44100, bitsPerSample: 16, channels: 2 } };
const signal = () => new AbortController().signal;
const changed = () => new MobileServiceError(409, 'SOURCE_CHANGED');
const clock = { now: () => 100, epochNow: () => 1_800_000_000_000 };
const probe = () => { const value = createMobilePreparationProbe({ enabled: true, ...clock }); value.arm(); return value; };
function claim(value: MobilePreparationProbe, id = randomUUID()) {
  const context = value.claim('getTrack', id, signal()); assert.ok(context);
  withMobileCapabilityContext(context, () => mobilePreparationSync('preparation.http.track', () => undefined)); return context;
}
function finish(value: MobilePreparationProbe, context: MobileCapabilityContext, status = 409, finished = true) {
  value.finish(context, { failed: status !== 200, finished, httpStatus: status }); closeMobileCapabilityContext(context);
}
function pair(value: MobilePreparationProbe, root: MobileCapabilityContext) {
  const id = randomUUID(), main = createMobileCapabilityContext(id, 'main', 'content', root.requestSha256, undefined, root.sink, clock); assert.ok(main);
  withMobileCapabilityContext(main, () => mobileCapabilitySync('content.rpc.track.read', () => undefined));
  const core = createMobileCapabilityContext(id, 'core', 'content', null, undefined,
    createMobileCapabilityTraceReader(row => value.acceptCoreTrace(row)), clock); assert.ok(core); return { id, main, core };
}
function assertLinked(snapshot: MobilePreparationSnapshot, slot = 0) {
  const current = snapshot.trackScopes[slot]!;
  const roots = current.trace.records.filter(row => row.component === 'main' && row.requestSha256 === current.requestSha256);
  assert.ok(roots.some(row => row.stage === 'preparation.http.track'));
  for (const row of current.trace.records.filter(row => row.component === 'core')) {
    assert.ok(current.trace.records.some(edge => edge.component === 'main' && edge.requestSha256 === row.requestSha256
      && edge.parentSha256 === current.requestSha256)
      || current.trace.records.some(edge => edge.component === 'main' && edge.phase === 'cache'
        && edge.stage === 'content.initialize.cache' && edge.relatedSha256 === row.requestSha256), 'Core必须有同原content请求或明确初始化cache边');
  }
  assert.ok(copyMobilePreparationSnapshot(snapshot));
  assert.doesNotMatch(JSON.stringify(snapshot), /合成曲目正文|合成艺人正文|https?:|message|stack|accessToken|Cookie|sourceItemId/u);
}

// 只截取本进程原Core闭集stdout，模拟Supervisor现有reader；不从全局环回查或补关联。
function bridgeCore(t: TestContext, value: MobilePreparationProbe) {
  const original = fs.writeSync, reader = createMobileCapabilityTraceReader(row => value.acceptCoreTrace(row));
  const mock = t.mock.method(fs, 'writeSync', ((fd: number, data: unknown, ...args: unknown[]) => {
    if (fd === 1 && typeof data === 'string' && data.startsWith(MOBILE_CAPABILITY_TRACE_PREFIX)) { reader(data); return Buffer.byteLength(data); }
    return Reflect.apply(original, fs, [fd, data, ...args]) as number;
  }) as typeof fs.writeSync);
  syncBuiltinESMExports(); t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
}
type Fault = 'none' | 'read.before' | 'read.after' | 'revalidate.before' | 'revalidate.after' | 'selection' | 'fingerprint' | 'provider' | 'main.scope' | 'artwork';
function ports(t: TestContext, value: MobilePreparationProbe, fault: Fault, enabled = true) {
  bridgeCore(t, value);
  // 原RPC跨进程不会继承Main ALS；合成端口同样用独立async根，不能制造Core假parent。
  const boundary = new AsyncResource('synthetic-track-core-rpc');
  const artwork = createMobileNeteaseArtwork({ serverId: scope.serverId, datasetId: scope.datasetId, ownerEpoch: scope.ownerEpoch,
    namespace: 'abc123', key: new Uint8Array(32).fill(19) });
  t.after(() => artwork.close()); const observed: MobileTrack[] = [];
  const requests = new Map<string, MobileContentCoreRequest>(), checks = new Map<string, number>();
  let reads = 0, scopeReads = 0;
  const originalError = changed();
  const core = createMobileContentRpcPort({ initialize: async () => undefined, invalidateDevice: async () => undefined,
    content: { async dispatch() { throw new MobileServiceError(400, 'INVALID_REQUEST'); } },
    resolveScope: async () => { scopeReads++; return fault === 'main.scope' && scopeReads > 1 ? { ...scope, providerEpoch: 'provider.changed' } : scope; },
    assertScope: () => {
      const hash = captureMobileCapabilityContext()?.requestSha256, request = hash ? requests.get(hash) : undefined;
      if (!hash || request?.action !== 'track') return;
      const count = (checks.get(hash) ?? 0) + 1; checks.set(hash, count);
      if (fault === `${request.operation}.${count === 1 ? 'before' : 'after'}`) throw originalError;
    },
    source: async () => { throw new MobileServiceError(409, 'UNSUPPORTED_FORMAT'); },
    readTrack: async (_scope, _id, expected) => {
      reads++; if (fault === 'provider') throw originalError;
      assert.ok(typeof track.durationMs === 'number');
      const result = { ...structuredClone(track), ...(expected && fault === 'selection' ? { versionId: 'nv:synthetic:changed' } : {}),
        ...(expected && fault === 'fingerprint' ? { durationMs: track.durationMs + 1 } : {}),
        ...(fault === 'artwork' ? { artworkId: artwork.bind(scope, 's', '1', `https://p${expected ? 2 : 1}.music.126.net/synthetic-cover.jpg`)! } : {}) };
      observed.push(result); return result;
    } });
  const requestCore = async (request: MobileContentCoreRequest, parent: AbortSignal) => {
    const hash = mobileCapabilityRequestSha('content', request.id); assert.ok(hash); requests.set(hash, request);
    return boundary.runInAsyncScope(() => core.request(request, parent));
  };
  const main = createMainMobileContentPort({ serverId: scope.serverId, datasetId: scope.datasetId, key: new Uint8Array(32).fill(17),
    privateProviderDiagnostics: enabled, assertCurrent() {}, requestRpc: requestCore });
  t.after(async () => { await main.close(); await core.close(); boundary.emitDestroy(); });
  return { main, requests, requestCore, observed, reads: () => reads };
}

test('两个专属详情槽保原父链和Core首拒，挤压全局环及资源请求均不消耗详情槽', () => {
  const value = probe(), first = claim(value), a = pair(value, first);
  withMobileCapabilityContext(a.core, () => mobileCapabilityReject('core.track.read.scope.before', changed())); finish(value, first);
  const second = claim(value), b = pair(value, second);
  withMobileCapabilityContext(b.core, () => mobileCapabilityReject('core.track.revalidate.fingerprint', changed())); finish(value, second);
  for (let i = 0; i < 12; i++) {
    const flood = createMobileCapabilityContext(randomUUID(), 'main', 'http', null, undefined, () => {}, clock); assert.ok(flood);
    withMobileCapabilityContext(flood, () => { for (let j = 0; j < 32; j++) mobileCapabilitySync('main.current', () => undefined); });
  }
  assert.equal(snapshotMobileCapabilityTrace().records.some(row => row.requestSha256 === a.core.requestSha256), false);
  assert.equal(value.claim('getTrack', randomUUID(), signal()), undefined);
  const resource = value.claim('createResource', randomUUID(), signal()); assert.ok(resource);
  value.finish(resource, { failed: false, finished: true, httpStatus: 201 }); closeMobileCapabilityContext(resource);
  const captured = value.snapshot(); assert.equal(captured.trackClaims, 2); assert.equal(captured.trackDropped, 1);
  assert.equal(captured.resourceClaims, 1); assert.equal(captured.scopes.length, 0); assert.equal(captured.contextFaults, 0);
  assert.equal(captured.trackScopes[0]!.trace.firstBusinessFailures.find(row => row.component === 'core')?.stage, 'core.track.read.scope.before');
  assert.equal(captured.trackScopes[1]!.trace.firstBusinessFailures.find(row => row.component === 'core')?.stage, 'core.track.revalidate.fingerprint');
  assertLinked(captured); assertLinked(captured, 1);
});

test('原Main→Core track guard逐支保留首拒，业务409不放宽且不依赖时间相近', async t => {
  const cases: [Fault, MobileCapabilityStage][] = [
    ['read.before', 'core.track.read.scope.before'], ['read.after', 'core.track.read.scope.after'],
    ['revalidate.before', 'core.track.revalidate.scope.before'], ['revalidate.after', 'core.track.revalidate.scope.after'],
    ['selection', 'core.track.revalidate.selection'], ['fingerprint', 'core.track.revalidate.fingerprint.other'],
    ['provider', 'core.provider.read'], ['main.scope', 'main.track.revalidate.scope'],
  ];
  for (const [fault, stage] of cases) await t.test(fault, async child => {
    const value = probe(), context = claim(value), h = ports(child, value, fault);
    await assert.rejects(withMobileCapabilityContext(context, async () => {
      const result = await h.main.track(principal, track.id, signal()); await result.beforeSend();
    }), error => error instanceof MobileServiceError && error.status === 409 && error.code === 'SOURCE_CHANGED');
    finish(value, context);
    const captured = value.snapshot(), first = captured.trackScopes[0]!.trace.firstBusinessFailures;
    assert.ok(first.some(row => row.stage === stage && row.code === 'SOURCE_CHANGED'), stage);
    if (fault !== 'main.scope') assert.equal(first.find(row => row.component === 'core')?.stage, stage);
    assertLinked(captured); assert.ok(h.reads() <= 2);
  });
});

test('仅合法图片CDN主机p1换p2使原artworkId及完整fingerprint变化，原409保留且只标封面字段漂移', async t => {
  const value = probe(), context = claim(value), h = ports(t, value, 'artwork');
  await assert.rejects(withMobileCapabilityContext(context, async () => {
    const selected = await h.main.track(principal, track.id, signal()); await selected.beforeSend();
  }), error => error instanceof MobileServiceError && error.status === 409 && error.code === 'SOURCE_CHANGED');
  finish(value, context);
  const [before, after] = h.observed; assert.ok(before?.artworkId); assert.ok(after?.artworkId); assert.notEqual(before.artworkId, after.artworkId);
  const { artworkId: _first, ...restBefore } = before, { artworkId: _second, ...restAfter } = after;
  assert.deepEqual(restBefore, restAfter); assert.deepEqual(before.audio, after.audio);
  const captured = value.snapshot();
  assert.equal(captured.trackScopes[0]!.trace.firstBusinessFailures.find(row => row.component === 'core')?.stage, 'core.track.revalidate.fingerprint.artwork-only');
  assertLinked(captured); assert.doesNotMatch(JSON.stringify(captured), /music\.126|synthetic-cover|naw:|p[12]\.music/u);
});

test('没有原read基线或provider epoch已改变均标missing，不拿跨scope哈希推导other或artwork-only', async t => {
  for (const priorRead of [false, true]) await t.test(String(priorRead), async child => {
    const value = probe(), root = claim(value), h = ports(child, value, 'fingerprint');
    await withMobileCapabilityContext(root, () => priorRead ? h.main.track(principal, track.id, signal()) : h.main.resolveScope(principal, signal()));
    const linked = pair(value, root), actualScope = priorRead ? { ...scope, providerEpoch: 'provider.new-epoch' } : scope;
    const result = await h.requestCore({ type: 'mobile-content-core-request', id: linked.id, action: 'track', operation: 'revalidate', scope: actualScope,
      trackId: track.id, expectedSelection: { trackId: track.id, source: 'netease', versionId: track.versionId, contentRevision: track.contentRevision },
      expectedFingerprint: mobileContentTrackFingerprint(track) }, signal());
    assert.ok('kind' in result && result.kind === 'error' && result.code === 'SOURCE_CHANGED'); finish(value, root);
    const captured = value.snapshot();
    assert.equal(captured.trackScopes[0]!.trace.firstBusinessFailures.find(row => row.requestSha256 === linked.core.requestSha256)?.stage,
      'core.track.revalidate.fingerprint.baseline-missing'); assertLinked(captured);
  });
});

test('稳定read/revalidate保持完整DTO及执行次数，默认关闭不创建详情诊断', async t => {
  for (const enabled of [true, false]) await t.test(String(enabled), async child => {
    const value = enabled ? probe() : createMobilePreparationProbe(); value.arm();
    const context = value.claim('getTrack', randomUUID(), signal()), h = ports(child, value, 'none', enabled);
    const result = await withMobileCapabilityContext(context, async () => {
      if (context) mobilePreparationSync('preparation.http.track', () => undefined);
      const selected = await h.main.track(principal, track.id, signal()); await selected.beforeSend(); return selected.track;
    });
    assert.deepEqual(JSON.parse(JSON.stringify(result)), track); assert.equal(h.reads(), 2);
    if (context) { finish(value, context, 200); assertLinked(value.snapshot()); }
    assert.equal(value.snapshot().trackClaims, enabled ? 1 : 0);
  });
});

test('同scope两个并发详情仍各有明确HTTP→Main→Core原请求，允许共享的仅是显式初始化cache边', async t => {
  const value = probe(), roots = [claim(value), claim(value)], h = ports(t, value, 'none');
  await Promise.all(roots.map(root => withMobileCapabilityContext(root, async () => {
    const selected = await h.main.track(principal, track.id, signal()); await selected.beforeSend(); finish(value, root, 200);
  })));
  const captured = value.snapshot(); assert.equal(captured.trackClaims, 2); assert.equal(h.reads(), 4);
  const requests = captured.trackScopes.map(current => new Set(current.trace.records
    .filter(row => row.component === 'main' && row.stage.startsWith('content.rpc.track.')).map(row => row.requestSha256)));
  assert.equal(requests[0]!.size, 2); assert.equal(requests[1]!.size, 2);
  for (const id of requests[0]!) assert.equal(requests[1]!.has(id), false);
  assertLinked(captured); assertLinked(captured, 1);
});

test('详情192上限、迟到Core与清理仍归原槽；未知/伪造父链及旧schema闭集拒绝', async () => {
  const value = probe(), root = claim(value), linked = pair(value, root);
  const outsider = createMobileCapabilityContext(randomUUID(), 'core', 'content', null, undefined,
    createMobileCapabilityTraceReader(row => value.acceptCoreTrace(row)), clock); assert.ok(outsider);
  withMobileCapabilityContext(outsider, () => mobileCapabilityReject('core.track.read.scope.before', changed()));
  withMobileCapabilityContext(root, () => { for (let i = 0; i < 300; i++) mobilePreparationSync('preparation.auth.envelope', () => undefined); });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const pending = withMobileCapabilityContext(linked.core, () => mobileCapabilityAsync('core.provider.read', async () => { await gate; throw changed(); }));
  const rejected = assert.rejects(pending, MobileServiceError); finish(value, root, 409, false);
  assert.equal(value.snapshot().trackScopes[0]!.workPending, true);
  const second = claim(value); finish(value, second, 200);
  release(); await rejected; closeMobileCapabilityContext(linked.core);
  withMobileCapabilityContext(linked.core, () => mobileCapabilityReject('core.rpc.failure', changed(), 'cleanup'));
  const captured = value.snapshot(), current = captured.trackScopes[0]!;
  assert.equal(current.workPending, false); assert.ok(current.trace.droppedRecords > 0); assert.ok(current.trace.records.length <= 192);
  assert.equal(current.trace.records.some(row => row.requestSha256 === outsider.requestSha256), false);
  assert.equal(current.trace.firstBusinessFailures.find(row => row.component === 'core')?.stage, 'core.provider.read');
  assert.equal(current.trace.cleanupFailures.length, 1); assert.equal(captured.trackScopes[1]!.trace.cleanupFailures.length, 0); assertLinked(captured);
  const mutate = (work: (snapshot: MobilePreparationSnapshot) => void) => { const bad = structuredClone(captured); work(bad); assert.equal(copyMobilePreparationSnapshot(bad), null); };
  mutate(bad => { bad.trackClaims = 3; }); mutate(bad => { bad.trackScopes.push(bad.trackScopes[0]!); });
  mutate(bad => { bad.trackScopes[0]!.trace.records[0]!.stage = 'core.track.not-approved' as MobileCapabilityStage; });
  mutate(bad => { bad.trackScopes[0]!.trace.records.push({ ...current.trace.firstBusinessFailures[0]!, requestSha256: 'f'.repeat(64) }); });
  assert.equal(copyMobilePreparationSnapshot({ ...captured, schema: 'mb.mobile-preparation-evidence.v2' }), null);
  assert.equal(copyMobilePreparationSnapshot({ ...captured, privatePayload: '禁止正文' }), null);
  let touched = 0; const hostile = Object.defineProperty({ ...captured }, 'trackScopes', { enumerable: true, get() { touched++; return []; } });
  assert.equal(copyMobilePreparationSnapshot(hostile), null); assert.equal(touched, 0);
  const failed = createMobilePreparationProbe({ enabled: true, now() { throw changed(); } }); failed.arm();
  assert.equal(failed.claim('getTrack', randomUUID(), signal()), undefined);
  assert.equal(failed.snapshot().trackContextFaults, 1); assert.equal(failed.snapshot().contextFaults, 0); assert.ok(copyMobilePreparationSnapshot(failed.snapshot()));
});

test('真实loopback HTTPS详情401重放及Core409进入各自有限槽，并由原0600正式导出校验v3', async t => {
  const temporary = process.env.TMPDIR ?? ''; assert.ok(temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/'));
  const directory = await mkdtemp(path.join(temporary, 'track-preparation-fixture-')); t.after(() => rm(directory, { recursive: true, force: true }));
  // 仅合成开发身份；不读取任何用户证书、保险库或账号。
  const key = randomBytes(32); t.after(() => key.fill(0));
  const tls = await loadOrCreateMobileIdentity({ directory: path.join(directory, 'identity'), hosts: ['127.0.0.1'], secretProtector: {
    encryptString(text) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      const bytes = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]); },
    decryptString(bytes) { const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'); },
  } });
  const value = probe(), h = ports(t, value, 'fingerprint'); let calls = 0, origin = 'https://127.0.0.1:9443';
  const server = createMobileHttpsServer({ host: '127.0.0.1', port: 0, tls: { key: tls.privateKeyPEM, cert: tls.certificatePEM }, preparationProbe: value,
    backend: { async dispatch(input) {
      if (input.operation !== 'getTrack' || !input.request.pathParameters.trackId?.startsWith('nt:')) throw new MobileServiceError(404, 'INVALID_REQUEST');
      calls++; if (calls === 1) throw new MobileServiceError(401, 'UNAUTHORIZED');
      const selected = await h.main.track(principal, track.id, input.signal);
      const result = encodeMobileJsonReply('getTrack', { status: 200, category: 'success', body: selected.track },
        { responseOrigin: origin, requestPath: '/mobile/v1/tracks/' + track.id }); assert.ok(result.ok);
      return { ...result.value, beforeSend: selected.beforeSend };
    } } });
  const listening = await server.start(); origin = listening.baseUrl; t.after(() => server.close());
  const request = (target: string) => new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
    const req = httpsRequest(new URL(target, listening.baseUrl), { rejectUnauthorized: false }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.once('end', () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks) })); response.once('error', reject);
    }); req.once('error', reject); req.end();
  });
  assert.equal((await request('/mobile/v1/tracks/lt:synthetic:1')).status, 404); assert.equal(value.snapshot().trackClaims, 0);
  const unauthorized = await request('/mobile/v1/tracks/' + track.id); assert.equal(unauthorized.status, 401);
  const refused = await request('/mobile/v1/tracks/' + track.id); assert.equal(refused.status, 409);
  const response = JSON.parse(refused.body.toString()) as { error: { code: string; requestId: string } }; assert.equal(response.error.code, 'SOURCE_CHANGED');
  const captured = value.snapshot(); assert.equal(captured.trackScopes[1]!.requestSha256, mobileCapabilityRequestSha('http', response.error.requestId));
  assert.equal(captured.trackScopes[0]!.httpStatus, 401); assert.equal(captured.trackScopes[1]!.httpStatus, 409);
  assert.equal(captured.trackScopes[1]!.trace.firstBusinessFailures.find(row => row.component === 'core')?.stage, 'core.track.revalidate.fingerprint.other');
  assert.equal(captured.resourceClaims, 0); assert.equal(captured.identityClaims, 0); assert.equal(captured.sessionClaims, 0); assertLinked(captured, 1);
  assert.equal((await request('/mobile/v1/tracks/' + track.id)).status, 409); assert.equal(value.snapshot().trackDropped, 1); assert.equal(calls, 3);
  const recorder = new MainDiagnosticRecorder(), input: DiagnosticReportWriteInput = {
    platform: { platform: 'darwin', arch: 'arm64', appVersion: '0.1.0-beta.2', electronVersion: '43.4.0', nodeVersion: '22.23.2' },
    main: recorder.snapshot(), core: { ...recorder.snapshot(), component: 'core' },
    privateEvidence: { version: 1, localAlbum: { schema: 'v39.local-album-safe-trace.v1', records: [], firstRejects: [], droppedRecords: 0 },
      localPlayback: [], mobilePreparation: value.snapshot() },
  };
  const output = path.join(directory, 'accepted.json'); await writeDiagnosticReport(output, input);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  const saved = JSON.parse(await readFile(output, 'utf8')); assert.deepEqual(saved.privateEvidence.mobilePreparation, value.snapshot());
  assert.equal(saved.privateEvidence.mobilePreparation.schema, 'mb.mobile-preparation-evidence.v3');
  await assert.rejects(writeDiagnosticReport(path.join(directory, 'rejected.json'), { ...input,
    privateEvidence: { ...input.privateEvidence!, mobilePreparation: { ...value.snapshot(), trackClaims: 3 } } }), /安全闭集/);
});
