import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import type { LocalRootView } from '@music-bridge/contracts'
import type { LocalAlbumBrowserSnapshot, LocalAlbumSummary, LocalAlbumTrackItem } from '../src/renderer/src/composables/application/local-library-browser/types.js'
import * as albumTypes from '../src/renderer/src/composables/application/local-library-browser/types.js'
import * as albumFacts from '../src/renderer/src/composables/application/local-library-browser/presentation.js'
import * as albumUi from '../src/renderer/src/components/library/local-browser/presentation.js'
import { useGridWindow } from '../src/renderer/src/composables/useGridWindow.js'
import { calculateVirtualWindow } from '../src/renderer/src/composables/virtualWindow.js'
import { installSyntheticDocumentRealm, syntheticRootNode } from './helpers/synthetic-dom-realm.js'

const require = createRequire(import.meta.url), vue = require('vue') as typeof import('vue')
const componentRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../src/renderer/src/components/library/local-browser')
const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`
const libraryRoot: LocalRootView = { root: { id: id(1), sourceRootId: id(2), role: 'library', revision: '1' }, label: '合成来源目录', availability: 'ONLINE' }
function album(n = 1, overrides: Partial<LocalAlbumSummary> = {}): LocalAlbumSummary {
  return { id: `local-album-${n}`, kind: 'edition', rootId: libraryRoot.root.id, editionId: id(100 + n), title: `合成专辑 ${n}`, artists: ['合成作者'], year: '2000', versionLabel: '原版 CD', sourceLabel: '合成来源目录', trackCount: 2, representativeTrackId: id(1000 + n), revision: '1', artworkAvailable: false, statuses: ['missing-artwork'], ...overrides }
}
function track(n = 1, segment = false): LocalAlbumTrackItem {
  return { facts: { track: { id: id(1000 + n), assetId: id(2000 + n), selectionRevision: '1', segment: segment ? { id: id(3000 + n), startFrame: '0', endFrameExclusive: '44100', timebaseHz: 44100 } : null }, asset: { id: id(2000 + n), libraryRootId: libraryRoot.root.id, sourceRootId: libraryRoot.root.sourceRootId, rootRevision: '1', fileRevision: '1', locationRevision: '1', sampleFrames: null, timebaseHz: null }, metadata: { raw: { title: `合成曲目 ${n}`, artist: '合成作者', album: '原始专辑' }, effective: { title: `合成曲目 ${n}`, artist: '合成作者', album: '显示专辑' }, override: null }, versionTokens: [], editions: [], fileParameters: null }, disc: 1, trackNumber: n, sequence: n, statuses: [] }
}
function snapshot(overrides: Partial<LocalAlbumBrowserSnapshot> = {}): LocalAlbumBrowserSnapshot {
  return { active: true, query: '', rootId: null, filter: 'all', items: [album()], total: 1, hasMore: false, counts: { all: 1, 'missing-artwork': 1, 'has-artwork': 0, 'cue-unsplit': 0, 'metadata-issue': 0, 'parse-failed': 0, 'loose-audio': 0, 'track-named-audio': 0, 'missing-lyrics': 0 }, loaded: true, status: 'ready', initialLoading: false, refreshing: false, loadingMore: false, error: '', refreshError: '', loadMoreError: '', stale: false, scrollTop: 0, selectedAlbum: null, tracks: [], trackTotal: 0, tracksHasMore: false, detailStatus: 'idle', detailLoading: false, detailRefreshing: false, detailLoadingMore: false, detailError: '', detailRefreshError: '', detailLoadMoreError: '', detailStale: false, returnTarget: null, artwork: {}, ...overrides }
}

interface Host {
  type: string; tagName: string; text: string; props: Record<string, any>; children: Host[]; parent: Host | null
  value: any; checked: boolean; selected: boolean; multiple: boolean; options: Host[]; listeners: Record<string, (event: any) => void>
  style: Record<string, any>; dataset: Record<string, string>; scrollTop: number; clientHeight: number; isConnected: boolean
  focus(options?: FocusOptions): void; contains(target: Host | null): boolean; matches(selector: string): boolean
  closest(selector: string): Host | null; querySelector(selector: string): Host | null; querySelectorAll(selector: string): Host[]
  getAttribute(name: string): string | null; addEventListener(name: string, fn: (event: any) => void): void; removeEventListener(name: string): void
  getRootNode(): unknown
  readonly ownerDocument: object
}
async function mounted(t: test.TestContext, filename: string, initial: Record<string, unknown>) {
  const document = { activeElement: null as Host | null, addEventListener() {}, removeEventListener() {} }
  // 复用正式测试 realm：Document/ShadowRoot 身份与 activeElement 均由真实 directive 判断。
  const restoreRealm = installSyntheticDocumentRealm(document)
  t.after(restoreRealm)
  let mountedRoot: Host | null = null
  const all = (el: Host): Host[] => [el, ...el.children.flatMap(child => all(child))]
  const node = (type = ''): Host => {
    const el: Host = { type, tagName: type.toUpperCase(), text: '', props: {}, children: [], parent: null, value: '', checked: false, selected: false, multiple: false, options: [], listeners: {}, style: { display: '' }, dataset: {}, scrollTop: 0, clientHeight: 620, isConnected: false,
      focus() { document.activeElement = el }, contains(target) { return !!target && all(el).includes(target) },
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
      querySelector(selector) { return all(el).find(item => item !== el && item.matches(selector)) ?? null },
      querySelectorAll(selector) { return all(el).filter(item => item !== el && item.matches(selector)) },
      getAttribute(name) { return el.props[name] === undefined ? null : String(el.props[name]) },
      // Vue v-model 在更新时按所属文档核对输入焦点，保留正式 directive 的执行路径。
      ownerDocument: document,
      getRootNode() { return syntheticRootNode(el, mountedRoot, document) },
      addEventListener(name, fn) { el.listeners[name] = fn }, removeEventListener(name) { delete el.listeners[name] },
    }
    Object.defineProperties(el, {
      isConnected: { get: () => { let current = el; while (current.parent) current = current.parent; return current.type === 'root' } },
      options: { get: () => el.children.filter(child => child.type === 'option') },
      multiple: { get: () => !!el.props.multiple },
    })
    return el
  }
  const modules = new Map<string, import('vue').Component>()
  const load = (file: string): import('vue').Component => {
    const known = modules.get(file); if (known) return known
    const { descriptor } = parse(readFileSync(file, 'utf8')), script = compileScript(descriptor, { id: file })
    const template = compileTemplate({ id: file, filename: file, source: descriptor.template!.content, compilerOptions: { bindingMetadata: script.bindings } })
    assert.deepEqual(template.errors, [])
    const localRequire = createRequire(file), module = { exports: {} as { default: import('vue').Component } }, renderModule = { exports: {} as { render: (...args: any[]) => any } }
    const imports = (name: string) => {
      if (name === 'vue') return vue
      if (name.endsWith('RoonArtwork.vue')) return { default: { render: () => vue.h('span') } }
      if (name.endsWith('.vue')) return { default: load(path.resolve(path.dirname(file), name)) }
      const resolved = path.resolve(path.dirname(file), name)
      if (resolved.endsWith('/components/library/local-browser/presentation.js')) return albumUi
      if (resolved.endsWith('/composables/application/local-library-browser/presentation.js')) return albumFacts
      if (resolved.endsWith('/composables/application/local-library-browser/types.js')) return albumTypes
      if (name.endsWith('/useGridWindow.js')) return { useGridWindow }
      if (name.endsWith('/virtualWindow.js')) return { calculateVirtualWindow }
      return localRequire(name)
    }
    const compile = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    const window = { innerWidth: 1200, innerHeight: 900, addEventListener() {}, removeEventListener() {} }
    new Function('require', 'module', 'exports', 'document', 'window', compile(script.content))(imports, module, module.exports, document, window)
    new Function('require', 'module', 'exports', compile(template.code))(imports, renderModule, renderModule.exports)
    const component = { ...module.exports.default, render: renderModule.exports.render }; modules.set(file, component); return component
  }
  const remove = (el: Host) => { if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1); el.parent = null }
  const renderer = vue.createRenderer<Host, Host>({ createElement: node, createText: text => ({ ...node('text'), text }), createComment: () => node('comment'), setText: (el, text) => { el.text = text }, setElementText: (el, text) => { el.text = text; el.children = [] }, patchProp: (el, key, _old, value) => {
    el.props[key] = value
    if (key === 'style' && value) Object.assign(el.style, value)
    if (['value', 'checked', 'selected'].includes(key)) (el as any)[key] = value
    if (key.startsWith('data-')) el.dataset[key.slice(5).replace(/-([a-z])/gu, (_match, char: string) => char.toUpperCase())] = String(value)
  }, insert: (el, parent, anchor) => { remove(el); el.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(index < 0 ? parent.children.length : index, 0, el) }, remove, parentNode: el => el.parent, nextSibling: el => el.parent?.children[el.parent.children.indexOf(el) + 1] ?? null })
  const props = vue.reactive(initial), host = node('root'), app = renderer.createApp({ render: () => vue.h('div', { class: 'content-scroll' }, [vue.h(load(path.join(componentRoot, filename)), props)]) })
  mountedRoot = host
  app.mount(host); t.after(() => app.unmount())
  const text = (el: Host = host): string => el.text + el.children.map(child => text(child)).join('')
  const settle = async () => { for (let i = 0; i < 3; i++) { await vue.nextTick(); await new Promise<void>(resolve => setImmediate(resolve)) } }
  const event = (el: Host, key = '', extra: Record<string, unknown> = {}) => ({ target: el, currentTarget: el, key, shiftKey: false, metaKey: false, ctrlKey: false, preventDefault() {}, stopPropagation() {}, ...extra })
  const click = async (el: Host | undefined, extra: Record<string, unknown> = {}) => { assert.ok(el, '缺少点击目标'); const handlers = Array.isArray(el.props.onClick) ? el.props.onClick : [el.props.onClick]; for (const handler of handlers) handler?.(event(el, '', extra)); await settle() }
  const input = async (el: Host | undefined, value: string) => { assert.ok(el, '缺少输入目标'); el.value = value; el.listeners.input?.(event(el)); await settle() }
  await settle()
  return { props, all: (el: Host = host) => all(el), text, settle, event, click, input, active: () => document.activeElement, scroll: () => all(host).find(el => el.props.class === 'content-scroll')! }
}

test('本地专辑浏览的搜索和原七类筛选按读取事实派发，缺图入口保留准确身份', async t => {
  const searches: unknown[] = [], actions: unknown[] = []
  const f = await mounted(t, 'LocalAlbumBrowser.vue', { state: snapshot(), roots: [libraryRoot], onSearch: (request: unknown) => searches.push(request), onWorkbench: (request: unknown) => actions.push(request) })
  assert.equal(f.all().filter(el => el.props['aria-pressed'] !== undefined).length, 9)
  await f.input(f.all().find(el => el.props.id === 'local-album-search-query'), '明确版本')
  const form = f.all().find(el => el.props.role === 'search')!; form.props.onSubmit(f.event(form)); await f.settle()
  assert.deepEqual(searches[0], { query: '明确版本', rootId: null, filter: 'all' })
  await f.click(f.all().find(el => el.type === 'button' && f.text(el).startsWith('track 音轨')))
  assert.deepEqual(searches[1], { query: '', rootId: null, filter: 'track-named-audio' })
  await f.click(f.all().find(el => el.type === 'button' && f.text(el).startsWith('缺歌词')))
  assert.deepEqual(searches[2], { query: '', rootId: null, filter: 'missing-lyrics' })
  await f.click(f.all().find(el => el.props['aria-label'] === '为 合成专辑 1 选择封面'))
  assert.deepEqual(actions, [{ action: 'artwork', albumId: 'local-album-1', editionId: id(101), trackId: id(1001) }])
})

test('进入专辑后返回恢复原滚动和焦点，搜索筛选条件保留', async t => {
  const state = snapshot({ query: '具体版本', filter: 'missing-artwork', scrollTop: 480 }), selection: unknown[] = []
  const f = await mounted(t, 'LocalAlbumBrowser.vue', { state, roots: [libraryRoot], onSelect: (value: LocalAlbumSummary, top: number) => { selection.push([value.id, top]); (f.props.state as LocalAlbumBrowserSnapshot).selectedAlbum = value }, onBack: () => { (f.props.state as LocalAlbumBrowserSnapshot).selectedAlbum = null } })
  f.scroll().scrollTop = 480
  const trigger = f.all().find(el => el.props['data-local-album-id'] === state.items[0]!.id)!
  await f.click(trigger)
  assert.deepEqual(selection, [['local-album-1', 480]]); assert.equal(f.active()?.props.id, 'local-album-detail-heading'); assert.equal(f.scroll().scrollTop, 0)
  await f.click(f.all().find(el => el.type === 'button' && f.text(el).trim() === '本地专辑'))
  assert.equal(f.scroll().scrollTop, 480); assert.equal(f.active(), trigger)
  assert.equal((f.props.state as LocalAlbumBrowserSnapshot).query, '具体版本'); assert.equal((f.props.state as LocalAlbumBrowserSnapshot).filter, 'missing-artwork')
})

test('首次读错误、初始加载、确认空结果和服务未接入各有独立状态', async t => {
  const state = snapshot({ items: [], loaded: false, total: 0, counts: { ...snapshot().counts, all: 0, 'missing-artwork': 0 }, status: 'error', error: '合成读取错误' })
  const f = await mounted(t, 'LocalAlbumBrowser.vue', { state, roots: [], managementAvailable: false })
  assert.match(f.text(), /暂时无法读取.*合成读取错误/u); assert.doesNotMatch(f.text(), /音乐库还没有专辑/u)
  const current = f.props.state as LocalAlbumBrowserSnapshot; current.error = ''; current.status = 'loading'; current.initialLoading = true; await f.settle()
  assert.match(f.text(), /正在读取本地专辑/u); assert.doesNotMatch(f.text(), /音乐库还没有专辑/u)
  current.initialLoading = false; current.loaded = true; current.status = 'empty'; await f.settle()
  assert.match(f.text(), /音乐库还没有专辑/u)
  f.props.readAvailable = false; await f.settle()
  assert.match(f.text(), /专辑浏览服务尚未接入/u); assert.ok(f.all().find(el => el.type === 'button' && f.text(el) === '打开整理工作台')?.props.disabled)
})

test('零轨目录仍能进入选图、AI与CUE工作台，不伪造代表曲目', async t => {
  const emptyAlbum = album(9, { kind: 'source-directory', editionId: null, trackCount: 0, representativeTrackId: null, statuses: ['cue-unsplit', 'parse-failed'] }), actions: unknown[] = []
  const f = await mounted(t, 'LocalAlbumDetail.vue', { album: emptyAlbum, tracks: [], onWorkbench: (request: unknown) => actions.push(request) })
  for (const label of ['选择封面', 'AI 整理', 'CUE 分轨']) await f.click(f.all().find(el => el.type === 'button' && f.text(el) === label))
  assert.deepEqual(actions, [{ action: 'artwork', albumId: 'local-album-9' }, { action: 'ai', albumId: 'local-album-9' }, { action: 'cue', albumId: 'local-album-9' }])
  assert.match(f.text(), /名称解析失败/u); assert.doesNotMatch(f.text(), /音频解析失败/u)
  assert.ok(f.all().find(el => el.type === 'button' && f.text(el).includes('播放首曲'))?.props.disabled)
})

test('混合专辑逐轨禁用CUE，名称整理失败不禁普通轨，忙和离线时不能发播放ID', async t => {
  const regular = track(1), cue = track(2, true); regular.statuses = ['parse-failed']
  const plays: string[] = [], queues: string[] = [], nexts: string[] = [], details: string[] = []
  const f = await mounted(t, 'LocalAlbumDetail.vue', { album: album(), tracks: [regular, cue], sourceStatus: '目录可读取', onPlay: (value: string) => plays.push(value), onQueue: (value: string) => queues.push(value), 'onPlay-next': (value: string) => nexts.push(value), 'onOpen-track': (value: string) => details.push(value) })
  const normalPlay = f.all().find(el => el.props['aria-label'] === '播放 合成曲目 1')!, cuePlay = f.all().find(el => el.props['aria-label'] === '播放 合成曲目 2')!
  assert.equal(!!normalPlay.props.disabled, false); assert.equal(cuePlay.props.disabled, true)
  await f.click(normalPlay); await f.click(cuePlay); assert.deepEqual(plays, [regular.facts.track.id])
  await f.click(f.all().find(el => el.props['aria-label'] === '打开 合成曲目 1 的更多操作'))
  await f.click(f.all().find(el => el.props.role === 'menuitem' && f.text(el) === '加入队列')); assert.deepEqual(queues, [regular.facts.track.id])
  await f.click(f.all().find(el => el.props['aria-label'] === '打开 合成曲目 2 的更多操作'))
  const cueNext = f.all().find(el => el.props.role === 'menuitem' && f.text(el) === '下一首播放')!
  assert.equal(cueNext.props.disabled, true); await f.click(cueNext); assert.deepEqual(nexts, [])
  await f.click(f.all().find(el => el.props['aria-label'] === '查看 合成曲目 2 的版本与文件详情')); assert.deepEqual(details, [cue.facts.track.id])
  f.props.playbackPending = true; await f.settle(); await f.click(normalPlay); assert.equal(plays.length, 1)
  f.props.playbackPending = false; f.props.sourceUnavailable = true; await f.settle(); await f.click(normalPlay); assert.equal(plays.length, 1)
  await f.click(f.all().find(el => el.props['aria-label'] === '打开 合成曲目 1 的更多操作'))
  const offlineQueue = f.all().find(el => el.props.role === 'menuitem' && f.text(el) === '加入队列')!
  assert.equal(offlineQueue.props.disabled, true); await f.click(offlineQueue); assert.deepEqual(queues, [regular.facts.track.id])
  assert.match(f.text(), /源目录离线或许可已撤销/u)
})

test('专辑墙只挂载窗口内卡片并按需请求封面，隐藏墙不启动读取', async t => {
  const albums = Array.from({ length: 5000 }, (_value, index) => album(index + 1)), requested: string[] = []
  const f = await mounted(t, 'LocalAlbumGrid.vue', { albums, artwork: {}, loaded: true, total: 5000, 'onEnsure-artwork': (value: LocalAlbumSummary) => requested.push(value.id) })
  assert.ok(f.all().filter(el => el.props['data-local-album-id']).length < 40)
  assert.ok(new Set(requested).size < 40); assert.ok(new Set(requested).size > 0)
  f.props.active = false; await f.settle(); const count = requested.length
  f.props.albums = albums.map(value => ({ ...value, revision: '2' })); await f.settle(); assert.equal(requested.length, count)
})

test('封面使用安全显示图和lazy加载，图片解码失败可显式重试', async t => {
  const value = album(1, { artworkAvailable: true, statuses: ['has-artwork'] }), retries: string[] = [], dataUrl = 'data:image/png;base64,aGVsbG8='
  const f = await mounted(t, 'LocalAlbumGrid.vue', { albums: [value], artwork: { [value.id]: { status: 'ready', dataUrl, error: '', canRetry: false } }, loaded: true, 'onRetry-artwork': (item: LocalAlbumSummary) => retries.push(item.id) })
  const image = f.all().find(el => el.type === 'img')!; assert.equal(image.props.src, dataUrl); assert.equal(image.props.loading, 'lazy')
  const wrapper = f.all().find(el => el.props.onErrorCapture)!; wrapper.props.onErrorCapture({ ...f.event(wrapper), target: image }); image.props.onError?.(f.event(image)); await f.settle()
  assert.match(f.text(), /封面暂未读取/u)
  await f.click(f.all().find(el => el.props['aria-label'] === '重试读取 合成专辑 1 的封面')); assert.deepEqual(retries, [value.id])
})

test('未探测与来源不可用不显示成确认缺图，零轨目录仍请求真实封面读取', async t => {
  const value = album(3, { kind: 'source-directory', editionId: null, trackCount: 0, representativeTrackId: null, artworkState: 'unknown', statuses: [] }), reads: string[] = []
  const f = await mounted(t, 'LocalAlbumGrid.vue', { albums: [value], artwork: {}, loaded: true, 'onEnsure-artwork': (item: LocalAlbumSummary) => reads.push(item.id) })
  assert.match(f.text(), /封面尚未探测/u); assert.doesNotMatch(f.text(), /未找到封面/u)
  assert.deepEqual(reads, [value.id]); assert.ok(f.all().find(el => el.type === 'button' && f.text(el) === '查找封面'))
  f.props.albums = [{ ...value, artworkState: 'source-unavailable' }]
  f.props.artwork = { [value.id]: { status: 'error', dataUrl: null, error: '源目录暂时不可读取', canRetry: true } }; await f.settle()
  assert.match(f.text(), /来源不可用，封面未读取/u); assert.doesNotMatch(f.text(), /未找到封面/u)
  assert.equal(f.all().find(el => el.props['aria-label'] === '重试读取 合成专辑 3 的封面')?.props.disabled, false)
})

test('普通单击仍进专辑，Cmd/Ctrl和Shift多选保留CUE/零曲目及批量真实身份', async t => {
  const albums = [album(1), album(2, { kind: 'source-directory', editionId: null, trackCount: 0, representativeTrackId: null, revision: '7', statuses: [] }), album(3, { statuses: ['cue-unsplit'], revision: '3' }), album(4)]
  const state = snapshot({ items: albums, total: albums.length }), selected: string[] = [], batches: unknown[] = [], singleActions: unknown[] = [], plays: string[] = []
  const f = await mounted(t, 'LocalAlbumBrowser.vue', { state, roots: [libraryRoot], onSelect: (value: LocalAlbumSummary) => { selected.push(value.id); (f.props.state as LocalAlbumBrowserSnapshot).selectedAlbum = value }, onBack: () => { (f.props.state as LocalAlbumBrowserSnapshot).selectedAlbum = null }, 'onWorkbench-batch': (value: unknown) => batches.push(value), onWorkbench: (value: unknown) => singleActions.push(value), onPlay: (value: string) => plays.push(value) })
  const card = (n: number) => f.all().find(el => el.props['data-local-album-id'] === `local-album-${n}`)!
  const choice = (n: number) => f.all().find(el => el.props.role === 'checkbox' && el.props['aria-label'].startsWith(`取消选择 合成专辑 ${n}，`))
  await f.click(card(1), { metaKey: true }); await f.click(card(3), { shiftKey: true })
  assert.deepEqual(selected, []); assert.equal((f.props.state as LocalAlbumBrowserSnapshot).selectedAlbum, null)
  assert.match(f.text(), /已选择 3 张专辑/u); assert.equal(choice(2)?.props['aria-checked'], true); assert.equal(choice(3)?.props['aria-checked'], true)
  await f.click(card(4), { ctrlKey: true }); assert.match(f.text(), /已选择 4 张专辑/u)
  await f.click(card(4), { ctrlKey: true }); assert.match(f.text(), /已选择 3 张专辑/u)
  await f.click(card(1)); assert.deepEqual(selected, ['local-album-1'])
  await f.click(f.all().find(el => el.type === 'button' && f.text(el).trim() === '本地专辑'))
  assert.match(f.text(), /已选择 3 张专辑/u)
  await f.click(f.all().find(el => el.type === 'button' && f.text(el).trim() === '批量整理'))
  assert.deepEqual(batches, [{ action: 'overview', albums: [
    { albumKey: 'local-album-1', rootId: libraryRoot.root.id, revision: '1', kind: 'edition', title: '合成专辑 1', artists: ['合成作者'], editionId: id(101), representativeTrackId: id(1001) },
    { albumKey: 'local-album-2', rootId: libraryRoot.root.id, revision: '7', kind: 'source-directory', title: '合成专辑 2', artists: ['合成作者'], editionId: null, representativeTrackId: null },
    { albumKey: 'local-album-3', rootId: libraryRoot.root.id, revision: '3', kind: 'edition', title: '合成专辑 3', artists: ['合成作者'], editionId: id(103), representativeTrackId: id(1003) },
  ] }])
  assert.deepEqual(plays, []); assert.deepEqual(singleActions, [])
  await f.click(f.all().find(el => el.props['aria-label'] === '为 合成专辑 1 选择封面'))
  assert.deepEqual(singleActions, [{ action: 'artwork', albumId: 'local-album-1', editionId: id(101), trackId: id(1001) }])
})

test('可见选择按钮、取消、查询范围变化与真实刷新身份约束批量入口', async t => {
  const state = snapshot({ items: [album(1), album(2)], total: 2 }), batches: unknown[] = []
  const f = await mounted(t, 'LocalAlbumBrowser.vue', { state, 'onWorkbench-batch': (value: unknown) => batches.push(value) })
  const choose = (n: number) => f.all().find(el => el.props.role === 'checkbox' && el.props['aria-label'].startsWith(`选择 合成专辑 ${n}，`))!
  await f.click(choose(1)); await f.click(choose(2)); assert.match(f.text(), /已选择 2 张专辑/u)
  const current = f.props.state as LocalAlbumBrowserSnapshot
  current.refreshing = true; await f.settle()
  const batchButton = f.all().find(el => el.type === 'button' && f.text(el).trim() === '批量整理')!
  assert.equal(batchButton.props.disabled, true); await f.click(batchButton); assert.deepEqual(batches, [])
  current.items = [album(2, { rootId: id(99), revision: '12' })]; current.refreshing = false; await f.settle()
  assert.match(f.text(), /已选择 1 张专辑/u)
  f.props.managementAvailable = false; await f.settle(); await f.click(batchButton); assert.deepEqual(batches, [])
  f.props.managementAvailable = true; await f.settle(); await f.click(batchButton)
  assert.deepEqual(batches, [{ action: 'overview', albums: [{ albumKey: 'local-album-2', rootId: id(99), revision: '12', kind: 'edition', title: '合成专辑 2', artists: ['合成作者'], editionId: id(102), representativeTrackId: id(1002) }] }])
  await f.click(f.all().find(el => el.type === 'button' && f.text(el).trim() === '取消选择'))
  assert.doesNotMatch(f.text(), /已选择 \d+ 张专辑/u); assert.equal(f.active()?.props['data-local-album-id'], 'local-album-2')
  await f.click(choose(2)); current.query = '新范围'; await f.settle(); assert.doesNotMatch(f.text(), /已选择 \d+ 张专辑/u)
  assert.equal(f.all().find(el => el.props.role === 'checkbox')?.props['aria-checked'], false)
})

test('跨虚拟窗口连续选择超正式100上限时原子拒绝，不截取假批次或自动派发', async t => {
  const albums = Array.from({ length: 112 }, (_value, index) => album(index + 1)), batches: unknown[] = [], opened: unknown[] = []
  const f = await mounted(t, 'LocalAlbumBrowser.vue', { state: snapshot({ items: albums, total: albums.length }), 'onWorkbench-batch': (value: unknown) => batches.push(value), onSelect: (value: unknown) => opened.push(value) })
  await f.click(f.all().find(el => el.props['data-local-album-id'] === 'local-album-1'), { metaKey: true })
  // 使用正式网格的Tab边界切换，让远处卡片实际挂载，不以stub创建第101张按钮。
  for (let turn = 0; turn < 30; turn++) {
    const entries = f.all().filter(el => el.props['data-grid-index'] !== undefined).sort((a, b) => Number(a.props['data-grid-index']) - Number(b.props['data-grid-index']))
    const last = entries.at(-1)!
    if (Number(last.props['data-grid-index']) >= 100) break
    const boundary = f.all(last).filter(el => el.type === 'button' && !el.props.disabled).at(-1)!
    const grid = f.all().find(el => el.props['data-grid-window'] === 'true')!
    grid.props.onKeydown(f.event(boundary, 'Tab')); await f.settle()
  }
  const distant = f.all().find(el => el.props['data-local-album-id'] === 'local-album-101')!
  assert.ok(distant, '正式虚拟网格未挂载目标卡片'); await f.click(distant, { shiftKey: true })
  assert.match(f.text(), /一次最多选择 100 张专辑/u); assert.match(f.text(), /已选择 1 张专辑/u)
  assert.deepEqual(batches, []); assert.deepEqual(opened, [])
  await f.click(distant, { ctrlKey: true }); assert.match(f.text(), /已选择 2 张专辑/u); assert.doesNotMatch(f.text(), /一次最多选择/u)
})


// Stage3：正式 Browser → 正式 Grid → 正式 model；所有 API 回复仅为内存合成事实。
import { createHash } from 'node:crypto'
import type { LocalArtworkImage } from '@music-bridge/contracts'
import { createLocalAlbumBrowserModel, LOCAL_ALBUM_ARTWORK_CACHE_BYTES, LOCAL_ALBUM_ARTWORK_CACHE_ENTRIES, LOCAL_ALBUM_ARTWORK_CONCURRENCY } from '../src/renderer/src/composables/application/local-library-browser/model.js'
import type { LocalAlbumArtworkReply, LocalAlbumArtworkRequest, LocalAlbumArtworkWindow, LocalAlbumFilterCounts, LocalAlbumPage, LocalAlbumQuery, LocalAlbumTrackQuery, LocalAlbumTrackPage } from '../src/renderer/src/composables/application/local-library-browser/types.js'

function connectedArtworkReply(request: LocalAlbumArtworkRequest, image: LocalArtworkImage | null): LocalAlbumArtworkReply {
  return { albumKey: request.albumKey, rootId: request.rootId, editionId: request.editionId, representativeTrackId: request.representativeTrackId, revision: request.revision, image }
}

function connectedDisplayImage(targetBytes = 512 * 1024): LocalArtworkImage {
  // 既有自有 16×16 JPEG 只增加合法 COM 段，默认精确 512KiB；浏览器夹具另核对真实 decode。
  const seed = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAgMDAwMDBAcFBAQEBAkGBwUHCgkLCwoJCgoMDREODAwQDAoKDhQPEBESExMTCw4UFhQSFhESExL/2wBDAQMDAwQEBAgFBQgSDAoMEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhL/wAARCAAQABADAREAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5++FfwE/1P+jen8NbUZHmcO8Xbe8fVGj/AAZTRPBmqXkoa08qycJMoIKSMNqEEcj5ivPbrxX0GVyprEwlVaUIvmk5NKKjHWTbellFNu/Q/R8+8QVlnC+OxPtnCSpyUZK91OS5YW5dU+dxSfR6tpK657Qvj94D8OQ3A8NaRrHiCW2EZhnMIs7WfO0t875lXALDmLllwOCGr34eHeLwWCePzfEQw9CCbm23KUei0jpJydkkpXd0knL3T8G4D8NuIMZKl9brQoqV7q/PNb20XuO+n/LzRO71VjP+NP7VHjrX/Ad1p3grQdI8N6bqt1awwTGM3V3blSJWYu/7pwTEy4MQwH9QDX4rmEcv4nzGlhqc6n1WmnKUXaHtZbLnUW3GMG04xVRpyjzy3jGH7txx4fZBknBijj6k8RUrVIwfvckFq6ifKk57QS/iLV3va8X/AP/Z', 'base64')
  const parts = [seed.subarray(0, 2)]
  let padding = targetBytes - seed.length
  while (padding > 0) {
    const length = Math.min(65537, padding), segment = Buffer.alloc(length)
    segment[0] = 255; segment[1] = 254; segment.writeUInt16BE(length - 2, 2)
    parts.push(segment); padding -= length
  }
  const bytes = Buffer.concat([...parts, seed.subarray(2)]), sha256 = createHash('sha256').update(bytes).digest('hex')
  const info = { mime: 'image/jpeg' as const, bytes: bytes.length, sha256, width: 16, height: 16 }
  return { original: info, display: { ...info, dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}` } }
}
function connectedPage(request: LocalAlbumQuery, values: readonly LocalAlbumSummary[]): LocalAlbumPage {
  const scoped = values.filter(value => (request.rootId === null || value.rootId === request.rootId) && (!request.query || value.title.includes(request.query)))
  const selected = scoped.filter(value => request.filter === 'all' || value.statuses.includes(request.filter)), items = selected.slice(request.offset, request.offset + request.limit)
  const counts = Object.fromEntries([['all', scoped.length], ...albumTypes.LOCAL_ALBUM_STATUSES.map(status => [status, scoped.filter(value => value.statuses.includes(status)).length])]) as unknown as LocalAlbumFilterCounts
  return { ...request, items, total: selected.length, hasMore: request.offset + items.length < selected.length, counts }
}
function connectedTrackPage(request: LocalAlbumTrackQuery, selected: LocalAlbumSummary): LocalAlbumTrackPage {
  const values = Array.from({ length: selected.trackCount }, (_, index) => {
    const source = track(index + 1), trackId = index === 0 ? selected.representativeTrackId! : id(50_000 + index)
    // 无人工覆盖时 effective 必须等于 raw；旧呈现样本的两套专辑名不属于有效详情事实。
    const metadata = { ...source.facts.metadata.raw, artist: selected.artists.join('、'), album: selected.title, year: selected.year ?? '', disc: String(source.disc ?? 1), track: String(source.trackNumber ?? index + 1) }
    return { ...source, statuses: selected.statuses, facts: { ...source.facts, track: { ...source.facts.track, id: trackId }, asset: { ...source.facts.asset, libraryRootId: selected.rootId },
      metadata: { raw: metadata, override: null, effective: { ...metadata } },
      editions: selected.editionId ? [{ id: selected.editionId, title: selected.title, edition: selected.versionLabel ?? '', revision: selected.revision }] : [] } }
  })
  const items = values.slice(request.offset, request.offset + request.limit)
  return { ...request, album: selected, items, total: values.length, hasMore: request.offset + items.length < values.length }
}
async function connectedBrowser(t: test.TestContext) {
  const image = connectedDisplayImage(), values = Array.from({ length: 7 }, (_, index) => album(index + 1, { artworkAvailable: true, artworkState: 'available', statuses: ['has-artwork'] }))
  const requests: { request: LocalAlbumArtworkRequest; resolve: (reply: LocalAlbumArtworkReply) => void; returned: boolean }[] = []
  const usage: { entries: number; bytes: number; running: number; queued: number }[] = []
  let liveProps: Record<string, unknown> | undefined
  const model = createLocalAlbumBrowserModel({
    artworkCacheBytes: 8 * 1024 * 1024, artworkCacheEntries: 48,
    api: {
      queryAlbums: async request => connectedPage(request, values),
      queryAlbumTracks: async request => { const selected = values.find(value => value.id === request.albumKey && value.rootId === request.rootId); assert.ok(selected); return connectedTrackPage(request, selected) },
      getArtwork: request => {
        assert.ok(requests.length < 32, '合成 API 的 32 次读取保险丝已触发；不得无限返还循环')
        return new Promise<LocalAlbumArtworkReply>(resolve => requests.push({ request: { ...request }, resolve, returned: false }))
      },
    },
    onChange: state => { if (liveProps) liveProps.state = state },
  })
  liveProps = vue.reactive({ state: model.getSnapshot(), roots: [libraryRoot], readAvailable: true, managementAvailable: true,
    onSearch: (scope: Pick<LocalAlbumQuery, 'query' | 'rootId' | 'filter'>) => { void model.setScope(scope) },
    onSelect: (value: LocalAlbumSummary, scrollTop: number) => { void model.openAlbum(value, { scrollTop }) },
    onBack: () => model.closeAlbum(), onRetry: () => { void model.refresh(true) },
    'onArtwork-window': (window: LocalAlbumArtworkWindow) => model.setArtworkWindow(window),
    'onEnsure-artwork': (value: LocalAlbumSummary) => { void model.ensureArtwork(value) },
    'onRetry-artwork': (value: LocalAlbumSummary) => { void model.retryArtwork(value) },
    'onUpdate:scrollTop': (value: number) => model.setScrollTop(value),
    'onUpdate:selectedAlbumIds': (ids: readonly string[]) => model.setSelectedAlbums(ids),
  })
  const f = await mounted(t, 'LocalAlbumBrowser.vue', liveProps)
  t.after(async () => { model.dispose(); for (const pending of requests) if (!pending.returned) { pending.returned = true; pending.resolve(connectedArtworkReply(pending.request, image)) }; await f.settle() })
  const recordUsage = () => {
    const observed = model.getArtworkCacheUsage(); usage.push(observed)
    assert.ok(observed.bytes <= 8 * 1024 * 1024, '本例显式小缓存8MiB预算不得扩大')
    assert.ok(observed.entries <= 48, '本例显式小缓存48项预算不得扩大')
    assert.ok(observed.running <= 2, '正式两槽并发预算不得扩大')
    return observed
  }
  await model.activate(); await f.settle()
  assert.equal(model.getSnapshot().status, 'ready', '夹具必须先通过真实专辑合同，读取失败不能充当 LRU 反例')
  assert.equal(f.all().filter(el => el.props['data-local-album-id']).length, 7, '必须挂载真实 Browser 的七张子 Grid 卡片')
  assert.equal(requests.length, 2, '正式两路并发应开始前两张图')
  recordUsage()
  const release = async (index: number) => {
    const pending = requests[index]; assert.ok(pending, `第 ${index + 1} 次读取尚未派发`); assert.equal(pending.returned, false)
    pending.returned = true; pending.resolve(connectedArtworkReply(pending.request, image)); await f.settle(); recordUsage()
  }
  const stable = async (expected: number) => { for (let turn = 0; turn < 8; turn++) { await f.settle(); recordUsage() }; assert.equal(requests.length, expected, '同一可见窗口不能因 LRU 淘汰自动重读') }
  const initialSeven = async () => {
    assert.equal(LOCAL_ALBUM_ARTWORK_CONCURRENCY, 2)
    assert.equal(image.display.bytes, 524_288); assert.equal(image.display.dataUrl.length, 699_075)
    assert.equal(image.display.dataUrl.length * 2, 1_398_150); assert.equal(6 * image.display.dataUrl.length * 2 - 8 * 1024 * 1024, 292)
    for (let index = 0; index < 7; index++) await release(index)
    assert.equal(requests.length, 7, '七张有效 512KiB 图返回后，第八次自动读取就是 LRU 循环反例')
    const observed = recordUsage()
    assert.equal(observed.entries, 5); assert.equal(observed.bytes, 6_990_750); assert.equal(observed.running, 0); assert.equal(observed.queued, 0)
    assert.equal(Object.values(model.getSnapshot().artwork).filter(value => value.dataUrl !== null).length, 5, '只保留正式预算内的五张图，不能藏第二份图片缓存')
    await stable(7)
  }
  const evicted = () => values.filter(value => model.artworkFor(value).status === 'idle')
  return { f, model, values, requests, usage, image, release, stable, initialSeven, evicted }
}

