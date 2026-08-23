import assert from 'node:assert/strict';
import test from 'node:test';

import type { PlaybackSnapshot } from '@music-bridge/contracts';
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
    assert.deepEqual(calls, ['replace:0:2', 'next', 'previous']);
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
