import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, readdir, realpath, rmdir, statfs, unlink } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { isCollectionId } from '@music-bridge/contracts';
import { archiveDigest, previewArchiveRoot } from './archive-files.js';
import { authorizeSourceDirectory, type RootCapability } from './source-files.js';
import { BackupError, backupFail, checkBackupRoot, createBackupDirectory, hashBackupFile, readBackupText, syncBackupRoot, writeBackupText, type BackupFile } from './backup-files.js';
import { validateArchiveBackupManifest, verifyArchiveBackup, type ArchiveBackupManifest } from './backup-package.js';
import { readBackupIndex } from './backup-index.js';
import { isolateRestoredDatabase, verifyRestoredDatabaseIsolation } from './restore-database.js';
import { verifyRestoredArchive, type RestoredArchiveManifest } from './restore-package.js';
import { readVerifiedZipEntries, verifyVerifiedZip, writeVerifiedZip, VerifiedZipError, type ZipBudget, type ZipEntryDescription, type ZipEntrySource, type ZipReceipt } from './verified-zip.js';

const MAX_FILE = 68_719_476_736;
const MAX_TOTAL = 1_168_230_000_000;
const MAX_ENTRIES = 50_000;
const ZIP_OVERHEAD = 16 * 1024 * 1024;
const readBudget: ZipBudget = { maxEntries: MAX_ENTRIES, maxEntryBytes: MAX_FILE, maxTotalBytes: MAX_TOTAL, maxArchiveBytes: MAX_TOTAL + ZIP_OVERHEAD };
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const identity = (info: BigIntStats): string => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
const safeName = (name: string): boolean => !!name && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\') && !/[\u0000-\u001f\u007f]/u.test(name) && Buffer.byteLength(name) <= 255 && name.toLowerCase().endsWith('.zip');
const inside = (parent: string, child: string): boolean => { const relative = path.relative(parent, child); return !relative || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`); };
const digest = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
function zipFailure(error: unknown, signal: AbortSignal): never {
  if (signal.aborted) throw signal.reason;
  if (error instanceof BackupError) throw error;
  if (error instanceof VerifiedZipError) backupFail(error.code === 'CONTENT_CHANGED' ? 'BACKUP_INCOMPLETE' : 'BACKUP_INVALID');
  throw error;
}

/** 私有文件能力；不进入 Renderer，也不给 ZIP 来源目录写权限。 */
export interface ArchiveBackupZipFile {
  parent: RootCapability; name: string; dev: string; ino: string; size: number; mtimeNs: string; ctimeNs: string;
}

async function checkedZip(file: ArchiveBackupZipFile): Promise<FileHandle> {
  if (!safeName(file.name) || !/^\d+$/u.test(file.dev) || !/^\d+$/u.test(file.ino) || !/^\d+$/u.test(file.mtimeNs) || !/^\d+$/u.test(file.ctimeNs) || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > readBudget.maxArchiveBytes) backupFail();
  await checkBackupRoot(file.parent);
  const absolute = path.join(file.parent.path, file.name), named = await lstat(absolute, { bigint: true });
  if (!named.isFile() || named.nlink !== 1n || String(named.dev) !== file.dev || String(named.ino) !== file.ino || Number(named.size) !== file.size || String(named.mtimeNs) !== file.mtimeNs || String(named.ctimeNs) !== file.ctimeNs) backupFail();
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (identity(await handle.stat({ bigint: true })) !== identity(named)) backupFail();
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

export async function authorizeArchiveBackupZipFile(absolute: string): Promise<ArchiveBackupZipFile> {
  if (!path.isAbsolute(absolute) || absolute.includes('\0') || absolute.split(path.sep).some(part => part === '.' || part === '..') || !safeName(path.basename(absolute))) backupFail('BACKUP_DESTINATION_INVALID');
  const parentPath = path.dirname(absolute);
  if (await realpath(parentPath) !== parentPath) backupFail('BACKUP_DESTINATION_INVALID');
  const parent = { ...await authorizeSourceDirectory(parentPath), id: randomUUID() };
  const info = await lstat(absolute, { bigint: true });
  if (!info.isFile() || info.nlink !== 1n || info.size < 1n || info.size > BigInt(readBudget.maxArchiveBytes) || await realpath(absolute) !== absolute) backupFail('BACKUP_DESTINATION_INVALID');
  return { parent, name: path.basename(absolute), dev: String(info.dev), ino: String(info.ino), size: Number(info.size), mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs) };
}

function expectedEntries(manifest: ArchiveBackupManifest, backupText: Buffer, completeText: Buffer): ZipEntryDescription[] {
  validateArchiveBackupManifest(manifest);
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'musicbridge-archive-backup' || !isCollectionId(manifest.id) || !['metadata','archive-content'].includes(manifest.mode) || manifest.contentIncluded !== (manifest.mode === 'archive-content') || !Array.isArray(manifest.operations) || manifest.operations.length > 10_000 || !Array.isArray(manifest.objects) || manifest.objects.length > MAX_ENTRIES || !Array.isArray(manifest.incompleteOperationIds) || manifest.incompleteOperationIds.length > 10_000 || !manifest.database || manifest.database.relative !== 'collection.sqlite' || !hex(manifest.database.sha256) || !Number.isSafeInteger(manifest.database.size) || manifest.database.size < 1 || manifest.database.size > MAX_FILE) backupFail();
  if (backupText.length < 1 || backupText.length > 32 * 1024 * 1024 || completeText.length < 1 || completeText.length > 1024) backupFail();
  let complete: unknown;
  try { complete = JSON.parse(completeText.toString('utf8')); } catch { return backupFail(); }
  if (!same(complete, { schemaVersion: 1, id: manifest.id, manifestHash: digest(backupText) })) backupFail();
  const names = new Set<string>();
  const entries: ZipEntryDescription[] = [
    { name: 'database/', kind: 'directory', size: 0 },
    { name: 'manifests/', kind: 'directory', size: 0 },
    { name: 'objects/', kind: 'directory', size: 0 },
    { name: 'Backup.json', kind: 'file', size: backupText.length, sha256: digest(backupText) },
    { name: 'Complete.json', kind: 'file', size: completeText.length, sha256: digest(completeText) },
    { name: 'database/collection.sqlite', kind: 'file', size: manifest.database.size, sha256: manifest.database.sha256 },
  ];
  for (const op of manifest.operations) {
    if (!isCollectionId(op.operationId) || !isCollectionId(op.rootId) || !hex(op.manifestHash) || !Number.isSafeInteger(op.manifestSize) || op.manifestSize < 1 || op.manifestSize > 4 * 1024 * 1024 || names.has(op.operationId)) backupFail();
    names.add(op.operationId);
    entries.push({ name: `manifests/${op.operationId}.json`, kind: 'file', size: op.manifestSize, sha256: op.manifestHash });
  }
  names.clear();
  for (const object of manifest.objects) {
    if (!hex(object.sha256) || !Number.isSafeInteger(object.size) || object.size < 1 || object.size > MAX_FILE || names.has(object.sha256)) backupFail();
    names.add(object.sha256);
    if (manifest.contentIncluded) entries.push({ name: `objects/${object.sha256}`, kind: 'file', size: object.size, sha256: object.sha256 });
  }
  const total = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (entries.length > MAX_ENTRIES || !Number.isSafeInteger(total) || total > MAX_TOTAL) backupFail();
  return entries;
}

function budgetFor(entries: readonly ZipEntryDescription[]): ZipBudget {
  const total = entries.reduce((sum, entry) => sum + entry.size, 0);
  const largest = entries.reduce((size, entry) => Math.max(size, entry.size), 1);
  return { maxEntries: entries.length, maxEntryBytes: largest, maxTotalBytes: total, maxArchiveBytes: total + ZIP_OVERHEAD };
}

function receiptMatches(receipt: ZipReceipt, expected: readonly ZipEntryDescription[]): boolean {
  if (receipt.entries.length !== expected.length) return false;
  const wanted = new Map(expected.map(entry => [entry.name, entry]));
  return wanted.size === expected.length && receipt.entries.every(entry => {
    const match = wanted.get(entry.name);
    return !!match && entry.kind === match.kind && entry.size === match.size && entry.sha256 === match.sha256;
  });
}

async function packageChild(parent: RootCapability, name: string): Promise<RootCapability> {
  await checkBackupRoot(parent);
  const absolute = path.join(parent.path, name), child = { ...await authorizeSourceDirectory(absolute), id: randomUUID() };
  if (child.path !== absolute) backupFail();
  return child;
}

function fileSource(root: RootCapability, relative: string, entry: ZipEntryDescription, signal: AbortSignal): ZipEntrySource {
  return { ...entry, open: async () => {
    signal.throwIfAborted(); await checkBackupRoot(root);
    const absolute = path.join(root.path, relative), named = await lstat(absolute, { bigint: true });
    if (!named.isFile() || named.nlink !== 1n || named.size !== BigInt(entry.size)) backupFail();
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (identity(await handle.stat({ bigint: true })) !== identity(named)) backupFail();
      async function* chunks(): AsyncGenerator<Buffer> {
        try {
          let offset = 0;
          while (offset < entry.size) {
            signal.throwIfAborted();
            const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, entry.size - offset));
            const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
            if (!bytesRead) backupFail();
            offset += bytesRead; yield chunk.subarray(0, bytesRead);
          }
          if (identity(await handle.stat({ bigint: true })) !== identity(named) || identity(await lstat(absolute, { bigint: true })) !== identity(named)) backupFail();
          await checkBackupRoot(root); signal.throwIfAborted();
        } finally { await handle.close(); }
      }
      return Readable.from(chunks(), { objectMode: false });
    } catch (error) { await handle.close(); throw error; }
  } };
}

async function recoverPublishedZip(destination: RootCapability, id: string, expectedManifest: ArchiveBackupManifest): Promise<{ file: ArchiveBackupZipFile; manifest: ArchiveBackupManifest; receipt: ZipReceipt } | undefined> {
  const name = `MusicBridge-Backup-${id}.zip`, absolute = path.join(destination.path, name);
  await checkBackupRoot(destination);
  const named = await lstat(absolute, { bigint: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (!named) return undefined;
  if (!named.isFile() || named.nlink < 1n || named.nlink > 2n || named.size < 1n || named.size > BigInt(readBudget.maxArchiveBytes)) backupFail('BACKUP_DESTINATION_INVALID');
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  let checked: Awaited<ReturnType<typeof inspectZipHandle>>;
  try {
    if (identity(await handle.stat({ bigint: true })) !== identity(named)) backupFail();
    checked = await inspectZipHandle(handle, new AbortController().signal);
    const after = await lstat(absolute, { bigint: true });
    if (identity(after) !== identity(named) || after.nlink !== named.nlink) backupFail();
  } finally { await handle.close(); }
  if (!same(checked.manifest, expectedManifest)) backupFail('BACKUP_DESTINATION_INVALID');
  if (named.nlink === 2n) {
    // 仅收口本任务发布留下的同 inode 临时链接；其他文件绝不猜测清理。
    const prefix = `.musicbridge-backup-zip-${id}-`;
    const matches: string[] = [];
    for (const candidate of await readdir(destination.path)) {
      if (!candidate.startsWith(prefix) || !/^\.musicbridge-backup-zip-[0-9a-f-]{36}-[0-9a-f-]{36}\.partial$/u.test(candidate)) continue;
      const item = await lstat(path.join(destination.path, candidate), { bigint: true });
      if (item.isFile() && item.dev === named.dev && item.ino === named.ino) matches.push(candidate);
    }
    if (matches.length !== 1) backupFail('BACKUP_INCOMPLETE');
    await checkBackupRoot(destination);
    const current = await lstat(absolute, { bigint: true });
    if (identity(current) !== identity(named) || current.nlink !== 2n) backupFail();
    const pendingPath = path.join(destination.path, matches[0]!);
    const pending = await lstat(pendingPath, { bigint: true });
    if (!pending.isFile() || pending.nlink !== 2n || identity(pending) !== identity(named)) backupFail('BACKUP_INCOMPLETE');
    await unlink(pendingPath);
    await syncBackupRoot(destination);
  }
  const file = await authorizeArchiveBackupZipFile(absolute);
  const verified = await inspectArchiveBackupZip(file, new AbortController().signal);
  if (verified.receipt.sha256 !== checked.receipt.sha256 || verified.receipt.size !== checked.receipt.size || !same(verified.manifest, expectedManifest)) backupFail();
  return { file, manifest: expectedManifest, receipt: verified.receipt };
}

/** 冷启或维护回执失败后只认已有 final；绝不借恢复动作重新生成或覆盖 ZIP。 */
export async function recoverPublishedArchiveBackupZip(options: { packageDirectory: RootCapability; destination: RootCapability; id: string }): Promise<{ file: ArchiveBackupZipFile; manifest: ArchiveBackupManifest; receipt: ZipReceipt } | undefined> {
  const { packageDirectory, destination, id } = options;
  if (!isCollectionId(id) || inside(packageDirectory.path, destination.path)) backupFail('BACKUP_DESTINATION_INVALID');
  const manifest = await verifyArchiveBackup(packageDirectory, new AbortController().signal);
  if (manifest.id !== id) backupFail();
  return recoverPublishedZip(destination, id, manifest);
}

export async function createArchiveBackupZip(options: { packageDirectory: RootCapability; destination: RootCapability; id: string; signal: AbortSignal; userConfirmed: boolean }): Promise<{ file: ArchiveBackupZipFile; manifest: ArchiveBackupManifest; receipt: ZipReceipt }> {
  const { packageDirectory, destination, id, signal } = options;
  if (options.userConfirmed !== true || !isCollectionId(id) || inside(packageDirectory.path, destination.path)) backupFail('BACKUP_DESTINATION_INVALID');
  signal.throwIfAborted(); await checkBackupRoot(destination);
  const manifest = await verifyArchiveBackup(packageDirectory, signal);
  if (manifest.id !== id) backupFail();
  const backupText = Buffer.from(await readBackupText(packageDirectory, 'Backup.json', 32 * 1024 * 1024, signal));
  const completeText = Buffer.from(await readBackupText(packageDirectory, 'Complete.json', 1024, signal));
  const entries = expectedEntries(manifest, backupText, completeText), budget = budgetFor(entries);
  const previouslyPublished = await recoverPublishedZip(destination, id, manifest);
  if (previouslyPublished) return previouslyPublished;
  const space = await statfs(destination.path, { bigint: true });
  if (space.bavail * space.bsize < BigInt(budget.maxArchiveBytes)) backupFail('BACKUP_IO_ERROR');
  const database = await packageChild(packageDirectory, 'database'), manifests = await packageChild(packageDirectory, 'manifests'), objects = await packageChild(packageDirectory, 'objects');
  const sources: ZipEntrySource[] = entries.map(entry => {
    if (entry.kind === 'directory') return entry;
    const [head, tail] = entry.name.split('/');
    if (!tail) return { ...entry, open: async () => Readable.from([head === 'Backup.json' ? backupText : completeText]) };
    return fileSource(head === 'database' ? database : head === 'manifests' ? manifests : objects, tail, entry, signal);
  });
  const name = `MusicBridge-Backup-${id}.zip`, temp = path.join(destination.path, `.musicbridge-backup-zip-${id}-${randomUUID()}.partial`), final = path.join(destination.path, name);
  const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  let published = false;
  try {
    const written = await writeVerifiedZip(handle, sources, budget, signal);
    const receipt = await verifyVerifiedZip(handle, entries, budget, signal);
    if (written.sha256 !== receipt.sha256 || written.size !== receipt.size) backupFail();
    await verifyArchiveBackup(packageDirectory, signal);
    signal.throwIfAborted(); await checkBackupRoot(destination);
    const staged = await handle.stat({ bigint: true });
    if (!staged.isFile() || staged.nlink !== 1n || staged.size !== BigInt(receipt.size)) backupFail();
    await link(temp, final);
    published = true;
    const publishedInfo = await lstat(final, { bigint: true });
    if (!publishedInfo.isFile() || publishedInfo.nlink !== 2n || publishedInfo.dev !== staged.dev || publishedInfo.ino !== staged.ino || publishedInfo.size !== staged.size) backupFail();
    await unlink(temp);
    await syncBackupRoot(destination);
  } catch (error) {
    if (!published) return zipFailure(error, signal);
    // link 已建立完成边界；其后取消或回执 I/O 失败都不得将有效最终 ZIP 写成失败。
    return (await recoverPublishedZip(destination, id, manifest)) ?? backupFail('BACKUP_INCOMPLETE');
  } finally { await handle.close(); }
  return (await recoverPublishedZip(destination, id, manifest)) ?? backupFail('BACKUP_INCOMPLETE');
}

const allowedZipEntry = (entry: ZipEntryDescription): boolean => entry.kind === 'directory'
  ? ['database/','manifests/','objects/'].includes(entry.name)
  : ['Backup.json','Complete.json','database/collection.sqlite'].includes(entry.name)
    || /^manifests\/[0-9a-f-]{36}\.json$/u.test(entry.name)
    || /^objects\/[a-f0-9]{64}$/u.test(entry.name);

interface ScratchDatabase { root: RootCapability; created?: { dev: string; ino: string } }
async function writeScratchDatabase(scratch: ScratchDatabase, chunks: AsyncIterable<Buffer>, expectedSize: number, signal: AbortSignal): Promise<void> {
  await checkBackupRoot(scratch.root);
  const space = await statfs(scratch.root.path, { bigint: true });
  if (space.bavail * space.bsize < BigInt(expectedSize) + 16n * 1024n * 1024n) backupFail('BACKUP_IO_ERROR');
  const absolute = path.join(scratch.root.path, 'collection.sqlite');
  const output = await open(absolute, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const opened = await output.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n) backupFail();
    scratch.created = { dev: String(opened.dev), ino: String(opened.ino) };
    let offset = 0;
    for await (const chunk of chunks) {
      signal.throwIfAborted();
      let written = 0;
      while (written < chunk.length) {
        const result = await output.write(chunk, written, chunk.length - written, offset + written);
        if (!result.bytesWritten) backupFail('BACKUP_IO_ERROR');
        written += result.bytesWritten;
      }
      offset += chunk.length;
    }
    if (offset !== expectedSize) backupFail();
    await output.sync();
    const completed = await output.stat({ bigint: true });
    if (String(completed.dev) !== scratch.created.dev || String(completed.ino) !== scratch.created.ino || completed.nlink !== 1n || completed.size !== BigInt(expectedSize)) backupFail();
  } finally { await output.close(); }
  await syncBackupRoot(scratch.root);
}

async function inspectZipHandle(handle: FileHandle, signal: AbortSignal, scratch?: ScratchDatabase): Promise<{ manifest: ArchiveBackupManifest; manifestHash: string; receipt: ZipReceipt }> {
  try {
    let backup = Buffer.alloc(0), complete = Buffer.alloc(0);
    const receipt = await readVerifiedZipEntries(handle, readBudget, signal, async (entry, chunks) => {
      if (!allowedZipEntry(entry)) backupFail();
      const limit = entry.name === 'Backup.json' ? 32 * 1024 * 1024 : entry.name === 'Complete.json' ? 1024 : entry.name.startsWith('manifests/') ? 4 * 1024 * 1024 : MAX_FILE;
      if (entry.size < (entry.kind === 'file' ? 1 : 0) || entry.size > limit) backupFail();
      if (entry.kind === 'directory') return;
      if (entry.name === 'database/collection.sqlite' && scratch) return writeScratchDatabase(scratch, chunks, entry.size, signal);
      const capture = entry.name === 'Backup.json' || entry.name === 'Complete.json';
      const parts: Buffer[] = [];
      for await (const chunk of chunks) if (capture) parts.push(Buffer.from(chunk));
      if (entry.name === 'Backup.json') backup = Buffer.concat(parts);
      if (entry.name === 'Complete.json') complete = Buffer.concat(parts);
    });
    let parsed: unknown;
    try { parsed = JSON.parse(backup.toString('utf8')); } catch { return backupFail(); }
    const manifest = parsed as ArchiveBackupManifest;
    const expected = expectedEntries(manifest, backup, complete);
    if (!receiptMatches(receipt, expected)) backupFail();
    if (scratch) {
      if (!scratch.created) backupFail();
      const database = await hashBackupFile(scratch.root, 'collection.sqlite', signal);
      if (!same(database, manifest.database)) backupFail();
      let index: ReturnType<typeof readBackupIndex>['index'];
      try { index = readBackupIndex(path.join(scratch.root.path, 'collection.sqlite')).index; }
      catch { return backupFail(); }
      if (!same(index, { operations: manifest.operations, objects: manifest.objects, incompleteOperationIds: manifest.incompleteOperationIds }) || manifest.contentIncluded && index.incompleteOperationIds.length) backupFail();
      if (!same(await hashBackupFile(scratch.root, 'collection.sqlite', signal), database)) backupFail();
    }
    return { manifest, manifestHash: digest(backup), receipt };
  } catch (error) { return zipFailure(error, signal); }
}

async function inspectArchiveBackupZipWithScratch(file: ArchiveBackupZipFile, signal: AbortSignal, scratch?: ScratchDatabase): Promise<{ manifest: ArchiveBackupManifest; manifestHash: string; receipt: ZipReceipt }> {
  const handle = await checkedZip(file);
  try {
    const result = await inspectZipHandle(handle, signal, scratch);
    await checkBackupRoot(file.parent);
    const after = await lstat(path.join(file.parent.path, file.name), { bigint: true });
    if (String(after.dev) !== file.dev || String(after.ino) !== file.ino || Number(after.size) !== file.size || String(after.mtimeNs) !== file.mtimeNs || String(after.ctimeNs) !== file.ctimeNs) backupFail();
    return result;
  } finally { await handle.close(); }
}

/** 容器与逐项字节检查；完整语义成功回执应使用 verifyArchiveBackupZip。 */
export async function inspectArchiveBackupZip(file: ArchiveBackupZipFile, signal: AbortSignal): Promise<{ manifest: ArchiveBackupManifest; manifestHash: string; receipt: ZipReceipt }> {
  return inspectArchiveBackupZipWithScratch(file, signal);
}

async function removeOwnedScratch(parent: RootCapability, scratch: ScratchDatabase): Promise<void> {
  await checkBackupRoot(parent); await checkBackupRoot(scratch.root);
  if (path.dirname(scratch.root.path) !== parent.path) backupFail('BACKUP_DESTINATION_INVALID');
  const entries = await readdir(scratch.root.path);
  if (scratch.created) {
    if (entries.length !== 1 || entries[0] !== 'collection.sqlite') backupFail('BACKUP_INCOMPLETE');
    const absolute = path.join(scratch.root.path, 'collection.sqlite'), named = await lstat(absolute, { bigint: true });
    if (!named.isFile() || named.nlink !== 1n || String(named.dev) !== scratch.created.dev || String(named.ino) !== scratch.created.ino) backupFail('BACKUP_INCOMPLETE');
    await unlink(absolute);
  } else if (entries.length) backupFail('BACKUP_INCOMPLETE');
  await checkBackupRoot(scratch.root);
  await rmdir(scratch.root.path);
  await syncBackupRoot(parent);
}

/** 与目录备份同义的校验：ZIP 全量字节核验后，仅暂存 SQLite 快照验证内部引用闭包。 */
export async function verifyArchiveBackupZip(file: ArchiveBackupZipFile, privateRoot: RootCapability, signal: AbortSignal): Promise<{ manifest: ArchiveBackupManifest; manifestHash: string; receipt: ZipReceipt }> {
  if (!privateRoot || inside(privateRoot.path, file.parent.path) || inside(file.parent.path, privateRoot.path)) backupFail('BACKUP_DESTINATION_INVALID');
  signal.throwIfAborted(); await checkBackupRoot(privateRoot);
  const root = await createBackupDirectory(privateRoot, `zipverify_${randomUUID()}`), scratch: ScratchDatabase = { root };
  try { return await inspectArchiveBackupZipWithScratch(file, signal, scratch); }
  finally { await removeOwnedScratch(privateRoot, scratch); }
}

async function extractArchiveBackupZip(file: ArchiveBackupZipFile, directory: RootCapability, expected: ZipReceipt, signal: AbortSignal): Promise<void> {
  const children = { database: await createBackupDirectory(directory, 'database'), manifests: await createBackupDirectory(directory, 'manifests'), objects: await createBackupDirectory(directory, 'objects') };
  const handle = await checkedZip(file);
  try {
    const receipt = await readVerifiedZipEntries(handle, readBudget, signal, async (entry, chunks) => {
      if (!allowedZipEntry(entry)) backupFail();
      if (entry.kind === 'directory') return;
      const [head, tail] = entry.name.split('/');
      const target = tail ? children[head as keyof typeof children] : directory;
      const name = tail ?? head!;
      if (!target || !name) backupFail();
      await checkBackupRoot(target);
      const output = await open(path.join(target.path, name), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      try {
        let offset = 0;
        for await (const chunk of chunks) {
          signal.throwIfAborted();
          let written = 0;
          while (written < chunk.length) {
            const result = await output.write(chunk, written, chunk.length - written, offset + written);
            if (!result.bytesWritten) backupFail('BACKUP_IO_ERROR');
            written += result.bytesWritten;
          }
          offset += chunk.length;
        }
        if (offset !== entry.size) backupFail();
        await output.sync();
      } finally { await output.close(); }
      await checkBackupRoot(target);
    });
    if (receipt.sha256 !== expected.sha256 || receipt.size !== expected.size || !same(receipt.entries, expected.entries)) backupFail();
    await syncBackupRoot(children.database); await syncBackupRoot(children.manifests); await syncBackupRoot(children.objects); await syncBackupRoot(directory);
  } finally { await handle.close(); }
}

/** ZIP 只作为只读来源；输出直接落在新建隔离候选，随后复用旧包的完整语义校验。 */
export async function restoreArchiveBackupZip(options: { file: ArchiveBackupZipFile; destination: RootCapability; protectedRoots: readonly RootCapability[]; id: string; userConfirmed: boolean; signal: AbortSignal; expectedBackupIdentity?: { id: string; manifestHash: string } }): Promise<{ directory: RootCapability; manifest: RestoredArchiveManifest }> {
  const { file, destination, id, signal } = options;
  try {
  if (options.userConfirmed !== true || !isCollectionId(id) || !Array.isArray(options.protectedRoots)) backupFail('BACKUP_DESTINATION_INVALID');
  signal.throwIfAborted(); await checkBackupRoot(destination);
  await previewArchiveRoot(destination.path, [file.parent, ...options.protectedRoots]);
  const verified = await inspectArchiveBackupZip(file, signal);
  if (options.expectedBackupIdentity && (options.expectedBackupIdentity.id !== verified.manifest.id || options.expectedBackupIdentity.manifestHash !== verified.manifestHash)) backupFail();
  const absolute = path.join(destination.path, id);
  const existing = await lstat(absolute).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) backupFail('BACKUP_DESTINATION_INVALID');
    const directory = await packageChild(destination, id), manifest = await verifyRestoredArchive(directory, signal);
    if (manifest.id !== id || manifest.sourceBackupId !== verified.manifest.id || manifest.sourceManifestHash !== verified.manifestHash) backupFail();
    return { directory, manifest };
  }
  const bytes = verified.receipt.entries.reduce((sum, entry) => sum + entry.size, 0);
  const space = await statfs(destination.path, { bigint: true });
  if (!Number.isSafeInteger(bytes) || space.bavail * space.bsize < BigInt(bytes) + BigInt(ZIP_OVERHEAD)) backupFail('BACKUP_IO_ERROR');
  const directory = await createBackupDirectory(destination, id);
  await extractArchiveBackupZip(file, directory, verified.receipt, signal);
  const original = await verifyArchiveBackup(directory, signal);
  if (!same(original, verified.manifest)) backupFail();
  // 数据库隔离会改写快照字节；移除仅用于导入核验的旧备份标记，避免候选同时冒充原备份。
  await unlink(path.join(directory.path, 'Backup.json'));
  await unlink(path.join(directory.path, 'Complete.json'));
  await syncBackupRoot(directory);
  const database = await packageChild(directory, 'database');
  const dbPath = path.join(database.path, 'collection.sqlite');
  isolateRestoredDatabase(dbPath);
  verifyRestoredDatabaseIsolation(dbPath);
  const dbHandle = await open(dbPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await dbHandle.sync(); } finally { await dbHandle.close(); }
  await syncBackupRoot(database);
  const databaseFile: BackupFile = await hashBackupFile(database, 'collection.sqlite', signal);
  const index = readBackupIndex(dbPath).index;
  const manifest: RestoredArchiveManifest = { schemaVersion: 1, kind: 'musicbridge-isolated-restore', id, state: 'isolated-pending-activation', sourceBackupId: original.id, sourceManifestHash: verified.manifestHash, mode: original.mode, contentIncluded: original.contentIncluded, database: databaseFile, originalDatabase: original.database, ...index };
  const encoded = JSON.stringify(manifest, null, 2) + '\n';
  if (Buffer.byteLength(encoded) > 32 * 1024 * 1024) backupFail();
  await writeBackupText(directory, 'Restore.json', encoded);
  // 完成标记前再次检查源 ZIP 与隔离候选；失败只保留未完成目录，不动当前工作库。
  const latest = await inspectArchiveBackupZip(file, signal);
  if (latest.receipt.sha256 !== verified.receipt.sha256 || !same(latest.manifest, original)) backupFail();
  await checkBackupRoot(destination); signal.throwIfAborted();
  await writeBackupText(directory, 'RestoreComplete.json', JSON.stringify({ schemaVersion: 1, id, manifestHash: archiveDigest(encoded) }) + '\n');
  const checked = await verifyRestoredArchive(directory, signal);
  if (!same(checked, manifest)) backupFail();
  return { directory, manifest };
  } catch (error) { return zipFailure(error, signal); }
}
