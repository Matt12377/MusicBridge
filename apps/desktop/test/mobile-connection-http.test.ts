import assert from 'node:assert/strict';
import test from 'node:test';
import { request as httpsRequest } from 'node:https';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createMobileHttpsServer } from '../src/main/mobile-https-server.js';
import { loadOrCreateMobileIdentity } from '../src/main/mobile-tls-identity.js';
import { MOBILE_CONNECTION_IDENTIFY_PATH, MOBILE_CONNECTION_PATHS_PATH, type MobileConnectionPath, type MobilePublicConnectionConfiguration } from '@music-bridge/contracts';
import { createMobileConnectionHttpBackend, type MobileConnectionHttpInput } from '../src/main/mobile-connection-http.js';
import { MobileServiceError, type MobilePrincipal } from '../../../packages/bridge-core/src/mobile/types.js';

const serverId = 'server.synthetic-connection';
const pem = '-----BEGIN CERTIFICATE-----\nQQ==\n-----END CERTIFICATE-----\n';
const lan: MobileConnectionPath = { kind: 'lan', baseURL: 'https://192.168.20.2:45391', certificatePEM: pem, certificateSha256: 'ab'.repeat(32) };
const tail: MobileConnectionPath = { ...lan, kind: 'tailscale', baseURL: 'https://100.100.100.10:45391', certificateSha256: 'cd'.repeat(32) };
const failure = (status: number) => (error: unknown) => error instanceof MobileServiceError && error.status === status;
function fixture() {
  let live = true, revoked = false, authCalls = 0, checks = 0, now = 1000;
  let paths = [lan, tail];
  const principal: MobilePrincipal = { serverId, deviceId: 'device.synthetic', datasetId: 'dataset.synthetic', accountDomain: 'account.synthetic',
    deviceEpoch: 1, generation: 1, accessTokenHash: 'ef'.repeat(32), accessExpiresAt: '2030-01-01T00:00:00.000Z' };
  const backend = createMobileConnectionHttpBackend({ serverId,
    assertCurrent() { if (!live) throw new MobileServiceError(503, 'BUSY'); },
    publicConnection(origin) { const found = paths.find(v => v.baseURL === origin); if (!found) throw new MobileServiceError(503, 'BUSY');
      return { schemaVersion: 1, serverId, baseURL: found.baseURL, certificatePEM: found.certificatePEM, certificateSha256: found.certificateSha256 }; },
    connectionPaths: () => ({ schemaVersion: 1, serverId, paths }),
    auth: {
      async authenticate(token) { authCalls++; if (revoked || token !== 'synthetic-access') throw new MobileServiceError(401, 'UNAUTHORIZED'); return principal; },
      async assertCurrent(value) { checks++; assert.equal(value, principal); if (revoked) throw new MobileServiceError(401, 'UNAUTHORIZED'); },
    }, now: () => now,
  });
  const input = (path = MOBILE_CONNECTION_IDENTIFY_PATH, endpoint = lan): MobileConnectionHttpInput => ({ method: 'GET', path,
    query: [], headers: [], body: new Uint8Array(), remoteAddress: '192.168.20.3', origin: endpoint.baseURL,
    certificateSha256: endpoint.certificateSha256, accessToken: null, signal: new AbortController().signal });
  return { backend, input, get authCalls() { return authCalls; }, get checks() { return checks; },
    revoke() { revoked = true; }, stop() { live = false; }, advance(ms: number) { now += ms; }, setPaths(value: MobileConnectionPath[]) { paths = value; } };
}

