import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { readFileSync } from 'node:fs'
import { parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import { effectScope, nextTick, ref, shallowRef, watch } from 'vue'
import type * as contracts from '@music-bridge/contracts'
import { useLocalWorkbenchLibrary, type LocalLibraryWorkspaceApi } from '../src/renderer/src/composables/application/local-library-workbench/library.js'
import { useLocalWorkbenchLyrics, type LocalLyricsRendererApi } from '../src/renderer/src/composables/application/local-library-workbench/lyrics.js'

// 执行实际App入口与真实library组合函数；合成API不代表Owner、目录或普通App证据。
const id = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`
const datasetId = id(1), libraryId = id(2)
const target = { albumKey: 'synthetic-album', rootId: libraryId, revision: '原分组修订' }
const nameSettings: contracts.LocalNameSettings = { revision: '1', backend: 'ollama',
  ollama: { endpoint: 'http://127.0.0.1:11434', model: 'synthetic-local' },
  vllm: { endpoint: 'http://127.0.0.1:8000/v1', model: 'synthetic-vllm' },
  cloud: { endpoint: 'https://example.invalid/v1', model: 'synthetic-cloud', keyConfigured: false } }
function gate() {
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const promise = new Promise<void>(resolve => { release = resolve })
  return { entered, promise, enter, release }
}
function appEntryCode(): string {
  const { descriptor } = parse(readFileSync(new URL('../src/renderer/src/App.vue', import.meta.url), 'utf8'))
  const source = ts.createSourceFile('App.vue.ts', descriptor.scriptSetup!.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const functions = ['loadWorkspace', 'captureWorkbenchTargets', 'bindWorkbenchLyrics', 'captureSelectedLyricsLibraries'].map(name => {
    const matches = source.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name)
    assert.equal(matches.length, 1); return matches[0]!.getText(source)
  })
  const declarations = source.statements.filter(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(value => ts.isIdentifier(value.name) && value.name.text === 'workspaceLoading'))
  assert.equal(declarations.length, 1)
  const selectedWatch = source.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'watch' && node.getText(source).includes('captureSelectedLyricsLibraries()'))
  assert.equal(selectedWatch.length, 1, '执行实际整个音乐库页签/选择监听，不复制触发条件')
  const captureWatch = source.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'watch'
    && node.getText(source).includes('workbenchLibrary.capture.value') && node.getText(source).includes('workbenchLyrics.setLibraries'))
  assert.equal(captureWatch.length, 1, '执行实际capture发布监听，旧dataset不能旁路绑定')
  return ts.transpileModule(`${declarations[0]!.getText(source)}\n${functions.join('\n')}\n${selectedWatch[0]!.getText(source)}\n${captureWatch[0]!.getText(source)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
}
const entryCode = appEntryCode()
function fixture(t: TestContext) {
  const calls: { command: string; payload: unknown }[] = [], ports: unknown[] = [], bindings: unknown[] = [], opens: unknown[] = []
  const control = { datasetId, libraries: [libraryId] as string[], libraryFailure: false, nameFailure: false, contextFailure: false,
    foreignAlbum: false, blockOpen: false, nextRead: null as ReturnType<typeof gate> | null,
    nextName: null as ReturnType<typeof gate> | null, nextContext: null as ReturnType<typeof gate> | null }
  const libraryState = (): contracts.LocalLibraryManagementReadback => ({ datasetId: control.datasetId, revision: '1', scanConcurrency: 12,
    libraries: control.libraries.map(libraryId => ({ libraryId, label: '合成原音乐库', role: 'catalog', online: true, watching: false,
      latestSnapshotId: id(3), totalAlbums: 1, totalTracks: 1, scanState: 'complete' })) })
  const albumCapture = (): contracts.LocalWorkbenchReadback => ({ datasetId: control.foreignAlbum ? id(99) : control.datasetId, snapshotId: id(4),
    albums: [{ album: { albumId: target.albumKey, rootId: libraryId, title: '合成原专辑', artist: '合成作者', trackIds: [id(5)] },
      capture: { albumId: target.albumKey, readToken: 'synthetic-owner-capture' }, availability: 'online', issues: [], currentArtwork: null, cueSheets: [] }] })
  const api: LocalLibraryWorkspaceApi = {
    async localLibraryManagement<C extends contracts.LocalLibraryManagementMainCommand>(command: C, payload: contracts.LocalLibraryManagementMainPayloads[C]): Promise<contracts.LocalLibraryManagementMainResults[C]> {
      calls.push({ command, payload: structuredClone(payload) })
      let value: unknown
      if (command === 'library.read') {
        const held = control.nextRead; control.nextRead = null
        if (held) { held.enter(); await held.promise }
        if (control.libraryFailure) throw new Error('合成列表失败 /private-only')
        value = libraryState()
      } else if (command === 'library.album.capture' || command === 'library.albums.capture') value = albumCapture()
      else if (command === 'library.capture') {
        const held = control.nextContext; control.nextContext = null
        if (held) { held.enter(); await held.promise }
        if (control.contextFailure) throw new Error('合成范围失败 /private-only')
        const ids = (payload as contracts.LocalLibraryManagementPayloads['library.capture']).libraryIds
        value = { datasetId: control.datasetId, captureId: id(6), libraryIds: [...ids], revision: '1',
          lyricsLibraries: ids.map(libraryId => ({ datasetId: control.datasetId, libraryId, captureId: id(7) })) }
      } else throw new Error('合成未知原写请求')
      return value as contracts.LocalLibraryManagementMainResults[C]
    },
    async localNameSettings<C extends contracts.LocalNameSettingsCommand>(command: C, payload: contracts.LocalNameSettingsPayloads[C]): Promise<contracts.LocalNameSettingsResults[C]> {
      calls.push({ command, payload: structuredClone(payload) })
      if (command !== 'name.settings.read') throw new Error('合成未知原名称写请求')
      const held = control.nextName; control.nextName = null
      if (held) { held.enter(); await held.promise }
      if (control.nameFailure) throw new Error('合成名称失败 /private-only')
      return structuredClone(nameSettings) as contracts.LocalNameSettingsResults[C]
    },
  }
  const model = useLocalWorkbenchLibrary({ api, makeCommandId: () => id(8) }); t.after(model.dispose)
  const lyricsApi: LocalLyricsRendererApi = {
    async localLibraryLyrics<C extends contracts.LocalLyricsCommand>(command: C, payload: contracts.LocalLyricsCommandPayloads[C]): Promise<contracts.LocalLyricsCommandResults[C]> {
      calls.push({ command, payload: structuredClone(payload) })
      let value: unknown
      if (command === 'localLyrics.query') value = { sessionId: id(10), scope: (payload as contracts.LocalLyricsQueryRequest).scope, state: 'ready', tracks: [], candidates: [] } satisfies contracts.LocalLyricsSession
      else if (command === 'localLyrics.job.start') {
        const original = payload as contracts.LocalLyricsJobStartRequest
        value = { jobId: original.commandId, library: original.library, state: 'complete', totalAlbums: 0, processedAlbums: 0, savedAlbums: 0,
          reviewAlbumIds: [], failedAlbumIds: [], unknownAlbumIds: [], sidecars: 0, embedded: 0, inspectionFailures: 0, revision: 1 } satisfies contracts.LocalLyricsJobSnapshot
      } else throw new Error('此Gate不能隐式读取或保存其他歌词请求')
      return value as contracts.LocalLyricsCommandResults[C]
    },
  }
  const lyrics = useLocalWorkbenchLyrics({ api: lyricsApi, makeCommandId: () => id(11) }); t.after(lyrics.dispose)
  const currentView = ref('coverdrop'), error = ref('原工作台错误'), entryError = ref(''), opening = ref(false)
  const isOpen = ref(false), action = ref('overview'), readback = shallowRef<contracts.LocalWorkbenchReadback | null>(null)
  const focusedAlbum = shallowRef<contracts.LocalWorkbenchAlbumSnapshot | null>(null)
  const environment = {
    window: { musicBridge: { ...api, localWorkbenchCapabilities: async () => { calls.push({ command: 'capabilities', payload: null }); return {} } } },
    workbenchLibrary: model, workbenchPorts: {}, createLocalWorkbenchRendererPorts: () => { ports.push({}); return {} },
    openOriginalMaintenance: () => { throw new Error('不得转派其他维护') }, maintenanceUiGeneration: 0,
    currentView, coverDropViewRef: ref(null), localMaintenanceAvailability: () => false, localMaintenanceOpened: () => false,
    watch, workbench: { isOpen, action, readback, focusedAlbum, error, openLibrary: () => { opens.push('library'); if (!control.blockOpen) { isOpen.value = true; action.value = 'library'; readback.value = null; focusedAlbum.value = null } },
      open: async (request: { action: string }, capture: contracts.LocalWorkbenchReadback) => { opens.push(request); if (!control.blockOpen) { isOpen.value = true; action.value = request.action; readback.value = structuredClone(capture); focusedAlbum.value = readback.value.albums[0] ?? null } } },
    workbenchLyrics: { ...lyrics, bind: (...args: Parameters<typeof lyrics.bind>) => { bindings.push(structuredClone(args)); return lyrics.bind(...args) } },
    workbenchEntryError: entryError, workbenchOpening: opening,
  }
  const body = `const {window,workbenchLibrary,workbenchPorts,createLocalWorkbenchRendererPorts,openOriginalMaintenance,maintenanceUiGeneration,currentView,coverDropViewRef,localMaintenanceAvailability,localMaintenanceOpened,workbench,workbenchLyrics,watch,workbenchEntryError,workbenchOpening}=environment;\n${entryCode}\nreturn {loadWorkspace,captureWorkbenchTargets,captureSelectedLyricsLibraries,bindWorkbenchLyrics,advance:()=>{workbenchOpenGeneration++}};`
  const scope = effectScope(); t.after(() => scope.stop())
  const app = scope.run(() => new Function('environment', body)(environment)) as { loadWorkspace(): Promise<boolean>; captureWorkbenchTargets(intent: unknown): Promise<void>; captureSelectedLyricsLibraries(): Promise<void>; bindWorkbenchLyrics(): void; advance(): void }
  const captures = () => calls.filter(value => value.command === 'library.album.capture' || value.command === 'library.albums.capture')
  const mutations = () => calls.filter(value => !['capabilities', 'library.read', 'name.settings.read', 'library.album.capture', 'library.albums.capture', 'library.capture', 'localLyrics.query', 'localLyrics.inventory'].includes(value.command))
  return { model, lyrics, app, control, calls, ports, bindings, opens, captures, mutations, currentView, entryError, error, opening, isOpen, action, readback }
}

for (const failure of ['libraryFailure', 'nameFailure'] as const) test(`整理本次${failure}失败：保留旧列表与配置，但不进入专辑捕获`, { timeout: 5000 }, async t => {
  const f = fixture(t)
  assert.equal(await f.model.read(), true); assert.equal(await f.model.readNameSettings(), true)
  const before = structuredClone({ state: f.model.state.value, settings: f.model.settings.value })
  f.control[failure] = true
  await f.app.captureWorkbenchTargets({ action: 'overview', albums: [target] })
  assert.deepEqual({ state: f.model.state.value, settings: f.model.settings.value }, before)
  assert.match(f.entryError.value, /^整理入口尚未就绪/u)
  assert.equal(f.ports.length, 0); assert.equal(f.captures().length, 0); assert.equal(f.opens.length, 0); assert.equal(f.bindings.length, 0)
  assert.equal(f.mutations().length, 0); assert.equal(f.opening.value, false)
  assert.equal(f.calls.filter(value => value.command === 'library.read').length, 2)
  assert.equal(f.calls.filter(value => value.command === 'name.settings.read').length, 2)
  f.control[failure] = false
  await f.app.captureWorkbenchTargets({ action: 'overview', albums: [target] })
  assert.equal(f.entryError.value, ''); assert.equal(f.captures().length, 1); assert.equal(f.bindings.length, 1, '仅显式重读成功后继续原捕获')
})

for (const succeeds of [true, false]) test(`整理并发列表读取共享一次真实结算：${succeeds}`, { timeout: 5000 }, async t => {
  const f = fixture(t), held = gate(); f.control.nextRead = held; f.control.libraryFailure = !succeeds
  const first = f.model.read(), joined = f.model.read()
  await held.entered
  assert.equal(f.calls.filter(value => value.command === 'library.read').length, 1)
  held.release()
  assert.deepEqual(await Promise.all([first, joined]), [succeeds, succeeds])
  assert.equal(f.model.busy.value, false)
  assert.equal(f.model.state.value !== null, succeeds)
})

test('整理列表旧generation迟到：原读取和共享者都false，旧显示不被覆盖', { timeout: 5000 }, async t => {
  const f = fixture(t); assert.equal(await f.model.read(), true)
  const before = f.model.state.value, held = gate(); f.control.nextRead = held
  const first = f.model.read(), joined = f.model.read(); await held.entered
  f.model.dispose(); f.control.datasetId = id(99); held.release()
  assert.deepEqual(await Promise.all([first, joined]), [false, false]); assert.equal(f.model.state.value, before)
  assert.equal(await f.model.read(), false); assert.equal(f.calls.filter(value => value.command === 'library.read').length, 2)
})

test('整理名称旧generation迟到：返回false并保留旧配置', { timeout: 5000 }, async t => {
  const f = fixture(t); assert.equal(await f.model.readNameSettings(), true)
  const before = f.model.settings.value, held = gate(); f.control.nextName = held
  const reading = f.model.readNameSettings(); await held.entered; f.model.dispose(); held.release()
  assert.equal(await reading, false); assert.equal(f.model.settings.value, before)
  assert.equal(await f.model.readNameSettings(), false); assert.equal(f.calls.filter(value => value.command === 'name.settings.read').length, 2)
})

test('整理其他流程占busy不是成功读取，不借原列表进入捕获', { timeout: 5000 }, async t => {
  const f = fixture(t); assert.equal(await f.model.read(), true)
  const finish = f.model.beginNativeImport(); assert.ok(finish)
  assert.equal(await f.app.loadWorkspace(), false)
  assert.equal(f.calls.filter(value => value.command === 'library.read').length, 1)
  assert.equal(f.ports.length, 0); assert.equal(f.captures().length, 0); assert.equal(f.mutations().length, 0)
  assert.equal(finish(null), true)
})

test('整理明确整库选择的真实范围返回null不绑定旧库', { timeout: 5000 }, async t => {
  const f = fixture(t); assert.equal(await f.model.read(), true)
  assert.ok(await f.model.captureLibraries([libraryId])); const previous = f.model.capture.value
  f.control.contextFailure = true
  await f.app.captureWorkbenchTargets({ action: 'overview', albums: [] })
  assert.match(f.entryError.value, /^音乐库读取未获确认/u)
  assert.equal(f.model.capture.value, previous, '原捕获显示保留，但不能充作本次确认')
  assert.equal(f.bindings.length, 0); assert.equal(f.mutations().length, 0); assert.equal(f.opening.value, false)
})

test('整理专辑作者改dataset：不打开、不读取后续范围、不绑定', { timeout: 5000 }, async t => {
  const f = fixture(t); f.control.foreignAlbum = true
  await f.app.captureWorkbenchTargets({ action: 'overview', albums: [target] })
  assert.match(f.entryError.value, /^完整专辑捕获未获确认/u)
  assert.equal(f.opens.length, 0); assert.equal(f.bindings.length, 0)
  assert.equal(f.calls.filter(value => value.command === 'library.capture').length, 0)
  assert.equal(f.captures().length, 1); assert.equal(f.mutations().length, 0)
})

test('整理末范围迟到后换页或换操作：不绑定、不覆盖错误、不重发', { timeout: 5000 }, async t => {
  for (const changed of ['page', 'operation'] as const) {
    const f = fixture(t), held = gate(); f.control.nextContext = held
    const reading = f.app.captureWorkbenchTargets({ action: 'overview', albums: [] }); await held.entered
    if (changed === 'page') f.currentView.value = 'home'; else f.app.advance()
    held.release(); await reading
    assert.equal(f.bindings.length, 0); assert.equal(f.entryError.value, ''); assert.equal(f.error.value, '原工作台错误')
    assert.equal(f.captures().length, 0); assert.equal(f.calls.filter(value => value.command === 'library.capture').length, 1)
    assert.equal(f.mutations().length, 0)
  }
})

test('整理末范围dataset已换：旧捕获不得绑定到新工作库', { timeout: 5000 }, async t => {
  const f = fixture(t), held = gate(); f.control.nextContext = held
  const reading = f.app.captureWorkbenchTargets({ action: 'overview', albums: [] }); await held.entered
  f.model.state.value = { ...f.model.state.value!, datasetId: id(99) }; held.release(); await reading
  assert.match(f.entryError.value, /^音乐库读取未获确认/u); assert.equal(f.bindings.length, 0)
  assert.equal(f.captures().length, 0); assert.equal(f.mutations().length, 0)
})

test('整理旧工作台因离开保护未接纳本次捕获：保留旧内容但不能继续绑定', { timeout: 5000 }, async t => {
  const f = fixture(t); f.control.blockOpen = true; f.isOpen.value = true
  const original = { datasetId, snapshotId: '原请求仍在', albums: [] } satisfies contracts.LocalWorkbenchReadback
  f.readback.value = original
  await f.app.captureWorkbenchTargets({ action: 'overview', albums: [target] })
  assert.match(f.entryError.value, /^专辑工作区打开未获确认/u)
  assert.equal(f.readback.value, original); assert.equal(f.bindings.length, 0)
  assert.equal(f.calls.filter(value => value.command === 'library.capture').length, 0); assert.equal(f.mutations().length, 0)
})

for (const original of ['library', 'settings'] as const) test(`整理读取失败保留真实未知原请求：${original}`, { timeout: 5000 }, async t => {
  const f = fixture(t); assert.equal(await f.model.read(), true); assert.equal(await f.model.readNameSettings(), true)
  if (original === 'library') assert.equal(await f.model.rename(libraryId, '合成更名'), false)
  else {
    f.model.editName({ ...f.model.settingsDraft.value!, ollama: { ...f.model.settingsDraft.value!.ollama, model: 'synthetic-pending' } })
    assert.equal(await f.model.saveNameSettings(), false)
  }
  assert.equal(f.model.pending.value, true)
  const before = structuredClone({ originals: f.model.originals.value, operations: f.model.operations.value, originalNameSave: f.model.originalNameSave.value })
  const writes = f.mutations().length; assert.equal(writes, 1)
  f.control.libraryFailure = true
  await f.app.captureWorkbenchTargets({ action: 'overview', albums: [target] })
  assert.deepEqual({ originals: f.model.originals.value, operations: f.model.operations.value, originalNameSave: f.model.originalNameSave.value }, before)
  assert.equal(f.model.pending.value, true); assert.equal(f.mutations().length, writes)
  assert.equal(f.captures().length, 0); assert.equal(f.bindings.length, 0)
})

test('整理真实空库可打开管理页，但不伪造范围或绑定歌词', { timeout: 5000 }, async t => {
  const f = fixture(t); f.control.libraries = []
  await f.app.captureWorkbenchTargets({ action: 'overview', albums: [] })
  assert.equal(f.entryError.value, ''); assert.equal(f.isOpen.value, true)
  assert.deepEqual(f.opens, ['library']); assert.equal(f.bindings.length, 0)
  assert.equal(f.calls.filter(value => value.command === 'library.capture').length, 0); assert.equal(f.mutations().length, 0)
})


test('整理专辑只用原readToken；整个音乐库页签才真实捕库并保批量歌词入口', { timeout: 5000 }, async t => {
  const f = fixture(t)
  // 即使全库捕获当前会拒绝，也不能阻断已完整捕获的单专辑。
  f.control.contextFailure = true
  await f.app.captureWorkbenchTargets({ action: 'overview', albums: [target] })
  assert.equal(f.entryError.value, '')
  assert.equal(f.calls.filter(value => value.command === 'library.capture').length, 0)
  const originalScope = { datasetId, libraryId, albumId: target.albumKey, captureId: 'synthetic-owner-capture' }
  assert.deepEqual(f.lyrics.scope.value, originalScope); assert.equal(f.lyrics.library.value, null)
  assert.deepEqual(f.bindings, [[originalScope, null]])
  await f.lyrics.query()
  assert.deepEqual(f.calls.filter(value => value.command === 'localLyrics.query').map(value => value.payload), [{ scope: originalScope }])
  await f.lyrics.startBatch()
  assert.equal(f.calls.filter(value => value.command === 'localLyrics.job.start').length, 0, 'albumToken不冒充完整库捕获')
  f.control.contextFailure = false
  const held = gate(); f.control.nextContext = held
  let accepted!: () => void
  const libraryAccepted = new Promise<void>(resolve => { accepted = resolve })
  const stop = watch(() => f.lyrics.library.value, value => { if (value) accepted() }, { flush: 'sync' }); t.after(stop)
  f.action.value = 'library'; await held.entered
  assert.equal(f.calls.filter(value => value.command === 'library.capture').length, 1)
  held.release(); await libraryAccepted; await nextTick()
  const library = { datasetId, libraryId, captureId: id(7) }
  assert.deepEqual(f.lyrics.library.value, library); assert.deepEqual(f.lyrics.scope.value, originalScope)
  await f.lyrics.startBatch()
  assert.deepEqual(f.calls.filter(value => value.command === 'localLyrics.job.start').map(value => value.payload), [{ commandId: id(11), library, embed: true }])
})

test('整理尚无专辑和整库捕获时不解引用空上下文或绑定歌词', { timeout: 5000 }, t => {
  const f = fixture(t)
  assert.equal(f.model.capture.value, null); assert.equal(f.readback.value, null)
  assert.doesNotThrow(() => f.app.bindWorkbenchLyrics())
  assert.equal(f.bindings.length, 0); assert.equal(f.lyrics.scope.value, null); assert.equal(f.lyrics.library.value, null)
})

test('整理已有其他dataset的库捕获不能作为本次专辑的可选库上下文', { timeout: 5000 }, async t => {
  const f = fixture(t)
  f.model.capture.value = { datasetId: id(99), captureId: id(6), libraryIds: [libraryId], revision: '1',
    lyricsLibraries: [{ datasetId: id(99), libraryId, captureId: id(7) }] }
  await f.app.captureWorkbenchTargets({ action: 'overview', albums: [target] })
  assert.equal(f.entryError.value, ''); assert.equal(f.lyrics.library.value, null)
  assert.deepEqual(f.lyrics.scope.value, { datasetId, libraryId, albumId: target.albumKey, captureId: 'synthetic-owner-capture' })
  assert.equal(f.calls.filter(value => value.command === 'library.capture').length, 0)
})
