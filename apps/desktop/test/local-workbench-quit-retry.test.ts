import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { createLocalWorkbenchQuitCoordinator } from '../src/main/local-library-workbench/quit-coordinator.js'
import { shouldHideWindowOnClose } from '../src/main/tray.js'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const phases = [
  'prepare_name', 'prepare_lyrics', 'prepare_reads', 'prepare_normalizer', 'owner_shutdown',
  'join_name', 'join_lyrics_grant', 'join_lyrics_provider', 'join_directory', 'join_readers',
  'close_management', 'close_legacy', 'close_assembly', 'close_lyrics_main', 'close_lyrics_provider', 'close_name',
  'remote_stop', 'mobile_close', 'close_outbox',
] as const
type Phase = typeof phases[number]
type Entry = { kind: string; phase?: string; attempt?: number; status?: string }
type Diagnostic = { event: string; level: string; fields: Record<string, unknown> }
type QuitEvent = { preventDefault(): void }

/** 执行Main源码中的原退出回调；受控关闭仅证明调度，不冒充真实Owner或FD闭口。 */
async function originalQuitFixture(controls: Partial<Record<Phase, (attempt: number) => unknown>>, options: { fakeTimers?: boolean } = {}) {
  const text = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const source = ts.createSourceFile('index.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const handlers: ts.ArrowFunction[] = []
  const windowHandlers: ts.ArrowFunction[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(source) === 'app' && node.expression.name.text === 'on'
      && node.arguments.length === 2 && ts.isStringLiteral(node.arguments[0]!)
      && node.arguments[0]!.text === 'before-quit' && ts.isArrowFunction(node.arguments[1]!)) handlers.push(node.arguments[1]!)
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(source) === 'window' && node.expression.name.text === 'on'
      && node.arguments.length === 2 && ts.isStringLiteral(node.arguments[0]!)
      && node.arguments[0]!.text === 'close' && ts.isArrowFunction(node.arguments[1]!)) windowHandlers.push(node.arguments[1]!)
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.equal(handlers.length, 1, '必须执行Main唯一原before-quit回调')
  assert.equal(windowHandlers.length, 1, '必须执行Main唯一原主窗口close回调')
  const transpiled = ts.transpileModule(`const callback = ${handlers[0]!.getText(source)}; const closeWindow = ${windowHandlers[0]!.getText(source)}`, {
    fileName: 'original-before-quit-retry.ts', reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  })
  assert.equal((transpiled.diagnostics ?? []).some(item => item.category === ts.DiagnosticCategory.Error), false)

  const entries: Entry[] = [], diagnostics: Diagnostic[] = [], errors: Array<{ phase: Phase; reason: unknown }> = []
  const counts = new Map<Phase, number>()
  const stage = (phase: Phase): Promise<unknown> => {
    const attempt = (counts.get(phase) ?? 0) + 1
    counts.set(phase, attempt)
    entries.push({ kind: 'begin', phase, attempt })
    return Promise.resolve().then(() => controls[phase]?.(attempt)).then(value => {
      entries.push({ kind: 'settled', phase, attempt, status: 'fulfilled' })
      return value
    }, reason => {
      errors.push({ phase, reason })
      entries.push({ kind: 'settled', phase, attempt, status: 'rejected' })
      throw reason
    })
  }
  let quitCalls = 0, destroyed = 0, revoked = 0
  let timerId = 0
  const timers = new Map<number, () => void>(), timerDeadlines: number[] = []
  const record = (kind: string, phase?: string) => { entries.push({ kind, ...(phase ? { phase } : {}) }) }
  const environment = {
    createLocalWorkbenchQuitCoordinator, shouldHideWindowOnClose,
    CoreIpcError: class extends Error { constructor(readonly code: string, message: string) { super(message) } },
    window: { hide: () => record('window.hide') },
    ...(options.fakeTimers ? {
      setTimeout: (callback: () => void, milliseconds: number) => { const id = ++timerId; timers.set(id, callback); timerDeadlines.push(milliseconds); return id },
      clearTimeout: (id: number) => { timers.delete(id) },
    } : {}),
    app: { quit: () => { quitCalls++; record('app.quit') } },
    lifecycleProbe: {
      mark: (phase: string) => record('lifecycle', phase),
      observe: (promise: Promise<unknown>, done: string, failed: string) => { void promise.then(() => record('lifecycle', done), () => record('lifecycle', failed)) },
    },
    coreSupervisor: {
      shutdown: () => stage('owner_shutdown'),
      joinPrivateNameProviderBridge: () => stage('join_name'),
      joinPrivateLyricsGrantProducer: () => stage('join_lyrics_grant'),
      joinPrivateLyricsProviderBridge: () => stage('join_lyrics_provider'),
      joinPrivateWorkbenchDirectoryProducer: () => stage('join_directory'),
      joinPrivateWorkbenchReadersProducer: () => stage('join_readers'),
    },
    localWorkbenchRootMainAuthor: { binding: Object.freeze({ original: true }) },
    localWorkbenchManagementBoundary: { seal: () => record('management.seal'), close: () => stage('close_management') },
    localWorkbenchLegacyIpc: { sealReads: () => stage('prepare_reads'), close: () => stage('close_legacy') },
    localArtworkImportNormalizer: { close: () => stage('prepare_normalizer') },
    localWorkbenchMainAssembly: { close: () => stage('close_assembly') },
    localLyricsMainService: { close: () => stage('close_lyrics_main') },
    localLyricsProviderBridge: { revokeOwner: () => stage('prepare_lyrics'), close: () => stage('close_lyrics_provider') },
    localNameMainBridge: { sealOwner: () => stage('prepare_name'), close: () => stage('close_name') },
    remoteCoreTunnelManager: { stop: () => stage('remote_stop').then(state => state ?? { mode: 'local-core', status: 'idle' }) },
    mobileConnectionSettings: { close: () => stage('mobile_close') },
    commandOutbox: { close: () => { record('outbox.close'); return stage('close_outbox') } },
    roonDisplayConnection: { stop: () => record('roon.stop') },
    closeLocalArtwork: () => record('artwork.seal'),
    closeLocalSourceWrites: () => record('source.seal'),
    closeLocalRelocation: () => record('relocation.seal'),
    stopRecordingPrintWorker: () => record('print.stop'),
    destroyTray: () => { destroyed++; record('tray.destroy') },
    revokeLocalWorkbenchRootMainAuthor: () => { revoked++; record('author.revoke') },
    mainDiagnostics: {
      recordLifecycle: (event: string, level = 'info', fields: Record<string, unknown> = {}) => {
        diagnostics.push({ event, level, fields: structuredClone(fields) })
        record('diagnostic', event)
      },
    },
    packagedRouteProbe: undefined, packagedRendererProbe: undefined,
    collectionReadonlyProbe: undefined, collectionScaleProbe: undefined,
  }
  const instantiate = new Function('environment', `
    let { ${Object.keys(environment).join(', ')} } = environment;
    let quitAfterCoreShutdown = false, localWorkbenchShutdownConfirmed = false;
    let localWorkbenchQuitCoordinator;
    const originalRevoke = revokeLocalWorkbenchRootMainAuthor;
    revokeLocalWorkbenchRootMainAuthor = () => { originalRevoke(); localWorkbenchRootMainAuthor = undefined; };
    ${transpiled.outputText}
    return { callback, closeWindow, state: () => ({ quitAfterCoreShutdown, localWorkbenchShutdownConfirmed }),
      clearCurrentResources: () => { localWorkbenchMainAssembly = undefined; localNameMainBridge = undefined; localWorkbenchLegacyIpc = undefined; } };
  `) as (input: typeof environment) => {
    callback(event: QuitEvent): void
    closeWindow(event: QuitEvent): void
    clearCurrentResources(): void
    state(): { quitAfterCoreShutdown: boolean; localWorkbenchShutdownConfirmed: boolean }
  }
  const current = instantiate(environment)
  return {
    invoke() {
      let prevented = false
      current.callback({ preventDefault() { prevented = true; record('quit.prevented') } })
      return prevented
    },
    state: current.state, entries, diagnostics, errors,
    clearCurrentResources: current.clearCurrentResources,
    closeWindow() {
      let prevented = false
      current.closeWindow({ preventDefault() { prevented = true; record('window.prevented') } })
      return prevented
    },
    expireOutboxWait() {
      assert.equal(timers.size, 1, '只能有同一退出尝试的一秒等待界')
      const [id, callback] = [...timers][0]!
      timers.delete(id); callback()
    },
    timerDeadlines, pendingTimers: () => timers.size,
    count: (phase: Phase) => counts.get(phase) ?? 0,
    counters: () => ({ quitCalls, destroyed, revoked }),
  }
}

