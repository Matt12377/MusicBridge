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

export type AuthStatus =
  | 'idle'
  | 'creating'
  | 'waiting'
  | 'scanned'
  | 'authorized'
  | 'expired'
  | 'cancelled'
  | 'error';

export interface PublicAuthState {
  status: AuthStatus;
  challengeId?: string;
  qrImage?: string;
  expiresAt?: number;
}

export type PublicAccountProfileStatus = 'missing' | 'loading' | 'ready' | 'unavailable'

export interface PublicAccountProfile {
  displayName: string
  avatarUrl?: string
}

export interface PublicAccountState {
  status: PublicAccountProfileStatus
  profile?: PublicAccountProfile
}

export interface PublicRoonZone {
  zoneId: string;
  displayName: string;
  selected: boolean;
  seekAllowed?: boolean;
}

export interface PublicBridgeState {
  runtime: RuntimeStatus;
  roon: PublicRoonStatus;
  provider: ProviderCredentialStatus;
  activeStreamCount: number;
  activePlaybackPresent: boolean;
}
