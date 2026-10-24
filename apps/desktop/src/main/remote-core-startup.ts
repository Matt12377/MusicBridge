import { types } from 'node:util'

import { isTrustedRendererSender } from './security.js'
import { isSafeSshTarget } from './remote-core-tunnel.js'
import { logLibraryOperation } from '../../../../packages/bridge-core/src/shared/library-operation-log.js'

export const REMOTE_CORE_STARTUP_PREFERENCE = 'remote-core:bootstrap-preference'
export const REMOTE_CORE_STARTUP_READY = 'remote-core:bootstrap-ready'
export const REMOTE_CORE_STARTUP_PREFERENCE_MS = 2_000

interface StartupFrame { readonly url: string }
interface StartupContents { readonly id: number; readonly mainFrame: StartupFrame }
export interface RemoteCoreStartupWindow {
  readonly webContents: StartupContents
  isDestroyed(): boolean
}
export interface RemoteCoreStartupSender {
  readonly sender: StartupContents
  readonly senderFrame: StartupFrame | null
}
interface Preference {
  readonly autoStart: boolean
  readonly sshTarget: string | undefined
}

class StartupError extends Error {
  readonly code = 'NOT_READY'
  constructor() { super('本次应用启动已经撤销或尚未完成。') }
}

function dataRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false
  const fields = Object.getOwnPropertyDescriptors(value)
  return Reflect.ownKeys(fields).length === keys.length && keys.every(key =>
    fields[key]?.enumerable === true && Object.hasOwn(fields[key]!, 'value'))
}

