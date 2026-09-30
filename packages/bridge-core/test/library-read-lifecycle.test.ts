import assert from 'node:assert/strict';
import test from 'node:test';
import { LibraryReadRegistry } from '../src/shared/library-read-registry.js';
import { assertLibraryReadCurrent, withLibraryRead, currentLibraryRead } from '../src/shared/library-read-lifetime.js';
import type { IpcRequest } from '@music-bridge/contracts';
import { createRoonLibraryService } from '../src/roon/library.js';
const turn = () => new Promise(resolve => setImmediate(resolve));
const request = (id: string, deadlineAtMs = Date.now() + 1000): IpcRequest => ({ version: 1, id, command: 'library.search', payload: { query: 'same', page: { offset: 0, limit: 24 } }, readContext: { deadlineAtMs } });
const code = (error: unknown, expected: string) => (error as { code?: string }).code === expected;

test('MBP-002：最后订阅者取消后不读取下一页，新同键读取不受旧 finally 影响', async () => {
  const registry = new LibraryReadRegistry(() => 'scope'); let release!: () => void; let pages = 0;
  const first = registry.read(request('A'), async () => { await new Promise<void>(resolve => { release = resolve; }); assertLibraryReadCurrent(); pages++; return 'old'; });
  const rejected = assert.rejects(first, error => code(error, 'READ_CANCELLED')); await turn(); registry.cancel('A'); await rejected;
  let finish!: () => void; let newCalls = 0;
  const next = () => { newCalls++; return new Promise(resolve => { finish = () => resolve('new'); }); };
  const second = registry.read(request('B'), next); await turn(); release(); await turn();
  const third = registry.read(request('C'), next); await turn(); assert.equal(newCalls, 1); assert.equal(pages, 0);
  finish(); assert.deepEqual(await Promise.all([second, third]), ['new', 'new']);
});
test('MBP-002：排队阶段取消不派发，迟到工作仍占未返回预算', async () => {
  const registry = new LibraryReadRegistry(() => 'scope', Date.now, 1); let calls = 0;
  const first = registry.read(request('queued'), async () => { calls++; return 'wrong'; }); registry.cancel('queued'); await assert.rejects(first, error => code(error, 'READ_CANCELLED')); await turn(); assert.equal(calls, 0);
  let finish!: () => void; const pending = registry.read(request('pending'), () => new Promise(resolve => { finish = () => resolve('late'); }));
  const cancelled = assert.rejects(pending, error => code(error, 'READ_CANCELLED')); await turn(); registry.cancel('pending'); await cancelled;
  await assert.rejects(registry.read(request('blocked'), async () => 'wrong'), /预算已满/u); finish(); await turn(); assert.equal(await registry.read(request('later'), async () => 'ok'), 'ok');
});
test('MBP-002：独立订阅期限只缩短，晚加入不能延长共享 flight 总预算', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 }); const registry = new LibraryReadRegistry(() => 'scope'); let finish!: () => void;
  const a = registry.read(request('A', 1020), () => new Promise(resolve => { finish = () => resolve('ready'); })); const aFailure = assert.rejects(a, error => code(error, 'READ_DEADLINE'));
  const b = registry.read(request('B', 1080), async () => 'wrong'); await turn(); t.mock.timers.tick(21); await aFailure; finish(); assert.equal(await b, 'ready');
  const forever = registry.read(request('F', 999999), async () => { await new Promise(() => {}); }); const timeout = assert.rejects(forever, error => code(error, 'READ_DEADLINE')); await turn(); t.mock.timers.tick(9000);
  const late = registry.read(request('L', 999999), async () => 'wrong'); const lateTimeout = assert.rejects(late, error => code(error, 'READ_DEADLINE')); t.mock.timers.tick(1001); await Promise.all([timeout, lateTimeout]);
});
test('MBP-002：账户/服务作用域换代不复用旧结果，旧成功不能作为当前回执', async () => {
  let scope = 'A'; const registry = new LibraryReadRegistry(() => scope); let finish!: () => void;
  const old = registry.read(request('old'), () => new Promise(resolve => { finish = () => resolve('old'); })); const rejected = assert.rejects(old, error => code(error, 'READ_CANCELLED')); await turn(); scope = 'B';
  assert.equal(await registry.read(request('new'), async () => 'new'), 'new'); finish(); await rejected;
});
test('MBP-002：Roon 本地取消废弃 key，迟到成功不继续 load，新读取使用新 key', async () => {
  const calls: Array<{ key: string; callback: (error: string | false, body: unknown) => void }> = []; let loads = 0;
  const service = createRoonLibraryService({ browse: { browse(options, callback) { calls.push({ key: String(options.multi_session_key), callback }); }, load(_options, callback) { loads++; callback(false, { offset: 0, items: [] }); } }, image: { get_image() {} } });
  const controller = new AbortController(); const old = withLibraryRead({ signal: controller.signal, deadlineAtMs: Date.now() + 1000, now: Date.now, isCurrent: () => true }, () => service.browseAlbums({ offset: 0, limit: 24 }));
  const rejected = assert.rejects(old, error => code(error, 'READ_CANCELLED')); await turn(); controller.abort(); await rejected;
  const next = service.browseAlbums({ offset: 0, limit: 24 }); await turn(); assert.equal(calls.length, 2); assert.notEqual(calls[0]!.key, calls[1]!.key);
  calls[0]!.callback(false, { action: 'list', list: { level: 0, count: 100 } }); await turn(); assert.equal(loads, 0); calls[1]!.callback(false, { action: 'list', list: { level: 0, count: 0 } }); assert.equal((await next).items.length, 0);
});
test('MBP-002：共享工作期限不采用首个短订阅者', async () => {
  const registry = new LibraryReadRegistry(() => 'scope'); let deadline = 0;
  assert.equal(await registry.read(request('short', Date.now() + 200), async () => { deadline = currentLibraryRead()!.deadlineAtMs; return 'ok'; }), 'ok'); assert.ok(deadline - Date.now() > 9000);
});

