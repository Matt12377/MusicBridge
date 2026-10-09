import test from 'node:test';
import assert from 'node:assert/strict';
import { isMobileConnectionSettings } from '../../src/shared/mobile-settings.js';
import { createMobileConnectionClient } from '../../src/preload/mobile-connection-client.js';

const settings = { schemaVersion: 1, enabled: false, state: 'off', host: '127.0.0.1', port: 45391, hosts: ['127.0.0.1'], connection: null, devices: [] };
test('设置坏回包的缺connection、null设备及getter完整拒绝，不触发TypeError或getter', () => {
  assert.equal(isMobileConnectionSettings(settings), true);
  const { connection: _connection, ...missing } = settings;
  let reads = 0;
  const hostileHosts = ['127.0.0.1']; Object.defineProperty(hostileHosts, '0', { enumerable: true, get() { reads++; return '127.0.0.1'; } });
  for (const value of [missing, { ...settings, connection: undefined }, { ...settings, devices: [null] }, { ...settings, devices: [1] }, { ...settings, connection: {} }, { ...settings, get connection() { reads++; return null; } }, { ...settings, hosts: hostileHosts }, { ...settings, devices: new Array(1) }]) {
    assert.doesNotThrow(() => assert.equal(isMobileConnectionSettings(value), false));
  }
  assert.equal(reads, 0);
});
test('独立移动preload只有四种闭集能力，许可不经过诊断或通用command', async () => {
  const calls: string[] = [];
  const api = createMobileConnectionClient(async channel => { calls.push(channel); return channel === 'mobile:pairing' ? { pairingSecret: 'synthetic-unique-permit', expiresAt: '2026-10-10T00:00:00.000Z' } : settings; });
  assert.deepEqual(Object.keys(api), ['getMobileConnectionSettings', 'configureMobileConnection', 'issueMobilePairing', 'revokeMobileDevice']);
  await api.getMobileConnectionSettings(); await api.configureMobileConnection({ enabled: false, host: '127.0.0.1', port: 45391 }); await api.issueMobilePairing(); await api.revokeMobileDevice('synthetic-device');
  assert.deepEqual(calls, ['mobile:settings', 'mobile:configure', 'mobile:pairing', 'mobile:revoke-device']);
  const malformed = createMobileConnectionClient(async () => ({ ...settings, devices: [null] }));
  await assert.rejects(malformed.getMobileConnectionSettings(), /移动连接回执无效/u);
});
