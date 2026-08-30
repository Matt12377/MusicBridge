import assert from 'node:assert/strict';
import test from 'node:test';
import * as c from '../src/index.js';

const id = (n: number): string => `74000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hash = 'a'.repeat(64), at = '2026-08-29T10:00:00.000Z', later = '2026-08-29T10:00:01.000Z', end = '2026-08-29T10:00:02.000Z';
function side(name: 'A' | 'B' | 'Program' = 'A'): c.RecordingAttemptSide {
  return { side: name, phase: 'outputting', frameCount: 100, recipeHash: hash, audioSha256: hash, pcmSha256: hash,
    runId: id(name === 'B' ? 8 : 7), sourceFramesRead: 0, submittedFrames: 0, consumedFrames: 0,
    sourceEof: false, backendDrained: false, engineStoppedSubmitting: false, stopAcknowledged: false, cleanupQuiescent: false, startedAt: at };
}
function pending(): c.RecordingAttemptSide { const value = side('B'); value.phase = 'pending'; delete value.runId; delete value.startedAt; return value; }
function completeSide(name: 'A' | 'B' | 'Program' = 'A'): c.RecordingAttemptSide {
  return { ...side(name), phase: 'complete', sourceFramesRead: 100, submittedFrames: 100, consumedFrames: 100,
    sourceEof: true, backendDrained: true, engineStoppedSubmitting: true, physicalStopConfirmedAt: later, endedAt: later };
}
function attempt(): c.RecordingAttempt {
  return { kind: 'formal', id: id(1), draftId: id(2), planVersionId: id(3), planContentHash: hash, executionAssetId: id(4), physicalId: 'MB-C-00001',
    revision: 1, createdAt: at, updatedAt: at, status: 'in-progress', phase: 'outputting', activeSide: 'A', sides: [side()], softwarePlaybackComplete: false };
}
function completed(): c.RecordingAttempt {
  const value = attempt(); delete value.activeSide;
  return { ...value, status: 'completed', phase: 'finished', sides: [completeSide()], softwarePlaybackComplete: true,
    updatedAt: end, endedAt: end, physicalRecordingConfirmedAt: later, finalVerificationCompleteAt: end };
}
const begin = { commandId: id(10), planVersionId: id(3), planContentHash: hash, userConfirmed: true };
const confirm = { commandId: id(11), attemptId: id(1), expectedRevision: 1, userConfirmed: true, kind: 'physical-stop', side: 'A' };
const beginSide = { commandId: id(12), attemptId: id(1), expectedRevision: 2, userConfirmed: true, side: 'B' };
const stop = { commandId: id(13), attemptId: id(1) };

test('Attempt请求只接受明确计划/命令身份，不接受认证、路径和后端事件', () => {
  assert.equal(typeof c.isBeginRecordingAttemptRequest, 'function', 'Attempt合同尚未实现');
  assert.equal(c.isBeginRecordingAttemptRequest(begin), true);
  for (const patch of [{ planVersionId: 'latest' }, { planContentHash: `${hash}\n` }, { commandId: `${id(10)}\n` }, { userConfirmed: false }, { gateB: 'PASS' }, { certificate: {} }, { path: '/private/audio' }, { driverEvent: 'drained' }, { side: 'B' }]) assert.equal(c.isBeginRecordingAttemptRequest({ ...begin, ...patch }), false);
  assert.equal(c.isRecordingAttemptIdRequest({ attemptId: id(1) }), true);
  assert.equal(c.isRecordingAttemptIdRequest({ id: id(1) }), false);
});

test('人工确认按kind限定side及CAS；BeginSide仅B；停止不要求陈旧revision', () => {
  assert.equal(typeof c.isConfirmRecordingAttemptRequest, 'function');
  assert.equal(c.isConfirmRecordingAttemptRequest(confirm), true);
  for (const side of ['A', 'B', 'Program']) assert.equal(c.isConfirmRecordingAttemptRequest({ ...confirm, side }), true);
  for (const kind of ['flip', 'physical-recording', 'final-verification']) {
    const value = { ...confirm, kind }; delete (value as Partial<typeof value>).side;
    assert.equal(c.isConfirmRecordingAttemptRequest(value), true);
    assert.equal(c.isConfirmRecordingAttemptRequest({ ...value, side: 'A' }), false);
  }
  for (const patch of [{ kind: 'source-eof' }, { kind: 'backend-drained' }, { expectedRevision: 0 }, { expectedRevision: 1.1 }, { userConfirmed: false }, { side: undefined }]) assert.equal(c.isConfirmRecordingAttemptRequest({ ...confirm, ...patch }), false);
  assert.equal(c.isBeginRecordingAttemptSideRequest(beginSide), true);
  for (const side of ['A', 'Program', 'all']) assert.equal(c.isBeginRecordingAttemptSideRequest({ ...beginSide, side }), false);
  assert.equal(c.isStopRecordingAttemptRequest(stop), true);
  assert.equal(c.isStopRecordingAttemptRequest({ ...stop, expectedRevision: 1 }), false);
  assert.equal(c.isStopRecordingAttemptRequest({ ...stop, reason: 'backend-failure' }), false);
});

test('正式快照保留Plan、执行与实体身份；拒绝认证字段和未知嵌套key', () => {
  assert.equal(typeof c.isRecordingAttempt, 'function');
  assert.equal(c.isRecordingAttempt(attempt()), true);
  for (const patch of [{ kind: 'synthetic' }, { id: `${id(1)}\n` }, { physicalId: 'MB-C-00001\n' }, { planContentHash: 'A'.repeat(64) }, { revision: 0 }, { createdAt: '2026-02-30T10:00:00.000Z' }, { updatedAt: '2026-08-28T10:00:00.000Z' }, { gateB: 'PASS' }, { formalReady: true }, { unknown: true }]) assert.equal(c.isRecordingAttempt({ ...attempt(), ...patch }), false);
  for (const patch of [{ recipeHash: '' }, { audioSha256: `${hash}\n` }, { pcmSha256: 'A'.repeat(64) }, { outputPath: '/audio' }, { phase: 'ready' }, { runId: undefined }]) assert.equal(c.isRecordingAttemptSide({ ...side(), ...patch }), false);
});

test('每侧帧数与EOF/排空独立且有序，拒绝短消费虚报软件完成', () => {
  assert.equal(typeof c.isRecordingAttemptSide, 'function');
  for (const frameCount of [0, -1, 1.2, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.equal(c.isRecordingAttemptSide({ ...side(), frameCount }), false);
  for (const patch of [{ consumedFrames: 1 }, { submittedFrames: 1 }, { sourceFramesRead: 101 }, { sourceEof: true }, { backendDrained: true }]) assert.equal(c.isRecordingAttemptSide({ ...side(), ...patch }), false);
  const value = attempt(); value.phase = 'draining'; value.sides = [{ ...side(), phase: 'draining', sourceFramesRead: 100, submittedFrames: 40, consumedFrames: 30, sourceEof: true }];
  assert.equal(c.isRecordingAttempt(value), true);
  assert.equal(c.isRecordingAttempt({ ...value, softwarePlaybackComplete: true }), false);
  value.phase = 'awaiting-physical-stop'; value.sides = [{ ...value.sides[0]!, phase: 'awaiting-physical-stop', submittedFrames: 100, consumedFrames: 100, backendDrained: true }]; value.softwarePlaybackComplete = true;
  assert.equal(c.isRecordingAttempt(value), true, '软件完成不能依赖实体确认，也不代表引擎停止或实体完成');
  assert.equal(c.isRecordingAttempt({ ...value, softwarePlaybackComplete: false }), false);
});

test('完成必须非空面全部complete、实体录制及最终核实分别成立', () => {
  assert.equal(typeof c.isRecordingAttempt, 'function');
  assert.equal(c.isRecordingAttempt(completed()), true);
  for (const key of ['physicalRecordingConfirmedAt', 'finalVerificationCompleteAt', 'endedAt'] as const) { const value = completed(); delete value[key]; assert.equal(c.isRecordingAttempt(value), false); }
  for (const patch of [{ sourceEof: false }, { backendDrained: false }, { engineStoppedSubmitting: false }, { physicalStopConfirmedAt: undefined }, { consumedFrames: 99 }]) assert.equal(c.isRecordingAttempt({ ...completed(), sides: [{ ...completeSide(), ...patch }] }), false);
  assert.equal(c.isRecordingAttempt({ ...completed(), reason: 'underrun' }), false);
  assert.equal(c.isRecordingAttempt({ ...completed(), activeSide: 'A' }), false);
  assert.equal(c.isRecordingAttempt({ ...completed(), status: 'in-progress', phase: 'final-verification' }), false);
});

test('A-only与DAT不造空B或翻面证据，A/B只能在A实体停止并翻面后开始B', () => {
  assert.equal(typeof c.isRecordingAttempt, 'function');
  const value = attempt(); value.sides = [completeSide(), pending()]; value.updatedAt = later; value.phase = 'awaiting-flip'; delete value.activeSide;
  assert.equal(c.isRecordingAttempt(value), true);
  value.phase = 'awaiting-side-b'; value.flipConfirmedAt = later; assert.equal(c.isRecordingAttempt(value), true);
  value.phase = 'outputting'; value.activeSide = 'B'; value.updatedAt = end; value.sides = [completeSide(), { ...side('B'), startedAt: end }];
  assert.equal(c.isRecordingAttempt(value), true);
  const noFlip = structuredClone(value); delete noFlip.flipConfirmedAt; assert.equal(c.isRecordingAttempt(noFlip), false);
  assert.equal(c.isRecordingAttempt({ ...value, sides: [side(), side('B')] }), false);
  assert.equal(c.isRecordingAttempt({ ...value, sides: [completeSide(), { ...side('B'), runId: id(7), startedAt: end }] }), false);
  const dat = completed(); dat.physicalId = 'MB-D-00001'; dat.sides = [completeSide('Program')]; assert.equal(c.isRecordingAttempt(dat), true);
  assert.equal(c.isRecordingAttempt({ ...dat, flipConfirmedAt: later }), false);
  assert.equal(c.isRecordingAttempt({ ...completed(), flipConfirmedAt: later }), false);
  for (const sides of [[], [side('B')], [side('Program'), pending()], [side(), { ...pending(), frameCount: 0 }]]) assert.equal(c.isRecordingAttempt({ ...attempt(), sides }), false);
});

test('pending侧无伪造执行事实，阶段/activeSide与时间保持一致', () => {
  assert.equal(typeof c.isRecordingAttemptSide, 'function');
  assert.equal(c.isRecordingAttemptSide(pending()), true);
  for (const patch of [{ runId: id(8) }, { startedAt: at }, { sourceFramesRead: 1 }, { engineStoppedSubmitting: true }, { stopAcknowledged: true }, { cleanupQuiescent: true }, { physicalStopConfirmedAt: later }]) assert.equal(c.isRecordingAttemptSide({ ...pending(), ...patch }), false);
  for (const patch of [{ activeSide: 'B' }, { phase: 'draining' }, { endedAt: later }, { reason: 'underrun' }]) assert.equal(c.isRecordingAttempt({ ...attempt(), ...patch }), false);
  assert.equal(c.isRecordingAttempt({ ...attempt(), sides: [{ ...side(), startedAt: later }] }), false);
  assert.equal(c.isRecordingAttemptSide({ ...completeSide(), endedAt: at }), false);
});

test('中断与清理事实分离，合法迟到清理不抹终态；终态不能伪造完成', () => {
  assert.equal(typeof c.isRecordingAttempt, 'function');
  const value = attempt(); delete value.activeSide;
  value.status = 'interrupted'; value.phase = 'finished'; value.reason = 'underrun'; value.endedAt = later; value.updatedAt = later;
  value.sides = [{ ...side(), phase: 'interrupted', reason: 'underrun', endedAt: later }];
  assert.equal(c.isRecordingAttempt(value), true);
  value.revision = 2; value.updatedAt = end; Object.assign(value.sides[0]!, { engineStoppedSubmitting: true, stopAcknowledged: true, cleanupQuiescent: true, physicalStopConfirmedAt: end });
  assert.equal(c.isRecordingAttempt(value), true);
  assert.equal(c.isRecordingAttempt({ ...value, status: 'completed' }), false);
  for (const status of ['aborted', 'failed', 'interrupted']) assert.equal(c.isRecordingAttempt({ ...value, status, reason: undefined }), false);
  assert.equal(c.isRecordingAttempt({ ...value, phase: 'outputting', activeSide: 'A' }), false);
});

test('分页最多25、拒绝重复ID和不一致分页事实', () => {
  assert.equal(typeof c.isRecordingAttemptsPage, 'function');
  assert.equal(c.MAX_RECORDING_ATTEMPT_PAGE_SIZE, 25);
  const request = { page: { offset: 0, limit: 25 }, draftId: id(2), planVersionId: id(3), physicalId: 'MB-C-00001' };
  assert.equal(c.isListRecordingAttemptsRequest(request), true);
  for (const page of [{ offset: -1, limit: 1 }, { offset: 0, limit: 26 }, { offset: 0, limit: 0 }, { offset: 1.2, limit: 1 }, { offset: Number.MAX_SAFE_INTEGER + 1, limit: 1 }, { offset: 0, limit: 1, all: true }]) assert.equal(c.isListRecordingAttemptsRequest({ ...request, page }), false);
  const page = { items: [attempt()], offset: 0, limit: 25, total: 1, hasMore: false };
  assert.equal(c.isRecordingAttemptsPage(page), true);
  assert.equal(c.isRecordingAttemptsPage({ ...page, items: [], total: 0 }), true);
  for (const patch of [{ items: Array.from({ length: 26 }, () => attempt()), total: 26 }, { items: [attempt(), attempt()], total: 2 }, { hasMore: true }, { total: 0 }, { offset: -1 }, { limit: 26 }, { certification: 'PASS' }]) assert.equal(c.isRecordingAttemptsPage({ ...page, ...patch }), false);
});

test('六个IPC请求与响应闭合，未知key及伪造后端命令拒绝', () => {
  const cases = {
    'recordingAttempts.list': [{ page: { offset: 0, limit: 25 } }, { items: [attempt()], offset: 0, limit: 25, total: 1, hasMore: false }],
    'recordingAttempts.get': [{ attemptId: id(1) }, { attempt: attempt() }],
    'recordingAttempts.begin': [begin, attempt()], 'recordingAttempts.confirm': [confirm, completed()],
    'recordingAttempts.beginSide': [beginSide, attempt()], 'recordingAttempts.stop': [stop, attempt()],
  };
  for (const [command, [payload, result]] of Object.entries(cases)) {
    assert.equal(c.validateIpcRequest({ version: 1, id: 'attempt', command, payload }).ok, true, command);
    assert.equal(c.validateIpcRequest({ version: 1, id: 'attempt', command, payload: { ...payload, certified: true } }).ok, false, command);
    assert.equal(c.validateIpcResponseForCommand({ version: 1, id: 'attempt', ok: true, result }, command as c.IpcCommand).ok, true, command);
    assert.equal(c.validateIpcResponseForCommand({ version: 1, id: 'attempt', ok: true, result: { ...result, unknown: true } }, command as c.IpcCommand).ok, false, command);
    assert.equal(c.isCommandOutboxTrackedCommand(command), false, command);
  }
  assert.equal(c.validateIpcResponseForCommand({ version: 1, id: 'attempt', ok: true, result: { attempt: null } }, 'recordingAttempts.get').ok, true);
  for (const command of ['recordingAttempts.certify', 'recordingAttempts.backendEvent', 'recordingAttempts.resume', 'recordingAttempts.authorize']) assert.equal(c.validateIpcRequest({ version: 1, id: 'attempt', command, payload: {} }).ok, false);
});

test('GateB阻断使用既有NOT_READY公开错误，领域码不能伪装已注册IPC错误', () => {
  const error = { code: 'NOT_READY', message: 'Gate B 尚未认证，不能开始正式录音。' };
  assert.equal(c.validateIpcResponseForCommand({ version: 1, id: 'attempt', ok: false, error }, 'recordingAttempts.begin').ok, true);
  assert.equal(c.validateIpcResponseForCommand({ version: 1, id: 'attempt', ok: false, error: { ...error, code: 'BACKEND_NOT_CERTIFIED' } }, 'recordingAttempts.begin').ok, false);
});

test('终态的侧终因/时间须与Attempt一致，不混淆主动中止、启动失败和中断', () => {
  const value = attempt(); delete value.activeSide;
  Object.assign(value, { status: 'interrupted', phase: 'finished', reason: 'underrun', endedAt: later, updatedAt: end });
  value.sides = [{ ...side(), phase: 'interrupted', reason: 'underrun', endedAt: later }];
  assert.equal(c.isRecordingAttempt(value), true);
  assert.equal(c.isRecordingAttempt({ ...value, endedAt: at }), false);
  assert.equal(c.isRecordingAttempt({ ...value, sides: [{ ...value.sides[0]!, reason: 'device-lost' }] }), false);
  for (const status of ['aborted', 'failed']) assert.equal(c.isRecordingAttempt({ ...value, status }), false);
});

test('数组超预算在深入项校验前拒绝，不扫描无界Side或History', () => {
  const oversizedSides = Array.from({ length: 3 }, () => side());
  Object.defineProperty(oversizedSides, 0, { get() { throw new Error('不应深入超预算Side') } });
  assert.doesNotThrow(() => assert.equal(c.isRecordingAttempt({ ...attempt(), sides: oversizedSides }), false));
  const oversizedItems = Array.from({ length: 26 }, () => attempt());
  Object.defineProperty(oversizedItems, 0, { get() { throw new Error('不应深入超预算History') } });
  assert.doesNotThrow(() => assert.equal(c.isRecordingAttemptsPage({ items: oversizedItems, offset: 0, limit: 25, total: 26, hasMore: true }), false));
});
