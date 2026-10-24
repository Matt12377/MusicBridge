import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { createPlaybackStorageActor, decodePlaybackStorage, encodePlaybackStorage, readPlaybackStorageRejectionBoundary } from '../../src/mobile/playback-state-codec.js';
import { createMobileAuthCrypto } from '../../src/mobile/auth-crypto.js';
import { capturePlaybackState, type PlaybackState } from '../../src/mobile/playback-state.js';
import { MOBILE_PLAYBACK_DEFAULT_LIMITS as limits, MobilePlaybackError } from '../../src/mobile/playback-types.js';
import { capacityHistory, capacityNodes, CAPACITY_SERVER as SERVER, CAPACITY_DATASET as DATASET, CAPACITY_ORIGIN as ORIGIN } from './playback-state-capacity-fixture.js';
import { deltaCandidate, deltaContext, deltaCreate, deltaPublish } from './playback-state-delta-fixture.js';

// 全部为合成历史与票据；不读取真实账本、媒体、Provider或凭据。
function largeOldRowHistory(): PlaybackState {
  const state = capacityHistory({ sessions: 52, resources: 588, receipts: 1600 });
  for (const row of state.resources) row.source!.processing.reason = '合成原字节'.repeat(10);
  for (const row of state.receipts) if (row.reply && row.reply.status < 400 && row.operation !== 'createSession')
    (row.reply.body as { processing: { reason: string } }).processing.reason = '合成原字节'.repeat(10);
  const old = state.resources.at(-1)!;
  old.tickets = Array.from({ length: 6144 }, (_, i) => ({ hash: i.toString(16).padStart(64, '0'),
    expiresAt: old.hardExpiresAt, runtimeEpoch: 'segment.synthetic.'.padEnd(160, 'x') }));
  return capturePlaybackState(state, SERVER, DATASET, ORIGIN, limits);
}

