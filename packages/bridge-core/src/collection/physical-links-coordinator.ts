import { createHash } from 'node:crypto';
import { isAlbumQuery, isCollectionId, isConfirmPhysicalLinkRequest, isRelocateDigitalRequest, isRegisterDigitalRequest, isRemovePhysicalLinkRequest, isConfirmAbsenceRequest, isDigitalAlbumMetadata,
  type ConfirmPhysicalLinkRequest, type RelocateDigitalRequest, type RegisterDigitalRequest, type RemovePhysicalLinkRequest, type ConfirmAbsenceRequest, type PhysicalLinkResult, type DigitalRuntime, type PageRequest, type RoonLibraryPage } from '@music-bridge/contracts';
import { BridgeError } from '../shared/errors.js';
import type { RoonPublicLibrary } from '../roon/public-library.js';
import type { PhysicalLinksRepository } from './physical-links.js';

export interface PhysicalLinksCoordinator {
  search(query: string, page: PageRequest): Promise<RoonLibraryPage>;
  confirm(request: ConfirmPhysicalLinkRequest): PhysicalLinkResult;
  register(request: RegisterDigitalRequest): PhysicalLinkResult;
  relocate(request: RelocateDigitalRequest): PhysicalLinkResult;
  remove(request: RemovePhysicalLinkRequest): PhysicalLinkResult;
  absence(request: ConfirmAbsenceRequest): PhysicalLinkResult;
  runtime(id: string): DigitalRuntime;
}
const invalid = (): never => { throw new BridgeError('BAD_REQUEST', '关联请求无效，请检查选择和确认项。', { httpStatus: 400 }); };
function canonical(v: unknown): string { return Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : typeof v === 'object' && v !== null ? `{${Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, value]) => `${JSON.stringify(k)}:${canonical(value)}`).join(',')}}` : JSON.stringify(v); }
const fingerprint = (action: string, request: unknown): string => createHash('sha256').update(canonical({ action, request })).digest('hex');
export function createPhysicalLinksCoordinator({ repository, library }: { repository: PhysicalLinksRepository; library: RoonPublicLibrary }): PhysicalLinksCoordinator {
  const references = new Map<string, string>();
  const remember = (id: string, reference: string): void => { references.delete(id); references.set(id, reference); if (references.size > 4096) references.delete(references.keys().next().value!); };
  function metadata(reference: string) {
    const result = library.getAlbumSnapshot(reference);
    if (!isDigitalAlbumMetadata(result)) return invalid(); return result;
  }
  return {
    async search(query, page) { if (!isAlbumQuery(query)) return invalid(); return query.trim() ? library.searchLibrary(query.trim(), page, 'album') : library.browseAlbums(page); },
    runtime(id) {
      if (!isCollectionId(id)) return invalid();
      const album = repository.digitalDetail(id).album;
      const reference = references.get(id); if (!reference) return { status: 'needs-resolution' };
      try { return canonical(metadata(reference)) === canonical(album.metadata) ? { status: 'available', reference } : { status: 'unavailable' }; }
      catch { return { status: 'unavailable' }; }
    },
    confirm(request) {
      if (!isConfirmPhysicalLinkRequest(request)) return invalid();
      const hash = fingerprint('confirm', request), prior = repository.cached(request.commandId, hash);
      if (prior) return prior;
      const snapshot = request.reference ? metadata(request.reference) : undefined;
      const knownId = request.digitalId ?? [...references].find(([, ref]) => ref === request.reference)?.[0];
      if (knownId && snapshot && canonical(repository.digitalDetail(knownId).album.metadata) !== canonical(snapshot)) return invalid();
      const result = repository.link({ commandId: request.commandId, fingerprint: hash, releaseId: request.releaseId, expectedRevision: request.expectedRevision, relation: request.relation, ripFromCdConfirmed: request.ripFromCdConfirmed,
        ...(knownId ? { digitalId: knownId } : snapshot ? { metadata: snapshot } : {}) });
      if (request.reference && result.digitalId) remember(result.digitalId, request.reference);
      return result;
    },
    register(request) {
      if (!isRegisterDigitalRequest(request)) return invalid();
      const hash = fingerprint('register', request), prior = repository.cached(request.commandId, hash); if (prior) return prior;
      const result = repository.register(request.commandId, hash, metadata(request.reference), request.physicalAbsenceConfirmed);
      remember(result.digitalId!, request.reference); return result;
    },
    relocate(request) {
      if (!isRelocateDigitalRequest(request)) return invalid();
      const hash = fingerprint('relocate', request), prior = repository.cached(request.commandId, hash); if (prior) return prior;
      const result = repository.relocate(request.commandId, hash, request.digitalId, request.expectedRevision, metadata(request.reference));
      remember(request.digitalId, request.reference); return result;
    },
    remove(request) { if (!isRemovePhysicalLinkRequest(request)) return invalid(); return repository.remove(request, fingerprint('remove', request)); },
    absence(request) { if (!isConfirmAbsenceRequest(request)) return invalid(); return repository.absence(request, fingerprint('absence', request)); },
  };
}
