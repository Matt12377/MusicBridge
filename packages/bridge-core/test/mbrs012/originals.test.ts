import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import * as dto from '@music-bridge/contracts';
import { catalogFixture } from '../mbrs006/catalog-fixture.js';
import { createCollectionRepository, type CollectionRepository } from '../../src/collection/repository.js';
import { createLocalSourceWritesStore } from '../../src/collection/local-source-writes-store.js';
import { createSourceOriginalStore } from '../../src/collection/source-original-store.js';
import { SourceWritesError } from '../../src/collection/local-source-writes-journal.js';

const fixtures = new URL('../fixtures/mbrs012-source/', import.meta.url);
const manifestSha256 = '5a3621481eb22801c020589b393c3a1ffa32e3d132766ea6e8db6e33fa47714b';
interface OwnedImage { bytes: Buffer; info: dto.LocalArtworkImageInfo }
async function ownedImage(file: string): Promise<OwnedImage> {
  const raw = await readFile(new URL('manifest.json', fixtures)); assert.equal(createHash('sha256').update(raw).digest('hex'), manifestSha256);
  const manifest = JSON.parse(raw.toString('utf8')) as { synthetic: boolean; allContentOwned: boolean; realLibraryUsed: boolean; files: { file: string; bytes: number; sha256: string; mime?: string; width?: number; height?: number }[] };
  assert.equal(manifest.synthetic, true); assert.equal(manifest.allContentOwned, true); assert.equal(manifest.realLibraryUsed, false);
  const entry = manifest.files.find(v => v.file === file); assert.ok(entry); assert.ok(entry.mime === 'image/png' || entry.mime === 'image/jpeg'); assert.ok(entry.width); assert.ok(entry.height);
  const bytes = await readFile(new URL(file, fixtures)); assert.equal(bytes.length, entry.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
  return { bytes, info: { mime: entry.mime, bytes: entry.bytes, sha256: entry.sha256, width: entry.width, height: entry.height } };
}
function storeFor(repository: CollectionRepository, datasetId: string, rootId: string, directory: string) {
  const journal = createLocalSourceWritesStore(repository.localCatalog);
  const originals = createSourceOriginalStore({ datasetId, directory, assertCurrent: () => { repository.localCatalog.root(rootId); }, artwork: repository.localArtwork,
    read: () => journal.read(view => [...view.projection.originals.values()]),
    cached: (id, fingerprint) => journal.read(view => { const event = view.receipt(id, fingerprint); if (event && event.kind !== 'original') throw new SourceWritesError('COMMAND_ID_REUSED'); return event; }),
    append: event => journal.append(event) });
  return { originals, journal };
}
const rejectsIssue = (code: dto.LocalSourceWritesIssue) => (error: unknown): boolean => error instanceof SourceWritesError && error.code === code;
async function originalFixture(t: TestContext, file = 'owned-cover-16.png') {
  const f = await catalogFixture(t), image = await ownedImage(file), display = await ownedImage('owned-cover-16.jpg');
  const edition = f.repository.localCatalog.createEdition({ commandId: randomUUID(), title: '自有原图测试发行', edition: '' });
  f.repository.localCatalog.linkEditionTrack({ commandId: randomUUID(), editionId: edition.id, trackId: f.tracks[0]!.id, disc: 1, trackNumber: 1, sequence: 1 });
  const currentTarget = f.repository.localArtwork.context({ trackId: f.tracks[0]!.id, editionId: edition.id }).target; assert.ok(currentTarget); assert.ok(dto.isLocalArtworkTarget(currentTarget));
  const target: dto.LocalArtworkTarget = currentTarget;
  function stage(value: OwnedImage) {
    const artwork: dto.LocalArtworkImage = { original: value.info, display: { ...display.info, mime: 'image/jpeg', dataUrl: `data:image/jpeg;base64,${display.bytes.toString('base64')}` } };
    assert.ok(dto.isLocalArtworkImage(artwork));
    const context = f.repository.localArtwork.stage({ target, origin: 'manual', sourceIdentity: value.info.sha256, sourceLabel: '自有合成原图', image: artwork });
    const candidate = context.candidates.find(v => v.original.sha256 === value.info.sha256); assert.ok(candidate); assert.ok(dto.isLocalArtworkCandidate(candidate)); return candidate;
  }
  const candidate = stage(image), originalDirectory = path.join(f.directory, 'source-writes', 'originals'), stores = storeFor(f.repository, f.datasetId, f.root.id, originalDirectory);
  const request: dto.AttachLocalSourceWritesOriginal = { datasetId: f.datasetId, commandId: randomUUID(), target, candidateId: candidate.id, original: image.info, bytes: new Uint8Array(image.bytes) };
  assert.ok(dto.isLocalArtworkTarget(request.target)); assert.deepEqual(dto.localSourceWritesDataSnapshot(dto.localSourceWritesOriginalSnapshot(request).original), dto.localSourceWritesDataSnapshot(candidate.original));
  return { ...f, ...stores, image, display, target, candidate, originalDirectory, request, stage };
}
type Fixture = Awaited<ReturnType<typeof originalFixture>>;
function artworkRef(f: Fixture, contentRef: string, selection: dto.LocalArtworkSelection): dto.LocalSourceWritesArtworkRef {
  return { editionId: f.target.editionId, candidateId: f.candidate.id, selectionId: selection.id, expectedSelectionRevision: selection.revision, contentRef, originalSha256: f.image.info.sha256 };
}

for (const file of ['owned-cover-16.png', 'owned-cover-16.jpg'] as const) test(`012 ${file} 原件：真实SQLite与owned字节闭环，合法cached重试不重复保存`, async t => {
  const f = await originalFixture(t, file);
  try {
    const first = await f.originals.attach(f.request), second = await f.originals.attach({ ...f.request, bytes: new Uint8Array(f.image.bytes) });
    assert.deepEqual(second, first); assert.equal(first.sha256, f.image.info.sha256); assert.equal(first.bytes, f.image.bytes.length);
    assert.equal(f.originals.refs().length, 1); assert.equal(f.journal.read(v => v.projection.events.filter(e => e.kind === 'original').length), 1);
    assert.deepEqual(await f.originals.usage(), { bytes: f.image.bytes.length, count: 1 }); assert.deepEqual(await readFile(path.join(f.originalDirectory, `${first.contentRef}.blob`)), f.image.bytes);
  } finally { await f.originals.close(); f.journal.close(); }
});
for (const file of ['owned-cover-16.png', 'owned-cover-16.jpg'] as const) test(`012 ${file} 原件cached命中也拒同metadata同长度变异binary，原receipt/文件不改`, async t => {
  const f = await originalFixture(t, file);
  try {
    const first = await f.originals.attach(f.request), changed = new Uint8Array(f.image.bytes); changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
    const bad = { ...f.request, bytes: changed }; assert.ok(dto.isLocalArtworkTarget(bad.target)); assert.equal(dto.localSourceWritesOriginalSnapshot(bad).bytes.byteLength, f.image.bytes.length);
    await assert.rejects(() => f.originals.attach(bad), rejectsIssue('ARTWORK_CHANGED'));
    assert.deepEqual(await f.originals.attach(f.request), first); assert.equal(f.originals.refs().length, 1); assert.deepEqual(await readFile(path.join(f.originalDirectory, `${first.contentRef}.blob`)), f.image.bytes);
  } finally { await f.originals.close(); f.journal.close(); }
});
test('012 原图全域commandId不允许换成另一合法candidate和owned原图，缓存不是变参授权', async t => {
  const f = await originalFixture(t);
  try {
    const first = await f.originals.attach(f.request), secondImage = await ownedImage('owned-cover-32.png'), secondCandidate = f.stage(secondImage);
    const changed: dto.AttachLocalSourceWritesOriginal = { ...f.request, candidateId: secondCandidate.id, original: secondImage.info, bytes: new Uint8Array(secondImage.bytes) };
    assert.ok(dto.isLocalArtworkTarget(changed.target)); assert.deepEqual(dto.localSourceWritesDataSnapshot(dto.localSourceWritesOriginalSnapshot(changed).original), dto.localSourceWritesDataSnapshot(secondCandidate.original));
    await assert.rejects(() => f.originals.attach(changed), rejectsIssue('COMMAND_ID_REUSED')); assert.deepEqual(await f.originals.attach(f.request), first);
    assert.equal(f.originals.refs().length, 1); assert.deepEqual(await f.originals.usage(), { bytes: f.image.bytes.length, count: 1 });
  } finally { await f.originals.close(); f.journal.close(); }
});
test('012 原图历史ref保留：换当前选图后关闭/冷开SQLite，旧owned原件仍完整可读而不重attach', async t => {
  const f = await originalFixture(t); let reopened: CollectionRepository | undefined;
  try {
    const first = await f.originals.attach(f.request), selection = f.repository.localArtwork.apply({ commandId: randomUUID(), target: f.target, candidateId: f.candidate.id, expectedSelectionRevision: null });
    const ref = artworkRef(f, first.contentRef, selection), nextImage = await ownedImage('owned-cover-32.jpg'), nextCandidate = f.stage(nextImage);
    const next = f.repository.localArtwork.apply({ commandId: randomUUID(), target: f.target, candidateId: nextCandidate.id, expectedSelectionRevision: selection.revision });
    assert.equal(next.id, selection.id); assert.equal(next.revision, '2'); assert.notEqual(next.candidate!.id, f.candidate.id);
    await f.originals.close(); f.journal.close(); f.repository.close();
    reopened = createCollectionRepository({ filePath: path.join(f.directory, 'collection.sqlite') }); const fresh = storeFor(reopened, f.datasetId, f.root.id, f.originalDirectory);
    try {
      const before = fresh.journal.read(v => v.projection.events.length), material = await fresh.originals.get(ref);
      assert.deepEqual(material.bytes, f.image.bytes); assert.equal(createHash('sha256').update(material.bytes).digest('hex'), ref.originalSha256); assert.equal(material.contentRef, first.contentRef);
      assert.equal(fresh.originals.refs().length, 1); assert.equal(fresh.journal.read(v => v.projection.events.length), before); assert.deepEqual(await fresh.originals.usage(), { bytes: f.image.bytes.length, count: 1 });
      assert.equal(reopened.localArtwork.context({ trackId: f.target.trackId, editionId: f.target.editionId }).selection!.candidate!.id, nextCandidate.id);
    } finally { await fresh.originals.close(); fresh.journal.close(); }
  } finally { await f.originals.close(); f.journal.close(); reopened?.close(); }
});
test('012 原图旧Artwork目标守卫保持：expectedSourceRevision正例必须64位Hash，数字revision拒绝不产生文件/事件', async t => {
  const f = await originalFixture(t);
  try {
    assert.ok(dto.isLocalArtworkTarget(f.request.target)); const wrong = { ...f.request, target: { ...f.target, expectedSourceRevision: '1' } };
    assert.equal(dto.isLocalArtworkTarget(wrong.target), false); await assert.rejects(async () => f.originals.attach(wrong));
    assert.equal(f.originals.refs().length, 0); assert.equal(f.journal.read(v => v.projection.events.length), 0);
  } finally { await f.originals.close(); f.journal.close(); }
});
for (const [file, damage] of [
  ['owned-cover-16.png', (bytes: Buffer) => { const bad = Buffer.from(bytes); bad[29] = bad[29]! ^ 1; return bad; }],
  ['owned-cover-16.jpg', (bytes: Buffer) => Buffer.from(bytes.subarray(0, bytes.length - 2))],
] as const) test(`012 ${file} 原图独立结构核验：合法旧metadata/candidate且完整声明Hash吻合，仍拒损坏CRC或缺EOI`, async t => {
  const f = await originalFixture(t, file);
  try {
    const broken = damage(f.image.bytes), damagedImage: OwnedImage = { bytes: broken, info: { ...f.image.info, bytes: broken.length, sha256: createHash('sha256').update(broken).digest('hex') } }, candidate = f.stage(damagedImage);
    const request: dto.AttachLocalSourceWritesOriginal = { ...f.request, commandId: randomUUID(), candidateId: candidate.id, original: damagedImage.info, bytes: new Uint8Array(broken) };
    assert.ok(dto.isLocalArtworkTarget(request.target)); assert.deepEqual(dto.localSourceWritesDataSnapshot(candidate.original), dto.localSourceWritesDataSnapshot(dto.localSourceWritesOriginalSnapshot(request).original));
    await assert.rejects(() => f.originals.attach(request), rejectsIssue('ARTWORK_UNAVAILABLE'));
    assert.equal(f.originals.refs().length, 0); assert.equal(f.journal.read(v => v.projection.events.length), 0);
    assert.deepEqual(await f.originals.usage(), { bytes: 0, count: 0 }); assert.deepEqual(await readdir(f.originalDirectory), []);
  } finally { await f.originals.close(); f.journal.close(); }
});
