import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import test, { type TestContext } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { IPC_VERSION, validateIpcEvent, type RemoteCoreMode } from '@music-bridge/contracts'
import { CoreSupervisor, type CoreChildProcess, type CoreMessagePort } from '../src/main/core-supervisor.js'
import { createRemoteCoreModeController } from '../src/main/remote-core-mode.js'
import { RemoteCoreTunnelManager, type RemoteSshProcess } from '../src/main/remote-core-tunnel.js'
import { createRemoteCoreStartup } from '../src/main/remote-core-startup.js'
import { createLocalWorkbenchQuitCoordinator } from '../src/main/local-library-workbench/quit-coordinator.js'
import { logLibraryOperation, readLibraryOperationLine, type LibraryOperationEvent } from '../../../packages/bridge-core/src/shared/library-operation-log.js'

const nonce = 'd0000000-0000-4000-8000-000000000001'
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const health = { runtime: 'ready', roon: 'disconnected', provider: 'missing', activeStreamCount: 0, activePlaybackPresent: false } as const
const preference = (autoStart = true, sshTarget: string | null = 'saved-core') => ({ version: 1, nonce, readable: true, autoStart, sshTarget })

class Port implements CoreMessagePort {
  private listener: ((event: { data: unknown }) => void) | undefined
  readonly sent: unknown[] = []
  closed = false
  constructor(readonly post: (value: unknown) => void = () => {}) {}
  on(_name: 'message', listener: (event: { data: unknown }) => void): void { this.listener = listener }
  start(): void {}
  close(): void { this.closed = true }
  postMessage(value: unknown): void { assert.equal(this.closed, false); this.sent.push(value); this.post(value) }
  receive(value: unknown): void { this.listener?.({ data: value }) }
}
class Child implements CoreChildProcess {
  readonly listeners: Array<(code: number) => void> = []
  exited = false
  killCount = 0
  postMessage(_value: unknown): void {}
  once(_name: 'exit', listener: (code: number) => void): void { this.listeners.push(listener) }
  kill(): boolean { this.killCount++; this.exit(); return true }
  exit(): void { if (this.exited) return; this.exited = true; for (const listener of this.listeners.splice(0)) listener(0) }
}
class Ssh extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  exited = false
  kill(): boolean {
    if (!this.exited) { this.exited = true; this.emit('exit', 0, null); this.emit('close', 0, null) }
    return true
  }
}

