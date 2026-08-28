import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readdir, rm, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { authorizeSourceDirectory, copyReadonlySource } from '../src/recording/source-files.js';
import { prepareRestoredDataset } from '../src/recording/restore-activation-files.js';

test('文件完成标记与当前清单字节不一致时不登记成功备份回执', async t => {
  const f = await setup(t), { createCollectionRepository } = await import('../src/collection/repository.js');
  const { createBackupCoordinator } = await import('../src/recording/backup-coordinator.js');
  const { createArchiveBackup } = await import('../src/recording/backup-package.js');
  const repository = createCollectionRepository({ filePath: ':memory:' });
  const coordinator = createBackupCoordinator({ store: f.store, repository, createBackup: async options => {
    const result = await createArchiveBackup(options);
    const manifest = path.join(result.directory.path, 'Backup.json');
    await writeFile(manifest, await readFile(manifest, 'utf8') + '\n');
    return result;
  } });
  try {
    const root = await coordinator.authorize({ commandId: randomUUID(), kind: 'backup-destination', absolutePath: f.root.path });
    const job = coordinator.start({ commandId: randomUUID(), kind: 'backup', rootId: root.id, mode: 'metadata', userConfirmed: true });
    await coordinator.idle();
    assert.equal(coordinator.overview().jobs.find(value => value.id === job.id)?.state, 'failed');
    assert.equal(coordinator.overview().roots.filter(value => value.kind === 'backup-source').length, 0);
  } finally { await coordinator.close(); repository.close(); }
});

async function setup(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-backup-workflow-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const api = await import('../src/recording/backup-workflow-store.js').catch(() => ({}));
  assert.ok('createBackupWorkflowStore' in api, '缺少独立持久备份工作流仓库');
  const create = (api as typeof import('../src/recording/backup-workflow-store.js')).createBackupWorkflowStore;
  const filePath = path.join(directory, 'maintenance.sqlite'), store = create({ filePath }); t.after(() => store.close());
  const target = path.join(directory, '备份目录'); await mkdir(target); const root = { ...await authorizeSourceDirectory(target), id: randomUUID() };
  return { create, directory, filePath, store, root };
}

test('备份维护仓库初始为空，目录候选可持久化但不写入所选目录', async t => {
  const f = await setup(t);
  assert.deepEqual(f.store.overview(), { roots: [], jobs: [], activations: [] });
  const command = { commandId: randomUUID(), kind: 'backup-destination' as const }, chosen = f.store.authorize(command, f.root);
  assert.equal(chosen.id, f.root.id); assert.equal(chosen.kind, 'backup-destination');
  assert.equal(JSON.stringify(chosen).includes(f.root.path), false);
  assert.deepEqual(await readdir(f.root.path), []);
  f.store.close(); const cold = f.create({ filePath: f.filePath });
  try { assert.deepEqual(cold.overview().roots, [chosen]); assert.deepEqual(cold.authorizationReceipt(command.commandId), chosen); }
  finally { cold.close(); }
});

test('目录命令重试幂等，原命令不能授权另一路径或用途', async t => {
  const f = await setup(t), command = { commandId: randomUUID(), kind: 'backup-destination' as const };
  const result = f.store.authorize(command, f.root);
  assert.deepEqual(f.store.authorize(command, f.root), result);
  assert.throws(() => f.store.authorize({ ...command, kind: 'backup-source' }, f.root));
  assert.throws(() => f.store.authorize(command, { ...f.root, path: path.join(f.directory, '另一目录') }));
  assert.equal(f.store.overview().roots.length, 1);
});


test('维护仓库拒绝既有非库文件和符号链接，不覆盖原始内容', async t => {
  const f = await setup(t), original = path.join(f.directory, '不可更改');
  await writeFile(original, '用户原始内容');
  const link = path.join(f.directory, '维护库链接'); await symlink(original, link);
  for (const filePath of [original, link]) {
    assert.throws(() => { const store = f.create({ filePath }); try { store.overview(); } finally { store.close(); } });
    assert.equal(await readFile(original, 'utf8'), '用户原始内容');
  }
});

