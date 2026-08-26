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
export type RoonSearchResultKind = 'track' | 'album';

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
  durationMs?: number;
  durationSeconds?: number;
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
}

export interface RoonImageResult {
  contentType: string;
  body: Buffer;
}

export interface RoonLibraryService {
  browseAlbums(request: RoonPageRequest): Promise<RoonLibraryPage<RoonEntityDescriptor>>;
  browseArtists(request: RoonPageRequest): Promise<RoonLibraryPage<RoonEntityDescriptor>>;
  browseGenres(request: RoonPageRequest): Promise<RoonLibraryPage<RoonEntityDescriptor>>;
  browsePlaylists(request: RoonPageRequest): Promise<RoonLibraryPage<RoonEntityDescriptor>>;
  browseAlbum(
    album: RoonEntityDescriptor,
    request: RoonPageRequest,
  ): Promise<RoonLibraryPage<RoonEntityDescriptor>>;
  browseArtist(
    artist: RoonEntityDescriptor,
    request: RoonPageRequest,
  ): Promise<RoonLibraryPage<RoonEntityDescriptor>>;
  browseGenre(
    genre: RoonEntityDescriptor,
    request: RoonPageRequest,
  ): Promise<RoonLibraryPage<RoonEntityDescriptor>>;
  browsePlaylist(
    playlist: RoonEntityDescriptor,
    request: RoonPageRequest,
  ): Promise<RoonLibraryPage<RoonEntityDescriptor>>;
  searchLibrary(
    query: string,
    request: RoonPageRequest,
    kind?: RoonSearchResultKind,
  ): Promise<RoonLibraryPage<RoonEntityDescriptor>>;
  getImage(imageKey: string, options?: RoonImageOptions): Promise<RoonImageResult>;
  playTrack(track: RoonEntityDescriptor, zoneOrOutputId: string): Promise<void>;
  queueTrack(track: RoonEntityDescriptor, zoneOrOutputId: string): Promise<void>;
}

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

interface BrowseSessionState {
  hierarchy: RoonBrowseHierarchy;
  multiSessionKey: string;
  input?: string;
  initialized: boolean;
  rootLevel?: number;
  currentLevel?: number;
  currentCount?: number;
  currentPath: BrowsePathSegment[];
  tail: Promise<void>;
}

