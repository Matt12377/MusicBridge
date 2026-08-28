import assert from 'node:assert/strict';
import type test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { preparationFixture } from './preparation-fixture.js';
import { recordingProfileContent } from './recording-profile-fixture.js';
import { createPreparationCoordinator } from '../../src/recording/preparation-coordinator.js';
import { compileExecutionFile } from '../../src/recording/preparation-files.js';
import type { FfmpegConverter } from '../../src/recording/audio-converter.js';

type Hooks = { compile?: typeof compileExecutionFile; afterPublish?: () => Promise<void>; operationTimeoutMs?: number; converter?: FfmpegConverter };
export async function executionFixture(t: test.TestContext, options: Hooks & { beforeCommit?: (action: string) => void; emptyB?: boolean; format?: 'cassette' | 'dat' } = {}) {
  const f = await preparationFixture(t, options), v = await f.freeze(); await f.versions.idle();
  assert.ok('execution' in f.repository, '缺少持久化执行资产仓库');
  const { createExecutionCoordinator } = await import('../../src/recording/execution-coordinator.js');
  const frozen = f.repository.preparations.frozen(f.versions.job(v.id).job!.layoutVersionId!);
  const preparation = createPreparationCoordinator({ store: f.repository.preparations, sourceStore: f.repository.sources, sources: f.sources });
  const target = path.join(f.directory, '执行文件'); await mkdir(target); const destination = await preparation.authorize(randomUUID(), target);
  const profile = f.repository.recordingProfiles.save({ commandId: randomUUID(), content: recordingProfileContent(), userConfirmed: true });
  const session = f.repository.recordingProfiles.saveSession({ commandId: randomUUID(), draftId: f.draft.draftId, expectedRevision: 0, profileVersionId: profile.id, overrides: { recordLevel: '本次人工电平' }, userConfirmed: true });
  const make = (repository = f.repository, hooks: Hooks = options) => createExecutionCoordinator({ store: repository.execution, profiles: repository.recordingProfiles, preparationStore: repository.preparations, preparedStore: repository.prepared, mediaStore: repository.media, sourceStore: repository.sources, sources: f.sources, preparation, ...hooks });
  const execution = make(); t.after(async () => { await execution.close(); await preparation.close(); });
  const selection = { layoutVersionId: frozen.layout.id, destinationId: destination.id, mode: 'direct' as const, sessionRevision: session.revision };
  const preview = () => execution.preview({ ...selection, readId: randomUUID() });
  const request = async () => ({ ...selection, commandId: randomUUID(), proposalFingerprint: (await preview()).proposalFingerprint, userConfirmed: true as const });
  return { ...f, ...frozen, profile, session, preparation, target, destination, execution, make, selection, preview, request };
}
