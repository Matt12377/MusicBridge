import assert from 'node:assert/strict';
import { createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { SRP, SrpClient } from 'fast-srp-hap';
import {
  mobilePairingCanonicalBinding, type MobilePairingBeginReply, type MobilePairingBeginRequest,
  type MobilePairingBootstrapBinding, type MobilePairingFinishReply, type MobilePairingClaim, type MobileTokenPair,
} from '@music-bridge/contracts';
import { createMobileAuthCrypto } from '../../src/mobile/auth-crypto.js';
import { createMobileAuthService } from '../../src/mobile/auth-service.js';
import {
  createMobilePairingBootstrap, MOBILE_PAIRING_BOOTSTRAP_LIMITS,
  type MobilePairingBootstrapOptions, type MobilePairingBootstrapPeer, type MobilePairingBootstrapPrompt,
} from '../../src/mobile/pairing-bootstrap.js';
import { MobileAuthPersistenceError, MobileServiceError, type MobileSealedState } from '../../src/mobile/types.js';

const START = Date.parse('2026-10-24T10:00:00.000Z');
const SERVER = 'server.synthetic-pairing', DATASET = 'dataset.synthetic-pairing';
const ORIGIN = 'https://192.168.1.20:45391', CERT = 'ab'.repeat(32);
const PEER: MobilePairingBootstrapPeer = { remoteAddress: '192.168.1.30', origin: ORIGIN,
  certificateSha256: CERT, serverId: SERVER };
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest();
const sha512 = (...values: readonly Uint8Array[]) => {
  const digest = createHash('sha512'); for (const value of values) digest.update(value); return digest.digest();
};
const failure = (status: number, code?: string) => (error: unknown) => error instanceof MobileServiceError
  && error.status === status && (code === undefined || error.code === code);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function request(installationId = 'installation.synthetic-one'): MobilePairingBeginRequest {
  return { protocolVersion: 1, serverId: SERVER, certificateSha256: CERT, installationId,
    deviceName: '合成手机', clientNonce: randomBytes(32).toString('hex'), claimIdempotencyKey: 'claim:' + randomBytes(16).toString('hex') };
}

/** 真实原鉴权和AES密封CAS，手机SRP为合成客户端；不是网络或设备验收。 */
function fixture(t: TestContext, overrides: Partial<MobilePairingBootstrapOptions> = {}) {
  let wall = START, monotonic = 1000, ready = true;
  let stored: MobileSealedState = { kind: 'missing', datasetId: DATASET, revision: 0 };
  const auth = createMobileAuthService({ serverId: SERVER, datasetId: DATASET, displayName: '合成电脑',
    environment: 'development', now: () => wall, crypto: createMobileAuthCrypto(randomBytes(32)),
    persistence: {
      async load() { return structuredClone(stored); },
      async save(input) {
        if (input.expectedRevision !== stored.revision) return { kind: 'conflict', datasetId: DATASET, currentRevision: stored.revision };
        stored = { kind: 'sealed', datasetId: DATASET, revision: input.expectedRevision + 1,
          commitId: input.commitId, sealed: new Uint8Array(input.sealed) };
        return { kind: 'saved', datasetId: DATASET, revision: stored.revision, commitId: input.commitId };
      },
    } });
  const prompts = new Map<string, MobilePairingBootstrapPrompt>(), ended: string[] = [];
  const counts = { issues: 0, claims: 0 }, claimInputs: { body: MobilePairingClaim; key: string }[] = [];
  let issueEffect: (() => Promise<Awaited<ReturnType<typeof auth.issuePairing>>>) | undefined;
  let claimEffect: ((body: MobilePairingClaim, key: string) => ReturnType<typeof auth.claim>) | undefined;
  const coordinator = createMobilePairingBootstrap({ serverId: SERVER, origin: ORIGIN, certificateSha256: CERT,
    now: () => wall, monotonicNow: () => monotonic,
    assertCurrent() { if (!ready) throw new MobileServiceError(503, 'BUSY'); },
    auth: {
      async issuePairing() { counts.issues++; return issueEffect ? issueEffect() : auth.issuePairing(); },
      async claim(body, key) { counts.claims++; claimInputs.push({ body: structuredClone(body), key });
        return claimEffect ? claimEffect(body, key) : auth.claim(body, key); },
    },
    onRequest: prompt => { prompts.set(prompt.requestId, prompt); }, onEnded: id => { ended.push(id); }, ...overrides });
  t.after(async () => { await coordinator.close(); await auth.close(); });
  return { coordinator, auth, prompts, ended, counts, claimInputs,
    advance(milliseconds: number) { wall += milliseconds; monotonic += milliseconds; },
    setWall(value: number) { wall = value; }, setReady(value: boolean) { ready = value; },
    setIssueEffect(effect: typeof issueEffect) { issueEffect = effect; },
    setClaimEffect(effect: typeof claimEffect) { claimEffect = effect; },
    async start(body = request(), peer = PEER) { return { body, challenge: await coordinator.start(body, peer) }; },
  };
}

/** 与Swift原生证明公式一致，独立调用成熟库客户端的大整数计算。 */
function client(begin: MobilePairingBeginRequest, challenge: MobilePairingBeginReply, code: string,
  bindingPatch: Partial<MobilePairingBootstrapBinding> = {}) {
  const binding = Buffer.from(mobilePairingCanonicalBinding({ ...begin, ...challenge, ...bindingPatch }));
  const identity = Buffer.from('mousa-pair:' + sha256(binding).toString('hex'));
  const salt = Buffer.from(challenge.salt, 'hex');
  const srp = new SrpClient(SRP.params.hap, salt, identity, Buffer.from(code), randomBytes(32));
  srp.setB(Buffer.from(challenge.serverPublicKey, 'hex'));
  const a = srp.computeA(), b = Buffer.from(challenge.serverPublicKey, 'hex'), key = srp.computeK();
  const group = sha512(SRP.params.hap.N.toBuffer(384)), generator = sha512(SRP.params.hap.g.toBuffer(384));
  for (let at = 0; at < group.length; at++) group[at] = group[at]! ^ generator[at]!;
  const m1 = sha512(group, sha512(identity), salt, a, b, key), m2 = sha512(a, m1, key);
  const aad = Buffer.concat([binding, m1, m2]);
  const tokenKey = Buffer.from(hkdfSync('sha256', key, sha256(binding), 'Mousa Pairing Bootstrap v1 token', 32));
  const finishKey = Buffer.from(hkdfSync('sha256', key, sha256(binding), 'Mousa Pairing Bootstrap v1 finish', 32));
  return {
    exchange: { clientPublicKey: a.toString('hex'), clientProof: m1.toString('hex') },
    finish: { clientConfirmation: createHmac('sha256', finishKey).update(aad).digest('hex') },
    serverProof: m2.toString('hex'),
    decrypt(envelope: MobilePairingFinishReply): MobileTokenPair {
      const decipher = createDecipheriv('aes-256-gcm', tokenKey, Buffer.from(envelope.nonce, 'hex'));
      decipher.setAAD(aad); decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
      const bytes = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'hex')), decipher.final()]);
      try { return JSON.parse(bytes.toString('utf8')) as MobileTokenPair; } finally { bytes.fill(0); }
    },
  };
}
async function prove(f: ReturnType<typeof fixture>, started: Awaited<ReturnType<ReturnType<typeof fixture>['start']>>, peer = PEER) {
  const prompt = f.prompts.get(started.challenge.requestId); assert.ok(prompt);
  const c = client(started.body, started.challenge, prompt.code);
  assert.deepEqual(await f.coordinator.exchange(started.challenge.requestId, c.exchange, peer), { serverProof: c.serverProof });
  return c;
}

