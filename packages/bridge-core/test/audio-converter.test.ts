import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { constants, renameSync, writeFileSync, writeSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { mkdtemp, open, readFile, realpath, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isAudioConversionReceipt, type ExecutionFormat } from '@music-bridge/contracts';
import { authorizeSourceDirectory, probeReadonlySource } from '../src/recording/source-files.js';
import { createFfmpegConverter, AudioConversionError, type PinnedFfmpegBuild } from '../src/recording/audio-converter.js';
import { runConverterProcess, verifyConverterFile } from '../src/recording/conversion-process.js';

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
function wave(rate: number, frames: number): Buffer {
  const bytes = Buffer.alloc(44 + frames * 4);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 4, 28); bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(frames * 4, 40); return bytes;
}
async function fixture(t: test.TestContext, fault = '') {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'musicbridge-converter-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceBytes = wave(44100, 441), outputBytes = wave(96000, 960);
  await writeFile(path.join(directory, 'source.wav'), sourceBytes);
  const root = { ...await authorizeSourceDirectory(directory), id: randomUUID() };
  const source = await probeReadonlySource(root, 'source.wav', new AbortController().signal);
  const dependency = path.join(directory, 'pinned-library'); await writeFile(dependency, 'fixed synthetic dependency', { mode: 0o600 });
  async function program(role: string) {
    const version = `${role} version 8.1.2\nlibswresample 6.3.102\n`;
    const code = `#!${process.execPath}\nimport fs from 'node:fs';\nconst args=process.argv.slice(2);\nif(args[0]==='-version'){process.stdout.write(${JSON.stringify(version)});process.exit(0);}\nif(${JSON.stringify(fault)}==='slow'){setTimeout(()=>process.exit(0),10000);await new Promise(()=>{});}\nif(args.includes('/private/source.wav')||args[args.indexOf('-fd')+1]!=='3')process.exit(90);\nif(${JSON.stringify(role)}==='ffprobe'){process.stdout.write('frame|sample_fmt=s16|nb_samples=${fault === 'frames' ? 440 : 441}|channels=2\\nstream|codec_name=pcm_s16le|sample_fmt=s16|sample_rate=44100|channels=2\\n');}\nelse{fs.writeFileSync(4,Buffer.from(${JSON.stringify(outputBytes.toString('base64'))},'base64'));if(${JSON.stringify(fault)}==='failed'){process.stderr.write('/private/do-not-expose.wav');process.exit(7);}}\n`;
    const filename = path.join(directory, role + '.mjs'); await writeFile(filename, code, { mode: 0o700 });
    return { path: filename, sha256: hash(code), versionSha256: hash(version) };
  }
  const build: PinnedFfmpegBuild = {
    ffmpeg: await program('ffmpeg'), ffprobe: await program('ffprobe'),
    dependencies: [{ id: 'fixture-library', path: dependency, sha256: hash('fixed synthetic dependency') }],
    version: '8.1.2', components: [{ name: 'libswresample', version: '6.3.102' }],
  };
  const format: ExecutionFormat = { sampleRate: 96000, channelCount: 2, channelLayout: 'stereo', outputSampleFormat: 'pcm-s16le', internalProcessingPrecision: 'float64', resamplerImplementation: 'ffmpeg-swr', resamplerVersion: '6.3.102', ditherPolicy: 'none', channelMapping: 'identity', outputBackend: { id: 'no-output', version: '1' }, outputProfileVersion: randomUUID() };
  const converter = createFfmpegConverter(build);
  const plan = converter.plan({ sha256: source.sha256, size: source.size, technical: source.technical }, format);
  async function output() {
    const handle = await open(path.join(directory, randomUUID() + '.wav'), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    t.after(() => handle.close()); return handle;
  }
  return { directory, root, source, sourceBytes, outputBytes, dependency, build, converter, plan, output };
}
const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, error => error instanceof AudioConversionError && error.code === code && !error.message.includes('/'));
function proxy(handle: FileHandle, overrides: Partial<FileHandle>): FileHandle {
  return new Proxy(handle, { get(target, key) { const value = key in overrides ? Reflect.get(overrides, key) : Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value; } });
}

test('受控进程替身：完整解码、固定计划和实际输出回读后才生成回执', async t => {
  const f = await fixture(t), output = await f.output();
  const receipt = await f.converter.convert(f.plan, { root: f.root, relative: 'source.wav' }, output, new AbortController().signal);
  assert.equal(isAudioConversionReceipt(receipt), true); assert.equal(receipt.decoded.frameCount, 441);
  assert.equal(receipt.audio.sha256, hash(f.outputBytes)); assert.equal(receipt.audio.frameCount, 960);
  assert.equal(receipt.formalReady, false); assert.ok(!JSON.stringify(receipt).includes(f.directory));
  assert.deepEqual(await readFile(path.join(f.directory, 'source.wav')), f.sourceBytes);
});

