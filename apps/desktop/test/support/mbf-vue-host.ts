import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { TestContext } from 'node:test'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import * as publicContracts from '@music-bridge/contracts'
import * as workbenchController from '../../src/renderer/src/composables/application/local-library-workbench/controller.js'
import * as localAlbumPresentation from '../../src/renderer/src/components/library/local-browser/presentation.js'
import * as localRelocationPlans from '../../src/renderer/src/composables/application/useLocalRelocationPlans.js'
import { calculateVirtualWindow } from '../../src/renderer/src/composables/virtualWindow.js'

/** 实际 SFC + Vue renderer 的行为宿主；不代替浏览器几何、native 解码或真实 IPC。 */
export interface VueHostNode {
  type: string
  tagName: string
  text: string
  props: Record<string, any>
  children: VueHostNode[]
  parent: VueHostNode | null
  value: any
  checked: boolean
  selected: boolean
  readonly options: VueHostNode[]
  selectedIndex: number
  readonly multiple: boolean
  style: Record<string, any>
  scrollTop: number
  clientHeight: number
  getRootNode(): { activeElement: VueHostNode | null }
  getAttribute(name: string): string | null
  matches(selector: string): boolean
  closest(selector: string): VueHostNode | null
  querySelector(selector: string): VueHostNode | null
  querySelectorAll(selector: string): VueHostNode[]
  showModal(): void
  show(): void
  close(): void
  getBoundingClientRect(): DOMRect
  focus(options?: FocusOptions): void
  addEventListener(name: string, fn: (event: any) => void): void
  removeEventListener(name: string): void
  listeners: Record<string, (event: any) => void>
}
interface MountOptions { slots?(vue: typeof import('vue')): Record<string, (...args: any[]) => import('vue').VNodeChild> }

