import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { authorizeSourceDirectory } from '../src/recording/source-files.js';
import { createArchiveBackupZip, authorizeArchiveBackupZipFile, inspectArchiveBackupZip, restoreArchiveBackupZip, verifyArchiveBackupZip } from '../src/recording/backup-zip.js';
import { verifyRestoredArchive } from '../src/recording/restore-package.js';
import { writeVerifiedZip, type ZipEntrySource } from '../src/recording/verified-zip.js';
import { archiveDigest } from '../src/recording/archive-files.js';
import { archiveBackupFixture } from './helpers/archive-backup-fixture.js';

const signal = (): AbortSignal => new AbortController().signal;
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const source = (name: string, bytes: Buffer): ZipEntrySource => ({ name, kind: 'file', size: bytes.length, sha256: sha(bytes), open: async () => Readable.from([bytes]) });
async function privateRoot(directory: string) {
  const absolute = path.join(directory, 'zip-private'); await mkdir(absolute);
  return { ...await authorizeSourceDirectory(absolute), id: randomUUID() };
}

test('真实目录包生成独占 ZIP，重验后只读导入隔离候选且不触碰活动数据库', async t => {
  const f = await archiveBackupFixture(t), packageResult = await f.api.createArchiveBackup(f.backupRequest);
  const before = f.repository.archive.operations(), scratch = await privateRoot(f.directory);
  const zip = await createArchiveBackupZip({ packageDirectory: packageResult.directory, destination: f.destination, id: packageResult.manifest.id, userConfirmed: true, signal: signal() });
  const filename = `MusicBridge-Backup-${packageResult.manifest.id}.zip`;
  assert.equal(zip.file.name, filename);
  assert.equal(zip.receipt.sha256, (await verifyArchiveBackupZip(zip.file, scratch, signal())).receipt.sha256);
  assert.deepEqual(await readdir(scratch.path), [], '语义核验只允许短暂存放自己创建的 SQLite 副本');
  assert.equal((await stat(path.join(f.destination.path, filename))).nlink, 1);
  assert.deepEqual((await readdir(f.destination.path)).filter(name => name.endsWith('.partial')), []);
  const bytes = await readFile(path.join(f.destination.path, filename));
  const destinationPath = path.join(f.directory, 'ZIP隔离恢复'); await mkdir(destinationPath);
  const destination = { ...await authorizeSourceDirectory(destinationPath), id: randomUUID() };
  const restored = await restoreArchiveBackupZip({ file: zip.file, destination, protectedRoots: [], id: randomUUID(), userConfirmed: true, signal: signal(), expectedBackupIdentity: { id: packageResult.manifest.id, manifestHash: (await verifyArchiveBackupZip(zip.file, scratch, signal())).manifestHash } });
  assert.deepEqual(await verifyRestoredArchive(restored.directory, signal()), restored.manifest);
  assert.equal(restored.manifest.sourceBackupId, packageResult.manifest.id);
  assert.equal(restored.manifest.state, 'isolated-pending-activation');
  assert.equal((await readdir(restored.directory.path)).includes('Backup.json'), false);
  assert.equal((await readdir(restored.directory.path)).includes('Complete.json'), false);
  assert.deepEqual(await readFile(path.join(f.destination.path, filename)), bytes, '导入不得改写来源 ZIP');
  assert.deepEqual(f.repository.archive.operations(), before);
});

test('已发布 ZIP 的同 inode 临时链接先全量核验再收口；重复请求不覆盖最终文件', async t => {
  const f = await archiveBackupFixture(t), packageResult = await f.api.createArchiveBackup(f.backupRequest);
  const input = { packageDirectory: packageResult.directory, destination: f.destination, id: packageResult.manifest.id, userConfirmed: true, signal: signal() };
  const first = await createArchiveBackupZip(input);
  const final = path.join(f.destination.path, first.file.name);
  const partial = path.join(f.destination.path, `.musicbridge-backup-zip-${input.id}-${randomUUID()}.partial`);
  await link(final, partial);
  assert.equal((await stat(final)).nlink, 2);
  const recovered = await createArchiveBackupZip(input);
  assert.equal(recovered.receipt.sha256, first.receipt.sha256);
  assert.equal((await stat(final)).nlink, 1);
  assert.equal((await readdir(f.destination.path)).includes(path.basename(partial)), false);
  assert.deepEqual(await readFile(final), await readFile(path.join(f.destination.path, recovered.file.name)));
});

