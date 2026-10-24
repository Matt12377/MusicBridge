import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, randomBytes, X509Certificate } from 'node:crypto';
import { createServer } from 'node:net';
import { request as httpsRequest } from 'node:https';
import os, { type NetworkInterfaceInfo } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { createMobileConnectionSettings, installMobileConnectionHandlers } from '../../src/main/mobile-settings.js';
import { loadOrCreateMobileIdentity, type MobileSecretProtector } from '../../src/main/mobile-tls-identity.js';
import { mobileContentRpcFailure } from '../../../../packages/bridge-core/src/mobile/content-rpc.js';
import { isMobileOwnerPrivateResult } from '../../../../packages/bridge-core/src/mobile/owner-protocol.js';
import { MobileAuthPersistenceError, type MobileOwnerPrivateResult,
  type MobileSealedState } from '../../../../packages/bridge-core/src/mobile/types.js';
import type { MobilePublicConnection } from '../../src/shared/mobile-settings.js';

test('可信sender先于全部移动副作用；额外参数零派发，内部异常不泄漏路径或许可', async () => {
  const handlers = new Map<string, (event: boolean, ...args: unknown[]) => unknown>(); let calls = 0;
  const internal = async () => { calls++; throw new Error('/private/synthetic-path synthetic-secret'); };
  const settings = { get: internal, configure: internal, issuePairing: internal, revokeDevice: internal } as unknown as ReturnType<typeof createMobileConnectionSettings>;
  installMobileConnectionHandlers({ handle: (channel, listener) => { handlers.set(channel, listener); }, requireTrusted: event => { if (!event) throw new Error('拒绝不可信调用。'); }, settings });
  assert.deepEqual([...handlers.keys()], ['mobile:settings', 'mobile:configure', 'mobile:pairing', 'mobile:revoke-device']);
  for (const handler of handlers.values()) assert.throws(() => handler(false), /拒绝不可信调用/u);
  for (const [channel, args] of [['mobile:settings', [1]], ['mobile:configure', []], ['mobile:pairing', [1]], ['mobile:revoke-device', [null]]] as const) {
    assert.throws(() => handlers.get(channel)!(true, ...args), /移动连接请求无效/u);
  }
  assert.equal(calls, 0);
  for (const [channel, args] of [['mobile:settings', []], ['mobile:configure', [{}]], ['mobile:pairing', []], ['mobile:revoke-device', ['synthetic-device']]] as const) {
    await assert.rejects(Promise.resolve(handlers.get(channel)!(true, ...args)), error => error instanceof Error && error.message === '移动连接操作未完成，请刷新设置查看状态。');
  }
  assert.equal(calls, 4);
});

test('默认OFF无身份/Owner副作用；设置队列满也共享同一个完整关闭flight', async () => {
  const temporary = process.env.TMPDIR, hostedRoot = process.env.RUNNER_TEMP;
  const hosted = process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted'
    && typeof hostedRoot === 'string' && path.isAbsolute(hostedRoot) && typeof temporary === 'string' && temporary.startsWith(hostedRoot + path.sep);
  assert.ok(typeof temporary === 'string' && (process.platform === 'darwin' && temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/') || hosted));
  const directory = mkdtempSync(path.join(temporary, 'mbm001-off-settings-')); let effects = 0;
  const unexpected = (): never => { effects++; throw new Error('OFF不应访问私有身份或Owner。'); };
  const settings = createMobileConnectionSettings({ directory, environment: 'development',
    protector: { encryptString: unexpected, decryptString: unexpected }, currentDataset: async () => unexpected(), requestOwner: async () => unexpected(),
    isCoreReady: () => true, resizeArtwork: unexpected });
  const initial = await settings.get(); assert.equal(initial.enabled, false); assert.equal(initial.state, 'off'); assert.equal(initial.connection, null);
  const queued = Array.from({ length: 8 }, () => settings.configure({ enabled: false, host: '127.0.0.1', port: 45391 }));
  const first = settings.close(), repeated = settings.close(); assert.equal(first, repeated);
  assert.equal((await Promise.allSettled(queued)).every(result => result.status === 'rejected'), true);
  await first; const final = await settings.get(); assert.equal(final.enabled, false); assert.equal(final.state, 'off'); assert.equal(final.connection, null);
  assert.equal(effects, 0); await assert.rejects(settings.issuePairing());
});

async function unusedLoopbackPort(): Promise<number> {
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve);
  });
  const address = reservation.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  return address.port;
}

