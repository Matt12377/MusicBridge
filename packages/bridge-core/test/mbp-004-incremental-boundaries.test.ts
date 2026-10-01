import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRoonLibraryService,
  type RoonBrowseApi,
  type RoonEntityDescriptor,
} from '../src/roon/library.js';
import { withLibraryRead } from '../src/shared/library-read-lifetime.js';

type Row = { title: string; hint: string; subtitle?: string; child?: string };
type Node = { rows: Row[]; unknown?: boolean };
type Load = { key: string; node: string; offset: number; count: number; returned: number };
type Callback = Parameters<RoonBrowseApi['load']>[1];
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const track = (title: string): Row => ({ title, subtitle: '合成艺人', hint: 'action_list' });
const album = (title: string): Row => ({ title, subtitle: '合成艺人', hint: 'list' });
const header = (title = '分类标题'): Row => ({ title, hint: 'header' });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

// 使用真实Service；这里只替换不可重复的Browse SDK，按每个真实session分别保存路径。
function fixture(kind: 'album' | 'playlist' | 'artist', details: Node, extra: Record<string, Node> = {}) {
  const nodes: Record<string, Node> = { root: { rows: [{ title: '稳定实体', hint: 'list', child: 'detail' }] }, detail: details, ...extra };
  const paths = new Map<string, string[]>();
  const keys = new Map<string, { node: string; index: number }>();
  const loads: Load[] = [];
  const browses: Array<{ key: string; node: string; itemKey?: string }> = [];
  const actions: Array<{ key: string; title: string; zone: unknown }> = [];
  let zone = '合成Zone-A';
  let failNextNode: string | undefined;
  let holdNextNode: string | undefined;
  let held: { callback: Callback; body: { offset: number; items: unknown[] }; load: Load } | undefined;
  let maximumReturned = Number.POSITIVE_INFINITY;
  let wrongNextOffset = false;
  const rowsFor = (node: string, key: string, offset: number, count: number) => nodes[node]!.rows
    .slice(offset, offset + Math.min(count, maximumReturned))
    .map((row, i) => {
      const index = offset + i;
      const itemKey = `${key}/${node}/${index}`;
      keys.set(itemKey, { node, index });
      const { child: _child, ...visible } = row;
      return { ...visible, ...(row.hint === 'header' ? {} : { item_key: itemKey }) };
    });
  const browse: RoonBrowseApi = {
    browse(options, callback) {
      const key = String(options.multi_session_key);
      let path = paths.get(key) ?? ['root'];
      if (options.pop_all) path = ['root'];
      else if (options.pop_levels) path = path.slice(0, Math.max(1, path.length - Number(options.pop_levels)));
      else if (options.item_key) {
        const itemKey = String(options.item_key);
        const location = keys.get(itemKey);
        assert.ok(location, '派发只能使用SDK真实提供过的item_key');
        assert.equal(itemKey.startsWith(`${key}/`), true, '稳定重定位必须取得本session的新key');
        const row = nodes[location.node]!.rows[location.index]!;
        if (row.hint === 'action') {
          actions.push({ key, title: row.title, zone: options.zone_or_output_id });
          callback(false, { action: 'none' });
          return;
        }
        let child = row.child;
        if (!child) {
          child = `actions:${location.node}:${location.index}`;
          nodes[child] = { rows: [{ title: 'Play Now', hint: 'action' }, { title: 'Add Next', hint: 'action' }] };
        }
        path = [...path, child];
      }
      paths.set(key, path);
      const node = path.at(-1)!;
      browses.push({ key, node, ...(options.item_key ? { itemKey: String(options.item_key) } : {}) });
      callback(false, { action: 'list', list: { level: path.length - 1, ...(nodes[node]!.unknown ? {} : { count: nodes[node]!.rows.length }) } });
    },
    load(options, callback) {
      const key = String(options.multi_session_key);
      const node = paths.get(key)?.at(-1);
      assert.ok(node);
      assert.equal(options.level, paths.get(key)!.length - 1, 'load不能读取另一层的raw索引');
      const offset = Number(options.offset), count = Number(options.count);
      const items = rowsFor(node, key, offset, count);
      const load = { key, node, offset, count, returned: items.length };
      loads.push(load);
      if (failNextNode === node) { failNextNode = undefined; callback('合成普通分页失败', undefined); return; }
      const body = { offset: wrongNextOffset ? offset + 1 : offset, items };
      wrongNextOffset = false;
      if (holdNextNode === node) { holdNextNode = undefined; held = { callback, body, load }; return; }
      callback(false, body);
    },
  };
  const service = createRoonLibraryService({ browse, image: { get_image() {} }, zoneOrOutputId: () => zone, requestTimeoutMs: 100 });
  const root = async () => (kind === 'album' ? await service.browseAlbums({ offset: 0, limit: 1 })
    : kind === 'artist' ? await service.browseArtists({ offset: 0, limit: 1 })
      : await service.browsePlaylists({ offset: 0, limit: 1 })).items[0]!;
  const read = (entity: RoonEntityDescriptor, offset = 0, limit = 4) => kind === 'album'
    ? service.browseAlbum(entity, { offset, limit })
    : kind === 'artist' ? service.browseArtist(entity, { offset, limit })
      : service.browsePlaylist(entity, { offset, limit });
  return {
    service, nodes, loads, browses, actions, root, read,
    shortPages: (maximum: number) => { maximumReturned = maximum; },
    wrongOffset: () => { wrongNextOffset = true; },
    fail: (node = 'detail') => { failNextNode = node; },
    hold: (node = 'detail') => { holdNextNode = node; },
    held: () => { assert.ok(held); return held; },
    release: (items?: unknown[]) => { const current = held; assert.ok(current); held = undefined; current.callback(false, { ...current.body, ...(items ? { items } : {}) }); },
    zone: (value: string) => { zone = value; },
  };
}

