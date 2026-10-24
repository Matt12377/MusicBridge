import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { IPC_VERSION, type PlaybackStreamSnapshot } from '@music-bridge/contracts'
import { CoreSupervisor, type CoreMessagePort, type CoreChildProcess, type CoreStartupClient } from '../src/main/core-supervisor.js'

class Port implements CoreMessagePort {
  readonly sent: unknown[] = []
  closed = false
  private listener: ((event: { data: unknown }) => void) | undefined
  constructor(private readonly sentHook: (message: unknown) => void = () => {}) {}
  on(event: 'message', listener: (event: { data: unknown }) => void): void { assert.equal(event, 'message'); this.listener = listener }
  start(): void {}
  close(): void { this.closed = true }
  postMessage(message: unknown): void { if (this.closed) throw new Error('受控旧端口已关闭'); this.sent.push(message); this.sentHook(message) }
  /** 故意允许注入旧端口迟到帧，由实际Supervisor验证代次隔离。 */
  receive(message: unknown): void { this.listener?.({ data: message }) }
}
class Child implements CoreChildProcess {
  private listeners: Array<(code: number) => void> = []
  exited = false
  killCount = 0
  autoExitOnKill = true
  autoShutdownExit = true
  postMessage(_message: unknown): void {}
  once(event: 'exit', listener: (code: number) => void): void { assert.equal(event, 'exit'); this.listeners.push(listener) }
  kill(): boolean { this.killCount++; if (this.autoExitOnKill) this.exit(0); return true }
  exit(code: number): void { if (this.exited) return; this.exited = true; for (const listener of this.listeners.splice(0)) listener(code) }
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
async function eventually(ready: () => boolean) { for (let count = 0; !ready(); count++) { assert.ok(count < 64, '受控路由未完成预期转换'); await turn() } }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
function watch<T>(promise: Promise<T>) {
  let settled = false
  const result = promise.then(value => { settled = true; return { ok: true as const, value } }, (error: unknown) => {
    settled = true; assert.ok(error && typeof error === 'object' && 'code' in error)
    return { ok: false as const, code: error.code }
  })
  return { result, settled: () => settled }
}
const health = { runtime: 'ready', roon: 'disconnected', provider: 'missing', activeStreamCount: 0, activePlaybackPresent: false } as const
function seed(coreInstanceId: string): PlaybackStreamSnapshot {
  return { stamp: { coreInstanceId, generation: 0, sequence: 1, queueRevision: 1, selectedZoneId: null, trackId: null, source: null },
    snapshot: { state: 'idle', positionMs: 0, queue: { items: [], index: -1, hasNext: false, hasPrevious: false }, canNext: false, canPrevious: false, canStop: false, canPause: false, canResume: false } }
}
/** 实际Supervisor配合假时钟；受控端口和child不启动App、Owner、DB或Source。 */
function harness(t: TestContext, options: { persistent?: boolean; compact?: boolean; startupTimeoutMs?: number; onReady?: (client: CoreStartupClient) => Promise<void> | void } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const channels: Array<{ port1: Port; port2: Port }> = [], children: Child[] = [], events: string[] = [], lifecycle: string[] = []
  const supervisor = new CoreSupervisor({ entryPath: '/合成/未启动-core.js', cwd: '/合成/未启动', playbackEventProtocol: options.compact ? 'compact-v1' : null,
    ...(options.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: options.startupTimeoutMs }),
    ...(options.onReady ? { onReady: options.onReady } : {}), onEvent: event => events.push(event.event), onLifecycle: event => lifecycle.push(event.event),
    dependencies: {
      createChannel() {
        const index = channels.length
        const primary = new Port(message => {
          const value = message as { type?: string; command?: string; id?: string }
          if (value.command === 'core.shutdown') queueMicrotask(() => primary.receive({ version: IPC_VERSION, id: value.id, ok: true, result: { stopped: true } }))
          if (value.type === 'musicbridge.core-shutdown-received' && children[index]!.autoShutdownExit) queueMicrotask(() => children[index]!.exit(0))
        })
        const channel = { port1: new Port(), port2: primary }; channels.push(channel); return channel
      },
      fork() { const child = new Child(); children.push(child); return child },
    },
  })
  if (options.persistent !== false) supervisor.configurePrivatePersistentOwnerStartup()
  t.after(async () => {
    for (const child of children) { child.autoExitOnKill = true; child.autoShutdownExit = true }
    try {
      const closing = supervisor.shutdown().catch(() => {})
      await turn()
      // 失败反例即使断言中断也交还受控物理exit，不能在cleanup等待永不到来的外部事件。
      for (const child of children) child.exit(0)
      await closing
    } finally { t.mock.timers.reset() }
  })
  return { supervisor, channels, children, events, lifecycle,
    get port() { return channels.at(-1)!.port2 },
    ready(index = channels.length - 1, coreInstanceId?: string) { channels[index]!.port2.receive({ version: IPC_VERSION, event: 'core.ready', payload: {
      state: health, ...(coreInstanceId ? { playbackEvents: { protocol: 'compact-v1', coreInstanceId } } : {}),
    } }) },
    async advance(ms: number) { t.mock.timers.tick(ms); await turn() },
  }
}

