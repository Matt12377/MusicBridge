import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { createMobilePlaybackStateCodec } from '../../src/main/mobile-playback-state-codec-client.js';
import { MOBILE_PLAYBACK_DEFAULT_LIMITS, MobilePlaybackError, type MobilePlaybackStateCodecContext } from '../../../../packages/bridge-core/src/mobile/playback-types.js';
import { capacityHistory, capacityLogicalBoundary, capacityNodes, CAPACITY_SERVER, CAPACITY_DATASET, CAPACITY_ORIGIN } from '../../../../packages/bridge-core/test/mbm002/playback-state-capacity-fixture.js';

test('真实Worker容量：1139历史、4096回执及近1m节点在原512MiB和超时内往返，超限仍拒绝', { timeout: 90_000 }, async t => {
  const file = process.env.MUSIC_BRIDGE_PLAYBACK_CODEC_TEST_ENTRY;
  assert.ok(typeof file === 'string' && file.startsWith('/Volumes/LifeWeave/'), '必须使用Root整包编译后的真实生产Worker入口');
  const port = createMobilePlaybackStateCodec({ workerUrl: pathToFileURL(file) }); t.after(() => port.close());
  const context = (state: ReturnType<typeof capacityHistory>): MobilePlaybackStateCodecContext => ({ serverId: CAPACITY_SERVER,
    datasetId: CAPACITY_DATASET, responseOrigin: CAPACITY_ORIGIN, generation: 'capacity.synthetic.generation', revision: state.revision,
    commitId: state.commitId, limits: MOBILE_PLAYBACK_DEFAULT_LIMITS });
  const boundary = capacityLogicalBoundary();
  for (const state of [capacityHistory(), capacityHistory({ sessions: 1, resources: 1, receipts: 4096, formats: 20, errors: true }), boundary.inside]) {
    const started = performance.now(), encoded = await port.encode(state, context(state)), encodeMs = Math.round(performance.now() - started);
    assert.deepEqual(encoded.state, state); assert.ok(encoded.bytes.length <= 2 * 1024 * 1024);
    const physicalNodes = capacityNodes(JSON.parse(encoded.canonical)); assert.ok(physicalNodes <= 200_000);
    const decoding = performance.now(), decoded = await port.decode(encoded.bytes, context(state));
    assert.deepEqual(decoded.state, state);
    t.diagnostic(JSON.stringify({ synthetic: true, receipts: state.receipts.length, logicalNodes: capacityNodes(state), physicalNodes,
      physicalBytes: encoded.bytes.length, encodeMs, decodeMs: Math.round(performance.now() - decoding) }));
    encoded.bytes.fill(0);
  }
  boundary.inside.receipts.push(boundary.next); boundary.inside.revision++;
  await assert.rejects(port.encode(boundary.inside, context(boundary.inside)), error => error instanceof MobilePlaybackError && error.code === 'RESOURCE_BUSY');
});
