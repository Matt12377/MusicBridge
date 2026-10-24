import * as dto from '@music-bridge/contracts';
import { isLocalAlbumPrivateRelative } from './grouping.js';
import type { LocalAlbumGroupMember } from './types.js';

/** 仅结构作者的候选；歌词、库存状态与公开专辑修订始终由原 Owner 处理。 */
export interface MobileStructureAlbum {
  id: string; rootId: string; editionId: string | null; title: string; artists: readonly string[];
  versionLabel: string | null; trackCount: number; representativeTrackId: string | null;
}
export interface MobileStructureRow {
  album: MobileStructureAlbum; groupHash: string; artworkSourceRevision: string;
  structureRevision: string; sourceHasArtwork: boolean; online: boolean;
  member: LocalAlbumGroupMember | null;
}
export interface MobileStructurePage { revision: string; total: number; items: readonly MobileStructureRow[] }
/** 已由 Owner 当前同步库存帧补齐，仍不是 LocalAlbumSummary。 */
export interface MobileProjectionRow extends Omit<MobileStructureRow, 'album'> {
  album: MobileStructureAlbum & { artworkState: dto.LocalAlbumSummary['artworkState'] };
}
export interface MobileProjectionPage { revision: string; total: number; items: readonly MobileProjectionRow[] }

const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const closed = (v: unknown, keys: readonly string[]): v is Record<string, unknown> => object(v)
  && Reflect.ownKeys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));

const natural = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
/** 两个私有只读作者共用原成员资格校验，不扩展移动结构页闭集。 */
export function isLocalAlbumSqlMember(value: unknown, album: Record<string, unknown>): value is LocalAlbumGroupMember {
  if (!closed(value, ['fact', 'disc', 'trackNumber', 'sequence', 'editionLink', 'statuses'])
    || !object(value.fact) || ![5, 6].includes(Reflect.ownKeys(value.fact).length)) return false;
  const fact = value.fact;
  if (!['relative', 'summary', 'rawMetadata', 'hasArtwork', 'artworkRevision'].every(key => Object.hasOwn(fact, key))
    || Reflect.ownKeys(fact).some(key => typeof key !== 'string' || !['relative', 'summary', 'rawMetadata', 'hasArtwork', 'artworkRevision', 'artworkState'].includes(key))
    || !isLocalAlbumPrivateRelative(fact.relative) || !dto.isLocalLibraryTrackSummary(fact.summary)
    || fact.summary.asset.libraryRootId !== album.rootId || !dto.isLocalMetadata(fact.rawMetadata)
    || typeof fact.hasArtwork !== 'boolean' || !(fact.artworkRevision === null || typeof fact.artworkRevision === 'string' && fact.artworkRevision.length > 0 && fact.artworkRevision.length <= 1024)
    || Object.hasOwn(fact, 'artworkState') && (!['available', 'missing', 'unknown', 'source-unavailable'].includes(String(fact.artworkState)) || fact.hasArtwork !== (fact.artworkState === 'available'))) return false;
  if (!(value.disc === null || natural(value.disc)) || !(value.trackNumber === null || natural(value.trackNumber)) || !natural(value.sequence)
    || !Array.isArray(value.statuses) || value.statuses.length > dto.LOCAL_ALBUM_STATUSES.length
    || value.statuses.some(status => !(dto.LOCAL_ALBUM_STATUSES as readonly unknown[]).includes(status)) || new Set(value.statuses).size !== value.statuses.length) return false;
  return value.editionLink === null ? album.editionId === null : closed(value.editionLink, ['id', 'editionId', 'trackId', 'disc', 'trackNumber', 'sequence', 'revision', 'active'])
    && dto.isAlbumEditionTrack(value.editionLink) && value.editionLink.active
    && value.editionLink.editionId === album.editionId && value.editionLink.trackId === fact.summary.track.id;
}
export function isMobileStructurePage(value: unknown): value is MobileStructurePage {
  try {
    if (!closed(value, ['revision', 'total', 'items']) || typeof value.revision !== 'string' || value.revision.length === 0 || value.revision.length > 1024
      || !natural(value.total) || value.total > 300_000 || !Array.isArray(value.items) || value.items.length > 100
      || value.items.length > value.total || Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 * 1024) return false;
    return value.items.every(row => {
      if (!closed(row, ['album', 'groupHash', 'artworkSourceRevision', 'structureRevision', 'sourceHasArtwork', 'online', 'member'])
        || !closed(row.album, ['id', 'rootId', 'editionId', 'title', 'artists', 'versionLabel', 'trackCount', 'representativeTrackId'])) return false;
      const album = row.album;
      return typeof album.id === 'string' && album.id.length > 0 && album.id.length <= 256 && dto.isCollectionId(album.rootId)
        && (album.editionId === null || dto.isCollectionId(album.editionId)) && dto.isLocalCatalogText(album.title)
        && Array.isArray(album.artists) && album.artists.length <= 64 && album.artists.every(v => dto.isLocalCatalogText(v))
        && (album.versionLabel === null || dto.isLocalCatalogText(album.versionLabel)) && natural(album.trackCount) && album.trackCount <= 300_000
        && (album.representativeTrackId === null || dto.isCollectionId(album.representativeTrackId))
        && sha(row.groupHash) && sha(row.artworkSourceRevision) && sha(row.structureRevision)
        && typeof row.sourceHasArtwork === 'boolean' && typeof row.online === 'boolean'
        && (row.member === null || isLocalAlbumSqlMember(row.member, album));
    });
  } catch { return false; }
}