/** 仅合成child/SSH；实际Supervisor、模式控制器与隧道manager均走生产实现。 */
function fixture(t: TestContext, options: { health?: boolean; autoReady?: boolean; noShutdownAck?: boolean; now?: () => number } = {}) {
  const frame = { url: 'musicbridge://app/index.html' }
  const contents = { id: 7, mainFrame: frame }
  const window = { webContents: contents, isDestroyed: () => destroyed }
  let current: typeof window | undefined = window, destroyed = false, closing = false
  const startup = createRemoteCoreStartup({ nonce, suggestedTarget: 'environment-core', currentWindow: () => current, isClosing: () => closing, ...(options.now ? { now: options.now } : {}) })
  startup.bindWindow(window)
  const event = { sender: contents, senderFrame: frame }
  const channels: Port[] = [], children: Child[] = [], environments: NodeJS.ProcessEnv[] = [], order: string[] = []
  const supervisor = new CoreSupervisor({ entryPath: '/合成/不执行/core.js', cwd: '/合成/不执行', playbackEventProtocol: null,
    env: { MUSIC_BRIDGE_REMOTE_CORE_MODE: 'local-core' },
    onReady: () => { order.push('core-ready') }, dependencies: {
      createChannel() {
        const index = channels.length
        const primary = new Port(value => {
          const request = value as { command?: string; id?: string; type?: string }
          if (request.command === 'core.shutdown' && !options.noShutdownAck) queueMicrotask(() => primary.receive({ version: IPC_VERSION, id: request.id, ok: true, result: { stopped: true } }))
          if (request.type === 'musicbridge.core-shutdown-received') { order.push('shutdown-receipt'); queueMicrotask(() => children[index]!.exit()) }
        })
        channels.push(primary); return { port1: new Port(), port2: primary }
      },
      fork(_entry, _args, value) {
        const child = new Child(), index = children.length
        children.push(child); environments.push({ ...value.env }); order.push('spawn')
        if (options.autoReady !== false) queueMicrotask(() => channels[index]!.receive({ version: IPC_VERSION, event: 'core.ready', payload: { state: health } }))
        return child
      },
    } })
  supervisor.configurePrivatePersistentOwnerStartup()
  let mode: RemoteCoreMode = 'local-core', remoteStreamPort: number | undefined
  const controller = createRemoteCoreModeController({ readMode: () => ({ mode, remoteStreamPort }),
    setMode: (next, port) => { mode = next; remoteStreamPort = port; order.push(next) },
    restart: async () => {
      startup.markCoreActivation()
      await supervisor.restart({ MUSIC_BRIDGE_REMOTE_CORE_MODE: mode,
        ...(remoteStreamPort === undefined ? {} : { MUSIC_BRIDGE_REMOTE_STREAM_PORT: String(remoteStreamPort) }) })
    } })
  const ssh: Ssh[] = []
  const manager = new RemoteCoreTunnelManager({
    spawn(_command, args) {
      const child = new Ssh(); ssh.push(child)
      const reverse = args[args.indexOf('-R') + 1]!
      const port = reverse.split(':')[1]!
      queueMicrotask(() => child.stderr.emit('data', Buffer.from(`debug1: Local forwarding listening on 127.0.0.1 port 19330.\ndebug1: remote forward success for: listen 127.0.0.1:${port}, connect 127.0.0.1:38502\n`)))
      return child as unknown as RemoteSshProcess
    },
    onTunnelBound: state => { order.push('ssh-bound'); return controller.bound(state) },
    onTunnelUnavailable: state => controller.unavailable(state),
    healthProbe: async () => { assert.equal(supervisor.status, 'ready'); order.push('ssh-health'); return options.health !== false },
  })
  const dependencies = {
    startLocal: () => supervisor.start(),
    startRemote: (target: string) => manager.start({ sshTarget: target, remoteStreamPort: 38512, localStreamPort: 38502, autoReconnect: true }),
    isCoreReady: () => supervisor.status === 'ready',
  }
  t.after(async () => {
    startup.cancel(); controller.reset(); await manager.stop()
    const stop = supervisor.shutdown().catch(() => undefined)
    await turn(); for (const child of children) child.exit(); await stop
  })
  return { startup, event, window, contents, frame, supervisor, controller, manager, dependencies, children, channels, environments, order, ssh,
    ready(index = channels.length - 1) { channels[index]!.receive({ version: IPC_VERSION, event: 'core.ready', payload: { state: health } }) },
    revoke() { closing = true; startup.cancel(); controller.reset() },
    replaceWindow() { current = { ...window } },
    destroyWindow() { destroyed = true; startup.cancel() },
  }
}

