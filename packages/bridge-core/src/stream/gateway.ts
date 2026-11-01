import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { asBridgeError, BridgeError } from '../shared/errors.js';
import { assertSafeAudioUrl } from '../netease/policy.js';
import type { ResolvedAudioStream } from '../netease/types.js';
import type { RoonGatewayStage } from '../roon/types.js';
import type { Logger } from '../shared/logger.js';
import type { StreamRegistry } from './registry.js';
import { secureGatewayFetch, type GatewayFetch } from './upstream-policy.js';
import { serveLocalFile, type LocalFileTransferEvidence } from './local-file-http.js';
import { isTrustedLocalMediaNetwork, type TrustedLocalMediaNetwork } from '../config/config.js';
import { RoonMediaListener, type TrustedRoonMediaPeer } from './roon-media-listener.js';

const FORWARDED_RESPONSE_HEADERS = [
  'accept-ranges',
  'content-length',
  'content-range',
  'content-type',
  'etag',
  'last-modified',
] as const;

const ICON_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="112" fill="#111"/>
  <path d="M122 322c74-16 100-62 100-138v-54l172-38v184c0 74-44 123-111 137-45 9-80-10-86-42-7-34 22-67 67-76 25-5 49-2 68 8V166l-55 12v48c0 75-44 123-111 137-45 9-80-10-86-42-7-34 22-67 67-76 27-6 52-2 75 10v-38c-10 57-44 92-100 105z" fill="#fff"/>
