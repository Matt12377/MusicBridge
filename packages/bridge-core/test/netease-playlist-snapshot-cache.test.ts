import assert from 'node:assert/strict';
import test from 'node:test';
import { NeteaseClient } from '../src/netease/client.js';
import { withLibraryRead, type LibraryReadLifetime } from '../src/shared/library-read-lifetime.js';

const page = { offset: 0, limit: 20 };
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T = unknown>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function song(id: string) { return { id: Number(id), name: `歌曲${id}`, ar: [{ name: '艺人' }], al: { name: '专辑' }, dt: 60000 }; }
function detail(ids: readonly string[], name = '歌单', extras: Record<string, unknown> = {}) { return { body: { code: 200, playlist: { id: 301, name, description: '说明', trackCount: ids.length, trackIds: ids.map(id => ({ id })), ...extras } } }; }
function fixture(options: ConstructorParameters<typeof NeteaseClient>[3] = {}) {
  const calls = { headers: 0, songs: [] as string[][], accounts: 0, fallback: [] as Record<string, unknown>[] };
  let ids = Array.from({ length: 50 }, (_, index) => String(1000 + index));
  let header: (params: Record<string, unknown>) => Promise<unknown> = async () => detail(ids);
  let account: () => Promise<unknown> = async () => ({ body: { code: 200, account: { id: 42 } } });
  let tracks: (selected: string[]) => Promise<unknown> = async selected => ({ body: { code: 200, songs: [...selected].reverse().map(song) } });
  const api = {
    playlist_detail: async (params: Record<string, unknown>) => { calls.headers++; return header(params); },
    song_detail: async (params: Record<string, unknown>) => { const selected = String(params.ids).split(','); calls.songs.push(selected); return tracks(selected); },
    playlist_track_all: async (params: Record<string, unknown>) => { calls.fallback.push(params); return { body: { code: 200, songs: [song('7')] } }; },
    user_account: async () => { calls.accounts++; return account(); },
    user_playlist: async () => ({ body: { code: 200, playlist: [] } }),
    likelist: async () => ({ body: { code: 200, ids: [] } }),
  } as unknown as NonNullable<ConstructorParameters<typeof NeteaseClient>[1]>;
  const client = new NeteaseClient('fixture-A', api, undefined, options);
  return { client, calls, setIds: (value: string[]) => { ids = value; }, setHeader: (value: typeof header) => { header = value; }, setSongs: (value: typeof tracks) => { tracks = value; }, setAccount: (value: typeof account) => { account = value; } };
}
function reader<T>(controller: AbortController, operation: () => Promise<T>, options: Partial<LibraryReadLifetime> & { cacheMode?: 'reload' } = {}) {
  return withLibraryRead({ signal: controller.signal, deadlineAtMs: Date.now() + 3000, now: Date.now, isCurrent: () => true, ...options }, operation);
}
function version(value: Awaited<ReturnType<NeteaseClient['getPlaylist']>>) { assert.match(value.snapshotVersion ?? '', /^[a-f0-9-]{36}$/); return value.snapshotVersion!; }

test('005：同页组件共享header/song，第二页仅新song且TTL版本稳定', async () => {
  const h = fixture(), held = deferred(); h.setHeader(() => held.promise);
  const a = h.client.getPlaylist('301', page), b = h.client.getPlaylist('301', page); await turn();
  assert.equal(h.calls.headers, 1); held.resolve(detail(Array.from({ length: 50 }, (_, i) => String(1000 + i))));
  const [first, same] = await Promise.all([a, b]); assert.equal(h.calls.songs.length, 1);
  assert.equal(version(first), version(same)); assert.deepEqual(first.tracks.items.map(t => t.id), h.calls.songs[0]);
  (first.tracks.items[0]!.artists as string[]).push('外部修改'); assert.equal(same.tracks.items[0]!.artists.length, 1);
  const next = await h.client.getPlaylist('301', { offset: 20, limit: 20 });
  assert.equal(h.calls.headers, 1); assert.equal(h.calls.songs.length, 2); assert.equal(version(next), version(same));
  assert.deepEqual(h.calls.songs[1], Array.from({ length: 20 }, (_, i) => String(1020 + i)));
});

