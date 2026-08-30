import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createCollectionRepository } from '../src/collection/repository.js';
import { createPhysicalLinksCoordinator } from '../src/collection/physical-links-coordinator.js';
import { createRoonPublicLibrary } from '../src/roon/public-library.js';
import type { RoonLibraryService } from '../src/roon/library.js';

function fixture(t: test.TestContext) {
  const repository = createCollectionRepository({ filePath: ':memory:' }); t.after(() => repository.close());
  const empty = async () => ({ items: [], offset: 0, level: 0 });
  let available = true;
  const service: RoonLibraryService = {
    browseAlbums: async () => ({ items: [{ kind: 'album', title: '合成专辑', artist: '合成艺术家', version: '首版', itemKey: 'private-roon-item' }], offset: 0, level: 0 }),
    browseArtists: empty, browseGenres: empty, browsePlaylists: empty, browseArtist: empty, browseGenre: empty, browsePlaylist: empty, browseAlbum: empty,
    searchLibrary: async () => service.browseAlbums({ offset: 0, limit: 20 }), getImage: async () => ({ contentType: 'image/jpeg', body: Buffer.from([255,216,255,217]) }), playTrack: async () => undefined, queueTrack: async () => undefined,
  };
  const library = createRoonPublicLibrary(() => available ? service : undefined);
  const coordinator = createPhysicalLinksCoordinator({ repository: repository.links, library });
  const release = repository.music.saveRelease({ commandId: randomUUID(), release: { format: 'cd', title: '合成专辑', artist: '合成艺术家', quantity: 1, completeness: 'basic', tracks: [] } });
  return { repository, library, coordinator, releaseId: release.id, offline: () => { available = false; }, online: () => { available = true; } };
}

test('用户确认关联只持久化安全元数据，重建协调器后仍有关系但没有运行期引用', async t => {
  const f = fixture(t);
  const candidate = (await f.coordinator.search('', { offset: 0, limit: 20 })).items[0]!;
  const request = { commandId: randomUUID(), releaseId: f.releaseId, expectedRevision: 1, reference: candidate.reference, relation: 'exact' as const, ripFromCdConfirmed: false, userConfirmed: true as const };
  const result = f.coordinator.confirm(request);
  assert.deepEqual(f.coordinator.confirm(request), result);
  assert.equal(f.coordinator.runtime(result.digitalId!).status, 'available');
  assert.doesNotMatch(JSON.stringify(f.repository.links.digitalDetail(result.digitalId!)), /musicbridge-v2|private-roon-item|itemKey/u);
  const restarted = createPhysicalLinksCoordinator({ repository: f.repository.links, library: f.library });
  assert.equal(restarted.runtime(result.digitalId!).status, 'needs-resolution');
  assert.deepEqual(restarted.confirm(request), result);
  assert.equal(restarted.runtime(result.digitalId!).status, 'needs-resolution');
});

test('离线保留实体关系，旧引用不重连；重新定位必须明确确认当前专辑', async t => {
  const f = fixture(t);
  const first = (await f.coordinator.search('', { offset: 0, limit: 20 })).items[0]!;
  const result = f.coordinator.confirm({ commandId: randomUUID(), releaseId: f.releaseId, expectedRevision: 1, reference: first.reference, relation: 'probable', ripFromCdConfirmed: false, userConfirmed: true });
  f.offline(); assert.equal(f.coordinator.runtime(result.digitalId!).status, 'unavailable');
  assert.equal(f.repository.links.physical(f.releaseId).links.length, 1);
  f.online(); assert.equal(f.coordinator.runtime(result.digitalId!).status, 'unavailable');
  const current = (await f.coordinator.search('', { offset: 0, limit: 20 })).items[0]!;
  assert.notEqual(current.reference, first.reference);
  const album = f.repository.links.digitalDetail(result.digitalId!).album;
  f.coordinator.relocate({ commandId: randomUUID(), digitalId: album.id, expectedRevision: album.revision, reference: current.reference, userConfirmed: true });
  assert.equal(f.coordinator.runtime(album.id).status, 'available');
});

test('重新定位拒绝不同元数据且不改变原关系，无确认请求不会产生数字对象', async t => {
  const f = fixture(t);
  const candidate = (await f.coordinator.search('', { offset: 0, limit: 20 })).items[0]!;
  const request = { commandId: randomUUID(), releaseId: f.releaseId, expectedRevision: 1, reference: candidate.reference, relation: 'exact' as const, ripFromCdConfirmed: false, userConfirmed: true as const };
  assert.throws(() => f.coordinator.confirm({ ...request, userConfirmed: false } as unknown as typeof request), /确认/u);
  assert.equal(f.repository.links.digitalList({ offset: 0, limit: 20 }).total, 0);
  const result = f.coordinator.confirm(request), before = f.repository.links.digitalDetail(result.digitalId!);
  const changed = createPhysicalLinksCoordinator({ repository: f.repository.links, library: { ...f.library, getAlbumSnapshot: () => ({ title: '另一张专辑' }) } });
  assert.throws(() => changed.relocate({ commandId: randomUUID(), digitalId: result.digitalId!, expectedRevision: before.album.revision, reference: candidate.reference, userConfirmed: true }), /元数据已改变/u);
  assert.deepEqual(f.repository.links.digitalDetail(result.digitalId!), before);
  assert.equal(changed.runtime(result.digitalId!).status, 'needs-resolution');
});

test('同一运行引用的元数据变化不能沿用已存数字身份建立新关系', async t => {
  const f = fixture(t);
  let changed = false;
  const coordinator = createPhysicalLinksCoordinator({ repository: f.repository.links, library: { ...f.library, getAlbumSnapshot: reference => changed ? { title: '另一版' } : f.library.getAlbumSnapshot(reference) } });
  const candidate = (await coordinator.search('', { offset: 0, limit: 20 })).items[0]!;
  const request = { commandId: randomUUID(), releaseId: f.releaseId, expectedRevision: 1, reference: candidate.reference, relation: 'exact' as const, ripFromCdConfirmed: false, userConfirmed: true as const };
  const result = coordinator.confirm(request), before = f.repository.links.digitalDetail(result.digitalId!);
  changed = true;
  assert.throws(() => coordinator.confirm({ ...request, commandId: randomUUID(), expectedRevision: 2 }), /关联请求无效/u);
  assert.deepEqual(f.repository.links.digitalDetail(result.digitalId!), before);
});
