import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { effectScope, nextTick, ref, shallowRef, watch } from 'vue'
import { logLibraryOperation } from '../../../packages/bridge-core/src/shared/library-operation-log.js'
import * as contracts from '@music-bridge/contracts'
import { useLocalWorkbenchLibrary } from '../src/renderer/src/composables/application/local-library-workbench/library.js'
import { useLocalAlbumBrowserPages } from '../src/renderer/src/composables/application/local-library-browser/useLocalAlbumBrowser.js'
import { useLocalLibrary } from '../src/renderer/src/composables/application/useLocalLibrary.js'
import { isCoreRuntimeStable } from '../src/renderer/src/core-readiness.js'
import { localLibraryScanPresentation } from '../src/renderer/src/composables/application/local-library-browser/scan-presentation.js'

// QA执行时提取正式App接线并执行真实Vue组合函数；不以文本存在断言替代行为。
// 这里只覆盖合成API/计时器与model，不冒充DOM、IMG解码、Electron或真实目录扫描。
const id = (value: number) => `22222222-2222-4222-8222-${String(value).padStart(12, '0')}`
const dataset = id(1), rootId = id(2), sourceId = id(3), jobId = id(4)
const root: contracts.LocalRootView = { root: { id: rootId, sourceRootId: sourceId, revision: '1', role: 'library' }, label: '合成新目录', availability: 'ONLINE' }
function job(phase: contracts.ScanJobRecord['phase'] = 'running', overrides: Partial<contracts.ScanJobRecord> = {}): contracts.ScanJobRecord {
  const accepted = phase === 'completed' ? '7' : '0'
  return { schemaVersion: '1.2', jobId, datasetId: dataset, libraryRootId: rootId, sourceRootId: sourceId, rootRevision: '1', jobRevision: phase === 'completed' ? '3' : '2',
    checkpointRef: phase === 'completed' ? id(5) : null, phase, progress: { visited: accepted, accepted, rejected: '0' }, failureCode: null, ...overrides }
}
function deferred() {
  let release!: () => void, enter!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { enter = resolve })
  return { promise, release, entered, enter }
}
function sourceBlock() {
  const source = readFileSync(new URL('../src/renderer/src/App.vue', import.meta.url), 'utf8')
  const bindingStart = source.indexOf('const workbenchLibrary = useLocalWorkbenchLibrary('), bindingEnd = source.indexOf('\nconst { currentTrack } = useLocalPlaybackArtwork(', bindingStart)
  const start = source.indexOf('// 首扫原任务观察开始：'), end = source.indexOf('// 首扫原任务观察结束。', start)
  const queryStart = source.indexOf('async function queryLocalAlbumsWithFlow('), queryEnd = source.indexOf('\nasync function readLocalArtworkWithFlow', queryStart)
  const workspaceStart = source.indexOf('async function loadWorkspace():'), workspaceEnd = source.indexOf('\nasync function captureWorkbenchTargets', workspaceStart)
  const navigationStart = source.indexOf('watch(currentView, (view, previous) => {'), navigationEnd = source.indexOf('\ninstallInitialScanObservationLifecycle()\n', navigationStart)
  const recoveryStart = source.indexOf('// 本地专辑首读恢复事件开始。'), recoveryEnd = source.indexOf('// 本地专辑首读恢复事件结束。', recoveryStart)
  for (const [a,b] of [[bindingStart,bindingEnd],[start,end],[queryStart,queryEnd],[workspaceStart,workspaceEnd],[navigationStart,navigationEnd],[recoveryStart,recoveryEnd]]) assert.ok(a >= 0 && b > a, '执行当前App实际接线，不能退回复制实现')
  const body = `let catalogActionGeneration=0, workspaceLoading=null, workbenchOpenGeneration=0, maintenanceUiGeneration=0, maintenanceUiOpened=null;
    const catalogActionPending=ref(false), workbenchPorts={}, workbenchOpening=ref(false), workbenchEntryError=ref(''), recordingInitialPhysical=ref(), recordingReservationNavigation=ref();
    const localLibraryViewMode=ref('albums'), localLibrarySelectedTrackId=ref(null);
    const createLocalWorkbenchRendererPorts=()=>({}), localMaintenanceAvailability=()=>false, localMaintenanceOpened=()=>{}, invalidateResultInspections=()=>{};
    ${source.slice(bindingStart,bindingEnd)}\n${source.slice(start,end)}\n${source.slice(queryStart,queryEnd)}\n${source.slice(workspaceStart,workspaceEnd)}\n${source.slice(navigationStart,navigationEnd)}
    installInitialScanObservationLifecycle();
    return { workbenchLibrary, localLibraryViewMode, queryLocalAlbumsWithFlow, refreshLocalBrowserViews, refreshLocalLibraryFromWorkbench,
      flush:()=>initialScanWork??Promise.resolve(), observations:()=>[...initialScanObservations.values()], budgets:()=>initialScanDiscoveryBudgets.map(value=>({...value})),
      epoch:()=>initialScanEpoch, timer:()=>initialScanTimer, observeInitialScan:()=>requestInitialScanRefresh(false),
      scanStatus:()=>initialScanStatusError.value, scanJobs:()=>initialScanJobs.value, attemptedRoots:()=>[...initialScanAttemptedRoots],
      deferred:()=>deferInitialAlbumContextReads(), contextFlush:()=>initialAlbumContextWork??Promise.resolve(),
      receiveCoreEvent:(event)=>{${source.slice(recoveryStart,recoveryEnd)}},
      recoveryFlush:()=>Promise.all([localAlbumRecoveryWork??Promise.resolve(),localSettingsReadRecoveryWork??Promise.resolve(),initialScanReadRecoveryWork??Promise.resolve(),initialAlbumContextWork??Promise.resolve()]).then(()=>undefined) };`
  return ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
}

