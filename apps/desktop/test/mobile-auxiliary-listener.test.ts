import assert from 'node:assert/strict';
import test from 'node:test';
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, randomBytes, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { MobilePublicConnectionConfiguration } from '@music-bridge/contracts';
import { loadOrCreateMobileIdentity, type MobileSecretProtector } from '../src/main/mobile-tls-identity.js';
import { createMobileAuxiliaryListener } from '../src/main/mobile-auxiliary-listener.js';

// Real encrypted identities/certificates, controlled listeners and prerequisite probe; no VPN, real socket or account evidence.
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t: test.TestContext, primaryHost = '10.99.0.1') {
  const parent = process.platform === 'darwin' ? '/Volumes/LifeWeave/Developer/CommandLine/tmp' : path.resolve(os.tmpdir());
  const directory = await mkdtemp(path.join(parent, 'mousa-aux-listener-')), key = randomBytes(32);
  const protector: MobileSecretProtector = {
    encryptString(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]); },
    decryptString(value) { const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8'); },
  };
  const rootOptions = { directory: path.join(directory, 'identity'), hosts: [primaryHost], secretProtector: protector };
  const root = await loadOrCreateMobileIdentity(rootOptions), primaryBytes = await readFile(path.join(rootOptions.directory, 'identity.json'));
  const primary: MobilePublicConnectionConfiguration = { schemaVersion: 1, serverId: root.serverId, baseURL: `https://${primaryHost}:45391`,
    certificatePEM: root.certificatePEM, certificateSha256: root.certificateSha256 };
  const bindings = new Map([[primary.baseURL, primary]]), added: MobilePublicConnectionConfiguration[] = [], closed: string[] = [], authBuffers: Buffer[] = [];
  let addresses = ['127.0.0.1', '10.99.0.1', '100.100.100.10'], probeResult: string | null = '100.100.100.10';
  let probes = 0, factories = 0, failClose = false, startHook: (() => Promise<void>) | undefined;
  const manager = createMobileAuxiliaryListener({ primary, directory: path.join(directory, 'endpoints'), protector,
    addresses: () => addresses, probeTailscale: async () => { probes++; return probeResult; }, assertCurrent() {},
    async loadRootIdentity() { const value = await loadOrCreateMobileIdentity(rootOptions); authBuffers.push(value.authKey); return value; },
    add(connection) { assert.equal(connection.serverId, primary.serverId); added.push(connection); bindings.set(connection.baseURL, connection); },
    remove(connection) { bindings.delete(connection.baseURL); },
    createServer(input) {
      factories++; const certificate = new X509Certificate(input.tls.cert);
      assert.equal(certificate.checkIP(input.host), input.host); assert.equal(certificate.checkPrivateKey(createPrivateKey(input.tls.key)), true);
      const baseURL = `https://${input.host}:${input.port}`, certificateSha256 = createHash('sha256').update(certificate.raw).digest('hex');
      return { async start() { await startHook?.(); return { baseUrl: baseURL, certificateSha256 }; },
        async close() { closed.push(baseURL); if (failClose) throw new Error('Synthetic close is unconfirmed.'); } };
    },
  });
  t.after(async () => {
    await manager.close().catch(() => {}); root.authKey.fill(0); key.fill(0);
    assert.equal(path.dirname(path.resolve(directory)), parent); assert.ok(path.basename(directory).startsWith('mousa-aux-listener-'));
    await rm(directory, { recursive: true, force: true });
  });
  return { manager, primary, bindings, added, closed, authBuffers, get probes() { return probes; }, get factories() { return factories; },
    setAddresses(value: string[]) { addresses = value; }, setProbe(value: string | null) { probeResult = value; }, setStart(value: typeof startHook) { startHook = value; },
    failClose() { failClose = true; }, async assertPrimaryUnchanged() { assert.deepEqual(await readFile(path.join(rootOptions.directory, 'identity.json')), primaryBytes); } };
}

