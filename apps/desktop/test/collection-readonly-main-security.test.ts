import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { isTrustedRendererSender } from '../src/main/security.js'
import { installCollectionReadonlyHandlers } from '../src/main/collection-readonly-settings.js'

test('实际Main普通控件IPC拒绝第二窗口/子frame/URL/额外参数，先于偏好副作用', async () => {
  const source = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const trusted = source.slice(source.indexOf('function requireTrustedRenderer('), source.indexOf('async function invokeCore'))
  const block = source.slice(source.indexOf('  installCollectionReadonlyHandlers<Electron.IpcMainInvokeEvent>'), source.indexOf("  registerPerformanceHandler('app:set-appearance-theme'"))
  const frame = { url: 'musicbridge://app/index.html' }, contents = { id: 7, mainFrame: frame }
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>(); let effects = 0
  const script = ts.transpileModule(trusted + block, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  runInNewContext(script, { mainWindow: { isDestroyed: () => false, webContents: contents }, isTrustedRendererSender,
    publicIpcFailure: () => { throw new Error('受控拒绝') }, installCollectionReadonlyHandlers,
    registerPerformanceHandler: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, handler),
    collectionReadonlySettings: { get: async () => { effects++; return {} }, set: async () => { effects++; return {} }, refresh: async () => { effects++; return {} } },
  })
  const valid = { sender: contents, senderFrame: frame }
  for (const event of [{ ...valid, sender: { ...contents, id: 8 } }, { ...valid, senderFrame: { ...frame } }, { ...valid, senderFrame: { url: 'https://outside.invalid/' } }, { ...valid, senderFrame: null }]) assert.throws(() => handlers.get('collection:readonly-settings')!(event))
  assert.throws(() => handlers.get('collection:set-readonly-enabled')!(valid, true, {})); assert.throws(() => handlers.get('collection:refresh')!(valid, {})); assert.equal(effects, 0)
  await handlers.get('collection:readonly-settings')!(valid); await handlers.get('collection:set-readonly-enabled')!(valid, true); await handlers.get('collection:refresh')!(valid); assert.equal(effects, 3)
})

test('实际Main在原ready后仅绑定一次第二父port，保留正常恢复；新Core换nonce', async () => {
  const source = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const start = source.indexOf('function createCoreSupervisor('), end = source.indexOf('\nasync function prepareCoreDataDirectory', start)
  assert.ok(end > start)
  type Child = { postMessage(value: unknown, ports: unknown[]): void; once(): void }
  const posts: unknown[] = [], attached: unknown[] = []; let readyCalls = 0, detaches = 0, failChannel = false
  const makeChild = (): Child => ({ postMessage(value, ports) { assert.equal(ports.length, 1); posts.push(value) }, once() {} })
  class Channel {
    port1 = { on() {}, start() {}, close() {}, postMessage() {} }
    port2 = { on() {}, start() {}, close() {}, postMessage() {} }
    constructor() { if (failChannel) throw new Error('受控通道失败') }
  }
  let captured!: { dependencies: { fork(entry: string, args: string[], options: { cwd: string; env: object; stdio: string; serviceName: string }): Child }; onReady(client: unknown): Promise<void>; onLifecycle(event: { event: string }): void }
  const context = {
    coreDataDirectory: undefined, CoreSupervisor: class { constructor(options: typeof captured) { captured = options } },
    path: { join: (...parts: string[]) => parts.join('/') }, currentDirectory: '/fixed/main', buildCoreEnvironment: () => ({}), process: { env: {} },
    MessageChannelMain: Channel, packagedRouteProbe: undefined, packagedRendererProbe: undefined, collectionReadonlyProbe: undefined, collectionScaleProbe: undefined,
    utilityProcess: { fork: (entry: string, args: string[]) => { assert.equal(entry, '/fixed/main/core.js'); assert.deepEqual([...args], []); return makeChild() } },
    mainDiagnostics: { performance: {} }, performanceIpc: { context() {} }, libraryReadTrace: undefined,
    collectionReadonlySettings: { attach: (client: unknown) => attached.push(client), detach: () => { detaches++ } },
    createCollectionReadonlyControlClient: (await import('../src/main/collection-readonly-control-client.js')).createCollectionReadonlyControlClient,
    require: () => {}, module: { exports: {} }, exports: {},
  }
  const code = ts.transpileModule(source.slice(start, end) + '\ncreateCoreSupervisor("/profile/data", {onReady: async () => originalReady()});', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  runInNewContext(code, { ...context, originalReady: () => { readyCalls++ } })
  captured.dependencies.fork('/fixed/main/core.js', [], { cwd: '/profile/data', env: {}, stdio: 'ignore', serviceName: 'Core' }); assert.equal(posts.length, 0)
  await captured.onReady({}); await captured.onReady({}); assert.equal(posts.length, 1); assert.equal(readyCalls, 2)
  captured.dependencies.fork('/fixed/main/core.js', [], { cwd: '/profile/data', env: {}, stdio: 'ignore', serviceName: 'Core' }); await captured.onReady({})
  assert.equal(posts.length, 2); assert.notEqual((posts[0] as {generationNonce:string}).generationNonce, (posts[1] as {generationNonce:string}).generationNonce)
  captured.onLifecycle({ event: 'exit' }); assert.equal(detaches, 1)
  failChannel = true; captured.dependencies.fork('/fixed/main/core.js', [], { cwd: '/profile/data', env: {}, stdio: 'ignore', serviceName: 'Core' }); await captured.onReady({})
  assert.equal(readyCalls, 4); assert.equal(posts.length, 2); assert.equal(detaches, 2)
})
