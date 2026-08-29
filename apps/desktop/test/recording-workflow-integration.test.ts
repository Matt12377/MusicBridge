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
async function mounted(t: test.TestContext, api: unknown, document = focusDocument(), options: { actualTemplate?: boolean; appNavigation?: boolean; reload?: () => void } = {}) {
  const { parse, compileScript, compileTemplate } = await import('@vue/compiler-sfc'), ts = (await import('typescript')).default
  const require = createRequire(import.meta.url), vue = require('vue') as typeof import('vue')
  const { descriptor, errors } = parse(await readFile(new URL('../src/renderer/src/components/recording/RecordingView.vue', import.meta.url), 'utf8'))
  assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: 'recording-workflow-integration' })
  const modules: Record<string, unknown> = {}
  for (const name of ['recording-workflow-controller', 'recording-next-step']) {
    try { modules[name] = await import(new URL('../src/renderer/src/components/recording/' + name + '.ts', import.meta.url).href) } catch { /* 旧候选未实现时，由行为断言报告RED。 */ }
  }
  const compile = (content: string) => ts.transpileModule(content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const window = { musicBridge: api, location: { reload: options.reload ?? (() => { throw new Error('本用例不允许重新加载') }) } }
  const componentStubs: Record<string, unknown> = {}
  const load = (name: string): unknown => name === 'vue' ? vue : componentStubs[name] ?? (name.endsWith('.vue') ? { default: { render: () => null } } : modules[name.replace('./', '')] ?? require(name))
  const renderTemplate = (descriptor: ReturnType<typeof parse>['descriptor'], script: ReturnType<typeof compileScript>, filename: string) => {
    const template = compileTemplate({ id: filename, filename, source: descriptor.template!.content, compilerOptions: { bindingMetadata: script.bindings, hoistStatic: false } }); assert.deepEqual(template.errors, [])
    const module = { exports: {} as { render: (...args: unknown[]) => unknown } }
    new Function('require', 'module', 'exports', compile(template.code))(load, module, module.exports)
    return module.exports.render
  }
  if (options.actualTemplate) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'document')
    Object.defineProperty(globalThis, 'document', { configurable: true, value: document })
    t.after(() => { if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document') })
    const { descriptor } = parse(await readFile(new URL('../src/renderer/src/components/recording/BackupRestorePanel.vue', import.meta.url), 'utf8'))
    const script = compileScript(descriptor, { id: 'backup-activation-behavior' }), module = { exports: {} as { default: import('vue').Component } }
    new Function('require', 'module', 'exports', 'window', compile(script.content))(load, module, module.exports, window)
    componentStubs['./BackupRestorePanel.vue'] = { default: { ...module.exports.default, render: renderTemplate(descriptor, script, 'BackupRestorePanel.vue') } }
  }
  const module = { exports: {} as { default: import('vue').Component } }
  const code = ts.transpileModule(script.content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  new Function('require', 'module', 'exports', 'window', 'document', code)(load, module, module.exports, window, document)
  interface Host { tag: string; text: string; props: Record<string, unknown>; parent: Host | null; children: Host[]; isConnected: boolean; value: unknown; readonly options: Host[]; focus(): void; showModal(): void; close(): void; addEventListener(): void; querySelector(selector: string): Host | undefined }
  const node = (tag = ''): Host => vue.markRaw({ tag, text: '', props: {}, parent: null, children: [], isConnected: true, value: '', get options() { return this.children.filter((child: Host) => child.tag === 'option') }, focus() { document.activeElement = this }, showModal() {}, close() {}, addEventListener() {}, querySelector(selector: string) { return all(this).find(child => selector === '#' + child.props.id) } })
  const renderer = vue.createRenderer<Host, Host>({ createElement: node, createText: text => ({ ...node('#text'), text }), createComment: () => node('#comment'),
    setText(item, text) { item.text = text }, setElementText(item, text) { item.text = text; item.children = [] }, patchProp(item, key, _old, value) { item.props[key] = key === 'disabled' && value === '' ? true : value; if (key === 'value') item.value = value },
    insert(child, parent, anchor) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = parent; const i = anchor ? parent.children.indexOf(anchor) : -1; if (i < 0) parent.children.push(child); else parent.children.splice(i, 0, child) },
    remove(child) { child.isConnected = false; if (document.activeElement === child) document.activeElement = document.body; child.parent?.children.splice(child.parent.children.indexOf(child), 1); child.parent = null }, parentNode: item => item.parent, nextSibling: item => item.parent?.children[(item.parent?.children.indexOf(item) ?? -1) + 1] ?? null })
  const root = node(), all = (current = root): Host[] => [current, ...current.children.flatMap(child => all(child))]
  const text = (current = root): string => current.text + current.children.map(child => text(child)).join(' ')
  const recordingComponent = { ...module.exports.default, render: options.actualTemplate ? renderTemplate(descriptor, script, 'RecordingView.vue') : () => null }
  let hostComponent = recordingComponent
  if (options.appNavigation) {
    // 只隔离无关页面；保留真实 App 的状态声明和 RecordingView 属性/事件接线。
    const { descriptor: appDescriptor } = parse(await readFile(new URL('../src/renderer/src/App.vue', import.meta.url), 'utf8'))
    type TemplateNode = { tag?: string; loc: { source: string }; children?: readonly TemplateNode[] }
    const findRecording = (nodes: readonly TemplateNode[]): string[] => nodes.flatMap(node => node.tag === 'RecordingView' ? [node.loc.source] : findRecording(node.children ?? []))
    const branches = findRecording(appDescriptor.template!.ast!.children as readonly TemplateNode[])
    assert.equal(branches.length, 1)
    const sourceFile = ts.createSourceFile('App.ts', appDescriptor.scriptSetup!.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const declarations = sourceFile.statements.filter(ts.isVariableStatement).flatMap(statement => statement.declarationList.declarations)
      .filter(declaration => ts.isIdentifier(declaration.name) && ['currentView', 'recordingReloadRequired'].includes(declaration.name.text))
      .map(declaration => 'const ' + declaration.getText(sourceFile))
    const source = '<script setup lang="ts">import { ref } from "vue"; import RecordingView from "./RecordingView.vue"; type ViewId = string;\n' + declarations.join(';\n') + ';\nfunction openTapeCollection() { currentView.value = "collection" }' + '</script><template>' + branches[0]!.replace('v-else-if=', 'v-if=') + '</template>'
    const { descriptor: hostDescriptor, errors } = parse(source); assert.deepEqual(errors, [])
    const hostScript = compileScript(hostDescriptor, { id: 'recording-app-navigation' }), hostModule = { exports: {} as { default: import('vue').Component } }
    componentStubs['./RecordingView.vue'] = { default: recordingComponent }
    new Function('require', 'module', 'exports', compile(hostScript.content))(load, hostModule, hostModule.exports)
    hostComponent = { ...hostModule.exports.default, render: renderTemplate(hostDescriptor, hostScript, 'App-navigation.vue') }
  }
  const app = renderer.createApp(hostComponent), instance = app.mount(root)
  const hostSetup = (instance.$ as unknown as { setupState: Record<string, unknown> }).setupState
  t.after(() => app.unmount())
  if (options.appNavigation) hostSetup.currentView = 'recording'
  await new Promise<void>(resolve => setImmediate(resolve)); await vue.nextTick()
  const getSetup = () => options.appNavigation
    ? (instance.$.subTree.component as unknown as { setupState: Record<string, unknown> }).setupState : hostSetup
  const invoke = async (name: string, ...args: unknown[]) => { const setup = getSetup(); assert.equal(typeof setup[name], 'function', name); await (setup[name] as (...args: unknown[]) => unknown)(...args); await vue.nextTick() }
  const tick = async () => { await new Promise<void>(done => setImmediate(done)); await vue.nextTick() }
  const button = (label: string) => { const value = all().find(item => item.tag === 'button' && text(item).trim() === label); assert.ok(value, label); return value }
  const click = async (label: string) => { const target = button(label); assert.notEqual(target.props.disabled, true, label); target.focus(); await (target.props.onClick as () => unknown)(); await tick() }
  return { get setup() { return getSetup() }, invoke, text, all, button, click, tick, focused: () => document.activeElement, async navigate(view: string) { assert.equal(options.appNavigation, true); hostSetup.currentView = view; await tick() } }
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

test('真实恢复面板激活后明确要求重载，旧上下文清空且只有用户点击才重载一次', async t => {
  const f = apiFixture(), calls: string[] = [], activation = { id: secondId, restoreJobId: firstId, previousId: null, state: 'active' as const, createdAt: '2026-08-29T00:00:00.000Z' }
  let finish!: (value: typeof activation) => void, reloads = 0
  const api = { ...f.api,
    async listMasterDrafts() { calls.push('list'); return f.api.listMasterDrafts() },
    async getBackupOverview() { return { roots: [], activations: [], jobs: [{ id: firstId, kind: 'restore', state: 'succeeded', rootId: secondId, createdAt: activation.createdAt }] } },
    async activateRestoredDataset() { calls.push('activate'); return new Promise<typeof activation>(resolve => { finish = resolve }) },
  }
  const view = await mounted(t, api, focusDocument(), { actualTemplate: true, reload: () => { reloads++ } })
  await view.invoke('open', firstId); view.setup.title = '尚未保存的编辑'
  await view.click('备份与恢复')
  const checkbox = view.all().find(item => item.tag === 'label' && view.text(item).includes('我确认停止播放'))!.children.find(item => item.tag === 'input')!
  ;(checkbox.props['onUpdate:modelValue'] as (value: boolean) => void)(true); await view.tick()
  await view.click('确认停止播放并切换工作库')
  assert.equal(reloads, 0); assert.equal(view.all().some(item => item.props['data-testid'] === 'dataset-reload-required'), false)
  const readsBefore = calls.filter(name => name === 'list').length
  finish(activation); await view.tick()
  assert.match(view.text(), /工作库已切换，需要重新加载窗口/u)
  assert.doesNotMatch(view.text(), /已加载恢复后的工作库/u)
  assert.match(view.text(), /未保存/u); assert.match(view.text(), /不会自动重放/u)
  assert.equal(view.setup.draft, undefined); assert.equal(view.setup.title, ''); assert.equal(view.setup.backupRestore, false)
  assert.equal(calls.filter(name => name === 'list').length, readsBefore, '旧窗口不得假装刷新为新录音上下文')
  assert.equal(view.button('录音档案').props.disabled, true); assert.equal(reloads, 0)
  const reload = view.button('重新加载窗口'); assert.equal(reload.props.type, 'button'); assert.strictEqual(view.focused(), reload)
  const handler = reload.props.onClick as () => void
  await view.click('重新加载窗口'); handler(); await view.tick()
  assert.equal(reloads, 1); assert.equal(reload.props.disabled, true); assert.match(view.text(), /正在重新加载窗口/u)
  assert.deepEqual(calls.filter(name => name === 'activate'), ['activate'])
})

test('工作库激活后迟到的旧草稿读取失效，不自动重载', async t => {
  const f = apiFixture(); let reloads = 0
  const view = await mounted(t, f.api, focusDocument(), { actualTemplate: true, reload: () => { reloads++ } })
  let resolve!: (value: MasterDraft) => void
  f.api.getMasterDraft = () => new Promise(done => { resolve = done })
  const pending = view.invoke('open', firstId)
  await view.invoke('activatedDataset'); resolve(draft(firstId)); await pending
  assert.equal(view.setup.draft, undefined); assert.equal(reloads, 0)
  assert.match(view.text(), /工作库已切换，需要重新加载窗口/u)
})

test('失败、回滚和回执未知不显示成功重载入口，也不自动重试激活', async t => {
  for (const state of ['failed', 'rolled-back', 'unknown'] as const) {
    const f = apiFixture(); let reloads = 0, activations = 0
    const api = { ...f.api,
      async getBackupOverview() { return { roots: [], activations: [], jobs: [{ id: firstId, kind: 'restore', state: 'succeeded', rootId: secondId, createdAt: '2026-08-29T00:00:00.000Z' }] } },
      async activateRestoredDataset() { activations++; if (state === 'unknown') throw new Error('[OUTBOX_RESULT_UNKNOWN] 合成回执未知'); return { state } },
    }
    const view = await mounted(t, api, focusDocument(), { actualTemplate: true, reload: () => { reloads++ } })
    await view.click('备份与恢复')
    assert.match(view.text(), /切换成功后需要你点击“重新加载窗口”/u)
    const checkbox = view.all().find(item => item.tag === 'label' && view.text(item).includes('我确认停止播放'))!.children.find(item => item.tag === 'input')!
    ;(checkbox.props['onUpdate:modelValue'] as (value: boolean) => void)(true); await view.tick()
    await view.click('确认停止播放并切换工作库')
    assert.equal(view.all().some(item => item.props['data-testid'] === 'dataset-reload-required'), false)
    assert.equal(view.all().some(item => item.tag === 'button' && view.text(item) === '重新加载窗口'), false)
    assert.equal(view.setup.backupRestore, true); assert.equal(reloads, 0); assert.equal(activations, 1)
  }
})


test('同窗口离开再返回录音页仍要求重载，不读取旧scope且新窗口才清除标记', async t => {
  const f = apiFixture(); let lists = 0, reloads = 0
  const api = { ...f.api, async listMasterDrafts() { lists++; return f.api.listMasterDrafts() } }
  const view = await mounted(t, api, focusDocument(), { actualTemplate: true, appNavigation: true, reload: () => { reloads++ } })
  assert.equal(lists, 1)
  await view.invoke('activatedDataset')
  assert.match(view.text(), /工作库已切换，需要重新加载窗口/u)
  await view.navigate('collection')
  assert.equal(view.all().some(item => item.props['data-component'] === 'RecordingView'), false, '真实条件分支已卸载录音页')
  await view.navigate('recording')
  assert.equal(view.all().some(item => item.props['data-component'] === 'RecordingView'), true, '录音页已在同窗口重新挂载')
  assert.match(view.text(), /工作库已切换，需要重新加载窗口/u)
  assert.equal(view.button('录音档案').props.disabled, true)
  assert.equal(lists, 1, '重挂不假装读取新工作库上下文')
  assert.equal(reloads, 0)
  await view.click('重新加载窗口'); assert.equal(reloads, 1)
  const fresh = await mounted(t, api, focusDocument(), { actualTemplate: true, appNavigation: true })
  assert.equal(fresh.all().some(item => item.props['data-testid'] === 'dataset-reload-required'), false)
  assert.equal(lists, 2, '新 App 实例正常读取工作库，不继承前一窗口标记')
})