async function fixture(t: TestContext, options: { jobs?: contracts.ScanJobRecord[]; rootPresent?: boolean; phase?: contracts.ScanJobRecord['phase']; total?: number; drainTail?: boolean; initialView?: string; localSession?: ReturnType<typeof useLocalLibrary>; initialReadFailure?: boolean; runtime?: contracts.RuntimeStatus; remoteStatus?: contracts.RemoteCoreTunnelStatus } = {}) {
  const currentView = ref(options.initialView ?? 'home'), scope = effectScope(), mounts: (() => void)[] = [], unmounts: (() => void)[] = []
  const timers = new Map<number, () => void>(), listeners = new Map<string, () => void>(), gates: ReturnType<typeof deferred>[] = []
  const calls: { command: string; payload: any }[] = [], galleryQueries: contracts.LocalAlbumQuery[] = []
  let outboxReads=0, targetReads=0, capabilityReads=0, trackReads=0; let nextTimer = 0, maxTimers = 0, activeGets = 0, maxGets = 0, activeScanPages = 0, maxScanPages = 0, rootsReads = 0, libraryReads = 0, trackRefreshes = 0, invalidations = 0, activeQueries = 0, maxQueries = 0, now = 1_800_000_000_000
  const timerDelays = new Map<number, number>()
  let drainTail: (() => void) | undefined
  const state = { datasetId: dataset, rootPresent: options.rootPresent ?? true, phase: options.phase ?? 'running', total: options.total ?? 0,
    snapshotId: null as string | null, rootRevision: '1', readThrows: options.initialReadFailure ?? false, nextRead: undefined as ReturnType<typeof deferred> | undefined,
    nextGet: undefined as ReturnType<typeof deferred> | undefined, pageTotalsChange: false,
    progress: undefined as contracts.ScanJobRecord['progress'] | undefined, jobRevision: undefined as string | undefined,
    queryFailures: 0, nextQuery: undefined as ReturnType<typeof deferred> | undefined,
    rootsFailures: 0, pageFailures: 0, getFailures: 0, nextPage: undefined as ReturnType<typeof deferred> | undefined,
    availability: 'ONLINE' as contracts.LocalRootView['availability'], extraRoot: null as contracts.LocalRootView | null,
    failureCode: null as contracts.ScanJobRecord['failureCode'] }
  const coreState = ref<{runtime:contracts.RuntimeStatus}>({runtime:options.runtime ?? 'ready'})
  const remoteCoreState = ref<{ status: contracts.RemoteCoreTunnelStatus }>({ status: options.remoteStatus ?? 'idle' })
  let rows = options.jobs ?? [job(state.phase)]
  const readback = (): contracts.LocalLibraryManagementReadback => ({ datasetId: state.datasetId, revision: String(libraryReads), scanConcurrency: 12,
    libraries: state.rootPresent ? [{ libraryId: rootId, label: '合成新目录', role: 'catalog', online: state.availability === 'ONLINE', watching: false, latestSnapshotId: state.snapshotId,
      totalAlbums: state.total, totalTracks: state.total, scanState: state.availability !== 'ONLINE' ? 'offline' : state.phase === 'completed' ? 'complete' : state.phase === 'pending' ? 'queued' : state.phase }] : [] })
  let importCommand: string | null = null
  const api = {
    async queryLocalLibraryTracks(request:contracts.LocalLibraryQuery) { trackReads++; return {...request,items:[],total:0,hasMore:false} },
    async getLocalLibraryPlaybackTarget() { targetReads++; return null },
    async getCommandOutbox() { outboxReads++; return {datasetId:dataset,entries:[]} },
    async localWorkbenchCapabilities() { capabilityReads++; return {} },
    async listLocalLibraryRoots() {
      rootsReads++; if (state.rootsFailures > 0) { state.rootsFailures--; throw new Error('合成目录读取TIMEOUT') }
      return state.rootPresent ? [{ ...root, availability: state.availability, root: { ...root.root, revision: state.rootRevision } }, ...(state.extraRoot ? [state.extraRoot] : [])] : []
    },
    async localLibraryManagement(command: string, payload: any) {
      calls.push({ command, payload: structuredClone(payload) })
      if (command === 'library.read') {
        libraryReads++
        const frozen = structuredClone(readback()), held = state.nextRead; state.nextRead = undefined
        if (held) { held.enter(); await held.promise }
        if (state.readThrows) throw new Error('合成库读取失败')
        return frozen
      }
      if (command === 'library.import.prepare') return { choiceId: id(7), label: '合成新目录', suggestedRole: 'catalog', evidence: ['合成目录角色证据'] }
      if (command === 'library.import.confirm') {
        importCommand = payload.commandId; state.rootPresent = true; state.phase = 'running'; rows = [job()]
        return { commandId: payload.commandId, kind: command, state: 'succeeded', libraryIds: [rootId], message: null }
      }
      throw new Error('禁止未声明的库命令：' + command)
    },
    async localNameSettings(command:string) { assert.equal(command,'name.settings.read'); return {revision:'1',backend:'ollama',ollama:{endpoint:'http://127.0.0.1:11434',model:'合成'},vllm:{endpoint:'http://127.0.0.1:8000/v1',model:'合成'},cloud:{endpoint:'https://example.invalid/v1',model:'合成',keyConfigured:false}} },
    async localLibraryScan(command: string, payload: any) {
      calls.push({ command, payload: structuredClone(payload) })
      if (command === 'localScan.page') {
        const failed = state.pageFailures > 0, held = state.nextPage; state.nextPage = undefined
        if (failed) state.pageFailures--
        activeScanPages++; maxScanPages = Math.max(maxScanPages, activeScanPages)
        try {
          if (held) { held.enter(); await held.promise }
          if (failed) throw new Error('合成扫描分页TIMEOUT')
          const total = rows.length + (state.pageTotalsChange ? calls.filter(value => value.command === command).length : 0)
          const padded = [...rows, ...Array.from({ length: total - rows.length }, (_, index) => job('completed', { jobId: id(50000 + index), libraryRootId: id(99) }))]
          return { ...payload, total, items: padded.slice(payload.offset, payload.offset + payload.limit), hasMore: payload.offset + payload.limit < total }
        } finally { activeScanPages-- }
      }
      if (command === 'localScan.receipt') return payload.commandId === importCommand ? { commandId: importCommand, jobId, operation: 'start', fingerprint: 'a'.repeat(64), result: job('pending', { jobRevision: '1' }) } : null
      if (command === 'localScan.get') {
        if (payload.jobId !== jobId) {
          const selected = rows.find(row => row.jobId === payload.jobId)
          assert.ok(state.extraRoot && selected && selected.libraryRootId === state.extraRoot.root.id, '仅允许原真实发现匹配的额外合成root')
          return structuredClone(selected)
        }
        assert.equal(payload.jobId, jobId, '只查询匹配本次目录/来源/修订的原job')
        activeGets++; maxGets = Math.max(maxGets, activeGets)
        const frozen = job(state.phase, { ...(state.progress ? { progress: state.progress } : {}), ...(state.jobRevision ? { jobRevision: state.jobRevision } : {}), ...(state.failureCode ? { failureCode: state.failureCode } : {}) }), held = state.nextGet; state.nextGet = undefined
        try { if (held) { held.enter(); await held.promise }; if (state.getFailures > 0) { state.getFailures--; throw new Error('合成原任务读取TIMEOUT') }; return frozen } finally { activeGets-- }
      }
      throw new Error('禁止新增扫描、恢复或批处理：' + command)
    },
  }
  const rawModelApi: contracts.LocalAlbumReadPort = {
    async queryAlbums(request) {
      galleryQueries.push(structuredClone(request))
      assert.equal(isCoreRuntimeStable(coreState.value.runtime,remoteCoreState.value.status),true,'未实际就绪不得发送专辑IPC')
      const held = state.nextQuery, failed = state.queryFailures > 0; state.nextQuery = undefined
      if (failed) state.queryFailures--
      activeQueries++; maxQueries = Math.max(maxQueries, activeQueries)
      try {
      const items: contracts.LocalAlbumSummary[] = Array.from({ length: state.total }, (_, index) => ({ id: `first-scan-album-${index}`, kind: 'source-directory', rootId,
        editionId: null, title: '合成扫描专辑 ' + index, artists: ['合成作者'], year: null, versionLabel: null, trackCount: 1, representativeTrackId: id(100 + index),
        revision: String(state.total + 1), artworkAvailable: false, artworkState: 'missing', statuses: ['missing-artwork'] }))
      const counts = Object.fromEntries(['all', ...contracts.LOCAL_ALBUM_STATUSES].map(filter => [filter, filter === 'all' || filter === 'missing-artwork' ? state.total : 0])) as contracts.LocalAlbumFilterCounts
      const reply = { ...request, items: items.slice(request.offset, request.offset + request.limit), total: items.length, hasMore: request.offset + request.limit < items.length, counts }
      if (held) { held.enter(); await held.promise }
      if (failed) throw new Error('合成Core切换中的NOT_READY')
      return reply
      } finally { activeQueries-- }
    },
    async queryAlbumTracks() { throw new Error('本例不打开详情') }, async getArtwork() { throw new Error('本例不冒充实际IMG解码') },
  }
  const localLibrary = options.localSession ?? useLocalLibrary({api:api as unknown as contracts.LocalLibraryPublicApi,getSelectedZone:()=>undefined,play:async()=>{throw new Error('纯读Gate禁止点播')}}), workbenchLyrics = { pending: ref(false) }
  const storage = new Map<string, string>()
  const window = { musicBridge: {...api,queryLocalAlbums:rawModelApi.queryAlbums}, localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value) } },
    addEventListener: (name: string, callback: () => void) => { listeners.set(name, callback) }, removeEventListener: (name: string) => { listeners.delete(name) } }
  const setTimeout = (callback: () => void, delay: number) => { assert.ok(delay > 0 && delay <= 15_000); const timer = ++nextTimer; timers.set(timer, callback); timerDelays.set(timer, delay); maxTimers = Math.max(maxTimers, timers.size); return timer }
  const clearTimeout = (timer: number | undefined) => { if (timer !== undefined) { timers.delete(timer); timerDelays.delete(timer) } }
  let pages!: ReturnType<typeof useLocalAlbumBrowserPages>, host: any
  scope.run(() => {
    pages = useLocalAlbumBrowserPages({ api: {...rawModelApi,queryAlbums:request=>host.queryLocalAlbumsWithFlow(request)} })
    const wrap = (page: typeof pages.localLibrary) => ({ ...page, invalidateArtwork: async () => { invalidations++; await page.invalidateArtwork() } })
    const parameters = ['window', 'watch', 'onMounted', 'onUnmounted', 'currentView', 'localWorkbenchDto', 'useLocalWorkbenchLibrary', 'localLibrary', 'workbenchLyrics', 'albumBrowser', 'coverDropBrowser', 'setTimeout', 'clearTimeout', 'shallowRef', 'ref', 'logLibraryOperation', 'remoteCoreState', 'isCoreRuntimeStable', 'Date', 'readLocalAlbumWithSafeTrace', 'coreState']
    // 仅隔离VM拦截原生finally入口，在真实尾微任务中投递请求；不改App区段或替代drain。
    const factory = options.drainTail ? runInNewContext(`(() => {
      const originalFinally = Promise.prototype.finally;
      Promise.prototype.finally = function(callback) { return originalFinally.call(this, () => { beforeDrainFinally(); return callback(); }); };
      return function(${parameters.join(',')}) { ${sourceBlock()} };
    })()`, { beforeDrainFinally: () => drainTail?.() }) : new Function(...parameters, sourceBlock())
    host = factory(
      window, watch, (callback: () => void) => mounts.push(callback), (callback: () => void) => unmounts.push(callback), currentView, contracts, useLocalWorkbenchLibrary,
      localLibrary, workbenchLyrics, wrap(pages.localLibrary), wrap(pages.coverDrop), setTimeout, clearTimeout, shallowRef, ref, logLibraryOperation, remoteCoreState, isCoreRuntimeStable, { now: () => now }, async(action:()=>Promise<unknown>)=>action(), coreState)
  })
  let destroyed = false
  const destroy = () => { if (destroyed) return; destroyed = true; for (const callback of unmounts) callback(); host.workbenchLibrary.dispose(); localLibrary.dispose(); scope.stop() }
  const drain = async () => { for (let pass = 0; pass < 3; pass++) { await nextTick(); await host.flush(); await host.recoveryFlush() } }
  t.after(async () => {
    const failures: unknown[] = []
    for (const gate of gates) gate.release()
    try { destroy() } catch (error) { failures.push(error) }
    try { await drain() } catch (error) { failures.push(error) }
    try { assert.equal(timers.size, 0, '卸载后实际合成timer清零') } catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, '合成首扫夹具未完整收口', { cause: failures[0] })
  })
  for (const callback of mounts) callback()
  const enter = async (view = 'local-library') => { currentView.value = view; if (view === 'local-library') await pages.localLibrary.activate(); else if (view === 'coverdrop') await pages.coverDrop.activate(); await drain() }
  const tick = async () => { assert.equal(timers.size, 1, '只允许一个待执行观察timer'); const [key, callback] = [...timers][0]!; now += timerDelays.get(key)!; timers.delete(key); timerDelays.delete(key); callback(); await drain() }
  const hold = (kind: 'nextRead' | 'nextGet' | 'nextQuery' | 'nextPage') => { const gate = deferred(); gates.push(gate); state[kind] = gate; return gate }
  const noWrites = () => assert.equal(calls.some(value => ['localScan.start', 'localScan.resume', 'localScan.prepareBatch', 'localScan.commitBatch', 'library.snapshot.retry', 'library.snapshot.load'].includes(value.command)), false)
  return { host, pages, localLibrary, state, currentView, calls, galleryQueries, timers, listeners, drain, enter, tick, hold, destroy, noWrites, now: () => now,
    counters: () => ({ maxTimers, maxGets, maxScanPages, rootsReads, libraryReads, trackRefreshes, invalidations, maxQueries, outboxReads, targetReads, capabilityReads, trackReads }), setRows: (value: contracts.ScanJobRecord[]) => { rows = value },
    coreEvent: (event: 'core.ready' | 'core.health', runtime: contracts.RuntimeStatus = 'ready') => { coreState.value={runtime}; host.receiveCoreEvent({ event, payload: { state: { runtime } } }) }, coreState, remoteCoreState,
    onDrainTail: (callback: () => void) => { drainTail = callback } }
}

