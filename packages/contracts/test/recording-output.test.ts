import assert from 'node:assert/strict';
import test from 'node:test';
import * as c from '../src/index.js';

const runId = '73000000-0000-4000-8000-000000000001';
const planVersionId = '73000000-0000-4000-8000-000000000002';
const hash = 'a'.repeat(64);
const request = { runId, planVersionId, side: 'A' as const };
const status = () => ({ backend: { id: 'musicbridge-coreaudio-hal', version: '0.1.0', halAdapterCompiled: true }, syntheticCheck: { available: true, helperSha256: hash, protocolVersion: 1 }, deviceAccess: 'not-authorized', gateB: 'NOT_RUN', formalReady: false });
const verified = () => ({ state: 'verified', ...request, planContentHash: hash, frameCount: 48000, consumedFrames: 48000, pcmSha256: hash, helperSha256: hash, deviceOpened: false, formalReady: false, gateB: 'NOT_RUN', evidence: 'synthetic-only' });

test('输出状态分别表达无产物与合成helper可用，不授予设备权限', () => {
  assert.equal(typeof c.isRecordingOutputStatus, 'function', '输出状态合同尚未实现');
  assert.equal(c.isRecordingOutputStatus(status()), true);
  assert.equal(c.isRecordingOutputStatus({ ...status(), backend: { ...status().backend, halAdapterCompiled: false }, syntheticCheck: { available: false, helperSha256: null, protocolVersion: 1 } }), true);
  assert.equal(c.isRecordingOutputStatus({ ...status(), backend: { ...status().backend, halAdapterCompiled: false } }), false, '可用完整包必须包含独立HAL编译证据');
  assert.equal(c.isRecordingOutputStatus({ ...status(), syntheticCheck: { available: false, helperSha256: null, protocolVersion: 1 } }), false, '无有效包不能报告HAL已编译');
  assert.equal(c.isRecordingOutputStatus({ ...status(), syntheticCheck: { ...status().syntheticCheck, available: false } }), false, '不可用状态不携带helper身份');
  for (const patch of [{ deviceAccess: 'authorized' }, { gateB: 'PASS' }, { formalReady: true }, { certificate: {} }]) assert.equal(c.isRecordingOutputStatus({ ...status(), ...patch }), false);
});

test('输出状态严格限定后端身份、协议和helper Hash，不接受设备或路径注入', () => {
  assert.equal(typeof c.isRecordingOutputStatus, 'function');
  for (const patch of [{ id: 'roon' }, { version: '0.2.0' }, { halAdapterCompiled: 1 }, { deviceUid: 'private' }]) assert.equal(c.isRecordingOutputStatus({ ...status(), backend: { ...status().backend, ...patch } }), false);
  for (const patch of [{ protocolVersion: 2 }, { available: 1 }, { helperSha256: null }, { helperSha256: 'A'.repeat(64) }, { helperSha256: `${hash}\n` }, { path: '/private/helper' }]) assert.equal(c.isRecordingOutputStatus({ ...status(), syntheticCheck: { ...status().syntheticCheck, ...patch } }), false);
});

test('只读核验和取消只接受明确run/plan/side，不接受默认选择或额外权限', () => {
  assert.equal(typeof c.isRecordingOutputCheckRequest, 'function');
  for (const side of ['A', 'B', 'Program']) assert.equal(c.isRecordingOutputCheckRequest({ ...request, side }), true);
  for (const patch of [{ runId: '' }, { planVersionId: 'latest' }, { side: 'all' }, { side: undefined }, { path: '/private/audio' }, { deviceOpened: true }, { userConfirmed: true }]) assert.equal(c.isRecordingOutputCheckRequest({ ...request, ...patch }), false);
  assert.equal(c.isRecordingOutputCancelRequest({ runId }), true);
  for (const value of [null, [], {}, { id: runId }, { runId: 'bad' }, { runId, planVersionId }]) assert.equal(c.isRecordingOutputCancelRequest(value), false);
});

test('verified只表示同一非空执行音频已全部消费，拒绝零帧、短读和不安全整数', () => {
  assert.equal(typeof c.isRecordingOutputCheckResult, 'function');
  assert.equal(c.isRecordingOutputCheckResult(verified()), true);
  for (const frameCount of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) assert.equal(c.isRecordingOutputCheckResult({ ...verified(), frameCount, consumedFrames: frameCount }), false);
  for (const consumedFrames of [0, 47999, 48001, '48000']) assert.equal(c.isRecordingOutputCheckResult({ ...verified(), consumedFrames }), false);
});

test('核验结果保持合成证据边界，不返回取消成功、设备排空或正式就绪', () => {
  assert.equal(typeof c.isRecordingOutputCheckResult, 'function');
  for (const patch of [{ state: 'cancelled' }, { state: 'failed' }, { runId: '' }, { planVersionId: 'latest' }, { side: 'all' }, { deviceOpened: true }, { formalReady: true }, { gateB: 'PASS' }, { evidence: 'device-measured' }, { drained: true }, { path: '/private/audio' }]) assert.equal(c.isRecordingOutputCheckResult({ ...verified(), ...patch }), false);
  for (const key of ['planContentHash', 'pcmSha256', 'helperSha256']) for (const value of [null, '', 'f'.repeat(63), 'A'.repeat(64), `${hash}\n`]) assert.equal(c.isRecordingOutputCheckResult({ ...verified(), [key]: value }), false);
});

test('三个输出IPC请求与响应严格闭合，status只接受空payload', () => {
  const cases = { 'recordingOutput.status': [{}, status()], 'recordingOutput.check': [request, verified()], 'recordingOutput.cancel': [{ runId }, { cancelled: true }] };
  for (const [command, [payload, result]] of Object.entries(cases)) {
    assert.equal(c.validateIpcRequest({ version: 1, id: 'output', command, payload }).ok, true, command);
    assert.equal(c.validateIpcRequest({ version: 1, id: 'output', command, payload: { ...payload, path: '/private/audio' } }).ok, false, command);
    assert.equal(c.validateIpcResponseForCommand({ version: 1, id: 'output', ok: true, result }, command as c.IpcCommand).ok, true, command);
    assert.equal(c.validateIpcResponseForCommand({ version: 1, id: 'output', ok: true, result: { ...result, certified: true } }, command as c.IpcCommand).ok, false, command);
  }
  assert.equal(c.validateIpcResponseForCommand({ version: 1, id: 'output', ok: true, result: { cancelled: false } }, 'recordingOutput.cancel').ok, false);
});

test('合成输出检查不进入outbox，不开放播放、设备授权或认证写命令', () => {
  for (const command of ['recordingOutput.status', 'recordingOutput.check', 'recordingOutput.cancel']) assert.equal(c.isCommandOutboxCommand(command), false);
  for (const command of ['recordingOutput.start', 'recordingOutput.play', 'recordingOutput.authorize', 'recordingOutput.certify']) assert.equal(c.validateIpcRequest({ version: 1, id: 'output', command, payload: {} }).ok, false);
});
