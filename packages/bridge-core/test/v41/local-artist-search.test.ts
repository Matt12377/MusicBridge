import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as yieldForeground } from 'node:timers/promises';
import type { ArtistQuery, LocalAlbumSummary, LocalLibraryTrackSummary, LocalMetadata, LocalPlayRequest } from '@music-bridge/contracts';
import { createLocalArtistSearchService, localArtistId, LocalArtistSearchError, type LocalArtistSearchService } from '../../src/collection/local-artist-search.js';
import { materializeLocalSearchQueue } from '../../src/collection/mb-queue-materializer.js';
import { LocalAlbumReadError } from '../../src/collection/local-album-browser/grouping.js';
import type { CollectionRepository } from '../../src/collection/repository.js';
import type { LocalAlbumOwnerService } from '../../src/collection/local-album-browser/owner-port.js';
import type { LocalAlbumSqlMobileQuery, LocalAlbumSqlMobileRow } from '../../src/collection/local-album-browser/sql-types.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function temporaryDirectory(): string {
  const root = process.env.TMPDIR ?? path.join(process.env.DEV_BUILD_ROOT ?? '/Volumes/LifeWeave/Developer/CommandLine', 'tmp');
  assert.ok(path.resolve(root).startsWith('/Volumes/LifeWeave/Developer/CommandLine/'));
  mkdirSync(root, { recursive: true }); return mkdtempSync(path.join(root, 'mousa41-artist-index-'));
}
function fixture(directory: string | null = null) {
  let revision = 'revision-1', highWater = 1, changed: string[] = [], scans = 0;
  const metadata = new Map<number, LocalMetadata>([
    [1, { title: '七里香', album: '七里香', artist: '周杰伦', artists: ['周杰伦'], albumArtist: '周杰伦', albumArtists: ['周杰伦'] }],
    [2, { title: '合唱曲', album: '合辑', artist: '周杰伦', artists: ['周杰伦', '王菲'], albumArtist: 'Various Artists', albumArtists: ['Various Artists'] }],
    [3, { title: 'Back in Black', album: '摇滚现场', artist: 'AC/DC', artists: ['AC/DC'], albumArtist: 'AC/DC', albumArtists: ['AC/DC'] }],
    [4, { title: 'September', album: '现场', artist: 'Earth, Wind & Fire', artists: ['Earth, Wind & Fire'], albumArtists: [] }],
  ]);
  const facts = (n: number): LocalLibraryTrackSummary => ({
    track: { id: id(n), assetId: id(100 + n), selectionRevision: '1', segment: null },
    asset: { id: id(100 + n), libraryRootId: id(1000), sourceRootId: id(1001), rootRevision: '1', fileRevision: '1', locationRevision: '1', sampleFrames: null, timebaseHz: null },
    metadata: structuredClone(metadata.get(n)!), versionTokens: [],
  });
  const album = (n: number): LocalAlbumSummary => ({ id: `album-${n}`, kind: 'source-directory', rootId: id(1000), editionId: null,
    title: metadata.get(n)!.album!, artists: [metadata.get(n)!.artist!], year: null, versionLabel: null, trackCount: 1,
    representativeTrackId: id(n), revision: `album-${n}-${revision}`, artworkAvailable: false, artworkState: 'missing', statuses: ['missing-artwork'] });
  const rows = (): LocalAlbumSqlMobileRow[] => [...metadata.keys()].map(n => ({ album: album(n), groupHash: hash(n), artworkSourceRevision: hash(['art', n]),
    member: { fact: { relative: `album-${n}/track.flac`, summary: facts(n), rawMetadata: structuredClone(metadata.get(n)!), hasArtwork: false, artworkRevision: null },
      sequence: 1, disc: null, trackNumber: null, editionLink: null, statuses: [] } }));
  const current = (query: LocalAlbumSqlMobileQuery) => {
    if (query.kind === 'members' && query.trackId === null) scans++;
    const selected = rows().filter(row => (!query.rootId || row.album.rootId === query.rootId) && (!query.albumKey || row.album.id === query.albumKey)
      && (!query.trackId || row.member!.fact.summary.track.id === query.trackId));
    const items = selected.slice(query.offset, query.offset + query.limit).map(row => query.kind === 'groups' ? { ...row, member: null } : row);
    return { revision, total: selected.length, items };
  };
  const collection = { localCatalog: { privateArtistSearchChanges: (after: number) => ({ highWater, rebuild: after === 0, trackIds: after < highWater ? changed : [] }) } } as unknown as CollectionRepository;
  const localAlbums = { privateMobile: { refresh: async () => {}, revision: () => revision, current } } as unknown as LocalAlbumOwnerService;
  const options = { directory, collection, localAlbums, assertCurrent() {} };
  return { options, service: createLocalArtistSearchService(options), reopen: () => createLocalArtistSearchService(options), facts,
    scans: () => scans, change(n: number, fields: LocalMetadata) { metadata.set(n, fields); highWater++; revision = `revision-${highWater}`; changed = [id(n)]; } };
}

