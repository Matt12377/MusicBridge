import type { RemoteCoreMode, RemoteCoreTunnelState } from '@music-bridge/contracts'

export interface RemoteCoreModeSnapshot {
  mode: RemoteCoreMode
  remoteStreamPort: number | undefined
}

export interface RemoteCoreModeDependencies {
  readMode(): Readonly<RemoteCoreModeSnapshot>
  setMode(mode: RemoteCoreMode, remoteStreamPort: number | undefined): void
  restart(): Promise<void>
}

export interface RemoteCoreModeController {
  bound(state: RemoteCoreTunnelState): Promise<void>
  unavailable(state: RemoteCoreTunnelState): Promise<void>
  reset(): void
}

interface Binding {
  sshTarget: string
  remoteStreamPort: number
  ready: boolean
}

export function createRemoteCoreModeController(dependencies: RemoteCoreModeDependencies): RemoteCoreModeController {
  let binding: Binding | undefined
  let transition: Promise<void> | undefined

  function restartInOrder(action: () => Promise<void>): Promise<void> {
    const pending = transition
    const next = (async () => {
      if (pending) await pending.catch(() => undefined)
      await action()
    })()
    transition = next
    const release = () => { if (transition === next) transition = undefined }
    void next.then(release, release)
    return next
  }

  return {
    async bound(state) {
      if (!state.sshTarget || state.remoteStreamPort === undefined) {
        throw new Error('远程 Core 隧道绑定信息不完整。')
      }
      const current: Binding = {
        sshTarget: state.sshTarget,
        remoteStreamPort: state.remoteStreamPort,
        ready: false,
      }
      binding = current
      return restartInOrder(async () => {
        // 排队期间的新绑定或显式停止可以撤销本次切换。
        if (binding !== current) return
        dependencies.setMode('remote-core-development', current.remoteStreamPort)
        try {
          await dependencies.restart()
          if (binding === current) current.ready = true
        } catch (error) {
          // 新绑定或显式停止已经接管时，旧重启不能再恢复旧模式。
          if (binding !== current) throw error
          // manager 已拆除先前隧道，切换失败只能恢复可用的本地模式。
          binding = undefined
          dependencies.setMode('local-core', undefined)
          try {
            await dependencies.restart()
          } catch (fallbackError) {
            throw new AggregateError([error, fallbackError], '远程 Core 切换失败，恢复本地模式也失败。', { cause: error })
          }
          throw error
        }
      })
    },

    async unavailable(state) {
      const current = binding
      const mode = dependencies.readMode()
      if (!current?.ready || current.sshTarget !== state.sshTarget
        || current.remoteStreamPort !== state.remoteStreamPort
        || mode.mode !== 'remote-core-development' || mode.remoteStreamPort !== current.remoteStreamPort) return

      return restartInOrder(async () => {
        const mode = dependencies.readMode()
        if (binding !== current || mode.mode !== 'remote-core-development'
          || mode.remoteStreamPort !== current.remoteStreamPort) return
        // 先撤销本次绑定，重复或迟到的失败只能触发一次回退。
        binding = undefined
        dependencies.setMode('local-core', undefined)
        await dependencies.restart()
      })
    },

    reset() {
      binding = undefined
    },
  }
}