for (const count of [50, 500, 5000, 6000]) test(`005：${count}首屏与尾页只采header一次，浏览不套5000播放cap`, async () => {
  const h = fixture(); h.setIds(Array.from({ length: count }, (_, i) => String(i + 1)));
  const first = await h.client.getPlaylist('301', page), tail = await h.client.getPlaylist('301', { offset: count - 1, limit: 20 });
  assert.equal(h.calls.headers, 1); assert.equal(h.calls.songs.length, 2); assert.equal(h.calls.songs[0]!.length, 20);
  assert.equal(tail.tracks.items[0]?.id, String(count)); assert.equal(tail.tracks.total, count); assert.equal(tail.tracks.hasMore, false); assert.equal(version(first), version(tail));
});

test('005：真实重读完全相同复用UUID，orderedIDs/header任一变化换版', async () => {
  let now = 1000; const h = fixture({ now: () => now }); const first = await h.client.getPlaylist('301', page);
  now += 30001; const same = await h.client.getPlaylist('301', page); assert.equal(h.calls.headers, 2); assert.equal(version(first), version(same));
  h.setIds(Array.from({ length: 50 }, (_, i) => String(2000 + i))); now += 30001;
  const changed = await h.client.getPlaylist('301', page); assert.notEqual(version(changed), version(same));
  h.setHeader(async () => detail(Array.from({ length: 50 }, (_, i) => String(2000 + i)), '改名')); now += 30001;
  assert.notEqual(version(await h.client.getPlaylist('301', page)), version(changed));
});

test('005：reload区别normal且同轮共享，新round晚旧header不得覆盖', async () => {
  const h = fixture(), old = deferred(), fresh = deferred(); let round = 0; h.setHeader(() => (++round === 1 ? old : fresh).promise);
  const initial = reader(new AbortController(), () => h.client.getPlaylist('301', page)).catch(error => error); await turn();
  const reload = reader(new AbortController(), () => h.client.getPlaylist('301', page), { cacheMode: 'reload' });
  const reloadSame = reader(new AbortController(), () => h.client.getPlaylist('301', page), { cacheMode: 'reload' }); await turn(); assert.equal(h.calls.headers, 2);
  fresh.resolve(detail(['2000'])); const [a, b] = await Promise.all([reload, reloadSame]); assert.equal(version(a), version(b)); assert.equal(h.calls.songs.length, 1);
  old.resolve(detail(['1000'])); assert.equal((await initial).code, 'READ_CANCELLED');
  const cached = await h.client.getPlaylist('301', page); assert.equal(version(cached), version(a)); assert.equal(cached.tracks.items[0]?.id, '2000'); assert.equal(h.calls.headers, 2);
});

test('005：A subscriber取消不废B共享header，last取消零新song/零cache commit', async () => {
  const h = fixture(), held = deferred(); h.setHeader(() => held.promise);
  const ca = new AbortController(), cb = new AbortController();
  const a = reader(ca, () => h.client.getPlaylist('301', page)); const rejected = assert.rejects(a, { code: 'READ_CANCELLED' });
  const b = reader(cb, () => h.client.getPlaylist('301', page)); await turn(); ca.abort(); await rejected;
  held.resolve(detail(['1'])); assert.equal((await b).tracks.items[0]?.id, '1'); assert.equal(h.calls.headers, 1); assert.equal(h.calls.songs.length, 1);
  const next = deferred(); h.setHeader(() => next.promise); const cc = new AbortController();
  const pending = reader(cc, () => h.client.getPlaylist('302', page)); const cancelled = assert.rejects(pending, { code: 'READ_CANCELLED' }); await turn(); cc.abort(); await cancelled;
  next.resolve({ body: { code: 200, playlist: { id: 302, name: '已废弃', trackCount: 1, trackIds: [2] } } }); await turn(); assert.equal(h.calls.songs.length, 1);
  h.setHeader(async () => ({ body: { code: 200, playlist: { id: 302, name: '新读取', trackCount: 1, trackIds: [3] } } }));
  assert.equal((await h.client.getPlaylist('302', page)).tracks.items[0]?.id, '3'); assert.equal(h.calls.headers, 3);
});

