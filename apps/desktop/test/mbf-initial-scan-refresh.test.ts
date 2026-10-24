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
  const install = '\ninstallInitialScanObservationLifecycle()\n', installed = source.indexOf(install)
  const recoveryStart = source.indexOf('// 本地专辑首读恢复事件开始。'), recoveryEnd = source.indexOf('// 本地专辑首读恢复事件结束。', recoveryStart)
  const recoveryEvent = recoveryStart >= 0 && recoveryEnd > recoveryStart ? source.slice(recoveryStart, recoveryEnd) : ''
  assert.ok(bindingStart >= 0 && bindingEnd > bindingStart && start >= 0 && end > start, '必须执行App原绑定和完整接线区段')
  assert.ok(installed > source.indexOf('\n  currentView, sidebar,'), '正式注册必须位于原currentView初始化之后')
  const body = `${source.slice(bindingStart, bindingEnd)}\n${source.slice(start, end)}${source.slice(installed, installed + install.length)}\nreturn { workbenchLibrary, refreshLocalBrowserViews, refreshLocalLibraryFromWorkbench,
    flush:()=>initialScanWork??Promise.resolve(), observations:()=>[...initialScanObservations.values()], budgets:()=>initialScanDiscoveryBudgets.map(value=>({...value})),
    epoch:()=>initialScanEpoch, timer:()=>initialScanTimer, observeInitialScan:()=>requestInitialScanRefresh(false),
    scanStatus:()=>initialScanStatusError.value, scanJobs:()=>initialScanJobs.value, attemptedRoots:()=>[...initialScanAttemptedRoots],
    receiveCoreEvent:(event)=>{${recoveryEvent}}, recoveryFlush:()=>Promise.all([localAlbumRecoveryWork??Promise.resolve(),localSettingsReadRecoveryWork??Promise.resolve(),initialScanReadRecoveryWork??Promise.resolve()]).then(()=>undefined) };`
  return ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
}
async function fixture(t: TestContext, options: { jobs?: contracts.ScanJobRecord[]; rootPresent?: boolean; phase?: contracts.ScanJobRecord['phase']; total?: number; drainTail?: boolean; initialView?: string; localSession?: ReturnType<typeof useLocalLibrary>; initialReadFailure?: boolean } = {}) {
  const currentView = ref(options.initialView ?? 'home'), scope = effectScope(), mounts: (() => void)[] = [], unmounts: (() => void)[] = []
  const timers = new Map<number, () => void>(), listeners = new Map<string, () => void>(), gates: ReturnType<typeof deferred>[] = []
  const calls: { command: string; payload: any }[] = [], galleryQueries: contracts.LocalAlbumQuery[] = []
  let nextTimer = 0, maxTimers = 0, activeGets = 0, maxGets = 0, activeScanPages = 0, maxScanPages = 0, rootsReads = 0, libraryReads = 0, trackRefreshes = 0, invalidations = 0, activeQueries = 0, maxQueries = 0, now = 1_800_000_000_000
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
  const remoteCoreState = ref<{ status: contracts.RemoteCoreTunnelStatus }>({ status: 'idle' })
  let rows = options.jobs ?? [job(state.phase)]
  const readback = (): contracts.LocalLibraryManagementReadback => ({ datasetId: state.datasetId, revision: String(libraryReads), scanConcurrency: 12,
    libraries: state.rootPresent ? [{ libraryId: rootId, label: '合成新目录', role: 'catalog', online: state.availability === 'ONLINE', watching: false, latestSnapshotId: state.snapshotId,
      totalAlbums: state.total, totalTracks: state.total, scanState: state.availability !== 'ONLINE' ? 'offline' : state.phase === 'completed' ? 'complete' : state.phase === 'pending' ? 'queued' : state.phase }] : [] })
  let importCommand: string | null = null
  const api = {
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
    async localNameSettings() { throw new Error('本例不读取或更改模型设置') },
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
  const modelApi: contracts.LocalAlbumReadPort = {
    async queryAlbums(request) {
      galleryQueries.push(structuredClone(request))
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
  const localLibrary = options.localSession ?? { maintenanceLocked: ref(false), loaded: ref(false), error: ref(''), rootsError: ref(''), refreshContext: async () => {}, refresh: async () => { trackRefreshes++ } }, workbenchLyrics = { pending: ref(false) }
  const storage = new Map<string, string>()
  const window = { musicBridge: api, localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value) } },
    addEventListener: (name: string, callback: () => void) => { listeners.set(name, callback) }, removeEventListener: (name: string) => { listeners.delete(name) } }
  const setTimeout = (callback: () => void, delay: number) => { assert.ok(delay > 0 && delay <= 15_000); const timer = ++nextTimer; timers.set(timer, callback); timerDelays.set(timer, delay); maxTimers = Math.max(maxTimers, timers.size); return timer }
  const clearTimeout = (timer: number | undefined) => { if (timer !== undefined) { timers.delete(timer); timerDelays.delete(timer) } }
  let pages!: ReturnType<typeof useLocalAlbumBrowserPages>, host: any
  scope.run(() => {
    pages = useLocalAlbumBrowserPages({ api: modelApi })
    const wrap = (page: typeof pages.localLibrary) => ({ ...page, invalidateArtwork: async () => { invalidations++; await page.invalidateArtwork() } })
    const parameters = ['window', 'watch', 'onMounted', 'onUnmounted', 'currentView', 'localWorkbenchDto', 'useLocalWorkbenchLibrary', 'localLibrary', 'workbenchLyrics', 'albumBrowser', 'coverDropBrowser', 'setTimeout', 'clearTimeout', 'shallowRef', 'ref', 'logLibraryOperation', 'remoteCoreState', 'isCoreRuntimeStable', 'Date']
    // 仅隔离VM拦截原生finally入口，在真实尾微任务中投递请求；不改App区段或替代drain。
    const factory = options.drainTail ? runInNewContext(`(() => {
      const originalFinally = Promise.prototype.finally;
      Promise.prototype.finally = function(callback) { return originalFinally.call(this, () => { beforeDrainFinally(); return callback(); }); };
      return function(${parameters.join(',')}) { ${sourceBlock()} };
    })()`, { beforeDrainFinally: () => drainTail?.() }) : new Function(...parameters, sourceBlock())
    host = factory(
      window, watch, (callback: () => void) => mounts.push(callback), (callback: () => void) => unmounts.push(callback), currentView, contracts, useLocalWorkbenchLibrary,
      localLibrary, workbenchLyrics, wrap(pages.localLibrary), wrap(pages.coverDrop), setTimeout, clearTimeout, shallowRef, ref, logLibraryOperation, remoteCoreState, isCoreRuntimeStable, { now: () => now })
  })
  let destroyed = false
  const destroy = () => { if (destroyed) return; destroyed = true; for (const callback of unmounts) callback(); host.workbenchLibrary.dispose(); scope.stop() }
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
  await host.workbenchLibrary.read()
  const enter = async (view = 'local-library') => { currentView.value = view; if (view === 'local-library') await pages.localLibrary.activate(); else if (view === 'coverdrop') await pages.coverDrop.activate(); await drain() }
  const tick = async () => { assert.equal(timers.size, 1, '只允许一个待执行观察timer'); const [key, callback] = [...timers][0]!; now += timerDelays.get(key)!; timers.delete(key); timerDelays.delete(key); callback(); await drain() }
  const hold = (kind: 'nextRead' | 'nextGet' | 'nextQuery' | 'nextPage') => { const gate = deferred(); gates.push(gate); state[kind] = gate; return gate }
  const noWrites = () => assert.equal(calls.some(value => ['localScan.start', 'localScan.resume', 'localScan.prepareBatch', 'localScan.commitBatch', 'library.snapshot.retry', 'library.snapshot.load'].includes(value.command)), false)
  return { host, pages, state, currentView, calls, galleryQueries, timers, listeners, drain, enter, tick, hold, destroy, noWrites, now: () => now,
    counters: () => ({ maxTimers, maxGets, maxScanPages, rootsReads, libraryReads, trackRefreshes, invalidations, maxQueries }), setRows: (value: contracts.ScanJobRecord[]) => { rows = value },
    coreEvent: (event: 'core.ready' | 'core.health', runtime: contracts.RuntimeStatus = 'ready') => host.receiveCoreEvent({ event, payload: { state: { runtime } } }), remoteCoreState,
    onDrainTail: (callback: () => void) => { drainTail = callback } }
}

