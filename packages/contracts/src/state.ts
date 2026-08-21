export type RuntimeStatus =
  | 'starting'
  | 'ready'
  | 'degraded'
  | 'failed'
  | 'stopped';

export type PublicRoonStatus =
  | 'disconnected'
  | 'discovering'
  | 'paired'
  | 'ready';

export type ProviderCredentialStatus = 'configured' | 'missing' | 'invalid';

export interface PublicRoonZone {
  zoneId: string;
  displayName: string;
  selected: boolean;
}

export interface PublicBridgeState {
  runtime: RuntimeStatus;
  roon: PublicRoonStatus;
  provider: ProviderCredentialStatus;
  activeStreamCount: number;
  activePlaybackPresent: boolean;
}