test('005：短subscriber期限不成为共享deadline，晚加入不续共享10秒', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const h = fixture(), held = deferred(); h.setHeader(() => held.promise);
  const a = reader(new AbortController(), () => h.client.getPlaylist('301', page), { deadlineAtMs: 1020 }); const rejected = assert.rejects(a, { code: 'READ_DEADLINE' });
  const b = reader(new AbortController(), () => h.client.getPlaylist('301', page), { deadlineAtMs: 12000 }); await turn(); t.mock.timers.tick(21); await rejected;
  held.resolve(detail(['1'])); await b; assert.equal(h.calls.headers, 1);
  const never = deferred(); h.setHeader(() => never.promise);
  const x = reader(new AbortController(), () => h.client.getPlaylist('302', page), { deadlineAtMs: 50000 }); const failed = assert.rejects(x, { code: 'READ_DEADLINE' }); await turn();
  t.mock.timers.tick(9000);
  const y = reader(new AbortController(), () => h.client.getPlaylist('302', page), { deadlineAtMs: 50000 }); const late = assert.rejects(y, { code: 'READ_DEADLINE' }); await turn();
  t.mock.timers.tick(1001); await Promise.all([failed, late]); assert.equal(h.calls.headers, 2); never.resolve(detail(['1'], '歌单', { id: 302 })); await turn();
});

test('005：换account废弃header/song late与所有完成cache；旧finally不删新flight', async () => {
  const h = fixture(), old = deferred(), fresh = deferred(); let rounds = 0; h.setHeader(() => (++rounds === 1 ? old : fresh).promise);
  const before = h.client.getPlaylist('301', page); const rejected = assert.rejects(before, { code: 'READ_CANCELLED' }); await turn();
  h.client.setCredential('fixture-B'); const after = h.client.getPlaylist('301', page); await turn(); old.resolve(detail(['1'])); await rejected;
  const shared = h.client.getPlaylist('301', page); await turn(); assert.equal(h.calls.headers, 2); fresh.resolve(detail(['2']));
  const [a, b] = await Promise.all([after, shared]); assert.equal(version(a), version(b)); assert.equal(a.tracks.items[0]?.id, '2');
  const delayed = deferred(); h.setSongs(() => delayed.promise);
  const pageRead = h.client.getPlaylist('301', { offset: 0, limit: 1 }); const stopped = assert.rejects(pageRead, { code: 'READ_CANCELLED' }); await turn(); h.client.clearCredential();
  delayed.resolve({ body: { code: 200, songs: [song('2')] } }); await stopped; assert.equal(h.client.configured, false);
});

test('005：source重复/乱序/缺项/额外song按选中IDs还原，cursor消耗limit', async () => {
  const h = fixture(); h.setIds(['3', '1', '3', '2']); h.setSongs(async () => ({ body: { code: 200, songs: [song('1'), song('3'), song('999')] } }));
  const first = await h.client.getPlaylist('301', { offset: 0, limit: 3 }); assert.deepEqual(first.tracks.items.map(t => t.id), ['3', '1', '3']);
  assert.equal(first.tracks.total, 4); assert.equal(first.tracks.hasMore, true);
  const tail = await h.client.getPlaylist('301', { offset: 3, limit: 3 }); assert.equal(tail.tracks.items.length, 0); assert.equal(tail.tracks.hasMore, false); assert.deepEqual(h.calls.songs[1], ['2']);
});

test('005：缺trackIds legacy无强version；损坏/部分/错ID明确失败非空完整列表', async () => {
  const h = fixture(); h.setHeader(async () => ({ body: { code: 200, playlist: { id: 301, name: '旧API', trackCount: 50 } } }));
  const first = await h.client.getPlaylist('301', page), next = await h.client.getPlaylist('301', { offset: 20, limit: 20 });
  assert.equal(first.snapshotVersion, undefined); assert.equal(next.snapshotVersion, undefined); assert.equal(h.calls.fallback.length, 2);
  assert.equal(h.calls.fallback[1]!.offset, 20); assert.equal(h.calls.fallback[1]!.limit, 20);
  for (const extras of [{ trackIds: null }, { trackIds: [1, 'bad'] }, { trackCount: 2, trackIds: [1] }, { id: 302, trackIds: [1], trackCount: 1 }]) {
    const broken = fixture(); broken.setHeader(async () => detail(['1'], '坏数据', extras));
    await assert.rejects(broken.client.getPlaylist('301', page), { code: 'NETEASE_REQUEST_FAILED' }); assert.equal(broken.calls.songs.length, 0); assert.equal(broken.calls.fallback.length, 0);
  }
});

