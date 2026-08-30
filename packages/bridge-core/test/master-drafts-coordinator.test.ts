import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createCollectionRepository } from '../src/collection/repository.js';
import { createSyntheticRoonLibrary } from '../src/roon/synthetic-library.js';
import { createMasterDraftsCoordinator } from '../src/recording/drafts-coordinator.js';

test('确认选曲只存安全快照，重启保留草稿但不恢复运行引用或 Source Lock', async t => {
  const repository = createCollectionRepository({ filePath: ':memory:' }); t.after(() => repository.close());
  const library = createSyntheticRoonLibrary(), coordinator = createMasterDraftsCoordinator({ repository: repository.drafts, library });
  const album = (await library.browseAlbums({ offset: 0, limit: 20 })).items[0]!;
  const track = (await library.browseAlbum(album.reference, { offset: 0, limit: 20 })).items[0]!;
  const request = { commandId: randomUUID(), title: '我的精选', programType: 'compilation' as const, references: [track.reference], userConfirmed: true as const };
  const saved = coordinator.append(request);
  assert.deepEqual(coordinator.append(request), saved);
  assert.equal(coordinator.runtime(saved.draftId, saved.trackIds[0]!).status, 'available');
  const snapshot = repository.drafts.detail(saved.draftId);
  assert.equal(snapshot.sourceLockEligible, false); assert.equal(snapshot.tracks[0]?.metadata.title, '合成关联曲目');
  assert.doesNotMatch(JSON.stringify(snapshot), /musicbridge-v2|synthetic-private|itemKey|artworkReference/u);
  const restarted = createMasterDraftsCoordinator({ repository: repository.drafts, library });
  assert.deepEqual(restarted.append(request), saved);
  assert.equal(restarted.runtime(saved.draftId, saved.trackIds[0]!).status, 'needs-resolution');
  library.invalidateReferences();
  assert.equal(coordinator.runtime(saved.draftId, saved.trackIds[0]!).status, 'unavailable');
  assert.deepEqual(repository.drafts.detail(saved.draftId), snapshot);
});

test('专辑、旧引用和未确认选择不能创建草稿，删除后曲目运行引用不可使用', async t => {
  const repository = createCollectionRepository({ filePath: ':memory:' }); t.after(() => repository.close());
  const library = createSyntheticRoonLibrary(), coordinator = createMasterDraftsCoordinator({ repository: repository.drafts, library });
  const album = (await library.browseAlbums({ offset: 0, limit: 20 })).items[0]!;
  const track = (await library.browseAlbum(album.reference, { offset: 0, limit: 20 })).items[0]!;
  const request = { commandId: randomUUID(), title: '我的精选', programType: 'compilation' as const, references: [track.reference], userConfirmed: true as const };
  assert.throws(() => coordinator.append({ ...request, references: [album.reference] }));
  assert.throws(() => coordinator.append({ ...request, userConfirmed: false } as unknown as typeof request));
  assert.equal(repository.drafts.list({ offset: 0, limit: 20 }).total, 0);
  const saved = coordinator.append(request);
  coordinator.update({ commandId: randomUUID(), draftId: saved.draftId, expectedRevision: 1, title: '我的精选', programType: 'compilation', trackIds: [] });
  assert.throws(() => coordinator.runtime(saved.draftId, saved.trackIds[0]!));
  library.invalidateReferences();
  assert.throws(() => coordinator.append({ ...request, commandId: randomUUID() }));
  assert.equal(repository.drafts.list({ offset: 0, limit: 20 }).total, 1);
});