test('MBP-002：Roon 超时后的原会话不复用，未返回 Browse 调用数量有界', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const keys: string[] = [];
  const service = createRoonLibraryService({ browse: { browse(options) { keys.push(String(options.multi_session_key)); }, load() { assert.fail('未收到 Browse 成功不能 load'); } }, image: { get_image() {} }, requestTimeoutMs: 10 });
  for (let i = 0; i < 32; i++) {
    const pending = service.browseAlbums({ offset: 0, limit: 24 }); const timeout = assert.rejects(pending, /timed out/u); await turn(); t.mock.timers.tick(11); await timeout;
  }
  assert.equal(new Set(keys).size, 32); await assert.rejects(service.browseAlbums({ offset: 0, limit: 24 }), /预算已满/u); assert.equal(keys.length, 32);
});

test('MBP-002：期限已到时迟到成功不能绕过尚未执行的定时器', async () => {
  let now = 1000; const registry = new LibraryReadRegistry(() => 'scope', () => now); let finish!: () => void;
  const pending = registry.read(request('late', 1020), () => new Promise(resolve => { finish = () => resolve('late'); }));
  const rejected = assert.rejects(pending, error => code(error, 'READ_DEADLINE')); await turn(); now = 1021; finish(); await rejected;
});
test('MBP-002：搜索会话到预算后淘汰已完成旧查询，新查询仍可正常读取', async () => {
  const keys = new Set<string>(); const service = createRoonLibraryService({ browse: {
    browse(options, callback) { keys.add(String(options.multi_session_key)); callback(false, { action: 'list', list: { level: options.pop_all ? 0 : 1, count: options.pop_all ? 1 : 0 } }); },
    load(options, callback) { callback(false, { offset: options.offset, items: options.level === 0 ? [{ title: 'Tracks', item_key: 'tracks', hint: 'list' }] : [] }); },
  }, image: { get_image() {} } });
  for (let i = 0; i < 65; i++) assert.equal((await service.searchLibrary(`查询${i}`, { offset: 0, limit: 24 }, 'track')).items.length, 0);
  assert.equal(keys.size, 65); assert.equal((await service.searchLibrary('查询0', { offset: 0, limit: 24 }, 'track')).items.length, 0); assert.equal(keys.size, 66);
});
test('MBP-002：真实 runtime 不复用已取消每日推荐，旧失败不污染新读取或负缓存', async t => {
  const { NeteaseClient } = await import('../src/netease/client.js'); const { createBridgeRuntime } = await import('../src/runtime.js');
  const { createLocalFavoriteRepository } = await import('../src/favorites/repository.js');
  type Snapshot = Awaited<ReturnType<InstanceType<typeof NeteaseClient>['getDailyRecommendations']>>;
  const calls: Array<{ resolve(value: Snapshot): void; reject(error: unknown): void }> = [];
  t.mock.method(NeteaseClient.prototype, 'getDailyRecommendations', () => new Promise<Snapshot>((resolve, reject) => { calls.push({ resolve, reject }); }));
  const runtime = createBridgeRuntime({ env: { NETEASE_COOKIE: 'synthetic-lifetime-only' }, favoriteRepository: createLocalFavoriteRepository(), roonSdk: { createApi: () => assert.fail('禁止连接真实 Roon') } as never });
  const controller = new AbortController(); const read = { signal: controller.signal, deadlineAtMs: Date.now() + 1000, now: Date.now, isCurrent: () => true };
  try {
    const old = withLibraryRead(read, () => runtime.getDailyRecommendations()); const rejected = assert.rejects(old, error => code(error, 'READ_CANCELLED')); await turn(); controller.abort();
    const newController = new AbortController(); const fresh = withLibraryRead({ ...read, signal: newController.signal }, () => runtime.getDailyRecommendations()); await turn(); assert.equal(calls.length, 2);
    calls[0]!.reject(new Error('旧读取错误')); await rejected; const shared = runtime.getDailyRecommendations(); assert.equal(calls.length, 2);
    calls[1]!.resolve({ dayKey: '2026-10-01', tracks: [] }); await Promise.all([fresh, shared]); await runtime.getDailyRecommendations(); assert.equal(calls.length, 2);
  } finally { await runtime.shutdown(); }
});

