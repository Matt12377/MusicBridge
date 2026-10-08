import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import ts from 'typescript'
import * as relocationPlans from '../../src/renderer/src/composables/application/useLocalRelocationPlans.js'
export const relocationComposables = relocationPlans
const require = createRequire(import.meta.url), vue = require('vue') as typeof import('vue')
interface Host {
  type: string; tagName: string; text: string; props: Record<string, any>; children: Host[]; parent: Host | null; value: any; checked: boolean; selected: boolean; listeners: Record<string, (event: any) => void>; style: Record<string, string>; scrollTop: number; clientHeight: number; hidden: boolean; modalCount: number; closeCount: number;
  focus(options?: FocusOptions): void; closest(selector: string): Host | null; querySelector(selector: string): Host | null; querySelectorAll(selector: string): Host[]; getClientRects(): object[]; getRootNode(): object; showModal(): void; close(): void; addEventListener(name: string, fn: (event: any) => void): void; removeEventListener(name: string): void;
}
/** 013目录设置专用DOM宿主：转译SFC的require接真实ESM命名空间，不替换函数、模板或API。 */
export async function mountedRelocationSettings(t: test.TestContext, file: string, initial: Record<string, unknown>, api: any = {}, slots?: Record<string, (...args: any[]) => any>) {
  assert.equal(path.basename(file), 'LocalLibrarySettings.vue', '此宿主只处理013目录设置组件')
  class HTMLElement {}
  class Document {}
  class ShadowRoot {}
  const previousDocument = globalThis.document, previousHTMLElement = globalThis.HTMLElement, previousDocumentType = globalThis.Document, previousShadowRoot = globalThis.ShadowRoot
  const timers = new Map<number, () => void>(); let timerId = 0
  const document = Object.assign(new Document(), { activeElement: null as Host | null, addEventListener() {}, removeEventListener() {}, querySelector: (selector: string) => all().find(el => selector.startsWith('#') ? el.props.id === selector.slice(1) : String(el.props.class).split(' ').includes(selector.slice(1))) ?? null })
  Object.assign(globalThis, { document, HTMLElement, Document, ShadowRoot })
  let restored = false
  const restoreGlobals = () => { if (restored) return; restored = true; for (const [key, value] of Object.entries({ document: previousDocument, HTMLElement: previousHTMLElement, Document: previousDocumentType, ShadowRoot: previousShadowRoot })) { if (value) Object.assign(globalThis, { [key]: value }); else delete (globalThis as any)[key] } }
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
      if (filename === file && name === '../../composables/application/useLocalRelocationPlans.js') return relocationComposables
      if (name.endsWith('.vue')) return { __esModule: true, default: load(path.resolve(path.dirname(filename), name)) }
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
  const props = vue.reactive(initial), host = node('root'), app = renderer.createApp({ render: () => vue.h(load(file), props, slots) }); let stopped = false, mountSucceeded = false
  const unmount = () => { if (!stopped) { stopped = true; if (mountSucceeded) app.unmount() } }
  t.after(async () => { try { unmount(); await new Promise<void>(resolve => setImmediate(resolve)); await vue.nextTick() } finally { timers.clear(); restoreGlobals() } })
  try { app.mount(host); mountSucceeded = true } catch (cause) { unmount(); timers.clear(); restoreGlobals(); throw cause }
  const all = (el: Host = host): Host[] => [el, ...el.children.flatMap(child => all(child))], text = (el: Host = host): string => el.text + el.children.map(child => text(child)).join('')
  const settle = async () => { for (let n = 0; n < 4; n++) { await new Promise<void>(resolve => setImmediate(resolve)); await vue.nextTick() } }
  const event = (el: Host, key = '', shiftKey = false) => ({ target: el, currentTarget: el, key, shiftKey, prevented: false, stopped: false, preventDefault() { this.prevented = true }, stopPropagation() { this.stopped = true } })
  const dispatch = (value: any, event: any) => { if (Array.isArray(value)) value.forEach(fn => fn(event)); else value?.(event) }
  const click = async (el: Host | undefined) => { assert.ok(el, '缺少点击目标'); assert.ok(!el.props.disabled, '不能点击禁用入口'); el.focus(); dispatch(el.props.onClick, event(el)); await settle() }
  const input = async (el: Host | undefined, value: string) => { assert.ok(el, '缺少输入目标'); el.value = value; dispatch(el.listeners.input, event(el)); dispatch(el.props.onInput, event(el)); await settle() }
  const change = async (el: Host | undefined, value: string) => { assert.ok(el, '缺少选择目标'); el.value = value; el.children.filter(child => child.type === 'option').forEach(option => { option.selected = option.props.value === value }); dispatch(el.listeners.change, event(el)); dispatch(el.props.onChange, event(el)); await settle() }
  await settle(); return { all, text, event, click, input, change, settle, unmount, active: () => document.activeElement, node, host }
}
