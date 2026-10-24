import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { createLocalWorkbenchMainRecovery, type LocalWorkbenchBindEvent, type LocalWorkbenchBindPhase } from '../src/main/local-workbench-main-recovery.js'
import { randomUUID } from 'node:crypto'
import { DATASET_WORKBENCH_BOUNDS } from '../../../packages/bridge-core/src/collection/dataset-owner-protocol.js'
import { createLocalWorkbenchMainAssembly, type LocalWorkbenchMainResources } from '../src/main/local-library-workbench/service.js'

const turn = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
class ControlledError extends Error { constructor(readonly code: string) { super('合成异常正文包含不应输出的路径或秘密。') } }
function fixture(overrides: Partial<Parameters<typeof createLocalWorkbenchMainRecovery<object>>[0]> = {}) {
  const events: LocalWorkbenchBindEvent[] = [], actions: string[] = [], author = {}
  const helper = createLocalWorkbenchMainRecovery({ isReady: () => true,
    async create() { actions.push('create'); return author }, attach() { actions.push('attach') },
    async activate() { actions.push('activate') }, async announce(_author, check) { check(); actions.push('health') },
    failureCode(error) { return error instanceof ControlledError ? error.code : 'UNKNOWN' }, observe: event => events.push(event), ...overrides })
  return { helper, events, actions, author }
}

test('Main 绑定恢复：双启动触发共享整段 flight，成功后同代不重复激活或公告', async () => {
  const entered = deferred<void>(), reply = deferred<object>(), f = fixture({ async create() { entered.resolve(); return reply.promise } })
  const one = f.helper.request(), two = f.helper.request(); assert.equal(one, two); await entered.promise
  assert.deepEqual(f.actions, []); reply.resolve(f.author); await one
  assert.deepEqual(f.actions, ['attach', 'activate', 'health']); await f.helper.request()
  assert.deepEqual(f.actions, ['attach', 'activate', 'health']); assert.equal(f.events.filter(event => event.state === 'start').length, 4); f.helper.close()
})

test('Main 绑定恢复：仅 TIMEOUT/NOT_READY 自动有限退避，保留真实失败首阶段与闭集码', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const code of ['TIMEOUT', 'NOT_READY']) {
    let count = 0
    const f = fixture({ async create() { count++; throw new ControlledError(code) } })
    await f.helper.request(); assert.equal(count, 1)
    for (const delay of [500, 1000, 2000, 4000, 5000]) { t.mock.timers.tick(delay); await turn() }
    assert.equal(count, 6); t.mock.timers.tick(100_000); await turn(); assert.equal(count, 6)
    assert.deepEqual(f.events.filter(event => event.state === 'error').map(event => [event.phase, event.code, event.attempt]), [1, 2, 3, 4, 5, 6].map(number => ['create', code, number]))
    assert.equal(JSON.stringify(f.events).includes('秘密'), false); f.helper.close()
  }
  for (const code of ['OUTBOX_SCOPE_MISMATCH', 'INVALID_IPC_RESPONSE', 'INVENTORY_UNAVAILABLE', 'UNKNOWN', '未知值']) {
    let count = 0; const f = fixture({ async create() { count++; throw new ControlledError(code) } })
    await f.helper.request(); t.mock.timers.tick(100_000); await turn(); assert.equal(count, 1); f.helper.close()
  }
})

test('Main 绑定恢复：已有作者但 activate 首次超时，重新激活原资源后只公告一次', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let activated = 0, announced = 0
  const f = fixture({ async activate() { if (++activated === 1) throw new ControlledError('TIMEOUT') }, async announce() { announced++ } })
  await f.helper.request(); assert.equal(announced, 0)
  assert.deepEqual(f.events.filter(event => event.state === 'error').map(event => [event.phase, event.code]), [['activate', 'TIMEOUT']])
  t.mock.timers.tick(500); await turn(); assert.equal(activated, 2); assert.equal(announced, 1); f.helper.close()
})

test('Main 绑定恢复：Main 资源注册可提前唤醒原退避，始终只有一个 flight', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let resourcesReady = false, activated = 0, announced = 0
  const f = fixture({ async activate() { activated++; if (!resourcesReady) throw new ControlledError('NOT_READY') }, async announce() { announced++ } })
  await f.helper.request(); resourcesReady = true; await f.helper.request()
  t.mock.timers.tick(10_000); await turn(); assert.equal(activated, 2); assert.equal(announced, 1); f.helper.close()
})