function request(connection: MobilePublicConnection, target: string, body?: unknown, token?: string) {
  const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const url = new URL(connection.baseURL);
  return new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
    const call = httpsRequest({ hostname: url.hostname, port: url.port, path: target, method: bytes ? 'POST' : 'GET',
      ca: connection.certificatePEM, agent: false, headers: {
        Connection: 'close', ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length,
          'Idempotency-Key': 'settings.close.synthetic.claim' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}),
      } }, response => {
      const chunks: Buffer[] = []; response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      response.once('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }));
      response.once('error', reject); response.once('aborted', () => reject(new Error('合成响应已关闭。')));
    });
    call.once('error', reject); call.setTimeout(5000, () => call.destroy(new Error('合成请求等待已结束。'))); call.end(bytes);
  });
}

/** 真正设置/HTTPS/Auth；仅隔离目录中的保护器与 Owner/内容传输受控，不连接真实服务。 */
async function failedCloseFixture(t: TestContext, induceContentFailure = true, identityHosts?: readonly string[]) {
  const temporary = process.env.TMPDIR, hostedRoot = process.env.RUNNER_TEMP;
  const hosted = process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted'
    && typeof hostedRoot === 'string' && path.isAbsolute(hostedRoot) && typeof temporary === 'string' && temporary.startsWith(hostedRoot + path.sep);
  assert.ok(typeof temporary === 'string' && (process.platform === 'darwin' && temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/') || hosted));
  const directory = mkdtempSync(path.join(temporary, 'mbm001-failed-close-')), key = randomBytes(32);
  const datasetId = '50000000-0000-4000-8000-000000000073';
  let auth: MobileSealedState = { kind: 'missing', datasetId, revision: 0 }, starts = 0;
  let failAuthRead = false;
  const rpc: string[] = [];
  const protector: MobileSecretProtector = {
      encryptString(value) {
        const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
        const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), body]);
      },
      decryptString(value) {
        const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28));
        return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
      },
    };
  if (identityHosts) {
    const identity = await loadOrCreateMobileIdentity({ directory: path.join(directory, 'identity'), secretProtector: protector, hosts: identityHosts });
    identity.authKey.fill(0);
  }
  const settings = createMobileConnectionSettings({ directory, environment: 'development',
    protector, currentDataset: async () => { starts++; return datasetId; }, isCoreReady: () => true, resizeArtwork: bytes => bytes,
    async requestOwner(input): Promise<MobileOwnerPrivateResult> {
      let result: MobileOwnerPrivateResult;
      if (input.kind === 'load') {
        if (failAuthRead) { failAuthRead = false; throw new MobileAuthPersistenceError('not-sent'); }
        result = structuredClone(auth);
      }
      else if (input.kind === 'playback-load') result = { kind: 'missing', datasetId, revision: 0 };
      else if (input.kind === 'save') {
        assert.equal(input.request.expectedRevision, auth.revision);
        auth = { kind: 'sealed', datasetId, revision: auth.revision + 1, commitId: input.request.commitId,
          sealed: new Uint8Array(input.request.sealed) };
        result = { kind: 'saved', datasetId, revision: auth.revision, commitId: auth.commitId };
      } else throw new Error('本例不访问来源、目录或真实数据库。');
      assert.ok(isMobileOwnerPrivateResult(result, input)); return result;
    },
    async requestContentRpc(input) {
      rpc.push(input.action);
      if (input.action === 'initialize') return { type: 'mobile-content-core-response', id: input.id, action: 'initialize', ok: true };
      if (input.action === 'scope' || input.action === 'cancel') return mobileContentRpcFailure(input, new MobileAuthPersistenceError('unknown'));
      throw new Error('本例不派发内容或来源业务。');
    },
  });
  t.after(async () => {
    // 传输已给出受控未知回包；原关闭拒绝由正文检查，清理仅处理本测试自有文件。
    await settings.close().catch(() => {}); key.fill(0); if (auth.kind === 'sealed') auth.sealed.fill(0);
    await rm(directory, { recursive: true, force: true });
  });
  const configuration = { enabled: true, host: '127.0.0.1', port: await unusedLoopbackPort() };
  const started = await settings.configure(configuration); assert.equal(started.state, 'ready'); assert.ok(started.connection);
  const permit = await settings.issuePairing();
  const paired = await request(started.connection, '/mobile/v1/pairings/claim', { pairingSecret: permit.pairingSecret,
    installationId: 'settings.close.synthetic.installation', deviceName: '合成客户端' });
  assert.equal(paired.status, 201);
  const pair: unknown = JSON.parse(paired.body.toString('utf8'));
  assert.ok(pair && typeof pair === 'object' && 'accessToken' in pair && typeof pair.accessToken === 'string');
  if (induceContentFailure) assert.equal((await request(started.connection, '/mobile/v1/capabilities', undefined, pair.accessToken)).status, 503);
  await new Promise<void>(resolve => setImmediate(resolve));
  return { settings, configuration, directory, rpc, starts: () => starts, failNextAuthRead: () => { failAuthRead = true; } };
}

