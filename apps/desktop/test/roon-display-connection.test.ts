import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInThisContext } from 'node:vm'
import { normalizeRoonDisplayUrl } from '@music-bridge/contracts'
import * as ts from 'typescript'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(onResolve => { resolve = onResolve })
  return { promise, resolve }
}

const files = new Map<string, string>()
const renameGates = new Map<string, ReturnType<typeof deferred>>()
const failedRenames = new Set<string>()
let readGate: ReturnType<typeof deferred> | undefined

const fakeFiles = {
  stat: async (path: string) => {
    const value = files.get(path)
    if (value === undefined) throw new Error('不存在')
    return { size: Buffer.byteLength(value) }
  },
  readFile: async (path: string) => {
    const value = files.get(path)
    if (value === undefined) throw new Error('不存在')
    await readGate?.promise
    return value
  },
  writeFile: async (path: string, value: string) => {
    if (files.has(path)) throw new Error('临时文件已存在')
    files.set(path, value)
  },
  rename: async (source: string, target: string) => {
    const value = files.get(source)
    if (value === undefined) throw new Error('临时文件不存在')
    const url = JSON.parse(value).url as string
    await renameGates.get(url)?.promise
    if (failedRenames.has(url)) throw new Error('合成写盘失败')
    files.set(target, value)
    files.delete(source)
  },
  unlink: async (path: string) => { files.delete(path) },
}

class FakeDebugger extends EventEmitter {
  attach(): void {}
  async sendCommand(): Promise<void> {}
}

class FakeWebContents extends EventEmitter {
  debugger = new FakeDebugger()
  setWindowOpenHandler(): void {}
}

class FakeBrowserWindow {
  static all: FakeBrowserWindow[] = []
  webContents = new FakeWebContents()
  url = ''
  destroyed = false

  constructor() { FakeBrowserWindow.all.push(this) }
  loadURL(url: string): Promise<void> { this.url = url; return Promise.resolve() }
  isDestroyed(): boolean { return this.destroyed }
  destroy(): void { this.destroyed = true }
  static live(): FakeBrowserWindow[] { return this.all.filter(window => !window.destroyed) }
}

const fakeElectron = {
  BrowserWindow: FakeBrowserWindow,
  session: { fromPartition: () => ({
    setPermissionRequestHandler: () => undefined,
    setPermissionCheckHandler: () => undefined,
    on: () => undefined,
    webRequest: { onBeforeRequest: () => undefined },
  }) },
}

// 用标准 Node 测试入口执行真实连接类源码，并仅替换 Electron 与配置文件边界。
// 避免 node:test 的 experimental module mock 标志影响整套单测入口。
const sourcePath = new URL('../src/main/roon-display-connection.ts', import.meta.url)
const compiled = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const connectionModule: { exports: Record<string, unknown> } = { exports: {} }
const factory = runInThisContext(`(function (require, module, exports) { ${compiled}\n})`, {
  filename: sourcePath.pathname,
}) as (require: (name: string) => unknown, module: typeof connectionModule, exports: typeof connectionModule.exports) => void
factory((name) => {
  if (name === 'electron') return fakeElectron
  if (name === 'node:crypto') return { randomUUID }
  if (name === 'node:fs/promises') return fakeFiles
  if (name === '@music-bridge/contracts') return { normalizeRoonDisplayUrl }
  if (name === './roon-display-protocol.js') return { RoonDisplayProtocol: class {
    clear(): void {}
    receive(): [] { return [] }
  } }
  throw new Error(`未预期的连接模块依赖：${name}`)
}, connectionModule, connectionModule.exports)
const { RoonDisplayConnection } = connectionModule.exports as {
  RoonDisplayConnection: typeof import('../src/main/roon-display-connection.js').RoonDisplayConnection
}
const settingsPath = '/Volumes/LifeWeave/Developer/CommandLine/tmp/synthetic-roon-display-settings.json'
const A = 'http://192.168.1.10:9330/display/'
const B = 'http://192.168.1.11:9330/display/'
const C = 'http://192.168.1.12:9330/display/'

function resetFakes(): void {
  files.clear()
  renameGates.clear()
  failedRenames.clear()
  readGate = undefined
  FakeBrowserWindow.all = []
}

function diskUrl(): string | undefined {
  const value = files.get(settingsPath)
  return value === undefined ? undefined : JSON.parse(value).url as string
}

function connection() {
  return new RoonDisplayConnection({ settingsPath, forward: async () => undefined })
}

function fakeTimers() {
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const scheduled = new Map<number, { callback: () => void; delay: number }>()
  let nextId = 0
  globalThis.setTimeout = ((callback: () => void, delay: number) => {
    const id = ++nextId
    scheduled.set(id, { callback, delay })
    return id as unknown as ReturnType<typeof setTimeout>
  }) as typeof setTimeout
  globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
    scheduled.delete(timer as unknown as number)
  }) as typeof clearTimeout
  return {
    fire(delay: number) {
      for (const [id, entry] of [...scheduled]) if (entry.delay === delay) {
        scheduled.delete(id)
        entry.callback()
      }
    },
    restore() {
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
    },
  }
}

async function settleAsync(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
}

