import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import promises, { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { mobileCatalogResponseSnapshot } from '@music-bridge/contracts';
import type { MobileAlbum, MobileFavoriteAlbumState, MobilePersonalPlaylistReceipt, MobileRequestMap, MobileTrack, MobileTrackSelection } from '@music-bridge/contracts';
import type { MobileContentScope } from '../../src/mobile/content-types.js';
import type { MobileContentOwnerDispatch, MobileContentOwnerRequest, MobileContentOwnerResult, MobileContentOwnerSnapshot } from '../../src/mobile/owner-content-protocol.js';
import { isMobileOwnerPrivateRequest, isMobileOwnerPrivateResult } from '../../src/mobile/owner-protocol.js';
import type { DatasetProjectionCommand, DatasetProjectionCommandPayloads, DatasetProjectionCommandResults, DatasetProjectionPort } from '../../src/collection/dataset-owner-protocol.js';
import type { LocalLibraryManagementBindingRecord, LocalLibraryManagementOperationRecord } from '../../src/collection/local-library-workbench/owner-journal.js';
import { audioFixture, loadFreshMetadataReader } from '../helpers/mbrs003-audio-fixtures.js';

const limits = { stateBytes: 16 * 1024 * 1024, receipts: 1024, albums: 10000, favoriteTracks: 100000, playlists: 10000, playlistTracks: 100000 };
const selected = (track: MobileTrack): MobileTrackSelection => ({ trackId: track.id, source: track.source, versionId: track.versionId, contentRevision: track.contentRevision });
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
/** 真Reader/Scanner创建三目录五资产；不借发行关系制造canonical目录。 */
async function realDirectoryFixture(t: TestContext) {
  const inputs = await audioFixture(t); await loadFreshMetadataReader();
  const repositoryModule = await import(new URL('../../dist/collection/repository.js', import.meta.url).href) as typeof import('../../src/collection/repository.js');
  const admissionModule = await import(new URL('../../dist/library/scan-read-admission.js', import.meta.url).href) as typeof import('../../src/library/scan-read-admission.js');
  const filesModule = await import(new URL('../../dist/recording/source-files.js', import.meta.url).href) as typeof import('../../src/recording/source-files.js');
  const ownerModule = await import(new URL('../../dist/mobile/owner-service.js', import.meta.url).href) as typeof import('../../src/mobile/owner-service.js');
  const domainModule = await import(new URL('../../dist/collection/dataset-domain.js', import.meta.url).href) as typeof import('../../src/collection/dataset-domain.js');
  const maintenanceModule = await import(new URL('../../dist/recording/backup-workflow-store.js', import.meta.url).href) as typeof import('../../src/recording/backup-workflow-store.js');
  const directory = path.join(inputs.directory, 'directory-content'), media = path.join(directory, 'media');
  await mkdir(directory, { mode: 0o700 }); await mkdir(media, { mode: 0o700 });
  const directories = [{ relative: '目录甲', count: 2 }, { relative: '目录乙', count: 2 }, { relative: '目录丙', count: 1 }];
  const original = await inputs.bytes('core-wav'), originals = new Map<string, Awaited<ReturnType<typeof lstat>>>();
  for (const item of directories) {
    await mkdir(path.join(media, item.relative), { mode: 0o700 });
    for (let index = 0; index < item.count; index++) {
      const relative = `${item.relative}/${index + 1}.wav`, file = path.join(media, relative);
      await writeFile(file, original, { mode: 0o600, flag: 'wx' }); originals.set(relative, await lstat(file));
    }
  }
  const repository = repositoryModule.createCollectionRepository({ filePath: path.join(directory, 'collection.sqlite') });
  const datasetId = randomUUID(), ownerEpoch = randomUUID(), serverId = `server:${randomUUID()}`;
  const source = repository.sources.authorize(randomUUID(), await filesModule.authorizeSourceDirectory(media));
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
  let alive = true, closing: Promise<void> | undefined;
  const assertCurrent = () => { assert.ok(alive); repository.readonlySnapshotStamp(); };
  const admission = admissionModule.createScanReadAdmission({ isBusy: () => false }), context = { datasetId, epoch: ownerEpoch };
  const projection: DatasetProjectionPort = {
    async call<C extends DatasetProjectionCommand>(command: C, payload: DatasetProjectionCommandPayloads[C]): Promise<DatasetProjectionCommandResults[C]> {
      let value: unknown;
      if (command === 'scanReadAcquire') value = admission.acquire(context);
      else if (command === 'scanReadWatchRevocation') value = await admission.watchRevocation(context, (payload as { permitId: string }).permitId);
      else if (command === 'scanReadRelease') value = admission.release(context, (payload as { permitId: string }).permitId);
      else throw new Error('目录内容测试只接原扫描准入，不提供Provider或假事实。');
      return value as DatasetProjectionCommandResults[C];
    },
  };
  const maintenance = maintenanceModule.createBackupWorkflowStore({ filePath: ':memory:' });
  // Scanner、目录和内容服务都由原生产Domain唯一安装，沿同一投影与SQLite连接。
  const identity = { datasetId, assertCurrent };
  const domain = domainModule.createDatasetDomain({ collectionRepository: repository, backupWorkflowStore: maintenance,
    collectionDatasetIdentity: identity, localSourceEpoch: ownerEpoch, projection });
  assert.equal(typeof domain.mobileMain, 'function');
  const scanner = domain.localScan;
  const catalog = ownerModule.createMobileOwnerService({ collection: repository, datasetId, ownerEpoch, assertCurrent });
  async function assertOriginals(): Promise<void> {
    for (const [relative, before] of originals) {
      const file = path.join(media, relative), after = await lstat(file);
      assert.deepEqual([after.dev, after.ino, after.mode, after.nlink, after.size, after.mtimeMs, after.ctimeMs],
        [before.dev, before.ino, before.mode, before.nlink, before.size, before.mtimeMs, before.ctimeMs]);
      assert.deepEqual(await readFile(file), original);
    }
    await inputs.assertUnchanged();
  }
  const close = () => closing ??= (async () => {
    const errors: unknown[] = [];
    for (const stop of [() => domain.close(), () => admission.close(), assertOriginals])
      try { await stop(); } catch (error) { errors.push(error); }
    const turn = scanner.privateReaderTurn();
    try {
      assert.equal(turn.occupied, false); assert.equal(turn.waiting, 0); assert.equal(turn.readerConcurrency, 2);
      assert.deepEqual(admission.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: true });
    } catch (error) { errors.push(error); }
    alive = false; if (errors.length) throw new AggregateError(errors, '真实目录资源尚未全部静止。', { cause: errors[0] });
  })();
  t.after(close);
  const started = scanner.start({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision });
  await scanner.privateWait(started.jobId); const completed = scanner.get(started.jobId);
  assert.equal(completed.phase, 'completed'); assert.deepEqual(completed.progress, { visited: '5', accepted: '5', rejected: '0' });
  const tracks = repository.localCatalog.pageTracks({ offset: 0, limit: 10 }); assert.equal(tracks.total, 5);
  const scanned = [...originals.keys()].map(relative => {
    const track = tracks.items.find(item => repository.localCatalog.privateAssetLocator(item.assetId).relative === relative); assert.ok(track);
    const state = repository.localScan.privateCurrentFileState(root.id, relative)?.value; assert.ok(state?.readFacts);
    assert.equal(state.outcome, 'accepted'); assert.equal(state.trackId, track.id); assert.equal(state.assetId, track.assetId);
    assert.equal(repository.localCatalog.trackDetail(track.id).editions.length, 0); return { relative, track };
  });
  const readonlyStamp = () => repository.readonlySnapshotStamp();
  const assertReadonly = (stamp: ReturnType<typeof readonlyStamp>) => assert.deepEqual(readonlyStamp(), stamp);
  const catalogDispatch = (overrides: { operation?: 'listTracks' | 'listAlbums' } = {}) => domain.mobileMain!({ kind: 'catalog', datasetId, request: {
    operation: 'listTracks', serverId, offset: 0, limit: 100, q: '', albumId: null, itemId: null, expectedRevision: null, catalogPlaybackEnabled: true, ...overrides } }) as Promise<import('../../src/mobile/types.js').MobileOwnerCatalogSnapshot | import('../../src/mobile/types.js').MobileOwnerPrivateFailure>;
  return { repository, datasetId, ownerEpoch, serverId, root, source, directory, media, directories, scanned, catalog, catalogDispatch, readonlyStamp, assertReadonly, assertOriginals, close, domain, identity };
}
type DirectoryFixture = Awaited<ReturnType<typeof realDirectoryFixture>>;
function snapshot(result: MobileContentOwnerResult): MobileContentOwnerSnapshot {
  assert.equal(result.kind, 'content-snapshot', '实际目录成员必须取得内容快照，不能用错误或空页冒充成功。');
  if (result.kind !== 'content-snapshot') throw new Error('没有内容快照。'); return result;
}
function failure(result: MobileContentOwnerResult, status: number, code: string): void {
  assert.equal(result.kind, 'content-error'); if (result.kind !== 'content-error') throw new Error('期望明确拒绝。');
  assert.equal(result.status, status); assert.equal(result.code, code); assert.equal(result.retryable, false);
}
interface Context {
  f: DirectoryFixture; scope: MobileContentScope; tracks: MobileTrack[]; albums: MobileAlbum[];
  dispatch(request: MobileContentOwnerRequest): Promise<MobileContentOwnerResult>;
  empty: { favoritesRevision: string; collectionRevision: string };
}
async function withDomain(t: TestContext, run: (context: Context) => Promise<void>,
  seed?: (f: DirectoryFixture, scope: MobileContentScope, key: Buffer) => Promise<void>): Promise<void> {
  const f = await realDirectoryFixture(t);
  const stateModule = await import(new URL('../../dist/mobile/content-state.js', import.meta.url).href) as typeof import('../../src/mobile/content-state.js');
  const scope: MobileContentScope = { serverId: f.serverId, datasetId: f.datasetId, ownerEpoch: f.ownerEpoch,
    deviceId: 'directory.content.device', deviceEpoch: 1, accessGeneration: 1, accountDomain: `local:${f.datasetId}`, providerEpoch: null };
  const key = randomBytes(32), errors: unknown[] = [];
  try {
    await seed?.(f, scope, key);
    const rawTracks = await f.catalogDispatch(), rawAlbums = await f.catalogDispatch({ operation: 'listAlbums' });
    assert.ok(!('kind' in rawTracks) && !('kind' in rawAlbums));
    const tracks = rawTracks.items.map(value => { const parsed = mobileCatalogResponseSnapshot('track', value); assert.ok(parsed.ok); return parsed.value; });
    const albums = rawAlbums.items.map(value => { const parsed = mobileCatalogResponseSnapshot('album', value); assert.ok(parsed.ok); return parsed.value; });
    assert.equal(tracks.length, 5); assert.equal(albums.length, 3);
    assert.ok(tracks.every(track => track.id.startsWith('mt:')) && albums.every(album => album.id.startsWith('ma:')));
    const currentDomain = f.domain;
    const dispatch = async (request: MobileContentOwnerRequest): Promise<MobileContentOwnerResult> => {
      const envelope = { kind: 'content' as const, datasetId: f.datasetId, request };
      assert.equal(isMobileOwnerPrivateRequest(envelope), true);
      const result = await currentDomain.mobileMain!(envelope) as MobileContentOwnerResult;
      assert.equal(isMobileOwnerPrivateResult(result, envelope), true, '同一正式Owner协议必须接受结果。'); return result;
    };
    assert.equal((await dispatch({ action: 'initialize', serverId: f.serverId, datasetId: f.datasetId, key: Buffer.from(key) })).kind, 'content-initialized');
    assert.equal((await dispatch({ action: 'updateScope', scope })).kind, 'content-scope-updated');
    const empty = stateModule.mobileContentDomainSnapshot(stateModule.createMobileContentState({ serverId: f.serverId, datasetId: f.datasetId }), scope, limits);
    const stamp = f.readonlyStamp();
    await run({ f, scope, tracks, albums, dispatch, empty });
    f.assertReadonly(stamp); await f.assertOriginals();
  } catch (error) { errors.push(error); }
  finally {
    try { await f.close(); } catch (error) { errors.push(error); }
    key.fill(0);
  }
  if (errors.length) throw new AggregateError(errors, '目录内容组合断言或原资源关闭失败。', { cause: errors[0] });
}
function trackWrite(c: Pick<Context, 'scope'>, track: MobileTrack, revision: string, key: string, value = true): MobileContentOwnerDispatch {
  return { action: 'dispatch', operation: 'setTrackFavorite', scope: c.scope, request: {
    path: `/mobile/v1/ui/favorites/tracks/${encodeURIComponent(track.id)}`, pathParameters: { trackId: track.id }, query: {}, idempotencyKey: key,
    body: { source: 'local', isFavorite: value, accountDomain: c.scope.accountDomain, expectedRevision: revision,
      albumId: track.albumId, versionId: track.versionId, contentRevision: track.contentRevision } } };
}
function createPlaylist(c: Pick<Context, 'scope'>, track: MobileTrack, revision: string, key: string): MobileContentOwnerDispatch {
  return { action: 'dispatch', operation: 'createPersonalPlaylist', scope: c.scope, request: {
    path: '/mobile/v1/ui/playlists', pathParameters: {}, query: {}, idempotencyKey: key,
    body: { accountDomain: c.scope.accountDomain, expectedCollectionRevision: revision,
      draft: { title: '目录成员歌单', description: '', icon: 'music.note' }, initialTrack: selected(track) } } };
}
function favoriteTracks(c: Pick<Context, 'scope'>, albumId: string, revision: string): MobileContentOwnerDispatch {
  return { action: 'dispatch', operation: 'listFavoriteAlbumTracks', scope: c.scope, request: {
    path: `/mobile/v1/ui/favorites/albums/${encodeURIComponent(albumId)}/tracks`, pathParameters: { albumId }, body: null,
    query: { source: 'local', accountDomain: c.scope.accountDomain, favoritesRevision: revision } } };
}
function playlistTracks(c: Pick<Context, 'scope'>, playlist: MobilePersonalPlaylistReceipt['playlist']): MobileContentOwnerDispatch {
  return { action: 'dispatch', operation: 'listPersonalPlaylistTracks', scope: c.scope, request: {
    path: `/mobile/v1/ui/playlists/${playlist.playlistId}/tracks`, pathParameters: { playlistId: playlist.playlistId }, body: null,
    query: { accountDomain: c.scope.accountDomain, playlistRevision: playlist.playlistRevision } } };
}