test('Main原close首次拒绝后，第二次Quit补同原closure且不重发已成功Owner', { timeout: 2_000 }, async () => {
  const originalError = Object.assign(new Error('合成原close拒绝，不是普通App首因'), { code: 'CHANGED' })
  const fixture = await originalQuitFixture({ close_assembly: attempt => { if (attempt === 1) throw originalError } })
  assert.equal(fixture.invoke(), true)
  await tick()
  assert.equal(fixture.count('close_assembly'), 1)
  assert.equal(fixture.errors[0]?.reason, originalError)
  assert.ok(fixture.diagnostics.some(item => item.event === 'local_workbench_shutdown_not_verified'), '必须先观察原关闭拒绝完成')
  assert.deepEqual(fixture.state(), { quitAfterCoreShutdown: true, localWorkbenchShutdownConfirmed: false })
  assert.deepEqual(fixture.counters(), { quitCalls: 0, destroyed: 0, revoked: 1 })
  assert.equal(fixture.closeWindow(), true, '退出未确认时普通关闭只能隐藏，不能销毁Renderer')
  fixture.clearCurrentResources()

  assert.equal(fixture.invoke(), true)
  await tick()
  assert.equal(fixture.count('close_assembly'), 2, '首次关闭已拒绝后，第二次Quit必须补同一原closure，不能永久只preventDefault')
  assert.equal(fixture.count('owner_shutdown'), 1, 'Owner已成功关闭，不得重发Owner关闭或改用新actor')
  assert.equal(fixture.count('close_name'), 1, '已成功的同原Main关闭不能重复派发')
  assert.deepEqual(fixture.state(), { quitAfterCoreShutdown: true, localWorkbenchShutdownConfirmed: true })
  assert.deepEqual(fixture.counters(), { quitCalls: 1, destroyed: 1, revoked: 1 })
  assert.equal(fixture.closeWindow(), false, '全部原关闭确认后才允许真正关闭窗口')
  assert.ok(fixture.diagnostics.some(item => item.event === 'local_workbench_shutdown_failure'
    && item.fields.state === 'close_assembly' && item.fields.code === 'CHANGED'), '补关闭成功仍保留首次原失败诊断')
})

