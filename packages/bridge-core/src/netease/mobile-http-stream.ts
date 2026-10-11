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

/** 仅在同一 Core 内部传递。这里没有 Cookie、公共 URL 或 Roon 确认能力。 */
export interface MobileNeteaseHttpSource {
  account: Readonly<MobileNeteaseAccount>;
  sourceIdentity: string;
  size: number;
  expiresAtMs: number;
  upstreamUrl: string;
  requestHeaders: Readonly<Record<string, string>>;
}
export interface MobileNeteaseHttpStreamsOptions {
  assertCurrent: MobileNeteaseFence;
  refresh(scope: MobileNeteaseScope, selection: Readonly<MobileTrackSelection>, signal: AbortSignal): Promise<MobileNeteaseHttpSource>;
  now?: () => number;
  /** 合成测试可注入只读 transport；生产缺省使用原 public-DNS/HTTPS/redirect 策略。 */
  fetch?: GatewayFetch;
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
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/u.test(v);
const fail = (status: 400 | 401 | 403 | 404 | 409 | 410 | 429 | 503, code: MobileSafeErrorFacts['code']): never => {
  throw new MobileServiceError(status, code, status === 429 || status === 503, status === 429 || status === 503 ? 1000 : undefined);
};
function freeze<T>(v: T): T { if (v && typeof v === 'object') { for (const child of Object.values(v)) freeze(child); Object.freeze(v); } return v; }
function canonical(value: unknown): string { const c = mobileDataSnapshot(value); if (!c.ok) return fail(409, 'SOURCE_CHANGED'); return mobileCanonicalJson(c.value); }
function captureSource(raw: MobileNeteaseHttpSource): Readonly<MobileNeteaseHttpSource> {
  const c = mobileDataSnapshot(raw);
  if (!c.ok || !mobileRecord(c.value)) return fail(409, 'SOURCE_CHANGED');
  const v = c.value;
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
  return freeze({ account, sourceIdentity: v.sourceIdentity, size: v.size, expiresAtMs: v.expiresAtMs,
    upstreamUrl, requestHeaders: { ...headers } as Record<string,string> });
}
interface Reader {
  id: string; controller: AbortController; pending: Promise<Uint8Array> | null; flights: Set<Promise<unknown>>; closed: boolean; closing: Promise<void> | null;
}
interface LeaseRecord {
  id: string; kind: 'probe' | 'lease'; scope: MobileNeteaseScope; source: Readonly<MobileNeteaseHttpSource>;
  selection: Readonly<MobileTrackSelection> | null; controller: AbortController; born: number; expires: number;
  etag: string | null; observed: Readonly<MobileNeteaseObservedAudio> | null;
  pending: Set<Promise<unknown>>; readers: Map<string, Reader>; closing: Promise<void> | null; released: boolean;
  failure: MobileServiceError | null;
}

/** 独立手机网络租约；不下载整曲、不建立文件池、不借用旧 loopback/Roon registry。 */
export function createMobileNeteaseHttpStreams(options: MobileNeteaseHttpStreamsOptions): MobileNeteaseHttpStreams {
  const now = options.now ?? Date.now, fence = options.assertCurrent, refresh = options.refresh;
  const injectedTransport = options.fetch !== undefined, transport = options.fetch ?? fetch;
  const records = new Set<LeaseRecord>(), readerOwners = new Map<string, LeaseRecord>();
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
  async function fetchRange(r: LeaseRecord, init: RequestInit): Promise<Response> {
    // 生产沿原 HTTPS/public-DNS 和五次重定向准入，但不能吞掉中间 body 的关闭失败。
    // 测试 transport 只代替实际网络，不代替下面的 Range/身份/quiet 验证。
    let url = r.source.upstreamUrl;
    for (let redirects = 0; redirects <= 5; redirects++) {
      init.signal?.throwIfAborted();
      const target = injectedTransport ? assertSafeAudioUrl(url) : (await assertPublicHttpsUrl(url)).toString();
      const response = await transport(target, { ...init, redirect: 'manual' });
      if (![301,302,303,307,308].includes(response.status)) return response;
      const location = response.headers.get('location');
      if (response.body) { try { await response.body.cancel(); } catch { throw nonquiet(r); } }
      if (!location || redirects === 5) return fail(409, 'UNSUPPORTED_FORMAT');
      try { url = assertSafeAudioUrl(new URL(location, target).toString()); }
      catch { return fail(409, 'UNSUPPORTED_FORMAT'); }
    }
    return fail(409, 'UNSUPPORTED_FORMAT');
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
        const response = await fetchRange(r, { method: 'GET', redirect: 'manual', signal: controller.signal,
          headers: { ...r.source.requestHeaders, Range: `bytes=${start}-${start + length - 1}`, ...(r.etag ? { 'If-Match': r.etag } : {}) } });
        // 即便 transport 忽略 abort 迟到返回，也先取得原 body 的清理所有权。
        if (response.body) reader = response.body.getReader();
        controller.signal.throwIfAborted(); await current(r, controller.signal);
        if (response.status === 401 || response.status === 403) return fail(403, 'RESOURCE_REVOKED');
        if (response.status !== 206 || !reader) return fail(409, 'UNSUPPORTED_FORMAT');
        const range = response.headers.get('content-range'), declared = response.headers.get('content-length');
        if (range !== `bytes ${start}-${start + length - 1}/${r.source.size}` || declared !== String(length)
          || ![null, 'identity'].includes(response.headers.get('content-encoding'))) return fail(409, 'SOURCE_CHANGED');
        // 强验证器来自本次实际 HTTP，不能由 Provider 的 size/URL 或文件名推导。
        const etag = response.headers.get('etag');
        if (!etag || etag.length > 256 || !/^"[^"\u0000-\u001f\u007f]+"(?![\s\S])/u.test(etag)) return fail(409, 'UNSUPPORTED_FORMAT');
        if (r.etag !== null && etag !== r.etag) return fail(409, 'SOURCE_CHANGED');
        if (r.etag === null) r.etag = etag;
        const out = new Uint8Array(length); let at = 0;
        while (true) {
          controller.signal.throwIfAborted();
          const part = await reader.read(); controller.signal.throwIfAborted();
          if (part.done) { complete = true; break; }
          const value = part.value;
          if (!(value instanceof Uint8Array) || !(value.buffer instanceof ArrayBuffer) || value.byteLength === 0
            || value.byteLength > length - at) return fail(409, 'SOURCE_CHANGED');
          out.set(value, at); at += value.byteLength;
        }
        if (at !== length) return fail(409, 'SOURCE_CHANGED');
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
    if (count(kind) >= (kind === 'probe' ? MAX_PROBES : MAX_LEASES)) return fail(429, 'RESOURCE_BUSY');
    const born = clock(), expires = Math.min(source.expiresAtMs, born + LEASE_MS);
    if (expires <= born) return fail(410, 'RESOURCE_EXPIRED');
    const r: LeaseRecord = { id: randomUUID(), kind, scope, source, selection, born, expires, etag: null, observed: null,
      controller: new AbortController(), pending: new Set(), readers: new Map(), closing: null, released: false, failure: null };
    records.add(r); return r;
  }
  async function observe(r: LeaseRecord, signal: AbortSignal): Promise<Readonly<MobileNeteaseObservedAudio>> {
    const facts = await readMobileNeteaseAudioFacts(r.source.size, (p, n, s) => boundedRange(r, p, n, s), signal);
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
    if (readerOwners.size >= MAX_READ_IDS || active >= MAX_READERS || [...r.readers.values()].filter(reader => !reader.closed).length >= MAX_RESOURCE_READERS) return fail(429, 'RESOURCE_BUSY');
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
          || fresh.size !== r.source.size) return fail(409, 'SOURCE_CHANGED');
        // 新 URL 允许更新，但原强 ETag 与同一个实际音频头必须保持。
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
        if (reader.pending) return fail(429, 'RESOURCE_BUSY');
        const abort = () => reader.controller.abort(); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
        const work = boundedRange(r, start, maxBytes, reader.controller.signal, reader); reader.pending = work;
        try { const value = await work; signal.throwIfAborted(); if (reader.closed || reader.controller.signal.aborted) return fail(410, 'RESOURCE_RELEASED'); await current(r, signal); return value; }
        finally { reader.pending = null; signal.removeEventListener('abort', abort); }
      },
      closeRead(readId: string): Promise<void> {
        if (!uuid(readId)) return Promise.reject(new MobileServiceError(400, 'INVALID_REQUEST'));
        const owner = readerOwners.get(readId); if (owner && owner !== r) return Promise.reject(new MobileServiceError(404, 'INVALID_REQUEST'));
        const reader = r.readers.get(readId); if (reader) return closeReader(r, reader);
        if (readerOwners.size >= MAX_READ_IDS) return Promise.reject(new MobileServiceError(429, 'RESOURCE_BUSY', true, 1000));
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
