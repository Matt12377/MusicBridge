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
const LOCAL_ICON_URL = 'http://127.0.0.1:38502/assets/icon.png';

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
  private readonly stageObservers = new Map<string, GatewayStageObserver>();
  private activeTimerCount = 0;

  constructor(
    private readonly options: {
      host: string;
      port: number;
      publicBaseUrl: string;
      registry: StreamRegistry;
      logger: Logger;
      fetcher?: GatewayFetch;
      preflightTimeoutMs?: number;
    },
  ) {}

  async start(): Promise<void> {
    if (this.server) return;
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(this.options.port, this.options.host, () => {
        this.server?.off('error', reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.stageObservers.clear();
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  streamUrl(
    token: string,
    format?: string,
    onStageChange?: GatewayStageObserver,
  ): string {
    if (onStageChange) this.stageObservers.set(token, onStageChange);
    return `${this.options.publicBaseUrl}/stream/${encodeURIComponent(token)}.${routeExtensionForFormat(format)}`;
  }

  clearStageObserver(token: string): void {
    this.stageObservers.delete(token);
  }

  getDiagnosticResourceCounters(): { listenerCount: number; timerCount: number } {
    return {
      listenerCount: this.stageObservers.size,
      timerCount: this.activeTimerCount,
    };
  }

  iconUrl(): string {
    return LOCAL_ICON_URL;
  }

  localBaseUrl(): string {
    const address = this.server?.address();
    if (!address || typeof address === 'string') {
      throw new BridgeError('INTERNAL_ERROR', 'Stream gateway is not listening');
    }
    const host = address.address.includes(':') ? `[${address.address}]` : address.address;
    return `http://${host}:${address.port}`;
  }

  async preflight(resolved: ResolvedAudioStream): Promise<void> {
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
    this.activeTimerCount += 1;
    const timeout = setTimeout(
      () => abortController.abort(),
      this.options.preflightTimeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS,
    );

    try {
      const fetcher = this.options.fetcher ?? secureGatewayFetch;
      const upstream = await fetcher(upstreamUrl, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: abortController.signal,
      });

      try {
        if (upstream.status !== 200 && upstream.status !== 206) {
          throw preflightFailure(undefined, upstream.status);
        }
      } finally {
        if (upstream.body !== null) await upstream.body.cancel();
      }
    } catch (error) {
      if (
        error instanceof BridgeError &&
        error.message.startsWith('UPSTREAM_HTTPS_UNAVAILABLE:')
      ) {
        throw error;
      }
      throw preflightFailure(error);
    } finally {
      clearTimeout(timeout);
      this.activeTimerCount = Math.max(0, this.activeTimerCount - 1);
    }
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const requestUrl = new URL(
        request.url ?? '/',
        `http://${request.headers.host ?? 'localhost'}`,
      );

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
      const byteCounter = new Transform({
        transform(chunk: unknown, _encoding, callback) {
          if (typeof chunk === 'string') bytesForwarded += Buffer.byteLength(chunk);
          else if (chunk instanceof Uint8Array) bytesForwarded += chunk.byteLength;
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
      request.off('aborted', onRequestAborted);
      response.off('finish', onResponseFinish);
      response.off('close', onResponseClose);
      if (transferOutcome) {
        this.options.logger.info('roon_gateway_transfer_complete', {
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

  private notifyStage(token: string, stage: RoonGatewayStage, terminal = false): void {
    const observer = this.stageObservers.get(token);
    if (!observer) return;
    try {
      observer(stage);
    } catch {
      // A diagnostic observer must never affect media delivery.
    }
    if (terminal) this.stageObservers.delete(token);
  }
}
