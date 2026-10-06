import type { LocalPlayTarget } from '@music-bridge/contracts';
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

/** Core内部的操作身份与取消；不进入公开DTO或IPC。 */
export interface RoonOperationOptions {
  assertCurrent?(): void;
  withDispatch?<T>(send: () => T): T;
  signal?: AbortSignal;
  expectedZoneId?: string;
}

export interface LocalRoonSessionObservation {
  event: 'DISPATCHED' | 'SESSION' | 'PLAYING' | 'PAUSED' | 'UNKNOWN' | 'ENDED' | 'OWNERSHIP_LOST';
  generation: number; sessionId?: string; isConfirmed(): boolean; isOwned(): boolean;
}
export interface RoonPlayRequest extends RoonOperationOptions {
  /** 私有会话事实，不进入公开IPC。 */
  onLocalSession?(observation: LocalRoonSessionObservation): void;
  mediaUrl: string;
  iconUrl: string;
  metadata: TrackMetadata;
  gatewayStage?: () => RoonGatewayStage;
  onStartupStage?: (stage: 'roon-session-began' | 'roon-playing') => void;
  /** 首个实际SDK写入前同步登记，取消或Zone变化时可以拒绝派发。 */
  onDispatch?: () => void;
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
  /** 仅 Core 内部使用，映射为不透明封面引用后才能进入公开快照。 */
  imageKey?: string;
  canNext?: boolean;
  canPrevious?: boolean;
}

export interface RoonPlaybackConfirmationRequest {
  signal?: AbortSignal;
  zoneId: string;
  state: 'playing' | 'paused' | 'stopped' | 'inactive';
  afterRevision: number;
  track?: {
    title: string;
    artists: readonly string[];
    album: string;
    durationMs?: number;
  };
  /** 仅供已定位并派发的原生曲目动作使用，允许 Browse 与 Transport 元数据别名。 */
  allowMetadataAliases?: boolean;
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
  captureLocalTarget?(): {target: LocalPlayTarget; isCurrent(): boolean} | null;
  setTerminalHandler(handler: (reason: RoonTerminalReason) => void): void;
  setTimeHandler?(handler: (event: RoonTimeEvent) => void): void;
  start(): Promise<void>;
  stop(options?: RoonOperationOptions): Promise<void>;
  shutdown(): Promise<void>;
  play(request: RoonPlayRequest): Promise<void>;
  pause(options?: RoonOperationOptions): Promise<void>;
  resume(options?: RoonOperationOptions): Promise<void>;
  seek?(positionMs: number, options?: RoonOperationOptions): Promise<void>;
  control?(control: 'play' | 'pause' | 'playpause' | 'stop' | 'previous' | 'next', options?: RoonOperationOptions): Promise<void>;
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
