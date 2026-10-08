import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const relocationMarker = 'local-relocation-main-port-v1'
const wrappers = ['private-rust-main-host-wrapper.mjs', 'private-rust-collection-main-host-wrapper.mjs'] as const
const hosts = ['private-rust-host.ts', 'private-rust-collection-host.ts'] as const
type BootstrapMessage = Record<string, unknown>
type PortListener = (event: { data: unknown }) => void
interface Port {
  readonly name: string
  readonly listeners: PortListener[]
  readonly messages: unknown[]
  starts: number
  on(event: string, listener: PortListener): void
  start(): void
  postMessage(message: unknown): void
  close(): void
}
interface Forwarded { data: unknown; ports: unknown[] }
type ParentCallback = (event: Forwarded) => void
interface InvalidPortCase { name: string; data: unknown; ports: unknown[] }
const fixturePorts = new WeakSet<object>()

function port(name: string): Port {
  const result: Port = {
    name, listeners: [], messages: [], starts: 0,
    on(event, listener) { assert.equal(event, 'message'); this.listeners.push(listener) },
    start() { this.starts++ },
    postMessage(message) { this.messages.push(message) },
    close() {},
  }
  fixturePorts.add(result)
  return result
}
function message(relocation = false, compact = false): BootstrapMessage {
  return { type: 'musicbridge.core.port', ...(compact ? { playbackEventProtocol: 'compact-v1' } : {}),
    ...(relocation ? { relocationMainPort: relocationMarker } : {}) }
}
function assertExactForward(received: Forwarded[], data: unknown, expected: Port[]): void {
  assert.equal(received.length, 1, '真实转交函数必须恰好投递一次。')
  assert.strictEqual(received[0]!.data, data, '原启动消息不能被重写或重新构造。')
  assert.equal(received[0]!.ports.length, expected.length)
  expected.forEach((value, index) => assert.strictEqual(received[0]!.ports[index], value, '端口身份及顺序必须完整保留。'))
}

const wrapperArrows = new Map<string, string>()
function wrapper(filename: typeof wrappers[number], observer: unknown, observerPeer: unknown = port('独立观察Main端')) {
  let arrow = wrapperArrows.get(filename)
  if (!arrow) {
    const url = new URL(`../e2e/${filename}`, import.meta.url)
    const source = ts.createSourceFile(fileURLToPath(url), readFileSync(url, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS)
    const assignments: ts.ArrowFunction[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isPropertyAccessExpression(node.left) && ts.isIdentifier(node.left.expression)
        && node.left.expression.text === 'child' && node.left.name.text === 'postMessage' && ts.isArrowFunction(node.right)) assignments.push(node.right)
      ts.forEachChild(node, visit)
    }
    visit(source)
    assert.equal(assignments.length, 1, '必须执行当前wrapper中唯一真实child.postMessage赋值，不能另写替代守卫。')
    arrow = assignments[0]!.getText(source)
    wrapperArrows.set(filename, arrow)
  }
  const received: Forwarded[] = []
  // 只执行完整真实箭头；绕开Electron启动及末尾dynamic import，闭包仅注入真实箭头使用的转交和观察端口。
  const forward = runInNewContext(`(${arrow})`, {
    Object, Array,
    channel: { port1: observer, port2: observerPeer },
    post(data: unknown, ports: unknown[]) { received.push({ data, ports }) },
  }, { filename }) as (data: unknown, ports: unknown[]) => void
  return { forward, received }
}

