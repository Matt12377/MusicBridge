import type { PublicRoonZone, RemoteCoreTunnelStatus } from '@music-bridge/contracts'

export type ZoneLifecycleStatus =
  | 'core-disconnected'
  | 'loading'
  | 'empty'
  | 'unselected'
  | 'selected'

export interface ZoneLifecycleInput {
  roonStatus: string
  loading: boolean
  zoneCount: number
  selected: boolean
}

export function resolveZoneLifecycleStatus(input: ZoneLifecycleInput): ZoneLifecycleStatus {
  if (input.roonStatus === 'disconnected' || input.roonStatus === 'discovering') {
    return 'core-disconnected'
  }
  if (input.loading) return 'loading'
  if (input.zoneCount === 0) return 'empty'
  return input.selected ? 'selected' : 'unselected'
}

const ZONE_LIFECYCLE_LABELS: Record<ZoneLifecycleStatus, string> = {
  'core-disconnected': 'Core 已断开',
  loading: '正在读取播放设备',
  empty: '没有可用播放设备',
  unselected: '尚未选择播放设备',
  selected: '播放设备已选择',
}

export function zoneLifecycleLabel(status: ZoneLifecycleStatus): string {
  return ZONE_LIFECYCLE_LABELS[status]
}

export interface ZoneRefreshCoordinatorOptions {
  load: () => Promise<readonly PublicRoonZone[]>
  onZones: (zones: readonly PublicRoonZone[]) => void
  onLoading: (loading: boolean) => void
  onError: (error: unknown) => void
  debounceMs?: number
}

export interface ZoneRefreshCoordinator {
  refreshNow(): Promise<void>
  handleCoreEvent(event: 'core.ready' | 'roon.changed', roonStatus: string): void
  handleRemoteCoreState(status: RemoteCoreTunnelStatus): void
  dispose(): void
}

export function createZoneRefreshCoordinator(
  options: ZoneRefreshCoordinatorOptions,
): ZoneRefreshCoordinator {
  const debounceMs = options.debounceMs ?? 50
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const cancelScheduled = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }

  const clearZones = (): void => {
    cancelScheduled()
    generation += 1
    options.onLoading(false)
    options.onZones([])
  }

  const refreshNow = async (): Promise<void> => {
    if (disposed) return
    cancelScheduled()
    const currentGeneration = ++generation
    options.onLoading(true)
    try {
      const zones = await options.load()
      if (!disposed && currentGeneration === generation) options.onZones(zones)
    } catch (error) {
      if (!disposed && currentGeneration === generation) options.onError(error)
    } finally {
      if (!disposed && currentGeneration === generation) options.onLoading(false)
    }
  }

  const scheduleRefresh = (): void => {
    if (disposed) return
    cancelScheduled()
    timer = setTimeout(() => {
      timer = undefined
      void refreshNow()
    }, debounceMs)
  }

  return {
    refreshNow,
    handleCoreEvent(_event, roonStatus) {
      if (roonStatus === 'disconnected' || roonStatus === 'discovering') clearZones()
      else scheduleRefresh()
    },
    handleRemoteCoreState(status) {
      if (status === 'ready') scheduleRefresh()
      else clearZones()
    },
    dispose() {
      disposed = true
      cancelScheduled()
      generation += 1
      options.onLoading(false)
    },
  }
}
