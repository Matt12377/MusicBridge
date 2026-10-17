import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { isLocalLibraryTrackDetail, isMobileId, type LocalLibraryTrackDetail } from '@music-bridge/contracts';

export type MobileAlbumIdentity =
  | { kind: 'canonical'; rootId: string; albumKey: string }
  | { kind: 'legacy'; editionId: string };
export type MobileTrackIdentity =
  | { kind: 'canonical'; trackId: string; groupHash: string }
  | { kind: 'legacy'; trackId: string; editionId: string };
export interface MobileArtworkIdentity { albumKey: string; artworkRevisionHash: string }

// 地址只表达身份，不表示该root、组、成员或旧发行已经取得授权或唯一性证明。
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const GROUP_KEY = /^(edition|directory)-([0-9a-f]{64})$/u;
const HEX = /^[0-9a-f]{64}$/u;
const uuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const groupKey = (value: unknown): value is string => typeof value === 'string' && GROUP_KEY.test(value);
const hex = (value: unknown): value is string => typeof value === 'string' && HEX.test(value);
const invalid = (): never => { throw new Error('本地音乐身份参数无效。'); };
const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
function address(value: string): string { return isMobileId(value) ? value : invalid(); }
function compactDataset(datasetId: string): string {
  if (!uuid(datasetId)) return invalid();
  return Buffer.from(datasetId.replaceAll('-', ''), 'hex').toString('base64url');
}
function expandDataset(value: string): string | null {
  if (!/^[A-Za-z0-9_-]{22}$/u.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.byteLength !== 16 || bytes.toString('base64url') !== value) return null;
  const text = bytes.toString('hex');
  const result = `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
  return uuid(result) ? result : null;
}

/** 与原SQL行逐字同算法；不纳入观测、计数、Owner世代或LRU。 */
export function mobileGroupHash(rootId: string, albumKey: string): string {
  if (!uuid(rootId) || !groupKey(albumKey)) return invalid();
  return hash(JSON.stringify([rootId, albumKey]));
}
export function mobileAlbumId(datasetId: string, rootId: string, albumKey: string): string {
  if (!uuid(datasetId) || !uuid(rootId) || !groupKey(albumKey)) return invalid();
  return address(`ma:${datasetId}:${rootId}:${albumKey}`);
}
export function mobileTrackId(datasetId: string, trackId: string, groupHash: string): string {
  if (!uuid(datasetId) || !uuid(trackId) || !hex(groupHash)) return invalid();
  return address(`mt:${datasetId}:${trackId}:${groupHash}`);
}
/** 原SQL封面来源修订按原UTF8字符串散列，不借用显示图或计数的修订。 */
export function mobileArtworkRevisionHash(revision: string): string {
  if (typeof revision !== 'string') return invalid();
  return hash(revision);
}
export function mobileArtworkId(datasetId: string, albumKey: string, artworkSourceRevision: string): string {
  if (!uuid(datasetId) || !groupKey(albumKey) || typeof artworkSourceRevision !== 'string') return invalid();
  const match = GROUP_KEY.exec(albumKey)!;
  const key = `${match[1] === 'edition' ? 'e' : 'd'}${match[2]!}`;
  return address(`mw:${compactDataset(datasetId)}:${key}:${mobileArtworkRevisionHash(artworkSourceRevision)}`);
}

export function parseMobileAlbumId(id: string, datasetId: string): MobileAlbumIdentity | null {
  if (!uuid(datasetId) || !isMobileId(id)) return null;
  const parts = id.split(':');
  if (parts.length === 4 && parts[0] === 'ma' && parts[1] === datasetId && uuid(parts[2]) && groupKey(parts[3]))
    return { kind: 'canonical', rootId: parts[2], albumKey: parts[3] };
  if (parts.length === 3 && parts[0] === 'la' && parts[1] === datasetId && uuid(parts[2]))
    return { kind: 'legacy', editionId: parts[2] };
  return null;
}
export function parseMobileTrackId(id: string, datasetId: string): MobileTrackIdentity | null {
  if (!uuid(datasetId) || !isMobileId(id)) return null;
  const parts = id.split(':');
  if (parts.length !== 4 || parts[1] !== datasetId || !uuid(parts[2])) return null;
  if (parts[0] === 'mt' && hex(parts[3])) return { kind: 'canonical', trackId: parts[2], groupHash: parts[3] };
  if (parts[0] === 'lt' && uuid(parts[3])) return { kind: 'legacy', trackId: parts[2], editionId: parts[3] };
  return null;
}
export function parseMobileArtworkId(id: string, datasetId: string): MobileArtworkIdentity | null {
  if (!uuid(datasetId) || !isMobileId(id)) return null;
  const parts = id.split(':');
  if (parts.length !== 4 || parts[0] !== 'mw' || !parts[1] || expandDataset(parts[1]) !== datasetId
    || !parts[2] || !/^[ed][0-9a-f]{64}$/u.test(parts[2]) || !hex(parts[3])) return null;
  const albumKey = `${parts[2][0] === 'e' ? 'edition' : 'directory'}-${parts[2].slice(1)}`;
  return { albumKey, artworkRevisionHash: parts[3] };
}

/** 保留旧本地内容指纹的数组次序与segment原值；目录地址变化不重造内容版本。 */
export function mobileLocalContentDigest(datasetId: string, detail: LocalLibraryTrackDetail): string {
  try {
    if (!uuid(datasetId) || !isLocalLibraryTrackDetail(detail)) return invalid();
    return hash(JSON.stringify([datasetId, detail.asset.id, detail.asset.fileRevision, detail.track.selectionRevision, detail.track.segment]));
  } catch { return invalid(); }
}
