import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as dto from '@music-bridge/contracts';
import { createCollectionRepository, type CollectionRepository } from '../../src/collection/repository.js';
import { physicalResourceLocks } from '../../src/stream/physical-resource-locks.js';
import { sourceServiceFixture, hash } from './service-fixture.js';
import { sourceOwner } from './owner-fixture.js';

test('012 AT06 真实undo READY及Main grant后外部改写：执行拒绝，外部完整bytes与原backup保留，零逆向事实',
  { timeout: 180_000 }, async t => {
  const datasets = new Set<string>();
  const directories = new Set<string>();
  for (const window of ['ready-before-grant', 'grant-before-confirm'] as const) {
    const input = 'owned-stereo-fixed-tags.flac';
    const f = await sourceServiceFixture(t, { files: [input] });
    assert.ok(!datasets.has(f.datasetId) && !directories.has(f.directory), '两个窗口必须使用独立真实fixture。');
    datasets.add(f.datasetId);
    directories.add(f.directory);
    assert.equal(f.tracks.length, 1);
    const track = f.tracks[0]!;
    const beforeAsset = f.repository.localCatalog.asset(track.assetId);
    const file = path.join(f.media, input);
    const beforeBytes = await readFile(file);
    const beforeSha = hash(beforeBytes);
    const original = f.preWriteSources.get(track.id);
    assert.ok(original?.file);
    assert.equal(original.sha256, beforeSha);
    assert.deepEqual(await readFile(original.file), beforeBytes);
    await f.close();

    const o = sourceOwner(f, { sharedLocks: true });
    let ownerExitCode: number | undefined;
    o.worker.once('exit', code => { ownerExitCode = code; });
    const publishedTitle = 'AT06真实源写标题';
    const externalTitle = 'AT06外部改写标题';
    const publishedValue = Buffer.from(publishedTitle, 'utf8');
    const externalValue = Buffer.from(externalTitle, 'utf8');
    assert.equal(externalValue.length, publishedValue.length);

    function catalog(repository: CollectionRepository) {
      return {
        track: repository.localCatalog.track(track.id),
        asset: repository.localCatalog.asset(beforeAsset.id),
        detail: repository.localCatalog.trackDetail(track.id),
        locator: repository.localCatalog.privateAssetLocator(beforeAsset.id),
        currentScan: repository.localScan.privateCurrentFileState(f.root.id, input),
        sourceWriteScan: repository.localScan.privateSourceWriteFileState(f.root.id, input),
        tracks: repository.localCatalog.pageTracks({ offset: 0, limit: 200 }).items,
      };
    }

    function observeCatalog() {
      const repository = createCollectionRepository({ filePath: f.filePath });
      try { return catalog(repository); } finally { repository.close(); }
    }

    async function history(planId: string): Promise<dto.LocalSourceWritesHistoryEvent[]> {
      const result = await o.request('localSourceWrites.history', {
        datasetId: f.datasetId, selector: { kind: 'events', planId }, cursor: null, limit: 100,
      });
      assert.ok(result.kind === 'events');
      assert.equal(result.hasMore, false, '必须观察完整事件，不能以首页冒充无发布。');
      return result.items;
    }

    const backupIdentity = (info: BigIntStats): string =>
      [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.birthtimeNs, info.mode, info.uid, info.gid, info.nlink].join(':');

    try {
      await o.boot();
      const policy = await o.request('localSourceWrites.setPolicy', {
        datasetId: f.datasetId, commandId: randomUUID(), expectedPolicyRevision: '1', enabled: true,
      });
      assert.equal(policy.outcome, 'accepted');
      const preview = await o.request('localSourceWrites.preview', {
        datasetId: f.datasetId, commandId: randomUUID(), intent: {
          kind: 'tags', target: { mode: 'single', trackId: track.id },
          fields: { title: { action: 'set', value: publishedTitle } },
        },
      });
      assert.equal(preview.outcome, 'accepted');
      assert.ok(preview.planId);
      const ready = await o.waitPlan(preview.planId, p => p.state !== 'PREVIEWING');
      assert.equal(ready.state, 'READY', ready.issues.join(','));
      const forward = await o.confirm(ready);
      assert.equal(forward.accepted.outcome, 'accepted');
      const written = await o.waitPlan(ready.planId,
        p => ['COMPLETED', 'FAILED', 'RECOVERY_REQUIRED'].includes(p.state));
      assert.equal(written.state, 'COMPLETED', written.issues.join(','));
      assert.equal(written.items.length, 1);
      const operation = written.items[0]!;
      assert.equal(operation.state, 'applied');
      assert.equal(operation.trackId, track.id);
      assert.equal(operation.assetId, beforeAsset.id);
      const writtenRevision = (BigInt(beforeAsset.fileRevision) + 1n).toString();
      assert.equal(operation.currentFileRevision, writtenRevision);
      const publishedBytes = await readFile(file);
      const publishedSha = hash(publishedBytes);
      assert.notEqual(publishedSha, beforeSha);
      const backup = path.join(f.directory, 'source-writes', 'safety', operation.operationId, 'backup');
      const backupBytes = await readFile(backup);
      const backupStat = backupIdentity(await lstat(backup, { bigint: true }));
      assert.deepEqual(backupBytes, beforeBytes);
      assert.equal(hash(backupBytes), beforeSha);
      const publishedCatalog = observeCatalog();
      assert.equal(publishedCatalog.asset.fileRevision, writtenRevision);
      assert.equal(publishedCatalog.detail.metadata.raw.title, publishedTitle);
      const publishedHistory = await history(written.planId);
      assert.ok(publishedHistory.some(event => event.phase === 'FACTS_COMMITTED'));

      const undo = await o.request('localSourceWrites.undo', {
        datasetId: f.datasetId, commandId: randomUUID(), planId: written.planId,
        expectedViewRevision: written.viewRevision, operationIds: [operation.operationId],
        journalFingerprint: written.journalFingerprint,
      });
      assert.equal(undo.outcome, 'accepted');
      assert.ok(undo.planId);
      const inverse = await o.waitPlan(undo.planId, p => p.state !== 'PREVIEWING');
      assert.equal(inverse.state, 'READY', inverse.issues.join(','));
      assert.equal(inverse.undoOf, written.planId);
      assert.equal(inverse.items.length, 1);
      const inverseOperation = inverse.items[0]!;
      assert.equal(inverseOperation.restoration?.kind, 'restore-audio-file');
      assert.equal(inverseOperation.restoration?.originOperationId, operation.operationId);
      assert.equal(inverseOperation.restoration?.expectedOutputSha256, beforeSha);
      assert.ok(inverse.planHash && inverse.contextFingerprint);
      assert.equal(physicalResourceLocks.combinedSnapshot().resources, 0);
      assert.deepEqual(await readFile(file), publishedBytes);
      assert.deepEqual(observeCatalog(), publishedCatalog);

      // 等长替换真实写后TITLE值，保留有效UTF-8/FLAC布局；不制造解析错误代替冲突。
      const titleOffset = publishedBytes.indexOf(publishedValue);
      assert.ok(titleOffset >= 0);
      assert.equal(publishedBytes.indexOf(publishedValue, titleOffset + publishedValue.length), -1);
      const externalBytes = Buffer.from(publishedBytes);
      externalValue.copy(externalBytes, titleOffset);
      const externalSha = hash(externalBytes);
      assert.notEqual(externalSha, publishedSha);
      assert.notEqual(externalSha, beforeSha);
      async function modifyTarget(): Promise<void> {
        await writeFile(file, externalBytes);
        assert.deepEqual(await readFile(file), externalBytes);
        assert.equal(hash(await readFile(file)), externalSha);
        assert.deepEqual(await readFile(backup), backupBytes);
        assert.deepEqual(observeCatalog(), publishedCatalog);
        assert.deepEqual(await o.plan(inverse.planId), inverse);
      }

      const confirm: dto.ConfirmLocalSourceWrites = {
        datasetId: f.datasetId, commandId: randomUUID(), planId: inverse.planId,
        expectedViewRevision: inverse.viewRevision, scope: 'SOURCE_FILES', range: inverse.range,
        planHash: inverse.planHash, contextFingerprint: inverse.contextFingerprint,
      };
      let challenge: dto.LocalSourceWritesChallenge;
      if (window === 'ready-before-grant') {
        await modifyTarget();
        challenge = await o.main('localSourceWrites.challenge', { datasetId: f.datasetId, confirm });
      } else {
        challenge = await o.main('localSourceWrites.challenge', { datasetId: f.datasetId, confirm });
        await modifyTarget();
      }
      assert.equal(challenge.commandId, confirm.commandId);
      assert.equal(challenge.planId, inverse.planId);
      assert.equal(challenge.expectedViewRevision, inverse.viewRevision);
      assert.equal(challenge.planHash, inverse.planHash);
      assert.equal(challenge.contextFingerprint, inverse.contextFingerprint);
      assert.ok(challenge.grant.challengeId !== forward.challenge.grant.challengeId, '逆向必须取得新的具体Main grant。');

      // checkedConfirm核目录事实；实际拒绝在executionTargets全文件观察比较，先于publisher。
      const accepted = await o.main('localSourceWrites.executeGranted', {
        datasetId: f.datasetId, confirm, grant: challenge.grant,
      });
      assert.equal(accepted.outcome, 'accepted');
      assert.equal(accepted.issue, null);
      const conflict = await o.waitPlan(inverse.planId,
        p => ['COMPLETED', 'PARTIAL', 'FAILED', 'BLOCKED', 'RECOVERY_REQUIRED', 'CANCELLED'].includes(p.state));
      assert.equal(conflict.state, 'FAILED', conflict.issues.join(','));
      assert.deepEqual(conflict.issues, ['SOURCE_CHANGED']);
      assert.deepEqual(conflict.items, inverse.items);
      assert.equal(conflict.items[0]!.currentFileRevision, writtenRevision);
      assert.deepEqual(await readFile(file), externalBytes);
      assert.equal(hash(await readFile(file)), externalSha);
      assert.deepEqual(await readFile(backup), backupBytes);
      assert.equal(hash(await readFile(backup)), beforeSha);
      assert.equal(backupIdentity(await lstat(backup, { bigint: true })), backupStat);
      assert.deepEqual(observeCatalog(), publishedCatalog);
      assert.deepEqual(await o.plan(written.planId), written);
      assert.deepEqual(await history(written.planId), publishedHistory);
      const inverseHistory = await history(inverse.planId);
      assert.ok(inverseHistory.some(event => event.issue === 'SOURCE_CHANGED'));
      assert.equal(inverseHistory.some(event => event.operationId !== null), false,
        '逆向不能出现BACKUP/捕获/发布/FACTS_COMMITTED操作事件。');
      await assert.rejects(lstat(path.join(f.directory, 'source-writes', 'safety', inverseOperation.operationId)),
        { code: 'ENOENT' });
      assert.equal(physicalResourceLocks.combinedSnapshot().resources, 0);

      // 自然关闭真实Owner后重开同一SQLite，核拒绝持久且没有新增源发布事实。
      await o.close();
      assert.equal(o.worker.threadId, -1);
      assert.equal(ownerExitCode, 0);
      const cold = createCollectionRepository({ filePath: f.filePath });
      try {
        assert.deepEqual(catalog(cold), publishedCatalog);
        cold.localCatalog.privateSourceWritesRead(view => {
          const retained = view.projection.plans.get(inverse.planId);
          assert.ok(retained);
          assert.deepEqual(retained.plan, conflict);
          assert.equal(retained.events.some(event => ['phase', 'facts', 'directory-facts'].includes(event.kind)), false);
          assert.equal(view.projection.events.filter(event => event.kind === 'facts').length, 1);
        });
      } finally {
        cold.close();
      }
      assert.deepEqual(await readFile(file), externalBytes);
      assert.equal(hash(await readFile(file)), externalSha);
      assert.deepEqual(await readFile(backup), backupBytes);
      assert.equal(backupIdentity(await lstat(backup, { bigint: true })), backupStat);
      t.diagnostic(JSON.stringify({
        window, datasetId: f.datasetId, originalPlanId: written.planId,
        originalOperationId: operation.operationId, inversePlanId: inverse.planId,
        inverseOperationId: inverseOperation.operationId,
        receiptOutcome: accepted.outcome, conflictState: conflict.state, conflictIssues: conflict.issues,
        fileRevision: writtenRevision, sha256: { before: beforeSha, published: publishedSha, external: externalSha, backup: hash(backupBytes) },
        externalFullBytesPreserved: true, originalBackupPreserved: true,
        inversePublicationEvents: 0, newCatalogFacts: 0, ownerExitCode,
      }));
    } finally {
      await o.close();
    }
    assert.equal(physicalResourceLocks.combinedSnapshot().resources, 0);
  }
  assert.equal(datasets.size, 2);
  assert.equal(directories.size, 2);
});
