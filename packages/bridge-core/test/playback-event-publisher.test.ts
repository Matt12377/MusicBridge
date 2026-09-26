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