test('备份任务先保存确认请求，重试不重复排队，冷启动不自动续写', async t => {
  const f = await setup(t), root = f.store.authorize({ commandId: randomUUID(), kind: 'backup-destination' }, f.root);
  assert.equal(typeof f.store.startJob, 'function', '尚无持久确认任务');
  const request = { commandId: randomUUID(), kind: 'backup' as const, rootId: root.id, mode: 'metadata' as const, userConfirmed: true as const };
  assert.throws(() => f.store.startJob({ ...request, userConfirmed: false } as never));
  const job = f.store.startJob(request); assert.equal(job.state, 'queued');
  assert.equal(f.store.startJob(request).id, job.id);
  assert.throws(() => f.store.startJob({ ...request, mode: 'archive-content' }));
  f.store.markRunning(job.id); f.store.close();
  const cold = f.create({ filePath: f.filePath });
  try {
    cold.recoverInterrupted();
    assert.equal(cold.overview().jobs[0]?.state, 'interrupted');
    assert.equal(cold.startJob(request).state, 'interrupted');
    assert.deepEqual(await readdir(f.root.path), []);
  } finally { cold.close(); }
});

test('后台实际备份、复核和隔离恢复使用明确确认，回执不会暴露私有路径', async t => {
  const f = await setup(t), fixture = await import('./helpers/archive-backup-fixture.js');
  const original = await fixture.archiveBackupFixture(t);
  const api = await import('../src/recording/backup-coordinator.js').catch(() => ({}));
  assert.ok('createBackupCoordinator' in api, '尚无后台备份协调器');
  const coordinator = (api as typeof import('../src/recording/backup-coordinator.js')).createBackupCoordinator({ store: f.store, repository: original.repository });
  t.after(() => coordinator.close());
  const root = await coordinator.authorize({ commandId: randomUUID(), kind: 'backup-destination', absolutePath: f.root.path });
  assert.deepEqual(await readdir(f.root.path), []);
  const request = { commandId: randomUUID(), kind: 'backup' as const, rootId: root.id, mode: 'archive-content' as const, userConfirmed: true as const };
  const job = coordinator.start(request); await coordinator.idle();
  const completed = coordinator.overview().jobs.find(j => j.id === job.id)!;
  assert.equal(completed.state, 'succeeded'); assert.ok(completed.resultRootId); assert.ok(completed.summary!.objectCount > 0);
  assert.equal(coordinator.start(request).id, job.id); await coordinator.idle(); assert.equal((await readdir(f.root.path)).length, 1);
  const verification = coordinator.start({ commandId: randomUUID(), kind: 'verify', rootId: completed.resultRootId!, userConfirmed: true });
  await coordinator.idle(); assert.equal(coordinator.overview().jobs.find(j => j.id === verification.id)?.state, 'succeeded');
  const target = path.join(f.directory, '隔离恢复'); await mkdir(target);
  const restoreRoot = await coordinator.authorize({ commandId: randomUUID(), kind: 'restore-destination', absolutePath: target });
  const restoring = coordinator.start({ commandId: randomUUID(), kind: 'restore', rootId: completed.resultRootId!, destinationId: restoreRoot.id, verificationId: verification.id, userConfirmed: true });
  await coordinator.idle();
  assert.equal(coordinator.overview().jobs.find(j => j.id === restoring.id)?.state, 'succeeded');
  const restored = JSON.parse(await readFile(path.join(target, restoring.id, 'Restore.json'), 'utf8'));
  assert.equal(restored.state, 'isolated-pending-activation');
  assert.equal(JSON.stringify(coordinator.overview()).includes(f.directory), false);
  await coordinator.close();
});


test('运行中的取消等待发布边界，已发布结果不被迟到取消覆盖', async t => {
  const f = await setup(t), root = f.store.authorize({ commandId: randomUUID(), kind: 'backup-destination' }, f.root);
  const job = f.store.startJob({ commandId: randomUUID(), kind: 'backup', rootId: root.id, mode: 'metadata', userConfirmed: true });
  f.store.markRunning(job.id);
  const cancel = { commandId: randomUUID(), id: job.id };
  assert.equal(f.store.cancel(cancel).state, 'cancelling');
  const summary = { backupId: job.id, manifestHash: 'a'.repeat(64), mode: 'metadata' as const, objectCount: 0, copyBytes: 0, operationCount: 0, incompleteCount: 0 };
  assert.equal(f.store.finish(job.id, { summary }, { ...f.root, id: job.id }).state, 'succeeded');
  assert.equal(f.store.cancel(cancel).state, 'succeeded');
});

