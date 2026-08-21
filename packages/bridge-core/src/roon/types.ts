import type { TrackMetadata } from '../netease/types.js';

export type RoonConnectionStatus =
  | 'discovering'
  | 'paired'
  | 'ready'
  | 'playing'
  | 'error';

export interface RoonState {
  status: RoonConnectionStatus;
  coreName?: string;
  selectedZoneId?: string;
  selectedZoneName?: string;
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

export interface RoonPort {
  setTerminalHandler(handler: (reason: RoonTerminalReason) => void): void;
  setTimeHandler?(handler: (positionMs: number) => void): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  shutdown(): Promise<void>;
  play(request: RoonPlayRequest): Promise<void>;
  getState(): RoonState;
  getDiagnosticResourceCounters?(): {
    activeSessionCount: number;
    listenerCount: number;
    timerCount: number;
  };
}
