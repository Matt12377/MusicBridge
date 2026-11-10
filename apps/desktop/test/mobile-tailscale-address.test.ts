import assert from 'node:assert/strict';
import test from 'node:test';
import { captureMobileTailscaleAddress, detectMobileTailscaleAddress } from '../src/main/mobile-tailscale-address.js';

const local = ['127.0.0.1', '10.99.0.1', '100.100.100.10'];
const running = { BackendState: 'Running', Self: { TailscaleIPs: ['fd7a:115c:a1e0::1', '100.100.100.10'] },
  AuthURL: 'https://invalid.example/synthetic-only', Peer: { synthetic: { HostName: 'not-returned' } } };

test('Tailscale prerequisite projection returns only an actual Self CGNAT IPv4, not peers or account data', () => {
  assert.equal(captureMobileTailscaleAddress(running, local), '100.100.100.10');
  assert.equal(captureMobileTailscaleAddress({ ...running, BackendState: 'NeedsLogin' }, local), null);
  assert.equal(captureMobileTailscaleAddress(running, ['127.0.0.1', '10.99.0.1']), null);
  assert.equal(captureMobileTailscaleAddress({ BackendState: 'Running', Self: { TailscaleIPs: ['10.99.0.1', '127.0.0.1', '100.63.255.255', '100.128.0.1'] } }, local), null);
});

test('Tailscale prerequisite projection rejects malformed, sparse, accessor and oversized address evidence without invoking getters', () => {
  let reads = 0;
  const accessor = { BackendState: 'Running', get Self() { reads++; return running.Self; } };
  const addresses = ['100.100.100.10']; Object.defineProperty(addresses, '0', { enumerable: true, get() { reads++; return '100.100.100.10'; } });
  for (const value of [null, [], {}, accessor, { BackendState: 'Running', Self: { TailscaleIPs: addresses } },
    { BackendState: 'Running', Self: { TailscaleIPs: new Array(2) } },
    { BackendState: 'Running', Self: { TailscaleIPs: new Array(17).fill('100.100.100.10') } }]) {
    assert.equal(captureMobileTailscaleAddress(value, local), null);
  }
  assert.equal(reads, 0);
});

test('Tailscale prerequisite probe has no subprocess reason when the OS has no CGNAT interface', async () => {
  assert.equal(await detectMobileTailscaleAddress(['127.0.0.1', '10.99.0.1']), null);
});