test('本地艺人区分专辑归属与歌曲参与，保留结构化多人及含标点原名', async t => {
  const f = fixture(); t.after(() => f.service.close());
  const page = await f.service.queryArtists({ query: '', offset: 0, limit: 100 });
  assert.equal(page.items.length, 5);
  const jay = page.items.find(artist => artist.id === localArtistId('周杰伦'))!;
  assert.equal(jay.albumCount, 1); assert.equal(jay.trackCount, 2);
  const owner = await f.service.artist(localArtistId('Various Artists'));
  assert.equal(owner.albumCount, 1); assert.equal(owner.trackCount, 0);
  assert.equal((await f.service.queryArtistAlbums({ artistId: jay.id, relation: 'appearsOn', offset: 0, limit: 20 })).items[0]?.id, 'album-2');
  assert.equal((await f.service.queryArtistTracks({ artistId: localArtistId('王菲'), offset: 0, limit: 20 })).items[0]?.track.id, id(2));
  assert.ok(page.items.some(artist => artist.name === 'AC/DC'));
  assert.ok(page.items.some(artist => artist.name === 'Earth, Wind & Fire'));
  assert.equal(localArtistId('  AC/DC  '), localArtistId('ac/dc'));
});

test('搜索在服务端匹配原文多词、全拼及首字母，并保留原albumKey映射', async t => {
  const f = fixture(); t.after(() => f.service.close());
  for (const query of ['周 七里', 'zhou jielun qili', 'zjl qlx']) {
    const result = await f.service.search({ query, offset: 0, limit: 1 });
    assert.equal(result.tracks.total, 1, query); assert.equal(result.tracks.items[0]?.track.id, id(1));
    assert.equal(result.tracks.items[0]?.rootId, id(1000)); assert.equal(result.tracks.items[0]?.albumKey, 'album-1');
  }
  assert.deepEqual(await f.service.trackMemberships(id(1)), [{ rootId: id(1000), albumKey: 'album-1' }]);
  assert.equal((await f.service.search({ query: 'AC/DC', offset: 0, limit: 10 })).tracks.total, 1);
});

test('艺人、专辑和歌曲的原文命中优先于全拼或首字母，分页前完成排序', async t => {
  for (const entry of [
    { label: '全拼', query: 'lin', phonetic: '蔡依林', original: 'Linkin Park' },
    { label: '首字母', query: 'cj', phonetic: '陈佳', original: 'CJ' },
  ]) await t.test(entry.label, async sub => {
    const f = fixture(); sub.after(() => f.service.close());
    for (const [n, title, album, artist] of [
      [1, 'A Song', 'A Live', entry.phonetic], [2, 'Z Song', 'Z Live', entry.original],
    ] as const) f.change(n, { title, album, artist, artists: [artist], albumArtist: artist, albumArtists: [artist] });
    const first = await f.service.search({ query: entry.query, offset: 0, limit: 1 });
    const second = await f.service.search({ query: entry.query, offset: 1, limit: 1 });
    assert.deepEqual({ artist: first.artists.items[0]?.name, album: first.albums.items[0]?.id, track: first.tracks.items[0]?.track.id },
      { artist: entry.original, album: 'album-2', track: id(2) });
    assert.deepEqual({ artist: second.artists.items[0]?.name, album: second.albums.items[0]?.id, track: second.tracks.items[0]?.track.id },
      { artist: entry.phonetic, album: 'album-1', track: id(1) });
    for (const result of [first, second]) {
      assert.deepEqual([result.artists.total, result.albums.total, result.tracks.total], [2, 2, 2]);
    }
    assert.equal((await f.service.queryArtists({ query: entry.query, offset: 0, limit: 1 })).items[0]?.name, entry.original);
    const empty = await f.service.search({ query: '', offset: 0, limit: 20 });
    const spaces = await f.service.search({ query: '   ', offset: 0, limit: 20 });
    assert.deepEqual(empty.tracks.items.map(item => item.track.id), [id(1), id(3), id(4), id(2)]);
    assert.deepEqual(spaces.artists.items, empty.artists.items);
    assert.deepEqual(spaces.albums.items, empty.albums.items);
    assert.deepEqual(spaces.tracks.items, empty.tracks.items);
  });
});

