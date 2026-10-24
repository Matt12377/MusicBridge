import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import {
  MOBILE_OPERATION_TABLE, decodeMobileRequest, decodeMobileResponse,
  type MobileAlbum, type MobileHeaderPairs, type MobileOperationId, type MobileSearchQuery,
  type MobileTrack, type MobileTrackPage,
} from '@music-bridge/contracts';
import { createMobileBackend } from '../src/main/mobile-backend.js';
import { createMobileContentRpcPort, type MobileContentRpcPortOptions } from '../../../packages/bridge-core/src/mobile/content-rpc-port.js';
import type { MobileContentCoreRequest } from '../../../packages/bridge-core/src/mobile/content-rpc.js';
import type { MobileContentScope } from '../../../packages/bridge-core/src/mobile/content-types.js';
import { createMobileCatalogCursorCodec } from '../../../packages/bridge-core/src/mobile/cursor.js';
import { MobileServiceError, type Mobile001Operation, type Mobile001BackendReply,
  type MobileOwnerPrivateRequest, type MobileOwnerPrivateResult, type MobileSealedState } from '../../../packages/bridge-core/src/mobile/types.js';

// 实际 Main/auth/wire/RPC，只有 Owner 存储与 Core 目录事实受控；不连接真实账号或音频。
const SERVER = 'server.album-detail', DATASET = '10000000-0000-4000-8000-000000000014';
const OWNER = '10000000-0000-4000-8000-000000000015', ORIGIN = 'https://127.0.0.1';
const ALBUM = 'na:0123456789abcdef:5', LOCAL = `la:${DATASET}:local-edition`;
const signal = () => new AbortController().signal;
function song(index: number, source: 'local' | 'netease' = 'netease'): MobileTrack {
  return { id: `${source === 'netease' ? 'nt:0123456789abcdef' : 'lt:local'}:${index + 1}`, source,
    sourceItemId: String(index + 1), albumId: source === 'netease' ? ALBUM : LOCAL,
    title: `合成曲${index + 1}`, artists: ['合成艺人'], versionId: `nv:version.${index}`,
    contentRevision: `nr:content.${index}`, editionLabel: '', durationMs: 120_000,
    audio: { codec: 'unknown', container: 'unknown' }, availability: index === 101 ? 'unavailable' : 'available' };
}
function refuses(status: number, code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof MobileServiceError); assert.equal(error.status, status); assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /https?:|cookie|credential|stack/iu); return true;
  };
}
async function fixture(t: TestContext, enabled = true) {
  let stored: MobileSealedState = { kind: 'missing', datasetId: DATASET, revision: 0 };
  const calls: MobileContentCoreRequest[] = [], ownerCalls: MobileOwnerPrivateRequest[] = [];
  const state = { accountDomain: 'account.album.1', providerEpoch: 'provider.album.1' as string | null,
    ownerEpoch: OWNER, active: true, revision: 'nr:album.1', reads: 0, sourceOpens: 0,
    album: { id: ALBUM, source: 'netease', title: '合成原发行', artists: ['合成艺人'], editionLabel: '', trackCount: 103 } as MobileAlbum,
    tracks: Array.from({ length: 103 }, (_, index) => song(index)), hasNext: true,
    failure: undefined as MobileServiceError | undefined };
  const scopes = new Map<string, Readonly<MobileContentScope>>(), revoked = new Map<string, number>();
  const cursor = createMobileCatalogCursorCodec({ key: new Uint8Array(32).fill(43), version: 2 });
  // 交接前旧生产会忽略这两个新增注入；RED 必须由公开路由实际 404/503 产生。
  const options: MobileContentRpcPortOptions & {
    readAlbum(scope: Readonly<MobileContentScope>, id: string, owned: AbortSignal): Promise<MobileAlbum>;
    readAlbumTracks(scope: Readonly<MobileContentScope>, id: string, query: MobileSearchQuery,
      expected: string | null, owned: AbortSignal): Promise<MobileTrackPage>;
  } = { initialize: async () => undefined, invalidateDevice: async input => { revoked.set(input.deviceId, input.deviceEpoch); },
    resolveScope: async principal => {
      const scope = { ...principal, ownerEpoch: state.ownerEpoch, accountDomain: state.accountDomain, providerEpoch: state.providerEpoch };
      scopes.set(principal.deviceId, scope); return scope;
    }, assertScope: (scope, stage) => {
      if (!state.active || (revoked.get(scope.deviceId) ?? 0) >= scope.deviceEpoch) throw new MobileServiceError(401, 'UNAUTHORIZED');
      if (scope.accountDomain !== state.accountDomain || scope.providerEpoch !== state.providerEpoch || scope.ownerEpoch !== state.ownerEpoch
        || stage === 'acquire' && scopes.get(scope.deviceId)?.accessGeneration !== scope.accessGeneration) throw new MobileServiceError(409, 'SOURCE_CHANGED');
    }, content: { async dispatch() { throw new MobileServiceError(409, 'UNSUPPORTED_FORMAT'); } },
    source: async () => { state.sourceOpens++; throw new Error('目录读取不能准备音频资源。'); },
    readAlbum: async (_scope, id) => { state.reads++; if (state.failure) throw state.failure;
      if (id !== ALBUM) throw new MobileServiceError(409, 'SOURCE_CHANGED'); return structuredClone(state.album); },
    readAlbumTracks: async (scope, id, query, expected) => {
      state.reads++; if (state.failure) throw state.failure;
      if (id !== ALBUM || expected !== null && expected !== state.revision) throw new MobileServiceError(409, 'SOURCE_CHANGED');
      const limit = query.limit ?? 50, facts = { operation: 'listTracks' as const, serverId: scope.serverId,
        datasetId: scope.datasetId, deviceId: scope.deviceId, accountDomain: scope.accountDomain, deviceEpoch: scope.deviceEpoch,
        generation: scope.accessGeneration, source: 'netease' as const, sort: 'fixture-order', filter: 'a'.repeat(64), albumId: id, limit };
      const offset = query.cursor === undefined ? 0 : cursor.open(query.cursor, facts).offset;
      return { items: structuredClone(state.tracks.slice(offset, offset + limit)), libraryRevision: state.revision,
        nextCursor: state.hasNext && offset + limit < state.tracks.length ? cursor.issue({ ...facts,
          ownerEpoch: scope.ownerEpoch, libraryRevision: state.revision, offset: offset + limit }) : null };
    } };
  const rpc = createMobileContentRpcPort(options);
  async function owner(request: MobileOwnerPrivateRequest): Promise<MobileOwnerPrivateResult> {
    ownerCalls.push(request);
    if (request.kind === 'load') return structuredClone(stored);
    if (request.kind === 'save') {
      assert.equal(stored.revision, request.request.expectedRevision);
      stored = { kind: 'sealed', datasetId: DATASET, revision: stored.revision + 1,
        commitId: request.request.commitId, sealed: new Uint8Array(request.request.sealed) };
      return { kind: 'saved', datasetId: DATASET, revision: stored.revision, commitId: stored.commitId };
    }
    if (request.kind !== 'catalog') throw new MobileServiceError(409, 'UNSUPPORTED_FORMAT');
    const q = request.request, album: MobileAlbum = { ...state.album, id: LOCAL, source: 'local', trackCount: 1 };
    const all = q.operation === 'getAlbum' || q.operation === 'listAlbums' ? [album] : [song(0, 'local')];
    const items = all.filter(item => (q.itemId === null || item.id === q.itemId)
      && (q.albumId === null || ('albumId' in item ? item.albumId : item.id) === q.albumId));
    return { datasetId: DATASET, ownerEpoch: OWNER, libraryRevision: 'mr:local.1', operation: q.operation,
      offset: q.offset, limit: q.limit, total: items.length, items: items.slice(q.offset, q.offset + q.limit) };
  }
  const service = createMobileBackend({ serverId: SERVER, datasetId: DATASET, authKey: new Uint8Array(32).fill(41),
    displayName: '合成专辑接线', environment: 'development', requestOwner: owner, assertCurrent: () => undefined,
    resizeArtwork: bytes => bytes, ...(enabled ? { enableContent: true } : {}),
    requestContentRpc: (request, parent) => { calls.push(structuredClone(request)); return rpc.request(request, parent); } });
  const permit = await service.auth.issuePairing(), tokens = await service.auth.claim({ pairingSecret: permit.pairingSecret,
    installationId: 'installation.album-detail', deviceName: '合成手机' }, 'claim.album-detail');
  t.after(async () => { await service.close(); await rpc.close(); if (stored.kind === 'sealed') stored.sealed.fill(0); });
  async function dispatch(operation: Mobile001Operation, query: MobileHeaderPairs = [], parent = signal(), id = ALBUM) {
    const path = MOBILE_OPERATION_TABLE[operation].path.replace('{albumId}', encodeURIComponent(id));
    const request = decodeMobileRequest(operation, { method: MOBILE_OPERATION_TABLE[operation].method, path,
      query, headers: [['Authorization', `Bearer ${tokens.accessToken}`]], body: new Uint8Array() },
    { responseOrigin: ORIGIN, requestPath: path }); assert.ok(request.ok);
    const reply = await service.backend.dispatch({ operation, request: request.value, accessToken: tokens.accessToken, signal: parent });
    return { reply, path };
  }
  return { service, rpc, state, calls, ownerCalls, tokens, dispatch };
}
function body<O extends MobileOperationId>(operation: O, result: { reply: Mobile001BackendReply; path: string }) {
  const decoded = decodeMobileResponse(operation, { status: result.reply.status, headers: result.reply.headers,
    body: result.reply.body, finalUrl: ORIGIN + result.path }, { responseOrigin: ORIGIN, requestPath: result.path });
  assert.ok(decoded.ok); assert.equal(decoded.value.category, 'success'); return decoded.value.body;
}
test('R14_ROUTE_RED na详情走可信Provider原专辑而非本地Owner404', async t => {
  const f = await fixture(t), result = await f.dispatch('getAlbum');
  assert.equal(result.reply.status, 200); await result.reply.beforeSend!();
  assert.deepEqual(JSON.parse(JSON.stringify(body('getAlbum', result))), f.state.album);
  assert.equal(f.ownerCalls.filter(call => call.kind === 'catalog').length, 0);
  assert.equal(f.state.reads, 2); assert.equal(f.state.sourceOpens, 0);
});
test('R14_ROUTE_RED source=netease专辑页沿原公开TrackPage而非本地503', async t => {
  const f = await fixture(t), query: MobileHeaderPairs = [['source', 'netease'], ['albumId', ALBUM], ['limit', '100']];
  const result = await f.dispatch('listTracks', query); assert.equal(result.reply.status, 200); await result.reply.beforeSend!();
  const page = body('listTracks', result) as MobileTrackPage; assert.equal(page.items.length, 100); assert.ok(page.nextCursor);
  assert.equal(page.libraryRevision, f.state.revision); assert.equal(f.state.reads, 2);
  assert.equal(f.ownerCalls.filter(call => call.kind === 'catalog').length, 0); assert.equal(f.state.sourceOpens, 0);
});
test('R14_LOCAL 原本地详情及专辑页仍经Owner读取与发送前复核', async t => {
  const f = await fixture(t), detail = await f.dispatch('getAlbum', [], signal(), LOCAL); await detail.reply.beforeSend!();
  assert.equal((body('getAlbum', detail) as MobileAlbum).source, 'local');
  const page = await f.dispatch('listTracks', [['source', 'local'], ['albumId', LOCAL]]); await page.reply.beforeSend!();
  assert.equal((body('listTracks', page) as MobileTrackPage).items.length, 1);
  assert.equal(f.ownerCalls.filter(call => call.kind === 'catalog').length, 4); assert.equal(f.state.reads, 0);
});
test('R14_BEFORE_SEND 详情与页面保留账户/Owner/修订/元数据/可用性/hasNext/取消撤权围栏', async t => {
  for (const mutation of ['account', 'provider', 'owner', 'revision', 'metadata', 'availability', 'hasNext', 'cancel', 'revoke'] as const) {
    await t.test(mutation, async child => {
      const f = await fixture(child), controller = new AbortController();
      const result = await f.dispatch('listTracks', [['source', 'netease'], ['albumId', ALBUM], ['limit', '100']], controller.signal);
      if (mutation === 'account') f.state.accountDomain = 'account.album.changed';
      if (mutation === 'provider') f.state.providerEpoch = 'provider.album.changed';
      if (mutation === 'owner') f.state.ownerEpoch = '10000000-0000-4000-8000-000000000016';
      if (mutation === 'revision') f.state.revision = 'nr:album.changed';
      if (mutation === 'metadata') f.state.tracks[0]!.title += '已变化';
      if (mutation === 'availability') f.state.tracks[0]!.availability = 'unavailable';
      if (mutation === 'hasNext') f.state.hasNext = false;
      if (mutation === 'cancel') controller.abort();
      if (mutation === 'revoke') await f.service.auth.revokeDevice(f.tokens.deviceId);
      await assert.rejects(result.reply.beforeSend!()); assert.equal(f.state.sourceOpens, 0);
      assert.equal(f.ownerCalls.filter(call => call.kind === 'catalog').length, 0);
    });
  }
  const f = await fixture(t), detail = await f.dispatch('getAlbum'); f.state.album.title += '已变化';
  await assert.rejects(detail.reply.beforeSend!(), refuses(409, 'SOURCE_CHANGED'));
});
test('R14_PRIVACY 正式wire只公开目录事实，未启用Provider不回落Owner且上游失败不伪空', async t => {
  const f = await fixture(t), result = await f.dispatch('getAlbum'); await result.reply.beforeSend!();
  assert.doesNotMatch(new TextDecoder().decode(result.reply.body), /https?:|cookie|credential|accountDomain|providerEpoch|ownerEpoch|fingerprint/iu);
  for (const error of [new MobileServiceError(403, 'RESOURCE_REVOKED'), new MobileServiceError(503, 'BUSY')]) {
    f.state.failure = error; await assert.rejects(f.dispatch('getAlbum'), refuses(error.status, error.code));
  }
  const off = await fixture(t, false); await assert.rejects(off.dispatch('getAlbum'));
  assert.equal(off.ownerCalls.filter(call => call.kind === 'catalog').length, 0); assert.equal(off.calls.length, 0);
});
