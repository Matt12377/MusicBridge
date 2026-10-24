import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  createPlaybackStorageActor, encodePlaybackStorage, readPlaybackStorageRejectionBoundary,
  type PlaybackStorageCapacityDiagnostic,
} from '../../src/mobile/playback-state-codec.js';
import { capturePlaybackState, playbackCanonical, type PlaybackState } from '../../src/mobile/playback-state.js';
import { MOBILE_PLAYBACK_DEFAULT_LIMITS, MobilePlaybackError } from '../../src/mobile/playback-types.js';
import { capacityHistory, CAPACITY_SERVER as SERVER, CAPACITY_DATASET as DATASET, CAPACITY_ORIGIN as ORIGIN } from './playback-state-capacity-fixture.js';
import { deltaCandidate, deltaContext, deltaCreate } from './playback-state-delta-fixture.js';

// 仅使用合成历史；缩小测试物理预算，覆盖真实v6路径而不读取真实账本。
const limits = { ...MOBILE_PLAYBACK_DEFAULT_LIMITS, stateBytes: 65_536 };
const prefix = '[MusicBridgePlaybackCapacity] ';
const context = (state: PlaybackState, stateBytes = limits.stateBytes) => ({ ...deltaContext(state), limits: { ...limits, stateBytes } });
function pendingHistory(): PlaybackState {
  const before = capacityHistory({ sessions: 2, resources: 7, receipts: 63, formats: 2 });
  const old = before.resources.at(-1)!;
  old.tickets = Array.from({ length: 1024 }, (_, i) => ({ hash: i.toString(16).padStart(64, '0'),
    expiresAt: old.hardExpiresAt, runtimeEpoch: 'diagnostic.synthetic.old-row.'.padEnd(160, 'x') }));
  capturePlaybackState(before, SERVER, DATASET, ORIGIN, limits);
  return deltaCandidate(before, deltaCreate(before, 14001), 1);
}
function keys(value: object, expected: readonly string[]): void { assert.deepEqual(Object.keys(value).sort(), [...expected].sort()); }
function assertNumbers(value: unknown): void {
  if (typeof value === 'object' && value !== null) { for (const item of Object.values(value)) assertNumbers(item); }
  else assert.ok(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}
function assertShape(value: PlaybackStorageCapacityDiagnostic, worker = false): void {
  keys(value, ['schema', 'phase', 'actualPhysicalBytes', 'futureBoundBytes', 'stateBytes', 'counts', 'groups', ...(worker ? ['atMs'] : [])]);
  assert.equal(value.schema, 'mb.playback-codec-capacity.v1');
  assert.ok(['sample', 'v4-physical', 'terminal-v4-reserve'].includes(value.phase));
  keys(value.counts, ['sessions', 'resources', 'receipts', 'unknown', 'tickets']);
  keys(value.groups, ['root', 'sessions', 'resources', 'receipts']);
  for (const group of Object.values(value.groups)) {
    keys(group, ['currentEncodedBytes', 'reserveBoundBytes', 'affectedBlocks', 'affectedRows', 'affectedRowMaxRawBytes', 'unchangedRowSegmentBytes']);
    assertNumbers(group);
    assert.ok(group.reserveBoundBytes >= group.currentEncodedBytes);
  }
  assertNumbers(value.counts);
  assertNumbers([value.actualPhysicalBytes, value.futureBoundBytes, value.stateBytes]);
  if (worker) assertNumbers((value as PlaybackStorageCapacityDiagnostic & { atMs: number }).atMs);
  assert.ok(!/synthetic|https?:|original-key|ticket=|capacity\.session|capacity\.resource/u.test(JSON.stringify(value)));
}
function envelopeBytes(schema: string): number {
  return Buffer.byteLength(JSON.stringify({ schema, root: null, sessions: null, resources: null, receipts: null })) - 4 * 'null'.length;
}
function assertConservation(value: PlaybackStorageCapacityDiagnostic, schema: string): void {
  const groups = Object.values(value.groups);
  assert.equal(value.actualPhysicalBytes, envelopeBytes(schema) + groups.reduce((sum, group) => sum + group.currentEncodedBytes, 0));
  assert.equal(value.futureBoundBytes, envelopeBytes(schema) + groups.reduce((sum, group) => sum + group.reserveBoundBytes, 0));
}
function errorBoundary(error: unknown): boolean {
  return error instanceof MobilePlaybackError && error.status === 429 && error.code === 'RESOURCE_BUSY'
    && readPlaybackStorageRejectionBoundary(error) === 'terminal-v4-reserve';
}

test('容量数字旁注：全量v6字节与分组精确守恒，只计数不泄露历史且原编码不变', () => {
  const state = pendingHistory(), observations: PlaybackStorageCapacityDiagnostic[] = [];
  const expected = encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, limits);
  assert.equal(expected.format, 'v6');
  const actor = createPlaybackStorageActor({ observeCapacity: value => observations.push(value) });
  try {
    const actual = actor.encode(state, context(state));
    assert.equal(actual.canonical, expected.canonical); assert.deepEqual(actual.bytes, expected.bytes);
    assert.deepEqual(actual.state, state); assert.equal(observations.length, 1);
    const value = observations[0]!; assertShape(value);
    assert.equal(value.phase, 'sample'); assert.equal(value.actualPhysicalBytes, actual.bytes.length);
    assert.equal(value.stateBytes, limits.stateBytes);
    assert.deepEqual(value.counts, { sessions: 2, resources: 8, receipts: 64, unknown: 1, tickets: 1024 });
    const archive = JSON.parse(actual.canonical) as Record<string, unknown> & { schema: string };
    for (const name of ['root', 'sessions', 'resources', 'receipts'] as const)
      assert.equal(value.groups[name].currentEncodedBytes, Buffer.byteLength(JSON.stringify(archive[name])));
    assertConservation(value, archive.schema);
    assert.equal(value.groups.root.affectedBlocks, 1); assert.equal(value.groups.root.affectedRows, 1);
    assert.equal(value.groups.resources.affectedBlocks, 1); assert.equal(value.groups.resources.affectedRows, 1);
    assert.equal(value.groups.receipts.affectedBlocks, 1); assert.equal(value.groups.receipts.affectedRows, 1);
    assert.equal(value.groups.sessions.affectedBlocks, 0); assert.equal(value.groups.sessions.affectedRows, 0);
    assert.ok(value.groups.resources.unchangedRowSegmentBytes > 0);
    assert.ok(value.groups.receipts.unchangedRowSegmentBytes > 0);
    assert.ok(value.groups.resources.affectedRowMaxRawBytes >= Buffer.byteLength(playbackCanonical(state.resources.at(-1)!)));
    assert.ok(value.groups.resources.affectedRowMaxRawBytes < Buffer.byteLength(playbackCanonical(state.resources.at(-2)!)) / 10,
      '可变行最大raw大小不能把同块旧大票据行冒充成新增UNKNOWN自身开销');
  } finally { actor.close(); }
});