test('艺人原文完整姓名在分页前优先于复合名，保留独立人物、参与计数与多词召回', async t => {
  const f = fixture(); t.after(() => f.service.close());
  const exact = '周杰伦', compound = '周杰伦&洪荣宏';
  f.change(1, { title: '独唱曲', album: '本名专辑', artist: exact, artists: [exact], albumArtist: exact, albumArtists: [exact] });
  f.change(2, { title: '合唱曲', album: '合辑', artist: compound, artists: [compound], albumArtist: 'Various Artists', albumArtists: ['Various Artists'] });
  const first = await f.service.search({ query: exact, offset: 0, limit: 1 });
  const second = await f.service.search({ query: exact, offset: 1, limit: 1 });
  assert.deepEqual(first.artists.items.map(item => item.name), [exact], '原文完整姓名必须先于同样含原文的复合名，不能在 LIMIT 后才调整。');
  assert.deepEqual(second.artists.items.map(item => item.name), [compound]);
  assert.equal(first.artists.total, 2); assert.equal(first.artists.hasMore, true); assert.equal(second.artists.hasMore, false);
  assert.equal((await f.service.queryArtists({ query: exact, offset: 0, limit: 1 })).items[0]?.id, localArtistId(exact));
  assert.notEqual(first.artists.items[0]?.id, second.artists.items[0]?.id, '排序不合并原有独立人物身份。');
  assert.deepEqual(first.artists.items.map(({ albumCount, trackCount }) => [albumCount, trackCount]), [[1, 1]]);
  assert.deepEqual(second.artists.items.map(({ albumCount, trackCount }) => [albumCount, trackCount]), [[0, 1]], '仅参与的复合名仍可查到，不能为排序隐藏。');
  const separated = await f.service.queryArtists({ query: '周杰伦 洪荣宏', offset: 0, limit: 1 });
  assert.deepEqual(separated.items.map(item => item.name), [compound], '完整姓名只影响排序，分词仍可分别命中非连续原文。');
  const empty = await f.service.queryArtists({ query: '', offset: 0, limit: 100 });
  assert.deepEqual(empty.items.filter(item => [exact, compound].includes(item.name)).map(item => item.name), [compound, exact], '空查询保持原全拼字典序。');
});

test('艺人完整原文、全拼与首字母在同层分页前优先于合作名和前缀扩展名', async t => {
  for (const query of ['周杰伦', 'zhoujielun', 'zhou jie lun', 'zjl']) await t.test(query, async sub => {
    const f = fixture(); sub.after(() => f.service.close());
    const exact = '周杰伦', compound = '周杰伦&洪荣宏', extended = '周杰伦经典合唱';
    for (const [n, name] of [[1, exact], [2, compound], [3, extended]] as const) {
      f.change(n, { title: `歌曲${n}`, album: `专辑${n}`, artist: name, artists: [name], albumArtist: name, albumArtists: [name] });
    }
    const pages = [];
    for (let offset = 0; offset < 3; offset++) pages.push(await f.service.search({ query, offset, limit: 1 }));
    assert.deepEqual(pages[0]!.artists.items.map(item => item.name), [exact], '完整姓名的原文、全拼或首字母必须在 LIMIT 前优先');
    assert.deepEqual(new Set(pages.slice(1).map(page => page.artists.items[0]!.name)), new Set([compound, extended]));
    assert.deepEqual(pages.map(page => [page.artists.total, page.artists.hasMore]), [[3, true], [3, true], [3, false]]);
    assert.equal(new Set(pages.map(page => page.artists.items[0]!.id)).size, 3, '合作名与扩展名仍保持原独立人物身份');
    assert.equal((await f.service.queryArtists({ query, offset: 0, limit: 1 })).items[0]!.id, localArtistId(exact));
  });
});

test('完整全拼或首字母全等仍不能越过原文匹配层级', async t => {
  for (const query of ['zhoujielun', 'zjl']) await t.test(query, async sub => {
    const f = fixture(); sub.after(() => f.service.close());
    const exact = '周杰伦', original = `${query.toUpperCase()} Guests`;
    for (const [n, name] of [[1, exact], [2, original]] as const) {
      f.change(n, { title: `歌曲${n}`, album: `专辑${n}`, artist: name, artists: [name], albumArtist: name, albumArtists: [name] });
    }
    const first = await f.service.search({ query, offset: 0, limit: 1 });
    const second = await f.service.search({ query, offset: 1, limit: 1 });
    assert.deepEqual(first.artists.items.map(item => item.name), [original], '原文包含命中也必须优先于完整拼音或首字母命中');
    assert.deepEqual(second.artists.items.map(item => item.name), [exact]);
    assert.equal(first.artists.total, 2); assert.equal(second.artists.total, 2);
  });
});

