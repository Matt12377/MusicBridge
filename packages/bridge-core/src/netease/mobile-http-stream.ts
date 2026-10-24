import { mobileResourceCapacityFailure } from '../mobile/resource-capacity-trace.js';
import { randomUUID } from 'node:crypto';
import { mobileCanonicalJson, mobileDataSnapshot, mobileInteger, mobileRecord } from '@music-bridge/contracts';
import type { MobileSafeErrorFacts, MobileTrackSelection } from '@music-bridge/contracts';
import { assertSafeAudioUrl } from './policy.js';
import { assertPublicHttpsUrl, type GatewayFetch } from '../stream/upstream-policy.js';
import { readMobileNeteaseAudioFacts } from '../mobile/netease-audio-facts.js';
import { captureMobileNeteaseSelection } from '../mobile/netease-catalog-service.js';
import { assertMobileNeteaseAccount, captureMobileNeteaseAccount, captureMobileNeteaseScope, mobileNeteaseId } from '../mobile/netease-source-types.js';
import type { MobileNeteaseAccount, MobileNeteaseFence, MobileNeteaseObservedAudio, MobileNeteaseScope, MobileNeteaseStreamLease } from '../mobile/netease-source-types.js';
import { MobileServiceError } from '../mobile/types.js';
import { captureMobileCapabilityContext, mobileCapabilityCache, mobileCapabilityReject, type MobileCapabilityStage } from '../mobile/capability-trace.js';

/** 仅在同一 Core 内部传递。这里没有 Cookie、公共 URL 或 Roon 确认能力。 */
export interface MobileNeteaseHttpSource {
  account: Readonly<MobileNeteaseAccount>;
  sourceIdentity: string;
  size: number;
  expiresAtMs: number;
  upstreamUrl: string;
  requestHeaders: Readonly<Record<string, string>>;
  /** 本次Provider API已验证的完整对象指纹；不是HTTP entity-tag，也不进入公共DTO。 */
  contentDigest?: Readonly<{ algorithm: 'md5'; value: string }>;
  /** 仅私有旁注比较本次已验证API事实；不用于HTTP准入、公开DTO或来源身份。 */
  diagnosticMediaMd5?: string;
}
export interface MobileNeteaseHttpStreamsOptions {
  assertCurrent: MobileNeteaseFence;
  refresh(scope: MobileNeteaseScope, selection: Readonly<MobileTrackSelection>, signal: AbortSignal): Promise<MobileNeteaseHttpSource>;
  now?: () => number;
  /** 合成测试可注入只读 transport；生产缺省使用原 public-DNS/HTTPS/redirect 策略。 */
  fetch?: GatewayFetch;
  /** 仅可信组合根显式开启；不输出上游地址、头部、异常正文或业务身份。 */
  privateDiagnostics?: boolean;
}
export interface MobileNeteaseHttpStreams {
  readonly qualified: boolean;
  probe(scope: MobileNeteaseScope, source: MobileNeteaseHttpSource, signal: AbortSignal): Promise<Readonly<MobileNeteaseObservedAudio>>;
  openFromSource(scope: MobileNeteaseScope, source: MobileNeteaseHttpSource, selection: Readonly<MobileTrackSelection>, signal: AbortSignal): Promise<{
    lease: MobileNeteaseStreamLease; observed: Readonly<MobileNeteaseObservedAudio>;
  }>;
  invalidateAccount(): void;
  close(): Promise<void>;
  snapshot(): Readonly<{ leases: number; probes: number; readers: number; pending: number; fatal: boolean }>;
}

const MAX_LEASES = 8, MAX_PROBES = 2, MAX_READERS = 32, MAX_RESOURCE_READERS = 4, MAX_READ_IDS = 4096;
const READ_MS = 5_000, QUIET_MS = 10_000, LEASE_MS = 300_000, MAX_LIFETIME_MS = 43_200_000;
type AudioProbeRejection = 'non206' | 'body-missing' | 'etag-missing' | 'etag-weak' | 'etag-invalid'
  | 'etag-invalid.bare32hex' | 'etag-invalid.overlimit' | 'etag-invalid.malformedquoted' | 'etag-invalid.unquotedother'
  | `etag-date.${'missing' | 'invalid' | 'future' | 'not-strong' | 'shape' | 'conditional' | 'changed'}`
  | 'redirect-location-missing' | 'redirect-limit' | 'redirect-policy' | 'parser' | SourceConsistencyRejection;
type SourceConsistencyRejection = 'range.content-range' | 'range.content-length' | 'range.encoding'
  | 'vendor.status' | 'vendor.etag' | 'vendor.digest' | 'vendor.identity' | 'vendor.size' | 'vendor.multipart'
  | 'strong-etag-changed' | 'body.chunk' | 'body.length';