test('005：header失败保留lastgood；expired失败不伪stale成功；页失败不毁base', async () => {
  let now = 1000; const h = fixture({ now: () => now }); const base = await h.client.getPlaylist('301', page);
  h.setHeader(async () => { throw Error('合成header失败'); });
  await assert.rejects(reader(new AbortController(), () => h.client.getPlaylist('301', page), { cacheMode: 'reload' }));
  assert.equal(version(await h.client.getPlaylist('301', page)), version(base));
  now += 30001; await assert.rejects(h.client.getPlaylist('301', page));
  h.setHeader(async () => detail(Array.from({ length: 50 }, (_, i) => String(1000 + i))));
  h.setSongs(async () => { throw Error('合成页失败'); }); await assert.rejects(h.client.getPlaylist('301', page));
  const headers = h.calls.headers; h.setSongs(async ids => ({ body: { code: 200, songs: ids.map(song) } }));
  assert.equal(version(await h.client.getPlaylist('301', page)), version(base)); assert.equal(h.calls.headers, headers);
});

test('005：account短cache按scope清除，header安全字段全部参与实际采样比较', async () => {
  const h = fixture(); await h.client.getUserPlaylists(); await h.client.getUserPlaylists(); assert.equal(h.calls.accounts, 1);
  h.client.setCredential('fixture-B'); await h.client.getUserPlaylists(); assert.equal(h.calls.accounts, 2);
  const first = await h.client.getPlaylist('301', page);
  h.setHeader(async () => detail(Array.from({ length: 50 }, (_, i) => String(1000 + i)), '歌单', { coverImgUrl: 'https://p1.music.126.net/public.jpg' }));
  const changed = await reader(new AbortController(), () => h.client.getPlaylist('301', page), { cacheMode: 'reload' }); assert.notEqual(version(changed), version(first)); assert.equal(changed.artworkUrl, 'https://p1.music.126.net/public.jpg');
});

test('005：相同UUID的reload页也不共享在途normal song结果', async () => {
  const h = fixture(); await h.client.getPlaylist('301', page);
  const held = deferred(); let next = 0;
  h.setSongs(async ids => (++next === 1 ? held.promise : { body: { code: 200, songs: ids.map(id => ({ ...song(id), name: '刷新后' })) } }));
  const ordinary = reader(new AbortController(), () => h.client.getPlaylist('301', { offset: 20, limit: 20 })); await turn();
  const fresh = reader(new AbortController(), () => h.client.getPlaylist('301', { offset: 20, limit: 20 }), { cacheMode: 'reload' }); await turn();
  const calls = h.calls.songs.length;
  held.resolve({ body: { code: 200, songs: Array.from({ length: 20 }, (_, i) => song(String(1020 + i))) } });
  const [a, b] = await Promise.all([ordinary, fresh]); assert.equal(calls, 3); assert.equal(version(a), version(b)); assert.equal(b.tracks.items[0]?.title, '刷新后');
});

for (const options of [{ playlistCacheMaxEntries: 1 }, { playlistCacheMaxBytes: 800 }]) test(`005：entry/byte LRU预算${JSON.stringify(options)}淘汰后无可比base则换UUID`, async () => {
  const h = fixture(options); h.setHeader(async params => detail(['1'], '歌单', { id: Number(params.id) }));
  const first = await h.client.getPlaylist('301', page); await h.client.getPlaylist('302', page);
  const again = await h.client.getPlaylist('301', page); assert.equal(h.calls.headers, 3); assert.notEqual(version(first), version(again));
});

test('005：singleentry超字节/坏header拒绝不截断，reload失败保留好entry', async () => {
  const h = fixture({ playlistCacheMaxEntryBytes: 1024 }); h.setIds(['1']); const good = await h.client.getPlaylist('301', page);
  for (const extras of [{ trackIds: Array.from({ length: 50 }, (_, i) => ({ id: i + 1 })), trackCount: 50 }, { description: 'x'.repeat(4097) }, { name: 'x'.repeat(513) }, { trackCount: -1, trackIds: [] }, { trackCount: 0.5, trackIds: [] }, { trackIds: ['9'.repeat(129)] }]) {
    h.setHeader(async () => detail(['1'], '歌单', extras));
    await assert.rejects(reader(new AbortController(), () => h.client.getPlaylist('301', page), { cacheMode: 'reload' }), { code: 'NETEASE_REQUEST_FAILED' });
    assert.equal(version(await h.client.getPlaylist('301', page)), version(good));
  }
});