for (const action of ['cancel', 'revoke', 'close'] as const) {
  test(`实际快照后${action}停止文件发布，冷启动不重放已确认任务`, async t => {
    const f = await setup(t), { createCollectionRepository } = await import('../src/collection/repository.js');
    const { createBackupCoordinator } = await import('../src/recording/backup-coordinator.js');
    const { createArchiveBackup } = await import('../src/recording/backup-package.js');
    const repository = createCollectionRepository({ filePath: ':memory:' });
    let hookCalled = false, jobId = '', closing: Promise<void> | undefined;
    const coordinator = createBackupCoordinator({ store: f.store, repository, createBackup: async options => createArchiveBackup({ ...options, afterSnapshot: async () => {
      hookCalled = true;
      if (action === 'cancel') coordinator.cancel({ commandId: randomUUID(), id: jobId });
      if (action === 'revoke') coordinator.revoke({ commandId: randomUUID(), id: root.id });
      if (action === 'close') closing = coordinator.close();
    } }) });
    const root = await coordinator.authorize({ commandId: randomUUID(), kind: 'backup-destination', absolutePath: f.root.path });
    const request = { commandId: randomUUID(), kind: 'backup' as const, rootId: root.id, mode: 'metadata' as const, userConfirmed: true as const };
    try {
      jobId = coordinator.start(request).id; await coordinator.idle(); await closing;
      assert.equal(hookCalled, true, '必须在真实快照完成后触发取消或撤权');
      assert.ok(!(await readdir(path.join(f.root.path, jobId))).includes('Complete.json'));
      if (action !== 'close') assert.equal(coordinator.overview().jobs[0]?.state, action === 'cancel' ? 'cancelled' : 'failed');
    } finally { await coordinator.close(); repository.close(); }
    const cold = f.create({ filePath: f.filePath });
    try { assert.equal(cold.startJob(request).id, jobId); assert.equal(cold.overview().jobs.length, 1); assert.notEqual(cold.overview().jobs[0]?.state, 'queued'); }
    finally { cold.close(); }
  });
}

async function activationSetup(t: test.TestContext, hooks: { prepareDataset?: typeof prepareRestoredDataset } = {}) {
  const f = await setup(t), { createCollectionRepository } = await import('../src/collection/repository.js');
  const { createBackupCoordinator } = await import('../src/recording/backup-coordinator.js');
  const privatePath = path.join(f.directory, '私有数据'); await mkdir(privatePath);
  const privateRoot = { ...await authorizeSourceDirectory(privatePath), id: randomUUID() };
  const repository = createCollectionRepository({ filePath: ':memory:' });
  const coordinator = createBackupCoordinator({ store: f.store, repository, privateRoot, ...hooks });
  t.after(async () => { await coordinator.close(); repository.close(); });
  const backupRoot = await coordinator.authorize({ commandId: randomUUID(), kind: 'backup-destination', absolutePath: f.root.path });
  const backup = coordinator.start({ commandId: randomUUID(), kind: 'backup', rootId: backupRoot.id, mode: 'metadata', userConfirmed: true }); await coordinator.idle();
  const source = coordinator.overview().jobs.find(j => j.id === backup.id)!.resultRootId!;
  const verify = coordinator.start({ commandId: randomUUID(), kind: 'verify', rootId: source, userConfirmed: true }); await coordinator.idle();
  const targetPath = path.join(f.directory, '恢复'); await mkdir(targetPath);
  const target = await coordinator.authorize({ commandId: randomUUID(), kind: 'restore-destination', absolutePath: targetPath });
  const restore = coordinator.start({ commandId: randomUUID(), kind: 'restore', rootId: source, destinationId: target.id, verificationId: verify.id, userConfirmed: true }); await coordinator.idle();
  assert.equal(coordinator.overview().jobs.find(value => value.id === restore.id)?.state, 'succeeded');
  const request = { commandId: randomUUID(), restoreJobId: restore.id, expectedActiveId: null, userConfirmed: true as const, stopPlaybackConfirmed: true as const };
  return { ...f, coordinator, privateRoot, privatePath, repository, backupRoot, source, target, restore, request };
}

