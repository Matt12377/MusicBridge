import assert from 'node:assert/strict';
import test from 'node:test';
import { BridgeController } from '../src/application/bridge-controller.js';
import { BridgeError } from '../src/shared/errors.js';
import type {
  NeteasePort,
  QualityLevel,
  ResolvedAudioStream,
} from '../src/netease/types.js';
import type { RoonPlayRequest, RoonPort, RoonState } from '../src/roon/types.js';
import { createLogger } from '../src/shared/logger.js';
import { StreamGateway } from '../src/stream/gateway.js';
import { StreamRegistry } from '../src/stream/registry.js';

class FakeNetease implements NeteasePort {
  readonly configured = true;
  resolveCalls = 0;
  readonly unavailableTrackIds = new Set<string>();

  async searchTracks() {
    return { items: [], offset: 0, limit: 10, total: 0, hasMore: false };
  }

  async getLikedTracks() {
    return { items: [], offset: 0, limit: 10, total: 0, hasMore: false };
  }

  async getUserPlaylists() {
    return [];
  }

  async getPlaylist() {
    return {
      id: '1',
      name: 'Synthetic Playlist',
      trackCount: 0,
      tracks: { items: [], offset: 0, limit: 10, total: 0, hasMore: false },
    };
  }

  async getTrack(trackId: string) {
    if (this.unavailableTrackIds.has(trackId)) {
      throw new BridgeError('TRACK_UNAVAILABLE', 'Synthetic track is unavailable', {
        httpStatus: 409,
      });
    }
    return {
      id: trackId,
      title: 'Test Song',
      artists: ['Artist'],
      album: 'Album',
      durationMs: 120000,
    };
  }

  async resolveStream(
    trackId: string,
    quality: QualityLevel,
  ): Promise<ResolvedAudioStream> {
    this.resolveCalls += 1;
    if (this.unavailableTrackIds.has(trackId)) {
      throw new BridgeError('TRACK_UNAVAILABLE', 'Synthetic track is unavailable', {
        httpStatus: 409,
      });
    }
    return {
      trackId,
      upstreamUrl: 'https://cdn.example/audio.flac',
      requestedQuality: quality,
      transportSecurity: 'https-upgraded',
      actualQuality: 'lossless',
      format: 'flac',
      expiresInSeconds: 600,
    };
  }
}

class FakeRoon implements RoonPort {
  playRequest: RoonPlayRequest | undefined;
  readonly playRequests: RoonPlayRequest[] = [];
  stopCalls = 0;
  activePlayCalls = 0;
  maxConcurrentPlayCalls = 0;
  playDelayMs = 0;
  shouldFail = false;
  shouldFailOnStop = false;
  terminalDuringPlay = false;
  terminalHandler: (reason: 'ended' | 'stopped' | 'media_error' | 'zone_lost') => void = () => undefined;
  state: RoonState = {
    status: 'ready',
    selectedZoneId: 'zone-1',
    selectedZoneName: 'Living Room',
  };

  constructor(private readonly events: string[] = []) {}

  setTerminalHandler(handler: (reason: 'ended' | 'stopped' | 'media_error' | 'zone_lost') => void): void {
    this.terminalHandler = handler;
  }

  emitTerminal(reason: 'ended' | 'stopped' | 'media_error' | 'zone_lost'): void {
    this.terminalHandler(reason);
  }

  async start(): Promise<void> {}

