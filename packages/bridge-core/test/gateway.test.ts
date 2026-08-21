import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
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
  let seenIfRange: string | null = null;

  const fetcher: GatewayFetch = async (_url, init) => {
    seenMethod = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    seenRange = headers.get('range');
    seenIfRange = headers.get('if-range');
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
    `${gateway.localBaseUrl()}/stream/${registration.token}.flac`,
    { headers: { Range: 'bytes=0-3', 'If-Range': 'opaque-etag' } },
  );
  const bytes = new Uint8Array(await response.arrayBuffer());

  assert.equal(seenMethod, 'GET');
  assert.equal(seenRange, 'bytes=0-3');
  assert.equal(seenIfRange, 'opaque-etag');
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 0-3/100');
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(response.headers.get('content-type'), 'audio/flac');
  assert.deepEqual([...bytes], [1, 2, 3, 4]);
});

test('gateway retries one expired upstream response through the resolver and then succeeds', async (t) => {
  const registry = new StreamRegistry();
  const statuses = [403, 206];
  const reasons: Array<{ reason?: string; status?: number }> = [];
  let fetchCalls = 0;
  const gateway = new StreamGateway({
    host: '127.0.0.1',
    port: 0,
    publicBaseUrl: 'http://127.0.0.1:0',
    registry,
    logger: createLogger('error'),
    fetcher: async () => {
      fetchCalls += 1;
      return new Response(fetchCalls === 1 ? null : Uint8Array.from([7]), {
        status: statuses[fetchCalls - 1] ?? 500,
        ...(fetchCalls === 2 ? { headers: { 'Content-Type': 'audio/flac' } } : {}),
      });
    },
  });
  await gateway.start();
  t.after(async () => gateway.stop());

  const registration = registry.register({
    metadata: { id: '1', title: 'Track', artists: ['Artist'], album: 'Album' },
    requestedQuality: 'lossless',
    resolve: async (request) => {
      reasons.push(request ?? {});
      return resolvedStream('https://203.0.113.10/refreshed.flac');
    },
  });

  const response = await fetch(`${gateway.localBaseUrl()}/stream/${registration.token}.flac`);
  assert.equal(response.status, 206);
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [7]);
  assert.equal(fetchCalls, 2);
  assert.deepEqual(reasons, [{}, { reason: 'upstream_expired', status: 403 }]);
});

test('gateway converts a second expired upstream response into deterministic STREAM_URL_EXPIRED', async (t) => {
  const registry = new StreamRegistry();
  let fetchCalls = 0;
  let resolveCalls = 0;
  const gateway = new StreamGateway({
    host: '127.0.0.1',
    port: 0,
    publicBaseUrl: 'http://127.0.0.1:0',
    registry,
    logger: createLogger('error'),
    fetcher: async () => {
      fetchCalls += 1;
      return new Response(null, { status: 403 });
    },
  });
  await gateway.start();
  t.after(async () => gateway.stop());

  const registration = registry.register({
    metadata: { id: '1', title: 'Track', artists: ['Artist'], album: 'Album' },
    requestedQuality: 'lossless',
    resolve: async () => {
      resolveCalls += 1;
      return resolvedStream();
    },
  });

  const response = await fetch(`${gateway.localBaseUrl()}/stream/${registration.token}.flac`);
  const body = await response.json() as { code?: string; message?: string };
  assert.equal(response.status, 502);
  assert.deepEqual(body, {
    ok: false,
    code: 'STREAM_URL_EXPIRED',
    message: 'Audio stream URL expired after one refresh',
  });
  assert.equal(fetchCalls, 2);
  assert.equal(resolveCalls, 2);
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
    `${gateway.localBaseUrl()}/stream/${registration.token}.bin`,
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
    (await fetch(`${baseUrl}/stream/${registration.token}.bin`)).status,
    206,
  );
  assert.equal(
    (await fetch(`${baseUrl}/stream/${registration.token}.bin`, { method: 'HEAD' })).status,
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
      { method: 'GET', routeClass: 'stream', proxyStream: true, mediaExtension: 'unknown' },
      { method: 'HEAD', routeClass: 'stream', proxyStream: true, mediaExtension: 'unknown' },
    ],
  );
  const serializedEvents = JSON.stringify(events);
  assert.equal(serializedEvents.includes(registration.token), false);
  assert.equal(serializedEvents.includes('track-id-must-not-be-logged'), false);
});

