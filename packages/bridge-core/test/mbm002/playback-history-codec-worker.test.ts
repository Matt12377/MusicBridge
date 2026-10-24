import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { encodePlaybackStorage, type EncodedPlaybackStorage, type IncrementalPlaybackStateCodecPort,
  type PlaybackStorageWithBase } from '../../src/mobile/playback-state-codec.js';
import { decodePlaybackHistoryGroup } from '../../src/mobile/playback-history-codec.js';
import { playbackCopy } from '../../src/mobile/playback-state.js';
import { MOBILE_PLAYBACK_DEFAULT_LIMITS } from '../../src/mobile/playback-types.js';
import { capacityHistory, CAPACITY_SERVER as SERVER, CAPACITY_DATASET as DATASET,
  CAPACITY_ORIGIN as ORIGIN } from './playback-state-capacity-fixture.js';
import { deltaCandidate, deltaContext, deltaSession } from './playback-state-delta-fixture.js';

// 必须编译本候选的真实desktop client/entry；不以同步codec或旧dist替代线程证据。
type Factory = (options: { workerUrl?: URL; workerFactory?: () => Worker }) => IncrementalPlaybackStateCodecPort;
const busy = (error: unknown): boolean => error !== null && typeof error === 'object'
  && Object.getOwnPropertyDescriptor(error, 'status')?.value === 503
  && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'BUSY';
async function fixture(t: TestContext, observeWorker = false) {
  const client = process.env.MUSIC_BRIDGE_PLAYBACK_CODEC_TEST_CLIENT;
  const entry = process.env.MUSIC_BRIDGE_PLAYBACK_CODEC_TEST_ENTRY;
  assert.ok(typeof client === 'string' && client.startsWith('/Volumes/LifeWeave/Developer/CommandLine/'), '需外置本候选真实client编译产物。');
  assert.ok(typeof entry === 'string' && entry.startsWith('/Volumes/LifeWeave/Developer/CommandLine/'), '需外置本候选真实Worker编译入口。');
  const { createMobilePlaybackStateCodec } = await import(pathToFileURL(client).href) as { createMobilePlaybackStateCodec: Factory };
  let exit: Promise<number> | undefined;
  const port = createMobilePlaybackStateCodec(observeWorker ? { workerFactory() {
    const worker = new Worker(pathToFileURL(entry), { execArgv: [], env: {},
      resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 } });
    exit = new Promise(resolve => worker.once('exit', resolve)); return worker;
  } } : { workerUrl: pathToFileURL(entry) });
  t.after(() => port.close());
  assert.equal(typeof port.readHistory, 'function');
  return { port, read: port.readHistory!.bind(port), exit: () => exit };
}
function history() {
  const state = capacityHistory({ sessions: 3, resources: 9, receipts: 24, formats: 1 });
  const encoded = encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, MOBILE_PLAYBACK_DEFAULT_LIMITS);
  return { state, encoded, sessionId: state.sessions[1]!.id, context: deltaContext(state) };
}

test('归档真实Worker：独立读完整终态组与原回执，调用者可改写明文副本且原hot base仍可增量提交', { timeout: 30_000 }, async t => {
  const f = await fixture(t), archive = history();
  const hot = capacityHistory({ sessions: 1, resources: 2, receipts: 5, formats: 1 });
  const encoded = await f.port.encode(hot, deltaContext(hot)) as PlaybackStorageWithBase<EncodedPlaybackStorage>;
  assert.ok(encoded.base);
  const expected = decodePlaybackHistoryGroup(archive.encoded.bytes, archive.context, archive.sessionId);
  const plain = new Uint8Array(archive.encoded.bytes), length = plain.byteLength;
  const flight = f.read(plain, archive.context, archive.sessionId);
  assert.equal(plain.byteLength, length, '只能transfer专用副本，不得detach调用方快照。');
  plain.fill(0);
  const selected = await flight;
  assert.deepEqual(selected, expected);
  assert.equal(selected.sessions.length, 1);
  assert.ok(selected.resources.length > 0 && selected.receipts.length > 0);
  assert.ok(selected.resources.every(row => row.sessionId === archive.sessionId && row.state === 'terminal'));
  assert.ok(selected.receipts.every(row => row.sessionId === archive.sessionId));
  assert.equal(selected.revision, archive.state.revision); assert.equal(selected.commitId, archive.state.commitId);
  // 修改已取回的历史组也不能污染Worker当前热状态或其句柄。
  selected.receipts[0]!.fingerprint = '0'.repeat(64);
  const patch = deltaSession(hot, 301), candidate = deltaCandidate(hot, patch, 301);
  const next = await f.port.derive(encoded.base, patch, deltaContext(candidate));
  const oracle = encodePlaybackStorage(candidate, SERVER, DATASET, ORIGIN, MOBILE_PLAYBACK_DEFAULT_LIMITS);
  assert.deepEqual(next.state, candidate); assert.equal(next.canonical, oracle.canonical);
  assert.deepEqual(next.bytes, oracle.bytes);
  archive.encoded.bytes.fill(0); encoded.bytes.fill(0); next.bytes.fill(0); oracle.bytes.fill(0);
});