async function allPages(f: ReturnType<typeof fixture>, entity: RoonEntityDescriptor, limit = 4) {
  const items: RoonEntityDescriptor[] = [];
  let offset = 0, epoch: string | undefined;
  for (let attempts = 0; attempts < 100; attempts++) {
    const page = await f.read(entity, offset, limit);
    assert.match(page.sourceEpoch ?? '', UUID);
    epoch ??= page.sourceEpoch;
    assert.equal(page.sourceEpoch, epoch, '同一遍历不能混代');
    assert.equal(page.offset, offset);
    items.push(...page.items);
    if (!page.hasMore) return { items, last: page };
    assert.ok(page.nextOffset !== undefined && page.nextOffset > offset, '有效详情游标必须前进');
    offset = page.nextOffset;
  }
  assert.fail('分页不得无限循环');
}

for (const kind of ['album', 'playlist', 'artist'] as const) {
  for (const size of [50, 500, 5000]) {
    test(`MBP004独立：${kind}的${size}项同形首屏按需读取，调用不随总数线性增`, async t => {
      const rows = Array.from({ length: size }, (_, i) => kind === 'artist' ? album(`专辑${i}`) : track(`曲目${i}`));
      const f = kind === 'artist'
        ? fixture(kind, { rows: [{ title: 'Albums', hint: 'list', child: 'albums' }, ...Array.from({ length: size - 1 }, () => header())] }, { albums: { rows } })
        : fixture(kind, { rows });
      const entity = await f.root();
      const before = f.loads.length;
      const page = await f.read(entity, 0, 4);
      const detailLoads = f.loads.slice(before);
      t.diagnostic(`首屏证据：${kind}/${size}，SDK load ${detailLoads.length}次，实际raw ${detailLoads.reduce((sum, load) => sum + load.returned, 0)}行`);
      assert.deepEqual(page.items.map(item => item.title), rows.slice(0, 4).map(row => row.title));
      assert.ok(detailLoads.length <= 6, `首屏仅有限raw页，实际${detailLoads.length}`);
      assert.ok(detailLoads.reduce((sum, load) => sum + load.returned, 0) <= 200, '首屏不能全遍历');
      assert.match(page.sourceEpoch ?? '', UUID);
      assert.equal(page.nextOffset, 4);
      assert.equal(page.hasMore, true);
    });
  }
}

