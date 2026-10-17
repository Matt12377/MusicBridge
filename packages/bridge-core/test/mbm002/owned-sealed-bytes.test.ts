import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { accessSync, constants, mkdtempSync, statSync } from 'node:fs';
import { allocateOwnedSealedBytes, ownedSealedByteLength } from '../../src/mobile/owned-sealed-bytes.js';
import { createMobileAuthCrypto } from '../../src/mobile/auth-crypto.js';
import { isMobileOwnerPrivateRequest, isMobileOwnerPrivateResult } from '../../src/mobile/owner-protocol.js';
import { createMobileSealedStateStore } from '../../src/mobile/sealed-state-store.js';
import { createMobilePlaybackService } from '../../src/mobile/playback-service.js';
import { MobilePlaybackError, type MobilePlaybackSourcePort } from '../../src/mobile/playback-types.js';
import { MOBILE_AUTH_SEALED_MAX_BYTES, MobileAuthPersistenceError, type MobileAuthPersistence, type MobilePrincipal } from '../../src/mobile/types.js';

const SIZE = 1_999_173, DATASET = '30000000-0000-4000-8000-000000000001';
const SERVER = 'owned.synthetic.server', NOW = Date.parse('2026-10-17T00:00:00.000Z');
const signal = () => new AbortController().signal;
const saveRequest = (sealed: Uint8Array, expectedRevision = 0, commitId: string = randomUUID()) => ({
  kind: 'playback-save' as const, datasetId: DATASET, request: { datasetId: DATASET, expectedRevision, commitId, sealed },
});
function probeKeys<T>(target: Uint8Array, work: () => T): { value: T; scans: number } {
  const ownKeys = Reflect.ownKeys; let scans = 0;
  Reflect.ownKeys = (value: object): (string | symbol)[] => { if (value === target) scans++; return ownKeys(value); };
  try { return { value: work(), scans }; } finally { Reflect.ownKeys = ownKeys; }
}
function scratch(): string {
  const volume = '/Volumes/LifeWeave', root = volume + '/Developer/CommandLine/tmp';
  assert.notEqual(statSync(volume).dev, statSync('/').dev, '必须使用已挂载的外置卷');
  accessSync(root, constants.W_OK);
  // 只新建本次合成Owner材料，供Root保留回执；不读或清理任何真实库。
  return mkdtempSync(root + '/mb-owned-byte-regression-');
}
function unknownGuard(value: Uint8Array): boolean { return isMobileOwnerPrivateRequest(saveRequest(value)); }

