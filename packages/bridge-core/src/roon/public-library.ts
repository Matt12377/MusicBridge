import type { RoonPlaybackContextLease, RoonPlaybackContextPage } from './playback-context.js';
import { assertLibraryReadCurrent, currentLibraryRead } from '../shared/library-read-lifetime.js';
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
  type RoonCapturedTrackActions,
} from './library.js';

const MAX_REFERENCES = 65_536;
const DEFAULT_MAX_REFERENCE_CACHE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_IMAGE_CACHE_ENTRIES = 128;
const DEFAULT_MAX_IMAGE_CACHE_BYTES = 32 * 1024 * 1024;
const DEFAULT_NEGATIVE_IMAGE_TTL_MS = 3_000;

export interface RoonPublicLibraryOptions {
  incrementalPlaybackContexts?: boolean;
  /** 受信任组合层设置；实体及图片引用各自的保留数据计量预算。 */
  maxReferenceCacheBytes?: number;
  maxImageCacheEntries?: number;
  maxImageCacheBytes?: number;
  negativeImageTtlMs?: number;
  now?: () => number;
  onImageShape?: (summary: RoonImageShapeSummary) => void;
}

export interface RoonAlbumMetadata { title: string; artist?: string; year?: number; version?: string }

export interface RoonPublicLibrary {
  acquirePlaybackContext(handle: string, selectedReference: string, zoneId: string): RoonPlaybackContextLease;
  getReadScope(): string;
  invalidateReferences(): void;
  /** 仅 Core 调用；将 Transport 封面键接入已有受控图片读取链路。 */
  registerNowPlayingArtwork(imageKey: string): string;
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
  playTrack(reference: string, zoneOrOutputId: string, onDispatch?: () => void): Promise<RoonTrackActionOutcome | void>;
  queueTrack(reference: string, zoneOrOutputId: string): Promise<RoonTrackActionOutcome | void>;
  /** Core 内部使用的安全元数据投影；不暴露 Roon item_key 或运行期引用。 */
  getTrackSummary(reference: string): TrackSummary;
}

interface DescriptorReference {
  descriptor: RoonEntityDescriptor;
  actions?: RoonCapturedTrackActions;
  imageReference?: string;
}

/** 计量引用自身与已支持标量，不是实际RSS；既有引用不因新页挤压而静默失效。 */
class ReferenceMap<T> extends Map<string, T> {
  private retainedBytes = 0;
  private readonly sizes = new Map<string, number>();
  constructor(private readonly maximumBytes: number, private readonly measure: (value: T) => number) { super(); }
  override set(key: string, value: T): this {
    const bytes = 1_024 + key.length * 2 + this.measure(value);
    const nextBytes = this.retainedBytes - (this.sizes.get(key) ?? 0) + bytes;
    if (nextBytes > this.maximumBytes) throw new RoonLibraryError('ROON_LIBRARY_RESPONSE_INVALID', '公开引用字节预算已满，请重新读取');
    super.set(key, value); this.sizes.set(key, bytes); this.retainedBytes = nextBytes;
    return this;
  }
  prepare(entries: Iterable<[string, T]>): void {
    let bytes = this.retainedBytes, additions = 0;
    for (const [key, value] of entries) {
      bytes += 1_024 + key.length * 2 + this.measure(value) - (this.sizes.get(key) ?? 0);
      if (!this.has(key)) additions++;
    }
    if (bytes > this.maximumBytes || this.size + additions > MAX_REFERENCES) throw new RoonLibraryError('ROON_LIBRARY_RESPONSE_INVALID', '公开引用预算已满');
  }
  override delete(key: string): boolean {
    const deleted = super.delete(key);
    if (deleted) { this.retainedBytes -= this.sizes.get(key) ?? 0; this.sizes.delete(key); }
    return deleted;
  }
  override clear(): void { super.clear(); this.sizes.clear(); this.retainedBytes = 0; }
}

function descriptorReferenceBytes(value: DescriptorReference): number {
  const descriptor = value.descriptor;
  const strings = [descriptor.kind, descriptor.hierarchy, descriptor.title, descriptor.subtitle,
    descriptor.artist, descriptor.album, descriptor.itemKey, descriptor.imageKey, descriptor.hint,
    descriptor.format, descriptor.version, value.imageReference];
  const context = descriptor.browseContext;
  if (context) strings.push(context.hierarchy, context.multiSessionKey, context.itemKey,
    context.kind, context.parentReference, context.pathSignature);
  return 1_024 + strings.reduce((bytes, text) => bytes + (text?.length ?? 0) * 2, 0) + (value.actions?.retainedBytes ?? 0);
}

