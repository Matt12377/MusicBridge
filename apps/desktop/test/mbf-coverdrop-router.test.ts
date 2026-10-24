import assert from 'node:assert/strict'
import test from 'node:test'
import { ref } from 'vue'
import type { MusicBridgePublicApi } from '../src/preload/api.js'
import { mountVueSfc } from './support/mbf-vue-host.js'
import { usePageJourney } from '../src/renderer/src/composables/application/usePageJourney.js'
import { useRoonBrowse } from '../src/renderer/src/composables/application/useRoonBrowse.js'
import { useAggregatedSearch } from '../src/renderer/src/composables/application/useAggregatedSearch.js'
import { useLocalLibraryWorkbench } from '../src/renderer/src/composables/application/local-library-workbench/controller.js'

function journeyFixture(t: import('node:test').TestContext, beforeLeave?: Parameters<typeof usePageJourney>[0]['beforeLeave'], canLeaveRecording = () => true) {
  const api = {} as MusicBridgePublicApi
  let journey!: ReturnType<typeof usePageJourney>
  const browse = useRoonBrowse({ api, formatError: () => '合成读取失败', onError: () => {}, onToast: () => {}, getView: () => journey.currentView.value, onDetailOpening: view => journey.setDetailView(view), onDetailReady: (view, source) => journey.setDetailView(view, source), onNavigateSource: source => journey.navigateSource(source), onPlayTrack: () => {} })
  const search = useAggregatedSearch({ api, getZoneId: () => undefined, getScrollTop: () => 0, scrollTo: () => {}, classifyError: () => 'generic', onResetSearchOrigin: () => {}, onInvalidateRoonDetails: () => {} })
  journey = usePageJourney({ browse, search, beforeLeave, canLeaveRecording, library: { hasLikedItems: () => true, isPlaylistReady: () => true, getPlaylistScrollTop: () => 0, setPlaylistScrollTop: () => {}, loadLiked: async () => {}, loadPlaylists: async () => {}, loadPlaylist: async () => {} }, onPlayRoonTrack: () => {}, onCloseInspector: () => {}, onClearActionError: () => {} })
  t.after(() => { journey.dispose(); browse.dispose(); search.dispose() })
  return { journey, search }
}
test('实际Sidebar只新增一个独立CoverDrop，原本地音乐与设置入口仍在同一永久侧栏', async t => {
  const events: unknown[] = []
  const host = await mountVueSfc(t, new URL('../src/renderer/src/components/sidebar/MusicSidebar.vue', import.meta.url).pathname, { expanded: true, activeSource: { type: 'local-library' }, searchQuery: '', playlists: [], playlistState: 'ready', sourceScrollTop: 0, settingsActive: false, onNavigate: (v: unknown) => events.push(v) })
  const buttons = host.all().filter(v => v.props['data-sidebar-source'] === 'coverdrop')
  assert.equal(buttons.length, 1); await host.dispatch(buttons[0], 'onClick')
  assert.deepEqual(events, [{ type: 'coverdrop' }]); assert.match(host.text(), /本地音乐/u); assert.match(host.text(), /设置/u)
})
test('Sidebar Settings Search共用Save门禁，阻断时不改搜索或来源，恢复精确最后意图', async t => {
  const pending = ref(false), model = useLocalLibraryWorkbench({ ports: {}, saveParticipants: [{ pending, locked: ref(false), save: async () => { pending.value = false; return true }, discard: () => { pending.value = false; return true } }] }); t.after(model.dispose)
  const { journey, search } = journeyFixture(t, (_destination, resume) => model.requestLeave(resume))
  journey.navigateSource({ type: 'coverdrop' }); pending.value = true
  journey.navigate('settings'); assert.equal(journey.currentView.value, 'coverdrop')
  journey.updateSearchQuery('合成新搜索'); assert.equal(search.searchQuery.value, ''); assert.equal(journey.sidebar.activeSource.value.type, 'coverdrop')
  model.continueEditing(); assert.equal(journey.currentView.value, 'coverdrop')
  journey.navigateSource({ type: 'local-library' }); await model.saveBeforeLeave()
  assert.equal(journey.currentView.value, 'local-library'); assert.equal(journey.sidebar.activeSource.value.type, 'local-library'); assert.equal(search.searchQuery.value, '')
  journey.navigateSource({ type: 'coverdrop' }); journey.enterNowPlaying(); journey.exitNowPlaying(); assert.equal(journey.currentView.value, 'coverdrop')
})
test('CoverDrop准入不绕原Recording不能离开的围栏', t => {
  let extraGuard = 0
  const { journey } = journeyFixture(t, () => { extraGuard++; return true }, () => false)
  journey.navigateSource({ type: 'recording' }); const before = extraGuard
  journey.navigateSource({ type: 'coverdrop' }); journey.updateSearchQuery('合成查询')
  assert.equal(journey.currentView.value, 'recording'); assert.equal(extraGuard, before)
})

