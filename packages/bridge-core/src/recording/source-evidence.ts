import path from 'node:path';
import { isCollectionId, isSourceSelection, isSourceAction, isSourceConfirmation, type SourceRoot, type SourceBinding, type SourceSelection, type SourceAction, type SourceConfirmation, type DraftSourceSnapshot, type SourceFailure } from '@music-bridge/contracts';
import { BridgeError } from '../shared/errors.js';
import { authorizeSourceDirectory, sourceRootAvailability, sourceFileAvailability, sourceRelativePath, probeReadonlySource, SourceFileError, type RootCapability } from './source-files.js';
import type { SourceStore, StoredBinding } from './source-store.js';
import type { MasterDraftsRepository } from './drafts.js';

const invalid = (message = '源文件操作无效，请刷新并重新确认。'): never => { throw new BridgeError('BAD_REQUEST', message, { httpStatus: 400 }); };
export function createSourceEvidenceService({ store, drafts, probe = probeReadonlySource }: { store: SourceStore; drafts: MasterDraftsRepository; probe?: typeof probeReadonlySource }) {
  const active = new Map<string, { rootId: string; controller: AbortController; promise: Promise<void> }>();
  let closed = false;
  const pendingFailures = new Map<string, SourceFailure>();
  function flushFailures(): void { for (const [id, failure] of pendingFailures) { store.fail(id, failure); pendingFailures.delete(id); } }
  // 只由 Core 生命周期唯一持有者调用；仓库的普通读取不会中断另一个任务。
  store.recover();
  async function publicRoot(root: RootCapability): Promise<SourceRoot> { return { id: root.id, label: root.label, authorized: root.authorized, availability: await sourceRootAvailability(root) }; }
  async function publicBinding(binding: StoredBinding): Promise<SourceBinding> {
    let availability = await sourceFileAvailability(store.root(binding.rootId), binding.relative, binding.evidence.signature);
    if (binding.invalidated && availability === 'ONLINE') availability = 'CONTENT_CHANGED';
    return { id: binding.id, rootId: binding.rootId, fileName: path.basename(binding.relative).replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 240) || '源文件', acquisition: binding.acquisition,
      verification: 'fileHashVerified', preservation: 'externalReferenceOnly', availability, sha256: binding.evidence.sha256, size: binding.evidence.size, modifiedAt: binding.evidence.modifiedAt, verifiedAt: binding.evidence.verifiedAt,
      technical: binding.evidence.technical, userConfirmed: binding.userConfirmed, sourceLockEligible: binding.userConfirmed && availability === 'ONLINE' };
  }
  function start(selection: SourceSelection, absolutePath: string, recheck = false) {
    if (!isSourceSelection(selection) || closed) return invalid();
    flushFailures();
    const prior = store.job(selection.commandId);
    if (prior) return store.start(selection, prior.relative, recheck).public;
    if (active.size >= 2) return invalid('已有两项源校验在进行，请等待或取消其中一项。');
    const root = store.root(selection.rootId), relative = sourceRelativePath(root, absolutePath);
    const job = store.start(selection, relative, recheck);
    const controller = new AbortController();
    const promise = (async () => {
      try {
        const evidence = await probe(root, relative, controller.signal);
        if (controller.signal.aborted) throw new SourceFileError('CANCELLED');
        const current = store.root(selection.rootId);
        if (!current.authorized) throw new SourceFileError('REVOKED');
        const availability = await sourceFileAvailability(current, relative, evidence.signature);
        if (availability !== 'ONLINE') throw new SourceFileError(availability);
        if (!closed) store.finish(job.public.id, evidence);
      } catch (error) {
        if (!closed) {
          const failure = error instanceof SourceFileError ? error.code : 'IO_ERROR';
          try { store.fail(job.public.id, failure); } catch { pendingFailures.set(job.public.id, failure); }
        }
      } finally { active.delete(job.public.id); }
    })();
    active.set(job.public.id, { rootId: root.id, controller, promise });
    return job.public;
  }
  return {
    async roots() { return { roots: await Promise.all(store.roots().map(publicRoot)) }; },
    async authorize(commandId: string, absolutePath: string) { if (!isCollectionId(commandId)) return invalid(); const prior = store.rootReceipt(commandId); return publicRoot(prior ?? store.authorize(commandId, await authorizeSourceDirectory(absolutePath))); },
    async rootReceipt(commandId: string) { if (!isCollectionId(commandId)) return invalid(); const root = store.rootReceipt(commandId); return { root: root ? await publicRoot(root) : null }; },
    async context(id: string) { if (!isCollectionId(id)) return invalid(); const root = store.root(id); if (await sourceRootAvailability(root) !== 'ONLINE') return invalid('源目录当前未授权或离线。'); return { absolutePath: root.path }; },
    async revoke(request: SourceAction) {
      if (!isSourceAction(request)) return invalid(); const root = store.revoke(request);
      for (const [id, job] of active) if (job.rootId === root.id) { store.fail(id, 'REVOKED'); job.controller.abort(); }
      return publicRoot(root);
    },
    start,
    job(id: string) { if (!isCollectionId(id)) return invalid(); flushFailures(); return { job: store.job(id)?.public ?? null }; },
    cancel(request: SourceAction) { if (!isSourceAction(request)) return invalid(); const result = store.cancel(request); active.get(request.id)?.controller.abort(); return result; },
    recheck(request: SourceConfirmation) {
      if (!isSourceConfirmation(request)) return invalid(); const binding = store.linked(request.draftId, request.trackId);
      if (!binding || binding.id !== request.id) return invalid();
      return start({ commandId: request.commandId, draftId: request.draftId, trackId: request.trackId, rootId: binding.rootId, acquisition: binding.acquisition, relocateBindingId: binding.id }, path.join(store.root(binding.rootId).path, binding.relative), true);
    },
    async confirm(request: SourceConfirmation) {
      if (!isSourceConfirmation(request)) return invalid(); const binding = store.binding(request.id);
      if ((await publicBinding(binding)).availability !== 'ONLINE') return invalid('源文件已变化或不可访问，请先重新校验。');
      return publicBinding(store.confirm(request));
    },
    async snapshot(draftId: string): Promise<DraftSourceSnapshot> {
      if (!isCollectionId(draftId)) return invalid(); flushFailures(); const draft = drafts.detail(draftId);
      const tracks = await Promise.all(draft.tracks.map(async track => { const binding = store.linked(draftId, track.id); return { trackId: track.id, ...(binding ? { binding: await publicBinding(binding) } : {}), jobs: store.jobs(draftId, track.id) }; }));
      return { draftId, sourceLockEligible: tracks.length > 0 && tracks.every(t => t.binding?.sourceLockEligible === true), tracks };
    },
    async idle() { await Promise.all([...active.values()].map(job => job.promise)); },
    async close() { closed = true; for (const job of active.values()) job.controller.abort(); await Promise.all([...active.values()].map(job => job.promise)); },
  };
}
export type SourceEvidenceService = ReturnType<typeof createSourceEvidenceService>;
