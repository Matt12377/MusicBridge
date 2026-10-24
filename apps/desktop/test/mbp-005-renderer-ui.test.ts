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

import type { MusicBridgePublicApi } from '../src/preload/api.js'
import type { PageRequest } from '@music-bridge/contracts'
import { createCatalogDataAdapter } from '../src/renderer/src/composables/catalog/catalog-data-adapter.js'
import { useCatalogExperience } from '../src/renderer/src/composables/catalog/useCatalogExperience.js'
import { neteaseAlbumItem } from '../src/renderer/src/composables/catalog/catalog-presentation.js'
import { mountVueSfc } from './support/mbf-vue-host.js'
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
const album = neteaseAlbumItem({ id: 'album-a', name: '合成专辑', artistName: '合成艺人', trackCount: 2 })
type AlbumReply = Awaited<ReturnType<MusicBridgePublicApi['getAlbum']>>
function albumReply(title: string, page: PageRequest, hasMore = false): AlbumReply {
  return { id: 'album-a', name: '合成专辑', artistName: '合成艺人', trackCount: hasMore || page.offset ? 2 : 1,
    tracks: { ...page, total: hasMore || page.offset ? 2 : 1, hasMore, items: [{ id: `track-${page.offset}`, title, artists: ['合成艺人'], album: '合成专辑' }] } }
}
function catalogDetail(t: test.TestContext, getAlbum: MusicBridgePublicApi['getAlbum']) {
  const data = createCatalogDataAdapter({ getAlbum } as unknown as MusicBridgePublicApi, () => undefined)
  const model = useCatalogExperience(data.port)
  t.after(() => { model.dispose(); data.dispose() })
  return model
}
async function mountedSearchDetail(t: test.TestContext, model: ReturnType<typeof useCatalogExperience>) {
  const { parse } = await import('@vue/compiler-sfc')
  const { descriptor } = parse(await readFile(new URL('../src/renderer/src/App.vue', import.meta.url), 'utf8'))
  // 跟随实际App当前的搜索详情入口；模型、目录组件及歌曲表格均使用产品实现。
  const workspace = descriptor.template!.content.match(/<CatalogWorkspace\b[^>]*\bmode="search"[^>]*\/>/u)?.[0]
  assert.ok(workspace, '实际App须以目录工作区承载搜索详情'); assert.match(workspace, /:model="catalog"/u)
  return mountVueSfc(t, new URL('../src/renderer/src/components/catalog/CatalogWorkspace.vue', import.meta.url).pathname, { model, mode: 'search' })
}
function trackTitles(ui: Awaited<ReturnType<typeof mountedSearchDetail>>): string[] {
  return ui.all().filter(node => String(node.props.class).split(' ').includes('track-row')).map(row => row.querySelector('strong')?.text ?? '')
}
for (const phase of ['pending', 'failed'] as const) test(`MBP005 R1 mounted：实际App搜索详情${phase}刷新保留已有歌曲与有效重试`, async t => {
  const requests: PageRequest[] = []; let reject!: (error: Error) => void
  const pending = new Promise<never>((_done, fail) => { reject = fail })
  const model = catalogDetail(t, async (id, page) => {
    assert.equal(id, 'album-a'); assert.ok(page); requests.push({ ...page })
    if (requests.length === 2) return pending
    return albumReply(requests.length > 2 ? '重试新歌曲' : '已加载歌曲', page)
  })
  await model.openDetail(album)
  const refresh = model.readDetailSection('tracks'), ui = await mountedSearchDetail(t, model)
  assert.equal(model.detail.value?.tracks.hasMore, false, '完整已加载页也必须显示刷新状态与失败重试')
  if (phase === 'pending') {
    try {
      assert.deepEqual(trackTitles(ui), ['已加载歌曲']); assert.equal(model.detail.value?.tracks.loading, true); assert.match(ui.text(), /正在刷新.*保留已加载歌曲/u)
      await model.readDetailSection('tracks', true); assert.equal(requests.length, 2, '刷新首页在途时保持可见歌曲，但不能并发拼接旧尾页')
    } finally { reject(new Error('合成失败')); await refresh }
  } else {
    reject(new Error('合成失败')); await refresh; await ui.settle()
    assert.deepEqual(trackTitles(ui), ['已加载歌曲']); assert.match(ui.text(), /保留已加载歌曲/u)
    const retry = ui.all().find(node => node.type === 'button' && ui.text(node) === '重新读取'); assert.ok(retry)
    await ui.dispatch(retry, 'onClick')
    assert.equal(requests.length, 3); assert.deepEqual(requests.map(page => page.offset), [0, 0, 0]); assert.deepEqual(trackTitles(ui), ['重试新歌曲']); assert.doesNotMatch(ui.text(), /刷新失败/u)
  }
  assert.ok(requests.every(page => page.limit === 24), '保持实际目录页大小，不以缩页改变刷新合同')
})

