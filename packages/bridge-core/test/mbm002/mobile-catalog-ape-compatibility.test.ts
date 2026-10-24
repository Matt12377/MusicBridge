import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { authorizeSourceDirectory, readonlySourceCandidateMetadata } from '../../src/recording/source-files.js';
import { createLocalAlbumOwnerRuntime } from '../../src/collection/local-album-browser/owner-runtime.js';
import { createMobileOwnerService } from '../../src/mobile/owner-service.js';
import { createMobileOwnerSourceService } from '../../src/mobile/source-service.js';
import { createLocalSourceTickets } from '../../src/collection/local-source-tickets.js';
import { CUE_INPUT_SCAN_VERSION, METADATA_PARSER_VERSION } from '../../src/library/metadata-reader-types.js';
import { LocalFileSourcePool } from '../../src/stream/local-file-source.js';
import type { ScanPreparedItem, ScanPreparedBatch } from '../../src/collection/local-scan-store.js';
import type { MobileOwnerCatalogRequest } from '../../src/mobile/types.js';
import { mobileCatalogResponseSnapshot, type MobileTrack } from '@music-bridge/contracts';

/** 真实SQLite、来源签名与原提交证明，只有技术解析事实是明确的合成输入；不解析真实APE或调用Provider。 */
async function fixture(t: TestContext, count = 201) {
  assert.ok(process.env.TMPDIR?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
  const directory = await mkdtemp(path.join(process.env.TMPDIR!, 'catalog-ape-')), media = path.join(directory, 'media'); await mkdir(media);
  const repository = createCollectionRepository({ filePath: path.join(directory, 'collection.sqlite') });
  const sourceRoot = await authorizeSourceDirectory(media), source = repository.sources.authorize(randomUUID(), sourceRoot);
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' }), datasetId = randomUUID(), ownerEpoch = randomUUID();
  const parserVersion = METADATA_PARSER_VERSION, items: ScanPreparedItem[] = [];
  for (let index = 0; index < count; index++) {
    const relative = `synthetic-${String(index).padStart(4, '0')}.ape`; await writeFile(path.join(media, relative), Buffer.from('MAC synthetic-not-a-decoder-fixture'));
    const observation = await readonlySourceCandidateMetadata(repository.sources.root(source.id), relative);
    items.push({ relative, signature: observation.signature, parserVersion, outcome: 'accepted', fields: { title: `合成APE${index}`, album: '合成APE集合' }, failureCode: null, reused: false,
      readFacts: { technical: { container: 'APE', codec: 'APE', lossless: true, sampleRateHz: 44100, channels: 2, bitsPerSample: index % 2 ? 24 : 16, durationSeconds: 1, evidence: 'bounded-parser-reported' },
        coverEvidence: [], readEvidence: { bytesRead: 8, readCalls: 1, maxReadBytes: 8, allocationBytes: 8, elapsedMs: 0, wholeAudioHash: false, wholeAudioDecode: false } } });
  }
  const pending = repository.localScan.start({ commandId: randomUUID(), datasetId, libraryRootId: root.id, expectedRootRevision: root.revision, parserVersion: CUE_INPUT_SCAN_VERSION }).job;
  let job = repository.localScan.resume({ commandId: randomUUID(), jobId: pending.jobId, expectedRevision: pending.jobRevision });
  // 原每批200项上限完整保留；测试201条需要真实连续两次提交。
  for (let offset = 0; offset < items.length; offset += 200) {
    const batch: ScanPreparedBatch = { batchId: randomUUID(), jobId: job.jobId, expectedJobRevision: job.jobRevision,
      checkpointBefore: job.checkpointRef, items: items.slice(offset, offset + 200), frontier: [], completed: offset + 200 >= items.length };
    repository.localScan.privatePrepareBatch({ commandId: randomUUID(), jobId: job.jobId, batch });
    job = repository.localScan.privateCommitBatch({ commandId: randomUUID(), jobId: job.jobId, batchId: batch.batchId, expectedRevision: job.jobRevision });
  }
  assert.equal(job.phase, 'completed');
  const runtime = createLocalAlbumOwnerRuntime({ repository, datasetId, assertCurrent() {}, readRootViews: async () => [{ root: repository.localCatalog.root(root.id), label: '合成来源', availability: 'ONLINE' }] });
  const catalog = createMobileOwnerService({ collection: repository, datasetId, ownerEpoch, localAlbums: runtime.localAlbums, assertCurrent() {} });
  const tickets = createLocalSourceTickets(repository, ownerEpoch, datasetId, () => {}), service = createMobileOwnerSourceService({ collection: repository, datasetId, ownerEpoch, localAlbums: runtime.localAlbums, tickets, assertCurrent() {} });
  t.after(async () => { await service.close(); tickets.seal(); await runtime.close(); repository.close(); await rm(directory, { recursive: true }); });
  const page = (overrides: Partial<MobileOwnerCatalogRequest> = {}) => catalog.dispatch({ kind: 'catalog', datasetId, request: { operation: 'listTracks', serverId: 'server.synthetic', offset: 0, limit: 100, q: '', albumId: null, itemId: null, expectedRevision: null, catalogPlaybackEnabled: true, ...overrides } });
  const track = (value: unknown): MobileTrack => { const result = mobileCatalogResponseSnapshot('track', value); assert.ok(result.ok); return result.value; };
  return { repository, service, tickets, page, track };
}

test('APE真实SQLite目录16/24bit保完整100项和后页，规格/身份不伪装且全部unavailable', { timeout: 15000 }, async t => {
  const f = await fixture(t), ids: string[] = []; let revision: string | null = null;
  for (let offset = 0; offset < 201; offset += 100) {
    const result = await f.page({ offset, expectedRevision: revision }); assert.ok('items' in result && 'total' in result);
    revision ??= result.libraryRevision; assert.equal(result.libraryRevision, revision); assert.equal(result.total, 201);
    assert.equal(result.items.length, Math.min(100, 201 - offset));
    for (const row of result.items) { const track = f.track(row); ids.push(track.id); assert.equal(track.audio.codec, 'ape'); assert.equal(track.audio.container, 'ape'); assert.equal(track.audio.sampleRateHz, 44100); assert.equal(track.audio.channels, 2); assert.ok([16, 24].includes(track.audio.bitsPerSample!)); assert.equal(track.availability, 'unavailable'); }
  }
  assert.equal(ids.length, 201); assert.equal(new Set(ids).size, 201);
});

test('APE目录可见不新增播放能力：16/24bit prepare仍UNSUPPORTED_FORMAT且原lease/ticket清理', { timeout: 10000 }, async t => {
  const f = await fixture(t, 2), result = await f.page(); assert.ok('items' in result);
  let prepares = 0; const original = LocalFileSourcePool.prototype.prepare;
  t.mock.method(LocalFileSourcePool.prototype, 'prepare', function (this: LocalFileSourcePool, ...args: Parameters<typeof original>) { prepares++; return original.apply(this, args); });
  for (const row of result.items) {
    const track = f.track(row), failed = await f.service.dispatch({ operation: 'prepare', selection: { resourceId: randomUUID(), trackId: track.id, versionId: track.versionId, contentRevision: track.contentRevision } });
    assert.equal(failed.kind, 'mobile-error'); assert.ok(failed.kind === 'mobile-error'); assert.equal(failed.status, 409); assert.equal(failed.code, 'UNSUPPORTED_FORMAT');
    assert.equal(prepares, 0); assert.equal(f.tickets.size, 0);
    const snapshot = f.service.resourceSnapshot(); for (const key of ['liveResources', 'readers', 'activeIo', 'openLeases', 'tickets', 'retainedFences', 'lanes'] as const) assert.equal(snapshot[key], 0);
  }
});

test('APE兼容不绕过缺失/畸形参数和身份修订：仍按原错误拒绝不跳坏行', { timeout: 10000 }, async t => {
  const f = await fixture(t, 2), result = await f.page(); assert.ok('items' in result); const track = f.track(result.items[0]);
  const identityChanged = await f.service.dispatch({ operation: 'prepare', selection: { resourceId: randomUUID(), trackId: track.id, versionId: track.versionId, contentRevision: 'lc:' + '0'.repeat(64) } });
  assert.ok(identityChanged.kind === 'mobile-error'); assert.equal(identityChanged.code, 'SOURCE_CHANGED'); assert.equal(f.tickets.size, 0);
  const original = f.repository.localScan.privateDisplayFileParameters;
  t.mock.method(f.repository.localScan, 'privateDisplayFileParameters', () => null);
  const absent = await f.page(); assert.ok('kind' in absent); assert.equal(absent.kind, 'mobile-error');
  if (absent.kind === 'mobile-error') assert.equal(absent.status, 503);
  t.mock.restoreAll();
  t.mock.method(f.repository.localScan, 'privateDisplayFileParameters', (...args: Parameters<typeof original>) => { const value = original.apply(f.repository.localScan, args); return value ? { ...value, codec: 'APE/非法路径' } : value; });
  const malformed = await f.page(); assert.ok('kind' in malformed); assert.equal(malformed.kind, 'mobile-error');
  if (malformed.kind === 'mobile-error') assert.equal(malformed.status, 503);
});
