import type { OptionalRustReadonlyManager } from '../../../../packages/bridge-core/src/rust-core/optional-readonly-manager.js'
import { types } from 'node:util'
import { COLLECTION_READONLY_PORT_TYPE, isCollectionReadonlyControlRequest, isCollectionReadonlyPortMessage, type CollectionReadonlyControlResponse } from './collection-readonly-control-protocol.js'

export interface CollectionReadonlyCorePort {
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown
  on(event: 'close', listener: () => void): unknown
  postMessage(data: unknown): void
  start(): void
  close(): void
}
export interface CollectionReadonlyCoreParent {
  on(event: 'message', listener: (event: { data: unknown; ports?: readonly CollectionReadonlyCorePort[] }) => void): unknown
}

/** 原首公有端口仅被动观察 ready；私有端口不替换 utility 的 once 监听。 */
export function installCollectionReadonlyCoreBridge(manager: OptionalRustReadonlyManager, parent: CollectionReadonlyCoreParent) {
  let publicSeen = false, ready = false, used = false, closed = false
  let privatePort: CollectionReadonlyCorePort | undefined
  const revoke = () => { if (closed) return; closed = true; void manager.setEnabled(false).catch(() => {}) }
  parent.on('message', event => {
    const data = event.data
    if (!publicSeen) {
      publicSeen = true
      const publicPort = event.ports?.[0]
      if (publicPort) {
        const postMessage = publicPort.postMessage.bind(publicPort)
        publicPort.postMessage = message => {
          if (message && typeof message === 'object' && Object.getOwnPropertyDescriptor(message, 'event')?.value === 'core.ready') ready = true
          postMessage(message)
        }
      }
      return
    }
    // 不认识的父消息没有新能力；可信消息本身也必须是精确数据字段。
    if (!data || typeof data !== 'object' || types.isProxy(data) || Object.getOwnPropertyDescriptor(data, 'type')?.value !== COLLECTION_READONLY_PORT_TYPE) return
    if (used || closed || !ready || !isCollectionReadonlyPortMessage(data) || event.ports?.length !== 1) {
      for (const port of event.ports ?? []) { try { port.close() } catch {} }
      revoke(); return
    }
    used = true
    const nonce = data.generationNonce, port = event.ports[0]!
    privatePort = port
    const requestIds = new Set<string>()
    port.on('close', revoke)
    port.on('message', event => {
      if (closed) return
      const request = event.data
      if (!isCollectionReadonlyControlRequest(request) || request.generationNonce !== nonce || requestIds.has(request.requestId)) {
        revoke(); try { port.close() } catch {} return
      }
      requestIds.add(request.requestId)
      const header = { schemaVersion: 1 as const, generationNonce: nonce, requestId: request.requestId, type: request.type }
      // 每条请求独立执行：OFF 不能排在旧 ON 的 await 后。
      void (async () => {
        let response: CollectionReadonlyControlResponse
        try {
          if (request.type === 'refresh') response = { ...header, type: 'refresh', ok: true, result: await manager.refresh() }
          else response = { ...header, type: request.type, ok: true, status: request.type === 'setEnabled' ? await manager.setEnabled(request.enabled) : manager.getStatus() }
        } catch {
          response = { ...header, ok: false, errorCode: manager.getStatus().state === 'blocked' ? 'RUST_BLOCKED' : 'RUST_UNAVAILABLE' }
        }
        if (!closed) { try { port.postMessage(response) } catch { revoke() } }
      })()
    })
    port.start()
  })
  return { close() { revoke(); try { privatePort?.close() } catch {} } }
}