export async function mountVueSfc(t: TestContext, file: string, initial: Record<string, unknown>, options: MountOptions = {}) {
  const require = createRequire(import.meta.url), vue = require('vue') as typeof import('vue')
  class HostDocument { activeElement: VueHostNode | null = null; addEventListener() {} removeEventListener() {} }
  const document = new HostDocument(), previousDocumentConstructor = globalThis.Document
  Object.assign(globalThis, { Document: HostDocument })
  t.after(() => { if (previousDocumentConstructor) Object.assign(globalThis, { Document: previousDocumentConstructor }); else delete (globalThis as any).Document })
  const previousElement = globalThis.HTMLElement
  class HostElement { static [Symbol.hasInstance](value: unknown) { return !!value && typeof value === 'object' && 'tagName' in value } }
  if (!previousElement) Object.assign(globalThis, { HTMLElement: HostElement })
  t.after(() => { if (previousElement) Object.assign(globalThis, { HTMLElement: previousElement }); else delete (globalThis as any).HTMLElement })
  const previousDocument = globalThis.document
  Object.assign(globalThis, { document })
  t.after(() => { if (previousDocument) Object.assign(globalThis, { document: previousDocument }); else delete (globalThis as any).document })
  const descendants = (element: VueHostNode): VueHostNode[] => [element, ...element.children.flatMap(descendants)]
  const node = (type = ''): VueHostNode => {
    const element: VueHostNode = {
      type, tagName: type.toUpperCase(), text: '', props: {}, children: [], parent: null, value: '', checked: false, selected: false,
      get options() { return element.querySelectorAll('option') },
      get multiple() { return element.props.multiple === true || element.props.multiple === '' },
      get selectedIndex() { return element.options.findIndex(option => option.selected) },
      set selectedIndex(value: number) { element.options.forEach((option, index) => { option.selected = index === value }); element.value = element.options[value]?.value ?? '' },
      style: {}, scrollTop: 0, clientHeight: 620, listeners: {},
      getAttribute(name) { return element.props[name] == null ? null : String(element.props[name]) },
      matches(selector) {
        if (selector.includes(',')) return selector.split(',').some(part => element.matches(part.trim()))
        if (selector.startsWith('.')) return String(element.props.class).split(' ').includes(selector.slice(1))
        if (selector.startsWith('#')) return element.props.id === selector.slice(1)
        const attribute = /^\[([^=\]]+)(?:="([^"]*)")?\]$/u.exec(selector)
        if (attribute) return attribute[2] === undefined ? element.props[attribute[1]!] !== undefined : String(element.props[attribute[1]!]) === attribute[2]
        return element.type === selector
      },
      closest(selector) { let current: VueHostNode | null = element; while (current) { if (current.matches(selector)) return current; current = current.parent } return null },
      querySelector(selector) { return descendants(element).find(child => child !== element && child.matches(selector)) ?? null },
      querySelectorAll(selector) { return descendants(element).filter(child => child !== element && child.matches(selector)) },
      showModal() { element.props.open = true }, show() { element.props.open = true }, close() { element.props.open = false },
      getBoundingClientRect() { return { x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 620, width: 1200, height: 620, toJSON() { return {} } } as DOMRect },
      getRootNode() { return document },
      focus() { document.activeElement = element }, addEventListener(name, fn) { element.listeners[name] = fn }, removeEventListener(name) { delete element.listeners[name] },
    }
    return element
  }
  const modules = new Map<string, import('vue').Component>()
  const load = (sourceFile: string): import('vue').Component => {
    const cached = modules.get(sourceFile); if (cached) return cached
    const { descriptor } = parse(readFileSync(sourceFile, 'utf8')), script = compileScript(descriptor, { id: sourceFile })
    const template = compileTemplate({ id: sourceFile, filename: sourceFile, source: descriptor.template!.content, compilerOptions: { bindingMetadata: script.bindings } })
    assert.deepEqual(template.errors, [])
    const localRequire = createRequire(sourceFile), module = { exports: {} as { default: import('vue').Component } }, rendering = { exports: {} as { render: (...args: any[]) => any } }
    const imports = (name: string) => {
      if (name === 'vue') return vue
      // 合同包只公开ESM入口，使用真实命名空间，不经CJS解析也不改公开exports。
      if (name === '@music-bridge/contracts') return publicContracts
      if (name.endsWith('RoonArtwork.vue')) return { default: { render: () => vue.h('span') } }
      if (name.endsWith('.vue')) return { default: load(path.resolve(path.dirname(sourceFile), name)) }
      if (name.endsWith('/virtualWindow.js')) return { calculateVirtualWindow }
      if (name.startsWith('.') && name.endsWith('.js')) {
        const source = path.resolve(path.dirname(sourceFile), name.slice(0, -3) + '.ts')
        // 这两个真实模块也依赖ESM合同；保持与行为用例相同的原模块实例。
        const hostDirectory = path.dirname(fileURLToPath(import.meta.url))
        if (source === path.resolve(hostDirectory, '../../src/renderer/src/composables/application/local-library-workbench/controller.ts')) return workbenchController
        if (source === path.resolve(hostDirectory, '../../src/renderer/src/components/library/local-browser/presentation.ts')) return localAlbumPresentation
        if (source === path.resolve(hostDirectory, '../../src/renderer/src/composables/application/useLocalRelocationPlans.ts')) return localRelocationPlans
        if (existsSync(source)) return localRequire(source)
      }
      return localRequire(name)
    }
    const compile = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    const window = { innerWidth: 1200, innerHeight: 900, addEventListener() {}, removeEventListener() {} }
    new Function('require', 'module', 'exports', 'document', 'window', compile(script.content))(imports, module, module.exports, document, window)
    new Function('require', 'module', 'exports', compile(template.code))(imports, rendering, rendering.exports)
    const component = { ...module.exports.default, render: rendering.exports.render }; modules.set(sourceFile, component); return component
  }
  const remove = (element: VueHostNode) => { if (element.parent) element.parent.children.splice(element.parent.children.indexOf(element), 1); element.parent = null }
  const renderer = vue.createRenderer<VueHostNode, VueHostNode>({
    createElement: node, createText: text => ({ ...node('text'), text }), createComment: () => node('comment'),
    setText: (element, text) => { element.text = text }, setElementText: (element, text) => { element.text = text; element.children = [] },
    patchProp: (element, key, _old, value) => { element.props[key] = value; if (key === 'style' && value) Object.assign(element.style, value); if (key === 'value') element.value = value; if (key === 'checked') element.checked = value },
    insert: (element, parent, anchor) => { remove(element); element.parent = parent; const at = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(at < 0 ? parent.children.length : at, 0, element) },
    remove, parentNode: element => element.parent, nextSibling: element => element.parent?.children[element.parent.children.indexOf(element) + 1] ?? null,
  })
  const props = vue.shallowReactive(initial), host = node('root'), slots = options.slots?.(vue), component = load(file)
  const app = renderer.createApp({ render: () => vue.h(component, props, slots) })
  app.mount(host); t.after(() => app.unmount())
  const text = (element: VueHostNode = host): string => element.text + element.children.map(child => text(child)).join('')
  const settle = async () => { for (let at = 0; at < 3; at++) { await vue.nextTick(); await new Promise<void>(resolve => setImmediate(resolve)) } }
  const event = (element: VueHostNode, extra: Record<string, unknown> = {}) => ({ target: element, currentTarget: element, clientX: 200, clientY: 100, key: '', preventDefault() {}, stopPropagation() {}, ...extra })
  const dispatch = async (element: VueHostNode | undefined, name: string, extra: Record<string, unknown> = {}) => {
    assert.ok(element, '缺少行为目标')
    const handlers = Array.isArray(element.props[name]) ? element.props[name] : [element.props[name]]
    assert.ok(handlers.some(handler => typeof handler === 'function'), `缺少正式处理器 ${name}`)
    for (const handler of handlers) handler?.(event(element, extra))
    await settle()
  }
  await settle()
  return { props, vue, host, text, settle, event, dispatch, all: (element: VueHostNode = host) => descendants(element) }
}
