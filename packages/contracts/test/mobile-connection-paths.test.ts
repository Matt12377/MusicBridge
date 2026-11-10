import assert from 'node:assert/strict';
import test from 'node:test';
import { mobileConnectionAddressKind, isMobileConnectionOrigin, mobilePublicConnectionSnapshot,
  mobileConnectionPathsSnapshot, MOBILE_CONNECTION_DEFAULT_PORT } from '../src/mobile-connection-paths.js';

// Deliberately shape-only PEM: cryptographic adoption remains the TLS layer's responsibility.
const pem = '-----BEGIN CERTIFICATE-----\nQQ==\n-----END CERTIFICATE-----\n';
const lan = { kind: 'lan' as const, baseURL: 'https://192.168.20.2:45391', certificatePEM: pem, certificateSha256: 'ab'.repeat(32) };
const tail = { ...lan, kind: 'tailscale' as const, baseURL: 'https://100.100.100.10:45391', certificateSha256: 'cd'.repeat(32) };
const reply = () => ({ schemaVersion: 1, serverId: 'server.synthetic-paths', paths: [{ ...lan }, { ...tail }] });

test('connection address kinds cover only canonical IPv4 and exact CGNAT/private boundaries', () => {
  assert.equal(MOBILE_CONNECTION_DEFAULT_PORT, 45391);
  for (const host of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.0.1']) assert.equal(mobileConnectionAddressKind(host), 'lan');
  for (const host of ['100.64.0.1', '100.127.255.254']) assert.equal(mobileConnectionAddressKind(host), 'tailscale');
  for (const host of ['100.63.255.255', '100.128.0.1', '172.15.1.1', '172.32.0.1', '8.8.8.8', '0.0.0.0', '127.1', '010.0.0.1', '256.0.0.1', '::1', 'host.ts.net', '', null]) assert.equal(mobileConnectionAddressKind(host), null);
});

test('connection origins forbid aliases, redirects, public hosts, credentials, paths and noncanonical ports', () => {
  assert.equal(isMobileConnectionOrigin(lan.baseURL), true);
  assert.equal(isMobileConnectionOrigin(tail.baseURL), true);
  assert.equal(isMobileConnectionOrigin('https://10.0.0.1'), true);
  for (const value of ['https://127.1:45391', 'https://100.100.100.10:443', 'https://100.100.100.10:45391/', 'http://100.100.100.10:45391', 'https://user@100.100.100.10:45391', 'https://example.ts.net:45391', 'https://8.8.8.8', 'https://100.100.100.10:45391?x=1', 'https://100.100.100.10:45391#x']) assert.equal(isMobileConnectionOrigin(value), false);
});

test('connection paths capture a bounded detached frozen snapshot and preserve one path per kind', () => {
  const input = reply(), captured = mobileConnectionPathsSnapshot(input);
  input.paths[1]!.certificateSha256 = 'ee'.repeat(32);
  assert.equal(captured.paths[1]!.certificateSha256, tail.certificateSha256);
  assert.equal(Object.isFrozen(captured), true);
  assert.equal(Object.isFrozen(captured.paths), true);
  assert.equal(Object.isFrozen(captured.paths[0]), true);
  assert.throws(() => mobileConnectionPathsSnapshot({ ...reply(), paths: [] }));
  assert.throws(() => mobileConnectionPathsSnapshot({ ...reply(), paths: [lan, lan] }));
  assert.throws(() => mobileConnectionPathsSnapshot({ ...reply(), paths: [lan, tail, tail] }));
  assert.throws(() => mobileConnectionPathsSnapshot({ ...reply(), paths: [{ ...tail, kind: 'lan' }] }));
});

test('connection public configuration remains the existing five-field schema without an authorization token', () => {
  const { kind: _, ...path } = lan;
  const input = { schemaVersion: 1, serverId: 'server.synthetic-paths', ...path };
  const value = mobilePublicConnectionSnapshot(input);
  assert.equal(value.baseURL, lan.baseURL);
  assert.throws(() => mobilePublicConnectionSnapshot({ ...input, accessToken: 'not-a-credential' }));
  assert.throws(() => mobilePublicConnectionSnapshot({ ...input, certificateSha256: 'a'.repeat(63) }));
  assert.throws(() => mobilePublicConnectionSnapshot({ ...input, certificatePEM: 'not a certificate' }));
  assert.throws(() => mobilePublicConnectionSnapshot({ ...input, certificatePEM: 'A'.repeat(8193) }));
});

test('connection paths reject unknown keys, symbols, array accessors and properties without invoking getters', () => {
  assert.throws(() => mobileConnectionPathsSnapshot({ ...reply(), privateField: true }));
  assert.throws(() => mobileConnectionPathsSnapshot({ ...reply(), paths: [{ ...lan, [Symbol('hidden')]: true }] }));
  let reads = 0;
  const object = { ...reply() };
  Object.defineProperty(object, 'paths', { enumerable: true, get() { reads++; return [lan]; } });
  assert.throws(() => mobileConnectionPathsSnapshot(object));
  const array = new Array(1);
  Object.defineProperty(array, '0', { enumerable: true, get() { reads++; return lan; } });
  assert.throws(() => mobileConnectionPathsSnapshot({ ...reply(), paths: array }));
  assert.equal(reads, 0);
  const extra = [lan];
  Object.assign(extra, { injected: true });
  assert.throws(() => mobileConnectionPathsSnapshot({ ...reply(), paths: extra }));
  assert.throws(() => mobileConnectionPathsSnapshot({ ...reply(), paths: new Array(1) }));
});