test('MBP004独立：稀疏header与短raw页逐条消费，重复出现不被去重，未知total到真实EOF才完整', async () => {
  const repeated = track('重复出现');
  const f = fixture('album', { unknown: true, rows: [header('Disc 1'), header(), repeated, header(), repeated, ...Array.from({ length: 9 }, () => header()), track('最后曲目')] });
  f.shortPages(2);
  const result = await allPages(f, await f.root(), 1);
  assert.deepEqual(result.items.map(item => item.title), ['重复出现', '重复出现', '最后曲目']);
  assert.deepEqual(result.items.map(item => item.browseContext?.sourceIndex), [2, 4, 14]);
  assert.notEqual(result.items[0]?.browseContext?.pathSignature, result.items[1]?.browseContext?.pathSignature);
  assert.equal(result.last.complete, true);
  assert.equal(result.last.total, 3);
  assert.equal(result.last.hasMore, false);
  assert.ok(f.loads.some(load => load.node === 'detail' && load.offset === 15 && load.returned === 0), '未知total必须收到真实空尾');
});

test('MBP004独立：未知总数首屏不伪造total，已全遍历缓存首页complete可true且hasMore仍true', async () => {
  const f = fixture('playlist', { unknown: true, rows: Array.from({ length: 300 }, (_, i) => track(`曲目${i}`)) });
  const entity = await f.root();
  const first = await f.read(entity, 0, 2);
  assert.equal(first.complete, false);
  assert.equal(first.total, undefined);
  const result = await allPages(f, entity, 4);
  assert.equal(result.items.length, 300);
  const before = f.loads.length;
  const cachedFirst = await f.read(entity, 0, 2);
  assert.equal(cachedFirst.complete, true);
  assert.equal(cachedFirst.hasMore, true);
  assert.equal(cachedFirst.total, 300);
  assert.equal(f.loads.length, before, '完整缓存首页不得重读SDK');
});

test('MBP004独立：多碟DFS按层raw索引保持身份，播放重定位不把有效offset当raw', async () => {
  const f = fixture('album', { rows: [{ title: 'Disc 1', hint: 'list', child: 'disc1' }, { title: 'Disc 2', hint: 'list', child: 'disc2' }] }, {
    disc1: { rows: [header('Disc 1'), track('第一碟同名'), track('第一碟尾')] },
    disc2: { rows: [header('Disc 2'), header(), track('第二碟同名')] },
  });
  f.shortPages(1);
  const result = await allPages(f, await f.root(), 1);
  assert.deepEqual(result.items.map(item => [item.title, item.discNumber, item.browseContext?.sourceIndex]), [['第一碟同名', 1, 1], ['第一碟尾', 1, 2], ['第二碟同名', 2, 2]]);
  const before = f.loads.length;
  await f.service.playTrack(result.items[2]!, '合成Zone-A');
  assert.ok(f.loads.slice(before).some(load => load.node === 'disc2' && load.offset === 2 && load.count === 1));
  assert.deepEqual(f.actions.map(action => action.title), ['Play Now']);
  assert.equal(f.actions[0]?.zone, '合成Zone-A');
});

for (const grouped of [false, true]) {
  test(`MBP004独立：艺人同metadata ${grouped ? '最后才出现Albums组优先' : '无组保留121个direct专辑'}，不以元数据猜分类`, async () => {
    const direct = Array.from({ length: 121 }, (_, i) => album(`直接专辑${i}`));
    const f = fixture('artist', { rows: grouped ? [...direct, { title: 'Albums', hint: 'list', child: 'group' }] : direct }, { group: { rows: [album('真正分组专辑')] } });
    const result = await allPages(f, await f.root(), 24);
    assert.deepEqual(result.items.map(item => item.title), grouped ? ['真正分组专辑'] : direct.map(item => item.title));
    assert.equal(result.last.complete, true);
    assert.equal(result.last.total, grouped ? 1 : 121);
  });
}

