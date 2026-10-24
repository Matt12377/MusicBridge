import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { MOBILE_OPERATION_TABLE, mobileCanonicalJson } from '@music-bridge/contracts';
import type { MobileJsonValue } from '@music-bridge/contracts';
import { createActualMobileNeteasePorts } from '../../src/netease/mobile-actual-ports.js';
import { createMobileContentProviderService, type MobileNeteaseContentOperation } from '../../src/mobile/content-provider-service.js';
import { captureMobileContentRequest } from '../../src/mobile/content-protocol.js';
import { projectMobileReadResponse } from '../../src/netease/mobile-read-response.js';
import { createMobileContentCursorCodec } from '../../src/mobile/content-cursor.js';
import { MobileServiceError } from '../../src/mobile/types.js';
import type { NeteaseMobileAccountInvalidation, NeteaseMobileReadPort, NeteaseMobileReadRequest } from '../../src/netease/types.js';

const signal = () => new AbortController().signal;
const changed = (e: unknown) => e instanceof MobileServiceError && e.status === 409 && e.code === 'SOURCE_CHANGED';
const busy = (e: unknown) => e instanceof MobileServiceError && e.status === 503 && e.code === 'BUSY';
function request<O extends MobileNeteaseContentOperation>(operation: O, query: Record<string, string | number> = {}, pathParameters: Record<string, string> = {}) {
  return captureMobileContentRequest(operation, { path: MOBILE_OPERATION_TABLE[operation].path.replace('{collectionId}', encodeURIComponent(pathParameters.collectionId ?? '')),
    pathParameters, query, body: null });
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function fixture(t: TestContext) {
  let feed = ['9', '10', '11', '12'], revoked = false, epoch = 'epoch-1', active = 0, peak = 0;
  let held: { id: string; entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
  const gates: { release: ReturnType<typeof deferred> }[] = [], calls: NeteaseMobileReadRequest[] = [];
  const details = new Map<string, Record<string, unknown>>(), errors = new Map<string, unknown>(), codes = new Map<string, number>();
  const listeners = new Set<(event: NeteaseMobileAccountInvalidation) => void>();
  for (const id of feed) details.set(id, { id, name: `合成歌单${id}`, trackCount: 2, trackIds: [{ id: '1' }, { id: '2' }], specialType: 5, creator: { userId: '700' } });
  const client: NeteaseMobileReadPort = { configured: true, async mobileAccount() { return { accountId: '700', providerEpoch: epoch }; },
    onMobileAccountInvalidated(listener) { listeners.add(listener); return () => listeners.delete(listener); }, async awaitMobileQuiet() {},
    async mobileRead(r) {
      calls.push(r); active++; peak = Math.max(peak, active);
      try {
        await Promise.resolve(); let body: unknown;
        if (r.operation === 'recommended-playlists') body = { code: 200, result: feed.map(id => ({ id })) };
        else if (r.operation === 'charts') body = { code: 200, list: feed.map(id => ({ id })) };
        else if (r.operation === 'user-playlists') body = { code: 200, more: false, playlist: [{ id: '9', specialType: 5, creator: { userId: '700' } }] };
        else if (r.operation === 'playlist-detail') {
          if (held?.id === r.id) { const gate = held; held = undefined; gate.entered.resolve(); await gate.release.promise; }
          if (errors.has(r.id)) throw errors.get(r.id);
          body = { code: codes.get(r.id) ?? 200, playlist: details.get(r.id) };
        } else throw new Error('推荐卡片测试禁止音频、曲目或其他真实读取');
        return { providerEpoch: epoch, response: projectMobileReadResponse({ body }, r.operation) };
      } finally { active--; }
    } };
  const actual = createActualMobileNeteasePorts({ client, serverId: 'server-1', datasetId: 'dataset-1', ownerEpoch: 'owner-1',
    identityKey32: new Uint8Array(32).fill(31), now: () => 1700000000000,
    async assertCurrent() { if (revoked) throw new MobileServiceError(403, 'RESOURCE_REVOKED'); } });
  const account = await actual.account.current(signal()); assert.ok(account);
  const scope = { serverId: 'server-1', datasetId: 'dataset-1', ownerEpoch: 'owner-1', deviceId: 'device-1', deviceEpoch: 1, accessGeneration: 1, ...account };
  const provider = createMobileContentProviderService({ provider: actual.provider, cursorKey: new Uint8Array(32).fill(17), now: () => 1700000000000,
    assertCurrent: value => actual.assertCurrent(value, 'acquire', signal()) });
  t.after(async () => { for (const gate of gates) gate.release.resolve(); provider.close(); await actual.close(); });
  return { actual, provider, scope, calls, peak: () => peak,
    read: (cursor?: string, owned = signal(), limit = 2) => provider.dispatch({ operation: 'listNeteaseRecommendedPlaylists',
      request: request('listNeteaseRecommendedPlaylists', { limit, ...(cursor ? { cursor } : {}) }), scope, signal: owned }),
    detail(id: string, extra: Record<string, unknown>) { const next = { ...details.get(id), ...extra };
      for (const [key, value] of Object.entries(next)) if (value === undefined) delete next[key]; details.set(id, next); },
    feed(ids: string[]) { feed = ids; }, fail(id: string, error: unknown) { errors.set(id, error); }, code(id: string, code: number) { codes.set(id, code); },
    revoke() { revoked = true; }, accountChange() { epoch = 'epoch-2'; for (const listener of listeners) listener({ previousProviderEpoch: 'epoch-1', nextProviderEpoch: epoch }); },
    block(id = '9') { const gate = { id, entered: deferred(), release: deferred() }; held = gate; gates.push(gate); return gate; } };
}

function seedRecommendations(f: Awaited<ReturnType<typeof fixture>>, count: number): string[] {
  const ids = Array.from({ length: count }, (_, index) => String(100 + index)); f.feed(ids);
  for (const id of ids) f.detail(id, { id, name: `合成歌单${id}`, trackCount: 2, trackIds: [{ id: '1' }, { id: '2' }] });
  return ids;
}

// 冻结H及K20的旧修订公式，仅用于构造同一合成密钥签发的真实旧策略游标。
function legacyFeedRevision(kind: 'playlist' | 'chart', facts: unknown, candidateLimit?: number): string {
  const material = candidateLimit === undefined ? [kind, facts] : [kind, 'recommended-bounded-v1', candidateLimit, facts];
  return 'nr:' + createHmac('sha256', new Uint8Array(32).fill(31)).update('MusicBridge:MBM004:NETEASE_COLLECTION_FEED:1\0')
    .update(mobileCanonicalJson(material as MobileJsonValue)).digest('hex');
}

test('推荐K10：正式请求固定10候选，完整资格化后普通iOS容量10单页结束', async t => {
  const f = await fixture(t), ids = seedRecommendations(f, 10);
  const page = await f.read(undefined, signal(), 10);
  assert.deepEqual(page.reply.body.items.map(v => v.title), ids.map(id => `合成歌单${id}`));
  assert.equal(page.reply.body.nextCursor, null, '本批至多10候选，普通手机自动全页不会另发续页');
  assert.equal(f.calls.filter(v => v.operation === 'playlist-detail').length, 10);
  assert.deepEqual(f.calls.filter(v => v.operation === 'recommended-playlists'), [{ operation: 'recommended-playlists', limit: 10 }]);
  assert.ok(f.peak() <= 2); await page.beforeSend();
});

test('推荐K10：公开更小limit仍按完整合格集合签发游标，两页无遗漏重复', async t => {
  const f = await fixture(t), ids = seedRecommendations(f, 10);
  const first = await f.read(undefined, signal(), 5); assert.equal(first.reply.body.items.length, 5); assert.ok(first.reply.body.nextCursor);
  assert.equal(f.calls.filter(v => v.operation === 'playlist-detail').length, 10);
  const second = await f.read(first.reply.body.nextCursor, signal(), 5);
  assert.equal(second.reply.body.items.length, 5); assert.equal(second.reply.body.nextCursor, null);
  assert.deepEqual([...first.reply.body.items, ...second.reply.body.items].map(v => v.title), ids.map(id => `合成歌单${id}`));
  assert.equal(new Set([...first.reply.body.items, ...second.reply.body.items].map(v => v.id)).size, 10);
  assert.equal(first.reply.body.feedRevision, second.reply.body.feedRevision);
  assert.equal(f.calls.filter(v => v.operation === 'playlist-detail').length, 20, '每次请求恰核10详情，不漏核尾页');
  const upstream = f.calls.filter(v => v.operation === 'recommended-playlists');
  assert.equal(upstream.length, 2); assert.ok(upstream.every(v => v.limit === 10)); assert.ok(f.peak() <= 2);
});

test('推荐K10：局部坏卡过滤后更小limit仍按完整合格顺序分页，不补全或假报总数', async t => {
  const f = await fixture(t), ids = seedRecommendations(f, 10), bad = new Set(['101', '104', '108']);
  for (const id of bad) f.detail(id, { trackCount: 3 });
  const first = await f.read(undefined, signal(), 5); assert.equal(first.reply.body.items.length, 5); assert.ok(first.reply.body.nextCursor);
  const second = await f.read(first.reply.body.nextCursor, signal(), 5); assert.equal(second.reply.body.items.length, 2);
  assert.deepEqual([...first.reply.body.items, ...second.reply.body.items].map(v => v.title), ids.filter(id => !bad.has(id)).map(id => `合成歌单${id}`));
  assert.equal(new Set([...first.reply.body.items, ...second.reply.body.items].map(v => v.id)).size, 7);
  assert.equal(second.reply.body.nextCursor, null); assert.equal(first.reply.body.feedRevision, second.reply.body.feedRevision);
  assert.equal(f.calls.filter(v => v.operation === 'playlist-detail').length, 20);
});

test('推荐K10：上游超出10直接拒绝，不截断、不读取详情也不伪造空页', async t => {
  for (const count of [11, 20, 100]) await t.test(String(count), async child => {
    const f = await fixture(child); seedRecommendations(f, count); await assert.rejects(f.read(), busy);
    assert.equal(f.calls.filter(v => v.operation === 'playlist-detail').length, 0);
    assert.deepEqual(f.calls.filter(v => v.operation === 'recommended-playlists'), [{ operation: 'recommended-playlists', limit: 10 }]);
  });
});

test('推荐K10：未显示尾项成员或资格变化及集合缩短仍使旧cursor先SOURCE_CHANGED', async t => {
  for (const kind of ['members', 'eligibility', 'shrink'] as const) await t.test(kind, async child => {
    const f = await fixture(child), ids = seedRecommendations(f, 10), first = await f.read(undefined, signal(), 5); assert.ok(first.reply.body.nextCursor);
    if (kind === 'members') f.detail('109', { trackIds: [{ id: '2' }, { id: '1' }] });
    else if (kind === 'eligibility') f.detail('109', { trackCount: 3 }); else f.feed(ids.slice(0, 3));
    await assert.rejects(f.read(first.reply.body.nextCursor, signal(), 5), changed);
  });
});

test('推荐K10：同账户同集合的旧K20及旧100策略真实签名cursor拒绝，当前cursor仍可续页', async t => {
  const f = await fixture(t), all = await f.read(undefined, signal(), 100);
  const codec = createMobileContentCursorCodec({ key: new Uint8Array(32).fill(17), now: () => 1700000000000 }); t.after(() => codec.close());
  for (const oldRevision of [legacyFeedRevision('playlist', all.reply.body.items, 20), legacyFeedRevision('playlist', all.reply.body.items)]) {
    assert.notEqual(all.reply.body.feedRevision, oldRevision, '推荐修订必须显式绑定新策略及K');
    const oldCursor = codec.issue({ query: { scope: f.scope, operation: 'listNeteaseRecommendedPlaylists', source: 'netease', parentId: null,
      kind: null, filterHash: createHash('sha256').update(mobileCanonicalJson({ limit: 2 })).digest('hex'), sort: 'provider-order', limit: 2 },
      revision: oldRevision, offset: 2 });
    await assert.rejects(f.read(oldCursor), changed);
  }
  const first = await f.read(); assert.ok(first.reply.body.nextCursor);
  assert.equal((await f.read(first.reply.body.nextCursor)).reply.body.feedRevision, first.reply.body.feedRevision);
});

test('推荐K10：榜单仍允许超过20且其原完整feed修订公式不变', async t => {
  const f = await fixture(t); seedRecommendations(f, 21);
  const charts = await f.provider.dispatch({ operation: 'listNeteaseCharts', request: request('listNeteaseCharts', { limit: 100 }), scope: f.scope, signal: signal() });
  assert.equal(charts.reply.body.items.length, 21); assert.equal(charts.reply.body.nextCursor, null);
  assert.equal(charts.reply.body.feedRevision, legacyFeedRevision('chart', charts.reply.body.items.map(v => v.id)));
  assert.equal(f.calls.filter(v => v.operation === 'playlist-detail').length, 21);
  assert.equal(f.calls.filter(v => v.operation === 'recommended-playlists').length, 0);
});

test('推荐卡片：单项count不一致只移除该卡，合格序列第一页和续页无重复漏项', async t => {
  const f = await fixture(t); f.detail('10', { trackCount: 3 });
  const first = await f.read(); assert.equal(first.reply.status, 200); assert.deepEqual(first.reply.body.items.map(v => v.title), ['合成歌单9', '合成歌单11']);
  assert.ok(first.reply.body.nextCursor); const second = await f.read(first.reply.body.nextCursor);
  assert.deepEqual(second.reply.body.items.map(v => v.title), ['合成歌单12']); assert.equal(second.reply.body.nextCursor, null);
  assert.equal(first.reply.body.feedRevision, second.reply.body.feedRevision);
  const items = [...first.reply.body.items, ...second.reply.body.items]; assert.equal(new Set(items.map(v => v.id)).size, 3);
  assert.ok(items.every(v => v.trackCount === 2)); assert.equal(f.calls.filter(v => v.operation === 'playlist-detail').length, 8);
  assert.ok(f.peak() <= 2); await second.beforeSend();
});

test('推荐卡片：本次fresh详情局部资格错误隔离，但不伪造count或空卡', async t => {
  const variants: Record<string, unknown>[] = [{ trackCount: 3 }, { trackCount: -1 }, { trackIds: undefined },
    { trackIds: [{ id: '1' }, { id: '1' }] }, { trackIds: [{ id: '0' }, { id: '2' }] }, { id: '999' }, { name: '' }, { name: '坏\n标题' }];
  for (let index = 0; index < variants.length; index++) await t.test(String(index), async child => {
    const f = await fixture(child); f.feed(['9', '10']); f.detail('10', variants[index]!);
    const page = await f.read(); assert.deepEqual(page.reply.body.items.map(v => v.title), ['合成歌单9']);
    assert.equal(page.reply.body.items[0]!.trackCount, 2); assert.equal(page.reply.body.nextCursor, null);
  });
});

test('推荐卡片：全部候选失格仍拒绝；真实空feed才返回无游标的空页', async t => {
  const f = await fixture(t); f.feed(['10']); f.detail('10', { trackCount: 3 }); await assert.rejects(f.read(), changed);
  const empty = await fixture(t); empty.feed([]); const page = await empty.read(); assert.equal(page.reply.status, 200);
  assert.deepEqual(page.reply.body.items, []); assert.equal(page.reply.body.nextCursor, null);
  assert.equal(empty.calls.filter(v => v.operation === 'playlist-detail').length, 0);
});

test('推荐卡片：合格成员序列或其真实修订变化使旧cursor拒绝，持续失格项变化不污染序列', async t => {
  for (const kind of ['eligible', 'title', 'members', 'feed', 'shrink'] as const) await t.test(kind, async child => {
    const f = await fixture(child); f.detail('10', { trackCount: 3 }); const first = await f.read(); assert.ok(first.reply.body.nextCursor);
    if (kind === 'eligible') f.detail('10', { trackCount: 2 }); else if (kind === 'title') f.detail('9', { name: '新标题' });
    else if (kind === 'members') f.detail('9', { trackIds: [{ id: '2' }, { id: '1' }] }); else if (kind === 'shrink') f.feed(['9']); else f.feed(['12', '11', '10', '9']);
    await assert.rejects(f.read(first.reply.body.nextCursor), changed);
  });
  const f = await fixture(t); f.detail('10', { trackCount: 3 }); const first = await f.read(); f.detail('10', { name: '仍然失格的新标题' });
  assert.equal((await f.read(first.reply.body.nextCursor!)).reply.body.feedRevision, first.reply.body.feedRevision);
});

test('推荐卡片：API错误、登录、SDK投影及全局SOURCE_CHANGED不当成坏卡跳过', async t => {
  for (const kind of ['network', 'login', 'projection', 'global'] as const) await t.test(kind, async child => {
    const f = await fixture(child); f.feed(['9', '10']);
    if (kind === 'network') f.fail('10', new Error('合成网络失败')); else if (kind === 'login') f.code('10', 301);
    else if (kind === 'projection') f.detail('10', { trackIds: '损坏的SDK数组' }); else f.fail('10', new MobileServiceError(409, 'SOURCE_CHANGED'));
    await assert.rejects(f.read(), value => value instanceof MobileServiceError && (kind === 'login' ? value.status === 403
      : kind === 'global' ? changed(value) : busy(value)));
  });
});

test('推荐卡片：原10秒总deadline及取消、撤权、账户更换继续封闭输出', async t => {
  for (const kind of ['cancel', 'revoke', 'account'] as const) await t.test(kind, async child => {
    const f = await fixture(child), hold = f.block(), controller = new AbortController(); const read = assert.rejects(f.read(undefined, controller.signal));
    await hold.entered.promise; if (kind === 'cancel') controller.abort(); else if (kind === 'revoke') f.revoke(); else f.accountChange();
    hold.release.resolve(); await read;
  });
  const f = await fixture(t), hold = f.block(); t.mock.timers.enable({ apis: ['setTimeout'] });
  const read = assert.rejects(f.read(), busy); await hold.entered.promise; t.mock.timers.tick(10001); await read;
  hold.release.resolve(); await f.actual.close(); t.mock.timers.reset();
});

test('推荐卡片：chart/liked/成员读取的原严格count guard保留，beforeSend仍重验撤权', async t => {
  const f = await fixture(t); f.detail('10', { trackCount: 3 }); const page = await f.read();
  await assert.rejects(f.provider.dispatch({ operation: 'listNeteaseCharts', request: request('listNeteaseCharts'), scope: f.scope, signal: signal() }), changed);
  const badId = page.reply.body.items[0]!.id.replace(/:[0-9]+$/u, ':10');
  await assert.rejects(f.provider.dispatch({ operation: 'getNeteaseDiscoveryCollectionTracks', request: request('getNeteaseDiscoveryCollectionTracks',
    { kind: 'playlist', accountDomain: f.scope.accountDomain, collectionRevision: page.reply.body.items[0]!.collectionRevision }, { collectionId: badId }), scope: f.scope, signal: signal() }), changed);
  f.detail('9', { trackCount: 3 }); await assert.rejects(f.provider.dispatch({ operation: 'getNeteaseLikedPlaylist', request: request('getNeteaseLikedPlaylist'), scope: f.scope, signal: signal() }), changed);
  f.revoke(); await assert.rejects(page.beforeSend(), value => value instanceof MobileServiceError && value.status === 403);
});
