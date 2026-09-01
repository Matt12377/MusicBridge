import assert from 'node:assert/strict';
import test from 'node:test';
import { BridgeController } from '../src/application/bridge-controller.js';
import { BridgeError } from '../src/shared/errors.js';
import type {
  NeteasePort,
  QualityLevel,
  ResolvedAudioStream,
} from '../src/netease/types.js';
import type {
  RoonPlayRequest,
  RoonPlaybackObservation,
  RoonPort,
  RoonState,
  RoonTimeEvent,
} from '../src/roon/types.js';
import { createLogger } from '../src/shared/logger.js';
import { StreamGateway } from '../src/stream/gateway.js';
import { StreamRegistry } from '../src/stream/registry.js';
import { LyricsCoordinator, createLyricsRequestContext } from '../src/lyrics/coordinator.js';
import { LyricsMatchResolver } from '../src/lyrics-matching/resolver.js';
import { createLyricsMatchRepository } from '../src/lyrics-matching/repository.js';

class FakeNetease implements NeteasePort {
  readonly configured = true;
  resolveCalls = 0;
  actualQuality = 'lossless';
  authExpired = false;
  readonly unavailableTrackIds = new Set<string>();
  readonly previewOnlyTrackIds = new Set<string>();
  readonly blockedMetadataTrackIds = new Set<string>();
  metadataStarted = false;
  metadataGate: Promise<void> | undefined;

  async searchTracks() {
    return { items: [], offset: 0, limit: 10, total: 0, hasMore: false };
  }

  async searchArtists() {
    return { items: [], offset: 0, limit: 10, total: 0, hasMore: false };
  }

  async searchAlbums() {
    return { items: [], offset: 0, limit: 10, total: 0, hasMore: false };
  }

  async getArtist() {
    return { id: '7', name: 'Artist', tracks: { items: [], offset: 0, limit: 10, total: 0, hasMore: false } };
  }

  async getAlbum() {
    return { id: '9', name: 'Album', artistName: 'Artist', tracks: { items: [], offset: 0, limit: 10, total: 0, hasMore: false } };
  }

  async getLikedTracks() {
    return { items: [], offset: 0, limit: 10, total: 0, hasMore: false };
  }

  async isTrackLiked() {
    return { liked: false };
  }

  async likeTrack(_trackId: string, liked: boolean) {
    return { liked };
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

  async getPublicAccountProfile() {
    return { displayName: 'Synthetic Listener' };
  }

  async getDailyRecommendations() {
    return { dayKey: '2026-08-22', tracks: [] };
  }

  async getTrack(trackId: string) {
    this.metadataStarted = true;
    if (
      this.blockedMetadataTrackIds.size === 0 ||
      this.blockedMetadataTrackIds.has(trackId)
    ) await this.metadataGate;
    if (this.authExpired) {
      throw new BridgeError('AUTH_EXPIRED', 'Synthetic expired session', { httpStatus: 401 });
    }
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
    if (this.previewOnlyTrackIds.has(trackId)) {
      throw new BridgeError('TRACK_PREVIEW_ONLY', 'Synthetic track is preview only', {
        httpStatus: 409,
      });
    }
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
      actualQuality: this.actualQuality,
      format: 'flac',
      expiresInSeconds: 600,
    };
  }
}

class FakeRoon implements RoonPort {
  playRequest: RoonPlayRequest | undefined;
  readonly playRequests: RoonPlayRequest[] = [];
  stopCalls = 0;
  pauseCalls = 0;
  resumeCalls = 0;
  readonly seekCalls: number[] = [];
  activePlayCalls = 0;
  maxConcurrentPlayCalls = 0;
  playDelayMs = 0;
  shouldFail = false;
  shouldFailOnStop = false;
  terminalDuringPlay = false;
  autoConfirmPause = true;
  autoConfirmResume = true;
  failPause = false;
  failResume = false;
  activePlaybackEpoch = 17;
  zoneRevision = 1;
  private confirmPauseRequest: (() => void) | undefined;
  private confirmResumeRequest: (() => void) | undefined;
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
    request.onStartupStage?.('roon-session-began');
    if (this.playDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.playDelayMs));
    }
    this.activePlayCalls -= 1;
    if (this.shouldFail) throw new Error('Roon failed');
    this.state = {
      ...this.state,
      status: 'playing',
      transportState: 'playing',
      canPause: true,
      canResume: false,
    };
    request.onStartupStage?.('roon-playing');
    if (this.terminalDuringPlay) this.terminalHandler('media_error');
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    if (this.shouldFailOnStop) throw new Error('Roon stop failed');
    this.state = { ...this.state, status: 'ready', transportState: 'stopped' };
  }

  async pause(): Promise<void> {
    this.pauseCalls += 1;
    if (this.failPause) {
      throw new BridgeError('ROON_TIMEOUT', 'Synthetic pause confirmation timed out', {
        httpStatus: 504,
      });
    }
    if (!this.autoConfirmPause) {
      await new Promise<void>((resolve) => {
        this.confirmPauseRequest = resolve;
      });
    }
    this.state = {
      ...this.state,
      status: 'paused',
      transportState: 'paused',
      canPause: false,
      canResume: true,
    };
  }

  async resume(): Promise<void> {
    this.resumeCalls += 1;
    if (this.failResume) {
      throw new BridgeError('ROON_TIMEOUT', 'Synthetic resume confirmation timed out', {
        httpStatus: 504,
      });
    }
    if (!this.autoConfirmResume) {
      await new Promise<void>((resolve) => {
        this.confirmResumeRequest = resolve;
      });
    }
    this.state = {
      ...this.state,
      status: 'playing',
      transportState: 'playing',
      canPause: true,
      canResume: false,
    };
  }

  async seek(positionMs: number): Promise<void> {
    this.seekCalls.push(positionMs);
  }

  confirmPause(): void {
    this.confirmPauseRequest?.();
    this.confirmPauseRequest = undefined;
  }

  confirmResume(): void {
    this.confirmResumeRequest?.();
    this.confirmResumeRequest = undefined;
  }

  async shutdown(): Promise<void> {}

  getState(): RoonState {
    return { ...this.state };
  }

  getActivePlaybackEpoch(): number {
    return this.activePlaybackEpoch;
  }

  getSelectedZonePlaybackObservation(): RoonPlaybackObservation | undefined {
    if (!this.state.selectedZoneId) return undefined;
    return {
      revision: this.zoneRevision,
      zoneId: this.state.selectedZoneId,
      ...(this.state.transportState ? { state: this.state.transportState } : {}),
    };
  }
}

