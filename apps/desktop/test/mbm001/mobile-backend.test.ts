import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import {
  MOBILE_OPERATION_TABLE, decodeMobileRequest, decodeMobileResponse,
  type MobileAlbum, type MobileHeaderPairs, type MobilePairingClaim,
  type MobileRefreshRequest, type MobileResponseBody, type MobileTokenPair, type MobileTrack,
} from '@music-bridge/contracts';
import { createMobileBackend } from '../../src/main/mobile-backend.js';
import {
  isMobileOwnerPrivateRequest, isMobileOwnerPrivateResult,
} from '../../../../packages/bridge-core/src/mobile/owner-protocol.js';
import {
  MobileAuthPersistenceError, MobileServiceError,
  type Mobile001BackendReply, type Mobile001BackendRequest, type Mobile001Operation,
  type MobileOwnerCatalogSnapshot, type MobileOwnerPrivateFailure,
  type MobileOwnerPrivateRequest, type MobileOwnerPrivateResult, type MobileSealedState,
} from '../../../../packages/bridge-core/src/mobile/types.js';

/**
 * 原 HTTP codec、实际 Main backend/auth/AES-GCM/catalog 的合成行为测试。
 * 仅 Owner 私有存储/同快照回包及缩图端口受控；不证明真实 Owner、SQLite、HTTPS、
 * 原生图片尺寸、实际音频、生产 App 或 Owner 接受。不会打开账号、媒体或文件。
 */
const IDS = {
  server: 'server.backend-fixture',
  dataset: '20000000-0000-4000-8000-000000000001',
  otherDataset: '20000000-0000-4000-8000-000000000002',
  owner: '20000000-0000-4000-8000-000000000003',
  otherOwner: '20000000-0000-4000-8000-000000000004',
  edition: '20000000-0000-4000-8000-000000000005',
};
const ALBUM = `la:${IDS.dataset}:${IDS.edition}`;
const ARTWORK = `aw:${IDS.dataset}:selection.1`;
const ORIGIN = 'https://127.0.0.1';
const AUTH_KEY = new Uint8Array(32).fill(71);
type BackendHandle = ReturnType<typeof createMobileBackend>;

function track(index: number): MobileTrack {
  return { id: `lt:${IDS.dataset}:track.${index}:${IDS.edition}`, title: '同名合成曲目', artists: ['受控作者'],
    albumId: ALBUM, source: 'local', sourceItemId: `ls:${IDS.dataset}:asset.${index}`, versionId: `lv:fixture.${index}`,
    contentRevision: `lc:fixture.${index}`, editionLabel: '已登记合成发行', durationMs: 1_000,
    audio: { codec: 'flac', container: 'flac', sampleRateHz: 96_000, channels: 2, bitsPerSample: 24 },
    availability: 'unavailable', artworkId: ARTWORK };
}
function failure(status: MobileServiceError['status'], code: MobileServiceError['code']): MobileOwnerPrivateFailure {
  return { kind: 'mobile-error', status, code, retryable: false, outcome: null };
}
function safeError(status: MobileServiceError['status'], code: MobileServiceError['code']) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof MobileServiceError);
    assert.equal(error.status, status); assert.equal(error.code, code); assert.equal(error.retryable, false);
    assert.equal(error.message, '移动服务当前无法完成请求。'); assert.equal(Object.hasOwn(error, 'cause'), false);
    return true;
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function copyState(value: MobileSealedState): MobileSealedState {
  return value.kind === 'missing' ? { ...value } : { ...value, sealed: new Uint8Array(value.sealed) };
}