test('Main 绑定恢复：撤代/退出清理退避，迟到 create 不能 attach 或公告，新代等旧 flight 收口', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const reply = deferred<object>(); let ready = true, creates = 0, announced = 0
  const f = fixture({ isReady: () => ready, async create() { return ++creates === 1 ? reply.promise : {} }, async announce() { announced++ } })
  const old = f.helper.request(); await turn(); ready = false; f.helper.revoke(); ready = true
  const next = f.helper.request(); assert.equal(next, old); assert.equal(creates, 1)
  reply.resolve({}); await old; await turn(); assert.equal(creates, 2); assert.equal(announced, 1)
  assert.equal(f.actions.filter(value => value === 'attach').length, 1); f.helper.close()
  let fails = 0; const closing = fixture({ async create() { fails++; throw new ControlledError('TIMEOUT') } })
  await closing.helper.request(); closing.helper.close(); t.mock.timers.tick(100_000); await turn(); await closing.helper.request(); assert.equal(fails, 1)
})

test('Main 绑定恢复：每个阶段迟到后都停稳，health await 后门禁先于实际公告', async () => {
  for (const phase of ['attach', 'activate', 'health'] as LocalWorkbenchBindPhase[]) {
    const entered = deferred<void>(), reply = deferred<void>(); let announced = 0
    const f = fixture({
      attach() { if (phase === 'attach') { f.helper.revoke() } },
      async activate() { if (phase === 'activate') { entered.resolve(); await reply.promise } },
      async announce(_author, check) { if (phase === 'health') { entered.resolve(); await reply.promise } check(); announced++ },
    })
    const pending = f.helper.request()
    if (phase !== 'attach') { await entered.promise; f.helper.revoke(); reply.resolve() }
    await pending; assert.equal(announced, 0); assert.equal(f.events.at(-1)?.state, 'cancelled'); f.helper.close()
  }
})

test('Main 绑定恢复：旁注故障不改变真实流程，不从未知异常 getter 读取正文', async () => {
  const f = fixture({ observe() { throw new Error('合成日志故障。') } }); await f.helper.request(); assert.deepEqual(f.actions, ['create', 'attach', 'activate', 'health']); f.helper.close()
  let getter = 0; const raw = Object.defineProperty({}, 'message', { get() { getter++; throw Error('不应读取。') } })
  const failed = fixture({ async create() { throw raw } }); await failed.helper.request(); assert.equal(getter, 0)
  assert.equal(failed.events.at(-1)?.code, 'UNKNOWN'); failed.helper.close()
})

