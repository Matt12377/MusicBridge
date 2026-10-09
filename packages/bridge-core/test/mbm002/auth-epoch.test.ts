import assert from 'node:assert/strict';
import test from 'node:test';
import { createMobileAuthService } from '../../src/mobile/auth-service.js';
import { createMobileAuthCrypto } from '../../src/mobile/auth-crypto.js';
import { MobileServiceError, type MobileSealedState, type MobileAuthPersistence } from '../../src/mobile/types.js';

/** 合成鉴权/密封存储；只证明token轮换与设备epoch的区别，不证明真实保险库或设备。 */
function fixture() {
  const datasetId = 'dataset.epoch-fixture';
  let stored: MobileSealedState = { kind: 'missing', datasetId, revision: 0 }, serial = 0;
  const revoked: string[] = [];
  const persistence: MobileAuthPersistence = {
    async load() { return structuredClone(stored); },
    async save(request) {
      assert.equal(request.datasetId, datasetId);
      if (request.expectedRevision !== stored.revision) return { kind: 'conflict', datasetId, currentRevision: stored.revision };
      stored = { kind: 'sealed', datasetId, revision: stored.revision + 1, commitId: request.commitId, sealed: new Uint8Array(request.sealed) };
      return { kind: 'saved', datasetId, revision: stored.revision, commitId: request.commitId };
    },
  };
  const auth = createMobileAuthService({ serverId: 'server.epoch-fixture', datasetId, displayName: '合成epoch检查', environment: 'development',
    persistence, crypto: createMobileAuthCrypto(new Uint8Array(32).fill(17)), now: () => 1_800_000_000_000,
    randomToken: () => `synthetic_epoch_${String(++serial).padStart(32, '0')}`, onDeviceEpochRevoked: id => revoked.push(id) });
  const claim = async (key: string) => {
    const permit = await auth.issuePairing();
    const body = { pairingSecret: permit.pairingSecret, installationId: 'installation.epoch-fixture', deviceName: '合成设备' };
    return { body, pair: await auth.claim(body, key) };
  };
  return { auth, claim, revoked };
}
const failure = (status: number, code: string) => (error: unknown) => error instanceof MobileServiceError && error.status === status && error.code === code;

test('002正常refresh淘汰旧access品牌，但保持媒体设备epoch且不触发撤销', async t => {
  const f = fixture(); t.after(() => f.auth.close());
  const { pair } = await f.claim('claim.1');
  const original = await f.auth.authenticate(pair.accessToken);
  const next = await f.auth.refresh({ refreshToken: pair.refreshToken }, 'refresh.1');
  await assert.rejects(() => f.auth.assertCurrent(original), failure(401, 'UNAUTHORIZED'));
  await f.auth.assertDeviceCurrent(original.deviceId, original.deviceEpoch);
  const latest = await f.auth.authenticate(next.accessToken);
  assert.equal(latest.deviceEpoch, original.deviceEpoch); assert.ok(latest.generation > original.generation); assert.deepEqual(f.revoked, []);
});

test('002设备撤销退旧epoch且重复撤销只产生一次真实围栏事件', async t => {
  const f = fixture(); t.after(() => f.auth.close());
  const { pair } = await f.claim('claim.1'), principal = await f.auth.authenticate(pair.accessToken);
  await f.auth.revokeDevice(pair.deviceId); await f.auth.revokeDevice(pair.deviceId);
  assert.deepEqual(f.revoked, [pair.deviceId]);
  await assert.rejects(() => f.auth.assertDeviceCurrent(principal.deviceId, principal.deviceEpoch), failure(403, 'DEVICE_REVOKED'));
});

test('002同installation重新配对改变epoch；原claim回执重读不再退活跃资源', async t => {
  const f = fixture(); t.after(() => f.auth.close());
  const first = await f.claim('claim.1'), original = await f.auth.authenticate(first.pair.accessToken);
  const next = await f.claim('claim.2'), current = await f.auth.authenticate(next.pair.accessToken);
  assert.equal(current.deviceId, original.deviceId); assert.ok(current.deviceEpoch > original.deviceEpoch);
  assert.deepEqual(f.revoked, [current.deviceId]);
  assert.deepEqual(await f.auth.claim(next.body, 'claim.2'), next.pair); assert.deepEqual(f.revoked, [current.deviceId]);
  await assert.rejects(() => f.auth.assertDeviceCurrent(original.deviceId, original.deviceEpoch), failure(403, 'DEVICE_REVOKED'));
  await f.auth.assertDeviceCurrent(current.deviceId, current.deviceEpoch);
});

test('002logout触发自己的epoch撤销；伪设备或非法epoch没有读取资格', async t => {
  const f = fixture(); t.after(() => f.auth.close());
  const { pair } = await f.claim('claim.1'), principal = await f.auth.authenticate(pair.accessToken);
  await assert.rejects(() => f.auth.assertDeviceCurrent('another.device', principal.deviceEpoch), failure(403, 'DEVICE_REVOKED'));
  await assert.rejects(() => f.auth.assertDeviceCurrent(principal.deviceId, 0), failure(401, 'UNAUTHORIZED'));
  await f.auth.logout(principal); assert.deepEqual(f.revoked, [principal.deviceId]);
  await assert.rejects(() => f.auth.assertDeviceCurrent(principal.deviceId, principal.deviceEpoch), failure(403, 'DEVICE_REVOKED'));
});
