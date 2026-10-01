import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
interface Host { tag: string; text: string; children: Host[]; parent: Host | null; props: Record<string, unknown>; closest: () => null }
async function mounted(t: test.TestContext, name: 'SearchEntities' | 'LibraryRefreshNotice', initial: Record<string, unknown>) {
  const { parse, compileScript } = await import('@vue/compiler-sfc'), ts = (await import('typescript')).default
  const require = createRequire(import.meta.url), vue = require('vue') as typeof import('vue')
  const { descriptor, errors } = parse(await readFile(new URL(`../src/renderer/src/components/${name}.vue`, import.meta.url), 'utf8')); assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: 'mbp005-ui', inlineTemplate: true })
  const compiled = ts.transpileModule(script.content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const entities = await import('../src/renderer/src/composables/search-entities.js')
  const load = (path: string) => path === 'vue' ? vue : path.includes('search-entities') ? entities : path.endsWith('.vue') ? { default: { render: () => null } } : path.startsWith('.') ? require(new URL(path, new URL('../src/renderer/src/components/', import.meta.url)).pathname) : require(path)
  let intersect: (() => void) | undefined
  class Observer { constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) { intersect = () => callback([{ isIntersecting: true }]) } observe() {} disconnect() {} }
  const component = { exports: {} as { default: import('vue').Component } }
  new Function('require', 'module', 'exports', 'IntersectionObserver', compiled)(load, component, component.exports, Observer)
  const node = (tag = ''): Host => ({ tag, text: '', children: [], parent: null, props: {}, closest: () => null })
  const renderer = vue.createRenderer<Host, Host>({ createElement: node, createText(value) { const n = node('#text'); n.text = value; return n }, createComment: () => node('#comment'),
    setText(target, value) { target.text = value }, setElementText(target, value) { target.text = value; target.children = [] }, patchProp(target, key, _old, value) { target.props[key] = value },
    insert(child, parent, anchor) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = parent; const i = anchor ? parent.children.indexOf(anchor) : -1; if (i < 0) parent.children.push(child); else parent.children.splice(i, 0, child) },
    remove(child) { child.parent?.children.splice(child.parent.children.indexOf(child), 1); child.parent = null }, parentNode: target => target.parent,
    nextSibling: target => target.parent?.children[(target.parent?.children.indexOf(target) ?? -1) + 1] ?? null })
  const props = vue.reactive(initial), more: unknown[][] = [], root = node('root'); let retries = 0
  const app = renderer.createApp({ render: () => vue.h(component.exports.default, { ...props, ...(name === 'SearchEntities' ? { onMore: (...args: unknown[]) => more.push(args) } : { onRetry: () => retries++ }) }) })
  app.mount(root); t.after(() => app.unmount()); await vue.nextTick(); await vue.nextTick()
  const flatten = (target: Host): Host[] => [target, ...target.children.flatMap(flatten)]
  return { props, more, text: () => flatten(root).map(n => n.text).join(' '), nodes: () => flatten(root), retryCount: () => retries, flush: async () => { await vue.nextTick(); await vue.nextTick() }, intersect: () => intersect?.() }
}
test('MBP005 mounted：健康Roon专辑不被艺人loading/error或共享error挡住，滚动只派发健康分区', async t => {
  const h = await mounted(t, 'SearchEntities', { mode: 'albums', artists: [], albums: [], roonArtists: [], roonAlbums: [{ reference: '专辑A', kind: 'album', title: '即时专辑' }],
    artistsLoading: false, albumsLoading: false, roonLoading: true, roonAlbumsLoading: false, roonArtistsLoading: true,
    artistsError: null, albumsError: null, roonError: '共享错误不可挡专辑', roonAlbumsError: null, roonArtistsError: null,
    moreRoonAlbums: true, moreRoonArtists: true, moreAlbums: false, moreArtists: false })
  assert.match(h.text(), /即时专辑/); assert.doesNotMatch(h.text(), /共享错误不可挡专辑/)
  h.intersect(); assert.deepEqual(h.more, [['roon', 'album']])
  h.props.roonArtistsLoading = false; h.props.roonArtistsError = '艺人读取失败'; await h.flush(); h.intersect()
  assert.deepEqual(h.more, [['roon', 'album'], ['roon', 'album']]); assert.match(h.text(), /即时专辑/)
})
test('MBP005 mounted：刷新失败提示保留legacy声明且明确重试，pending只禁用重试', async t => {
  const h = await mounted(t, 'LibraryRefreshNotice', { message: '后台刷新失败，保留已加载内容。', legacy: true, pending: true })
  assert.match(h.text(), /保留已加载内容/); assert.match(h.text(), /无法确认分页来自同一份歌单/)
  const button = h.nodes().find(n => n.tag === 'button')!; assert.equal(button.props.disabled, true)
  h.props.pending = false; await h.flush(); assert.equal(button.props.disabled, false)
  ;(button.props.onClick as () => void)(); assert.equal(h.retryCount(), 1)
  h.props.message = null; await h.flush(); assert.doesNotMatch(h.text(), /后台刷新失败/); assert.match(h.text(), /无法确认分页来自同一份歌单/)
})

