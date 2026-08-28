import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import type { MasterDraft, MediaLayoutSpec, ExecutionMode } from '@music-bridge/contracts'

const id = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const draft: MasterDraft = { id: id(1), title: '合成上下文草稿', revision: 1, status: 'draft', sourceLockEligible: false, programType: 'compilation', trackCount: 1, tracks: [{ id: id(2), source: 'roon', metadata: { title: '合成曲目', durationMs: 1000 } }] }
const spec: MediaLayoutSpec = { format: 'cassette', splitAfter: 1, leadInMs: 0, tailMs: 0, defaultGapMs: 5000, rules: [], compatibility: { confirmed: false, cassetteTypes: [], dat: false } }
function fixture() {
  const layout = { timebase: 'milliseconds', executionReady: false, sides: [], constraints: [] }
  const plans = [3, 4].map(n => ({ id: id(n), draftId: draft.id, draftRevision: 1, revision: 1, spec: { ...spec, tailMs: n * 1000 }, layout, sourceBasis: 'verified-sources', inputFingerprint: 'a'.repeat(64), requiresReview: false, executionReady: false, reservation: { physicalId: `MB-C-0000${n}`, modelId: id(20), skuId: id(21), packaging: 'opened' } }))
  const versions = { draftId: draft.id, masters: [5, 6].map(n => ({ id: id(n), draftId: draft.id, sequence: n - 4 })), layouts: [7, 8].map((n, index) => ({ id: id(n), draftId: draft.id, masterVersionId: id(index + 5), planId: plans[index]!.id, sequence: index + 1, spec })), jobs: [] }
  const prepared = { draftId: draft.id, preps: [9, 10].map((n, index) => ({ id: id(n), draftId: draft.id, masterVersionId: id(index + 5), layoutVersionId: id(index + 7), preparationId: id(30 + index), sequence: index + 1, conformance: { status: 'MATCHED' } })), jobs: [] }
  const candidates = [22, 23].map(n => ({ skuId: id(n), model: { id: id(n + 2), brand: '合成品牌', name: `合成型号${n}`, edition: '', year: 1990, tapeType: 'II', featuredPhoto: { id: id(n + 4), width: 40, height: 80 }, counts: {}, format: 'cassette' }, lengthMinutes: 90, packaging: 'opened', availableCount: 1, reservableCount: 1, status: 'recommended', reasons: [] }))
  const calls: { name: string; value?: unknown }[] = []
  const api = {
    async listMediaPlans() { calls.push({ name: 'plans' }); return { draftId: draft.id, plans } },
    async getMediaPlan(value: string) { calls.push({ name: 'plan', value }); const plan = plans.find(p => p.id === value); assert.ok(plan); return plan },
    async previewMediaPlan(value: unknown) { calls.push({ name: 'media-preview', value }); return { draftId: draft.id, draftRevision: 1, sourceBasis: 'verified-sources', inputFingerprint: 'a'.repeat(64), layout, candidates: { items: candidates, offset: 0, limit: 12, total: 2, hasMore: false } } },
    async listMasterVersions() { calls.push({ name: 'versions' }); return versions },
    async listPrepared() { calls.push({ name: 'prepared' }); return prepared },
    async listExecutionAssets() { calls.push({ name: 'execution' }); return { draftId: draft.id, assets: [], jobs: [] } },
    async listPreparationDestinations() { calls.push({ name: 'destinations' }); return { destinations: [] } },
    async getCollectionPhoto(value: string) { calls.push({ name: 'photo', value }); if (value === id(26) && calls.filter(call => call.name === 'photo' && call.value === value).length === 1) throw new Error('合成单图失败'); return { dataUrl: 'data:image/png;base64,YQ==', width: 40, height: 80 } },
  }
  return { plans, versions, prepared, candidates, calls, api }
}

