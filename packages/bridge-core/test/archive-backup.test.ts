import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, rm, writeFile, mkdtemp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { CanonicalReference } from '@music-bridge/contracts';
import { DatabaseSync } from 'node:sqlite';
import { authorizeSourceDirectory } from '../src/recording/source-files.js';
import { archiveDigest } from '../src/recording/archive-files.js';
import { archiveBackupFixture as setup } from './helpers/archive-backup-fixture.js';
import { createCollectionRepository } from '../src/collection/repository.js';
import { readBackupIndex } from '../src/recording/backup-index.js';
import { isolateRestoredDatabase, verifyRestoredDatabaseIsolation } from '../src/recording/restore-database.js';

test('固定旧schema14仍可校验，目录schema15迁移后快照与隔离恢复保留库存事实', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-catalog-backup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'collection.sqlite');
  const seed = new DatabaseSync(filePath);
  try { seed.exec(await readFile(new URL('./fixtures/collection-schema14.sql', import.meta.url), 'utf8')); assert.equal(seed.prepare('PRAGMA user_version').get()?.user_version, 14); }
  finally { seed.close(); }
  const before = await readFile(filePath);
  assert.deepEqual(readBackupIndex(filePath).index, { operations: [], objects: [], incompleteOperationIds: [] });
  assert.deepEqual(await readFile(filePath), before, '只读验证旧备份不得迁移或修改原件');
  const inspect = () => {
    const db = new DatabaseSync(filePath, { readOnly: true });
    try { return { version: db.prepare('PRAGMA user_version').get()?.user_version, ledger: db.prepare('SELECT * FROM inventory_ledger ORDER BY command_id').all(), copies: db.prepare('SELECT * FROM physical_copies ORDER BY physical_id').all(), lots: db.prepare('SELECT * FROM inventory_lots ORDER BY id').all(), photos: db.prepare('SELECT * FROM collection_photos ORDER BY id').all() }; }
    finally { db.close(); }
  };
  const original = inspect(), repository = createCollectionRepository({ filePath });
  try { repository.list({ offset: 0, limit: 20 }); } finally { repository.close(); }
  assert.equal(inspect().version, 15, '目录schema必须由正式迁移创建');
  assert.deepEqual(readBackupIndex(filePath).index, { operations: [], objects: [], incompleteOperationIds: [] });
  isolateRestoredDatabase(filePath); verifyRestoredDatabaseIsolation(filePath);
  assert.deepEqual(inspect(), { ...original, version: 15 });
});


test('含参考资料与历史拥有快照的真实数据库备份可隔离恢复，原包哈希篡改拒绝', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-catalog-snapshot-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'collection.sqlite'), seed = new DatabaseSync(filePath);
  try { seed.exec(await readFile(new URL('./fixtures/collection-schema14.sql', import.meta.url), 'utf8')); } finally { seed.close(); }
  const repository = createCollectionRepository({ filePath }); t.after(() => repository.close());
  const item: CanonicalReference = { referenceId: 'synthetic-ref', bookId: 'synthetic-book', brand: '合成', series: '测试', edition: '1990', model: '合成型号', lengths: [60, 90], iec: 'II', era: '1990', image: { kind: 'none' }, pages: ['1'], notes: '', confidence: 'high' };
  const rawPack = '\uFEFF' + JSON.stringify({ schemaVersion: 1, bookId: item.bookId, title: '合成目录', sourceVersion: '1', items: [item] }) + '\r\n';
  const source = repository.catalog.registerSource({ commandId: randomUUID(), rawPack, packHash: createHash('sha256').update(rawPack).digest('hex'), userConfirmed: true });
  const previewRequest = { sourceId: source.id, expectedCurrentRevisionId: null, items: [item], mappings: [] };
  const preview = repository.catalog.previewRevision(previewRequest);
  const initial = repository.catalog.publishRevision({ ...previewRequest, commandId: randomUUID(), baselineFingerprint: preview.baselineFingerprint, userConfirmed: true });
  const matched = repository.catalog.setMatch({ commandId: randomUUID(), revisionId: initial.revision.id, expectedMatchVersion: 0, match: { referenceId: item.referenceId, modelId: repository.list({ offset: 0, limit: 20 }).items[0]!.id, status: 'confirmed', availability: 'unknown' }, userConfirmed: true });
  assert.equal(matched.currentCounts.owned, 1); assert.equal(matched.currentEntries[0]?.stockCount, 5);
  const destinationPath = path.join(directory, '快照'); await mkdir(destinationPath);
  const snapshot = await repository.backupSnapshot({ ...await authorizeSourceDirectory(destinationPath), id: randomUUID() });
  assert.equal(snapshot.schemaVersion, 15);
  const restoredPath = path.join(destinationPath, 'collection.sqlite');
  readBackupIndex(restoredPath); isolateRestoredDatabase(restoredPath); verifyRestoredDatabaseIsolation(restoredPath); readBackupIndex(restoredPath);
  const restored = createCollectionRepository({ filePath: restoredPath });
  try {
    assert.deepEqual(restored.catalog.source({ id: source.id }), { source, rawPack });
    assert.deepEqual(restored.catalog.revision({ id: initial.revision.id }), matched);
    assert.deepEqual(restored.catalog.snapshot({ id: initial.snapshot.id }), initial.snapshot);
    assert.deepEqual(restored.list({ offset: 0, limit: 20 }), repository.list({ offset: 0, limit: 20 }));
  } finally { restored.close(); }
  const damaged = new DatabaseSync(restoredPath);
  try {
    const trigger = String(damaged.prepare("SELECT sql FROM sqlite_master WHERE name='reference_sources_no_update'").get()?.sql);
    damaged.exec('DROP TRIGGER reference_sources_no_update');
    damaged.prepare('UPDATE reference_sources SET raw_pack=raw_pack || ? WHERE id=?').run(' ', source.id);
    damaged.exec(trigger);
  } finally { damaged.close(); }
  const damagedBytes = await readFile(restoredPath);
  assert.throws(() => readBackupIndex(restoredPath), /参考目录|BACKUP/u);
  assert.deepEqual(await readFile(restoredPath), damagedBytes, '只读拒绝不能修改损坏证据');
  assert.equal(repository.catalog.source({ id: source.id }).rawPack, rawPack, '恢复副本损坏不影响原工作库');
});

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