test('持久Owner私有300秒：299999ms前不误重启，只有原ready完成才能发布；普通IPC仍2秒', async t => {
  const f = harness(t), starting = watch(f.supervisor.start())
  await f.advance(60_001)
  assert.equal(f.children.length, 1); assert.equal(f.children[0]!.killCount, 0); assert.equal(starting.settled(), false)
  f.port.receive({ version: IPC_VERSION, event: 'core.health', payload: { state: health } })
  await f.advance(239_998)
  assert.equal(f.supervisor.status, 'starting'); assert.deepEqual(f.events, []); assert.equal(starting.settled(), false)
  f.ready(); assert.deepEqual(await starting.result, { ok: true, value: undefined })
  assert.equal(f.supervisor.status, 'ready'); assert.deepEqual(f.events, ['core.ready']); assert.equal(f.children.length, 1)
  const request = watch(f.supervisor.request('core.ping', {}))
  await f.advance(1_999); assert.equal(request.settled(), false)
  await f.advance(1); assert.deepEqual(await request.result, { ok: false, code: 'TIMEOUT' })
  await f.advance(300_000); assert.equal(f.children.length, 1, '成功必须清除原启动计时器')
})

test('持久Owner每轮绝对300秒整点超时，保原最多一次且真实exit后的重试', async t => {
  const f = harness(t), starting = watch(f.supervisor.start()), oldPort = f.port
  await f.advance(299_999); assert.equal(f.children.length, 1); assert.equal(starting.settled(), false)
  await f.advance(1)
  assert.equal(f.children[0]!.exited, true); assert.equal(f.children[0]!.killCount, 1); assert.equal(f.children.length, 2); assert.equal(f.supervisor.restarts, 1)
  oldPort.receive({ version: IPC_VERSION, event: 'core.ready', payload: { state: health } })
  await f.advance(299_999); assert.equal(starting.settled(), false); assert.deepEqual(f.events, [])
  await f.advance(1); assert.deepEqual(await starting.result, { ok: false, code: 'TIMEOUT' })
  assert.equal(f.supervisor.status, 'failed'); assert.equal(f.children[1]!.exited, true)
  await f.advance(500_000); assert.equal(f.children.length, 2); assert.deepEqual(f.events, [])
})

test('未配置私有持久策略仍为原60秒默认值', async t => {
  const f = harness(t, { persistent: false }), starting = watch(f.supervisor.start())
  await f.advance(59_999); assert.equal(f.children.length, 1); assert.equal(starting.settled(), false)
  await f.advance(1); assert.equal(f.children.length, 2); assert.equal(f.children[0]!.exited, true)
  f.ready(); assert.deepEqual(await starting.result, { ok: true, value: undefined })
})

for (const duration of [1, 2_000, 60_000]) test(`显式startupTimeoutMs=${duration}仍优先收紧私有300秒`, async t => {
  const f = harness(t, { startupTimeoutMs: duration }), starting = watch(f.supervisor.start())
  await f.advance(duration - 1); assert.equal(f.children.length, 1); assert.equal(starting.settled(), false)
  await f.advance(1); assert.equal(f.children.length, 2); assert.equal(f.children[0]!.exited, true)
  f.ready(); assert.deepEqual(await starting.result, { ok: true, value: undefined })
})

