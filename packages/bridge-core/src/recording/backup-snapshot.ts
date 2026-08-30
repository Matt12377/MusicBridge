import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import type { RootCapability } from './source-files.js';
import { backupFail, checkBackupRoot, hashBackupFile, syncBackupRoot, type BackupFile } from './backup-files.js';

export interface CollectionSnapshot extends BackupFile { schemaVersion: number; pages: number }
/** 调用方须在整个异步备份期间持有源连接；只向空的已授权目标目录写入。 */
export async function createCollectionSnapshot(db: DatabaseSync, destination: RootCapability): Promise<CollectionSnapshot> {
  await checkBackupRoot(destination);
  if ((await readdir(destination.path)).length) backupFail('BACKUP_DESTINATION_INVALID');
  const absolute = path.join(destination.path, 'collection.sqlite');
  const reserved = await open(absolute, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const identity = await reserved.stat({ bigint: true }); await checkBackupRoot(destination);
    // Backup API 会覆盖目标，故上面必须先排他创建，不能接收现有用户文件。
    const pages = await backup(db, absolute);
    const current = await lstat(absolute, { bigint: true });
    if (!current.isFile() || current.nlink !== 1n || current.ino !== identity.ino || current.dev !== identity.dev) backupFail();
    const snapshot = new DatabaseSync(absolute, { allowExtension: false });
    let schemaVersion: number;
    try {
      snapshot.exec('PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
      if (snapshot.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' || snapshot.prepare('PRAGMA foreign_key_check').all().length) backupFail();
      schemaVersion = Number(snapshot.prepare('PRAGMA user_version').get()?.user_version);
    } finally { snapshot.close(); }
    await reserved.sync(); await syncBackupRoot(destination);
    return { ...await hashBackupFile(destination, 'collection.sqlite'), schemaVersion, pages };
  } finally { await reserved.close(); }
}
