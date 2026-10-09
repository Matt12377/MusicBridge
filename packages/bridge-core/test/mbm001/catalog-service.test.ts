import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MobileAlbum, MobileSearchQuery, MobileTrack } from '@music-bridge/contracts';
import { createMobileCatalogService, projectMobileOwnerLocalTrack } from '../../src/mobile/catalog-service.js';
import {
  MobileServiceError, type MobileAuthService, type MobileCatalogReadPort,
  type MobileOwnerArtworkSnapshot, type MobileOwnerCatalogRequest,
  type MobileOwnerCatalogSnapshot, type MobileOwnerLocalTrackFacts, type MobilePrincipal,
} from '../../src/mobile/types.js';

const clock = Date.UTC(2030, 0, 1);
const ids = {
  dataset: '10000000-0000-4000-8000-000000000001',
  track: '10000000-0000-4000-8000-000000000002',
  asset: '10000000-0000-4000-8000-000000000003',
  edition: '10000000-0000-4000-8000-000000000004',
  root: '10000000-0000-4000-8000-000000000005',
  sourceRoot: '10000000-0000-4000-8000-000000000006',
  segment: '10000000-0000-4000-8000-000000000007',
};
const principal = (): MobilePrincipal => ({ serverId: 'server.1', deviceId: 'device.1', datasetId: ids.dataset,
  accountDomain: 'account.1', deviceEpoch: 1, generation: 1, accessTokenHash: 'a'.repeat(64),
  accessExpiresAt: new Date(clock + 900_000).toISOString() });
const safeError = (status: MobileServiceError['status'], code: MobileServiceError['code']) =>
  (error: unknown): boolean => error instanceof MobileServiceError && error.status === status && error.code === code && error.retryable === false;

function track(index: number, albumId = 'album.1'): MobileTrack {
  return { id: `lt.fixture.${index}`, title: '同名合成曲目', artists: ['受控作者'], albumId, source: 'local',
    sourceItemId: `ls.fixture.${index}`, versionId: `lv.fixture.${index}`, contentRevision: `lc.fixture.${index}`,
    editionLabel: '受控发行', durationMs: 1_000,
    audio: { codec: 'flac', container: 'flac', sampleRateHz: 96_000, channels: 2, bitsPerSample: 24 }, availability: 'unavailable' };
}