test('真实 Browser+Grid+model 在 7×512KiB 的显式 8MiB 小缓存计费下停止自动循环，淘汰卡片可明示重试且只读取目标', async t => {
  const c = await connectedBrowser(t); await c.initialSeven()
  const dropped = c.evicted(); assert.equal(dropped.length, 2)
  for (const value of dropped) {
    const button = c.f.all().find(el => el.type === 'button' && el.props['aria-label'] === `重试读取 ${value.title} 的封面`)
    assert.ok(button, '缓存淘汰的可见卡片必须有真实重试按钮'); assert.equal(button.props.disabled, false); assert.match(c.f.text(button), /重试封面/u)
  }
  const target = dropped[0]!, retry = c.f.all().find(el => el.props['aria-label'] === `重试读取 ${target.title} 的封面`)
  await c.f.click(retry)
  assert.equal(c.requests.length, 8); assert.equal(c.requests[7]!.request.albumKey, target.id)
  await c.release(7); await c.stable(8)
  assert.equal(c.model.artworkFor(target).status, 'ready'); assert.equal(c.evicted().length, 2)
  assert.equal(c.f.all().filter(el => el.props['data-local-album-id']).length, 7)
})

test('真实 Browser+Grid+model 的搜索离窗与详情离开再进入恢复资格，同修订单专辑 invalidate 不连带其他淘汰卡片', async t => {
  const c = await connectedBrowser(t); await c.initialSeven()
  const firstDropped = c.evicted().map(value => value.id).sort()
  await c.model.search('不存在的合成专辑'); await c.f.settle(); assert.equal(c.f.all().filter(el => el.props['data-local-album-id']).length, 0)
  await c.model.search(''); await c.f.settle()
  assert.deepEqual(c.requests.slice(7).map(value => value.request.albumKey).sort(), firstDropped, '离窗再进入只需重读当前无缓存的项')
  await c.release(7); await c.release(8); await c.stable(9)
  const detailTarget = c.values.find(value => c.model.artworkFor(value).status === 'ready')!
  await c.f.click(c.f.all().find(el => el.props['data-local-album-id'] === detailTarget.id))
  assert.equal(c.model.getSnapshot().detailStatus, 'ready', '详情夹具必须通过真实曲目合同')
  const detailDropped = c.evicted().map(value => value.id).sort()
  await c.f.click(c.f.all().find(el => el.type === 'button' && c.f.text(el).trim() === '本地专辑'))
  assert.deepEqual(c.requests.slice(9).map(value => value.request.albumKey).sort(), detailDropped, '隐藏 Grid 后再进入恢复无缓存项的自动资格')
  await c.release(9); await c.release(10); await c.stable(11)
  const target = c.evicted()[0]!, revision = target.revision
  const invalidating = c.model.invalidateArtwork(target.id); await c.f.settle()
  assert.equal(c.requests.length, 12, '同修订显式失效也必须恢复该项资格')
  assert.deepEqual(c.requests.slice(11).map(value => value.request.albumKey), [target.id], '单专辑失效不得唤醒其他淘汰项')
  assert.equal(c.requests[11]!.request.revision, revision); await c.release(11); await invalidating; await c.stable(12)
  assert.equal(c.model.artworkFor(target).status, 'ready')
})

