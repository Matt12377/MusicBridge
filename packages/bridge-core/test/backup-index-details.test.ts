import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isBackupJobView } from '@music-bridge/contracts';
import { archiveBackupFixture } from './helpers/archive-backup-fixture.js';
import { createBackupWorkflowStore } from '../src/recording/backup-workflow-store.js';
import { createBackupCoordinator } from '../src/recording/backup-coordinator.js';

async function fixture(t: test.TestContext) {
  const f = await archiveBackupFixture(t), backup = await f.api.createArchiveBackup(f.backupRequest);
  const store = createBackupWorkflowStore({ filePath: path.join(f.directory, 'maintenance.sqlite') });
  const coordinator = createBackupCoordinator({ store, repository: f.repository });
  t.after(() => coordinator.close());
  const root = await coordinator.authorize({ commandId: randomUUID(), kind: 'backup-source', absolutePath: backup.directory.path });
  const run = async () => {
    const job = coordinator.start({ commandId: randomUUID(), kind: 'index', rootId: root.id, userConfirmed: true });
    await coordinator.idle();
    const completed = coordinator.overview().jobs.find(value => value.id === job.id)!;
    assert.equal(completed.state, 'succeeded');
    assert.equal(isBackupJobView(completed), true);
    return completed;
  };
  return { ...f, backup, coordinator, run };
}

for (const fault of ['missing', 'changed'] as const) {
  test(`索引协调器公开 ${fault} 对象的安全问题标识，同时保留未知历史与库存`, async t => {
    const f = await fixture(t), object = f.backup.manifest.objects[0]!;
    const absolute = path.join(f.backup.directory.path, 'objects', object.sha256);
    if (fault === 'missing') await rm(absolute); else await writeFile(absolute, '合成损坏');
    const before = await readdir(f.backup.directory.path), completed = await f.run();
    assert.ok(Array.isArray(completed.index?.issueDetails), '索引协调器尚未返回问题明细');
    const index = completed.index!;
    assert.deepEqual(index.issueDetails, [{ code: fault === 'missing' ? 'OBJECT_MISSING' : 'OBJECT_INVALID', operationId: f.archiveRequest.commandId, sha256: object.sha256 }]);
    assert.equal(index.operationCount, 1); assert.equal(index.quarantinedCount, 1); assert.equal(index.issueCount, 1); assert.equal(index.issueDetailsOmittedCount, 0);
    assert.equal(index.historyTrusted, false); assert.equal(index.inventoryReconstructed, false);
    assert.deepEqual(index.missingFacts, ['physical-recording-completion', 'inventory-and-ledger', 'frozen-version-records', 'profile-snapshots-and-user-confirmations', 'directory-authorizations']);
    assert.equal(JSON.stringify(completed).includes(f.directory), false);
    assert.deepEqual(await readdir(f.backup.directory.path), before);
    if (fault === 'changed') assert.equal(await readFile(absolute, 'utf8'), '合成损坏');
  });
}

test('大量无效清单仅公开前100条问题并保留总数，非法文件名不会进入明细', async t => {
  const f = await fixture(t), manifests = path.join(f.backup.directory.path, 'manifests');
  for (let index = 0; index < 103; ++index) await writeFile(path.join(manifests, `${randomUUID()}.json`), '{}');
  await writeFile(path.join(manifests, '私有文件名不能回传.txt'), '{}');
  const completed = await f.run();
  assert.ok(Array.isArray(completed.index?.issueDetails), '索引协调器尚未返回有界问题明细');
  const index = completed.index!;
  assert.equal(index.issueCount, 104); assert.equal(index.issueDetails.length, 100); assert.equal(index.issueDetailsOmittedCount, 4);
  assert.equal(index.quarantinedCount, 0); assert.equal(index.operationCount, 1);
  assert.ok(index.issueDetails.every(issue => issue.code === 'MANIFEST_INVALID'));
  assert.equal(JSON.stringify(completed).includes('私有文件名'), false);
  assert.equal(JSON.stringify(completed).includes(f.directory), false);
});
