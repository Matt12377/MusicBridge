import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import ts from 'typescript'
import type { LocalLibraryPublicApi, LocalLibraryQuery, LocalLibraryQueryPage, LocalLibraryTrackDetail, LocalLibraryTrackSummary, LocalPlayRequest } from '@music-bridge/contracts'
import * as localWorkbenchDto from '@music-bridge/contracts'
import { useLocalLibrary } from '../src/renderer/src/composables/application/useLocalLibrary.js'
import { useLocalWorkbenchLibrary } from '../src/renderer/src/composables/application/local-library-workbench/library.js'
import { calculateVirtualWindow } from '../src/renderer/src/composables/virtualWindow.js'
import * as details from '../src/renderer/src/components/player/details.js'
import * as outboxController from '../src/renderer/src/components/command-outbox/controller.js'
import * as localAlbumBrowserTypes from '../src/renderer/src/composables/application/local-library-browser/types.js'
import * as localAlbumTrackPresentation from '../src/renderer/src/composables/application/local-library-browser/presentation.js'
import * as localScanPresentation from '../src/renderer/src/composables/application/local-library-browser/scan-presentation.js'
import * as localScanControl from '../src/renderer/src/composables/application/local-library-browser/scan-control.js'
import * as desktopArtworkTrace from '../../../packages/bridge-core/src/shared/desktop-artwork-trace.js'
import * as libraryOperationLog from '../../../packages/bridge-core/src/shared/library-operation-log.js'
import * as gridArtworkCache from '../src/renderer/src/composables/application/local-library-browser/grid-artwork-cache.js'
import * as gridDisplayBudget from '../src/renderer/src/composables/application/local-library-browser/grid-display-budget.js'
import * as localAlbumWorkbenchPresentation from '../src/renderer/src/components/library/local-browser/presentation.js'
import * as gridWindow from '../src/renderer/src/composables/useGridWindow.js'
import * as localArtwork from '../src/renderer/src/composables/application/useLocalArtwork.js'
import * as localRelocation from '../src/renderer/src/composables/application/useLocalRelocationPlans.js'
import { installSyntheticDocumentRealm, syntheticRootNode } from './helpers/synthetic-dom-realm.js'

