import { createHash } from 'node:crypto';
import path from 'node:path';
import { isCollectionId, isSourceAction, isPreviewPreparationRequest, isStartPreparationRequest, type PreparationDestination, type PreviewPreparationRequest, type StartPreparationRequest, type PreparationJob, type PreparationFailure, type SourceTechnical } from '@music-bridge/contracts';
import { BridgeError } from '../shared/errors.js';
import type { SourceStore } from './source-store.js';
import type { SourceEvidenceService } from './source-evidence.js';
import type { PreparationStore, PreparationInput, StoredPreparationJob } from './preparation-store.js';
import { mediaFingerprint } from './media-store.js';
import { sourceFileAvailability, SourceFileError } from './source-files.js';
import { authorizePreparationDestination, assertPreparationOutsideSources, createPreparationDirectory, checkPreparationOwnership, copyPreparationFile, writePreparationFile, publishPreparation, verifyPublishedPreparation, PreparationFileError, type PreparationOutput } from './preparation-files.js';
const invalid = (message = '工作区提案已失效，请重新预览并确认。'): never => { throw new BridgeError('BAD_REQUEST', message, { httpStatus: 400 }); };
const publicDestination = (root: { id: string; label: string; authorized: boolean }): PreparationDestination => ({ id: root.id, label: root.label, authorized: root.authorized });
export function createPreparationCoordinator({ store, sourceStore, sources, copy = copyPreparationFile, afterPublish }: { store: PreparationStore; sourceStore: SourceStore; sources: SourceEvidenceService; copy?: typeof copyPreparationFile; afterPublish?: () => Promise<void> }) {
  let closed = false;
  const destinationRevoked = new Set<(id: string) => void>();
  const active = new Map<string, { destinationId: string; roots: readonly string[]; controller: AbortController; promise: Promise<void> }>();
  const pendingFailures = new Map<string, PreparationFailure | undefined>();
  function flushFailures(): void { for (const [id, failure] of pendingFailures) { store.fail(id, failure); pendingFailures.delete(id); } }
  const unsubscribe = sources.onRootRevoked(id => { for (const job of active.values()) if (job.roots.includes(id)) job.controller.abort('SOURCE_REVOKED'); });
  const recoveryControllers = new Map<string, AbortController>();
  let recoveryError: unknown;
  const recovered = (async () => {
    for (const pending of store.pending()) {
      if (closed) return;
      // 未完成复制只中断；有发布意图时仅读取独占输出，不重读源、不重放复制。
      store.fail(pending.public.id);
      const controller = new AbortController(); recoveryControllers.set(pending.public.destinationId, controller);
      try {
        if (pending.owned && pending.manifestHash && store.destination(pending.public.destinationId).authorized && await verifyPublishedPreparation(pending.owned, pending.files, pending.manifestHash, controller.signal) && !closed && store.destination(pending.public.destinationId).authorized) store.finish(pending.public.id);
      } finally { recoveryControllers.delete(pending.public.destinationId); }
    }
  })().catch(error => { recoveryError = error; });
  async function ready(): Promise<void> { await recovered; if (recoveryError) throw recoveryError; }
  function bindings(input: PreparationInput) {
    const planned = input.layout.timeline.sides.flatMap(s => s.tracks);
    return input.master.content.tracks.map((track, index) => {
      if (planned[index]?.trackId !== track.trackId) return invalid();
      const binding = sourceStore.binding(planned[index]!.sourceBindingId);
      if (!binding.userConfirmed || binding.invalidated || binding.evidence.sha256 !== track.source.sha256 || binding.evidence.size !== track.source.size || mediaFingerprint(binding.evidence.technical) !== mediaFingerprint(track.source.technical)) throw new SourceFileError('CONTENT_CHANGED');
      return { track, binding };
    });
  }
  async function checkSources(input: PreparationInput): Promise<void> {
    for (const { binding } of bindings(input)) if (await sourceFileAvailability(sourceStore.root(binding.rootId), binding.relative, binding.evidence.signature) !== 'ONLINE') throw new SourceFileError('CONTENT_CHANGED');
  }
  async function input(request: PreviewPreparationRequest): Promise<PreparationInput> {
    if (closed || !isPreviewPreparationRequest(request)) return invalid();
    const { master, layout } = store.frozen(request.layoutVersionId), destination = store.destination(request.destinationId);
    if (!destination.authorized) throw new PreparationFileError();
    const current = await authorizePreparationDestination(destination.path, sourceStore.roots());
    if (current.dev !== destination.dev || current.ino !== destination.ino) throw new PreparationFileError();
    const proposal = { draftId: master.draftId, masterVersionId: master.id, layoutVersionId: layout.id, destinationId: destination.id, contentHash: master.contentHash, timelineHash: layout.timelineHash, trackCount: master.content.tracks.length, bytes: master.content.tracks.reduce((sum, t) => sum + t.source.size, 0), proposalFingerprint: '', executionReady: false as const };
    proposal.proposalFingerprint = mediaFingerprint({ proposal, destination });
    const result = { master, layout, destination, proposal }; await checkSources(result); return result;
  }
  function launch(job: StoredPreparationJob): PreparationJob {
    const controller = new AbortController(), rootIds = bindings(job.input).map(b => b.binding.rootId);
    const promise = (async () => {
      let published = false;
      try {
        const current = await input({ layoutVersionId: job.input.layout.id, destinationId: job.input.destination.id });
        if (current.proposal.proposalFingerprint !== job.request.proposalFingerprint) return invalid();
        controller.signal.throwIfAborted();
        assertPreparationOutsideSources([path.join(job.input.destination.path, `MusicBridge-Preparation-${job.public.id}`)], sourceStore.roots());
        const owned = await createPreparationDirectory(job.input.destination, job.public.id, job.input.layout.spec.format);
        store.update(job.public.id, { owned });
        const checkDestination = (): void => { if (!store.destination(job.public.destinationId).authorized) throw new PreparationFileError(); assertPreparationOutsideSources([owned.root.path, ...owned.directories.map(d => d.path)], sourceStore.roots()); };
        const files: PreparationOutput[] = [], lineage: { trackId: string; sourceBindingId: string; workingCopy: string; sha256: string; size: number; technical: SourceTechnical }[] = [];
        for (const [index, { track, binding }] of bindings(job.input).entries()) {
          controller.signal.throwIfAborted(); checkDestination();
          const container = track.source.technical.container.toLowerCase(), extension = /wav|wave/u.test(container) ? 'wav' : /aiff/u.test(container) ? 'aiff' : /flac/u.test(container) ? 'flac' : invalid('源容器不支持工作副本。');
          const relative = `Sources/${String(index + 1).padStart(3, '0')}.${extension}`;
          files.push(await copy(owned, relative, sourceStore.root(binding.rootId), binding.relative, track.source, controller.signal));
          checkDestination();
          lineage.push({ trackId: track.trackId, sourceBindingId: binding.id, workingCopy: relative, sha256: track.source.sha256, size: track.source.size, technical: track.source.technical });
          store.update(job.public.id, { files: [...files] }, index + 1);
        }
        const json = (v: unknown): Buffer => Buffer.from(JSON.stringify(v, null, 2) + '\n');
        checkDestination();
        files.push(await writePreparationFile(owned, 'SourceLineage.json', json(lineage)));
        // TSV 单元格消除分隔符及公式前缀；曲序固定为冻结母版，不读取当前草稿。
        const cell = (v: string): string => v.replace(/[\t\r\n]/gu, ' ').replace(/^[=+@-]/u, "'$&");
        checkDestination();
        files.push(await writePreparationFile(owned, 'Tracklist.tsv', Buffer.from(['序号\t曲目\t源绑定', ...job.input.master.content.tracks.map((track, i) => `${i + 1}\t${cell(track.metadata.title)}\t${lineage[i]!.sourceBindingId}`)].join('\n') + '\n')));
        checkDestination();
        files.push(await writePreparationFile(owned, 'README.txt', Buffer.from('Logic 工作副本\n请手动导入 Sources，并按 Planned Timeline 安排曲序及留白。Bounce Targets 仅是输出位置，不表示已经生成或验证渲染音频。工作副本可以编辑；再导入 MusicBridge 时必须重新校验。原件保持只读。本目录不是归档或执行资产。\n')));
        const manifest = json({ schemaVersion: 1, kind: 'logic-working-copy', operationId: job.public.id, masterVersionId: job.input.master.id, layoutVersionId: job.input.layout.id, contentHash: job.input.master.contentHash, timelineHash: job.input.layout.timelineHash, plannedTimeline: job.input.layout.timeline, files, executionReady: false });
        // 先持久化发布意图，再写最终清单；冷启动可验证确切归属及 Hash 后补回执。
        store.update(job.public.id, { files, manifestHash: createHash('sha256').update(manifest).digest('hex') });
        await checkSources(job.input); controller.signal.throwIfAborted(); checkDestination();
        const manifestHash = await publishPreparation(owned, files, manifest, controller.signal); published = true;
        await afterPublish?.(); await checkSources(job.input); controller.signal.throwIfAborted();
        if (!await verifyPublishedPreparation(owned, files, manifestHash, controller.signal)) throw new PreparationFileError();
        controller.signal.throwIfAborted(); checkDestination();
        if (!closed) store.finish(job.public.id);
      } catch (error) {
        if (!closed) {
          const failure: PreparationFailure | undefined = controller.signal.reason === 'SOURCE_REVOKED' ? 'SOURCE_INVALID' : controller.signal.reason === 'DESTINATION_REVOKED' ? 'DESTINATION_INVALID' : controller.signal.aborted ? 'CANCELLED' : error instanceof SourceFileError ? 'SOURCE_INVALID' : error instanceof PreparationFileError ? 'DESTINATION_INVALID' : published ? undefined : error instanceof Error && 'code' in error && error.code === 'ENOSPC' ? 'DISK_FULL' : 'IO_ERROR';
          try { store.fail(job.public.id, failure); } catch { pendingFailures.set(job.public.id, failure); }
        }
      } finally { active.delete(job.public.id); }
    })();
    active.set(job.public.id, { destinationId: job.public.destinationId, roots: rootIds, controller, promise }); return job.public;
  }
  return {
    onDestinationRevoked(listener: (id: string) => void) { destinationRevoked.add(listener); return () => { destinationRevoked.delete(listener); }; },
    destinations: () => store.destinations().map(publicDestination),
    authorizationReceipt(id: string) { if (!isCollectionId(id)) return invalid(); const prior = store.authorizationReceipt(id); return prior ? publicDestination(prior) : null; },
    async authorize(commandId: string, absolute: string): Promise<PreparationDestination> {
      if (closed || !isCollectionId(commandId)) return invalid();
      const prior = store.authorizationReceipt(commandId); if (prior) return publicDestination(prior);
      let capability: Awaited<ReturnType<typeof authorizePreparationDestination>>;
      try { capability = await authorizePreparationDestination(absolute, sourceStore.roots()); }
      catch { return invalid('目标目录不可授权，请选择源目录之外的可用目录。'); }
      // 数据库写入失败仍保留模糊回执语义，不能误报为确定未接受。
      return publicDestination(store.authorize(commandId, capability));
    },
    revoke(request: { commandId: string; id: string }) { if (!isSourceAction(request)) return invalid(); const result = store.revoke(request); recoveryControllers.get(request.id)?.abort('DESTINATION_REVOKED'); for (const job of active.values()) if (job.destinationId === request.id) job.controller.abort('DESTINATION_REVOKED'); for (const listener of destinationRevoked) listener(request.id); return publicDestination(result); },
    list(draftId: string) { if (!isCollectionId(draftId)) return invalid(); flushFailures(); return store.list(draftId); },
    async preview(request: PreviewPreparationRequest) { await ready(); return (await input(request)).proposal; },
    async start(request: StartPreparationRequest): Promise<PreparationJob> { await ready(); if (closed || !isStartPreparationRequest(request)) return invalid(); flushFailures(); const prior = store.cached(request); if (prior) return prior; let prepared: PreparationInput;
      try { prepared = await input({ layoutVersionId: request.layoutVersionId, destinationId: request.destinationId }); }
      catch (error) { if (error instanceof SourceFileError || error instanceof PreparationFileError || error instanceof Error && 'code' in error && ['ENOENT','EACCES','ELOOP','ENOTDIR'].includes(String(error.code))) return invalid(); throw error; }
       if (prepared.proposal.proposalFingerprint !== request.proposalFingerprint) return invalid(); const job = store.start(request, prepared); return active.has(job.public.id) || job.public.state !== 'running' ? job.public : launch(job); },
    job(id: string) { if (!isCollectionId(id)) return invalid(); flushFailures(); return { job: store.job(id)?.public ?? null }; },
    async context(id: string): Promise<{ absolutePath: string }> {
      if (closed || !isCollectionId(id)) return invalid(); await ready(); flushFailures();
      const job = store.job(id);
      if (!job?.owned || job.public.state !== 'completed' || !store.destination(job.public.destinationId).authorized) throw new PreparationFileError();
      await checkPreparationOwnership(job.owned);
      if (!store.destination(job.public.destinationId).authorized) throw new PreparationFileError();
      return { absolutePath: job.owned.root.path };
    },
    cancel(request: { commandId: string; id: string }) { if (!isSourceAction(request)) return invalid(); flushFailures(); const result = store.cancel(request); active.get(request.id)?.controller.abort(); return result; },
    async idle() { await ready(); await Promise.all([...active.values()].map(j => j.promise)); },
    async close() { closed = true; unsubscribe(); for (const controller of recoveryControllers.values()) controller.abort(); for (const job of active.values()) job.controller.abort(); await recovered; await Promise.all([...active.values()].map(j => j.promise)); },
  };
}
export type PreparationCoordinator = ReturnType<typeof createPreparationCoordinator>;