test('首次健康SSH：真实Supervisor无child restart只spawn远程一代，health不等待总bootstrap', async t => {
  const startupLogs: LibraryOperationEvent[] = []
  t.mock.method(console, 'info', (line: string) => { const record = readLibraryOperationLine(line); if (record?.action.startsWith('startup.')) startupLogs.push(record) })
  const f = fixture(t)
  f.startup.acceptPreference(f.event, preference())
  // 仅离线重现旧顺序：同一真实Supervisor先本地start，再沿原manager绑定远程。
  const oldOrder = process.env.MB_COLD_START_BASELINE_REPRODUCTION === '1'
  const activation = oldOrder ? (async () => {
    await f.supervisor.start(); await f.dependencies.startRemote('saved-core')
  })() : f.startup.activate(f.dependencies)
  if (!oldOrder) assert.equal(f.startup.activate(f.dependencies), activation)
  let released = false
  const waiting = f.startup.waitUntilReady(f.event, { version: 1, nonce }).then(() => { released = true })
  void waiting.catch(() => undefined)
  await activation
  assert.equal(f.children.length, 1)
  assert.equal(f.environments[0]!.MUSIC_BRIDGE_REMOTE_CORE_MODE, 'remote-core-development')
  assert.equal(f.environments[0]!.MUSIC_BRIDGE_REMOTE_STREAM_PORT, '38512')
  assert.deepEqual(f.order, ['ssh-bound', 'remote-core-development', 'spawn', 'core-ready', 'ssh-health'])
  assert.equal(released, false, 'Core ready不能跳过后续账号/移动设置与IPC装配')
  f.order.push('provider', 'mobile', 'handlers'); f.startup.complete(); await waiting
  assert.equal(released, true)
  assert.equal(f.children[0]!.killCount, 0)
  assert.deepEqual(startupLogs.map(record => [record.action, record.code]), [['startup.preference', 'PREFERENCE_ACCEPTED'], ['startup.core-activation', 'CORE_READY']])
  assert.ok(startupLogs.every(record => record.elapsedMs !== undefined && record.elapsedMs >= 0 && !JSON.stringify(record).includes('saved-core')))
})

test('正常运行后同一窗口reload复用终态、不重新自动启动；显式换模式仍走原关闭回执', async t => {
  const f = fixture(t)
  f.startup.acceptPreference(f.event, preference()); await f.startup.activate(f.dependencies); f.startup.complete()
  const newFrame = { url: f.frame.url }; f.contents.mainFrame = newFrame
  const nextEvent = { sender: f.contents, senderFrame: newFrame }
  assert.equal(f.startup.acceptPreference(nextEvent, preference(true, 'other-core')), false)
  await f.startup.waitUntilReady(nextEvent, { version: 1, nonce })
  await assert.rejects(f.startup.waitUntilReady(f.event, { version: 1, nonce }))
  assert.equal(f.children.length, 1)
  await f.controller.bound({ ...f.manager.getState(), sshTarget: 'explicit-core', remoteStreamPort: 38513 })
  assert.equal(f.children.length, 2); assert.equal(f.children[0]!.exited, true)
  assert.ok(f.order.indexOf('shutdown-receipt') < f.order.lastIndexOf('spawn'))
  assert.equal(f.environments[1]!.MUSIC_BRIDGE_REMOTE_STREAM_PORT, '38513')
})

test('autoStart关闭和不可读取偏好均只启动本地，环境默认目标不覆盖用户关闭', async t => {
  for (const unreadable of [false, true]) {
    const f = fixture(t)
    f.startup.acceptPreference(f.event, unreadable ? { version: 1, nonce, readable: false, autoStart: false, sshTarget: null } : preference(false))
    await f.startup.activate(f.dependencies); f.startup.complete()
    assert.equal(f.ssh.length, 0); assert.equal(f.children.length, 1)
    assert.equal(f.environments[0]!.MUSIC_BRIDGE_REMOTE_CORE_MODE, 'local-core')
  }
})

test('偏好最多2秒，迟到autoStart不再触发第二轮；旧准备状态不冒充ready', async t => {
  const f = fixture(t)
  t.mock.timers.enable({ apis: ['setTimeout'] }); t.after(() => t.mock.timers.reset())
  const activating = f.startup.activate(f.dependencies)
  t.mock.timers.tick(1_999); await turn(); assert.equal(f.children.length, 0)
  assert.throws(() => f.startup.complete())
  t.mock.timers.tick(1); await activating; f.startup.complete()
  assert.equal(f.children.length, 1); assert.equal(f.ssh.length, 0)
  assert.equal(f.startup.acceptPreference(f.event, preference()), false)
})

