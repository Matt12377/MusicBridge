import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { authorizeSourceDirectory, sourceRootAvailability, type RootCapability } from './source-files.js';

export class BackupError extends Error {
  constructor(readonly code: 'BACKUP_DESTINATION_INVALID' | 'BACKUP_INCOMPLETE' | 'BACKUP_INVALID' | 'BACKUP_IO_ERROR') { super(code); }
}
export interface BackupFile { relative: string; sha256: string; size: number }
export function backupFail(code: BackupError['code'] = 'BACKUP_INVALID'): never { throw new BackupError(code); }
export async function checkBackupRoot(root: RootCapability): Promise<void> {
  if (await sourceRootAvailability(root) !== 'ONLINE') backupFail('BACKUP_DESTINATION_INVALID');
}
export async function syncBackupRoot(root: RootCapability): Promise<void> {
  await checkBackupRoot(root);
  const handle = await open(root.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isDirectory() || String(info.dev) !== root.dev || String(info.ino) !== root.ino) backupFail();
    await handle.sync();
  } finally { await handle.close(); }
}
export async function createBackupDirectory(parent: RootCapability, name: string): Promise<RootCapability> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/u.test(name)) backupFail('BACKUP_DESTINATION_INVALID');
  await checkBackupRoot(parent);
  const absolute = path.join(parent.path, name);
  await mkdir(absolute, { mode: 0o700 });
  await checkBackupRoot(parent); const root = { ...await authorizeSourceDirectory(absolute), id: randomUUID() }; await syncBackupRoot(parent); return root;
}
export async function writeBackupText(root: RootCapability, name: string, text: string): Promise<BackupFile> {
  if (!/^[a-zA-Z0-9_.-]{1,100}$/u.test(name) || name === '.' || name === '..') backupFail();
  await checkBackupRoot(root);
  const handle = await open(path.join(root.path, name), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await checkBackupRoot(root); await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
  await syncBackupRoot(root);
  return { relative: name, sha256: createHash('sha256').update(text).digest('hex'), size: Buffer.byteLength(text) };
}
/** 有界流式摘要；目录/文件替换、硬链接和读取期间变化均拒绝。 */
export async function hashBackupFile(root: RootCapability, relative: string, signal?: AbortSignal, maximum = 68_719_476_736): Promise<BackupFile> {
  if (!/^[a-zA-Z0-9_.-]{1,100}$/u.test(relative) || relative === '.' || relative === '..') backupFail();
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 68_719_476_736) backupFail();
  signal?.throwIfAborted(); await checkBackupRoot(root);
  const absolute = path.join(root.path, relative), handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  const identity = (s: Awaited<ReturnType<typeof handle.stat>>): string => [s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maximum) backupFail();
    const digest = createHash('sha256'), chunk = Buffer.allocUnsafe(1024 * 1024); let offset = 0;
    while (offset < before.size) {
      signal?.throwIfAborted(); const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, before.size - offset), offset);
      if (!bytesRead) backupFail(); digest.update(chunk.subarray(0, bytesRead)); offset += bytesRead;
    }
    signal?.throwIfAborted(); await checkBackupRoot(root);
    if (identity(before) !== identity(await handle.stat()) || identity(before) !== identity(await lstat(absolute))) backupFail();
    return { relative, sha256: digest.digest('hex'), size: before.size };
  } finally { await handle.close(); }
}