/** 此夹具仅表达受控 Owner 端口；正常每个请求/整份回包均经实际闭集协议校验。 */
function fixture(t: TestContext, count = 3) {
  const tracks = Array.from({ length: count }, (_, index) => track(index));
  const albums: MobileAlbum[] = [{ id: ALBUM, title: '受控专辑', artists: ['受控作者'], source: 'local',
    editionLabel: '已登记合成发行', trackCount: count, artworkId: ARTWORK }];
  const calls: MobileOwnerPrivateRequest[] = [];
  const resizeCalls: { size: 96 | 256 | 512; bytes: Uint8Array; output: Uint8Array }[] = [];
  const handles: BackendHandle[] = [];
  let held: { entered: ReturnType<typeof deferred>; released: ReturnType<typeof deferred> } | null = null;
  const state: {
    datasetId: string; ownerEpoch: string; revision: string; hostCurrent: boolean;
    stored: MobileSealedState; saves: number; selected: boolean; selectionRevision: string; selectedBytes: Uint8Array;
    afterResize: (() => void) | null;
    malformedCatalog: ((value: MobileOwnerCatalogSnapshot) => MobileOwnerPrivateResult) | null;
    unavailableTracks: Set<string>;
  } = { datasetId: IDS.dataset, ownerEpoch: IDS.owner, revision: 'mr:fixture.1', hostCurrent: true,
    stored: { kind: 'missing', datasetId: IDS.dataset, revision: 0 }, saves: 0, selected: true,
    selectionRevision: 'selection.1', selectedBytes: new Uint8Array([0xff, 0xd8, 17, 0xff, 0xd9]),
    afterResize: null, malformedCatalog: null, unavailableTracks: new Set() };

  async function requestOwner(request: MobileOwnerPrivateRequest): Promise<MobileOwnerPrivateResult> {
    assert.equal(isMobileOwnerPrivateRequest(request), true, '正常端口请求必须属于实际私有闭集。');
    // 存储入参的密文稍后由 auth 清零；这里只记录独立副本，不依赖借出的缓冲区。
    calls.push(structuredClone(request));
    let result: MobileOwnerPrivateResult;
    if (request.datasetId !== state.datasetId) result = failure(503, 'BUSY');
    else if (request.kind === 'load') result = copyState(state.stored);
    else if (request.kind === 'save') {
      if (request.request.expectedRevision !== state.stored.revision) {
        result = { kind: 'conflict', datasetId: request.datasetId, currentRevision: state.stored.revision };
      } else {
        state.stored = { kind: 'sealed', datasetId: request.datasetId, revision: request.request.expectedRevision + 1,
          commitId: request.request.commitId, sealed: new Uint8Array(request.request.sealed) };
        state.saves++;
        result = { kind: 'saved', datasetId: request.datasetId, revision: state.stored.revision, commitId: state.stored.commitId };
      }
    } else if (request.kind === 'artwork') {
      assert.equal(request.request.serverId, IDS.server);
      result = !state.selected || request.request.artworkId !== ARTWORK ? failure(404, 'INVALID_REQUEST')
        : { datasetId: state.datasetId, ownerEpoch: state.ownerEpoch, libraryRevision: state.revision,
          artworkId: ARTWORK, selectionRevision: state.selectionRevision, contentType: 'image/jpeg',
          bytes: new Uint8Array(state.selectedBytes) };
    } else {
      assert.ok(request.kind === 'catalog', '原001测试组合只接收认证、目录和选图操作。');
      assert.equal(request.request.serverId, IDS.server);
      const gate = held; held = null;
      if (gate) { gate.entered.resolve(); await gate.released.promise; }
      const q = request.request;
      const playbackEnabled = q.catalogPlaybackEnabled === true;
      const revision = playbackEnabled ? `${state.revision}.playback` : state.revision;
      if (q.expectedRevision !== null && q.expectedRevision !== revision) result = failure(409, 'SOURCE_CHANGED');
      else {
        // 受控 Owner 独立裁决每条曲目；Main 不能把整页改成 available。
        const visibleTracks = tracks.map(item => ({ ...item,
          availability: playbackEnabled && !state.unavailableTracks.has(item.id) ? 'available' as const : 'unavailable' as const }));
        const rows = (q.operation === 'listAlbums' || q.operation === 'getAlbum' ? albums : visibleTracks)
          .filter(item => (q.itemId === null || item.id === q.itemId)
            && (q.albumId === null || ('albumId' in item ? item.albumId : item.id) === q.albumId)
            && (!q.q || item.title.includes(q.q)));
        const snapshot: MobileOwnerCatalogSnapshot = { datasetId: state.datasetId, ownerEpoch: state.ownerEpoch, libraryRevision: revision,
          operation: q.operation, offset: q.offset, limit: q.limit, total: rows.length,
          items: structuredClone(rows.slice(q.offset, q.offset + q.limit)) };
        assert.equal(isMobileOwnerPrivateResult(snapshot, request), true, '注入负向回包前，正常整份快照必须有效。');
        if (state.malformedCatalog) return state.malformedCatalog(snapshot);
        result = snapshot;
      }
    }
    assert.equal(isMobileOwnerPrivateResult(result, request), true, '正常端口结果必须属于实际私有闭集。');
    return result;
  }
  function open(overrides: { authKey?: Uint8Array; serverId?: string; enablePlayback?: boolean } = {}): BackendHandle {
    const value = createMobileBackend({ serverId: overrides.serverId ?? IDS.server, datasetId: IDS.dataset,
      authKey: overrides.authKey ?? AUTH_KEY, displayName: '合成 Main 目录', environment: 'development', requestOwner,
      ...(overrides.enablePlayback === undefined ? {} : { enablePlayback: overrides.enablePlayback }),
      assertCurrent() { if (!state.hostCurrent || state.datasetId !== IDS.dataset) throw new MobileServiceError(503, 'BUSY'); },
      resizeArtwork(bytes, size) {
        // 只验证缩图端口的选择来源、输出复制及围栏；这些标记不冒充真实 JPEG 解码或尺寸。
        const output = new Uint8Array([0xff, 0xd8, size >>> 8, size & 255, bytes[2]!, 0xff, 0xd9]);
        resizeCalls.push({ size, bytes: new Uint8Array(bytes), output }); state.afterResize?.(); return output;
      },
    });
    handles.push(value); return value;
  }
  const handle = open();
  t.after(async () => { held?.released.resolve(); for (const value of handles) await value.close(); });
  return { handle, open, state, calls, tracks, albums, resizeCalls,
    holdNextCatalog() {
      assert.equal(held, null); const gate = { entered: deferred(), released: deferred() }; held = gate;
      // 已进入的请求已经取走 held；仍保留这个释放钩子，失败清理也不会留下等待者。
      t.after(() => gate.released.resolve());
      return { entered: gate.entered.promise, release: gate.released.resolve };
    } };
}
type Fixture = ReturnType<typeof fixture>;
interface RequestOptions {
  token?: string; body?: unknown; key?: string; path?: string; query?: MobileHeaderPairs; signal?: AbortSignal;
}
function operationPath(operation: Mobile001Operation): string {
  return MOBILE_OPERATION_TABLE[operation].path.replace('{albumId}', encodeURIComponent(ALBUM))
    .replace('{trackId}', encodeURIComponent(track(0).id)).replace('{artworkId}', encodeURIComponent(ARTWORK));
}
function prepare(operation: Mobile001Operation, options: RequestOptions = {}): Mobile001BackendRequest {
  const entry = MOBILE_OPERATION_TABLE[operation];
  const path = options.path ?? operationPath(operation);
  const bytes = options.body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(options.body));
  const headers: [string, string][] = options.body === undefined ? []
    : [['Content-Type', 'application/json'], ['Content-Length', String(bytes.byteLength)]];
  if (options.key !== undefined) headers.push(['Idempotency-Key', options.key]);
  if (options.token !== undefined) headers.push(['Authorization', `Bearer ${options.token}`]);
  const decoded = decodeMobileRequest(operation, { method: entry.method, path, headers, query: options.query ?? [], body: bytes },
    { responseOrigin: ORIGIN, requestPath: path });
  assert.equal(decoded.ok, true, '完整 HTTP 请求必须先经原 codec。');
  if (!decoded.ok) throw new Error('合成请求不符合原 wire 合同。');
  return { operation, request: decoded.value, accessToken: options.token ?? null, signal: options.signal ?? new AbortController().signal };
}
function readBody<O extends Mobile001Operation>(operation: O, reply: Mobile001BackendReply, path?: string): MobileResponseBody<O> {
  const requestPath = path ?? operationPath(operation);
  const decoded = decodeMobileResponse(operation, { status: reply.status, headers: reply.headers,
    body: reply.body, finalUrl: `${ORIGIN}${requestPath}` }, { responseOrigin: ORIGIN, requestPath });
  assert.equal(decoded.ok, true, '完整响应必须通过原 wire decoder。');
  if (!decoded.ok) throw new Error('实际 backend 回包不符合原 wire 合同。');
  assert.notEqual(decoded.value.category, 'error');
  return decoded.value.body as MobileResponseBody<O>;
}
async function beforeSend(reply: Mobile001BackendReply): Promise<void> {
  assert.equal(typeof reply.beforeSend, 'function', '真实 Main 回包必须保留发送前围栏。');
  await reply.beforeSend!();
}
async function paired(f: Fixture, handle = f.handle) {
  const permit = await handle.auth.issuePairing();
  const body: MobilePairingClaim = { pairingSecret: permit.pairingSecret, installationId: 'installation.backend-fixture', deviceName: '合成客户端' };
  const key = 'pair.original-intent', request = prepare('claimPairing', { body, key });
  const reply = await handle.backend.dispatch(request); assert.equal(reply.status, 201); await beforeSend(reply);
  return { tokens: readBody('claimPairing', reply, request.request.path), body, key, reply };
}
async function refreshed(f: Fixture, tokens: MobileTokenPair, key = 'refresh.original-intent') {
  const body: MobileRefreshRequest = { refreshToken: tokens.refreshToken }, request = prepare('refreshToken', { body, key });
  const reply = await f.handle.backend.dispatch(request); assert.equal(reply.status, 200); await beforeSend(reply);
  return { tokens: readBody('refreshToken', reply, request.request.path), body, key, reply };
}
const dispatch = (f: Fixture, operation: Mobile001Operation, options: RequestOptions = {}) => f.handle.backend.dispatch(prepare(operation, options));
const catalogCalls = (f: Fixture) => f.calls.filter(value => value.kind === 'catalog');

