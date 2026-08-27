import { isCollectionId } from './collection.js';

/** 格式是显式输入；有格式描述不代表对应转换器或输出后端已实现、已认证。 */
export interface ExecutionFormat {
  sampleRate: number; channelCount: 1 | 2; channelLayout: 'mono' | 'stereo';
  internalProcessingPrecision: 'integer-bit-copy' | 'float32' | 'float64';
  outputSampleFormat: 'pcm-s16le' | 'pcm-s24le' | 'pcm-s32le' | 'pcm-f32le';
  resamplerImplementation: string; resamplerVersion: string;
  ditherPolicy: 'none' | 'tpdf'; channelMapping: 'identity' | 'mono-to-stereo' | 'stereo-to-mono';
  outputBackend: { id: string; version: string }; outputProfileVersion: string;
}
export interface ExecutionPcmInput { sha256: string; size: number; sampleRate: number; channelCount: 1 | 2; bitsPerSample: 16 | 24 | 32; totalFrames: number }
export type ExecutionSegment =
  | { kind: 'silence'; reason: 'lead-in' | 'gap' | 'tail'; startFrame: number; endFrame: number }
  | { kind: 'source'; trackId: string; input: ExecutionPcmInput; startFrame: number; endFrame: number }
  | { kind: 'render'; renderAssetId: string; input: ExecutionPcmInput; startFrame: number; endFrame: number };