function contextCalls(f:Awaited<ReturnType<typeof fixture>>) {
  const c=f.counters();return {roots:c.rootsReads,library:c.libraryReads,outbox:c.outboxReads,target:c.targetReads,capabilities:c.capabilityReads,scan:f.calls.filter(call=>call.command.startsWith('localScan.')).length}
}

test('FIRST_ALBUM_CONTEXT_GATE 首次真实页接受前零自动目录/工作台/扫描/Outbox读取，页成功无需health即可补齐',async t=>{
  const f=await fixture(t,{total:7}),hold=f.hold('nextQuery'),entering=f.enter();await hold.entered
  assert.equal(f.host.deferred(),true)
  assert.deepEqual(contextCalls(f),{roots:0,library:0,outbox:0,target:0,capabilities:0,scan:0})
  await f.host.observeInitialScan();await f.drain()
  assert.deepEqual(contextCalls(f),{roots:0,library:0,outbox:0,target:0,capabilities:0,scan:0})
  hold.release();await entering;await f.drain()
  assert.equal(f.pages.localLibrary.snapshot.value.loaded,true);assert.equal(f.host.deferred(),false)
  assert.equal(f.localLibrary.rootsLoaded.value,true);assert.equal(f.localLibrary.rootsError.value,'')
  assert.ok(f.counters().rootsReads>0&&f.counters().libraryReads>0&&f.counters().outboxReads>0)
  assert.ok(f.calls.some(call=>call.command==='localScan.page'));f.noWrites()
})

