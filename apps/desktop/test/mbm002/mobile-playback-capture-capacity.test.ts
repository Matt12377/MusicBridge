import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { captureCodecData, type CodecCaptureMetrics } from '../../src/main/mobile-playback-state-codec-protocol.js';
import { MOBILE_PLAYBACK_DEFAULT_LIMITS, MOBILE_PLAYBACK_STATE_LOGICAL_NODE_LIMIT, MobilePlaybackError, type MobilePlaybackStateCodecContext } from '../../../../packages/bridge-core/src/mobile/playback-types.js';
import { capacityHistory, capacityLogicalBoundary, capacityNodes, CAPACITY_SERVER, CAPACITY_DATASET, CAPACITY_ORIGIN } from '../../../../packages/bridge-core/test/mbm002/playback-state-capacity-fixture.js';

const context: MobilePlaybackStateCodecContext = { serverId: CAPACITY_SERVER, datasetId: CAPACITY_DATASET, responseOrigin: CAPACITY_ORIGIN,
  generation: 'capacity.synthetic.generation', revision: 0, commitId: null, limits: MOBILE_PLAYBACK_DEFAULT_LIMITS };
test('Main逻辑复制：近实机1139条与4096条合成历史逐引用计费，诊断标明新逻辑上限', t => {
  for (const options of [{}, { sessions: 1, resources: 1, receipts: 4096, formats: 20, errors: true }]) {
    const state = capacityHistory(options), observations: CodecCaptureMetrics[] = [], started = performance.now();
    const copy = captureCodecData(state, context, row => observations.push(row));
    const captureMs = Math.round(performance.now() - started), metrics = observations.at(-1)!;
    assert.equal(metrics.reason, 'accepted'); assert.equal(metrics.nodeLimit, 1_000_000); assert.equal(metrics.nodes, capacityNodes(state));
    assert.deepEqual(JSON.parse(JSON.stringify(copy)), state); assert.notEqual(copy, state);
    assert.equal(metrics.byteLimit, 35_651_584); assert.equal(metrics.depthLimit, 24);
    t.diagnostic(JSON.stringify({ synthetic: true, receipts: state.receipts.length, logicalNodes: metrics.nodes, logicalBytes: metrics.bytes, captureMs }));
  }
});
test('Main逻辑复制：999730节点可复制，共享对象再次引用后超过1m仍按每次引用拒绝', t => {
  const { inside, next } = capacityLogicalBoundary(), observations: CodecCaptureMetrics[] = [], started = performance.now();
  captureCodecData(inside, context, row => observations.push(row));
  const captureMs = Math.round(performance.now() - started);
  assert.equal(observations.at(-1)?.nodes, capacityNodes(inside));
  assert.equal(observations.at(-1)?.nodeLimit, MOBILE_PLAYBACK_STATE_LOGICAL_NODE_LIMIT);
  // 故意复用原对象；不能通过指针相等或缓存跳过累计节点及字节。
  next.request.body = inside.receipts[1]!.request.body;
  next.resourceContext = inside.receipts[1]!.resourceContext;
  inside.receipts.push(next); inside.revision++;
  assert.ok(capacityNodes(inside) > MOBILE_PLAYBACK_STATE_LOGICAL_NODE_LIMIT);
  assert.throws(() => captureCodecData(inside, context, row => observations.push(row)), error => error instanceof MobilePlaybackError && error.code === 'RESOURCE_BUSY');
  assert.ok(['nodes', 'keys'].includes(observations.at(-1)!.reason));
  assert.equal(inside.receipts.at(-1)!.request.body, inside.receipts[1]!.request.body);
  t.diagnostic(JSON.stringify({ synthetic: true, insideNodes: observations[0]!.nodes, captureMs, outsideNodes: capacityNodes(inside), reason: observations.at(-1)!.reason }));
});
