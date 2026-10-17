import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import ts from 'typescript'
import type { LocalLibraryPublicApi, LocalLibraryQuery, LocalLibraryQueryPage, LocalLibraryTrackDetail, LocalLibraryTrackSummary, LocalPlayRequest } from '@music-bridge/contracts'
import { useLocalLibrary } from '../src/renderer/src/composables/application/useLocalLibrary.js'
import { calculateVirtualWindow } from '../src/renderer/src/composables/virtualWindow.js'
import * as details from '../src/renderer/src/components/player/details.js'
import * as outboxController from '../src/renderer/src/components/command-outbox/controller.js'
import * as localAlbumBrowserTypes from '../src/renderer/src/composables/application/local-library-browser/types.js'
import * as localAlbumTrackPresentation from '../src/renderer/src/composables/application/local-library-browser/presentation.js'
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

test('009首次读取失败显示错误与重试，不能断言音乐库为空', async t => {
  const api = { queryLocalLibraryTracks: async () => { throw new Error('合成首次读取失败') }, listLocalLibraryRoots: async () => [], getLocalLibraryPlaybackTarget: async () => null, localLibraryScan: async () => ({ offset: 0, limit: 200, total: 0, hasMore: false, items: [] }) } as unknown as LocalLibraryPublicApi
  const model = useLocalLibrary({ api, getSelectedZone: () => undefined, play: async () => { throw new Error('不应点播') } }); t.after(() => model.dispose())
  const f = await mounted(t, path.join(componentRoot, 'library/LocalLibraryView.vue'), { session: model, playbackState: null }, api)
  assert.equal(model.loaded.value, false); assert.match(f.text(), /暂时无法读取.*重试读取/u); assert.doesNotMatch(f.text(), /本地音乐库还没有曲目/u); assert.ok(f.all().some(el => el.props.role === 'alert'))
})
test('009确认读取成功total为零才显示空库与目录加入引导', async t => {
  const api={queryLocalLibraryTracks:async(query:LocalLibraryQuery)=>queryPage(query,0),listLocalLibraryRoots:async()=>[],getLocalLibraryPlaybackTarget:async()=>null,localLibraryScan:async()=>({offset:0,limit:200,total:0,hasMore:false,items:[]})} as unknown as LocalLibraryPublicApi
  const model=useLocalLibrary({api,getSelectedZone:()=>undefined,play:async()=>{throw new Error('空库不得点播')}});t.after(()=>model.dispose())
  const f=await mounted(t,path.join(componentRoot,'library/LocalLibraryView.vue'),{session:model,playbackState:null},api)
  assert.equal(model.loaded.value,true);assert.equal(model.total.value,0);assert.match(f.text(),/本地音乐库还没有曲目/u);assert.match(f.text(),/展开目录与扫描管理/u);assert.equal(f.all().filter(el=>el.props.role==='alert').length,0)
})

