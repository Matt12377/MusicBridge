export type RemoteCoreMode = 'local-core' | 'remote-core-development'

export const REMOTE_CORE_LOCAL_PORT_PAIRS = Object.freeze({
  default: Object.freeze({ controlPort: 38501, streamPort: 38502 }),
  secondary: Object.freeze({ controlPort: 38601, streamPort: 38602 }),
} as const)

export type RemoteCoreLocalPortProfile = keyof typeof REMOTE_CORE_LOCAL_PORT_PAIRS

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
  | 'SSH_CONNECTION_FAILED'
  | 'SSH_BINARY_UNAVAILABLE'
  | 'REMOTE_PORTS_UNAVAILABLE'
  | 'REMOTE_HEALTH_UNAVAILABLE'
  | 'CORE_RESTART_FAILED'
  | 'TUNNEL_DISCONNECTED'

export type RemoteCoreTunnelFailurePhase =
  | 'configuration'
  | 'ssh'
  | 'port-forward'
  | 'core-restart'
  | 'health-check'
  | 'lifecycle'

export interface RemoteCoreTunnelFailure {
  phase: RemoteCoreTunnelFailurePhase
  code: RemoteCoreTunnelErrorCode
  message: string
}

export interface RemoteCoreTunnelState {
  mode: RemoteCoreMode
  status: RemoteCoreTunnelStatus
  sshTarget?: string
  localStreamPort: number
  remoteStreamPort?: number
  remoteHealth: RemoteCoreHealthStatus
  autoReconnect: boolean
  errorCode?: RemoteCoreTunnelErrorCode
  failure?: RemoteCoreTunnelFailure
}
