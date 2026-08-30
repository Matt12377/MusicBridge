import type { FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAudioConversionSource, isAudioConversionPlan, isAudioConversionReceipt, isAudioConverterIdentity, type AudioConversionSource, type AudioConversionPlan, type AudioConversionReceipt, type AudioConverterIdentity, type ExecutionFormat } from '@music-bridge/contracts';
import { mediaFingerprint } from './media-store.js';
import { withVerifiedReadonlySource, SourceFileError, type RootCapability } from './source-files.js';
import { inspectConversionOutput } from './execution-wave.js';
import { ExecutionCompileError } from './execution-plan.js';
import { AudioConversionError, conversionFail, runConverterProcess, verifyConverterFile, type ConverterFilePin } from './conversion-process.js';
export { AudioConversionError } from './conversion-process.js';

/** 私有、预先核定的构建清单；不是从用户可选路径自动信任一个转换器。 */
export interface PinnedFfmpegBuild {
  ffmpeg: ConverterFilePin & { versionSha256: string };
  ffprobe: ConverterFilePin & { versionSha256: string };
  dependencies: readonly (ConverterFilePin & { id: string })[];
  version: '8.1.2';
  components: AudioConverterIdentity['components'];
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const label = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,79}$/u.test(value);

function inputFormat(source: AudioConversionSource): { demuxer: string; codec: string; sampleFormat: AudioConversionReceipt['decoded']['sampleFormat'] } {
  const t = source.technical, bits = t.bitsPerSample;
  if (t.container === 'FLAC' && t.codec === 'FLAC' && [16,24,32].includes(bits ?? 0)) return { demuxer: 'flac', codec: 'flac', sampleFormat: bits === 16 ? 's16' : 's32' };
  if ((t.container === 'WAVE' || t.container === 'AIFF') && t.codec === 'PCM' && [16,24,32].includes(bits ?? 0)) return { demuxer: t.container === 'WAVE' ? 'wav' : 'aiff', codec: `pcm_s${bits}${t.container === 'WAVE' ? 'le' : 'be'}`, sampleFormat: bits === 16 ? 's16' : 's32' };
  if (t.container === 'WAVE' && t.codec === 'IEEE_FLOAT' && (bits === 32 || bits === 64)) return { demuxer: 'wav', codec: `pcm_f${bits}le`, sampleFormat: bits === 32 ? 'flt' : 'dbl' };
  return conversionFail('UNSUPPORTED_CONVERSION');
}
function argumentsFor(plan: AudioConversionPlan): { parameters: AudioConversionPlan['processing']['parameters']; filter?: string; codec: string; demuxer: string } {
  const f = plan.format, input = inputFormat(plan.input), bits = Number(f.outputSampleFormat.slice(5,7));
  if (f.resamplerImplementation !== 'none' && (f.resamplerImplementation !== 'ffmpeg-swr' || f.resamplerVersion !== '6.3.102')) return conversionFail('UNSUPPORTED_CONVERSION');
  const parameters: { name: string; value: string | number | boolean }[] = [
    { name: 'demuxer', value: input.demuxer }, { name: 'decoder-error-policy', value: 'explode' },
    { name: 'threads', value: 1 }, { name: 'bitexact', value: true }, { name: 'metadata', value: 'removed' },
    { name: 'precision', value: f.internalProcessingPrecision }, { name: 'mapping', value: f.channelMapping },
  ];
  const codec = f.outputSampleFormat.replace('pcm-', 'pcm_');
  if (f.internalProcessingPrecision === 'integer-bit-copy') return { parameters, codec, demuxer: input.demuxer };
  const internal = f.internalProcessingPrecision === 'float64' ? 'dblp' : 'fltp';
  const output = f.outputSampleFormat === 'pcm-f32le' ? 'flt' : bits === 16 ? 's16' : 's32';
  const dither = f.ditherPolicy === 'tpdf' ? 'triangular' : '0';
  const options = { resampler: 'swr', tsf: internal, osf: output, filter_size: 32, phase_shift: 10, linear_interp: 1, exact_rational: 1, filter_type: 'kaiser', kaiser_beta: 9, cutoff: 0.97, async: 0, dither_method: dither, output_sample_bits: bits };
  for (const [name, value] of Object.entries(options)) parameters.push({ name, value });
  const pan = f.channelMapping === 'mono-to-stereo' ? 'pan=stereo|c0=c0|c1=c0,' : f.channelMapping === 'stereo-to-mono' ? 'pan=mono|c0=0.5*c0+0.5*c1,' : '';
  const filter = pan + `aresample=${f.sampleRate}:` + Object.entries(options).map(([key,value]) => `${key}=${value}`).join(':');
  return { parameters, codec, demuxer: input.demuxer, filter };
}

