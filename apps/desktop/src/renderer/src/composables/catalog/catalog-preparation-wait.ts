import { readPublicIpcErrorCode } from '../../roonLibraryMessages.js'
import type { CatalogSource } from './catalog-presentation.js'

export const catalogPreparationMessage = '正在准备本地艺术家与搜索，可继续使用其他页面。'
type Scope = 'library' | 'search' | 'preview' | 'detail' | 'matches'

/** 每个页面只撤销自己的等待；共享索引的生命周期始终由原Owner控制。 */
export function createCatalogPreparationWaiters() {
  const active = new Set<{ scope: Scope; source: CatalogSource; controller: AbortController }>()
  let disposed = false
  async function read<T>(options: {
    scope: Scope; source: CatalogSource; current(): boolean; preparing(value: boolean): void; operation(): Promise<T>
  }): Promise<T | undefined> {
    const entry = { scope: options.scope, source: options.source, controller: new AbortController() }
    if (disposed || !options.current()) return
    active.add(entry)
    const signal = entry.controller.signal, cancelled = new Error('[CANCELLED] 本次页面等待已结束。')
    let rejectAbort!: (error: Error) => void
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject })
    const abort = () => rejectAbort(cancelled)
    signal.addEventListener('abort', abort, { once: true })
    const expired = Object.assign(new Error('Mac仍在准备本地艺术家与搜索，请稍后重试。'), { code: 'ARTIST_INDEX_WAIT_LIMIT' })
    let delay = 500, limited = false, limitTimer: ReturnType<typeof setTimeout> | undefined
    try {
      while (!disposed && !signal.aborted && options.current()) {
        if (limited) throw expired
        try {
          return await Promise.race([Promise.resolve().then(() => {
            if (disposed || signal.aborted || !options.current()) throw cancelled
            if (limited) throw expired
            return options.operation()
          }), aborted])
        }
        catch (error) {
          if (disposed || signal.aborted || !options.current()) return
          if (options.source !== 'local' || readPublicIpcErrorCode(error) !== 'ARTIST_INDEX_PREPARING') throw error
          options.preparing(true)
          limitTimer ??= setTimeout(() => { limited = true; rejectAbort(expired) }, 5 * 60_000)
          let timer: ReturnType<typeof setTimeout> | undefined
          try { await Promise.race([new Promise<void>(resolve => { timer = setTimeout(resolve, delay) }), aborted]) }
          catch (error) { if (error === cancelled) return; throw error }
          finally { if (timer !== undefined) clearTimeout(timer) }
          delay = Math.min(delay * 2, 2000)
        }
      }
    } finally {
      if (limitTimer !== undefined) clearTimeout(limitTimer)
      signal.removeEventListener('abort', abort); active.delete(entry)
      if (options.current()) options.preparing(false)
    }
  }
  function cancel(scope?: Scope, source?: CatalogSource): void {
    for (const entry of active) if ((!scope || entry.scope === scope) && (!source || entry.source === source)) entry.controller.abort()
  }
  return { read, cancel, dispose() { disposed = true; cancel() } }
}
