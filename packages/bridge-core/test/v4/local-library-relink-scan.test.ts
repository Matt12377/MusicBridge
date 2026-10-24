import assert from 'node:assert/strict';
import test, { after, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import * as dto from '@music-bridge/contracts';
import { lstat, mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { createDatasetDomain } from '../../src/collection/dataset-domain.js';
import { createBackupWorkflowStore } from '../../src/recording/backup-workflow-store.js';
import { authorizeSourceDirectory } from '../../src/recording/source-files.js';
import { createScanReadAdmission } from '../../src/library/scan-read-admission.js';
import { closeRustMediaWorkerPool } from '../../src/library/rust-media-worker.js';
import { createLocalAlbumArtworkReader } from '../../src/collection/local-album-browser/artwork-read-port.js';
import type { LocalAlbumArtworkReadContext } from '../../src/collection/local-album-browser/types.js';
import type { DatasetProjectionPort, DatasetProjectionCommand, DatasetProjectionCommandPayloads, DatasetProjectionCommandResults } from '../../src/collection/dataset-owner-protocol.js';

after(closeRustMediaWorkerPool);

async function fixture(t: TestContext) {
  const temporary = process.env.TMPDIR;
  assert.ok(temporary && path.isAbsolute(temporary));
  if (process.platform === 'darwin') assert.ok(temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
  assert.ok((await lstat(temporary)).isDirectory());
  const directory = await mkdtemp(path.join(temporary, 'musicbridge-relink-scan-'));
  const media = path.join(directory, 'media'), targetDirectory = path.join(directory, 'new-mount');
  await mkdir(path.join(media, 'album'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(media, 'album/song.wav'), await readFile(new URL('../fixtures/mbrs003/audio/fixtures/core-wav.wav', import.meta.url)), { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(media, 'album/folder.png'), await readFile(new URL('../fixtures/mbrs012-source/owned-cover-16.png', import.meta.url)), { flag: 'wx', mode: 0o600 });
  const file = path.join(directory, 'collection.sqlite');
  const repository = createCollectionRepository({ filePath: file });
  repository.localCatalog.roots();
  const maintenance = createBackupWorkflowStore({ filePath: path.join(directory, 'maintenance.sqlite') });
  const identity = maintenance.datasetIdentities.bind('default', file, false);
  const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media));
  const originalRoot = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
  let busy = false, grants = 0;
  const datasetId = identity.datasetId;
  const gate = createScanReadAdmission({ isBusy: () => busy }), epoch = randomUUID();
  const projection: DatasetProjectionPort = {
    async call<K extends DatasetProjectionCommand>(command: K, payload: DatasetProjectionCommandPayloads[K]): Promise<DatasetProjectionCommandResults[K]> {
      const scope = { epoch, datasetId };
      let result: unknown;
      if (command === 'scanReadAcquire') {
        result = gate.acquire(scope, Object.hasOwn(payload, 'purpose') ? 'local-album-display' : 'scan');
        if ((result as { status: string }).status === 'granted') grants++;
      } else if (command === 'scanReadWatchRevocation') result = await gate.watchRevocation(scope, (payload as { permitId: string }).permitId);
      else if (command === 'scanReadRelease') result = gate.release(scope, (payload as { permitId: string }).permitId);
      else throw new Error('合成重关联回归只允许真实本地读取准入。');
      return result as DatasetProjectionCommandResults[K];
    },
  };
  const domain = createDatasetDomain({ collectionRepository: repository, backupWorkflowStore: maintenance, collectionDatasetIdentity: identity, localSourceEpoch: epoch, projection });
  t.after(async () => {
    try { await domain.close(); }
    finally {
      gate.close();
      assert.deepEqual(gate.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: true });
    }
  });
  const initial = domain.localScan.start({ commandId: randomUUID(), libraryRootId: originalRoot.id, expectedRootRevision: originalRoot.revision });
  await domain.localScan.privateWait(initial.jobId);
  assert.equal(domain.localScan.get(initial.jobId).phase, 'completed');
  assert.equal(domain.localScan.get(initial.jobId).progress.accepted, '1');
  const track = repository.localCatalog.pageTracks({ offset: 0, limit: 1 }).items[0]!;
  const asset = repository.localCatalog.asset(track.assetId);
  repository.localCatalog.overrideMetadata({ commandId: randomUUID(), trackId: track.id, expectedRevision: null, fields: { title: '重关联后仍保留的人工标题' } });
  const metadata = repository.localCatalog.metadata(track.id);
  await rename(media, targetDirectory);
  const target = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(targetDirectory));
  const request = { commandId: randomUUID(), rootId: originalRoot.id, expectedRevision: originalRoot.revision, targetSourceRootId: target.id, userConfirmed: true as const };
  return { domain, repository, gate, projection, request, originalRoot, target, track, asset, metadata,
    setBusy(value: boolean) { busy = value; gate.observe(); }, grants: () => grants,
    assertQuiet() { assert.deepEqual(gate.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: false }); } };
}

