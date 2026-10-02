import { assertLibraryReadCurrent, currentLibraryRead, libraryReadCancelled, libraryReadTimeout, remainingLibraryReadMs, withLibraryRead } from '../shared/library-read-lifetime.js';
import { currentPerformanceContext, readPerformanceTime } from '../diagnostics/performance-trace.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import {
  isValidRoonImageBinary,
  summarizeRoonImageBinary,
  type RoonImageShapeSummary,
} from '@music-bridge/contracts';
import { authorizeRoonAction } from './action-policy.js';

export interface RoonBrowseApi {
  browse(
    options: Record<string, unknown>,
    callback: (error: string | false, body: unknown) => void,
  ): void;
  load(
    options: Record<string, unknown>,
    callback: (error: string | false, body: unknown) => void,
  ): void;
}

export type RoonImageScale = 'fit' | 'fill' | 'stretch';
export type RoonImageFormat = 'image/jpeg' | 'image/png';

export interface RoonImageOptions {
  scale?: RoonImageScale;
  width?: number;
  height?: number;
  format?: RoonImageFormat;
}

export interface RoonImageApi {
  get_image(
    imageKey: string,
    options: Record<string, unknown>,
    callback: (
      error: string | false,
      contentType?: string,
      imageBody?: Buffer,
    ) => void,
  ): void;
}

export type RoonLibraryKind =
  | 'album'
  | 'artist'
  | 'genre'
  | 'playlist'
  | 'composer'
  | 'track';

export type RoonBrowseHierarchy = 'albums' | 'artists' | 'genres' | 'playlists' | 'search';
export type RoonSearchResultKind = 'track' | 'album' | 'artist';

export interface RoonBrowseContext {
  hierarchy: RoonBrowseHierarchy;
  multiSessionKey: string;
  level: number;
  itemKey?: string;
  sourceIndex?: number;
  kind: RoonLibraryKind;
  parentReference?: string;
  pathSignature: string;
}

export interface RoonEntityDescriptor {
  kind: RoonLibraryKind;
  /** Core 内部 Browse 上下文；不会进入公开 contracts。 */
  hierarchy?: RoonBrowseHierarchy;
  title: string;
  subtitle?: string;
  itemKey?: string;
  imageKey?: string;
  hint?: string;
  artist?: string;
  album?: string;
  albumCount?: number;
  durationMs?: number;
  durationSeconds?: number;
  bitrate?: number;
  format?: string;
  trackNumber?: number;
  discNumber?: number;
  year?: number;
  version?: string;
  browseContext?: RoonBrowseContext;
}

export interface RoonLibraryPage<T extends RoonEntityDescriptor> {
  items: readonly T[];
  offset: number;
  level: number;
  total?: number;
  hasMore?: boolean;
  sourceEpoch?: string;
  complete?: boolean;
  nextOffset?: number;
}

export interface RoonImageResult {
  contentType: string;
  body: Buffer;
}

export interface RoonCapturedTrackActions {
  retainedBytes: number;
  play(zoneOrOutputId: string, onDispatch?: () => void): Promise<RoonTrackActionOutcome>;
  queue(zoneOrOutputId: string): Promise<RoonTrackActionOutcome>;
}
/** 私有源：不消费调用方游标，也不继承UI读取信号。 */
export interface RoonOwnedPlaybackSource {
  isCurrent(): boolean;
  read(page: RoonPageRequest, options: { signal: AbortSignal; isCurrent(): boolean }): Promise<RoonLibraryPage<RoonEntityDescriptor>>;
  release(): void;
}
export interface RoonBrowseReadOptions { refresh?: true }
export type RoonReadCacheSelector =
  | { kind: 'root'; hierarchy: Exclude<RoonBrowseHierarchy, 'search'> }
  | { kind: 'detail'; entity: RoonEntityDescriptor }
  | { kind: 'search'; query: string; resultKind?: RoonSearchResultKind };
export interface RoonLibraryService {
  getReadCacheStamp?(selector: RoonReadCacheSelector): string | undefined;
  captureTrackActions?(track: RoonEntityDescriptor): RoonCapturedTrackActions;
  forkPlaybackContext?(parent: RoonEntityDescriptor, sourceEpoch: string, zoneId: string): RoonOwnedPlaybackSource;
  invalidateReadContexts?(): void;
  browseAlbums(request: RoonPageRequest, options?: RoonBrowseReadOptions): Promise<RoonLibraryPage<RoonEntityDescriptor>>;
  browseArtists(request: RoonPageRequest, options?: RoonBrowseReadOptions): Promise<RoonLibraryPage<RoonEntityDescriptor>>;
  browseGenres(request: RoonPageRequest, options?: RoonBrowseReadOptions): Promise<RoonLibraryPage<RoonEntityDescriptor>>;
  browsePlaylists(request: RoonPageRequest, options?: RoonBrowseReadOptions): Promise<RoonLibraryPage<RoonEntityDescriptor>>;
  browseAlbum(
    album: RoonEntityDescriptor,
    request: RoonPageRequest,
    options?: RoonBrowseReadOptions,
  ): Promise<RoonLibraryPage<RoonEntityDescriptor>>;
  browseArtist(
    artist: RoonEntityDescriptor,
    request: RoonPageRequest,
    options?: RoonBrowseReadOptions,
  ): Promise<RoonLibraryPage<RoonEntityDescriptor>>;
  browseGenre(
    genre: RoonEntityDescriptor,
    request: RoonPageRequest,
    options?: RoonBrowseReadOptions,
  ): Promise<RoonLibraryPage<RoonEntityDescriptor>>;
  browsePlaylist(
    playlist: RoonEntityDescriptor,
    request: RoonPageRequest,
    options?: RoonBrowseReadOptions,
  ): Promise<RoonLibraryPage<RoonEntityDescriptor>>;
  searchLibrary(
    query: string,
    request: RoonPageRequest,
    kind?: RoonSearchResultKind,
    options?: RoonBrowseReadOptions,
  ): Promise<RoonLibraryPage<RoonEntityDescriptor>>;
  getImage(imageKey: string, options?: RoonImageOptions): Promise<RoonImageResult>;
  getArtistImageKey?(artist: RoonEntityDescriptor): Promise<string | undefined>;
  playTrack(track: RoonEntityDescriptor, zoneOrOutputId: string, onDispatch?: () => void): Promise<RoonTrackActionOutcome | void>;
  queueTrack(track: RoonEntityDescriptor, zoneOrOutputId: string): Promise<RoonTrackActionOutcome | void>;
}

export type RoonTrackActionOutcome = 'accepted' | 'confirmation-required';

export interface RoonPageRequest {
  offset: number;
  limit: number;
}

export class RoonLibraryError extends Error {
  constructor(
    readonly code:
      | 'ROON_LIBRARY_INVALID_PAGE'
      | 'ROON_LIBRARY_REQUEST_FAILED'
      | 'ROON_LIBRARY_RESPONSE_INVALID'
      | 'ROON_IMAGE_REQUEST_FAILED'
      | 'ROON_IMAGE_UNAVAILABLE'
      | 'ROON_IMAGE_DECODE_FAILED'
      | 'ROON_TRACK_ACTION_UNAVAILABLE',
    message: string,
  ) {
    super(message);
    this.name = 'RoonLibraryError';
  }
}

interface BrowseList {
  level: number;
  count?: number;
  imageKey?: string;
}

interface BrowseItemRecord {
  [key: string]: unknown;
}

interface BrowseResponse {
  list: BrowseList;
  action?: string;
}

interface LoadResponse {
  offset?: unknown;
  items: readonly unknown[];
}

interface BrowsePathSegment {
  hierarchy: RoonBrowseHierarchy;
  kind: RoonLibraryKind | 'container';
  title: string;
  subtitle?: string;
  artist?: string;
  album?: string;
  trackNumber?: number;
  discNumber?: number;
  durationSeconds?: number;
  durationMs?: number;
  version?: string;
  itemKey: string;
  hint?: string;
  sourceIndex: number;
  pathSignature: string;
}

// 私有原始页检查点；公开 offset 仍表示详情的有效条目位置。
type DetailMode = 'album' | 'artist' | 'genre' | 'playlist';
interface DetailFrame {
  path: readonly BrowsePathSegment[];
  role: 'album' | 'artist-root' | 'mixed-root' | 'album-items' | 'track-items';
  offset: number;
  total?: number;
  level?: number;
  buffer: readonly unknown[];
  bufferOffset: number;
  bufferBytes: number;
  index: number;
  eof: boolean;
  disc?: number;
  depth: number;
  validateBuffer?: boolean;
}
interface DetailState {
  frames: DetailFrame[];
  groups: DetailFrame[];
  items: RoonEntityDescriptor[];
  candidates: RoonEntityDescriptor[];
  itemBytes: number;
  candidateBytes: number;
  grouped: boolean;
  complete: boolean;
  containers: number;
  level: number;
}
interface DetailContext {
  owned?: boolean;
  abort?: AbortController;
  pathValues?: Map<string, readonly BrowsePathSegment[]>;
  key: string;
  epoch: string;
  session: BrowseSessionState;
  sessionKey: string;
  generation: number;
  zone: string | undefined;
  state: DetailState;
  tail: Promise<void>;
  pending: number;
  paths: Set<string>;
  rootPath: readonly BrowsePathSegment[];
  pathBytes: number;
  rootPathBytes: number;
  rootRawCount?: number;
}
const MAX_DETAIL_CONTEXTS = 32;
const MAX_DETAIL_DESCRIPTORS = 8_192;
const MAX_RETAINED_DESCRIPTORS = 32_768;
const MAX_REGISTERED_PATHS = 65_536;
const MAX_DETAIL_REQUEST_WORK = 16_384;
const MAX_BROWSE_RECORD_BYTES = 128 * 1024;
const MAX_DETAIL_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_RETAINED_CACHE_BYTES = 128 * 1024 * 1024;
const MAX_PATH_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_ARTIST_IMAGE_KEY_BYTES = 32 * 1024;
const MAX_ARTIST_IMAGE_CACHE_BYTES = 4 * 1024 * 1024;

// 保守计量 UTF-16 字符串与容器/节点开销；不串行化全缓存，也不截断身份。
function browseValueBytes(value: unknown, maximum: number): number {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new Set<object>(); let bytes = 0; let nodes = 0;
  while (pending.length) {
    const entry = pending.pop()!;
    if (++nodes > 4096 || entry.depth > 16) throw new RoonLibraryError('ROON_LIBRARY_RESPONSE_INVALID', 'Browse 记录结构预算超限');
    bytes += 64;
    if (typeof entry.value === 'string') bytes += 2 * Buffer.byteLength(entry.value, 'utf8');
    else if (entry.value && typeof entry.value === 'object') {
      if (seen.has(entry.value)) throw new RoonLibraryError('ROON_LIBRARY_RESPONSE_INVALID', 'Browse 记录包含循环引用');
      seen.add(entry.value);
      // 逐字段访问，巨大未知对象不会先复制 Object.entries 到另一个大数组。
      for (const key in entry.value) {
        if (!Object.hasOwn(entry.value, key)) continue;
        bytes += 64 + 2 * Buffer.byteLength(key, 'utf8');
        if (bytes > maximum || pending.length >= 4096) throw new RoonLibraryError('ROON_LIBRARY_RESPONSE_INVALID', 'Browse 记录字节预算超限');
        pending.push({ value: (entry.value as Record<string, unknown>)[key], depth: entry.depth + 1 });
      }
    }
    if (bytes > maximum) throw new RoonLibraryError('ROON_LIBRARY_RESPONSE_INVALID', 'Browse 记录字节预算超限');
  }
  return bytes;
}


interface BrowseSessionState {
  cacheEpoch: string;
  hierarchy: RoonBrowseHierarchy;
  multiSessionKey: string;
  input?: string;
  initialized: boolean;
  requiresPathValidation?: boolean;
  rootLevel?: number;
  currentLevel?: number;
  currentCount?: number;
  currentImageKey?: string;
  currentPath: BrowsePathSegment[];
  tail: Promise<void>;
  pendingOperations: number;
  owned?: boolean;
}

export interface RoonBrowseShapeSummary {
  operation: 'browse' | 'load';
  hierarchy: RoonBrowseHierarchy | 'unknown';
  bodyType: string;
  errorCategory?: 'invalid-item-key' | 'invalid-request' | 'network' | 'other';
  requestItemKeyPresent?: boolean;
  requestPopLevels?: number;
  bodyKeys?: string[];
  action?: 'list' | 'message' | 'none' | 'replace_item' | 'remove_item' | 'unknown';
  level?: number;
  count?: number;
  listHint?: 'generic' | 'actionList' | 'unknown';
  listKeys?: string[];
  replacementItemKeyPresent?: boolean;
  replacementInputPromptPresent?: boolean;
  replacementHint?: 'generic' | 'list' | 'actionList' | 'action' | 'header' | 'unknown';
  replacementKeys?: string[];
  offset?: number;
  itemCount?: number;
  itemKeys?: string[];
  itemKeyCount?: number;
  imageKeyCount?: number;
  subtitleCount?: number;
  inputPromptCount?: number;
  hintCounts?: {
    generic: number;
    list: number;
    actionList: number;
    action: number;
    header: number;
    unknown: number;
  };
}

const MAX_PAGE_LIMIT = 100;
const MAX_SEARCH_SCAN_ITEMS = 1_000;
const MAX_ALBUM_SCAN_ITEMS = 1_000;
const MAX_ARTIST_SCAN_ITEMS = 1_000;
const MAX_ALBUM_CONTAINER_COUNT = 64;
const MAX_ALBUM_BROWSE_DEPTH = 4;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_IMAGE_OPTIONS: Required<RoonImageOptions> = {
  scale: 'fit',
  width: 256,
  height: 256,
  format: 'image/jpeg',
};

function asRecord(value: unknown): BrowseItemRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as BrowseItemRecord
    : undefined;
}

function readSafeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? value as number
    : undefined;
}

