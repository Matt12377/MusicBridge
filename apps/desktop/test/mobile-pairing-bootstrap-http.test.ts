import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import type { ClientRequest } from 'node:http';
import path from 'node:path';
import { SRP, SrpClient } from 'fast-srp-hap';
import {
  captureMobilePairingBeginReply, mobilePairingCanonicalBinding,
  MOBILE_PAIRING_BOOTSTRAP_FINISH_INFO, MOBILE_PAIRING_BOOTSTRAP_TOKEN_INFO,
  type MobilePairingBeginReply, type MobilePairingBeginRequest,
  type MobilePairingClaim, type MobilePairingFinishReply, type MobileTokenPair,
} from '@music-bridge/contracts';
import { createMobilePairingBootstrap, type MobilePairingBootstrapPrompt } from '../../../packages/bridge-core/src/mobile/pairing-bootstrap.js';
import { MobileServiceError, type Mobile001BackendReply } from '../../../packages/bridge-core/src/mobile/types.js';
import { createMobileHttpsServer } from '../src/main/mobile-https-server.js';
import { createMobilePairingBootstrapHttp, type MobilePairingBootstrapHttpBackend } from '../src/main/mobile-pairing-bootstrap-http.js';
import { loadOrCreateMobileIdentity, type MobileTlsIdentity } from '../src/main/mobile-tls-identity.js';