test('目录内容：mt单曲收藏写入、成员回读与取消沿同一真实Owner', { concurrency: false }, async t => {
  await withDomain(t, async c => {
    const track = c.tracks[0]!, first = snapshot(await c.dispatch(trackWrite(c, track, c.empty.favoritesRevision, 'canonical.track.on')));
    const favorite = first.reply.body as MobileFavoriteAlbumState;
    assert.deepEqual(plain(favorite.favorite?.favoriteTracks), [selected(track)]);
    const read = snapshot(await c.dispatch(favoriteTracks(c, track.albumId, favorite.favoritesRevision)));
    assert.deepEqual((read.reply.body as { items: MobileTrack[] }).items, [track]);
    const removed = snapshot(await c.dispatch(trackWrite(c, track, favorite.favoritesRevision, 'canonical.track.off', false)));
    assert.equal((removed.reply.body as MobileFavoriteAlbumState).favorite, null);
  });
});

test('目录内容：mt歌单初始成员、跨目录添加与完整回读保留身份', { concurrency: false }, async t => {
  await withDomain(t, async c => {
    const track = c.tracks[0]!, other = c.tracks.find(value => value.albumId !== track.albumId)!;
    const first = snapshot(await c.dispatch(createPlaylist(c, track, c.empty.collectionRevision, 'canonical.playlist.create'))).reply.body as MobilePersonalPlaylistReceipt;
    assert.equal(first.playlist.trackCount, 1);
    const add: MobileContentOwnerDispatch = { action: 'dispatch', operation: 'addPersonalPlaylistTrack', scope: c.scope, request: {
      path: `/mobile/v1/ui/playlists/${first.playlist.playlistId}/tracks`, pathParameters: { playlistId: first.playlist.playlistId }, query: {}, idempotencyKey: 'canonical.playlist.add',
      body: { accountDomain: c.scope.accountDomain, expectedRevision: first.playlist.playlistRevision, selection: selected(other) } } };
    const added = snapshot(await c.dispatch(add)).reply.body as MobilePersonalPlaylistReceipt;
    assert.equal(added.playlist.trackCount, 2);
    assert.deepEqual((snapshot(await c.dispatch(playlistTracks(c, added.playlist))).reply.body as { items: MobileTrack[] }).items, [track, other]);
  });
});