test('真实 Browser+Grid+model 按服务返回的完整 artwork tuple 与 revision 重新读取，仅改变的专辑获得资格', async t => {
  const c = await connectedBrowser(t); await c.initialSeven()
  const previous = c.values[0]!
  c.values[0] = { ...previous, rootId: id(701), editionId: id(702), representativeTrackId: id(703) }
  await c.model.refresh(); await c.f.settle()
  assert.equal(c.requests.length, 8, '同 revision 的 root/edition/代表轨道变化不能被旧自动资格吞掉')
  assert.deepEqual(c.requests[7]!.request, { albumKey: previous.id, rootId: id(701), editionId: id(702), representativeTrackId: id(703), revision: previous.revision })
  await c.release(7); await c.stable(8)
  c.values[0] = { ...c.values[0]!, revision: '2' }; await c.model.refresh(); await c.f.settle()
  assert.equal(c.requests.length, 9); assert.equal(c.requests[8]!.request.albumKey, previous.id); assert.equal(c.requests[8]!.request.revision, '2')
  await c.release(8); await c.stable(9)
})


test('真实 Browser 与 model 双向选择连接在同范围发布时保持选择，只有实际 query/root/filter 改变清一次', async t => {
  const values = [album(1)], selections: readonly string[][] = []
  let liveProps: Record<string, unknown> | undefined
  const model = createLocalAlbumBrowserModel({ api: {
    queryAlbums: async request => connectedPage(request, values),
    queryAlbumTracks: async request => connectedTrackPage(request, values[0]!),
    getArtwork: async request => ({ ...request, image: null }),
  }, onChange: state => { if (liveProps) liveProps.state = state } })
  liveProps = vue.reactive({ state: model.getSnapshot(), roots: [libraryRoot],
    onSearch: (scope: Pick<LocalAlbumQuery, 'query' | 'rootId' | 'filter'>) => { void model.setScope(scope) },
    'onEnsure-artwork': (value: LocalAlbumSummary) => { void model.ensureArtwork(value) },
    'onUpdate:selectedAlbumIds': (ids: readonly string[]) => { (selections as string[][]).push([...ids]); model.setSelectedAlbums(ids) },
  })
  const f = await mounted(t, 'LocalAlbumBrowser.vue', liveProps); t.after(model.dispose)
  await model.activate(); await f.settle(); assert.equal(model.getSnapshot().status, 'ready')
  const choose = async () => { await f.click(f.all().find(el => el.props.role === 'checkbox' && el.props['aria-label'].startsWith('选择 合成专辑 1，'))); assert.deepEqual(model.getSnapshot().selectedAlbumIds, [values[0]!.id]); assert.match(f.text(), /已选择 1 张专辑/u) }
  await choose(); const before = selections.length
  model.setScrollTop(128); await f.settle(); await model.refresh(); await f.settle()
  await model.invalidateArtwork(values[0]!.id); await f.settle()
  assert.equal(selections.length, before, '滚动、刷新和封面缓存发布均不得产生清选择反馈')
  assert.deepEqual(model.getSnapshot().selectedAlbumIds, [values[0]!.id]); assert.match(f.text(), /已选择 1 张专辑/u)
  for (const change of [() => model.search('合成'), () => model.setRoot(libraryRoot.root.id), () => model.setFilter('missing-artwork')]) {
    const count = selections.length; await change(); await f.settle()
    assert.equal(selections.length, count + 1, '实际作用域改变只发一次清选择事件')
    assert.deepEqual(selections.at(-1), []); assert.deepEqual(model.getSnapshot().selectedAlbumIds, [])
    assert.doesNotMatch(f.text(), /已选择 1 张专辑/u); await choose()
  }
  const finalCount = selections.length
  for (let turn = 0; turn < 8; turn++) await f.settle()
  assert.equal(selections.length, finalCount, '选择状态不能靠持续 publish 自激循环维持')
  assert.deepEqual(model.getSnapshot().selectedAlbumIds, [values[0]!.id])
})