test('connection identify exposes only the existing five public fields for the exact requesting listener', async () => {
  const f = fixture();
  for (const path of [lan, tail]) {
    const reply = await f.backend.dispatch(f.input(MOBILE_CONNECTION_IDENTIFY_PATH, path));
    assert.equal(reply.status, 200);
    const body = JSON.parse(Buffer.from(reply.body).toString()) as MobilePublicConnectionConfiguration;
    assert.deepEqual(Object.keys(body).sort(), ['baseURL', 'certificatePEM', 'certificateSha256', 'schemaVersion', 'serverId']);
    assert.equal(body.baseURL, path.baseURL); assert.equal(body.certificateSha256, path.certificateSha256);
    assert.ok(reply.headers.some(([key, value]) => key.toLowerCase() === 'cache-control' && value.includes('no-store')));
    await reply.beforeSend?.();
  }
  assert.equal(f.authCalls, 0);
});

test('connection paths require one real bearer and return both paths under the original shared auth', async () => {
  const f = fixture();
  await assert.rejects(f.backend.dispatch(f.input(MOBILE_CONNECTION_PATHS_PATH)), failure(401));
  const input = f.input(MOBILE_CONNECTION_PATHS_PATH, tail); input.accessToken = 'synthetic-access'; input.headers = [['Authorization', 'Bearer synthetic-access']];
  const reply = await f.backend.dispatch(input); await reply.beforeSend?.();
  const body = JSON.parse(Buffer.from(reply.body).toString()); assert.equal(body.serverId, serverId); assert.equal(body.paths.length, 2);
  assert.equal(f.authCalls, 1); assert.equal(f.checks, 1);
  f.revoke(); await assert.rejects(reply.beforeSend!(), failure(401));
});

test('connection routes reject method/query/body/cookies, identify credentials and duplicate authorization before lookup', async () => {
  const f = fixture();
  for (const patch of [
    { method: 'POST' }, { query: [['x', '1']] }, { body: new Uint8Array([1]) }, { headers: [['Cookie', 'x=1']] },
    { headers: [['Authorization', 'Bearer synthetic-access']], accessToken: 'synthetic-access' },
  ] as Partial<MobileConnectionHttpInput>[]) await assert.rejects(f.backend.dispatch({ ...f.input(), ...patch }), failure(400));
  const paths = f.input(MOBILE_CONNECTION_PATHS_PATH); paths.accessToken = 'synthetic-access'; paths.headers = [['Authorization', 'Bearer synthetic-access'], ['authorization', 'Bearer synthetic-access']];
  await assert.rejects(f.backend.dispatch(paths), failure(400));
  assert.equal(f.authCalls, 0);
});

test('connection descriptor is fenced to the exact TLS fingerprint and current live service', async () => {
  const f = fixture();
  await assert.rejects(f.backend.dispatch({ ...f.input(), certificateSha256: tail.certificateSha256 }), failure(503));
  const reply = await f.backend.dispatch(f.input()); f.stop(); await assert.rejects(reply.beforeSend!(), failure(503));
  await assert.rejects(f.backend.dispatch(f.input()), failure(503));
});

test('connection paths never publish an authenticated list that omits or silently rotates the current trusted endpoint', async () => {
  const f = fixture();
  const input = f.input(MOBILE_CONNECTION_PATHS_PATH); input.accessToken = 'synthetic-access'; input.headers = [['Authorization', 'Bearer synthetic-access']];
  f.setPaths([tail]); await assert.rejects(f.backend.dispatch(input), failure(503));
  f.setPaths([{ ...lan, certificateSha256: tail.certificateSha256 }, tail]); await assert.rejects(f.backend.dispatch(input), failure(503));
});

test('connection identify probes share a bounded global rate budget across both listeners without issuing pairing', async () => {
  const f = fixture();
  for (let index = 0; index < 12; index++) await f.backend.dispatch(f.input(MOBILE_CONNECTION_IDENTIFY_PATH, index % 2 ? lan : tail));
  await assert.rejects(f.backend.dispatch(f.input()), failure(429));
  f.advance(60_001); await f.backend.dispatch(f.input());
  assert.equal(f.authCalls, 0);
});