/** 只替代私有Owner端口和授权时钟；不证明SQLite、真实文件、原生缩图或设备资格。 */
function fixture(count = 213) {
  const authenticated = principal(), brands = new WeakSet<MobilePrincipal>([authenticated]);
  const tracks = Array.from({ length: count }, (_, index) => track(index));
  const albums: MobileAlbum[] = [
    { id: 'album.1', title: '同名合成专辑', artists: ['受控作者'], source: 'local', editionLabel: '甲', trackCount: count },
    { id: 'album.2', title: '同名合成专辑', artists: ['受控作者'], source: 'local', editionLabel: '乙', trackCount: 0 },
  ];
  const requests: MobileOwnerCatalogRequest[] = [];
  const state: {
    now: number; ownerEpoch: string; revision: string; generation: number; deviceEpoch: number; revoked: boolean;
    authChecks: number; artworkReads: number; requireBrand: boolean; authPrincipals: MobilePrincipal[];
    transformRead: ((value: MobileOwnerCatalogSnapshot, request: MobileOwnerCatalogRequest) => MobileOwnerCatalogSnapshot) | null;
    afterRead: (() => void) | null; afterArtwork: (() => void) | null;
    artwork: MobileOwnerArtworkSnapshot;
  } = { now: clock, ownerEpoch: 'owner.1', revision: 'library.1', generation: 1, deviceEpoch: 1, revoked: false,
    authChecks: 0, artworkReads: 0, requireBrand: false, authPrincipals: [], transformRead: null, afterRead: null, afterArtwork: null,
    // 这里只验证二进制选择回包与授权围栏，四字节标记不冒充可原生解码图片。
    artwork: { datasetId: ids.dataset, ownerEpoch: 'owner.1', libraryRevision: 'library.1', artworkId: 'artwork.1',
      selectionRevision: 'selection.1', contentType: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) } };
  const unused = async (): Promise<never> => { throw new Error('本项受控unit禁止调用认证写入口。'); };
  const auth: MobileAuthService = { serverInfo: unused, issuePairing: unused, devices: unused, revokeDevice: unused,
    claim: unused, refresh: unused, authenticate: unused, logout: unused, close: unused,
    async assertCurrent(value) {
      state.authChecks++; state.authPrincipals.push(value);
      if (state.requireBrand && !brands.has(value) || state.revoked || value.generation !== state.generation || value.deviceEpoch !== state.deviceEpoch) throw new MobileServiceError(401, 'UNAUTHORIZED');
    } };
  const port: MobileCatalogReadPort = {
    async read(request) {
      requests.push({ ...request });
      const albumOperation = request.operation === 'listAlbums' || request.operation === 'getAlbum';
      const rows = (albumOperation ? albums : tracks).filter(row => (!request.itemId || row.id === request.itemId)
        && (!request.albumId || ('albumId' in row ? row.albumId : row.id) === request.albumId)
        && (!request.q || row.title.includes(request.q)));
      let value: MobileOwnerCatalogSnapshot = { datasetId: ids.dataset, ownerEpoch: state.ownerEpoch, libraryRevision: state.revision,
        operation: request.operation, offset: request.offset, limit: request.limit, total: rows.length,
        items: rows.slice(request.offset, request.offset + request.limit) };
      if (state.transformRead) value = state.transformRead(value, request);
      state.afterRead?.();
      return value;
    },
    async artwork(request) {
      assert.equal(request.serverId, 'server.1'); assert.equal(request.artworkId, 'artwork.1');
      state.artworkReads++; state.afterArtwork?.(); return state.artwork;
    },
  };
  const service = createMobileCatalogService({ port, auth, serverId: 'server.1', datasetId: ids.dataset,
    cursorKey: new Uint8Array(32).fill(7), now: () => state.now });
  return { service, state, requests, tracks, albums, principal: authenticated };
}

function projectionFacts(segmented = true): MobileOwnerLocalTrackFacts {
  const segment = segmented ? { id: ids.segment, startFrame: '48000', endFrameExclusive: '96000', timebaseHz: 48_000 } : null;
  return {
    detail: {
      track: { id: ids.track, assetId: ids.asset, selectionRevision: '1', segment },
      asset: { id: ids.asset, libraryRootId: ids.root, sourceRootId: ids.sourceRoot, rootRevision: '1', fileRevision: '1',
        locationRevision: '1', sampleFrames: '480000', timebaseHz: 48_000 },
      metadata: { raw: { title: '受控完整事实', artist: '受控作者' }, override: null, effective: { title: '受控完整事实', artist: '受控作者' } },
      versionTokens: [], editions: [{ id: ids.edition, title: '已登记发行', edition: '受控版', revision: '1' }],
      fileParameters: { container: 'FLAC', codec: 'FLAC', lossless: true, sampleRateHz: 48_000, channels: 2,
        bitsPerSample: 24, durationMs: 9_999_000, evidence: 'bounded-parser-reported' },
    },
    binding: { localTrackId: ids.track, assetId: ids.asset, fileRevision: '1', selectionRevision: '1', segmentId: segment?.id ?? null,
      editionId: ids.edition, editionRevision: '1', trackId: `lt:${ids.dataset}:${ids.track}:${ids.edition}`,
      sourceItemId: `ls:${ids.dataset}:${ids.asset}`, albumId: `la:${ids.dataset}:${ids.edition}`,
      versionId: `lv:${'b'.repeat(64)}`, contentRevision: `lc:${'c'.repeat(64)}` },
    projection: { title: '受控完整事实', artists: ['受控作者'], editionLabel: '受控版', availability: 'unavailable' },
  };
}

