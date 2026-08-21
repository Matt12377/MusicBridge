import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { BridgeState } from '../application/bridge-controller.js';
import type { QualityLevel } from '../netease/types.js';
import type { PlaybackSnapshot } from '@music-bridge/contracts';
import { asBridgeError, BridgeError } from '../shared/errors.js';
import type { Logger } from '../shared/logger.js';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_QUEUE_ITEMS = 100;
const PLAYBACK_QUALITIES = new Set(['standard', 'exhigh', 'lossless', 'hires']);

type QueueInputItem = { trackId: unknown; quality: unknown };

interface ControlController {
  getState(): BridgeState;
  getPlaybackState(): PlaybackSnapshot;
  play(input: QueueInputItem): Promise<BridgeState>;
  stop(): Promise<BridgeState>;
  replaceQueue(items: readonly QueueInputItem[], startIndex: number): Promise<BridgeState>;
  next(): Promise<BridgeState>;
  previous(): Promise<BridgeState>;
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

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new BridgeError('BAD_REQUEST', 'Request body is too large', {
        httpStatus: 413,
      });
    }
    chunks.push(buffer);
  }

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

  constructor(
    private readonly options: {
      host: string;
      port: number;
      defaultQuality: QualityLevel;
      controller: ControlController;
      logger: Logger;
    },
  ) {}

  getListeningPort(): number | undefined {
    const address = this.server?.address();
    return address && typeof address === 'object' ? address.port : undefined;
  }

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

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const url = new URL(
        request.url ?? '/',
        `http://${request.headers.host ?? 'localhost'}`,
      );

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

      if (request.method === 'POST' && url.pathname === '/v1/queue') {
        const body = await readJsonBody(request);
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
        const body = await readJsonBody(request);
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

      sendJson(response, 404, { ok: false, code: 'NOT_FOUND' });
    } catch (error) {
      const bridgeError = asBridgeError(error);
      this.options.logger.warn('control_request_failed', {
        code: bridgeError.code,
        message: bridgeError.message,
        method: request.method,
        path: request.url,
      });
      sendJson(response, bridgeError.httpStatus, {
        ok: false,
        code: bridgeError.code,
        message: bridgeError.message,
        ...(bridgeError.details ? { details: bridgeError.details } : {}),
      });
    }
  }
}
