import assert from 'node:assert/strict';
import test from 'node:test';
import { captureCodecData, type CodecCaptureMetrics } from '../../src/main/mobile-playback-state-codec-protocol.js';
import { MOBILE_PLAYBACK_DEFAULT_LIMITS, MOBILE_PLAYBACK_STATE_LOGICAL_NODE_LIMIT, MobilePlaybackError, type MobilePlaybackStateCodecContext } from '../../../../packages/bridge-core/src/mobile/playback-types.js';
const context: MobilePlaybackStateCodecContext = { serverId: 'synthetic', datasetId: 'synthetic', responseOrigin: 'https://127.0.0.1:9443', generation: 'test', revision: 0, commitId: null, limits: MOBILE_PLAYBACK_DEFAULT_LIMITS };
const root = () => ({ schema: 'synthetic-secret', serverId: 'synthetic', datasetId: 'synthetic', revision: 0, commitId: null, clockFloor: 0, sessions: [], resources: [], receipts: [] as unknown[] });
test('容量旁注只报告闭集计数，拒绝不改变原始错误或输入', () => {
  const rows: CodecCaptureMetrics[] = [], raw = root();
  captureCodecData(raw, context, row => rows.push(row));
  assert.equal(rows[0]?.reason, 'accepted'); assert.equal(rows[0]?.receipts, 0);
  assert.equal(JSON.stringify(rows).includes('synthetic'), false);
  assert.deepEqual(Object.keys(rows[0]!).sort(), ['reason','nodes','bytes','depth','sessions','resources','receipts','nodeLimit','byteLimit','depthLimit'].sort());
  const nested = root(); let item: unknown = 'payload-secret'; for (let i = 0; i < 25; i++) item = { item }; nested.receipts.push(item);
  assert.throws(() => captureCodecData(nested, context, row => rows.push(row)), (e: unknown) => e instanceof MobilePlaybackError && e.status === 429 && e.code === 'RESOURCE_BUSY');
  assert.equal(rows.at(-1)?.reason, 'depth'); assert.equal(rows.at(-1)?.depth, 25);
  assert.equal(JSON.stringify(rows).includes('payload'), false);
  assert.equal(nested.receipts[0], item);
});
test('超节点与超字节可区分，诊断回调异常不改变准入', () => {
  const rows: CodecCaptureMetrics[] = [], many = root(); many.receipts.push(new Array(MOBILE_PLAYBACK_STATE_LOGICAL_NODE_LIMIT + 1).fill(null));
  assert.throws(() => captureCodecData(many, context, row => rows.push(row)), (e: unknown) => e instanceof MobilePlaybackError && e.status === 429);
  assert.ok(['keys','nodes'].includes(rows.at(-1)!.reason));
  const large = root(); large.receipts.push(['x'.repeat(5_000), 'y'.repeat(5_000)]);
  assert.throws(() => captureCodecData(large, {...context, limits: {...context.limits, stateBytes: 1024, maxReceipts: 1}}, row => rows.push(row)), (e: unknown) => e instanceof MobilePlaybackError && e.status === 429);
  assert.equal(rows.at(-1)?.reason, 'bytes');
  assert.doesNotThrow(() => captureCodecData(root(), context, () => { throw Error('诊断异常'); }));
});
