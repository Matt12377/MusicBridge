import assert from 'node:assert/strict';
import test from 'node:test';
import { request as httpRequest, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';

import type { PlaybackSnapshot, RoonImageResult, RoonLibraryPage } from '@music-bridge/contracts';
import { ControlServer } from '../src/control/server.js';
import type { BridgeState } from '../src/application/bridge-controller.js';
import type { Logger } from '../src/shared/logger.js';

const logger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function playbackState(): PlaybackSnapshot {
  return {
    state: 'idle',
    queue: { items: [], index: -1, hasNext: false, hasPrevious: false },
    positionMs: 0,
    canNext: false,
    canPrevious: false,
    canStop: false,
    canPause: false,
    canResume: false,
  };
}

function bridgeState(): BridgeState {
  return {
    neteaseConfigured: true,
    roon: { status: 'ready', selectedZoneId: 'zone-1' },
    activeStreamCount: 0,
  };
}

function makeController() {
  const calls: string[] = [];
  let snapshot = playbackState();
  return {
    calls,
    controller: {
      getState: () => bridgeState(),
      getPlaybackState: () => snapshot,
      async play() {
        calls.push('play');
        return bridgeState();
      },
      async stop() {
        calls.push('stop');
        return bridgeState();
      },
      async pause() {
        calls.push('pause');
        return bridgeState();
      },
      async resume() {
        calls.push('resume');
        return bridgeState();
      },
      async replaceQueue(items: readonly { trackId: unknown; quality: unknown }[], index: number) {
        calls.push(`replace:${index}:${items.length}`);
        snapshot = {
          ...snapshot,
          state: 'playing',
          queue: {
            items: items.map((item) => ({
              trackId: String(item.trackId),
              qualityPreference: item.quality as 'lossless',
            })),
            index,
            hasNext: index < items.length - 1,
            hasPrevious: index > 0,
          },
          canNext: index < items.length - 1,
          canPrevious: index > 0,
          canStop: true,
          canPause: true,
          canResume: false,
        };
        return bridgeState();
      },
      async next() {
        calls.push('next');
        return bridgeState();
      },
      async previous() {
        calls.push('previous');
        return bridgeState();
      },
    },
  };
}

test('MBR002：Control拒绝跨来源/伪造Host/非JSON写入，保留无Origin的本机工具', async t => {
  const { controller, calls } = makeController();
  const server = new ControlServer({ host: '127.0.0.1', port: 0, defaultQuality: 'auto', controller, logger });
  await server.start(); t.after(() => server.stop());
  const port = server.getListeningPort()!;
  const post = (headers: Record<string, string>, body = '') => new Promise<number>((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path: '/v1/pause', method: 'POST', headers }, response => {
      response.resume(); response.once('end', () => resolve(response.statusCode!));
    }); request.once('error', reject); request.end(body);
  });
  assert.equal(await post({ Origin: 'https://external.example', 'Content-Type': 'application/json' }, '{}'), 403);
  assert.equal(await post({ Host: `external.example:${port}` }), 403);
  assert.equal(await post({ 'Content-Type': 'text/plain' }, '{}'), 415);
  assert.equal(await post({ Origin: 'null' }), 403);
  assert.equal(await post({ 'Sec-Fetch-Site': 'cross-site' }), 403);
  assert.equal(await post({ Host: `127.0.0.1:${port + 1}` }), 403);
  assert.equal(await post({ 'Content-Type': 'application/json' }, '[]'), 400);
  assert.equal(await post({ 'Content-Type': 'application/json' }, ' '.repeat(64 * 1024) + '{}'), 413);
  assert.deepEqual(calls, []);
  assert.equal(await post({}), 200);
  assert.equal(await post({ Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json; charset=utf-8' }, '{}'), 200);
  assert.deepEqual(calls, ['pause', 'pause']);
});

test('MBR002：Control本身拒绝非loopback绑定', async () => {
  assert.throws(() => new ControlServer({ host: '0.0.0.0', port: 0, defaultQuality: 'auto', controller: makeController().controller, logger }));
});

test('MBR002：慢请求体有截止期限，关闭不会等待迟到请求派发播放', async t => {
  const { controller, calls } = makeController();
  const server = new ControlServer({ host: '127.0.0.1', port: 0, defaultQuality: 'auto', controller, logger, bodyTimeoutMs: 30, stopTimeoutMs: 100 });
  const sockets: Socket[] = [];
  await server.start(); t.after(() => { for (const value of sockets) value.destroy(); return server.stop(); });
  const port = server.getListeningPort()!, socket = connect(port, '127.0.0.1');
  sockets.push(socket); socket.resume();
  t.after(() => socket.destroy());
  await new Promise<void>(resolve => socket.once('connect', resolve));
  const ended = new Promise<void>(resolve => socket.once('close', () => resolve()));
  socket.on('error', () => {});
  socket.write(`POST /v1/play HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
  const outcome = await Promise.race([ended.then(() => 'closed'), new Promise(resolve => setTimeout(() => resolve('late'), 500))]);
  assert.equal(outcome, 'closed'); assert.deepEqual(calls, []);
  const second = connect(port, '127.0.0.1'); t.after(() => second.destroy()); second.on('error', () => {});
  sockets.push(second); second.resume();
  await new Promise<void>(resolve => second.once('connect', resolve));
  const ownedServer = (server as unknown as { server: Server }).server;
  const bodyEntered = new Promise<void>(resolve => ownedServer.once('request', () => resolve()));
  second.write(`POST /v1/pause HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{`);
  await bodyEntered;
  const stopping = server.stop(); second.write('}'); await stopping;
  assert.deepEqual(calls, []);
});

test('MBR002：listen尚未完成时并发stop不会遗留晚到监听器', async t => {
  const server = new ControlServer({ host: '127.0.0.1', port: 0, defaultQuality: 'auto', controller: makeController().controller, logger });
  const starting = server.start();
  // 即使断言失败，也收尾已创建的原始服务器，避免失败夹具遗留端口。
  const ownedServer = (server as unknown as { server: Server }).server;
  t.after(async () => {
    await starting.catch(() => {});
    if (ownedServer.listening) await new Promise<void>((resolve, reject) => ownedServer.close(error => error ? reject(error) : resolve()));
    await server.stop().catch(() => {});
  });
  const outcomes = await Promise.allSettled([starting, server.stop()]);
  assert.equal(outcomes[1]!.status, 'fulfilled');
  assert.equal(ownedServer.listening, false);
  assert.equal(server.getListeningPort(), undefined);
});

test('MBR002：未完成请求头也有截止期限，不占用连接直到常规30秒检查', async t => {
  const { controller, calls } = makeController();
  const server = new ControlServer({ host: '127.0.0.1', port: 0, defaultQuality: 'auto', controller, logger, headersTimeoutMs: 30, stopTimeoutMs: 100 });
  await server.start();
  const socket = connect(server.getListeningPort()!, '127.0.0.1');
  t.after(() => { socket.destroy(); return server.stop(); });
  socket.on('error', () => {}); socket.resume();
  await new Promise<void>(resolve => socket.once('connect', resolve));
  const ended = new Promise<void>(resolve => socket.once('close', () => resolve()));
  socket.write('POST /v1/play HTTP/1.1\r\nHost: 127.0.0.1:');
  const outcome = await Promise.race([ended.then(() => 'closed'), new Promise(resolve => setTimeout(() => resolve('late'), 500))]);
  assert.equal(outcome, 'closed'); assert.deepEqual(calls, []);
});

function makeRoonController() {
  const seekPositions: number[] = [];
  const page: RoonLibraryPage = {
    items: [{ reference: 'album-ref', kind: 'album', title: 'Album' }],
    offset: 0,
    limit: 1,
    total: 1,
    hasMore: false,
  };
  const image: RoonImageResult = {
    contentType: 'image/jpeg',
    body: new Uint8Array([1, 2, 3]),
  };
  return {
    seekPositions,
    listZones: () => [{ zoneId: 'zone-1', displayName: 'Zone', selected: false }],
    selectZone: async (_zoneId: string) => ({
      runtime: 'ready' as const,
      roon: 'ready' as const,
      provider: 'configured' as const,
      activeStreamCount: 0,
      activePlaybackPresent: false,
    }),
    browseRoonAlbums: async (_page: { offset: number; limit: number }) => page,
    browseRoonAlbum: async (_reference: string, _page: { offset: number; limit: number }) => page,
    getRoonImage: async (_reference: string) => image,
    seekRoonTransport: async (positionMs: number) => {
      seekPositions.push(positionMs);
      return { positionMs };
    },
  };
}

async function request(server: ControlServer, path: string, init?: RequestInit): Promise<Response> {
  const port = server.getListeningPort();
  assert.ok(port);
  return fetch(`http://127.0.0.1:${port}${path}`, init);
}

test('Control API exposes queue replacement, navigation and sanitized playback state', async () => {
  const { controller, calls } = makeController();
  const server = new ControlServer({
    host: '127.0.0.1',
    port: 0,
    defaultQuality: 'standard',
    controller,
    logger,
  });
  await server.start();

  try {
    const replaceResponse = await request(server, '/v1/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [
          { trackId: '101', quality: 'lossless' },
          { trackId: '102', quality: 'standard' },
        ],
        index: 0,
      }),
    });
    assert.equal(replaceResponse.status, 200);
    assert.equal((await replaceResponse.json()).state.queue.items.length, 2);

    const playbackResponse = await request(server, '/v1/playback');
    assert.equal(playbackResponse.status, 200);
    assert.equal((await playbackResponse.json()).state.queue.index, 0);

    assert.equal((await request(server, '/v1/next', { method: 'POST' })).status, 200);
    assert.equal((await request(server, '/v1/previous', { method: 'POST' })).status, 200);
    assert.equal((await request(server, '/v1/pause', { method: 'POST' })).status, 200);
    assert.equal((await request(server, '/v1/resume', { method: 'POST' })).status, 200);
    assert.deepEqual(calls, ['replace:0:2', 'next', 'previous', 'pause', 'resume']);
  } finally {
    await server.stop();
  }
});

test('Control API rejects malformed queues before invoking playback', async () => {
  const { controller, calls } = makeController();
  const server = new ControlServer({
    host: '127.0.0.1',
    port: 0,
    defaultQuality: 'standard',
    controller,
    logger,
  });
  await server.start();

  try {
    const response = await request(server, '/v1/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ trackId: '101', quality: 'invalid' }], index: 0 }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(calls, []);
  } finally {
    await server.stop();
  }
});

test('Control API exposes typed read-only Roon browse, zones and image routes', async () => {
  const { controller } = makeController();
  const server = new ControlServer({
    host: '127.0.0.1',
    port: 0,
    defaultQuality: 'standard',
    controller,
    roon: makeRoonController(),
    logger,
  });
  await server.start();

  try {
    const zones = await request(server, '/v1/roon/zones');
    assert.equal(zones.status, 200);
    assert.equal((await zones.json()).zones.length, 1);

    const albums = await request(server, '/v1/roon/albums?offset=0&limit=1');
    assert.equal(albums.status, 200);
    assert.equal((await albums.json()).items[0].kind, 'album');

    const tracks = await request(server, '/v1/roon/album?reference=album-ref&offset=0&limit=1');
    assert.equal(tracks.status, 200);
    assert.equal((await tracks.json()).items[0].reference, 'album-ref');

    const image = await request(server, '/v1/roon/image?reference=art-ref&width=64&height=64&format=image/jpeg');
    assert.equal(image.status, 200);
    assert.deepEqual(await image.json(), {
      ok: true,
      contentType: 'image/jpeg',
      bodyBase64: 'AQID',
    });

    const roon = makeRoonController();
    const seekServer = new ControlServer({
      host: '127.0.0.1',
      port: 0,
      defaultQuality: 'standard',
      controller,
      roon,
      logger,
    });
    await seekServer.start();
    try {
      const seek = await request(seekServer, '/v1/roon/seek', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positionMs: 12_345 }),
      });
      assert.equal(seek.status, 200);
      assert.deepEqual(await seek.json(), { ok: true, positionMs: 12_345 });
      assert.deepEqual(roon.seekPositions, [12_345]);

      const invalidSeek = await request(seekServer, '/v1/roon/seek', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positionMs: -1 }),
      });
      assert.equal(invalidSeek.status, 400);
      assert.deepEqual(roon.seekPositions, [12_345]);
    } finally {
      await seekServer.stop();
    }
  } finally {
    await server.stop();
  }
});