test('公共封面组件：DTO-ready不会自发变解码错误，只有同src的IMG error进入图片失败分支', async t => {
  // 使用原合法JPEG夹具；Host只派发受控事件，不声称执行了Chromium/nativeImage解码。
  const dataUrl=connectedDisplayImage().display.dataUrl;let imageErrors=0;
  const f=await mounted(t,'LocalAlbumArtwork.vue',{artwork:{status:'ready',dataUrl,error:'',canRetry:false},sourceState:'available',alt:'公共合成图片','onImage-error':()=>{imageErrors++}});
  const image=f.all().find(el=>el.type==='img')!,wrapper=f.all().find(el=>el.props.onErrorCapture)!;
  assert.ok(image);assert.equal(image.props.src,dataUrl);assert.doesNotMatch(f.text(),/封面暂未读取/u);assert.equal(imageErrors,0);
  wrapper.props.onErrorCapture({...f.event(wrapper),target:wrapper});
  wrapper.props.onErrorCapture({...f.event(wrapper),target:{tagName:'IMG',getAttribute:()=>dataUrl+'#old'}});await f.settle();
  assert.equal(imageErrors,0);assert.doesNotMatch(f.text(),/封面暂未读取/u);
  wrapper.props.onErrorCapture({...f.event(wrapper),target:image});image.props.onError?.(f.event(image));await f.settle();
  assert.equal(imageErrors,1);assert.match(f.text(),/封面暂未读取/u);
  f.props.artwork={status:'error',dataUrl:null,error:'受控RPC拒绝',canRetry:true};await f.settle();
  assert.equal(imageErrors,1,'RPC/DTO error状态不能反过来伪造IMG decode事件');assert.match(f.text(),/封面暂未读取/u);assert.equal(f.all().filter(el=>el.type==='img').length,0);
  f.props.artwork={status:'ready',dataUrl,error:'',canRetry:false};await f.settle();
  assert.equal(f.all().find(el=>el.type==='img')?.props.src,dataUrl);assert.doesNotMatch(f.text(),/封面暂未读取/u);assert.equal(imageErrors,1);
});

