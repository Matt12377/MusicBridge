import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { LyricsSnapshot, PlaybackSnapshot } from '@music-bridge/contracts';
import { validateIpcEvent } from '@music-bridge/contracts';
import { LyricsCoordinator, createLyricsRequestContext, type LocalFileLyricsContext } from '../src/lyrics/coordinator.js';
import { parseLocalPlaybackLrc } from '../src/library/local-playback-lyrics.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
const ready = (text: string): LyricsSnapshot => parseLocalPlaybackLrc(Buffer.from(`[00:01.00]${text}\n[00:02.00]下一行`));
function playing(trackId: string = randomUUID(), assetId: string = randomUUID(), revision = '1', attempt = 'owner-attempt-1'): PlaybackSnapshot {
  const track = { id: trackId, title: '合成曲目', artists: ['合成作者'], album: '合成专辑' };
  return { state: 'playing', source: 'local_file', currentTrack: track, positionMs: 0, selectedZoneId: 'synthetic-zone',
    queue: { items: [{ trackId, track, resolvedSource: 'local_file', qualityPreference: 'auto',
      local: { local_track_id: trackId, asset_id: assetId, asset_revision: revision, selection_revision: '1', location_revision: '1', root_revision: '1' } }], index: 0, hasNext: false, hasPrevious: false },
    canNext: false, canPrevious: false, canStop: true, canPause: true, canResume: false,
    local: { schema_version: '1.2', request_id: randomUUID(), attempt_id: attempt, intent_generation: '1', route: 'roon_audio_input',
      local_track_id: trackId, asset_id: assetId, asset_revision: revision, target: { core_id: 'synthetic-core', zone_id: 'synthetic-zone' },
      session_epoch: 'synthetic-confirmed-session', phase: 'PLAYING', ownership: 'MB_OWNED', queue_owner: 'MB', delivery_state: 'UNKNOWN', position_ms: 0,
      roon_observation: { event: 'PLAYING', observed: true, correlation: 'ATTEMPT_CONFIRMED' },
      quality: { http_bytes: 'NOT_TESTED', signal_path: 'NOT_TESTED', digital_output: 'NOT_TESTED', gapless: 'NOT_TESTED' }, error_code: null } };
}
function context(snapshot: PlaybackSnapshot, generation = 1): LocalFileLyricsContext {
  assert.equal(validateIpcEvent({ version: 1, event: 'playback.changed', payload: { state: snapshot } }).ok, true);
  const result = createLyricsRequestContext(snapshot, generation); assert.equal(result?.kind, 'local-file');
  if (result?.kind !== 'local-file') throw new Error('没有生成合法本地播放上下文'); return result;
}

test('本地歌词上下文绑定实际队列UUID/asset修订/attempt，错配不转Provider查询', async t => {
  const snapshot = playing(), current = context(snapshot, 7);
  assert.equal(current.localTrackId, snapshot.currentTrack!.id); assert.equal(current.assetId, snapshot.local!.asset_id);
  assert.equal(current.assetRevision, snapshot.local!.asset_revision); assert.equal(current.attemptId, snapshot.local!.attempt_id); assert.equal(current.playbackGeneration, 7);
  for (const change of [(s: PlaybackSnapshot) => { s.local!.asset_id = randomUUID(); }, (s: PlaybackSnapshot) => { s.local!.asset_revision = '2'; },
    (s: PlaybackSnapshot) => { delete s.local; }, (s: PlaybackSnapshot) => { s.queue.items = []; }]) {
    const value = structuredClone(snapshot); change(value); assert.equal(createLyricsRequestContext(value, 7)?.kind, 'unavailable');
  }
  let provider = 0, local = 0;
  const coordinator = new LyricsCoordinator({ load: async () => { provider++; return ready('云端内容'); }, localFile: { read: async () => { local++; return ready('旁置正文'); }, isCurrent: () => false } });
  t.after(() => coordinator.shutdown());
  coordinator.onPlaybackChanged(snapshot, current); await tick();
  assert.equal((await coordinator.getLyrics(snapshot.currentTrack!.id)).status, 'unavailable');
  assert.equal((await coordinator.getLyrics(randomUUID())).status, 'unavailable'); assert.equal(provider, 0); assert.equal(local, 0);
  await coordinator.getLyrics('123456'); assert.equal(provider, 1, '原数字网易ID仍走原路径');
});

