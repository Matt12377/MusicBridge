import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { capturePlaybackState } from '../../src/mobile/playback-state.js';
import { encodePlaybackStorage, decodePlaybackStorage } from '../../src/mobile/playback-state-codec.js';
import { MOBILE_PLAYBACK_DEFAULT_LIMITS as limits, MobilePlaybackError } from '../../src/mobile/playback-types.js';
import { capacityHistory, capacityDigest, CAPACITY_SERVER as SERVER, CAPACITY_DATASET as DATASET, CAPACITY_ORIGIN as ORIGIN } from './playback-state-capacity-fixture.js';

// 修改前Mac23纯合成原新对比profile独立录得；提交身份、原键、全部历史、format及canonical字节都固定。
const goldens = [
  ['33d4699d816f4317da96d51b18066d64913ac3f9140c449c60a95760233d20ac', '225267489eeb80ecc992edff90d748ffb7715f7fb116c6fcfa13c8f95d1e286f', '1d7d61ca9c2f0da489849d107a533c7983e4732abd67e275d2dd8cc9c890e520'],
  ['217482f363ec54f044ffe6658f3beb2df115ddacaefc2f701e6af2fc30517ff4', 'c33e961ec2d606f9538d3cfd326684367f624df0892f24ba838fd02e33e1a119', '929782c4dfa0dd0d579a5da60691b2104b95947098cfbb898ffab2e6e3eb1cf9'],
] as const;
test('同次Stats复用：1139逐次新增及8 UNKNOWN的原format/字节黄金保持，完整历史往返', { timeout: 60_000 }, () => {
  for (const unknowns of [0, 8]) for (const round of [1, 2, 3]) {
    const state = capacityHistory({ receipts: 1139 + round }); state.commitId = `stats.synthetic.${unknowns}.${round}`;
    for (const row of state.receipts.filter(row => row.operation === 'createResource').slice(0, unknowns)) {
      row.state = 'UNKNOWN'; row.reply = null; row.resourceContext = null;
    }
    const encoded = encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, limits);
    assert.equal(encoded.format, 'v3');
    assert.equal(createHash('sha256').update(encoded.bytes).digest('hex'), goldens[unknowns ? 1 : 0][round - 1]);
    assert.deepEqual(encoded.state, state);
    assert.deepEqual(decodePlaybackStorage(encoded.bytes, SERVER, DATASET, ORIGIN, limits).state, state);
  }
});

test('同次Stats复用：未配对代理字符保留原BUSY优先级，不能被v2预算预判跳过或由v1输出', { timeout: 60_000 }, () => {
  for (const receipts of [2, 64, 1139]) {
    const state = receipts === 1139 ? capacityHistory() : capacityHistory({ sessions: 1, resources: 1, receipts });
    const row = state.receipts.at(-1)!;
    row.request.idempotencyKey = '\ud800';
    // 故意构造畸形键的数学摘要；原playbackCanonical自身会拒绝该文本，不能用夹具摘要器生成。
    row.keyHash = createHash('sha256').update(JSON.stringify(['MBM002_PLAYBACK_V1', SERVER, DATASET, 'key', [row.deviceId, row.deviceEpoch, row.request.idempotencyKey]])).digest('hex');
    const selected = receipts === 2 ? { ...limits, stateBytes: Buffer.byteLength(JSON.stringify(state)) } : limits;
    for (let attempt = 0; attempt < 2; attempt++) assert.throws(() => encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, selected),
      error => error instanceof MobilePlaybackError && error.status === 503 && error.code === 'BUSY');
    row.request.idempotencyKey = '合法.词🎵'; row.keyHash = capacityDigest('key', [row.deviceId, row.deviceEpoch, row.request.idempotencyKey]);
    capturePlaybackState(state, SERVER, DATASET, ORIGIN, limits);
    const valid = encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, limits);
    assert.deepEqual(decodePlaybackStorage(valid.bytes, SERVER, DATASET, ORIGIN, limits).state, state);
  }
});