test('独立激活确认排队复制新工作库，不切换旧库或重复复制，撤权候选拒绝', async t => {
  const f = await activationSetup(t), { coordinator, privatePath, request } = f;
  assert.equal(typeof coordinator.activate, 'function', '恢复候选尚不能独立确认激活');
  assert.throws(() => coordinator.activate({ ...request, stopPlaybackConfirmed: false } as never));
  assert.deepEqual(await readdir(privatePath), []);
  const activation = coordinator.activate(request); assert.equal(activation.state, 'preparing');
  await coordinator.idle();
  assert.equal(coordinator.overview().activations[0]?.state, 'prepared');
  assert.equal(f.store.activations.overview().activeId, null);
  assert.equal(coordinator.activate(request).id, activation.id);
  assert.equal((await readdir(path.join(privatePath, 'restored-datasets'))).length, 1);
  await assert.rejects(coordinator.authorize({ commandId: randomUUID(), kind: 'backup-destination', absolutePath: privatePath }));
  assert.equal(JSON.stringify(coordinator.overview()).includes(privatePath), false);
  await coordinator.close();
});

test('准备前撤销恢复目标授权不创建私有目录，失败命令重试不自动复制', async t => {
  const f = await activationSetup(t);
  f.coordinator.revoke({ commandId: randomUUID(), id: f.target.id });
  const activation = f.coordinator.activate(f.request);
  await f.coordinator.idle();
  assert.equal(f.store.activations.get(activation.id).view.state, 'failed');
  assert.deepEqual(await readdir(f.privatePath), []);
  assert.equal(f.coordinator.activate(f.request).id, activation.id);
  await f.coordinator.idle();
  assert.equal(f.coordinator.activate(f.request).state, 'failed');
  assert.deepEqual(await readdir(f.privatePath), []);
  await f.coordinator.close();
});

for (const phase of ['copy', 'completed-files'] as const) {
  for (const action of ['revoke', 'close'] as const) {
    test(`激活真实${phase}之后${action}不发布prepared，失败不会自动重放`, async t => {
      let reached = false, trigger = () => {}, closing: Promise<void> | undefined;
      const f = await activationSetup(t, { prepareDataset: async options => {
        if (phase === 'copy') return prepareRestoredDataset({ ...options, copy: async (...args) => {
          const copied = await copyReadonlySource(...args); reached = true; trigger(); return copied;
        } });
        const value = await prepareRestoredDataset(options);
        reached = true; trigger(); return value;
      } });
      trigger = () => {
        if (action === 'revoke') f.coordinator.revoke({ commandId: randomUUID(), id: f.target.id });
        else closing = f.coordinator.close();
      };
      const activation = f.coordinator.activate(f.request);
      assert.equal(f.coordinator.activate(f.request).id, activation.id, '排队中的重复命令不能新增候选');
      await f.coordinator.idle(); await closing;
      assert.equal(reached, true, '必须实际完成文件复制或文件层发布后才触发中断');
      assert.ok((await stat(path.join(f.privatePath, 'restored-datasets', activation.id, 'database', 'collection.sqlite'))).size > 0);
      const files = await readdir(path.join(f.privatePath, 'restored-datasets', activation.id));
      assert.equal(files.includes('ActivationComplete.json'), phase === 'completed-files');
      await f.coordinator.close();
      const cold = f.create({ filePath: f.filePath });
      try {
        assert.equal(cold.activations.get(activation.id).view.state, 'failed');
        assert.equal(cold.activations.get(activation.id).view.issue, action === 'close' ? 'PREPARATION_INTERRUPTED' : 'PREPARATION_FAILED');
        assert.equal(cold.activations.beginBoot().pending, undefined);
        assert.equal(cold.activations.begin(f.request).view.id, activation.id);
        assert.equal(cold.activations.begin(f.request).view.state, 'failed');
        assert.deepEqual(await readdir(path.join(f.privatePath, 'restored-datasets')), [activation.id]);
      } finally { cold.close(); }
    });
  }
}

