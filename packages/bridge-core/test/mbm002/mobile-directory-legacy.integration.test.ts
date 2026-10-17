import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import promises, { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { mobileCatalogResponseSnapshot, type MobileAlbum, type MobileTrack } from '@music-bridge/contracts';
import type { MobileOwnerCatalogSnapshot, MobileOwnerPrivateFailure } from '../../src/mobile/types.js';
import type { MobileOwnerSourceResult } from '../../src/mobile/source-protocol.js';
import { directoryFixture } from './mobile-directory-fixture.js';

type Fixture = Awaited<ReturnType<typeof directoryFixture>>;
type Result = MobileOwnerCatalogSnapshot | MobileOwnerSourceResult | MobileOwnerPrivateFailure;
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
function snapshot(value: MobileOwnerCatalogSnapshot | MobileOwnerPrivateFailure): MobileOwnerCatalogSnapshot {
  assert.ok(!('kind' in value), '实际目录不能以安全错误或空页替代成功。');
  assert.equal(value.items.length, Math.min(value.limit, Math.max(0, value.total - value.offset)));
  return value;
}
function album(value: MobileAlbum | MobileTrack): MobileAlbum {
  const result = mobileCatalogResponseSnapshot('album', value); assert.ok(result.ok); return result.value;
}
function track(value: MobileAlbum | MobileTrack): MobileTrack {
  const result = mobileCatalogResponseSnapshot('track', value); assert.ok(result.ok); return result.value;
}
function failure(value: Result, status: number, code: string): void {
  assert.ok('kind' in value && value.kind === 'mobile-error');
  assert.equal(value.status, status); assert.equal(value.code, code); assert.equal(value.outcome, null);
}
const selected = (value: MobileTrack, trackId = value.id) => ({ resourceId: randomUUID(), trackId,
  versionId: value.versionId, contentRevision: value.contentRevision });

/** 只围住已经完成扫描/目录读取后的拒绝；实际open全部委派，恢复与零次断言均全尝试。 */
async function withoutSourceOpen(t: TestContext, run: () => Promise<void>): Promise<void> {
  const nativeOpen = promises.open, nativeOpenSync = fs.openSync, errors: unknown[] = [];
  let opens = 0, syncOpens = 0, restoreOpen: (() => void) | undefined, restoreSync: (() => void) | undefined;
  try {
    const opened = t.mock.method(promises, 'open', (...args: Parameters<typeof promises.open>) => {
      opens++; return Reflect.apply(nativeOpen, promises, args) as ReturnType<typeof promises.open>;
    });
    restoreOpen = () => opened.mock.restore();
    const openedSync = t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
      syncOpens++; return Reflect.apply(nativeOpenSync, fs, args) as ReturnType<typeof fs.openSync>;
    });
    restoreSync = () => openedSync.mock.restore(); syncBuiltinESMExports(); await run();
  } catch (error) { errors.push(error); }
  finally {
    for (const restore of [restoreSync, restoreOpen, syncBuiltinESMExports]) if (restore) try { restore(); } catch (error) { errors.push(error); }
    try { assert.deepEqual({ opens, syncOpens }, { opens: 0, syncOpens: 0 }, '旧引用歧义或缺成员拒绝须发生在源FD取得前。'); }
    catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, '旧引用拒绝或真实文件观察恢复失败。', { cause: errors[0] });
}
async function withDirectory(t: TestContext, run: (f: Fixture, checks: (() => Promise<void> | void)[]) => Promise<void>): Promise<void> {
  const f = await directoryFixture(t, { allowEditionRelations: true }), errors: unknown[] = [];
  const checks: (() => Promise<void> | void)[] = [];
  try { await run(f, checks); } catch (error) { errors.push(error); }
  for (const close of [() => f.close(), ...checks]) try { await close(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, '真实发行兼容断言或夹具关闭未完全成立。', { cause: errors[0] });
}
function registerEdition(f: Fixture) {
  const directory = f.directories[0]!;
  const records = f.scanned.filter(item => path.posix.dirname(item.relative) === directory.relative);
  assert.equal(records.length, 2);
  const edition = f.repository.localCatalog.createEdition({ commandId: randomUUID(), title: '真实关系的合成发行', edition: '兼容甲' });
  const links = records.map((record, index) => f.repository.localCatalog.linkEditionTrack({ commandId: randomUUID(),
    editionId: edition.id, trackId: record.track.id, disc: 1, trackNumber: index + 1, sequence: index + 1 }));
  assert.deepEqual(new Set(links.map(link => link.trackId)), new Set(records.map(record => record.track.id)));
  return { edition, records, links };
}
async function canonicalPages(f: Fixture, totalAlbums: number, totalTracks: number) {
  const albums = snapshot(await f.catalogDispatch({ operation: 'listAlbums' }));
  const global = snapshot(await f.catalogDispatch({ operation: 'listTracks' }));
  assert.equal(albums.total, totalAlbums); assert.equal(albums.items.length, totalAlbums);
  assert.equal(global.total, totalTracks); assert.equal(global.items.length, totalTracks);
  assert.equal(albums.libraryRevision, global.libraryRevision);
  const groups = albums.items.map(album), all = global.items.map(track), members: MobileTrack[] = [];
  assert.equal(new Set(groups.map(value => value.id)).size, totalAlbums);
  assert.equal(new Set(all.map(value => value.id)).size, totalTracks);
  assert.equal(new Set(all.map(value => value.sourceItemId)).size, totalTracks, '六个独立实际资产不得被发行/目录双列表重复投影。');
  for (const group of groups) {
    assert.ok(group.id.startsWith('ma:'), 'canonical身份只能来自实际目录，不能保留旧发行聚合。');
    const detail = snapshot(await f.catalogDispatch({ operation: 'getAlbum', itemId: group.id, limit: 1 }));
    assert.deepEqual(album(detail.items[0]!), group);
    const page = snapshot(await f.catalogDispatch({ operation: 'listTracks', albumId: group.id }));
    assert.equal(page.total, group.trackCount); assert.equal(page.items.length, group.trackCount);
    for (const raw of page.items) {
      const member = track(raw); assert.ok(member.id.startsWith('mt:')); assert.equal(member.albumId, group.id);
      const found = snapshot(await f.catalogDispatch({ operation: 'getTrack', itemId: member.id, limit: 1 }));
      assert.deepEqual(track(found.items[0]!), member); members.push(member);
    }
  }
  const ordered = (values: MobileTrack[]) => values.slice().sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(ordered(members), ordered(all), '每组完整成员与global列表必须逐事实一致。');
  return { groups, all, revision: albums.libraryRevision };
}
async function prepareAndRelease(f: Fixture, value: MobileTrack): Promise<void> {
  const prepared = await f.prepareFromTrack(value), errors: unknown[] = [];
  try {
    const original = f.originals.values().next().value; assert.ok(original);
    assert.equal(prepared.size, original.length); assert.equal(prepared.contentType, 'audio/wav');
    assert.equal(prepared.processing.mode, 'direct'); assert.deepEqual(prepared.actualAudio, prepared.sourceAudio);
  } catch (error) { errors.push(error); }
  try { assert.deepEqual(await f.sourceDispatch({ operation: 'release', handle: prepared.handle }),
    { kind: 'mobile-source-ack', operation: 'release', handle: prepared.handle, readId: null, quiet: true }); }
  catch (error) { errors.push(error); }
  try { f.assertQuiet(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, '旧曲目原文件准备或quiet释放未成立。', { cause: errors[0] });
}

// 仅旧la/lt按已登记UUID构造；新ma/mt均消费实际目录响应，不拆解或拼接。
test('MBM目录旧引用：真实发行与目录共存且唯一la/lt保留身份、成员门与原文件准备资格', { concurrency: false }, async t => {
  await withDirectory(t, async f => {
    const { edition, records } = registerEdition(f), baseline = f.readonlyStamp();
    const current = await canonicalPages(f, 3, 5), registered = current.groups.filter(group => group.title === edition.title);
    assert.equal(registered.length, 1); assert.equal(registered[0]!.trackCount, 2);
    const oldAlbumId = `la:${f.datasetId}:${edition.id}`, oldTrackId = `lt:${f.datasetId}:${records[0]!.track.id}:${edition.id}`;
    const oldAlbum = snapshot(await f.catalogDispatch({ operation: 'getAlbum', itemId: oldAlbumId, limit: 1 }));
    assert.equal(oldAlbum.total, 1); assert.equal(album(oldAlbum.items[0]!).id, oldAlbumId);
    assert.equal(album(oldAlbum.items[0]!).trackCount, 2); assert.equal(oldAlbum.libraryRevision, current.revision);
    const oldDetail = snapshot(await f.catalogDispatch({ operation: 'getTrack', itemId: oldTrackId, limit: 1 })), oldTrack = track(oldDetail.items[0]!);
    assert.equal(oldTrack.id, oldTrackId); assert.equal(oldTrack.albumId, oldAlbumId); assert.equal(oldTrack.availability, 'available');
    const sameContent = current.all.filter(value => value.versionId === oldTrack.versionId && value.contentRevision === oldTrack.contentRevision);
    assert.equal(sameContent.length, 1); assert.equal(sameContent[0]!.albumId, registered[0]!.id);
    assert.equal(oldTrack.sourceItemId, sameContent[0]!.sourceItemId); assert.deepEqual(oldTrack.audio, sameContent[0]!.audio);
    assert.equal(oldTrack.durationMs, sameContent[0]!.durationMs); await prepareAndRelease(f, oldTrack);
    const outsider = f.scanned.find(record => !records.some(member => member.track.id === record.track.id)); assert.ok(outsider);
    assert.equal(f.repository.localCatalog.trackDetail(outsider.track.id).editions.length, 0);
    const missingMember = `lt:${f.datasetId}:${outsider.track.id}:${edition.id}`;
    await withoutSourceOpen(t, async () => {
      failure(await f.catalogDispatch({ operation: 'getTrack', itemId: missingMember, limit: 1 }), 404, 'INVALID_REQUEST');
      failure(await f.sourceDispatch({ operation: 'prepare', selection: selected(oldTrack, missingMember) }), 404, 'INVALID_REQUEST');
      f.assertQuiet();
    });
    f.assertReadonly(baseline); await f.assertOriginals();
  });
});

test('MBM目录旧引用：同发行跨真实源根拆成canonical组，旧la/lt歧义拒绝且不取得源FD', { concurrency: false }, async t => {
  await withDirectory(t, async (f, checks) => {
    const { edition, records } = registerEdition(f);
    const oldAlbumId = `la:${f.datasetId}:${edition.id}`, oldTrackId = `lt:${f.datasetId}:${records[0]!.track.id}:${edition.id}`;
    const previous = snapshot(await f.catalogDispatch({ operation: 'getTrack', itemId: oldTrackId, limit: 1 }));
    const oldTrack = track(previous.items[0]!); assert.equal(oldTrack.id, oldTrackId);
    const media = path.join(f.directory, '独立源根'), file = path.join(media, '新增.wav'), original = await f.inputs.bytes('core-wav');
    await mkdir(media, { mode: 0o700 }); await writeFile(file, original, { flag: 'wx', mode: 0o600 });
    const before = await lstat(file, { bigint: true });
    assert.equal(before.isFile(), true); assert.equal(before.isSymbolicLink(), false); assert.equal(before.nlink, 1n);
    assert.equal(await realpath(file), file); assert.equal(sha(await readFile(file)), sha(original));
    checks.push(async () => {
      const after = await lstat(file, { bigint: true });
      const axes = (value: typeof before) => [value.dev, value.ino, value.size, value.mode, value.uid, value.gid, value.nlink, value.mtimeNs, value.ctimeNs];
      assert.deepEqual(axes(after), axes(before)); assert.deepEqual(await readFile(file), original);
    });
    const source = f.repository.sources.authorize(randomUUID(), await f.modules.files.authorizeSourceDirectory(media));
    const root = f.repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
    assert.notEqual(root.id, f.root.id); assert.notEqual(root.sourceRootId, f.root.sourceRootId);
    // 同Owner原Scanner/Reader及同准入Map，只新增原真实job，不造第二份扫描事实。
    const started = f.scanner.start({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision });
    await f.scanner.privateWait(started.jobId);
    const completed = f.scanner.get(started.jobId);
    assert.equal(completed.phase, 'completed'); assert.deepEqual(completed.progress, { visited: '1', accepted: '1', rejected: '0' });
    const state = f.repository.localScan.privateCurrentFileState(root.id, '新增.wav')?.value;
    assert.ok(state?.readFacts && state.trackId && state.assetId); assert.equal(state.outcome, 'accepted');
    assert.deepEqual(state.readFacts.coverEvidence, []);
    const added = f.repository.localCatalog.track(state.trackId), asset = f.repository.localCatalog.asset(state.assetId);
    assert.equal(added.assetId, asset.id); assert.equal(asset.libraryRootId, root.id);
    assert.equal(f.repository.localCatalog.trackDetail(added.id).editions.length, 0);
    const link = f.repository.localCatalog.linkEditionTrack({ commandId: randomUUID(), editionId: edition.id,
      trackId: added.id, disc: 1, trackNumber: 3, sequence: 3 });
    assert.equal(link.trackId, added.id); assert.equal(link.editionId, edition.id);
    const baseline = f.readonlyStamp(), current = await canonicalPages(f, 4, 6);
    const registered = current.groups.filter(group => group.title === edition.title);
    assert.equal(registered.length, 2); assert.notEqual(registered[0]!.id, registered[1]!.id);
    assert.deepEqual(registered.map(group => group.trackCount).sort(), [1, 2]);
    assert.notEqual(current.revision, previous.libraryRevision);
    await withoutSourceOpen(t, async () => {
      failure(await f.catalogDispatch({ operation: 'getAlbum', itemId: oldAlbumId, limit: 1 }), 409, 'SOURCE_CHANGED');
      failure(await f.catalogDispatch({ operation: 'getTrack', itemId: oldTrackId, limit: 1 }), 409, 'SOURCE_CHANGED');
      failure(await f.sourceDispatch({ operation: 'prepare', selection: selected(oldTrack) }), 409, 'SOURCE_CHANGED');
      f.assertQuiet();
    });
    f.assertReadonly(baseline); await f.assertOriginals();
  });
});
