import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { archiveBackupFixture } from './helpers/archive-backup-fixture.js';
import { authorizeSourceDirectory } from '../src/recording/source-files.js';
import { createCollectionRepository } from '../src/collection/repository.js';

async function setup(t: test.TestContext, mode: 'archive-content' | 'metadata' = 'archive-content', prepared = false) {
  const f = await archiveBackupFixture(t, prepared), backup = await f.api.createArchiveBackup({ ...f.backupRequest, mode });
  const target = path.join(f.directory, '恢复候选'); await mkdir(target);
  const destination = { ...await authorizeSourceDirectory(target), id: randomUUID() };
  const api = await import('../src/recording/restore-package.js').catch(() => ({}));
  assert.ok('restoreArchiveBackup' in api && 'verifyRestoredArchive' in api, '隔离恢复尚无生产接口');
  return { ...f, backup, restoreApi: api as typeof import('../src/recording/restore-package.js'), restoreRequest: { backup: backup.directory, destination, protectedRoots: [...f.repository.sources.roots(), ...f.repository.preparations.destinations(), f.root.root], id: randomUUID(), userConfirmed: true, signal: new AbortController().signal } };
}

test('完整备份恢复成隔离候选，旧目录权限撤销而库存和版本关系不改写', async t => {
  const f = await setup(t), original = await readFile(f.filePath);
  const restored = await f.restoreApi.restoreArchiveBackup(f.restoreRequest);
  const verified = await f.restoreApi.verifyRestoredArchive(restored.directory, f.restoreRequest.signal);
  assert.equal(verified.state, 'isolated-pending-activation'); assert.equal(verified.contentIncluded, true);
  const repository = createCollectionRepository({ filePath: path.join(restored.directory.path, 'database', 'collection.sqlite') });
  try {
    assert.equal(repository.list({ offset: 0, limit: 100 }).total, f.repository.list({ offset: 0, limit: 100 }).total);
    assert.deepEqual(repository.versions.list(f.draft.draftId), f.repository.versions.list(f.draft.draftId));
    assert.ok(repository.sources.roots().every(r => r.authorized === false));
    assert.ok(repository.preparations.destinations().every(r => r.authorized === false));
    assert.throws(() => repository.archive.root(f.root.id));
    assert.ok(repository.archive.candidates().every(r => r.authorized === false));
  } finally { repository.close(); }
  assert.deepEqual(await readFile(f.filePath), original);
  assert.equal((await f.api.verifyArchiveBackup(f.backup.directory, f.restoreRequest.signal)).id, f.backup.manifest.id);
});

test('恢复回执重复返回同一候选，候选库新写入后重试显式冲突且不覆盖新数据', async t => {
  const f = await setup(t), first = await f.restoreApi.restoreArchiveBackup(f.restoreRequest);
  assert.equal((await f.restoreApi.restoreArchiveBackup(f.restoreRequest)).directory.path, first.directory.path);
  const database = path.join(first.directory.path, 'database', 'collection.sqlite'), db = new DatabaseSync(database);
  db.exec('PRAGMA user_version=99'); db.close(); const before = await readFile(database);
  await assert.rejects(f.restoreApi.restoreArchiveBackup(f.restoreRequest));
  assert.deepEqual(await readFile(database), before);
});

test('元数据恢复不声明音频可用，原归档不在线仍可查看恢复候选', async t => {
  const f = await setup(t, 'metadata'); await rm(f.root.root.path, { recursive: true });
  const result = await f.restoreApi.restoreArchiveBackup(f.restoreRequest);
  assert.equal(result.manifest.contentIncluded, false);
  assert.deepEqual(await readdir(path.join(result.directory.path, 'objects')), []);
  assert.equal((await f.restoreApi.verifyRestoredArchive(result.directory, f.restoreRequest.signal)).state, 'isolated-pending-activation');
});

