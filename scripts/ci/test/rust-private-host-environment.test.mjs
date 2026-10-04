import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

// 执行原启动器；只替换Electron进程边界和Main导入，不修改被测环境组装或入口围栏。
for (const [file, entry] of [
  ['private-rust-main-host-wrapper.mjs', 'startPrivateMainHost'],
  ['private-rust-collection-main-host-wrapper.mjs', 'startPrivateCollectionMainHost'],
]) {
  const url = new URL('../../../apps/desktop/e2e/' + file, import.meta.url);
  const source = readFileSync(url, 'utf8');
  const mainImport = "await import(pathToFileURL(path.join(current, 'index.js')).href)";
  assert.ok(source.includes(mainImport), 'Main导入边界必须明确且仍在原启动器内。');
  const body = source.replace(/^import[^\n]+\n/gmu, '').replace('export async function', 'async function')
    .replaceAll('import.meta.url', JSON.stringify(url.href)).replace(mainImport, 'await loadIndex()');
  const current = path.dirname(fileURLToPath(url));
  const temporary = process.env.TMPDIR;
  assert.ok(temporary && path.isAbsolute(temporary));

  async function execute(optional = {}, options = {}) {
    const calls = [];
    const env = { TMPDIR: temporary, MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_CORE_TEST_MODE: '1',
      MUSIC_BRIDGE_UI_E2E_OFFLINE: '1', MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: path.join(temporary, 'musicbridge-ui-e2e-env-unit'), ...optional };
    if (options.online) delete env.MUSIC_BRIDGE_UI_E2E_OFFLINE;
    const utilityProcess = {
      fork(entryPath, args, value) {
        // 官方Electron43.4原生探针已证实：env含undefined时同步拒绝，不进入Core。
        if (Object.values(value.env).some(item => typeof item !== 'string')) throw new TypeError('Invalid value for env');
        calls.push({ entryPath, args, options: value });
        return { stderr: { on() {} }, once() {}, postMessage() {} };
      },
    };
    const context = { path, fileURLToPath, pathToFileURL, process: { env }, utilityProcess,
      MessageChannelMain: class { port1 = {}; port2 = { on() {}, start() {} }; },
      randomUUID: () => 'synthetic-control-id', writeFileSync: () => assert.fail('纯环境测试不应落盘'),
      loadIndex: async () => {
        utilityProcess.fork(path.join(current, options.wrongEntry ? 'other.js' : 'core.js'), ['固定参数'], {
          env: { NODE_ENV: 'test', VALIDATED_CORE_VALUE: 'kept' }, cwd: temporary, stdio: 'ignore', serviceName: 'synthetic',
        });
      },
    };
    try {
      await vm.runInNewContext(body + '\n' + entry + '(false, 100)', context);
      return { calls: JSON.parse(JSON.stringify(calls)), error: null };
    } catch (error) { return { calls: JSON.parse(JSON.stringify(calls)), error }; }
  }

  for (const optional of [{}, { DEV_CACHE_ROOT: temporary }, { DEV_BUILD_ROOT: temporary },
    { DEV_BUILD_ROOT: temporary, DEV_CACHE_ROOT: temporary }]) {
    test(file + '可选开发路径仅存在时传递：' + (Object.keys(optional).join(',') || '全部缺省'), async () => {
      const result = await execute(optional);
      assert.equal(result.error, null);
      assert.equal(result.calls.length, 1);
      const call = result.calls[0];
      assert.equal(call.entryPath, path.join(current, file.includes('collection') ? 'private-rust-collection-node.js' : 'private-rust-node.js'));
      assert.deepEqual(call.options.env, { NODE_ENV: 'test', VALIDATED_CORE_VALUE: 'kept', TMPDIR: temporary, ...optional });
      assert.deepEqual(call.args, ['固定参数']); assert.equal(call.options.cwd, temporary);
      assert.equal(call.options.stdio, 'pipe'); assert.equal(call.options.serviceName, 'synthetic');
    });
  }
  test(file + '未知Core入口拒绝且不调用原fork', async () => {
    const result = await execute({}, { wrongEntry: true });
    assert.ok(result.error); assert.equal(result.error.message, '隔离 Main 不允许未知 Core 入口。');
    assert.deepEqual(result.calls, []);
  });
  test(file + '缺离线标记拒绝且不调用原fork', async () => {
    const result = await execute({}, { online: true });
    assert.ok(result.error); assert.equal(result.error.message, '隔离 Main 必须采用离线合成模式。');
    assert.deepEqual(result.calls, []);
  });
}
