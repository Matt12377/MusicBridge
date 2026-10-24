import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createMobilePlaybackStateCodec } from '../../src/main/mobile-playback-state-codec-client.js';
import { MOBILE_PLAYBACK_DEFAULT_LIMITS as limits, MobilePlaybackError, type MobilePlaybackStateCodecContext } from '../../../../packages/bridge-core/src/mobile/playback-types.js';
import { capacityHistory, capacityLogicalBoundary, CAPACITY_SERVER as serverId, CAPACITY_DATASET as datasetId, CAPACITY_ORIGIN as responseOrigin } from '../../../../packages/bridge-core/test/mbm002/playback-state-capacity-fixture.js';

test('真实Worker同次Stats：默认512MiB保留8 UNKNOWN和1m近界逐引用计费，畸形字符串仍BUSY且线程继续', { timeout: 90_000 }, async t => {
  const entry = process.env.MUSIC_BRIDGE_PLAYBACK_CODEC_TEST_ENTRY;
  assert.ok(entry?.startsWith('/Volumes/LifeWeave/'), '必须采用Root编译的真实生产入口');
  const port = createMobilePlaybackStateCodec({ workerUrl: pathToFileURL(entry!) }); t.after(() => port.close());
  const context = (state: ReturnType<typeof capacityHistory>): MobilePlaybackStateCodecContext => ({ serverId, datasetId, responseOrigin,
    generation: 'stats.synthetic.generation', revision: state.revision, commitId: state.commitId, limits });
  const unknown = capacityHistory();
  for (const row of unknown.receipts.filter(row => row.operation === 'createResource').slice(0, 8)) {
    row.state = 'UNKNOWN'; row.reply = null; row.resourceContext = null;
  }
  const boundary = capacityLogicalBoundary();
  // 相同完整正文共享对象只改变输入别名，不减少逻辑逐次计费或已存回执内容。
  for (const row of boundary.inside.receipts) if (row.operation === 'createResource') row.request.body = boundary.inside.resources[0]!.request;
  for (const state of [unknown, boundary.inside]) {
    const encoded = await port.encode(state, context(state));
    assert.deepEqual(encoded.state, state); assert.ok(encoded.bytes.length <= 2 * 1024 * 1024);
    assert.deepEqual((await port.decode(encoded.bytes, context(state))).state, state); encoded.bytes.fill(0);
  }
  boundary.inside.receipts.push(boundary.next); boundary.inside.revision++;
  await assert.rejects(port.encode(boundary.inside, context(boundary.inside)), error => error instanceof MobilePlaybackError && error.code === 'RESOURCE_BUSY');
  const malformed = capacityHistory(), row = malformed.receipts.at(-1)!;
  row.request.idempotencyKey = '\ud800';
  row.keyHash = createHash('sha256').update(JSON.stringify(['MBM002_PLAYBACK_V1', serverId, datasetId, 'key', [row.deviceId, row.deviceEpoch, row.request.idempotencyKey]])).digest('hex');
  await assert.rejects(port.encode(malformed, context(malformed)), error => error instanceof MobilePlaybackError && error.status === 503 && error.code === 'BUSY');
  const good = capacityHistory({ sessions: 1, resources: 1, receipts: 2 }), final = await port.encode(good, context(good));
  assert.deepEqual(final.state, good); final.bytes.fill(0);
});