async function mounted(t: test.TestContext, name: 'MediaPlanningPanel' | 'MasterVersionsPanel' | 'ExecutionPanel', api: unknown, props: Record<string, unknown> = {}, actualTemplate = false) {
  const { parse, compileScript, compileTemplate } = await import('@vue/compiler-sfc'), ts = (await import('typescript')).default
  const require = createRequire(import.meta.url), vue = require('vue') as typeof import('vue')
  if (actualTemplate) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'document')
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { activeElement: null } })
    t.after(() => { if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document') })
  }
  interface Host { tag: string; text: string; children: Host[]; parent: Host | null; props: Record<string, unknown>; style: Record<string, string>; options: Host[]; addEventListener(): void; removeEventListener(): void; showModal(): void; close(): void }
  const observers: { fire(): void }[] = []
  const window = { musicBridge: api, IntersectionObserver: class {
    target?: Host
    constructor(private callback: (entries: unknown[]) => void) { observers.push(this) }
    observe(target: Host) { this.target = target }
    disconnect() {}
    fire() { this.callback([{ target: this.target, isIntersecting: true }]) }
  } }
  const display = await import('../src/renderer/src/components/collection/collection-display.js')
  const contracts = await import('@music-bridge/contracts')
  const compile = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  async function component(componentName: string, directory: string, render: boolean): Promise<import('vue').Component> {
    const { descriptor, errors } = parse(await readFile(new URL(`../src/renderer/src/components/${directory}/${componentName}.vue`, import.meta.url), 'utf8')); assert.deepEqual(errors, [])
    const script = compileScript(descriptor, { id: 'panel-context-' + componentName })
    const photo = componentName === 'MediaPlanningPanel' && render ? await component('CollectionPhoto', 'collection', true) : undefined
    const load = (dependency: string) => dependency === 'vue' ? vue : dependency === '@music-bridge/contracts' ? contracts : dependency.includes('collection-display') ? display : dependency.endsWith('CollectionPhoto.vue') && photo ? { default: photo } : dependency.endsWith('.vue') ? { default: { render: () => null } } : require(dependency)
    const module = { exports: {} as { default: import('vue').Component } }
    new Function('require', 'module', 'exports', 'window', compile(script.content))(load, module, module.exports, window)
    if (!render) return { ...module.exports.default, render: () => null }
    const template = compileTemplate({ id: 'panel-context-' + componentName, filename: componentName + '.vue', source: descriptor.template!.content, compilerOptions: { bindingMetadata: script.bindings } }); assert.deepEqual(template.errors, [])
    const rendered = { exports: {} as { render: (...args: unknown[]) => unknown } }
    new Function('require', 'module', 'exports', compile(template.code))(load, rendered, rendered.exports)
    return { ...module.exports.default, render: rendered.exports.render }
  }
  function node(tag = ''): Host { return { tag, text: '', children: [], parent: null, props: {}, style: {}, get options() { return this.children.filter(child => child.tag === 'option') }, addEventListener() {}, removeEventListener() {}, showModal() {}, close() {} } }
  const renderer = vue.createRenderer<Host, Host>({ createElement: node, createText(text) { return { ...node('#text'), text } }, createComment: () => node('#comment'),
    setText(node, text) { node.text = text }, setElementText(node, text) { node.text = text; node.children = [] }, patchProp(node, key, _old, value) { node.props[key] = value },
    insert(child, parent, anchor) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; if (index < 0) parent.children.push(child); else parent.children.splice(index, 0, child) },
    remove(child) { child.parent?.children.splice(child.parent.children.indexOf(child), 1); child.parent = null }, parentNode: node => node.parent, nextSibling: node => node.parent?.children[(node.parent?.children.indexOf(node) ?? -1) + 1] ?? null,
  })
  const root = node(), app = renderer.createApp(await component(name, 'recording', actualTemplate), { draft, ...props }), instance = app.mount(root)
  t.after(() => app.unmount())
  const tick = async () => { await new Promise<void>(resolve => setImmediate(resolve)); await vue.nextTick() }
  await tick()
  const setup = (instance.$ as unknown as { setupState: Record<string, unknown> }).setupState
  const invoke = async (key: string, ...args: unknown[]) => { await (setup[key] as (...args: unknown[]) => unknown)(...args); await tick() }
  const all = (current = root): Host[] => [current, ...current.children.flatMap(child => all(child))]
  const text = (current = root): string => current.text + current.children.map(child => text(child)).join(' ')
  return { setup, invoke, tick, observers, all, text }
}

for (const name of ['MediaPlanningPanel', 'MasterVersionsPanel'] as const) {
  test(`${name}保留非首条initialPlanId，不自行选首条或发写命令`, async t => {
    const f = fixture(), panel = await mounted(t, name, f.api, { initialPlanId: id(4) })
    assert.equal(panel.setup.planId, id(4))
    if (name === 'MediaPlanningPanel') { assert.equal((panel.setup.plan as { id: string }).id, id(4)); assert.equal((panel.setup.spec as MediaLayoutSpec).tailMs, 4000); assert.equal(f.calls.find(call => call.name === 'plan')?.value, id(4)) }
    assert.ok(f.calls.every(call => ['plans', 'plan', 'media-preview', 'versions'].includes(call.name)))
  })
  test(`${name}显式空或失效initialPlanId保持空，不fallback；旧入口仍保留默认`, async t => {
    for (const initialPlanId of ['', id(99)]) {
      const f = fixture(), panel = await mounted(t, name, f.api, { initialPlanId })
      assert.equal(panel.setup.planId, '')
      if (initialPlanId) assert.ok(panel.setup.error)
      if (name === 'MediaPlanningPanel') { assert.equal(panel.setup.plan, undefined); assert.equal(f.calls.some(call => call.name === 'plan'), false) }
      await panel.invoke(name === 'MediaPlanningPanel' ? 'load' : 'refresh'); assert.equal(panel.setup.planId, '')
    }
    const f = fixture(), legacy = await mounted(t, name, f.api); assert.equal(legacy.setup.planId, id(3))
  })
  test(`${name}拒绝属于另一草稿的初始规划`, async t => {
    const f = fixture(); f.plans[1]!.draftId = id(99)
    const panel = await mounted(t, name, f.api, { initialPlanId: id(4) }); assert.equal(panel.setup.planId, ''); assert.ok(panel.setup.error)
  })
}

