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
async function fixture(t: TestContext) {
  let clock = 1700000000000, accountId = '700', epoch = 'epoch1', revoked = false, detailQualified = true;
  let marker: string | number = 5, owner = '700', updateTime: string | number = 1;
  let cover = 'https://p1.music.126.net/synthetic-cover.jpg', title = '合成红心';
  let members = Array.from({ length: 825 }, (_, i) => String(i + 1));
  let alias: unknown = '  原始版本  ';
  let changeSong: (song: Record<string, unknown>) => void = () => {};
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
        case 'song-detail': body = { code: 200, songs: r.ids.map(id => {
          const song: Record<string, unknown> = { id, name: '合成曲' + id, ar: [{ id: '1', name: '合成艺人' }],
            al: { id: '5', name: '合成专辑' }, dt: 1000, alia: id === '801' ? [alias] : [] };
          if (id === '801') changeSong(song);
          return song;
        }) }; break;
        case 'streams': body = { code: 200, data: r.ids.map(id => ({ id, code: 200, freeTrialInfo: null,
          md5: 'a'.repeat(32), size: 150000, expi: 300, url: 'https://synthetic.invalid/a.flac', level: 'hires', type: 'flac', br: 1000 })) }; break;
        default: throw new Error('未授权的合成操作');
      }
      // 经过与真实SDK相同的有限投影，证明资格字段确实可到达适配器。
      return { providerEpoch: epoch, response: projectMobileReadResponse({ body }, r.operation) };
    },
  };
  const actual = createActualMobileNeteasePorts({ client, serverId: 'server1', datasetId: 'dataset1', ownerEpoch: 'owner1',
    identityKey32: new Uint8Array(32).fill(23), now: () => clock, privateProviderDiagnostics: false,
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
    setAlias: (v: unknown) => { alias = v; }, patchSong: (f: (song: Record<string, unknown>) => void) => { changeSong = f; },
    setTime: (v: number | string) => { updateTime = v; }, setCover: (v: string) => { cover = v; },
    setTitle: (v: string) => { title = v; }, setMembers: (v: string[]) => { members = v; },
    setQualification: (v: boolean) => { detailQualified = v; }, setOwner: (v: string) => { owner = v; }, setMarker: (v: string | number) => { marker = v; },
    revoke: () => { revoked = true; },
    accountChange: () => { epoch = 'epoch2'; accountId = '701'; clock += 10001; for (const f of listeners) f({ previousProviderEpoch: 'epoch1', nextProviderEpoch: epoch }); },
    block: () => { gate = { entered: deferred(), release: deferred() }; return gate; } };
}


async function reachOffset800(f: Awaited<ReturnType<typeof fixture>>) {
  let cursor: string | undefined;
  let count = 0;
  for (let page = 0; page < 16; page++) {
    const result = await f.page(cursor);
    assert.equal(result.reply.body.items.length, 50);
    count += result.reply.body.items.length;
    assert.equal(result.reply.body.playlistRevision, f.initial.reply.body.playlistRevision);
    assert.ok(result.reply.body.nextCursor);
    cursor = result.reply.body.nextCursor;
  }
  assert.equal(count, 800);
  assert.equal(f.calls.filter(v => v.operation === 'song-detail').length, 16);
  assert.ok(cursor);
  return cursor;
}

test('M26红心第17页可选edition畸形不应拒整页，真实825项全部保留', async t => {
  const cases: { name: string; value: unknown; expected: string }[] = [
    { name: '换行tab与C0C1', value: '\u0000 现场\n\t纪念\u0085版本\u007f', expected: '现场 纪念 版本' },
    { name: '首alias为null', value: null, expected: '' },
    { name: '首alias为数值', value: 19, expected: '' },
    { name: '首alias为布尔', value: false, expected: '' },
    { name: '按UTF8字节超过1024', value: '汉'.repeat(342), expected: '' },
  ];
  for (const row of cases) await t.test(row.name, async t => {
    const f = await fixture(t), cursor = await reachOffset800(f);
    f.setAlias(row.value);
    const result = await f.page(cursor);
    assert.equal(result.reply.body.items.length, 25);
    assert.equal(result.reply.body.nextCursor, null);
    assert.equal(result.reply.body.trackCount, 825);
    assert.equal(result.reply.body.playlistRevision, f.initial.reply.body.playlistRevision);
    const target = result.reply.body.items[0]!;
    assert.equal(target.sourceItemId, '801');
    assert.equal(target.editionLabel, row.expected);
    assert.equal(target.title, '合成曲801');
    assert.equal(new Set(result.reply.body.items.map(v => v.id)).size, 25);
    assert.equal(f.calls.filter(v => v.operation === 'song-detail').length, 17);
    assert.equal(f.calls.filter(v => v.operation === 'streams').length, 17);
    await result.beforeSend();
  });
});

