import assert from 'node:assert/strict'
import test from 'node:test'
import * as Vue from 'vue'
import { createRenderer, nextTick, ref } from 'vue'
import { compileTemplate, parse } from 'vue/compiler-sfc'
import { readFileSync } from 'node:fs'
import { ScriptTarget, transpileModule } from 'typescript'
import { useCollection } from '../src/renderer/src/composables/useCollection.js'
import { createCollectionReadonlyPreference } from '../src/renderer/src/components/settings/collection-readonly-preference.js'
import type { CollectionReadonlySettings } from '@music-bridge/contracts'
const off: CollectionReadonlySettings = { schemaVersion: 1, enabled: false, mode: 'node', state: 'off' }
const ready: CollectionReadonlySettings = { schemaVersion: 1, enabled: true, mode: 'rust', state: 'ready' }
const tick = async () => { await new Promise<void>(resolve => setImmediate(resolve)); await nextTick() }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

test('设置控件ON等待期间允许OFF，旧回执/读/unmount不回跳', async () => {
  const on = deferred<CollectionReadonlySettings>(); const calls: boolean[] = []
  const preference = createCollectionReadonlyPreference({ getCollectionReadonlySettings: async () => off, setCollectionReadonlyEnabled: enabled => { calls.push(enabled); return enabled ? on.promise : Promise.resolve(off) } })
  const first = preference.select(true); assert.equal(preference.requested.value, true)
  await preference.select(false); on.resolve(ready); await first; await tick()
  assert.deepEqual(calls, [true, false]); assert.deepEqual(preference.settings.value, off)
  preference.close(); await preference.select(true); assert.deepEqual(calls, [true, false])
})
function mountInventory(t: test.TestContext) {
  const list: { page: { offset: number }; filter: unknown; resolve: (value: unknown) => void }[] = []
  const details: { id: string; page: { offset: number }; resolve: (value: unknown) => void }[] = []
  const refresh = deferred<{ schemaVersion: 1; refreshed: boolean; settings: CollectionReadonlySettings }>(); let refreshCalls = 0
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { musicBridge: {
    listCollection: (page: { offset: number }, filter: unknown) => new Promise(resolve => { list.push({ page, filter, resolve }) }),
    getCollectionModel: (id: string, page: { offset: number }) => new Promise(resolve => { details.push({ id, page, resolve }) }),
    refreshCollection: () => { refreshCalls++; return refresh.promise },
  } } })
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'window', descriptor); else Reflect.deleteProperty(globalThis, 'window') })
  type Node = { parent: Node | null }
  const node = (): Node => ({ parent: null })
  const renderer = createRenderer<Node, Node>({ createElement: node, createText: node, createComment: node, setText() {}, setElementText() {}, patchProp() {}, insert(child, parent) { child.parent = parent }, remove(child) { child.parent = null }, parentNode: item => item.parent, nextSibling: () => null })
  let inventory!: ReturnType<typeof useCollection>
  const app = renderer.createApp({ setup() { inventory = useCollection(); return () => null } }); app.mount(node())
  let closed = false; const unmount = () => { if (!closed) { closed = true; app.unmount() } }; t.after(unmount)
  const resolveList = (index: number, total: number) => list[index]!.resolve({ items: [], total, offset: list[index]!.page.offset, limit: 24 })
  return { inventory, list, details, refresh, refreshCalls: () => refreshCalls, resolveList, unmount }
}
test('真实Vue刷新前撤旧读，完成后最新filter/page/detail；关闭详情不回跳', async t => {
  const f = mountInventory(t), pending = f.inventory.refresh()
  const catalog = () => f.inventory.catalog.value
  f.resolveList(0, 100); await tick(); assert.equal(catalog(), undefined)
  f.inventory.filter.value = { brand: '最新品牌' }; void f.inventory.load(24); void f.inventory.openModel('最新型号', 20)
  f.resolveList(1, 26); await tick(); assert.equal(catalog()?.offset, 24)
  f.refresh.resolve({ schemaVersion: 1, refreshed: true, settings: ready }); await tick()
  assert.deepEqual(f.list[2]!.filter, { brand: '最新品牌' }); assert.equal(f.list[2]!.page.offset, 24)
  f.resolveList(2, 27); await tick(); assert.equal(f.details[1]!.id, '最新型号'); assert.equal(f.details[1]!.page.offset, 20)
  f.inventory.closeModel(); f.details[1]!.resolve({ model: { id: '最新型号' } }); f.details[0]!.resolve({ model: { id: '旧型号' } })
  await pending; assert.equal(f.inventory.detail.value, undefined); assert.equal(catalog()?.total, 27)
})
test('unknown保存不发刷新；unmount后的刷新不能再读取/更改notice', async t => {
  const f = mountInventory(t)
  f.inventory.pending.value = async () => { throw new Error('unknown') }
  await f.inventory.refresh(); assert.equal(f.refreshCalls(), 0)
  f.inventory.pending.value = undefined
  const pending = f.inventory.refresh(); f.unmount(); f.refresh.resolve({ schemaVersion: 1, refreshed: false, settings: off }); await pending
  assert.equal(f.list.length, 1); assert.equal(f.inventory.notice.value, '')
})

