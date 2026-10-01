import assert from 'node:assert/strict';
import test from 'node:test';
import type { PlaybackSnapshot, TypedIpcEvent } from '@music-bridge/contracts';
import { createPlaybackEventPublisher } from '../src/application/playback-event-publisher.js';

test('播放事件发布器的 100 次合成进度仅发送播放事件，队列变化仍单独通知', () => {
  const events: TypedIpcEvent[] = [];
  const publish = createPlaybackEventPublisher((event) => events.push(event));
  const initial: PlaybackSnapshot = {
    state: 'playing',
    queue: {
      items: [{ trackId: 'synthetic-1', qualityPreference: 'standard' }],
      index: 0, hasNext: false, hasPrevious: false,
    },
    currentTrack: { id: 'synthetic-1', title: 'Synthetic Song', artists: ['Artist'], album: 'Album' },
    source: 'netease', positionMs: 0, canNext: false, canPrevious: false,
    canStop: true, canPause: true, canResume: false,
  };
  publish(initial);
  for (let index = 0; index < 100; index += 1) {
    publish({ ...initial, positionMs: (index + 1) * 250 });
  }
  assert.equal(events.filter((event) => event.event === 'playback.changed').length, 101);
  assert.equal(events.filter((event) => event.event === 'queue.changed').length, 1);
  const appended: PlaybackSnapshot = {
    ...initial,
    queue: {
      items: [...initial.queue.items, { trackId: 'synthetic-2', qualityPreference: 'standard' }],
      index: 0, hasNext: true, hasPrevious: false,
    },
    canNext: true,
  };
  publish(appended);
  publish({ ...appended, queue: { ...appended.queue, index: 1, hasNext: false, hasPrevious: true },
    canNext: false, canPrevious: true });
  const queueEvents = events.filter((event) => event.event === 'queue.changed');
  assert.equal(queueEvents.length, 3);
  assert.deepEqual(queueEvents.map((event) => event.payload.queue.index), [0, 0, 1]);
});

test('队列通知失败后，相同队列的下次发布会重试', () => {
  const events: TypedIpcEvent[] = [];
  let failQueueOnce = true;
  const publish = createPlaybackEventPublisher((event) => {
    if (event.event === 'queue.changed' && failQueueOnce) {
      failQueueOnce = false;
      throw new Error('合成发送失败');
    }
    events.push(event);
  });
  const snapshot: PlaybackSnapshot = {
    state: 'playing',
    queue: {
      items: [{ trackId: 'synthetic-1', qualityPreference: 'standard' }],
      index: 0, hasNext: false, hasPrevious: false,
    },
    currentTrack: { id: 'synthetic-1', title: 'Synthetic Song', artists: ['Artist'], album: 'Album' },
    source: 'netease',
    positionMs: 0,
    canNext: false,
    canPrevious: false,
    canStop: true,
    canPause: true,
    canResume: false,
  };

  assert.throws(() => publish(snapshot), /合成发送失败/);
  publish(snapshot);
  publish({ ...snapshot, positionMs: 100 });

  assert.equal(events.filter((event) => event.event === 'playback.changed').length, 3);
  assert.equal(events.filter((event) => event.event === 'queue.changed').length, 1);
});


const compactInitial: PlaybackSnapshot = {
  state: 'playing', source: 'netease', selectedZoneId: 'zone-a', positionMs: 0,
  currentTrack: { id: '1000', title: '曲目', artists: ['艺人'], album: '专辑' },
  queue: { items: [{ trackId: '1000', qualityPreference: 'standard' }], index: 0, hasNext: false, hasPrevious: false },
  canNext: false, canPrevious: false, canStop: true, canPause: true, canResume: false,
};
const compactMetadata = { generation: 7, kind: 'full' as const };

function compactPublisher(emit: (event: TypedIpcEvent) => void) {
  return createPlaybackEventPublisher(emit, { protocol: 'compact-v1' });
}

test('compact 首基准与100次进度只有小消息，5000队列不遍历', () => {
  const events: TypedIpcEvent[] = [];
  let reads = 0;
  const items = new Proxy(Array.from({ length: 5000 }, (_, index) => ({ trackId: String(1000 + index), qualityPreference: 'standard' as const })), {
    get(target, key, receiver) { if (/^\d+$/.test(String(key))) reads += 1; return Reflect.get(target, key, receiver); },
  });
  const initial = { ...compactInitial, queue: { ...compactInitial.queue, items } };
  const publish = compactPublisher(event => events.push(event));
  publish(initial, compactMetadata);
  reads = 0;
  for (let index = 1; index <= 100; index += 1) publish({ ...initial, positionMs: index * 250 }, { generation: 7, kind: 'position' });
  assert.equal(reads, 0);
  assert.deepEqual(events.map(event => event.event), ['playback.snapshot', ...Array(100).fill('playback.progress')]);
  const last = events.at(-1)!;
  assert.equal(last.event, 'playback.progress');
  if (last.event !== 'playback.progress') return;
  assert.deepEqual(Object.keys(last.payload).sort(), ['positionMs', 'stamp']);
  assert.equal(last.payload.stamp.sequence, 101);
  assert.equal(last.payload.stamp.queueRevision, 1);
  assert.equal(last.payload.stamp.generation, 7);
});

