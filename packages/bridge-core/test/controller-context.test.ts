import assert from 'node:assert/strict';
import test from 'node:test';
import { roonTrackIdFromReference } from '@music-bridge/contracts';
import type { TrackSummary } from '@music-bridge/contracts';
import { BridgeController } from '../src/application/bridge-controller.js';
import type { NeteasePort } from '../src/netease/types.js';
import type { RoonOperationOptions, RoonPlaybackObservation, RoonPort, RoonState } from '../src/roon/types.js';
import type { RoonPlaybackContextItem, RoonPlaybackContextLease, RoonPlaybackContextPage } from '../src/roon/playback-context.js';
import { StreamRegistry } from '../src/stream/registry.js';
import { StreamGateway } from '../src/stream/gateway.js';
import { createLogger } from '../src/shared/logger.js';

function item(index: number): RoonPlaybackContextItem {
  const reference = `musicbridge-v2-entity-${(index + 1).toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
  const track = { id: roonTrackIdFromReference(reference), title: `曲目${index}`, artists: ['艺人'], album: '专辑', durationMs: 120_000 };
  return { reference, zoneId: 'zone-1', track, roonItem: { kind: 'track', reference, title: track.title, artist: '艺人', album: '专辑', durationMs: track.durationMs } };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function tick() { await new Promise<void>(resolve => setImmediate(resolve)); }
async function until(condition: () => boolean) {
  for (let i = 0; i < 100 && !condition(); i++) await tick();
  assert.ok(condition(), '受控异步行为应已到达');
}
function leaseFixture(size = 250, offset = 0, count = 2, selectedIndex = 0) {
  const values = Array.from({ length: size }, (_, i) => item(i));
  const calls: Array<{ offset: number; limit: number; signal: AbortSignal }> = [];
  let releases = 0, current = true;
  let reader: ((offset: number, limit: number) => Promise<RoonPlaybackContextPage>) | undefined;
  const page = (start: number, limit: number): RoonPlaybackContextPage => ({ items: values.slice(start, start + limit), offset: start, nextOffset: Math.min(size, start + limit), complete: start + limit >= size });
  const lease: RoonPlaybackContextLease = {
    initial: { ...page(offset, count), selectedIndex }, isCurrent: () => current && releases === 0,
    async read(request, options) {
      calls.push({ ...request, signal: options.signal });
      return reader ? reader(request.offset, request.limit) : page(request.offset, request.limit);
    }, release() { releases++; },
  };
  return { lease, calls, values, page, get releases() { return releases; }, expire() { current = false; }, readWith(fn: NonNullable<typeof reader>) { reader = fn; } };
}
function harness(now?: () => number) {
  const logger = createLogger('error'), registry = new StreamRegistry();
  const state: RoonState = { status: 'ready', selectedZoneId: 'zone-1', transportState: 'playing', canPause: true, canResume: true };
  let observation: RoonPlaybackObservation | undefined;
  const plays: string[] = []; let stops = 0, pauses = 0, seeks = 0, failStop = false;
  let confirm: Promise<void> | undefined;
  let stopGate: Promise<void> | undefined;
  const native = {
    async play(reference: string, zoneId: string, track: TrackSummary, options?: RoonOperationOptions & { onDispatch?: () => void; onDispatchCompletion?: (value: Promise<void>) => void }) {
      plays.push(reference); options?.onDispatch?.(); options?.onDispatchCompletion?.(Promise.resolve());
      await confirm;
      observation = { zoneId, revision: plays.length * 10, state: 'playing', positionMs: 0, nowPlaying: { title: track.title, artist: track.artists[0]!, album: track.album, durationMs: track.durationMs! } };
      return observation;
    },
    async stop() { stops++; await stopGate; if (failStop) throw new Error('受控Stop失败'); },
    async pause() { pauses++; }, async resume() {}, async seek() { seeks++; },
  };
  const roon = { getState: () => ({ ...state }), getSelectedZonePlaybackObservation: () => observation, setTerminalHandler() {}, stop: native.stop, seek: native.seek } as unknown as RoonPort;
  const netease = { configured: true, async getTrack(trackId: string) { return { ...item(9000).track, id: trackId }; } } as unknown as NeteasePort;
  const controller = new BridgeController({ roon, roonLibrary: native, netease, registry, logger, ...(now ? { now } : {}), gateway: new StreamGateway({ host: '127.0.0.1', port: 0, publicBaseUrl: 'http://127.0.0.1:38502', registry, logger }) });
  return { controller, native, plays, state, setStopGate(value: Promise<void>) { stopGate = value; }, setConfirmation(value: Promise<void>) { confirm = value; }, setObservation(value: RoonPlaybackObservation) { observation = value; }, get stops() { return stops; }, get pauses() { return pauses; }, get seeks() { return seeks; }, failStop(value: boolean) { failStop = value; } };
}

test('003B：initial 即播放，Native确认前零补页，确认后仅一邻近页', async () => {
  const h = harness(), f = leaseFixture(5000), confirmation = deferred<void>(), page = deferred<RoonPlaybackContextPage>();
  h.setConfirmation(confirmation.promise); f.readWith(() => page.promise);
  const playing = h.controller.replaceRoonContext(f.lease);
  await until(() => h.plays.length === 1); assert.equal(f.calls.length, 0);
  confirmation.resolve(); await playing; await until(() => f.calls.length === 1);
  assert.equal(h.controller.getPlaybackState().queue.items.length, 2);
  assert.equal(h.controller.getPlaybackState().queue.context?.loading, true);
  page.resolve(f.page(2, 100)); await tick(); await tick();
  assert.equal(f.calls.length, 1); assert.equal(h.plays.length, 1);
  assert.equal(h.controller.getPlaybackState().queue.items.length, 102);
  await h.controller.stop(); assert.equal(f.releases, 1);
});

test('003B：过期或无效initial在Stop旧播放前拒绝并release', async () => {
  const h = harness(); await h.controller.playRoon(item(7));
  const f = leaseFixture(); f.expire();
  await assert.rejects(h.controller.replaceRoonContext(f.lease));
  assert.equal(h.stops, 0); assert.equal(h.plays.length, 1); assert.equal(f.releases, 1);
  const bad = leaseFixture(); bad.lease.initial.selectedIndex = 100;
  await assert.rejects(h.controller.replaceRoonContext(bad.lease)); assert.equal(h.stops, 0); assert.equal(bad.releases, 1);
});

test('003B：第二页previous补prefix，不重启当前对象、position或generation', async () => {
  const h = harness(), f = leaseFixture(8, 4, 2), held = deferred<RoonPlaybackContextPage>();
  f.readWith((offset, limit) => offset === 6 ? held.promise : Promise.resolve(f.page(offset, limit)));
  await h.controller.replaceRoonContext(f.lease); await until(() => f.calls.length === 1);
  held.resolve(f.page(6, 100)); await tick(); await tick();
  const generation = h.controller.getPlaybackGeneration();
  await h.controller.previous();
  assert.deepEqual(h.plays, [f.values[4]!.reference, f.values[3]!.reference]);
  assert.equal(h.controller.getPlaybackState().queue.items[4]!.trackId, f.values[4]!.track.id);
  assert.equal(h.controller.getPlaybackState().queue.index, 3);
  assert.equal(h.stops, 1); assert.equal(f.releases, 0); assert.ok(h.controller.getPlaybackGeneration() > generation);
  await h.controller.stop();
});

test('003B：补页失败不终止当前，未EOF仍Next并可重试', async () => {
  const h = harness(), f = leaseFixture(3, 0, 1); let fail = true;
  f.readWith((offset, limit) => fail ? Promise.reject(new Error('受控页失败')) : Promise.resolve(f.page(offset, limit)));
  await h.controller.replaceRoonContext(f.lease); await until(() => h.controller.getPlaybackState().queue.context?.error === 'retryable');
  assert.equal(h.controller.getPlaybackState().state, 'playing'); assert.equal(h.controller.getPlaybackState().canNext, true); assert.equal(h.stops, 0);
  fail = false; await h.controller.next(); assert.equal(h.plays[1], f.values[1]!.reference); await h.controller.stop();
});

test('003B：Stop受理取消held页，迟到零append且停止未知保留deviceowner', async () => {
  const h = harness(), f = leaseFixture(), held = deferred<RoonPlaybackContextPage>(); f.readWith(() => held.promise);
  await h.controller.replaceRoonContext(f.lease); await until(() => f.calls.length === 1);
  h.failStop(true); await assert.rejects(h.controller.stop());
  assert.equal(f.calls[0]!.signal.aborted, true); assert.equal(f.releases, 1); assert.equal(h.controller.getPlaybackState().canStop, true);
  held.resolve(f.page(2, 100)); await tick(); await tick(); assert.equal(h.controller.getPlaybackState().queue.items.length, 2);
  h.failStop(false); await h.controller.stop(); assert.equal(h.controller.getPlaybackState().canStop, false);
});

test('003B：替换受理即取消旧context，旧late不覆盖新队列', async () => {
  const h = harness(), f = leaseFixture(), held = deferred<RoonPlaybackContextPage>(); f.readWith(() => held.promise);
  await h.controller.replaceRoonContext(f.lease); await until(() => f.calls.length === 1);
  await h.controller.replaceRoonQueue([item(8000)], 0); assert.equal(f.releases, 1);
  held.resolve(f.page(2, 100)); await tick(); await tick();
  assert.equal(h.controller.getPlaybackState().queue.items.length, 1); assert.equal(h.plays.at(-1), item(8000).reference);
});

test('003B：空track页按valid游标推进，不伪EOF', async () => {
  const h = harness(), f = leaseFixture(250, 0, 1);
  f.readWith(async (offset, limit) => offset === 1 ? { items: [], offset, nextOffset: 101, complete: false } : f.page(offset, limit));
  await h.controller.replaceRoonContext(f.lease); await until(() => f.calls.length === 1); await tick();
  assert.equal(h.controller.getPlaybackState().canNext, true);
  await h.controller.next(); assert.equal(f.calls[1]!.offset, 101); assert.equal(h.plays[1], f.values[101]!.reference); await h.controller.stop();
});

test('003B：编辑drain在mailbox外，pause/seek独立；成功一次保序且不重启当前', async () => {
  const h = harness(), f = leaseFixture(250, 100, 2), held = deferred<RoonPlaybackContextPage>(); let holding = true;
  f.readWith((offset, limit) => holding ? held.promise : Promise.resolve(f.page(offset, limit)));
  await h.controller.replaceRoonContext(f.lease); await until(() => f.calls.length === 1);
  const append = h.controller.appendRoon(item(8000)); const settled = append.then(() => true); let complete = false; void settled.then(() => { complete = true; });
  await h.controller.pause(); await h.controller.seek(1000); assert.equal(h.pauses, 1); assert.equal(h.seeks, 1); assert.equal(complete, false);
  holding = false; held.resolve(f.page(102, 100)); await append;
  const queue = h.controller.getPlaybackState().queue;
  assert.equal(queue.items.length, 251); assert.equal(queue.index, 100); assert.equal(queue.items[250]!.trackId, item(8000).track.id);
  assert.equal(h.plays.length, 1); assert.equal(h.stops, 0); assert.equal(queue.context?.afterComplete, true); await h.controller.stop();
});

test('003B：drain失败可见queue与cursor不动，重试不丢不重', async () => {
  const h = harness(), f = leaseFixture(350); let fail = false;
  f.readWith((offset, limit) => fail && offset >= 202 ? Promise.reject(new Error('受控中途失败')) : Promise.resolve(f.page(offset, limit)));
  await h.controller.replaceRoonContext(f.lease); await until(() => h.controller.getPlaybackState().queue.items.length === 102);
  fail = true; const before = h.controller.getPlaybackState().queue.items.map(row => row.trackId);
  await assert.rejects(h.controller.insertNextRoon(item(8000))); assert.deepEqual(h.controller.getPlaybackState().queue.items.map(row => row.trackId), before);
  assert.equal(h.controller.getPlaybackState().state, 'playing'); fail = false;
  await h.controller.insertNextRoon(item(8000)); assert.equal(h.controller.getPlaybackState().queue.items.length, 351);
  assert.equal(h.controller.getPlaybackState().queue.items[1]!.trackId, item(8000).track.id); await h.controller.stop();
});

test('003B：5000容量含编辑预留，拒绝不截断、不假完成', async () => {
  const h = harness(), f = leaseFixture(5000); await h.controller.replaceRoonContext(f.lease);
  await until(() => h.controller.getPlaybackState().queue.items.length === 102);
  await assert.rejects(h.controller.appendRoon(item(8000)), { httpStatus: 413 });
  assert.equal(h.controller.getPlaybackState().queue.items.length, 102); assert.equal(h.controller.getPlaybackState().queue.context?.error, 'capacity'); assert.equal(h.stops, 0); await h.controller.stop();
});

test('003B：可信roonItem投影clone/freeze，错trackId拒绝', async () => {
  const h = harness(), f = leaseFixture(2); await h.controller.replaceRoonContext(f.lease);
  const projected = h.controller.getPlaybackState().queue.items[0]!.roonItem;
  assert.ok(projected); assert.equal(Object.isFrozen(projected), true); f.values[0]!.roonItem.title = '外部改动';
  assert.equal(projected.title, '曲目0'); await h.controller.stop();
  const bad = leaseFixture(1); bad.values[0]!.track.id = '123'; await assert.rejects(h.controller.replaceRoonContext(bad.lease));
});

function tailObservation(value: RoonPlaybackContextItem, revision: number, state: 'playing' | 'stopped', positionMs: number): RoonPlaybackObservation {
  return { zoneId: value.zoneId, revision, state, positionMs, nowPlaying: { title: value.track.title, artist: value.track.artists[0]!, album: value.track.album, durationMs: value.track.durationMs! } };
}

test('003B：同曲新鲜尾部stopped才按对象锚自动补页推进', async () => {
  const h = harness(), f = leaseFixture(3, 0, 1), held = deferred<RoonPlaybackContextPage>(); f.readWith(() => held.promise);
  await h.controller.replaceRoonContext(f.lease); await until(() => f.calls.length === 1);
  h.setObservation(tailObservation(f.values[0]!, 11, 'playing', 119_500)); h.controller.handleRoonPlaybackState('playing');
  h.setObservation(tailObservation(f.values[0]!, 12, 'stopped', 120_000)); h.controller.handleRoonPlaybackState('stopped');
  await tick(); assert.equal(h.plays.length, 1); held.resolve(f.page(1, 100));
  await until(() => h.plays.length === 2); assert.equal(h.plays[1], f.values[1]!.reference); assert.equal(h.stops, 0); await h.controller.stop();
});

for (const mode of ['中途停止', '缺完整身份', '旧revision', '换Zone', '仅loading'] as const) {
  test(`003B：${mode}不得猜自然结束派发`, async () => {
    const h = harness(), f = leaseFixture(2); await h.controller.replaceRoonContext(f.lease);
    h.setObservation(tailObservation(f.values[0]!, 11, 'playing', mode === '中途停止' ? 50_000 : 119_500));
    h.controller.handleRoonPlaybackState(mode === '仅loading' ? 'loading' : 'playing');
    const stopped = tailObservation(f.values[0]!, mode === '旧revision' ? 10 : 12, 'stopped', 120_000);
    if (mode === '缺完整身份') stopped.nowPlaying = { title: f.values[0]!.track.title };
    if (mode === '换Zone') stopped.zoneId = 'zone-2';
    h.setObservation(stopped); h.controller.handleRoonPlaybackState('stopped'); await tick(); await tick();
    assert.equal(h.plays.length, 1); await h.controller.stop();
  });
}

test('003B：自然尾部held页后Stop取消，late零自动派发', async () => {
  const h = harness(), f = leaseFixture(3, 0, 1), held = deferred<RoonPlaybackContextPage>(); f.readWith(() => held.promise);
  await h.controller.replaceRoonContext(f.lease); await until(() => f.calls.length === 1);
  h.setObservation(tailObservation(f.values[0]!, 11, 'playing', 119_500)); h.controller.handleRoonPlaybackState('playing');
  h.setObservation(tailObservation(f.values[0]!, 12, 'stopped', 120_000)); h.controller.handleRoonPlaybackState('stopped'); await tick();
  await h.controller.stop(); held.resolve(f.page(1, 100)); await tick(); await tick();
  assert.equal(h.plays.length, 1); assert.equal(f.releases, 1); assert.equal(h.controller.getPlaybackState().canStop, false);
});

test('003B：drain期间已loaded Next不等页，最后提交定位新current且只一次编辑', async () => {
  const h = harness(), f = leaseFixture(250), held = deferred<RoonPlaybackContextPage>();
  await h.controller.replaceRoonContext(f.lease); await until(() => h.controller.getPlaybackState().queue.items.length === 102);
  f.readWith((offset, limit) => offset === 102 ? held.promise : Promise.resolve(f.page(offset, limit)));
  const edit = h.controller.insertNextRoon(item(8000)); await until(() => f.calls.length === 2);
  await h.controller.next(); assert.equal(h.plays[1], f.values[1]!.reference);
  held.resolve(f.page(102, 100)); await edit;
  const queue = h.controller.getPlaybackState().queue; assert.equal(queue.index, 1); assert.equal(queue.items[2]!.trackId, item(8000).track.id);
  assert.equal(h.plays.length, 2); await h.controller.stop();
});

test('003B：同turn context播放后Stop，待受理lease恰好release且零play', async () => {
  const h = harness(), f = leaseFixture(); const play = h.controller.replaceRoonContext(f.lease);
  const rejected = assert.rejects(play); await h.controller.stop(); await rejected;
  assert.equal(f.releases, 1); assert.equal(h.plays.length, 0); assert.equal(h.controller.getPlaybackState().canStop, false);
});

test('003B：错误offset/无进度页拒绝不commit，expired补页可观测', async () => {
  for (const mode of ['offset', 'progress', 'expired'] as const) {
    const h = harness(), f = leaseFixture(3, 0, 1);
    f.readWith(async (offset, limit) => {
      if (mode === 'expired') f.expire();
      return mode === 'progress' ? { items: [], offset, nextOffset: offset, complete: false }
        : { ...f.page(offset, limit), ...(mode === 'offset' ? { offset: offset + 1 } : {}) };
    });
    await h.controller.replaceRoonContext(f.lease);
    await until(() => h.controller.getPlaybackState().queue.context?.error === (mode === 'expired' ? 'expired' : 'retryable'));
    assert.equal(h.controller.getPlaybackState().queue.items.length, 1); assert.equal(h.plays.length, 1); await h.controller.stop();
  }
});

test('003B：连续insert drain保序，prefix不改当前generation/对象所有权', async () => {
  const h = harness(), f = leaseFixture(250, 100, 2); await h.controller.replaceRoonContext(f.lease);
  await until(() => h.controller.getPlaybackState().queue.items.length === 102);
  const generation = h.controller.getPlaybackGeneration();
  await Promise.all([h.controller.insertNextRoon(item(8000)), h.controller.insertNextRoon(item(8001))]);
  const queue = h.controller.getPlaybackState().queue;
  assert.equal(queue.index, 100); assert.equal(queue.items[101]!.trackId, item(8000).track.id); assert.equal(queue.items[102]!.trackId, item(8001).track.id);
  assert.equal(h.controller.getPlaybackGeneration(), generation); assert.equal(h.plays.length, 1);
  await h.controller.pause(); assert.equal(h.pauses, 1); await h.controller.stop();
});

test('003B：边缘Next等待既有prefetch，已补目标后不额外读页', async () => {
  const h = harness(), f = leaseFixture(250, 0, 1), held = deferred<RoonPlaybackContextPage>();
  f.readWith((offset, limit) => offset === 1 ? held.promise : Promise.reject(new Error('不应额外预读')));
  await h.controller.replaceRoonContext(f.lease); await until(() => f.calls.length === 1);
  const next = h.controller.next(); held.resolve(f.page(1, 100)); await next;
  assert.equal(f.calls.length, 1); assert.equal(h.plays[1], f.values[1]!.reference); await h.controller.stop();
});

test('003B：同曲已观测停止但缺时长只发布idle，不推断ended，手动Next保留', async () => {
  const h = harness(), f = leaseFixture(2); await h.controller.replaceRoonContext(f.lease);
  h.setObservation(tailObservation(f.values[0]!, 11, 'playing', 119_500)); h.controller.handleRoonPlaybackState('playing');
  h.setObservation({ zoneId: 'zone-1', revision: 12, state: 'stopped', nowPlaying: { title: f.values[0]!.track.title, artist: '艺人', album: '专辑' } });
  h.controller.handleRoonPlaybackState('stopped'); await tick(); await tick();
  assert.equal(h.plays.length, 1); assert.equal(h.controller.getPlaybackState().state, 'idle');
  await h.controller.next(); assert.equal(h.plays[1], f.values[1]!.reference); await h.controller.stop();
});

test('003B：外部原生切到队列外立即撤销旧context，队列内唯一匹配保留', async () => {
  for (const outside of [false, true]) {
    const h = harness(), f = leaseFixture(250), held = deferred<RoonPlaybackContextPage>(); f.readWith(() => held.promise);
    await h.controller.replaceRoonContext(f.lease); await until(() => f.calls.length === 1);
    h.setObservation(tailObservation(outside ? item(8000) : f.values[1]!, 11, 'playing', 0)); h.controller.syncRoonTransportState();
    assert.equal(f.releases, outside ? 1 : 0);
    assert.equal(h.controller.getPlaybackState().queue.context === undefined, outside);
    held.resolve(f.page(2, 100)); await tick(); await tick();
    assert.equal(h.controller.getPlaybackState().queue.items.length, outside ? 2 : 102);
    await h.controller.stop();
  }
});

test('003B：同turn replace context 后编辑不得绕过drain或丢内容', async () => {
  const h = harness(), f = leaseFixture(250);
  const playing = h.controller.replaceRoonContext(f.lease), edit = h.controller.appendRoon(item(8000));
  await Promise.all([playing, edit]);
  const queue = h.controller.getPlaybackState().queue;
  assert.equal(queue.items.length, 251); assert.equal(queue.items.at(-1)!.trackId, item(8000).track.id); await h.controller.stop();
});

test('003B：点击队列项等待Stop时Previous补prefix，仍播放原选中对象', async () => {
  const h = harness(), f = leaseFixture(250, 100, 2); await h.controller.replaceRoonContext(f.lease);
  await until(() => h.controller.getPlaybackState().queue.items.length === 102);
  const stop = deferred<void>(); h.setStopGate(stop.promise);
  const selected = h.controller.playQueueIndex(1); await until(() => h.stops === 1);
  const previous = h.controller.previous(); const cancelledPrevious = assert.rejects(previous);
  await until(() => h.controller.getPlaybackState().queue.items[0]?.trackId === f.values[0]!.track.id);
  stop.resolve(); await selected; await cancelledPrevious;
  assert.equal(h.plays.at(-1), f.values[101]!.reference); assert.equal(h.controller.getPlaybackState().queue.index, 101); await h.controller.stop();
});

test('003B：陈旧尾部位置不得推断自然结束', async () => {
  let clock = 1_000; const h = harness(() => clock), f = leaseFixture(2); await h.controller.replaceRoonContext(f.lease);
  h.setObservation(tailObservation(f.values[0]!, 11, 'playing', 119_500)); h.controller.handleRoonPlaybackState('playing'); clock = 3_001;
  h.setObservation(tailObservation(f.values[0]!, 12, 'stopped', 120_000)); h.controller.handleRoonPlaybackState('stopped'); await tick(); await tick();
  assert.equal(h.plays.length, 1); assert.equal(h.controller.getPlaybackState().state, 'idle'); await h.controller.stop();
});

test('003B：clear/shutdown取消held读和编辑，资源各release一次', async () => {
  for (const shutdown of [false, true]) {
    const h = harness(), f = leaseFixture(), held = deferred<RoonPlaybackContextPage>(); f.readWith(() => held.promise);
    await h.controller.replaceRoonContext(f.lease); await until(() => f.calls.length === 1);
    const edit = h.controller.appendRoon(item(8000)); const rejected = assert.rejects(edit);
    if (shutdown) await h.controller.shutdown(); else await h.controller.clearQueue();
    await rejected; held.resolve(f.page(2, 100)); await tick(); await tick();
    assert.equal(f.releases, 1); assert.equal(f.calls[0]!.signal.aborted, true); assert.equal(h.controller.getPlaybackState().queue.items.length, 0);
  }
});

test('003B：已点击对象Stop held期间新replace受理，旧目标不得派发', async () => {
  const h = harness(), f = leaseFixture(2); await h.controller.replaceRoonContext(f.lease);
  const stop = deferred<void>(); h.setStopGate(stop.promise);
  const clicked = h.controller.playQueueIndex(1); const rejected = assert.rejects(clicked); await until(() => h.stops === 1);
  const replace = h.controller.replaceRoonQueue([item(8000)], 0); stop.resolve(); await rejected; await replace;
  assert.deepEqual(h.plays, [f.values[0]!.reference, item(8000).reference]); assert.equal(f.releases, 1); await h.controller.stop();
});

test('003B：context点击受理后确认链held且prefix先提交，仍使用受理时对象', async () => {
  const h = harness(), f = leaseFixture(250, 100, 2, 1); await h.controller.replaceRoonContext(f.lease);
  await until(() => h.controller.getPlaybackState().queue.items.length === 102);
  const confirmation = deferred<void>(); h.setConfirmation(confirmation.promise);
  const preceding = h.controller.playQueueIndex(0); const cancelledPreceding = assert.rejects(preceding); await until(() => h.plays.length === 2);
  const clicked = h.controller.playQueueIndex(1);
  const previous = h.controller.previous(); const cancelledPrevious = assert.rejects(previous);
  await until(() => h.controller.getPlaybackState().queue.items[0]?.trackId === f.values[0]!.track.id);
  confirmation.resolve(); await cancelledPreceding; await clicked; await cancelledPrevious;
  assert.equal(h.plays.at(-1), f.values[101]!.reference); assert.equal(h.controller.getPlaybackState().queue.index, 101);
  await h.controller.stop();
});

test('003B：legacy及待安装context保留同turn替换后选新窗口的执行语义', async () => {
  const legacy = harness();
  const replacing = legacy.controller.replaceRoonQueue([item(10), item(11)], 0);
  const selecting = legacy.controller.playQueueIndex(1);
  await Promise.all([replacing, selecting]); assert.equal(legacy.plays.at(-1), item(11).reference); await legacy.controller.stop();
  const pending = harness(), f = leaseFixture(2);
  const opening = pending.controller.replaceRoonContext(f.lease), clicked = pending.controller.playQueueIndex(1);
  await Promise.all([opening, clicked]); assert.equal(pending.plays.at(-1), f.values[1]!.reference); await pending.controller.stop();
});
