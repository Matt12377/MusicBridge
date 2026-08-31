import type {
  RoonImageOptions as PublicRoonImageOptions,
  RoonImageShapeSummary,
  RoonLibraryItem as PublicRoonLibraryItem,
  RoonLibraryPage as PublicRoonLibraryPage,
  TrackSummary,
  DraftTrackMetadata,
} from '@music-bridge/contracts';
import {
  isValidRoonImageBinary,
  roonTrackIdFromReference,
  summarizeRoonImageBinary,
} from '@music-bridge/contracts';
import { createHash, randomUUID } from 'node:crypto';
import { BridgeError } from '../shared/errors.js';
import { RoonActionBlockedError } from './action-policy.js';
import {
  RoonLibraryError,
  type RoonEntityDescriptor,
  type RoonImageOptions,
  type RoonLibraryPage,
  type RoonLibraryService,
  type RoonPageRequest,
  type RoonSearchResultKind,
  type RoonTrackActionOutcome,
} from './library.js';

const MAX_REFERENCES = 65_536;
const DEFAULT_MAX_IMAGE_CACHE_ENTRIES = 128;
const DEFAULT_MAX_IMAGE_CACHE_BYTES = 32 * 1024 * 1024;
const DEFAULT_NEGATIVE_IMAGE_TTL_MS = 3_000;

export interface RoonPublicLibraryOptions {
  maxImageCacheEntries?: number;
  maxImageCacheBytes?: number;
  negativeImageTtlMs?: number;
  now?: () => number;
  onImageShape?: (summary: RoonImageShapeSummary) => void;
}

export interface RoonAlbumMetadata { title: string; artist?: string; year?: number; version?: string }

export interface RoonPublicLibrary {
  invalidateReferences(): void;
  /** Core 内部专辑元数据快照，不包含运行期引用或私有 Browse 身份。 */
  getAlbumSnapshot(reference: string): RoonAlbumMetadata;
  getTrackSnapshot(reference: string): DraftTrackMetadata;
  browseAlbums(request: RoonPageRequest): Promise<PublicRoonLibraryPage>;
  browseArtists(request: RoonPageRequest): Promise<PublicRoonLibraryPage>;
  browseGenres(request: RoonPageRequest): Promise<PublicRoonLibraryPage>;
  browsePlaylists(request: RoonPageRequest): Promise<PublicRoonLibraryPage>;
  browseAlbum(reference: string, request: RoonPageRequest): Promise<PublicRoonLibraryPage>;
  browseArtist(reference: string, request: RoonPageRequest): Promise<PublicRoonLibraryPage>;
  browseGenre(reference: string, request: RoonPageRequest): Promise<PublicRoonLibraryPage>;
  browsePlaylist(reference: string, request: RoonPageRequest): Promise<PublicRoonLibraryPage>;
  searchLibrary(
    query: string,
    request: RoonPageRequest,
    kind?: RoonSearchResultKind,
  ): Promise<PublicRoonLibraryPage>;
  getImage(reference: string, options?: PublicRoonImageOptions): Promise<{
    contentType: string;
    body: Uint8Array;
  }>;
  playTrack(reference: string, zoneOrOutputId: string): Promise<RoonTrackActionOutcome | void>;
  queueTrack(reference: string, zoneOrOutputId: string): Promise<RoonTrackActionOutcome | void>;
  /** Core 内部使用的安全元数据投影；不暴露 Roon item_key 或运行期引用。 */
  getTrackSummary(reference: string): TrackSummary;
}

interface DescriptorReference {
  descriptor: RoonEntityDescriptor;
  imageReference?: string;
}

interface CachedImage {
  contentType: string;
  body: Uint8Array;
}