test('gateway serves the deterministic local PNG icon for GET and HEAD', async (t) => {
  const gateway = new StreamGateway({
    host: '127.0.0.1',
    port: 0,
    publicBaseUrl: 'http://127.0.0.1:38502',
    registry: new StreamRegistry(),
    logger: createLogger('error'),
  });
  await gateway.start();
  t.after(async () => gateway.stop());

  assert.equal(gateway.iconUrl(), 'http://127.0.0.1:38502/assets/icon.png');
  const baseUrl = gateway.localBaseUrl();
  const getResponse = await fetch(`${baseUrl}/assets/icon.png`);
  const getBytes = new Uint8Array(await getResponse.arrayBuffer());
  assert.equal(getResponse.status, 200);
  assert.equal(getResponse.headers.get('content-type'), 'image/png');
  assert.equal(getResponse.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(
    getResponse.headers.get('content-length'),
    String(getBytes.byteLength),
  );
  assert.deepEqual([...getBytes.slice(0, 8)], [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);

  const headResponse = await fetch(`${baseUrl}/assets/icon.png`, { method: 'HEAD' });
  assert.equal(headResponse.status, 200);
  assert.equal(headResponse.headers.get('content-type'), 'image/png');
  assert.equal(
    headResponse.headers.get('content-length'),
    String(getBytes.byteLength),
  );
  assert.equal(await headResponse.text(), '');
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

test('stream URLs use a format allowlist and extensions never become registry tokens', async (t) => {
  const registry = new StreamRegistry();
  let resolveCalls = 0;
  const gateway = new StreamGateway({
    host: '127.0.0.1',
    port: 0,
    publicBaseUrl: 'http://127.0.0.1:0',
    registry,
    logger: createLogger('error'),
    fetcher: async () => new Response(Uint8Array.from([1]), { status: 200 }),
  });
  await gateway.start();
  t.after(async () => gateway.stop());

  const registration = registry.register({
    metadata: { id: 'provider-track-id', title: 'Track', artists: ['Artist'], album: 'Album' },
    requestedQuality: 'standard',
    resolve: async () => {
      resolveCalls += 1;
      return { ...resolvedStream(), format: 'mp3' };
    },
  });

  assert.match(gateway.streamUrl(registration.token, 'mp3'), /\.mp3$/);
  assert.match(gateway.streamUrl(registration.token, 'flac'), /\.flac$/);
  assert.match(gateway.streamUrl(registration.token, 'not-a-format'), /\.bin$/);
  assert.equal(new URL(gateway.streamUrl(registration.token, 'mp3')).pathname.includes(`${registration.token}.mp3`), true);

  const valid = await fetch(
    `${gateway.localBaseUrl()}/stream/${registration.token}.mp3`,
  );
  assert.equal(valid.status, 200);
  assert.equal(resolveCalls, 1);

  const invalid = await fetch(
    `${gateway.localBaseUrl()}/stream/${registration.token}.exe`,
  );
  assert.equal(invalid.status, 404);
  assert.equal(resolveCalls, 1);
  assert.throws(() => registry.get(`${registration.token}.mp3`));
});

test('gateway preserves concrete audio Content-Type and falls back only for missing or octet-stream', async (t) => {
  const cases = [
    { format: 'flac', upstream: 'audio/mpeg', expected: 'audio/mpeg' },
    { format: 'mp3', upstream: 'application/octet-stream', expected: 'audio/mpeg' },
    { format: 'flac', upstream: null, expected: 'audio/flac' },
  ] as const;

  for (const item of cases) {
    const registry = new StreamRegistry();
    const gateway = new StreamGateway({
      host: '127.0.0.1',
      port: 0,
      publicBaseUrl: 'http://127.0.0.1:0',
      registry,
      logger: createLogger('error'),
      fetcher: async () =>
        new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Uint8Array.from([1, 2]));
            controller.close();
          },
        }), {
          status: 200,
          ...(item.upstream ? { headers: { 'Content-Type': item.upstream } } : {}),
        }),
    });
    await gateway.start();
    t.after(async () => gateway.stop());

    const registration = registry.register({
      metadata: { id: '1', title: 'Track', artists: ['Artist'], album: 'Album' },
      requestedQuality: 'standard',
      resolve: async () => ({ ...resolvedStream(), format: item.format }),
    });
    const response = await fetch(
      `${gateway.localBaseUrl()}/stream/${registration.token}.${item.format}`,
    );
    await response.arrayBuffer();
    assert.equal(response.headers.get('content-type'), item.expected);
    assert.equal(response.headers.get('content-length'), null);
    assert.equal(response.headers.get('content-range'), null);
  }
});

