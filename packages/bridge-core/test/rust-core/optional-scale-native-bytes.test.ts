import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createRustReadonlyDatasetEndpoint, RustSidecarError, type RustSidecarObservation, type RustReadonlyCostObservation } from '../../src/rust-core/readonly-sidecar.js';
import { exactScalePrepareFrame, exactScaleSnapshot, scalePrepareFrame } from '../helpers/optional-scale-fixture.js';

const binary = { path: process.env.MUSIC_BRIDGE_RUST_BINARY ?? '', sha256: process.env.MUSIC_BRIDGE_RUST_SHA256 ?? '' };
assert.equal(binary.sha256, '2feb6d5fbe2d875228c5b0de26f016abe6377aee05a7e48977503ece899f21ef', '015只接受冻结已签资源。');
assert.equal(createHash('sha256').update(readFileSync(binary.path)).digest('hex'), binary.sha256);

for (const delta of [-1, 0, 1]) test(`实际已签 native 合法 prepare 帧 4MiB${delta >= 0 ? '+' : ''}${delta}，已知过界零spawn`, { timeout: 30_000 }, async t => {
  const snapshot = exactScalePrepareFrame(4_194_304 + delta), observations: RustSidecarObservation[] = [], costs: RustReadonlyCostObservation[] = [];
  const endpoint = createRustReadonlyDatasetEndpoint({ binary, snapshot, onObservation: value => observations.push(value), onCostObservation: value => costs.push(value) });
  t.after(() => endpoint.close().catch(() => {}));
  if (delta <= 0) { await endpoint.prepare(); await endpoint.commitBoot(); await endpoint.close(); }
  else {
    await assert.rejects(endpoint.prepare(), error => error instanceof RustSidecarError && error.code === 'CAPACITY_EXCEEDED');
    t.diagnostic(JSON.stringify({ expectedZeroSpawn: true, actualSpawns: observations.filter(value => value.event === 'spawn').length, observations }));
    assert.equal(observations.length, 0); await endpoint.close();
  }
  const exits = observations.filter(value => value.event === 'exit');
  assert.equal(exits.length, delta <= 0 ? 1 : 0);
  assert.ok(exits.every(value => value.event === 'exit' && value.code === 0 && value.signal === null && value.closeAcknowledged && value.pendingRequests === 0));
  const encoded = costs.find(value => value.stage === 'frameEncoding' && value.operation === 'prepare'); assert.ok(encoded?.requestId);
  const frame = JSON.parse(scalePrepareFrame(snapshot).toString()) as Record<string, unknown>; frame.requestId = encoded.requestId;
  const actualEncoded = Buffer.from(JSON.stringify(frame) + '\n');
  t.diagnostic(JSON.stringify({ binarySha256: binary.sha256, snapshotBytes: Buffer.byteLength(JSON.stringify(snapshot)),
    frameBytesWithoutLF: actualEncoded.length - 1, encodedPrepareSha256: createHash('sha256').update(actualEncoded).digest('hex'), wireSent: delta <= 0,
    actualSpawns: observations.filter(value => value.event === 'spawn').length, exits, boundary: delta }));
});

for (const delta of [-1, 0, 1]) test(`可信 v3 对照合法 snapshot 8MiB${delta >= 0 ? '+' : ''}${delta}，保持独立5000/40chunk预算`, { timeout: 30_000 }, async t => {
  const snapshot = exactScaleSnapshot(8_388_608 + delta, 5_000), observations: RustSidecarObservation[] = [];
  if (delta > 0) {
    assert.throws(() => createRustReadonlyDatasetEndpoint({ binary, snapshot, snapshotProfile: 'v3-5000', onObservation: value => observations.push(value) }), error => error instanceof RustSidecarError && error.code === 'CAPACITY_EXCEEDED');
    assert.equal(observations.length, 0); return;
  }
  const endpoint = createRustReadonlyDatasetEndpoint({ binary, snapshot, snapshotProfile: 'v3-5000', onObservation: value => observations.push(value), requestTimeoutMs: 30_000 });
  t.after(() => endpoint.close().catch(() => {}));
  await endpoint.prepare(); await endpoint.commitBoot(); await endpoint.close();
  const chunks = observations.filter(value => value.event === 'request' && value.frame.operation === 'appendSnapshot');
  const lengths = chunks.map(value => value.event === 'request' ? Buffer.byteLength(JSON.stringify(value.frame)) + 1 : 0);
  assert.equal(chunks.length, 40); assert.ok(lengths.every(bytes => bytes - 1 <= 1_048_576));
  assert.ok(lengths.reduce((a, b) => a + b, 0) <= 8_388_608 + 65_536);
  const exits = observations.filter(value => value.event === 'exit'); assert.equal(exits.length, 1);
  assert.ok(exits.every(value => value.event === 'exit' && value.code === 0 && value.signal === null && value.closeAcknowledged && value.pendingRequests === 0));
  t.diagnostic(JSON.stringify({ profile: 'v3-5000', binarySha256: binary.sha256, snapshotBytes: Buffer.byteLength(JSON.stringify(snapshot)),
    chunks: chunks.length, chunkFrameBytesIncludingLF: lengths, uploadBytesIncludingLF: lengths.reduce((a, b) => a + b, 0), exits }));
});
