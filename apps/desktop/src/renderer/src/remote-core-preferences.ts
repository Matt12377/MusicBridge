const TARGET_KEY = 'musicbridge.remoteCore.sshTarget'

interface TargetStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** 环境提供的目标只作为首次默认值；后续从应用设置恢复。 */
export function restoreRemoteTarget(suggested: string | undefined, storage: TargetStorage): string {
  const target = storage.getItem(TARGET_KEY)?.trim() || suggested?.trim() || ''
  if (target) storage.setItem(TARGET_KEY, target)
  return target
}

/** 冷启动没有旧会话；失败后也可能已经修改了目标。 */
export function reconnectRemoteTarget<T>(
  api: { startRemoteCore(target: string): Promise<T>; reconnectRemoteCore(): Promise<T> },
  state: { status: string; sshTarget?: string },
  target: string,
): Promise<T> {
  if (['idle', 'failed', 'disconnected'].includes(state.status) || state.sshTarget !== target) {
    return api.startRemoteCore(target.trim())
  }
  return api.reconnectRemoteCore()
}
