import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import ts from 'typescript'
import { createLocalWorkbenchQuitCoordinator } from '../src/main/local-library-workbench/quit-coordinator.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
const lease = () => ({ workerId: randomUUID(), leaseId: randomUUID(), jobId: randomUUID(), requestId: randomUUID(), inputHash: 'a'.repeat(64), facts: {}, artworkImage: null, templateId: 'jp0-basic-v1' })
async function subject() {
  const module = await import('../src/main/recording-print-worker.js').catch(() => ({}))
  assert.ok('createRecordingPrintWorker' in module, '缺少与界面无关的持久打印任务worker')
  return (module as typeof import('../src/main/recording-print-worker.js')).createRecordingPrintWorker
}
test('worker无需打开UI自动领取并顺序生成，所有私有调用固定库且不并发', async () => {
  const create = await subject(), datasetId = randomUUID(), first = lease()
  const calls: Array<[string, any, string]> = []
  let renders = 0, closed = 0, release!: (v: any) => void
  const result = { pdfBase64: 'synthetic', pdfSha256: 'b'.repeat(64), preview: {}, pageCount: 2, rendererVersion: 'fixture' }
  const worker = create({ datasetId, intervalMs: 60_000, requestInternal: (async (name: string, payload: any, scope: string) => {
    calls.push([name, payload, scope])
    if (name.endsWith('claim')) return { lease: { ...first, workerId: payload.workerId } }
    return { state: 'ready' }
  }) as never, renderer: { render: (async () => { renders++; return new Promise(resolve => { release = resolve }) }) as never, close: () => { closed++ } } })
  worker.start(); worker.start()
  await tick()
  assert.equal(renders, 1); assert.equal(calls.length, 1)
  release(result); await tick(); await tick()
  assert.equal(calls.length, 2)
  assert.equal(calls[1]![0], 'recordingPrintWorker.complete')
  assert.deepEqual(calls[1]![1], { ...result, workerId: calls[0]![1].workerId, leaseId: first.leaseId, jobId: first.jobId, inputHash: first.inputHash })
  assert.ok(calls.every(call => call[2] === datasetId))
  await worker.stop(); assert.equal(closed, 1)
})
test('排版失败只提交有限错误码，停止后迟到渲染不提交任何结果', async () => {
  const create = await subject(), first = lease(), calls: Array<[string, any]> = []
  let reject!: (e: unknown) => void, closed = 0
  const worker = create({ datasetId: randomUUID(), intervalMs: 60_000, requestInternal: (async (name: string, payload: any) => {
    calls.push([name, payload]); return name.endsWith('claim') ? { lease: { ...first, workerId: payload.workerId } } : { state: 'failed' }
  }) as never, renderer: { render: (async () => { throw Object.assign(new Error('/private/internal'), { code: 'LAYOUT_OVERFLOW' }) }) as never, close: () => { closed++ } } })
  worker.start(); await tick(); await tick()
  assert.equal(calls[1]![0], 'recordingPrintWorker.fail')
  assert.equal(calls[1]![1].errorCode, 'LAYOUT_OVERFLOW')
  assert.ok(!JSON.stringify(calls).includes('/private'))
  await worker.stop()
  const lateCalls: string[] = []
  const late = create({ datasetId: randomUUID(), intervalMs: 60_000, requestInternal: (async (name: string, payload: any) => { lateCalls.push(name); return { lease: { ...first, workerId: payload.workerId } } }) as never,
    renderer: { render: (async () => new Promise((_resolve, fail) => { reject = fail })) as never, close: () => { reject(new Error('停止')); closed++ } } })
  late.start(); await tick(); await late.stop(); await tick()
  assert.deepEqual(lateCalls, ['recordingPrintWorker.claim'])
  assert.equal(closed, 2)
})
test('complete回执未知只重试相同payload一次，不重新渲染或修改冻结输入', async () => {
  const create = await subject(), first = lease(), completions: any[] = []
  let renders = 0
  const worker = create({ datasetId: randomUUID(), intervalMs: 60_000, requestInternal: (async (name: string, payload: any) => {
    if (name.endsWith('claim')) return { lease: { ...first, workerId: payload.workerId } }
    if (name.endsWith('complete')) { completions.push(payload); if (completions.length === 1) throw new Error('回执丢失'); return { state: 'ready' } }
    throw new Error('不应失败已完成任务')
  }) as never, renderer: { render: (async () => { renders++; return { pdfBase64: 'exact-original', pdfSha256: 'b'.repeat(64), preview: {}, pageCount: 2, rendererVersion: 'fixture' } }) as never, close: () => undefined } })
  worker.start(); await tick(); await tick(); await worker.stop()
  assert.equal(renders, 1); assert.equal(completions.length, 2); assert.deepEqual(completions[0], completions[1])
})