test('1132返回封面：七小图ready后经正式Browser按钮进详情并返回两轮，缓存与IMG保留', async t => {
  const values = Array.from({ length: 7 }, (_, index) => album(index + 1, { artworkAvailable: true, artworkState: 'available', statuses: ['has-artwork'] }))
  const image = connectedDisplayImage(64 * 1024), expectedBytes = values.length * image.display.dataUrl.length * 2
  assert.ok(expectedBytes < LOCAL_ALBUM_ARTWORK_CACHE_BYTES, '本例七图必须全部低于正式预算，不能以LRU淘汰替代返回缺图')
  const requests: LocalAlbumArtworkRequest[] = [], queries: LocalAlbumQuery[] = [], details: LocalAlbumTrackQuery[] = []
  const trace: unknown[] = []
  let liveProps: Record<string, unknown> | undefined
  const model = createLocalAlbumBrowserModel({
    api: {
      queryAlbums: async request => { queries.push({ ...request }); return connectedPage(request, values) },
      queryAlbumTracks: async request => {
        details.push({ ...request })
        const selected = values.find(value => value.id === request.albumKey && value.rootId === request.rootId)
        assert.ok(selected, '详情读取必须命中实际点击的专辑身份')
        return connectedTrackPage(request, selected)
      },
      getArtwork: async request => { requests.push({ ...request }); return { ...request, image } },
    },
    onChange: state => { if (liveProps) liveProps.state = state },
  })
  liveProps = vue.reactive({ state: model.getSnapshot(), roots: [libraryRoot], readAvailable: true, managementAvailable: true,
    onSelect: (value: LocalAlbumSummary, scrollTop: number) => { void model.openAlbum(value, { scrollTop }) },
    onBack: () => model.closeAlbum(),
    'onEnsure-artwork': (value: LocalAlbumSummary) => { void model.ensureArtwork(value) },
    'onUpdate:scrollTop': (value: number) => model.setScrollTop(value),
  })
  const f = await mounted(t, 'LocalAlbumBrowser.vue', liveProps)
  t.after(() => {
    t.diagnostic(JSON.stringify({ scope: '正式Browser/Grid/model与合成Host，不含Chromium解码、App顶层路由或真实Owner服务', trace }))
    model.dispose()
  })
  const requestFor = (value: LocalAlbumSummary): LocalAlbumArtworkRequest => ({ albumKey: value.id, rootId: value.rootId, editionId: value.editionId, representativeTrackId: value.representativeTrackId, revision: value.revision })
  const cardFor = (value: LocalAlbumSummary) => f.all().find(el => el.props['data-local-album-id'] === value.id)
  // 检查真实Vue v-show在Host上的祖先display状态；不伪称浏览器布局或图片解码证据。
  const shown = (element: Host): boolean => {
    for (let current: Host | null = element; current; current = current.parent) {
      if (current.style.display === 'none' || current.style.visibility === 'hidden' || current.props.hidden === true || current.props['aria-hidden'] === 'true') return false
    }
    return element.isConnected
  }
  const record = (phase: string) => {
    const state = model.getSnapshot()
    trace.push({ phase, active: state.active, selectedAlbum: state.selectedAlbum?.id ?? null, usage: model.getArtworkCacheUsage(), requests: requests.map(request => ({ ...request })),
      albums: state.items.map(value => {
        const card = cardFor(value), images = card ? f.all(card).filter(el => el.type === 'img') : []
        return { ...requestFor(value), artworkStatus: state.artwork[value.id]?.status ?? 'idle', dataUrlMatches: state.artwork[value.id]?.dataUrl === image.display.dataUrl,
          imageCount: images.length, imagesShown: images.every(shown), imageSourcesMatch: images.every(element => element.props.src === image.display.dataUrl) }
      }) })
  }
  const assertGallery = (phase: string) => {
    record(phase)
    const state = model.getSnapshot()
    assert.equal(state.active, true); assert.equal(state.selectedAlbum, null); assert.equal(state.status, 'ready')
    assert.deepEqual(model.getArtworkCacheUsage(), { entries: 7, bytes: expectedBytes, running: 0, queued: 0 })
    assert.equal(Object.keys(state.artwork).length, 7)
    assert.equal(f.all().filter(el => el.props['data-local-album-id']).length, 7)
    for (const value of values) {
      assert.equal(state.artwork[value.id]?.status, 'ready', `${phase}：${value.id}的缓存必须保留ready`)
      assert.equal(state.artwork[value.id]?.dataUrl, image.display.dataUrl)
      const card = cardFor(value); assert.ok(card)
      const images = f.all(card).filter(el => el.type === 'img')
      assert.equal(images.length, 1, `${phase}：${value.id}必须保留唯一IMG`)
      assert.equal(images[0]!.props.src, image.display.dataUrl)
      assert.equal(shown(images[0]!), true, `${phase}：${value.id}不能仍藏在v-show的详情前祖先下`)
    }
    assert.doesNotMatch(f.text(), /封面暂未读取|封面待加载|封面尚未探测/u)
  }
  await model.activate(); await f.settle()
  assertGallery('首次七图ready')
  assert.deepEqual(requests, values.map(requestFor), '首次七图必须分别从正式Grid触发读取，不能预填缓存冒充已显示')
  for (let round = 1; round <= 2; round++) {
    const selected = values[round - 1]!, before = requests.length
    await f.click(cardFor(selected))
    record(`第${round}轮详情`)
    assert.equal(model.getSnapshot().selectedAlbum?.id, selected.id); assert.equal(model.getSnapshot().detailStatus, 'ready')
    assert.equal(f.all().find(el => el.matches('.local-album-gallery'))?.style.display, 'none')
    assert.equal(requests.length, before, '同修订进入详情必须复用已ready封面')
    await f.click(f.all().find(el => el.type === 'button' && f.text(el).trim() === '本地专辑'))
    assertGallery(`第${round}轮返回`)
    assert.equal(requests.length, before, '普通返回不能无故重新读取七张封面')
    assert.equal(queries.length, 1, '详情返回不能暗中改走重新查询首页的路径')
  }
  assert.deepEqual(details.map(request => [request.albumKey, request.rootId]), values.slice(0, 2).map(value => [value.id, value.rootId]))
})