// 使用原Journey及原Save守门；这里仅消费合成浏览描述符，不读取工作库或派发写入。
test('CoverDrop独立页面先导航再完整捕获，Save和Discard只恢复冻结意图一次', async t => {
  const { createCoverDropPageEntry } = await import('../src/renderer/src/composables/application/local-library-browser/useLocalAlbumBrowser.js')
  for (const decision of ['save', 'discard'] as const) {
    const pending = ref(false), locked = ref(false), calls: string[] = []
    let release!: () => void
    const finishing = new Promise<void>(resolve => { release = resolve })
    const model = useLocalLibraryWorkbench({ ports: {}, saveParticipants: [{ pending, locked,
      save: async () => { calls.push('save'); await finishing; pending.value = false; return true },
      discard: async () => { calls.push('discard'); await finishing; pending.value = false; return true } }] })
    t.after(model.dispose)
    let entry!: ReturnType<typeof createCoverDropPageEntry>
    const { journey } = journeyFixture(t, (destination, resume) => entry.beforeLeave(destination, resume))
    const captured: import('../src/renderer/src/composables/application/local-library-browser/useLocalAlbumBrowser.js').CoverDropPageIntent[] = []
    entry = createCoverDropPageEntry({ getView: () => journey.currentView.value, navigate: () => journey.navigateSource({ type: 'coverdrop' }),
      requestLeave: model.requestLeave, close: () => { calls.push('close'); return model.close() }, open: intent => { assert.equal(journey.currentView.value, 'coverdrop'); calls.push('capture'); captured.push(intent) } })
    t.after(entry.dispose)
    journey.navigateSource({ type: 'local-library' }); calls.length = 0; pending.value = true
    const source = { action: 'overview' as const, albums: [{ albumKey: 'album-complete', rootId: 'root-original', revision: 'revision-original', kind: 'source-directory' as const, title: '完整专辑', artists: ['合成艺人'], editionId: null, representativeTrackId: null }] }
    entry.request(source); source.albums[0]!.title = '浏览列表已改变'
    assert.equal(journey.currentView.value, 'local-library'); assert.equal(captured.length, 0)
    const departure = decision === 'save' ? model.saveBeforeLeave() : model.discardBeforeLeave()
    await Promise.resolve(); assert.equal(captured.length, 0); assert.equal(journey.currentView.value, 'local-library')
    release(); await departure
    assert.equal(journey.currentView.value, 'coverdrop'); assert.equal(captured.length, 1); assert.equal(captured[0]!.albums[0]!.title, '完整专辑')
    assert.deepEqual(calls, [decision, 'close', 'capture']); assert.equal(Object.isFrozen(captured[0]!.albums), true)
    await model.saveBeforeLeave(); assert.equal(captured.length, 1)
    journey.navigateSource({ type: 'local-library' }); journey.navigateSource({ type: 'coverdrop' })
    assert.equal(captured.length, 1, '普通返回只恢复页面，不自动清候选或再次捕获')
  }
})
test('CoverDrop继续编辑不捕获，UNKNOWN不离开，后续普通导航不重放旧意图', async t => {
  const { createCoverDropPageEntry } = await import('../src/renderer/src/composables/application/local-library-browser/useLocalAlbumBrowser.js')
  const pending = ref(false), locked = ref(false), model = useLocalLibraryWorkbench({ ports: {}, saveParticipants: [{ pending, locked, save: async () => { pending.value = false; return true }, discard: () => { pending.value = false; return true } }] })
  t.after(model.dispose)
  let entry!: ReturnType<typeof createCoverDropPageEntry>, captures = 0
  const { journey } = journeyFixture(t, (destination, resume) => entry.beforeLeave(destination, resume))
  entry = createCoverDropPageEntry({ getView: () => journey.currentView.value, navigate: () => journey.navigateSource({ type: 'coverdrop' }), requestLeave: model.requestLeave, close: model.close, open: () => { captures++ } }); t.after(entry.dispose)
  journey.navigateSource({ type: 'local-library' }); pending.value = true; entry.request({ action: 'overview', albums: [] }); model.continueEditing()
  assert.equal(captures, 0); assert.equal(journey.currentView.value, 'local-library')
  locked.value = true; entry.request({ action: 'overview', albums: [] }); await model.saveBeforeLeave(); await model.discardBeforeLeave()
  assert.equal(captures, 0); assert.equal(journey.currentView.value, 'local-library'); assert.equal(model.leavePrompt.value, true)
  model.continueEditing(); pending.value = locked.value = false
  journey.navigateSource({ type: 'coverdrop' }); assert.equal(captures, 0, '解除未知后普通Sidebar不自动执行旧整理意图')
})
test('CoverDrop页面式工作台复用七业务页和原Save守门，默认调用仍为dialog', async t => {
  const model = useLocalLibraryWorkbench({ ports: {} }); t.after(model.dispose); model.openLibrary()
  const file = new URL('../src/renderer/src/components/library/local-workbench/LocalLibraryWorkbench.vue', import.meta.url).pathname
  const page = await mountVueSfc(t, file, { model, presentation: 'page' })
  assert.equal(page.all().some(node => node.type === 'dialog'), false)
  assert.ok(page.all().some(node => node.type === 'section' && String(node.props.class).includes('is-page')))
  for (const label of ['专辑信息', '封面', '智能解析', 'CUE 分轨', '信息与文件整理', '歌词', '整个音乐库']) assert.ok(page.text().includes(label))
  const dialog = await mountVueSfc(t, file, { model })
  assert.ok(dialog.all().some(node => node.type === 'dialog' && node.props.open === true))
})