test('MBP005 mounted：详情首页刷新失败不变成旧尾页追加，实际重试重新读取首页', async t => {
  const requests: PageRequest[] = []
  const model = catalogDetail(t, async (_id, page) => {
    assert.ok(page); requests.push({ ...page })
    if (requests.length === 2) throw new Error('合成首页刷新失败')
    return albumReply(requests.length > 2 ? '重试后的首页' : '原首页歌曲', page, true)
  })
  await model.openDetail(album); const ui = await mountedSearchDetail(t, model)
  await model.readDetailSection('tracks'); await ui.settle()
  assert.deepEqual(trackTitles(ui), ['原首页歌曲']); assert.match(ui.text(), /刷新失败.*保留已加载歌曲/u)
  assert.equal(ui.all().some(node => node.type === 'button' && ui.text(node) === '加载更多歌曲'), false)
  await model.readDetailSection('tracks', true); assert.equal(requests.length, 2, '失败首页尚未恢复时不能把旧游标用于追加')
  await ui.dispatch(ui.all().find(node => node.type === 'button' && ui.text(node) === '重新读取'), 'onClick')
  assert.deepEqual(requests.map(page => page.offset), [0, 0, 0]); assert.deepEqual(trackTitles(ui), ['重试后的首页'])
  assert.ok(ui.all().some(node => node.type === 'button' && ui.text(node) === '加载更多歌曲'), '首页恢复成功后才恢复当前续页入口')
})

test('MBP005 mounted：详情尾页失败保留首页，实际重试沿原续页游标追加而不刷新首页', async t => {
  const requests: PageRequest[] = []; let reject!: (error: Error) => void
  const pending = new Promise<never>((_done, fail) => { reject = fail })
  const model = catalogDetail(t, async (_id, page) => {
    assert.ok(page); requests.push({ ...page })
    if (requests.length === 2) return pending
    return albumReply(page.offset ? '续页歌曲' : '已加载歌曲', page, page.offset === 0)
  })
  await model.openDetail(album); const ui = await mountedSearchDetail(t, model)
  const more = model.readDetailSection('tracks', true); await ui.settle()
  try {
    assert.deepEqual(trackTitles(ui), ['已加载歌曲']); assert.match(ui.text(), /正在加载更多/u)
    await model.readDetailSection('tracks', true); assert.equal(requests.length, 2, '追加在途也不能并发请求同一尾页')
  } finally { reject(new Error('合成尾页失败')); await more }
  await ui.settle()
  assert.deepEqual(trackTitles(ui), ['已加载歌曲']); assert.match(ui.text(), /这个来源暂时不可用/u); assert.doesNotMatch(ui.text(), /刷新失败/u)
  await ui.dispatch(ui.all().find(node => node.type === 'button' && ui.text(node) === '重试'), 'onClick')
  assert.deepEqual(requests.map(page => page.offset), [0, 1, 1]); assert.deepEqual(trackTitles(ui), ['已加载歌曲', '续页歌曲']); assert.doesNotMatch(ui.text(), /这个来源暂时不可用/u)
})

for (const append of [false, true]) test(`MBP005：详情${append ? '追加' : '刷新'}在途返回后恢复同一请求，迟到旧页不覆盖`, async t => {
  const requests: PageRequest[] = []; let resolve!: (value: AlbumReply) => void
  const pending = new Promise<AlbumReply>(done => { resolve = done })
  const model = catalogDetail(t, async (_id, page) => {
    assert.ok(page); requests.push({ ...page })
    if (requests.length === 2) return pending
    return albumReply(requests.length === 1 ? '原首页歌曲' : '恢复后的歌曲', page, page.offset === 0)
  })
  await model.openDetail(album)
  const ui = await mountedSearchDetail(t, model), read = model.readDetailSection('tracks', append)
  await turn(); assert.equal(requests.length, 2)
  const location = model.captureReturnLocation('search'); model.closeDetail(); assert.equal(location.restore(), true)
  await ui.settle(); await read
  resolve(albumReply('不得覆盖的迟到歌曲', requests[1]!, append ? false : true)); await ui.settle()
  assert.deepEqual(requests.map(page => page.offset), [0, append ? 1 : 0, append ? 1 : 0])
  assert.deepEqual(trackTitles(ui), append ? ['原首页歌曲', '恢复后的歌曲'] : ['恢复后的歌曲']); assert.doesNotMatch(ui.text(), /不得覆盖/u)
})