test('MBF封面窗口复用：ready入窗只触碰一次，搜索重入刷新LRU且不重读API', async t => {
  // 真Browser/Grid/model与受控显示DTO；搜索切窗不代表真实滚动、IMG解码或持久缓存。
  const values = [1, 2, 3].map(index => album(index, { artworkAvailable: true, artworkState: 'available', statuses: ['has-artwork'] }))
  const image = connectedDisplayImage(4 * 1024), requests: LocalAlbumArtworkRequest[] = [], ensured: LocalAlbumArtworkRequest[] = []
  const ensureTasks: Promise<void>[] = []
  const tuple = (value: LocalAlbumSummary): LocalAlbumArtworkRequest => ({ albumKey: value.id, rootId: value.rootId, editionId: value.editionId,
    representativeTrackId: value.representativeTrackId, revision: value.revision })
  let liveProps: Record<string, unknown> | undefined
  const model = createLocalAlbumBrowserModel({ artworkCacheEntries: 2, artworkCacheBytes: 32 * 1024, api: {
    queryAlbums: async request => connectedPage(request, values),
    queryAlbumTracks: async request => { const value = values.find(item => item.id === request.albumKey); assert.ok(value); return connectedTrackPage(request, value) },
    getArtwork: async request => { requests.push({ ...request }); return { ...request, image, status: 'ready' } },
  }, onChange: state => { if (liveProps) liveProps.state = state } }); t.after(model.dispose)
  await model.activate(); await model.ensureArtwork(values[0]!); await model.ensureArtwork(values[1]!)
  assert.deepEqual(requests, values.slice(0, 2).map(tuple)); assert.equal(model.getArtworkCacheUsage().entries, 2)
  await model.search(values[0]!.title)
  liveProps = vue.reactive({ state: model.getSnapshot(), roots: [libraryRoot], readAvailable: true, managementAvailable: true,
    'onArtwork-window': (window: LocalAlbumArtworkWindow) => model.setArtworkWindow(window),
    'onEnsure-artwork': (value: LocalAlbumSummary) => { ensured.push(tuple(value)); ensureTasks.push(model.ensureArtwork(value)) },
  })
  const f = await mounted(t, 'LocalAlbumBrowser.vue', liveProps)
  const stable = async (expected: readonly LocalAlbumSummary[], reads: number) => {
    for (let turn = 0; turn < 4; turn++) { await f.settle(); await Promise.all(ensureTasks) }
    assert.deepEqual(ensured, expected.map(tuple), '只由原Grid为新入窗身份派发一次ensure；同窗发布不能追加触碰')
    assert.equal(requests.length, reads, 'ready命中只能触碰原LRU，不能新增getArtwork')
  }
  assert.equal(f.all().filter(el => el.props['data-local-album-id']).length, 1)
  await stable([values[0]!], 2)
  const unchanged = model.getSnapshot()
  liveProps.state = { ...unchanged, items: unchanged.items.map(value => ({ ...value })), artwork: { ...unchanged.artwork } }
  await stable([values[0]!], 2)
  await model.search(values[1]!.title); await stable([values[0]!, values[1]!], 2)
  await model.search(values[0]!.title); await stable([values[0]!, values[1]!, values[0]!], 2)
  assert.equal(model.artworkFor(values[0]!).status, 'ready'); assert.equal(model.artworkFor(values[1]!).status, 'ready')
  await model.search(values[2]!.title); await stable([values[0]!, values[1]!, values[0]!, values[2]!], 3)
  assert.deepEqual(requests, values.map(tuple))
  assert.equal(model.artworkFor(values[0]!).status, 'ready', 'A重入的真实Grid触碰须让A保留为最近使用')
  assert.equal(model.artworkFor(values[1]!).status, 'idle', '加入C时须淘汰更旧的B，而非刚重入的A')
  assert.equal(model.artworkFor(values[2]!).status, 'ready')
  const usage = model.getArtworkCacheUsage()
  assert.deepEqual(usage, { entries: 2, bytes: image.display.dataUrl.length * 2 * 2, running: 0, queued: 0 })
  assert.ok(usage.bytes <= 32 * 1024)
})

