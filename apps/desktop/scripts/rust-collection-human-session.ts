import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createRequire } from 'node:module'
import { createWriteStream, writeFileSync } from 'node:fs'
import { access, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { execFileSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import type { HumanSessionReceipt } from '../test/helpers/rust-collection-human-evidence.js'

export type SessionMode = 'node100' | 'rust100' | 'rust2000' | 'rust5000'
export type TerminalCommand = 'status' | 'refresh' | 'quit'
export interface SessionArguments { driverManifestPath: string; sessionParent: string; mode: SessionMode }
export interface ControlRecord {
  sequence: number; command: TerminalCommand; source: 'terminal' | 'automated-smoke' | 'expiry' | 'application-menu'
  startedMs: number; completedMs: number; outcome: 'success' | 'rejected'
}

/** 启动模式只属于可信本地启动器；运行环境与 Renderer 不参与选择。 */
export function parseSessionArguments(args: readonly string[]): SessionArguments {
  const fields = new Map<string, string>()
  for (const argument of args) {
    const match = /^--(manifest|session-parent|mode)=(.+)$/.exec(argument)
    assert.ok(match && !fields.has(match[1]!), '参数无效或重复；仅允许 manifest、session-parent、mode。')
    fields.set(match[1]!, match[2]!)
  }
  const driverManifestPath = fields.get('manifest') ?? '', sessionParent = fields.get('session-parent') ?? ''
  assert.ok(path.isAbsolute(driverManifestPath) && path.isAbsolute(sessionParent), 'manifest 与会话父目录必须是绝对路径。')
  const mode = fields.get('mode') ?? 'node100'
  assert.ok(['node100', 'rust100', 'rust2000', 'rust5000'].includes(mode), '模式必须是 node100、rust100、rust2000 或 rust5000。')
  return { driverManifestPath, sessionParent, mode: mode as SessionMode }
}

export function parseTerminalCommand(line: string): TerminalCommand {
  assert.ok(['status', 'refresh', 'quit'].includes(line), '指令无效；仅允许精确的 status、refresh、quit。')
  return line as TerminalCommand
}

export interface ControllerDependencies {
  status(): Promise<unknown>; refresh(): Promise<unknown>; quit(source: ControlRecord['source']): Promise<unknown>
  onControl(record: ControlRecord): void; now?(): number
}

/** 每一条可信指令都串行执行，失败原样拒绝，退出一经排队就封闭新输入。 */
export function createSessionController(dependencies: ControllerDependencies) {
  let queue: Promise<unknown> = Promise.resolve(), closing = false, sequence = 0, pendingCount = 0, expired = false
  let quitting: Promise<unknown> | undefined
  const now = dependencies.now ?? (() => performance.now())
  return {
    execute(line: string, source: ControlRecord['source'] = 'terminal'): Promise<unknown> {
      const command = parseTerminalCommand(line)
      if (command === 'quit' && source === 'expiry') {
        // 只取消尚未开始的工作；当前原刷新预算和真实资源关闭路径保持。
        expired = true
        if (quitting) return quitting
      }
      assert.ok(!closing, '会话正在关闭，不再接受新指令。')
      assert.ok(command === 'quit' || pendingCount < 64, '终端指令积压已达上限，请等待当前请求完成。')
      if (command === 'quit') closing = true
      const number = ++sequence; pendingCount++
      const pending = queue.then(async () => {
        const startedMs = now()
        try {
          if (expired && command !== 'quit') throw new Error('会话已经到期，尚未开始的指令已撤销。')
          const result = command === 'status' ? await dependencies.status()
            : command === 'refresh' ? await dependencies.refresh() : await dependencies.quit(source)
          dependencies.onControl({ sequence: number, command, source, startedMs, completedMs: now(), outcome: 'success' })
          return result
        } catch (error) {
          dependencies.onControl({ sequence: number, command, source, startedMs, completedMs: now(), outcome: 'rejected' })
          throw error
        } finally {
          pendingCount--
        }
      })
      queue = pending.catch(() => undefined)
      if (command === 'quit') quitting = pending
      return pending
    },
    isClosing: () => closing,
    settled: () => queue,
  }
}

export const OWNER_SESSION_BUDGET_MS = 30 * 60 * 1000
const EXTERNAL_ROOT = '/Volumes/LifeWeave/Developer/CommandLine'
const MODES = {
  node100: { models: 100, rust: false, wrapper: 'private-rust-collection-node-main-wrapper.mjs' },
  rust100: { models: 100, rust: true, wrapper: 'private-rust-collection-main-100-wrapper.mjs' },
  rust2000: { models: 2000, rust: true, wrapper: 'private-rust-collection-main-2000-wrapper.mjs' },
  rust5000: { models: 5000, rust: true, wrapper: 'private-rust-collection-main-5000-wrapper.mjs' },
} as const

const LAUNCH_SIGNALS = { SIGINT: 'sigintHandler', SIGTERM: 'sigtermHandler', SIGHUP: 'sighupHandler' } as const
const PLAYWRIGHT_CORE_SHA256 = '9393fa79e1c67c74edc26b610d65a4f7ed73d345a762465cc88340a33a2454ac'
type LaunchSignal = keyof typeof LAUNCH_SIGNALS
interface SignalListenerHost {
  on(event: string | symbol, listener: (...args: any[]) => void): unknown
  listeners(event: string | symbol): Function[]
}
export interface LaunchSignalIdentity {
  file: string; sha256: string; version: '1.62.1'; signatures: Record<LaunchSignal, string>
}
export interface LaunchSignalEvidence {
  dependencyPath: string; dependencySha256: string; version: string
  preservedAtStart: Record<LaunchSignal, number>
  suppressed: { signal: LaunchSignal; name: string; sourceSha256: string }[]
  restored: boolean
}
const launchOwners = new WeakSet<object>()

/** 只读验证固定依赖；不执行 Electron installer，也不修改 Playwright。 */
export async function verifyPlaywrightSignalIdentity(): Promise<LaunchSignalIdentity> {
  const require = createRequire(import.meta.url)
  const testEntry = require.resolve('@playwright/test')
  const playwrightEntry = createRequire(testEntry).resolve('playwright')
  const coreEntry = createRequire(playwrightEntry).resolve('playwright-core')
  const root = path.dirname(coreEntry), file = path.join(root, 'lib/coreBundle.js')
  const source = await readFile(file, 'utf8')
  const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  return parsePlaywrightSignalIdentity(file, source, metadata.version)
}

/** 纯身份校验与真实只读取文件分开，允许在不改依赖的情况下证明漂移拒绝。 */
export function parsePlaywrightSignalIdentity(file: string, source: string, version: unknown): LaunchSignalIdentity {
  const sha256 = createHash('sha256').update(source).digest('hex')
  assert.ok(version === '1.62.1' && sha256 === PLAYWRIGHT_CORE_SHA256, '固定 Playwright 信号实现发生漂移，拒绝启动。')
  const signatures = {} as Record<LaunchSignal, string>
  for (const [signal, name] of Object.entries(LAUNCH_SIGNALS) as [LaunchSignal, string][]) {
    const start = source.indexOf(`function ${name}()`), end = source.indexOf('\nfunction ', start + 1)
    assert.ok(start >= 0 && end > start && source.indexOf(`function ${name}()`, start + 1) === -1, '固定 Playwright 信号签名不唯一。')
    signatures[signal] = source.slice(start, end).trim()
  }
  return { file, sha256, version: '1.62.1', signatures }
}

/** 仅本次 launch 异步上下文内的固定 PW 回调被隔离；其他监听器照常注册和接收信号。 */
export async function withElectronLaunchSignalOwnership<T>(identity: LaunchSignalIdentity, evidence: LaunchSignalEvidence,
  launch: () => Promise<T>, target: SignalListenerHost = process): Promise<T> {
  assert.ok(!launchOwners.has(target), '同一进程已有尚未交付的合成 launch，不能竞争信号所有权。')
  const original = target.on, descriptor = Object.getOwnPropertyDescriptor(target, 'on')
  for (const signal of Object.keys(LAUNCH_SIGNALS) as LaunchSignal[]) {
    const existing = target.listeners(signal)
    evidence.preservedAtStart[signal] = existing.length
    assert.ok(!existing.some(listener => Function.prototype.toString.call(listener) === identity.signatures[signal]), '已有 Playwright 会话持有信号监听器，不能撤销其他会话的监听器。')
  }
  const context = new AsyncLocalStorage<object>(), token = {}, intercepted = new Set<LaunchSignal>()
  const wrapper = function(this: SignalListenerHost, event: string | symbol, listener: (...args: any[]) => void) {
    const signal = event as LaunchSignal, expectedName = LAUNCH_SIGNALS[signal]
    if (this === target && context.getStore() === token && expectedName && listener.name === expectedName) {
      assert.equal(Function.prototype.toString.call(listener), identity.signatures[signal], '本次 Playwright 信号回调签名未知，拒绝宽泛过滤。')
      assert.ok(!intercepted.has(signal), '本次 launch 重复注册固定信号回调。')
      intercepted.add(signal)
      evidence.suppressed.push({ signal, name: expectedName, sourceSha256: createHash('sha256').update(identity.signatures[signal]).digest('hex') })
      return this
    }
    return Reflect.apply(original, this, [event, listener])
  }
  launchOwners.add(target)
  try {
    Object.defineProperty(target, 'on', { configurable: true, writable: true, value: wrapper })
    const result = await context.run(token, launch)
    assert.equal(intercepted.size, 3, '本次 Electron launch 未交付完整已核信号所有权。')
    return result
  } finally {
    launchOwners.delete(target)
    // 其他调用方若接管了注册方法，不能用旧引用覆盖它；失败现场由稳定 owned 句柄收口。
    assert.equal(target.on, wrapper, '信号注册方法被其他调用方更换，拒绝覆盖其所有权。')
    if (descriptor) Object.defineProperty(target, 'on', descriptor)
    else Reflect.deleteProperty(target, 'on')
    evidence.restored = target.on === original
    assert.ok(evidence.restored, '本次信号注册方法未恢复原身份。')
  }
}

interface ScopeElectron {
  ipcMain: { handle(channel: string, listener: (...args: any[]) => any): void; removeHandler(channel: string): void }
  dialog: { showOpenDialog: (...args: any[]) => any; showSaveDialog: (...args: any[]) => any }
  BrowserWindow: { getAllWindows(): { isVisible(): boolean }[] }
}
/** 固定 Electron43 测试 seam；全量拒绝未知入口，保留收藏原 handler 与原回执。 */
export function installMainScopeBoundary(electron: ScopeElectron, input: { sessionId: string }) {
  // 此函数会被 Playwright 序列化进入真实 Main，因此所有闭集和校验均在函数内部。
  const channels = [
    'app:get-info', 'app:set-appearance-theme', 'core:get-health', 'core:get-state', 'core:ping',
    'auth:get-state', 'account:get-state', 'playback:get-state', 'playback:get-stream-snapshot',
    'remote-core:get-state', 'roon:list-zones', 'lyrics:match:get',
    'commandOutbox:context', 'commandOutbox:overview', 'commandOutbox:acknowledge',
    'collection:list', 'collection:detail', 'collection:photo', 'collection:copy',
    'collectionProgress:wants', 'collectionProgress:wantHistory', 'collectionProgress:current',
    'collectionProgress:snapshots', 'collectionProgress:snapshot', 'collectionProgress:modelLengths',
    'referenceCatalog:sources', 'referenceCatalog:source', 'referenceCatalog:sourceZipReceipts',
    'referenceCatalog:history', 'referenceCatalog:revision', 'referenceCatalog:snapshot',
  ]
  const map = (electron.ipcMain as ScopeElectron['ipcMain'] & { _invokeHandlers?: Map<string, (...args: any[]) => any> })._invokeHandlers
  if (!(map instanceof Map) || map.size === 0 || Array.from(map).some(([key, value]) => typeof key !== 'string' || typeof value !== 'function')) throw new Error('合成隔离无法验证实际 Main handler 全集。')
  for (const required of ['collection:list', 'collection:detail', 'collection:photo', 'commandOutbox:submit', 'commandOutbox:context', 'commandOutbox:acknowledge', 'remote-core:start']) {
    if (!map.has(required)) throw new Error('合成隔离缺少必要原 Main handler。')
  }
  if (electron.BrowserWindow.getAllWindows().some(window => window.isVisible())) throw new Error('合成隔离必须安装在窗口显示之前。')
  const originals = new Map(map), allowed = new Set(channels), blockedAttempts: { sequence: number; channel: string; code: string; requestCommand?: string }[] = []
  const boundary = { policy: 'synthetic-collection-only-v1', sessionId: input.sessionId, installedBeforeVisible: true,
    visibleBeforeInstallation: false, dialogBlocked: true, futureRegistrationsGuarded: true,
    registeredChannels: Array.from(originals.keys()).sort(), allowedChannels: channels.filter(channel => originals.has(channel)).sort(),
    conditionalChannels: ['commandOutbox:submit'], conditionalOutboxCommands: ['collection.setPolicy'], blockedChannels: Array.from(originals.keys()).filter(channel => !allowed.has(channel) && channel !== 'commandOutbox:submit').sort(), blockedAttempts,
    trayPlayback: 'original-Core-testmock-only', productionHandlersPreserved: true }
  const denied = (channel: string, requestCommand?: string): never => {
    blockedAttempts.push({ sequence: blockedAttempts.length + 1, channel, code: 'SYNTHETIC_SCOPE_DENIED',
      ...(requestCommand ? { requestCommand: requestCommand === 'collection.receive' ? requestCommand : 'outside-approved-policy' } : {}) })
    throw new Error('[SYNTHETIC_SCOPE_DENIED] 合成人工验收仅开放收藏浏览与合成 policy；该入口超出本次范围。')
  }
  const guard = (channel: string, original: (...args: any[]) => any) => (...args: any[]) => {
    if (allowed.has(channel)) return original(...args)
    if (channel === 'commandOutbox:submit') {
      const value = args[1]
      if (value && typeof value === 'object' && !Array.isArray(value) && value.request?.command === 'collection.setPolicy'
        && value.retryConfirmed === undefined && Object.keys(value).every(key => key === 'request')) return original(...args)
    }
    return denied(channel, channel === 'commandOutbox:submit' ? args[1]?.request?.command : undefined)
  }
  const register = electron.ipcMain.handle.bind(electron.ipcMain)
  for (const [channel, original] of originals) { electron.ipcMain.removeHandler(channel); register(channel, guard(channel, original)) }
  Object.defineProperty(electron.ipcMain, 'handle', { configurable: false, writable: false, value(channel: string, handler: (...args: any[]) => any) { register(channel, guard(channel, handler)) } })
  Object.defineProperty(electron.dialog, 'showOpenDialog', { configurable: false, writable: false, value: () => denied('native.showOpenDialog') })
  Object.defineProperty(electron.dialog, 'showSaveDialog', { configurable: false, writable: false, value: () => denied('native.showSaveDialog') })
  if (map.size !== originals.size || Array.from(map.keys()).sort().join('\n') !== boundary.registeredChannels.join('\n')) throw new Error('合成隔离替换前后 handler 全集发生变化。')
  const global = globalThis as typeof globalThis & { __rust010ScopeBoundary?: typeof boundary }
  global.__rust010ScopeBoundary = boundary
  // 实际受保护 Main handler 的拒绝自检，不调用原 handler 或真实服务。
  for (const channel of ['remote-core:start', 'library:read', 'collection:pick-photo', 'lyrics:display:configure', 'commandOutbox:submit']) {
    if (!map.has(channel)) throw new Error('合成隔离缺少范围外入口。')
    let rejected = false
    try { map.get(channel)!({}, channel === 'commandOutbox:submit' ? { request: { command: 'collection.receive' } } : {}) } catch (error) { rejected = String(error).includes('SYNTHETIC_SCOPE_DENIED') }
    if (!rejected) throw new Error('合成隔离拒绝自检失败。')
  }
  for (const [channel, probe] of [['native.showOpenDialog', electron.dialog.showOpenDialog], ['native.showSaveDialog', electron.dialog.showSaveDialog]] as const) {
    let rejected = false
    try { probe() } catch (error) { rejected = String(error).includes('SYNTHETIC_SCOPE_DENIED') }
    if (!rejected) throw new Error(`合成隔离拒绝自检失败：${channel}`)
  }
  return boundary
}

/** tsx保留函数名时注入的 __name 只在这个可信隔离求值里提供，不污染生产 Main global。 */
export function evaluateMainScopeBoundary(electron: ScopeElectron, input: { sessionId: string; source: string }) {
  const install = new Function('electron', 'input', '__name', `return (${input.source})(electron, input)`)
  return install(electron, { sessionId: input.sessionId }, (value: unknown) => value)
}

/** Main求值VM没有动态import回调；只使用固定Electron Node的内建模块能力。 */
export function installMainLifecycleObserver(electron: { app: { once(event: string, listener: () => void): unknown } }, input: { file: string; sessionId: string }) {
  if (typeof process.getBuiltinModule !== 'function') throw new Error('已核 Electron Node 缺少内建模块能力，不能安装生命周期观察。')
  const builtin = process.getBuiltinModule('node:fs') as { writeFileSync?: (file: string, contents: string, options: { mode: number }) => void }
  if (typeof builtin?.writeFileSync !== 'function') throw new Error('已核 Electron Node 缺少真实内建文件写入能力。')
  const writeFileSync = builtin.writeFileSync
  electron.app.once('before-quit', () => {
    const boundary = (globalThis as typeof globalThis & { __rust010ScopeBoundary?: unknown }).__rust010ScopeBoundary
    writeFileSync(input.file, JSON.stringify({ sessionId: input.sessionId, electronPid: process.pid, beforeQuitObserved: true, boundary }) + '\n', { mode: 0o600 })
  })
  return { module: 'node:fs', capability: 'process.getBuiltinModule', nodeVersion: process.versions.node }
}

/** 只读预检，目录必须已经在外置卷；不创建本机回落目录。 */
export async function verifySessionParent(directory: string): Promise<string> {
  assert.equal(process.platform, 'darwin', '人工入口目前只准入已核本机 macOS。')
  assert.match(process.version, /^v22\./, '人工启动器必须使用 Node22。')
  const mounted = execFileSync('diskutil', ['info', '-plist', '/Volumes/LifeWeave'], { encoding: 'utf8' })
  assert.match(mounted, /<key>MountPoint<\/key>\s*<string>\/Volumes\/LifeWeave<\/string>/)
  assert.match(mounted, /<key>Internal<\/key>\s*<false\/>/)
  assert.match(mounted, /<key>WritableVolume<\/key>\s*<true\/>/)
  const resolved = await realpath(directory)
  assert.equal(resolved, path.resolve(directory), '会话父目录不能通过符号链接改向。')
  assert.ok(resolved.startsWith(`${EXTERNAL_ROOT}/tmp/`), '人工会话只能创建在外置临时根之下。')
  await access(resolved, constants.W_OK)
  return resolved
}

export interface RunningHumanSession {
  page: Page
  control(command: TerminalCommand, source?: ControlRecord['source']): Promise<unknown>
  receipt: Record<string, any>
}
/** 测试只缩短人工会话期限；不改变 Main worker、Rust 启动和请求预算。 */
export interface ControlledSmokeOptions {
  testBudgetMs?: number
  onReady?(session: RunningHumanSession): Promise<void>
}

type StableOwnedProcess = Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode'>
export function ownedProcessEvidence(owned?: StableOwnedProcess) {
  return owned ? { electronPid: owned.pid, electronExitCode: owned.exitCode, electronSignal: owned.signalCode } : { electronStarted: false }
}
/** 最终验证失败也必须落 failed；关闭后的包装器不再参与资源判定。 */
export async function verifyClosedSessionReceipt(receipt: Record<string, any>, owned: StableOwnedProcess,
  dependencies: { verify(receipt: Record<string, any>): unknown; persist(): Promise<void> }) {
  try { await dependencies.verify(receipt); await dependencies.persist() }
  catch (error) {
    receipt.state = 'failed'
    receipt.failure = { code: 'FINAL_EVIDENCE_REJECTED', message: '进程已结束，但最终资源或身份未满足准入；不能记作通过。' }
    receipt.unclosedResources = ownedProcessEvidence(owned)
    await dependencies.persist()
    throw error
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!await check()) {
    if (performance.now() >= deadline) throw new Error(`会话等待失败：${label}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/** 原Main隐藏窗口完成DOM加载后才能关闭；中断标记不能把启动过程变成失败退出。 */
export function createOriginalMainStartupBarrier<T>(dependencies: { waitForWindow(): Promise<T>; quit(): Promise<void>; hasExited?(): boolean }, budgetMs = 30_000) {
  let startup: Promise<T> | undefined, closing: Promise<void> | undefined
  const wait = () => {
    if (!startup) {
      let timer: ReturnType<typeof setTimeout>, exitPoll: ReturnType<typeof setInterval>
      const deadline = new Promise<never>((_, reject) => {
        const checkExit = () => { if (dependencies.hasExited?.()) reject(new Error('原Main在稳定窗口出现前已退出，不能冒称已稳定。')) }
        timer = setTimeout(() => reject(new Error('原隐藏Main启动屏障等待超时，不能冒称已稳定。')), budgetMs)
        exitPoll = setInterval(checkExit, 25)
        checkExit()
      })
      startup = Promise.race([Promise.resolve().then(dependencies.waitForWindow), deadline]).finally(() => { clearTimeout(timer); clearInterval(exitPoll) })
    }
    return startup
  }
  return {
    wait,
    quit() {
      // 中断期间的控制器与catch共用一次关闭；未观察到稳定窗口时保留失败资源事实。
      closing ??= wait().then(() => dependencies.quit())
      return closing
    },
  }
}

function childEnvironment(sessionRoot: string, profile: string): NodeJS.ProcessEnv {
  const values: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TZ', 'DISPLAY']) {
    if (process.env[key] !== undefined) values[key] = process.env[key]
  }
  return { ...values, NODE_ENV: 'test', TMPDIR: sessionRoot, DEV_BUILD_ROOT: EXTERNAL_ROOT,
    DEV_CACHE_ROOT: `${EXTERNAL_ROOT}/Caches`, NODE_COMPILE_CACHE: `${EXTERNAL_ROOT}/Caches/Node`,
    ELECTRON_CACHE: `${EXTERNAL_ROOT}/Caches/Electron`, electron_config_cache: `${EXTERNAL_ROOT}/Caches/Electron`,
    XDG_CACHE_HOME: `${EXTERNAL_ROOT}/Caches/XDG`, ELECTRON_SKIP_BINARY_DOWNLOAD: '1',
    MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_CORE_TEST_MODE: '1', MUSIC_BRIDGE_UI_E2E_OFFLINE: '1',
    MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: profile, MUSIC_BRIDGE_UI_E2E_LIFECYCLE_TRACE: '1' }
}

/** 可见会话与自动 smoke 分列；只有 Owner 自己操作才属于人工体验。 */
export async function runHumanSession(options: SessionArguments, smoke: ControlledSmokeOptions = {}): Promise<Record<string, any>> {
  const checked = parseSessionArguments([`--manifest=${options.driverManifestPath}`, `--session-parent=${options.sessionParent}`, `--mode=${options.mode}`])
  const parent = await verifySessionParent(checked.sessionParent)
  const { verifyHumanSessionIdentity, verifyHumanSessionReadiness, verifyHumanSessionEvidence, humanSessionFileSha256 } = await import('../test/helpers/rust-collection-human-evidence.js')
  // 此处之前没有 seed、profile 创建或 Electron 启动。完整身份验证失败即停止。
  const identity = verifyHumanSessionIdentity({ driverManifestPath: checked.driverManifestPath })
  const signalIdentity = await verifyPlaywrightSignalIdentity()
  const durationMs = smoke.testBudgetMs ?? OWNER_SESSION_BUDGET_MS
  assert.ok(Number.isSafeInteger(durationMs) && durationMs > 0 && durationMs <= OWNER_SESSION_BUDGET_MS, '受控期限无效。')
  const automated = smoke.onReady !== undefined || smoke.testBudgetMs !== undefined
  const mode = MODES[checked.mode], sessionId = randomUUID(), tick = performance.now(), now = () => performance.now() - tick
  const sessionRoot = await mkdtemp(path.join(parent, 'musicbridge-human-session-'))
  const profile = await mkdtemp(path.join(sessionRoot, 'musicbridge-ui-e2e-human-'))
  const receipt: Record<string, any> = { schemaVersion: 1, task: 'RUST-010', sessionId, state: 'starting', mode: checked.mode,
    identity, sessionRoot, profile, profileWasFresh: true, controls: [], ownerAcceptance: 'NOT_RUN',
    productionDefault: 'Node', realServices: 'NOT_RUN', systemKeychain: 'NOT_RUN', installedApplication: 'NOT_CHANGED',
    signalOwnership: { dependencyPath: signalIdentity.file, dependencySha256: signalIdentity.sha256, version: signalIdentity.version,
      preservedAtStart: {}, suppressed: [], restored: false } }
  const receiptPath = path.join(sessionRoot, 'session.json'), readinessPath = path.join(sessionRoot, 'readiness.json')
  const persist = async () => { await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 }) }
  let application: ElectronApplication | undefined, owned: ChildProcess | undefined, expiry: ReturnType<typeof setTimeout> | undefined
  let terminal: ReturnType<typeof createInterface> | undefined, failure = false, requestedBy: ControlRecord['source'] = 'application-menu'
  let controller: ReturnType<typeof createSessionController> | undefined
  let startupBarrier: ReturnType<typeof createOriginalMainStartupBarrier<Page>> | undefined
  const signal = () => {
    failure = true
    if (controller && !controller.isClosing()) void controller.execute('quit', 'terminal').catch(() => undefined)
  }
  process.on('SIGINT', signal); process.on('SIGTERM', signal); process.on('SIGHUP', signal)
  const log = createWriteStream(path.join(sessionRoot, 'electron.log'), { flags: 'wx', mode: 0o600 })
  const checkStarting = () => { assert.ok(!failure, '启动会话已经中断，不得写入或宣告 ready。') }
  try {
    const { seedCollectionHost } = await import('../test/helpers/rust-collection-host-seed.js')
    receipt.seed = { ...await seedCollectionHost(profile, mode.models), writer: 'Node-before-Main', closedBeforeLaunch: true }
    const { _electron: electron } = await import('@playwright/test')
    const { testElectronArguments } = await import('./test-keychain.mjs')
    const { waitForMainWindow } = await import('../e2e/main-window.js')
    assert.ok(!failure, '启动前会话已中断。')
    startupBarrier = createOriginalMainStartupBarrier({
      async waitForWindow() {
        assert.ok(application, '原Main启动屏障缺少真实应用。')
        const startedMs = now(), page = await waitForMainWindow(application)
        receipt.startupBarrier = { marker: 'production-Main-window-DOMContentLoaded', budgetMs: 30_000,
          startedMs, completedMs: now(), url: page.url() }
        return page
      },
      async quit() {
        assert.ok(application && owned, '原Main关闭屏障缺少稳定应用与进程句柄。')
        await application.evaluate(({ app }) => { app.quit() }).catch(() => undefined)
        await waitFor(() => owned!.exitCode !== null || owned!.signalCode !== null, '原稳定Main自然退出')
      },
      hasExited: () => owned !== undefined && (owned.exitCode !== null || owned.signalCode !== null),
    })
    await withElectronLaunchSignalOwnership(signalIdentity, receipt.signalOwnership, async () => {
      application = await electron.launch({ executablePath: identity.electronManifest.executable.path,
      args: testElectronArguments([path.join(path.dirname(identity.driverManifest.componentManifestPath), 'main', mode.wrapper)], 'mock'),
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
      env: Object.fromEntries(Object.entries(childEnvironment(sessionRoot, profile)).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
        timeout: 60_000 })
      // 恢复临时注册包装器即使失败，也不能丢失已启动的真实应用与进程句柄。
      owned = application.process()
    })
    assert.ok(application, '启动器未交付真实应用。')
    assert.ok(owned, '启动器未交付可追踪的真实进程句柄。')
    owned.stdout?.on('data', chunk => { log.write(chunk) }); owned.stderr?.on('data', chunk => { log.write(chunk) })
    receipt.electronPid = owned.pid
    const app = application, lifecyclePath = path.join(profile, 'human-lifecycle.json')
    receipt.lifecycleObserver = await app.evaluate(installMainLifecycleObserver, { file: lifecyclePath, sessionId })
    // 启动期现场即刻落盘，受控信号直接针对 driver，绝不强杀 Electron。
    await persist()
    // 信号即使在launch或持久化期间到达，也必须等原bootstrap生成隐藏生产页后才能quit。
    const page = await startupBarrier.wait()
    checkStarting()
    const status = async () => await app.evaluate(async () => {
      const host = (globalThis as typeof globalThis & { __rust009Host: { control(operation: string): Promise<any> } }).__rust009Host
      return host.control('status')
    })
    const processHandle = owned
    // 原bootstrap稳定后交付退出能力；中断不必等到两次worker claim或人工期限结束。
    controller = createSessionController({
      now,
      async status() {
        const state = await status(); receipt.host = state
        return { sessionId, state: receipt.state, mode: checked.mode, profile, phase: state.controller?.router?.phase ?? 'node',
          generation: state.controller?.router?.generation, scope: state.controller?.router, rustConfigured: state.rustConfigured }
      },
      async refresh() {
        const refreshed = await app.evaluate(async () => (globalThis as typeof globalThis & { __rust009Host: { control(operation: string): Promise<any> } }).__rust009Host.control('refresh'))
        receipt.host = refreshed
        return { phase: refreshed.controller?.router?.phase, generation: refreshed.controller?.router?.generation, scope: refreshed.controller?.router }
      },
      async quit(source) {
        requestedBy = source; receipt.state = 'closing'; await persist()
        await startupBarrier!.quit()
      },
      onControl(record) { receipt.controls.push(record) },
    })
    checkStarting()
    await page.locator('[data-sidebar-source="collection"]').waitFor()
    checkStarting()
    receipt.boundary = await app.evaluate(evaluateMainScopeBoundary, { sessionId, source: installMainScopeBoundary.toString() })
    checkStarting()
    const title = `MusicBridge · 合成人工验收 · ${checked.mode} · ${sessionId.slice(0, 8)}`
    const window = await app.evaluate(({ app, BrowserWindow }, input) => {
      const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL() === 'musicbridge://app/index.html')
      if (!window) throw new Error('未找到原生产页面窗口。')
      window.webContents.on('page-title-updated', event => { event.preventDefault(); window.setTitle(input.title) })
      window.setTitle(input.title); window.show(); app.focus({ steal: true }); window.focus()
      return { browserWindowId: window.id, electronPid: process.pid }
    }, { title })
    checkStarting()
    await waitFor(async () => {
      checkStarting()
      const state = await status()
      checkStarting()
      return state.observations.filter((entry: any) => entry.event === 'core.publicReply' && entry.command === 'recordingPrintWorker.claim' && entry.leaseNull === true).length >= 2
    }, '原1500ms worker至少两次公开空claim')
    checkStarting()
    receipt.visibleWindow = { ...window, ...await app.evaluate(({ BrowserWindow }, id) => {
      const window = BrowserWindow.fromId(id)!
      return { isVisible: window.isVisible(), isFocused: window.isFocused(), title: window.getTitle(), url: window.webContents.getURL() }
    }, window.browserWindowId), mounted: await page.evaluate(() => Boolean(document.querySelector('#app')?.children.length)), models: mode.models }
    checkStarting()
    receipt.runtimeVersions = await app.evaluate(() => ({ node: process.versions.node, electron: process.versions.electron, chrome: process.versions.chrome }))
    checkStarting()
    receipt.host = await status()
    checkStarting()
    receipt.main = await app.evaluate(() => (globalThis as typeof globalThis & { __rust009Host: { snapshot(): { main: unknown } } }).__rust009Host.snapshot().main)
    checkStarting()
    const startedMs = now()
    receipt.budget = { durationMs, kind: automated ? 'automated-smoke' : 'owner-session', startedMs, deadlineMs: startedMs + durationMs }
    receipt.state = 'ready'
    verifyHumanSessionReadiness(receipt as HumanSessionReceipt)
    checkStarting()
    // readiness提交不在状态切换中间让出事件循环；退出控制器已经登记。
    writeFileSync(readinessPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
    receipt.readinessReceiptPath = readinessPath
    receipt.readinessReceiptSha256 = humanSessionFileSha256(readinessPath)
    await persist()
    checkStarting()
    process.stdout.write(`合成人工验收会话已显示：${checked.mode}\n会话：${sessionId}\n合成 profile：${profile}\n期限：${Math.ceil(durationMs / 60_000)}分钟；红点只隐藏。终端仅 status / refresh / quit。\nOwner 验收：NOT_RUN\n`)
    expiry = setTimeout(() => {
      void controller!.execute('quit', 'expiry').catch(() => { failure = true })
    }, durationMs)
    if (!automated) {
      terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY })
      terminal.on('line', line => {
        try { void controller!.execute(line).then(result => { if (result !== undefined) process.stdout.write(JSON.stringify(result) + '\n') }, () => { process.stderr.write(checked.mode === 'node100' && line === 'refresh' ? '默认 Node 没有 Rust 控制器；刷新被拒绝，模式仍为 Node。\n' : '指令被拒绝；未自动重试。\n') }) }
        catch { process.stderr.write('指令无效或会话正在关闭；仅允许 status / refresh / quit。\n') }
      })
    }
    if (smoke.onReady) await smoke.onReady({ page, receipt, control: (command, source = 'automated-smoke') => controller!.execute(command, source) })
    await waitFor(() => processHandle.exitCode !== null || processHandle.signalCode !== null, '人工会话终止', durationMs + 30_000)
    await controller.settled()
    if (!controller.isClosing()) receipt.controls.push({ sequence: receipt.controls.length + 1, command: 'quit', source: 'application-menu', startedMs: now(), completedMs: now(), outcome: 'success' })
    const final = JSON.parse(await readFile(path.join(profile, 'rust009-main-evidence.json'), 'utf8'))
    const lifecycle = JSON.parse(await readFile(lifecyclePath, 'utf8'))
    receipt.host = final.final; receipt.main = final.main; receipt.coreExit = final.coreExit
    receipt.boundary = lifecycle.boundary
    // 退出前的范围拒绝观察单独留档；原业务 DTO 不被这个观察器替换。
    receipt.close = { method: 'app.quit', requestedBy, electronPid: owned.pid, electronExit: { code: owned.exitCode, signal: owned.signalCode },
      forcedCleanup: false, beforeQuitObserved: lifecycle.beforeQuitObserved === true, lifecyclePath, lifecycleSha256: humanSessionFileSha256(lifecyclePath) }
    receipt.state = failure ? 'failed' : 'closed'
    await verifyClosedSessionReceipt(receipt, owned, { verify: async value => {
      verifyHumanSessionEvidence(value as HumanSessionReceipt)
      assert.ok(!failure, '最终验收期间收到中断。')
    }, persist })
    process.stdout.write(`会话自然关闭：${receiptPath}\nOwner 验收：NOT_RUN\n`)
    return receipt
  } catch (error) {
    receipt.state = 'failed'; receipt.failure ??= { code: failure ? 'SESSION_INTERRUPTED' : 'SESSION_FAILED', message: '会话未满足准入或自然关闭要求；保留全部现场，不冒称通过。' }
    // 已经排队的原 app.quit 不再重发，避免第二次 before-quit 越过生产 shutdown。
    if (controller?.isClosing()) await controller.settled()
    if (!controller?.isClosing() && application && owned?.exitCode === null && owned.signalCode === null) {
      await startupBarrier?.quit().catch(() => undefined)
    }
    receipt.unclosedResources = ownedProcessEvidence(owned)
    try {
      const final = JSON.parse(await readFile(path.join(profile, 'rust009-main-evidence.json'), 'utf8'))
      receipt.host = final.final; receipt.main = final.main; receipt.coreExit = final.coreExit
    } catch { /* 启动失败时未产生完整 Core final；保留缺失事实。 */ }
    await persist()
    if (error && typeof error === 'object') Object.assign(error, { sessionRoot, receiptPath })
    throw error
  } finally {
    if (expiry) clearTimeout(expiry)
    terminal?.close(); log.end()
    process.removeListener('SIGINT', signal); process.removeListener('SIGTERM', signal); process.removeListener('SIGHUP', signal)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failed = () => {
    process.stderr.write('合成会话启动或关闭失败；请检查外置收据与日志，未执行隐式安装或自动重试。\n')
    process.exitCode = 1
  }
  try { void runHumanSession(parseSessionArguments(process.argv.slice(2))).catch(failed) }
  catch { failed() }
}
