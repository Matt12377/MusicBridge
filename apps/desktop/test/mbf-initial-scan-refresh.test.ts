import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { effectScope, nextTick, ref, watch } from 'vue'
import * as contracts from '@music-bridge/contracts'
import { useLocalWorkbenchLibrary } from '../src/renderer/src/composables/application/local-library-workbench/library.js'
import { useLocalAlbumBrowserPages } from '../src/renderer/src/composables/application/local-library-browser/useLocalAlbumBrowser.js'

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
  const bindingStart = source.indexOf('const workbenchLibrary = useLocalWorkbenchLibrary('), bindingEnd = source.indexOf('\nconst workbenchPorts', bindingStart)
  const start = source.indexOf('// 首扫原任务观察开始：'), end = source.indexOf('// 首扫原任务观察结束。', start)
  const install = '\ninstallInitialScanObservationLifecycle()\n', installed = source.indexOf(install)
  assert.ok(bindingStart >= 0 && bindingEnd > bindingStart && start >= 0 && end > start, '必须执行App原绑定和完整接线区段')
  assert.ok(installed > source.indexOf('\n  currentView, sidebar,'), '正式注册必须位于原currentView初始化之后')
  const body = `${source.slice(bindingStart, bindingEnd)}\n${source.slice(start, end)}${source.slice(installed, installed + install.length)}\nreturn { workbenchLibrary, refreshLocalBrowserViews, refreshLocalLibraryFromWorkbench,
    flush:()=>initialScanWork??Promise.resolve(), observations:()=>[...initialScanObservations.values()], budgets:()=>initialScanDiscoveryBudgets.map(value=>({...value})),
    epoch:()=>initialScanEpoch, timer:()=>initialScanTimer };`
  return ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
}
async function fixture(t: TestContext, options: { jobs?: contracts.ScanJobRecord[]; rootPresent?: boolean; phase?: contracts.ScanJobRecord['phase']; total?: number; drainTail?: boolean } = {}) {
  const currentView = ref('home'), scope = effectScope(), mounts: (() => void)[] = [], unmounts: (() => void)[] = []
  const timers = new Map<number, () => void>(), listeners = new Map<string, () => void>(), gates: ReturnType<typeof deferred>[] = []
  const calls: { command: string; payload: any }[] = [], galleryQueries: contracts.LocalAlbumQuery[] = []
  let nextTimer = 0, maxTimers = 0, activeGets = 0, maxGets = 0, libraryReads = 0, trackRefreshes = 0, invalidations = 0
  let drainTail: (() => void) | undefined
  const state = { datasetId: dataset, rootPresent: options.rootPresent ?? true, phase: options.phase ?? 'running', total: options.total ?? 0,
    snapshotId: null as string | null, rootRevision: '1', readThrows: false, nextRead: undefined as ReturnType<typeof deferred> | undefined,
    nextGet: undefined as ReturnType<typeof deferred> | undefined, pageTotalsChange: false }
  let rows = options.jobs ?? [job(state.phase)]
  const readback = (): contracts.LocalLibraryManagementReadback => ({ datasetId: state.datasetId, revision: String(libraryReads), scanConcurrency: 12,
    libraries: state.rootPresent ? [{ libraryId: rootId, label: '合成新目录', role: 'catalog', online: true, watching: false, latestSnapshotId: state.snapshotId,
      totalAlbums: state.total, totalTracks: state.total, scanState: state.phase === 'completed' ? 'complete' : state.phase === 'pending' ? 'queued' : state.phase }] : [] })
  let importCommand: string | null = null
  const api = {
    async listLocalLibraryRoots() { return state.rootPresent ? [{ ...root, root: { ...root.root, revision: state.rootRevision } }] : [] },
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
        const total = rows.length + (state.pageTotalsChange ? calls.filter(value => value.command === command).length : 0)
        const padded = [...rows, ...Array.from({ length: total - rows.length }, (_, index) => job('completed', { jobId: id(50000 + index), libraryRootId: id(99) }))]
        return { ...payload, total, items: padded.slice(payload.offset, payload.offset + payload.limit), hasMore: payload.offset + payload.limit < total }
      }
      if (command === 'localScan.receipt') return payload.commandId === importCommand ? { commandId: importCommand, jobId, operation: 'start', fingerprint: 'a'.repeat(64), result: job('pending', { jobRevision: '1' }) } : null
      if (command === 'localScan.get') {
        assert.equal(payload.jobId, jobId, '只查询匹配本次目录/来源/修订的原job')
        activeGets++; maxGets = Math.max(maxGets, activeGets)
        const frozen = job(state.phase), held = state.nextGet; state.nextGet = undefined
        try { if (held) { held.enter(); await held.promise }; return frozen } finally { activeGets-- }
      }
      throw new Error('禁止新增扫描、恢复或批处理：' + command)
    },
  }
  const modelApi: contracts.LocalAlbumReadPort = {
    async queryAlbums(request) {
      galleryQueries.push(structuredClone(request))
      const items: contracts.LocalAlbumSummary[] = Array.from({ length: state.total }, (_, index) => ({ id: `first-scan-album-${index}`, kind: 'source-directory', rootId,
        editionId: null, title: '合成扫描专辑 ' + index, artists: ['合成作者'], year: null, versionLabel: null, trackCount: 1, representativeTrackId: id(100 + index),
        revision: String(state.total + 1), artworkAvailable: false, artworkState: 'missing', statuses: ['missing-artwork'] }))
      const counts = Object.fromEntries(['all', ...contracts.LOCAL_ALBUM_STATUSES].map(filter => [filter, filter === 'all' || filter === 'missing-artwork' ? state.total : 0])) as contracts.LocalAlbumFilterCounts
      return { ...request, items: items.slice(request.offset, request.offset + request.limit), total: items.length, hasMore: request.offset + request.limit < items.length, counts }
    },
    async queryAlbumTracks() { throw new Error('本例不打开详情') }, async getArtwork() { throw new Error('本例不冒充实际IMG解码') },
  }
  const localLibrary = { maintenanceLocked: ref(false), refresh: async () => { trackRefreshes++ } }, workbenchLyrics = { pending: ref(false) }
  const storage = new Map<string, string>()
  const window = { musicBridge: api, localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value) } },
    addEventListener: (name: string, callback: () => void) => { listeners.set(name, callback) }, removeEventListener: (name: string) => { listeners.delete(name) } }
  const setTimeout = (callback: () => void, delay: number) => { assert.equal(delay, 1500); const timer = ++nextTimer; timers.set(timer, callback); maxTimers = Math.max(maxTimers, timers.size); return timer }
  const clearTimeout = (timer: number | undefined) => { if (timer !== undefined) timers.delete(timer) }
  let pages!: ReturnType<typeof useLocalAlbumBrowserPages>, host: any
  scope.run(() => {
    pages = useLocalAlbumBrowserPages({ api: modelApi })
    const wrap = (page: typeof pages.localLibrary) => ({ ...page, invalidateArtwork: async () => { invalidations++; await page.invalidateArtwork() } })
    const parameters = ['window', 'watch', 'onMounted', 'onUnmounted', 'currentView', 'localWorkbenchDto', 'useLocalWorkbenchLibrary', 'localLibrary', 'workbenchLyrics', 'albumBrowser', 'coverDropBrowser', 'setTimeout', 'clearTimeout']
    // 仅隔离VM拦截原生finally入口，在真实尾微任务中投递请求；不改App区段或替代drain。
    const factory = options.drainTail ? runInNewContext(`(() => {
      const originalFinally = Promise.prototype.finally;
      Promise.prototype.finally = function(callback) { return originalFinally.call(this, () => { beforeDrainFinally(); return callback(); }); };
      return function(${parameters.join(',')}) { ${sourceBlock()} };
    })()`, { beforeDrainFinally: () => drainTail?.() }) : new Function(...parameters, sourceBlock())
    host = factory(
      window, watch, (callback: () => void) => mounts.push(callback), (callback: () => void) => unmounts.push(callback), currentView, contracts, useLocalWorkbenchLibrary,
      localLibrary, workbenchLyrics, wrap(pages.localLibrary), wrap(pages.coverDrop), setTimeout, clearTimeout)
  })
  let destroyed = false
  const destroy = () => { if (destroyed) return; destroyed = true; for (const callback of unmounts) callback(); host.workbenchLibrary.dispose(); scope.stop() }
  const drain = async () => { for (let pass = 0; pass < 3; pass++) { await nextTick(); await host.flush() } }
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
  const tick = async () => { assert.equal(timers.size, 1, '只允许一个待执行观察timer'); const [key, callback] = [...timers][0]!; timers.delete(key); callback(); await drain() }
  const hold = (kind: 'nextRead' | 'nextGet') => { const gate = deferred(); gates.push(gate); state[kind] = gate; return gate }
  const noWrites = () => assert.equal(calls.some(value => ['localScan.start', 'localScan.resume', 'localScan.prepareBatch', 'localScan.commitBatch', 'library.snapshot.retry', 'library.snapshot.load'].includes(value.command)), false)
  return { host, pages, state, currentView, calls, galleryQueries, timers, listeners, drain, enter, tick, hold, destroy, noWrites,
    counters: () => ({ maxTimers, maxGets, libraryReads, trackRefreshes, invalidations }), setRows: (value: contracts.ScanJobRecord[]) => { rows = value },
    onDrainTail: (callback: () => void) => { drainTail = callback } }
}

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
  assert.equal(f.counters().maxTimers, 1); assert.equal(f.counters().maxGets, 1)
  for (let attempt = 0; attempt < 6; attempt++) await f.tick()
  assert.equal(f.timers.size, 0); assert.equal(f.host.workbenchLibrary.notice.value, ''); f.noWrites()
})