test('六位码只出现在Main私有提示；完整PAKE、原鉴权和AEAD令牌可互通', async t => {
  const f = fixture(t), started = await f.start(), id = started.challenge.requestId;
  const prompt = f.prompts.get(id); assert.ok(prompt);
  assert.match(prompt.code, /^[0-9]{6}$/u); assert.equal(prompt.expiresAtMs, START + 120_000);
  assert.equal(Object.hasOwn(started.challenge, 'code'), false); assert.equal(f.counts.issues, 0);
  assert.equal(f.counts.claims, 0); assert.equal((await f.auth.devices()).length, 0);
  const c = await prove(f, started);
  assert.equal(f.counts.issues, 0); assert.equal(f.counts.claims, 0);
  const envelope = await f.coordinator.finish(id, c.finish, PEER), pair = c.decrypt(envelope);
  assert.equal(pair.serverId, SERVER); assert.equal((await f.auth.authenticate(pair.accessToken)).serverId, SERVER);
  assert.equal((await f.auth.devices()).length, 1); assert.equal(f.counts.issues, 1); assert.equal(f.counts.claims, 1);
  assert.deepEqual(f.ended, [id]); await f.coordinator.beforeSend(id, PEER);
  assert.deepEqual(await f.coordinator.finish(id, c.finish, PEER), envelope);
  assert.equal(f.counts.issues, 1); assert.equal((await f.auth.devices()).length, 1);
  const tampered = { ...envelope, tag: (envelope.tag[0] === '0' ? '1' : '0') + envelope.tag.slice(1) };
  assert.throws(() => c.decrypt(tampered));
});