</svg>`;

const ICON_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const DEFAULT_PREFLIGHT_TIMEOUT_MS = 10_000;

export type MediaExtension =
  | 'mp3'
  | 'flac'
  | 'aac'
  | 'm4a'
  | 'ogg'
  | 'opus'
  | 'wav'
  | 'unknown';

type GatewayStageObserver = (stage: RoonGatewayStage) => void;
/** Core私有日志绑定，不改变公开命令、DTO或网关路由。 */
export interface LocalMediaDiagnosticBinding {
  diagnosticId: string;
  isCurrent(): boolean;
  isOwned(): boolean;
}
type GatewayObserverBinding = {
  stage?: GatewayStageObserver;
  localDiagnostic?: LocalMediaDiagnosticBinding;
  requestSequence: number;
  truncated: boolean;
};
type RangeClass = ReturnType<typeof classifyRange>;
const MAX_LOCAL_MEDIA_DIAGNOSTIC_REQUESTS=16;

function normalizeFormat(format: string | undefined): string {
  return format?.trim().toLowerCase().replace(/^\./, '') ?? '';
}

export function mediaExtensionForFormat(format: string | undefined): MediaExtension {
  switch (normalizeFormat(format)) {
    case 'mp3':
      return 'mp3';
    case 'flac':
      return 'flac';
    case 'aac':
      return 'aac';
    case 'm4a':
      return 'm4a';
    case 'ogg':
      return 'ogg';
    case 'opus':
      return 'opus';
    case 'wav':
      return 'wav';
    default:
      return 'unknown';
  }
}

function routeExtensionForFormat(format: string | undefined): string {
  const extension = mediaExtensionForFormat(format);
  return extension === 'unknown' ? 'bin' : extension;
}

function fallbackContentTypeForFormat(format: string | undefined): string | undefined {
  switch (mediaExtensionForFormat(format)) {
    case 'mp3':
      return 'audio/mpeg';
    case 'flac':
      return 'audio/flac';
    case 'aac':
      return 'audio/aac';
    case 'm4a':
      return 'audio/mp4';
    case 'ogg':
      return 'application/ogg';
    case 'opus':
      return 'audio/ogg';
    case 'wav':
      return 'audio/wav';
    case 'unknown':
      return undefined;
  }
}

type ContentTypeClass =
  | 'audio-mpeg'
  | 'audio-flac'
  | 'audio-aac'
  | 'audio-mp4'
  | 'audio-ogg'
  | 'audio-wav'
  | 'octet-stream'
  | 'missing'
  | 'other';

function contentTypeBase(value: string | null): string | undefined {
  if (value === null) return undefined;
  const base = value.split(';', 1)[0]?.trim().toLowerCase();
  return base || undefined;
}

function isGenericContentType(value: string | null): boolean {
  const base = contentTypeBase(value);
  return (
    base === undefined ||
    base === 'application/octet-stream' ||
    base === 'binary/octet-stream'
  );
}

function classifyContentType(value: string | null): ContentTypeClass {
  const base = contentTypeBase(value);
  switch (base) {
    case undefined:
      return 'missing';
    case 'audio/mpeg':
      return 'audio-mpeg';
    case 'audio/flac':
      return 'audio-flac';
    case 'audio/aac':
      return 'audio-aac';
    case 'audio/mp4':
    case 'audio/x-m4a':
      return 'audio-mp4';
    case 'audio/ogg':
    case 'application/ogg':
      return 'audio-ogg';
    case 'audio/wav':
    case 'audio/x-wav':
      return 'audio-wav';
    case 'application/octet-stream':
    case 'binary/octet-stream':
      return 'octet-stream';
    default:
      return 'other';
  }
}

function classifyRange(value: string | undefined):
  | 'none'
  | 'start-end'
  | 'start-open'
  | 'suffix'
  | 'other' {
  if (!value) return 'none';
  if (/^bytes=\d+-\d+$/.test(value)) return 'start-end';
  if (/^bytes=\d+-$/.test(value)) return 'start-open';
  if (/^bytes=-\d+$/.test(value)) return 'suffix';
  return 'other';
}

function readContentLength(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function preflightFailure(cause?: unknown, status?: number): BridgeError {
  return new BridgeError(
    'STREAM_UPSTREAM_FAILED',
    status === undefined
      ? 'UPSTREAM_HTTPS_UNAVAILABLE: HTTPS upstream preflight failed'
      : `UPSTREAM_HTTPS_UNAVAILABLE: HTTPS preflight returned HTTP ${status}`,
    {
      httpStatus: 502,
      ...(cause !== undefined ? { cause } : {}),
      details: {
        reason: 'UPSTREAM_HTTPS_UNAVAILABLE',
        ...(status !== undefined ? { status } : {}),
      },
    },
  );
}

function isExpiredUpstreamStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 404;
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': encoded.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(encoded);
}

export class StreamGateway {
  private server: Server | undefined;
  private localMediaServer: Server | undefined;
  private starting: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private localRequests = 0;
  private readonly stageObservers = new Map<string, GatewayObserverBinding>();
  private activeTimerCount = 0;
  private activeMediaReadCount = 0;
  private activePreflightOwnerListenerCount = 0;
  private readonly roonMedia: RoonMediaListener;
  private readonly mediaDiagnosticIds = new Map<string, string>();
  private mediaDiagnosticSequence = 0;

  constructor(
    private readonly options: {
      host: string;
      port: number;
      publicBaseUrl: string;
      registry: StreamRegistry;
      logger: Logger;
      fetcher?: GatewayFetch;
      /** 真实上游读取生命周期通知；不是token注册量或公开播放状态。 */
      onMediaReadActivityChanged?: () => void;
      preflightTimeoutMs?: number;
      remoteDevelopmentMode?: boolean;
      /** 独立媒体接口。默认缺席；绝不改变原控制与远程Gateway监听。 */
      localMediaNetwork?: TrustedLocalMediaNetwork;
    },
  ) {
    this.roonMedia = new RoonMediaListener({ logger: options.logger,
      dispatch: (request, response) => this.handleRoonMedia(request, response) });
  }

  async configureRoonMedia(peer?: TrustedRoonMediaPeer): Promise<void> {
    if (peer && (!this.server?.listening || this.closing || this.options.localMediaNetwork)) {
      throw new BridgeError('CONFIG_INVALID', 'Roon 媒体监听当前不可用');
    }
    await this.roonMedia.configure(peer);
  }

  isTrustedRoonMediaOrigin(origin: string): boolean { return this.roonMedia.origin === origin; }

  private roonMediaOrigin(): string | undefined {
    if (this.roonMedia.required && !this.roonMedia.origin) throw new BridgeError('ROON_MEDIA_ERROR', 'Roon 局域网媒体服务尚未就绪', { httpStatus: 503 });
    return this.roonMedia.origin;
  }

  private mediaDiagnosticId(token: string): string {
    let id = this.mediaDiagnosticIds.get(token);
    if (!id) {
      id = `roon-media-${++this.mediaDiagnosticSequence}`;
      this.mediaDiagnosticIds.set(token, id);
      if (this.mediaDiagnosticIds.size > 512) this.mediaDiagnosticIds.delete(this.mediaDiagnosticIds.keys().next().value!);
    }
    return id;
  }

  getMediaDiagnosticId(mediaUrl: string): string | undefined {
    try {
      const match = /^\/(?:local-stream|stream)\/([A-Za-z0-9_-]{43})(?:\.[a-z0-9]+)?$/u.exec(new URL(mediaUrl).pathname);
      return match ? this.mediaDiagnosticIds.get(match[1]!) : undefined;
    } catch { return undefined; }
  }

  private async handleRoonMedia(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const target = request.url ?? '';
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(404); response.end(); return; }
    if (target === '/assets/icon.png') {
      response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': ICON_PNG.length, 'X-Content-Type-Options': 'nosniff' });
      response.end(request.method === 'HEAD' ? undefined : ICON_PNG); return;
    }
    const local = /^\/local-stream\/([A-Za-z0-9_-]{43})$/u.exec(target);
    const stream = /^\/stream\/([A-Za-z0-9_-]{43})\.(mp3|flac|aac|m4a|ogg|opus|wav|bin)$/u.exec(target);
    if (!local && !stream) { response.writeHead(404); response.end(); return; }
    const diagnosticId = this.mediaDiagnosticId((local ?? stream)![1]!);
    try { this.options.logger.info('roon_media_request', { diagnosticId, routeClass: local ? 'local-file' : 'stream', method: request.method,
      rangeClass: classifyRange(request.headers.range) }); } catch { /* 观察不改变媒体准入。 */ }
    if (local) { await this.handleLocal(request, response); return; }
    await this.proxyStream(stream![1]!, request, response);
  }

  getActiveMediaReadCount(): number { return this.activeMediaReadCount; }

  private beginMediaRead(): () => void {
    ++this.activeMediaReadCount;
    const notify = (): void => {
      try { this.options.onMediaReadActivityChanged?.(); }
      catch { this.options.logger.warn('scan_media_activity_listener_failed', {}); }
    };
    notify();
    let released = false;
    return () => { if (!released) { released = true; --this.activeMediaReadCount; notify(); } };
  }

  async start(): Promise<void> {
    if (this.closing) await this.closing;
    if (this.starting) return this.starting;
    if (this.server) return;
    if (this.options.localMediaNetwork && !isTrustedLocalMediaNetwork(this.options.localMediaNetwork)) throw new BridgeError('CONFIG_INVALID', '本地媒体网络未经可信启动组合准入');
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server = server;
    const starting = (async () => {
      let media: Server | undefined;
      try {
        await this.listenServer(server, this.options.port, this.options.host);
        // stop先撤销身份；迟到的listen成功不能再启动独立媒体监听。
        if (this.server !== server) return;
        const network = this.options.localMediaNetwork;
        if (network) {
          media = createServer((request, response) => {
            const peer = request.socket.remoteAddress?.replace(/^::ffff:/u, '');
            if (!peer || !network.allowedPeers.includes(peer)) { response.writeHead(404); response.end(); return; }
            // 此监听不路由health、控制、旧remote fetch或诊断资产。
            void this.handleLocal(request, response).then(handled => { if (!handled) { response.writeHead(404); response.end(); } }).catch(() => response.destroy());
          });
          this.localMediaServer = media;
          await this.listenServer(media, network.port, network.bindAddress);
        }
      } catch (error) {
        if (this.server === server) this.server = undefined;
        if (this.localMediaServer === media) this.localMediaServer = undefined;
        // 关闭未监听的Server无需close；部分监听失败也不能覆盖最初的listen错误。
        await Promise.allSettled([this.closeServer(server), ...(media ? [this.closeServer(media)] : [])]);
        if (media) await this.options.registry.closeLocal().catch(() => {});
        throw error;
      }
    })();
    this.starting = starting;
    try { await starting; }
    finally { if (this.starting === starting) this.starting = undefined; }
  }

  async stop(): Promise<void> {
    if (this.closing) return this.closing;
    const server = this.server;
    this.server = undefined;
    this.stageObservers.clear();
    this.mediaDiagnosticIds.clear();
    const roonClosing = this.roonMedia.configure();
    const media = this.localMediaServer; this.localMediaServer = undefined;
    const starting = this.starting;
    this.closing = Promise.resolve().then(async () => {
      await starting?.catch(() => {});
      await roonClosing;
      try { await this.options.registry.closeLocal(); }
      finally { await Promise.all([server, media].filter((value): value is Server => Boolean(value)).map(value => this.closeServer(value))); }
    }).finally(() => { this.closing = undefined; });
    return this.closing;
  }

  private listenServer(server: Server, port: number, host: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const failed = (error: unknown): void => { server.off('listening', ready); reject(error); };
      const ready = (): void => { server.off('error', failed); resolve(); };
      server.once('error', failed);
      server.once('listening', ready);
      try { server.listen(port, host); }
      catch (error) { server.off('error', failed); failed(error); }
    });
  }

  private closeServer(server: Server): Promise<void> {
    if (!server.listening) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeIdleConnections();
    });
  }

  localStreamUrl(token: string, onStageChange?:GatewayStageObserver, diagnostic?:LocalMediaDiagnosticBinding): string {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token) || !this.options.registry.getLocal(token)) throw new BridgeError('STREAM_NOT_FOUND', '本地媒体租约不可用', { httpStatus: 404 });
    let localDiagnostic:LocalMediaDiagnosticBinding|undefined;
    try {
      if(diagnostic && /^diag-local-[a-f0-9]{64}$/u.test(diagnostic.diagnosticId))localDiagnostic={diagnosticId:diagnostic.diagnosticId,isCurrent:()=>diagnostic.isCurrent(),isOwned:()=>diagnostic.isOwned()};
    } catch { /* 无合法私有绑定时保持原媒体行为。 */ }
    if(onStageChange || localDiagnostic)this.stageObservers.set(token,{...(onStageChange?{stage:onStageChange}:{}),...(localDiagnostic?{localDiagnostic}:{}),requestSequence:0,truncated:false});
    this.mediaDiagnosticId(token);
    return `${this.roonMediaOrigin() ?? this.options.localMediaNetwork?.advertisedBaseUrl ?? (this.options.remoteDevelopmentMode ? this.options.publicBaseUrl : this.localBaseUrl())}/local-stream/${token}`;
  }
  private async handleLocal(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (!(request.url ?? '').startsWith('/local-stream/')) return false;
    const match = /^\/local-stream\/([A-Za-z0-9_-]{43})$/u.exec(request.url ?? '');
    const registration = match ? this.options.registry.getLocal(match[1]!) : undefined;
    if (!registration || request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(404, { 'Content-Length': 0 }); response.end(); return true; }
    const binding=this.stageObservers.get(match![1]!), method=request.method, rangeClass=classifyRange(request.headers.range);
    let requestSequence:number|undefined;
    try {
      if(binding?.localDiagnostic){
        const sequence=++binding.requestSequence;
        if(sequence<=MAX_LOCAL_MEDIA_DIAGNOSTIC_REQUESTS){requestSequence=sequence;this.logLocalMedia(binding,sequence,method,rangeClass,'request');}
        else if(!binding.truncated){binding.truncated=true;this.logLocalMedia(binding,sequence,method,rangeClass,'truncated');}
      }
    } catch { /* 日志或只读诊断谓词失败不改变HTTP准入。 */ }
    if (this.localRequests >= 8) {
      response.writeHead(429, { 'Content-Length': 0 }); response.end();
      if(requestSequence!==undefined)this.logLocalMedia(binding!,requestSequence,method,rangeClass,'transfer-terminal',
        {outcome:'capacity-rejected',statusCode:429,pipelineBodyBytesObserved:0,observedBytesCapped:false,responseFinished:response.writableFinished,elapsedMs:0});
      return true;
    }
    this.localRequests++; const release = this.beginMediaRead();
    if(!binding?.localDiagnostic)try{this.options.logger.info('roon_gateway_local_request',{method,routeClass:'local-file',rangeClass});}catch{/* 原有限日志失败同样不改变传输。 */}
    try { await serveLocalFile(registration.lease, request, response, fallbackContentTypeForFormat(registration.format),stage=>{
      this.notifyStage(match![1]!,stage);
      if(stage==='streaming')try{this.options.logger.info('roon_gateway_first_body_bytes',{diagnosticId:this.mediaDiagnosticId(match![1]!),routeClass:'local-file'});}catch{/* 观察不改变传输。 */}
    },
      requestSequence===undefined?undefined:evidence=>this.logLocalMedia(binding!,requestSequence!,method,rangeClass,'transfer-terminal',evidence)); }
    finally { this.localRequests--; release(); }
    return true;
  }

  streamUrl(
    token: string,
    format?: string,
    onStageChange?: GatewayStageObserver,
  ): string {
    if (onStageChange) this.stageObservers.set(token, {stage:onStageChange,requestSequence:0,truncated:false});
    this.mediaDiagnosticId(token);
    return `${this.roonMediaOrigin() ?? this.options.publicBaseUrl}/stream/${encodeURIComponent(token)}.${routeExtensionForFormat(format)}`;
  }

  clearStageObserver(token: string): void {
    this.stageObservers.delete(token);
    this.mediaDiagnosticIds.delete(token);
  }

  getDiagnosticResourceCounters(): { listenerCount: number; timerCount: number } {
    return {
      listenerCount: this.stageObservers.size + this.activePreflightOwnerListenerCount,
      timerCount: this.activeTimerCount,
    };
  }

  iconUrl(): string {
    return `${this.roonMediaOrigin() ?? this.options.publicBaseUrl.replace(/\/$/, '')}/assets/icon.png`;
  }

  localBaseUrl(): string {
    const address = this.server?.address();
    if (!address || typeof address === 'string') {
      throw new BridgeError('INTERNAL_ERROR', 'Stream gateway is not listening');
    }
    const host = address.address.includes(':') ? `[${address.address}]` : address.address;
    return `http://${host}:${address.port}`;
  }

  async preflight(resolved: ResolvedAudioStream, ownerSignal?: AbortSignal): Promise<void> {
    const cancelled = () => new BridgeError('BAD_REQUEST', '播放操作已取消', {
      httpStatus: 409,
      details: { reason: 'operation_cancelled' },
    });
    if (ownerSignal?.aborted) throw cancelled();
    let upstreamUrl: string;
    try {
      upstreamUrl = assertSafeAudioUrl(resolved.upstreamUrl);
    } catch (error) {
      throw preflightFailure(error);
    }

    const headers = new Headers(resolved.requestHeaders ?? {});
    headers.set('Accept-Encoding', 'identity');
    headers.set('Range', 'bytes=0-0');

    const abortController = new AbortController();
    const abortForOwner = () => abortController.abort(cancelled());
    if (ownerSignal) {
      ownerSignal.addEventListener('abort', abortForOwner, { once: true });
      this.activePreflightOwnerListenerCount += 1;
      if (ownerSignal.aborted) abortForOwner();
    }
    this.activeTimerCount += 1;
    const timeout = setTimeout(
      () => abortController.abort(),
      this.options.preflightTimeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS,
    );

    const releaseMediaRead = this.beginMediaRead();
    try {
      const fetcher = this.options.fetcher ?? secureGatewayFetch;
      if (ownerSignal?.aborted) throw cancelled();
      const upstream = await fetcher(upstreamUrl, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: abortController.signal,
      });

      try {
        abortController.signal.throwIfAborted();
        if (upstream.status !== 200 && upstream.status !== 206) {
          throw preflightFailure(undefined, upstream.status);
        }
      } finally {
        if (upstream.body !== null) await upstream.body.cancel();
      }
      abortController.signal.throwIfAborted();
    } catch (error) {
      if (ownerSignal?.aborted) throw cancelled();
      if (
        error instanceof BridgeError &&
        error.message.startsWith('UPSTREAM_HTTPS_UNAVAILABLE:')
      ) {
        throw error;
      }
      throw preflightFailure(error);
    } finally {
      releaseMediaRead();
      if (ownerSignal) {
        ownerSignal.removeEventListener('abort', abortForOwner);
        this.activePreflightOwnerListenerCount = Math.max(0, this.activePreflightOwnerListenerCount - 1);
      }
      clearTimeout(timeout);
      this.activeTimerCount = Math.max(0, this.activeTimerCount - 1);
    }
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      if (await this.handleLocal(request, response)) return;
      const requestUrl = new URL(
        request.url ?? '/',
        `http://${request.headers.host ?? 'localhost'}`,
      );

      if (
        this.options.remoteDevelopmentMode &&
        requestUrl.pathname === '/__musicbridge_remote_dev_health' &&
        request.method === 'GET'
      ) {
        sendJson(response, 200, {
          ok: true,
          mode: 'remote-core-development',
        });
        return;
      }

      if (requestUrl.pathname === '/health' && request.method === 'GET') {
        sendJson(response, 200, {
          ok: true,
          activeStreams: this.options.registry.size,
        });
        return;
      }

      if (
        requestUrl.pathname === '/assets/icon.png' &&
        (request.method === 'GET' || request.method === 'HEAD')
      ) {
        this.options.logger.info('roon_gateway_icon_request', {
          method: request.method,
          routeClass: 'icon',
          iconKind: 'local-png',
        });
        response.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': ICON_PNG.length,
          'Cache-Control': 'private, max-age=3600',
          'X-Content-Type-Options': 'nosniff',
        });
        response.end(request.method === 'HEAD' ? undefined : ICON_PNG);
        return;
      }

      if (
        requestUrl.pathname === '/assets/icon.svg' &&
        (request.method === 'GET' || request.method === 'HEAD')
      ) {
        this.options.logger.info('roon_gateway_icon_request', {
          method: request.method,
          routeClass: 'icon',
        });
        const body = Buffer.from(ICON_SVG);
        response.writeHead(200, {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Content-Length': body.length,
          'Cache-Control': 'private, max-age=3600',
          'X-Content-Type-Options': 'nosniff',
        });
        response.end(request.method === 'HEAD' ? undefined : body);
        return;
      }

      const match = /^\/stream\/([A-Za-z0-9_-]+)\.(mp3|flac|aac|m4a|ogg|opus|wav|bin)$/.exec(
        requestUrl.pathname,
      );
      if (!match || (request.method !== 'GET' && request.method !== 'HEAD')) {
        sendJson(response, 404, { ok: false, code: 'NOT_FOUND' });
        return;
      }

      const token = match[1];
      if (!token) {
        throw new BridgeError('STREAM_NOT_FOUND', 'Missing stream token', {
          httpStatus: 404,
        });
      }
      this.options.logger.info('roon_gateway_stream_request', {
        method: request.method,
        routeClass: 'stream',
        proxyStream: true,
        mediaExtension: match[2] === 'bin' ? 'unknown' : match[2],
      });
      await this.proxyStream(token, request, response);
    } catch (error) {
      const bridgeError = asBridgeError(error);
      this.options.logger.warn('stream_gateway_request_failed', {
        code: bridgeError.code,
      });
      if (!response.headersSent) {
        sendJson(response, bridgeError.httpStatus, {
          ok: false,
          code: bridgeError.code,
          message: bridgeError.message,
        });
      } else {
        response.destroy();
      }
    }
  }

  private async proxyStream(
    token: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const startedAt = Date.now();
    const abortController = new AbortController();
    let clientAborted = false;
    let responseFinished = false;
    let responseClosed = false;
    let transferOutcome:
      | 'finished'
      | 'client-aborted'
      | 'upstream-aborted'
      | 'pipeline-error'
      | 'headers-only'
      | undefined;
    let pipelineStarted = false;
    let upstreamResponseReceived = false;
    let upstreamBodyErrored = false;
    let clientAbortBeforeUpstreamBodyError = false;
    let bytesForwarded = 0;
    let releaseMediaRead: (() => void) | undefined;

    const onRequestAborted = (): void => {
      if (!upstreamBodyErrored) clientAbortBeforeUpstreamBodyError = true;
      clientAborted = true;
      abortController.abort();
    };
    const onResponseFinish = (): void => {
      responseFinished = true;
    };
    const onResponseClose = (): void => {
      responseClosed = true;
      if (!responseFinished) abortController.abort();
    };
    request.once('aborted', onRequestAborted);
    response.once('finish', onResponseFinish);
    response.once('close', onResponseClose);

    try {
      const registration = this.options.registry.get(token);
      releaseMediaRead = this.beginMediaRead();
      let resolved = await registration.resolve();
      const range = request.headers.range;
      const ifRangeValue = request.headers['if-range'];
      const ifRange = Array.isArray(ifRangeValue) ? ifRangeValue[0] : ifRangeValue;
      const requestHeaders = (stream: ResolvedAudioStream): Headers => {
        const headers = new Headers(stream.requestHeaders ?? {});
        headers.set('Accept-Encoding', 'identity');
        if (range) headers.set('Range', range);
        if (ifRange) headers.set('If-Range', ifRange);
        return headers;
      };

      const fetcher = this.options.fetcher ?? secureGatewayFetch;
      let headers = requestHeaders(resolved);
      let upstream = await fetcher(resolved.upstreamUrl, {
        method: request.method ?? 'GET',
        headers,
        signal: abortController.signal,
      });
      upstreamResponseReceived = true;

      let refreshAttempted = false;
      if (isExpiredUpstreamStatus(upstream.status)) {
        refreshAttempted = true;
        if (upstream.body !== null) {
          try {
            await upstream.body.cancel();
          } catch {
            // The expired response is already unusable; continue with one refresh attempt.
          }
        }
        resolved = await registration.resolve({
          reason: 'upstream_expired',
          status: upstream.status,
        });
        headers = requestHeaders(resolved);
        upstream = await fetcher(resolved.upstreamUrl, {
          method: request.method ?? 'GET',
          headers,
          signal: abortController.signal,
        });
        upstreamResponseReceived = true;
      }

      if (!upstream.ok && upstream.status !== 206) {
        if (refreshAttempted && isExpiredUpstreamStatus(upstream.status)) {
          throw new BridgeError(
            'STREAM_URL_EXPIRED',
            'Audio stream URL expired after one refresh',
            { httpStatus: 502, details: { status: upstream.status } },
          );
        }
        throw new BridgeError(
          'STREAM_UPSTREAM_FAILED',
          `Audio upstream returned HTTP ${upstream.status}`,
          { httpStatus: 502, details: { status: upstream.status } },
        );
      }

      response.statusCode = upstream.status;
      const upstreamContentType = upstream.headers.get('content-type');
      for (const headerName of FORWARDED_RESPONSE_HEADERS) {
        const value = upstream.headers.get(headerName);
        if (value !== null) response.setHeader(headerName, value);
      }
      if (isGenericContentType(upstreamContentType)) {
        const fallbackContentType = fallbackContentTypeForFormat(resolved.format);
        if (fallbackContentType) response.setHeader('Content-Type', fallbackContentType);
      }
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');

      this.notifyStage(token, 'headers');
      this.options.logger.info('roon_gateway_upstream_response', {
        diagnosticId: this.mediaDiagnosticId(token),
        method: request.method ?? 'GET',
        rangePresent: Boolean(range),
        rangeClass: classifyRange(range),
        upstreamStatus: upstream.status,
        contentTypeClass: classifyContentType(upstreamContentType),
        contentLengthPresent: upstream.headers.get('content-length') !== null,
        ...(readContentLength(upstream.headers.get('content-length')) !== undefined
          ? { contentLengthBytes: readContentLength(upstream.headers.get('content-length')) }
          : {}),
        contentRangePresent: upstream.headers.get('content-range') !== null,
        acceptRangesPresent: upstream.headers.get('accept-ranges') !== null,
        mediaExtension: mediaExtensionForFormat(resolved.format),
        transportSecurity: resolved.transportSecurity ?? 'unknown',
      });

      if (request.method === 'HEAD' || upstream.body === null) {
        transferOutcome = 'headers-only';
        response.end();
        return;
      }

      this.notifyStage(token, 'streaming');
      pipelineStarted = true;
      const nodeStream = Readable.fromWeb(upstream.body as any);
      nodeStream.once('error', () => {
        upstreamBodyErrored = true;
      });
      const firstBodyBytes = (): void => {
        try { this.options.logger.info('roon_gateway_first_body_bytes', { diagnosticId: this.mediaDiagnosticId(token), routeClass: 'stream' }); }
        catch { /* 观察失败不阻断音频读取。 */ }
      };
      let bodyObserved = false;
      const byteCounter = new Transform({
        transform(chunk: unknown, _encoding, callback) {
          if (typeof chunk === 'string') bytesForwarded += Buffer.byteLength(chunk);
          else if (chunk instanceof Uint8Array) bytesForwarded += chunk.byteLength;
          if (!bodyObserved && bytesForwarded > 0) { bodyObserved = true; firstBodyBytes(); }
          callback(null, chunk);
        },
      });
      await pipeline(nodeStream, byteCounter, response);
      transferOutcome = 'finished';
      this.notifyStage(token, 'completed', true);
    } catch (error) {
      const isAbortError = error instanceof Error && error.name === 'AbortError';
      if (
        pipelineStarted &&
        !isAbortError &&
        upstreamBodyErrored &&
        !clientAbortBeforeUpstreamBodyError
      ) {
        transferOutcome = 'pipeline-error';
        this.notifyStage(token, 'error', true);
      } else if (clientAborted) {
        transferOutcome = 'client-aborted';
        this.notifyStage(token, 'aborted', true);
      } else if (!pipelineStarted || !upstreamResponseReceived) {
        transferOutcome = 'upstream-aborted';
        this.notifyStage(token, 'error', true);
      } else {
        transferOutcome = 'pipeline-error';
        this.notifyStage(token, 'error', true);
      }
      throw error;
    } finally {
      releaseMediaRead?.();
      request.off('aborted', onRequestAborted);
      response.off('finish', onResponseFinish);
      response.off('close', onResponseClose);
      if (transferOutcome) {
        this.options.logger.info('roon_gateway_transfer_complete', {
          diagnosticId: this.mediaDiagnosticId(token),
          method: request.method ?? 'GET',
          bytesForwarded,
          durationMs: Date.now() - startedAt,
          outcome: transferOutcome,
          responseFinished: responseFinished || response.writableFinished,
          responseClosed,
        });
      }
    }
  }

  private logLocalMedia(binding:GatewayObserverBinding,requestSequence:number,method:'GET'|'HEAD',rangeClass:RangeClass,
    stage:'request'|'transfer-terminal'|'truncated',evidence?:LocalFileTransferEvidence):void {
    try {
      const diagnostic=binding.localDiagnostic;if(!diagnostic)return;
      const current=diagnostic.isCurrent()===true;
      this.options.logger.info('local_playback_media_evidence',{schemaVersion:1,component:'gateway',diagnosticId:diagnostic.diagnosticId,
        requestSequence,method,routeClass:'local-file',rangeClass,stage,currentOwned:current && diagnostic.isOwned()===true,staleCallback:!current,
        ...(evidence?{outcome:evidence.outcome,statusCode:evidence.statusCode,pipelineBodyBytesObserved:evidence.pipelineBodyBytesObserved,
          observedBytesCapped:evidence.observedBytesCapped,responseFinished:evidence.responseFinished,elapsedMs:evidence.elapsedMs,
          ...(evidence.completedPipelineBodyBytes===undefined?{}:{completedPipelineBodyBytes:evidence.completedPipelineBodyBytes})}:{}),
        ...(stage==='truncated'?{requestLimit:MAX_LOCAL_MEDIA_DIAGNOSTIC_REQUESTS}:{})});
    } catch { /* 私有日志不影响原媒体字节、背压和租约生命周期。 */ }
  }

  private notifyStage(token: string, stage: RoonGatewayStage, terminal = false): void {
    const observer = this.stageObservers.get(token);
    if (!observer) return;
    try {
      observer.stage?.(stage);
    } catch {
      // A diagnostic observer must never affect media delivery.
    }
    if (terminal) this.stageObservers.delete(token);
  }
}