test('容量数字旁注：terminal拒绝后仍给完整safe sum，不止于首个越界前缀', () => {
  const state = pendingHistory(), baseline: PlaybackStorageCapacityDiagnostic[] = [];
  const first = createPlaybackStorageActor({ observeCapacity: value => baseline.push(value) });
  const encoded = first.encode(state, context(state)); first.close();
  const bytes = encoded.bytes.length, rows: PlaybackStorageCapacityDiagnostic[] = [];
  const tight = { ...limits, stateBytes: bytes };
  assert.throws(() => encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, tight), errorBoundary);
  const actor = createPlaybackStorageActor({ observeCapacity: value => rows.push(value) });
  try {
    assert.throws(() => actor.encode(state, context(state, bytes)), errorBoundary);
    assert.equal(rows.length, 1); const value = rows[0]!; assertShape(value);
    assert.equal(value.phase, 'terminal-v4-reserve'); assert.equal(value.actualPhysicalBytes, bytes);
    assert.ok(value.actualPhysicalBytes <= value.stateBytes); assert.ok(value.futureBoundBytes > value.stateBytes);
    assert.equal(value.futureBoundBytes, baseline[0]!.futureBoundBytes);
    assert.equal(value.groups.receipts.reserveBoundBytes, baseline[0]!.groups.receipts.reserveBoundBytes,
      '前面resource部分越界也不能漏掉末尾receipt完整预留');
    assertConservation(value, JSON.parse(encoded.canonical).schema as string);
  } finally { actor.close(); }
});

test('容量数字旁注：首次采样和八次失败封顶，observer抛错不改变原成功或拒绝', () => {
  const state = pendingHistory(), expected = encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, limits);
  const phases: PlaybackStorageCapacityDiagnostic['phase'][] = [];
  const actor = createPlaybackStorageActor({ observeCapacity(value) { phases.push(value.phase); throw new Error('合成旁注出口故障'); } });
  try {
    for (let i = 0; i < 2; i++) assert.equal(actor.encode(state, context(state)).canonical, expected.canonical);
    for (let i = 0; i < 10; i++) assert.throws(() => actor.encode(state, context(state, expected.bytes.length)), errorBoundary);
    assert.deepEqual(phases, ['sample', ...Array.from({ length: 8 }, () => 'terminal-v4-reserve')]);
    assert.deepEqual(state, pendingHistory(), '旁注和失败不能写回调用方状态');
  } finally { actor.close(); }
});

