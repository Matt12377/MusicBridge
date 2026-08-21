import assert from 'node:assert/strict';
import test from 'node:test';
import type { PublicBridgeState } from '@music-bridge/contracts';
import { toPublicBridgeState } from '../src/runtime.js';

test('runtime maps internal BridgeState to a bounded public state', () => {
  const state = toPublicBridgeState(
    {
      neteaseConfigured: true,
      roon: { status: 'playing', coreName: 'hidden core' },
      activeStreamCount: 1,
      activePlayback: {
        track: {
          id: 'hidden-track',
          title: 'hidden title',
          artists: ['hidden artist'],
          album: 'hidden album',
        },
        requestedQuality: 'lossless',
        actualQuality: 'lossless',
        startedAt: new Date(0).toISOString(),
      },
    },
    'ready',
  );

  const expected: PublicBridgeState = {
    runtime: 'ready',
    roon: 'ready',
    provider: 'configured',
    activeStreamCount: 1,
    activePlaybackPresent: true,
  };
  assert.deepEqual(state, expected);
  assert.doesNotMatch(JSON.stringify(state), /hidden/);
});
