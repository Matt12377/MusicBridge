import assert from 'node:assert/strict';
import test from 'node:test';
import type { PublicBridgeState, TrackSummary, TypedIpcEvent, PlaybackEventProtocol } from '@music-bridge/contracts';
import { createBridgeRuntime, createTestBridgeRuntime, toPublicBridgeState } from '../src/runtime.js';
import { NeteaseClient } from '../src/netease/client.js';
import { RoonAudioInputAdapter } from '../src/roon/adapter.js';
import type { RoonLibraryService } from '../src/roon/library.js';
import type { RoonPlaybackObservation, RoonState } from '../src/roon/types.js';
import { StreamGateway } from '../src/stream/gateway.js';
import { ControlServer } from '../src/control/server.js';
import { createLocalFavoriteRepository } from '../src/favorites/repository.js';
import { BridgeError } from '../src/shared/errors.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function beforeSlowWork<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 300);
    })]);
  } finally { clearTimeout(timer); }
}

/** 真实runtime组合，只替换外部I/O；两个select回调均来自生产构造，不是合成runtime实现。 */
async function priorityRuntime(t: test.TestContext, contextOptions: { enabled?: boolean; disabledFlag?: boolean; size?: number; protocol?: PlaybackEventProtocol } = {}) {
  const protocolEvents: TypedIpcEvent[] = [];
  const events: string[] = [], metadata = deferred<void>(), url = deferred<void>(), confirmation = deferred<void>(), stop = deferred<void>(), nativeResponse = deferred<void>();
  let holdMetadata = false, holdUrl = false, holdConfirmation = false, holdStop = false, holdNativeResponse = false, failStop = false;
  let state: RoonState = { status: 'ready', selectedZoneId: 'zone-A', transportState: 'stopped', canPause: true, canResume: true };
  let revision = 1, metadataEntered = false, urlEntered = false, nativeDispatched = false;
  let controlSelect!: (zoneId: string) => Promise<unknown>;
  let controlSeek!: (positionMs: number) => Promise<{ positionMs: number }>;
  let nativePlay!: (reference: string, zoneId: string, track: TrackSummary, options: {
    signal?: AbortSignal; expectedZoneId?: string; onDispatch?: () => void; onDispatchCompletion?: (completion: Promise<void>) => void;
  }) => Promise<RoonPlaybackObservation>;
  const observation = (): RoonPlaybackObservation => ({ zoneId: state.selectedZoneId!, revision, ...(state.transportState ? { state: state.transportState } : {}) });
  const library = {
    async browseAlbums() { return { items: [{ kind: 'album', title: '合成专辑', itemKey: 'album' }], offset: 0, level: 0, hasMore: false }; },
    async browseAlbum() { return { items: [{ kind: 'track', title: '合成本地曲目', artist: '合成艺人', album: '合成专辑', itemKey: 'track' }], offset: 0, level: 1, hasMore: false }; },
    async playTrack(_track: unknown, zoneId: string, onDispatch?: () => void) {
      onDispatch?.(); nativeDispatched = true; events.push(`native-play:${zoneId}`);
      if (holdNativeResponse) await nativeResponse.promise;
      events.push(`native-response:${zoneId}`);
      return 'accepted';
    },
  } as unknown as RoonLibraryService;
  const contextEpoch = '11111111-1111-4111-8111-111111111111';
  if (contextOptions.enabled) {
    const tracks = Array.from({ length: contextOptions.size ?? 6 }, (_, index) => ({ kind: 'track' as const, title: `合成上下文${index}`, artist: '合成艺人', album: '合成专辑', itemKey: `context-${index}`, durationMs: 60_000 }));
    library.browseAlbum = async (_album, page) => ({ items: tracks.slice(page.offset, page.offset + page.limit), offset: page.offset, level: 1,
      total: tracks.length, hasMore: page.offset + page.limit < tracks.length, sourceEpoch: contextEpoch,
      nextOffset: Math.min(tracks.length, page.offset + page.limit), complete: page.offset + page.limit >= tracks.length });
    library.forkPlaybackContext = (_parent, epoch, zoneId) => {
      assert.equal(epoch, contextEpoch); assert.equal(zoneId, 'zone-A'); events.push('context-acquire');
      let released = false;
      return { isCurrent: () => !released, release: () => { released = true; events.push('context-release'); },
        async read(page, options) {
          assert.equal(options.signal.aborted, false); assert.equal(options.isCurrent(), true);
          events.push(`context-read:${page.offset}`);
          return { items: tracks.slice(page.offset, page.offset + page.limit), offset: page.offset, level: 1,
            total: tracks.length, hasMore: page.offset + page.limit < tracks.length, sourceEpoch: '22222222-2222-4222-8222-222222222222',
            nextOffset: Math.min(tracks.length, page.offset + page.limit), complete: page.offset + page.limit >= tracks.length };
        },
      };
    };
  }
  t.mock.method(NeteaseClient.prototype, 'getTrack', async (id: string) => {
    metadataEntered = true; events.push('metadata'); if (holdMetadata) await metadata.promise;
    return { id, title: '合成云曲目', artists: ['合成艺人'], album: '合成专辑' };
  });
  t.mock.method(NeteaseClient.prototype, 'resolveStream', async (trackId: string, quality: string) => {
    urlEntered = true; events.push('url'); if (holdUrl) await url.promise;
    return { trackId, upstreamUrl: 'https://synthetic.invalid/audio', requestedQuality: quality, actualQuality: 'lossless', expiresInSeconds: 600 };
  });
  t.mock.method(NeteaseClient.prototype, 'getPublicAccountProfile', async () => ({ displayName: '合成账号' }));
  t.mock.method(StreamGateway.prototype, 'start', async () => undefined);
  t.mock.method(StreamGateway.prototype, 'preflight', async () => { events.push('preflight'); });
  t.mock.method(RoonAudioInputAdapter.prototype, 'start', async () => undefined);
  t.mock.method(RoonAudioInputAdapter.prototype, 'getState', () => ({ ...state }));
  t.mock.method(RoonAudioInputAdapter.prototype, 'getLibraryService', () => library);
  t.mock.method(RoonAudioInputAdapter.prototype, 'getSelectedZonePlaybackState', () => state.transportState);
  t.mock.method(RoonAudioInputAdapter.prototype, 'getSelectedZonePlaybackObservation', observation);
  t.mock.method(RoonAudioInputAdapter.prototype, 'selectZone', (zoneId: string) => {
    events.push(`select:${zoneId}`); state = { ...state, selectedZoneId: zoneId }; ++revision;
  });
  t.mock.method(RoonAudioInputAdapter.prototype, 'play', async (request: { onDispatch?: () => void }) => {
    request.onDispatch?.(); events.push(`cloud-play:${state.selectedZoneId}`);
    state = { ...state, status: 'playing', transportState: 'playing' }; ++revision;
  });
  t.mock.method(RoonAudioInputAdapter.prototype, 'stop', async () => {
    events.push(`audio-stop:${state.selectedZoneId}`); if (holdStop) await stop.promise;
    if (failStop) throw new BridgeError('ROON_TIMEOUT', '合成停止未确认');
    state = { ...state, status: 'ready', transportState: 'stopped' }; ++revision;
  });
  t.mock.method(RoonAudioInputAdapter.prototype, 'control', async (command: string, options?: { expectedZoneId?: string; signal?: AbortSignal }) => {
    const owner = options?.expectedZoneId ?? state.selectedZoneId;
    events.push(`control:${command}:${owner}`);
    if (command === 'stop') {
      assert.equal(options?.signal?.aborted ?? false, false, '停止不能复用已取消的准备signal');
      if (holdStop) await stop.promise;
      if (failStop) throw new BridgeError('ROON_TIMEOUT', '合成停止未确认');
      state = { ...state, status: 'ready', transportState: 'stopped' }; ++revision;
    }
  });
  t.mock.method(RoonAudioInputAdapter.prototype, 'waitForSelectedZonePlayback', async (request: { signal?: AbortSignal; state: string }) => {
    if (request.state === 'playing' && holdConfirmation) {
      await new Promise<void>((resolve, reject) => {
        void confirmation.promise.then(resolve);
        if (request.signal?.aborted) reject(new BridgeError('ROON_TIMEOUT', '合成旧确认取消'));
        else request.signal?.addEventListener('abort', () => reject(new BridgeError('ROON_TIMEOUT', '合成旧确认取消')), { once: true });
      });
    }
    if (request.state === 'playing') { state = { ...state, status: 'playing', transportState: 'playing' }; ++revision; }
    return observation();
  });
  t.mock.method(RoonAudioInputAdapter.prototype, 'setVolume', async (request: { zoneId: string; outputId: string; value: number }) => {
    events.push(`volume:${request.zoneId}:${request.value}`);
    return { zoneId: request.zoneId, outputs: [{ outputId: request.outputId, name: '合成输出', type: 'number', min: 0, max: 100, step: 1, value: request.value }] };
  });
  t.mock.method(RoonAudioInputAdapter.prototype, 'seek', async (positionMs: number, options?: { expectedZoneId?: string }) => {
    events.push(`seek:${options?.expectedZoneId ?? state.selectedZoneId}:${positionMs}`);
  });
  t.mock.method(ControlServer.prototype, 'start', async function(this: ControlServer) {
    const options = Reflect.get(this, 'options') as { controller: object; roon: { selectZone(zoneId: string): Promise<unknown>; seekRoonTransport(positionMs: number): Promise<{ positionMs: number }> } };
    controlSelect = options.roon.selectZone;
    controlSeek = options.roon.seekRoonTransport;
    nativePlay = (Reflect.get(options.controller, 'dependencies') as { roonLibrary: { play: typeof nativePlay } }).roonLibrary.play;
  });
  const runtime = createBridgeRuntime({
    ...(contextOptions.protocol ? { playbackEventProtocol: contextOptions.protocol } : {}),
    onEvent: event => protocolEvents.push(event),
    env: { NETEASE_COOKIE: 'synthetic-runtime-only', BRIDGE_CONTROL_HOST: '127.0.0.1', BRIDGE_STREAM_HOST: '127.0.0.1', ...(contextOptions.disabledFlag ? { MUSIC_BRIDGE_INCREMENTAL_ROON_QUEUE: '0' } : {}) },
    favoriteRepository: createLocalFavoriteRepository(),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    roonSdk: { createApi: () => assert.fail('此夹具禁止真实Roon连接') } as never,
  });
  await runtime.start();
  t.after(async () => { metadata.resolve(); url.resolve(); confirmation.resolve(); stop.resolve(); nativeResponse.resolve(); failStop = false; await runtime.shutdown(); });
  return {
    runtime, events, protocolEvents, metadata, url, confirmation, stop, nativeResponse,
    select: (entry: 'runtime' | 'control', zoneId: string) => entry === 'runtime' ? runtime.selectZone(zoneId) : controlSelect(zoneId),
    controlSeek: (positionMs: number) => controlSeek(positionMs),
    nativePlay,
    hold: (kind: 'metadata' | 'url' | 'confirmation' | 'stop' | 'native-response') => { if (kind === 'metadata') holdMetadata = true; else if (kind === 'url') holdUrl = true; else if (kind === 'confirmation') holdConfirmation = true; else if (kind === 'native-response') holdNativeResponse = true; else holdStop = true; },
    failStop: (value: boolean) => { failStop = value; },
    entered: () => ({ metadata: metadataEntered, url: urlEntered, native: nativeDispatched }),
    async nativeReference() { const album = (await runtime.browseRoonAlbums({ offset: 0, limit: 1 })).items[0]!; return (await runtime.browseRoonAlbum(album.reference, { offset: 0, limit: 1 })).items[0]!.reference; },
    async nativePage() { const album = (await runtime.browseRoonAlbums({ offset: 0, limit: 1 })).items[0]!; return runtime.browseRoonAlbum(album.reference, { offset: 0, limit: 1 }); },
  };
}

