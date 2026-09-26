import type { MusicBridgePublicApi } from '../../../../preload/api.js'

type CoreEvent = Parameters<Parameters<MusicBridgePublicApi['onCoreEvent']>[0]>[0]
type RemoteEvent = Parameters<Parameters<MusicBridgePublicApi['onRemoteCoreEvent']>[0]>[0]
type AppCommand = Parameters<Parameters<MusicBridgePublicApi['onAppCommand']>[0]>[0]

export type InitialReadResult<T> = { active: true; value: T } | { active: false }
export type InitialRead = <T>(request: () => Promise<T>) => Promise<InitialReadResult<T>>

export interface RendererLifecycleOptions {
  api: Pick<MusicBridgePublicApi, 'onCoreEvent' | 'onRemoteCoreEvent' | 'onAppCommand'>
  keyTarget: Pick<Window, 'addEventListener' | 'removeEventListener'>
  onKeydown: (event: KeyboardEvent) => void
  onCoreEvent: (event: CoreEvent) => void
  onRemoteCoreEvent: (event: RemoteEvent) => void
  onAppCommand: (command: AppCommand) => void
  initialize: (read: InitialRead) => Promise<void>
  onInitializationError: (error: unknown) => void
}

/** 唯一管理 Renderer 订阅与启动查询的生命期，不承载任何领域状态。 */
export function useRendererLifecycle(options: RendererLifecycleOptions) {
  let active = false
  let disposed = false
  const unsubscribe: Array<() => void> = []

  const isActive = (): boolean => active && !disposed

  const read: InitialRead = async request => {
    if (!isActive()) return { active: false }
    const value = await request()
    return isActive() ? { active: true, value } : { active: false }
  }

  function start(): void {
    if (active || disposed) return
    active = true
    options.keyTarget.addEventListener('keydown', options.onKeydown)
    unsubscribe.push(
      options.api.onAppCommand(command => { if (isActive()) options.onAppCommand(command) }),
      options.api.onRemoteCoreEvent(event => { if (isActive()) options.onRemoteCoreEvent(event) }),
      options.api.onCoreEvent(event => { if (isActive()) options.onCoreEvent(event) }),
    )
    void options.initialize(read).catch(error => {
      if (isActive()) options.onInitializationError(error)
    })
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    active = false
    options.keyTarget.removeEventListener('keydown', options.onKeydown)
    for (const remove of unsubscribe.splice(0)) remove()
  }

  return { start, dispose, isActive }
}
