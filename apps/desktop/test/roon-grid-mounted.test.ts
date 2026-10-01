import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import type { FavoriteRecord } from '@music-bridge/contracts'
interface Host { tag: string; text: string; children: Host[]; parent: Host | null; props: Record<string, unknown>; closest: (selector?: string) => Host | null; querySelector: (selector: string) => Host | null; querySelectorAll: (selector: string) => Host[]; matches: (selector: string) => boolean; dataset: { gridIndex?: string }; focus: () => void }
const turn = () => new Promise<void>(done => setImmediate(done))
async function mountGrid(t: test.TestContext, name: string, initial: Record<string, unknown>, api: Record<string, unknown> = {}) {
  const { parse, compileScript } = await import('@vue/compiler-sfc'), ts = (await import('typescript')).default, require = createRequire(import.meta.url), vue = require('vue') as typeof import('vue')
  const source = await readFile(new URL(`../src/renderer/src/components/${name}.vue`, import.meta.url), 'utf8'), { descriptor, errors } = parse(source); assert.deepEqual(errors, [])
  const code = ts.transpileModule(compileScript(descriptor, { id: 'grid007', inlineTemplate: true }).content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const component = { exports: {} as { default: import('vue').Component } }
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { value: { musicBridge: api }, configurable: true }); t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window') })
  class Observer { observe() {} disconnect() {} unobserve() {} }
  const artwork = vue.defineComponent({ props: ['externalRetry', 'reference'], emits: ['retry-action'], setup(props, { emit }) {
    function publishBusy() { if (typeof api.__testArtwork === 'function') (api.__testArtwork as (props: object, publish: (action: (() => void) | undefined) => void) => void)(props, action => emit('retry-action', action)) }
    vue.onMounted(publishBusy); vue.watch(() => props.reference, publishBusy, { flush: 'post' })
    vue.onUnmounted(() => emit('retry-action', undefined)); return () => null
  } })
  const load = (path: string) => path === 'vue' ? vue : path.endsWith('RoonArtwork.vue') ? { default: artwork } : path.endsWith('.vue') ? { default: { render: () => null } } : require(new URL(path, new URL('../src/renderer/src/components/', import.meta.url)).pathname)
  new Function('require', 'module', 'exports', 'IntersectionObserver', code)(load, component, component.exports, Observer)
  const focusHistory: number[] = []
  const descendants = (n: Host): Host[] => n.children.flatMap(child => [child, ...descendants(child)])
  const node = (tag = ''): Host => {
    const n: Host = { tag, text: '', children: [], parent: null, props: {},
      get dataset() { return { gridIndex: n.props['data-grid-index'] === undefined ? undefined : String(n.props['data-grid-index']) } },
      closest(selector) { if (selector === 'button') return n.tag === 'button' ? n : n.parent?.closest(selector) ?? null; if (selector === '[data-grid-index]') return n.dataset.gridIndex !== undefined ? n : n.parent?.closest(selector) ?? null; return null },
      matches(selector) { return selector.includes('button') && n.tag === 'button' && !n.props.disabled },
      querySelectorAll(selector) { return descendants(n).filter(child => selector.startsWith('[data-grid-index') ? child.dataset.gridIndex !== undefined : child.matches(selector)) },
      querySelector(selector) { const index = selector.match(/data-grid-index="(\d+)"/)?.[1]; return descendants(n).find(child => child.dataset.gridIndex === index) ?? null },
      focus() { const card = n.closest('[data-grid-index]'); if (card?.dataset.gridIndex !== undefined) focusHistory.push(Number(card.dataset.gridIndex)) },
    }; return n
  }
  const renderer = vue.createRenderer<Host, Host>({ createElement: node, createText(text) { const n = node('#text'); n.text = text; return n }, createComment: () => node('#comment'),
    setText(n, v) { n.text = v }, setElementText(n, v) { n.text = v; n.children = [] }, patchProp(n, key, _old, v) { n.props[key] = v },
    insert(c, p, a) { if (c.parent) c.parent.children.splice(c.parent.children.indexOf(c), 1); c.parent = p; const i = a ? p.children.indexOf(a) : -1; if (i < 0) p.children.push(c); else p.children.splice(i, 0, c) },
    remove(c) { c.parent?.children.splice(c.parent.children.indexOf(c), 1); c.parent = null }, parentNode: n => n.parent, nextSibling: n => n.parent?.children[n.parent.children.indexOf(n) + 1] ?? null })
  const root = node('root'), props = vue.reactive(initial), events: Record<string, unknown[][]> = {}
  const listeners = Object.fromEntries(['Select', 'Remove', 'Retry', 'LoadMore', 'More', 'Roon', 'Artist', 'Album'].map(key => [`on${key}`, (...args: unknown[]) => (events[key] ??= []).push(args)]))
  const app = renderer.createApp({ render: () => vue.h(component.exports.default, { ...props, ...listeners }) }); app.config.warnHandler = () => {}; app.mount(root); t.after(() => app.unmount()); await vue.nextTick(); await turn()
  const flatten = (n: Host): Host[] => [n, ...n.children.flatMap(flatten)]
  return { props, events, focusHistory, nodes: () => flatten(root), flush: async () => { await vue.nextTick(); await turn(); await vue.nextTick() } }
}
const items = (count: number, kind: 'album' | 'artist' = 'album') => Array.from({ length: count }, (_, i) => ({ reference: `ref-${i}`, kind, title: `合成条目${i}` }))
for (const name of ['RoonAlbumGrid', 'RoonEntityGrid'] as const) test(`007 RED/GREEN mounted ${name}：5000条目只挂窗口且选择仍是原条目`, async t => {
  const page = { items: items(5000), offset: 0, limit: 24, hasMore: false }
  const h = await mountGrid(t, name, { page, entityLabel: '艺术家', emptyTitle: '空', emptyCopy: '空' })
  const cards = h.nodes().filter(n => n.props.class === 'roon-album-card'); assert.ok(cards.length > 0 && cards.length <= 64, `实际挂载${cards.length}卡片`)
  ;(cards[0]!.props.onClick as () => void)(); assert.equal((h.events.Select?.[0]?.[0] as { reference: string }).reference, page.items[0]!.reference)
})
for (const mode of ['albums', 'artists'] as const) test(`007 RED/GREEN mounted expanded ${mode}：5000条目只挂窗口，不改变来源事件`, async t => {
  const h = await mountGrid(t, 'SearchEntities', { mode, artists: [], albums: [], roonArtists: mode === 'artists' ? items(5000, 'artist') : [], roonAlbums: mode === 'albums' ? items(5000) : [], artistsLoading: false, albumsLoading: false, roonLoading: false, artistsError: null, albumsError: null, roonError: null, moreRoonAlbums: false, moreRoonArtists: false, moreAlbums: false, moreArtists: false })
  const cards = h.nodes().filter(n => typeof n.props.class === 'string' && n.props.class.includes(mode === 'albums' ? 'search-album-card' : 'unified-artist')); assert.ok(cards.length > 0 && cards.length <= 64, `实际挂载${cards.length}卡片`)
})
test('007 RED/GREEN mounted 收藏：5000记录只解析窗口，scope变更旧引用不可打开', async t => {
  let calls = 0
  const records: FavoriteRecord[] = Array.from({ length: 5000 }, (_, i) => ({ favoriteId: `fav-${i}`, kind: 'album', title: `合成收藏${i}`, createdAt: 1, updatedAt: 1 }))
  const h = await mountGrid(t, 'FavoriteEntityGrid', { page: { items: records, offset: 0, limit: 24, total: records.length, hasMore: false }, kind: 'album', scopeKey: 'scope-a' }, {
    searchRoonLibrary: async (query: string, page: object) => { calls++; if (calls === 65) return new Promise<never>(() => {}); return { ...page, items: [{ reference: `ref-${calls}`, kind: 'album', title: query }], hasMore: false } },
  })
  assert.ok(calls > 0 && calls <= 64, `实际解析${calls}收藏`)
  const cards = h.nodes().filter(n => n.props.class === 'favorite-entity-card'); assert.ok(cards.length <= 64)
  const first = h.nodes().find(n => n.props.class === 'favorite-open')!; (first.props.onClick as () => void)(); const before = (h.events.Select?.[0]?.[0] as { reference: string }).reference
  h.props.scopeKey = 'scope-b'; await h.flush(); (h.nodes().find(n => n.props.class === 'favorite-open')!.props.onClick as () => void)()
  assert.notEqual((h.events.Select?.[1]?.[0] as { reference: string }).reference, before)
})