test('转换器或依赖 Hash 改变、计划参数被改写时不启动转换', async t => {
  const f = await fixture(t), output = await f.output(), location = { root: f.root, relative: 'source.wav' };
  const changed = structuredClone(f.plan); changed.processing.parameters = [{ name: 'volume', value: 2 }];
  await rejects(f.converter.convert(changed, location, output, new AbortController().signal), 'INVALID_INPUT');
  await writeFile(f.dependency, 'different');
  await rejects(f.converter.convert(f.plan, location, output, new AbortController().signal), 'BACKEND_CHANGED');
  assert.equal((await output.stat()).size, 0);
});

test('解码缺帧在写出前拒绝；进程失败即使已有合法 WAV 也无成功回执', async t => {
  for (const fault of ['frames', 'failed']) {
    const f = await fixture(t, fault), output = await f.output();
    await rejects(f.converter.convert(f.plan, { root: f.root, relative: 'source.wav' }, output, new AbortController().signal), fault === 'frames' ? 'FRAME_MISMATCH' : 'CONVERSION_FAILED');
    assert.equal((await output.stat()).size > 0, fault === 'failed');
  }
});

test('预取消、非空目标和源 Hash 变化均拒绝，不覆盖原有目标', async t => {
  const f = await fixture(t), output = await f.output(), location = { root: f.root, relative: 'source.wav' };
  const controller = new AbortController(); controller.abort();
  await rejects(f.converter.convert(f.plan, location, output, controller.signal), 'CANCELLED');
  await output.writeFile('keep');
  await rejects(f.converter.convert(f.plan, location, output, new AbortController().signal), 'INVALID_INPUT');
  const empty = await f.output(); await writeFile(path.join(f.directory, 'source.wav'), wave(44100, 442));
  await rejects(f.converter.convert(f.plan, location, empty, new AbortController().signal), 'INPUT_CHANGED');
  assert.equal((await output.stat()).size, 4); assert.equal((await empty.stat()).size, 0);
});

test('输出回读后撤权或改写同尺寸字节，不能返回过期回执', async t => {
  for (const fault of ['revoked', 'changed', 'source-changed']) {
    const f = await fixture(t), output = await f.output(); let read = false, checked = false, fired = false;
    const wrapped = proxy(output, {
      read: (async (bytes: Buffer, offset: number, length: number, position: number) => {
        const result = await output.read(bytes, offset, length, position);
        if (position === 0 && result.bytesRead === f.outputBytes.length) read = true;
        return result;
      }) as FileHandle['read'],
      stat: (async (options: unknown) => { const result = await output.stat(options as { bigint: true }); if (read) checked = true; return result; }) as FileHandle['stat'],
    });
    const check = () => {
      if (checked && !fired) {
        fired = true;
        if (fault === 'revoked') f.root.authorized = false;
        else if (fault === 'source-changed') { const bytes = Buffer.from(f.sourceBytes); bytes[44] = 1; writeFileSync(path.join(f.directory, 'source.wav'), bytes); }
        else writeSync(output.fd, Buffer.from([1]), 0, 1, 44);
      }
    };
    await rejects(f.converter.convert(f.plan, { root: f.root, relative: 'source.wav' }, wrapped, new AbortController().signal, check), fault === 'revoked' ? 'SOURCE_UNAVAILABLE' : 'INPUT_CHANGED');
    assert.equal(fired, true);
  }
});

test('构建文件完成 Hash 后路径被替换，也必须拒绝', async t => {
  const f = await fixture(t), replacement = path.join(f.directory, 'replacement');
  await writeFile(replacement, 'replacement', { mode: 0o600 }); let checks = 0;
  await rejects(verifyConverterFile(f.build.dependencies[0]!, () => {
    if (++checks === 3) renameSync(replacement, f.dependency);
  }), 'BACKEND_CHANGED');
  assert.equal(checks, 3);
});

test('取消转换进程等待实际关闭，目标不能留有后台写者', async t => {
  const f = await fixture(t), output = await f.output(); let pid = 0, cancelled = false;
  const code = "const fs=require('node:fs');fs.writeSync(3,Buffer.from([1]));console.log(process.pid);setInterval(()=>fs.writeSync(3,Buffer.from([2])),10)";
  await rejects(runConverterProcess(process.execPath, ['-e', code], [output.fd], () => {
    if (cancelled) throw new AudioConversionError('CANCELLED');
  }, 'CONVERSION_FAILED', line => { pid = Number(line); cancelled = true; }), 'CANCELLED');
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ESRCH');
  assert.ok((await output.stat()).size >= 1);
});