/** 延续原001用例覆盖002激活接线，不改变冻结用例清单或把受控端口写成真文件证据。 */
async function assertPlaybackCatalogGating(f: Fixture, tokens: MobileTokenPair): Promise<void> {
  const enabled = f.open({ enablePlayback: true }), disabled = f.open({ enablePlayback: false });
  const run = (handle: BackendHandle, operation: Mobile001Operation, query: MobileHeaderPairs = []) =>
    handle.backend.dispatch(prepare(operation, { token: tokens.accessToken, query }));
  assert.ok(enabled.playbackBackend); assert.equal(disabled.playbackBackend, undefined);
  assert.throws(() => disabled.activatePlayback(ORIGIN), safeError(400, 'INVALID_REQUEST'));
  assert.throws(() => enabled.activatePlayback('http://127.0.0.1'), safeError(400, 'INVALID_REQUEST'));
  const callsBeforeActivation = catalogCalls(f).length;
  for (const handle of [enabled, disabled]) {
    const capability = await run(handle, 'getCapabilities'); await beforeSend(capability);
    assert.equal(readBody('getCapabilities', capability).localPlayback, false);
    const page = await run(handle, 'listTracks'); await beforeSend(page);
    assert.equal(readBody('listTracks', page).items.every(item => item.availability === 'unavailable'), true);
    const detail = await run(handle, 'getTrack'); await beforeSend(detail);
    assert.equal(readBody('getTrack', detail).availability, 'unavailable');
  }
  assert.equal(catalogCalls(f).slice(callsBeforeActivation).every(call => call.request.catalogPlaybackEnabled !== true), true);
  const oldAlbums = await run(enabled, 'listAlbums'), oldPage = await run(enabled, 'listTracks', [['limit', '1']]);
  const oldDetail = await run(enabled, 'getTrack'); await beforeSend(oldPage);
  const oldCursor = readBody('listTracks', oldPage).nextCursor; assert.equal(typeof oldCursor, 'string');
  enabled.activatePlayback(ORIGIN);
  const activeCalls = catalogCalls(f).length;
  const capability = await run(enabled, 'getCapabilities'); await beforeSend(capability);
  assert.equal(readBody('getCapabilities', capability).localPlayback, true);
  f.state.unavailableTracks.add(f.tracks[2]!.id);
  const albums = await run(enabled, 'listAlbums'); await beforeSend(albums);
  const all = await run(enabled, 'listTracks'); await beforeSend(all);
  assert.deepEqual(readBody('listTracks', all).items.map(item => item.availability), ['available', 'available', 'unavailable']);
  const freshPage = await run(enabled, 'listTracks', [['limit', '1']]); await beforeSend(freshPage);
  const fresh = readBody('listTracks', freshPage); assert.equal(fresh.items[0]!.availability, 'available');
  assert.notEqual(fresh.libraryRevision, readBody('listTracks', oldPage).libraryRevision);
  const detail = await run(enabled, 'getTrack'); await beforeSend(detail);
  assert.deepEqual(readBody('getTrack', detail), fresh.items[0]);
  for (const reply of [oldAlbums, oldPage, oldDetail]) await assert.rejects(beforeSend(reply), safeError(409, 'SOURCE_CHANGED'));
  await assert.rejects(run(enabled, 'listTracks', [['limit', '1'], ['cursor', oldCursor!]]), safeError(409, 'SOURCE_CHANGED'));
  assert.equal(typeof fresh.nextCursor, 'string');
  const next = await run(enabled, 'listTracks', [['limit', '1'], ['cursor', fresh.nextCursor!]]); await beforeSend(next);
  assert.equal(readBody('listTracks', next).items[0]!.id, f.tracks[1]!.id);
  // 只改 Owner 当前可用性，不改数据库修订；发送前必须重读原第二页，不能抽查第一张专辑。
  f.state.unavailableTracks.add(f.tracks[1]!.id);
  await assert.rejects(beforeSend(next), safeError(409, 'SOURCE_CHANGED'));
  const changed = await run(enabled, 'listTracks', [['limit', '1'], ['cursor', fresh.nextCursor!]]); await beforeSend(changed);
  assert.equal(readBody('listTracks', changed).items[0]!.availability, 'unavailable');
  assert.equal(catalogCalls(f).slice(activeCalls).every(call => call.request.catalogPlaybackEnabled === true), true);
  // 激活一个002实例不能扩大另一个显式禁用或缺省001实例的目录资格。
  for (const handle of [disabled, f.handle]) {
    const page = await run(handle, 'listTracks'); await beforeSend(page);
    assert.equal(readBody('listTracks', page).items.every(item => item.availability === 'unavailable'), true);
  }
}

