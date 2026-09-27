import assert from 'node:assert/strict';
import test from 'node:test';
import * as c from '../src/index.js';
const id = (n: number): string => `76000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hash = (value = 'a'): string => value.repeat(64);
const at = '2026-08-29T00:00:00.000Z', later = '2026-08-29T00:00:01.000Z';
function audio(target: 'actual-execution' | 'original-render' = 'actual-execution') {
  const common = { fileSha256: hash(), size: 192044, frameCount: 48000, format: { container: 'wav', sampleRate: 48000, channelCount: 2, sampleFormat: 'pcm-s16le' }, pcmSha256: hash('b') };
  return target === 'actual-execution' ? { ...common, target, executionAssetId: id(4), recipeHash: hash('c'), pcmHashEvidence: 'frozen-execution' } : { ...common, target, preparedVersionId: id(5), renderAssetId: id(6), pcmHashEvidence: 'verified-render-bytes' };
}
function historical() { return { recordingId: id(1), recordingContentHash: hash('d'), planVersionId: id(2), planContentHash: hash('e'), archiveOperationId: id(3), archiveManifestHash: hash('f') }; }
function inspection() { return { ...historical(), readId: id(7), checkedAt: at, fingerprint: hash(), targets: [{ target: 'actual-execution', side: 'A', state: 'verified', audio: audio() }, { target: 'actual-execution', side: 'B', state: 'empty', frameCount: 0 }], playback: 'blocked', deviceOpened: false, formalReady: false, gateB: 'NOT_RUN' }; }
function request() { return { runId: id(8), recordingId: id(1), target: 'actual-execution', side: 'A', expectedFingerprint: hash(), userConfirmed: true }; }
function session() { return { kind: 'session', runId: id(8), request: request(), revision: 1, createdAt: at, updatedAt: at, state: 'starting', identity: null, progress: null, started: false, stopRequested: false, cleanupQuiescent: false, evidence: 'none', deviceOpened: false, formalReady: false, gateB: 'NOT_RUN' }; }
function running() { return { ...session(), state: 'consuming', started: true, startedAt: at, evidence: 'synthetic-only', identity: { ...historical(), target: 'actual-execution', side: 'A', fingerprint: hash(), audio: audio() }, progress: { sourceFramesRead: 12000, submittedFrames: 12000, consumedFrames: 8000, sourceEof: false, backendDrained: false } }; }
function finished() { return { ...running(), state: 'finished', updatedAt: later, endedAt: later, cleanupQuiescent: true, progress: { sourceFramesRead: 48000, submittedFrames: 48000, consumedFrames: 48000, sourceEof: true, backendDrained: true } }; }
function tombstone() { return { kind: 'cancelled-before-start', runId: id(8), state: 'cancelled', started: false, stopRequested: true, cleanupQuiescent: true, evidence: 'none', deviceOpened: false, formalReady: false, gateB: 'NOT_RUN' }; }
test('默认状态只表示后端blocked，拒绝认证/设备/私有provider字段', () => {
  assert.equal(typeof c.isRecordingReplicaStatus, 'function', 'Replica合同尚未实现');
  const value = { playback: 'blocked', reason: 'BACKEND_UNAVAILABLE', deviceAccess: 'not-authorized', deviceOpened: false, formalReady: false, gateB: 'NOT_RUN' };
  assert.equal(c.isRecordingReplicaStatus(value), true);
  assert.equal(c.isRecordingReplicaStatus({ ...value, reason: 'OUTPUT_RUN_UNVERIFIED' }), true);
  for (const patch of [{ playback: 'available' }, { deviceOpened: true }, { formalReady: true }, { gateB: 'PASS' }, { provider: 'synthetic' }, { path: '/private/output' }]) assert.equal(c.isRecordingReplicaStatus({ ...value, ...patch }), false);
});
test('六API输入严格且start只给明确历史selection与预览指纹，不给路径/参数/认证', () => {
  assert.equal(typeof c.isStartRecordingReplicaRequest, 'function'); assert.equal(c.isStartRecordingReplicaRequest(request()), true);
  assert.equal(c.isInspectRecordingReplicaRequest({ readId: id(7), recordingId: id(1) }), true);
  assert.equal(c.isRecordingReplicaReadIdRequest({ readId: id(7) }), true); assert.equal(c.isRecordingReplicaRunIdRequest({ runId: id(8) }), true);
  for (const patch of [{ runId: `${id(8)}\n` }, { expectedFingerprint: `${hash()}\n` }, { side: 'all' }, { target: 'latest' }, { userConfirmed: false }, { provider: 'synthetic' }, { timeoutMs: 1 }, { fd: 3 }, { file: '/private/source.wav' }, { certification: true }]) assert.equal(c.isStartRecordingReplicaRequest({ ...request(), ...patch }), false);
  assert.equal(c.isRecordingReplicaReadIdRequest({ readId: id(7), runId: id(8) }), false);
});
test('实际执行和原Render身份分离，原Render不能冒用recipe/profile或冻结PCM证据', () => {
  assert.equal(typeof c.isReplicaAudioIdentity, 'function'); assert.equal(c.isReplicaAudioIdentity(audio()), true); assert.equal(c.isReplicaAudioIdentity(audio('original-render')), true);
  for (const patch of [{ target: 'original-render' }, { pcmHashEvidence: 'verified-render-bytes' }, { outputProfileVersion: id(9) }, { fileSha256: hash('A') }, { dataOffset: 44 }]) assert.equal(c.isReplicaAudioIdentity({ ...audio(), ...patch }), false);
  for (const patch of [{ recipeHash: hash() }, { pcmHashEvidence: 'frozen-execution' }, { executionAssetId: id(4) }, { renderAssetId: undefined }]) assert.equal(c.isReplicaAudioIdentity({ ...audio('original-render'), ...patch }), false);
});
test('音频有限RIFF/PCM/时长与字节帧一致，不接受空帧或超预算原件', () => {
  assert.equal(typeof c.isReplicaAudioIdentity, 'function');
  for (const patch of [{ size: 40 }, { size: 0xffffffff + 9 }, { size: 48044 }, { frameCount: 0 }, { frameCount: 48000.5 }, { frameCount: Number.MAX_SAFE_INTEGER }]) assert.equal(c.isReplicaAudioIdentity({ ...audio(), ...patch }), false);
  for (const patch of [{ sampleRate: 0 }, { sampleRate: 384001 }, { channelCount: 3 }, { sampleFormat: 'aac' }, { container: 'rf64' }, { outputProfileVersion: id(9) }]) assert.equal(c.isReplicaAudioIdentity({ ...audio(), format: { ...audio().format, ...patch } }), false);
  assert.equal(c.isReplicaAudioIdentity({ ...audio(), size: 691200044, frameCount: 172800000, format: { ...audio().format, sampleRate: 8000 } }), true);
  assert.equal(c.isReplicaAudioIdentity({ ...audio(), size: 691200048, frameCount: 172800001, format: { ...audio().format, sampleRate: 8000 } }), false);
});
test('核验目标结构唯一有界，A/空B和DAT Program分开；verified不等播放许可', () => {
  assert.equal(typeof c.isRecordingReplicaInspection, 'function'); assert.equal(c.isRecordingReplicaInspection(inspection()), true);
  const original = [{ target: 'original-render', side: 'A', state: 'verified', audio: audio('original-render') }, { target: 'original-render', side: 'B', state: 'empty', frameCount: 0 }];
  assert.equal(c.isRecordingReplicaInspection({ ...inspection(), targets: [...inspection().targets, ...original] }), true);
  assert.equal(c.isRecordingReplicaInspection({ ...inspection(), targets: [{ ...inspection().targets[0], side: 'Program' }] }), true);
  for (const targets of [[], [inspection().targets[0]], [...inspection().targets, inspection().targets[0]], [{ ...inspection().targets[0], side: 'B' }, { ...inspection().targets[1], side: 'A' }], [inspection().targets[0], { ...inspection().targets[1], side: 'Program' }], [original[0], original[1]], [{ ...inspection().targets[0], audio: audio('original-render') }, inspection().targets[1]]]) assert.equal(c.isRecordingReplicaInspection({ ...inspection(), targets }), false);
  assert.equal(c.isRecordingReplicaInspection({ ...inspection(), targets: [{ target: 'actual-execution', side: 'A', state: 'unavailable', reason: 'ARCHIVE_UNAVAILABLE' }, inspection().targets[1]] }), true);
  for (const patch of [{ gateB: 'PASS' }, { checkedAt: '2026-02-30T00:00:00.000Z' }, { fingerprint: `${hash()}\n` }]) assert.equal(c.isRecordingReplicaInspection({ ...inspection(), ...patch }), false);
});
test('目标超预算先拒绝，不扫描无界数组', () => {
  assert.equal(typeof c.isRecordingReplicaInspection, 'function'); const targets = Array.from({ length: 5 }, () => inspection().targets[0]); Object.defineProperty(targets, 0, { get() { throw new Error('不应读取超预算数组'); } });
  assert.doesNotThrow(() => assert.equal(c.isRecordingReplicaInspection({ ...inspection(), targets }), false));
});
test('start立即快照无伪核验身份；取消先到无需Record/Plan并不能伪started', () => {
  assert.equal(typeof c.isRecordingReplicaRun, 'function'); assert.equal(c.isRecordingReplicaRun(session()), true); assert.equal(c.isRecordingReplicaRun(tombstone()), true);
  for (const patch of [{ request: request() }, { startedAt: at }, { identity: running().identity }, { cleanupQuiescent: false }, { started: true }, { evidence: 'synthetic-only' }]) assert.equal(c.isRecordingReplicaRun({ ...tombstone(), ...patch }), false);
  for (const patch of [{ started: true }, { state: 'consuming' }, { evidence: 'synthetic-only' }, { createdAt: later }, { revision: 0 }, { state: 'playing' }]) assert.equal(c.isRecordingReplicaRun({ ...session(), ...patch }), false);
});
test('会话身份精确绑定run/request/record/target/side/fingerprint，不接受迟到别对象', () => {
  assert.equal(typeof c.isRecordingReplicaRun, 'function'); assert.equal(c.isRecordingReplicaRun(running()), true);
  for (const patch of [{ recordingId: id(90) }, { target: 'original-render' }, { side: 'B' }, { fingerprint: hash('b') }]) assert.equal(c.isRecordingReplicaRun({ ...running(), identity: { ...running().identity, ...patch } }), false);
  assert.equal(c.isRecordingReplicaRun({ ...running(), runId: id(90) }), false);
  assert.equal(c.isRecordingReplicaRun({ ...running(), progress: null }), false);
});
test('精确帧/EOF/排空分开，不能提交冒消费或短读完成', () => {
  assert.equal(typeof c.isRecordingReplicaRun, 'function'); assert.equal(c.isRecordingReplicaRun(finished()), true);
  for (const patch of [{ sourceFramesRead: 48001 }, { submittedFrames: 12001 }, { consumedFrames: 12001 }, { sourceEof: true }, { backendDrained: true }, { consumedFrames: -1 }]) assert.equal(c.isRecordingReplicaRun({ ...running(), progress: { ...running().progress, ...patch } }), false);
  for (const patch of [{ consumedFrames: 47999 }, { sourceEof: false }, { backendDrained: false }]) assert.equal(c.isRecordingReplicaRun({ ...finished(), progress: { ...finished().progress, ...patch } }), false);
  for (const patch of [{ evidence: 'device-output' }, { deviceOpened: true }, { cleanupQuiescent: false }, { stopRequested: true }, { reason: 'CANCELLED' }, { endedAt: undefined }]) assert.equal(c.isRecordingReplicaRun({ ...finished(), ...patch }), false);
});
test('取消首因与真实清理独立；清理未完成只能stopping不能假终态', () => {
  assert.equal(typeof c.isRecordingReplicaRun, 'function'); const stopping = { ...running(), state: 'stopping', stopRequested: true, reason: 'CANCELLED' }; assert.equal(c.isRecordingReplicaRun(stopping), true);
  const cancelled = { ...stopping, state: 'cancelled', cleanupQuiescent: true, endedAt: later, updatedAt: later }; assert.equal(c.isRecordingReplicaRun(cancelled), true);
  assert.equal(c.isRecordingReplicaRun({ ...cancelled, reason: 'TIMEOUT', state: 'failed' }), true);
  for (const patch of [{ cleanupQuiescent: false }, { reason: 'TIMEOUT' }, { stopRequested: false }]) assert.equal(c.isRecordingReplicaRun({ ...cancelled, ...patch }), false);
  assert.equal(c.isRecordingReplicaRun({ ...stopping, stopRequested: false }), false);
  assert.equal(c.isRecordingReplicaRun({ ...stopping, endedAt: later }), false);
});
test('六命令注册请求和响应，stop返回真实Run状态；无outbox或测试认证入口', () => {
  const status = { playback: 'blocked', reason: 'BACKEND_UNAVAILABLE', deviceAccess: 'not-authorized', deviceOpened: false, formalReady: false, gateB: 'NOT_RUN' };
  const cases = { 'recordingReplica.status': [{}, status], 'recordingReplica.inspect': [{ readId: id(7), recordingId: id(1) }, inspection()], 'recordingReplica.cancelRead': [{ readId: id(7) }, { readId: id(7), cancelRequested: true }], 'recordingReplica.start': [request(), session()], 'recordingReplica.get': [{ runId: id(8) }, { run: session() }], 'recordingReplica.stop': [{ runId: id(8) }, tombstone()] };
  for (const [command, [payload, result]] of Object.entries(cases)) { assert.equal(c.validateIpcRequest({ version: 1, id: 'replica', command, payload }).ok, true, command); assert.equal(c.validateIpcResponseForCommand({ version: 1, id: 'replica', ok: true, result }, command as c.IpcCommand).ok, true, command); assert.equal(c.validateIpcRequest({ version: 1, id: 'replica', command, payload: { ...payload, path: '/private' } }).ok, false, command); assert.equal(c.isCommandOutboxCommand(command), false); }
  for (const command of ['recordingReplica.authorize', 'recordingReplica.provider', 'recordingReplica.seek', 'recordingReplica.rebuild']) assert.equal(c.validateIpcRequest({ version: 1, id: 'replica', command, payload: {} }).ok, false);
  assert.equal(c.validateIpcResponseForCommand({ version: 1, id: 'replica', ok: true, result: { run: null } }, 'recordingReplica.get').ok, true);
});

test('设备输出请求须有 Core 选择代际；普通Replica回执不借Formal Gate B', () => {
  const outputSelection = { endpointId: 'coreaudio-1', selectionGeneration: id(20) };
  const deviceRequest = { ...request(), mode: 'device-output', outputSelection };
  assert.equal(c.isStartRecordingReplicaRequest(deviceRequest), true);
  assert.equal(c.isStartRecordingReplicaRequest({ ...request(), outputSelection }), false, '旧合成请求不能偷偷携带设备选择');
  assert.equal(c.isRecordingReplicaRun({ ...session(), request: deviceRequest }), false, '设备请求不能沿用旧 synthetic 会话');
  for (const patch of [{ outputSelection: undefined }, { outputSelection: { ...outputSelection, selectionGeneration: 'bad' } }, { deviceUid: 'renderer-value' }])
    assert.equal(c.isStartRecordingReplicaRequest({ ...deviceRequest, ...patch }), false);

  const receipt = { runId: deviceRequest.runId, segmentId: id(22), playbackIdentitySha256: hash('1'), manifestSha256: hash('2'), helperSha256: hash('3'),
    backendId: 'musicbridge-coreaudio-hal', backendVersion: '0.2.0', drainAlgorithmId: 'hal-sample-zero-cover-v1',
    endpointId: outputSelection.endpointId, deviceUid: 'synthetic-coreaudio-uid', configurationFingerprintSha256: hash('4'),
    selectionGeneration: outputSelection.selectionGeneration, sourceFrameCount: 48000, fromFrame: 0,
    frameCount: 48000, suppliedFrames: 48000, consumedFrames: 48000,
    sourceEof: true, drainObserved: true, childClosed: true, inputFinalVerified: true,
    segmentPlaybackComplete: true, formalReady: false, gateB: 'NOT_RUN' };
  const run = { kind: 'device-session', runId: deviceRequest.runId, request: deviceRequest, revision: 2,
    createdAt: at, updatedAt: later, state: 'finished', identity: running().identity,
    progress: { sourceFramesRead: 48000, submittedFrames: 48000, consumedFrames: 48000, sourceEof: true, backendDrained: true },
    receipt, controlRevision: 0, cursorFrame: 48000, segmentId: receipt.segmentId, segmentIndex: 1,
    segmentFromFrame: 0, segmentQuiescent: true, started: true, startedAt: at, endedAt: later,
    stopRequested: false, cleanupQuiescent: true, evidence: 'device-output', deviceOpened: true,
    formalReady: false, gateB: 'NOT_RUN' };
  assert.equal(c.isReplicaDeviceReceipt(receipt), true);
  assert.equal(c.isRecordingReplicaRun(run), true);
  for (const patch of [{ sourceEof: false }, { drainObserved: false }, { childClosed: false }, { inputFinalVerified: false },
    { consumedFrames: 47999 }, { helperSha256: 'bad' }, { gateB: 'CERTIFIED' }]) {
    assert.equal(c.isReplicaDeviceReceipt({ ...receipt, ...patch }), false, JSON.stringify(patch));
    assert.equal(c.isRecordingReplicaRun({ ...run, receipt: { ...receipt, ...patch } }), false, JSON.stringify(patch));
  }
  assert.equal(c.isReplicaDeviceReceipt({ ...receipt, selectionGeneration: id(21) }), true, '回执形状本身不证明当前选择');
  assert.equal(c.isRecordingReplicaRun({ ...run, receipt: { ...receipt, selectionGeneration: id(21) } }), false, '会话必须核对选中代际');
  assert.equal(c.isRecordingReplicaRun({ ...run, progress: { ...run.progress, backendDrained: false } }), false);
  assert.equal(c.isRecordingReplicaRun({ ...run, cleanupQuiescent: false }), false);
  assert.equal(c.isRecordingReplicaRun({ ...run, evidence: 'synthetic-only' }), false);
  assert.equal(c.isRecordingReplicaRun({ ...run, identity: { ...run.identity, recordingId: id(99) } }), false);
});

test('普通Replica设备可用状态不等于Formal Gate B，也不能称实体录制', () => {
  const ready = { playback: 'ready', outputSelection: { endpointId: 'coreaudio-1', selectionGeneration: id(20) },
    deviceAccess: 'authorized', deviceOpened: false, formalReady: false, gateB: 'NOT_RUN' };
  assert.equal(c.isRecordingReplicaStatus(ready), true);
  assert.equal(c.isRecordingReplicaStatus({ ...ready, gateB: 'CERTIFIED' }), false);
  assert.equal(c.isRecordingReplicaStatus({ ...ready, formalReady: true }), false);
  assert.equal(c.isRecordingReplicaStatus({ playback: 'blocked', reason: 'GATE_B_NOT_CERTIFIED', deviceAccess: 'not-authorized',
    deviceOpened: false, formalReady: false, gateB: 'NOT_RUN' }), false);
});

test('Replica控制命令必须有独立commandId与预期控制修订，seek只接受有界帧', () => {
  const base = { runId: id(8), commandId: id(23), expectedControlRevision: 0 };
  for (const operation of ['pause', 'resume', 'stop'])
    assert.equal(c.isReplicaDeviceControlRequest({ ...base, operation }), true);
  assert.equal(c.isReplicaDeviceControlRequest({ ...base, operation: 'seek', frame: 0 }), true);
  for (const invalid of [{ ...base, operation: 'seek' }, { ...base, operation: 'pause', frame: 1 },
    { ...base, operation: 'seek', frame: -1 }, { ...base, operation: 'seek', frame: 1.5 },
    { ...base, operation: 'stop', expectedControlRevision: -1 }, { ...base, operation: 'resume', commandId: 'bad' },
    { ...base, operation: 'seek', frame: 1, path: '/private/source.wav' }])
    assert.equal(c.isReplicaDeviceControlRequest(invalid), false);
});

 test('PCM sampleFormat 必须为有限字符串，不接受字符串化的数组或对象', () => {
  const format = audio().format;
  for (const sampleFormat of ['pcm-s16le', 'pcm-s24le', 'pcm-s32le', 'pcm-f32le']) assert.equal(c.isReplicaPcmFormat({ ...format, sampleFormat }), true);
  for (const sampleFormat of [['pcm-s16le'], new String('pcm-s16le'), { toString: () => 'pcm-s16le' }, null, 16, true]) {
    assert.equal(c.isReplicaPcmFormat({ ...format, sampleFormat }), false);
    assert.equal(c.isReplicaAudioIdentity({ ...audio(), size: 384044, format: { ...format, sampleFormat } }), false);
  }
});
