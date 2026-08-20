export const QUALITY_LEVELS = [
  'standard',
  'exhigh',
  'lossless',
  'hires',
] as const;

export type QualityLevel = (typeof QUALITY_LEVELS)[number];

export type TransportSecurity = 'https-native' | 'https-upgraded';

export interface TrackMetadata {
  id: string;
  title: string;
  artists: string[];
  album: string;
  durationMs?: number;
  artworkUrl?: string;
}

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
  getTrack(trackId: string): Promise<TrackMetadata>;
  resolveStream(
    trackId: string,
    quality: QualityLevel,
  ): Promise<ResolvedAudioStream>;
}
