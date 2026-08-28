import assert from 'node:assert/strict';
import test from 'node:test';
import type { RenderSide } from '@music-bridge/contracts';
import type { BeginRecordingAttemptInput, RecordingAttemptEvent } from '../src/recording/attempt-state.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (n = 0) => new Date(Date.UTC(2026, 7, 29, 0, 0, n)).toISOString();
const runA = id(5), runB = id(6);
function input(sides: RenderSide[] = ['A', 'B']): BeginRecordingAttemptInput {
  return { id: id(1), generation: runA, startedAt: at(), plan: {
    id: id(2), draftId: id(3), contentHash: 'a'.repeat(64), physicalCopy: { physicalId: sides[0] === 'Program' ? 'MB-D-00001' : 'MB-C-00001' },
    execution: { assetId: id(4), audio: sides.map(side => ({ recipe: { side }, recipeHash: 'd'.repeat(64), audio: { frameCount: 100, sha256: 'b'.repeat(64), pcmSha256: 'c'.repeat(64) } })) },
  } };
}
async function api() {
  const module = await import('../src/recording/attempt-state.js');
  assert.ok('beginRecordingAttempt' in module && 'reduceRecordingAttempt' in module && 'recoverRecordingAttempt' in module && 'isRecordingAttemptEvent' in module, '缺少纯Attempt状态机实现');
  return module as typeof import('../src/recording/attempt-state.js');
}
function output(type: 'progress' | 'source-eof' | 'backend-drained' | 'engine-cutoff' | 'stop-ack' | 'cleanup-quiescent', side: RenderSide = 'A', runId = runA, seconds = 1): RecordingAttemptEvent {
  return type === 'progress'
    ? { type, side, runId, at: at(seconds), sourceFramesRead: 100, submittedFrames: 100, consumedFrames: 100 }
    : { type, side, runId, at: at(seconds) };
}
async function readyForPhysical(sides: RenderSide[] = ['A']) {
  const m = await api(); let state = m.beginRecordingAttempt(input(sides));
  const side = sides[0]!;
  for (const event of [output('progress', side), output('source-eof', side, runA, 2), output('engine-cutoff', side, runA, 3), output('backend-drained', side, runA, 4)]) state = m.reduceRecordingAttempt(state, event);
  return { m, state };
}
function immutable<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) immutable(child); }
  return value;
}

test('开始只绑定传入Plan与非空执行音频，A/Program开始而B保持pending；纯函数不改输入', async () => {
  const m = await api(), seed = input(), original = structuredClone(seed), state = m.beginRecordingAttempt(immutable(seed));
  assert.deepEqual(seed, original); assert.equal(state.kind, 'formal'); assert.equal(state.planContentHash, seed.plan.contentHash);
  assert.equal(state.executionAssetId, seed.plan.execution.assetId); assert.equal(state.physicalId, seed.plan.physicalCopy.physicalId);
  assert.equal(state.phase, 'outputting'); assert.equal(state.activeSide, 'A'); assert.equal(state.revision, 1);
  assert.equal(state.sides[0]!.runId, runA); assert.equal(state.sides[1]!.phase, 'pending'); assert.equal(state.sides[1]!.runId, undefined);
  assert.equal(state.softwarePlaybackComplete, false); assert.equal(state.sides[0]!.backendDrained, false);
  assert.deepEqual(m.beginRecordingAttempt(input(['A'])).sides.map(s => s.side), ['A']);
  assert.deepEqual(m.beginRecordingAttempt(input(['Program'])).sides.map(s => s.side), ['Program']);
});

test('源EOF不等后端排空；停止ACK和资源静止不授予软件或实体完成', async () => {
  const m = await api(); let state = m.beginRecordingAttempt(input(['A']));
  state = m.reduceRecordingAttempt(state, output('progress'));
  state = m.reduceRecordingAttempt(state, output('source-eof', 'A', runA, 2));
  assert.equal(state.phase, 'draining'); assert.equal(state.softwarePlaybackComplete, false);
  for (const type of ['stop-ack', 'cleanup-quiescent', 'engine-cutoff'] as const) state = m.reduceRecordingAttempt(state, output(type, 'A', runA, 3));
  assert.equal(state.sides[0]!.backendDrained, false); assert.equal(state.softwarePlaybackComplete, false);
  assert.equal(state.status, 'in-progress'); assert.equal(state.physicalRecordingConfirmedAt, undefined);
  assert.throws(() => m.reduceRecordingAttempt(state, { type: 'confirm', kind: 'physical-stop', side: 'A', at: at(4) }), /INVALID_TRANSITION/u);
});