test('LOCAL_ALBUM_CORE_RECOVERY 切换中首读error，真实ready过早失败后stable health补一次恢复，健康页零重复查询', async t => {
  for (const view of ['local-library', 'coverdrop']) await t.test(view, async sub => {
    const f = await fixture(sub, { total: 7 }); f.state.queryFailures = 1; await f.enter(view)
    const browser = view === 'local-library' ? f.pages.localLibrary : f.pages.coverDrop
    assert.equal(browser.snapshot.value.loaded, false); assert.equal(browser.snapshot.value.status, 'error')
    f.state.queryFailures = 1; f.coreEvent('core.ready'); await f.drain()
    assert.equal(browser.snapshot.value.status, 'error'); assert.equal(f.galleryQueries.length, 2)
    f.coreEvent('core.health'); await f.drain()
    assert.equal(browser.snapshot.value.loaded, true); assert.equal(browser.snapshot.value.total, 7); assert.equal(f.galleryQueries.length, 3)
    f.coreEvent('core.health'); f.coreEvent('core.ready'); f.coreEvent('core.health'); await f.drain()
    assert.equal(f.galleryQueries.length, 3, '已loaded页不能因ready/health重复刷新')
    f.noWrites()
  })
})

test('LOCAL_ALBUM_CORE_RECOVERY 持续真实错误每个Core代次最多两次，Core未ready不读且错误提示保留', async t => {
  const f = await fixture(t); f.state.queryFailures = 20; await f.enter()
  f.coreEvent('core.health', 'starting'); await f.drain()
  assert.equal(f.galleryQueries.length, 1)
  f.remoteCoreState.value.status = 'ready'
  for (let n = 0; n < 8; n++) { f.coreEvent('core.health'); await f.drain() }
  assert.equal(f.galleryQueries.length, 3); assert.equal(f.pages.localLibrary.snapshot.value.status, 'error')
  assert.notEqual(f.pages.localLibrary.snapshot.value.error, '')
  f.state.queryFailures = 0; f.coreEvent('core.ready'); await f.drain()
  assert.equal(f.galleryQueries.length, 4); assert.equal(f.pages.localLibrary.snapshot.value.loaded, true)
  f.noWrites()
})

test('LOCAL_ALBUM_CORE_RECOVERY Main绑定后的真实health不依赖SSH稳定，成功后只补真实失败的曲目首读', async t => {
  for (const failed of [true, false]) await t.test(failed ? '曲目首读失败' : '曲目已健康加载', async sub => {
    let available = !failed, trackReads = 0
    const scope = effectScope(), unused = async (): Promise<never> => { throw new Error('本例禁止写入、扫描或播放。') }
    const api: contracts.LocalLibraryPublicApi = {
      async queryLocalLibraryTracks(query) { trackReads++; if (!available) throw new Error('合成Core未就绪'); return { ...query, items: [], total: 0, hasMore: false } },
      async listLocalLibraryRoots() { return [root] }, async getLocalLibraryPlaybackTarget() { return null },
      getLocalLibraryTrackDetail: unused, overrideLocalLibraryMetadata: unused, playLocalLibraryTrack: unused, chooseLocalLibraryRoot: unused,
      chooseLocalRelocationCandidates: unused, confirmLocalRelocation: unused, relinkLocalLibraryRoot: unused, localLibraryScan: unused,
      listLocalLibraryTracks: unused, getLocalLibraryAsset: unused, getLocalLibraryMetadata: unused,
    }
    const session = scope.run(() => useLocalLibrary({ api, getSelectedZone: () => undefined, play: unused }))!
    sub.after(() => { session.dispose(); scope.stop() })
    await session.activate()
    assert.equal(session.loaded.value, !failed)
    if (failed) assert.match(session.error.value, /这一页暂时无法读取/u)
    const originalReads = trackReads
    const f = await fixture(sub, { total: 7, localSession: session }); f.state.queryFailures = 2; await f.enter()
    f.remoteCoreState.value.status = 'starting'
    f.coreEvent('core.ready'); await f.drain()
    assert.equal(f.galleryQueries.length, 2, '本地读取不依赖Roon/SSH切换状态')
    assert.equal(trackReads, originalReads, '专辑尚未恢复时不能清理或掩盖曲目错误')
    available = true
    f.coreEvent('core.health'); await f.drain()
    assert.equal(f.pages.localLibrary.snapshot.value.loaded, true)
    assert.equal(session.loaded.value, true); assert.equal(session.error.value, '')
    assert.equal(trackReads, originalReads + (failed ? 1 : 0), '只补一次真实失败页，健康曲目session不刷新')
    f.coreEvent('core.health'); await f.drain()
    assert.equal(f.galleryQueries.length, 3); assert.equal(trackReads, originalReads + (failed ? 1 : 0))
    f.noWrites()
  })
})

test('LOCAL_ALBUM_CORE_RECOVERY 单次在途合并health，离页/换dataset/pagehide拒绝原代排队恢复', async t => {
  for (const action of ['continue', 'leave', 'dataset', 'pagehide', 'unmount']) await t.test(action, async sub => {
    const f = await fixture(sub); f.state.queryFailures = 2; await f.enter()
    const held = f.hold('nextQuery'); f.coreEvent('core.ready'); await held.entered
    f.coreEvent('core.health'); f.coreEvent('core.health')
    assert.equal(f.galleryQueries.length, 2); assert.equal(f.counters().maxQueries, 1)
    if (action === 'leave') { f.currentView.value = 'home'; f.pages.localLibrary.deactivate() }
    if (action === 'dataset') { f.state.datasetId = id(45); f.state.rootPresent = false; f.host.workbenchLibrary.state.value = { datasetId: id(45), revision: 'new', libraries: [], scanConcurrency: 12 } }
    if (action === 'pagehide') f.listeners.get('pagehide')!()
    if (action === 'unmount') f.destroy()
    held.release(); await f.drain()
    assert.equal(f.galleryQueries.length, action === 'continue' ? 3 : 2)
    if (action === 'continue') assert.equal(f.pages.localLibrary.snapshot.value.loaded, true)
    assert.equal(f.counters().maxQueries, 1); f.noWrites()
  })
})