test('密文字节资格：1999173字节owned与unknown均合法且未知边界不被洗白', { timeout: 30_000 }, () => {
  const owned = allocateOwnedSealedBytes(SIZE), unknown = new Uint8Array(SIZE);
  owned.fill(19); unknown.fill(19);
  assert.equal(ownedSealedByteLength(owned, MOBILE_AUTH_SEALED_MAX_BYTES), SIZE);
  assert.equal(ownedSealedByteLength(unknown, MOBILE_AUTH_SEALED_MAX_BYTES), null);
  assert.equal(Object.isExtensible(owned), false); assert.deepEqual(owned, unknown);
  const fast = probeKeys(owned, () => unknownGuard(owned)), full = probeKeys(unknown, () => unknownGuard(unknown));
  assert.deepEqual(fast, { value: true, scans: 0 }); assert.deepEqual(full, { value: true, scans: 1 });
  assert.equal(Object.isExtensible(unknown), true);
  assert.equal(Reflect.defineProperty(owned, 'extra', { value: true }), false);
  assert.equal(Reflect.defineProperty(owned, Symbol('fake'), { value: true }), false);
  assert.equal(Reflect.defineProperty(owned, '0', { get() { throw new Error('不得执行'); } }), false);
  assert.equal(Reflect.setPrototypeOf(owned, Object.create(null)), false);
  owned.fill(0); assert.equal(unknown[0], 19); assert.equal(unknownGuard(owned), true);
  // 验过一次仍不是资格；不扩展对象或自报品牌同样不能得到资格。
  Object.defineProperty(unknown, 'extra', { enumerable: false, value: true });
  assert.equal(unknownGuard(unknown), false);
  assert.equal(Object.isExtensible(unknown), true);
  const nonextensible = Object.preventExtensions(new Uint8Array(4));
  assert.equal(ownedSealedByteLength(nonextensible, MOBILE_AUTH_SEALED_MAX_BYTES), null);
  assert.deepEqual(probeKeys(nonextensible, () => unknownGuard(nonextensible)), { value: true, scans: 1 });
  let getters = 0;
  for (const key of ['extra', 'byteLength', 'buffer', Symbol('fake-owned')]) {
    const raw = Object.defineProperty(new Uint8Array(8), key, { enumerable: false, get() { getters++; return true; } });
    assert.equal(unknownGuard(raw), false); assert.equal(ownedSealedByteLength(raw, MOBILE_AUTH_SEALED_MAX_BYTES), null);
  }
  const selfReported = Object.assign(new Uint8Array(8), { owned: true });
  assert.equal(unknownGuard(selfReported), false);
  const proxy = new Proxy(owned, { getPrototypeOf() { getters++; throw new Error('不得触发'); } });
  assert.equal(unknownGuard(proxy), false); assert.equal(getters, 0);
  const forged = Object.create(Uint8Array.prototype) as Uint8Array;
  assert.equal(unknownGuard(forged), false);
  const getterPacket = saveRequest(owned);
  Object.defineProperty(getterPacket.request, 'sealed', { enumerable: true, get() { getters++; return owned; } });
  assert.equal(isMobileOwnerPrivateRequest(getterPacket), false); assert.equal(getters, 0);
  assert.equal(unknownGuard(new Uint8Array(new SharedArrayBuffer(8))), false);
  assert.equal(unknownGuard(Buffer.alloc(8)), false);
  class ForeignBytes extends Uint8Array {}
  assert.equal(unknownGuard(new ForeignBytes(8)), false);
  assert.equal(unknownGuard(new Uint8Array(0)), false);
  assert.equal(unknownGuard(new Uint8Array(MOBILE_AUTH_SEALED_MAX_BYTES + 1)), false);
  for (const length of [0, -1, 0.5, NaN, Infinity, MOBILE_AUTH_SEALED_MAX_BYTES + 1])
    assert.throws(() => allocateOwnedSealedBytes(length), error => error instanceof MobileAuthPersistenceError && error.outcome === 'not-sent');
  const factoryArgument = { valueOf() { getters++; return 8; } };
  assert.throws(() => allocateOwnedSealedBytes(factoryArgument as unknown as number)); assert.equal(getters, 0);
  assert.equal(ownedSealedByteLength(owned, SIZE - 1), null);
  const detached = allocateOwnedSealedBytes(8), moved = structuredClone(detached, { transfer: [detached.buffer] });
  assert.equal(ownedSealedByteLength(detached, MOBILE_AUTH_SEALED_MAX_BYTES), null); assert.equal(unknownGuard(detached), false);
  assert.equal(ownedSealedByteLength(moved, MOBILE_AUTH_SEALED_MAX_BYTES), null);
  assert.deepEqual(probeKeys(moved, () => unknownGuard(moved)), { value: true, scans: 1 });
  const clone = structuredClone(owned);
  assert.equal(ownedSealedByteLength(clone, MOBILE_AUTH_SEALED_MAX_BYTES), null);
  assert.deepEqual(probeKeys(clone, () => unknownGuard(clone)), { value: true, scans: 1 });
  const badScope = saveRequest(owned); badScope.request.datasetId = 'another.dataset';
  assert.equal(isMobileOwnerPrivateRequest(badScope), false);
  const badRevision = saveRequest(owned); badRevision.request.expectedRevision = -1;
  assert.equal(isMobileOwnerPrivateRequest(badRevision), false);
  const badCommit = saveRequest(owned); badCommit.request.commitId = 'forged';
  assert.equal(isMobileOwnerPrivateRequest(badCommit), false);
  assert.equal(isMobileOwnerPrivateRequest({ ...saveRequest(owned), privateBrand: true }), false);
});

