import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { isMobileId } from '@music-bridge/contracts';
import type { GatewayFetch } from '../stream/upstream-policy.js';
import { createMobileArtworkFetch } from './mobile-artwork-transport.js';
import { MobileServiceError } from '../mobile/types.js';
import type { MobileNeteaseScope } from '../mobile/netease-source-types.js';
import { captureMobileCapabilityContext, mobileCapabilityReject, type MobileCapabilityStage } from '../mobile/capability-trace.js';

export const MOBILE_NETEASE_ARTWORK_MAX_BYTES = 4 * 1024 * 1024;
export type MobileNeteaseArtworkKind = 'a' | 's' | 'p' | 'r';
export interface MobileNeteaseArtworkData { artworkId: string; revision: string; contentType: 'image/png' | 'image/jpeg'; bytes: Uint8Array }
const unavailable = () => new MobileServiceError(503, 'BUSY', true, 1000);
const changed = () => new MobileServiceError(409, 'SOURCE_CHANGED');
const missing = () => new MobileServiceError(404, 'RESOURCE_REVOKED');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const limited = () => new MobileServiceError(413, 'CONTENT_LIMIT_EXCEEDED');

/** 只接受既有网易云图片域；HTTP仅按原图片策略升级，绝不接收手机自报URL。 */
export function mobileNeteaseArtworkURL(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 2048) return null;
  try {
    const url = new URL(raw), host = url.hostname.toLowerCase();
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash
      || host !== 'music.126.net' && !host.endsWith('.music.126.net')
      || url.port && url.port !== (url.protocol === 'http:' ? '80' : '443')) return null;
    url.protocol = 'https:'; url.port = ''; return url.href;
  } catch { return null; }
}
/** 仅有限图片主机共享逻辑身份；只排除下载必定替换的param，其余路径和查询逐字保留。 */
function artworkIdentityDigest(url: string): string {
  const identity = new URL(url);
  if (/^p[1-9]\.music\.126\.net$/u.test(identity.hostname)) identity.hostname = 'p1.music.126.net';
  const retained = retainedThumbnailQuery(identity);
  // 单个空查询项在实际缩图请求中保留为开头的&，不能与完全无查询合并。
  identity.search = retained.length === 1 && retained[0] === '' ? '?' : retained.join('&');
  return hash(identity.href);
}
/** 逻辑封面身份不含短期授权MAC；只在Core内参与目录修订。 */
export function mobileNeteaseArtworkIdentity(raw: unknown): string | null {
  const url = mobileNeteaseArtworkURL(raw); return url === null ? null : artworkIdentityDigest(url);
}
/** 身份核验后只取512px缩图；其余查询逐字保留，每个合法CDN跳转都重新固定尺寸。 */
function retainedThumbnailQuery(url: URL): string[] {
  const query = url.search ? url.search.slice(1).split('&') : [];
  return query.filter(part => {
    const name = part.split('=', 1)[0]!.replace(/\+/gu, ' ');
    try { return decodeURIComponent(name) !== 'param'; } catch { return true; }
  });
}
function thumbnailRequestURL(raw: string): string {
  const url = new URL(raw);
  url.search = [...retainedThumbnailQuery(url), 'param=512y512'].join('&');
  return url.href;
}
/** 图片标识只含有界来源身份与MAC；URL、header和凭据始终留在Core。 */
export function createMobileNeteaseArtwork(options: {
  key: Uint8Array; serverId: string; datasetId: string; ownerEpoch: string; namespace: string;
  /** 仅合成transport测试注入；生产逐跳执行公网DNS及CDN验证。 */
  fetch?: GatewayFetch;
}) {
  const key = Buffer.from(options.key), active = new Set<AbortController>();
  const fetchImage = options.fetch ?? createMobileArtworkFetch();
  let generation = 0, closed = false;
  const diagnosed = new WeakSet<object>();
  function reject(stage: MobileCapabilityStage, error: Error): never {
    try {
      const context = captureMobileCapabilityContext();
      if (context?.privateContentDiagnostic === true && !context.closed && !context.firstBusiness && !diagnosed.has(context)) {
        diagnosed.add(context); mobileCapabilityReject(stage, error);
      }
    } catch { /* 私有旁注失败不替换来源校验的原错误。 */ }
    throw error;
  }
  function rejectMagic(type: string | undefined, bytes: Uint8Array, png: boolean, jpeg: boolean): never {
    let stage: MobileCapabilityStage = 'provider.artwork.download.magic';
    try {
      const context = captureMobileCapabilityContext();
      if (context?.privateContentDiagnostic === true && !context.closed && !context.firstBusiness && !diagnosed.has(context)) {
        const mime = type === 'image/png' ? 'png' : type === 'image/jpeg' ? 'jpeg'
          : type === 'image/jpg' ? 'jpg' : type === 'application/octet-stream' ? 'octet' : undefined;
        if (mime !== undefined) {
          let signature: 'png' | 'jpeg-soi-final-eoi' | 'jpeg-soi-tail-zero' | 'jpeg-soi-tail-whitespace'
            | 'jpeg-soi-tail-other' | 'jpeg-soi-no-eoi' | 'webp' | 'other' = 'other';
          if (png) signature = 'png';
          else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
            signature = jpeg ? 'jpeg-soi-final-eoi' : 'jpeg-soi-no-eoi';
            if (!jpeg) {
              let zero = true, whitespace = true;
              // 只对既有拒绝字节作有界旁注；找到EOI不代表容器或图片结构有效。
              for (let at = bytes.byteLength - 1; at >= 3; at--) {
                const value = bytes[at]!;
                if (value === 0xd9 && bytes[at - 1] === 0xff) {
                  signature = zero ? 'jpeg-soi-tail-zero' : whitespace ? 'jpeg-soi-tail-whitespace' : 'jpeg-soi-tail-other';
                  break;
                }
                zero = zero && value === 0;
                whitespace = whitespace && (value === 0x09 || value === 0x0a || value === 0x0c || value === 0x0d || value === 0x20);
              }
            }
          } else if (bytes.byteLength >= 12 && bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70
            && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) signature = 'webp';
          stage = `provider.artwork.download.magic.${mime}.${signature}`;
        }
      }
    } catch { /* 私有分类失败保留原magic拒绝；不替换公开错误。 */ }
    return reject(stage, unavailable());
  }
  const mac = (scope: MobileNeteaseScope, kind: MobileNeteaseArtworkKind, item: string, digest: string) =>
    createHmac('sha256', key).update(JSON.stringify([options.serverId, options.datasetId, options.ownerEpoch,
      scope.accountDomain, scope.providerEpoch, generation, kind, item, digest])).digest('hex').slice(0, 32);
  const sameScope = (scope: MobileNeteaseScope) => scope.serverId === options.serverId && scope.datasetId === options.datasetId
    && scope.ownerEpoch === options.ownerEpoch && isMobileId(scope.accountDomain) && isMobileId(scope.providerEpoch);
  function material(scope: MobileNeteaseScope, artworkId: string) {
    if (!sameScope(scope)) return reject('provider.artwork.scope', changed());
    const parts = artworkId.split(':');
    if (closed || !isMobileId(artworkId) || parts.length !== 6 || parts[0] !== 'naw' || parts[1] !== options.namespace
      || !['a', 's', 'p', 'r'].includes(parts[2]!) || !/^[1-9][0-9]{0,31}$/u.test(parts[3]!)
      || !/^[a-f0-9]{64}$/u.test(parts[4]!) || !/^[a-f0-9]{32}$/u.test(parts[5]!)) return reject('provider.artwork.identity', missing());
    const kind = parts[2] as MobileNeteaseArtworkKind, item = parts[3]!, digest = parts[4]!;
    if (!timingSafeEqual(Buffer.from(parts[5]!, 'hex'), Buffer.from(mac(scope, kind, item, digest), 'hex'))) return reject('provider.artwork.signature', changed());
    return { kind, item, digest };
  }
  async function source(scope: MobileNeteaseScope, artworkId: string, signal: AbortSignal,
    resolve: (kind: MobileNeteaseArtworkKind, item: string, signal: AbortSignal) => Promise<unknown>) {
    const own = generation, binding = material(scope, artworkId);
    const url = mobileNeteaseArtworkURL(await resolve(binding.kind, binding.item, signal));
    signal.throwIfAborted();
    if (closed || own !== generation) return reject('provider.artwork.generation', changed());
    if (url === null) return reject('provider.artwork.url-missing', missing());
    if (artworkIdentityDigest(url) !== binding.digest && hash(url) !== binding.digest) {
      // material已验证原HMAC；兼容原URL或九主机旧签名，新规范化ID仅接受同缩图语义。
      const candidate = new URL(url);
      let hostAliasOnly = false;
      if (/^p[1-9]\.music\.126\.net$/u.test(candidate.hostname)) {
        for (let index = 1; index <= 9; index++) {
          candidate.hostname = `p${index}.music.126.net`;
          if (hash(candidate.href) === binding.digest) { hostAliasOnly = true; break; }
        }
      }
      if (!hostAliasOnly) return reject('provider.artwork.url-changed', changed());
    }
    return { url, own };
  }
  async function download(initial: string, signal: AbortSignal): Promise<{ contentType: 'image/png' | 'image/jpeg'; bytes: Uint8Array }> {
    let url = initial;
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (mobileNeteaseArtworkURL(url) !== url) return reject('provider.artwork.download.url', unavailable());
      url = thumbnailRequestURL(url);
      if (mobileNeteaseArtworkURL(url) !== url) return reject('provider.artwork.download.url', unavailable());
      signal.throwIfAborted();
      const response = await fetchImage(url, { method: 'GET', redirect: 'manual', credentials: 'omit', signal,
        headers: { Accept: 'image/jpeg,image/png', 'Accept-Encoding': 'identity' } }).catch(error => {
          return reject('provider.artwork.download.transport', error);
        });
      if (response.redirected || response.url && mobileNeteaseArtworkURL(response.url) !== url) {
        await response.body?.cancel().catch(() => undefined); return reject('provider.artwork.download.response-url', unavailable());
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location'); await response.body?.cancel().catch(() => undefined);
        if (!location || redirects === 3) return reject('provider.artwork.download.redirect', unavailable());
        const next = mobileNeteaseArtworkURL(new URL(location, url).href);
        if (!next) return reject('provider.artwork.download.redirect', unavailable()); url = next; continue;
      }
      if (response.status === 404) { await response.body?.cancel().catch(() => undefined); return reject('provider.artwork.download.status', missing()); }
      const rawType = response.headers.get('content-type');
      const type = rawType?.split(';')[0]?.trim().toLowerCase();
      const combinedType = rawType?.includes(',') === true;
      const acceptedType = !combinedType && (type === 'image/png' || type === 'image/jpeg'
        || type === 'image/jpg' || type === 'application/octet-stream');
      const typeCategory = combinedType ? 'combined' : !type ? 'missing' : type === 'image/webp' ? 'webp'
        : type === 'image/svg+xml' ? 'svg' : type === 'text/html' || type === 'application/xhtml+xml' ? 'html' : 'other';
      const encoding = response.headers.get('content-encoding');
      const length = response.headers.get('content-length');
      if (length !== null && /^[1-9][0-9]*$/u.test(length) && Number(length) > MOBILE_NETEASE_ARTWORK_MAX_BYTES) {
        await response.body?.cancel().catch(() => undefined); return reject('provider.artwork.download.limit', limited());
      }
      if (response.status !== 200 || !response.body || !acceptedType
        || encoding && encoding.toLowerCase() !== 'identity'
        || length !== null && !/^[1-9][0-9]*$/u.test(length)) {
        await response.body?.cancel().catch(() => undefined);
        const stage = response.status !== 200 ? 'status' : !response.body ? 'body'
          : !acceptedType ? `type.${typeCategory}` as const
            : encoding && encoding.toLowerCase() !== 'identity' ? 'encoding' : 'length';
        return reject(`provider.artwork.download.${stage}`, unavailable());
      }
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0, complete = false;
      try {
        for (;;) {
          signal.throwIfAborted(); const part = await reader.read();
          if (part.done) { complete = true; break; }
          if (!(part.value instanceof Uint8Array) || part.value.byteLength < 1) return reject('provider.artwork.download.chunk', unavailable());
          if (chunks.length >= 4096) return reject('provider.artwork.download.limit', limited());
          size += part.value.byteLength; if (size > MOBILE_NETEASE_ARTWORK_MAX_BYTES) return reject('provider.artwork.download.limit', limited());
          chunks.push(part.value);
        }
      } finally { if (!complete) await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      if (size < 8 || length !== null && size !== Number(length)) return reject('provider.artwork.download.length', unavailable());
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const png = [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v);
      const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[size - 2] === 0xff && bytes[size - 1] === 0xd9;
      // 声明已通过有限MIME白名单；实际格式仅按原PNG/JPEG字节签名归一，下游仍完整解码。
      const contentType = png ? 'image/png' : jpeg ? 'image/jpeg' : null;
      if (contentType === null) return rejectMagic(type, bytes, png, jpeg);
      return { contentType, bytes };
    }
    return reject('provider.artwork.download.redirect', unavailable());
  }
  async function read(scope: MobileNeteaseScope, artworkId: string, signal: AbortSignal,
    resolve: (kind: MobileNeteaseArtworkKind, item: string, signal: AbortSignal) => Promise<unknown>): Promise<MobileNeteaseArtworkData> {
      if (active.size >= 4) throw unavailable();
      const controller = new AbortController(), abort = () => controller.abort();
      active.add(controller); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
      try {
        const selected = await source(scope, artworkId, controller.signal, resolve), image = await download(selected.url, controller.signal);
        controller.signal.throwIfAborted(); if (closed || selected.own !== generation) return reject('provider.artwork.generation', changed());
        const digest = createHash('sha256').update(image.bytes).digest('hex');
        return { artworkId, revision: 'nar:' + hash(JSON.stringify([artworkId, digest])), ...image };
      } finally { active.delete(controller); signal.removeEventListener('abort', abort); }
  }
  return {
    bind(scope: MobileNeteaseScope, kind: MobileNeteaseArtworkKind, item: string, raw: unknown): string | undefined {
      const url = mobileNeteaseArtworkURL(raw);
      if (closed || !sameScope(scope) || !url || !/^[1-9][0-9]{0,31}$/u.test(item)) return undefined;
      const digest = artworkIdentityDigest(url); return `naw:${options.namespace}:${kind}:${item}:${digest}:${mac(scope, kind, item, digest)}`;
    },
    read,
    async assert(scope: MobileNeteaseScope, artworkId: string, signal: AbortSignal,
      resolve: (kind: MobileNeteaseArtworkKind, item: string, signal: AbortSignal) => Promise<unknown>) {
      // 不假定同URL的上游字节永远不变；发送前再读同一有界来源并比较原实际字节修订。
      return (await read(scope, artworkId, signal, resolve)).revision;
    },
    invalidate() { generation++; for (const controller of active) controller.abort(); },
    close() { closed = true; generation++; for (const controller of active) controller.abort(); key.fill(0); },
  };
}
