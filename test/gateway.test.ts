import assert from 'node:assert/strict';
import test from 'node:test';
import { createLogger } from '../src/shared/logger.js';
import { StreamGateway } from '../src/stream/gateway.js';
import { StreamRegistry } from '../src/stream/registry.js';
import type { GatewayFetch } from '../src/stream/upstream-policy.js';

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