const heldClose = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test('Main原退出补关闭仍单inflight，永久保留的原拒绝不能写成成功', { timeout: 2_000 }, async t => {
  const held = heldClose(), originalError = Object.assign(new Error('合成原关闭失败'), { code: 'CLOSED' })
  t.after(async () => { held.resolve(); await tick() })
  const fixture = await originalQuitFixture({ close_assembly: attempt => {
    if (attempt === 1) throw originalError
    return held.promise
  } })
  fixture.invoke(); await tick()
  fixture.invoke(); await tick()
  assert.equal(fixture.count('close_assembly'), 2)
  fixture.invoke(); fixture.invoke(); await tick()
  assert.equal(fixture.count('close_assembly'), 2, '补关闭尚在途时重复Quit不并发')
  assert.equal(fixture.count('owner_shutdown'), 1)
  assert.equal(fixture.state().localWorkbenchShutdownConfirmed, false)
  held.resolve(); await tick()
  assert.equal(fixture.state().localWorkbenchShutdownConfirmed, true)
  assert.equal(fixture.counters().quitCalls, 1)

  let retained: Promise<never> | undefined
  const failed = await originalQuitFixture({ close_assembly: () => retained ??= Promise.reject(originalError) })
  failed.invoke(); await tick(); failed.invoke(); await tick()
  assert.equal(failed.count('close_assembly'), 2)
  assert.equal(failed.count('owner_shutdown'), 1)
  assert.equal(failed.state().localWorkbenchShutdownConfirmed, false, '同原memo拒绝仍是拒绝，不能清retained或伪造闭口')
  assert.equal(failed.counters().quitCalls, 0)
})