test('逐词原文优先允许跨元数据字段，中文与拼音混合查询不要求整句连续', async t => {
  for (const entry of [
    { label: '中文原文跨标题和艺人', query: '周 七里', title: 'Z 七里香', artist: '周杰伦', expected: [1, 2] },
    { label: '全拼原文跨标题和艺人', query: 'zhou qili', title: 'Z Qili', artist: 'Zhou', expected: [2, 1] },
    { label: '中文原文与首字母混合', query: '周 qlx', title: 'Z QLX', artist: '周杰伦', expected: [2, 1] },
  ]) await t.test(entry.label, async sub => {
    const f = fixture(); sub.after(() => f.service.close());
    f.change(1, { title: 'A 七里香', album: 'A Album', artist: '周杰伦', artists: ['周杰伦'], albumArtists: ['周杰伦'] });
    f.change(2, { title: entry.title, album: 'Z Album', artist: entry.artist, artists: [entry.artist], albumArtists: [entry.artist] });
    const result = await f.service.search({ query: entry.query, offset: 0, limit: 20 });
    assert.equal(result.tracks.total, 2);
    assert.deepEqual(result.tracks.items.map(item => item.track.id), entry.expected.map(id));
    assert.deepEqual((await f.service.querySearchTracks({ query: entry.query, offset: 0, limit: 20 })).items.map(item => item.track.id), entry.expected.map(id));
  });
});

test('原文优先的搜索分页与完整续播队列保持同序，非首条跨页选择不漂移', async t => {
  const f = fixture(); t.after(() => f.service.close());
  for (let n = 1; n <= 241; n++) {
    const artist = n === 241 ? 'Linkin Park' : '蔡依林';
    f.change(n, { title: `${n === 241 ? 'Z' : 'A'} Song ${String(n).padStart(3, '0')}`, album: `Live ${n}`,
      artist, artists: [artist], albumArtist: artist, albumArtists: [artist] });
  }
  const facts = Array.from({ length: 241 }, (_, n) => f.facts(n + 1));
  const tracks = new Map(facts.map(item => [item.track.id, item.track]));
  const assets = new Map(facts.map(item => [item.asset.id, item.asset]));
  const root = { id: id(1000), sourceRootId: id(1001), role: 'library', revision: '1' };
  Object.assign(f.options.collection.localCatalog, { track: (key: string) => tracks.get(key)!, asset: (key: string) => assets.get(key)!, root: () => root });
  Object.assign(f.options.collection, { sources: { root: () => ({ authorized: true }) } });
  const visible: string[] = [];
  for (let offset = 0; offset < 241; offset += 73) {
    const result = await f.service.search({ query: 'lin', offset, limit: 73 });
    assert.equal(result.tracks.total, 241); visible.push(...result.tracks.items.map(item => item.track.id));
  }
  const selected = f.facts(220), revision = await f.service.revision();
  const selection: LocalPlayRequest = { schema_version: '1.2', request_id: '原搜索排序请求', route: 'roon_audio_input', source_kind: 'local_file',
    local_track_id: selected.track.id, asset_id: selected.asset.id, expected_asset_revision: '1', action: 'PLAY_NOW',
    target: { core_id: 'core', zone_id: 'zone' }, context: { kind: 'search', query: 'lin', revision } };
  const pages: number[] = [];
  const artists = { revision: () => f.service.revision(), queryArtistTracks: f.service.queryArtistTracks,
    querySearchTracks: async (request: ArtistQuery) => { pages.push(request.offset); return f.service.querySearchTracks(request); } };
  const queue = await materializeLocalSearchQueue(f.options.collection, artists, selection, Date.now() + 10_000, () => {});
  assert.deepEqual(pages, [0, 200]);
  assert.deepEqual(queue.sources.map(source => source.snapshot.trackId), visible);
  assert.equal(visible[0], id(241));
  assert.deepEqual(visible.slice(1), Array.from({ length: 240 }, (_, n) => id(n + 1)));
  assert.equal(queue.startIndex, 220); assert.equal(queue.sources[queue.startIndex]?.snapshot.trackId, selected.track.id);
});

test('metadata尾部更新只重读受影响曲目，人物计数与旧拼音命中一起撤回', async t => {
  const f = fixture(); t.after(() => f.service.close()); await f.service.refresh();
  const scans = f.scans();
  f.change(1, { title: '新歌', album: '七里香', artist: '陈奕迅', artists: ['陈奕迅'], albumArtist: '陈奕迅', albumArtists: ['陈奕迅'] });
  const result = await f.service.search({ query: 'chen yixun', offset: 0, limit: 20 });
  assert.equal(result.tracks.total, 1); assert.equal(f.scans(), scans);
  assert.equal((await f.service.artist(localArtistId('周杰伦'))).trackCount, 1);
  assert.equal((await f.service.artist(localArtistId('周杰伦'))).albumCount, 0);
  assert.equal((await f.service.search({ query: 'zjl qlx', offset: 0, limit: 20 })).tracks.total, 0);
});