for (const name of ['RoonAlbumGrid', 'RoonEntityGrid'] as const) test(`007 mounted keyboard ${name}：卡片选择button Tab跨窗口不丢下一逻辑index`, async t => {
  const h = await mountGrid(t, name, { page: { items: items(5000), offset: 0, limit: 24, hasMore: false }, entityLabel: '艺人', emptyTitle: '空', emptyCopy: '空' })
  const grid = h.nodes().find(n => n.props['data-grid-window'] === 'true')!, cards = h.nodes().filter(n => n.dataset.gridIndex !== undefined), lastCard = cards.at(-1)!, last = lastCard.querySelectorAll('button:not(:disabled)').at(-1)!
  let prevented = false
  ;(grid.props.onKeydown as (event: unknown) => void)({ key: 'Tab', shiftKey: false, target: last, preventDefault() { prevented = true } })
  await h.flush(); assert.equal(prevented, true); assert.equal(h.focusHistory.at(-1), Number(lastCard.dataset.gridIndex) + 1)
  const mounted = h.nodes().filter(n => n.dataset.gridIndex !== undefined); assert.ok(mounted.length <= 64)
})
for (const count of [50, 500, 5000]) test(`007 mounted 结构观测 ${count}：五网格与收藏调用/纯值池只随初始窗口`, async t => {
  const album = await mountGrid(t, 'RoonAlbumGrid', { page: { items: items(count), offset: 0, limit: 24, hasMore: false } })
  const playlist = await mountGrid(t, 'NeteasePlaylistGrid', { playlists: Array.from({ length: count }, (_, i) => ({ id: String(i), name: `歌单${i}`, trackCount: 1 })) })
  let calls = 0
  const favorite = await mountGrid(t, 'FavoriteEntityGrid', { page: { items: Array.from({ length: count }, (_, i) => ({ favoriteId: String(i), kind: 'album', title: `收藏${i}`, createdAt: 1, updatedAt: 1 })), offset: 0, limit: 24, total: count, hasMore: false }, kind: 'album', scopeKey: 'measure' }, { searchRoonLibrary: async (query: string, page: object) => { calls++; return { ...page, items: [{ reference: `ref${calls}`, kind: 'album', title: query }], hasMore: false } } })
  const counts = [album, playlist, favorite].map(h => h.nodes().filter(n => n.dataset.gridIndex !== undefined).length)
  assert.ok(counts.every(value => value > 0 && value <= 64)); assert.ok(calls <= 64)
  const pool = favorite.nodes().find(n => n.props['data-favorite-pool-entries'] !== undefined)!
  assert.ok(Number(pool.props['data-favorite-pool-entries']) <= 128); assert.ok(Number(pool.props['data-favorite-pool-bytes']) <= 2 * 1024 * 1024)
  t.diagnostic(JSON.stringify({ count, albumDOM: counts[0], playlistDOM: counts[1], favoriteDOM: counts[2], resolveCalls: calls, poolEntries: pool.props['data-favorite-pool-entries'], poolBytes: pool.props['data-favorite-pool-bytes'], evidence: '受控mounted结构，非Browser几何/RSS' }))
})