test('begin重试忽略JSON键顺序，只重放同一挑战且不重复弹框或申请原许可', async t => {
  const f = fixture(t), first = await f.start();
  const reordered = Object.fromEntries(Object.entries(first.body).reverse());
  assert.deepEqual(await f.coordinator.start(reordered, PEER), first.challenge);
  assert.equal(f.prompts.size, 1); assert.deepEqual(f.counts, { issues: 0, claims: 0 });
  await assert.rejects(f.coordinator.start({ ...first.body, deviceName: '另一名字' }, PEER), failure(409));
  await assert.rejects(f.coordinator.start({ ...first.body, clientNonce: 'cd'.repeat(32) }, PEER), failure(409));
});

test('begin重试等待同一个Mac提示登记，不能早于原登记返回挑战', async t => {
  const entered = deferred(), gate = deferred(); let registrations = 0;
  const f = fixture(t, { onRequest: async () => { registrations++; entered.resolve(); await gate.promise; } });
  const body = request(), first = f.coordinator.start(body, PEER); await entered.promise;
  let settled = false;
  const duplicate = f.coordinator.start(body, PEER).then(value => { settled = true; return value; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, false);
  } finally { gate.resolve(); }
  assert.deepEqual(await duplicate, await first); assert.equal(registrations, 1);
});

test('错误短码只消耗自己的单次证明，不调用原许可或claim；随后使用新挑战', async t => {
  const f = fixture(t), first = await f.start(), prompt = f.prompts.get(first.challenge.requestId)!;
  const wrong = prompt.code === '000000' ? '000001' : '000000';
  const c = client(first.body, first.challenge, wrong);
  await assert.rejects(f.coordinator.exchange(first.challenge.requestId, c.exchange, PEER), failure(401));
  await assert.rejects(f.coordinator.exchange(first.challenge.requestId, c.exchange, PEER), failure(401));
  assert.deepEqual(f.counts, { issues: 0, claims: 0 }); assert.deepEqual(f.ended, [first.challenge.requestId]);
  const next = await f.start(); assert.notEqual(next.challenge.requestId, first.challenge.requestId);
  assert.notEqual(next.challenge.salt, first.challenge.salt); await prove(f, next);
});

