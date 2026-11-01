import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import {
  createRoonApiWithPairingCompatibility,
  readRoonCoreNetworkConnection,
  type RoonApiInstance,
  type RoonApiOptions,
  type RoonCore,
} from '../src/roon/sdk.js';

interface NativePairingApi extends RoonApiInstance {
  paired_core_id?: string;
  paired_core?: Pick<RoonCore, 'core_id'>;
  is_paired: boolean;
  pairing_service_1: { found_core(core: RoonCore): void; lost_core(core: RoonCore): void };
  _service_request_handlers: Record<string, (request: { msg: { name: string }; moo: { core: RoonCore } }, mooid: string) => void>;
}

const require = createRequire(import.meta.url);
const NativeRoonApi = require('node-roon-api') as new (options: RoonApiOptions & {
  get_persisted_state(): unknown;
  set_persisted_state(state: unknown): void;
}) => NativePairingApi;

function pairingHarness(selectedId?: string): {
  api: NativePairingApi;
  paired: RoonCore[];
  unpaired: RoonCore[];
  state(): { paired_core_id?: string; tokens: Record<string, string> };
  writes: string[];
} {
  let state = { ...(selectedId ? { paired_core_id: selectedId } : {}), tokens: { coreA: 'synthetic-authorization-a', coreB: 'synthetic-authorization-b' } };
  const paired: RoonCore[] = [], unpaired: RoonCore[] = [], writes: string[] = [];
  const api = createRoonApiWithPairingCompatibility({
    extension_id: 'com.musicbridge.test.offline-pairing', display_name: '合成配对', display_version: '1',
    publisher: '合成测试', email: 'offline@example.invalid', website: 'https://example.invalid', log_level: 'none', force_server: true,
    core_paired: core => { paired.push(core); }, core_unpaired: core => { if (core) unpaired.push(core); },
  }, options => {
    // 使用固定官方SDK的真实Pair handler，替换全部持久化入口；不启动发现、不创建socket、不读用户配置。
    const native = new NativeRoonApi({ ...options, get_persisted_state: () => state, set_persisted_state: next => {
      state = next as typeof state;
      writes.push(state.paired_core_id ?? '');
    } });
    native.load_config = key => key === 'roonstate' ? state : undefined;
    native.save_config = () => { throw new Error('离线测试不得触碰配置文件'); };
    return native;
  }) as NativePairingApi;
  api.init_services({ required_services: [], provided_services: [] });
  return { api, paired, unpaired, state: () => state, writes };
}

function core(id: string): RoonCore {
  // 仅触发配对身份合同，不实例化或访问真实Roon服务。
  return { core_id: id, services: {} as RoonCore['services'] };
}

function requestPair(api: NativePairingApi, target: RoonCore): void {
  api._service_request_handlers['com.roonlabs.pairing:1']!({ msg: { name: 'pair' }, moo: { core: target } }, 'synthetic-connection');
}

test('冷启动恢复已选Core，先出现其他已授权Core也不误选，重连刷新真实Core身份', () => {
  const { api, paired, unpaired, state, writes } = pairingHarness('coreA');
  const authorization = state().tokens;
  const first = core('coreA'), other = core('coreB');
  api.pairing_service_1.found_core(other);
  assert.deepEqual(paired, []);
  api.pairing_service_1.found_core(first);
  assert.deepEqual(paired, [first]);
  assert.equal(api.paired_core, first);
  assert.equal(api.is_paired, true);
  api.pairing_service_1.lost_core(other);
  assert.deepEqual(unpaired, []);
  api.pairing_service_1.lost_core(first);
  assert.deepEqual(unpaired, [first]);
  assert.equal(api.is_paired, false);
  const replacement = core('coreA');
  api.pairing_service_1.found_core(replacement);
  assert.equal(api.paired_core, replacement);
  assert.equal(api.is_paired, true);
  api.pairing_service_1.lost_core(first);
  assert.deepEqual(unpaired, [first]);
  assert.equal(state().tokens, authorization);
  assert.deepEqual(writes, []);
});

test('已选Core离线时官方主动Pair仍可切换目标并保留全部原授权', () => {
  const { api, paired, unpaired, state, writes } = pairingHarness('coreA');
  const authorization = { ...state().tokens };
  const other = core('coreB');
  api.pairing_service_1.found_core(other);
  assert.deepEqual(paired, []);
  requestPair(api, other);
  assert.deepEqual(paired, [other]);
  assert.deepEqual(unpaired, []);
  assert.equal(api.paired_core_id, 'coreB');
  assert.equal(state().paired_core_id, 'coreB');
  assert.deepEqual(state().tokens, authorization);
  assert.deepEqual(writes, ['coreB']);
});

test('在线主动Pair切换后旧Core丢失不会清除新目标', () => {
  const { api, paired, unpaired, state } = pairingHarness('coreA');
  const first = core('coreA'), other = core('coreB');
  api.pairing_service_1.found_core(first);
  api.pairing_service_1.found_core(other);
  requestPair(api, other);
  assert.deepEqual(paired, [first, other]);
  assert.deepEqual(unpaired, [first]);
  api.pairing_service_1.lost_core(first);
  assert.deepEqual(unpaired, [first]);
  assert.equal(api.paired_core, other);
  assert.equal(api.is_paired, true);
  assert.equal(state().paired_core_id, 'coreB');
});

test('真实socket读取规范化映射IPv4，不把配置host当作peer', () => {
  const base = core('coreA');
  const withSocket = (socket: unknown): RoonCore => Object.assign({}, base, {
    moo: { transport: { host: '192.168.50.99', port: 9330, ws: { _socket: socket } } },
  });
  assert.deepEqual(readRoonCoreNetworkConnection(withSocket({ localAddress: '::ffff:192.168.50.10', remoteAddress: '::ffff:192.168.50.20', destroyed: false })), {
    localAddress: '192.168.50.10', remoteAddress: '192.168.50.20',
  });
  assert.equal(readRoonCoreNetworkConnection(withSocket(undefined)), undefined);
  assert.equal(readRoonCoreNetworkConnection(withSocket({ localAddress: '192.168.50.10', remoteAddress: 'not-an-address' })), undefined);
  assert.equal(readRoonCoreNetworkConnection(withSocket({ localAddress: '192.168.50.10', remoteAddress: '192.168.50.20', destroyed: true })), undefined);
});
