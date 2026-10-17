import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { NeteaseClient } from '../../src/netease/client.js';
import { createActualMobileNeteasePorts } from '../../src/netease/mobile-actual-ports.js';
import { BridgeError } from '../../src/shared/errors.js';
import { MobileServiceError } from '../../src/mobile/types.js';

const accountId = '9007199254740993', credential = 'synthetic-account-response-private-cookie';
const wrapperCookie = 'synthetic-sdk-wrapper-private-cookie';
const signal = () => new AbortController().signal;
const valid = () => ({ status: 200, body: { code: 200, account: { id: accountId } }, cookie: [wrapperCookie] });
const busy = (error: unknown) => error instanceof MobileServiceError && error.status === 503 && error.code === 'BUSY';
const expired = (error: unknown) => error instanceof BridgeError && error.code === 'AUTH_EXPIRED' && error.httpStatus === 401;
const cancelled = (error: unknown) => error instanceof BridgeError && error.code === 'READ_CANCELLED';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

// 所有SDK/媒体端口均为合成；保真正Client scheduler与actual mapper，且fixture不先读账户。
function fixture(t: TestContext, reply: () => unknown | Promise<unknown>, settle = () => {}) {
  const calls: Record<string, unknown>[] = [];
  let networkCalls = 0;
  const unexpected = async (): Promise<never> => { throw new Error('账户夹具不得调用其它SDK能力。'); };
  const client = new NeteaseClient(credential, {
    song_detail: unexpected, song_url_v1: unexpected, login_qr_key: unexpected, login_qr_create: unexpected,
    login_qr_check: unexpected, login_status: unexpected, logout: unexpected,
    async user_account(params) {
      calls.push({ ...params }); assert.equal(typeof params.timeout, 'number'); assert.ok(Number(params.timeout) > 0 && Number(params.timeout) <= 10_000);
      return reply();
    },
  }, async () => undefined);
  const actual = createActualMobileNeteasePorts({ client, serverId: 'server.synthetic.account-response', datasetId: 'dataset.synthetic.account-response',
    ownerEpoch: 'owner.synthetic.account-response', identityKey32: new Uint8Array(32).fill(19), assertCurrent: async () => {},
    fetch: async () => { networkCalls++; throw new Error('账户响应测试不得发起实际媒体请求。'); } });
  t.after(async () => {
    const errors: unknown[] = [];
    for (const cleanup of [() => settle(), () => actual.close(), () => client.awaitMobileQuiet(), () => { assert.equal(networkCalls, 0); }]) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, '合成账户夹具未完全收口。', { cause: errors[0] });
  });
  return { client, actual, calls };
}
function assertPrivateFieldsAbsent(value: unknown): void {
  const encoded = JSON.stringify(value); assert.ok(typeof encoded === 'string');
  for (const text of [accountId, credential, wrapperCookie, '合成账户私密扩展', 'synthetic-profile-private-name']) assert.equal(encoded.includes(text), false);
}

test('MBM账户响应：冷Client到actual账户保留合法身份并忽略无关profile扩展，unsafe与getter或Proxy严格拒绝', { concurrency: false }, async t => {
  let unusedReads = 0, identityReads = 0, proxyTraps = 0;
  const unused = () => { unusedReads++; throw new Error('无关SDK扩展不得被身份读取。'); };
  const profile = { userId: accountId, nickname: 'synthetic-profile-private-name', signature: '合成账户私密扩展',
    avatarImgId: Number.MAX_SAFE_INTEGER + 1, backgroundImgId: Number.MAX_SAFE_INTEGER + 3, birthday: -1, userType: 0,
    authStatus: 0, followed: false, detail: { unneededImageId: Number.MAX_SAFE_INTEGER + 1 } };
  Object.defineProperty(profile, 'unusedMetadata', { enumerable: true, get: unused });
  const full = { status: 200, body: { code: 200, account: { id: accountId, userName: '合成账户私密扩展', status: 0 }, profile }, cookie: [wrapperCookie] };
  Object.defineProperty(full, 'unusedWrapper', { enumerable: true, get: unused });
  const responses: unknown[] = [
    full,
    { code: 200, account: { id: accountId } },
    { body: { code: 200, data: { account: { userId: accountId }, profile: null } }, cookie: [wrapperCookie] },
    { data: { code: 200, profile: { userId: accountId } } },
    { body: { result: { code: 200 }, account: null, data: null, profile: { id: accountId } } },
  ];
  let mappedAccount: string | undefined;
  for (const response of responses) {
    const f = fixture(t, () => response); assert.equal(f.calls.length, 0, 'fixture不能预热账户。');
    const account = await f.actual.account.current(signal()); assert.ok(account); assert.equal(f.calls.length, 1, '首个actual调用必须穿过原冷Client与scheduler。');
    assert.deepEqual(Object.keys(account).sort(), ['accountDomain', 'providerEpoch']); assert.match(account.accountDomain, /^nc:[a-f0-9]{64}$/u);
    mappedAccount ??= account.accountDomain; assert.equal(account.accountDomain, mappedAccount);
    const privateSnapshot = await f.client.mobileAccount(); assert.equal(privateSnapshot.accountId, accountId); assert.equal(account.providerEpoch, privateSnapshot.providerEpoch);
    assert.equal(f.calls.length, 2); assert.equal(f.calls[0]!.cookie, credential); assertPrivateFieldsAbsent(account);
  }
  const getterIdentity = Object.defineProperty({}, 'id', { enumerable: true, get() { identityReads++; return accountId; } });
  const getterProfile = Object.defineProperty({}, 'userId', { enumerable: true, get() { identityReads++; return accountId; } });
  const getterAccount = Object.defineProperty({ code: 200 }, 'account', { enumerable: true, get() { identityReads++; return { id: accountId }; } });
  const getterBody = Object.defineProperty({}, 'body', { enumerable: true, get() { identityReads++; return { code: 200, account: { id: accountId } }; } });
  const getterCode = Object.defineProperty({ account: { id: accountId } }, 'code', { enumerable: true, get() { identityReads++; return 200; } });
  const proxy = (target: Record<string, unknown>) => new Proxy(target, {
    get() { proxyTraps++; throw new Error('Proxy读取不得执行。'); },
    ownKeys() { proxyTraps++; throw new Error('Proxy枚举不得执行。'); },
    getOwnPropertyDescriptor() { proxyTraps++; throw new Error('Proxy描述符不得执行。'); },
    getPrototypeOf() { proxyTraps++; throw new Error('Proxy原型不得执行。'); },
  });
  const invalidResponses: unknown[] = [
    { body: { code: 200, account: { id: Number.MAX_SAFE_INTEGER + 1 }, profile: { userId: accountId } } },
    { body: { code: 200, account: getterIdentity } },
    { body: { code: 200, account: { id: accountId }, profile: getterProfile } },
    { body: getterAccount }, getterBody,
    { body: getterCode },
    { body: { code: 200, account: { id: accountId }, data: { code: Number.MAX_SAFE_INTEGER + 1 } } },
    { body: proxy({ code: 200, account: { id: accountId } }) },
    { body: { code: 200, account: proxy({ id: accountId }) } },
  ];
  for (const response of invalidResponses) {
    const f = fixture(t, () => response);
    await assert.rejects(f.actual.account.current(signal()), busy);
    await assert.rejects(f.client.mobileAccount(), error => error instanceof BridgeError && error.code === 'NETEASE_REQUEST_FAILED');
    assert.equal(f.calls.length, 2); assert.equal(f.client.configured, true);
  }
  assert.equal(unusedReads, 0); assert.equal(identityReads, 0); assert.equal(proxyTraps, 0);
});

