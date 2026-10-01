import assert from 'node:assert/strict';
import test from 'node:test';
import { validateIpcEvent, type TypedIpcEvent } from '@music-bridge/contracts';
import { createTestBridgeRuntime } from '../src/runtime.js';

test('synthetic compact与生产共享协议：种子、命令stamp、同曲重播、seek与queue revision', async t => {
  const events: TypedIpcEvent[] = [];
  const runtime = createTestBridgeRuntime({ playbackEventProtocol: 'compact-v1', onEvent: event => events.push(event) });
  t.after(() => runtime.shutdown());
  const ack = runtime.getPlaybackEventProtocol();
  assert.equal(ack?.protocol, 'compact-v1');
  const seed = runtime.getPlaybackStreamSnapshot()!;
  assert.equal(seed.stamp.coreInstanceId, ack?.coreInstanceId);
  assert.equal(seed.stamp.sequence, 1);
  assert.deepEqual(runtime.getPlaybackStreamSnapshot(), seed);
  await runtime.selectZone('synthetic-zone');
  const playing = await runtime.playbackPlay('1000', 'standard');
  assert.ok(playing.stream);
  const first = playing.stream!;
  const replay = await runtime.playbackPlay('1000', 'standard');
  assert.ok(replay.stream!.generation > first.generation);
  const revision = replay.stream!.queueRevision;
  await runtime.seekPlayback(5000);
  const seek = events.at(-1)!;
  assert.equal(seek.event, 'playback.state');
  const appended = await runtime.appendPlaybackQueue([{ trackId: '1001', qualityPreference: 'standard' }]);
  assert.ok(appended.stream!.queueRevision > revision);
  assert.equal(appended.stream!.generation, replay.stream!.generation);
  const stop = await runtime.playbackStop();
  assert.equal(stop.stream!.generation > replay.stream!.generation, true);
  assert.equal(events.some(event => event.event === 'playback.changed' || event.event === 'queue.changed'), false);
  for (const event of events) assert.equal(validateIpcEvent(event).ok, true);
});

test('synthetic legacy默认无stream、无ACK、只读null；同实例与跨实例身份隔离', async t => {
  const legacy = createTestBridgeRuntime();
  const one = createTestBridgeRuntime({ playbackEventProtocol: 'compact-v1' });
  const two = createTestBridgeRuntime({ playbackEventProtocol: 'compact-v1' });
  t.after(async () => { await legacy.shutdown(); await one.shutdown(); await two.shutdown(); });
  assert.equal(legacy.getPlaybackEventProtocol(), null);
  assert.equal(legacy.getPlaybackStreamSnapshot(), null);
  assert.equal('stream' in await legacy.playbackPlay('1000', 'standard'), false);
  assert.notEqual(one.getPlaybackEventProtocol()!.coreInstanceId, two.getPlaybackEventProtocol()!.coreInstanceId);
});
