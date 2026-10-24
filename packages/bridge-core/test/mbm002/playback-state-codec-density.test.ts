import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { mobileCanonicalJson, type MobileJsonValue } from '@music-bridge/contracts';
import { encodePlaybackStorage, decodePlaybackStorage, readPlaybackStorageRejectionBoundary, createPlaybackStorageActor,
  type PlaybackStorageCapacityDiagnostic } from '../../src/mobile/playback-state-codec.js';
import { MOBILE_PLAYBACK_DEFAULT_LIMITS as limits, MobilePlaybackError, type MobilePlaybackSourcePort } from '../../src/mobile/playback-types.js';
import { capturePlaybackState, type PlaybackState } from '../../src/mobile/playback-state.js';
import { createMobileAuthCrypto } from '../../src/mobile/auth-crypto.js';
import { createMobilePlaybackService } from '../../src/mobile/playback-service.js';
import type { MobileAuthPersistence, MobileSealedState } from '../../src/mobile/types.js';
import { capacityHistory, capacityPrincipal, CAPACITY_NOW as NOW,
  CAPACITY_SERVER as SERVER, CAPACITY_DATASET as DATASET, CAPACITY_ORIGIN as ORIGIN } from './playback-state-capacity-fixture.js';
import { deltaCandidate, deltaContext, deltaCreate, deltaPublish } from './playback-state-delta-fixture.js';

// 全部为合成历史；只使用公开codec，不读取真实账本、Provider、媒体或凭据。
function history(): PlaybackState {
  const state = capacityHistory({ sessions: 52, resources: 588, receipts: 1600 });
  for (const row of state.resources) row.source!.processing.reason = '合成原字节'.repeat(10);
  for (const row of state.receipts) if (row.reply && row.reply.status < 400 && row.operation !== 'createSession')
    (row.reply.body as { processing: { reason: string } }).processing.reason = '合成原字节'.repeat(10);
  return capturePlaybackState(state, SERVER, DATASET, ORIGIN, limits);
}
interface Block { encoding: 'raw' | 'deflate-raw'; count: number; rawBytes: number; digest: string; data: string }
interface Archive { schema: string; root: Block; sessions: Block[]; resources: Block[]; receipts: Block[] }
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown) => mobileCanonicalJson(value as MobileJsonValue);
function inflate(block: Block): Buffer {
  const payload = Buffer.from(block.data, 'base64');
  if (block.encoding === 'raw') return payload;
  const result = inflateRawSync(payload, { info: true, maxOutputLength: block.rawBytes }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  assert.equal(result.engine.bytesWritten, payload.length); return result.buffer;
}
/** 独立合法归档见证：保留已有8行分块及全部原始字节，只调用标准完整deflate流重压。 */
function losslessWitness(encoded: ReturnType<typeof encodePlaybackStorage>): Uint8Array {
  assert.equal(encoded.format, 'v6'); const archive = JSON.parse(encoded.canonical) as Archive;
  for (const block of [archive.root, ...archive.sessions, ...archive.resources, ...archive.receipts]) {
    const raw = inflate(block); assert.equal(raw.length, block.rawBytes); assert.equal(digest(raw), block.digest);
    block.encoding = 'deflate-raw'; block.data = deflateRawSync(raw, { level: 6 }).toString('base64');
    assert.deepEqual(inflate(block), raw);
  }
  return new Uint8Array(Buffer.from(canonical(archive)));
}
test('DENSITY_RED 同一合法历史已有可冷读无损归档时，较紧物理边界不得因旧压缩选择误拒', { timeout: 60_000 }, t => {
  const state = history(), before = encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, limits);
  const witness = losslessWitness(before), bounded = { ...limits, stateBytes: witness.byteLength + 32 };
  assert.ok(bounded.stateBytes < limits.stateBytes, '只下调本测试物理上限，不能增加正式2MiB预算。');
  assert.deepEqual(decodePlaybackStorage(witness, SERVER, DATASET, ORIGIN, bounded).state, state,
    '原公开decoder必须确认该归档合法且保全所有历史，不能只比较zlib长度。');
  let encoded: ReturnType<typeof encodePlaybackStorage>;
  try { encoded = encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, bounded); }
  catch (error) {
    assert.ok(error instanceof MobilePlaybackError && error.status === 429 && error.code === 'RESOURCE_BUSY');
    assert.equal(readPlaybackStorageRejectionBoundary(error), 'v4-physical');
    t.diagnostic(JSON.stringify({ synthetic: true, originalBytes: before.bytes.length, independentlyDecodableBytes: witness.byteLength,
      boundedStateBytes: bounded.stateBytes, defaultStateBytes: limits.stateBytes, oldDecoderPreservesAllFields: true,
      rejectionBoundary: readPlaybackStorageRejectionBoundary(error) }));
    throw error;
  }
  assert.equal(encoded.format, 'v6'); assert.ok(encoded.bytes.length <= bounded.stateBytes);
  assert.deepEqual(decodePlaybackStorage(encoded.bytes, SERVER, DATASET, ORIGIN, bounded).state, state);
  t.diagnostic(JSON.stringify({ synthetic: true, admittedBytes: encoded.bytes.length, independentlyDecodableBytes: witness.byteLength,
    boundedStateBytes: bounded.stateBytes, defaultStateBytes: limits.stateBytes, allHistoryFieldsPreserved: true }));
});

