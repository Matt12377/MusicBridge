import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { copyFile, link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { openCollectionDataset } from '../src/recording/restore-dataset-runtime.js';
import { archiveBackupFixture } from './helpers/archive-backup-fixture.js';
import { createCollectionRepository, type CollectionRepository } from '../src/collection/repository.js';
import { createBackupWorkflowStore } from '../src/recording/backup-workflow-store.js';
import { createBackupCoordinator } from '../src/recording/backup-coordinator.js';
import { authorizeSourceDirectory, copyReadonlySource } from '../src/recording/source-files.js';
import { prepareRestoredDataset } from '../src/recording/restore-activation-files.js';

const page = { offset: 0, limit: 1 };
function addBusinessData(repository: CollectionRepository): void {
  repository.receive({ commandId: randomUUID(), model: { brand: '合成', name: '激活后新增', edition: '测试', year: 1990, format: 'cassette', tapeType: 'II', identification: 'verified' }, lengthMinutes: 60, quantities: { openedBlank: 1, sealedBlank: 0, legacyUsed: 0, unclassified: 0 } });
}
async function fixture(t: test.TestContext) {
  const f = await archiveBackupFixture(t), backup = await f.api.createArchiveBackup(f.backupRequest);
  const privatePath = path.join(f.directory, '应用私有目录'), restorePath = path.join(f.directory, '隔离恢复');
  await mkdir(privatePath); await mkdir(restorePath);
  const privateRoot = { ...await authorizeSourceDirectory(privatePath), id: randomUUID() };
  const defaultFile = path.join(privatePath, 'collection.v1.sqlite'), defaultRepository = createCollectionRepository({ filePath: defaultFile });
  defaultRepository.list(page); defaultRepository.close();
  const storePath = path.join(privatePath, 'backup-maintenance.v1.sqlite'), store = createBackupWorkflowStore({ filePath: storePath });
  const coordinator = createBackupCoordinator({ store, repository: f.repository, privateRoot });
  const source = await coordinator.authorize({ commandId: randomUUID(), kind: 'backup-source', absolutePath: backup.directory.path });
  const destination = await coordinator.authorize({ commandId: randomUUID(), kind: 'restore-destination', absolutePath: restorePath });
  const verify = coordinator.start({ commandId: randomUUID(), kind: 'verify', rootId: source.id, userConfirmed: true });
  await coordinator.idle(); assert.equal(store.job(verify.id).view.state, 'succeeded');
  const restore = coordinator.start({ commandId: randomUUID(), kind: 'restore', rootId: source.id, destinationId: destination.id, verificationId: verify.id, userConfirmed: true });
  await coordinator.idle(); assert.equal(store.job(restore.id).view.state, 'succeeded');
  const restored = store.job(restore.id).output!;
  await coordinator.close();
  const datasetsPath = path.join(privatePath, 'restored-datasets'); await mkdir(datasetsPath);
  const datasets = { ...await authorizeSourceDirectory(datasetsPath), id: randomUUID() };
  const prepare = async (expectedActiveId: string | null = null) => {
    const maintenance = createBackupWorkflowStore({ filePath: storePath });
    try {
      const request = { commandId: randomUUID(), restoreJobId: restore.id, expectedActiveId, userConfirmed: true as const, stopPlaybackConfirmed: true as const };
      const pending = maintenance.activations.begin(request);
      const prepared = await prepareRestoredDataset({ id: pending.view.id, source: restored, destination: datasets, userConfirmed: true, signal: new AbortController().signal });
      maintenance.activations.prepared(pending.view.id, prepared);
      return { request, id: pending.view.id, prepared };
    } finally { maintenance.close(); }
  };
  const pending = await prepare();
  const module = await import('../src/recording/restore-dataset-runtime.js').catch(() => ({}));
  assert.ok('openCollectionDataset' in module, '缺少启动工作库选择与回滚边界');
  const open = (module as typeof import('../src/recording/restore-dataset-runtime.js')).openCollectionDataset;
  return { ...f, privatePath, defaultFile, storePath, restored, destinationId: destination.id, pending, prepare, open };
}

test('目录schema15默认工作库关闭后可冷开，保留dataset身份及库存', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-catalog-cold-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await openCollectionDataset(directory), datasetId = first.datasetId;
  addBusinessData(first.repository); first.close();
  const cold = await openCollectionDataset(directory);
  try { assert.equal(cold.datasetId, datasetId); assert.equal(cold.repository.list(page).total, 1); }
  finally { cold.close(); }
});

