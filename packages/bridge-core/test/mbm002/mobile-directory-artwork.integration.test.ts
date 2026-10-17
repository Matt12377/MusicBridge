import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mobileCatalogResponseSnapshot, type MobileAlbum, type MobileTrack } from '@music-bridge/contracts';
import type { MobileOwnerArtworkSnapshot, MobileOwnerCatalogSnapshot, MobileOwnerPrivateFailure } from '../../src/mobile/types.js';
import { directoryFixture } from './mobile-directory-fixture.js';

function catalog(value: MobileOwnerCatalogSnapshot | MobileOwnerPrivateFailure): MobileOwnerCatalogSnapshot {
  if ('kind' in value) assert.fail(`真实冷目录被拒绝：${value.status}/${value.code}`);
  return value;
}
function album(value: MobileAlbum | MobileTrack): MobileAlbum {
  const checked = mobileCatalogResponseSnapshot('album', value); assert.ok(checked.ok); return checked.value;
}
function track(value: MobileAlbum | MobileTrack): MobileTrack {
  const checked = mobileCatalogResponseSnapshot('track', value); assert.ok(checked.ok); return checked.value;
}
function artwork(value: MobileOwnerArtworkSnapshot | MobileOwnerPrivateFailure): MobileOwnerArtworkSnapshot {
  if ('kind' in value) assert.fail(`真实外置封面被拒绝：${value.status}/${value.code}`);
  return value;
}
function failure(value: MobileOwnerArtworkSnapshot | MobileOwnerCatalogSnapshot | MobileOwnerPrivateFailure): void {
  assert.ok('kind' in value); assert.equal(value.kind, 'mobile-error'); assert.equal(value.status, 409); assert.equal(value.code, 'SOURCE_CHANGED');
  assert.equal(value.retryable, false); assert.equal(value.outcome, null);
  assert.deepEqual(Reflect.ownKeys(value).sort(), ['code', 'kind', 'outcome', 'retryable', 'status']);
}