test('MBF可见封面默认预算：七张512KiB成功图在64MiB与128项内完整保留且不循环', async t => {
  assert.equal(LOCAL_ALBUM_ARTWORK_CACHE_BYTES, 64 * 1024 * 1024); assert.equal(LOCAL_ALBUM_ARTWORK_CACHE_ENTRIES, 128); assert.equal(LOCAL_ALBUM_ARTWORK_CONCURRENCY, 2)
  const values = Array.from({ length: 7 }, (_, index) => album(101 + index, { artworkAvailable: true, artworkState: 'available', statuses: ['has-artwork'] }))
  const image = connectedDisplayImage(), requests: LocalAlbumArtworkRequest[] = [], tasks: Promise<void>[] = []
  let liveProps: Record<string, unknown> | undefined
  const model = createLocalAlbumBrowserModel({ api: {
    queryAlbums: async request => connectedPage(request, values),
    queryAlbumTracks: async request => connectedTrackPage(request, values.find(value => value.id === request.albumKey)!),
    getArtwork: async request => { requests.push({ ...request }); return connectedArtworkReply(request, image) },
  }, onChange: state => { if (liveProps) liveProps.state = state } })
  t.after(async () => { model.dispose(); await Promise.all(tasks) })
  liveProps = vue.reactive({ state: model.getSnapshot(), readAvailable: true,
    onRetry: () => tasks.push(model.refresh(true)),
    'onArtwork-window': (window: LocalAlbumArtworkWindow) => model.setArtworkWindow(window),
    'onEnsure-artwork': (value: LocalAlbumSummary) => tasks.push(model.ensureArtwork(value)),
  })
  const f = await mounted(t, 'LocalAlbumBrowser.vue', liveProps)
  await model.activate(); for (let turn = 0; turn < 4; turn++) { await f.settle(); await Promise.all(tasks) }
  assert.equal(requests.length, 7); assert.ok(requests.every(request => !Object.hasOwn(request, 'refresh')))
  assert.equal(values.every(value => model.artworkFor(value).status === 'ready'), true)
  const usage = model.getArtworkCacheUsage()
  assert.deepEqual(usage, { entries: 7, bytes: 7 * image.display.dataUrl.length * 2, running: 0, queued: 0 })
  assert.ok(usage.bytes > 8 * 1024 * 1024 && usage.bytes < LOCAL_ALBUM_ARTWORK_CACHE_BYTES)
  assert.equal(f.all().filter(el => el.type === 'img' && el.props.src === image.display.dataUrl).length, 7, 'Host只核正式IMG挂载与src，不冒浏览器decode')
  await f.click(f.all().find(el => el.type === 'button' && f.text(el).trim() === '刷新')); await Promise.all(tasks); await f.settle()
  assert.equal(requests.length, 14); assert.ok(requests.slice(7).every(request => request.refresh === true), '实际Browser刷新按钮要把显式意图传入原读口')
  assert.equal(f.all().filter(el => el.type === 'img' && el.props.src === image.display.dataUrl).length, 7)
})