test('M26合法edition逐字保持，最终规范化显示值绑定曲目revision', async t => {
  const f = await fixture(t), cursor = await reachOffset800(f);
  const read = async () => (await f.page(cursor)).reply.body.items[0]!;
  const original = await read();
  assert.equal(original.editionLabel, '  原始版本  ');
  f.setAlias('纪念\n版本'); const newline = await read();
  f.setAlias('纪念\t版本'); const tab = await read();
  assert.equal(newline.editionLabel, '纪念 版本');
  assert.equal(tab.editionLabel, newline.editionLabel);
  assert.equal(tab.contentRevision, newline.contentRevision);
  assert.notEqual(tab.contentRevision, original.contentRevision);
  f.setAlias('另一真实版本'); const changed = await read();
  assert.equal(changed.id, original.id); assert.equal(changed.albumId, original.albumId);
  assert.equal(changed.versionId, original.versionId);
  assert.notEqual(changed.contentRevision, tab.contentRevision);
  f.setAlias(null); const missing = await read();
  f.setAlias('汉'.repeat(342)); const over = await read();
  assert.equal(over.editionLabel, ''); assert.equal(over.contentRevision, missing.contentRevision);
});

test('M26可选edition宽容不放松必需曲目身份标题专辑与成员账号守门', async t => {
  const f = await fixture(t), cursor = await reachOffset800(f);
  f.setAlias('可选\n版本');
  const patches: { name: string; apply: (song: Record<string, unknown>) => void }[] = [
    { name: '非法songID', apply: song => { song.id = '0'; } },
    { name: '必需标题控制字符', apply: song => { song.name = '标题\n非法'; } },
    { name: '必需标题为空', apply: song => { song.name = ''; } },
    { name: '非法albumID', apply: song => { song.al = { id: -1, name: '合成专辑' }; } },
    { name: '必需艺人控制字符', apply: song => { song.ar = [{ id: '1', name: '艺人\n非法' }]; } },
  ];
  for (const row of patches) await t.test(row.name, async () => {
    f.patchSong(row.apply);
    const streams = f.calls.filter(v => v.operation === 'streams').length;
    await assert.rejects(f.page(cursor), changed);
    assert.equal(f.calls.filter(v => v.operation === 'streams').length, streams);
  });
  f.patchSong(() => {});
  f.setMembers(Array.from({ length: 825 }, (_, i) => String(825 - i)));
  const songs = f.calls.filter(v => v.operation === 'song-detail').length;
  await assert.rejects(f.page(cursor), changed);
  assert.equal(f.calls.filter(v => v.operation === 'song-detail').length, songs);
  f.setMembers(Array.from({ length: 825 }, (_, i) => String(i + 1)));
  f.accountChange();
  await assert.rejects(f.page(cursor));
  assert.equal(f.calls.filter(v => v.operation === 'song-detail').length, songs);
});

test('M26未知字段不读取，已知alias恶意形状或getter仍在原投影边界拒绝', async t => {
  const f = await fixture(t), cursor = await reachOffset800(f); let invoked = 0;
  f.patchSong(song => { Object.defineProperty(song, 'unknownPrivateField', { enumerable: true, get() { invoked++; throw new Error('不得访问'); } }); });
  const result = await f.page(cursor); assert.equal(result.reply.body.items.length, 25); assert.equal(invoked, 0);
  f.patchSong(song => { Object.defineProperty(song, 'alia', { enumerable: true, get() { invoked++; throw new Error('不得访问'); } }); });
  await assert.rejects(f.page(cursor)); assert.equal(invoked, 0);
  f.patchSong(() => {}); f.setAlias({ unknownPrivateField: '不得扩为展示字符串' });
  await assert.rejects(f.page(cursor));
});
