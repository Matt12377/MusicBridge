import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { BridgeState } from '../application/bridge-controller.js';
import { MAX_PLAYBACK_QUEUE_ITEMS } from '@music-bridge/contracts';
import type {
  PageRequest,
  PlaybackQualityPreference,
  PlaybackSnapshot,
  PublicBridgeState,
  PublicRoonZone,
  RoonImageOptions,
  RoonImageResult,
  RoonLibraryPage,
} from '@music-bridge/contracts';
import { asBridgeError, BridgeError } from '../shared/errors.js';
import type { Logger } from '../shared/logger.js';
import type { Socket } from 'node:net';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_QUEUE_ITEMS = MAX_PLAYBACK_QUEUE_ITEMS;
const PLAYBACK_QUALITIES = new Set(['auto', 'standard', 'exhigh', 'lossless', 'hires']);

type QueueInputItem = { trackId: unknown; quality: unknown };

interface ControlController {
  getState(): BridgeState;
  getPlaybackState(): PlaybackSnapshot;
  play(input: QueueInputItem): Promise<BridgeState>;
  pause(): Promise<BridgeState>;
  resume(): Promise<BridgeState>;
  stop(): Promise<BridgeState>;
  replaceQueue(items: readonly QueueInputItem[], startIndex: number): Promise<BridgeState>;
  next(): Promise<BridgeState>;
  previous(): Promise<BridgeState>;
}

export interface ControlRoonController {
  listZones(): readonly PublicRoonZone[];
  selectZone(zoneId: string): Promise<PublicBridgeState> | PublicBridgeState;
  browseRoonAlbums(page: PageRequest): Promise<RoonLibraryPage>;
  browseRoonAlbum(reference: string, page: PageRequest): Promise<RoonLibraryPage>;
  getRoonImage(reference: string, options?: RoonImageOptions): Promise<RoonImageResult>;
  playRoonTrack?(reference: string, zoneId: string): Promise<{ started: true }>;
  queueRoonTrack?(reference: string, zoneId: string): Promise<{ queued: true }>;
  seekRoonTransport?(positionMs: number): Promise<{ positionMs: number }>;
  stopRoonTransport?(): Promise<{ stopped: true }>;
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  const data = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(data);
}

async function readJsonBody(request: IncomingMessage, timeoutMs: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer); request.off('data', data); request.off('end', end);
      request.off('error', failed); request.off('aborted', aborted);
      if (error) { request.pause(); reject(error); } else resolve();
    };
    const failed = () => finish(new BridgeError('BAD_REQUEST', '请求体未完整读取', { httpStatus: 400 }));
    const aborted = () => failed();
    const end = () => finish();
    const data = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += buffer.length;
      if (size > MAX_BODY_BYTES) return finish(new BridgeError('BAD_REQUEST', '请求体超过大小限制', { httpStatus: 413 }));
      if (!/^application\/json(?:\s*;.*)?$/iu.test(request.headers['content-type'] ?? ''))
        return finish(new BridgeError('BAD_REQUEST', '写入请求体必须使用JSON', { httpStatus: 415 }));
      chunks.push(buffer);
    };
    const timer = setTimeout(() => finish(new BridgeError('BAD_REQUEST', '请求体读取超时', { httpStatus: 408 })), timeoutMs);
    request.on('data', data); request.once('end', end); request.once('error', failed); request.once('aborted', aborted);
  });

  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('JSON body must be an object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new BridgeError('BAD_REQUEST', 'Invalid JSON body', {
      cause: error,
      httpStatus: 400,
    });
  }
}

function invalidQueueRequest(): BridgeError {
  return new BridgeError('BAD_REQUEST', 'Invalid playback queue', { httpStatus: 400 });
}

function invalidRoonRequest(): BridgeError {
  return new BridgeError('BAD_REQUEST', 'Invalid Roon request', { httpStatus: 400 });
}

function readPage(url: URL): PageRequest {
  const offset = Number(url.searchParams.get('offset') ?? '0');
  const limit = Number(url.searchParams.get('limit') ?? '50');
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw invalidRoonRequest();
  }
  return { offset, limit };
}