/** 一套原组合式模型与合成有限DTO；仅组件层，不启动Owner/DB/Native。 */
async function coverDropSfcRegressionFixture(t: import('node:test').TestContext, change?: { pending: import('vue').Ref<boolean>; locked: import('vue').Ref<boolean>; finish: Promise<void> }, browserApi?: Partial<import('../src/renderer/src/composables/application/local-library-browser/types.js').LocalAlbumBrowserApi>) {
  const [{ effectScope }, browserModule, workspaceModule, lyricsModule, sessionModule, dto] = await Promise.all([
    import('vue'), import('../src/renderer/src/composables/application/local-library-browser/useLocalAlbumBrowser.js'),
    import('../src/renderer/src/composables/application/local-library-workbench/library.js'), import('../src/renderer/src/composables/application/local-library-workbench/lyrics.js'),
    import('../src/renderer/src/composables/application/useLocalLibrary.js'), import('@music-bridge/contracts'),
  ])
  const id = (n: number) => `55555555-5555-4555-8555-${String(n).padStart(12, '0')}`
  const datasetId = id(1), A = id(2), B = id(3), originalCaptureId = 'sfc-whole-original', calls: { command: string; payload: unknown }[] = []
  const managed: import('@music-bridge/contracts').LocalLibraryManagementReadback = { datasetId, revision: 'library-revision-1', scanConcurrency: 12,
    libraries: [A, B].map(libraryId => ({ libraryId, label: libraryId === A ? '合成库A' : '合成库B', role: 'catalog', online: true, watching: false, latestSnapshotId: 'snapshot-' + libraryId, totalAlbums: 1, totalTracks: 2, scanState: 'complete' })) }
  const settings: import('@music-bridge/contracts').LocalNameSettings = { revision: 'name-revision-1', backend: 'ollama', ollama: { endpoint: 'http://127.0.0.1:11434', model: 'synthetic-model' }, vllm: { endpoint: 'http://127.0.0.1:8000/v1', model: 'synthetic-vllm' }, cloud: { endpoint: 'https://example.invalid/v1', model: 'synthetic-cloud', keyConfigured: false } }
  let issued = 0
  const workspaceApi: import('../src/renderer/src/composables/application/local-library-workbench/library.js').LocalLibraryWorkspaceApi = {
    async localLibraryManagement<C extends import('@music-bridge/contracts').LocalLibraryManagementMainCommand>(command: C, input525: import('@music-bridge/contracts').LocalLibraryManagementMainPayloads[C]): Promise<import('@music-bridge/contracts').LocalLibraryManagementMainResults[C]> {
      if (command === 'library.import.cancel') throw new Error('此SFC夹具未prepare目录，不能虚构取消闭口')
      const payload = input525 as import('@music-bridge/contracts').LocalLibraryManagementPayloads[import('@music-bridge/contracts').LocalLibraryManagementCommand]
      calls.push({ command, payload: structuredClone(payload) }); let result: unknown
      if (command === 'library.read') result = managed
      else if (command === 'library.capture') { const libraryIds = [...(payload as import('@music-bridge/contracts').LocalLibraryManagementMainPayloads['library.capture']).libraryIds]; result = { datasetId, captureId: originalCaptureId, libraryIds, revision: managed.revision, lyricsLibraries: libraryIds.map((libraryId, index) => ({ datasetId, libraryId, captureId: 'sfc-lyrics-original-' + index })) } }
      else if (command === 'library.ai.start') result = { jobId: (payload as import('@music-bridge/contracts').LocalLibraryManagementMainPayloads['library.ai.start']).commandId, captureId: originalCaptureId, kind: 'ai', state: 'queued', totalAlbums: 2, processedAlbums: 0, succeededAlbums: 0, failedAlbums: 0, offset: 0, items: [] }
      else throw new Error('此回归不得派发其它业务命令: ' + command)
      assert.equal(dto.isLocalLibraryManagementResult(command, result, payload), true); return structuredClone(result) as import('@music-bridge/contracts').LocalLibraryManagementMainResults[C]
    },
    async localNameSettings<C extends import('@music-bridge/contracts').LocalNameSettingsCommand>(command: C, payload: import('@music-bridge/contracts').LocalNameSettingsPayloads[C]): Promise<import('@music-bridge/contracts').LocalNameSettingsResults[C]> {
      assert.equal(command, 'name.settings.read'); assert.equal(dto.isLocalNameSettingsPayload(command, payload), true)
      return structuredClone(settings) as import('@music-bridge/contracts').LocalNameSettingsResults[C]
    },
  }
  const scope = effectScope(), workspace = scope.run(() => workspaceModule.useLocalWorkbenchLibrary({ api: workspaceApi, makeCommandId: () => `sfc-original-${++issued}` }))!
  t.after(() => { scope.stop(); workspace.dispose() }); await workspace.read(); await workspace.readNameSettings(); workspace.selectLibraries([A, B])
  const summary: import('@music-bridge/contracts').LocalAlbumSummary = { id: id(4), kind: 'source-directory', rootId: B, editionId: null, title: '合成B专辑', artists: ['合成艺人'], year: null, versionLabel: null, trackCount: 2, representativeTrackId: id(10), revision: 'album-b-1', artworkAvailable: false, artworkState: 'missing', statuses: ['missing-artwork', 'missing-lyrics'] }
  assert.equal(dto.isLocalAlbumSummary(summary), true)
  const track = (n: number): import('@music-bridge/contracts').LocalAlbumTrackItem => {
    const metadata = { title: `合成曲目${n}`, artist: '合成艺人', album: summary.title, year: '', disc: '1', track: String(n) }
    return { facts: { track: { id: id(9 + n), assetId: id(20 + n), selectionRevision: '1', segment: null }, asset: { id: id(20 + n), libraryRootId: B, sourceRootId: id(30), rootRevision: '1', fileRevision: '1', locationRevision: '1', sampleFrames: null, timebaseHz: null }, metadata: { raw: metadata, override: null, effective: { ...metadata } }, versionTokens: [], editions: [], fileParameters: null }, disc: 1, trackNumber: n, sequence: n, statuses: ['missing-lyrics'] }
  }
  const queries: import('@music-bridge/contracts').LocalAlbumQuery[] = []
  const browser = scope.run(() => browserModule.useLocalAlbumBrowser({ api: {
    async queryAlbums(request) { queries.push(structuredClone(request)); const candidates = request.rootId === A ? [] : [summary], values = candidates.filter(value => !request.query || value.title.includes(request.query));
      const counts = Object.fromEntries([['all', values.length], ...dto.LOCAL_ALBUM_STATUSES.map(status => [status, values.filter(value => value.statuses.includes(status)).length])]) as unknown as import('@music-bridge/contracts').LocalAlbumFilterCounts
      const items = values.slice(request.offset, request.offset + request.limit); return { ...request, total: values.length, hasMore: request.offset + items.length < values.length, counts, items: structuredClone(items) } },
    async queryAlbumTracks(request) { assert.equal(request.albumKey, summary.id); assert.equal(request.rootId, B); const all = [track(1), track(2)], items = all.slice(request.offset, request.offset + request.limit); return { ...request, album: structuredClone(summary), items, total: all.length, hasMore: request.offset + items.length < all.length } },
    async getArtwork(request) { return { ...request, image: null } },
    ...browserApi,
  } }))!
  const unused = async (): Promise<never> => { throw new Error('此组件回归不允许派发曲目写入、播放或源授权') }
  const sessionApi: import('../src/renderer/src/composables/application/useLocalLibrary.js').LocalLibraryOptions['api'] = {
    listLocalLibraryRoots: async () => [], listLocalLibraryTracks: async page => ({ ...page, items: [], total: 0, hasMore: false }),
    queryLocalLibraryTracks: unused, getLocalLibraryTrackDetail: unused, getLocalLibraryPlaybackTarget: unused,
    overrideLocalLibraryMetadata: unused, playLocalLibraryTrack: unused, chooseLocalLibraryRoot: unused,
    chooseLocalRelocationCandidates: unused, confirmLocalRelocation: unused, relinkLocalLibraryRoot: unused,
    localLibraryScan: unused, getLocalLibraryAsset: unused, getLocalLibraryMetadata: unused,
  }
  const session = sessionModule.useLocalLibrary({ api: sessionApi, getSelectedZone: () => undefined, play: unused })
  const lyrics = lyricsModule.useLocalWorkbenchLyrics({ api: { async localLibraryLyrics() { throw new Error('此回归不创建歌词操作') } } })
  t.after(() => { session.dispose(); lyrics.dispose() })
  const model = useLocalLibraryWorkbench({ ports: { capabilities: { read: { available: true } }, aiBackends: [{ id: 'ollama', label: '合成已装配后端', availability: { available: true } }] },
    saveParticipants: change ? [{ pending: change.pending, locked: change.locked, save: async () => { await change.finish; change.pending.value = false; return true }, discard: async () => { await change.finish; change.pending.value = false; return true } }] : [] })
  t.after(model.dispose)
  const props = { session, browser, workspace, model, lyrics, playbackState: null }, file = new URL('../src/renderer/src/components/library/CoverDropView.vue', import.meta.url).pathname
  return { A, B, summary, props, browser, workspace, model, queries, calls, issued: () => issued, file,
    async openDetail() { workspace.selectLibraries([B]); await browser.activate(); await browser.setScope({ query: '合成B', rootId: B, filter: 'missing-lyrics' }); await browser.openAlbum(summary, { scrollTop: 725 });
      const album = { albumId: summary.id, rootId: B, revision: summary.revision, title: summary.title, artist: summary.artists[0]!, trackIds: [id(10), id(11)], trackCount: 2 }
      await model.open({ action: 'overview', albums: [album] }, { datasetId, snapshotId: 'sfc-read-original', albums: [{ album, capture: { albumId: album.albumId, readToken: 'sfc-album-original' }, availability: 'online', issues: [], currentArtwork: null, cueSheets: [] }] }) },
  }
}

