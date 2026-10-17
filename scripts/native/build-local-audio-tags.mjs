// TagLib保护副本后端：固定离线源码、显式SDK编译器、封闭共享库和全新输出。
import { constants } from 'node:fs';
import { mkdir, open, readFile, writeFile, copyFile, lstat, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { buildStoragePolicy } from '../../apps/desktop/scripts/build-storage-root.mjs';

const source = { id: 'taglib', version: '2.3.2', archive: 'taglib-2.3.2.tar.gz', directory: 'taglib-2.3.2',
  url: 'https://taglib.org/releases/taglib-2.3.2.tar.gz', bytes: 1799985,
  sha256: '3ca2d8afaa7f1cf7f6ed10e511ebc368bfacd6dcaa3dbfa690b89e502e8963dc',
  authenticity: 'official-https-and-fixed-first-observed-sha256', independentSignature: null };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const args = process.argv.slice(2), started = performance.now();
if (args.length !== 3 || process.platform !== 'darwin' || process.arch !== 'arm64' || !process.versions.node.startsWith('22.'))
  throw new Error('TagLib构建要求macOS arm64/Node22：固定源码包、新输出目录、新工作目录。');
const storage = buildStoragePolicy();
const archive = storage.check(path.resolve(args[0]), { mustExist: true, kind: 'file' });
const output = storage.check(path.resolve(args[1])), work = storage.check(path.resolve(args[2]));
const temp = storage.check(process.env.TMPDIR, { mustExist: true });
if (output === work || output.startsWith(work + path.sep) || work.startsWith(output + path.sep)) throw new Error('工作目录与输出必须独立。');
const before = await lstat(archive), handle = await open(archive, constants.O_RDONLY | constants.O_NOFOLLOW);
try {
  const bytes = await handle.readFile(), after = await handle.stat();
  if (!before.isFile() || before.isSymbolicLink() || await realpath(archive) !== archive || bytes.length !== source.bytes || digest(bytes) !== source.sha256
    || before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
    throw new Error('TagLib固定源码身份不匹配。');
} finally { await handle.close(); }
await mkdir(output, { mode: 0o700 }); await mkdir(work, { mode: 0o700 });
for (const part of ['bin', 'lib', 'legal']) await mkdir(path.join(output, part), { mode: 0o700 });
const modules = path.join(work, 'modules'); await mkdir(modules);
const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C', TMPDIR: temp,
  DEV_BUILD_ROOT: storage.root, DEV_CACHE_ROOT: process.env.DEV_CACHE_ROOT, MACOSX_DEPLOYMENT_TARGET: '13.0' };
const stages = [];
async function run(label, program, argv, cwd = work) {
  const remaining = 480000 - (performance.now() - started);
  if (remaining <= 0) throw new Error('TagLib整体480秒期限已到。');
  const deadline = Math.min(180000, remaining), begin = performance.now();
  const child = spawn(program, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const parts = { stdout: [], stderr: [] }, sizes = { stdout: 0, stderr: 0 }; let failure = null;
  const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') failure ??= 'PROCESS_GROUP_CLOSE_FAILED'; } };
  const timer = setTimeout(() => { failure ??= 'DEADLINE'; kill(); }, deadline);
  for (const stream of ['stdout', 'stderr']) child[stream].on('data', bytes => {
    sizes[stream] += bytes.length;
    if (sizes[stream] > 16 * 1024 * 1024) { failure ??= 'RAW_OVER_16MIB'; kill(); } else parts[stream].push(bytes);
  });
  const result = await new Promise(resolve => { child.once('error', () => { failure ??= 'SPAWN'; }); child.once('close', (code, signal) => resolve({ code, signal })); });
  clearTimeout(timer);
  if (child.pid) { try { process.kill(-child.pid, 0); failure ??= 'DESCENDANT_STILL_OPEN'; kill(); } catch (error) { if (error.code !== 'ESRCH') failure ??= 'PROCESS_GROUP_INSPECTION_FAILED'; } }
  const raw = {};
  for (const stream of ['stdout', 'stderr']) {
    const bytes = Buffer.concat(parts[stream]); await writeFile(path.join(work, label + '.' + stream + '.log'), bytes, { flag: 'wx', mode: 0o600 });
    raw[stream] = { bytes: bytes.length, sha256: digest(bytes) };
  }
  const receipt = { label, program, argv, ...result, failure, elapsedMs: performance.now() - begin, deadlineMs: deadline, pid: child.pid ?? null, raw };
  stages.push(receipt); await writeFile(path.join(work, label + '.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  if (failure || result.code !== 0 || result.signal) throw new Error(label + '失败，完整日志保留在专属工作目录。');
  return Buffer.concat(parts.stdout).toString('utf8');
}
const configure = ['-G', 'Unix Makefiles', '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0', '-DCMAKE_OSX_ARCHITECTURES=arm64',
  '-DCMAKE_C_COMPILER=/usr/bin/clang', '-DCMAKE_CXX_COMPILER=/usr/bin/clang++', '-DCMAKE_MAKE_PROGRAM=/usr/bin/make',
  '-DCMAKE_CXX_FLAGS=-fmodules-cache-path=' + modules, '-DBUILD_SHARED_LIBS=ON', '-DBUILD_BINDINGS=OFF', '-DBUILD_EXAMPLES=OFF', '-DBUILD_TESTING=OFF',
  '-DWITH_APE=ON', '-DWITH_MP4=ON', '-DWITH_RIFF=ON', '-DWITH_VORBIS=ON', '-DWITH_ZLIB=OFF',
  '-DWITH_ASF=OFF', '-DWITH_DSF=OFF', '-DWITH_MATROSKA=OFF', '-DWITH_MOD=OFF', '-DWITH_SHORTEN=OFF', '-DWITH_TRUEAUDIO=OFF',
  '-DCMAKE_FIND_USE_SYSTEM_ENVIRONMENT_PATH=OFF', '-DCMAKE_FIND_USE_PACKAGE_REGISTRY=OFF', '-DCMAKE_FIND_USE_SYSTEM_PACKAGE_REGISTRY=OFF',
  '-DCMAKE_FIND_FRAMEWORK=NEVER', '-DCMAKE_FIND_APPBUNDLE=NEVER'];
try {
  await run('cmake-version', '/opt/homebrew/bin/cmake', ['--version']);
  await run('compiler-version', '/usr/bin/clang++', ['--version']);
  const members = (await run('source-members', '/usr/bin/tar', ['-tzf', archive])).split('\n').filter(Boolean);
  if (!members.length || members.some(name => !name.startsWith(source.directory + '/') || name.split('/').some(part => part === '..') || /[\x00-\x1f\x7f\\]/u.test(name)))
    throw new Error('TagLib归档成员不符合固定安全范围。');
  await run('extract-source', '/usr/bin/tar', ['-xzf', archive, '-C', work]);
  const sourceDirectory = path.join(work, source.directory), build = path.join(work, 'build'), prefix = path.join(work, 'install');
  await run('configure', '/opt/homebrew/bin/cmake', ['-S', sourceDirectory, '-B', build, '-DCMAKE_INSTALL_PREFIX=' + prefix, ...configure]);
  await run('make', '/opt/homebrew/bin/cmake', ['--build', build, '--parallel', '4']);
  await run('install', '/opt/homebrew/bin/cmake', ['--install', build]);
  const sourceHelper = fileURLToPath(new URL('../../native/local-audio-tags/taglib-helper.cpp', import.meta.url));
  const helperBytes = await readFile(sourceHelper); await writeFile(path.join(work, 'taglib-helper.cpp'), helperBytes, { flag: 'wx', mode: 0o600 });
  const library = path.join(output, 'lib/libtag.2.dylib');
  const actualLibrary = await realpath(path.join(prefix, 'lib/libtag.2.dylib'));
  if (!actualLibrary.startsWith(work + path.sep) || !(await lstat(actualLibrary)).isFile()) throw new Error('TagLib共享库来源越界。');
  await copyFile(actualLibrary, library, constants.COPYFILE_EXCL);
  await run('library-id', '/usr/bin/install_name_tool', ['-id', '@rpath/libtag.2.dylib', library]);
  const program = path.join(output, 'bin/mb-audio-tags');
  await run('compile-helper', '/usr/bin/clang++', ['-std=c++17', '-O2', '-arch', 'arm64', '-mmacosx-version-min=13.0', '-fmodules-cache-path=' + modules,
    '-I' + path.join(prefix, 'include/taglib'), path.join(work, 'taglib-helper.cpp'), library, '-Wl,-rpath,@executable_path/../lib', '-o', program]);
  const files = [], allowed = new Set(['@rpath/libtag.2.dylib', '/usr/lib/libSystem.B.dylib', '/usr/lib/libc++.1.dylib']);
  for (const relative of ['bin/mb-audio-tags', 'lib/libtag.2.dylib']) {
    const file = path.join(output, relative), id = relative.replaceAll('/', '-');
    await run('sign-' + id, '/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', file]);
    await run('signature-' + id, '/usr/bin/codesign', ['--verify', '--strict', file]);
    if ((await run('arch-' + id, '/usr/bin/lipo', ['-archs', file])).trim() !== 'arm64') throw new Error('TagLib产物架构不符合arm64。');
    const linked = await run('links-' + id, '/usr/bin/otool', ['-L', file]);
    const dependencies = linked.split('\n').slice(1).map(line => line.trim().split(' (')[0]).filter(Boolean);
    if (dependencies.some(name => !allowed.has(name))) throw new Error('TagLib产物存在宿主共享库依赖。');
    const bytes = await readFile(file); files.push({ relative, bytes: bytes.length, sha256: digest(bytes), dependencies });
  }
  await copyFile(archive, path.join(output, 'legal', source.archive), constants.COPYFILE_EXCL);
  const legal = [];
  for (const relative of ['COPYING.LGPL', 'COPYING.MPL', 'AUTHORS', '3rdparty/utfcpp/LICENSE']) {
    const bytes = await readFile(path.join(sourceDirectory, relative)), target = relative.replaceAll('/', '-');
    await writeFile(path.join(output, 'legal', target), bytes, { flag: 'wx', mode: 0o600 }); legal.push({ relative: 'legal/' + target, bytes: bytes.length, sha256: digest(bytes) });
  }
  const manifest = { schemaVersion: 1, purpose: 'owner-protected-audio-copy-tags', platform: 'darwin', arch: 'arm64', minimumMacOS: '13.0', source,
    helperSource: { bytes: helperBytes.length, sha256: digest(helperBytes) }, configure, configureSha256: digest(JSON.stringify(configure)),
    formats: ['flac', 'alac', 'mp3', 'vorbis', 'opus', 'wavpack', 'pcm-wav', 'pcm-aiff'], files, legal,
    actualProtectedCopyQualification: null, releaseReady: false };
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(work, 'result.json'), JSON.stringify({ state: 'BUILT_NOT_YET_PROTECTED_COPY_QUALIFIED', elapsedMs: performance.now() - started,
    manifestSha256: digest(await readFile(path.join(output, 'manifest.json'))), files, stages }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ state: 'BUILT_NOT_YET_PROTECTED_COPY_QUALIFIED', files: files.length, elapsedMs: performance.now() - started }));
} catch (error) {
  await writeFile(path.join(work, 'failure.json'), JSON.stringify({ state: 'FAILED', message: error.message, elapsedMs: performance.now() - started, stages }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  throw error;
}