function readReference(url: URL): string {
  const reference = url.searchParams.get('reference');
  if (!reference || reference.length > 4_096) throw invalidRoonRequest();
  return reference;
}

function readZoneId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw invalidRoonRequest();
  }
  return value;
}

function readPositionMs(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 24 * 60 * 60 * 1_000) {
    throw invalidRoonRequest();
  }
  return value as number;
}

function readReferenceFromBody(body: Record<string, unknown>): string {
  const reference = body.reference;
  if (typeof reference !== 'string' || reference.length === 0 || reference.length > 4_096) {
    throw invalidRoonRequest();
  }
  return reference;
}

function readImageOptions(url: URL): RoonImageOptions | undefined {
  const widthValue = url.searchParams.get('width');
  const heightValue = url.searchParams.get('height');
  const formatValue = url.searchParams.get('format');
  const scaleValue = url.searchParams.get('scale');
  if (!widthValue && !heightValue && !formatValue && !scaleValue) return undefined;
  const width = widthValue === null ? undefined : Number(widthValue);
  const height = heightValue === null ? undefined : Number(heightValue);
  if (
    (width !== undefined && (!Number.isSafeInteger(width) || width < 1 || width > 2048)) ||
    (height !== undefined && (!Number.isSafeInteger(height) || height < 1 || height > 2048))
  ) {
    throw invalidRoonRequest();
  }
  const format = formatValue === 'image/jpeg' || formatValue === 'image/png' ? formatValue : undefined;
  const scale = scaleValue === 'fit' || scaleValue === 'fill' || scaleValue === 'stretch' ? scaleValue : undefined;
  if (formatValue !== null && format === undefined) throw invalidRoonRequest();
  if (scaleValue !== null && scale === undefined) throw invalidRoonRequest();
  return { ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}), ...(format ? { format } : {}), ...(scale ? { scale } : {}) };
}

function isTrackId(value: unknown): boolean {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0;
  }
  return typeof value === 'string' && /^\d+$/.test(value) && value !== '0' && value.length <= 128;
}

function readQueueRequest(body: Record<string, unknown>): {
  items: readonly QueueInputItem[];
  index: number;
} {
  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > MAX_QUEUE_ITEMS) {
    throw invalidQueueRequest();
  }

  const index = body.index ?? 0;
  if (
    typeof index !== 'number' ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= body.items.length
  ) {
    throw invalidQueueRequest();
  }

  const items = body.items.map((value): QueueInputItem => {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => !['trackId', 'quality'].includes(key))
    ) {
      throw invalidQueueRequest();
    }
    const item = value as { trackId?: unknown; quality?: unknown };
    if (
      !isTrackId(item.trackId) ||
      typeof item.quality !== 'string' ||
      !PLAYBACK_QUALITIES.has(item.quality)
    ) {
      throw invalidQueueRequest();
    }
    return { trackId: item.trackId, quality: item.quality };
  });

  return { items, index };
}

export class ControlServer {
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();
  private readonly bodyTimeoutMs: number;
  private readonly headersTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private closing: Promise<void> | undefined;
  private starting: Promise<void> | undefined;

  constructor(
    private readonly options: {
      host: string;
      port: number;
      defaultQuality: PlaybackQualityPreference;
      controller: ControlController;
      roon?: ControlRoonController;
      logger: Logger;
      bodyTimeoutMs?: number;
      headersTimeoutMs?: number;
      stopTimeoutMs?: number;
    },
  ) {
    if (!['127.0.0.1', '::1'].includes(options.host)) throw new Error('Control API必须绑定loopback');
    this.bodyTimeoutMs = options.bodyTimeoutMs ?? 5_000;
    this.headersTimeoutMs = options.headersTimeoutMs ?? 10_000;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 1_000;
    if (!Number.isSafeInteger(this.bodyTimeoutMs) || this.bodyTimeoutMs < 1 || this.bodyTimeoutMs > 30_000
      || !Number.isSafeInteger(this.headersTimeoutMs) || this.headersTimeoutMs < 1 || this.headersTimeoutMs > 10_000
      || !Number.isSafeInteger(this.stopTimeoutMs) || this.stopTimeoutMs < 1 || this.stopTimeoutMs > 5_000)
      throw new Error('Control API截止期限无效');
  }

