import assert from 'node:assert/strict';
import test from 'node:test';
import * as c from '../src/index.js';

const generation = '85000000-0000-4000-8000-000000000001';
const selected = { endpointId: 'coreaudio-1', selectionGeneration: generation };
const candidates = { candidates: [{ endpointId: 'coreaudio-1', label: '合成输出设备', available: true }], selected,
  blockedReason: null, deviceOpened: false, gateB: 'NOT_RUN', formalReady: false };

test('设备目录仅暴露有界候选及 Core 签发代际，不接受 Renderer UID、配置或认证', () => {
  assert.equal(c.isRecordingDeviceCandidates(candidates), true);
  assert.equal(c.isRecordingOutputSelection(selected), true);
  assert.equal(c.isSelectRecordingDeviceRequest({ endpointId: selected.endpointId }), true);
  assert.equal(c.isRecordingDeviceCandidates({ ...candidates, candidates: [] }), false, '签发选择须仍属于可用候选');
  assert.equal(c.isRecordingDeviceCandidates({ ...candidates, candidates: [{ ...candidates.candidates[0], available: false }] }), false);
  assert.equal(c.isRecordingDeviceCandidates({ ...candidates, deviceOpened: true }), false);
  assert.equal(c.isRecordingDeviceCandidates({ ...candidates, gateB: 'PASS' }), false);
  assert.equal(c.isRecordingDeviceCandidates({ candidates: [], selected: null, blockedReason: 'NO_DEVICE_CATALOG', deviceOpened: false, gateB: 'NOT_RUN', formalReady: false }), true);
  for (const patch of [{ selectionGeneration: '1' }, { deviceUid: 'unauthorized' }, { configurationFingerprintSha256: 'a'.repeat(64) }])
    assert.equal(c.isRecordingOutputSelection({ ...selected, ...patch }), false);
  assert.equal(c.isSelectRecordingDeviceRequest({ endpointId: selected.endpointId, deviceUid: 'unauthorized' }), false);
});

test('设备候选和选择 IPC 只允许公开字段，且非持久命令', () => {
  for (const [command, payload, result] of [
    ['recordingDevice.candidates', {}, candidates],
    ['recordingDevice.select', { endpointId: selected.endpointId }, selected],
  ] as const) {
    assert.equal(c.validateIpcRequest({ version: 1, id: 'device', command, payload }).ok, true);
    assert.equal(c.validateIpcResponseForCommand({ version: 1, id: 'device', ok: true, result }, command).ok, true);
    assert.equal(c.isCommandOutboxCommand(command), false);
  }
  assert.equal(c.validateIpcRequest({ version: 1, id: 'device', command: 'recordingDevice.select', payload: { endpointId: 'coreaudio-1', deviceUid: 'not-core-signed' } }).ok, false);
});
