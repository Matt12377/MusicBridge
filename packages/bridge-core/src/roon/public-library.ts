import type {
  RoonImageOptions as PublicRoonImageOptions,
  RoonLibraryItem as PublicRoonLibraryItem,
  RoonLibraryPage as PublicRoonLibraryPage,
  TrackSummary,
} from '@music-bridge/contracts';
import { roonTrackIdFromReference } from '@music-bridge/contracts';
import { randomUUID } from 'node:crypto';
import { BridgeError } from '../shared/errors.js';
import { RoonActionBlockedError } from './action-policy.js';
import {
  RoonLibraryError,
  type RoonEntityDescriptor,
  type RoonImageOptions,
  type RoonLibraryPage,
  type RoonLibraryService,
  type RoonPageRequest,
} from './library.js';

const MAX_REFERENCES = 4096;

export interface RoonPublicLibrary {
  browseAlbums(request: RoonPageRequest): Promise<PublicRoonLibraryPage>;
  browseArtists(request: RoonPageRequest): Promise<PublicRoonLibraryPage>;
  browseGenres(request: RoonPageRequest): Promise<PublicRoonLibraryPage>;
  browsePlaylists(request: RoonPageRequest): Promise<PublicRoonLibraryPage>;
  browseAlbum(reference: string, request: RoonPageRequest): Promise<PublicRoonLibraryPage>;
  browseArtist(reference: string, request: RoonPageRequest): Promise<PublicRoonLibraryPage>;
  searchLibrary(query: string, request: RoonPageRequest): Promise<PublicRoonLibraryPage>;
  getImage(reference: string, options?: PublicRoonImageOptions): Promise<{
    contentType: string;
    body: Uint8Array;
  }>;
  playTrack(reference: string, zoneOrOutputId: string): Promise<void>;
  queueTrack(reference: string, zoneOrOutputId: string): Promise<void>;
  /** Core 内部使用的安全元数据投影；不暴露 Roon item_key 或运行期引用。 */
  getTrackSummary(reference: string): TrackSummary;
}

interface DescriptorReference {
  descriptor: RoonEntityDescriptor;
  imageReference?: string;
}

function toDurationMs(descriptor: RoonEntityDescriptor): number | undefined {
  if (descriptor.durationMs !== undefined) return descriptor.durationMs;
  if (
    descriptor.durationSeconds === undefined
    || descriptor.durationSeconds > 86_400
    || !Number.isSafeInteger(descriptor.durationSeconds * 1_000)
  ) {
    return undefined;
  }
  return descriptor.durationSeconds * 1_000;
}

function createToken(prefix: string): string {
  return `musicbridge-v2-${prefix}-${randomUUID()}`;
}

function addBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.set(key, value);
  while (map.size > MAX_REFERENCES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function mapDescriptor(
  descriptor: RoonEntityDescriptor,
  references: Map<string, DescriptorReference>,
  imageReferences: Map<string, string>,
): PublicRoonLibraryItem {
  const reference = createToken('entity');
  let artworkReference: string | undefined;
  if (descriptor.imageKey) {
    artworkReference = createToken('image');
    addBounded(imageReferences, artworkReference, descriptor.imageKey);
  }
  addBounded(references, reference, {
    descriptor,
    ...(artworkReference !== undefined ? { imageReference: artworkReference } : {}),
  });
  const durationMs = toDurationMs(descriptor);
  return {
    reference,
    kind: descriptor.kind,
    title: descriptor.title,
    ...(descriptor.subtitle !== undefined ? { subtitle: descriptor.subtitle } : {}),
    ...(descriptor.artist !== undefined ? { artist: descriptor.artist } : {}),
    ...(descriptor.album !== undefined ? { album: descriptor.album } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(descriptor.trackNumber !== undefined ? { trackNumber: descriptor.trackNumber } : {}),
    ...(descriptor.discNumber !== undefined ? { discNumber: descriptor.discNumber } : {}),
    ...(descriptor.year !== undefined ? { year: descriptor.year } : {}),
    ...(descriptor.version !== undefined ? { version: descriptor.version } : {}),
    ...(artworkReference !== undefined ? { artworkReference } : {}),
  };
}

function mapPage(
  page: RoonLibraryPage<RoonEntityDescriptor>,
  request: RoonPageRequest,
  references: Map<string, DescriptorReference>,
  imageReferences: Map<string, string>,
): PublicRoonLibraryPage {
  return {
    items: page.items.map((item) => mapDescriptor(item, references, imageReferences)),
    offset: page.offset,
    limit: request.limit,
    ...(page.total !== undefined ? { total: page.total } : {}),
    ...(page.hasMore !== undefined ? { hasMore: page.hasMore } : {}),
  };
}

function imageOptions(options?: PublicRoonImageOptions): RoonImageOptions | undefined {
  if (!options) return undefined;
  return {
    ...(options.scale !== undefined ? { scale: options.scale } : {}),
    ...(options.width !== undefined ? { width: options.width } : {}),
    ...(options.height !== undefined ? { height: options.height } : {}),
    ...(options.format !== undefined ? { format: options.format } : {}),
  };
}

function wrapLibraryError(error: unknown): never {
  if (error instanceof BridgeError) throw error;
  if (error instanceof RoonActionBlockedError) {
    throw new BridgeError('ROON_ACTION_BLOCKED', 'Roon library action is not allowed', {
      httpStatus: 400,
      cause: error,
    });
  }
  if (error instanceof RoonLibraryError) {
    throw new BridgeError('ROON_LIBRARY_REQUEST_FAILED', 'Roon library request failed', {
      httpStatus: 503,
      cause: error,
    });
  }
  throw error;
}

export function createRoonPublicLibrary(
  getService: () => RoonLibraryService | undefined,
): RoonPublicLibrary {
  const references = new Map<string, DescriptorReference>();
  const imageReferences = new Map<string, string>();

  const service = (): RoonLibraryService => {
    const value = getService();
    if (!value) {
      throw new BridgeError('ROON_LIBRARY_UNAVAILABLE', 'Roon Library is not available', {
        httpStatus: 503,
      });
    }
    return value;
  };

  const resolveAlbum = (reference: string): RoonEntityDescriptor => {
    const stored = references.get(reference);
    if (!stored || stored.descriptor.kind !== 'album') {
      throw new BridgeError('ROON_LIBRARY_INVALID_REFERENCE', 'Roon album reference is invalid', {
        httpStatus: 400,
      });
    }
    return stored.descriptor;
  };

  const resolveTrack = (reference: string): RoonEntityDescriptor => {
    const stored = references.get(reference);
    if (!stored || stored.descriptor.kind !== 'track') {
      throw new BridgeError('ROON_LIBRARY_INVALID_REFERENCE', 'Roon track reference is invalid', {
        httpStatus: 400,
      });
    }
    return stored.descriptor;
  };

  const resolveArtist = (reference: string): RoonEntityDescriptor => {
    const stored = references.get(reference);
    if (!stored || stored.descriptor.kind !== 'artist') {
      throw new BridgeError('ROON_LIBRARY_INVALID_REFERENCE', 'Roon artist reference is invalid', {
        httpStatus: 400,
      });
    }
    return stored.descriptor;
  };

  return {
    async browseAlbums(request) {
      try {
        return mapPage(await service().browseAlbums(request), request, references, imageReferences);
      } catch (error) {
        return wrapLibraryError(error);
      }
    },
    async browseArtists(request) {
      try {
        return mapPage(await service().browseArtists(request), request, references, imageReferences);
      } catch (error) {
        return wrapLibraryError(error);
      }
    },
    async browseGenres(request) {
      try {
        return mapPage(await service().browseGenres(request), request, references, imageReferences);
      } catch (error) {
        return wrapLibraryError(error);
      }
    },
    async browsePlaylists(request) {
      try {
        return mapPage(await service().browsePlaylists(request), request, references, imageReferences);
      } catch (error) {
        return wrapLibraryError(error);
      }
    },
    async browseAlbum(reference, request) {
      try {
        return mapPage(
          await service().browseAlbum(resolveAlbum(reference), request),
          request,
          references,
          imageReferences,
        );
      } catch (error) {
        return wrapLibraryError(error);
      }
    },
    async browseArtist(reference, request) {
      try {
        return mapPage(
          await service().browseArtist(resolveArtist(reference), request),
          request,
          references,
          imageReferences,
        );
      } catch (error) {
        return wrapLibraryError(error);
      }
    },
    async searchLibrary(query, request) {
      try {
        return mapPage(
          await service().searchLibrary(query, request),
          request,
          references,
          imageReferences,
        );
      } catch (error) {
        return wrapLibraryError(error);
      }
    },
    async getImage(reference, options) {
      const imageKey = imageReferences.get(reference);
      if (!imageKey) {
        throw new BridgeError('ROON_LIBRARY_INVALID_REFERENCE', 'Roon image reference is invalid', {
          httpStatus: 400,
        });
      }
      try {
        const result = await service().getImage(imageKey, imageOptions(options));
        return {
          contentType: result.contentType,
          body: new Uint8Array(result.body),
        };
      } catch (error) {
        return wrapLibraryError(error);
      }
    },
    async playTrack(reference, zoneOrOutputId) {
      try {
        await service().playTrack(resolveTrack(reference), zoneOrOutputId);
      } catch (error) {
        return wrapLibraryError(error);
      }
    },
    async queueTrack(reference, zoneOrOutputId) {
      try {
        await service().queueTrack(resolveTrack(reference), zoneOrOutputId);
      } catch (error) {
        return wrapLibraryError(error);
      }
    },
    getTrackSummary(reference) {
      const descriptor = resolveTrack(reference);
      const durationMs = toDurationMs(descriptor);
      return {
        id: roonTrackIdFromReference(reference),
        title: descriptor.title,
        artists: [descriptor.artist ?? descriptor.subtitle ?? 'Roon Library'],
        album: descriptor.album ?? 'Roon Library',
        ...(durationMs !== undefined ? { durationMs } : {}),
      };
    },
  };
}