test('真实健康检查失败仍等原远程Core正常退出再完整启动本地，不以优化删除回退', async t => {
  const f = fixture(t, { health: false })
  f.startup.acceptPreference(f.event, preference()); await f.startup.activate(f.dependencies)
  assert.equal(f.children.length, 2); assert.equal(f.children[0]!.exited, true)
  assert.equal(f.environments[0]!.MUSIC_BRIDGE_REMOTE_CORE_MODE, 'remote-core-development')
  assert.equal(f.environments[1]!.MUSIC_BRIDGE_REMOTE_CORE_MODE, 'local-core')
  assert.equal(f.manager.getState().errorCode, 'REMOTE_HEALTH_UNAVAILABLE')
  assert.ok(f.order.indexOf('shutdown-receipt') < f.order.lastIndexOf('spawn'))
  f.startup.complete()
})

test('偏好原绝对2秒期限已过，即使timer尚未调度也不能接受迟到远程目标', async t => {
  let now = 10
  const f = fixture(t, { now: () => now }), activation = f.startup.activate(f.dependencies)
  now = 2_010
  assert.equal(f.startup.acceptPreference(f.event, preference()), false)
  await activation; f.startup.complete()
  assert.equal(f.children.length, 1); assert.equal(f.ssh.length, 0)
})

test('绑定前失败可首次本地回退，已激活失败则不得盲启第三轮', async t => {
  const first = fixture(t)
  first.startup.acceptPreference(first.event, preference())
  await first.startup.activate({ ...first.dependencies, startRemote: async () => ({ status: 'failed' }) })
  assert.equal(first.children.length, 1); assert.equal(first.ssh.length, 0)
  const failed = fixture(t), original = new Error('原失败')
  failed.startup.acceptPreference(failed.event, preference())
  await assert.rejects(failed.startup.activate({ ...failed.dependencies, startRemote: async () => { failed.startup.markCoreActivation(); return { status: 'failed' } } }))
  assert.equal(failed.children.length, 0); assert.throws(() => failed.startup.complete())
  const thrown = fixture(t)
  thrown.startup.acceptPreference(thrown.event, preference())
  await assert.rejects(thrown.startup.activate({ ...thrown.dependencies, startRemote: async () => { throw original } }), error => error === original)
  assert.equal(thrown.children.length, 0)
})

test('Quit在偏好/绑定await时撤销原启动，迟到结果不能fallback或发布ready', async t => {
  for (const phase of ['preference', 'binding']) {
    const f = fixture(t), pending = deferred(); let remoteCalls = 0
    if (phase === 'binding') f.startup.acceptPreference(f.event, preference())
    const operation = f.startup.activate({ ...f.dependencies, startRemote: async () => { remoteCalls++; await pending.promise } })
    const rejected = assert.rejects(operation)
    await turn(); f.revoke(); pending.resolve(); await rejected
    assert.equal(f.children.length, 0); assert.equal(remoteCalls, phase === 'binding' ? 1 : 0)
    assert.throws(() => f.startup.markCoreActivation())
    await assert.rejects(f.startup.waitUntilReady(f.event, { version: 1, nonce }))
  }
})

test('Quit中原Core必须实际关闭，迟到ready不能放行Renderer或新Core', async t => {
  const f = fixture(t, { autoReady: false })
  f.startup.acceptPreference(f.event, preference(false)); const opening = f.startup.activate(f.dependencies)
  const rejected = assert.rejects(opening); await turn(); assert.equal(f.children.length, 1)
  f.revoke(); const closing = f.supervisor.shutdown(); f.ready()
  await rejected; await closing
  assert.equal(f.children.length, 1); assert.equal(f.children[0]!.exited, true)
  assert.throws(() => f.startup.complete())
})

