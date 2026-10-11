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

/** 仅可信移动适配器可用；调用者不能传 Cookie、URL、代理或任意 SDK 方法名。 */
export type NeteaseMobileReadRequest =
  | { operation: 'song-detail'; ids: readonly string[] }
  | { operation: 'album' | 'playlist-detail' | 'lyrics'; id: string }
  | { operation: 'user-playlists'; userId: string; offset: number; limit: number }
  | { operation: 'daily' | 'charts' | 'personal-fm' }
  | { operation: 'recommended-playlists'; limit: number }
  | { operation: 'new-albums'; offset: number; limit: number }
  | { operation: 'stream'; id: string; quality: QualityLevel };
export interface NeteaseMobileAccountSnapshot { readonly accountId: string; readonly providerEpoch: string }
export interface NeteaseMobileRawSnapshot { readonly providerEpoch: string; readonly response: unknown }
export interface NeteaseMobileAccountInvalidation { readonly previousProviderEpoch: string; readonly nextProviderEpoch: string }
/** 与原 NeteasePort 分开，旧 Roon/录音的测试端口不被要求制造移动事实。 */
export interface NeteaseMobileReadPort {
  readonly configured: boolean;
  mobileAccount(options?: NeteaseRequestOptions): Promise<NeteaseMobileAccountSnapshot>;
  mobileRead(request: NeteaseMobileReadRequest, options?: NeteaseRequestOptions): Promise<NeteaseMobileRawSnapshot>;
  onMobileAccountInvalidated(listener: (event: NeteaseMobileAccountInvalidation) => void): () => void;
  /** 等待本域原始 SDK Promise 落定；本地 abort/timeout 不代表底层 quiet。 */
  awaitMobileQuiet(): Promise<void>;
}