test('009正式页面复用表格与目录控件，详情焦点/关闭返回，显示更正保留原始信息', async t => {
  const writes: any[] = [], sends: LocalPlayRequest[] = []; let name = ''; let trackReads = 0
  const api = { queryLocalLibraryTracks: async (query: LocalLibraryQuery) => queryPage(query), getLocalLibraryTrackDetail: async (trackId: string) => { const value = trackDetail(Number(trackId.slice(-12)) - 1000); if (name) { value.metadata.override = { trackId, revision: '1', fields: { title: name } }; value.metadata.effective = { ...value.metadata.raw, title: name } } return value }, getLocalLibraryPlaybackTarget: async () => ({ core_id: '受控Core', zone_id: '受控Zone' }), listLocalLibraryRoots: async () => [root], localLibraryScan: async () => ({ offset: 0, limit: 200, total: 0, hasMore: false, items: [] }), listLocalLibraryTracks: async () => { trackReads++; throw new Error('目录模式不得读取第二列表') }, overrideLocalLibraryMetadata: async (request: any) => { writes.push(request); name = request.fields.title; return { trackId: request.trackId, revision: '1', fields: request.fields } } } as unknown as LocalLibraryPublicApi
  const model = useLocalLibrary({ api, getSelectedZone: () => ({ zoneId: '受控Zone', displayName: '合成播放目标', selected: true }), play: async request => { sends.push(request); return { status: 'accepted', request_id: request.request_id, action: request.action } } }); t.after(() => model.dispose())
  const f = await mounted(t, path.join(componentRoot, 'library/LocalLibraryView.vue'), { session: model, playbackState: null }, api)
  assert.equal(f.all().filter(el => el.props['data-testid'] === 'local-library-settings').length, 1); assert.equal(f.all().filter(el => el.props.role === 'table').length, 1); assert.equal(trackReads, 0)
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
  await f.click(f.all().find(el => el.type === 'button' && f.text(el) === '授权源目录并加入音乐库')); assert.match(f.text(), /操作未获确认/u)
  readFails = true; await f.poll(); assert.match(f.text(), /读取未获确认/u); assert.match(f.text(), /操作未获确认/u)
  readFails = false; await f.poll(); assert.doesNotMatch(f.text(), /读取未获确认/u); assert.match(f.text(), /操作未获确认/u)
})
test('009R1 本地队列入口实际接回App原焦点路径，打开及关闭保持滚动', async t => {
  const appSource = readFileSync(path.join(componentRoot, '../App.vue'), 'utf8'), descriptor = parse(appSource).descriptor
  const source = ts.createSourceFile('App.ts', descriptor.scriptSetup!.content, ts.ScriptTarget.ES2022, true)
  const names = ['rememberInspectorFocus', 'openInspector', 'openQueue', 'closeInspector']
  const functions = source.statements.filter(node => ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)).map(node => node.getText(source)).join('\n')
  assert.equal(functions.match(/function /gu)?.length, 4)
  const findLocal = (node: any): any => node?.tag === 'LocalLibraryView' ? node : node?.children?.map(findLocal).find(Boolean)
  const local = findLocal(descriptor.template!.ast), binding = local.props.find((prop: any) => prop.name === 'on' && prop.arg?.content === 'open-queue')?.exp?.content
  assert.equal(binding, 'openQueue', '正式App本地入口须使用已存在的openQueue')
  let dispatch = () => {}
  const api = { queryLocalLibraryTracks: async (query: LocalLibraryQuery) => queryPage(query, 0), listLocalLibraryRoots: async () => [], getLocalLibraryPlaybackTarget: async () => null, localLibraryScan: async () => ({ offset: 0, limit: 200, total: 0, hasMore: false, items: [] }) } as unknown as LocalLibraryPublicApi
  const model = useLocalLibrary({ api, getSelectedZone: () => undefined, play: async () => { throw new Error('焦点测试不得点播') } }); t.after(() => model.dispose())
  const f = await mounted(t, path.join(componentRoot, 'library/LocalLibraryView.vue'), { session: model, playbackState: null, 'onOpen-queue': () => dispatch() }, api)
  const trigger = f.all().find(el => el.type === 'button' && f.text(el) === '打开原播放队列')!, close = f.node('button'); close.parent = trigger.parent
  const focusDocument = { get activeElement() { return f.active() }, querySelector: () => close }, inspectorOpen = vue.ref(false), inspectorReturnFocus = vue.ref(null)
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
function settingsUpdatedAncestor593(environment: Record<string, unknown>, onUpdated: (work: Promise<void>) => void): (component: import('vue').Component) => import('vue').Component {
  const { descriptor } = parse(readFileSync(path.resolve(componentRoot, '../App.vue'), 'utf8'))
  const settings: any[] = []
  const visit = (node: any): void => { if (node?.type === 1 && node.tag === 'SettingsView') settings.push(node); for (const child of node?.children ?? []) visit(child) }
  visit(descriptor.template?.ast); assert.equal(settings.length, 1, '只消费原 App 的唯一设置入口')
  const script = ts.createSourceFile('App.vue.ts', descriptor.scriptSetup!.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const functions = script.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'refreshLocalBrowserViews')
  assert.equal(functions.length, 1)
  const compile = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const refresh = new Function('albumBrowser', 'coverDropBrowser', 'localLibrary', `${compile(functions[0]!.getText(script))}\nreturn refreshLocalBrowserViews;`)(environment.albumBrowser, environment.coverDropBrowser, environment.localLibrary) as () => Promise<void>
  // 原完整节点包含全部 props、事件和 slot；补一个永假前邻，仅使原 v-else-if 在此受控祖链合法编译。
  const template = compileTemplate({ id: 'settings-ancestor593', filename: 'App.vue', source: `<template v-if="false"></template>${settings[0].loc.source}`, compilerOptions: { expressionPlugins: ['typescript'] } })
  assert.deepEqual(template.errors, [])
  const module = { exports: {} as { render: (...args: any[]) => any } }
  new Function('require', 'module', 'exports', compile(template.code))((name: string) => { assert.equal(name, 'vue'); return vue }, module, module.exports)
  const state = { ...environment, refreshLocalBrowserViews: () => { const work = refresh(); onUpdated(work); return work } }
  let ancestor: import('vue').Component | undefined
  return component => ancestor ??= vue.defineComponent({ inheritAttrs: false, components: { SettingsView: component }, setup: () => state, render: module.exports.render })
}

test('009设置目录变化向上传递一次，失效两页原读范围且挂载和同状态轮询不追加刷新', async t => {
  const { useLocalAlbumBrowserPages } = await import('../src/renderer/src/composables/application/local-library-browser/useLocalAlbumBrowser.js')
  const settingsNavigation = await import('../src/renderer/src/composables/useSettingsNavigation.js')
  const zoneLifecycle = await import('../src/renderer/src/zone-lifecycle.js')
  type AlbumQuery = import('../src/renderer/src/composables/application/local-library-browser/types.js').LocalAlbumQuery
  type AlbumPage = import('../src/renderer/src/composables/application/local-library-browser/types.js').LocalAlbumPage
  let revision = '1', rootReads = 0, trackReads = 0, updates = 0
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
  const api = { listLocalLibraryRoots: async () => { rootReads++; return [{ ...root, root: { ...root.root, revision } }] },
    localLibraryScan: async (command: string) => { assert.equal(command, 'localScan.page', '设置读取不启动扫描或写操作'); return { offset: 0, limit: 200, total: 0, hasMore: false, items: [] } },
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
  const wrap = settingsUpdatedAncestor593(environment, work => { updates++; pending.push(work) })
  const f = await mounted(t, path.join(componentRoot, 'settings/SettingsView.vue'), {}, api, {
    './AppearanceSettings.vue': unrelated, './CollectionReadonlySettings.vue': unrelated, './LocalAiSettings.vue': unrelated,
    './MobileConnectionSettings.vue': unrelated, './RoonDisplaySettings.vue': unrelated,
    '../../composables/useSettingsNavigation.js': settingsNavigation, '../../zone-lifecycle.js': zoneLifecycle,
  }, wrap)
  t.after(async () => { if (held) held.resolve(albumPage(held.request)); await Promise.all(pending) })
  assert.equal(rootReads, 0); assert.equal(updates, 0)
  await f.click(f.all().find(el => el.type === 'button' && el.props.role === 'tab' && f.text(el) === '应用'))
  assert.equal(rootReads, 1); assert.equal(trackReads, 1); assert.equal(updates, 0); assert.equal(albumRequests.length, 2, '原设置挂载不追加专辑查询')
  revision = '2'; await f.poll(); await Promise.all(pending)
  assert.equal(updates, 1); assert.equal(rootReads, 2); assert.equal(trackReads, 2)
  assert.equal(pages.localLibrary.snapshot.value.stale, true); assert.equal(pages.coverDrop.snapshot.value.stale, true)
  assert.equal(pages.localLibrary.snapshot.value.active, false); assert.equal(pages.coverDrop.snapshot.value.active, false)
  assert.equal(albumRequests.length, 2, '失效不激活后台页面，也不主动登记或扫描')
  assert.equal(pages.localLibrary.snapshot.value.items[0]!.revision, '1'); assert.equal(pages.coverDrop.snapshot.value.items[0]!.revision, '1')
  await f.poll(); assert.equal(updates, 1, '同一设置事实不重复发送变化事件'); assert.equal(albumRequests.length, 2)
  await pages.coverDrop.activate(); assert.equal(pages.coverDrop.snapshot.value.items[0]!.revision, '2')
  assert.equal(pages.localLibrary.snapshot.value.items[0]!.revision, '1')
  revision = '3'; holdNext = true; await f.poll()
  assert.equal(updates, 2); assert.equal(albumRequests.length, 4); assert.ok(held)
  assert.deepEqual(held.request, { query: '整理', rootId: id(2), filter: 'has-artwork', offset: 0, limit: 60 })
  assert.equal(pages.coverDrop.snapshot.value.refreshing, true); assert.equal(pages.localLibrary.snapshot.value.stale, true)
  assert.equal(pages.coverDrop.snapshot.value.items[0]!.revision, '2', '原刷新未返回前继续保留原成功结果')
  held.resolve(albumPage(held.request)); await Promise.all(pending)
  assert.equal(pages.coverDrop.snapshot.value.items[0]!.revision, '3'); assert.equal(pages.coverDrop.snapshot.value.refreshing, false)
  assert.equal(pages.localLibrary.snapshot.value.query, '本地'); assert.equal(pages.localLibrary.snapshot.value.rootId, id(1)); assert.equal(pages.localLibrary.snapshot.value.filter, 'all')
  assert.equal(pages.coverDrop.snapshot.value.query, '整理'); assert.equal(pages.coverDrop.snapshot.value.rootId, id(2)); assert.equal(pages.coverDrop.snapshot.value.filter, 'has-artwork')
  await pages.localLibrary.activate(); assert.equal(pages.localLibrary.snapshot.value.items[0]!.revision, '3')
  assert.equal(pages.coverDrop.snapshot.value.active, false)
})

// 只验证原 App 读取入口的友好阶段提示；受控回调不代表真实 Owner、Native 或普通 App。
test('009整理读取失败按原阶段回显，保留原请求顺序与null行为且换代不泄露内部错误', async () => {
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
  const target = { albumKey: '原专辑', rootId: id(1), revision: '原修订' }, captured = { albums: [{ album: { albumId: '原专辑', rootId: id(1) } }] }
  function fixture(failure: Failure) {
    const calls: string[] = [], rpc: { command: string; payload: unknown }[] = [], contexts: unknown[] = []
    const entryError = vue.ref(''), opening = vue.ref(false), error = vue.ref('原错误保留'), isOpen = vue.ref(false), currentView = vue.ref('coverdrop')
    let inspectedError = 0, rejectCapture!: (error: Error) => void, enterCapture!: () => void
    const entered = new Promise<void>(resolve => { enterCapture = resolve }), held = new Promise<never>((_resolve, reject) => { rejectCapture = reject })
    const privateError = Object.defineProperties(new Error(), { message: { get() { inspectedError++; return '合成内部原因 secret-marker' } }, stack: { get() { inspectedError++; throw new Error('不得读取内部stack') } } })
    const fail = (stage: Failure): void => { if (failure === stage) throw privateError }
    const environment = {
      window: { musicBridge: { localWorkbenchCapabilities: async () => { calls.push('capabilities'); fail('capabilities'); return {} },
        localLibraryManagement: async (command: string, payload: unknown) => { calls.push('capture'); rpc.push({ command, payload: structuredClone(payload) }); fail('capture'); if (failure === 'held-capture') { enterCapture(); return held } return captured } } },
      workbenchLibrary: { state: vue.ref({ datasetId: id(90) }), read: async () => { calls.push('library-read'); fail('library-read') },
        readNameSettings: async () => { calls.push('name-read'); fail('name-read') },
        captureLibraries: async (roots?: readonly string[]) => { calls.push('context'); contexts.push(roots); fail('context'); return failure === 'context-null' ? null : { lyricsLibraries: [] } } },
      workbenchPorts: {}, createLocalWorkbenchRendererPorts: () => { calls.push('ports'); fail('ports'); return {} },
      openOriginalMaintenance: () => { throw new Error('此受控入口不派发其他维护') }, maintenanceUiGeneration: 0,
      currentView, coverDropViewRef: vue.ref(null), localMaintenanceAvailability: () => false, localMaintenanceOpened: () => false,
      workbench: { isOpen, readback: vue.ref(null), error, openLibrary: () => { calls.push('open-library'); fail('open-library') },
        open: async () => { calls.push('open'); fail('open'); isOpen.value = failure !== 'closed' } },
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
    ['context', '音乐库读取未获确认，尚未准备任何写入。请重新读取。', [...initial, 'capture', 'open', 'context']],
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
    assert.equal(f.entryError.value, ''); assert.deepEqual(f.calls, [...initial, 'capture', 'open', 'context', 'bind'])
    assert.deepEqual(f.rpc, [{ command: albums.length === 1 ? 'library.album.capture' : 'library.albums.capture', payload: albums.length === 1 ? { albumId: target.albumKey, rootId: target.rootId, revision: target.revision }
      : { albums: albums.map(value => ({ albumId: value.albumKey, rootId: value.rootId, revision: value.revision })) } }])
    assert.deepEqual(f.contexts, [[id(1)]]); assert.equal(f.opening.value, false)
  }
  for (const albums of [[target], []]) {
    const f = fixture('context-null'); await f.runtime.captureWorkbenchTargets({ action: 'overview', albums })
    assert.equal(f.entryError.value, '', '原null行为仍不重新解释为拒绝'); assert.equal(f.error.value, '原错误保留')
    assert.deepEqual(f.calls, albums.length ? [...initial, 'capture', 'open', 'context', 'bind'] : [...initial, 'open-library', 'context'])
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

test('1132返回封面：正式LocalLibraryView父v-if卸载回入沿pages生命周期释放并补齐七图', async t => {
  const { useLocalAlbumBrowserPages } = await import('../src/renderer/src/composables/application/local-library-browser/useLocalAlbumBrowser.js')
  const { LOCAL_ALBUM_ARTWORK_CACHE_BYTES, LOCAL_ALBUM_ARTWORK_CONCURRENCY } = await import('../src/renderer/src/composables/application/local-library-browser/model.js')
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
  const expectedBytes = values.length * image.display.dataUrl.length * 2
  assert.ok(expectedBytes < LOCAL_ALBUM_ARTWORK_CACHE_BYTES, '七图全部低于原缓存预算，隔离顶层释放而非LRU淘汰')
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
  const heldPages: { request: AlbumQuery; resolve(reply: AlbumPage): void }[] = [], heldArtwork: { request: ArtworkRequest; resolve(reply: ArtworkReply): void }[] = []
  let holdPages = false, holdArtwork = false
  const scope = vue.effectScope(), pages = scope.run(() => useLocalAlbumBrowserPages({ api: {
    queryAlbums: request => { queries.push({ ...request }); return holdPages ? new Promise<AlbumPage>(resolve => heldPages.push({ request: { ...request }, resolve })) : Promise.resolve(albumPage(request)) },
    queryAlbumTracks: async request => { detailRequests.push({ ...request }); return trackPage(request) },
    getArtwork: request => { artworkRequests.push({ ...request }); return holdArtwork ? new Promise<ArtworkReply>(resolve => heldArtwork.push({ request: { ...request }, resolve })) : Promise.resolve({ ...request, image }) },
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
    for (const pending of heldPages.splice(0)) pending.resolve(albumPage(pending.request))
    for (const pending of heldArtwork.splice(0)) pending.resolve({ ...pending.request, image })
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
          imagesShown: images.every(shown), imageSourcesMatch: images.every(element => element.props.src === image.display.dataUrl) } }) })
  }
  const assertReadyGallery = (phase: string) => {
    record(phase)
    const state = pages.localLibrary.snapshot.value
    assert.equal(state.active, true); assert.equal(state.selectedAlbum, null); assert.equal(state.status, 'ready')
    assert.equal(f.all().filter(element => element.props['data-testid'] === 'local-library-view').length, 1)
    assert.equal(f.all().filter(element => element.props['data-testid'] === 'local-album-browser').length, 1, '必须挂正式Browser')
    assert.deepEqual(pages.localLibrary.getArtworkCacheUsage(), { entries: 7, bytes: expectedBytes, running: 0, queued: 0 })
    for (const value of values) {
      assert.equal(state.artwork[value.id]?.status, 'ready'); assert.equal(state.artwork[value.id]?.dataUrl, image.display.dataUrl)
      const card = cardFor(value); assert.ok(card)
      const images = f.all(card).filter(element => element.type === 'img')
      assert.equal(images.length, 1); assert.equal(images[0]!.props.src, image.display.dataUrl); assert.equal(shown(images[0]!), true)
    }
    assert.equal(f.imageErrors.length, 0, '此Host没有派发IMG error，不能把图片失败与缓存失效混为一谈')
    assert.doesNotMatch(f.text(), /封面暂未读取|封面待加载|封面尚未探测/u)
  }
  assertReadyGallery('首次七图ready')
  assert.deepEqual(artworkRequests, values.map(requestFor)); assert.equal(queries.length, 1)
  await f.click(cardFor(values[0]!))
  record('详情保留七图')
  assert.equal(pages.localLibrary.snapshot.value.selectedAlbum?.id, values[0]!.id); assert.equal(pages.localLibrary.snapshot.value.detailStatus, 'ready')
  const previousEpoch = pages.localLibrary.snapshot.value.artworkInvalidation?.epoch ?? 0
  showPage.value = false; await f.settle()
  record('父v-if卸载后缓存清空')
  assert.equal(f.all().filter(element => element.props['data-testid'] === 'local-library-view').length, 0)
  assert.equal(pages.localLibrary.snapshot.value.active, false); assert.equal(pages.localLibrary.snapshot.value.selectedAlbum?.id, values[0]!.id)
  assert.deepEqual(pages.localLibrary.getArtworkCacheUsage(), { entries: 0, bytes: 0, running: 0, queued: 0 })
  assert.equal(pages.localLibrary.snapshot.value.artworkInvalidation?.epoch, previousEpoch + 1)
  holdPages = holdArtwork = true; showPage.value = true; await f.settle()
  record('回入详情等待原读取')
  assert.equal(pages.localLibrary.snapshot.value.active, true); assert.equal(queries.length, 2); assert.equal(heldPages.length, 1)
  assert.equal(pages.localLibrary.snapshot.value.selectedAlbum?.id, values[0]!.id)
  assert.equal(pages.localLibrary.snapshot.value.artwork[values[0]!.id]?.status, 'loading', '回入必须由原View激活后为详情申请封面')
  await f.click(f.all().find(element => element.type === 'button' && f.text(element).trim() === '本地专辑'))
  record('回入返回首页等待七图')
  const waiting = pages.localLibrary.getArtworkCacheUsage()
  assert.equal(waiting.entries, 7); assert.equal(waiting.running, Math.min(values.length, LOCAL_ALBUM_ARTWORK_CONCURRENCY)); assert.equal(waiting.queued, values.length - waiting.running)
  assert.ok(values.every(value => pages.localLibrary.snapshot.value.artwork[value.id]?.status === 'loading'))
  holdPages = false
  const pendingPage = heldPages.shift()!; pendingPage.resolve(albumPage(pendingPage.request)); await f.settle()
  for (let index = 0; index < values.length; index++) {
    const pending = heldArtwork.shift(); assert.ok(pending, `回入第${index + 1}张原请求未派发`)
    pending.resolve({ ...pending.request, image }); await f.settle()
  }
  holdArtwork = false
  assertReadyGallery('回入七图重新ready')
  assert.deepEqual(artworkRequests.slice(values.length), values.map(requestFor), '同来源同修订的七图仅因实际离页释放后各补载一次')
  assert.equal(heldArtwork.length, 0); assert.equal(queries.length, 2); assert.equal(detailRequests.length, 1)
  assert.equal(pages.coverDrop.snapshot.value.active, false); assert.equal(pages.coverDrop.getArtworkCacheUsage().entries, 0)
})