test('001 Main真配对/AES-GCM后使用原品牌鉴权读目录与能力，不公开未知播放能力', async t => {
  const f = fixture(t), server = await dispatch(f, 'getServer'); await beforeSend(server);
  assert.deepEqual({ ...readBody('getServer', server) }, { serverId: IDS.server, displayName: '合成 Main 目录', contractVersion: '0.1.0', environment: 'development' });
  for (const operation of ['getCapabilities', 'listAlbums', 'getAlbum', 'listTracks', 'getTrack', 'getArtwork'] as const) {
    await assert.rejects(dispatch(f, operation), safeError(401, 'UNAUTHORIZED'));
  }
  const p = await paired(f); assert.equal(p.tokens.serverId, IDS.server); assert.notEqual(p.tokens.accessToken, p.tokens.refreshToken);
  assert.equal(f.state.stored.kind, 'sealed');
  if (f.state.stored.kind !== 'sealed') throw new Error('真实认证写入未形成密文。');
  assert.equal(f.state.stored.sealed[0], 1); assert.ok(f.state.stored.sealed.length > 29);
  for (const secret of [p.body.pairingSecret, p.tokens.accessToken, p.tokens.refreshToken]) {
    assert.equal(Buffer.from(f.state.stored.sealed).includes(Buffer.from(secret)), false, '受控存储不能保存 token 明文。');
  }
  const principal = await f.handle.auth.authenticate(p.tokens.accessToken);
  assert.equal(Object.isFrozen(principal), true); await f.handle.auth.assertCurrent(principal);
  await assert.rejects(f.handle.auth.assertCurrent({ ...principal }), safeError(401, 'UNAUTHORIZED'));
  const cap = await dispatch(f, 'getCapabilities', { token: p.tokens.accessToken }); await beforeSend(cap);
  assert.deepEqual({ ...readBody('getCapabilities', cap) }, { contractVersion: '0.1.0', localPlayback: false, neteasePlayback: false,
    transcoding: false, hls: false, preparedVariants: false, qualityProfiles: [], maxConcurrentSessions: 2 });
  const albums = await dispatch(f, 'listAlbums', { token: p.tokens.accessToken }); await beforeSend(albums);
  assert.deepEqual(readBody('listAlbums', albums).items.map(value => value.id), [ALBUM]);
  const album = await dispatch(f, 'getAlbum', { token: p.tokens.accessToken }); await beforeSend(album);
  assert.equal(readBody('getAlbum', album).id, ALBUM);
  const tracks = await dispatch(f, 'listTracks', { token: p.tokens.accessToken }); await beforeSend(tracks);
  const page = readBody('listTracks', tracks); assert.equal(page.items.length, 3); assert.equal(page.nextCursor, null);
  assert.equal(Object.hasOwn(page, 'total'), false); assert.equal(page.items[0]!.availability, 'unavailable');
  const detail = await dispatch(f, 'getTrack', { token: p.tokens.accessToken }); await beforeSend(detail);
  assert.equal(readBody('getTrack', detail).sourceItemId, f.tracks[0]!.sourceItemId);
  await assertPlaybackCatalogGating(f, p.tokens);
});