test('启动先选择已确认候选，仅运行成功后commit切换持久指针，旧库原样保留', async t => {
  const f = await fixture(t), before = await readFile(f.defaultFile), maintenance = createBackupWorkflowStore({ filePath: f.storePath });
  const originalId = maintenance.datasetIdentities.bind('default', f.defaultFile, true).datasetId; maintenance.close();
  const opened = await f.open(f.privatePath);
  try {
    assert.notEqual(opened.datasetId, originalId); assert.notEqual(opened.datasetId, f.pending.id);
    assert.equal(opened.pendingActivationId, f.pending.id); assert.equal(opened.repository.list(page).total, 1);
    assert.equal(opened.store.activations.overview().activeId, null); assert.equal(opened.store.activations.get(f.pending.id).view.state, 'activating');
    assert.ok(opened.contentBinding); assert.equal(opened.privateRoot.path, f.privatePath);
    opened.commit(); opened.commit();
    assert.equal(opened.store.activations.overview().activeId, f.pending.id);
  } finally { opened.close(); }
  assert.deepEqual(await readFile(f.defaultFile), before);
});

test('候选启动前损坏只回旧默认库一次，留下BOOT_FAILED且冷启动不重放', async t => {
  const f = await fixture(t), file = path.join(f.pending.prepared.database.path, 'collection.sqlite');
  const corrupt = Buffer.concat([await readFile(file), Buffer.from('合成损坏')]); await writeFile(file, corrupt);
  const opened = await f.open(f.privatePath);
  try {
    assert.equal(opened.pendingActivationId, undefined); assert.equal(opened.repository.list(page).total, 0);
    assert.equal(opened.store.activations.get(f.pending.id).view.issue, 'BOOT_FAILED');
    assert.equal(opened.store.activations.begin(f.pending.request).view.state, 'rolled-back');
  } finally { opened.close(); }
  const cold = await f.open(f.privatePath);
  try { assert.equal(cold.repository.list(page).total, 0); assert.equal(cold.pendingActivationId, undefined); }
  finally { cold.close(); }
  assert.deepEqual(await readFile(file), corrupt);
});

test('active工作库允许新增业务数据，恢复包和历史源离线后冷启动仍保留新数据', async t => {
  const f = await fixture(t), opened = await f.open(f.privatePath);
  const datasetId = (opened as typeof opened & { datasetId?: string }).datasetId;
  assert.match(datasetId ?? '', /^[0-9a-f-]{36}$/u);
  opened.commit(); addBusinessData(opened.repository); assert.equal(opened.repository.list(page).total, 2); opened.close();
  await rename(f.restored.path, f.restored.path + '-离线'); await rm(f.root.root.path, { recursive: true });
  const cold = await f.open(f.privatePath);
  try {
    assert.equal((cold as typeof cold & { datasetId?: string }).datasetId, datasetId);
    assert.equal(cold.repository.list(page).total, 2); assert.equal(cold.pendingActivationId, undefined); assert.ok(cold.contentBinding);
    assert.equal(cold.store.activations.overview().activeId, f.pending.id);
    assert.throws(() => cold.repository.archive.root(f.root.id));
  } finally { cold.close(); }
});

test('已激活数据库被相同字节的新文件替换也拒绝冷启动，不继承原scope', async t => {
  const f = await fixture(t), opened = await f.open(f.privatePath); opened.commit(); opened.close();
  const file = path.join(f.pending.prepared.database.path, 'collection.sqlite');
  await rename(file, file + '.original'); await copyFile(file + '.original', file);
  await assert.rejects(f.open(f.privatePath));
});

