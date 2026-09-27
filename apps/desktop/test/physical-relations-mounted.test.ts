import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

const release = { id: '10000000-0000-4000-8000-000000000001', kind: 'cd', title: '合成实体', artist: '合成艺人', quantity: 1, revision: 1 }
const digitalId = '20000000-0000-4000-8000-000000000001'
const album = { id: digitalId, revision: 1, metadata: { title: '合成数字版', artist: '合成艺人', year: 2026, version: '测试版' }, physicalAbsenceConfirmed: false }
const link = { id: '30000000-0000-4000-8000-000000000001', revision: 1, relation: 'exact', ripFromCdConfirmed: false }
const page = (offset: number) => ({ items: [{ reference: 'roon:track:' + offset, title: offset ? '合成第21首' : '合成第1首', artist: '合成艺人' }],
  offset, limit: 20, total: 21, hasMore: offset === 0 })

async function mounted(t: test.TestContext) {
  const { parse, compileScript } = await import('@vue/compiler-sfc')
  const ts = (await import('typescript')).default, require = createRequire(import.meta.url), vue = require('vue') as typeof import('vue')
  const filename = new URL('../src/renderer/src/components/collection/PhysicalRelations.vue', import.meta.url)
  const { descriptor, errors } = parse(await readFile(filename, 'utf8'), { filename: 'PhysicalRelations.vue' })
  assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: 'physical-relations-mounted', inlineTemplate: true })
  const historyFence = await import('../src/renderer/src/components/collection/physical-link-history-fence.js')
  const requestFence = await import('../src/renderer/src/components/collection/physical-relation-request-fence.js')
  type TrackPage = ReturnType<typeof page>
  let runtimeReference = 'roon:album:original', coreListener: ((event: unknown) => void) | undefined
  let trackResponse: (reference: string, offset: number) => Promise<TrackPage> = async (_reference, offset) => page(offset)
  const trackCalls: { reference: string; offset: number }[] = []
  const api = {
    onCoreEvent(listener: (event: unknown) => void) { coreListener = listener; return () => { coreListener = undefined } },
    async getPhysicalLinks() { return { releaseId: release.id, revision: 1, links: [{ link, album }], digitalAbsenceConfirmed: false } },
    async getPhysicalLinkHistory() { return { items: [], offset: 0, limit: 20, total: 0, hasMore: false } },
    async getDigitalAlbum() { return { album, links: [{ link, release }] } },
    async getDigitalRuntime() { return { status: 'available' as const, reference: runtimeReference } },
    getRoonAlbumTracks(reference: string, request: { offset: number }) {
      trackCalls.push({ reference, offset: request.offset })
      return trackResponse(reference, request.offset)
    },
  }
  const compiled = ts.transpileModule(script.content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const component = { exports: {} as { default: import('vue').Component } }
  const load = (name: string) => name === 'vue' ? vue
    : name === './physical-link-history-fence' ? historyFence
    : name === './physical-relation-request-fence' ? requestFence
    : name === './RoonAlbumPicker.vue' ? { default: { render: () => null } }
    : require(name)
  new Function('require', 'module', 'exports', 'window', compiled)(load, component, component.exports, { musicBridge: api })
  interface Host { tag: string; text: string; children: Host[]; parent: Host | null; props: Record<string, unknown> }
  const node = (tag = ''): Host => ({ tag, text: '', children: [], parent: null, props: {} })
  const renderer = vue.createRenderer<Host, Host>({
    createElement: node, createText(value) { const result = node('#text'); result.text = value; return result }, createComment: () => node('#comment'),
    setText(target, value) { target.text = value }, setElementText(target, value) { target.text = value; target.children = [] },
    patchProp(target, key, _old, value) { target.props[key] = value },
    insert(child, parent, anchor) {
      if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1)
      child.parent = parent
      const index = anchor ? parent.children.indexOf(anchor) : -1
      if (index < 0) parent.children.push(child)
      else parent.children.splice(index, 0, child)
    },
    remove(child) { child.parent?.children.splice(child.parent.children.indexOf(child), 1); child.parent = null },
    parentNode: target => target.parent,
    nextSibling: target => target.parent?.children[(target.parent?.children.indexOf(target) ?? -1) + 1] ?? null,
  })
  const root = node('root'), app = renderer.createApp(component.exports.default, { release })
  app.mount(root)
  t.after(() => app.unmount())
  const tick = async () => { await new Promise<void>(resolve => setImmediate(resolve)); await vue.nextTick() }
  const all = (current = root): Host[] => [current, ...current.children.flatMap(child => all(child))]
  const text = (current = root): string => current.text + current.children.map(child => text(child)).join(' ')
  async function click(label: string) {
    const button = all().find(current => current.tag === 'button' && text(current).trim() === label)
    assert.ok(button, '缺少可操作按钮：' + label)
    void (button.props.onClick as () => unknown)()
    await tick()
  }
  function core(roon: 'ready' | 'disconnected') {
    assert.ok(coreListener, '组件须订阅 Core 事件')
    coreListener({ event: 'roon.changed', payload: { state: { runtime: 'ready', roon } } })
  }
  await tick()
  return { all, text, click, core, tick, trackCalls,
    setRuntimeReference(value: string) { runtimeReference = value },
    setTrackResponse(value: (reference: string, offset: number) => Promise<TrackPage>) { trackResponse = value } }
}

test('挂载的实体关系页：同 reference 在线更新保留第 2 页，真正导航回实物才清空曲目', async t => {
  const view = await mounted(t)
  await view.click('查看数字关联详情')
  await view.click('查看 Roon 曲目 / 试听')
  await view.click('下一页')
  assert.match(view.text(), /合成第21首/u)
  assert.deepEqual(view.trackCalls.map(call => call.offset), [0, 20])

  view.core('ready')
  await view.tick()
  assert.match(view.text(), /合成第21首/u, '播放或 Zone 更新不能清掉同一专辑的当前分页')
  assert.deepEqual(view.trackCalls.map(call => call.offset), [0, 20], '普通事件不应重取曲目第一页')

  await view.click('查看关联实物')
  assert.equal(view.all().some(current => current.tag === 'section' && current.props['aria-label'] === '关联专辑曲目'), false)
  await view.click('查看数字关联详情')
  assert.doesNotMatch(view.text(), /合成第21首/u, '重新进入数字详情需要显式查看曲目')
})

test('挂载的实体关系页：reference 真变化与离线使曲目失效，离线前迟到页不回填', async t => {
  const view = await mounted(t)
  await view.click('查看数字关联详情')
  await view.click('查看 Roon 曲目 / 试听')
  assert.match(view.text(), /合成第1首/u)

  view.setRuntimeReference('roon:album:relocated')
  view.core('ready')
  await view.tick()
  assert.doesNotMatch(view.text(), /合成第1首/u, '真实 reference 更换不能沿用旧曲目')

  const late = deferred<ReturnType<typeof page>>()
  view.setTrackResponse(async () => late.promise)
  await view.click('查看 Roon 曲目 / 试听')
  assert.deepEqual(view.trackCalls.at(-1), { reference: 'roon:album:relocated', offset: 0 })
  view.core('disconnected')
  await view.tick()
  late.resolve(page(0))
  await view.tick()
  assert.match(view.text(), /当前 Roon 不可用，收藏关系已保留/u)
  assert.doesNotMatch(view.text(), /合成第1首/u, '离线前的迟到曲目不能回填')
  assert.equal(view.all().some(current => current.tag === 'section' && current.props['aria-label'] === '关联专辑曲目'), false)
})
