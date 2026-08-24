import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IPC_VERSION,
  type DiagnosticComponentSnapshot,
  type IpcEventMessage,
  type PlaybackSnapshot,
} from '@music-bridge/contracts';
import {
  attachCoreRuntimePort,
  type CoreRuntimeForIpc,
  type UtilityPort,
} from '../src/utility-main.js';
import { BridgeError } from '../src/shared/errors.js';
import { emptyLyricsSnapshot } from '../src/netease/lyrics.js';

class FakePort implements UtilityPort {
  readonly messages: unknown[] = [];
  private listener: ((event: { data: unknown }) => void) | undefined;

  on(event: 'message', listener: (event: { data: unknown }) => void): void {
    assert.equal(event, 'message');
    this.listener = listener;
  }

  start(): void {}

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  send(message: unknown): void {
    this.listener?.({ data: message });
  }
}

function makeRuntime(): CoreRuntimeForIpc & {
  shutdownCalls: number
  setCredentialCalls: string[]
  clearCredentialCalls: number
  setProviderCredential(credential: string): Promise<typeof state>
  clearProviderCredential(): Promise<typeof state>
  verifyProviderCredential(credential: string): Promise<{
    status: 'authorized' | 'expired' | 'unavailable'
  }>
  getAuthState(): { status: 'idle' | 'waiting' | 'authorized' }
  beginQrLogin(): Promise<{
    status: 'waiting'
    challengeId: string
    qrImage: string
    expiresAt: number
  }>
  pollQrLogin(challengeId: string): Promise<{
    state: { status: 'authorized' }
    credential?: string
  }>
  cancelQrLogin(challengeId: string): { status: 'cancelled'; challengeId?: string }
  logoutProvider(): Promise<{ status: 'idle' }>
} {
  const state = {
    runtime: 'ready' as const,
    roon: 'disconnected' as const,
    provider: 'missing' as const,
    activeStreamCount: 0,
    activePlaybackPresent: false,
  };
  const authState = { status: 'idle' as const };
  const accountState = {
    status: 'ready' as const,
    profile: {
      displayName: 'Synthetic Listener',
      avatarUrl: 'https://p1.music.126.net/synthetic-avatar.jpg',
    },
  };
  const dailyRecommendations = {
    dayKey: '2026-08-22',
    tracks: [
      {
        id: '101',
        title: 'Synthetic Recommendation',
        artists: ['Synthetic Artist'],
        album: 'Synthetic Album',
        artworkUrl: 'https://p1.music.126.net/recommend.jpg',
        recommendationReason: 'Synthetic taste match',
      },
    ],
  };
  const playbackState: PlaybackSnapshot = {
    state: 'idle',
    queue: { items: [], index: -1, hasNext: false, hasPrevious: false },
    positionMs: 0,
    canNext: false,
    canPrevious: false,
    canStop: false,
    canPause: false,
    canResume: false,
  };
  const diagnostics: DiagnosticComponentSnapshot = {
    component: 'core',
    health: state,
    timeline: [],
    memory: { rssBytes: 1, heapUsedBytes: 1, heapTotalBytes: 1, externalBytes: 1 },
    counters: {
      queueItemCount: 0,
      activeStreamCount: 0,
      activePlaybackCount: 0,
      activeSessionCount: 0,
      activeTokenCount: 0,
      listenerCount: 0,
      timerCount: 0,
    },
    latency: {},
    gates: [],
  };
  return {
    shutdownCalls: 0,
    setCredentialCalls: [],
    clearCredentialCalls: 0,
    async start() {},
    async shutdown() {
      this.shutdownCalls += 1;
    },
    ping: () => ({ pong: true as const }),
    getHealth: () => state,
    getState: () => state,
    getDiagnostics: () => diagnostics,
    listZones: () => [],
    selectZone: async () => state,
    async setProviderCredential(credential: string) {
      this.setCredentialCalls.push(credential)
      return state
    },
    async verifyProviderCredential(credential: string) {
      assert.equal(credential, 'synthetic-credential')
      return { status: 'authorized' as const }
    },
    async clearProviderCredential() {
      this.clearCredentialCalls += 1
      return state
    },
    getAuthState: () => authState,
    async beginQrLogin() {
      return {
        status: 'waiting' as const,
        challengeId: 'challenge-utility',
        qrImage: 'data:image/png;base64,synthetic-qr',
        expiresAt: 123_456,
      }
    },
    async pollQrLogin(challengeId: string) {
      assert.equal(challengeId, 'challenge-utility')
      return { state: { status: 'authorized' as const }, credential: 'synthetic-credential' }
    },
    cancelQrLogin: (challengeId: string) => {
      assert.equal(challengeId, 'challenge-utility')
      return { status: 'cancelled' as const }
    },
    async logoutProvider() {
      return { status: 'idle' as const }
    },
    getAccountState: () => accountState,
    async refreshAccountProfile() {
      return accountState
    },
    async getDailyRecommendations() {
      return dailyRecommendations
    },
    async searchTracks() {
      return {
        items: [
          {
            id: '101',
            title: 'Synthetic Song',
            artists: ['Synthetic Artist'],
            album: 'Synthetic Album',
          },
        ],
        offset: 0,
        limit: 20,
        total: 1,
        hasMore: false,
      }
    },
    async searchArtists() {
      return { items: [], offset: 0, limit: 20, total: 0, hasMore: false }
    },
    async searchAlbums() {
      return { items: [], offset: 0, limit: 20, total: 0, hasMore: false }
    },
    async getArtist() {
      return { id: '2000', name: 'Synthetic Artist', tracks: { items: [], offset: 0, limit: 20, total: 0, hasMore: false } }
    },
    async getAlbum() {
      return { id: '3000', name: 'Synthetic Album', artistName: 'Synthetic Artist', tracks: { items: [], offset: 0, limit: 20, total: 0, hasMore: false } }
    },
    async getLikedTracks() {
      return { items: [], offset: 0, limit: 20, total: 0, hasMore: false }
    },
    async getUserPlaylists() {
      return [{ id: '301', name: 'Synthetic Playlist', trackCount: 1 }]
    },
    async getPlaylist() {
      return {
        id: '301',
        name: 'Synthetic Playlist',
        trackCount: 1,
        tracks: { items: [], offset: 0, limit: 20, total: 1, hasMore: false },
      }
    },
    async getLyrics() {
      return emptyLyricsSnapshot('unavailable')
    },
    getPlaybackState: () => playbackState,
    async playbackPlay() {
      return playbackState;
    },
    async playbackPause() {
      return playbackState;
    },
    async playbackResume() {
      return playbackState;
    },
    async playbackStop() {
      return playbackState;
    },
    async playbackNext() {
      return playbackState;
    },
    async playbackPrevious() {
      return playbackState;
    },
    async replacePlaybackQueue() {
      return playbackState;
    },
    async appendPlaybackQueue() {
      return playbackState;
    },
    async insertNextPlayback() {
      return playbackState;
    },
  };
}

