import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { FakeMoo, loadOfficialAudioInput, nextTurn, readyFakeAdapter, SYNTHETIC_ZONE } from '../fake-roon-sdk.js';
import type { RoonTimeEvent } from '../../../src/roon/types.js';

const request = {
  expectedZoneId: SYNTHETIC_ZONE,
  mediaUrl: 'http://127.0.0.1:1/sample/synthetic-memory-only',
  iconUrl: 'http://127.0.0.1:38502/assets/icon.png',
  metadata: { id: 'synthetic-one', title: 'Same synthetic name', artists: ['Synthetic'], album: 'Synthetic', durationMs: 120_000 },
};
async function harness(t: TestContext, mode: 'track' | 'channel' = 'track') {
  const ready = await readyFakeAdapter({ playbackMode: mode });
  t.after(async () => { await ready.adapter.shutdown().catch(() => undefined); });
  return ready;
}
async function beginPlaying(ready: Awaited<ReturnType<typeof readyFakeAdapter>>) {
  const pending = ready.adapter.play(request); await nextTurn();
  assert.equal(ready.sdk.moo.count('play'), 0);
  ready.sdk.moo.emitBegin(); ready.sdk.moo.emitPlay(); await pending;
}
async function confirmedStop(ready: Awaited<ReturnType<typeof readyFakeAdapter>>) {
  const pending = ready.adapter.stop({ expectedZoneId: SYNTHETIC_ZONE }); await nextTurn();
  ready.sdk.moo.replyEnd(ready.sdk.moo.count('end_session') - 1); await pending;
}

test('MBRS001 官方薄类：begin字符串、play原消息对象、早期end无moo请求', () => {
  const Official = loadOfficialAudioInput(); const moo = new FakeMoo();
  const audio = new Official({ moo });
  let beginType = ''; let playType = ''; let sessionId = '';
  const session = audio.begin_session({ zone_id: SYNTHETIC_ZONE }, (message, body) => {
    beginType = typeof message; sessionId = (body as { session_id: string }).session_id;
  });
  session.end_session(() => undefined); assert.equal(moo.count('end_session'), 0);
  moo.emitBegin(); assert.equal(beginType, 'string');
  audio.play({ session_id: sessionId, track_id: 'synthetic-track', type: 'track', slot: 'play', media_url: request.mediaUrl,
    info: { is_seek_allowed: true, is_pause_allowed: true, one_line: { line1: 'Synthetic' }, two_line: { line1: 'Synthetic' }, three_line: { line1: 'Synthetic' } } },
    message => { playType = typeof message; });
  moo.emitPlay(); assert.equal(playType, 'object');
  session.end_session(() => undefined); assert.equal(moo.count('end_session'), 1);
  assert.equal(moo.ledger()[0]!.remoteStop, 'UNCONFIRMED');
  moo.replyEnd(); assert.equal(moo.ledger()[0]!.sessionConfirmedClosed, true);
  assert.throws(() => moo.emitPlay(1), /没有实际发送/u);
  moo.disconnect(); assert.equal(moo.callbackSlots(), 0);
});

for (const mode of ['track', 'channel'] as const) {
  test(`MBRS001 原Adapter ${mode}：显式Zone、精确单play槽位与官方payload`, async t => {
    const ready = await harness(t, mode); await beginPlaying(ready);
    const { sdk } = ready;
    const begin = sdk.moo.request('begin_session').payload;
    assert.deepEqual(Object.keys(begin).sort(), ['display_name', 'icon_url', 'zone_id']);
    assert.equal(begin.zone_id, SYNTHETIC_ZONE); assert.equal(begin.icon_url, request.iconUrl);
    const play = sdk.moo.request('play').payload;
    assert.equal(play.type, mode); assert.equal(play.slot, 'play'); assert.equal(play.media_url, request.mediaUrl);
    assert.equal(play.track_id, 'musicbridge-synthetic-track-1'); assert.notEqual(play.track_id, request.metadata.id);
    assert.equal(play.seek_position_ms, mode === 'track' ? 0 : undefined);
    const info = play.info as Record<string, unknown>;
    assert.equal(info.is_seek_allowed, mode === 'track'); assert.equal(info.is_pause_allowed, true);
    assert.equal(info.length, mode === 'track' ? 120 : undefined);
    assert.deepEqual(sdk.moo.request('update_transport_controls').payload.controls, { is_previous_allowed: false, is_next_allowed: false });
    assert.equal(sdk.optionalServices.length, 0); assert.equal(sdk.requiredServices.length, 2);
    assert.equal(ready.adapter.getLibraryService(), undefined);
    assert.deepEqual(sdk.forbiddenCalls, { browse: 0, resolver: 0, enhancement: 0 });
    await confirmedStop(ready);
  });
}

