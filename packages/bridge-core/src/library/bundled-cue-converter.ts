import { constants } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { CUE_NATIVE_SOURCE_INPUTS, CUE_FFMPEG_LIBRARIES, CUE_FFMPEG_CONFIGURE, CUE_INPUT_DEMUXERS } from './cue-ffmpeg-build-policy.js';

export type CueFormatId = 'flac' | 'alac' | 'mp3' | 'vorbis' | 'opus' | 'wavpack' | 'pcm-wav' | 'pcm-aiff';
export type CuePcmProfile = 's16' | 's24' | 's32' | 'f32';
export type CueInputDemuxer = typeof CUE_INPUT_DEMUXERS[number];
export interface CueNativeFilePin { relative: string; bytes: number; sha256: string; dependencies: readonly string[] }
export interface CueNativeBundle { root: string; manifestSha256: string; files: readonly CueNativeFilePin[] }
export interface CueNativeClaim { commandId: string; claimId: string; assertCurrent(): void | Promise<void> }
export interface CueNativeRun { exitCode: 0; signal: null; stdout: Uint8Array; stderr: Uint8Array; pid: number; pidClosed: true }
export class CueNativeRunError extends Error {
  constructor(readonly raw: { exitCode: number | null; signal: NodeJS.Signals | null; stdout: Uint8Array; stderr: Uint8Array; pid: number | null; pidClosed: boolean }) {
    super('CUE实际音频处理失败，未发布输出。');
  }
}
export interface CueEncodeInput {
  source: FileHandle; target: FileHandle; demuxer: CueInputDemuxer; format: CueFormatId; profile?: CuePcmProfile;
  startFrame: number; frameCount: number; sampleRate: number; channels: 1 | 2; sourceClaim: CueNativeClaim; targetClaim: CueNativeClaim;
}
const admitted = new WeakSet<CueNativeBundle>();
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const fail = (message = 'CUE后端或原文件身份不符合固定合同。'): never => { throw new Error(message); };
const positive = (value: number): boolean => Number.isSafeInteger(value) && value > 0;
async function whole(file: string, maximum = 64 * 1024 * 1024): Promise<Buffer> {
  if (await realpath(file) !== file) return fail();
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maximum) || (before.mode & 0o022n) !== 0n) return fail();
    const bytes = await handle.readFile(), after = await handle.stat({ bigint: true }), named = await lstat(file, { bigint: true });
    const same = (a: typeof before, b: typeof before): boolean => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key as keyof typeof a] === b[key as keyof typeof b]);
    if (BigInt(bytes.length) !== before.size || !same(before, after) || !same(after, named)) return fail(); return bytes;
  } finally { await handle.close(); }
}
export async function loadBundledCueConverter(root: string, expectedManifest: string): Promise<CueNativeBundle> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || !path.isAbsolute(root) || !/^[a-f0-9]{64}$/u.test(expectedManifest)) return fail();
  const bytes = await whole(path.join(root, 'manifest.json'), 64 * 1024); if (sha(bytes) !== expectedManifest) return fail();
  const manifest = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
  if (manifest.schemaVersion !== 1 || manifest.purpose !== 'cue-independent-eight-format-output' || manifest.platform !== 'darwin' || manifest.arch !== 'arm64'
    || JSON.stringify(manifest.sources) !== JSON.stringify(CUE_NATIVE_SOURCE_INPUTS) || JSON.stringify(manifest.configure) !== JSON.stringify(CUE_FFMPEG_CONFIGURE)
    || manifest.configureSha256 !== sha(Buffer.from(JSON.stringify(CUE_FFMPEG_CONFIGURE))) || JSON.stringify(manifest.components) !== JSON.stringify(CUE_FFMPEG_LIBRARIES)
    || JSON.stringify(manifest.protocols) !== '["fd"]') return fail();
  const names = new Set(['bin/ffmpeg', 'bin/ffprobe', ...CUE_FFMPEG_LIBRARIES.map(item => 'lib/' + item.id)]);
  const files = manifest.files as CueNativeFilePin[];
  if (!Array.isArray(files) || files.length !== names.size || new Set(files.map(pin => pin.relative)).size !== files.length) return fail();
  const system = new Set(['/usr/lib/libSystem.B.dylib', '/usr/lib/libc++.1.dylib', '/usr/lib/libm.1.dylib',
    '/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation',
    '/System/Library/Frameworks/CoreMedia.framework/Versions/A/CoreMedia', '/System/Library/Frameworks/CoreVideo.framework/Versions/A/CoreVideo']);
  for (const pin of files) {
    if (!names.has(pin.relative) || !positive(pin.bytes) || !/^[a-f0-9]{64}$/u.test(pin.sha256) || !Array.isArray(pin.dependencies)
      || pin.dependencies.some(value => !system.has(value) && !CUE_FFMPEG_LIBRARIES.some(library => value === '@rpath/' + library.id))) return fail();
    const actual = await whole(path.join(root, pin.relative)); if (actual.length !== pin.bytes || sha(actual) !== pin.sha256) return fail();
  }
  for (const source of CUE_NATIVE_SOURCE_INPUTS) {
    const actual = await whole(path.join(root, 'legal', source.id, source.archive), 32 * 1024 * 1024);
    if (actual.length !== source.bytes || sha(actual) !== source.sha256) return fail();
    for (const name of source.legal) await whole(path.join(root, 'legal', source.id, name), 1024 * 1024);
  }
  await whole(path.join(root, 'legal/NOTICE.txt'), 1024 * 1024);
  const bundle: CueNativeBundle = { root, manifestSha256: expectedManifest, files: Object.freeze(structuredClone(files)) };
  admitted.add(bundle); return Object.freeze(bundle);
}
const formats = { flac: ['flac', 'flac'], alac: ['alac', 'ipod'], mp3: ['libmp3lame', 'mp3'], vorbis: ['libvorbis', 'ogg'],
  opus: ['libopus', 'ogg'], wavpack: ['wavpack', 'wv'], 'pcm-wav': ['', 'wav'], 'pcm-aiff': ['', 'aiff'] } as const;