  async play(request: RoonPlayRequest): Promise<void> {
    this.events.push('roon.play');
    this.playRequest = request;
    this.playRequests.push(request);
    this.activePlayCalls += 1;
    this.maxConcurrentPlayCalls = Math.max(
      this.maxConcurrentPlayCalls,
      this.activePlayCalls,
    );
    if (this.playDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.playDelayMs));
    }
    this.activePlayCalls -= 1;
    if (this.shouldFail) throw new Error('Roon failed');
    this.state = { ...this.state, status: 'playing' };
    if (this.terminalDuringPlay) this.terminalHandler('media_error');
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    if (this.shouldFailOnStop) throw new Error('Roon stop failed');
    this.state = { ...this.state, status: 'ready' };
  }

  async shutdown(): Promise<void> {}

  getState(): RoonState {
    return { ...this.state };
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error('Timed out waiting for synthetic playback condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function makeHarness(preflightStatus = 206) {
  const registry = new StreamRegistry();
  const events: string[] = [];
  const gateway = new StreamGateway({
    host: '127.0.0.1',
    port: 0,
    publicBaseUrl: 'http://127.0.0.1:38502',
    registry,
    logger: createLogger('error'),
    fetcher: async (_url, _init) => {
      events.push('gateway.preflight');
      return new Response(null, { status: preflightStatus });
    },
  });
  const netease = new FakeNetease();
  const roon = new FakeRoon(events);
  const controller = new BridgeController({
    netease,
    roon,
    registry,
    gateway,
    logger: createLogger('error'),
    now: () => 1_700_000_000_000,
  });
  return { registry, gateway, netease, roon, controller, events };
}

test('controller registers a local stream, starts Roon and reports actual quality', async () => {
  const { controller, registry, roon, events } = makeHarness();
  const state = await controller.play({ trackId: '123', quality: 'lossless' });

  assert.equal(registry.size, 1);
  assert.match(
    roon.playRequest?.mediaUrl ?? '',
    /^http:\/\/127\.0\.0\.1:38502\/stream\/[A-Za-z0-9_-]+\.flac$/,
  );
  assert.equal(roon.playRequest?.metadata.title, 'Test Song');
  assert.equal(roon.playRequest?.gatewayStage?.(), 'none');
  assert.equal(state.activePlayback?.requestedQuality, 'lossless');
  assert.equal(state.activePlayback?.actualQuality, 'lossless');
  assert.equal(state.activePlayback?.transportSecurity, 'https-upgraded');
  assert.deepEqual(events, ['gateway.preflight', 'roon.play']);

  await controller.stop();
  assert.equal(registry.size, 0);
  assert.equal(controller.getState().activePlayback, undefined);
});

test('controller attaches an explicit gateway stage context to the Roon request', async () => {
  const { controller, roon } = makeHarness();
  await controller.play({ trackId: '123', quality: 'lossless' });

  assert.equal(roon.playRequest?.gatewayStage?.(), 'none');
});

test('controller rejects preflight failure before registering a token or starting Roon', async () => {
  const { controller, registry, roon, events } = makeHarness(503);

  await assert.rejects(
    () => controller.play({ trackId: '123', quality: 'standard' }),
    (error: unknown) =>
      error instanceof Error && error.message.includes('UPSTREAM_HTTPS_UNAVAILABLE'),
  );

  assert.deepEqual(events, ['gateway.preflight']);
  assert.equal(roon.playRequest, undefined);
  assert.equal(registry.size, 0);
  assert.equal(controller.getState().activePlayback, undefined);
  assert.equal(controller.getState().activeStreamCount, 0);
});

test('controller stop is idempotent after playback has already been cleared', async () => {
  const { controller, registry, roon } = makeHarness();
  await controller.play({ trackId: '123', quality: 'standard' });

  await controller.stop();
  roon.shouldFailOnStop = true;

  const state = await controller.stop();

  assert.equal(roon.stopCalls, 1);
  assert.equal(registry.size, 0);
  assert.equal(state.activeStreamCount, 0);
  assert.equal(state.activePlayback, undefined);
});

test('controller revokes stream token when Roon start fails', async () => {
  const { controller, registry, roon } = makeHarness();
  roon.shouldFail = true;
  await assert.rejects(() =>
    controller.play({ trackId: '123', quality: 'lossless' }),
  );
  assert.equal(registry.size, 0);
});


test('controller revokes stream token when Roon reports a terminal event', async () => {
  const { controller, registry, roon } = makeHarness();
  await controller.play({ trackId: '123', quality: 'lossless' });
  assert.equal(registry.size, 1);
  roon.emitTerminal('ended');
  await waitFor(() => registry.size === 0);
  assert.equal(registry.size, 0);
  assert.equal(controller.getState().activePlayback, undefined);
});


test('controller does not resurrect playback state if Roon terminates during startup', async () => {
  const { controller, registry, roon } = makeHarness();
  roon.terminalDuringPlay = true;
  await assert.rejects(() =>
    controller.play({ trackId: '123', quality: 'lossless' }),
  );
  assert.equal(registry.size, 0);
  assert.equal(controller.getState().activePlayback, undefined);
});

test('controller replaces the queue and next/previous move one item at a time', async () => {
  const { controller, roon, registry } = makeHarness();

  await controller.replaceQueue([
    { trackId: '101', quality: 'standard' },
    { trackId: '102', quality: 'lossless' },
    { trackId: '103', quality: 'exhigh' },
  ]);
  assert.equal(roon.playRequests.length, 1);
  assert.equal(roon.playRequests[0]!.metadata.id, '101');

  await controller.next();
  assert.equal(roon.playRequests.length, 2);
  assert.equal(roon.playRequests[1]!.metadata.id, '102');

  await controller.previous();
  assert.equal(roon.playRequests.length, 3);
  assert.equal(roon.playRequests[2]!.metadata.id, '101');
  assert.equal(registry.size, 1);
});

test('controller serializes rapid queue controls and keeps one active stream', async () => {
  const { controller, roon, registry } = makeHarness();
  roon.playDelayMs = 10;

  const replacing = controller.replaceQueue([
    { trackId: '201', quality: 'standard' },
    { trackId: '202', quality: 'standard' },
  ]);
  const advancing = controller.next();
  await Promise.all([replacing, advancing]);

  assert.equal(roon.maxConcurrentPlayCalls, 1);
  assert.deepEqual(
    roon.playRequests.map((request) => request.metadata.id),
    ['201', '202'],
  );
  assert.equal(registry.size, 1);
});

test('natural end automatically advances and end of queue stops without residue', async () => {
  const { controller, roon, registry } = makeHarness();

  await controller.replaceQueue([
    { trackId: '301', quality: 'standard' },
    { trackId: '302', quality: 'standard' },
  ]);
  roon.emitTerminal('ended');
  await waitFor(() => roon.playRequests.length === 2);
  assert.equal(roon.playRequests[1]!.metadata.id, '302');
  assert.equal(registry.size, 1);

  roon.emitTerminal('ended');
  await waitFor(() => registry.size === 0);
  assert.equal(controller.getState().activePlayback, undefined);
});

test('unavailable queue items are skipped and all-unavailable queues stop cleanly', async () => {
  const { controller, netease, roon, registry } = makeHarness();
  netease.unavailableTrackIds.add('401');

  await controller.replaceQueue([
    { trackId: '401', quality: 'standard' },
    { trackId: '402', quality: 'standard' },
  ]);
  assert.deepEqual(
    roon.playRequests.map((request) => request.metadata.id),
    ['402'],
  );
  assert.equal(registry.size, 1);

  netease.unavailableTrackIds.add('403');
  await controller.replaceQueue([{ trackId: '403', quality: 'standard' }]);
  assert.equal(registry.size, 0);
  assert.equal(controller.getState().activePlayback, undefined);
  assert.equal(controller.getPlaybackState().lastError, 'TRACK_UNAVAILABLE');
});

test('ten naturally ended tracks leave no stream token or active playback', async () => {
  const { controller, roon, registry } = makeHarness();
  const items = Array.from({ length: 10 }, (_, index) => ({
    trackId: String(501 + index),
    quality: 'lossless' as const,
  }));

  await controller.replaceQueue(items);
  for (let index = 0; index < items.length; index += 1) {
    roon.emitTerminal('ended');
    await waitFor(() => roon.playRequests.length === index + 2 || registry.size === 0);
  }

  await waitFor(() => registry.size === 0);
  assert.equal(controller.getState().activePlayback, undefined);
  assert.equal(controller.getState().activeStreamCount, 0);
  assert.equal(roon.playRequests.length, 10);
});
