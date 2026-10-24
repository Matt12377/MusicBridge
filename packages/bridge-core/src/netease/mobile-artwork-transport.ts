import { Resolver } from 'node:dns/promises';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import type { GatewayFetch } from '../stream/upstream-policy.js';
import { MobileServiceError } from '../mobile/types.js';
import { captureMobileCapabilityContext, mobileCapabilityReject, type MobileCapabilityStage } from '../mobile/capability-trace.js';

const unavailable = () => new MobileServiceError(503, 'BUSY', true, 1000);
const MAX_BYTES = 4 * 1024 * 1024;
type TransportFailure = 'dns-failure' | 'dns-answer' | 'dns-address' | 'dns-empty' | 'http-status'
  | 'tls' | 'connection' | 'body' | 'headers' | 'request';
/** 仅旁注原失败的闭集阶段；不输出地址、响应头或底层错误文本。 */
function transportFailure(stage: TransportFailure, error = unavailable()): MobileServiceError {
  try {
    const context = captureMobileCapabilityContext();
    if (context?.privateContentDiagnostic === true && !context.closed && !context.firstBusiness)
      mobileCapabilityReject(`provider.artwork.transport.${stage}` as MobileCapabilityStage, error);
  } catch { /* 诊断失败不替换原传输错误。 */ }
  return error;
}
export interface MobileArtworkResolver {
  resolve4(host: string): Promise<string[]>;
  resolve6(host: string): Promise<string[]>;
  cancel(): void;
}
/** 只替换原生叶供合成验证；生产仍走相同解析、地址筛选及固定连接路径。 */
export interface MobileArtworkTransportLeaves {
  resolver?(): MobileArtworkResolver;
  request?(options: RequestOptions, respond: (message: IncomingMessage) => void): ClientRequest;
}

/** 对图片使用保守公网集合；映射/过渡IPv6不作为绕过IPv4检查的入口。 */
export function mobileArtworkPublicAddress(address: string, family: 4 | 6): boolean {
  if (typeof address !== 'string' || address.length > 64 || isIP(address) !== family) return false;
  if (family === 4) {
    const [a = 0, b = 0, c = 0] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127
      || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31
      || a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2) || b === 88 && c === 99)
      || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  if (address.includes('.') || address.includes('%')) return false;
  const halves = address.toLowerCase().split('::');
  const left = halves[0] ? halves[0].split(':') : [], right = halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 1 ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  if (groups.length !== 8) return false;
  const first = Number.parseInt(groups[0]!, 16), second = Number.parseInt(groups[1]!, 16);
  return first >= 0x2000 && first < 0x3ffe && first !== 0x2002
    && !(first === 0x2001 && (second < 0x0200 || second === 0x0db8));
}

async function resolveAddress(host: string, signal: AbortSignal, create: () => MobileArtworkResolver) {
  signal.throwIfAborted();
  const resolver = create(), abort = () => { try { resolver.cancel(); } catch { /* 取消仍由原signal决定。 */ } };
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) abort();
    const result = await Promise.allSettled([
      Promise.resolve().then(() => { signal.throwIfAborted(); return resolver.resolve4(host); }),
      Promise.resolve().then(() => { signal.throwIfAborted(); return resolver.resolve6(host); }),
    ]);
    signal.throwIfAborted();
    const addresses: Array<{ address: string; family: 4 | 6 }> = [];
    for (const [index, answer] of result.entries()) {
      if (answer.status === 'rejected') {
        const code = answer.reason && typeof answer.reason === 'object' ? Object.getOwnPropertyDescriptor(answer.reason, 'code')?.value : undefined;
        if (code !== 'ENODATA' && code !== 'ENOTFOUND') throw transportFailure('dns-failure');
        continue;
      }
      if (!Array.isArray(answer.value) || answer.value.length > 32) throw transportFailure('dns-answer');
      const family = index === 0 ? 4 : 6;
      for (const address of answer.value) {
        if (!mobileArtworkPublicAddress(address, family)) throw transportFailure('dns-address');
        addresses.push({ address, family });
      }
    }
    if (!addresses.length) throw transportFailure('dns-empty');
    return addresses[0]!;
  } finally { signal.removeEventListener('abort', abort); abort(); }
}