test('归档真实Worker：错scope/原revision/组身份、非终态和畸形快照仍拒绝，失败不覆盖hot base', { timeout: 30_000 }, async t => {
  const f = await fixture(t), archive = history();
  const hot = capacityHistory({ sessions: 1, resources: 1, receipts: 3, formats: 1 });
  const encoded = await f.port.encode(hot, deltaContext(hot)) as PlaybackStorageWithBase<EncodedPlaybackStorage>;
  await assert.rejects(f.read(archive.encoded.bytes, { ...archive.context, serverId: 'wrong.synthetic.server' }, archive.sessionId), busy);
  await assert.rejects(f.read(archive.encoded.bytes, { ...archive.context, revision: archive.context.revision + 1 }, archive.sessionId), busy);
  await assert.rejects(f.read(archive.encoded.bytes, archive.context, 'history.synthetic.missing-session'), busy);
  await assert.rejects(f.read(new Uint8Array(Buffer.from('{"invalid":true}')), archive.context, archive.sessionId), busy);
  await assert.rejects(f.read(new Uint8Array(MOBILE_PLAYBACK_DEFAULT_LIMITS.stateBytes + 1), archive.context, archive.sessionId), busy);
  const active = playbackCopy(archive.state); active.sessions[1]!.terminal = null;
  const activeBytes = encodePlaybackStorage(active, SERVER, DATASET, ORIGIN, MOBILE_PLAYBACK_DEFAULT_LIMITS).bytes;
  await assert.rejects(f.read(activeBytes, deltaContext(active), archive.sessionId), busy);
  const patch = deltaSession(hot, 302), candidate = deltaCandidate(hot, patch, 302);
  assert.deepEqual((await f.port.derive(encoded.base, patch, deltaContext(candidate))).state, candidate);
  archive.encoded.bytes.fill(0); activeBytes.fill(0); encoded.bytes.fill(0);
});

test('归档真实Worker：历史读取仍共用原两个在途job预算，完成后资格归还且可继续读取', { timeout: 30_000 }, async t => {
  const f = await fixture(t), archive = history();
  const first = f.read(archive.encoded.bytes, archive.context, archive.state.sessions[0]!.id);
  const second = f.read(archive.encoded.bytes, archive.context, archive.state.sessions[1]!.id);
  const rejected = assert.rejects(f.read(archive.encoded.bytes, archive.context, archive.state.sessions[2]!.id), busy);
  const groups = await Promise.all([first, second]); await rejected;
  assert.deepEqual(groups.map(group => group.sessions[0]!.id), archive.state.sessions.slice(0, 2).map(row => row.id));
  const next = await f.read(archive.encoded.bytes, archive.context, archive.state.sessions[2]!.id);
  assert.equal(next.sessions[0]!.id, archive.state.sessions[2]!.id); archive.encoded.bytes.fill(0);
});

test('归档真实Worker：展开超过公开2MiB的合法终态组仍守原私有逻辑帽，完整回执不被截断', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const state = capacityHistory({ sessions: 1, resources: 8, receipts: 900, formats: 20 });
  assert.ok(Buffer.byteLength(JSON.stringify(state)) > MOBILE_PLAYBACK_DEFAULT_LIMITS.stateBytes);
  const packed = encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, MOBILE_PLAYBACK_DEFAULT_LIMITS);
  assert.ok(packed.bytes.length <= MOBILE_PLAYBACK_DEFAULT_LIMITS.stateBytes);
  const hot = capacityHistory({ sessions: 1, resources: 1, receipts: 3, formats: 1 });
  const base = await f.port.encode(hot, deltaContext(hot)) as PlaybackStorageWithBase<EncodedPlaybackStorage>;
  const selected = await f.read(packed.bytes, deltaContext(state), state.sessions[0]!.id);
  assert.deepEqual(selected, state); assert.equal(selected.receipts.length, 900);
  const patch = deltaSession(hot, 303), candidate = deltaCandidate(hot, patch, 303);
  const next = await f.port.derive(base.base, patch, deltaContext(candidate));
  assert.deepEqual(next.state, candidate);
  packed.bytes.fill(0); base.bytes.fill(0); next.bytes.fill(0);
});

test('归档真实Worker：关闭撤回未发布历史结果并等待线程自然退出，关闭后不再准入', { timeout: 30_000 }, async t => {
  const f = await fixture(t, true), archive = history();
  const reading = f.read(archive.encoded.bytes, archive.context, archive.sessionId);
  const rejected = assert.rejects(reading, busy), closing = f.port.close();
  await rejected; await closing;
  assert.ok(f.exit(), '必须曾启动真实Worker。'); assert.equal(await f.exit(), 0);
  await assert.rejects(f.read(archive.encoded.bytes, archive.context, archive.sessionId), busy);
  archive.encoded.bytes.fill(0);
});