test('远程回退原ACK超时仍阻止第二代，迟到ACK不把原失败改成ready', async t => {
  const f = fixture(t, { health: false, noShutdownAck: true })
  t.mock.timers.enable({ apis: ['setTimeout'] }); t.after(() => t.mock.timers.reset())
  f.startup.acceptPreference(f.event, preference())
  const rejected = assert.rejects(f.startup.activate(f.dependencies)); await turn()
  assert.equal(f.children.length, 1); assert.equal(f.children[0]!.exited, false)
  t.mock.timers.tick(29_999); await turn(); assert.equal(f.children.length, 1)
  t.mock.timers.tick(1); await rejected
  assert.equal(f.children.length, 1); assert.equal(f.children[0]!.killCount, 0)
  const request = f.channels[0]!.sent.find(value => (value as { command?: string }).command === 'core.shutdown') as { id: string }
  f.channels[0]!.receive({ version: IPC_VERSION, id: request.id, ok: true, result: { stopped: true } })
  await turn(); assert.equal(f.children.length, 1); assert.throws(() => f.startup.complete())
})

test('偏好和ready仅限当前主window/frame/origin/nonce，拒Proxy/getter/额外键且不执行getter', async t => {
  const f = fixture(t); let getterCalls = 0
  const getter = Object.defineProperty({ ...preference() }, 'autoStart', { enumerable: true, get() { getterCalls++; return true } })
  const attacks = [preference(true, 'x'.repeat(256)), { ...preference(), extra: true }, { ...preference(), nonce: nonce.replace('d', 'e') },
    { ...preference(), readable: false }, new Proxy(preference(), {}), getter]
  for (const attack of attacks) assert.throws(() => f.startup.acceptPreference(f.event, attack))
  assert.equal(getterCalls, 0)
  assert.throws(() => f.startup.acceptPreference({ ...f.event, sender: { ...f.contents } }, preference()))
  assert.throws(() => f.startup.acceptPreference({ ...f.event, senderFrame: { url: f.frame.url } }, preference()))
  f.frame.url = 'https://untrusted.invalid/index.html'; assert.throws(() => f.startup.acceptPreference(f.event, preference()))
  f.frame.url = 'musicbridge://app/index.html'; f.replaceWindow(); assert.throws(() => f.startup.acceptPreference(f.event, preference()))
  assert.equal(f.children.length, 0)
})

