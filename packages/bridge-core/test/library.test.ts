import assert from 'node:assert/strict';
import test from 'node:test';

import { NeteaseClient } from '../src/netease/client.js';
import { BridgeError } from '../src/shared/errors.js';

function track(id: number, title: string) {
  return {
    id,
    name: title,
    ar: [{ name: 'Synthetic Artist' }],
    al: {
      name: 'Synthetic Album',
      picUrl: 'https://p1.music.126.net/synthetic-cover.jpg',
    },
    dt: 180_000,
  };
}

type ApiFunction = (params: Record<string, unknown>) => Promise<unknown>;

interface LibraryApiOverrides {
  song_detail?: ApiFunction;
  song_url_v1?: ApiFunction;
  login_qr_key?: ApiFunction;
  login_qr_create?: ApiFunction;
  login_qr_check?: ApiFunction;
  login_status?: ApiFunction;
  logout?: ApiFunction;
  search?: ApiFunction;
  likelist?: ApiFunction;
  song_like?: ApiFunction;
  song_like_check?: ApiFunction;
  user_account?: ApiFunction;
  recommend_songs?: ApiFunction;
  user_playlist?: ApiFunction;
  playlist_detail?: ApiFunction;
  playlist_track_all?: ApiFunction;
}

function baseApi(overrides: LibraryApiOverrides = {}) {
  const empty = async () => ({ body: { code: 200 } });
  return {
    song_detail: empty,
    song_url_v1: empty,
    login_qr_key: empty,
    login_qr_create: empty,
    login_qr_check: empty,
    login_status: empty,
    logout: empty,
    ...overrides,
  };
}

test('NeteaseClient returns a sanitized public paged search result without forwarding the account credential', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const client = new NeteaseClient('synthetic-credential', baseApi({
    async search(params) {
      calls.push({ method: 'search', params });
      return {
        body: {
          code: 200,
          result: { songCount: 12, songs: [track(101, 'Synthetic Search')] },
        },
      };
    },
  }));

  assert.deepEqual(await client.searchTracks('  demo  ', { offset: 10, limit: 1 }), {
    items: [
      {
        id: '101',
        title: 'Synthetic Search',
        artists: ['Synthetic Artist'],
        album: 'Synthetic Album',
        durationMs: 180_000,
        artworkUrl: 'https://p1.music.126.net/synthetic-cover.jpg',
      },
    ],
    offset: 10,
    limit: 1,
    total: 12,
    hasMore: true,
  });
  assert.deepEqual(calls, [
    {
      method: 'search',
      params: {
        keywords: 'demo',
        type: 1,
        offset: 10,
        limit: 1,
      },
    },
  ]);
});

test('NeteaseClient reuses hydrated search metadata without repeating song_detail', async () => {
  let songDetailCalls = 0;
  const client = new NeteaseClient('synthetic-credential', baseApi({
    async search() {
      return {
        body: {
          code: 200,
          result: { songCount: 1, songs: [track(101, 'Hydrated Search Result')] },
        },
      };
    },
    async song_detail() {
      songDetailCalls += 1;
      return { body: { code: 200, songs: [track(101, 'Repeated Detail')] } };
    },
  }));

  await client.searchTracks('hydrated', { offset: 0, limit: 20 });
  assert.deepEqual(await client.getTrack('101'), {
    id: '101',
    title: 'Hydrated Search Result',
    artists: ['Synthetic Artist'],
    album: 'Synthetic Album',
    durationMs: 180_000,
    artworkUrl: 'https://p1.music.126.net/synthetic-cover.jpg',
  });
  assert.equal(songDetailCalls, 0);
});

