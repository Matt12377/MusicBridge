import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { runInThisContext } from 'node:vm'
import ts from 'typescript'
import * as dto from '@music-bridge/contracts'
import { CoreIpcError } from '../src/main/core-supervisor.js'
import { registerLocalAlbumIpc, runLocalAlbumMainRead } from '../src/main/local-library-workbench/album-ipc.js'
import { createLocalWorkbenchMainAssembly, type LocalWorkbenchMainResources, type LocalWorkbenchRootMainAuthor, type LocalWorkbenchRootAuthorBinding } from '../src/main/local-library-workbench/service.js'
import { isLocalAlbumMainRequest, isLocalAlbumMainResponse, type LocalAlbumMainRequest, type LocalAlbumMainResponse } from '../../../packages/bridge-core/src/collection/local-album-browser/main-protocol.js'
import { localAlbumPhase, localAlbumMatch, localAlbumLink, localAlbumRejectCode } from '../../../packages/bridge-core/src/shared/local-album-read-trace-node.js'
import { readLocalAlbumPrivateFailure, localAlbumTraceIdSha256 } from '../src/shared/library-read-trace.js'

// 提取正式index函数并执行正式IPC/assembly；不执行Electron启动、不连接Owner进程或Source。
// VM使用本realm，使闭集validator仍检查真实Object原型，不用跨realm适配器绕过DTO检查。
function installer(state: object): (supervisor: object, assembly: object) => void {
  const text = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const source = ts.createSourceFile('main.ts', text, ts.ScriptTarget.ES2023, true)
  const declaration = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'registerCurrentLocalAlbumIpc')
  assert.ok(declaration, '必须执行正式Main factory，禁止在测试里重写授权管线')
  const compiled = ts.transpileModule(declaration.getText(source), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText
  const prepare = runInThisContext(`(function(state){with(state){${compiled};return registerCurrentLocalAlbumIpc;}})`) as (state: object) => (supervisor: object, assembly: object) => void
  return prepare(state)
}
const datasetId = '11111111-1111-4111-8111-111111111111', rootId = '22222222-2222-4222-8222-222222222222'
const query: dto.LocalAlbumQuery = { query: '', rootId: null, filter: 'all', offset: 0, limit: 60 }
const album: dto.LocalAlbumSummary = { id: 'source:main-scope', kind: 'source-directory', rootId, editionId: null, representativeTrackId: null,
  title: '合成专辑', artists: [], year: null, versionLabel: null, sourceLabel: '合成来源', trackCount: 0, revision: '1', artworkAvailable: false, artworkState: 'unknown', statuses: [] }