test('派生SQLite跨重开复用；显式rebuild仍从原Owner重建', async t => {
  const directory = temporaryDirectory(); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = fixture(directory); await f.service.refresh(); const scans = f.scans(); await f.service.close();
  const reopened: LocalArtistSearchService = f.reopen(); t.after(() => reopened.close());
  assert.equal((await reopened.queryArtists({ query: 'zjl', offset: 0, limit: 20 })).total, 1);
  assert.equal(f.scans(), scans, '重开查询不会下载或重扫全部原曲目');
  await reopened.rebuild(); assert.ok(f.scans() > scans);
});

test('交互读取立即报告准备中，两个调用者共享索引，完成后返回真实结果', async t => {
  const f = fixture(); t.after(() => f.service.close());
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  f.options.localAlbums.privateMobile.refresh = async () => held;
  t.after(release);
  const query = { query: 'zjl', offset: 0, limit: 20 };
  const results = await Promise.allSettled([
    f.service.queryArtists(query, 'interactive'), f.service.search(query, 'interactive'),
  ]);
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.code === 'PREPARING'));
  assert.equal(f.scans(), 0, '准备状态不会伪造已完成页，也不会重复扫描');
  release(); await f.service.refresh();
  const page = await f.service.queryArtists(query, 'interactive');
  assert.equal(page.total, 1); assert.equal(f.scans(), 1);
});

test('交互索引准备失败会结束等待，保留明确失败而非永远准备中', async t => {
  const f = fixture(); t.after(() => f.service.close());
  let attempts = 0;
  f.options.localAlbums.privateMobile.refresh = async () => { attempts++; throw new Error('合成 Owner 读取失败'); };
  await assert.rejects(f.service.queryArtists({ query: '', offset: 0, limit: 20 }, 'interactive'), { code: 'PREPARING' });
  while (f.service.preparing) await new Promise<void>(resolve => setImmediate(resolve));
  for (let caller = 0; caller < 2; caller++) {
    await assert.rejects(f.service.queryArtists({ query: '', offset: 0, limit: 20 }, 'interactive'), { code: 'UNAVAILABLE' });
  }
  assert.equal(attempts, 1, '第二设备轮询不能自动重新启动失败的全量准备');
  f.options.localAlbums.privateMobile.refresh = async () => {};
  await f.service.refresh();
  assert.equal((await f.service.queryArtists({ query: 'zjl', offset: 0, limit: 20 }, 'interactive')).total, 1);
});

test('音乐库变更时交互读取重新准备，旧索引不冒充新修订', async t => {
  const f = fixture(); t.after(() => f.service.close()); await f.service.refresh();
  f.change(1, { title: '新歌', album: '七里香', artist: '陈奕迅', artists: ['陈奕迅'], albumArtists: ['陈奕迅'] });
  await assert.rejects(f.service.search({ query: 'chenyixun', offset: 0, limit: 20 }, 'interactive'), { code: 'PREPARING' });
  await f.service.refresh();
  assert.equal((await f.service.search({ query: 'chenyixun', offset: 0, limit: 20 }, 'interactive')).tracks.total, 1);
});

test('准备期间关闭会停止索引，后续读取不能从旧服务返回页', async () => {
  const f = fixture();
  await assert.rejects(f.service.queryArtists({ query: '', offset: 0, limit: 20 }, 'interactive'), { code: 'PREPARING' });
  await f.service.close();
  assert.equal(f.scans(), 0);
  await assert.rejects(f.service.queryArtists({ query: '', offset: 0, limit: 20 }, 'interactive'), { code: 'CLOSED' });
});

test('可用的异步索引读口覆盖全量与增量读取，不回到 Owner 同步查询', async t => {
  const f = fixture(); t.after(() => f.service.close());
  const current = f.options.localAlbums.privateMobile.current;
  let reads = 0;
  Object.assign(f.options.localAlbums.privateMobile, {
    async indexRead(query: LocalAlbumSqlMobileQuery, signal?: AbortSignal) {
      assert.ok(signal); assert.equal(signal.aborted, false);
      await yieldForeground(); reads++; return current(query);
    },
    current() { throw new Error('异步索引不能退回同步 Owner 查询'); },
  });
  const initial = await f.service.search({ query: 'zjl', offset: 0, limit: 20 });
  assert.equal(initial.tracks.total, 2); assert.ok(reads >= 2);
  const initialReads = reads;
  f.change(1, { title: '新歌', album: '七里香', artist: '陈奕迅', artists: ['陈奕迅'], albumArtists: ['陈奕迅'] });
  const updated = await f.service.search({ query: 'chenyixun', offset: 0, limit: 20 });
  assert.equal(updated.tracks.total, 1); assert.ok(reads > initialReads);
});