export interface RoonBrowseShapeSummary {
  operation: 'browse' | 'load';
  hierarchy: RoonBrowseHierarchy | 'unknown';
  bodyType: string;
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
  const level = readSafeInteger(list?.level);
  if (level === undefined) {
    throw new RoonLibraryError(
      'ROON_LIBRARY_RESPONSE_INVALID',
      'Roon Browse response has no valid level',
    );
  }
  const count = readSafeInteger(list?.count);
  const action = readString(body ?? {}, 'action');
  return {
    list: { level, ...(count !== undefined ? { count } : {}) },
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
}): RoonLibraryService {
  const requestTimeoutMs = dependencies.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
    throw new TypeError('Roon library timeout is invalid');
  }
  const newSessionKey = (hierarchy: RoonBrowseHierarchy): string =>
    `musicbridge-v2-${hierarchy}-${randomUUID()}`;
  const sessionsByKey = new Map<string, BrowseSessionState>();
  const rootSessions = new Map<RoonBrowseHierarchy, BrowseSessionState>();
  const searchSessions = new Map<string, BrowseSessionState>();
  const pathsBySignature = new Map<string, readonly BrowsePathSegment[]>();
  const albumTracksBySignature = new Map<string, readonly RoonEntityDescriptor[]>();
  const artistAlbumsBySignature = new Map<string, readonly RoonEntityDescriptor[]>();
  const genreItemsBySignature = new Map<string, readonly RoonEntityDescriptor[]>();
  const playlistTracksBySignature = new Map<string, readonly RoonEntityDescriptor[]>();
  const searchTracksByQuery = new Map<string, readonly RoonEntityDescriptor[]>();
  const searchAlbumsByQuery = new Map<string, readonly RoonEntityDescriptor[]>();

  const createSession = (
    hierarchy: RoonBrowseHierarchy,
    options: { register?: boolean; input?: string } = {},
  ): BrowseSessionState => {
    const session: BrowseSessionState = {
      hierarchy,
      multiSessionKey: newSessionKey(hierarchy),
      ...(options.input !== undefined ? { input: options.input } : {}),
      initialized: false,
      currentPath: [],
      tail: Promise.resolve(),
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
  const searchSession = (query: string): BrowseSessionState => {
    const existing = searchSessions.get(query);
    if (existing) return existing;
    const created = createSession('search', { input: query });
    searchSessions.set(query, created);
    return created;
  };
  const registerPath = (
    pathSignature: string,
    path: readonly BrowsePathSegment[],
  ): void => {
    pathsBySignature.set(pathSignature, path);
  };
  const withSession = <T>(
    session: BrowseSessionState,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const result = session.tail.then(operation, operation);
    session.tail = result.then(() => undefined, () => undefined);
    return result;
  };

  const requestBrowse = (
    operation: 'browse' | 'load',
    options: Record<string, unknown>,
  ): Promise<unknown> => new Promise((resolve, reject) => {
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
    const finish = (error?: Error, body?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(body);
    };
    const timeout = setTimeout(() => {
      finish(new RoonLibraryError(
        'ROON_LIBRARY_REQUEST_FAILED',
        `Roon ${operation} timed out`,
      ));
    }, requestTimeoutMs);
    try {
      dependencies.browse[operation](requestOptions, (error, body) => {
        try {
          dependencies.onBrowseShape?.(summarizeRoonBrowsePayload(operation, requestOptions, body));
        } catch {
          // 诊断回调不得改变 Browse 行为。
        }
        if (error) {
          finish(new RoonLibraryError('ROON_LIBRARY_REQUEST_FAILED', `Roon ${operation} failed`));
          return;
        }
        finish(undefined, body);
      });
    } catch {
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
    session.initialized = true;
    session.currentLevel = response.list.level;
    if (response.list.count === undefined) delete session.currentCount;
    else session.currentCount = response.list.count;
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
    const path = pathsBySignature.get(context.pathSignature);
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
      const nextPath = targetPath.slice(0, index + 1);
      const response = readBrowseResponse(await requestBrowse('browse', {
        hierarchy: session.hierarchy,
        multi_session_key: session.multiSessionKey,
        item_key: segment.itemKey,
      }));
      applyBrowseState(session, response, nextPath);
    }
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
  ): Promise<RoonLibraryPage<RoonEntityDescriptor>> => {
    const pageRequest = normalizePage(request);
    const session = rootSession(hierarchy);
    return withSession(session, async () => {
      const list = await ensureRoot(session);
      const loaded = readLoadResponse(await requestBrowse('load', {
        hierarchy,
        multi_session_key: session.multiSessionKey,
        level: list.level,
        offset: pageRequest.offset,
        count: pageRequest.limit,
      }));
      const offset = readSafeInteger(loaded.offset) ?? pageRequest.offset;
      const items = mapItems(loaded.items, kind, hierarchy, {
        multiSessionKey: session.multiSessionKey,
        level: list.level,
        parentReference: rootReference(hierarchy),
        parentPath: [],
        sourceOffset: offset,
        registerPath,
      }).filter((item) => item.itemKey !== undefined && item.hint === 'list');
      return {
        items,
        offset,
        level: list.level,
        ...(list.count !== undefined
          ? { total: list.count, hasMore: offset + loaded.items.length < list.count }
          : {}),
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
    const { session, path } = entitySessionAndPath(entity, expectedKind);
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
  ): Promise<void> => {
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
    const { session: sourceSession, path } = entitySessionAndPath(track, 'track');
    const segment = path.at(-1);
    if (!segment) {
      throw new RoonLibraryError('ROON_LIBRARY_RESPONSE_INVALID', 'Roon track path is unavailable');
    }
    const parentPath = path.slice(0, -1);
    const actionSession = createSession(sourceSession.hierarchy, {
      register: false,
      ...(sourceSession.input !== undefined ? { input: sourceSession.input } : {}),
    });
    await withSession(actionSession, async () => {
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
      const result = asRecord(await requestBrowse('browse', {
        hierarchy: actionSession.hierarchy,
        multi_session_key: actionSession.multiSessionKey,
        item_key: authorization.itemKey,
        zone_or_output_id: zoneOrOutputId,
      }));
      const resultAction = readString(result ?? {}, 'action');
      if (!resultAction) {
        throw new RoonLibraryError(
          'ROON_LIBRARY_RESPONSE_INVALID',
          `Roon ${kind} action response is invalid`,
        );
      }
      if (resultAction === 'message') {
        throw new RoonLibraryError(
          'ROON_LIBRARY_REQUEST_FAILED',
          `Roon ${kind} action returned a message`,
        );
      }
    });
  };

  return {
    browseAlbums: (request) => pageFor('albums', 'album', request),
    browseArtists: (request) => pageFor('artists', 'artist', request),
    browseGenres: (request) => pageFor('genres', 'genre', request),
    browsePlaylists: (request) => pageFor('playlists', 'playlist', request),
    browseGenre: (genre, request) => browseEntityChildren(genre, 'genre', request),
    browsePlaylist: (playlist, request) => browseEntityChildren(playlist, 'playlist', request),
    browseAlbum: async (album, request) => {
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
      const { session, path } = entitySessionAndPath(album, 'album');
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
        albumTracksBySignature.set(cacheKey, tracks);
        return pageFromResolvedItems(tracks, pageRequest, list.level);
      });
    },
    browseArtist: async (artist, request) => {
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
      const { session, path } = entitySessionAndPath(artist, 'artist');
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
        artistAlbumsBySignature.set(cacheKey, albums);
        const resultLevel = albums[0]?.browseContext?.level ?? list.level;
        return pageFromResolvedItems(albums, pageRequest, resultLevel);
      });
    },
    searchLibrary: async (query, request, kind = 'track') => {
      const normalizedQuery = query.trim();
      if (normalizedQuery.length === 0 || normalizedQuery.length > 128) {
        throw new RoonLibraryError('ROON_LIBRARY_INVALID_PAGE', 'Roon search query is invalid');
      }
      const pageRequest = normalizePage(request);
      const cache = kind === 'track' ? searchTracksByQuery : searchAlbumsByQuery;
      const cached = cache.get(normalizedQuery);
      if (cached) {
        const level = cached[0]?.browseContext?.level ?? 0;
        return pageFromResolvedItems(cached, pageRequest, level);
      }
      const session = searchSession(normalizedQuery);
      return withSession(session, async () => {
        const existing = cache.get(normalizedQuery);
        if (existing) {
          const level = existing[0]?.browseContext?.level ?? 0;
          return pageFromResolvedItems(existing, pageRequest, level);
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
          : new Set(['album', 'albums', '专辑', '唱片']);
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
        cache.set(normalizedQuery, uniqueResults);
        const resultLevel = uniqueResults[0]?.browseContext?.level ?? list.level;
        return pageFromResolvedItems(uniqueResults, pageRequest, resultLevel);
      });
    },
    getImage: (imageKey, options = {}) => {
      if (imageKey.trim().length === 0 || imageKey.length > 512) {
        return Promise.reject(new RoonLibraryError('ROON_LIBRARY_RESPONSE_INVALID', 'Roon image key is invalid'));
      }
      const requestOptions = { ...DEFAULT_IMAGE_OPTIONS, ...options };
      validateImageOptions(requestOptions);
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error, result?: RoonImageResult): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (error) reject(error);
          else if (result) resolve(result);
        };
        const timeout = setTimeout(() => {
          finish(new RoonLibraryError('ROON_IMAGE_REQUEST_FAILED', 'Roon image request timed out'));
        }, requestTimeoutMs);
        try {
          dependencies.image.get_image(imageKey, requestOptions, (error, contentType, body) => {
            try {
              dependencies.onImageShape?.(
                summarizeRoonImageBinary('roon-callback', contentType, body),
              );
            } catch {
              // 诊断回调不得改变图片行为。
            }
            if (
              error
              || typeof contentType !== 'string'
              || !Buffer.isBuffer(body)
              || !isValidRoonImageBinary(contentType, body)
            ) {
              finish(new RoonLibraryError('ROON_IMAGE_REQUEST_FAILED', 'Roon image request failed'));
              return;
            }
            finish(undefined, { contentType, body });
          });
        } catch {
          finish(new RoonLibraryError('ROON_IMAGE_REQUEST_FAILED', 'Roon image request failed'));
        }
      });
    },
    playTrack: (track, zoneOrOutputId) => runTrackAction(track, zoneOrOutputId, 'play'),
    queueTrack: (track, zoneOrOutputId) => runTrackAction(track, zoneOrOutputId, 'queue'),
  };
}