test('CoverDrop真实remount保多库选择中的原B读范围和查询筛选位置详情', async t => {
  const f = await coverDropSfcRegressionFixture(t)
  await t.test('原页面离开', async leaf => {
    const host = await mountVueSfc(leaf, f.file, f.props)
    f.workspace.selectLibraries([f.A, f.B]); await f.browser.setScope({ query: '合成B', rootId: f.B, filter: 'missing-lyrics' }); await f.browser.openAlbum(f.summary, { scrollTop: 725 }); await host.settle()
    assert.deepEqual(f.workspace.selectedLibraryIds.value, [f.A, f.B]); assert.equal(f.browser.snapshot.value.rootId, f.B)
    assert.deepEqual(f.browser.snapshot.value.selectedAlbum, f.summary, '卸载前必须确实打开原B专辑，不能以两份空详情证明恢复')
  })
  const original = f.browser.snapshot.value; assert.equal(original.active, false); assert.equal(original.rootId, f.B)
  await t.test('同模型重新挂载', async leaf => {
    const host = await mountVueSfc(leaf, f.file, f.props), current = f.browser.snapshot.value
    assert.deepEqual(f.workspace.selectedLibraryIds.value, [f.A, f.B]); assert.equal(current.rootId, f.B)
    assert.equal(current.query, original.query); assert.equal(current.filter, original.filter); assert.equal(current.scrollTop, original.scrollTop)
    assert.deepEqual(current.selectedAlbum, original.selectedAlbum); assert.deepEqual(current.tracks, original.tracks); assert.deepEqual(current.returnTarget, original.returnTarget)
    assert.ok(host.text().includes('合成库B'))
  })
})
test('CoverDrop真实page关闭dirty后Save或Discard续接原close和browser返回各一次，继续及UNKNOWN零关闭', async t => {
  for (const decision of ['save', 'discard', 'continue', 'unknown'] as const) await t.test(decision, async leaf => {
    const pending = ref(false), locked = ref(false); let release!: () => void
    const finish = new Promise<void>(resolve => { release = resolve }), f = await coverDropSfcRegressionFixture(leaf, { pending, locked, finish })
    await f.openDetail(); const host = await mountVueSfc(leaf, f.file, f.props)
    let closed = 0, browserClosed = 0, returned = 0
    const originalClose = f.model.close, originalBrowserClose = f.browser.closeAlbum
    f.model.close = () => { const result = originalClose(); if (result) closed++; return result }
    f.browser.closeAlbum = (...args) => { browserClosed++; return originalBrowserClose(...args) }
    const heading = host.all().find(node => node.props.id === 'coverdrop-heading'); assert.ok(heading)
    const originalFocus = heading.focus; heading.focus = options => { returned++; originalFocus(options) }
    pending.value = true; if (decision === 'unknown') locked.value = true; await host.settle()
    const close = host.all().find(node => node.props['aria-label'] === '关闭专辑详情'); assert.ok(close)
    await host.dispatch(close, 'onClick'); assert.equal(f.model.leavePrompt.value, true); assert.equal(closed, 0); assert.equal(browserClosed, 0); assert.equal(returned, 0)
    const button = (label: string) => host.all().find(node => node.type === 'button' && host.text(node) === label)
    if (decision === 'continue') { await host.dispatch(button('继续编辑'), 'onClick'); assert.equal(f.model.leavePrompt.value, false) }
    else if (decision === 'unknown') { assert.equal(button('保存并离开')?.props.disabled, true); assert.equal(button('丢弃待保存选择并离开')?.props.disabled, true); release(); await f.model.saveBeforeLeave(); await f.model.discardBeforeLeave(); await host.settle() }
    else { await host.dispatch(button(decision === 'save' ? '保存并离开' : '丢弃待保存选择并离开'), 'onClick'); assert.equal(closed, 0); assert.equal(browserClosed, 0); release(); await host.settle()
      assert.equal(f.model.isOpen.value, false); assert.equal(f.browser.snapshot.value.selectedAlbum, null); assert.equal(closed, 1); assert.equal(browserClosed, 1); assert.equal(returned, 1)
      await f.model.saveBeforeLeave(); await host.settle(); assert.equal(closed, 1); assert.equal(browserClosed, 1); assert.equal(returned, 1)
    }
    if (decision === 'continue' || decision === 'unknown') { assert.equal(f.model.isOpen.value, true); assert.equal(f.browser.snapshot.value.selectedAlbum?.id, f.summary.id); assert.equal(closed, 0); assert.equal(browserClosed, 0); assert.equal(returned, 0); release() }
  })
})
test('CoverDrop多库页面整库AI按钮委托同workspace与配置backend，保完整AB和唯一原命令，锁定不启动', async t => {
  const f = await coverDropSfcRegressionFixture(t), originalStart = f.workspace.startAi, delegates: string[] = []
  f.workspace.startAi = (backend, albums) => { delegates.push(backend); return originalStart(backend, albums) }
  const host = await mountVueSfc(t, f.file, f.props)
  const header = host.all().find(node => String(node.props.class).split(' ').includes('coverdrop-header-actions')); assert.ok(header)
  const button = host.all(header).find(node => node.type === 'button' && host.text(node).includes('解析')); assert.ok(button, '实际多库页面必须有整库AI按钮，不能只留单库右键')
  f.workspace.writing.value = true; await host.settle(); assert.equal(button.props.disabled, true)
  await host.dispatch(button, 'onClick'); assert.equal(f.issued(), 0); assert.equal(f.calls.filter(row => row.command === 'library.capture' || row.command === 'library.ai.start').length, 0)
  f.workspace.writing.value = false; delegates.length = 0; await host.settle(); assert.equal(button.props.disabled, false)
  await host.dispatch(button, 'onClick'); assert.deepEqual(delegates, ['ollama']); assert.deepEqual(f.workspace.selectedLibraryIds.value, [f.A, f.B])
  const captures = f.calls.filter(row => row.command === 'library.capture'), starts = f.calls.filter(row => row.command === 'library.ai.start')
  assert.equal(captures.length, 1); assert.deepEqual(captures[0]!.payload, { libraryIds: [f.A, f.B] }); assert.equal(starts.length, 1); assert.equal(f.issued(), 1)
  assert.deepEqual(starts[0]!.payload, { commandId: 'sfc-original-1', captureId: 'sfc-whole-original', backend: 'ollama', selection: 'missing-cover', albumIds: [] })
  assert.equal(f.workspace.originalJob.value?.payload.commandId, 'sfc-original-1'); assert.deepEqual(f.workspace.capture.value?.libraryIds, [f.A, f.B])
  await host.dispatch(button, 'onClick'); assert.equal(f.issued(), 1); assert.equal(f.calls.filter(row => row.command === 'library.ai.start').length, 1)
})