test('未确认、重叠目标或损坏备份拒绝恢复，不写入已有用户文件', async t => {
  const f = await setup(t);
  await assert.rejects(f.restoreApi.restoreArchiveBackup({ ...f.restoreRequest, userConfirmed: false }));
  assert.deepEqual(await readdir(f.restoreRequest.destination.path), []);
  await assert.rejects(f.restoreApi.restoreArchiveBackup({ ...f.restoreRequest, destination: f.backup.directory }));
  await writeFile(path.join(f.backup.directory.path, 'Backup.json'), '{}');
  await assert.rejects(f.restoreApi.restoreArchiveBackup(f.restoreRequest));
  assert.deepEqual(await readdir(f.restoreRequest.destination.path), []);
});

test('恢复复制中断无完成收据，源备份保持完整', async t => {
  const f = await setup(t);
  await assert.rejects(f.restoreApi.restoreArchiveBackup({ ...f.restoreRequest, copy: async (_root, _name, _file, handle) => {
    await handle.write(Buffer.from('部分恢复')); throw new Error('合成磁盘写满');
  } }));
  const target = path.join(f.restoreRequest.destination.path, f.restoreRequest.id);
  assert.ok(!(await readdir(target)).includes('RestoreComplete.json'));
  await f.api.verifyArchiveBackup(f.backup.directory, f.restoreRequest.signal);
});

async function indexApi() {
  const api = await import('../src/recording/restore-index.js').catch(() => ({}));
  assert.ok('rebuildArchiveIndex' in api, 'Manifest 索引重建未实现');
  return api as typeof import('../src/recording/restore-index.js');
}

test('无数据库时从 Manifest 重建基本索引，重复检查不改文件、不伪造完成或库存', async t => {
  const f = await setup(t), api = await indexApi();
  await rm(path.join(f.backup.directory.path, 'database'), { recursive: true }); await rm(path.join(f.backup.directory.path, 'Backup.json'));
  const before = await readdir(f.backup.directory.path), request = { directory: f.backup.directory, signal: f.restoreRequest.signal };
  const index = await api.rebuildArchiveIndex(request);
  assert.equal(index.state, 'needs-review'); assert.equal(index.historyTrusted, false); assert.equal(index.inventoryReconstructed, false);
  assert.equal(index.operations.length, 1); assert.equal(index.operations[0]!.state, 'bytes-verified-history-unverified');
  assert.ok(index.missingFacts.includes('physical-recording-completion'));
  assert.deepEqual(await api.rebuildArchiveIndex(request), index);
  assert.deepEqual(await readdir(f.backup.directory.path), before);
});

for (const fault of ['missing','changed'] as const) {
  test(`Manifest 索引标记 ${fault} 为 Quarantine 问题，不删除或改写共享对象`, async t => {
    const f = await setup(t), api = await indexApi(), object = f.backup.manifest.objects[0]!;
    const absolute = path.join(f.backup.directory.path, 'objects', object.sha256);
    if (fault === 'missing') await rm(absolute); else await writeFile(absolute, '合成损坏');
    const index = await api.rebuildArchiveIndex({ directory: f.backup.directory, signal: f.restoreRequest.signal });
    assert.equal(index.operations[0]!.state, 'quarantined');
    assert.ok(index.issues.some(i => i.sha256 === object.sha256 && i.code === (fault === 'missing' ? 'OBJECT_MISSING' : 'OBJECT_INVALID')));
    if (fault === 'changed') assert.equal(await readFile(absolute, 'utf8'), '合成损坏');
  });
}

test('Manifest 不合法或曲目引用越界不成为基本索引，取消不被吞为普通损坏', async t => {
  const f = await setup(t), api = await indexApi(), op = f.backup.manifest.operations[0]!;
  const absolute = path.join(f.backup.directory.path, 'manifests', op.operationId + '.json');
  const value = JSON.parse(await readFile(absolute, 'utf8')); value.files[0].name = '../../越界文件';
  await writeFile(absolute, JSON.stringify(value));
  const index = await api.rebuildArchiveIndex({ directory: f.backup.directory, signal: f.restoreRequest.signal });
  assert.equal(index.operations.length, 0); assert.equal(index.issues[0]?.code, 'MANIFEST_INVALID');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(api.rebuildArchiveIndex({ directory: f.backup.directory, signal: controller.signal }));
});

