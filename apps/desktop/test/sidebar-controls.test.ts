import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import ts from 'typescript'
import * as sidebarSearchModel from '../src/renderer/src/components/sidebar/sidebar-search-model.js'

const require = createRequire(import.meta.url)
const vue = require('vue') as typeof import('vue')
interface Host { type: string; text: string; props: Record<string, any>; children: Host[]; parent: Host | null }
const node = (type = ''): Host => Object.assign({ type, text: '', props: {}, children: [], parent: null }, { style: { display: '' }, getBoundingClientRect: () => ({ top: 180, right: 60 }), focus() {}, blur() {},
  contains(this: Host, other: Host): boolean { for (let value: Host | null = other; value; value = value.parent) if (value === this) return true; return false } })

async function mount(t: test.TestContext, name: string, initial: Record<string, unknown>) {
  const { descriptor } = parse(await readFile(new URL(`../src/renderer/src/components/sidebar/${name}.vue`, import.meta.url), 'utf8'))
  const script = compileScript(descriptor, { id: name })
  const template = compileTemplate({ id: name, filename: name + '.vue', source: descriptor.template!.content, compilerOptions: { bindingMetadata: script.bindings } })
  assert.deepEqual(template.errors, [])
  const module = { exports: {} as { default: import('vue').Component } }
  const renderModule = { exports: {} as { render: (...args: any[]) => any } }
  const load = (id: string) => {
    if (id === 'vue') return vue
    if (id.endsWith('sidebar-search-model.js')) return sidebarSearchModel
    if (id.endsWith('SidebarPlaylistRow.vue')) return { default: vue.defineComponent({
      props: ['playlist', 'expanded', 'selected'], emits: ['select'],
      setup: (props, { emit }) => () => vue.h('button', { class: 'test-playlist', onClick: () => emit('select', props.playlist.id) }, props.playlist.name),
    }) }
    if (id.endsWith('.vue')) return { default: { render: () => vue.h('span') } }
    return require(id)
  }
  const compile = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const documentListeners = new Map<string, (event: any) => void>()
  const windowListeners = new Map<string, (event: any) => void>()
  const hostDocument = { addEventListener: (type: string, listener: (event: any) => void) => documentListeners.set(type, listener), removeEventListener: (type: string) => documentListeners.delete(type), getElementById: () => ({ scrollIntoView() {} }) }
  class HostNode { static [Symbol.hasInstance](value: unknown) { return !!value && typeof value === 'object' && 'type' in value } }
  new Function('require', 'module', 'exports', 'document', 'window', 'Node', compile(script.content))(load, module, module.exports, hostDocument, { innerWidth: 720, innerHeight: 480,
    addEventListener: (type: string, listener: (event: any) => void) => windowListeners.set(type, listener), removeEventListener: (type: string) => windowListeners.delete(type) }, HostNode)
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
  return { all, byClass, click, props, tick: vue.nextTick, pointerOutside: () => documentListeners.get('pointerdown')?.({ target: node('outside') }),
    globalKeydown: (event: Record<string, unknown>) => windowListeners.get('keydown')?.(event) }
}

const playlists = [{ id: '301', name: '合成歌单', trackCount: 2 }]

test('主导航按指定顺序排列，收藏只指向 Roon，歌单独立折叠', async () => {
  const source = await readFile(new URL('../src/renderer/src/components/sidebar/MusicSidebar.vue', import.meta.url), 'utf8')
  const entries = [...source.matchAll(/<SidebarNavRow source="([^"]+)" label="([^"]+)"/g)].map(match => ({ index: match.index, source: match[1], label: match[2] }))
  const collection = source.indexOf('data-sidebar-source="collection"')
  assert.ok(collection > 0)
  entries.push({ index: collection, source: 'collection', label: '实物收藏' })
  const sources = entries.sort((a, b) => a.index - b.index).map(entry => [entry.source, entry.label])
  assert.deepEqual(sources, [['home','主页'],['roon-albums','专辑'],['roon-artists','艺术家'],['roon-genres','流派'],['local-library','本地音乐'],['coverdrop','CoverDrop'],['roon-favorites','收藏'],['collection','实物收藏'],['recording','录音']])
  assert.ok(source.indexOf('<SidebarPlaylistList') > source.indexOf('source="recording"'))
  assert.ok(source.indexOf('<SidebarSettingsFooter') > source.indexOf('</nav>'))
})

