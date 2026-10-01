import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import ts from 'typescript'
import { createRoonArtworkCache, type RoonArtworkCache } from '../src/renderer/src/roon-artwork-cache.js'
import { readPublicIpcErrorCode } from '../src/renderer/src/roonLibraryMessages.js'
const require = createRequire(import.meta.url), vue = require('vue') as typeof import('vue')
interface Host { type: string; text: string; props: Record<string, any>; children: Host[]; parent: Host | null; getAttribute(name: string): string | null }
const node = (type = ''): Host => vue.markRaw({ type, text: '', props: {}, children: [], parent: null, getAttribute(name) { const value = this.props[name]; return typeof value === 'string' ? value : null } })
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
const reference = (id = 1) => `musicbridge-v2-image-123e4567-e89b-12d3-a456-${String(id).padStart(12, '0')}`
function cacheFixture() {
  let calls = 0, sequence = 0; const released: string[] = []
  const cache = createRoonArtworkCache({ getImage: async () => { throw Error('不使用真实API') } })
  cache.acquire = async (_request, _options) => {
    calls++; const url = `blob:mounted-${++sequence}`
    return { url, release() { released.push(url) }, invalidate() { released.push(`invalid:${url}`) } }
  }
  return { cache, calls: () => calls, released }
}
async function mounted(t: test.TestContext, name: 'SafeArtwork' | 'RoonArtwork', initial: Record<string, unknown>, cache?: RoonArtworkCache) {
  const { descriptor } = parse(await readFile(new URL(`../src/renderer/src/components/${name}.vue`, import.meta.url), 'utf8'))
  const script = compileScript(descriptor, { id: name }), template = compileTemplate({ id: name, filename: name + '.vue', source: descriptor.template!.content, compilerOptions: { bindingMetadata: script.bindings } })
  assert.deepEqual(template.errors, [])
  const module = { exports: {} as { default: import('vue').Component } }, render = { exports: {} as { render: (...args: any[]) => any } }
  const observers: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = []
  class Observer { constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) { observers.push(callback) } observe() {} disconnect() {} }
  const load = (id: string) => id === 'vue' ? vue : id.endsWith('roon-artwork-cache.js') ? { roonArtworkCache: cache } : { readPublicIpcErrorCode }
  const compile = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  new Function('require', 'module', 'exports', 'IntersectionObserver', compile(script.content))(load, module, module.exports, Observer)
  new Function('require', 'module', 'exports', compile(template.code))(load, render, render.exports)
  const remove = (child: Host) => { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = null }
  const renderer = vue.createRenderer<Host, Host>({ createElement: node, createText: text => ({ ...node('text'), text }), createComment: () => node('comment'), setText: (el, text) => { el.text = text }, setElementText: (el, text) => { el.text = text; el.children = [] }, patchProp: (el, key, _old, value) => { el.props[key] = value }, insert: (el, parent, anchor) => { remove(el); el.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(index < 0 ? parent.children.length : index, 0, el) }, remove, parentNode: el => el.parent, nextSibling: el => el.parent?.children[el.parent.children.indexOf(el) + 1] ?? null })
  const props = vue.reactive(initial), root = node('root'), component = { ...module.exports.default, render: render.exports.render }
  const app = renderer.createApp({ render: () => vue.h(component, props) }); app.mount(root)
  let closed = false
  const unmount = () => { if (!closed) { closed = true; app.unmount() } }; t.after(unmount)
  const all = (el: Host = root): Host[] => [el, ...el.children.flatMap(child => all(child))]
  const tick = async () => { await turn(); await vue.nextTick() }
  await tick()
  return { props, all, tick, observers, image: () => all().find(el => el.type === 'img'), button: () => all().find(el => el.type === 'button'), unmount }
}

test('007 Mounted：SafeArtwork旧DOM error不能隐藏新src，当前error仍fallback', async t => {
  const f = await mounted(t, 'SafeArtwork', { src: 'old.jpg' }), old = f.image()!
  f.props.src = 'new.jpg'; await f.tick(); const current = f.image()!; assert.notEqual(old, current)
  old.props.onError({ currentTarget: old }); await f.tick(); assert.equal(f.image()?.props.src, 'new.jpg')
  current.props.onError({ currentTarget: current }); await f.tick(); assert.equal(f.image(), undefined)
})

