import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { computed, effectScope, nextTick, reactive, ref, watch } from 'vue'
import type { PlaybackEventProtocolAck } from '@music-bridge/contracts'
import type { MusicBridgePublicApi } from '../src/preload/api.js'
import { useRendererPreparation } from '../src/renderer/src/composables/application/useRendererPreparation.js'
import { usePageJourney } from '../src/renderer/src/composables/application/usePageJourney.js'
import { useRoonBrowse } from '../src/renderer/src/composables/application/useRoonBrowse.js'
import { useAggregatedSearch } from '../src/renderer/src/composables/application/useAggregatedSearch.js'
import { useNeteaseLibrary } from '../src/renderer/src/composables/application/useNeteaseLibrary.js'

const turn = () => new Promise<void>(resolve => setImmediate(resolve))
const ack = (coreInstanceId: string): PlaybackEventProtocolAck => ({ protocol: 'compact-v1', coreInstanceId })

test('准备期仅暂存最新播放代次，放行一次且不重试旧启动', () => {
  const preparation = useRendererPreparation(), accepted: Array<PlaybackEventProtocolAck | undefined> = []
  const accept = (value?: PlaybackEventProtocolAck) => { accepted.push(value) }
  preparation.acceptPlaybackReady(ack('旧代'), accept)
  preparation.acceptPlaybackReady(ack('当前代'), accept)
  assert.equal(preparation.ready.value, false)
  assert.deepEqual(accepted, [])
  preparation.observeNotice({ code: 'STARTUP_VERIFYING', message: '正在核验已保存的音乐库。' })
  assert.equal(preparation.message.value, '正在核验已保存的音乐库。')
  assert.equal(preparation.release(accept), true)
  assert.equal(preparation.release(accept), false)
  assert.deepEqual(accepted, [ack('当前代')])
  preparation.acceptPlaybackReady(ack('恢复代'), accept)
  assert.deepEqual(accepted, [ack('当前代'), ack('恢复代')])
})

test('准备失败持续可见，丢弃早到播放代次；迟到成功不能重新放行业务', async () => {
  const preparation = useRendererPreparation()
  let accepted = 0
  preparation.acceptPlaybackReady(ack('失败代'), () => { accepted++ })
  preparation.observeNotice({ code: 'STARTUP_FAILED', message: '合成失败' })
  await turn()
  assert.equal(preparation.failed.value, true)
  assert.match(preparation.message.value, /准备未完成/u)
  assert.equal(preparation.release(() => { accepted++ }), false)
  assert.equal(accepted, 0)
  assert.equal(preparation.ready.value, false)
  preparation.observeNotice({ code: 'STARTUP_PREPARING', message: '迟到准备' })
  assert.match(preparation.message.value, /准备未完成/u)
})

test('实际App启动先等getAppInfo，准备期间不初始化歌词或读取其他业务', async () => {
  const source = await readFile(new URL('../src/renderer/src/App.vue', import.meta.url), 'utf8')
  const start = source.indexOf('  initialize: async read => {') + '  initialize: '.length
  const body = source.slice(start, source.indexOf('\n  onInitializationError:', start)).trim().replace(/,$/u, '')
  let reject!: (error: Error) => void
  const pending = new Promise<never>((_resolve, fail) => { reject = fail })
  const calls: string[] = [], result: { initialize?: (read: (request: () => Promise<unknown>) => Promise<{ active: true; value: unknown }>) => Promise<void> } = {}
  runInNewContext(ts.transpileModule('result.initialize = ' + body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    result, window: { musicBridge: { getAppInfo: () => { calls.push('info'); return pending } } },
    playback: { initializeLocalLyricsMatch: () => { calls.push('lyrics') } },
  })
  const work = result.initialize!(async request => ({ active: true, value: await request() }))
  await turn(); assert.deepEqual(calls, ['info'])
  reject(new Error('合成启动失败'))
  await assert.rejects(work, /合成启动失败/u)
  assert.deepEqual(calls, ['info'])
})