test('gateway records safe upstream and transfer telemetry for GET and HEAD', async (t) => {
  const registry = new StreamRegistry();
  const { logger, events } = recordingLogger();
  const gateway = new StreamGateway({
    host: '127.0.0.1',
    port: 0,
    publicBaseUrl: 'http://127.0.0.1:0',
    registry,
    logger,
    fetcher: async (_url, init) =>
      new Response(init.method === 'HEAD' ? null : Uint8Array.from([1, 2, 3, 4]), {
        status: 206,
        headers: {
          'Content-Type': 'audio/flac',
          'Content-Length': '4',
          'Content-Range': 'bytes 0-3/100',
          'Accept-Ranges': 'bytes',
        },
      }),
  });
  await gateway.start();
  t.after(async () => gateway.stop());

  const registration = registry.register({
    metadata: { id: 'provider-id-must-not-log', title: 'Track', artists: ['Artist'], album: 'Album' },
    requestedQuality: 'standard',
    resolve: async () => ({ ...resolvedStream(), format: 'flac' }),
  });
  const baseUrl = gateway.localBaseUrl();
  const getResponse = await fetch(`${baseUrl}/stream/${registration.token}.flac`, {
    headers: { Range: 'bytes=0-3' },
  });
  await getResponse.arrayBuffer();
  const headResponse = await fetch(`${baseUrl}/stream/${registration.token}.flac`, {
    method: 'HEAD',
  });
  await headResponse.arrayBuffer();

  const upstreamEvents = events.filter(({ event }) => event === 'roon_gateway_upstream_response');
  assert.deepEqual(upstreamEvents[0]?.fields, {
    method: 'GET',
    rangePresent: true,
    rangeClass: 'start-end',
    upstreamStatus: 206,
    contentTypeClass: 'audio-flac',
    contentLengthPresent: true,
    contentLengthBytes: 4,
    contentRangePresent: true,
    acceptRangesPresent: true,
    mediaExtension: 'flac',
    transportSecurity: 'https-native',
  });
  assert.equal(upstreamEvents[1]?.fields.method, 'HEAD');
  assert.equal(upstreamEvents[1]?.fields.rangeClass, 'none');

  const transferEvents = events.filter(({ event }) => event === 'roon_gateway_transfer_complete');
  assert.equal(transferEvents[0]?.fields.method, 'GET');
  assert.equal(transferEvents[0]?.fields.bytesForwarded, 4);
  assert.equal(transferEvents[0]?.fields.outcome, 'finished');
  assert.equal(transferEvents[0]?.fields.responseFinished, true);
  assert.equal(typeof transferEvents[0]?.fields.responseClosed, 'boolean');
  assert.equal(transferEvents[1]?.fields.method, 'HEAD');
  assert.equal(transferEvents[1]?.fields.bytesForwarded, 0);
  assert.equal(transferEvents[1]?.fields.outcome, 'headers-only');

  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes(registration.token), false);
  assert.equal(serialized.includes('provider-id-must-not-log'), false);
  assert.equal(serialized.includes('https://'), false);
  assert.equal(serialized.includes('bytes=0-3'), false);
});

test('gateway reports pipeline-error without logging upstream error text', async (t) => {
  const registry = new StreamRegistry();
  const { logger, events } = recordingLogger();
  const gateway = new StreamGateway({
    host: '127.0.0.1',
    port: 0,
    publicBaseUrl: 'http://127.0.0.1:0',
    registry,
    logger,
    fetcher: async () =>
      new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Uint8Array.from([1]));
          setImmediate(() => controller.error(new Error('upstream-secret-detail')));
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'audio/mpeg' },
      }),
  });
  await gateway.start();
  t.after(async () => gateway.stop());

  const registration = registry.register({
    metadata: { id: '1', title: 'Track', artists: ['Artist'], album: 'Album' },
    requestedQuality: 'standard',
    resolve: async () => ({ ...resolvedStream(), format: 'mp3' }),
  });
  await assert.rejects(() =>
    fetch(`${gateway.localBaseUrl()}/stream/${registration.token}.mp3`).then((response) => response.arrayBuffer()),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  const transfer = events.find(({ event }) => event === 'roon_gateway_transfer_complete');
  assert.equal(transfer?.fields.outcome, 'pipeline-error');
  assert.equal(JSON.stringify(events).includes('upstream-secret-detail'), false);
});

test('gateway records client-aborted when the downstream request is closed mid-transfer', async (t) => {
  const registry = new StreamRegistry();
  const { logger, events } = recordingLogger();
  const gateway = new StreamGateway({
    host: '127.0.0.1',
    port: 0,
    publicBaseUrl: 'http://127.0.0.1:0',
    registry,
    logger,
    fetcher: async () =>
      new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Uint8Array.from([1, 2, 3]));
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'audio/mpeg' },
      }),
  });
  await gateway.start();
  t.after(async () => gateway.stop());

  const registration = registry.register({
    metadata: { id: '1', title: 'Track', artists: ['Artist'], album: 'Album' },
    requestedQuality: 'standard',
    resolve: async () => ({ ...resolvedStream(), format: 'mp3' }),
  });
  await new Promise<void>((resolve, reject) => {
    const request = httpRequest(
      `${gateway.localBaseUrl()}/stream/${registration.token}.mp3`,
      (response) => {
        response.once('data', () => {
          request.destroy();
          resolve();
        });
        response.once('error', () => undefined);
      },
    );
    request.once('error', (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error);
    });
    request.end();
  });

  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (events.some(({ event, fields }) =>
      event === 'roon_gateway_transfer_complete' && fields.outcome === 'client-aborted')) {
      break;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const transfer = events.find(({ event }) => event === 'roon_gateway_transfer_complete');
  assert.equal(transfer?.fields.outcome, 'client-aborted');
});