test('容量数字旁注：实际物理不足仍原样拒绝，并完整报告后续resource和receipt合计', () => {
  const state = pendingHistory(), encoded = encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, limits);
  const observations: PlaybackStorageCapacityDiagnostic[] = [];
  const actor = createPlaybackStorageActor({ observeCapacity: value => observations.push(value) });
  try {
    assert.throws(() => actor.encode(state, context(state, encoded.bytes.length - 1)), error =>
      error instanceof MobilePlaybackError && error.status === 429 && error.code === 'RESOURCE_BUSY'
        && readPlaybackStorageRejectionBoundary(error) === 'v4-physical');
    assert.equal(observations.length, 1);
    const value = observations[0]!; assertShape(value);
    assert.equal(value.phase, 'v4-physical'); assert.equal(value.actualPhysicalBytes, encoded.bytes.length);
    assert.ok(value.actualPhysicalBytes > value.stateBytes);
    assert.ok(value.futureBoundBytes >= value.actualPhysicalBytes);
    assert.ok(value.groups.resources.currentEncodedBytes > 0); assert.ok(value.groups.receipts.currentEncodedBytes > 0);
    assertConservation(value, JSON.parse(encoded.canonical).schema as string);
  } finally { actor.close(); }
});

const child = `
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
const input = JSON.parse(readFileSync(0, 'utf8'));
if (input.mode === 'flag') process.argv.push('--mb-private-resource-capacity-trace');
const { createMobilePlaybackStateCodec } = await import(pathToFileURL(process.env.MUSIC_BRIDGE_PLAYBACK_CODEC_TEST_CLIENT));
const workerUrl = pathToFileURL(process.env.MUSIC_BRIDGE_PLAYBACK_CODEC_TEST_ENTRY);
const codec = createMobilePlaybackStateCodec(input.mode === 'string' ? { workerFactory: () => new Worker(workerUrl,
  { execArgv: [], env: {}, workerData: { resourceCapacityDiagnostic: 'true' } }) } : { workerUrl });
try {
  const result = await codec.encode(input.state, input.context);
  console.log('SYNTHETIC_CODEC_RESULT ' + JSON.stringify({ bytes: result.bytes.length,
    sha256: createHash('sha256').update(result.bytes).digest('hex') }));
} finally { await codec.close(); }
`;

test('容量数字旁注：真实Worker仅由显式boolean启用，父flag传递且默认或字符串不开启', { timeout: 60_000 }, () => {
  for (const name of ['MUSIC_BRIDGE_PLAYBACK_CODEC_TEST_ENTRY', 'MUSIC_BRIDGE_PLAYBACK_CODEC_TEST_CLIENT'])
    assert.ok(process.env[name]?.startsWith('/Volumes/LifeWeave/'), '测试必须由外置runner编译本次真实生产entry/client');
  const state = pendingHistory(), results: { bytes: number; sha256: string }[] = [];
  for (const mode of ['default', 'flag', 'string']) {
    const run = spawnSync(process.execPath, ['--input-type=module', '--eval', child], {
      input: JSON.stringify({ mode, state, context: context(state) }), encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '', MUSIC_BRIDGE_RESOURCE_CAPACITY_TRACE: 'true' }, timeout: 30_000,
    });
    assert.equal(run.error, undefined); assert.equal(run.signal, null); assert.equal(run.status, 0, run.stderr);
    const lines = run.stdout.split('\n'), numeric = lines.filter(line => line.startsWith(prefix));
    assert.equal(numeric.length, mode === 'flag' ? 1 : 0);
    if (numeric[0]) {
      assert.ok(Buffer.byteLength(numeric[0]) <= 4096);
      const value = JSON.parse(numeric[0].slice(prefix.length)) as PlaybackStorageCapacityDiagnostic;
      assertShape(value, true); assert.equal(value.phase, 'sample'); assert.equal(value.counts.unknown, 1);
    }
    const result = lines.find(line => line.startsWith('SYNTHETIC_CODEC_RESULT ')); assert.ok(result);
    results.push(JSON.parse(result.slice('SYNTHETIC_CODEC_RESULT '.length)) as { bytes: number; sha256: string });
  }
  assert.deepEqual(results[1], results[0]); assert.deepEqual(results[2], results[0]);
});