test('V4 重关联：真实目录确认自动提交同操作扫描，冷/热封面与稳定资产在复扫后恢复', { timeout: 30_000 }, async t => {
  const f = await fixture(t), root = await f.domain.localRelocation.relinkRoot(f.request);
  assert.equal(root.id, f.originalRoot.id); assert.equal(root.revision, '2');
  const receipt = f.domain.localScan.receipt(f.request.commandId);
  assert.ok(receipt, '目录重关联确认必须关联同一操作编号的新修订扫描');
  assert.equal(receipt.operation, 'start'); assert.equal(receipt.result.sourceRootId, f.target.id); assert.equal(receipt.result.rootRevision, root.revision);
  await f.domain.localScan.privateWait(receipt.jobId);
  const completed = f.domain.localScan.get(receipt.jobId);
  assert.equal(completed.phase, 'completed'); assert.equal(completed.progress.accepted, '1');
  const asset = f.repository.localCatalog.asset(f.asset.id);
  assert.equal(asset.id, f.asset.id); assert.equal(asset.sourceRootId, f.target.id); assert.equal(asset.rootRevision, root.revision);
  assert.equal(asset.fileRevision, '2'); assert.equal(asset.locationRevision, '2');
  assert.equal(f.repository.localCatalog.track(f.track.id).assetId, f.asset.id);
  assert.deepEqual(f.repository.localCatalog.metadata(f.track.id), f.metadata);
  const albums = f.domain.localAlbums;
  assert.ok(albums, '真实Owner必须装配本地专辑读取服务');
  const page = await albums.queryAlbums({ query: '', rootId: root.id, filter: 'all', offset: 0, limit: 1 });
  const album = page.items[0]!;
  const artworkRequest = { albumKey: album.id, rootId: album.rootId, editionId: album.editionId, representativeTrackId: album.representativeTrackId, revision: album.revision };
  const originalContext = f.repository.localCatalog.privateAlbumBrowserArtwork.bind(f.repository.localCatalog);
  let captured: LocalAlbumArtworkReadContext | undefined;
  t.mock.method(f.repository.localCatalog, 'privateAlbumBrowserArtwork', (...args: Parameters<typeof originalContext>) => {
    const context = originalContext(...args); captured = structuredClone(context);
    const representative = context.representative;
    assert.ok(representative);
    const detail = f.repository.localCatalog.trackDetail(representative.summary.track.id);
    const comparisons = { track: [detail.track, representative.summary.track], asset: [detail.asset, representative.summary.asset],
      raw: [detail.metadata.raw, representative.rawMetadata], effective: [detail.metadata.effective, representative.summary.metadata] };
    t.diagnostic(JSON.stringify(Object.fromEntries(Object.entries(comparisons).map(([key, values]) => [key, {
      deepEqual: isDeepStrictEqual(values[0], values[1]), jsonEqual: JSON.stringify(values[0]) === JSON.stringify(values[1]),
    }]))));
    for (const [key, values] of Object.entries(comparisons)) assert.deepEqual(values[0], values[1], `${key}实际值必须一致，不能以变更来源通过正例`);
    assert.equal(detail.asset.sourceRootId, root.sourceRootId); assert.equal(detail.asset.rootRevision, root.revision);
    return context;
  });
  const cold = await albums.getArtwork(artworkRequest).catch(async error => {
    if (captured) {
      const probe = createLocalAlbumArtworkReader({ repository: f.repository, projection: f.projection, datasetId: f.domain.datasetId, assertCurrent: () => f.domain.assertOpen() });
      try {
        const result = await probe.readSources({ request: artworkRequest, context: captured }, randomUUID(), undefined, performance.now() + 2000, 'display');
        t.diagnostic(JSON.stringify({ directReaderCompleted: true, hasImage: result.image !== null, imageValid: dto.isLocalArtworkImage(result.image), hasGrid: !!result.grid,
          gridValid: dto.isLocalAlbumArtworkGrid(result.grid), replyValid: dto.isLocalAlbumArtworkReply({ ...artworkRequest, image: result.image, status: result.copies.status, ...(result.grid ? { grid: result.grid } : {}) }, artworkRequest) }));
      }
      catch (original) { t.diagnostic(`合成封面Reader原始拒绝：${original instanceof Error ? original.stack : String(original)}`); }
      finally { await probe.close(); }
    }
    throw error;
  });
  const hot = await albums.getArtwork(artworkRequest);
  assert.equal(cold.status, 'ready'); assert.ok(cold.image); assert.ok(cold.grid); assert.deepEqual(hot, cold);
  const count = f.domain.localScan.page({ offset: 0, limit: 200 }).total, grants = f.grants();
  assert.deepEqual(await f.domain.localRelocation.relinkRoot(f.request), root);
  assert.equal(f.domain.localScan.page({ offset: 0, limit: 200 }).total, count);
  assert.deepEqual(f.domain.localScan.get(receipt.jobId), completed); assert.equal(f.grants(), grants);
  assert.deepEqual(f.domain.localScan.receipt(f.request.commandId), receipt); f.assertQuiet();
  assert.ok(captured);
  const reader = createLocalAlbumArtworkReader({ repository: f.repository, projection: f.projection, datasetId: f.domain.datasetId, assertCurrent: () => f.domain.assertOpen() });
  try {
    const oldOverride = f.repository.localCatalog.metadata(f.track.id).override;
    f.repository.localCatalog.overrideMetadata({ commandId: randomUUID(), trackId: f.track.id, expectedRevision: oldOverride!.revision, fields: { title: '捕获后实际修改的标题' } });
    await assert.rejects(reader.readSources({ request: artworkRequest, context: captured }, randomUUID(), undefined, performance.now() + 2000, 'display'), /专辑封面来源已改变/u);
    f.assertQuiet();
  } finally { await reader.close(); }
});