test('LOCAL_ALBUM_CORE_RECOVERY 延后旧曲目页时只重读失败目录，离页和身份变化不消费迟到恢复', async t => {
  for (const action of ['continue', 'leave', 'dataset', 'pagehide', 'unmount']) await t.test(action, async sub => {
    let available = false, rootsReads = 0, trackReads = 0
    const unused = async (): Promise<never> => { throw new Error('本例禁止写入、扫描或播放。') }, scope = effectScope()
    const api: contracts.LocalLibraryPublicApi = {
      async queryLocalLibraryTracks(query) { trackReads++; return { ...query, items: [], total: 0, hasMore: false } },
      async listLocalLibraryRoots() { rootsReads++; if (!available) throw new Error('合成Core切换中的目录NOT_READY'); return [root] },
      async getLocalLibraryPlaybackTarget() { return null }, getLocalLibraryTrackDetail: unused, overrideLocalLibraryMetadata: unused,
      playLocalLibraryTrack: unused, chooseLocalLibraryRoot: unused, chooseLocalRelocationCandidates: unused, confirmLocalRelocation: unused,
      relinkLocalLibraryRoot: unused, localLibraryScan: unused, listLocalLibraryTracks: unused, getLocalLibraryAsset: unused, getLocalLibraryMetadata: unused,
    }
    const session = scope.run(() => useLocalLibrary({ api, getSelectedZone: () => undefined, play: unused }))!
    sub.after(() => { session.dispose(); scope.stop() })
    await session.activate({ deferTrackReads: true })
    assert.equal(trackReads, 0); assert.equal(session.error.value, ''); assert.match(session.rootsError.value, /目录状态暂时无法读取/u)
    const f = await fixture(sub, { total: 7, localSession: session }); f.state.queryFailures = 2; await f.enter()
    f.coreEvent('core.ready'); await f.drain()
    assert.equal(f.galleryQueries.length, 2); assert.equal(rootsReads, 1)
    const held = f.hold('nextQuery'); available = true; f.coreEvent('core.health'); await held.entered
    if (action === 'leave') { f.currentView.value = 'home'; f.pages.localLibrary.deactivate() }
    if (action === 'dataset') f.host.workbenchLibrary.state.value = { datasetId: id(45), revision: 'new', libraries: [], scanConcurrency: 12 }
    if (action === 'pagehide') f.listeners.get('pagehide')!()
    if (action === 'unmount') f.destroy()
    held.release(); await f.drain()
    assert.equal(trackReads, 0, '目录恢复不能重新启用未消费旧列表')
    assert.equal(rootsReads, action === 'continue' ? 2 : 1)
    if (action === 'continue') {
      assert.equal(session.rootsError.value, ''); assert.equal(session.rootsLoaded.value, true); assert.deepEqual(session.roots.value, [root])
      assert.equal(f.pages.localLibrary.snapshot.value.loaded, true)
      f.coreEvent('core.health'); await f.drain(); assert.equal(rootsReads, 2, '健康目录不重复读取')
    } else assert.match(session.rootsError.value, /目录状态暂时无法读取/u)
    f.noWrites()
  })
})

test('INITIAL_SCAN_REFRESH 生命周期首次进入只由model读取一屏，显式刷新仍真正再读一次', async t => {
  for (const [phase, initialView] of [['running', 'home'], ['completed', 'home'], ['completed', 'local-library']] as const) {
    await t.test(`${initialView}进入${phase}`, async sub => {
      const f = await fixture(sub, { phase, total: 7, initialView }); await f.enter()
      assert.equal(f.galleryQueries.length, 1, 'watch/onMounted只观察扫描，首屏已经由model.activate读取')
      assert.equal(f.pages.localLibrary.snapshot.value.items.length, 7)
      assert.equal(f.host.observations()[0].job.phase, phase)
      await f.host.refreshLocalBrowserViews(); await f.drain()
      assert.equal(f.galleryQueries.length, 2, '用户显式刷新仍保留原目录读取')
      f.noWrites()
    })
  }
})

test('INITIAL_SCAN_REFRESH 观察请求false不能覆盖已经排队的显式刷新true', async t => {
  const f = await fixture(t); await f.enter()
  const held = f.hold('nextGet'), inspecting = f.tick(); await held.entered
  const before = f.galleryQueries.length
  const refresh = f.host.refreshLocalBrowserViews(), observing = f.host.observeInitialScan()
  held.release(); await Promise.all([inspecting, refresh, observing]); await f.drain()
  assert.equal(f.galleryQueries.length, before + 1, '本轮只合并一次刷新，后来的观察请求不能把它取消')
  f.noWrites()
})

test('INITIAL_SCAN_REFRESH 历史completed首读后零重复整库查询，旧快照不冒本job快照证明', async t => {
  const f = await fixture(t, { phase: 'completed', total: 7 }); f.state.snapshotId = id(77)
  await f.enter()
  const queries = f.galleryQueries.length, reads = f.counters().libraryReads, tracks = f.counters().trackRefreshes
  for (let pass = 0; pass < 8; pass++) { if (f.timers.size) await f.tick(); else await f.drain() }
  assert.equal(f.galleryQueries.length, queries, '未发生新扫描时不能再执行六轮封面墙查询')
  assert.equal(f.counters().libraryReads, reads, '历史completed不能靠timer重复读取全库计数')
  assert.equal(f.counters().trackRefreshes, tracks)
  assert.equal(f.timers.size, 0); assert.equal(f.host.observations()[0].finished, true)
  assert.equal(f.host.observations()[0].observedSnapshot, id(77), '只记录实读最后成功ID，不证明它属于此job')
  assert.equal(f.host.workbenchLibrary.operations.value.length, 0); assert.equal(f.host.workbenchLibrary.notice.value, '')
  f.noWrites()
})

test('INITIAL_SCAN_REFRESH 扫描仅visited或job修订变化不刷整库，新增入库批及真正完成各刷新一次', async t => {
  const f = await fixture(t); await f.enter()
  let queries = f.galleryQueries.length, reads = f.counters().libraryReads
  f.state.jobRevision = '4'; f.state.progress = { visited: '10', accepted: '0', rejected: '2' }
  await f.tick(); await f.tick()
  assert.equal(f.galleryQueries.length, queries); assert.equal(f.counters().libraryReads, reads)
  f.state.jobRevision = '5'; f.state.progress = { visited: '20', accepted: '3', rejected: '2' }; f.state.total = 3
  await f.tick()
  assert.equal(f.galleryQueries.length, queries + 1); assert.equal(f.counters().libraryReads, reads + 1)
  queries = f.galleryQueries.length; reads = f.counters().libraryReads
  await f.tick(); assert.equal(f.galleryQueries.length, queries); assert.equal(f.counters().libraryReads, reads)
  f.state.phase = 'completed'; f.state.jobRevision = '6'; f.state.progress = { visited: '20', accepted: '3', rejected: '17' }
  await f.tick()
  assert.equal(f.galleryQueries.length, queries + 1); assert.equal(f.counters().libraryReads, reads + 1)
  assert.equal(f.pages.localLibrary.snapshot.value.total, 3); assert.equal(f.timers.size, 0)
  assert.equal(f.host.observations()[0].observedSnapshot, null, '没有完成快照时仍保持未知')
  f.noWrites()
})

test('INITIAL_SCAN_REFRESH 首批立即显示，中间批次五秒合并且进度实时更新，完成立即冲刷', async t => {
  const f = await fixture(t); await f.enter(); const queries = f.galleryQueries.length
  const batch = (accepted: number) => { f.state.total = accepted; f.state.progress = { visited: String(accepted), accepted: String(accepted), rejected: '0' }; f.state.jobRevision = String(accepted + 3) }
  batch(1); await f.tick(); const firstAt = f.now()
  assert.equal(f.galleryQueries.length, queries + 1); assert.equal(f.pages.localLibrary.total.value, 1)
  for (const accepted of [2, 3, 4]) {
    batch(accepted); await f.tick()
    assert.equal(f.galleryQueries.length, queries + 1, '中间入库批不能每次重读整个已载页前缀')
    assert.equal(f.host.observations()[0].job.progress.accepted, String(accepted), '真实进度不等待投影节流')
  }
  await f.tick(); assert.equal(f.now() - firstAt, 5000)
  assert.equal(f.galleryQueries.length, queries + 2); assert.equal(f.pages.localLibrary.total.value, 4)
  batch(5); await f.host.observeInitialScan(); await f.drain(); assert.equal(f.galleryQueries.length, queries + 2)
  f.state.phase = 'completed'; await f.host.observeInitialScan(); await f.drain()
  assert.equal(f.galleryQueries.length, queries + 3); assert.equal(f.pages.localLibrary.total.value, 5)
  assert.equal(f.timers.size, 0); assert.equal(f.counters().maxTimers, 1); assert.equal(f.counters().maxQueries, 1); f.noWrites()
})

