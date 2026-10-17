// CUE八族独立构建：只接受固定离线输入和全新外置输出，不碰旧录音/mobile配方。
import { constants } from 'node:fs';
import { mkdir, open, readFile, writeFile, copyFile, realpath, lstat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { buildStoragePolicy } from '../../apps/desktop/scripts/build-storage-root.mjs';
import { CUE_NATIVE_SOURCE_INPUTS, CUE_FFMPEG_LIBRARIES, CUE_FFMPEG_CONFIGURE,
  CUE_NATIVE_STAGE_MS, CUE_NATIVE_WHOLE_MS, CUE_NATIVE_RAW_BYTES } from '../../packages/bridge-core/src/library/cue-ffmpeg-build-policy.ts';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const args = process.argv.slice(2);
if (process.platform !== 'darwin' || process.arch !== 'arm64' || !process.versions.node.startsWith('22.') || args.length !== 7)
  throw new Error('CUE构建要求macOS arm64/Node22：五个固定源码包、新输出目录、新工作目录。');
const storage = buildStoragePolicy(), started = performance.now();
const output = storage.check(path.resolve(args[5])), work = storage.check(path.resolve(args[6]));
const temp = storage.check(process.env.TMPDIR, { mustExist: true });
if (output === work || output.startsWith(work + path.sep) || work.startsWith(output + path.sep))
  throw new Error('工作目录与输出必须是两个独立的新目录。');
const archives = [];
for (let i = 0; i < 5; i++) {
  const file = storage.check(path.resolve(args[i]), { mustExist: true, kind: 'file' });
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || await realpath(file) !== file || before.size !== CUE_NATIVE_SOURCE_INPUTS[i].bytes)
    throw new Error('源码不是固定完整普通文件。');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const body = await handle.readFile(), after = await handle.stat();
    if (hash(body) !== CUE_NATIVE_SOURCE_INPUTS[i].sha256 || before.dev !== after.dev || before.ino !== after.ino
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new Error('完整源码SHA或文件身份变化。');
  } finally { await handle.close(); }
  archives.push(file);
}
await mkdir(work, { mode: 0o700 });
await mkdir(output, { mode: 0o700 });
for (const part of ['bin', 'lib', 'legal']) await mkdir(path.join(output, part), { mode: 0o700 });
const modules = path.join(work, 'modules'), dep = path.join(work, 'dependencies');
await mkdir(modules); await mkdir(dep);
const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C', TMPDIR: temp,
  DEV_BUILD_ROOT: storage.root, DEV_CACHE_ROOT: process.env.DEV_CACHE_ROOT,
  MACOSX_DEPLOYMENT_TARGET: '13.0', CC: '/usr/bin/clang', CXX: '/usr/bin/clang++',
  CFLAGS: '-O2 -mmacosx-version-min=13.0 -fmodules-cache-path=' + modules,
  CXXFLAGS: '-O2 -mmacosx-version-min=13.0 -fmodules-cache-path=' + modules,
  CPPFLAGS: '-I' + path.join(dep, 'include'), LDFLAGS: '-L' + path.join(dep, 'lib'),
  PKG_CONFIG: '/opt/homebrew/bin/pkg-config',
  PKG_CONFIG_PATH: path.join(dep, 'lib/pkgconfig'), PKG_CONFIG_LIBDIR: path.join(dep, 'lib/pkgconfig') };