test('密度：冷重开在较紧预算逐字段重放原session/resource/renew回执，不另prepare或重写', { timeout: 60_000 }, async t => {
  const original = history(), before = encodePlaybackStorage(original, SERVER, DATASET, ORIGIN, limits), witness = losslessWitness(before);
  const bounded = { ...limits, stateBytes: witness.byteLength + 32 }, encoded = encodePlaybackStorage(original, SERVER, DATASET, ORIGIN, bounded);
  const key = randomBytes(32), crypto = createMobileAuthCrypto(key); key.fill(0);
  const aad = Buffer.from(JSON.stringify(['MBM002_PLAYBACK_STATE_V1', SERVER, DATASET, original.revision]));
  const sealed = crypto.seal(encoded.bytes, aad), originalSealed = new Uint8Array(sealed);
  const stored: MobileSealedState = { kind: 'sealed', datasetId: DATASET, revision: original.revision, commitId: original.commitId!, sealed };
  let writes = 0, prepares = 0, revoked = false;
  const persistence: MobileAuthPersistence = { async load() { return structuredClone(stored); }, async save() {
    writes++; throw new Error('原回执只读重放不能重新写入。');
  } };
  const source: MobilePlaybackSourcePort = { async prepare() { prepares++; throw new Error('原回执不能重新准备音频。'); },
    async verify() {}, async renew() {}, async read() { throw new Error('不读取媒体。'); }, async closeRead() {}, async release() {} };
  const service = createMobilePlaybackService({ serverId: SERVER, datasetId: DATASET, responseOrigin: ORIGIN, limits: bounded,
    persistence, crypto, sourcePort: source, nowMs: () => NOW,
    auth: { async assertDeviceCurrent() { if (revoked) throw new MobilePlaybackError(401, 'DEVICE_REVOKED'); } } });
  t.after(async () => { await service.close(); sealed.fill(0); originalSealed.fill(0); });
  let latest: Awaited<ReturnType<typeof service.control>> | undefined;
  for (const row of [original.receipts[0]!, original.receipts[52]!, original.receipts[640]!, original.receipts.at(-1)!]) {
    const replay = await service.control(row.operation, row.request, capacityPrincipal(), new AbortController().signal);
    assert.equal(replay.status, row.reply!.status); assert.deepEqual(replay.body, row.reply!.body);
    await replay.beforeSend(); latest = replay;
  }
  assert.equal(writes, 0); assert.equal(prepares, 0); assert.deepEqual(sealed, originalSealed);
  const plain = crypto.open(sealed, aad);
  try { assert.deepEqual(decodePlaybackStorage(plain, SERVER, DATASET, ORIGIN, bounded).state, original); }
  finally { plain.fill(0); }
  revoked = true; assert.ok(latest);
  await assert.rejects(latest.beforeSend(), error => error instanceof MobilePlaybackError && error.code === 'DEVICE_REVOKED');
});

test('密度：原准入复杂/高熵历史不倒退，更强压缩仍受物理字节与计数上限约束', { timeout: 60_000 }, () => {
  const complex = history(), last = complex.resources.at(-1)!;
  last.tickets = Array.from({ length: 512 }, (_, index) => ({ hash: digest(Buffer.from(`density.hash.${index}`)),
    expiresAt: last.hardExpiresAt,
    runtimeEpoch: [0, 1, 2].map(part => digest(Buffer.from(`density.epoch.${index}.${part}`))).join('').slice(0, 160) }));
  for (const state of [capacityHistory({ sessions: 2, resources: 6, receipts: 12, formats: 1 }),
    capacityHistory({ sessions: 2, resources: 6, receipts: 12, errors: true }), complex]) {
    const encoded = encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, limits);
    assert.ok(encoded.bytes.length <= limits.stateBytes); assert.deepEqual(encoded.state, state);
    assert.deepEqual(decodePlaybackStorage(encoded.bytes, SERVER, DATASET, ORIGIN, limits).state, state);
  }
  const encoded = encodePlaybackStorage(complex, SERVER, DATASET, ORIGIN, limits); assert.equal(encoded.format, 'v6');
  const archive = JSON.parse(encoded.canonical) as Archive;
  assert.ok([...archive.sessions, ...archive.resources, ...archive.receipts].every(block => block.count >= 1 && block.count <= 8));
  assert.throws(() => encodePlaybackStorage(complex, SERVER, DATASET, ORIGIN, { ...limits, stateBytes: encoded.bytes.length - 1 }),
    error => error instanceof MobilePlaybackError && error.code === 'RESOURCE_BUSY'
      && readPlaybackStorageRejectionBoundary(error) === 'v4-physical');
  assert.throws(() => encodePlaybackStorage(complex, SERVER, DATASET, ORIGIN, { ...limits, maxReceipts: complex.receipts.length - 1 }));
  const trailer = structuredClone(archive), first = trailer.receipts[0]!;
  first.data = Buffer.concat([Buffer.from(first.data, 'base64'), Buffer.from([0])]).toString('base64');
  assert.throws(() => decodePlaybackStorage(new Uint8Array(Buffer.from(canonical(trailer))), SERVER, DATASET, ORIGIN, limits));
});

