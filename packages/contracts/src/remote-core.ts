export type RemoteCoreMode = 'local-core' | 'remote-core-development'

export const REMOTE_CORE_STREAM_PORT_CANDIDATES = Object.freeze([
  38512,
  38513,
  38514,
  38515,
  38516,
  38517,
  38518,
  38519,
]) as readonly number[]

export type RemoteCoreTunnelStatus =
  | 'idle'
  | 'checking'
  | 'starting'
  | 'ready'
  | 'reconnecting'
  | 'stopping'
  | 'disconnected'
  | 'failed'

export type RemoteCoreHealthStatus = 'available' | 'unavailable'

export type RemoteCoreTunnelErrorCode =
  | 'INVALID_SSH_TARGET'
  | 'INVALID_REMOTE_STREAM_PORT'
  | 'INVALID_LOCAL_STREAM_PORT'
  | 'SSH_AUTH_REQUIRED'
  | 'SSH_BINARY_UNAVAILABLE'
  | 'REMOTE_PORTS_UNAVAILABLE'
  | 'REMOTE_HEALTH_UNAVAILABLE'
  | 'TUNNEL_DISCONNECTED'

export interface RemoteCoreTunnelState {
  mode: RemoteCoreMode
  status: RemoteCoreTunnelStatus
  sshTarget?: string
  localStreamPort: number
  remoteStreamPort?: number
  remoteHealth: RemoteCoreHealthStatus
  autoReconnect: boolean
  errorCode?: RemoteCoreTunnelErrorCode
}