test('实物收藏展开组保留两个独立入口且子项点击不重复导航', async t => {
  const selections: string[] = [], views: string[] = []
  const f = await mount(t, 'MusicSidebar', { expanded: true, activeSource: { type: 'home' }, searchQuery: '', playlists: [], playlistState: 'ready', sourceScrollTop: 0, settingsActive: false,
    onNavigate: (source: { type: string }) => selections.push(source.type), 'onNavigate-collection': (view: string) => views.push(view) })
  await f.click(f.byClass('sidebar-collection-toggle')[0])
  assert.deepEqual(selections, ['collection'])
  f.props.activeSource = { type: 'collection' }; await f.tick()
  const children = f.byClass('sidebar-collection-child')
  assert.equal(children.length, 2)
  assert.deepEqual(children.map(child => child.props['data-collection-view']), ['tapes', 'music'])
  for (const child of children) await f.click(child)
  assert.deepEqual(views, ['tapes', 'music'])
  assert.deepEqual(selections, ['collection'])
  f.props.collectionView = 'music'; await f.tick()
  assert.equal(f.byClass('sidebar-collection-child')[1]?.props['aria-current'], 'page')
})

test('设置保留收藏来源时，单次父按钮返回收藏且普通页仍可折叠', async t => {
  for (const expanded of [true, false]) {
    const selections: string[] = []; let toggles = 0
    const f = await mount(t, 'MusicSidebar', { expanded, activeSource: { type: 'collection' }, collectionView: 'music', searchQuery: '', playlists: [], playlistState: 'ready', sourceScrollTop: 0, settingsActive: true,
      onNavigate: (source: { type: string }) => selections.push(source.type), onToggle: () => toggles++ })
    const parent = () => f.byClass('sidebar-collection-toggle')[0]
    await f.click(parent())
    assert.deepEqual(selections, ['collection'], '设置页单次点击必须导航，不能只折叠分类')
    assert.equal(toggles, expanded ? 0 : 1)
    f.props.expanded = true; f.props.settingsActive = false; await f.tick()
    assert.equal(parent()?.props['aria-expanded'], true)
    assert.equal(f.byClass('sidebar-collection-child')[1]?.props['aria-current'], 'page')
    await f.click(parent()); assert.equal(parent()?.props['aria-expanded'], false)
    await f.click(parent()); assert.equal(parent()?.props['aria-expanded'], true)
    assert.deepEqual(selections, ['collection'], '已在收藏页时折叠和展开不得重复导航')
  }
})

test('收藏分类即使文字被窄窗样式隐藏仍保留独立按钮名称', async t => {
  const f = await mount(t, 'MusicSidebar', { expanded: true, activeSource: { type: 'collection' }, searchQuery: '', playlists: [], playlistState: 'ready', sourceScrollTop: 0, settingsActive: false })
  for (const expanded of [true, false]) {
    f.props.expanded = expanded; await f.tick()
    assert.deepEqual(f.byClass('sidebar-collection-child').map(child => child.props['aria-label']), ['收藏音乐库', '实体音乐库'])
  }
})

