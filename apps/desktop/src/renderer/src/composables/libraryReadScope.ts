import type {
  IpcCommandPayloads, IpcCommandResults, LibraryReadCommand, LibraryReadRequest,
} from '@music-bridge/contracts'
import type { MusicBridgePublicApi } from '../../../preload/api.js'
import { readPublicIpcErrorCode } from '../roonLibraryMessages.js'

const MAX_LIBRARY_READ_MS = 10_000
type ReadTimer = ReturnType<typeof setTimeout>
type ReadEndCode = 'CANCELLED' | 'TIMEOUT'

/** Signal 只在 Renderer 内使用；跨进程请求只有合同允许的四个字段。 */
export interface LibraryReadOptions {
  signal?: AbortSignal
  deadlineAtMs?: number
}

/** 时钟和计时器可注入，使取消与期限测试不依赖真实等待。 */
export interface LibraryReadScopeOptions {
  now?: () => number
  createId?: () => string
  schedule?: (operation: () => void, delayMs: number) => ReadTimer
  unschedule?: (timer: ReadTimer) => void
}

export interface LibraryReadScope {
  read: <C extends LibraryReadCommand>(
    command: C,
    payload: IpcCommandPayloads[C],
    fallback: () => Promise<IpcCommandResults[C]>,
    options?: LibraryReadOptions,
  ) => Promise<IpcCommandResults[C]>
  cancelAll: () => void
  dispose: () => void
}

function readEndError(code: ReadEndCode): Error & { code: ReadEndCode } {
  const message = code === 'CANCELLED' ? '本次资料库读取已取消。' : '资料库读取超时，请重试。'
  return Object.assign(new Error(`[${code}] ${message}`), { code })
}

/** 只对取消静默；TIMEOUT 与普通失败仍交给原页面的用户提示。 */
export function isLibraryReadCancelled(error: unknown): boolean {
  return readPublicIpcErrorCode(error) === 'CANCELLED'
}

/** 每个调用者单独拥有 readId；同载荷合并与最后订阅者取消由 Core 处理。 */
export function createLibraryReadScope(
  api: Pick<MusicBridgePublicApi, 'readLibrary' | 'cancelLibraryRead'>,
  options: LibraryReadScopeOptions = {},
): LibraryReadScope {
  const now = options.now ?? Date.now
  const createId = options.createId ?? (() => crypto.randomUUID())
  const schedule = options.schedule ?? ((operation, delayMs) => setTimeout(operation, delayMs))
  const unschedule = options.unschedule ?? (timer => clearTimeout(timer))
  const pending = new Set<{ cancel: (code: ReadEndCode) => void }>()
  let disposed = false

  function read<C extends LibraryReadCommand>(
    command: C,
    payload: IpcCommandPayloads[C],
    fallback: () => Promise<IpcCommandResults[C]>,
    readOptions: LibraryReadOptions = {},
  ): Promise<IpcCommandResults[C]> {
    if (disposed || readOptions.signal?.aborted) return Promise.reject(readEndError('CANCELLED'))
    const startedAtMs = now()
    if (!Number.isSafeInteger(startedAtMs) || !Number.isSafeInteger(startedAtMs + MAX_LIBRARY_READ_MS)
      || (readOptions.deadlineAtMs !== undefined && !Number.isSafeInteger(readOptions.deadlineAtMs))) {
      return Promise.reject(new Error('[INVALID_IPC_REQUEST] 资料库读取期限无效。'))
    }
    const deadlineAtMs = Math.min(startedAtMs + MAX_LIBRARY_READ_MS, readOptions.deadlineAtMs ?? Infinity)
    const remainingMs = deadlineAtMs - startedAtMs
    if (remainingMs <= 0) return Promise.reject(readEndError('TIMEOUT'))
    const readLibrary = api.readLibrary
    const cancelLibraryRead = api.cancelLibraryRead
    // 缺少任一能力即调用一次原具名 API；新协议失败不能再重放旧调用。
    const protocol = typeof readLibrary === 'function' && typeof cancelLibraryRead === 'function'
    const id = protocol ? createId() : undefined

    return new Promise<IpcCommandResults[C]>((resolve, reject) => {
      let ended = false
      let dispatched = false
      let timer: ReadTimer | undefined
      const signal = readOptions.signal
      const abort = () => entry.cancel('CANCELLED')
      const release = () => {
        pending.delete(entry)
        if (timer !== undefined) unschedule(timer)
        timer = undefined
        signal?.removeEventListener('abort', abort)
      }
      const fail = (error: unknown) => {
        if (ended) return
        ended = true
        release()
        reject(error)
      }
      const entry = {
        cancel: (code: ReadEndCode) => {
          if (ended) return
          fail(readEndError(code))
          if (dispatched && id !== undefined && cancelLibraryRead) {
            // 取消回执不决定本地终态；同步抛错和异步失败都不能反向恢复旧等待。
            try { void Promise.resolve(cancelLibraryRead.call(api, id)).catch(() => undefined) }
            catch { /* 当前本地等待已结束，原页面可以发起新的读取。 */ }
          }
        },
      }
      pending.add(entry)
      signal?.addEventListener('abort', abort, { once: true })
      timer = schedule(() => entry.cancel('TIMEOUT'), remainingMs)
      if (ended) { release(); return }
      if (signal?.aborted) { entry.cancel('CANCELLED'); return }
      let operation: Promise<IpcCommandResults[C]>
      try {
        dispatched = true
        if (protocol && id !== undefined && readLibrary) {
          const request: LibraryReadRequest<C> = { id, command, payload, deadlineAtMs }
          operation = readLibrary.call(api, request) as Promise<IpcCommandResults[C]>
        } else operation = fallback()
      } catch (error) { fail(error); return }
      // 即使已本地取消，仍消费迟到 rejection；只接受当前等待的唯一终态。
      void Promise.resolve(operation).then(result => {
        if (ended) return
        if (now() >= deadlineAtMs) { entry.cancel('TIMEOUT'); return }
        ended = true
        release()
        resolve(result)
      }, fail)
    })
  }

  const cancelAll = () => { for (const entry of [...pending]) entry.cancel('CANCELLED') }
  return { read, cancelAll, dispose: () => { disposed = true; cancelAll() } }
}
