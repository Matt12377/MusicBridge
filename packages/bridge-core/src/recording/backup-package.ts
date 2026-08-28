import { constants } from 'node:fs';
import { open, readdir, statfs } from 'node:fs/promises';
import path from 'node:path';
import { isCollectionId } from '@music-bridge/contracts';
import type { CollectionRepository } from '../collection/repository.js';
import { archiveDigest, previewArchiveRoot, verifyArchiveObjects, type OwnedArchiveOperation } from './archive-files.js';
import { authorizeSourceDirectory, copyReadonlySource, type RootCapability } from './source-files.js';
import { BackupError, backupFail, checkBackupRoot, createBackupDirectory, hashBackupFile, syncBackupRoot, writeBackupText, readBackupText, type BackupFile } from './backup-files.js';
import { readBackupIndex, type BackupIndex } from './backup-index.js';

export interface ArchiveBackupManifest extends BackupIndex {
  schemaVersion: 1; kind: 'musicbridge-archive-backup'; id: string; mode: 'metadata' | 'archive-content'; createdAt: string;
  database: BackupFile; contentIncluded: boolean; exclusions: string[];
}
const exclusions = ['unarchived-source-and-working-files', 'provider-credentials-and-roon-sessions', 'formal-recording-retention-policy-not-decided'];
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
async function child(parent: RootCapability, name: string): Promise<RootCapability> {
  await checkBackupRoot(parent); const root = { ...await authorizeSourceDirectory(path.join(parent.path, name)), id: parent.id };
  if (root.path !== path.join(parent.path, name)) backupFail(); return root;
}
/** 只验证备份内部字节和引用闭包，不接触快照内保存的原绝对路径，也不恢复目录权限。 */
async function verifyPackage(directory: RootCapability, signal: AbortSignal, completed: boolean): Promise<ArchiveBackupManifest> {
  signal.throwIfAborted(); await checkBackupRoot(directory);
  const bytes = await readBackupText(directory, 'Backup.json', 32 * 1024 * 1024, signal), manifest = JSON.parse(bytes) as ArchiveBackupManifest;
  if (!same(Object.keys(manifest).sort(), ['schemaVersion','kind','id','mode','createdAt','database','contentIncluded','exclusions','operations','objects','incompleteOperationIds'].sort()) || manifest.schemaVersion !== 1 || manifest.kind !== 'musicbridge-archive-backup' || !isCollectionId(manifest.id) || !['metadata','archive-content'].includes(manifest.mode) || manifest.contentIncluded !== (manifest.mode === 'archive-content') || !same(manifest.exclusions, exclusions) || !Number.isFinite(Date.parse(manifest.createdAt))) backupFail();
  if (completed) {
    const marker = JSON.parse(await readBackupText(directory, 'Complete.json', 1024, signal)) as unknown;
    if (!same(marker, { schemaVersion: 1, id: manifest.id, manifestHash: archiveDigest(bytes) })) backupFail('BACKUP_INCOMPLETE');
  }
  const databaseRoot = await child(directory, 'database');
  if (!same((await readdir(databaseRoot.path)).sort(), ['collection.sqlite'])) backupFail();
  const database = await hashBackupFile(databaseRoot, 'collection.sqlite', signal);
  if (!same(database, manifest.database)) backupFail();
  const { index } = readBackupIndex(path.join(databaseRoot.path, 'collection.sqlite'));
  if (!same(index, { operations: manifest.operations, objects: manifest.objects, incompleteOperationIds: manifest.incompleteOperationIds }) || manifest.contentIncluded && index.incompleteOperationIds.length) backupFail();
  if (!same(await hashBackupFile(databaseRoot, 'collection.sqlite', signal), database)) backupFail();
  const manifests = await child(directory, 'manifests'), objects = await child(directory, 'objects');
  for (const operation of index.operations) {
    const file = await hashBackupFile(manifests, `${operation.operationId}.json`, signal);
    if (file.sha256 !== operation.manifestHash || file.size !== operation.manifestSize) backupFail();
  }
  if (!same((await readdir(manifests.path)).sort(), index.operations.map(op => `${op.operationId}.json`).sort())) backupFail();
  const expectedObjects = manifest.contentIncluded ? index.objects : [];
  if (!same((await readdir(objects.path)).sort(), expectedObjects.map(o => o.sha256).sort())) backupFail();
  for (const object of expectedObjects) {
    const file = await hashBackupFile(objects, object.sha256, signal);
    if (file.sha256 !== object.sha256 || file.size !== object.size) backupFail();
  }
  signal.throwIfAborted(); return manifest;
}
export async function verifyArchiveBackup(directory: RootCapability, signal: AbortSignal): Promise<ArchiveBackupManifest> {
  try { return await verifyPackage(directory, signal, true); }
  catch (error) { if (signal.aborted) throw signal.reason; if (error instanceof BackupError) throw error; return backupFail(); }
}
/** 仅为已核验的恢复内容提供位置，不修改历史操作或恢复旧目录授权。 */
export interface ArchiveContentReadSession {
  resolve(operation: OwnedArchiveOperation): RootCapability | undefined;
  verify(signal: AbortSignal): Promise<void>;
}
export interface ArchiveContentBinding {
  readonly protectedRoots: readonly RootCapability[];
  open(signal: AbortSignal): Promise<ArchiveContentReadSession>;
}
export interface CreateArchiveBackupOptions {
  repository: CollectionRepository; destination: RootCapability; id: string; mode: 'metadata' | 'archive-content'; userConfirmed: boolean; signal: AbortSignal;
  afterSnapshot?: () => Promise<void>;
  copy?: typeof copyReadonlySource;
  contentBinding?: ArchiveContentBinding;
}
/** 内部能力边界；桌面选择器与持久化命令确认由后续工作流负责，不开放任意路径 IPC。 */
export async function createArchiveBackup(options: CreateArchiveBackupOptions): Promise<{ directory: RootCapability; manifest: ArchiveBackupManifest }> {
  const { repository, destination, id, mode, signal } = options;
  try {
    signal.throwIfAborted();
    if (options.userConfirmed !== true || !isCollectionId(id) || !['metadata','archive-content'].includes(mode)) backupFail('BACKUP_DESTINATION_INVALID');
    const protectedRoots = [...repository.sources.roots(), ...repository.preparations.destinations(), ...repository.archive.candidates().map(c => c.parent), ...repository.archive.operations().flatMap(op => op.owned ? [op.owned.archive.root] : []), ...options.contentBinding?.protectedRoots ?? []];
    await checkBackupRoot(destination); await previewArchiveRoot(destination.path, protectedRoots);
    const binding = mode === 'archive-content' ? await options.contentBinding?.open(signal) : undefined;
    const directory = await createBackupDirectory(destination, id), databaseRoot = await createBackupDirectory(directory, 'database');
    const snapshot = await repository.backupSnapshot(databaseRoot);
    signal.throwIfAborted();
    const { index, owned } = readBackupIndex(path.join(databaseRoot.path, snapshot.relative));
    if (mode === 'archive-content' && index.incompleteOperationIds.length) backupFail('BACKUP_INCOMPLETE');
    await options.afterSnapshot?.(); signal.throwIfAborted();
    const manifests = await createBackupDirectory(directory, 'manifests'), objects = await createBackupDirectory(directory, 'objects');
    const total = index.objects.reduce((n, o) => n + o.size, 0), space = await statfs(destination.path, { bigint: true });
    if (!Number.isSafeInteger(total) || total > 1_099_511_627_776 || mode === 'archive-content' && space.bavail * space.bsize < BigInt(total) + 16_777_216n) backupFail('BACKUP_IO_ERROR');
    const boundRoots = new Map(owned.flatMap(op => { const root = binding?.resolve(op); return root ? [[op.id, root] as const] : []; }));
    const checkLiveRoots = (): void => {
      if (mode !== 'archive-content') return;
      for (const op of owned) {
        const bound = boundRoots.get(op.id);
        if (bound ? !same(binding?.resolve(op), bound) : !same(repository.archive.root(op.archive.id), op.archive)) backupFail('BACKUP_INCOMPLETE');
      }
    };
    checkLiveRoots();
    for (const op of owned) {
      signal.throwIfAborted(); checkLiveRoots();
      if (mode === 'archive-content' && !boundRoots.has(op.id)) await verifyArchiveObjects(op, signal);
      await writeBackupText(manifests, `${op.id}.json`, op.manifest);
    }
    if (mode === 'archive-content') {
      for (const object of index.objects) {
        signal.throwIfAborted(); checkLiveRoots(); await checkBackupRoot(objects);
        const operation = owned.find(op => op.files.some(file => file.sha256 === object.sha256));
        const source = operation && (boundRoots.get(operation.id) ?? operation.archive.objects);
        if (!source) backupFail();
        const target = await open(path.join(objects.path, object.sha256), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
        try { await (options.copy ?? copyReadonlySource)(source, object.sha256, object, target, signal); }
        finally { await target.close(); }
      }
    }
    signal.throwIfAborted(); checkLiveRoots(); await syncBackupRoot(objects);
    const { relative, sha256, size } = snapshot;
    const manifest: ArchiveBackupManifest = { schemaVersion: 1, kind: 'musicbridge-archive-backup', id, mode, createdAt: new Date().toISOString(), database: { relative, sha256, size }, contentIncluded: mode === 'archive-content', exclusions, ...index };
    const encoded = JSON.stringify(manifest, null, 2) + '\n';
    if (Buffer.byteLength(encoded) > 32 * 1024 * 1024) backupFail();
    await writeBackupText(directory, 'Backup.json', encoded);
    await verifyPackage(directory, signal, false);
    await binding?.verify(signal);
    signal.throwIfAborted(); checkLiveRoots(); await checkBackupRoot(destination);
    // 完成标记是唯一发布边界；中途失败只留下隔离目录，不自动删除或覆盖它。
    await writeBackupText(directory, 'Complete.json', JSON.stringify({ schemaVersion: 1, id, manifestHash: archiveDigest(encoded) }) + '\n');
    return { directory, manifest };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof BackupError) throw error;
    return backupFail('BACKUP_IO_ERROR');
  }
}
