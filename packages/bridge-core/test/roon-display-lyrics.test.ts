import test from 'node:test';
import assert from 'node:assert/strict';
import type { PlaybackSnapshot, RoonDisplayLyricsEvent } from '@music-bridge/contracts';
import { RoonDisplayLyricsStore } from '../src/lyrics/roon-display-store.js';
import { LyricsCoordinator, createLyricsRequestContext } from '../src/lyrics/coordinator.js';

const track = { title: '测试歌曲', artist: '测试歌手', album: '测试专辑', durationMs: 180000 };
const event: RoonDisplayLyricsEvent = { type: 'zone', zoneId: 'zone1', track, lrc: '[00:00.00]第一行\n[00:10.00]第二行\n[00:20.00]第三行' };
const playback: PlaybackSnapshot = { state: 'playing', source: 'roon', selectedZoneId: 'zone1', positionMs: 12000,
  queue: { items: [], index: -1, hasNext: false, hasPrevious: false }, currentTrack: { id: '123', title: track.title, artists: [track.artist], album: track.album, durationMs: track.durationMs },
  canNext: false, canPrevious: false, canStop: true, canPause: true, canResume: false };
const context = createLyricsRequestContext(playback, 1)!;
assert.equal(context.kind, 'local');
const local = context as Extract<typeof context, { kind: 'local' }>;
const turn = () => new Promise(resolve => setImmediate(resolve));

test('仅已启用且设备及曲目对应的 LRC 可进入显示，保留来源与时间轴', () => {
  const store = new RoonDisplayLyricsStore();
  assert.equal(store.read(local), undefined);
  store.update({ type: 'reset', enabled: true });
  assert.equal(store.read(local)?.status, 'unavailable');
  store.update(event);
  assert.equal(store.read(local)?.source, 'roon-display');
  assert.deepEqual(store.read(local)?.lines.map(line => line.startMs), [0, 10000, 20000]);
  assert.equal(store.read({ ...local, zoneId: 'other' })?.status, 'unavailable');
});

for (const changed of [{ title: '另一首' }, { artist: '其他歌手' }, { album: '现场版' }, { durationMs: 195000 }]) {
  test('不同版本/曲目不能冒充当前歌词：' + Object.keys(changed)[0], () => {
    const store = new RoonDisplayLyricsStore();
    store.update({ type: 'reset', enabled: true });
    store.update({ ...event, track: { ...track, ...changed } });
    assert.equal(store.read(local)?.status, 'unavailable');
  });
}

test('切歌、无歌词、断连立即清空，重连不重放旧歌词', () => {
  const store = new RoonDisplayLyricsStore();
  store.update({ type: 'reset', enabled: true }); store.update(event);
  store.update({ ...event, lrc: null }); assert.equal(store.read(local)?.lines.length, 0);
  store.update(event); store.update({ type: 'reset', enabled: true });
  assert.equal(store.read(local)?.lines.length, 0);
  store.update({ type: 'reset', enabled: false }); assert.equal(store.read(local), undefined);
});

test('Browse 多位制作人员与 Display 主艺人不一致时，必须有同设备 Transport 完整佐证', () => {
  const creditsPlayback = { ...playback, currentTrack: { ...playback.currentTrack!, artists: [track.artist, '制作人员', '另一位作者'] } };
  const credits = createLyricsRequestContext(creditsPlayback, 1)!;
  assert.equal(credits.kind, 'local');
  if (credits.kind !== 'local') return;
  let transport: { zoneId: string; track: typeof track } | undefined;
  const store = new RoonDisplayLyricsStore(() => transport);
  store.update({ type: 'reset', enabled: true }); store.update(event);
  assert.equal(store.read(credits)?.status, 'unavailable');
  transport = { zoneId: 'zone1', track };
  assert.equal(store.read(credits)?.status, 'ready');
  for (const invalid of [
    { zoneId: 'zone2', track },
    { zoneId: 'zone1', track: { ...track, title: '另一首' } },
    { zoneId: 'zone1', track: { ...track, artist: '不同艺人' } },
    { zoneId: 'zone1', track: { ...track, album: '另一个版本' } },
    { zoneId: 'zone1', track: { ...track, durationMs: 199000 } },
  ]) {
    transport = invalid;
    assert.equal(store.read(credits)?.status, 'unavailable');
  }
  transport = { zoneId: 'zone1', track: { ...track, artist: '无关艺人' } };
  store.update({ ...event, track: transport.track });
  assert.equal(store.read(credits)?.status, 'unavailable');
});