function readString(record: BrowseItemRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(record: BrowseItemRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function valueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function safeShapeKeys(value: BrowseItemRecord | undefined): string[] {
  if (!value) return [];
  return Object.keys(value)
    .filter((key) => /^[A-Za-z][A-Za-z0-9_]{0,31}$/u.test(key))
    .sort()
    .slice(0, 16);
}

function readHierarchy(value: unknown): RoonBrowseHierarchy | 'unknown' {
  switch (value) {
    case 'albums':
    case 'artists':
    case 'genres':
    case 'playlists':
    case 'search':
      return value;
    default:
      return 'unknown';
  }
}

function readAction(value: unknown): RoonBrowseShapeSummary['action'] {
  switch (value) {
    case 'list':
    case 'message':
    case 'none':
    case 'replace_item':
    case 'remove_item':
      return value;
    default:
      return value === undefined ? undefined : 'unknown';
  }
}

function readListHint(value: unknown): NonNullable<RoonBrowseShapeSummary['listHint']> {
  if (value === undefined || value === null) return 'generic';
  if (value === 'action_list') return 'actionList';
  return 'unknown';
}

function readItemHint(value: unknown): NonNullable<RoonBrowseShapeSummary['replacementHint']> {
  switch (value) {
    case undefined:
    case null:
      return 'generic';
    case 'list':
      return 'list';
    case 'action_list':
      return 'actionList';
    case 'action':
      return 'action';
    case 'header':
      return 'header';
    default:
      return 'unknown';
  }
}

export function summarizeRoonBrowsePayload(
  operation: 'browse' | 'load',
  options: Record<string, unknown>,
  value: unknown,
): RoonBrowseShapeSummary {
  const body = asRecord(value);
  const base: RoonBrowseShapeSummary = {
    operation,
    hierarchy: readHierarchy(options.hierarchy),
    bodyType: valueType(value),
    ...(body ? { bodyKeys: safeShapeKeys(body) } : {}),
  };
  if (operation === 'browse') {
    const list = asRecord(body?.list);
    const replacement = asRecord(body?.item);
    const action = readAction(body?.action);
    const level = readSafeInteger(list?.level);
    const count = readSafeInteger(list?.count);
    return {
      ...base,
      ...(action !== undefined ? { action } : {}),
      ...(level !== undefined ? { level } : {}),
      ...(count !== undefined ? { count } : {}),
      ...(list ? { listHint: readListHint(list.hint) } : {}),
      ...(list ? { listKeys: safeShapeKeys(list) } : {}),
      ...(replacement ? {
        replacementKeys: safeShapeKeys(replacement),
        replacementItemKeyPresent:
          typeof replacement.item_key === 'string' && replacement.item_key.length > 0,
        replacementInputPromptPresent: asRecord(replacement.input_prompt) !== undefined,
        replacementHint: readItemHint(replacement.hint),
      } : {}),
    };
  }

  const items = Array.isArray(body?.items) ? body.items : undefined;
  const offset = readSafeInteger(body?.offset);
  if (!items) return { ...base, ...(offset !== undefined ? { offset } : {}) };
  const hintCounts = {
    generic: 0,
    list: 0,
    actionList: 0,
    action: 0,
    header: 0,
    unknown: 0,
  };
  let itemKeyCount = 0;
  let imageKeyCount = 0;
  let subtitleCount = 0;
  let inputPromptCount = 0;
  const itemKeyNames = new Set<string>();
  for (const item of items) {
    const record = asRecord(item);
    if (!record) {
      hintCounts.unknown += 1;
      continue;
    }
    for (const key of safeShapeKeys(record)) itemKeyNames.add(key);
    if (typeof record.item_key === 'string' && record.item_key.length > 0) itemKeyCount += 1;
    if (typeof record.image_key === 'string' && record.image_key.length > 0) imageKeyCount += 1;
    if (typeof record.subtitle === 'string' && record.subtitle.length > 0) subtitleCount += 1;
    if (asRecord(record.input_prompt)) inputPromptCount += 1;
    switch (record.hint) {
      case undefined:
      case null:
        hintCounts.generic += 1;
        break;
      case 'list':
        hintCounts.list += 1;
        break;
      case 'action_list':
        hintCounts.actionList += 1;
        break;
      case 'action':
        hintCounts.action += 1;
        break;
      case 'header':
        hintCounts.header += 1;
        break;
      default:
        hintCounts.unknown += 1;
    }
  }
  return {
    ...base,
    ...(offset !== undefined ? { offset } : {}),
    itemCount: items.length,
    itemKeys: [...itemKeyNames].sort().slice(0, 16),
    itemKeyCount,
    imageKeyCount,
    subtitleCount,
    inputPromptCount,
    hintCounts,
  };
}

function normalizePage(request: RoonPageRequest): RoonPageRequest {
  if (
    !Number.isSafeInteger(request.offset)
    || request.offset < 0
    || !Number.isSafeInteger(request.limit)
    || request.limit < 1
    || request.limit > MAX_PAGE_LIMIT
  ) {
    throw new RoonLibraryError('ROON_LIBRARY_INVALID_PAGE', 'Roon page request is invalid');
  }
  return request;
}

function readBrowseResponse(value: unknown): BrowseResponse {
  const body = asRecord(value);
  const list = asRecord(body?.list);
  if (list) browseValueBytes(list, MAX_BROWSE_RECORD_BYTES);
  const level = readSafeInteger(list?.level);
  if (level === undefined) {
    throw new RoonLibraryError(
      'ROON_LIBRARY_RESPONSE_INVALID',
      'Roon Browse response has no valid level',
    );
  }
  const count = readSafeInteger(list?.count);
  const imageKey = readString(list ?? {}, 'image_key');
  const action = readString(body ?? {}, 'action');
  return {
    list: {
      level,
      ...(count !== undefined ? { count } : {}),
      ...(imageKey !== undefined ? { imageKey } : {}),
    },
    ...(action !== undefined ? { action } : {}),
  };
}

function readLoadResponse(value: unknown): LoadResponse {
  const body = asRecord(value);
  if (!Array.isArray(body?.items)) {
    throw new RoonLibraryError(
      'ROON_LIBRARY_RESPONSE_INVALID',
      'Roon Browse load response has no items list',
    );
  }
  return { offset: body.offset, items: body.items };
}

function entityPathSignature(
  source: BrowseItemRecord,
  kind: RoonLibraryKind | 'container',
  parentReference: string,
  sourceIndex: number,
  inheritedDiscNumber?: number,
): string {
  const discNumber = readNumber(source, 'disc_number') ?? inheritedDiscNumber;
  return createHash('sha256')
    .update([
      parentReference,
      kind,
      readString(source, 'title') ?? '',
      readString(source, 'subtitle') ?? '',
      readString(source, 'artist') ?? '',
      readString(source, 'album') ?? '',
      String(readNumber(source, 'track_number') ?? ''),
      String(discNumber ?? ''),
      String(readNumber(source, 'duration_ms') ?? ''),
      String(readNumber(source, 'duration') ?? ''),
      readString(source, 'version') ?? '',
      String(sourceIndex),
    ].join('\0'))
    .digest('hex');
}

function readPathSegment(
  value: unknown,
  hierarchy: RoonBrowseHierarchy,
  kind: RoonLibraryKind | 'container',
  parentReference: string,
  sourceIndex: number,
  inheritedDiscNumber?: number,
): BrowsePathSegment | undefined {
  const source = asRecord(value);
  if (!source) return undefined;
  const title = readString(source, 'title');
  const itemKey = readString(source, 'item_key');
  if (!title || !itemKey) return undefined;
  const subtitle = readString(source, 'subtitle');
  const artist = readString(source, 'artist');
  const album = readString(source, 'album');
  const albumCount = readSafeInteger(source['album_count']);
  const trackNumber = readNumber(source, 'track_number');
  const discNumber = readNumber(source, 'disc_number') ?? inheritedDiscNumber;
  const durationSeconds = readNumber(source, 'duration');
  const durationMs = readNumber(source, 'duration_ms');
  const version = readString(source, 'version');
  const hint = readString(source, 'hint');
  return {
    hierarchy,
    kind,
    title,
    itemKey,
    sourceIndex,
    pathSignature: entityPathSignature(
      source,
      kind,
      parentReference,
      sourceIndex,
      inheritedDiscNumber,
    ),
    ...(subtitle !== undefined ? { subtitle } : {}),
    ...(artist !== undefined ? { artist } : {}),
    ...(album !== undefined ? { album } : {}),
    ...(kind === 'artist' && albumCount !== undefined && albumCount <= 1_000_000 ? { albumCount } : {}),
    ...(trackNumber !== undefined ? { trackNumber } : {}),
    ...(discNumber !== undefined ? { discNumber } : {}),
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(hint !== undefined ? { hint } : {}),
  };
}

function readItem(
  value: unknown,
  kind: RoonLibraryKind,
  hierarchy: RoonBrowseHierarchy,
  context: {
    multiSessionKey: string;
    level: number;
    parentReference: string;
    parentPath: readonly BrowsePathSegment[];
    sourceIndex: number;
    inheritedDiscNumber?: number;
    registerPath: (pathSignature: string, path: readonly BrowsePathSegment[]) => void;
  },
): RoonEntityDescriptor | undefined {
  const record = asRecord(value);
  const source = record ?? {};
  const rawTitle = readString(source, 'title');
  if (!rawTitle) return undefined;

  const subtitle = readString(source, 'subtitle');
  const itemKey = readString(source, 'item_key');
  const imageKey = readString(source, 'image_key');
  const hint = readString(source, 'hint');
  const artist = readString(source, 'artist');
  const album = readString(source, 'album');
  const durationMs = readNumber(source, 'duration_ms');
  const durationSeconds = readNumber(source, 'duration');
  const rawBitrate = readNumber(source, 'bitrate') ?? readNumber(source, 'bit_rate');
  const bitrate = rawBitrate !== undefined
    && Number.isSafeInteger(rawBitrate)
    && rawBitrate > 0
    && rawBitrate <= 10_000_000
    ? rawBitrate
    : undefined;
  const rawFormat = readString(source, 'format')?.trim();
  const format = rawFormat && rawFormat.length <= 64 ? rawFormat : undefined;
  const explicitTrackNumber = readNumber(source, 'track_number');
  const numberedTitle = kind === 'track'
    ? /^\s*0*(\d{1,3})[.．]\s+(.+?)\s*$/u.exec(rawTitle)
    : null;
  const inferredTrackNumber = Number.parseInt(numberedTitle?.[1] ?? '', 10);
  const canUseNumberedTitle = numberedTitle !== null
    && Number.isSafeInteger(inferredTrackNumber)
    && inferredTrackNumber > 0
    && (explicitTrackNumber === undefined || explicitTrackNumber === inferredTrackNumber);
  const title = canUseNumberedTitle ? numberedTitle[2] ?? rawTitle : rawTitle;
  const trackNumber = explicitTrackNumber ?? (canUseNumberedTitle ? inferredTrackNumber : undefined);
  const discNumber = readNumber(source, 'disc_number') ?? context.inheritedDiscNumber;
  const year = readNumber(source, 'year');
  const version = readString(source, 'version');

  const pathSignature = entityPathSignature(
    source,
    kind,
    context.parentReference,
    context.sourceIndex,
    context.inheritedDiscNumber,
  );
  const item: RoonEntityDescriptor = {
    kind,
    hierarchy,
    title,
    ...(subtitle !== undefined ? { subtitle } : {}),
    ...(itemKey !== undefined ? { itemKey } : {}),
    ...(imageKey !== undefined ? { imageKey } : {}),
    ...(hint !== undefined ? { hint } : {}),
    ...(artist !== undefined ? { artist } : {}),
    ...(album !== undefined ? { album } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    ...(bitrate !== undefined ? { bitrate } : {}),
    ...(format !== undefined ? { format } : {}),
    ...(trackNumber !== undefined ? { trackNumber } : {}),
    ...(discNumber !== undefined ? { discNumber } : {}),
    ...(year !== undefined ? { year } : {}),
    ...(version !== undefined ? { version } : {}),
    browseContext: {
      hierarchy,
      multiSessionKey: context.multiSessionKey,
      level: context.level,
      ...(itemKey !== undefined ? { itemKey } : {}),
      sourceIndex: context.sourceIndex,
      kind,
      parentReference: context.parentReference,
      pathSignature,
    },
  };
  const segment = readPathSegment(
    source,
    hierarchy,
    kind,
    context.parentReference,
    context.sourceIndex,
    context.inheritedDiscNumber,
  );
  if (segment) context.registerPath(pathSignature, [...context.parentPath, segment]);
  return item;
}

function mapItems(
  value: readonly unknown[],
  kind: RoonLibraryKind,
  hierarchy: RoonBrowseHierarchy,
  context: {
    multiSessionKey: string;
    level: number;
    parentReference: string;
    parentPath: readonly BrowsePathSegment[];
    sourceOffset: number;
    inheritedDiscNumber?: number;
    registerPath: (pathSignature: string, path: readonly BrowsePathSegment[]) => void;
  },
): RoonEntityDescriptor[] {
  return value
    .map((item, index) => readItem(item, kind, hierarchy, {
      ...context,
      sourceIndex: context.sourceOffset + index,
    }))
    .filter((item): item is RoonEntityDescriptor => item !== undefined);
}

function validateImageOptions(options: Required<RoonImageOptions>): void {
  for (const dimension of [options.width, options.height]) {
    if (!Number.isSafeInteger(dimension) || dimension < 1 || dimension > 2048) {
      throw new RoonLibraryError('ROON_LIBRARY_INVALID_PAGE', 'Roon image dimensions are invalid');
    }
  }
}

export function createRoonLibraryService(dependencies: {
  browse: RoonBrowseApi;
  image: RoonImageApi;
  requestTimeoutMs?: number;
  onBrowseShape?: (summary: RoonBrowseShapeSummary) => void;
  onImageShape?: (summary: RoonImageShapeSummary) => void;
  zoneOrOutputId?: () => string | undefined;
  incrementalDetails?: boolean;
}): RoonLibraryService {
  const requestTimeoutMs = dependencies.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
    throw new TypeError('Roon library timeout is invalid');
  }
  const newSessionKey = (hierarchy: RoonBrowseHierarchy): string =>
    `musicbridge-v2-${hierarchy}-${randomUUID()}`;
  const incrementalDetails = dependencies.incrementalDetails !== false;
  let contextGeneration = 0;
  let actionGeneration = 0;
  let contextZone = dependencies.zoneOrOutputId?.();
  const detailContexts = new Map<string, DetailContext>();
  const rootEpochs = new Map<string, { epoch: string; sessionKey: string; eofOffset?: number; contiguousThrough: number }>();
  const sessionsByKey = new Map<string, BrowseSessionState>();
  const rootSessions = new Map<RoonBrowseHierarchy, BrowseSessionState>();
  const searchSessions = new Map<string, BrowseSessionState>();
  const pathsBySignature = new Map<string, readonly BrowsePathSegment[]>();
  const pathSizes = new Map<string, number>();
  let retainedPathBytes = 0;
  const albumTracksBySignature = new Map<string, readonly RoonEntityDescriptor[]>();
  const artistAlbumsBySignature = new Map<string, readonly RoonEntityDescriptor[]>();
  const genreItemsBySignature = new Map<string, readonly RoonEntityDescriptor[]>();
  const playlistTracksBySignature = new Map<string, readonly RoonEntityDescriptor[]>();
  const searchTracksByQuery = new Map<string, readonly RoonEntityDescriptor[]>();
  const searchAlbumsByQuery = new Map<string, readonly RoonEntityDescriptor[]>();
  const searchArtistsByQuery = new Map<string, readonly RoonEntityDescriptor[]>();
  const entitySearchProgress = new Map<string, {
    groups: readonly BrowsePathSegment[];
    groupIndex: number;
    sourceOffset: number;
    scanned: number;
    items: readonly RoonEntityDescriptor[];
    done: boolean;
    level: number;
  }>();
  const artistImageKeysBySignature = new Map<string, string | undefined>();
  const artistImageKeySizes = new Map<string, number>();
  let retainedArtistImageKeyBytes = 0;
  const pendingArtistImageKeys = new Map<string, Promise<string | undefined>>();
  const artistReadOwners = new WeakMap<Promise<string | undefined>, NonNullable<ReturnType<typeof currentLibraryRead>>>();
  const artistImageLookupTails = Array.from({ length: 4 }, () => Promise.resolve());
  let nextArtistImageLookupLane = 0;

  const createSession = (
    hierarchy: RoonBrowseHierarchy,
    options: { register?: boolean; input?: string } = {},
  ): BrowseSessionState => {
    if (options.register !== false && sessionsByKey.size >= 256) throw new RoonLibraryError('ROON_LIBRARY_REQUEST_FAILED', 'Browse 会话预算已满');
    const session: BrowseSessionState = {
      hierarchy,
      cacheEpoch: randomUUID(),
      multiSessionKey: newSessionKey(hierarchy),
      ...(options.input !== undefined ? { input: options.input } : {}),
      initialized: false,
      currentPath: [],
      tail: Promise.resolve(),
      pendingOperations: 0,
    };
    if (options.register !== false) sessionsByKey.set(session.multiSessionKey, session);
    return session;
  };
  const rootSession = (hierarchy: RoonBrowseHierarchy): BrowseSessionState => {
    const existing = rootSessions.get(hierarchy);
    if (existing) return existing;
    const created = createSession(hierarchy);
    rootSessions.set(hierarchy, created);
    return created;
  };
  const searchSession = (query: string, kind = 'track'): BrowseSessionState => {
    const key = JSON.stringify([kind, query]);
    const existing = searchSessions.get(key);
    if (existing) { searchSessions.delete(key); searchSessions.set(key, existing); return existing; }
    if (searchSessions.size >= 48) {
      const oldest = [...searchSessions].find(([, session]) => session.pendingOperations === 0);
      if (!oldest) throw new RoonLibraryError('ROON_LIBRARY_REQUEST_FAILED', '搜索会话预算已满');
      const [oldKey, oldSession] = oldest;
      searchSessions.delete(oldKey);
      for (const [alias, value] of sessionsByKey) if (value === oldSession) sessionsByKey.delete(alias);
      const oldQuery = oldSession.input ?? '';
      searchTracksByQuery.delete(oldQuery); searchAlbumsByQuery.delete(oldQuery); searchArtistsByQuery.delete(oldQuery);
      entitySearchProgress.delete(oldKey);
    }
    const created = createSession('search', { input: query });
    searchSessions.set(key, created);
    return created;
  };
  const registerPath = (
    pathSignature: string,
    path: readonly BrowsePathSegment[],
  ): void => {
    assertLibraryReadCurrent();
    if (!pathsBySignature.has(pathSignature) && pathsBySignature.size >= MAX_REGISTERED_PATHS) {
      throw new RoonLibraryError('ROON_LIBRARY_REQUEST_FAILED', 'Browse 路径预算已满，请重新加载资料库');
    }
    const bytes = browseValueBytes(path, MAX_PATH_CACHE_BYTES);
    if (retainedPathBytes - (pathSizes.get(pathSignature) ?? 0) + bytes > MAX_PATH_CACHE_BYTES) {
      throw new RoonLibraryError('ROON_LIBRARY_REQUEST_FAILED', 'Browse 路径字节预算已满');
    }
    retainedPathBytes += bytes - (pathSizes.get(pathSignature) ?? 0);
    pathSizes.set(pathSignature, bytes); pathsBySignature.set(pathSignature, path);
  };
  const withSession = <T>(
    session: BrowseSessionState,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const guarded = () => { assertLibraryReadCurrent(); return operation(); };
    session.pendingOperations++;
    const result = session.tail.then(guarded, guarded).finally(() => { session.pendingOperations--; });
    session.tail = result.then(() => undefined, () => undefined);
    return result;
  };

  const withArtistImageLookupLane = <T>(operation: () => Promise<T>): Promise<T> => {
    const lane = nextArtistImageLookupLane;
    nextArtistImageLookupLane = (nextArtistImageLookupLane + 1) % artistImageLookupTails.length;
    const guarded = () => { assertLibraryReadCurrent(); return operation(); };
    const result = artistImageLookupTails[lane]!.then(guarded, guarded);
    artistImageLookupTails[lane] = result.then(() => undefined, () => undefined);
    return result;
  };

  const removeArtistImageKey = (signature: string): void => {
    artistImageKeysBySignature.delete(signature);
    retainedArtistImageKeyBytes -= artistImageKeySizes.get(signature) ?? 0;
    artistImageKeySizes.delete(signature);
  };
  const cacheArtistImageKey = (signature: string, imageKey: string | undefined): void => {
    assertLibraryReadCurrent();
    const keyBytes = imageKey === undefined ? 0 : Buffer.byteLength(imageKey, 'utf8');
    if (keyBytes > MAX_ARTIST_IMAGE_KEY_BYTES) throw new RoonLibraryError('ROON_LIBRARY_RESPONSE_INVALID', '艺人图片 key 字节预算超限');
    const bytes = 128 + 2 * Buffer.byteLength(signature, 'utf8') + 2 * keyBytes;
    removeArtistImageKey(signature);
    while (artistImageKeysBySignature.size >= 2_048 || retainedArtistImageKeyBytes + bytes > MAX_ARTIST_IMAGE_CACHE_BYTES) {
      const oldest = artistImageKeysBySignature.keys().next().value;
      if (oldest === undefined) throw new RoonLibraryError('ROON_LIBRARY_REQUEST_FAILED', '艺人图片 key 缓存字节预算已满');
      removeArtistImageKey(oldest);
    }
    artistImageKeysBySignature.set(signature, imageKey);
    artistImageKeySizes.set(signature, bytes); retainedArtistImageKeyBytes += bytes;
  };

  const actualBrowseByKey = new Map<string, number>();
  let outstandingReadBrowse = 0;
  let outstandingOtherBrowse = 0;
  let outstandingImages = 0;
  const retireSession = (key: unknown, targeted = false): void => {
    if (typeof key !== 'string') return;
    const session = sessionsByKey.get(key);
    if (!session || session.multiSessionKey !== key) return;
    for (const context of detailContexts.values()) if (context.session === session) forgetContext(context);
    if (session.owned) return;
    rootEpochs.delete(session.hierarchy);
    session.cacheEpoch = randomUUID();
    // 真取消/超时隔离尚未返回的SDK；串行目标刷新可保留SDK会话并重新pop_all。
    if (!targeted) session.multiSessionKey = newSessionKey(session.hierarchy);
    session.initialized = false; session.currentPath = []; session.requiresPathValidation = true;
    delete session.rootLevel; delete session.currentLevel; delete session.currentCount; delete session.currentImageKey;
    sessionsByKey.set(session.multiSessionKey, session);
    const aliases = [...sessionsByKey].filter(([, value]) => value === session);
    for (const [old] of aliases.slice(0, Math.max(0, aliases.length - 4))) sessionsByKey.delete(old);
    if (!targeted) {
      albumTracksBySignature.clear(); artistAlbumsBySignature.clear(); genreItemsBySignature.clear(); playlistTracksBySignature.clear();
      searchTracksByQuery.clear(); searchAlbumsByQuery.clear(); searchArtistsByQuery.clear(); entitySearchProgress.clear();
    } else {
      // 旧实现的空列表没有descriptor可反查session，仍须撤掉本hierarchy的物化结果。
      if (session.hierarchy === 'albums') albumTracksBySignature.clear();
      if (session.hierarchy === 'artists') artistAlbumsBySignature.clear();
      if (session.hierarchy === 'genres') genreItemsBySignature.clear();
      if (session.hierarchy === 'playlists') playlistTracksBySignature.clear();
      for (const cache of [albumTracksBySignature, artistAlbumsBySignature, genreItemsBySignature, playlistTracksBySignature]) {
        for (const [signature, items] of cache) if (items.some(item => sessionsByKey.get(item.browseContext?.multiSessionKey ?? '') === session)) cache.delete(signature);
      }
      if (session.hierarchy === 'search') {
        const query = session.input ?? '';
        searchTracksByQuery.delete(query); searchAlbumsByQuery.delete(query); searchArtistsByQuery.delete(query);
        for (const [searchKey, value] of searchSessions) if (value === session) entitySearchProgress.delete(searchKey);
      }
    }
  };
  const refreshSession = (session: BrowseSessionState): Promise<void> => withSession(session, async () => {
    assertLibraryReadCurrent();
    // 同key尚有真实未返回SDK时必须旋转，绝不能把本地等待结束当物理静止。
    retireSession(session.multiSessionKey, (actualBrowseByKey.get(session.multiSessionKey) ?? 0) === 0);
  });
  const requestBrowse = (
    operation: 'browse' | 'load',
    options: Record<string, unknown>,
  ): Promise<unknown> => new Promise((resolve, reject) => {
    assertLibraryReadCurrent();
    const read = currentLibraryRead();
    if ((read ? outstandingReadBrowse : outstandingOtherBrowse) >= 32) throw new RoonLibraryError('ROON_LIBRARY_REQUEST_FAILED', '未返回 Browse 请求预算已满');
    const zoneOrOutputId = operation === 'browse' ? dependencies.zoneOrOutputId?.() : undefined;
    const requestOptions = {
      ...options,
      ...(typeof zoneOrOutputId === 'string'
        && zoneOrOutputId.length > 0
        && zoneOrOutputId.length <= 128
        && options.zone_or_output_id === undefined
        ? { zone_or_output_id: zoneOrOutputId }
        : {}),
    };
    let settled = false;
    const trace = currentPerformanceContext();
    const span = trace?.recorder.start('provider', trace.context, { providerCallCount: 1, ...(operation === 'load' ? { pageCount: 1 } : {}) });
    const started = trace ? readPerformanceTime() : undefined;
    trace?.recorder.mark('provider', 'provider-dispatch', trace.context);
    const finish = (error?: Error, body?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout); read?.signal.removeEventListener('abort', cancel);
      const completedAt = trace ? readPerformanceTime() : undefined;
      span?.end(error ? 'error' : 'ok', started !== undefined && completedAt !== undefined ? { providerDurationMs: Math.max(0, completedAt - started) } : {});
      if (error) reject(error);
      else { try { assertLibraryReadCurrent(); resolve(body); } catch (expired) { retireSession(options.multi_session_key); reject(expired); } }
    };
    const cancel = (): void => { retireSession(options.multi_session_key); finish(read?.signal.reason instanceof Error && 'code' in read.signal.reason && (read.signal.reason.code === 'READ_CANCELLED' || read.signal.reason.code === 'READ_DEADLINE') ? read.signal.reason : libraryReadCancelled()); };
    const timeout = setTimeout(() => {
      retireSession(options.multi_session_key);
      if (read && read.now() >= read.deadlineAtMs) { finish(libraryReadTimeout()); return; }
      finish(new RoonLibraryError(
        'ROON_LIBRARY_REQUEST_FAILED',
        `Roon ${operation} timed out`,
      ));
    }, remainingLibraryReadMs(requestTimeoutMs));
    read?.signal.addEventListener('abort', cancel, { once: true });
    let returned = false;
    const physicalKey = typeof options.multi_session_key === 'string' ? options.multi_session_key : undefined;
    const release = (): void => { if (!returned) {
      returned = true; if (read) outstandingReadBrowse--; else outstandingOtherBrowse--;
      if (physicalKey) { const remaining = (actualBrowseByKey.get(physicalKey) ?? 1) - 1; if (remaining === 0) actualBrowseByKey.delete(physicalKey); else actualBrowseByKey.set(physicalKey, remaining); }
    } };
    if (physicalKey) actualBrowseByKey.set(physicalKey, (actualBrowseByKey.get(physicalKey) ?? 0) + 1);
    if (read) outstandingReadBrowse++; else outstandingOtherBrowse++;
    try {
      // SDK 共享传输回调不保证请求上下文；读取与诊断都必须跟随自身派发。
      dependencies.browse[operation](requestOptions, AsyncLocalStorage.bind<Parameters<RoonBrowseApi['browse']>[1]>((error, body) => {
        release();
        // 本地超时不冒充 Provider 已返回；迟到回调仍留下真正的返回标记。
        trace?.recorder.mark('provider', 'provider-response', trace.context);
        try {
          dependencies.onBrowseShape?.({
            ...summarizeRoonBrowsePayload(operation, requestOptions, body),
            ...(error ? {
              errorCategory: /item.?key/i.test(String(error)) ? 'invalid-item-key' as const
                : /network/i.test(String(error)) ? 'network' as const
                : /invalid/i.test(String(error)) ? 'invalid-request' as const : 'other' as const,
              requestItemKeyPresent: typeof options.item_key === 'string',
              ...(typeof options.pop_levels === 'number' ? { requestPopLevels: options.pop_levels } : {}),
            } : {}),
          });
        } catch {
          // 诊断回调不得改变 Browse 行为。
        }
        if (error) {
          finish(new RoonLibraryError('ROON_LIBRARY_REQUEST_FAILED', `Roon ${operation} failed`));
          return;
        }
        finish(undefined, body);
      }));
    } catch {
      release();
      finish(new RoonLibraryError('ROON_LIBRARY_REQUEST_FAILED', `Roon ${operation} failed`));
    }
  });

  const rootReference = (hierarchy: RoonBrowseHierarchy, suffix = ''): string =>
    createHash('sha256').update(`root\0${hierarchy}\0${suffix}`).digest('hex');

  const sessionRootReference = (session: BrowseSessionState): string =>
    rootReference(session.hierarchy, session.input ?? '');

  const applyBrowseState = (
    session: BrowseSessionState,
    response: BrowseResponse,
    path: readonly BrowsePathSegment[],
  ): void => {
    if (response.action !== undefined && response.action !== 'list') {
      throw new RoonLibraryError(
        'ROON_LIBRARY_RESPONSE_INVALID',
        'Roon Browse did not return a navigable list',
      );
    }
    assertLibraryReadCurrent();
    session.initialized = true;
    session.currentLevel = response.list.level;
    if (response.list.count === undefined) delete session.currentCount;
    else session.currentCount = response.list.count;
    if (response.list.imageKey === undefined) delete session.currentImageKey;
    else session.currentImageKey = response.list.imageKey;
    session.currentPath = [...path];
  };

  const currentList = (session: BrowseSessionState): BrowseList => {
    if (!session.initialized || session.currentLevel === undefined) {
      throw new RoonLibraryError(
        'ROON_LIBRARY_RESPONSE_INVALID',
        'Roon Browse session is not initialized',
      );
    }
    return {
      level: session.currentLevel,
      ...(session.currentCount !== undefined ? { count: session.currentCount } : {}),
      ...(session.currentImageKey !== undefined ? { imageKey: session.currentImageKey } : {}),
    };
  };

  const ensureRoot = async (session: BrowseSessionState): Promise<BrowseList> => {
    if (!session.initialized) {
      const response = readBrowseResponse(await requestBrowse('browse', {
        hierarchy: session.hierarchy,
        multi_session_key: session.multiSessionKey,
        pop_all: true,
        ...(session.input !== undefined ? { input: session.input } : {}),
      }));
      applyBrowseState(session, response, []);
      session.rootLevel = response.list.level;
      return response.list;
    }
    if (session.currentPath.length > 0) {
      const response = readBrowseResponse(await requestBrowse('browse', {
        hierarchy: session.hierarchy,
        multi_session_key: session.multiSessionKey,
        pop_levels: session.currentPath.length,
      }));
      applyBrowseState(session, response, []);
    }
    return currentList(session);
  };

  const entitySessionAndPath = (
    entity: RoonEntityDescriptor,
    expectedKind: RoonLibraryKind,
  ): { session: BrowseSessionState; path: readonly BrowsePathSegment[] } => {
    const context = entity.browseContext;
    if (!context || context.kind !== expectedKind) {
      throw new RoonLibraryError(
        'ROON_LIBRARY_RESPONSE_INVALID',
        `Roon ${expectedKind} Browse context is unavailable`,
      );
    }
    const session = sessionsByKey.get(context.multiSessionKey);
    const ownedContext = [...detailContexts.values()].find(value => value.owned && value.session === session);
    const path = ownedContext?.pathValues?.get(context.pathSignature) ?? pathsBySignature.get(context.pathSignature);
    if (
      !session
      || session.hierarchy !== context.hierarchy
      || !path
      || path.at(-1)?.pathSignature !== context.pathSignature
    ) {
      throw new RoonLibraryError(
        'ROON_LIBRARY_RESPONSE_INVALID',
        `Roon ${expectedKind} Browse context is stale`,
      );
    }
    return { session, path };
  };

  const navigateToPath = async (
    session: BrowseSessionState,
    targetPath: readonly BrowsePathSegment[],
  ): Promise<BrowseList> => {
    if (!session.initialized) await ensureRoot(session);
    let commonLength = 0;
    while (
      commonLength < session.currentPath.length
      && commonLength < targetPath.length
      && session.currentPath[commonLength]?.pathSignature
        === targetPath[commonLength]?.pathSignature
    ) {
      commonLength += 1;
    }
    const popLevels = session.currentPath.length - commonLength;
    if (popLevels > 0) {
      const response = readBrowseResponse(await requestBrowse('browse', {
        hierarchy: session.hierarchy,
        multi_session_key: session.multiSessionKey,
        pop_levels: popLevels,
      }));
      applyBrowseState(session, response, session.currentPath.slice(0, commonLength));
    }
    for (let index = commonLength; index < targetPath.length; index += 1) {
      const segment = targetPath[index];
      if (!segment) continue;
      // 搜索分组重新进入后其子项 key 会更换；每层验证身份并读取当前 key。
      const currentSegment = session.owned === true || session.hierarchy === 'search' || session.requiresPathValidation === true
        ? (await resolveCurrentItemKey(session, segment, session.currentPath)).segment
        : segment;
      const nextPath = [...session.currentPath, currentSegment];
      const response = readBrowseResponse(await requestBrowse('browse', {
        hierarchy: session.hierarchy,
        multi_session_key: session.multiSessionKey,
        item_key: currentSegment.itemKey,
      }));
      applyBrowseState(session, response, nextPath);
    }
    session.requiresPathValidation = false;
    return currentList(session);
  };

  const loadAllAtLevel = async (
    hierarchy: RoonBrowseHierarchy,
    multiSessionKey: string,
    level: number,
    total: number | undefined,
    maximum: number,
  ): Promise<readonly unknown[]> => {
    if (total !== undefined && total > maximum) {
      throw new RoonLibraryError(
        'ROON_LIBRARY_RESPONSE_INVALID',
        'Roon Browse list exceeds the bounded scan limit',
      );
    }
    const items: unknown[] = [];
    while (items.length < maximum && (total === undefined || items.length < total)) {
      const count = Math.min(MAX_PAGE_LIMIT, maximum - items.length, total === undefined
        ? MAX_PAGE_LIMIT
        : total - items.length);
      if (count < 1) break;
      const loaded = readLoadResponse(await requestBrowse('load', {
        hierarchy,
        multi_session_key: multiSessionKey,
        level,
        offset: items.length,
        count,
      }));
      items.push(...loaded.items);
      if (loaded.items.length < count) break;
    }
    if (total === undefined && items.length === maximum) {
      const overflow = readLoadResponse(await requestBrowse('load', {
        hierarchy,
        multi_session_key: multiSessionKey,
        level,
        offset: maximum,
        count: 1,
      }));
      if (overflow.items.length > 0) {
        throw new RoonLibraryError(
          'ROON_LIBRARY_RESPONSE_INVALID',
          'Roon Browse list exceeds the bounded scan limit',
        );
      }
    }
    return items;
  };

  const pageFor = async (
    hierarchy: Exclude<RoonBrowseHierarchy, 'search'>,
    kind: Exclude<RoonLibraryKind, 'track'>,
    request: RoonPageRequest,
    options?: RoonBrowseReadOptions,
  ): Promise<RoonLibraryPage<RoonEntityDescriptor>> => {
    const pageRequest = normalizePage(request);
    checkContextZone();
    const session = rootSession(hierarchy);
    if (options?.refresh) await refreshSession(session);
    return withSession(session, async () => {
      const generation = contextGeneration;
      const zone = contextZone;
      let epoch = rootEpochs.get(hierarchy);
      if (!epoch || epoch.sessionKey !== session.multiSessionKey) {
        epoch = { epoch: randomUUID(), sessionKey: session.multiSessionKey, contiguousThrough: 0 };
        rootEpochs.set(hierarchy, epoch);
      }
      const list = await ensureRoot(session);
      assertLibraryReadCurrent();
      if (generation !== contextGeneration || zone !== dependencies.zoneOrOutputId?.() || epoch.sessionKey !== session.multiSessionKey) throw libraryReadCancelled();
      const loaded = readLoadResponse(await requestBrowse('load', {
        hierarchy,
        multi_session_key: session.multiSessionKey,
        level: list.level,
        offset: pageRequest.offset,
        count: pageRequest.limit,
      }));
      validateRawPage(loaded, pageRequest.offset, pageRequest.limit, list.count);
      assertLibraryReadCurrent();
      if (generation !== contextGeneration || zone !== dependencies.zoneOrOutputId?.() || epoch.sessionKey !== session.multiSessionKey) {
        throw libraryReadCancelled();
      }
      const offset = pageRequest.offset;
      const nextOffset = offset + loaded.items.length;
      const stagedPaths = new Map<string, readonly BrowsePathSegment[]>();
      const items = mapItems(loaded.items, kind, hierarchy, {
        multiSessionKey: session.multiSessionKey,
        level: list.level,
        parentReference: rootReference(hierarchy),
        parentPath: [],
        sourceOffset: offset,
        registerPath: (signature, value) => { stagedPaths.set(signature, value); },
      }).filter((item) => item.itemKey !== undefined && item.hint === 'list');
      const stagedSizes = new Map([...stagedPaths].map(([signature, value]) => [signature, browseValueBytes(value, MAX_PATH_CACHE_BYTES)]));
      const additions = [...stagedPaths.keys()].filter(signature => !pathsBySignature.has(signature)).length;
      const delta = [...stagedSizes].reduce((sum, [signature, bytes]) => sum + bytes - (pathSizes.get(signature) ?? 0), 0);
      if (pathsBySignature.size + additions > MAX_REGISTERED_PATHS || retainedPathBytes + delta > MAX_PATH_CACHE_BYTES) {
        throw new RoonLibraryError('ROON_LIBRARY_REQUEST_FAILED', 'Browse 根页路径预算已满');
      }
      for (const [signature, value] of stagedPaths) { pathsBySignature.set(signature, value); pathSizes.set(signature, stagedSizes.get(signature)!); }
      retainedPathBytes += delta;
      if (offset <= epoch.contiguousThrough) epoch.contiguousThrough = Math.max(epoch.contiguousThrough, nextOffset);
      if (list.count !== undefined && nextOffset >= list.count) epoch.eofOffset = list.count;
      else if (list.count === undefined && loaded.items.length === 0) epoch.eofOffset = Math.min(epoch.eofOffset ?? offset, offset);

      return {
        items,
        offset,
        level: list.level,
        sourceEpoch: epoch.epoch,
        complete: epoch.eofOffset !== undefined,
        nextOffset,
        ...(list.count !== undefined ? { total: list.count } : epoch.eofOffset !== undefined && epoch.contiguousThrough === epoch.eofOffset ? { total: epoch.eofOffset } : {}),
        hasMore: list.count !== undefined ? nextOffset < list.count : epoch.eofOffset !== undefined ? nextOffset < epoch.eofOffset : loaded.items.length > 0,
      };
    });
  };

  const inferDiscNumber = (title: string): number | undefined => {
    const latin = /\b(?:disc|disk|cd)\s*0*(\d{1,2})\b/iu.exec(title);
    const localized = /第\s*0*(\d{1,2})\s*[碟盘張张]/u.exec(title);
    const value = Number.parseInt(latin?.[1] ?? localized?.[1] ?? '', 10);
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  };

  const collectAlbumTracks = async (
    session: BrowseSessionState,
    albumPath: readonly BrowsePathSegment[],
    inheritedImageKey: string | undefined,
  ): Promise<readonly RoonEntityDescriptor[]> => {
    const tracks: RoonEntityDescriptor[] = [];
    const inheritedAlbum = albumPath.at(-1)?.title;
    let scannedItems = 0;
    let containerCount = 0;

    const collectCurrentLevel = async (
      parentPath: readonly BrowsePathSegment[],
      inheritedDiscNumber: number | undefined,
      depth: number,
    ): Promise<void> => {
      if (depth > MAX_ALBUM_BROWSE_DEPTH) {
        throw new RoonLibraryError(
          'ROON_LIBRARY_RESPONSE_INVALID',
          'Roon album Browse depth exceeds the bounded limit',
        );
      }
      const list = currentList(session);
      const remaining = MAX_ALBUM_SCAN_ITEMS - scannedItems;
      if (remaining < 1) {
        throw new RoonLibraryError(
          'ROON_LIBRARY_RESPONSE_INVALID',
          'Roon album Browse exceeds the bounded scan limit',
        );
      }
      const values = await loadAllAtLevel(
        session.hierarchy,
        session.multiSessionKey,
        list.level,
        list.count,
        remaining,
      );
      scannedItems += values.length;
      const parentReference = parentPath.at(-1)?.pathSignature
        ?? rootReference(session.hierarchy);
      let sectionDiscNumber = inheritedDiscNumber;

      for (let index = 0; index < values.length; index += 1) {
        const value = values[index];
        const record = asRecord(value);
        if (!record) continue;
        const hint = readString(record, 'hint');
        const title = readString(record, 'title');
        if (hint === 'header') {
          if (title) sectionDiscNumber = inferDiscNumber(title) ?? sectionDiscNumber;
          continue;
        }
        // 真实专辑层会把 Play Album 也标成 action_list；曲目必须同时具备实体副标题元数据。
        if (
          hint === 'action_list'
          && readString(record, 'item_key')
          && readString(record, 'subtitle')
        ) {
          const trackDiscNumber = title ? inferDiscNumber(title) : undefined;
          const resolvedDiscNumber = trackDiscNumber ?? sectionDiscNumber;
          const track = readItem(value, 'track', session.hierarchy, {
            multiSessionKey: session.multiSessionKey,
            level: list.level,
            parentReference,
            parentPath,
            sourceIndex: index,
            ...(resolvedDiscNumber !== undefined
              ? { inheritedDiscNumber: resolvedDiscNumber }
              : {}),
            registerPath,
          });
          if (track) {
            const withAlbum = track.album || !inheritedAlbum
              ? track
              : { ...track, album: inheritedAlbum };
            tracks.push(withAlbum.imageKey || !inheritedImageKey
              ? withAlbum
              : { ...withAlbum, imageKey: inheritedImageKey });
          }
          continue;
        }
        if (hint !== 'list' || !title) continue;
        const segment = readPathSegment(
          value,
          session.hierarchy,
          'container',
          parentReference,
          index,
          sectionDiscNumber,
        );
        if (!segment) continue;
        containerCount += 1;
        if (containerCount > MAX_ALBUM_CONTAINER_COUNT) {
          throw new RoonLibraryError(
            'ROON_LIBRARY_RESPONSE_INVALID',
            'Roon album Browse has too many nested containers',
          );
        }
        const containerPath = [...parentPath, segment];
        registerPath(segment.pathSignature, containerPath);
        await navigateToPath(session, containerPath);
        await collectCurrentLevel(
          containerPath,
          inferDiscNumber(title) ?? sectionDiscNumber,
          depth + 1,
        );
      }
    };

    await navigateToPath(session, albumPath);
    await collectCurrentLevel(albumPath, undefined, 0);
    return tracks;
  };

  const pageFromResolvedItems = (
    items: readonly RoonEntityDescriptor[],
    request: RoonPageRequest,
    level: number,
  ): RoonLibraryPage<RoonEntityDescriptor> => {
    const pageRequest = normalizePage(request);
    const pageItems = items.slice(pageRequest.offset, pageRequest.offset + pageRequest.limit);
    return {
      items: pageItems,
      offset: pageRequest.offset,
      level,
      total: items.length,
      hasMore: pageRequest.offset + pageItems.length < items.length,
    };
  };

  // 专辑/艺人首屏只扫描当前页加一个前瞻条目；不等待整组资料库全部读完。
  const searchEntityPage = async (
    query: string, kind: 'album' | 'artist', request: RoonPageRequest,
  ): Promise<RoonLibraryPage<RoonEntityDescriptor>> => {
    const key = JSON.stringify([kind, query]);
    const session = searchSession(query, kind);
    return withSession(session, async () => {
      const previous = entitySearchProgress.get(key);
      let state = previous ? { ...previous, items: [...previous.items] } : undefined;
      if (!state) {
        const response = readBrowseResponse(await requestBrowse('browse', {
          hierarchy: 'search', multi_session_key: session.multiSessionKey, pop_all: true, input: query,
        }));
        applyBrowseState(session, response, []);
        session.rootLevel = response.list.level;
        const root = await loadAllAtLevel('search', session.multiSessionKey, response.list.level, response.list.count, MAX_SEARCH_SCAN_ITEMS);
        const titles = new Set(kind === 'album' ? ['album', 'albums', '专辑', '唱片'] : ['artist', 'artists', '艺人', '艺术家', '歌手']);
        const groups = root.flatMap((value, index) => {
          const record = asRecord(value) ?? {};
          if (readString(record, 'hint') !== 'list' || !titles.has((readString(record, 'title') ?? '').normalize('NFKC').trim().toLocaleLowerCase('en-US'))) return [];
          const segment = readPathSegment(value, 'search', 'container', rootReference('search', query), index);
          return segment ? [segment] : [];
        });
        state = { groups, groupIndex: 0, sourceOffset: 0, scanned: root.length, items: [], done: groups.length === 0, level: response.list.level };
      }
      const target = request.offset + request.limit + 1;
      while (!state.done && state.items.length < target) {
        const group = state.groups[state.groupIndex]!;
        const path = [group];
        registerPath(group.pathSignature, path);
        const list = await navigateToPath(session, path);
        state.level = list.level;
        if (list.count !== undefined && state.sourceOffset >= list.count) {
          state.groupIndex++; state.sourceOffset = 0;
          state.done = state.groupIndex >= state.groups.length;
          continue;
        }
        const remaining = MAX_SEARCH_SCAN_ITEMS - state.scanned;
        if (remaining < 1) throw new RoonLibraryError('ROON_LIBRARY_RESPONSE_INVALID', '搜索结果超出有界扫描上限');
        const count = Math.min(MAX_PAGE_LIMIT, target - state.items.length, remaining, list.count === undefined ? MAX_PAGE_LIMIT : list.count - state.sourceOffset);
        const loaded = readLoadResponse(await requestBrowse('load', {
          hierarchy: 'search', multi_session_key: session.multiSessionKey, level: list.level, offset: state.sourceOffset, count,
        }));
        for (let index = 0; index < loaded.items.length; index++) {
          const value = loaded.items[index];
          if (readString(asRecord(value) ?? {}, 'hint') !== 'list') continue;
          const item = readItem(value, kind, 'search', {
            multiSessionKey: session.multiSessionKey, level: list.level, parentReference: group.pathSignature,
            parentPath: path, sourceIndex: state.sourceOffset + index, registerPath,
          });
          if (item?.itemKey && !state.items.some(existing => existing.itemKey === item.itemKey && existing.title === item.title && existing.subtitle === item.subtitle)) state.items.push(item);
        }
        state.sourceOffset += loaded.items.length;
        state.scanned += loaded.items.length;
        if (loaded.items.length < count || (list.count !== undefined && state.sourceOffset >= list.count)) {
          state.groupIndex++; state.sourceOffset = 0;
          state.done = state.groupIndex >= state.groups.length;
        }
      }
      // 整次请求成功才推进检查点，失败重试不会跳过条目。
      assertLibraryReadCurrent();
      entitySearchProgress.set(key, state);
      return {
        items: state.items.slice(request.offset, request.offset + request.limit), offset: request.offset, level: state.level,
        ...(state.done ? { total: state.items.length } : {}),
        hasMore: !state.done || request.offset + request.limit < state.items.length,
      };
    });
  };

  const albumGroupTitles = new Set([
    'album',
    'albums',
    'discography',
    'releases',
    '专辑',
    '唱片',
    '唱片集',
    '发行',
  ]);
  const trackGroupTitles = new Set([
    'track',
    'tracks',
    'song',
    'songs',
    'top tracks',
    '单曲',
    '曲目',
    '歌曲',
  ]);

  const normalizedGroupKind = (title: string): 'album' | 'track' | undefined => {
    const normalized = title.normalize('NFKC').trim().toLocaleLowerCase('en-US');
    if (albumGroupTitles.has(normalized)) return 'album';
    if (trackGroupTitles.has(normalized)) return 'track';
    return undefined;
  };

  const isGenreCollectionSummary = (subtitle: string): boolean => {
    const normalized = subtitle.normalize('NFKC').trim();
    return /^\d[\d,. ]*\s+artists?\s*[,，]\s*\d[\d,. ]*\s+albums?$/iu.test(normalized)
      || /^\d[\d,. ]*\s*(?:位)?艺术家\s*[,，]\s*\d[\d,. ]*\s*(?:张)?专辑$/u.test(normalized);
  };

  const invalidateReadContexts = (preserveActions = false): void => {
    contextGeneration++;
    if (!preserveActions) actionGeneration++;
    for (const context of [...detailContexts.values()]) if (context.owned) forgetContext(context);
    detailContexts.clear(); rootEpochs.clear();
    albumTracksBySignature.clear(); artistAlbumsBySignature.clear(); genreItemsBySignature.clear(); playlistTracksBySignature.clear();
    searchTracksByQuery.clear(); searchAlbumsByQuery.clear(); searchArtistsByQuery.clear(); entitySearchProgress.clear();
    pathsBySignature.clear(); pathSizes.clear(); retainedPathBytes = 0;
    artistImageKeysBySignature.clear(); artistImageKeySizes.clear(); retainedArtistImageKeyBytes = 0; pendingArtistImageKeys.clear();
    for (const session of new Set(sessionsByKey.values())) {
      const oldKey = session.multiSessionKey;
      retireSession(oldKey);
    }
    contextZone = dependencies.zoneOrOutputId?.();
  };
  const checkContextZone = (): void => {
    if (contextZone === dependencies.zoneOrOutputId?.()) return;
    // Zone 换代保留已发引用的稳定重放材料；缓存与会话必须换代。
    const paths = new Map(pathsBySignature);
    invalidateReadContexts(true);
    for (const [signature, path] of paths) registerPath(signature, path);
  };
  const validateRawPage = (loaded: LoadResponse, offset: number, count: number, total?: number): void => {
    if (loaded.offset !== undefined && readSafeInteger(loaded.offset) !== offset) {
      throw new RoonLibraryError('ROON_LIBRARY_RESPONSE_INVALID', 'Browse 原始 offset 偏移不匹配');
    }
    if (offset + loaded.items.length > 1_000_000) throw new RoonLibraryError('ROON_LIBRARY_RESPONSE_INVALID', 'Browse 原始偏移超出公开游标范围');
    if (loaded.items.length > count || (total !== undefined && loaded.items.length > 0 && offset + loaded.items.length > total)) {
      throw new RoonLibraryError('ROON_LIBRARY_RESPONSE_INVALID', 'Browse 原始页超出请求范围');
    }
    if (loaded.items.length === 0 && total !== undefined && offset < total) {
      throw new RoonLibraryError('ROON_LIBRARY_RESPONSE_INVALID', 'Browse 原始页未推进且未到 EOF');
    }
    for (const value of loaded.items) browseValueBytes(value, MAX_BROWSE_RECORD_BYTES);
  };
  const newFrame = (path: readonly BrowsePathSegment[], role: DetailFrame['role'], disc?: number, depth = 0): DetailFrame => ({
    path, role, offset: 0, buffer: [], bufferOffset: 0, bufferBytes: 0, index: 0, eof: false, ...(disc !== undefined ? { disc } : {}), depth,
  });
  const forgetContext = (context: DetailContext): void => {
    if (detailContexts.get(context.key) !== context) return;
    detailContexts.delete(context.key);
    if (context.owned) {
      for (const [alias, value] of sessionsByKey) if (value === context.session) sessionsByKey.delete(alias);
      context.pathValues?.clear(); context.paths.clear();
      context.rootPath = []; context.pathBytes = 0; context.rootPathBytes = 0;
      context.state = { frames: [], groups: [], items: [], candidates: [], itemBytes: 0, candidateBytes: 0, grouped: false, complete: false, containers: 0, level: 0 };
      context.session.currentPath = [];
      context.abort?.abort();
      return;
    }
    // 根实体路径独立保留；释放详情条目路径后旧 reference 只会明确过期。
    const retained = new Set([...detailContexts.values()].flatMap(value => [...value.paths, ...value.rootPath.map(segment => segment.pathSignature)]));
    for (const signature of context.paths) if (!retained.has(signature)) {
      pathsBySignature.delete(signature); retainedPathBytes -= pathSizes.get(signature) ?? 0; pathSizes.delete(signature);
    }
  };
  const detailBytes = (context: DetailContext, state: DetailState): number => state.itemBytes + state.candidateBytes
    + state.frames.reduce((sum, frame) => sum + frame.bufferBytes + 256, 0)
    + state.groups.reduce((sum, frame) => sum + frame.bufferBytes + 256, 0) + context.pathBytes + context.rootPathBytes + (context.owned ? 4096 + 2 * (context.session.input?.length ?? 0) : 0);
  const reserveDetailMemory = (context: DetailContext, state: DetailState, stagedBytes: number): void => {
    const size = (value: DetailState) => value.items.length + value.candidates.length;
    if (size(state) > MAX_DETAIL_DESCRIPTORS) throw new RoonLibraryError('ROON_LIBRARY_REQUEST_FAILED', '详情条目预算已满');
    if (detailBytes(context, state) + stagedBytes > MAX_DETAIL_CACHE_BYTES) throw new RoonLibraryError('ROON_LIBRARY_REQUEST_FAILED', '详情缓存字节预算已满');
    let bytes = detailBytes(context, state) + stagedBytes + [...detailContexts.values()].filter(value => value !== context).reduce((sum, value) => sum + detailBytes(value, value.state), 0);
    let retained = size(state) + [...detailContexts.values()].filter(value => value !== context).reduce((sum, value) => sum + size(value.state), 0);
    while (retained > MAX_RETAINED_DESCRIPTORS || bytes > MAX_RETAINED_CACHE_BYTES) {
      const oldest = [...detailContexts.values()].find(value => value !== context && value.pending === 0 && !value.owned);
      if (!oldest) throw new RoonLibraryError('ROON_LIBRARY_REQUEST_FAILED', '在途详情缓存预算已满');
      retained -= size(oldest.state); bytes -= detailBytes(oldest, oldest.state); forgetContext(oldest);
    }
  };
  const assertContext = (context: DetailContext): void => {
    assertLibraryReadCurrent();
    if (detailContexts.get(context.key) !== context || context.generation !== contextGeneration
      || context.sessionKey !== context.session.multiSessionKey || context.zone !== dependencies.zoneOrOutputId?.()) {
      throw libraryReadCancelled();
    }
  };
  const incrementalDetail = async (
    entity: RoonEntityDescriptor, mode: DetailMode, session: BrowseSessionState,
    path: readonly BrowsePathSegment[], request: RoonPageRequest, supplied?: DetailContext,
  ): Promise<RoonLibraryPage<RoonEntityDescriptor>> => {
    const key = supplied?.key ?? `${mode}\0${entity.browseContext!.pathSignature}`;
    let context = supplied ?? detailContexts.get(key);
    if (!context) {
      if (detailContexts.size >= MAX_DETAIL_CONTEXTS) {
        const oldest = [...detailContexts.values()].find(value => value.pending === 0 && !value.owned);
        if (!oldest) throw new RoonLibraryError('ROON_LIBRARY_REQUEST_FAILED', '在途详情上下文预算已满');
        forgetContext(oldest);
      }
      context = {
        key, epoch: randomUUID(), session, sessionKey: session.multiSessionKey, generation: contextGeneration, zone: contextZone,
        state: { frames: [newFrame(path, mode === 'album' ? 'album' : mode === 'artist' ? 'artist-root' : 'mixed-root')], groups: [], items: [], candidates: [], itemBytes: 0, candidateBytes: 0, grouped: false, complete: false, containers: 0, level: entity.browseContext!.level + 1 },
        tail: Promise.resolve(), pending: 0, paths: new Set(), rootPath: path, pathBytes: 0, rootPathBytes: browseValueBytes(path, MAX_PATH_CACHE_BYTES),
      };
      detailContexts.set(key, context);
    }
    const owned = context;
    detailContexts.delete(key); detailContexts.set(key, owned); owned.pending++;
    const work = async (): Promise<RoonLibraryPage<RoonEntityDescriptor>> => {
      assertContext(owned);
      let scanned = 0;
      const target = request.offset + request.limit + 1;
      if (owned.owned) await withSession(session, async () => {
        assertContext(owned);
        // 每页重新进入稳定父路径，不能把上次SDK导航的count当新观测。
        await ensureRoot(session);
        const list = await navigateToPath(session, owned.rootPath);
        assertContext(owned);
        if (owned.rootRawCount !== undefined && list.count !== undefined && owned.rootRawCount !== list.count) {
          forgetContext(owned);
          throw new RoonLibraryError('ROON_LIBRARY_RESPONSE_INVALID', '播放来源原始总数已改变');
        }
      });
      while (!owned.state.complete && owned.state.items.length < target) {
        await withSession(session, async () => {
          assertContext(owned);
          const state: DetailState = { ...owned.state, frames: owned.state.frames.map(frame => ({ ...frame })), groups: [...owned.state.groups], items: [...owned.state.items], candidates: [...owned.state.candidates] };
          const stagedPaths = new Map<string, readonly BrowsePathSegment[]>();
          const stagePath = (signature: string, value: readonly BrowsePathSegment[]) => { stagedPaths.set(signature, value); };
          const frame = state.frames.at(-1);
          let rootRawCount: number | undefined;
          if (!frame) { state.complete = true; }
          else {
            const needsLoad = frame.index >= frame.buffer.length && !frame.eof && (frame.total === undefined || frame.offset < frame.total);
            const list = needsLoad || frame.level === undefined ? await navigateToPath(session, frame.path) : { level: frame.level, ...(frame.total !== undefined ? { count: frame.total } : {}) };
            assertContext(owned);
            frame.level = list.level;
            state.level = list.level;
            if (frame.total !== undefined && list.count !== undefined && frame.total !== list.count) {
              forgetContext(owned);
              throw new RoonLibraryError('ROON_LIBRARY_RESPONSE_INVALID', '详情原始总数变化，请重新加载');
            }
            if (list.count !== undefined) { frame.total = list.count; if (frame.path.at(-1)?.pathSignature === owned.rootPath.at(-1)?.pathSignature) rootRawCount = list.count; }
            if (frame.validateBuffer && frame.buffer.length) {
              const refreshed = readLoadResponse(await requestBrowse('load', { hierarchy: session.hierarchy, multi_session_key: session.multiSessionKey, level: list.level, offset: frame.bufferOffset, count: frame.buffer.length }));
              validateRawPage(refreshed, frame.bufferOffset, frame.buffer.length, frame.total);
              const identity = (value: unknown) => {
                const record = asRecord(value) ?? {};
                return ['title', 'subtitle', 'hint', 'artist', 'album', 'track_number', 'disc_number', 'duration', 'duration_ms', 'version'].map(key => record[key]);
              };
              if (refreshed.items.length !== frame.buffer.length || refreshed.items.some((value, index) => JSON.stringify(identity(value)) !== JSON.stringify(identity(frame.buffer[index])))) {
                forgetContext(owned);
                throw new RoonLibraryError('ROON_LIBRARY_RESPONSE_INVALID', '播放来源检查点身份已改变');
              }
              scanned += refreshed.items.length;
              frame.buffer = refreshed.items;
              frame.bufferBytes = refreshed.items.reduce<number>((sum, value) => sum + browseValueBytes(value, MAX_BROWSE_RECORD_BYTES), 0);
              delete frame.validateBuffer;
            }
            if (frame.index >= frame.buffer.length && !frame.eof) {
              if (frame.total !== undefined && frame.offset >= frame.total) frame.eof = true;
              else {
                const budget = MAX_DETAIL_REQUEST_WORK - scanned;
                if (budget <= 0) throw new RoonLibraryError('ROON_LIBRARY_REQUEST_FAILED', '本次详情扫描预算已满，可重试继续读取');
                const count = Math.min(MAX_PAGE_LIMIT, Math.max(1, target - state.items.length), budget, frame.total === undefined ? MAX_PAGE_LIMIT : frame.total - frame.offset);
                const loaded = readLoadResponse(await requestBrowse('load', { hierarchy: session.hierarchy, multi_session_key: session.multiSessionKey, level: list.level, offset: frame.offset, count }));
                validateRawPage(loaded, frame.offset, count, frame.total);
                scanned += loaded.items.length;
                frame.bufferBytes = loaded.items.reduce<number>((sum, value) => sum + browseValueBytes(value, MAX_BROWSE_RECORD_BYTES), 0);
                frame.buffer = loaded.items; frame.bufferOffset = frame.offset; frame.index = 0;
                frame.offset += loaded.items.length;
                frame.eof = frame.total !== undefined ? frame.offset >= frame.total : loaded.items.length === 0;
              }
            }
            const parentReference = frame.path.at(-1)?.pathSignature ?? rootReference(session.hierarchy);
            let descended = false;
            while (frame.index < frame.buffer.length && state.items.length < target) {
              const index = frame.bufferOffset + frame.index++;
              const value = frame.buffer[frame.index - 1]; const record = asRecord(value) ?? {};
              const hint = readString(record, 'hint'), title = readString(record, 'title'), subtitle = readString(record, 'subtitle');
              const groupKind = title ? normalizedGroupKind(title) : undefined;
              if (frame.role === 'album' && hint === 'header') { if (title) { const disc = inferDiscNumber(title) ?? frame.disc; if (disc !== undefined) frame.disc = disc; } continue; }
              const container = hint === 'list' && title && (frame.role === 'album' || frame.role === 'artist-root' && groupKind === 'album' || frame.role === 'mixed-root' && groupKind);
              if (container) {
                const segment = readPathSegment(value, session.hierarchy, 'container', parentReference, index, frame.disc);
                if (segment && (frame.role !== 'mixed-root' || mode === 'genre' || groupKind === 'track')) {
                  if (++state.containers > MAX_ALBUM_CONTAINER_COUNT) throw new RoonLibraryError('ROON_LIBRARY_RESPONSE_INVALID', '详情分组数量超出有界预算');
                  const childPath = [...frame.path, segment]; stagePath(segment.pathSignature, childPath);
                  const child = newFrame(childPath, frame.role === 'album' ? 'album' : groupKind === 'album' ? 'album-items' : 'track-items', title ? inferDiscNumber(title) ?? frame.disc : frame.disc, frame.depth + 1);
                  if (child.depth > MAX_ALBUM_BROWSE_DEPTH) throw new RoonLibraryError('ROON_LIBRARY_RESPONSE_INVALID', '详情层级深度超出有界预算');
                  if (frame.role === 'mixed-root') state.groups.push(child);
                  else {
                    if (frame.role === 'artist-root') { state.grouped = true; state.candidates = []; state.candidateBytes = 0; }
                    state.frames.push(child); descended = true; break;
                  }
                }
                continue;
              }
              let kind: 'album' | 'track' | undefined;
              if (frame.role === 'artist-root') { if (!state.grouped && hint === 'list') kind = 'album'; }
              else if (frame.role === 'album-items') { if (hint === 'list') kind = 'album'; }
              else if (frame.role === 'mixed-root') {
                if (mode === 'genre' && hint === 'list' && subtitle && !isGenreCollectionSummary(subtitle)) kind = 'album';
                else if (hint === 'action_list' && subtitle) kind = 'track';
              } else if (hint === 'action_list' && subtitle) kind = 'track';
              if (!kind) continue;
              const disc = frame.role === 'album' ? (title ? inferDiscNumber(title) : undefined) ?? frame.disc : undefined;
              const item = readItem(value, kind, session.hierarchy, { multiSessionKey: session.multiSessionKey, level: list.level, parentReference, parentPath: frame.path, sourceIndex: index, ...(disc !== undefined ? { inheritedDiscNumber: disc } : {}), registerPath: stagePath });
              if (!item?.itemKey) continue;
              const resolved = mode === 'album' ? { ...item, ...(!item.album ? { album: entity.title } : {}), ...(!item.imageKey && entity.imageKey ? { imageKey: entity.imageKey } : {}) } : item;
              const bytes = browseValueBytes(resolved, MAX_BROWSE_RECORD_BYTES);
              if (frame.role === 'artist-root') { state.candidates.push(resolved); state.candidateBytes += bytes; }
              else { state.items.push(resolved); state.itemBytes += bytes; }
            }
            if (!descended && frame.index >= frame.buffer.length) {
              frame.buffer = []; frame.bufferBytes = 0; frame.index = 0;
              if (frame.eof) {
                state.frames.pop();
                if (frame.role === 'artist-root' && !state.grouped) { state.items = state.candidates; state.itemBytes = state.candidateBytes; state.candidates = []; state.candidateBytes = 0; }
                if (frame.role === 'mixed-root' && state.groups.length) state.frames.push(state.groups.shift()!);
                else if (!state.frames.length && state.groups.length) state.frames.push(state.groups.shift()!);
                state.complete = state.frames.length === 0;
              }
            }
          }
          assertContext(owned);
          const stagedSizes = new Map([...stagedPaths].map(([signature, value]) => [signature, browseValueBytes(value, MAX_PATH_CACHE_BYTES)]));
          const newContextBytes = [...stagedSizes].filter(([signature]) => !owned.paths.has(signature)).reduce((sum, [, bytes]) => sum + bytes, 0);
          reserveDetailMemory(owned, state, newContextBytes);
          if (owned.owned) {
            for (const [signature, value] of stagedPaths) { owned.pathValues!.set(signature, value); owned.paths.add(signature); }
          } else {
            const additions = [...stagedPaths.keys()].filter(signature => !pathsBySignature.has(signature)).length;
            if (pathsBySignature.size + additions > MAX_REGISTERED_PATHS) throw new RoonLibraryError('ROON_LIBRARY_REQUEST_FAILED', 'Browse 路径预算已满');
            const pathDelta = [...stagedSizes].reduce((sum, [signature, bytes]) => sum + bytes - (pathSizes.get(signature) ?? 0), 0);
            if (retainedPathBytes + pathDelta > MAX_PATH_CACHE_BYTES) throw new RoonLibraryError('ROON_LIBRARY_REQUEST_FAILED', 'Browse 路径字节预算已满');
            for (const [signature, value] of stagedPaths) { pathsBySignature.set(signature, value); pathSizes.set(signature, stagedSizes.get(signature)!); owned.paths.add(signature); }
            retainedPathBytes += pathDelta;
          }
          owned.pathBytes += newContextBytes;
          owned.state = state;
          if (rootRawCount !== undefined) owned.rootRawCount = rootRawCount;
        });
      }
      assertContext(owned);
      const items = owned.state.items.slice(request.offset, request.offset + request.limit);
      return { items, offset: request.offset, level: owned.state.level, sourceEpoch: owned.epoch, complete: owned.state.complete, nextOffset: request.offset + items.length,
        ...(owned.state.complete ? { total: owned.state.items.length } : {}), hasMore: !owned.state.complete || request.offset + items.length < owned.state.items.length };
    };
    const result = owned.tail.then(work, work).finally(() => { owned.pending--; });
    owned.tail = result.then(() => undefined, () => undefined);
    return result;
  };

  const collectEntityChildren = async (
    session: BrowseSessionState,
    entityPath: readonly BrowsePathSegment[],
    mode: 'genre' | 'playlist',
  ): Promise<{ items: readonly RoonEntityDescriptor[]; level: number }> => {
    const list = await navigateToPath(session, entityPath);
    const loadedItems = await loadAllAtLevel(
      session.hierarchy,
      session.multiSessionKey,
      list.level,
      list.count,
      MAX_ARTIST_SCAN_ITEMS,
    );
    const parentReference = entityPath.at(-1)?.pathSignature
      ?? rootReference(session.hierarchy);
    const items: RoonEntityDescriptor[] = [];
    const groups: Array<{ kind: 'album' | 'track'; segment: BrowsePathSegment }> = [];

    for (let index = 0; index < loadedItems.length; index += 1) {
      const value = loadedItems[index];
      const record = asRecord(value);
      const hint = readString(record ?? {}, 'hint');
      const title = readString(record ?? {}, 'title');
      const subtitle = readString(record ?? {}, 'subtitle');
      const groupKind = title ? normalizedGroupKind(title) : undefined;
      if (hint === 'list' && groupKind) {
        const segment = readPathSegment(
          value,
          session.hierarchy,
          'container',
          parentReference,
          index,
        );
        if (segment && (mode === 'genre' || groupKind === 'track')) {
          groups.push({ kind: groupKind, segment });
        }
        continue;
      }
      if (
        mode === 'genre'
        && hint === 'list'
        && subtitle
        && !isGenreCollectionSummary(subtitle)
      ) {
        const album = readItem(value, 'album', session.hierarchy, {
          multiSessionKey: session.multiSessionKey,
          level: list.level,
          parentReference,
          parentPath: entityPath,
          sourceIndex: index,
          registerPath,
        });
        if (album?.itemKey) items.push(album);
        continue;
      }
      if (hint === 'action_list' && readString(record ?? {}, 'subtitle')) {
        const track = readItem(value, 'track', session.hierarchy, {
          multiSessionKey: session.multiSessionKey,
          level: list.level,
          parentReference,
          parentPath: entityPath,
          sourceIndex: index,
          registerPath,
        });
        if (track?.itemKey) items.push(track);
      }
    }

    let scannedItems = loadedItems.length;
    for (const group of groups) {
      const groupPath = [...entityPath, group.segment];
      registerPath(group.segment.pathSignature, groupPath);
      const groupList = await navigateToPath(session, groupPath);
      const remaining = MAX_ARTIST_SCAN_ITEMS - scannedItems;
      if (remaining < 1) {
        throw new RoonLibraryError(
          'ROON_LIBRARY_RESPONSE_INVALID',
          `Roon ${mode} results exceed the bounded scan limit`,
        );
      }
      const groupItems = await loadAllAtLevel(
        session.hierarchy,
        session.multiSessionKey,
        groupList.level,
        groupList.count,
        remaining,
      );
      scannedItems += groupItems.length;
      for (let index = 0; index < groupItems.length; index += 1) {
        const value = groupItems[index];
        const record = asRecord(value);
        const expectedHint = group.kind === 'album' ? 'list' : 'action_list';
        if (readString(record ?? {}, 'hint') !== expectedHint) continue;
        if (group.kind === 'track' && !readString(record ?? {}, 'subtitle')) continue;
        const item = readItem(value, group.kind, session.hierarchy, {
          multiSessionKey: session.multiSessionKey,
          level: groupList.level,
          parentReference: group.segment.pathSignature,
          parentPath: groupPath,
          sourceIndex: index,
          registerPath,
        });
        if (item?.itemKey) items.push(item);
      }
    }
    return {
      items,
      level: items[0]?.browseContext?.level ?? list.level,
    };
  };

  const browseEntityChildren = async (
    entity: RoonEntityDescriptor,
    expectedKind: 'genre' | 'playlist',
    request: RoonPageRequest,
    options?: RoonBrowseReadOptions,
  ): Promise<RoonLibraryPage<RoonEntityDescriptor>> => {
    const pageRequest = normalizePage(request);
    if (!entity.itemKey) {
      throw new RoonLibraryError(
        'ROON_LIBRARY_RESPONSE_INVALID',
        `Roon ${expectedKind} has no item key`,
      );
    }
    authorizeRoonAction({
      title: entity.title,
      hint: entity.hint,
      item_key: entity.itemKey,
    }, { kind: 'browse' });
    const context = entity.browseContext;
    if (!context) {
      throw new RoonLibraryError(
        'ROON_LIBRARY_RESPONSE_INVALID',
        `Roon ${expectedKind} path is unavailable`,
      );
    }
    checkContextZone();
    const { session, path } = entitySessionAndPath(entity, expectedKind);
    if (options?.refresh) await refreshSession(session);
    if (incrementalDetails) return incrementalDetail(entity, expectedKind, session, path, pageRequest);
    const cache = expectedKind === 'genre'
      ? genreItemsBySignature
      : playlistTracksBySignature;
    const cached = cache.get(context.pathSignature);
    if (cached) {
      const level = cached[0]?.browseContext?.level ?? context.level + 1;
      return pageFromResolvedItems(cached, pageRequest, level);
    }
    return withSession(session, async () => {
      const existing = cache.get(context.pathSignature);
      if (existing) {
        const level = existing[0]?.browseContext?.level ?? context.level + 1;
        return pageFromResolvedItems(existing, pageRequest, level);
      }
      const collected = await collectEntityChildren(session, path, expectedKind);
      assertLibraryReadCurrent();
      cache.set(context.pathSignature, collected.items);
      return pageFromResolvedItems(collected.items, pageRequest, collected.level);
    });
  };

  const resolveCurrentItemKey = async (
    session: BrowseSessionState,
    segment: BrowsePathSegment,
    parentPath: readonly BrowsePathSegment[],
  ): Promise<{ itemKey: string; segment: BrowsePathSegment }> => {
    const list = currentList(session);
    const loaded = readLoadResponse(await requestBrowse('load', {
      hierarchy: session.hierarchy,
      multi_session_key: session.multiSessionKey,
      level: list.level,
      offset: segment.sourceIndex,
      count: 1,
    }));
    validateRawPage(loaded, segment.sourceIndex, 1, list.count);
    const value = loaded.items[0];
    const parentReference = parentPath.at(-1)?.pathSignature
      ?? sessionRootReference(session);
    const refreshed = readPathSegment(
      value,
      session.hierarchy,
      segment.kind,
      parentReference,
      segment.sourceIndex,
      segment.discNumber,
    );
    if (
      !refreshed
      || refreshed.pathSignature !== segment.pathSignature
      || refreshed.hint !== segment.hint
    ) {
      throw new RoonLibraryError(
        'ROON_LIBRARY_RESPONSE_INVALID',
        'Roon Browse item identity changed before action',
      );
    }
    return { itemKey: refreshed.itemKey, segment: refreshed };
  };

  const replayStablePath = async (
    session: BrowseSessionState,
    sourcePath: readonly BrowsePathSegment[],
  ): Promise<readonly BrowsePathSegment[]> => {
    await ensureRoot(session);
    const replayedPath: BrowsePathSegment[] = [];
    for (const sourceSegment of sourcePath) {
      const refreshed = await resolveCurrentItemKey(session, sourceSegment, replayedPath);
      const nextPath = [...replayedPath, refreshed.segment];
      const response = readBrowseResponse(await requestBrowse('browse', {
        hierarchy: session.hierarchy,
        multi_session_key: session.multiSessionKey,
        item_key: refreshed.itemKey,
      }));
      applyBrowseState(session, response, nextPath);
      replayedPath.push(refreshed.segment);
    }
    return replayedPath;
  };

  const runTrackAction = async (
    track: RoonEntityDescriptor,
    zoneOrOutputId: string,
    kind: 'play' | 'queue',
    onDispatch?: () => void,
    captured?: { hierarchy: RoonBrowseHierarchy; input?: string; path: readonly BrowsePathSegment[]; generation?: number },
  ): Promise<RoonTrackActionOutcome> => {
    if (!track.itemKey) {
      throw new RoonLibraryError(
        'ROON_LIBRARY_RESPONSE_INVALID',
        'Roon track has no item key',
      );
    }
    if (zoneOrOutputId.trim().length === 0 || zoneOrOutputId.length > 128) {
      throw new RoonLibraryError('ROON_LIBRARY_INVALID_PAGE', 'Roon Zone reference is invalid');
    }

    authorizeRoonAction({
      title: track.title,
      hint: track.hint,
      item_key: track.itemKey,
    }, { kind: 'browse' });
    const resolved = captured ?? (() => { const value = entitySessionAndPath(track, 'track'); return { hierarchy: value.session.hierarchy, ...(value.session.input !== undefined ? { input: value.session.input } : {}), path: value.path }; })();
    const path = resolved.path;
    const segment = path.at(-1);
    if (!segment) {
      throw new RoonLibraryError('ROON_LIBRARY_RESPONSE_INVALID', 'Roon track path is unavailable');
    }
    const parentPath = path.slice(0, -1);
    const actionSession = createSession(resolved.hierarchy, {
      register: false,
      ...(resolved.input !== undefined ? { input: resolved.input } : {}),
    });
    return withSession(actionSession, async () => {
      const refreshedParentPath = await replayStablePath(actionSession, parentPath);
      const refreshed = await resolveCurrentItemKey(
        actionSession,
        segment,
        refreshedParentPath,
      );
      const refreshedPath = [...refreshedParentPath, refreshed.segment];
      const browseResponse = readBrowseResponse(await requestBrowse('browse', {
        hierarchy: actionSession.hierarchy,
        multi_session_key: actionSession.multiSessionKey,
        item_key: refreshed.itemKey,
      }));
      applyBrowseState(actionSession, browseResponse, refreshedPath);
      const actionList = readLoadResponse(await requestBrowse('load', {
        hierarchy: actionSession.hierarchy,
        multi_session_key: actionSession.multiSessionKey,
        level: browseResponse.list.level,
        offset: 0,
        count: Math.min(browseResponse.list.count ?? 32, 32),
      }));
      const actionItem = actionList.items
        .map((item) => asRecord(item))
        .find((item) => {
          if (!item) return false;
          try {
            authorizeRoonAction(item, { kind, allowMutation: true });
            return true;
          } catch {
            return false;
          }
        });
      if (!actionItem) {
        throw new RoonLibraryError(
          'ROON_TRACK_ACTION_UNAVAILABLE',
          `Roon ${kind} action is unavailable`,
        );
      }
      const authorization = authorizeRoonAction(actionItem, { kind, allowMutation: true });
      // 导航和身份校验完成后、真正发命令前开始监听，不漏掉早于 Browse 回执的 Transport 事件。
      const guardCaptured = () => {
        if (captured && captured.generation !== actionGeneration) throw new RoonLibraryError('ROON_LIBRARY_RESPONSE_INVALID', '曲目动作快照已过期');
        if (dependencies.zoneOrOutputId && dependencies.zoneOrOutputId() !== zoneOrOutputId) throw new RoonLibraryError('ROON_LIBRARY_RESPONSE_INVALID', '播放Zone已改变');
      };
      guardCaptured(); onDispatch?.(); guardCaptured();
      let result: BrowseItemRecord | undefined;
      try {
        result = asRecord(await requestBrowse('browse', {
          hierarchy: actionSession.hierarchy,
          multi_session_key: actionSession.multiSessionKey,
          item_key: authorization.itemKey,
          zone_or_output_id: zoneOrOutputId,
        }));
      } catch (error) {
        if (kind === 'play' && error instanceof RoonLibraryError) {
          return 'confirmation-required';
        }
        throw error;
      }
      const resultAction = readString(result ?? {}, 'action');
      if (!resultAction || resultAction === 'message') {
        if (kind === 'play') return 'confirmation-required';
        throw new RoonLibraryError(
          resultAction === 'message'
            ? 'ROON_LIBRARY_REQUEST_FAILED'
            : 'ROON_LIBRARY_RESPONSE_INVALID',
          `Roon ${kind} action response requires confirmation`,
        );
      }
      return 'accepted';
    });
  };

  const captureTrackActions = (track: RoonEntityDescriptor): RoonCapturedTrackActions => {
    const { session, path } = entitySessionAndPath(track, 'track');
    const captured = { generation: actionGeneration, hierarchy: session.hierarchy, ...(session.input !== undefined ? { input: session.input } : {}), path: path.map(segment => ({ ...segment })) };
    const descriptor = { ...track, ...(track.browseContext ? { browseContext: { ...track.browseContext } } : {}) };
    const retainedBytes = browseValueBytes(captured, MAX_DETAIL_CACHE_BYTES) + browseValueBytes(descriptor, MAX_BROWSE_RECORD_BYTES) + 512;
    const generation = actionGeneration;
    const guard = () => { if (actionGeneration !== generation) throw new RoonLibraryError('ROON_LIBRARY_RESPONSE_INVALID', '曲目动作快照已过期'); };
    return { retainedBytes,
      play(zone, onDispatch) { guard(); return runTrackAction(descriptor, zone, 'play', onDispatch, captured); },
      queue(zone) { guard(); return runTrackAction(descriptor, zone, 'queue', undefined, captured); },
    };
  };
  const forkPlaybackContext = (entity: RoonEntityDescriptor, epoch: string, zone: string): RoonOwnedPlaybackSource => {
    checkContextZone();
    const mode = entity.kind;
    if (!incrementalDetails || (mode !== 'album' && mode !== 'genre' && mode !== 'playlist')) throw new RoonLibraryError('ROON_LIBRARY_RESPONSE_INVALID', '播放上下文不支持此来源');
    if (dependencies.zoneOrOutputId && dependencies.zoneOrOutputId() !== zone) throw new RoonLibraryError('ROON_LIBRARY_RESPONSE_INVALID', '播放Zone已改变');
    const origin = detailContexts.get(`${mode}\0${entity.browseContext?.pathSignature}`);
    if (!origin || origin.owned || origin.epoch !== epoch) throw new RoonLibraryError('ROON_LIBRARY_RESPONSE_INVALID', '播放上下文已过期');
    assertContext(origin);
    if ([...detailContexts.values()].filter(value => value.owned).length >= 2) throw new RoonLibraryError('ROON_LIBRARY_REQUEST_FAILED', '活动播放来源预算已满');
    const session = createSession(origin.session.hierarchy, { ...(origin.session.input !== undefined ? { input: origin.session.input } : {}) });
    session.owned = true; session.requiresPathValidation = true;
    // 不重复复制同一不可变路径；frame/root/map共用fork自己的路径材料。
    const clonedPaths = new Map<readonly BrowsePathSegment[], readonly BrowsePathSegment[]>();
    const clonePath = (path: readonly BrowsePathSegment[]) => {
      let copy = clonedPaths.get(path);
      if (!copy) { copy = path.map(segment => ({ ...segment })); clonedPaths.set(path, copy); }
      return copy;
    };
    const frame = (value: DetailFrame): DetailFrame => { const copy = { ...value, path: clonePath(value.path), buffer: value.buffer.map(row => structuredClone(row)), ...(value.buffer.length ? { validateBuffer: true } : {}) }; delete copy.level; return copy; };
    const item = (value: RoonEntityDescriptor): RoonEntityDescriptor => ({ ...value, ...(value.browseContext ? { browseContext: { ...value.browseContext, multiSessionKey: session.multiSessionKey } } : {}) });
    const context: DetailContext = { ...origin, owned: true, abort: new AbortController(), key: `owned\0${randomUUID()}`, epoch: randomUUID(), session, sessionKey: session.multiSessionKey,
      state: { ...origin.state, frames: origin.state.frames.map(frame), groups: origin.state.groups.map(frame), items: origin.state.items.map(item), candidates: origin.state.candidates.map(item) },
      pending: 0, tail: Promise.resolve(), paths: new Set(origin.paths), rootPath: clonePath(origin.rootPath), pathValues: new Map(),
    };
    for (const signature of [...origin.paths, ...origin.rootPath.map(segment => segment.pathSignature)]) {
      const path = pathsBySignature.get(signature);
      if (path) context.pathValues!.set(signature, clonePath(path));
    }
    try {
      reserveDetailMemory(context, context.state, 0);
      while (detailContexts.size >= MAX_DETAIL_CONTEXTS) {
        const idle = [...detailContexts.values()].find(value => value.pending === 0 && !value.owned);
        if (!idle) throw new RoonLibraryError('ROON_LIBRARY_REQUEST_FAILED', '在途详情上下文预算已满');
        forgetContext(idle);
      }
      detailContexts.set(context.key, context);
    }
    catch (error) { sessionsByKey.delete(session.multiSessionKey); throw error; }
    const current = () => detailContexts.get(context.key) === context && context.generation === contextGeneration && context.sessionKey === session.multiSessionKey && context.zone === dependencies.zoneOrOutputId?.();
    const parent = item(entity);
    return {
      isCurrent: current,
      release() { forgetContext(context); },
      async read(request, options) {
        const signal = AbortSignal.any([context.abort!.signal, options.signal]);
        try {
          return await withLibraryRead({ signal, deadlineAtMs: Date.now() + 10_000, now: Date.now, isCurrent: () => current() && options.isCurrent() }, () => incrementalDetail(parent, mode, session, context.rootPath, normalizePage(request), context));
        } catch (error) {
          if (signal.aborted || !options.isCurrent() || error instanceof Error && 'code' in error && (error.code === 'READ_CANCELLED' || error.code === 'READ_DEADLINE')) forgetContext(context);
          throw error;
        }
      },
    };
  };
  const getReadCacheStamp = (selector: RoonReadCacheSelector): string | undefined => {
    // 不调用checkContextZone：缓存检查不得更新代际、会话或权限寿命。
    if (contextZone !== dependencies.zoneOrOutputId?.()) return undefined;
    if (selector.kind === 'root') {
      const epoch = rootEpochs.get(selector.hierarchy), session = rootSessions.get(selector.hierarchy);
      return epoch && session && epoch.sessionKey === session.multiSessionKey ? epoch.epoch : undefined;
    }
    if (selector.kind === 'search') {
      return searchSessions.get(JSON.stringify([selector.resultKind ?? 'track', selector.query.trim()]))?.cacheEpoch;
    }
    const entity = selector.entity, signature = entity.browseContext?.pathSignature;
    const context = signature ? detailContexts.get(`${entity.kind}\0${signature}`) : undefined;
    return context && !context.owned && context.generation === contextGeneration
      && context.sessionKey === context.session.multiSessionKey && context.zone === contextZone ? context.epoch : undefined;
  };
  return {
    getReadCacheStamp,
    invalidateReadContexts,
    captureTrackActions,
    ...(incrementalDetails ? { forkPlaybackContext } : {}),
    browseAlbums: (request, options) => pageFor('albums', 'album', request, options),
    browseArtists: (request, options) => pageFor('artists', 'artist', request, options),
    browseGenres: (request, options) => pageFor('genres', 'genre', request, options),
    browsePlaylists: (request, options) => pageFor('playlists', 'playlist', request, options),
    browseGenre: (genre, request, options) => browseEntityChildren(genre, 'genre', request, options),
    browsePlaylist: (playlist, request, options) => browseEntityChildren(playlist, 'playlist', request, options),
    getArtistImageKey: async (artist) => {
      checkContextZone();
      const imageGeneration = contextGeneration;
      const imageZone = contextZone;
      const { session: sourceSession, path } = entitySessionAndPath(artist, 'artist');
      const signature = path.at(-1)?.pathSignature;
      if (!signature) {
        throw new RoonLibraryError(
          'ROON_LIBRARY_RESPONSE_INVALID',
          'Roon artist image path is unavailable',
        );
      }
      if (artistImageKeysBySignature.has(signature)) {
        const cached = artistImageKeysBySignature.get(signature);
        artistImageKeysBySignature.delete(signature);
        artistImageKeysBySignature.set(signature, cached);
        return cached;
      }
      const existing = pendingArtistImageKeys.get(signature);
      const owner = existing && artistReadOwners.get(existing);
      if (existing && (!owner || (!owner.signal.aborted && owner.isCurrent() && owner.now() < owner.deadlineAtMs))) return existing;
      const imageSession = createSession(sourceSession.hierarchy, {
        register: false,
        ...(sourceSession.input !== undefined ? { input: sourceSession.input } : {}),
      });
      const assertImageOwner = () => {
        assertLibraryReadCurrent();
        if (imageGeneration !== contextGeneration || imageZone !== dependencies.zoneOrOutputId?.()) throw libraryReadCancelled();
      };
      const pending = withArtistImageLookupLane(async () => withSession(imageSession, async () => {
        assertImageOwner();
        await replayStablePath(imageSession, path);
        assertImageOwner();
        const list = currentList(imageSession);
        let imageKey = list.imageKey;
        if (!imageKey && list.count !== 0) {
          const count = Math.min(list.count ?? 8, 8);
          const loaded = readLoadResponse(await requestBrowse('load', {
            hierarchy: imageSession.hierarchy,
            multi_session_key: imageSession.multiSessionKey,
            level: list.level,
            offset: 0,
            count,
          }));
          validateRawPage(loaded, 0, count, list.count);
          assertImageOwner();
          imageKey = loaded.items
            .map((item) => asRecord(item))
            .map((item) => readString(item ?? {}, 'image_key'))
            .find((candidate) => candidate !== undefined);
        }
        assertImageOwner();
        cacheArtistImageKey(signature, imageKey);
        return imageKey;
      })).finally(() => {
        if (pendingArtistImageKeys.get(signature) === pending) pendingArtistImageKeys.delete(signature);
      });
      const read = currentLibraryRead();
      if (read) artistReadOwners.set(pending, read);
      pendingArtistImageKeys.set(signature, pending);
      return pending;
    },
    browseAlbum: async (album, request, options) => {
      const pageRequest = normalizePage(request);
      if (!album.itemKey) {
        throw new RoonLibraryError(
          'ROON_LIBRARY_RESPONSE_INVALID',
          'Roon album has no item key',
        );
      }
      const authorization = authorizeRoonAction({
        title: album.title,
        hint: album.hint,
        item_key: album.itemKey,
      }, { kind: 'browse' });
      if (authorization.itemKey !== album.itemKey) {
        throw new RoonLibraryError('ROON_LIBRARY_RESPONSE_INVALID', 'Roon album key changed');
      }
      const albumContext = album.browseContext;
      if (!albumContext) {
        throw new RoonLibraryError('ROON_LIBRARY_RESPONSE_INVALID', 'Roon album path is unavailable');
      }
      checkContextZone();
      const { session, path } = entitySessionAndPath(album, 'album');
      if (options?.refresh) await refreshSession(session);
      if (incrementalDetails) return incrementalDetail(album, 'album', session, path, pageRequest);
      const cacheKey = albumContext.pathSignature;
      const cached = albumTracksBySignature.get(cacheKey);
      if (cached) {
        const level = cached[0]?.browseContext?.level ?? albumContext.level + 1;
        return pageFromResolvedItems(cached, pageRequest, level);
      }
      return withSession(session, async () => {
        const existing = albumTracksBySignature.get(cacheKey);
        if (existing) {
          const level = existing[0]?.browseContext?.level ?? albumContext.level + 1;
          return pageFromResolvedItems(existing, pageRequest, level);
        }
        const list = await navigateToPath(session, path);
        const tracks = await collectAlbumTracks(session, path, album.imageKey);
        assertLibraryReadCurrent();
        albumTracksBySignature.set(cacheKey, tracks);
        return pageFromResolvedItems(tracks, pageRequest, list.level);
      });
    },
    browseArtist: async (artist, request, options) => {
      const pageRequest = normalizePage(request);
      if (!artist.itemKey) {
        throw new RoonLibraryError(
          'ROON_LIBRARY_RESPONSE_INVALID',
          'Roon artist has no item key',
        );
      }
      const authorization = authorizeRoonAction({
        title: artist.title,
        hint: artist.hint,
        item_key: artist.itemKey,
      }, { kind: 'browse' });
      if (authorization.itemKey !== artist.itemKey) {
        throw new RoonLibraryError('ROON_LIBRARY_RESPONSE_INVALID', 'Roon artist key changed');
      }
      const artistContext = artist.browseContext;
      if (!artistContext) {
        throw new RoonLibraryError('ROON_LIBRARY_RESPONSE_INVALID', 'Roon artist path is unavailable');
      }
      checkContextZone();
      const { session, path } = entitySessionAndPath(artist, 'artist');
      if (options?.refresh) await refreshSession(session);
      if (incrementalDetails) return incrementalDetail(artist, 'artist', session, path, pageRequest);
      const cacheKey = artistContext.pathSignature;
      const cached = artistAlbumsBySignature.get(cacheKey);
      if (cached) {
        const level = cached[0]?.browseContext?.level ?? artistContext.level + 1;
        return pageFromResolvedItems(cached, pageRequest, level);
      }
      return withSession(session, async () => {
        const existing = artistAlbumsBySignature.get(cacheKey);
        if (existing) {
          const level = existing[0]?.browseContext?.level ?? artistContext.level + 1;
          return pageFromResolvedItems(existing, pageRequest, level);
        }
        const list = await navigateToPath(session, path);
        const loadedItems = await loadAllAtLevel(
          session.hierarchy,
          session.multiSessionKey,
          list.level,
          list.count,
          MAX_ARTIST_SCAN_ITEMS,
        );
        const parentReference = path.at(-1)?.pathSignature ?? rootReference(session.hierarchy);
        const albumGroupTitles = new Set([
          'album',
          'albums',
          'discography',
          'releases',
          '专辑',
          '唱片',
          '唱片集',
          '发行',
        ]);
        const groups = loadedItems.flatMap((value, index) => {
          const record = asRecord(value);
          const title = readString(record ?? {}, 'title');
          if (
            readString(record ?? {}, 'hint') !== 'list'
            || !title
            || !albumGroupTitles.has(title.normalize('NFKC').trim().toLocaleLowerCase('en-US'))
          ) {
            return [];
          }
          const segment = readPathSegment(
            value,
            session.hierarchy,
            'container',
            parentReference,
            index,
          );
          return segment ? [segment] : [];
        });
        let scannedItems = loadedItems.length;
        const albums: RoonEntityDescriptor[] = [];
        if (groups.length === 0) {
          albums.push(...mapItems(loadedItems, 'album', session.hierarchy, {
            multiSessionKey: session.multiSessionKey,
            level: list.level,
            parentReference,
            parentPath: path,
            sourceOffset: 0,
            registerPath,
          }).filter((item) => item.itemKey !== undefined && item.hint === 'list'));
        } else {
          for (const group of groups) {
            const groupPath = [...path, group];
            registerPath(group.pathSignature, groupPath);
            const groupList = await navigateToPath(session, groupPath);
            const remaining = MAX_ARTIST_SCAN_ITEMS - scannedItems;
            if (remaining < 1) {
              throw new RoonLibraryError(
                'ROON_LIBRARY_RESPONSE_INVALID',
                'Roon artist results exceed the bounded scan limit',
              );
            }
            const groupItems = await loadAllAtLevel(
              session.hierarchy,
              session.multiSessionKey,
              groupList.level,
              groupList.count,
              remaining,
            );
            scannedItems += groupItems.length;
            albums.push(...mapItems(groupItems, 'album', session.hierarchy, {
              multiSessionKey: session.multiSessionKey,
              level: groupList.level,
              parentReference: group.pathSignature,
              parentPath: groupPath,
              sourceOffset: 0,
              registerPath,
            }).filter((item) => item.itemKey !== undefined && item.hint === 'list'));
          }
        }
        assertLibraryReadCurrent();
        artistAlbumsBySignature.set(cacheKey, albums);
        const resultLevel = albums[0]?.browseContext?.level ?? list.level;
        return pageFromResolvedItems(albums, pageRequest, resultLevel);
      });
    },
    searchLibrary: async (query, request, kind = 'track', options) => {
      const normalizedQuery = query.trim();
      if (normalizedQuery.length === 0 || normalizedQuery.length > 128) {
        throw new RoonLibraryError('ROON_LIBRARY_INVALID_PAGE', 'Roon search query is invalid');
      }
      const pageRequest = normalizePage(request);
      checkContextZone();
      const session = searchSession(normalizedQuery, kind);
      if (options?.refresh) await refreshSession(session);
      const stamp = session.cacheEpoch;
      const stamped = (page: RoonLibraryPage<RoonEntityDescriptor>) => {
        assertLibraryReadCurrent();
        if (session.cacheEpoch !== stamp || contextZone !== dependencies.zoneOrOutputId?.()) throw libraryReadCancelled();
        return { ...page, sourceEpoch: stamp, complete: page.total !== undefined, nextOffset: page.offset + page.items.length };
      };
      const entityPage = kind === 'album' || kind === 'artist' ? searchEntityPage(normalizedQuery, kind, pageRequest) : undefined;
      if (entityPage) return stamped(await entityPage);
      const cache = kind === 'track' ? searchTracksByQuery : kind === 'album' ? searchAlbumsByQuery : searchArtistsByQuery;
      const cached = cache.get(normalizedQuery);
      if (cached) {
        const level = cached[0]?.browseContext?.level ?? 0;
        return stamped(pageFromResolvedItems(cached, pageRequest, level));
      }
      return withSession(session, async () => {
        const existing = cache.get(normalizedQuery);
        if (existing) {
          const level = existing[0]?.browseContext?.level ?? 0;
          return stamped(pageFromResolvedItems(existing, pageRequest, level));
        }
        if (!session.initialized) {
          const response = readBrowseResponse(await requestBrowse('browse', {
            hierarchy: 'search',
            multi_session_key: session.multiSessionKey,
            pop_all: true,
            input: normalizedQuery,
          }));
          applyBrowseState(session, response, []);
          session.rootLevel = response.list.level;
        } else {
          await navigateToPath(session, []);
        }
        const list = currentList(session);
        const loadedItems = await loadAllAtLevel(
          'search',
          session.multiSessionKey,
          list.level,
          list.count,
          MAX_SEARCH_SCAN_ITEMS,
        );
        const parentReference = rootReference('search', normalizedQuery);
        const results: RoonEntityDescriptor[] = kind === 'track'
          ? loadedItems.flatMap((value, index) => {
              const record = asRecord(value);
              if (readString(record ?? {}, 'hint') !== 'action_list') return [];
              const track = readItem(value, 'track', 'search', {
                multiSessionKey: session.multiSessionKey,
                level: list.level,
                parentReference,
                parentPath: [],
                sourceIndex: index,
                registerPath,
              });
              return track?.itemKey ? [track] : [];
            })
          : [];
        let scannedItems = loadedItems.length;
        const groupTitles = kind === 'track'
          ? new Set(['track', 'tracks', 'song', 'songs', '单曲', '曲目', '歌曲'])
          : kind === 'album'
            ? new Set(['album', 'albums', '专辑', '唱片'])
            : new Set(['artist', 'artists', '艺人', '艺术家', '歌手']);
        const groups = loadedItems.flatMap((value, index) => {
          const record = asRecord(value);
          const title = readString(record ?? {}, 'title');
          if (
            readString(record ?? {}, 'hint') !== 'list'
            || !title
            || !groupTitles.has(title.normalize('NFKC').trim().toLocaleLowerCase('en-US'))
          ) {
            return [];
          }
          const segment = readPathSegment(
            value,
            'search',
            'container',
            parentReference,
            index,
          );
          return segment ? [segment] : [];
        });
        for (const group of groups) {
          const groupPath = [group];
          registerPath(group.pathSignature, groupPath);
          const groupList = await navigateToPath(session, groupPath);
          const remaining = MAX_SEARCH_SCAN_ITEMS - scannedItems;
          if (remaining < 1) {
            throw new RoonLibraryError(
              'ROON_LIBRARY_RESPONSE_INVALID',
              'Roon search results exceed the bounded scan limit',
            );
          }
          const groupItems = await loadAllAtLevel(
            'search',
            session.multiSessionKey,
            groupList.level,
            groupList.count,
            remaining,
          );
          scannedItems += groupItems.length;
          for (let index = 0; index < groupItems.length; index += 1) {
            const value = groupItems[index];
            const record = asRecord(value);
            const expectedHint = kind === 'track' ? 'action_list' : 'list';
            if (readString(record ?? {}, 'hint') !== expectedHint) continue;
            const item = readItem(value, kind, 'search', {
              multiSessionKey: session.multiSessionKey,
              level: groupList.level,
              parentReference: group.pathSignature,
              parentPath: groupPath,
              sourceIndex: index,
              registerPath,
            });
            if (item?.itemKey) results.push(item);
          }
        }
        const seenResults = new Set<string>();
        const uniqueResults = results.filter((item) => {
          const identity = createHash('sha256').update([
            item.kind,
            item.itemKey ?? '',
            item.title,
            item.artist ?? item.subtitle ?? '',
            item.album ?? '',
            String(item.discNumber ?? ''),
            String(item.trackNumber ?? ''),
            String(item.durationMs ?? item.durationSeconds ?? ''),
            item.version ?? '',
          ].join('\0')).digest('hex');
          if (seenResults.has(identity)) return false;
          seenResults.add(identity);
          return true;
        });
        assertLibraryReadCurrent();
        cache.set(normalizedQuery, uniqueResults);
        const resultLevel = uniqueResults[0]?.browseContext?.level ?? list.level;
        return stamped(pageFromResolvedItems(uniqueResults, pageRequest, resultLevel));
      });
    },
    getImage: (imageKey, options = {}) => {
      if (imageKey.trim().length === 0 || imageKey.length > 512) {
        return Promise.reject(new RoonLibraryError('ROON_LIBRARY_RESPONSE_INVALID', 'Roon image key is invalid'));
      }
      assertLibraryReadCurrent();
      if (outstandingImages >= 32) return Promise.reject(new RoonLibraryError('ROON_IMAGE_REQUEST_FAILED', '未返回图片请求预算已满'));
      const read = currentLibraryRead();
      const requestOptions = { ...DEFAULT_IMAGE_OPTIONS, ...options };
      validateImageOptions(requestOptions);
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error, result?: RoonImageResult): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout); read?.signal.removeEventListener('abort', cancel);
          if (error) reject(error);
          else if (result) { try { assertLibraryReadCurrent(); resolve(result); } catch (error) { reject(error); } }
        };
        const cancel = (): void => finish(read?.signal.reason instanceof Error && 'code' in read.signal.reason && (read.signal.reason.code === 'READ_CANCELLED' || read.signal.reason.code === 'READ_DEADLINE') ? read.signal.reason : libraryReadCancelled());
        const timeout = setTimeout(() => {
          if (read && read.now() >= read.deadlineAtMs) { finish(libraryReadTimeout()); return; }
          finish(new RoonLibraryError('ROON_IMAGE_REQUEST_FAILED', 'Roon image request timed out'));
        }, remainingLibraryReadMs(requestTimeoutMs));
        read?.signal.addEventListener('abort', cancel, { once: true });
        let returned = false;
        const release = (): void => { if (!returned) { returned = true; outstandingImages--; } };
        outstandingImages++;
        try {
          // 无读取作用域也显式绑定，不能继承共享 SDK 资源上的旧读取。
          dependencies.image.get_image(imageKey, requestOptions, AsyncLocalStorage.bind<Parameters<RoonImageApi['get_image']>[2]>((error, contentType, body) => {
            release();
            try {
              dependencies.onImageShape?.(
                summarizeRoonImageBinary('roon-callback', contentType, body),
              );
            } catch {
              // 诊断回调不得改变图片行为。
            }
            if (error) {
              finish(new RoonLibraryError('ROON_IMAGE_REQUEST_FAILED', 'Roon image request failed'));
              return;
            }
            if (body === undefined || body === null || (Buffer.isBuffer(body) && body.length === 0)) {
              finish(new RoonLibraryError('ROON_IMAGE_UNAVAILABLE', 'Roon image is unavailable'));
              return;
            }
            if (
              typeof contentType !== 'string'
              || !Buffer.isBuffer(body)
              || !isValidRoonImageBinary(contentType, body)
            ) {
              finish(new RoonLibraryError('ROON_IMAGE_DECODE_FAILED', 'Roon image response is not decodable'));
              return;
            }
            finish(undefined, { contentType, body });
          }));
        } catch {
          release();
          finish(new RoonLibraryError('ROON_IMAGE_REQUEST_FAILED', 'Roon image request failed'));
        }
      });
    },
    playTrack: (track, zoneOrOutputId, onDispatch) => runTrackAction(track, zoneOrOutputId, 'play', onDispatch),
    queueTrack: (track, zoneOrOutputId) => runTrackAction(track, zoneOrOutputId, 'queue'),
  };
}