test('001目录超过100项的三页完整读出，不丢同名曲目或伪造公开total', async () => {
  const f = fixture(), idsRead: string[] = []; let next: string | null = null;
  for (const expectedSize of [100, 100, 13]) {
    const page = await f.service.listTracks({ limit: 100, ...(next === null ? {} : { cursor: next }) }, f.principal);
    assert.equal(page.items.length, expectedSize); assert.equal(page.libraryRevision, 'library.1');
    assert.deepEqual(Object.keys(page).sort(), ['items', 'libraryRevision', 'nextCursor']);
    idsRead.push(...page.items.map(value => value.id)); next = page.nextCursor;
  }
  assert.equal(next, null); assert.equal(idsRead.length, 213); assert.equal(new Set(idsRead).size, 213);
  assert.deepEqual(idsRead, f.tracks.map(value => value.id));
  assert.deepEqual(f.requests.map(value => value.offset), [0, 100, 200]);
  assert.deepEqual(f.requests.map(value => value.expectedRevision), [null, 'library.1', 'library.1']);
});

test('001同名发行保留独立ID，详情与album过滤不跨发行合并', async () => {
  const f = fixture(3); f.tracks[2]!.albumId = 'album.2';
  const albums = await f.service.listAlbums({}, f.principal);
  assert.deepEqual(albums.items.map(value => value.id), ['album.1', 'album.2']); assert.equal(albums.items[0]!.title, albums.items[1]!.title);
  assert.equal((await f.service.getAlbum('album.2', f.principal)).editionLabel, '乙');
  const tracks = await f.service.listTracks({ albumId: 'album.2' }, f.principal);
  assert.deepEqual(tracks.items.map(value => value.id), ['lt.fixture.2']);
  assert.equal((await f.service.getTrack('lt.fixture.0', f.principal)).sourceItemId, 'ls.fixture.0');
});

test('001搜索按200码点和100条闭请求约束，保留字面搜索并拒绝getter', async () => {
  const f = fixture(1), q = '𠮷'.repeat(200); f.tracks[0]!.title = q;
  assert.equal((await f.service.listTracks({ q, limit: 100 }, f.principal)).items.length, 1);
  f.tracks[0]!.title = '字面 %_ 和 https://example.invalid/';
  assert.equal((await f.service.listTracks({ q: '%_' }, f.principal)).items.length, 1);
  assert.equal(f.requests.at(-1)!.q, '%_');
  assert.equal((await f.service.listTracks({ q: 'https://example.invalid/' }, f.principal)).items.length, 1);
  for (const invalid of [{ q: '𠮷'.repeat(201) }, { limit: 0 }, { limit: 101 }, { extra: true }, { q: null }]) {
    await assert.rejects(f.service.listTracks(invalid as unknown as MobileSearchQuery, f.principal), safeError(400, 'INVALID_REQUEST'));
  }
  await assert.rejects(f.service.listAlbums({ albumId: 'album.1' }, f.principal), safeError(400, 'INVALID_REQUEST'));
  let accesses = 0; const getter = Object.defineProperty({}, 'q', { enumerable: true, get() { accesses++; return ''; } });
  await assert.rejects(f.service.listTracks(getter, f.principal), safeError(400, 'INVALID_REQUEST')); assert.equal(accesses, 0);
});

test('001默认来源仅local，显式all或netease返回有限错误且不偷偷降级读取', async () => {
  const f = fixture(1); assert.equal((await f.service.listTracks({}, f.principal)).items[0]!.source, 'local');
  const reads = f.requests.length;
  for (const source of ['all', 'netease'] as const) await assert.rejects(f.service.listTracks({ source }, f.principal), safeError(503, 'BUSY'));
  assert.equal(f.requests.length, reads);
  await assert.rejects(f.service.listTracks({ source: 'roon' } as unknown as MobileSearchQuery, f.principal), safeError(400, 'INVALID_REQUEST'));
});

