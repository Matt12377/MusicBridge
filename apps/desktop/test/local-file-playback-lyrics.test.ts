import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { LyricsSnapshot, PlaybackSnapshot } from '@music-bridge/contracts';
import { validateIpcEvent } from '@music-bridge/contracts';
import type { MusicBridgePublicApi } from '../src/preload/api.js';
import { usePlaybackSession } from '../src/renderer/src/composables/application/usePlaybackSession.js';
import { favoriteDescriptorForRoonItem } from '../src/renderer/src/composables/playbackFavorites.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const ready = (text: string): LyricsSnapshot => ({ status: 'ready', lines: [{ startMs: 0, text }], activeLineIndex: -1, timingSource: 'static' });
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
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
function fixture(getLyrics: MusicBridgePublicApi['getLyrics']) {
  let likes = 0, favorites = 0;
  const session = usePlaybackSession({ api: { getLyrics, getTrackLikeStatus: async () => { likes++; return { liked: false }; },
    checkFavorite: async () => { favorites++; return { favorite: false }; } } as unknown as MusicBridgePublicApi,
    getSelectedZone: () => ({ zoneId: 'synthetic-zone', displayName: '合成Zone', selected: true }), getZoneLifecycleStatus: () => 'selected', getSelectedQuality: () => 'auto',
    getMatchResult: () => undefined, getPendingMatch: () => undefined, onMatchTracks() {}, getRoonPlaybackContext: () => undefined,
    resolveFavoriteDescriptor: favoriteDescriptorForRoonItem, onEnterNowPlaying() {}, clearActionError() {}, onActionMessage() {}, onError(error) { throw error; }, onToast() {} });
  return { session, likes: () => likes, favorites: () => favorites };
}

test('本地播放Renderer：首次UUID触发既有lyrics.get，100次进度不重读、不调用网易喜欢或Roon收藏', async t => {
  const requested: string[] = [], f = fixture(async id => { requested.push(id); return ready('真实旁置回执'); }); t.after(() => f.session.dispose());
  const initial = playing(); assert.equal(validateIpcEvent({ version: 1, event: 'playback.changed', payload: { state: initial } }).ok, true);
  f.session.applyPlaybackState(initial); await tick(); assert.deepEqual(requested, [initial.currentTrack!.id]);
  assert.equal(f.session.lyricsSnapshot.value.lines[0]?.text, '真实旁置回执'); assert.equal(f.session.lyricsSnapshot.value.source, undefined);
  for (let i = 1; i <= 100; i++) f.session.applyPlaybackState({ ...initial, positionMs: i * 100 });
  await tick(); assert.equal(requested.length, 1); assert.equal(f.likes(), 0); assert.equal(f.favorites(), 0);
});

for (const late of ['success', 'error'] as const) test(`本地Renderer同UUID新attempt/修订：旧${late}不能覆盖新歌词`, async t => {
  const a = deferred<LyricsSnapshot>(), b = deferred<LyricsSnapshot>(), requested: string[] = [];
  const f = fixture(id => { requested.push(id); return requested.length === 1 ? a.promise : b.promise; }); t.after(() => f.session.dispose());
  const first = playing(), second = playing(first.currentTrack!.id, first.local!.asset_id, '2', 'owner-attempt-2');
  f.session.applyPlaybackState(first); f.session.applyPlaybackState(second); assert.equal(requested.length, 2);
  b.resolve(ready('当前B')); await tick(); assert.equal(f.session.lyricsSnapshot.value.lines[0]?.text, '当前B');
  if (late === 'success') a.resolve(ready('旧A')); else a.reject(new Error('旧A只读失败'));
  await tick(); assert.equal(f.session.lyricsSnapshot.value.lines[0]?.text, '当前B'); assert.equal(f.session.lyricsSnapshot.value.status, 'ready');
});

test('本地Renderer：无人歌词/坏歌词真实unavailable沿用公开状态，Core当前事件覆盖loading，dispose拒晚回', async t => {
  const wait = deferred<LyricsSnapshot>(), f = fixture(() => wait.promise); t.after(() => f.session.dispose());
  const snapshot = playing(); f.session.applyPlaybackState(snapshot); assert.equal(f.session.lyricsSnapshot.value.status, 'loading');
  const unavailable: LyricsSnapshot = { status: 'unavailable', lines: [], activeLineIndex: -1, timingSource: 'static' };
  f.session.onLyricsChanged(unavailable); wait.resolve(ready('不再接纳的旧API回执')); await tick(); assert.equal(f.session.lyricsSnapshot.value, unavailable);
  const next = deferred<LyricsSnapshot>(), closed = fixture(() => next.promise); closed.session.applyPlaybackState(snapshot); closed.session.dispose(); next.resolve(ready('关闭后不得发布')); await tick();
  assert.equal(closed.session.lyricsSnapshot.value.status, 'loading'); assert.deepEqual(closed.session.lyricsSnapshot.value.lines, []);
});
