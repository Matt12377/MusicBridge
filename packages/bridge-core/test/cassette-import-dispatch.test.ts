import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createCollectionRepository } from '../src/collection/repository.js';
import { dispatchDatasetCommand, type DatasetDispatchTarget } from '../src/collection/dataset-dispatch.js';

test('档案预览与确认均拒绝预览后切换资料库，不读旧档案或写新库', async t => {
  const repository = createCollectionRepository({ filePath: ':memory:', stagingRoot: '/Volumes/LifeWeave/Developer/CommandLine/tmp' });
  t.after(() => repository.close());
  const expectedDatasetId = randomUUID(), currentDatasetId = randomUUID();
  const runtime = { collection: repository, commandOutbox: { context: () => ({ datasetId: currentDatasetId }) } } as DatasetDispatchTarget;
  for (const command of ['referenceCatalog.previewArchive', 'referenceCatalog.importArchive'] as const) {
    const payload = { archiveSha256: 'a'.repeat(64), expectedDatasetId, expectedCurrentRevisionId: null,
      ...(command === 'referenceCatalog.importArchive' ? { commandId: randomUUID(), baselineFingerprint: 'b'.repeat(64), userConfirmed: true as const } : {}) };
    await assert.rejects(dispatchDatasetCommand(runtime, { version: 1, id: randomUUID(), command, payload }), /资料库已切换/u);
  }
  assert.equal(repository.list({ offset: 0, limit: 100 }).total, 0);
  assert.equal(repository.catalog.sources({ offset: 0, limit: 25 }).total, 0);
});