test('目录内容：ma整专收藏保留目录全部真实成员', { concurrency: false }, async t => {
  await withDomain(t, async c => {
    const album = c.albums.find(value => value.trackCount === 2)!;
    const request: MobileContentOwnerDispatch = { action: 'dispatch', operation: 'setAlbumFavorite', scope: c.scope, request: {
      path: `/mobile/v1/ui/favorites/albums/${encodeURIComponent(album.id)}`, pathParameters: { albumId: album.id }, query: {}, idempotencyKey: 'canonical.album.on',
      body: { source: 'local', isFavorite: true, accountDomain: c.scope.accountDomain, expectedRevision: c.empty.favoritesRevision } } };
    const first = snapshot(await c.dispatch(request)).reply.body as MobileFavoriteAlbumState;
    assert.equal(first.favorite?.album.id, album.id); assert.equal(first.favorite?.albumFavorite, true);
    const read = snapshot(await c.dispatch(favoriteTracks(c, album.id, first.favoritesRevision))).reply.body as { items: MobileTrack[] };
    assert.deepEqual(read.items, c.tracks.filter(track => track.albumId === album.id));
  });
});

test('目录内容：mt错误组hash、未知ID、跨库与旧版本不能写入收藏或歌单', { concurrency: false }, async t => {
  await withDomain(t, async c => {
    const track = c.tracks[0]!, prefix = `mt:${c.f.datasetId}:`;
    const invalids = [
      { ...track, id: `${prefix}${track.id.split(':')[2]}:${'0'.repeat(64)}` },
      { ...track, id: `${prefix}${randomUUID()}:${track.id.split(':')[3]}` },
      { ...track, id: track.id.replace(c.f.datasetId, randomUUID()) },
    ];
    for (const [index, bad] of invalids.entries()) {
      failure(await c.dispatch(trackWrite(c, bad, c.empty.favoritesRevision, `canonical.reject.${index}`)), 404, 'INVALID_REQUEST');
      failure(await c.dispatch(createPlaylist(c, bad, c.empty.collectionRevision, `canonical.reject.playlist.${index}`)), 404, 'INVALID_REQUEST');
    }
    const stale = { ...track, versionId: 'lv:changed' };
    failure(await c.dispatch(trackWrite(c, stale, c.empty.favoritesRevision, 'canonical.reject.version')), 409, 'SOURCE_CHANGED');
    const wrongAlbum = { ...track, albumId: c.albums.find(value => value.id !== track.albumId)!.id };
    failure(await c.dispatch(trackWrite(c, wrongAlbum, c.empty.favoritesRevision, 'canonical.reject.album')), 409, 'SOURCE_CHANGED');
    const missingAlbum = track.albumId.replace(c.f.root.id, randomUUID());
    failure(await c.dispatch({ action: 'dispatch', operation: 'setAlbumFavorite', scope: c.scope, request: {
      path: `/mobile/v1/ui/favorites/albums/${encodeURIComponent(missingAlbum)}`, pathParameters: { albumId: missingAlbum }, query: {}, idempotencyKey: 'canonical.reject.unknown.album',
      body: { source: 'local', isFavorite: true, accountDomain: c.scope.accountDomain, expectedRevision: c.empty.favoritesRevision } } }), 404, 'INVALID_REQUEST');
    const valid = snapshot(await c.dispatch(createPlaylist(c, track, c.empty.collectionRevision, 'canonical.valid.after.reject'))).reply.body as MobilePersonalPlaylistReceipt;
    assert.equal(valid.playlist.trackCount, 1, '所有拒绝均未消费原collection CAS。');
  });
});

