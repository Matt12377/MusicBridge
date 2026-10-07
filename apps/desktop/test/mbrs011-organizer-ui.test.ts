import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import ts from 'typescript'
import type { LocalLibraryPublicApi, LocalLibraryQuery, LocalLibraryTrackDetail, LocalLibraryTrackSummary, LocalOrganizerPlan, LocalOrganizerPublicApi, PreviewLocalOrganizer } from '@music-bridge/contracts'
import { organizerPlanFixture } from '../../../packages/contracts/test/mbrs011/fixture.js'
import { useLocalLibrary } from '../src/renderer/src/composables/application/useLocalLibrary.js'
import * as organizer from '../src/renderer/src/composables/application/useLocalOrganizer.js'
import * as artwork from '../src/renderer/src/composables/application/useLocalArtwork.js'
import { calculateVirtualWindow } from '../src/renderer/src/composables/virtualWindow.js'
import * as details from '../src/renderer/src/components/player/details.js'
import * as outboxController from '../src/renderer/src/components/command-outbox/controller.js'

const require = createRequire(import.meta.url), vue = require('vue') as typeof import('vue')
const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`
const track = id(1000), edition = id(20), otherEdition = id(21), dataset = id(90), copy = <T>(value: T): T => structuredClone(value)
const editions = [{ id: edition, title: '同名专辑', edition: '现场', revision: '7' }, { id: otherEdition, title: '同名专辑', edition: '现场', revision: '8' }]
function preview(request: PreviewLocalOrganizer, state: LocalOrganizerPlan['state'] = 'DRAFT'): LocalOrganizerPlan {
  const value = organizerPlanFixture(); value.planId = request.commandId; value.datasetId = dataset; value.expiresAt = '2099-01-01T00:00:00.000Z'; value.state = state
  const tracks = request.target.mode === 'single' ? [request.target.trackId] : request.target.mode === 'batch' ? request.target.trackIds : [track, id(1001)]
  value.items = tracks.map((trackId, n) => {
    const item = copy(value.items[0]!); item.trackId = trackId; item.operation.operation_id = id(400 + n); item.operation.target_asset_id = id(2000 + n)
    item.raw = { title: `原始曲目 ${n}`, artist: '原始作者', album: '同名专辑', year: '2000', disc: '1', track: String(n + 1) }; item.before = { fields: { title: '当前人工标题', year: '2010' }, annotations: { versionDescription: '当前版本说明' } }; item.after = copy(item.before)
    for (const [name, change] of Object.entries(request.patch.fields)) { const field = name as keyof typeof item.after.fields; if (change.action === 'clear') delete item.after.fields[field]; else item.after.fields[field] = change.value }
    if (request.patch.annotations?.versionDescription) { const change = request.patch.annotations.versionDescription; if (change.action === 'clear') delete item.after.annotations.versionDescription; else item.after.annotations.versionDescription = change.value }
    if (request.patch.annotations?.groupingSuggestions) { const change = request.patch.annotations.groupingSuggestions; if (change.action === 'clear') delete item.after.annotations.groupingSuggestions; else item.after.annotations.groupingSuggestions = copy(change.value) }
    return item
  })
  value.body.operations = value.items.map(item => item.operation); value.results = value.items.map(item => ({ operationId: item.operation.operation_id, trackId: item.trackId, state: 'planned', overrideRevision: null, issue: null })); value.editionBindings = request.target.mode === 'edition' ? [{ editionId: request.target.editionId, revision: '7' }] : []
  return value
}
function fixture() {
  const stored = new Map<string, LocalOrganizerPlan>(), writes: string[] = [], previews: PreviewLocalOrganizer[] = []
  const api: LocalOrganizerPublicApi & { getCommandOutbox(): Promise<{ datasetId: string; entries: [] }> } = {
    getCommandOutbox: async () => ({ datasetId: dataset, entries: [] }),
    previewLocalOrganizer: async request => { previews.push(request); const value = preview(request); stored.set(value.planId, copy(value)); return value },
    getLocalOrganizerPlan: async request => copy(stored.get(request.planId)!),
    listLocalOrganizerHistory: async request => ({ ...request, total: stored.size, items: [...stored.values()].map(value => ({ planId: value.planId, revision: value.revision, state: value.state, scope: value.scope, createdAt: value.createdAt, count: value.items.length, issue: value.issue })).slice(request.offset, request.offset + request.limit) }),
    confirmLocalOrganizer: async request => { writes.push(request.commandId); const value = copy(stored.get(request.planId)!); value.revision = '3'; value.state = 'COMPLETED'; value.results = value.results.map(result => ({ ...result, state: 'applied', overrideRevision: '4' })); stored.set(value.planId, copy(value)); return value },
    undoLocalOrganizer: async request => { const value = copy(stored.get(request.planId)!); value.planId = request.commandId; value.revision = '1'; value.state = 'DRAFT'; value.undoOf = request.planId; value.items = value.items.map(item => ({ ...item, before: copy(item.after), after: copy(item.before) })); value.results = value.results.map(result => ({ ...result, state: 'planned' })); stored.set(value.planId, copy(value)); return value },
    cancelLocalOrganizer: async request => { const value = copy(stored.get(request.planId)!); value.revision = '2'; value.state = 'CANCELLED'; stored.set(value.planId, copy(value)); return value },
  }
  return { api, stored, writes, previews }
}

interface Host {
  type: string; tagName: string; text: string; props: Record<string, any>; children: Host[]; parent: Host | null; value: any; checked: boolean; selected: boolean; listeners: Record<string, (event: any) => void>; style: Record<string, string>; scrollTop: number; clientHeight: number; hidden: boolean; modalCount: number; closeCount: number;
  focus(options?: FocusOptions): void; closest(selector: string): Host | null; querySelector(selector: string): Host | null; querySelectorAll(selector: string): Host[]; getClientRects(): object[]; getRootNode(): object; showModal(): void; close(): void; addEventListener(name: string, fn: (event: any) => void): void; removeEventListener(name: string): void;
}
/** 编译并挂载真实Vue组件；宿主只提供DOM接口，不替换会话逻辑或模板。 */
async function mounted(t: test.TestContext, file: string, initial: Record<string, unknown>, api: any = {}, slots?: Record<string, (...args: any[]) => any>) {
  class HTMLElement {}
  class Document {}
  class ShadowRoot {}
  const previousDocument = globalThis.document, previousHTMLElement = globalThis.HTMLElement, previousDocumentType = globalThis.Document, previousShadowRoot = globalThis.ShadowRoot
  const timers = new Map<number, () => void>(); let timerId = 0
  const document = Object.assign(new Document(), { activeElement: null as Host | null, addEventListener() {}, removeEventListener() {}, querySelector: (selector: string) => all().find(el => selector.startsWith('#') ? el.props.id === selector.slice(1) : String(el.props.class).split(' ').includes(selector.slice(1))) ?? null })
  Object.assign(globalThis, { document, HTMLElement, Document, ShadowRoot })
  const restoreGlobals = () => { for (const [key, value] of Object.entries({ document: previousDocument, HTMLElement: previousHTMLElement, Document: previousDocumentType, ShadowRoot: previousShadowRoot })) { if (value) Object.assign(globalThis, { [key]: value }); else delete (globalThis as any)[key] } }
  const node = (type = ''): Host => {
    const el: Host = { type, tagName: type.toUpperCase(), text: '', props: {}, children: [], parent: null, value: '', checked: false, selected: false, listeners: {}, style: {}, scrollTop: 0, clientHeight: 620, hidden: false, modalCount: 0, closeCount: 0,
      focus() { document.activeElement = el }, closest(selector) { let current: Host | null = el; while (current) { if (String(current.props.class).split(' ').includes(selector.slice(1))) return current; current = current.parent }; return null },
      querySelector(selector) { const attribute = /^\[([^=]+)="([^"]+)"\]$/u.exec(selector); return all(el).find(candidate => attribute ? candidate.props[attribute[1]!] === attribute[2] : selector.startsWith('#') ? candidate.props.id === selector.slice(1) : String(candidate.props.class).split(' ').includes(selector.slice(1))) ?? null },
      querySelectorAll() { return all(el).filter(value => (['button', 'input', 'select', 'textarea', 'summary'].includes(value.type) || value.props.tabindex === 0 || value.props.tabindex === '0') && !value.props.disabled) },
      getClientRects: () => [{}], getRootNode: () => document, showModal() { el.modalCount++ }, close() { el.closeCount++ }, addEventListener(name, fn) { el.listeners[name] = fn }, removeEventListener(name) { delete el.listeners[name] } }
    Object.setPrototypeOf(el, HTMLElement.prototype)
    Object.defineProperties(el, { isConnected: { get: () => { let current = el; while (current.parent) current = current.parent; return current.type === 'root' } }, options: { get: () => el.children.filter(child => child.type === 'option') }, multiple: { get: () => !!el.props.multiple } })
    return vue.markRaw(el)
  }
  const modules = new Map<string, import('vue').Component>()
  const load = (filename: string): import('vue').Component => {
    const known = modules.get(filename); if (known) return known
    const { descriptor } = parse(readFileSync(filename, 'utf8')), script = compileScript(descriptor, { id: filename })
    const template = compileTemplate({ id: filename, filename, source: descriptor.template!.content, compilerOptions: { bindingMetadata: script.bindings } }); assert.deepEqual(template.errors, [])
    const module = { exports: {} as { default: import('vue').Component } }, renderModule = { exports: {} as { render: (...args: any[]) => any } }, localRequire = createRequire(filename)
    const imports = (name: string) => {
      if (name === 'vue') return vue
      if (name.endsWith('TrackArtwork.vue')) return { default: { render: () => vue.h('span', { class: 'test-artwork' }) } }
      if (name.endsWith('.vue')) return { default: load(path.resolve(path.dirname(filename), name)) }
      if (name.endsWith('/useLocalOrganizer.js')) return organizer
      if (name.endsWith('/useLocalArtwork') || name.endsWith('/useLocalArtwork.js')) return artwork
      if (name.endsWith('/virtualWindow.js')) return { calculateVirtualWindow }
      if (name.endsWith('/details.js')) return details
      if (name.endsWith('/command-outbox/controller.js')) return outboxController
      return localRequire(name)
    }
    const compile = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    const window = { musicBridge: api, innerWidth: 1200, innerHeight: 900, addEventListener() {}, removeEventListener() {}, setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId }, clearTimeout: (id: number) => timers.delete(id) }
    new Function('require', 'module', 'exports', 'document', 'window', 'setTimeout', 'clearTimeout', compile(script.content))(imports, module, module.exports, document, window, window.setTimeout, window.clearTimeout)
    new Function('require', 'module', 'exports', compile(template.code))(imports, renderModule, renderModule.exports)
    const component = { ...module.exports.default, render: renderModule.exports.render }; modules.set(filename, component); return component
  }
  const remove = (el: Host) => { if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1); el.parent = null }
  const renderer = vue.createRenderer<Host, Host>({ createElement: node, createText: text => ({ ...node('text'), text }), createComment: () => node('comment'), setText: (el, text) => { el.text = text }, setElementText: (el, text) => { el.text = text; el.children = [] }, patchProp: (el, key, _old, value) => { el.props[key] = value; if (['value', 'checked', 'selected'].includes(key)) (el as any)[key] = value }, insert: (el, parent, anchor) => { remove(el); el.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(index < 0 ? parent.children.length : index, 0, el) }, remove, parentNode: el => el.parent, nextSibling: el => el.parent?.children[el.parent.children.indexOf(el) + 1] ?? null })
  const props = vue.reactive(initial), host = node('root'), app = renderer.createApp({ render: () => vue.h(load(file), props, slots) }); let stopped = false
  app.mount(host); const unmount = () => { if (!stopped) { stopped = true; app.unmount() } }; t.after(async () => { unmount(); await settle(); restoreGlobals() })
  const all = (el: Host = host): Host[] => [el, ...el.children.flatMap(child => all(child))], text = (el: Host = host): string => el.text + el.children.map(child => text(child)).join('')
  const settle = async () => { for (let n = 0; n < 4; n++) { await new Promise<void>(resolve => setImmediate(resolve)); await vue.nextTick() } }
  const event = (el: Host, key = '', shiftKey = false) => ({ target: el, currentTarget: el, key, shiftKey, prevented: false, stopped: false, preventDefault() { this.prevented = true }, stopPropagation() { this.stopped = true } })
  const dispatch = (value: any, event: any) => { if (Array.isArray(value)) value.forEach(fn => fn(event)); else value?.(event) }
  const click = async (el: Host | undefined) => { assert.ok(el, '缺少点击目标'); assert.ok(!el.props.disabled, '不能点击禁用入口'); el.focus(); dispatch(el.props.onClick, event(el)); await settle() }
  const input = async (el: Host | undefined, value: string) => { assert.ok(el, '缺少输入目标'); el.value = value; dispatch(el.listeners.input, event(el)); dispatch(el.props.onInput, event(el)); await settle() }
  const change = async (el: Host | undefined, value: string) => { assert.ok(el, '缺少选择目标'); el.value = value; el.children.filter(child => child.type === 'option').forEach(option => { option.selected = option.props.value === value }); dispatch(el.listeners.change, event(el)); dispatch(el.props.onChange, event(el)); await settle() }
  await settle(); return { all, text, event, click, input, change, settle, unmount, active: () => document.activeElement, node, host }
}
const componentRoot = path.resolve(import.meta.dirname, '../src/renderer/src/components'), dialogFile = path.join(componentRoot, 'library/LocalOrganizerDialog.vue')
async function ready(t: test.TestContext, selection: Parameters<ReturnType<typeof organizer.useLocalOrganizer>['open']>[0] = { mode: 'single', trackId: track }) {
  const f = fixture(), model = vue.markRaw(organizer.useLocalOrganizer({ api: f.api })); t.after(() => model.dispose()); await model.open(selection, '明确选择', editions)
  const ui = await mounted(t, dialogFile, { session: model }); return { ...f, model, ui }
}
const button = (ui: Awaited<ReturnType<typeof mounted>>, label: string) => ui.all().find(el => el.type === 'button' && ui.text(el) === label)

test('011真实对话框六字段默认保持，空串与清除人工更正并列预览且零自动保存', async t => {
  const f = await ready(t), { ui, model } = f
  assert.equal(ui.all().find(el => el.type === 'dialog')?.modalCount, 1); assert.equal(ui.active()?.props.id, 'local-organizer-title')
  assert.equal(ui.all().filter(el => el.type === 'select' && String(el.props['aria-label']).endsWith('更正方式')).length, 6); assert.equal(button(ui, '预览更正')?.props.disabled, true)
  await ui.change(ui.all().find(el => el.props.id === 'organizer-title-action'), 'set'); await ui.input(ui.all().find(el => el.props.id === 'organizer-title-value'), '')
  await ui.change(ui.all().find(el => el.props.id === 'organizer-year-action'), 'clear')
  const form = ui.all().find(el => el.props['aria-label'] === '具体信息更正')!; form.props.onSubmit(ui.event(form)); await ui.settle()
  assert.equal(f.previews.length, 1); assert.equal(f.writes.length, 0); assert.equal(model.plan.value?.state, 'DRAFT')
  const headers = ui.all().filter(el => el.type === 'th' && el.props.scope === 'col').map(el => ui.text(el)); assert.deepEqual(headers, ['字段', '原始标签', '当前人工更正', '当前生效值', '待保存生效值'])
  const rows = ui.all().filter(el => el.type === 'tr'), titleRow = rows.find(el => ui.text(el).startsWith('标题'))!, yearRow = rows.find(el => ui.text(el).startsWith('年份'))!
  assert.deepEqual(titleRow.children.filter(el => el.type === 'td').map(el => ui.text(el)), ['原始曲目 0', '当前人工标题', '当前人工标题', '空值']); assert.match(ui.text(yearRow), /2000.*2010.*2010.*2000恢复原始标签/u)
  assert.match(ui.text(), /尚未保存/u); assert.doesNotMatch(ui.text(), /planHash|contextFingerprint|[ab]{64}/u); assert.ok(button(ui, '保存这些更正')); assert.equal(button(ui, '保存这些更正')?.props.disabled, false)
})

test('011版本说明与edition/revision/reason建议通过真实控件预览，注记不改变发行身份', async t => {
  const { ui, previews, model } = await ready(t)
  await ui.change(ui.all().find(el => el.props.id === 'organizer-version-action'), 'set'); await ui.input(ui.all().find(el => el.props.id === 'organizer-version-value'), '同名发行的人工辨认说明')
  await ui.change(ui.all().find(el => el.props.id === 'organizer-grouping-action'), 'set')
  const select = ui.all().find(el => el.type === 'select' && el.children.some(option => option.props.value === otherEdition))!
  await ui.change(select, otherEdition); const reason = ui.all().find(el => el.type === 'input' && el.parent?.type === 'label' && ui.text(el.parent).includes('建议理由')); await ui.input(reason, '此发行独立保留，仅建议关联'); await ui.click(button(ui, '加入建议'))
  assert.match(ui.text(), /说明帮助辨认版本，不改变独立发行身份/u); assert.match(ui.text(), /不合并发行或删除关联/u); assert.equal(model.annotations.groupingSuggestions.length, 1)
  const form = ui.all().find(el => el.type === 'form')!; form.props.onSubmit(ui.event(form)); await ui.settle()
  assert.deepEqual(previews[0]?.patch.annotations, { versionDescription: { action: 'set', value: '同名发行的人工辨认说明' }, groupingSuggestions: { action: 'set', value: [{ editionId: otherEdition, expectedRevision: '8', reason: '此发行独立保留，仅建议关联' }] } })
})

test('011具体保存后按真实逐项结果显示，返回编辑使旧预览失效', async t => {
  const f = await ready(t), { ui, model } = f
  await ui.change(ui.all().find(el => el.props.id === 'organizer-title-action'), 'set'); await ui.input(ui.all().find(el => el.props.id === 'organizer-title-value'), '本次人工值')
  const form = ui.all().find(el => el.type === 'form')!; form.props.onSubmit(ui.event(form)); await ui.settle(); await ui.click(button(ui, '返回编辑'))
  assert.equal(model.plan.value, null); assert.equal(button(ui, '保存这些更正'), undefined); await ui.input(ui.all().find(el => el.props.id === 'organizer-title-value'), '最终人工值'); form.props.onSubmit(ui.event(form)); await ui.settle()
  await ui.click(button(ui, '保存这些更正')); assert.equal(f.writes.length, 1); assert.match(ui.text(), /已完成.*已保存/u); assert.equal(button(ui, '保存这些更正')?.props.disabled, true); assert.ok(button(ui, '预览撤销'))
  await ui.click(button(ui, '预览撤销')); assert.equal(f.writes.length, 1); assert.match(ui.text(), /反向预览，明确保存后才执行撤销/u); assert.equal(button(ui, '保存这些更正')?.props.disabled, false)
})

test('011部分完成/未写入/未知逐项信息不会呈现全部成功', async t => {
  const f = await ready(t, { mode: 'batch', trackIds: [track, id(1001), id(1002)] }), { ui, model } = f
  model.setFieldAction('title', 'set'); model.setFieldValue('title', '批量人工值'); await model.preview()
  const value = copy(model.plan.value!); value.state = 'PARTIAL'; value.revision = '3'; value.results[0]!.state = 'applied'; value.results[1]!.state = 'not-written'; value.results[2]!.state = 'unknown'; value.results[2]!.issue = 'WRITE_RESULT_UNKNOWN'; f.stored.set(value.planId, value)
  await model.loadPlan(value.planId); await ui.settle()
  assert.match(ui.text(), /部分完成/u); assert.deepEqual(ui.all().filter(el => String(el.props.class).includes('organizer-item-result')).map(el => ui.text(el).split(' · ')[0]), ['已保存', '未写入', '结果未知']); assert.equal(button(ui, '预览撤销'), undefined); assert.equal(button(ui, '保存这些更正')?.props.disabled, true)
})

test('011真实对话框Tab环绕、Esc关闭回到原入口，原页面三按钮与标题保存保留', async t => {
  const f = fixture(), libraryRoot = { root: { id: id(1), sourceRootId: id(2), role: 'library' as const, revision: '1' }, label: '合成目录', availability: 'ONLINE' as const }
  const summary: LocalLibraryTrackSummary = { track: { id: track, assetId: id(2000), selectionRevision: '1', segment: null }, asset: { id: id(2000), libraryRootId: id(1), sourceRootId: id(2), rootRevision: '1', fileRevision: '1', locationRevision: '1', sampleFrames: null, timebaseHz: null }, metadata: { title: '原始曲目 0', album: '同名专辑' }, versionTokens: [] }
  const detail: LocalLibraryTrackDetail = { track: summary.track, asset: summary.asset, metadata: { raw: summary.metadata, effective: summary.metadata, override: null }, editions, versionTokens: [], fileParameters: null }
  const api = { ...f.api, queryLocalLibraryTracks: async (query: LocalLibraryQuery) => ({ ...query, total: 1, hasMore: false, items: [summary] }), getLocalLibraryTrackDetail: async () => detail, listLocalLibraryRoots: async () => [libraryRoot], getLocalLibraryPlaybackTarget: async () => null, localLibraryScan: async () => ({ offset: 0, limit: 200, total: 0, hasMore: false, items: [] }) } as unknown as LocalLibraryPublicApi & typeof f.api
  const model = useLocalLibrary({ api, getSelectedZone: () => undefined, play: async () => { throw new Error('本测试不得点播') } }); t.after(() => model.dispose())
  const ui = await mounted(t, path.join(componentRoot, 'library/LocalLibraryView.vue'), { session: model, playbackState: null }, api)
  const row = ui.all().find(el => String(el.props.class).split(' ').includes('track-row'))!, actions = ui.all(row).find(el => String(el.props.class).includes('row-actions'))!
  assert.equal(ui.all(actions).filter(el => el.type === 'button').length, 3); await ui.click(ui.all().find(el => el.props['data-local-detail-track'] === track)); assert.ok(button(ui, '保存显示更正')); assert.ok(button(ui, '选择封面')); assert.ok(button(ui, '选择重新定位候选')); assert.ok(button(ui, '打开原播放队列'))
  const trigger = button(ui, '整理此曲目信息')!; await ui.click(trigger); const dialog = ui.all().find(el => el.type === 'dialog')!; assert.equal(ui.active()?.props.id, 'local-organizer-title')
  const enabled = dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]'), first = enabled[0]!, last = enabled.at(-1)!
  const backwards = ui.event(dialog, 'Tab', true); dialog.props.onKeydown(backwards); assert.equal(backwards.prevented, true); assert.equal(ui.active(), last)
  const forwards = ui.event(dialog, 'Tab'); dialog.props.onKeydown(forwards); assert.equal(forwards.prevented, true); assert.equal(ui.active(), first)
  dialog.props.onCancel(ui.event(dialog, 'Escape')); await ui.settle(); assert.equal(model.organizer.isOpen.value, false); assert.equal(ui.active(), trigger); assert.equal(dialog.closeCount, 1)
  const sameNameButtons = ui.all().filter(el => el.type === 'button' && String(el.props['aria-label']).startsWith('整理具体发行')); assert.equal(sameNameButtons.length, 2); assert.notEqual(sameNameButtons[0]?.props['aria-label'], sameNameButtons[1]?.props['aria-label'])
  await ui.click(sameNameButtons[1]); assert.deepEqual(model.organizer.target.value, { mode: 'edition', editionId: otherEdition }); assert.match(ui.text(), new RegExp(otherEdition.slice(-8), 'u'))
})

test('011leading slot只按本地选择开关增加第四列，跨搜索identity保留且Enter不触发播放', async t => {
  const f = fixture(), summaries = [0, 1].map(n => ({ track: { id: id(1000 + n), assetId: id(2000 + n), selectionRevision: '1', segment: null }, asset: { id: id(2000 + n), libraryRootId: id(1), sourceRootId: id(2), rootRevision: '1', fileRevision: '1', locationRevision: '1', sampleFrames: null, timebaseHz: null }, metadata: { title: `原始曲目 ${n}` }, versionTokens: [] }))
  const api = { ...f.api, queryLocalLibraryTracks: async (query: LocalLibraryQuery) => ({ ...query, total: 1, hasMore: false, items: [summaries[query.query === '第二页' ? 1 : 0]] }), listLocalLibraryRoots: async () => [], getLocalLibraryPlaybackTarget: async () => null, localLibraryScan: async () => ({ offset: 0, limit: 200, total: 0, hasMore: false, items: [] }) } as unknown as LocalLibraryPublicApi & typeof f.api
  let plays = 0; const model = useLocalLibrary({ api, getSelectedZone: () => undefined, play: async () => { plays++; throw new Error('选择不应点播') } }); t.after(() => model.dispose())
  const ui = await mounted(t, path.join(componentRoot, 'library/LocalLibraryView.vue'), { session: model, playbackState: null }, api)
  const table = () => ui.all().find(el => el.props.role === 'table')!; assert.equal(table().props['aria-colcount'], 3); await ui.click(button(ui, '选择曲目')); assert.equal(table().props['aria-colcount'], 4)
  assert.deepEqual(ui.all().filter(el => el.props.role === 'columnheader').map(el => ui.text(el)), ['选择', '歌曲', '时长', '操作'])
  const checkbox = ui.all().find(el => el.type === 'input' && el.props.type === 'checkbox')!, label = checkbox.parent!; checkbox.props.onChange(ui.event(checkbox)); const enter = ui.event(label, 'Enter'); label.props.onKeydown(enter); await ui.settle(); assert.equal(enter.stopped, true); assert.equal(plays, 0)
  await model.search('第二页'); await ui.settle(); const next = ui.all().find(el => el.type === 'input' && el.props.type === 'checkbox')!; next.props.onChange(ui.event(next)); await ui.settle(); assert.deepEqual(model.selectedTrackIds.value, [track, id(1001)])
  await ui.click(button(ui, '整理已选曲目')); assert.deepEqual(model.organizer.target.value, { mode: 'batch', trackIds: [track, id(1001)] }); model.organizer.close(); await ui.settle(); await ui.click(button(ui, '结束选择')); assert.equal(table().props['aria-colcount'], 3); assert.equal(model.selectedTrackIds.value.length, 2)
})

test('011历史首次失败保留错误不伪称空，查看持久记录与撤销预览均不自动保存', async t => {
  const f = fixture(), model = vue.markRaw(organizer.useLocalOrganizer({ api: f.api })); t.after(() => model.dispose())
  const originalHistory = f.api.listLocalOrganizerHistory; f.api.listLocalOrganizerHistory = async () => { throw new Error('合成首次失败') }; await model.openHistory()
  const ui = await mounted(t, dialogFile, { session: model }); assert.match(ui.text(), /历史暂时无法读取/u); assert.doesNotMatch(ui.text(), /还没有整理记录/u)
  const value = preview({ commandId: id(500), scope: 'MB_ONLY', target: { mode: 'single', trackId: track }, patch: { fields: { title: { action: 'set', value: '已保存人工值' } } } }, 'COMPLETED'); value.revision = '3'; value.results[0]!.state = 'applied'; f.stored.set(value.planId, value); f.api.listLocalOrganizerHistory = originalHistory
  await ui.click(button(ui, '重新读取核对')); assert.match(ui.text(), /1 首 · 已完成/u); await ui.click(button(ui, '查看记录')); assert.equal(model.plan.value?.planId, value.planId); assert.equal(f.writes.length, 0); await ui.click(button(ui, '预览撤销')); assert.equal(model.plan.value?.undoOf, value.planId); assert.equal(f.writes.length, 0); assert.match(ui.text(), /反向预览/u)
})

test('011选择列的虚拟占位行保留4个cell，未读取identity不生成选择控件', async t => {
  const track = { id: id(1000), title: '已读取曲目', artists: ['原始作者'], album: '合成专辑' }
  const ui = await mounted(t, path.join(componentRoot, 'media/TrackTable.vue'), { tracks: [track], rangeWindow: { total: 200, entries: [{ index: 0, track }] } }, {}, { 'row-leading': ({ track }) => vue.h('input', { type: 'checkbox', 'aria-label': `选择 ${track.title}` }) })
  const table = ui.all().find(el => el.props.role === 'table')!; assert.equal(table.props['aria-colcount'], 4)
  const placeholders = ui.all().filter(el => String(el.props.class).split(' ').includes('track-row-placeholder')); assert.ok(placeholders.length > 0)
  for (const row of placeholders) { assert.equal(ui.all(row).filter(el => el.props.role === 'cell').length, 4); assert.equal(ui.all(row).filter(el => el.type === 'input').length, 0); assert.equal(ui.all(row).find(el => el.props['aria-label'] === '选择暂不可用')?.props.role, 'cell') }
})