test('实际 index 绑定接入：首次 context 超时、资源晚注册与激活失败恢复后仅公告真实健康，原请求无写重放', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const source = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const begin = source.indexOf('function attachLocalWorkbenchRootMainAuthor('), end = source.indexOf('\nlet roonDisplayConnection', begin)
  const registrationBegin = source.indexOf('  const assembly = createLocalWorkbenchMainAssembly({', source.indexOf('function registerIpcHandlers('))
  const registrationEnd = source.indexOf('\n  const trustedWorkbench', registrationBegin)
  assert.ok(begin >= 0 && end > begin && registrationBegin >= 0 && registrationEnd > registrationBegin)
  const acknowledgements: string[] = []
  const author = { binding: Object.freeze({ datasetId: randomUUID(), ownerEpoch: randomUUID(), childGeneration: 1, authorityRef: {} }),
    async requestOwner(command: string, payload: unknown, context: { binding: unknown; signal: AbortSignal; deadlineAtMs: number }) {
      assert.equal(command, 'lifecycle.mainReady'); assert.equal(JSON.stringify(payload), '{}'); assert.equal(context.binding, author.binding)
      assert.equal(context.signal.aborted, false); assert.ok(context.deadlineAtMs <= performance.now() + DATASET_WORKBENCH_BOUNDS.requestMs)
      acknowledgements.push(command); return true
    } }, events: { action: string; state: string; code?: string }[] = [], announcements: unknown[] = [], requests: string[] = []
  let created = 0, activated = 0, failActivation = true, installed = 0
  const supervisor = { status: 'ready',
    async createWorkbenchRootMainAuthor() { if (++created === 1) throw new ControlledError('TIMEOUT'); return author },
    async request(command: string) { requests.push(command); assert.equal(command, 'core.getState'); return { runtime: 'ready' } },
  }
  const assembly = { async activate(actual: object) { assert.equal(actual, author); activated++; if (failActivation) throw new ControlledError('NOT_READY') } }
  const context = { coreSupervisor: supervisor, quitAfterCoreShutdown: false,
    localWorkbenchRootMainAuthor: undefined, localWorkbenchTransportOwner: undefined, localWorkbenchMainRecovery: undefined, localWorkbenchMainRecoverySupervisor: undefined,
    localWorkbenchMainAssembly: undefined, localWorkbenchManagementBoundary: undefined, localNameMainBridge: undefined, localLyricsMainService: undefined,
    mainWindow: { isDestroyed: () => false, webContents: { send: (...args: unknown[]) => announcements.push(args) } }, IPC_VERSION: 1, DATASET_WORKBENCH_BOUNDS, performance, AbortController,
    CoreIpcError: ControlledError, LocalWorkbenchMainBoundaryError: ControlledError, createLocalWorkbenchMainRecovery,
    createLocalWorkbenchTransportOwner: () => ({}), mainDiagnostics: { recordLifecycle() {} },
    logLibraryOperation: (_part: string, action: string, state: string, metrics: { code?: string }) => events.push({ action, state, ...metrics }),
    createCurrentLocalWorkbenchResources: () => { throw new Error('本例不创建真实 Main 资源。') },
    createLocalWorkbenchMainAssembly: () => assembly, registerCurrentLocalAlbumIpc: (actual: object, resources: object) => { assert.equal(actual, supervisor); assert.equal(resources, assembly); installed++ },
    api: undefined as unknown as { bind(actual: typeof supervisor): Promise<void>; register(actual: typeof supervisor): void },
  }
  const script = source.slice(begin, end) + '\nfunction registerResourcesUnderTest(supervisor) {' + source.slice(registrationBegin, registrationEnd)
    + '\n}\nglobalThis.api = { bind: bindCurrentLocalWorkbenchRootMainAuthor, register: registerResourcesUnderTest };'
  runInNewContext(ts.transpileModule(script, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context)
  t.after(() => (context.localWorkbenchMainRecovery as unknown as { close(): void } | undefined)?.close())
  await Promise.all([context.api.bind(supervisor), context.api.bind(supervisor)])
  assert.equal(created, 1); assert.equal(announcements.length, 0)
  t.mock.timers.tick(500); await turn(); assert.equal(created, 2); assert.equal(context.localWorkbenchRootMainAuthor, author)
  context.api.register(supervisor); await turn(); assert.equal(installed, 1); assert.equal(activated, 1); assert.equal(announcements.length, 0)
  failActivation = false; t.mock.timers.tick(500); await turn()
  assert.equal(activated, 2); assert.equal(announcements.length, 1); assert.deepEqual(requests, ['core.getState']); assert.deepEqual(acknowledgements, ['lifecycle.mainReady'])
  await context.api.bind(supervisor); t.mock.timers.tick(100_000); await turn(); assert.equal(created, 4); assert.equal(announcements.length, 1)
  assert.deepEqual(events.filter(event => event.state === 'error').map(event => [event.action, event.code]), [
    ['workbench.main-bind.create', 'TIMEOUT'], ['workbench.main-bind.activate', 'NOT_READY'], ['workbench.main-bind.activate', 'NOT_READY'],
  ])
  assert.equal(events.filter(event => event.action === 'workbench.main-bind.health' && event.state === 'complete').length, 1)
  assert.equal(JSON.stringify(events).includes('秘密'), false)
  t.diagnostic('执行实际 index 的绑定与资源注册代码；Core/资源工厂受控，不代表真实 App 或独立 Owner 启动。')
})


