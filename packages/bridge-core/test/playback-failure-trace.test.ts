import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlaybackFailureTraceStreamReader } from '../src/shared/playback-failure-trace.js';

test('播放失败终端管道只保留闭集原因，分片和恶意私密字段不泄漏', () => {
  const lines: string[] = [];
  const consume = createPlaybackFailureTraceStreamReader(line => lines.push(line));
  const raw = JSON.stringify({ level: 'warn', event: 'queue_replace_failed', code: 'NETEASE_REQUEST_FAILED',
    reason: 'request-budget', cookie: 'MUSIC_U=hidden', message: 'https://private.invalid/?token=hidden', stack: 'private stack' }) + '\n';
  consume(raw.slice(0, 17)); consume(raw.slice(17));
  assert.deepEqual(lines, ['[playback:replace-queue] {"code":"NETEASE_REQUEST_FAILED","reason":"request-budget"}\n']);
  consume(JSON.stringify({ level: 'warn', event: 'queue_replace_failed', code: 'MUSIC_U=hidden', reason: { cookie: 'hidden' } }) + '\n');
  assert.equal(lines.at(-1), '[playback:replace-queue] {"code":"OTHER","reason":"unclassified"}\n');
  consume('private SDK stack\n');
  consume(JSON.stringify({ level: 'warn', event: 'other', message: 'hidden' }) + '\n');
  consume('x'.repeat(9000)); consume('\n');
  assert.equal(lines.length, 2);
  assert.doesNotMatch(lines.join(''), /hidden|cookie|private|stack|token/u);
  consume(JSON.stringify({ level: 'warn', event: 'queue_replace_failed', code: 'NETEASE_REQUEST_FAILED', reason: 'runtime-prepare' }) + '\n');
  assert.equal(lines.length, 3);
  for (const code of ['READ_CANCELLED', 'READ_DEADLINE', 'ROON_NOT_PAIRED', 'ROON_ZONE_NOT_SELECTED', 'ROON_TRANSPORT_UNAVAILABLE']) {
    consume(JSON.stringify({ level: 'warn', event: 'queue_replace_failed', code, reason: 'unclassified', message: 'private SDK stack' }) + '\n');
    assert.equal(JSON.parse(lines.at(-1)!.slice('[playback:replace-queue] '.length)).code, code);
  }
  assert.doesNotMatch(lines.join(''), /private|stack/u);
});

test('终端输出失败不会向播放进程抛出或保留无界管道内容', () => {
  const consume = createPlaybackFailureTraceStreamReader(() => { throw new Error('输出已关闭'); });
  assert.doesNotThrow(() => consume('{"level":"warn","event":"queue_replace_failed","code":"NETEASE_REQUEST_FAILED","reason":"request-timeout"}\n'));
});