/** 真 TLS / HTTP / 原解码器 / 新 PAKE 适配；鉴权叶口为合成数据，不代表真实手机或听感。 */
let identity: MobileTlsIdentity, owned = '';
before(async () => {
  const parent = process.env.TMPDIR;
  if (!parent?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/')) throw new Error('合成构建材料必须使用外置目录。');
  owned = await mkdtemp(path.join(parent, 'mousa-pairing-https-'));
  const key = randomBytes(32);
  identity = await loadOrCreateMobileIdentity({ directory: path.join(owned, 'identity'), hosts: ['127.0.0.1'], secretProtector: {
    encryptString(value) {
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
    },
    decryptString(value) {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
    },
  } });
});
after(async () => { if (owned) await rm(owned, { recursive: true, force: true }); });

interface Reply { status: number; body: Buffer; headers: string[] }
interface RequestOptions { method?: string; headers?: string[]; body?: Buffer }
function request(base: string, target: string, options: RequestOptions = {}): { request: ClientRequest; result: Promise<Reply> } {
  const url = new URL(base), headers = ['Host', url.host, 'Connection', 'close', ...(options.headers ?? [])];
  if (options.body !== undefined) headers.push('Content-Length', String(options.body.byteLength));
  let outgoing!: ClientRequest;
  const result = new Promise<Reply>((resolve, reject) => {
    outgoing = httpsRequest({ hostname: url.hostname, port: url.port, method: options.method ?? 'GET', path: target,
      headers, ca: identity.certificatePEM, agent: false }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      response.once('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks), headers: response.rawHeaders }));
      response.once('error', reject); response.once('aborted', () => reject(new Error('合成响应已关闭。')));
    });
    outgoing.once('error', reject); outgoing.setTimeout(5000, () => outgoing.destroy(new Error('合成 HTTPS 等待结束。')));
    outgoing.end(options.body);
  });
  return { request: outgoing, result };
}
const read = (base: string, target: string, options?: RequestOptions) => request(base, target, options).result;
const post = (base: string, target: string, body: unknown) => read(base, target,
  { method: 'POST', headers: ['Content-Type', 'application/json'], body: Buffer.from(JSON.stringify(body)) });
function jsonReply(body: unknown, status = 200): Mobile001BackendReply {
  const bytes = Buffer.from(JSON.stringify(body));
  return { status, headers: [['Content-Type', 'application/json'], ['Content-Length', String(bytes.byteLength)]], body: bytes };
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: test.TestContext, options: {
  bootstrap?: boolean; onPrompt?(prompt: MobilePairingBootstrapPrompt): Promise<void> | void;
  onEnded?(requestId: string): void;
  rejectBeforeSend?: boolean;
} = {}) {
  let adapter: MobilePairingBootstrapHttpBackend | undefined;
  const legacy: string[] = [], prompts = new Map<string, string>(), ended: string[] = [], signals: AbortSignal[] = [];
  const claims: { body: MobilePairingClaim; key: string }[] = [];
  let permits = 0;
  const pair: MobileTokenPair = { serverId: identity.serverId, deviceId: 'device:synthetic-phone',
    accessToken: 'synthetic-access-' + 'a'.repeat(32), refreshToken: 'synthetic-refresh-' + 'r'.repeat(32),
    accessExpiresAt: new Date(Date.now() + 900_000).toISOString(), refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString() };
  const info = { serverId: identity.serverId, displayName: '合成 Mousa 电脑', contractVersion: '0.1.0', environment: 'development' };
  const server = createMobileHttpsServer({ tls: { key: identity.privateKeyPEM, cert: identity.certificatePEM }, host: '127.0.0.1', port: 0,
    backend: { dispatch: async input => {
      legacy.push(input.operation);
      if (input.operation === 'getServer') return jsonReply(info);
      if (input.operation === 'claimPairing') return jsonReply(pair, 201);
      throw new MobileServiceError(401, 'UNAUTHORIZED');
    } },
    ...(options.bootstrap === false ? {} : { pairing: { dispatch: input => {
      if (!adapter) throw new MobileServiceError(503, 'BUSY');
      signals.push(input.signal);
      return adapter.dispatch(input);
    } } satisfies MobilePairingBootstrapHttpBackend }),
  });
  const listening = await server.start();
  const coordinator = createMobilePairingBootstrap({ serverId: identity.serverId, origin: listening.baseUrl,
    certificateSha256: listening.certificateSha256, assertCurrent: () => {},
    onRequest: async prompt => { prompts.set(prompt.requestId, prompt.code); await options.onPrompt?.(prompt); },
    onEnded: requestId => { prompts.delete(requestId); ended.push(requestId); options.onEnded?.(requestId); },
    auth: {
      issuePairing: async () => { permits++; return { pairingSecret: 'synthetic-private-permit-' + 'p'.repeat(32), expiresAt: new Date(Date.now() + 300_000).toISOString() }; },
      claim: async (body, key) => {
        claims.push({ body: { ...body }, key });
        if (options.rejectBeforeSend && claims.length > 1) throw new MobileServiceError(401, 'UNAUTHORIZED');
        return { ...pair };
      },
    } });
  adapter = createMobilePairingBootstrapHttp({ coordinator, serverId: identity.serverId });
  t.after(async () => { try { await server.close(); } finally { await coordinator.close(); } });
  const begin = (overrides: Partial<MobilePairingBeginRequest> = {}): MobilePairingBeginRequest => ({
    protocolVersion: 1, serverId: identity.serverId, certificateSha256: identity.certificateSha256,
    installationId: 'installation:' + randomUUID(), deviceName: '合成 iPhone', clientNonce: randomBytes(32).toString('hex'),
    claimIdempotencyKey: randomUUID(), ...overrides,
  });
  return { ...listening, coordinator, pair, info, legacy, prompts, ended, claims, signals, begin, server,
    get permitCount() { return permits; } };
}

const sha256 = (value: Uint8Array) => createHash('sha256').update(value).digest();
const sha512 = (...values: Uint8Array[]) => { const hash = createHash('sha512'); for (const value of values) hash.update(value); return hash.digest(); };
function prove(begin: MobilePairingBeginRequest, challenge: MobilePairingBeginReply, code: string) {
  const binding = Buffer.from(mobilePairingCanonicalBinding({ ...begin, ...challenge }));
  const username = Buffer.from('mousa-pair:' + sha256(binding).toString('hex'));
  const salt = Buffer.from(challenge.salt, 'hex'), client = new SrpClient(SRP.params.hap, salt, username, Buffer.from(code), randomBytes(32));
  client.setB(Buffer.from(challenge.serverPublicKey, 'hex'));
  const a = client.computeA(), b = Buffer.from(challenge.serverPublicKey, 'hex'), key = client.computeK();
  const group = sha512(SRP.params.hap.N.toBuffer(384)), generator = sha512(SRP.params.hap.g.toBuffer(384));
  for (let index = 0; index < group.length; index++) group[index] = group[index]! ^ generator[index]!;
  const m1 = sha512(group, sha512(username), salt, a, b, key), m2 = sha512(a, m1, key), aad = Buffer.concat([binding, m1, m2]);
  const tokenKey = Buffer.from(hkdfSync('sha256', key, sha256(binding), MOBILE_PAIRING_BOOTSTRAP_TOKEN_INFO, 32));
  const finishKey = Buffer.from(hkdfSync('sha256', key, sha256(binding), MOBILE_PAIRING_BOOTSTRAP_FINISH_INFO, 32));
  return { exchange: { clientPublicKey: a.toString('hex'), clientProof: m1.toString('hex') }, serverProof: m2.toString('hex'),
    finish: { clientConfirmation: createHmac('sha256', finishKey).update(aad).digest('hex') },
    decrypt(envelope: MobilePairingFinishReply): MobileTokenPair {
      const decipher = createDecipheriv('aes-256-gcm', tokenKey, Buffer.from(envelope.nonce, 'hex'));
      decipher.setAAD(aad); decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'hex')), decipher.final()]).toString('utf8')) as MobileTokenPair;
    } };
}
const route = (challenge: MobilePairingBeginReply, action = '') => '/mobile/v1/pairing-requests/' + encodeURIComponent(challenge.requestId) + (action ? '/' + action : '');
async function start(f: Awaited<ReturnType<typeof fixture>>, begin = f.begin()) {
  const response = await post(f.baseUrl, '/mobile/v1/pairing-requests', begin);
  assert.equal(response.status, 201);
  const checked = captureMobilePairingBeginReply(JSON.parse(response.body.toString('utf8')));
  assert.equal(checked.ok, true);
  if (!checked.ok) throw new Error('合成挑战校验失败。');
  return { begin, challenge: checked.value, response };
}

