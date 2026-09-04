import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const vue = require('vue') as typeof import('vue')
interface Host { type: string; text: string; props: Record<string, any>; children: Host[]; parent: Host | null }
const node = (type = ''): Host => Object.assign({ type, text: '', props: {}, children: [], parent: null }, { getBoundingClientRect: () => ({ top: 180, right: 60 }), focus() {} })

async function mount(t: test.TestContext, name: string, initial: Record<string, unknown>) {
  const { descriptor } = parse(await readFile(new URL(`../src/renderer/src/components/sidebar/${name}.vue`, import.meta.url), 'utf8'))
  const script = compileScript(descriptor, { id: name })
  const template = compileTemplate({ id: name, filename: name + '.vue', source: descriptor.template!.content, compilerOptions: { bindingMetadata: script.bindings } })
  assert.deepEqual(template.errors, [])
  const module = { exports: {} as { default: import('vue').Component } }
  const renderModule = { exports: {} as { render: (...args: any[]) => any } }
  const load = (id: string) => {
    if (id === 'vue') return vue
    if (id.endsWith('SidebarPlaylistRow.vue')) return { default: vue.defineComponent({
      props: ['playlist', 'expanded', 'selected'], emits: ['select'],
      setup: (props, { emit }) => () => vue.h('button', { class: 'test-playlist', onClick: () => emit('select', props.playlist.id) }, props.playlist.name),
    }) }
    if (id.endsWith('.vue')) return { default: { render: () => vue.h('span') } }
    return require(id)
  }
  const compile = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  new Function('require', 'module', 'exports', 'document', 'window', compile(script.content))(load, module, module.exports, { addEventListener() {}, removeEventListener() {} }, { innerWidth: 720, innerHeight: 480, addEventListener() {}, removeEventListener() {} })
  new Function('require', 'module', 'exports', compile(template.code))(load, renderModule, renderModule.exports)
  const remove = (child: Host) => { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = null }
  const body = node('body')
  const renderer = vue.createRenderer<Host, Host>({
    querySelector: () => body,
    createElement: node, createText: text => ({ ...node('text'), text }), createComment: () => node('comment'),
    setText: (el, text) => { el.text = text }, setElementText: (el, text) => { el.text = text; el.children = [] },
    patchProp: (el, key, _old, value) => { el.props[key] = value },
    insert: (el, parent, anchor) => { remove(el); el.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(index < 0 ? parent.children.length : index, 0, el) },
    remove, parentNode: el => el.parent, nextSibling: el => el.parent?.children[el.parent.children.indexOf(el) + 1] ?? null,
  })
  const props = vue.reactive(initial), root = node('root')
  const component = { ...module.exports.default, render: renderModule.exports.render }
  const app = renderer.createApp({ render: () => vue.h(component, props) }); app.mount(root)
  t.after(() => app.unmount())
  const all = (el: Host = root): Host[] => [el, ...el.children.flatMap(child => all(child))]
  const byClass = (name: string) => [...all(), ...all(body)].filter(el => String(el.props.class).split(' ').includes(name))
  const click = async (el: Host | undefined) => { assert.ok(el, '缺少可点击控件'); el.props.onClick(); await vue.nextTick() }
  return { all, byClass, click, props, tick: vue.nextTick }
}

const playlists = [{ id: '301', name: '合成歌单', trackCount: 2 }]

test('侧栏只有资料库和收藏两个主分类，既有入口完整且网易云歌单嵌入收藏', async () => {
  const source = await readFile(new URL('../src/renderer/src/components/sidebar/MusicSidebar.vue', import.meta.url), 'utf8')
  const groups = [...source.matchAll(/<SidebarSection title="([^"]+)"[^>]*>([\s\S]*?)<\/SidebarSection>/g)]
  assert.deepEqual(groups.map(group => group[1]), ['资料库', '收藏'])
  const sources = (group: string) => [...group.matchAll(/<SidebarNavRow source="([^"]+)"/g)].map(match => match[1])
  assert.deepEqual(sources(groups[0]![2]!), ['home', 'playlists', 'roon-albums', 'roon-artists', 'roon-genres', 'roon-playlists'])
  assert.deepEqual(sources(groups[1]![2]!), ['liked', 'roon-favorites', 'collection', 'recording'])
  assert.match(groups[1]![2]!, /<SidebarPlaylistList/)
  assert.match(source, /source="collection" label="实物收藏"/)
})

test('歌单默认展开，折叠后移除列表，再展开仍可导航且不触发重试', async t => {
  const selections: string[] = []; let retries = 0
  const f = await mount(t, 'SidebarPlaylistList', { expanded: true, playlists, state: 'ready', onSelect: (id: string) => selections.push(id), onRetry: () => retries++ })
  const toggle = () => f.byClass('sidebar-playlist-toggle')[0]
  assert.equal(toggle()?.props['aria-expanded'], true)
  assert.ok(toggle()?.props['aria-controls'])
  await f.click(toggle()); assert.equal(toggle()?.props['aria-expanded'], false); assert.equal(f.byClass('test-playlist').length, 0)
  await f.click(toggle()); await f.click(f.byClass('test-playlist')[0])
  assert.deepEqual(selections, ['301']); assert.equal(retries, 0); assert.equal(playlists.length, 1)
})

test('歌单加载、错误与空列表均可以折叠；重试行为仍保留', async t => {
  for (const state of ['loading', 'error', 'ready']) {
    let retries = 0
    const f = await mount(t, 'SidebarPlaylistList', { expanded: true, playlists: [], state, onRetry: () => retries++ })
    if (state === 'error') { await f.click(f.byClass('sidebar-retry-button')[0]); assert.equal(retries, 1) }
    await f.click(f.byClass('sidebar-playlist-toggle')[0])
    assert.equal(f.byClass('sidebar-playlist-list').length, 0); assert.equal(f.byClass('sidebar-playlist-error').length, 0); assert.equal(f.byClass('sidebar-empty-playlists').length, 0)
  }
})

test('侧栏收窄仍可打开歌单弹层，选中后关闭，返回展开侧栏保持折叠状态', async t => {
  const f = await mount(t, 'SidebarPlaylistList', { expanded: true, playlists, state: 'ready' })
  await f.click(f.byClass('sidebar-playlist-toggle')[0]); f.props.expanded = false; await f.tick()
  await f.click(f.byClass('sidebar-collapsed-source-button')[0]); assert.equal(f.byClass('sidebar-playlist-popover').length, 1)
  assert.equal(f.byClass('sidebar-playlist-popover')[0]?.parent?.type, 'body', '弹层必须脱离侧栏滚动容器，避免被裁切')
  await f.click(f.byClass('test-playlist')[0]); assert.equal(f.byClass('sidebar-playlist-popover').length, 0)
  f.props.expanded = true; await f.tick(); assert.equal(f.byClass('sidebar-playlist-toggle')[0]?.props['aria-expanded'], false)
})

test('设置横条不含头像，展开与收窄都能打开设置并保留当前页语义', async t => {
  let opens = 0
  const f = await mount(t, 'SidebarSettingsFooter', { expanded: true, active: true, onOpen: () => opens++ })
  const button = () => f.byClass('sidebar-settings-button')[0]
  assert.equal(button()?.props['aria-label'], '打开设置'); assert.equal(button()?.props['aria-current'], 'page')
  assert.equal(f.all().filter(el => el.type === 'img').length, 0)
  await f.click(button()); f.props.expanded = false; await f.tick(); await f.click(button()); assert.equal(opens, 2)
})
