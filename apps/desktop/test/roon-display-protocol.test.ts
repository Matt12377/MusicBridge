import test from 'node:test'
import assert from 'node:assert/strict'
import { RoonDisplayProtocol } from '../src/main/roon-display-protocol.js'
import { normalizeRoonDisplayUrl, isRoonDisplayLyricsEvent, validateIpcRequest, validateIpcResponseForCommand, validateIpcInternalResponseForCommand } from '@music-bridge/contracts'
const packet = (name: string, body: unknown) => `MOO/1 CONTINUE ${name}\nRequest-Id: 3\nContent-Type: application/json\n\n${JSON.stringify(body)}`
const zone = (title = '歌曲') => ({ zone_id: 'zone1', now_playing: { three_line: { line1: title, line2: '艺人', line3: '专辑' }, length: 180 } })

test('真实协议形状：只投影歌词与当前曲目信息，不转发 key/token 或整包', () => {
  const protocol = new RoonDisplayProtocol()
  assert.equal(protocol.receive(packet('Registered', { token: 'secret' }), 1).length, 0)
  assert.equal(protocol.receive(packet('Subscribed', { zones: [zone()] }), 1).length, 2)
  const lyrics = protocol.receive(packet('LyricsChanged', { zone_id: 'zone1', key: 'private-key', lrc: '[00:00.00]歌词' }), 1)
  assert.equal(lyrics.length, 1)
  assert.ok(!JSON.stringify(lyrics).includes('private-key'))
  assert.ok(lyrics.every(isRoonDisplayLyricsEvent))
});
test('换歌先清旧词，seek 更新不清词，区域删除/重连清空身份', () => {
  const protocol = new RoonDisplayProtocol()
  protocol.receive(packet('Subscribed', { zones: [zone()] }), 1)
  assert.equal(protocol.receive(packet('Changed', { zones_seek_changed: [{ zone_id: 'zone1', seek_position: 30 }] }), 1).length, 0)
  assert.deepEqual(protocol.receive(packet('Changed', { zones_changed: [zone('下一首')] }), 1).map(event => event.type === 'zone' && event.lrc), [null])
  protocol.receive(packet('Changed', { zones_removed: ['zone1'] }), 1)
  assert.equal(protocol.receive(packet('LyricsChanged', { zone_id: 'zone1', lrc: '旧词' }), 1).length, 0)
  protocol.clear()
  assert.equal(protocol.receive(packet('LyricsChanged', { zone_id: 'zone1', lrc: '旧词' }), 1).length, 0)
});
test('已知区域的增量更新缺 now_playing 时保留曲目，显式 null 才清空', () => {
  const protocol = new RoonDisplayProtocol()
  protocol.receive(packet('Subscribed', { zones: [zone('当前歌曲')] }), 1)
  assert.deepEqual(protocol.receive(packet('Changed', { zones_changed: [{ zone_id: 'zone1', state: 'playing' }] }), 1), [])
  const lyrics = protocol.receive(packet('LyricsChanged', { zone_id: 'zone1', lrc: '[00:00.00]当前歌词' }), 1)
  assert.equal(lyrics.length, 1)
  assert.equal(lyrics[0]?.type === 'zone' ? lyrics[0].track?.title : undefined, '当前歌曲')
  assert.deepEqual(protocol.receive(packet('Changed', { zones_changed: [{ zone_id: 'zone1', now_playing: null }] }), 1), [
    { type: 'zone', zoneId: 'zone1', track: null, lrc: null },
  ])
});
test('非法 now_playing 不清除已知区域，也不建立未知区域', () => {
  const protocol = new RoonDisplayProtocol()
  protocol.receive(packet('Subscribed', { zones: [zone('当前歌曲')] }), 1)
  assert.deepEqual(protocol.receive(packet('Changed', { zones_changed: [{ zone_id: 'zone1', now_playing: '损坏' }] }), 1), [])
  assert.deepEqual(protocol.receive(packet('Changed', { zones_changed: [{ zone_id: 'zone2', now_playing: { three_line: {} } }] }), 1), [])
  assert.equal(protocol.receive(packet('LyricsChanged', { zone_id: 'zone2', lrc: '不应接收' }), 1).length, 0)
  const lyrics = protocol.receive(packet('LyricsChanged', { zone_id: 'zone1', lrc: '仍属当前歌曲' }), 1)
  assert.equal(lyrics[0]?.type === 'zone' ? lyrics[0].track?.title : undefined, '当前歌曲')
});
test('新增区域和全快照缺 now_playing 表示无曲目，不继承旧区域状态', () => {
  const protocol = new RoonDisplayProtocol()
  protocol.receive(packet('Subscribed', { zones: [zone('旧歌曲')] }), 1)
  assert.deepEqual(protocol.receive(packet('Changed', { zones_added: [{ zone_id: 'zone2' }] }), 1), [
    { type: 'zone', zoneId: 'zone2', track: null, lrc: null },
  ])
  assert.deepEqual(protocol.receive(packet('Subscribed', { zones: [{ zone_id: 'zone1' }] }), 1), [
    { type: 'reset', enabled: true },
    { type: 'zone', zoneId: 'zone1', track: null, lrc: null },
  ])
  assert.equal(protocol.receive(packet('LyricsChanged', { zone_id: 'zone2', lrc: '旧区域' }), 1).length, 0)
});
test('二进制帧与 CRLF 可解析，损坏/超限/未知数据不进入业务', () => {
  const protocol = new RoonDisplayProtocol()
  assert.equal(protocol.receive(Buffer.from(packet('Subscribed', { zones: [zone()] }).replaceAll('\n', '\r\n')).toString('base64'), 2).length, 2)
  assert.equal(protocol.receive('x'.repeat(1024 * 1024 + 1), 1).length, 0)
  assert.equal(protocol.receive('MOO/1 CONTINUE LyricsChanged\n\n{bad}', 1).length, 0)
  assert.equal(protocol.receive(packet('WaveformChanged', { waveform: [] }), 1).length, 0)
});
test('只接受明确局域网 Display URL，拒绝凭据、公网、协议和任意路径', () => {
  assert.equal(normalizeRoonDisplayUrl('http://192.168.1.2:9330/display'), 'http://192.168.1.2:9330/display/')
  assert.equal(normalizeRoonDisplayUrl(''), '')
  for (const url of ['https://example.com/display/', 'file:///display/', 'http://user:pass@192.168.1.2/display/', 'http://192.168.1.2/other', 'http://192.168.1.2/display/?token=secret', 'http://169.254.169.254/display/']) assert.throws(() => normalizeRoonDisplayUrl(url))
});
test('歌词更新仅有内部响应，严格限制消息字段和长度', () => {
  const request = { version: 1, id: 'test', command: 'lyrics.display.update', payload: { type: 'reset', enabled: true } }
  assert.equal(validateIpcRequest(request).ok, true)
  assert.equal(validateIpcRequest({ ...request, payload: { ...request.payload, token: 'secret' } }).ok, false)
  const response = { version: 1, id: 'test', ok: true, result: { applied: true } }
  assert.equal(validateIpcResponseForCommand(response, 'lyrics.display.update').ok, false)
  assert.equal(validateIpcInternalResponseForCommand(response, 'lyrics.display.update').ok, true)
});
