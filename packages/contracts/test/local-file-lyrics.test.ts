import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { validateIpcRequest, validateIpcResponseForCommand } from '../src/index.js';

const request = (trackId: unknown, extra: Record<string, unknown> = {}) => ({ version: 1, id: 'local-lyrics-read', command: 'lyrics.get', payload: { trackId, ...extra } });

test('歌词公开只读合同：保持原数字ID，新增规范本地v4 UUID，拒路径/Provider替代/畸形UUID/新增字段', () => {
  const local = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  for (const id of ['1', '101', '00101', local]) assert.equal(validateIpcRequest(request(id)).ok, true, id);
  for (const id of ['', '0', '../一.lrc', '/source/一.lrc', 'file:///source/一.lrc', 'lt:' + local, 'not-a-numeric-id',
    local.toUpperCase(), local.slice(0, 14) + '5' + local.slice(15), null, 101]) assert.equal(validateIpcRequest(request(id)).ok, false, String(id));
  for (const field of ['relative', 'path', 'providerId', 'datasetId', 'ticketId']) assert.equal(validateIpcRequest(request(local, { [field]: '不可作为歌词许可' })).ok, false);
});

test('歌词UUID准入不扩大数字播放/喜欢合同，本地回执沿原有界LyricsSnapshot且不携Source证据', () => {
  const id = randomUUID();
  assert.equal(validateIpcRequest({ version: 1, id: 'numeric-like', command: 'library.likeStatus', payload: { trackId: '123' } }).ok, true);
  assert.equal(validateIpcRequest({ version: 1, id: 'local-lyrics', command: 'playback.play', payload: { trackId: id, qualityPreference: 'auto' } }).ok, false);
  assert.equal(validateIpcRequest({ version: 1, id: 'local-lyrics', command: 'library.likeStatus', payload: { trackId: id } }).ok, false);
  const result = { status: 'ready', lines: [{ startMs: 1000, text: '合成旁置正文' }], activeLineIndex: -1, timingSource: 'static' };
  assert.equal(validateIpcResponseForCommand({ version: 1, id: 'local-lyrics', ok: true, result }, 'lyrics.get').ok, true);
  assert.equal(validateIpcResponseForCommand({ version: 1, id: 'local-lyrics', ok: true, result: { ...result, sourceRoot: '/不应发布' } }, 'lyrics.get').ok, false);
});