test('NeteaseClient metadata cache is bounded and expires hydrated search results', async () => {
  let now = 1_000;
  const detailCalls: string[] = [];
  let searchTrack = track(101, 'First Search Result');
  const client = new NeteaseClient(
    'synthetic-credential',
    baseApi({
      async search() {
        return {
          body: {
            code: 200,
            result: { songCount: 1, songs: [searchTrack] },
          },
        };
      },
      async song_detail(params) {
        const id = Number(params.ids);
        detailCalls.push(String(id));
        return { body: { code: 200, songs: [track(id, `Detail ${id}`)] } };
      },
    }),
    undefined,
    { metadataCacheMaxEntries: 1, metadataCacheTtlMs: 100, now: () => now },
  );

  await client.searchTracks('first', { offset: 0, limit: 1 });
  searchTrack = track(102, 'Second Search Result');
  await client.searchTracks('second', { offset: 0, limit: 1 });
  assert.equal((await client.getTrack('102')).title, 'Second Search Result');
  assert.deepEqual(detailCalls, []);
  await client.getTrack('101');
  assert.deepEqual(detailCalls, ['101']);

  now += 101;
  await client.getTrack('102');
  assert.deepEqual(detailCalls, ['101', '102']);
});

test('NeteaseClient paginates the native liked playlist without loading all track metadata', async () => {
  const calls: string[] = [];
  const client = new NeteaseClient('synthetic-credential', baseApi({
    async user_account() {
      calls.push('account');
      return { body: { code: 200, account: { id: 42 } } };
    },
    async user_playlist() {
      calls.push('user_playlist');
      return { body: { code: 200, playlist: [{ id: 9001, specialType: 10, trackCount: 3 }] } };
    },
    async playlist_detail() {
      calls.push('playlist_detail:9001');
      return {
        body: {
          code: 200,
          playlist: { id: 9001, specialType: 10, trackCount: 3, trackIds: [201, 202, 203] },
        },
      };
    },
    async song_detail(params) {
      calls.push(`song_detail:${String(params.ids)}`);
      return { body: { code: 200, songs: [track(202, 'Liked Page')] } };
    },
  }));

  assert.deepEqual(await client.getLikedTracks({ offset: 1, limit: 1 }), {
    items: [
      {
        id: '202',
        title: 'Liked Page',
        artists: ['Synthetic Artist'],
        album: 'Synthetic Album',
        durationMs: 180_000,
        artworkUrl: 'https://p1.music.126.net/synthetic-cover.jpg',
      },
    ],
    offset: 1,
    limit: 1,
    total: 3,
    hasMore: true,
  });
  assert.deepEqual(calls, ['account', 'user_playlist', 'playlist_detail:9001', 'song_detail:202']);
});

test('NeteaseClient uses the native liked playlist order and reorders song details by trackIds', async () => {
  const calls: string[] = [];
  const client = new NeteaseClient('synthetic-credential', baseApi({
    async user_account() {
      calls.push('account');
      return { body: { code: 200, account: { id: 42 } } };
    },
    async user_playlist() {
      calls.push('user_playlist');
      return {
        body: {
          code: 200,
          playlist: [
            { id: 9001, name: '系统喜欢歌单', specialType: 10, trackCount: 3 },
            { id: 9002, name: '普通收藏', specialType: 0, trackCount: 3 },
          ],
        },
      };
    },
    async playlist_detail(params) {
      calls.push(`playlist_detail:${String(params.id)}`);
      return {
        body: {
          code: 200,
          playlist: {
            id: 9001,
            name: '系统喜欢歌单',
            specialType: 10,
            trackCount: 3,
            trackIds: [{ id: 303 }, { id: 301 }, { id: 302 }],
          },
        },
      };
    },
    async song_detail(params) {
      calls.push(`song_detail:${String(params.ids)}`);
      return { body: { code: 200, songs: [track(301, 'One'), track(302, 'Two'), track(303, 'Three')] } };
    },
  }));

  const result = await client.getLikedTracks({ offset: 0, limit: 3 });
  assert.deepEqual(result.items.map((item) => item.id), ['303', '301', '302']);
  assert.deepEqual(calls, ['account', 'user_playlist', 'playlist_detail:9001', 'song_detail:303,301,302']);
});

test('NeteaseClient loads liked track ids from the native likelist endpoint', async () => {
  const calls: string[] = [];
  const client = new NeteaseClient('synthetic-credential', baseApi({
    async user_account() {
      calls.push('account');
      return { body: { code: 200, account: { id: 42 } } };
    },
    async likelist(params) {
      calls.push(`likelist:${String(params.uid)}`);
      return { body: { code: 200, ids: [303, 301, 302] } };
    },
    async song_detail(params) {
      calls.push(`song_detail:${String(params.ids)}`);
      return { body: { code: 200, songs: [track(301, 'One'), track(302, 'Two'), track(303, 'Three')] } };
    },
  }));

  const result = await client.getLikedTracks({ offset: 0, limit: 3 });
  assert.deepEqual(result.items.map((item) => item.id), ['303', '301', '302']);
  assert.deepEqual(calls, ['account', 'likelist:42', 'song_detail:303,301,302']);
});