const require = createRequire(import.meta.url), vue = require('vue') as typeof import('vue')
const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`
const root = { root: { id: id(1), sourceRootId: id(2), role: 'library' as const, revision: '1' }, label: '合成只读目录', availability: 'ONLINE' as const }
function item(n: number): LocalLibraryTrackSummary { return { track: { id: id(1000 + n), assetId: id(2000 + n), selectionRevision: '1', segment: null }, asset: { id: id(2000 + n), libraryRootId: root.root.id, sourceRootId: root.root.sourceRootId, rootRevision: '1', fileRevision: '1', locationRevision: '1', sampleFrames: null, timebaseHz: null }, metadata: { title: `原始曲目 ${n}`, artist: '合成作者', album: '原始专辑' }, versionTokens: [] } }
function queryPage(query: LocalLibraryQuery, total = 245): LocalLibraryQueryPage { return { ...query, total, hasMore: query.offset + query.limit < total, items: Array.from({ length: Math.min(query.limit, Math.max(0, total - query.offset)) }, (_, offset) => item(query.offset + offset)) } }
function trackDetail(n: number): LocalLibraryTrackDetail { const value = item(n); return { track: value.track, asset: value.asset, metadata: { raw: value.metadata, effective: value.metadata, override: null }, editions: [], versionTokens: [], fileParameters: null } }

interface Host { type: string; tagName: string; text: string; props: Record<string, any>; children: Host[]; parent: Host | null; value: any; checked: boolean; listeners: Record<string, (event: any) => void>; style: Record<string, string>; dataset: Record<string, string>; scrollTop: number; clientHeight: number; isConnected: boolean; focusCount: number; focusOptions?: FocusOptions; readonly ownerDocument: object; getRootNode(): unknown; getAttribute(name: string): string | null; contains(target: Host | null): boolean; matches(selector: string): boolean; focus(options?: FocusOptions): void; closest(selector: string): Host | null; querySelector(selector: string): Host | null; querySelectorAll(selector: string): Host[]; showModal(): void; close(): void; addEventListener(name: string, fn: (event: any) => void): void; removeEventListener(name: string): void }
async function mounted(t: test.TestContext, file: string, initial: Record<string, unknown>, api: any = {}, isolatedImports: Readonly<Record<string, unknown>> = {}, wrapComponent?: (component: import('vue').Component) => import('vue').Component) {
  const timers = new Map<number, () => void>(); let timerId = 0
  const document = { activeElement: null as Host | null, addEventListener() {}, removeEventListener() {}, querySelector: (selector: string): Host | null => all().find(el => selector.startsWith('#') ? el.props.id === selector.slice(1) : selector.split(' ').every((part, index, parts) => index === parts.length - 1 ? String(el.props.class).split(' ').includes(part.slice(1)) : !!el.closest(part))) ?? null }
  const restoreRealm = installSyntheticDocumentRealm(document); t.after(restoreRealm)
  let mountedRoot: Host | null = null
  const imageErrors: { src: string | null; currentTargetMatches: boolean }[] = []
  const node = (type = ''): Host => {
    const el: Host = { type, tagName: type.toUpperCase(), text: '', props: {}, children: [], parent: null, value: '', checked: false, listeners: {}, style: { display: '' }, dataset: {}, scrollTop: 0, clientHeight: 620, isConnected: false, focusCount: 0,
      ownerDocument: document, getRootNode: () => syntheticRootNode(el, mountedRoot, document), getAttribute: name => el.props[name] === undefined ? null : String(el.props[name]), contains: target => !!target && all(el).includes(target),
      focus(options) { document.activeElement = el; el.focusCount++; el.focusOptions = options },
      matches(selector) {
        if (selector.includes(',')) return selector.split(',').some(part => el.matches(part.trim()))
        if (selector === 'button:not(:disabled)') return el.type === 'button' && !el.props.disabled
        if (selector === 'input:not(:disabled)') return el.type === 'input' && !el.props.disabled
        if (selector === 'a[href]') return el.type === 'a' && !!el.props.href
        const attribute = /^\[([^=\]]+)(?:="([^"]*)")?\]$/u.exec(selector)
        if (attribute) return attribute[2] === undefined ? el.props[attribute[1]!] !== undefined : String(el.props[attribute[1]!]) === attribute[2]
        return selector.startsWith('.') ? String(el.props.class).split(' ').includes(selector.slice(1)) : selector.startsWith('#') ? el.props.id === selector.slice(1) : el.type === selector
      },
      closest(selector) { let current: Host | null = el; while (current) { if (current.matches(selector)) return current; current = current.parent } return null },
      querySelector: selector => all(el).find(candidate => candidate !== el && candidate.matches(selector)) ?? null,
      querySelectorAll: selector => all(el).filter(candidate => candidate !== el && candidate.matches(selector)),
      showModal() {}, close() {}, addEventListener(name, fn) { el.listeners[name] = fn }, removeEventListener(name) { delete el.listeners[name] },
    }
    Object.defineProperties(el, { isConnected: { get: () => { let current = el; while (current.parent) current = current.parent; return current.type === 'root' } }, options: { get: () => el.children.filter(child => child.type === 'option') }, multiple: { get: () => !!el.props.multiple }, type: { value: type, writable: true } })
    return el
  }
  const modules = new Map<string, import('vue').Component>()
  const load = (filename: string): import('vue').Component => {
    const known = modules.get(filename); if (known) return known
    const { descriptor } = parse(readFileSync(filename, 'utf8')), script = compileScript(descriptor, { id: filename })
    const template = compileTemplate({ id: filename, filename, source: descriptor.template!.content, compilerOptions: { bindingMetadata: script.bindings } }); assert.deepEqual(template.errors, [])
    const module = { exports: {} as { default: import('vue').Component } }, renderModule = { exports: {} as { render: (...args: any[]) => any } }
    const localRequire = createRequire(filename)
    const imports = (name: string) => {
      if (name === 'vue') return vue
      if (Object.hasOwn(isolatedImports, name)) return isolatedImports[name]
      if (name.endsWith('TrackArtwork.vue')) return { default: { render: () => vue.h('span', { class: 'test-artwork' }) } }
      if (name.endsWith('.vue')) return { default: load(path.resolve(path.dirname(filename), name)) }
      if (name.endsWith('/virtualWindow.js')) return { calculateVirtualWindow }
      if (name.endsWith('/details.js')) return details
      if (name.endsWith('/command-outbox/controller.js')) return outboxController
      if (name.endsWith('/useLocalArtwork') || name.endsWith('/useLocalArtwork.js')) return localArtwork
      if (name.endsWith('/useLocalRelocationPlans.js')) return localRelocation
      // .vue issuer的CommonJS夹具不走TS .js映射；接原ESM模块，不stub新专辑组件或常量。
      if (name.endsWith('/local-library-browser/types.js')) return localAlbumBrowserTypes
      if (name.endsWith('/local-library-browser/presentation.js')) return localAlbumTrackPresentation
      if (name.endsWith('/local-library-browser/scan-presentation.js')) return localScanPresentation
      if (name.endsWith('/local-library-browser/scan-control.js')) return localScanControl
      if (name.endsWith('/shared/desktop-artwork-trace.js')) return desktopArtworkTrace
      if (name.endsWith('/shared/library-operation-log.js')) return libraryOperationLog
      if (name.endsWith('/local-library-browser/grid-artwork-cache.js')) return gridArtworkCache
      if (name.endsWith('/local-library-browser/grid-display-budget.js')) return gridDisplayBudget
      if (name.endsWith('/useGridWindow.js')) return gridWindow
      if (name === './presentation.js' && path.dirname(filename) === path.join(componentRoot, 'library/local-browser')) return localAlbumWorkbenchPresentation
      return localRequire(name)
    }
    const compile = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    new Function('require', 'module', 'exports', 'document', 'window', 'setTimeout', 'clearTimeout', compile(script.content))(imports, module, module.exports, document, { musicBridge: api, innerWidth: 1200, innerHeight: 900, addEventListener() {}, removeEventListener() {}, setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId }, clearTimeout: (id: number) => timers.delete(id) }, (callback: () => void) => { timers.set(++timerId, callback); return timerId }, (id: number) => timers.delete(id))
    new Function('require', 'module', 'exports', compile(template.code))(imports, renderModule, renderModule.exports)
    const component = { ...module.exports.default, render: renderModule.exports.render }; modules.set(filename, component); return component
  }
  const remove = (el: Host) => { if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1); el.parent = null }
  const renderer = vue.createRenderer<Host, Host>({ createElement: node, createText: text => ({ ...node('text'), text }), createComment: () => node('comment'), setText: (el, text) => { el.text = text }, setElementText: (el, text) => { el.text = text; el.children = [] }, patchProp: (el, key, _old, value) => {
    el.props[key] = value
    if (key === 'style' && value) Object.assign(el.style, value)
    if (['value', 'checked'].includes(key)) (el as any)[key] = value
    if (key.startsWith('data-')) el.dataset[key.slice(5).replace(/-([a-z])/gu, (_match, char: string) => char.toUpperCase())] = String(value)
    // 被动记录原IMG handler的实际调用；不制造事件，也不替换组件的错误判断。
    if (key === 'onError' && el.type === 'img' && value) el.props[key] = (event: any) => {
      imageErrors.push({ src: el.getAttribute('src'), currentTargetMatches: event.currentTarget === el })
      for (const handler of Array.isArray(value) ? value : [value]) handler(event)
    }
  }, insert: (el, parent, anchor) => { remove(el); el.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(index < 0 ? parent.children.length : index, 0, el) }, remove, parentNode: el => el.parent, nextSibling: el => el.parent?.children[el.parent.children.indexOf(el) + 1] ?? null })
  const props = vue.reactive(initial), host = node('root'), component = load(file), app = renderer.createApp({ render: () => vue.h(wrapComponent ? wrapComponent(component) : component, props) }); let stopped = false
  mountedRoot = host
  app.mount(host); const unmount = () => { if (!stopped) { stopped = true; app.unmount() } }; t.after(unmount)
  const all = (el: Host = host): Host[] => [el, ...el.children.flatMap(child => all(child))]
  const text = (el: Host = host): string => el.text + el.children.map(child => text(child)).join('')
  const settle = async () => { for (let i = 0; i < 4; i++) { await new Promise<void>(resolve => setImmediate(resolve)); await vue.nextTick() } }
  const event = (el: Host, key = '') => ({ target: el, currentTarget: el, key, preventDefault() {}, stopPropagation() {} })
  const click = async (el: Host | undefined) => { assert.ok(el, '缺少点击目标'); el.props.onClick?.(event(el)); await settle() }
  const input = async (el: Host | undefined, value: string) => { assert.ok(el, '缺少输入目标'); el.value = value; el.listeners.input?.(event(el)); await vue.nextTick() }
  await settle()
  const poll = async () => { const entry = timers.entries().next().value; assert.ok(entry, '缺少已调度轮询'); timers.delete(entry[0]); entry[1](); await settle() }
  return { props, all, text, settle, event, click, input, poll, document, node, unmount, imageErrors, active: () => document.activeElement }
}
const componentRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../src/renderer/src/components')

test('4.1 搜索来源返回交给页面旅程，普通本地库返回与新选专辑保持原行为', async t => {
  const { useLocalAlbumBrowser } = await import('../src/renderer/src/composables/application/local-library-browser/useLocalAlbumBrowser.js')
  const selected: localWorkbenchDto.LocalAlbumSummary = { id: 'catalog-parent-return', kind: 'source-directory', rootId: root.root.id,
    editionId: null, title: '七里香', artists: ['周杰伦'], year: '2004', versionLabel: null, trackCount: 0, representativeTrackId: null,
    revision: '1', artworkAvailable: false, statuses: ['missing-artwork'] }
  const browser = useLocalAlbumBrowser({ api: {
    queryAlbums: async request => ({ ...request, items: [selected], total: 1, hasMore: false,
      counts: Object.fromEntries(['all', ...localWorkbenchDto.LOCAL_ALBUM_STATUSES].map(filter => [filter, filter === 'all' || filter === 'missing-artwork' ? 1 : 0])) as localWorkbenchDto.LocalAlbumFilterCounts }),
    queryAlbumTracks: async request => ({ ...request, album: selected, total: 0, hasMore: false, items: [] }),
    getArtwork: async request => ({ ...request, image: null, status: 'ready' }),
  } })
  const api = { queryLocalLibraryTracks: async (request: LocalLibraryQuery) => queryPage(request, 0), listLocalLibraryRoots: async () => [root],
    getLocalLibraryPlaybackTarget: async () => null, localLibraryScan: async () => ({ offset: 0, limit: 200, total: 0, hasMore: false, items: [] }) } as unknown as LocalLibraryPublicApi
  const session = useLocalLibrary({ api, getSelectedZone: () => undefined, play: async () => { throw new Error('返回导航不得点播') } })
  t.after(() => { session.dispose(); browser.dispose() })
  await browser.activate(); await browser.openAlbumReference({ albumKey: selected.id, rootId: selected.rootId, revision: selected.revision })
  let backs = 0, selections = 0
  const selectedAlbumId = () => browser.selectedAlbum.value?.id
  const f = await mounted(t, path.join(componentRoot, 'library/LocalLibraryView.vue'), { session, browser: vue.markRaw(browser), playbackState: null,
    viewMode: 'albums', albumBackLabel: '返回搜索结果', 'onBack-album': () => { backs++ },
    'onSelect-album': () => { assert.equal(browser.selectedAlbum.value, null); selections++ } }, api)
  await f.click(f.all().find(el => el.type === 'button' && f.text(el).trim() === '返回搜索结果'))
  assert.equal(backs, 1); assert.equal(selectedAlbumId(), selected.id, '父级返回只派发一次旅程事件，不提前按库内返回关闭')
  f.props.albumBackLabel = undefined; await f.settle()
  await f.click(f.all().find(el => el.type === 'button' && f.text(el).trim() === '本地专辑'))
  assert.equal(backs, 1); assert.equal(browser.selectedAlbum.value, null)
  await f.click(f.all().find(el => el.props['data-local-album-id'] === selected.id))
  assert.equal(selections, 1); assert.equal(selectedAlbumId(), selected.id)
})

test('009首次读取失败显示错误与重试，不能断言音乐库为空', async t => {
  const api = { queryLocalLibraryTracks: async () => { throw new Error('合成首次读取失败') }, listLocalLibraryRoots: async () => [], getLocalLibraryPlaybackTarget: async () => null, localLibraryScan: async () => ({ offset: 0, limit: 200, total: 0, hasMore: false, items: [] }) } as unknown as LocalLibraryPublicApi
  const model = useLocalLibrary({ api, getSelectedZone: () => undefined, play: async () => { throw new Error('不应点播') } }); t.after(() => model.dispose())
  const f = await mounted(t, path.join(componentRoot, 'library/LocalLibraryView.vue'), { session: model, playbackState: null }, api)
  assert.equal(model.loaded.value, false); assert.match(f.text(), /暂时无法读取.*重试读取/u); assert.doesNotMatch(f.text(), /本地音乐库还没有曲目/u); assert.ok(f.all().some(el => el.props.role === 'alert'))
})
test('共享库确认没有任何根时显示首次添加引导，零曲目不决定是否已有库', async t => {
  const api={queryLocalLibraryTracks:async(query:LocalLibraryQuery)=>queryPage(query,0),listLocalLibraryRoots:async()=>[],getLocalLibraryPlaybackTarget:async()=>null,localLibraryScan:async()=>({offset:0,limit:200,total:0,hasMore:false,items:[]})} as unknown as LocalLibraryPublicApi
  const model=useLocalLibrary({api,getSelectedZone:()=>undefined,play:async()=>{throw new Error('空库不得点播')}});t.after(()=>model.dispose())
  const f=await mounted(t,path.join(componentRoot,'library/LocalLibraryView.vue'),{session:model,playbackState:null},api)
  assert.equal(model.loaded.value,true);assert.equal(model.total.value,0);assert.match(f.text(),/添加本地音乐库/u);assert.match(f.text(),/选择音乐文件夹/u);assert.equal(f.all().filter(el=>el.props['data-testid']==='local-library-onboarding').length,1);assert.equal(f.all().filter(el=>el.props.role==='alert').length,0)
})

test('现代页面只在旧曲目表实际可见时启用列表，专辑墙与具体详情不读取隐藏100首', async t => {
  const { useLocalAlbumBrowserPages } = await import('../src/renderer/src/composables/application/local-library-browser/useLocalAlbumBrowser.js')
  const reads = { roots: 0, target: 0, detail: 0 }, trackReads: LocalLibraryQuery[] = []
  const api = { queryLocalLibraryTracks: async (query: LocalLibraryQuery) => { trackReads.push(query); return queryPage(query) },
    getLocalLibraryTrackDetail: async (trackId: string) => { reads.detail++; return trackDetail(Number(trackId.slice(-12)) - 1000) },
    listLocalLibraryRoots: async () => { reads.roots++; return [root] }, getLocalLibraryPlaybackTarget: async () => { reads.target++; return null },
  } as unknown as LocalLibraryPublicApi
  const scope = vue.effectScope(), pages = scope.run(() => useLocalAlbumBrowserPages({ api: {
    queryAlbums: async request => ({ ...request, items: [], total: 0, hasMore: false,
      counts: Object.fromEntries(['all', ...localWorkbenchDto.LOCAL_ALBUM_STATUSES].map(filter => [filter, 0])) as localWorkbenchDto.LocalAlbumFilterCounts }),
    queryAlbumTracks: async () => { throw new Error('本例不读专辑详情') }, getArtwork: async () => { throw new Error('空专辑页不读封面') },
  } }))!
  const model = useLocalLibrary({ api, getSelectedZone: () => undefined, play: async () => { throw new Error('本例不点播') } })
  t.after(() => { model.dispose(); scope.stop() })
  const f = await mounted(t, path.join(componentRoot, 'library/LocalLibraryView.vue'), { session: model, browser: vue.markRaw(pages.localLibrary), playbackState: null,
    viewMode: 'albums', selectedTrackId: null }, api)
  assert.equal(trackReads.length, 0); assert.deepEqual(reads, { roots: 1, target: 1, detail: 0 })
  await model.selectTrack(item(102).track.id); f.props.selectedTrackId = item(102).track.id; f.props.viewMode = 'tracks'; await f.settle()
  assert.equal(reads.detail, 1); assert.equal(trackReads.length, 0); assert.equal(f.all().filter(el => el.props.role === 'table').length, 0)
  assert.match(f.text(), /原始曲目 102/u)
  f.props.viewMode = 'albums'; f.props.selectedTrackId = null; model.closeDetail(); await f.settle()
  assert.equal(trackReads.length, 0)
  f.props.viewMode = 'tracks'; await f.settle()
  assert.equal(trackReads.length, 1); assert.equal(trackReads[0]!.limit, 100); assert.equal(f.all().filter(el => el.props.role === 'table').length, 1)
  const search = f.all().find(el => el.props['aria-label'] === '搜索本地音乐')!
  await f.input(f.all(search).find(el => el.type === 'input'), '明确旧列表搜索')
  search.props.onSubmit(f.event(search)); await f.settle()
  assert.equal(trackReads.length, 2); assert.equal(trackReads[1]!.query, '明确旧列表搜索')
  const table = f.all().find(el => el.props.role === 'table')!; table.scrollTop = 102 * 84; table.props.onScroll(f.event(table)); await f.settle()
  assert.equal(trackReads.length, 3); assert.equal(trackReads[2]!.offset, 100)
})

test('App真实导航watch在专辑首屏前只激活会话，旧表模式仍立即读取', async t => {
  const source = readFileSync(path.resolve(componentRoot, '../App.vue'), 'utf8')
  const start = source.indexOf('watch(currentView, (view, previous) => {'), end = source.indexOf('\ninstallInitialScanObservationLifecycle()', start)
  assert.ok(start >= 0 && end > start, '执行原App完整页面watch，不复制激活分支')
  const counts = { tracks: 0, roots: 0, target: 0, outbox: 0 }
  const model = useLocalLibrary({ api: { queryLocalLibraryTracks: async (query: LocalLibraryQuery) => { counts.tracks++; return queryPage(query) },
    listLocalLibraryRoots: async () => { counts.roots++; return [root] }, getLocalLibraryPlaybackTarget: async () => { counts.target++; return null },
    getCommandOutbox: async () => { counts.outbox++; return { datasetId: id(90), entries: [] } },
  } as unknown as LocalLibraryPublicApi, getSelectedZone: () => undefined, play: async () => { throw new Error('本例不点播') } })
  const scope = vue.effectScope(), currentView = vue.ref('home'), viewMode = vue.ref('albums'), selectedTrackId = vue.ref<string | null>(null)
  const catalogActionPending = vue.ref(true)
  t.after(() => { model.dispose(); scope.stop() })
  let deferredContext=false
  const beginContext=(_view:string,albumPage:boolean)=>{deferredContext=albumPage}
  // 该夹具只隔离导航watch；真实页接受/换代/错误闭环由独立App Gate执行。
  const block = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  scope.run(() => new Function('watch', 'currentView', 'localLibrary', 'localLibraryViewMode', 'localLibrarySelectedTrackId', 'loadWorkspace', 'albumBrowser', 'coverDropBrowser',
    'workbenchOpenGeneration', 'maintenanceUiGeneration', 'maintenanceUiOpened', 'workbenchOpening', 'workbenchEntryError', 'invalidateResultInspections',
    'recordingInitialPhysical', 'recordingReservationNavigation', 'beginInitialAlbumContext', 'deferInitialAlbumContextReads', 'requestInitialScanRefresh',
    'catalogActionGeneration', 'catalogActionPending', block)(vue.watch, currentView, model, viewMode, selectedTrackId, () => {}, { deactivate() {} }, { deactivate() {} },
    0, 0, null, vue.ref(false), vue.ref(''), () => {}, vue.ref(), vue.ref(), beginContext, ()=>deferredContext, async()=>{}, 0, catalogActionPending))
  const enter = async (view: string) => { currentView.value = view; for (let i = 0; i < 8; i++) await vue.nextTick() }
  await enter('local-library'); assert.deepEqual(counts, { tracks: 0, roots: 0, target: 0, outbox: 0 })
  assert.equal(catalogActionPending.value, false, '执行真实页面换代取消分支，同时保留原会话激活顺序')
  await model.refresh(); assert.deepEqual(counts, { tracks: 0, roots: 1, target: 1, outbox: 1 }, '原显式刷新仍真实读取上下文，不被defer替代')
  await enter('coverdrop'); assert.deepEqual(counts, { tracks: 0, roots: 1, target: 1, outbox: 1 }, '新专辑入口未有真实页时不抢跑上下文')
  viewMode.value = 'tracks'; selectedTrackId.value = item(0).track.id
  await enter('local-library'); assert.equal(counts.tracks, 0, '详情模式仍不消费隐藏旧表'); assert.deepEqual({roots:counts.roots,target:counts.target,outbox:counts.outbox},{roots:2,target:2,outbox:2},'显式详情模式保留真实上下文读取')
  await enter('home'); selectedTrackId.value = null
  await enter('local-library'); assert.equal(counts.tracks, 1, '真实旧曲目表保持原首屏读取'); assert.deepEqual({roots:counts.roots,target:counts.target,outbox:counts.outbox},{roots:3,target:3,outbox:3})
  await enter('coverdrop'); await model.refresh(); assert.equal(counts.tracks, 1, '从旧表切入CoverDrop后刷新也不得隐式读取')
})

test('009正式页面复用表格与目录控件，详情焦点/关闭返回，显示更正保留原始信息', async t => {
  const writes: any[] = [], sends: LocalPlayRequest[] = []; let name = ''; let trackReads = 0
  const api = { queryLocalLibraryTracks: async (query: LocalLibraryQuery) => queryPage(query), getLocalLibraryTrackDetail: async (trackId: string) => { const value = trackDetail(Number(trackId.slice(-12)) - 1000); if (name) { value.metadata.override = { trackId, revision: '1', fields: { title: name } }; value.metadata.effective = { ...value.metadata.raw, title: name } } return value }, getLocalLibraryPlaybackTarget: async () => ({ core_id: '受控Core', zone_id: '受控Zone' }), listLocalLibraryRoots: async () => [root], localLibraryScan: async () => ({ offset: 0, limit: 200, total: 0, hasMore: false, items: [] }), listLocalLibraryTracks: async () => { trackReads++; throw new Error('目录模式不得读取第二列表') }, overrideLocalLibraryMetadata: async (request: any) => { writes.push(request); name = request.fields.title; return { trackId: request.trackId, revision: '1', fields: request.fields } } } as unknown as LocalLibraryPublicApi
  const model = useLocalLibrary({ api, getSelectedZone: () => ({ zoneId: '受控Zone', displayName: '合成播放目标', selected: true }), play: async request => { sends.push(request); return { status: 'accepted', request_id: request.request_id, action: request.action } } }); t.after(() => model.dispose())
  const f = await mounted(t, path.join(componentRoot, 'library/LocalLibraryView.vue'), { session: model, playbackState: null }, api)
  assert.equal(f.all().filter(el => el.props['data-testid'] === 'local-library-settings').length, 0); assert.equal(f.all().filter(el => el.props.role === 'table').length, 1); assert.equal(trackReads, 0)
  const trigger = f.all().find(el => el.type === 'button' && el.props['aria-label'] === '查看 原始曲目 0 的版本与文件详情')
  await f.click(trigger); assert.equal(f.active()?.props.id, 'local-track-detail-heading'); assert.match(f.text(), /原始标签.*显示更正.*生效信息/u); assert.match(f.text(), /文件参数未知/u); assert.match(f.text(), /合成播放目标/u)
  await f.input(f.all().find(el => el.props.id === 'local-display-title'), '仅 MB 显示名')
  const form = f.all().find(el => String(el.props.class).includes('local-title-form'))!; form.props.onSubmit(f.event(form)); await f.settle()
  assert.equal(writes.length, 1); assert.equal(writes[0].trackId, item(0).track.id); assert.match(f.text(), /原始曲目 0/u); assert.match(f.text(), /仅 MB 显示名/u); assert.equal(model.detail.value?.asset.id, item(0).asset.id)
  const pane = f.all().find(el => el.props['aria-labelledby'] === 'local-track-detail-heading')!; pane.props.onKeydown(f.event(pane, 'Escape')); await f.settle(); assert.equal(model.selectedId.value, null); assert.equal(f.active(), trigger)
  assert.equal(sends.length, 0)
})
test('009共享TrackTable稀疏窗口与键盘实际派发，抽象total不创建全量节点', async t => {
  const plays: string[] = [], ranges: number[][] = [], entries = Array.from({ length: 100 }, (_, index) => ({ index, track: { id: id(index + 1000), title: `曲目 ${index}`, artists: ['合成'], album: '合成' } }))
  const f = await mounted(t, path.join(componentRoot, 'media/TrackTable.vue'), { tracks: entries.map(entry => entry.track), rangeWindow: { total: 100_000, entries }, onPlay: (track: any) => plays.push(track.id), 'onVisible-range': (start: number, end: number) => ranges.push([start, end]) })
  const table = f.all().find(el => el.props.role === 'table')!; assert.equal(table.props['aria-rowcount'], 100_001); assert.ok(f.all().filter(el => el.props.role === 'row').length < 40)
  const row = f.all().find(el => el.props['aria-rowindex'] === 2)!; row.props.onKeydown(f.event(row, 'Enter')); await f.settle(); assert.deepEqual(plays, [entries[0]!.track.id])
  table.scrollTop = 500 * 84; table.props.onScroll(f.event(table)); await f.settle(); assert.ok(ranges.some(([start, end]) => start > 480 && end < 540)); assert.ok(f.all().filter(el => el.props.role === 'row').length < 40); assert.match(f.text(), /正在读取这一页/u)
})
test('009共享TrackTable旧默认保留普通列表、Enter播放与加载更多', async t => {
  const plays: string[] = []; let more = 0
  const tracks = Array.from({ length: 3 }, (_, n) => ({ id: id(n + 1000), title: `原默认曲目 ${n}`, artists: ['合成'], album: '合成' }))
  const f = await mounted(t, path.join(componentRoot, 'media/TrackTable.vue'), { tracks, hasMore: true, total: 4, onPlay: (track: any) => plays.push(track.id), 'onLoad-more': () => more++ })
  const table = f.all().find(el => el.props.role === 'table')!; assert.equal(table.props['aria-rowcount'], undefined); assert.equal(f.all().filter(el => String(el.props.class).split(' ').includes('track-row')).length, 3)
  const row = f.all().find(el => String(el.props.class).split(' ').includes('track-row'))!; row.props.onKeydown(f.event(row, 'Enter')); await f.settle(); assert.deepEqual(plays, [tracks[0]!.id])
  await f.click(f.all().find(el => el.type === 'button' && f.text(el) === '加载更多歌曲')); assert.equal(more, 1)
})

test('009R1 共享表格提供实际3列表头及歌曲/时长/操作cell，装饰不增加列', async t => {
  const f = await mounted(t, path.join(componentRoot, 'media/TrackTable.vue'), { tracks: [item(0)].map(value => ({ id: value.track.id, title: value.metadata.title, artists: [value.metadata.artist!], album: value.metadata.album! })), rangeWindow: { total: 1, entries: [{ index: 0, track: { id: id(1000), title: '测试曲目', artists: ['作者'], album: '专辑' } }] } })
  const table = f.all().find(el => el.props.role === 'table')!; assert.equal(table.props['aria-colcount'], 3)
  const headers = f.all().filter(el => el.props.role === 'columnheader'); assert.deepEqual(headers.map(el => f.text(el)), ['歌曲', '时长', '操作'])
  const row = f.all().find(el => el.props['aria-rowindex'] === 2)!; assert.equal(f.all(row).filter(el => el.props.role === 'cell').length, 3)
  assert.match(f.text(f.all(row).find(el => el.props.role === 'cell')!), /测试曲目.*作者.*专辑/u)
  assert.ok(f.all(row).filter(el => ['track-index', 'track-art', 'track-album'].some(name => String(el.props.class).split(' ').includes(name))).every(el => el.props['aria-hidden'] === 'true' || el.props['aria-hidden'] === true))
})
test('009R1 目录读失败后成功仅清读故障，未知业务动作在成功轮询后仍可见', async t => {
  let readFails = true
  const api = { listLocalLibraryRoots: async () => { if (readFails) throw new Error('合成读取失败'); return [root] }, localLibraryScan: async () => ({ offset: 0, limit: 200, total: 0, hasMore: false, items: [] }), chooseLocalLibraryRoot: async () => { throw new Error('合成业务未知') } }
  const f = await mounted(t, path.join(componentRoot, 'settings/LocalLibrarySettings.vue'), { managementOnly: true }, api)
  assert.match(f.text(), /读取未获确认/u); readFails = false; await f.poll(); assert.doesNotMatch(f.text(), /读取未获确认/u); assert.match(f.text(), /合成只读目录/u)
  await f.click(f.all().find(el => el.type === 'button' && f.text(el) === '添加音乐文件夹并扫描')); assert.match(f.text(), /操作未获确认/u)
  readFails = true; await f.poll(); assert.match(f.text(), /读取未获确认/u); assert.match(f.text(), /操作未获确认/u)
  readFails = false; await f.poll(); assert.doesNotMatch(f.text(), /读取未获确认/u); assert.match(f.text(), /操作未获确认/u)
})

test('设置轮询仅扫描进度发观察，目录身份可用性和用户操作仍立即updated', async t => {
  let updated = 0, observed = 0, accepted = '0', phase = 'running', availability = 'ONLINE', revision = '1', present = true, pauses = 0
  const job = () => ({ schemaVersion: '1.2', jobId: id(70), datasetId: id(71), libraryRootId: root.root.id, sourceRootId: root.root.sourceRootId, rootRevision: revision,
    jobRevision: '1', checkpointRef: null, phase, progress: { visited: accepted, accepted, rejected: '0' }, failureCode: null })
  const api = { listLocalLibraryRoots: async () => present ? [{ ...root, availability, root: { ...root.root, revision } }] : [],
    localLibraryScan: async (command: string) => {
      if (command === 'localScan.get') return job()
      if (command === 'localScan.pause') { pauses++; phase = 'paused'; return job() }
      assert.equal(command, 'localScan.page'); return { offset: 0, limit: 200, total: 1, hasMore: false, items: [job()] }
    } }
  const f = await mounted(t, path.join(componentRoot, 'settings/LocalLibrarySettings.vue'), { managementOnly: true, onUpdated: () => updated++, onScanObserved: () => observed++ }, api)
  assert.equal(updated, 0); assert.equal(observed, 0)
  accepted = '1'; await f.poll(); assert.equal(observed, 1); assert.equal(updated, 0)
  await f.poll(); assert.equal(observed, 1, '相同进度不再次发出事件')
  await f.click(f.all().find(el => el.type === 'button' && f.text(el) === '暂停'))
  assert.equal(pauses, 1); assert.equal(updated, 1, '用户动作仍保留立即刷新'); assert.equal(observed, 2)
  availability = 'SOURCE_ROOT_OFFLINE'; await f.poll(); assert.equal(updated, 2); assert.equal(observed, 2)
  revision = '2'; await f.poll(); assert.equal(updated, 3, '根修订变化不能降为扫描观察')
  present = false; await f.poll(); assert.equal(updated, 4, '移除目录仍立即更新')
})

test('添加反馈：设置空选择或prepare失败不派发成功updated，成功轮询后反馈仍可见', async t => {
  for (const failed of [false, true]) await t.test(failed ? 'prepare失败' : '成功null', async sub => {
    const readback = { datasetId: id(90), revision: '1', scanConcurrency: 12, libraries: [] }
    const workspace = useLocalWorkbenchLibrary({ api: { localLibraryManagement: async (command: string) => {
      if (command === 'library.read') return readback
      if (command === 'library.import.prepare') { if (failed) throw new Error('合成prepare失败'); return null }
      throw new Error('未选择不得写入')
    } } as any }); sub.after(workspace.dispose)
    let updated = 0
    const api = { listLocalLibraryRoots: async () => [], localLibraryScan: async () => ({ offset: 0, limit: 200, total: 0, hasMore: false, items: [] }) }
    const f = await mounted(sub, path.join(componentRoot, 'settings/LocalLibrarySettings.vue'), { workspace: vue.markRaw(workspace), managementOnly: true, onUpdated: () => { updated++; void workspace.read() } }, api)
    await f.click(f.all().find(el => el.type === 'button' && f.text(el) === '添加音乐文件夹并扫描'))
    assert.equal(updated, 0, '未添加不得派发成功刷新事件')
    const feedback = f.all().find(el => el.props['data-testid'] === 'library-add-feedback')
    assert.ok(feedback, '本次未添加结果必须在普通设置区可见')
    assert.match(f.text(feedback), failed ? /未完成.*选择|选择.*未.*确认/u : /未添加.*未启动扫描/u)
    await workspace.read(); await f.poll()
    assert.equal(f.text(f.all().find(el => el.props['data-testid'] === 'library-add-feedback')!), f.text(feedback))
  })
})

test('添加反馈：设置选择和确认阶段连续可见，未知回执保留原操作查询入口', async t => {
  let choose!: (value: unknown) => void, reject!: (cause: Error) => void
  const choice = new Promise(resolve => { choose = resolve }), confirmation = new Promise((_resolve, fail) => { reject = fail })
  const workspace = useLocalWorkbenchLibrary({ api: { localLibraryManagement: async (command: string) => command === 'library.read'
    ? { datasetId: id(90), revision: '1', scanConcurrency: 12, libraries: [] } : command === 'library.import.prepare' ? choice : confirmation } as any,
    makeCommandId: () => 'visible-original-command' }); t.after(workspace.dispose)
  let updated = 0
  const api = { listLocalLibraryRoots: async () => [], localLibraryScan: async () => ({ offset: 0, limit: 200, total: 0, hasMore: false, items: [] }) }
  const f = await mounted(t, path.join(componentRoot, 'settings/LocalLibrarySettings.vue'), { workspace: vue.markRaw(workspace), managementOnly: true, onUpdated: () => updated++ }, api)
  await f.click(f.all().find(el => el.type === 'button' && f.text(el) === '添加音乐文件夹并扫描'))
  assert.match(f.text(), /正在选择音乐文件夹/u)
  choose({ choiceId: 'visible-choice', label: '合成新目录', suggestedRole: 'artist', evidence: [] }); await f.settle()
  assert.match(f.text(), /正在确认添加/u)
  reject(new Error('合成回执丢失')); await f.settle()
  assert.equal(updated, 0)
  const feedback = f.all().find(el => el.props['data-testid'] === 'library-add-feedback')!
  assert.match(f.text(feedback), /结果尚未确认/u)
  assert.ok(f.all(feedback).some(el => el.type === 'button' && /查询原添加结果/u.test(f.text(el))))
  assert.equal(workspace.originals.value[0]?.payload.commandId, 'visible-original-command')
  await workspace.read(); await f.poll(); assert.match(f.text(feedback), /结果尚未确认/u)
})

test('添加反馈：无workspace旧入口取消不触发成功刷新，已有目录保留', async t => {
  let updated = 0, reads = 0, writes = 0
  const api = { listLocalLibraryRoots: async () => { reads++; return [root] }, localLibraryScan: async (command: string) => {
    if (command !== 'localScan.page') writes++
    return { offset: 0, limit: 200, total: 0, hasMore: false, items: [] }
  }, chooseLocalLibraryRoot: async () => null }
  const f = await mounted(t, path.join(componentRoot, 'settings/LocalLibrarySettings.vue'), { managementOnly: true, onUpdated: () => updated++ }, api)
  const before = reads
  await f.click(f.all().find(el => el.type === 'button' && f.text(el) === '添加音乐文件夹并扫描'))
  assert.equal(updated, 0); assert.equal(reads, before); assert.equal(writes, 0)
  assert.match(f.text(), /合成只读目录/u)
})

test('移除投影：成功后raw根仍保留，真实按钮、轮询与重挂均不能补回卡片', async t => {
  let removed = false, writes = 0, updated = 0
  const workspace = useLocalWorkbenchLibrary({ api: { localLibraryManagement: async (command: string, payload: any) => {
    if (command === 'library.read') return { datasetId: id(90), revision: removed ? '2' : '1', scanConcurrency: 12, libraries: removed ? [] : [{ libraryId: root.root.id, label: root.label, role: 'catalog', online: true, watching: false, latestSnapshotId: null, totalAlbums: 2, totalTracks: 9, scanState: 'complete' }] }
    if (command === 'library.remove') { writes++; removed = true; return { commandId: payload.commandId, kind: command, state: 'succeeded', libraryIds: [root.root.id], message: null } }
    throw new Error('移除只接受原写入')
  } } as any, makeCommandId: () => 'remove-visible' }); t.after(workspace.dispose)
  const api = { listLocalLibraryRoots: async () => [root], localLibraryScan: async () => ({ offset: 0, limit: 200, total: 0, hasMore: false, items: [] }) }
  const props = { workspace: vue.markRaw(workspace), managementOnly: true, onUpdated: () => updated++ }
  const f = await mounted(t, path.join(componentRoot, 'settings/LocalLibrarySettings.vue'), props, api)
  const cards = () => f.all().filter(el => String(el.props.class).split(' ').includes('library-card'))
  assert.equal(cards().length, 1)
  const confirm = f.all().find(el => el.type === 'input' && el.props.type === 'checkbox' && /我已核对选中的/u.test(f.text(el.parent!)))!
  assert.ok(confirm); confirm.checked = true; confirm.listeners.change?.(f.event(confirm)); await f.settle()
  const button = f.all().find(el => el.type === 'button' && f.text(el) === '移除选中库本地记录')!
  assert.equal(button.props.disabled, false); await f.click(button)
  assert.equal(writes, 1); assert.equal(cards().length, 0, '成功移除不能被仍保留的raw root补回')
  assert.equal(updated, 1, '仅确认成功的按钮动作通知上层刷新')
  assert.match(f.text(f.all().find(el => el.props['data-testid'] === 'library-remove-feedback')!), /已移除/u)
  await f.poll(); assert.equal(cards().length, 0)
  f.unmount()
  const cold = await mounted(t, path.join(componentRoot, 'settings/LocalLibrarySettings.vue'), props, api)
  assert.equal(cold.all().filter(el => String(el.props.class).split(' ').includes('library-card')).length, 0)
  assert.equal(writes, 1)
})

test('移除投影：未知回执成功reload后仍可见，只查询原command成功后清卡片和选择', async t => {
  let removed = false, writes = 0, queries = 0, updated = 0
  const workspace = useLocalWorkbenchLibrary({ api: { localLibraryManagement: async (command: string, payload: any) => {
    if (command === 'library.read') return { datasetId: id(90), revision: removed ? '2' : '1', scanConcurrency: 12, libraries: removed ? [] : [{ libraryId: root.root.id, label: root.label, role: 'catalog', online: true, watching: false, latestSnapshotId: null, totalAlbums: 2, totalTracks: 9, scanState: 'complete' }] }
    if (command === 'library.remove') { writes++; return { commandId: payload.commandId, kind: command, state: 'unknown', libraryIds: [root.root.id], message: null } }
    if (command === 'library.operation.read') { queries++; assert.deepEqual(payload, { commandId: 'remove-query-original' }); removed = true; return { commandId: payload.commandId, kind: 'library.remove', state: 'succeeded', libraryIds: [root.root.id], message: null } }
    throw new Error('只查询原命令')
  } } as any, makeCommandId: () => 'remove-query-original' }); t.after(workspace.dispose)
  const api = { listLocalLibraryRoots: async () => [root], localLibraryScan: async () => ({ offset: 0, limit: 200, total: 0, hasMore: false, items: [] }) }
  const f = await mounted(t, path.join(componentRoot, 'settings/LocalLibrarySettings.vue'), { workspace: vue.markRaw(workspace), managementOnly: true, onUpdated: () => updated++ }, api)
  const confirm = f.all().find(el => el.type === 'input' && el.props.type === 'checkbox' && /我已核对选中的/u.test(f.text(el.parent!)))!
  confirm.checked = true; confirm.listeners.change?.(f.event(confirm)); await f.settle()
  await f.click(f.all().find(el => el.type === 'button' && f.text(el) === '移除选中库本地记录'))
  assert.equal(writes, 1); assert.equal(updated, 0)
  const feedback = () => f.all().find(el => el.props['data-testid'] === 'library-remove-feedback')!
  assert.ok(feedback()); assert.match(f.text(feedback()), /结果尚未确认/u)
  await workspace.read(); await f.poll(); assert.match(f.text(feedback()), /结果尚未确认/u)
  assert.equal(f.all().filter(el => String(el.props.class).split(' ').includes('library-card')).length, 1)
  await f.click(f.all(feedback()).find(el => el.type === 'button' && /查询原移除结果/u.test(f.text(el))))
  assert.equal(writes, 1); assert.equal(queries, 1)
  assert.equal(f.all().filter(el => String(el.props.class).split(' ').includes('library-card')).length, 0)
  assert.deepEqual(workspace.selectedLibraryIds.value, []); assert.match(f.text(feedback()), /已移除/u)
})

test('移除投影：管理state暂未确认保上次卡片，无workspace入口继续raw fallback', async t => {
  const workspace = useLocalWorkbenchLibrary({ api: { localLibraryManagement: async () => ({ datasetId: id(90), revision: '1', scanConcurrency: 12, libraries: [{ libraryId: root.root.id, label: '已确认管理卡片', role: 'catalog', online: true, watching: false, latestSnapshotId: null, totalAlbums: 2, totalTracks: 9, scanState: 'complete' }] }) } as any }); t.after(workspace.dispose)
  const api = { listLocalLibraryRoots: async () => [root], localLibraryScan: async () => ({ offset: 0, limit: 200, total: 0, hasMore: false, items: [] }) }
  const f = await mounted(t, path.join(componentRoot, 'settings/LocalLibrarySettings.vue'), { workspace: vue.markRaw(workspace), managementOnly: true }, api)
  workspace.state.value = null; await f.settle(); await f.poll()
  assert.ok(f.all().some(el => String(el.props.class).split(' ').includes('library-card') && /已确认管理卡片/u.test(f.text(el))))
  assert.doesNotMatch(f.text(), /添加你的第一个音乐库/u)
  f.unmount()
  const legacy = await mounted(t, path.join(componentRoot, 'settings/LocalLibrarySettings.vue'), { managementOnly: true }, api)
  assert.equal(legacy.all().filter(el => String(el.props.class).split(' ').includes('library-card')).length, 1)
  assert.match(legacy.text(), /合成只读目录/u)
})

test('移除投影：成功后管理read失败仍隐藏旧成员，显示列表刷新待确认', async t => {
  let removed = false
  const workspace = useLocalWorkbenchLibrary({ api: { localLibraryManagement: async (command: string, payload: any) => {
    if (command === 'library.read') { if (removed) throw new Error('合成回读失败'); return { datasetId: id(90), revision: '1', scanConcurrency: 12, libraries: [{ libraryId: root.root.id, label: root.label, role: 'catalog', online: true, watching: false, latestSnapshotId: null, totalAlbums: 2, totalTracks: 9, scanState: 'complete' }] } }
    if (command === 'library.remove') { removed = true; return { commandId: payload.commandId, kind: command, state: 'succeeded', libraryIds: [root.root.id], message: null } }
    throw new Error('只执行一次移除')
  } } as any, makeCommandId: () => 'remove-read-failed' }); t.after(workspace.dispose)
  const api = { listLocalLibraryRoots: async () => [root], localLibraryScan: async () => ({ offset: 0, limit: 200, total: 0, hasMore: false, items: [] }) }
  const f = await mounted(t, path.join(componentRoot, 'settings/LocalLibrarySettings.vue'), { workspace: vue.markRaw(workspace), managementOnly: true }, api)
  const confirm = f.all().find(el => el.type === 'input' && el.props.type === 'checkbox' && /我已核对选中的/u.test(f.text(el.parent!)))!
  confirm.checked = true; confirm.listeners.change?.(f.event(confirm)); await f.settle()
  await f.click(f.all().find(el => el.type === 'button' && f.text(el) === '移除选中库本地记录'))
  assert.equal(workspace.state.value?.revision, '1'); assert.equal(workspace.state.value?.libraries.length, 1, '保留最后真实readback')
  assert.equal(f.all().filter(el => String(el.props.class).split(' ').includes('library-card')).length, 0)
  assert.match(f.text(f.all().find(el => el.props['data-testid'] === 'library-remove-feedback')!), /已移除.*列表刷新待确认/u)
  await f.poll(); assert.equal(f.all().filter(el => String(el.props.class).split(' ').includes('library-card')).length, 0)
})

test('移除投影：首次管理未确认不将raw空列表当成没有音乐库', async t => {
  let release!: (value: unknown) => void
  const held = new Promise(resolve => { release = resolve })
  const workspace = useLocalWorkbenchLibrary({ api: { localLibraryManagement: async () => held } as any }); t.after(workspace.dispose)
  const api = { listLocalLibraryRoots: async () => [], localLibraryScan: async () => ({ offset: 0, limit: 200, total: 0, hasMore: false, items: [] }) }
  const f = await mounted(t, path.join(componentRoot, 'settings/LocalLibrarySettings.vue'), { workspace: vue.markRaw(workspace), managementOnly: true }, api)
  assert.match(f.text(), /正在读取音乐库/u); assert.doesNotMatch(f.text(), /添加你的第一个音乐库/u)
  release({ datasetId: id(90), revision: '1', scanConcurrency: 12, libraries: [] }); await f.settle()
  assert.match(f.text(), /添加你的第一个音乐库/u)
})

test('添加反馈：成功只报告登记，扫描状态绑定新root而不借用旧库已完成任务', async t => {
  const newRoot = { root: { id: id(9), sourceRootId: id(10), role: 'library', revision: '1' }, label: '合成新增歌手', availability: 'ONLINE' }
  let imported = false, updated = 0
  const workspace = useLocalWorkbenchLibrary({ api: { localLibraryManagement: async (command: string, payload: any) => {
    if (command === 'library.read') return { datasetId: id(90), revision: '1', scanConcurrency: 12, libraries: [root, ...(imported ? [newRoot] : [])].map(value => ({ libraryId: value.root.id, label: value.label, role: 'artist', online: true, watching: false, latestSnapshotId: null, totalAlbums: 0, totalTracks: 0, scanState: value === newRoot ? 'running' : 'complete' })) }
    if (command === 'library.import.prepare') return { choiceId: 'added-choice', label: newRoot.label, suggestedRole: 'artist', evidence: [] }
    if (command === 'library.import.confirm') { imported = true; return { commandId: payload.commandId, kind: command, state: 'succeeded', libraryIds: [newRoot.root.id], message: null } }
    throw new Error('成功路径只确认一次')
  } } as any, makeCommandId: () => 'added-command' }); t.after(workspace.dispose)
  const api = { listLocalLibraryRoots: async () => [root, ...(imported ? [newRoot] : [])], localLibraryScan: async () => ({ offset: 0, limit: 200, total: imported ? 2 : 1, hasMore: false,
    items: [root, ...(imported ? [newRoot] : [])].map(value => ({ jobId: value.root.id, datasetId: id(90), libraryRootId: value.root.id, sourceRootId: value.root.sourceRootId, rootRevision: '1', jobRevision: '1', phase: value === newRoot ? 'running' : 'completed', progress: { visited: value === newRoot ? '3' : '999', accepted: value === newRoot ? '2' : '999', rejected: '0' } })) }) }
  const f = await mounted(t, path.join(componentRoot, 'settings/LocalLibrarySettings.vue'), { workspace: vue.markRaw(workspace), managementOnly: true, onUpdated: () => updated++ }, api)
  await f.click(f.all().find(el => el.type === 'button' && f.text(el) === '添加音乐文件夹并扫描'))
  assert.equal(workspace.addFeedback.value?.phase, 'added')
  assert.ok(updated > 0)
  const feedback = f.all().find(el => el.props['data-testid'] === 'library-add-feedback')!
  assert.match(f.text(feedback), /已登记.*合成新增歌手/u)
  assert.doesNotMatch(f.text(feedback), /扫描完成|扫描成功/u)
  const card = f.all().find(el => String(el.props.class).split(' ').includes('library-card') && f.text(el).includes(newRoot.label))!
  assert.match(f.text(card), /扫描中.*已处理3.*已收录2/u)
  assert.doesNotMatch(f.text(card), /已完成|999/u)
})
test('009R1 底部播放栏队列入口接回App原焦点路径，打开及关闭保持本地滚动', async t => {
  const appSource = readFileSync(path.join(componentRoot, '../App.vue'), 'utf8'), descriptor = parse(appSource).descriptor
  const source = ts.createSourceFile('App.ts', descriptor.scriptSetup!.content, ts.ScriptTarget.ES2022, true)
  const names = ['rememberInspectorFocus', 'openInspector', 'openQueue', 'closeInspector']
  const functions = source.statements.filter(node => ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)).map(node => node.getText(source)).join('\n')
  assert.equal(functions.match(/function /gu)?.length, 4)
  const findPlayer = (node: any): any => node?.tag === 'BottomPlayer' ? node : node?.children?.map(findPlayer).find(Boolean)
  const player = findPlayer(descriptor.template!.ast); assert.ok(player)
  const binding = player.props.find((prop: any) => prop.name === 'on' && prop.arg?.content === 'open-queue')?.exp?.content
  assert.equal(binding, 'openQueue', '正式App底部播放栏入口须使用已存在的openQueue')
  let dispatch = () => {}
  const api = { queryLocalLibraryTracks: async (query: LocalLibraryQuery) => queryPage(query, 0), listLocalLibraryRoots: async () => [], getLocalLibraryPlaybackTarget: async () => null, localLibraryScan: async () => ({ offset: 0, limit: 200, total: 0, hasMore: false, items: [] }) } as unknown as LocalLibraryPublicApi
  const model = useLocalLibrary({ api, getSelectedZone: () => undefined, play: async () => { throw new Error('焦点测试不得点播') } }); t.after(() => model.dispose())
  // 执行App原完整BottomPlayer节点与正式按钮；只有其他播放控件是无动作表面。
  const template = compileTemplate({ id: 'queue-player-ancestor009', filename: 'App.vue', source: player.loc.source, compilerOptions: { expressionPlugins: ['typescript'] } })
  assert.deepEqual(template.errors, [])
  const rendering = { exports: {} as { render: (...args: any[]) => any } }
  const renderCode = ts.transpileModule(template.code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  new Function('require', 'module', 'exports', renderCode)((name: string) => { assert.equal(name, 'vue'); return vue }, rendering, rendering.exports)
  const unexpected = () => { throw new Error('队列入口测试不得派发其他播放动作') }
  const environment = { playbackClockIdentity: '合成队列焦点时钟', playbackSyncStatus: 'ready', isImmersiveNowPlaying: false,
    currentTrack: undefined, playbackState: null, zones: [], selectedZone: undefined, coreState: null, zoneLifecycleStatus: 'empty', selectedQuality: 'lossless',
    openQueue: () => dispatch(), seekPlayback: unexpected, previousTrack: unexpected, togglePlayback: unexpected, nextTrack: unexpected, openNowPlaying: unexpected, selectZone: unexpected, setSelectedQuality: unexpected }
  let ancestor: import('vue').Component | undefined
  const wrap = (component: import('vue').Component) => ancestor ??= vue.defineComponent({ inheritAttrs: false, components: { BottomPlayer: component }, setup: () => environment, render: rendering.exports.render })
  const unrelated = { default: vue.defineComponent({ setup: () => () => vue.h('span') }) }
  const f = await mounted(t, path.join(componentRoot, 'BottomPlayer.vue'), {}, api, {
    './player/PlayerProgress.vue': unrelated, './player/VolumeControl.vue': unrelated, './player/QualityControl.vue': unrelated, './player/ZoneControl.vue': unrelated,
  }, wrap)
  const trigger = f.all().find(el => el.type === 'button' && el.props['aria-label'] === '打开播放队列'); assert.ok(trigger)
  const close = f.node('button'); close.parent = trigger.parent
  const focusDocument = { get activeElement() { return f.active() }, querySelector: (selector: string) => { assert.equal(selector, '.playback-inspector .inspector-close'); return close } }, inspectorOpen = vue.ref(false), inspectorReturnFocus = vue.ref(null)
  const HostElement = class { static [Symbol.hasInstance](value: any) { return !!value?.props && typeof value.focus === 'function' } }
  const compiled = ts.transpileModule(functions + '\nreturn {openQueue,closeInspector}', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  const handlers = new Function('document', 'HTMLElement', 'inspectorReturnFocus', 'isImmersiveNowPlaying', 'inspectorOpen', 'nextTick', 'exitNowPlaying', compiled)(focusDocument, HostElement, inspectorReturnFocus, vue.ref(false), inspectorOpen, vue.nextTick, () => {})
  dispatch = handlers.openQueue; trigger.focus(); model.scrollTop.value = 168; await f.click(trigger)
  assert.equal(inspectorOpen.value, true); assert.equal(f.active(), close); assert.equal(close.focusOptions?.preventScroll, true)
  handlers.closeInspector(); await f.settle(); assert.equal(inspectorOpen.value, false); assert.equal(f.active(), trigger); assert.equal(trigger.focusOptions?.preventScroll, true); assert.equal(model.scrollTop.value, 168)
})

test('009R1 原Outbox面板传出持久成功终态，确认隐藏后不丢失原命令身份', async t => {
  let acknowledged = false
  const entry = { id: id(70), commandId: id(71), command: 'localCatalog.overrideMetadata' as const, datasetId: id(90), state: 'succeeded' as const, createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z', acknowledged: false, canRetry: false }, observations: any[] = []
  const api = { getCommandOutbox: async () => ({ datasetId: id(90), entries: acknowledged ? [] : [entry] }), acknowledgeCommandOutbox: async () => { acknowledged = true; return { ...entry, acknowledged: true } } }
  const f = await mounted(t, path.join(componentRoot, 'CommandOutboxPanel.vue'), { onOverview: (value: any) => observations.push(value) }, api)
  await f.click(f.all().find(el => el.type === 'button' && f.text(el) === '成功结果已确认'))
  assert.equal(acknowledged, true); assert.match(f.text(), /没有待确认操作/u)
  assert.ok(observations.some(value => value.datasetId === entry.datasetId && value.entries.some((item: any) => item.commandId === entry.commandId && item.command === entry.command && item.state === 'succeeded' && item.acknowledged)))
})

test('009R1 详情触发控件虚拟卸载或离页重建后关闭，恢复原曲目按钮及滚动', async t => {
  const api = { queryLocalLibraryTracks: async (query: LocalLibraryQuery) => queryPage(query), getLocalLibraryTrackDetail: async (trackId: string) => trackDetail(Number(trackId.slice(-12)) - 1000), listLocalLibraryRoots: async () => [root], getLocalLibraryPlaybackTarget: async () => null, localLibraryScan: async () => ({ offset: 0, limit: 200, total: 0, hasMore: false, items: [] }) } as unknown as LocalLibraryPublicApi
  const model = useLocalLibrary({ api, getSelectedZone: () => undefined, play: async () => { throw new Error('焦点验证不得点播') } }); t.after(() => model.dispose())
  const f = await mounted(t, path.join(componentRoot, 'library/LocalLibraryView.vue'), { session: model, playbackState: null }, api)
  const trigger = f.all().find(el => el.props['aria-label'] === '查看 原始曲目 0 的版本与文件详情')!; await f.click(trigger)
  const table = f.all().find(el => el.props.role === 'table')!; table.scrollTop = 102 * 84; table.props.onScroll(f.event(table)); await f.settle()
  assert.equal((trigger as any).isConnected, false)
  await f.click(f.all().find(el => el.props['aria-label'] === '关闭曲目详情')); assert.equal(f.active()?.props['aria-label'], '查看 原始曲目 0 的版本与文件详情'); assert.equal(model.scrollTop.value, 0)
  await f.click(f.active()!); f.unmount()
  const returned = await mounted(t, path.join(componentRoot, 'library/LocalLibraryView.vue'), { session: model, playbackState: null }, api)
  await returned.click(returned.all().find(el => el.props['aria-label'] === '关闭曲目详情')); assert.equal(returned.active()?.props['aria-label'], '查看 原始曲目 0 的版本与文件详情'); assert.equal(model.scrollTop.value, 0)
})

test('009R1 Outbox旧读取错误不掩盖随后收到的真实终态事件', async t => {
  let reads = 0
  const entry = { id: id(70), commandId: id(71), command: 'localCatalog.overrideMetadata' as const, datasetId: id(90), state: 'succeeded' as const, createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z', acknowledged: false, canRetry: false }, observations: any[] = []
  const api = { getCommandOutbox: async () => { if (++reads > 1) throw new Error('合成读故障'); return { datasetId: id(90), entries: [entry] } }, acknowledgeCommandOutbox: async () => ({ ...entry, acknowledged: true }) }
  const f = await mounted(t, path.join(componentRoot, 'CommandOutboxPanel.vue'), { onOverview: (value: any) => observations.push(value) }, api)
  await f.click(f.all().find(el => el.type === 'button' && f.text(el) === '刷新状态')); assert.match(f.text(), /暂时无法读取待确认操作/u)
  await f.click(f.all().find(el => el.type === 'button' && f.text(el) === '成功结果已确认'))
  assert.ok(observations.some(value => value.entries.some((item: any) => item.commandId === entry.commandId && item.state === 'succeeded' && item.acknowledged)))
})

// 仅组件层受控接线：真实设置 SFC、原 App 监听与两页纯读模型；不代表实际 Owner 或普通 App。
function settingsUpdatedAncestor593(t: test.TestContext, environment: Record<string, unknown>, onUpdated: (work: Promise<void>) => void, observationLibrary: ReturnType<typeof useLocalWorkbenchLibrary>, onObserved: (work: Promise<void>) => void = () => {}): (component: import('vue').Component) => import('vue').Component {
  const { descriptor } = parse(readFileSync(path.resolve(componentRoot, '../App.vue'), 'utf8'))
  const settings: any[] = []
  const visit = (node: any): void => { if (node?.type === 1 && node.tag === 'SettingsView') settings.push(node); for (const child of node?.children ?? []) visit(child) }
  visit(descriptor.template?.ast); assert.equal(settings.length, 1, '只消费原 App 的唯一设置入口')
  const source = descriptor.scriptSetup!.content
  const start = source.indexOf('// 首扫原任务观察开始：'), end = source.indexOf('// 首扫原任务观察结束。', start)
  assert.ok(start >= 0 && end > start, '设置事件必须执行原完整扫描观察闭包，不能只抽出转发函数')
  const compile = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const observation = new Function('albumBrowser', 'coverDropBrowser', 'localLibrary', 'workbenchLibrary', 'currentView', 'shallowRef', 'ref', 'localWorkbenchDto', 'logLibraryOperation',
    `${compile(source.slice(start, end))}\nreturn { refresh: refreshLocalBrowserViews, observe: ()=>requestInitialScanRefresh(false), close: closeInitialScanObservation };`)(
    environment.albumBrowser, environment.coverDropBrowser, environment.localLibrary, observationLibrary, vue.ref(environment.currentView), vue.shallowRef, vue.ref, localWorkbenchDto, libraryOperationLog.logLibraryOperation,
  ) as { refresh(): Promise<void>; observe(): Promise<void>; close(): void }
  t.after(observation.close)
  // 原完整节点包含全部 props、事件和 slot；补一个永假前邻，仅使原 v-else-if 在此受控祖链合法编译。
  const template = compileTemplate({ id: 'settings-ancestor593', filename: 'App.vue', source: `<template v-if="false"></template>${settings[0].loc.source}`, compilerOptions: { expressionPlugins: ['typescript'] } })
  assert.deepEqual(template.errors, [])
  const module = { exports: {} as { render: (...args: any[]) => any } }
  new Function('require', 'module', 'exports', compile(template.code))((name: string) => { assert.equal(name, 'vue'); return vue }, module, module.exports)
  const state = { ...environment, refreshLocalBrowserViews: () => { const work = observation.refresh(); onUpdated(work); return work },
    requestInitialScanRefresh: (refresh: boolean) => { assert.equal(refresh, false); const work = observation.observe(); onObserved(work); return work } }
  let ancestor: import('vue').Component | undefined
  return component => ancestor ??= vue.defineComponent({ inheritAttrs: false, components: { SettingsView: component }, setup: () => state, render: module.exports.render })
}

test('009设置目录变化向上传递一次，失效两页原读范围且挂载和同状态轮询不追加刷新', async t => {
  const { useLocalAlbumBrowserPages } = await import('../src/renderer/src/composables/application/local-library-browser/useLocalAlbumBrowser.js')
  const settingsNavigation = await import('../src/renderer/src/composables/useSettingsNavigation.js')
  const zoneLifecycle = await import('../src/renderer/src/zone-lifecycle.js')
  type AlbumQuery = import('../src/renderer/src/composables/application/local-library-browser/types.js').LocalAlbumQuery
  type AlbumPage = import('../src/renderer/src/composables/application/local-library-browser/types.js').LocalAlbumPage
  let revision = '1', rootReads = 0, trackReads = 0, updates = 0, workspaceReads = 0, accepted = '0', observations = 0, availability = 'ONLINE', rootPresent = true
  const albumRequests: AlbumQuery[] = [], pending: Promise<void>[] = []
  let held: { request: AlbumQuery; resolve(value: AlbumPage): void } | undefined, holdNext = false
  const albumPage = (request: AlbumQuery): AlbumPage => ({ ...request, total: 1, hasMore: false,
    counts: { all: 1, 'missing-artwork': 0, 'missing-lyrics': 0, 'has-artwork': 1, 'cue-unsplit': 0, 'metadata-issue': 0, 'parse-failed': 0, 'loose-audio': 0, 'track-named-audio': 0 },
    items: [{ id: `edition-settings-${request.rootId}`, kind: 'edition', rootId: request.rootId!, editionId: id(300), title: `${request.query}原专辑`, artists: ['合成艺人'],
      year: '2000', versionLabel: '原发行', sourceLabel: '合成目录', trackCount: 3, representativeTrackId: id(1000), revision, artworkAvailable: true, statuses: ['has-artwork'] }] })
  const scope = vue.effectScope(), pages = scope.run(() => useLocalAlbumBrowserPages({ api: {
    queryAlbums: request => { albumRequests.push({ ...request }); if (holdNext) { holdNext = false; return new Promise<AlbumPage>(resolve => { held = { request, resolve } }) } return Promise.resolve(albumPage(request)) },
    queryAlbumTracks: async () => { throw new Error('此事件链不得发详情请求') },
    getArtwork: async () => { throw new Error('此事件链不得申请图片') },
  } }))!
  t.after(() => scope.stop())
  await pages.localLibrary.setScope({ query: '本地', rootId: id(1), filter: 'all' }); await pages.localLibrary.activate()
  await pages.coverDrop.setScope({ query: '整理', rootId: id(2), filter: 'has-artwork' }); await pages.coverDrop.activate(); pages.coverDrop.deactivate()
  assert.equal(albumRequests.length, 2)
  assert.equal(pages.localLibrary.snapshot.value.stale, false); assert.equal(pages.coverDrop.snapshot.value.stale, false)
  const api = { listLocalLibraryRoots: async () => { rootReads++; return rootPresent ? [{ ...root, availability, root: { ...root.root, revision } }] : [] },
    localLibraryScan: async (command: string) => { assert.equal(command, 'localScan.page', '设置读取不启动扫描或写操作'); return { offset: 0, limit: 200, total: accepted === '0' ? 0 : 1, hasMore: false,
      items: accepted === '0' ? [] : [{ schemaVersion: '1.2', jobId: id(70), datasetId: id(71), libraryRootId: root.root.id, sourceRootId: root.root.sourceRootId, rootRevision: revision,
        jobRevision: '1', checkpointRef: null, phase: 'running', progress: { visited: accepted, accepted, rejected: '0' }, failureCode: null }] } },
    listLocalLibraryTracks: async () => { trackReads++; return { items: [], hasMore: false } },
    queryLocalLibraryTracks: async (request: LocalLibraryQuery) => queryPage(request, 0), getLocalLibraryPlaybackTarget: async () => null,
  } as unknown as LocalLibraryPublicApi
  const session = useLocalLibrary({ api, getSelectedZone: () => undefined, play: async () => { throw new Error('设置更新不得播放') } }); t.after(() => session.dispose())
  // 仅其他设置模块是无动作表面；被检验的 SettingsView / LocalLibrarySettings 均加载原 SFC。
  const unrelated = { default: vue.defineComponent({ setup: () => () => vue.h('span') }) }
  const environment = { currentView: 'settings', appInfo: null, workbenchLibrary: undefined, authState: { status: 'idle' }, accountState: { status: 'missing' },
    zones: [], selectedZone: undefined, coreState: null, zoneLifecycleStatus: 'empty', selectedQuality: 'lossless', authError: false, accountError: null,
    remoteCoreState: { status: 'idle' }, remoteAutoStart: false, remoteSshTarget: '', localLibrary: session, albumBrowser: pages.localLibrary, coverDropBrowser: pages.coverDrop }
  // 原节点的其他账户/播放/远端事件只保绑定，不属于此受控例；意外触发必须失败。
  Object.assign(environment, Object.fromEntries(['beginQrLogin', 'cancelQrLogin', 'logout', 'refreshAccountProfile', 'setSelectedQuality', 'selectZone', 'loadZones', 'navigate', 'startRemoteCore', 'stopRemoteCore', 'reconnectRemoteCore', 'updateRemoteAutoStart', 'updateRemoteSshTarget'].map(name => [name, () => { throw new Error('此受控设置事件不应触发其他业务') }])))
  // 此例保留没有工作台Owner的旧设置入口；执行真实Controller失败回读，再走App原刷新分支。
  const observationLibrary = useLocalWorkbenchLibrary({ api: {
    async localLibraryManagement(command) { assert.equal(command, 'library.read'); workspaceReads++; throw new Error('此合成旧设置入口尚无工作台Owner') },
    async localNameSettings() { throw new Error('设置目录变化不读取模型配置') },
  } })
  t.after(() => observationLibrary.dispose())
  const wrap = settingsUpdatedAncestor593(t, environment, work => { updates++; pending.push(work) }, observationLibrary, work => { observations++; pending.push(work) })
  const f = await mounted(t, path.join(componentRoot, 'settings/SettingsView.vue'), {}, api, {
    './AppearanceSettings.vue': unrelated, './CollectionReadonlySettings.vue': unrelated, './LocalAiSettings.vue': unrelated,
    './MobileConnectionSettings.vue': unrelated, './RoonDisplaySettings.vue': unrelated,
    '../../composables/useSettingsNavigation.js': settingsNavigation, '../../zone-lifecycle.js': zoneLifecycle,
  }, wrap)
  t.after(async () => { if (held) held.resolve(albumPage(held.request)); await Promise.all(pending) })
  assert.equal(rootReads, 0); assert.equal(updates, 0); assert.equal(workspaceReads, 0)
  assert.equal(f.all().find(el => el.props.role === 'tab' && el.props['aria-selected'] === true)?.props['data-settings-category'], 'application')
  await f.click(f.all().find(el => el.type === 'button' && el.props.role === 'tab' && el.props['data-settings-category'] === 'library'))
  assert.equal(rootReads, 1); assert.equal(trackReads, 0, '默认音乐库设置不逐曲读取'); assert.equal(updates, 0); assert.equal(albumRequests.length, 2, '原设置挂载不追加专辑查询')
  revision = '2'; await f.poll(); await Promise.all(pending)
  assert.equal(updates, 1); assert.equal(rootReads, 2); assert.equal(trackReads, 0); assert.equal(workspaceReads, 1)
  assert.equal(pages.localLibrary.snapshot.value.stale, true); assert.equal(pages.coverDrop.snapshot.value.stale, true)
  assert.equal(pages.localLibrary.snapshot.value.active, false); assert.equal(pages.coverDrop.snapshot.value.active, false)
  assert.equal(albumRequests.length, 2, '失效不激活后台页面，也不主动登记或扫描')
  assert.equal(pages.localLibrary.snapshot.value.items[0]!.revision, '1'); assert.equal(pages.coverDrop.snapshot.value.items[0]!.revision, '1')
  await f.poll(); assert.equal(updates, 1, '同一设置事实不重复发送变化事件'); assert.equal(albumRequests.length, 2); assert.equal(workspaceReads, 1)
  await pages.coverDrop.activate(); assert.equal(pages.coverDrop.snapshot.value.items[0]!.revision, '2')
  assert.equal(pages.localLibrary.snapshot.value.items[0]!.revision, '1')
  revision = '3'; holdNext = true; await f.poll()
  assert.equal(updates, 2); assert.equal(albumRequests.length, 4); assert.ok(held)
  assert.deepEqual(held.request, { query: '整理', rootId: id(2), filter: 'has-artwork', offset: 0, limit: 200 })
  assert.equal(pages.coverDrop.snapshot.value.refreshing, true); assert.equal(pages.localLibrary.snapshot.value.stale, true)
  assert.equal(pages.coverDrop.snapshot.value.items[0]!.revision, '2', '原刷新未返回前继续保留原成功结果')
  held.resolve(albumPage(held.request)); await Promise.all(pending)
  assert.equal(pages.coverDrop.snapshot.value.items[0]!.revision, '3'); assert.equal(pages.coverDrop.snapshot.value.refreshing, false)
  assert.equal(pages.localLibrary.snapshot.value.query, '本地'); assert.equal(pages.localLibrary.snapshot.value.rootId, id(1)); assert.equal(pages.localLibrary.snapshot.value.filter, 'all')
  assert.equal(pages.coverDrop.snapshot.value.query, '整理'); assert.equal(pages.coverDrop.snapshot.value.rootId, id(2)); assert.equal(pages.coverDrop.snapshot.value.filter, 'has-artwork')
  await pages.localLibrary.activate(); assert.equal(pages.localLibrary.snapshot.value.items[0]!.revision, '3')
  assert.equal(pages.coverDrop.snapshot.value.active, false)
  assert.equal(trackReads, 0, '设置轮询与目录更新不隐式展开逐曲找回')
  const beforeProgress = albumRequests.length
  accepted = '1'; await f.poll(); await Promise.all(pending)
  assert.equal(observations, 1, '真实LocalLibrarySettings→SettingsView→App必须转发观察事件')
  assert.equal(updates, 2); assert.equal(albumRequests.length, beforeProgress, '观察不能冒充用户强制刷新绕过节流')
  availability = 'SOURCE_ROOT_OFFLINE'; await f.poll(); await Promise.all(pending)
  assert.equal(updates, 3); assert.equal(albumRequests.length, beforeProgress + 1, '目录离线仍立即刷新原活跃范围')
  rootPresent = false; await f.poll(); await Promise.all(pending)
  assert.equal(updates, 4); assert.equal(albumRequests.length, beforeProgress + 2)
})

test('设置音乐库默认不读逐曲或AI配置，手动找回按50首读取且关闭后拒绝迟回元数据', async t => {
  let workspaceReads = 0, nameReads = 0, metadataReads = 0, holdNext = false
  const requests: unknown[] = [], tracks = { items: [{ id: id(1000), assetId: id(2000), selectionRevision: '1', segment: null }], hasMore: false }
  let release: ((value: typeof tracks) => void) | undefined
  const workspace = vue.markRaw(useLocalWorkbenchLibrary({ api: {
    async localLibraryManagement(command) { assert.equal(command, 'library.read'); workspaceReads++; throw new Error('合成设置没有工作台Owner') },
    async localNameSettings() { nameReads++; throw new Error('音乐库默认设置不得读取AI配置') },
  } }))
  t.after(() => workspace.dispose()); t.after(() => release?.(tracks))
  const api = {
    listLocalLibraryRoots: async () => [root], localLibraryScan: async (command: string) => { assert.equal(command, 'localScan.page'); return { offset: 0, limit: 200, total: 0, hasMore: false, items: [] } },
    listLocalLibraryTracks: async (request: unknown) => { requests.push(request); if (holdNext) { holdNext = false; return new Promise<typeof tracks>(resolve => { release = resolve }) } return tracks },
    getLocalLibraryMetadata: async (trackId: string) => { assert.equal(trackId, id(1000)); metadataReads++; return { effective: { title: '合成找回曲目' } } },
  }
  const f = await mounted(t, path.join(componentRoot, 'settings/LocalLibrarySettings.vue'), { workspace }, api)
  assert.equal(workspaceReads, 1); assert.equal(nameReads, 0); assert.equal(requests.length, 0); assert.equal(metadataReads, 0)
  const recovery = f.all().find(element => element.type === 'details' && element.children.some(child => child.type === 'summary' && f.text(child).includes('逐曲找回文件')))
  assert.ok(recovery)
  const toggle = async (open: boolean) => { (recovery as any).open = open; recovery.props.onToggle(f.event(recovery)); await f.settle() }
  await toggle(true)
  assert.deepEqual(requests, [{ offset: 0, limit: 50 }]); assert.equal(metadataReads, 1); assert.match(f.text(recovery), /合成找回曲目/u)
  assert.ok(f.all(recovery).some(element => element.type === 'button' && f.text(element) === '外部改名后重新定位'))
  await toggle(false); assert.equal(nameReads, 0); assert.equal(requests.length, 1)
  holdNext = true; await toggle(true); assert.equal(requests.length, 2); assert.ok(release)
  await toggle(false); release(tracks); await f.settle()
  assert.equal(metadataReads, 1, '关闭找回后，在途曲目页不得继续派发逐曲元数据读取')
  assert.equal(nameReads, 0); assert.equal(workspaceReads, 1)
})

// 只验证原 App 读取入口的友好阶段提示；受控回调不代表真实 Owner、Native 或普通 App。
test('009整理读取失败按原阶段回显，真实上下文未确认与换代不绑定且不泄露内部错误', async () => {
  const { descriptor } = parse(readFileSync(path.resolve(componentRoot, '../App.vue'), 'utf8'))
  const script = ts.createSourceFile('App.vue.ts', descriptor.scriptSetup!.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const functions = ['loadWorkspace', 'captureWorkbenchTargets'].map(name => {
    const found = script.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name)
    assert.equal(found.length, 1); return found[0]!.getText(script)
  })
  const declarations = script.statements.filter(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === 'workspaceLoading'))
  assert.equal(declarations.length, 1)
  const code = ts.transpileModule(`${declarations[0]!.getText(script)}\n${functions.join('\n')}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  type Failure = 'none' | 'capabilities' | 'library-read' | 'name-read' | 'ports' | 'capture' | 'open' | 'closed' | 'context' | 'context-null' | 'open-library' | 'held-capture'
  const target = { albumKey: '原专辑', rootId: id(1), revision: '原修订' }, captured = { datasetId: id(90), snapshotId: '本次作者快照', albums: [{ album: { albumId: '原专辑', rootId: id(1) } }] }
  function fixture(failure: Failure) {
    const calls: string[] = [], rpc: { command: string; payload: unknown }[] = [], contexts: unknown[] = []
    const entryError = vue.ref(''), opening = vue.ref(false), error = vue.ref('原错误保留'), isOpen = vue.ref(false), currentView = vue.ref('coverdrop'), readback = vue.shallowRef<typeof captured | null>(null)
    let inspectedError = 0, rejectCapture!: (error: Error) => void, enterCapture!: () => void
    const entered = new Promise<void>(resolve => { enterCapture = resolve }), held = new Promise<never>((_resolve, reject) => { rejectCapture = reject })
    const privateError = Object.defineProperties(new Error(), { message: { get() { inspectedError++; return '合成内部原因 secret-marker' } }, stack: { get() { inspectedError++; throw new Error('不得读取内部stack') } } })
    const fail = (stage: Failure): void => { if (failure === stage) throw privateError }
    const environment = {
      window: { musicBridge: { localWorkbenchCapabilities: async () => { calls.push('capabilities'); fail('capabilities'); return {} },
        localLibraryManagement: async (command: string, payload: unknown) => { calls.push('capture'); rpc.push({ command, payload: structuredClone(payload) }); fail('capture'); if (failure === 'held-capture') { enterCapture(); return held } return captured } } },
      workbenchLibrary: { state: vue.ref({ datasetId: id(90) }), selectedLibraryIds: vue.ref([id(1)]), read: async () => { calls.push('library-read'); fail('library-read'); return true },
        readNameSettings: async () => { calls.push('name-read'); fail('name-read'); return true },
        captureLibraries: async (roots?: readonly string[]) => { calls.push('context'); contexts.push(roots); fail('context'); return failure === 'context-null' ? null : { datasetId: id(90), lyricsLibraries: [] } } },
      workbenchPorts: {}, createLocalWorkbenchRendererPorts: () => { calls.push('ports'); fail('ports'); return {} },
      openOriginalMaintenance: () => { throw new Error('此受控入口不派发其他维护') }, maintenanceUiGeneration: 0,
      currentView, coverDropViewRef: vue.ref(null), localMaintenanceAvailability: () => false, localMaintenanceOpened: () => false,
      workbench: { isOpen, readback, error, openLibrary: () => { calls.push('open-library'); fail('open-library') },
        open: async () => { calls.push('open'); fail('open'); isOpen.value = failure !== 'closed'; readback.value = failure === 'closed' ? null : captured } },
      workbenchLyrics: { bind: () => { calls.push('lyrics-bind') } }, bindWorkbenchLyrics: () => { calls.push('bind') },
      workbenchEntryError: entryError, workbenchOpening: opening,
    }
    const body = `const {window,workbenchLibrary,workbenchPorts,createLocalWorkbenchRendererPorts,openOriginalMaintenance,maintenanceUiGeneration,currentView,coverDropViewRef,localMaintenanceAvailability,localMaintenanceOpened,workbench,workbenchLyrics,bindWorkbenchLyrics,workbenchEntryError,workbenchOpening}=environment;\n${code}\nreturn {loadWorkspace,captureWorkbenchTargets,advance:()=>{workbenchOpenGeneration++}};`
    const runtime = new Function('environment', body)(environment) as { loadWorkspace(): Promise<boolean>; captureWorkbenchTargets(intent: unknown): Promise<void>; advance(): void }
    return { runtime, calls, rpc, contexts, entryError, opening, error, isOpen, entered, rejectCapture, privateError, inspected: () => inspectedError }
  }
  const initial = ['capabilities', 'library-read', 'name-read', 'ports']
  const failures: [Failure, string, string[]][] = [
    ['capabilities', '整理入口尚未就绪，尚未准备任何写入。请重新读取。', ['capabilities']],
    ['library-read', '整理入口尚未就绪，尚未准备任何写入。请重新读取。', initial.slice(0, 3)],
    ['name-read', '整理入口尚未就绪，尚未准备任何写入。请重新读取。', initial.slice(0, 3)],
    ['ports', '整理入口尚未就绪，尚未准备任何写入。请重新读取。', initial],
    ['capture', '完整专辑捕获未获确认，尚未准备任何写入。请重新读取。', [...initial, 'capture']],
    ['open', '专辑工作区打开未获确认，尚未准备任何写入。请重新读取。', [...initial, 'capture', 'open']],
    ['closed', '专辑工作区打开未获确认，尚未准备任何写入。请重新读取。', [...initial, 'capture', 'open']],
  ]
  for (const [failure, expected, sequence] of failures) {
    const f = fixture(failure); await f.runtime.captureWorkbenchTargets({ action: 'overview', albums: [target] })
    assert.equal(f.entryError.value, expected, failure); assert.equal(f.error.value, expected); assert.deepEqual(f.calls, sequence)
    assert.equal(f.opening.value, false); assert.equal(f.inspected(), 0)
    assert.doesNotMatch(f.entryError.value, /secret-marker|合成内部|stack|file:/u)
    assert.equal(f.rpc.length, sequence.includes('capture') ? 1 : 0)
  }
  const whole = fixture('open-library'); await whole.runtime.captureWorkbenchTargets({ action: 'lyrics', albums: [] })
  assert.match(whole.entryError.value, /^专辑工作区打开未获确认/u); assert.deepEqual(whole.calls, [...initial, 'open-library']); assert.equal(whole.rpc.length, 0)
  for (const albums of [[target], [target, { ...target, albumKey: '另一原专辑' }]]) {
    const f = fixture('none'); await f.runtime.captureWorkbenchTargets({ action: 'overview', albums })
    assert.equal(f.entryError.value, ''); assert.deepEqual(f.calls, [...initial, 'capture', 'open', 'bind'])
    assert.deepEqual(f.rpc, [{ command: albums.length === 1 ? 'library.album.capture' : 'library.albums.capture', payload: albums.length === 1 ? { albumId: target.albumKey, rootId: target.rootId, revision: target.revision }
      : { albums: albums.map(value => ({ albumId: value.albumKey, rootId: value.rootId, revision: value.revision })) } }])
    assert.deepEqual(f.contexts, [], '打开专辑不隐式捕获整个根'); assert.equal(f.opening.value, false)
  }
  for (const failure of ['context', 'context-null'] as const) {
    const f = fixture(failure); await f.runtime.captureWorkbenchTargets({ action: 'overview', albums: [] })
    assert.match(f.entryError.value, /^音乐库读取未获确认/u); assert.equal(f.error.value, f.entryError.value, '有明确范围但未获确认时保留原context阶段错误')
    assert.deepEqual(f.calls, [...initial, 'open-library', 'context'])
    assert.equal(f.calls.includes('bind') || f.calls.includes('lyrics-bind'), false, 'null不使用已有捕获继续绑定')
  }
  const late = fixture('held-capture'), running = late.runtime.captureWorkbenchTargets({ action: 'overview', albums: [target] })
  await late.entered; late.runtime.advance(); late.rejectCapture(late.privateError); await running
  assert.equal(late.entryError.value, ''); assert.equal(late.error.value, '原错误保留'); assert.equal(late.inspected(), 0)
  assert.deepEqual(late.calls, [...initial, 'capture']); assert.equal(late.rpc.length, 1, '换代不重发原请求')
})

