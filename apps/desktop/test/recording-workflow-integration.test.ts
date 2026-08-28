import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import type { MasterDraft, DraftSourceSnapshot } from '@music-bridge/contracts'

const firstId = '11111111-1111-4111-8111-111111111111', secondId = '22222222-2222-4222-8222-222222222222'
const trackId = '33333333-3333-4333-8333-333333333333'
function draft(id: string): MasterDraft {
  return { id, title: '合成草稿', revision: 1, status: 'draft', programType: 'compilation', trackCount: 1, estimatedDurationMs: 1000, sourceLockEligible: false, tracks: [{ id: trackId, source: 'roon', metadata: { title: '合成曲目', durationMs: 1000 } }] }
}
const sources = (id: string): DraftSourceSnapshot => ({ draftId: id, sourceLockEligible: false, tracks: [{ trackId, jobs: [] }] })
function apiFixture() {
  const calls: string[] = []
  return { calls, api: {
    async listMasterDrafts() { return { items: [], total: 0, offset: 0, limit: 12, hasMore: false } },
    async getMasterDraft(id: string) { return draft(id) },
    async getDraftSources(id: string) { calls.push('sources:' + id); return sources(id) },
    async listMediaPlans(id: string) { calls.push('plans:' + id); return { draftId: id, plans: [] } },
    async listMasterVersions(id: string) { calls.push('versions:' + id); return { draftId: id, masters: [], layouts: [], jobs: [] } },
    async listPreparations(id: string) { calls.push('preparations:' + id); return { draftId: id, workspaces: [], jobs: [] } },
    async listPrepared(id: string) { calls.push('prepared:' + id); return { draftId: id, preps: [], jobs: [] } },
    async listExecutionAssets(id: string) { calls.push('execution:' + id); return { draftId: id, assets: [], jobs: [] } },
  } }
}
async function mounted(t: test.TestContext, api: unknown, document = focusDocument()) {
  const { parse, compileScript } = await import('@vue/compiler-sfc'), ts = (await import('typescript')).default
  const require = createRequire(import.meta.url), vue = require('vue') as typeof import('vue')
  const { descriptor, errors } = parse(await readFile(new URL('../src/renderer/src/components/recording/RecordingView.vue', import.meta.url), 'utf8'))
  assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: 'recording-workflow-integration' })
  const modules: Record<string, unknown> = {}
  for (const name of ['recording-workflow-controller', 'recording-next-step']) {
    try { modules[name] = await import(new URL('../src/renderer/src/components/recording/' + name + '.ts', import.meta.url).href) } catch { /* 旧候选未实现时，由行为断言报告RED。 */ }
  }
  const load = (name: string) => name === 'vue' ? vue : name.endsWith('.vue') ? { default: { render: () => null } } : modules[name.replace('./', '')] ?? require(name)
  const module = { exports: {} as { default: import('vue').Component } }
  const code = ts.transpileModule(script.content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  new Function('require', 'module', 'exports', 'window', 'document', code)(load, module, module.exports, { musicBridge: api }, document)
  interface Host { parent: Host | null; children: Host[] }
  const node = (): Host => ({ parent: null, children: [] })
  const renderer = vue.createRenderer<Host, Host>({ createElement: node, createText: node, createComment: node, setText() {}, setElementText() {}, patchProp() {}, insert(child, parent) { child.parent = parent; parent.children.push(child) }, remove() {}, parentNode: item => item.parent, nextSibling: () => null })
  const app = renderer.createApp({ ...module.exports.default, render: () => null }), instance = app.mount(node())
  t.after(() => app.unmount()); await new Promise<void>(resolve => setImmediate(resolve))
  const setup = (instance.$ as unknown as { setupState: Record<string, unknown> }).setupState
  const invoke = async (name: string, ...args: unknown[]) => { assert.equal(typeof setup[name], 'function', name); await (setup[name] as (...args: unknown[]) => unknown)(...args); await vue.nextTick() }
  return { setup, invoke }
}