test('NeteaseClient exposes explicit NetEase like and like-status operations', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const client = new NeteaseClient('synthetic-credential', baseApi({
    async song_like(params) {
      calls.push({ method: 'song_like', params });
      return { body: { code: 200 } };
    },
    async song_like_check(params) {
      calls.push({ method: 'song_like_check', params });
      return { body: { code: 200, checkPoint: true } };
    },
  }));

  assert.deepEqual(await client.isTrackLiked('101'), { liked: true });
  assert.deepEqual(await client.likeTrack('101', false), { liked: false });
  assert.deepEqual(calls, [
    { method: 'song_like_check', params: { ids: '101', cookie: 'synthetic-credential' } },
    { method: 'song_like', params: { id: '101', like: false, cookie: 'synthetic-credential' } },
  ]);
});

test('NeteaseClient rejects a like-status response without an explicit boolean', async () => {
  const client = new NeteaseClient('synthetic-credential', baseApi({
    async song_like_check() {
      return { body: { code: 200, data: {} } };
    },
  }));

  await assert.rejects(
    () => client.isTrackLiked('101'),
    (error: unknown) => (
      error instanceof BridgeError &&
      error.code === 'NETEASE_REQUEST_FAILED' &&
      !error.message.includes('data')
    ),
  );
});

test('NeteaseClient rejects a like mutation response without an explicit success code', async () => {
  const client = new NeteaseClient('synthetic-credential', baseApi({
    async song_like() {
      return { body: {} };
    },
  }));

  await assert.rejects(
    () => client.likeTrack('101', true),
    (error: unknown) => error instanceof BridgeError && error.code === 'NETEASE_REQUEST_FAILED',
  );
});

test('NeteaseClient exposes account profile and daily recommendations through the pinned capabilities', async () => {
  const calls: string[] = [];
  const client = new NeteaseClient('synthetic-credential', baseApi({
    async user_account(params) {
      calls.push(`account:${String(params.cookie)}`);
      return {
        body: {
          code: 200,
          profile: {
            nickname: 'Synthetic Listener',
            avatarUrl: 'https://p1.music.126.net/avatar.jpg',
          },
        },
      };
    },
    async recommend_songs(params) {
      calls.push(`recommend:${String(params.afresh)}:${String(params.cookie)}`);
      return {
        body: {
          code: 200,
          dailySongs: [track(501, 'Daily Pick')],
          recommendReasons: [{ songId: 501, reason: 'Synthetic taste match' }],
        },
      };
    },
  }));

  assert.deepEqual(await client.getPublicAccountProfile(), {
    displayName: 'Synthetic Listener',
    avatarUrl: 'https://p1.music.126.net/avatar.jpg',
  });
  const recommendations = await client.getDailyRecommendations();
  assert.equal(recommendations.tracks[0]?.id, '501');
  assert.equal(recommendations.tracks[0]?.recommendationReason, 'Synthetic taste match');
  assert.deepEqual(calls, [
    'account:synthetic-credential',
    'recommend:false:synthetic-credential',
  ]);
});