for (const name of ['RoonAlbumGrid', 'RoonEntityGrid', 'SearchEntities', 'FavoriteEntityGrid'] as const) test(`007 mounted ${name} 封面显式重试button不嵌套/不选曲/只调用一次`, async t => {
  let retries = 0; const publishers: ((action: (() => void) | undefined) => void)[] = []
  const api = { __testArtwork: (_props: object, publish: (action: (() => void) | undefined) => void) => { publishers.push(publish); publish(() => { retries++ }) }, searchRoonLibrary: async (query: string, page: object) => ({ ...page, items: [{ reference: 'resolved', artworkReference: 'art', kind: 'album', title: query }], hasMore: false }) }
  const page = { items: items(2).map(item => ({ ...item, artworkReference: 'art' })), offset: 0, limit: 24, hasMore: false }
  const props = name === 'SearchEntities' ? { mode: 'albums', artists: [], albums: [], roonArtists: [], roonAlbums: page.items } : name === 'FavoriteEntityGrid' ? { page: { ...page, total: 2, items: page.items.map((item, i) => ({ favoriteId: String(i), kind: 'album', title: item.title, createdAt: 1, updatedAt: 1 })) }, kind: 'album', scopeKey: 'retry' } : { page, entityLabel: '艺人', emptyTitle: '空', emptyCopy: '空' }
  const h = await mountGrid(t, name, props, api); await h.flush()
  const buttons = h.nodes().filter(n => n.tag === 'button'); assert.ok(buttons.every(n => !n.parent?.closest('button')), '不得嵌套button')
  const retry = buttons.find(n => n.props['aria-label'] === '重试读取封面')!; assert.ok(retry)
  let stopped = 0; const click = retry.props.onClick as (event: unknown) => void
  const event = { preventDefault() {}, stopPropagation() { stopped++ } }; click(event); click(event); await h.flush()
  assert.equal(retries, 1); assert.equal(stopped, 2); assert.equal(h.events.Select?.length ?? 0, 0); assert.equal(h.events.Roon?.length ?? 0, 0)
  publishers.forEach(publish => publish(undefined)); await h.flush(); assert.equal(h.nodes().some(n => n.props['aria-label'] === '重试读取封面'), false)
})
