import assert from 'node:assert/strict';
import test from 'node:test';
import { BridgeError } from '../src/shared/errors.js';
import {
  assertSafeAudioUrl,
  enforceNeteaseSafetyEnvironment,
  normalizeTrackId,
  resolveNeteaseAudioUrl,
  parseQuality,
} from '../src/netease/policy.js';

test('safety environment forces all unblock-related flags to false', () => {
  const env: NodeJS.ProcessEnv = {};
  enforceNeteaseSafetyEnvironment(env);
  assert.equal(env.ENABLE_GENERAL_UNBLOCK, 'false');
  assert.equal(env.ENABLE_PROXY, 'false');
  assert.equal(env.ENABLE_RANDOM_CN_IP, 'false');
});

test('safety environment rejects any enabled unblock-related flag', () => {
  const env: NodeJS.ProcessEnv = { ENABLE_GENERAL_UNBLOCK: 'true' };
  assert.throws(
    () => enforceNeteaseSafetyEnvironment(env),
    (error: unknown) =>
      error instanceof BridgeError && error.code === 'CONFIG_INVALID',
  );
});

test('quality and track IDs are strictly validated', () => {
  assert.equal(parseQuality('lossless'), 'lossless');
  assert.equal(normalizeTrackId(347230), '347230');
  assert.throws(() => parseQuality('jymaster'));
  assert.throws(() => normalizeTrackId('abc'));
});

test('audio URL policy permits public HTTPS and rejects local/private URLs', () => {
  assert.equal(
    assertSafeAudioUrl('https://example.com/audio.flac?x=1'),
    'https://example.com/audio.flac?x=1',
  );
  assert.throws(() => assertSafeAudioUrl('http://example.com/audio.mp3'));
  assert.throws(() => assertSafeAudioUrl('https://127.0.0.1/audio.mp3'));
  assert.throws(() => assertSafeAudioUrl('https://192.168.1.5/audio.mp3'));
});

test('native HTTPS audio URLs remain unchanged and are marked native', () => {
  assert.deepEqual(
    resolveNeteaseAudioUrl('https://cdn.example/audio.flac?fixture=1'),
    {
      upstreamUrl: 'https://cdn.example/audio.flac?fixture=1',
      transportSecurity: 'https-native',
    },
  );
});

test('NetEase CDN HTTP URLs upgrade to HTTPS while preserving path and query', () => {
  assert.deepEqual(
    resolveNeteaseAudioUrl(
      'http://m1.music.126.net/audio/path.flac?auth=fixture&range=1',
    ),
    {
      upstreamUrl:
        'https://m1.music.126.net/audio/path.flac?auth=fixture&range=1',
      transportSecurity: 'https-upgraded',
    },
  );
});

test('NetEase CDN HTTP port 80 is removed during HTTPS upgrade', () => {
  assert.equal(
    resolveNeteaseAudioUrl('http://m1.music.126.net:80/audio.mp3').upstreamUrl,
    'https://m1.music.126.net/audio.mp3',
  );
});

test('HTTP upgrade rejects non-standard ports', () => {
  assert.throws(
    () => resolveNeteaseAudioUrl('http://m1.music.126.net:8080/audio.mp3'),
    (error: unknown) =>
      error instanceof BridgeError && error.code === 'UNSAFE_UPSTREAM',
  );
});

test('HTTP upgrade rejects userinfo and fragments', () => {
  assert.throws(
    () => resolveNeteaseAudioUrl('http://user:pass@m1.music.126.net/audio.mp3'),
    (error: unknown) =>
      error instanceof BridgeError && error.code === 'UNSAFE_UPSTREAM',
  );
  assert.throws(
    () => resolveNeteaseAudioUrl('http://m1.music.126.net/audio.mp3#fragment'),
    (error: unknown) =>
      error instanceof BridgeError && error.code === 'UNSAFE_UPSTREAM',
  );
  assert.throws(
    () => resolveNeteaseAudioUrl('http://:@m1.music.126.net/audio.mp3'),
    (error: unknown) =>
      error instanceof BridgeError && error.code === 'UNSAFE_UPSTREAM',
  );
  assert.throws(
    () => resolveNeteaseAudioUrl('http://m1.music.126.net/audio.mp3#'),
    (error: unknown) =>
      error instanceof BridgeError && error.code === 'UNSAFE_UPSTREAM',
  );
});

test('HTTP upgrade rejects non-NetEase hosts and IP literals', () => {
  assert.throws(
    () => resolveNeteaseAudioUrl('http://cdn.example/audio.mp3'),
    (error: unknown) =>
      error instanceof BridgeError && error.code === 'UNSAFE_UPSTREAM',
  );
  assert.throws(
    () => resolveNeteaseAudioUrl('http://192.0.2.1/audio.mp3'),
    (error: unknown) =>
      error instanceof BridgeError && error.code === 'UNSAFE_UPSTREAM',
  );
  assert.throws(
    () => resolveNeteaseAudioUrl('http://[2001:db8::1]/audio.mp3'),
    (error: unknown) =>
      error instanceof BridgeError && error.code === 'UNSAFE_UPSTREAM',
  );
});
