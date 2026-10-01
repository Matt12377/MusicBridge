import assert from 'node:assert/strict';
import test from 'node:test';
import { validateIpcEvent, validateIpcRequest, validateIpcResponseForCommand, type IpcCommand } from '../src/index.js';

const coreInstanceId = '11111111-1111-4111-8111-111111111111';
const stamp = { coreInstanceId, generation: 2, sequence: 3, queueRevision: 1, selectedZoneId: 'zone', trackId: '123', source: 'netease' };
const state = { state: 'playing', currentTrack: { id: '123', title: '曲目', artists: ['艺人'], album: '专辑' }, source: 'netease', positionMs: 1000, selectedZoneId: 'zone', canNext: false, canPrevious: false, canStop: true, canPause: true, canResume: false };
const queue = { items: [{ trackId: '123', qualityPreference: 'auto' }], index: 0, hasNext: false, hasPrevious: false };
const snapshot = { ...state, queue };
const envelope = { stamp, snapshot };
const event = (name: string, payload: unknown) => validateIpcEvent({ version: 1, event: name, payload }).ok;
const response = (result: unknown, command: IpcCommand = 'playback.getState') => validateIpcResponseForCommand({ version: 1, id: 'stream', ok: true, result }, command).ok;
const health = { runtime: 'ready', roon: 'ready', provider: 'configured', activeStreamCount: 0, activePlaybackPresent: true };

test('006：旧快照兼容，紧凑快照与带stamp命令回执可验证', () => {
  assert.equal(response(snapshot), true);
  assert.equal(response({ ...snapshot, stream: stamp }), true);
  assert.equal(event('playback.snapshot', envelope), true);
});

test('006：同原子采样的身份必须匹配，禁止重复stream与私有字段', () => {
  assert.equal(event('playback.snapshot', envelope), true);
  for (const bad of [
    { stamp: { ...stamp, trackId: '456' }, snapshot },
    { stamp: { ...stamp, source: 'roon' }, snapshot },
    { stamp: { ...stamp, selectedZoneId: 'other' }, snapshot },
    { stamp, snapshot: { ...snapshot, stream: stamp } },
    { ...envelope, sessionId: 'private' },
  ]) assert.equal(event('playback.snapshot', bad), false);
});

test('006：progress仅传stamp和有界位置，不能携带队列与曲目', () => {
  const payload = { stamp, positionMs: 1200 };
  assert.equal(event('playback.progress', payload), true);
  for (const extra of [{ queue }, { currentTrack: state.currentTrack }, { state }, { token: 'private' }]) assert.equal(event('playback.progress', { ...payload, ...extra }), false);
  for (const positionMs of [-1, 0.5, NaN, Infinity, 86400001, '1000']) assert.equal(event('playback.progress', { stamp, positionMs }), false);
});

test('006：state完整非队列投影，可原子附加合法队列', () => {
  assert.equal(event('playback.state', { stamp, state }), true);
  assert.equal(event('playback.state', { stamp, state, queue }), true);
  for (const bad of [{ stamp, state: { ...state, queue } }, { stamp, state: { ...state, stream: stamp } }, { stamp, state, queue: { ...queue, index: 5000 } }, { stamp, state: { ...state, selectedZoneId: 'other' } }]) assert.equal(event('playback.state', bad), false);
});

test('006：stamp代际和序号拒绝非安全整数、缺失、数组与任意私有字段', () => {
  assert.equal(event('playback.progress', { stamp, positionMs: 0 }), true);
  for (const key of ['generation', 'sequence', 'queueRevision']) {
    for (const value of [-1, 1.1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '2', [], null, undefined]) assert.equal(event('playback.progress', { stamp: { ...stamp, [key]: value }, positionMs: 0 }), false, `${key}:${String(value)}`);
  }
  assert.equal(event('playback.progress', { stamp: { ...stamp, generation: 0 }, positionMs: 0 }), true);
  for (const key of ['sequence', 'queueRevision']) assert.equal(event('playback.progress', { stamp: { ...stamp, [key]: 0 }, positionMs: 0 }), false);
  for (const extra of [{ privateEpoch: 'x' }, { sourceIndex: 1 }, { sessionId: 'x' }]) assert.equal(event('playback.progress', { stamp: { ...stamp, ...extra }, positionMs: 0 }), false);
});