test('无关网卡变化仍复用所选地址的原证书和配对，未覆盖的所选地址仍拒绝', async t => {
  const ipv4 = (address: string, internal = false): NetworkInterfaceInfo => ({ address, netmask: '255.255.255.0', family: 'IPv4',
    mac: '00:00:00:00:00:00', internal, cidr: `${address}/24` });
  let bridge = '172.16.1.1';
  const interfaces = t.mock.method(os, 'networkInterfaces', () => ({ lo0: [ipv4('127.0.0.1', true), ipv4('127.0.0.2', true)], bridge0: [ipv4(bridge)] }));
  syncBuiltinESMExports();
  t.after(() => { interfaces.mock.restore(); syncBuiltinESMExports(); });
  // 模拟升级前的证书；改变的是无关桥接网卡，实际监听地址仍在旧证书内。
  const f = await failedCloseFixture(t, false, ['127.0.0.1', '172.16.1.3']);
  const before = await f.settings.get(); assert.equal(before.state, 'ready'); assert.ok(before.connection);
  assert.equal(before.devices.length, 1); assert.ok(before.hosts.includes(bridge));
  const certificate = new X509Certificate(before.connection.certificatePEM);
  assert.equal(certificate.checkIP('127.0.0.1'), '127.0.0.1');
  assert.equal(certificate.checkIP('172.16.1.3'), '172.16.1.3');
  assert.equal(certificate.checkIP(bridge), undefined);
  const file = path.join(f.directory, 'identity', 'identity.json'), identityBefore = await readFile(file);
  assert.equal((await f.settings.configure({ ...f.configuration, enabled: false })).state, 'off');
  bridge = '172.16.1.2';
  const reopened = await f.settings.configure(f.configuration); assert.equal(reopened.state, 'ready');
  const restored = await f.settings.get();
  assert.deepEqual(restored.connection, before.connection); assert.deepEqual(restored.devices, before.devices);
  assert.deepEqual(await readFile(file), identityBefore); assert.ok(restored.hosts.includes(bridge));
  // 该地址确在本机地址列表中且可供回环绑定，原证书没有授权它；不能借此次修复放行。
  const uncovered = await f.settings.configure({ ...f.configuration, host: '127.0.0.2' });
  assert.equal(uncovered.state, 'failed'); assert.equal(uncovered.connection, null);
  assert.deepEqual(await readFile(file), identityBefore);
  assert.equal((await f.settings.configure(f.configuration)).state, 'ready');
  const recovered = await f.settings.get();
  assert.deepEqual(recovered.connection, before.connection); assert.deepEqual(recovered.devices, before.devices);
});

test('设置刷新：一次授权纯读暂错后可重新读取原设备，不重启或重新配对', async t => {
  const f = await failedCloseFixture(t, false), before = await f.settings.get();
  assert.equal(before.state, 'ready'); assert.equal(before.devices.length, 1);
  f.failNextAuthRead(); assert.equal((await f.settings.get()).state, 'failed');
  const recovered = await f.settings.get();
  assert.equal(recovered.state, 'ready'); assert.deepEqual(recovered.devices, before.devices);
  assert.deepEqual(recovered.connection, before.connection); assert.equal(f.starts(), 1);
  await f.settings.close();
});

test('设置关闭失败：重复关闭或重新开启不能遗忘原未静止服务，退出也不得伪报成功', async t => {
  for (const enabled of [false, true]) await t.test(enabled ? '重新开启' : '重复关闭', async child => {
    const f = await failedCloseFixture(child);
    await assert.rejects(f.settings.configure({ ...f.configuration, enabled: false }));
    const preference = await readFile(path.join(f.directory, 'connection.json'), 'utf8');
    assert.equal(f.starts(), 1); assert.deepEqual(f.rpc, ['initialize', 'scope', 'cancel', 'cancel']);
    await assert.rejects(f.settings.configure({ ...f.configuration, enabled }));
    assert.equal(f.starts(), 1, '原服务未获静止确认前不能创建替代服务。');
    assert.equal(await readFile(path.join(f.directory, 'connection.json'), 'utf8'), preference, '失败操作不能提交新的连接偏好。');
    assert.deepEqual(f.rpc, ['initialize', 'scope', 'cancel', 'cancel'], '不能重放业务或增加取消轮询。');
    await assert.rejects(f.settings.close());
  });
});