function pinnedResponse(url: URL, address: { address: string; family: 4 | 6 }, signal: AbortSignal,
  request: NonNullable<MobileArtworkTransportLeaves['request']>): Promise<Response> {
  signal.throwIfAborted();
  return new Promise<Response>((resolve, reject) => {
    let outgoing: ClientRequest | undefined, incoming: IncomingMessage | undefined, responded = false;
    let failureStage: TransportFailure = 'connection';
    let markRequestClosed!: () => void, markResponseClosed: (() => void) | undefined;
    const requestClosed = new Promise<void>(done => { markRequestClosed = done; });
    let responseClosed = Promise.resolve();
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { incoming?.destroy(unavailable()); outgoing?.destroy(unavailable()); };
    const quiet = async () => { await requestClosed; await responseClosed; cleanup(); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      outgoing = request({ protocol: 'https:', hostname: address.address, family: address.family, port: 443,
        path: url.pathname + url.search, method: 'GET', agent: false,
        servername: url.hostname, rejectUnauthorized: true,
        checkServerIdentity: (_host, certificate) => checkServerIdentity(url.hostname, certificate),
        headers: { Host: url.hostname, Accept: 'image/jpeg,image/png', 'Accept-Encoding': 'identity' },
        maxHeaderSize: 16 * 1024,
      }, message => {
        incoming = message;
        responseClosed = new Promise<void>(done => { markResponseClosed = done; });
        message.once('close', () => markResponseClosed?.());
        message.on('error', () => {}); // 实际失败由异步迭代器及close收口，不把原错误写入日志。
        const status = message.statusCode ?? 0;
        if (![200,301,302,303,307,308,404].includes(status) || signal.aborted) {
          if (!signal.aborted) failureStage = 'http-status'; abort(); return;
        }
        try {
          const headers = new Headers();
          for (let index = 0; index < message.rawHeaders.length; index += 2) headers.append(message.rawHeaders[index]!, message.rawHeaders[index + 1]!);
          const iterator = message[Symbol.asyncIterator](); let bytes = 0;
          const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const item = await iterator.next(); signal.throwIfAborted();
                if (item.done) { await quiet(); controller.close(); return; }
                if (!(item.value instanceof Uint8Array)) throw unavailable();
                bytes += item.value.byteLength;
                if (bytes > MAX_BYTES) throw new MobileServiceError(413, 'CONTENT_LIMIT_EXCEEDED');
                controller.enqueue(Uint8Array.from(item.value));
              } catch (error) {
                abort(); await quiet();
                controller.error(transportFailure('body', error instanceof MobileServiceError ? error : unavailable()));
              }
            },
            async cancel() { abort(); await quiet(); },
          });
          const result = new Response(body, { status, headers }); responded = true; resolve(result);
        } catch { failureStage = 'headers'; abort(); }
      });
      outgoing.maxHeadersCount = 64;
      outgoing.on('error', error => {
        const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
        if (['ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT',
          'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_NOT_YET_VALID',
          'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(code)) failureStage = 'tls';
        incoming?.destroy(unavailable());
      });
      outgoing.once('close', () => {
        markRequestClosed();
        if (!responded) void quiet().then(() => reject(transportFailure(failureStage)));
      });
      if (signal.aborted) abort(); else outgoing.end();
    } catch {
      if (outgoing) { outgoing.destroy(); void quiet().then(() => reject(transportFailure('request'))); }
      else { markRequestClosed(); cleanup(); reject(transportFailure('request')); }
    }
  });
}

/** 每跳只连接刚验证的地址字面量；TLS仍验证原CDN主机，不触发第二次DNS或复用旧socket。 */
export function createMobileArtworkFetch(leaves: MobileArtworkTransportLeaves = {}): GatewayFetch {
  return async (raw, init) => {
    const signal = init.signal;
    if (!signal || init.method !== 'GET' || init.redirect !== 'manual' || init.credentials !== 'omit') throw unavailable();
    const url = new URL(raw), host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port && url.port !== '443'
      || host !== 'music.126.net' && !host.endsWith('.music.126.net')) throw unavailable();
    try {
      const address = await resolveAddress(host, signal, leaves.resolver ?? (() => new Resolver()));
      signal.throwIfAborted();
      return await pinnedResponse(url, address, signal, leaves.request ?? httpsRequest);
    } catch (error) { throw error instanceof MobileServiceError ? error : unavailable(); }
  };
}