test('关闭共享索引会取消其独立读任务，无需先等待专辑服务关闭', { timeout: 3_000 }, async t => {
  const f = fixture(); t.after(() => f.service.close());
  let entered = false, aborted = false;
  Object.assign(f.options.localAlbums.privateMobile, {
    async indexRead(_query: LocalAlbumSqlMobileQuery, signal?: AbortSignal) {
      assert.ok(signal); entered = true;
      await new Promise<void>((_resolve, reject) => {
        const cancel = () => { aborted = true; reject(new Error('合成独立读任务已取消')); };
        if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
      });
      throw new Error('已取消的读任务不能发布结果');
    },
    current() { throw new Error('不能退回同步 Owner 查询'); },
  });
  const refreshing = f.service.refresh(); void refreshing.catch(() => undefined);
  while (!entered && f.service.preparing) await yieldForeground();
  assert.equal(entered, true);
  const closing = f.service.close();
  await assert.rejects(refreshing, { code: 'CLOSED' }); await closing;
  assert.equal(aborted, true);
});

test('已撤销的准备快照不冻结后续交互，两位读者共享下一修订的新任务', async t => {
  for (const reason of ['port', 'revision'] as const) await t.test(reason === 'port' ? '原读口明确撤销快照' : '本地修订检查发现快照变化', { timeout: 3_000 }, async sub => {
    const f = fixture(), port = f.options.localAlbums.privateMobile;
    const current = port.current, revision = port.revision, originalRevision = revision();
    let cachedRevision = originalRevision, refreshes = 0, reads = 0, firstEntered = false, nextEntered = false;
    let releaseFirst!: () => void, releaseNext!: () => void;
    const firstRead = new Promise<void>(resolve => { releaseFirst = resolve; });
    const nextRead = new Promise<void>(resolve => { releaseNext = resolve; });
    sub.after(async () => { releaseFirst(); releaseNext(); await f.service.close(); });
    Object.assign(port, {
      async refresh() { refreshes++; cachedRevision = revision(); },
      // 原 SQL 读口可先发现失效，Owner 的修订缓存在下一轮 refresh 才更新。
      revision: () => reason === 'port' ? cachedRevision : revision(),
      async indexRead(query: LocalAlbumSqlMobileQuery, signal?: AbortSignal) {
        assert.ok(signal); assert.equal(signal.aborted, false);
        const page = current(query); reads++;
        if (reads === 1) {
          firstEntered = true; await firstRead;
          if (reason === 'port') throw new LocalAlbumReadError('SNAPSHOT_CHANGED', '合成原读口已撤销旧快照。');
        } else if (reads === 2) { nextEntered = true; await nextRead; }
        return page;
      },
      current() { throw new Error('失效重试也必须沿原异步读口。'); },
    });
    const first = await Promise.allSettled([
      f.service.queryArtists({ query: 'zjl', offset: 0, limit: 20 }, 'interactive'),
      f.service.search({ query: 'zjl', offset: 0, limit: 20 }, 'interactive'),
    ]);
    assert.ok(first.every(result => result.status === 'rejected' && result.reason.code === 'PREPARING'));
    while (!firstEntered && f.service.preparing) await yieldForeground();
    assert.equal(firstEntered, true);
    const oldFlight = f.service.refresh(); void oldFlight.catch(() => undefined);
    f.change(1, { title: '新歌', album: '七里香', artist: '陈奕迅', artists: ['陈奕迅'], albumArtists: ['陈奕迅'] });
    releaseFirst();
    await assert.rejects(oldFlight, error => {
      assert.ok(error instanceof LocalAlbumReadError || error instanceof LocalArtistSearchError);
      assert.equal(error.code, 'SNAPSHOT_CHANGED');
      assert.ok(reason === 'port' ? error instanceof LocalAlbumReadError : error instanceof LocalArtistSearchError);
      return true;
    });
    while (f.service.preparing) await yieldForeground();
    assert.equal(refreshes, 1); assert.equal(reads, 1, '旧任务失效后不在内部无限重试。');
    const nextQuery = { query: 'chenyixun', offset: 0, limit: 20 };
    const next = await Promise.allSettled([
      f.service.queryArtists(nextQuery, 'interactive'), f.service.search(nextQuery, 'interactive'),
    ]);
    assert.ok(next.every(result => result.status === 'rejected' && result.reason.code === 'PREPARING'), '下一轮交互必须能准备新快照，不能沿用旧快照失败。');
    while (!nextEntered && f.service.preparing) await yieldForeground();
    assert.equal(nextEntered, true); assert.equal(refreshes, 2, '两位读者须共享一个新任务。');
    releaseNext(); while (f.service.preparing) await yieldForeground();
    const [artists, search] = await Promise.all([f.service.queryArtists(nextQuery, 'interactive'), f.service.search(nextQuery, 'interactive')]);
    assert.equal(artists.items[0]?.name, '陈奕迅'); assert.equal(search.tracks.items[0]?.track.id, id(1));
    assert.notEqual(search.revision, originalRevision); assert.equal(search.revision, artists.revision);
  });
});