test('utility IPC returns ready, typed responses and bounded events', async () => {
  const port = new FakePort();
  const runtime = makeRuntime();
  await attachCoreRuntimePort(port, runtime);

  assert.deepEqual(port.messages[0], {
    version: IPC_VERSION,
    event: 'core.ready',
    payload: { state: runtime.getState() },
  } satisfies IpcEventMessage);

  port.send({
    version: IPC_VERSION,
    id: 'ping-1',
    command: 'core.ping',
    payload: {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(port.messages[1], {
    version: IPC_VERSION,
    id: 'ping-1',
    ok: true,
    result: { pong: true },
  });

  port.send({
    version: IPC_VERSION,
    id: 'diagnostics-1',
    command: 'core.getDiagnostics',
    payload: {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(port.messages[2], {
    version: IPC_VERSION,
    id: 'diagnostics-1',
    ok: true,
    result: runtime.getDiagnostics(),
  });
  assert.doesNotMatch(JSON.stringify(port.messages[2]), /trackId|Cookie|https?:\/\/|[?&][A-Za-z0-9_-]+=/i);
});

test('utility IPC rejects invalid payloads without throwing internal details', async () => {
  const port = new FakePort();
  await attachCoreRuntimePort(port, makeRuntime());

  port.send({
    version: IPC_VERSION,
    id: 'bad-1',
    command: 'roon.selectZone',
    payload: { zoneId: 7 },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(port.messages[1], {
    version: IPC_VERSION,
    id: 'bad-1',
    ok: false,
    error: {
      code: 'INVALID_IPC_REQUEST',
      message: 'Invalid IPC request',
    },
  });
});

test('utility shutdown is bounded behind the typed command', async () => {
  const port = new FakePort();
  const runtime = makeRuntime();
  await attachCoreRuntimePort(port, runtime);

  port.send({
    version: IPC_VERSION,
    id: 'shutdown-1',
    command: 'core.shutdown',
    payload: {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.shutdownCalls, 1);
  assert.deepEqual(port.messages[1], {
    version: IPC_VERSION,
    id: 'shutdown-1',
    ok: true,
    result: { stopped: true },
  });
});

test('controlled credential requests return only public state', async () => {
  const port = new FakePort();
  const runtime = makeRuntime();
  await attachCoreRuntimePort(port, runtime);

  port.send({
    version: IPC_VERSION,
    id: 'credential-1',
    command: 'auth.setCredential',
    payload: { credential: 'fixture-credential' },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(runtime.setCredentialCalls, ['fixture-credential']);
  assert.deepEqual(port.messages[1], {
    version: IPC_VERSION,
    id: 'credential-1',
    ok: true,
    result: runtime.getState(),
  });
  assert.doesNotMatch(JSON.stringify(port.messages[1]), /fixture-credential/);

  port.send({
    version: IPC_VERSION,
    id: 'credential-2',
    command: 'auth.clearCredential',
    payload: {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.clearCredentialCalls, 1);
  assert.deepEqual(port.messages[2], {
    version: IPC_VERSION,
    id: 'credential-2',
    ok: true,
    result: runtime.getState(),
  });
});

test('utility IPC exposes paged library data without raw provider fields', async () => {
  const port = new FakePort();
  await attachCoreRuntimePort(port, makeRuntime());

  port.send({
    version: IPC_VERSION,
    id: 'library-search',
    command: 'library.search',
    payload: { query: 'synthetic', page: { offset: 0, limit: 20 } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(port.messages[1], {
    version: IPC_VERSION,
    id: 'library-search',
    ok: true,
    result: {
      items: [
        {
          id: '101',
          title: 'Synthetic Song',
          artists: ['Synthetic Artist'],
          album: 'Synthetic Album',
        },
      ],
      offset: 0,
      limit: 20,
      total: 1,
      hasMore: false,
    },
  });
  assert.doesNotMatch(JSON.stringify(port.messages[1]), /rawProvider|cookie|token|Authorization/i);

  port.send({
    version: IPC_VERSION,
    id: 'library-playlists',
    command: 'library.playlists',
    payload: {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(port.messages[2], {
    version: IPC_VERSION,
    id: 'library-playlists',
    ok: true,
    result: [{ id: '301', name: 'Synthetic Playlist', trackCount: 1 }],
  });
});

test('utility IPC exposes account state and daily recommendations through typed commands', async () => {
  const port = new FakePort();
  const runtime = makeRuntime();
  await attachCoreRuntimePort(port, runtime);

  for (const [id, command] of [
    ['account-state', 'account.getState'],
    ['account-refresh', 'account.refresh'],
    ['daily-recommendations', 'library.dailyRecommendations'],
  ] as const) {
    port.send({ version: IPC_VERSION, id, command, payload: {} });
    await new Promise((resolve) => setImmediate(resolve));
    const response = port.messages.at(-1);
    assert.equal((response as { ok?: boolean }).ok, true);
    assert.doesNotMatch(JSON.stringify(response), /cookie|userId|rawProvider|recommendReasons/i);
  }
});

test('utility IPC maps an expired Provider session to a public error', async () => {
  const port = new FakePort();
  const runtime = makeRuntime();
  runtime.searchTracks = async () => {
    throw new BridgeError('AUTH_EXPIRED', 'synthetic raw provider detail');
  };
  await attachCoreRuntimePort(port, runtime);

  port.send({
    version: IPC_VERSION,
    id: 'library-expired',
    command: 'library.search',
    payload: { query: 'synthetic', page: { offset: 0, limit: 20 } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(port.messages[1], {
    version: IPC_VERSION,
    id: 'library-expired',
    ok: false,
    error: { code: 'AUTH_EXPIRED', message: 'Provider session expired' },
  });
  assert.doesNotMatch(JSON.stringify(port.messages[1]), /synthetic raw provider detail/);
});

test('utility IPC returns bounded lyrics snapshots without provider response fields', async () => {
  const port = new FakePort();
  await attachCoreRuntimePort(port, makeRuntime());

  port.send({
    version: IPC_VERSION,
    id: 'lyrics-get',
    command: 'lyrics.get',
    payload: { trackId: '101' },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(port.messages[1], {
    version: IPC_VERSION,
    id: 'lyrics-get',
    ok: true,
    result: {
      status: 'unavailable',
      lines: [],
      activeLineIndex: -1,
      timingSource: 'static',
    },
  });
  assert.doesNotMatch(JSON.stringify(port.messages[1]), /rawProvider|cookie|token|Authorization/i);
});

test('utility IPC dispatches typed playback controls without exposing stream internals', async () => {
  const port = new FakePort();
  const runtime = makeRuntime();
  await attachCoreRuntimePort(port, runtime);

  for (const [id, command, payload] of [
    ['playback-state', 'playback.getState', {}],
    ['playback-play', 'playback.play', { trackId: '101', qualityPreference: 'lossless' }],
    ['playback-pause', 'playback.pause', {}],
    ['playback-resume', 'playback.resume', {}],
    ['playback-stop', 'playback.stop', {}],
    ['playback-next', 'playback.next', {}],
    ['playback-previous', 'playback.previous', {}],
    [
      'playback-replace',
      'playback.replaceQueue',
      { items: [{ trackId: '101', qualityPreference: 'lossless' }], index: 0 },
    ],
    ['playback-append', 'playback.appendQueue', { items: [{ trackId: '101', qualityPreference: 'lossless' }] }],
    ['playback-insert-next', 'playback.insertNext', { items: [{ trackId: '101', qualityPreference: 'lossless' }] }],
  ] as const) {
    port.send({ version: IPC_VERSION, id, command, payload });
    await new Promise((resolve) => setImmediate(resolve));
    const response = port.messages.at(-1);
    assert.deepEqual(response, {
      version: IPC_VERSION,
      id,
      ok: true,
      result: runtime.getPlaybackState(),
    });
    assert.doesNotMatch(JSON.stringify(response), /upstreamUrl|gatewayToken|cookie|token/i);
  }
});

test('utility QR commands keep the credential only in the Core-to-Main response', async () => {
  const port = new FakePort();
  await attachCoreRuntimePort(port, makeRuntime());

  port.send({
    version: IPC_VERSION,
    id: 'qr-begin',
    command: 'auth.beginQr',
    payload: {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(port.messages[1], {
    version: IPC_VERSION,
    id: 'qr-begin',
    ok: true,
    result: {
      status: 'waiting',
      challengeId: 'challenge-utility',
      qrImage: 'data:image/png;base64,synthetic-qr',
      expiresAt: 123_456,
    },
  });

  port.send({
    version: IPC_VERSION,
    id: 'qr-poll',
    command: 'auth.pollQr',
    payload: { challengeId: 'challenge-utility' },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(port.messages[2], {
    version: IPC_VERSION,
    id: 'qr-poll',
    ok: true,
    result: {
      state: { status: 'authorized' },
      credential: 'synthetic-credential',
    },
  });
});