test('005：subscriber预算明确拒绝第三订阅，前两个共享工作不被挤掉', async () => {
  const h = fixture({ snapshotReadMaximumSubscribers: 2 }), held = deferred(); h.setHeader(() => held.promise);
  const a = h.client.getPlaylist('301', page), b = h.client.getPlaylist('301', page); await turn();
  await assert.rejects(h.client.getPlaylist('301', page), /订阅预算/u);
  held.resolve(detail(['1'])); await Promise.all([a, b]); assert.equal(h.calls.headers, 1); assert.equal(h.calls.songs.length, 1);
});

test('005：逻辑flight预算满不派发不同key，settle后可用', async () => {
  const h = fixture({ snapshotReadMaximumFlights: 1 }), held = deferred(); h.setHeader(() => held.promise);
  const a = h.client.getPlaylist('301', page); await turn(); await assert.rejects(h.client.getPlaylist('302', page), /共享读取预算/u);
  assert.equal(h.calls.headers, 1); held.resolve(detail(['1'])); await a;
  h.setHeader(async () => detail(['2'], '歌单', { id: 302 })); await h.client.getPlaylist('302', page); assert.equal(h.calls.headers, 2);
});

test('005：32物理header取消后仍占预算直到actualsettlement，预留播放getTrack可用', async () => {
  const h = fixture(), releases: Array<() => void> = [];
  h.setHeader(params => new Promise(resolve => { releases.push(() => resolve(detail(['1'], '旧读取', { id: Number(params.id) }))); }));
  const controllers = Array.from({ length: 32 }, () => new AbortController());
  const work = controllers.map((controller, index) => reader(controller, () => h.client.getPlaylist(String(301 + index), page)));
  const outcomes = Promise.allSettled(work); await turn(); assert.equal(h.calls.headers, 32);
  assert.equal((await h.client.getTrack('999')).id, '999');
  controllers.forEach(controller => controller.abort()); for (const result of await outcomes) { assert.equal(result.status, 'rejected'); if (result.status === 'rejected') assert.equal(result.reason.code, 'READ_CANCELLED'); }
  await assert.rejects(reader(new AbortController(), () => h.client.getPlaylist('999', page)), /未返回读取预算/u); assert.equal(h.calls.headers, 32);
  releases.forEach(release => release()); await turn();
  h.setHeader(async () => detail(['2'], '新读取', { id: 999 })); assert.equal((await h.client.getPlaylist('999', page)).tracks.items[0]?.id, '2'); assert.equal(h.calls.headers, 33);
});

test('005：normal账户回包晚于reload不得覆盖account cache', async () => {
  const h = fixture(), old = deferred(), fresh = deferred(); let rounds = 0; h.setAccount(() => (++rounds === 1 ? old : fresh).promise);
  const a = h.client.getUserPlaylists().catch(error => error); await turn();
  const b = reader(new AbortController(), () => h.client.getUserPlaylists(), { cacheMode: 'reload' }); await turn();
  fresh.resolve({ body: { code: 200, account: { id: 43 } } }); await b;
  old.resolve({ body: { code: 200, account: { id: 42 } } }); assert.equal((await a).code, 'READ_CANCELLED');
  await h.client.getUserPlaylists(); assert.equal(h.calls.accounts, 2);
});

test('005：retained base只含公共header/IDs，不留raw私有字段与播放URL', async () => {
  const h = fixture(); h.setHeader(async () => ({ ...detail(['1'], '歌单', { cookie: 'private-cookie', tracks: [{ audioUrl: 'https://audio.invalid/signed?token=secret' }], coverImgUrl: 'https://p1.music.126.net/public.jpg' }), cookie: 'raw-private' }));
  await h.client.getPlaylist('301', page);
  const internal = h.client as unknown as { playlistBases: Map<string, unknown> };
  const retained = JSON.stringify([...internal.playlistBases.values()]); assert.doesNotMatch(retained, /private|audio|token|cookie|tracks/iu); assert.match(retained, /public\.jpg/u);
});

test('005：新版base已提交后旧页late不能回写当前metadata cache', async () => {
  const h = fixture(); h.setIds(['1', '2']); await h.client.getPlaylist('301', { offset: 0, limit: 1 });
  const held = deferred(); let count = 0;
  h.setSongs(async ids => (++count === 1 ? held.promise : { body: { code: 200, songs: ids.map(id => ({ ...song(id), name: '新版元数据' })) } }));
  const old = h.client.getPlaylist('301', { offset: 1, limit: 1 }).catch(error => error); await turn();
  h.setIds(['2', '3']); await reader(new AbortController(), () => h.client.getPlaylist('301', { offset: 0, limit: 1 }), { cacheMode: 'reload' });
  held.resolve({ body: { code: 200, songs: [song('2')] } });
  const before = await old, metadata = await h.client.getTrack('2');
  assert.equal(before.code, 'READ_CANCELLED'); assert.equal(metadata.title, '新版元数据');
});