/** 原目录端口给出一页完整事实；虚拟时钟只模拟每条事实的处理成本，不依赖机器负载。 */
function batchFixture(directory: string, count = 80, groupCount = 4) {
  let revision = 1, highWater = 1, forceRebuild = false, clock = 0;
  let onTrack: ((processed: number) => void) | undefined, onAlbum: ((processed: number) => void) | undefined;
  const admitted = new Set<number>();
  let albumReads = 0;
  const group = (n: number) => (n - 1) % groupCount + 1;
  const summary = (n: number): LocalLibraryTrackSummary => ({
    track: { id: id(n), assetId: id(10_000 + n), selectionRevision: '1', segment: null },
    asset: { id: id(10_000 + n), libraryRootId: id(900_000), sourceRootId: id(900_001), rootRevision: '1',
      fileRevision: '1', locationRevision: '1', sampleFrames: null, timebaseHz: null },
    metadata: { title: `第${revision}版歌曲${n}`, album: `合成专辑${group(n)}`, artist: `合成艺人${n}`,
      artists: [`合成艺人${n}`], albumArtist: '合成专辑艺人', albumArtists: ['合成专辑艺人'] },
    versionTokens: [],
  });
  const album = (n: number): LocalAlbumSummary => ({ id: `batch-album-${n}`, kind: 'source-directory', rootId: id(900_000),
    editionId: null, title: `合成专辑${n}`, artists: ['合成专辑艺人'], year: null, versionLabel: null,
    trackCount: Array.from({ length: count }, (_, i) => i + 1).filter(track => group(track) === n).length,
    representativeTrackId: id(n), revision: `batch-album-${n}-${revision}`, artworkAvailable: false,
    artworkState: 'missing', statuses: ['missing-artwork'] });
  const current = (request: LocalAlbumSqlMobileQuery) => {
    if (request.kind === 'groups') {
      const values = Array.from({ length: groupCount }, (_, i) => i + 1).filter(n => request.albumKey === null || request.albumKey === `batch-album-${n}`);
      if (request.albumKey !== null) { clock += 4; onAlbum?.(++albumReads); }
      return { revision: `batch-${revision}`, total: values.length, items: values.slice(request.offset, request.offset + request.limit)
        .map(n => ({ album: album(n), groupHash: hash(n), artworkSourceRevision: hash(['artwork', n]), member: null })) };
    }
    const values = Array.from({ length: count }, (_, i) => i + 1).filter(n => request.trackId === null || request.trackId === id(n));
    const items: LocalAlbumSqlMobileRow[] = values.slice(request.offset, request.offset + request.limit).map(n => {
      const facts = summary(n);
      const fact = { relative: `album-${group(n)}/track-${n}.flac`, rawMetadata: facts.metadata, hasArtwork: false, artworkRevision: null,
        get summary() {
          if (!admitted.has(n)) { admitted.add(n); clock += 4; onTrack?.(admitted.size); }
          return facts;
        } };
      return { album: album(group(n)), groupHash: hash(group(n)), artworkSourceRevision: hash(['artwork', group(n)]),
        member: { fact, sequence: n, disc: null, trackNumber: null, editionLink: null, statuses: [] } };
    });
    return { revision: `batch-${revision}`, total: values.length, items };
  };
  const localAlbums = { privateMobile: { refresh: async () => {}, revision: () => `batch-${revision}`, current } } as unknown as LocalAlbumOwnerService;
  const collection = { localCatalog: { privateArtistSearchChanges: (after: number) => ({ highWater,
    rebuild: after === 0 || forceRebuild, trackIds: after < highWater ? Array.from({ length: count }, (_, i) => id(i + 1)) : [] }) } } as unknown as CollectionRepository;
  const service = createLocalArtistSearchService({ directory, collection, localAlbums, assertCurrent() {} });
  const persisted = () => {
    const db = new DatabaseSync(path.join(directory, 'catalog.sqlite'), { readOnly: true });
    try {
      return { source: String(db.prepare("SELECT value FROM state WHERE key='source'").get()?.value ?? ''),
        tracks: Number(db.prepare('SELECT count(*) n FROM tracks').get()!.n),
        title: String(db.prepare('SELECT json_extract(payload,\'$.metadata.title\') title FROM tracks ORDER BY id LIMIT 1').get()?.title ?? '') };
    } finally { db.close(); }
  };
  return { service, persisted, now: () => clock, processed: () => admitted.size, albumReads: () => albumReads,
    observeTracks(callback: typeof onTrack) { onTrack = callback; }, observeAlbums(callback: typeof onAlbum) { onAlbum = callback; },
    change(rebuild = false) { revision++; highWater++; forceRebuild = rebuild; admitted.clear(); albumReads = 0; },
    foregroundPage: () => ({ revision: `batch-${revision}`, title: summary(1).metadata.title }) };
}