/** 实际Vue组件消费已验证合成DTO；此处不签Owner、Scanner、Native或真实目录资格。 */
async function coverDropTrackFactsSfcFixture(t: import('node:test').TestContext, cue: boolean) {
  const f = await coverDropSfcRegressionFixture(t)
  await f.openDetail()
  const [dto, { effectScope }, browserModule] = await Promise.all([
    import('@music-bridge/contracts'), import('vue'),
    import('../src/renderer/src/composables/application/local-library-browser/useLocalAlbumBrowser.js'),
  ])
  const items = structuredClone([...f.browser.snapshot.value.tracks])
  assert.equal(items.length, 2)
  const known = items[0]!, unknown = items[1]!
  known.disc = 2; known.trackNumber = 7; known.sequence = 48
  known.facts.metadata = { raw: { title: '来源第七曲', artist: '合成艺人', album: f.summary.title, disc: '2', track: '7' }, override: null,
    effective: { title: '来源第七曲', artist: '合成艺人', album: f.summary.title, disc: '2', track: '7' } }
  known.facts.fileParameters = { container: 'FLAC', codec: 'FLAC', lossless: true, sampleRateHz: 96000, channels: 2,
    bitsPerSample: 24, durationMs: 123000, evidence: 'bounded-parser-reported' }
  unknown.disc = null; unknown.trackNumber = null; unknown.sequence = 49
  unknown.facts.metadata = { raw: { title: '文件名提示 FLAC 24bit 96kHz 第03曲' }, override: null,
    effective: { title: '文件名提示 FLAC 24bit 96kHz 第03曲' } }
  unknown.facts.fileParameters = null
  unknown.facts.asset.sampleFrames = null; unknown.facts.asset.timebaseHz = null
  if (cue) {
    // 最后一帧仍未满60秒；若帧号先经Number，会把此原合法64位范围误显示为1:00。
    known.facts.track.segment = { id: '77777777-7777-4777-8777-000000000001', startFrame: '9007199254740993',
      endFrameExclusive: '9007199257386992', timebaseHz: 44100 }
    known.facts.asset.sampleFrames = '9007199257386993'; known.facts.asset.timebaseHz = 44100
    unknown.facts.asset.sampleFrames = '96000'; unknown.facts.asset.timebaseHz = 48000
  }
  for (const item of items) assert.equal(dto.isLocalAlbumTrackItem(item), true)
  const originalFacts = JSON.stringify(items), readRequests: import('@music-bridge/contracts').LocalAlbumTrackQuery[] = []
  const scope = effectScope(), browser = scope.run(() => browserModule.useLocalAlbumBrowser({ api: {
    async queryAlbums(request) {
      const values = request.rootId !== null && request.rootId !== f.B ? [] : [f.summary]
      const counts = Object.fromEntries([['all', values.length], ...dto.LOCAL_ALBUM_STATUSES.map(status =>
        [status, values.filter(value => value.statuses.includes(status)).length])]) as unknown as import('@music-bridge/contracts').LocalAlbumFilterCounts
      const filtered = values.filter(value => request.filter === 'all' || value.statuses.includes(request.filter)), page = filtered.slice(request.offset, request.offset + request.limit)
      const result = { ...request, total: filtered.length, hasMore: request.offset + page.length < filtered.length, counts, items: structuredClone(page) }
      assert.equal(dto.isLocalAlbumPage(result, request), true); return result
    },
    async queryAlbumTracks(request) {
      readRequests.push(structuredClone(request)); assert.equal(request.albumKey, f.summary.id); assert.equal(request.rootId, f.B)
      const page = items.slice(request.offset, request.offset + request.limit), result = { ...request, album: structuredClone(f.summary),
        items: structuredClone(page), total: items.length, hasMore: request.offset + page.length < items.length }
      assert.equal(dto.isLocalAlbumTrackPage(result, request, f.summary), true); return result
    },
    async getArtwork(request) { return { ...request, image: null } },
  } }))!
  t.after(() => { browser.deactivate(); scope.stop() })
  await browser.activate(); await browser.setScope({ query: '', rootId: f.B, filter: 'missing-lyrics' }); await browser.openAlbum(f.summary)
  const host = await mountVueSfc(t, f.file, { ...f.props, browser })
  const section = host.all().find(node => node.props['aria-label'] === '原捕获的曲目读取'); assert.ok(section)
  const rows = host.all(section).filter(node => node.type === 'li'); assert.equal(rows.length, 2)
  const cell = (index: number, className: string) => {
    const value = host.all(rows[index]!).find(node => String(node.props.class).split(' ').includes(className)); assert.ok(value)
    return host.text(value)
  }
  return { f, host, rows, cell, items, originalFacts, readRequests }
}

