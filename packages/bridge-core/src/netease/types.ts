import type {
  AlbumDetail,
  Page,
  PageRequest,
  DailyRecommendationsSnapshot,
  ArtistDetail,
  ArtistSummary,
  AlbumSummary,
  PlaylistDetail,
  PlaylistSummary,
  TrackSummary,
  PublicAccountProfile,
} from '@music-bridge/contracts';
import type { LyricsSnapshot } from '@music-bridge/contracts';

export const QUALITY_LEVELS = [
  'standard',
  'exhigh',
  'lossless',
  'hires',
] as const;

export type QualityLevel = (typeof QUALITY_LEVELS)[number];

export type CredentialVerificationStatus = 'authorized' | 'expired' | 'unavailable';

export interface NeteaseRequestOptions {
  signal?: AbortSignal;
  priority?: 'playback' | 'background';
  /** 排队等待与实际请求各自的期限，均不超过10秒；音频服务准备另有同样的等待期限。 */
  timeoutMs?: number;
}

export type TransportSecurity = 'https-native' | 'https-upgraded';

export interface TrackMetadata {
  id: string;
  title: string;
  artists: string[];
  album: string;
  durationMs?: number;
  version?: string;
  artworkUrl?: string;
}

export type {
  AlbumSummary,
  AlbumDetail,
  DailyRecommendationsSnapshot,
  ArtistSummary,
  ArtistDetail,
  Page,
  PageRequest,
  PlaylistDetail,
  PlaylistSummary,
  PublicAccountProfile,
  TrackSummary,
};

export interface ResolvedAudioStream {
  trackId: string;
  upstreamUrl: string;
  requestedQuality: QualityLevel;
  transportSecurity?: TransportSecurity;
  actualQuality: string;
  format?: string;
  bitrate?: number;
  sizeBytes?: number;
  expiresInSeconds?: number;
  requestHeaders?: Record<string, string>;
}

export interface NeteasePort {
  readonly configured: boolean;
  getTrack(trackId: string, options?: NeteaseRequestOptions): Promise<TrackMetadata>;
  resolveStream(
    trackId: string,
    quality: QualityLevel,
    options?: NeteaseRequestOptions,
  ): Promise<ResolvedAudioStream>;
  searchTracks(query: string, page: PageRequest): Promise<Page<TrackSummary>>;
  searchArtists(query: string, page: PageRequest): Promise<Page<ArtistSummary>>;
  searchAlbums(query: string, page: PageRequest): Promise<Page<AlbumSummary>>;
  getArtist(artistId: string, page: PageRequest): Promise<import('@music-bridge/contracts').ArtistDetail>;
  getAlbum(albumId: string, page: PageRequest): Promise<import('@music-bridge/contracts').AlbumDetail>;
  getLikedTracks(page: PageRequest): Promise<Page<TrackSummary>>;
  isTrackLiked(trackId: string): Promise<{ liked: boolean }>;
  likeTrack(trackId: string, liked: boolean): Promise<{ liked: boolean }>;
  getUserPlaylists(): Promise<readonly PlaylistSummary[]>;
  getPlaylist(playlistId: string, page: PageRequest): Promise<PlaylistDetail>;
  getPublicAccountProfile(): Promise<PublicAccountProfile>;
  getDailyRecommendations(): Promise<DailyRecommendationsSnapshot>;
  getLyrics?(trackId: string, options?: NeteaseRequestOptions): Promise<LyricsSnapshot>;
}