test('INITIAL_SCAN_REFRESH legacy目标位于中间分页，运行中进入普通墙并停留自然更新真实model与库计数', async t => {
  const rows = Array.from({ length: 650 }, (_, index) => job('completed', { jobId: id(1000 + index), libraryRootId: id(99) }))
  rows[250] = job(); rows[640] = job('completed', { jobId: id(6000), sourceRootId: id(98) }); rows[645] = job('completed', { jobId: id(6001), rootRevision: '2' })
  const f = await fixture(t, { jobs: rows }); await f.enter()
  assert.deepEqual(f.calls.filter(value => value.command === 'localScan.page' && value.payload.limit === 200).map(value => value.payload.offset), [600, 400, 200])
  assert.equal(f.pages.localLibrary.snapshot.value.total, 0); assert.equal(f.host.observations()[0].job.jobId, jobId)
  f.state.phase = 'completed'; f.state.total = 7
  await f.tick()
  assert.equal(f.currentView.value, 'local-library'); assert.equal(f.pages.localLibrary.snapshot.value.items.length, 7)
  assert.equal(f.host.workbenchLibrary.state.value.libraries[0].totalAlbums, 7)
  f.state.snapshotId = id(8)
  for (let count = 0; count < 6; count++) await f.tick()
  assert.equal(f.host.workbenchLibrary.state.value.libraries[0].latestSnapshotId, id(8))
  assert.equal(f.host.observations()[0].settleAttempts, 6); assert.equal(f.timers.size, 0)
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
  assert.equal(f.host.workbenchLibrary.state.value.libraries[0].totalAlbums, 0)
  assert.equal(f.host.observations()[0].observedSnapshot, null)
  assert.equal(f.host.workbenchLibrary.notice.value, '', 'busy不是用户故障')
  oldRead.release(); await old; await f.drain()
  assert.equal(f.host.workbenchLibrary.state.value.libraries[0].totalAlbums, 0, '旧read返回的是受理时旧事实')
  f.state.readThrows = true; await f.tick()
  assert.equal(f.host.observations()[0].observedSnapshot, null); assert.notEqual(f.host.workbenchLibrary.error.value, '')
  f.state.readThrows = false; await f.tick()
  assert.equal(f.host.workbenchLibrary.state.value.libraries[0].totalAlbums, 7)
  assert.equal(f.host.observations()[0].observedSnapshot, id(9)); assert.equal(f.host.observations()[0].finished, false)
  for (let count = 2; count < 6; count++) await f.tick()
  assert.equal(f.timers.size, 0); assert.equal(f.host.observations()[0].settleAttempts, 6); f.noWrites()
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
    const budget = f.host.budgets()
    for (let attempt = 1; attempt <= 6; attempt++) {
      await Promise.all([f.host.refreshLocalBrowserViews(), f.host.refreshLocalBrowserViews()]); await f.drain(); await f.tick()
      assert.equal(f.host.observations()[0].settleAttempts, attempt); assert.deepEqual(f.host.budgets(), budget)
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
    await f.host.refreshLocalBrowserViews(); await f.drain(); assert.deepEqual(f.host.budgets(), [budget]); assert.equal(f.timers.size, 0); f.noWrites()
  })
})