test('001 Main配对只取同key同完整body原201回执，改意图或重用已消费许可拒绝', async t => {
  const f = fixture(t), p = await paired(f), writes = f.state.saves;
  const original = await dispatch(f, 'claimPairing', { body: p.body, key: p.key }); await beforeSend(original);
  assert.equal(original.status, 201); assert.deepEqual(original.body, p.reply.body); assert.equal(f.state.saves, writes);
  await assert.rejects(dispatch(f, 'claimPairing', { body: { ...p.body, deviceName: '另一个意图' }, key: p.key }), safeError(409, 'IDEMPOTENCY_CONFLICT'));
  await assert.rejects(dispatch(f, 'claimPairing', { body: p.body, key: 'pair.new-intent' }), safeError(401, 'UNAUTHORIZED'));
  assert.equal(f.state.saves, writes); assert.equal((await f.handle.auth.devices()).length, 1);
});

test('001 Main刷新返回原完整回执且只轮换一次，旧access与新key重用旧refresh均拒绝', async t => {
  const f = fixture(t), p = await paired(f), r = await refreshed(f, p.tokens), writes = f.state.saves;
  assert.notEqual(r.tokens.accessToken, p.tokens.accessToken); assert.notEqual(r.tokens.refreshToken, p.tokens.refreshToken);
  const original = await dispatch(f, 'refreshToken', { body: r.body, key: r.key }); await beforeSend(original);
  assert.deepEqual(original.body, r.reply.body); assert.equal(f.state.saves, writes);
  await assert.rejects(dispatch(f, 'refreshToken', { body: r.body, key: 'refresh.new-intent' }), safeError(401, 'UNAUTHORIZED'));
  await assert.rejects(dispatch(f, 'getCapabilities', { token: p.tokens.accessToken }), safeError(401, 'UNAUTHORIZED'));
  const live = await dispatch(f, 'listTracks', { token: r.tokens.accessToken }); await beforeSend(live);
  assert.equal(readBody('listTracks', live).items.length, 3); assert.equal(f.state.saves, writes);
});