test('原生 Archive Root 的 Operations Manifest 也可重建基本索引，不依赖备份包', async t => {
  const f = await setup(t), api = await indexApi();
  const index = await api.rebuildArchiveIndex({ archive: f.root, signal: f.restoreRequest.signal });
  assert.equal(index.operations.length, 1);
  assert.equal(index.operations[0]!.operationId, f.archiveRequest.commandId);
  assert.equal(index.operations[0]!.state, 'bytes-verified-history-unverified');
  assert.equal(index.historyTrusted, false);
});

test('恢复收据不能用重算 Hash 掩盖无效的原数据库描述', async t => {
  const f = await setup(t), result = await f.restoreApi.restoreArchiveBackup(f.restoreRequest);
  const { archiveDigest } = await import('../src/recording/archive-files.js');
  const manifest = { ...result.manifest, originalDatabase: { relative: '../../越界', sha256: '假的', size: -1 } };
  const text = JSON.stringify(manifest, null, 2) + '\n';
  await writeFile(path.join(result.directory.path, 'Restore.json'), text);
  await writeFile(path.join(result.directory.path, 'RestoreComplete.json'), JSON.stringify({ schemaVersion: 1, id: manifest.id, manifestHash: archiveDigest(text) }) + '\n');
  await assert.rejects(f.restoreApi.verifyRestoredArchive(result.directory, f.restoreRequest.signal));
});


test('PREP 原 Render 与冻结版本随隔离恢复保留，临时导入根权限不继承', async t => {
  const f = await setup(t, 'archive-content', true);
  const result = await f.restoreApi.restoreArchiveBackup(f.restoreRequest);
  const source = new DatabaseSync(f.filePath, { readOnly: true }), restored = new DatabaseSync(path.join(result.directory.path, 'database', 'collection.sqlite'), { readOnly: true });
  try {
    const before = source.prepare('SELECT data FROM prepared_versions ORDER BY id').all(); assert.equal(before.length, 1);
    assert.deepEqual(restored.prepare('SELECT data FROM prepared_versions ORDER BY id').all(), before);
    assert.deepEqual(restored.prepare('SELECT data FROM execution_assets ORDER BY id').all(), source.prepare('SELECT data FROM execution_assets ORDER BY id').all());
    assert.equal(restored.prepare("SELECT count(*) n FROM prepared_selections WHERE json_extract(data,'$.root.authorized')<>0").get()?.n, 0);
    assert.ok(result.manifest.objects.length >= 5);
  } finally { source.close(); restored.close(); }
});

test('恢复前已取消不创建目录或激活收据', async t => {
  const f = await setup(t), controller = new AbortController(); controller.abort();
  await assert.rejects(f.restoreApi.restoreArchiveBackup({ ...f.restoreRequest, signal: controller.signal }));
  assert.deepEqual(await readdir(f.restoreRequest.destination.path), []);
});

test('快照中未结束的后台任务恢复为中断，不改源库的故障现场', async t => {
  const f = await setup(t), source = new DatabaseSync(f.filePath);
  try {
    source.exec("UPDATE source_jobs SET data=json_set(data,'$.public.state','running')");
    assert.ok(Number(source.prepare("SELECT count(*) n FROM source_jobs WHERE json_extract(data,'$.public.state')='running'").get()?.n) > 0);
    const backup = await f.api.createArchiveBackup({ ...f.backupRequest, id: randomUUID() });
    const result = await f.restoreApi.restoreArchiveBackup({ ...f.restoreRequest, backup: backup.directory });
    const restored = new DatabaseSync(path.join(result.directory.path, 'database', 'collection.sqlite'), { readOnly: true });
    try {
      assert.equal(restored.prepare("SELECT count(*) n FROM source_jobs WHERE json_extract(data,'$.public.state')='running'").get()?.n, 0);
      assert.ok(Number(restored.prepare("SELECT count(*) n FROM source_jobs WHERE json_extract(data,'$.public.state')='interrupted'").get()?.n) > 0);
      assert.ok(Number(source.prepare("SELECT count(*) n FROM source_jobs WHERE json_extract(data,'$.public.state')='running'").get()?.n) > 0);
    } finally { restored.close(); }
  } finally { source.close(); }
});