const artwork: dto.LocalAlbumArtworkRequest = { albumKey: album.id, rootId, editionId: null, representativeTrackId: null, revision: '1' }
const tracks: dto.LocalAlbumTrackQuery = { albumKey: album.id, rootId, offset: 0, limit: 100 }
const counts = Object.fromEntries([['all', 1], ...dto.LOCAL_ALBUM_STATUSES.map(status => [status, 0])]) as unknown as dto.LocalAlbumFilterCounts
function resultFor(call: LocalAlbumMainRequest): dto.LocalAlbumCommandResults[dto.LocalAlbumCommand] {
  switch (call.request.command) {
    case 'localAlbum.query': return { ...call.request.payload, items: call.request.payload.offset === 0 ? [album] : [], total: 1, hasMore: false, counts }
    case 'localAlbum.tracks': return { ...call.request.payload, album, items: [], total: 0, hasMore: false }
    case 'localAlbum.artwork': return { ...call.request.payload, image: null, status: 'ready' }
  }
}
function response(call: LocalAlbumMainRequest): LocalAlbumMainResponse {
  return { version: 1, type: 'local-album-main-response', id: call.id, datasetId: call.datasetId, command: call.request.command, ok: true, result: resultFor(call) }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const settings: dto.LocalNameSettings = { revision: 'scope-1', backend: 'ollama', ollama: { endpoint: 'http://localhost:11434', model: '' },
  vllm: { endpoint: 'http://localhost:8000', model: '' }, cloud: { endpoint: 'https://example.invalid/v1', model: '', keyConfigured: false } }
async function fixture(t: TestContext) {
  let binding: LocalWorkbenchRootAuthorBinding = { datasetId, ownerEpoch: randomUUID(), childGeneration: 1, authorityRef: {} }
  let fullChecks = 0, closes = 0, readsClosed = 0, trusted = true, quitting = false
  const actions = new AsyncLocalStorage<string>(), ownerChecks: Array<{ binding: Readonly<LocalWorkbenchRootAuthorBinding>; action: string | undefined }> = []
  let verifyHook: ((index: number) => Promise<void>) | undefined
  const author: LocalWorkbenchRootMainAuthor = { get binding() { return binding },
    async assertCurrent() { fullChecks++ },
    async assertReadCurrent(value) { const index = ownerChecks.length; ownerChecks.push({ binding: value, action: actions.getStore() }); await verifyHook?.(index) },
    async request() { throw new Error('只读fixture不得执行mutation') }, async requestOwner() { throw new Error('只读fixture不得调用私有写口') } }
  let current: LocalWorkbenchRootMainAuthor | undefined = author
  // 仅资源生命周期端口合成；capture/冻结/换代/关闭策略全部由实际assembly执行。
  const assembly = createLocalWorkbenchMainAssembly({ currentAuthor: () => current, createResources: () => ({
    service: { async closeReadResources() { readsClosed++ } } as unknown as LocalWorkbenchMainResources['service'],
    names: { read: async () => settings, save: async () => settings, securityPrompt: async () => ({ configured: false, cancelled: true }) },
    async close() { closes++ },
  }) })
  await assembly.activate(author); const originalFull = fullChecks
  t.after(() => assembly.close())
  const capture = assembly.captureLocalAlbumReadAuthor.bind(assembly), pins: Array<ReturnType<typeof capture>> = []
  // 观察真实pin属于哪次IPC；不替代其原assert/Owner核验。若ALS互借，最先在此暴露。
  const observedAssembly = { ...assembly, captureLocalAlbumReadAuthor(dataset: string) {
    const action = actions.getStore(), pin = capture(dataset); pins.push(pin)
    return { binding: pin.binding, assertCurrent() { assert.equal(actions.getStore(), action, '不能借用其他IPC的pin'); pin.assertCurrent() },
      async verifyCurrent() { assert.equal(actions.getStore(), action); await pin.verifyCurrent(); assert.equal(actions.getStore(), action) } }
  } }
  const calls: LocalAlbumMainRequest[] = []
  let body: (call: LocalAlbumMainRequest) => Promise<LocalAlbumMainResponse> = async call => response(call)
  const supervisor = { status: 'ready', async readLocalAlbum(call: LocalAlbumMainRequest) { assert.equal(isLocalAlbumMainRequest(call), true); calls.push(call); return body(call) } }
  let activeSupervisor: object = supervisor, mainAssembly: object = observedAssembly
  const frame = {}, event = { senderFrame: frame }, handlers = new Map<string, (event: { senderFrame: object }, value: unknown) => Promise<unknown>>()
  let trustedChecks = 0, dtoChecks = 0
  installer({ AsyncLocalStorage, registerLocalAlbumIpc, runLocalAlbumMainRead, CoreIpcError, randomUUID, structuredClone, performance,
    localAlbumPhase, localAlbumMatch, localAlbumLink, localAlbumRejectCode, logLibraryOperation() {},
    isLocalAlbumMainResponse(value: unknown, call: LocalAlbumMainRequest) { dtoChecks++; return isLocalAlbumMainResponse(value, call) },
    registerPerformanceHandler(channel: string, handler: (event: { senderFrame: object }, value: unknown) => Promise<unknown>) { assert.equal(channel, 'localAlbum:request'); assert.equal(handlers.has(channel), false); handlers.set(channel, handler) },
    requireTrustedRenderer() { trustedChecks++; if (!trusted) throw new CoreIpcError('NOT_READY', '合成主页面已失效'); return { webContents: { mainFrame: frame } } },
    publicIpcFailure(code: 'NOT_READY', message: string): never { throw new CoreIpcError(code, message) },
    get quitAfterCoreShutdown() { return quitting }, get coreSupervisor() { return activeSupervisor }, get localWorkbenchRootMainAuthor() { return current },
    get localWorkbenchMainAssembly() { return mainAssembly },
  })(supervisor, observedAssembly)
  const handler = handlers.get('localAlbum:request'); assert.ok(handler)
  return { assembly, author, ownerChecks, pins, calls, supervisor, event,
    invoke(value: unknown = { datasetId, command: 'localAlbum.query', payload: query }, received = event, action: string = randomUUID()) { return actions.run(action, () => handler(received, value)) },
    metrics: () => ({ fullChecks, originalFull, closes, readsClosed, trustedChecks, dtoChecks }),
    setVerifyHook(hook: typeof verifyHook) { verifyHook = hook }, setBody(hook: typeof body) { body = hook },
    replaceBinding(patch: Partial<LocalWorkbenchRootAuthorBinding>) { binding = { ...binding, ...patch } },
    mutateBinding(patch: Partial<LocalWorkbenchRootAuthorBinding>) { Object.assign(binding, patch) },
    replaceAuthor() { current = { ...author, binding: { ...binding, ownerEpoch: randomUUID(), childGeneration: binding.childGeneration + 1, authorityRef: {} } } },
    setTrusted(value: boolean) { trusted = value }, setQuitting(value: boolean) { quitting = value }, setSupervisor(value: object) { activeSupervisor = value },
    setAssembly(value: object) { mainAssembly = value },
  }
}

test('Main实际factory：三个IPC各首末核Owner2次，固定读口和真实DTO/主frame核验保留', async t => {
  const f = await fixture(t)
  for (const [command, payload] of [['localAlbum.query', query], ['localAlbum.tracks', tracks], ['localAlbum.artwork', artwork]] as const) {
    const before = f.ownerChecks.length, actual = await f.invoke({ datasetId, command, payload })
    assert.equal(f.ownerChecks.length, before + 2)
    assert.deepEqual(actual, resultFor(f.calls.at(-1)!)); assert.equal(f.calls.at(-1)!.request.command, command)
    assert.equal(f.ownerChecks[before]!.binding, f.ownerChecks[before + 1]!.binding)
    assert.equal(Object.isFrozen(f.ownerChecks[before]!.binding), true)
  }
  assert.equal(f.calls.length, 3); assert.equal(f.metrics().dtoChecks, 3); assert.ok(f.metrics().trustedChecks >= 18)
  assert.equal(f.metrics().fullChecks, f.metrics().originalFull, '本地显示不降级或升级成工作台完整写许可')
})

test('Main实际factory：真实ALS交错两个独立IPC，B先完成后A继续时不能互借pin或跳过首末核验', async t => {
  const f = await fixture(t), entered = deferred<void>(), release = deferred<void>()
  t.after(() => release.resolve())
  f.setVerifyHook(async index => { if (index === 0) { entered.resolve(); await release.promise } })
  const a = f.invoke({ datasetId, command: 'localAlbum.query', payload: { ...query, query: 'A' } }, f.event, 'A')
  await entered.promise
  const b = await f.invoke({ datasetId, command: 'localAlbum.query', payload: { ...query, query: 'B' } }, f.event, 'B') as dto.LocalAlbumPage
  assert.equal(b.query, 'B'); assert.deepEqual(f.ownerChecks.map(value => value.action), ['A', 'B', 'B'])
  release.resolve(); assert.equal((await a as dto.LocalAlbumPage).query, 'A')
  assert.deepEqual(f.ownerChecks.map(value => value.action), ['A', 'B', 'B', 'A'])
  assert.equal(f.ownerChecks[0]!.binding, f.ownerChecks[3]!.binding); assert.equal(f.ownerChecks[1]!.binding, f.ownerChecks[2]!.binding)
  assert.notEqual(f.ownerChecks[0]!.binding, f.ownerChecks[1]!.binding); assert.equal(f.calls.length, 2)
  assert.deepEqual(f.calls.map(value => (value.request.payload as dto.LocalAlbumQuery).query), ['B', 'A'])
})

for (const changed of ['ownerEpoch', 'childGeneration', 'authorityRef'] as const) test(`Main实际factory：await中同dataset换${changed}拒绝迟到成功`, async t => {
  const f = await fixture(t), entered = deferred<void>(), release = deferred<void>()
  t.after(() => release.resolve())
  f.setBody(async call => { entered.resolve(); await release.promise; return response(call) })
  const pending = f.invoke(), rejected = assert.rejects(pending, { code: 'OUTBOX_SCOPE_MISMATCH' })
  await entered.promise
  f.replaceBinding(changed === 'ownerEpoch' ? { ownerEpoch: randomUUID() } : changed === 'childGeneration' ? { childGeneration: 2 } : { authorityRef: {} })
  release.resolve(); await rejected
  assert.equal(f.ownerChecks.length, 1); assert.equal(f.metrics().dtoChecks, 0, '换代在DTO接受之前拒绝')
})

test('Main实际factory：await中readsClosed、Owner引用替换与Supervisor路由替换均拒绝', async t => {
  for (const changed of ['readsClosed', 'author', 'supervisor'] as const) await t.test(changed, async sub => {
    const f = await fixture(sub), entered = deferred<void>(), release = deferred<void>()
    sub.after(() => release.resolve())
    f.setBody(async call => { entered.resolve(); await release.promise; return response(call) })
    const pending = f.invoke(), rejected = assert.rejects(pending, { code: 'OUTBOX_SCOPE_MISMATCH' })
    await entered.promise
    if (changed === 'readsClosed') { await f.assembly.closeReadResources(); assert.equal(f.metrics().readsClosed, 1) }
    else if (changed === 'author') f.replaceAuthor()
    else f.setSupervisor({})
    release.resolve(); await rejected; assert.equal(f.metrics().dtoChecks, 0)
  })
})

test('Main实际factory：首次Owner核验await期间原binding被原地改写，冻结快照拒绝且不派发读口', async t => {
  const f = await fixture(t), entered = deferred<void>(), release = deferred<void>()
  t.after(() => release.resolve())
  f.setVerifyHook(async index => { if (index === 0) { entered.resolve(); await release.promise } })
  const pending = f.invoke(), rejected = assert.rejects(pending, { code: 'OUTBOX_SCOPE_MISMATCH' })
  await entered.promise; f.mutateBinding({ ownerEpoch: randomUUID() }); release.resolve(); await rejected
  assert.equal(f.calls.length, 0); assert.equal(f.ownerChecks.length, 1); assert.equal(Object.isFrozen(f.pins[0]!.binding), true)
})

test('Main实际factory：错dataset、frame、命令及DTO回声逐项拒绝，原读取错误保持', async t => {
  const f = await fixture(t)
  await assert.rejects(f.invoke({ datasetId: randomUUID(), command: 'localAlbum.query', payload: query }), /工作库/u)
  await assert.rejects(f.invoke(undefined, { senderFrame: {} }), /主页面/u)
  await assert.rejects(f.invoke({ datasetId, command: 'localAlbum.apply', payload: query }), /无效/u)
  assert.equal(f.calls.length, 0)
  f.setBody(async call => ({ ...response(call), id: randomUUID() })); await assert.rejects(f.invoke(), { code: 'INVALID_IPC_RESPONSE' })
  f.setBody(async call => ({ ...response(call), datasetId: randomUUID() })); await assert.rejects(f.invoke(), { code: 'INVALID_IPC_RESPONSE' })
  f.setBody(async call => ({ ...response(call), result: { ...resultFor(call), query: '错回声' } } as LocalAlbumMainResponse)); await assert.rejects(f.invoke(), { code: 'INVALID_IPC_RESPONSE' })
  const original = new CoreIpcError('TIMEOUT', '合成原路由超时')
  f.setBody(async () => { throw original }); await assert.rejects(f.invoke(), error => error === original)
  const correlationId = randomUUID(), safe = await f.invoke({ datasetId, command: 'localAlbum.query', payload: query, correlationId })
  const trace = readLocalAlbumPrivateFailure(safe, correlationId, localAlbumTraceIdSha256(correlationId)!)
  assert.ok(trace); assert.equal(trace.trace.code, 'TIMEOUT')
})

test('Main实际factory：末Owner核验错误不能被成功DTO遮住，关闭后新IPC不重用旧scope', async t => {
  const f = await fixture(t), original = new CoreIpcError('TIMEOUT', '合成末Owner核验超时')
  f.setVerifyHook(async index => { if (index === 1) throw original })
  await assert.rejects(f.invoke(), error => error === original)
  assert.equal(f.calls.length, 1); assert.equal(f.metrics().dtoChecks, 1); assert.equal(f.ownerChecks.length, 2)
  await f.assembly.closeReadResources(); await assert.rejects(f.invoke(), { code: 'NOT_READY' })
  assert.equal(f.calls.length, 1); assert.equal(f.ownerChecks.length, 2)
})

test('实际assembly独立Gate：capture与本地assert零Owner调用，verify实核一次，撤销/关闭和旧author回退保守拒绝', async t => {
  const f = await fixture(t), pin = f.assembly.captureLocalAlbumReadAuthor(datasetId)
  assert.equal(Object.isFrozen(pin.binding), true); assert.notEqual(pin.binding, f.author.binding)
  pin.assertCurrent(); pin.assertCurrent(); assert.equal(f.ownerChecks.length, 0)
  await pin.verifyCurrent(); assert.equal(f.ownerChecks.length, 1)
  f.replaceBinding({ childGeneration: 2 }); assert.throws(pin.assertCurrent, { code: 'OUTBOX_SCOPE_MISMATCH' })
  await assert.rejects(pin.verifyCurrent(), { code: 'OUTBOX_SCOPE_MISMATCH' }); assert.equal(f.ownerChecks.length, 1)
  await f.assembly.closeReadResources(); assert.throws(() => f.assembly.captureLocalAlbumReadAuthor(datasetId), { code: 'NOT_READY' })
  const old = await fixture(t)
  delete old.author.assertReadCurrent
  const conservative = old.assembly.captureLocalAlbumReadAuthor(datasetId), before = old.metrics().fullChecks
  await conservative.verifyCurrent(); assert.equal(old.metrics().fullChecks, before + 1); assert.equal(old.ownerChecks.length, 0)
  old.assembly.revoke(); assert.throws(conservative.assertCurrent, { code: 'OUTBOX_SCOPE_MISMATCH' })
})


test('Main实际factory：末次Owner核验await期间主页面失效必须拒绝，仍只核Owner两次', async t => {
  const f = await fixture(t), entered = deferred<void>(), release = deferred<void>()
  t.after(() => release.resolve())
  f.setVerifyHook(async index => { if (index === 1) { entered.resolve(); await release.promise } })
  const pending = f.invoke(), rejected = assert.rejects(pending, { code: 'NOT_READY' })
  await entered.promise; f.setTrusted(false); release.resolve(); await rejected
  assert.equal(f.ownerChecks.length, 2); assert.equal(f.calls.length, 1); assert.equal(f.metrics().dtoChecks, 1)
})