test('一页大批索引处理中可响应无关原库前台任务，派生结果只在完整提交后可见', async t => {
  const directory = temporaryDirectory(), f = batchFixture(directory);
  t.after(async () => { await f.service.close(); rmSync(directory, { recursive: true, force: true }); });
  t.mock.method(performance, 'now', f.now);
  let observed: { processed: number; preparing: boolean; page: ReturnType<typeof f.foregroundPage>; saved: ReturnType<typeof f.persisted> } | undefined;
  f.observeTracks(processed => { if (processed === 1) setImmediate(() => {
    observed = { processed: f.processed(), preparing: f.service.preparing, page: f.foregroundPage(), saved: f.persisted() };
  }); });
  await f.service.refresh(); await yieldForeground();
  assert.ok(observed);
  assert.ok(observed.processed > 0 && observed.processed < 80, '前台任务须在本页事实尚未处理完时得到执行机会');
  assert.equal(observed.preparing, true); assert.equal(observed.page.title, '第1版歌曲1');
  assert.deepEqual(observed.saved, { source: '', tracks: 0, title: '' });
  assert.equal(f.persisted().tracks, 80);
  assert.equal((await f.service.queryArtists({ query: '', offset: 0, limit: 100 })).total, 81);
});

test('增量专辑摘要更新也让出前台任务，外部读取仍保持上次完整索引', async t => {
  const directory = temporaryDirectory(), f = batchFixture(directory, 60, 60);
  t.after(async () => { await f.service.close(); rmSync(directory, { recursive: true, force: true }); });
  t.mock.method(performance, 'now', f.now);
  await f.service.refresh(); const previous = f.persisted(); f.change();
  let observed: { processed: number; preparing: boolean; saved: ReturnType<typeof f.persisted> } | undefined;
  f.observeAlbums(processed => { if (processed === 1) setImmediate(() => {
    observed = { processed: f.albumReads(), preparing: f.service.preparing, saved: f.persisted() };
  }); });
  await f.service.refresh(); await yieldForeground();
  assert.ok(observed);
  assert.ok(observed.processed > 0 && observed.processed < 60, '增量专辑摘要循环须在批内让出，不能等全部专辑完成');
  assert.equal(observed.preparing, true); assert.deepEqual(observed.saved, previous);
  assert.equal(f.persisted().title, '第2版歌曲1');
});

test('批内前台关闭或修订变化会中止准备，旧成功索引不被部分结果替换', async t => {
  for (const reason of ['close', 'revision'] as const) await t.test(reason === 'close' ? '关闭' : '修订变化', async sub => {
    const directory = temporaryDirectory(), f = batchFixture(directory);
    sub.after(async () => { await f.service.close(); rmSync(directory, { recursive: true, force: true }); });
    sub.mock.method(performance, 'now', f.now);
    await f.service.refresh(); const previous = f.persisted(); f.change(true);
    let closing: Promise<void> | undefined, intervened = false;
    f.observeTracks(processed => { if (processed === 1) setImmediate(() => {
      intervened = true;
      if (reason === 'close') closing = f.service.close(); else f.change(true);
    }); });
    await assert.rejects(f.service.refresh(), { code: reason === 'close' ? 'CLOSED' : 'SNAPSHOT_CHANGED' });
    await closing; await yieldForeground();
    assert.equal(intervened, true); assert.deepEqual(f.persisted(), previous);
    if (reason === 'revision') {
      f.observeTracks(undefined); await f.service.refresh();
      assert.equal(f.persisted().tracks, 80); assert.equal(f.persisted().title, '第3版歌曲1');
    }
  });
});
