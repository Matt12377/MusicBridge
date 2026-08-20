import assert from 'node:assert/strict';
import test from 'node:test';
import { createLogger } from '../src/shared/logger.js';
import { StreamGateway } from '../src/stream/gateway.js';
import { StreamRegistry } from '../src/stream/registry.js';
import {
  secureGatewayFetch,
  type GatewayFetch,
} from '../src/stream/upstream-policy.js';
import type { Logger } from '../src/shared/logger.js';

function recordingLogger(): {
  logger: Logger;
  events: Array<{ event: string; fields: Record<string, unknown> }>;
} {
  const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const record = (event: string, fields?: Record<string, unknown>): void => {
    events.push({ event, fields: fields ?? {} });
  };
  return {
    events,
    logger: {
      debug: record,
      info: record,
      warn: record,
      error: record,
    },
  };
}

test('gateway forwards Range and preserves media response headers without buffering API', async (t) => {
  const registry = new StreamRegistry();
  let seenMethod = '';
  let seenRange: string | null = null;

  const fetcher: GatewayFetch = async (_url, init) => {
    seenMethod = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    seenRange = headers.get('range');
    return new Response(Uint8Array.from([1, 2, 3, 4]), {
      status: 206,
      headers: {
        'Content-Type': 'audio/flac',
        'Content-Length': '4',
        'Content-Range': 'bytes 0-3/100',
        'Accept-Ranges': 'bytes',
      },
    });
  };

  const gateway = new StreamGateway({
    host: '127.0.0.1',
    port: 0,
    publicBaseUrl: 'http://127.0.0.1:0',
    registry,
    logger: createLogger('error'),
    fetcher,
  });
  await gateway.start();
  t.after(async () => gateway.stop());

  const registration = registry.register({
    metadata: {
      id: '123',
      title: 'Track',
      artists: ['Artist'],
      album: 'Album',
    },
    requestedQuality: 'lossless',
    resolve: async () => ({
      trackId: '123',
      upstreamUrl: 'https://cdn.example/audio.flac',
      requestedQuality: 'lossless',
      transportSecurity: 'https-native',
      actualQuality: 'lossless',
      format: 'flac',
    }),
  });

  const response = await fetch(
    `${gateway.localBaseUrl()}/stream/${registration.token}`,
    { headers: { Range: 'bytes=0-3' } },
  );
  const bytes = new Uint8Array(await response.arrayBuffer());

  assert.equal(seenMethod, 'GET');
  assert.equal(seenRange, 'bytes=0-3');
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 0-3/100');
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(response.headers.get('content-type'), 'audio/flac');
  assert.deepEqual([...bytes], [1, 2, 3, 4]);
});

test('gateway supports HEAD without a response body', async (t) => {
  const registry = new StreamRegistry();
  let seenMethod = '';
  const fetcher: GatewayFetch = async (_url, init) => {
    seenMethod = init.method ?? 'GET';
    return new Response(null, {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': '5000',
        'Accept-Ranges': 'bytes',
      },
    });
  };
  const gateway = new StreamGateway({
    host: '127.0.0.1',
    port: 0,
    publicBaseUrl: 'http://127.0.0.1:0',
    registry,
    logger: createLogger('error'),
    fetcher,
  });
  await gateway.start();
  t.after(async () => gateway.stop());

  const registration = registry.register({
    metadata: {
      id: '1',
      title: 'Track',
      artists: ['Artist'],
      album: 'Album',
    },
    requestedQuality: 'standard',
    resolve: async () => ({
      trackId: '1',
      upstreamUrl: 'https://cdn.example/audio.mp3',
      requestedQuality: 'standard',
      transportSecurity: 'https-native',
      actualQuality: 'standard',
    }),
  });

  const response = await fetch(
    `${gateway.localBaseUrl()}/stream/${registration.token}`,
    { method: 'HEAD' },
  );
  assert.equal(seenMethod, 'HEAD');
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');
  assert.equal(response.headers.get('content-length'), '5000');
});