test('FIRST_ALBUM_CONTEXT_GATE 空专辑页也是成功证据，根状态仍由随后真实目录读取决定',async t=>{
  const f=await fixture(t,{total:0,rootPresent:true});await f.enter()
  assert.equal(f.pages.localLibrary.snapshot.value.status,'empty');assert.equal(f.host.deferred(),false)
  assert.equal(f.localLibrary.rootsLoaded.value,true);assert.equal(f.localLibrary.roots.value[0]?.root.id,rootId)
  f.noWrites()
})

test('FIRST_ALBUM_CONTEXT_GATE 首页真实失败保留可见错误、不预读根；显式成功重读后再补目录',async t=>{
  const f=await fixture(t,{total:7});f.state.queryFailures=1;await f.enter()
  assert.equal(f.pages.localLibrary.snapshot.value.status,'error');assert.ok(f.pages.localLibrary.snapshot.value.error)
  assert.equal(f.host.deferred(),true);assert.deepEqual(contextCalls(f),{roots:0,library:0,outbox:0,target:0,capabilities:0,scan:0})
  await f.pages.localLibrary.refresh();await f.drain()
  assert.equal(f.pages.localLibrary.snapshot.value.loaded,true);assert.equal(f.host.deferred(),false)
  assert.equal(f.localLibrary.rootsError.value,'');f.noWrites()
})