test('Main在Core就绪时启动打印worker，失效与退出时停止，公开preload接八入口', async () => {
  const { readFile } = await import('node:fs/promises')
  const main = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const preload = await readFile(new URL('../src/preload/index.ts', import.meta.url), 'utf8')
  assert.match(main, /installRecordingPrintHandlers\(/u)
  assert.match(main, /onReady: async client => \{\s*lifecycleProbe\.mark\('core-ready-received'\)\s*await startRecordingPrintWorker\(client\)/u)
  assert.match(main, /onLifecycle: \(event\) => \{\s*if \(event.event === 'spawn'\) lifecycleProbe\.mark\('core-spawn'\)[\s\S]*?if \(event.event !== 'ready'\) stopRecordingPrintWorker\(\)/u)
  const source = ts.createSourceFile('main.ts', main, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const diagnostics = ts.transpileModule(main, { reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).diagnostics ?? []
  assert.equal(diagnostics.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error), false)
  const quitHooks: ts.ArrowFunction[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(source) === 'app' && node.expression.name.text === 'on'
      && node.arguments.length === 2 && ts.isStringLiteral(node.arguments[0]!) && node.arguments[0]!.text === 'before-quit'
      && ts.isArrowFunction(node.arguments[1]!)) quitHooks.push(node.arguments[1]!)
    ts.forEachChild(node, visit)
  }
  visit(source); assert.equal(quitHooks.length, 1)
  const hook = quitHooks[0]!.body; assert.ok(ts.isBlock(hook))
  const initialization = hook.statements.find(statement => ts.isIfStatement(statement)
    && statement.expression.getText(source) === '!localWorkbenchQuitCoordinator')
  assert.ok(initialization && ts.isIfStatement(initialization) && ts.isBlock(initialization.thenStatement), '原退出协调器只能在首次Quit固定关闭者')
  const statements = initialization.thenStatement.statements
  const quitAt = statements.findIndex(statement => ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)
    && statement.expression.left.getText(source) === 'quitAfterCoreShutdown' && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && statement.expression.right.kind === ts.SyntaxKind.TrueKeyword)
  const stopAt = statements.findIndex(statement => ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)
    && statement.expression.expression.getText(source) === 'stopRecordingPrintWorker')
  const coordinatorAt = statements.findIndex(statement => ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)
    && statement.expression.left.getText(source) === 'localWorkbenchQuitCoordinator')
  const asynchronousAt = hook.statements.findIndex(statement => ts.isExpressionStatement(statement) && ts.isVoidExpression(statement.expression))
  assert.ok(quitAt >= 0 && stopAt > quitAt && coordinatorAt > stopAt
    && asynchronousAt > hook.statements.indexOf(initialization), '原退出hook先封新输入和停止打印worker，再登记并发起原协调器关闭')
  for (const statement of statements.slice(quitAt + 1, stopAt)) assert.ok(ts.isExpressionStatement(statement), '停止打印worker前不能提前return或引入分支绕过')
  assert.match(preload, /createRecordingPrintClient\(\(channel, value\) => invokePerformance\(channel, value\)\)/u)
})