test('歌单默认展开，折叠后移除列表，再展开仍可导航且不触发重试', async t => {
  const selections: string[] = []; let retries = 0
  const f = await mount(t, 'SidebarPlaylistList', { expanded: true, playlists, state: 'ready', onSelect: (id: string) => selections.push(id), onRetry: () => retries++ })
  const toggle = () => f.byClass('sidebar-playlist-toggle')[0]
  assert.equal(toggle()?.props['aria-label'], '歌单')
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

test('4.1 搜索草稿IME防抖，输入不提交，Esc保留文字，查看全部才提交', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const suggestions: string[] = [], submissions: string[] = [], selected: string[] = []
  let f!: Awaited<ReturnType<typeof mount>>
  f = await mount(t, 'SidebarSearch', { expanded: true, modelValue: '', suggestions: [{ key: 'artist:1', kind: 'artist', source: 'local', title: '合成人物', subtitle: '本地' }],
    'onUpdate:modelValue': (value: string) => { f.props.modelValue = value }, 'onSuggest-query': (value: string) => suggestions.push(value),
    'onSubmit-query': (value: string) => submissions.push(value), 'onSelect-suggestion': (item: { key: string }) => selected.push(item.key) })
  const input = () => f.all().find(el => el.type === 'input')!
  const key = async (value: string, composing = false) => { input().props.onKeydown({ key: value, isComposing: composing, preventDefault() {} }); await f.tick() }
  input().props.onCompositionstart(); input().props.onInput({ target: { value: '合' } }); await f.tick()
  t.mock.timers.tick(300); await key('Enter', true)
  assert.deepEqual(suggestions, []); assert.deepEqual(submissions, []); assert.deepEqual(selected, [])
  assert.equal(input().props['aria-expanded'], false, '组词期间不能显示未查询的空结果提示')
  assert.equal(f.byClass('sidebar-search-popover').length, 0)
  input().props.onCompositionend({ target: { value: '合成人物' } }); await f.tick()
  t.mock.timers.tick(249); assert.deepEqual(suggestions, [])
  t.mock.timers.tick(1); assert.deepEqual(suggestions, ['合成人物']); assert.deepEqual(submissions, [])
  assert.equal(input().props['aria-expanded'], true)
  await key('Escape'); assert.equal(input().props['aria-expanded'], false); assert.equal(f.props.modelValue, '合成人物')
  await key('ArrowDown'); assert.equal(input().props['aria-expanded'], true)
  await key('ArrowDown'); await key('Enter')
  assert.deepEqual(submissions, ['合成人物']); assert.deepEqual(selected, [])
})

test('4.1 搜索下拉键盘选中跟随异步实体身份，外点关闭且不清空草稿', async t => {
  const selected: string[] = []
  const first = { key: 'first', kind: 'artist', source: 'local', title: '合成人物甲', subtitle: '本地' }
  const second = { key: 'second', kind: 'album', source: 'netease', title: '合成专辑乙', subtitle: '网易云' }
  const f = await mount(t, 'SidebarSearch', { expanded: true, modelValue: '合成', suggestions: [first, second], 'onSelect-suggestion': (item: { key: string }) => selected.push(item.key) })
  const input = () => f.all().find(el => el.type === 'input')!
  const key = async (value: string) => { input().props.onKeydown({ key: value, preventDefault() {} }); await f.tick() }
  input().props.onFocus(); await f.tick(); await key('ArrowDown'); await key('ArrowDown')
  f.props.suggestions = [second, first]; await f.tick(); await key('Enter')
  assert.deepEqual(selected, ['second'])
  input().props.onFocus(); await f.tick(); f.pointerOutside(); await f.tick()
  assert.equal(input().props['aria-expanded'], false); assert.equal(f.props.modelValue, '合成')
})

test('4.1 完整搜索后输入仍聚焦，点击、方向键与⌘L重开同词都重新请求建议', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const suggestions: string[] = [], submissions: string[] = []
  let f!: Awaited<ReturnType<typeof mount>>
  f = await mount(t, 'SidebarSearch', { expanded: true, modelValue: '周杰伦', suggestions: [],
    'onSuggest-query': (value: string) => suggestions.push(value),
    // 对应真实父层 search→invalidatePreview：完整提交清掉预览，但草稿继续保留。
    'onSubmit-query': (value: string) => { submissions.push(value); f.props.suggestions = [] } })
  const input = () => f.all().find(el => el.type === 'input')!
  const key = async (value: string) => { input().props.onKeydown({ key: value, preventDefault() {} }); await f.tick() }
  input().props.onFocus(); await f.tick(); t.mock.timers.tick(250)
  assert.deepEqual(suggestions, ['周杰伦'])
  const reopen = [() => f.click(input()), () => key('ArrowDown'), () => key('ArrowUp'), async () => {
    let prevented = false
    f.globalKeydown({ key: 'l', metaKey: true, shiftKey: false, preventDefault() { prevented = true } }); await f.tick()
    assert.equal(prevented, true)
  }]
  for (const [index, open] of reopen.entries()) {
    await key('Enter'); assert.equal(input().props['aria-expanded'], false)
    assert.equal(f.props.modelValue, '周杰伦')
    // 不再触发 focus，覆盖真实的“提交后仍聚焦”路径。
    await open(); assert.equal(input().props['aria-expanded'], true)
    t.mock.timers.tick(249); assert.equal(suggestions.length, index + 1)
    t.mock.timers.tick(1); assert.equal(suggestions.length, index + 2)
    assert.equal(suggestions.at(-1), '周杰伦')
  }
  assert.deepEqual(submissions, ['周杰伦', '周杰伦', '周杰伦', '周杰伦'])
})

