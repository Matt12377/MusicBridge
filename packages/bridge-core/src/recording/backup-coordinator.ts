import { randomUUID } from 'node:crypto';
import { mkdir, statfs } from 'node:fs/promises';
import path from 'node:path';
import { BACKUP_INDEX_ISSUE_DETAIL_LIMIT, BACKUP_INDEX_MISSING_FACTS, isActivateRestoredDataset, type ActivateRestoredDataset, type RestoreActivationView, type AuthorizeBackupRoot, type StartBackupJob, type BackupJobView, type BackupSummary, type BackupJobIssue } from '@music-bridge/contracts';
import type { CollectionRepository } from '../collection/repository.js';
import { archiveDigest, previewArchiveRoot } from './archive-files.js';
import { authorizeSourceDirectory, type RootCapability } from './source-files.js';
import { BackupError, checkBackupRoot, readBackupText } from './backup-files.js';
import { createArchiveBackup, verifyArchiveBackup, type ArchiveBackupManifest, type ArchiveContentBinding } from './backup-package.js';
import { prepareRestoredDataset } from './restore-activation-files.js';
import { restoreArchiveBackup } from './restore-package.js';
import { authorizeArchiveBackupZipFile, createArchiveBackupZip, inspectArchiveBackupZip, recoverPublishedArchiveBackupZip, restoreArchiveBackupZip, verifyArchiveBackupZip, type ArchiveBackupZipFile } from './backup-zip.js';
import { rebuildArchiveIndex } from './restore-index.js';
import { BackupWorkflowError, type BackupWorkflowStore } from './backup-workflow-store.js';