type UnquotedEtagDiagnostic = 'after-strong' | 'multipart-initial';
// RFC9110 8.8.3：opaque-tag允许空内容；etagc只有指定的单字节字符，不能反转义或补引号。
const strongEntityTag = /^"[\x21\x23-\x7e\x80-\xff]*"(?![\s\S])/u;
function invalidEtagReason(etag: string): AudioProbeRejection {
  if (etag.length > 256) return 'etag-invalid.overlimit';
  if (/^[a-fA-F0-9]{32}(?![\s\S])/u.test(etag)) return 'etag-invalid.bare32hex';
  if (etag.startsWith('"') || etag.endsWith('"')) return 'etag-invalid.malformedquoted';
  return 'etag-invalid.unquotedother';
}
type DateValidator = Readonly<{ lastModified: string; rawEtag: string }>;
type VendorDigestValidator = Readonly<{ rawEtag: string; value: string; sourceIdentity: string; size: number }>;
type NeteaseObjectValidator = Readonly<{ rawEtag: string; value: string; sourceIdentity: string; size: number }>;
type CapturedHttpSource = Readonly<MobileNeteaseHttpSource> & Readonly<{ neteaseObjectTarget: boolean }>;
const neteaseObjectTag = /^[a-fA-F0-9]{32}-(?:[1-9][0-9]{0,3}|10000)(?![\s\S])/u;
function neteaseObjectTarget(value: string, base?: string): boolean {
  try {
    const authority = /^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#]*)/iu.exec(value)?.[1];
    if (value.trim() !== value || value.includes('\\') || authority?.includes('@')) return false;
    const url = new URL(value, base);
    return url.protocol === 'https:' && !url.username && !url.password && url.port === ''
      && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+music\.126\.net$/u.test(url.hostname);
  } catch { return false; }
}
// 只接受IMF-fixdate的逐字往返；Date.parse的宽松语法不能作为请求头准入。
function httpDate(value: string): number | null {
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT(?![\s\S])/u.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && new Date(parsed).toUTCString() === value ? parsed : null;
}
function dateValidator(response: Response, etag: string, now: number): DateValidator | AudioProbeRejection {
  // 裸标记仅作额外逐字围栏，绝不补引号、解码为MD5或放入If-Match。
  if (!/^[\x21-\x7e]{1,256}(?![\s\S])/u.test(etag) || /[",\\]/u.test(etag) || /^w\//iu.test(etag)) return 'etag-date.shape';
  const modified = response.headers.get('last-modified'), date = response.headers.get('date');
  if (!modified || !date) return 'etag-date.missing';
  const modifiedMs = httpDate(modified), dateMs = httpDate(date);
  if (modifiedMs === null || dateMs === null) return 'etag-date.invalid';
  if (dateMs > now || modifiedMs > now) return 'etag-date.future';
  // RFC9110 8.8.2.2允许根据Date/Last-Modified及足够时差推定强日期。
  // 本分支额外保守要求60秒；60秒是本地策略，并非9110规定的门槛。
  if (dateMs - modifiedMs < 60000) return 'etag-date.not-strong';
  return Object.freeze({ lastModified: modified, rawEtag: etag });
}
type HttpDateDiagnostic = 'valid' | 'imf-shape' | 'imf-parse' | 'imf-negative' | 'imf-weekday' | 'imf-roundtrip'
  | 'obsolete' | 'iso' | 'combined' | 'other';
const diagnosticImfShape = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT(?![\s\S])/u;
const diagnosticObsoleteShape = /^(?:(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), [0-9]{2}-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT|(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?: [0-9]|[0-9]{2}) [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4})(?![\s\S])/u;
const diagnosticIsoShape = /^[0-9]{4}-[0-9]{2}-[0-9]{2}(?:[Tt ][0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?(?:[Zz]|[+-][0-9]{2}:?[0-9]{2}))?(?![\s\S])/u;
/** 只在原invalid拒绝之后作私有旁注；识别形态不授予HTTP日期准入资格。 */
function httpDateDiagnostic(value: string | null): HttpDateDiagnostic {
  if (value === null || value.length > 512) return 'other';
  if (diagnosticImfShape.test(value)) {
    const parsed = Date.parse(value);
    if (!Number.isSafeInteger(parsed)) return 'imf-parse';
    if (parsed < 0) return 'imf-negative';
    const canonical = new Date(parsed).toUTCString();
    if (canonical === value) return 'valid';
    return canonical.slice(3) === value.slice(3) ? 'imf-weekday' : 'imf-roundtrip';
  }
  // 组合仅指两个以上完整、已知形态的日期以逗号+空格连接；不猜任意字符串。
  const parts = value.split(/, (?=(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)(?:,| )|[0-9]{4}-)/u);
  if (parts.length > 1 && parts.every(part => diagnosticImfShape.test(part) || diagnosticObsoleteShape.test(part) || diagnosticIsoShape.test(part))) return 'combined';
  if (diagnosticObsoleteShape.test(value)) return 'obsolete';
  if (diagnosticIsoShape.test(value)) return 'iso';
  if (/^[A-Za-z]{3}, [0-9]{1,2} [A-Za-z]{3} [0-9]{4} [0-9]{1,2}:[0-9]{1,2}:[0-9]{1,2} [A-Za-z]{1,5}(?![\s\S])/u.test(value)) return 'imf-shape';
  return 'other';
}
function invalidDateDiagnostic(response: Response): MobileCapabilityStage | null {
  const date = httpDateDiagnostic(response.headers.get('date')), modified = httpDateDiagnostic(response.headers.get('last-modified'));
  if (date !== 'valid' && modified === 'valid') return `provider.audio-probe.reject.etag-date.invalid.date.${date}.valid`;
  if (date === 'valid' && modified !== 'valid') return `provider.audio-probe.reject.etag-date.invalid.last-modified.valid.${modified}`;
  if (date !== 'valid' && modified !== 'valid') return `provider.audio-probe.reject.etag-date.invalid.both.${date}.${modified}`;
  return null;
}
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/u.test(v);
const fail = (status: 400 | 401 | 403 | 404 | 409 | 410 | 429 | 503, code: MobileSafeErrorFacts['code']): never => {
  throw new MobileServiceError(status, code, status === 429 || status === 503, status === 429 || status === 503 ? 1000 : undefined);
};
function freeze<T>(v: T): T { if (v && typeof v === 'object') { for (const child of Object.values(v)) freeze(child); Object.freeze(v); } return v; }
function canonical(value: unknown): string { const c = mobileDataSnapshot(value); if (!c.ok) return fail(409, 'SOURCE_CHANGED'); return mobileCanonicalJson(c.value); }
function captureSource(raw: MobileNeteaseHttpSource): CapturedHttpSource {
  const c = mobileDataSnapshot(raw);
  if (!c.ok || !mobileRecord(c.value)) return fail(409, 'SOURCE_CHANGED');
  const { diagnosticMediaMd5, contentDigest, ...v } = c.value;
  if (Reflect.ownKeys(v).length !== 6 || !['account','sourceIdentity','size','expiresAtMs','upstreamUrl','requestHeaders'].every(k => Object.hasOwn(v, k))
    || !mobileNeteaseId(v.sourceIdentity) || !mobileInteger(v.size, 4) || !mobileInteger(v.expiresAtMs)
    || typeof v.upstreamUrl !== 'string' || v.upstreamUrl.length > 8192 || !mobileRecord(v.requestHeaders)) return fail(409, 'SOURCE_CHANGED');
  const headers = v.requestHeaders, keys = Object.keys(headers);
  if (keys.some(k => !['User-Agent','Referer','Accept-Encoding'].includes(k))
    || !keys.every(k => typeof headers[k] === 'string' && String(headers[k]).length <= 1024
      && !/[\u0000-\u001f\u007f]/u.test(String(headers[k])))
    || headers['Accept-Encoding'] !== 'identity') return fail(409, 'SOURCE_CHANGED');
  const account = captureMobileNeteaseAccount(v.account);
  let upstreamUrl: string;
  try { upstreamUrl = assertSafeAudioUrl(v.upstreamUrl); } catch { return fail(409, 'SOURCE_CHANGED'); }
  let digest: MobileNeteaseHttpSource['contentDigest'];
  if (contentDigest !== undefined) {
    if (!mobileRecord(contentDigest) || Reflect.ownKeys(contentDigest).length !== 2 || !['algorithm','value'].every(k => Object.hasOwn(contentDigest, k)) || contentDigest.algorithm !== 'md5'
      || typeof contentDigest.value !== 'string' || !/^[a-fA-F0-9]{32}(?![\s\S])/u.test(contentDigest.value)) return fail(409, 'SOURCE_CHANGED');
    digest = Object.freeze({ algorithm: 'md5', value: contentDigest.value.toLowerCase() });
  }
  return freeze({ account, sourceIdentity: v.sourceIdentity, size: v.size, expiresAtMs: v.expiresAtMs,
    // 在URL规范化前捕获资格，空userinfo也不能被URL.toString抹掉后取得对象模式。
    neteaseObjectTarget: neteaseObjectTarget(v.upstreamUrl),
    upstreamUrl, requestHeaders: { ...headers } as Record<string,string>,
    ...(digest ? { contentDigest: digest } : {}),
    ...(typeof diagnosticMediaMd5 === 'string' && /^[a-fA-F0-9]{32}(?![\s\S])/u.test(diagnosticMediaMd5)
      ? { diagnosticMediaMd5: diagnosticMediaMd5.toLowerCase() } : {}) });
}
interface Reader {
  id: string; controller: AbortController; pending: Promise<Uint8Array> | null; flights: Set<Promise<unknown>>; closed: boolean; closing: Promise<void> | null;
}
interface LeaseRecord {
  id: string; kind: 'probe' | 'lease'; scope: MobileNeteaseScope; source: CapturedHttpSource;
  selection: Readonly<MobileTrackSelection> | null; controller: AbortController; born: number; expires: number;
  etag: string | null; dateValidator: DateValidator | null; vendorDigest: VendorDigestValidator | null; neteaseObject: NeteaseObjectValidator | null;
  observed: Readonly<MobileNeteaseObservedAudio> | null;
  pending: Set<Promise<unknown>>; readers: Map<string, Reader>; closing: Promise<void> | null; released: boolean;
  failure: MobileServiceError | null;
}

/** 独立手机网络租约；不下载整曲、不建立文件池、不借用旧 loopback/Roon registry。 */
export function createMobileNeteaseHttpStreams(options: MobileNeteaseHttpStreamsOptions): MobileNeteaseHttpStreams {
  const now = options.now ?? Date.now, fence = options.assertCurrent, refresh = options.refresh;
  const injectedTransport = options.fetch !== undefined, transport = options.fetch ?? fetch;
  const records = new Set<LeaseRecord>(), readerOwners = new Map<string, LeaseRecord>();
  const diagnosedContexts = new WeakSet<object>();
  function diagnose(reason: AudioProbeRejection, error: MobileServiceError, response?: Response,
    identity?: Readonly<{ etag: string; expectedMd5?: string }>, unquoted?: UnquotedEtagDiagnostic): void {
    try {
      const context = captureMobileCapabilityContext();
      if (options.privateDiagnostics !== true || !context || context.closed || diagnosedContexts.has(context)) return;
      let stage: MobileCapabilityStage = `provider.audio-probe.reject.${reason}`;
      if (reason === 'etag-invalid.unquotedother') {
        if (unquoted === 'after-strong') stage = 'provider.audio-probe.reject.etag-invalid.unquotedother.after-strong';
        else if (unquoted === 'multipart-initial' && response && identity) {
          try {
            // 仅对既有拒绝分类；合格日期也不写入record、不授予准入或发送条件头。
            const candidate = dateValidator(response, identity.etag, clock());
            if (typeof candidate !== 'string') stage = 'provider.audio-probe.reject.etag-invalid.unquotedother.multipart-initial.date-eligible';
            else switch (candidate) {
              case 'etag-date.missing': stage = 'provider.audio-probe.reject.etag-invalid.unquotedother.multipart-initial.date-missing'; break;
              case 'etag-date.invalid':
                stage = 'provider.audio-probe.reject.etag-invalid.unquotedother.multipart-initial.date-invalid';
                try { stage = invalidDateDiagnostic(response) ?? stage; } catch { /* 详细旁注失败保留原粗分类。 */ }
                break;
              case 'etag-date.future': stage = 'provider.audio-probe.reject.etag-invalid.unquotedother.multipart-initial.date-future'; break;
              case 'etag-date.not-strong': stage = 'provider.audio-probe.reject.etag-invalid.unquotedother.multipart-initial.date-not-strong'; break;
              case 'etag-date.shape': stage = 'provider.audio-probe.reject.etag-invalid.unquotedother.multipart-initial.date-shape'; break;
            }
          } catch { /* 诊断失败仍保留原generic首拒，不检查异常内容。 */ }
        }
      }
      if (reason === 'etag-date.invalid' && response) {
        try { stage = invalidDateDiagnostic(response) ?? stage; } catch { /* 旁注读取失败仍保留原generic首拒。 */ }
      }
      let identityStage: MobileCapabilityStage | undefined;
      if (context.privateContentDiagnostic === true && identity) {
        if (/^[a-fA-F0-9]{32}(?![\s\S])/u.test(identity.etag)) {
          identityStage = identity.expectedMd5 === undefined ? 'provider.audio-probe.validator.bare32hex.not-comparable'
            : identity.etag.toLowerCase() === identity.expectedMd5 ? 'provider.audio-probe.validator.bare32hex.equal'
              : 'provider.audio-probe.validator.bare32hex.mismatch';
        } else identityStage = 'provider.audio-probe.validator.unquotedother.not-comparable';
      }
      diagnosedContexts.add(context); mobileCapabilityReject(stage, error);
      // 同一次拒绝的分类旁注，不代表初始化或验证成功；先保留原首拒的预留槽。
      if (identityStage) mobileCapabilityCache(identityStage, 'none', null);
    } catch { /* 私有旁注不能替换原拒绝或重演网络读取。 */ }
  }
  function unsupported(reason: AudioProbeRejection, response?: Response,
    identity?: Readonly<{ etag: string; expectedMd5?: string }>, unquoted?: UnquotedEtagDiagnostic): never {
    const error = new MobileServiceError(409, 'UNSUPPORTED_FORMAT'); diagnose(reason, error, response, identity, unquoted); throw error;
  }
  function sourceChanged(reason: () => SourceConsistencyRejection): never {
    try { return fail(409, 'SOURCE_CHANGED'); } catch (error) {
      try {
        const context = captureMobileCapabilityContext();
        if (options.privateDiagnostics === true && context?.privateContentDiagnostic === true && !context.closed && !context.firstBusiness
          && !diagnosedContexts.has(context) && error instanceof MobileServiceError) diagnose(reason(), error);
      } catch { /* 仅对原拒绝作闭集旁注；分类失败不替换原错误或quiet。 */ }
      throw error;
    }
  }
  function dateChanged(reason: 'etag-date.conditional' | 'etag-date.changed'): never {
    const error = new MobileServiceError(409, 'SOURCE_CHANGED'); diagnose(reason, error); throw error;
  }
  let closed = false, fatal = false, closeOperation: Promise<void> | null = null;
  const clock = () => { const value = now(); return mobileInteger(value) ? value : fail(503, 'BUSY'); };
  const count = (kind: LeaseRecord['kind']) => [...records].filter(r => !r.released && r.kind === kind).length;
  const ready = () => { if (closed || fatal) return fail(503, 'BUSY'); };
  function nonquiet(r: LeaseRecord): MobileServiceError {
    fatal = true; r.failure ??= new MobileServiceError(503, 'BUSY', true, 1000); return r.failure;
  }
  function local(r: LeaseRecord): void {
    if (r.failure) throw r.failure;
    if (closed || r.released || r.closing || r.controller.signal.aborted) return fail(410, 'RESOURCE_RELEASED');
    if (fatal) return fail(503, 'BUSY');
    if (clock() >= r.expires || clock() - r.born >= MAX_LIFETIME_MS) return fail(410, 'RESOURCE_EXPIRED');
  }
  async function current(r: LeaseRecord, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted(); local(r); await fence(r.scope, 'lease'); signal.throwIfAborted(); local(r);
  }
  function quiet(r: LeaseRecord, work: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refused = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(nonquiet(r)), QUIET_MS); });
    return Promise.race([work, refused]).finally(() => { if (timer) clearTimeout(timer); });
  }
  function track<T>(r: LeaseRecord, work: Promise<T>): Promise<T> {
    r.pending.add(work); void work.finally(() => r.pending.delete(work)).catch(() => undefined); return work;
  }
  async function fetchRange(r: LeaseRecord, init: RequestInit): Promise<Readonly<{ response: Response; target: string; neteaseObjectTarget: boolean }>> {
    // 生产沿原 HTTPS/public-DNS 和五次重定向准入，但不能吞掉中间 body 的关闭失败。
    // 测试 transport 只代替实际网络，不代替下面的 Range/身份/quiet 验证。
    let url = r.source.upstreamUrl, objectTarget = r.source.neteaseObjectTarget;
    for (let redirects = 0; redirects <= 5; redirects++) {
      init.signal?.throwIfAborted();
      const target = injectedTransport ? assertSafeAudioUrl(url) : (await assertPublicHttpsUrl(url)).toString();
      const response = await transport(target, { ...init, redirect: 'manual' });
      if (![301,302,303,307,308].includes(response.status)) return { response, target, neteaseObjectTarget: objectTarget && neteaseObjectTarget(target) };
      const location = response.headers.get('location');
      if (response.body) { try { await response.body.cancel(); } catch { throw nonquiet(r); } }
      if (!location) return unsupported('redirect-location-missing');
      if (redirects === 5) return unsupported('redirect-limit');
      try { objectTarget = neteaseObjectTarget(location, target); url = assertSafeAudioUrl(new URL(location, target).toString()); }
      catch { return unsupported('redirect-policy'); }
    }
    return unsupported('redirect-limit');
  }
  /** Caller 超时不把实际 fetch/reader 从 pending 删除，迟到响应仍必须取消并静止。 */
  function boundedRange(r: LeaseRecord, start: number, length: number, signal: AbortSignal, read?: Reader): Promise<Uint8Array> {
    if (!mobileInteger(start) || !mobileInteger(length, 1, 65_536) || !Number.isSafeInteger(start + length) || start + length > r.source.size) return Promise.reject(new MobileServiceError(400, 'INVALID_REQUEST'));
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true }); r.controller.signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted || r.controller.signal.aborted) controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined, onAbort: (() => void) | undefined;
    const refusal = new Promise<never>((_, reject) => {
      onAbort = () => reject(new MobileServiceError(503, 'BUSY', true, 1000));
      controller.signal.addEventListener('abort', onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
      timer = setTimeout(abort, READ_MS);
    });
    const raw = track(r, (async () => {
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null, complete = false;
      try {
        await current(r, controller.signal);
        const { response, target, neteaseObjectTarget: objectTarget } = await fetchRange(r, { method: 'GET', redirect: 'manual', signal: controller.signal,
          headers: { ...r.source.requestHeaders, Range: `bytes=${start}-${start + length - 1}`, ...(r.etag ? { 'If-Match': r.etag } : {}),
            ...(r.dateValidator ? { 'If-Range': r.dateValidator.lastModified, 'If-Unmodified-Since': r.dateValidator.lastModified } : {}) } });
        // 即便 transport 忽略 abort 迟到返回，也先取得原 body 的清理所有权。
        if (response.body) reader = response.body.getReader();
        controller.signal.throwIfAborted(); await current(r, controller.signal);
        if (response.status === 401 || response.status === 403) return fail(403, 'RESOURCE_REVOKED');
        // If-Range失配会退回200；只关闭body，不接受或消耗整曲响应。
        if (r.dateValidator && (response.status === 200 || response.status === 412)) return dateChanged('etag-date.conditional');
        if ((r.vendorDigest || r.neteaseObject) && response.status !== 206) return sourceChanged(() => 'vendor.status');
        if (response.status !== 206) return unsupported('non206');
        if (!reader) return unsupported('body-missing');
        const range = response.headers.get('content-range'), declared = response.headers.get('content-length');
        if (range !== `bytes ${start}-${start + length - 1}/${r.source.size}` || declared !== String(length)
          || ![null, 'identity'].includes(response.headers.get('content-encoding'))) return sourceChanged(() =>
            range !== `bytes ${start}-${start + length - 1}/${r.source.size}` ? 'range.content-range'
              : declared !== String(length) ? 'range.content-length' : 'range.encoding');
        // 验证器来自本次实际HTTP，不能由Provider的size/URL或文件名推导。
        const etag = response.headers.get('etag');
        if (r.neteaseObject) {
          const object = r.neteaseObject;
          // NOS完整对象标记逐字围栏；不是整曲MD5验证，也不是RFC strong ETag。
          if (etag !== object.rawEtag || r.source.contentDigest?.value !== object.value
            || r.source.sourceIdentity !== object.sourceIdentity || r.source.size !== object.size
            || !r.source.neteaseObjectTarget || !objectTarget || !neteaseObjectTarget(target)
            || /^multipart\//iu.test(response.headers.get('content-type') ?? '')) return sourceChanged(() =>
              etag !== object.rawEtag ? 'vendor.etag' : r.source.contentDigest?.value !== object.value ? 'vendor.digest'
                : r.source.size !== object.size ? 'vendor.size' : r.source.sourceIdentity !== object.sourceIdentity
                  || !r.source.neteaseObjectTarget || !objectTarget || !neteaseObjectTarget(target) ? 'vendor.identity' : 'vendor.multipart');
        } else if (r.vendorDigest) {
          const digest = r.vendorDigest;
          // 每个206都先核同一完整对象标签；不把裸标签伪装为RFC strong ETag或发送条件头。
          if (etag !== digest.rawEtag || r.source.contentDigest?.value !== digest.value
            || r.source.sourceIdentity !== digest.sourceIdentity || r.source.size !== digest.size
            || /^multipart\//iu.test(response.headers.get('content-type') ?? '')) return sourceChanged(() =>
              etag !== digest.rawEtag ? 'vendor.etag' : r.source.contentDigest?.value !== digest.value ? 'vendor.digest'
                : r.source.sourceIdentity !== digest.sourceIdentity ? 'vendor.identity' : r.source.size !== digest.size ? 'vendor.size' : 'vendor.multipart');
        } else if (r.dateValidator) {
          if (etag !== r.dateValidator.rawEtag || response.headers.get('last-modified') !== r.dateValidator.lastModified
            || typeof dateValidator(response, etag, clock()) === 'string') return dateChanged('etag-date.changed');
        } else {
          if (!etag) return unsupported('etag-missing');
          if (etag.startsWith('W/')) return unsupported('etag-weak');
          if (etag.length > 256 || !strongEntityTag.test(etag)) {
            const reason = invalidEtagReason(etag);
            if (r.etag !== null || reason === 'etag-invalid.overlimit' || reason === 'etag-invalid.malformedquoted') return unsupported(reason,
              undefined, undefined, r.etag !== null ? 'after-strong' : undefined);
            const identity = { etag, ...(r.source.diagnosticMediaMd5 === undefined ? {} : { expectedMd5: r.source.diagnosticMediaMd5 }) };
            if (reason === 'etag-invalid.bare32hex') {
              const digest = r.source.contentDigest;
              // 正式API事实与诊断输入分离；缺失或不匹配时不借日期回退。
              if (!digest || etag.toLowerCase() !== digest.value || /^multipart\//iu.test(response.headers.get('content-type') ?? '')) return unsupported(reason, response, identity);
              r.vendorDigest = Object.freeze({ rawEtag: etag, value: digest.value, sourceIdentity: r.source.sourceIdentity, size: r.source.size });
            } else {
              if (/^[a-fA-F0-9]{32}-/u.test(etag)) {
                const digest = r.source.contentDigest;
                if (!neteaseObjectTag.test(etag) || !digest || !r.source.neteaseObjectTarget || !objectTarget || !neteaseObjectTarget(target)
                  || /^multipart\//iu.test(response.headers.get('content-type') ?? '')) return unsupported(reason, response, identity, 'multipart-initial');
                // 前缀不解释为MD5；正式API摘要与完整对象tag分别保留，之后不能切换验证模式。
                r.neteaseObject = Object.freeze({ rawEtag: etag, value: digest.value, sourceIdentity: r.source.sourceIdentity, size: r.source.size });
              } else {
                const candidate = dateValidator(response, etag, clock());
                if (typeof candidate === 'string') return unsupported(candidate, response, identity);
                r.dateValidator = candidate;
              }
            }
          } else {
            if (r.etag !== null && etag !== r.etag) return sourceChanged(() => 'strong-etag-changed');
            if (r.etag === null) r.etag = etag;
          }
        }
        const out = new Uint8Array(length); let at = 0;
        while (true) {
          controller.signal.throwIfAborted();
          const part = await reader.read(); controller.signal.throwIfAborted();
          if (part.done) { complete = true; break; }
          const value = part.value;
          if (!(value instanceof Uint8Array) || !(value.buffer instanceof ArrayBuffer) || value.byteLength === 0
            || value.byteLength > length - at) return sourceChanged(() => 'body.chunk');
          out.set(value, at); at += value.byteLength;
        }
        if (at !== length) return sourceChanged(() => 'body.length');
        await current(r, controller.signal); return out;
      } finally {
        if (reader) {
          try { if (!complete) await reader.cancel(); }
          catch { throw nonquiet(r); }
          finally { reader.releaseLock(); }
        }
      }
    })());
    if (read) read.flights.add(raw);
    // Listener/timer 只随实际 I/O 完成移除；超时后的真实 flight 仍绑定原 record/readId。
    void raw.finally(() => {
      if (timer) clearTimeout(timer); if (onAbort) controller.signal.removeEventListener('abort', onAbort);
      signal.removeEventListener('abort', abort); r.controller.signal.removeEventListener('abort', abort); read?.flights.delete(raw);
    }).catch(() => undefined);
    return Promise.race([raw, refusal]);
  }
  function make(scopeRaw: MobileNeteaseScope, sourceRaw: MobileNeteaseHttpSource, kind: LeaseRecord['kind'], selection: Readonly<MobileTrackSelection> | null): LeaseRecord {
    ready(); const scope = captureMobileNeteaseScope(scopeRaw), source = captureSource(sourceRaw);
    assertMobileNeteaseAccount(scope, source.account);
    if (count(kind) >= (kind === 'probe' ? MAX_PROBES : MAX_LEASES)) return mobileResourceCapacityFailure(kind === 'probe' ? 'capacity.http.probes-full' : 'capacity.http.leases-full', () => fail(429, 'RESOURCE_BUSY'));
    const born = clock(), expires = Math.min(source.expiresAtMs, born + LEASE_MS);
    if (expires <= born) return fail(410, 'RESOURCE_EXPIRED');
    const r: LeaseRecord = { id: randomUUID(), kind, scope, source, selection, born, expires, etag: null, dateValidator: null, vendorDigest: null, neteaseObject: null, observed: null,
      controller: new AbortController(), pending: new Set(), readers: new Map(), closing: null, released: false, failure: null };
    records.add(r); return r;
  }
  async function observe(r: LeaseRecord, signal: AbortSignal): Promise<Readonly<MobileNeteaseObservedAudio>> {
    let facts: Readonly<MobileNeteaseObservedAudio>;
    try { facts = await readMobileNeteaseAudioFacts(r.source.size, (p, n, s) => boundedRange(r, p, n, s), signal); }
    catch (error) {
      if (error instanceof MobileServiceError && error.code === 'UNSUPPORTED_FORMAT') diagnose('parser', error);
      throw error;
    }
    // 与头部独立的远端单字节 Range；不是由首请求成功或非零长度推导 seek。
    await boundedRange(r, r.source.size - 1, 1, signal); await current(r, signal);
    r.observed = facts; return facts;
  }
  function closeReader(r: LeaseRecord, reader: Reader): Promise<void> {
    if (reader.closing) return reader.closing;
    reader.closed = true; reader.controller.abort();
    const work = (async () => { if (reader.pending) await Promise.allSettled([reader.pending]);
      while (reader.flights.size) await Promise.allSettled([...reader.flights]); if (r.failure) throw r.failure; })();
    reader.closing = quiet(r, work).catch(() => { throw nonquiet(r); }); return reader.closing;
  }
  function release(r: LeaseRecord): Promise<void> {
    if (r.closing) return r.closing; if (r.released) return Promise.resolve();
    r.controller.abort();
    const work = (async () => {
      await Promise.all([...r.readers.values()].map(reader => closeReader(r, reader)));
      while (r.pending.size) await Promise.allSettled([...r.pending]);
      if (r.failure) throw r.failure;
      r.released = true; records.delete(r);
    })();
    r.closing = quiet(r, work).catch(() => { throw nonquiet(r); }); return r.closing;
  }
  function readRecord(r: LeaseRecord, readId: string): Reader {
    if (!uuid(readId)) return fail(400, 'INVALID_REQUEST');
    const owner = readerOwners.get(readId); if (owner && owner !== r) return fail(404, 'INVALID_REQUEST');
    const existing = r.readers.get(readId); if (existing) { if (existing.closed) return fail(410, 'RESOURCE_RELEASED'); return existing; }
    const active = [...records].reduce((n, ownerRecord) => n + [...ownerRecord.readers.values()].filter(reader => !reader.closed).length, 0);
    if (readerOwners.size >= MAX_READ_IDS) return mobileResourceCapacityFailure('capacity.http.read-ids-full', () => fail(429, 'RESOURCE_BUSY'));
    if (active >= MAX_READERS) return mobileResourceCapacityFailure('capacity.http.readers-full', () => fail(429, 'RESOURCE_BUSY'));
    if ([...r.readers.values()].filter(reader => !reader.closed).length >= MAX_RESOURCE_READERS) return mobileResourceCapacityFailure('capacity.http.resource-readers-full', () => fail(429, 'RESOURCE_BUSY'));
    const reader: Reader = { id: readId, controller: new AbortController(), pending: null, flights: new Set(), closed: false, closing: null };
    readerOwners.set(readId, r); r.readers.set(readId, reader); return reader;
  }
  function leaseObject(r: LeaseRecord): MobileNeteaseStreamLease {
    const selection = r.selection!;
    const lease = {
      account: r.source.account, selection, sourceIdentity: r.source.sourceIdentity, size: r.source.size, expiresAtMs: r.expires, rangeSupported: true,
      async verify(signal: AbortSignal): Promise<void> { await current(r, signal); await boundedRange(r, 0, 1, signal); await current(r, signal); },
      async renew(signal: AbortSignal): Promise<Readonly<{ expiresAtMs: number }>> {
        await current(r, signal);
        const fresh = captureSource(await refresh(r.scope, selection, signal)); await current(r, signal);
        assertMobileNeteaseAccount(r.scope, fresh.account);
        if (canonical(fresh.account) !== canonical(r.source.account) || fresh.sourceIdentity !== r.source.sourceIdentity
          || fresh.size !== r.source.size || r.vendorDigest && fresh.contentDigest?.value !== r.vendorDigest.value
          || r.neteaseObject && (fresh.contentDigest?.value !== r.neteaseObject.value || !fresh.neteaseObjectTarget)) return fail(409, 'SOURCE_CHANGED');
        // 新URL允许更新；原强ETag、独立强日期或专属内容指纹围栏及实际音频头必须保持。
        const before = r.source; r.source = fresh;
        try {
          const facts = await observe(r, signal);
          if (!r.observed || canonical(facts) !== canonical(originalObserved)) return fail(409, 'SOURCE_CHANGED');
          const next = Math.min(fresh.expiresAtMs, clock() + LEASE_MS, r.born + MAX_LIFETIME_MS);
          if (next <= clock()) return fail(410, 'RESOURCE_EXPIRED');
          await current(r, signal); r.expires = next;
          // 初始准入描述符保持不可变；renew返回新真实期限，避免并发read把续租认成身份变异。
          return Object.freeze({ expiresAtMs: next });
        } catch (error) { r.source = before; throw error; }
      },
      async read(readId: string, start: number, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
        await current(r, signal); const reader = readRecord(r, readId);
        if (reader.pending) return mobileResourceCapacityFailure('capacity.http.read-pending', () => fail(429, 'RESOURCE_BUSY'));
        const abort = () => reader.controller.abort(); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
        const work = boundedRange(r, start, maxBytes, reader.controller.signal, reader); reader.pending = work;
        try { const value = await work; signal.throwIfAborted(); if (reader.closed || reader.controller.signal.aborted) return fail(410, 'RESOURCE_RELEASED'); await current(r, signal); return value; }
        finally { reader.pending = null; signal.removeEventListener('abort', abort); }
      },
      closeRead(readId: string): Promise<void> {
        if (!uuid(readId)) return Promise.reject(new MobileServiceError(400, 'INVALID_REQUEST'));
        const owner = readerOwners.get(readId); if (owner && owner !== r) return Promise.reject(new MobileServiceError(404, 'INVALID_REQUEST'));
        const reader = r.readers.get(readId); if (reader) return closeReader(r, reader);
        if (readerOwners.size >= MAX_READ_IDS) {
          try { return mobileResourceCapacityFailure('capacity.http.read-ids-full', () => { throw new MobileServiceError(429, 'RESOURCE_BUSY', true, 1000); }); }
          catch (error) { return Promise.reject(error); }
        }
        const tombstone: Reader = { id: readId, controller: new AbortController(), pending: null, flights: new Set(), closed: true, closing: Promise.resolve() };
        r.readers.set(readId, tombstone); readerOwners.set(readId, r); return Promise.resolve();
      },
      release: () => release(r),
    };
    const originalObserved = r.observed!;
    for (const key of Object.keys(lease)) Object.defineProperty(lease, key, { writable: false, configurable: false });
    return Object.seal(lease);
  }
  return {
    get qualified() { return !closed && !fatal; },
    async probe(scope, source, signal) { const r = make(scope, source, 'probe', null);
      try { return await observe(r, signal); } finally { await release(r); } },
    async openFromSource(scope, source, selectionRaw, signal) {
      const selection = captureMobileNeteaseSelection(selectionRaw), r = make(scope, source, 'lease', selection);
      try { const observed = await observe(r, signal); return { lease: leaseObject(r), observed }; }
      catch (error) { await release(r); throw error; }
    },
    invalidateAccount() { for (const r of records) { r.controller.abort(); void release(r).catch(() => undefined); } },
    close() {
      if (closeOperation) return closeOperation; closed = true;
      closeOperation = Promise.all([...records].map(r => release(r))).then(() => { if (fatal) return fail(503, 'BUSY'); });
      return closeOperation;
    },
    snapshot() { return Object.freeze({ leases: count('lease'), probes: count('probe'),
      readers: [...records].reduce((n, r) => n + [...r.readers.values()].filter(reader => !reader.closed).length, 0),
      pending: [...records].reduce((n, r) => n + r.pending.size, 0), fatal }); },
  };
}
