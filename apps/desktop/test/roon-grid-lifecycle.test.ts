import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url), vue = require('vue') as typeof import('vue')
const { useGridWindow } = require('../src/renderer/src/composables/useGridWindow.ts') as typeof import('../src/renderer/src/composables/useGridWindow.js')
const turn = async () => { await vue.nextTick(); await new Promise<void>(done => setImmediate(done)); await vue.nextTick() }
function mount(t: test.TestContext, setup: () => void) {
  type H = { parent: H | null; children: H[] }
  const renderer = vue.createRenderer<H, H>({ createElement: () => ({ parent: null, children: [] }), createText: () => ({ parent: null, children: [] }), createComment: () => ({ parent: null, children: [] }), setText() {}, setElementText() {}, patchProp() {}, insert(n, p) { n.parent = p; p.children.push(n) }, remove() {}, parentNode: n => n.parent, nextSibling: () => null })
  const app = renderer.createApp({ setup() { setup(); return () => null } }); app.mount({ parent: null, children: [] }); t.after(() => app.unmount())
}
function fakeGeometry(t: test.TestContext) {
  const old = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle')
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: () => ({ gridTemplateColumns: '288px 288px', columnGap: '24px', rowGap: '28px' }) })
  t.after(() => { if (old) Object.defineProperty(globalThis, 'getComputedStyle', old); else Reflect.deleteProperty(globalThis, 'getComputedStyle') })
  let scroll: (() => void) | undefined, detach = 0
  const port = { scrollTop: 0, clientTop: 0, clientHeight: 600, getBoundingClientRect: () => ({ top: 0 }), addEventListener(_kind: string, handler: () => void) { scroll = handler }, removeEventListener() { scroll = undefined; detach++ } }
  const element = { getBoundingClientRect: () => ({ width: 600, top: -port.scrollTop }), closest: () => port, querySelector: () => null, querySelectorAll: () => [], parentElement: null } as unknown as HTMLElement
  return { element, port, scroll: () => scroll?.(), detached: () => detach }
}
test('007 条件挂载/替换root自动测量并解除旧滚动监听', async t => {
  const fake = fakeGeometry(t); let root!: import('vue').Ref<HTMLElement | null>, grid!: ReturnType<typeof useGridWindow<{ id: number }>>
  mount(t, () => { root = vue.ref(null); grid = useGridWindow(vue.ref(Array.from({ length: 50 }, (_, id) => ({ id }))), root) })
  await turn(); root.value = fake.element; await turn(); assert.equal(grid.attrs.value['data-grid-columns'], 2)
  root.value = null; await turn(); assert.equal(fake.detached(), 1)
  root.value = fake.element; await turn(); assert.equal(grid.attrs.value['data-grid-columns'], 2)
})
test('007 稳定CSS滚动只查窗口，不重建5000条目profile/prefix', async t => {
  const fake = fakeGeometry(t); let calls = 0, grid!: ReturnType<typeof useGridWindow<{ id: number }>>
  mount(t, () => { grid = useGridWindow(vue.ref(Array.from({ length: 5000 }, (_, id) => ({ id }))), vue.ref(fake.element), { profile: () => { calls++; return 'plain' } }) })
  await turn(); void grid.rendered.value; calls = 0
  for (let i = 1; i <= 20; i++) { fake.port.scrollTop = i * 200; fake.scroll(); await turn(); void grid.rendered.value; assert.ok(grid.rendered.value.length <= 32) }
  assert.equal(calls, 0, '滚动位置不应使数据集profile扫描或row prefix重建')
})

test('007 retry callback跟随窗口完整key，离窗旧撤销不可清新实例', async t => {
  const { useGridArtworkRetry } = require('../src/renderer/src/composables/useGridArtworkRetry.ts') as typeof import('../src/renderer/src/composables/useGridArtworkRetry.js')
  let entries!: import('vue').Ref<{ id: string }[]>, scope!: import('vue').Ref<string>, retry!: ReturnType<typeof useGridArtworkRetry<{ id: string }>>
  mount(t, () => { entries = vue.ref([{ id: 'same' }]); scope = vue.ref('a'); retry = useGridArtworkRetry(entries, item => `${scope.value}:${item.id}`) })
  const item = { id: 'same' }; const old = retry.handler(item); let calls = 0; old(() => { calls++ }); assert.equal(retry.available(item), true)
  scope.value = 'b'; assert.equal(retry.available(item), false); const current = retry.handler(item); current(() => { calls++ }); old(undefined); assert.equal(retry.available(item), true)
  retry.run(item, { preventDefault() {}, stopPropagation() {} } as MouseEvent); assert.equal(calls, 1)
  entries.value = []; old(() => { calls++ }); current(() => { calls++ }); assert.equal(retry.available(item), false)
})