test('INITIAL_SCAN_REFRESH 用户明确刷新绕过扫描节流，离开相关页面撤销未冲刷批次', async t => {
  const f = await fixture(t); await f.enter()
  f.state.total = 1; f.state.progress = { visited: '1', accepted: '1', rejected: '0' }; await f.tick()
  const queries = f.galleryQueries.length
  f.state.total = 2; f.state.progress = { visited: '2', accepted: '2', rejected: '0' }; await f.tick()
  assert.equal(f.galleryQueries.length, queries)
  await f.host.refreshLocalBrowserViews(); await f.drain(); assert.equal(f.galleryQueries.length, queries + 1); assert.equal(f.pages.localLibrary.total.value, 2)
  f.state.total = 3; f.state.progress = { visited: '3', accepted: '3', rejected: '0' }; await f.tick()
  assert.equal(f.galleryQueries.length, queries + 1)
  f.currentView.value = 'home'; await f.drain(); assert.equal(f.timers.size, 0); assert.equal(f.galleryQueries.length, queries + 1); f.noWrites()
})

test('INITIAL_SCAN_REFRESH 空drain判空到finally之间的真实微任务投递不丢发现，旧Promise等待新drain', async t => {
  const f = await fixture(t, { rootPresent: false, jobs: [], drainTail: true })
  let inserted = false, tailRequest: Promise<void> | undefined
  f.onDrainTail(() => {
    if (inserted) return
    inserted = true
    assert.equal(f.host.observations().length, 0); assert.equal(f.timers.size, 0, '原drain没有captured job可借timer唤醒')
    f.state.rootPresent = true; f.state.phase = 'completed'; f.state.total = 7; f.setRows([job('completed')])
    tailRequest = f.host.refreshLocalBrowserViews()
  })
  f.currentView.value = 'local-library'
  const originalDrain = f.host.flush()
  await f.pages.localLibrary.activate()
  await originalDrain
  assert.equal(inserted, true)
  assert.equal(f.host.observations()[0]?.job.jobId, jobId, '旧Promise结束前必须处理尾窗发现，不能永久留队')
  assert.equal(f.pages.localLibrary.snapshot.value.total, 7)
  assert.equal(f.host.workbenchLibrary.state.value.libraries[0].totalAlbums, 7)
  await tailRequest
  assert.equal(f.counters().maxTimers, 0, '尾窗发现的历史完成任务不再安排六轮计数读取'); assert.equal(f.counters().maxGets, 1)
  assert.equal(f.timers.size, 0); assert.equal(f.host.workbenchLibrary.notice.value, ''); f.noWrites()
})

test('INITIAL_SCAN_REFRESH legacy目标位于中间分页，运行中进入普通墙并停留自然更新真实model与库计数', async t => {
  const rows = Array.from({ length: 650 }, (_, index) => job('completed', { jobId: id(1000 + index), libraryRootId: id(99) }))
  rows[250] = job(); rows[640] = job('completed', { jobId: id(6000), sourceRootId: id(98) }); rows[645] = job('completed', { jobId: id(6001), rootRevision: '2' })
  const f = await fixture(t, { jobs: rows }); await f.enter()
  assert.deepEqual(f.calls.filter(value => value.command === 'localScan.page' && value.payload.limit === 200).map(value => value.payload.offset), [600, 400, 200])
  assert.equal(f.pages.localLibrary.snapshot.value.total, 0); assert.equal(f.host.observations()[0].job.jobId, jobId)
  f.state.phase = 'completed'; f.state.total = 7; f.state.snapshotId = id(8)
  await f.tick()
  assert.equal(f.currentView.value, 'local-library'); assert.equal(f.pages.localLibrary.snapshot.value.items.length, 7)
  assert.equal(f.host.workbenchLibrary.state.value.libraries[0].totalAlbums, 7)
  assert.equal(f.host.workbenchLibrary.state.value.libraries[0].latestSnapshotId, id(8))
  assert.equal(f.host.observations()[0].settleAttempts, 0); assert.equal(f.host.observations()[0].finished, true); assert.equal(f.timers.size, 0)
  assert.equal(f.host.workbenchLibrary.notice.value, '', '正常完成和成功快照不产生额外故障提示')
  assert.equal(f.host.observations()[0].observedSnapshot, id(8), '只保留最后成功ID观察，不升级成本次job快照证明')
  assert.deepEqual(f.counters().invalidations, 0, '观察进度不能清空全部封面')
  assert.equal(f.counters().maxTimers, 1); assert.equal(f.counters().maxGets, 1); f.noWrites()
})

test('INITIAL_SCAN_REFRESH 实际导入callback用原command receipt绑定，pending回执不冒充当前phase', async t => {
  const f = await fixture(t, { rootPresent: false }); await f.enter('settings')
  await f.host.workbenchLibrary.prepareImport(); assert.equal(await f.host.workbenchLibrary.confirmImport(), true); await f.drain()
  assert.equal(f.calls.filter(value => value.command === 'localScan.receipt').length, 1)
  assert.equal(f.calls.filter(value => value.command === 'localScan.page').length, 0, '直接原receipt绑定无需遍历其他历史')
  assert.equal(f.host.observations()[0].job.phase, 'running')
  await f.enter('local-library'); f.state.phase = 'completed'; f.state.total = 7; await f.tick()
  assert.equal(f.pages.localLibrary.snapshot.value.total, 7); assert.equal(f.host.workbenchLibrary.state.value.libraries[0].totalTracks, 7)
  assert.equal(f.counters().invalidations, 2, '只保留真实导入成功的一次原双页失效意图')
  f.noWrites()
})

test('INITIAL_SCAN_REFRESH read忙与吞错不冒fresh，另一旧read迟回后仍须本次真正新读', async t => {
  const f = await fixture(t)
  const oldRead = f.hold('nextRead'), old = f.host.workbenchLibrary.read()
  f.state.phase = 'completed'; f.state.total = 7; f.state.snapshotId = id(9)
  await f.enter()
  const queries = f.galleryQueries.length
  assert.equal(f.host.workbenchLibrary.state.value.libraries[0].totalAlbums, 0)
  assert.equal(f.host.observations()[0].observedSnapshot, null)
  assert.equal(f.host.workbenchLibrary.notice.value, '', 'busy不是用户故障')
  oldRead.release(); await old; await f.drain()
  assert.equal(f.host.workbenchLibrary.state.value.libraries[0].totalAlbums, 0, '旧read返回的是受理时旧事实')
  f.state.readThrows = true; await f.tick()
  assert.equal(f.host.observations()[0].observedSnapshot, null); assert.notEqual(f.host.workbenchLibrary.error.value, '')
  f.state.readThrows = false; await f.tick()
  assert.equal(f.host.workbenchLibrary.state.value.libraries[0].totalAlbums, 7)
  assert.equal(f.host.observations()[0].observedSnapshot, id(9)); assert.equal(f.host.observations()[0].finished, true)
  assert.equal(f.galleryQueries.length, queries, 'busy和吞错后的补读只更新库读取证据，不重放完成态的封面墙刷新')
  assert.equal(f.timers.size, 0); assert.equal(f.host.observations()[0].settleAttempts, 2); f.noWrites()
})