test('第二个候选损坏回退到先前active工作库，保留其激活后新增数据', async t => {
  const f = await fixture(t), first = await f.open(f.privatePath);
  first.commit(); addBusinessData(first.repository); first.close();
  const next = await f.prepare(f.pending.id), file = path.join(next.prepared.database.path, 'collection.sqlite');
  await writeFile(file, '第二候选的合成损坏');
  const opened = await f.open(f.privatePath);
  try {
    assert.equal(opened.repository.list(page).total, 2); assert.equal(opened.store.activations.overview().activeId, f.pending.id);
    assert.equal(opened.store.activations.get(next.id).view.issue, 'BOOT_FAILED'); assert.equal(opened.pendingActivationId, undefined);
  } finally { opened.close(); }
});

for (const checkpoint of ['before-open', 'before-commit'] as const) {
  test(`恢复目标授权在${checkpoint}撤销不得切换工作库`, async t => {
    const f = await fixture(t);
    if (checkpoint === 'before-open') {
      const maintenance = createBackupWorkflowStore({ filePath: f.storePath });
      maintenance.revoke({ commandId: randomUUID(), id: f.destinationId }); maintenance.close();
    }
    const opened = await f.open(f.privatePath);
    try {
      if (checkpoint === 'before-open') { assert.equal(opened.repository.list(page).total, 0); assert.equal(opened.pendingActivationId, undefined); }
      else {
        opened.store.revoke({ commandId: randomUUID(), id: f.destinationId });
        assert.throws(() => opened.commit()); opened.fail();
      }
      assert.equal(opened.store.activations.overview().activeId, null);
    } finally { opened.close(); }
  });
}

test('启动失败时store已关闭仍可fail清理，下次启动识别activating并回旧库', async t => {
  const f = await fixture(t), opened = await f.open(f.privatePath);
  opened.store.close(); assert.doesNotThrow(() => opened.fail()); opened.close();
  const cold = await f.open(f.privatePath);
  try { assert.equal(cold.repository.list(page).total, 0); assert.equal(cold.store.activations.get(f.pending.id).view.issue, 'BOOT_INTERRUPTED'); }
  finally { cold.close(); }
});

for (const fault of ['corrupt', 'symlink', 'hardlink'] as const) {
  test(`active数据库${fault}拒绝启动，不覆盖文件也不回退默认库`, async t => {
    const f = await fixture(t), opened = await f.open(f.privatePath); opened.commit(); opened.close();
    const file = path.join(f.pending.prepared.database.path, 'collection.sqlite'), original = await readFile(file);
    if (fault === 'corrupt') await writeFile(file, '合成损坏的工作库');
    else if (fault === 'hardlink') await link(file, path.join(f.privatePath, '工作库硬链接'));
    else { await rename(file, file + '.saved'); await symlink(file + '.saved', file); }
    await assert.rejects(f.open(f.privatePath));
    assert.deepEqual(await readFile(file), fault === 'corrupt' ? Buffer.from('合成损坏的工作库') : original);
    assert.deepEqual((await readdir(f.privatePath)).filter(name => name.startsWith('collection.v1')), ['collection.v1.sqlite']);
  });
}

for (const state of ['missing', 'empty', 'unknown'] as const) {
  test(`默认数据库${state}仅允许缺失文件首次初始化，已有未知内容不覆盖`, async t => {
    const f = await fixture(t), maintenance = createBackupWorkflowStore({ filePath: f.storePath });
    maintenance.activations.fail(f.pending.id, 'PREPARATION_FAILED'); maintenance.close();
    await rm(f.defaultFile);
    if (state !== 'missing') await writeFile(f.defaultFile, state === 'empty' ? '' : '合成未知内容');
    if (state === 'missing') {
      const opened = await f.open(f.privatePath);
      try { assert.equal(opened.repository.list(page).total, 0); assert.equal(opened.contentBinding, undefined); }
      finally { opened.close(); }
    } else {
      await assert.rejects(f.open(f.privatePath));
      assert.equal(await readFile(f.defaultFile, 'utf8'), state === 'empty' ? '' : '合成未知内容');
    }
  });
}

