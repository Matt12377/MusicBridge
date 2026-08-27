import assert from 'node:assert/strict';
import type test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSourceEvidenceService } from '../../src/recording/source-evidence.js';
import { createMediaPlanningCoordinator } from '../../src/recording/media-coordinator.js';
import { probeReadonlySource } from '../../src/recording/source-files.js';
import { mediaFingerprint } from '../../src/recording/media-store.js';
import { isVersionProposal, isVersionHistory, type MediaLayoutSpec } from '@music-bridge/contracts';
const page = { offset: 0, limit: 20 };
const spec: MediaLayoutSpec = { format: 'cassette', splitAfter: 2, leadInMs: 1000, tailMs: 1000, defaultGapMs: 5000, rules: [], compatibility: { confirmed: true, cassetteTypes: ['II'], dat: true } };
function audio() {
  const b = Buffer.alloc(44 + 44101 * 4); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(44100, 24); b.writeUInt32LE(176400, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(b.length - 44, 40); return b;
}
export async function preparationFixture(t: test.TestContext, options: { probe?: typeof probeReadonlySource; beforeCommit?: (action: string) => void } = {}) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'musicbridge-version-'))), sourcePath = path.join(directory, 'private-source');
  await mkdir(sourcePath); const file = path.join(sourcePath, 'fixture.wav'); await writeFile(file, audio());
  const filePath = path.join(directory, 'collection.sqlite');
  const repository = createCollectionRepository({ filePath, ...(options.beforeCommit ? { beforeCommit: options.beforeCommit } : {}) });
  const sources = createSourceEvidenceService({ store: repository.sources, drafts: repository.drafts });
  const draft = repository.drafts.append({ commandId: randomUUID(), fingerprint: 'b'.repeat(64), title: '版本合成草稿', programType: 'compilation', metadata: [1,2,3].map(i => ({ title: `合成曲目 ${i}` })) });
  const root = await sources.authorize(randomUUID(), sourcePath);
  for (const trackId of draft.trackIds) {
    const job = sources.start({ commandId: randomUUID(), draftId: draft.draftId, trackId, rootId: root.id, acquisition: 'userFileBind' }, file);
    await sources.idle(); assert.equal(sources.job(job.id).job?.state, 'completed');
    const binding = repository.sources.linked(draft.draftId, trackId)!;
    await sources.confirm({ commandId: randomUUID(), id: binding.id, draftId: draft.draftId, trackId, userConfirmed: true });
  }
  repository.receive({ commandId: randomUUID(), model: { brand: 'TDK', name: 'SA', edition: '合成', year: 1990, format: 'cassette', tapeType: 'II', identification: 'verified' }, lengthMinutes: 60, quantities: { openedBlank: 3, sealedBlank: 0, legacyUsed: 0, unclassified: 0 } });
  const media = createMediaPlanningCoordinator({ store: repository.media, drafts: repository.drafts, sources });
  const preview = await media.preview({ draftId: draft.draftId, spec, page });
  const saved = await media.save({ commandId: randomUUID(), draftId: draft.draftId, expectedDraftRevision: preview.draftRevision, inputFingerprint: preview.inputFingerprint, spec });
  const plan = await media.reserve({ commandId: randomUUID(), planId: saved.id, expectedRevision: saved.revision, skuId: preview.candidates.items[0]!.skuId, packaging: 'opened', userConfirmed: true });
  const { createMasterVersionsCoordinator } = await import('../../src/recording/versions-coordinator.js');
  const versions = createMasterVersionsCoordinator({ store: repository.versions, mediaStore: repository.media, media, drafts: repository.drafts, sourceStore: repository.sources, sources, ...(options.probe ? { probe: options.probe } : {}) });
  t.after(async () => { await versions.close(); await sources.close(); repository.close(); await rm(directory, { recursive: true, force: true }); });
  const proposal = () => versions.preview({ planId: plan.id, sampleRate: 96000 });
  const freeze = async () => { const p = await proposal(); return versions.freeze({ commandId: randomUUID(), planId: plan.id, sampleRate: 96000, proposalFingerprint: p.proposalFingerprint, userConfirmed: true }); };
  return { repository, sources, media, versions, draft, plan, proposal, freeze, directory, sourcePath, file, filePath, root };
}