for (const coldRevoke of [false, true]) {
  test(`prepared${coldRevoke ? '冷开' : '当前进程'}撤权清除持久pending，不能自动激活旧授权副本`, async t => {
    const f = await activationSetup(t), activation = f.coordinator.activate(f.request);
    await f.coordinator.idle();
    assert.equal(f.store.activations.get(activation.id).view.state, 'prepared');
    assert.equal(f.store.activations.get(activation.id).dataset?.source.authorized, true);
    let coordinator = f.coordinator;
    if (coldRevoke) {
      await coordinator.close();
      const { createBackupCoordinator } = await import('../src/recording/backup-coordinator.js');
      coordinator = createBackupCoordinator({ store: f.create({ filePath: f.filePath }), repository: f.repository, privateRoot: f.privateRoot });
    }
    try {
      coordinator.revoke({ commandId: randomUUID(), id: f.target.id });
      assert.equal(coordinator.overview().activations.find(value => value.id === activation.id)?.state, 'failed');
      assert.equal(coordinator.activate(f.request).state, 'failed');
    } finally { await coordinator.close(); }
    const cold = f.create({ filePath: f.filePath });
    try {
      assert.equal(cold.activations.beginBoot().pending, undefined);
      assert.equal(cold.activations.get(activation.id).view.issue, 'PREPARATION_FAILED');
      assert.equal(cold.activations.overview().activeId, null);
    } finally { cold.close(); }
  });
}

test('已排队备份和激活分属回执域，撤权及取消不误读表，新备份不能越过pending激活', async t => {
  const f = await activationSetup(t);
  const queued = f.coordinator.start({ commandId: randomUUID(), kind: 'backup', rootId: f.backupRoot.id, mode: 'metadata', userConfirmed: true });
  const activation = f.coordinator.activate(f.request);
  assert.throws(() => f.coordinator.cancel({ commandId: randomUUID(), id: activation.id }));
  assert.equal(f.coordinator.cancel({ commandId: randomUUID(), id: f.restore.id }).state, 'succeeded');
  assert.throws(() => f.coordinator.start({ commandId: randomUUID(), kind: 'verify', rootId: f.source, userConfirmed: true }));
  f.coordinator.revoke({ commandId: randomUUID(), id: f.backupRoot.id });
  await f.coordinator.idle();
  assert.equal(f.store.job(queued.id).view.issue, 'AUTHORIZATION_REVOKED');
  assert.equal(f.store.activations.get(activation.id).view.state, 'prepared');
  assert.equal(f.coordinator.activate(f.request).id, activation.id);
  await f.coordinator.close();
});

test('激活排队后立即关闭不创建目录，冷开保留中断回执而不重放', async t => {
  const f = await activationSetup(t), activation = f.coordinator.activate(f.request);
  await f.coordinator.close();
  assert.deepEqual(await readdir(f.privatePath), []);
  const cold = f.create({ filePath: f.filePath });
  try {
    assert.equal(cold.activations.get(activation.id).view.issue, 'PREPARATION_INTERRUPTED');
    assert.equal(cold.activations.beginBoot().pending, undefined);
    assert.equal(cold.activations.begin(f.request).view.state, 'failed');
  } finally { cold.close(); }
});

test('已租用待激活候选撤权回滚，迟到commit不能切换工作库', async t => {
  const f = await activationSetup(t), activation = f.coordinator.activate(f.request);
  await f.coordinator.idle();
  assert.equal(f.store.activations.beginBoot().pending?.view.id, activation.id);
  f.coordinator.revoke({ commandId: randomUUID(), id: f.target.id });
  assert.equal(f.store.activations.get(activation.id).view.state, 'rolled-back');
  assert.equal(f.store.activations.get(activation.id).view.issue, 'BOOT_FAILED');
  assert.throws(() => f.store.activations.commitBoot(activation.id));
  assert.equal(f.store.activations.overview().activeId, null);
  await f.coordinator.close();
});
