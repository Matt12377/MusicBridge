import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type FavoriteKind = 'track' | 'album' | 'artist';

export interface FavoriteEntityDescriptor {
  kind: FavoriteKind;
  title: string;
  subtitle?: string;
  artist?: string;
  album?: string;
  durationMs?: number;
  trackNumber?: number;
  discNumber?: number;
  year?: number;
  version?: string;
}

export interface FavoriteRecord extends FavoriteEntityDescriptor {
  favoriteId: string;
  createdAt: number;
  updatedAt: number;
}

export interface FavoritePage {
  items: readonly FavoriteRecord[];
  offset: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

export interface LocalFavoriteRepository {
  isFavorite(descriptor: FavoriteEntityDescriptor): Promise<boolean>;
  setFavorite(descriptor: FavoriteEntityDescriptor, favorite: boolean): Promise<FavoriteRecord | undefined>;
  listFavorites(kind: FavoriteKind | undefined, page: { offset: number; limit: number }): Promise<FavoritePage>;
}

interface PersistedState {
  version: 1;
  favorites: FavoriteRecord[];
}

const MAX_TITLE_LENGTH = 512;
const MAX_TEXT_LENGTH = 512;
const MAX_FAVORITES = 10_000;

function canonicalDescriptor(descriptor: FavoriteEntityDescriptor): Record<string, unknown> {
  return {
    kind: descriptor.kind,
    title: descriptor.title.trim(),
    ...(descriptor.subtitle !== undefined ? { subtitle: descriptor.subtitle.trim() } : {}),
    ...(descriptor.artist !== undefined ? { artist: descriptor.artist.trim() } : {}),
    ...(descriptor.album !== undefined ? { album: descriptor.album.trim() } : {}),
    ...(descriptor.durationMs !== undefined ? { durationMs: descriptor.durationMs } : {}),
    ...(descriptor.trackNumber !== undefined ? { trackNumber: descriptor.trackNumber } : {}),
    ...(descriptor.discNumber !== undefined ? { discNumber: descriptor.discNumber } : {}),
    ...(descriptor.year !== undefined ? { year: descriptor.year } : {}),
    ...(descriptor.version !== undefined ? { version: descriptor.version.trim() } : {}),
  };
}

function validateDescriptor(descriptor: FavoriteEntityDescriptor): void {
  if (!descriptor || !['track', 'album', 'artist'].includes(descriptor.kind)) {
    throw new TypeError('Invalid favorite kind');
  }
  if (typeof descriptor.title !== 'string' || descriptor.title.trim().length === 0 || descriptor.title.length > MAX_TITLE_LENGTH) {
    throw new TypeError('Invalid favorite title');
  }
  for (const field of ['subtitle', 'artist', 'album', 'version'] as const) {
    const value = descriptor[field];
    if (value !== undefined && (typeof value !== 'string' || value.length > MAX_TEXT_LENGTH)) {
      throw new TypeError('Invalid favorite descriptor');
    }
  }
  for (const field of ['durationMs', 'trackNumber', 'discNumber', 'year'] as const) {
    const value = descriptor[field];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new TypeError('Invalid favorite numeric field');
    }
  }
}

function favoriteId(descriptor: FavoriteEntityDescriptor): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(canonicalDescriptor(descriptor)))
    .digest('hex')
    .slice(0, 32);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`;
}

function cloneRecord(record: FavoriteRecord): FavoriteRecord {
  return { ...record };
}

function isPersistedRecord(value: unknown): value is FavoriteRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const allowedKeys = new Set([
    'kind',
    'title',
    'subtitle',
    'artist',
    'album',
    'durationMs',
    'trackNumber',
    'discNumber',
    'year',
    'version',
    'favoriteId',
    'createdAt',
    'updatedAt',
  ]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) return false;
  if (typeof record.favoriteId !== 'string' || !/^[-0-9a-f]{36}$/u.test(record.favoriteId)) return false;
  if (!['track', 'album', 'artist'].includes(String(record.kind))) return false;
  if (typeof record.title !== 'string' || record.title.trim().length === 0 || record.title.length > MAX_TITLE_LENGTH) return false;
  if (!Number.isSafeInteger(record.createdAt) || !Number.isSafeInteger(record.updatedAt)) return false;
  try {
    validateDescriptor(record as unknown as FavoriteEntityDescriptor);
    return true;
  } catch {
    return false;
  }
}

export function createLocalFavoriteRepository(
  filePath?: string,
  now: () => number = () => Date.now(),
): LocalFavoriteRepository {
  const favorites = new Map<string, FavoriteRecord>();
  let loaded = false;
  let loading: Promise<void> | undefined;

  async function load(): Promise<void> {
    if (loaded) return;
    if (loading) return loading;
    loading = (async () => {
      loaded = true;
      if (!filePath) return;
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
        if (!parsed || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== 1) return;
        const values = (parsed as { favorites?: unknown }).favorites;
        if (!Array.isArray(values)) return;
        for (const value of values.slice(0, MAX_FAVORITES)) {
          if (isPersistedRecord(value)) favorites.set(value.favoriteId, cloneRecord(value));
        }
      } catch {
        // 首次启动或损坏的本地收藏文件都 fail-closed 为“没有收藏”。
      }
    })();
    try {
      await loading;
    } finally {
      loading = undefined;
    }
  }

  async function persist(): Promise<void> {
    if (!filePath) return;
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const state: PersistedState = {
      version: 1,
      favorites: [...favorites.values()].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, MAX_FAVORITES),
    };
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporaryPath, filePath);
  }

  return {
    async isFavorite(descriptor) {
      validateDescriptor(descriptor);
      await load();
      return favorites.has(favoriteId(descriptor));
    },
    async setFavorite(descriptor, favorite) {
      validateDescriptor(descriptor);
      await load();
      const id = favoriteId(descriptor);
      if (!favorite) {
        favorites.delete(id);
        await persist();
        return undefined;
      }
      const timestamp = now();
      const previous = favorites.get(id);
      const normalized = canonicalDescriptor(descriptor) as unknown as FavoriteEntityDescriptor;
      const record: FavoriteRecord = {
        ...normalized,
        favoriteId: id,
        createdAt: previous?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      favorites.set(id, record);
      await persist();
      return cloneRecord(record);
    },
    async listFavorites(kind, page) {
      if (!Number.isSafeInteger(page.offset) || page.offset < 0 || !Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 100) {
        throw new TypeError('Invalid favorite page');
      }
      await load();
      const values = [...favorites.values()]
        .filter((record) => kind === undefined || record.kind === kind)
        .sort((left, right) => right.updatedAt - left.updatedAt || left.favoriteId.localeCompare(right.favoriteId));
      const items = values.slice(page.offset, page.offset + page.limit).map(cloneRecord);
      return {
        items,
        offset: page.offset,
        limit: page.limit,
        total: values.length,
        hasMore: page.offset + items.length < values.length,
      };
    },
  };
}
