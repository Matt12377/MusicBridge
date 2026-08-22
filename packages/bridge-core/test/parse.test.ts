import assert from 'node:assert/strict';
import test from 'node:test';
import { BridgeError } from '../src/shared/errors.js';
import {
  parseDailyRecommendations,
  parseLoginStatusResponse,
  parsePublicAccountProfile,
  parseQrCheckResponse,
  parseQrImageResponse,
  parseQrKeyResponse,
  parseResolvedAudioStream,
  parseTrackMetadata,
} from '../src/netease/parse.js';

test('parses QR login responses into bounded internal values', () => {
  assert.equal(
    parseQrKeyResponse({ body: { code: 200, data: { unikey: 'provider-key' } } }),
    'provider-key',
  );
  assert.equal(
    parseQrImageResponse({
      body: { code: 200, data: { qrimg: 'data:image/png;base64,synthetic-qr' } },
    }),
    'data:image/png;base64,synthetic-qr',
  );
  assert.deepEqual(
    parseQrCheckResponse({ body: { code: 803, cookie: 'fixture-credential' } }),
    { code: 803, credential: 'fixture-credential' },
  );
  assert.deepEqual(
    parseQrCheckResponse({ body: { code: 801, message: 'waiting' } }),
    { code: 801 },
  );
  assert.equal(
    parseLoginStatusResponse({ body: { code: 200, data: { profile: { userId: 1 } } } }),
    true,
  );
  assert.equal(parseLoginStatusResponse({ body: { code: 200, data: {} } }), false);
});

test('parses the real login_status response wrapper from API 4.40.1', () => {
  assert.equal(
    parseLoginStatusResponse({
      body: {
        data: {
          code: 200,
          profile: { userId: 1 },
          account: { id: 1 },
        },
      },
    }),
    true,
  );
  assert.equal(
    parseLoginStatusResponse({
      body: {
        data: {
          code: 200,
          account: { id: 1 },
        },
      },
    }),
    true,
  );
  assert.equal(
    parseLoginStatusResponse({
      body: {
        data: {
          code: 401,
          profile: { userId: 1 },
        },
      },
    }),
    false,
  );
  assert.equal(
    parseLoginStatusResponse({
      body: {
        data: {
          code: 200,
        },
      },
    }),
    false,
  );
  assert.equal(
    parseLoginStatusResponse({
      body: {
        code: 200,
        profile: { userId: 1 },
        account: { id: 1 },
      },
    }),
    true,
  );
  assert.equal(
    parseLoginStatusResponse({
      body: {
        code: 200,
        data: {
          profile: { userId: 1 },
        },
      },
    }),
    true,
  );
  assert.equal(parseLoginStatusResponse({}), false);
});

test('parses defensive song metadata shape', () => {
  const result = parseTrackMetadata(
    {
      body: {
        code: 200,
        songs: [
          {
            id: 123,
            name: 'Test Song',
            ar: [{ name: 'Artist A' }, { name: 'Artist B' }],
            al: { name: 'Album', picUrl: 'https://p3.music.126.net/cover.jpg' },
            dt: 240000,
          },
        ],
      },
    },
    '123',
  );

  assert.deepEqual(result, {
    id: '123',
    title: 'Test Song',
    artists: ['Artist A', 'Artist B'],
    album: 'Album',
    durationMs: 240000,
    artworkUrl: 'https://p3.music.126.net/cover.jpg',
  });
});

test('parses public account profile from both supported provider wrappers', () => {
  assert.deepEqual(
    parsePublicAccountProfile({
      body: {
        code: 200,
        profile: {
          nickname: 'Synthetic Listener',
          avatarUrl: 'https://p1.music.126.net/avatar.jpg',
          userId: 991,
        },
      },
    }),
    {
      displayName: 'Synthetic Listener',
      avatarUrl: 'https://p1.music.126.net/avatar.jpg',
    },
  );
  assert.deepEqual(
    parsePublicAccountProfile({
      body: {
        data: {
          code: 200,
          profile: { nickname: 'Nested Listener', avatarUrl: 'https://p2.music.126.net/avatar.jpg' },
        },
      },
    }),
    {
      displayName: 'Nested Listener',
      avatarUrl: 'https://p2.music.126.net/avatar.jpg',
    },
  );
});

test('rejects unavailable or unsafe public account profiles without exposing private fields', () => {
  assert.throws(
    () => parsePublicAccountProfile({ body: { code: 200, profile: { userId: 991 } } }),
    (error: unknown) => error instanceof BridgeError && error.code === 'ACCOUNT_PROFILE_UNAVAILABLE',
  );
  assert.throws(
    () => parsePublicAccountProfile({ body: { code: 200, profile: { nickname: 'x'.repeat(81) } } }),
    (error: unknown) => error instanceof BridgeError && error.code === 'ACCOUNT_PROFILE_UNAVAILABLE',
  );
  const result = parsePublicAccountProfile({
    body: {
      code: 200,
      profile: { nickname: 'Safe Listener', avatarUrl: 'https://example.invalid/avatar.jpg' },
    },
  });
  assert.deepEqual(result, { displayName: 'Safe Listener' });
});

