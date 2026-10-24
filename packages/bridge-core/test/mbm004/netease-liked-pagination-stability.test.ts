import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { MOBILE_OPERATION_TABLE } from '@music-bridge/contracts';
import { createActualMobileNeteasePorts } from '../../src/netease/mobile-actual-ports.js';
import { createMobileContentProviderService } from '../../src/mobile/content-provider-service.js';
import { captureMobileContentRequest } from '../../src/mobile/content-protocol.js';
import { createMobileCapabilityContext, withMobileCapabilityContext } from '../../src/mobile/capability-trace.js';
import { MobileServiceError } from '../../src/mobile/types.js';
import type { NeteaseMobileReadPort, NeteaseMobileReadRequest, NeteaseMobileAccountInvalidation } from '../../src/netease/types.js';
import { projectMobileReadResponse } from '../../src/netease/mobile-read-response.js';

const signal = () => new AbortController().signal;
const changed = (e: unknown) => e instanceof MobileServiceError && e.code === 'SOURCE_CHANGED';
function request(operation: 'getNeteaseLikedPlaylist' | 'listNeteaseLikedPlaylistTracks', query: Record<string, string | number> = {}) {
  return captureMobileContentRequest(operation, { path: MOBILE_OPERATION_TABLE[operation].path, pathParameters: {}, query, body: null });
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function fixture(t: TestContext, diagnostics = false) {
  let clock = 1700000000000, accountId = '700', epoch = 'epoch1', revoked = false, detailQualified = true;
  let marker: string | number = 5, owner = '700', updateTime: string | number = 1;
  let cover = 'https://p1.music.126.net/synthetic-cover.jpg', title = '合成红心';
  let members = Array.from({ length: 121 }, (_, i) => String(i + 1));
  let gate: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
  const calls: NeteaseMobileReadRequest[] = [], listeners = new Set<(event: NeteaseMobileAccountInvalidation) => void>();
  const client: NeteaseMobileReadPort = {
    get configured() { return true; },
    async mobileAccount() { return { accountId, providerEpoch: epoch }; },
    onMobileAccountInvalidated(f) { listeners.add(f); return () => listeners.delete(f); }, async awaitMobileQuiet() {},
    async mobileRead(r) {
      calls.push(r); let body: unknown;
      switch (r.operation) {
        case 'user-playlists': body = { code: 200, more: false, playlist: [{ id: '9', specialType: 5, creator: { userId: accountId } }] }; break;
        case 'playlist-detail':
          if (gate) { const hold = gate; gate = undefined; hold.entered.resolve(); await hold.release.promise; }
          body = { code: 200, playlist: { id: r.id, name: title, trackCount: members.length, trackIds: members.map(id => ({ id })),
            updateTime, coverImgUrl: cover, ...(detailQualified ? { specialType: marker, creator: { userId: owner } } : {}) } }; break;
        case 'song-detail': body = { code: 200, songs: r.ids.map(id => ({ id, name: '合成曲' + id,
          ar: [{ id: '1', name: '合成艺人' }], al: { id: '5', name: '合成专辑' }, dt: 1000, alia: [] })) }; break;
        case 'streams': body = { code: 200, data: r.ids.map(id => ({ id, code: 200, freeTrialInfo: null,
          md5: 'a'.repeat(32), size: 150000, expi: 300, url: 'https://synthetic.invalid/a.flac', level: 'hires', type: 'flac', br: 1000 })) }; break;
        default: throw new Error('未授权的合成操作');
      }
      // 经过与真实SDK相同的有限投影，证明资格字段确实可到达适配器。
      return { providerEpoch: epoch, response: projectMobileReadResponse({ body }, r.operation) };
    },
  };
  const actual = createActualMobileNeteasePorts({ client, serverId: 'server1', datasetId: 'dataset1', ownerEpoch: 'owner1',
    identityKey32: new Uint8Array(32).fill(23), now: () => clock, privateProviderDiagnostics: diagnostics,
    assertCurrent: async () => { if (revoked) throw new MobileServiceError(403, 'RESOURCE_REVOKED'); } });
  const account = await actual.account.current(signal()); assert.ok(account);
  const scope = { serverId: 'server1', datasetId: 'dataset1', ownerEpoch: 'owner1', deviceId: 'device1', deviceEpoch: 1, accessGeneration: 1, ...account };
  const provider = createMobileContentProviderService({ provider: actual.provider, cursorKey: new Uint8Array(32).fill(19), now: () => clock,
    assertCurrent: s => actual.assertCurrent(s, 'acquire', signal()) });
  t.after(async () => { gate?.release.resolve(); provider.close(); await actual.close(); });
  const summary = () => provider.dispatch({ operation: 'getNeteaseLikedPlaylist', request: request('getNeteaseLikedPlaylist'), scope, signal: signal() });
  const initial = await summary();
  const query = { playlistId: initial.reply.body.playlistId, playlistRevision: initial.reply.body.playlistRevision, accountDomain: scope.accountDomain, limit: 50 };
  const page = (cursor?: string, owned = signal()) => provider.dispatch({ operation: 'listNeteaseLikedPlaylistTracks',
    request: request('listNeteaseLikedPlaylistTracks', { ...query, ...(cursor ? { cursor } : {}) }), scope, signal: owned });
  return { actual, provider, scope, calls, page, initial, summary,
    setTime: (v: number | string) => { updateTime = v; }, setCover: (v: string) => { cover = v; },
    setTitle: (v: string) => { title = v; }, setMembers: (v: string[]) => { members = v; },
    setQualification: (v: boolean) => { detailQualified = v; }, setOwner: (v: string) => { owner = v; }, setMarker: (v: string | number) => { marker = v; },
    revoke: () => { revoked = true; },
    accountChange: () => { epoch = 'epoch2'; accountId = '701'; clock += 10001; for (const f of listeners) f({ previousProviderEpoch: 'epoch1', nextProviderEpoch: epoch }); },
    block: () => { gate = { entered: deferred(), release: deferred() }; return gate; } };
}

test('M22 红心121项完整分页：更新时间及九CDN别名漂移不破坏游标，fresh detail免重复扫描', async t => {
  const f = await fixture(t); const first = await f.page(); assert.ok(first.reply.body.nextCursor);
  f.setTime('999'); f.setCover('https://p9.music.126.net/synthetic-cover.jpg');
  const second = await f.page(first.reply.body.nextCursor); assert.ok(second.reply.body.nextCursor);
  const third = await f.page(second.reply.body.nextCursor); assert.equal(third.reply.body.nextCursor, null);
  assert.equal(new Set([...first.reply.body.items, ...second.reply.body.items, ...third.reply.body.items].map(v => v.id)).size, 121);
  assert.equal(f.calls.filter(v => v.operation === 'user-playlists').length, 1);
  assert.equal(f.calls.filter(v => v.operation === 'playlist-detail').length, 4);
  assert.equal(third.reply.body.playlistRevision, f.initial.reply.body.playlistRevision);
  await third.beforeSend();
});

test('M22 真实成员/标题/封面变化在歌曲与streams请求前拒绝旧revision', async t => {
  for (const field of ['member', 'title', 'artwork'] as const) await t.test(field, async t => {
    const f = await fixture(t); const first = await f.page(); const count = f.calls.filter(v => v.operation === 'song-detail' || v.operation === 'streams').length;
    if (field === 'member') f.setMembers(Array.from({ length: 121 }, (_, i) => String(121 - i)));
    if (field === 'title') f.setTitle('真实新标题');
    if (field === 'artwork') f.setCover('https://p9.music.126.net/new-cover.jpg?real=1');
    await assert.rejects(f.page(first.reply.body.nextCursor!), changed);
    assert.equal(f.calls.filter(v => v.operation === 'song-detail' || v.operation === 'streams').length, count);
  });
});

test('M22 detail缺资格/历史10沿原完整扫描，同次detail仅取一次', async t => {
  for (const mode of ['missing', 'legacy'] as const) await t.test(mode, async t => {
    const f = await fixture(t); if (mode === 'missing') f.setQualification(false); else f.setMarker(10);
    await f.page(); assert.equal(f.calls.filter(v => v.operation === 'user-playlists').length, 2);
    assert.equal(f.calls.filter(v => v.operation === 'playlist-detail').length, 2);
  });
});

test('M22 fresh detail外来归属拒绝，取消/撤销/账户更换阻断晚回', async t => {
  for (const mode of ['owner', 'cancel', 'revoke', 'account'] as const) await t.test(mode, async t => {
    const f = await fixture(t);
    if (mode === 'owner') { f.setOwner('999'); await assert.rejects(f.page(), changed); return; }
    const held = f.block(), controller = new AbortController(); const reading = f.page(undefined, controller.signal);
    await held.entered.promise;
    if (mode === 'cancel') controller.abort(); else if (mode === 'revoke') f.revoke(); else f.accountChange();
    held.release.resolve(); await assert.rejects(reading);
    assert.equal(f.calls.filter(v => v.operation === 'song-detail' || v.operation === 'streams').length, 0);
  });
});

test('M22 cursor绑定设备/limit/filter，不能把游标范围错误当collection revision变化', async t => {
  const f = await fixture(t), first = await f.page(); const count = f.calls.length;
  for (const extra of [{ limit: 49 }, { accountDomain: 'nc:wrong' }]) await assert.rejects(f.provider.dispatch({
    operation: 'listNeteaseLikedPlaylistTracks', request: request('listNeteaseLikedPlaylistTracks', { playlistId: f.initial.reply.body.playlistId,
      playlistRevision: f.initial.reply.body.playlistRevision, accountDomain: f.scope.accountDomain, limit: 50, cursor: first.reply.body.nextCursor!, ...extra }), scope: f.scope, signal: signal() }));
  assert.equal(f.calls.length, count);
});

test('M22 私有revision旁注只输出bool/offset/请求hash，关闭无产物且64行有界', async t => {
  for (const enabled of [false, true]) await t.test(String(enabled), async t => {
    const f = await fixture(t, enabled), lines: string[] = [];
    const observe = async () => { const context = createMobileCapabilityContext(randomUUID(), 'core', 'content', null, signal(), line => lines.push(line))!;
      context.privateContentDiagnostic = true; return withMobileCapabilityContext(context, () => f.summary()); };
    await observe(); f.setTime(999); await observe();
    const first = await f.page();
    const context = createMobileCapabilityContext(randomUUID(), 'core', 'content', null, signal(), line => lines.push(line))!;
    context.privateContentDiagnostic = true; await withMobileCapabilityContext(context, () => f.page(first.reply.body.nextCursor!));
    for (let i = 0; i < 66; i++) await observe();
    const records = lines.filter(v => v.startsWith('MUSICBRIDGE_MOBILE_COLLECTION_TRACE ')).map(v => JSON.parse(v.slice('MUSICBRIDGE_MOBILE_COLLECTION_TRACE '.length)));
    assert.equal(records.length, enabled ? 64 : 0);
    if (enabled) {
      assert.ok(records.some(r => r.baselinePresent && r.offset === 50 && r.revisionEqual === true && r.updateTimeEqual === false && r.trackIdsEqual === true && r.artworkIdentityEqual === true));
      assert.doesNotMatch(JSON.stringify(records), /https?:|synthetic-cover|nc:|owner1|epoch1|playlistId|trackIdsHash/);
      for (const r of records) for (const [k, v] of Object.entries(r)) if (k.endsWith('Equal')) assert.ok(v === null || typeof v === 'boolean');
    }
  });
});


test('M22 私有旁注写失败不改变业务且失败尝试也受64行预算约束', async t => {
  const f = await fixture(t, true); let attempted = 0;
  for (let i = 0; i < 66; i++) {
    const context = createMobileCapabilityContext(randomUUID(), 'core', 'content', null, signal(), line => {
      if (line.startsWith('MUSICBRIDGE_MOBILE_COLLECTION_TRACE ')) { attempted++; throw new Error('合成旁注写失败'); }
    })!;
    context.privateContentDiagnostic = true;
    const result = await withMobileCapabilityContext(context, () => f.summary()); assert.equal(result.reply.status, 200);
  }
  assert.equal(attempted, 64);
});


test('M22 detail明确取消红心资格不能被用户歌单列表的旧marker覆盖', async t => {
  const f = await fixture(t); f.setMarker(0);
  await assert.rejects(f.page(), e => e instanceof MobileServiceError && e.code === 'RESOURCE_REVOKED');
  assert.equal(f.calls.filter(v => v.operation === 'user-playlists').length, 1);
  assert.equal(f.calls.filter(v => v.operation === 'song-detail' || v.operation === 'streams').length, 0);
});
