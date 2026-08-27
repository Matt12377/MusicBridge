import { createHash } from 'node:crypto';
import { isAppendMasterDraftRequest, isUpdateMasterDraftRequest, isCollectionId, isDraftTrackMetadata,
  type AppendMasterDraftRequest, type UpdateMasterDraftRequest, type MasterDraftResult, type DigitalRuntime } from '@music-bridge/contracts';
import { BridgeError } from '../shared/errors.js';
import type { RoonPublicLibrary } from '../roon/public-library.js';
import type { MasterDraftsRepository } from './drafts.js';

export interface MasterDraftsCoordinator {
  append(request: AppendMasterDraftRequest): MasterDraftResult;
  update(request: UpdateMasterDraftRequest): MasterDraftResult;
  runtime(draftId: string, trackId: string): DigitalRuntime;
}
const invalid = (): never => { throw new BridgeError('BAD_REQUEST', '草稿选曲请求无效，请重新核对并确认。', { httpStatus: 400 }); };
function canonical(v: unknown): string { return Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : typeof v === 'object' && v !== null ? `{${Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, value]) => `${JSON.stringify(k)}:${canonical(value)}`).join(',')}}` : JSON.stringify(v); }
const fingerprint = (action: string, request: unknown): string => createHash('sha256').update(canonical({ action, request })).digest('hex');
export function createMasterDraftsCoordinator({ repository, library }: { repository: MasterDraftsRepository; library: RoonPublicLibrary }): MasterDraftsCoordinator {
  const references = new Map<string, string>();
  return {
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
}