test('实际App早到Core和授权事件只更新准备事实，不抢跑领域加载', async () => {
  const source = await readFile(new URL('../src/renderer/src/App.vue', import.meta.url), 'utf8')
  const start = source.indexOf('  onCoreEvent: event => {') + '  onCoreEvent: '.length
  const body = source.slice(start, source.indexOf('\n  initialize:', start)).trim().replace(/,$/u, '')
  const preparation = useRendererPreparation(), accepted: unknown[] = [], coreState = ref<unknown>(null)
  const result: { event?: (value: unknown) => void; auth?: () => unknown } = {}
  runInNewContext(ts.transpileModule('result.event = ' + body + '; result.auth = () => preparingAuthState', {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, { result, preparation, desktopReadReady: preparation.ready, coreState, diagnosticNotice: ref(null), preparingAuthState: undefined,
    playback: { acceptPlaybackReady: (value: unknown) => { accepted.push(value) } } })
  const state = { runtime: 'ready', roon: 'disconnected', provider: 'missing', activeStreamCount: 0, activePlaybackPresent: false }
  result.event!({ event: 'core.ready', payload: { state, playbackEvents: ack('当前代') } })
  result.event!({ event: 'auth.changed', payload: { state: { status: 'authorized' } } })
  result.event!({ event: 'diagnostic.notice', payload: { code: 'STARTUP_VERIFYING', message: '正在核验已保存的音乐库。' } })
  assert.deepEqual(accepted, [])
  assert.deepEqual(coreState.value, state)
  assert.deepEqual(result.auth!(), { status: 'authorized' })
  assert.equal(preparation.ready.value, false)
  assert.equal(preparation.message.value, '正在核验已保存的音乐库。')
})

test('Core和授权已就绪但桌面读口未放行时，网易云资料不发请求且不消耗首次加载', async t => {
  const preparation = useRendererPreparation(), reads: string[] = []
  const empty = { items: [], offset: 0, limit: 20, total: 0, hasMore: false }
  const api = {
    getAccountState: async () => { reads.push('account'); return { status: 'unavailable' } },
    getLikedTracks: async () => { reads.push('liked'); return empty },
    getUserPlaylists: async () => { reads.push('playlists'); return [] },
    getDailyRecommendations: async () => { reads.push('daily'); return { dayKey: '2026-11-01', tracks: [] } },
  } as unknown as MusicBridgePublicApi
  const library = useNeteaseLibrary({ api, canReadData: () => preparation.ready.value, getCoreRuntime: () => 'ready', getRemoteStatus: () => 'ready',
    getView: () => 'settings', onMatchTracks: () => {}, onPlaylistSwitch: () => {}, onPlaylistReady: () => {}, onResetPrivate: () => {},
    onError: () => {}, accountMessage: () => '合成账户错误', dailyMessage: () => '合成推荐错误', libraryErrorKind: () => 'generic' })
  t.after(library.dispose)
  library.applyInitialAuthState({ status: 'authorized' })
  library.loadAuthorizedLibraryWhenReady()
  await library.loadAccountState()
  await turn(); assert.deepEqual(reads, [])
  preparation.release(() => {})
  library.loadAuthorizedLibraryWhenReady(); library.loadAuthorizedLibraryWhenReady()
  await turn()
  assert.deepEqual(reads.sort(), ['account', 'daily', 'liked', 'playlists'])
})

test('准备期可以连续导航，放行只读取当前可见Roon页面', async t => {
  const preparation = useRendererPreparation(), reads: string[] = []
  const empty = { items: [], offset: 0, limit: 24, total: 0, hasMore: false }
  const api = {
    listRoonAlbums: async () => { reads.push('albums'); return empty },
    listRoonArtists: async () => { reads.push('artists'); return empty },
    listRoonGenres: async () => { reads.push('genres'); return empty },
    listRoonPlaylists: async () => { reads.push('playlists'); return empty },
  } as unknown as MusicBridgePublicApi
  let journey!: ReturnType<typeof usePageJourney>
  const browse = useRoonBrowse({ api, formatError: () => '合成读取失败', onError: () => {}, onToast: () => {},
    getView: () => journey.currentView.value, onDetailOpening: () => {}, onDetailReady: () => {}, onNavigateSource: () => {}, onPlayTrack: () => {} })
  const search = useAggregatedSearch({ api, getZoneId: () => undefined, getScrollTop: () => 0, scrollTo: () => {}, classifyError: () => 'generic',
    onResetSearchOrigin: () => {}, onInvalidateRoonDetails: () => {} })
  journey = usePageJourney({ browse, search, canReadData: () => preparation.ready.value,
    library: { hasLikedItems: () => false, isPlaylistReady: () => false, getPlaylistScrollTop: () => 0, setPlaylistScrollTop: () => {},
      loadLiked: async () => { reads.push('liked') }, loadPlaylists: async () => { reads.push('netease-playlists') }, loadPlaylist: async () => { reads.push('playlist') } },
    onPlayRoonTrack: () => {}, onCloseInspector: () => {}, onClearActionError: () => {} })
  t.after(() => { journey.dispose(); browse.dispose(); search.dispose() })
  for (const type of ['roon-albums', 'roon-artists', 'collection', 'recording', 'roon-genres'] as const) journey.navigateSource({ type })
  journey.navigate('settings')
  journey.navigateSource({ type: 'roon-albums' })
  assert.equal(journey.currentView.value, 'roon-albums')
  assert.equal(journey.sidebar.activeSource.value.type, 'roon-albums')
  await turn(); assert.deepEqual(reads, [])
  preparation.release(() => {})
  browse.refreshVisibleRoonCollection()
  await turn()
  assert.deepEqual(reads, ['albums'])
})

test('实际Catalog组件准备期保存最新查询，放行只恢复当前页面一次', async t => {
  const source = await readFile(new URL('../src/renderer/src/components/catalog/CatalogWorkspace.vue', import.meta.url), 'utf8')
  const script = source.slice(source.indexOf('>') + 1, source.indexOf('</script>')).replace(/^import[^\n]*\n/gmu, '')
  const scope = effectScope(), reads: string[] = []
  t.after(() => scope.stop())
  const model = { artistSource: ref<'local' | 'roon'>('local'), artistQuery: ref(''), detail: ref(null), category: ref('all'), bindingOpen: ref(false),
    library: { items: [], loading: false }, activateWorkspace() {}, suspendWorkspace() {}, stopArtists() {}, closeDetail() {},
    loadArtists: async (query: string) => { reads.push('artists:' + query) }, resumeSearch: () => { reads.push('search:当前查询') } }
  const props = reactive({ mode: 'artists' as 'artists' | 'search', readReady: false, model })
  // Vue组件props不会解包model内部Ref，夹具同样保留原model对象。
  const actualProps = new Proxy(props, { get(target, key) { return key === 'model' ? model : Reflect.get(target, key) } })
  const result: { changeQuery?: (value: string) => void } = {}
  scope.run(() => runInNewContext(ts.transpileModule(script + '\nresult.changeQuery = changeArtistQuery', {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, { result, computed, ref, watch, nextTick, onUnmounted: () => {}, defineProps: () => actualProps,
    withDefaults: (value: unknown) => value, defineEmits: () => () => {}, setTimeout, clearTimeout, catalogKinds: ['artists', 'albums', 'tracks'] }))
  result.changeQuery!('最初查询'); result.changeQuery!('最新查询')
  await nextTick(); assert.deepEqual(reads, [])
  props.readReady = true
  await nextTick(); assert.deepEqual(reads, ['artists:最新查询'])
  props.readReady = true
  await nextTick(); assert.deepEqual(reads, ['artists:最新查询'])
  props.readReady = false; props.mode = 'search'
  await nextTick(); assert.deepEqual(reads, ['artists:最新查询'])
  props.readReady = true
  await nextTick(); assert.deepEqual(reads, ['artists:最新查询', 'search:当前查询'])
})
