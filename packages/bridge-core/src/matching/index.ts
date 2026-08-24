import type { RoonLibraryItem } from '@music-bridge/contracts';

export const MATCH_ALGORITHM_VERSION = 'v2-deterministic-1';

export interface LogicalRecording {
  neteaseTrackId: string;
  title: string;
  artists: readonly string[];
  album?: string;
  durationMs?: number;
  version?: string;
}

export type MatchState = 'CONFIRMED' | 'POSSIBLE' | 'REJECTED' | 'NONE' | 'MANUAL';

export interface MatchCandidateScore {
  candidate: RoonLibraryItem;
  score: number;
  evidence: readonly string[];
}

export interface MatchResult {
  state: MatchState;
  confidence: number;
  evidence: readonly string[];
  candidates: readonly MatchCandidateScore[];
  candidate?: RoonLibraryItem;
  algorithmVersion: typeof MATCH_ALGORITHM_VERSION;
}

const VERSION_MARKERS = [
  'live',
  'remix',
  'instrumental',
  'cover',
  'demo',
  'acoustic',
  'karaoke',
  '伴奏',
  '现场',
  '混音',
  '翻唱',
  '演奏',
  '演示',
] as const;

const MAX_CACHE_ENTRIES = 512;

function normalizeText(value: string | undefined): string {
  return (value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[()[\]{}。、，,。:：;；!！?？'"“”‘’·•\-_]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function markerSet(value: string | undefined): Set<string> {
  const normalized = normalizeText(value);
  return new Set(VERSION_MARKERS.filter((marker) => normalized.includes(marker)));
}

function artistMatches(recording: LogicalRecording, candidate: RoonLibraryItem): boolean {
  const candidateArtist = normalizeText(candidate.artist ?? candidate.subtitle);
  if (!candidateArtist) return false;
  return recording.artists.some((artist) => normalizeText(artist) === candidateArtist);
}

function durationScore(recording: LogicalRecording, candidate: RoonLibraryItem): number {
  if (recording.durationMs === undefined || candidate.durationMs === undefined) return 0;
  const difference = Math.abs(recording.durationMs - candidate.durationMs);
  if (difference <= 1_000) return 1;
  if (difference <= 3_000) return 0.75;
  if (difference <= 8_000) return 0.35;
  return 0;
}

function versionRejected(recording: LogicalRecording, candidate: RoonLibraryItem): boolean {
  const recordingMarkers = markerSet(`${recording.title} ${recording.version ?? ''}`);
  const candidateMarkers = markerSet(`${candidate.title} ${candidate.version ?? ''}`);
  if (recordingMarkers.size === 0 && candidateMarkers.size === 0) return false;
  if (recordingMarkers.size === 0) return candidateMarkers.size > 0;
  for (const marker of candidateMarkers) {
    if (!recordingMarkers.has(marker)) return true;
  }
  for (const marker of recordingMarkers) {
    if (!candidateMarkers.has(marker)) return true;
  }
  return false;
}

function scoreCandidate(recording: LogicalRecording, candidate: RoonLibraryItem): MatchCandidateScore {
  const evidence: string[] = [];
  const titleExact = normalizeText(recording.title) === normalizeText(candidate.title);
  if (titleExact) evidence.push('title-exact');
  const artistExact = artistMatches(recording, candidate);
  if (artistExact) evidence.push('artist-exact');
  const albumExact = recording.album !== undefined && normalizeText(recording.album) === normalizeText(candidate.album);
  if (albumExact) evidence.push('album-exact');
  const duration = durationScore(recording, candidate);
  if (duration >= 1) evidence.push('duration-close');
  else if (duration > 0) evidence.push('duration-near');
  const rejected = versionRejected(recording, candidate);
  if (rejected) evidence.push('version-reject');

  const score = rejected
    ? 0
    : (titleExact ? 0.48 : 0) +
      (artistExact ? 0.28 : 0) +
      (albumExact ? 0.14 : 0) +
      duration * 0.1;
  return { candidate, score, evidence };
}

export function matchLogicalRecording(
  recording: LogicalRecording,
  candidates: readonly RoonLibraryItem[],
): MatchResult {
  const scored = candidates
    .filter((candidate) => candidate.kind === 'track')
    .map((candidate) => scoreCandidate(recording, candidate))
    .sort((left, right) => right.score - left.score || left.candidate.reference.localeCompare(right.candidate.reference));
  const rejected = scored.filter((entry) => entry.evidence.includes('version-reject'));
  const usable = scored.filter((entry) => !entry.evidence.includes('version-reject'));
  const top = usable[0];
  if (!top) {
    const firstRejected = rejected[0];
    return {
      state: firstRejected ? 'REJECTED' : 'NONE',
      confidence: 0,
      evidence: firstRejected ? [...firstRejected.evidence] : ['no-candidate'],
      candidates: scored,
      algorithmVersion: MATCH_ALGORITHM_VERSION,
    };
  }
  const second = usable[1];
  const margin = second ? top.score - second.score : top.score;
  const confirmed = top.score >= 0.86 && margin >= 0.2;
  const possible = top.score >= 0.52;
  return {
    state: confirmed ? 'CONFIRMED' : possible ? 'POSSIBLE' : 'NONE',
    confidence: Number(top.score.toFixed(3)),
    evidence: [...top.evidence, ...(second && margin < 0.08 ? ['ambiguous-top-candidates'] : [])],
    candidates: scored,
    ...(confirmed ? { candidate: top.candidate } : {}),
    algorithmVersion: MATCH_ALGORITHM_VERSION,
  };
}

export interface MatchCache {
  get(recording: LogicalRecording): MatchResult | undefined;
  set(recording: LogicalRecording, result: MatchResult): void;
  invalidate(): void;
}

export function createMatchCache(maxEntries = MAX_CACHE_ENTRIES): MatchCache {
  const boundedMax = Number.isSafeInteger(maxEntries) && maxEntries > 0
    ? Math.min(maxEntries, MAX_CACHE_ENTRIES)
    : MAX_CACHE_ENTRIES;
  const entries = new Map<string, MatchResult>();
  return {
    get(recording) {
      const result = entries.get(recording.neteaseTrackId);
      if (!result) return undefined;
      entries.delete(recording.neteaseTrackId);
      entries.set(recording.neteaseTrackId, result);
      return result;
    },
    set(recording, result) {
      entries.delete(recording.neteaseTrackId);
      entries.set(recording.neteaseTrackId, result);
      while (entries.size > boundedMax) {
        const first = entries.keys().next().value;
        if (first === undefined) break;
        entries.delete(first);
      }
    },
    invalidate() {
      entries.clear();
    },
  };
}

export { resolvePlaybackSource } from './playback-resolver.js';
export type {
  PlaybackSourcePolicy,
  ResolvedPlaybackSource,
} from './playback-resolver.js';