test('目录内容：刷新期间撤销Scope会拒绝未提交写入', { concurrency: false }, async t => {
  await withDomain(t, async c => {
    const original = promises.lstat; let enter!: () => void, release!: () => void, blocked = false;
    const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const mock = t.mock.method(promises, 'lstat', async (...args: Parameters<typeof promises.lstat>) => {
      if (args[0] === c.f.media && !blocked) { blocked = true; enter(); await gate; }
      return Reflect.apply(original, promises, args);
    });
    syncBuiltinESMExports();
    let pending: Promise<MobileContentOwnerResult> | undefined;
    try {
      pending = c.dispatch(trackWrite(c, c.tracks[0]!, c.empty.favoritesRevision, 'canonical.revoked.during.refresh'));
      await Promise.race([entered, pending.then(() => { throw new Error('写入未等到真实目录刷新。'); })]);
      assert.equal((await c.dispatch({ action: 'invalidateScope', kind: 'device', deviceId: c.scope.deviceId })).kind, 'content-scope-invalidated');
      release(); failure(await pending, 401, 'UNAUTHORIZED');
    } finally { release(); await pending; mock.mock.restore(); syncBuiltinESMExports(); }
    c.scope = { ...c.scope, deviceEpoch: 2 };
    assert.equal((await c.dispatch({ action: 'updateScope', scope: c.scope })).kind, 'content-scope-updated');
    const accepted = snapshot(await c.dispatch(trackWrite(c, c.tracks[0]!, c.empty.favoritesRevision, 'canonical.after.revocation')));
    assert.equal((accepted.reply.body as MobileFavoriteAlbumState).favorite?.favoriteTracks.length, 1);
  });
});

