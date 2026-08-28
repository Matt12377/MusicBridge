import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { archiveBackupFixture } from './helpers/archive-backup-fixture.js';
import { authorizeSourceDirectory, copyReadonlySource } from '../src/recording/source-files.js';
import { BackupError } from '../src/recording/backup-files.js';
import { restoreArchiveBackup, verifyRestoredArchive } from '../src/recording/restore-package.js';
import { createCollectionRepository } from '../src/collection/repository.js';

async function fixture(t: test.TestContext, mode: 'archive-content' | 'metadata' = 'archive-content') {
  const f = await archiveBackupFixture(t), backup = await f.api.createArchiveBackup({ ...f.backupRequest, mode });
  const destinationPath = path.join(f.directory, '隔离恢复'), privatePath = path.join(f.directory, '工作库集合');
  await mkdir(destinationPath); await mkdir(privatePath);
  const destination = { ...await authorizeSourceDirectory(destinationPath), id: randomUUID() };
  const datasets = { ...await authorizeSourceDirectory(privatePath), id: randomUUID() };
  const restored = await restoreArchiveBackup({ backup: backup.directory, destination, protectedRoots: [], id: randomUUID(), userConfirmed: true, signal: new AbortController().signal });
  const module = await import('../src/recording/restore-activation-files.js').catch(() => ({}));
  assert.ok('prepareRestoredDataset' in module && 'verifyPreparedDataset' in module, '缺少恢复激活前的独立工作库复制与复核');
  const api = module as typeof import('../src/recording/restore-activation-files.js');
  const request = { id: randomUUID(), source: restored.directory, destination: datasets, userConfirmed: true, signal: new AbortController().signal };
  return { ...f, restored, datasets, api, request };
}

test('未确认激活不创建工作库；确认后复制工作库，恢复包和旧库权限事实不变', async t => {
  const f = await fixture(t), original = await readFile(path.join(f.restored.directory.path, 'database/collection.sqlite'));
  await assert.rejects(f.api.prepareRestoredDataset({ ...f.request, userConfirmed: false }));
  assert.deepEqual(await readdir(f.datasets.path), []);
  const prepared = await f.api.prepareRestoredDataset(f.request);
  await f.api.verifyPreparedDataset(prepared, f.request.signal);
  assert.deepEqual(await readFile(path.join(prepared.database.path, 'collection.sqlite')), original);
  const repository = createCollectionRepository({ filePath: path.join(prepared.database.path, 'collection.sqlite') });
  try {
    assert.throws(() => repository.archive.root(f.root.id), '恢复旧根的权限必须继续撤销');
    assert.equal(repository.archive.operation(f.archiveRequest.commandId)?.owned?.archive.root.path, f.root.root.path);
  } finally { repository.close(); }
  assert.deepEqual(await readFile(path.join(f.restored.directory.path, 'database/collection.sqlite')), original);
  await verifyRestoredArchive(f.restored.directory, f.request.signal);
});

test('激活候选不覆盖同名目录，复核拒绝已变化的工作库字节', async t => {
  const f = await fixture(t), prepared = await f.api.prepareRestoredDataset(f.request);
  const file = path.join(prepared.database.path, 'collection.sqlite'), before = await readFile(file);
  await assert.rejects(f.api.prepareRestoredDataset(f.request));
  assert.deepEqual(await readFile(file), before);
  await writeFile(file, Buffer.concat([before, Buffer.from('变化')]));
  await assert.rejects(f.api.verifyPreparedDataset(prepared, f.request.signal));
  await verifyRestoredArchive(f.restored.directory, f.request.signal);
});

test('恢复对象变化时拒绝激活，不发布激活完成标记', async t => {
  const f = await fixture(t), object = f.restored.manifest.objects[0]!;
  await writeFile(path.join(f.restored.directory.path, 'objects', object.sha256), '变化的合成对象');
  await assert.rejects(f.api.prepareRestoredDataset(f.request));
  assert.deepEqual(await readdir(f.datasets.path), []);
});

test('复制完成后目标父根被替换，即使原候选子目录移回也不得发布完成标记', async t => {
  const f = await fixture(t), displaced = path.join(f.directory, '原工作库集合');
  let copied = false;
  const request = { ...f.request, copy: (async (...args) => {
    const result = await copyReadonlySource(...args); copied = true;
    await rename(f.datasets.path, displaced); await mkdir(f.datasets.path);
    // 保留候选及数据库 inode，仅替换已授权父根，复现只检查子根的缺口。
    await rename(path.join(displaced, f.request.id), path.join(f.datasets.path, f.request.id));
    return result;
  }) satisfies typeof copyReadonlySource };
  const failure = await f.api.prepareRestoredDataset(request).then(() => undefined, error => error as unknown);
  assert.equal(copied, true, '必须实际完成复制和目录替换后才评价失败证据');
  assert.ok(failure instanceof BackupError && failure.code === 'BACKUP_DESTINATION_INVALID');
  assert.ok(!(await readdir(path.join(f.datasets.path, f.request.id))).includes('ActivationComplete.json'));
  await verifyRestoredArchive(f.restored.directory, f.request.signal);
});