test('同源早期preload偏好不等DOM，全部context纯读等结算且变更不排队', async () => {
  const source = await readFile(new URL('../src/preload/index.ts', import.meta.url), 'utf8')
  const bootstrap = source.slice(source.indexOf('// 偏好消息与DOM/module完成独立'), source.indexOf('const rendererPerformance'))
  const invoker = source.slice(source.indexOf('const invokePerformance: typeof ipcRenderer.invoke = (channel'), source.indexOf('const invokeScoped'))
  const ready = deferred(), calls: string[] = [], result: { invoke?: (channel: string) => Promise<unknown> } = {}
  const script = ts.transpileModule(bootstrap + '\n' + invoker + '\nresult.invoke = invokePerformance', { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  runInNewContext(script, { result, process: { argv: ['--music-bridge-startup-nonce=' + nonce] },
    window: { localStorage: { getItem: (key: string) => key.endsWith('autoStart') ? '1' : 'saved-core' } },
    ipcRenderer: { invoke: async (channel: string) => { calls.push(channel); if (channel.endsWith('bootstrap-ready')) await ready.promise } },
    invokeObserved: async (channel: string) => { calls.push(channel); return channel },
  })
  const context = result.invoke!('commandOutbox:context'), info = result.invoke!('app:get-info')
  await assert.rejects(result.invoke!('playback:play')); await turn()
  assert.deepEqual(calls, ['remote-core:bootstrap-preference', 'remote-core:bootstrap-ready'])
  ready.resolve(); assert.equal(await context, 'commandOutbox:context'); assert.equal(await info, 'app:get-info')
  assert.equal(calls.includes('playback:play'), false)
})

test('实际Renderer入口在bootstrap结算前不创建App、不初始化appearance；失败保可见提示', async () => {
  const source = await readFile(new URL('../src/renderer/src/main.ts', import.meta.url), 'utf8')
  const program = source.slice(source.indexOf('async function mountPreparedApp'))
  for (const reject of [false, true]) {
    let release!: () => void, fail!: () => void
    const waiting = new Promise<void>((resolve, rejected) => { release = resolve; fail = () => rejected(new Error('原失败')) })
    const calls: string[] = [], message = { textContent: '正在准备音乐库…' }
    const root = { dataset: {}, classList: { add() {}, remove() {} } }
    const document = { hidden: false, documentElement: root, addEventListener() {}, removeEventListener() {}, querySelector: () => message }
    const app = { use() { return this }, provide() { return this }, onUnmount() {}, mount() { calls.push('mount') } }
    runInNewContext(ts.transpileModule(program, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
      window: { musicBridge: { getAppInfo: () => waiting, setAppearanceTheme: async () => {} }, localStorage: {} },
      document, createApp: () => { calls.push('app'); return app }, createPinia: () => ({}), App: {},
      appearanceKey: Symbol(), APPEARANCE_STORAGE_KEY: 'theme', createAppearancePreference: () => { calls.push('appearance'); return {} },
    })
    assert.deepEqual(calls, [])
    if (reject) fail(); else release()
    await turn()
    assert.deepEqual(calls, reject ? [] : ['appearance', 'app', 'mount'])
    assert.equal(message.textContent, reject ? '音乐库暂时无法打开，请退出后重试。' : '正在准备音乐库…')
  }
})

test('执行Main真实bootstrap片段：窗口/偏好先行，Provider→移动设置→原IPC装配后才放行', async t => {
  const f = fixture(t), mobile = deferred(), handlers = new Map<string, (event: typeof f.event, value: unknown) => unknown>()
  const source = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const boot = source.slice(source.indexOf('  // 专用无窗口Gate保持原入口'), source.indexOf('  await bindCurrentLocalWorkbenchRootMainAuthor(supervisor)', source.indexOf('  // 专用无窗口Gate保持原入口')))
  const providerStart = source.indexOf('  roonDisplayConnection = new RoonDisplayConnection', source.indexOf('async function bootstrap'))
  const provider = source.slice(providerStart, source.indexOf('  if (isCoreRestartCredentialRecoveryGate) {', providerStart))
  const tailStart = source.indexOf('  if (!isStartupTest && !isUiE2e) await mobileConnectionSettings.restore()')
  const tail = source.slice(tailStart, source.indexOf('  if (collectionScaleProbe) {', tailStart))
  assert.ok(boot && provider && tail)
  const observed: string[] = [], result: { work?: Promise<void> } = {}
  runInNewContext(ts.transpileModule('async function run() {\n' + boot + provider + tail + '\n}\nresult.work = run()', {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    result, supervisor: f.supervisor, remoteCoreStartup: undefined, mainWindow: f.window, quitAfterCoreShutdown: false,
    packagedRouteProbe: false, isCoreRestartCredentialRecoveryGate: false, isElectronColdStartGate: false,
    isStartupTest: false, isUiE2e: false, packagedRendererProbe: false, electronColdStartStage: undefined,
    randomUUID: () => nonce, process: { env: { CORE_SSH_TARGET: 'environment-core' }, platform: 'darwin' },
    createRemoteCoreStartup: () => f.startup, REMOTE_CORE_STARTUP_PREFERENCE: 'remote-core:bootstrap-preference', REMOTE_CORE_STARTUP_READY: 'remote-core:bootstrap-ready',
    ipcMain: { handle: (name: string, handler: (event: typeof f.event, value: unknown) => unknown) => handlers.set(name, handler) },
    createWindow: () => { observed.push('window'); queueMicrotask(() => handlers.get('remote-core:bootstrap-preference')!(f.event, preference())); return f.window },
    startRemoteCoreDevelopment: f.dependencies.startRemote, remoteCoreTunnelManager: f.manager,
    roonDisplayConnection: undefined, RoonDisplayConnection: class { async restore() { observed.push('display') } },
    path: { join: (...parts: string[]) => parts.join('/') }, syntheticUserDataDirectory: '/合成/不读取', app: {},
    prepared: { credentialVault: {} }, initialProvisioningComplete: false,
    provisionProviderCredential: async () => { observed.push('provider'); return 'missing' }, restoreProviderCredential: async () => { throw new Error('首代不能误走重启凭据恢复') },
    mobileConnectionSettings: { async restore() { observed.push('mobile'); await mobile.promise } },
    registerIpcHandlers: () => observed.push('handlers'), createTray: () => observed.push('tray'), CoreIpcError: Error,
    logLibraryOperation, bootstrapStarted: performance.now(), performance,
  })
  await turn(); assert.deepEqual(observed, ['window', 'display', 'provider', 'mobile'])
  let released = false
  const ready = Promise.resolve(handlers.get('remote-core:bootstrap-ready')!(f.event, { version: 1, nonce })).then(() => { released = true })
  await turn(); assert.equal(released, false); assert.equal(f.children.length, 1)
  mobile.resolve(); await result.work; await ready
  assert.deepEqual(observed, ['window', 'display', 'provider', 'mobile', 'handlers', 'tray'])
  assert.equal(f.children.length, 1)
})

test('Main真实bootstrap拒绝处理：Quit中的取消不调用app.exit，窗口撤销走原正常Quit', async () => {
  const source = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const body = source.slice(source.indexOf('void bootstrap().catch('), source.indexOf("app.on('before-quit'"))
  for (const closing of [false, true]) {
    const actions: string[] = []
    runInNewContext(ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
      bootstrap: () => Promise.reject(new Error('原准备撤销')), quitAfterCoreShutdown: closing,
      remoteCoreStartup: { cancelled: true, fail() { actions.push('seal') } },
      app: { quit() { actions.push('quit') }, exit() { actions.push('exit') } }, process: { stderr: { write() { actions.push('stderr') } } },
    })
    await turn(); assert.deepEqual(actions, closing ? ['seal'] : ['seal', 'quit'])
  }
})

test('Main实际earlyWindow先完成document时，旧启动Gate只在最终bootstrap后执行一次', async () => {
  const source = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const begin = source.indexOf('function createWindow('), end = source.indexOf('\nfunction buildCoreEnvironment', begin)
  const ready = deferred(), calls: string[] = []
  class Window extends EventEmitter {
    readonly webContents = Object.assign(new EventEmitter(), {
      id: 7, mainFrame: { url: 'musicbridge://app/index.html' },
      setWindowOpenHandler() {}, async executeJavaScript() { calls.push('execute'); return [{ pong: true }, health, health] },
    })
    isDestroyed() { return false }
    async loadURL() { return undefined }
    hide() {}
  }
  const result: { create?: (supervisor: { status: string }, startup: unknown) => Window } = {}
  runInNewContext(ts.transpileModule(source.slice(begin, end) + '\nresult.create = createWindow', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    result, nativeTheme: {}, BrowserWindow: Window, DISPLAY_NAME: 'Mousa', isStartupTest: true, isUiE2e: false, isCoreCrashGate: false,
    collectionReadonlyProbe: { observeWindow() { calls.push('observe-window') } }, collectionScaleProbe: undefined, packagedRendererProbe: undefined,
    buildBrowserWindowWebPreferences: () => ({}), path: { join: (...parts: string[]) => parts.join('/') }, currentDirectory: '/合成/未执行',
    process: { env: {}, stdout: { write(value: string) { calls.push(value.trim()) } } }, isLibraryReadTrace: false,
    mainWindow: undefined, quitAfterCoreShutdown: false, localWorkbenchShutdownConfirmed: false,
    getWindowOpenDecision: () => ({ action: 'deny' }), lifecycleProbe: { mark() {} },
    RENDERER_SCHEME: 'musicbridge', RENDERER_HOST: 'app', RENDERER_ENTRY_PATH: '/index.html',
    IPC_VERSION, validateIpcEvent, setTimeout(_work: unknown, ms: number) { assert.equal(ms, 25); calls.push('quit-scheduled') },
    app: { exit() { calls.push('unexpected-exit') } },
  })
  const supervisor = { status: 'starting' }
  const window = result.create!(supervisor, { nonce, bindWindow() {}, waitUntilReady: () => ready.promise })
  window.webContents.emit('did-finish-load'); await turn(); assert.deepEqual(calls, [])
  supervisor.status = 'ready'; ready.resolve(); await turn()
  assert.deepEqual(calls, ['observe-window', 'execute', 'DESKTOP_STARTUP_READY', 'quit-scheduled'])
  window.webContents.emit('did-finish-load'); await turn(); assert.equal(calls.filter(value => value === 'execute').length, 1)
})

test('Main真实Quit在首次SSH cold Core中仍能先收原代，remote_stop不自等待到冷核完成', async t => {
  const f = fixture(t, { autoReady: false })
  f.startup.acceptPreference(f.event, preference())
  const opening = f.startup.activate(f.dependencies).catch(() => undefined)
  await turn(); assert.equal(f.children.length, 1)
  const source = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
  let callback: string | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'app.on'
      && ts.isStringLiteral(node.arguments[0]!) && node.arguments[0]!.text === 'before-quit') callback = node.arguments[1]!.getText(ast)
    ts.forEachChild(node, visit)
  }
  visit(ast); assert.ok(callback)
  const result: { invoke?: (event: { preventDefault(): void }) => void } = {}, actions: string[] = []
  const sandbox = {
    result, remoteCoreStartup: f.startup, createLocalWorkbenchQuitCoordinator,
    coreSupervisor: f.supervisor, remoteCoreTunnelManager: f.manager, remoteCoreModeController: f.controller, remoteCoreModeIntent: 0,
    quitAfterCoreShutdown: false, localWorkbenchShutdownConfirmed: false, localWorkbenchQuitCoordinator: undefined,
    localWorkbenchMainRecovery: { close() {} }, localWorkbenchRootMainAuthor: undefined,
    localWorkbenchManagementBoundary: undefined, localWorkbenchLegacyIpc: undefined,
    localArtworkImportNormalizer: undefined, localWorkbenchMainAssembly: undefined,
    localLyricsMainService: undefined, localLyricsProviderBridge: undefined, localNameMainBridge: undefined,
    mobileConnectionSettings: undefined, mobilePairingPrompts: undefined,
    commandOutbox: undefined, roonDisplayConnection: undefined, artistCatalogService: undefined,
    closeLocalArtwork: undefined, closeLocalSourceWrites: undefined, closeLocalRelocation: undefined,
    packagedRouteProbe: undefined, packagedRendererProbe: undefined, collectionReadonlyProbe: undefined, collectionScaleProbe: undefined,
    mainDiagnostics: { recordLifecycle() {} }, lifecycleProbe: { mark() {}, observe(work: Promise<unknown>) { void work.catch(() => undefined) } },
    stopRecordingPrintWorker() {}, closeRustMediaWorkerPool: async () => {}, destroyTray() {}, revokeLocalWorkbenchRootMainAuthor() {},
    app: { quit() { actions.push('quit') } }, setTimeout, clearTimeout, CoreIpcError: Error,
  }
  runInNewContext(ts.transpileModule('result.invoke = ' + callback, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox)
  try {
    result.invoke!({ preventDefault() {} })
    for (let i = 0; i < 8; i++) await turn()
    assert.equal(f.children[0]!.exited, true, '不能先等manager.start完成，再尝试关闭正被它等待的首代Core')
    assert.equal(f.children[0]!.killCount, 0); assert.equal(f.children.length, 1)
    assert.deepEqual(actions, ['quit']); assert.equal(sandbox.localWorkbenchShutdownConfirmed, true)
    assert.throws(() => f.startup.complete())
  } finally {
    // RED或中断也只释放合成actor；不让夹具cleanup反过来等待永不ready的假child。
    f.revoke(); const closing = f.supervisor.shutdown().catch(() => undefined)
    await turn(); for (const child of f.children) child.exit(); await closing; await opening
  }
})