test('001游标跨设备账号过滤页宽或方法拒绝，篡改不进入Owner读取', async () => {
  const f = fixture(), page = await f.service.listTracks({ limit: 100 }, f.principal); assert.ok(page.nextCursor);
  const token = page.nextCursor, reads = f.requests.length;
  for (const p of [{ ...f.principal, deviceId: 'device.2' }, { ...f.principal, accountDomain: 'account.2' }]) {
    await assert.rejects(f.service.listTracks({ limit: 100, cursor: token }, p), safeError(409, 'CURSOR_INVALID'));
  }
  for (const query of [{ limit: 99 }, { q: '不同过滤' }, { albumId: 'album.2' }]) {
    await assert.rejects(f.service.listTracks({ limit: 100, ...query, cursor: token }, f.principal), safeError(409, 'CURSOR_INVALID'));
  }
  await assert.rejects(f.service.listAlbums({ limit: 100, cursor: token }, f.principal), safeError(409, 'CURSOR_INVALID'));
  const tampered = `${token.slice(0, -2)}${token.at(-2) === 'A' ? 'B' : 'A'}${token.at(-1)}`;
  await assert.rejects(f.service.listTracks({ limit: 100, cursor: tampered }, f.principal), safeError(409, 'CURSOR_INVALID'));
  assert.equal(f.requests.length, reads);
});

test('001Owner快照的操作窗口总数与独立ID必须完整一致，不以缺项伪装末页', async () => {
  const faults: Array<(value: MobileOwnerCatalogSnapshot) => MobileOwnerCatalogSnapshot> = [
    value => ({ ...value, operation: 'listAlbums' }), value => ({ ...value, offset: 1 }), value => ({ ...value, limit: 2 }),
    value => ({ ...value, total: 3 }), value => ({ ...value, items: [] }), value => ({ ...value, items: [value.items[0]!, value.items[0]!] }),
  ];
  for (const fault of faults) {
    const f = fixture(2); f.state.transformRead = fault;
    await assert.rejects(f.service.listTracks({ limit: 100 }, f.principal), safeError(409, 'SOURCE_CHANGED'));
  }
  const f = fixture(2); f.state.transformRead = value => ({ ...value, extra: true } as MobileOwnerCatalogSnapshot);
  await assert.rejects(f.service.listTracks({}, f.principal), safeError(503, 'BUSY'));
});

test('001库修订工作库或Owner世代变化使旧页失效，原cursor不重签或续期', async () => {
  for (const change of ['revision', 'ownerEpoch', 'dataset'] as const) {
    const f = fixture(), first = await f.service.listTracks({ limit: 100 }, f.principal); assert.ok(first.nextCursor);
    if (change === 'revision') f.state.revision = 'library.2';
    else if (change === 'ownerEpoch') f.state.ownerEpoch = 'owner.2';
    else f.state.transformRead = value => ({ ...value, datasetId: 'dataset.other' });
    await assert.rejects(f.service.listTracks({ limit: 100, cursor: first.nextCursor }, f.principal), safeError(409, 'SOURCE_CHANGED'));
    assert.equal(f.requests.at(-1)!.expectedRevision, 'library.1');
  }
});

test('001refresh或撤销在读取前后生效，新授权不能借用旧世代cursor', async () => {
  const f = fixture(), first = await f.service.listTracks({ limit: 100 }, f.principal); assert.ok(first.nextCursor);
  f.state.generation = 2;
  await assert.rejects(f.service.listTracks({ limit: 100, cursor: first.nextCursor }, f.principal), safeError(401, 'UNAUTHORIZED'));
  await assert.rejects(f.service.listTracks({ limit: 100, cursor: first.nextCursor }, { ...f.principal, generation: 2 }), safeError(409, 'CURSOR_INVALID'));
  const revoked = fixture(1); revoked.state.afterRead = () => { revoked.state.revoked = true; };
  await assert.rejects(revoked.service.getTrack('lt.fixture.0', revoked.principal), safeError(401, 'UNAUTHORIZED'));
  assert.equal(revoked.requests.length, 1); assert.ok(revoked.state.authChecks >= 2);
  const before = fixture(1); before.state.revoked = true;
  await assert.rejects(before.service.listTracks({}, before.principal), safeError(401, 'UNAUTHORIZED')); assert.equal(before.requests.length, 0);
});