test('Display 先到而 Transport 元数据迟到时，在后续播放观测中恢复歌词', async () => {
  let observed = false;
  const store = new RoonDisplayLyricsStore(() => observed ? { zoneId: 'zone1', track } : undefined);
  store.update({ type: 'reset', enabled: true }); store.update(event);
  const creditsPlayback = { ...playback, currentTrack: { ...playback.currentTrack!, artists: [track.artist, '制作人员'] } };
  const credits = createLyricsRequestContext(creditsPlayback, 1)!;
  const coordinator = new LyricsCoordinator({ localDisplay: store, load: async () => assert.fail('不应请求网易云') });
  coordinator.onPlaybackChanged(creditsPlayback, credits); await turn();
  assert.equal(coordinator.getSnapshot().status, 'unavailable');
  observed = true;
  coordinator.onPlaybackChanged({ ...creditsPlayback, positionMs: 14000 }, credits); await turn();
  assert.equal(coordinator.getSnapshot().status, 'ready');
  assert.equal(coordinator.getSnapshot().activeLineIndex, 1);
  coordinator.shutdown();
});

test('歌词启用后绝不请求网易云；播放推进、暂停、设备切换与断连保持同步', async () => {
  let now = 1000;
  const store = new RoonDisplayLyricsStore(); store.update({ type: 'reset', enabled: true }); store.update(event);
  const coordinator = new LyricsCoordinator({ localDisplay: store, load: async () => assert.fail('不应读取网易云'),
    localResolver: { resolveActive: async () => assert.fail('不应匹配网易云'), cancelActive() {} }, now: () => now });
  coordinator.onPlaybackChanged(playback, local); await turn();
  assert.equal(coordinator.getSnapshot().activeLineIndex, 1);
  assert.equal(coordinator.getSnapshot().source, 'roon-display');
  now += 9000; coordinator.updateEstimated(); assert.equal(coordinator.getSnapshot().activeLineIndex, 2);
  coordinator.onPlaybackChanged({ ...playback, state: 'paused', positionMs: 5000 }, local);
  now += 30000; coordinator.updateEstimated(); assert.equal(coordinator.getSnapshot().activeLineIndex, 0);
  const other = { ...playback, selectedZoneId: 'zone2' };
  coordinator.onPlaybackChanged(other, createLyricsRequestContext(other, 1)); await turn();
  assert.equal(coordinator.getSnapshot().lines.length, 0);
  coordinator.onPlaybackChanged(playback, local); await turn();
  store.update({ type: 'reset', enabled: true }); await coordinator.reloadActiveLocalLyrics(local);
  assert.equal(coordinator.getSnapshot().lines.length, 0);
  coordinator.shutdown();
});

test('启用 Display 会作废先前网易云缓存及迟到请求，Display 来源不会被重标', async () => {
  const store = new RoonDisplayLyricsStore();
  let resolve!: (value: any) => void;
  let localResolutionCalls = 0;
  const coordinator = new LyricsCoordinator({ localDisplay: store, onLocalResolution: () => { localResolutionCalls++; }, load: async () => assert.fail(), localResolver: {
    resolveActive: () => new Promise(done => { resolve = done; }), cancelActive() {},
  } });
  coordinator.onPlaybackChanged(playback, local);
  store.update({ type: 'reset', enabled: true }); store.update(event);
  coordinator.clearLocalCache(); await coordinator.reloadActiveLocalLyrics(local);
  resolve({ applied: true, status: 'matched', lyrics: { status: 'ready', lines: [{ startMs: 0, text: '迟到内容' }], activeLineIndex: -1, timingSource: 'static' } });
  await turn();
  assert.equal(coordinator.getSnapshot().source, 'roon-display');
  assert.equal(coordinator.getSnapshot().lines[0]?.text, '第一行');
  assert.equal(localResolutionCalls, 0);
  coordinator.shutdown();
});

test('Display 启用不改变网易云歌曲的歌词来源', async () => {
  const store = new RoonDisplayLyricsStore(); store.update({ type: 'reset', enabled: true });
  let calls = 0;
  const coordinator = new LyricsCoordinator({ localDisplay: store, load: async () => {
    calls++;
    return { status: 'ready', lines: [{ startMs: 0, text: '网易云合成歌词' }], activeLineIndex: -1, timingSource: 'static' };
  } });
  const online: PlaybackSnapshot = { ...playback, source: 'netease', queue: {
    items: [{ trackId: '123', qualityPreference: 'auto' }], index: 0, hasNext: false, hasPrevious: false,
  } };
  coordinator.onPlaybackChanged(online, createLyricsRequestContext(online, 2));
  await turn();
  assert.equal(calls, 1);
  assert.equal(coordinator.getSnapshot().source, 'netease');
  coordinator.shutdown();
});
