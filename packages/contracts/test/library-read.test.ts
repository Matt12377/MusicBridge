import assert from 'node:assert/strict';
import test from 'node:test';
import { validateIpcRequest, validateIpcResponse } from '../src/index.js';

test('MBP-002：只读期限被保留，写命令及非法期限不能进入取消协议', () => {
  const deadlineAtMs = Date.now() + 500;
  const request = { version: 1, id: 'read-1', command: 'library.search', payload: { query: 'test', page: { offset: 0, limit: 24 } }, readContext: { deadlineAtMs } };
  const valid = validateIpcRequest(request);
  assert.equal(valid.ok, true);
  if (valid.ok) assert.deepEqual((valid.value as unknown as { readContext?: unknown }).readContext, { deadlineAtMs });
  for (const context of [{ deadlineAtMs: -1 }, { deadlineAtMs: 1.5 }, { deadlineAtMs, extra: true }, { deadlineAtMs: Infinity }]) {
    assert.equal(validateIpcRequest({ ...request, readContext: context }).ok, false);
  }
  assert.equal(validateIpcRequest({ ...request, command: 'playback.stop', payload: {} }).ok, false);
  assert.equal(validateIpcResponse({ version: 1, id: 'read-1', ok: false, error: { code: 'CANCELLED', message: '读取已取消' } }).ok, true);
});
