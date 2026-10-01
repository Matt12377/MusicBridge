import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createDatasetRoonProjectionGateway } from '../src/collection/dataset-roon-projection.js';
import { createSyntheticRoonLibrary } from '../src/roon/synthetic-library.js';
import type { RoonPublicLibrary } from '../src/roon/public-library.js';

async function fixture(t: test.TestContext) {
  const original = createSyntheticRoonLibrary();
  const page = { offset: 0, limit: 20 };
  const albums = await original.browseAlbums(page);
  const tracks = await Promise.all(albums.items.map(album => original.browseAlbum(album.reference, page)));
  let scope = '父Core媒体库代际1';
  let source: RoonPublicLibrary = { ...original, getReadScope: () => scope };
  const epoch = randomUUID();
  const gateway = createDatasetRoonProjectionGateway(() => source, { isCurrentOwner: candidate => candidate === epoch });
  t.after(() => gateway.close());
  return { original, albums, tracks, page, epoch, gateway,
    changeScope() { scope = '父Core媒体库代际2'; },
    replace(value: RoonPublicLibrary) { source = value; }, source: () => source };
}

test('媒体库代际失效或来源替换后，未许可元数据不能进入owner事务', async t => {
  const f = await fixture(t);
  const first = await f.gateway.handler('captureAlbumMetadata', { reference: f.albums.items[0]!.reference }, { epoch: f.epoch });
  f.changeScope();
  await assert.rejects(f.gateway.handler('acquirePermit', { scope: first.scope, projectionId: first.projectionId }, { epoch: f.epoch }), /来源已经变化/u);
  const second = await f.gateway.handler('captureAlbumMetadata', { reference: f.albums.items[0]!.reference }, { epoch: f.epoch });
  // 即使合成来源碰巧沿用scope字符串，也不能借用另一个来源的快照。
  f.replace({ ...f.source() });
  await assert.rejects(f.gateway.handler('acquirePermit', { scope: second.scope, projectionId: second.projectionId }, { epoch: f.epoch }), /来源已经变化/u);
});

test('已因来源替换而拒绝的元数据票据不能随旧来源返回重新取得许可', async t => {
  const f = await fixture(t);
  const source = f.source();
  const capture = await f.gateway.handler('captureAlbumMetadata', { reference: f.albums.items[0]!.reference }, { epoch: f.epoch });
  const ticket = { scope: capture.scope, projectionId: capture.projectionId };
  f.replace({ ...source });
  await assert.rejects(f.gateway.handler('acquirePermit', ticket, { epoch: f.epoch }), /来源已经变化/u);
  f.replace(source);
  await assert.rejects(f.gateway.handler('acquirePermit', ticket, { epoch: f.epoch }), /来源已经变化/u);
});

test('许可先成立的同步事务可以完成并释放；之后失效和重复许可不冒充新权限', async t => {
  const f = await fixture(t);
  const capture = await f.gateway.handler('captureAlbumMetadata', { reference: f.albums.items[0]!.reference }, { epoch: f.epoch });
  const ticket = { scope: capture.scope, projectionId: capture.projectionId };
  const permit = await f.gateway.handler('acquirePermit', ticket, { epoch: f.epoch });
  await assert.rejects(f.gateway.handler('acquirePermit', ticket, { epoch: f.epoch }), /来源已经变化/u);
  f.changeScope();
  await assert.rejects(f.gateway.handler('releasePermit', { ...permit, permitId: randomUUID() }, { epoch: f.epoch }), /来源已经变化/u);
  assert.deepEqual(await f.gateway.handler('releasePermit', permit, { epoch: f.epoch }), { released: true });
  await assert.rejects(f.gateway.handler('releasePermit', permit, { epoch: f.epoch }), /来源已经变化/u);
});

test('投影限定当前owner并保持整批选曲次序，私有运行引用不出现在快照', async t => {
  const f = await fixture(t);
  const references = [f.tracks[1]!.items[0]!.reference, f.tracks[0]!.items[0]!.reference];
  await assert.rejects(f.gateway.handler('captureTrackMetadataBatch', { references }, { epoch: randomUUID() }), /来源已经变化/u);
  const result = await f.gateway.handler('captureTrackMetadataBatch', { references }, { epoch: f.epoch });
  assert.deepEqual(result.metadata, references.map(reference => f.original.getTrackSnapshot(reference)));
  assert.doesNotMatch(JSON.stringify(result.metadata), /reference|itemKey|sessionId/u);
  f.gateway.close();
  await assert.rejects(f.gateway.handler('acquirePermit', { scope: result.scope, projectionId: result.projectionId }, { epoch: f.epoch }), /来源已经变化/u);
});

test('异步Browse迟到返回不能跨库代际或关闭后进入owner', async t => {
  const f = await fixture(t);
  let finish!: (value: Awaited<ReturnType<RoonPublicLibrary['browseAlbums']>>) => void;
  f.replace({ ...f.source(), browseAlbums: () => new Promise(resolve => { finish = resolve; }) });
  const pending = f.gateway.handler('browseAlbumCandidates', { query: '', page: f.page }, { epoch: f.epoch });
  const rejected = assert.rejects(pending, /来源已经变化/u);
  f.changeScope();
  finish(f.albums);
  await rejected;
  const pendingAfterClose = f.gateway.handler('browseAlbumCandidates', { query: '', page: f.page }, { epoch: f.epoch });
  const rejectedAfterClose = assert.rejects(pendingAfterClose, /来源已经变化/u);
  f.gateway.close();
  finish(f.albums);
  await rejectedAfterClose;
});
