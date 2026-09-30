import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertExternalOutput, rendererPlaybackScenario, detailFirstPageScenario,
  publisherScenario, duplicateContextScenario, multiDiscScenario,
} from './baseline.js';

test('真实播放入口的基线记录闸门与分页序列，不将合成计数当耗时', async () => {
  const result = await rendererPlaybackScenario(50, 24);
  assert.equal(result.total, 50);
  assert.equal(result.dispatchedReferenceCount, 50);
  assert.equal(result.uniqueDispatchedReferenceCount, 50);
  assert.equal(result.remainingPageRequests.length, 2);
  const actualCompletedBeforePlay = result.sequence.slice(0, result.sequence.indexOf('playRoonTrack')).filter((item) => item.startsWith('page-return:')).length;
  assert.equal(result.pagesCompletedBeforePlayback, actualCompletedBeforePlay);
  assert.equal('durationMs' in result, false);
});

test('真实 Roon Library 三类首屏场景的 SDK 计数来自已执行回调', async () => {
  for (const kind of ['album', 'artist', 'playlist'] as const) {
    const result = await detailFirstPageScenario(kind, 250, 24);
    assert.equal(result.returnedPageItems, 24);
    assert.equal(result.reportedTotal, 250);
    assert.equal(result.sdkLoadCount, result.sdkLoads.length);
    assert.equal(result.loadedBeforeFirstPage, result.sdkLoads.reduce((sum, load) => sum + load.returnedCount, 0));
    assert.ok(result.loadedBeforeFirstPage >= result.returnedPageItems);
    assert.equal(result.collectedFullListBeforeReturningFirstPage, result.loadedBeforeFirstPage >= result.total);
  }
});

test('事件基线保留双 tick 的实际事件数量和 JSON 字节估计', () => {
  const sizes = [50, 500, 5_000].map(publisherScenario);
  for (const result of sizes) {
    assert.equal(result.ticks.length, 2);
    assert.equal(result.eventCount, result.ticks.reduce((sum, tick) => sum + tick.eventCount, 0));
    assert.equal(result.jsonBytesEstimate, result.ticks.reduce((sum, tick) => sum + tick.jsonBytesEstimate, 0));
    assert.ok(result.ticks.every((tick) => tick.eventCount > 0 && tick.jsonBytesEstimate > 0));
    assert.match(result.byteEstimateBoundary, /不是 Electron IPC/);
  }
});

test('重复出现与多碟场景观察 sourceIndex 和出现身份，不改变原有语义', async () => {
  const duplicates = await duplicateContextScenario();
  assert.equal(duplicates.distinctOccurrencesCollected, 3);
  assert.equal(duplicates.distinctOccurrencesPreserveOrder, true);
  const multiDisc = await multiDiscScenario();
  assert.equal(multiDisc.returned, 6);
  assert.equal(multiDisc.uniqueOccurrencePathCount, 6);
  assert.equal(multiDisc.repeatedTitleCount, 4);
  assert.deepEqual(multiDisc.items.map((item) => [item.discNumber, item.trackNumber, item.sourceIndex]), [[1, 1, 0], [1, 2, 1], [1, 3, 2], [2, 1, 0], [2, 2, 1], [2, 3, 2]]);
});

test('输出合同拒绝相对路径、非 JSON 以及外置卷之外的真实目录', async () => {
  await assert.rejects(assertExternalOutput('baseline.json'));
  await assert.rejects(assertExternalOutput('/Volumes/LifeWeave/Developer/CommandLine/tmp/baseline.txt'));
  await assert.rejects(assertExternalOutput('/Volumes/forbidden-baseline.json'));
});