test('INITIAL_SCAN_REFRESH 初见completed的缺失或旧快照只保内部未确认，普通已有库及busy初读不凭空notice', async t => {
  for (const snapshot of [null, id(10)]) await t.test(snapshot ? '已有库旧成功快照与busy初读' : '完成快照始终缺失', async sub => {
    const f = await fixture(sub, { phase: 'completed', total: 7 })
    if (snapshot) {
      f.state.snapshotId = snapshot; await f.host.workbenchLibrary.read()
      f.host.workbenchLibrary.state.value = null
      const gate = f.hold('nextRead'), reading = f.host.workbenchLibrary.read()
      await gate.entered; await f.enter('coverdrop')
      assert.equal(f.host.workbenchLibrary.notice.value, '', 'bootstrap的busy短路不能制造notice')
      gate.release(); await reading; await f.drain()
    } else await f.enter('coverdrop')
    for (let attempt = 0; attempt < 2; attempt++) {
      await Promise.all([f.host.refreshLocalBrowserViews(), f.host.refreshLocalBrowserViews()]); await f.drain()
      assert.equal(f.host.observations()[0].settleAttempts, 0); assert.equal(f.timers.size, 0, '显式刷新已完成任务也不重开自动settle轮询')
      assert.ok(f.host.budgets().every((value: { pages: number; rows: number; restarts: number }) => value.pages <= 50 && value.rows <= 10000 && value.restarts <= 1))
      assert.equal(f.host.workbenchLibrary.notice.value, '')
    }
    assert.equal(f.pages.coverDrop.snapshot.value.total, 7); assert.equal(f.host.workbenchLibrary.state.value.libraries[0].latestSnapshotId, snapshot)
    assert.equal(f.host.observations()[0].observedSnapshot, snapshot); assert.equal(f.host.observations()[0].finished, true)
    assert.equal(f.host.workbenchLibrary.operations.value.length, 0, '普通已有库进入，没有虚构新导入意图')
    assert.equal(f.timers.size, 0)
    await f.host.refreshLocalBrowserViews(); await f.drain(); assert.equal(f.timers.size, 0); assert.equal(f.host.workbenchLibrary.notice.value, ''); f.noWrites()
  })
})

test('INITIAL_SCAN_REFRESH 原get挂起后确认写回调再离页/换scope，双页真实失效仍独立完成', async t => {
  for (const action of ['leave', 'dataset'] as const) await t.test(action, async sub => {
    const f = await fixture(sub); await f.enter()
    const held = f.hold('nextGet'), pending = f.tick(); await held.entered
    const libraryEpoch = f.pages.localLibrary.snapshot.value.artworkInvalidation?.epoch ?? 0, coverDropEpoch = f.pages.coverDrop.snapshot.value.artworkInvalidation?.epoch ?? 0
    const written = f.host.refreshLocalLibraryFromWorkbench()
    assert.equal(f.counters().invalidations, 2, '确认写后的业务失效不排在挂起get后')
    assert.equal(f.pages.localLibrary.snapshot.value.artworkInvalidation?.epoch, libraryEpoch + 1)
    assert.equal(f.pages.coverDrop.snapshot.value.artworkInvalidation?.epoch, coverDropEpoch + 1)
    if (action === 'leave') { f.currentView.value = 'home'; f.pages.localLibrary.deactivate() }
    else { f.state.datasetId = id(45); f.state.rootPresent = false; f.host.workbenchLibrary.state.value = { datasetId: id(45), revision: 'new', libraries: [], scanConcurrency: 12 } }
    held.release(); await Promise.all([pending, written]); await f.drain()
    assert.equal(f.counters().invalidations, 2, '旧观察迟回或scope变化不丢失也不重放业务失效')
    assert.equal(f.host.observations().length, 0); assert.equal(f.timers.size, 0); assert.equal(f.counters().maxGets, 1); f.noWrites()
  })
})

test('INITIAL_SCAN_REFRESH 离页/换dataset/卸载/pagehide/根修订变化丢弃实际get迟回并清timer', async t => {
  for (const action of ['leave', 'dataset', 'unmount', 'pagehide', 'root'] as const) await t.test(action, async sub => {
    const f = await fixture(sub); await f.enter()
    f.state.phase = 'completed'; f.state.total = 7
    const held = f.hold('nextGet'), pending = f.tick()
    await held.entered
    const before = f.host.epoch()
    if (action === 'leave') { f.currentView.value = 'home'; f.pages.localLibrary.deactivate() }
    if (action === 'dataset') { f.state.datasetId = id(44); f.state.rootPresent = false; f.state.total = 0; f.host.workbenchLibrary.state.value = { datasetId: id(44), revision: 'new', libraries: [], scanConcurrency: 12 } }
    if (action === 'unmount') f.destroy()
    if (action === 'pagehide') f.listeners.get('pagehide')!()
    if (action === 'root') { f.state.rootRevision = '2'; void f.host.refreshLocalBrowserViews() }
    held.release(); await pending; await f.drain()
    if (action !== 'root') assert.ok(f.host.epoch() > before)
    if (action === 'root') { assert.equal(f.host.observations().some((value: any) => !value.finished), false); assert.equal(f.host.observations()[0].completed, false) }
    assert.equal(f.timers.size, 0); assert.equal(f.counters().maxGets, 1); f.noWrites()
  })
})

test('INITIAL_SCAN_REFRESH 发现预算耗尽或total连续变化保未确认，不漏页冒无任务或空poll', async t => {
  for (const unstable of [false, true]) await t.test(unstable ? 'total连续变化' : '原任务超出发现预算', async sub => {
    const rows = Array.from({ length: unstable ? 250 : 12000 }, (_, index) => job('completed', { jobId: id(1000 + index), libraryRootId: id(99) }))
    rows[0] = job()
    const f = await fixture(sub, { jobs: rows }); f.state.pageTotalsChange = unstable; await f.enter()
    const [budget] = f.host.budgets(); assert.ok(budget.pages <= 50 && budget.rows <= 10000 && budget.restarts <= 1)
    assert.equal(f.host.observations().length, 0); assert.equal(f.calls.some(value => value.command === 'localScan.get'), false)
    assert.match(f.host.workbenchLibrary.notice.value, /尚未确认/u); assert.equal(f.timers.size, 0)
    await f.host.refreshLocalBrowserViews(); await f.drain()
    assert.deepEqual(f.host.budgets()[0], budget)
    assert.ok(f.host.budgets().length >= 2, '设置显式刷新可重新发现最新任务，每次仍使用独立有限预算')
    assert.ok(f.host.budgets().every((value: { pages: number; rows: number; restarts: number }) => value.pages <= 50 && value.rows <= 10000 && value.restarts <= 1))
    assert.equal(f.timers.size, 0); f.noWrites()
  })
})

test('INITIAL_SCAN_REFRESH 等待扫描超过旧六轮后仍观察，进度恢复后自然显示音乐且零自动resume', async t => {
  const f = await fixture(t, { phase: 'pending' }); await f.enter()
  for (let count = 0; count < 8; count++) await f.tick()
  assert.equal(f.timers.size, 1)
  assert.equal(f.host.observations()[0].finished, false)
  f.state.phase = 'completed'; f.state.total = 7; await f.tick()
  assert.equal(f.pages.localLibrary.snapshot.value.total, 7)
  f.noWrites()
})

test('INITIAL_SCAN_REFRESH 手动暂停停止观察，设置继续原任务后可重新发现同一job且不重签扫描', async t => {
  const f = await fixture(t, { phase: 'paused' }); await f.enter()
  assert.equal(f.host.observations()[0].job.phase, 'paused')
  assert.equal(f.timers.size, 0)
  f.state.phase = 'running'; f.setRows([job('running', { jobRevision: '3' })])
  await f.host.refreshLocalBrowserViews(); await f.drain()
  assert.equal(f.host.observations()[0].job.phase, 'running')
  assert.equal(f.timers.size, 1)
  f.noWrites()
})

