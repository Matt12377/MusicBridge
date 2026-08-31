import path from 'node:path';
import { isCollectionId } from '@music-bridge/contracts';
import { archiveDigest, archiveManifest } from './archive-files.js';
import { authorizeSourceDirectory } from './source-files.js';
import { backupFail, checkBackupRoot, readBackupText } from './backup-files.js';
import type { ArchiveContentBinding } from './backup-package.js';
import type { PreparedRestoredDataset } from './restore-activation-files.js';
import { verifyRestoredArchive } from './restore-package.js';

/** 绑定保存新位置能力，旧 OwnedArchiveOperation 始终作为不可变历史引用。 */
export function createRestoredContentBinding(prepared: PreparedRestoredDataset, options: { isAuthorized?: () => boolean } = {}): ArchiveContentBinding {
  const value = structuredClone(prepared);
  const isAuthorized = options.isAuthorized ?? (() => true);
  const check = (signal: AbortSignal): void => {
    signal.throwIfAborted();
    let authorized = false;
    try { authorized = isAuthorized() === true; } catch { /* 授权账本关闭或不可读时，不能沿用旧能力。 */ }
    if (!authorized) backupFail('BACKUP_DESTINATION_INVALID');
  };
  const verifySource = async (signal: AbortSignal) => {
    check(signal);
    if (!isCollectionId(value.id) || !isCollectionId(value.restoreId) || !/^[a-f0-9]{64}$/u.test(value.restoreManifestHash)) backupFail();
    const manifest = await verifyRestoredArchive(value.source, signal);
    check(signal);
    const text = await readBackupText(value.source, 'Restore.json', 32 * 1024 * 1024, signal);
    check(signal);
    if (manifest.id !== value.restoreId || manifest.contentIncluded !== value.contentIncluded
      || archiveDigest(text) !== value.restoreManifestHash || JSON.stringify(JSON.parse(text)) !== JSON.stringify(manifest)
      || JSON.stringify(manifest.database) !== JSON.stringify(value.databaseFile)) backupFail();
    return manifest;
  };
  return {
    get protectedRoots() { return structuredClone([value.source, value.directory]); },
    async open(signal) {
      const manifest = await verifySource(signal);
      const operations = new Map(manifest.operations.map(operation => [operation.operationId, operation]));
      const absolute = path.join(value.source.path, 'objects');
      check(signal);
      const objects = manifest.contentIncluded ? { ...await authorizeSourceDirectory(absolute), id: value.restoreId } : undefined;
      check(signal);
      if (objects && objects.path !== absolute) backupFail();
      return {
        resolve(operation) {
          check(signal);
          const expected = operations.get(operation.id);
          if (!expected) return undefined;
          if (operation.archive.id !== expected.rootId || archiveDigest(operation.manifest) !== expected.manifestHash
            || Buffer.byteLength(operation.manifest) !== expected.manifestSize || archiveManifest(operation.id, operation.files, operation.lineage) !== operation.manifest) backupFail();
          return objects ? structuredClone(objects) : undefined;
        },
        async verify(currentSignal) {
          check(signal);
          await verifySource(currentSignal);
          if (objects) await checkBackupRoot(objects);
          check(currentSignal); check(signal);
        },
      };
    },
  };
}
