import { isCollectionId, isSourceAction, isInitializeArchiveRequest, isPreviewArchiveRequest, isStartArchiveRequest, isVerifyArchiveRequest, archiveObjectTotals, type InitializeArchiveRequest, type PreviewArchiveRequest, type StartArchiveRequest, type ArchiveOperationView, type ArchiveRootView, type ArchiveCheck, type VerifyArchiveRequest } from '@music-bridge/contracts';
import { BridgeError } from '../shared/errors.js';
import { ArchiveFileError, previewArchiveRoot, initializePlannedArchiveRoot, checkArchiveRoot, verifyArchiveObjects, type ArchiveFilePhase } from './archive-files.js';
import { archiveDescriptors, captureArchiveInput, checkArchiveInputPermissions, previewArchiveInput, type ArchiveInputContext } from './archive-input.js';
import { createArchiveTransactionRunner } from './archive-transactions.js';
import type { ArchiveStore, StoredArchiveOperation } from './archive-store.js';
import type { ArchiveRootCandidate } from './archive-workflow-store.js';
import type { ExecutionStore } from './execution-store.js';
import type { PreparationStore } from './preparation-store.js';
import type { PreparationCoordinator } from './preparation-coordinator.js';
import type { SourceStore } from './source-store.js';
import type { SourceEvidenceService } from './source-evidence.js';
import { sourceRootAvailability, copyReadonlySource, type RootCapability } from './source-files.js';
import { assertPreparationOutsideSources } from './preparation-files.js';
import { mediaFingerprint } from './media-store.js';