test('001 Main设备撤销使已算出的能力、两类页、两类详情及选图在beforeSend全部拒绝', async t => {
  const f = fixture(t), p = await paired(f), replies: Mobile001BackendReply[] = [];
  for (const operation of ['getCapabilities', 'listAlbums', 'listTracks', 'getAlbum', 'getTrack', 'getArtwork'] as const) {
    replies.push(await dispatch(f, operation, { token: p.tokens.accessToken }));
  }
  await f.handle.auth.revokeDevice(p.tokens.deviceId);
  for (const reply of replies) await assert.rejects(beforeSend(reply), safeError(401, 'UNAUTHORIZED'));
  await assert.rejects(dispatch(f, 'listTracks', { token: p.tokens.accessToken }), safeError(401, 'UNAUTHORIZED'));
  assert.equal((await f.handle.auth.devices())[0]!.revoked, true);
});

test('001 Main刷新隔离旧发送与旧游标generation，新access不能接续原设备generation页', async t => {
  const f = fixture(t, 103), p = await paired(f);
  const page = await dispatch(f, 'listTracks', { token: p.tokens.accessToken, query: [['limit', '100']] }); await beforeSend(page);
  const cursor = readBody('listTracks', page).nextCursor; assert.equal(typeof cursor, 'string');
  const heldReply = await dispatch(f, 'getTrack', { token: p.tokens.accessToken });
  const r = await refreshed(f, p.tokens);
  await assert.rejects(beforeSend(page), safeError(401, 'UNAUTHORIZED'));
  await assert.rejects(beforeSend(heldReply), safeError(401, 'UNAUTHORIZED'));
  await assert.rejects(dispatch(f, 'listTracks', { token: r.tokens.accessToken,
    query: [['limit', '100'], ['cursor', cursor!]] }), safeError(409, 'CURSOR_INVALID'));
  const fresh = await dispatch(f, 'listTracks', { token: r.tokens.accessToken, query: [['limit', '100']] }); await beforeSend(fresh);
  assert.equal(readBody('listTracks', fresh).items.length, 100);
});

test('001 Main不在发送前重新发旧token：配对或刷新回包遇撤销/后续刷新被拒', async t => {
  for (const operation of ['claimPairing', 'refreshToken'] as const) {
    const f = fixture(t), p = await paired(f), issued = operation === 'claimPairing' ? p : await refreshed(f, p.tokens);
    await f.handle.auth.revokeDevice(issued.tokens.deviceId);
    await assert.rejects(beforeSend(issued.reply), safeError(401, 'UNAUTHORIZED'));
  }
  const f = fixture(t), p = await paired(f), r = await refreshed(f, p.tokens);
  await refreshed(f, r.tokens, 'refresh.second-original-intent');
  await assert.rejects(beforeSend(p.reply), safeError(401, 'UNAUTHORIZED'));
  await assert.rejects(beforeSend(r.reply), safeError(401, 'UNAUTHORIZED'));
});

test('001 Main logout真实204空回包保留送达围栏，旧授权与待发送页同时失效', async t => {
  const f = fixture(t), p = await paired(f), heldReply = await dispatch(f, 'listAlbums', { token: p.tokens.accessToken });
  const reply = await dispatch(f, 'logout', { token: p.tokens.accessToken, body: {} });
  assert.equal(reply.status, 204); assert.equal(reply.body.byteLength, 0); await beforeSend(reply);
  assert.equal(readBody('logout', reply), null);
  await assert.rejects(beforeSend(heldReply), safeError(401, 'UNAUTHORIZED'));
  await assert.rejects(dispatch(f, 'getCapabilities', { token: p.tokens.accessToken }), safeError(401, 'UNAUTHORIZED'));
  await assert.rejects(dispatch(f, 'refreshToken', { body: { refreshToken: p.tokens.refreshToken }, key: 'refresh.after-logout' }), safeError(401, 'UNAUTHORIZED'));
});

test('001 Main发送前重读libraryRevision，详情同值换键序有效而实际内容变化拒绝', async t => {
  const f = fixture(t), p = await paired(f);
  const albumPage = await dispatch(f, 'listAlbums', { token: p.tokens.accessToken });
  const trackPage = await dispatch(f, 'listTracks', { token: p.tokens.accessToken });
  f.state.revision = 'mr:fixture.2';
  for (const reply of [albumPage, trackPage]) await assert.rejects(beforeSend(reply), safeError(409, 'SOURCE_CHANGED'));
  const detail = await dispatch(f, 'getTrack', { token: p.tokens.accessToken });
  f.tracks[0] = Object.fromEntries(Object.entries(f.tracks[0]!).reverse()) as unknown as MobileTrack;
  await beforeSend(detail);
  f.tracks[0]!.title = '本轮实际不同标题';
  await assert.rejects(beforeSend(detail), safeError(409, 'SOURCE_CHANGED'));
  const album = await dispatch(f, 'getAlbum', { token: p.tokens.accessToken }); f.albums[0]!.editionLabel = '本轮实际不同发行';
  await assert.rejects(beforeSend(album), safeError(409, 'SOURCE_CHANGED'));
});

