import test from 'node:test';
import assert from 'node:assert/strict';
import { desktopDevChildEnvironment } from '../../desktop-dev-workspace.mjs';

test('开发子进程清除继承的 Electron Node 模式，原环境与代理设置保持不变', () => {
  const inherited = Object.freeze({ ELECTRON_RUN_AS_NODE: '1', PATH: '/synthetic/bin', HOME: '/synthetic/home',
    HTTP_PROXY: 'http://synthetic.invalid:1234', HTTPS_PROXY: 'http://synthetic.invalid:2345',
    ALL_PROXY: 'socks5://synthetic.invalid:3456', NO_PROXY: '127.0.0.1,synthetic.local',
    https_proxy: 'http://synthetic.invalid:4567', NODE_OPTIONS: '--use-env-proxy', MB_SYNTHETIC: 'preserved' });
  const next = desktopDevChildEnvironment(inherited);
  assert.equal(Object.hasOwn(next, 'ELECTRON_RUN_AS_NODE'), false);
  assert.equal(inherited.ELECTRON_RUN_AS_NODE, '1');
  assert.deepEqual(next, { PATH: inherited.PATH, HOME: inherited.HOME, HTTP_PROXY: inherited.HTTP_PROXY,
    HTTPS_PROXY: inherited.HTTPS_PROXY, ALL_PROXY: inherited.ALL_PROXY, NO_PROXY: inherited.NO_PROXY,
    https_proxy: inherited.https_proxy, NODE_OPTIONS: inherited.NODE_OPTIONS, MB_SYNTHETIC: inherited.MB_SYNTHETIC });
});

test('正常终端环境不增添或删除其他字段', () => {
  assert.deepEqual(desktopDevChildEnvironment({ PATH: '/synthetic/bin' }), { PATH: '/synthetic/bin' });
});