test('密度：旧准入UNKNOWN全部子集及最后结算保全历史，当前压缩字节不能替代终态预留', { timeout: 120_000 }, t => {
  const before = history(); let pending = before;
  for (let index = 0; index < 2; index++) pending = deltaCandidate(pending, deltaCreate(pending, 2501 + index), index + 1);
  const samples: PlaybackStorageCapacityDiagnostic[] = [], actor = createPlaybackStorageActor({ observeCapacity: value => samples.push(value) });
  try {
    const admitted = actor.encode(pending, deltaContext(pending)); assert.equal(admitted.format, 'v6');
    const sample = samples.find(value => value.phase === 'sample'); assert.ok(sample);
    assert.ok(sample.futureBoundBytes > sample.actualPhysicalBytes);
    assert.throws(() => encodePlaybackStorage(pending, SERVER, DATASET, ORIGIN, { ...limits, stateBytes: admitted.bytes.length }),
      error => error instanceof MobilePlaybackError && error.status === 429 && error.code === 'RESOURCE_BUSY'
        && readPlaybackStorageRejectionBoundary(error) === 'terminal-v4-reserve');
    let maximumBytes = 0;
    for (let mask = 0; mask < 4; mask++) {
      const state = structuredClone(pending); state.revision = Number.MAX_SAFE_INTEGER; state.clockFloor = 8_640_000_000_000_000;
      state.commitId = '50000000-0000-4000-8000-000000000001';
      for (let index = 0; index < 2; index++) if (mask & 1 << index) {
        const receipt = state.receipts.find(row => row.id === `delta.receipt.${2501 + index}`)!;
        receipt.state = 'RECORDED'; receipt.reply = { status: 409, body: { error: { code: 'IDEMPOTENCY_CONFLICT',
          message: '服务暂时无法完成请求，请查询原记录。', requestId: `40000000-0000-4000-8000-${(index + 1).toString().padStart(12, '0')}`,
          retryable: false, retryAfterMs: Number.MAX_SAFE_INTEGER } } };
        const resource = state.resources.find(row => row.id === receipt.resourceId)!;
        resource.state = 'failed'; resource.failure = 'IDEMPOTENCY_CONFLICT'; resource.media = null;
      }
      const encoded = encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, limits); maximumBytes = Math.max(maximumBytes, encoded.bytes.length);
      assert.deepEqual(decodePlaybackStorage(encoded.bytes, SERVER, DATASET, ORIGIN, limits).state, state);
      assert.deepEqual(encoded.state.resources.slice(0, before.resources.length), before.resources);
      assert.deepEqual(encoded.state.receipts.slice(0, before.receipts.length), before.receipts);
    }
    let state = pending, hot = admitted;
    for (let index = 0; index < 2; index++) {
      const patch = deltaPublish(state, 2501 + index), candidate = deltaCandidate(state, patch, index + 10);
      hot = actor.derive(hot.base, patch, deltaContext(candidate));
      const cold = encodePlaybackStorage(candidate, SERVER, DATASET, ORIGIN, limits);
      assert.equal(hot.canonical, cold.canonical); assert.deepEqual(decodePlaybackStorage(hot.bytes, SERVER, DATASET, ORIGIN, limits).state, candidate);
      assert.deepEqual(hot.state.receipts.slice(0, before.receipts.length), before.receipts); state = candidate;
    }
    assert.equal(hot.state.receipts.filter(row => row.state === 'UNKNOWN').length, 0);
    t.diagnostic(JSON.stringify({ synthetic: true, unknowns: 2, subsets: 4, maximumBytes,
      actualPhysicalBytes: sample.actualPhysicalBytes, futureBoundBytes: sample.futureBoundBytes,
      defaultStateBytes: limits.stateBytes, terminalGuardPreserved: true, lastUnknownSettled: true }));
  } finally { actor.close(); }
});
