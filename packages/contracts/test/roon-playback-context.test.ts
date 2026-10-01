import assert from 'node:assert/strict';
import test from 'node:test';
import { IPC_VERSION, roonTrackIdFromReference, validateIpcEvent, validateIpcRequest, validateIpcResponseForCommand, type IpcCommand } from '../src/index.js';

const handle = '11111111-1111-4111-8111-111111111111';
const reference = `musicbridge-v2-entity-${handle}`;
const trackId = roonTrackIdFromReference(reference);
const roonItem = { reference, kind: 'track', title: '已授权曲目' };
const entry = { trackId, qualityPreference: 'auto', preferredSource: 'roon', roonItem };
const request = (payload: unknown, command = 'roon.library.play') => validateIpcRequest({ version: IPC_VERSION, id: 'context-play', command, payload }).ok;
const page = (value: unknown, command: IpcCommand = 'roon.library.album') => validateIpcResponseForCommand({ version: IPC_VERSION, id: 'context-page', ok: true, result: value }, command).ok;
const queue = (items: unknown[], context?: unknown) => validateIpcEvent({ version: IPC_VERSION, event: 'queue.changed', payload: { queue: { items, index: 0, hasNext: true, hasPrevious: false, ...(context === undefined ? {} : { context }) } } }).ok;

test('003B：详情页允许opaque上下文handle，旧页继续兼容', () => {
  const base = { items: [roonItem], offset: 0, limit: 24, sourceEpoch: handle, nextOffset: 1, hasMore: true };
  assert.equal(page(base), true);
  assert.equal(page({ ...base, playbackContextHandle: handle }), true);
  for (const playbackContextHandle of [null, 1, '', '/private/session', 'not-a-uuid']) assert.equal(page({ ...base, playbackContextHandle }), false);
});

test('003B：play可传contextHandle但禁止与旧queueReferences混用', () => {
  assert.equal(request({ reference, zoneId: 'zone', contextHandle: handle }), true);
  assert.equal(request({ reference, zoneId: 'zone', queueReferences: [reference] }), true);
  assert.equal(request({ reference, zoneId: 'zone', queueReferences: [reference], contextHandle: handle }), false);
  assert.equal(request({ reference, zoneId: 'zone', contextHandle: handle }, 'roon.library.queue'), false);
  for (const contextHandle of [null, 1, '', '/private/session']) assert.equal(request({ reference, zoneId: 'zone', contextHandle }), false);
});

test('003B：游标、私有路径和伪造曲目不能从play请求注入', () => {
  for (const extra of [{ offset: 1 }, { sourceEpoch: handle }, { roonItem }, { privateCursor: 'sdk-key' }]) assert.equal(request({ reference, zoneId: 'zone', contextHandle: handle, ...extra }), false);
});

test('003B：可信Roon队列项支持后台曲目描述符，映射必须匹配', () => {
  assert.equal(queue([entry]), true);
  assert.equal(queue([{ ...entry, trackId: '123' }]), false);
  assert.equal(queue([{ ...entry, roonItem: { ...roonItem, kind: 'album' } }]), false);
  assert.equal(queue([{ ...entry, preferredSource: 'netease' }]), false);
  assert.equal(queue([{ ...entry, roonItem: { ...roonItem, item_key: 'private' } }]), false);
});

test('003B：未读边缘与加载、可重试错误可观测且有严格白名单', () => {
  for (const error of [undefined, 'retryable', 'expired', 'capacity']) assert.equal(queue([entry], { beforeComplete: true, afterComplete: false, loading: false, ...(error ? { error } : {}) }), true);
  for (const bad of [{ beforeComplete: 1, afterComplete: false, loading: false }, { beforeComplete: true, afterComplete: false, loading: false, error: 'private-stack' }, { beforeComplete: true, afterComplete: false, loading: false, cursor: 1 }]) assert.equal(queue([entry], bad), false);
});

test('003B：请求队列不得注入response-only上下文或roonItem', () => {
  const base = { trackId, qualityPreference: 'auto', preferredSource: 'roon' };
  for (const command of ['playback.replaceQueue', 'playback.appendQueue', 'playback.insertNext']) {
    assert.equal(request({ items: [{ ...base, roonItem }], ...(command === 'playback.replaceQueue' ? { index: 0 } : {}) }, command), false);
    assert.equal(request({ items: [base], context: { afterComplete: false }, ...(command === 'playback.replaceQueue' ? { index: 0 } : {}) }, command), false);
  }
});

test('003B：上下文错误枚举拒绝数组、对象、null及其他非字符串', () => {
  for (const error of [['retryable'], ['expired'], [['capacity']], {}, null, 1, true]) {
    assert.equal(queue([entry], { beforeComplete: true, afterComplete: false, loading: false, error }), false);
  }
});
