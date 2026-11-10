import assert from 'node:assert/strict';
import test from 'node:test';
import { isMobileConnectionSettings } from '../src/shared/mobile-settings.js';

// Deliberately shape-only PEM: real certificate checks belong to TLS/pairing, not Renderer IPC validation.
const certificatePEM = '-----BEGIN CERTIFICATE-----\nYWJj\n-----END CERTIFICATE-----\n';
const connection = { schemaVersion: 1, serverId: 'server:synthetic-settings', baseURL: 'https://10.99.0.1:45391', certificatePEM, certificateSha256: 'a'.repeat(64) };
const primary = { kind: 'lan', baseURL: connection.baseURL, certificatePEM, certificateSha256: connection.certificateSha256 };
const secondary = { kind: 'tailscale', baseURL: 'https://100.100.100.10:45391', certificatePEM, certificateSha256: 'b'.repeat(64) };
const legacy = { schemaVersion: 1, enabled: true, state: 'ready', host: '10.99.0.1', port: 45391, hosts: ['127.0.0.1', '10.99.0.1'], connection, devices: [] };
const connectionPaths = { schemaVersion: 1, serverId: connection.serverId, paths: [primary, secondary] };

test('additive settings capabilities accept both old snapshots and exact current primary plus one companion', () => {
  assert.equal(isMobileConnectionSettings(legacy), true);
  assert.equal(isMobileConnectionSettings({ ...legacy, connectionPaths, tailscaleState: 'ready' }), true);
  assert.equal(isMobileConnectionSettings({ ...legacy, connection: null, connectionPaths: null, tailscaleState: 'off' }), true);
});

test('additive settings capabilities cannot substitute a same-name server, drop the primary, rotate its pin, or smuggle extra fields', () => {
  for (const value of [
    { ...connectionPaths, serverId: 'server:another' }, { ...connectionPaths, paths: [secondary] },
    { ...connectionPaths, paths: [{ ...primary, certificateSha256: 'c'.repeat(64) }, secondary] },
    { ...connectionPaths, paths: [primary, { ...secondary, certificateSha256: 'b'.repeat(64) + '\n' }] },
    { ...connectionPaths, paths: [primary, { ...secondary, authorization: 'synthetic-forbidden' }] },
  ]) assert.equal(isMobileConnectionSettings({ ...legacy, connectionPaths: value, tailscaleState: 'ready' }), false);
  assert.equal(isMobileConnectionSettings({ ...legacy, connectionPaths: null }), false);
  assert.equal(isMobileConnectionSettings({ ...legacy, tailscaleState: 'connected-to-real-vpn' }), false);
});

test('additive settings capabilities reject optional accessors without reading them and malformed proxies without throwing', () => {
  let reads = 0;
  assert.equal(isMobileConnectionSettings({ ...legacy, get connectionPaths() { reads++; return connectionPaths; } }), false);
  assert.equal(isMobileConnectionSettings({ ...legacy, get tailscaleState() { reads++; return 'ready'; } }), false);
  assert.equal(reads, 0);
  assert.equal(isMobileConnectionSettings(new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('synthetic'); } })), false);
});