test('SETTINGS_FIRST_READ_RECOVERY 只有实际library.read失败置位，名称/未知操作错误不冒充库首读失败', async t => {
  let ready = false
  const calls: string[] = []
  const api = {
    async localLibraryManagement(command: string) {
      calls.push(command); assert.equal(command, 'library.read')
      if (!ready) throw new Error('合成初次库读取NOT_READY')
      return { datasetId: dataset, revision: '1', scanConcurrency: 12, libraries: [] }
    },
    async localNameSettings() { throw new Error('合成名称设置读取失败') },
  }
  const model = useLocalWorkbenchLibrary({ api: api as unknown as Parameters<typeof useLocalWorkbenchLibrary>[0]['api'] })
  t.after(() => model.dispose())
  await model.readNameSettings()
  assert.notEqual(model.error.value, ''); assert.equal(model.state.value, null); assert.equal(model.readFailed.value, false)
  await model.read()
  assert.equal(model.readFailed.value, true); assert.equal(model.state.value, null)
  ready = true; await model.read()
  assert.equal(model.readFailed.value, false)
  assert.deepEqual(model.state.value, { datasetId: dataset, revision: '1', scanConcurrency: 12, libraries: [] })
  assert.deepEqual(calls, ['library.read', 'library.read'])
})

test('SETTINGS_FIRST_READ_RECOVERY 首读失败无已知job时，ready过早失败后真实health补读恢复，成功后零重复', async t => {
  const f = await fixture(t, { initialReadFailure: true, rootPresent: false, jobs: [] }); await f.enter('settings')
  assert.equal(f.host.workbenchLibrary.state.value, null); assert.equal(f.host.workbenchLibrary.readFailed.value, true); assert.equal(f.timers.size, 0)
  const reads = f.counters().libraryReads
  f.coreEvent('core.health', 'starting'); await f.drain(); assert.equal(f.counters().libraryReads, reads)
  f.coreEvent('core.ready'); await f.drain(); assert.equal(f.counters().libraryReads, reads + 1)
  assert.equal(f.host.workbenchLibrary.state.value, null)
  f.state.readThrows = false; f.coreEvent('core.health'); await f.drain()
  assert.equal(f.counters().libraryReads, reads + 2); assert.equal(f.host.workbenchLibrary.readFailed.value, false)
  assert.equal(f.host.workbenchLibrary.state.value.datasetId, dataset); assert.deepEqual(f.host.workbenchLibrary.state.value.libraries, [])
  for (const event of ['core.health', 'core.ready', 'core.health'] as const) f.coreEvent(event)
  await f.drain(); assert.equal(f.counters().libraryReads, reads + 2)
  assert.equal(f.galleryQueries.length, 0, '设置补读不能顺带查询封面墙')
  assert.ok(f.calls.every(value => ['library.read', 'localScan.page', 'localScan.get', 'localScan.receipt'].includes(value.command)))
  f.noWrites()
})

test('SETTINGS_FIRST_READ_RECOVERY 同Core代最多两次普通读，失败不轮询且只有新Core代可重新补读', async t => {
  const f = await fixture(t, { initialReadFailure: true, rootPresent: false, jobs: [] }); await f.enter('settings')
  const reads = f.counters().libraryReads
  for (let event = 0; event < 10; event++) { f.coreEvent('core.health'); await f.drain() }
  assert.equal(f.counters().libraryReads, reads + 2); assert.equal(f.timers.size, 0)
  assert.equal(f.host.workbenchLibrary.readFailed.value, true); assert.notEqual(f.host.workbenchLibrary.error.value, '')
  f.state.readThrows = false; await f.drain(); assert.equal(f.counters().libraryReads, reads + 2, '解除故障本身不能自行发请求')
  f.coreEvent('core.ready'); await f.drain()
  assert.equal(f.counters().libraryReads, reads + 3); assert.equal(f.host.workbenchLibrary.state.value.datasetId, dataset)
  f.noWrites()
})

test('SETTINGS_FIRST_READ_RECOVERY 在途health只合并一个令牌，离页/换dataset/pagehide/unmount不消费旧排队读', async t => {
  for (const action of ['continue', 'leave', 'dataset', 'pagehide', 'unmount']) await t.test(action, async sub => {
    const f = await fixture(sub, { initialReadFailure: true, rootPresent: false, jobs: [] }); await f.enter('settings')
    const reads = f.counters().libraryReads, held = f.hold('nextRead')
    f.coreEvent('core.ready'); await held.entered
    f.coreEvent('core.health'); f.coreEvent('core.health')
    assert.equal(f.counters().libraryReads, reads + 1, '前一个真实read未结束时不得并发第二个')
    if (action === 'leave') f.currentView.value = 'home'
    if (action === 'dataset') f.host.workbenchLibrary.state.value = { datasetId: id(45), revision: 'new', libraries: [], scanConcurrency: 12 }
    if (action === 'pagehide') f.listeners.get('pagehide')!()
    if (action === 'unmount') f.destroy()
    held.release(); await f.drain()
    assert.equal(f.counters().libraryReads, reads + (action === 'continue' ? 2 : 1))
    if (action === 'dataset') assert.equal(f.host.workbenchLibrary.state.value.datasetId, id(45))
    f.noWrites()
  })
})

test('SETTINGS_FIRST_READ_RECOVERY 原未知mutation/pending只保留不重发，解除pending也需新的真实Core事件', async t => {
  const f = await fixture(t, { initialReadFailure: true, rootPresent: false, jobs: [] }); await f.enter('settings')
  const original = { command: 'library.rename', payload: { commandId: id(72), libraryId: rootId, name: '原确认意图' } }
  const operation = { commandId: id(72), kind: 'library.rename', state: 'unknown', libraryIds: [rootId], message: null }
  f.host.workbenchLibrary.originals.value = [structuredClone(original)]; f.host.workbenchLibrary.operations.value = [structuredClone(operation)]
  assert.equal(f.host.workbenchLibrary.pending.value, true)
  const reads = f.counters().libraryReads
  f.coreEvent('core.ready'); f.coreEvent('core.health'); await f.drain()
  assert.equal(f.counters().libraryReads, reads)
  assert.deepEqual(f.host.workbenchLibrary.originals.value, [original]); assert.deepEqual(f.host.workbenchLibrary.operations.value, [operation])
  f.host.workbenchLibrary.operations.value = []; f.state.readThrows = false
  await f.drain(); assert.equal(f.counters().libraryReads, reads)
  f.coreEvent('core.health'); await f.drain(); assert.equal(f.counters().libraryReads, reads + 1)
  assert.deepEqual(f.host.workbenchLibrary.originals.value, [original]); assert.equal(f.calls.some(value => value.command === 'library.rename'), false)
  f.noWrites()
})

test('SETTINGS_FIRST_READ_RECOVERY 已有管理库状态时保留真实读取错误，ready/health不得扩成后台全量刷新', async t => {
  const f = await fixture(t, { rootPresent: false, jobs: [] }); await f.enter('settings')
  const before = f.host.workbenchLibrary.state.value
  f.state.readThrows = true; await f.host.workbenchLibrary.read()
  assert.equal(f.host.workbenchLibrary.readFailed.value, true); assert.equal(f.host.workbenchLibrary.state.value, before)
  const reads = f.counters().libraryReads
  f.coreEvent('core.ready'); f.coreEvent('core.health'); await f.drain()
  assert.equal(f.counters().libraryReads, reads); assert.equal(f.host.workbenchLibrary.state.value, before)
  assert.notEqual(f.host.workbenchLibrary.error.value, ''); f.noWrites()
})


const scanPages = (f: Awaited<ReturnType<typeof fixture>>) => f.calls.filter(value => value.command === 'localScan.page').length