test('CoverDrop详情显示Owner原盘号曲序与真实格式时长，缺事实明确未知且不猜文件名', async t => {
  const view = await coverDropTrackFactsSfcFixture(t, false)
  assert.match(view.cell(0, 'coverdrop-track-order'), /盘号 2 · 曲序 7 · 整轨文件/u)
  assert.doesNotMatch(view.cell(0, 'coverdrop-track-order'), /曲序 (?:1|48)(?:\D|$)/u)
  assert.equal(view.cell(0, 'coverdrop-track-format'), 'FLAC · 无损 · 24 bit · 96,000 Hz · 2 声道')
  assert.equal(view.cell(0, 'coverdrop-track-duration'), '2:03')
  assert.match(view.cell(1, 'coverdrop-track-order'), /盘号未知 · 曲序未知/u)
  assert.equal(view.cell(1, 'coverdrop-track-format'), '格式未确认'); assert.equal(view.cell(1, 'coverdrop-track-duration'), '时长未知')
  assert.equal(JSON.stringify(view.items), view.originalFacts)
  assert.ok(view.readRequests.length > 0); assert.ok(view.f.calls.every(row => row.command === 'library.read'))
})

test('CoverDrop详情CUE时长只按原精确帧范围，源文件时长与播放权限不冒段落事实', async t => {
  const view = await coverDropTrackFactsSfcFixture(t, true)
  assert.equal(view.cell(0, 'coverdrop-track-duration'), '0:59'); assert.match(view.cell(0, 'coverdrop-track-order'), /CUE 段落/u)
  assert.doesNotMatch(view.cell(0, 'coverdrop-track-duration'), /2:03|1:00/u)
  assert.equal(view.cell(1, 'coverdrop-track-duration'), '0:02'); assert.equal(view.cell(1, 'coverdrop-track-format'), '格式未确认')
  const cueButtons = view.host.all(view.rows[0]!).filter(node => node.type === 'button' && ['播放', '入队', '下一首'].includes(view.host.text(node)))
  assert.equal(cueButtons.length, 3); assert.ok(cueButtons.every(node => node.props.disabled === true))
  assert.equal(JSON.stringify(view.items), view.originalFacts); assert.ok(view.f.calls.every(row => row.command === 'library.read'))
})

/** 搜索返回只换原 pane；有限合成状态用于核对原选择、歌词与回执没有被清空或另存。 */
function coverDropSearchRetainedState(f: Awaited<ReturnType<typeof coverDropSfcRegressionFixture>>) {
  const browser = f.browser.snapshot.value
  return JSON.stringify({ albums: f.model.albums.value, readback: f.model.readback.value, focusedAlbumId: f.model.focusedAlbumId.value,
    candidates: f.model.artworkCandidates.value, selectedArtworkId: f.model.selectedArtworkId.value, comparisonIds: f.model.comparisonIds.value,
    plan: f.model.plan.value, operations: f.model.operations.value, lyricsScope: f.props.lyrics.scope.value, lyricsSession: f.props.lyrics.session.value,
    libraryIds: f.workspace.selectedLibraryIds.value, rootId: browser.rootId, query: browser.query, filter: browser.filter, scrollTop: browser.scrollTop,
    selectedAlbum: browser.selectedAlbum, selectedAlbumIds: browser.selectedAlbumIds, tracks: browser.tracks, returnTarget: browser.returnTarget })
}
function observeCoverDropSearchDeparture(f: Awaited<ReturnType<typeof coverDropSfcRegressionFixture>>) {
  const calls: string[] = [], save = f.model.savePending, apply = f.model.applyPreview, discard = f.model.discardPending
  const requestLeave = f.model.requestLeave, close = f.model.close, browserClose = f.browser.closeAlbum
  f.model.savePending = () => { calls.push('save'); return save() }
  f.model.applyPreview = () => { calls.push('apply'); return apply() }
  f.model.discardPending = () => { calls.push('discard'); return discard() }
  f.model.requestLeave = resume => { calls.push('requestLeave'); return requestLeave(resume) }
  f.model.close = () => { calls.push('close'); return close() }
  f.browser.closeAlbum = (...args) => { calls.push('browser.close'); return browserClose(...args) }
  return calls
}