export function createFfmpegConverter(configuration: PinnedFfmpegBuild, options: { operationTimeoutMs?: number } = {}) {
  const build = structuredClone(configuration), timeout = options.operationTimeoutMs ?? 15 * 60_000;
  if (build.version !== '8.1.2' || !hash(build.ffmpeg?.sha256) || !hash(build.ffprobe?.sha256) || !hash(build.ffmpeg?.versionSha256) || !hash(build.ffprobe?.versionSha256)
    || !Array.isArray(build.dependencies) || build.dependencies.length > 64 || build.dependencies.some(p => !label(p.id) || !hash(p.sha256))
    || new Set(build.dependencies.map(p => p.id)).size !== build.dependencies.length || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 15 * 60_000) return conversionFail('INVALID_INPUT');
  const identity: AudioConverterIdentity = { id: 'ffmpeg', version: build.version, binarySha256: build.ffmpeg.sha256,
    buildSha256: mediaFingerprint({ ffmpegVersion: build.ffmpeg.versionSha256, ffprobe: build.ffprobe.sha256, ffprobeVersion: build.ffprobe.versionSha256, dependencies: build.dependencies.map(p => ({ id: p.id, sha256: p.sha256 })).sort((a,b) => a.id.localeCompare(b.id)), components: build.components }), components: build.components };
  if (!isAudioConverterIdentity(identity) || !identity.components.some(c => c.name === 'libswresample' && c.version === '6.3.102')) return conversionFail('INVALID_INPUT');
  function plan(source: unknown, format: ExecutionFormat): AudioConversionPlan {
    if (!isAudioConversionSource(source)) return conversionFail('INVALID_INPUT');
    const value: AudioConversionPlan = { schemaVersion: 1, input: structuredClone(source), format: structuredClone(format), converter: structuredClone(identity), processing: { sourceExtent: 'whole-input', inputStreamIndex: 0, gain: 'unchanged', timestampCompensation: 'disabled', parameters: [] }, formalReady: false };
    if (!isAudioConversionPlan(value)) return conversionFail('INVALID_INPUT');
    value.processing.parameters = argumentsFor(value).parameters;
    return value;
  }
  async function verifyBuild(check: () => void, versions: boolean): Promise<void> {
    for (const pin of [build.ffmpeg, build.ffprobe, ...build.dependencies]) await verifyConverterFile(pin, check);
    if (versions) for (const [name, pin] of [['ffmpeg', build.ffmpeg], ['ffprobe', build.ffprobe]] as const) {
      const version = await runConverterProcess(pin.path, ['-version'], [], check, 'BACKEND_CHANGED');
      if (digest(version) !== pin.versionSha256 || !version.startsWith(`${name} version ${build.version}`)) return conversionFail('BACKEND_CHANGED');
      for (const component of build.components) {
        const actual = version.split('\n').map(line => /^(lib[a-z0-9]+)\s+(\d+)\.\s*(\d+)\.\s*(\d+)/u.exec(line)).find(m => m?.[1] === component.name);
        if (!actual || `${actual[2]}.${actual[3]}.${actual[4]}` !== component.version) return conversionFail('BACKEND_CHANGED');
      }
    }
  }
  return {
    get identity() { return structuredClone(identity); },
    plan,
    async convert(request: AudioConversionPlan, location: { root: RootCapability; relative: string }, destination: FileHandle, signal: AbortSignal, checkOperation: () => void = () => undefined): Promise<AudioConversionReceipt> {
      const wall = Date.now() + timeout, monotonic = performance.now() + timeout;
      let interrupted: unknown;
      const check = (): void => {
        if (interrupted) throw interrupted;
        try {
          checkOperation();
          if (signal.aborted) return conversionFail('CANCELLED');
          if (!location.root.authorized) return conversionFail('SOURCE_UNAVAILABLE');
          if (Date.now() > wall || performance.now() > monotonic) return conversionFail('LIMIT_EXCEEDED');
        } catch (error) { interrupted = error; throw error; }
      };
      try {
        check();
        if (!isAudioConversionPlan(request) || mediaFingerprint(request) !== mediaFingerprint(plan(request.input, request.format))) return conversionFail('INVALID_INPUT');
        const snapshot = structuredClone(request), processing = argumentsFor(snapshot), target = await destination.stat({ bigint: true });
        if (!target.isFile() || target.size !== 0n || target.nlink !== 1n) return conversionFail('INVALID_INPUT');
        const frames = (BigInt(snapshot.input.technical.sampleFrames) * BigInt(snapshot.format.sampleRate) + BigInt(snapshot.input.technical.sampleRate) - 1n) / BigInt(snapshot.input.technical.sampleRate) + 1n;
        const maximumBytes = frames * BigInt(snapshot.format.channelCount) * BigInt(Number(snapshot.format.outputSampleFormat.slice(5,7))) / 8n + 4096n;
        if (maximumBytes > 0xffffffffn) return conversionFail('LIMIT_EXCEEDED');
        await verifyBuild(check, true);
        const decoded = await withVerifiedReadonlySource(location.root, location.relative, snapshot.input, signal, async (source, sourceCheck) => {
          const checked = (): void => { check(); sourceCheck(); };
          const stat = await source.stat({ bigint: true }); if (stat.dev === target.dev && stat.ino === target.ino) return conversionFail('INVALID_INPUT');
          return decode(source, snapshot.input, processing.demuxer, build.ffprobe.path, checked);
        }, check);
        const { receipt, beforeReadback } = await withVerifiedReadonlySource(location.root, location.relative, snapshot.input, signal, async (source, sourceCheck) => {
          const checked = (): void => { check(); sourceCheck(); };
          const now = await destination.stat({ bigint: true }); if (now.dev !== target.dev || now.ino !== target.ino || now.size !== 0n || now.nlink !== 1n) return conversionFail('INPUT_CHANGED');
          const args = ['-hide_banner','-nostdin','-v','error','-n','-xerror','-err_detect','explode','-threads','1','-filter_threads','1','-protocol_whitelist','fd','-f',processing.demuxer,'-fd','3','-i','fd:','-map','0:a:0','-map_metadata','-1','-map_chapters','-1',...(processing.filter ? ['-af',processing.filter] : []),'-c:a',processing.codec,'-flags:a','+bitexact','-fflags','+bitexact','-threads','1','-fs',String(maximumBytes),'-f','wav','-fd','4','fd:'];
          await runConverterProcess(build.ffmpeg.path, args, [source.fd, destination.fd], checked, 'CONVERSION_FAILED');
          checked(); await destination.sync();
          const beforeReadback = await destination.stat({ bigint: true });
          const audio = await inspectConversionOutput(destination, snapshot.format, signal, checked);
          const receipt: AudioConversionReceipt = { plan: snapshot, planHash: mediaFingerprint(snapshot), decoded, audio, formalReady: false };
          if (!isAudioConversionReceipt(receipt)) return conversionFail('FRAME_MISMATCH');
          await verifyBuild(checked, false); checked();
          return { receipt, beforeReadback };
        }, check);
        const after = await destination.stat({ bigint: true });
        if (after.dev !== target.dev || after.ino !== target.ino || after.size !== BigInt(receipt.audio.size) || after.nlink !== 1n || after.mtimeNs !== beforeReadback.mtimeNs || after.ctimeNs !== beforeReadback.ctimeNs) return conversionFail('INPUT_CHANGED');
        check();
        return receipt;
      } catch (error) {
        error = interrupted ?? error;
        if (error instanceof AudioConversionError) throw error;
        if (error instanceof SourceFileError) {
          if (error.code === 'CANCELLED' || error.code === 'LIMIT_EXCEEDED' || error.code === 'HASH_MISMATCH') return conversionFail(error.code);
          return conversionFail(error.code === 'CONTENT_CHANGED' ? 'INPUT_CHANGED' : 'SOURCE_UNAVAILABLE');
        }
        if (error instanceof ExecutionCompileError) {
          if (error.code === 'CANCELLED' || error.code === 'LIMIT_EXCEEDED' || error.code === 'INPUT_CHANGED' || error.code === 'IO_ERROR') return conversionFail(error.code);
          return conversionFail('INVALID_OUTPUT');
        }
        if (error instanceof Error && 'code' in error && error.code === 'ENOSPC') return conversionFail('DISK_FULL');
        return conversionFail('IO_ERROR');
      }
    },
  };
}