test('目录内容：已提交回执与发送前确认不等待新目录刷新', { concurrency: false }, async t => {
  await withDomain(t, async c => {
    const request = trackWrite(c, c.tracks[0]!, c.empty.favoritesRevision, 'canonical.receipt.once');
    const first = snapshot(await c.dispatch(request)), file = path.join(c.f.directory, 'mobile-content', 'content-state.v1.sealed.json');
    const before = await readFile(file), original = promises.lstat; let rootReads = 0;
    const mock = t.mock.method(promises, 'lstat', (...args: Parameters<typeof promises.lstat>) => {
      if (args[0] === c.f.media) rootReads++; return Reflect.apply(original, promises, args);
    });
    syncBuiltinESMExports();
    try {
      assert.deepEqual(snapshot(await c.dispatch(request)).reply, first.reply);
      assert.equal((await c.dispatch({ action: 'revalidate', scope: c.scope, snapshotId: first.snapshotId })).kind, 'content-revalidated');
      assert.equal(rootReads, 0, '重放及mutation回执复核不读取最新目录事实。');
      assert.deepEqual(await readFile(file), before);
    } finally { mock.mock.restore(); syncBuiltinESMExports(); }
  });
});

test('目录内容：canonical提交UNKNOWN维持冻结，原commit对账与回执不重新刷新或保存', { concurrency: false }, async t => {
  await withDomain(t, async c => {
    const input = trackWrite(c, c.tracks[0]!, c.empty.favoritesRevision, 'canonical.commit.unknown');
    const directory = path.join(c.f.directory, 'mobile-content'), file = path.join(directory, 'content-state.v1.sealed.json');
    const renameSync = fs.renameSync, fsyncSync = fs.fsyncSync; let published = false, failed = false;
    const renamed = t.mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
      const result = Reflect.apply(renameSync, fs, args); if (args[1] === file) published = true; return result;
    });
    const synced = t.mock.method(fs, 'fsyncSync', (fd: number) => {
      if (published && !failed && fs.fstatSync(fd).isDirectory()) { failed = true; throw new Error('合成内容提交后目录fsync故障。'); }
      return fsyncSync(fd);
    });
    syncBuiltinESMExports(); let unknown: MobileContentOwnerResult;
    try { unknown = await c.dispatch(input); }
    finally { synced.mock.restore(); renamed.mock.restore(); syncBuiltinESMExports(); }
    failure(unknown, 503, 'BUSY'); assert.equal(failed, true);
    if (unknown.kind !== 'content-error') throw new Error('没有保留UNKNOWN。');
    assert.equal(unknown.outcome, 'unknown'); assert.ok(unknown.commitId);
    const committed = await readFile(file), lstat = promises.lstat; let rootReads = 0;
    const read = t.mock.method(promises, 'lstat', (...args: Parameters<typeof promises.lstat>) => {
      if (args[0] === c.f.media) rootReads++; return Reflect.apply(lstat, promises, args);
    });
    syncBuiltinESMExports();
    try {
      failure(await c.dispatch(input), 503, 'BUSY');
      assert.deepEqual(await readFile(file), committed);
      const resolved = snapshot(await c.dispatch({ action: 'revalidate', scope: c.scope, commitId: unknown.commitId,
        operation: 'setTrackFavorite', request: input.request as MobileRequestMap['setTrackFavorite'] }));
      assert.equal((resolved.reply.body as MobileFavoriteAlbumState).favorite?.favoriteTracks.length, 1);
      assert.deepEqual(snapshot(await c.dispatch(input)).reply, resolved.reply);
      assert.deepEqual(await readFile(file), committed); assert.equal(rootReads, 0);
    } finally { read.mock.restore(); syncBuiltinESMExports(); }
  });
});