function localDayKey(now = Date.now()): string {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

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
        qualityPreference: 'lossless',
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
      qualityPreference: 'lossless' as const,
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

test('队列替换失败保留有界根因诊断，之后正常播放无需重启', async t => {
  const f = await priorityRuntime(t);
  let fail = true;
  t.mock.method(StreamGateway.prototype, 'preflight', async () => {
    if (fail) throw new BridgeError('STREAM_UPSTREAM_FAILED', 'https://synthetic.invalid/private?token=synthetic', { details: { reason: 'UPSTREAM_HTTPS_UNAVAILABLE' } });
  });
  await assert.rejects(f.runtime.replacePlaybackQueue([{ trackId: '1001', qualityPreference: 'lossless' }], 0), { code: 'STREAM_UPSTREAM_FAILED' });
  const diagnostics = f.runtime.getDiagnostics();
  const failure = diagnostics.timeline.find(event => event.event === 'queue_replace_failed');
  assert.equal(failure?.code, 'STREAM_UPSTREAM_FAILED');
  assert.equal(failure?.state, 'error');
  assert.doesNotMatch(JSON.stringify(diagnostics), /synthetic\.invalid|private\?|token=|trackId/u);
  fail = false;
  const recovered = await f.runtime.replacePlaybackQueue([{ trackId: '1002', qualityPreference: 'lossless' }], 0);
  assert.equal(recovered.currentTrack?.id, '1002');
});

test('较新队列替换造成的正常取消不记成播放故障', async t => {
  const f = await priorityRuntime(t);
  f.hold('metadata');
  const first = f.runtime.replacePlaybackQueue([{ trackId: '1003', qualityPreference: 'lossless' }], 0);
  const cancelled = assert.rejects(first, error => error instanceof BridgeError && error.details?.reason === 'operation_cancelled');
  await turn();
  const latest = f.runtime.replacePlaybackQueue([{ trackId: '1004', qualityPreference: 'lossless' }], 0);
  f.metadata.resolve();
  await cancelled;
  assert.equal((await latest).currentTrack?.id, '1004');
  assert.equal(f.runtime.getDiagnostics().timeline.some(event => event.event === 'queue_replace_failed'), false);
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

test('synthetic runtime exposes local favorite check, set and list seams', async () => {
  const runtime = createTestBridgeRuntime();
  await runtime.start();
  const descriptor = {
    kind: 'track' as const,
    title: 'Synthetic Favorite',
    artist: 'Synthetic Artist',
    album: 'Synthetic Album',
  };

  assert.deepEqual(await runtime.checkFavorite(descriptor), { favorite: false });
  const set = await runtime.setFavorite(descriptor, true);
  assert.equal(set.favorite, true);
  assert.equal(set.item?.title, 'Synthetic Favorite');
  assert.deepEqual(await runtime.checkFavorite(descriptor), { favorite: true });
  assert.equal((await runtime.listFavorites('track', { offset: 0, limit: 20 })).items.length, 1);
  await runtime.setFavorite(descriptor, false);
  assert.deepEqual(await runtime.checkFavorite(descriptor), { favorite: false });
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
    dayKey: localDayKey(),
    tracks: [],
  });
});

test('synthetic runtime 切换 Zone 时停止当前播放并清除当前曲目', async () => {
  const runtime = createTestBridgeRuntime();
  await runtime.start();
  await runtime.playbackPlay('1000', 'lossless');

  await runtime.selectZone('zone-next');

  const playback = runtime.getPlaybackState();
  assert.equal(playback.state, 'idle');
  assert.equal(playback.positionMs, 0);
  assert.equal(playback.currentTrack, undefined);
  assert.equal(playback.canStop, false);
  assert.equal(playback.canPause, false);
  assert.equal(playback.canResume, false);
  assert.equal(playback.selectedZoneId, 'zone-next');
});

test('显式合成目录注入走同一公共曲目浏览，不提供试听成功证据', async () => {
  const { createSyntheticRoonLibrary } = await import('../src/roon/synthetic-library.js');
  const library = createSyntheticRoonLibrary();
  const runtime = createTestBridgeRuntime({ roonLibrary: library });
  const album = (await library.browseAlbums({ offset: 0, limit: 20 })).items[0]!;
  assert.equal((await runtime.browseRoonAlbums({ offset: 0, limit: 20 })).items[0]?.reference, album.reference);
  const tracks = await runtime.browseRoonAlbum(album.reference, { offset: 0, limit: 20 });
  assert.equal(tracks.items[0]?.title, '合成关联曲目');
  await assert.rejects(runtime.playRoonTrack(tracks.items[0]!.reference, 'synthetic-zone'));
});

for (const entry of ['runtime', 'control'] as const) {
  test(`MBP-003A：${entry}同turn换Zone撤销尚未进入mailbox的旧播放意图`, async t => {
    const f = await priorityRuntime(t);
    const pending = f.runtime.playbackPlay('1000', 'lossless');
    const ended = Promise.allSettled([pending]);
    const changed = f.select(entry, 'zone-B');
    try {
      await beforeSlowWork(changed, '同turn换Zone没有撤销旧播放意图');
      await ended; await turn();
      assert.equal(f.runtime.getPlaybackState().selectedZoneId, 'zone-B');
      assert.equal(f.events.some(event => event.startsWith('cloud-play:')), false, '旧mailbox意图不得稍后使用新Zone派发');
      assert.equal(f.runtime.getDiagnostics().counters.activeTokenCount, 0);
      assert.equal(f.runtime.getPlaybackState().state, 'idle');
    } finally { await ended; }
  });

  for (const blocked of ['metadata', 'url'] as const) test(`MBP-003A：${entry}换Zone撤销未派发${blocked}准备，迟到结果不能播放新Zone`, async t => {
    const f = await priorityRuntime(t); f.hold(blocked);
    const pending = f.runtime.playbackPlay('1000', 'lossless');
    const ended = Promise.allSettled([pending]);
    for (let i = 0; i < 20 && !f.entered()[blocked]; ++i) await turn();
    assert.equal(f.entered()[blocked], true);
    try {
      await beforeSlowWork(f.select(entry, 'zone-B'), '换Zone仍等待旧metadata/URL，未撤销准备所有权');
      assert.equal(f.runtime.getPlaybackState().selectedZoneId, 'zone-B');
      assert.equal(f.events.some(event => event.startsWith('cloud-play:')), false);
    } finally { f.metadata.resolve(); f.url.resolve(); await ended; }
    await turn();
    assert.equal(f.events.some(event => event.startsWith('cloud-play:')), false, '旧Zone取消后迟到准备不能注册或派发新Zone播放');
    assert.equal(f.runtime.getDiagnostics().counters.activeTokenCount, 0);
    assert.equal(f.runtime.getPlaybackState().state, 'idle');
  });

  test(`MBP-003A：${entry}换Zone在Native已派发未确认时先Stop原owner，确认关闭前不select`, async t => {
    const f = await priorityRuntime(t); f.hold('confirmation'); f.hold('stop');
    const pending = f.runtime.playRoonTrack(await f.nativeReference(), 'zone-A');
    const ended = Promise.allSettled([pending]);
    for (let i = 0; i < 20 && !f.entered().native; ++i) await turn();
    assert.equal(f.entered().native, true);
    const changed = f.select(entry, 'zone-B'), changedEnded = Promise.allSettled([changed]);
    try {
      for (let i = 0; i < 30 && !f.events.includes('control:stop:zone-A'); ++i) await turn();
      assert.ok(f.events.includes('control:stop:zone-A'), '旧播放确认不得阻塞原owner的停止派发');
      assert.equal(f.events.includes('select:zone-B'), false);
      assert.equal(f.runtime.getPlaybackState().selectedZoneId, 'zone-A');
      f.stop.resolve();
      await beforeSlowWork(changed, '原owner停止确认后仍等待已撤销的播放确认');
      assert.equal(f.runtime.getPlaybackState().selectedZoneId, 'zone-B');
      assert.ok(f.events.indexOf('control:stop:zone-A') < f.events.indexOf('select:zone-B'));
    } finally { f.stop.resolve(); f.confirmation.resolve(); await Promise.all([ended, changedEnded]); }
    assert.deepEqual(f.events.filter(event => event.startsWith('native-play:')), ['native-play:zone-A']);
    assert.equal(f.runtime.getPlaybackState().currentTrack, undefined);
  });

  test(`MBP-003A：${entry}停止未知保留原Zone所有权，重试确认前不得select`, async t => {
    const f = await priorityRuntime(t); f.hold('confirmation'); f.failStop(true);
    const pending = f.runtime.playRoonTrack(await f.nativeReference(), 'zone-A'), ended = Promise.allSettled([pending]);
    for (let i = 0; i < 20 && !f.entered().native; ++i) await turn();
    assert.equal(f.entered().native, true);
    try {
      await assert.rejects(beforeSlowWork(f.select(entry, 'zone-B'), '停止未知仍等待旧播放确认'), { code: 'ROON_TIMEOUT' });
      assert.equal(f.runtime.getPlaybackState().selectedZoneId, 'zone-A');
      assert.equal(f.events.some(event => event.startsWith('select:')), false);
      await assert.rejects(beforeSlowWork(f.select(entry, 'zone-B'), '停止未知重试仍等待旧播放确认'), { code: 'ROON_TIMEOUT' });
      assert.equal(f.events.filter(event => event === 'control:stop:zone-A').length, 2);
      assert.equal(f.events.some(event => event.startsWith('select:')), false);
      f.failStop(false);
      await beforeSlowWork(f.select(entry, 'zone-B'), '原owner停止成功后没有解除换Zone屏障');
      assert.equal(f.runtime.getPlaybackState().selectedZoneId, 'zone-B');
    } finally { f.failStop(false); f.confirmation.resolve(); await ended; }
    assert.deepEqual(f.events.filter(event => event.startsWith('native-play:')), ['native-play:zone-A']);
    assert.equal(f.runtime.getPlaybackState().state, 'idle');
  });

  test(`MBP-003A：${entry}取消Native确认不冒充实际SDK回执，Stop不得越过在途写入`, async t => {
    const f = await priorityRuntime(t); f.hold('confirmation'); f.hold('native-response');
    const pending = f.runtime.playRoonTrack(await f.nativeReference(), 'zone-A'), ended = Promise.allSettled([pending]);
    for (let i = 0; i < 20 && !f.entered().native; ++i) await turn();
    assert.equal(f.entered().native, true);
    const changed = f.select(entry, 'zone-B'), changedEnded = Promise.allSettled([changed]);
    try {
      for (let i = 0; i < 20; ++i) await turn();
      assert.equal(f.events.includes('control:stop:zone-A'), false, '确认取消不能把仍在途的实际写入当成完成');
      assert.equal(f.events.includes('select:zone-B'), false);
      f.nativeResponse.resolve();
      await beforeSlowWork(changed, '原SDK回执结束后停止仍被旧确认阻塞');
      assert.ok(f.events.indexOf('native-response:zone-A') < f.events.indexOf('control:stop:zone-A'));
      assert.ok(f.events.indexOf('control:stop:zone-A') < f.events.indexOf('select:zone-B'));
    } finally { f.nativeResponse.resolve(); f.confirmation.resolve(); await Promise.all([ended, changedEnded]); }
    assert.equal(f.runtime.getPlaybackState().selectedZoneId, 'zone-B');
    assert.equal(f.runtime.getPlaybackState().currentTrack, undefined);
  });
}

test('MBP-003A：生产runtime音量走独立设备路径，不等待metadata或URL准备', async t => {
  const f = await priorityRuntime(t); f.hold('metadata'); f.hold('url');
  const pending = f.runtime.playbackPlay('1000', 'lossless'), ended = Promise.allSettled([pending]);
  for (let i = 0; i < 20 && !f.entered().metadata; ++i) await turn();
  assert.equal(f.entered().metadata, true); assert.equal(f.entered().url, true);
  try {
    const volume = await beforeSlowWork(f.runtime.setVolume({ zoneId: 'zone-A', outputId: 'output-A', how: 'absolute', value: 47 }), '音量误入慢播放准备链');
    assert.equal(volume.outputs[0]?.value, 47);
    assert.ok(f.events.includes('volume:zone-A:47'));
    assert.equal(f.events.some(event => event.startsWith('cloud-play:')), false);
  } finally { f.metadata.resolve(); f.url.resolve(); await ended; }
});

test('MBP-003A：HTTP transport seek不越过实际Native写入，原回执后不等旧确认', async t => {
  const f = await priorityRuntime(t); f.hold('confirmation'); f.hold('native-response');
  const pending = f.runtime.playRoonTrack(await f.nativeReference(), 'zone-A'), ended = Promise.allSettled([pending]);
  for (let i = 0; i < 20 && !f.entered().native; ++i) await turn();
  assert.equal(f.entered().native, true);
  const seek = f.controlSeek(1250), seekEnded = Promise.allSettled([seek]);
  try {
    for (let i = 0; i < 20; ++i) await turn();
    assert.equal(f.events.some(event => event.startsWith('seek:')), false, 'HTTP控制不能绕过设备写入tail');
    f.nativeResponse.resolve();
    assert.equal((await beforeSlowWork(seek, 'HTTP seek仍等待旧播放确认')).positionMs, 1250);
    assert.ok(f.events.indexOf('native-response:zone-A') < f.events.indexOf('seek:zone-A:1250'));
  } finally { f.nativeResponse.resolve(); f.confirmation.resolve(); await Promise.all([ended, seekEnded]); }
});

test('MBP-003A：HTTP transport seek保留无MB owner时的外部Roon控制能力', async t => {
  const f = await priorityRuntime(t);
  assert.equal(f.runtime.getPlaybackState().currentTrack, undefined);
  assert.equal((await f.controlSeek(2500)).positionMs, 2500);
  assert.deepEqual(f.events.filter(event => event.startsWith('seek:')), ['seek:zone-A:2500']);
  assert.equal(f.events.some(event => event.startsWith('native-play:') || event.startsWith('cloud-play:')), false);
});

for (const hook of ['onDispatch', 'onDispatchCompletion'] as const) test(`MBP-003A：生产Native ${hook}同步取消仍挡住首个SDK写入`, async t => {
  const f = await priorityRuntime(t); f.hold('confirmation');
  const abort = new AbortController();
  const options = { signal: abort.signal, expectedZoneId: 'zone-A', [hook]: () => abort.abort() };
  await assert.rejects(f.nativePlay(await f.nativeReference(), 'zone-A', {
    id: 'synthetic-native', title: '合成本地曲目', artists: ['合成艺人'], album: '合成专辑',
  }, options), { code: 'BAD_REQUEST' });
  assert.equal(f.entered().native, false);
  assert.equal(f.events.some(event => event.startsWith('native-play:')), false);
});

test('003B：生产runtime初次handle播放先派发选曲，确认后才读取邻近页', async t => {
  const f = await priorityRuntime(t, { enabled: true }), page = await f.nativePage();
  assert.ok(page.playbackContextHandle);
  const reference = page.items[0]!.reference;
  await f.runtime.playRoonTrack(reference, 'zone-A', undefined, page.playbackContextHandle);
  for (let turnIndex = 0; turnIndex < 8; turnIndex++) await turn();
  assert.equal(f.events.filter(event => event === 'native-play:zone-A').length, 1);
  const dispatch = f.events.indexOf('native-play:zone-A'), firstRead = f.events.findIndex(event => event.startsWith('context-read:'));
  assert.ok(dispatch >= 0 && firstRead > dispatch, '初次派发不能等未读页');
  assert.ok(f.events.filter(event => event.startsWith('context-read:')).length <= 1, '首次只预取一个邻近页');
  const snapshot = await f.runtime.getPlaybackState();
  assert.equal(snapshot.currentTrack?.id, snapshot.queue.items[0]?.trackId);
  assert.ok(snapshot.queue.items.length > 1);
  assert.ok(snapshot.queue.items.every(item => item.roonItem?.kind === 'track'));
});

test('003B：无效或互斥handle不停止已有播放，不降级派发单曲', async t => {
  const f = await priorityRuntime(t), reference = await f.nativeReference();
  await f.runtime.playRoonTrack(reference, 'zone-A');
  const before = await f.runtime.getPlaybackState(), callCount = f.events.length;
  await assert.rejects(f.runtime.playRoonTrack(reference, 'zone-A', undefined, '11111111-1111-4111-8111-111111111111'), error => error instanceof BridgeError && error.code === 'ROON_LIBRARY_INVALID_REFERENCE');
  await assert.rejects(f.runtime.playRoonTrack(reference, 'zone-A', [reference], '11111111-1111-4111-8111-111111111111'), error => error instanceof BridgeError && error.code === 'BAD_REQUEST');
  assert.deepEqual(await f.runtime.getPlaybackState(), before);
  assert.equal(f.events.length, callCount);
});

test('003B：关闭正式增量队列开关不提供handle，旧单曲入口保留', async t => {
  const f = await priorityRuntime(t, { enabled: true, disabledFlag: true }), page = await f.nativePage();
  assert.equal(page.playbackContextHandle, undefined);
  await f.runtime.playRoonTrack(page.items[0]!.reference, 'zone-A');
  assert.equal(f.events.filter(event => event === 'native-play:zone-A').length, 1);
  assert.equal(f.events.filter(event => event === 'context-acquire' || event.startsWith('context-read:')).length, 0);
  await assert.rejects(f.runtime.playRoonTrack(page.items[0]!.reference, 'zone-A', undefined, '11111111-1111-4111-8111-111111111111'));
  assert.equal(f.events.filter(event => event === 'context-acquire').length, 0);
});

for (const size of [50, 500, 5000]) test(`003B：${size}条生产runtime合成上下文首播只预取一个窗口`, async t => {
  const f = await priorityRuntime(t, { enabled: true, size }), page = await f.nativePage();
  assert.ok(page.playbackContextHandle);
  await f.runtime.playRoonTrack(page.items[0]!.reference, 'zone-A', undefined, page.playbackContextHandle);
  for (let turnIndex = 0; turnIndex < 8; turnIndex++) await turn();
  const reads = f.events.filter(event => event.startsWith('context-read:'));
  assert.equal(reads.length, 1);
  assert.ok(f.events.indexOf('native-play:zone-A') < f.events.indexOf(reads[0]!));
  const snapshot = await f.runtime.getPlaybackState();
  assert.ok(snapshot.queue.items.length > 1 && snapshot.queue.items.length <= 101);
  assert.equal(snapshot.queue.index, 0);
  assert.equal(f.events.filter(event => event === 'native-play:zone-A').length, 1);
  if (size > 101) assert.equal(snapshot.queue.context?.afterComplete, false);
});


test('MBP006：真实runtime compact只读基准与命令回执共享owner事实，新Zone采样不贴旧seq', async t => {
  const f = await priorityRuntime(t, { protocol: 'compact-v1' });
  const seed = f.runtime.getPlaybackStreamSnapshot()!;
  assert.equal(seed.stamp.coreInstanceId, f.runtime.getPlaybackEventProtocol()!.coreInstanceId);
  assert.deepEqual(f.runtime.getPlaybackStreamSnapshot(), seed);
  const playing = await f.runtime.playbackPlay('101', 'lossless');
  assert.equal(playing.stream!.trackId, playing.currentTrack!.id);
  const sample = f.runtime.getPlaybackStreamSnapshot()!;
  assert.deepEqual(playing.stream, sample.stamp);
  await f.runtime.selectZone('zone-B');
  const moved = f.runtime.getPlaybackStreamSnapshot()!;
  assert.equal(moved.snapshot.selectedZoneId, 'zone-B');
  assert.equal(moved.stamp.selectedZoneId, 'zone-B');
  assert.ok(moved.stamp.sequence > sample.stamp.sequence);
  assert.deepEqual(f.runtime.getPlaybackState().stream, moved.stamp);
  const playbackEvents = f.protocolEvents.filter(event => event.event.startsWith('playback.') || event.event === 'queue.changed');
  assert.equal(playbackEvents.some(event => event.event === 'playback.changed' || event.event === 'queue.changed'), false);
});

test('MBP006：真实runtime legacy仍无ACK/stream，compact同曲重播换owner且前进seek保持state', async t => {
  const legacy = await priorityRuntime(t);
  assert.equal(legacy.runtime.getPlaybackEventProtocol(), null);
  assert.equal(legacy.runtime.getPlaybackStreamSnapshot(), null);
  assert.equal('stream' in legacy.runtime.getPlaybackState(), false);
  const f = await priorityRuntime(t, { protocol: 'compact-v1' });
  const first = await f.runtime.playbackPlay('101', 'lossless');
  const second = await f.runtime.playbackPlay('101', 'lossless');
  assert.ok(second.stream!.generation > first.stream!.generation);
  await f.runtime.seekPlayback(5000);
  const event = f.protocolEvents.filter(event => event.event.startsWith('playback.')).at(-1)!;
  assert.equal(event.event, 'playback.state');
  assert.ok(f.events.includes('seek:zone-A:5000'));
  assert.equal(f.runtime.getPlaybackState().positionMs, 0, '不能把请求目标冒充尚未观测的设备位置');
});
