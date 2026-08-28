import { constants } from 'node:fs';
import { lstat, open, readdir, statfs } from 'node:fs/promises';
import path from 'node:path';
import { isCollectionId } from '@music-bridge/contracts';
import { archiveDigest, previewArchiveRoot } from './archive-files.js';
import { authorizeSourceDirectory, copyReadonlySource, type RootCapability } from './source-files.js';
import { verifyArchiveBackup, type ArchiveBackupManifest } from './backup-package.js';
import { BackupError, backupFail, checkBackupRoot, createBackupDirectory, hashBackupFile, readBackupText, syncBackupRoot, writeBackupText, type BackupFile } from './backup-files.js';
import { readBackupIndex, type BackupIndex } from './backup-index.js';
import { isolateRestoredDatabase, verifyRestoredDatabaseIsolation } from './restore-database.js';

export interface RestoredArchiveManifest extends BackupIndex {
  schemaVersion: 1; kind: 'musicbridge-isolated-restore'; id: string; state: 'isolated-pending-activation';
  sourceBackupId: string; sourceManifestHash: string; mode: ArchiveBackupManifest['mode']; contentIncluded: boolean;
  database: BackupFile; originalDatabase: BackupFile;
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
async function child(root: RootCapability, name: string): Promise<RootCapability> {
  await checkBackupRoot(root); const absolute = path.join(root.path, name), result = { ...await authorizeSourceDirectory(absolute), id: root.id };
  if (result.path !== absolute) backupFail(); return result;
}
async function verify(directory: RootCapability, signal: AbortSignal, complete: boolean): Promise<RestoredArchiveManifest> {
  const text = await readBackupText(directory, 'Restore.json', 32 * 1024 * 1024, signal), manifest = JSON.parse(text) as RestoredArchiveManifest;
  if (!same(Object.keys(manifest).sort(), ['schemaVersion','kind','id','state','sourceBackupId','sourceManifestHash','mode','contentIncluded','database','originalDatabase','operations','objects','incompleteOperationIds'].sort()) || manifest.schemaVersion !== 1 || manifest.kind !== 'musicbridge-isolated-restore' || manifest.state !== 'isolated-pending-activation' || !isCollectionId(manifest.id) || !isCollectionId(manifest.sourceBackupId) || !/^[a-f0-9]{64}$/u.test(manifest.sourceManifestHash) || !['metadata','archive-content'].includes(manifest.mode) || manifest.contentIncluded !== (manifest.mode === 'archive-content')) backupFail();
  const original = manifest.originalDatabase;
  if (!original || Object.keys(original).sort().join(',') !== 'relative,sha256,size' || original.relative !== 'collection.sqlite' || typeof original.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(original.sha256) || !Number.isSafeInteger(original.size) || original.size < 1 || original.size > 68_719_476_736) backupFail();
  if (complete && !same(JSON.parse(await readBackupText(directory, 'RestoreComplete.json', 1024, signal)), { schemaVersion: 1, id: manifest.id, manifestHash: archiveDigest(text) })) backupFail();
  const database = await child(directory, 'database');
  if (!same((await readdir(database.path)).sort(), ['collection.sqlite'])) backupFail();
  const fingerprint = await hashBackupFile(database, 'collection.sqlite', signal);
  if (!same(fingerprint, manifest.database)) backupFail();
  const absolute = path.join(database.path, 'collection.sqlite'), { index } = readBackupIndex(absolute);
  verifyRestoredDatabaseIsolation(absolute);
  if (!same(index, { operations: manifest.operations, objects: manifest.objects, incompleteOperationIds: manifest.incompleteOperationIds }) || manifest.contentIncluded && index.incompleteOperationIds.length) backupFail();
  if (!same(await hashBackupFile(database, 'collection.sqlite', signal), fingerprint)) backupFail();
  const manifests = await child(directory, 'manifests'), objects = await child(directory, 'objects');
  if (!same((await readdir(manifests.path)).sort(), index.operations.map(op => `${op.operationId}.json`).sort())) backupFail();
  for (const op of index.operations) {
    const file = await hashBackupFile(manifests, `${op.operationId}.json`, signal, 4 * 1024 * 1024);
    if (file.sha256 !== op.manifestHash || file.size !== op.manifestSize) backupFail();
  }
  const expected = manifest.contentIncluded ? index.objects : [];
  if (!same((await readdir(objects.path)).sort(), expected.map(o => o.sha256).sort())) backupFail();
  for (const object of expected) { const file = await hashBackupFile(objects, object.sha256, signal); if (file.sha256 !== object.sha256 || file.size !== object.size) backupFail(); }
  signal.throwIfAborted(); return manifest;
}
export async function verifyRestoredArchive(directory: RootCapability, signal: AbortSignal): Promise<RestoredArchiveManifest> {
  try { return await verify(directory, signal, true); }
  catch (error) { if (signal.aborted) throw signal.reason; if (error instanceof BackupError) throw error; return backupFail(); }
}
export interface RestoreArchiveOptions {
  backup: RootCapability; destination: RootCapability; protectedRoots: readonly RootCapability[];
  id: string; userConfirmed: boolean; signal: AbortSignal; copy?: typeof copyReadonlySource;
}
/** 恢复收据仅证明隔离候选，不能据此切换当前 Runtime 或恢复历史目录权限。 */
export async function restoreArchiveBackup(options: RestoreArchiveOptions): Promise<{ directory: RootCapability; manifest: RestoredArchiveManifest }> {
  const { backup, destination, id, signal } = options;
  try {
    signal.throwIfAborted();
    if (options.userConfirmed !== true || !isCollectionId(id) || !Array.isArray(options.protectedRoots)) backupFail('BACKUP_DESTINATION_INVALID');
    await checkBackupRoot(destination); await previewArchiveRoot(destination.path, [backup, ...options.protectedRoots]);
    const original = await verifyArchiveBackup(backup, signal), sourceText = await readBackupText(backup, 'Backup.json', 32 * 1024 * 1024, signal);
    if (!same(JSON.parse(sourceText), original)) backupFail();
    const sourceManifestHash = archiveDigest(sourceText), absolute = path.join(destination.path, id);
    const existing = await lstat(absolute).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
    if (existing) {
      if (!existing.isDirectory() || existing.isSymbolicLink()) backupFail('BACKUP_DESTINATION_INVALID');
      const directory = await child(destination, id), manifest = await verifyRestoredArchive(directory, signal);
      if (manifest.id !== id || manifest.sourceBackupId !== original.id || manifest.sourceManifestHash !== sourceManifestHash) backupFail();
      return { directory, manifest };
    }
    const bytes = original.database.size + (original.contentIncluded ? original.objects.reduce((n, o) => n + o.size, 0) : 0);
    const space = await statfs(destination.path, { bigint: true });
    if (!Number.isSafeInteger(bytes) || space.bavail * space.bsize < BigInt(bytes) + 16_777_216n) backupFail('BACKUP_IO_ERROR');
    const directory = await createBackupDirectory(destination, id), database = await createBackupDirectory(directory, 'database'), manifests = await createBackupDirectory(directory, 'manifests'), objects = await createBackupDirectory(directory, 'objects');
    const copy = async (source: RootCapability, target: RootCapability, file: BackupFile): Promise<void> => {
      signal.throwIfAborted(); await checkBackupRoot(target);
      const handle = await open(path.join(target.path, file.relative), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      try { await (options.copy ?? copyReadonlySource)(source, file.relative, file, handle, signal); }
      finally { await handle.close(); }
    };
    await copy(await child(backup, 'database'), database, original.database);
    const sourceManifests = await child(backup, 'manifests'), sourceObjects = await child(backup, 'objects');
    for (const op of original.operations) await copy(sourceManifests, manifests, { relative: `${op.operationId}.json`, sha256: op.manifestHash, size: op.manifestSize });
    if (original.contentIncluded) for (const object of original.objects) await copy(sourceObjects, objects, { relative: object.sha256, sha256: object.sha256, size: object.size });
    signal.throwIfAborted(); await checkBackupRoot(database);
    const dbPath = path.join(database.path, 'collection.sqlite'); isolateRestoredDatabase(dbPath);
    const dbHandle = await open(dbPath, constants.O_RDONLY | constants.O_NOFOLLOW); try { await dbHandle.sync(); } finally { await dbHandle.close(); }
    await syncBackupRoot(database); await syncBackupRoot(manifests); await syncBackupRoot(objects);
    const manifest: RestoredArchiveManifest = { schemaVersion: 1, kind: 'musicbridge-isolated-restore', id, state: 'isolated-pending-activation', sourceBackupId: original.id, sourceManifestHash, mode: original.mode, contentIncluded: original.contentIncluded, database: await hashBackupFile(database, 'collection.sqlite', signal), originalDatabase: original.database, ...readBackupIndex(dbPath).index };
    const encoded = JSON.stringify(manifest, null, 2) + '\n';
    if (Buffer.byteLength(encoded) > 32 * 1024 * 1024) backupFail();
    await writeBackupText(directory, 'Restore.json', encoded); await verify(directory, signal, false);
    if (!same(await verifyArchiveBackup(backup, signal), original)) backupFail();
    signal.throwIfAborted(); await checkBackupRoot(destination);
    await writeBackupText(directory, 'RestoreComplete.json', JSON.stringify({ schemaVersion: 1, id, manifestHash: archiveDigest(encoded) }) + '\n');
    return { directory, manifest };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof BackupError) throw error;
    return backupFail('BACKUP_IO_ERROR');
  }
}