test('目录内容：历史lt收藏与歌单持久态在新目录接线后仍可回读', { concurrency: false }, async t => {
  let oldTrack: MobileTrack, oldFavorite: MobileFavoriteAlbumState, oldPlaylist: MobilePersonalPlaylistReceipt;
  await withDomain(t, async c => {
    const favorites = snapshot(await c.dispatch(favoriteTracks(c, oldTrack!.albumId, oldFavorite!.favoritesRevision))).reply.body as { items: MobileTrack[] };
    assert.deepEqual(plain(favorites.items.map(selected)), [selected(oldTrack!)]);
    const members = snapshot(await c.dispatch(playlistTracks(c, oldPlaylist!.playlist))).reply.body as { items: MobileTrack[] };
    assert.deepEqual(plain(members.items.map(selected)), [selected(oldTrack!)]);
    const absent = c.f.scanned.find(value => !c.f.repository.localCatalog.trackDetail(value.track.id).editions.length)!;
    const missing = { ...oldTrack!, id: `lt:${c.f.datasetId}:${absent.track.id}:${oldTrack!.id.split(':')[3]}` };
    failure(await c.dispatch({ action: 'local-track', scope: c.scope, selection: selected(missing) }), 404, 'INVALID_REQUEST');
  }, async (f, scope, key) => {
    const records = f.scanned.filter(value => path.posix.dirname(value.relative) === f.directories[0]!.relative);
    const edition = f.repository.localCatalog.createEdition({ commandId: randomUUID(), title: '原已持久化发行', edition: '历史引用' });
    for (const [index, record] of records.entries()) f.repository.localCatalog.linkEditionTrack({ commandId: randomUUID(), editionId: edition.id,
      trackId: record.track.id, disc: 1, trackNumber: index + 1, sequence: index + 1 });
    const contentModule = await import(new URL('../../dist/mobile/content-owner-service.js', import.meta.url).href) as typeof import('../../src/mobile/content-owner-service.js');
    const stateModule = await import(new URL('../../dist/mobile/content-state.js', import.meta.url).href) as typeof import('../../src/mobile/content-state.js');
    const legacy = contentModule.createMobileContentOwnerService({ collection: f.repository, datasetId: f.datasetId, ownerEpoch: f.ownerEpoch,
      catalog: { dispatch: f.catalog.dispatchLegacy, catalogRevision: f.catalog.catalogRevision },
      assertCurrent: () => { f.repository.readonlySnapshotStamp(); }, limits });
    try {
      const raw = f.catalog.dispatchLegacy({ kind: 'catalog', datasetId: f.datasetId, request: { operation: 'getTrack', serverId: f.serverId,
        offset: 0, limit: 1, q: '', albumId: null, itemId: `lt:${f.datasetId}:${records[0]!.track.id}:${edition.id}`, expectedRevision: null, catalogPlaybackEnabled: true } });
      assert.ok(!('kind' in raw) && 'items' in raw); const parsed = mobileCatalogResponseSnapshot('track', raw.items[0]); assert.ok(parsed.ok); oldTrack = parsed.value;
      assert.equal((await legacy.dispatch({ action: 'initialize', serverId: f.serverId, datasetId: f.datasetId, key: Buffer.from(key) })).kind, 'content-initialized');
      assert.equal((await legacy.dispatch({ action: 'updateScope', scope })).kind, 'content-scope-updated');
      const empty = stateModule.mobileContentDomainSnapshot(stateModule.createMobileContentState({ serverId: f.serverId, datasetId: f.datasetId }), scope, limits);
      oldFavorite = snapshot(await legacy.dispatch(trackWrite({ scope }, oldTrack, empty.favoritesRevision, 'legacy.track.seed'))).reply.body as MobileFavoriteAlbumState;
      oldPlaylist = snapshot(await legacy.dispatch(createPlaylist({ scope }, oldTrack, empty.collectionRevision, 'legacy.playlist.seed'))).reply.body as MobilePersonalPlaylistReceipt;
    } finally { await legacy.close(); }
  });
});