test('MBP004独立：普通load失败不推进checkpoint，重试原raw位置且不换epoch', async () => {
  const f = fixture('album', { rows: Array.from({ length: 500 }, (_, i) => track(`曲目${i}`)) });
  const entity = await f.root();
  const first = await f.read(entity, 0, 4);
  assert.match(first.sourceEpoch ?? '', UUID);
  const offset = first.nextOffset!;
  // 消费缓存直到下一次真实raw读取，避免把SDK分块大小写成测试合同。
  f.fail();
  let cursor = offset;
  let failedCursor = -1;
  for (let i = 0; i < 30; i++) {
    try { const page = await f.read(entity, cursor, 4); assert.equal(page.hasMore, true); cursor = page.nextOffset!; }
    catch (error) {
      assert.equal((error as { code?: string }).code, 'ROON_LIBRARY_REQUEST_FAILED', '只把真实SDK分页失败视作恢复测试的故障');
      failedCursor = cursor; break;
    }
  }
  assert.ok(failedCursor >= 0);
  const failed = f.loads.at(-1)!;
  const resumed = await f.read(entity, failedCursor, 4);
  assert.equal(resumed.sourceEpoch, first.sourceEpoch);
  assert.equal(resumed.items[0]?.title, `曲目${failedCursor}`);
  assert.ok(f.loads.slice(f.loads.indexOf(failed) + 1).some(load => load.node === failed.node && load.offset === failed.offset), '错误页必须从同raw checkpoint重试');
});

test('MBP004独立：错误实际offset拒绝且不提交错误页，修复SDK后原游标可恢复', async () => {
  const f = fixture('album', { rows: Array.from({ length: 12 }, (_, i) => track(`曲目${i}`)) });
  const entity = await f.root();
  f.wrongOffset();
  await assert.rejects(f.read(entity, 0, 4), '实际offset与请求不一致必须拒绝');
  const recovered = await f.read(entity, 0, 4);
  assert.deepEqual(recovered.items.map(item => item.title), ['曲目0', '曲目1', '曲目2', '曲目3']);
  assert.equal(recovered.items[0]?.browseContext?.sourceIndex, 0);
});

test('MBP004独立：root下一游标消费raw过滤行，详情有效游标不倒灌SDK', async () => {
  const f = fixture('album', { rows: [] });
  f.nodes.root!.rows = [header(), album('可见专辑'), header(), album('同名专辑'), album('同名专辑')];
  const first = await f.service.browseAlbums({ offset: 0, limit: 3 });
  assert.equal(first.items.length, 1);
  assert.equal(first.nextOffset, 3);
  assert.equal(first.complete, false);
  assert.equal(first.items[0]?.browseContext?.sourceIndex, 1);
  const second = await f.service.browseAlbums({ offset: first.nextOffset!, limit: 3 });
  assert.deepEqual(second.items.map(item => item.title), ['同名专辑', '同名专辑']);
  assert.deepEqual(second.items.map(item => item.browseContext?.sourceIndex), [3, 4]);
  assert.equal(second.nextOffset, 5);
  assert.equal(second.complete, true);
  assert.equal(second.hasMore, false);
  assert.equal(second.sourceEpoch, first.sourceEpoch);
});

