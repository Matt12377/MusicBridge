import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isCollectionId, isPreparationZipTarget, isPreviewPreparationZipRequest, isStartPreparationZipRequest, isPreparationZipReceiptRequest, type PreparationZipJob, type PreparationZipProposal, type PreparationZipTarget, type PreparationZipReceiptRequest, type PreviewPreparationZipRequest, type StartPreparationZipRequest } from '@music-bridge/contracts';
import { BridgeError } from '../shared/errors.js';
import { mediaFingerprint } from './media-store.js';
import type { PreparationStore, StoredPreparationJob } from './preparation-store.js';
import { authorizeSourceDirectory, type RootCapability } from './source-files.js';
import { checkPreparationZipTarget, createPreparationZipTemp, planPreparationZip, preparationZipTempPath, publishPreparationZip, removeOwnedPreparationZipTemp, verifyPreparationZipPublication, writeAndVerifyPreparationZip, PreparationZipFileError, type PreparationZipPlan } from './preparation-export-files.js';
import type { PreparationZipStore, PreparationZipTargetBinding, StoredPreparationZipJob } from './preparation-export-store.js';

function invalid(message = 'ZIP 导出请求已失效，请重新选择另存目标并预览。'): never { throw new BridgeError('BAD_REQUEST', message, { httpStatus: 400 }); }
const absent = async (absolute: string): Promise<boolean> => { try { await lstat(absolute); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; } };
export interface AuthorizePreparationZipTarget {
  targetId: string; absolute: string; parentPath: string; parentDev: string; parentIno: string;
  datasetId: string; scopeId: string; generation: number; expiresAt: string;
}
export function createPreparationZipCoordinator({ store, preparations, datasetId, assertDataset = () => undefined, protectedRoots = () => [], verifyPublication = verifyPreparationZipPublication, beforePlan, afterTemp, beforePublish, afterPublish }: {
  store: PreparationZipStore; preparations: PreparationStore; datasetId: string; assertDataset?: () => void; protectedRoots?: () => readonly RootCapability[];
  verifyPublication?: typeof verifyPreparationZipPublication;
  /** 可控故障注入点；真实运行不传入，link 前后竞态由领域测试验证。 */
  beforePlan?: () => Promise<void>; afterTemp?: () => Promise<void>; beforePublish?: () => Promise<void>; afterPublish?: () => Promise<void>;
}) {
  const epoch = store.bootSession();
  let closed = false;
  let closing: Promise<void> | undefined;
  const targets = new Map<string, PreparationZipTargetBinding>();
  const scopeGenerations = new Map<string, number>();
  const closedScopes = new Set<string>();
  const active = new Map<string, { scopeId: string; controller: AbortController; lifecycle: AbortController; promise: Promise<void> }>();
  const operations = new Set<{ scopeId?: string; controller: AbortController; settled: Promise<void> }>();
  const recoveryController = new AbortController();
  let recoveryScope: string | undefined;
  const protectedTarget = (absolute: string): boolean => protectedRoots().some(root => absolute === root.path || absolute.startsWith(`${root.path}${path.sep}`));
  function persistedTargetLive(job: StoredPreparationZipJob): boolean {
    assertDataset();
    return !closed && store.sessionCurrent(epoch) && !job.recoveryRevoked && job.target.datasetId === datasetId && !protectedTarget(job.target.absolute) && preparations.destination(job.workspace.owned.destination.id).authorized;
  }
  function activeTargetLive(job: StoredPreparationZipJob): boolean {
    if (!persistedTargetLive(job)) return false;
    const target = targets.get(job.target.id);
    return !!target && target.scopeId === job.target.scopeId && target.generation === job.target.generation && !closedScopes.has(target.scopeId) && scopeGenerations.get(target.scopeId) === target.generation && store.targetCurrent(target, epoch);
  }
  function operation<T>(targetId: string | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const item: { scopeId?: string; controller: AbortController; settled: Promise<void> } = { controller, settled: Promise.resolve(), ...(targetId && targets.get(targetId) ? { scopeId: targets.get(targetId)!.scopeId } : {}) };
    operations.add(item);
    const result = (async () => { try { controller.signal.throwIfAborted(); return await run(controller.signal); } finally { operations.delete(item); } })();
    item.settled = result.then(() => undefined, () => undefined);
    return result;
  }
  let recoveryError: unknown;
  const recovered = (async () => {
    // 先核当前库身份；恢复激活库的旧路径和旧 scope 永不参与文件系统恢复。
    assertDataset();
    for (const pending of store.recoverable()) {
      if (closed || recoveryController.signal.aborted) return;
      assertDataset();
      const current = store.job(pending.public.id);
      if (!current) invalid('ZIP 恢复记录已失效。');
      if (!persistedTargetLive(current)) { if (store.sessionCurrent(epoch)) store.revokeTarget(current.public.id, epoch); continue; }
      recoveryScope = current.target.scopeId;
      let published = false;
      try { published = !!current.verified && await verifyPublication(current, recoveryController.signal); }
      finally { recoveryScope = undefined; }
      if (closed || recoveryController.signal.aborted) return;
      const after = store.job(current.public.id);
      if (!after) invalid('ZIP 恢复记录已失效。');
      if (!persistedTargetLive(after)) { if (store.sessionCurrent(epoch)) store.revokeTarget(after.public.id, epoch); continue; }
      if (published && mediaFingerprint([current.temp, current.verified]) === mediaFingerprint([after.temp, after.verified])) {
        const finished = store.finish(after.public.id, epoch);
        const receipt = store.job(after.public.id);
        if (receipt && persistedTargetLive(receipt) && !recoveryController.signal.aborted) await removeOwnedPreparationZipTemp({ ...receipt, public: finished }, () => {
          const latest = store.job(receipt.public.id);
          if (!latest || !persistedTargetLive(latest) || recoveryController.signal.aborted) invalid();
        });
      } else if (after.public.state === 'cancelling') store.completeCancellation(after.public.id, epoch);
      else if (after.public.state === 'running') store.fail(after.public.id, epoch);
    }
  })().catch(error => { recoveryError = error; });
  async function ready(): Promise<void> { await recovered; if (recoveryError) throw recoveryError; if (closed) invalid('ZIP 导出服务已关闭。'); assertDataset(); }
  function liveTarget(targetId: string, requireUnexpired = true): PreparationZipTargetBinding {
    const target = targets.get(targetId);
    if (target && requireUnexpired && Date.now() >= Date.parse(target.expiresAt)) { store.expireTarget(target.id, epoch); return invalid(); }
    if (!target || closedScopes.has(target.scopeId) || scopeGenerations.get(target.scopeId) !== target.generation || target.datasetId !== datasetId || protectedTarget(target.absolute) || !store.targetCurrent(target, epoch)) return invalid();
    assertDataset(); return target;
  }
  function currentWorkspace(id: string): StoredPreparationJob {
    const job = preparations.job(id);
    if (!job || job.public.state !== 'completed' || !job.owned || !job.manifestHash || !preparations.destination(job.public.destinationId).authorized) return invalid('工作区尚未完整生成或原归属已失效。');
    return job;
  }
  async function proposal(request: PreviewPreparationZipRequest, signal: AbortSignal): Promise<{ proposal: PreparationZipProposal; plan: PreparationZipPlan; workspace: StoredPreparationJob; target: PreparationZipTargetBinding }> {
    if (!isPreviewPreparationZipRequest(request)) return invalid();
    signal.throwIfAborted();
    const target = liveTarget(request.targetId), workspace = currentWorkspace(request.workspaceId);
    if (!workspace.owned) return invalid();
    await checkPreparationZipTarget(target, workspace.owned.root.path);
    signal.throwIfAborted(); liveTarget(request.targetId);
    if (!await absent(target.absolute)) return invalid('目标文件已存在；请选择新的 ZIP 文件名。');
    signal.throwIfAborted(); liveTarget(request.targetId);
    await beforePlan?.();
    signal.throwIfAborted(); liveTarget(request.targetId);
    const plan = await planPreparationZip(workspace, signal);
    signal.throwIfAborted(); liveTarget(request.targetId);
    const current = currentWorkspace(request.workspaceId);
    if (current.manifestHash !== workspace.manifestHash || current.public.draftId !== workspace.public.draftId) return invalid('工作区内容或授权已改变，请重新预览。');
    await checkPreparationZipTarget(target, workspace.owned.root.path);
    signal.throwIfAborted(); liveTarget(request.targetId);
    const result: PreparationZipProposal = {
      workspaceId: request.workspaceId, draftId: workspace.public.draftId, masterVersionId: workspace.input.master.id, layoutVersionId: workspace.input.layout.id,
      targetId: target.id, targetLabel: path.basename(target.absolute), manifestHash: workspace.manifestHash!, fileCount: plan.entries.length, sourceBytes: plan.sourceBytes,
      proposalFingerprint: '', executionReady: false,
    };
    result.proposalFingerprint = mediaFingerprint({ proposal: result, target, packageManifest: plan.packageManifest, entries: plan.entries });
    return { proposal: result, plan, workspace, target };
  }
  function launch(job: StoredPreparationZipJob, plan: PreparationZipPlan): PreparationZipJob {
    const controller = new AbortController();
    const lifecycle = new AbortController();
    const promise = Promise.resolve().then(async () => {
      let handle: Awaited<ReturnType<typeof createPreparationZipTemp>>['handle'] | undefined;
      try {
        // 已持久化的 Job 可在短时目标到期后继续；窗口 scope/代次仍须保持有效。
        const target = liveTarget(job.target.id, false);
        if (target.scopeId !== job.target.scopeId || target.generation !== job.target.generation || !await absent(target.absolute)) return invalid();
        const staged = await createPreparationZipTemp(target, job.public.id, job.workspace.owned.root.path, false);
        handle = staged.handle;
        if (!activeTargetLive(job)) return invalid();
        job = store.temp(job.public.id, staged.identity, epoch);
        await afterTemp?.();
        controller.signal.throwIfAborted(); liveTarget(target.id, false);
        const receipt = await writeAndVerifyPreparationZip(handle, plan.sources(controller.signal), plan.entries, plan.budget, controller.signal);
        await handle.close(); handle = undefined;
        const workspace = currentWorkspace(job.public.workspaceId);
        if (!workspace.owned || !await planPreparationZip(workspace, controller.signal).then(current => mediaFingerprint(current.entries) === mediaFingerprint(job.entries) && current.packageManifest === job.packageManifest)) throw new PreparationZipFileError('CONTENT_CHANGED');
        controller.signal.throwIfAborted(); liveTarget(target.id, false);
        job = store.verified(job.public.id, { sha256: receipt.sha256, size: receipt.size }, epoch);
        await beforePublish?.();
        controller.signal.throwIfAborted(); liveTarget(target.id, false);
        await publishPreparationZip(target, job, controller.signal, () => { if (!activeTargetLive(job)) invalid(); liveTarget(target.id, false); });
        await afterPublish?.();
        // link 成功后即使取消抵达，也只复核已发布字节并补完整回执，绝不回滚用户目标。
        if (!activeTargetLive(job) || lifecycle.signal.aborted) return;
        if (!await verifyPublication(job, lifecycle.signal)) throw new PreparationZipFileError('RECOVERY_REQUIRED');
        const current = store.job(job.public.id);
        if (!current || !activeTargetLive(current) || lifecycle.signal.aborted) return;
        const finished = store.finish(current.public.id, epoch);
        await removeOwnedPreparationZipTemp({ ...current, public: finished }, () => {
          const latest = store.job(current.public.id);
          if (!latest || !activeTargetLive(latest) || lifecycle.signal.aborted) invalid();
        });
      } catch (error) {
        if (handle) await handle.close().catch(() => undefined);
        try {
          const current = store.job(job.public.id);
          if (!current) return;
          if (!activeTargetLive(current) || lifecycle.signal.aborted) {
            assertDataset();
            if (!closed && store.sessionCurrent(epoch) && (current.recoveryRevoked || protectedTarget(current.target.absolute) || !preparations.destination(current.workspace.owned.destination.id).authorized)) store.revokeTarget(current.public.id, epoch);
            return;
          }
          const published = !!current.verified && await verifyPublication(current, lifecycle.signal);
          const after = store.job(current.public.id);
          if (!after || !activeTargetLive(after) || lifecycle.signal.aborted) return;
          if (published && mediaFingerprint([current.temp, current.verified]) === mediaFingerprint([after.temp, after.verified])) {
            const finished = store.finish(after.public.id, epoch);
            await removeOwnedPreparationZipTemp({ ...after, public: finished }, () => {
              const latest = store.job(after.public.id);
              if (!latest || !activeTargetLive(latest) || lifecycle.signal.aborted) invalid();
            });
          } else if (after.public.state === 'cancelling') store.completeCancellation(after.public.id, epoch);
          else if (after.public.state === 'running') {
            const failure = controller.signal.aborted ? 'CANCELLED' : error instanceof PreparationZipFileError ? error.code : error instanceof Error && 'code' in error && error.code === 'ENOSPC' ? 'DISK_FULL' : error instanceof Error && 'code' in error && error.code === 'EEXIST' ? 'TARGET_INVALID' : 'IO_ERROR';
            store.fail(after.public.id, epoch, failure);
          }
        } catch { /* 数据库/磁盘不确定时保留原任务与临时文件，冷启动只读核查。 */ }
      } finally { active.delete(job.public.id); }
    });
    active.set(job.public.id, { scopeId: job.target.scopeId, controller, lifecycle, promise });
    return job.public;
  }
  return {
    async authorizeTarget(input: AuthorizePreparationZipTarget): Promise<PreparationZipTarget> {
      await ready();
      if (!isCollectionId(input.targetId) || !isCollectionId(input.datasetId) || input.datasetId !== datasetId || !isCollectionId(input.scopeId) || !Number.isSafeInteger(input.generation) || input.generation < 0 || closedScopes.has(input.scopeId) || targets.size >= 64) return invalid();
      const previous = scopeGenerations.get(input.scopeId);
      if (previous !== undefined && input.generation < previous) return invalid();
      const expiry = Date.parse(input.expiresAt);
      if (!Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 5 * 60_000 || typeof input.absolute !== 'string' || !path.isAbsolute(input.absolute) || input.absolute.includes('\0') || input.absolute.split(path.sep).some(part => part === '.' || part === '..') || path.dirname(input.absolute) !== input.parentPath || !isPreparationZipTarget({ id: input.targetId, label: path.basename(input.absolute), expiresAt: input.expiresAt }) || await realpath(input.parentPath) !== input.parentPath) return invalid();
      const parent = { ...await authorizeSourceDirectory(input.parentPath), id: randomUUID() };
      if (parent.path !== input.parentPath || parent.dev !== input.parentDev || parent.ino !== input.parentIno || protectedTarget(input.absolute) || !await absent(input.absolute)) return invalid();
      if (closed || closedScopes.has(input.scopeId) || (scopeGenerations.get(input.scopeId) ?? input.generation) > input.generation || protectedTarget(input.absolute)) return invalid();
      assertDataset();
      const target: PreparationZipTargetBinding = { id: input.targetId, absolute: input.absolute, parent, datasetId: input.datasetId, scopeId: input.scopeId, generation: input.generation, expiresAt: input.expiresAt };
      store.authorizeTarget(target, epoch);
      // 更高代次先淘汰旧目标；过期或关闭后的旧授权不能靠迟到 IPC 复活。
      if (previous === undefined || input.generation > previous) {
        scopeGenerations.set(input.scopeId, input.generation);
        for (const [id, binding] of targets) if (binding.scopeId === input.scopeId) targets.delete(id);
        for (const running of active.values()) if (running.scopeId === input.scopeId) { running.controller.abort('SCOPE_CHANGED'); running.lifecycle.abort('SCOPE_CHANGED'); }
        for (const pending of operations) if (pending.scopeId === input.scopeId) pending.controller.abort('SCOPE_CHANGED');
      }
      if (targets.has(input.targetId)) return invalid();
      targets.set(input.targetId, target);
      return { id: target.id, label: path.basename(target.absolute), expiresAt: target.expiresAt };
    },
    invalidateScope(scopeId: string): void {
      closedScopes.add(scopeId);
      store.revokeScope(scopeId, epoch);
      if (recoveryScope === scopeId) recoveryController.abort('SCOPE_CLOSED');
      for (const [id, binding] of targets) if (binding.scopeId === scopeId) targets.delete(id);
      for (const running of active.values()) if (running.scopeId === scopeId) { running.controller.abort('SCOPE_CLOSED'); running.lifecycle.abort('SCOPE_CLOSED'); }
      for (const pending of operations) if (pending.scopeId === scopeId) pending.controller.abort('SCOPE_CLOSED');
    },
    preview(request: PreviewPreparationZipRequest): Promise<PreparationZipProposal> {
      return operation(isPreviewPreparationZipRequest(request) ? request.targetId : undefined, async signal => {
        await ready(); signal.throwIfAborted(); return (await proposal(request, signal)).proposal;
      });
    },
    start(request: StartPreparationZipRequest): Promise<PreparationZipJob> {
      return operation(isStartPreparationZipRequest(request) ? request.targetId : undefined, async signal => {
        await ready(); signal.throwIfAborted();
        if (!isStartPreparationZipRequest(request)) return invalid();
        const cached = store.cached(request);
        if (cached) return cached.public;
        const prepared = await proposal({ workspaceId: request.workspaceId, targetId: request.targetId }, signal);
        signal.throwIfAborted(); liveTarget(request.targetId);
        if (prepared.proposal.proposalFingerprint !== request.proposalFingerprint) return invalid();
        const stored: StoredPreparationZipJob = {
          public: { id: request.commandId, workspaceId: request.workspaceId, draftId: prepared.proposal.draftId, state: 'running', targetLabel: prepared.proposal.targetLabel, fileCount: prepared.plan.entries.length, completedFiles: 0 },
          request, proposal: prepared.proposal, target: structuredClone(prepared.target),
          workspace: { owned: structuredClone(prepared.workspace.owned!), files: structuredClone(prepared.workspace.files), manifestHash: prepared.workspace.manifestHash! },
          packageManifest: prepared.plan.packageManifest, entries: prepared.plan.entries, createdAt: new Date().toISOString(),
        };
        const result = store.start(stored, epoch);
        return active.has(result.public.id) || result.public.state !== 'running' ? result.public : launch(result, prepared.plan);
      });
    },
    async list(draftId: string) { await ready(); if (!isCollectionId(draftId)) return invalid(); return store.list(draftId); },
    async job(id: string) { await ready(); if (!isCollectionId(id)) return invalid(); return { job: store.job(id)?.public ?? null }; },
    async receipt(request: PreparationZipReceiptRequest) {
      await ready(); if (!isPreparationZipReceiptRequest(request)) return invalid();
      return store.receipt(request);
    },
    async cancel(request: { commandId: string; id: string }) {
      await ready(); if (!isCollectionId(request.commandId) || !isCollectionId(request.id)) return invalid();
      const result = store.cancel(request, epoch);
      const running = active.get(request.id);
      if (running) running.controller.abort('CANCELLED');
      else if (result.state === 'cancelling') {
        const current = store.job(request.id);
        if (current?.verified && !closedScopes.has(current.target.scopeId) && persistedTargetLive(current) && await verifyPublication(current, recoveryController.signal)) {
          const after = store.job(request.id);
          if (after && !closedScopes.has(after.target.scopeId) && persistedTargetLive(after)) return store.finish(request.id, epoch);
        }
        return store.completeCancellation(request.id, epoch);
      }
      return result;
    },
    async idle() { await ready(); await Promise.all([...operations].map(item => item.settled)); await Promise.all([...active.values()].map(job => job.promise)); },
    async close() {
      if (closing) return closing;
      closed = true; targets.clear(); recoveryController.abort('CLOSED');
      closing = (async () => {
        let revocationError: unknown;
        try { store.revokeSession(epoch); } catch (error) { revocationError = error; }
        const pending = [...operations].map(item => { item.controller.abort('CLOSED'); return item.settled; });
        const running = [...active.values()].map(job => { job.controller.abort('CLOSED'); job.lifecycle.abort('CLOSED'); return job.promise; });
        await Promise.all([recovered, ...pending, ...running]);
        if (revocationError) throw revocationError;
      })();
      return closing;
    },
  };
}
export type PreparationZipCoordinator = ReturnType<typeof createPreparationZipCoordinator>;