test('gateway records icon and stream GET/HEAD routes without token or track identifiers', async (t) => {
  const registry = new StreamRegistry();
  const { logger, events } = recordingLogger();
  const gateway = new StreamGateway({
    host: '127.0.0.1',
    port: 0,
    publicBaseUrl: 'http://127.0.0.1:0',
    registry,
    logger,
    fetcher: async (_url, init) =>
      new Response(init.method === 'HEAD' ? null : Uint8Array.from([1]), {
        status: 206,
        headers: {
          'Content-Type': 'audio/mpeg',
          'Content-Length': '1',
          'Content-Range': 'bytes 0-0/1',
        },
      }),
  });
  await gateway.start();
  t.after(async () => gateway.stop());

  const registration = registry.register({
    metadata: {
      id: 'track-id-must-not-be-logged',
      title: 'Track',
      artists: ['Artist'],
      album: 'Album',
    },
    requestedQuality: 'standard',
    resolve: async () => resolvedStream(),
  });
  const baseUrl = gateway.localBaseUrl();

  assert.equal((await fetch(`${baseUrl}/assets/icon.svg`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/assets/icon.svg`, { method: 'HEAD' })).status, 200);
  assert.equal(
    (await fetch(`${baseUrl}/stream/${registration.token}`)).status,
    206,
  );
  assert.equal(
    (await fetch(`${baseUrl}/stream/${registration.token}`, { method: 'HEAD' })).status,
    206,
  );

  assert.deepEqual(
    events.filter(({ event }) => event === 'roon_gateway_icon_request').map(({ fields }) => fields),
    [
      { method: 'GET', routeClass: 'icon' },
      { method: 'HEAD', routeClass: 'icon' },
    ],
  );
  assert.deepEqual(
    events.filter(({ event }) => event === 'roon_gateway_stream_request').map(({ fields }) => fields),
    [
      { method: 'GET', routeClass: 'stream', proxyStream: true },
      { method: 'HEAD', routeClass: 'stream', proxyStream: true },
    ],
  );
  const serializedEvents = JSON.stringify(events);
  assert.equal(serializedEvents.includes(registration.token), false);
  assert.equal(serializedEvents.includes('track-id-must-not-be-logged'), false);
});

function resolvedStream(url = 'https://203.0.113.10/audio.mp3') {
  return {
    trackId: '1',
    upstreamUrl: url,
    requestedQuality: 'standard' as const,
    transportSecurity: 'https-native' as const,
    actualQuality: 'standard',
    requestHeaders: {
      'X-Fixture': 'present',
      'Accept-Encoding': 'gzip',
    },
  };
}

test('gateway preflight uses HTTPS GET Range 0-0, identity encoding, and cancels 206 body', async () => {
  let seenUrl = '';
  let seenMethod = '';
  let seenRange: string | null = null;
  let seenEncoding: string | null = null;
  let seenRedirect: RequestRedirect | undefined;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.from([1]));
    },
    cancel() {
      cancelled = true;
    },
  });
  const fetcher: GatewayFetch = async (url, init) => {
    seenUrl = url;
    seenMethod = init.method ?? '';
    seenRedirect = init.redirect;
    const headers = new Headers(init.headers);
    seenRange = headers.get('range');
    seenEncoding = headers.get('accept-encoding');
    return new Response(body, { status: 206 });
  };
  const gateway = new StreamGateway({
    host: '127.0.0.1',
    port: 0,
    publicBaseUrl: 'http://127.0.0.1:0',
    registry: new StreamRegistry(),
    logger: createLogger('error'),
    fetcher,
  });

  await gateway.preflight(resolvedStream());

  assert.equal(seenUrl, 'https://203.0.113.10/audio.mp3');
  assert.equal(seenMethod, 'GET');
  assert.equal(seenRange, 'bytes=0-0');
  assert.equal(seenEncoding, 'identity');
  assert.equal(seenRedirect, 'manual');
  assert.equal(cancelled, true);
});

test('gateway preflight accepts HTTP 200 and cancels the response body', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.from([1]));
    },
    cancel() {
      cancelled = true;
    },
  });
  const gateway = new StreamGateway({
    host: '127.0.0.1',
    port: 0,
    publicBaseUrl: 'http://127.0.0.1:0',
    registry: new StreamRegistry(),
    logger: createLogger('error'),
    fetcher: async () => new Response(body, { status: 200 }),
  });

  await gateway.preflight(resolvedStream());

  assert.equal(cancelled, true);
});

test('gateway preflight never calls an HTTP URL', async () => {
  let fetchCalls = 0;
  const gateway = new StreamGateway({
    host: '127.0.0.1',
    port: 0,
    publicBaseUrl: 'http://127.0.0.1:0',
    registry: new StreamRegistry(),
    logger: createLogger('error'),
    fetcher: async () => {
      fetchCalls += 1;
      return new Response(null, { status: 206 });
    },
  });

  await assert.rejects(
    () => gateway.preflight(resolvedStream('http://203.0.113.10/audio.mp3')),
    (error: unknown) =>
      error instanceof Error && error.message.includes('UPSTREAM_HTTPS_UNAVAILABLE'),
  );
  assert.equal(fetchCalls, 0);
});

test('gateway preflight rejects non-200/206 responses with a precise status', async () => {
  const gateway = new StreamGateway({
    host: '127.0.0.1',
    port: 0,
    publicBaseUrl: 'http://127.0.0.1:0',
    registry: new StreamRegistry(),
    logger: createLogger('error'),
    fetcher: async () => new Response(null, { status: 503 }),
  });

  await assert.rejects(
    () => gateway.preflight(resolvedStream()),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes('UPSTREAM_HTTPS_UNAVAILABLE') &&
      error.message.includes('HTTP 503'),
  );
});

test('gateway preflight converts fetch and TLS failures to a bounded HTTPS error', async () => {
  const gateway = new StreamGateway({
    host: '127.0.0.1',
    port: 0,
    publicBaseUrl: 'http://127.0.0.1:0',
    registry: new StreamRegistry(),
    logger: createLogger('error'),
    fetcher: async () => {
      throw new Error('TLS handshake failed');
    },
  });

  await assert.rejects(
    () => gateway.preflight(resolvedStream()),
    (error: unknown) =>
      error instanceof Error && error.message.includes('UPSTREAM_HTTPS_UNAVAILABLE'),
  );
});

test('gateway preflight aborts a timed-out fetch', async () => {
  let aborted = false;
  const gateway = new StreamGateway({
    host: '127.0.0.1',
    port: 0,
    publicBaseUrl: 'http://127.0.0.1:0',
    registry: new StreamRegistry(),
    logger: createLogger('error'),
    preflightTimeoutMs: 10,
    fetcher: async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      }),
  });

  await assert.rejects(
    () => gateway.preflight(resolvedStream()),
    (error: unknown) =>
      error instanceof Error && error.message.includes('UPSTREAM_HTTPS_UNAVAILABLE'),
  );
  assert.equal(aborted, true);
});

test('secure gateway follows HTTPS redirects and rejects HTTP or private redirects before fetching them', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (calls.length === 1) {
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://203.0.113.10/final' },
      });
    }
    return new Response(null, { status: 206 });
  };

  await secureGatewayFetch('https://203.0.113.10/start', { method: 'GET' });
  assert.deepEqual(calls, [
    'https://203.0.113.10/start',
    'https://203.0.113.10/final',
  ]);

  calls.length = 0;
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return new Response(null, {
      status: 302,
      headers: { Location: 'http://203.0.113.10/http-redirect' },
    });
  };
  await assert.rejects(() =>
    secureGatewayFetch('https://203.0.113.10/start', { method: 'GET' }),
  );
  assert.deepEqual(calls, ['https://203.0.113.10/start']);

  calls.length = 0;
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return new Response(null, {
      status: 302,
      headers: { Location: 'https://192.168.1.5/private' },
    });
  };
  await assert.rejects(() =>
    secureGatewayFetch('https://203.0.113.10/start', { method: 'GET' }),
  );
  assert.deepEqual(calls, ['https://203.0.113.10/start']);
});