/** 配方不是已验证资产；路径及可写句柄仅存在于 Core。空 B 配方没有文件或音频段。 */
export interface ExecutionRecipe {
  schemaVersion: 1; mode: 'direct' | 'prepared-reference';
  compiler: 'musicbridge-pcm-copy-v1';
  masterVersionId: string; layoutVersionId: string; contentHash: string; plannedTimelineHash: string;
  prepared?: { id: string; renderTimelineHash: string };
  format: ExecutionFormat; side: 'A' | 'B' | 'Program'; capacityFrames: number; totalFrames: number;
  segments: readonly ExecutionSegment[]; formalReady: false;
}
/** 本地字节/帧回执不能替代归档发布、数据库提交、预检或正式后端认证。 */
export interface ExecutionAudioReceipt {
  recipe: ExecutionRecipe; recipeHash: string;
  origin: 'compiled' | 'retained-render';
  audio: { sha256: string; size: number; pcmSha256: string; dataOffset: number; frameCount: number };
  formalReady: false;
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(v).every(k => allowed.includes(k));
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const label = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,79}$/u.test(v);
const rate = (v: unknown): v is number => integer(v, 8000, 384000);
export function isExecutionFormat(v: unknown): v is ExecutionFormat {
  return record(v) && keys(v, ['sampleRate','channelCount','channelLayout','internalProcessingPrecision','outputSampleFormat','resamplerImplementation','resamplerVersion','ditherPolicy','channelMapping','outputBackend','outputProfileVersion']) && rate(v.sampleRate)
    && (v.channelCount === 1 ? v.channelLayout === 'mono' : v.channelCount === 2 && v.channelLayout === 'stereo')
    && ['integer-bit-copy','float32','float64'].includes(String(v.internalProcessingPrecision))
    && ['pcm-s16le','pcm-s24le','pcm-s32le','pcm-f32le'].includes(String(v.outputSampleFormat))
    && label(v.resamplerImplementation) && label(v.resamplerVersion)
    && (v.resamplerImplementation !== 'none' || v.resamplerVersion === 'not-applied')
    && ['none','tpdf'].includes(String(v.ditherPolicy)) && ['identity','mono-to-stereo','stereo-to-mono'].includes(String(v.channelMapping))
    && record(v.outputBackend) && keys(v.outputBackend, ['id','version']) && label(v.outputBackend.id) && label(v.outputBackend.version) && isCollectionId(v.outputProfileVersion);
}
export function isExecutionPcmInput(v: unknown): v is ExecutionPcmInput {
  return record(v) && keys(v, ['sha256','size','sampleRate','channelCount','bitsPerSample','totalFrames']) && hash(v.sha256) && integer(v.size, 44, 0xffffffff + 8) && rate(v.sampleRate) && [1,2].includes(Number(v.channelCount)) && typeof v.channelCount === 'number' && [16,24,32].includes(Number(v.bitsPerSample)) && typeof v.bitsPerSample === 'number' && integer(v.totalFrames, 1) && BigInt(v.totalFrames) * BigInt(v.channelCount) * BigInt(v.bitsPerSample) / 8n + 44n <= BigInt(v.size);
}
export function isExecutionRecipe(v: unknown): v is ExecutionRecipe {
  if (!record(v) || !keys(v, ['schemaVersion','mode','compiler','masterVersionId','layoutVersionId','contentHash','plannedTimelineHash','prepared','format','side','capacityFrames','totalFrames','segments','formalReady']) || v.schemaVersion !== 1 || v.compiler !== 'musicbridge-pcm-copy-v1' || !['direct','prepared-reference'].includes(String(v.mode)) || !isCollectionId(v.masterVersionId) || !isCollectionId(v.layoutVersionId) || !hash(v.contentHash) || !hash(v.plannedTimelineHash) || !isExecutionFormat(v.format) || !['A','B','Program'].includes(String(v.side)) || !integer(v.capacityFrames, 1) || !integer(v.totalFrames, 0, v.capacityFrames) || !Array.isArray(v.segments) || v.segments.length > 401 || v.formalReady !== false) return false;
  if (v.mode === 'prepared-reference' ? !record(v.prepared) || !keys(v.prepared, ['id','renderTimelineHash']) || !isCollectionId(v.prepared.id) || !hash(v.prepared.renderTimelineHash) : v.prepared !== undefined) return false;
  if (v.totalFrames === 0) return v.side === 'B' && v.segments.length === 0;
  const format = v.format;
  if (format.internalProcessingPrecision !== 'integer-bit-copy' || format.resamplerImplementation !== 'none' || format.resamplerVersion !== 'not-applied' || format.ditherPolicy !== 'none' || format.channelMapping !== 'identity' || format.outputSampleFormat === 'pcm-f32le') return false;
  const bits = Number(format.outputSampleFormat.slice(5,7)), trackIds = new Set<string>();
  let cursor = 0;
  for (const [i, s] of v.segments.entries()) {
    if (!record(s) || !integer(s.startFrame) || s.startFrame !== cursor || !integer(s.endFrame, s.startFrame + 1, v.totalFrames)) return false;
    if (s.kind === 'silence') {
      if (v.mode !== 'direct' || !keys(s, ['kind','reason','startFrame','endFrame']) || !['lead-in','gap','tail'].includes(String(s.reason))) return false;
      if (s.reason === 'lead-in' ? i !== 0 || v.segments[i + 1]?.kind !== 'source' : s.reason === 'tail' ? i !== v.segments.length - 1 || v.segments[i - 1]?.kind !== 'source' : v.segments[i - 1]?.kind !== 'source' || v.segments[i + 1]?.kind !== 'source') return false;
    } else {
      if (!isExecutionPcmInput(s.input) || s.input.totalFrames !== s.endFrame - s.startFrame || s.input.sampleRate !== format.sampleRate || s.input.channelCount !== format.channelCount || s.input.bitsPerSample !== bits) return false;
      if (v.mode === 'direct') {
        if (s.kind !== 'source' || !keys(s, ['kind','trackId','input','startFrame','endFrame']) || !isCollectionId(s.trackId) || trackIds.has(s.trackId)) return false;
        trackIds.add(s.trackId);
      } else if (s.kind !== 'render' || !keys(s, ['kind','renderAssetId','input','startFrame','endFrame']) || !isCollectionId(s.renderAssetId) || v.segments.length !== 1) return false;
    }
    cursor = s.endFrame;
  }
  return cursor === v.totalFrames && (v.mode !== 'direct' || trackIds.size >= 1 && trackIds.size <= 200);
}
export function isExecutionAudioReceipt(v: unknown): v is ExecutionAudioReceipt {
  if (!record(v) || !keys(v, ['recipe','recipeHash','origin','audio','formalReady']) || !isExecutionRecipe(v.recipe) || v.recipe.totalFrames === 0 || !hash(v.recipeHash) || v.origin !== (v.recipe.mode === 'direct' ? 'compiled' : 'retained-render') || !record(v.audio) || !keys(v.audio, ['sha256','size','pcmSha256','dataOffset','frameCount']) || !hash(v.audio.sha256) || !hash(v.audio.pcmSha256) || !integer(v.audio.size, 44, 0xffffffff + 8) || !integer(v.audio.dataOffset, 20, v.audio.size) || v.audio.frameCount !== v.recipe.totalFrames || v.formalReady !== false) return false;
  const bytes = BigInt(v.recipe.totalFrames) * BigInt(v.recipe.format.channelCount) * BigInt(Number(v.recipe.format.outputSampleFormat.slice(5,7))) / 8n;
  return BigInt(v.audio.dataOffset) + bytes <= BigInt(v.audio.size) && (v.origin !== 'compiled' || v.audio.dataOffset === 44 && BigInt(v.audio.size) === 44n + bytes + bytes % 2n) && (v.origin !== 'retained-render' || v.recipe.segments[0]?.kind === 'render' && v.recipe.segments[0].input.sha256 === v.audio.sha256 && v.recipe.segments[0].input.size === v.audio.size);
}