test('精确源帧/提交帧/消费帧单调，提前EOF/排空及错帧拒绝且不污染旧事实', async () => {
  const m = await api(), start = immutable(m.beginRecordingAttempt(input(['A'])));
  for (const event of [output('source-eof'), output('backend-drained'), { ...output('progress'), sourceFramesRead: 99, submittedFrames: 100 }, { ...output('progress'), consumedFrames: 101 }]) {
    assert.throws(() => m.reduceRecordingAttempt(start, event), /INVALID_TRANSITION|INVALID_REQUEST/u);
  }
  const partial = m.reduceRecordingAttempt(start, { type: 'progress', side: 'A', runId: runA, at: at(1), sourceFramesRead: 100, submittedFrames: 80, consumedFrames: 60 });
  const eof = m.reduceRecordingAttempt(partial, output('source-eof', 'A', runA, 2));
  assert.equal(eof.sides[0]!.sourceEof, true); assert.equal(eof.softwarePlaybackComplete, false);
  assert.throws(() => m.reduceRecordingAttempt(eof, output('backend-drained', 'A', runA, 3)), /INVALID_TRANSITION/u);
  assert.throws(() => m.reduceRecordingAttempt(partial, { type: 'progress', side: 'A', runId: runA, at: at(3), sourceFramesRead: 100, submittedFrames: 79, consumedFrames: 60 }), /INVALID_TRANSITION/u);
  assert.equal(start.sides[0]!.sourceFramesRead, 0);
});

test('A排空和实体停止后仍不开始B；必须翻面确认和新的显式B边界', async () => {
  const { m, state: drained } = await readyForPhysical(['A', 'B']);
  assert.equal(drained.phase, 'awaiting-physical-stop'); assert.equal(drained.sides[1]!.phase, 'pending');
  assert.throws(() => m.reduceRecordingAttempt(drained, { type: 'begin-side', side: 'B', runId: runB, at: at(5) }), /INVALID_TRANSITION/u);
  const stopped = m.reduceRecordingAttempt(drained, { type: 'confirm', kind: 'physical-stop', side: 'A', at: at(5) });
  assert.equal(stopped.phase, 'awaiting-flip'); assert.equal(stopped.activeSide, undefined); assert.equal(stopped.sides[1]!.runId, undefined);
  const flipped = m.reduceRecordingAttempt(stopped, { type: 'confirm', kind: 'flip', at: at(6) });
  assert.equal(flipped.phase, 'awaiting-side-b'); assert.equal(flipped.sides[1]!.phase, 'pending');
  assert.throws(() => m.reduceRecordingAttempt(flipped, { type: 'begin-side', side: 'B', runId: runA, at: at(7) }), /INVALID_TRANSITION/u);
  const playingB = m.reduceRecordingAttempt(flipped, { type: 'begin-side', side: 'B', runId: runB, at: at(7) });
  assert.equal(playingB.activeSide, 'B'); assert.equal(playingB.phase, 'outputting'); assert.equal(playingB.sides[1]!.runId, runB);
  assert.equal(playingB.sides[0]!.phase, 'complete'); assert.equal(playingB.sides[0]!.physicalStopConfirmedAt, at(5));
});

for (const side of ['A', 'Program'] as const) test(`${side}单段三层完成独立，空B/DAT不制造翻面或播放`, async () => {
  const { m, state: drained } = await readyForPhysical([side]);
  assert.equal(drained.softwarePlaybackComplete, true); assert.equal(drained.physicalRecordingConfirmedAt, undefined);
  assert.equal(drained.status, 'in-progress'); assert.equal(drained.sides.length, 1);
  assert.throws(() => m.reduceRecordingAttempt(drained, { type: 'confirm', kind: 'physical-recording', at: at(5) }), /INVALID_TRANSITION/u);
  const stopped = m.reduceRecordingAttempt(drained, { type: 'confirm', kind: 'physical-stop', side, at: at(5) });
  assert.equal(stopped.phase, 'final-verification');
  assert.throws(() => m.reduceRecordingAttempt(stopped, { type: 'confirm', kind: 'flip', at: at(6) }), /INVALID_TRANSITION/u);
  assert.throws(() => m.reduceRecordingAttempt(stopped, { type: 'confirm', kind: 'final-verification', at: at(6) }), /INVALID_TRANSITION/u);
  const recorded = m.reduceRecordingAttempt(stopped, { type: 'confirm', kind: 'physical-recording', at: at(6) });
  assert.equal(recorded.status, 'in-progress'); assert.equal(recorded.physicalRecordingConfirmedAt, at(6)); assert.equal(recorded.finalVerificationCompleteAt, undefined);
  const complete = m.reduceRecordingAttempt(recorded, { type: 'confirm', kind: 'final-verification', at: at(7) });
  assert.equal(complete.status, 'completed'); assert.equal(complete.phase, 'finished'); assert.equal(complete.endedAt, at(7));
  assert.equal(complete.finalVerificationCompleteAt, at(7)); assert.equal(complete.reason, undefined);
});