import { useAggregatedSearch } from '../src/renderer/src/composables/application/useAggregatedSearch.js'
import { createLibraryPageCache } from '../src/renderer/src/composables/libraryPageCache.js'
import type { MusicBridgePublicApi } from '../src/preload/api.js'
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
async function mountedSearchDetail(t: test.TestContext, search: ReturnType<typeof useAggregatedSearch>) {
  const { parse, compileScript, compileTemplate } = await import('@vue/compiler-sfc'), ts = (await import('typescript')).default
  const require = createRequire(import.meta.url), vue = require('vue') as typeof import('vue')
  const { descriptor } = parse(await readFile(new URL('../src/renderer/src/App.vue', import.meta.url), 'utf8'))
  let subtree = ''
  function visit(node: { type: number; tag?: string; props?: Array<{ type: number; name?: string; exp?: { content?: string } }>; loc: { source: string }; children?: unknown[] }): void {
    if (node.type === 1 && node.tag === 'template' && node.props?.some(prop => prop.type === 7 && prop.name === 'if' && prop.exp?.content === 'searchDetail')) subtree = node.loc.source
    for (const child of node.children ?? []) visit(child as Parameters<typeof visit>[0])
  }
  visit(descriptor.template!.ast as unknown as Parameters<typeof visit>[0]); assert.ok(subtree)
  const compiled = compileTemplate({ source: subtree, filename: 'ActualAppDetail.vue', id: 'mbp005-detail' }); assert.deepEqual(compiled.errors, [])
  const mod = { exports: {} as { render: import('vue').ComponentOptions['render'] } }
  new Function('require', 'module', 'exports', ts.transpileModule(compiled.code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText)(
    (path: string) => path === 'vue' ? vue : require(path), mod, mod.exports)
  const notice = parse(await readFile(new URL('../src/renderer/src/components/LibraryRefreshNotice.vue', import.meta.url), 'utf8')).descriptor
  const noticeScript = compileScript(notice, { id: 'mbp005-detail-notice', inlineTemplate: true }), noticeModule = { exports: {} as { default: import('vue').Component } }
  new Function('require', 'module', 'exports', ts.transpileModule(noticeScript.content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText)(
    (path: string) => path === 'vue' ? vue : require(path), noticeModule, noticeModule.exports)
  const node = (tag = ''): Host => ({ tag, text: '', children: [], parent: null, props: {}, closest: () => null })
  const renderer = vue.createRenderer<Host, Host>({ createElement: node, createText(value) { const n = node('#text'); n.text = value; return n }, createComment: () => node('#comment'),
    setText(n, v) { n.text = v }, setElementText(n, v) { n.text = v; n.children = [] }, patchProp(n, k, _o, v) { n.props[k] = v },
    insert(c, p, a) { if (c.parent) c.parent.children.splice(c.parent.children.indexOf(c), 1); c.parent = p; const i = a ? p.children.indexOf(a) : -1; if (i < 0) p.children.push(c); else p.children.splice(i, 0, c) },
    remove(c) { c.parent?.children.splice(c.parent.children.indexOf(c), 1); c.parent = null }, parentNode: n => n.parent, nextSibling: n => n.parent?.children[n.parent.children.indexOf(n) + 1] ?? null })
  const component = { setup: () => ({ search, searchDetail: search.searchDetail, searchDetailLoadingMore: search.searchDetailLoadingMore, searchDetailMoreError: search.searchDetailMoreError,
    closeSearchDetail: search.closeSearchDetail, loadMoreSearchDetail: search.loadMoreSearchDetail, playbackStartPending: false, matchStates: {}, playTrack() {}, appendTrack() {}, insertTrackNext() {} }),
    components: { TrackTable: vue.defineComponent({ props: { tracks: { type: Array as import('vue').PropType<Array<{ title: string }>>, required: true } }, setup(props) { return () => vue.h('div', { 'data-test': 'table' }, props.tracks.map(track => track.title).join(' ')) } }), LibraryRefreshNotice: noticeModule.exports.default }, render: mod.exports.render }
  const root = node('root'), app = renderer.createApp(component); app.mount(root); t.after(() => app.unmount())
  const flatten = (n: Host): Host[] => [n, ...n.children.flatMap(flatten)]
  return { text: () => flatten(root).map(n => n.text).join(' '), nodes: () => flatten(root), flush: async () => { await vue.nextTick(); await vue.nextTick() } }
}
for (const phase of ['pending', 'failed'] as const) test(`MBP005 R1 mounted：实际App搜索详情${phase}刷新保留已有歌曲与有效重试`, async t => {
  let now = 100_000, calls = 0, reject!: (error: Error) => void
  const pending = new Promise<never>((_done, fail) => { reject = fail })
  const search = useAggregatedSearch({ cache: createLibraryPageCache({ now: () => now }), api: { getAlbum: async () => {
    calls++; if (calls === 2) return pending
    return { id: 'album-a', name: '合成专辑', artistName: '合成艺人', trackCount: 1, tracks: { items: [{ id: 'track-a', title: calls > 2 ? '重试新歌曲' : '已加载歌曲', artists: ['合成艺人'], album: '合成专辑' }], offset: 0, limit: 20, total: 1, hasMore: false } }
  } } as unknown as MusicBridgePublicApi, getZoneId: () => undefined, getScrollTop: () => 0, scrollTo: () => {}, classifyError: () => 'generic', onResetSearchOrigin: () => {}, onInvalidateRoonDetails: () => {} })
  t.after(() => search.dispose()); await search.openSearchDetail('album', 'album-a', '合成专辑', '合成艺人'); now = 130_000
  const refresh = search.openSearchDetail('album', 'album-a', '合成专辑', '合成艺人'), ui = await mountedSearchDetail(t, search); await ui.flush()
  if (phase === 'pending') {
    try { assert.equal(ui.nodes().find(n => n.props['data-test'] === 'table')?.text, '已加载歌曲'); assert.equal(search.searchDetail.value?.loading, true); await search.loadMoreSearchDetail(); assert.equal(calls, 2, '刷新首页在途时保持可见歌曲，但不能并发拼接旧尾页') }
    finally { reject(new Error('合成失败')); await refresh }
  } else {
    reject(new Error('合成失败')); await refresh; await ui.flush()
    assert.equal(ui.nodes().find(n => n.props['data-test'] === 'table')?.text, '已加载歌曲'); assert.match(ui.text(), /保留已加载歌曲/)
    const retry = ui.nodes().find(n => n.tag === 'button' && n.text === '重新读取')!; assert.ok(retry); (retry.props.onClick as () => void)()
    await turn(); await ui.flush(); assert.equal(calls, 3); assert.match(ui.text(), /重试新歌曲/); assert.doesNotMatch(ui.text(), /刷新详情失败/)
  }
})