test('006：stamp实例及可空身份严格验证，idle不猜造身份', () => {
  const idle = { ...snapshot, state: 'idle', currentTrack: undefined, source: undefined, selectedZoneId: undefined, positionMs: 0 };
  const idleStamp = { ...stamp, trackId: null, source: null, selectedZoneId: null };
  assert.equal(event('playback.snapshot', { stamp: idleStamp, snapshot: idle }), true);
  for (const coreInstanceId of ['', '../private', ['uuid'], null]) assert.equal(event('playback.progress', { stamp: { ...stamp, coreInstanceId }, positionMs: 0 }), false);
  for (const source of ['smart', [], {}, true]) assert.equal(event('playback.progress', { stamp: { ...stamp, source }, positionMs: 0 }), false);
  for (const key of ['selectedZoneId', 'trackId']) for (const value of ['', 1, [], {}, 'x'.repeat(129)]) assert.equal(event('playback.progress', { stamp: { ...stamp, [key]: value }, positionMs: 0 }), false);
});

test('006：只读seed命令允许空payload，响应明确旧模式null', () => {
  assert.equal(validateIpcRequest({ version: 1, id: 'stream', command: 'playback.getStreamSnapshot', payload: {} }).ok, true);
  const command = 'playback.getStreamSnapshot' as IpcCommand;
  assert.equal(response(envelope, command), true);
  assert.equal(response(null, command), true);
  for (const payload of [{ stream: stamp }, { mode: 'compact-v1' }, { token: 'private' }]) assert.equal(validateIpcRequest({ version: 1, id: 'stream', command, payload }).ok, false);
  assert.equal(response({ stamp, snapshot: { ...snapshot, stream: stamp } }, command), false);
});

test('006：ACK只出现在ready并严格验证协议与实例', () => {
  assert.equal(event('core.ready', { state: health }), true);
  const playbackEvents = { protocol: 'compact-v1', coreInstanceId };
  assert.equal(event('core.ready', { state: health, playbackEvents }), true);
  assert.equal(event('core.health', { state: health, playbackEvents }), false);
  for (const bad of [{ ...playbackEvents, protocol: 'other' }, { ...playbackEvents, protocol: ['compact-v1'] }, { ...playbackEvents, coreInstanceId: 'bad' }, { ...playbackEvents, token: 'private' }, null]) assert.equal(event('core.ready', { state: health, playbackEvents: bad }), false);
});

test('006：5000项合法full不被小progress协议的预算截断', () => {
  const full = { ...snapshot, queue: { ...queue, items: Array.from({ length: 5000 }, (_, i) => ({ trackId: String(i + 1), qualityPreference: 'auto' })) } };
  assert.equal(event('playback.snapshot', { stamp, snapshot: full }), true);
  assert.equal(event('playback.snapshot', { stamp, snapshot: { ...full, queue: { ...full.queue, items: [...full.queue.items, full.queue.items[0]] } } }), false);
});

test('006：紧凑state与full拒绝数组冒充状态或恢复动作枚举', () => {
  const badState = { ...state, state: ['playing'] };
  assert.equal(event('playback.state', { stamp, state: badState }), false);
  assert.equal(event('playback.snapshot', { stamp, snapshot: { ...badState, queue } }), false);
  const lastIssue = { code: 'INTERNAL_ERROR', message: '失败', retryable: true, diagnosticId: 'synthetic', action: ['retry'] };
  assert.equal(event('playback.state', { stamp, state: { ...state, lastIssue } }), false);
});