test('MBF可见封面滚动：真实Grid测量窗口撤旧队列，迟到不回填且成功淘汰回屏自动复用读口', async t => {
  // 受控几何执行正式useGridWindow的scroll监听与Grid/model；磁盘读口是有界内存替身，不冒真实持久缓存/FD/decode。
  const values = Array.from({ length: 60 }, (_, index) => album(201 + index, { artworkAvailable: true, artworkState: 'available', statuses: ['has-artwork'] }))
  const image = connectedDisplayImage(4 * 1024), persistent = new Map<string, LocalArtworkImage>()
  const jobs: { request: LocalAlbumArtworkRequest; resolve: (reply: LocalAlbumArtworkReply) => void; returned: boolean }[] = []
  const tasks: Promise<void>[] = [], windows: LocalAlbumArtworkWindow[] = []
  let running = 0, maximum = 0, bodies = 0, hits = 0, liveProps: Record<string, unknown> | undefined
  const model = createLocalAlbumBrowserModel({ artworkCacheEntries: 16, artworkCacheBytes: 256 * 1024, api: {
    queryAlbums: async request => connectedPage(request, values),
    queryAlbumTracks: async request => connectedTrackPage(request, values.find(value => value.id === request.albumKey)!),
    getArtwork: request => {
      assert.ok(jobs.length < 80, '固定滚动路径不允许自动循环耗尽保险丝')
      maximum = Math.max(maximum, ++running)
      return new Promise<LocalAlbumArtworkReply>(resolve => jobs.push({ request: { ...request }, resolve, returned: false })).finally(() => { running-- })
    },
  }, onChange: state => { if (liveProps) Object.assign(liveProps, { albums: state.items, artwork: state.artwork, active: state.active, loaded: state.loaded, total: state.total }) } })
  t.after(async () => { model.dispose(); for (const job of jobs) if (!job.returned) { job.returned = true; job.resolve(connectedArtworkReply(job.request, image)) }; await Promise.all(tasks) })
  await model.activate()
  liveProps = vue.reactive({ albums: model.getSnapshot().items, artwork: model.getSnapshot().artwork, active: true, loaded: true, total: 60,
    'onArtwork-window': (window: LocalAlbumArtworkWindow) => { windows.push(window); model.setArtworkWindow(window) },
    'onEnsure-artwork': (value: LocalAlbumSummary) => tasks.push(model.ensureArtwork(value)),
  })
  const f = await mounted(t, 'LocalAlbumGrid.vue', liveProps)
  const grid = f.all().find(el => el.props['data-grid-window'] === 'true')!, scroll = f.scroll(); assert.ok(grid)
  const originalStyle = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle')
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: () => ({ gridTemplateColumns: '212px 212px 212px 212px', columnGap: '24px', rowGap: '28px' }) })
  t.after(() => { if (originalStyle) Object.defineProperty(globalThis, 'getComputedStyle', originalStyle); else Reflect.deleteProperty(globalThis, 'getComputedStyle') })
  const rect = (top: number, height: number) => ({ x: 0, y: top, top, bottom: top + height, left: 0, right: 920, width: 920, height, toJSON: () => ({}) })
  Object.assign(scroll, { getBoundingClientRect: () => rect(0, 620) })
  Object.assign(grid, { getBoundingClientRect: () => rect(-scroll.scrollTop, Number.parseFloat(grid.style.height) || 0) })
  const query = grid.querySelector.bind(grid)
  // 行高固定为产品默认280；无DOM排版的Host不伪造probe测量或克隆IMG。
  grid.querySelector = selector => selector === '[data-grid-index]' ? null : query(selector)
  f.props.albums = [...model.getSnapshot().items]; await f.settle()
  assert.equal(windows.at(-1)!.visible.length, 12); assert.equal(windows.at(-1)!.nearby.length, 4)
  const release = async (index: number) => {
    const job = jobs[index]; assert.ok(job, `第${index + 1}项尚未实际派发`); assert.equal(job.returned, false)
    let stored = persistent.get(job.request.albumKey)
    if (stored) hits++; else { bodies++; persistent.set(job.request.albumKey, stored = image) }
    job.returned = true; job.resolve(connectedArtworkReply(job.request, stored)); await f.settle()
    const usage = model.getArtworkCacheUsage(); assert.ok(usage.bytes <= 256 * 1024); assert.ok(usage.entries <= 16); assert.ok(usage.running <= 2)
  }
  for (let index = 0; index < 16; index++) await release(index)
  assert.equal(jobs.length, 16); assert.equal(bodies, 16); assert.equal(model.artworkFor(values[0]!).status, 'ready')
  const jump = async (row: number) => {
    scroll.scrollTop = row * 308
    assert.equal(typeof scroll.listeners.scroll, 'function', '必须走正式useGridWindow安装的scroll监听')
    scroll.listeners.scroll!(f.event(scroll)); await f.settle()
  }
  await jump(10)
  assert.deepEqual(jobs.slice(16).map(job => job.request.albumKey), values.slice(40, 42).map(value => value.id))
  await jump(5)
  assert.equal(jobs.length, 18, '跳滚不应绕开旧两槽或派发其余旧窗口queue')
  assert.equal(model.getArtworkCacheUsage().running, 2); assert.equal(model.getArtworkCacheUsage().queued, 16)
  await release(16); await release(17)
  assert.deepEqual(jobs.slice(18, 20).map(job => job.request.albumKey), values.slice(20, 22).map(value => value.id), '旧槽真正settle后优先新可见，不能先读近邻')
  assert.equal(model.artworkFor(values[40]!).status, 'idle'); assert.equal(model.artworkFor(values[41]!).status, 'idle')
  assert.ok(jobs.every(job => !values.slice(42, 56).some(value => value.id === job.request.albumKey)), '未启动旧窗项必须零API')
  for (let index = 18; index < 34; index++) await release(index)
  assert.equal(jobs.length, 34); assert.equal(model.artworkFor(values[0]!).status, 'idle', '成功RAM淘汰必须真实发生')
  const beforeBody = bodies, beforeHits = hits
  await jump(0)
  for (let index = 34; index < 50; index++) await release(index)
  assert.deepEqual(jobs.slice(34).map(job => job.request.albumKey), values.slice(0, 16).map(value => value.id))
  assert.equal(bodies, beforeBody); assert.equal(hits - beforeHits, 16, 'Renderer应自动再次调用原读口，成功缓存替身可复用，不显示为失败重试')
  for (let turn = 0; turn < 4; turn++) await f.settle()
  assert.equal(jobs.length, 50); assert.equal(maximum, 2); assert.equal(running, 0)
  assert.ok(jobs.every(job => !Object.hasOwn(job.request, 'refresh')))
  assert.equal(model.getArtworkCacheUsage().queued, 0); assert.equal(model.getArtworkCacheUsage().running, 0)
  assert.equal(values.slice(0, 12).every(value => model.artworkFor(value).status === 'ready'), true)
  await jump(1)
  for (let index = 50; index < 54; index++) await release(index)
  assert.deepEqual(jobs.slice(50).map(job => job.request.albumKey), values.slice(16, 20).map(value => value.id))
  assert.equal(values.slice(4, 16).every(value => model.artworkFor(value).status === 'ready'), true, '容量不足时优先保真正可见12项')
  assert.equal(values.slice(0, 4).every(value => model.artworkFor(value).status === 'idle'), true, '当前近邻中的原成功项须真实发生RAM淘汰')
  const promotionBodies = bodies, promotionHits = hits
  await jump(0)
  for (let index = 54; index < 58; index++) await release(index)
  assert.deepEqual(jobs.slice(54).map(job => job.request.albumKey), values.slice(0, 4).map(value => value.id), '仍在兴趣窗的近邻晋升可见须自动续一次资格')
  assert.equal(bodies, promotionBodies); assert.equal(hits - promotionHits, 4)
  for (let turn = 0; turn < 4; turn++) await f.settle()
  assert.equal(jobs.length, 58, '恢复成功后的同窗状态变化不能循环续资格')
  assert.equal(values.slice(0, 12).every(value => model.artworkFor(value).status === 'ready'), true)
  assert.equal(maximum, 2); assert.equal(running, 0); assert.equal(model.getArtworkCacheUsage().queued, 0)
  model.deactivate(true); await f.settle(); assert.equal(model.getArtworkCacheUsage().entries, 0); assert.equal(model.getArtworkCacheUsage().bytes, 0)
})
