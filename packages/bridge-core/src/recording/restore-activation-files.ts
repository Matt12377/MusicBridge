import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isCollectionId } from '@music-bridge/contracts';
import { archiveDigest, previewArchiveRoot } from './archive-files.js';
import { authorizeSourceDirectory, copyReadonlySource, type RootCapability } from './source-files.js';
import { BackupError, backupFail, checkBackupRoot, createBackupDirectory, hashBackupFile, readBackupText, syncBackupRoot, writeBackupText, type BackupFile } from './backup-files.js';
import { verifyRestoredArchive } from './restore-package.js';
import { verifyRestoredDatabaseIsolation } from './restore-database.js';

/** 私有能力记录，仅由独立维护账本持有，不进入 Renderer 合同。 */
export interface PreparedRestoredDataset {
  id: string;
  directory: RootCapability;
  database: RootCapability;
  databaseFile: BackupFile;
  source: RootCapability;
  restoreId: string;
  restoreManifestHash: string;
  contentIncluded: boolean;
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const marker = (value: PreparedRestoredDataset) => ({ schemaVersion: 1, kind: 'musicbridge-restored-dataset', id: value.id, restoreId: value.restoreId, restoreManifestHash: value.restoreManifestHash, contentIncluded: value.contentIncluded, database: value.databaseFile });

/** 只在首次启动前检查原始数据库指纹；激活后的数据库允许正常业务写入。 */
export async function verifyPreparedDataset(value: PreparedRestoredDataset, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (!isCollectionId(value.id) || !isCollectionId(value.restoreId) || value.database.path !== path.join(value.directory.path, 'database')) backupFail();
  await checkBackupRoot(value.directory); await checkBackupRoot(value.database);
  const encoded = await readBackupText(value.directory, 'Activation.json', 4096, signal);
  if (!same(JSON.parse(encoded), marker(value)) || !same(JSON.parse(await readBackupText(value.directory, 'ActivationComplete.json', 1024, signal)), { schemaVersion: 1, id: value.id, manifestHash: archiveDigest(encoded) })) backupFail();
  const restored = await verifyRestoredArchive(value.source, signal);
  if (restored.id !== value.restoreId || restored.contentIncluded !== value.contentIncluded || archiveDigest(await readBackupText(value.source, 'Restore.json', 32 * 1024 * 1024, signal)) !== value.restoreManifestHash || !same(restored.database, value.databaseFile)) backupFail();
  if (!same((await readdir(value.database.path)).sort(), ['collection.sqlite']) || !same(await hashBackupFile(value.database, 'collection.sqlite', signal), value.databaseFile)) backupFail();
  verifyRestoredDatabaseIsolation(path.join(value.database.path, 'collection.sqlite'));
  if (!same(await hashBackupFile(value.database, 'collection.sqlite', signal), value.databaseFile)) backupFail();
}

/** 保留恢复包和旧工作库，目标只允许在应用私有根下排他创建新的工作库。 */
export async function prepareRestoredDataset(options: {
  id: string; source: RootCapability; destination: RootCapability; userConfirmed: boolean; signal: AbortSignal;
  copy?: typeof copyReadonlySource;
}): Promise<PreparedRestoredDataset> {
  const { id, source, destination, signal } = options;
  const check = async (...roots: readonly RootCapability[]): Promise<void> => {
    signal.throwIfAborted();
    for (const root of roots) { await checkBackupRoot(root); signal.throwIfAborted(); }
  };
  try {
    signal.throwIfAborted();
    if (options.userConfirmed !== true || !isCollectionId(id)) backupFail('BACKUP_DESTINATION_INVALID');
    await check(destination, source); await previewArchiveRoot(destination.path, [source]);
    const manifest = await verifyRestoredArchive(source, signal);
    const sourceText = await readBackupText(source, 'Restore.json', 32 * 1024 * 1024, signal);
    if (!same(JSON.parse(sourceText), manifest)) backupFail();
    await check(source);
    const sourceDatabase = { ...await authorizeSourceDirectory(path.join(source.path, 'database')), id };
    if (sourceDatabase.path !== path.join(source.path, 'database')) backupFail();
    await check(destination, source);
    const directory = await createBackupDirectory(destination, id), database = await createBackupDirectory(directory, 'database');
    await check(destination, directory, database, source, sourceDatabase);
    const output = await open(path.join(database.path, 'collection.sqlite'), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try {
      await check(destination, directory, database, source, sourceDatabase);
      await (options.copy ?? copyReadonlySource)(sourceDatabase, 'collection.sqlite', manifest.database, output, signal);
    } finally { await output.close(); }
    // 子目录 inode 不足以证明目标父根仍获授权，复制后的每个发布阶段都重核父根。
    await check(destination, directory, database, source, sourceDatabase);
    await syncBackupRoot(database);
    const value: PreparedRestoredDataset = { id, directory, database, databaseFile: manifest.database, source, restoreId: manifest.id, restoreManifestHash: archiveDigest(sourceText), contentIncluded: manifest.contentIncluded };
    const encoded = JSON.stringify(marker(value)) + '\n';
    await check(destination, directory, database, source);
    await writeBackupText(directory, 'Activation.json', encoded);
    const current = await verifyRestoredArchive(source, signal);
    if (!same(current, manifest) || !same(await hashBackupFile(database, 'collection.sqlite', signal), manifest.database)) backupFail();
    await check(destination, directory, database, source);
    await writeBackupText(directory, 'ActivationComplete.json', JSON.stringify({ schemaVersion: 1, id, manifestHash: archiveDigest(encoded) }) + '\n');
    return value;
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof BackupError) throw error;
    return backupFail('BACKUP_IO_ERROR');
  }
}