test('私有策略只能首次启动前配置一次，启动/ready/退出后均拒；构造器上限仍60秒', async t => {
  const f = harness(t, { persistent: false })
  assert.equal(f.supervisor.configurePrivatePersistentOwnerStartup(), undefined)
  assert.throws(() => f.supervisor.configurePrivatePersistentOwnerStartup(), { code: 'NOT_READY' })
  const starting = watch(f.supervisor.start())
  assert.throws(() => f.supervisor.configurePrivatePersistentOwnerStartup(), { code: 'NOT_READY' })
  f.ready(); await starting.result
  assert.throws(() => f.supervisor.configurePrivatePersistentOwnerStartup(), { code: 'NOT_READY' })
  await f.supervisor.shutdown(); assert.equal(f.supervisor.status, 'stopped')
  assert.throws(() => f.supervisor.configurePrivatePersistentOwnerStartup(), { code: 'NOT_READY' })
  for (const startupTimeoutMs of [0, 60_001, 300_000, Infinity, 1.5]) assert.throws(() => new CoreSupervisor({
    entryPath: '/合成/不应fork', cwd: '/合成/未启动', startupTimeoutMs,
    dependencies: { createChannel() { throw new Error('不应创建通道') }, fork() { throw new Error('不应fork') } },
  }), { code: 'INVALID_IPC_REQUEST' })
})

test('恢复hook沿用原300秒总期限，重复start共等；旧hook和旧client不提交新代ready', async t => {
  const gates = [deferred(), deferred()], clients: CoreStartupClient[] = []
  const f = harness(t, { onReady: client => { clients.push(client); return gates[clients.length - 1]!.promise } })
  const starting = watch(f.supervisor.start())
  await f.advance(290_000); f.ready(); await eventually(() => clients.length === 1)
  const duplicate = watch(f.supervisor.start())
  f.port.receive({ version: IPC_VERSION, event: 'core.health', payload: { state: health } })
  await f.advance(9_999); assert.equal(starting.settled(), false); assert.equal(duplicate.settled(), false); assert.deepEqual(f.events, [])
  await assert.rejects(f.supervisor.request('core.ping', {}), { code: 'NOT_READY' })
  await f.advance(1); assert.equal(f.children.length, 2)
  f.ready(); await eventually(() => clients.length === 2)
  gates[0]!.resolve(); await turn()
  assert.equal(f.supervisor.status, 'starting'); assert.deepEqual(f.events, [])
  await assert.rejects(clients[0]!.request('core.ping', {}), { code: 'NOT_READY' })
  await f.advance(299_999); assert.equal(starting.settled(), false)
  gates[1]!.resolve()
  assert.deepEqual(await starting.result, { ok: true, value: undefined }); assert.deepEqual(await duplicate.result, { ok: true, value: undefined })
  assert.deepEqual(f.events, ['core.ready']); assert.equal(f.children.length, 2)
})

test('播放seed不另续300秒：hook后仍先等真实seed，末毫秒超时且拒旧代seed', async t => {
  const gate = deferred(), f = harness(t, { compact: true, onReady: () => gate.promise })
  const starting = watch(f.supervisor.start()), oldId = randomUUID(), oldPort = f.port
  await f.advance(290_000); f.ready(0, oldId); await turn()
  await f.advance(9_998); assert.equal(oldPort.sent.length, 0); assert.deepEqual(f.events, [])
  gate.resolve(); await turn()
  const oldRequest = oldPort.sent.at(-1) as { command: string; id: string }
  assert.equal(oldRequest.command, 'playback.getStreamSnapshot'); assert.equal(f.supervisor.status, 'starting')
  await f.advance(1); assert.equal(starting.settled(), false)
  await f.advance(1); assert.equal(f.children.length, 2)
  oldPort.receive({ version: IPC_VERSION, id: oldRequest.id, ok: true, result: seed(oldId) }); await turn()
  assert.deepEqual(f.events, []); assert.equal(starting.settled(), false)
  const currentId = randomUUID(); f.ready(1, currentId); await turn()
  const request = f.port.sent.at(-1) as { command: string; id: string }
  assert.equal(request.command, 'playback.getStreamSnapshot')
  f.port.receive({ version: IPC_VERSION, id: request.id, ok: true, result: seed(currentId) })
  assert.deepEqual(await starting.result, { ok: true, value: undefined }); assert.deepEqual(f.events, ['core.ready', 'playback.snapshot'])
})

