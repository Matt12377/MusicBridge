import assert from 'node:assert/strict';
import test from 'node:test';
import { IPC_VERSION, validateIpcRequest, validateIpcResponseForCommand } from '../src/index.js';

const epoch = '11111111-1111-4111-8111-111111111111';
const legacy = { items: [], offset: 0, limit: 24, hasMore: true };
const valid = (page: unknown) => validateIpcResponseForCommand({
  version: IPC_VERSION, id: 'pagination', ok: true, result: page,
}, 'roon.library.albums').ok;

test('MBP004：未知总数的Roon增量页允许快照代、完成状态和原始下一游标', () => {
  assert.equal(valid({ ...legacy, sourceEpoch: epoch, complete: false, nextOffset: 12 }), true);
});

test('MBP004：完整缓存首页仍有后续页，complete不等同hasMore', () => {
  assert.equal(valid({ ...legacy, sourceEpoch: epoch, complete: true, nextOffset: 24, total: 100 }), true);
});

test('MBP004：旧Roon页和原请求格式继续兼容', () => {
  assert.equal(valid(legacy), true);
  const providerPage = { ...legacy, hasMore: false, total: 0 };
  const providerResponse = (result: unknown) => validateIpcResponseForCommand({
    version: IPC_VERSION, id: 'provider-page', ok: true, result,
  }, 'library.liked').ok;
  assert.equal(providerResponse(providerPage), true);
  assert.equal(providerResponse({ ...providerPage, sourceEpoch: epoch }), false);
  for (const command of ['roon.library.albums', 'library.liked']) {
    assert.equal(validateIpcRequest({ version: IPC_VERSION, id: 'old-page', command, payload: { page: { offset: 0, limit: 24 } } }).ok, true);
    assert.equal(validateIpcRequest({ version: IPC_VERSION, id: 'request-epoch', command, payload: { page: { offset: 0, limit: 24, sourceEpoch: epoch } } }).ok, false);
  }
});

test('MBP004：分页快照只接受opaque UUID，不泄露私有会话或任意路径', () => {
  for (const sourceEpoch of ['', 'musicbridge-v2-albums-private-session', '/private/music', 123, null]) {
    assert.equal(valid({ ...legacy, sourceEpoch }), false);
  }
});

test('MBP004：下一游标有界且不得倒退，完成状态只能为布尔值', () => {
  for (const nextOffset of [-1, 1.5, 1_000_001, NaN, '24', null]) {
    assert.equal(valid({ ...legacy, nextOffset }), false);
  }
  assert.equal(valid({ ...legacy, offset: 48, nextOffset: 24 }), false);
  for (const complete of [0, 1, 'true', null]) assert.equal(valid({ ...legacy, complete }), false);
});

test('MBP004：新增Roon页字段仍受严格白名单约束', () => {
  assert.equal(valid({ ...legacy, sourceEpoch: epoch, privateCursor: 'session:key' }), false);
});