test('CoverDrop搜索两个返回均只回原详情，保待保存封面歌词与原计划UNKNOWN且零派写或重捕获', async t => {
  for (const label of ['关闭', '返回详情保存']) for (const unknown of [false, true]) await t.test(label + (unknown ? '·UNKNOWN' : '·待保存'), async leaf => {
    const pending = ref(false), locked = ref(false), f = await coverDropSfcRegressionFixture(leaf, { pending, locked, finish: Promise.resolve() })
    await f.openDetail(); const host = await mountVueSfc(leaf, f.file, f.props)
    const button = (text: string) => host.all().find(node => node.type === 'button' && host.text(node).trim() === text)
    assert.ok(host.all().some(node => String(node.props.class).split(' ').includes('coverdrop-save')))
    await host.dispatch(button('搜索封面'), 'onClick'); assert.equal(f.model.action.value, 'artwork')
    assert.ok(host.all().some(node => node.props['aria-label'] === '封面搜索来源'), 'CoverDrop必须显式采用原四来源Tabs')
    const albumId = f.summary.id, datasetId = f.model.readback.value!.datasetId
    const candidate: import('../src/renderer/src/composables/application/local-library-workbench/types.js').LocalWorkbenchArtworkCandidate = {
      candidateId: 'sfc-return-candidate', albumId, label: '原待保存封面', origin: 'manual', sourceLabel: '合成明确选择',
      previewUrl: 'data:image/jpeg;base64,/9j/', width: 32, height: 32, licenseLabel: '用户提供' }
    const plan: import('../src/renderer/src/composables/application/local-library-workbench/types.js').LocalWorkbenchPlan = {
      kind: 'artwork', scope: 'MB_ONLY', relationship: 'create-on-apply', datasetId, planId: 'sfc-return-plan', revision: '1',
      planHash: 'a'.repeat(64), contextFingerprint: 'b'.repeat(64), expiresAt: '2099-01-01T00:00:00.000Z', albumIds: [albumId], state: 'ready', blockers: [],
      items: [{ itemId: 'sfc-return-item', albumId, label: f.summary.title, changes: [] }] }
    f.model.artworkCandidates.value = [candidate]; f.model.selectedArtworkId.value = candidate.candidateId
    f.model.comparisonIds.value = [candidate.candidateId]; f.model.plan.value = plan
    const lyrics = f.props.lyrics, scope = { datasetId, libraryId: f.B, albumId, captureId: 'sfc-return-lyrics-capture' }
    const lyricCandidate = { candidateId: 'sfc-return-lyrics-candidate', trackId: f.model.albums.value[0]!.trackIds[0]!, source: 'lrclib' as const,
      title: '原待保存歌词', artist: '合成艺人', album: f.summary.title, durationMs: 90000, language: '中文', version: 'original' as const, score: 95 }
    lyrics.bind(scope); lyrics.session.value = { sessionId: 'sfc-return-lyrics-session', scope, state: 'ready', candidates: [lyricCandidate],
      tracks: [{ trackId: lyricCandidate.trackId, title: lyricCandidate.title, presence: 'false', match: 'review',
        candidateIds: [lyricCandidate.candidateId], selectedCandidateId: lyricCandidate.candidateId, sources: [{ source: 'lrclib', state: 'ok' }] }] }
    pending.value = true
    if (unknown) {
      const request = { commandId: 'sfc-return-original-command', datasetId, planId: plan.planId, expectedRevision: plan.revision,
        planHash: plan.planHash, contextFingerprint: plan.contextFingerprint, kind: plan.kind }
      f.model.operations.value = [{ request, plan, state: 'unknown', receipt: { commandId: request.commandId, datasetId, planId: plan.planId,
        planHash: plan.planHash, state: 'unknown', message: '原回执尚未确认', items: [{ itemId: plan.items[0]!.itemId, albumId, label: f.summary.title, state: 'unknown', message: null }] } }]
      locked.value = true
    }
    await host.settle()
    for (const text of ['关闭', '返回详情保存']) {
      const target = button(text); assert.ok(target); assert.ok(target.closest('.workbench-artwork-sidebar'), '返回按钮必须在搜索右栏')
    }
    assert.equal(host.all().some(node => String(node.props.class).split(' ').includes('coverdrop-save')), false)
    assert.equal(host.all().some(node => String(node.props.class).split(' ').includes('coverdrop-lyrics-count')), false)
    assert.equal(button('在 Finder 中显示'), undefined)
    assert.equal(host.all().some(node => String(node.props.class).split(' ').includes('workbench-footer')), false, '搜索slot不得回退共享footer')
    assert.equal(button('保存封面与歌词'), undefined); assert.equal(button('返回专辑浏览'), undefined)
    const before = coverDropSearchRetainedState(f), originalPlan = f.model.plan.value, originalOperations = f.model.operations.value
    const calls = observeCoverDropSearchDeparture(f), reads = f.calls.length, queries = f.queries.length
    f.model.lookingUp.value = true; await host.settle()
    assert.equal(button(label)?.props.disabled, true, '进行中沿原busy禁用返回按钮')
    f.model.lookingUp.value = false; await host.settle(); await host.dispatch(button(label), 'onClick')
    assert.equal(f.model.action.value, 'overview'); assert.equal(f.model.isOpen.value, true); assert.equal(f.model.leavePrompt.value, false)
    assert.equal(pending.value, true); assert.equal(lyrics.pending.value, true); assert.equal(f.model.hasPendingChanges.value, true)
    assert.equal(f.model.plan.value, originalPlan); assert.equal(f.model.operations.value, originalOperations)
    assert.equal(coverDropSearchRetainedState(f), before); assert.deepEqual(calls, []); assert.equal(f.calls.length, reads); assert.equal(f.queries.length, queries)
    const save = host.all().find(node => String(node.props.class).split(' ').includes('coverdrop-save')); assert.ok(save)
    assert.equal(!!save.props.disabled, unknown); assert.ok(button('在 Finder 中显示'))
    assert.ok(host.all().some(node => String(node.props.class).split(' ').includes('coverdrop-lyrics-count')))
    assert.equal(button('返回详情保存'), undefined); assert.equal(button('关闭'), undefined)
  })
})

test('CoverDrop搜索X背景Esc先受busy保护再回详情，同一入口在详情才走原关闭流程', async t => {
  for (const source of ['x', 'backdrop', 'escape'] as const) await t.test(source, async leaf => {
    const f = await coverDropSfcRegressionFixture(leaf); await f.openDetail()
    const host = await mountVueSfc(leaf, f.file, f.props), calls = observeCoverDropSearchDeparture(f)
    const dispatch = async (search: boolean) => {
      if (source === 'x') await host.dispatch(host.all().find(node => node.props['aria-label'] === (search ? '关闭封面搜索' : '关闭专辑详情')), 'onClick')
      else if (source === 'backdrop') await host.dispatch(host.all().find(node => String(node.props.class).split(' ').includes('coverdrop-detail-backdrop')), 'onClick')
      else await host.dispatch(host.all().find(node => node.props['data-testid'] === 'coverdrop-workspace'), 'onKeydown', { key: 'Escape' })
    }
    f.model.setAction('artwork'); f.model.lookingUp.value = true; await host.settle()
    const before = coverDropSearchRetainedState(f), reads = f.calls.length, queries = f.queries.length
    await dispatch(true); assert.equal(f.model.action.value, 'artwork'); assert.equal(f.model.isOpen.value, true); assert.deepEqual(calls, [])
    f.model.lookingUp.value = false; await host.settle(); await dispatch(true)
    assert.equal(f.model.action.value, 'overview'); assert.equal(f.model.isOpen.value, true); assert.equal(f.model.leavePrompt.value, false)
    assert.equal(coverDropSearchRetainedState(f), before); assert.deepEqual(calls, []); assert.equal(f.calls.length, reads); assert.equal(f.queries.length, queries)
    await dispatch(false); assert.equal(f.model.isOpen.value, false); assert.equal(f.browser.snapshot.value.selectedAlbum, null)
    assert.deepEqual(calls, ['requestLeave', 'close', 'browser.close'])
  })
})

