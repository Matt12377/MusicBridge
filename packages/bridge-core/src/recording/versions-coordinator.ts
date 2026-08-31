import { isCollectionId, isSourceAction, isPreviewVersionsRequest, isFreezeVersionsRequest, type PreviewVersionsRequest, type FreezeVersionsRequest, type VersionProposal, type VersionJob, type VersionFailure } from '@music-bridge/contracts';
import { BridgeError } from '../shared/errors.js';
import { mediaFingerprint, type MediaPlanningStore } from './media-store.js';
import type { MediaPlanningCoordinator } from './media-coordinator.js';
import type { MasterDraftsRepository } from './drafts.js';
import type { SourceEvidenceService } from './source-evidence.js';
import type { SourceStore } from './source-store.js';
import type { MasterVersionsStore, VersionInput, StoredVersionJob } from './versions-store.js';
import { probeReadonlySource, sourceFileAvailability, SourceFileError } from './source-files.js';
import { planVersions } from './version-planner.js';
const invalid = (message = '版本提案无效或已过期，请重新预览并明确确认。'): never => { throw new BridgeError('BAD_REQUEST', message, { httpStatus: 400 }); };
export function createMasterVersionsCoordinator({ store, mediaStore, media, drafts, sourceStore, sources, probe = probeReadonlySource }: { store: MasterVersionsStore; mediaStore: MediaPlanningStore; media: MediaPlanningCoordinator; drafts: MasterDraftsRepository; sourceStore: SourceStore; sources: SourceEvidenceService; probe?: typeof probeReadonlySource }) {
  let closed = false;
  const active = new Map<string, { rootIds: readonly string[]; controller: AbortController; promise: Promise<void> }>(), pendingFailures = new Map<string, VersionFailure>();
  store.recover();
  const unsubscribe = sources.onRootRevoked(rootId => { for (const job of active.values()) if (job.rootIds.includes(rootId)) job.controller.abort('SOURCE_REVOKED'); });
  function flushFailures(): void { for (const [id, failure] of pendingFailures) { store.fail(id, failure); pendingFailures.delete(id); } }
  async function input(request: PreviewVersionsRequest): Promise<VersionInput> {
    if (!isPreviewVersionsRequest(request) || closed) return invalid();
    const initial = mediaStore.detail(request.planId), identity = mediaStore.inputIdentity(initial.draftId);
    const plan = await media.detail(request.planId), draft = drafts.detail(plan.draftId);
    if (plan.requiresReview || !plan.reservation || plan.sourceBasis !== 'verified-sources') return invalid('请先保存最新分面、校验全部源文件并预留磁带。');
    const stock = mediaStore.reservationStock(plan.reservation); if (!stock?.lengthMinutes) return invalid('预留已变化或容量未知，请重新选择介质。');
    const snapshot = await sources.snapshot(draft.id), material = planVersions(draft, snapshot.tracks, plan.spec, request.sampleRate, stock.lengthMinutes);
    if (identity !== mediaStore.inputIdentity(draft.id) || mediaFingerprint(initial) !== mediaFingerprint(mediaStore.detail(plan.id))) return invalid();
    const history = store.list(draft.id), existing = history.masters.find(m => m.contentHash === material.contentHash);
    const proposal: VersionProposal = { ...material, draftId: draft.id, planId: plan.id, masterAction: existing ? 'reuse' : 'create', ...(existing ? { existingMasterId: existing.id } : {}), ...(history.masters[0] ? { previousMasterId: history.masters[0].id } : {}), lengthMinutes: stock.lengthMinutes, reservation: plan.reservation, proposalFingerprint: '' };
    proposal.proposalFingerprint = mediaFingerprint({ identity, plan, stock, proposal });
    return { identity, plan: mediaStore.detail(plan.id), stockFingerprint: mediaFingerprint(stock), title: draft.title, proposal, sourceEvidence: snapshot.tracks.map(t => ({ trackId: t.trackId, binding: t.binding! })) };
  }
  function launch(job: StoredVersionJob): VersionJob {
    const controller = new AbortController();
    const promise = (async () => {
      try {
        const evidence: VersionInput['sourceEvidence'][number][] = [];
        for (const track of job.input.sourceEvidence) {
          if (controller.signal.aborted) throw new SourceFileError('CANCELLED');
          const binding = sourceStore.linked(job.public.draftId, track.trackId);
          if (!binding || !binding.userConfirmed || binding.invalidated || binding.id !== track.binding.id) return invalid();
          const file = await probe(sourceStore.root(binding.rootId), binding.relative, controller.signal);
          if (file.sha256 !== track.binding.sha256 || file.size !== track.binding.size || mediaFingerprint(file.technical) !== mediaFingerprint(track.binding.technical)) throw new SourceFileError('CONTENT_CHANGED');
          if (await sourceFileAvailability(sourceStore.root(binding.rootId), binding.relative, file.signature) !== 'ONLINE') throw new SourceFileError('CONTENT_CHANGED');
          evidence.push({ trackId: track.trackId, binding: { ...track.binding, verifiedAt: file.verifiedAt } });
        }
        // 每首全量 Hash 后再次检查全部源，避免先校验的文件在后续校验期间改变。
        const current = await sources.snapshot(job.public.draftId);
        if (!current.sourceLockEligible) throw new SourceFileError('CONTENT_CHANGED');
        if (controller.signal.aborted) throw new SourceFileError('CANCELLED');
        if (!closed) store.finish(job.public.id, evidence);
      } catch (error) {
        if (!closed) {
          const failure: VersionFailure = controller.signal.reason === 'SOURCE_REVOKED' ? 'SOURCE_INVALID' : controller.signal.aborted ? 'CANCELLED' : error instanceof SourceFileError ? 'SOURCE_INVALID' : (error instanceof BridgeError && error.code === 'BAD_REQUEST' || error instanceof Error && 'code' in error && error.code === 'INVENTORY_CONFLICT') ? 'INPUT_CHANGED' : 'IO_ERROR';
          try { store.fail(job.public.id, failure); } catch { pendingFailures.set(job.public.id, failure); }
        }
      } finally { active.delete(job.public.id); }
    })();
    active.set(job.public.id, { rootIds: job.input.sourceEvidence.map(t => t.binding.rootId), controller, promise }); return job.public;
  }
  return {
    list(draftId: string) { if (!isCollectionId(draftId)) return invalid(); flushFailures(); return store.list(draftId); },
    async preview(request: PreviewVersionsRequest): Promise<VersionProposal> { return (await input(request)).proposal; },
    async freeze(request: FreezeVersionsRequest): Promise<VersionJob> {
      if (!isFreezeVersionsRequest(request) || closed) return invalid(); flushFailures(); const prior = store.cached(request); if (prior) return prior;
      if (active.size >= 2) return invalid('已有两项冻结复核在进行，请等待或取消其中一项。');
      const prepared = await input({ planId: request.planId, sampleRate: request.sampleRate });
      if (prepared.proposal.proposalFingerprint !== request.proposalFingerprint) return invalid();
      const job = store.start(request, prepared); if (active.has(job.public.id) || job.public.state !== 'running') return job.public;
      return launch(job);
    },
    job(id: string) { if (!isCollectionId(id)) return invalid(); flushFailures(); return { job: store.job(id)?.public ?? null }; },
    cancel(request: { commandId: string; id: string }) { if (!isSourceAction(request)) return invalid(); const result = store.cancel(request); active.get(request.id)?.controller.abort(); return result; },
    async idle() { await Promise.all([...active.values()].map(job => job.promise)); },
    async close() { closed = true; unsubscribe(); for (const job of active.values()) job.controller.abort(); await Promise.all([...active.values()].map(job => job.promise)); },
  };
}
export type MasterVersionsCoordinator = ReturnType<typeof createMasterVersionsCoordinator>;
