import { isCollectionId, isMediaLayoutSpec, isPreviewMediaRequest, isSaveMediaPlanRequest, isReserveMediaRequest, isReleaseMediaRequest,
  type MediaPlan, type MediaPreview, type MediaTimingTrack, type MediaSourceBasis, type MediaLayoutSpec, type PreviewMediaRequest, type SaveMediaPlanRequest, type ReserveMediaRequest, type ReleaseMediaRequest } from '@music-bridge/contracts';
import { BridgeError } from '../shared/errors.js';
import { resolveMediaLayout, balancedSplit, assessMediaCandidate } from './media-planner.js';
import { mediaFingerprint, type MediaPlanningStore, type MediaPlanningInput } from './media-store.js';
import type { MasterDraftsRepository } from './drafts.js';
import type { SourceEvidenceService } from './source-evidence.js';

const invalid = (): never => { throw new BridgeError('BAD_REQUEST', '录音规划请求无效，请重新计算并确认。', { httpStatus: 400 }); };
export function createMediaPlanningCoordinator({ store, drafts, sources }: { store: MediaPlanningStore; drafts: MasterDraftsRepository; sources?: SourceEvidenceService }) {
  async function input(draftId: string): Promise<MediaPlanningInput> {
    if (!isCollectionId(draftId)) return invalid();
    const identity = store.inputIdentity(draftId), draft = drafts.detail(draftId);
    const snapshot = sources ? await sources.snapshot(draftId) : undefined;
    const tracks: MediaTimingTrack[] = draft.tracks.map(track => {
      const binding = snapshot?.tracks.find(t => t.trackId === track.id)?.binding;
      if (binding) return binding.sourceLockEligible ? { trackId: track.id, basis: 'verified-sources', durationMs: binding.technical.durationMs } : { trackId: track.id, basis: 'unavailable' };
      return { trackId: track.id, basis: 'roon-estimate', ...(track.metadata.durationMs !== undefined ? { durationMs: track.metadata.durationMs } : {}) };
    });
    if (identity !== store.inputIdentity(draftId)) return invalid();
    const basis: MediaSourceBasis = !tracks.length || tracks.some(t => t.basis === 'unavailable') ? 'unavailable' : tracks.every(t => t.basis === 'verified-sources') ? 'verified-sources' : 'roon-estimate';
    return { draftId, revision: draft.revision, identity, tracks, basis, fingerprint: mediaFingerprint({ identity, tracks, basis }) };
  }
  function decorate(plan: MediaPlan, current: MediaPlanningInput): MediaPlan {
    let requiresReview = plan.requiresReview || plan.inputFingerprint !== current.fingerprint;
    if (plan.reservation) {
      const stock = store.reservationStock(plan.reservation);
      if (!stock || assessMediaCandidate(stock, plan.layout, plan.spec, current.basis).status !== 'recommended') requiresReview = true;
    }
    return { ...plan, requiresReview };
  }
  async function detail(id: string): Promise<MediaPlan> { if (!isCollectionId(id)) return invalid(); const plan = store.detail(id); return decorate(plan, await input(plan.draftId)); }
  return {
    async list(draftId: string) { const result = store.list(draftId); if (!result.plans.length) return result; const current = await input(draftId); return { draftId, plans: result.plans.map(plan => decorate(plan, current)) }; },
    detail,
    async preview(request: PreviewMediaRequest): Promise<MediaPreview> {
      if (!isPreviewMediaRequest(request)) return invalid();
      const current = await input(request.draftId), layout = resolveMediaLayout(current.tracks, request.spec);
      const stock = store.stock(request.page, request.spec.format);
      const score = { recommended: 0, pending: 1, excluded: 2 };
      const candidates = { ...stock, items: stock.items.map(item => assessMediaCandidate(item, layout, request.spec, current.basis)).sort((a, b) => score[a.status] - score[b.status] || Number(a.packaging === 'sealed') - Number(b.packaging === 'sealed')) };
      return { draftId: request.draftId, draftRevision: current.revision, inputFingerprint: current.fingerprint, sourceBasis: current.basis, layout, candidates };
    },
    async balance(draftId: string, spec: MediaLayoutSpec) { if (!isMediaLayoutSpec(spec)) return invalid(); return { splitAfter: balancedSplit((await input(draftId)).tracks, spec) }; },
    async save(request: SaveMediaPlanRequest) {
      if (!isSaveMediaPlanRequest(request)) return invalid();
      const prior = store.cached('save-media-plan', request); if (prior) return detail(prior.id);
      const current = await input(request.draftId);
      resolveMediaLayout(current.tracks, request.spec);
      return decorate(store.save(request, current), current);
    },
    async reserve(request: ReserveMediaRequest) {
      if (!isReserveMediaRequest(request)) return invalid();
      const prior = store.cached('reserve-media-plan', request); if (prior) return detail(prior.id);
      const plan = store.detail(request.planId), current = await input(plan.draftId);
      return decorate(store.reserve(request, current), current);
    },
    async release(request: ReleaseMediaRequest) { if (!isReleaseMediaRequest(request)) return invalid(); const plan = store.release(request); return detail(plan.id); },
  };
}
export type MediaPlanningCoordinator = ReturnType<typeof createMediaPlanningCoordinator>;