test('005：缺实际playlist header不是legacy能力缺失，不制造默认成功base', async () => {
  const h = fixture(); h.setHeader(async () => ({ body: { code: 200 } }));
  await assert.rejects(h.client.getPlaylist('301', page), { code: 'NETEASE_REQUEST_FAILED' }); assert.equal(h.calls.fallback.length, 0);
});

test('005-R1：时钟回拨不续鲜base，实际重采不同IDs才换版', async () => {
  let now = 100000; const h = fixture({ now: () => now }); h.setIds(['1']);
  const first = await h.client.getPlaylist('301', page); h.setIds(['2']); now = 90000;
  const next = await h.client.getPlaylist('301', page);
  assert.equal(h.calls.headers, 2); assert.equal(next.tracks.items[0]?.id, '2'); assert.notEqual(version(next), version(first));
});

test('005-R1：时钟回拨必须重新采账户，不能复用未来出生的cache', async () => {
  let now = 100000; const h = fixture({ now: () => now }); await h.client.getUserPlaylists();
  now = 90000; await h.client.getUserPlaylists(); assert.equal(h.calls.accounts, 2);
});

for (const capacity of [1, 32]) test(`005-R1：新版base被LRU淘汰${capacity}后旧页仍拒绝且不污染metadata`, async () => {
  const h = fixture({ playlistCacheMaxEntries: capacity }); h.setIds(['1', '2']);
  await h.client.getPlaylist('301', { offset: 0, limit: 1 });
  const held = deferred(); let count = 0;
  h.setSongs(async ids => (++count === 1 ? held.promise : { body: { code: 200, songs: ids.map(id => ({ ...song(id), name: '已接受的新元数据' })) } }));
  const old = h.client.getPlaylist('301', { offset: 1, limit: 1 }).catch(error => error); await turn();
  h.setIds(['2', '3']); await reader(new AbortController(), () => h.client.getPlaylist('301', { offset: 0, limit: 1 }), { cacheMode: 'reload' });
  h.setHeader(async params => detail(['9'], '其他歌单', { id: Number(params.id) }));
  for (let index = 0; index < capacity; index++) await h.client.getPlaylist(String(302 + index), page);
  held.resolve({ body: { code: 200, songs: [{ ...song('2'), name: '迟到旧元数据' }] } });
  const outcome = await old; assert.equal(outcome.code, 'READ_CANCELLED');
  assert.equal((await h.client.getTrack('2')).title, '已接受的新元数据');
});

for (const field of ['id', 'name', 'trackCount']) test(`005-R1：完整IDs不得合成缺失header字段${field}`, async () => {
  const h = fixture(); const playlist: Record<string, unknown> = { id: 301, name: '真实header', trackCount: 0, trackIds: [] };
  delete playlist[field]; h.setHeader(async () => ({ body: { code: 200, playlist } }));
  await assert.rejects(h.client.getPlaylist('301', page), { code: 'NETEASE_REQUEST_FAILED' });
  assert.equal(h.calls.songs.length, 0); assert.equal(h.calls.fallback.length, 0);
});

test('005-R1：仅其他歌单LRU淘汰不撤销原页，结算后在途预算可复用', async () => {
  const h = fixture({ playlistCacheMaxEntries: 1, snapshotReadMaximumSubscribers: 2 }); h.setIds(['1']);
  const first = await h.client.getPlaylist('301', page); const held = deferred(); let count = 0;
  h.setSongs(async ids => (++count === 1 ? held.promise : { body: { code: 200, songs: ids.map(song) } }));
  const pending = h.client.getPlaylist('301', page); await turn();
  h.setHeader(async params => detail(['2'], '其他歌单', { id: Number(params.id) })); await h.client.getPlaylist('302', page);
  held.resolve({ body: { code: 200, songs: [song('1')] } }); const result = await pending;
  assert.equal(version(result), version(first)); assert.equal(result.tracks.items[0]?.id, '1');
  const [a, b] = await Promise.all([h.client.getPlaylist('303', page), h.client.getPlaylist('303', page)]);
  assert.equal(version(a), version(b)); assert.equal(a.tracks.items[0]?.id, '2');
});