test('配对HTTPS：未装引导能力继续拒绝新路由，原server与长许可合同仍独立', async t => {
  const f = await fixture(t, { bootstrap: false });
  assert.equal((await post(f.baseUrl, '/mobile/v1/pairing-requests', f.begin())).status, 404);
  const legacy = await read(f.baseUrl, '/mobile/v1/server');
  assert.equal(legacy.status, 200); assert.deepEqual(JSON.parse(legacy.body.toString('utf8')), f.info);
  const body = { pairingSecret: 'synthetic-long-permit-' + 's'.repeat(32), installationId: 'installation:legacy', deviceName: '旧手机' };
  const claim = await read(f.baseUrl, '/mobile/v1/pairings/claim', { method: 'POST', headers: ['Content-Type', 'application/json', 'Idempotency-Key', randomUUID()], body: Buffer.from(JSON.stringify(body)) });
  assert.equal(claim.status, 201);
  const short = await read(f.baseUrl, '/mobile/v1/pairings/claim', { method: 'POST', headers: ['Content-Type', 'application/json', 'Idempotency-Key', randomUUID()], body: Buffer.from(JSON.stringify({ ...body, pairingSecret: '123456' })) });
  assert.equal(short.status, 400); assert.deepEqual(f.legacy, ['getServer', 'claimPairing']);
});

test('配对HTTPS：挑战绑定真实TLS叶身份与实际源站，公开回包无短码或原许可', async t => {
  const f = await fixture(t), { challenge, response } = await start(f);
  assert.equal(challenge.origin, f.baseUrl); assert.equal(challenge.certificateSha256, identity.certificateSha256);
  assert.match(f.prompts.get(challenge.requestId)!, /^[0-9]{6}$/u);
  assert.equal(f.permitCount, 0); assert.equal(f.claims.length, 0); assert.equal(f.legacy.length, 0);
  assert.equal('code' in challenge, false); assert.equal('pairingSecret' in challenge, false);
  assert.equal(response.headers.some((value, index) => index % 2 === 0 && /^(set-cookie|location)$/iu.test(value)), false);
  assert.ok(response.headers.some((value, index) => index % 2 === 0 && value.toLowerCase() === 'cache-control' && response.headers[index + 1] === 'no-store'));
  assert.equal((await post(f.baseUrl, '/mobile/v1/pairing-requests', f.begin({ certificateSha256: '0'.repeat(64) }))).status, 401);
  assert.equal((await post(f.baseUrl, '/mobile/v1/pairing-requests', f.begin({ serverId: 'server:wrong' }))).status, 401);
  assert.equal(f.prompts.size, 1);
});