test('FIRST_ALBUM_CONTEXT_GATE 旧页离开后迟到不读取根，返回的新页真实完成才放行',async t=>{
  const f=await fixture(t,{total:7}),hold=f.hold('nextQuery'),oldEntry=f.enter();await hold.entered
  f.currentView.value='home';await nextTick();hold.release();await oldEntry;await f.drain()
  assert.equal(f.pages.localLibrary.snapshot.value.loaded,false)
  assert.deepEqual(contextCalls(f),{roots:0,library:0,outbox:0,target:0,capabilities:0,scan:0})
  await f.enter();assert.equal(f.host.deferred(),false);assert.equal(f.localLibrary.rootsLoaded.value,true);f.noWrites()
})

test('FIRST_ALBUM_CONTEXT_GATE 旧Core在途页不能放行新Core；新代首次真实页接收后才补读',async t=>{
  const f=await fixture(t,{total:7}),oldHold=f.hold('nextQuery'),oldEntry=f.enter();await oldHold.entered
  f.coreEvent('core.health','starting');await nextTick()
  oldHold.release();await f.drain()
  assert.equal(f.pages.localLibrary.snapshot.value.initialLoading,true);assert.equal(f.pages.localLibrary.snapshot.value.error,'')
  assert.equal(f.host.deferred(),true);assert.deepEqual(contextCalls(f),{roots:0,library:0,outbox:0,target:0,capabilities:0,scan:0})
  f.coreEvent('core.ready');await oldEntry;await f.drain()
  assert.equal(f.host.deferred(),false);assert.ok(f.counters().rootsReads>0);f.noWrites()
})

test('FIRST_ALBUM_CONTEXT_GATE cached loaded遇新Core只做一次真实页复核，普通health不循环重建/重读',async t=>{
  const f=await fixture(t,{total:7});await f.enter();assert.equal(f.galleryQueries.length,1)
  f.coreEvent('core.ready');await f.drain()
  assert.equal(f.galleryQueries.length,2);assert.equal(f.host.deferred(),false)
  const before=contextCalls(f);f.coreEvent('core.health');f.coreEvent('core.health');await f.drain()
  assert.equal(f.galleryQueries.length,2);assert.deepEqual(contextCalls(f),before);f.noWrites()
})

