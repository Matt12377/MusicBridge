// 固定macOS FSEvents后端；不下载依赖，编译输入与完整原始日志保留在外置目录。
import { constants } from 'node:fs';
import { open, lstat, realpath, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStoragePolicy } from '../../apps/desktop/scripts/build-storage-root.mjs';

const args = process.argv.slice(2);
if (args.length !== 2 || process.platform !== 'darwin' || process.arch !== 'arm64' || !process.versions.node.startsWith('22.'))
  throw new Error('目录监听构建要求macOS arm64/Node22和两个全新外置目录。');
const storage = buildStoragePolicy(), output = storage.check(path.resolve(args[0])), work = storage.check(path.resolve(args[1]));
if (output === work || output.startsWith(work + path.sep) || work.startsWith(output + path.sep)) throw new Error('监听构建目录须独立。');
storage.check(process.env.TMPDIR, { mustExist: true });
await mkdir(output, { mode: 0o700 }); await mkdir(work, { mode: 0o700 });
await mkdir(path.join(work, 'modules'), { mode: 0o700 });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sourcePath = fileURLToPath(new URL('../../native/library-watch/fsevents-helper.cpp', import.meta.url));
const fd = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
let source;
try { const before = await fd.stat({ bigint: true }); if (!before.isFile() || before.nlink !== 1n || before.size > 65536n || await realpath(sourcePath) !== sourcePath) throw new Error('监听编译输入无效。');
  source = await fd.readFile(); const after = await fd.stat({ bigint: true }), named = await lstat(sourcePath, { bigint: true });
  if (['dev','ino','size','mtimeNs','ctimeNs'].some(key => before[key] !== after[key] || after[key] !== named[key])) throw new Error('监听编译输入在读取期间改变。');
} finally { await fd.close(); }
if (source.length !== 18771 || sha(source) !== '41adaa8b5218c257324e52fccbb3c60efce829691fb777686e46041812a3a03a')
  throw new Error('监听编译源码不属于当前固定配方。');
await writeFile(path.join(work, 'fsevents-helper.cpp'), source, { flag: 'wx', mode: 0o600 });
await mkdir(path.join(output, 'legal'), { mode: 0o700 });
await writeFile(path.join(output, 'legal/fsevents-helper.cpp'), source, { flag: 'wx', mode: 0o600 });
const stages = [], begin = Date.now();
async function run(id, program, argv) {
  const remaining = 480000 - (Date.now() - begin); if (remaining <= 0) throw new Error('监听构建整体期限已到。');
  const child = spawn(program, argv, { cwd: work, detached: true, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TMPDIR: process.env.TMPDIR },
    stdio: ['ignore','pipe','pipe'] });
  const raw = [[],[]], sizes = [0,0]; let failure = null;
  const kill = () => { if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') failure ??= 'PROCESS_GROUP_CLOSE_FAILED'; } };
  const timer = setTimeout(() => { failure ??= 'DEADLINE'; kill(); }, Math.min(180000, remaining));
  [child.stdout, child.stderr].forEach((stream, index) => stream.on('data', bytes => {
    sizes[index] += bytes.length; if (sizes[index] > 16 * 1024 * 1024) { failure ??= 'RAW_OVER_BUDGET'; kill(); } else raw[index].push(bytes);
  }));
  const result = await new Promise(resolve => { child.once('error', () => { failure ??= 'SPAWN'; }); child.once('close', (code, signal) => resolve({ code, signal })); });
  clearTimeout(timer);
  if (child.pid) try { process.kill(-child.pid, 0); failure ??= 'DESCENDANT_OPEN'; kill(); } catch (error) { if (error.code !== 'ESRCH') failure ??= 'PROCESS_GROUP_UNKNOWN'; }
  const pins = {};
  for (const [index, stream] of ['stdout','stderr'].entries()) {
    const bytes = Buffer.concat(raw[index]); const relative = id + '.' + stream + '.log';
    await writeFile(path.join(work, relative), bytes, { flag: 'wx', mode: 0o600 }); pins[stream] = { relative, bytes: bytes.length, sha256: sha(bytes) };
  }
  const receipt = { id, program, argv, ...result, failure, pid: child.pid ?? null, raw: pins };
  stages.push(receipt); await writeFile(path.join(work, id + '.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  if (failure || result.code !== 0 || result.signal) throw new Error('目录监听编译阶段失败，完整原始日志保留。');
  return Buffer.concat(raw[0]).toString('utf8');
}
const program = path.join(output, 'mb-library-watch');
await run('compiler', '/usr/bin/clang++', ['--version']);
await run('compile', '/usr/bin/clang++', ['-std=c++17','-O2','-arch','arm64','-mmacosx-version-min=13.0',
  '-fmodules-cache-path=' + path.join(work, 'modules'), path.join(work, 'fsevents-helper.cpp'), '-framework','CoreServices','-framework','CoreFoundation','-o',program]);
await run('sign', '/usr/bin/codesign', ['--force','--sign','-','--timestamp=none',program]);
await run('signature', '/usr/bin/codesign', ['--verify','--strict',program]);
if ((await run('architecture','/usr/bin/lipo',['-archs',program])).trim() !== 'arm64') throw new Error('监听产物架构无效。');
const dependencies = (await run('dependencies','/usr/bin/otool',['-L',program])).split('\n').slice(1).map(line => line.trim().split(' (')[0]).filter(Boolean);
const allowed = new Set(['/usr/lib/libSystem.B.dylib','/usr/lib/libc++.1.dylib',
  '/System/Library/Frameworks/CoreServices.framework/Versions/A/CoreServices',
  '/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation']);
if (new Set(dependencies).size !== dependencies.length || dependencies.length !== allowed.size || dependencies.some(value => !allowed.has(value)))
  throw new Error('监听共享库依赖越过固定系统闭集。');
const binaryFd = await open(program, constants.O_RDONLY | constants.O_NOFOLLOW); let binary;
try {
  const before = await binaryFd.stat({ bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > 1048576n || (before.mode & 0o111n) === 0n || await realpath(program) !== program)
    throw new Error('监听编译产物不是固定普通程序。');
  binary = await binaryFd.readFile(); const after = await binaryFd.stat({ bigint: true }), named = await lstat(program, { bigint: true });
  if (['dev','ino','mode','nlink','size','mtimeNs','ctimeNs'].some(key => before[key] !== after[key] || before[key] !== named[key]))
    throw new Error('监听编译产物在捕获期间改变。');
} finally { await binaryFd.close(); }
const manifest = { schema: 'musicbridge.fsevents-bundle.v1', platform: 'darwin', architecture: 'arm64',
  source: { relative: 'native/library-watch/fsevents-helper.cpp', bytes: source.length, sha256: sha(source) },
  program: { relative: 'mb-library-watch', bytes: binary.length, sha256: sha(binary), dependencies }, qualifiedRuntime: false };
const manifestRaw = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
await writeFile(path.join(output, 'manifest.json'), manifestRaw, { flag: 'wx', mode: 0o600 });
await writeFile(path.join(work, 'result.json'), JSON.stringify({ build: 'PASSED', runtime: 'NOT_RUN', stages,
  capturedArtifacts: [{ relative: 'manifest.json', bytes: manifestRaw.length, sha256: sha(manifestRaw) },
    { relative: 'mb-library-watch', bytes: binary.length, sha256: sha(binary) },
    { relative: 'legal/fsevents-helper.cpp', bytes: source.length, sha256: sha(source) }],
  actualMonitorQualificationGranted: false }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
