import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { executionFixture } from './helpers/execution-fixture.js';
import { createArchiveCoordinator } from '../src/recording/archive-coordinator.js';
import { authorizeSourceDirectory } from '../src/recording/source-files.js';
import { archiveDigest } from '../src/recording/archive-files.js';

async function setup(t: test.TestContext) {
  const f = await executionFixture(t);
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
  const module = await import('../src/recording/backup-package.js').catch(() => ({}));
  assert.ok('createArchiveBackup' in module && 'verifyArchiveBackup' in module, '生产备份包边界尚未实现');
  const api = module as typeof import('../src/recording/backup-package.js');
  const backupRequest = { repository: f.repository, destination, id: randomUUID(), mode: 'archive-content' as const, userConfirmed: true, signal: new AbortController().signal };
  return { ...f, api, archive, archiveRequest: request, root: f.repository.archive.root(root.id), destination, backupRequest };
}

test('完整归档内容备份包含快照与每一引用字节；脱离原目录可独立校验', async t => {
  const f = await setup(t), before = f.repository.archive.operations();
  const result = await f.api.createArchiveBackup(f.backupRequest);
  const verified = await f.api.verifyArchiveBackup(result.directory, f.backupRequest.signal);
  assert.equal(verified.mode, 'archive-content');
  assert.ok(verified.objects.length > 0);
  assert.equal(verified.operations.length, 1);
  assert.deepEqual(verified.incompleteOperationIds, []);
  for (const object of verified.objects) assert.equal(archiveDigest(await readFile(path.join(result.directory.path, 'objects', object.sha256))), object.sha256);
  const db = new DatabaseSync(path.join(result.directory.path, 'database', 'collection.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) n FROM archive_operations').get()?.n, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM master_versions').get()?.n, 1);
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally { db.close(); }
  assert.deepEqual(f.repository.archive.operations(), before);
  await rm(f.root.root.path, { recursive: true });
  assert.deepEqual(await f.api.verifyArchiveBackup(result.directory, f.backupRequest.signal), verified);
});

test('备份范围固定于数据库快照；后续新归档不混入旧清单', async t => {
  const f = await setup(t);
  const result = await f.api.createArchiveBackup({ ...f.backupRequest, afterSnapshot: async () => {
    await f.archive.start({ ...f.archiveRequest, commandId: randomUUID() }); await f.archive.idle();
  } });
  assert.equal(f.repository.archive.operations().length, 2);
  assert.equal((await f.api.verifyArchiveBackup(result.directory, f.backupRequest.signal)).operations.length, 1);
});

test('元数据备份允许归档离线，清单明确不包含音频字节', async t => {
  const f = await setup(t);
  await rm(f.root.root.path, { recursive: true });
  const result = await f.api.createArchiveBackup({ ...f.backupRequest, mode: 'metadata' });
  const verified = await f.api.verifyArchiveBackup(result.directory, f.backupRequest.signal);
  assert.equal(verified.mode, 'metadata'); assert.ok(verified.objects.length > 0);
  assert.deepEqual(await readdir(path.join(result.directory.path, 'objects')), []);
  assert.equal(verified.contentIncluded, false);
});

for (const kind of ['missing', 'changed', 'revoked', 'unfinished'] as const) {
  test(`完整备份拒绝 ${kind}；不能发布完成标记`, async t => {
    const f = await setup(t);
    const first = (await readdir(f.root.objects.path))[0]!;
    if (kind === 'missing') await rm(path.join(f.root.objects.path, first));
    if (kind === 'changed') await writeFile(path.join(f.root.objects.path, first), '损坏合成对象');
    if (kind === 'revoked') f.repository.archive.revokeRoot(f.root.id);
    if (kind === 'unfinished') {
      const original = f.repository.archive.operation(f.archiveRequest.commandId)!;
      const { workflow: _workflow, ...request } = original.request;
      f.repository.archive.request({ ...request, id: randomUUID() });
    }
    await assert.rejects(f.api.createArchiveBackup(f.backupRequest));
    const directory = path.join(f.destination.path, f.backupRequest.id);
    assert.ok(!(await readdir(directory).catch((): string[] => [])).includes('Complete.json'));
  });
}

test('未确认或目标重叠不写入；已有备份拒绝覆盖', async t => {
  const f = await setup(t);
  await assert.rejects(f.api.createArchiveBackup({ ...f.backupRequest, userConfirmed: false }));
  assert.deepEqual(await readdir(f.destination.path), []);
  await assert.rejects(f.api.createArchiveBackup({ ...f.backupRequest, destination: f.root.objects }));
  const result = await f.api.createArchiveBackup(f.backupRequest), before = await readFile(path.join(result.directory.path, 'Complete.json'));
  await assert.rejects(f.api.createArchiveBackup(f.backupRequest));
  assert.deepEqual(await readFile(path.join(result.directory.path, 'Complete.json')), before);
});

test('复制中断或取消不发布完成标记，原件和活动数据库不变', async t => {
  const f = await setup(t), controller = new AbortController(), original = f.repository.archive.operations();
  await assert.rejects(f.api.createArchiveBackup({ ...f.backupRequest, signal: controller.signal, afterSnapshot: async () => { controller.abort(); } }));
  assert.ok(!(await readdir(path.join(f.destination.path, f.backupRequest.id))).includes('Complete.json'));
  assert.deepEqual(f.repository.archive.operations(), original);
});

test('缺失或损坏备份内容拒绝验证；修改范围清单不能绕过数据库引用闭包', async t => {
  const f = await setup(t), result = await f.api.createArchiveBackup(f.backupRequest);
  const complete = JSON.parse(await readFile(path.join(result.directory.path, 'Complete.json'), 'utf8'));
  const manifestPath = path.join(result.directory.path, 'Backup.json'), bytes = await readFile(manifestPath, 'utf8'), manifest = JSON.parse(bytes);
  manifest.objects.pop(); const changed = JSON.stringify(manifest, null, 2) + '\n'; await writeFile(manifestPath, changed);
  complete.manifestHash = archiveDigest(changed); await writeFile(path.join(result.directory.path, 'Complete.json'), JSON.stringify(complete) + '\n');
  await assert.rejects(f.api.verifyArchiveBackup(result.directory, f.backupRequest.signal));
  await writeFile(manifestPath, bytes); complete.manifestHash = archiveDigest(bytes); await writeFile(path.join(result.directory.path, 'Complete.json'), JSON.stringify(complete) + '\n');
  await rm(path.join(result.directory.path, 'objects', manifest.objects[0].sha256));
  await assert.rejects(f.api.verifyArchiveBackup(result.directory, f.backupRequest.signal));
});

test('复制中磁盘写满留下未完成目录，源与已完成归档不受损', async t => {
  const f = await setup(t), sourceBytes = new Map<string, Buffer>();
  for (const name of await readdir(f.root.objects.path)) sourceBytes.set(name, await readFile(path.join(f.root.objects.path, name)));
  await assert.rejects(f.api.createArchiveBackup({ ...f.backupRequest, copy: async (_root, _name, _expected, handle) => {
    await handle.write(Buffer.from('部分复制')); throw Object.assign(new Error('合成磁盘写满'), { code: 'ENOSPC' });
  } }));
  const root = { ...await authorizeSourceDirectory(path.join(f.destination.path, f.backupRequest.id)), id: randomUUID() };
  await assert.rejects(f.api.verifyArchiveBackup(root, f.backupRequest.signal));
  assert.ok(!(await readdir(root.path)).includes('Complete.json'));
  for (const [name, bytes] of sourceBytes) assert.deepEqual(await readFile(path.join(f.root.objects.path, name)), bytes);
  assert.equal(f.repository.archive.operation(f.archiveRequest.commandId)?.phase, 'FINALIZED');
});

test('多个操作共享内容只备份一次，SQLite 照片和库存随快照保留', async t => {
  const f = await setup(t);
  const receipt = f.repository.receive({ commandId: randomUUID(), model: { brand: '合成', name: '照片快照', edition: '一', year: 1990, format: 'cassette', tapeType: 'II', identification: 'verified' }, lengthMinutes: 90, quantities: { sealedBlank: 1, openedBlank: 0, legacyUsed: 0, unclassified: 0 } });
  const image = { dataUrl: 'data:image/jpeg;base64,/9j/2Q==', width: 1, height: 1 };
  f.repository.addPhoto({ commandId: randomUUID(), modelId: receipt.modelId, image });
  await f.archive.start({ ...f.archiveRequest, commandId: randomUUID() }); await f.archive.idle();
  const result = await f.api.createArchiveBackup(f.backupRequest);
  const manifest = await f.api.verifyArchiveBackup(result.directory, f.backupRequest.signal);
  assert.equal(manifest.operations.length, 2);
  assert.equal((await readdir(path.join(result.directory.path, 'objects'))).length, manifest.objects.length);
  const db = new DatabaseSync(path.join(result.directory.path, 'database', 'collection.sqlite'), { readOnly: true });
  try {
    assert.ok(Number(db.prepare('SELECT count(*) n FROM archive_references').get()?.n) > manifest.objects.length);
    assert.deepEqual(Buffer.from(db.prepare('SELECT content FROM collection_photos WHERE model_id=?').get(receipt.modelId)!.content as Uint8Array), Buffer.from('/9j/2Q==', 'base64'));
  } finally { db.close(); }
});

test('备份复制期间撤权拒绝发布；未完成包不被当作可恢复备份', async t => {
  const f = await setup(t);
  const { copyReadonlySource } = await import('../src/recording/source-files.js');
  await assert.rejects(f.api.createArchiveBackup({ ...f.backupRequest, copy: async (...args) => {
    const copied = await copyReadonlySource(...args); f.repository.archive.revokeRoot(f.root.id); return copied;
  } }));
  const root = { ...await authorizeSourceDirectory(path.join(f.destination.path, f.backupRequest.id)), id: randomUUID() };
  await assert.rejects(f.api.verifyArchiveBackup(root, f.backupRequest.signal));
  assert.ok(!(await readdir(root.path)).includes('Complete.json'));
});

test('备份元数据摘要在读取前执行较小的大小上限', async t => {
  const f = await setup(t);
  const { hashBackupFile } = await import('../src/recording/backup-files.js');
  await writeFile(path.join(f.destination.path, 'oversize.json'), 'x'.repeat(4096));
  await assert.rejects(hashBackupFile(f.destination, 'oversize.json', f.backupRequest.signal, 1024));
});
