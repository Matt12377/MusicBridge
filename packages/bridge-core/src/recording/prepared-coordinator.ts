import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isCollectionId, isSourceAction, isSelectPreparedRequest, isPreviewPreparedImportRequest, isStartPreparedImportRequest, isReviewPreparedRequest, isFreezePreparedRequest, isRawRenderAsset, type SelectPreparedRequest, type PreparedSelection, type PreviewPreparedImportRequest, type StartPreparedImportRequest, type PreparedImportProposal, type PreparedImportJob, type ReviewPreparedRequest, type FreezePreparedRequest, type PreparedReview, type FrozenPrepared, type RawRenderAsset } from '@music-bridge/contracts';
import { retainedRenderManifest, type PreparedStore, type PreparedInput, type StoredPreparedJob } from './prepared-store.js';
import type { PreparationStore } from './preparation-store.js';
import type { PreparationCoordinator } from './preparation-coordinator.js';
import type { SourceStore } from './source-store.js';
import { BridgeError } from '../shared/errors.js';
import { mediaFingerprint } from './media-store.js';
import { authorizeSourceDirectory, probeReadonlySource, sourceFileAvailability, sourceRelativePath, SourceFileError } from './source-files.js';
import { authorizePreparationDestination, assertPreparationOutsideSources, createPreparationDirectory, copyPreparationFile, publishPreparation, verifyPublishedPreparation, PreparationFileError, type PreparationOutput } from './preparation-files.js';
import { assessRender } from './render-conformance.js';
const invalid = (message = 'Render 输入已改变或未确认，请重新检查。'): never => { throw new BridgeError('BAD_REQUEST', message, { httpStatus: 400 }); };
export function createPreparedCoordinator({ store, preparationStore, preparation, sourceStore, copy = copyPreparationFile, afterPublish }: { store: PreparedStore; preparationStore: PreparationStore; preparation: PreparationCoordinator; sourceStore: SourceStore; copy?: typeof copyPreparationFile; afterPublish?: () => Promise<void> }) {
  let closed = false, recoveryError: unknown;
  const active = new Map<string, { destinationId: string; selectionIds: readonly string[]; controller: AbortController; promise: Promise<void> }>();
  const reads = new Map<AbortController, { destinationId: string; selectionIds: readonly string[]; promise: Promise<PreparedInput> }>();
  const recoveries = new Map<string, { destinationId: string; controller: AbortController }>();
  const reviews = new Map<AbortController, { destinationId: string; promise: Promise<boolean> }>();
  const pendingFailures = new Map<string, PreparedImportJob['failure']>();
  function flushFailures(): void { for (const [id, failure] of pendingFailures) { store.fail(id, failure); pendingFailures.delete(id); } }
  const unsubscribe = preparation.onDestinationRevoked(id => {
    for (const operation of [...active.values(), ...recoveries.values()]) if (operation.destinationId === id) operation.controller.abort('DESTINATION_REVOKED');
    for (const [controller, operation] of reads) if (operation.destinationId === id) controller.abort('DESTINATION_REVOKED');
    for (const [controller, operation] of reviews) if (operation.destinationId === id) controller.abort('DESTINATION_REVOKED');
  });
  const recovered = (async () => {
    for (const pending of store.pending()) {
      if (closed) return;
      store.fail(pending.public.id);
      const controller = new AbortController(); recoveries.set(pending.public.id, { destinationId: pending.public.destinationId, controller });
      try {
        // 只恢复已发布且字节完整的保留副本；不重读用户原件，不重放复制。
        if (pending.owned && pending.manifestHash && preparationStore.destination(pending.public.destinationId).authorized && await verifyPublishedPreparation(pending.owned, pending.files, pending.manifestHash, controller.signal) && !closed && !controller.signal.aborted && preparationStore.destination(pending.public.destinationId).authorized) store.finish(pending.public.id);
      } finally { recoveries.delete(pending.public.id); }
    }
  })().catch(error => { recoveryError = error; });
  async function ready(): Promise<void> { await recovered; if (recoveryError) throw recoveryError; if (closed) return invalid('PREP 服务已关闭。'); }
  function preparationContext(id: string) {
    const job = preparationStore.job(id);
    if (!job || job.public.state !== 'completed' || job.public.workspaceId !== id) return invalid('必须先选择已完成的 Logic 工作区。');
    return { master: job.input.master, layout: job.input.layout };
  }
  function permissions(input: PreparedInput, checkSelections = true): void {
    if (!preparationStore.destination(input.destination.id).authorized) throw new PreparationFileError();
    if (checkSelections && input.selections.some(s => !store.selection(s.public.id).public.authorized)) throw new SourceFileError('REVOKED');
    assertPreparationOutsideSources([input.destination.path], sourceStore.roots());
  }
  async function sourceCheck(input: PreparedInput): Promise<void> {
    permissions(input);
    for (const s of input.selections) if (await sourceFileAvailability(store.selection(s.public.id).root, s.relative, s.evidence.signature) !== 'ONLINE') throw new SourceFileError('CONTENT_CHANGED');
    permissions(input);
  }
  async function input(request: PreviewPreparedImportRequest, signal: AbortSignal): Promise<PreparedInput> {
    const { master, layout } = preparationContext(request.preparationId), destination = preparationStore.destination(request.destinationId);
    if (!destination.authorized) throw new PreparationFileError();
    const current = await authorizePreparationDestination(destination.path, sourceStore.roots());
    if (current.dev !== destination.dev || current.ino !== destination.ino) throw new PreparationFileError();
    const selections: PreparedInput['selections'][number][] = [];
    const requiredSides = layout.timeline.sides.filter(s => s.tracks.length > 0);
    if (request.selectionIds.length !== requiredSides.length) return invalid('每个有内容的面须选择一个原始 WAV，空面不需要文件。');
    for (const [i, id] of request.selectionIds.entries()) {
      signal.throwIfAborted(); const selected = store.selection(id);
      if (!selected.public.authorized || selected.public.preparationId !== request.preparationId || selected.public.side !== requiredSides[i]!.name || await sourceFileAvailability(selected.root, selected.relative, selected.signature) !== 'ONLINE') throw new SourceFileError('CONTENT_CHANGED');
      const evidence = await probeReadonlySource(selected.root, selected.relative, signal), technical = evidence.technical;
      if (!/^(?:wav|wave)$/iu.test(technical.container) || technical.sampleFrames === undefined || ![1,2].includes(technical.channels)) return invalid('原始 Render 仅接受可验证的单声道或立体声 WAV。');
      const asset: RawRenderAsset = { id, side: selected.public.side, sha256: evidence.sha256, size: evidence.size, format: 'wav', sampleRate: technical.sampleRate, channelLayout: technical.channels === 1 ? 'mono' : 'stereo', totalFrames: technical.sampleFrames, createdAt: selected.createdAt, creationTimeEvidence: selected.creationTimeEvidence };
      if (!isRawRenderAsset(asset)) return invalid('Render 技术信息不完整。');
      selections.push({ ...selected, evidence, asset });
    }
    const proposal: PreparedImportProposal = { ...request, draftId: master.draftId, masterVersionId: master.id, layoutVersionId: layout.id, assets: selections.map(s => s.asset), bytes: selections.reduce((sum, s) => sum + s.asset.size, 0), destinationLabel: destination.label, storagePolicy: 'separate-retained-originals-v1', proposalFingerprint: '', executionReady: false };
    proposal.proposalFingerprint = mediaFingerprint({ proposal, destination, signatures: selections.map(s => s.evidence.signature) });
    const result = { master, layout, destination, proposal, selections }; await sourceCheck(result); signal.throwIfAborted(); return result;
  }
  async function readInput(request: PreviewPreparedImportRequest): Promise<PreparedInput> {
    if (closed || !isPreviewPreparedImportRequest(request) || reads.size >= 2) return invalid('Render 预览输入无效或已有两项读取，请稍后重试。');
    const captured = structuredClone(request), controller = new AbortController(), promise = input(captured, controller.signal);
    reads.set(controller, { destinationId: request.destinationId, selectionIds: [...request.selectionIds], promise });
    try { return await promise; } finally { reads.delete(controller); }
  }
  function launch(job: StoredPreparedJob): PreparedImportJob {
    const controller = new AbortController();
    const promise = (async () => {
      let published = false;
      try {
        await sourceCheck(job.input); controller.signal.throwIfAborted();
        const owned = await createPreparationDirectory(job.input.destination, job.public.id, job.input.layout.spec.format, 'raw-render');
        store.update(job.public.id, { owned });
        const check = (): void => { controller.signal.throwIfAborted(); permissions(job.input); assertPreparationOutsideSources([owned.root.path, ...owned.directories.map(d => d.path)], sourceStore.roots()); };
        const files: PreparationOutput[] = [];
        for (const [i, selection] of job.input.selections.entries()) {
          check(); files.push(await copy(owned, `Originals/${selection.asset.side}.wav`, store.selection(selection.public.id).root, selection.relative, selection.asset, controller.signal)); check();
          store.update(job.public.id, { files: [...files] }, i + 1);
        }
        const manifest = retainedRenderManifest({ operationId: job.public.id, preparationId: job.public.preparationId, masterVersionId: job.input.master.id, layoutVersionId: job.input.layout.id, contentHash: job.input.master.contentHash, plannedTimelineHash: job.input.layout.timelineHash, assets: job.input.proposal.assets, files });
        store.update(job.public.id, { files, manifestHash: createHash('sha256').update(manifest).digest('hex') });
        await sourceCheck(job.input); check();
        const hash = await publishPreparation(owned, files, manifest, controller.signal); published = true;
        await afterPublish?.(); await sourceCheck(job.input); check();
        if (!await verifyPublishedPreparation(owned, files, hash, controller.signal)) throw new PreparationFileError();
        check(); if (!closed) store.finish(job.public.id);
      } catch (error) {
        if (!closed) {
          const failure: PreparedImportJob['failure'] = controller.signal.reason === 'SELECTION_REVOKED' ? 'SOURCE_INVALID' : controller.signal.reason === 'DESTINATION_REVOKED' ? 'DESTINATION_INVALID' : controller.signal.aborted ? 'CANCELLED' : error instanceof SourceFileError ? 'SOURCE_INVALID' : error instanceof PreparationFileError ? 'DESTINATION_INVALID' : published ? undefined : error instanceof Error && 'code' in error && error.code === 'ENOSPC' ? 'DISK_FULL' : 'IO_ERROR';
          try { store.fail(job.public.id, failure); } catch { pendingFailures.set(job.public.id, failure); }
        }
      } finally { active.delete(job.public.id); }
    })();
    active.set(job.public.id, { destinationId: job.public.destinationId, selectionIds: job.request.selectionIds, controller, promise }); return job.public;
  }
  async function review(request: ReviewPreparedRequest): Promise<PreparedReview> {
    await ready(); if (!isReviewPreparedRequest(request)) return invalid();
    const job = store.job(request.importJobId);
    if (!job || job.public.state !== 'completed' || !job.owned || !job.manifestHash) return invalid('原始 Render 尚未完整保存。');
    permissions(job.input, false);
    if (reviews.size >= 2) return invalid('已有两项 Render 核对，请稍后重试。');
    const controller = new AbortController(), promise = verifyPublishedPreparation(job.owned, job.files, job.manifestHash, controller.signal);
    reviews.set(controller, { destinationId: job.public.destinationId, promise });
    try { if (!await promise) return invalid('原始 Render 保留副本已缺失、改变或核对被取消。'); }
    finally { reviews.delete(controller); }
    if (closed) return invalid(); permissions(job.input, false);
    const conformance = assessRender(job.input.master, job.input.layout, job.public.assets!, request.assessment);
    const result: PreparedReview = { draftId: job.public.draftId, preparationId: job.public.preparationId, masterVersionId: job.input.master.id, layoutVersionId: job.input.layout.id, plannedTimeline: job.input.layout.timeline, assets: job.public.assets!, conformance, proposalFingerprint: '', executionReady: false };
    result.proposalFingerprint = mediaFingerprint({ request, result, rawManifestHash: job.manifestHash }); return result;
  }
  return {
    selectionReceipt(request: SelectPreparedRequest) { if (!isSelectPreparedRequest(request)) return invalid(); return store.selectionReceipt(request); },
    selections(preparationId: string) { if (!isCollectionId(preparationId)) return invalid(); preparationContext(preparationId); return { selections: store.selections(preparationId) }; },
    async select(request: SelectPreparedRequest, absolute: string): Promise<PreparedSelection> {
      await ready(); if (!isSelectPreparedRequest(request)) return invalid(); const prior = store.selectionReceipt(request); if (prior) return prior;
      const context = preparationContext(request.preparationId); if (!context.layout.timeline.sides.some(s => s.name === request.side && s.tracks.length > 0)) return invalid();
      let selected: Parameters<PreparedStore['select']>[1], label: string;
      try {
        if (!path.isAbsolute(absolute) || await realpath(absolute) !== absolute || path.extname(absolute).toLowerCase() !== '.wav') return invalid();
        const root = { ...await authorizeSourceDirectory(path.dirname(absolute)), id: request.commandId }, relative = sourceRelativePath(root, absolute), info = await lstat(absolute, { bigint: true });
        if (!info.isFile() || info.isSymbolicLink() || info.size < 1n || info.size > 68_719_476_736n) return invalid();
        const hasBirthtime = info.birthtimeNs > 0n;
        selected = { root, relative, signature: [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':'), createdAt: hasBirthtime ? new Date(Number(info.birthtimeNs / 1_000_000n)).toISOString() : new Date().toISOString(), creationTimeEvidence: hasBirthtime ? 'filesystem-birthtime' : 'first-observed' };
        label = path.basename(absolute).replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 240) || '原始 Render';
      } catch { return invalid('所选原始 WAV 不可读取或文件身份无效。'); }
      if (closed) return invalid(); return store.select(request, selected, label);
    },
    revoke(request: { commandId: string; id: string }) { if (!isSourceAction(request)) return invalid(); const result = store.revoke(request); for (const operation of active.values()) if (operation.selectionIds.includes(request.id)) operation.controller.abort('SELECTION_REVOKED'); for (const [controller, operation] of reads) if (operation.selectionIds.includes(request.id)) controller.abort('SELECTION_REVOKED'); return result; },
    list(draftId: string) { if (!isCollectionId(draftId)) return invalid(); flushFailures(); return store.list(draftId); },
    async previewImport(request: PreviewPreparedImportRequest) { await ready(); return (await readInput(request)).proposal; },
    async startImport(request: StartPreparedImportRequest): Promise<PreparedImportJob> {
      await ready(); if (!isStartPreparedImportRequest(request)) return invalid(); const captured = structuredClone(request); flushFailures(); const prior = store.cachedImport(captured); if (prior) return prior;
      let result: PreparedInput;
      try { result = await readInput({ preparationId: captured.preparationId, destinationId: captured.destinationId, selectionIds: captured.selectionIds }); }
      catch (error) { if (error instanceof SourceFileError || error instanceof PreparationFileError) return invalid(); throw error; }
      if (result.proposal.proposalFingerprint !== captured.proposalFingerprint) return invalid();
      const job = store.start(captured, result); return active.has(job.public.id) || job.public.state !== 'running' ? job.public : launch(job);
    },
    job(id: string) { if (!isCollectionId(id)) return invalid(); flushFailures(); return { job: store.job(id)?.public ?? null }; },
    cancel(request: { commandId: string; id: string }) { if (!isSourceAction(request)) return invalid(); flushFailures(); const result = store.cancel(request); active.get(request.id)?.controller.abort(); recoveries.get(request.id)?.controller.abort(); return result; },
    review: (request: ReviewPreparedRequest) => review(structuredClone(request)),
    async freeze(request: FreezePreparedRequest): Promise<FrozenPrepared> {
      await ready(); if (!isFreezePreparedRequest(request)) return invalid(); const captured = structuredClone(request), prior = store.cachedFreeze(captured); if (prior) return prior;
      const result = await review({ importJobId: captured.importJobId, assessment: captured.assessment, daw: captured.daw, processingLineage: captured.processingLineage });
      if (result.proposalFingerprint !== captured.proposalFingerprint || !['MATCHED','ACCEPTED_VARIANCE'].includes(result.conformance.status)) return invalid('必须先确认符合要求的实际 Render 时间线。');
      return store.freeze(captured, result);
    },
    async idle() { await ready(); await Promise.all([...active.values()].map(j => j.promise)); flushFailures(); },
    async close() { closed = true; unsubscribe(); for (const controller of [...reads.keys(), ...reviews.keys()]) controller.abort(); for (const operation of [...active.values(), ...recoveries.values()]) operation.controller.abort(); await recovered; await Promise.allSettled([...active.values()].map(j => j.promise).concat([...reads.values(), ...reviews.values()].map(r => r.promise.then(() => {})))); },
  };
}
export type PreparedCoordinator = ReturnType<typeof createPreparedCoordinator>;