test('录音页打开草稿一次读取六类当前事实，源标签与下一步共享同一代际', async t => {
  const f = apiFixture(), view = await mounted(t, f.api)
  await view.invoke('open', firstId)
  assert.deepEqual(f.calls.sort(), ['sources', 'plans', 'versions', 'preparations', 'prepared', 'execution'].map(name => name + ':' + firstId).sort())
  assert.equal((view.setup.sourceSnapshot as DraftSourceSnapshot).draftId, firstId)
  assert.equal((view.setup.nextStep as { action: { type: string } }).action.type, 'source')
})

test('关闭源面板的迟到读取不能覆盖后来打开的另一草稿', async t => {
  const f = apiFixture(), view = await mounted(t, f.api); await view.invoke('open', firstId)
  let resolve!: (value: DraftSourceSnapshot) => void
  f.api.getDraftSources = async id => id === firstId ? new Promise(done => { resolve = done }) : sources(id)
  const closing = view.invoke('closeSources'); await new Promise<void>(done => setImmediate(done))
  await view.invoke('open', secondId); resolve(sources(firstId)); await closing
  assert.equal((view.setup.draft as MasterDraft).id, secondId)
  assert.equal((view.setup.sourceSnapshot as DraftSourceSnapshot).draftId, secondId)
})

test('读取失败不继续展示旧源资格，工作库激活清空临时上下文', async t => {
  const f = apiFixture(), view = await mounted(t, f.api); await view.invoke('open', firstId)
  f.api.getDraftSources = async () => { throw new Error('合成读取失败') }
  await view.invoke('closeSources')
  assert.equal(view.setup.sourceSnapshot, undefined)
  assert.equal((view.setup.nextStep as { action: { type: string } }).action.type, 'refresh')
  await view.invoke('activatedDataset')
  assert.equal(view.setup.draft, undefined); assert.equal(view.setup.sourceSnapshot, undefined)
})

test('主下一步遵守草稿必填校验，空标题不能显示可执行保存', async t => {
  const f = apiFixture(), view = await mounted(t, f.api); await view.invoke('open', firstId)
  view.setup.title = '   '
  const next = view.setup.nextStep as { action: { type: string }; disabled: boolean }
  assert.equal(next.action.type, 'save-draft'); assert.equal(next.disabled, true)
})

test('下一步向三个工具传递明确上下文，手动工具入口清除上次初始选择', async t => {
  const f = apiFixture(), view = await mounted(t, f.api); await view.invoke('open', firstId)
  await view.invoke('nextAction', { type: 'media' }); assert.equal(view.setup.initialMediaPlanId, undefined)
  const state = view.setup.workflowState as { selection: Record<string, string> }
  state.selection = { planId: 'selected-plan', layoutId: 'selected-layout', path: 'prep', preparedId: 'selected-prep' }
  await view.invoke('nextAction', { type: 'media' }); assert.equal(view.setup.initialMediaPlanId, 'selected-plan')
  await view.invoke('nextAction', { type: 'versions' }); assert.equal(view.setup.initialVersionPlanId, 'selected-plan')
  await view.invoke('nextAction', { type: 'execution' }); assert.deepEqual(view.setup.initialExecutionContext, { layoutId: 'selected-layout', mode: 'prepared-reference', preparedId: 'selected-prep' })
  await view.invoke('openMediaPlanning'); await view.invoke('openMasterVersions'); await view.invoke('openExecution')
  assert.equal(view.setup.initialMediaPlanId, undefined); assert.equal(view.setup.initialVersionPlanId, undefined); assert.equal(view.setup.initialExecutionContext, undefined)
})

test('每次事实刷新向子组件提供新状态引用，使上下文选项随只读状态更新', async t => {
  const f = apiFixture(), view = await mounted(t, f.api); await view.invoke('open', firstId)
  const firstState = view.setup.workflowState
  await view.invoke('closeSources')
  assert.notStrictEqual(view.setup.workflowState, firstState)
  assert.equal((view.setup.workflowState as { status: string }).status, 'ready')
})

