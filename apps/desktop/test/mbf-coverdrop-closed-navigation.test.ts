import assert from 'node:assert/strict'
import test from 'node:test'
import type { LocalLibraryManagementMainCommand, LocalLibraryManagementMainPayloads, LocalLibraryManagementMainResults, LocalLibraryManagementReadback } from '@music-bridge/contracts'
import type { MusicBridgePublicApi } from '../src/preload/api.js'
import { useAggregatedSearch } from '../src/renderer/src/composables/application/useAggregatedSearch.js'
import { usePageJourney } from '../src/renderer/src/composables/application/usePageJourney.js'
import { useRoonBrowse } from '../src/renderer/src/composables/application/useRoonBrowse.js'
import { createCoverDropPageEntry } from '../src/renderer/src/composables/application/local-library-browser/useLocalAlbumBrowser.js'
import { useLocalLibraryWorkbench } from '../src/renderer/src/composables/application/local-library-workbench/controller.js'
import { useLocalWorkbenchLibrary, type LocalLibraryWorkspaceApi } from '../src/renderer/src/composables/application/local-library-workbench/library.js'

// 原Journey、页面入口和两个原工作区模型；API仅返回合成DTO，不启动Owner或界面。
async function navigationFixture(t: test.TestContext, provideOpenState = true) {
  const libraryId = '55555555-5555-4555-8555-000000000002'
  const calls: { command: LocalLibraryManagementMainCommand; payload: unknown }[] = []
  const managed: LocalLibraryManagementReadback = {
    datasetId: '55555555-5555-4555-8555-000000000001', revision: 'navigation-library-1', scanConcurrency: 12,
    libraries: [{ libraryId, label: '合成导航库', role: 'catalog', online: true, watching: false,
      latestSnapshotId: 'synthetic-navigation-snapshot', totalAlbums: 1, totalTracks: 1, scanState: 'complete' }],
  }
  const api: LocalLibraryWorkspaceApi = {
    async localLibraryManagement<C extends LocalLibraryManagementMainCommand>(command: C, payload: LocalLibraryManagementMainPayloads[C]): Promise<LocalLibraryManagementMainResults[C]> {
      calls.push({ command, payload: structuredClone(payload) })
      let result: unknown
      if (command === 'library.read') result = managed
      else if (command === 'library.watch.set') {
        const original = payload as LocalLibraryManagementMainPayloads['library.watch.set']
        result = { commandId: original.commandId, kind: 'library.watch.set', state: 'unknown', libraryIds: [original.libraryId], message: null }
      } else throw new Error('导航回归不允许其它库操作。')
      return structuredClone(result) as LocalLibraryManagementMainResults[C]
    },
    async localNameSettings() { throw new Error('导航回归不读取或写入名称设置。') },
  }
  const workspace = useLocalWorkbenchLibrary({ api, makeCommandId: () => '55555555-5555-4555-8555-000000000003' })
  const model = useLocalLibraryWorkbench({ ports: {}, saveParticipants: [workspace] })
  let journey!: ReturnType<typeof usePageJourney>, entry!: ReturnType<typeof createCoverDropPageEntry>
  let requests = 0, closes = 0, captures = 0
  const departures: string[] = []
  const browseApi = {} as MusicBridgePublicApi
  const browse = useRoonBrowse({ api: browseApi, formatError: () => '合成读取失败', onError: () => {}, onToast: () => {},
    getView: () => journey.currentView.value, onDetailOpening: view => journey.setDetailView(view),
    onDetailReady: (view, source) => journey.setDetailView(view, source), onNavigateSource: source => journey.navigateSource(source), onPlayTrack: () => {} })
  const search = useAggregatedSearch({ api: browseApi, getZoneId: () => undefined, getScrollTop: () => 0, scrollTo: () => {},
    classifyError: () => 'generic', onResetSearchOrigin: () => {}, onInvalidateRoonDetails: () => {} })
  journey = usePageJourney({ browse, search, beforeLeave: (destination, resume) => { departures.push(destination); return entry.beforeLeave(destination, resume) },
    canLeaveRecording: () => true, library: { hasLikedItems: () => true, isPlaylistReady: () => true, getPlaylistScrollTop: () => 0,
      setPlaylistScrollTop: () => {}, loadLiked: async () => {}, loadPlaylists: async () => {}, loadPlaylist: async () => {} },
    onPlayRoonTrack: () => {}, onCloseInspector: () => {}, onClearActionError: () => {} })
  entry = createCoverDropPageEntry({
    getView: () => journey.currentView.value,
    ...(provideOpenState ? { isWorkbenchOpen: () => model.isOpen.value } : {}),
    navigate: () => journey.navigateSource({ type: 'coverdrop' }),
    requestLeave: resume => { requests++; return model.requestLeave(resume) },
    close: () => { closes++; return model.close() },
    open: () => { captures++ },
  })
  t.after(() => { entry.dispose(); journey.dispose(); browse.dispose(); search.dispose(); model.dispose(); workspace.dispose() })
  await workspace.read()
  assert.equal(workspace.error.value, '')
  const unknownWatch = async () => {
    assert.equal(await workspace.watchLibrary(libraryId, true), false)
    assert.equal(workspace.operations.value[0]?.state, 'unknown')
    assert.equal(workspace.originals.value[0]?.command, 'library.watch.set')
    assert.equal(workspace.pending.value, true)
    assert.equal(workspace.locked.value, true)
  }
  return { workspace, model, journey, search, calls, departures, unknownWatch, counts: () => ({ requests, closes, captures }) }
}