test('connection extension is wired to real pinned TLS, rejects alternate request targets, and never enters legacy dispatch', async t => {
  const parent = process.platform === 'darwin' ? '/Volumes/LifeWeave/Developer/CommandLine/tmp' : path.resolve(os.tmpdir());
  const directory = await mkdtemp(path.join(parent, 'mousa-connection-https-')), key = randomBytes(32);
  const identity = await loadOrCreateMobileIdentity({ directory: path.join(directory, 'identity'), hosts: ['127.0.0.1'], secretProtector: {
    encryptString(value) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decryptString(value) {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
    },
  } });
  let baseURL = '', legacy = 0, authenticated = 0;
  const configuration = (): MobilePublicConnectionConfiguration => ({ schemaVersion: 1, serverId: identity.serverId, baseURL,
    certificatePEM: identity.certificatePEM, certificateSha256: identity.certificateSha256 });
  const connection = createMobileConnectionHttpBackend({ serverId: identity.serverId, assertCurrent() {}, publicConnection: configuration,
    connectionPaths: () => ({ schemaVersion: 1, serverId: identity.serverId, paths: [{ kind: 'lan', baseURL,
      certificatePEM: identity.certificatePEM, certificateSha256: identity.certificateSha256 }] }), auth: {
      async authenticate(token) {
        if (token !== 'synthetic-access') throw new MobileServiceError(401, 'UNAUTHORIZED'); authenticated++;
        return { serverId: identity.serverId, deviceId: 'device.synthetic', datasetId: 'dataset.synthetic', accountDomain: 'account.synthetic',
          deviceEpoch: 1, generation: 1, accessTokenHash: 'ef'.repeat(32), accessExpiresAt: '2030-01-01T00:00:00.000Z' };
      }, async assertCurrent() {},
    } });
  const server = createMobileHttpsServer({ tls: { key: identity.privateKeyPEM, cert: identity.certificatePEM }, host: '127.0.0.1', port: 0,
    backend: { async dispatch() { legacy++; throw new MobileServiceError(400, 'INVALID_REQUEST'); } }, connection });
  t.after(async () => {
    await server.close(); identity.authKey.fill(0); key.fill(0);
    assert.equal(path.dirname(path.resolve(directory)), parent); assert.ok(path.basename(directory).startsWith('mousa-connection-https-'));
    await rm(directory, { recursive: true, force: true });
  });
  baseURL = (await server.start()).baseUrl;
  const send = (target: string, headers: string[] = [], method = 'GET') => new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
    const url = new URL(baseURL);
    const request = httpsRequest({ host: url.hostname, port: url.port, path: target, method, agent: false, ca: identity.certificatePEM,
      headers: ['Host', url.host, 'Connection', 'close', ...headers] }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.once('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }));
      response.once('error', reject);
    });
    request.once('error', reject); request.setTimeout(5000, () => request.destroy(new Error('Synthetic TLS deadline.'))); request.end();
  });
  const identify = await send(MOBILE_CONNECTION_IDENTIFY_PATH);
  assert.equal(identify.status, 200); assert.equal(JSON.parse(identify.body.toString()).baseURL, baseURL);
  assert.equal((await send(MOBILE_CONNECTION_PATHS_PATH)).status, 401);
  const paths = await send(MOBILE_CONNECTION_PATHS_PATH, ['Authorization', 'Bearer synthetic-access']);
  assert.equal(paths.status, 200); assert.equal(JSON.parse(paths.body.toString()).paths.length, 1);
  for (const target of [MOBILE_CONNECTION_IDENTIFY_PATH + '?', MOBILE_CONNECTION_IDENTIFY_PATH + '?x=1']) assert.equal((await send(target)).status, 400);
  assert.equal((await send(MOBILE_CONNECTION_IDENTIFY_PATH, [], 'POST')).status, 400);
  assert.equal((await send(MOBILE_CONNECTION_IDENTIFY_PATH, ['X-Forwarded-For', '100.100.100.10'])).status, 400);
  assert.equal(legacy, 0); assert.equal(authenticated, 1);
});