test('目录内容：最近添加先按当前可见目录筛选再分页，停用旧la不使整页404且原快照失效', { concurrency: false }, async t => {
  const f = await realDirectoryFixture(t);
  const files = await import(new URL('../../dist/recording/source-files.js', import.meta.url).href) as typeof import('../../src/recording/source-files.js');
  const journal = await import(new URL('../../dist/collection/local-library-workbench/owner-journal.js', import.meta.url).href) as typeof import('../../src/collection/local-library-workbench/owner-journal.js');
  const visibleMedia = path.join(f.directory, 'visible-media'); await mkdir(visibleMedia, { mode: 0o700 });
  const visibleBytes = await readFile(path.join(f.media, f.scanned[0]!.relative)), visibleFile = path.join(visibleMedia, '可见.wav');
  await writeFile(visibleFile, visibleBytes, { mode: 0o600, flag: 'wx' });
  const source = f.repository.sources.authorize(randomUUID(), await files.authorizeSourceDirectory(visibleMedia));
  const visibleRoot = f.repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
  const job = f.domain.localScan.start({ commandId: randomUUID(), libraryRootId: visibleRoot.id, expectedRootRevision: visibleRoot.revision });
  await f.domain.localScan.privateWait(job.jobId); assert.equal(f.domain.localScan.get(job.jobId).phase, 'completed');
  const visibleTrack = f.repository.localCatalog.pageTracks({ offset: 0, limit: 100 }).items.find(track => f.repository.localCatalog.trackDetail(track.id).asset.libraryRootId === visibleRoot.id); assert.ok(visibleTrack);
  const visible = f.repository.localCatalog.createEdition({ commandId: randomUUID(), title: '当前可见发行', edition: '可见' });
  f.repository.localCatalog.linkEditionTrack({ commandId: randomUUID(), editionId: visible.id, trackId: visibleTrack.id, disc: 1, trackNumber: 1, sequence: 1 });
  const hidden = f.repository.localCatalog.createEdition({ commandId: randomUUID(), title: '后续停用发行', edition: '停用' });
  f.repository.localCatalog.linkEditionTrack({ commandId: randomUUID(), editionId: hidden.id, trackId: f.scanned[0]!.track.id, disc: 1, trackNumber: 1, sequence: 1 });
  function operation(command: 'library.import.confirm' | 'library.remove', commandId: string): LocalLibraryManagementOperationRecord {
    const original: LocalLibraryManagementOperationRecord['original'] = command === 'library.import.confirm'
      ? { command, request: { commandId, choiceId: randomUUID(), role: 'catalog' } }
      : { command, request: { commandId, libraryIds: [f.root.id] } };
    return { schema: 1, kind: 'operation', datasetId: f.datasetId, key: commandId, revision: 1, original,
      originalSha256: journal.localLibraryManagementDigest(original), receipt: { commandId, kind: command, state: 'succeeded', libraryIds: [f.root.id], message: null } };
  }
  const imported = operation('library.import.confirm', randomUUID());
  const binding: LocalLibraryManagementBindingRecord = { schema: 1, kind: 'binding', datasetId: f.datasetId, key: f.root.id, revision: 1,
    libraryId: f.root.id, sourceRootId: f.source.id, rootRevision: f.root.revision, role: 'catalog', name: '有限合成库', active: true, watchEnabled: false, operationId: imported.key };
  f.repository.localCatalog.privateLibraryManagementCompareAndSwap(f.identity, [{ record: binding, expectedRevision: null }, { record: imported, expectedRevision: null }]);
  const scope: MobileContentScope = { serverId: f.serverId, datasetId: f.datasetId, ownerEpoch: f.ownerEpoch, deviceId: 'recent.directory.device',
    deviceEpoch: 1, accessGeneration: 1, accountDomain: `local:${f.datasetId}`, providerEpoch: null };
  const key = randomBytes(32), dispatch = (request: MobileContentOwnerRequest) => f.domain.mobileMain!({ kind: 'content', datasetId: f.datasetId, request }) as Promise<MobileContentOwnerResult>;
  const recent = (limit: number): MobileContentOwnerDispatch => ({ action: 'dispatch', operation: 'listRecentlyAddedAlbums', scope,
    request: { path: '/mobile/v1/ui/home/added-albums', pathParameters: {}, query: { limit }, body: null } });
  try {
    assert.equal((await dispatch({ action: 'initialize', serverId: f.serverId, datasetId: f.datasetId, key: Buffer.from(key) })).kind, 'content-initialized');
    assert.equal((await dispatch({ action: 'updateScope', scope })).kind, 'content-scope-updated');
    const before = snapshot(await dispatch(recent(100))); assert.equal((before.reply.body as { items: unknown[] }).items.length, 2);
    const removed = operation('library.remove', randomUUID());
    f.repository.localCatalog.privateLibraryManagementCompareAndSwap(f.identity, [{ record: { ...binding, revision: 2, active: false, operationId: removed.key }, expectedRevision: 1 }, { record: removed, expectedRevision: null }]);
    assert.equal(f.repository.localCatalog.privateLibraryManagementRootVisible(f.root.id), false);
    const legacy = f.catalog.dispatchLegacy({ kind: 'catalog', datasetId: f.datasetId, request: { operation: 'getAlbum', serverId: f.serverId,
      offset: 0, limit: 1, q: '', albumId: null, itemId: `la:${f.datasetId}:${hidden.id}`, expectedRevision: null } });
    assert.ok(!('kind' in legacy) && 'items' in legacy && legacy.items.length === 1, '旧候选仍能枚举停用组织中的发行。');
    failure(await dispatch({ action: 'revalidate', scope, snapshotId: before.snapshotId }), 409, 'SOURCE_CHANGED');
    const hiddenCurrent = await f.domain.mobileMain!({ kind: 'catalog', datasetId: f.datasetId, request: { operation: 'getAlbum', serverId: f.serverId,
      offset: 0, limit: 1, q: '', albumId: null, itemId: `la:${f.datasetId}:${hidden.id}`, expectedRevision: null } });
    assert.ok('kind' in hiddenCurrent && hiddenCurrent.kind === 'mobile-error'); assert.equal(hiddenCurrent.status, 404);
    const stamp = f.readonlyStamp(), page = snapshot(await dispatch(recent(1)));
    const body = page.reply.body as { items: MobileAlbum[]; nextCursor: string | null };
    assert.equal(body.items.length, 1); assert.equal(body.items[0]!.id, `la:${f.datasetId}:${visible.id}`); assert.equal(body.nextCursor, null);
    assert.equal((await dispatch({ action: 'revalidate', scope, snapshotId: page.snapshotId })).kind, 'content-revalidated');
    f.assertReadonly(stamp); await f.assertOriginals(); assert.deepEqual(await readFile(visibleFile), visibleBytes);
  } finally { key.fill(0); await f.close(); }
});