test('compact 前进seek仍是state；新队列revision附队列原子提交', () => {
  const events: TypedIpcEvent[] = [];
  const publish = compactPublisher(event => events.push(event));
  publish(compactInitial, compactMetadata);
  publish({ ...compactInitial, positionMs: 3000 }, compactMetadata);
  assert.equal(events[1]?.event, 'playback.state');
  publish({ ...compactInitial, queue: { ...compactInitial.queue, context: { beforeComplete: false, afterComplete: true, loading: false } } }, compactMetadata);
  const last = events.at(-1)!;
  assert.equal(last.event, 'playback.state');
  if (last.event !== 'playback.state') return;
  assert.equal(last.payload.stamp.queueRevision, 2);
  assert.ok(last.payload.queue?.context);
  assert.equal('queue' in last.payload.state, false);
});

test('compact capture同事实不消耗序号；新Zone/owner/克隆队列不能贴旧序号', () => {
  const events: TypedIpcEvent[] = [];
  const publish = compactPublisher(event => events.push(event));
  publish(compactInitial, compactMetadata);
  const first = publish.capture(compactInitial, compactMetadata)!;
  assert.equal(publish.capture(structuredClone(compactInitial), compactMetadata)!.stamp.sequence, first.stamp.sequence);
  assert.equal(events.length, 1);
  const next = publish.capture({ ...compactInitial, selectedZoneId: 'zone-b' }, { generation: 8, kind: 'full' })!;
  assert.equal(next.stamp.sequence, 2);
  assert.equal(next.stamp.generation, 8);
  assert.equal(next.stamp.selectedZoneId, next.snapshot.selectedZoneId);
  assert.equal(next.stamp.queueRevision, 1);
  assert.equal('stream' in next.snapshot, false);
  assert.deepEqual(publish.stamp({ ...compactInitial, selectedZoneId: 'zone-b' }, { generation: 8, kind: 'full' }).stream, next.stamp);
});

test('compact 发送失败后下一次出版全基准且序号不假装已送达', () => {
  const events: TypedIpcEvent[] = [];
  let fail = false;
  const publish = compactPublisher(event => { if (fail) { fail = false; throw new Error('发送失败'); } events.push(event); });
  publish(compactInitial, compactMetadata);
  fail = true;
  assert.throws(() => publish({ ...compactInitial, positionMs: 100 }, { generation: 7, kind: 'position' }), /发送失败/);
  publish({ ...compactInitial, positionMs: 200 }, { generation: 7, kind: 'position' });
  assert.deepEqual(events.map(event => event.event), ['playback.snapshot', 'playback.snapshot']);
  const last = events.at(-1)!;
  if (last.event !== 'playback.snapshot') return;
  assert.equal(last.payload.stamp.sequence, 3);
  assert.equal(last.payload.snapshot.positionMs, 200);
});

test('compact 同曲重播新generation，metadata变化不得假作progress', () => {
  const events: TypedIpcEvent[] = [];
  const publish = compactPublisher(event => events.push(event));
  publish(compactInitial, compactMetadata);
  publish(compactInitial, { generation: 8, kind: 'position' });
  publish({ ...compactInitial, lastError: '合成错误' }, { generation: 8, kind: 'position' });
  assert.deepEqual(events.map(event => event.event), ['playback.snapshot', 'playback.state', 'playback.state']);
});

test('legacy capture/ACK为null，命令stamp不改变旧shape', () => {
  const publish = createPlaybackEventPublisher(() => {});
  assert.equal(publish.getProtocol(), null);
  assert.equal(publish.capture(compactInitial, compactMetadata), null);
  assert.equal(publish.stamp(compactInitial, compactMetadata), compactInitial);
});


test('compact 保留的基准不可被后来的调用者改写，非法/过时代次零出版', () => {
  const events: TypedIpcEvent[] = [];
  const publish = compactPublisher(event => events.push(event));
  const input = structuredClone(compactInitial);
  publish(input, compactMetadata);
  const captured = publish.capture(input, compactMetadata)!;
  input.currentTrack!.title = '后来修改';
  input.queue.items[0]!.trackId = '2000';
  assert.equal(captured.snapshot.currentTrack!.title, '曲目');
  assert.equal(captured.snapshot.queue.items[0]!.trackId, '1000');
  assert.equal(Object.isFrozen(captured.snapshot.queue.items), true);
  for (const generation of [6, -1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => publish(compactInitial, { generation, kind: 'full' }), /代次无效/);
  }
  assert.equal(events.length, 1);
});

test('compact 未送达的同事实readonly full不虚耗seq，随后仍full恢复', () => {
  let fail = true;
  const events: TypedIpcEvent[] = [];
  const publish = compactPublisher(event => { if (fail) { fail = false; throw new Error('发送失败'); } events.push(event); });
  assert.throws(() => publish(compactInitial, compactMetadata), /发送失败/);
  const read = publish.capture(compactInitial, compactMetadata)!;
  assert.equal(read.stamp.sequence, 1);
  assert.equal(events.length, 0);
  publish(compactInitial, { generation: 7, kind: 'position' });
  assert.equal(events[0]!.event, 'playback.snapshot');
});