test('A→B→C 串行保存期间旧重试不能恢复 A，逐次返回与最终窗口均对应已写盘配置', async () => {
  resetFakes()
  const timers = fakeTimers()
  const display = connection()
  try {
    assert.equal((await display.configure(A)).url, A)
    FakeBrowserWindow.live()[0]?.webContents.emit('did-fail-load')
    const gate = deferred()
    renameGates.set(B, gate)
    const saveB = display.configure(B)
    const saveC = display.configure(C)
    await settleAsync()
    timers.fire(10_000)
    gate.resolve()
    assert.equal((await saveB).url, B)
    assert.equal((await saveC).url, C)
    assert.equal(diskUrl(), C)
    assert.equal(display.getSettings().url, C)
    assert.deepEqual(FakeBrowserWindow.live().map(window => window.url), [C])
  } finally { display.stop(); timers.restore() }
})

test('清空配置写盘期间触发旧重试，完成后磁盘、返回和窗口一致关闭', async () => {
  resetFakes()
  const timers = fakeTimers()
  const display = connection()
  try {
    await display.configure(A)
    FakeBrowserWindow.live()[0]?.webContents.emit('did-fail-load')
    const gate = deferred()
    renameGates.set('', gate)
    const clearing = display.configure('')
    await settleAsync()
    timers.fire(10_000)
    gate.resolve()
    assert.deepEqual(await clearing, { url: '', status: 'disabled' })
    assert.equal(diskUrl(), '')
    assert.deepEqual(FakeBrowserWindow.live(), [])
  } finally { display.stop(); timers.restore() }
})

test('Core stop 不取消 pending 配置，暂停期间不建窗口，ready 后只连接新地址', async () => {
  resetFakes()
  const display = connection()
  try {
    await display.configure(A)
    const gate = deferred()
    renameGates.set(B, gate)
    const saving = display.configure(B)
    await settleAsync()
    display.stop()
    gate.resolve()
    assert.deepEqual(await saving, { url: B, status: 'disconnected' })
    assert.equal(diskUrl(), B)
    assert.deepEqual(FakeBrowserWindow.live(), [])
    display.restart()
    assert.deepEqual(FakeBrowserWindow.live().map(window => window.url), [B])
  } finally { display.stop() }
})

test('Core ready 在新配置写盘中可暂用旧有效地址，落盘后切换到新地址', async () => {
  resetFakes()
  const display = connection()
  try {
    await display.configure(A)
    const gate = deferred()
    renameGates.set(B, gate)
    const saving = display.configure(B)
    await settleAsync()
    display.stop()
    display.restart()
    assert.deepEqual(FakeBrowserWindow.live().map(window => window.url), [A])
    gate.resolve()
    assert.equal((await saving).url, B)
    assert.equal(diskUrl(), B)
    assert.deepEqual(FakeBrowserWindow.live().map(window => window.url), [B])
  } finally { display.stop() }
})

test('restore 与 configure 串行，写盘失败保留有效配置并恢复连接', async () => {
  resetFakes()
  files.set(settingsPath, JSON.stringify({ url: A }) + '\n')
  const display = connection()
  try {
    const gate = deferred()
    readGate = gate
    const restoring = display.restore()
    const saving = display.configure(B)
    gate.resolve()
    await restoring
    assert.equal((await saving).url, B)
    assert.equal(diskUrl(), B)
    assert.deepEqual(FakeBrowserWindow.live().map(window => window.url), [B])

    failedRenames.add(C)
    await assert.rejects(display.configure(C), /合成写盘失败/)
    assert.equal(diskUrl(), B)
    assert.equal(display.getSettings().url, B)
    assert.deepEqual(FakeBrowserWindow.live().map(window => window.url), [B])
  } finally { display.stop() }
})

test('排队中的旧配置 B 成功而新配置 C 失败时，以最近成功写盘的 B 为准', async () => {
  resetFakes()
  const display = connection()
  try {
    await display.configure(A)
    const gate = deferred()
    renameGates.set(B, gate)
    failedRenames.add(C)
    const savingB = display.configure(B)
    const savingC = display.configure(C)
    await settleAsync()
    gate.resolve()
    assert.equal((await savingB).url, B)
    await assert.rejects(savingC, /合成写盘失败/)
    assert.equal(diskUrl(), B)
    assert.equal(display.getSettings().url, B)
    assert.deepEqual(FakeBrowserWindow.live().map(window => window.url), [B])
  } finally { display.stop() }
})

test('旧重试因新配置意图失效后若写盘失败，可恢复上一个有效地址', async () => {
  resetFakes()
  const timers = fakeTimers()
  const display = connection()
  try {
    await display.configure(A)
    FakeBrowserWindow.live()[0]?.webContents.emit('did-fail-load')
    const gate = deferred()
    renameGates.set(B, gate)
    failedRenames.add(B)
    const saving = display.configure(B)
    await settleAsync()
    timers.fire(10_000)
    gate.resolve()
    await assert.rejects(saving, /合成写盘失败/)
    assert.equal(diskUrl(), A)
    assert.equal(display.getSettings().url, A)
    assert.deepEqual(FakeBrowserWindow.live().map(window => window.url), [A])
  } finally { display.stop(); timers.restore() }
})

test('restore 读盘未完成时 Core stop 只暂停连接，随后 ready 使用恢复的地址', async () => {
  resetFakes()
  files.set(settingsPath, JSON.stringify({ url: A }) + '\n')
  const display = connection()
  try {
    const gate = deferred()
    readGate = gate
    const restoring = display.restore()
    await settleAsync()
    display.stop()
    gate.resolve()
    await restoring
    assert.deepEqual(display.getSettings(), { url: A, status: 'disconnected' })
    assert.deepEqual(FakeBrowserWindow.live(), [])
    display.restart()
    assert.deepEqual(FakeBrowserWindow.live().map(window => window.url), [A])
  } finally { display.stop() }
})