test('两面都要精确完成，B物理停止后才允许全局确认', async () => {
  const { m, state } = await readyForPhysical(['A', 'B']); let next = state;
  for (const event of [{ type: 'confirm', kind: 'physical-stop', side: 'A', at: at(5) }, { type: 'confirm', kind: 'flip', at: at(6) }, { type: 'begin-side', side: 'B', runId: runB, at: at(7) }] as const) next = m.reduceRecordingAttempt(next, event);
  assert.equal(next.softwarePlaybackComplete, false);
  for (const event of [output('progress', 'B', runB, 8), output('source-eof', 'B', runB, 9), output('engine-cutoff', 'B', runB, 10), output('backend-drained', 'B', runB, 11)]) next = m.reduceRecordingAttempt(next, event);
  assert.equal(next.softwarePlaybackComplete, true); assert.equal(next.status, 'in-progress');
  for (const event of [{ type: 'confirm', kind: 'physical-stop', side: 'B', at: at(12) }, { type: 'confirm', kind: 'physical-recording', at: at(13) }, { type: 'confirm', kind: 'final-verification', at: at(14) }] as const) next = m.reduceRecordingAttempt(next, event);
  assert.equal(next.status, 'completed'); assert.deepEqual(next.sides.map(s => s.phase), ['complete', 'complete']);
});

for (const [type, reason, expected] of [['abort', 'user-stop', 'aborted'], ['fail', 'backend-start-failed', 'failed'], ['interrupt', 'underrun', 'interrupted']] as const) test(`${expected}锁存首个终因；迟到成功不改Completed，清理证据可追加`, async () => {
  const m = await api(), start = m.beginRecordingAttempt(input(['A', 'B']));
  const terminal = m.reduceRecordingAttempt(start, type === 'abort' ? { type, reason, at: at(1) } : type === 'fail' ? { type, reason: 'backend-start-failed', side: 'A', runId: runA, at: at(1) } : { type, reason: 'underrun', side: 'A', runId: runA, at: at(1) });
  assert.equal(terminal.status, expected); assert.equal(terminal.reason, reason); assert.equal(terminal.endedAt, at(1)); assert.equal(terminal.activeSide, undefined);
  for (const event of [output('progress', 'A', runA, 2), output('source-eof', 'A', runA, 2), output('backend-drained', 'A', runA, 2), { type: 'interrupt', reason: 'device-lost', side: 'A', runId: runA, at: at(2) }] as RecordingAttemptEvent[]) assert.deepEqual(m.reduceRecordingAttempt(terminal, event), terminal);
  let cleaned = terminal;
  for (const type of ['engine-cutoff', 'stop-ack', 'cleanup-quiescent'] as const) cleaned = m.reduceRecordingAttempt(cleaned, output(type, 'A', runA, 3));
  assert.equal(cleaned.status, expected); assert.equal(cleaned.reason, reason); assert.equal(cleaned.endedAt, at(1));
  assert.equal(cleaned.sides[0]!.engineStoppedSubmitting, true); assert.equal(cleaned.sides[0]!.stopAcknowledged, true); assert.equal(cleaned.sides[0]!.cleanupQuiescent, true);
  assert.equal(cleaned.revision, terminal.revision + 3); assert.equal(cleaned.softwarePlaybackComplete, false);
  assert.deepEqual(m.reduceRecordingAttempt(cleaned, output('cleanup-quiescent', 'A', runA, 4)), cleaned);
});

test('输出事件必须匹配side/runId；旧代际和未开始B不改变revision或原因', async () => {
  const m = await api(), start = m.beginRecordingAttempt(input());
  for (const event of [output('progress', 'A', id(90)), output('backend-drained', 'B', runB), output('engine-cutoff', 'Program', runA)]) assert.deepEqual(m.reduceRecordingAttempt(start, event), start);
  assert.throws(() => m.reduceRecordingAttempt(start, { type: 'confirm', kind: 'physical-stop', side: 'B', at: at(1) }), /INVALID_TRANSITION/u);
});

