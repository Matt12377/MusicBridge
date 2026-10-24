import { LOCAL_METADATA_TEXT_FIELDS, LOCAL_METADATA_ARTIST_FIELDS, isLocalMetadata, type LocalMetadata } from '@music-bridge/contracts';

/** JSON数组只解码SQLite固定投影；不把任意分隔符解释为姓名边界。 */
export function readProjectedLocalMetadata(row: Record<string, unknown>, prefix: 'raw' | 'effective'): LocalMetadata {
  const result: LocalMetadata = {};
  for (const key of LOCAL_METADATA_TEXT_FIELDS) if (typeof row[`${prefix}_${key}`] === 'string') result[key] = row[`${prefix}_${key}`] as string;
  for (const key of LOCAL_METADATA_ARTIST_FIELDS) {
    const value = row[`${prefix}_${key}`];
    if (value === null || value === undefined) continue;
    if (typeof value !== 'string') throw new Error('艺人元数据投影无效。');
    result[key] = JSON.parse(value) as string[];
  }
  if (!isLocalMetadata(result)) throw new Error('艺人元数据投影无效。');
  return result;
}

/** 优先使用标签明确的多人数组；兼容旧库的单值，不猜拆AC/DC、乐团或含标点的姓名。 */
export function localMetadataArtists(metadata: LocalMetadata, role: 'track' | 'album' = 'track'): string[] {
  const explicit = role === 'album' ? metadata.albumArtists : metadata.artists;
  const scalar = role === 'album' ? metadata.albumArtist : metadata.artist;
  const values = explicit ?? (scalar?.trim() ? [scalar] : []);
  const seen = new Set<string>();
  return values.map(value => value.normalize('NFKC').trim().replace(/\s+/gu, ' ')).filter(value => {
    const key = value.toLocaleLowerCase('und');
    if (!value || seen.has(key)) return false;
    seen.add(key); return true;
  });
}
