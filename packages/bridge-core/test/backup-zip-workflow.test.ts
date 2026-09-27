import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { isBackupOverview } from '@music-bridge/contracts';
import { createBackupCoordinator } from '../src/recording/backup-coordinator.js';
import { createBackupWorkflowStore } from '../src/recording/backup-workflow-store.js';
import { authorizeSourceDirectory } from '../src/recording/source-files.js';
import { archiveBackupFixture } from './helpers/archive-backup-fixture.js';

async function privateRoot(directory: string) {
  const absolute = path.join(directory, 'zip-private'); await mkdir(absolute);
  return { ...await authorizeSourceDirectory(absolute), id: randomUUID() };
}

test('ZIP 备份、文件重验、隔离恢复与旧目录任务共存，公开回执不暴露路径', async t => {
  const f = await archiveBackupFixture(t), store = createBackupWorkflowStore({ filePath: path.join(f.directory, 'zip-maintenance.sqlite') });
  const coordinator = createBackupCoordinator({ store, repository: f.repository, privateRoot: await privateRoot(f.directory) });
  t.after(() => coordinator.close());
  const destination = await coordinator.authorize({ commandId: randomUUID(), kind: 'backup-destination', absolutePath: f.destination.path });
  const request = { commandId: randomUUID(), kind: 'backup' as const, rootId: destination.id, mode: 'archive-content' as const, format: 'zip' as const, userConfirmed: true as const };
  const started = coordinator.start(request); await coordinator.idle();
  const backed = coordinator.overview().jobs.find(job => job.id === started.id)!;
  assert.equal(backed.state, 'succeeded'); assert.equal(backed.format, 'zip'); assert.ok(backed.resultRootId);
  const source = coordinator.overview().roots.find(root => root.id === backed.resultRootId)!;
  assert.equal(source.kind, 'backup-source'); assert.equal(source.format, 'zip');
  assert.deepEqual((await readdir(f.destination.path)).filter(name => name.endsWith('.zip')), [source.label]);
  const verified = coordinator.start({ commandId: randomUUID(), kind: 'verify', rootId: source.id, userConfirmed: true });
  await coordinator.idle();
  assert.equal(coordinator.overview().jobs.find(job => job.id === verified.id)?.state, 'succeeded');
  const restorePath = path.join(f.directory, 'zip-workflow-restore'); await mkdir(restorePath);
  const restoreDestination = await coordinator.authorize({ commandId: randomUUID(), kind: 'restore-destination', absolutePath: restorePath });
  const restored = coordinator.start({ commandId: randomUUID(), kind: 'restore', rootId: source.id, destinationId: restoreDestination.id, verificationId: verified.id, userConfirmed: true });
  await coordinator.idle();
  assert.equal(coordinator.overview().jobs.find(job => job.id === restored.id)?.state, 'succeeded');
  assert.equal(JSON.parse(await readFile(path.join(restorePath, restored.id, 'Restore.json'), 'utf8')).state, 'isolated-pending-activation');
  assert.equal(JSON.stringify(coordinator.overview()).includes(f.directory), false);
  const selected = await coordinator.authorize({ commandId: randomUUID(), kind: 'backup-source', format: 'zip', absolutePath: path.join(f.destination.path, source.label) });
  assert.equal(selected.format, 'zip');
  const selectedVerification = coordinator.start({ commandId: randomUUID(), kind: 'verify', rootId: selected.id, userConfirmed: true });
  await coordinator.idle();
  assert.equal(coordinator.overview().jobs.find(job => job.id === selectedVerification.id)?.state, 'succeeded');
  assert.throws(() => coordinator.start({ commandId: randomUUID(), kind: 'index', rootId: source.id, userConfirmed: true }));
});

test('缺少私有暂存根时 ZIP 校验公开报不可用，已成功备份回执仍可读', async t => {
  const f = await archiveBackupFixture(t), store = createBackupWorkflowStore({ filePath: path.join(f.directory, 'zip-unavailable.sqlite') });
  const coordinator = createBackupCoordinator({ store, repository: f.repository });
  t.after(() => coordinator.close());
  const destination = await coordinator.authorize({ commandId: randomUUID(), kind: 'backup-destination', absolutePath: f.destination.path });
  const backup = coordinator.start({ commandId: randomUUID(), kind: 'backup', rootId: destination.id, mode: 'metadata', format: 'zip', userConfirmed: true });
  await coordinator.idle();
  const backed = coordinator.overview().jobs.find(job => job.id === backup.id)!;
  assert.equal(backed.state, 'succeeded');
  const verification = coordinator.start({ commandId: randomUUID(), kind: 'verify', rootId: backed.resultRootId!, userConfirmed: true });
  await coordinator.idle();
  const overview = coordinator.overview();
  assert.equal(isBackupOverview(overview), true);
  assert.equal(overview.jobs.find(job => job.id === verification.id)?.state, 'failed');
  assert.equal(overview.jobs.find(job => job.id === verification.id)?.issue, 'BACKUP_UNAVAILABLE');
  assert.equal(overview.jobs.find(job => job.id === verification.id)?.summary, undefined);
  assert.equal(overview.jobs.find(job => job.id === backup.id)?.state, 'succeeded');
  assert.deepEqual(overview.jobs.find(job => job.id === backup.id)?.summary, backed.summary);
});

test('final 已发布而维护落账失败，冷启同命令仅核验并补成功回执，不重新写 ZIP', async t => {
  const f = await archiveBackupFixture(t), filePath = path.join(f.directory, 'zip-receipt-recovery.sqlite');
  const store = createBackupWorkflowStore({ filePath }), scratch = await privateRoot(f.directory);
  let failOnce = true;
  const interrupted = new Proxy(store, { get(target, key) {
    if (key === 'finish') return (...args: Parameters<typeof store.finish>) => {
      if (failOnce && target.job(args[0]).view.kind === 'backup') { failOnce = false; throw new Error('合成落账失败'); }
      return target.finish(...args);
    };
    const value: unknown = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const coordinator = createBackupCoordinator({ store: interrupted, repository: f.repository, privateRoot: scratch });
  const destination = await coordinator.authorize({ commandId: randomUUID(), kind: 'backup-destination', absolutePath: f.destination.path });
  const request = { commandId: randomUUID(), kind: 'backup' as const, rootId: destination.id, mode: 'metadata' as const, format: 'zip' as const, userConfirmed: true as const };
  const started = coordinator.start(request); await coordinator.idle();
  assert.equal(coordinator.overview().jobs.find(job => job.id === started.id)?.state, 'failed');
  const zipPath = path.join(f.destination.path, `MusicBridge-Backup-${started.id}.zip`), original = await readFile(zipPath);
  await coordinator.close();
  const coldStore = createBackupWorkflowStore({ filePath }), cold = createBackupCoordinator({ store: coldStore, repository: f.repository, privateRoot: scratch });
  t.after(() => cold.close());
  assert.equal(cold.start(request).id, started.id);
  await cold.idle();
  const settled = cold.overview().jobs.find(job => job.id === started.id)!;
  assert.equal(settled.state, 'succeeded'); assert.equal(settled.issue, undefined); assert.ok(settled.resultRootId);
  assert.deepEqual(await readFile(zipPath), original);
  assert.deepEqual((await readdir(f.destination.path)).filter(name => name.endsWith('.zip')), [path.basename(zipPath)]);
});