async function decode(handle: FileHandle, source: AudioConversionSource, demuxer: string, executable: string, check: () => void): Promise<AudioConversionReceipt['decoded']> {
  const expected = inputFormat(source); let frames = 0, stream = false;
  const args = ['-v','error','-err_detect','explode','-protocol_whitelist','fd','-f',demuxer,'-fd','3','-select_streams','a:0','-show_streams','-show_frames','-show_entries','stream=codec_name,sample_rate,channels,sample_fmt:frame=nb_samples,sample_fmt,channels','-of','compact=p=1:nk=0','fd:'];
  await runConverterProcess(executable, args, [handle.fd], check, 'DECODE_FAILED', line => {
    const [kind, ...parts] = line.split('|'), values: Record<string,string> = {};
    for (const part of parts) { const at = part.indexOf('='); if (at < 1 || Object.hasOwn(values, part.slice(0,at))) return conversionFail('DECODE_FAILED'); values[part.slice(0,at)] = part.slice(at + 1); }
    if (values.sample_fmt !== expected.sampleFormat || values.channels !== String(source.technical.channels)) return conversionFail('DECODE_FAILED');
    if (kind === 'frame') {
      const count = Number(values.nb_samples);
      if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(frames + count)) return conversionFail('DECODE_FAILED');
      frames += count; if (frames > source.technical.sampleFrames) return conversionFail('FRAME_MISMATCH');
    } else if (kind === 'stream') {
      if (stream || values.codec_name !== expected.codec || values.sample_rate !== String(source.technical.sampleRate)) return conversionFail('DECODE_FAILED');
      stream = true;
    } else return conversionFail('DECODE_FAILED');
  });
  if (!stream || frames !== source.technical.sampleFrames) return conversionFail('FRAME_MISMATCH');
  return { codec: expected.codec, sampleRate: source.technical.sampleRate, channelCount: source.technical.channels as 1 | 2, sampleFormat: expected.sampleFormat, frameCount: frames, wholeInputConsumed: true };
}
export type FfmpegConverter = ReturnType<typeof createFfmpegConverter>;
