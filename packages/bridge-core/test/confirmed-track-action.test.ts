import assert from 'node:assert/strict';
import test from 'node:test';
import { getEventListeners } from 'node:events';
import { runConfirmedTrackAction } from '../src/roon/confirmed-track-action.js';
import type { RoonPlaybackObservation } from '../src/roon/types.js';

const observation: RoonPlaybackObservation = { revision: 2, zoneId: 'zone-1', state: 'playing', nowPlaying: { title: '新专辑首曲' } };
const turn = () => new Promise(resolve => setImmediate(resolve));

test('新曲已确认而 Browse 回执仍未返回时立即完成，不等待回执超时', async () => {
  let release!: () => void;
  let finished = false;
  const result = runConfirmedTrackAction({
    dispatch: async onDispatch => { onDispatch(); await new Promise<void>(resolve => { release = resolve; }); return 'accepted'; },
    confirm: async () => observation,
  }).then(value => { finished = true; return value; });
  await turn();
  try { assert.equal(finished, true); assert.deepEqual(await result, observation); }
  finally { release(); await result; }
});

test('Browse 接受不等于播放成功，仍等待匹配事件', async () => {
  let confirm!: (value: RoonPlaybackObservation) => void;
  let finished = false;
  const result = runConfirmedTrackAction({
    dispatch: async onDispatch => { onDispatch(); return 'accepted'; },
    confirm: () => new Promise(resolve => { confirm = resolve; }),
  }).then(value => { finished = true; return value; });
  await turn(); assert.equal(finished, false);
  confirm(observation); assert.deepEqual(await result, observation);
});

test('导航失败不启动确认，确认超时不被成功回执覆盖', async () => {
  await assert.rejects(runConfirmedTrackAction({ dispatch: async () => { throw Error('身份校验失败'); }, confirm: async () => { assert.fail('不可开始确认'); } }), /身份校验失败/);
  await assert.rejects(runConfirmedTrackAction({ dispatch: async onDispatch => { onDispatch(); return 'accepted'; }, confirm: async () => { throw Error('目标曲目没有确认'); } }), /目标曲目没有确认/);
});

test('迟到的 Browse 错误不能覆盖先到的有效播放确认，也不产生未处理拒绝', async () => {
  let rejectResponse!: (error: Error) => void;
  const result = runConfirmedTrackAction({
    dispatch: async onDispatch => { onDispatch(); return new Promise((_resolve, reject) => { rejectResponse = reject; }); },
    confirm: async () => observation,
  });
  await turn();
  const outcome = result.then(value => ({ value }), error => ({ error }));
  rejectResponse(Error('迟到回执错误'));
  assert.deepEqual(await outcome, { value: observation });
});

test('MBP003A：取消导航立即结束等待，迟到onDispatch不得写入播放', async () => {
  const controller = new AbortController();
  let release!: () => void, writes = 0, finished = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const result = runConfirmedTrackAction({
    signal: controller.signal,
    dispatch: async onDispatch => { await gate; onDispatch(); ++writes; return 'accepted'; },
    confirm: async () => observation,
  }).then(value => { finished = true; return { value }; }, error => { finished = true; return { error }; });
  await turn(); controller.abort(); await turn();
  try {
    assert.equal(finished, true, '取消不能等待不可取消的Browse导航返回');
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  } finally { release(); await result; }
  assert.equal(writes, 0, '迟到导航不能越过派发守卫');
  assert.equal('error' in await result, true);
});

test('MBP003A：已取消不启动导航；派发后取消确认不改变迟到回执', async () => {
  const already = new AbortController(); already.abort(); let writes = 0;
  const early = runConfirmedTrackAction({ signal: already.signal,
    dispatch: async onDispatch => { onDispatch(); ++writes; return 'accepted'; }, confirm: async () => observation,
  });
  await assert.rejects(early, error => (error as { details?: { reason?: string } }).details?.reason === 'operation_cancelled');
  assert.equal(writes, 0);
  const controller = new AbortController(); let ack!: () => void, confirm!: (value: RoonPlaybackObservation) => void;
  const pending = runConfirmedTrackAction({ signal: controller.signal,
    dispatch: async onDispatch => { onDispatch(); ++writes; await new Promise<void>(resolve => { ack = resolve; }); return 'accepted'; },
    confirm: () => new Promise(resolve => { confirm = resolve; }),
  });
  const rejected = assert.rejects(pending, error => (error as { details?: { reason?: string } }).details?.reason === 'operation_cancelled');
  await turn(); controller.abort(); await rejected;
  assert.equal(writes, 1); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  ack(); confirm(observation); await turn();
});

test('MBP003A：首派发登记同步取消时不开始确认或写入', async () => {
  const controller = new AbortController(); let confirmations = 0, writes = 0;
  await assert.rejects(runConfirmedTrackAction({ signal: controller.signal, onDispatch: () => controller.abort(),
    dispatch: async onDispatch => { onDispatch(); ++writes; return 'accepted'; },
    confirm: async () => { ++confirmations; return observation; },
  }));
  assert.equal(writes, 0); assert.equal(confirmations, 0);
});

test('MBP003A：确认注册同步取消仍挡住首写，并消费被取消确认的迟到拒绝', async () => {
  const controller = new AbortController(); let writes = 0;
  await assert.rejects(runConfirmedTrackAction({ signal: controller.signal,
    dispatch: async onDispatch => { onDispatch(); ++writes; return 'accepted'; },
    confirm: () => { controller.abort(); return Promise.reject(Error('合成取消确认')); },
  }));
  await turn(); assert.equal(writes, 0); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