test('FIRST_ALBUM_CONTEXT_GATE 已有真实rootsError在等待期间保留，仅成功真实补读清除',async t=>{
  const f=await fixture(t,{total:7});await f.localLibrary.activate({deferTrackReads:true})
  f.state.rootsFailures=1;await f.localLibrary.refreshContext();const prior=f.localLibrary.rootsError.value;assert.ok(prior)
  const before=contextCalls(f),hold=f.hold('nextQuery'),entering=f.enter();await hold.entered
  assert.equal(f.localLibrary.rootsError.value,prior);assert.deepEqual(contextCalls(f),before)
  hold.release();await entering;await f.drain()
  assert.equal(f.localLibrary.rootsError.value,'');assert.ok(f.counters().rootsReads>before.roots);f.noWrites()
})

test('FIRST_ALBUM_CONTEXT_GATE 补读真实目录失败仍显示错误，响应watch不造成无限自动重试',async t=>{
  const f=await fixture(t,{total:7});f.state.rootsFailures=100;await f.enter()
  assert.ok(f.localLibrary.rootsError.value);assert.equal(f.host.deferred(),false)
  const reads=f.counters().rootsReads;for(let i=0;i<5;i++)await nextTick();await f.drain()
  assert.equal(f.counters().rootsReads,reads)
  f.state.rootsFailures=0;await f.localLibrary.refreshContext();assert.equal(f.localLibrary.rootsError.value,'');f.noWrites()
})

test('FIRST_ALBUM_CONTEXT_GATE pending写入期间页完成也不启动自动纯读，解除后真实补读且零mutation',async t=>{
  const f=await fixture(t,{total:7}),hold=f.hold('nextQuery'),entering=f.enter();await hold.entered
  f.host.workbenchLibrary.writing.value=true;hold.release();await entering;await f.drain()
  assert.equal(f.pages.localLibrary.snapshot.value.loaded,true);assert.equal(f.host.deferred(),true)
  assert.deepEqual(contextCalls(f),{roots:0,library:0,outbox:0,target:0,capabilities:0,scan:0})
  f.host.workbenchLibrary.writing.value=false;await f.drain()
  assert.equal(f.host.deferred(),false);assert.equal(f.localLibrary.rootsLoaded.value,true)
  assert.ok(f.calls.every(call=>call.command==='library.read'||['localScan.page','localScan.get','localScan.receipt'].includes(call.command)));f.noWrites()
})

test('FIRST_ALBUM_CONTEXT_GATE 真实曲目模式保留即时目录/目标/Outbox/曲目读取，不依赖隐藏专辑页',async t=>{
  const f=await fixture(t,{total:7});f.host.localLibraryViewMode.value='tracks';await f.enter()
  assert.equal(f.host.deferred(),false);assert.ok(f.counters().rootsReads>0&&f.counters().outboxReads>0&&f.counters().targetReads>0&&f.counters().trackReads>0)
  f.noWrites()
})


test('FIRST_ALBUM_CONTEXT_GATE 非预期纯读拒绝真实传播，finally不自重入；显式新页才再次补读',async t=>{
  const f=await fixture(t,{total:7}),entered=deferred(),original=f.localLibrary.activate.bind(f.localLibrary)
  let attempts=0,rejectActivation!:(error:Error)=>void
  const held=new Promise<void>((_resolve,reject)=>{rejectActivation=reject})
  t.mock.method(f.localLibrary,'activate',(options:Parameters<typeof original>[0]={})=>{
    if(options.deferContextReads)return original(options)
    attempts++;entered.enter()
    return attempts===1?held:original(options)
  })
  const entering=f.enter();await entered.entered
  const rejectedRead=assert.rejects(f.host.contextFlush(),/合成异常纯读拒绝/u)
  rejectActivation(new Error('合成异常纯读拒绝'))
  await rejectedRead;await entering;for(let i=0;i<5;i++)await nextTick();await f.drain()
  assert.equal(attempts,1,'异常finally不得自动发第二轮纯读')
  assert.equal(f.host.deferred(),true,'异常不能冒充已补齐上下文')
  assert.deepEqual(contextCalls(f),{roots:0,library:0,outbox:0,target:0,capabilities:0,scan:0})
  await f.pages.localLibrary.refresh();await f.drain()
  assert.equal(attempts,2);assert.equal(f.host.deferred(),false);assert.equal(f.localLibrary.rootsLoaded.value,true);f.noWrites()
})