const quitShutdownPhases = [
  'prepare_name', 'prepare_lyrics', 'prepare_reads', 'prepare_normalizer', 'owner_shutdown',
  'join_name', 'join_lyrics_grant', 'join_lyrics_provider', 'join_directory', 'join_readers',
  'close_management', 'close_legacy', 'close_assembly', 'close_lyrics_main', 'close_lyrics_provider', 'close_name',
] as const
type QuitShutdownPhase = typeof quitShutdownPhases[number]
const quitSafeCodes = ['NOT_READY', 'OUTBOX_SCOPE_MISMATCH', 'TIMEOUT', 'INVALID_IPC_RESPONSE', 'INTERNAL_ERROR', 'CHANGED', 'CLOSED', 'UNKNOWN'] as const
const quitGate = () => {
  let resolve!: () => void, reject!: (reason: unknown) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

/** 只执行源码唯一退出callback；宿主Promise只证明调度，不替代App/Owner/FD闭口。 */
async function originalBeforeQuitFixture(name: string, controls: Partial<Record<QuitShutdownPhase, () => unknown>> = {}) {
  const fs = await import('node:fs/promises'), path = await import('node:path'), os = await import('node:os')
  const { constants } = await import('node:fs'), { createHash } = await import('node:crypto')
  const text = await fs.readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const source = ts.createSourceFile('index.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const handlers: ts.ArrowFunction[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(source) === 'app' && node.expression.name.text === 'on'
      && node.arguments.length === 2 && ts.isStringLiteral(node.arguments[0]!) && node.arguments[0]!.text === 'before-quit'
      && ts.isArrowFunction(node.arguments[1]!)) handlers.push(node.arguments[1]!)
    ts.forEachChild(node, visit)
  }
  visit(source); assert.equal(handlers.length, 1)
  const original = handlers[0]!.getText(source)
  const transpiled = ts.transpileModule(`const callback = ${original}`, {
    fileName: 'original-before-quit.ts', reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  })
  assert.equal((transpiled.diagnostics ?? []).some(item => item.category === ts.DiagnosticCategory.Error), false)
  const base = await fs.realpath(process.env.MUSIC_BRIDGE_QUIT_PRIVATE_RESULT_ROOT ?? os.tmpdir())
  if (process.platform === 'darwin' && !['true', '1'].includes(process.env.CI ?? '')) {
    assert.ok(base.startsWith('/Volumes/LifeWeave/Developer/CommandLine/'), '本机合成退出原件必须保存在外置LifeWeave')
    const [volume, parent] = await Promise.all([fs.stat('/Volumes/LifeWeave'), fs.stat('/Volumes')])
    assert.notEqual(volume.dev, parent.dev, 'LifeWeave未实际挂载，不能建立同名本机目录')
  }
  await fs.access(base, constants.W_OK)
  const resultRoot = await fs.mkdtemp(path.join(base, 'mb-quit-original-handler-'))
  type Entry = { order: number; kind: string; phase?: string; status?: string }
  type Diagnostic = { event: string; level: string; fields: Record<string, unknown> }
  const entries: Entry[] = [], diagnostics: Diagnostic[] = [], errors: Array<{ phase: QuitShutdownPhase; reason: unknown }> = []
  const waiters = new Set<() => void>()
  const record = (kind: string, phase?: string, status?: string) => {
    entries.push({ order: entries.length + 1, kind, ...(phase ? { phase } : {}), ...(status ? { status } : {}) })
    for (const notify of [...waiters]) notify()
  }
  const waitFor = (predicate: () => boolean): Promise<void> => {
    if (predicate()) return Promise.resolve()
    return new Promise(resolve => { const notify = () => { if (predicate()) { waiters.delete(notify); resolve() } }; waiters.add(notify); notify() })
  }
  const stage = (phase: QuitShutdownPhase): Promise<unknown> => {
    record('begin', phase)
    return Promise.resolve().then(() => controls[phase]?.()).then(value => {
      record('settled', phase, 'fulfilled'); return value
    }, reason => { errors.push({ phase, reason }); record('settled', phase, 'rejected'); throw reason })
  }
  let quitCalls = 0, destroyed = 0, revoked = 0
  const lifecycleProbe = { mark: (phase: string) => record('lifecycle', phase), observe: (promise: Promise<unknown>, done: string, failed: string) => { void promise.then(() => record('lifecycle', done), () => record('lifecycle', failed)) } }
  const environment = {
    createLocalWorkbenchQuitCoordinator,
    CoreIpcError: class extends Error { constructor(readonly code: string, message: string) { super(message) } },
    app: { quit: () => { quitCalls++; record('app.quit') } }, lifecycleProbe,
    coreSupervisor: { shutdown: () => stage('owner_shutdown'), joinPrivateNameProviderBridge: () => stage('join_name'),
      joinPrivateLyricsGrantProducer: () => stage('join_lyrics_grant'), joinPrivateLyricsProviderBridge: () => stage('join_lyrics_provider'),
      joinPrivateWorkbenchDirectoryProducer: () => stage('join_directory'), joinPrivateWorkbenchReadersProducer: () => stage('join_readers') },
    localWorkbenchRootMainAuthor: { binding: Object.freeze({ original: true }) },
    localWorkbenchManagementBoundary: { seal: () => record('management.seal'), close: () => stage('close_management') },
    localWorkbenchLegacyIpc: { sealReads: () => stage('prepare_reads'), close: () => stage('close_legacy') },
    localArtworkImportNormalizer: { close: () => stage('prepare_normalizer') },
    localWorkbenchMainAssembly: { close: () => stage('close_assembly') },
    localLyricsMainService: { close: () => stage('close_lyrics_main') },
    localLyricsProviderBridge: { revokeOwner: () => stage('prepare_lyrics'), close: () => stage('close_lyrics_provider') },
    localNameMainBridge: { sealOwner: () => stage('prepare_name'), close: () => stage('close_name') },
    remoteCoreTunnelManager: { stop: () => Promise.resolve({ mode: 'local-core', status: 'idle' }) }, mobileConnectionSettings: { close: () => Promise.resolve() },
    commandOutbox: { close: () => { record('outbox.close'); return Promise.resolve() } },
    roonDisplayConnection: { stop: () => record('roon.stop') }, closeLocalArtwork: () => record('artwork.seal'),
    closeLocalSourceWrites: () => record('source.seal'), closeLocalRelocation: () => record('relocation.seal'),
    stopRecordingPrintWorker: () => record('print.stop'), destroyTray: () => { destroyed++; record('tray.destroy') },
    revokeLocalWorkbenchRootMainAuthor: () => { revoked++; record('author.revoke') },
    mainDiagnostics: { recordLifecycle: (event: string, level = 'info', fields: Record<string, unknown> = {}) => {
      diagnostics.push({ event, level, fields: structuredClone(fields) }); record('diagnostic', event)
    } },
    packagedRouteProbe: undefined, packagedRendererProbe: undefined, collectionReadonlyProbe: undefined, collectionScaleProbe: undefined,
  }
  const bindingNames = Object.keys(environment)
  const instantiate = new Function('environment', `
    const { ${bindingNames.join(', ')} } = environment;
    let quitAfterCoreShutdown = false, localWorkbenchShutdownConfirmed = false;
    let localWorkbenchQuitCoordinator;
    ${transpiled.outputText}
    return { callback, state: () => ({ quitAfterCoreShutdown, localWorkbenchShutdownConfirmed }) };
  `) as (input: typeof environment) => { callback(event: { preventDefault(): void }): void; state(): { quitAfterCoreShutdown: boolean; localWorkbenchShutdownConfirmed: boolean } }
  const current = instantiate(environment)
  const has = (kind: string, phase: string) => entries.some(item => item.kind === kind && item.phase === phase)
  const invoke = () => { let prevented = false; current.callback({ preventDefault() { prevented = true; record('quit.prevented') } }); return prevented }
  const flush = async () => {
    const reason = (value: unknown) => {
      if (!(value instanceof Error)) return { originalType: typeof value, originalValue: value }
      const code = Object.getOwnPropertyDescriptor(value, 'code')
      return { name: value.name, message: value.message, stack: value.stack ?? null,
        originalCode: code && Object.hasOwn(code, 'value') ? code.value : null, codeAccessorPresent: Boolean(code && !Object.hasOwn(code, 'value')) }
    }
    await fs.writeFile(path.join(resultRoot, 'private-result.json'), JSON.stringify({
      schema: 'MUSIC_BRIDGE_SYNTHETIC_BEFORE_QUIT_OBSERVATION_V1', name,
      sourceSha256: createHash('sha256').update(text).digest('hex'), handlerSha256: createHash('sha256').update(original).digest('hex'),
      fixture: 'CONTROLLED_PROMISE_SCHEDULING_ONLY', ordinaryAppFirstCause: false, qualification: false,
      entries, diagnostics, originalRejectedReasons: errors.map(item => ({ phase: item.phase, reason: reason(item.reason) })),
      state: current.state(), quitCalls, destroyed, revoked,
    }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  }
  return { invoke, state: current.state, entries, diagnostics, errors, has, stage, flush, resultRoot,
    begun: (phase: QuitShutdownPhase) => waitFor(() => has('begin', phase)), settled: (phase: QuitShutdownPhase) => waitFor(() => has('settled', phase)),
    counts: () => ({ quitCalls, destroyed, revoked }) }
}

function assertQuitFailure(fixture: Awaited<ReturnType<typeof originalBeforeQuitFixture>>, phase: QuitShutdownPhase, code: typeof quitSafeCodes[number]) {
  const failures = fixture.diagnostics.filter(item => item.event === 'local_workbench_shutdown_failure')
  assert.ok(failures.length >= 1, '原退出拒绝必须保首个固定phase和安全原code，不能只剩generic错误')
  for (const failure of failures) assert.deepEqual(failure, { event: 'local_workbench_shutdown_failure', level: 'error', fields: { state: phase, code } })
  assert.ok(failures.every(item => quitSafeCodes.includes(item.fields.code as typeof quitSafeCodes[number])))
  assert.ok(!JSON.stringify(fixture.diagnostics).includes('private-quit-original'), 'message或stack不能进入公开退出诊断')
  assert.equal(fixture.state().localWorkbenchShutdownConfirmed, false)
  assert.equal(fixture.counts().quitCalls, 0); assert.equal(fixture.counts().destroyed, 0)
}

const originalQuitError = (code: string) => Object.assign(new Error('private-quit-original: /private/fixture/exit'), { code })

test('Main原before-quit等待同原私有join，重复Quit不重发Owner且全部Main收口后才再次退出', async t => {
  const held = quitGate(), fixture = await originalBeforeQuitFixture('held-original-join', { join_readers: () => held.promise })
  try {
    assert.equal(fixture.invoke(), true)
    await fixture.begun('join_readers'); await tick()
    assert.ok(fixture.has('settled', 'owner_shutdown'))
    assert.equal(fixture.has('begin', 'close_management'), false)
    assert.equal(fixture.state().localWorkbenchShutdownConfirmed, false)
    assert.equal(fixture.counts().quitCalls, 0)
    assert.equal(fixture.invoke(), true)
    assert.equal(fixture.entries.filter(item => item.kind === 'begin' && item.phase === 'owner_shutdown').length, 1)
    assert.equal(fixture.entries.filter(item => item.kind === 'begin' && item.phase === 'prepare_reads').length, 1)
    held.resolve(); await fixture.settled('close_name'); await tick()
    for (const phase of quitShutdownPhases) assert.ok(fixture.has('settled', phase), `原阶段未收口：${phase}`)
    assert.equal(fixture.state().localWorkbenchShutdownConfirmed, true)
    assert.equal(fixture.counts().quitCalls, 1)
    const at = (kind: string, phase?: string) => fixture.entries.findIndex(item => item.kind === kind && (phase === undefined || item.phase === phase))
    assert.ok(at('settled', 'join_readers') < at('begin', 'close_management'))
    assert.ok(at('settled', 'close_name') < at('app.quit'))
    assert.ok(at('outbox.close') < at('app.quit'))
    assert.equal(fixture.diagnostics.some(item => item.event === 'local_workbench_shutdown_failure'), false)
  } finally { held.resolve(); await tick(); await fixture.flush(); t.diagnostic(`合成私有原件：${fixture.resultRoot}`) }
})

test('Main原before-quit准备Owner和joins首拒保闭集原码，同组其余原Promise必须全部settled', async t => {
  const cases: Array<{ name: string; first: QuitShutdownPhase; later: QuitShutdownPhase; held: QuitShutdownPhase; code: typeof quitSafeCodes[number] }> = [
    { name: '准备后位先拒，前位迟拒不能覆盖首因', first: 'prepare_reads', later: 'prepare_name', held: 'prepare_lyrics', code: 'OUTBOX_SCOPE_MISMATCH' },
    { name: 'Owner先拒后仍完整join原Main任务', first: 'owner_shutdown', later: 'join_name', held: 'join_readers', code: 'NOT_READY' },
    { name: 'joins后位先拒，前位迟拒仍保原码', first: 'join_readers', later: 'join_name', held: 'join_directory', code: 'TIMEOUT' },
  ]
  for (const scenario of cases) await t.test(scenario.name, async child => {
    const held = quitGate(), late = quitGate(), firstError = originalQuitError(scenario.code), laterError = originalQuitError('INVALID_IPC_RESPONSE')
    const fixture = await originalBeforeQuitFixture(scenario.name, { [scenario.first]: () => Promise.reject(firstError), [scenario.later]: () => late.promise, [scenario.held]: () => held.promise })
    try {
      assert.equal(fixture.invoke(), true)
      await fixture.settled(scenario.first); await fixture.begun(scenario.held); await tick()
      assert.equal(fixture.errors[0]!.reason, firstError)
      assert.equal(fixture.has('settled', scenario.held), false)
      if (scenario.first.startsWith('prepare_')) assert.equal(fixture.has('begin', 'owner_shutdown'), false)
      assert.equal(fixture.has('begin', 'close_management'), false)
      late.reject(laterError); await fixture.settled(scenario.later); await tick()
      assert.equal(fixture.has('settled', scenario.held), false)
      held.resolve(); await fixture.settled('join_readers'); await tick()
      for (const phase of quitShutdownPhases.slice(0, 10)) assert.ok(fixture.has('settled', phase), `原阶段未settled：${phase}`)
      assert.equal(fixture.errors[0]!.reason, firstError)
      assertQuitFailure(fixture, scenario.first, scenario.code)
      assert.equal(fixture.counts().revoked, 0)
      assert.equal(fixture.has('begin', 'close_management'), false)
      assert.equal(fixture.invoke(), true)
      await tick()
      assert.equal(fixture.entries.filter(item => item.kind === 'begin' && item.phase === scenario.first).length, 2, '失败阶段允许补同原关闭；成功Owner不重复关闭')
      assert.equal(fixture.entries.filter(item => item.kind === 'begin' && item.phase === 'owner_shutdown').length, scenario.first === 'owner_shutdown' ? 2 : 1)
      assert.equal(fixture.state().localWorkbenchShutdownConfirmed, false, '原关闭仍拒绝，不得把重试当作闭口')
    } finally { held.resolve(); late.reject(laterError); await tick(); await fixture.flush(); child.diagnostic(`合成私有原件：${fixture.resultRoot}`) }
  })
})

test('Main原before-quit最终Mainclose拒绝仍join其它原资源，不确认退出且不读Error code getter', async t => {
  const held = quitGate(), originalError = originalQuitError('TIMEOUT'); let codeReads = 0
  Object.defineProperty(originalError, 'code', { configurable: true, get() { codeReads++; throw new Error('private-quit-original: 不允许读取code getter') } })
  const fixture = await originalBeforeQuitFixture('main-close-original-rejection', { close_assembly: () => Promise.reject(originalError), close_name: () => held.promise })
  try {
    assert.equal(fixture.invoke(), true)
    await fixture.settled('close_assembly'); await fixture.begun('close_name'); await tick()
    assert.equal(fixture.has('settled', 'close_name'), false)
    assert.equal(fixture.state().localWorkbenchShutdownConfirmed, false)
    assert.equal(fixture.counts().quitCalls, 0)
    assert.equal(fixture.entries.some(item => item.kind === 'outbox.close'), false)
    held.resolve(); await fixture.settled('close_name'); await tick()
    for (const phase of quitShutdownPhases) assert.ok(fixture.has('settled', phase), `原阶段未settled：${phase}`)
    assert.equal(fixture.errors[0]!.reason, originalError)
    assertQuitFailure(fixture, 'close_assembly', 'INTERNAL_ERROR')
    assert.equal(codeReads, 0)
    assert.equal(fixture.entries.some(item => item.kind === 'outbox.close'), false)
    assert.equal(fixture.invoke(), true)
    await tick()
    assert.equal(fixture.entries.filter(item => item.kind === 'begin' && item.phase === 'close_assembly').length, 2)
    assert.equal(fixture.entries.filter(item => item.kind === 'begin' && item.phase === 'owner_shutdown').length, 1)
    assert.equal(fixture.state().localWorkbenchShutdownConfirmed, false)
    assert.equal(codeReads, 0)
  } finally { held.resolve(); await tick(); await fixture.flush(); t.diagnostic(`合成私有原件：${fixture.resultRoot}`) }
})