test('重启所有非终态只Interrupted一次，保留已完成A/翻面和帧事实，不自动开始B', async () => {
  const { m, state } = await readyForPhysical(['A', 'B']);
  const stopped = m.reduceRecordingAttempt(state, { type: 'confirm', kind: 'physical-stop', side: 'A', at: at(5) });
  const flipped = m.reduceRecordingAttempt(stopped, { type: 'confirm', kind: 'flip', at: at(6) });
  for (const current of [m.beginRecordingAttempt(input()), state, stopped, flipped]) {
    const original = structuredClone(current), recovered = m.recoverRecordingAttempt(immutable(current), at(10));
    assert.deepEqual(current, original); assert.equal(recovered.status, 'interrupted'); assert.equal(recovered.reason, 'app-restarted'); assert.equal(recovered.activeSide, undefined);
    assert.equal(recovered.revision, current.revision + 1); assert.equal(recovered.sides[1]!.phase, 'pending');
    assert.equal(recovered.sides[0]!.sourceFramesRead, current.sides[0]!.sourceFramesRead); assert.equal(recovered.flipConfirmedAt, current.flipConfirmedAt);
    assert.deepEqual(m.recoverRecordingAttempt(recovered, at(11)), recovered);
    assert.deepEqual(m.reduceRecordingAttempt(current, { type: 'recover', at: at(10) }), recovered);
  }
});

test('公开确认不能重开终态；后端启动失败不能抹去已经提交的帧', async () => {
  const m = await api(), start = m.beginRecordingAttempt(input(['A']));
  const progressed = m.reduceRecordingAttempt(start, output('progress'));
  assert.throws(() => m.reduceRecordingAttempt(progressed, { type: 'fail', reason: 'backend-start-failed', side: 'A', runId: runA, at: at(2) }), /INVALID_TRANSITION/u);
  const interrupted = m.reduceRecordingAttempt(progressed, { type: 'interrupt', reason: 'source-read-failed', side: 'A', runId: runA, at: at(2) });
  assert.throws(() => m.reduceRecordingAttempt(interrupted, { type: 'confirm', kind: 'physical-recording', at: at(3) }), /INVALID_TRANSITION/u);
  assert.deepEqual(m.recoverRecordingAttempt(interrupted, at(4)), interrupted);
});

test('内部事件严格判别联合，拒绝未知类型/key、路径、伪造side与非整数帧；纯时间明确输入', async () => {
  const m = await api();
  const valid: RecordingAttemptEvent[] = [output('progress'), output('source-eof'), output('backend-drained'), output('engine-cutoff'), output('stop-ack'), output('cleanup-quiescent'), { type: 'begin-side', side: 'B', runId: runB, at: at(1) }, { type: 'confirm', kind: 'flip', at: at(1) }, { type: 'recover', at: at(1) }];
  for (const event of valid) assert.equal(m.isRecordingAttemptEvent(event), true);
  for (const bad of [{ type: 'start-device', at: at() }, { ...output('progress'), sourceFramesRead: 0.5 }, { ...output('progress'), consumedFrames: -1 }, { ...output('progress'), absolutePath: '/synthetic/forbidden' }, { ...output('source-eof'), side: 'C' }, { type: 'confirm', kind: 'flip', side: 'A', at: at() }, { type: 'recover', at: 'yesterday' }, { type: 'interrupt', reason: 'user-stop', at: at() }]) assert.equal(m.isRecordingAttemptEvent(bad), false);
  const state = m.beginRecordingAttempt(input(['A']));
  assert.throws(() => m.reduceRecordingAttempt(state, { type: 'recover', at: at(-1) }), /INVALID_REQUEST/u);
});

test('待最终核实重启保留三层已有证据；已经Completed的历史不被恢复重写', async () => {
  const { m, state } = await readyForPhysical(['Program']);
  const stopped = m.reduceRecordingAttempt(state, { type: 'confirm', kind: 'physical-stop', side: 'Program', at: at(5) });
  const recorded = m.reduceRecordingAttempt(stopped, { type: 'confirm', kind: 'physical-recording', at: at(6) });
  for (const current of [stopped, recorded]) {
    const recovered = m.recoverRecordingAttempt(current, at(8));
    assert.equal(recovered.status, 'interrupted'); assert.equal(recovered.softwarePlaybackComplete, true);
    assert.equal(recovered.physicalRecordingConfirmedAt, current.physicalRecordingConfirmedAt);
    assert.equal(recovered.finalVerificationCompleteAt, undefined); assert.deepEqual(recovered.sides, current.sides);
  }
  const complete = m.reduceRecordingAttempt(recorded, { type: 'confirm', kind: 'final-verification', at: at(7) });
  assert.deepEqual(m.recoverRecordingAttempt(complete, at(9)), complete);
});