test('密文字节资格：原AES密文逐字节与真实Owner大负载CAS及UNKNOWN保持', { timeout: 30_000 }, () => {
  const key = randomBytes(32), crypto = createMobileAuthCrypto(key), plain = new Uint8Array(SIZE - 29);
  plain.fill(73); const aad = Buffer.from('owned.synthetic.aad'), sealed = crypto.seal(plain, aad);
  assert.equal(sealed.byteLength, SIZE); assert.equal(ownedSealedByteLength(sealed, MOBILE_AUTH_SEALED_MAX_BYTES), SIZE);
  const cipher = createCipheriv('aes-256-gcm', key, sealed.subarray(1, 13)); cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const expected = new Uint8Array(Buffer.concat([Buffer.from([1]), Buffer.from(sealed.subarray(1, 13)), cipher.getAuthTag(), encrypted]));
  assert.deepEqual(sealed, expected); assert.deepEqual(crypto.open(sealed, aad), plain); key.fill(0);
  const directory = scratch(); let active = true, failAfterPublish = false, publications = 0;
  const store = createMobileSealedStateStore({ directory, datasetId: DATASET, namespace: 'playback',
    assertCurrent() { if (!active) throw new Error('合成Owner已关闭'); },
    afterPublish() { publications++; if (failAfterPublish) throw new Error('合成ACK丢失'); } });
  assert.deepEqual(store.load(DATASET), { kind: 'missing', datasetId: DATASET, revision: 0 });
  const original = saveRequest(sealed); assert.equal(isMobileOwnerPrivateRequest(original), true);
  // 原同步structuredClone后无身份资格，Owner入口仍完整guard，未跨IPC恢复品牌。
  const wire = structuredClone(original);
  assert.equal(ownedSealedByteLength(wire.request.sealed, MOBILE_AUTH_SEALED_MAX_BYTES), null);
  assert.equal(isMobileOwnerPrivateRequest(wire), true);
  const ack = store.save(wire.request); assert.equal(ack.kind, 'saved');
  assert.equal(isMobileOwnerPrivateResult(ack, original), true);
  sealed.fill(0); assert.deepEqual(wire.request.sealed, expected);
  const loaded = store.load(DATASET); assert.equal(loaded.kind, 'sealed');
  if (loaded.kind !== 'sealed') throw new Error('合成Owner未保存');
  assert.deepEqual(loaded.sealed, expected); assert.deepEqual(crypto.open(loaded.sealed, aad), plain);
  assert.equal(ownedSealedByteLength(loaded.sealed, MOBILE_AUTH_SEALED_MAX_BYTES), SIZE);
  assert.deepEqual(probeKeys(loaded.sealed, () => isMobileOwnerPrivateResult(loaded, { kind: 'playback-load', datasetId: DATASET })),
    { value: true, scans: 0 });
  assert.equal(store.save(wire.request).kind, 'saved'); assert.equal(publications, 1);
  assert.equal(store.save({ ...wire.request, commitId: randomUUID() }).kind, 'conflict');
  const second = { ...wire.request, expectedRevision: 1, commitId: randomUUID() }; failAfterPublish = true;
  assert.throws(() => store.save(second), error => error instanceof MobileAuthPersistenceError && error.outcome === 'unknown');
  const resolved = store.load(DATASET); assert.equal(resolved.kind, 'sealed');
  if (resolved.kind !== 'sealed') throw new Error('合成提交缺失');
  assert.equal(resolved.revision, 2); assert.equal(resolved.commitId, second.commitId); assert.deepEqual(resolved.sealed, expected);
  assert.equal(store.save(second).kind, 'saved'); assert.equal(publications, 2);
  active = false;
  assert.throws(() => store.load(DATASET), error => error instanceof MobileAuthPersistenceError && error.outcome === 'not-sent');
  assert.throws(() => store.save({ ...second, expectedRevision: 2, commitId: randomUUID() }),
    error => error instanceof MobileAuthPersistenceError && error.outcome === 'not-sent');
  loaded.sealed.fill(0); resolved.sealed.fill(0); wire.request.sealed.fill(0); expected.fill(0); plain.fill(0);
});

