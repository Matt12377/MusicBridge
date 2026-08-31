import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [label, sanitizer = 'none'] = process.argv.slice(2);
if (!label || !/^[a-z0-9-]{1,48}$/u.test(label) || !['none', 'address', 'thread'].includes(sanitizer) || process.argv.length > 4) throw new Error('用法：node scripts/test-output-lifecycle.mjs <唯一证据名> [none|address|thread]');
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('此独立原生验证仅支持darwin-arm64。');
const runtime = path.join(root, 'reports/runtime/task-073-output-lifecycle');
mkdirSync(runtime, { recursive: true });
const directory = path.join(runtime, label); mkdirSync(directory);
const entryPath = path.join(runtime, 'entry.json');
const entry = existsSync(entryPath) ? JSON.parse(readFileSync(entryPath, 'utf8')) : undefined;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const nativePaths = [
  ...['bin/ffmpeg', 'bin/ffprobe', 'legal/BUILD.json', 'legal/COPYING.LGPLv2.1', 'legal/LICENSE.md', 'legal/NOTICE.txt', 'legal/ffmpeg-8.1.2.tar.xz',
    'lib/libavcodec.62.dylib', 'lib/libavfilter.11.dylib', 'lib/libavformat.62.dylib', 'lib/libavutil.60.dylib', 'lib/libswresample.6.dylib', 'manifest.json'].map(name => 'apps/desktop/native/ffmpeg/darwin-arm64/' + name),
  ...['bin/output-helper', 'build/core-audio-adapter.o', 'manifest.json'].map(name => 'apps/desktop/native/output/darwin-arm64/' + name),
].sort();
if (entry && (!entry.native || JSON.stringify(Object.keys(entry.native).sort()) !== JSON.stringify(nativePaths))) throw new Error('阶段基线的固定16文件列表无效。');
function pins() {
  const current = Object.fromEntries(nativePaths.map(name => {
    const file = path.join(root, name);
    let stat;
    try { stat = lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return [name, null]; throw error; }
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('原生快照文件必须是单链接常规文件。');
    return [name, digest(readFileSync(file))];
  }));
  if (entry && nativePaths.some(name => current[name] !== entry.native[name])) throw new Error('固定16原生文件身份不匹配，停止独立验证。');
  return { baseline: entry ? 'stage-entry' : 'current-only', installedFiles: Object.values(current).filter(Boolean).length, files: current };
}
const before = pins();
writeFileSync(path.join(directory, 'pins-before.json'), JSON.stringify(before, null, 2));
console.log(entry ? '使用阶段基线，严格核验16个固定原生文件。' : `没有阶段基线；仅检查当前${before.installedFiles}个已安装原生文件前后不变，不宣称16文件基线通过。`);
const commands = [];
function run(name, command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', env, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  writeFileSync(path.join(directory, name + '.log'), (result.stdout ?? '') + (result.stderr ?? '') + (result.error ? '\n' + result.error.message : ''));
  commands.push({ command, args, cwd: root, exit: result.status, signal: result.signal });
  writeFileSync(path.join(directory, 'commands.json'), JSON.stringify(commands, null, 2));
  if (result.status !== 0) { process.exitCode = result.status ?? 1; throw new Error(`${name}失败，证据保留于${directory}`); }
  return result.stdout;
}
try {
  const sdk = run('sdk', 'xcrun', ['--sdk', 'macosx', '--show-sdk-path']).trim();
  const flags = ['-std=c++20', '-O1', '-g', '-Wall', '-Wextra', '-Werror', '-pthread', '-arch', 'arm64', '-mmacosx-version-min=13.0', '-isysroot', sdk];
  if (sanitizer !== 'none') flags.push(sanitizer === 'address' ? '-fsanitize=address,undefined' : '-fsanitize=thread', '-fno-omit-frame-pointer');
  const binary = path.join(directory, 'device-session-test');
  run('compile', 'xcrun', ['clang++', ...flags, 'native/output-helper/frame-pump.cpp', 'native/output-lifecycle/device-session.cpp', 'native/output-lifecycle/device-session.test.cpp', '-o', binary]);
  const libraries = run('libraries', 'otool', ['-L', binary]);
  const symbols = run('symbols', 'nm', ['-u', binary]);
  if (/CoreAudio|AudioToolbox|AudioUnit|AVFoundation/u.test(libraries) || /_Audio(Device|Object|Hardware|Unit)|_dlopen|_dlsym/u.test(symbols)) throw new Error('生命周期测试不能链接或动态加载设备路径。');
  const env = { ...process.env, ...(sanitizer === 'address' ? { ASAN_OPTIONS: 'detect_leaks=0:halt_on_error=1', UBSAN_OPTIONS: 'halt_on_error=1:print_stacktrace=1' } : sanitizer === 'thread' ? { TSAN_OPTIONS: 'halt_on_error=1' } : {}) };
  if (sanitizer === 'address') console.log('运行ASan与UBSan；本机不支持LSan，未运行动态泄漏扫描。');
  const output = run('test', binary, [], env); process.stdout.write(output);
} catch (error) { process.exitCode ||= 1; console.error(error.message); }
finally {
  const after = pins();
  writeFileSync(path.join(directory, 'pins-after.json'), JSON.stringify(after, null, 2));
  if (JSON.stringify(after) !== JSON.stringify(before)) { process.exitCode = 1; console.error('独立测试期间原生文件安装状态或身份发生变化。'); }
}