test('ExecutionPanel保留非首条布局与PREP路径，watch下一tick及刷新不清初始PREP', async t => {
  const f = fixture(), initialContext = { layoutId: id(8), mode: 'prepared-reference' as ExecutionMode, preparedId: id(10) }
  const panel = await mounted(t, 'ExecutionPanel', f.api, { initialContext })
  assert.equal(panel.setup.layoutId, id(8)); assert.equal(panel.setup.mode, 'prepared-reference'); assert.equal(panel.setup.preparedId, id(10))
  await panel.tick(); await panel.invoke('refresh'); assert.equal(panel.setup.preparedId, id(10))
  panel.setup.layoutId = id(7); await panel.tick(); assert.equal(panel.setup.preparedId, '')
  await panel.invoke('refresh'); assert.equal(panel.setup.layoutId, id(7)); assert.equal(panel.setup.preparedId, '')
  assert.ok(f.calls.every(call => ['versions', 'prepared', 'execution', 'destinations'].includes(call.name)))
})

test('ExecutionPanel显式无效布局、PREP和跨master谱系不fallback，旧入口仍默认Direct首布局', async t => {
  for (const context of [
    { layoutId: '', mode: 'direct' }, { layoutId: id(99), mode: 'direct' },
    { layoutId: id(8), mode: 'prepared-reference', preparedId: id(9) },
    { layoutId: id(8), mode: 'prepared-reference' },
  ]) {
    const f = fixture(), panel = await mounted(t, 'ExecutionPanel', f.api, { initialContext: context })
    assert.equal(panel.setup.layoutId, ''); assert.equal(panel.setup.preparedId, ''); assert.ok(panel.setup.error)
    await panel.invoke('refresh'); assert.equal(panel.setup.layoutId, '')
  }
  const wrong = fixture(); wrong.prepared.preps[1]!.masterVersionId = id(5)
  const panel = await mounted(t, 'ExecutionPanel', wrong.api, { initialContext: { layoutId: id(8), mode: 'prepared-derivative', preparedId: id(10) } })
  assert.equal(panel.setup.layoutId, ''); assert.equal(panel.setup.preparedId, ''); assert.ok(panel.setup.error)
  const legacy = await mounted(t, 'ExecutionPanel', fixture().api); assert.equal(legacy.setup.layoutId, id(7)); assert.equal(legacy.setup.mode, 'direct')
})

test('实际媒体候选CollectionPhoto失败可安全单图重试，不重算候选/改选/写规划预留', async t => {
  const f = fixture(), panel = await mounted(t, 'MediaPlanningPanel', f.api, {}, true)
  assert.equal(panel.observers.length, 2)
  panel.observers.forEach(observer => observer.fire()); await panel.tick()
  assert.match(panel.text(), /照片读取失败/u)
  const before = JSON.stringify({ plan: panel.setup.plan, selected: panel.setup.selected, spec: panel.setup.spec, preview: panel.setup.preview })
  const readsBefore = f.calls.filter(call => call.name !== 'photo').length
  const retry = panel.all().find(node => node.tag === 'button' && panel.text(node).trim() === '重试此照片')
  assert.ok(retry, '媒体候选图没有大图入口，必须提供可执行的单图重试')
  for (let parent = retry.parent; parent; parent = parent.parent) assert.notEqual(parent.tag, 'button')
  ;(retry.props.onClick as () => void)(); await panel.tick()
  assert.equal(f.calls.filter(call => call.name === 'photo' && call.value === id(26)).length, 2)
  assert.equal(f.calls.filter(call => call.name === 'photo' && call.value === id(27)).length, 1)
  assert.equal(f.calls.filter(call => call.name !== 'photo').length, readsBefore)
  assert.equal(JSON.stringify({ plan: panel.setup.plan, selected: panel.setup.selected, spec: panel.setup.spec, preview: panel.setup.preview }), before)
  assert.equal(panel.all().filter(node => node.tag === 'img').length, 2)
})
