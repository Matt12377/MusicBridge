import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('此固定构建只支持 darwin-arm64。');
const source = path.join(root, 'native/output-helper');
const target = path.join(root, 'apps/desktop/native/output/darwin-arm64');
const intermediate = path.join(root, 'reports/runtime/task-073-output-backend/native-build');
mkdirSync(intermediate, { recursive: true });
for (const name of ['bin', 'build']) mkdirSync(path.join(target, name), { recursive: true });
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`原生构建失败：${result.stderr || result.error || result.status}`);
  return result.stdout;
}
const sdk = run('xcrun', ['--sdk', 'macosx', '--show-sdk-path']).trim();
const flags = ['-std=c++20', '-O2', '-Wall', '-Wextra', '-Werror', '-pthread', '-arch', 'arm64', '-mmacosx-version-min=13.0', '-isysroot', sdk];
for (const name of ['frame-pump', 'synthetic-main', 'core-audio-adapter', 'frame-pump.test']) {
  const output = name === 'core-audio-adapter' ? path.join(target, 'build', `${name}.o`) : path.join(intermediate, `${name}.o`);
  run('xcrun', ['clang++', ...flags, '-c', path.join(source, `${name}.cpp`), '-o', output]);
}
// HAL object 故意不进入可执行文件；禁止通配链接。
run('xcrun', ['clang++', ...flags, path.join(intermediate, 'frame-pump.o'), path.join(intermediate, 'synthetic-main.o'), '-o', path.join(target, 'bin/output-helper')]);
run('xcrun', ['clang++', ...flags, path.join(intermediate, 'frame-pump.o'), path.join(intermediate, 'frame-pump.test.o'), '-o', path.join(intermediate, 'frame-pump-test')]);
// 仅清除此构建器旧版生成的已知中间件，不扫描或删除其他文件。
for (const name of ['frame-pump.o', 'synthetic-main.o', 'frame-pump.test.o', 'frame-pump-test']) rmSync(path.join(target, 'build', name), { force: true });
const loadCommands = run('otool', ['-L', path.join(target, 'bin/output-helper')]);
const symbols = run('nm', ['-u', path.join(target, 'bin/output-helper')]);
if (/CoreAudio|AudioToolbox|AudioUnit|AVFoundation/u.test(loadCommands) || /_Audio(Device|Object|Hardware|Unit)|_dlopen|_dlsym/u.test(symbols)) throw new Error('合成 helper 不能链接或动态加载设备路径。');
const sha = data => createHash('sha256').update(data).digest('hex');
const entries = readdirSync(source).filter(name => /\.(?:cpp|hpp)$/u.test(name)).sort();
const sourceSha256 = sha(entries.map(name => `${name}\0${sha(readFileSync(path.join(source, name)))}\n`).join(''));
const manifest = { schemaVersion: 1, platform: 'darwin', arch: 'arm64', protocolVersion: 1, backendId: 'musicbridge-coreaudio-hal', backendVersion: '0.1.0', mode: 'synthetic-only', files: {
  helper: { path: 'bin/output-helper', sha256: sha(readFileSync(path.join(target, 'bin/output-helper'))) },
  halAdapter: { path: 'build/core-audio-adapter.o', sha256: sha(readFileSync(path.join(target, 'build/core-audio-adapter.o'))) },
}, sourceSha256 };
writeFileSync(path.join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`原生合成构建完成；HAL仅object；sourceSha256=${sourceSha256}`);
