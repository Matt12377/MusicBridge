import { createHash } from 'node:crypto';
import { mobileDataSnapshot, mobileCatalogResponseSnapshot, mobileCanonicalJson, isMobileId, mobileInteger, type MobileAlbum, type MobileTrack, type MobileJsonValue } from '@music-bridge/contracts';
import { MobileServiceError } from './types.js';

export interface MobileDirectoryArtist { id: string; name: string; source: 'netease'; albumCount: number; trackCount: number; artworkId?: string; biography?: string; credit?: string }
export interface MobileDirectoryQuery { kind: 'tracks' | 'albums' | 'artists'; query: string; artistId: string | null; offset: number; limit: number; expectedRevision: string | null }
export interface MobileDirectoryPage { kind: MobileDirectoryQuery['kind']; items: (MobileTrack | MobileAlbum | MobileDirectoryArtist)[]; offset: number; limit: number; total: number; revision: string; nextOffset: number | null }
const invalid = (): never => { throw new MobileServiceError(400, 'INVALID_REQUEST'); };
const closed = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const numericId = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,31}$/u.test(value);
const label = (value: unknown, maximum: number, empty = false): value is string => typeof value === 'string' && (empty || value.trim().length > 0) && value.length <= maximum && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
function capture(raw: unknown): Record<string, unknown> {
  const snapshot = mobileDataSnapshot(raw, { requestBytes: 16_384, responseBytes: 2 * 1024 * 1024, depth: 20, nodes: 65536, extensionBytes: 2 * 1024 * 1024 });
  if (!snapshot.ok || !snapshot.value || typeof snapshot.value !== 'object' || Array.isArray(snapshot.value)) return invalid();
  return snapshot.value as Record<string, unknown>;
}
export function captureMobileDirectoryQuery(raw: unknown): MobileDirectoryQuery {
  const value = capture(raw);
  if (!closed(value, ['kind','query','artistId','offset','limit','expectedRevision']) || !['tracks','albums','artists'].includes(String(value.kind))
    || !label(value.query, 200, value.artistId !== null) || value.artistId !== null && !numericId(value.artistId)
    || !mobileInteger(value.offset, 0, 300000) || !mobileInteger(value.limit, 1, 100)
    || value.expectedRevision !== null && !isMobileId(value.expectedRevision)) return invalid();
  return { kind: value.kind as MobileDirectoryQuery['kind'], query: value.query, artistId: value.artistId as string | null,
    offset: value.offset as number, limit: value.limit as number, expectedRevision: value.expectedRevision as string | null };
}
export function captureMobileDirectoryPage(raw: unknown, query: MobileDirectoryQuery): MobileDirectoryPage {
  const value = capture(raw);
  if (!closed(value,['kind','items','offset','limit','total','revision','nextOffset']) || value.kind !== query.kind
    || value.offset !== query.offset || value.limit !== query.limit || !mobileInteger(value.total, 0, 300000) || !isMobileId(value.revision)
    || !Array.isArray(value.items) || value.items.length > query.limit || query.offset + value.items.length > Number(value.total)
    || value.nextOffset !== (query.offset + value.items.length < Number(value.total) ? query.offset + value.items.length : null)
    || value.nextOffset !== null && value.items.length === 0
    || query.expectedRevision !== null && value.revision !== query.expectedRevision) return invalid();
  const ids = new Set<string>();
  for (const item of value.items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return invalid();
    const row = item as Record<string, unknown>;
    if (row.source !== 'netease' || !isMobileId(row.id) || ids.has(row.id)) return invalid();
    ids.add(row.id);
    if (query.kind === 'artists') {
      if (Object.keys(row).some(key => !['id','name','source','albumCount','trackCount','artworkId','biography','credit'].includes(key))
        || !numericId(row.id) || !label(row.name, 1024) || !mobileInteger(row.albumCount) || !mobileInteger(row.trackCount)
        || row.biography !== undefined && !label(row.biography, 20000, true) || row.credit !== undefined && row.credit !== '人物资料来自网易云'
        || row.artworkId !== undefined && (!isMobileId(row.artworkId) || !String(row.artworkId).startsWith('naw:'))) return invalid();
    } else {
      const snapshot = mobileCatalogResponseSnapshot(query.kind === 'tracks' ? 'track' : 'album', row);
      const permitted = query.kind === 'tracks' ? ['id','title','artists','albumId','source','sourceItemId','versionId','contentRevision','editionLabel','durationMs','audio','availability','artworkId']
        : ['id','title','artists','source','editionLabel','trackCount','artworkId'];
      if (!snapshot.ok || Object.keys(row).some(key => !permitted.includes(key)) || !row.id.startsWith(query.kind === 'tracks' ? 'nt:' : 'na:')) return invalid();
      if (!label(row.title, 1024) || !label(row.editionLabel, 1024, true) || !Array.isArray(row.artists)
        || row.artists.length < 1 || row.artists.length > 32 || !row.artists.every(name => label(name, 1024))) return invalid();
      if (query.kind === 'tracks') {
        if (!row.audio || typeof row.audio !== 'object' || Array.isArray(row.audio)
          || Object.keys(row.audio).some(key => !['codec','container','sampleRateHz','bitsPerSample','channels','bitrateKbps'].includes(key))) return invalid();
        const audio = row.audio as Record<string, unknown>;
        if (!['unknown','flac','mp3'].includes(String(audio.codec)) || audio.codec !== audio.container) return invalid();
      }

    }
  }
  return value as unknown as MobileDirectoryPage;
}
export const mobileDirectoryFingerprint = (page: MobileDirectoryPage) => createHash('sha256').update(mobileCanonicalJson(page as unknown as MobileJsonValue)).digest('hex');
