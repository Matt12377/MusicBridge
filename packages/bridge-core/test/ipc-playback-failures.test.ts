import assert from 'node:assert/strict';
import test from 'node:test';
import { failureForError } from '../src/shared/ipc-failure.js';
import { BridgeError } from '../src/shared/errors.js';

test('被新播放意图替代的请求返回取消，非法队列仍返回参数错误', () => {
  const cancelled = new BridgeError('BAD_REQUEST', '私有错误详情', { details: { reason: 'operation_cancelled' } });
  assert.equal(failureForError('synthetic', cancelled, 'playback.replaceQueue').error.code, 'CANCELLED');
  assert.equal(failureForError('synthetic', new BridgeError('BAD_REQUEST', '私有错误详情'), 'playback.replaceQueue').error.code, 'INVALID_IPC_REQUEST');
});

test('播放失败说明区分音频服务与 Roon 媒体错误，不泄露内部详情', () => {
  for (const [code, message] of [
    ['NETEASE_REQUEST_FAILED', '音频服务暂时不可用，请重试。'],
    ['STREAM_UPSTREAM_FAILED', '音频服务暂时不可用，请重试。'],
    ['ROON_MEDIA_ERROR', 'Roon 报告媒体错误，请重试。'],
    ['STREAM_URL_EXPIRED', '播放地址已过期，请重试。'],
  ] as const) {
    const result = failureForError('synthetic', new BridgeError(code, '私有 URL 与错误栈', {
      details: { url: 'https://synthetic.invalid/private?token=private-value' },
    }), 'playback.replaceQueue');
    assert.equal(result.error.code, 'INTERNAL_ERROR');
    assert.equal(result.error.message, message);
    assert.equal(JSON.stringify(result).includes('private-value'), false);
  }
  assert.deepEqual(failureForError('synthetic', new Error('未知私有错误'), 'playback.replaceQueue').error,
    { code: 'INTERNAL_ERROR', message: 'Core request failed' });
});
