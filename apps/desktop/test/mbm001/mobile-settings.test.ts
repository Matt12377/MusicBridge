import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { createMobileConnectionSettings, installMobileConnectionHandlers } from '../../src/main/mobile-settings.js';

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