test('SCAN_STATUS_READ_RECOVERY 已loaded墙首次roots/page失败无job和timer，真实ready过早失败后health完整成功才清红', async t => {
  for (const failure of ['roots','page'] as const) await t.test(failure, async sub => {
    const f = await fixture(sub, { total: 7, phase: 'completed' })
    if (failure === 'roots') f.state.rootsFailures = 1; else f.state.pageFailures = 1
    await f.enter()
    assert.equal(f.pages.localLibrary.snapshot.value.loaded, true)
    assert.match(f.host.scanStatus(), /尚未确认/u); assert.equal(f.host.observations().length, 0); assert.equal(f.timers.size, 0)
    assert.equal(f.host.attemptedRoots().length, 0, '失败只读发现不得占住root资格')
    const queries = f.galleryQueries.length
    f.state.pageFailures = 1; f.coreEvent('core.ready'); await f.drain()
    assert.match(f.host.scanStatus(), /尚未确认/u); assert.equal(f.host.observations().length, 0); assert.equal(f.timers.size, 0)
    const held = f.hold('nextPage'); f.coreEvent('core.health'); await held.entered
    assert.match(f.host.scanStatus(), /尚未确认/u, '受理重试不能在尚未返回完整分页/get时先清红')
    held.release(); await f.drain()
    assert.equal(f.host.scanStatus(), ''); assert.equal(f.host.workbenchLibrary.notice.value, '')
    assert.equal(f.host.observations()[0]?.job.jobId, jobId); assert.equal(f.host.observations()[0]?.finished, true)
    assert.equal(f.timers.size, 0); assert.equal(f.galleryQueries.length, queries, '扫描状态恢复不能刷新已健康封面墙')
    const pages = scanPages(f)
    for (let pass = 0; pass < 8; pass++) { f.coreEvent('core.health'); await f.drain() }
    assert.equal(scanPages(f), pages); assert.equal(f.galleryQueries.length, queries); assert.equal(f.counters().maxScanPages, 1); f.noWrites()
  })
})

test('SCAN_STATUS_READ_RECOVERY 同代失败最多补两次，重复health不轮询，新Core代才重新取得资格', async t => {
  const f = await fixture(t, { total: 7, phase: 'completed' }); f.state.pageFailures = 100; await f.enter()
  const original = scanPages(f)
  f.coreEvent('core.ready'); await f.drain()
  for (let pass = 0; pass < 8; pass++) { f.coreEvent('core.health'); await f.drain() }
  assert.equal(scanPages(f), original + 2); assert.match(f.host.scanStatus(), /尚未确认/u); assert.equal(f.timers.size, 0)
  f.coreEvent('core.ready'); await f.drain(); assert.equal(scanPages(f), original + 3)
  assert.equal(f.counters().maxScanPages, 1); f.noWrites()
})

test('SCAN_STATUS_READ_RECOVERY 等原flight真正settle，健康完成零补读，失败尾部才消费真实health令牌', async t => {
  for (const failed of [false,true]) await t.test(failed ? '原flight失败' : '原flight健康完成', async sub => {
    const f = await fixture(sub, { total: 7, phase: 'completed' })
    f.coreEvent('core.ready'); await f.drain() // home中仅建立真实Core代，后面的旧flight与health同代。
    f.state.pageFailures = 1; await f.enter()
    f.state.pageFailures = failed ? 1 : 0
    const held = f.hold('nextPage'), original = f.host.observeInitialScan(); await held.entered
    const started = scanPages(f)
    f.coreEvent('core.health'); f.coreEvent('core.health'); await nextTick()
    assert.equal(scanPages(f), started); assert.equal(f.counters().maxScanPages, 1)
    assert.match(f.host.scanStatus(), /尚未确认/u)
    held.release(); await original; await f.drain()
    assert.equal(f.host.scanStatus(), '')
    assert.equal(scanPages(f), started + (failed ? 3 : 2), '完整成功发现仍需原head/200页/末head三个证明；健康在途不再另读一套')
    assert.equal(f.counters().maxScanPages, 1); assert.equal(f.counters().maxGets, 1); f.noWrites()
  })
})

test('SCAN_STATUS_READ_RECOVERY 离页/换dataset/pagehide/unmount/原Core撤销后，等待旧flight的令牌不启动新读', async t => {
  for (const action of ['leave','dataset','pagehide','unmount','generation'] as const) await t.test(action, async sub => {
    const f = await fixture(sub, { total: 7, phase: 'completed' }); f.state.pageFailures = 1; await f.enter()
    f.state.pageFailures = 1; const held = f.hold('nextPage'), original = f.host.observeInitialScan(); await held.entered
    f.coreEvent('core.ready'); f.coreEvent('core.health'); const started = scanPages(f)
    if (action === 'leave') { f.currentView.value = 'home'; f.pages.localLibrary.deactivate() }
    if (action === 'dataset') { f.state.datasetId = id(45); f.state.rootPresent = false; f.host.workbenchLibrary.state.value = { datasetId: id(45), revision: 'new', libraries: [], scanConcurrency: 12 } }
    if (action === 'pagehide') f.listeners.get('pagehide')!()
    if (action === 'unmount') f.destroy()
    if (action === 'generation') f.coreEvent('core.health', 'starting')
    held.release(); await original; await f.drain()
    assert.equal(scanPages(f), started); assert.equal(f.timers.size, 0)
    if (action === 'dataset') assert.equal(f.host.workbenchLibrary.state.value.datasetId, id(45))
    f.noWrites()
  })
})

test('SCAN_STATUS_READ_RECOVERY 缺第二root的发现证明时，另一root正常timer不能清红，health补齐原job后才清', async t => {
  const f = await fixture(t, { total: 7 }); await f.enter()
  assert.equal(f.host.observations().length, 1); assert.equal(f.timers.size, 1)
  const secondRoot: contracts.LocalRootView = { ...root, root: { ...root.root, id: id(80), sourceRootId: id(81) } }
  const secondJob = job('running', { jobId: id(82), libraryRootId: id(80), sourceRootId: id(81) })
  f.state.extraRoot = secondRoot; f.setRows([job(), secondJob]); f.state.pageFailures = 1
  await f.host.observeInitialScan(); await f.drain()
  assert.match(f.host.scanStatus(), /尚未确认/u); assert.equal(f.host.observations().length, 1)
  await f.tick()
  assert.match(f.host.scanStatus(), /尚未确认/u, '仅既有root成功get不能替缺root清未确认提示')
  f.coreEvent('core.ready'); await f.drain()
  assert.equal(f.host.scanStatus(), ''); assert.equal(f.host.observations().length, 2)
  assert.ok(f.host.observations().some((value: { job: contracts.ScanJobRecord }) => value.job.jobId === secondJob.jobId))
  assert.equal(f.counters().maxScanPages, 1); f.noWrites()
})

test('SCAN_STATUS_READ_RECOVERY 原get未确认不凭完整发现页清红，后续全部当前观察成功才清', async t => {
  const f = await fixture(t, { total: 7 }); f.state.pageFailures = 1; await f.enter()
  f.state.getFailures = 1; f.coreEvent('core.ready'); await f.drain()
  assert.equal(f.host.observations().length, 1); assert.ok(f.host.observations()[0].failures > 0); assert.match(f.host.scanStatus(), /尚未确认/u)
  f.coreEvent('core.health'); await f.drain()
  assert.equal(f.host.scanStatus(), ''); assert.equal(f.host.observations()[0].failures, 0); f.noWrites()
})