test('MBM账户响应：原SDK明确过期同401而未知拒绝保持scheduler原cause，凭据代际与abort仍封迟到结果', { concurrency: false }, async t => {
  const authCases = [
    () => Promise.reject({ status: 301, body: { code: 301 }, cookie: [wrapperCookie] }),
    () => ({ status: 200, body: { code: 302 }, cookie: [wrapperCookie] }),
    () => Promise.reject({ status: 302, body: { code: 302 }, cookie: [wrapperCookie] }),
  ];
  for (const response of authCases) {
    const f = fixture(t, response), invalidations: unknown[] = [];
    const unsubscribe = f.client.onMobileAccountInvalidated(value => { invalidations.push(value); }); t.after(unsubscribe);
    await assert.rejects(f.actual.account.current(signal()), error => {
      assert.ok(error instanceof MobileServiceError); assert.equal(error.status, 401); assert.equal(error.code, 'UNAUTHORIZED'); assertPrivateFieldsAbsent(error); return true;
    });
    await assert.rejects(f.client.mobileAccount(), expired);
    assert.equal(f.calls.length, 2); assert.equal(f.client.configured, true); assert.equal(invalidations.length, 0, '分类不能撤Cookie或伪造账户换代。');
  }
  for (const original of [{ status: 503, body: { code: 301 }, cookie: [wrapperCookie] }, new Error('合成账户私密扩展')]) {
    const f = fixture(t, () => Promise.reject(original));
    await assert.rejects(f.client.mobileAccount(), error => error instanceof BridgeError && error.code === 'NETEASE_REQUEST_FAILED'
      && Object.getOwnPropertyDescriptor(error, 'cause')?.value === original);
    await assert.rejects(f.actual.account.current(signal()), error => { assert.ok(busy(error)); assertPrivateFieldsAbsent(error); return true; });
    assert.equal(f.client.configured, true);
  }
  for (const kind of ['credential', 'abort'] as const) {
    const started = deferred<void>(), late = deferred<unknown>(); let first = true;
    const f = fixture(t, () => { if (!first) return valid(); first = false; started.resolve(); return late.promise; }, () => late.resolve(valid()));
    const invalidations: { previousProviderEpoch: string; nextProviderEpoch: string }[] = [];
    const unsubscribe = f.client.onMobileAccountInvalidated(value => { invalidations.push(value); }); t.after(unsubscribe);
    const controller = new AbortController(), pending = f.client.mobileAccount({ signal: controller.signal }), refused = assert.rejects(pending, cancelled);
    await started.promise;
    if (kind === 'credential') f.client.setCredential(credential + '.replacement'); else controller.abort();
    await refused; assert.equal(f.calls.length, 1);
    let quiet = false; const quietFlight = f.client.awaitMobileQuiet().then(() => { quiet = true; }); await Promise.resolve();
    assert.equal(quiet, false, '取消本地等待不能冒原SDK已物理quiet。'); late.resolve(valid()); await quietFlight;
    const account = await f.actual.account.current(signal()); assert.ok(account);
    const current = await f.client.mobileAccount(); assert.equal(account.providerEpoch, current.providerEpoch); assertPrivateFieldsAbsent(account);
    assert.equal(f.calls.length, 3); assert.equal(f.calls[1]!.cookie, kind === 'credential' ? credential + '.replacement' : credential);
    assert.equal(invalidations.length, kind === 'credential' ? 1 : 0);
    if (kind === 'credential') { assert.equal(current.providerEpoch, invalidations[0]!.nextProviderEpoch); assert.notEqual(current.providerEpoch, invalidations[0]!.previousProviderEpoch); }
    assert.equal(f.client.configured, true);
  }
});