test('配对HTTPS：认证头、Cookie、query、重复JSON键、错类型及超预算正文均在新路由拒绝', async t => {
  const f = await fixture(t), body = Buffer.from(JSON.stringify(f.begin()));
  for (const extra of [['Authorization', 'Bearer synthetic-token'], ['Cookie', 'synthetic=cookie'], ['X-Forwarded-For', '192.168.1.2']]) {
    assert.equal((await read(f.baseUrl, '/mobile/v1/pairing-requests', { method: 'POST', headers: ['Content-Type', 'application/json', ...extra], body })).status, 400);
  }
  assert.equal((await read(f.baseUrl, '/mobile/v1/pairing-requests?extra=1', { method: 'POST', headers: ['Content-Type', 'application/json'], body })).status, 400);
  for (const headers of [[], ['Content-Type', 'text/plain'], ['Content-Type', 'application/json', 'content-type', 'application/json']]) {
    assert.equal((await read(f.baseUrl, '/mobile/v1/pairing-requests', { method: 'POST', headers, body })).status, 400);
  }
  const duplicate = Buffer.from(body.toString('utf8').replace('{', '{"protocolVersion":1,'));
  assert.equal((await read(f.baseUrl, '/mobile/v1/pairing-requests', { method: 'POST', headers: ['Content-Type', 'application/json'], body: duplicate })).status, 400);
  assert.equal((await post(f.baseUrl, '/mobile/v1/pairing-requests', { ...f.begin(), extra: true })).status, 400);
  assert.equal((await read(f.baseUrl, '/mobile/v1/pairing-requests', { method: 'POST', headers: ['Content-Type', 'application/json'], body: Buffer.alloc(8193, 32) })).status, 413);
  assert.equal(f.prompts.size, 0); assert.equal(f.permitCount, 0); assert.equal(f.claims.length, 0); assert.equal(f.legacy.length, 0);
});

test('配对HTTPS：完整SRP双向证明后才调用原claim，AEAD回包与原令牌一致且finish幂等', async t => {
  const f = await fixture(t), { begin, challenge } = await start(f), proof = prove(begin, challenge, f.prompts.get(challenge.requestId)!);
  const exchanged = await post(f.baseUrl, route(challenge, 'exchange'), proof.exchange);
  assert.equal(exchanged.status, 200); assert.deepEqual(JSON.parse(exchanged.body.toString('utf8')), { serverProof: proof.serverProof });
  assert.equal(f.permitCount, 0); assert.equal(f.claims.length, 0);
  const first = await post(f.baseUrl, route(challenge, 'finish'), proof.finish), second = await post(f.baseUrl, route(challenge, 'finish'), proof.finish);
  assert.equal(first.status, 201); assert.equal(second.status, 201); assert.deepEqual(first.body, second.body);
  assert.deepEqual(proof.decrypt(JSON.parse(first.body.toString('utf8'))), f.pair);
  assert.equal(first.body.includes(Buffer.from(f.pair.accessToken)), false); assert.equal(first.body.includes(Buffer.from(f.pair.refreshToken)), false);
  assert.equal(f.permitCount, 1); assert.ok(f.claims.length >= 2);
  for (const claim of f.claims) { assert.equal(claim.body.installationId, begin.installationId); assert.equal(claim.body.deviceName, begin.deviceName); assert.equal(claim.key, begin.claimIdempotencyKey); }
  assert.equal(f.prompts.size, 0); assert.deepEqual(f.ended, [challenge.requestId]);
  assert.equal((await read(f.baseUrl, route(challenge), { method: 'DELETE' })).status, 409);
});