test('001 Main工作库切换、Owner epoch变化或关闭阻断旧回包而不跨库补读', async t => {
  const dataset = fixture(t), a = await paired(dataset), old = await dispatch(dataset, 'listTracks', { token: a.tokens.accessToken });
  dataset.state.datasetId = IDS.otherDataset;
  await assert.rejects(beforeSend(old), safeError(503, 'BUSY'));
  await assert.rejects(dispatch(dataset, 'getServer'), safeError(503, 'BUSY'));
  const owner = fixture(t), b = await paired(owner), oldDetail = await dispatch(owner, 'getTrack', { token: b.tokens.accessToken });
  owner.state.ownerEpoch = IDS.otherOwner; owner.state.revision = 'mr:other-owner.1';
  await assert.rejects(beforeSend(oldDetail), safeError(409, 'SOURCE_CHANGED'));
  const replaced = fixture(t), d = await paired(replaced), oldCapability = await dispatch(replaced, 'getCapabilities', { token: d.tokens.accessToken });
  replaced.state.hostCurrent = false;
  await assert.rejects(beforeSend(oldCapability), safeError(503, 'BUSY'));
  await assert.rejects(dispatch(replaced, 'getServer'), safeError(503, 'BUSY'));
  const closed = fixture(t), c = await paired(closed), cap = await dispatch(closed, 'getCapabilities', { token: c.tokens.accessToken });
  const image = await dispatch(closed, 'getArtwork', { token: c.tokens.accessToken });
  const closing = closed.handle.close(); assert.equal(closed.handle.close(), closing);
  for (const reply of [cap, image]) await assert.rejects(beforeSend(reply), safeError(503, 'BUSY'));
  await closing;
  await assert.rejects(dispatch(closed, 'getServer'), safeError(503, 'BUSY'));
});

test('001 Main abort在入场、Owner异步读后和最终发送前均阻断，不借已算好body放行', async t => {
  const f = fixture(t), p = await paired(f), start = new AbortController(); start.abort();
  const calls = f.calls.length;
  await assert.rejects(dispatch(f, 'listTracks', { token: p.tokens.accessToken, signal: start.signal }), safeError(503, 'BUSY'));
  assert.equal(f.calls.length, calls);
  const during = new AbortController(), gate = f.holdNextCatalog();
  const pending = dispatch(f, 'listTracks', { token: p.tokens.accessToken, signal: during.signal });
  try {
    await Promise.race([gate.entered, pending.then(() => { throw new Error('受控Owner读屏障之前不应已返回正文。'); }, error => { throw error; })]);
    during.abort();
  } finally { gate.release(); }
  await assert.rejects(pending, safeError(503, 'BUSY'));
  for (const operation of ['getCapabilities', 'listTracks', 'getArtwork'] as const) {
    const controller = new AbortController(), reply = await dispatch(f, operation, { token: p.tokens.accessToken, signal: controller.signal });
    controller.abort(); await assert.rejects(beforeSend(reply), safeError(503, 'BUSY'));
  }
});

test('001 Main显式all/netease给503有限错误且零目录投递，省略来源才读取local', async t => {
  const f = fixture(t), p = await paired(f), count = catalogCalls(f).length;
  for (const operation of ['listAlbums', 'listTracks'] as const) for (const source of ['all', 'netease']) {
    await assert.rejects(dispatch(f, operation, { token: p.tokens.accessToken, query: [['source', source]] }), safeError(503, 'BUSY'));
  }
  assert.equal(catalogCalls(f).length, count);
  const queries: MobileHeaderPairs[] = [[], [['source', 'local']]];
  for (const query of queries) {
    const reply = await dispatch(f, 'listTracks', { token: p.tokens.accessToken, query }); await beforeSend(reply);
    assert.equal(readBody('listTracks', reply).items.every(value => value.source === 'local'), true);
  }
});

test('001 Main选图只用已保存selection，96/256/512及默认尺寸均复制实际缩图端口输出', async t => {
  const f = fixture(t), p = await paired(f);
  for (const [query, size] of [[[], 256], [[['size', '96']], 96], [[['size', '256']], 256], [[['size', '512']], 512]] as const) {
    const reply = await dispatch(f, 'getArtwork', { token: p.tokens.accessToken, query });
    const selected = f.resizeCalls.at(-1)!; assert.equal(selected.size, size); assert.deepEqual(selected.bytes, f.state.selectedBytes);
    assert.deepEqual(reply.body, selected.output); assert.notEqual(reply.body, selected.output);
    const bytes = new Uint8Array(reply.body); selected.output.fill(0); assert.deepEqual(reply.body, bytes);
    assert.equal(reply.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1], 'image/jpeg');
    assert.equal(reply.headers.find(([name]) => name.toLowerCase() === 'content-length')?.[1], String(reply.body.byteLength));
    await beforeSend(reply); assert.equal(readBody('getArtwork', reply).contentLength, reply.body.byteLength);
  }
  const calls = f.resizeCalls.length;
  await assert.rejects(dispatch(f, 'getArtwork', { token: p.tokens.accessToken,
    path: '/mobile/v1/artwork/staged%3Aunapplied' }), safeError(404, 'INVALID_REQUEST'));
  assert.equal(f.resizeCalls.length, calls);
  const artworkRequests = f.calls.filter(value => value.kind === 'artwork');
  assert.equal(artworkRequests.slice(0, -1).every(value => value.request.artworkId === ARTWORK), true);
});

