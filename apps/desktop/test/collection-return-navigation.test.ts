import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const modelId = '11111111-1111-4111-8111-111111111111'
const otherModelId = '22222222-2222-4222-8222-222222222222'
const physicalId = 'MB-C-00012'
const location = { physicalId, modelId, returnOffset: 20 }

async function mounted(t: test.TestContext) {
  const { parse, compileScript } = await import('@vue/compiler-sfc')
  const ts = (await import('typescript')).default
  const require = createRequire(import.meta.url)
  const vue = require('vue') as typeof import('vue')
  const source = await readFile(new URL('../src/renderer/src/components/collection/CollectionView.vue', import.meta.url), 'utf8')
  const { descriptor, errors } = parse(source)
  assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: 'collection-return-navigation' })
  const detail = vue.shallowRef<unknown>()
  const notice = vue.ref(''), error = vue.ref('')
  let finishRead: ((value: unknown) => void) | undefined
  let finishCopy: ((value: unknown) => void) | undefined
  let openCalls = 0
  const inventory = {
    catalog: vue.shallowRef(), detail, filter: vue.ref({}), loading: vue.ref(false), saving: vue.ref(false),
    error, notice, pending: vue.shallowRef(), blocked: vue.computed(() => false),
    load: async () => {}, closeModel: () => {}, retry: async () => false, mutate: async () => false,
    addPhoto: async () => {},
    openModel: (_id: string, _offset = 0) => new Promise<void>(resolve => { openCalls++; finishRead = value => { detail.value = value; resolve() } }),
  }
  const listeners = new Map<string, () => void>()
  let focused = 0
  const document = {
    addEventListener(name: string, listener: () => void) { listeners.set(name, listener) },
    removeEventListener(name: string) { listeners.delete(name) },
    querySelector() { return { focus() { focused++ } } },
  }
  const window = { musicBridge: { getCollectionCopy: () => new Promise(resolve => { finishCopy = resolve }) } }
  const stubs: Record<string, unknown> = {
    './collection-display': { collectionModelLabel: () => '' },
    './reference-images': { loadPublishedCassetteCatalog: async () => [], referenceImagesForModel: () => [] },
    '../../composables/useCollection': { useCollection: () => inventory },
  }
  const load = (name: string) => name === 'vue' ? vue : stubs[name] ?? (name.endsWith('.vue') ? { default: { render: () => null } } : require(name))
  const module = { exports: {} as { default: import('vue').Component } }
  const code = ts.transpileModule(script.content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  new Function('require', 'module', 'exports', 'window', 'document', code)(load, module, module.exports, window, document)
  type Node = { text: string; children: Node[]; parent: Node | null }
  const node = (): Node => ({ text: '', children: [], parent: null })
  const renderer = vue.createRenderer<Node, Node>({ createElement: node, createText: text => ({ ...node(), text }), createComment: node,
    setText(item, text) { item.text = text }, setElementText(item, text) { item.text = text }, patchProp() {},
    insert(child, parent) { child.parent = parent; parent.children.push(child) }, remove(child) { child.parent?.children.splice(child.parent.children.indexOf(child), 1); child.parent = null },
    parentNode: item => item.parent, nextSibling: () => null })
  const app = renderer.createApp({ ...module.exports.default, render: () => null }, { modelValue: 'tapes', returnLocation: location })
  const instance = app.mount(node())
  t.after(() => app.unmount())
  const resolve = (model = modelId, offset = 20, ids: string[] = [physicalId]) => {
    assert.ok(finishRead, '挂载后应请求当前型号与分页')
    finishRead({ model: { id: model }, copies: { offset, items: ids.map(id => ({ physicalId: id })) } })
  }
  const settle = async () => { await new Promise<void>(done => setImmediate(done)); await vue.nextTick() }
  return { resolve, settle, listeners, focused: () => focused, notice, openCalls: () => openCalls,
    setup: (instance.$ as unknown as { setupState: Record<string, unknown> }).setupState,
    resolveCopy: (value: unknown) => { assert.ok(finishCopy); finishCopy(value) } }
}

test('返回单盘异步读取期间用户移焦，不再把焦点抢回旧实体', async t => {
  const view = await mounted(t)
  view.listeners.get('pointerdown')?.()
  view.resolve()
  await view.settle()
  assert.equal(view.focused(), 0)
})

test('只有同型号同分页且单盘仍存在才恢复焦点', async t => {
  const view = await mounted(t)
  view.resolve()
  await view.settle()
  assert.equal(view.focused(), 1)
})

test('分页或型号发生变化时不聚焦，也不误称已找到单盘', async t => {
  const view = await mounted(t)
  view.resolve(otherModelId, 20)
  await view.settle()
  assert.equal(view.focused(), 0)
  assert.equal(view.notice.value, '')
})

test('手动重新定位等待时用户切换焦点，迟到副本位置不能重新打开旧型号', async t => {
  const view = await mounted(t)
  view.resolve(modelId, 20, [])
  await view.settle()
  const pending = (view.setup.relocatePhysical as () => Promise<void>)()
  view.listeners.get('pointerdown')?.()
  view.resolveCopy({ modelId, copy: { physicalId }, copyIndex: 40 })
  await pending
  await view.settle()
  assert.equal(view.openCalls(), 1)
  assert.equal(view.focused(), 0)
})

test('收藏页录音档案未收口时不切换视图、不关闭档案，收口后恢复入口', async t => {
  const view = await mounted(t)
  view.resolve()
  await view.settle()
  view.setup.recordPhysicalId = physicalId
  view.setup.recordsPanel = { canLeave: () => false, leaveBlockReason: () => '历史音频设备输出尚未收口。' }
  assert.equal((view.setup.canLeave as () => boolean)(), false)
  ;(view.setup.showRecording as (id: string) => void)(physicalId)
  ;(view.setup.closeRecords as () => void)()
  assert.equal(view.setup.musicNavigation, 0)
  assert.equal(view.setup.recordPhysicalId, physicalId)
  assert.match(String(view.setup.leaveError), /设备输出尚未收口/u)
  view.setup.recordsPanel = { canLeave: () => true, leaveBlockReason: () => null }
  ;(view.setup.closeRecords as () => void)()
  assert.equal(view.setup.recordPhysicalId, '')
  assert.equal((view.setup.canLeave as () => boolean)(), true)
})