const invalid = (message = '归档授权、输入或确认已失效，请重新检查。'): never => { throw new BridgeError('BAD_REQUEST', message, { httpStatus: 400 }); };
interface Dependencies {
  store: ArchiveStore; executionStore: ExecutionStore; preparationStore: PreparationStore; sourceStore: SourceStore;
  sources: SourceEvidenceService; preparation: PreparationCoordinator;
  copy?: typeof copyReadonlySource; availableBytes?: (root: RootCapability) => Promise<bigint>;
  initialize?: typeof initializePlannedArchiveRoot;
  afterPhase?: (phase: ArchiveFilePhase) => Promise<void>; operationTimeoutMs?: number;
}
interface Scope { rootId: string; controller: AbortController; promise: Promise<unknown>; sourceIds: readonly string[]; destinationIds: readonly string[]; usesInputs(): boolean; finish(): void }
export function createArchiveCoordinator({ store, executionStore, preparationStore, sourceStore, sources, preparation, copy = copyReadonlySource, initialize = initializePlannedArchiveRoot, availableBytes, afterPhase, operationTimeoutMs = 30 * 60_000 }: Dependencies) {
  if (!Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs < 1 || operationTimeoutMs > 30 * 60_000) return invalid('归档期限无效。');
  let closed = false, recoveryError: unknown;
  const active = new Map<string, Scope>(), reads = new Map<string, Scope>(), cancelledReads = new Set<string>();
  const initializations = new Map<string, Scope & { promise: Promise<ArchiveRootView> }>();
  function ensureOpen(): void { if (closed) return invalid('归档服务已关闭。'); }
  const unroot = sources.onRootRevoked(id => { for (const op of [...active.values(), ...reads.values()]) if (op.usesInputs() && op.sourceIds.includes(id)) op.controller.abort('SOURCE_REVOKED'); });
  const undestination = preparation.onDestinationRevoked(id => { for (const op of [...active.values(), ...reads.values()]) if (op.usesInputs() && op.destinationIds.includes(id)) op.controller.abort('DESTINATION_REVOKED'); });
  function scope(rootId: string, sourceIds: readonly string[] = [], destinationIds: readonly string[] = []): Scope {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort('TIME_LIMIT'), operationTimeoutMs);
    return { rootId, sourceIds, destinationIds, controller, promise: Promise.resolve(), usesInputs: () => true, finish: () => clearTimeout(timer) };
  }
  function view(op: StoredArchiveOperation): ArchiveOperationView {
    const workflow = op.request.workflow, asset = executionStore.asset(op.request.lineage.executionAssetId);
    if (!workflow || !asset) return invalid('此归档没有公开工作流记录。');
    const { assetId, rootId, sourcePolicy } = workflow.request, totals = archiveObjectTotals(archiveDescriptors(op.request.files)); if (!totals) return invalid();
    return { id: op.request.id, assetId, rootId, sourcePolicy, draftId: asset.draftId, masterVersionId: asset.masterVersionId, layoutVersionId: asset.layoutVersionId, phase: op.phase, active: active.has(op.request.id), ...(op.issue ? { issue: op.issue } : {}), ...totals, createdAt: workflow.createdAt, formalReady: false };
  }
  async function rootView(candidate: ArchiveRootCandidate): Promise<ArchiveRootView> {
    const base = { id: candidate.id, label: candidate.parent.label };
    if (!candidate.authorized) return { ...base, state: 'revoked' };
    if (await sourceRootAvailability(candidate.parent) !== 'ONLINE') return { ...base, state: 'offline' };
    if (!candidate.initialized) return { ...base, state: initializations.has(candidate.id) ? 'initializing' : candidate.initialization ? 'recovery-required' : 'selected' };
    try { await checkArchiveRoot(store.root(candidate.id)); return { ...base, state: 'ready' }; }
    catch { return { ...base, state: 'recovery-required' }; }
  }
  function captured(request: PreviewArchiveRequest | StartArchiveRequest): ArchiveInputContext {
    try {
      const candidate = store.candidate(request.rootId); if (!candidate.authorized || !candidate.initialized) return invalid();
      return captureArchiveInput(request, store.root(request.rootId), executionStore, sourceStore);
    } catch { return invalid(); }
  }
  async function read<T>(id: string, op: Scope, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!isCollectionId(id) || reads.has(id) || reads.size >= 2 || cancelledReads.delete(id)) { op.finish(); return invalid('读取已取消或已有两项核验，请稍后重试。'); }
    const promise = Promise.resolve().then(() => fn(op.controller.signal)); op.promise = promise; reads.set(id, op);
    try { return await promise; } catch { return invalid(op.controller.signal.aborted ? '归档读取已取消或超过期限。' : undefined); }
    finally { op.finish(); reads.delete(id); }
  }
  function needsInputs(id: string): boolean { const phase = store.operation(id)?.phase; return phase === 'REQUESTED' || phase === 'INTENT_WRITTEN'; }
  function launch(stored: StoredArchiveOperation): void {
    const id = stored.request.id; if (active.has(id)) return;
    const job = executionStore.job(stored.request.lineage.executionAssetId)!;
    const sourceIds = stored.request.files.filter(f => f.role === 'exact-source' && 'source' in f).map(f => 'source' in f ? f.source.id : '');
    const destinationIds = [job.input.destination.id, ...(job.input.retained ? [job.input.retained.owned.destination.id] : [])];
    const op = scope(stored.request.rootId, sourceIds, destinationIds); op.usesInputs = () => needsInputs(id);
    const check = (): void => {
      op.controller.signal.throwIfAborted(); ensureOpen(); const root = store.root(op.rootId);
      assertPreparationOutsideSources([root.root.path], sourceStore.roots());
      if (op.usesInputs() && (sourceIds.some(key => !sourceStore.root(key).authorized) || destinationIds.some(key => !preparationStore.destination(key).authorized))) return invalid();
    };
    const runner = createArchiveTransactionRunner({ store, copy: async (...args) => { check(); const result = await copy(...args); check(); return result; }, ...(availableBytes ? { availableBytes: () => availableBytes(store.root(op.rootId).root) } : {}), afterPhase: async phase => { check(); await afterPhase?.(phase); check(); } });
    op.promise = Promise.resolve().then(async () => { check(); await runner.run(id, op.controller.signal); }).catch(() => {
      // 内核保留具体失败及部分文件；启动前失败也要留下可恢复状态。
      const current = store.operation(id);
      if (current && !current.issue) store.noteIssue(id, op.controller.signal.aborted ? 'CANCELLED' : 'ARCHIVE_RECOVERY_REQUIRED');
    }).finally(() => { op.finish(); active.delete(id); });
    active.set(id, op);
  }
  const recovered = Promise.resolve().then(async () => {
    for (const saved of store.operations()) {
      while (!closed && active.size >= 2) await Promise.race([...active.values()].map(op => op.promise));
      if (closed) return;
      const op = store.operation(saved.request.id)!;
      if (!op.request.workflow || op.phase === 'FINALIZED' || op.issue === 'CANCELLED' && op.phase !== 'DB_COMMITTED') continue;
      launch(op); await active.get(op.request.id)!.promise;
    }
  }).catch(error => { recoveryError = error; });
  // 恢复在后台串行推进；普通读取和取消不等待全部历史操作完成。
  async function ready(): Promise<void> { ensureOpen(); if (recoveryError) return invalid('归档恢复尚未完成，请检查本地数据库。'); }
  return {
    async roots() { ensureOpen(); return { roots: await Promise.all(store.candidates().map(rootView)) }; },
    async authorizationReceipt(commandId: string) { ensureOpen(); if (!isCollectionId(commandId)) return invalid(); const prior = store.authorizationReceipt(commandId); return { root: prior ? await rootView(prior) : null }; },
    async authorize(commandId: string, absolutePath: string): Promise<ArchiveRootView> {
      ensureOpen(); if (!isCollectionId(commandId)) return invalid(); const prior = store.authorizationReceipt(commandId); if (prior) return rootView(prior);
      try { const parent = await previewArchiveRoot(absolutePath, sourceStore.roots()); ensureOpen(); return rootView(store.authorizeCandidate(commandId, parent)); } catch { return invalid(); }
    },
    async initialize(request: InitializeArchiveRequest): Promise<ArchiveRootView> {
      ensureOpen(); if (!isInitializeArchiveRequest(request)) return invalid();
      const value = store.beginInitialization(request); if (value.initialized) return rootView(value);
      const prior = initializations.get(value.id); if (prior) return prior.promise;
      const op = scope(value.id), check = (): void => { ensureOpen(); op.controller.signal.throwIfAborted(); if (!store.candidate(value.id).authorized) return invalid(); };
      const promise = Promise.resolve().then(async () => {
        try { check(); const root = await initialize(value.initialization!, sourceStore.roots(), true, check); check(); return await rootView(store.finishInitialization(value.id, root)); }
        catch { return invalid('归档初始化未完成；请检查目录授权后重试原操作。'); }
        finally { op.finish(); initializations.delete(value.id); }
      });
      initializations.set(value.id, { ...op, promise }); return promise;
    },
    async revoke(request: { commandId: string; id: string }): Promise<ArchiveRootView> {
      ensureOpen(); if (!isSourceAction(request)) return invalid(); const value = store.revokeCandidate(request);
      for (const op of [...active.values(), ...reads.values(), ...initializations.values()]) if (op.rootId === request.id) op.controller.abort('ARCHIVE_REVOKED');
      return rootView(value);
    },
    async preview(request: PreviewArchiveRequest) {
      await ready(); if (!isPreviewArchiveRequest(request)) return invalid(); const value = captured(request);
      const { readId, ...selection } = request;
      return read(readId, scope(request.rootId, value.sourceIds, value.destinationIds), signal => previewArchiveInput(selection, value, signal, () => { ensureOpen(); store.root(request.rootId); checkArchiveInputPermissions(value, preparationStore, sourceStore, signal); }, availableBytes));
    },
    async start(request: StartArchiveRequest): Promise<ArchiveOperationView> {
      await ready(); if (!isStartArchiveRequest(request)) return invalid(); const prior = store.cached(request); if (prior) return view(prior);
      if (active.size >= 2) return invalid('已有两项归档，请等待或取消。');
      const value = captured(request), { commandId, proposalFingerprint, userConfirmed: _confirmed, ...selection } = request;
      return read(commandId, scope(request.rootId, value.sourceIds, value.destinationIds), async signal => {
        const check = (): void => { ensureOpen(); store.root(request.rootId); checkArchiveInputPermissions(value, preparationStore, sourceStore, signal); };
        const proposal = await previewArchiveInput(selection, value, signal, check, availableBytes);
        if (proposal.proposalFingerprint !== proposalFingerprint || mediaFingerprint(captured(request).files) !== mediaFingerprint(value.files)) return invalid('归档内容已改变，请重新预览。');
        if (proposal.availableBytes < proposal.requiredBytes) return invalid('归档目录容量不足。'); check();
        if (active.size >= 2) return invalid('已有两项归档，请稍后重试确认。');
        const op = store.request({ id: commandId, rootId: request.rootId, files: value.files, lineage: { executionAssetId: request.assetId, masterVersionId: proposal.masterVersionId, layoutVersionId: proposal.layoutVersionId }, confirmed: true, workflow: { request: structuredClone(request), createdAt: new Date().toISOString() } });
        launch(op); return view(op);
      });
    },
    list(draftId: string) { ensureOpen(); executionStore.list(draftId); return { draftId, operations: store.operations().filter(op => op.request.workflow && executionStore.asset(op.request.lineage.executionAssetId)?.draftId === draftId).reverse().map(view) }; },
    operation(id: string) { ensureOpen(); if (!isCollectionId(id)) return invalid(); const op = store.operation(id); return { operation: op?.request.workflow ? view(op) : null }; },
    cancel(request: { commandId: string; id: string }) {
      ensureOpen(); const result = store.control('cancel', request);
      if (!result.replayed && result.operation.phase !== 'DB_COMMITTED' && result.operation.phase !== 'FINALIZED') active.get(request.id)?.controller.abort('USER_CANCELLED');
      return view(result.operation);
    },
    async resume(request: { commandId: string; id: string }) {
      await ready(); if (!isSourceAction(request)) return invalid();
      if (active.has(request.id)) return invalid('归档仍在结束，请稍后重试恢复。');
      if (active.size >= 2) return invalid('已有两项归档，请稍后重试。');
      const result = store.control('resume', request); if (!result.replayed && result.operation.phase !== 'FINALIZED') launch(result.operation); return view(result.operation);
    },
    async verify(request: VerifyArchiveRequest): Promise<ArchiveCheck> {
      await ready(); if (!isVerifyArchiveRequest(request)) return invalid(); const stored = store.operation(request.id); if (!stored?.request.workflow) return invalid();
      return read(request.readId, scope(stored.request.rootId), async signal => {
        let reason: ArchiveCheck['reason'];
        try {
          store.root(stored.request.rootId);
          if (!stored.owned || !['DB_COMMITTED','FINALIZED'].includes(stored.phase)) throw new ArchiveFileError('ARCHIVE_RECOVERY_REQUIRED');
          await verifyArchiveObjects(stored.owned, signal); signal.throwIfAborted(); store.root(stored.request.rootId);
        } catch (error) { if (signal.aborted) return invalid('归档核验已取消。'); reason = !store.candidate(stored.request.rootId).authorized || error instanceof ArchiveFileError && error.code === 'ARCHIVE_ROOT_INVALID' ? 'ARCHIVE_ROOT_INVALID' : 'ARCHIVE_RECOVERY_REQUIRED'; }
        return { id: request.id, state: reason ? 'unavailable' : 'verified', checkedAt: new Date().toISOString(), ...(reason ? { reason } : {}), formalReady: false };
      });
    },
    cancelRead(id: string): { cancelled: true } { ensureOpen(); if (!isCollectionId(id)) return invalid(); const op = reads.get(id); if (op) op.controller.abort(); else { if (cancelledReads.size >= 1000) cancelledReads.delete(cancelledReads.values().next().value!); cancelledReads.add(id); } return { cancelled: true }; },
    async idle() { await recovered; await ready(); await Promise.all([...active.values(), ...initializations.values()].map(op => op.promise)); },
    async close() { closed = true; unroot(); undestination(); const running = [...active.values(), ...reads.values(), ...initializations.values()]; for (const op of running) op.controller.abort('CLOSE'); await Promise.allSettled([recovered, ...running.map(op => op.promise)]); },
  };
}
export type ArchiveCoordinator = ReturnType<typeof createArchiveCoordinator>;
