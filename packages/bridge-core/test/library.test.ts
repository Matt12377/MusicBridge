import assert from 'node:assert/strict';
import test from 'node:test';

import { NeteaseClient } from '../src/netease/client.js';

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
  user_account?: ApiFunction;
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

test('NeteaseClient returns a sanitized paged search result', async () => {
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
        cookie: 'synthetic-credential',
      },
    },
  ]);
});

test('NeteaseClient paginates liked track ids without loading all track metadata', async () => {
  const calls: string[] = [];
  const client = new NeteaseClient('synthetic-credential', baseApi({
    async user_account() {
      calls.push('account');
      return { body: { code: 200, account: { id: 42 } } };
    },
    async likelist(params) {
      calls.push(`likelist:${String(params.uid)}`);
      return { body: { code: 200, ids: [201, 202, 203] } };
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
  assert.deepEqual(calls, ['account', 'likelist:42', 'song_detail:202']);
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
          },
        },
      };
    },
    async playlist_track_all(params) {
      calls.push(`tracks:${String(params.id)}:${String(params.limit)}:${String(params.offset)}`);
      return { body: { code: 200, songs: [track(401, 'Playlist Page')] } };
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
          id: '401',
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
    'tracks:301:10:20',
  ]);
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