test('MBP004独立：未知总数root过滤短有效页仍可续读，真实空raw页才结束', async () => {
  const f = fixture('album', { rows: [] });
  f.nodes.root = { unknown: true, rows: [header(), album('中间专辑'), header(), album('尾专辑')] };
  const first = await f.service.browseAlbums({ offset: 0, limit: 3 });
  assert.equal(first.total, undefined);
  assert.equal(first.complete, false);
  assert.equal(first.nextOffset, 3);
  assert.equal(first.hasMore, true, '没有total时也必须保留可继续读取的公开入口');
  const lastItem = await f.service.browseAlbums({ offset: first.nextOffset!, limit: 3 });
  assert.equal(lastItem.items[0]?.title, '尾专辑');
  assert.equal(lastItem.complete, false, '短raw页不能冒充未知列表EOF');
  assert.equal(lastItem.hasMore, true);
  const eof = await f.service.browseAlbums({ offset: lastItem.nextOffset!, limit: 3 });
  assert.equal(eof.items.length, 0);
  assert.equal(eof.nextOffset, 4);
  assert.equal(eof.complete, true);
  assert.equal(eof.hasMore, false);
  assert.equal(eof.sourceEpoch, first.sourceEpoch);
});

test('MBP004独立：playlist根direct先于前置Tracks组，组条目不替换同名重复项', async () => {
  const f = fixture('playlist', { rows: [{ title: 'Tracks', hint: 'list', child: 'group' }, track('根同名'), track('根尾')] }, {
    group: { rows: [track('根同名'), track('组尾')] },
  });
  const result = await allPages(f, await f.root(), 1);
  assert.deepEqual(result.items.map(item => item.title), ['根同名', '根尾', '根同名', '组尾']);
  assert.equal(new Set(result.items.map(item => item.browseContext?.pathSignature)).size, 4);
});

for (const reason of ['cancel', 'timeout', 'invalidate', 'zone'] as const) {
  test(`MBP004独立：${reason}废弃未完成详情，旧结果零commit、新UUID与session、旧finally不伤新读取`, async t => {
    if (reason === 'timeout') t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture('album', { rows: Array.from({ length: 500 }, (_, i) => track(`当前曲目${i}`)) });
    const entity = await f.root();
    const first = await f.read(entity, 0, 1);
    assert.match(first.sourceEpoch ?? '', UUID);
    f.hold();
    const controller = new AbortController();
    const lifetime = { signal: controller.signal, deadlineAtMs: Date.now() + 5000, now: Date.now, isCurrent: () => true };
    // 跳到尚未扫描的末端以保证真实SDK work在途。
    const old = withLibraryRead(lifetime, () => f.read(entity, 400, 1));
    const rejected = assert.rejects(old);
    await turn();
    const oldKey = f.held().load.key;
    if (reason === 'cancel') controller.abort();
    if (reason === 'timeout') t.mock.timers.tick(101);
    if (reason === 'invalidate') { assert.equal(typeof f.service.invalidateReadContexts, 'function'); f.service.invalidateReadContexts!(); }
    if (reason === 'zone') f.zone('合成Zone-B');
    if (reason === 'cancel' || reason === 'timeout') await rejected;
    // 显式失效允许旧reference明确过期；重新读取根实体取得当前授权，不要求复活旧路径。
    if (reason === 'invalidate') await assert.rejects(f.read(entity, 0, 1), /stale/u);
    const currentEntity = reason === 'invalidate' ? await f.root() : entity;
    const fresh = f.read(currentEntity, 0, 1);
    await turn();
    f.release([{ title: '旧代恶意迟到曲目', subtitle: '旧代艺人', item_key: `${oldKey}/late/0`, hint: 'action_list' }]);
    await rejected;
    const current = await fresh;
    assert.notEqual(current.sourceEpoch, first.sourceEpoch);
    assert.match(current.sourceEpoch ?? '', UUID);
    assert.equal(current.items[0]?.title, '当前曲目0');
    assert.notEqual(current.items[0]?.browseContext?.multiSessionKey, oldKey);
    const cached = await f.read(currentEntity, 0, 1);
    assert.equal(cached.sourceEpoch, current.sourceEpoch);
    assert.equal(cached.items[0]?.title, '当前曲目0');
    assert.equal(f.actions.length, 0, '只读不得派发播放');
  });
}
