import assert from 'node:assert/strict';
import test from 'node:test';
import { isLibraryReadContext, validateIpcRequest, validateIpcResponseForCommand } from '../src/index.js';
const deadlineAtMs = 100_000;
const request = { version: 1, id: 'cache-read', command: 'library.playlist', payload: { playlistId: '123', page: { offset: 0, limit: 24 } } };
const snapshotVersion = '11111111-1111-4111-8111-111111111111';
const playlist = { id: '123', name: '受控歌单', trackCount: 0, tracks: { items: [], offset: 0, limit: 24, hasMore: false, total: 0 } };

test('005合同：reload仅作为只读context意图保留，旧请求形状不变', () => {
  const context = { deadlineAtMs, cacheMode: 'reload' };
  assert.equal(isLibraryReadContext(context), true);
  const result = validateIpcRequest({ ...request, readContext: context });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value.readContext, context);
  const legacy = validateIpcRequest({ ...request, readContext: { deadlineAtMs } });
  assert.equal(legacy.ok, true);
  if (legacy.ok) assert.deepEqual(legacy.value.readContext, { deadlineAtMs });
  assert.equal(validateIpcRequest(request).ok, true);
});

test('005合同：非法mode、scope setter和写命令不能借刷新协议派发', () => {
  for (const context of [ { deadlineAtMs, cacheMode: 'default' }, { deadlineAtMs, cacheMode: ['reload'] }, { deadlineAtMs, cacheMode: true }, { deadlineAtMs, cacheMode: 'reload', scope: '伪造' }, { deadlineAtMs: 1.5, cacheMode: 'reload' } ]) {
    assert.equal(validateIpcRequest({ ...request, readContext: context }).ok, false);
  }
  assert.equal(validateIpcRequest({ ...request, command: 'playback.stop', payload: {}, readContext: { deadlineAtMs, cacheMode: 'reload' } }).ok, false);
  assert.equal(validateIpcRequest({ ...request, payload: { ...request.payload, cacheMode: 'reload' } }).ok, false);
});

test('005合同：歌单response-only UUID版本可缺省，畸形版本和私密字段拒绝', () => {
  const response = (result: unknown) => validateIpcResponseForCommand({ version: 1, id: request.id, ok: true, result }, 'library.playlist');
  assert.equal(response(playlist).ok, true);
  assert.equal(response({ ...playlist, snapshotVersion }).ok, true);
  for (const version of ['', '123', ['11111111-1111-4111-8111-111111111111'], 1]) assert.equal(response({ ...playlist, snapshotVersion: version }).ok, false);
  assert.equal(response({ ...playlist, snapshotVersion, cookie: '合成私密字段' }).ok, false);
  assert.equal(validateIpcRequest({ ...request, payload: { ...request.payload, snapshotVersion } }).ok, false);
});