test('NeteaseClient maps user playlists and loads only one playlist detail page', async () => {
  const calls: string[] = [];
  const client = new NeteaseClient('synthetic-credential', baseApi({
    async user_account() {
      calls.push('account');
      return { body: { code: 200, account: { id: 42 } } };
    },
    async user_playlist(params) {
      calls.push(`playlists:${String(params.uid)}:${String(params.limit)}:${String(params.offset)}`);
      return {
        body: {
          code: 200,
          playlist: [
            {
              id: 301,
              name: 'Synthetic Playlist',
              trackCount: 50,
              coverImgUrl: 'https://p1.music.126.net/synthetic-playlist.jpg',
            },
          ],
          playlistCount: 1,
          more: false,
        },
      };
    },
    async playlist_detail(params) {
      calls.push(`detail:${String(params.id)}`);
      return {
        body: {
          code: 200,
          playlist: {
            id: 301,
            name: 'Synthetic Playlist',
            description: 'Synthetic description',
            trackCount: 50,
            coverImgUrl: 'https://p1.music.126.net/synthetic-playlist.jpg',
            trackIds: Array.from({ length: 50 }, (_, index) => ({ id: 401 + index })),
          },
        },
      };
    },
    async song_detail(params) {
      const ids = String(params.ids).split(',');
      calls.push(`song_detail:${ids[0]}-${ids[ids.length - 1]}`);
      return { body: { code: 200, songs: [track(421, 'Playlist Page')] } };
    },
  }));

  assert.deepEqual(await client.getUserPlaylists(), [
    {
      id: '301',
      name: 'Synthetic Playlist',
      trackCount: 50,
      artworkUrl: 'https://p1.music.126.net/synthetic-playlist.jpg',
    },
  ]);
  assert.deepEqual(await client.getPlaylist('301', { offset: 20, limit: 10 }), {
    id: '301',
    name: 'Synthetic Playlist',
    description: 'Synthetic description',
    trackCount: 50,
    artworkUrl: 'https://p1.music.126.net/synthetic-playlist.jpg',
    tracks: {
      items: [
        {
          id: '421',
          title: 'Playlist Page',
          artists: ['Synthetic Artist'],
          album: 'Synthetic Album',
          durationMs: 180_000,
          artworkUrl: 'https://p1.music.126.net/synthetic-cover.jpg',
        },
      ],
      offset: 20,
      limit: 10,
      total: 50,
      hasMore: true,
    },
  });
  assert.deepEqual(calls, [
    'account',
    'playlists:42:100:0',
    'detail:301',
    'song_detail:421-430',
  ]);
});

test('NeteaseClient opens a 1200-track playlist page without the unbounded track wrapper', async () => {
  const calls: string[] = [];
  const trackIds = Array.from({ length: 1200 }, (_, index) => ({ id: 1000 + index }));
  const client = new NeteaseClient('synthetic-credential', baseApi({
    async playlist_detail(params) {
      calls.push(`detail:${String(params.id)}`);
      return {
        body: {
          code: 200,
          playlist: {
            id: 301,
            name: 'Synthetic Large Playlist',
            trackCount: 1200,
            trackIds,
          },
        },
      };
    },
    async song_detail(params) {
      const ids = String(params.ids).split(',').map(Number);
      calls.push(`song_detail:${ids[0]}-${ids[ids.length - 1]}`);
      return {
        body: {
          code: 200,
          songs: ids.map((id) => track(id, `Playlist Track ${id}`)),
        },
      };
    },
    async playlist_track_all() {
      calls.push('legacy_playlist_track_all');
      return { body: { code: 200, songs: [] } };
    },
  }));

  const result = await client.getPlaylist('301', { offset: 1000, limit: 20 });

  assert.equal(result.trackCount, 1200);
  assert.equal(result.tracks.items.length, 20);
  assert.equal(result.tracks.items[0]?.id, '2000');
  assert.equal(result.tracks.items.at(-1)?.id, '2019');
  assert.equal(result.tracks.hasMore, true);
  assert.deepEqual(calls, ['detail:301', 'song_detail:2000-2019']);
});

test('NeteaseClient refuses library access without a credential', async () => {
  const client = new NeteaseClient(undefined, baseApi());
  await assert.rejects(
    () => client.searchTracks('demo', { offset: 0, limit: 10 }),
    (error: { code?: string }) => error.code === 'NETEASE_NOT_CONFIGURED',
  );
});

test('NeteaseClient maps an expired Provider session to AUTH_EXPIRED', async () => {
  const client = new NeteaseClient('synthetic-credential', baseApi({
    search: async () => ({ body: { code: 301, message: 'synthetic expired session' } }),
  }));
  await assert.rejects(
    () => client.searchTracks('demo', { offset: 0, limit: 10 }),
    (error: { code?: string }) => error.code === 'AUTH_EXPIRED',
  );
});
