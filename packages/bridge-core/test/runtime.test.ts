import assert from 'node:assert/strict';
import test from 'node:test';
import type { PublicBridgeState } from '@music-bridge/contracts';
import { createTestBridgeRuntime, toPublicBridgeState } from '../src/runtime.js';

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

test('synthetic runtime exposes redacted diagnostics and clears resources on stop', async () => {
  const runtime = createTestBridgeRuntime();
  await runtime.start();
  await runtime.replacePlaybackQueue(
    Array.from({ length: 100 }, (_, index) => ({
      trackId: String(1000 + index),
      quality: 'lossless' as const,
    })),
    0,
  );

  const playing = runtime.getDiagnostics();
  assert.equal(playing.component, 'core');
  assert.equal(playing.counters.queueItemCount, 100);
  assert.equal(playing.counters.activePlaybackCount, 1);
  assert.equal(playing.counters.activeTokenCount, 0);
  assert.equal(playing.gates.find((gate) => gate.name === 'queue-state-machine')?.status, 'pass');
  assert.doesNotMatch(JSON.stringify(playing), /Synthetic Track|1000|trackId|zoneId|https?:\/\//i);

  await runtime.shutdown();
  const stopped = runtime.getDiagnostics();
  assert.equal(stopped.health.runtime, 'stopped');
  assert.equal(stopped.health.roon, 'disconnected');
  assert.equal(stopped.counters.activePlaybackCount, 0);
  assert.equal(stopped.counters.activeSessionCount, 0);
  assert.equal(stopped.counters.activeTokenCount, 0);
  assert.equal(stopped.counters.listenerCount, 0);
  assert.equal(stopped.counters.timerCount, 0);
  assert.equal(stopped.gates.find((gate) => gate.name === 'resource-cleanup')?.status, 'pass');
});

test('synthetic runtime exposes bounded account and daily recommendation seams', async () => {
  const runtime = createTestBridgeRuntime();
  await runtime.start();

  assert.deepEqual(runtime.getAccountState(), {
    status: 'missing',
  });
  await runtime.setProviderCredential('synthetic-credential');
  assert.deepEqual(runtime.getAccountState(), {
    status: 'ready',
    profile: {
      displayName: 'Synthetic Listener',
      avatarUrl: 'https://p1.music.126.net/synthetic-avatar.jpg',
    },
  });
  const recommendations = await runtime.getDailyRecommendations();
  assert.equal(recommendations.tracks.length, 12);
  assert.equal(recommendations.tracks[0]?.recommendationReason, 'Synthetic taste match');
  assert.doesNotMatch(JSON.stringify(recommendations), /cookie|userId|rawProvider/i);

  await runtime.logoutProvider();
  assert.deepEqual(runtime.getAccountState(), { status: 'missing' });
  assert.deepEqual(await runtime.getDailyRecommendations(), {
    dayKey: recommendations.dayKey,
    tracks: [],
  });
});

test('synthetic runtime keeps daily recommendations when profile is unavailable', async () => {
  const runtime = createTestBridgeRuntime({ authorized: true, accountMode: 'profile-unavailable' });
  await runtime.start();

  assert.deepEqual(runtime.getAuthState(), { status: 'authorized' });
  assert.deepEqual(runtime.getAccountState(), { status: 'unavailable' });
  assert.equal((await runtime.getDailyRecommendations()).tracks.length, 12);
});

test('synthetic runtime clears public account and daily recommendations after expiry', async () => {
  const runtime = createTestBridgeRuntime({ authorized: true, accountMode: 'expired' });
  await runtime.start();

  assert.deepEqual(runtime.getAuthState(), { status: 'expired' });
  assert.deepEqual(runtime.getAccountState(), { status: 'missing' });
  assert.deepEqual(await runtime.getDailyRecommendations(), {
    dayKey: new Date().toISOString().slice(0, 10),
    tracks: [],
  });
});
