import * as dto from '@music-bridge/contracts';
import { isLocalAlbumSqlMember } from './mobile-structure.js';
import type { LocalAlbumSqlMobilePage } from './sql-types.js';

/** 原完整 SQL 作者的摘要与成员；封面库存尚待 Owner 回包后重新读取，不进入公开 IPC。 */
export type ArtistIndexCandidatePage = LocalAlbumSqlMobilePage;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object'
  && Object.getPrototypeOf(value) === Object.prototype;
const closed = (value: unknown, fields: readonly string[]): value is Record<string, unknown> => object(value)
  && Reflect.ownKeys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
export function isArtistIndexCandidatePage(value: unknown): value is ArtistIndexCandidatePage {
  try {
    return closed(value, ['revision', 'total', 'items']) && typeof value.revision === 'string'
      && value.revision.length > 0 && value.revision.length <= 1024 && Number.isSafeInteger(value.total)
      && Number(value.total) >= 0 && Number(value.total) <= 300_000 && Array.isArray(value.items)
      && value.items.length <= 100 && value.items.length <= Number(value.total)
      && Buffer.byteLength(JSON.stringify(value)) <= 2 * 1024 * 1024
      && value.items.every(row => closed(row, ['album', 'groupHash', 'artworkSourceRevision', 'member'])
        && dto.isLocalAlbumSummary(row.album) && sha(row.groupHash) && sha(row.artworkSourceRevision)
        && (row.member === null || isLocalAlbumSqlMember(row.member, row.album as unknown as Record<string, unknown>)));
  } catch { return false; }
}
