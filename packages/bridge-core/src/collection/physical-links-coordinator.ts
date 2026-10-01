import { createHash } from 'node:crypto';
import { isAlbumQuery, isCollectionId, isConfirmPhysicalLinkRequest, isLegacyConfirmPhysicalLinkRequest, isRelocateDigitalRequest, isRegisterDigitalRequest, isRemovePhysicalLinkRequest, isLegacyRemovePhysicalLinkRequest, isConfirmAbsenceRequest, isDigitalAlbumMetadata,
  type ConfirmPhysicalLinkRequest, type LegacyConfirmPhysicalLinkRequest, type RelocateDigitalRequest, type RegisterDigitalRequest, type RemovePhysicalLinkRequest, type LegacyRemovePhysicalLinkRequest, type ConfirmAbsenceRequest, type PhysicalLinkResult, type DigitalRuntime, type PageRequest, type RoonLibraryPage } from '@music-bridge/contracts';
import { BridgeError } from '../shared/errors.js';
import type { RoonPublicLibrary } from '../roon/public-library.js';
import type { RoonAlbumMetadata } from '../roon/public-library.js';
import type { DraftTrackMetadata } from '@music-bridge/contracts';
import type { PhysicalLinksRepository } from './physical-links.js';

export interface PhysicalLinksCoordinator {
  search(query: string, page: PageRequest): Promise<RoonLibraryPage>;
  confirm(request: ConfirmPhysicalLinkRequest | LegacyConfirmPhysicalLinkRequest): PhysicalLinkResult;
  register(request: RegisterDigitalRequest): PhysicalLinkResult;
  relocate(request: RelocateDigitalRequest): PhysicalLinkResult;
  remove(request: RemovePhysicalLinkRequest | LegacyRemovePhysicalLinkRequest): PhysicalLinkResult;
  absence(request: ConfirmAbsenceRequest): PhysicalLinkResult;
  runtime(id: string): DigitalRuntime;
}
/** consume只在owner本地同步执行；跨线程只传安全元数据与许可票据。 */
export interface CollectionRoonProjectionPort {
  projectAlbum<T>(reference: string, consume: (metadata: RoonAlbumMetadata) => T): Promise<T>;
  projectTracks<T>(references: readonly string[], consume: (metadata: readonly DraftTrackMetadata[]) => T): Promise<T>;
  browseAlbumCandidates(query: string, page: PageRequest): Promise<RoonLibraryPage>;
}
export type ProjectedPhysicalLinksCoordinator = Omit<PhysicalLinksCoordinator, 'confirm' | 'register' | 'relocate' | 'runtime'> & {
  confirm(request: ConfirmPhysicalLinkRequest | LegacyConfirmPhysicalLinkRequest): Promise<PhysicalLinkResult>;
  register(request: RegisterDigitalRequest): Promise<PhysicalLinkResult>;
  relocate(request: RelocateDigitalRequest): Promise<PhysicalLinkResult>;
  runtime(id: string): Promise<DigitalRuntime>;
};
const invalid = (): never => { throw new BridgeError('BAD_REQUEST', '关联请求无效，请检查选择和确认项。', { httpStatus: 400 }); };
function canonical(v: unknown): string { return Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : typeof v === 'object' && v !== null ? `{${Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, value]) => `${JSON.stringify(k)}:${canonical(value)}`).join(',')}}` : JSON.stringify(v); }
const fingerprint = (action: string, request: unknown): string => createHash('sha256').update(canonical({ action, request })).digest('hex');
function createPhysicalLinksState({ repository, library }: { repository: PhysicalLinksRepository; library: Pick<RoonPublicLibrary, 'getAlbumSnapshot' | 'browseAlbums' | 'searchLibrary'> }) {
  const references = new Map<string, string>();
  const remember = (id: string, reference: string): void => { references.delete(id); references.set(id, reference); if (references.size > 4096) references.delete(references.keys().next().value!); };
  function metadata(reference: string) {
    const result = library.getAlbumSnapshot(reference);
    if (!isDigitalAlbumMetadata(result)) return invalid(); return result;
  }
  const coordinator: PhysicalLinksCoordinator = {
    async search(query, page) { if (!isAlbumQuery(query)) return invalid(); return query.trim() ? library.searchLibrary(query.trim(), page, 'album') : library.browseAlbums(page); },
    runtime(id) {
      if (!isCollectionId(id)) return invalid();
      const album = repository.digitalDetail(id).album;
      const reference = references.get(id); if (!reference) return { status: 'needs-resolution' };
      try { return canonical(metadata(reference)) === canonical(album.metadata) ? { status: 'available', reference } : { status: 'unavailable' }; }
      catch { return { status: 'unavailable' }; }
    },
    confirm(request) {
      if (!isConfirmPhysicalLinkRequest(request) && !isLegacyConfirmPhysicalLinkRequest(request)) return invalid();
      const hash = fingerprint('confirm', request), prior = repository.cached(request.commandId, hash);
      if (prior) return prior;
      const snapshot = request.reference ? metadata(request.reference) : undefined;
      const knownId = request.digitalId ?? [...references].find(([, ref]) => ref === request.reference)?.[0];
      if (knownId && snapshot && canonical(repository.digitalDetail(knownId).album.metadata) !== canonical(snapshot)) return invalid();
      const legacyRequest = !('reason' in request);
      const result = repository.link({ commandId: request.commandId, fingerprint: hash, releaseId: request.releaseId, expectedRevision: request.expectedRevision, relation: request.relation, ripFromCdConfirmed: request.ripFromCdConfirmed, reason: legacyRequest ? null : request.reason, legacyRequest, origin: request.reference ? 'roon-candidate' : 'existing-digital',
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
    remove(request) { if (!isRemovePhysicalLinkRequest(request) && !isLegacyRemovePhysicalLinkRequest(request)) return invalid(); return repository.remove(request, fingerprint('remove', request)); },
    absence(request) { if (!isConfirmAbsenceRequest(request)) return invalid(); return repository.absence(request, fingerprint('absence', request)); },
  };
  return { coordinator, referenceFor: (id: string) => references.get(id) };
}

export function createPhysicalLinksCoordinator(options: { repository: PhysicalLinksRepository; library: RoonPublicLibrary }): PhysicalLinksCoordinator {
  return createPhysicalLinksState(options).coordinator;
}

export function createProjectedPhysicalLinksCoordinator({ repository, projection, assertCurrent }: {
  repository: PhysicalLinksRepository; projection: CollectionRoonProjectionPort; assertCurrent(): void;
}): ProjectedPhysicalLinksCoordinator {
  let capture: { reference: string; metadata: RoonAlbumMetadata } | undefined;
  const state = createPhysicalLinksState({ repository, library: {
    getAlbumSnapshot(reference) { if (!capture || capture.reference !== reference) return invalid(); return capture.metadata; },
    browseAlbums: page => projection.browseAlbumCandidates('', page),
    searchLibrary: (query, page) => projection.browseAlbumCandidates(query, page),
  } });
  const projected = <T>(reference: string, consume: () => T) => projection.projectAlbum(reference, metadata => {
    assertCurrent(); capture = { reference, metadata };
    try { return consume(); } finally { capture = undefined; }
  });
  return {
    async search(query, page) { assertCurrent(); const result = await state.coordinator.search(query, page); assertCurrent(); return result; },
    remove(request) { assertCurrent(); return state.coordinator.remove(request); },
    absence(request) { assertCurrent(); return state.coordinator.absence(request); },
    async confirm(request) {
      assertCurrent();
      if (!isConfirmPhysicalLinkRequest(request) && !isLegacyConfirmPhysicalLinkRequest(request)) return invalid();
      const prior = repository.cached(request.commandId, fingerprint('confirm', request)); if (prior) return prior;
      return request.reference ? projected(request.reference, () => state.coordinator.confirm(request)) : state.coordinator.confirm(request);
    },
    async register(request) {
      assertCurrent(); if (!isRegisterDigitalRequest(request)) return invalid();
      const prior = repository.cached(request.commandId, fingerprint('register', request)); if (prior) return prior;
      return projected(request.reference, () => state.coordinator.register(request));
    },
    async relocate(request) {
      assertCurrent(); if (!isRelocateDigitalRequest(request)) return invalid();
      const prior = repository.cached(request.commandId, fingerprint('relocate', request)); if (prior) return prior;
      return projected(request.reference, () => state.coordinator.relocate(request));
    },
    async runtime(id) {
      assertCurrent(); if (!isCollectionId(id)) return invalid();
      const album = repository.digitalDetail(id).album, reference = state.referenceFor(id);
      if (!reference) return { status: 'needs-resolution' };
      try { return await projected(reference, () => canonical(capture!.metadata) === canonical(album.metadata) ? { status: 'available' as const, reference } : { status: 'unavailable' as const }); }
      catch { assertCurrent(); return { status: 'unavailable' }; }
    },
  };
}
