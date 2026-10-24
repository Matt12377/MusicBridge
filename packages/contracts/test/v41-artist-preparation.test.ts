import assert from 'node:assert/strict';
import test from 'node:test';
import { validateIpcResponseForCommand, mapMobileSafeError, mobileCommonResponseSnapshot } from '../src/index.js';

test('4.1 专用索引准备错误沿原IPC失败合同通过，未知码仍拒绝', () => {
  const response = { version: 1, id: 'artist-prepare', ok: false, error: { code: 'ARTIST_INDEX_PREPARING', message: '正在准备本地艺术家与搜索。' } };
  assert.equal(validateIpcResponseForCommand(response, 'localArtist.list').ok, true);
  assert.equal(validateIpcResponseForCommand({ ...response, error: { ...response.error, code: 'ARTIST_INDEX_UNKNOWN' } }, 'localArtist.list').ok, false);
});

test('4.1 移动安全错误允许准备态，不改变原Error.code字符串合同', () => {
  const result = mapMobileSafeError({ code: 'ARTIST_INDEX_PREPARING', requestId: 'artist-prepare', retryable: true, retryAfterMs: 500 });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.error.code, 'ARTIST_INDEX_PREPARING'); assert.equal(result.value.error.retryAfterMs, 500);
    assert.match(result.value.error.message, /正在准备/u); assert.equal(mobileCommonResponseSnapshot('error', result.value).ok, true);
  }
  assert.equal(mapMobileSafeError({ code: 'BUSY', requestId: 'legacy-busy', retryable: true }).ok, true);
});
