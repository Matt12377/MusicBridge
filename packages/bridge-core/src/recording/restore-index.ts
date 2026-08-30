import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { archiveObjectTotals, isCollectionId, type ArchiveObjectDescriptor } from '@music-bridge/contracts';
import { authorizeSourceDirectory, type RootCapability } from './source-files.js';
import { checkArchiveRoot, type OwnedArchive } from './archive-files.js';
import { backupFail, checkBackupRoot, hashBackupFile, readBackupText } from './backup-files.js';

interface RecoveredManifest {
  schemaVersion: 1; operationId: string; formalRecording: false;
  lineage: { masterVersionId: string; layoutVersionId: string; executionAssetId: string };
  files: ArchiveObjectDescriptor[];
}
export interface RebuiltArchiveIndex {
  schemaVersion: 1; state: 'needs-review'; historyTrusted: false; inventoryReconstructed: false;
  missingFacts: string[];
  operations: Array<{ operationId: string; lineage: RecoveredManifest['lineage']; files: ArchiveObjectDescriptor[]; state: 'quarantined' | 'bytes-verified-history-unverified' }>;
  issues: Array<{ operationId?: string; sha256?: string; code: 'MANIFEST_INVALID' | 'OBJECT_MISSING' | 'OBJECT_INVALID' }>;
}
function parseManifest(text: string, id: string): RecoveredManifest {
  const value = JSON.parse(text) as RecoveredManifest;
  if (!value || Object.keys(value).sort().join(',') !== 'files,formalRecording,lineage,operationId,schemaVersion' || value.schemaVersion !== 1 || value.operationId !== id || !isCollectionId(id) || value.formalRecording !== false || !value.lineage || Object.keys(value.lineage).sort().join(',') !== 'executionAssetId,layoutVersionId,masterVersionId' || !Object.values(value.lineage).every(isCollectionId) || !Array.isArray(value.files) || !value.files.length || value.files.length > 1000 || !archiveObjectTotals(value.files)) backupFail();
  return value;
}
/** 文件内容只作为候选证据；没有 DB 时绝不据此生成实体库存、冻结版本或完成事实。 */
export async function rebuildArchiveIndex(options: ({ directory: RootCapability } | { archive: OwnedArchive }) & { signal: AbortSignal }): Promise<RebuiltArchiveIndex> {
  const { signal } = options, archive = 'archive' in options ? options.archive : undefined;
  const directory = 'directory' in options ? options.directory : options.archive.root;
  signal.throwIfAborted(); await checkBackupRoot(directory);
  if (archive) await checkArchiveRoot(archive);
  const child = async (name: string): Promise<RootCapability> => {
    const absolute = path.join(directory.path, name), root = { ...await authorizeSourceDirectory(absolute), id: directory.id };
    if (root.path !== absolute) backupFail(); return root;
  };
  const manifests = archive?.operations ?? await child('manifests'), objects = archive?.objects ?? await child('objects');
  const entries = (await readdir(manifests.path)).sort();
  if (entries.length > 10000) backupFail();
  const result: RebuiltArchiveIndex = { schemaVersion: 1, state: 'needs-review', historyTrusted: false, inventoryReconstructed: false, missingFacts: ['physical-recording-completion','inventory-and-ledger','frozen-version-records','profile-snapshots-and-user-confirmations','directory-authorizations'], operations: [], issues: [] };
  let totalBytes = 0;
  for (const entry of entries) {
    signal.throwIfAborted(); await checkBackupRoot(manifests);
    const id = archive ? entry : entry.endsWith('.json') ? entry.slice(0, -5) : '';
    if (!isCollectionId(id)) { result.issues.push({ code: 'MANIFEST_INVALID' }); continue; }
    let manifest: RecoveredManifest;
    try {
      const manifestRoot = archive ? { ...await authorizeSourceDirectory(path.join(manifests.path, id)), id } : manifests;
      if (archive && manifestRoot.path !== path.join(manifests.path, id)) backupFail();
      const text = await readBackupText(manifestRoot, archive ? 'Manifest.json' : entry, 4 * 1024 * 1024, signal);
      totalBytes += Buffer.byteLength(text); if (totalBytes > 32 * 1024 * 1024) backupFail();
      manifest = parseManifest(text, id);
    } catch {
      signal.throwIfAborted(); if (totalBytes > 32 * 1024 * 1024) backupFail();
      result.issues.push({ operationId: id, code: 'MANIFEST_INVALID' }); continue;
    }
    let invalid = false;
    for (const object of new Map(manifest.files.map(file => [file.sha256, file])).values()) {
      signal.throwIfAborted(); await checkBackupRoot(objects);
      const info = await lstat(path.join(objects.path, object.sha256)).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
      if (!info) { invalid = true; result.issues.push({ operationId: id, sha256: object.sha256, code: 'OBJECT_MISSING' }); continue; }
      try {
        const file = await hashBackupFile(objects, object.sha256, signal);
        if (file.sha256 !== object.sha256 || file.size !== object.size) backupFail();
      } catch {
        signal.throwIfAborted(); invalid = true; result.issues.push({ operationId: id, sha256: object.sha256, code: 'OBJECT_INVALID' });
      }
    }
    result.operations.push({ operationId: id, lineage: manifest.lineage, files: manifest.files, state: invalid ? 'quarantined' : 'bytes-verified-history-unverified' });
  }
  signal.throwIfAborted(); await checkBackupRoot(directory); return result;
}