export function createCueNativeActor(bundle: CueNativeBundle) {
  if (!admitted.has(bundle)) return fail();
  const running = new Map<string, { promise: Promise<CueNativeRun>; controller: AbortController; pid: number | null }>(); let closing = false;
  const unverified = new Map<string, CueNativeRunError>();
  async function verify(): Promise<void> {
    if (sha(await whole(path.join(bundle.root, 'manifest.json'), 64 * 1024)) !== bundle.manifestSha256) return fail();
    for (const pin of bundle.files) if (sha(await whole(path.join(bundle.root, pin.relative))) !== pin.sha256) return fail();
  }
  async function processRun(program: 'ffmpeg' | 'ffprobe', args: readonly string[], descriptors: readonly number[], claim: CueNativeClaim, signal: AbortSignal): Promise<CueNativeRun> {
    if (closing || signal.aborted) return fail('CUE处理已停止。'); await claim.assertCurrent(); await verify();
    if (closing || signal.aborted) return fail('CUE处理已停止。');
    const child = spawn(path.join(bundle.root, 'bin', program), [...args], { shell: false, detached: true,
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe', ...descriptors] });
    const originalRun = running.get(claim.commandId); if (originalRun) originalRun.pid = child.pid ?? null;
    const parts: Buffer[][] = [[], []]; let size = 0, failure: string | null = null;
    const kill = (): void => { if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= 'CUE进程组关闭失败'; } };
    const cancel = (): void => { failure ??= 'CUE处理已取消'; kill(); };
    const timer = setTimeout(() => { failure ??= 'CUE单进程30秒期限已到'; kill(); }, 30_000);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    for (const [i, stream] of [child.stdout, child.stderr].entries()) stream?.on('data', (bytes: Buffer) => {
      size += bytes.length; if (size > 16 * 1024 * 1024) { failure ??= 'CUE原始回显超过16MiB'; kill(); } else parts[i]!.push(bytes);
    });
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once('error', () => { failure ??= 'CUE后端无法启动'; }); child.once('close', (code, stop) => resolve({ code, signal: stop }));
    });
    clearTimeout(timer); signal.removeEventListener('abort', cancel);
    let processGroupClosed = !child.pid;
    if (child.pid) try { process.kill(-child.pid, 0); failure ??= 'CUE进程组仍未结束'; kill(); } catch (error) {
      processGroupClosed = (error as NodeJS.ErrnoException).code === 'ESRCH'; if (!processGroupClosed) failure ??= 'CUE进程组状态未知';
    }
    if (failure || result.code !== 0 || result.signal || !child.pid) throw new CueNativeRunError({ exitCode: result.code, signal: result.signal,
      stdout: Buffer.concat(parts[0]!), stderr: Buffer.concat(parts[1]!), pid: child.pid ?? null, pidClosed: processGroupClosed });
    await claim.assertCurrent(); await verify();
    return { exitCode: 0, signal: null, stdout: Buffer.concat(parts[0]!), stderr: Buffer.concat(parts[1]!), pid: child.pid, pidClosed: true };
  }
  function run(program: 'ffmpeg' | 'ffprobe', args: readonly string[], descriptors: readonly number[], claim: CueNativeClaim, signal?: AbortSignal): Promise<CueNativeRun> {
    if (unverified.size) throw unverified.values().next().value;
    if (running.has(claim.commandId)) return fail('原CUE命令仍在处理，不能重复启动。');
    const controller = new AbortController(), combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const promise = processRun(program, args, descriptors, claim, combined); running.set(claim.commandId, { promise, controller, pid: null });
    void promise.catch(error => { if (error instanceof CueNativeRunError && !error.raw.pidClosed) unverified.set(claim.commandId,error); })
      .finally(() => { if (running.get(claim.commandId)?.promise === promise) running.delete(claim.commandId); }).catch(() => {}); return promise;
  }
  async function distinct(source: FileHandle, target: FileHandle): Promise<void> {
    const a = await source.stat({ bigint: true }), b = await target.stat({ bigint: true });
    if (!a.isFile() || !b.isFile() || b.nlink !== 1n || b.size !== 0n || a.dev === b.dev && a.ino === b.ino) return fail('CUE输出必须为独占的新文件。');
  }
  return {
    async encode(input: CueEncodeInput, signal?: AbortSignal): Promise<CueNativeRun> {
      if (!Object.hasOwn(formats, input.format) || !CUE_INPUT_DEMUXERS.includes(input.demuxer)
        || !Number.isSafeInteger(input.startFrame) || input.startFrame < 0 || !positive(input.frameCount) || !Number.isSafeInteger(input.startFrame + input.frameCount)
        || !positive(input.sampleRate) || input.sampleRate > 768000 || ![1, 2].includes(input.channels)) return fail('CUE分段或格式无效。');
      await input.sourceClaim.assertCurrent(); await input.targetClaim.assertCurrent(); await distinct(input.source, input.target);
      const [base, mux] = formats[input.format], profile = input.profile ?? 's24';
      if (!['s16', 's24', 's32', 'f32'].includes(profile) || input.format === 'opus' && input.sampleRate !== 48000) return fail('CUE精度或采样率不受支持。');
      const codec = base || 'pcm_' + profile + (input.format === 'pcm-aiff' ? 'be' : 'le');
      const precision = input.format === 'flac' ? ['-sample_fmt', 's32', '-bits_per_raw_sample', '24']
        : input.format === 'alac' || input.format === 'wavpack' ? ['-sample_fmt', 's32p', '-bits_per_raw_sample', '24']
        : input.format === 'mp3' ? ['-q:a', '2', '-write_xing', '1'] : input.format === 'vorbis' ? ['-q:a', '6']
        : input.format === 'opus' ? ['-b:a', '128k', '-application', 'audio'] : [];
      const args = ['-hide_banner', '-nostdin', '-v', 'error', '-n', '-xerror', '-err_detect', 'explode', '-threads', '1', '-filter_threads', '1',
        '-protocol_whitelist', 'fd', '-f', input.demuxer, '-fd', '3', '-i', 'fd:', '-map', '0:a:0', '-map_metadata', '-1', '-map_chapters', '-1',
        '-af', 'atrim=start_sample=' + input.startFrame + ':end_sample=' + (input.startFrame + input.frameCount) + ',asetpts=PTS-STARTPTS',
        '-ar', String(input.sampleRate), '-ac', String(input.channels), '-c:a', codec, ...precision, '-threads', '1', '-f', mux,
        // 短片段也要输出独立首音频页，供Ogg解码器正确处理起始时延与末尾granule。
        ...(mux === 'ogg' ? ['-page_duration', '20000'] : []), '-fd', '4', 'fd:'];
      const claim: CueNativeClaim = { ...input.targetClaim, async assertCurrent() { await input.sourceClaim.assertCurrent(); await input.targetClaim.assertCurrent(); } };
      const result = await run('ffmpeg', args, [input.source.fd, input.target.fd], claim, signal); await input.target.sync(); return result;
    },
    async decode(source: FileHandle, target: FileHandle, demuxer: CueInputDemuxer, claim: CueNativeClaim, signal?: AbortSignal): Promise<CueNativeRun> {
      if (!CUE_INPUT_DEMUXERS.includes(demuxer)) return fail(); await distinct(source, target);
      const result = await run('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-n', '-xerror', '-err_detect', 'explode', '-threads', '1',
        '-protocol_whitelist', 'fd', '-f', demuxer, '-fd', '3', '-i', 'fd:', '-map', '0:a:0', '-c:a', 'pcm_s32le', '-threads', '1', '-f', 's32le', '-fd', '4', 'fd:'], [source.fd, target.fd], claim, signal);
      await target.sync(); return result;
    },
    async probe(source: FileHandle, demuxer: CueInputDemuxer, claim: CueNativeClaim, signal?: AbortSignal) {
      if (!CUE_INPUT_DEMUXERS.includes(demuxer)) return fail();
      const result = await run('ffprobe', ['-v', 'error', '-err_detect', 'explode', '-protocol_whitelist', 'fd', '-f', demuxer, '-fd', '3', '-select_streams', 'a:0',
        '-show_streams', '-show_frames', '-show_entries', 'stream=codec_name,sample_rate,channels,sample_fmt,bits_per_raw_sample,bits_per_sample:frame=nb_samples', '-of', 'compact=p=1:nk=0', 'fd:'], [source.fd], claim, signal);
      let frames = 0, sampleRate = 0, channels = 0, codec = '', sampleFormat = '', bitsPerSample = 0, streams = 0;
      for (const line of Buffer.from(result.stdout).toString('utf8').split('\n').filter(Boolean)) {
        const [kind, ...parts] = line.split('|'), values = Object.fromEntries(parts.map(part => { const at = part.indexOf('='); if (at < 1) return fail(); return [part.slice(0, at), part.slice(at + 1)]; }));
        if (kind === 'frame') { const count = Number(values.nb_samples); if (!positive(count) || !Number.isSafeInteger(frames + count)) return fail(); frames += count; }
        else if (kind === 'stream') { streams++; sampleRate = Number(values.sample_rate); channels = Number(values.channels); codec = values.codec_name ?? ''; sampleFormat = values.sample_fmt ?? '';
          bitsPerSample = Number(values.bits_per_raw_sample) || Number(values.bits_per_sample) || (sampleFormat.startsWith('s16') ? 16 : sampleFormat.startsWith('s32') || sampleFormat.startsWith('flt') ? 32 : sampleFormat.startsWith('dbl') ? 64 : 0); }
        else return fail('CUE音频帧回显无效。');
      }
      if (streams !== 1 || !positive(frames) || !positive(sampleRate) || ![1, 2].includes(channels) || !codec
        || !['u8','u8p','s16','s16p','s32','s32p','flt','fltp','dbl','dblp'].includes(sampleFormat) || !Number.isSafeInteger(bitsPerSample) || bitsPerSample < 0 || bitsPerSample > 64) return fail('CUE未取得完整实际PCM帧。');
      return { ...result, frames, sampleRate, channels, codec, sampleFormat, bitsPerSample, eof: true as const };
    },
    async join(commandId: string) { const current = running.get(commandId); if (current) await current.promise.catch(() => {}); if(unverified.has(commandId))throw unverified.get(commandId); },
    async close() { closing = true; for (const current of running.values()) current.controller.abort(); await Promise.allSettled([...running.values()].map(current => current.promise)); if(unverified.size)throw unverified.values().next().value; },
    inspect: () => ({ closing, running: running.size, unverified: unverified.size, pids: [...running.values()].flatMap(value => value.pid === null ? [] : [value.pid]) }),
  };
}
export type CueNativeActor = ReturnType<typeof createCueNativeActor>;