test('009CoverDrop原刷新拒绝显示安全告警且保旧结果，只有手动重试追加同范围读取', async t => {
  const { createLocalAlbumBrowserModel } = await import('../src/renderer/src/composables/application/local-library-browser/model.js')
  type AlbumQuery = import('../src/renderer/src/composables/application/local-library-browser/types.js').LocalAlbumQuery
  type AlbumPage = import('../src/renderer/src/composables/application/local-library-browser/types.js').LocalAlbumPage
  type Snapshot = import('../src/renderer/src/composables/application/local-library-browser/types.js').LocalAlbumBrowserSnapshot
  const requests: AlbumQuery[] = [], state = vue.shallowRef<Snapshot>()
  let release!: (page: AlbumPage) => void
  const page = (request: AlbumQuery, revision = '1'): AlbumPage => ({ ...request, total: 1, hasMore: false,
    counts: { all: 1, 'missing-artwork': 0, 'missing-lyrics': 0, 'has-artwork': 0, 'cue-unsplit': 0, 'metadata-issue': 0, 'parse-failed': 0, 'loose-audio': 0, 'track-named-audio': 0 },
    items: [{ id: 'refresh-error-original-album', kind: 'source-directory', rootId: id(1), editionId: null, title: '原成功专辑', artists: ['合成艺人'], year: null,
      versionLabel: null, sourceLabel: '合成自有库', trackCount: 1, representativeTrackId: id(1000), revision, artworkAvailable: false, artworkState: 'unknown', statuses: [] }] })
  const model = createLocalAlbumBrowserModel({ onChange: value => { state.value = value }, api: {
    queryAlbums: async request => { requests.push({ ...request }); if (requests.length === 2) throw new Error('合成私有拒绝 secret-marker /private-only')
      if (requests.length === 3) return new Promise<AlbumPage>(resolve => { release = resolve }); return page(request) },
    queryAlbumTracks: async () => { throw new Error('刷新告警不得读取详情') }, getArtwork: async () => { throw new Error('刷新告警不得读取封面') },
  } })
  t.after(() => model.dispose()); state.value = model.getSnapshot(); await model.activate()
  const success = model.getSnapshot(); assert.equal(success.total, 1); assert.equal(requests.length, 1)
  const originalSource = readFileSync(path.join(componentRoot, 'library/CoverDropView.vue'), 'utf8'), { descriptor } = parse(originalSource)
  const nodes: any[] = []
  const visit = (node: any): void => { if (node?.type === 1 && node.tag === 'p' && node.props.some((prop: any) => prop.type === 7 && prop.name === 'if' && prop.exp?.content === 'state.refreshError || state.stale && state.refreshing')) nodes.push(node)
    for (const child of node?.children ?? []) visit(child) }
  visit(descriptor.template?.ast); assert.equal(nodes.length, 1, '只渲染实际CoverDrop完整告警节点，不复制文案或事件实现')
  const compiled = compileTemplate({ id: 'coverdrop-refresh-error620', filename: 'CoverDropView.vue', source: nodes[0].loc.source })
  assert.deepEqual(compiled.errors, [])
  const module = { exports: {} as { render: (...args: any[]) => any } }
  const code = ts.transpileModule(compiled.code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  new Function('require', 'module', 'exports', code)((name: string) => { assert.equal(name, 'vue'); return vue }, module, module.exports)
  const retries: Promise<void>[] = [], browser = { refresh: () => { const work = model.refresh(); retries.push(work); return work } }
  const fragment = vue.defineComponent({ setup: () => ({ state, browser }), render: module.exports.render })
  // 沿原mounted宿主；仅实例化上述真实CD节点，不据此称完整CoverDrop/App/Owner挂载已验。
  const f = await mounted(t, path.join(componentRoot, 'library/LocalLibraryView.vue'), {}, {}, {}, () => fragment)
  assert.equal(requests.length, 1, '呈现告警节点不能启动额外读取'); assert.equal(f.all().filter(el => el.props.role === 'alert').length, 0)
  await model.refresh(); await f.settle()
  assert.equal(requests.length, 2); assert.equal(model.getSnapshot().stale, true); assert.equal(model.getSnapshot().loaded, true)
  assert.equal(model.getSnapshot().items, success.items); assert.equal(model.getSnapshot().total, 1)
  const alert = f.all().find(el => el.props.role === 'alert')!; assert.ok(alert)
  assert.ok(f.text(alert).includes(model.getSnapshot().refreshError)); assert.doesNotMatch(f.text(), /secret-marker|private-only|Error:|stack/u)
  const retry = f.all(alert).find(el => el.type === 'button' && f.text(el) === '重试读取')!; assert.ok(retry); assert.equal(retry.props.disabled, false)
  await f.click(retry)
  assert.equal(requests.length, 3); assert.deepEqual(requests[2], requests[0]); assert.equal(retries.length, 1)
  assert.equal(model.getSnapshot().refreshing, true); assert.equal(retry.props.disabled, true)
  assert.ok(f.all().includes(alert)); assert.ok(f.all().includes(retry), '原告警与按钮在重试中仍为真实Host节点')
  assert.ok(f.text(alert).includes('正在重新读取专辑…'))
  assert.equal(model.getSnapshot().items, success.items); assert.equal(model.getSnapshot().total, 1)
  release(page(requests[2]!, '2')); await Promise.all(retries); await f.settle()
  assert.equal(model.getSnapshot().stale, false); assert.equal(model.getSnapshot().refreshError, '')
  assert.equal(model.getSnapshot().items[0]!.revision, '2'); assert.equal(model.getSnapshot().total, 1)
  assert.equal(f.all().filter(el => el.props.role === 'alert').length, 0); assert.equal(requests.length, 3)
  t.diagnostic('受控Vue原SFC告警片段与真实只读model行为；不运行Electron/DefaultOwner/普通App，不归因为619。')
})

test('1132返回封面：正式LocalLibraryView父v-if卸载释放显示节点，回入复用七图压缩缓存', async t => {
  const { useLocalAlbumBrowserPages } = await import('../src/renderer/src/composables/application/local-library-browser/useLocalAlbumBrowser.js')
  const { LOCAL_ALBUM_ARTWORK_CACHE_BYTES } = await import('../src/renderer/src/composables/application/local-library-browser/model.js')
  type Album = import('../src/renderer/src/composables/application/local-library-browser/types.js').LocalAlbumSummary
  type AlbumQuery = import('../src/renderer/src/composables/application/local-library-browser/types.js').LocalAlbumQuery
  type AlbumPage = import('../src/renderer/src/composables/application/local-library-browser/types.js').LocalAlbumPage
  type TrackQuery = import('../src/renderer/src/composables/application/local-library-browser/types.js').LocalAlbumTrackQuery
  type TrackPage = import('../src/renderer/src/composables/application/local-library-browser/types.js').LocalAlbumTrackPage
  type ArtworkRequest = import('../src/renderer/src/composables/application/local-library-browser/types.js').LocalAlbumArtworkRequest
  type ArtworkReply = import('../src/renderer/src/composables/application/local-library-browser/types.js').LocalAlbumArtworkReply
  const values: Album[] = Array.from({ length: 7 }, (_, index) => ({ id: `post1132-album-${index + 1}`, kind: 'edition', rootId: root.root.id,
    editionId: id(300 + index), title: `生命周期专辑 ${index + 1}`, artists: ['合成作者'], year: '2000', versionLabel: '合成原版', sourceLabel: root.label,
    trackCount: 1, representativeTrackId: item(index + 1).track.id, revision: '1', artworkAvailable: true, artworkState: 'available', statuses: ['has-artwork'] }))
  // 复用既有自有16×16 JPEG种子；Host只核对合同、IMG与事件，不声称真实解码。
  const bytes = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAgMDAwMDBAcFBAQEBAkGBwUHCgkLCwoJCgoMDREODAwQDAoKDhQPEBESExMTCw4UFhQSFhESExL/2wBDAQMDAwQEBAgFBQgSDAoMEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhL/wAARCAAQABADAREAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5++FfwE/1P+jen8NbUZHmcO8Xbe8fVGj/AAZTRPBmqXkoa08qycJMoIKSMNqEEcj5ivPbrxX0GVyprEwlVaUIvmk5NKKjHWTbellFNu/Q/R8+8QVlnC+OxPtnCSpyUZK91OS5YW5dU+dxSfR6tpK657Qvj94D8OQ3A8NaRrHiCW2EZhnMIs7WfO0t875lXALDmLllwOCGr34eHeLwWCePzfEQw9CCbm23KUei0jpJydkkpXd0knL3T8G4D8NuIMZKl9brQoqV7q/PNb20XuO+n/LzRO71VjP+NP7VHjrX/Ad1p3grQdI8N6bqt1awwTGM3V3blSJWYu/7pwTEy4MQwH9QDX4rmEcv4nzGlhqc6n1WmnKUXaHtZbLnUW3GMG04xVRpyjzy3jGH7txx4fZBknBijj6k8RUrVIwfvckFq6ifKk57QS/iLV3va8X/AP/Z', 'base64')
  const info = { mime: 'image/jpeg' as const, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), width: 16, height: 16 }
  const image: import('@music-bridge/contracts').LocalArtworkImage = { original: info, display: { ...info, dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}` } }
  // 同一自有JPEG加合法COM段，形成可区分的持久grid副本；只验证合同与IMG接线，不冒真实像素处理。
  const gridBytes = Buffer.concat([bytes.subarray(0, 2), Buffer.from([255, 254, 0, 6, 71, 82, 73, 68]), bytes.subarray(2)])
  const grid: import('@music-bridge/contracts').LocalAlbumArtworkGrid = { ...info, bytes: gridBytes.length, sha256: createHash('sha256').update(gridBytes).digest('hex'), dataUrl: `data:image/jpeg;base64,${gridBytes.toString('base64')}` }
  assert.equal(localWorkbenchDto.isLocalAlbumArtworkGrid(grid), true); assert.notEqual(grid.dataUrl, image.display.dataUrl)
  // 正式pages只常驻紧凑grid；dataUrl与grid.dataUrl是同一引用，只按UTF-16计一份。
  const expectedBytes = values.length * grid.dataUrl.length * 2
  assert.ok(expectedBytes < LOCAL_ALBUM_ARTWORK_CACHE_BYTES / 2, '七图低于单页共享缓存份额，隔离实际切页而非LRU淘汰')
  const requestFor = (value: Album): ArtworkRequest => ({ albumKey: value.id, rootId: value.rootId, editionId: value.editionId, representativeTrackId: value.representativeTrackId, revision: value.revision })
  const albumPage = (request: AlbumQuery): AlbumPage => ({ ...request, total: values.length, hasMore: false, items: values,
    counts: { all: values.length, 'has-artwork': values.length, 'missing-artwork': 0, 'missing-lyrics': 0, 'cue-unsplit': 0, 'metadata-issue': 0, 'parse-failed': 0, 'loose-audio': 0, 'track-named-audio': 0 } })
  const trackPage = (request: TrackQuery): TrackPage => {
    const index = values.findIndex(value => value.id === request.albumKey && value.rootId === request.rootId), selected = values[index]
    assert.ok(selected, '详情必须绑定实际专辑身份')
    const source = item(index + 1), metadata = { ...source.metadata, album: selected.title }
    return { ...request, album: selected, total: 1, hasMore: false, items: [{ facts: { track: source.track, asset: source.asset,
      metadata: { raw: metadata, effective: metadata, override: null }, versionTokens: source.versionTokens,
      editions: [{ id: selected.editionId!, title: selected.title, edition: selected.versionLabel!, revision: selected.revision }], fileParameters: null },
    disc: 1, trackNumber: 1, sequence: 1, statuses: ['has-artwork'] }] }
  }
  const queries: AlbumQuery[] = [], artworkRequests: ArtworkRequest[] = [], detailRequests: TrackQuery[] = [], publications: unknown[] = [], trace: unknown[] = []
  const heldArtwork: { request: ArtworkRequest; resolve(reply: ArtworkReply): void }[] = []
  let holdArtwork = false
  const scope = vue.effectScope(), pages = scope.run(() => useLocalAlbumBrowserPages({ api: {
    queryAlbums: request => { queries.push({ ...request }); return Promise.resolve(albumPage(request)) },
    queryAlbumTracks: async request => { detailRequests.push({ ...request }); return trackPage(request) },
    getArtwork: request => { artworkRequests.push({ ...request }); return holdArtwork ? new Promise<ArtworkReply>(resolve => heldArtwork.push({ request: { ...request }, resolve })) : Promise.resolve({ ...request, image, grid }) },
  }, onChange: state => publications.push({ active: state.active, selectedAlbum: state.selectedAlbum?.id ?? null, epoch: state.artworkInvalidation?.epoch ?? 0,
    artwork: Object.entries(state.artwork).map(([albumKey, value]) => ({ albumKey, status: value.status, hasDataUrl: value.dataUrl !== null })) }) }))!
  t.after(() => scope.stop())
  const api = { queryLocalLibraryTracks: async (request: LocalLibraryQuery) => queryPage(request, 0), listLocalLibraryRoots: async () => [root],
    getLocalLibraryPlaybackTarget: async () => null, localLibraryScan: async () => ({ offset: 0, limit: 200, total: 0, hasMore: false, items: [] }) } as unknown as LocalLibraryPublicApi
  const session = useLocalLibrary({ api, getSelectedZone: () => undefined, play: async () => { throw new Error('导航生命周期不得播放') } })
  t.after(() => session.dispose())
  const showPage = vue.ref(true)
  // 父级只有真实v-if；activate/deactivate全部来自正式LocalLibraryView，不在此复制生命周期。
  const template = compileTemplate({ id: 'post1132-page-lifecycle', filename: 'post1132-page-lifecycle.vue',
    source: '<div class="content-scroll"><LocalLibraryView v-if="showPage" v-bind="$attrs" /><p v-else data-testid="post1132-away">其他页面</p></div>' })
  assert.deepEqual(template.errors, [])
  const rendered = { exports: {} as { render: (...args: any[]) => any } }
  const compiled = ts.transpileModule(template.code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  new Function('require', 'module', 'exports', compiled)((name: string) => { assert.equal(name, 'vue'); return vue }, rendered, rendered.exports)
  let ancestor: import('vue').Component | undefined
  const wrap = (component: import('vue').Component) => ancestor ??= vue.defineComponent({ inheritAttrs: false, components: { LocalLibraryView: component }, setup: () => ({ showPage }), render: rendered.exports.render })
  const f = await mounted(t, path.join(componentRoot, 'library/LocalLibraryView.vue'), { session, browser: vue.markRaw(pages.localLibrary), playbackState: null,
    externalSessionLifecycle: true, externalMaintenanceDialogs: true, externalRelocationDialog: true, viewMode: 'albums' }, api, {}, wrap)
  t.after(async () => {
    t.diagnostic(JSON.stringify({ scope: '正式LocalLibraryView/Browser/Grid/pages与父v-if、合成Host；不含App watcher、Owner/Core或Chromium解码', imageSha256: info.sha256, trace, publications }))
    scope.stop()
    for (const pending of heldArtwork.splice(0)) pending.resolve({ ...pending.request, image, grid })
    await f.settle()
  })
  const cardFor = (value: Album) => f.all().find(element => element.props['data-local-album-id'] === value.id)
  const shown = (element: Host): boolean => {
    for (let current: Host | null = element; current; current = current.parent) if (current.style.display === 'none' || current.style.visibility === 'hidden') return false
    return element.isConnected
  }
  const record = (phase: string) => {
    const state = pages.localLibrary.snapshot.value
    trace.push({ phase, mountedViews: f.all().filter(element => element.props['data-testid'] === 'local-library-view').length, active: state.active,
      selectedAlbum: state.selectedAlbum?.id ?? null, epoch: state.artworkInvalidation?.epoch ?? 0, usage: pages.localLibrary.getArtworkCacheUsage(),
      queries: queries.map(request => ({ ...request })), artworkRequests: artworkRequests.map(request => ({ ...request })), imageErrors: [...f.imageErrors],
      albums: state.items.map(value => { const card = cardFor(value), images = card ? f.all(card).filter(element => element.type === 'img') : []
        return { ...requestFor(value), artworkStatus: state.artwork[value.id]?.status ?? 'idle', imageCount: images.length,
          imagesShown: images.every(shown), imageSourcesMatch: images.every(element => element.props.src === grid.dataUrl) } }) })
  }
  const assertReadyGallery = (phase: string) => {
    record(phase)
    const state = pages.localLibrary.snapshot.value
    assert.equal(state.active, true); assert.equal(state.selectedAlbum, null); assert.equal(state.status, 'ready')
    assert.equal(f.all().filter(element => element.props['data-testid'] === 'local-library-view').length, 1)
    assert.equal(f.all().filter(element => element.props['data-testid'] === 'local-album-browser').length, 1, '必须挂正式Browser')
    assert.deepEqual(pages.localLibrary.getArtworkCacheUsage(), { entries: 7, bytes: expectedBytes, running: 0, queued: 0 })
    for (const value of values) {
      assert.equal(state.artwork[value.id]?.status, 'ready'); assert.equal(state.artwork[value.id]?.dataUrl, grid.dataUrl)
      assert.deepEqual(state.artwork[value.id]?.grid, grid)
      const card = cardFor(value); assert.ok(card)
      const images = f.all(card).filter(element => element.type === 'img')
      assert.equal(images.length, 1); assert.equal(images[0]!.props.src, grid.dataUrl); assert.equal(shown(images[0]!), true)
    }
    assert.equal(f.imageErrors.length, 0, '此Host没有派发IMG error，不能把图片失败与缓存失效混为一谈')
    assert.doesNotMatch(f.text(), /封面暂未读取|封面待加载|封面尚未探测/u)
  }
  assertReadyGallery('首次七图ready')
  const gridRequests = values.map(value => ({ ...requestFor(value), variant: 'grid' as const }))
  assert.deepEqual(artworkRequests, gridRequests); assert.equal(queries.length, 1)
  await f.click(cardFor(values[0]!))
  record('详情保留七图')
  assert.equal(pages.localLibrary.snapshot.value.selectedAlbum?.id, values[0]!.id); assert.equal(pages.localLibrary.snapshot.value.detailStatus, 'ready')
  const detail = f.all().find(element => element.matches('.local-album-detail')); assert.ok(detail)
  assert.equal(f.all(detail).find(element => element.type === 'img')?.props.src, image.display.dataUrl, '详情继续使用原display，离页前不能被grid替换')
  const previousEpoch = pages.localLibrary.snapshot.value.artworkInvalidation?.epoch ?? 0
  showPage.value = false; await f.settle()
  record('父v-if卸载后压缩缓存保留')
  assert.equal(f.all().filter(element => element.props['data-testid'] === 'local-library-view').length, 0)
  assert.equal(pages.localLibrary.snapshot.value.active, false); assert.equal(pages.localLibrary.snapshot.value.selectedAlbum?.id, values[0]!.id)
  assert.equal(f.all().filter(element => element.type === 'img').length, 0, '离页实际卸载所有图片显示节点')
  assert.deepEqual(pages.localLibrary.getArtworkCacheUsage(), { entries: 7, bytes: expectedBytes, running: 0, queued: 0 })
  assert.equal(pages.localLibrary.snapshot.value.artworkInvalidation?.epoch ?? 0, previousEpoch, '普通离页不伪造封面失效')
  holdArtwork = true; showPage.value = true; await f.settle()
  record('回入详情等待原读取')
  assert.equal(pages.localLibrary.snapshot.value.active, true)
  assert.equal(queries.length, 1, '正式pages回入复用已完成目录，不额外刷新相同元数据')
  assert.equal(pages.localLibrary.snapshot.value.selectedAlbum?.id, values[0]!.id)
  assert.equal(pages.localLibrary.snapshot.value.artwork[values[0]!.id]?.status, 'ready', '回入详情沿原身份复用压缩副本')
  const returnedDetail = f.all().find(element => element.matches('.local-album-detail')); assert.ok(returnedDetail)
  assert.equal(f.all(returnedDetail).find(element => element.type === 'img')?.props.src, grid.dataUrl, '离页释放单项高清，回入等待高清期间复用原grid')
  assert.equal(heldArtwork.length, 1, '只补所选详情高清，不重读七张画廊小图')
  const pendingDetail = heldArtwork.shift()!; assert.deepEqual(pendingDetail.request, requestFor(values[0]!))
  pendingDetail.resolve({ ...pendingDetail.request, image, grid }); await f.settle()
  assert.equal(f.all(returnedDetail).find(element => element.type === 'img')?.props.src, image.display.dataUrl)
  const withDetail = expectedBytes + (image.display.dataUrl.length + grid.dataUrl.length) * 2
  assert.deepEqual(pages.localLibrary.getArtworkCacheUsage(), { entries: 7, bytes: withDetail, running: 0, queued: 0 })
  assert.ok(withDetail < LOCAL_ALBUM_ARTWORK_CACHE_BYTES / 2, '临时单项高清也不扩大原单页共享预算边界')
  await f.click(f.all().find(element => element.type === 'button' && f.text(element).trim() === '本地专辑'))
  record('回入返回首页立即复用七图')
  const waiting = pages.localLibrary.getArtworkCacheUsage()
  assert.deepEqual(waiting, { entries: 7, bytes: expectedBytes, running: 0, queued: 0 })
  assert.ok(values.every(value => pages.localLibrary.snapshot.value.artwork[value.id]?.status === 'ready'))
  assert.deepEqual(artworkRequests, [...gridRequests, requestFor(values[0]!), requestFor(values[0]!)])
  assert.equal(heldArtwork.length, 0)
  holdArtwork = false
  assertReadyGallery('回入七图仍ready')
  assert.deepEqual(artworkRequests.filter(request => request.variant === 'grid'), gridRequests, '同来源同修订的七张紧凑grid回入零补载')
  assert.equal(artworkRequests.length, values.length + 2, '只在打开和回入所选详情时分别读取一次高清')
  assert.equal(heldArtwork.length, 0); assert.equal(queries.length, 1); assert.equal(detailRequests.length, 1)
  assert.equal(pages.coverDrop.snapshot.value.active, false); assert.equal(pages.coverDrop.getArtworkCacheUsage().entries, 0)
})
