import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { capturePlaybackState, playbackCopy, type PlaybackState } from '../../src/mobile/playback-state.js';
import { encodePlaybackStorage, decodePlaybackStorage } from '../../src/mobile/playback-state-codec.js';
import { MOBILE_PLAYBACK_DEFAULT_LIMITS, MobilePlaybackError } from '../../src/mobile/playback-types.js';
import { capacityHistory, CAPACITY_SERVER as SERVER, CAPACITY_DATASET as DATASET, CAPACITY_ORIGIN as ORIGIN } from './playback-state-capacity-fixture.js';

const limits = MOBILE_PLAYBACK_DEFAULT_LIMITS;
const busy = (work: () => unknown) => assert.throws(work, error => error instanceof MobilePlaybackError && error.code === 'BUSY');
test('回执证书：新对象同值及变化root保留全部字段，完整父记录/唯一键/负零变化仍原样拒绝', { timeout: 60_000 }, t => {
  const base = capacityHistory(), coldStart = performance.now(), first = encodePlaybackStorage(base, SERVER, DATASET, ORIGIN, limits);
  const coldMs = performance.now() - coldStart;
  const same = playbackCopy(base); same.revision++; same.commitId = 'certificate.new.commit';
  const started = performance.now(), next = encodePlaybackStorage(same, SERVER, DATASET, ORIGIN, limits), warmMs = performance.now() - started;
  assert.deepEqual(next.state, capturePlaybackState(same, SERVER, DATASET, ORIGIN, limits));
  assert.notEqual(next.state.receipts[0], first.state.receipts[0]);
  assert.deepEqual(decodePlaybackStorage(next.bytes, SERVER, DATASET, ORIGIN, limits).state, same);
  first.state.receipts[0]!.request.body = { clientInstanceId: '不能污染后续证明' };
  assert.deepEqual(encodePlaybackStorage(same, SERVER, DATASET, ORIGIN, limits).state, same);

  const changes: ((state: PlaybackState) => void)[] = [
    state => { state.resources[0]!.request.trackId = 'different.valid.track'; },
    state => { state.resources[0]!.source!.processing.reason = '变化后的来源解释'; },
    state => { state.sessions[0]!.clientInstanceId = 'different.valid.client'; },
    state => { state.receipts[0]!.request.idempotencyKey = 'different-original-key'; },
    state => { state.receipts[1]!.id = state.receipts[0]!.id; },
    state => { const duplicate = playbackCopy(state.receipts[0]!); duplicate.id = 'certificate.unique.id'; state.receipts.push(duplicate); },
  ];
  for (const change of changes) {
    encodePlaybackStorage(base, SERVER, DATASET, ORIGIN, limits);
    const altered = playbackCopy(base); change(altered);
    busy(() => capturePlaybackState(altered, SERVER, DATASET, ORIGIN, limits));
    busy(() => encodePlaybackStorage(altered, SERVER, DATASET, ORIGIN, limits));
  }
  const zero = playbackCopy(base); zero.receipts[0]!.createdAt = 0;
  encodePlaybackStorage(zero, SERVER, DATASET, ORIGIN, limits);
  const negativeZero = playbackCopy(zero); negativeZero.receipts[0]!.createdAt = -0;
  assert.equal(JSON.stringify(negativeZero), JSON.stringify(zero));
  busy(() => encodePlaybackStorage(negativeZero, SERVER, DATASET, ORIGIN, limits));
  busy(() => encodePlaybackStorage(base, 'different.server', DATASET, ORIGIN, limits));
  assert.throws(() => encodePlaybackStorage(base, SERVER, DATASET, ORIGIN, { ...limits, stateBytes: 1024 }),
    error => error instanceof MobilePlaybackError && error.code === 'RESOURCE_BUSY');

  const unknown = playbackCopy(base), pending = unknown.receipts.find(row => row.operation === 'createResource')!;
  pending.state = 'UNKNOWN'; pending.reply = null; pending.resourceContext = null;
  const encodedUnknown = encodePlaybackStorage(unknown, SERVER, DATASET, ORIGIN, limits);
  assert.deepEqual(encodedUnknown.state, capturePlaybackState(unknown, SERVER, DATASET, ORIGIN, limits));
  assert.equal(decodePlaybackStorage(encodedUnknown.bytes, SERVER, DATASET, ORIGIN, limits).state.receipts.find(row => row.id === pending.id)!.state, 'UNKNOWN');
  t.diagnostic(JSON.stringify({ synthetic: true, receipts: base.receipts.length, coldMs: Math.round(coldMs), warmMs: Math.round(warmMs), timingIsNotAcceptance: true }));
});

test('回执证书：大父记录只造成缓存未命中，重复引用不扩大私有缓存且账本仍完整往返', { timeout: 60_000 }, () => {
  const state = capacityHistory({ sessions: 1, resources: 1, receipts: 2048, formats: 10, errors: true }), resource = state.resources[0]!;
  for (let i = 0; i < 1024; i++) resource.tickets.push({ hash: i.toString(16).padStart(64, '0'), expiresAt: resource.hardExpiresAt, runtimeEpoch: resource.runtimeEpoch });
  assert.ok(Buffer.byteLength(JSON.stringify(resource)) > 32 * 1024);
  const expected = capturePlaybackState(state, SERVER, DATASET, ORIGIN, limits), first = encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, limits);
  assert.deepEqual(first.state, expected);
  const second = encodePlaybackStorage(playbackCopy(state), SERVER, DATASET, ORIGIN, limits);
  assert.equal(second.canonical, first.canonical);
  assert.deepEqual(decodePlaybackStorage(second.bytes, SERVER, DATASET, ORIGIN, limits).state, expected);
});