test('V4 重关联：同命令重复确认保留手动暂停、取消和失败，不启动替代扫描', { timeout: 30_000 }, async t => {
  for (const phase of ['paused', 'cancelled', 'failed'] as const) {
    const f = await fixture(t); f.setBusy(true);
    const root = await f.domain.localRelocation.relinkRoot(f.request), receipt = f.domain.localScan.receipt(f.request.commandId);
    assert.ok(receipt, '重关联必须先持久关联扫描，不能依赖刷新页面补建任务');
    const running = f.domain.localScan.get(receipt.jobId);
    const paused = await f.domain.localScan.pause({ commandId: randomUUID(), jobId: running.jobId, expectedRevision: running.jobRevision });
    if (phase === 'cancelled') await f.domain.localScan.cancel({ commandId: randomUUID(), jobId: paused.jobId, expectedRevision: paused.jobRevision });
    else if (phase === 'failed') f.repository.localScan.privateFail({ commandId: randomUUID(), jobId: paused.jobId, expectedRevision: paused.jobRevision, code: 'SCAN_READ_FAILED' });
    f.setBusy(false);
    const before = f.domain.localScan.get(receipt.jobId), count = f.domain.localScan.page({ offset: 0, limit: 200 }).total, grants = f.grants();
    assert.equal(before.phase, phase);
    for (let retry = 0; retry < 2; retry++) assert.deepEqual(await f.domain.localRelocation.relinkRoot(f.request), root);
    await f.domain.localScan.privateWait(receipt.jobId);
    assert.deepEqual(f.domain.localScan.get(receipt.jobId), before);
    assert.equal(f.domain.localScan.page({ offset: 0, limit: 200 }).total, count); assert.equal(f.grants(), grants);
    assert.deepEqual(f.repository.localCatalog.asset(f.asset.id), f.asset, '未获新扫描确认前不能覆盖旧资产来源');
    f.assertQuiet();
  }
});

test('V4 重关联：根已提交而扫描接线中断，同原命令重试补齐一次扫描', { timeout: 30_000 }, async t => {
  const f = await fixture(t), originalReceipt = f.domain.localScan.receipt.bind(f.domain.localScan);
  let interrupted = false;
  t.mock.method(f.domain.localScan, 'receipt', (commandId: string) => {
    if (commandId === f.request.commandId && !interrupted) { interrupted = true; throw new Error('合成根提交后扫描接线中断'); }
    return originalReceipt(commandId);
  });
  await assert.rejects(f.domain.localRelocation.relinkRoot(f.request), /合成根提交后扫描接线中断/u);
  const committed = f.repository.localCatalog.root(f.originalRoot.id);
  assert.equal(committed.sourceRootId, f.target.id); assert.equal(committed.revision, '2');
  assert.equal(originalReceipt(f.request.commandId), null); assert.deepEqual(f.repository.localCatalog.asset(f.asset.id), f.asset);
  const root = await f.domain.localRelocation.relinkRoot(f.request), receipt = originalReceipt(f.request.commandId);
  assert.deepEqual(root, committed); assert.ok(receipt);
  await f.domain.localScan.privateWait(receipt.jobId);
  assert.equal(f.domain.localScan.get(receipt.jobId).phase, 'completed');
  assert.equal(f.domain.localScan.page({ offset: 0, limit: 200 }).total, 2);
  assert.deepEqual(await f.domain.localRelocation.relinkRoot(f.request), committed);
  assert.equal(f.domain.localScan.page({ offset: 0, limit: 200 }).total, 2); f.assertQuiet();
});
