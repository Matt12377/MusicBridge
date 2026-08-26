import type {
  RoonLibraryItem,
  RoonLibraryPage,
} from '@music-bridge/contracts';
import { matchLogicalRecording } from './index.js';
import type { LogicalRecording, MatchResult } from './types.js';

const SEARCH_LIMIT = 20;
const ALBUM_CANDIDATE_LIMIT = 3;
const ALBUM_TRACK_LIMIT = 100;

export interface RoonMatchCandidateLibrary {
  searchLibrary(
    query: string,
    request: { offset: number; limit: number },
    kind?: 'track' | 'album',
  ): Promise<RoonLibraryPage>;
  browseAlbum(
    reference: string,
    request: { offset: number; limit: number },
  ): Promise<RoonLibraryPage>;
}

function normalizeIdentityText(value: string | undefined): string {
  return (value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[()[\]{}。、，,。:：;；!！?？'"“”‘’·•\-_]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function hasUsableAlbum(value: string | undefined): value is string {
  const normalized = normalizeIdentityText(value);
  return normalized.length > 0
    && normalized !== 'unknown album'
    && normalized !== '未知专辑';
}

function matchRank(result: MatchResult): number {
  switch (result.state) {
    case 'CONFIRMED': return 4;
    case 'MANUAL': return 3;
    case 'POSSIBLE': return 2;
    case 'REJECTED': return 1;
    case 'NONE': return 0;
  }
}

function strongerResult(left: MatchResult, right: MatchResult): MatchResult {
  const rankDifference = matchRank(right) - matchRank(left);
  if (rankDifference > 0) return right;
  if (rankDifference < 0) return left;
  return right.confidence > left.confidence ? right : left;
}

/**
 * 先使用真实 Search → Tracks；字段不足时才进入 Search → Albums → Album Tracks。
 * Album Tracks 的专辑名来自已打开的专辑实体，不从含义不稳定的 subtitle 猜测。
 */
export async function resolveRoonMatch(
  recording: LogicalRecording,
  library: RoonMatchCandidateLibrary,
): Promise<MatchResult> {
  const primaryArtist = recording.artists[0] ?? '';
  const trackQuery = `${primaryArtist} ${recording.title}`.trim();
  const directPage = await library.searchLibrary(
    trackQuery,
    { offset: 0, limit: SEARCH_LIMIT },
    'track',
  );
  const directResult = matchLogicalRecording(recording, directPage.items);
  if (directResult.state === 'CONFIRMED' || !hasUsableAlbum(recording.album)) {
    return directResult;
  }

  const albumQuery = `${primaryArtist} ${recording.album}`.trim();
  try {
    const albumPage = await library.searchLibrary(
      albumQuery,
      { offset: 0, limit: SEARCH_LIMIT },
      'album',
    );
    const normalizedAlbum = normalizeIdentityText(recording.album);
    const exactAlbums = albumPage.items
      .filter((item) => item.kind === 'album' && normalizeIdentityText(item.title) === normalizedAlbum)
      .slice(0, ALBUM_CANDIDATE_LIMIT);
    const albumTracks: RoonLibraryItem[] = [];
    for (const album of exactAlbums) {
      try {
        const page = await library.browseAlbum(album.reference, {
          offset: 0,
          limit: ALBUM_TRACK_LIMIT,
        });
        for (const item of page.items) {
          if (item.kind !== 'track') continue;
          albumTracks.push(item.album
            ? item
            : { ...item, album: album.title });
        }
      } catch {
        // 单个专辑候选失效时继续检查其余有界候选；直接 Search 结果仍可回退。
      }
    }
    if (albumTracks.length === 0) return directResult;
    const albumResult = matchLogicalRecording(recording, albumTracks);
    return strongerResult(directResult, albumResult);
  } catch {
    return directResult;
  }
}