const noSource: MobilePlaybackSourcePort = {
  async prepare() { throw new Error('本项不准备媒体'); }, async verify() {}, async renew() {},
  async read() { throw new Error('本项不读取媒体'); }, async closeRead() {}, async release() {},
};
test('密文字节资格：实际seal到Playback原save采用快路且外来crypto不获资格', { timeout: 30_000 }, async t => {
  for (const foreign of [false, true]) await t.test(foreign ? '外来crypto保原路' : '原生产seal采用资格', async (sub: TestContext) => {
    const key = randomBytes(32), actual = createMobileAuthCrypto(key); key.fill(0);
    const rawResults: Uint8Array[] = [], outputCopies: Uint8Array[] = [];
    const crypto = { seal(plain: Uint8Array, aad: Uint8Array) {
      const produced = actual.seal(plain, aad), result = foreign ? structuredClone(produced) : produced;
      rawResults.push(result); return result;
    }, open: actual.open };
    const store = createMobileSealedStateStore({ directory: scratch(), datasetId: DATASET, namespace: 'playback', assertCurrent() {} });
    let writes = 0, dropAck = true;
    const persistence: MobileAuthPersistence = {
      async load(dataset) {
        const result = store.load(dataset);
        assert.equal(isMobileOwnerPrivateResult(result, { kind: 'playback-load', datasetId: dataset }), true);
        if (result.kind === 'sealed') assert.equal(ownedSealedByteLength(result.sealed, MOBILE_AUTH_SEALED_MAX_BYTES), result.sealed.byteLength);
        const wire = structuredClone(result);
        if (wire.kind === 'sealed') assert.equal(ownedSealedByteLength(wire.sealed, MOBILE_AUTH_SEALED_MAX_BYTES), null);
        return wire;
      },
      async save(request) {
        writes++; outputCopies.push(request.sealed);
        assert.equal(ownedSealedByteLength(request.sealed, MOBILE_AUTH_SEALED_MAX_BYTES) !== null, !foreign);
        const packet = { kind: 'playback-save' as const, datasetId: DATASET, request };
        assert.deepEqual(probeKeys(request.sealed, () => isMobileOwnerPrivateRequest(packet)), { value: true, scans: foreign ? 1 : 0 });
        const expected = new Uint8Array(request.sealed), raw = rawResults.at(-1)!;
        assert.notEqual(raw, request.sealed); raw.fill(0); assert.deepEqual(request.sealed, expected);
        // 与Main原路径同一顺序：同步完整请求验证→structuredClone→交给Owner。
        const wire = structuredClone(packet);
        assert.equal(ownedSealedByteLength(wire.request.sealed, MOBILE_AUTH_SEALED_MAX_BYTES), null);
        assert.equal(isMobileOwnerPrivateRequest(wire), true); assert.deepEqual(wire.request.sealed, expected);
        const result = store.save(wire.request); expected.fill(0); wire.request.sealed.fill(0);
        assert.equal(isMobileOwnerPrivateResult(result, packet), true);
        if (dropAck) { dropAck = false; throw new MobileAuthPersistenceError('unknown'); }
        return result;
      },
    };
    const service = createMobilePlaybackService({ serverId: SERVER, datasetId: DATASET, responseOrigin: 'https://127.0.0.1:9443',
      auth: { async assertDeviceCurrent() {} }, persistence, crypto, sourcePort: noSource, nowMs: () => NOW });
    sub.after(() => service.close());
    const principal: MobilePrincipal = { serverId: SERVER, datasetId: DATASET, accountDomain: `local:${DATASET}`,
      deviceId: 'device.synthetic.owned', deviceEpoch: 1, generation: 1, accessTokenHash: 'a'.repeat(64), accessExpiresAt: '2030-01-01T00:00:00.000Z' };
    const request = { path: '/mobile/v1/sessions', pathParameters: {}, query: {}, body: { clientInstanceId: 'client.synthetic.owned' }, idempotencyKey: 'owned.original.intent' };
    await assert.rejects(service.control('createSession', request, principal, signal()),
      error => error instanceof MobilePlaybackError && error.code === 'BUSY');
    assert.equal(service.resourceSnapshot().pendingPersistence, true); assert.equal(writes, 1);
    assert.ok(outputCopies.every(copy => copy.every(byte => byte === 0)));
    assert.equal((await service.control('createSession', request, principal, signal())).status, 201);
    assert.equal(service.resourceSnapshot().pendingPersistence, false); assert.equal(writes, 1);
    assert.equal(rawResults.length, 1); await service.close();
  });
});