test('001 Main缩图后仍按原artwork及修订再查，selection/library变化或取消已保存选择拒绝', async t => {
  for (const change of ['selection', 'library', 'removed'] as const) {
    const f = fixture(t), p = await paired(f), reply = await dispatch(f, 'getArtwork', { token: p.tokens.accessToken });
    if (change === 'selection') f.state.selectionRevision = 'selection.2';
    if (change === 'library') f.state.revision = 'mr:fixture.2';
    if (change === 'removed') f.state.selected = false;
    await assert.rejects(beforeSend(reply), safeError(change === 'removed' ? 404 : 409,
      change === 'removed' ? 'INVALID_REQUEST' : 'SOURCE_CHANGED'));
    assert.equal(f.resizeCalls.length, 1, '发送前回查不得重新缩图掩盖旧回包。');
    const requests = f.calls.filter(value => value.kind === 'artwork'); assert.equal(requests.length, 2);
    assert.equal(requests.every(value => value.request.artworkId === ARTWORK), true);
  }
  const f = fixture(t), p = await paired(f); f.state.afterResize = () => { f.state.selectionRevision = 'selection.resize-race'; };
  const reply = await dispatch(f, 'getArtwork', { token: p.tokens.accessToken });
  await assert.rejects(beforeSend(reply), safeError(409, 'SOURCE_CHANGED'));
});

test('001 Main实际AES-GCM对密文损坏、错误密钥及修订AAD变化均fail closed且不读目录', async t => {
  for (const fault of ['tag', 'key', 'revision'] as const) {
    const f = fixture(t), p = await paired(f), count = catalogCalls(f).length;
    assert.equal(f.state.stored.kind, 'sealed');
    if (f.state.stored.kind !== 'sealed') throw new Error('受控存储缺少真实密文。');
    let handle = f.handle;
    if (fault === 'tag') f.state.stored.sealed[13] = f.state.stored.sealed[13]! ^ 1;
    if (fault === 'key') handle = f.open({ authKey: new Uint8Array(32).fill(72) });
    if (fault === 'revision') f.state.stored = { ...f.state.stored, revision: f.state.stored.revision + 1 };
    await assert.rejects(handle.backend.dispatch(prepare('listTracks', { token: p.tokens.accessToken })), safeError(503, 'BUSY'));
    assert.equal(catalogCalls(f).length, count);
  }
});

test('001 Main受控存储冷重开保持完整原配对回执，跨auth实例品牌不借用且旧backend已关闭', async t => {
  const f = fixture(t), p = await paired(f), branded = await f.handle.auth.authenticate(p.tokens.accessToken);
  const writes = f.state.saves; await f.handle.close();
  const reopened = f.open();
  await assert.rejects(reopened.auth.assertCurrent(branded), safeError(401, 'UNAUTHORIZED'));
  const request = prepare('claimPairing', { body: p.body, key: p.key });
  const receipt = await reopened.backend.dispatch(request); await beforeSend(receipt);
  assert.deepEqual(receipt.body, p.reply.body); assert.equal(f.state.saves, writes);
  const live = await reopened.backend.dispatch(prepare('listTracks', { token: p.tokens.accessToken })); await beforeSend(live);
  assert.equal(readBody('listTracks', live).items.length, 3);
  await assert.rejects(beforeSend(p.reply), safeError(503, 'BUSY'));
});

test('001 Main实际私有结果guard拒绝额外键/getter快照，不把恶意回包变成成功正文', async t => {
  for (const fault of ['extra', 'getter'] as const) {
    const f = fixture(t), p = await paired(f); let getterReads = 0;
    f.state.malformedCatalog = value => fault === 'extra' ? { ...value, path: '/synthetic/private-must-not-escape' } as unknown as MobileOwnerPrivateResult
      : Object.defineProperty({ ...value }, 'items', { enumerable: true, get() { getterReads++; return value.items; } }) as MobileOwnerPrivateResult;
    await assert.rejects(dispatch(f, 'listTracks', { token: p.tokens.accessToken }), (error: unknown) =>
      error instanceof MobileAuthPersistenceError && error.outcome === 'unknown');
    assert.equal(getterReads, 0);
  }
});
