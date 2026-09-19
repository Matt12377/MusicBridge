import assert from 'node:assert/strict';
import test from 'node:test';
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