test('COVERDROP_CLOSED_NAVIGATION：关闭工作台的共享UNKNOWN不造空弹层，普通导航保留原请求', async t => {
  const f = await navigationFixture(t)
  await f.unknownWatch()
  const operations = structuredClone(f.workspace.operations.value), originals = structuredClone(f.workspace.originals.value)
  const calls = structuredClone(f.calls)
  for (const source of ['local-library', 'coverdrop'] as const) {
    f.journey.navigateSource({ type: source })
    assert.equal(f.journey.currentView.value, source)
  }
  f.journey.navigate('settings')
  assert.equal(f.journey.currentView.value, 'settings')
  f.journey.updateSearchQuery('合成导航查询')
  assert.equal(f.journey.currentView.value, 'search')
  assert.equal(f.search.searchQuery.value, '合成导航查询')
  f.journey.navigateSource({ type: 'local-library' })
  assert.equal(f.journey.currentView.value, 'local-library')
  assert.ok(f.departures.length >= 5, '每次实际Journey导航均进入公开beforeLeave。')
  assert.deepEqual(f.counts(), { requests: 0, closes: 0, captures: 0 })
  assert.equal(f.model.isOpen.value, false)
  assert.equal(f.model.leavePrompt.value, false)
  assert.equal(f.workspace.locked.value, true)
  assert.deepEqual(f.workspace.operations.value, operations)
  assert.deepEqual(f.workspace.originals.value, originals)
  assert.deepEqual(f.calls, calls, '普通导航不查询、重发或清理后台原操作。')
})

test('COVERDROP_CLOSED_NAVIGATION：真实打开的dirty与UNKNOWN继续原离开门', async t => {
  for (const state of ['dirty', 'unknown'] as const) {
    const f = await navigationFixture(t)
    f.model.openLibrary()
    if (state === 'unknown') await f.unknownWatch()
    else f.workspace.scanConcurrency.value = 13
    const calls = structuredClone(f.calls), operations = structuredClone(f.workspace.operations.value)
    f.journey.navigate('settings')
    assert.notEqual(f.journey.currentView.value, 'settings')
    assert.equal(f.model.isOpen.value, true)
    assert.equal(f.model.leavePrompt.value, true)
    assert.deepEqual(f.counts(), { requests: 1, closes: 0, captures: 0 })
    if (state === 'dirty') {
      assert.equal(f.model.leaveLocked.value, false)
      await f.model.discardBeforeLeave()
      assert.equal(f.journey.currentView.value, 'settings')
      assert.equal(f.model.isOpen.value, false)
      assert.equal(f.workspace.scanConcurrency.value, 12)
      assert.deepEqual(f.counts(), { requests: 1, closes: 1, captures: 0 })
    } else {
      assert.equal(f.model.leaveLocked.value, true)
      await f.model.saveBeforeLeave()
      await f.model.discardBeforeLeave()
      assert.notEqual(f.journey.currentView.value, 'settings')
      assert.equal(f.model.isOpen.value, true)
      assert.equal(f.model.leavePrompt.value, true)
      assert.equal(f.workspace.locked.value, true)
      assert.deepEqual(f.workspace.operations.value, operations)
      assert.deepEqual(f.counts(), { requests: 1, closes: 0, captures: 0 })
    }
    assert.deepEqual(f.calls, calls, '原离开门只在明确丢弃草稿时恢复导航，UNKNOWN不派发或丢弃。')
  }
})

test('COVERDROP_CLOSED_NAVIGATION：未提供真实打开态的旧调用方保留原守门', async t => {
  const f = await navigationFixture(t, false)
  await f.unknownWatch()
  const operations = structuredClone(f.workspace.operations.value), calls = structuredClone(f.calls)
  f.journey.navigate('settings')
  assert.notEqual(f.journey.currentView.value, 'settings')
  assert.equal(f.model.isOpen.value, false)
  assert.equal(f.model.leavePrompt.value, true)
  assert.equal(f.workspace.locked.value, true)
  assert.deepEqual(f.counts(), { requests: 1, closes: 0, captures: 0 })
  assert.deepEqual(f.workspace.operations.value, operations)
  assert.deepEqual(f.calls, calls)
})