const stages = [];
async function run(label, program, argv, cwd = work) {
  const remaining = CUE_NATIVE_WHOLE_MS - (performance.now() - started);
  if (remaining <= 0) throw new Error('CUE构建整体480秒期限已到。');
  const deadline = Math.min(CUE_NATIVE_STAGE_MS, remaining), begin = performance.now();
  const child = spawn(program, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const parts = { stdout: [], stderr: [] }, sizes = { stdout: 0, stderr: 0 };
  let failure = null;
  const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') failure ??= 'PROCESS_GROUP_CLOSE_FAILED'; } };
  const timer = setTimeout(() => { failure ??= 'DEADLINE'; kill(); }, deadline);
  for (const stream of ['stdout', 'stderr']) child[stream].on('data', bytes => {
    sizes[stream] += bytes.length;
    if (sizes[stream] > CUE_NATIVE_RAW_BYTES) { failure ??= 'RAW_OVER_16MIB'; kill(); }
    else parts[stream].push(bytes);
  });
  const result = await new Promise(resolve => {
    child.once('error', () => { failure ??= 'SPAWN'; });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  if (child.pid) {
    try { process.kill(-child.pid, 0); failure ??= 'DESCENDANT_STILL_OPEN'; kill(); }
    catch (error) { if (error.code !== 'ESRCH') failure ??= 'PROCESS_GROUP_INSPECTION_FAILED'; }
  }
  const raw = {};
  for (const stream of ['stdout', 'stderr']) {
    const body = Buffer.concat(parts[stream]);
    await writeFile(path.join(work, label + '.' + stream + '.log'), body, { flag: 'wx', mode: 0o600 });
    raw[stream] = { bytes: body.length, sha256: hash(body) };
  }
  const receipt = { label, ...result, failure, elapsedMs: performance.now() - begin, deadlineMs: deadline, pid: child.pid ?? null, raw };
  stages.push(receipt);
  await writeFile(path.join(work, label + '.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  if (failure || result.code !== 0 || result.signal) throw new Error(label + '失败，完整原始日志保留在专属工作目录。');
  return Buffer.concat(parts.stdout).toString('utf8');
}
try {
  for (let i = 0; i < 5; i++) {
    const source = CUE_NATIVE_SOURCE_INPUTS[i];
    const list = await run('list-' + source.id, '/usr/bin/tar', ['-tf', archives[i]]);
    for (const name of list.trim().split('\n')) {
      if (!(name === source.directory + '/' || name.startsWith(source.directory + '/')) || name.startsWith('/')
          || name.split('/').includes('..') || /[\x00-\x1f\x7f]/u.test(name)) throw new Error('源码成员路径越界。');
    }
    await run('extract-' + source.id, '/usr/bin/tar', ['-xf', archives[i], '--no-same-owner', '--no-same-permissions', '-C', work]);
  }
  const recipes = {
    ogg: ['--enable-shared', '--disable-static', '--disable-docs'],
    vorbis: ['--enable-shared', '--disable-static', '--disable-examples', '--disable-docs', '--with-ogg=' + dep],
    opus: ['--enable-shared', '--disable-static', '--disable-doc', '--disable-extra-programs', '--disable-deep-plc', '--disable-dred', '--disable-osce'],
    lame: ['--enable-shared', '--disable-static', '--disable-decoder', '--disable-frontend', '--disable-nasm'],
  };
  for (const id of ['ogg', 'vorbis', 'opus', 'lame']) {
    const source = path.join(work, CUE_NATIVE_SOURCE_INPUTS.find(row => row.id === id).directory);
    const build = path.join(work, 'build-' + id); await mkdir(build);
    await run('configure-' + id, path.join(source, 'configure'), ['--prefix=' + dep, ...recipes[id]], build);
    const makeOptions = ['-j4'];
    if (id === 'vorbis') {
      // 1.3.7的Darwin配方仍注入旧PowerPC选项，当前arm64链接器不接受。
      // 仅覆盖生成的make变量；原始源码与其余配置参数完整保留。
      const generated = await readFile(path.join(build, 'Makefile'), 'utf8');
      const flags = /^CFLAGS = (.*)$/mu.exec(generated)?.[1];
      if (!flags || !flags.includes('-force_cpusubtype_ALL')) throw new Error('固定Vorbis旧Darwin参数前提变化。');
      const corrected = flags.replace(/(?:^|\s)-force_cpusubtype_ALL(?=\s|$)/gu, '');
      makeOptions.push('CFLAGS=' + corrected);
      recipes.vorbisMake = ['CFLAGS:仅移除-force_cpusubtype_ALL'];
    }
    await run('make-' + id, '/usr/bin/make', makeOptions, build);
    await run('install-' + id, '/usr/bin/make', ['install'], build);
  }
  const ff = path.join(work, 'ffmpeg-8.1.2'), build = path.join(work, 'build-ffmpeg'), stage = path.join(work, 'stage-ffmpeg');
  await mkdir(build);
  await run('configure-ffmpeg', path.join(ff, 'configure'), [...CUE_FFMPEG_CONFIGURE], build);
  const config = await readFile(path.join(build, 'config.h'), 'utf8');
  for (const flag of ['GPL', 'NONFREE', 'VERSION3', 'NETWORK'])
    if (!config.includes('#define CONFIG_' + flag + ' 0')) throw new Error('FFmpeg许可或网络开关错误。');
  await run('make-ffmpeg', '/usr/bin/make', ['-j4'], build);
  await run('install-ffmpeg', '/usr/bin/make', ['install', 'DESTDIR=' + stage], build);
  const installed = path.join(stage, 'MusicBridgeCue');
  const names = ['bin/ffmpeg', 'bin/ffprobe', ...CUE_FFMPEG_LIBRARIES.map(row => 'lib/' + row.id)];
  for (const relative of names) {
    const original = path.join(relative.startsWith('bin/') || relative.includes('libav') || relative.includes('libswresample') ? installed : dep, relative);
    const canonical = await realpath(original);
    if (!canonical.startsWith(work + path.sep) || !(await lstat(canonical)).isFile()) throw new Error('构建产物来源越界。');
    await copyFile(canonical, path.join(output, relative), constants.COPYFILE_EXCL);
  }
  const allowedLibraries = new Set(CUE_FFMPEG_LIBRARIES.map(row => row.id));
  const system = new Set(['/usr/lib/libSystem.B.dylib', '/usr/lib/libc++.1.dylib', '/usr/lib/libm.1.dylib',
    '/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation',
    '/System/Library/Frameworks/CoreMedia.framework/Versions/A/CoreMedia',
    '/System/Library/Frameworks/CoreVideo.framework/Versions/A/CoreVideo']);
  const files = [];
  for (const relative of names) {
    const file = path.join(output, relative), label = relative.replaceAll('/', '-');
    if (relative.startsWith('lib/')) await run('id-' + label, '/usr/bin/install_name_tool', ['-id', '@rpath/' + path.basename(file), file]);
    const originalLinks = await run('original-links-' + label, '/usr/bin/otool', ['-L', file]);
    for (const line of originalLinks.split('\n').slice(1)) {
      const linked = line.trim().split(' (')[0];
      if (linked && allowedLibraries.has(path.basename(linked)) && linked !== '@rpath/' + path.basename(linked))
        await run('relocate-' + label + '-' + path.basename(linked), '/usr/bin/install_name_tool', ['-change', linked, '@rpath/' + path.basename(linked), file]);
    }
    const load = await run('load-' + label, '/usr/bin/otool', ['-l', file]);
    const rpaths = [...load.matchAll(/cmd LC_RPATH\n\s+cmdsize \d+\n\s+path (.+?) \(offset/gu)].map(match => match[1]);
    if (rpaths.some(value => value !== '@executable_path/../lib')) throw new Error('产物含未授权rpath。');
    if (!rpaths.length) await run('rpath-' + label, '/usr/bin/install_name_tool', ['-add_rpath', '@executable_path/../lib', file]);
    await run('sign-' + label, '/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', file]);
    await run('signature-' + label, '/usr/bin/codesign', ['--verify', '--strict', file]);
    if ((await run('arch-' + label, '/usr/bin/lipo', ['-archs', file])).trim() !== 'arm64') throw new Error('产物架构不符合arm64。');
    const linked = await run('links-' + label, '/usr/bin/otool', ['-L', file]);
    const dependencies = linked.split('\n').slice(1).map(line => line.trim().split(' (')[0]).filter(Boolean);
    if (dependencies.some(value => !system.has(value) && !allowedLibraries.has(value.replace(/^@rpath\//u, ''))))
      throw new Error('产物存在未授权动态依赖。');
    const body = await readFile(file); files.push({ relative, bytes: body.length, sha256: hash(body), dependencies });
  }
  for (const program of ['ffmpeg', 'ffprobe']) {
    const version = await run('version-' + program, path.join(output, 'bin', program), ['-version']);
    if (!version.startsWith(program + ' version 8.1.2 ') || !version.includes('--disable-network') || version.includes('--enable-gpl'))
      throw new Error('实际版本与许可配方不一致。');
  }
  const protocols = await run('protocols', path.join(output, 'bin/ffmpeg'), ['-hide_banner', '-protocols']);
  if (protocols.split('\n').map(line => line.trim()).filter(line => line && !['Supported file protocols:', 'Input:', 'Output:', 'fd'].includes(line)).length)
    throw new Error('CUE程序暴露了非FD协议。');
  for (let i = 0; i < 5; i++) {
    const source = CUE_NATIVE_SOURCE_INPUTS[i], legal = path.join(output, 'legal', source.id); await mkdir(legal);
    await copyFile(archives[i], path.join(legal, source.archive), constants.COPYFILE_EXCL);
    for (const name of source.legal) await copyFile(path.join(work, source.directory, name), path.join(legal, name), constants.COPYFILE_EXCL);
  }
  const manifest = { schemaVersion: 1, purpose: 'cue-independent-eight-format-output', platform: 'darwin', arch: 'arm64', minimumMacOS: '13.0',
    sources: CUE_NATIVE_SOURCE_INPUTS, configure: CUE_FFMPEG_CONFIGURE, configureSha256: hash(JSON.stringify(CUE_FFMPEG_CONFIGURE)),
    externalRecipes: recipes, components: CUE_FFMPEG_LIBRARIES, files, protocols: ['fd'],
    actualEncodeDecodeEofQualification: null, releaseReady: false };
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(output, 'legal/NOTICE.txt'), 'CUE独立后端使用FFmpeg8.1.2及共享LAME/Ogg/Vorbis/Opus；对应完整源码、许可证与配方随目录提供。\nFFmpeg禁止GPL/nonfree/version3及网络，LAME解码器/前端未启用，Opus模型增强显式关闭。\n本地ad-hoc签名仅为开发候选，不代表Developer ID、公证或发布接受。\n', { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(work, 'result.json'), JSON.stringify({ state: 'BUILT_NOT_YET_ENCODE_DECODE_QUALIFIED', elapsedMs: performance.now() - started,
    manifestSha256: hash(await readFile(path.join(output, 'manifest.json'))), files, stages }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ state: 'BUILT_NOT_YET_ENCODE_DECODE_QUALIFIED', files: files.length, elapsedMs: performance.now() - started }));
} catch (error) {
  await writeFile(path.join(work, 'failure.json'), JSON.stringify({ state: 'FAILED', message: error.message, elapsedMs: performance.now() - started, stages }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  throw error;
}
