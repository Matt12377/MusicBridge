import type { FileAudioParameters } from './audio-quality.js';
import type { SourceTechnical } from './source-evidence.js';

/** 移动 HTTP 域的独立传输边界，不代表服务、设备或声音验收。 */
export const MOBILE_JSON_REQUEST_MAX_BYTES = 262_144;
export const MOBILE_API_RESPONSE_MAX_BYTES = 2_097_152;
export const MOBILE_RETRY_HINT_MAX_MS = 86_400_000;
export interface MobileCodecLimits { requestBytes: number; responseBytes: number; depth: number; nodes: number; extensionBytes: number }
export const MOBILE_CODEC_LIMITS: Readonly<MobileCodecLimits> = Object.freeze({ requestBytes: MOBILE_JSON_REQUEST_MAX_BYTES, responseBytes: MOBILE_API_RESPONSE_MAX_BYTES, depth: 64, nodes: 2_097_152, extensionBytes: 2_097_152 });
export type MobileId = string;
export type MobileRevision = string;
export type MobileSource = 'local' | 'netease';
export type MobileJsonValue = null | boolean | number | string | MobileJsonValue[] | { [key: string]: MobileJsonValue };
export type MobileRecord = { [key: string]: MobileJsonValue };
export interface MobileCodecIssue { code: 'INVALID_REQUEST' | 'INVALID_RESPONSE' | 'LIMIT_EXCEEDED' | 'CONTEXT_MISMATCH' | 'SOURCE_CHANGED' | 'REVISION_CONFLICT'; field: string }
export type MobileDecodeResult<T> = { ok: true; value: T } | { ok: false; issue: MobileCodecIssue };
export const mobileOk = <T>(value: T): MobileDecodeResult<T> => ({ ok: true, value });
export const mobileFailure = (code: MobileCodecIssue['code'], field: string): MobileDecodeResult<never> => ({ ok: false, issue: { code, field } });
export const mobileUtf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;
function wellFormed(value:string):boolean {
  for (let i=0;i<value.length;i++) { const code = value.charCodeAt(i); if (code >= 0xd800 && code <= 0xdbff) { const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; } else if (code >= 0xdc00 && code <= 0xdfff) return false; }
  return true;
}
export const mobileRecord = (value: unknown): value is MobileRecord => value !== null && typeof value === 'object' && !Array.isArray(value);
export const isMobileId = (value: unknown): value is MobileId => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/u.test(value);
export const isMobileRevision = isMobileId;
export const isMobileSource = (value: unknown): value is MobileSource => value === 'local' || value === 'netease';
export const mobileInteger = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
export function mobileDateTime(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const day = value.slice(0,10); return mobileDate(day);
}
export function mobileDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`); return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === value;
}
function validLimits(limits: MobileCodecLimits): boolean {
  return [limits.requestBytes, limits.responseBytes, limits.depth, limits.nodes, limits.extensionBytes].every(n => mobileInteger(n,1)) && limits.requestBytes <= MOBILE_JSON_REQUEST_MAX_BYTES && limits.responseBytes <= MOBILE_API_RESPONSE_MAX_BYTES && limits.depth <= MOBILE_CODEC_LIMITS.depth && limits.nodes <= MOBILE_CODEC_LIMITS.nodes && limits.extensionBytes <= MOBILE_CODEC_LIMITS.extensionBytes;
}

/** 按数据描述符捕获，拒绝 getter、洞、循环和隐式 toJSON；不执行调用者代码。 */
export function mobileDataSnapshot(raw: unknown, limits: MobileCodecLimits = MOBILE_CODEC_LIMITS, direction: 'request' | 'response' = 'response'): MobileDecodeResult<MobileJsonValue> {
  if (!validLimits(limits)) return mobileFailure('LIMIT_EXCEEDED','limits');
  const cap = direction === 'request' ? limits.requestBytes : limits.responseBytes;
  let nodes = 0; const active = new Set<object>();
  const walk = (v: unknown, depth: number): MobileJsonValue => {
    if (++nodes > limits.nodes || depth > limits.depth) throw 'limit';
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'string') { if (!wellFormed(v)) throw 'data'; if (mobileUtf8Bytes(v) > cap) throw 'limit'; return v; }
    if (typeof v === 'number') { if (!Number.isFinite(v) || (Number.isInteger(v) && !Number.isSafeInteger(v))) throw 'data'; return v; }
    if (typeof v !== 'object' || active.has(v)) throw 'data';
    const array = Array.isArray(v), proto = Object.getPrototypeOf(v);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw 'data';
    active.add(v);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(v), keys = Reflect.ownKeys(descriptors);
      if (keys.some(key => typeof key !== 'string')) throw 'data';
      if (array) {
        const length = descriptors.length?.value as unknown;
        if (!mobileInteger(length) || length > limits.nodes || keys.length !== length + 1) throw 'data';
        const out: MobileJsonValue[] = [];
        for (let i = 0; i < length; i++) { const d = descriptors[String(i)]; if (!d || !d.enumerable || !Object.hasOwn(d,'value')) throw 'data'; out.push(walk(d.value,depth+1)); }
        return out;
      }
      const out = Object.create(null) as MobileRecord;
      for (const key of keys as string[]) { const d = descriptors[key]; if (!wellFormed(key) || !d || !d.enumerable || !Object.hasOwn(d,'value')) throw 'data'; out[key] = walk(d.value,depth+1); }
      return out;
    } finally { active.delete(v); }
  };
  try { const value = walk(raw,0); if (mobileUtf8Bytes(mobileCanonicalJson(value)) > cap) return mobileFailure('LIMIT_EXCEEDED','body'); return mobileOk(value); }
  catch (error) { return mobileFailure(error === 'limit' ? 'LIMIT_EXCEEDED' : direction === 'request' ? 'INVALID_REQUEST' : 'INVALID_RESPONSE','body'); }
}

/** 保留原始 UTF-8 预算并独立拒绝重复键，不能以重新编码后的短正文绕过 cap。 */
export function parseMobileJson(raw: Uint8Array, limits: MobileCodecLimits = MOBILE_CODEC_LIMITS, direction: 'request' | 'response' = 'response'): MobileDecodeResult<MobileJsonValue> {
  const cap = direction === 'request' ? limits.requestBytes : limits.responseBytes;
  if (!validLimits(limits) || !(raw instanceof Uint8Array) || raw.byteLength > cap) return mobileFailure('LIMIT_EXCEEDED','body');
  let text: string; try { text = new TextDecoder('utf-8',{ fatal: true, ignoreBOM: true }).decode(raw); } catch { return mobileFailure(direction === 'request' ? 'INVALID_REQUEST' : 'INVALID_RESPONSE','body'); }
  let at = 0, nodes = 0;
  const space = (): void => { while (at < text.length && /[\t\n\r ]/u.test(text[at]!)) at++; };
  const string = (): string => {
    const start = at++; let escaped = false;
    while (at < text.length) { const c = text[at++]!; if (!escaped && c === '"') { const v: unknown = JSON.parse(text.slice(start,at)); if (typeof v !== 'string' || !wellFormed(v)) throw 'data'; return v; } if (!escaped && c === '\\') escaped = true; else escaped = false; }
    throw 'data';
  };
  const value = (depth: number): MobileJsonValue => {
    if (++nodes > limits.nodes || depth > limits.depth) throw 'limit'; space(); const c = text[at];
    if (c === '"') return string();
    if (c === '{') { at++; space(); const out = Object.create(null) as MobileRecord, seen = new Set<string>(); if (text[at] === '}') { at++; return out; }
      for (;;) { space(); if (text[at] !== '"') throw 'data'; const key = string(); if (seen.has(key)) throw 'data'; seen.add(key); space(); if (text[at++] !== ':') throw 'data'; out[key] = value(depth+1); space(); const end = text[at++]; if (end === '}') return out; if (end !== ',') throw 'data'; }
    }
    if (c === '[') { at++; space(); const out: MobileJsonValue[] = []; if (text[at] === ']') { at++; return out; } for (;;) { out.push(value(depth+1)); space(); const end = text[at++]; if (end === ']') return out; if (end !== ',') throw 'data'; } }
    for (const [token,v] of [['true',true],['false',false],['null',null]] as const) if (text.startsWith(token,at)) { at += token.length; return v; }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(text.slice(at)); if (!match) throw 'data'; at += match[0].length;
    const n = Number(match[0]); if (!Number.isFinite(n) || (Number.isInteger(n) && !Number.isSafeInteger(n))) throw 'data'; return n;
  };
  try { const result = value(0); space(); if (at !== text.length) throw 'data'; return mobileOk(result); }
  catch (error) { return mobileFailure(error === 'limit' ? 'LIMIT_EXCEEDED' : direction === 'request' ? 'INVALID_REQUEST' : 'INVALID_RESPONSE','body'); }
}
export function mobileCanonicalJson(value: MobileJsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(mobileCanonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${mobileCanonicalJson(value[key]!)}`).join(',')}}`;
}

/** 这里只执行冻结 schema 所需规则；不读取外部文档或旧 IPC validator。 */
export interface MobileSchema {
  $ref?: string; type?: string | readonly string[]; const?: MobileJsonValue; enum?: readonly MobileJsonValue[];
  properties?: Readonly<Record<string,MobileSchema>>; required?: readonly string[]; additionalProperties?: boolean | MobileSchema;
  items?: MobileSchema; minItems?: number; maxItems?: number; uniqueItems?: boolean;
  minLength?: number; maxLength?: number; 'x-max-utf8-bytes'?: number; pattern?: string; format?: string; minimum?: number; maximum?: number;
  allOf?: readonly MobileSchema[]; anyOf?: readonly MobileSchema[]; oneOf?: readonly MobileSchema[];
  if?: MobileSchema; then?: MobileSchema; else?: MobileSchema; not?: MobileSchema;
}
export type MobileSchemaRegistry = Readonly<Record<string,MobileSchema>>;
const refName = (ref: string): string => ref.slice(ref.lastIndexOf('/')+1);
export function mobileSchemaAccepts(schema: MobileSchema, value: MobileJsonValue, registry: MobileSchemaRegistry): boolean {
  if (schema.$ref) { const ref = registry[refName(schema.$ref)]; if (!ref || !mobileSchemaAccepts(ref,value,registry)) return false; }
  if (Object.hasOwn(schema,'const') && mobileCanonicalJson(value) !== mobileCanonicalJson(schema.const!)) return false;
  if (schema.enum && !schema.enum.some(v => mobileCanonicalJson(v) === mobileCanonicalJson(value))) return false;
  const types = typeof schema.type === 'string' ? [schema.type] : schema.type;
  if (types && !types.some(t => t === 'null' ? value === null : t === 'object' ? mobileRecord(value) : t === 'array' ? Array.isArray(value) : t === 'integer' ? mobileInteger(value,Number.MIN_SAFE_INTEGER) : t === 'number' ? typeof value === 'number' : typeof value === t)) return false;
  if (typeof value === 'string') {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength || schema.maxLength !== undefined && length > schema.maxLength || schema['x-max-utf8-bytes'] !== undefined && mobileUtf8Bytes(value) > schema['x-max-utf8-bytes'] || schema.pattern && !new RegExp(schema.pattern,'u').test(value)) return false;
    if (schema.format === 'date-time' && !mobileDateTime(value) || schema.format === 'date' && !mobileDate(value)) return false;
    if (schema.format === 'uri') { try { new URL(value); } catch { return false; } }
  }
  if (typeof value === 'number' && (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum)) return false;
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems || schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.items && !value.every(v => mobileSchemaAccepts(schema.items!,v,registry))) return false;
    if (schema.uniqueItems && new Set(value.map(mobileCanonicalJson)).size !== value.length) return false;
  }
  if (mobileRecord(value)) {
    if (schema.required?.some(key => !Object.hasOwn(value,key))) return false;
    for (const key of Object.keys(value)) {
      const child = schema.properties?.[key];
      if (child ? !mobileSchemaAccepts(child,value[key]!,registry) : schema.additionalProperties === false || typeof schema.additionalProperties === 'object' && !mobileSchemaAccepts(schema.additionalProperties,value[key]!,registry)) return false;
    }
  }
  if (schema.allOf?.some(s => !mobileSchemaAccepts(s,value,registry))) return false;
  if (schema.anyOf && !schema.anyOf.some(s => mobileSchemaAccepts(s,value,registry))) return false;
  if (schema.oneOf && schema.oneOf.filter(s => mobileSchemaAccepts(s,value,registry)).length !== 1) return false;
  if (schema.not && mobileSchemaAccepts(schema.not,value,registry)) return false;
  if (schema.if && !mobileSchemaAccepts(mobileSchemaAccepts(schema.if,value,registry) ? schema.then ?? {} : schema.else ?? {},value,registry)) return false;
  return true;
}
export function mobileSchemaSnapshot<T>(schema: MobileSchema, raw: unknown, registry: MobileSchemaRegistry, limits: MobileCodecLimits = MOBILE_CODEC_LIMITS, direction: 'request' | 'response' = 'response'): MobileDecodeResult<T> {
  const captured = mobileDataSnapshot(raw,limits,direction); if (!captured.ok) return captured;
  if (!mobileSchemaAccepts(schema,captured.value,registry)) return mobileFailure(direction === 'request' ? 'INVALID_REQUEST' : 'INVALID_RESPONSE','schema');
  if (extensionBytes(schema,captured.value,registry) > limits.extensionBytes) return mobileFailure('LIMIT_EXCEEDED','extensions');
  return mobileOk(captured.value as unknown as T);
}
function extensionBytes(schema:MobileSchema,value:MobileJsonValue,registry:MobileSchemaRegistry):number {
  const props:Record<string,MobileSchema> = {}; const items:MobileSchema[] = [];
  const collect = (s:MobileSchema):void => {
    if (s.$ref && registry[refName(s.$ref)]) collect(registry[refName(s.$ref)]!);
    for (const [key,child] of Object.entries(s.properties ?? {})) props[key] = props[key] ? {allOf:[props[key]!,child]} : child;
    if (s.items) items.push(s.items); s.allOf?.forEach(collect);
    const branch = (s.oneOf ?? s.anyOf)?.find(part => mobileSchemaAccepts(part,value,registry)); if (branch) collect(branch);
    if (s.if) collect(mobileSchemaAccepts(s.if,value,registry) ? s.then ?? {} : s.else ?? {});
  };
  collect(schema);
  if (Array.isArray(value)) return items.length ? value.reduce<number>((sum,v) => sum + extensionBytes({allOf:items},v,registry),0) : 0;
  if (!mobileRecord(value)) return 0;
  return Object.keys(value).reduce((sum,key) => sum + (props[key] ? extensionBytes(props[key]!,value[key]!,registry) : mobileUtf8Bytes(`${JSON.stringify(key)}:${mobileCanonicalJson(value[key]!)}`)),0);
}
/** 出站投影全部 known 字段；不会反射允许的入站扩展。 */
export function mobileProjectSchema(schema: MobileSchema, value: MobileJsonValue, registry: MobileSchemaRegistry): MobileJsonValue {
  const resolved = schema.$ref ? registry[refName(schema.$ref)] ?? {} : schema;
  if (resolved.oneOf || resolved.anyOf) { const found = (resolved.oneOf ?? resolved.anyOf)!.find(s => mobileSchemaAccepts(s,value,registry)); if (found) return mobileProjectSchema(found,value,registry); }
  if (Array.isArray(value)) return resolved.items ? value.map(v => mobileProjectSchema(resolved.items!,v,registry)) : value.map(v => mobileProjectSchema({},v,registry));
  if (!mobileRecord(value)) return value;
  const props: Record<string,MobileSchema> = {};
  const collect = (s: MobileSchema): void => { if (s.$ref) { const ref = registry[refName(s.$ref)]; if (ref) collect(ref); } Object.assign(props,s.properties); s.allOf?.forEach(collect); };
  collect(schema); const out = Object.create(null) as MobileRecord;
  for (const key of Object.keys(props)) if (Object.hasOwn(value,key)) out[key] = mobileProjectSchema(props[key]!,value[key]!,registry);
  return out;
}

export interface MobileServerInfo { serverId: MobileId; displayName: string; contractVersion: '0.1.0'; environment: 'mock' | 'development' | 'production' }
export interface MobileCapabilities { contractVersion: '0.1.0'; localPlayback: boolean; neteasePlayback: boolean; transcoding: boolean; hls: boolean; preparedVariants: boolean; qualityProfiles: ('auto' | 'lossless' | 'balanced' | 'data_saver')[]; maxConcurrentSessions: number }
export interface MobilePairingClaim { pairingSecret: string; installationId: MobileId; deviceName: string }
export interface MobileTokenPair { deviceId: MobileId; accessToken: string; accessExpiresAt: string; refreshToken: string; refreshExpiresAt: string; serverId: MobileId }
export interface MobileRefreshRequest { refreshToken: string }
export type MobileEmptyRequest = Record<string,never>;
export interface MobileErrorEnvelope { error: { code: string; message: string; requestId: string; retryable: boolean; retryAfterMs?: number } }
export interface MobileAudioInfo { codec: string; container: string; sampleRateHz?: number; bitsPerSample?: number; channels?: number; bitrateKbps?: number }
export interface MobileProcessing { mode: 'direct' | 'remux' | 'lossless_conversion' | 'lossy_transcode' | 'resample'; reason: string; fromPreparedCache: boolean }
export interface MobileSessionScope { serverId: MobileId; deviceId: MobileId; sessionId: MobileId }
export interface MobileResourceContextBasis { capabilitySnapshotIdentity: MobileId; responseOrigin: string; now: string }
export interface MobileResourceCodecContext extends MobileResourceContextBasis { scope: MobileSessionScope; resourceFormatBitDepth: boolean; capabilityVersion: 'base' | '1.0.0' }
export interface MobileSafeErrorFacts { code: 'INVALID_REQUEST' | 'UNAUTHORIZED' | 'SOURCE_CHANGED' | 'CURSOR_INVALID' | 'REVISION_CONFLICT' | 'IDEMPOTENCY_CONFLICT' | 'UNSUPPORTED_FORMAT' | 'BUSY' | 'CONTENT_LIMIT_EXCEEDED'; requestId: string; retryable: boolean; retryAfterMs?: number }
export const MOBILE_ID_SCHEMA: MobileSchema = { type:'string', minLength:1, maxLength:160, pattern:'^[A-Za-z0-9_.:-]+(?![\\s\\S])' };
export const MOBILE_COMMON_SCHEMAS: MobileSchemaRegistry = {
  Error:{ type:'object', required:['error'], additionalProperties:true, properties:{error:{type:'object',required:['code','message','requestId','retryable'],additionalProperties:true,properties:{code:{type:'string'},message:{type:'string'},requestId:{type:'string'},retryable:{type:'boolean'},retryAfterMs:{type:'integer',minimum:0}}}}},
  ServerInfo:{type:'object',required:['serverId','displayName','contractVersion','environment'],additionalProperties:true,properties:{serverId:MOBILE_ID_SCHEMA,displayName:{type:'string'},contractVersion:{type:'string',const:'0.1.0'},environment:{enum:['mock','development','production']}}},
  Capabilities:{type:'object',required:['contractVersion','localPlayback','neteasePlayback','transcoding','hls','preparedVariants','qualityProfiles','maxConcurrentSessions'],additionalProperties:true,properties:{contractVersion:{type:'string',const:'0.1.0'},localPlayback:{type:'boolean'},neteasePlayback:{type:'boolean'},transcoding:{type:'boolean'},hls:{type:'boolean'},preparedVariants:{type:'boolean'},qualityProfiles:{type:'array',items:{enum:['auto','lossless','balanced','data_saver']}},maxConcurrentSessions:{type:'integer',minimum:2}}},
  PairingClaim:{type:'object',required:['pairingSecret','installationId','deviceName'],additionalProperties:false,properties:{pairingSecret:{type:'string',minLength:16,maxLength:512},installationId:MOBILE_ID_SCHEMA,deviceName:{type:'string',minLength:1,maxLength:100}}},
  TokenPair:{type:'object',required:['deviceId','accessToken','accessExpiresAt','refreshToken','refreshExpiresAt','serverId'],additionalProperties:true,properties:{deviceId:MOBILE_ID_SCHEMA,serverId:MOBILE_ID_SCHEMA,accessToken:{type:'string'},refreshToken:{type:'string'},accessExpiresAt:{type:'string',format:'date-time'},refreshExpiresAt:{type:'string',format:'date-time'}}},
  RefreshRequest:{type:'object',required:['refreshToken'],additionalProperties:false,properties:{refreshToken:{type:'string',minLength:16,maxLength:512}}},
  EmptyRequest:{type:'object',required:[],additionalProperties:false,properties:{}},
  AudioInfo:{type:'object',required:['codec','container'],additionalProperties:true,properties:{codec:{type:'string'},container:{type:'string'},sampleRateHz:{type:'integer',minimum:1},bitsPerSample:{type:'integer',minimum:1},channels:{type:'integer',minimum:1},bitrateKbps:{type:'number',minimum:0}}},
  Processing:{type:'object',required:['mode','reason','fromPreparedCache'],additionalProperties:true,properties:{mode:{enum:['direct','remux','lossless_conversion','lossy_transcode','resample']},reason:{type:'string'},fromPreparedCache:{type:'boolean'}}}
};
export interface MobileCommonRequestMap { pairingClaim: MobilePairingClaim; refresh: MobileRefreshRequest; empty: MobileEmptyRequest }
export interface MobileCommonResponseMap { serverInfo: MobileServerInfo; capabilities: MobileCapabilities; tokenPair: MobileTokenPair; error: MobileErrorEnvelope; audioInfo: MobileAudioInfo; processing: MobileProcessing }
const requestSchemas = {pairingClaim:'PairingClaim',refresh:'RefreshRequest',empty:'EmptyRequest'} as const;
const responseSchemas = {serverInfo:'ServerInfo',capabilities:'Capabilities',tokenPair:'TokenPair',error:'Error',audioInfo:'AudioInfo',processing:'Processing'} as const;
export function mobileCommonRequestSnapshot<K extends keyof MobileCommonRequestMap>(kind: K, raw: unknown, limits: MobileCodecLimits = MOBILE_CODEC_LIMITS): MobileDecodeResult<MobileCommonRequestMap[K]> { return mobileSchemaSnapshot(MOBILE_COMMON_SCHEMAS[requestSchemas[kind]]!,raw,MOBILE_COMMON_SCHEMAS,limits,'request'); }
export function mobileCommonResponseSnapshot<K extends keyof MobileCommonResponseMap>(kind: K, raw: unknown, limits: MobileCodecLimits = MOBILE_CODEC_LIMITS): MobileDecodeResult<MobileCommonResponseMap[K]> { return mobileSchemaSnapshot(MOBILE_COMMON_SCHEMAS[responseSchemas[kind]]!,raw,MOBILE_COMMON_SCHEMAS,limits); }
export const isMobileAudioInfo = (raw: unknown): raw is MobileAudioInfo => mobileCommonResponseSnapshot('audioInfo',raw).ok;
export const isMobileProcessing = (raw: unknown): raw is MobileProcessing => mobileCommonResponseSnapshot('processing',raw).ok;
export const isMobileErrorEnvelope = (raw: unknown): raw is MobileErrorEnvelope => mobileCommonResponseSnapshot('error',raw).ok;
export function normalizeMobileRetryHint(raw: unknown): number | null { return mobileInteger(raw) ? Math.min(raw,MOBILE_RETRY_HINT_MAX_MS) : null; }
export function mapMobileSafeError(facts: MobileSafeErrorFacts): MobileDecodeResult<MobileErrorEnvelope> {
  const messages: Record<MobileSafeErrorFacts['code'],string> = {INVALID_REQUEST:'请求无法识别。',UNAUTHORIZED:'设备认证已失效。',SOURCE_CHANGED:'来源内容已变化，请刷新。',CURSOR_INVALID:'分页快照已失效，请刷新。',REVISION_CONFLICT:'内容已被更新，请刷新。',IDEMPOTENCY_CONFLICT:'原操作身份不一致。',UNSUPPORTED_FORMAT:'当前设备不支持此格式。',BUSY:'服务忙，请稍后重试。',CONTENT_LIMIT_EXCEEDED:'完整内容超过传输上限。'};
  if (!Object.hasOwn(messages,facts.code) || !/^[A-Za-z0-9_.-]{1,128}$/u.test(facts.requestId) || typeof facts.retryable !== 'boolean' || facts.retryAfterMs !== undefined && !mobileInteger(facts.retryAfterMs)) return mobileFailure('INVALID_RESPONSE','error');
  return mobileOk({error:{code:facts.code,message:messages[facts.code],requestId:facts.requestId,retryable:facts.retryable,...(facts.retryAfterMs === undefined ? {} : {retryAfterMs:normalizeMobileRetryHint(facts.retryAfterMs)!})}});
}
export function mapMobileFileAudioParameters(raw: FileAudioParameters): MobileDecodeResult<MobileAudioInfo> {
  const captured = mobileDataSnapshot(raw); if (!captured.ok || !mobileRecord(captured.value)) return mobileFailure('INVALID_RESPONSE','sourceAudio'); raw = captured.value as unknown as FileAudioParameters;
  const containers: Record<FileAudioParameters['container'],string> = {FLAC:'flac',MPEG:'mp3',MP4:'m4a',WAVE:'wav',AIFF:'aiff'};
  if (typeof raw.codec !== 'string') return mobileFailure('INVALID_RESPONSE','sourceAudio');
  const codec = raw.codec.toLowerCase();
  if (!containers[raw.container] || !/^[a-z0-9_+-]{1,40}$/u.test(codec)) return mobileFailure('INVALID_RESPONSE','sourceAudio');
  return mobileCommonResponseSnapshot('audioInfo',{codec,container:containers[raw.container],sampleRateHz:raw.sampleRateHz,channels:raw.channels,...(raw.bitsPerSample === null ? {} : {bitsPerSample:raw.bitsPerSample})});
}
export function mapMobileSourceTechnical(raw: SourceTechnical): MobileDecodeResult<MobileAudioInfo> {
  const captured = mobileDataSnapshot(raw); if (!captured.ok || !mobileRecord(captured.value)) return mobileFailure('INVALID_RESPONSE','sourceAudio'); raw = captured.value as unknown as SourceTechnical;
  return mobileCommonResponseSnapshot('audioInfo',{codec:raw.codec,container:raw.container,sampleRateHz:raw.sampleRate,channels:raw.channels,...(raw.bitsPerSample === undefined ? {} : {bitsPerSample:raw.bitsPerSample})});
}