  getListeningPort(): number | undefined {
    const address = this.server?.address();
    return address && typeof address === 'object' ? address.port : undefined;
  }

  async start(): Promise<void> {
    if (this.closing) await this.closing;
    if (this.starting) return this.starting;
    if (this.server) return;
    const server = createServer({
      headersTimeout: this.headersTimeoutMs,
      requestTimeout: Math.max(15_000, this.headersTimeoutMs),
      // Node默认每30秒检查一次，不能用它证明10秒慢头截止期限。
      connectionsCheckingInterval: Math.min(1_000, this.headersTimeoutMs),
    }, (request, response) => {
      void this.handle(request, response, server);
    });
    this.server = server;
    server.maxConnections = 64;
    server.keepAliveTimeout = 1_000; server.maxRequestsPerSocket = 100;
    server.on('connection', socket => { this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket)); });
    const starting = new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { if (this.server === server) this.server = undefined; reject(error); };
      server.once('error', failed);
      server.listen(this.options.port, this.options.host, () => {
        server.off('error', failed);
        resolve();
      });
    });
    this.starting = starting;
    try { await starting; }
    finally { if (this.starting === starting) this.starting = undefined; }
  }

  async stop(): Promise<void> {
    if (this.closing) return this.closing;
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    const starting = this.starting;
    // 先使请求身份失效，再等待本轮listen落定，避免close取消listen后留下未决启动。
    this.closing = Promise.resolve().then(async () => {
      await starting?.catch(() => {});
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { for (const socket of this.sockets) socket.destroy(); }, this.stopTimeoutMs);
        server.close(error => { clearTimeout(timer); if (error) reject(error); else resolve(); });
        server.closeIdleConnections();
      });
    }).finally(() => { this.closing = undefined; });
    return this.closing;
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
    server: Server,
  ): Promise<void> {
    let route = '/';
    try {
      const address = server.address(), port = address && typeof address === 'object' ? address.port : undefined;
      const host = request.headers.host ?? '', match = /^(localhost|127\.0\.0\.1|\[::1\]):(\d{1,5})$/iu.exec(host);
      if (!match || Number(match[2]) !== port || this.server !== server
        || request.headers['sec-fetch-site'] === 'cross-site'
        || request.headers.origin !== undefined && request.headers.origin !== `http://${host}`)
        throw new BridgeError('BAD_REQUEST', 'Control请求来源无效', { httpStatus: 403 });
      if (!request.url?.startsWith('/') || request.url.startsWith('//'))
        throw new BridgeError('BAD_REQUEST', 'Control请求路径无效', { httpStatus: 400 });
      const url = new URL(request.url, `http://${host}`);
      route = url.pathname;
      const body = request.method === 'POST' ? await readJsonBody(request, this.bodyTimeoutMs) : {};
      if (this.server !== server) throw new BridgeError('BAD_REQUEST', 'Control服务正在关闭', { httpStatus: 503 });

      if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, 200, {
          ok: true,
          service: 'music-bridge-for-roon',
          state: this.options.controller.getState(),
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/v1/state') {
        sendJson(response, 200, {
          ok: true,
          state: this.options.controller.getState(),
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/v1/playback') {
        sendJson(response, 200, {
          ok: true,
          state: this.options.controller.getPlaybackState(),
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/v1/roon/zones') {
        if (!this.options.roon) throw new BridgeError('ROON_NOT_PAIRED', 'Roon is not paired', { httpStatus: 503 });
        sendJson(response, 200, { ok: true, zones: this.options.roon.listZones() });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/roon/zone') {
        if (!this.options.roon) throw new BridgeError('ROON_NOT_PAIRED', 'Roon is not paired', { httpStatus: 503 });
        const state = await this.options.roon.selectZone(readZoneId(body.zoneId));
        sendJson(response, 200, { ok: true, state });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/v1/roon/albums') {
        if (!this.options.roon) throw new BridgeError('ROON_LIBRARY_UNAVAILABLE', 'Roon Library is not ready', { httpStatus: 503 });
        sendJson(response, 200, { ok: true, ...(await this.options.roon.browseRoonAlbums(readPage(url))) });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/v1/roon/album') {
        if (!this.options.roon) throw new BridgeError('ROON_LIBRARY_UNAVAILABLE', 'Roon Library is not ready', { httpStatus: 503 });
        sendJson(response, 200, { ok: true, ...(await this.options.roon.browseRoonAlbum(readReference(url), readPage(url))) });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/v1/roon/image') {
        if (!this.options.roon) throw new BridgeError('ROON_LIBRARY_UNAVAILABLE', 'Roon Library is not ready', { httpStatus: 503 });
        const image = await this.options.roon.getRoonImage(readReference(url), readImageOptions(url));
        sendJson(response, 200, { ok: true, contentType: image.contentType, bodyBase64: Buffer.from(image.body).toString('base64') });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/roon/play') {
        if (!this.options.roon?.playRoonTrack) throw new BridgeError('ROON_LIBRARY_UNAVAILABLE', 'Roon playback is not ready', { httpStatus: 503 });
        sendJson(response, 200, { ok: true, ...(await this.options.roon.playRoonTrack(readReferenceFromBody(body), readZoneId(body.zoneId))) });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/roon/queue') {
        if (!this.options.roon?.queueRoonTrack) throw new BridgeError('ROON_LIBRARY_UNAVAILABLE', 'Roon playback is not ready', { httpStatus: 503 });
        sendJson(response, 200, { ok: true, ...(await this.options.roon.queueRoonTrack(readReferenceFromBody(body), readZoneId(body.zoneId))) });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/roon/seek') {
        if (!this.options.roon?.seekRoonTransport) throw new BridgeError('ROON_TRANSPORT_UNAVAILABLE', 'Roon seek is not ready', { httpStatus: 503 });
        sendJson(response, 200, { ok: true, ...(await this.options.roon.seekRoonTransport(readPositionMs(body.positionMs))) });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/roon/stop') {
        if (!this.options.roon?.stopRoonTransport) throw new BridgeError('ROON_TRANSPORT_UNAVAILABLE', 'Roon transport is not ready', { httpStatus: 503 });
        sendJson(response, 200, { ok: true, ...(await this.options.roon.stopRoonTransport()) });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/queue') {
        const queue = readQueueRequest(body);
        await this.options.controller.replaceQueue(queue.items, queue.index);
        sendJson(response, 200, {
          ok: true,
          state: this.options.controller.getPlaybackState(),
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/next') {
        await this.options.controller.next();
        sendJson(response, 200, {
          ok: true,
          state: this.options.controller.getPlaybackState(),
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/previous') {
        await this.options.controller.previous();
        sendJson(response, 200, {
          ok: true,
          state: this.options.controller.getPlaybackState(),
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/play') {
        const state = await this.options.controller.play({
          trackId: body.trackId,
          quality: body.quality ?? this.options.defaultQuality,
        });
        sendJson(response, 200, { ok: true, state });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/stop') {
        const state = await this.options.controller.stop();
        sendJson(response, 200, { ok: true, state });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/pause') {
        const state = await this.options.controller.pause();
        sendJson(response, 200, { ok: true, state });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/resume') {
        const state = await this.options.controller.resume();
        sendJson(response, 200, { ok: true, state });
        return;
      }

      sendJson(response, 404, { ok: false, code: 'NOT_FOUND' });
    } catch (error) {
      const bridgeError = asBridgeError(error);
      this.options.logger.warn('control_request_failed', {
        code: bridgeError.code,
        method: request.method,
        route,
      });
      if (response.destroyed || response.writableEnded) return;
      response.setHeader('Connection', 'close'); response.once('finish', () => request.destroy());
      sendJson(response, bridgeError.httpStatus, {
        ok: false,
        code: bridgeError.code,
        message: bridgeError.message,
      });
    }
  }
}
