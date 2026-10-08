import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import ts from 'typescript'
import type { LocalLibraryPublicApi, LocalLibraryQuery, LocalLibraryQueryPage, LocalLibraryTrackDetail, LocalLibraryTrackSummary, LocalPlayRequest } from '@music-bridge/contracts'
import { useLocalLibrary } from '../src/renderer/src/composables/application/useLocalLibrary.js'
import { calculateVirtualWindow } from '../src/renderer/src/composables/virtualWindow.js'
import * as details from '../src/renderer/src/components/player/details.js'
import * as outboxController from '../src/renderer/src/components/command-outbox/controller.js'
import * as localArtwork from '../src/renderer/src/composables/application/useLocalArtwork.js'
import * as localRelocation from '../src/renderer/src/composables/application/useLocalRelocationPlans.js'

const require = createRequire(import.meta.url), vue = require('vue') as typeof import('vue')
const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`
const root = { root: { id: id(1), sourceRootId: id(2), role: 'library' as const, revision: '1' }, label: '合成只读目录', availability: 'ONLINE' as const }
function item(n: number): LocalLibraryTrackSummary { return { track: { id: id(1000 + n), assetId: id(2000 + n), selectionRevision: '1', segment: null }, asset: { id: id(2000 + n), libraryRootId: root.root.id, sourceRootId: root.root.sourceRootId, rootRevision: '1', fileRevision: '1', locationRevision: '1', sampleFrames: null, timebaseHz: null }, metadata: { title: `原始曲目 ${n}`, artist: '合成作者', album: '原始专辑' }, versionTokens: [] } }
function queryPage(query: LocalLibraryQuery, total = 245): LocalLibraryQueryPage { return { ...query, total, hasMore: query.offset + query.limit < total, items: Array.from({ length: Math.min(query.limit, Math.max(0, total - query.offset)) }, (_, offset) => item(query.offset + offset)) } }
function trackDetail(n: number): LocalLibraryTrackDetail { const value = item(n); return { track: value.track, asset: value.asset, metadata: { raw: value.metadata, effective: value.metadata, override: null }, editions: [], versionTokens: [], fileParameters: null } }

interface Host { type: string; tagName: string; text: string; props: Record<string, any>; children: Host[]; parent: Host | null; value: any; checked: boolean; listeners: Record<string, (event: any) => void>; style: Record<string, string>; scrollTop: number; clientHeight: number; focusCount: number; focusOptions?: FocusOptions; focus(options?: FocusOptions): void; closest(selector: string): Host | null; querySelector(selector: string): Host | null; showModal(): void; close(): void; addEventListener(name: string, fn: (event: any) => void): void; removeEventListener(name: string): void }
async function mounted(t: test.TestContext, file: string, initial: Record<string, unknown>, api: any = {}) {
  const timers = new Map<number, () => void>(); let timerId = 0
  const document = { activeElement: null as Host | null, addEventListener() {}, removeEventListener() {}, querySelector: (selector: string): Host | null => all().find(el => selector.startsWith('#') ? el.props.id === selector.slice(1) : selector.split(' ').every((part, index, parts) => index === parts.length - 1 ? String(el.props.class).split(' ').includes(part.slice(1)) : !!el.closest(part))) ?? null }
  const previousDocument = globalThis.document
  Object.assign(globalThis, { document }); t.after(() => { if (previousDocument) Object.assign(globalThis, { document: previousDocument }); else delete (globalThis as any).document })
  const node = (type = ''): Host => {
    const el: Host = { type, tagName: type.toUpperCase(), text: '', props: {}, children: [], parent: null, value: '', checked: false, listeners: {}, style: {}, scrollTop: 0, clientHeight: 620, focusCount: 0, focus(options) { document.activeElement = el; el.focusCount++; el.focusOptions = options }, closest(selector) { let current: Host | null = el; while (current) { if (String(current.props.class).split(' ').includes(selector.slice(1))) return current; current = current.parent } return null }, querySelector(selector) { const attribute = /^\[([^=]+)="([^"]+)"\]$/u.exec(selector); return all(el).find(candidate => attribute ? candidate.props[attribute[1]!] === attribute[2] : selector.startsWith('#') ? candidate.props.id === selector.slice(1) : String(candidate.props.class).split(' ').includes(selector.slice(1))) ?? null }, showModal() {}, close() {}, addEventListener(name, fn) { el.listeners[name] = fn }, removeEventListener(name) { delete el.listeners[name] } }
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
      if (name.endsWith('TrackArtwork.vue')) return { default: { render: () => vue.h('span', { class: 'test-artwork' }) } }
      if (name.endsWith('.vue')) return { default: load(path.resolve(path.dirname(filename), name)) }
      if (name.endsWith('/virtualWindow.js')) return { calculateVirtualWindow }
      if (name.endsWith('/details.js')) return details
      if (name.endsWith('/command-outbox/controller.js')) return outboxController
      if (name.endsWith('/useLocalArtwork') || name.endsWith('/useLocalArtwork.js')) return localArtwork
      if (name.endsWith('/useLocalRelocationPlans.js')) return localRelocation
      return localRequire(name)
    }
    const compile = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    new Function('require', 'module', 'exports', 'document', 'window', 'setTimeout', 'clearTimeout', compile(script.content))(imports, module, module.exports, document, { musicBridge: api, innerWidth: 1200, innerHeight: 900, addEventListener() {}, removeEventListener() {}, setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId }, clearTimeout: (id: number) => timers.delete(id) }, (callback: () => void) => { timers.set(++timerId, callback); return timerId }, (id: number) => timers.delete(id))
    new Function('require', 'module', 'exports', compile(template.code))(imports, renderModule, renderModule.exports)
    const component = { ...module.exports.default, render: renderModule.exports.render }; modules.set(filename, component); return component
  }
  const remove = (el: Host) => { if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1); el.parent = null }
  const renderer = vue.createRenderer<Host, Host>({ createElement: node, createText: text => ({ ...node('text'), text }), createComment: () => node('comment'), setText: (el, text) => { el.text = text }, setElementText: (el, text) => { el.text = text; el.children = [] }, patchProp: (el, key, _old, value) => { el.props[key] = value; if (['value', 'checked'].includes(key)) (el as any)[key] = value }, insert: (el, parent, anchor) => { remove(el); el.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(index < 0 ? parent.children.length : index, 0, el) }, remove, parentNode: el => el.parent, nextSibling: el => el.parent?.children[el.parent.children.indexOf(el) + 1] ?? null })
  const props = vue.reactive(initial), host = node('root'), app = renderer.createApp({ render: () => vue.h(load(file), props) }); let stopped = false
  app.mount(host); const unmount = () => { if (!stopped) { stopped = true; app.unmount() } }; t.after(unmount)
  const all = (el: Host = host): Host[] => [el, ...el.children.flatMap(child => all(child))]
  const text = (el: Host = host): string => el.text + el.children.map(child => text(child)).join('')
  const settle = async () => { for (let i = 0; i < 4; i++) { await new Promise<void>(resolve => setImmediate(resolve)); await vue.nextTick() } }
  const event = (el: Host, key = '') => ({ target: el, currentTarget: el, key, preventDefault() {}, stopPropagation() {} })
  const click = async (el: Host | undefined) => { assert.ok(el, '缺少点击目标'); el.props.onClick?.(event(el)); await settle() }
  const input = async (el: Host | undefined, value: string) => { assert.ok(el, '缺少输入目标'); el.value = value; el.listeners.input?.(event(el)); await vue.nextTick() }
  await settle()
  const poll = async () => { const entry = timers.entries().next().value; assert.ok(entry, '缺少已调度轮询'); timers.delete(entry[0]); entry[1](); await settle() }
  return { props, all, text, settle, event, click, input, poll, document, node, unmount, active: () => document.activeElement }
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