test('001目录和选图保留原授权对象品牌，安全值snapshot不替代凭证', async () => {
  const f = fixture(1); f.state.requireBrand = true;
  await f.service.listTracks({}, f.principal); await f.service.getTrack('lt.fixture.0', f.principal);
  await f.service.listAlbums({}, f.principal); await f.service.getAlbum('album.1', f.principal);
  await f.service.artwork('artwork.1', f.principal);
  assert.ok(f.state.authPrincipals.length >= 12);
  for (const value of f.state.authPrincipals) assert.equal(value, f.principal);
  await assert.rejects(f.service.listTracks({}, { ...f.principal }), safeError(401, 'UNAUTHORIZED'));
});

test('001真实事实投影接受Owner派生ID，segment用精确frame而非整文件展示时长', () => {
  const facts = projectionFacts(), projected = projectMobileOwnerLocalTrack(facts);
  assert.equal(projected.id, facts.binding.trackId); assert.equal(projected.sourceItemId, facts.binding.sourceItemId);
  assert.equal(projected.albumId, facts.binding.albumId); assert.equal(projected.durationMs, 1_000);
  assert.deepEqual(projected.audio, Object.assign(Object.create(null) as Record<string, unknown>, {
    codec: 'flac', container: 'flac', sampleRateHz: 48_000, channels: 2, bitsPerSample: 24 }));
  const unknownWholeDuration = projectionFacts(); unknownWholeDuration.detail.fileParameters!.durationMs = null;
  assert.equal(projectMobileOwnerLocalTrack(unknownWholeDuration).durationMs, 1_000);
  const halfFrame = projectionFacts(); halfFrame.detail.track.segment!.startFrame = '0'; halfFrame.detail.track.segment!.endFrameExclusive = '24';
  assert.equal(projectMobileOwnerLocalTrack(halfFrame).durationMs, 1);
});

test('001无发行音频或segment轴缺证整项报有限错误，不猜整文件或伪造专辑', () => {
  const faults: Array<(facts: MobileOwnerLocalTrackFacts) => void> = [
    facts => { facts.detail.editions = []; }, facts => { facts.detail.fileParameters = null; },
    facts => { facts.detail.asset.sampleFrames = null; facts.detail.asset.timebaseHz = null; },
    facts => { facts.detail.asset.timebaseHz = 44_100; }, facts => { facts.detail.track.segment!.endFrameExclusive = '480001'; },
    facts => { facts.binding.fileRevision = '2'; }, facts => { facts.binding.segmentId = ids.asset; },
    facts => { facts.binding.editionRevision = '2'; }, facts => { facts.detail.fileParameters!.bitsPerSample = null; },
  ];
  for (const fault of faults) { const facts = projectionFacts(); fault(facts); assert.throws(() => projectMobileOwnerLocalTrack(facts), safeError(503, 'BUSY')); }
  const whole = projectionFacts(false); whole.detail.fileParameters!.durationMs = null;
  assert.throws(() => projectMobileOwnerLocalTrack(whole), safeError(503, 'BUSY'));
});

test('001纯位置根修订不重造内容身份，同曲链接另一发行保留独立条目', () => {
  const facts = projectionFacts(), before = projectMobileOwnerLocalTrack(facts);
  facts.detail.asset.rootRevision = '2'; facts.detail.asset.locationRevision = '9'; facts.detail.asset.libraryRootId = ids.sourceRoot;
  const after = projectMobileOwnerLocalTrack(facts); assert.deepEqual(after, before);
  const otherEdition = '10000000-0000-4000-8000-000000000008';
  facts.detail.editions.push({ id: otherEdition, title: '另一真实登记发行', edition: '乙', revision: '1' });
  facts.binding.editionId = otherEdition; facts.binding.albumId = `la:${ids.dataset}:${otherEdition}`;
  facts.binding.trackId = `lt:${ids.dataset}:${ids.track}:${otherEdition}`;
  const linked = projectMobileOwnerLocalTrack(facts);
  assert.notEqual(linked.id, before.id); assert.notEqual(linked.albumId, before.albumId);
  assert.equal(linked.sourceItemId, before.sourceItemId); assert.equal(linked.versionId, before.versionId);
});

