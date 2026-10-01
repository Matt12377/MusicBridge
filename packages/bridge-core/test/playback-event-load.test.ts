import assert from 'node:assert/strict';
import test from 'node:test';
import { validateIpcEvent, type PlaybackQueueEntry, type PlaybackSnapshot } from '@music-bridge/contracts';
import { createPlaybackEventPublisher } from '../src/application/playback-event-publisher.js';

for (const size of [50, 500, 5000]) {
  test(`006结构负载：${size}项队列的100个进度tick不读取队列，协议字节有界`, () => {
    let queueReads = 0;
    const source: PlaybackQueueEntry[] = Array.from({ length: size }, (_, index) => ({
      trackId: String(index + 1), qualityPreference: 'auto', preferredSource: 'netease',
      track: { id: String(index + 1), title: '合成曲目', artists: ['合成艺人'], album: '合成专辑', durationMs: 180000 },
    }));
    const items = new Proxy(source, { get(target, key, receiver) {
      queueReads += 1; return Reflect.get(target, key, receiver);
    } });
    const snapshot: PlaybackSnapshot = { state: 'playing', queue: { items, index: 0, hasNext: true, hasPrevious: false },
      currentTrack: source[0]!.track!, source: 'netease', selectedZoneId: 'synthetic-zone', positionMs: 0,
      canNext: true, canPrevious: false, canStop: true, canPause: true, canResume: false };
    let initialized = false, compactBytes = 0, legacyBytes = 0, compactMessages = 0, legacyMessages = 0, maxProgressBytes = 0;
    const compact = createPlaybackEventPublisher(event => {
      assert.equal(validateIpcEvent(event).ok, true);
      if (!initialized) return;
      assert.equal(event.event, 'playback.progress');
      const bytes = Buffer.byteLength(JSON.stringify(event));
      compactBytes += bytes; maxProgressBytes = Math.max(maxProgressBytes, bytes); compactMessages += 1;
    }, { protocol: 'compact-v1' });
    // 当前旧模式在稳定queue引用下每tick发送一个full；历史双tick基线另列。
    const legacy = createPlaybackEventPublisher(event => {
      if (!initialized) return;
      legacyBytes += Buffer.byteLength(JSON.stringify(event)); legacyMessages += 1;
    });
    compact(snapshot, { generation: 1, kind: 'full' }); legacy(snapshot);
    initialized = true; queueReads = 0;
    for (let tick = 1; tick <= 100; tick += 1) compact({ ...snapshot, positionMs: tick * 250 }, { generation: 1, kind: 'position' });
    assert.equal(queueReads, 0, '纯进度不得扫描、复制或序列化源队列');
    for (let tick = 1; tick <= 100; tick += 1) legacy({ ...snapshot, positionMs: tick * 250 });
    assert.equal(compactMessages, 100); assert.equal(legacyMessages, 100);
    assert.ok(maxProgressBytes <= 512); assert.ok(compactBytes < legacyBytes * 0.05);
    console.log(JSON.stringify({ task: 'MBP-006', scope: 'synthetic-publisher-validator-json-structure', queueItems: size,
      ticks: 100, queueReadsDuringCompactTicks: 0, compactBytes, legacyBytes, maxProgressBytes,
      bytesReducedFraction: 1 - compactBytes / legacyBytes }));
  });
}
