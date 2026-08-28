import { isExecutionFormat, type ExecutionFormat } from './execution-audio.js';
import { isSourceTechnical, type SourceTechnical } from './source-evidence.js';

/** 构建身份不是认证结论；可执行路径只留在 Core。 */
export interface AudioConverterIdentity {
  id: string;
  version: string;
  binarySha256: string;
  buildSha256: string;
  components: readonly { name: string; version: string }[];
}
export interface AudioConversionSource {
  sha256: string;
  size: number;
  technical: SourceTechnical & { sampleFrames: number; frameEvidence: 'container-declared' };
}
/** 参数是适配器生成的公开谱系，不是可以直接执行的命令。 */
export interface AudioConversionPlan {
  schemaVersion: 1;
  input: AudioConversionSource;
  format: ExecutionFormat;
  converter: AudioConverterIdentity;
  processing: {
    sourceExtent: 'whole-input';
    inputStreamIndex: 0;
    gain: 'unchanged';
    timestampCompensation: 'disabled';
    parameters: readonly { name: string; value: string | number | boolean }[];
  };
  formalReady: false;
}
export interface AudioConversionReceipt {
  plan: AudioConversionPlan;
  planHash: string;
  decoded: {
    codec: string;
    sampleRate: number;
    channelCount: 1 | 2;
    sampleFormat: 'u8' | 's16' | 's32' | 'flt' | 'dbl';
    frameCount: number;
    wholeInputConsumed: true;
  };
  audio: { sha256: string; pcmSha256: string; size: number; dataOffset: number; frameCount: number };
  formalReady: false;
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: readonly string[]): boolean => Object.keys(v).every(k => names.includes(k));
const integer = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const label = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,79}$/u.test(v);
const one = (v: unknown, options: readonly string[]): boolean => typeof v === 'string' && options.includes(v);

export function isAudioConverterIdentity(v: unknown): v is AudioConverterIdentity {
  return record(v) && keys(v, ['id','version','binarySha256','buildSha256','components'])
    && label(v.id) && label(v.version) && hash(v.binarySha256) && hash(v.buildSha256)
    && Array.isArray(v.components) && v.components.length >= 1 && v.components.length <= 16
    && v.components.every(c => record(c) && keys(c, ['name','version']) && label(c.name) && label(c.version))
    && new Set(v.components.map(c => c.name)).size === v.components.length;
}
export function isAudioConversionSource(v: unknown): v is AudioConversionSource {
  return record(v) && keys(v, ['sha256','size','technical']) && hash(v.sha256)
    && integer(v.size, 1, 68_719_476_736) && isSourceTechnical(v.technical) && v.technical.lossless
    && integer(v.technical.sampleFrames, 1) && v.technical.frameEvidence === 'container-declared'
    && (v.technical.channels === 1 || v.technical.channels === 2);
}
export function isAudioConversionPlan(v: unknown): v is AudioConversionPlan {
  if (!record(v) || !keys(v, ['schemaVersion','input','format','converter','processing','formalReady'])
    || v.schemaVersion !== 1 || v.formalReady !== false || !isAudioConversionSource(v.input)
    || !isExecutionFormat(v.format) || !isAudioConverterIdentity(v.converter) || !record(v.processing)) return false;
  const p = v.processing, source = v.input.technical, f = v.format;
  if (!keys(p, ['sourceExtent','inputStreamIndex','gain','timestampCompensation','parameters'])
    || p.sourceExtent !== 'whole-input' || p.inputStreamIndex !== 0 || p.gain !== 'unchanged'
    || p.timestampCompensation !== 'disabled' || !Array.isArray(p.parameters) || p.parameters.length > 32
    || !p.parameters.every(x => record(x) && keys(x, ['name','value']) && label(x.name)
      && (label(x.value) || typeof x.value === 'boolean' || typeof x.value === 'number' && Number.isFinite(x.value) && Math.abs(x.value) <= 1_000_000_000))
    || new Set(p.parameters.map(x => x.name)).size !== p.parameters.length) return false;
  if (f.channelMapping !== (source.channels === f.channelCount ? 'identity' : source.channels === 1 ? 'mono-to-stereo' : 'stereo-to-mono')) return false;
  if (source.sampleRate !== f.sampleRate && f.resamplerImplementation === 'none') return false;
  if (f.outputSampleFormat === 'pcm-f32le' && f.ditherPolicy !== 'none') return false;
  if (f.internalProcessingPrecision === 'integer-bit-copy') {
    return ['PCM','FLAC'].includes(source.codec) && source.sampleRate === f.sampleRate && source.channels === f.channelCount
      && source.bitsPerSample === Number(f.outputSampleFormat.slice(5,7))
      && f.outputSampleFormat !== 'pcm-f32le' && f.resamplerImplementation === 'none' && f.ditherPolicy === 'none';
  }
  return true;
}

/** 不同采样率允许最多一个输出帧的整数边界差；同率解码必须完整保留帧数。 */
function durationConsistent(inputFrames: number, inputRate: number, outputFrames: number, outputRate: number): boolean {
  if (inputRate === outputRate) return inputFrames === outputFrames;
  const difference = BigInt(inputFrames) * BigInt(outputRate) - BigInt(outputFrames) * BigInt(inputRate);
  return (difference < 0n ? -difference : difference) <= BigInt(inputRate);
}
export function isAudioConversionReceipt(v: unknown): v is AudioConversionReceipt {
  if (!record(v) || !keys(v, ['plan','planHash','decoded','audio','formalReady']) || v.formalReady !== false
    || !isAudioConversionPlan(v.plan) || !hash(v.planHash) || !record(v.decoded) || !record(v.audio)) return false;
  const d = v.decoded, a = v.audio, source = v.plan.input.technical, format = v.plan.format;
  if (!keys(d, ['codec','sampleRate','channelCount','sampleFormat','frameCount','wholeInputConsumed'])
    || !label(d.codec) || !integer(d.sampleRate, 1, 50_000_000) || d.channelCount !== source.channels
    || !one(d.sampleFormat, ['u8','s16','s32','flt','dbl']) || !integer(d.frameCount, 1)
    || d.wholeInputConsumed !== true || d.sampleRate !== source.sampleRate || d.frameCount !== source.sampleFrames) return false;
  if (!keys(a, ['sha256','pcmSha256','size','dataOffset','frameCount']) || !hash(a.sha256) || !hash(a.pcmSha256)
    || !integer(a.size, 44, 0xffffffff + 8) || !integer(a.dataOffset, 20, a.size) || !integer(a.frameCount, 1)
    || !durationConsistent(d.frameCount, d.sampleRate, a.frameCount, format.sampleRate)) return false;
  const bytes = BigInt(a.frameCount) * BigInt(format.channelCount) * BigInt(Number(format.outputSampleFormat.slice(5,7))) / 8n;
  return BigInt(a.dataOffset) + bytes <= BigInt(a.size);
}
