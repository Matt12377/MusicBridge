import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MediaLayoutSpec, RawRenderAsset, RenderAssessment } from '@music-bridge/contracts';
import { executionFixture } from './helpers/execution-fixture.js';
import { assessRender } from '../src/recording/render-conformance.js';
import { planDirectExecution, ExecutionCompileError } from '../src/recording/execution-plan.js';
import { previewArchiveRoot } from '../src/recording/archive-files.js';
import { createArchiveCoordinator } from '../src/recording/archive-coordinator.js';
import { captureArchiveInput } from '../src/recording/archive-input.js';

test('分盘 Logic/Direct/精确源归档只消费本盘，完整 Master 身份保留且异盘失效不阻断', async t => {
  const f = await executionFixture(t), groupId = randomUUID(), assigned = f.draft.trackIds.slice(0, 2);
  const spec: MediaLayoutSpec = { format: 'cassette', splitAfter: 1, leadInMs: 1000, tailMs: 1000,
    defaultGapMs: 5000, rules: [], compatibility: { confirmed: true, cassetteTypes: ['II'], dat: true },
    distribution: { schemaVersion: 1, groupId, segmentIndex: 0,
      segmentSpecs: [{ trackIds: assigned }, { trackIds: f.draft.trackIds.slice(2) }] } };
  const preview = await f.media.preview({ draftId: f.draft.draftId, spec, page: { offset: 0, limit: 20 } });
  const saved = await f.media.save({ commandId: randomUUID(), draftId: f.draft.draftId,
    expectedDraftRevision: preview.draftRevision, inputFingerprint: preview.inputFingerprint, spec });
  const plan = await f.media.reserve({ commandId: randomUUID(), planId: saved.id, expectedRevision: saved.revision,
    skuId: preview.candidates.items[0]!.skuId, packaging: 'opened', userConfirmed: true });
  const proposal = await f.versions.preview({ planId: plan.id, sampleRate: 96000 });
  const versionJob = await f.versions.freeze({ commandId: randomUUID(), planId: plan.id, sampleRate: 96000,
    proposalFingerprint: proposal.proposalFingerprint, userConfirmed: true });
  await f.versions.idle();
  const { master, layout } = f.repository.preparations.frozen(f.versions.job(versionJob.id).job!.layoutVersionId!);
  assert.equal(master.content.tracks.length, 3);
  assert.deepEqual(layout.timeline.sides.flatMap(side => side.tracks.map(track => track.trackId)), assigned);

  const assets: RawRenderAsset[] = layout.timeline.sides.map(side => ({ id: randomUUID(), side: side.name,
    sha256: 'a'.repeat(64), size: 100, format: 'wav', sampleRate: 96000, channelLayout: 'stereo',
    totalFrames: side.totalFrames, createdAt: new Date().toISOString(), creationTimeEvidence: 'first-observed' }));
  const assessment: RenderAssessment = { structureChanged: false, acceptVariance: false, varianceReason: '',
    timeline: { timebase: 'sample-frames', sides: layout.timeline.sides.map((side, index) => ({ name: side.name,
      renderAssetId: assets[index]!.id, renderFileHash: assets[index]!.sha256, sampleRate: 96000,
      channelLayout: 'stereo', totalFrames: side.totalFrames, markers: side.tracks.map(track => ({
        trackId: track.trackId, exactSourceSha256: master.content.tracks.find(item => item.trackId === track.trackId)!.source.sha256,
        actualStartFrame: track.startFrame, actualEndFrame: track.endFrame, actualGapToNextFrames: track.gapAfterFrames,
        confirmationMethod: 'manual', userConfirmed: true })) })) } };
  assert.equal(assessRender(master, layout, assets, assessment).status, 'MATCHED');
  const wrongMarkers = structuredClone(assessment);
  wrongMarkers.timeline.sides[1]!.markers[0]!.trackId = f.draft.trackIds[2]!;
  assert.equal(assessRender(master, layout, assets, wrongMarkers).status, 'REQUIRES_NEW_MASTER');

  const forged = structuredClone(layout); forged.distribution!.distributionHash = '0'.repeat(64);
  assert.equal(assessRender(master, forged, assets, assessment).status, 'REJECTED');
  assert.throws(() => planDirectExecution(master, forged,
    { ...f.profile.content.executionFormat, outputProfileVersion: f.profile.id }),
    error => error instanceof ExecutionCompileError && error.code === 'VERSION_MISMATCH');

  // 只让另一盘的当前绑定失效；本盘两首仍保持可用，不能因此要求复制或归档全 Master。
  const offDisk = f.repository.sources.linked(f.draft.draftId, f.draft.trackIds[2]!)!;
  const db = new DatabaseSync(f.filePath);
  try { db.prepare('UPDATE source_bindings SET data=? WHERE id=?').run(JSON.stringify({ ...offDisk, invalidated: true }), offDisk.id); }
  finally { db.close(); }
  const selection = { ...f.selection, layoutVersionId: layout.id };
  const direct = await f.execution.preview({ ...selection, readId: randomUUID() });
  assert.deepEqual(direct.recipes.flatMap(recipe => recipe.segments.filter(segment => segment.kind === 'source').map(segment => segment.trackId)), assigned);
  const execution = await f.execution.start({ ...selection, commandId: randomUUID(),
    proposalFingerprint: direct.proposalFingerprint, userConfirmed: true });
  await f.execution.idle();
  assert.equal(f.execution.job(execution.id).job!.state, 'completed');
  assert.deepEqual(f.repository.execution.job(execution.id)!.input.sources.map(source => source.trackId), assigned);

  const parentPath = path.join(f.directory, '本盘精确源归档'); await mkdir(parentPath);
  const parent = await previewArchiveRoot(parentPath, f.repository.sources.roots());
  const archive = createArchiveCoordinator({ store: f.repository.archive, executionStore: f.repository.execution,
    preparationStore: f.repository.preparations, sourceStore: f.repository.sources, sources: f.sources,
    preparation: f.preparation });
  try {
    const candidate = await archive.authorize(randomUUID(), parent.path);
    await archive.initialize({ commandId: randomUUID(), id: candidate.id, userConfirmed: true });
    const picked = { rootId: candidate.id, assetId: execution.id, sourcePolicy: 'preserve-exact-sources' as const };
    const captured = captureArchiveInput(picked, f.repository.archive.root(candidate.id), f.repository.execution, f.repository.sources);
    assert.deepEqual(captured.files.filter(file => file.role === 'exact-source').map(file => file.name.split('.')[0]), assigned);
    const metadata = captured.files.find(file => file.role === 'metadata')!;
    assert.ok('content' in metadata);
    assert.equal(JSON.parse(metadata.content).master.content.tracks.length, 3);
    const archiveProposal = await archive.preview({ ...picked, readId: randomUUID() });
    assert.equal(archiveProposal.files.filter(file => file.role === 'exact-source').length, 2);
    const archived = await archive.start({ ...picked, commandId: randomUUID(),
      proposalFingerprint: archiveProposal.proposalFingerprint, userConfirmed: true });
    await archive.idle();
    assert.equal(archive.operation(archived.id).operation!.phase, 'FINALIZED');
  } finally { await archive.close(); }
});
