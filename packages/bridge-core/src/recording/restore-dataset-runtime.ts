import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isCollectionId } from '@music-bridge/contracts';
import { createCollectionRepository, type CollectionRepository } from '../collection/repository.js';
import { archiveDigest } from './archive-files.js';
import { readBackupText } from './backup-files.js';
import type { ArchiveContentBinding } from './backup-package.js';
import { BackupWorkflowError, createBackupWorkflowStore, type BackupWorkflowStore } from './backup-workflow-store.js';
import { verifyPreparedDataset, type PreparedRestoredDataset } from './restore-activation-files.js';
import type { StoredRestoreActivation } from './restore-activation-store.js';
import { createRestoredContentBinding } from './restore-content-binding.js';
import { authorizeSourceDirectory, type RootCapability } from './source-files.js';

export interface OpenCollectionDataset {
  readonly datasetId: string; assertIdentity(): void;
  repository: CollectionRepository; store: BackupWorkflowStore; privateRoot: RootCapability;
  contentBinding?: ArchiveContentBinding; pendingActivationId?: string;
  commit(): void; fail(): void; close(): void;
}
const unavailable = (): never => { throw new BackupWorkflowError('BACKUP_UNAVAILABLE'); };
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const inside = (parent: string, child: string): boolean => { const relative = path.relative(parent, child); return !relative || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`); };
function checkDirectory(absolute: string): void {
  const info = lstatSync(absolute);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(absolute) !== absolute) unavailable();
}
function checkRoot(root: RootCapability): void {
  if (!root.authorized || !path.isAbsolute(root.path)) unavailable();
  checkDirectory(root.path);
  const info = lstatSync(root.path, { bigint: true });
  if (String(info.dev) !== root.dev || String(info.ino) !== root.ino) unavailable();
}
function checkDatasetTree(root: RootCapability, dataset: PreparedRestoredDataset): string {
  checkRoot(root);
  if (!isCollectionId(dataset.id) || !isCollectionId(dataset.restoreId) || dataset.databaseFile.relative !== 'collection.sqlite'
    || dataset.directory.path !== path.join(root.path, 'restored-datasets', dataset.id)
    || dataset.database.path !== path.join(dataset.directory.path, 'database')
    || !path.isAbsolute(dataset.source.path) || inside(root.path, dataset.source.path) || inside(dataset.source.path, root.path)) unavailable();
  checkDirectory(path.join(root.path, 'restored-datasets')); checkRoot(dataset.directory); checkRoot(dataset.database);
  return path.join(dataset.database.path, 'collection.sqlite');
}
/** 工作库可正常写入；只固定目录与激活收据身份，不把初始数据库摘要当成永恒内容。 */
async function checkActiveMarker(dataset: PreparedRestoredDataset): Promise<void> {
  const signal = new AbortController().signal, text = await readBackupText(dataset.directory, 'Activation.json', 4096, signal);
  const marker = { schemaVersion: 1, kind: 'musicbridge-restored-dataset', id: dataset.id, restoreId: dataset.restoreId, restoreManifestHash: dataset.restoreManifestHash, contentIncluded: dataset.contentIncluded, database: dataset.databaseFile };
  if (!same(JSON.parse(text), marker) || !same(JSON.parse(await readBackupText(dataset.directory, 'ActivationComplete.json', 1024, signal)), { schemaVersion: 1, id: dataset.id, manifestHash: archiveDigest(text) })) unavailable();
}
function checkDatabaseFiles(file: string, required: boolean): boolean {
  let exists = false, sidecar = false;
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try {
      const info = lstatSync(file + suffix);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || realpathSync(file + suffix) !== file + suffix) unavailable();
      if (suffix === '') { if (info.size < 1) unavailable(); exists = true; } else sidecar = true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (!exists && (required || sidecar)) unavailable();
  return exists;
}
function openRepository(file: string, required: boolean, check: () => void): CollectionRepository {
  check();
  const exists = checkDatabaseFiles(file, required), identity = exists ? lstatSync(file, { bigint: true }) : undefined;
  if (exists) {
    const inspection = new DatabaseSync(file, { readOnly: true, allowExtension: false });
    try {
      inspection.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;');
      const version = Number(inspection.prepare('PRAGMA user_version').get()?.user_version);
      if (!Number.isInteger(version) || version < 1 || version > 15 || inspection.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' || inspection.prepare('PRAGMA foreign_key_check').all().length) unavailable();
      inspection.prepare('SELECT id FROM collection_models LIMIT 1').all();
    } finally { inspection.close(); }
  }
  check(); checkDatabaseFiles(file, required);
  const repository = createCollectionRepository({ filePath: file });
  try {
    // 工厂是惰性的；最小真实读取才能证明本次启动实际打开了选定数据库。
    repository.list({ offset: 0, limit: 1 }); check(); checkDatabaseFiles(file, true);
    const opened = lstatSync(file, { bigint: true });
    if (identity && (opened.dev !== identity.dev || opened.ino !== identity.ino)) unavailable();
    return repository;
  } catch (error) { repository.close(); throw error; }
}

/** pending 仅租用候选；Runtime 成功后由调用方 commit，失败不覆盖现有工作库。 */
export async function openCollectionDataset(dataDirectory: string): Promise<OpenCollectionDataset> {
  if (!path.isAbsolute(dataDirectory) || dataDirectory.length > 1024 || dataDirectory.includes('\0') || dataDirectory.split(path.sep).some(part => part === '.' || part === '..') || dataDirectory === path.parse(dataDirectory).root) unavailable();
  const store = createBackupWorkflowStore({ filePath: path.join(dataDirectory, 'backup-maintenance.v1.sqlite') });
  let repository: CollectionRepository | undefined;
  try {
    const boot = store.activations.beginBoot();
    const privateRoot = { ...await authorizeSourceDirectory(dataDirectory), id: randomUUID() };
    let pendingActivationId: string | undefined, selectedActivation: StoredRestoreActivation | undefined, selectedDataset: PreparedRestoredDataset | undefined;
    function authorizeRestoreSource(value: StoredRestoreActivation): void {
      const dataset = value.dataset, job = store.job(value.view.restoreJobId);
      if (!dataset || job.request.kind !== 'restore' || job.view.kind !== 'restore' || job.view.state !== 'succeeded'
        || job.view.destinationId !== job.request.destinationId || dataset.restoreId !== job.view.id || !job.output || !same(job.output, dataset.source)) return unavailable();
      const destination = store.root(job.request.destinationId);
      if (destination.view.kind !== 'restore-destination' || !destination.view.authorized || !destination.capability.authorized
        || job.output.path !== path.join(destination.capability.path, job.view.id)) unavailable();
      checkRoot(destination.capability); checkRoot(job.output);
    }
    function authorizePending(value: StoredRestoreActivation): void {
      authorizeRestoreSource(value); checkDatasetTree(privateRoot, value.dataset!);
    }
    if (boot.pending) {
      try {
        authorizePending(boot.pending);
        const dataset = boot.pending.dataset!;
        await verifyPreparedDataset(dataset, new AbortController().signal);
        authorizePending(boot.pending);
        repository = openRepository(checkDatasetTree(privateRoot, dataset), true, () => { authorizePending(boot.pending!); });
        selectedDataset = dataset; selectedActivation = boot.pending; pendingActivationId = boot.pending.view.id;
      } catch {
        repository?.close(); repository = undefined;
        // 指针回退只做一次；写失败则外层 fail closed，不伪称回滚成功。
        store.activations.fail(boot.pending.view.id, 'BOOT_FAILED');
      }
    }
    if (!repository) {
      if (boot.active) {
        const dataset = boot.active.dataset; if (!dataset) return unavailable();
        const file = checkDatasetTree(privateRoot, dataset); await checkActiveMarker(dataset);
        store.datasetIdentities.assertKnown(`activation:${dataset.id}`, file);
        repository = openRepository(file, true, () => { checkDatasetTree(privateRoot, dataset); }); selectedDataset = dataset; selectedActivation = boot.active;
      } else repository = openRepository(path.join(privateRoot.path, 'collection.v1.sqlite'), false, () => { checkRoot(privateRoot); });
    }
    let settled = false, closed = false;
    const selected = repository;
    const datasetIdentity = store.datasetIdentities.bind(selectedDataset ? `activation:${selectedDataset.id}` : 'default', selectedDataset ? path.join(selectedDataset.database.path, 'collection.sqlite') : path.join(privateRoot.path, 'collection.v1.sqlite'), !selectedDataset);
    return {
      datasetId: datasetIdentity.datasetId,
      assertIdentity() { if (closed) unavailable(); checkRoot(privateRoot); if (selectedDataset) checkDatasetTree(privateRoot, selectedDataset); datasetIdentity.assertCurrent(); },
      repository: selected, store, privateRoot,
      ...(selectedDataset ? { contentBinding: createRestoredContentBinding(selectedDataset, { isAuthorized: () => {
        try {
          const current = store.activations.get(selectedActivation!.view.id);
          if (store.activations.overview().activeId !== current.view.id || current.view.state !== 'active' || !same(current.dataset, selectedDataset)) return false;
          authorizeRestoreSource(current); return true;
        } catch { return false; }
      } }) } : {}),
      ...(pendingActivationId ? { pendingActivationId } : {}),
      commit() {
        if (closed) unavailable();
        if (!pendingActivationId || settled) return;
        authorizePending(boot.pending!); store.activations.commitBoot(pendingActivationId); settled = true;
      },
      fail() {
        if (!pendingActivationId || settled) return;
        try { store.activations.fail(pendingActivationId, 'BOOT_FAILED'); }
        catch { /* Runtime 可能已关闭维护库；保留 activating，让下次启动记录 BOOT_INTERRUPTED。 */ }
        settled = true;
      },
      close() { if (closed) return; closed = true; try { selected.close(); } finally { store.close(); } },
    };
  } catch {
    try { repository?.close(); } finally { store.close(); }
    return unavailable();
  }
}
