import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { PerformanceTraceRecorder, validateIpcEvent } from '@music-bridge/contracts';
import { performance } from 'node:perf_hooks';
import { withPerformanceContext } from '../src/diagnostics/performance-trace.js';
import type { PlaybackSnapshot } from '@music-bridge/contracts';
import { BridgeController } from '../src/application/bridge-controller.js';
import { BridgeError } from '../src/shared/errors.js';
import { LocalSourcePreparationError } from '../src/application/local-source-resolver.js';
import { LocalSourceFence } from '../src/stream/local-source-fence.js';
import type { LocalPlayRequest, MBQueueRecord, MBQueueSaveRequest } from '@music-bridge/contracts';
import type { LocalSourceCaptureResult } from '../src/collection/local-source-ticket-types.js';
import type { LocalAlbumOwnerReadRequest } from '../src/collection/local-album-browser/owner-protocol.js';
import { copyLocalPlaybackEvidence, createLocalPlaybackEvidenceCollector, type LocalPlaybackEvidenceRecord } from '../../../apps/desktop/src/main/local-playback-evidence.js';
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
  readonly controlCalls: string[] = [];
  controlError: Error | undefined;
  async control(command: 'play' | 'pause' | 'playpause' | 'stop' | 'previous' | 'next'): Promise<void> {
    if (this.controlError) throw this.controlError;
    this.controlCalls.push(command);
  }
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
  nativeObservation: RoonPlaybackObservation | undefined;
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
    if (!this.shouldFail) request.onDispatch?.();
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
    if (this.nativeObservation) return this.nativeObservation;
    if (!this.state.selectedZoneId) return undefined;
    return {
      revision: this.zoneRevision,
      zoneId: this.state.selectedZoneId,
      ...(this.state.transportState ? { state: this.state.transportState } : {}),
    };
  }
}

class FakeNativeRoonLibrary {
  artworkReference = 'musicbridge-v2-image-22222222-2222-4222-8222-222222222222';
  resolveArtwork(_imageKey: string): string { return this.artworkReference; }
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