// 原App查询wrapper、真实Vue watch和原model Promise：实际未就绪时零IPC，不能用吞错误冒充等待。
test('ALBUM_RUNTIME_ADMISSION 冷Core starting首入保持原loading且零IPC/错误，ready后仅派一次真实首页',async t=>{
  const f=await fixture(t,{total:7,runtime:'starting'}),entering=f.enter()
  await f.drain()
  assert.equal(f.pages.localLibrary.snapshot.value.active,true)
  assert.equal(f.pages.localLibrary.snapshot.value.initialLoading,true);assert.equal(f.pages.localLibrary.snapshot.value.status,'loading')
  assert.equal(f.pages.localLibrary.snapshot.value.error,'');assert.equal(f.pages.localLibrary.snapshot.value.loaded,false)
  assert.equal(f.galleryQueries.length,0);assert.deepEqual(contextCalls(f),{roots:0,library:0,outbox:0,target:0,capabilities:0,scan:0})
  f.coreEvent('core.health','starting');f.coreEvent('core.health','starting');await f.drain()
  assert.equal(f.galleryQueries.length,0);assert.equal(f.pages.localLibrary.snapshot.value.error,'')
  f.coreEvent('core.ready');await entering;await f.drain()
  assert.equal(f.galleryQueries.length,1);assert.equal(f.pages.localLibrary.snapshot.value.loaded,true)
  assert.equal(f.pages.localLibrary.snapshot.value.error,'');assert.equal(f.host.deferred(),false)
  f.coreEvent('core.health');f.coreEvent('core.health');await f.drain();assert.equal(f.galleryQueries.length,1);f.noWrites()
})

test('ALBUM_RUNTIME_ADMISSION runtime ready但remote切换仍零IPC，真实隧道稳定后才放行',async t=>{
  const f=await fixture(t,{total:7,runtime:'ready',remoteStatus:'reconnecting'}),entering=f.enter();await f.drain()
  assert.equal(f.galleryQueries.length,0);assert.equal(f.pages.localLibrary.snapshot.value.initialLoading,true)
  f.coreEvent('core.health');await f.drain();assert.equal(f.galleryQueries.length,0)
  f.remoteCoreState.value={status:'starting'};await f.drain();assert.equal(f.galleryQueries.length,0)
  f.remoteCoreState.value={status:'ready'};await entering;await f.drain()
  assert.equal(f.galleryQueries.length,1);assert.equal(f.pages.localLibrary.snapshot.value.error,'')
  assert.equal(f.pages.localLibrary.snapshot.value.loaded,true);f.noWrites()
})

test('ALBUM_RUNTIME_ADMISSION 等待时离页原Promise实际settle，迟到ready不派读、不覆盖错误；新entry只读一次',async t=>{
  const f=await fixture(t,{total:7,runtime:'starting'}),entering=f.enter();await f.drain()
  f.currentView.value='home';await nextTick();await entering;await f.drain()
  assert.equal(f.pages.localLibrary.snapshot.value.active,false);assert.equal(f.pages.localLibrary.snapshot.value.error,'')
  f.coreEvent('core.ready');await f.drain();assert.equal(f.galleryQueries.length,0)
  await f.enter();assert.equal(f.galleryQueries.length,1);assert.equal(f.pages.localLibrary.snapshot.value.loaded,true);f.noWrites()
})

test('ALBUM_RUNTIME_ADMISSION pagehide先撤销原model再收口等待，关闭后ready不能派发或写error',async t=>{
  const f=await fixture(t,{total:7,runtime:'starting'}),entering=f.enter();await f.drain()
  assert.ok(f.listeners.has('pagehide'));f.listeners.get('pagehide')!();await entering;await f.drain()
  assert.equal(f.pages.localLibrary.snapshot.value.active,false);assert.equal(f.pages.localLibrary.snapshot.value.error,'')
  f.coreEvent('core.ready');await f.drain();assert.equal(f.galleryQueries.length,0);f.noWrites()
})

for(const oldOutcome of ['成功旧页','旧代NOT_READY'] as const)test(`ALBUM_RUNTIME_ADMISSION ${oldOutcome}不能覆盖新Core，原loading持续到当前代真实成功`,async t=>{
  const f=await fixture(t,{total:7}),hold=f.hold('nextQuery')
  if(oldOutcome==='旧代NOT_READY')f.state.queryFailures=1
  const entering=f.enter();await hold.entered;assert.equal(f.galleryQueries.length,1)
  f.coreEvent('core.health','starting');f.state.total=11;hold.release();await f.drain()
  assert.equal(f.pages.localLibrary.snapshot.value.loaded,false);assert.equal(f.pages.localLibrary.snapshot.value.initialLoading,true)
  assert.equal(f.pages.localLibrary.snapshot.value.error,'');assert.equal(f.galleryQueries.length,1)
  f.coreEvent('core.ready');await entering;await f.drain()
  assert.equal(f.galleryQueries.length,2);assert.equal(f.counters().maxQueries,1)
  assert.equal(f.pages.localLibrary.snapshot.value.total,11);assert.equal(f.pages.localLibrary.snapshot.value.error,'');f.noWrites()
})

test('ALBUM_RUNTIME_ADMISSION ready同代的真实失败仍显示且仅一次，不靠watch无限重发',async t=>{
  const f=await fixture(t,{total:7});f.state.queryFailures=1;await f.enter()
  assert.equal(f.galleryQueries.length,1);assert.equal(f.pages.localLibrary.snapshot.value.status,'error')
  assert.ok(f.pages.localLibrary.snapshot.value.error);assert.equal(f.host.deferred(),true)
  for(let count=0;count<8;count++)await nextTick();await f.drain();assert.equal(f.galleryQueries.length,1)
  assert.deepEqual(contextCalls(f),{roots:0,library:0,outbox:0,target:0,capabilities:0,scan:0});f.noWrites()
})

