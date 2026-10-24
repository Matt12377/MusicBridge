import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { Worker, type WorkerOptions } from 'node:worker_threads';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { createLocalAlbumOwnerService } from '../../src/collection/local-album-browser/owner-port.js';
import { createMobileLocalAlbumProjection } from '../../src/mobile/local-album-projection.js';
import { createMobileOwnerService } from '../../src/mobile/owner-service.js';
import { createMobileCatalogService } from '../../src/mobile/catalog-service.js';
import { isMobileOwnerPrivateRequest, isMobileOwnerPrivateResult } from '../../src/mobile/owner-protocol.js';
import { mobileAlbumId, mobileTrackId } from '../../src/mobile/local-album-identity.js';
import { MobileServiceError, type MobileOwnerCatalogSelectedRequest, type MobileAuthService, type MobilePrincipal } from '../../src/mobile/types.js';
import { seedMobileSqlWaveLibrary } from '../helpers/mobile-sql-owned-wave-library.js';

async function fixture(t: test.TestContext, count = 3, isolated = false) {
  assert.ok(process.env.TMPDIR?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
  const directory = await mkdtemp(path.join(process.env.TMPDIR!, 'selected-page-'));
  const repository = createCollectionRepository({ filePath: path.join(directory, 'catalog.sqlite') });
  const datasetId = randomUUID(), ownerEpoch = randomUUID();
  const seeded = await seedMobileSqlWaveLibrary(repository, datasetId, path.join(directory, '自有合成来源'), false,
    Array.from({ length: count }, (_, index) => `目录${String(index).padStart(3, '0')}/1.wav`));
  const libraries = [seeded];
  let current = true, afterMember: (() => void) | undefined, afterStructure: (() => void) | undefined;
  let parentCurrentCalls = 0, forceExact = false;
  const assertCurrent = () => { if (!current) throw new MobileServiceError(409, 'SOURCE_CHANGED'); };
  const service = createLocalAlbumOwnerService({ repository, datasetId, assertCurrent,
    ...(isolated ? { mobileSqlWorker: { databaseFile: path.join(directory, 'catalog.sqlite'),
      workerFactory: (options: WorkerOptions) => new Worker(new URL('../../src/collection/local-album-browser/mobile-sql-worker-entry.ts', import.meta.url),
        { ...options, execArgv: ['--import', 'tsx'] }) } } : {}),
    readRootViews: async () => libraries.map(library => ({ root: repository.localCatalog.root(library.rootId), label: '自有合成来源', availability: 'ONLINE' as const })),
    readArtwork: async () => ({ image: null, status: 'ready' }),
  });
  await service.privateMobile.refresh();
  const groups = service.privateMobile.current({ kind: 'groups', offset: 0, limit: 100, query: '', rootId: null, albumKey: null,
    trackId: null, editionId: null, groupHash: null });
  const tail = count > 100 ? service.privateMobile.current({ kind: 'groups', offset: 100, limit: 100, query: '', rootId: null,
    albumKey: null, trackId: null, editionId: null, groupHash: null }) : { items: [] };
  const rows = [...groups.items, ...tail.items], revision = service.privateMobile.revision();
  const rawMember = service.privateMobile.memberIdentity!;
  const localAlbums = { ...service, privateMobile: { ...service.privateMobile,
    current: (...args: Parameters<typeof service.privateMobile.current>) => { parentCurrentCalls++; return service.privateMobile.current(...args); },
    ...(service.privateMobile.structure ? { structure: async (...args: Parameters<NonNullable<typeof service.privateMobile.structure>>) => {
      const value = await service.privateMobile.structure!(...args), callback = afterStructure; afterStructure = undefined; callback?.(); return value;
    } } : {}),
    memberIdentity: (request: Parameters<typeof rawMember>[0]) => {
      if (forceExact) return null;
      const value = rawMember(request); const callback = afterMember; afterMember = undefined; callback?.(); return value;
    } } };
  const projection = createMobileLocalAlbumProjection({ collection: repository, localAlbums, datasetId, ownerEpoch, assertCurrent });
  const owner = createMobileOwnerService({ collection: repository, localAlbums, datasetId, ownerEpoch, assertCurrent });
  t.after(async () => { owner.close(); await Promise.all([service.privateMobile.closeIndex?.(), service.privateMobile.closeStructure?.()]);
    service.close(); repository.close(); await rm(directory, { recursive: true, force: true }); });
  const albumIds = rows.map(row => mobileAlbumId(datasetId, row.album.rootId, row.album.id));
  const trackIds = rows.map(row => mobileTrackId(datasetId, row.album.representativeTrackId!, row.groupHash));
  const request = (kind: 'albums' | 'tracks', ids = kind === 'albums' ? albumIds : trackIds): MobileOwnerCatalogSelectedRequest =>
    ({ kind, ids, sourceRevision: revision, serverId: 'selected.synthetic' });
  const oldItem = (kind: 'albums' | 'tracks', id: string) => projection.catalog({ operation: kind === 'albums' ? 'getAlbum' : 'getTrack',
    serverId: 'selected.synthetic', offset: 0, limit: 1, q: '', albumId: null, itemId: id, expectedRevision: null }).items[0]!;
  return { repository, service, projection, owner, datasetId, seeded, albumIds, trackIds, revision, request, oldItem,
    addLibrary: async () => { const library = await seedMobileSqlWaveLibrary(repository, datasetId, path.join(directory, '另一自有合成来源')); libraries.push(library); return library; },
    parentCurrentCalls: () => parentCurrentCalls, forceExact: () => { forceExact = true; },
    afterStructure: (callback: () => void) => { afterStructure = callback; },
    expire: () => { current = false; }, afterMember: (callback: () => void) => { afterMember = callback; } };
}
const changed = (promise: Promise<unknown>) => assert.rejects(promise,
  error => error instanceof MobileServiceError && error.status === 409 && error.code === 'SOURCE_CHANGED');

test('selected-page：100项及尾页25项按原选择次序，DTO与原真实Owner逐项投影完全一致', { timeout: 30_000 }, async t => {
  const f = await fixture(t, 125);
  for (const kind of ['tracks', 'albums'] as const) {
    const ids = [...(kind === 'tracks' ? f.trackIds : f.albumIds)].reverse();
    for (const slice of [ids.slice(0, 100), ids.slice(100)]) {
      const selected = await f.projection.selected(f.request(kind, slice));
      assert.equal(selected.sourceRevision, f.revision); assert.match(selected.libraryRevision, /^mr:/);
      assert.notEqual(selected.libraryRevision, selected.sourceRevision);
      assert.deepEqual(selected.items, slice.map(id => f.oldItem(kind, id)));
      const call = { kind: 'catalog-selected' as const, datasetId: f.datasetId, request: f.request(kind, slice) };
      assert.equal(isMobileOwnerPrivateRequest(call), true); assert.equal(isMobileOwnerPrivateResult(selected, call), true);
    }
  }
});

test('selected-page：原来源版本与公开目录版本不能互换，缺失与跨库namespace不取得DTO', async t => {
  const f = await fixture(t), request = f.request('tracks');
  await changed(f.projection.selected({ ...request, sourceRevision: f.projection.catalogRevision() }));
  await assert.rejects(f.projection.selected({ ...request, ids: [mobileTrackId(randomUUID(), f.seeded.trackIds[0]!, 'a'.repeat(64))] }),
    error => error instanceof MobileServiceError && error.status === 404);
  await assert.rejects(f.projection.selected({ ...request, ids: [mobileTrackId(f.datasetId, randomUUID(), 'a'.repeat(64))] }),
    error => error instanceof MobileServiceError && error.status === 404);
});

test('selected-page：真实Worker组头与精确回退均不回Parent分组SQL，保留原Actor完整DTO', { timeout: 20_000 }, async t => {
  const f = await fixture(t, 3, true); await f.service.privateMobile.prepare!();
  for (const exact of [false, true]) {
    if (exact) f.forceExact();
    for (const kind of ['albums', 'tracks'] as const) {
      const request = f.request(kind), selected = await f.projection.selected(request);
      const original = await Promise.all(request.ids.map(itemId => f.owner.dispatch({ kind: 'catalog', datasetId: f.datasetId,
        request: { operation: kind === 'tracks' ? 'getTrack' : 'getAlbum', serverId: request.serverId, offset: 0, limit: 1, q: '',
          albumId: null, itemId, expectedRevision: null } })));
      assert.deepEqual(selected.items, original.flatMap(value => { assert.ok('items' in value); return value.items; }));
      assert.equal(f.parentCurrentCalls(), 0, '生产选中页不得使原Owner重建分组或物化全库');
    }
  }
});

test('selected-page：真实Worker await后切库与无关主库写入不能发布迟到组头', { timeout: 20_000 }, async t => {
  for (const mutation of ['dataset', 'database'] as const) {
    const f = await fixture(t, 3, true); await f.service.privateMobile.prepare!();
    f.afterStructure(() => {
      if (mutation === 'dataset') f.expire();
      else f.repository.localCatalog.createEdition({ commandId: randomUUID(), title: '并发写入真实发行', edition: '物理水位验证' });
    });
    await changed(f.projection.selected(f.request('tracks'))); assert.equal(f.parentCurrentCalls(), 0);
  }
});

test('selected-page：yield后切库、来源撤销与元数据版本漂移均拒绝整页', async t => {
  for (const mutation of ['dataset', 'source', 'metadata'] as const) {
    const f = await fixture(t);
    f.afterMember(() => setImmediate(() => {
      if (mutation === 'dataset') f.expire();
      else if (mutation === 'source') f.repository.sources.revoke({ commandId: randomUUID(), id: f.seeded.sourceId });
      else f.repository.localCatalog.observeMetadata({ commandId: randomUUID(), trackId: f.seeded.trackIds[0]!, source: 'synthetic',
        parserVersion: '选中页变更验证-v1', fields: { title: '变更后的真实标题' } });
    }));
    await changed(f.projection.selected(f.request('tracks')));
  }
});

test('selected-page：无关主库物理写入同样使迟到页失效，不放宽成只比较逻辑revision', async t => {
  const f = await fixture(t);
  f.afterMember(() => setImmediate(() => f.repository.localCatalog.createEdition({ commandId: randomUUID(), title: '无关真实发行', edition: '物理水位验证' })));
  await changed(f.projection.selected(f.request('tracks')));
});

test('selected-page：播放开关沿原Owner核真实文件资格，完整DTO与旧目录相同', async t => {
  const f = await fixture(t);
  for (const enabled of [false, true]) {
    const request = { ...f.request('tracks'), catalogPlaybackEnabled: enabled };
    const result = await f.owner.dispatch({ kind: 'catalog-selected', datasetId: f.datasetId, request });
    assert.ok('items' in result);
    const original = await Promise.all(f.trackIds.map(itemId => f.owner.dispatch({ kind: 'catalog', datasetId: f.datasetId,
      request: { operation: 'getTrack', serverId: request.serverId, offset: 0, limit: 1, q: '', albumId: null, itemId,
        expectedRevision: null, catalogPlaybackEnabled: enabled } })));
    assert.deepEqual(result.items, original.flatMap(value => { assert.ok('items' in value); return value.items; }));
    assert.ok(result.items.every(item => 'availability' in item && item.availability === (enabled ? 'available' : 'unavailable')));
  }
});

test('selected-page：旧发行仍需唯一真实成员关系，多目录发行不能冒充一个专辑', async t => {
  const f = await fixture(t), edition = f.repository.localCatalog.createEdition({ commandId: randomUUID(), title: '真实合成发行', edition: '受控版' });
  const link = (index: number) => f.repository.localCatalog.linkEditionTrack({ commandId: randomUUID(), editionId: edition.id,
    trackId: f.seeded.trackIds[index]!, disc: 1, trackNumber: index + 1, sequence: index + 1 });
  link(0); await f.service.privateMobile.refresh();
  const id = `lt:${f.datasetId}:${f.seeded.trackIds[0]}:${edition.id}`;
  const request = { ...f.request('tracks', [id]), sourceRevision: f.service.privateMobile.revision() };
  assert.deepEqual((await f.projection.selected(request)).items, [f.oldItem('tracks', id)]);
  const other = await f.addLibrary();
  f.repository.localCatalog.linkEditionTrack({ commandId: randomUUID(), editionId: edition.id, trackId: other.trackIds[0]!, disc: 1, trackNumber: 2, sequence: 2 });
  await f.service.privateMobile.refresh();
  assert.throws(() => f.oldItem('tracks', id), error => error instanceof MobileServiceError && error.status === 409,
    '先证明原目录也按多个实际分组拒绝该旧发行');
  await changed(f.projection.selected({ ...request, sourceRevision: f.service.privateMobile.revision() }));
});

test('selected-page：Main目录服务仅一次页调用，等待后撤销、错序及取消不返回DTO', async t => {
  const f = await fixture(t), p: MobilePrincipal = { serverId: 'selected.synthetic', datasetId: f.datasetId, accountDomain: 'local:synthetic',
    deviceId: 'device.synthetic', deviceEpoch: 1, generation: 1, accessTokenHash: 'a'.repeat(64), accessExpiresAt: '2099-01-01T00:00:00Z' };
  let revoked = false, revokeOnReply = false, reverse = false, cancel: AbortController | undefined, reads = 0;
  const auth = { assertCurrent: async (value: MobilePrincipal) => { assert.equal(value, p); if (revoked) throw new MobileServiceError(401, 'UNAUTHORIZED'); } } as MobileAuthService;
  const catalog = createMobileCatalogService({ serverId: p.serverId, datasetId: p.datasetId, cursorKey: new Uint8Array(32).fill(8), auth,
    port: { read: async () => { throw Error('不能逐条回读'); }, artwork: async () => { throw Error('本场景不读图'); },
      selected: async request => {
        reads++; const value = await f.projection.selected(request); cancel?.abort(); if (revokeOnReply) revoked = true;
        return { ...value, items: reverse ? [...value.items].reverse() : value.items };
      } } });
  const query = { kind: 'tracks' as const, ids: f.trackIds, sourceRevision: f.revision };
  assert.equal((await catalog.selected(query, p)).length, 3); assert.equal(reads, 1);
  reverse = true; await changed(catalog.selected(query, p)); reverse = false;
  cancel = new AbortController(); await assert.rejects(catalog.selected(query, p, cancel.signal),
    error => error instanceof MobileServiceError && error.status === 503 && error.code === 'BUSY');
  cancel = undefined; revokeOnReply = true;
  await assert.rejects(catalog.selected(query, p), error => error instanceof MobileServiceError && error.status === 401);
  const before = reads;
  await assert.rejects(catalog.selected(query, p), error => error instanceof MobileServiceError && error.status === 401);
  assert.equal(reads, before, '已撤销设备不能进入Owner读口');
});

test('selected-page：Owner等待refresh期间捕获原请求，不借用可变输入偷换选择', async t => {
  const f = await fixture(t), request = f.request('albums', [f.albumIds[0]!]);
  const operation = f.owner.dispatch({ kind: 'catalog-selected', datasetId: f.datasetId, request });
  (request.ids as string[])[0] = f.albumIds[1]!;
  const result = await operation;
  assert.equal('kind' in result && result.kind === 'mobile-error', true, '迟到边界必须拒绝原请求被偷换');
});

test('selected-page：私有协议拒绝重复、稀疏、超100、额外字段、getter及输出错序', async t => {
  const f = await fixture(t), call = { kind: 'catalog-selected' as const, datasetId: f.datasetId, request: f.request('albums') };
  assert.equal(isMobileOwnerPrivateRequest(call), true);
  for (const request of [
    { ...call.request, ids: [f.albumIds[0], f.albumIds[0]] }, { ...call.request, ids: new Array(2) },
    { ...call.request, ids: Array.from({ length: 101 }, (_, i) => 'la:invalid:' + i) },
    { ...call.request, unexpected: true }, { ...call.request, get ids() { throw Error('不能执行getter'); } },
  ]) assert.equal(isMobileOwnerPrivateRequest({ ...call, request }), false);
  const result = await f.projection.selected(call.request);
  assert.equal(isMobileOwnerPrivateResult(result, call), true);
  assert.equal(isMobileOwnerPrivateResult({ ...result, items: [...result.items].reverse() }, call), false);
  assert.equal(isMobileOwnerPrivateResult({ ...result, datasetId: randomUUID() }, call), false);
  assert.equal(isMobileOwnerPrivateResult({ ...result, sourceRevision: 'other:revision' }, call), false);
});
