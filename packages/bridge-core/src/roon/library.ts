import { randomUUID } from 'node:crypto';
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

export interface RoonEntityDescriptor {
  kind: RoonLibraryKind;
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
  searchLibrary(
    query: string,
    request: RoonPageRequest,
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
      | 'ROON_IMAGE_REQUEST_FAILED',
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

const MAX_PAGE_LIMIT = 100;
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

function readItem(value: unknown, kind: RoonLibraryKind): RoonEntityDescriptor | undefined {
  const record = asRecord(value);
  const source = record ?? {};
  const title = readString(source, 'title');
  if (!title) return undefined;

  const subtitle = readString(source, 'subtitle');
  const itemKey = readString(source, 'item_key');
  const imageKey = readString(source, 'image_key');
  const hint = readString(source, 'hint');
  const artist = readString(source, 'artist');
  const album = readString(source, 'album');
  const durationMs = readNumber(source, 'duration_ms');
  const durationSeconds = readNumber(source, 'duration');
  const trackNumber = readNumber(source, 'track_number');
  const discNumber = readNumber(source, 'disc_number');
  const year = readNumber(source, 'year');
  const version = readString(source, 'version');

  const item: RoonEntityDescriptor = {
    kind,
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
  };
  return item;
}

function mapItems(value: readonly unknown[], kind: RoonLibraryKind): RoonEntityDescriptor[] {
  return value
    .map((item) => readItem(item, kind))
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
}): RoonLibraryService {
  const sessionKeys = new Map<string, string>();
  const sessionKeyFor = (hierarchy: string): string => {
    const existing = sessionKeys.get(hierarchy);
    if (existing) return existing;
    const created = `musicbridge-v2-${hierarchy}-${randomUUID()}`;
    sessionKeys.set(hierarchy, created);
    return created;
  };

  const requestBrowse = (
    operation: 'browse' | 'load',
    options: Record<string, unknown>,
  ): Promise<unknown> => new Promise((resolve, reject) => {
    dependencies.browse[operation](options, (error, body) => {
      if (error) {
        reject(new RoonLibraryError('ROON_LIBRARY_REQUEST_FAILED', `Roon ${operation} failed`));
        return;
      }
      resolve(body);
    });
  });

  const pageFor = async (
    hierarchy: string,
    kind: RoonLibraryKind,
    request: RoonPageRequest,
    itemKey?: string,
  ): Promise<RoonLibraryPage<RoonEntityDescriptor>> => {
    const pageRequest = normalizePage(request);
    const multiSessionKey = sessionKeyFor(hierarchy);
    const browseOptions: Record<string, unknown> = {
      hierarchy,
      multi_session_key: multiSessionKey,
      ...(itemKey ? { item_key: itemKey } : { pop_all: true }),
    };
    const browseResponse = readBrowseResponse(await requestBrowse('browse', browseOptions));
    const loadResponse = readLoadResponse(await requestBrowse('load', {
      hierarchy,
      multi_session_key: multiSessionKey,
      level: browseResponse.list.level,
      offset: pageRequest.offset,
      count: pageRequest.limit,
    }));
    const offset = readSafeInteger(loadResponse.offset) ?? pageRequest.offset;
    const items = mapItems(loadResponse.items, kind);
    const total = browseResponse.list.count;
    return {
      items,
      offset,
      level: browseResponse.list.level,
      ...(total !== undefined ? { total, hasMore: offset + items.length < total } : {}),
    };
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

    const hierarchy = 'albums';
    const multiSessionKey = sessionKeyFor(hierarchy);
    const browseResponse = readBrowseResponse(await requestBrowse('browse', {
      hierarchy,
      multi_session_key: multiSessionKey,
      item_key: track.itemKey,
    }));
    if (browseResponse.action !== 'list') {
      throw new RoonLibraryError(
        'ROON_LIBRARY_RESPONSE_INVALID',
        'Roon track action list is unavailable',
      );
    }
    const actionList = readLoadResponse(await requestBrowse('load', {
      hierarchy,
      multi_session_key: multiSessionKey,
      level: browseResponse.list.level,
      offset: 0,
      count: 32,
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
        'ROON_LIBRARY_RESPONSE_INVALID',
        `Roon ${kind} action is unavailable`,
      );
    }
    const authorization = authorizeRoonAction(actionItem, { kind, allowMutation: true });
    const result = asRecord(await requestBrowse('browse', {
      hierarchy,
      multi_session_key: multiSessionKey,
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
  };

  return {
    browseAlbums: (request) => pageFor('albums', 'album', request),
    browseArtists: (request) => pageFor('artists', 'artist', request),
    browseGenres: (request) => pageFor('genres', 'genre', request),
    browsePlaylists: (request) => pageFor('playlists', 'playlist', request),
    browseAlbum: async (album, request) => {
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
      return pageFor('albums', 'track', request, authorization.itemKey);
    },
    browseArtist: async (artist, request) => {
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
      return pageFor('artists', 'album', request, authorization.itemKey);
    },
    searchLibrary: async (query, request) => {
      if (query.trim().length === 0 || query.length > 128) {
        throw new RoonLibraryError('ROON_LIBRARY_INVALID_PAGE', 'Roon search query is invalid');
      }
      const hierarchy = 'search';
      const multiSessionKey = sessionKeyFor(hierarchy);
      const rootBrowse = readBrowseResponse(await requestBrowse('browse', {
        hierarchy,
        multi_session_key: multiSessionKey,
        pop_all: true,
      }));
      const rootLoad = readLoadResponse(await requestBrowse('load', {
        hierarchy,
        multi_session_key: multiSessionKey,
        level: rootBrowse.list.level,
        offset: 0,
        count: MAX_PAGE_LIMIT,
      }));
      const prompt = rootLoad.items
        .map((item) => asRecord(item))
        .find((item) => typeof item?.item_key === 'string' && asRecord(item.input_prompt));
      const promptKey = readString(prompt ?? {}, 'item_key');
      if (!promptKey) {
        throw new RoonLibraryError('ROON_LIBRARY_RESPONSE_INVALID', 'Roon search prompt is missing');
      }
      return pageFor('search', 'track', request, promptKey);
    },
    getImage: (imageKey, options = {}) => {
      if (imageKey.trim().length === 0 || imageKey.length > 512) {
        return Promise.reject(new RoonLibraryError('ROON_LIBRARY_RESPONSE_INVALID', 'Roon image key is invalid'));
      }
      const requestOptions = { ...DEFAULT_IMAGE_OPTIONS, ...options };
      validateImageOptions(requestOptions);
      return new Promise((resolve, reject) => {
        dependencies.image.get_image(imageKey, requestOptions, (error, contentType, body) => {
          if (error || !contentType || !body) {
            reject(new RoonLibraryError('ROON_IMAGE_REQUEST_FAILED', 'Roon image request failed'));
            return;
          }
          resolve({ contentType, body });
        });
      });
    },
    playTrack: (track, zoneOrOutputId) => runTrackAction(track, zoneOrOutputId, 'play'),
    queueTrack: (track, zoneOrOutputId) => runTrackAction(track, zoneOrOutputId, 'queue'),
  };
}
