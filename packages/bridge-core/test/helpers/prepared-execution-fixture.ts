import type test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RenderAssessment } from '@music-bridge/contracts';
import { recordingProfileContent } from './recording-profile-fixture.js';
import { executionFixture as setup } from './execution-fixture.js';
import { createPreparedCoordinator } from '../../src/recording/prepared-coordinator.js';
import { pcmWaveHeader } from '../../src/recording/execution-wave.js';

export async function preparedExecutionFixture(t: test.TestContext, options: Parameters<typeof setup>[1] = {}) {
  const f = await setup(t, options), profile = f.repository.recordingProfiles.save({ commandId: randomUUID(), content: recordingProfileContent(96000), userConfirmed: true });
  const session = f.repository.recordingProfiles.saveSession({ commandId: randomUUID(), draftId: f.draft.draftId, expectedRevision: 1, profileVersionId: profile.id, overrides: {}, userConfirmed: true });
  const workspaceProposal = await f.preparation.preview({ layoutVersionId: f.layout.id, destinationId: f.destination.id });
  const workspace = await f.preparation.start({ commandId: randomUUID(), layoutVersionId: f.layout.id, destinationId: f.destination.id, proposalFingerprint: workspaceProposal.proposalFingerprint, userConfirmed: true }); await f.preparation.idle();
  const preparationId = f.preparation.job(workspace.id).job!.workspaceId!, prepared = createPreparedCoordinator({ store: f.repository.prepared, preparationStore: f.repository.preparations, preparation: f.preparation, sourceStore: f.repository.sources }); t.after(() => prepared.close());
  const rawTarget = path.join(f.directory, '原始 Render 保留目录'); await mkdir(rawTarget); const rawDestination = await f.preparation.authorize(randomUUID(), rawTarget);
  const selections = [];
  for (const side of f.layout.timeline.sides.filter(s => s.totalFrames > 0)) {
    const file = path.join(f.directory, `合成Render-${side.name}.wav`), pcm = Buffer.alloc(side.totalFrames * 4); pcm.writeInt16LE(12345, 0); pcm.writeInt16LE(-12345, pcm.length - 2);
    await writeFile(file, Buffer.concat([pcmWaveHeader(96000, 2, 16, side.totalFrames), pcm]));
    selections.push(await prepared.select({ commandId: randomUUID(), preparationId, side: side.name }, file));
  }
  const importedSelection = { preparationId, destinationId: rawDestination.id, selectionIds: selections.map(s => s.id) }, importedProposal = await prepared.previewImport(importedSelection);
  const imported = await prepared.startImport({ ...importedSelection, commandId: randomUUID(), proposalFingerprint: importedProposal.proposalFingerprint, userConfirmed: true }); await prepared.idle();
  const done = prepared.job(imported.id).job!;
  const assessment: RenderAssessment = { structureChanged: false, acceptVariance: false, varianceReason: '', timeline: { timebase: 'sample-frames', sides: f.layout.timeline.sides.map(s => { const a = done.assets!.find(a => a.side === s.name); return { name: s.name, renderAssetId: a?.id ?? null, renderFileHash: a?.sha256 ?? null, sampleRate: 96000, channelLayout: a ? 'stereo' : 'none', totalFrames: s.totalFrames, markers: s.tracks.map(m => ({ trackId: m.trackId, exactSourceSha256: f.master.content.tracks.find(c => c.trackId === m.trackId)!.source.sha256, actualStartFrame: m.startFrame, actualEndFrame: m.endFrame, actualGapToNextFrames: m.gapAfterFrames, confirmationMethod: 'manual', userConfirmed: true })) }; }) } };
  const reviewRequest = { importJobId: done.id, assessment, daw: '合成 DAW', processingLineage: '合成 Render；未运行真实 Logic。' }, review = await prepared.review(reviewRequest), prep = await prepared.freeze({ ...reviewRequest, commandId: randomUUID(), proposalFingerprint: review.proposalFingerprint, userConfirmed: true });
  const selection = { ...f.selection, mode: 'prepared-reference' as const, preparedVersionId: prep.id, sessionRevision: session.revision };
  const request = async () => ({ ...selection, commandId: randomUUID(), proposalFingerprint: (await f.execution.preview({ ...selection, readId: randomUUID() })).proposalFingerprint, userConfirmed: true as const });
  return { ...f, rawDestination, rawTarget, imported: f.repository.prepared.job(imported.id)!, prep, request, selection };
}