export function createBackupCoordinator(options: { store: BackupWorkflowStore; repository: CollectionRepository; privateRoot?: RootCapability; contentBinding?: ArchiveContentBinding; protectedRoots?: readonly RootCapability[]; createBackup?: typeof createArchiveBackup; prepareDataset?: typeof prepareRestoredDataset }) {
  const { store, repository } = options;
  const controllers = new Map<string, AbortController>(), scheduledJobs = new Set<string>(), scheduledActivations = new Set<string>();
  let tail = Promise.resolve(), closed = false, closing: Promise<void> | undefined;
  store.recoverInterrupted();
  const conflict = (): never => { throw new BackupWorkflowError('BACKUP_CONFLICT'); };
  const protectedRoots = (): RootCapability[] => [...options.privateRoot ? [options.privateRoot] : [], ...options.contentBinding?.protectedRoots ?? [], ...options.protectedRoots ?? [], ...repository.sources.roots(), ...repository.preparations.destinations(), ...repository.archive.candidates().map(c => c.parent)];
  function root(id: string): RootCapability { const value = store.root(id); if (!value.view.authorized || !value.capability.authorized) return conflict(); return value.capability; }
  function zipFile(id: string): ArchiveBackupZipFile { const value = store.root(id); if (!value.view.authorized || value.view.kind !== 'backup-source' || value.view.format !== 'zip' || !value.zipFile) return conflict(); return value.zipFile; }
  function summaryFromManifest(manifest: ArchiveBackupManifest, manifestHash: string): BackupSummary {
    return { backupId: manifest.id, manifestHash, mode: manifest.mode, objectCount: manifest.objects.length, copyBytes: manifest.contentIncluded ? manifest.objects.reduce((n, f) => n + f.size, 0) : 0, operationCount: manifest.operations.length, incompleteCount: manifest.incompleteOperationIds.length };
  }
  async function summary(manifest: ArchiveBackupManifest, directory: RootCapability, signal: AbortSignal): Promise<BackupSummary> {
    const text = await readBackupText(directory, 'Backup.json', 32 * 1024 * 1024, signal);
    if (JSON.stringify(JSON.parse(text)) !== JSON.stringify(manifest)) throw new BackupError('BACKUP_INVALID');
    const complete = JSON.parse(await readBackupText(directory, 'Complete.json', 1024, signal));
    if (JSON.stringify(complete) !== JSON.stringify({ schemaVersion: 1, id: manifest.id, manifestHash: archiveDigest(text) })) throw new BackupError('BACKUP_INVALID');
    return summaryFromManifest(manifest, archiveDigest(text));
  }
  async function preflightZipPeak(destination: RootCapability, mode: 'metadata' | 'archive-content'): Promise<void> {
    // ZIP 备份保留目录包；事前至少为两份去重内容预留空间，快照后再按实际 entries 精确复核。
    const objects = new Map<string, number>();
    if (mode === 'archive-content') for (const operation of repository.archive.operations()) {
      if (operation.phase !== 'FINALIZED' || !operation.owned) continue;
      for (const file of operation.owned.files) {
        const previous = objects.get(file.sha256);
        if (previous !== undefined && previous !== file.size) throw new BackupError('BACKUP_INVALID');
        objects.set(file.sha256, file.size);
      }
    }
    const contentBytes = [...objects.values()].reduce((sum, size) => sum + size, 0);
    if (!Number.isSafeInteger(contentBytes)) throw new BackupError('BACKUP_IO_ERROR');
    const minimum = BigInt(contentBytes) * 2n + 128n * 1024n * 1024n;
    const space = await statfs(destination.path, { bigint: true });
    if (space.bavail * space.bsize < minimum) throw new BackupError('BACKUP_IO_ERROR');
  }
  async function recoverPublished(id: string): Promise<void> {
    const saved = store.job(id);
    if (saved.request.kind !== 'backup' || saved.request.format !== 'zip' || saved.view.state === 'succeeded') return;
    try {
      const destination = root(saved.request.rootId), absolute = path.join(destination.path, id);
      const packageDirectory = { ...await authorizeSourceDirectory(absolute), id: randomUUID() };
      if (packageDirectory.path !== absolute) return;
      const recovered = await recoverPublishedArchiveBackupZip({ packageDirectory, destination, id });
      if (!recovered) return;
      const resultSummary = await summary(recovered.manifest, packageDirectory, new AbortController().signal);
      store.reconcilePublishedZip(id, resultSummary, recovered.file);
    } catch { /* 无法证明 final 时保持原失败/中断回执，不重跑备份或覆写证据。 */ }
  }
  async function execute(id: string): Promise<void> {
    if (closed || store.job(id).view.state !== 'queued') return;
    const controller = new AbortController(); controllers.set(id, controller);
    const timer = setTimeout(() => controller.abort('BACKUP_IO_ERROR'), 30 * 60 * 1000);
    try {
      store.markRunning(id);
      const request = store.job(id).request, source = root(request.rootId), signal = controller.signal;
      await checkBackupRoot(source);
      if (request.kind === 'backup') {
        await previewArchiveRoot(source.path, protectedRoots());
        if (request.format === 'zip') await preflightZipPeak(source, request.mode);
        const result = await (options.createBackup ?? createArchiveBackup)({ repository, destination: source, id, mode: request.mode, userConfirmed: true, signal, ...(options.contentBinding ? { contentBinding: options.contentBinding } : {}) });
        if (request.format === 'zip') {
          const zip = await createArchiveBackupZip({ packageDirectory: result.directory, destination: source, id, userConfirmed: true, signal });
          // ZIP final 链接发布后使用中性信号核验和落账；迟到取消不改写成功事实。
          const resultSummary = await summary(zip.manifest, result.directory, new AbortController().signal);
          store.finish(id, { summary: resultSummary }, zip.file.parent, zip.file);
        } else {
          // 文件层完成标记已发布；取消若晚于发布边界，保留成功回执。
          const resultSummary = await summary(result.manifest, result.directory, new AbortController().signal);
          store.finish(id, { summary: resultSummary }, result.directory);
        }
      } else if (request.kind === 'verify') {
        if (store.root(request.rootId).view.format === 'zip') {
          if (!options.privateRoot) throw new BackupWorkflowError('BACKUP_UNAVAILABLE');
          const verified = await verifyArchiveBackupZip(zipFile(request.rootId), options.privateRoot, signal);
          store.finish(id, { summary: summaryFromManifest(verified.manifest, verified.manifestHash) });
        } else {
          const verified = await verifyArchiveBackup(source, signal);
          store.finish(id, { summary: await summary(verified, source, signal) });
        }
      } else if (request.kind === 'restore') {
        const zipped = store.root(request.rootId).view.format === 'zip';
        const current = zipped
          ? await inspectArchiveBackupZip(zipFile(request.rootId), signal).then(value => summaryFromManifest(value.manifest, value.manifestHash))
          : await verifyArchiveBackup(source, signal).then(value => summary(value, source, signal));
        const previous = store.job(request.verificationId).view.summary;
        if (!previous || JSON.stringify(previous) !== JSON.stringify(current)) throw new BackupError('BACKUP_INVALID');
        const result = zipped
          ? await restoreArchiveBackupZip({ file: zipFile(request.rootId), destination: root(request.destinationId), protectedRoots: protectedRoots(), id, userConfirmed: true, signal, expectedBackupIdentity: { id: current.backupId, manifestHash: current.manifestHash } })
          : await restoreArchiveBackup({ backup: source, destination: root(request.destinationId), protectedRoots: protectedRoots(), id, userConfirmed: true, signal, expectedBackupIdentity: { id: current.backupId, manifestHash: current.manifestHash } });
        store.finish(id, { summary: current }, result.directory);
      } else {
        const index = await rebuildArchiveIndex({ directory: source, signal });
        const issueDetails = index.issues.slice(0, BACKUP_INDEX_ISSUE_DETAIL_LIMIT).map(issue => ({
          code: issue.code, ...(issue.operationId ? { operationId: issue.operationId } : {}), ...(issue.sha256 ? { sha256: issue.sha256 } : {}),
        }));
        store.finish(id, { index: {
          operationCount: index.operations.length, quarantinedCount: index.operations.filter(op => op.state === 'quarantined').length,
          issueCount: index.issues.length, issueDetails, issueDetailsOmittedCount: index.issues.length - issueDetails.length,
          missingFacts: BACKUP_INDEX_MISSING_FACTS.filter(fact => index.missingFacts.includes(fact)), historyTrusted: false, inventoryReconstructed: false,
        } });
      }
    } catch (error) {
      const issue: BackupJobIssue = controller.signal.aborted
        ? controller.signal.reason === 'AUTHORIZATION_REVOKED' ? 'AUTHORIZATION_REVOKED' : controller.signal.reason === 'INTERRUPTED' ? 'INTERRUPTED' : controller.signal.reason === 'BACKUP_IO_ERROR' ? 'BACKUP_IO_ERROR' : 'CANCELLED'
        : error instanceof BackupError ? error.code : error instanceof BackupWorkflowError && error.code === 'BACKUP_UNAVAILABLE' ? 'BACKUP_UNAVAILABLE' : 'BACKUP_IO_ERROR';
      store.failJob(id, issue);
    } finally { clearTimeout(timer); controllers.delete(id); }
  }
  const api = {
    activationReceipt: (request: ActivateRestoredDataset) => ({ activation: store.activations.receipt(request) }),
    overview: () => store.overview(),
    activate(request: ActivateRestoredDataset): RestoreActivationView {
      if (closed || !options.privateRoot || !isActivateRestoredDataset(request)) return conflict();
      const restore = store.job(request.restoreJobId);
      if (restore.view.kind !== 'restore' || restore.view.state !== 'succeeded' || !restore.output) return conflict();
      const activation = store.activations.begin(request);
      if (activation.view.state !== 'preparing' || scheduledActivations.has(activation.view.id)) return activation.view;
      const id = activation.view.id, privateRoot = options.privateRoot;
      scheduledActivations.add(id);
      tail = tail.then(async () => {
        const controller = new AbortController(); controllers.set(id, controller);
        const timeout = setTimeout(() => controller.abort('INTERRUPTED'), 30 * 60_000);
        try {
          if (closed || restore.request.kind !== 'restore') throw new Error('激活已中断');
          root(restore.request.destinationId); await checkBackupRoot(privateRoot);
          const absolute = path.join(privateRoot.path, 'restored-datasets');
          try { await mkdir(absolute, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
          const destination = { ...await authorizeSourceDirectory(absolute), id: randomUUID() };
          if (destination.path !== absolute) throw new BackupError('BACKUP_DESTINATION_INVALID');
          const prepared = await (options.prepareDataset ?? prepareRestoredDataset)({ id, source: restore.output!, destination, userConfirmed: true, signal: controller.signal });
          root(restore.request.destinationId); await checkBackupRoot(privateRoot); controller.signal.throwIfAborted();
          store.activations.prepared(id, prepared);
        } catch { store.activations.fail(id, closed ? 'PREPARATION_INTERRUPTED' : 'PREPARATION_FAILED'); }
        finally { clearTimeout(timeout); controllers.delete(id); scheduledActivations.delete(id); }
      }).catch(() => undefined);
      return activation.view;
    },
    authorizationReceipt(command: AuthorizeBackupRoot) {
      const value = store.authorizationReceipt(command.commandId); if (value && (value.kind !== command.kind || value.format !== command.format)) return conflict(); return { root: value ?? null };
    },
    async authorize(request: AuthorizeBackupRoot & { absolutePath: string }) {
      if (closed) return conflict();
      if (request.format === 'zip') {
        if (request.kind !== 'backup-source') return conflict();
        const zip = await authorizeArchiveBackupZipFile(request.absolutePath);
        await previewArchiveRoot(zip.parent.path, protectedRoots());
        return store.authorize({ commandId: request.commandId, kind: request.kind, format: 'zip' }, zip.parent, zip);
      }
      const capability = { ...await authorizeSourceDirectory(request.absolutePath), id: randomUUID() };
      await previewArchiveRoot(capability.path, protectedRoots());
      return store.authorize({ commandId: request.commandId, kind: request.kind }, capability);
    },
    start(request: StartBackupJob): BackupJobView {
      if (closed) return conflict();
      if (store.overview().activations.some(value => ['preparing','prepared','activating'].includes(value.state))) return conflict();
      const job = store.startJob(request);
      if (job.state === 'queued' && !scheduledJobs.has(job.id)) {
        scheduledJobs.add(job.id);
        tail = tail.then(() => execute(job.id)).finally(() => scheduledJobs.delete(job.id));
        // 查询和后续任务不被后台故障卡住；失败仍写入对应任务，仓库损坏时拒绝后续读取。
        tail = tail.catch(() => undefined);
      } else if (job.kind === 'backup' && job.format === 'zip' && ['failed','cancelled','interrupted'].includes(job.state) && !scheduledJobs.has(job.id)) {
        scheduledJobs.add(job.id);
        tail = tail.then(() => recoverPublished(job.id)).finally(() => scheduledJobs.delete(job.id));
        tail = tail.catch(() => undefined);
      }
      return job;
    },
    cancel(request: { commandId: string; id: string }): BackupJobView {
      const result = store.cancel(request); controllers.get(request.id)?.abort('CANCELLED'); return result;
    },
    revoke(request: { commandId: string; id: string }) {
      const result = store.revoke(request);
      let revokedActiveContent = false;
      // prepared 已不在内存排队集合中，撤权必须清除持久 pending，不能信任 dataset 内的旧授权副本。
      for (const activation of store.activations.overview().activations) {
        if (!['preparing', 'prepared', 'activating', 'active'].includes(activation.state)) continue;
        const restored = store.job(activation.restoreJobId);
        if (restored.request.kind === 'restore' && restored.request.destinationId === request.id) {
          if (activation.state === 'active') { revokedActiveContent = true; continue; }
          controllers.get(activation.id)?.abort('AUTHORIZATION_REVOKED');
          store.activations.fail(activation.id, activation.state === 'activating' ? 'BOOT_FAILED' : 'PREPARATION_FAILED');
        }
      }
      for (const id of scheduledJobs) {
        const job = store.job(id);
        if (job.request.rootId === request.id || job.request.kind === 'restore' && job.request.destinationId === request.id || revokedActiveContent && job.request.kind === 'backup' && job.request.mode === 'archive-content') {
          const controller = controllers.get(id);
          if (controller) controller.abort('AUTHORIZATION_REVOKED'); else store.failJob(id, 'AUTHORIZATION_REVOKED');
        }
      }
      return result;
    },
    idle: () => tail,
    close(): Promise<void> {
      if (closing) return closing;
      closed = true; for (const controller of controllers.values()) controller.abort('INTERRUPTED');
      closing = tail.then(() => { store.recoverInterrupted(); store.close(); }); return closing;
    },
  };
  return api;
}
export type BackupCoordinator = ReturnType<typeof createBackupCoordinator>;
