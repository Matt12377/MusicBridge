import type { BrowserWindow, MessageBoxOptions, MessageBoxReturnValue } from 'electron'

export interface MobilePairingPrompt {
  requestId: string
  deviceName: string
  code: string
  expiresAtMs: number
  onCancel(requestId: string): Promise<void> | void
}
type PromptWindow = Pick<BrowserWindow, 'isDestroyed' | 'isMinimized' | 'isVisible' | 'restore' | 'show' | 'focus'>
type ShowMessageBox = (window: PromptWindow, options: MessageBoxOptions) => Promise<Pick<MessageBoxReturnValue, 'response'>>
interface Entry {
  requestId: string
  parent: PromptWindow
  code: string
  deviceName: string
  expiresAtMs: number
  onCancel: MobilePairingPrompt['onCancel']
  controller: AbortController
  timer: ReturnType<typeof setTimeout>
  silent: boolean
}
const unavailable = () => new Error('配对提示当前无法显示。')

/** 只由 Main 持有码；原生 sheet 串行呈现，请求身份与有效期互不覆盖。 */
export function createMobilePairingPromptCoordinator(options: {
  getWindow(): PromptWindow | undefined
  showMessageBox?: ShowMessageBox
  now?: () => number
}) {
  const entries = new Map<string, Entry>(), queue: Entry[] = [], tasks = new Set<Promise<void>>()
  let displaying = false, closed = false, stopFlight: Promise<void> | undefined
  const now = options.now ?? Date.now
  const current = (entry: Entry) => !closed && !entry.silent && entries.get(entry.requestId) === entry
  function release(entry: Entry): void {
    entry.silent = true
    clearTimeout(entry.timer)
    if (entries.get(entry.requestId) === entry) entries.delete(entry.requestId)
    entry.controller.abort()
    entry.code = ''
  }
  function track(task: Promise<void>): void {
    tasks.add(task)
    void task.then(() => tasks.delete(task), () => tasks.delete(task))
  }
  function cancel(entry: Entry): void {
    if (!current(entry)) return
    release(entry)
    // 取消原生 sheet 与后台取消只触及这一个请求；回调异常不进入日志。
    const task = Promise.resolve().then(() => entry.onCancel(entry.requestId)).then(() => undefined, () => undefined)
    track(task)
  }
  async function run(entry: Entry): Promise<void> {
    try {
      if (!current(entry)) return
      if (entry.expiresAtMs <= now() || entry.parent.isDestroyed()) { cancel(entry); return }
      const show = options.showMessageBox ?? ((parent: PromptWindow, value: MessageBoxOptions) => import('electron')
        .then(({ dialog }) => { if (!current(entry)) return { response: 0 }; return dialog.showMessageBox(parent as BrowserWindow, value) }))
      if (entry.parent.isMinimized()) entry.parent.restore()
      if (!entry.parent.isVisible()) entry.parent.show()
      entry.parent.focus()
      await show(entry.parent, { type: 'info', title: 'Mousa 配对', message: '在 iPhone 输入验证码',
        detail: entry.deviceName + '\n\n' + entry.code + '\n\n请只在你刚刚发起配对的设备上输入。验证码到期后自动关闭。',
        buttons: ['取消配对'], defaultId: 0, cancelId: 0, noLink: true, signal: entry.controller.signal })
      if (current(entry)) cancel(entry)
    } catch { if (current(entry)) cancel(entry) }
    finally { release(entry) }
  }
  function pump(): void {
    if (displaying || closed) return
    let entry: Entry | undefined
    while ((entry = queue.shift()) && !current(entry)) { /* 已完成或到期的排队请求不再展示。 */ }
    if (!entry) return
    displaying = true
    const selected = entry
    const task = run(selected).finally(() => { displaying = false; pump() })
    track(task)
  }
  return {
    /** 返回只表示请求已登记；等待用户关闭不会阻塞 HTTP 配对开始。 */
    show(input: MobilePairingPrompt): Promise<void> {
      let parent: PromptWindow | undefined
      try {
        if (closed || !input || typeof input.requestId !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/u.test(input.requestId)
          || entries.has(input.requestId) || entries.size >= 16 || typeof input.deviceName !== 'string'
          || input.deviceName.trim().length === 0 || [...input.deviceName].length > 128 || /[\p{Cc}\p{Cf}]/u.test(input.deviceName)
          || typeof input.code !== 'string' || !/^[0-9]{6}$/u.test(input.code) || typeof input.onCancel !== 'function'
          || !Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs <= now() || input.expiresAtMs - now() > 24 * 60 * 60 * 1000
          || !(parent = options.getWindow()) || parent.isDestroyed()) return Promise.reject(unavailable())
      } catch { return Promise.reject(unavailable()) }
      const entry: Entry = { requestId: input.requestId, deviceName: input.deviceName, code: input.code,
        expiresAtMs: input.expiresAtMs, onCancel: input.onCancel, parent, controller: new AbortController(), silent: false,
        timer: setTimeout(() => cancel(entry), Math.max(1, input.expiresAtMs - now())) }
      entries.set(entry.requestId, entry); queue.push(entry); pump()
      return Promise.resolve()
    },
    dismiss(requestId: string): void {
      const entry = entries.get(requestId)
      if (entry) release(entry)
    },
    stop(): Promise<void> {
      if (stopFlight) return stopFlight
      closed = true
      for (const entry of entries.values()) release(entry)
      queue.length = 0
      stopFlight = (async () => { while (tasks.size) await Promise.allSettled([...tasks]) })()
      return stopFlight
    },
  }
}