// 真实扫描/Owner/显示许可/Source FD及JPEG；Main边界只逐字验证copies后回传同JPEG，不证明Native解码。
test('MBM扫描目录衔接：真实外置JPEG异步冷读保持手机封面身份及目录修订，错组与旧修订拒绝且quiet', async t => {
  const f = await directoryFixture(t, { withArtwork: true }), expected = f.artwork; assert.ok(expected);
  f.assertNoEditions(); f.assertQuiet();
  assert.equal(f.localAlbums.getCacheInfo().revision, null, 'fixture不得先用Mac query初始化Owner根scope。');
  const initial = catalog(await f.catalogDispatch({ operation: 'listAlbums', offset: 0, limit: 10, catalogPlaybackEnabled: false }));
  assert.equal(initial.total, 3); assert.equal(initial.items.length, 3);
  const coveredTrack = f.scanned.find(row => row.relative.startsWith('目录甲/')); assert.ok(coveredTrack);
  let selected: MobileAlbum | undefined, other: MobileAlbum | undefined;
  for (const value of initial.items) {
    const group = album(value), members = catalog(await f.catalogDispatch({ operation: 'listTracks', albumId: group.id, limit: 10,
      expectedRevision: initial.libraryRevision, catalogPlaybackEnabled: false }));
    assert.equal(members.libraryRevision, initial.libraryRevision); assert.equal(members.total, group.trackCount);
    const items = members.items.map(track); assert.ok(items.every(item => item.albumId === group.id && item.artworkId === group.artworkId));
    if (items.some(item => item.id.split(':')[2] === coveredTrack.track.id)) selected = group;
    else other ??= group;
  }
  assert.ok(selected?.artworkId); assert.ok(other?.artworkId); assert.notEqual(selected.id, other.id);
  const before = expected.metrics();
  assert.equal(before.normalizes, 0); assert.equal(before.coverBodyReads, 0); assert.equal(before.displayGranted, 0);
  const pending = f.artworkDispatch(selected.artworkId);
  assert.equal(expected.metrics().normalizes, 0, '调用先进入原异步Owner读取，不预造图片回包。');
  const result = artwork(await pending), measured = expected.metrics();
  assert.equal(result.datasetId, f.datasetId); assert.equal(result.ownerEpoch, f.ownerEpoch); assert.equal(result.artworkId, selected.artworkId);
  assert.equal(result.libraryRevision, initial.libraryRevision); assert.equal(result.contentType, 'image/jpeg'); assert.match(result.selectionRevision, /^ar:[0-9a-f]{64}$/u);
  assert.equal(Object.getPrototypeOf(result.bytes), Uint8Array.prototype); assert.deepEqual(Buffer.from(result.bytes), expected.bytes);
  assert.equal(createHash('sha256').update(result.bytes).digest('hex'), expected.sha256);
  assert.equal(measured.normalizes, 1); assert.ok(measured.coverBodyReads >= 1); assert.equal(measured.coverBodyBytes, expected.bytes.length);
  assert.ok(measured.displayGranted >= 1); assert.equal(measured.displayGranted, measured.displayReleased); assert.ok(measured.maximumPermits <= 2);
  assert.ok(measured.actualCoverBodyHandles >= 1); assert.equal(measured.verifiedClosedCoverHandles, measured.actualCoverBodyHandles);
  f.assertQuiet(); f.assertReadonly(); await f.assertOriginals();
  const promoted = catalog(await f.catalogDispatch({ operation: 'listAlbums', offset: 0, limit: 10,
    expectedRevision: initial.libraryRevision, catalogPlaybackEnabled: false }));
  assert.deepEqual(promoted, initial, '冷读观察/计数晋升不能改手机目录身份、源修订或artworkId。');

  const ownedParts = selected.artworkId.split(':'), otherParts = other.artworkId.split(':');
  assert.equal(ownedParts.length, 4); assert.equal(otherParts.length, 4); assert.notEqual(ownedParts[3], otherParts[3]);
  const wrongGroup = [...otherParts.slice(0, 3), ownedParts[3]!].join(':'), beforeRejects = expected.metrics();
  failure(await f.artworkDispatch(wrongGroup));
  assert.deepEqual(expected.metrics(), beforeRejects, '错组哈希须在新显示许可/源正文/规范化之前拒绝。');

  // 明确的合成元数据作者动作制造真正旧修订；此后每个只读调用仍逐次核新的主库水位。
  f.repository.localCatalog.overrideMetadata({ commandId: randomUUID(), trackId: coveredTrack.track.id,
    expectedRevision: f.repository.localCatalog.trackDetail(coveredTrack.track.id).metadata.override?.revision ?? null,
    fields: { title: '封面旧修订负例的合成标题' } });
  const afterMutation = f.readonlyStamp();
  const fresh = catalog(await f.catalogDispatch({ operation: 'getAlbum', itemId: selected.id, offset: 0, limit: 1, catalogPlaybackEnabled: false }));
  assert.notEqual(fresh.libraryRevision, initial.libraryRevision); assert.equal(fresh.total, 1);
  const current = album(fresh.items[0]!); assert.equal(current.id, selected.id); assert.ok(current.artworkId); assert.notEqual(current.artworkId, selected.artworkId);
  failure(await f.artworkDispatch(selected.artworkId));
  failure(await f.catalogDispatch({ operation: 'listAlbums', limit: 10, expectedRevision: initial.libraryRevision, catalogPlaybackEnabled: false }));
  assert.deepEqual(expected.metrics(), beforeRejects, '旧修订拒绝不得重新读取Source或借规范化放行。');
  f.assertReadonly(afterMutation); f.assertNoEditions(); await f.assertOriginals(); f.assertQuiet();
  await f.close(); f.assertQuiet(); await f.modules.assertBoundBytes();
});
