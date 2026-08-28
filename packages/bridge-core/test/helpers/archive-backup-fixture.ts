import assert from 'node:assert/strict';
import type test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { executionFixture } from './execution-fixture.js';
import { preparedExecutionFixture } from './prepared-execution-fixture.js';
import { createArchiveCoordinator } from '../../src/recording/archive-coordinator.js';
import { authorizeSourceDirectory } from '../../src/recording/source-files.js';

export async function archiveBackupFixture(t: test.TestContext, prepared = false, options: { format?: 'cassette' | 'dat' } = {}) {
  const f = await (prepared ? preparedExecutionFixture(t) : executionFixture(t, options));
  const archive = createArchiveCoordinator({ store: f.repository.archive, executionStore: f.repository.execution, preparationStore: f.repository.preparations, sourceStore: f.repository.sources, sources: f.sources, preparation: f.preparation });
  t.after(() => archive.close());
  const parent = path.join(f.directory, '归档'), destinationPath = path.join(f.directory, '备份');
  await mkdir(parent); await mkdir(destinationPath);
  const root = await archive.authorize(randomUUID(), parent); await archive.initialize({ commandId: randomUUID(), id: root.id, userConfirmed: true });
  const job = await f.execution.start(await f.request()); await f.execution.idle();
  const selection = { rootId: root.id, assetId: job.id, sourcePolicy: 'preserve-exact-sources' as const };
  const preview = await archive.preview({ ...selection, readId: randomUUID() });
  const request = { ...selection, commandId: randomUUID(), proposalFingerprint: preview.proposalFingerprint, userConfirmed: true as const };
  await archive.start(request); await archive.idle();
  assert.equal(f.repository.archive.operation(request.commandId)?.phase, 'FINALIZED');
  const destination = { ...await authorizeSourceDirectory(destinationPath), id: randomUUID() };
  const module = await import('../../src/recording/backup-package.js').catch(() => ({}));
  assert.ok('createArchiveBackup' in module && 'verifyArchiveBackup' in module, '生产备份包边界尚未实现');
  const api = module as typeof import('../../src/recording/backup-package.js');
  const backupRequest = { repository: f.repository, destination, id: randomUUID(), mode: 'archive-content' as const, userConfirmed: true, signal: new AbortController().signal };
  return { ...f, api, archive, archiveRequest: request, root: f.repository.archive.root(root.id), destination, backupRequest };
}
