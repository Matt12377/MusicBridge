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
    async aggregateSearch(query, page) {
      return {
        query,
        netease: {
          items: [
            {
              id: '101',
              title: 'Synthetic Song',
              artists: ['Synthetic Artist'],
              album: 'Synthetic Album',
            },
          ],
          offset: page.offset,
          limit: page.limit,
          total: 1,
          hasMore: false,
        },
        roon: { items: [], offset: page.offset, limit: page.limit, hasMore: false },
        roonAvailable: false,
      };
    },
    async getLikedTracks() {
      return { items: [], offset: 0, limit: 20, total: 0, hasMore: false }
    },
    async getTrackLikeStatus() {
      return { liked: false }
    },
    async likeTrack(_trackId, liked) {
      return { liked }
    },
    async matchLibraryTrack(track) {
      return {
        trackId: track.id,
        state: 'NONE' as const,
        confidence: 0,
        evidence: ['roon-library-unavailable'],
        candidates: [],
        algorithmVersion: 'v2-deterministic-1',
      };
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
    async seekPlayback(positionMs) {
      return { positionMs };
    },
    async playbackPlay() {
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
    async browseRoonAlbums(page) {
      return { items: [], offset: page.offset, limit: page.limit };
    },
    async browseRoonArtists(page) {
      return { items: [], offset: page.offset, limit: page.limit };
    },
    async browseRoonGenres(page) {
      return { items: [], offset: page.offset, limit: page.limit };
    },
    async browseRoonPlaylists(page) {
      return { items: [], offset: page.offset, limit: page.limit };
    },
    async browseRoonAlbum() {
      return { items: [], offset: 0, limit: 20 };
    },
    async browseRoonArtist() {
      return { items: [], offset: 0, limit: 20 };
    },
    async searchRoonLibrary() {
      return { items: [], offset: 0, limit: 20 };
    },
    async getRoonImage() {
      return { contentType: 'image/jpeg', body: new Uint8Array() };
    },
    async playRoonTrack() {
      return { started: true as const };
    },
    async queueRoonTrack() {
      return { queued: true as const };
    },
    async stopRoonTransport() {
      return { stopped: true as const };
    },
    async listFavorites() {
      return { items: [], offset: 0, limit: 20, total: 0, hasMore: false };
    },
    async checkFavorite() {
      return { favorite: false };
    },
    async setFavorite(_descriptor, favorite) {
      return { favorite };
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

test('utility IPC aggregates NetEase and Roon search without leaking unavailable details', async () => {
  const port = new FakePort();
  await attachCoreRuntimePort(port, makeRuntime());

  port.send({
    version: IPC_VERSION,
    id: 'aggregate-search',
    command: 'library.aggregateSearch',
    payload: { query: 'synthetic', page: { offset: 0, limit: 20 } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(port.messages[1], {
    version: IPC_VERSION,
    id: 'aggregate-search',
    ok: true,
    result: {
      query: 'synthetic',
      netease: {
        items: [{ id: '101', title: 'Synthetic Song', artists: ['Synthetic Artist'], album: 'Synthetic Album' }],
        offset: 0,
        limit: 20,
        total: 1,
        hasMore: false,
      },
      roon: { items: [], offset: 0, limit: 20, hasMore: false },
      roonAvailable: false,
    },
  });
  assert.doesNotMatch(JSON.stringify(port.messages[1]), /item_key|rawProvider|cookie|token/i);
});

test('utility IPC keeps NetEase like operations explicit and typed', async () => {
  const port = new FakePort();
  await attachCoreRuntimePort(port, makeRuntime());

  port.send({ version: IPC_VERSION, id: 'like-status', command: 'library.likeStatus', payload: { trackId: '101' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(port.messages[1], {
    version: IPC_VERSION,
    id: 'like-status',
    ok: true,
    result: { liked: false },
  });

  port.send({ version: IPC_VERSION, id: 'like', command: 'library.like', payload: { trackId: '101', liked: true } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(port.messages[2], {
    version: IPC_VERSION,
    id: 'like',
    ok: true,
    result: { liked: true },
  });
});

test('utility IPC exposes fail-closed library matching without raw Roon identifiers', async () => {
  const port = new FakePort();
  await attachCoreRuntimePort(port, makeRuntime());

  port.send({
    version: IPC_VERSION,
    id: 'library-match',
    command: 'library.match',
    payload: {
      track: {
        id: '101',
        title: 'Synthetic Song',
        artists: ['Synthetic Artist'],
        album: 'Synthetic Album',
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(port.messages[1], {
    version: IPC_VERSION,
    id: 'library-match',
    ok: true,
    result: {
      trackId: '101',
      state: 'NONE',
      confidence: 0,
      evidence: ['roon-library-unavailable'],
      candidates: [],
      algorithmVersion: 'v2-deterministic-1',
    },
  });
  assert.doesNotMatch(JSON.stringify(port.messages[1]), /item_key|mediaPath|rawProvider|cookie/i);
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

test('utility IPC dispatches local favorite relationships without media fields', async () => {
  const port = new FakePort();
  await attachCoreRuntimePort(port, makeRuntime());

  const descriptor = {
    kind: 'track' as const,
    title: 'Synthetic Song',
    artist: 'Synthetic Artist',
    album: 'Synthetic Album',
    durationMs: 180_000,
  };

  port.send({
    version: IPC_VERSION,
    id: 'favorites-list',
    command: 'favorites.list',
    payload: { kind: 'track', page: { offset: 0, limit: 20 } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(port.messages[1], {
    version: IPC_VERSION,
    id: 'favorites-list',
    ok: true,
    result: { items: [], offset: 0, limit: 20, total: 0, hasMore: false },
  });

  port.send({
    version: IPC_VERSION,
    id: 'favorites-check',
    command: 'favorites.check',
    payload: { descriptor },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(port.messages[2], {
    version: IPC_VERSION,
    id: 'favorites-check',
    ok: true,
    result: { favorite: false },
  });

  port.send({
    version: IPC_VERSION,
    id: 'favorites-set',
    command: 'favorites.set',
    payload: { descriptor, favorite: true },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(port.messages[3], {
    version: IPC_VERSION,
    id: 'favorites-set',
    ok: true,
    result: { favorite: true },
  });
  assert.doesNotMatch(JSON.stringify(port.messages[3]), /item_key|media|path|file|https?:\/\//i);
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

test('utility IPC dispatches the opaque Roon Library browse/image seams', async () => {
  const port = new FakePort();
  const runtime = makeRuntime();
  await attachCoreRuntimePort(port, runtime);

  port.send({
    version: IPC_VERSION,
    id: 'roon-albums',
    command: 'roon.library.albums',
    payload: { page: { offset: 0, limit: 20 } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(port.messages[1], {
    version: IPC_VERSION,
    id: 'roon-albums',
    ok: true,
    result: { items: [], offset: 0, limit: 20 },
  });

  port.send({
    version: IPC_VERSION,
    id: 'roon-album',
    command: 'roon.library.album',
    payload: {
      reference: 'musicbridge-v2-entity-123e4567-e89b-12d3-a456-426614174000',
      page: { offset: 0, limit: 20 },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(port.messages[2], {
    version: IPC_VERSION,
    id: 'roon-album',
    ok: true,
    result: { items: [], offset: 0, limit: 20 },
  });

  port.send({
    version: IPC_VERSION,
    id: 'roon-image',
    command: 'roon.library.image',
    payload: {
      reference: 'musicbridge-v2-image-123e4567-e89b-12d3-a456-426614174001',
      options: { width: 128, height: 128 },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const response = port.messages[3] as { result?: { contentType?: string; body?: Uint8Array } };
  assert.equal(response.result?.contentType, 'image/jpeg');
  assert.deepEqual(response.result?.body, new Uint8Array());

  port.send({
    version: IPC_VERSION,
    id: 'roon-play',
    command: 'roon.library.play',
    payload: {
      reference: 'musicbridge-v2-entity-123e4567-e89b-12d3-a456-426614174000',
      zoneId: 'zone-1',
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(port.messages[4], {
    version: IPC_VERSION,
    id: 'roon-play',
    ok: true,
    result: { started: true },
  });

  port.send({
    version: IPC_VERSION,
    id: 'roon-queue',
    command: 'roon.library.queue',
    payload: {
      reference: 'musicbridge-v2-entity-123e4567-e89b-12d3-a456-426614174000',
      zoneId: 'zone-1',
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(port.messages[5], {
    version: IPC_VERSION,
    id: 'roon-queue',
    ok: true,
    result: { queued: true },
  });
});

test('utility IPC dispatches expanded Roon artist, genre, playlist and search seams', async () => {
  const port = new FakePort();
  await attachCoreRuntimePort(port, makeRuntime());

  const requests = [
    ['roon-artists', 'roon.library.artists', { page: { offset: 0, limit: 20 } }],
    ['roon-genres', 'roon.library.genres', { page: { offset: 0, limit: 20 } }],
    ['roon-playlists', 'roon.library.playlists', { page: { offset: 0, limit: 20 } }],
    ['roon-artist', 'roon.library.artist', {
      reference: 'musicbridge-v2-entity-123e4567-e89b-12d3-a456-426614174000',
      page: { offset: 0, limit: 20 },
    }],
    ['roon-search', 'roon.library.search', { query: 'Artist', page: { offset: 0, limit: 20 } }],
  ] as const;

  for (const [id, command, payload] of requests) {
    port.send({ version: IPC_VERSION, id, command, payload });
    await new Promise((resolve) => setImmediate(resolve));
  }

  for (const [index, [id]] of requests.entries()) {
    assert.deepEqual(port.messages[index + 1], {
      version: IPC_VERSION,
      id,
      ok: true,
      result: { items: [], offset: 0, limit: 20 },
    });
  }
});

test('utility IPC dispatches typed playback controls without exposing stream internals', async () => {
  const port = new FakePort();
  const runtime = makeRuntime();
  await attachCoreRuntimePort(port, runtime);

  for (const [id, command, payload] of [
    ['playback-state', 'playback.getState', {}],
    ['playback-play', 'playback.play', { trackId: '101', qualityPreference: 'lossless' }],
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

test('utility IPC exposes bounded interactive seek', async () => {
  const port = new FakePort();
  await attachCoreRuntimePort(port, makeRuntime());

  port.send({
    version: IPC_VERSION,
    id: 'playback-seek',
    command: 'playback.seek',
    payload: { positionMs: 12_345 },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(port.messages[1], {
    version: IPC_VERSION,
    id: 'playback-seek',
    ok: true,
    result: { positionMs: 12_345 },
  });

  port.send({
    version: IPC_VERSION,
    id: 'playback-seek-invalid',
    command: 'playback.seek',
    payload: { positionMs: -1 },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(port.messages[2], {
    version: IPC_VERSION,
    id: 'playback-seek-invalid',
    ok: false,
    error: { code: 'INVALID_IPC_REQUEST', message: 'Invalid IPC request' },
  });
});

test('utility IPC exposes only the typed Roon transport stop control', async () => {
  const port = new FakePort();
  await attachCoreRuntimePort(port, makeRuntime());

  port.send({
    version: IPC_VERSION,
    id: 'roon-transport-stop',
    command: 'roon.transport.stop',
    payload: {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(port.messages[1], {
    version: IPC_VERSION,
    id: 'roon-transport-stop',
    ok: true,
    result: { stopped: true },
  });
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