test('本地歌词：同曲新attempt/修订晚到不覆盖，读完再核Owner当前资格且无跨attempt缓存', async t => {
  const first = playing(), a = context(first, 1), bSnapshot = playing(first.currentTrack!.id, first.local!.asset_id, '2', 'owner-attempt-2'), b = context(bSnapshot, 2);
  const waits = [deferred<LyricsSnapshot>(), deferred<LyricsSnapshot>()], calls: LocalFileLyricsContext[] = [], events: LyricsSnapshot[] = [];
  let active = a, provider = 0;
  const coordinator = new LyricsCoordinator({ load: async () => { provider++; return ready('绝不能匹配云端'); }, localFile: {
    isCurrent: value => value.playbackGeneration === active.playbackGeneration && value.attemptId === active.attemptId && value.assetRevision === active.assetRevision,
    read: value => { calls.push(value); return waits[calls.length - 1]!.promise; } }, onChange: value => events.push(value) });
  t.after(() => coordinator.shutdown());
  coordinator.onPlaybackChanged(first, a); active = b; coordinator.onPlaybackChanged(bSnapshot, b);
  assert.equal(calls.length, 2); waits[1]!.resolve(ready('当前B')); await tick(); assert.equal(coordinator.getSnapshot().lines[0]?.text, '当前B');
  waits[0]!.resolve(ready('过期A')); await tick(); assert.equal(coordinator.getSnapshot().lines[0]?.text, '当前B');
  assert.ok(!events.some(event => event.lines.some(line => line.text === '过期A'))); assert.equal(provider, 0); assert.equal(coordinator.cacheSize, 0);
  active = { ...b, attemptId: 'owner-attempt-3' }; assert.equal(coordinator.getSnapshot().status, 'unavailable', '撤销后不返回已缓存旁置正文');
  assert.equal((await coordinator.getLyrics(first.currentTrack!.id)).status, 'unavailable');
});

test('本地歌词：读取期间Source/Owner失权的返回不发布ready，也不发布错误Provider来源', async t => {
  const snapshot = playing(), active = context(snapshot), wait = deferred<LyricsSnapshot>(), events: LyricsSnapshot[] = []; let allowed = true;
  const coordinator = new LyricsCoordinator({ load: async () => { throw new Error('禁止Provider'); }, localFile: { isCurrent: () => allowed, read: () => wait.promise }, onChange: value => events.push(value) });
  t.after(() => coordinator.shutdown()); coordinator.onPlaybackChanged(snapshot, active); allowed = false; wait.resolve(ready('已失权正文')); await tick();
  assert.equal(coordinator.getSnapshot().status, 'unavailable'); assert.ok(!events.some(event => event.status === 'ready')); assert.ok(events.every(event => event.source === undefined));
});

test('本地歌词：沿既有实际播放位置推进第二行，paused不增加估算时间，同曲进度不重读', async t => {
  const snapshot = playing(), active = context(snapshot); let reads = 0, now = 0;
  const coordinator = new LyricsCoordinator({ load: async () => { throw new Error('禁止Provider'); }, localFile: { isCurrent: () => true, read: async () => { reads++; return ready('第一行'); } }, now: () => now });
  t.after(() => coordinator.shutdown()); coordinator.onPlaybackChanged(snapshot, active); await tick();
  coordinator.onPlaybackChanged({ ...snapshot, positionMs: 2100 }, active);
  assert.equal(coordinator.getSnapshot().activeLineIndex, 1, '若没有真实next endMs会永久停第一行');
  coordinator.onPlaybackChanged({ ...snapshot, state: 'paused', positionMs: 2100 }, active); now += 5000;
  assert.equal(coordinator.getSnapshot().activeLineIndex, 1); assert.equal(reads, 1);
});
