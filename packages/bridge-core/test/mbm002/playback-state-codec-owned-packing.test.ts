import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { encodePlaybackStorage, decodePlaybackStorage } from '../../src/mobile/playback-state-codec.js';
import { capturePlaybackState } from '../../src/mobile/playback-state.js';
import { MOBILE_PLAYBACK_DEFAULT_LIMITS as limits, MobilePlaybackError } from '../../src/mobile/playback-types.js';
import { capacityHistory, capacityNodes, CAPACITY_SERVER as SERVER, CAPACITY_DATASET as DATASET, CAPACITY_ORIGIN as ORIGIN } from './playback-state-capacity-fixture.js';

// 完全合成；黄金来自修改前Mac40真实production actor/Worker，不读取真实账本。
function physicalHistory() {
  const state = capacityHistory({ sessions: 52, resources: 588, receipts: 1415 });
  for (const resource of state.resources) resource.source!.processing.reason = '合成原字节'.repeat(10);
  for (const receipt of state.receipts) if (receipt.reply && receipt.reply.status < 400 && receipt.operation !== 'createSession')
    (receipt.reply.body as { processing: { reason: string } }).processing.reason = '合成原字节'.repeat(10);
  return capturePlaybackState(state, SERVER, DATASET, ORIGIN, limits);
}

test('自产packing：全部历史与Mac40 canonical黄金相同，v5原物理预算内完整往返', { timeout: 60_000 }, () => {
  const state = physicalHistory(), encoded = encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, limits);
  assert.equal(encoded.format, 'v5'); assert.equal(encoded.bytes.byteLength, 1_461_387);
  assert.equal(createHash('sha256').update(encoded.bytes).digest('hex'), 'ca87ecfbf434752b531a56839703a36b11b7bd65258d49317f5ad2f344fbf7fb');
  assert.equal(encoded.canonical, Buffer.from(encoded.bytes).toString('utf8'));
  assert.ok(capacityNodes(JSON.parse(encoded.canonical)) <= 200_000);
  assert.deepEqual(encoded.state, state);
  assert.deepEqual(decodePlaybackStorage(encoded.bytes, SERVER, DATASET, ORIGIN, limits).state, state);
  const exact = { ...limits, stateBytes: encoded.bytes.byteLength };
  assert.equal(encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, exact).canonical, encoded.canonical);
  // 旧v5少1B已不足，但新显式v6可保真回退；原v5黄金与预算不变。
  const fallback = encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, { ...exact, stateBytes: exact.stateBytes - 1 });
  assert.equal(fallback.format, 'v6');
  assert.deepEqual(decodePlaybackStorage(fallback.bytes, SERVER, DATASET, ORIGIN, { ...exact, stateBytes: exact.stateBytes - 1 }).state, state);
  const compact = { ...limits, stateBytes: fallback.bytes.byteLength };
  assert.equal(encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, compact).canonical, fallback.canonical);
  assert.throws(() => encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, { ...compact, stateBytes: compact.stateBytes - 1 }),
    error => error instanceof MobilePlaybackError && error.code === 'RESOURCE_BUSY' && error.status === 429);
});

test('自产packing：UTF8及JSON转义逐字节计费，~原样还原，真实文本变更不可复用旧结果', { timeout: 60_000 }, () => {
  const state = capacityHistory();
  for (const reason of ['汉字🎵与"引号"和反斜线\\'.repeat(3), '~0000', '新内容\n\t不同']) {
    for (const resource of state.resources) resource.source!.processing.reason = reason;
    for (const receipt of state.receipts) if (receipt.reply && receipt.reply.status < 400 && receipt.operation !== 'createSession')
      (receipt.reply.body as { processing: { reason: string } }).processing.reason = reason;
    const encoded = encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, limits);
    assert.equal(Buffer.byteLength(encoded.canonical), encoded.bytes.byteLength);
    assert.ok(encoded.bytes.byteLength <= limits.stateBytes);
    assert.deepEqual(decodePlaybackStorage(encoded.bytes, SERVER, DATASET, ORIGIN, limits).state, state);
  }
});

test('自产packing：外来getter/Proxy和畸形Unicode仍经原完整入口拒绝，不执行getter', { timeout: 60_000 }, () => {
  const state = physicalHistory(); let getterCalls = 0;
  Object.defineProperty(state.resources[0]!.source!.processing, 'reason', { enumerable: true, get() { getterCalls++; return '禁止执行'; } });
  const rejects = (raw: unknown) => assert.throws(() => encodePlaybackStorage(raw, SERVER, DATASET, ORIGIN, limits),
    error => error instanceof MobilePlaybackError && error.status === 503 && error.code === 'BUSY');
  rejects(state); assert.equal(getterCalls, 0);
  const proxy = physicalHistory(); proxy.resources[0] = new Proxy(proxy.resources[0]!, {}); rejects(proxy);
  const unicode = physicalHistory(); unicode.resources[0]!.source!.processing.reason = '\ud800'; rejects(unicode);
});