test('A=0和A=N被成熟SRP检查拒绝，不会领取授权', async t => {
  const f = fixture(t);
  for (const key of [Buffer.alloc(384), SRP.params.hap.N.toBuffer(384)]) {
    const started = await f.start();
    await assert.rejects(f.coordinator.exchange(started.challenge.requestId,
      { clientPublicKey: key.toString('hex'), clientProof: '00'.repeat(64) }, PEER), failure(401));
  }
  assert.deepEqual(f.counts, { issues: 0, claims: 0 });
});

test('身份、实际叶证书、源站、设备名及nonce绑定被篡改时不能通过PAKE', async t => {
  const patches: Partial<MobilePairingBootstrapBinding>[] = [
    { serverId: 'server.other' }, { origin: 'https://192.168.1.21:45391' },
    { certificateSha256: 'cd'.repeat(32) }, { deviceName: '替换设备' }, { clientNonce: 'cd'.repeat(32) },
  ];
  for (const patch of patches) {
    const f = fixture(t), started = await f.start(), prompt = f.prompts.get(started.challenge.requestId)!;
    const c = client(started.body, started.challenge, prompt.code, patch);
    await assert.rejects(f.coordinator.exchange(started.challenge.requestId, c.exchange, PEER), failure(401));
    assert.deepEqual(f.counts, { issues: 0, claims: 0 });
  }
});

test('相同设备名的两台安装独立证明、授权和取消，不互相覆盖', async t => {
  const f = fixture(t), secondPeer = { ...PEER, remoteAddress: '192.168.1.31' };
  const one = await f.start(request('installation.one'));
  const two = await f.start(request('installation.two'), secondPeer);
  assert.equal(f.prompts.size, 2); assert.notEqual(one.challenge.requestId, two.challenge.requestId);
  await assert.rejects(f.coordinator.cancelFromPeer(one.challenge.requestId, secondPeer), failure(401));
  await f.coordinator.cancelFromPeer(one.challenge.requestId, PEER);
  const c = await prove(f, two, secondPeer), pair = c.decrypt(await f.coordinator.finish(two.challenge.requestId, c.finish, secondPeer));
  assert.equal((await f.auth.devices()).length, 1); assert.equal((await f.auth.authenticate(pair.accessToken)).deviceId, pair.deviceId);
  await assert.rejects(f.coordinator.finish(two.challenge.requestId, c.finish, PEER), failure(401));
  await assert.rejects(f.coordinator.cancelFromPeer(two.challenge.requestId, secondPeer), failure(409));
});

test('同安装已有请求进行中不创建第二个验证码；其取消不撤销其他设备', async t => {
  const f = fixture(t), one = await f.start();
  await assert.rejects(f.coordinator.start(request(), PEER), failure(409));
  assert.equal(f.prompts.size, 1); f.coordinator.cancel(one.challenge.requestId);
  await assert.rejects(f.coordinator.exchange(one.challenge.requestId,
    { clientPublicKey: '01'.repeat(384), clientProof: '02'.repeat(64) }, PEER), failure(401));
  assert.equal((await f.auth.devices()).length, 0);
});

test('证明与finish精确重试幂等；改变证明或伪造finish不得复用授权', async t => {
  const f = fixture(t), started = await f.start(), c = await prove(f, started), id = started.challenge.requestId;
  assert.deepEqual(await f.coordinator.exchange(id, c.exchange, PEER), { serverProof: c.serverProof });
  await assert.rejects(f.coordinator.exchange(id, { ...c.exchange, clientProof: '00'.repeat(64) }, PEER), failure(409));
  await assert.rejects(f.coordinator.finish(id, { clientConfirmation: '00'.repeat(32) }, PEER), failure(401));
  assert.deepEqual(f.counts, { issues: 0, claims: 0 });
});

test('服务器身份、地址、peer或证书不一致在生成提示前拒绝', async t => {
  const f = fixture(t);
  for (const peer of [ { ...PEER, serverId: 'server.other' }, { ...PEER, origin: 'https://192.168.1.21:45391' },
    { ...PEER, certificateSha256: 'cd'.repeat(32) } ]) await assert.rejects(f.coordinator.start(request(), peer), failure(401));
  await assert.rejects(f.coordinator.start({ ...request(), certificateSha256: 'cd'.repeat(32) }, PEER), failure(401));
  assert.equal(f.prompts.size, 0); assert.deepEqual(f.counts, { issues: 0, claims: 0 });
});