test('MBRS001 Time：只证可观察seek_position_ms；字段、负数、非整数拒绝', async t => {
  const ready = await harness(t); await beginPlaying(ready);
  const observations: RoonTimeEvent[] = []; ready.adapter.setTimeHandler(event => observations.push(event));
  ready.sdk.moo.emitPlay(0, 'Time', { seek_position_ms: 1234 });
  assert.deepEqual(observations.map(event => event.positionMs), [1234]);
  for (const body of [{ seek_position: 1234 }, { seek_position_ms: -1 }, { seek_position_ms: 1.25 }, { seek_position_ms: Number.MAX_SAFE_INTEGER }]) {
    ready.sdk.moo.emitPlay(0, 'Time', body);
  }
  assert.equal(observations.length, 1);
  // 一个合法整数不能自带单位信息；1仍按既有合同映射1ms，不声称能识别秒误传。
  ready.sdk.moo.emitPlay(0, 'Time', { seek_position_ms: 1 }); assert.equal(observations.at(-1)!.positionMs, 1);
  assert.equal(observations[0]!.zoneId, SYNTHETIC_ZONE); assert.equal(observations[0]!.playbackEpoch, ready.adapter.getActivePlaybackEpoch());
  await confirmedStop(ready);
});

test('MBRS001 控制：pause/resume等新Zone观测，seek1234ms发送1.234秒', async t => {
  const ready = await harness(t); await beginPlaying(ready);
  ready.sdk.transport.emit('playing');
  let settled = false;
  const pause = ready.adapter.pause({ expectedZoneId: SYNTHETIC_ZONE }).then(() => { settled = true; });
  await nextTurn(); assert.equal(settled, false);
  assert.deepEqual(ready.sdk.transport.controls[0], { target: { zone_id: SYNTHETIC_ZONE }, control: 'pause' });
  ready.sdk.transport.emit('paused'); await pause;
  assert.equal(ready.sdk.moo.count('end_session'), 0);
  const resume = ready.adapter.resume({ expectedZoneId: SYNTHETIC_ZONE }); await nextTurn();
  ready.sdk.transport.emit('playing'); await resume;
  const seek = ready.adapter.seek(1234, { expectedZoneId: SYNTHETIC_ZONE }); await nextTurn();
  assert.deepEqual(ready.sdk.transport.seeks[0], { target: SYNTHETIC_ZONE, how: 'absolute', seconds: 1.234 });
  ready.sdk.transport.emit('playing', 1.234); await seek;
  const writes = ready.sdk.transport.controls.length + ready.sdk.transport.seeks.length;
  await assert.rejects(ready.adapter.seek(1234, { expectedZoneId: 'wrong-zone' }), /设备/u);
  assert.equal(ready.sdk.transport.controls.length + ready.sdk.transport.seeks.length, writes);
  await confirmedStop(ready);
});

test('MBRS001 Paused：启动Promise可resolve，不能冒充Playing观察', async t => {
  const ready = await harness(t); const stages: string[] = [];
  const pending = ready.adapter.play({ ...request, onStartupStage: stage => stages.push(stage) }); await nextTurn();
  ready.sdk.moo.emitBegin(); ready.sdk.moo.emitPlay(0, 'Paused'); await pending;
  assert.equal(ready.adapter.getState().status, 'paused'); assert.deepEqual(stages, ['roon-session-began']);
  await confirmedStop(ready);
});

test('MBRS001 无增强：有效提交零禁止端口调用，禁止端口自身会拒绝', async t => {
  const ready = await harness(t); await beginPlaying(ready);
  assert.deepEqual(ready.sdk.forbiddenCalls, { browse: 0, resolver: 0, enhancement: 0 });
  await confirmedStop(ready);
  for (const kind of ['browse', 'resolver', 'enhancement'] as const) assert.throws(() => ready.sdk.forbidden(kind), /禁止/u);
  assert.deepEqual(ready.sdk.forbiddenCalls, { browse: 1, resolver: 1, enhancement: 1 });
});