test('复制完成后源恢复根被替换，不发布完成标记且移走的原恢复包仍完整', async t => {
  const f = await fixture(t), displaced = path.join(f.directory, '原恢复包');
  let copied = false;
  const request = { ...f.request, copy: (async (...args) => {
    const result = await copyReadonlySource(...args); copied = true;
    await rename(f.restored.directory.path, displaced); await mkdir(f.restored.directory.path);
    await writeFile(path.join(f.restored.directory.path, '用户文件.txt'), '替换根中的用户文件');
    return result;
  }) satisfies typeof copyReadonlySource };
  await assert.rejects(f.api.prepareRestoredDataset(request));
  assert.equal(copied, true);
  assert.ok(!(await readdir(path.join(f.datasets.path, f.request.id))).includes('ActivationComplete.json'));
  assert.equal(await readFile(path.join(f.restored.directory.path, '用户文件.txt'), 'utf8'), '替换根中的用户文件');
  await verifyRestoredArchive({ ...f.restored.directory, path: displaced }, f.request.signal);
});

test('复制部分真实数据库字节后取消，保留取消原因、未完成现场和原恢复包', async t => {
  const f = await fixture(t), controller = new AbortController(), reason = new Error('用户取消激活复制');
  const original = await readFile(path.join(f.restored.directory.path, 'database', 'collection.sqlite'));
  let copied = false;
  const request = { ...f.request, signal: controller.signal, copy: (async (...args) => {
    await args[3].write(original.subarray(0, 64)); copied = true; controller.abort(reason);
    return copyReadonlySource(...args);
  }) satisfies typeof copyReadonlySource };
  const failure = await f.api.prepareRestoredDataset(request).then(() => undefined, error => error as unknown);
  assert.equal(copied, true);
  assert.equal(failure, reason, '取消不得被内部 SourceFileError 替代');
  const candidate = path.join(f.datasets.path, f.request.id);
  assert.ok(!(await readdir(candidate)).includes('ActivationComplete.json'));
  assert.deepEqual(await readFile(path.join(candidate, 'database', 'collection.sqlite')), original.subarray(0, 64));
  await verifyRestoredArchive(f.restored.directory, f.request.signal);
});

test('部分数据库写入后磁盘错误不发布完成标记，重试不覆盖中断现场', async t => {
  const f = await fixture(t), original = await readFile(path.join(f.restored.directory.path, 'database', 'collection.sqlite'));
  let copied = false;
  const request = { ...f.request, copy: (async (_root, _relative, _file, handle) => {
    await handle.write(original.subarray(0, 64)); copied = true;
    throw Object.assign(new Error('合成写满'), { code: 'ENOSPC' });
  }) satisfies typeof copyReadonlySource };
  const failure = await f.api.prepareRestoredDataset(request).then(() => undefined, error => error as unknown);
  assert.equal(copied, true);
  assert.ok(failure instanceof BackupError && failure.code === 'BACKUP_IO_ERROR');
  const candidate = path.join(f.datasets.path, f.request.id);
  assert.ok(!(await readdir(candidate)).includes('ActivationComplete.json'));
  await assert.rejects(f.api.prepareRestoredDataset(f.request));
  assert.deepEqual(await readFile(path.join(candidate, 'database', 'collection.sqlite')), original.subarray(0, 64));
  await verifyRestoredArchive(f.restored.directory, f.request.signal);
});

test('开始前已取消不创建候选，未知同名目录及其用户内容原样保留', async t => {
  const f = await fixture(t), controller = new AbortController(), reason = new Error('开始前取消');
  controller.abort(reason);
  await assert.rejects(f.api.prepareRestoredDataset({ ...f.request, signal: controller.signal }), error => error === reason);
  assert.deepEqual(await readdir(f.datasets.path), []);
  const occupied = path.join(f.datasets.path, f.request.id); await mkdir(occupied);
  await writeFile(path.join(occupied, '用户文件.txt'), '不能覆盖或清理');
  await assert.rejects(f.api.prepareRestoredDataset(f.request));
  assert.deepEqual(await readdir(occupied), ['用户文件.txt']);
  assert.equal(await readFile(path.join(occupied, '用户文件.txt'), 'utf8'), '不能覆盖或清理');
});

test('元数据恢复可创建独立工作库但持续声明不含归档内容，也不重授旧根权限', async t => {
  const f = await fixture(t, 'metadata'); await rm(f.root.root.path, { recursive: true });
  const prepared = await f.api.prepareRestoredDataset(f.request);
  await f.api.verifyPreparedDataset(prepared, f.request.signal);
  assert.equal(prepared.contentIncluded, false);
  assert.equal(JSON.parse(await readFile(path.join(prepared.directory.path, 'Activation.json'), 'utf8')).contentIncluded, false);
  assert.deepEqual(await readdir(path.join(f.restored.directory.path, 'objects')), []);
  const repository = createCollectionRepository({ filePath: path.join(prepared.database.path, 'collection.sqlite') });
  try { assert.throws(() => repository.archive.root(f.root.id)); }
  finally { repository.close(); }
});

test('完成标记缺失或写入中断形成截断文件时，候选仍不可激活且不改恢复包', async t => {
  const f = await fixture(t), prepared = await f.api.prepareRestoredDataset(f.request);
  const marker = path.join(prepared.directory.path, 'ActivationComplete.json');
  await rm(marker);
  await assert.rejects(f.api.verifyPreparedDataset(prepared, f.request.signal));
  await writeFile(marker, '{"schemaVersion":1');
  await assert.rejects(f.api.verifyPreparedDataset(prepared, f.request.signal));
  assert.equal(await readFile(marker, 'utf8'), '{"schemaVersion":1');
  await verifyRestoredArchive(f.restored.directory, f.request.signal);
});