/** 执行实际index接线与真实MainAssembly；资源工厂/Owner回声受控，不冒充Source批准或真实Electron启动。 */
async function mainReadyFixture(t: test.TestContext, options: { revokeOnHealth?: boolean; holdAck?: boolean; reply?: boolean } = {}) {
  const source = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const begin = source.indexOf('function attachLocalWorkbenchRootMainAuthor('), end = source.indexOf('\nlet roonDisplayConnection', begin)
  const registrationBegin = source.indexOf('  const assembly = createLocalWorkbenchMainAssembly({', source.indexOf('function registerIpcHandlers('))
  const registrationEnd = source.indexOf('\n  const trustedWorkbench', registrationBegin)
  assert.ok(begin >= 0 && end > begin && registrationBegin >= 0 && registrationEnd > registrationBegin)
  const resourcesEntered = deferred<void>(), resourcesReady = deferred<void>(), healthEntered = deferred<void>(), healthReady = deferred<{ runtime: string }>()
  const ackEntered = deferred<void>(), ackReady = deferred<boolean>()
  const actions: string[] = [], events: { action: string; state: string; code?: string }[] = []
  let created = 0, resourceCreates = 0, closed = 0, pending: Promise<void> | undefined, healthResolved = false
  const binding = Object.freeze({ datasetId: randomUUID(), ownerEpoch: randomUUID(), childGeneration: 1, authorityRef: Object.freeze({}) })
  let context: Record<string, any>
  const author = { binding,
    async assertCurrent(value: unknown) { assert.equal(value, binding); if (context.localWorkbenchRootMainAuthor !== author || supervisor.status !== 'ready') throw new ControlledError('NOT_READY') },
    async requestOwner(command: string, payload: unknown, read: { binding: unknown; signal: AbortSignal; deadlineAtMs: number }) {
      assert.equal(command, 'lifecycle.mainReady'); assert.equal(JSON.stringify(payload), '{}'); assert.equal(read.binding, binding)
      assert.equal(read.signal.aborted, false); assert.ok(read.deadlineAtMs > performance.now())
      assert.ok(read.deadlineAtMs <= performance.now() + DATASET_WORKBENCH_BOUNDS.requestMs)
      assert.equal(healthResolved, true)
      assert.ok(events.some(event => event.action === 'workbench.main-bind.activate' && event.state === 'complete'))
      assert.equal(actions.at(-1), 'health.send')
      actions.push('ack'); ackEntered.resolve()
      return options.holdAck ? ackReady.promise : options.reply ?? true
    },
  }
  const supervisor = { status: 'ready',
    async createWorkbenchRootMainAuthor() { created++; return author },
    async request(command: string) { assert.equal(command, 'core.getState'); actions.push('health.request'); healthEntered.resolve(); const state = await healthReady.promise; healthResolved = true; return state },
  }
  const resources: LocalWorkbenchMainResources = {
    service: { async closeReadResources() {}, async close() {} } as unknown as LocalWorkbenchMainResources['service'],
    names: { async read() { throw new Error('本Gate不读设置。') }, async save() { throw new Error('本Gate不写设置。') }, async securityPrompt() { throw new Error('本Gate不请求凭据。') } },
    async close() { closed++; actions.push('resources.close') },
  }
  const revoke = () => {
    supervisor.status = 'stopping'; context.localWorkbenchMainRecovery?.revoke()
    context.localWorkbenchRootMainAuthor = undefined; context.localWorkbenchMainAssembly?.revoke()
  }
  context = { coreSupervisor: supervisor, quitAfterCoreShutdown: false,
    localWorkbenchRootMainAuthor: undefined, localWorkbenchTransportOwner: undefined, localWorkbenchMainRecovery: undefined, localWorkbenchMainRecoverySupervisor: undefined,
    localWorkbenchMainAssembly: undefined, localWorkbenchManagementBoundary: undefined, localNameMainBridge: undefined, localLyricsMainService: undefined,
    mainWindow: { isDestroyed: () => false, webContents: { send() { actions.push('health.send'); if (options.revokeOnHealth) revoke() } } },
    IPC_VERSION: 1, DATASET_WORKBENCH_BOUNDS, performance, AbortController, CoreIpcError: ControlledError, LocalWorkbenchMainBoundaryError: ControlledError,
    createLocalWorkbenchMainRecovery, createLocalWorkbenchMainAssembly, createLocalWorkbenchTransportOwner: () => ({}), mainDiagnostics: { recordLifecycle() {} },
    logLibraryOperation: (_part: string, action: string, state: string, metrics: { code?: string }) => events.push({ action, state, ...metrics }),
    async createCurrentLocalWorkbenchResources(actual: unknown) { assert.equal(actual, author); resourceCreates++; actions.push('resources.create'); resourcesEntered.resolve(); await resourcesReady.promise; return resources },
    registerCurrentLocalAlbumIpc() {}, api: undefined,
  }
  const script = source.slice(begin, end) + '\nfunction registerResourcesUnderTest(supervisor) {' + source.slice(registrationBegin, registrationEnd)
    + '\n}\nglobalThis.api = { bind: bindCurrentLocalWorkbenchRootMainAuthor, register: registerResourcesUnderTest };'
  runInNewContext(ts.transpileModule(script, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context)
  t.after(async () => {
    context.localWorkbenchMainRecovery?.close()
    resourcesReady.resolve(); healthReady.resolve({ runtime: 'ready' }); ackReady.resolve(true)
    await pending; await context.localWorkbenchMainAssembly?.close()
  })
  return { actions, events, resourcesEntered: resourcesEntered.promise, healthEntered: healthEntered.promise, ackEntered: ackEntered.promise,
    get created() { return created }, get resourceCreates() { return resourceCreates }, get closed() { return closed },
    start() { context.api.register(supervisor); return pending = context.api.bind(supervisor) },
    bind() { return context.api.bind(supervisor) as Promise<void> }, resourcesReady: () => resourcesReady.resolve(), healthReady: (runtime = 'ready') => healthReady.resolve({ runtime }), ackReady: () => ackReady.resolve(true), revoke,
  }
}

test('实际Main接线：真实assembly资源与health都未完成前零ACK，双触发同flight且无人开页只ACK一次', async t => {
  const f = await mainReadyFixture(t), first = f.start(), second = f.bind()
  await f.resourcesEntered; assert.equal(f.created, 1); assert.equal(f.resourceCreates, 1)
  assert.equal(f.actions.includes('health.request'), false); assert.equal(f.actions.includes('ack'), false)
  f.resourcesReady(); await f.healthEntered; assert.equal(f.actions.includes('ack'), false)
  f.healthReady(); await Promise.all([first, second]); await f.bind()
  assert.deepEqual(f.actions, ['resources.create', 'health.request', 'health.send', 'ack'])
  assert.equal(f.created, 1); assert.equal(f.resourceCreates, 1)
  assert.equal(f.events.filter(event => event.action === 'workbench.main-bind.health' && event.state === 'complete').length, 1)
})

test('实际Main接线：health非ready不发送ACK，仍沿原有限恢复而非延时启动后台', async t => {
  const f = await mainReadyFixture(t), pending = f.start()
  await f.resourcesEntered; f.resourcesReady(); await f.healthEntered; f.healthReady('starting'); await pending
  assert.equal(f.actions.includes('ack'), false)
  assert.equal(f.actions.includes('health.send'), false)
  assert.ok(f.events.some(event => event.action === 'workbench.main-bind.health' && event.state === 'error' && event.code === 'NOT_READY'))
})

test('实际Main接线：装配迟到或健康公告后撤代，发前check阻止旧作者ACK', async t => {
  for (const when of ['resources', 'health-send'] as const) await t.test(when, async child => {
    const f = await mainReadyFixture(child, { revokeOnHealth: when === 'health-send' }), pending = f.start()
    await f.resourcesEntered
    if (when === 'resources') f.revoke()
    f.resourcesReady()
    if (when === 'health-send') { await f.healthEntered; f.healthReady() }
    await pending
    assert.equal(f.actions.includes('ack'), false)
    assert.ok(f.events.some(event => event.state === 'cancelled'))
  })
})

test('实际Main接线：ACK回包迟到后再check，撤代不记本代绑定成功；非法false也拒绝', async t => {
  const stale = await mainReadyFixture(t, { holdAck: true }), pending = stale.start()
  await stale.resourcesEntered; stale.resourcesReady(); await stale.healthEntered; stale.healthReady(); await stale.ackEntered
  stale.revoke(); stale.ackReady(); await pending
  assert.equal(stale.events.some(event => event.action === 'workbench.main-bind.health' && event.state === 'complete'), false)
  assert.ok(stale.events.some(event => event.action === 'workbench.main-bind.health' && event.state === 'cancelled'))
  const invalid = await mainReadyFixture(t, { reply: false }), failed = invalid.start()
  await invalid.resourcesEntered; invalid.resourcesReady(); await invalid.healthEntered; invalid.healthReady(); await failed
  assert.ok(invalid.events.some(event => event.action === 'workbench.main-bind.health' && event.state === 'error' && event.code === 'INVALID_IPC_RESPONSE'))
})