test('120秒过期由单调时钟控制；墙钟回退不会延长尝试，关闭回调只发一次', async t => {
  const f = fixture(t), started = await f.start(), c = await prove(f, started);
  f.advance(MOBILE_PAIRING_BOOTSTRAP_LIMITS.lifetimeMs); f.setWall(START - 86_400_000);
  await assert.rejects(f.coordinator.finish(started.challenge.requestId, c.finish, PEER), failure(401));
  f.coordinator.cancel(started.challenge.requestId); assert.deepEqual(f.ended, [started.challenge.requestId]);
  assert.deepEqual(f.counts, { issues: 0, claims: 0 });
});

test('来源围栏失效后拒绝迟到证明与令牌', async t => {
  const f = fixture(t), started = await f.start(), c = await prove(f, started);
  f.setReady(false); await assert.rejects(f.coordinator.finish(started.challenge.requestId, c.finish, PEER), failure(503));
  assert.deepEqual(f.counts, { issues: 0, claims: 0 });
});

test('每peer限速、全局限速与八个临时请求容量互相独立，超限不弹框', async t => {
  const f = fixture(t);
  for (let i = 0; i < 5; i++) { const started = await f.start(request('installation.' + i)); f.coordinator.cancel(started.challenge.requestId); }
  await assert.rejects(f.coordinator.start(request('installation.limited'), PEER), failure(429));
  assert.equal(f.prompts.size, 5); f.advance(60_001);
  const active: string[] = [];
  for (let i = 0; i < 8; i++) active.push((await f.start(request('installation.active' + i), { ...PEER, remoteAddress: '192.168.1.' + (40 + i) })).challenge.requestId);
  await assert.rejects(f.coordinator.start(request('installation.capacity'), { ...PEER, remoteAddress: '192.168.1.80' }), failure(503));
  for (const id of active) f.coordinator.cancel(id);
  for (let i = 0; i < 8; i++) { const started = await f.start(request('installation.more' + i), { ...PEER, remoteAddress: '192.168.1.' + (90 + i) }); f.coordinator.cancel(started.challenge.requestId); }
  await assert.rejects(f.coordinator.start(request('installation.global'), { ...PEER, remoteAddress: '192.168.1.100' }), failure(429));
});

test('原issue结果UNKNOWN时不暗中重发许可；只允许重新开始用户意图', async t => {
  const f = fixture(t), started = await f.start(), c = await prove(f, started);
  f.setIssueEffect(async () => { throw new MobileAuthPersistenceError('unknown'); });
  await assert.rejects(f.coordinator.finish(started.challenge.requestId, c.finish, PEER), failure(503));
  await assert.rejects(f.coordinator.finish(started.challenge.requestId, c.finish, PEER), failure(401));
  assert.deepEqual(f.counts, { issues: 1, claims: 0 }); assert.deepEqual(f.ended, [started.challenge.requestId]);
});

test('原claim提交后UNKNOWN精确复用原permit、body和key读取回执，不重新授权', async t => {
  const f = fixture(t), started = await f.start(), c = await prove(f, started);
  let first = true;
  f.setClaimEffect(async (body, key) => {
    const pair = await f.auth.claim(body, key);
    if (first) { first = false; throw new MobileAuthPersistenceError('unknown'); }
    return pair;
  });
  await assert.rejects(f.coordinator.finish(started.challenge.requestId, c.finish, PEER), failure(503));
  const envelope = await f.coordinator.finish(started.challenge.requestId, c.finish, PEER);
  await f.auth.authenticate(c.decrypt(envelope).accessToken);
  assert.equal(f.counts.issues, 1); assert.equal(f.counts.claims, 2);
  assert.deepEqual(f.claimInputs[0], f.claimInputs[1]); assert.equal((await f.auth.devices()).length, 1);
});