test('auxiliary Tailscale listener uses the standard port and root auth subject while preserving the LAN pin', async t => {
  const f = await fixture(t); await f.manager.start();
  assert.equal(f.manager.state, 'ready'); assert.equal(f.factories, 1); assert.equal(f.bindings.size, 2);
  assert.equal(f.added[0]!.baseURL, 'https://100.100.100.10:45391'); assert.notEqual(f.added[0]!.certificateSha256, f.primary.certificateSha256);
  assert.equal(new X509Certificate(f.added[0]!.certificatePEM).subject, `CN=${f.primary.serverId}`);
  assert.ok(f.authBuffers.length); assert.ok(f.authBuffers.every(value => value.equals(Buffer.alloc(32))));
  await f.manager.reconcile(); assert.equal(f.factories, 1); assert.equal(f.probes, 1); await f.assertPrimaryUnchanged();
});

test('auxiliary interface loss and replacement close only that listener and derive another host pin under the same root', async t => {
  const f = await fixture(t); await f.manager.start(); const first = f.added[0]!;
  f.setAddresses(['127.0.0.1', '10.99.0.1']); await f.manager.reconcile();
  assert.equal(f.manager.state, 'unavailable'); assert.equal(f.closed.length, 1); assert.equal(f.bindings.size, 1);
  f.setAddresses(['127.0.0.1', '10.99.0.1', '100.100.100.12']); f.setProbe('100.100.100.12'); await f.manager.reconcile();
  assert.equal(f.manager.state, 'ready'); assert.equal(f.factories, 2); assert.equal(f.bindings.size, 2);
  assert.notEqual(f.added[1]!.certificateSha256, first.certificateSha256); assert.equal(f.added[1]!.serverId, first.serverId);
  await f.assertPrimaryUnchanged();
});

test('auxiliary loopback-only preference never probes VPN, loads a root key, or exposes another interface', async t => {
  const f = await fixture(t, '127.0.0.1'); await f.manager.start(); await f.manager.reconcile();
  assert.equal(f.manager.state, 'off'); assert.equal(f.probes, 0); assert.equal(f.authBuffers.length, 0); assert.equal(f.factories, 0);
});

test('auxiliary CLI evidence cannot bind an address absent from the actual interface list', async t => {
  const f = await fixture(t); f.setProbe('100.100.100.99'); await f.manager.start();
  assert.equal(f.manager.state, 'unavailable'); assert.equal(f.factories, 0); assert.equal(f.bindings.size, 1);
});

test('auxiliary start failure is bounded and cannot tear down the healthy primary or lose the failed server cleanup', async t => {
  const f = await fixture(t); f.setStart(async () => { throw new Error('Synthetic bind failure.'); }); await f.manager.start();
  assert.equal(f.manager.state, 'failed'); assert.equal(f.closed.length, 1); assert.equal(f.bindings.size, 1);
  f.setStart(undefined); await f.manager.reconcile(); assert.equal(f.manager.state, 'ready'); assert.equal(f.factories, 2);
});

test('auxiliary close joins an in-flight start and fences its late registration without polling or leaking a listener', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  f.setStart(async () => { entered.resolve(); await release.promise; });
  const start = f.manager.start(); await entered.promise;
  const close = f.manager.close(); assert.equal(close, f.manager.close()); release.resolve(); await start; await close;
  assert.equal(f.added.length, 0); assert.equal(f.closed.length, 1); assert.equal(f.manager.state, 'off');
  assert.ok(f.authBuffers.every(value => value.equals(Buffer.alloc(32))));
});

test('auxiliary unconfirmed close permanently blocks a replacement and remains a real shutdown failure', async t => {
  const f = await fixture(t); await f.manager.start(); f.failClose(); f.setAddresses(['127.0.0.1', '10.99.0.1']); await f.manager.reconcile();
  assert.equal(f.manager.state, 'failed'); assert.equal(f.bindings.size, 1);
  f.setAddresses(['127.0.0.1', '10.99.0.1', '100.100.100.12']); f.setProbe('100.100.100.12'); await f.manager.reconcile();
  assert.equal(f.factories, 1); await assert.rejects(f.manager.close()); assert.ok(f.bindings.has(f.primary.baseURL));
});

test('auxiliary can provide a verified LAN path when the explicitly configured primary is already Tailscale', async t => {
  const f = await fixture(t, '100.100.100.10'); await f.manager.start();
  assert.equal(f.manager.state, 'ready'); assert.equal(f.bindings.size, 2); assert.equal(f.added[0]!.baseURL, 'https://10.99.0.1:45391');
  assert.equal(f.added[0]!.serverId, f.primary.serverId); await f.assertPrimaryUnchanged();
});
