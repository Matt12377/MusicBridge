import type {
  AuthStatus,
  RemoteCoreTunnelStatus,
  RuntimeStatus,
} from '@music-bridge/contracts'

const REMOTE_CORE_TRANSITION_STATES = new Set<RemoteCoreTunnelStatus>([
  'checking',
  'starting',
  'reconnecting',
  'stopping',
])

export function isCoreRuntimeStable(
  runtimeStatus: RuntimeStatus | undefined,
  remoteCoreStatus?: RemoteCoreTunnelStatus,
): boolean {
  return runtimeStatus === 'ready'
    && (remoteCoreStatus === undefined || !REMOTE_CORE_TRANSITION_STATES.has(remoteCoreStatus))
}

export function canLoadAuthorizedLibrary(
  authStatus: AuthStatus,
  runtimeStatus: RuntimeStatus | undefined,
  remoteCoreStatus?: RemoteCoreTunnelStatus,
): boolean {
  return authStatus === 'authorized' && isCoreRuntimeStable(runtimeStatus, remoteCoreStatus)
}