test('CoverDrop常驻刷新按钮：正常墙实际点击经原model更新ready换图与missing新图，忙与离页禁用且零扫描', async t => {
  // 完整CoverDrop SFC/原browser模型与合成显示DTO；不证明Chromium解码、Native、实际Source或持久缓存。
  const dto = await import('@music-bridge/contracts')
  let values: import('@music-bridge/contracts').LocalAlbumSummary[] = [], replacing = false, queries = 0
  const requests: import('@music-bridge/contracts').LocalAlbumArtworkRequest[] = [], intents: boolean[] = [], refreshing: Promise<void>[] = []
  const display = (base64: string): import('@music-bridge/contracts').LocalArtworkImage => ({
    original: { mime: 'image/png', bytes: 4, sha256: 'a'.repeat(64), width: 32, height: 32 },
    display: { mime: 'image/jpeg', bytes: 3, sha256: (base64 === '/9j/' ? 'b' : 'c').repeat(64), width: 16, height: 16, dataUrl: `data:image/jpeg;base64,${base64}` },
  })
  const oldImage = display('/9j/'), newImage = display('abcd')
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  t.after(async () => { release(); await Promise.all(refreshing) })
  const f = await coverDropSfcRegressionFixture(t, undefined, {
    queryAlbums: async request => {
      queries++
      const scoped = values.filter(value => request.rootId === null || value.rootId === request.rootId)
        .filter(value => !request.query || value.title.includes(request.query))
      const selected = scoped.filter(value => request.filter === 'all' || value.statuses.includes(request.filter))
      const items = selected.slice(request.offset, request.offset + request.limit)
      const counts = Object.fromEntries([['all', scoped.length], ...dto.LOCAL_ALBUM_STATUSES.map(status => [status, scoped.filter(value => value.statuses.includes(status)).length])]) as unknown as import('@music-bridge/contracts').LocalAlbumFilterCounts
      const reply = { ...request, items, total: selected.length, hasMore: request.offset + items.length < selected.length, counts }
      assert.equal(dto.isLocalAlbumPage(reply, request), true); return reply
    },
    getArtwork: async request => {
      requests.push({ ...request })
      if (request.refresh === true && request.albumKey === 'coverdrop-ready-refresh') await held
      if (request.refresh === true) values = values.map((value): import('@music-bridge/contracts').LocalAlbumSummary => value.id === request.albumKey
        ? { ...value, artworkAvailable: true, artworkState: 'available', statuses: [...value.statuses.filter(status => status !== 'missing-artwork'), ...(value.statuses.includes('has-artwork') ? [] : ['has-artwork' as const])] } : value)
      const reply = { albumKey: request.albumKey, rootId: request.rootId, editionId: request.editionId, representativeTrackId: request.representativeTrackId,
        // 原生Owner提供有界网格副本；本SFC宿主不模拟Chromium位图解码。
        revision: request.revision, image: replacing ? newImage : oldImage, grid: (replacing ? newImage : oldImage).display }
      assert.equal(dto.isLocalAlbumArtworkReply(reply, request), true); assert.equal(Object.hasOwn(reply, 'refresh'), false)
      return reply
    },
  })
  const ready = { ...f.summary, id: 'coverdrop-ready-refresh', title: '合成已缓存专辑', artworkAvailable: true, artworkState: 'available' as const, statuses: ['has-artwork' as const] }
  const missing = f.summary
  values = [ready, missing]
  f.workspace.selectLibraries([f.B]); await f.browser.setScope({ query: '', rootId: f.B, filter: 'all' })
  const host = await mountVueSfc(t, f.file, f.props)
  const header = host.all().find(node => String(node.props.class).split(' ').includes('coverdrop-library-header')); assert.ok(header)
  const button = host.all(header).find(node => node.type === 'button' && node.props['aria-label'] === '刷新 CoverDrop 专辑与封面'); assert.ok(button, '正常有数据且无错误横幅时也必须可达常驻刷新')
  assert.equal(f.browser.snapshot.value.status, 'ready'); assert.equal(f.browser.snapshot.value.total, 2)
  assert.equal(f.browser.snapshot.value.refreshError, ''); assert.equal(f.workspace.error.value, ''); assert.equal(f.model.isOpen.value, false)
  assert.equal(!!button.props.disabled, false); assert.equal(host.text(button).trim(), '刷新')
  assert.equal(f.browser.artworkFor(ready).dataUrl, oldImage.display.dataUrl); assert.equal(f.browser.artworkFor(missing).status, 'missing')
  assert.equal(requests.length, 1); assert.equal(Object.hasOwn(requests[0]!, 'refresh'), false)
  const originalRefresh = f.browser.refresh
  f.browser.refresh = (force = false) => { intents.push(force); const work = originalRefresh(force); refreshing.push(work); return work }
  const beforeQueries = queries
  replacing = true
  await host.dispatch(button, 'onClick')
  assert.deepEqual(intents, [true]); assert.equal(f.browser.snapshot.value.refreshing, true); assert.equal(!!button.props.disabled, true)
  assert.match(host.text(button), /正在刷新/u); assert.equal(queries, beforeQueries, '必须先等本次窗口探测结束再重读首页')
  assert.equal(requests.length, 3); assert.ok(requests.slice(1).every(request => request.refresh === true))
  release(); await Promise.all(refreshing); await host.settle()
  assert.equal(queries, beforeQueries + 1); assert.equal(f.browser.snapshot.value.refreshing, false); assert.equal(!!button.props.disabled, false)
  assert.equal(f.browser.snapshot.value.counts['has-artwork'], 2); assert.equal(f.browser.snapshot.value.counts['missing-artwork'], 0)
  for (const value of values) {
    assert.equal(f.browser.artworkFor(value).status, 'ready'); assert.equal(f.browser.artworkFor(value).dataUrl, newImage.display.dataUrl)
    const card = host.all().find(node => node.props['data-local-album-id'] === value.id); assert.ok(card)
    assert.equal(host.all(card).filter(node => node.type === 'img' && node.props.src === newImage.display.dataUrl).length, 1, '必须由正式CoverDrop子Grid显示本次新src，不能只更新mock字段')
  }
  for (let turn = 0; turn < 3; turn++) await host.settle()
  assert.equal(requests.length, 3); assert.deepEqual(intents, [true])
  assert.equal(f.issued(), 0); assert.ok(f.calls.every(row => row.command === 'library.read'), '点击刷新不能创建scan/confirm或其它写命令')
  f.browser.deactivate(); await host.settle(); assert.equal(!!button.props.disabled, true)
})