for (const checkpoint of ['before-backup', 'during-copy'] as const) {
  test(`active恢复目标在${checkpoint}撤权后拒绝全内容备份，元数据及冷启动工作库仍可用`, async t => {
    const f = await fixture(t), opened = await f.open(f.privatePath); opened.commit();
    const destinationPath = path.join(f.directory, '撤权后的备份'); await mkdir(destinationPath);
    const destination = { ...await authorizeSourceDirectory(destinationPath), id: randomUUID() };
    const id = randomUUID(), object = f.repository.archive.operation(f.archiveRequest.commandId)!.owned!.files[0]!;
    const originalObject = await readFile(path.join(f.restored.path, 'objects', object.sha256));
    let revoked = false, copiedObjects = 0;
    const revoke = () => { if (!revoked) { opened.store.revoke({ commandId: randomUUID(), id: f.destinationId }); revoked = true; } };
    try {
      if (checkpoint === 'before-backup') revoke();
      await assert.rejects(f.api.createArchiveBackup({ repository: opened.repository, destination, id, mode: 'archive-content', userConfirmed: true, signal: new AbortController().signal,
        contentBinding: opened.contentBinding!, copy: async (...args) => { ++copiedObjects; const copied = await copyReadonlySource(...args); revoke(); return copied; },
      }), '撤销恢复目标授权后不得发布完整内容备份');
      assert.equal(revoked, true);
      assert.equal(copiedObjects, checkpoint === 'during-copy' ? 1 : 0, '撤权后不能开始读取下一对象');
      const children = await readdir(destination.path);
      if (children.includes(id)) assert.ok(!(await readdir(path.join(destination.path, id))).includes('Complete.json'));
      const metadata = await f.api.createArchiveBackup({ repository: opened.repository, destination, id: randomUUID(), mode: 'metadata', userConfirmed: true, signal: new AbortController().signal, contentBinding: opened.contentBinding! });
      assert.equal((await f.api.verifyArchiveBackup(metadata.directory, new AbortController().signal)).contentIncluded, false);
      assert.equal(opened.repository.list(page).total, 1);
      assert.deepEqual(await readFile(path.join(f.restored.path, 'objects', object.sha256)), originalObject);
    } finally { opened.close(); }
    const cold = await f.open(f.privatePath);
    try {
      assert.equal(cold.repository.list(page).total, 1);
      await assert.rejects(cold.contentBinding!.open(new AbortController().signal), '撤权事实应在冷启动后继续约束内容读取');
    } finally { cold.close(); }
  });
}

test('协调器撤销已激活内容来源时立即中止全内容备份signal，不读取下一对象', async t => {
  const f = await fixture(t), opened = await f.open(f.privatePath); opened.commit();
  const destinationPath = path.join(f.directory, '后台重新备份'); await mkdir(destinationPath);
  let copied = 0, aborted = false;
  const coordinator = createBackupCoordinator({ store: opened.store, repository: opened.repository, privateRoot: opened.privateRoot, contentBinding: opened.contentBinding!, createBackup: options => f.api.createArchiveBackup({ ...options, copy: async (...args) => {
    ++copied; const result = await copyReadonlySource(...args);
    coordinator.revoke({ commandId: randomUUID(), id: f.destinationId });
    aborted = args[4].aborted;
    return result;
  } }) });
  try {
    const root = await coordinator.authorize({ commandId: randomUUID(), kind: 'backup-destination', absolutePath: destinationPath });
    const job = coordinator.start({ commandId: randomUUID(), kind: 'backup', rootId: root.id, mode: 'archive-content', userConfirmed: true });
    await coordinator.idle();
    assert.equal(aborted, true, '撤权必须传递给当前真实文件复制signal');
    assert.equal(copied, 1);
    assert.equal(coordinator.overview().jobs.find(value => value.id === job.id)?.issue, 'AUTHORIZATION_REVOKED');
    assert.ok(!(await readdir(path.join(destinationPath, job.id))).includes('Complete.json'));
  } finally { await coordinator.close(); opened.close(); }
});