test('配对HTTPS：零公钥和错误证明不发原许可，失败只关闭对应验证码', async t => {
  const f = await fixture(t), first = await start(f), second = await start(f);
  const rejected = await post(f.baseUrl, route(first.challenge, 'exchange'), { clientPublicKey: '0'.repeat(768), clientProof: '0'.repeat(128) });
  assert.equal(rejected.status, 401); assert.equal(f.prompts.has(first.challenge.requestId), false); assert.equal(f.prompts.has(second.challenge.requestId), true);
  const proof = prove(second.begin, second.challenge, f.prompts.get(second.challenge.requestId)!);
  const changed = proof.exchange.clientProof.startsWith('0') ? '1' : '0';
  const wrong = await post(f.baseUrl, route(second.challenge, 'exchange'), { ...proof.exchange, clientProof: changed + proof.exchange.clientProof.slice(1) });
  assert.equal(wrong.status, 401); assert.equal(f.prompts.size, 0); assert.equal(f.permitCount, 0); assert.equal(f.claims.length, 0);
});

test('配对HTTPS：取消仅删原请求，伪造源站或带正文不能取消，迟到exchange被拒绝', async t => {
  const f = await fixture(t), first = await start(f), second = await start(f);
  assert.equal((await read(f.baseUrl, route(first.challenge), { method: 'DELETE', headers: ['X-Forwarded-For', '127.0.0.1'] })).status, 400);
  assert.equal((await read(f.baseUrl, route(first.challenge), { method: 'DELETE', body: Buffer.from('{}') })).status, 400);
  assert.equal(f.prompts.size, 2);
  assert.equal((await read(f.baseUrl, route(first.challenge), { method: 'DELETE' })).status, 204);
  assert.equal(f.prompts.has(first.challenge.requestId), false); assert.equal(f.prompts.has(second.challenge.requestId), true);
  const proof = prove(first.begin, first.challenge, '000000');
  assert.equal((await post(f.baseUrl, route(first.challenge, 'exchange'), proof.exchange)).status, 401);
  assert.equal(f.permitCount, 0); assert.equal(f.claims.length, 0);
});

test('配对HTTPS：claim后发送围栏检查原回执，已撤销授权不发送加密令牌', async t => {
  const f = await fixture(t, { rejectBeforeSend: true }), { begin, challenge } = await start(f), proof = prove(begin, challenge, f.prompts.get(challenge.requestId)!);
  assert.equal((await post(f.baseUrl, route(challenge, 'exchange'), proof.exchange)).status, 200);
  const finished = await post(f.baseUrl, route(challenge, 'finish'), proof.finish);
  assert.equal(finished.status, 401); assert.equal(f.claims.length, 2); assert.equal(f.permitCount, 1);
  const body = JSON.parse(finished.body.toString('utf8')) as Record<string, unknown>;
  assert.equal('ciphertext' in body, false); assert.equal(finished.body.includes(Buffer.from(f.pair.accessToken)), false);
  assert.equal(finished.body.includes(Buffer.from(f.pair.refreshToken)), false);
});

test('配对HTTPS：展示验证码期间客户端取消，迟到start完成后清除本次请求', { timeout: 5000 }, async t => {
  const seen = deferred<void>(), release = deferred<void>(), cleaned = deferred<void>();
  const f = await fixture(t, { onPrompt: async () => { seen.resolve(); await release.promise; }, onEnded: () => cleaned.resolve() });
  const begun = request(f.baseUrl, '/mobile/v1/pairing-requests', { method: 'POST', headers: ['Content-Type', 'application/json'], body: Buffer.from(JSON.stringify(f.begin())) });
  const failed = assert.rejects(begun.result);
  await seen.promise;
  const signal = f.signals[0]!;
  const remoteAbort = signal.aborted ? Promise.resolve() : new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  begun.request.destroy(); await failed; await remoteAbort; release.resolve(); await cleaned.promise;
  // 等同一请求的远端Abort和精确清理事件，不以本机destroy返回或任意延时冒充服务器已经看到取消。
  assert.equal(f.prompts.size, 0); assert.equal(f.ended.length, 1); assert.equal(f.permitCount, 0); assert.equal(f.claims.length, 0);
});
