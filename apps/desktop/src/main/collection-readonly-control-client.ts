import { randomUUID } from 'node:crypto'
import type { CollectionReadonlySettings } from '@music-bridge/contracts'
import { COLLECTION_READONLY_PORT_TYPE, CollectionReadonlyControlError, isCollectionReadonlyControlResponse, type CollectionReadonlyControlRequest } from './collection-readonly-control-protocol.js'
import type { CollectionReadonlyControl } from './collection-readonly-settings.js'

export { CollectionReadonlyControlError } from './collection-readonly-control-protocol.js'

export interface CollectionReadonlyControlPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown
  on(event: 'close', listener: () => void): unknown
  postMessage(value: unknown): void
  start(): void
  close(): void
}
export interface CollectionReadonlyControlChild {
  postMessage(value: unknown, ports: CollectionReadonlyControlPort[]): void
  once(event: 'exit', listener: () => void): unknown
}
const CONTROL_TIMEOUT_MS = 15_000
/** 只在真实Core ready后构造；每child只绑定一次，断开绝不重连。 */
export function createCollectionReadonlyControlClient(options: {
  child: CollectionReadonlyControlChild
  channel: { port1: CollectionReadonlyControlPort; port2: CollectionReadonlyControlPort }
}): CollectionReadonlyControl {
  const generationNonce = randomUUID(), { port1: remote, port2: port } = options.channel
  let closed = false
  let intentGeneration = 0
  let refreshing: { generation: number; promise: Promise<{ refreshed: boolean; status: CollectionReadonlySettings }> } | undefined
  const pending = new Map<string, {
    type: CollectionReadonlyControlRequest['type']
    timer: ReturnType<typeof setTimeout>
    resolve(value: unknown): void
    reject(error: Error): void
  }>()
  const failure = () => new CollectionReadonlyControlError('RUST_BLOCKED')
  const close = (): void => {
    if (closed) return
    closed = true
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(failure()) }
    pending.clear(); try { port.close() } catch { /* 已关闭的代际不重连。 */ }
    try { remote.close() } catch { /* 转移后的端口由Core拥有。 */ }
  }
  port.on('message', ({ data }) => {
    if (closed || !isCollectionReadonlyControlResponse(data) || data.generationNonce !== generationNonce) return
    const item = pending.get(data.requestId)
    if (!item || data.type !== item.type) return
    clearTimeout(item.timer); pending.delete(data.requestId)
    if (!data.ok) item.reject(new CollectionReadonlyControlError(data.errorCode))
    else item.resolve(data.type === 'refresh' ? data.result : data.status)
  })
  port.on('close', close); options.child.once('exit', close)
  port.start()
  try { options.child.postMessage({ type: COLLECTION_READONLY_PORT_TYPE, schemaVersion: 1, generationNonce }, [remote]) }
  catch { close() }
  function send(type: CollectionReadonlyControlRequest['type'], enabled?: boolean): Promise<unknown> {
    if (closed) return Promise.reject(failure())
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId); reject(failure())
        // 未知控制结果封住本通道；晚到reply不能恢复本Core能力。
        close()
      }, CONTROL_TIMEOUT_MS)
      pending.set(requestId, { type, timer, resolve, reject })
      try { port.postMessage({ schemaVersion: 1, generationNonce, requestId, type, ...(type === 'setEnabled' ? { enabled } : {}) }) }
      catch { close() }
    })
  }
  return {
    getStatus: () => send('status') as Promise<CollectionReadonlySettings>,
    setEnabled: enabled => {
      if (typeof enabled !== 'boolean') return Promise.reject(failure())
      // 切换意图立即撤销旧刷新复用权；旧pending保留原reply，不重连或重投。
      intentGeneration++
      return send('setEnabled', enabled) as Promise<CollectionReadonlySettings>
    },
    refresh: () => {
      if (refreshing?.generation === intentGeneration) return refreshing.promise
      const work = send('refresh') as Promise<{ refreshed: boolean; status: CollectionReadonlySettings }>
      const flight = { generation: intentGeneration, promise: work }
      refreshing = flight
      void work.finally(() => { if (refreshing === flight) refreshing = undefined }).catch(() => {})
      return work
    },
    close,
  }
}