interface NegativeImageEntry {
  error: unknown;
  expiresAt: number;
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

function uuidFromIdentity(scope: string, identity: string): string {
  const bytes = Buffer.from(createHash('sha256').update(`${scope}\0${identity}`).digest().subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function createToken(prefix: string, scope: string, identity: string): string {
  return `musicbridge-v2-${prefix}-${uuidFromIdentity(scope, identity)}`;
}

function descriptorIdentity(descriptor: RoonEntityDescriptor): string {
  if (descriptor.browseContext?.pathSignature) return descriptor.browseContext.pathSignature;
  return createHash('sha256').update([
    descriptor.hierarchy ?? '',
    descriptor.kind,
    descriptor.title,
    descriptor.subtitle ?? '',
    descriptor.artist ?? '',
    descriptor.album ?? '',
    String(descriptor.trackNumber ?? ''),
    String(descriptor.discNumber ?? ''),
    String(descriptor.durationMs ?? descriptor.durationSeconds ?? ''),
    descriptor.version ?? '',
    descriptor.itemKey ?? '',
  ].join('\0')).digest('hex');
}

function addReference<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (!map.has(key) && map.size >= MAX_REFERENCES) {
    throw new RoonLibraryError(
      'ROON_LIBRARY_RESPONSE_INVALID',
      'Roon runtime reference capacity is exhausted',
    );
  }
  map.set(key, value);
}

function mapDescriptor(
  descriptor: RoonEntityDescriptor,
  references: Map<string, DescriptorReference>,
  imageReferences: Map<string, string>,
  scope: string,
): PublicRoonLibraryItem {
  const identity = descriptorIdentity(descriptor);
  const reference = createToken('entity', scope, identity);
  let artworkReference: string | undefined;
  if (descriptor.imageKey) {
    artworkReference = createToken('image', scope, descriptor.imageKey);
    addReference(imageReferences, artworkReference, descriptor.imageKey);
  }
  addReference(references, reference, {
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
    ...(descriptor.bitrate !== undefined ? { bitrate: descriptor.bitrate } : {}),
    ...(descriptor.format !== undefined ? { format: descriptor.format } : {}),
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
  scope: string,
): PublicRoonLibraryPage {
  return {
    items: page.items.map((item) => mapDescriptor(item, references, imageReferences, scope)),
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

function normalizedImageOptions(options?: PublicRoonImageOptions): Required<PublicRoonImageOptions> {
  return {
    scale: options?.scale ?? 'fit',
    width: options?.width ?? 256,
    height: options?.height ?? 256,
    format: options?.format ?? 'image/jpeg',
  };
}

function requireBoundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return resolved;
}

function wrapLibraryError(
  error: unknown,
  operation: 'generic' | 'album' | 'image' | 'track-action' = 'generic',
): never {
  if (error instanceof BridgeError) throw error;
  if (error instanceof RoonActionBlockedError) {
    throw new BridgeError('ROON_ACTION_BLOCKED', 'Roon library action is not allowed', {
      httpStatus: 400,
      cause: error,
    });
  }
  if (error instanceof RoonLibraryError) {
    if (operation === 'album' && error.code === 'ROON_LIBRARY_RESPONSE_INVALID') {
      throw new BridgeError(
        'ROON_ALBUM_HIERARCHY_INVALID',
        'Roon album hierarchy is invalid',
        { httpStatus: 502, cause: error },
      );
    }
    if (error.code === 'ROON_TRACK_ACTION_UNAVAILABLE') {
      throw new BridgeError(
        'ROON_TRACK_ACTION_UNAVAILABLE',
        'Roon track action is unavailable',
        { httpStatus: 409, cause: error },
      );
    }
    if (operation === 'image' && error.code === 'ROON_IMAGE_DECODE_FAILED') {
      throw new BridgeError(
        'ROON_IMAGE_DECODE_FAILED',
        'Roon image decode failed',
        { httpStatus: 502, cause: error },
      );
    }
    if (operation === 'image' && error.code === 'ROON_IMAGE_UNAVAILABLE') {
      throw new BridgeError(
        'ROON_IMAGE_UNAVAILABLE',
        'Roon image is unavailable',
        { httpStatus: 404, cause: error },
      );
    }
    throw new BridgeError('ROON_LIBRARY_REQUEST_FAILED', 'Roon library request failed', {
      httpStatus: 503,
      cause: error,
    });
  }
  throw error;
}

export function createRoonPublicLibrary(
  getService: () => RoonLibraryService | undefined,
  libraryOptions: RoonPublicLibraryOptions = {},
): RoonPublicLibrary {
  const maxImageCacheEntries = requireBoundedInteger(
    libraryOptions.maxImageCacheEntries,
    DEFAULT_MAX_IMAGE_CACHE_ENTRIES,
    1_024,
    'Roon image cache entry limit',
  );
  const maxImageCacheBytes = requireBoundedInteger(
    libraryOptions.maxImageCacheBytes,
    DEFAULT_MAX_IMAGE_CACHE_BYTES,
    256 * 1024 * 1024,
    'Roon image cache byte limit',
  );
  const negativeImageTtlMs = requireBoundedInteger(
    libraryOptions.negativeImageTtlMs,
    DEFAULT_NEGATIVE_IMAGE_TTL_MS,
    60_000,
    'Roon image negative-cache TTL',
  );
  const now = libraryOptions.now ?? Date.now;
  const references = new Map<string, DescriptorReference>();
  const imageReferences = new Map<string, string>();
  const imageCache = new Map<string, CachedImage>();
  const pendingImages = new Map<string, Promise<CachedImage>>();
  const negativeImages = new Map<string, NegativeImageEntry>();
  let imageCacheBytes = 0;
  let activeService: RoonLibraryService | undefined;
  let referenceScope = randomUUID();

  const clearImageState = (): void => {
    imageCache.clear();
    pendingImages.clear();
    negativeImages.clear();
    imageCacheBytes = 0;
  };

  const touchCachedImage = (key: string): CachedImage | undefined => {
    const cached = imageCache.get(key);
    if (!cached) return undefined;
    imageCache.delete(key);
    imageCache.set(key, cached);
    return cached;
  };

  const cacheImage = (key: string, image: CachedImage): void => {
    const existing = imageCache.get(key);
    if (existing) {
      imageCacheBytes -= existing.body.byteLength;
      imageCache.delete(key);
    }
    while (
      imageCache.size > 0
      && (imageCache.size >= maxImageCacheEntries
        || imageCacheBytes + image.body.byteLength > maxImageCacheBytes)
    ) {
      const oldestKey = imageCache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const oldest = imageCache.get(oldestKey);
      imageCache.delete(oldestKey);
      imageCacheBytes -= oldest?.body.byteLength ?? 0;
    }
    if (
      image.body.byteLength <= maxImageCacheBytes
      && imageCache.size < maxImageCacheEntries
      && imageCacheBytes + image.body.byteLength <= maxImageCacheBytes
    ) {
      imageCache.set(key, image);
      imageCacheBytes += image.body.byteLength;
    }
  };

  const cloneImage = (image: CachedImage): CachedImage => ({
    contentType: image.contentType,
    body: new Uint8Array(image.body),
  });

  const service = (): RoonLibraryService => {
    const value = getService();
    if (!value) {
      if (activeService) { references.clear(); imageReferences.clear(); clearImageState(); referenceScope = randomUUID(); activeService = undefined; }
      throw new BridgeError('ROON_LIBRARY_UNAVAILABLE', 'Roon Library is not available', {
        httpStatus: 503,
      });
    }
    if (activeService && activeService !== value) {
      references.clear();
      imageReferences.clear();
      clearImageState();
      referenceScope = randomUUID();
    }
    activeService = value;
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

  const resolveTrackReference = (reference: string): DescriptorReference => {
    const stored = references.get(reference);
    if (!stored || stored.descriptor.kind !== 'track') {
      throw new BridgeError('ROON_LIBRARY_INVALID_REFERENCE', 'Roon track reference is invalid', {
        httpStatus: 400,
      });
    }
    return stored;
  };

  const resolveTrack = (reference: string): RoonEntityDescriptor =>
    resolveTrackReference(reference).descriptor;

  const resolveArtist = (reference: string): RoonEntityDescriptor => {
    const stored = references.get(reference);
    if (!stored || stored.descriptor.kind !== 'artist') {
      throw new BridgeError('ROON_LIBRARY_INVALID_REFERENCE', 'Roon artist reference is invalid', {
        httpStatus: 400,
      });
    }
    return stored.descriptor;
  };

  const resolveGenre = (reference: string): RoonEntityDescriptor => {
    const stored = references.get(reference);
    if (!stored || stored.descriptor.kind !== 'genre') {
      throw new BridgeError('ROON_LIBRARY_INVALID_REFERENCE', 'Roon genre reference is invalid', {
        httpStatus: 400,
      });
    }
    return stored.descriptor;
  };

  const resolvePlaylist = (reference: string): RoonEntityDescriptor => {
    const stored = references.get(reference);
    if (!stored || stored.descriptor.kind !== 'playlist') {
      throw new BridgeError('ROON_LIBRARY_INVALID_REFERENCE', 'Roon playlist reference is invalid', {
        httpStatus: 400,
      });
    }
    return stored.descriptor;
  };

  function currentPage(page: RoonLibraryPage<RoonEntityDescriptor>, request: RoonPageRequest, current: RoonLibraryService, scope: string): PublicRoonLibraryPage {
    if (service() !== current || referenceScope !== scope) {
      throw new BridgeError('ROON_LIBRARY_INVALID_REFERENCE', 'Roon 浏览结果已过期，请重新选择当前专辑。', { httpStatus: 409 });
    }
    return mapPage(page, request, references, imageReferences, scope);
  }

  return {
    invalidateReferences() { references.clear(); imageReferences.clear(); clearImageState(); referenceScope = randomUUID(); activeService = undefined; },
    getAlbumSnapshot(reference) {
      service();
      const descriptor = resolveAlbum(reference);
      return { title: descriptor.title, ...(descriptor.artist !== undefined ? { artist: descriptor.artist } : {}),
        ...(descriptor.year !== undefined ? { year: descriptor.year } : {}), ...(descriptor.version !== undefined ? { version: descriptor.version } : {}) };
    },
    async browseAlbums(request) {
      try {
        const current = service();
        const scope = referenceScope;
        return currentPage(
          await current.browseAlbums(request),
          request,
          current,
          scope,
        );
      } catch (error) {
        return wrapLibraryError(error);
      }
    },
    async browseArtists(request) {
      try {
        const current = service();
        const scope = referenceScope;
        return currentPage(
          await current.browseArtists(request),
          request,
          current,
          scope,
        );
      } catch (error) {
        return wrapLibraryError(error);
      }
    },
    async browseGenres(request) {
      try {
        const current = service();
        const scope = referenceScope;
        return currentPage(
          await current.browseGenres(request),
          request,
          current,
          scope,
        );
      } catch (error) {
        return wrapLibraryError(error);
      }
    },
    async browsePlaylists(request) {
      try {
        const current = service();
        const scope = referenceScope;
        return currentPage(
          await current.browsePlaylists(request),
          request,
          current,
          scope,
        );
      } catch (error) {
        return wrapLibraryError(error);
      }
    },
    async browseAlbum(reference, request) {
      try {
        const current = service();
        const scope = referenceScope;
        return currentPage(
          await current.browseAlbum(resolveAlbum(reference), request),
          request,
          current,
          scope,
        );
      } catch (error) {
        return wrapLibraryError(error, 'album');
      }
    },
    async browseArtist(reference, request) {
      try {
        const current = service();
        const scope = referenceScope;
        return currentPage(
          await current.browseArtist(resolveArtist(reference), request),
          request,
          current,
          scope,
        );
      } catch (error) {
        return wrapLibraryError(error);
      }
    },
    async browseGenre(reference, request) {
      try {
        const current = service();
        const scope = referenceScope;
        return currentPage(
          await current.browseGenre(resolveGenre(reference), request),
          request,
          current,
          scope,
        );
      } catch (error) {
        return wrapLibraryError(error);
      }
    },
    async browsePlaylist(reference, request) {
      try {
        const current = service();
        const scope = referenceScope;
        return currentPage(
          await current.browsePlaylist(resolvePlaylist(reference), request),
          request,
          current,
          scope,
        );
      } catch (error) {
        return wrapLibraryError(error);
      }
    },
    async searchLibrary(query, request, kind) {
      try {
        const current = service();
        const scope = referenceScope;
        return currentPage(
          await current.searchLibrary(query, request, kind),
          request,
          current,
          scope,
        );
      } catch (error) {
        return wrapLibraryError(error);
      }
    },
    async getImage(reference, options) {
      const current = service();
      let imageKey = imageReferences.get(reference);
      const stored = references.get(reference);
      if (!imageKey) {
        if (stored?.descriptor.kind === 'artist' && current.getArtistImageKey) {
          try {
            imageKey = await current.getArtistImageKey(stored.descriptor);
            if (imageKey) imageReferences.set(reference, imageKey);
          } catch (error) {
            return wrapLibraryError(error, 'image');
          }
        }
      }
      if (!imageKey) {
        if (stored?.descriptor.kind === 'artist') {
          throw new BridgeError('ROON_IMAGE_UNAVAILABLE', 'Roon artist image is unavailable', {
            httpStatus: 404,
          });
        }
        throw new BridgeError('ROON_LIBRARY_INVALID_REFERENCE', 'Roon image reference is invalid', {
          httpStatus: 400,
        });
      }
      try {
        const normalized = normalizedImageOptions(options);
        const cacheKey = JSON.stringify([
          referenceScope,
          imageKey,
          normalized.width,
          normalized.height,
          normalized.format,
          normalized.scale,
        ]);
        const cached = touchCachedImage(cacheKey);
        if (cached) return cloneImage(cached);
        const negative = negativeImages.get(cacheKey);
        if (negative) {
          if (negative.expiresAt > now()) throw negative.error;
          negativeImages.delete(cacheKey);
        }
        let pending = pendingImages.get(cacheKey);
        if (!pending) {
          pending = (async () => {
            try {
              const result = await current.getImage(imageKey, imageOptions(normalized));
              const body = new Uint8Array(result.body);
              if (!isValidRoonImageBinary(result.contentType, body)) {
                throw new RoonLibraryError(
                  'ROON_IMAGE_DECODE_FAILED',
                  'Roon image response failed binary validation',
                );
              }
              const image = { contentType: result.contentType, body };
              try {
                libraryOptions.onImageShape?.(
                  summarizeRoonImageBinary('bridge-core-output', image.contentType, image.body),
                );
              } catch {
                // 诊断回调不得改变图片行为。
              }
              cacheImage(cacheKey, image);
              return image;
            } catch (error) {
              negativeImages.set(cacheKey, {
                error,
                expiresAt: now() + negativeImageTtlMs,
              });
              throw error;
            } finally {
              pendingImages.delete(cacheKey);
            }
          })();
          pendingImages.set(cacheKey, pending);
        }
        return cloneImage(await pending);
      } catch (error) {
        return wrapLibraryError(error, 'image');
      }
    },
    async playTrack(reference, zoneOrOutputId) {
      try {
        const current = service();
        return await current.playTrack(resolveTrack(reference), zoneOrOutputId);
      } catch (error) {
        return wrapLibraryError(error, 'track-action');
      }
    },
    async queueTrack(reference, zoneOrOutputId) {
      try {
        const current = service();
        return await current.queueTrack(resolveTrack(reference), zoneOrOutputId);
      } catch (error) {
        return wrapLibraryError(error, 'track-action');
      }
    },
    getTrackSnapshot(reference) {
      service();
      const { descriptor } = resolveTrackReference(reference);
      const durationMs = toDurationMs(descriptor);
      // 不把缺失字段的 UI 占位文字、运行期身份和封面引用写成档案元数据。
      return {
        title: descriptor.title,
        ...(descriptor.artist ? { artist: descriptor.artist } : {}),
        ...(descriptor.album ? { album: descriptor.album } : {}),
        ...(descriptor.version ? { version: descriptor.version } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(descriptor.discNumber !== undefined ? { discNumber: descriptor.discNumber } : {}),
        ...(descriptor.trackNumber !== undefined ? { trackNumber: descriptor.trackNumber } : {}),
      };
    },
    getTrackSummary(reference) {
      service();
      const stored = resolveTrackReference(reference);
      const descriptor = stored.descriptor;
      const durationMs = toDurationMs(descriptor);
      return {
        id: roonTrackIdFromReference(reference),
        title: descriptor.title,
        artists: [descriptor.artist ?? descriptor.subtitle ?? 'Roon Library'],
        album: descriptor.album ?? 'Roon Library',
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(descriptor.version !== undefined ? { version: descriptor.version } : {}),
        ...(descriptor.bitrate !== undefined ? { bitrate: descriptor.bitrate } : {}),
        ...(descriptor.format !== undefined ? { format: descriptor.format } : {}),
        ...(stored.imageReference !== undefined
          ? { artworkReference: stored.imageReference }
          : {}),
      };
    },
  };
}