test('001完整响应预算与未知领域字段拒绝猜值，允许入站扩展只输出既定白名单', async () => {
  const oversized = fixture(1); oversized.tracks[0]!.title = 'x'.repeat(2 * 1024 * 1024);
  await assert.rejects(oversized.service.listTracks({}, oversized.principal), safeError(503, 'CONTENT_LIMIT_EXCEEDED'));
  for (const fault of ['audio', 'album', 'source'] as const) {
    const f = fixture(1); const value = f.tracks[0]!;
    if (fault === 'audio') (value as unknown as Record<string, unknown>).audio = null;
    else if (fault === 'album') (value as unknown as Record<string, unknown>).albumId = null;
    else value.source = 'netease';
    await assert.rejects(f.service.listTracks({}, f.principal), safeError(503, 'BUSY'));
  }
  const extended = fixture(1); Object.assign(extended.tracks[0]!, { futureHint: { safe: true } });
  const accepted = await extended.service.getTrack('lt.fixture.0', extended.principal); assert.equal(Object.hasOwn(accepted, 'futureHint'), false);
});

test('001空库是完整空页，未找到详情与坏详情窗口不混为成功', async () => {
  const f = fixture(0), page = await f.service.listTracks({}, f.principal);
  assert.deepEqual(page.items, []); assert.equal(page.nextCursor, null);
  await assert.rejects(f.service.getTrack('lt.absent', f.principal), safeError(404, 'SOURCE_CHANGED'));
  const wrong = fixture(1); wrong.state.transformRead = value => ({ ...value, items: [{ ...value.items[0]!, id: 'lt.wrong' }] });
  await assert.rejects(wrong.service.getTrack('lt.fixture.0', wrong.principal), safeError(409, 'SOURCE_CHANGED'));
  await assert.rejects(f.service.getTrack('lt.absent\n', f.principal), safeError(400, 'INVALID_REQUEST'));
});

test('001选图只返回独立有限bytes且读后撤权拒绝，不将标记图片冒充三尺寸原生解码', async () => {
  const f = fixture(), selected = await f.service.artwork('artwork.1', f.principal);
  f.state.artwork.bytes[0] = 0; assert.equal(selected.bytes[0], 0xff); assert.notEqual(selected.bytes, f.state.artwork.bytes);
  const revoked = fixture(); revoked.state.afterArtwork = () => { revoked.state.revoked = true; };
  await assert.rejects(revoked.service.artwork('artwork.1', revoked.principal), safeError(401, 'UNAUTHORIZED'));
  const replaced = fixture(); replaced.state.artwork.artworkId = 'artwork.other';
  await assert.rejects(replaced.service.artwork('artwork.1', replaced.principal), safeError(409, 'SOURCE_CHANGED'));
  const oversized = fixture(); oversized.state.artwork.bytes = new Uint8Array(2 * 1024 * 1024 + 1);
  await assert.rejects(oversized.service.artwork('artwork.1', oversized.principal), safeError(503, 'CONTENT_LIMIT_EXCEEDED'));
  const accessor = fixture(); let accesses = 0;
  Object.defineProperty(accessor.state.artwork, 'bytes', { enumerable: true, get() { accesses++; return new Uint8Array([0xff, 0xd8, 0xff, 0xd9]); } });
  await assert.rejects(accessor.service.artwork('artwork.1', accessor.principal), safeError(503, 'BUSY')); assert.equal(accesses, 0);
  const binary = fixture(); let binaryAccesses = 0;
  for (const name of ['byteLength', 'constructor', Symbol.iterator]) Object.defineProperty(binary.state.artwork.bytes, name,
    { get() { binaryAccesses++; throw new Error('受控binary getter不得执行。'); } });
  const copied = await binary.service.artwork('artwork.1', binary.principal);
  assert.deepEqual(copied.bytes, new Uint8Array([0xff, 0xd8, 0xff, 0xd9])); assert.equal(binaryAccesses, 0);
});
