export const LOCAL_WORKBENCH_BIND_CODES = ['TIMEOUT', 'NOT_READY', 'OUTBOX_SCOPE_MISMATCH', 'INVALID_IPC_REQUEST',
  'INVALID_IPC_RESPONSE', 'INVENTORY_UNAVAILABLE', 'INVENTORY_CONFLICT', 'CANCELLED', 'INTERNAL_ERROR', 'UNKNOWN'] as const
export type LocalWorkbenchBindCode = typeof LOCAL_WORKBENCH_BIND_CODES[number]
export type LocalWorkbenchBindPhase = 'create' | 'attach' | 'activate' | 'health'
export interface LocalWorkbenchBindEvent {
  phase: LocalWorkbenchBindPhase
  state: 'start' | 'complete' | 'error' | 'cancelled'
  code?: LocalWorkbenchBindCode | 'REVOKED'
  attempt: number
  elapsedMs: number
}
export interface LocalWorkbenchMainRecovery {
  request(): Promise<void>
  revoke(): void
  close(): void
}

/** 仅重取真实作者和激活原资源；不保存身份、延长原 RPC 截止或重放写命令。 */
export function createLocalWorkbenchMainRecovery<Author>(options: {
  isReady(): boolean
  create(): Promise<Author>
  attach(author: Author): void
  activate(author: Author): Promise<void>
  announce(author: Author, assertCurrent: () => void): Promise<void>
  failureCode(error: unknown): unknown
  observe?(event: LocalWorkbenchBindEvent): void
}): LocalWorkbenchMainRecovery {
  const retryDelays = [500, 1000, 2000, 4000, 5000] as const
  const revoked = new Error('本次 Main 作者绑定已撤销。')
  let generation = 0, attempt = 0, closed = false, completed = false, requested = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let flight: { generation: number; promise: Promise<void> } | undefined
  const eligible = () => !closed && options.isReady()
  const clearRetry = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined }
  const observe = (event: LocalWorkbenchBindEvent) => { try { options.observe?.(event) } catch { /* 旁注失败不改变真实绑定。 */ } }

  function start(): Promise<void> {
    if (!eligible() || completed) return Promise.resolve()
    if (flight) { if (flight.generation !== generation) requested = true; return flight.promise }
    const original = generation, number = ++attempt
    let phase: LocalWorkbenchBindPhase = 'create', started = performance.now(), retry: number | undefined
    const current = () => original === generation && eligible()
    const assertCurrent = () => { if (!current()) throw revoked }
    async function step<T>(next: LocalWorkbenchBindPhase, action: () => T | Promise<T>): Promise<T> {
      assertCurrent(); phase = next; started = performance.now()
      observe({ phase, state: 'start', attempt: number, elapsedMs: 0 })
      const value = await action(); assertCurrent()
      observe({ phase, state: 'complete', attempt: number, elapsedMs: Math.max(0, performance.now() - started) })
      return value
    }
    const promise = Promise.resolve().then(async () => {
      const author = await step('create', options.create)
      await step('attach', () => options.attach(author))
      await step('activate', () => options.activate(author))
      // 公告在内部 await 后、发送前再次使用本代门禁，迟到结果不得唤醒新代窗口。
      await step('health', () => options.announce(author, assertCurrent))
      completed = true
    }).catch(error => {
      if (!current() || error === revoked) {
        observe({ phase, state: 'cancelled', code: 'REVOKED', attempt: number, elapsedMs: Math.max(0, performance.now() - started) })
        return
      }
      let code: LocalWorkbenchBindCode = 'UNKNOWN'
      try { const value = options.failureCode(error); if ((LOCAL_WORKBENCH_BIND_CODES as readonly unknown[]).includes(value)) code = value as LocalWorkbenchBindCode } catch { /* 不读未知异常正文。 */ }
      observe({ phase, state: 'error', code, attempt: number, elapsedMs: Math.max(0, performance.now() - started) })
      if (code === 'TIMEOUT' || code === 'NOT_READY') retry = retryDelays[number - 1]
    }).finally(() => {
      if (flight?.promise === promise) flight = undefined
      if (requested && eligible()) { requested = false; attempt = 0; void start(); return }
      if (retry !== undefined && current()) timer = setTimeout(() => { timer = undefined; void start() }, retry)
    })
    flight = { generation: original, promise }
    return promise
  }
  return {
    request() {
      if (!eligible() || completed) return Promise.resolve()
      if (flight) { if (flight.generation !== generation) requested = true; return flight.promise }
      // 真实 ready / Main 资源注册是新触发；首试加五次退避，仍沿原单次 RPC 截止。
      clearRetry(); attempt = 0; return start()
    },
    revoke() { generation++; completed = false; requested = false; attempt = 0; clearRetry() },
    close() { closed = true; generation++; completed = false; requested = false; clearRetry() },
  }
}