function focusDocument() {
  const listeners = new Map<string, Set<() => void>>()
  const body = { isConnected: true, focus() {} }
  const document = { body, activeElement: body,
    addEventListener(type: string, listener: () => void) { const set = listeners.get(type) ?? new Set(); set.add(listener); listeners.set(type, set) },
    removeEventListener(type: string, listener: () => void) { listeners.get(type)?.delete(listener) },
    interact(type: string) { for (const listener of listeners.get(type) ?? []) listener() },
    element() { return { isConnected: true, focus() { document.activeElement = this } } },
  }
  return document
}

test('五个工具关闭后返回本次实际触发按钮，保留下一步和旧工具两种入口', async t => {
  const doc = focusDocument(), f = apiFixture(), view = await mounted(t, f.api, doc); await view.invoke('open', firstId)
  for (const name of ['Execution', 'Preparation', 'Prepared', 'MediaPlanning', 'MasterVersions']) {
    const primary = doc.element(), legacy = doc.element(); view.setup[name.toLowerCase() + 'Trigger'] = legacy
    for (const trigger of [primary, legacy]) {
      doc.activeElement = trigger; await view.invoke('open' + name); doc.activeElement = doc.body
      await view.invoke('close' + name); assert.strictEqual(doc.activeElement, trigger, name)
    }
  }
})

test('关闭后的迟到事实读取不抢走用户焦点，也不覆盖切草稿后的焦点', async t => {
  for (const scenario of ['other-focus', 'keyboard', 'new-draft']) {
    const doc = focusDocument(), f = apiFixture(), view = await mounted(t, f.api, doc); await view.invoke('open', firstId)
    const primary = doc.element(), legacy = doc.element(), other = doc.element()
    view.setup.executionTrigger = legacy; doc.activeElement = primary; await view.invoke('openExecution'); doc.activeElement = doc.body
    let resolve!: (value: DraftSourceSnapshot) => void
    f.api.getDraftSources = async id => id === firstId ? new Promise(done => { resolve = done }) : sources(id)
    const closing = view.invoke('closeExecution'); await new Promise<void>(done => setImmediate(done))
    if (scenario === 'other-focus') doc.activeElement = other
    if (scenario === 'keyboard') doc.interact('keydown')
    if (scenario === 'new-draft') await view.invoke('open', secondId)
    resolve(sources(firstId)); await closing
    assert.strictEqual(doc.activeElement, scenario === 'other-focus' ? other : doc.body, scenario)
  }
})


test('计划与预检只接显式工作上下文，手动入口清空上下文，激活工作库关闭面板', async t => {
  const f = apiFixture(), view = await mounted(t, f.api); await view.invoke('open', firstId)
  const state = view.setup.workflowState as { selection: Record<string, string> }
  state.selection = { layoutId: 'explicit-layout', path: 'prep', preparedId: 'explicit-prep' }
  await view.invoke('nextAction', { type: 'recording-plan' })
  assert.deepEqual(view.setup.initialRecordingPlanContext, { layoutId: 'explicit-layout', mode: 'prepared-reference', preparedId: 'explicit-prep' })
  assert.equal(view.setup.recordingPlan, true)
  await view.invoke('openRecordingPlan'); assert.equal(view.setup.initialRecordingPlanContext, undefined)
  await view.invoke('activatedDataset'); assert.equal(view.setup.recordingPlan, false)
})

test('计划面板关闭归还本次实际触发焦点，迟到刷新不抢用户焦点', async t => {
  const doc = focusDocument(), f = apiFixture(), view = await mounted(t, f.api, doc); await view.invoke('open', firstId)
  const trigger = doc.element(); doc.activeElement = trigger; await view.invoke('openRecordingPlan'); doc.activeElement = doc.body
  await view.invoke('closeRecordingPlan'); assert.strictEqual(doc.activeElement, trigger)
  doc.activeElement = trigger; await view.invoke('openRecordingPlan'); doc.activeElement = doc.body
  let resolve!: (value: DraftSourceSnapshot) => void
  f.api.getDraftSources = async () => new Promise(done => { resolve = done })
  const closing = view.invoke('closeRecordingPlan'); await new Promise<void>(done => setImmediate(done))
  doc.interact('keydown'); resolve(sources(firstId)); await closing
  assert.strictEqual(doc.activeElement, doc.body)
})
