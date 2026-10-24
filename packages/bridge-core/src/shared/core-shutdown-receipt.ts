import { types } from 'node:util'
import { logLibraryOperation } from './library-operation-log.js'

const RECEIPT_TYPE = 'musicbridge.core-shutdown-received'
interface ShutdownPort { postMessage(message: unknown): void }
interface PendingReceipt { requestId: string; posted: boolean; received: boolean; confirmed: boolean; began: number }

function closedFields(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) return null
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null
    result[key] = descriptor.value
  }
  return result
}

/** 只绑定本次 Utility 原端口；关闭成功回执和 Main 确认都成立后才允许退出。 */
export function createCoreShutdownReceipt(port: ShutdownPort, onConfirmed: () => void) {
  let pending: PendingReceipt | undefined
  function confirm(): void {
    if (!pending || !pending.posted || !pending.received || pending.confirmed) return
    pending.confirmed = true
    logLibraryOperation('library', 'shutdown.utility-receipt', 'complete', {
      code: 'ACK_RECEIVED', elapsedMs: performance.now() - pending.began, slowAfterMs: 100,
    })
    onConfirmed()
  }
  return {
    postSuccess(requestId: string, response: unknown): void {
      const fields = closedFields(response, ['version', 'id', 'ok', 'result'])
      const result = fields ? closedFields(fields.result, ['stopped']) : null
      if (typeof requestId !== 'string' || requestId.length > 128 || !requestId.trim()
        || fields?.version !== 1 || fields.id !== requestId || fields.ok !== true || result?.stopped !== true) {
        throw new Error('原 Core 关闭成功回执无效。')
      }
      // 重复关闭仍回复原端口；退出资格始终只绑定首个成功发送的请求，不重登记或重放确认。
      if (pending) { port.postMessage(response); return }
      const current: PendingReceipt = { requestId, posted: false, received: false, confirmed: false, began: performance.now() }
      // 先登记再发出；即便测试端口同步回入，也必须等 postMessage 实际成功返回。
      pending = current
      logLibraryOperation('library', 'shutdown.utility-receipt', 'start', { code: 'WAITING_ACK' })
      try { port.postMessage(response) }
      catch (error) { if (pending === current) pending = undefined; throw error }
      current.posted = true
      confirm()
    },
    receive(source: object, value: unknown): boolean {
      if (!value || typeof value !== 'object' || types.isProxy(value)
        || Object.getOwnPropertyDescriptor(value, 'type')?.value !== RECEIPT_TYPE) return false
      // 识别到私有帧即消费；无效确认不进入通用 IPC，也不取得退出资格。
      const fields = closedFields(value, ['version', 'type', 'requestId'])
      if (source !== port || !pending || !fields || fields.version !== 1 || fields.type !== RECEIPT_TYPE
        || fields.requestId !== pending.requestId || pending.received) return true
      pending.received = true
      confirm()
      return true
    },
    cancel(requestId: string): void {
      // Utility重复回应失败也会调用cancel；已实际发送或确认的原收据不能因此丢失。
      if (pending?.requestId === requestId && !pending.posted) pending = undefined
    },
    isConfirmed(): boolean { return pending?.confirmed === true },
  }
}
