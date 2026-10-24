import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import ts from 'typescript'
import * as vue from 'vue'
import * as navigation from '../src/renderer/src/composables/useSettingsNavigation.js'
import * as zoneLifecycle from '../src/renderer/src/zone-lifecycle.js'

interface Host {
  type: string; text: string; props: Record<string, any>; children: Host[]; parent: Host | null; open: boolean
  focus(): void; querySelector(selector: string): Host | null
}
const componentRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../src/renderer/src/components')
const categories = ['application', 'library', 'playback', 'roon', 'account', 'advanced'] as const
const labels = ['通用', '音乐库', '播放', '设备与连接', '账户', '高级']
const transpile = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText

// 只挂载正式设置壳及原App设置节点；子模块保留事件表面，不连接Owner、账号或真实音乐库。
async function mountSettings(t: test.TestContext, appAncestor = false, options: { sourceWritesAvailable?: boolean; workspaceAvailable?: boolean } = {}) {
  let focused: Host | null = null
  const mounts = new Map<string, number>(), updated: string[] = [], organized: unknown[] = [], outboxOpen = vue.ref(false)
  const all = (node: Host): Host[] => [node, ...node.children.flatMap(all)]
  const text = (node: Host): string => node.text + node.children.map(text).join('')
  const matches = (node: Host, selector: string): boolean => {
    if (selector.startsWith('#')) return node.props.id === selector.slice(1)
    const attributes = [...selector.matchAll(/\[([\w-]+)="([^"]*)"\]/gu)]
    return attributes.length > 0 ? attributes.every(match => String(node.props[match[1]!]) === match[2]) : node.type === selector
  }
  const node = (type: string, value = ''): Host => {
    const element: Host = { type, text: value, props: {}, children: [], parent: null, open: false,
      focus() { focused = element }, querySelector: selector => all(element).find(candidate => candidate !== element && matches(candidate, selector)) ?? null }
    return element
  }
  const remove = (element: Host) => {
    if (element.parent) element.parent.children.splice(element.parent.children.indexOf(element), 1)
    element.parent = null
  }
  const renderer = vue.createRenderer<Host, Host>({
    createElement: type => node(type), createText: value => node('text', value), createComment: () => node('comment'),
    setText: (element, value) => { element.text = value }, setElementText: (element, value) => { element.text = value; element.children = [] },
    patchProp: (element, key, _previous, value) => { element.props[key] = value; if (key === 'open') element.open = !!value },
    insert(element, parent, anchor) { remove(element); element.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(index < 0 ? parent.children.length : index, 0, element) },
    remove, parentNode: element => element.parent, nextSibling: element => element.parent?.children[element.parent.children.indexOf(element) + 1] ?? null,
  })
  const modules = new Map<string, { __esModule: true; default: vue.Component }>()
  const surface = (name: string) => {
    let module = modules.get(name)
    if (!module) {
      module = { __esModule: true, default: vue.defineComponent({ inheritAttrs: false, emits: ['updated', 'organize'], setup(_props, { emit }) {
        vue.onMounted(() => mounts.set(name, (mounts.get(name) ?? 0) + 1))
        return () => vue.h('section', { 'data-settings-module': name }, name === 'LocalLibrarySettings' ? [
          vue.h('button', { type: 'button', 'data-settings-action': 'updated', onClick: () => emit('updated') }, '合成目录变化'),
          vue.h('button', { type: 'button', 'data-settings-action': 'organize', onClick: () => emit('organize') }, '合成整理入口'),
        ] : name)
      } }) }
      modules.set(name, module)
    }
    return module
  }
  const file = path.join(componentRoot, 'settings/SettingsView.vue'), { descriptor } = parse(readFileSync(file, 'utf8'))
  const script = compileScript(descriptor, { id: 'settings-architecture' })
  // 合成Host不解析静态HTML字符串；保留完整模板，以普通VNode呈现相同节点和分支。
  const template = compileTemplate({ id: 'settings-architecture', filename: file, source: descriptor.template!.content, compilerOptions: { bindingMetadata: script.bindings, hoistStatic: false } })
  assert.deepEqual(template.errors, [])
  const imports = (name: string): unknown => {
    if (name === 'vue') return vue
    if (name.endsWith('/useSettingsNavigation.js')) return navigation
    if (name.endsWith('/zone-lifecycle.js')) return zoneLifecycle
    if (name.endsWith('.vue')) return surface(path.basename(name, '.vue'))
    throw new Error(`设置壳出现未隔离的依赖：${name}`)
  }
  const module = { exports: {} as { default: vue.Component } }, rendering = { exports: {} as { render: (...args: any[]) => any } }
  new Function('require', 'module', 'exports', 'window', transpile(script.content))(imports, module, module.exports, { musicBridge: options.sourceWritesAvailable === false ? {} : { getLocalSourceWrites() {} } })
  new Function('require', 'module', 'exports', transpile(template.code))(imports, rendering, rendering.exports)
  const component = { ...module.exports.default, render: rendering.exports.render }
  const appInfo = { version: '合成设置测试', buildMode: 'production', platform: 'darwin' }
  const workspace = options.workspaceAvailable === false ? undefined : { state: vue.ref({ libraries: [] }),
    originalNameSave: vue.ref<unknown | null>(null), nameDirty: vue.ref(false), error: vue.ref('') }
  const props = { appInfo, ...(workspace ? { workbenchLibrary: workspace } : {}), authState: { status: 'idle' }, accountState: { status: 'missing' }, zones: [],
    roonStatus: 'disconnected', zoneStatus: 'empty', selectedQuality: 'lossless', authError: false, accountError: null, remoteCoreState: { status: 'idle' }, remoteAutoStart: false, remoteSshTarget: '' }
  let root: vue.Component = vue.defineComponent({ setup: () => () => vue.h(component, props) })
  if (appAncestor) {
    const app = parse(readFileSync(path.join(componentRoot, '../App.vue'), 'utf8')).descriptor, settings: any[] = []
    const visit = (item: any): void => { if (item?.type === 1 && item.tag === 'SettingsView') settings.push(item); for (const child of item?.children ?? []) visit(child) }
    visit(app.template?.ast); assert.equal(settings.length, 1)
    const parentTemplate = compileTemplate({ id: 'settings-architecture-app', filename: 'App.vue', source: `<template v-if="false"></template>${settings[0].loc.source}`, compilerOptions: { expressionPlugins: ['typescript'], hoistStatic: false } })
    assert.deepEqual(parentTemplate.errors, [])
    const parentRendering = { exports: {} as { render: (...args: any[]) => any } }
    new Function('require', 'module', 'exports', transpile(parentTemplate.code))(imports, parentRendering, parentRendering.exports)
    const unexpected = () => assert.fail('设置事件祖链不应触发账户、播放或连接操作')
    const environment = { currentView: 'settings', ...props, localLibrary: { relocationPlans: undefined }, coreState: null, zoneLifecycleStatus: 'empty',
      refreshLocalBrowserViews: () => updated.push('refresh'), openAlbumWorkbench: (request: unknown) => organized.push(request),
      commandOutboxTrigger: vue.ref(null), commandOutboxOpen: outboxOpen, navigate: unexpected,
      ...Object.fromEntries(['beginQrLogin', 'cancelQrLogin', 'logout', 'refreshAccountProfile', 'setSelectedQuality', 'selectZone', 'loadZones', 'startRemoteCore', 'stopRemoteCore', 'reconnectRemoteCore', 'updateRemoteAutoStart', 'updateRemoteSshTarget'].map(name => [name, unexpected])) }
    root = vue.defineComponent({ components: { SettingsView: component }, setup: () => environment, render: parentRendering.exports.render })
  }
  const host = node('root'), app = renderer.createApp(root), errors: unknown[] = []
  app.config.errorHandler = error => { errors.push(error) }
  app.mount(host); t.after(() => app.unmount())
  const settle = async () => { for (let index = 0; index < 4; index++) { await new Promise<void>(resolve => setImmediate(resolve)); await vue.nextTick(); if (errors.length) throw errors.shift() } }
  const find = (predicate: (element: Host) => boolean) => all(host).find(predicate)
  const tab = (category: string) => { const found = find(element => element.props.role === 'tab' && element.props['data-settings-category'] === category); assert.ok(found); return found }
  const click = async (element: Host | undefined) => { assert.ok(element); element.props.onClick?.({ target: element, currentTarget: element }); await settle() }
  const select = (category: string) => click(tab(category))
  const toggle = async (title: string, open: boolean) => {
    const details = find(element => element.type === 'details' && element.children.some(child => child.type === 'summary' && text(child).includes(title)))
    assert.ok(details); details.open = open; details.props.onToggle({ currentTarget: details }); await settle(); return details
  }
  const press = async (key: string) => {
    const tabs = find(element => element.props.role === 'tablist'); assert.ok(tabs); let prevented = false
    tabs.props.onKeydown({ key, currentTarget: tabs, target: focused, preventDefault() { prevented = true } }); await settle(); return prevented
  }
  await settle()
  const connected = (element: Host | null): boolean => { while (element && element !== host) element = element.parent; return element === host }
  const summary = (title: string) => { const found = find(element => element.type === 'summary' && text(element).includes(title)); assert.ok(found); return found }
  return { all: () => all(host), text: (element: Host = host) => text(element), find, tab, click, select, toggle, press, settle, mounts, updated, organized, outboxOpen, workspace, summary, connected,
    active: () => focused, modules: () => all(host).filter(element => element.props['data-settings-module']).map(element => element.props['data-settings-module']).filter(name => name !== 'SidebarIcon') }
}

test('设置任务分区：首次通用不挂载音乐库；六类只呈现自己的控件', async t => {
  const f = await mountSettings(t)
  assert.deepEqual(f.all().filter(element => element.props.role === 'tab').map(element => element.props['data-settings-category']), categories)
  labels.forEach((label, index) => assert.ok(f.text(f.tab(categories[index]!)).includes(label) && f.tab(categories[index]!).props['aria-controls'] === `settings-pane-${categories[index]}`))
  assert.equal(f.tab('application').props['aria-selected'], true)
  assert.deepEqual(f.modules(), ['AppearanceSettings']); assert.equal(f.mounts.has('LocalLibrarySettings'), false)
  for (const [category, modules] of [['library', ['LocalLibrarySettings']], ['playback', ['RoonDisplaySettings']], ['roon', ['MobileConnectionSettings']], ['account', []], ['advanced', []]] as const) {
    await f.select(category)
    const panels = f.all().filter(element => element.props.role === 'tabpanel')
    assert.equal(panels.length, 1); assert.equal(panels[0]!.props.id, `settings-pane-${category}`)
    assert.equal(panels[0]!.props['aria-labelledby'], f.tab(category).props.id)
    assert.deepEqual(f.modules(), modules)
  }
})

test('设置垂直键盘将真实焦点交给新active tab，并始终只有一个Tab入口', async t => {
  const f = await mountSettings(t)
  const tabs = f.find(element => element.props.role === 'tablist'); assert.equal(tabs?.props['aria-orientation'], 'vertical')
  f.tab('application').focus()
  for (const [key, category] of [['ArrowDown', 'library'], ['ArrowRight', 'playback'], ['ArrowUp', 'library'], ['ArrowLeft', 'application'], ['ArrowUp', 'advanced'], ['ArrowDown', 'application'], ['End', 'advanced'], ['Home', 'application']] as const) {
    assert.equal(await f.press(key), true)
    const active = f.active(), selected = f.tab(category)
    assert.equal(active?.props.id, selected.props.id); assert.equal(f.connected(active), true)
    assert.strictEqual(active === selected, true, '焦点必须落到当前挂载的选中标签实例')
    assert.equal(selected.props['aria-selected'], true)
    assert.deepEqual(f.all().filter(element => element.props.role === 'tab' && element.props.tabindex === 0).map(element => element.props.id), [selected.props.id])
  }
  assert.equal(await f.press('PageDown'), false); assert.strictEqual(f.active() === f.tab('application'), true)
})

test('设置高级项按展开状态挂载，关闭后停止模块，回入保留展开状态', async t => {
  const f = await mountSettings(t); await f.select('advanced')
  assert.deepEqual(f.modules(), []); assert.equal(f.find(element => element.props.id === 'remote-ssh-target') === undefined, true)
  for (const [title, name] of [['智能整理服务', 'LocalAiSettings'], ['音乐文件写入', 'LocalSourceWritesSettings'], ['实物收藏查询', 'CollectionReadonlySettings']] as const) {
    const details = await f.toggle(title, true)
    assert.equal(details.props.open, true); assert.ok(f.modules().includes(name)); assert.equal(f.mounts.get(name), 1)
    await f.toggle(title, false); assert.equal(details.props.open, false); assert.equal(f.modules().includes(name), false)
  }
  const remote = await f.toggle('远程 Core', true)
  assert.ok(f.find(element => element.props.id === 'remote-ssh-target'))
  await f.select('application'); await f.select('advanced')
  const restored = f.find(element => element.type === 'details' && element.props.open === true)
  assert.ok(restored); assert.strictEqual(restored === remote, false); assert.ok(f.find(element => element.props.id === 'remote-ssh-target'))
  await f.toggle('远程 Core', false); assert.equal(f.find(element => element.props.id === 'remote-ssh-target') === undefined, true)
})

test('原App设置祖链保留updated和organize任务，并将操作记录slot放在高级', async t => {
  const f = await mountSettings(t, true)
  assert.equal(f.find(element => element.props['data-settings-action'] === 'updated') === undefined, true)
  assert.equal(f.find(element => element.props.class === 'command-outbox-entry') === undefined, true)
  await f.select('library')
  await f.click(f.find(element => element.props['data-settings-action'] === 'updated'))
  assert.deepEqual(f.updated, ['refresh']); assert.deepEqual(f.organized, [])
  await f.click(f.find(element => element.props['data-settings-action'] === 'organize'))
  assert.deepEqual(f.updated, ['refresh']); assert.deepEqual(f.organized, [{ action: 'overview' }])
  await f.select('advanced')
  const outbox = f.find(element => element.props.class === 'command-outbox-entry'); assert.ok(outbox)
  await f.click(outbox); assert.equal(f.outboxOpen.value, true)
  t.diagnostic('正式SettingsView与App原完整设置节点的合成接线；子模块为事件表面，不代表Electron、Owner或真实库验证。')
})

test('高级配置折叠后仍显示未保存和待核对，查看设置打开原AI入口，原错误继续可见', async t => {
  const f = await mountSettings(t, false, { sourceWritesAvailable: false }); assert.ok(f.workspace)
  f.workspace.nameDirty.value = true; await f.settle()
  const attention = () => f.find(element => element.props.role === 'status' && element.props.class === 'settings-attention')
  assert.ok(attention()); assert.match(f.text(attention()!), /未保存/u); assert.equal(f.mounts.has('LocalAiSettings'), false)
  await f.select('advanced')
  assert.equal(f.summary('智能整理服务').parent?.open, false)
  assert.match(f.text(f.summary('智能整理服务')), /未保存/u)
  assert.match(f.text(f.summary('音乐文件写入')), /未就绪/u)
  assert.deepEqual(f.modules(), [])
  f.workspace.originalNameSave.value = { commandId: '合成原保存身份' }; await f.settle()
  assert.match(f.text(f.summary('智能整理服务')), /待核对/u)
  assert.doesNotMatch(f.text(f.summary('智能整理服务')), /未保存/u)
  await f.select('application'); assert.match(f.text(attention()!), /待核对/u)
  await f.click(f.find(element => element.type === 'button' && f.text(element) === '查看设置'))
  assert.equal(f.tab('advanced').props['aria-selected'], true); assert.equal(f.summary('智能整理服务').parent?.open, true)
  assert.ok(f.modules().includes('LocalAiSettings'))
  await f.toggle('智能整理服务', false)
  f.workspace.error.value = '合成原配置尚未获确认，请核对设置。'; await f.settle()
  const alert = f.find(element => element.props.role === 'alert')
  assert.ok(alert); assert.equal(f.text(alert), f.workspace.error.value); assert.equal(f.modules().includes('LocalAiSettings'), false)
  await f.toggle('音乐文件写入', true)
  assert.equal(f.mounts.has('LocalSourceWritesSettings'), false); assert.match(f.text(), /文件写入暂不可用/u)
  f.workspace.originalNameSave.value = null; f.workspace.nameDirty.value = false; f.workspace.error.value = ''; await f.settle()
  assert.equal(attention() === undefined, true); assert.equal(f.find(element => element.props.role === 'alert') === undefined, true)
  assert.doesNotMatch(f.text(f.summary('智能整理服务')), /未保存|待核对/u)
  assert.match(f.text(f.summary('音乐文件写入')), /未就绪/u)
})

test('高级服务不可用在折叠摘要可见，展开不会伪造可用模块', async t => {
  const f = await mountSettings(t, false, { sourceWritesAvailable: false, workspaceAvailable: false }); await f.select('advanced')
  for (const title of ['智能整理服务', '音乐文件写入']) {
    const summary = f.summary(title)
    assert.equal(summary.parent?.open, false); assert.match(f.text(summary), /未就绪/u)
    await f.toggle(title, true); assert.match(f.text(summary), /未就绪/u)
  }
  assert.equal(f.mounts.has('LocalAiSettings'), false); assert.equal(f.mounts.has('LocalSourceWritesSettings'), false)
  assert.match(f.text(), /音乐库服务尚未就绪/u); assert.match(f.text(), /文件写入暂不可用/u)
})
