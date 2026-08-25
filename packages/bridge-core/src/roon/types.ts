import type { TrackMetadata } from '../netease/types.js';

export type RoonConnectionStatus =
  | 'discovering'
  | 'paired'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'error';

export type RoonTransportState = 'playing' | 'paused' | 'loading' | 'stopped';

export interface RoonState {
  status: RoonConnectionStatus;
  coreName?: string;
  selectedZoneId?: string;
  selectedZoneName?: string;
  transportState?: RoonTransportState;
  canPause?: boolean;
  canResume?: boolean;
  lastError?: string;
}

export type RoonGatewayStage =
  | 'none'
  | 'headers'
  | 'streaming'
  | 'completed'
  | 'aborted'
  | 'error';

export interface RoonPlayRequest {
  mediaUrl: string;
  iconUrl: string;
  metadata: TrackMetadata;
  gatewayStage?: () => RoonGatewayStage;
}

export type RoonTerminalReason =
  | 'ended'
  | 'stopped'
  | 'media_error'
  | 'zone_lost';

export type RoonNativePlaybackState = 'playing' | 'paused' | 'loading' | 'stopped';

export interface RoonNowPlayingIdentity {
  title?: string;
  artist?: string;
  album?: string;
  durationMs?: number;
}

export interface RoonPlaybackObservation {
  revision: number;
  zoneId: string;
  state?: RoonNativePlaybackState;
  positionMs?: number;
  nowPlaying?: RoonNowPlayingIdentity;
}

export interface RoonPlaybackConfirmationRequest {
  zoneId: string;
  state: 'playing' | 'paused' | 'stopped' | 'inactive';
  afterRevision: number;
  track?: {
    title: string;
    artists: readonly string[];
    album: string;
    durationMs?: number;
  };
  requirePosition?: boolean;
  positionMs?: number;
}

export interface RoonTimeEvent {
  positionMs: number;
  source: 'audio-input' | 'zone';
  zoneId: string;
  revision: number;
  playbackEpoch?: number;
  nowPlaying?: RoonNowPlayingIdentity;
}

export interface RoonPort {
  setTerminalHandler(handler: (reason: RoonTerminalReason) => void): void;
  setTimeHandler?(handler: (event: RoonTimeEvent) => void): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  shutdown(): Promise<void>;
  play(request: RoonPlayRequest): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  seek?(positionMs: number): Promise<void>;
  control?(control: 'play' | 'pause' | 'playpause' | 'stop' | 'previous' | 'next'): Promise<void>;
  getSelectedZonePlaybackState?(): RoonNativePlaybackState | undefined;
  getSelectedZonePlaybackObservation?(): RoonPlaybackObservation | undefined;
  waitForSelectedZonePlayback?(
    request: RoonPlaybackConfirmationRequest,
  ): Promise<RoonPlaybackObservation>;
  getActivePlaybackEpoch?(): number | undefined;
  getState(): RoonState;
  getDiagnosticResourceCounters?(): {
    activeSessionCount: number;
    listenerCount: number;
    timerCount: number;
  };
}
