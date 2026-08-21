import assert from 'node:assert/strict';
import test from 'node:test';
import { BridgeError } from '../src/shared/errors.js';
import {
  parseLoginStatusResponse,
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
            al: { name: 'Album', picUrl: 'https://img.example/cover.jpg' },
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
    artworkUrl: 'https://img.example/cover.jpg',
  });
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
