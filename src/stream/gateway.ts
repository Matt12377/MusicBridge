import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { asBridgeError, BridgeError } from '../shared/errors.js';
import { assertSafeAudioUrl } from '../netease/policy.js';
import type { ResolvedAudioStream } from '../netease/types.js';
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

const DEFAULT_PREFLIGHT_TIMEOUT_MS = 10_000;

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
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  streamUrl(token: string): string {
    return `${this.options.publicBaseUrl}/stream/${encodeURIComponent(token)}`;
  }

  iconUrl(): string {
    return `${this.options.publicBaseUrl}/assets/icon.svg`;
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

      if (requestUrl.pathname === '/assets/icon.svg' && request.method === 'GET') {
        const body = Buffer.from(ICON_SVG);
        response.writeHead(200, {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Content-Length': body.length,
          'Cache-Control': 'private, max-age=3600',
          'X-Content-Type-Options': 'nosniff',
        });
        response.end(body);
        return;
      }

      const match = /^\/stream\/([A-Za-z0-9_-]+)$/.exec(requestUrl.pathname);
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
      await this.proxyStream(token, request, response);
    } catch (error) {
      const bridgeError = asBridgeError(error);
      this.options.logger.warn('stream_gateway_request_failed', {
        code: bridgeError.code,
        message: bridgeError.message,
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
    const registration = this.options.registry.get(token);
    const resolved = await registration.resolve();
    const headers = new Headers(resolved.requestHeaders ?? {});
    headers.set('Accept-Encoding', 'identity');

    const range = request.headers.range;
    const ifRangeValue = request.headers['if-range'];
    const ifRange = Array.isArray(ifRangeValue) ? ifRangeValue[0] : ifRangeValue;
    if (range) headers.set('Range', range);
    if (ifRange) headers.set('If-Range', ifRange);

    const abortController = new AbortController();
    const onClose = (): void => abortController.abort();
    request.once('aborted', onClose);
    response.once('close', onClose);

    try {
      const fetcher = this.options.fetcher ?? secureGatewayFetch;
      const upstream = await fetcher(resolved.upstreamUrl, {
        method: request.method ?? 'GET',
        headers,
        signal: abortController.signal,
      });

      if (!upstream.ok && upstream.status !== 206) {
        throw new BridgeError(
          'STREAM_UPSTREAM_FAILED',
          `Audio upstream returned HTTP ${upstream.status}`,
          { httpStatus: 502, details: { status: upstream.status } },
        );
      }

      response.statusCode = upstream.status;
      for (const headerName of FORWARDED_RESPONSE_HEADERS) {
        const value = upstream.headers.get(headerName);
        if (value !== null) response.setHeader(headerName, value);
      }
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');

      this.options.logger.debug('stream_proxy_started', {
        trackId: registration.metadata.id,
        method: request.method ?? 'GET',
        status: upstream.status,
        rangeForwarded: Boolean(range),
        actualQuality: resolved.actualQuality,
        format: resolved.format,
      });

      if (request.method === 'HEAD' || upstream.body === null) {
        response.end();
        return;
      }

      const nodeStream = Readable.fromWeb(upstream.body as any);
      await pipeline(nodeStream, response);
    } finally {
      request.off('aborted', onClose);
      response.off('close', onClose);
    }
  }
}