test('已有同名非本任务 ZIP 与损坏 ZIP 均拒绝，原始字节不覆盖', async t => {
  const f = await archiveBackupFixture(t), packageResult = await f.api.createArchiveBackup(f.backupRequest);
  const final = path.join(f.destination.path, `MusicBridge-Backup-${packageResult.manifest.id}.zip`), original = Buffer.from('用户已有 ZIP 文件');
  await writeFile(final, original);
  await assert.rejects(createArchiveBackupZip({ packageDirectory: packageResult.directory, destination: f.destination, id: packageResult.manifest.id, userConfirmed: true, signal: signal() }));
  assert.deepEqual(await readFile(final), original);
  assert.deepEqual((await readdir(f.destination.path)).filter(name => name.endsWith('.partial')), []);
  const authorized = await authorizeArchiveBackupZipFile(final), scratch = await privateRoot(f.directory);
  await assert.rejects(verifyArchiveBackupZip(authorized, scratch, signal()), { code: 'BACKUP_INVALID' });
  assert.deepEqual(await readdir(scratch.path), []);
});

test('未确认、发布前取消和独立旧 partial 均不能伪造完成回执', async t => {
  const f = await archiveBackupFixture(t), packageResult = await f.api.createArchiveBackup(f.backupRequest);
  const input = { packageDirectory: packageResult.directory, destination: f.destination, id: packageResult.manifest.id, userConfirmed: true, signal: signal() };
  await assert.rejects(createArchiveBackupZip({ ...input, userConfirmed: false }));
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(createArchiveBackupZip({ ...input, signal: cancelled.signal }));
  const stale = path.join(f.destination.path, `.musicbridge-backup-zip-${input.id}-${randomUUID()}.partial`);
  await writeFile(stale, '合成未完成字节');
  const result = await createArchiveBackupZip(input);
  assert.equal((await readdir(f.destination.path)).includes(path.basename(stale)), true, '不猜测删除旧的未完成证据');
  assert.equal(result.receipt.sha256, (await verifyArchiveBackupZip(result.file, await privateRoot(f.directory), signal())).receipt.sha256);
});

test('容器 CRC/SHA 自洽但 SQLite 引用语义损坏时，正式 ZIP 校验拒绝成功', async t => {
  const f = await archiveBackupFixture(t);
  const original = await f.api.createArchiveBackup({ ...f.backupRequest, mode: 'metadata' });
  const manifest = structuredClone(original.manifest);
  const db = Buffer.from(await readFile(path.join(original.directory.path, 'database', 'collection.sqlite')));
  db[0] = db[0]! ^ 1;
  manifest.database = { ...manifest.database, sha256: sha(db) };
  const backup = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  const complete = Buffer.from(JSON.stringify({ schemaVersion: 1, id: manifest.id, manifestHash: archiveDigest(backup) }) + '\n');
  const entries: ZipEntrySource[] = [
    { name: 'database/', kind: 'directory', size: 0 },
    { name: 'manifests/', kind: 'directory', size: 0 },
    { name: 'objects/', kind: 'directory', size: 0 },
    source('Backup.json', backup), source('Complete.json', complete), source('database/collection.sqlite', db),
  ];
  for (const operation of manifest.operations) {
    const bytes = await readFile(path.join(original.directory.path, 'manifests', `${operation.operationId}.json`));
    entries.push(source(`manifests/${operation.operationId}.json`, bytes));
  }
  const total = entries.reduce((sum, entry) => sum + entry.size, 0);
  const absolute = path.join(f.destination.path, 'semantic-invalid.zip'), handle = await open(absolute, 'wx+');
  try { await writeVerifiedZip(handle, entries, { maxEntries: entries.length, maxEntryBytes: Math.max(...entries.map(entry => entry.size), 1), maxTotalBytes: total, maxArchiveBytes: total + 1024 * 1024 }, signal()); }
  finally { await handle.close(); }
  const file = await authorizeArchiveBackupZipFile(absolute), scratch = await privateRoot(f.directory);
  assert.equal((await inspectArchiveBackupZip(file, signal())).manifest.database.sha256, sha(db), 'ZIP 字节闭包本身合法');
  await assert.rejects(verifyArchiveBackupZip(file, scratch, signal()), { code: 'BACKUP_INVALID' });
  assert.deepEqual(await readdir(scratch.path), [], '拒绝后只清除本次私有 SQLite 暂存');
});