test('SCAN_STATUS_READ_RECOVERY 只清本观察提示，Source离线与真实failed任务仍由原presentation显示红状态', async t => {
  for (const failure of ['offline','failed'] as const) await t.test(failure, async sub => {
    const f = await fixture(sub, { total: 7, phase: failure === 'offline' ? 'completed' : 'running' })
    if (failure === 'offline') f.state.availability = 'SOURCE_ROOT_OFFLINE'
    else { f.state.phase = 'failed'; f.state.failureCode = 'SCAN_READ_FAILED'; f.setRows([job('failed', { failureCode: 'SCAN_READ_FAILED' })]) }
    f.state.pageFailures = 1; await f.enter(); assert.match(f.host.scanStatus(), /尚未确认/u)
    f.coreEvent('core.ready'); await f.drain(); assert.equal(f.host.scanStatus(), '')
    const presentation = localLibraryScanPresentation({ roots: [{ ...root, availability: f.state.availability }], rootsLoaded: true, jobs: f.host.scanJobs(), hasMusic: true })
    assert.equal(presentation.rows.length, 1); assert.equal(presentation.rows[0]!.phase, failure === 'offline' ? 'offline' : 'failed')
    assert.match(presentation.rows[0]!.message, failure === 'offline' ? /源目录离线/u : /扫描未完成/u); f.noWrites()
  })
})

test('SCAN_STATUS_READ_RECOVERY 原未知mutation/pending不消费不重发，其它notice与原意图保留，解锁也要新真实Core事件', async t => {
  const f = await fixture(t, { total: 7, phase: 'completed' }); f.state.pageFailures = 1; await f.enter()
  const original = { command: 'library.rename', payload: { commandId: id(72), libraryId: rootId, name: '原确认意图' } }
  const operation = { commandId: id(72), kind: 'library.rename', state: 'unknown', libraryIds: [rootId], message: null }
  f.host.workbenchLibrary.originals.value = [structuredClone(original)]; f.host.workbenchLibrary.operations.value = [structuredClone(operation)]
  f.host.workbenchLibrary.notice.value = '原未知操作提示'
  const pages = scanPages(f); assert.equal(f.host.workbenchLibrary.pending.value, true)
  f.coreEvent('core.ready'); f.coreEvent('core.health'); await f.drain()
  assert.equal(scanPages(f), pages); assert.match(f.host.scanStatus(), /尚未确认/u)
  assert.deepEqual(f.host.workbenchLibrary.originals.value, [original]); assert.deepEqual(f.host.workbenchLibrary.operations.value, [operation])
  f.host.workbenchLibrary.operations.value = []; await f.drain(); assert.equal(scanPages(f), pages)
  f.coreEvent('core.health'); await f.drain(); assert.equal(f.host.scanStatus(), '')
  assert.equal(f.host.workbenchLibrary.notice.value, '原未知操作提示'); assert.deepEqual(f.host.workbenchLibrary.originals.value, [original])
  assert.equal(f.calls.some(value => value.command === 'library.rename'), false); f.noWrites()
})


async function loadedRootsSession(t: TestContext) {
  const scope = effectScope(), errorText = '目录状态暂时无法读取'
  let available = false, reads = 0, active = 0, maxActive = 0, trackReads = 0
  let held: ReturnType<typeof deferred> | undefined
  const forbidden = async (): Promise<never> => { throw new Error('本例禁止写入、扫描、播放和曲目详情。') }
  const api: contracts.LocalLibraryPublicApi = {
    async queryLocalLibraryTracks(query) { trackReads++; return { ...query, items: [], total: 0, hasMore: false } },
    async listLocalLibraryRoots() {
      reads++; active++; maxActive = Math.max(maxActive, active)
      const succeeded = available, waiting = held; held = undefined
      try { if (waiting) { waiting.enter(); await waiting.promise }; if (!succeeded) throw new Error('合成目录NOT_READY'); return [root] }
      finally { active-- }
    },
    async getLocalLibraryPlaybackTarget() { return null }, getLocalLibraryTrackDetail: forbidden, overrideLocalLibraryMetadata: forbidden,
    playLocalLibraryTrack: forbidden, chooseLocalLibraryRoot: forbidden, chooseLocalRelocationCandidates: forbidden, confirmLocalRelocation: forbidden,
    relinkLocalLibraryRoot: forbidden, localLibraryScan: forbidden, listLocalLibraryTracks: forbidden, getLocalLibraryAsset: forbidden, getLocalLibraryMetadata: forbidden,
  }
  const session = scope.run(() => useLocalLibrary({ api, getSelectedZone: () => undefined, play: forbidden }))!
  t.after(() => { held?.release(); session.dispose(); scope.stop() })
  await session.activate({ deferTrackReads: true })
  assert.match(session.rootsError.value, new RegExp(errorText, 'u')); assert.equal(reads, 1)
  const f = await fixture(t, { total: 7, localSession: session }); await f.enter()
  assert.equal(f.pages.localLibrary.snapshot.value.loaded, true)
  return { ...f, session, countersRoots: () => ({ reads, maxActive, trackReads }),
    available: (value: boolean) => { available = value }, holdRoots: () => { const gate = deferred(); held = gate; t.after(() => gate.release()); return gate } }
}

test('LOCAL_ROOTS_READ_RECOVERY 已loaded专辑墙的独立目录错误由真实health补读一次，健康后不重读整墙', async t => {
  const f = await loadedRootsSession(t), pages = f.galleryQueries.length
  f.available(true); f.coreEvent('core.health'); await f.drain()
  assert.equal(f.countersRoots().reads, 2, '修前state.loaded会直接跳过，实际目录read不会发生')
  assert.equal(f.session.rootsError.value, ''); assert.equal(f.session.rootsLoaded.value, true); assert.deepEqual(f.session.roots.value, [root])
  for (let event = 0; event < 8; event++) f.coreEvent('core.health')
  await f.drain(); assert.equal(f.countersRoots().reads, 2); assert.equal(f.galleryQueries.length, pages)
  assert.equal(f.countersRoots().trackReads, 0); f.noWrites()
})

test('LOCAL_ROOTS_READ_RECOVERY health在途单飞，失败每Core代最多两读，新代才重新取得预算', async t => {
  const f = await loadedRootsSession(t), pages = f.galleryQueries.length
  const held = f.holdRoots(); f.coreEvent('core.health'); await held.entered
  for (let event = 0; event < 8; event++) f.coreEvent('core.health')
  assert.equal(f.countersRoots().reads, 2); assert.equal(f.countersRoots().maxActive, 1)
  held.release(); await f.drain()
  assert.equal(f.countersRoots().reads, 3); assert.match(f.session.rootsError.value, /目录状态暂时无法读取/u)
  for (let event = 0; event < 8; event++) { f.coreEvent('core.health'); await f.drain() }
  assert.equal(f.countersRoots().reads, 3, '原首读之外，同Core代最多消费两次事件补读')
  f.available(true); f.coreEvent('core.ready'); await f.drain()
  assert.equal(f.countersRoots().reads, 4); assert.equal(f.session.rootsError.value, '')
  assert.equal(f.countersRoots().maxActive, 1); assert.equal(f.galleryQueries.length, pages); assert.equal(f.countersRoots().trackReads, 0); f.noWrites()
})

test('LOCAL_ROOTS_READ_RECOVERY 切页或销毁后迟到成功不清原错误、不发布旧目录且不消费排队health', async t => {
  for (const action of ['leave', 'unmount'] as const) await t.test(action, async sub => {
    const f = await loadedRootsSession(sub), pages = f.galleryQueries.length, originalError = f.session.rootsError.value
    f.available(true); const held = f.holdRoots(); f.coreEvent('core.health'); await held.entered
    f.coreEvent('core.health'); f.coreEvent('core.health')
    if (action === 'leave') { f.currentView.value = 'home'; f.pages.localLibrary.deactivate(); f.session.suspend() }
    else { f.destroy(); f.session.dispose() }
    held.release(); await f.drain()
    assert.equal(f.countersRoots().reads, 2); assert.equal(f.session.rootsError.value, originalError)
    assert.equal(f.session.rootsLoaded.value, false); assert.deepEqual(f.session.roots.value, [])
    assert.equal(f.galleryQueries.length, pages); assert.equal(f.countersRoots().trackReads, 0); f.noWrites()
  })
})