test('真实收藏模板的列表与详情都有普通刷新入口，未知保存及刷新中不可重复提交', async t => {
  const source = readFileSync(new URL('../src/renderer/src/components/collection/CollectionView.vue', import.meta.url), 'utf8')
  const template = parse(source).descriptor.template?.content
  assert.ok(template)
  type ViewNode = { tag: string; tagName: string; text: string; style: Record<string, string>; props: Record<string, unknown>; children: ViewNode[]; parent: ViewNode | null; value: unknown; selectedIndex: number; options: ViewNode[]; addEventListener: () => void }
  const node = (tag = ''): ViewNode => ({ tag, tagName: tag.toUpperCase(), text: '', style: {}, props: {}, children: [], parent: null, value: '', selectedIndex: -1, get options() { return this.children.filter(child => child.tag === 'option') }, addEventListener() {} })
  const renderer = createRenderer<ViewNode, ViewNode>({
    createElement: tag => node(tag), createText: text => ({ ...node(), text }), createComment: () => node(),
    setText: (item, text) => { item.text = text }, setElementText: (item, text) => { item.text = text; item.children = [] },
    patchProp: (item, key, _before, after) => { item.props[key] = after; if (key === 'value') item.value = after },
    insert(item, parent, anchor) {
      if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1)
      item.parent = parent
      const offset = anchor ? parent.children.indexOf(anchor) : -1
      if (offset < 0) parent.children.push(item); else parent.children.splice(offset, 0, item)
    },
    remove(item) { if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1); item.parent = null },
    parentNode: item => item.parent, nextSibling: item => item.parent?.children[item.parent.children.indexOf(item) + 1] ?? null,
  })
  const detail = ref<unknown>(), blocked = ref(false), loading = ref(false), refreshing = ref(false)
  let refreshCalls = 0
  const context = {
    recordPhysicalId: undefined, leaveError: '', selectedView: 'tapes', views: [{ id: 'tapes', label: '收藏音乐库' }],
    error: '', notice: '', pending: undefined, receiving: false, returnLocationStale: false, returnLocation: null,
    detail, blocked, loading, refreshing, saving: false, referenceCandidates: () => [], musicNavigation: 0,
    filterDraft: { query: '', brand: '', decade: '', stockState: '' }, brandSuggestions: [], hasFilter: false,
    catalog: undefined, tapeView: 'inventory', inventoryView: 'wall', reviewTotal: 0, referenceLoading: false, referenceError: '',
    spreadsheetOpen: false, referenceOpen: false, archiveImportOpen: false, progressOpen: false, receiveModel: undefined,
    inventory: { refresh: () => { refreshCalls++ } },
  }
  const root = node('root')
  // 自定义宿主保留真实模板与事件；不让编译器将静态HTML交给浏览器专用插入实现。
  const compiled = compileTemplate({ source: template, filename: 'CollectionView.vue', id: 'readonly-refresh-behavior', compilerOptions: { mode: 'function', hoistStatic: false, expressionPlugins: ['typescript'] } })
  assert.deepEqual(compiled.errors, [])
  const render = new Function('Vue', transpileModule(compiled.code, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText)(Vue)
  const app = renderer.createApp({ setup: () => context, render })
  for (const name of ['RecordingRecordsPanel', 'CollectionModelDetail', 'PhysicalMusicView', 'SpreadsheetImportPanel', 'ReferenceCatalogPanel', 'CassetteCatalogView', 'CassetteArchiveImportPanel', 'CollectionProgressPanel', 'CollectionReceiveDialog', 'CollectionPhoto', 'CollectionReferenceImage']) app.component(name, { render: () => null })
  app.config.warnHandler = () => undefined
  app.mount(root); t.after(() => app.unmount())
  const text = (item: ViewNode): string => item.text + item.children.map(text).join('')
  const all = (item: ViewNode): ViewNode[] => [item, ...item.children.flatMap(all)]
  const refreshButton = (): ViewNode => {
    const buttons = all(root).filter(item => item.tag === 'button' && ['刷新库存', '刷新中…'].includes(text(item).trim()))
    assert.equal(buttons.length, 1, '列表和详情均应存在唯一普通刷新按钮')
    return buttons[0]!
  }
  assert.equal(refreshButton().props.disabled, false)
  ;(refreshButton().props.onClick as () => void)(); assert.equal(refreshCalls, 1)
  detail.value = { model: { id: '测试型号' } }; await nextTick()
  assert.equal(refreshButton().props.disabled, false)
  ;(refreshButton().props.onClick as () => void)(); assert.equal(refreshCalls, 2)
  blocked.value = true; await nextTick(); assert.equal(refreshButton().props.disabled, true)
  blocked.value = false; refreshing.value = true; loading.value = true; await nextTick()
  assert.equal(text(refreshButton()), '刷新中…'); assert.equal(refreshButton().props.disabled, true)
})