test('停止提交与后端排空可独立到达，但实体stop确认必须等引擎停止提交', async () => {
  const m = await api(); let state = m.beginRecordingAttempt(input(['A']));
  for (const event of [output('progress'), output('source-eof', 'A', runA, 2), output('backend-drained', 'A', runA, 3)]) state = m.reduceRecordingAttempt(state, event);
  assert.equal(state.softwarePlaybackComplete, true); assert.equal(state.sides[0]!.engineStoppedSubmitting, false);
  assert.throws(() => m.reduceRecordingAttempt(state, { type: 'confirm', kind: 'physical-stop', side: 'A', at: at(4) }), /INVALID_TRANSITION/u);
  state = m.reduceRecordingAttempt(state, output('engine-cutoff', 'A', runA, 4));
  assert.equal(m.reduceRecordingAttempt(state, { type: 'confirm', kind: 'physical-stop', side: 'A', at: at(5) }).sides[0]!.phase, 'complete');
});

test('B运行后A的迟到故障无效，但同A清理证据仍可追加而不停止B', async () => {
  const { m, state } = await readyForPhysical(['A', 'B']); let next = state;
  for (const event of [{ type: 'confirm', kind: 'physical-stop', side: 'A', at: at(5) }, { type: 'confirm', kind: 'flip', at: at(6) }, { type: 'begin-side', side: 'B', runId: runB, at: at(7) }] as const) next = m.reduceRecordingAttempt(next, event);
  const unchanged = m.reduceRecordingAttempt(next, { type: 'interrupt', side: 'A', runId: runA, reason: 'device-lost', at: at(8) });
  assert.deepEqual(unchanged, next);
  const cleaned = m.reduceRecordingAttempt(next, output('cleanup-quiescent', 'A', runA, 8));
  assert.equal(cleaned.status, 'in-progress'); assert.equal(cleaned.activeSide, 'B'); assert.equal(cleaned.sides[0]!.cleanupQuiescent, true);
  assert.equal(cleaned.sides[1]!.engineStoppedSubmitting, false);
});


test('旧侧迟到事件即使携带早于当前B的时间也完全失效，不误报当前运行错误', async () => {
  const { m, state } = await readyForPhysical(['A', 'B']); let next = state;
  for (const event of [{ type: 'confirm', kind: 'physical-stop', side: 'A', at: at(5) }, { type: 'confirm', kind: 'flip', at: at(6) }, { type: 'begin-side', side: 'B', runId: runB, at: at(7) }] as const) next = m.reduceRecordingAttempt(next, event);
  assert.deepEqual(m.reduceRecordingAttempt(next, output('progress', 'A', runA, 1)), next);
  assert.deepEqual(m.reduceRecordingAttempt(next, { type: 'interrupt', side: 'A', runId: runA, reason: 'device-lost', at: at(1) }), next);
});

test('内部事件runId必须精确UUID，尾换行不可进入持久事件账本', async () => {
  const m = await api();
  assert.equal(m.isRecordingAttemptEvent({ ...output('progress'), runId: runA + '\n' }), false);
  assert.equal(m.isRecordingAttemptEvent({ type: 'begin-side', side: 'B', runId: runB + '\n', at: at(1) }), false);
});

test('中断后可独立确认已开始面的实体停止，不能改终因或虚报软件/录制完成', async () => {
  const m = await api(), start = m.beginRecordingAttempt(input());
  const interrupted = m.reduceRecordingAttempt(start, { type: 'interrupt', side: 'A', runId: runA, reason: 'underrun', at: at(1) });
  const confirmed = m.reduceRecordingAttempt(interrupted, { type: 'confirm', kind: 'physical-stop', side: 'A', at: at(2) });
  assert.equal(confirmed.sides[0]!.physicalStopConfirmedAt, at(2)); assert.equal(confirmed.sides[0]!.endedAt, at(1));
  assert.equal(confirmed.status, 'interrupted'); assert.equal(confirmed.reason, 'underrun'); assert.equal(confirmed.endedAt, at(1));
  assert.equal(confirmed.softwarePlaybackComplete, false); assert.equal(confirmed.physicalRecordingConfirmedAt, undefined);
  assert.equal(confirmed.sides[0]!.engineStoppedSubmitting, false); assert.equal(confirmed.sides[0]!.backendDrained, false);
  assert.deepEqual(m.reduceRecordingAttempt(confirmed, { type: 'confirm', kind: 'physical-stop', side: 'A', at: at(3) }), confirmed);
  assert.throws(() => m.reduceRecordingAttempt(interrupted, { type: 'confirm', kind: 'physical-stop', side: 'B', at: at(2) }), /INVALID_TRANSITION/u);
});