/** 首次模式选择只使用本窗口的一次同源偏好；不缓存任何Core或Source权利。 */
export function createRemoteCoreStartup(options: {
  nonce: string
  suggestedTarget?: string
  currentWindow(): RemoteCoreStartupWindow | undefined
  isClosing(): boolean
  now?: () => number
}) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(options.nonce)) throw new StartupError()
  let window: RemoteCoreStartupWindow | undefined
  let state: 'preparing' | 'ready' | 'failed' | 'closed' = 'preparing'
  let choice: Preference | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let preferenceDeadline: number | undefined
  let attempted = false
  let activated = false
  let activation: Promise<void> | undefined
  let remoteActivationPending = false
  const preferenceStarted = options.now?.() ?? performance.now()
  let resolveChoice!: (value: Preference) => void, rejectChoice!: (error: unknown) => void
  let resolveReady!: () => void, rejectReady!: (error: unknown) => void
  const selected = new Promise<Preference>((resolve, reject) => { resolveChoice = resolve; rejectChoice = reject })
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  void selected.catch(() => undefined)
  void ready.catch(() => undefined)

  function assertCurrent(): void {
    if (state === 'closed' || state === 'failed' || options.isClosing()
      || !window || window.isDestroyed() || options.currentWindow() !== window) throw new StartupError()
  }
  function assertSender(event: RemoteCoreStartupSender, value: unknown, keys: readonly string[]): Record<string, unknown> {
    assertCurrent()
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
      || !event.senderFrame || !isTrustedRendererSender({ senderId: event.sender.id,
        windowId: window.webContents.id, frameUrl: event.senderFrame.url })
      || !dataRecord(value, keys) || value.version !== 1 || value.nonce !== options.nonce) throw new StartupError()
    return value
  }
  function select(value: Preference, code: 'PREFERENCE_ACCEPTED' | 'PREFERENCE_UNAVAILABLE' | 'PREFERENCE_TIMEOUT'): void {
    if (choice || state !== 'preparing') return
    if (timer) clearTimeout(timer)
    timer = undefined
    choice = Object.freeze(value)
    logLibraryOperation('library', 'startup.preference', 'complete', {
      code, elapsedMs: Math.max(0, (options.now?.() ?? performance.now()) - preferenceStarted),
    })
    resolveChoice(choice)
  }
  function fail(error: unknown, closed = false): void {
    if (state === 'closed' || state === 'failed') return
    state = closed ? 'closed' : 'failed'
    if (timer) clearTimeout(timer)
    timer = undefined
    rejectChoice(error)
    rejectReady(error)
  }

  return {
    nonce: options.nonce,
    bindWindow(value: RemoteCoreStartupWindow): void {
      if (window || state !== 'preparing' || options.currentWindow() !== value) throw new StartupError()
      window = value
    },
    assertCurrent,
    acceptPreference(event: RemoteCoreStartupSender, value: unknown): boolean {
      const input = assertSender(event, value, ['version', 'nonce', 'readable', 'autoStart', 'sshTarget'])
      if (typeof input.readable !== 'boolean' || typeof input.autoStart !== 'boolean'
        || input.sshTarget !== null && (typeof input.sshTarget !== 'string' || input.sshTarget.length > 255)
        || !input.readable && (input.autoStart || input.sshTarget !== null)) throw new StartupError()
      if (choice || state === 'ready') return false
      if (preferenceDeadline !== undefined && (options.now?.() ?? performance.now()) >= preferenceDeadline) {
        select({ autoStart: false, sshTarget: undefined }, 'PREFERENCE_TIMEOUT')
        return false
      }
      const stored = typeof input.sshTarget === 'string' ? input.sshTarget.trim() : ''
      const target = stored || (isSafeSshTarget(options.suggestedTarget) ? options.suggestedTarget : undefined)
      select({ autoStart: input.readable && input.autoStart, sshTarget: target }, input.readable ? 'PREFERENCE_ACCEPTED' : 'PREFERENCE_UNAVAILABLE')
      return true
    },
    async waitUntilReady(event: RemoteCoreStartupSender, value: unknown): Promise<void> {
      assertSender(event, value, ['version', 'nonce'])
      await ready
      assertSender(event, value, ['version', 'nonce'])
    },
    markCoreActivation(): void {
      if (state === 'ready') return
      assertCurrent()
      attempted = true
    },
    activate(dependencies: {
      startLocal(): Promise<void>
      startRemote(target: string): Promise<unknown>
      isCoreReady(): boolean
    }): Promise<void> {
      if (activation) return activation
      const run = async () => {
        assertCurrent()
        if (!choice) {
          preferenceDeadline = (options.now?.() ?? performance.now()) + REMOTE_CORE_STARTUP_PREFERENCE_MS
          timer = setTimeout(() => select({ autoStart: false, sshTarget: undefined }, 'PREFERENCE_TIMEOUT'), REMOTE_CORE_STARTUP_PREFERENCE_MS)
        }
        const preference = await selected
        assertCurrent()
        const activationStarted = options.now?.() ?? performance.now()
        if (preference.autoStart && preference.sshTarget) {
          remoteActivationPending = true
          try { await dependencies.startRemote(preference.sshTarget) }
          finally { remoteActivationPending = false }
          assertCurrent()
        }
        if (!dependencies.isCoreReady()) {
          // 已尝试远程激活但连原回退也未就绪，不能再盲启第三轮。
          if (attempted) throw new StartupError()
          attempted = true
          await dependencies.startLocal()
          assertCurrent()
        }
        if (!dependencies.isCoreReady()) throw new StartupError()
        activated = true
        logLibraryOperation('library', 'startup.core-activation', 'complete', {
          code: 'CORE_READY', elapsedMs: Math.max(0, (options.now?.() ?? performance.now()) - activationStarted),
        })
      }
      activation = run()
      void activation.catch(error => fail(error))
      return activation
    },
    complete(): void {
      assertCurrent()
      if (!activated) throw new StartupError()
      state = 'ready'
      resolveReady()
    },
    fail(error: unknown): void { fail(error) },
    cancel(): void { fail(new StartupError(), true) },
    get cancelled(): boolean { return state === 'closed' },
    get remoteActivationPending(): boolean { return remoteActivationPending },
  }
}
