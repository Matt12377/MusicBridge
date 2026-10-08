import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import * as dto from '@music-bridge/contracts';
import { createCollectionRepository, type CollectionRepository } from '../../src/collection/repository.js';
import { prepareLocalSourceReadonly, type PreparedLocalSource } from '../../src/application/local-source-resolver.js';
import { SourceFileError } from '../../src/recording/source-files.js';
import { LocalFileSourcePool, type AssetLease } from '../../src/stream/local-file-source.js';
import { StreamRegistry } from '../../src/stream/registry.js';
import { StreamGateway } from '../../src/stream/gateway.js';
import { physicalResourceLocks } from '../../src/stream/physical-resource-locks.js';
import type { Logger } from '../../src/shared/logger.js';
import { sourceServiceFixture, hash } from './service-fixture.js';
import { sourceOwner } from './owner-fixture.js';

test('012 AT05 同次真实源写：旧URL与descriptor拒新版，新lease读取新revision完整bytes，undo恢复',
  { timeout: 120_000 }, async t => {
  const input = 'owned-stereo-fixed-tags.flac';
  const f = await sourceServiceFixture(t, { files: [input] });
  assert.equal(f.tracks.length, 1);
  const track = f.tracks[0]!;
  const file = path.join(f.media, input);
  const beforeAsset = f.repository.localCatalog.asset(track.assetId);
  const beforeBytes = await readFile(file);
  const beforeSha = hash(beforeBytes);
  const beforeStat = await lstat(file, { bigint: true });
  const original = f.preWriteSources.get(track.id);
  assert.ok(original?.file);
  assert.equal(original.sha256, beforeSha);
  assert.deepEqual(await readFile(original.file), beforeBytes);
  const physical = { dev: String(beforeStat.dev), ino: String(beforeStat.ino) };
  const target = { core_id: 'owned-core', zone_id: 'owned-zone' };
  const authority = { captureCurrentTarget: () => ({ target, isCurrent: () => true }) };

  function descriptor(repository: CollectionRepository, revision: string): PreparedLocalSource {
    const request: dto.LocalPlayRequest = {
      schema_version: '1.2', request_id: randomUUID(), route: 'roon_audio_input',
      source_kind: 'local_file', local_track_id: track.id, asset_id: beforeAsset.id,
      expected_asset_revision: revision, target, action: 'PLAY_NOW',
    };
    const value = prepareLocalSourceReadonly(request, repository, authority);
    if (value.status !== 'prepared_descriptor') assert.fail('生产catalog resolver未返回descriptor。');
    assert.ok(value.facts.observation);
    return value;
  }

  const oldDescriptor = descriptor(f.repository, beforeAsset.fileRevision);
  const capturedOld = structuredClone(oldDescriptor);
  await f.close();

  const o = sourceOwner(f, { sharedLocks: true });
  const pool = new LocalFileSourcePool();
  const registry = new StreamRegistry({ localSourcePool: pool });
  const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
  let remoteFetches = 0;
  const gateway = new StreamGateway({
    host: '127.0.0.1', port: 0, publicBaseUrl: 'http://127.0.0.1:0', registry, logger,
    fetcher: async () => { remoteFetches++; throw new Error('本例不允许远程fetch。'); },
  });
  const leaseAuthority = (attempt: number, ownerId = 'at05-current') =>
    ({ ownerId, attempt, isCurrent: () => true });

  async function http(url: string, status: number): Promise<Buffer> {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, status);
    return Buffer.from(await response.arrayBuffer());
  }

  function released(lease: AssetLease): void {
    assert.equal(lease.state, 'CLOSED');
    assert.deepEqual(lease.resourceSnapshot(), { activeRequests: 0, activeIo: 0, timer: 0 });
    assert.deepEqual(pool.resourceSnapshot(), { openLeases: 0, reservations: 0 });
    assert.equal(physicalResourceLocks.combinedSnapshot().resources, 0);
  }

  // 两次写之间只读当前真实数据库；不回填旧observation，也不先rescan。
  function current(revision: string): PreparedLocalSource {
    const repository = createCollectionRepository({ filePath: f.filePath });
    try {
      const detail = repository.localCatalog.trackDetail(track.id);
      assert.equal(detail.track.id, track.id);
      assert.equal(detail.asset.id, beforeAsset.id);
      assert.equal(detail.asset.fileRevision, revision);
      assert.equal(repository.localCatalog.pageTracks({ offset: 0, limit: 200 }).items.length, 1);
      const value = descriptor(repository, revision);
      assert.equal(value.facts.observation!.trackId, track.id);
      assert.equal(value.facts.observation!.assetId, beforeAsset.id);
      assert.equal(value.facts.observation!.fileRevision, revision);
      assert.equal(value.facts.relative, oldDescriptor.facts.relative);
      return value;
    } finally {
      repository.close();
    }
  }

  try {
    await o.boot();
    const policy = await o.request('localSourceWrites.setPolicy', {
      datasetId: f.datasetId, commandId: randomUUID(), expectedPolicyRevision: '1', enabled: true,
    });
    assert.equal(policy.outcome, 'accepted');
    await gateway.start();
    const baseUrl = gateway.localBaseUrl();
    const old = await registry.registerLocalSource(oldDescriptor, leaseAuthority(1), 'flac');
    old.lease.confirmSession({ attempt: 1, sessionId: 'at05-old', isConfirmed: () => true });
    const oldUrl = gateway.localStreamUrl(old.token);
    const streamedBefore = await http(oldUrl, 200);
    assert.deepEqual(streamedBefore, beforeBytes);
    assert.equal(hash(streamedBefore), beforeSha);
    assert.equal(old.lease.revisions.assetId, beforeAsset.id);
    assert.equal(old.lease.revisions.assetRevision, beforeAsset.fileRevision);
    assert.ok(physicalResourceLocks.inspect([physical]).readers > 0);
    await old.lease.close();
    released(old.lease);
    assert.equal(physicalResourceLocks.inspect([physical]).readers, 0);
    assert.equal(physicalResourceLocks.inspect([physical]).writers, 0);

    const preview = await o.request('localSourceWrites.preview', {
      datasetId: f.datasetId, commandId: randomUUID(), intent: {
        kind: 'tags', target: { mode: 'single', trackId: track.id },
        fields: { title: { action: 'set', value: 'AT05同次发布后新租约' } },
      },
    });
    assert.equal(preview.outcome, 'accepted');
    assert.ok(preview.planId);
    const ready = await o.waitPlan(preview.planId, p => p.state !== 'PREVIEWING');
    assert.equal(ready.state, 'READY', ready.issues.join(','));
    assert.equal(ready.items.length, 1);
    const confirmed = await o.confirm(ready);
    assert.equal(confirmed.accepted.outcome, 'accepted');
    const written = await o.waitPlan(ready.planId,
      p => ['COMPLETED', 'FAILED', 'RECOVERY_REQUIRED'].includes(p.state));
    assert.equal(written.state, 'COMPLETED', written.issues.join(','));
    assert.equal(written.items.length, 1);
    const operation = written.items[0]!;
    assert.equal(operation.operationId, ready.items[0]!.operationId);
    assert.equal(operation.trackId, track.id);
    assert.equal(operation.assetId, beforeAsset.id);
    assert.equal(operation.state, 'applied');
    const afterRevision = (BigInt(beforeAsset.fileRevision) + 1n).toString();
    assert.equal(operation.currentFileRevision, afterRevision);
    const afterBytes = await readFile(file);
    const afterSha = hash(afterBytes);
    assert.notEqual(afterSha, beforeSha);
    const backup = path.join(f.directory, 'source-writes', 'safety', operation.operationId, 'backup');
    const backupBytes = await readFile(backup);
    assert.deepEqual(backupBytes, beforeBytes);
    assert.equal(hash(backupBytes), beforeSha);

    // 首次旧URL检查在任何新注册之前；整个闭环保持同一个监听和原能力对象。
    assert.equal(gateway.localBaseUrl(), baseUrl);
    assert.deepEqual(await http(oldUrl, 404), Buffer.alloc(0));
    assert.deepEqual(oldDescriptor, capturedOld);
    let staleDescriptorCode: string | undefined;
    await assert.rejects(pool.prepare(oldDescriptor, leaseAuthority(1, 'at05-stale-descriptor')), error => {
      if (!(error instanceof SourceFileError)) return false;
      staleDescriptorCode = error.code;
      return error.code === 'CONTENT_CHANGED';
    });
    assert.equal(staleDescriptorCode, 'CONTENT_CHANGED');
    assert.deepEqual(pool.resourceSnapshot(), { openLeases: 0, reservations: 0 });
    assert.equal(physicalResourceLocks.combinedSnapshot().resources, 0);

    const next = await registry.registerLocalSource(current(afterRevision), leaseAuthority(2), 'flac');
    next.lease.confirmSession({ attempt: 2, sessionId: 'at05-new', isConfirmed: () => true });
    assert.equal(next.lease.revisions.assetId, beforeAsset.id);
    assert.equal(next.lease.revisions.assetRevision, afterRevision);
    assert.ok(next.token !== old.token, '新租约必须使用独立能力标识。');
    const nextUrl = gateway.localStreamUrl(next.token);
    const streamedAfter = await http(nextUrl, 200);
    assert.deepEqual(streamedAfter, afterBytes);
    assert.equal(hash(streamedAfter), afterSha);
    assert.notEqual(hash(streamedAfter), beforeSha);
    assert.deepEqual(await http(oldUrl, 404), Buffer.alloc(0));
    await next.lease.close();
    released(next.lease);

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
    const undoConfirmed = await o.confirm(inverse);
    assert.equal(undoConfirmed.accepted.outcome, 'accepted');
    const restored = await o.waitPlan(inverse.planId,
      p => ['COMPLETED', 'FAILED', 'RECOVERY_REQUIRED'].includes(p.state));
    assert.equal(restored.state, 'COMPLETED', restored.issues.join(','));
    assert.equal(restored.items.length, 1);
    const restoration = restored.items[0]!;
    assert.equal(restoration.trackId, track.id);
    assert.equal(restoration.assetId, beforeAsset.id);
    assert.equal(restoration.restoration?.kind, 'restore-audio-file');
    assert.equal(restoration.restoration?.originPlanId, written.planId);
    assert.equal(restoration.restoration?.originOperationId, operation.operationId);
    assert.equal(restoration.restoration?.expectedOutputSha256, beforeSha);
    const restoredBytes = await readFile(file);
    const restoredRevision = (BigInt(afterRevision) + 1n).toString();
    assert.deepEqual(restoredBytes, beforeBytes);
    assert.equal(hash(restoredBytes), beforeSha);
    assert.equal(restoration.currentFileRevision, restoredRevision);
    const final = await registry.registerLocalSource(current(restoredRevision), leaseAuthority(3), 'flac');
    final.lease.confirmSession({ attempt: 3, sessionId: 'at05-restored', isConfirmed: () => true });
    assert.equal(final.lease.revisions.assetId, beforeAsset.id);
    assert.equal(final.lease.revisions.assetRevision, restoredRevision);
    const streamedRestored = await http(gateway.localStreamUrl(final.token), 200);
    assert.deepEqual(streamedRestored, beforeBytes);
    assert.equal(hash(streamedRestored), beforeSha);
    assert.equal(gateway.localBaseUrl(), baseUrl);
    assert.deepEqual(await http(oldUrl, 404), Buffer.alloc(0));
    assert.deepEqual(await http(nextUrl, 404), Buffer.alloc(0));
    assert.equal(remoteFetches, 0);
    t.diagnostic(JSON.stringify({
      trackId: track.id, assetId: beforeAsset.id, planId: written.planId,
      operationId: operation.operationId, undoPlanId: restored.planId,
      revisions: [beforeAsset.fileRevision, afterRevision, restoredRevision],
      sha256: { before: beforeSha, after: afterSha, restored: hash(streamedRestored) },
      oldUrlAfterWrite: { status: 404, bytes: 0 }, staleDescriptorCode,
      newHttpMatchesPublishedFile: true, restoredHttpMatchesOriginalFile: true,
    }));
  } finally {
    try { await gateway.stop(); } finally { await o.close(); }
  }
  assert.deepEqual(pool.resourceSnapshot(), { openLeases: 0, reservations: 0 });
  assert.equal(physicalResourceLocks.combinedSnapshot().resources, 0);
});
