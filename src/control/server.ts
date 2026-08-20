import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { BridgeController } from '../application/bridge-controller.js';
import type { QualityLevel } from '../netease/types.js';
import { asBridgeError, BridgeError } from '../shared/errors.js';
import type { Logger } from '../shared/logger.js';

const MAX_BODY_BYTES = 64 * 1024;

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

export class ControlServer {
  private server: Server | undefined;

  constructor(
    private readonly options: {
      host: string;
      port: number;
      defaultQuality: QualityLevel;
      controller: BridgeController;
      logger: Logger;
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