  async play(reference: string, zoneId: string, _track?: unknown, options?: { onDispatch?: () => void }): Promise<RoonPlaybackObservation> {
    this.playCalls.push({ reference, zoneId });
    if (this.shouldFail) throw new Error('Synthetic native Roon failure');
    options?.onDispatch?.();
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
  now: () => number = () => 1_700_000_000_000,
  onReadPriorityChanged?: () => void,
  localGuardOptions:Partial<Pick<ConstructorParameters<typeof BridgeController>[0],'logger'|'localSources'|'isLocalPlaybackAllowed'>>={},
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
    now,
    diagnosticId: () => 'diag-controller-test',
    onProviderAuthExpired: () => {
      authExpiredCalls += 1;
    },
    roonLibrary: nativeRoon,
    ...(onReadPriorityChanged ? { onReadPriorityChanged } : {}),
    ...(resolveSmartSource ? { resolveSmartSource } : {}),
    ...localGuardOptions,
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

test('下一首提前完成URL和预检，切歌不重复解析且不提前建立音频会话', async () => {
  const { controller, netease, roon, events, registry } = makeHarness();
  await controller.replaceQueue([{ trackId: '123' }, { trackId: '456' }]);
  await waitFor(() => netease.resolveCalls === 2);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(roon.playRequests.length, 1);
  assert.equal(registry.size, 1);
  assert.equal(events.filter(event => event === 'gateway.preflight').length, 2);
  await controller.next();
  assert.equal(netease.resolveCalls, 2);
  assert.equal(events.filter(event => event === 'gateway.preflight').length, 2);
  assert.equal(roon.playRequests[1]?.metadata.id, '456');
});

test('下一首预解析失败不打断当前歌曲，停止后不保留下一首结果', async () => {
  const { controller, netease, roon } = makeHarness();
  netease.unavailableTrackIds.add('456');
  await controller.replaceQueue([{ trackId: '123' }, { trackId: '456' }]);
  await waitFor(() => netease.resolveCalls === 2);
  assert.equal(controller.getPlaybackState().state, 'playing');
  assert.equal(roon.playRequests.length, 1);
  await controller.stop();
  netease.unavailableTrackIds.clear();
  await controller.playQueueIndex(1);
  assert.equal(roon.playRequests[1]?.metadata.id, '456');
  assert.equal(netease.resolveCalls, 3);
});

test('下一首预解析过期后重新解析，不延长上游URL有效期', async () => {
  let now = 1_700_000_000_000;
  const { controller, netease } = makeHarness(206, undefined, () => now);
  await controller.replaceQueue([{ trackId: '123' }, { trackId: '456' }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(netease.resolveCalls, 2);
  now += 571_000;
  await controller.next();
  assert.equal(netease.resolveCalls, 3);
});

test('预解析期间改队列只准备最新下一首，旧结果不能串歌', async () => {
  const { controller, netease, roon } = makeHarness();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const resolveStream = netease.resolveStream.bind(netease);
  netease.resolveStream = async (trackId, quality) => {
    const result = await resolveStream(trackId, quality);
    if (trackId === '456') await gate;
    return result;
  };
  await controller.replaceQueue([{ trackId: '123' }, { trackId: '456' }]);
  await controller.replaceQueue([{ trackId: '123' }, { trackId: '789' }]);
  assert.equal(netease.resolveCalls, 2);
  release();
  await waitFor(() => netease.resolveCalls === 3);
  await new Promise(resolve => setImmediate(resolve));
  await controller.next();
  assert.equal(netease.resolveCalls, 3);
  assert.equal(roon.playRequests[1]?.metadata.id, '789');
});

test('Roon停止入口也释放下一首预解析结果', async () => {
  const { controller, netease } = makeHarness();
  await controller.replaceQueue([{ trackId: '123' }, { trackId: '456' }]);
  await new Promise(resolve => setImmediate(resolve));
  await controller.stopRoonTransport();
  await controller.playQueueIndex(1);
  assert.equal(netease.resolveCalls, 3);
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

test('本地专辑队列从中间曲目开始，支持前后切换且不请求网易云', async () => {
  const { controller, nativeRoon, netease, registry } = makeHarness();
  const items = ['1', '2', '3'].map((id) => ({
    reference: `roon-ref-${id}`, zoneId: 'zone-1',
    track: { id, title: `本地曲目 ${id}`, artists: ['测试艺术家'], album: '测试专辑' },
  }));
  await controller.replaceRoonQueue(items, 1);
  assert.equal(controller.getPlaybackState().canNext, true);
  assert.equal(controller.getPlaybackState().canPrevious, true);
  await controller.next();
  assert.equal(controller.getPlaybackState().currentTrack?.id, '3');
  assert.equal(controller.getPlaybackState().canNext, false);
  await controller.previous();
  await controller.previous();
  assert.equal(controller.getPlaybackState().currentTrack?.id, '1');
  assert.equal(controller.getPlaybackState().canPrevious, false);
  assert.deepEqual(nativeRoon.playCalls.map((call) => call.reference), ['roon-ref-2', 'roon-ref-3', 'roon-ref-2', 'roon-ref-1']);
  assert.equal(netease.resolveCalls, 0);
  assert.equal(registry.size, 0);
  await assert.rejects(controller.replaceRoonQueue(items, 3));
  assert.equal(controller.getPlaybackState().currentTrack?.id, '1');
  await controller.shutdown();
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

test('Roon 连续播放不经过 stopped 时，同步下一首、队列位置、封面及进度，不重复派发播放', async () => {
  const { controller, roon, nativeRoon } = makeHarness();
  const tracks = ['第一首', '第二首'].map((title, index) => ({
    reference: `native-continuous-${index}`, zoneId: 'zone-1',
    track: { id: String(9001 + index), title, artists: ['本地艺人'], album: '本地专辑', durationMs: 180_000,
      artworkReference: `cover-${index}` },
  }));
  await controller.replaceRoonQueue(tracks, 0);
  const generation = controller.getPlaybackGeneration();
  roon.state = { ...roon.state, transportState: 'playing' };
  roon.nativeObservation = { revision: 2, zoneId: 'zone-1', state: 'playing', positionMs: 750,
    nowPlaying: { title: '第二首', artist: '本地艺人', album: '本地专辑', durationMs: 180_000 } };
  const updates: string[] = [];
  const unsubscribe = controller.subscribe(snapshot => { if (snapshot.currentTrack) updates.push(snapshot.currentTrack.title) });
  controller.syncRoonTransportState();
  const snapshot = controller.getPlaybackState();
  assert.equal(snapshot.currentTrack?.id, '9002');
  assert.equal(snapshot.currentTrack?.artworkReference, 'cover-1');
  assert.equal(snapshot.queue.index, 1);
  assert.equal(snapshot.positionMs, 750);
  assert.equal(snapshot.source, 'roon');
  assert.ok(controller.getPlaybackGeneration() > generation);
  assert.equal(updates.at(-1), '第二首');
  assert.equal(nativeRoon.playCalls.length, 1);
  assert.equal(nativeRoon.stopCalls, 0);
  assert.equal(controller.updateRoonTime({ source: 'zone', zoneId: 'zone-1', revision: 2,
    positionMs: 1750, nowPlaying: roon.nativeObservation.nowPlaying! }), true);
  // 旧曲事件、旧 revision、其他 Zone 和未确认 loading 状态不能反向覆盖。
  for (const observation of [
    { ...roon.nativeObservation, revision: 1, nowPlaying: { title: '第一首' } },
    { ...roon.nativeObservation, revision: 3, zoneId: 'zone-2', nowPlaying: { title: '其他设备' } },
    { ...roon.nativeObservation, revision: 3, state: 'loading' as const, nowPlaying: { title: '加载中的曲目' } },
  ]) { roon.nativeObservation = observation; controller.syncRoonTransportState() }
  assert.equal(controller.getPlaybackState().currentTrack?.id, '9002');
  unsubscribe();
});

test('Roon 续播应用队列外歌曲时显示真实元数据，不沿用旧封面、音质或队列高亮', async () => {
  const { controller, roon, nativeRoon } = makeHarness();
  await controller.playRoon({ reference: 'native-first', zoneId: 'zone-1', track: {
    id: '9011', title: '原歌曲', artists: ['原艺人'], album: '原专辑', durationMs: 120_000,
    artworkReference: 'musicbridge-v2-image-11111111-1111-4111-8111-111111111111', format: 'flac', bitrate: 900_000,
  } });
  roon.state = { ...roon.state, transportState: 'playing' };
  roon.nativeObservation = { revision: 2, zoneId: 'zone-1', state: 'playing', positionMs: 1000,
    nowPlaying: { title: 'Roon 队列歌曲', artist: '新艺人', album: '新专辑', durationMs: 210_000 } };
  controller.syncRoonTransportState();
  const snapshot = controller.getPlaybackState();
  assert.equal(snapshot.currentTrack?.title, 'Roon 队列歌曲');
  assert.deepEqual(snapshot.currentTrack?.artists, ['新艺人']);
  assert.equal(snapshot.currentTrack?.album, '新专辑');
  assert.equal(snapshot.currentTrack?.durationMs, 210_000);
  assert.equal(snapshot.currentTrack?.artworkReference, undefined);
  assert.equal(snapshot.format, undefined);
  assert.equal(snapshot.source, 'roon');
  assert.equal(snapshot.queue.index, -1);
  assert.equal(snapshot.queue.items.length, 1);
  assert.equal(snapshot.canNext, false);
  assert.equal(validateIpcEvent({ version: 1, event: 'playback.changed', payload: { state: snapshot } }).ok, true);
  assert.equal(createLyricsRequestContext(snapshot, controller.getPlaybackGeneration())?.kind, 'local');
  const id = snapshot.currentTrack?.id;
  roon.nativeObservation = { ...roon.nativeObservation, revision: 3, positionMs: 2000 };
  controller.syncRoonTransportState();
  assert.equal(controller.getPlaybackState().currentTrack?.id, id);
  controller.handleRoonPlaybackState('playing');
  controller.handleRoonPlaybackState('stopped');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nativeRoon.playCalls.length, 1);
});

test('Roon 队列外续播读取当前封面和原生导航，发送控制而不停止或重播旧队列', async () => {
  const { controller, roon, nativeRoon } = makeHarness();
  await controller.playRoon({ reference: 'first', zoneId: 'zone-1', track: {
    id: '9051', title: '应用单曲', artists: ['艺人'], album: '专辑',
  } });
  roon.nativeObservation = { revision: 2, zoneId: 'zone-1', state: 'playing',
    canNext: true, canPrevious: true, imageKey: 'private-current-image',
    nowPlaying: { title: 'Roon 续播曲目', artist: '艺人', album: '另一专辑' } };
  controller.syncRoonTransportState();
  const snapshot = controller.getPlaybackState();
  assert.equal(snapshot.currentTrack?.artworkReference, nativeRoon.artworkReference);
  assert.equal(snapshot.canNext, true);
  assert.equal(snapshot.canPrevious, true);
  assert.equal(snapshot.queue.index, -1);
  assert.equal(snapshot.queue.hasNext, false);
  assert.equal(snapshot.queue.hasPrevious, false);
  assert.doesNotMatch(JSON.stringify(snapshot), /private-current-image/);
  assert.equal(validateIpcEvent({ version: 1, event: 'playback.changed', payload: { state: snapshot } }).ok, true);
  await controller.next();
  await controller.previous();
  assert.deepEqual(roon.controlCalls, ['next', 'previous']);
  assert.equal(nativeRoon.stopCalls, 0);
  assert.equal(nativeRoon.playCalls.length, 1);
  assert.equal(controller.getPlaybackState().currentTrack?.id, snapshot.currentTrack?.id);

  // 同一首的封面与权限迟到或变化，也必须通知界面，不重新生成曲目身份。
  const updates: Array<{ canNext: boolean; artwork: string | undefined }> = [];
  const unsubscribe = controller.subscribe(s => updates.push({ canNext: s.canNext, artwork: s.currentTrack?.artworkReference }));
  nativeRoon.artworkReference = 'musicbridge-v2-image-33333333-3333-4333-8333-333333333333';
  roon.nativeObservation = { ...roon.nativeObservation, revision: 3, imageKey: 'new-image', canNext: false };
  controller.syncRoonTransportState();
  assert.equal(updates.at(-1)?.canNext, false);
  assert.equal(updates.at(-1)?.artwork, nativeRoon.artworkReference);
  assert.equal(controller.getPlaybackState().currentTrack?.id, snapshot.currentTrack?.id);
  await controller.next();
  assert.deepEqual(roon.controlCalls, ['next', 'previous']);
  assert.equal(nativeRoon.stopCalls, 0);
  // 切换设备不可控制另一个设备，也不可将其封面接入旧歌曲。
  roon.state = { ...roon.state, selectedZoneId: 'zone-2' };
  roon.nativeObservation = { ...roon.nativeObservation, revision: 4, zoneId: 'zone-2', canNext: true };
  controller.syncRoonTransportState();
  assert.equal(controller.getPlaybackState().canNext, false);
  await controller.previous();
  assert.deepEqual(roon.controlCalls, ['next', 'previous']);
  unsubscribe();
});

test('本地单曲在应用队列边界可用 Roon 导航，多曲队列优先按应用顺序切换', async () => {
  const { controller, roon, nativeRoon } = makeHarness();
  const tracks = ['甲', '乙'].map((title, index) => ({ reference: `nav-${index}`, zoneId: 'zone-1',
    track: { id: String(9061 + index), title, artists: ['艺人'], album: '专辑' } }));
  await controller.replaceRoonQueue(tracks, 0);
  roon.nativeObservation = { revision: 2, zoneId: 'zone-1', state: 'playing', canNext: true, canPrevious: true };
  assert.equal(controller.getPlaybackState().canPrevious, true);
  await controller.next();
  assert.equal(nativeRoon.playCalls.at(-1)?.reference, 'nav-1');
  assert.deepEqual(roon.controlCalls, []);
  await controller.next();
  assert.deepEqual(roon.controlCalls, ['next']);
  await controller.previous();
  assert.equal(nativeRoon.playCalls.at(-1)?.reference, 'nav-0');
});

test('Roon 原生导航失败保留当前歌曲和封面，不伪造切换成功', async () => {
  const { controller, roon } = makeHarness();
  await controller.playRoon({ reference: 'native', zoneId: 'zone-1', track: {
    id: '9071', title: '原歌曲', artists: [], album: '专辑',
  } });
  roon.nativeObservation = { revision: 2, zoneId: 'zone-1', state: 'playing', canNext: true };
  roon.controlError = new BridgeError('ROON_TIMEOUT', '合成控制超时', { httpStatus: 502 });
  await assert.rejects(controller.next(), { code: 'ROON_TIMEOUT' });
  assert.equal(controller.getPlaybackState().currentTrack?.id, '9071');
  assert.equal(controller.getPlaybackState().state, 'playing');
});

test('Roon 新歌曲已开始后，排队中的旧 stopped 回调不能再推进一次', async () => {
  const { controller, roon, nativeRoon } = makeHarness();
  await controller.replaceRoonQueue(['甲', '乙', '丙'].map((title, index) => ({
    reference: `race-${index}`, zoneId: 'zone-1', track: { id: String(9021 + index), title, artists: ['艺人'], album: '专辑' },
  })), 0);
  controller.handleRoonPlaybackState('playing');
  controller.handleRoonPlaybackState('stopped');
  roon.state = { ...roon.state, transportState: 'playing' };
  roon.nativeObservation = { revision: 2, zoneId: 'zone-1', state: 'playing', nowPlaying: { title: '乙', artist: '艺人', album: '专辑' } };
  controller.syncRoonTransportState();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.getPlaybackState().currentTrack?.title, '乙');
  assert.equal(nativeRoon.playCalls.length, 1);
});

test('同名不同艺人的 Roon 续播更新身份，暂停后的新曲也可同步；网易云播放不被接管', async () => {
  const { controller, roon, nativeRoon } = makeHarness();
  nativeRoon.playObservation = { revision: 10, zoneId: 'zone-1', state: 'playing',
    nowPlaying: { title: '同名歌曲', artist: '甲艺人', album: '甲专辑', durationMs: 180_000 } };
  await controller.playRoon({ reference: 'same-title', zoneId: 'zone-1',
    track: { id: '9031', title: '同名歌曲', artists: ['甲艺人'], album: '甲专辑', durationMs: 180_000 } });
  roon.state = { ...roon.state, transportState: 'paused' };
  roon.nativeObservation = { revision: 11, zoneId: 'zone-1', state: 'paused', positionMs: 400,
    nowPlaying: { title: '同名歌曲', artist: '乙艺人', album: '乙专辑', durationMs: 180_000 } };
  controller.syncRoonTransportState();
  assert.deepEqual(controller.getPlaybackState().currentTrack?.artists, ['乙艺人']);
  assert.equal(controller.getPlaybackState().state, 'paused');
  assert.notEqual(controller.getPlaybackState().currentTrack?.id, '9031');
  await controller.play({ trackId: '9032' });
  roon.nativeObservation = { ...roon.nativeObservation, revision: 12, state: 'playing' };
  controller.syncRoonTransportState();
  assert.equal(controller.getPlaybackState().currentTrack?.id, '9032');
  assert.equal(controller.getPlaybackState().source, 'netease');
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

test('100 个相同位置回报保留播放事件且不重建队列投影', async () => {
  let clock = 1_700_000_000_000;
  const { controller } = makeHarness(206, undefined, () => clock);
  await controller.play({ trackId: '90101', quality: 'standard' });
  await controller.appendQueue([{ trackId: '90102', quality: 'standard' }]);

  const snapshots: PlaybackSnapshot[] = [];
  let queueEvents = 0;
  let lastQueue: PlaybackSnapshot['queue'] | undefined;
  const unsubscribe = controller.subscribe((snapshot) => {
    snapshots.push(snapshot);
    if (snapshot.queue !== lastQueue) {
      queueEvents += 1;
      lastQueue = snapshot.queue;
    }
  });
  const probe = controller as unknown as { projectQueueSnapshot: () => PlaybackSnapshot['queue'] };
  const projectQueue = probe.projectQueueSnapshot.bind(controller);
  let queueProjectionCalls = 0;
  probe.projectQueueSnapshot = () => {
    queueProjectionCalls += 1;
    return projectQueue();
  };
  const initialCount = snapshots.length;

  for (let index = 0; index < 100; index += 1) {
    clock += 250;
    assert.equal(controller.updateRoonTime(5_000), true);
  }

  assert.equal(snapshots.length - initialCount, 100);
  assert.equal(queueEvents, 1); // 首次订阅一次；这 100 次没有 queue.changed。
  assert.equal(queueProjectionCalls, 0);
  assert.equal(snapshots.at(-1)?.positionMs, 5_000);
  assert.ok(snapshots.slice(initialCount).every((snapshot) => snapshot.queue === lastQueue));
  unsubscribe();
});

test('队列元数据、顺序、index、来源和质量变化更新发布投影', async () => {
  const { controller, netease } = makeHarness();
  netease.actualQuality = 'exhigh';
  const snapshots: PlaybackSnapshot[] = [];
  const unsubscribe = controller.subscribe((snapshot) => snapshots.push(snapshot));
  await controller.play({ trackId: '90201', quality: 'lossless' });
  const playing = snapshots.at(-1)!;
  assert.equal(playing.queue.items[0]?.track?.title, 'Test Song');
  assert.equal(playing.queue.items[0]?.resolvedSource, 'netease');
  assert.equal(playing.queue.items[0]?.requestedQuality, 'lossless');
  assert.equal(playing.queue.items[0]?.actualQuality, 'exhigh');

  await controller.appendQueue([{ trackId: '90202', quality: 'standard' }]);
  const appended = snapshots.at(-1)!;
  assert.notEqual(appended.queue, playing.queue);
  assert.deepEqual(appended.queue.items.map((item) => item.trackId), ['90201', '90202']);
  assert.equal(appended.queue.hasNext, true);

  await controller.next();
  const advanced = snapshots.at(-1)!;
  assert.notEqual(advanced.queue, appended.queue);
  assert.equal(advanced.queue.index, 1);
  assert.equal(advanced.queue.hasPrevious, true);
  assert.equal(advanced.queue.hasNext, false);
  assert.equal(advanced.queue.items[1]?.resolvedSource, 'netease');
  unsubscribe();
});

test('分批队列元数据在 await 间隙写入后，下一进度事件使用新投影', async () => {
  let clock = 1_700_000_000_000;
  const { controller, netease } = makeHarness(206, undefined, () => clock);
  let releaseLast!: () => void;
  netease.metadataGate = new Promise<void>((resolve) => { releaseLast = resolve; });
  const queued = Array.from({ length: 21 }, (_, index) => ({
    trackId: String(90501 + index), quality: 'standard' as const,
  }));
  netease.blockedMetadataTrackIds.add(queued.at(-1)!.trackId);
  await controller.play({ trackId: '90500', quality: 'standard' });
  const snapshots: PlaybackSnapshot[] = [];
  const unsubscribe = controller.subscribe((snapshot) => snapshots.push(snapshot));
  await controller.appendQueue(queued);
  const appended = snapshots.at(-1)!;
  assert.equal(appended.queue.items[1]?.track, undefined);

  try {
    await waitFor(() => controller.getPlaybackState().queue.items[1]?.track !== undefined);
    assert.equal(snapshots.at(-1), appended); // 后台批次尚未全部结束。
    clock += 250;
    assert.equal(controller.updateRoonTime(1_000), true);
    const duringHydration = snapshots.at(-1)!;
    assert.notEqual(duringHydration.queue, appended.queue);
    assert.equal(duringHydration.queue.items[1]?.track?.id, queued[0]?.trackId);
    assert.equal(duringHydration.queue.items.at(-1)?.track, undefined);

    releaseLast();
    await waitFor(() => snapshots.at(-1)?.queue.items.at(-1)?.track !== undefined);
    assert.equal(snapshots.at(-1)?.queue.items.at(-1)?.track?.id, queued.at(-1)?.trackId);
  } finally {
    releaseLast();
    unsubscribe();
  }
});

test('发布投影隔离可变查询副本与内部 issue、队列和曲目信息', async () => {
  const { controller, netease } = makeHarness();
  netease.actualQuality = 'exhigh';
  const snapshots: PlaybackSnapshot[] = [];
  const unsubscribe = controller.subscribe((snapshot) => snapshots.push(snapshot));
  await controller.play({ trackId: '90301', quality: 'lossless' });
  const published = snapshots.at(-1)!;
  assert.equal(Object.isFrozen(published), true);
  assert.equal(Object.isFrozen(published.queue), true);
  assert.equal(Object.isFrozen(published.queue.items), true);
  assert.equal(Object.isFrozen(published.queue.items[0]?.track?.artists), true);
  assert.equal(Object.isFrozen(published.qualityNotice), true);

  const query = controller.getPlaybackState();
  query.currentTrack!.title = 'caller changed title';
  query.queue.items[0]!.track!.title = 'caller changed queue';
  (query.queue.items[0]!.track!.artists as string[])[0] = 'caller changed artist';
  query.qualityNotice!.message = 'caller changed notice';
  assert.equal(controller.getPlaybackState().currentTrack?.title, 'Test Song');
  assert.equal(controller.getPlaybackState().queue.items[0]?.track?.title, 'Test Song');
  assert.equal(controller.getPlaybackState().queue.items[0]?.track?.artists[0], 'Artist');
  assert.equal(controller.getPlaybackState().qualityNotice?.message, '请求 lossless，实际 exhigh');
  assert.equal(published.qualityNotice?.message, '请求 lossless，实际 exhigh');
  unsubscribe();

  const failing = makeHarness();
  failing.netease.unavailableTrackIds.add('90302');
  await assert.rejects(failing.controller.play({ trackId: '90302', quality: 'standard' }));
  const issue = failing.controller.getPlaybackState();
  assert.ok(issue.lastIssue);
  issue.lastIssue.message = 'caller changed issue';
  assert.notEqual(failing.controller.getPlaybackState().lastIssue?.message, 'caller changed issue');
});

test('后来订阅者不会提前确认旧订阅者尚未收到的同曲能力变化', async () => {
  const { controller, roon } = makeHarness();
  await controller.playRoon({ reference: 'same-track', zoneId: 'zone-1', track: {
    id: '90401', title: 'Same Song', artists: ['Artist'], album: 'Album',
  } });
  roon.state = { ...roon.state, transportState: 'playing' };
  roon.nativeObservation = { revision: 2, zoneId: 'zone-1', state: 'playing',
    canNext: false, nowPlaying: { title: 'Same Song', artist: 'Artist', album: 'Album' } };
  const original: PlaybackSnapshot[] = [];
  const stopOriginal = controller.subscribe((snapshot) => original.push(snapshot));
  controller.syncRoonTransportState();
  const before = original.length;
  roon.nativeObservation = { ...roon.nativeObservation, revision: 3, canNext: true };
  const later: PlaybackSnapshot[] = [];
  const stopLater = controller.subscribe((snapshot) => later.push(snapshot));
  assert.equal(later.at(-1)?.canNext, true);
  controller.syncRoonTransportState();
  assert.equal(original.length, before + 1);
  assert.equal(original.at(-1)?.canNext, true);
  const after = original.length;
  controller.syncRoonTransportState();
  assert.equal(original.length, after);
  stopLater();
  stopOriginal();
});


test('诊断时钟故障不阻止排队业务修改真实队列', async t => {
  const { controller } = makeHarness();
  const recorder = new PerformanceTraceRecorder({ component: 'core', enabled: true, now: () => 0 });
  const context = recorder.context()!;
  const clock = t.mock.method(performance, 'now', () => { throw new Error('合成诊断时钟故障'); });
  try {
    await withPerformanceContext(recorder, context, () => controller.appendQueue([{ trackId: '123', qualityPreference: 'lossless' }]));
    assert.equal(controller.getPlaybackState().queue.items[0]?.trackId, '123');
    assert.equal(recorder.snapshot().inflightCount, 0);
  } finally { clock.mock.restore(); }
});

function drainMbrController(controller: BridgeController): Promise<void> {
  // 仅测试侧等待已提交操作落定，不新增生产调度或依赖定时 sleep。
  const internal = controller as unknown as { operationTail: Promise<void>; externalTasks: Set<Promise<unknown>> };
  return (async () => {
    await internal.operationTail;
    while (internal.externalTasks.size > 0) await Promise.allSettled([...internal.externalTasks]);
  })();
}

function mbrNativeQueue(length = 2) {
  return Array.from({ length }, (_, index) => ({
    reference: `mbr-native-${index}`,
    zoneId: 'zone-1',
    track: { id: String(94001 + index), title: `本地曲目 ${index + 1}`, artists: ['合成艺人'], album: '合成专辑' },
  }));
}

for (const length of [2, 3]) {
  test(`MBR-001：${length}曲队列的旧 ended 排在 Next 后不能清除新曲或再前进`, async t => {
    const { controller, roon, registry } = makeHarness();
    t.after(() => controller.stop());
    await controller.replaceQueue(Array.from({ length }, (_, index) => ({
      trackId: String(93001 + index), quality: 'standard',
    })));
    const advancing = controller.next();
    roon.emitTerminal('ended');
    await advancing;
    await drainMbrController(controller);
    assert.deepEqual(roon.playRequests.map(request => request.metadata.id), ['93001', '93002']);
    const snapshot = controller.getPlaybackState();
    assert.equal(snapshot.currentTrack?.id, '93002');
    assert.equal(snapshot.queue.index, 1);
    assert.equal(snapshot.state, 'playing');
    assert.equal(snapshot.canStop, true);
    assert.equal(registry.size, 1);
  });
}

for (const reason of ['stopped', 'media_error', 'zone_lost'] as const) {
  test(`MBR-001：旧 ${reason} 排在 Next 后不能终止新曲或写入旧错误`, async t => {
    const { controller, roon, registry } = makeHarness();
    t.after(() => controller.stop());
    await controller.replaceQueue([{ trackId: '93101' }, { trackId: '93102' }]);
    const advancing = controller.next();
    roon.emitTerminal(reason);
    await advancing;
    await drainMbrController(controller);
    assert.deepEqual(roon.playRequests.map(request => request.metadata.id), ['93101', '93102']);
    const snapshot = controller.getPlaybackState();
    assert.equal(snapshot.currentTrack?.id, '93102');
    assert.equal(snapshot.state, 'playing');
    assert.equal(snapshot.lastIssue, undefined);
    assert.equal(snapshot.canStop, true);
    assert.equal(registry.size, 1);
  });
}

test('MBR-001：同一曲目的重复 ended 只推进一次', async t => {
  const { controller, roon, registry } = makeHarness();
  t.after(() => controller.stop());
  await controller.replaceQueue([{ trackId: '93201' }, { trackId: '93202' }, { trackId: '93203' }]);
  roon.emitTerminal('ended');
  roon.emitTerminal('ended');
  await drainMbrController(controller);
  assert.deepEqual(roon.playRequests.map(request => request.metadata.id), ['93201', '93202']);
  assert.equal(controller.getPlaybackState().currentTrack?.id, '93202');
  assert.equal(controller.getPlaybackState().queue.index, 1);
  assert.equal(registry.size, 1);
});

test('MBR-001：Provider 停止失败保留身份、位置和受控错误，成功重试后才清理', async t => {
  const { controller, roon, registry } = makeHarness();
  await controller.play({ trackId: '93301' });
  assert.equal(controller.updateRoonTime(18_000), true);
  const active = controller.getState().activePlayback;
  const failure = new BridgeError('ROON_TIMEOUT', '合成停止故障包含内部会话资料', { httpStatus: 504 });
  const originalStop = roon.stop.bind(roon);
  let shouldFail = true;
  const stop = t.mock.method(roon, 'stop', async () => {
    if (shouldFail) { roon.stopCalls++; throw failure; }
    await originalStop();
  });
  const snapshots: PlaybackSnapshot[] = [];
  const unsubscribe = controller.subscribe(snapshot => snapshots.push(snapshot));
  t.after(async () => { unsubscribe(); stop.mock.restore(); await controller.stop(); });

  await assert.rejects(controller.stop(), error => error === failure);
  assert.equal(roon.stopCalls, 1);
  assert.equal(controller.getState().activePlayback, active);
  const failed = controller.getPlaybackState();
  assert.equal(failed.currentTrack?.id, '93301');
  assert.equal(failed.positionMs, 18_000);
  assert.equal(failed.state, 'error');
  assert.equal(failed.canStop, true);
  assert.equal(failed.canPause, false);
  assert.equal(failed.canResume, false);
  assert.equal(failed.lastIssue?.retryable, true);
  assert.equal(failed.lastIssue?.action, 'retry');
  assert.equal(failed.lastIssue?.message, '停止尚未确认，请重试停止');
  assert.doesNotMatch(JSON.stringify(failed.lastIssue), /内部会话资料/);
  assert.equal(registry.size, 1);
  assert.ok(snapshots.every(snapshot => snapshot.state !== 'idle'));

  shouldFail = false;
  await controller.stop();
  assert.equal(roon.stopCalls, 2);
  assert.equal(controller.getPlaybackState().state, 'idle');
  assert.equal(controller.getPlaybackState().canStop, false);
  assert.equal(controller.getPlaybackState().currentTrack, undefined);
  assert.equal(controller.getPlaybackState().lastIssue, undefined);
  assert.equal(registry.size, 0);
  await controller.stop();
  assert.equal(roon.stopCalls, 2);
});

test('MBR-001：原生 Roon 停止失败保留身份与停止意图，成功重试后才清理', async t => {
  const { controller, nativeRoon, roon, registry } = makeHarness();
  nativeRoon.playObservation = { revision: 1, zoneId: 'zone-1', state: 'playing', positionMs: 7_000 };
  await controller.replaceRoonQueue(mbrNativeQueue(), 0);
  const failure = new BridgeError('ROON_TIMEOUT', '合成原生停止确认超时', { httpStatus: 504 });
  const originalStop = nativeRoon.stop.bind(nativeRoon);
  let shouldFail = true;
  const stop = t.mock.method(nativeRoon, 'stop', async () => {
    if (shouldFail) { nativeRoon.stopCalls++; throw failure; }
    await originalStop();
  });
  t.after(async () => { stop.mock.restore(); await controller.stop(); });
  await assert.rejects(controller.stop(), error => error === failure);
  const failed = controller.getPlaybackState();
  assert.equal(failed.currentTrack?.id, '94001');
  assert.equal(failed.source, 'roon');
  assert.equal(failed.positionMs, 7_000);
  assert.equal(failed.state, 'error');
  assert.equal(failed.canStop, true);
  assert.equal(failed.lastIssue?.retryable, true);
  assert.equal(failed.lastIssue?.message, '停止尚未确认，请重试停止');
  assert.equal(nativeRoon.active, true);
  assert.equal(controller.getState().activeRoonPlayback?.id, '94001');
  assert.equal(registry.size, 0);

  controller.handleRoonPlaybackState('playing');
  controller.handleRoonPlaybackState('stopped');
  await drainMbrController(controller);
  assert.deepEqual(nativeRoon.playCalls.map(call => call.reference), ['mbr-native-0']);
  assert.equal(controller.getPlaybackState().currentTrack?.id, '94001');
  assert.equal(controller.getPlaybackState().state, 'error');
  assert.equal(roon.playRequests.length, 0);

  shouldFail = false;
  await controller.stop();
  assert.equal(nativeRoon.stopCalls, 2);
  assert.equal(nativeRoon.active, false);
  assert.equal(controller.getPlaybackState().state, 'idle');
  assert.equal(controller.getPlaybackState().currentTrack, undefined);
  assert.equal(controller.getPlaybackState().canStop, false);
  assert.equal(controller.getPlaybackState().lastIssue, undefined);
});

for (const source of ['Provider', '原生 Roon'] as const) {
  test(`MBR-001：${source} 的 Next 遇到停止失败不能开始下一首或丢失原曲`, async t => {
    const { controller, nativeRoon, roon, registry } = makeHarness();
    const native = source === '原生 Roon';
    if (native) await controller.replaceRoonQueue(mbrNativeQueue(), 0);
    else await controller.replaceQueue([{ trackId: '93401' }, { trackId: '93402' }]);
    const port = native ? nativeRoon : roon;
    const failure = new BridgeError('ROON_TIMEOUT', '合成切歌前停止失败', { httpStatus: 504 });
    const stop = t.mock.method(port, 'stop', async () => { port.stopCalls++; throw failure; });
    t.after(async () => { stop.mock.restore(); await controller.stop(); });
    await assert.rejects(controller.next(), error => error === failure);
    assert.equal(controller.getPlaybackState().queue.index, 0);
    assert.equal(controller.getPlaybackState().currentTrack?.id, native ? '94001' : '93401');
    assert.equal(controller.getPlaybackState().state, 'error');
    assert.equal(controller.getPlaybackState().canStop, true);
    assert.equal(nativeRoon.playCalls.length, native ? 1 : 0);
    assert.equal(roon.playRequests.length, native ? 0 : 1);
    assert.equal(registry.size, native ? 0 : 1);
  });
}

test('MBR-001：Provider 停止失败后的真实 ended 可以清理，但不能自动开启下一首', async t => {
  const { controller, roon, registry } = makeHarness();
  await controller.replaceQueue([{ trackId: '93501' }, { trackId: '93502' }]);
  const failure = new BridgeError('ROON_TIMEOUT', '合成停止失败', { httpStatus: 504 });
  const stop = t.mock.method(roon, 'stop', async () => { roon.stopCalls++; throw failure; });
  t.after(async () => { stop.mock.restore(); await controller.stop(); });
  await assert.rejects(controller.stop(), error => error === failure);
  assert.equal(controller.getPlaybackState().canStop, true);
  roon.emitTerminal('ended');
  await drainMbrController(controller);
  assert.deepEqual(roon.playRequests.map(request => request.metadata.id), ['93501']);
  assert.equal(controller.getPlaybackState().state, 'idle');
  assert.equal(controller.getPlaybackState().currentTrack, undefined);
  assert.equal(registry.size, 0);
});

test('MBR-001：停止等待期间到达的 ended 不因随后停止失败而自动续播', { timeout: 1_000 }, async t => {
  const { controller, roon, registry } = makeHarness();
  await controller.replaceQueue([{ trackId: '93601' }, { trackId: '93602' }]);
  let entered!: () => void;
  let rejectStop!: (error: unknown) => void;
  const entry = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>((_resolve, reject) => { rejectStop = reject; });
  const failure = new BridgeError('ROON_TIMEOUT', '合成延迟停止失败', { httpStatus: 504 });
  const stop = t.mock.method(roon, 'stop', () => { roon.stopCalls++; entered(); return pending; });
  const states: string[] = [];
  const unsubscribe = controller.subscribe(snapshot => states.push(snapshot.state));
  t.after(async () => { unsubscribe(); stop.mock.restore(); await controller.stop(); });
  const stopping = controller.stop();
  const rejected = assert.rejects(stopping, error => error === failure);
  await entry;
  assert.equal(controller.getPlaybackState().state, 'stopping');
  roon.emitTerminal('ended');
  rejectStop(failure);
  await rejected;
  await drainMbrController(controller);
  assert.ok(states.includes('error'));
  assert.deepEqual(roon.playRequests.map(request => request.metadata.id), ['93601']);
  assert.equal(controller.getPlaybackState().state, 'idle');
  assert.equal(registry.size, 0);
});

test('MBR-001：新鲜 paused 到 stopped 清理原生身份，但不视为自然结束续播', async t => {
  const { controller, nativeRoon, roon } = makeHarness();
  t.after(() => controller.stop());
  await controller.replaceRoonQueue(mbrNativeQueue(), 0);
  roon.state = { ...roon.state, transportState: 'playing', canPause: true };
  await controller.pause();
  controller.handleRoonPlaybackState('paused');
  nativeRoon.active = false;
  roon.nativeObservation = { revision: 2, zoneId: 'zone-1', state: 'stopped' };
  controller.handleRoonPlaybackState('stopped');
  await drainMbrController(controller);
  assert.equal(controller.getPlaybackState().state, 'idle');
  assert.equal(controller.getPlaybackState().currentTrack, undefined);
  assert.equal(controller.getPlaybackState().canStop, false);
  assert.equal(controller.getPlaybackState().queue.index, 0);
  assert.deepEqual(nativeRoon.playCalls.map(call => call.reference), ['mbr-native-0']);
  assert.equal(nativeRoon.stopCalls, 0);
});

test('MBR-001：暂停后过期或其他 Zone 的 stopped 不能清理，新鲜本 Zone 观测才可清理', async t => {
  const { controller, nativeRoon, roon } = makeHarness();
  t.after(() => controller.stop());
  await controller.replaceRoonQueue(mbrNativeQueue(), 0);
  roon.state = { ...roon.state, transportState: 'playing', canPause: true };
  await controller.pause();
  controller.handleRoonPlaybackState('paused');
  for (const observation of [
    { revision: 1, zoneId: 'zone-1', state: 'stopped' as const },
    { revision: 2, zoneId: 'zone-other', state: 'stopped' as const },
  ]) {
    roon.nativeObservation = observation;
    controller.handleRoonPlaybackState('stopped');
    await drainMbrController(controller);
    assert.equal(controller.getPlaybackState().currentTrack?.id, '94001');
    assert.equal(controller.getPlaybackState().state, 'paused');
    assert.equal(controller.getPlaybackState().canStop, true);
  }
  roon.nativeObservation = { revision: 2, zoneId: 'zone-1', state: 'stopped' };
  controller.handleRoonPlaybackState('stopped');
  await drainMbrController(controller);
  assert.equal(controller.getPlaybackState().state, 'idle');
  assert.equal(controller.getPlaybackState().currentTrack, undefined);
  assert.equal(nativeRoon.playCalls.length, 1);
});

test('MBR-001：暂停后 stopped 排队期间收到新 playing，不能按旧观测清理', async t => {
  const { controller, nativeRoon, roon } = makeHarness();
  t.after(() => controller.stop());
  await controller.replaceRoonQueue(mbrNativeQueue(), 0);
  roon.state = { ...roon.state, transportState: 'playing', canPause: true };
  await controller.pause();
  controller.handleRoonPlaybackState('paused');
  roon.nativeObservation = { revision: 2, zoneId: 'zone-1', state: 'stopped' };
  controller.handleRoonPlaybackState('stopped');
  roon.state = { ...roon.state, transportState: 'playing' };
  roon.nativeObservation = { revision: 3, zoneId: 'zone-1', state: 'playing' };
  controller.syncRoonTransportState();
  controller.handleRoonPlaybackState('playing');
  await drainMbrController(controller);
  assert.equal(controller.getPlaybackState().currentTrack?.id, '94001');
  assert.equal(controller.getPlaybackState().state, 'playing');
  assert.equal(controller.getPlaybackState().canStop, true);
  assert.equal(nativeRoon.playCalls.length, 1);
});

test('MBR-001：Core 断开缺少原生状态时保留身份与位置，标记可恢复错误而不续播', async t => {
  const { controller, nativeRoon, roon, registry } = makeHarness();
  nativeRoon.playObservation = { revision: 1, zoneId: 'zone-1', state: 'playing', positionMs: 8_000 };
  await controller.replaceRoonQueue(mbrNativeQueue(), 0);
  t.after(() => controller.stop());
  controller.handleRoonPlaybackState('playing');
  roon.state = { status: 'discovering' };
  controller.handleRoonPlaybackState(undefined);
  await drainMbrController(controller);
  const snapshot = controller.getPlaybackState();
  assert.equal(snapshot.currentTrack?.id, '94001');
  assert.equal(snapshot.positionMs, 8_000);
  assert.equal(snapshot.state, 'error');
  assert.equal(snapshot.canStop, true);
  assert.equal(snapshot.canPause, false);
  assert.equal(snapshot.canResume, false);
  assert.equal(snapshot.lastIssue?.retryable, true);
  assert.equal(snapshot.lastIssue?.message, 'Roon 播放状态暂不可确认，请重新连接后重试停止');
  assert.equal(nativeRoon.playCalls.length, 1);
  assert.equal(registry.size, 0);

  // 单纯恢复状态字符串不足以重新确认身份，更不能随后自动跳到另一首。
  roon.state = { status: 'playing', selectedZoneId: 'zone-1', transportState: 'playing' };
  roon.nativeObservation = { revision: 2, zoneId: 'zone-1', state: 'playing' };
  controller.syncRoonTransportState();
  controller.handleRoonPlaybackState('playing');
  roon.nativeObservation = { revision: 3, zoneId: 'zone-1', state: 'stopped' };
  controller.handleRoonPlaybackState('stopped');
  await drainMbrController(controller);
  assert.equal(controller.getPlaybackState().state, 'error');
  assert.equal(controller.getPlaybackState().currentTrack?.id, '94001');
  assert.equal(nativeRoon.playCalls.length, 1);
});

test('MBR-001：旧 Core 缺失状态排在 Next 后不能给新曲写入错误', async t => {
  const { controller, nativeRoon } = makeHarness();
  t.after(() => controller.stop());
  await controller.replaceRoonQueue(mbrNativeQueue(), 0);
  const advancing = controller.next();
  controller.handleRoonPlaybackState(undefined);
  await advancing;
  await drainMbrController(controller);
  assert.equal(controller.getPlaybackState().currentTrack?.id, '94002');
  assert.equal(controller.getPlaybackState().state, 'playing');
  assert.equal(controller.getPlaybackState().lastIssue, undefined);
  assert.deepEqual(nativeRoon.playCalls.map(call => call.reference), ['mbr-native-0', 'mbr-native-1']);
});

function mbpDeferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function displayReadTestCleanup(t: test.TestContext, steps: Array<() => unknown>): void {
  t.after(async () => {
    const errors: unknown[] = [];
    for (const step of steps) { try { await step(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, '封面显示关键期测试清理未全部确认。', { cause: errors[0] });
  });
}

function makeLocalGuardHarness(t:test.TestContext,logger=createLogger('info'),onEncodedLine?:(line:string)=>void) {
  const rows:Record<string,unknown>[]=[],phaseRows:Record<string,unknown>[]=[],fences=new Map<string,LocalSourceFence>();
  const sink=t.mock.method(console,'log',(line:unknown)=>{if(typeof line!=='string')return;onEncodedLine?.(line+'\n');try{const value=JSON.parse(line) as Record<string,unknown>;if(value.event==='local_play_request_guard_evidence')rows.push(value);else if(value.event==='local_playback_evidence')phaseRows.push(value);}catch{}});
  const datasetId=randomUUID(),rootId=randomUUID(),sourceId=randomUUID(),trackId=randomUUID(),assetId=randomUUID(),requestId=randomUUID();
  const facts:LocalSourceCaptureResult['facts']={track:{id:trackId,assetId,selectionRevision:'1',segment:null},
    asset:{id:assetId,libraryRootId:rootId,sourceRootId:sourceId,rootRevision:'1',fileRevision:'1',locationRevision:'1',sampleFrames:null,timebaseHz:null},
    root:{id:rootId,sourceRootId:sourceId,role:'library',revision:'1'},sourceRoot:{id:sourceId,path:'/private-guard-secret/source',dev:'1',ino:'2',authorized:true,label:'私有合成目录'},relative:'private-guard-secret.wav',
    observation:{signature:'1:2:3:4:5',assetId,trackId,libraryRootId:rootId,sourceRootId:sourceId,fileRevision:'1',rootRevision:'1',locationRevision:'1',selectionRevision:'1'}};
  const state={targetCurrent:true,sourceCurrent:true,targetChecks:0,sourceChecks:0,targetCaptures:0,captures:0,releases:0,materializations:0,saves:0,
    changeAtCapture:0,captureError:undefined as unknown,releaseError:undefined as unknown,captureGate:undefined as Promise<void>|undefined,
    captureEntered:undefined as ReturnType<typeof mbpDeferred<void>>|undefined};
  const request=(album=true,action:LocalPlayRequest['action']='PLAY_NOW'):LocalPlayRequest=>({schema_version:'1.2',request_id:requestId,route:'roon_audio_input',source_kind:'local_file',
    local_track_id:trackId,asset_id:assetId,expected_asset_revision:'1',target:{core_id:'private-guard-secret-core',zone_id:'zone-1'},action,
    ...(album?{album:{datasetId,albumKey:'synthetic-guard-album',rootId,revision:'album-1',kind:'source-directory' as const,editionId:null,trackCount:1}}:{})});
  const port={
    isLocalSourceCurrent(){++state.sourceChecks;return state.sourceCurrent;},
    async prepare(){return {datasetId,epoch:randomUUID(),snapshotId:randomUUID()};},
    async saveMBQueue(value:MBQueueSaveRequest):Promise<MBQueueRecord>{++state.saves;return structuredClone(value.queue);},
    async readLocalAlbum(value:LocalAlbumOwnerReadRequest){
      assert.equal(value.command,'localAlbum.materializeQueue');if(value.command!=='localAlbum.materializeQueue')throw new Error('仅允许原专辑物化请求。');
      ++state.materializations;
      return {album:structuredClone(value.payload.selection.album!),edition:null,startIndex:0,sources:[{kind:'local_file' as const,edition:null,
        snapshot:{sourceKind:'local_file' as const,trackId,assetId,libraryRootId:rootId,sourceRootId:sourceId,rootRevision:'1',fileRevision:'1',locationRevision:'1',selectionRevision:'1',segment:null}}]};
    },
    async captureLocalSource():Promise<LocalSourceCaptureResult>{
      const ordinal=++state.captures;state.captureEntered?.resolve();await state.captureGate;if(state.captureError!==undefined)throw state.captureError;
      const captured=structuredClone(facts);if(state.changeAtCapture===ordinal){captured.root.revision='2';captured.asset.rootRevision='2';captured.observation!.rootRevision='2';}
      const fence=LocalSourceFence.create(),ticketId='synthetic-guard-ticket-'+ordinal;fences.set(ticketId,fence);
      return {ticketId,epoch:'synthetic-guard-epoch',datasetId,buffer:fence.buffer,facts:captured,format:'wav',metadata:{id:trackId,title:'合成守卫曲',artists:['合成'],album:'合成专辑'}};
    },
    async releaseLocalSource(ticketId:string){++state.releases;if(state.releaseError!==undefined)throw state.releaseError;fences.get(ticketId)?.revoke();fences.delete(ticketId);},
    sealLocalSources(){for(const fence of fences.values())fence.revoke();},
  } as unknown as NonNullable<ConstructorParameters<typeof BridgeController>[0]['localSources']>;
  const f=makeHarness(206,undefined,undefined,undefined,{logger,localSources:port,isLocalPlaybackAllowed:()=>true});
  Object.assign(f.roon,{captureLocalTarget:()=>{++state.targetCaptures;return {target:{core_id:'private-guard-secret-core',zone_id:'zone-1'},isCurrent:()=>{++state.targetChecks;return state.targetCurrent;}};}});
  const closeFences=()=>{const errors:unknown[]=[];for(const fence of fences.values()){try{fence.revoke();}catch(error){errors.push(error);}try{fence.assertQuiet();}catch(error){errors.push(error);}}if(errors.length)throw new AggregateError(errors,'守卫旁注合成fence清理未全部确认。',{cause:errors[0]});};
  return {...f,rows,phaseRows,state,request,sink,facts,fences,closeFences};
}
function assertLocalGuardSchema(rows:readonly Record<string,unknown>[]):void {
  const fields=['timestamp','level','event','schemaVersion','component','diagnosticId','requestFingerprintSha256','stage','operationStage','firstStage','phase','elapsedMs','code','errorClass','httpStatus','cancelled','intentMatch','targetMatch','sourceMatch','fenceMatch','snapshotMatch','factsMatch','differenceMask'].sort();
  for(const row of rows){assert.deepEqual(Object.keys(row).sort(),fields);assert.equal(row.level,'info');assert.equal(row.event,'local_play_request_guard_evidence');assert.equal(row.schemaVersion,1);assert.equal(row.component,'controller');assert.equal(row.stage,'request-guard');
    assert.match(String(row.timestamp),/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);assert.match(String(row.diagnosticId),/^diag-local-[a-f0-9]{64}$/u);assert.match(String(row.requestFingerprintSha256),/^[a-f0-9]{64}$/u);
    assert.ok(Number.isSafeInteger(row.elapsedMs)&&Number(row.elapsedMs)>=0&&Number(row.elapsedMs)<=86400000);assert.ok(Number.isSafeInteger(row.differenceMask)&&Number(row.differenceMask)>=0&&Number(row.differenceMask)<=16383);
    for(const key of ['intentMatch','targetMatch','sourceMatch','fenceMatch','snapshotMatch','factsMatch'])assert.ok(['not-checked','match','mismatch'].includes(String(row[key])));
  }
}

test('原点播守卫旁注：点击快照首拒与release覆盖分保，60加4上界及安全hash不改原错误',async t=>{
  const f=makeLocalGuardHarness(t),gate=mbpDeferred<void>(),entered=mbpDeferred<void>();
  let getterReads=0,codeReads=0;const cleanupError=new BridgeError('INTERNAL_ERROR','private-guard-secret-error',{httpStatus:503});
  Object.defineProperty(cleanupError,'code',{get(){++codeReads;return 'INTERNAL_ERROR';}});
  for(const key of ['message','stack','name'])Object.defineProperty(cleanupError,key,{get(){++getterReads;throw new Error('诊断不能读取错误文本或getter。');}});
  f.state.changeAtCapture=1;f.state.captureGate=gate.promise;f.state.captureEntered=entered;f.state.releaseError=cleanupError;
  displayReadTestCleanup(t,[()=>gate.resolve(),()=>{f.state.releaseError=undefined;},()=>f.controller.shutdown(),()=>f.closeFences(),()=>f.gateway.stop(),()=>f.sink.mock.restore()]);
  const request=f.request(),work=f.controller.playLocal(request);void work.catch(()=>{});await entered.promise;
  const heldRowCount=f.rows.length,conflicts:Promise<void>[]=[];
  for(let i=0;i<80;i++){
    assert.equal(f.controller.playLocal(request),work,'原同UUID同正文仍返回原Promise，不再次物化或捕获。');
    conflicts.push(assert.rejects(f.controller.playLocal({...request,target:{...request.target,core_id:'synthetic-conflict-core'}}),{code:'BAD_REQUEST'}));
  }
  await Promise.all(conflicts);assert.equal(f.rows.length,heldRowCount,'重复与冲突不输出新trace，也不占原工作预算。');
  gate.resolve();await assert.rejects(work,error=>error===cleanupError);
  assertLocalGuardSchema(f.rows);
  const first=f.rows.find(row=>row.phase==='failed'&&row.operationStage==='SELECTED_SNAPSHOT')!;
  assert.equal(first.firstStage,'SELECTED_SNAPSHOT');assert.equal(first.snapshotMatch,'mismatch');assert.equal(first.differenceMask,0);assert.equal(first.code,'BAD_REQUEST');assert.equal(first.cancelled,'yes');
  const cleanup=f.rows.find(row=>row.phase==='cleanup-failed')!;assert.equal(cleanup.operationStage,'RELEASE_CAPTURE');assert.equal(cleanup.firstStage,'SELECTED_SNAPSHOT');assert.equal(cleanup.code,'UNKNOWN');assert.equal(cleanup.httpStatus,503);
  const final=f.rows.find(row=>row.operationStage==='RELEASE_CAPTURE'&&row.phase==='failed'&&row.firstStage==='SELECTED_SNAPSHOT')!;assert.ok(final);
  assert.equal(f.rows.at(-1)?.operationStage,'COMPLETED');assert.equal(f.rows.at(-1)?.phase,'failed');assert.equal(getterReads,0);assert.equal(codeReads,1,'只保留原回执映射自身的code读取。');
  const reserved=new Set([first,cleanup,final,f.rows.at(-1)!]);assert.equal(reserved.size,4);assert.ok(f.rows.filter(row=>!reserved.has(row)).length<=60);assert.ok(f.rows.length<=64);
  assert.equal(first.diagnosticId,'diag-local-'+createHash('sha256').update('musicbridge-local-request-guard-v1\0').update(request.request_id).digest('hex'));
  assert.equal(first.requestFingerprintSha256,createHash('sha256').update('musicbridge-local-request-fingerprint-v1\0').update(JSON.stringify(request)).digest('hex'));
  const serialized=JSON.stringify(f.rows);for(const value of [request.request_id,request.asset_id,request.local_track_id,request.target.core_id,'private-guard-secret'])assert.ok(!serialized.includes(value));
  assert.deepEqual([f.state.materializations,f.state.captures,f.state.releases,f.state.saves,f.state.targetCaptures,f.state.targetChecks,f.state.sourceChecks,f.roon.playRequests.length],[1,1,1,0,1,3,3,0]);
  const settledRowCount=f.rows.length;assert.equal(f.controller.playLocal(request),work);assert.equal(f.rows.length,settledRowCount,'原Promise结算后不再输出该context。');
});

test('原点播守卫旁注：第二次facts变化在原lease和SDK前拒绝，不重复读取谓词',async t=>{
  const f=makeLocalGuardHarness(t);f.state.changeAtCapture=2;
  displayReadTestCleanup(t,[()=>f.controller.shutdown(),()=>f.closeFences(),()=>f.gateway.stop(),()=>f.sink.mock.restore()]);
  await assert.rejects(f.controller.playLocal(f.request()),{code:'BAD_REQUEST'});assertLocalGuardSchema(f.rows);
  const first=f.rows.find(row=>row.phase==='failed'&&row.operationStage==='SECOND_FACTS')!;assert.equal(first.firstStage,'SECOND_FACTS');assert.equal(first.factsMatch,'mismatch');assert.equal(first.differenceMask,0);
  assert.ok(f.rows.some(row=>row.operationStage==='SECOND_FACTS'&&row.phase==='failed'&&row.code==='BAD_REQUEST'));
  assert.ok(!f.rows.some(row=>row.operationStage==='LEASE_REGISTER'||row.operationStage==='SDK_SUBMIT'));
  assert.deepEqual([f.state.materializations,f.state.captures,f.state.releases,f.state.saves,f.state.targetCaptures,f.state.targetChecks,f.state.sourceChecks,f.roon.playRequests.length],[1,2,2,1,1,7,6,0]);
  assert.equal(f.fences.size,0);assert.equal(f.rows.at(-1)?.operationStage,'COMPLETED');
});

test('原点播守卫旁注：原capture错误被公开stop的intent取消覆盖时仍保首阶段和原来源码',async t=>{
  const f=makeLocalGuardHarness(t),gate=mbpDeferred<void>(),entered=mbpDeferred<void>(),sourceError=new LocalSourcePreparationError('FACTS_CHANGED');
  f.state.captureGate=gate.promise;f.state.captureEntered=entered;f.state.captureError=sourceError;
  displayReadTestCleanup(t,[()=>gate.resolve(),()=>f.controller.shutdown(),()=>f.gateway.stop(),()=>f.sink.mock.restore()]);
  const work=f.controller.playLocal(f.request());void work.catch(()=>{});await entered.promise;const stopped=f.controller.stop();gate.resolve();
  await assert.rejects(work,error=>error instanceof BridgeError&&error.code==='BAD_REQUEST'&&error.details?.reason==='operation_cancelled');await stopped;
  assertLocalGuardSchema(f.rows);const first=f.rows.find(row=>row.phase==='failed'&&row.operationStage==='SOURCE_CAPTURE')!;
  assert.equal(first.firstStage,'SOURCE_CAPTURE');assert.equal(first.code,'FACTS_CHANGED');assert.equal(first.errorClass,'LocalSourcePreparationError');
  assert.ok(f.rows.some(row=>row.operationStage==='INTENT'&&row.phase==='failed'&&row.firstStage==='SOURCE_CAPTURE'&&row.code==='BAD_REQUEST'&&row.cancelled==='yes'));
  assert.deepEqual([f.state.captures,f.state.releases,f.state.saves,f.roon.playRequests.length],[1,0,0,0]);assert.equal(f.rows.at(-1)?.operationStage,'COMPLETED');
});

test('原点播守卫旁注：logger失败不改原结果，实际Main旁路保原守卫与媒体phase关联',async t=>{
  const collector=createLocalPlaybackEvidenceCollector(),forwarded:LocalPlaybackEvidenceRecord[]=[],stableSink=(row:LocalPlaybackEvidenceRecord)=>{forwarded.push(row);};
  const logger=createLogger('info'),f=makeLocalGuardHarness(t,logger,line=>collector.consume(line,stableSink)),fault=t.mock.method(logger,'info',()=>{throw new Error('合成诊断sink失败。');});
  // 仅隔离原租约与媒体端口；不打开文件、不提供真实FD或媒体字节。
  let leaseState:'PREPARED'|'CLOSED'='PREPARED',boundDiagnosticId:string|undefined;
  const lease={size:1,get state(){return leaseState;},async close(){leaseState='CLOSED';}} as unknown as Awaited<ReturnType<StreamRegistry['registerLocalSource']>>['lease'];
  const register=t.mock.method(f.registry,'registerLocalSource',async()=>({token:'synthetic-guard-owned-token',lease}));
  const revoke=t.mock.method(f.registry,'revokeLocal',async()=>{await lease.close();});
  const media=t.mock.method(f.gateway,'localStreamUrl',(...args:Parameters<StreamGateway['localStreamUrl']>)=>{boundDiagnosticId=args[2]?.diagnosticId;return 'http://127.0.0.1:38502/synthetic-local-stream';});
  displayReadTestCleanup(t,[()=>f.controller.shutdown(),()=>lease.close(),()=>f.closeFences(),()=>f.gateway.stop(),()=>collector.clear(),()=>register.mock.restore(),()=>revoke.mock.restore(),()=>media.mock.restore(),()=>fault.mock.restore(),()=>f.sink.mock.restore()]);
  f.state.targetCurrent=false;const rejected=f.request();await assert.rejects(f.controller.playLocal(rejected),{code:'BAD_REQUEST'});
  assert.deepEqual([f.state.targetCaptures,f.state.targetChecks,f.state.sourceChecks,f.state.captures,f.state.saves],[1,1,1,0,0]);
  f.state.targetCurrent=true;const request={...f.request(false,'APPEND_MB_QUEUE'),request_id:randomUUID()},work=f.controller.playLocal(request);
  assert.equal(f.controller.playLocal(request),work);assert.deepEqual(await work,{status:'accepted',request_id:request.request_id,action:'APPEND_MB_QUEUE'});
  assert.equal(f.state.captures,1);assert.equal(f.state.releases,1);assert.equal(f.state.saves,1);assert.equal(f.roon.playRequests.length,0);assert.equal(f.rows.length,0);
  fault.mock.restore();
  f.state.targetCurrent=false;const transportedRequest={...f.request(false),request_id:randomUUID()};
  await assert.rejects(f.controller.playLocal(transportedRequest),{code:'BAD_REQUEST'});assertLocalGuardSchema(forwarded);assert.deepEqual(forwarded,f.rows);
  const transportedFailure=f.rows.find(row=>row.operationStage==='TARGET_CAPTURE'&&row.phase==='failed')!;
  assert.ok(transportedFailure);assert.deepEqual(copyLocalPlaybackEvidence(transportedFailure),transportedFailure);assert.ok(forwarded.some(row=>row.phase==='failed'&&row.operationStage==='TARGET_CAPTURE'&&row.code==='BAD_REQUEST'));
  const admitted=forwarded.length,ringSize=collector.snapshot().length;
  for(const change of [{url:'private-guard-secret'},{operationStage:'UNKNOWN_STAGE'}]){const poison={...transportedFailure,...change};assert.equal(copyLocalPlaybackEvidence(poison),null);collector.consume(JSON.stringify(poison)+'\n',stableSink);}
  assert.equal(forwarded.length,admitted);assert.equal(collector.snapshot().length,ringSize);
  f.state.targetCurrent=true;const rowOffset=f.rows.length,sinkOffset=forwarded.length;
  const playingRequest={...f.request(false),request_id:randomUUID()},playing=f.controller.playLocal(playingRequest);
  assert.deepEqual(await playing,{status:'accepted',request_id:playingRequest.request_id,action:'PLAY_NOW'});assert.equal(register.mock.callCount(),1);assert.equal(f.roon.playRequests.length,1);
  const playingRows=f.rows.slice(rowOffset),playingForwarded=forwarded.slice(sinkOffset);assertLocalGuardSchema(playingRows);assert.deepEqual(playingForwarded,playingRows);
  const fingerprint=createHash('sha256').update('musicbridge-local-request-fingerprint-v1\0').update(JSON.stringify(playingRequest)).digest('hex');
  assert.ok(playingRows.length>0);assert.ok(playingForwarded.every(row=>row.requestFingerprintSha256===fingerprint));
  const phase=f.phaseRows.find(row=>row.stage==='roon-phase'&&row.phase==='SUBMITTING')!;assert.ok(phase);assert.equal(boundDiagnosticId,phase.diagnosticId);
  assert.equal(playingForwarded.find(row=>row.operationStage==='REQUEST_GATE')?.diagnosticId,'diag-local-'+createHash('sha256').update('musicbridge-local-request-guard-v1\0').update(playingRequest.request_id).digest('hex'));
  for(const stage of ['LEASE_REGISTER','SDK_SUBMIT','COMPLETED'])assert.equal(playingForwarded.find(row=>row.operationStage===stage&&row.phase==='succeeded')?.diagnosticId,phase.diagnosticId);
  assert.ok(f.phaseRows.some(row=>row.stage==='roon-phase'&&row.phase==='AWAITING_ROON'&&row.diagnosticId===phase.diagnosticId));
  assert.ok(collector.snapshot().some(row=>row.stage==='roon-phase'&&row.phase==='AWAITING_ROON'&&row.diagnosticId===phase.diagnosticId));
});

test('原点播守卫旁注：原SDK等待中重复及冲突不覆盖原阶段或抢占首错保留槽',async t=>{
  const f=makeLocalGuardHarness(t),gate=mbpDeferred<void>(),entered=mbpDeferred<void>(),sdkError=new BridgeError('ROON_MEDIA_ERROR','合成SDK拒绝',{httpStatus:503});
  let leaseState:'PREPARED'|'CLOSED'='PREPARED';
  const lease={size:1,get state(){return leaseState;},async close(){leaseState='CLOSED';}} as unknown as Awaited<ReturnType<StreamRegistry['registerLocalSource']>>['lease'];
  const register=t.mock.method(f.registry,'registerLocalSource',async()=>({token:'synthetic-guard-held-token',lease}));
  const revoke=t.mock.method(f.registry,'revokeLocal',async()=>{await lease.close();});
  const media=t.mock.method(f.gateway,'localStreamUrl',()=> 'http://127.0.0.1:38502/synthetic-held-stream');
  const originalPlay=f.roon.play.bind(f.roon),play=t.mock.method(f.roon,'play',async(request:RoonPlayRequest)=>{await originalPlay(request);entered.resolve();await gate.promise;throw sdkError;});
  displayReadTestCleanup(t,[()=>gate.resolve(),()=>f.controller.shutdown(),()=>lease.close(),()=>f.closeFences(),()=>f.gateway.stop(),()=>register.mock.restore(),()=>revoke.mock.restore(),()=>media.mock.restore(),()=>play.mock.restore(),()=>f.sink.mock.restore()]);
  const request=f.request(),work=f.controller.playLocal(request);void work.catch(()=>{});await Promise.race([entered.promise,work.then(()=>{throw new Error('原SDK尚未进入便提前结算。');})]);
  const calls=()=>[f.state.materializations,f.state.captures,f.state.releases,f.state.saves,f.state.targetCaptures,f.state.targetChecks,f.state.sourceChecks,f.roon.playRequests.length,register.mock.callCount(),play.mock.callCount()];
  const heldCalls=calls(),heldRows=f.rows.length,conflicts:Promise<void>[]=[];
  assert.equal(f.rows.at(-1)?.operationStage,'SDK_SUBMIT');assert.equal(f.rows.at(-1)?.phase,'started');
  for(let i=0;i<80;i++){
    assert.equal(f.controller.playLocal(request),work);
    conflicts.push(assert.rejects(f.controller.playLocal({...request,target:{...request.target,core_id:'synthetic-conflict-core'}}),{code:'BAD_REQUEST'}));
  }
  await Promise.all(conflicts);assert.equal(f.rows.length,heldRows);assert.deepEqual(calls(),heldCalls);
  gate.resolve();await assert.rejects(work,error=>error===sdkError);assertLocalGuardSchema(f.rows);
  const first=f.rows.find(row=>row.phase==='failed')!;assert.equal(first.operationStage,'SDK_SUBMIT');assert.equal(first.firstStage,'SDK_SUBMIT');assert.equal(first.code,'ROON_MEDIA_ERROR');
  assert.equal(f.rows.at(-1)?.operationStage,'COMPLETED');assert.equal(f.rows.at(-1)?.firstStage,'SDK_SUBMIT');assert.equal(f.rows.at(-1)?.code,'ROON_MEDIA_ERROR');
  assert.equal(f.rows.filter(row=>row.operationStage==='SDK_SUBMIT'&&row.phase==='failed').length,2,'原首业务拒绝与实际末拒绝各保留一次。');
  assert.ok(f.rows.length<=64);assert.deepEqual([f.state.materializations,f.state.captures,f.state.releases,f.state.saves,f.roon.playRequests.length,register.mock.callCount(),revoke.mock.callCount(),play.mock.callCount()],[1,2,2,1,1,1,1,1]);
  const settledRows=f.rows.length;assert.equal(f.controller.playLocal(request),work);assert.equal(f.rows.length,settledRows);
});

test('封面显示关键期：冷idle与确认playing暂停可读，控制受理和关闭同步阻断', async t => {
  let controller: BridgeController | undefined;
  const notifications: boolean[] = [], f = makeHarness(206, undefined, undefined, () => { notifications.push(controller?.hasDisplayReadPriorityBlocker() ?? true); });
  controller = f.controller;
  displayReadTestCleanup(t, [() => { f.roon.shouldFailOnStop = false; }, () => f.controller.shutdown(), () => f.gateway.stop()]);
  const initial = f.roon.state; f.roon.state = { status: 'discovering' };
  assert.equal(f.controller.hasDisplayReadPriorityBlocker(), false); assert.equal(f.controller.hasPlaybackOwnership(), false);
  f.roon.state = initial;
  const playing = f.controller.play({ trackId: '99401' });
  assert.equal(f.controller.hasDisplayReadPriorityBlocker(), true); assert.equal(notifications.at(-1), true);
  await playing;
  assert.equal(f.controller.hasPlaybackOwnership(), true); assert.equal(f.controller.hasDisplayReadPriorityBlocker(), false);
  const pause = f.controller.pause();
  assert.equal(f.roon.pauseCalls, 0); assert.equal(f.controller.hasDisplayReadPriorityBlocker(), true); assert.equal(notifications.at(-1), true);
  await pause; assert.equal(f.controller.getPlaybackState().state, 'paused'); assert.equal(f.controller.hasDisplayReadPriorityBlocker(), false);
  const seek = f.controller.seek(500);
  assert.equal(f.roon.seekCalls.length, 0); assert.equal(f.controller.hasDisplayReadPriorityBlocker(), true);
  await seek; assert.equal(f.controller.hasDisplayReadPriorityBlocker(), false);
  const externalSeek = f.controller.seekRoonTransport(750);
  assert.equal(f.controller.hasDisplayReadPriorityBlocker(), true); await externalSeek; assert.equal(f.controller.hasDisplayReadPriorityBlocker(), false);
  const resume = f.controller.resume();
  assert.equal(f.roon.resumeCalls, 0); assert.equal(f.controller.hasDisplayReadPriorityBlocker(), true);
  await resume; assert.equal(f.controller.hasDisplayReadPriorityBlocker(), false);
  f.roon.shouldFailOnStop = true;
  const failedStop = f.controller.stop();
  assert.equal(f.roon.stopCalls, 0); assert.equal(f.controller.hasDisplayReadPriorityBlocker(), true);
  await assert.rejects(failedStop, /Roon stop failed/u);
  f.roon.state = { ...f.roon.state, transportState: 'playing' };
  assert.equal(f.controller.hasDisplayReadPriorityBlocker(), true); assert.equal(f.controller.hasPlaybackOwnership(), true);
  f.roon.shouldFailOnStop = false; await f.controller.stop(); assert.equal(f.controller.hasDisplayReadPriorityBlocker(), false);
  for (const operation of [() => f.controller.stop(), () => f.controller.clearQueue(), () => f.controller.stopRoonTransport()]) {
    const before = notifications.length, work = operation();
    assert.equal(f.controller.hasDisplayReadPriorityBlocker(), true); assert.ok(notifications.length > before); assert.equal(notifications.at(-1), true);
    await work; assert.equal(f.controller.hasDisplayReadPriorityBlocker(), false);
  }
  const closing = f.controller.shutdown(); assert.equal(f.controller.hasDisplayReadPriorityBlocker(), true); assert.equal(notifications.at(-1), true);
  await closing; assert.equal(f.controller.hasDisplayReadPriorityBlocker(), true);
});

test('封面显示关键期：原SDK完成前确认不放行，旧完成不能清除新seek标记', async t => {
  const cleanup: Array<() => unknown> = []; displayReadTestCleanup(t, cleanup);
  for (const outcome of ['resolve', 'reject'] as const) {
    const f = makeHarness(), completion = mbpDeferred<void>(), seekEntered = mbpDeferred<void>(), seekRelease = mbpDeferred<void>();
    cleanup.push(() => completion.resolve(), () => seekRelease.resolve());
    const originalPlay = f.nativeRoon.play.bind(f.nativeRoon), originalSeek = f.nativeRoon.seek.bind(f.nativeRoon);
    const play = t.mock.method(f.nativeRoon, 'play', (reference: string, zoneId: string, track?: unknown, options?: {
      onDispatch?: () => void; onDispatchCompletion?: (completion: Promise<void>) => void;
    }) => { options?.onDispatchCompletion?.(completion.promise); return originalPlay(reference, zoneId, track, options); });
    const seek = t.mock.method(f.nativeRoon, 'seek', async (position: number) => { seekEntered.resolve(); await seekRelease.promise; await originalSeek(position); });
    cleanup.push(() => play.mock.restore(), () => seek.mock.restore(), () => f.controller.shutdown(), () => f.gateway.stop());
    await f.controller.playRoon(mbrNativeQueue(1)[0]!);
    assert.equal(f.controller.getPlaybackState().state, 'playing'); assert.equal(f.controller.hasPlaybackOwnership(), true);
    assert.equal(f.controller.hasDisplayReadPriorityBlocker(), true);
    const seeking = f.controller.seek(1200); assert.equal(f.controller.hasDisplayReadPriorityBlocker(), true);
    if (outcome === 'resolve') completion.resolve(); else completion.reject(new Error('合成原SDK回执拒绝'));
    await seekEntered.promise;
    assert.equal(f.controller.hasDisplayReadPriorityBlocker(), true, '旧写入已结算，新seek实际未退出仍须阻断');
    seekRelease.resolve(); await seeking;
    assert.equal(f.controller.hasDisplayReadPriorityBlocker(), false); assert.equal(f.nativeRoon.playCalls.length, 1);
  }
});

test('封面显示关键期：未注册SDK完成的原成功和原throw均释放自有标记', async t => {
  const f = makeHarness(), failure = new BridgeError('ROON_TIMEOUT', '合成未注册回执的原异常');
  const cleanup: Array<() => unknown> = []; displayReadTestCleanup(t, cleanup);
  cleanup.push(() => f.controller.shutdown(), () => f.gateway.stop());
  await f.controller.playRoon(mbrNativeQueue(1)[0]!);
  assert.equal(f.controller.hasDisplayReadPriorityBlocker(), false);
  await f.controller.stop();
  const play = t.mock.method(f.nativeRoon, 'play', () => { throw failure; });
  cleanup.unshift(() => play.mock.restore());
  await assert.rejects(f.controller.playRoon(mbrNativeQueue(1)[0]!), error => error === failure);
  await f.controller.stop();
  assert.equal(f.controller.hasPlaybackOwnership(), false); assert.equal(f.controller.hasDisplayReadPriorityBlocker(), false);
});

test('封面显示关键期：无ownership停止拒绝保未确认，外部稳态不能放行', async t => {
  const f = makeHarness(), failure = new BridgeError('ROON_TIMEOUT', '合成外部停止未确认');
  let fail = true;
  const stop = t.mock.method(f.nativeRoon, 'stop', async () => { if (fail) throw failure; });
  displayReadTestCleanup(t, [() => { fail = false; }, () => stop.mock.restore(), () => f.controller.shutdown(), () => f.gateway.stop()]);
  f.roon.state = { ...f.roon.state, transportState: 'playing' };
  assert.equal(f.controller.hasPlaybackOwnership(), false); assert.equal(f.controller.hasDisplayReadPriorityBlocker(), false);
  const work = f.controller.stopRoonTransport(); assert.equal(f.controller.hasDisplayReadPriorityBlocker(), true);
  await assert.rejects(work, error => error === failure);
  assert.equal(f.controller.hasPlaybackOwnership(), false); assert.equal(f.controller.hasDisplayReadPriorityBlocker(), true);
  f.roon.state = { ...f.roon.state, transportState: 'paused' };
  assert.equal(f.controller.hasDisplayReadPriorityBlocker(), true);
  fail = false; await f.controller.stopRoonTransport();
  assert.equal(f.controller.hasPlaybackOwnership(), false); assert.equal(f.controller.hasDisplayReadPriorityBlocker(), false);
});

type SyntheticPlaybackRequestOptions = {
  signal?: AbortSignal;
  priority?: 'playback' | 'background';
  timeoutMs?: number;
};

for (const length of [9, 20]) {
  test(`请求预算保护：${length}项冷队列先派发当前曲且每代补全最多2并发`, { timeout: 3000 }, async t => {
    const f = makeHarness(), gate = mbpDeferred<void>();
    const original = f.netease.getTrack.bind(f.netease);
    const currentId = '99300';
    const calls: { id: string; priority?: string }[] = [];
    const backgroundBySignal = new Map<AbortSignal | undefined, number>();
    let outstanding = 0, background = 0, maximumBackground = 0, maximumGeneration = 0;
    t.mock.method(f.netease, 'getTrack', async (id: string, options?: SyntheticPlaybackRequestOptions) => {
      calls.push({ id, ...(options?.priority ? { priority: options.priority } : {}) });
      if (outstanding >= 8) throw new BridgeError('NETEASE_REQUEST_FAILED', '合成物理请求预算已满');
      outstanding++;
      if (id !== currentId) {
        background++; maximumBackground = Math.max(maximumBackground, background);
        const active = (backgroundBySignal.get(options?.signal) ?? 0) + 1;
        backgroundBySignal.set(options?.signal, active);
        maximumGeneration = Math.max(maximumGeneration, active);
      }
      try {
        if (id !== currentId) await gate.promise;
        return await original(id);
      } finally {
        outstanding--;
        if (id !== currentId) {
          background--;
          backgroundBySignal.set(options?.signal, (backgroundBySignal.get(options?.signal) ?? 1) - 1);
        }
      }
    });
    try {
      await f.controller.replaceQueue(Array.from({ length }, (_, index) => ({ trackId: String(99300 + index) })));
      assert.equal(f.controller.getPlaybackState().state, 'playing');
      assert.equal(calls[0]?.id, currentId, '后台补全不得先占用当前曲请求预算');
      assert.equal(calls[0]?.priority, 'playback');
      assert.ok(maximumGeneration <= 2, `同一补全取消域的请求峰值为${maximumGeneration}`);
      // 此 Fake 不模拟 Client 全局调度；另一个取消域是紧邻下一首预准备。
      assert.ok(maximumBackground <= 3, `补全与单份预准备的请求峰值为${maximumBackground}`);
      assert.equal(backgroundBySignal.has(undefined), false, '背景请求必须绑定可撤销的生命周期');
      assert.ok(calls.filter(call => call.id !== currentId).every(call => call.priority === 'background'));
    } finally { gate.resolve(); await f.controller.stop(); }
  });
}

test('请求预算保护：换队列立即撤销旧补全，迟到响应不派发41项队列后继请求', { timeout: 3000 }, async t => {
  const f = makeHarness(), gate = mbpDeferred<void>();
  const original = f.netease.getTrack.bind(f.netease);
  const calls: string[] = [], signals: AbortSignal[] = [];
  t.mock.method(f.netease, 'getTrack', async (id: string, options?: SyntheticPlaybackRequestOptions) => {
    calls.push(id);
    if (id !== '99400' && id !== '99500') {
      if (options?.signal) signals.push(options.signal);
      await gate.promise;
    }
    return original(id);
  });
  try {
    await f.controller.replaceQueue(Array.from({ length: 41 }, (_, index) => ({ trackId: String(99400 + index) })));
    const oldCalls = calls.filter(id => id !== '99400');
    await f.controller.replaceQueue([{ trackId: '99500' }]);
    assert.ok(signals.length > 0, '补全请求必须获得独立取消信号');
    assert.ok(signals.every(signal => signal.aborted), '新意图受理时撤销旧补全');
    gate.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls.filter(id => id !== '99400' && id !== '99500'), oldCalls);
    assert.equal(f.controller.getPlaybackState().currentTrack?.id, '99500');
  } finally { gate.resolve(); await f.controller.stop(); }
});

for (const stage of ['metadata', 'url', 'preflight'] as const) {
  test(`请求预算保护：切歌把${stage}实际请求的Owner信号撤销`, { timeout: 3000 }, async t => {
    const f = makeHarness(), gate = mbpDeferred<void>(), entered = mbpDeferred<void>();
    const originalTrack = f.netease.getTrack.bind(f.netease), originalStream = f.netease.resolveStream.bind(f.netease), originalPreflight = f.gateway.preflight.bind(f.gateway);
    let signal: AbortSignal | undefined, priority: string | undefined;
    if (stage === 'metadata') t.mock.method(f.netease, 'getTrack', async (id: string, options?: SyntheticPlaybackRequestOptions) => {
      if (id === '99600') { signal = options?.signal; priority = options?.priority; entered.resolve(); await gate.promise; }
      return originalTrack(id);
    });
    if (stage === 'url') t.mock.method(f.netease, 'resolveStream', async (id: string, quality: QualityLevel, options?: SyntheticPlaybackRequestOptions) => {
      if (id === '99600') { signal = options?.signal; priority = options?.priority; entered.resolve(); await gate.promise; }
      return originalStream(id, quality);
    });
    if (stage === 'preflight') t.mock.method(f.gateway, 'preflight', async (stream: ResolvedAudioStream, ownerSignal?: AbortSignal) => {
      if (stream.trackId === '99600') { signal = ownerSignal; entered.resolve(); await gate.promise; }
      return originalPreflight(stream);
    });
    const old = f.controller.replaceQueue([{ trackId: '99600' }]).catch(error => error);
    let latest: Promise<unknown> | undefined;
    try {
      await entered.promise;
      latest = f.controller.replaceQueue([{ trackId: '99601' }]).catch(error => error);
      assert.ok(signal, '生产请求必须接收Owner取消信号');
      assert.equal(signal.aborted, true);
      if (stage !== 'preflight') assert.equal(priority, 'playback');
      await latest;
      assert.equal((await old).details?.reason, 'operation_cancelled');
      assert.deepEqual(f.roon.playRequests.map(request => request.metadata.id), ['99601']);
    } finally { gate.resolve(); await Promise.all([old, latest]); await f.controller.stop(); }
  });
}

test('请求预算保护：下一首预准备使用背景信号，换队列后不预检旧结果', { timeout: 3000 }, async t => {
  const f = makeHarness(), gate = mbpDeferred<void>(), entered = mbpDeferred<void>();
  const originalStream = f.netease.resolveStream.bind(f.netease), originalPreflight = f.gateway.preflight.bind(f.gateway);
  let signal: AbortSignal | undefined, priority: string | undefined;
  const preflightIds: string[] = [];
  t.mock.method(f.netease, 'resolveStream', async (id: string, quality: QualityLevel, options?: SyntheticPlaybackRequestOptions) => {
    if (id === '99701') { signal = options?.signal; priority = options?.priority; entered.resolve(); await gate.promise; }
    return originalStream(id, quality);
  });
  t.mock.method(f.gateway, 'preflight', async (stream: ResolvedAudioStream) => { preflightIds.push(stream.trackId); return originalPreflight(stream); });
  try {
    await f.controller.replaceQueue([{ trackId: '99700' }, { trackId: '99701' }]);
    await entered.promise;
    await f.controller.replaceQueue([{ trackId: '99700' }, { trackId: '99702' }]);
    assert.equal(priority, 'background');
    assert.ok(signal?.aborted);
    gate.resolve();
    await waitFor(() => preflightIds.includes('99702'));
    assert.equal(preflightIds.includes('99701'), false, '过期预准备不得继续派发HTTP预检');
    await f.controller.next();
    assert.equal(f.controller.getPlaybackState().currentTrack?.id, '99702');
  } finally { gate.resolve(); await f.controller.stop(); }
});

test('请求预算保护：Next接管未完成预准备后，更新播放意图仍撤销该请求', { timeout: 3000 }, async t => {
  const f = makeHarness(), gate = mbpDeferred<void>(), entered = mbpDeferred<void>();
  const original = f.netease.resolveStream.bind(f.netease);
  let preparationSignal: AbortSignal | undefined;
  t.mock.method(f.netease, 'resolveStream', async (id: string, quality: QualityLevel, options?: SyntheticPlaybackRequestOptions) => {
    if (id === '99801') { preparationSignal = options?.signal; entered.resolve(); await gate.promise; }
    return original(id, quality);
  });
  let advancing: Promise<unknown> | undefined;
  try {
    await f.controller.replaceQueue([{ trackId: '99800' }, { trackId: '99801' }]);
    await entered.promise;
    advancing = f.controller.next().catch(error => error);
    await waitFor(() => f.controller.getPlaybackState().queue.index === 1);
    assert.ok(preparationSignal && !preparationSignal.aborted, 'Next保留匹配的未完成预准备');
    await f.controller.replaceQueue([{ trackId: '99802' }]);
    assert.equal(preparationSignal.aborted, true, '接管后的新Owner仍能撤销预准备物理请求');
    assert.equal((await advancing as BridgeError).details?.reason, 'operation_cancelled');
    assert.deepEqual(f.roon.playRequests.map(request => request.metadata.id), ['99800', '99802']);
  } finally { gate.resolve(); await advancing; await f.controller.stop(); }
});

test('快速歌单切换：同turn受理A/B/C只派发最后C', async () => {
  const f = makeHarness();
  const a = f.controller.replaceQueue([{ trackId: '99201' }]).catch(error => error);
  const b = f.controller.replaceQueue([{ trackId: '99202' }]).catch(error => error);
  const c = f.controller.replaceQueue([{ trackId: '99203' }]);
  try {
    await c;
    assert.equal((await a).details?.reason, 'operation_cancelled');
    assert.equal((await b).details?.reason, 'operation_cancelled');
    assert.deepEqual(f.roon.playRequests.map(request => request.metadata.id), ['99203']);
    assert.equal(f.controller.getPlaybackState().currentTrack?.id, '99203');
    assert.equal(f.registry.size, 1);
  } finally { await f.controller.stop(); }
});

test('快速歌单切换：A准备时受理B/C，未开始的B不得阻塞C', { timeout: 3000 }, async t => {
  const f = makeHarness(), entered = mbpDeferred<void>(), oldGate = mbpDeferred<void>(), middleGate = mbpDeferred<void>();
  const original = f.netease.getTrack.bind(f.netease);
  const metadataCalls: string[] = [];
  t.mock.method(f.netease, 'getTrack', async (id: string) => {
    metadataCalls.push(id);
    if (id === '99211') { entered.resolve(); await oldGate.promise; }
    if (id === '99212') await middleGate.promise;
    return original(id);
  });
  const a = f.controller.replaceQueue([{ trackId: '99211' }]).catch(error => error);
  await entered.promise;
  const b = f.controller.replaceQueue([{ trackId: '99212' }]).catch(error => error);
  let latestSettled = false;
  const c = f.controller.replaceQueue([{ trackId: '99213' }]).then(() => { latestSettled = true; }).catch(error => error);
  try {
    await waitFor(() => latestSettled, 500);
    assert.equal(metadataCalls.includes('99212'), false);
    assert.equal((await a).details?.reason, 'operation_cancelled');
    assert.equal((await b).details?.reason, 'operation_cancelled');
    assert.deepEqual(f.roon.playRequests.map(request => request.metadata.id), ['99213']);
    assert.equal(f.controller.getPlaybackState().currentTrack?.id, '99213');
  } finally {
    oldGate.resolve(); middleGate.resolve();
    await Promise.all([a, b, c]); await f.controller.stop();
  }
});

test('快速歌单切换：B等待旧Stop时C取代B，真实关闭后只派发C', { timeout: 3000 }, async t => {
  const f = makeHarness(), entered = mbpDeferred<void>(), gate = mbpDeferred<void>();
  await f.controller.play({ trackId: '99221' });
  const original = f.roon.stop.bind(f.roon);
  t.mock.method(f.roon, 'stop', async () => { entered.resolve(); await gate.promise; return original(); });
  const b = f.controller.replaceQueue([{ trackId: '99222' }]).catch(error => error);
  await entered.promise;
  const c = f.controller.replaceQueue([{ trackId: '99223' }]);
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.roon.playRequests.map(request => request.metadata.id), ['99221']);
    gate.resolve(); await c;
    assert.equal((await b).details?.reason, 'operation_cancelled');
    assert.deepEqual(f.roon.playRequests.map(request => request.metadata.id), ['99221', '99223']);
    assert.equal(f.roon.stopCalls, 1);
  } finally { gate.resolve(); await Promise.all([b, c]); await f.controller.stop(); }
});

test('快速歌单切换：原生Stop失败仍保留所有权，最后C不得越过未知停止', async t => {
  const f = makeHarness(), entered = mbpDeferred<void>(), gate = mbpDeferred<void>();
  await f.controller.playRoon(mbrNativeQueue(1)[0]!);
  const original = f.nativeRoon.stop.bind(f.nativeRoon);
  let failStop = true;
  const stop = t.mock.method(f.nativeRoon, 'stop', async () => {
    entered.resolve(); await gate.promise;
    if (failStop) throw new BridgeError('ROON_TIMEOUT', '合成原生停止未知', { httpStatus: 504 });
    return original();
  });
  const b = f.controller.replaceQueue([{ trackId: '99232' }]).catch(error => error);
  await entered.promise;
  const c = f.controller.replaceQueue([{ trackId: '99233' }]).catch(error => error);
  try {
    gate.resolve();
    assert.equal((await b).code, 'ROON_TIMEOUT');
    assert.equal((await c).code, 'ROON_TRANSPORT_UNAVAILABLE');
    assert.equal(f.controller.hasPlaybackOwnership(), true);
    assert.equal(f.controller.getPlaybackState().canStop, true);
    assert.equal(f.nativeRoon.active, true);
    assert.equal(f.roon.playRequests.length, 0);
    assert.equal(f.registry.size, 0);
    const blockedStopCalls = stop.mock.calls.length;
    const blockedNativePlays = f.nativeRoon.playCalls.length;
    const blockedProviderPlays = f.roon.playRequests.length;
    await assert.rejects(f.controller.replaceQueue([{ trackId: '99234' }]), { code: 'ROON_TRANSPORT_UNAVAILABLE' });
    await assert.rejects(f.controller.play({ trackId: '99235' }), { code: 'ROON_TRANSPORT_UNAVAILABLE' });
    await assert.rejects(f.controller.playRoon(mbrNativeQueue(2)[1]!), { code: 'ROON_TRANSPORT_UNAVAILABLE' });
    assert.equal(stop.mock.calls.length, blockedStopCalls, '停止结果未知时两种来源都不得盲重发Stop');
    assert.equal(f.nativeRoon.playCalls.length, blockedNativePlays, '原生Roon点播不得越过共享停止保护');
    assert.equal(f.roon.playRequests.length, blockedProviderPlays, '网易云点播不得越过共享停止保护');
    assert.equal(f.registry.size, 0, '未知停止期间不得创建新媒体流');
    failStop = false; await f.controller.stop();
    assert.equal(f.nativeRoon.active, false);
    assert.equal(f.controller.hasPlaybackOwnership(), false);
    await f.controller.replaceQueue([{ trackId: '99234' }]);
    assert.equal(f.controller.getPlaybackState().currentTrack?.id, '99234');
  } finally { gate.resolve(); failStop = false; await Promise.all([b, c]); await f.controller.stop(); }
});

for (const source of ['provider', 'native'] as const) {
  test(`MBP003A：${source}已确认播放成功停止，最后发布快照不保留已结束的Stop所有权`, async () => {
    const f = makeHarness();
    const snapshots: PlaybackSnapshot[] = [];
    const unsubscribe = f.controller.subscribe(snapshot => snapshots.push(snapshot));
    try {
      if (source === 'provider') await f.controller.play({ trackId: '99101' });
      else await f.controller.playRoon(mbrNativeQueue(1)[0]!);
      assert.equal(snapshots.at(-1)?.canStop, true);
      await f.controller.stop();
      assert.equal(f.controller.hasPlaybackOwnership(), false);
      assert.equal(f.controller.getPlaybackState().canStop, false);
      assert.equal(snapshots.at(-1)?.state, 'idle');
      assert.equal(snapshots.at(-1)?.canStop, false, '已结束的Stop必须同步发布能力释放');
    } finally {
      unsubscribe();
      await f.controller.stop();
    }
  });
}

test('MBP003A：取消准备后最后意图结算，发布的停止能力与已释放所有权一致', async t => {
  const f = makeHarness(), gate = mbpDeferred<void>(), entered = mbpDeferred<void>();
  const original = f.netease.getTrack.bind(f.netease);
  t.mock.method(f.netease, 'getTrack', async (id: string) => {
    entered.resolve(); await gate.promise; return original(id);
  });
  const snapshots: PlaybackSnapshot[] = [];
  const unsubscribe = f.controller.subscribe(snapshot => snapshots.push(snapshot));
  const playing = f.controller.play({ trackId: '99100' }).catch(error => error);
  try {
    await entered.promise;
    assert.equal(snapshots.at(-1)?.canStop, true);
    await f.controller.stop();
    await playing;
    assert.equal(f.controller.hasPlaybackOwnership(), false);
    assert.equal(f.controller.getPlaybackState().canStop, false);
    assert.equal(snapshots.at(-1)?.state, 'idle');
    assert.equal(snapshots.at(-1)?.canStop, false, '已发布快照不得留存过期的停止能力');
    assert.equal(f.roon.playRequests.length, 0);
    assert.equal(f.registry.size, 0);
  } finally { gate.resolve(); unsubscribe(); await playing; }
});

for (const stage of ['metadata', 'url', 'preflight'] as const) {
  test(`MBP003A：${stage}准备未决时Stop先完成，迟到结果零播放/零token`, { timeout: 3000 }, async t => {
    const f = makeHarness(), gate = mbpDeferred<void>(), entered = mbpDeferred<void>();
    const originalTrack = f.netease.getTrack.bind(f.netease), originalStream = f.netease.resolveStream.bind(f.netease), originalPreflight = f.gateway.preflight.bind(f.gateway);
    if (stage === 'metadata') t.mock.method(f.netease, 'getTrack', async (id: string) => { entered.resolve(); await gate.promise; return originalTrack(id); });
    if (stage === 'url') t.mock.method(f.netease, 'resolveStream', async (id: string, quality: QualityLevel) => { entered.resolve(); await gate.promise; return originalStream(id, quality); });
    if (stage === 'preflight') t.mock.method(f.gateway, 'preflight', async (...args: Parameters<typeof f.gateway.preflight>) => { entered.resolve(); await gate.promise; return originalPreflight(...args); });
    const playing = f.controller.play({ trackId: '99001', quality: 'standard' }).catch(error => error);
    await entered.promise;
    let stopped = false;
    const stopping = f.controller.stop().then(() => { stopped = true; });
    try {
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(stopped, true, 'Stop不能等待准备Promise');
      assert.equal(f.roon.playRequests.length, 0); assert.equal(f.registry.size, 0);
    } finally { gate.resolve(); await playing; await stopping; }
    assert.equal(f.roon.playRequests.length, 0); assert.equal(f.registry.size, 0);
    assert.equal(f.controller.getPlaybackState().state, 'idle');
  });
}

test('MBP003A：小批队列元数据未决仍接受插入并响应Stop，顺序不变', { timeout: 3000 }, async t => {
  const f = makeHarness(), gate = mbpDeferred<void>(), entered = mbpDeferred<void>();
  await f.controller.play({ trackId: '99010', quality: 'standard' });
  const original = f.netease.getTrack.bind(f.netease);
  t.mock.method(f.netease, 'getTrack', async (id: string) => { if (id !== '99010') { entered.resolve(); await gate.promise; } return original(id); });
  const inserting = f.controller.insertNext([{ trackId: '99011', quality: 'standard' }]);
  await entered.promise;
  let stopped = false; const stopping = f.controller.stop().then(() => { stopped = true; });
  try { await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(stopped, true); }
  finally { gate.resolve(); await inserting; await stopping; }
  assert.deepEqual(f.controller.getPlaybackState().queue.items.map(item => item.trackId), ['99010', '99011']);
});

test('MBP003A：同turn已受理播放也具有ownership，Stop取消未启动意图', async () => {
  const f = makeHarness();
  const playing = f.controller.play({ trackId: '99020' }).catch(error => error);
  assert.equal(f.controller.hasPlaybackOwnership(), true);
  await f.controller.stop();
  await playing;
  assert.equal(f.roon.playRequests.length, 0);
  assert.equal(f.registry.size, 0);
  assert.equal(f.controller.hasPlaybackOwnership(), false);
});

test('MBP003A：Smart查找取消后不派发Native、不fallback Provider', { timeout: 3000 }, async () => {
  const gate = mbpDeferred<{ reference: string; zoneId: string }>(), entered = mbpDeferred<void>();
  const f = makeHarness(206, async () => { entered.resolve(); return gate.promise; });
  const playing = f.controller.replaceQueue([{ trackId: '99021', preferredSource: 'smart' }]).catch(error => error);
  await entered.promise;
  await f.controller.stop();
  gate.resolve({ reference: 'private-synthetic', zoneId: 'zone-1' });
  const error = await playing;
  assert.equal(error.details?.reason, 'operation_cancelled');
  assert.equal(f.nativeRoon.playCalls.length, 0);
  assert.equal(f.netease.resolveCalls, 0);
  assert.equal(f.registry.size, 0);
});

for (const control of ['pause', 'stop', 'external-seek'] as const) {
  test(`MBP003A：Native先确认但SDK回执未结时${control}不得越过真实写入`, { timeout: 3000 }, async t => {
    const f = makeHarness(), completion = mbpDeferred<void>();
    t.mock.method(f.nativeRoon, 'play', async (_reference: string, zoneId: string, _track: unknown, options?: {
      onDispatch?: () => void; onDispatchCompletion?: (completion: Promise<void>) => void;
    }) => {
      options?.onDispatch?.(); options?.onDispatchCompletion?.(completion.promise);
      return { revision: 1, zoneId, state: 'playing' as const };
    });
    await f.controller.playRoon(mbrNativeQueue(1)[0]!);
    f.roon.state = { ...f.roon.state, transportState: 'playing', canPause: true };
    let settled = false;
    const controlling = (control === 'pause' ? f.controller.pause() : control === 'stop' ? f.controller.stop() : f.controller.seekRoonTransport(1234)).then(() => { settled = true; });
    try {
      await new Promise(resolve => setTimeout(resolve, 15));
      assert.equal(settled, false);
      assert.equal(f.nativeRoon.pauseCalls + f.nativeRoon.stopCalls + f.roon.seekCalls.length, 0);
    } finally { completion.resolve(); await controlling; }
    assert.equal(settled, true);
    await f.controller.stop();
  });
}

test('MBP003A：Native已dispatch确认取消后Stop未知保留ownership，新Play禁止越过', { timeout: 3000 }, async t => {
  const f = makeHarness(), entered = mbpDeferred<void>();
  t.mock.method(f.nativeRoon, 'play', async (_ref: string, _zone: string, _track: unknown, options?: { signal?: AbortSignal; onDispatch?: () => void }) => {
    options?.onDispatch?.(); entered.resolve();
    await new Promise<void>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new BridgeError('BAD_REQUEST', '合成取消', { httpStatus: 409, details: { reason: 'operation_cancelled' } })), { once: true }));
    return { revision: 1, zoneId: 'zone-1', state: 'playing' as const };
  });
  const starting = f.controller.playRoon(mbrNativeQueue(1)[0]!).catch(error => error);
  await entered.promise;
  let failures = 2;
  t.mock.method(f.nativeRoon, 'stop', async (options?: { signal?: AbortSignal; expectedZoneId?: string }) => {
    assert.equal(options?.signal, undefined); assert.equal(options?.expectedZoneId, 'zone-1');
    f.nativeRoon.stopCalls++;
    if (failures-- > 0) throw new BridgeError('ROON_TIMEOUT', '合成未知停止', { httpStatus: 504 });
  });
  await assert.rejects(f.controller.stop()); await starting;
  assert.equal(f.controller.hasPlaybackOwnership(), true);
  await assert.rejects(f.controller.play({ trackId: '99022' }));
  assert.equal(f.nativeRoon.stopCalls, 1); assert.equal(f.roon.playRequests.length, 0);
  await assert.rejects(f.controller.stop());
  assert.equal(f.controller.hasPlaybackOwnership(), true);
  await f.controller.stop();
  assert.equal(f.controller.hasPlaybackOwnership(), false);
});

test('MBP003A：Native SDK已结算而Transport确认未决，外部seek不等待确认', { timeout: 3000 }, async t => {
  const f = makeHarness(), entered = mbpDeferred<void>(), completion = mbpDeferred<void>();
  t.mock.method(f.nativeRoon, 'play', async (_reference: string, zoneId: string, _track: unknown, options?: {
    signal?: AbortSignal; onDispatch?: () => void; onDispatchCompletion?: (completion: Promise<void>) => void;
  }) => {
    options?.onDispatch?.(); options?.onDispatchCompletion?.(completion.promise); entered.resolve();
    await new Promise<void>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new BridgeError('BAD_REQUEST', '合成取消', { httpStatus: 409, details: { reason: 'operation_cancelled' } })), { once: true }));
    return { revision: 1, zoneId, state: 'playing' as const };
  });
  const starting = f.controller.playRoon(mbrNativeQueue(1)[0]!).catch(error => error);
  await entered.promise;
  const seeking = f.controller.seekRoonTransport(2345);
  completion.resolve();
  await seeking;
  assert.deepEqual(f.roon.seekCalls, [2345]);
  assert.equal(f.controller.hasPlaybackOwnership(), true);
  await f.controller.stop(); await starting;
});

test('MBP003A：旧metadata准备被新Play取代，迟到reject不覆写新曲或撤销新token', { timeout: 3000 }, async t => {
  const f = makeHarness(), gate = mbpDeferred<never>(), entered = mbpDeferred<void>();
  const original = f.netease.getTrack.bind(f.netease);
  t.mock.method(f.netease, 'getTrack', async (id: string) => {
    if (id === '99030') { entered.resolve(); return gate.promise; }
    return original(id);
  });
  const old = f.controller.play({ trackId: '99030' }).catch(error => error);
  await entered.promise;
  await f.controller.play({ trackId: '99031' });
  assert.equal((await old).details?.reason, 'operation_cancelled');
  gate.reject(new Error('合成迟到元数据错误'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.controller.getPlaybackState().currentTrack?.id, '99031');
  assert.equal(f.controller.getPlaybackState().state, 'playing');
  assert.equal(f.registry.size, 1);
  assert.deepEqual(f.roon.playRequests.map(request => request.metadata.id), ['99031']);
  await f.controller.stop();
});

test('MBP003A：连续pause/resume按设备确认顺序执行，resume不在pausing期间误拒绝', { timeout: 3000 }, async () => {
  const f = makeHarness();
  await f.controller.play({ trackId: '99032' });
  f.roon.autoConfirmPause = false;
  const pausing = f.controller.pause();
  const resuming = f.controller.resume();
  await waitFor(() => f.roon.pauseCalls === 1);
  assert.equal(f.roon.resumeCalls, 0);
  f.roon.confirmPause();
  await Promise.all([pausing, resuming]);
  assert.equal(f.roon.resumeCalls, 1);
  assert.equal(f.controller.getPlaybackState().state, 'playing');
  await f.controller.stop();
});

for (const source of ['provider', 'native'] as const) {
  test(`MBP003A：${source}合法Port未提供onDispatch钩子，确认活动后仍必须真实Stop`, async t => {
    const f = makeHarness();
    if (source === 'provider') {
      const play = f.roon.play.bind(f.roon);
      t.mock.method(f.roon, 'play', async (request: RoonPlayRequest) => {
        const { onDispatch: _ignored, ...withoutHook } = request;
        await play(withoutHook);
      });
      await f.controller.play({ trackId: '99033' });
    } else {
      t.mock.method(f.nativeRoon, 'play', async (_reference: string, zoneId: string) => ({ revision: 1, zoneId, state: 'playing' as const }));
      await f.controller.playRoon(mbrNativeQueue(1)[0]!);
    }
    await f.controller.stop();
    assert.equal(source === 'provider' ? f.roon.stopCalls : f.nativeRoon.stopCalls, 1);
    assert.equal(f.controller.hasPlaybackOwnership(), false);
  });
}

test('MBP003A：无MB owner的外部Stop排队期间切Zone，迟到控制仍绑定受理Zone', { timeout: 3000 }, async t => {
  const f = makeHarness(), entered = mbpDeferred<void>(), release = mbpDeferred<void>();
  t.mock.method(f.roon, 'seek', async () => { entered.resolve(); await release.promise; });
  const seeking = f.controller.seekRoonTransport(3456);
  await entered.promise;
  let expectedZone: string | undefined;
  t.mock.method(f.nativeRoon, 'stop', async (options?: { expectedZoneId?: string; signal?: AbortSignal }) => {
    assert.equal(options?.signal, undefined);
    expectedZone = options?.expectedZoneId;
    if (options?.expectedZoneId !== f.roon.state.selectedZoneId) throw new BridgeError('BAD_REQUEST', '合成Zone已变化', { httpStatus: 409 });
    f.nativeRoon.stopCalls++;
  });
  const stopped = assert.rejects(f.controller.stopRoonTransport());
  f.roon.state = { ...f.roon.state, selectedZoneId: 'zone-2' };
  release.resolve();
  await seeking; await stopped;
  assert.equal(expectedZone, 'zone-1');
  assert.equal(f.nativeRoon.stopCalls, 0);
});


test('MBP006：Controller只读稳定出口与kind保留，前进seek不能标为position', async t => {
  let clock = 1_700_000_000_000;
  const { controller, roon } = makeHarness(206, undefined, () => clock);
  t.after(() => controller.stop());
  const kinds: string[] = [];
  const remove = controller.subscribe((_snapshot, metadata) => kinds.push(metadata?.kind ?? 'missing'));
  t.after(remove);
  assert.equal(kinds[0], 'full');
  await controller.play({ trackId: '90101', quality: 'standard' });
  const before = controller.getPlaybackPublication();
  assert.equal(controller.getPlaybackPublication().queue, before.queue);
  assert.equal(Object.isFrozen(before.queue.items), true);
  clock += 250;
  controller.updateRoonTime(1000);
  assert.equal(kinds.at(-1), 'position');
  t.mock.method(roon, 'seek', async () => { clock += 250; controller.updateRoonTime(5000); });
  await controller.seek(5000);
  assert.deepEqual(kinds.slice(-2), ['position', 'full']);
  assert.equal(controller.getPlaybackPublication().queue, before.queue);
});


for (const reason of ['failed', 'cancelled'] as const) {
  test(`MBP006：${reason} seek不会补发成功full`, async t => {
    const { controller, roon } = makeHarness();
    t.after(() => controller.stop());
    await controller.play({ trackId: '90101', quality: 'standard' });
    const fullPlaying: PlaybackSnapshot[] = [];
    const remove = controller.subscribe((snapshot, metadata) => {
      if (metadata?.kind === 'full' && snapshot.state === 'playing') fullPlaying.push(snapshot);
    });
    t.after(remove);
    const entered = mbpDeferred<void>(), release = mbpDeferred<void>();
    t.mock.method(roon, 'seek', async () => {
      entered.resolve(); await release.promise;
      if (reason === 'failed') throw new BridgeError('ROON_TIMEOUT', '合成seek失败');
    });
    const before = fullPlaying.length;
    const seeking = assert.rejects(controller.seek(5000));
    await entered.promise;
    const stopping = reason === 'cancelled' ? controller.stop() : undefined;
    release.resolve();
    await seeking;
    await stopping;
    assert.equal(fullPlaying.length, before);
  });
}
