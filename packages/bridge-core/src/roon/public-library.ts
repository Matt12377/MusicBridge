import type {
  RoonImageOptions as PublicRoonImageOptions,
  RoonImageShapeSummary,
  RoonLibraryItem as PublicRoonLibraryItem,
  RoonLibraryPage as PublicRoonLibraryPage,
  TrackSummary,
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

  return {
    async browseAlbums(request) {
      try {
        const current = service();
        return mapPage(
          await current.browseAlbums(request),
          request,
          references,
          imageReferences,
          referenceScope,
        );
      } catch (error) {
        return wrapLibraryError(error);
      }
    },
    async browseArtists(request) {
      try {
        const current = service();
        return mapPage(
          await current.browseArtists(request),
          request,
          references,
          imageReferences,
          referenceScope,
        );
      } catch (error) {
        return wrapLibraryError(error);
      }
    },
    async browseGenres(request) {
      try {
        const current = service();
        return mapPage(
          await current.browseGenres(request),
          request,
          references,
          imageReferences,
          referenceScope,
        );
      } catch (error) {
        return wrapLibraryError(error);
      }
    },
    async browsePlaylists(request) {
      try {
        const current = service();
        return mapPage(
          await current.browsePlaylists(request),
          request,
          references,
          imageReferences,
          referenceScope,
        );
      } catch (error) {
        return wrapLibraryError(error);
      }
    },
    async browseAlbum(reference, request) {
      try {
        const current = service();
        return mapPage(
          await current.browseAlbum(resolveAlbum(reference), request),
          request,
          references,
          imageReferences,
          referenceScope,
        );
      } catch (error) {
        return wrapLibraryError(error);
      }
    },
    async browseArtist(reference, request) {
      try {
        const current = service();
        return mapPage(
          await current.browseArtist(resolveArtist(reference), request),
          request,
          references,
          imageReferences,
          referenceScope,
        );
      } catch (error) {
        return wrapLibraryError(error);
      }
    },
    async searchLibrary(query, request) {
      try {
        const current = service();
        return mapPage(
          await current.searchLibrary(query, request),
          request,
          references,
          imageReferences,
          referenceScope,
        );
      } catch (error) {
        return wrapLibraryError(error);
      }
    },
    async getImage(reference, options) {
      const current = service();
      const imageKey = imageReferences.get(reference);
      if (!imageKey) {
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
                  'ROON_IMAGE_REQUEST_FAILED',
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
        return wrapLibraryError(error);
      }
    },
    async playTrack(reference, zoneOrOutputId) {
      try {
        const current = service();
        await current.playTrack(resolveTrack(reference), zoneOrOutputId);
      } catch (error) {
        return wrapLibraryError(error);
      }
    },
    async queueTrack(reference, zoneOrOutputId) {
      try {
        const current = service();
        await current.queueTrack(resolveTrack(reference), zoneOrOutputId);
      } catch (error) {
        return wrapLibraryError(error);
      }
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
        ...(stored.imageReference !== undefined
          ? { artworkReference: stored.imageReference }
          : {}),
      };
    },
  };
}