test('parses the daily recommendation response wrapper, merges reasons, deduplicates and caps at 50', () => {
  const songs = Array.from({ length: 52 }, (_, index) => ({
    id: index + 1,
    name: `Recommended ${index + 1}`,
    ar: [{ name: 'Synthetic Artist' }],
    al: { name: 'Synthetic Album', picUrl: 'https://p1.music.126.net/recommend.jpg' },
    dt: 180_000,
  }));
  const snapshot = parseDailyRecommendations(
    {
      body: {
        code: 200,
        dailySongs: [songs[0], songs[1], songs[1], ...songs.slice(2)],
        recommendReasons: [
          { songId: 1, reason: '根据你的收藏推荐' },
          { songId: '2', reason: '适合今天的播放氛围' },
        ],
      },
    },
    '2026-08-22',
  );
  assert.equal(snapshot.dayKey, '2026-08-22');
  assert.equal(snapshot.tracks.length, 50);
  assert.equal(snapshot.tracks[0]?.recommendationReason, '根据你的收藏推荐');
  assert.equal(snapshot.tracks[1]?.recommendationReason, '适合今天的播放氛围');
  assert.equal(new Set(snapshot.tracks.map((track) => track.id)).size, 50);
  assert.equal(snapshot.tracks[0]?.artworkUrl, 'https://p1.music.126.net/recommend.jpg');
});

test('parses empty and nested daily recommendation data while filtering malformed tracks', () => {
  assert.deepEqual(
    parseDailyRecommendations({ body: { code: 200, data: { dailySongs: [] } } }, '2026-08-22'),
    { dayKey: '2026-08-22', tracks: [] },
  );
  const snapshot = parseDailyRecommendations(
    {
      body: {
        data: {
          code: 200,
          dailySongs: [
            { id: 0, name: 'invalid' },
            { id: 21, name: 'Valid', ar: [{ name: 'Artist' }], al: { name: 'Album' } },
          ],
        },
      },
    },
    '2026-08-22',
  );
  assert.deepEqual(snapshot.tracks.map((track) => track.id), ['21']);
});

test('drops non-NetEase artwork URLs instead of exposing arbitrary upstream metadata', () => {
  const result = parseTrackMetadata(
    {
      body: {
        code: 200,
        songs: [{ id: 123, name: 'Test Song', al: { name: 'Album', picUrl: 'https://img.example/cover.jpg' } }],
      },
    },
    '123',
  );

  assert.equal(result.artworkUrl, undefined);
});

test('maps nested provider session expiration to AUTH_EXPIRED for metadata', () => {
  assert.throws(
    () => parseTrackMetadata({ body: { data: { code: 301 } } }, '123'),
    (error: unknown) => error instanceof BridgeError && error.code === 'AUTH_EXPIRED',
  );
});

test('parses actual stream quality instead of assuming requested quality', () => {
  const result = parseResolvedAudioStream(
    {
      body: {
        code: 200,
        data: [
          {
            id: 123,
            code: 200,
            url: 'https://cdn.example/audio.flac',
            level: 'exhigh',
            type: 'mp3',
            br: 320000,
            size: 123456,
            expi: 1200,
            freeTrialInfo: null,
          },
        ],
      },
    },
    '123',
    'lossless',
  );

  assert.equal(result.requestedQuality, 'lossless');
  assert.equal(result.actualQuality, 'exhigh');
  assert.equal(result.format, 'mp3');
  assert.equal(result.bitrate, 320000);
  assert.equal(result.transportSecurity, 'https-native');
});

test('parses a full NetEase HTTP stream as an HTTPS-upgraded stream', () => {
  const result = parseResolvedAudioStream(
    {
      body: {
        code: 200,
        data: [
          {
            id: 123,
            code: 200,
            url: 'http://m2.music.126.net/audio.flac?fixture=1',
            level: 'exhigh',
            freeTrialInfo: null,
          },
        ],
      },
    },
    '123',
    'exhigh',
  );

  assert.equal(
    result.upstreamUrl,
    'https://m2.music.126.net/audio.flac?fixture=1',
  );
  assert.equal(result.transportSecurity, 'https-upgraded');
});

test('rejects preview/trial streams', () => {
  assert.throws(
    () =>
      parseResolvedAudioStream(
        {
          body: {
            code: 200,
            data: [
              {
                id: 123,
                code: 200,
                url: 'https://cdn.example/preview.mp3',
                freeTrialInfo: { start: 0, end: 30 },
              },
            ],
          },
        },
        '123',
        'standard',
      ),
    (error: unknown) =>
      error instanceof BridgeError && error.code === 'TRACK_PREVIEW_ONLY',
  );
});

test('rejects preview streams before attempting HTTP URL upgrade', () => {
  assert.throws(
    () =>
      parseResolvedAudioStream(
        {
          body: {
            code: 200,
            data: [
              {
                id: 123,
                code: 200,
                url: 'http://m1.music.126.net/preview.mp3',
                freeTrialInfo: { start: 0, end: 30 },
              },
            ],
          },
        },
        '123',
        'standard',
      ),
    (error: unknown) =>
      error instanceof BridgeError && error.code === 'TRACK_PREVIEW_ONLY',
  );
});

test('rejects unavailable streams', () => {
  assert.throws(
    () =>
      parseResolvedAudioStream(
        {
          body: {
            code: 200,
            data: [{ id: 123, code: 404, url: null, freeTrialInfo: null }],
          },
        },
        '123',
        'lossless',
      ),
    (error: unknown) =>
      error instanceof BridgeError && error.code === 'TRACK_UNAVAILABLE',
  );
});