test('4.1 重开建议守IME，重复点击不延长防抖，换词撤销待发旧请求', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const suggestions: string[] = []
  let f!: Awaited<ReturnType<typeof mount>>
  f = await mount(t, 'SidebarSearch', { expanded: true, modelValue: '保留草稿', suggestions: [],
    'onUpdate:modelValue': (value: string) => { f.props.modelValue = value }, 'onSuggest-query': (value: string) => suggestions.push(value) })
  const input = () => f.all().find(el => el.type === 'input')!
  const key = async (value: string) => { input().props.onKeydown({ key: value, preventDefault() {} }); await f.tick() }
  input().props.onCompositionstart(); await f.click(input()); await key('ArrowDown')
  let prevented = false
  f.globalKeydown({ key: 'l', metaKey: true, preventDefault() { prevented = true } }); await f.tick()
  t.mock.timers.tick(300)
  assert.equal(prevented, false); assert.equal(input().props['aria-expanded'], false); assert.deepEqual(suggestions, [])
  input().props.onCompositionend({ target: { value: '完成输入' } }); await f.tick()
  t.mock.timers.tick(200); await f.click(input()); await key('ArrowDown')
  t.mock.timers.tick(49); assert.deepEqual(suggestions, [])
  t.mock.timers.tick(1); assert.deepEqual(suggestions, ['完成输入'])
  await key('Escape'); assert.equal(f.props.modelValue, '完成输入')
  await key('ArrowDown'); t.mock.timers.tick(100)
  input().props.onInput({ target: { value: '换成新词' } }); await f.tick()
  t.mock.timers.tick(249); assert.deepEqual(suggestions, ['完成输入'])
  t.mock.timers.tick(1); assert.deepEqual(suggestions, ['完成输入', '换成新词'])
})

test('4.1 关闭后的异步建议不自动重开，Esc仍保留草稿并撤销待发重开请求', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const suggestions: string[] = []
  const f = await mount(t, 'SidebarSearch', { expanded: true, modelValue: '保留草稿', suggestions: [], 'onSuggest-query': (value: string) => suggestions.push(value) })
  const input = () => f.all().find(el => el.type === 'input')!
  const key = async (value: string) => { input().props.onKeydown({ key: value, preventDefault() {} }); await f.tick() }
  input().props.onFocus(); await f.tick(); t.mock.timers.tick(250)
  f.pointerOutside(); await f.tick()
  f.props.suggestions = [{ key: 'later', kind: 'artist', source: 'local', title: '迟到实体', subtitle: '本地' }]; await f.tick()
  assert.equal(input().props['aria-expanded'], false)
  await f.click(input()); t.mock.timers.tick(100); await key('Escape'); t.mock.timers.tick(300)
  assert.equal(input().props['aria-expanded'], false); assert.equal(f.props.modelValue, '保留草稿')
  assert.deepEqual(suggestions, ['保留草稿'])
  await f.click(input()); t.mock.timers.tick(250)
  assert.deepEqual(suggestions, ['保留草稿', '保留草稿'])
})
