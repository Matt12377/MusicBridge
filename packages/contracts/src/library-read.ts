import type { IpcCommandPayloads, IpcCommandResults, LibraryReadContext } from './ipc.js';

/** 取消协议只允许纯读取；写操作与未知写入回执保持原合同。 */
export const LIBRARY_READ_COMMANDS = [
  'library.search', 'library.searchArtists', 'library.searchAlbums', 'library.artist',
  'library.album', 'library.liked', 'library.likeStatus', 'library.match',
  'library.aggregateSearch', 'library.playlists', 'library.playlist', 'library.dailyRecommendations',
  'roon.library.albums', 'roon.library.artists', 'roon.library.genres', 'roon.library.playlists',
  'roon.library.album', 'roon.library.artist', 'roon.library.genre', 'roon.library.playlist',
  'roon.library.search', 'roon.library.image', 'favorites.list', 'favorites.check',
] as const;
export type LibraryReadCommand = typeof LIBRARY_READ_COMMANDS[number];
export function isLibraryReadCommand(value: unknown): value is LibraryReadCommand {
  return typeof value === 'string' && (LIBRARY_READ_COMMANDS as readonly string[]).includes(value);
}
export type { LibraryReadContext } from './ipc.js';
export interface LibraryReadRequest<C extends LibraryReadCommand = LibraryReadCommand> {
  id: string;
  command: C;
  payload: IpcCommandPayloads[C];
  deadlineAtMs: number;
  /** 仅刷新纯读取，不授予 scope 或写入权限。 */
  cacheMode?: 'reload';
}
export interface LibraryReadPublicApi {
  readLibrary<C extends LibraryReadCommand>(request: LibraryReadRequest<C>): Promise<IpcCommandResults[C]>;
  cancelLibraryRead(id: string): Promise<void>;
}
export interface LibraryReadCancel { version: 1; kind: 'library.read.cancel'; id: string }
export function isLibraryReadCancel(value: unknown): value is LibraryReadCancel {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).length === 3 && v.version === 1 && v.kind === 'library.read.cancel'
    && typeof v.id === 'string' && v.id.trim().length > 0 && v.id.length <= 128;
}
export function isLibraryReadContext(value: unknown): value is LibraryReadContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).every(key => key === 'deadlineAtMs' || key === 'cacheMode')
    && Number.isSafeInteger(v.deadlineAtMs) && (v.deadlineAtMs as number) > 0
    && (v.cacheMode === undefined || v.cacheMode === 'reload');
}
