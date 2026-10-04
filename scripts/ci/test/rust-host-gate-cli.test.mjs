import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// 执行两个原CLI的纯解析片段；不启动编译器或Electron，不创建产品输出。
for (const [name, modes] of [['rust-main-host-gate.mjs', ['build', 'components', 'electron']], ['rust-collection-host-gate.mjs', ['build', 'electron', 'acceptance']]]) {
  const source = readFileSync(new URL('../../../apps/desktop/scripts/' + name, import.meta.url), 'utf8');
  const cli = source.slice(source.indexOf('const values ='), source.indexOf('const storage ='));
  function parse(args) { return JSON.parse(JSON.stringify(vm.runInNewContext('(function(){\n' + cli + '\nreturn { output, mode }; })()', { assert, path, process: { argv: ['node', name, ...args] } }))); }
  test(name + '默认与显式build同义，唯一模式各可解析', () => {
    const output = path.join(process.env.TMPDIR, 'musicbridge-cli-new-host');
    assert.deepEqual(parse(['--output=' + output]), { output, mode: 'build' });
    assert.deepEqual(parse(['--output=' + output, '--mode=build']), { output, mode: 'build' });
    for (const mode of modes) assert.equal(parse(['--output=' + output, '--mode=' + mode]).mode, mode);
    assert.doesNotMatch(source, /mode\s*===\s*['"]all['"]/u);
    assert.doesNotMatch(source.match(/用法[^\n]+/u)?.[0] ?? '', /\|all/u);
    for (const mode of modes) assert.match(source, new RegExp("if \\(mode === '" + mode + "'\\)"));
  });
  test(name + 'all及不支持模式在存储或spawn之前明确拒绝', () => {
    const output = path.join(process.env.TMPDIR, 'musicbridge-cli-new-host');
    for (const mode of ['all', 'unknown', name.startsWith('rust-main') ? 'acceptance' : 'components']) assert.throws(() => parse(['--output=' + output, '--mode=' + mode]));
    assert.throws(() => parse(['--mode=build'])); assert.throws(() => parse(['--output=' + output, '--mode=build', '--unexpected=true']));
    assert.ok(source.indexOf('const storage =') < source.indexOf('await mkdir(output)'));
  });
}
test('现有完整Rust producer保持两显式build，CLI修整不引入第二pipeline', () => {
  const source = readFileSync(new URL('../verify-rust-core.mjs', import.meta.url), 'utf8');
  for (const name of ['rust-main-host-gate.mjs', 'rust-collection-host-gate.mjs']) {
    const call = source.slice(source.indexOf("['apps/desktop/scripts/" + name), source.indexOf("['apps/desktop/scripts/" + name) + 180);
    assert.match(call, /--mode=build/u);
  }
});
