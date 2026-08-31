import { isCollectionId } from './collection.js';
import { isExecutionFormat, type ExecutionFormat } from './execution-audio.js';
import { isAudioConversionPlan, isAudioConversionReceipt, type AudioConversionPlan, type AudioConversionReceipt } from './audio-conversion.js';

export type ConvertedExecutionSegment =
  | { kind: 'silence'; reason: 'lead-in' | 'gap' | 'tail'; frames: number }
  | { kind: 'source'; trackId: string; conversion: AudioConversionPlan }
  | { kind: 'render'; renderAssetId: string; conversion: AudioConversionPlan };
/** 预览不声称 SRC 已产生某个精确帧数，也不重写冻结的 Master/Layout。 */
export interface ConvertedExecutionRecipe {
  schemaVersion: 2; compiler: 'musicbridge-conversion-v2'; mode: 'direct' | 'prepared-derivative';
  masterVersionId: string; layoutVersionId: string; contentHash: string; plannedTimelineHash: string;
  prepared?: { id: string; renderTimelineHash: string };
  format: ExecutionFormat; side: 'A' | 'B' | 'Program'; capacityFrames: number;
  minimumFrames: number; maximumFrames: number; segments: readonly ConvertedExecutionSegment[]; formalReady: false;
}
export interface ConvertedExecutionReceipt {
  recipe: ConvertedExecutionRecipe; recipeHash: string; origin: 'compiled' | 'derived-render';
  segments: readonly { startFrame: number; endFrame: number; conversion?: AudioConversionReceipt }[];
  audio: AudioConversionReceipt['audio']; formalReady: false;
}
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(v).every(k => allowed.includes(k));
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (record(v)) return `{${Object.entries(v).sort(([a],[b]) => a.localeCompare(b)).map(([k,value]) => `${JSON.stringify(k)}:${canonical(value)}`).join(',')}}`;
  return JSON.stringify(v);
}
/** 只对已经通过合同的计划调用；与单次转换回执的一帧边界规则一致。 */
export function conversionFrameBounds(plan: AudioConversionPlan): { minimum: number; maximum: number } {
  const source = plan.input.technical;
  if (source.sampleRate === plan.format.sampleRate) return { minimum: source.sampleFrames, maximum: source.sampleFrames };
  const n = BigInt(source.sampleFrames) * BigInt(plan.format.sampleRate), d = BigInt(source.sampleRate);
  return { minimum: Math.max(1, Number((n - 1n) / d)), maximum: Number((n + d) / d) };
}
function sameOutput(plan: AudioConversionPlan, format: ExecutionFormat): boolean {
  // 混合 mono/stereo 源的映射由每条源显式记录，其余执行参数必须完全一致。
  const { channelMapping: _inputMapping, ...input } = plan.format;
  const { channelMapping: _outputMapping, ...output } = format;
  return canonical(input) === canonical(output);
}
export function isConvertedExecutionRecipe(v: unknown): v is ConvertedExecutionRecipe {
  if (!record(v) || !keys(v, ['schemaVersion','compiler','mode','masterVersionId','layoutVersionId','contentHash','plannedTimelineHash','prepared','format','side','capacityFrames','minimumFrames','maximumFrames','segments','formalReady'])
    || v.schemaVersion !== 2 || v.compiler !== 'musicbridge-conversion-v2' || (v.mode !== 'direct' && v.mode !== 'prepared-derivative')
    || !isCollectionId(v.masterVersionId) || !isCollectionId(v.layoutVersionId) || !hash(v.contentHash) || !hash(v.plannedTimelineHash)
    || !isExecutionFormat(v.format) || (v.side !== 'A' && v.side !== 'B' && v.side !== 'Program') || !integer(v.capacityFrames, 1)
    || !integer(v.minimumFrames) || !integer(v.maximumFrames, v.minimumFrames, v.capacityFrames) || !Array.isArray(v.segments) || v.segments.length > 401 || v.formalReady !== false) return false;
  if (v.mode === 'direct' ? v.prepared !== undefined : !record(v.prepared) || !keys(v.prepared, ['id','renderTimelineHash']) || !isCollectionId(v.prepared.id) || !hash(v.prepared.renderTimelineHash)) return false;
  if (v.segments.length === 0) return v.side === 'B' && v.minimumFrames === 0 && v.maximumFrames === 0;
  let minimum = 0, maximum = 0; const ids = new Set<string>();
  for (const [i,s] of v.segments.entries()) {
    if (!record(s)) return false;
    if (s.kind === 'silence') {
      if (v.mode !== 'direct' || !keys(s, ['kind','reason','frames']) || !integer(s.frames, 1)) return false;
      if (s.reason === 'lead-in' ? i !== 0 || v.segments[i + 1]?.kind !== 'source'
        : s.reason === 'tail' ? i !== v.segments.length - 1 || v.segments[i - 1]?.kind !== 'source'
        : s.reason !== 'gap' || v.segments[i - 1]?.kind !== 'source' || v.segments[i + 1]?.kind !== 'source') return false;
      minimum += s.frames; maximum += s.frames;
    } else {
      if (!isAudioConversionPlan(s.conversion) || !sameOutput(s.conversion, v.format)) return false;
      if (v.mode === 'direct') {
        if (s.kind !== 'source' || !keys(s, ['kind','trackId','conversion']) || !isCollectionId(s.trackId) || ids.has(s.trackId)) return false;
        ids.add(s.trackId);
      } else if (s.kind !== 'render' || !keys(s, ['kind','renderAssetId','conversion']) || !isCollectionId(s.renderAssetId) || v.segments.length !== 1) return false;
      const bounds = conversionFrameBounds(s.conversion); minimum += bounds.minimum; maximum += bounds.maximum;
    }
    if (!integer(maximum, 1, v.capacityFrames)) return false;
  }
  return minimum === v.minimumFrames && maximum === v.maximumFrames && (v.mode !== 'direct' || ids.size >= 1 && ids.size <= 200);
}
export function isConvertedExecutionReceipt(v: unknown): v is ConvertedExecutionReceipt {
  if (!record(v) || !keys(v, ['recipe','recipeHash','origin','segments','audio','formalReady']) || !isConvertedExecutionRecipe(v.recipe) || !v.recipe.segments.length
    || !hash(v.recipeHash) || v.origin !== (v.recipe.mode === 'direct' ? 'compiled' : 'derived-render') || !Array.isArray(v.segments)
    || v.segments.length !== v.recipe.segments.length || !record(v.audio) || v.formalReady !== false) return false;
  let cursor = 0;
  for (const [i,s] of v.segments.entries()) {
    const planned = v.recipe.segments[i]!;
    if (!record(s) || !keys(s, ['startFrame','endFrame','conversion']) || s.startFrame !== cursor || !integer(s.endFrame, cursor + 1, v.recipe.capacityFrames)) return false;
    if (planned.kind === 'silence') {
      if (s.conversion !== undefined || s.endFrame - cursor !== planned.frames) return false;
    } else if (!isAudioConversionReceipt(s.conversion) || canonical(s.conversion.plan) !== canonical(planned.conversion) || s.endFrame - cursor !== s.conversion.audio.frameCount) return false;
    cursor = s.endFrame;
  }
  const a = v.audio;
  if (!keys(a, ['sha256','pcmSha256','size','dataOffset','frameCount']) || !hash(a.sha256) || !hash(a.pcmSha256)
    || !integer(a.size, 44, 0xffffffff + 8) || !integer(a.dataOffset, 20, a.size) || a.frameCount !== cursor || cursor < v.recipe.minimumFrames || cursor > v.recipe.maximumFrames) return false;
  const bytes = BigInt(cursor) * BigInt(v.recipe.format.channelCount) * BigInt(Number(v.recipe.format.outputSampleFormat.slice(5,7))) / 8n;
  return BigInt(a.dataOffset) + bytes <= BigInt(a.size)
    && (v.origin !== 'derived-render' || canonical(a) === canonical(v.segments[0]?.conversion?.audio));
}