test('MBP-002：网易云不可撤销读取占预算到实际返回，并为播放元数据保留容量', async () => {
  const { NeteaseClient } = await import('../src/netease/client.js');
  const replies: Array<(value: unknown) => void> = []; let details = 0;
  const api = { search: () => new Promise(resolve => { replies.push(resolve); }), song_detail: async () => { details++; return { body: { code: 200, songs: [{ id: 999, name: '播放元数据', ar: [{ name: '艺人' }], al: { name: '专辑' }, dt: 60000 }] } }; } } as unknown as NonNullable<ConstructorParameters<typeof NeteaseClient>[1]>;
  const client = new NeteaseClient('synthetic-budget', api); const controller = new AbortController();
  const lifetime = { signal: controller.signal, deadlineAtMs: Date.now() + 1000, now: Date.now, isCurrent: () => true };
  const reads = Array.from({ length: 32 }, () => withLibraryRead(lifetime, () => client.searchTracks('synthetic', { offset: 0, limit: 24 })));
  const ended = Promise.allSettled(reads); await turn(); assert.equal(replies.length, 32);
  await assert.rejects(withLibraryRead(lifetime, () => client.searchTracks('overflow', { offset: 0, limit: 24 })), /预算已满/u);
  assert.equal((await client.getTrack('999')).title, '播放元数据'); assert.equal(details, 1);
  controller.abort(); for (const result of await ended) { assert.equal(result.status, 'rejected'); if (result.status === 'rejected') assert.equal(result.reason.code, 'READ_CANCELLED'); }
  const freshController = new AbortController(); const nextLifetime = { ...lifetime, signal: freshController.signal };
  await assert.rejects(withLibraryRead(nextLifetime, () => client.searchTracks('still-full', { offset: 0, limit: 24 })), /预算已满/u);
  const response = { body: { code: 200, result: { songs: [], songCount: 0 } } }; for (const finish of replies) finish(response); await turn();
  const fresh = withLibraryRead(nextLifetime, () => client.searchTracks('fresh', { offset: 0, limit: 24 })); await turn(); assert.equal(replies.length, 33); replies[32]!(response); assert.equal((await fresh).items.length, 0); assert.equal(details, 1);
});

for (const changed of [false, true]) {
  test(`MBP-002：废弃会话后详情按稳定路径复核${changed ? '并拒绝身份变化' : '并使用新 item_key'}`, async () => {
    let version = 1; let hold = true; let title = '稳定专辑'; let finishOld!: (error: string | false, body: unknown) => void;
    const dispatched: string[] = [];
    const service = createRoonLibraryService({ browse: {
      browse(options, callback) { if (options.item_key) dispatched.push(String(options.item_key)); callback(false, { action: 'list', list: { level: options.pop_all ? 0 : 1, count: options.pop_all ? 1 : 2 } }); },
      load(options, callback) {
        if (options.level === 0) { callback(false, { offset: options.offset, items: [{ title, item_key: `album:v${version}`, hint: 'list' }] }); return; }
        if (hold) { finishOld = callback; return; }
        callback(false, { offset: options.offset, items: [0, 1].map(i => ({ title: `曲目${i}`, subtitle: '艺人', item_key: `track:v${version}:${i}`, hint: 'action_list' })) });
      },
    }, image: { get_image() {} } });
    const page = { offset: 0, limit: 24 }; const album = (await service.browseAlbums(page)).items[0]!;
    const controller = new AbortController(); const old = withLibraryRead({ signal: controller.signal, deadlineAtMs: Date.now() + 1000, now: Date.now, isCurrent: () => true }, () => service.browseAlbum(album, page));
    const rejected = assert.rejects(old, error => code(error, 'READ_CANCELLED')); await turn(); controller.abort(); await rejected;
    version = 2; hold = false; if (changed) title = '原位置另一个专辑';
    finishOld(false, { offset: 0, items: [{ title: '旧曲目', item_key: 'old', hint: 'action_list' }] });
    if (changed) { await assert.rejects(service.browseAlbum(album, page), /identity changed/u); assert.deepEqual(dispatched, ['album:v1']); }
    else { assert.equal((await service.browseAlbum(album, page)).items.length, 2); assert.deepEqual(dispatched, ['album:v1', 'album:v2']); }
  });
}
