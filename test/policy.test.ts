import assert from 'node:assert/strict';
import test from 'node:test';
import { BridgeError } from '../src/shared/errors.js';
import {
  assertSafeAudioUrl,
  enforceNeteaseSafetyEnvironment,
  normalizeTrackId,
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
