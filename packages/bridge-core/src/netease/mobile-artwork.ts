import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { isMobileId } from '@music-bridge/contracts';
import type { GatewayFetch } from '../stream/upstream-policy.js';
import { createMobileArtworkFetch } from './mobile-artwork-transport.js';
import { MobileServiceError } from '../mobile/types.js';
import type { MobileNeteaseScope } from '../mobile/netease-source-types.js';

export const MOBILE_NETEASE_ARTWORK_MAX_BYTES = 4 * 1024 * 1024;
export type MobileNeteaseArtworkKind = 'a' | 's' | 'p';
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
/** 图片标识只含有界来源身份与MAC；URL、header和凭据始终留在Core。 */
export function createMobileNeteaseArtwork(options: {
  key: Uint8Array; serverId: string; datasetId: string; ownerEpoch: string; namespace: string;
  /** 仅合成transport测试注入；生产逐跳执行公网DNS及CDN验证。 */
  fetch?: GatewayFetch;
}) {
  const key = Buffer.from(options.key), active = new Set<AbortController>();
  const fetchImage = options.fetch ?? createMobileArtworkFetch();
  let generation = 0, closed = false;
  const mac = (scope: MobileNeteaseScope, kind: MobileNeteaseArtworkKind, item: string, digest: string) =>
    createHmac('sha256', key).update(JSON.stringify([options.serverId, options.datasetId, options.ownerEpoch,
      scope.accountDomain, scope.providerEpoch, generation, kind, item, digest])).digest('hex').slice(0, 32);
  const sameScope = (scope: MobileNeteaseScope) => scope.serverId === options.serverId && scope.datasetId === options.datasetId
    && scope.ownerEpoch === options.ownerEpoch && isMobileId(scope.accountDomain) && isMobileId(scope.providerEpoch);
  function material(scope: MobileNeteaseScope, artworkId: string) {
    if (!sameScope(scope)) throw changed();
    const parts = artworkId.split(':');
    if (closed || !isMobileId(artworkId) || parts.length !== 6 || parts[0] !== 'naw' || parts[1] !== options.namespace
      || !['a', 's', 'p'].includes(parts[2]!) || !/^[1-9][0-9]{0,31}$/u.test(parts[3]!)
      || !/^[a-f0-9]{64}$/u.test(parts[4]!) || !/^[a-f0-9]{32}$/u.test(parts[5]!)) throw missing();
    const kind = parts[2] as MobileNeteaseArtworkKind, item = parts[3]!, digest = parts[4]!;
    if (!timingSafeEqual(Buffer.from(parts[5]!, 'hex'), Buffer.from(mac(scope, kind, item, digest), 'hex'))) throw changed();
    return { kind, item, digest };
  }
  async function source(scope: MobileNeteaseScope, artworkId: string, signal: AbortSignal,
    resolve: (kind: MobileNeteaseArtworkKind, item: string, signal: AbortSignal) => Promise<unknown>) {
    const own = generation, binding = material(scope, artworkId);
    const url = mobileNeteaseArtworkURL(await resolve(binding.kind, binding.item, signal));
    signal.throwIfAborted();
    if (closed || own !== generation) throw changed();
    if (url === null) throw missing();
    if (hash(url) !== binding.digest) throw changed();
    return { url, own };
  }
  async function download(initial: string, signal: AbortSignal): Promise<{ contentType: 'image/png' | 'image/jpeg'; bytes: Uint8Array }> {
    let url = initial;
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (mobileNeteaseArtworkURL(url) !== url) throw unavailable();
      signal.throwIfAborted();
      const response = await fetchImage(url, { method: 'GET', redirect: 'manual', credentials: 'omit', signal,
        headers: { Accept: 'image/jpeg,image/png', 'Accept-Encoding': 'identity' } });
      if (response.redirected || response.url && mobileNeteaseArtworkURL(response.url) !== url) {
        await response.body?.cancel().catch(() => undefined); throw unavailable();
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location'); await response.body?.cancel().catch(() => undefined);
        if (!location || redirects === 3) throw unavailable();
        const next = mobileNeteaseArtworkURL(new URL(location, url).href);
        if (!next) throw unavailable(); url = next; continue;
      }
      if (response.status === 404) { await response.body?.cancel().catch(() => undefined); throw missing(); }
      const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      const encoding = response.headers.get('content-encoding');
      const length = response.headers.get('content-length');
      if (length !== null && /^[1-9][0-9]*$/u.test(length) && Number(length) > MOBILE_NETEASE_ARTWORK_MAX_BYTES) {
        await response.body?.cancel().catch(() => undefined); throw limited();
      }
      if (response.status !== 200 || !response.body || type !== 'image/png' && type !== 'image/jpeg'
        || encoding && encoding.toLowerCase() !== 'identity'
        || length !== null && !/^[1-9][0-9]*$/u.test(length)) {
        await response.body?.cancel().catch(() => undefined); throw unavailable();
      }
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0, complete = false;
      try {
        for (;;) {
          signal.throwIfAborted(); const part = await reader.read();
          if (part.done) { complete = true; break; }
          if (!(part.value instanceof Uint8Array) || part.value.byteLength < 1) throw unavailable();
          if (chunks.length >= 4096) throw limited();
          size += part.value.byteLength; if (size > MOBILE_NETEASE_ARTWORK_MAX_BYTES) throw limited();
          chunks.push(part.value);
        }
      } finally { if (!complete) await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      if (size < 8 || length !== null && size !== Number(length)) throw unavailable();
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const png = [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v);
      const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[size - 2] === 0xff && bytes[size - 1] === 0xd9;
      if (type === 'image/png' ? !png : !jpeg) throw unavailable();
      return { contentType: type, bytes };
    }
    throw unavailable();
  }
  async function read(scope: MobileNeteaseScope, artworkId: string, signal: AbortSignal,
    resolve: (kind: MobileNeteaseArtworkKind, item: string, signal: AbortSignal) => Promise<unknown>): Promise<MobileNeteaseArtworkData> {
      if (active.size >= 4) throw unavailable();
      const controller = new AbortController(), abort = () => controller.abort();
      active.add(controller); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
      try {
        const selected = await source(scope, artworkId, controller.signal, resolve), image = await download(selected.url, controller.signal);
        controller.signal.throwIfAborted(); if (closed || selected.own !== generation) throw changed();
        const digest = createHash('sha256').update(image.bytes).digest('hex');
        return { artworkId, revision: 'nar:' + hash(JSON.stringify([artworkId, digest])), ...image };
      } finally { active.delete(controller); signal.removeEventListener('abort', abort); }
  }
  return {
    bind(scope: MobileNeteaseScope, kind: MobileNeteaseArtworkKind, item: string, raw: unknown): string | undefined {
      const url = mobileNeteaseArtworkURL(raw);
      if (closed || !sameScope(scope) || !url || !/^[1-9][0-9]{0,31}$/u.test(item)) return undefined;
      const digest = hash(url); return `naw:${options.namespace}:${kind}:${item}:${digest}:${mac(scope, kind, item, digest)}`;
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