test('并发finish只有一个原提交，取消不能越过已进入提交的边界', async t => {
  const f = fixture(t), started = await f.start(), c = await prove(f, started);
  const entered = deferred(), gate = deferred();
  f.setClaimEffect(async (body, key) => { entered.resolve(); await gate.promise; return f.auth.claim(body, key); });
  const one = f.coordinator.finish(started.challenge.requestId, c.finish, PEER);
  await entered.promise;
  const two = f.coordinator.finish(started.challenge.requestId, c.finish, PEER);
  await assert.rejects(f.coordinator.cancelFromPeer(started.challenge.requestId, PEER), failure(409));
  gate.resolve(); assert.deepEqual(await one, await two);
  assert.deepEqual(f.counts, { issues: 1, claims: 1 });
});

test('已领取令牌随后撤销或刷新，beforeSend与finish重放都拒绝迟到旧授权', async t => {
  for (const action of ['revoke', 'refresh'] as const) {
    const f = fixture(t), started = await f.start(), c = await prove(f, started);
    const pair = c.decrypt(await f.coordinator.finish(started.challenge.requestId, c.finish, PEER));
    if (action === 'revoke') await f.auth.revokeDevice(pair.deviceId);
    else await f.auth.refresh({ refreshToken: pair.refreshToken }, 'refresh:synthetic');
    await assert.rejects(f.coordinator.beforeSend(started.challenge.requestId, PEER), error => error instanceof MobileServiceError);
    await assert.rejects(f.coordinator.finish(started.challenge.requestId, c.finish, PEER), error => error instanceof MobileServiceError);
    assert.equal(f.counts.issues, 1); assert.equal((await f.auth.devices()).length, 1);
  }
});

test('Mac不能展示验证码时取消该尝试；close等待已登记的提示任务结束', async t => {
  const rejected = fixture(t, { onRequest: async () => { throw new Error('合成显示失败'); } });
  await assert.rejects(rejected.coordinator.start(request(), PEER), failure(503));
  assert.equal(rejected.ended.length, 1); assert.deepEqual(rejected.counts, { issues: 0, claims: 0 });
  const entered = deferred(), gate = deferred();
  const held = fixture(t, { onRequest: async () => { entered.resolve(); await gate.promise; } });
  const start = held.coordinator.start(request(), PEER); await entered.promise;
  let joined = false; const close = held.coordinator.close().then(() => { joined = true; });
  await Promise.resolve(); assert.equal(joined, false); gate.resolve();
  await assert.rejects(start, failure(503)); await close; assert.equal(joined, true);
  assert.equal(held.ended.length, 1); await assert.rejects(held.coordinator.start(request(), PEER), failure(503));
});

test('start登记任务尚未执行时close封住晚到弹框，不留下已过期的验证码窗口', async t => {
  let registrations = 0;
  const f = fixture(t, { onRequest: () => { registrations++; } });
  const start = f.coordinator.start(request(), PEER), close = f.coordinator.close();
  await assert.rejects(start, failure(503)); await close;
  assert.equal(registrations, 0); assert.equal(f.ended.length, 1);
});

test('close等待原claim提交静止，晚回包不会产生可发送令牌', async t => {
  const f = fixture(t), started = await f.start(), c = await prove(f, started);
  const entered = deferred(), gate = deferred();
  f.setClaimEffect(async (body, key) => { entered.resolve(); await gate.promise; return f.auth.claim(body, key); });
  const finish = f.coordinator.finish(started.challenge.requestId, c.finish, PEER); await entered.promise;
  let settled = false; const close = f.coordinator.close().then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false); gate.resolve();
  await assert.rejects(finish, failure(503)); await close; assert.equal(settled, true);
  assert.deepEqual(f.counts, { issues: 1, claims: 1 }); assert.equal(f.ended.length, 1);
});
