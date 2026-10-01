import { createHash } from 'node:crypto';
import { isAppendMasterDraftRequest, isUpdateMasterDraftRequest, isCollectionId, isDraftTrackMetadata,
  type AppendMasterDraftRequest, type UpdateMasterDraftRequest, type MasterDraftResult, type DigitalRuntime } from '@music-bridge/contracts';
import { BridgeError } from '../shared/errors.js';
import type { RoonPublicLibrary } from '../roon/public-library.js';
import type { MasterDraftsRepository } from './drafts.js';
import type { CollectionRoonProjectionPort } from '../collection/physical-links-coordinator.js';
import type { DraftTrackMetadata } from '@music-bridge/contracts';

export interface MasterDraftsCoordinator {
  append(request: AppendMasterDraftRequest): MasterDraftResult;
  update(request: UpdateMasterDraftRequest): MasterDraftResult;
  runtime(draftId: string, trackId: string): DigitalRuntime;
}
export type ProjectedMasterDraftsCoordinator = Omit<MasterDraftsCoordinator, 'append' | 'runtime'> & {
  append(request: AppendMasterDraftRequest): Promise<MasterDraftResult>;
  runtime(draftId: string, trackId: string): Promise<DigitalRuntime>;
};
const invalid = (): never => { throw new BridgeError('BAD_REQUEST', '草稿选曲请求无效，请重新核对并确认。', { httpStatus: 400 }); };
function canonical(v: unknown): string { return Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : typeof v === 'object' && v !== null ? `{${Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, value]) => `${JSON.stringify(k)}:${canonical(value)}`).join(',')}}` : JSON.stringify(v); }
const fingerprint = (action: string, request: unknown): string => createHash('sha256').update(canonical({ action, request })).digest('hex');
function createMasterDraftsState({ repository, library }: { repository: MasterDraftsRepository; library: Pick<RoonPublicLibrary, 'getTrackSnapshot'> }) {
  const references = new Map<string, string>();
  const coordinator: MasterDraftsCoordinator = {
    append(request) {
      if (!isAppendMasterDraftRequest(request)) return invalid();
      const hash = fingerprint('append', request), prior = repository.cached(request.commandId, hash);
      if (prior) return prior;
      const metadata = request.references.map(reference => library.getTrackSnapshot(reference));
      if (!metadata.every(isDraftTrackMetadata)) return invalid();
      const result = repository.append({ commandId: request.commandId, fingerprint: hash, metadata,
        ...(request.draftId ? { draftId: request.draftId, expectedRevision: request.expectedRevision! } : { title: request.title!, programType: request.programType! }) });
      result.trackIds.forEach((id, index) => { references.set(id, request.references[index]!); if (references.size > 4096) references.delete(references.keys().next().value!); });
      return result;
    },
    update(request) {
      if (!isUpdateMasterDraftRequest(request)) return invalid();
      return repository.update(request, fingerprint('update', request));
    },
    runtime(draftId, trackId) {
      if (!isCollectionId(draftId) || !isCollectionId(trackId)) return invalid();
      const track = repository.detail(draftId).tracks.find(t => t.id === trackId);
      if (!track) return invalid();
      const reference = references.get(trackId); if (!reference) return { status: 'needs-resolution' };
      try { return canonical(library.getTrackSnapshot(reference)) === canonical(track.metadata) ? { status: 'available', reference } : { status: 'unavailable' }; }
      catch { return { status: 'unavailable' }; }
    },
  };
  return { coordinator, referenceFor: (id: string) => references.get(id) };
}

export function createMasterDraftsCoordinator(options: { repository: MasterDraftsRepository; library: RoonPublicLibrary }): MasterDraftsCoordinator {
  return createMasterDraftsState(options).coordinator;
}

export function createProjectedMasterDraftsCoordinator({ repository, projection, assertCurrent }: {
  repository: MasterDraftsRepository; projection: CollectionRoonProjectionPort; assertCurrent(): void;
}): ProjectedMasterDraftsCoordinator {
  let capture: ReadonlyMap<string, DraftTrackMetadata> | undefined;
  const state = createMasterDraftsState({ repository, library: { getTrackSnapshot(reference) { const metadata = capture?.get(reference); if (!metadata) return invalid(); return metadata; } } });
  return {
    update(request) { assertCurrent(); return state.coordinator.update(request); },
    async append(request) {
      assertCurrent(); if (!isAppendMasterDraftRequest(request)) return invalid();
      const prior = repository.cached(request.commandId, fingerprint('append', request)); if (prior) return prior;
      return projection.projectTracks(request.references, metadata => {
        assertCurrent(); if (metadata.length !== request.references.length || !metadata.every(isDraftTrackMetadata)) return invalid();
        capture = new Map(request.references.map((reference, index) => [reference, metadata[index]!]));
        try { return state.coordinator.append(request); } finally { capture = undefined; }
      });
    },
    async runtime(draftId, trackId) {
      assertCurrent(); if (!isCollectionId(draftId) || !isCollectionId(trackId)) return invalid();
      const track = repository.detail(draftId).tracks.find(item => item.id === trackId); if (!track) return invalid();
      const reference = state.referenceFor(trackId); if (!reference) return { status: 'needs-resolution' };
      try {
        return await projection.projectTracks([reference], metadata => {
          assertCurrent(); if (metadata.length !== 1 || !metadata.every(isDraftTrackMetadata)) return invalid();
          return canonical(metadata[0]) === canonical(track.metadata) ? { status: 'available' as const, reference } : { status: 'unavailable' as const };
        });
      } catch { assertCurrent(); return { status: 'unavailable' }; }
    },
  };
}