const hostModules = new Map<string, string>()
async function host(filename: typeof hosts[number]) {
  let compiled = hostModules.get(filename)
  if (!compiled) {
    const url = new URL(`../e2e/${filename}`, import.meta.url)
    compiled = ts.transpileModule(readFileSync(url, 'utf8'), {
      fileName: fileURLToPath(url),
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText
    hostModules.set(filename, compiled)
  }
  const callbacks: ParentCallback[] = [], received: Forwarded[] = []
  const parent = { once(event: string, listener: ParentCallback): void { assert.equal(event, 'message'); callbacks.push(listener) } }
  const originalOnce = parent.once
  // 全部模块依赖都是局部对象；实际process、child_process和Worker都不会被赋值、启动或转交。
  const childProcess = { spawn(): never { throw new Error('本用例不得启动真实子进程。') } }
  const requireMock = (name: string): unknown => {
    if (name === 'node:child_process') return childProcess
    if (name === 'node:crypto') return { randomUUID: () => '00000000-0000-4000-8000-000000000001' }
    if (name === 'node:worker_threads') return { Worker: class { constructor() { throw new Error('本用例不得创建真实Worker。') } } }
    if (name === '@music-bridge/contracts') return { validateIpcRequest(): never { throw new Error('启动转交不应调用公共业务请求。') } }
    if (name === '../../../packages/bridge-core/src/utility-main.js') return {
      runCoreUtilityProcess() {
        parent.once('message', event => { received.push(event) })
        return Promise.resolve()
      },
    }
    if (name === '../src/main/core-host.js') return {
      async runDesktopCoreHost(options: { dependencies: { runCoreUtilityProcess: (...args: unknown[]) => unknown } }) {
        const ownerFactory = (): never => { throw new Error('本用例只捕获启动回调，不创建Owner。') }
        await options.dependencies.runCoreUtilityProcess(undefined, undefined, undefined, undefined, null, ownerFactory)
      },
    }
    throw new Error(`隔离模块出现未批准依赖：${name}`)
  }
  const module = { exports: {} as Record<string, unknown> }
  runInNewContext(compiled, {
    Object, Array, module, exports: module.exports, require: requireMock,
    process: { env: { MUSIC_BRIDGE_CORE_TEST_MODE: '1', MUSIC_BRIDGE_UI_E2E: '1' }, parentPort: parent },
    performance: { now: () => 0 },
  }, { filename })
  const start = module.exports.startPrivateDesktopHost as (rust: boolean, models: number) => Promise<void>
  assert.equal(typeof start, 'function')
  await start(false, 100)
  assert.strictEqual(parent.once, originalOnce, '真实observedUtility必须恢复其局部parent.once。')
  assert.equal(callbacks.length, 2, '必须捕获观察入口和实际Utility转交入口的两个真实回调。')
  return { observer: callbacks[0]!, utility: callbacks[1]!, received }
}

async function assertValidHost(filename: typeof hosts[number], data: BootstrapMessage, production: Port[]): Promise<void> {
  const fixture = await host(filename), observer = port('独立观察口')
  const originalPorts = [...production, observer]
  const event = { data, ports: originalPorts }
  let observerFailure: unknown, utilityFailure: unknown
  // 即使旧观察入口拒绝4口，也独立调用实际Utility入口，避免前一个失败遮住另一处旧守卫。
  try { fixture.observer(event) } catch (error) { observerFailure = error }
  try { fixture.utility(event) } catch (error) { utilityFailure = error }
  assert.equal(observerFailure, undefined, '真实观察回调必须接受批准的完整布局。')
  assert.equal(utilityFailure, undefined, '真实Utility回调必须接受批准的完整布局。')
  assertExactForward(fixture.received, data, production)
  assert.equal(originalPorts.length, production.length + 1, '输入端口数组不能被就地截短。')
  assert.strictEqual(originalPorts[originalPorts.length - 1], observer)
  assert.equal(observer.starts, 1)
  assert.equal(observer.listeners.length, 1)
  assert.equal(production[0]!.listeners.length, 1, '只允许公共口安装原观察器。')
  for (const privatePort of production.slice(1)) {
    assert.equal(privatePort.starts, 0, '不能启动或观察源写/搬迁私有口。')
    assert.equal(privatePort.listeners.length, 0)
  }
}

function invalidMessages(): { name: string; data: unknown }[] {
  return [
    { name: '错误搬迁标记', data: { ...message(), relocationMainPort: 'local-relocation-main-port-v2' } },
    { name: '空搬迁标记', data: { ...message(), relocationMainPort: null } },
    { name: '未知消息字段', data: { ...message(), sourceWritesPort: true } },
    { name: '未知私有字段', data: { ...message(), actor: '伪造' } },
    { name: '错误compact协议', data: { ...message(), playbackEventProtocol: 'compact-v2' } },
    { name: '空compact协议', data: { ...message(), playbackEventProtocol: null } },
    { name: '错误消息类型', data: { type: 'musicbridge.core.other' } },
    { name: '空消息', data: null },
    { name: '数组伪消息', data: Object.assign([], message()) },
  ]
}

function undefinedOptionalMessages(): BootstrapMessage[] {
  return [{ ...message(), relocationMainPort: undefined }, { ...message(), playbackEventProtocol: undefined }]
}

function invalidPortArrays(count: number): { name: string; ports: unknown[] }[] {
  const cases: { name: string; ports: unknown[] }[] = []
  for (let index = 0; index < count; index++) {
    for (const [name, value] of [['null', null], ['undefined', undefined], ['原始值', '伪造端口']] as const) {
      const ports: unknown[] = Array.from({ length: count }, (_, i) => port(`端口${i}`))
      ports[index] = value
      cases.push({ name: `合法数量${count}位置${index}为${name}`, ports })
    }
  }
  const hole: unknown[] = Array.from({ length: count }, (_, i) => port(`端口${i}`))
  delete hole[0]
  cases.push({ name: `合法数量${count}包含真实数组空洞`, ports: hole })
  return cases
}

function assertUnobservedPorts(ports: unknown[]): void {
  // 空洞和非对象不能让测试自身TypeError遮住守卫；仅核本fixture创建的端口对象副作用。
  for (const value of ports) {
    if (value === null || typeof value !== 'object' || !fixturePorts.has(value)) continue
    const candidate = value as Port
    assert.equal(candidate.starts, 0, '拒绝前不能启动伪布局中的端口。')
    assert.equal(candidate.listeners.length, 0, '拒绝前不能给伪布局安装观察器。')
  }
}

for (const filename of wrappers) {
  test(`${filename}：当前三生产口及独立观察口原样转交`, () => {
    const observer = port('观察'), production = [port('公共'), port('源写'), port('搬迁')]
    const fixture = wrapper(filename, observer), data = Object.freeze(message(true, true))
    fixture.forward(data, production)
    assertExactForward(fixture.received, data, [...production, observer])
    assert.equal(production.length, 3)
  })

  test(`${filename}：旧二生产口及省略compact协议保持合法`, () => {
    for (const compact of [false, true]) {
      const observer = port('观察'), production = [port('公共'), port('源写')]
      const fixture = wrapper(filename, observer), data = Object.freeze(message(false, compact))
      fixture.forward(data, production)
      assertExactForward(fixture.received, data, [...production, observer])
    }
    for (const data of undefinedOptionalMessages()) {
      const observer = port('观察'), production = [port('公共'), port('源写')]
      const fixture = wrapper(filename, observer)
      fixture.forward(data, production)
      assertExactForward(fixture.received, data, [...production, observer])
    }
    const observer = port('观察'), production = [port('公共'), port('源写'), port('搬迁')]
    const fixture = wrapper(filename, observer), data = message(true)
    fixture.forward(data, production)
    assertExactForward(fixture.received, data, [...production, observer])
  })

  test(`${filename}：伪消息、端口缺失多余及观察口复用均在转交前拒绝`, () => {
    const cases: (InvalidPortCase & { observer: unknown; observerPeer?: unknown })[] = invalidMessages()
      .map(value => ({ ...value, ports: [port('公共'), port('源写')], observer: port('观察') }))
    for (const relocation of [false, true]) {
      const expected = relocation ? 3 : 2
      for (const count of [0, expected - 1, expected + 1]) cases.push({ name: `标记${relocation}端口数量${count}`, data: message(relocation),
        ports: Array.from({ length: count }, (_, i) => port(`生产${i}`)), observer: port('观察') })
      const shared = port('共享')
      cases.push({ name: `标记${relocation}生产口共享`, data: message(relocation), ports: Array.from({ length: expected }, () => shared), observer: port('观察') })
      const production = Array.from({ length: expected }, (_, i) => port(`生产${i}`))
      cases.push({ name: `标记${relocation}观察口复用`, data: message(relocation), ports: production, observer: production[expected - 1]! })
      cases.push({ name: `标记${relocation}观察Main端复用生产口`, data: message(relocation), ports: production,
        observer: port('观察'), observerPeer: production[0]! })
      for (const value of invalidPortArrays(expected)) cases.push({ ...value, data: message(relocation), observer: port('观察') })
    }
    for (const value of cases) {
      const fixture = wrapper(filename, value.observer, value.observerPeer)
      assert.throws(() => fixture.forward(value.data, value.ports), value.name)
      assert.equal(fixture.received.length, 0, `${value.name}不能调用真实post。`)
      assertUnobservedPorts(value.ports)
    }
  })
}

for (const filename of hosts) {
  test(`${filename}：两次真实parent回调接受当前三生产口且仅剥离尾观察口`, async () => {
    await assertValidHost(filename, Object.freeze(message(true, true)), [port('公共'), port('源写'), port('搬迁')])
  })

  test(`${filename}：旧Node总二/三口与relocation-only总三口保持合法`, async () => {
    for (const compact of [false, true]) {
      await assertValidHost(filename, message(false, compact), [port('公共')])
      await assertValidHost(filename, message(false, compact), [port('公共'), port('源写')])
      await assertValidHost(filename, message(true, compact), [port('公共'), port('搬迁')])
    }
    for (const data of undefinedOptionalMessages()) {
      await assertValidHost(filename, data, [port('公共')])
      await assertValidHost(filename, data, [port('公共'), port('源写')])
    }
  })

  test(`${filename}：观察与Utility入口分别拒伪造标记、私有字段和端口复用`, async () => {
    const cases: InvalidPortCase[] = invalidMessages().map(value => ({ ...value, ports: [port('公共'), port('观察')] }))
    for (const [relocation, invalidCounts] of [[false, [0, 1, 4]], [true, [0, 1, 2, 5]]] as const) {
      for (const count of invalidCounts) cases.push({ name: `标记${relocation}总端口数量${count}`, data: message(relocation),
        ports: Array.from({ length: count }, (_, i) => port(`端口${i}`)) })
      const publicPort = port('共享公共口'), privatePort = port('共享私有口')
      cases.push({ name: `标记${relocation}观察口复用公共口`, data: message(relocation), ports: [publicPort, publicPort] })
      cases.push({ name: `标记${relocation}生产口彼此复用`, data: message(relocation), ports: [publicPort, privatePort, privatePort, port('观察')] })
      cases.push({ name: `标记${relocation}观察口复用私有口`, data: message(relocation), ports: [publicPort, privatePort, privatePort] })
      for (const count of relocation ? [3, 4] : [2, 3]) {
        for (const value of invalidPortArrays(count)) cases.push({ ...value, data: message(relocation) })
      }
    }
    for (const value of cases) {
      for (const entry of ['observer', 'utility'] as const) {
        const fixture = await host(filename)
        assert.throws(() => fixture[entry]({ data: value.data, ports: value.ports }), `${entry}：${value.name}`)
        assert.equal(fixture.received.length, 0, `${entry}：${value.name}不能进入实际Utility。`)
        assertUnobservedPorts(value.ports)
      }
    }
  })
}