test('ALBUM_RUNTIME_ADMISSION 未ready改变查询使旧等待settle且不报错，stable仅提交最新真实scope',async t=>{
  const f=await fixture(t,{total:7,runtime:'starting'}),entering=f.enter();await f.drain()
  const changing=f.pages.localLibrary.setScope({query:'合成新查询',rootId:null,filter:'all'});await f.drain()
  assert.equal(f.galleryQueries.length,0);assert.equal(f.pages.localLibrary.snapshot.value.error,'')
  f.coreEvent('core.ready');await Promise.all([entering,changing]);await f.drain()
  assert.equal(f.galleryQueries.length,1);assert.equal(f.galleryQueries[0]!.query,'合成新查询')
  assert.equal(f.pages.localLibrary.snapshot.value.loaded,true);assert.equal(f.pages.localLibrary.snapshot.value.error,'');f.noWrites()
})


for(const runtime of ['failed','stopped'] as const)test(`ALBUM_RUNTIME_TERMINAL ${runtime}且无切换必须走原错误并settle，不能永久loading`,async t=>{
  const f=await fixture(t,{total:7,runtime});await f.enter()
  assert.equal(f.galleryQueries.length,0);assert.equal(f.pages.localLibrary.snapshot.value.initialLoading,false)
  assert.equal(f.pages.localLibrary.snapshot.value.status,'error');assert.ok(f.pages.localLibrary.snapshot.value.error)
  assert.deepEqual(contextCalls(f),{roots:0,library:0,outbox:0,target:0,capabilities:0,scan:0})
  f.coreEvent('core.health',runtime);await f.drain();assert.equal(f.galleryQueries.length,0)
  f.coreEvent('core.ready');await f.drain()
  assert.equal(f.galleryQueries.length,1);assert.equal(f.pages.localLibrary.snapshot.value.loaded,true)
  assert.equal(f.pages.localLibrary.snapshot.value.error,'');f.noWrites()
})

for(const runtime of ['failed','stopped'] as const)test(`ALBUM_RUNTIME_TERMINAL ${runtime}但autoStart正在切换仍等待，真实新Core就绪后只派一次`,async t=>{
  const f=await fixture(t,{total:7,runtime,remoteStatus:'checking'}),entering=f.enter();await f.drain()
  assert.equal(f.galleryQueries.length,0);assert.equal(f.pages.localLibrary.snapshot.value.initialLoading,true)
  assert.equal(f.pages.localLibrary.snapshot.value.error,'')
  f.coreEvent('core.health',runtime);f.remoteCoreState.value={status:'starting'};await f.drain()
  assert.equal(f.pages.localLibrary.snapshot.value.error,'');assert.equal(f.galleryQueries.length,0)
  f.coreEvent('core.health','starting');f.remoteCoreState.value={status:'ready'};await f.drain()
  assert.equal(f.galleryQueries.length,0);assert.equal(f.pages.localLibrary.snapshot.value.initialLoading,true)
  f.coreEvent('core.ready');await entering;await f.drain()
  assert.equal(f.galleryQueries.length,1);assert.equal(f.pages.localLibrary.snapshot.value.loaded,true);f.noWrites()
})

test('ALBUM_RUNTIME_TERMINAL starting等待中收到真实failed必须立即settle为错误，重复失败事件不派读',async t=>{
  const f=await fixture(t,{total:7,runtime:'starting'}),entering=f.enter();await f.drain()
  assert.equal(f.pages.localLibrary.snapshot.value.initialLoading,true);assert.equal(f.galleryQueries.length,0)
  f.coreEvent('core.health','failed');await entering;await f.drain()
  assert.equal(f.pages.localLibrary.snapshot.value.initialLoading,false);assert.equal(f.pages.localLibrary.snapshot.value.status,'error')
  assert.ok(f.pages.localLibrary.snapshot.value.error);assert.equal(f.galleryQueries.length,0)
  f.coreEvent('core.health','failed');await f.drain();assert.equal(f.galleryQueries.length,0);f.noWrites()
})

test('ALBUM_RUNTIME_TERMINAL autoStart最终失败且Core未启动不能继续等待，原model展示真实失败',async t=>{
  const f=await fixture(t,{total:7,runtime:'failed',remoteStatus:'reconnecting'}),entering=f.enter();await f.drain()
  assert.equal(f.pages.localLibrary.snapshot.value.initialLoading,true);assert.equal(f.galleryQueries.length,0)
  f.remoteCoreState.value={status:'failed'};await entering;await f.drain()
  assert.equal(f.pages.localLibrary.snapshot.value.initialLoading,false);assert.equal(f.pages.localLibrary.snapshot.value.status,'error')
  assert.ok(f.pages.localLibrary.snapshot.value.error);assert.equal(f.galleryQueries.length,0);f.noWrites()
})
