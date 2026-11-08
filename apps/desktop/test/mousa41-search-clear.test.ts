import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import type { MusicBridgePublicApi } from '../src/preload/api.js'
import type { SidebarSource } from '../src/renderer/src/components/navigation.js'
import { useAggregatedSearch } from '../src/renderer/src/composables/application/useAggregatedSearch.js'
import { useRoonBrowse } from '../src/renderer/src/composables/application/useRoonBrowse.js'
import { usePageJourney, type PageJourneyOptions } from '../src/renderer/src/composables/application/usePageJourney.js'
import { localArtistItem, roonCatalogItem, type CatalogPage } from '../src/renderer/src/composables/catalog/catalog-presentation.js'
import { useCatalogExperience, type CatalogDataPort } from '../src/renderer/src/composables/catalog/useCatalogExperience.js'

const app = parse(readFileSync(new URL('../src/renderer/src/App.vue', import.meta.url), 'utf8')).descriptor
assert.ok(app.scriptSetup && app.template)
const source = ts.createSourceFile('App.ts', app.scriptSetup.content, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
const empty = (): CatalogPage => ({ items: [], offset: 0, limit: 24, total: 0, hasMore: false, revision: 'synthetic-1' })
const item = localArtistItem({ id: `local-artist:${'a'.repeat(64)}`, name: '合成搜索艺人', source: 'local', albumCount: 1, trackCount: 1 })
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }

function appSearchPort(catalog: ReturnType<typeof useCatalogExperience>): NonNullable<PageJourneyOptions['catalogSearch']> {
  const journey = source.statements.flatMap(node => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [])
    .find(node => ts.isIdentifier(node.name) && node.name.text === 'journey')
  assert.ok(journey?.initializer && ts.isCallExpression(journey.initializer))
  const options = journey.initializer.arguments[0]
  assert.ok(options && ts.isObjectLiteralExpression(options))
  const property = options.properties.find(node => ts.isPropertyAssignment(node) && node.name.getText(source) === 'catalogSearch')
  assert.ok(property && ts.isPropertyAssignment(property))
  const script = ts.transpileModule(`return (${property.initializer.getText(source)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return new Function('catalog', script)(catalog)
}

function fixture(t: test.TestContext, options: { search?: CatalogDataPort['search']; remoteDetail?: CatalogDataPort['remoteDetail']; beforeLeave?: PageJourneyOptions['beforeLeave'] } = {}) {
  let reads = 0
  const catalog = useCatalogExperience({
    search: async (...args) => { reads++; return options.search ? options.search(...args) : { ...empty(), items: args[1] === 'artists' ? [item] : [] } },
    suggest: async () => [], artists: async () => empty(), artist: async () => ({ artist: item.identity.type === 'local-artist' ? item.identity.value : assert.fail('local artist') }),
    artistAlbums: async () => empty(), artistTracks: async () => empty(), remoteDetail: options.remoteDetail ?? (async () => empty()),
    artistMatches: async () => [], bindArtist: async () => assert.fail('clearing search must not write'),
  })
  const page = { items: [], offset: 0, limit: 20, total: 0, hasMore: false }
  const api = { listRoonAlbums: async () => page, listRoonArtists: async () => page, searchRoonLibrary: async () => page,
    getRoonAlbumTracks: async () => page, searchArtists: async () => page, searchTracks: async () => page, searchAlbums: async () => page,
    checkFavorite: async () => ({ favorite: false }) } as unknown as MusicBridgePublicApi
  let journey!: ReturnType<typeof usePageJourney>
  const browse = useRoonBrowse({ api, formatError: () => '合成读取失败', onError() {}, onToast() {}, getView: () => journey.currentView.value,
    onDetailOpening: view => journey.setDetailView(view), onDetailReady: (view, selected) => journey.setDetailView(view, selected),
    onNavigateSource: selected => journey.navigateSource(selected), onPlayTrack() { assert.fail('no playback during clear') } })
  const legacy = useAggregatedSearch({ api, getZoneId: () => undefined, getScrollTop: () => 0, scrollTo() {}, classifyError: () => 'generic',
    onResetSearchOrigin() { journey.roonSearchOrigin.value = false }, onInvalidateRoonDetails() { browse.invalidateAlbumArtistRequests() } })
  journey = usePageJourney({ browse, search: legacy, localArtistsEnabled: true, catalogSearch: appSearchPort(catalog), beforeLeave: options.beforeLeave,
    library: { hasLikedItems: () => true, isPlaylistReady: () => true, getPlaylistScrollTop: () => 0, setPlaylistScrollTop() {}, async loadLiked() {}, async loadPlaylists() {}, async loadPlaylist() {} },
    onPlayRoonTrack() { assert.fail('no playback during clear') }, onCloseInspector() {}, onClearActionError() {} })
  t.after(() => { journey.dispose(); browse.dispose(); legacy.dispose(); catalog.dispose() })
  // Execute the actual App event expression and functions, not a parallel "correct" test-only handler.
  const expression = app.template!.content.match(/@clear-search="([^"]+)"/u)?.[1]
  assert.ok(expression)
  const functions = source.statements.filter(node => ts.isFunctionDeclaration(node) && ['clearCatalogSearch', 'updateCatalogDraft'].includes(node.name?.text ?? '')).map(node => node.getText(source)).join('\n')
  const eventScript = ts.transpileModule(`const { catalog, currentView, roonSearchOrigin, clearSearch } = context; ${functions}\nreturn () => { ${expression.includes('(') ? expression : `${expression}()`} };`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const event = new Function('context', eventScript)({ catalog, currentView: journey.currentView, roonSearchOrigin: journey.roonSearchOrigin, clearSearch: journey.clearSearch }) as () => void
  const clear = () => { catalog.invalidatePreview(''); event() } // SidebarSearch emits update:modelValue before clear-search.
  const submit = (query: string) => {
    const origin = journey.currentView.value === 'search' || journey.roonSearchOrigin.value ? journey.searchReturnSource.value : journey.sidebar.activeSource.value
    journey.navigate('search', false); journey.discardPageSearch(); journey.searchReturnSource.value = origin
    return catalog.search(query)
  }
  return { catalog, journey, browse, legacy, clear, submit, reads: () => reads }
}

for (const origin of [{ type: 'home' }, { type: 'local-library' }, { type: 'roon-artists' }, { type: 'roon-albums' }] as const satisfies readonly SidebarSource[]) {
  test(`4.1 清除搜索：真实App叉号清空已提交查询并返回${origin.type}，不自动恢复旧页`, async t => {
    const f = fixture(t)
    f.journey.navigateSource(origin)
    await f.submit('合成搜索')
    const oldLocation = f.catalog.captureReturnLocation('search'), reads = f.reads()
    f.clear()
    assert.equal(f.catalog.draft.value, '')
    assert.equal(f.catalog.query.value, '', '不能只清草稿而保留已提交查询')
    assert.equal(f.journey.currentView.value, f.journey.viewForSource(origin))
    assert.deepEqual(f.journey.sidebar.activeSource.value, origin)
    assert.equal(oldLocation.restore(), false, '旧搜索返回快照必须失效')
    f.journey.navigateSource({ type: 'home' }); f.journey.navigateSource(origin)
    assert.equal(f.journey.currentView.value, f.journey.viewForSource(origin))
    assert.equal(f.reads(), reads, '清空及导航不重新派发搜索')
  })
}

test('4.1 清除搜索：在途查询、预览和详情的迟到结果不能复活旧页面', async t => {
  const pending = deferred<CatalogPage>(), detail = deferred<CatalogPage>()
  const f = fixture(t, { search: async () => pending.promise, remoteDetail: async () => detail.promise })
  const old = f.submit('在途旧查询')
  const detailRead = f.catalog.openDetail(roonCatalogItem({ kind: 'album', reference: 'synthetic-album', title: '合成旧详情' }))
  const preview = f.catalog.preview('在途预览')
  assert.ok(f.catalog.previewPending.value > 0)
  const oldLocation = f.catalog.captureReturnLocation('search')
  f.clear()
  assert.equal(f.journey.currentView.value, 'home')
  assert.equal(f.catalog.query.value, '')
  assert.equal(f.catalog.previewPending.value, 0)
  pending.resolve({ ...empty(), items: [item] }); detail.resolve(empty())
  await Promise.all([old, preview, detailRead]); await turn()
  assert.equal(f.journey.currentView.value, 'home')
  assert.deepEqual(f.catalog.suggestions.value, [])
  assert.deepEqual(f.catalog.artistCards.value, [])
  assert.equal(f.catalog.detail.value, null)
  for (const sections of Object.values(f.catalog.searchSections)) for (const section of Object.values(sections)) {
    assert.equal(section.loading, false); assert.equal(section.preparing, false); assert.deepEqual(section.items, [])
  }
  assert.equal(oldLocation.restore(), false)
})

test('4.1 清除搜索：搜索派生Roon详情也能退出，空的旧聚合状态不阻止Catalog清空', async t => {
  const f = fixture(t)
  await f.submit('详情查询')
  f.journey.currentView.value = 'roon-album-detail'; f.journey.roonSearchOrigin.value = true
  assert.equal(f.legacy.searchQuery.value, '')
  f.clear()
  assert.equal(f.catalog.query.value, '')
  assert.equal(f.journey.currentView.value, 'home')
  assert.equal(f.journey.roonSearchOrigin.value, false)
  assert.deepEqual(f.journey.roonDetailParents.value, [])
})

test('4.1 清除搜索：离页门禁拒绝时保留已提交查询，同一恢复回调才原子完成清空', async t => {
  let allowed = true, resume: (() => void) | undefined
  const f = fixture(t, { beforeLeave: (_view, retry) => { if (allowed) return true; resume = retry; return false } })
  await f.submit('待确认查询'); allowed = false
  f.clear()
  assert.equal(f.catalog.query.value, '待确认查询')
  assert.equal(f.journey.currentView.value, 'search')
  assert.ok(resume)
  allowed = true; resume()
  assert.equal(f.catalog.query.value, '')
  assert.equal(f.journey.currentView.value, 'home')
})

test('4.1 清除搜索：其他页面只清未提交草稿，不关闭当前艺人详情或局部筛选', async t => {
  const f = fixture(t)
  f.journey.navigateSource({ type: 'roon-artists' })
  f.catalog.artistQuery.value = '局部艺人筛选'
  await f.catalog.openDetail(item)
  const selected = f.catalog.detail.value
  f.catalog.invalidatePreview('未提交草稿')
  f.clear()
  assert.equal(f.journey.currentView.value, 'roon-artists')
  assert.equal(f.catalog.artistQuery.value, '局部艺人筛选')
  assert.equal(f.catalog.detail.value, selected)
  assert.equal(f.catalog.draft.value, '')
})
