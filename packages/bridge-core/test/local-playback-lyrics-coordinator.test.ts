import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { LyricsSnapshot, PlaybackSnapshot, TrackSummary } from '@music-bridge/contracts';
import { LocalLyricsManualMatchController } from '../src/lyrics-matching/manual-controller.js';
import { createLyricsMatchRepository } from '../src/lyrics-matching/repository.js';
import { LyricsMatchResolver } from '../src/lyrics-matching/resolver.js';
import { validateIpcEvent } from '@music-bridge/contracts';
import { LyricsCoordinator, createLyricsRequestContext, type LocalFileLyricsContext } from '../src/lyrics/coordinator.js';
import { parseLocalPlaybackLrc } from '../src/library/local-playback-lyrics.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
const ready = (text: string): LyricsSnapshot => parseLocalPlaybackLrc(Buffer.from(`[00:01.00]${text}\n[00:02.00]下一行`));
function playing(trackId: string = randomUUID(), assetId: string = randomUUID(), revision = '1', attempt = 'owner-attempt-1'): PlaybackSnapshot {
  const track = { id: trackId, title: '合成曲目', artists: ['合成作者'], album: '合成专辑', durationMs: 271_000 };
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

const unavailable = (): LyricsSnapshot => ({ status: 'unavailable', lines: [], activeLineIndex: -1, timingSource: 'static' });
function filePipeline(t: TestContext, options: {
  read?: (value: LocalFileLyricsContext) => Promise<LyricsSnapshot>; tracks?: TrackSummary[];
  download?: (id: string) => Promise<LyricsSnapshot>; configured?: boolean; displayEnabled?: boolean;
} = {}) {
  const snapshot = playing(), downloads: string[] = []; let searches = 0, reads = 0, direct = 0;
  let current: LocalFileLyricsContext | undefined, allowed = true;
  const repository = createLyricsMatchRepository();
  const resolver = new LyricsMatchResolver({ repository, provider: {
    configured: options.configured ?? true,
    async searchTracks(query, page) {
      searches++; assert.ok(query.includes('合成曲目')); assert.equal(page.limit, 20);
      const items = options.tracks ?? [{ ...snapshot.currentTrack!, id: '101' }];
      return { items, offset: 0, limit: 20, total: items.length, hasMore: false };
    },
    async getLyrics(id) { assert.match(id, /^\d+$/u); downloads.push(id); return options.download ? options.download(id) : ready('云端已确认正文'); },
  } });
  let coordinator!: LyricsCoordinator;
  const manual = new LocalLyricsManualMatchController({ repository, reload: async value => {
    resolver.invalidate(value.signature.key); await coordinator.reloadActiveLocalLyrics(value);
  } });
  coordinator = new LyricsCoordinator({ load: async () => { direct++; throw new Error('本地UUID不能作为Provider ID'); }, localResolver: resolver,
    localDisplay: { enabled: options.displayEnabled ?? false, read: () => { throw new Error('本地文件不能读取Roon Display'); } },
    localFile: { isCurrent: value => allowed && value.cacheKey === current?.cacheKey && value.playbackGeneration === current.playbackGeneration,
      read: async value => { reads++; return options.read ? options.read(value) : unavailable(); } },
    onLocalMatchContext: value => manual.observeContext(value),
    onLocalResolution: (value, resolution) => manual.observeResolution(value, resolution),
  });
  t.after(() => coordinator.shutdown());
  return { snapshot, coordinator, manual, downloads, searches: () => searches, reads: () => reads, direct: () => direct,
    revokeSource: () => { allowed = false; },
    observe(value = snapshot, generation = 1) { current = context(value, generation); coordinator.onPlaybackChanged(value, current); return current; },
  };
}

test('本地FLAC缺词：按真实元数据复用已有严格匹配，保留云来源且不把UUID交给Provider', async t => {
  const f = filePipeline(t, { displayEnabled: true }); f.observe(); await tick();
  assert.equal(f.coordinator.getSnapshot().status, 'ready'); assert.equal(f.coordinator.getSnapshot().source, 'netease');
  assert.deepEqual(f.downloads, ['101']); assert.equal(f.searches(), 1); assert.equal(f.reads(), 1); assert.equal(f.direct(), 0);
  assert.equal(f.manual.getSnapshot().status, 'matched');
  for (let i = 0; i < 40; i++) f.observe({ ...f.snapshot, positionMs: i * 100 });
  await tick(); assert.equal(f.reads(), 1); assert.equal(f.searches(), 1); assert.equal(f.coordinator.cacheSize, 0);
});

test('本地FLAC有实际LRC/嵌词：优先本地，不查云端、不显示无意义的匹配控件', async t => {
  const f = filePipeline(t, { read: async () => ready('本地正文') }); f.observe(); await tick();
  assert.equal(f.coordinator.getSnapshot().lines[0]?.text, '本地正文'); assert.equal(f.coordinator.getSnapshot().source, undefined);
  assert.equal(f.searches(), 0); assert.equal(f.manual.getSnapshot().status, 'hidden');
});

test('本地FLAC歧义：不自动选版本，原手动候选确认/撤销可用于当前asset attempt', async t => {
  const base = playing().currentTrack!;
  const f = filePipeline(t, { tracks: [{ ...base, id: '401', durationMs: 268_000, album: '甲' }, { ...base, id: '402', durationMs: 274_000, album: '乙' }] });
  f.observe(); await tick(); assert.equal(f.coordinator.getSnapshot().status, 'unavailable'); assert.deepEqual(f.downloads, []);
  const choices = f.manual.getSnapshot(); assert.equal(choices.status, 'needs-choice');
  await f.manual.select(choices.matchSessionId!, choices.candidates[0]!.candidateId);
  assert.equal(f.coordinator.getSnapshot().source, 'netease'); assert.equal(f.manual.getSnapshot().canRevoke, true);
  await f.manual.revoke(); assert.equal(f.coordinator.getSnapshot().status, 'unavailable'); assert.equal(f.manual.getSnapshot().status, 'needs-choice');
});

test('本地FLAC不同版本：Live候选不能自动显示，未配置时不搜索且给出已有明确状态', async t => {
  const f = filePipeline(t, { tracks: [{ ...playing().currentTrack!, id: '501', title: '合成曲目 (Live)' }] });
  f.observe(); await tick(); assert.equal(f.coordinator.getSnapshot().status, 'unavailable'); assert.deepEqual(f.downloads, []);
  assert.equal(f.manual.getSnapshot().status, 'no-match');
  const offline = filePipeline(t, { configured: false }); offline.observe(); await tick();
  assert.equal(offline.searches(), 0); assert.equal(offline.manual.getSnapshot().status, 'provider-unavailable');
});

test('本地FLAC晚回：失效的原FD读取不能开始云端匹配，新attempt不接纳旧云端正文', async t => {
  const waiting = deferred<LyricsSnapshot>(); let count = 0;
  const f = filePipeline(t, { read: () => ++count === 1 ? waiting.promise : Promise.resolve(ready('当前本地B')) });
  f.observe(); const b = playing(f.snapshot.currentTrack!.id, f.snapshot.local!.asset_id, '2', 'owner-attempt-2'); f.observe(b, 2);
  await tick(); waiting.resolve(unavailable()); await tick();
  assert.equal(f.searches(), 0); assert.equal(f.coordinator.getSnapshot().lines[0]?.text, '当前本地B');
  const late = deferred<LyricsSnapshot>(), cloud = filePipeline(t, { download: () => late.promise });
  cloud.observe(); await tick(); assert.equal(cloud.downloads.length, 1);
  cloud.revokeSource(); late.resolve(ready('过期云端正文')); await tick();
  assert.equal(cloud.coordinator.getSnapshot().status, 'unavailable'); assert.equal(cloud.manual.getSnapshot().status, 'hidden');
});

test('本地FLAC新attempt：旧云端正文/旧手动会话不能跨修订覆盖当前曲目', async t => {
  const late = deferred<LyricsSnapshot>(); let reads = 0;
  const f = filePipeline(t, { read: async () => ++reads === 1 ? unavailable() : ready('新attempt本地正文'), download: () => late.promise });
  f.observe(); await tick(); assert.equal(f.downloads.length, 1);
  const next = playing(f.snapshot.currentTrack!.id, f.snapshot.local!.asset_id, '2', 'owner-attempt-2');
  f.observe(next, 2); await tick(); late.resolve(ready('旧attempt云端正文')); await tick();
  assert.equal(f.coordinator.getSnapshot().lines[0]?.text, '新attempt本地正文'); assert.equal(f.manual.getSnapshot().status, 'hidden');
  const base = playing().currentTrack!, choice = filePipeline(t, { tracks: [{ ...base, id: '401', durationMs: 268_000, album: '甲' }, { ...base, id: '402', durationMs: 274_000, album: '乙' }] });
  choice.observe(); await tick(); const old = choice.manual.getSnapshot();
  choice.observe(playing(choice.snapshot.currentTrack!.id, choice.snapshot.local!.asset_id, '2', 'owner-attempt-2'), 1); await tick();
  assert.notEqual(choice.manual.getSnapshot().matchSessionId, old.matchSessionId);
  await assert.rejects(choice.manual.select(old.matchSessionId!, old.candidates[0]!.candidateId)); assert.deepEqual(choice.downloads, []);
});

test('本地FLAC在途匹配不被Roon Display重置抢占，元数据不足时只读本地', async t => {
  const late = deferred<LyricsSnapshot>(), f = filePipeline(t, { displayEnabled: true, download: () => late.promise });
  f.observe(); await tick(); assert.equal(f.downloads.length, 1); f.coordinator.clearLocalCache();
  late.resolve(ready('仍是当前FLAC')); await tick(); assert.equal(f.coordinator.getSnapshot().source, 'netease');
  const incomplete = filePipeline(t); const noArtist = structuredClone(incomplete.snapshot);
  noArtist.currentTrack!.artists = []; noArtist.queue.items[0]!.track!.artists = [];
  incomplete.observe(noArtist); await tick(); assert.equal(incomplete.coordinator.getSnapshot().status, 'unavailable'); assert.equal(incomplete.searches(), 0);
});

test('本地FLAC读取资格与输出合同无效：不借云回退掩盖来源伪造或未闭合读取', async t => {
  const forged = filePipeline(t, { read: async () => ({ ...ready('伪造来源'), source: 'netease' }) });
  forged.observe(); await tick(); assert.equal(forged.coordinator.getSnapshot().status, 'unavailable'); assert.equal(forged.searches(), 0);
  const broken = filePipeline(t, { read: async () => { throw new Error('只读lease释放未确认'); } });
  broken.observe(); await tick(); assert.equal(broken.coordinator.getSnapshot().status, 'error'); assert.equal(broken.searches(), 0);
});