test('007 Mounted：RoonArtwork旧error不invalidate新lease，强clear同props立刻fallback', async t => {
  const h = cacheFixture(), f = await mounted(t, 'RoonArtwork', { reference: reference(), eager: true }, h.cache), old = f.image()!
  f.props.reference = reference(2); await f.tick(); const current = f.image()!
  old.props.onError({ currentTarget: old }); await f.tick(); assert.equal(f.image(), current); assert.ok(!h.released.some(url => url.startsWith('invalid:')))
  h.cache.clear(); await f.tick(); assert.equal(f.image(), undefined); assert.equal(h.calls(), 2)
})

test('007 Mounted：lazy只在可见时读，eager使用playing，卸载独立signal取消', async t => {
  const h = cacheFixture(); let priority: string | undefined, signal: AbortSignal | undefined
  const original = h.cache.acquire; h.cache.acquire = (request, options) => { priority = options?.priority; signal = options?.signal; return original(request, options) }
  const f = await mounted(t, 'RoonArtwork', { reference: reference() }, h.cache); assert.equal(h.calls(), 0)
  f.observers[0]!([{ isIntersecting: true }]); await f.tick(); assert.equal(h.calls(), 1); assert.equal(priority, 'visible')
  // 完成lease释放独立于未完成subscriber；新intent保持可取消。
  h.cache.acquire = (_request, options) => { priority = options?.priority; signal = options?.signal; return new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(Error('已取消')), { once: true })) }
  f.props.eager = true; f.props.reference = reference(2); await f.tick(); assert.equal(priority, 'playing'); f.unmount(); assert.equal(signal?.aborted, true)
})

test('007 Mounted：忙自动两次150/450重试后停止，显式按钮建立新意图恢复', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  const h = cacheFixture(); let attempts = 0, succeed = false; const original = h.cache.acquire
  h.cache.acquire = (request, options) => { attempts++; return succeed ? original(request, options) : Promise.reject(Object.assign(Error('繁忙'), { code: 'ARTWORK_BUSY' })) }
  const f = await mounted(t, 'RoonArtwork', { reference: reference(), eager: true }, h.cache); assert.equal(attempts, 1)
  t.mock.timers.tick(150); await f.tick(); assert.equal(attempts, 2)
  t.mock.timers.tick(450); await f.tick(); assert.equal(attempts, 3); assert.ok(f.button())
  t.mock.timers.tick(5000); await f.tick(); assert.equal(attempts, 3)
  succeed = true; f.button()!.props.onClick({ stopPropagation() {} }); await f.tick(); assert.ok(f.image()); assert.equal(attempts, 4)
})

test('007 Mounted：旧忙timer在换reference/强clear后零重放', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  const h = cacheFixture(); const calls: string[] = []
  h.cache.acquire = request => { calls.push(request.reference); return Promise.reject(Object.assign(Error('繁忙'), { code: 'ARTWORK_BUSY' })) }
  const f = await mounted(t, 'RoonArtwork', { reference: reference(), eager: true }, h.cache)
  f.props.reference = reference(2); await f.tick(); h.cache.clear(); await f.tick()
  t.mock.timers.tick(1000); await f.tick(); assert.deepEqual(calls, [reference(), reference(2)]); assert.equal(f.image(), undefined)
})

test('007 Mounted：externalRetry只emit同层动作，clear/新ref/卸载撤动作且旧闭包不重放', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  const h = cacheFixture(), actions: Array<(() => void) | undefined> = []; let attempts = 0, succeed = false; const original = h.cache.acquire
  h.cache.acquire = (request, options) => { attempts++; return succeed ? original(request, options) : Promise.reject(Object.assign(Error('临时失败'), { code: 'ARTWORK_BUSY' })) }
  const f = await mounted(t, 'RoonArtwork', { reference: reference(), eager: true, externalRetry: true, 'onRetry-action': (action: (() => void) | undefined) => actions.push(action) }, h.cache)
  t.mock.timers.tick(150); await f.tick(); t.mock.timers.tick(450); await f.tick()
  assert.equal(f.button(), undefined); const retry = actions.at(-1); assert.equal(typeof retry, 'function')
  succeed = true; retry!(); await f.tick(); assert.ok(f.image()); assert.equal(actions.at(-1), undefined)
  const accepted = attempts; h.cache.clear(); await f.tick(); retry!(); await f.tick(); assert.equal(attempts, accepted); assert.equal(actions.at(-1), undefined)
  f.unmount(); assert.equal(actions.at(-1), undefined)
})