test('转换总期限也覆盖停滞的解码进程；版本输出 Hash 不匹配在写入前拒绝', async t => {
  const f = await fixture(t, 'slow'), output = await f.output();
  const converter = createFfmpegConverter(f.build, { operationTimeoutMs: 1000 });
  await rejects(converter.convert(f.plan, { root: f.root, relative: 'source.wav' }, output, new AbortController().signal), 'LIMIT_EXCEEDED');
  const changed = structuredClone(f.build); changed.ffprobe.versionSha256 = '0'.repeat(64);
  const other = createFfmpegConverter(changed), plan = other.plan(f.plan.input, f.plan.format);
  await rejects(other.convert(plan, { root: f.root, relative: 'source.wav' }, output, new AbortController().signal), 'BACKEND_CHANGED');
  assert.equal((await output.stat()).size, 0);
});

test('内嵌 Hash 固定的本机构建只从规定目录加载，损坏、错平台和符号链接均拒绝', async t => {
  const { loadBundledConverter } = await import('../src/recording/bundled-converter.js');
  const { ffmpegBuildPolicy } = await import('../src/recording/ffmpeg-build-policy.js');
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'musicbridge-bundled-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(await loadBundledConverter(directory, null), undefined);
  for (const folder of ['bin','lib']) await mkdir(path.join(directory,folder));
  const bytes = Buffer.from('仅用于加载校验的合成文件，不执行'), sha256 = hash(bytes);
  for (const relative of ['bin/ffmpeg','bin/ffprobe',...ffmpegBuildPolicy.libraries.map(l => `lib/${l.id}`)]) await writeFile(path.join(directory,relative),bytes);
  const manifest = { schemaVersion:1, platform:'darwin', arch:'arm64', minimumMacOS:'13.0', sourceSha256:ffmpegBuildPolicy.source.sha256, license:'LGPL-2.1-or-later', build:{version:'8.1.2',ffmpeg:{path:'bin/ffmpeg',sha256,versionSha256:sha256},ffprobe:{path:'bin/ffprobe',sha256,versionSha256:sha256},dependencies:ffmpegBuildPolicy.libraries.map(l=>({id:l.id,path:`lib/${l.id}`,sha256})),components:ffmpegBuildPolicy.libraries.map(l=>({name:l.name,version:l.version}))} };
  async function put(value: unknown) { const data=JSON.stringify(value);await writeFile(path.join(directory,'manifest.json'),data);return hash(data); }
  const expected=await put(manifest), converter=await loadBundledConverter(directory,expected);
  assert.equal(converter!.identity.version,'8.1.2');assert.equal(converter!.identity.binarySha256,sha256);
  await assert.rejects(loadBundledConverter(directory,'0'.repeat(64)));
  await assert.rejects(loadBundledConverter(directory,await put({...manifest,arch:'x64'})));
  await assert.rejects(loadBundledConverter(directory,await put({...manifest,build:{...manifest.build,ffmpeg:{...manifest.build.ffmpeg,path:'../external'}}})));
  await assert.rejects(loadBundledConverter(directory,await put({...manifest,build:{...manifest.build,dependencies:[]}})));
  await put(manifest);await writeFile(path.join(directory,'bin/ffmpeg'),'已改变');await assert.rejects(loadBundledConverter(directory,expected));
  await rm(path.join(directory,'bin/ffmpeg'));await symlink('ffprobe',path.join(directory,'bin/ffmpeg'));await assert.rejects(loadBundledConverter(directory,expected));
});

test('本机构建策略固定源码与最小能力，不接受外部依赖、GPL、nonfree 或网络', async () => {
  const { ffmpegConfigureArgs, ffmpegBuildPolicy } = await import('../src/recording/ffmpeg-build-policy.js');
  const args=ffmpegConfigureArgs();
  for(const required of ['--disable-autodetect','--disable-everything','--disable-gpl','--disable-nonfree','--disable-version3','--disable-network','--enable-shared','--disable-static','--enable-protocol=fd']) assert.ok(args.includes(required));
  assert.equal(ffmpegBuildPolicy.source.sha256,'464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c');
  assert.ok(!args.some(a=>a.startsWith('--enable-lib')||/https|homebrew|Users\//.test(a)));
  args.push('--enable-gpl');assert.ok(!ffmpegConfigureArgs().includes('--enable-gpl'));
});