class FakeNativeRoonLibrary {
  readonly playCalls: Array<{ reference: string; zoneId: string }> = [];
  readonly seekCalls: number[] = [];
  stopCalls = 0;
  pauseCalls = 0;
  resumeCalls = 0;
  active = false;
  shouldFail = false;
  autoConfirmSeek = true;
  playObservation: RoonPlaybackObservation = {
    revision: 1,
    zoneId: 'zone-1',
    state: 'playing',
  };
  private confirmSeekRequest: (() => void) | undefined;

  async play(reference: string, zoneId: string, _track?: unknown): Promise<RoonPlaybackObservation> {
    this.playCalls.push({ reference, zoneId });
    if (this.shouldFail) throw new Error('Synthetic native Roon failure');
    this.active = true;
    return { ...this.playObservation, zoneId };
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.active = false;
  }

  async pause(): Promise<void> {
    this.pauseCalls += 1;
  }

  async resume(): Promise<void> {
    this.resumeCalls += 1;
  }

  async seek(positionMs: number): Promise<void> {
    this.seekCalls.push(positionMs);
    if (!this.autoConfirmSeek) {
      await new Promise<void>((resolve) => {
        this.confirmSeekRequest = resolve;
      });
    }
  }

  confirmSeek(): void {
    this.confirmSeekRequest?.();
    this.confirmSeekRequest = undefined;
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

function makeHarness(
  preflightStatus = 206,
  resolveSmartSource?: (track: { id: string; title: string; artists: readonly string[]; album: string }) => Promise<{
    reference: string;
    zoneId: string;
  } | undefined>,
) {
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
  const nativeRoon = new FakeNativeRoonLibrary();
  let authExpiredCalls = 0;
  const controller = new BridgeController({
    netease,
    roon,
    registry,
    gateway,
    logger: createLogger('error'),
    now: () => 1_700_000_000_000,
    diagnosticId: () => 'diag-controller-test',
    onProviderAuthExpired: () => {
      authExpiredCalls += 1;
    },
    roonLibrary: nativeRoon,
    ...(resolveSmartSource ? { resolveSmartSource } : {}),
  });
  return { registry, gateway, netease, roon, nativeRoon, controller, events, get authExpiredCalls() { return authExpiredCalls; } };
}

test('跨源验收：原生 Roon 先播放，歌词搜索未结算不阻塞音频，失败不触发播放控制', { timeout: 3_000 }, async (t) => {
  const { controller, nativeRoon, netease, registry } = makeHarness();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let searches = 0;
  const resolver = new LyricsMatchResolver({
    repository: createLyricsMatchRepository(),
    provider: {
      configured: true,
      async searchTracks() {
        searches += 1;
        await gate;
        throw new Error('Synthetic Provider unavailable');
      },
      async getLyrics() { throw new Error('未经匹配不得下载歌词'); },
    },
  });
  const lyrics = new LyricsCoordinator({
    load: async () => { throw new Error('不得使用 Roon runtime ID 下载歌词'); },
    localResolver: resolver,
  });
  const unsubscribe = controller.subscribe((snapshot) => {
    lyrics.onPlaybackChanged(snapshot, createLyricsRequestContext(snapshot, controller.getPlaybackGeneration()));
  });
  t.after(() => { release(); unsubscribe(); lyrics.shutdown(); });
  await controller.playRoon({
    reference: 'synthetic-private-roon-reference', zoneId: 'zone-1',
    track: { id: '98001', title: '归零', artists: ['林忆莲'], album: '0', durationMs: 271_000 },
  });
  await waitFor(() => searches === 1);
  assert.equal(controller.getPlaybackState().state, 'playing');
  assert.equal(controller.getPlaybackState().source, 'roon');
  assert.equal(nativeRoon.active, true);
  assert.equal(lyrics.getSnapshot().status, 'loading');
  release();
  await waitFor(() => lyrics.getSnapshot().status === 'error');
  assert.equal(controller.getPlaybackState().state, 'playing');
  assert.equal(nativeRoon.playCalls.length, 1);
  assert.equal(nativeRoon.stopCalls + nativeRoon.pauseCalls + nativeRoon.resumeCalls, 0);
  assert.equal(netease.resolveCalls, 0);
  assert.equal(registry.size, 0);
});

test('跨源验收：原生 pause/resume/seek 与歌词共享已确认的 Roon 时间轴', async (t) => {
  const { controller, nativeRoon, roon } = makeHarness();
  let now = 0;
  const resolver = new LyricsMatchResolver({
    repository: createLyricsMatchRepository(),
    provider: {
      configured: true,
      async searchTracks() {
        return { items: [{ id: '601', title: 'Synthetic Timing', artists: ['Artist'], album: 'Album', durationMs: 180_000 }], offset: 0, limit: 20, total: 1, hasMore: false };
      },
      async getLyrics() {
        return { status: 'ready', lines: [{ startMs: 0, endMs: 1_000, text: 'SYNTHETIC_A' }, { startMs: 1_000, text: 'SYNTHETIC_B' }], activeLineIndex: -1, timingSource: 'static' };
      },
    },
  });
  const lyrics = new LyricsCoordinator({
    now: () => now, localResolver: resolver,
    load: async () => { throw new Error('不应访问直接加载入口'); },
  });
  const unsubscribe = controller.subscribe((snapshot) => lyrics.onPlaybackChanged(
    snapshot, createLyricsRequestContext(snapshot, controller.getPlaybackGeneration()),
  ));
  t.after(() => { unsubscribe(); lyrics.shutdown(); });
  await controller.playRoon({
    reference: 'synthetic-time-reference', zoneId: 'zone-1',
    track: { id: '98002', title: 'Synthetic Timing', artists: ['Artist'], album: 'Album', durationMs: 180_000 },
  });
  await waitFor(() => lyrics.getSnapshot().status === 'ready');
  roon.state = { ...roon.state, status: 'playing', transportState: 'playing', canPause: true, canResume: false };
  const time = (positionMs: number): void => {
    if (controller.updateRoonTime(positionMs)) lyrics.updateRoonTime(positionMs);
  };
  time(400);
  await controller.pause();
  now = 2_000;
  lyrics.updateEstimated();
  assert.equal(lyrics.getSnapshot().activeLineIndex, 0);
  roon.state = { ...roon.state, status: 'paused', transportState: 'paused', canPause: false, canResume: true };
  let release!: () => void;
  nativeRoon.resume = () => new Promise<void>((resolve) => { release = resolve; });
  const resuming = controller.resume();
  await waitFor(() => controller.getPlaybackState().state === 'resuming');
  now = 4_000;
  lyrics.updateEstimated();
  assert.equal(lyrics.getSnapshot().activeLineIndex, 0);
  roon.state = { ...roon.state, status: 'playing', transportState: 'playing', canPause: true, canResume: false };
  release();
  await resuming;
  time(1_200);
  assert.equal(lyrics.getSnapshot().activeLineIndex, 1);
  await controller.seek(200);
  assert.equal(lyrics.getSnapshot().activeLineIndex, 1);
  time(200);
  assert.equal(lyrics.getSnapshot().activeLineIndex, 0);
  assert.equal(nativeRoon.playCalls.length, 1);
});

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

test('controller resolves independent metadata and stream URL work in parallel', async () => {
  const { controller, netease } = makeHarness();
  let releaseMetadata: () => void = () => undefined;
  netease.metadataGate = new Promise<void>((resolve) => {
    releaseMetadata = resolve;
  });

  const playback = controller.play({ trackId: '123', quality: 'lossless' });
  await waitFor(() => netease.metadataStarted);
  await waitFor(() => netease.resolveCalls === 1);
  releaseMetadata();
  await playback;
});

test('controller reports both independent Provider stages before Gateway preflight', async () => {
  const { controller } = makeHarness();
  const stages: string[] = [];

  await controller.play({
    trackId: '123',
    quality: 'lossless',
    startupTrace: {
      startedAtMs: 1_700_000_000_000,
      onStage: (stage) => stages.push(stage),
    },
  });

  assert.deepEqual(new Set(stages.slice(0, 2)), new Set([
    'metadata-ready',
    'stream-url-ready',
  ]));
  assert.deepEqual(stages.slice(2), [
    'gateway-preflight-ready',
    'roon-session-began',
    'roon-playing',
  ]);
});

test('controller exposes a bounded quality downgrade notice without upstream details', async () => {
  const { controller, netease } = makeHarness();
  netease.actualQuality = 'exhigh';

  await controller.play({ trackId: '123', quality: 'lossless' });

  assert.deepEqual(controller.getPlaybackState().qualityNotice, {
    code: 'QUALITY_DOWNGRADED',
    message: '请求 lossless，实际 exhigh',
    retryable: false,
    diagnosticId: 'diag-controller-test',
    action: 'none',
  });
  assert.equal(JSON.stringify(controller.getPlaybackState()).includes('cdn.example'), false);
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

test('controller maps ZoneLost to a diagnostic issue and clears stream resources', async () => {
  const { controller, registry, roon } = makeHarness();
  await controller.play({ trackId: '123', quality: 'lossless' });

  roon.emitTerminal('zone_lost');
  await waitFor(() => registry.size === 0);

  assert.equal(controller.getPlaybackState().state, 'error');
  assert.equal(controller.getPlaybackState().lastError, 'ROON_ZONE_LOST');
  assert.deepEqual(controller.getPlaybackState().lastIssue, {
    code: 'ROON_ZONE_LOST',
    message: 'Roon Zone 已丢失，请重新选择 Zone',
    retryable: false,
    diagnosticId: 'diag-controller-test',
    action: 'select_zone',
  });
});

test('controller maps MediaError to a retryable diagnostic issue', async () => {
  const { controller, roon } = makeHarness();
  await controller.play({ trackId: '123', quality: 'lossless' });

  roon.emitTerminal('media_error');
  await waitFor(() => controller.getPlaybackState().state === 'error');

  assert.deepEqual(controller.getPlaybackState().lastIssue, {
    code: 'ROON_MEDIA_ERROR',
    message: 'Roon 报告媒体错误，请重试',
    retryable: true,
    diagnosticId: 'diag-controller-test',
    action: 'retry',
  });
});

test('controller refreshes an expiring stream only once', async () => {
  const { controller, netease, registry, roon } = makeHarness();
  await controller.play({ trackId: '123', quality: 'lossless' });
  const mediaUrl = roon.playRequest?.mediaUrl ?? '';
  const token = /\/stream\/([A-Za-z0-9_-]+)\./.exec(mediaUrl)?.[1];
  assert.ok(token);
  const registration = registry.get(token);

  await registration.resolve({ reason: 'upstream_expired', status: 403 });
  assert.equal(netease.resolveCalls, 2);
  await assert.rejects(
    () => registration.resolve({ reason: 'upstream_expired', status: 403 }),
    (error: unknown) => error instanceof BridgeError && error.code === 'STREAM_URL_EXPIRED',
  );
  assert.equal(netease.resolveCalls, 2);
});

test('controller reports expired Provider credentials without retaining active resources', async () => {
  const harness = makeHarness();
  harness.netease.authExpired = true;

  await assert.rejects(
    () => harness.controller.play({ trackId: '123', quality: 'lossless' }),
    (error: unknown) => error instanceof BridgeError && error.code === 'AUTH_EXPIRED',
  );

  assert.equal(harness.authExpiredCalls, 1);
  assert.equal(harness.registry.size, 0);
  assert.deepEqual(harness.controller.getPlaybackState().lastIssue, {
    code: 'AUTH_EXPIRED',
    message: '登录已过期，请重新扫码登录',
    retryable: false,
    diagnosticId: 'diag-controller-test',
    action: 'reauthenticate',
  });
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

test('controller keeps Roon and NetEase items in one logical queue and switches source serially', async () => {
  const { controller, roon, nativeRoon, registry } = makeHarness();
  const roonTrack = {
    id: '8801',
    title: 'Local Song',
    artists: ['Local Artist'],
    album: 'Local Album',
    durationMs: 180_000,
    artworkReference: 'musicbridge-v2-image-123e4567-e89b-12d3-a456-426614174001',
  };

  await controller.playRoon({
    reference: 'roon-ref-1',
    zoneId: 'zone-1',
    track: roonTrack,
  });
  await controller.appendQueue([{ trackId: '8802', quality: 'lossless' }]);

  let snapshot = controller.getPlaybackState();
  assert.equal(snapshot.source, 'roon');
  assert.deepEqual(snapshot.queue.items.map((item) => item.resolvedSource), ['roon', undefined]);
  assert.equal(snapshot.queue.items[0]?.preferredSource, 'roon');
  assert.equal(snapshot.currentTrack?.artworkReference, roonTrack.artworkReference);
  assert.equal(snapshot.queue.items[0]?.track?.artworkReference, roonTrack.artworkReference);
  assert.equal('roonReference' in (snapshot.queue.items[0] ?? {}), false);
  assert.equal(nativeRoon.playCalls.length, 1);
  assert.equal(registry.size, 0);

  await controller.next();
  snapshot = controller.getPlaybackState();
  assert.equal(snapshot.source, 'netease');
  assert.equal(snapshot.currentTrack?.id, '8802');
  assert.equal(nativeRoon.stopCalls, 1);
  assert.equal(roon.playRequests.length, 1);
  assert.equal(registry.size, 1);
  assert.equal(nativeRoon.active, false);
});

test('controller projects available native Roon technical metadata and an explicit unknown quality', async () => {
  const { controller } = makeHarness();
  const roonTrack = {
    id: '8809',
    title: 'Local Technical Song',
    artists: ['Local Artist'],
    album: 'Local Album',
    bitrate: 921_600,
    format: 'flac',
  };

  await controller.playRoon({
    reference: 'roon-ref-technical',
    zoneId: 'zone-1',
    track: roonTrack,
  });

  const snapshot = controller.getPlaybackState();
  assert.equal(snapshot.actualQuality, 'unknown');
  assert.equal(snapshot.bitrate, 921_600);
  assert.equal(snapshot.format, 'flac');
  assert.equal(snapshot.currentTrack?.bitrate, 921_600);
  assert.equal(snapshot.currentTrack?.format, 'flac');
});

test('controller plays an existing mixed queue index without discarding the queue', async () => {
  const { controller } = makeHarness();
  await controller.play({ trackId: '8890', quality: 'standard' });
  await controller.appendRoon({
    reference: 'roon-ref-select',
    zoneId: 'zone-1',
    track: {
      id: '8891',
      title: 'Selected Local Song',
      artists: ['Local Artist'],
      album: 'Local Album',
    },
  });
  await controller.appendQueue([{ trackId: '8892', quality: 'lossless' }]);

  await controller.playQueueIndex(1);
  let snapshot = controller.getPlaybackState();
  assert.equal(snapshot.queue.items.length, 3);
  assert.equal(snapshot.queue.index, 1);
  assert.equal(snapshot.currentTrack?.id, '8891');
  assert.equal(snapshot.source, 'roon');

  await controller.next();
  snapshot = controller.getPlaybackState();
  assert.equal(snapshot.queue.items.length, 3);
  assert.equal(snapshot.currentTrack?.id, '8892');
  assert.equal(snapshot.source, 'netease');
});

test('controller pauses and resumes an active native Roon queue item through the same V1 controls', async () => {
  const { controller, roon, nativeRoon } = makeHarness();
  await controller.playRoon({
    reference: 'roon-ref-pause',
    zoneId: 'zone-1',
    track: {
      id: '8803',
      title: 'Local Pause Song',
      artists: ['Local Artist'],
      album: 'Local Album',
    },
  });
  roon.state = {
    ...roon.state,
    status: 'playing',
    transportState: 'playing',
    canPause: true,
    canResume: false,
  };

  assert.equal(controller.getPlaybackState().canPause, true);
  await controller.pause();
  assert.equal(nativeRoon.pauseCalls, 1);
  assert.equal(controller.getPlaybackState().state, 'paused');

  roon.state = {
    ...roon.state,
    status: 'paused',
    transportState: 'paused',
    canPause: false,
    canResume: true,
  };
  assert.equal(controller.getPlaybackState().canResume, true);
  await controller.resume();
  assert.equal(nativeRoon.resumeCalls, 1);
  assert.equal(controller.getPlaybackState().state, 'playing');
});

test('controller seeks active Provider Audio Input and native Roon playback through their matching ports', async () => {
  const { controller, roon, nativeRoon } = makeHarness();

  await controller.play({ trackId: '8804', quality: 'lossless' });
  await controller.seek(12_345);
  assert.deepEqual(roon.seekCalls, [12_345]);
  assert.deepEqual(nativeRoon.seekCalls, []);

  roon.state = {
    ...roon.state,
    status: 'playing',
    transportState: 'playing',
    canPause: true,
    canResume: false,
  };

  await controller.playRoon({
    reference: 'roon-ref-seek',
    zoneId: 'zone-1',
    track: {
      id: '8805',
      title: 'Local Seek Song',
      artists: ['Local Artist'],
      album: 'Local Album',
      durationMs: 180_000,
    },
  });
  roon.state = {
    ...roon.state,
    status: 'playing',
    transportState: 'playing',
    canPause: true,
    canResume: false,
  };
  await controller.seek(12_345);
  assert.deepEqual(nativeRoon.seekCalls, [12_345]);
  assert.equal(controller.getPlaybackState().positionMs, 0);
  controller.updateRoonTime(12_345);
  assert.equal(controller.getPlaybackState().positionMs, 12_345);
});

test('controller keeps the prior position until native Roon confirms seek with real time', async () => {
  const { controller, roon, nativeRoon } = makeHarness();
  roon.state = {
    ...roon.state,
    status: 'playing',
    transportState: 'playing',
    canPause: true,
    canResume: false,
  };
  await controller.playRoon({
    reference: 'roon-ref-confirmed-seek',
    zoneId: 'zone-1',
    track: {
      id: '8806',
      title: 'Confirmed Seek Song',
      artists: ['Local Artist'],
      album: 'Local Album',
      durationMs: 180_000,
    },
  });
  controller.updateRoonTime(4_000);
  nativeRoon.autoConfirmSeek = false;

  let settled = false;
  const seeking = controller.seek(20_000).then(() => {
    settled = true;
  });
  await waitFor(() => nativeRoon.seekCalls.length === 1);
  assert.equal(controller.getPlaybackState().positionMs, 4_000);
  assert.equal(settled, false);

  controller.updateRoonTime(19_750);
  nativeRoon.confirmSeek();
  await seeking;
  assert.equal(controller.getPlaybackState().positionMs, 19_750);
});

test('controller switches from an active NetEase item to a queued Roon item without overlap', async () => {
  const { controller, roon, nativeRoon, registry } = makeHarness();
  await controller.play({ trackId: '8810', quality: 'standard' });
  await controller.appendRoon({
    reference: 'roon-ref-2',
    zoneId: 'zone-1',
    track: {
      id: '8811',
      title: 'Queued Local Song',
      artists: ['Local Artist'],
      album: 'Local Album',
    },
  });

  await controller.next();
  const snapshot = controller.getPlaybackState();
  assert.equal(snapshot.source, 'roon');
  assert.equal(snapshot.currentTrack?.id, '8811');
  assert.equal(roon.stopCalls, 1);
  assert.equal(registry.size, 0);
  assert.equal(nativeRoon.playCalls.length, 1);
  assert.equal(nativeRoon.active, true);
});

test('controller advances a mixed queue after a native Roon track ends', async () => {
  const { controller, nativeRoon, roon } = makeHarness();
  await controller.playRoon({
    reference: 'roon-ref-3',
    zoneId: 'zone-1',
    track: {
      id: '8820',
      title: 'Native First',
      artists: ['Local Artist'],
      album: 'Local Album',
    },
  });
  await controller.appendQueue([{ trackId: '8821', quality: 'standard' }]);

  controller.handleRoonPlaybackState('playing');
  controller.handleRoonPlaybackState('stopped');
  await waitFor(() => controller.getPlaybackState().currentTrack?.id === '8821');

  assert.equal(controller.getPlaybackState().source, 'netease');
  assert.equal(nativeRoon.stopCalls, 0);
  assert.equal(roon.playRequests.length, 1);
});

test('controller resolves Smart at queue start and keeps the logical NetEase identity', async () => {
  const { controller, nativeRoon, registry } = makeHarness(206, async (track) => {
    assert.equal(track.id, '8830');
    return { reference: 'roon-smart-ref', zoneId: 'zone-1' };
  });

  await controller.replaceQueue([{
    trackId: '8830',
    quality: 'lossless',
    preferredSource: 'smart',
  }]);

  const snapshot = controller.getPlaybackState();
  assert.equal(snapshot.source, 'roon');
  assert.equal(snapshot.currentTrack?.id, '8830');
  assert.equal(snapshot.queue.items[0]?.preferredSource, 'smart');
  assert.equal(snapshot.queue.items[0]?.resolvedSource, 'roon');
  assert.equal(nativeRoon.playCalls[0]?.reference, 'roon-smart-ref');
  assert.equal(registry.size, 0);
});

test('controller safely falls Smart playback back to V1 Provider when native Roon start fails', async () => {
  const { controller, nativeRoon, roon, registry } = makeHarness(
    206,
    async () => ({ reference: 'roon-stale-ref', zoneId: 'zone-1' }),
  );
  nativeRoon.shouldFail = true;

  await controller.replaceQueue([{
    trackId: '8831',
    quality: 'lossless',
    preferredSource: 'smart',
  }]);

  const snapshot = controller.getPlaybackState();
  assert.equal(nativeRoon.playCalls.length, 1);
  assert.equal(nativeRoon.stopCalls, 1);
  assert.equal(roon.playRequests.length, 1);
  assert.equal(snapshot.source, 'netease');
  assert.equal(snapshot.currentTrack?.id, '8831');
  assert.equal(snapshot.queue.items[0]?.preferredSource, 'smart');
  assert.equal(snapshot.queue.items[0]?.resolvedSource, 'netease');
  assert.equal(registry.size, 1);
});

test('controller appends to an active queue without restarting playback', async () => {
  const { controller, roon, registry } = makeHarness();

  await controller.play({ trackId: '701', quality: 'lossless' });
  controller.updateRoonTime(12_345);
  const before = controller.getPlaybackState();
  const beforeMediaUrl = roon.playRequest?.mediaUrl;
  const beforePlayCount = roon.playRequests.length;
  const beforeStopCount = roon.stopCalls;
  const beforeTokenCount = controller.getDiagnosticResourceCounters().activeTokenCount;

  await controller.appendQueue([{ trackId: '702', quality: 'lossless' }]);

  const after = controller.getPlaybackState();
  assert.equal(roon.playRequests.length, beforePlayCount);
  assert.equal(roon.stopCalls, beforeStopCount);
  assert.equal(roon.playRequest?.mediaUrl, beforeMediaUrl);
  assert.equal(controller.getDiagnosticResourceCounters().activeTokenCount, beforeTokenCount);
  assert.equal(after.queue.index, before.queue.index);
  assert.equal(after.currentTrack?.id, '701');
  assert.equal(after.positionMs, before.positionMs);
  assert.deepEqual(after.queue.items.map((item) => item.trackId), ['701', '702']);
  assert.equal(registry.size, 1);
});

test('controller replaces the queue without restarting the same active track', async () => {
  const { controller, roon } = makeHarness();

  await controller.play({ trackId: '703', quality: 'lossless' });
  const beforePlayCount = roon.playRequests.length;

  const state = await controller.replaceQueue([
    { trackId: '702', quality: 'lossless' },
    { trackId: '703', quality: 'lossless' },
    { trackId: '704', quality: 'lossless' },
  ], 1);
  const playback = controller.getPlaybackState();

  assert.equal(roon.playRequests.length, beforePlayCount);
  assert.equal(state.activePlayback?.track.id, '703');
  assert.equal(playback.currentTrack?.id, '703');
  assert.equal(playback.queue.index, 1);
  assert.deepEqual(playback.queue.items.map((item) => item.trackId), ['702', '703', '704']);
});

test('controller inserts next after the current queue index without restarting playback', async () => {
  const { controller, roon } = makeHarness();

  await controller.replaceQueue([
    { trackId: '711', quality: 'standard' },
    { trackId: '713', quality: 'standard' },
  ]);
  const beforePlayCount = roon.playRequests.length;
  const beforeStopCount = roon.stopCalls;

  await controller.insertNext([{ trackId: '712', quality: 'standard' }]);

  assert.equal(roon.playRequests.length, beforePlayCount);
  assert.equal(roon.stopCalls, beforeStopCount);
  assert.equal(controller.getPlaybackState().queue.index, 0);
  assert.deepEqual(
    controller.getPlaybackState().queue.items.map((item) => item.trackId),
    ['711', '712', '713'],
  );
});

test('controller keeps consecutive insert-next batches in user order', async () => {
  const { controller } = makeHarness();

  await controller.replaceQueue([
    { trackId: '801', quality: 'standard' },
    { trackId: '804', quality: 'standard' },
  ]);
  await controller.insertNext([
    { trackId: '802', quality: 'standard' },
    { trackId: '803', quality: 'standard' },
  ]);
  await controller.insertNext([
    { trackId: '805', quality: 'standard' },
    { trackId: '806', quality: 'standard' },
  ]);

  assert.deepEqual(
    controller.getPlaybackState().queue.items.map((item) => item.trackId),
    ['801', '802', '803', '805', '806', '804'],
  );
});

test('controller accepts a 1,197-track queue through bounded progressive mutations', async () => {
  const { controller } = makeHarness();
  const firstPage = Array.from({ length: 20 }, (_, index) => ({
    trackId: String(10_000 + index),
    quality: 'standard' as const,
  }));
  await controller.replaceQueue(firstPage);

  for (let start = 20; start < 1_197; start += 20) {
    await controller.appendQueue(
      Array.from({ length: Math.min(20, 1_197 - start) }, (_, offset) => ({
        trackId: String(10_000 + start + offset),
        quality: 'standard' as const,
      })),
    );
  }

  const queue = controller.getPlaybackState().queue.items
  assert.equal(queue.length, 1_197)
  assert.equal(queue[1_196]?.trackId, '11196')
});

test('controller rejects a queue beyond the bounded capacity instead of silently dropping items', async () => {
  const { controller } = makeHarness();
  await assert.rejects(
    () => controller.replaceQueue(Array.from({ length: 5_001 }, (_, index) => ({
      trackId: String(20_000 + index),
      quality: 'standard' as const,
    }))),
    (error: unknown) => error instanceof BridgeError && error.code === 'BAD_REQUEST',
  );
  assert.equal(controller.getPlaybackState().queue.items.length, 0);
});

test('controller appends while idle without starting playback', async () => {
  const { controller, roon } = makeHarness();

  await controller.appendQueue([{ trackId: '721', quality: 'standard' }]);

  assert.equal(roon.playRequests.length, 0);
  assert.equal(roon.stopCalls, 0);
  assert.equal(controller.getPlaybackState().state, 'idle');
  assert.equal(controller.getPlaybackState().queue.index, -1);
  assert.deepEqual(controller.getPlaybackState().queue.items.map((item) => item.trackId), ['721']);
});

test('controller publishes verified summaries for queued tracks', async () => {
  const { controller } = makeHarness();

  await controller.replaceQueue([
    { trackId: '731', quality: 'standard' },
    { trackId: '732', quality: 'standard' },
  ]);

  assert.deepEqual(controller.getPlaybackState().queue.items.map((item) => item.track), [
    {
      id: '731',
      title: 'Test Song',
      artists: ['Artist'],
      album: 'Album',
      durationMs: 120000,
    },
    {
      id: '732',
      title: 'Test Song',
      artists: ['Artist'],
      album: 'Album',
      durationMs: 120000,
    },
  ]);
});

test('controller starts the selected track before background metadata hydration finishes', async () => {
  const { controller, netease, roon } = makeHarness();
  let releaseMetadata: (() => void) | undefined;
  netease.metadataGate = new Promise<void>((resolve) => {
    releaseMetadata = resolve;
  });
  const items = Array.from({ length: 20 }, (_, index) => ({
    trackId: String(7_400 + index),
    quality: 'standard' as const,
  }));
  for (const item of items.slice(1)) netease.blockedMetadataTrackIds.add(item.trackId);

  const replacing = controller.replaceQueue(items);
  await new Promise((resolve) => setImmediate(resolve));
  try {
    assert.equal(roon.playRequests.length, 1);
    assert.equal(roon.playRequests[0]?.metadata.id, items[0]?.trackId);
    assert.equal(controller.getPlaybackState().queue.items.length, items.length);
  } finally {
    releaseMetadata?.();
    await replacing;
  }
});

test('controller hydrates upcoming queue metadata while the selected track is still starting in Roon', async () => {
  const { controller, netease, roon } = makeHarness();
  roon.playDelayMs = 80;
  const items = Array.from({ length: 4 }, (_, index) => ({
    trackId: String(7_500 + index),
    quality: 'standard' as const,
  }));

  const replacing = controller.replaceQueue(items);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(roon.activePlayCalls, 1);
  assert.deepEqual(
    controller.getPlaybackState().queue.items.slice(1).map((item) => item.track?.id),
    items.slice(1).map((item) => item.trackId),
  );
  await replacing;
});

test('controller auto quality requests the highest supported level without a downgrade warning', async () => {
  const { controller, netease } = makeHarness();
  netease.actualQuality = 'exhigh';

  await controller.play({ trackId: '741', qualityPreference: 'auto' });

  const snapshot = controller.getPlaybackState();
  assert.equal(snapshot.qualityPreference, 'auto');
  assert.equal(snapshot.requestedQuality, 'hires');
  assert.equal(snapshot.actualQuality, 'exhigh');
  assert.equal(snapshot.qualityNotice, undefined);
});

test('controller only reports a downgrade when the fixed requested rank is lower than actual', async () => {
  const { controller, netease } = makeHarness();
  netease.actualQuality = 'lossless';

  await controller.play({ trackId: '742', qualityPreference: 'exhigh' });
  assert.equal(controller.getPlaybackState().qualityNotice, undefined);

  netease.actualQuality = 'vendor-unknown';
  await controller.play({ trackId: '743', qualityPreference: 'hires' });
  assert.equal(controller.getPlaybackState().actualQuality, 'unknown');
  assert.equal(controller.getPlaybackState().qualityNotice, undefined);
});

test('controller rejects stale Roon positions after a new playback generation', async () => {
  const { controller } = makeHarness();

  await controller.play({ trackId: '751', qualityPreference: 'lossless' });
  const oldGeneration = controller.getPlaybackGeneration();
  controller.updateRoonTime(1_234, oldGeneration);
  assert.equal(controller.getPlaybackState().positionMs, 1_234);

  await controller.play({ trackId: '752', qualityPreference: 'lossless' });
  assert.equal(controller.getPlaybackState().positionMs, 0);
  controller.updateRoonTime(9_999, oldGeneration);
  assert.equal(controller.getPlaybackState().positionMs, 0);
  controller.updateRoonTime(2_000);
  assert.equal(controller.getPlaybackState().positionMs, 2_000);

  await controller.stop();
  assert.equal(controller.getPlaybackState().positionMs, 0);
});

test('controller pause and resume preserve current track, queue index, position, and stream', async () => {
  const { controller, roon, registry } = makeHarness();
  roon.state = {
    ...roon.state,
    transportState: 'playing',
    canPause: true,
    canResume: false,
  };

  await controller.replaceQueue([
    { trackId: '761', qualityPreference: 'lossless' },
    { trackId: '762', qualityPreference: 'lossless' },
  ], 0);
  controller.updateRoonTime(12_345);
  const before = controller.getPlaybackState();

  await controller.pause();
  const paused = controller.getPlaybackState();
  assert.equal(paused.state, 'paused');
  assert.equal(paused.positionMs, 12_345);
  assert.equal(paused.currentTrack?.id, before.currentTrack?.id);
  assert.equal(paused.queue.index, before.queue.index);
  assert.equal(paused.canPause, false);
  assert.equal(paused.canResume, true);
  assert.equal(roon.pauseCalls, 1);
  assert.equal(registry.size, 1);

  await controller.resume();
  const resumed = controller.getPlaybackState();
  assert.equal(resumed.state, 'playing');
  assert.equal(resumed.positionMs, 12_345);
  assert.equal(resumed.currentTrack?.id, before.currentTrack?.id);
  assert.equal(resumed.queue.index, before.queue.index);
  assert.equal(resumed.canPause, true);
  assert.equal(resumed.canResume, false);
  assert.equal(roon.resumeCalls, 1);
  assert.equal(registry.size, 1);
});

test('controller publishes pausing and resuming until the Roon port confirms the real state', async () => {
  const { controller, roon } = makeHarness();
  const states: string[] = [];
  controller.subscribe((snapshot) => states.push(snapshot.state));
  roon.state = {
    ...roon.state,
    transportState: 'playing',
    canPause: true,
    canResume: false,
  };
  await controller.play({ trackId: '763', qualityPreference: 'lossless' });

  roon.autoConfirmPause = false;
  let pauseSettled = false;
  const pausing = controller.pause().then(() => {
    pauseSettled = true;
  });
  await waitFor(() => roon.pauseCalls === 1);
  assert.equal(controller.getPlaybackState().state, 'pausing');
  assert.equal(controller.getPlaybackState().canPause, false);
  assert.equal(controller.getPlaybackState().canResume, false);
  assert.equal(pauseSettled, false);
  roon.confirmPause();
  await pausing;
  assert.equal(controller.getPlaybackState().state, 'paused');

  roon.autoConfirmResume = false;
  let resumeSettled = false;
  const resuming = controller.resume().then(() => {
    resumeSettled = true;
  });
  await waitFor(() => roon.resumeCalls === 1);
  assert.equal(controller.getPlaybackState().state, 'resuming');
  assert.equal(controller.getPlaybackState().canPause, false);
  assert.equal(controller.getPlaybackState().canResume, false);
  assert.equal(resumeSettled, false);
  roon.confirmResume();
  await resuming;
  assert.equal(controller.getPlaybackState().state, 'playing');
  assert.deepEqual(
    states.filter((state) => ['pausing', 'paused', 'resuming', 'playing'].includes(state)).slice(-4),
    ['pausing', 'paused', 'resuming', 'playing'],
  );
});

test('controller rolls a failed pause confirmation back to the observed playing state', async () => {
  const { controller, roon } = makeHarness();
  const states: string[] = [];
  controller.subscribe((snapshot) => states.push(snapshot.state));
  roon.state = {
    ...roon.state,
    transportState: 'playing',
    canPause: true,
    canResume: false,
  };
  await controller.play({ trackId: '764', qualityPreference: 'lossless' });
  roon.failPause = true;

  await assert.rejects(
    controller.pause(),
    (error: unknown) => error instanceof BridgeError && error.code === 'ROON_TIMEOUT',
  );

  assert.equal(controller.getPlaybackState().state, 'playing');
  assert.deepEqual(states.slice(-2), ['pausing', 'playing']);
});

test('controller rejects position updates after the active Zone identity changes', async () => {
  const { controller, roon } = makeHarness();
  roon.state = {
    ...roon.state,
    transportState: 'playing',
    canPause: true,
    canResume: false,
  };
  await controller.play({ trackId: '765', qualityPreference: 'lossless' });
  controller.updateRoonTime(1_234);
  assert.equal(controller.getPlaybackState().positionMs, 1_234);

  roon.state = { ...roon.state, selectedZoneId: 'zone-2' };
  controller.updateRoonTime(9_999);
  assert.equal(controller.getPlaybackState().positionMs, 1_234);
});

test('controller binds real Time events to playback source, epoch, Zone and Track identity', async () => {
  const { controller, roon } = makeHarness();
  await controller.play({ trackId: '766', qualityPreference: 'lossless' });
  const audioEvent = (overrides: Partial<RoonTimeEvent> = {}): RoonTimeEvent => ({
    positionMs: 2_000,
    source: 'audio-input',
    zoneId: 'zone-1',
    revision: 2,
    playbackEpoch: 17,
    ...overrides,
  });

  assert.equal(controller.updateRoonTime(audioEvent({ playbackEpoch: 16 })), false);
  assert.equal(controller.updateRoonTime(audioEvent({ zoneId: 'zone-2' })), false);
  assert.equal(controller.getPlaybackState().positionMs, 0);
  assert.equal(controller.updateRoonTime(audioEvent()), true);
  assert.equal(controller.getPlaybackState().positionMs, 2_000);

  await controller.playRoon({
    reference: 'roon-ref-time-identity',
    zoneId: 'zone-1',
    track: {
      id: '767',
      title: '7. Native Time Song',
      artists: ['Local Artist'],
      album: 'Local Album',
      durationMs: 180_000,
    },
  });
  roon.state = {
    ...roon.state,
    transportState: 'playing',
    canPause: true,
    canResume: false,
  };
  const nativeEvent = (title: string): RoonTimeEvent => ({
    positionMs: 3_000,
    source: 'zone',
    zoneId: 'zone-1',
    revision: 3,
    nowPlaying: { title, durationMs: 180_000 },
  });
  assert.equal(controller.updateRoonTime(nativeEvent('Stale Native Song')), false);
  assert.equal(controller.getPlaybackState().positionMs, 0);
  // Roon Browse 常在标题前带曲目序号，而 Zone now_playing 只返回真实标题。
  assert.equal(controller.updateRoonTime(nativeEvent('Native Time Song')), true);
  assert.equal(controller.getPlaybackState().positionMs, 3_000);
});

test('controller hydrates native Roon duration and position from the confirmed Zone observation', async () => {
  const { controller, nativeRoon } = makeHarness();
  nativeRoon.playObservation = {
    revision: 8,
    zoneId: 'zone-1',
    state: 'playing',
    positionMs: 1_250,
    nowPlaying: {
      title: 'Native Duration Song',
      artist: 'Local Artist',
      album: 'Local Album',
      durationMs: 271_000,
    },
  };

  await controller.playRoon({
    reference: 'roon-ref-duration',
    zoneId: 'zone-1',
    track: {
      id: '768',
      title: '8. Native Duration Song',
      artists: ['Local Artist'],
      album: 'Local Album',
    },
  });

  const snapshot = controller.getPlaybackState();
  assert.equal(snapshot.currentTrack?.durationMs, 271_000);
  assert.equal(snapshot.queue.items[0]?.track?.durationMs, 271_000);
  assert.equal(snapshot.positionMs, 1_250);
});

test('controller continues a 45-track collection after starting at track 21', async () => {
  const { controller, roon } = makeHarness();
  const items = Array.from({ length: 45 }, (_, index) => ({
    trackId: String(8_000 + index),
    quality: 'lossless' as const,
  }));

  await controller.replaceQueue(items, 20);
  assert.equal(controller.getPlaybackState().currentTrack?.id, '8020');
  roon.emitTerminal('ended');
  await waitFor(() => controller.getPlaybackState().currentTrack?.id === '8021');
  assert.equal(controller.getPlaybackState().queue.index, 21);
});

test('controller preserves the tail of a 120-track collection across the same boundary', async () => {
  const { controller, roon } = makeHarness();
  const items = Array.from({ length: 120 }, (_, index) => ({
    trackId: String(9_000 + index),
    qualityPreference: 'auto' as const,
  }));

  await controller.replaceQueue(items, 20);
  assert.equal(controller.getPlaybackState().currentTrack?.id, '9020');
  roon.emitTerminal('ended');
  await waitFor(() => controller.getPlaybackState().currentTrack?.id === '9021');
  assert.equal(controller.getPlaybackState().queue.items.length, 120);
  assert.equal(controller.getPlaybackState().queue.index, 21);
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

test('preview-only first track is skipped when the collection first page is already queued', async () => {
  const { controller, netease, roon } = makeHarness();
  netease.previewOnlyTrackIds.add('451');

  await controller.replaceQueue([
    { trackId: '451', quality: 'standard' },
    { trackId: '452', quality: 'standard' },
    { trackId: '453', quality: 'standard' },
  ]);

  assert.deepEqual(roon.playRequests.map((request) => request.metadata.id), ['452']);
  assert.equal(controller.getPlaybackState().queue.index, 1);
  assert.equal(controller.getPlaybackState().lastError, 'TRACK_PREVIEW_ONLY');
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