for (const duration of [200, 150_000]) test(`原restart readyTimeoutMs=${duration}优先于显式短限及私有300秒，结束后不泄漏`, async t => {
  const f = harness(t, { startupTimeoutMs: 10 }), starting = watch(f.supervisor.start())
  f.ready(); await starting.result
  const restarting = watch(f.supervisor.restart(undefined, { readyTimeoutMs: duration }))
  await eventually(() => f.children.length === 2)
  await f.advance(duration - 1); assert.equal(f.children.length, 2); assert.equal(restarting.settled(), false)
  await f.advance(1); assert.equal(f.children.length, 3); assert.equal(f.children[1]!.exited, true)
  f.ready(); assert.deepEqual(await restarting.result, { ok: true, value: undefined })
  const again = watch(f.supervisor.restart()); await eventually(() => f.children.length === 4)
  await f.advance(9); assert.equal(f.children.length, 4)
  await f.advance(1); assert.equal(f.children.length, 5)
  f.ready(); assert.deepEqual(await again.result, { ok: true, value: undefined })
})

test('300秒超时只发kill但未见旧child物理exit时，250ms原屏障拒重试和新writer', async t => {
  const f = harness(t), starting = watch(f.supervisor.start())
  f.children[0]!.autoExitOnKill = false
  await f.advance(300_000); assert.equal(f.children[0]!.killCount, 1); assert.equal(f.children[0]!.exited, false); assert.equal(f.children.length, 1)
  await f.advance(249); assert.equal(starting.settled(), false); assert.equal(f.children.length, 1)
  await f.advance(1); assert.deepEqual(await starting.result, { ok: false, code: 'NOT_READY' }); assert.equal(f.supervisor.status, 'failed')
  await assert.rejects(f.supervisor.start(), { code: 'NOT_READY' })
  f.children[0]!.exit(0); await turn(); assert.equal(f.children.length, 1, '迟到exit本身不得重启')
})

test('300秒等待中主动shutdown仍撤销启动，ACK后继续等实际exit，迟到ready不复活', async t => {
  const f = harness(t), starting = watch(f.supervisor.start())
  await f.advance(60_001)
  f.children[0]!.autoShutdownExit = false
  const closing = watch(f.supervisor.shutdown()); await turn()
  assert.deepEqual(await starting.result, { ok: false, code: 'NOT_READY' })
  assert.equal(closing.settled(), false); assert.equal(f.children[0]!.exited, false); assert.equal(f.children[0]!.killCount, 0)
  assert.equal(f.port.sent.filter(value => (value as { type?: string }).type === 'musicbridge.core-shutdown-received').length, 1)
  f.ready(); await turn(); assert.deepEqual(f.events, [])
  f.children[0]!.exit(0); assert.deepEqual(await closing.result, { ok: true, value: undefined })
  assert.equal(f.supervisor.status, 'stopped'); assert.equal(f.children.length, 1)
  await f.advance(300_000); assert.equal(f.children.length, 1)
})

test('实际Main factory创建后固定一次私有策略，不依赖Native资格/环境开关且不提前start', async () => {
  const source = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const start = source.indexOf('function createCoreSupervisor('), end = source.indexOf('\nasync function prepareCoreDataDirectory', start)
  assert.ok(start >= 0 && end > start)
  class Supervisor {
    configurationCount = 0
    startCount = 0
    constructor(readonly options: { startupTimeoutMs?: number }) {}
    configurePrivatePersistentOwnerStartup() { this.configurationCount++ }
    start() { this.startCount++ }
  }
  const exports: { create?: (directory: string) => Supervisor } = {}
  const sandbox = { exports, CoreSupervisor: Supervisor, path: { join: (...parts: string[]) => parts.join('/') },
    currentDirectory: '/合成/未启动', coreDataDirectory: undefined, process: { env: {} as Record<string, string> }, buildCoreEnvironment: () => ({}),
    mainDiagnostics: { performance: undefined }, performanceIpc: { context: () => undefined }, libraryReadTrace: undefined, mobilePreparationProbe: undefined }
  const code = ts.transpileModule(source.slice(start, end) + '\nexports.create = createCoreSupervisor', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  runInNewContext(code, sandbox)
  const first = exports.create!('/合成/持久工作库')
  sandbox.process.env.MUSIC_BRIDGE_COMPACT_PLAYBACK_EVENTS = '0'
  const second = exports.create!('/合成/另一个持久工作库')
  for (const supervisor of [first, second]) {
    assert.equal(supervisor.configurationCount, 1); assert.equal(supervisor.startCount, 0)
    assert.equal(supervisor.options.startupTimeoutMs, undefined, 'Main不提高原构造器可接收期限')
  }
  assert.notEqual(first, second)
})