test('Main原outbox一秒界不授quiet，重复Quit只复核同原关闭Promise', { timeout: 2_000 }, async t => {
  const held = heldClose(), fixture = await originalQuitFixture({ close_outbox: () => held.promise }, { fakeTimers: true })
  t.after(async () => { held.resolve(); await tick() })
  fixture.invoke(); await tick()
  assert.equal(fixture.count('close_outbox'), 1)
  fixture.invoke(); await tick()
  assert.equal(fixture.count('close_outbox'), 1)
  assert.equal(fixture.state().localWorkbenchShutdownConfirmed, false)
  fixture.expireOutboxWait(); await tick()
  assert.equal(fixture.state().localWorkbenchShutdownConfirmed, false, '等待界结束不能冒充store已关闭')
  assert.equal(fixture.counters().quitCalls, 0)
  assert.ok(fixture.diagnostics.some(item => item.event === 'local_workbench_shutdown_failure'
    && item.fields.state === 'close_outbox' && item.fields.code === 'TIMEOUT'))
  fixture.invoke(); await tick(); fixture.invoke(); await tick()
  assert.equal(fixture.count('close_outbox'), 1, '超时后仍只等待原close，不重发store.close')
  assert.equal(fixture.count('owner_shutdown'), 1)
  assert.equal(fixture.state().localWorkbenchShutdownConfirmed, false)
  held.resolve(); await tick()
  assert.equal(fixture.state().localWorkbenchShutdownConfirmed, true)
  assert.equal(fixture.counters().quitCalls, 1)
  assert.deepEqual(fixture.timerDeadlines, [1000, 1000], '不扩原一秒等待界')
  assert.equal(fixture.pendingTimers(), 0)
})

test('Main原远程stop返回failed不能确认退出，补原stop仍保首错与后续清理错', { timeout: 2_000 }, async () => {
  const cleanupError = Object.assign(new Error('合成原join清理失败'), { code: 'CHANGED' })
  const fixture = await originalQuitFixture({
    remote_stop: attempt => attempt === 1 ? { mode: 'remote-core-development', status: 'failed' } : { mode: 'local-core', status: 'idle' },
    join_name: attempt => { if (attempt === 1) throw cleanupError },
  })
  fixture.invoke(); await tick()
  assert.equal(fixture.state().localWorkbenchShutdownConfirmed, false)
  assert.equal(fixture.count('owner_shutdown'), 1, '远程关闭失败也继续等待原Owner清理')
  assert.equal(fixture.counters().revoked, 0)
  assert.ok(fixture.diagnostics.some(item => item.event === 'local_workbench_shutdown_failure'
    && item.fields.state === 'remote_stop' && item.fields.code === 'NOT_READY'))
  assert.ok(fixture.diagnostics.some(item => item.event === 'local_workbench_shutdown_cleanup_failure'
    && item.fields.state === 'join_name' && item.fields.code === 'CHANGED'))
  fixture.invoke(); await tick()
  assert.equal(fixture.count('remote_stop'), 2)
  assert.equal(fixture.count('join_name'), 2)
  assert.equal(fixture.count('owner_shutdown'), 1)
  assert.equal(fixture.state().localWorkbenchShutdownConfirmed, true)
  assert.equal(fixture.counters().quitCalls, 1)
})
