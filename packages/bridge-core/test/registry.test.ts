import assert from 'node:assert/strict';
import test from 'node:test';
import { BridgeError } from '../src/shared/errors.js';
import { StreamRegistry } from '../src/stream/registry.js';

const metadata = {
  id: '1',
  title: 'Track',
  artists: ['Artist'],
  album: 'Album',
};

test('stream tokens are high entropy, retrievable and revocable', () => {
  const registry = new StreamRegistry();
  const one = registry.register({
    metadata,
    requestedQuality: 'lossless',
    resolve: async () => ({
      trackId: '1',
      upstreamUrl: 'https://example.com/a.flac',
      requestedQuality: 'lossless',
      actualQuality: 'lossless',
    }),
  });
  const two = registry.register({
    metadata,
    requestedQuality: 'lossless',
    resolve: one.resolve,
  });

  assert.notEqual(one.token, two.token);
  assert.ok(one.token.length >= 40);
  assert.equal(registry.get(one.token).metadata.id, '1');
  registry.revoke(one.token);
  assert.throws(
    () => registry.get(one.token),
    (error: unknown) =>
      error instanceof BridgeError && error.code === 'STREAM_NOT_FOUND',
  );
});

test('expired tokens are removed', () => {
  let now = 1000;
  const registry = new StreamRegistry({ now: () => now, defaultTtlMs: 100 });
  const registration = registry.register({
    metadata,
    requestedQuality: 'standard',
    resolve: async () => ({
      trackId: '1',
      upstreamUrl: 'https://example.com/a.mp3',
      requestedQuality: 'standard',
      actualQuality: 'standard',
    }),
  });
  now = 1200;
  assert.throws(() => registry.get(registration.token));
  assert.equal(registry.size, 0);
});