function assertStandaloneStreams(encoded: ReturnType<typeof encodePlaybackStorage>): void {
  assert.equal(encoded.format, 'v6');
  const archive = JSON.parse(encoded.canonical) as { root: unknown; sessions: unknown[]; resources: unknown[]; receipts: unknown[] };
  for (const value of [archive.root, ...archive.sessions, ...archive.resources, ...archive.receipts]) {
    const block = value as { encoding: string; count: number; rawBytes: number; digest: string; data: string };
    const payload = Buffer.from(block.data, 'base64');
    const inflated = block.encoding === 'raw' ? { buffer: payload, consumed: payload.length }
      : (() => { const result = inflateRawSync(payload, { info: true, maxOutputLength: block.rawBytes }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
        return { buffer: result.buffer, consumed: result.engine.bytesWritten }; })();
    assert.equal(inflated.consumed, payload.length, '每块须为完整独立流，不能依赖字典或忽略尾字节');
    assert.equal(inflated.buffer.length, block.rawBytes);
    assert.equal(createHash('sha256').update(inflated.buffer).digest('hex'), block.digest);
    assert.equal((JSON.parse('[' + inflated.buffer.toString('utf8') + ']') as unknown[]).length, block.count);
  }
}

test('分段终态预留：默认2MiB内旧大行可冷读，同块新增UNKNOWN不再按整块raw误拒绝', { timeout: 120_000 }, t => {
  assert.equal(limits.stateBytes, 2_097_152);
  const before = largeOldRowHistory(), base = encodePlaybackStorage(before, SERVER, DATASET, ORIGIN, limits);
  assert.equal(base.format, 'v6');
  assert.ok(base.bytes.length < limits.stateBytes);
  assert.deepEqual(decodePlaybackStorage(base.bytes, SERVER, DATASET, ORIGIN, limits).state, before);
  assert.ok(capacityNodes(before) < 1_000_000);
  const patch = deltaCreate(before, 1801), candidate = deltaCandidate(before, patch, 1);
  capturePlaybackState(candidate, SERVER, DATASET, ORIGIN, limits);
  assert.equal(Math.floor((before.resources.length - 1) / 8), Math.floor(before.resources.length / 8));
  let encoded: ReturnType<typeof encodePlaybackStorage>;
  try { encoded = encodePlaybackStorage(candidate, SERVER, DATASET, ORIGIN, limits); }
  catch (error) {
    assert.ok(error instanceof MobilePlaybackError && error.status === 429 && error.code === 'RESOURCE_BUSY');
    assert.equal(readPlaybackStorageRejectionBoundary(error), 'terminal-v4-reserve');
    t.diagnostic(JSON.stringify({ synthetic: true, oldBaseColdRead: true, baseBytes: base.bytes.length,
      stateBytes: limits.stateBytes, logicalNodes: capacityNodes(candidate), largeOldTickets: 6144,
      newUnknown: 1, failureBoundary: readPlaybackStorageRejectionBoundary(error) }));
    throw error;
  }
  assert.equal(encoded.format, 'v6');
  assert.ok(encoded.bytes.length <= limits.stateBytes);
  assertStandaloneStreams(encoded);
  assert.deepEqual(decodePlaybackStorage(encoded.bytes, SERVER, DATASET, ORIGIN, limits).state, candidate);
  assert.deepEqual(encoded.state.resources.slice(0, before.resources.length), before.resources);
  assert.deepEqual(encoded.state.receipts.slice(0, before.receipts.length), before.receipts);
  const actor = createPlaybackStorageActor();
  try {
    const cold = actor.decode(base.bytes, deltaContext(before));
    const hot = actor.derive(cold.base, patch, deltaContext(candidate));
    assert.equal(hot.canonical, encoded.canonical);
    assert.deepEqual(hot.state, candidate);
    assert.deepEqual(decodePlaybackStorage(hot.bytes, SERVER, DATASET, ORIGIN, limits).state, candidate);
    const publication = deltaPublish(candidate, 1801), complete = deltaCandidate(candidate, publication, 2);
    const expected = encodePlaybackStorage(complete, SERVER, DATASET, ORIGIN, limits);
    const last = actor.derive(hot.base, publication, deltaContext(complete));
    assert.equal(last.state.receipts.filter(row => row.state === 'UNKNOWN').length, 0);
    assert.equal(last.canonical, expected.canonical, '最后UNKNOWN成功结算后热编码和冷编码仍一致');
    assert.ok(last.bytes.length <= limits.stateBytes);
    assertStandaloneStreams(last);
    assert.deepEqual(decodePlaybackStorage(last.bytes, SERVER, DATASET, ORIGIN, limits).state, complete);
    assert.deepEqual(last.state.resources.slice(0, before.resources.length), before.resources);
    assert.deepEqual(last.state.receipts.slice(0, before.receipts.length), before.receipts);
  } finally { actor.close(); }
  t.diagnostic(JSON.stringify({ synthetic: true, oldBaseColdRead: true, baseBytes: base.bytes.length,
    admittedBytes: encoded.bytes.length, stateBytes: limits.stateBytes, logicalNodes: capacityNodes(candidate),
    largeOldTickets: 6144, newUnknown: 1 }));
});

test('分段终态预留：大旧行共块的4个UNKNOWN全部16子集均能seal冷读，最后失败也保留原历史', { timeout: 120_000 }, t => {
  const before = largeOldRowHistory();
  let pending = before;
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) {
    const patch = deltaCreate(pending, 1820 + i);
    pending = deltaCandidate(pending, patch, i + 1); ids.push(patch.receipt.id);
  }
  const admitted = encodePlaybackStorage(pending, SERVER, DATASET, ORIGIN, limits);
  assert.equal(admitted.format, 'v6');
  const key = randomBytes(32), crypto = createMobileAuthCrypto(key); key.fill(0);
  let maximumBytes = 0;
  for (let mask = 0; mask < 16; mask++) {
    const state = structuredClone(pending);
    state.revision = Number.MAX_SAFE_INTEGER; state.clockFloor = 8_640_000_000_000_000;
    state.commitId = '50000000-0000-4000-8000-000000000001';
    for (let i = 0; i < 4; i++) if (mask & 1 << i) {
      const receipt = state.receipts.find(row => row.id === ids[i])!;
      receipt.state = 'RECORDED'; receipt.reply = { status: 409, body: { error: {
        code: 'IDEMPOTENCY_CONFLICT', message: '服务暂时无法完成请求，请查询原记录。',
        requestId: `40000000-0000-4000-8000-${(mask * 4 + i).toString().padStart(12, '0')}`,
        retryable: false, retryAfterMs: Number.MAX_SAFE_INTEGER } } };
      const resource = state.resources.find(row => row.id === receipt.resourceId)!;
      resource.state = 'failed'; resource.failure = 'IDEMPOTENCY_CONFLICT'; resource.media = null;
    }
    const encoded = encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, limits);
    assert.equal(encoded.format, 'v6'); assert.ok(encoded.bytes.length <= limits.stateBytes);
    assertStandaloneStreams(encoded); maximumBytes = Math.max(maximumBytes, encoded.bytes.length);
    const aad = Buffer.from(JSON.stringify(['MBM002_PLAYBACK_STATE_V1', SERVER, DATASET, state.revision]));
    const sealed = crypto.seal(encoded.bytes, aad), plain = crypto.open(sealed, aad);
    try { assert.deepEqual(decodePlaybackStorage(plain, SERVER, DATASET, ORIGIN, limits).state, state); }
    finally { plain.fill(0); sealed.fill(0); }
    assert.deepEqual(state.resources.slice(0, before.resources.length), before.resources);
    assert.deepEqual(state.receipts.slice(0, before.receipts.length), before.receipts);
  }
  t.diagnostic(JSON.stringify({ synthetic: true, unknowns: 4, subsets: 16, maximumBytes, stateBytes: limits.stateBytes,
    maximumRevisionAndClock: true, lastUnknownFailureEncoded: true, oldResourcesAndReceiptsUnchanged: true }));
});

test('分段终态预留：默认2MiB真正物理不足仍拒绝，不借分段放大容量或丢弃大旧行', { timeout: 120_000 }, t => {
  const state = largeOldRowHistory();
  for (const [j, row] of state.resources.slice(-3).entries()) {
    row.tickets = Array.from({ length: 6144 }, (_, i) => ({
      hash: createHash('sha256').update(`segment.synthetic.hash.${j}.${i}`).digest('hex'), expiresAt: row.hardExpiresAt,
      runtimeEpoch: [0, 1, 2].map(part => createHash('sha256').update(`segment.synthetic.epoch.${j}.${i}.${part}`).digest('hex')).join('').slice(0, 160),
    }));
  }
  capturePlaybackState(state, SERVER, DATASET, ORIGIN, limits);
  assert.ok(capacityNodes(state) < 1_000_000);
  assert.throws(() => encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, limits), error =>
    error instanceof MobilePlaybackError && error.status === 429 && error.code === 'RESOURCE_BUSY'
    && readPlaybackStorageRejectionBoundary(error) === 'v4-physical');
  t.diagnostic(JSON.stringify({ synthetic: true, logicalNodes: capacityNodes(state), stateBytes: limits.stateBytes,
    oldLargeRows: 3, ticketsPerRow: 6144, failureBoundary: 'v4-physical', historyRowsDropped: 0 }));
});