/** 页内暂存，预先核两个Map预算后一起提交；不扫描/复制整个累计引用表。 */
class ReferenceDraft<T> extends Map<string, T> {
  constructor(private readonly base: Map<string, T>) { super(); }
  override get(key: string): T | undefined { return super.has(key) ? super.get(key) : this.base.get(key); }
  override has(key: string): boolean { return super.has(key) || this.base.has(key); }
  override get size(): number { let additions = 0; for (const key of super.keys()) if (!this.base.has(key)) additions++; return this.base.size + additions; }
}
interface PlaybackRegistration {
  handle: string;
  key: string;
  service: RoonLibraryService;
  scope: string;
  parentReference: string;
  epoch: string;
  positions: Map<number, string>;
  eof?: number;
  touched: number;
  pins: number;
  bytes: number;
}
const MAX_CONTEXT_REGISTRATIONS = 64;
const MAX_CONTEXT_REGISTRY_BYTES = 8 * 1024 * 1024;
const CONTEXT_IDLE_TTL_MS = 5 * 60 * 1000;
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
  capture?: (descriptor: RoonEntityDescriptor) => RoonCapturedTrackActions | undefined,
): PublicRoonLibraryItem {
  const identity = descriptorIdentity(descriptor);
  const reference = createToken('entity', scope, identity);
  const existing = references.get(reference);
  if (descriptor.kind === 'track' && existing?.actions) descriptor = existing.descriptor;
  let artworkReference: string | undefined;
  if (descriptor.imageKey) {
    artworkReference = createToken('image', scope, descriptor.imageKey);
    addReference(imageReferences, artworkReference, descriptor.imageKey);
  }
  const actions = descriptor.kind === 'track' ? existing?.actions ?? capture?.(descriptor) : undefined;
  addReference(references, reference, {
    descriptor,
    ...(actions ? { actions } : {}),
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
    ...(descriptor.albumCount !== undefined ? { albumCount: descriptor.albumCount } : {}),
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
  capture?: (descriptor: RoonEntityDescriptor) => RoonCapturedTrackActions | undefined,
): PublicRoonLibraryPage {
  return {
    items: page.items.map((item) => mapDescriptor(item, references, imageReferences, scope, capture)),
    offset: page.offset,
    limit: request.limit,
    ...(page.total !== undefined ? { total: page.total } : {}),
    ...(page.hasMore !== undefined ? { hasMore: page.hasMore } : {}),
    ...(page.sourceEpoch !== undefined ? { sourceEpoch: uuidFromIdentity(scope, `browse-source\0${page.sourceEpoch}`) } : {}),
    ...(page.complete !== undefined ? { complete: page.complete } : {}),
    ...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}),
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
  const maxReferenceCacheBytes = requireBoundedInteger(libraryOptions.maxReferenceCacheBytes,
    DEFAULT_MAX_REFERENCE_CACHE_BYTES, 128 * 1024 * 1024, '公开引用字节预算');
  const now = libraryOptions.now ?? Date.now;
  const references = new ReferenceMap<DescriptorReference>(maxReferenceCacheBytes, descriptorReferenceBytes);
  const imageReferences = new ReferenceMap<string>(maxReferenceCacheBytes, value => value.length * 2);
  const imageCache = new Map<string, CachedImage>();
  const pendingImages = new Map<string, Promise<CachedImage>>();
  const imageReadOwners = new WeakMap<Promise<CachedImage>, NonNullable<ReturnType<typeof currentLibraryRead>>>();
  const negativeImages = new Map<string, NegativeImageEntry>();
  let imageCacheBytes = 0;
  let activeService: RoonLibraryService | undefined;
  let referenceScope = randomUUID();
  const contexts = new Map<string, PlaybackRegistration>();
  const contextKeys = new Map<string, string>();
  const leases = new Set<RoonPlaybackContextLease>();
  const dropRegistration = (entry: PlaybackRegistration) => { contexts.delete(entry.handle); if (contextKeys.get(entry.key) === entry.handle) contextKeys.delete(entry.key); };
  const pruneContexts = () => { for (const entry of contexts.values()) if (entry.pins === 0 && now() - entry.touched >= CONTEXT_IDLE_TTL_MS) dropRegistration(entry); };
  const contextBytes = () => [...contexts.values()].reduce((sum, entry) => sum + entry.bytes, 0);


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

  const invalidateScope = (): void => {
    // 公共引用换代时同步撤销Core遍历，不能只换公开标签而继续复用旧详情。
    activeService?.invalidateReadContexts?.();
    for (const lease of leases) lease.release();
    contexts.clear(); contextKeys.clear();
    references.clear();
    imageReferences.clear();
    clearImageState();
    referenceScope = randomUUID();
    activeService = undefined;
  };

  const service = (): RoonLibraryService => {
    const value = getService();
    if (!value) {
      if (activeService) invalidateScope();
      throw new BridgeError('ROON_LIBRARY_UNAVAILABLE', 'Roon Library is not available', {
        httpStatus: 503,
      });
    }
    if (activeService && activeService !== value) {
      invalidateScope();
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

  const capture = (current: RoonLibraryService, scope: string) => (descriptor: RoonEntityDescriptor): RoonCapturedTrackActions | undefined => {
    if (!current.captureTrackActions) return undefined;
    const action = current.captureTrackActions(descriptor);
    if (!Number.isSafeInteger(action.retainedBytes) || action.retainedBytes < 0 || action.retainedBytes > maxReferenceCacheBytes) throw new RoonLibraryError('ROON_LIBRARY_RESPONSE_INVALID', '曲目动作快照预算超限');
    const guard = () => { if (service() !== current || referenceScope !== scope) throw new BridgeError('ROON_LIBRARY_INVALID_REFERENCE', '曲目动作快照已过期', { httpStatus: 409 }); };
    return { retainedBytes: action.retainedBytes + 256,
      play(zone, onDispatch) { guard(); return action.play(zone, () => { guard(); onDispatch?.(); guard(); }); },
      queue(zone) { guard(); return action.queue(zone); },
    };
  };
  const registration = (parentReference: string, page: RoonLibraryPage<RoonEntityDescriptor>, mapped: PublicRoonLibraryPage, current: RoonLibraryService, scope: string): PlaybackRegistration | undefined => {
    if (libraryOptions.incrementalPlaybackContexts === false || !current.forkPlaybackContext || !page.sourceEpoch) return undefined;
    pruneContexts();
    const key = `${scope}\0${parentReference}\0${page.sourceEpoch}`;
    const old = contexts.get(contextKeys.get(key) ?? '');
    const positions = new Map(old?.positions);
    mapped.items.forEach((item, index) => { const position = page.offset + index; const known = positions.get(position); if (known && known !== item.reference) throw new RoonLibraryError('ROON_LIBRARY_RESPONSE_INVALID', '公开播放窗口身份改变'); positions.set(position, item.reference); });
    if (positions.size > 8192) throw new RoonLibraryError('ROON_LIBRARY_RESPONSE_INVALID', '播放授权位置预算已满');
    const bytes = 512 + 2 * (key.length + parentReference.length + scope.length + page.sourceEpoch.length) + [...positions.values()].reduce((sum, reference) => sum + 128 + reference.length * 2, 0);
    while ((old ? contexts.size : contexts.size + 1) > MAX_CONTEXT_REGISTRATIONS || contextBytes() - (old?.bytes ?? 0) + bytes > MAX_CONTEXT_REGISTRY_BYTES) {
      const idle = [...contexts.values()].find(value => value !== old && value.pins === 0);
      if (!idle) throw new RoonLibraryError('ROON_LIBRARY_RESPONSE_INVALID', '播放上下文注册预算已满');
      dropRegistration(idle);
    }
    return { handle: old?.handle ?? randomUUID(), key, service: current, scope, parentReference, epoch: page.sourceEpoch, positions, touched: now(), pins: old?.pins ?? 0, bytes,
      ...(page.complete && page.total !== undefined ? { eof: page.total } : old?.eof !== undefined ? { eof: old.eof } : {}),
    };
  };
  function currentPage(page: RoonLibraryPage<RoonEntityDescriptor>, request: RoonPageRequest, current: RoonLibraryService, scope: string, parentReference?: string): PublicRoonLibraryPage {
    assertLibraryReadCurrent();
    if (service() !== current || referenceScope !== scope) throw new BridgeError('ROON_LIBRARY_INVALID_REFERENCE', 'Roon 浏览结果已过期，请重新选择当前专辑。', { httpStatus: 409 });
    const entityDraft = new ReferenceDraft(references), imageDraft = new ReferenceDraft(imageReferences);
    const mapped = mapPage(page, request, entityDraft, imageDraft, scope, capture(current, scope));
    const entry = parentReference ? registration(parentReference, page, mapped, current, scope) : undefined;
    references.prepare(entityDraft); imageReferences.prepare(imageDraft);
    for (const [key, value] of entityDraft) references.set(key, value);
    for (const [key, value] of imageDraft) imageReferences.set(key, value);
    if (entry) { const previous = contexts.get(entry.handle); if (previous) Object.assign(previous, entry); else contexts.set(entry.handle, entry); contextKeys.set(entry.key, entry.handle); }
    return { ...mapped, ...(entry ? { playbackContextHandle: entry.handle } : {}) };
  }
  const summary = (reference: string): TrackSummary => {
    const stored = resolveTrackReference(reference), descriptor = stored.descriptor, durationMs = toDurationMs(descriptor);
    return { id: roonTrackIdFromReference(reference), title: descriptor.title,
      artists: [descriptor.artist ?? descriptor.subtitle ?? 'Roon Library'], album: descriptor.album ?? 'Roon Library',
      ...(durationMs !== undefined ? { durationMs } : {}), ...(descriptor.version !== undefined ? { version: descriptor.version } : {}),
      ...(descriptor.bitrate !== undefined ? { bitrate: descriptor.bitrate } : {}), ...(descriptor.format !== undefined ? { format: descriptor.format } : {}),
      ...(stored.imageReference !== undefined ? { artworkReference: stored.imageReference } : {}),
    };
  };
  const expired = () => new BridgeError('ROON_LIBRARY_INVALID_REFERENCE', '播放上下文已过期，请重新选择', { httpStatus: 409 });
  const acquirePlaybackContext = (handle: string, selected: string, zone: string): RoonPlaybackContextLease => {
    const current = service(); pruneContexts();
    const entry = contexts.get(handle);
    if (libraryOptions.incrementalPlaybackContexts === false || !entry || entry.service !== current || entry.scope !== referenceScope || !current.forkPlaybackContext) throw expired();
    const selectedPosition = [...entry.positions].find(([, reference]) => reference === selected)?.[0];
    if (selectedPosition === undefined || resolveTrackReference(selected).descriptor.kind !== 'track') throw expired();
    let offset = selectedPosition, end = selectedPosition + 1;
    while (entry.positions.has(offset - 1)) offset--;
    while (entry.positions.has(end)) end++;
    // initial只投影最多一页已授权窗口，不把累计授权再次全量塞入首播。
    offset = Math.max(offset, selectedPosition - 49);
    end = Math.min(end, offset + 100);
    const publicItems = (positions: readonly [number, string][], start: number, next: number, complete: boolean): RoonPlaybackContextPage => ({
      offset: start, nextOffset: next, complete,
      items: positions.filter(([, reference]) => references.get(reference)?.descriptor.kind === 'track').map(([, reference]) => {
        const stored = resolveTrackReference(reference);
        const roonItem = mapDescriptor(stored.descriptor, new ReferenceDraft(references), new ReferenceDraft(imageReferences), entry.scope);
        return { reference, zoneId: zone, track: summary(reference), roonItem };
      }),
    });
    const initialPage = publicItems([...entry.positions].filter(([position]) => position >= offset && position < end).sort(([a], [b]) => a - b), offset, end, entry.eof !== undefined && end >= entry.eof);
    const selectedIndex = initialPage.items.findIndex(item => item.reference === selected);
    if (selectedIndex < 0) throw expired();
    const parent = references.get(entry.parentReference)?.descriptor;
    if (!parent) throw expired();
    const owned = current.forkPlaybackContext(parent, entry.epoch, zone);
    let released = false;
    entry.pins++; entry.touched = now();
    const isCurrent = () => !released && service() === current && referenceScope === entry.scope && owned.isCurrent();
    const lease: RoonPlaybackContextLease = {
      initial: { ...initialPage, selectedIndex },
      isCurrent() { try { return isCurrent(); } catch { return false; } },
      release() { if (released) return; released = true; entry.pins--; entry.touched = now(); owned.release(); leases.delete(lease); },
      async read(request, options) {
        if (!isCurrent() || options.signal.aborted || !options.isCurrent()) throw expired();
        const page = await owned.read(request, { signal: options.signal, isCurrent: () => isCurrent() && options.isCurrent() });
        if (!isCurrent() || options.signal.aborted || !options.isCurrent()) throw expired();
        const entityDraft = new ReferenceDraft(references), imageDraft = new ReferenceDraft(imageReferences);
        const mapped = mapPage(page, request, entityDraft, imageDraft, entry.scope, capture(current, entry.scope));
        references.prepare(entityDraft); imageReferences.prepare(imageDraft);
        for (const [key, value] of entityDraft) references.set(key, value);
        for (const [key, value] of imageDraft) imageReferences.set(key, value);
        const next = page.nextOffset ?? page.offset + page.items.length;
        return { offset: page.offset, nextOffset: next, complete: page.complete === true && page.total !== undefined && next >= page.total,
          items: mapped.items.filter(item => item.kind === 'track').map(roonItem => ({ reference: roonItem.reference, zoneId: zone, roonItem, track: summary(roonItem.reference) })),
        };
      },
    };
    leases.add(lease); return lease;
  };

  return {
    acquirePlaybackContext,
    getReadScope() {
      try { service(); } catch (error) { if (!(error instanceof BridgeError) || error.code !== 'ROON_LIBRARY_UNAVAILABLE') throw error; }
      return referenceScope;
    },
    invalidateReferences: invalidateScope,
    registerNowPlayingArtwork(imageKey) {
      service();
      if (typeof imageKey !== 'string' || imageKey.trim().length === 0 || imageKey.length > 512) {
        throw new BridgeError('BAD_REQUEST', 'Roon 当前封面引用无效', { httpStatus: 400 });
      }
      const reference = createToken('image', referenceScope, imageKey);
      addReference(imageReferences, reference, imageKey);
      return reference;
    },
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
          reference,
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
          reference,
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
          reference,
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
      const scope = referenceScope;
      const ensureCurrent = (): void => { assertLibraryReadCurrent(); if (service() !== current || referenceScope !== scope) throw new BridgeError('ROON_LIBRARY_INVALID_REFERENCE', 'Roon 封面读取已过期'); };
      const stored = references.get(reference);
      if (!imageKey) {
        if (stored?.descriptor.kind === 'artist' && current.getArtistImageKey) {
          try {
            imageKey = await current.getArtistImageKey(stored.descriptor);
            ensureCurrent();
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
        const owner = pending && imageReadOwners.get(pending);
        if (owner && (owner.signal.aborted || !owner.isCurrent() || owner.now() >= owner.deadlineAtMs)) pending = undefined;
        if (!pending) {
          pending = (async () => {
            try {
              const result = await current.getImage(imageKey, imageOptions(normalized));
              ensureCurrent();
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
              try { ensureCurrent(); } catch { throw error; }
              negativeImages.set(cacheKey, {
                error,
                expiresAt: now() + negativeImageTtlMs,
              });
              throw error;
            } finally {
              if (pendingImages.get(cacheKey) === pending) pendingImages.delete(cacheKey);
            }
          })();
          const read = currentLibraryRead();
          if (read) imageReadOwners.set(pending, read);
          pendingImages.set(cacheKey, pending);
        }
        const result = await pending;
        ensureCurrent();
        return cloneImage(result);
      } catch (error) {
        return wrapLibraryError(error, 'image');
      }
    },
    async playTrack(reference, zoneOrOutputId, onDispatch) {
      try {
        const current = service();
        const stored = resolveTrackReference(reference);
        return await (stored.actions ? stored.actions.play(zoneOrOutputId, onDispatch) : current.playTrack(stored.descriptor, zoneOrOutputId, onDispatch));
      } catch (error) {
        return wrapLibraryError(error, 'track-action');
      }
    },
    async queueTrack(reference, zoneOrOutputId) {
      try {
        const current = service();
        const stored = resolveTrackReference(reference);
        return await (stored.actions ? stored.actions.queue(zoneOrOutputId) : current.queueTrack(stored.descriptor, zoneOrOutputId));
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
