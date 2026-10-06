import { installSyntheticDocumentRealm, syntheticRootNode } from './helpers/synthetic-dom-realm.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import type { MasterDraft, DraftSourceSnapshot, MediaLayoutSpec } from '@music-bridge/contracts'
import { usePageJourney, type PageJourneyOptions } from '../src/renderer/src/composables/application/usePageJourney.js'

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
    async getRecordingWorkspaceContext() { return null },
    async putRecordingWorkspaceContext(request: { draftId: string; expectedDraftRevision: number; expectedContextRevision: number; selection: Record<string, string>; pagePosition: string }) { return { draftId: request.draftId, draftRevision: request.expectedDraftRevision, contextRevision: request.expectedContextRevision + 1, selection: request.selection, pagePosition: request.pagePosition, staleReasons: [] } },
    async getDraftSources(id: string) { calls.push('sources:' + id); return sources(id) },
    async listMediaPlans(id: string) { calls.push('plans:' + id); return { draftId: id, plans: [] } },
    async listMasterVersions(id: string) { calls.push('versions:' + id); return { draftId: id, masters: [], layouts: [], jobs: [] } },
    async listPreparations(id: string) { calls.push('preparations:' + id); return { draftId: id, workspaces: [], jobs: [] } },
    async listPrepared(id: string) { calls.push('prepared:' + id); return { draftId: id, preps: [], jobs: [] } },
    async listExecutionAssets(id: string) { calls.push('execution:' + id); return { draftId: id, assets: [], jobs: [] } },
  } }
}
/** 面板准入使用真实六类谱系事实与工作库 ACK，不直接改写 Vue 展示态。 */
function selectedContextFixture() {
  const base = apiFixture()
  const ids = { plan: secondId, master: '44444444-4444-4444-8444-444444444444', layout: '55555555-5555-4555-8555-555555555555',
    preparation: '66666666-6666-4666-8666-666666666666', prepared: '77777777-7777-4777-8777-777777777777' }
  const technical: NonNullable<DraftSourceSnapshot['tracks'][number]['binding']>['technical'] = { container: 'wav', codec: 'pcm', sampleRate: 48000, channels: 2, durationMs: 1000, bitsPerSample: 16,
    lossless: true, sampleFrames: 48000, frameEvidence: 'container-declared' }
  const binding: NonNullable<DraftSourceSnapshot['tracks'][number]['binding']> = { id: '88888888-8888-4888-8888-888888888888', rootId: '99999999-9999-4999-8999-999999999999',
    fileName: 'fixture.wav', acquisition: 'userFileBind', verification: 'fileHashVerified', preservation: 'externalReferenceOnly',
    availability: 'ONLINE', sha256: 'a'.repeat(64), size: 192044, modifiedAt: '2026-09-27T00:00:00.000Z',
    verifiedAt: '2026-09-27T00:00:00.000Z', technical, userConfirmed: true, sourceLockEligible: true }
  const spec = { format: 'cassette', splitAfter: 1, leadInMs: 0, tailMs: 0, defaultGapMs: 5000, rules: [],
    compatibility: { confirmed: true, cassetteTypes: ['II'], dat: true } }
  const reservation = { physicalId: 'MB-C-00001', modelId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    skuId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', packaging: 'opened' }
  const plan = { id: ids.plan, draftId: firstId, draftRevision: 1, revision: 1, spec, reservation,
    layout: { timebase: 'milliseconds', executionReady: false, constraints: [], sides: [] }, sourceBasis: 'verified-sources',
    inputFingerprint: 'a'.repeat(64), requiresReview: false, executionReady: false }
  const master = { id: ids.master, draftId: firstId, contentHash: 'a'.repeat(64), content: { programType: 'compilation', tracks: [
    { trackId, metadata: draft(firstId).tracks[0]!.metadata, source: { sha256: binding.sha256, size: binding.size, technical },
      transitionAfterMs: 5000, keepWithNext: false },
  ] } }
  const timeline = { timebase: 'sample-frames', sampleRate: 48000, rounding: 'nearest-half-up-v1', sides: [] }
  const layout = { id: ids.layout, draftId: firstId, planId: plan.id, masterVersionId: master.id, spec, reservation,
    timelineHash: 'b'.repeat(64), timeline }
  const preparation = { id: ids.preparation, draftId: firstId, layoutVersionId: layout.id, masterVersionId: master.id }
  const prepared = { id: ids.prepared, draftId: firstId, preparationId: preparation.id, layoutVersionId: layout.id,
    masterVersionId: master.id, contentHash: master.contentHash, plannedTimelineHash: layout.timelineHash,
    plannedTimeline: timeline, conformance: { status: 'MATCHED' } }
  return { ids, ...base, api: { ...base.api,
    async getDraftSources(_id: string): Promise<DraftSourceSnapshot> { return { draftId: firstId, sourceLockEligible: true, tracks: [{ trackId, binding, jobs: [] }] } },
    async listMediaPlans() { return { draftId: firstId, plans: [plan] } },
    async listMasterVersions() { return { draftId: firstId, masters: [master], layouts: [layout], jobs: [] } },
    async listPreparations() { return { draftId: firstId, workspaces: [preparation], jobs: [] } },
    async listPrepared() { return { draftId: firstId, preps: [prepared], jobs: [] } },
    async listExecutionAssets() { return { draftId: firstId, assets: [], jobs: [] } },
  } }
}
async function mounted(t: test.TestContext, api: unknown, document = focusDocument(), options: { actualTemplate?: boolean; appNavigation?: boolean; recordsGuard?: { value: boolean }; reload?: () => void; initialPhysical?: { physicalId: string; physicalRevision: number; modelId: string; skuId: string; packaging: 'opened' | 'sealed' }; reservationNavigation?: { physicalId: string; draftId: string; planId: string } } = {}) {
  const { parse, compileScript, compileTemplate } = await import('@vue/compiler-sfc'), ts = (await import('typescript')).default
  const require = createRequire(import.meta.url), vue = require('vue') as typeof import('vue')
  const { descriptor, errors } = parse(await readFile(new URL('../src/renderer/src/components/recording/RecordingView.vue', import.meta.url), 'utf8'))
  assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: 'recording-workflow-integration' })
  const modules: Record<string, unknown> = {}
  for (const name of ['recording-workflow-controller', 'recording-workspace-controller', 'recording-workbench-order', 'recording-workbench-projection', 'recording-next-step']) {
    try { modules[name] = await import(new URL('../src/renderer/src/components/recording/' + name + '.ts', import.meta.url).href) } catch { /* 旧候选未实现时，由行为断言报告RED。 */ }
  }
  const compile = (content: string) => ts.transpileModule(content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const window = { musicBridge: api, location: { reload: options.reload ?? (() => { throw new Error('本用例不允许重新加载') }) } }
  const componentStubs: Record<string, unknown> = {}
  componentStubs['./RecordingPlanPanel.vue'] = { default: vue.defineComponent({
    setup(_props, { expose }) {
      expose({ canLeave: () => true, leaveBlockReason: () => null })
      return () => null
    },
  }) }
  if (options.recordsGuard) componentStubs['./RecordingRecordsPanel.vue'] = { default: vue.defineComponent({
    setup(_props, { expose }) {
      expose({ canLeave: () => options.recordsGuard!.value, leaveBlockReason: () => options.recordsGuard!.value ? null : '历史音频设备输出尚未收口。' })
      return () => vue.h('section', { 'data-testid': 'recording-records-guard-stub' })
    },
  }) }
  const load = (name: string): unknown => name === 'vue' ? vue : componentStubs[name] ?? (name.endsWith('.vue') ? { default: { render: () => null } } : modules[name.replace(/^\.\//u, '').replace(/\.js$/u, '')] ?? require(name))
  const renderTemplate = (descriptor: ReturnType<typeof parse>['descriptor'], script: ReturnType<typeof compileScript>, filename: string) => {
    const template = compileTemplate({ id: filename, filename, source: descriptor.template!.content, compilerOptions: { bindingMetadata: script.bindings, hoistStatic: false } }); assert.deepEqual(template.errors, [])
    const module = { exports: {} as { render: (...args: unknown[]) => unknown } }
    new Function('require', 'module', 'exports', compile(template.code))(load, module, module.exports)
    return module.exports.render
  }
  const restoreDocument = installSyntheticDocumentRealm(document)
  let unmount = () => {}
  t.after(() => { try { unmount() } finally { restoreDocument() } })
  if (options.actualTemplate) {
    const { descriptor } = parse(await readFile(new URL('../src/renderer/src/components/recording/BackupRestorePanel.vue', import.meta.url), 'utf8'))
    const script = compileScript(descriptor, { id: 'backup-activation-behavior' }), module = { exports: {} as { default: import('vue').Component } }
    new Function('require', 'module', 'exports', 'window', compile(script.content))(load, module, module.exports, window)
    componentStubs['./BackupRestorePanel.vue'] = { default: { ...module.exports.default, render: renderTemplate(descriptor, script, 'BackupRestorePanel.vue') } }
    const { descriptor: nextDescriptor } = parse(await readFile(new URL('../src/renderer/src/components/recording/RecordingNextStep.vue', import.meta.url), 'utf8'))
    const nextScript = compileScript(nextDescriptor, { id: 'recording-next-step-behavior' }), nextModule = { exports: {} as { default: import('vue').Component } }
    new Function('require', 'module', 'exports', compile(nextScript.content))(load, nextModule, nextModule.exports)
    componentStubs['./RecordingNextStep.vue'] = { default: { ...nextModule.exports.default, render: renderTemplate(nextDescriptor, nextScript, 'RecordingNextStep.vue') } }
  }
  const module = { exports: {} as { default: import('vue').Component } }
  const code = ts.transpileModule(script.content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  new Function('require', 'module', 'exports', 'window', 'document', code)(load, module, module.exports, window, document)
  let mountedRoot: Host | null = null
  interface Host { readonly ownerDocument: typeof document; getRootNode(): Host | object; tag: string; text: string; props: Record<string, unknown>; parent: Host | null; children: Host[]; isConnected: boolean; value: unknown; readonly options: Host[]; focus(): void; showModal(): void; close(): void; addEventListener(): void; closest(selector: string): Host | null; querySelector(selector: string): Host | undefined }
  const node = (tag = ''): Host => vue.markRaw({ ownerDocument: document, getRootNode(): Host | object { return syntheticRootNode<Host>(this, mountedRoot, document) }, tag, text: '', props: {}, parent: null, children: [], isConnected: true, value: '', get options() { return this.children.filter((child: Host) => child.tag === 'option') }, focus() { document.activeElement = this }, showModal() {}, close() {}, addEventListener() {}, closest(selector: string) { let parent = this.parent; while (parent) { if (parent.tag === selector) return parent; parent = parent.parent } return null }, querySelector(selector: string) { return all(this).find(child => selector === '#' + child.props.id) } })
  const renderer = vue.createRenderer<Host, Host>({ createElement: node, createText: text => ({ ...node('#text'), text }), createComment: () => node('#comment'),
    setText(item, text) { item.text = text }, setElementText(item, text) { item.text = text; item.children = [] }, patchProp(item, key, _old, value) { item.props[key] = key === 'disabled' && value === '' ? true : value; if (key === 'value') item.value = value },
    insert(child, parent, anchor) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = parent; const i = anchor ? parent.children.indexOf(anchor) : -1; if (i < 0) parent.children.push(child); else parent.children.splice(i, 0, child) },
    remove(child) { child.isConnected = false; if (document.activeElement === child) document.activeElement = document.body; child.parent?.children.splice(child.parent.children.indexOf(child), 1); child.parent = null }, parentNode: item => item.parent, nextSibling: item => item.parent?.children[(item.parent?.children.indexOf(item) ?? -1) + 1] ?? null })
  const root = node(); mountedRoot = root
  const all = (current = root): Host[] => [current, ...current.children.flatMap(child => all(child))]
  const text = (current = root): string => current.text + current.children.map(child => text(child)).join(' ')
  const recordingComponent = { ...module.exports.default, render: options.actualTemplate ? renderTemplate(descriptor, script, 'RecordingView.vue') : () => null }
  let hostComponent = recordingComponent
  let canLeaveRecording = () => true
  if (options.appNavigation) {
    // 只隔离无关页面；保留真实 App 的 Journey 所有者及 RecordingView 属性/事件接线。
    const { descriptor: appDescriptor } = parse(await readFile(new URL('../src/renderer/src/App.vue', import.meta.url), 'utf8'))
    type TemplateNode = { tag?: string; loc: { source: string }; children?: readonly TemplateNode[] }
    const findRecording = (nodes: readonly TemplateNode[]): string[] => nodes.flatMap(node => node.tag === 'RecordingView' ? [node.loc.source] : findRecording(node.children ?? []))
    const branches = findRecording(appDescriptor.template!.ast!.children as readonly TemplateNode[])
    assert.equal(branches.length, 1)
    const appScript = appDescriptor.scriptSetup!.content
    const journeyStart = appScript.indexOf('const journey = usePageJourney(')
    const bindingStart = appScript.indexOf('const {', journeyStart)
    const bindingEnd = appScript.indexOf('} = journey', bindingStart)
    assert.ok(journeyStart >= 0 && bindingStart > journeyStart && bindingEnd > bindingStart, 'App 必须从 PageJourney 接入页面状态')
    const journeyBindings = appScript.slice(bindingStart, bindingEnd)
    assert.match(journeyBindings, /\bcurrentView\b/u)
    assert.match(journeyBindings, /\bopenTapeCollection\b/u)
    const sourceFile = ts.createSourceFile('App.ts', appDescriptor.scriptSetup!.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const declarations = sourceFile.statements.filter(ts.isVariableStatement).flatMap(statement => statement.declarationList.declarations)
      .filter(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === 'recordingReloadRequired')
      .map(declaration => 'const ' + declaration.getText(sourceFile))
    assert.equal(declarations.length, 1, 'App 必须保留录音工作库重载标记')
    const journeyPorts = {
      search: { searchQuery: vue.ref(''), searchPage: vue.ref({ items: [] }), searchSongsOpen: vue.ref(false), searchScrollTop: vue.ref(0), scheduleSearch() {}, resetSearch() {} },
      browse: { localAlbumQuery: vue.ref(''), localArtistQuery: vue.ref(''), invalidateAlbumArtistRequests() {}, leaveDetail() {} },
      library: { hasLikedItems: () => false, isPlaylistReady: () => false, getPlaylistScrollTop: () => 0, setPlaylistScrollTop() {}, async loadLiked() {}, async loadPlaylists() {}, async loadPlaylist() {} },
      onPlayRoonTrack() {}, onCloseInspector() {}, onClearActionError() {}, canLeaveRecording: () => canLeaveRecording(),
    } as unknown as PageJourneyOptions
    const source = '<script setup lang="ts">import { ref } from "vue"; import RecordingView from "./RecordingView.vue";\n' + declarations.join(';\n') + ';\nconst journey = usePageJourney(journeyPorts); const { currentView, openTapeCollection } = journey; const recordingInitialPhysical = ref(undefined); const recordingReservationNavigation = ref(undefined); const openCollectionFromRecording = () => openTapeCollection()' + '</script><template>' + branches[0]!.replace('v-else-if=', 'v-if=') + '</template>'
    const { descriptor: hostDescriptor, errors } = parse(source); assert.deepEqual(errors, [])
    const hostScript = compileScript(hostDescriptor, { id: 'recording-app-navigation' }), hostModule = { exports: {} as { default: import('vue').Component } }
    componentStubs['./RecordingView.vue'] = { default: recordingComponent }
    new Function('require', 'module', 'exports', 'usePageJourney', 'journeyPorts', compile(hostScript.content))(load, hostModule, hostModule.exports, usePageJourney, journeyPorts)
    hostComponent = { ...hostModule.exports.default, render: renderTemplate(hostDescriptor, hostScript, 'App-navigation.vue') }
  }
  const events = { reservationNavigationConsumed: 0, initialPhysicalConsumed: 0 }
  const app = renderer.createApp(hostComponent, { initialPhysical: options.initialPhysical, reservationNavigation: options.reservationNavigation,
    ...(!options.appNavigation ? { onReservationNavigationConsumed: () => { events.reservationNavigationConsumed++ }, onInitialPhysicalConsumed: () => { events.initialPhysicalConsumed++ } } : {}) }), instance = app.mount(root)
  if (options.appNavigation) canLeaveRecording = () => ((instance.$.subTree.component as unknown as { exposed?: { canLeave?: () => boolean } })?.exposed?.canLeave?.() ?? false)
  const hostSetup = (instance.$ as unknown as { setupState: Record<string, unknown> }).setupState
  unmount = () => app.unmount()
  const hostJourney = options.appNavigation ? hostSetup.journey as ReturnType<typeof usePageJourney> : undefined
  if (hostJourney) hostJourney.navigateSource({ type: 'recording' })
  await new Promise<void>(resolve => setImmediate(resolve)); await vue.nextTick()
  const getSetup = () => options.appNavigation
    ? (instance.$.subTree.component as unknown as { setupState: Record<string, unknown> }).setupState : hostSetup
  const invoke = async (name: string, ...args: unknown[]) => { const setup = getSetup(); assert.equal(typeof setup[name], 'function', name); await (setup[name] as (...args: unknown[]) => unknown)(...args); await vue.nextTick() }
  const tick = async () => { await new Promise<void>(done => setImmediate(done)); await vue.nextTick() }
  const button = (label: string) => { const value = all().find(item => item.tag === 'button' && text(item).trim() === label); assert.ok(value, label); return value }
  const click = async (label: string) => { const target = button(label); assert.notEqual(target.props.disabled, true, label); target.focus(); await (target.props.onClick as () => unknown)(); await tick() }
  const exposed = () => { const owner = options.appNavigation ? instance.$.subTree.component : instance.$; assert.ok(owner?.exposed); return owner.exposed as Record<string, unknown> }
  return { get setup() { return getSetup() }, get exposed() { return exposed() }, events, invoke, text, all, button, click, tick, focused: () => document.activeElement, async navigate(view: 'collection' | 'recording') { assert.ok(hostJourney); hostJourney.navigateSource({ type: view }); await tick() } }
}

test('录音页打开草稿一次读取六类当前事实，源标签与下一步共享同一代际', async t => {
  const f = apiFixture(), view = await mounted(t, f.api)
  await view.invoke('open', firstId)
  assert.deepEqual(f.calls.sort(), ['sources', 'plans', 'versions', 'preparations', 'prepared', 'execution'].map(name => name + ':' + firstId).sort())
  assert.equal((view.setup.sourceSnapshot as DraftSourceSnapshot).draftId, firstId)
  assert.equal((view.setup.nextStep as { action: { type: string } }).action.type, 'media')
})

test('冷重开恢复已存媒体页与原始实体意图，失效规划不自动改选或写回', async t => {
  const f = apiFixture(), puts: unknown[] = []
  const api = { ...f.api,
    async getRecordingWorkspaceContext(draftId: string) { return { draftId, draftRevision: 1, contextRevision: 3, selection: { planId: secondId, selectedPhysicalId: 'MB-C-00022' }, pagePosition: 'media', staleReasons: [{ field: 'planId', reason: 'missing' }] } },
    async putRecordingWorkspaceContext(request: unknown) { puts.push(request); throw new Error('恢复不应自动写回') },
  }
  const view = await mounted(t, api); await view.invoke('open', firstId)
  assert.equal(view.setup.page, 'media'); assert.equal(view.setup.mediaPlanning, true)
  assert.equal(view.setup.initialMediaPlanId, secondId)
  assert.equal((view.setup.workspaceState as { selection: { selectedPhysicalId: string } }).selection.selectedPhysicalId, 'MB-C-00022')
  assert.equal((view.setup.workflowState as { selection: { planId?: string } }).selection.planId, undefined)
  assert.deepEqual(puts, [])
})

test('源页缺曲目身份时回到工作台说明，不渲染空源页', async t => {
  const f = apiFixture(), api = { ...f.api, async getRecordingWorkspaceContext(draftId: string) { return { draftId, draftRevision: 1, contextRevision: 1, selection: {}, pagePosition: 'source', staleReasons: [] } } }
  const view = await mounted(t, api); await view.invoke('open', firstId)
  assert.equal(view.setup.page, 'workbench')
  assert.match(String(view.setup.notice), /曲目身份未随页面位置保存/u)
})

test('从收藏带入单盘后只保存选择意图，离开 guard 覆盖未存曲序与分面', async t => {
  const f = apiFixture(), puts: { selection: { selectedPhysicalId?: string } }[] = []
  const physical = { physicalId: 'MB-C-00022', physicalRevision: 7, modelId: secondId, skuId: trackId, packaging: 'opened' as const }
  const api = { ...f.api, async putRecordingWorkspaceContext(request: { draftId: string; expectedDraftRevision: number; expectedContextRevision: number; selection: { selectedPhysicalId?: string }; pagePosition: string }) {
    puts.push(request)
    return { draftId: request.draftId, draftRevision: request.expectedDraftRevision, contextRevision: request.expectedContextRevision + 1, selection: request.selection, pagePosition: request.pagePosition, staleReasons: [] }
  } }
  const view = await mounted(t, api, focusDocument(), { initialPhysical: physical }); await view.invoke('open', firstId); await view.tick()
  assert.equal(puts.length, 1); assert.equal(puts[0]!.selection.selectedPhysicalId, physical.physicalId)
  assert.equal(view.events.initialPhysicalConsumed, 1)
  const canLeave = view.exposed.canLeave as () => boolean
  assert.equal(canLeave(), true)
  view.setup.workbenchSpec = { ...(view.setup.workbenchSpec as Record<string, unknown>), splitAfter: 2 }
  assert.equal(canLeave(), false); assert.match(String(view.setup.leaveGuardNotice), /分面尚未保存/u)
  await view.invoke('back', true)
  assert.equal(canLeave(), true)
  assert.equal(view.events.initialPhysicalConsumed, 1, '带入意图仅消费一次')
})

test('删除带连播与指定面规则的曲目后保存，新草稿可带清理后的规则重新规划', async t => {
  const f = apiFixture(), middleId = '44444444-4444-4444-8444-444444444444', lastId = '55555555-5555-4555-8555-555555555555'
  let current = { ...draft(firstId), revision: 1, trackCount: 3, tracks: [
    { id: trackId, source: 'roon' as const, metadata: { title: '第一首', durationMs: 1000 } },
    { id: middleId, source: 'roon' as const, metadata: { title: '要删除', durationMs: 1000 } },
    { id: lastId, source: 'roon' as const, metadata: { title: '第三首', durationMs: 1000 } },
  ] }
  const planId = secondId
  const oldSpec = { format: 'cassette' as const, splitAfter: 2, leadInMs: 0, tailMs: 0, defaultGapMs: 5000, compatibility: { confirmed: false, cassetteTypes: [] as const, dat: false }, rules: [
    { trackId, keepWithNext: true }, { trackId: middleId, forceSide: 'A' as const, sideCloser: true }, { trackId: lastId, forceSide: 'B' as const },
  ] }
  const oldPlan = { id: planId, draftId: firstId, draftRevision: 1, revision: 1, spec: oldSpec, layout: { timebase: 'milliseconds', executionReady: false, constraints: [], sides: [
    { name: 'A', tracks: [{ trackId }, { trackId: middleId }] }, { name: 'B', tracks: [{ trackId: lastId }] },
  ] }, sourceBasis: 'roon-estimate', inputFingerprint: 'a'.repeat(64), requiresReview: false, executionReady: false }
  const api = { ...f.api,
    async getMasterDraft() { return current },
    async getDraftSources() { return { draftId: firstId, sourceLockEligible: false, tracks: current.tracks.map(track => ({ trackId: track.id, jobs: [] })) } },
    async listMediaPlans() { return { draftId: firstId, plans: [oldPlan] } },
    async getRecordingWorkspaceContext() { return { draftId: firstId, draftRevision: current.revision, contextRevision: 1, selection: { planId }, pagePosition: 'workbench', staleReasons: [] } },
    async updateMasterDraft(request: { trackIds: string[] }) { current = { ...current, revision: 2, trackCount: request.trackIds.length, tracks: current.tracks.filter(track => request.trackIds.includes(track.id)) }; return { draftId: firstId, trackIds: request.trackIds } },
  }
  const view = await mounted(t, api); await view.invoke('open', firstId)
  assert.equal((view.setup.workbenchSpec as { rules: { trackId: string }[] }).rules.length, 3)
  await view.invoke('removeTrack', middleId)
  assert.equal(view.setup.dirty, true, '移除曲目后应有未保存的曲序')
  assert.equal(view.setup.blocked, false, '没有其他待处理操作时允许保存草稿')
  assert.match(String(view.setup.moveError), /复核首末曲与指定面约束/u)
  await view.invoke('save')
  for (let attempt = 0; attempt < 5 && (view.setup.draft as MasterDraft).revision !== 2; attempt++) await view.tick()
  assert.equal(current.revision, 2, `保存命令未落地：${JSON.stringify({ saving: view.setup.saving, pending: !!view.setup.pending, error: view.setup.error, loading: view.setup.loading })}`)
  assert.equal((view.setup.draft as MasterDraft).revision, 2, `视图未更新：${JSON.stringify({ saving: view.setup.saving, pending: !!view.setup.pending, error: view.setup.error, loading: view.setup.loading, notice: view.setup.notice })}`)
  const cleaned = view.setup.workbenchSpec as { rules: { trackId: string; keepWithNext?: boolean; forceSide?: string }[] }
  assert.deepEqual(cleaned.rules, [{ trackId }, { trackId: lastId, forceSide: 'B' }])
  assert.equal(view.setup.splitDirty, true)
  await view.invoke('openMediaPlanning', planId)
  assert.deepEqual((view.setup.initialMediaSpec as typeof oldSpec).rules, cleaned.rules)
  assert.match(String(view.setup.notice), /重新核对并保存分面/u)
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

test('工作台从 Vue ref 分盘视图退出时可编辑完整母版，旧分盘稿不被改写', async t => {
  const f = apiFixture(), view = await mounted(t, f.api, focusDocument(), { actualTemplate: true })
  await view.invoke('open', firstId)
  const oldSpec: MediaLayoutSpec = { format: 'cassette', splitAfter: 1, leadInMs: 0, tailMs: 0, defaultGapMs: 5000,
    rules: [{ trackId, sideOpener: true }], compatibility: { confirmed: true, cassetteTypes: ['II'], dat: false },
    distribution: { schemaVersion: 1, groupId: firstId, segmentIndex: 0, segmentSpecs: [{ trackIds: [trackId] }] } }
  view.setup.workbenchSpec = oldSpec
  await view.tick()
  assert.equal((await import('vue')).isProxy(view.setup.workbenchSpec), true, '工作台必须测试真实 Vue 深代理而非普通对象')
  await view.click('退出分盘视图，编辑完整母版')
  const current = view.setup.workbenchSpec as MediaLayoutSpec
  assert.equal(current.distribution, undefined)
  assert.deepEqual(current.rules, [])
  assert.equal(current.splitAfter, 1)
  assert.equal(oldSpec.distribution?.groupId, firstId)
  assert.deepEqual(oldSpec.rules, [{ trackId, sideOpener: true }])
  assert.match(String(view.setup.moveError), /已切回完整母版编辑稿/u)
})

test('主建议的保存和分面按钮实际可点击；子页顶栏与侧栏都不能绕过离开保护', async t => {
  const f = apiFixture(); let current = draft(firstId), updates = 0
  const api = { ...f.api,
    async getMasterDraft() { return current },
    async updateMasterDraft(request: { title: string }) { updates++; current = { ...current, title: request.title, revision: current.revision + 1 }; return { draftId: firstId } },
  }
  const view = await mounted(t, api, focusDocument(), { actualTemplate: true, appNavigation: true })
  await view.invoke('open', firstId)
  view.setup.title = '修改后的标题'; await view.tick()
  assert.equal(view.button('保存当前草稿').props.disabled, false)
  await view.click('保存当前草稿')
  for (let attempt = 0; attempt < 5 && (view.setup.draft as MasterDraft).revision !== 2; attempt++) await view.tick()
  assert.equal(updates, 1); assert.equal((view.setup.draft as MasterDraft).revision, 2)
  view.setup.workbenchSpec = { ...(view.setup.workbenchSpec as Record<string, unknown>), splitAfter: 2 }
  await view.tick()
  assert.equal(view.button('估算并保存分面').props.disabled, false)
  await view.click('估算并保存分面')
  assert.equal(view.setup.page, 'media')
  assert.equal(view.button('我的制作').props.disabled, true)
  assert.equal(view.button('制作工作台').props.disabled, true)
  assert.equal(view.button('录音档案').props.disabled, true)
  await view.navigate('collection')
  assert.equal(view.all().some(item => item.props['data-component'] === 'RecordingView'), true, '侧栏不得卸载未保存的分面步骤')
  await view.invoke('closeMediaPlanning') // 等价于子页明确保存或放弃后发出的 close 回执。
  assert.equal((view.exposed.canLeave as () => boolean)(), false, '回工作台后仍有未保存分面')
  await view.invoke('back', true)
  await view.navigate('collection')
  assert.equal(view.all().some(item => item.props['data-component'] === 'RecordingView'), false, '明确放弃后可以离开')
})

test('保存回执悬挂时顶部我的制作不能先离开，迟到成功不会抢回旧页面', async t => {
  const f = apiFixture(); let current = draft(firstId), resolve!: (result: { draftId: string }) => void
  const api = { ...f.api,
    async getMasterDraft() { return current },
    async updateMasterDraft() { return new Promise<{ draftId: string }>(done => { resolve = done }) },
  }
  const view = await mounted(t, api, focusDocument(), { actualTemplate: true })
  await view.invoke('open', firstId)
  view.setup.title = '待回执的标题'; await view.tick()
  await view.click('保存当前草稿')
  assert.equal(view.setup.saving, true)
  const back = view.button('我的制作')
  assert.equal(back.props.disabled, true)
  ;(back.props.onClick as () => void)(); await view.tick() // 即使旧事件已排队，方法自身也须守住回执边界。
  assert.equal((view.setup.draft as MasterDraft).id, firstId)
  assert.equal(view.setup.page, 'workbench')
  assert.equal((view.exposed.canLeave as () => boolean)(), false)
  current = { ...current, title: '待回执的标题', revision: 2 }
  resolve({ draftId: firstId })
  for (let attempt = 0; attempt < 5 && (view.setup.draft as MasterDraft).revision !== 2; attempt++) await view.tick()
  assert.equal((view.setup.draft as MasterDraft).revision, 2)
  assert.equal(view.setup.page, 'workbench')
})

test('保存已确认但重读失败不伪装成未知回执，也不允许重放旧修订保存', async t => {
  const f = apiFixture(); let current = draft(firstId), reads = 0, updates = 0
  const api = { ...f.api,
    async getMasterDraft() { reads++; if (reads === 2) throw new Error('合成详情读取失败'); return current },
    async updateMasterDraft(request: { title: string }) { updates++; current = { ...current, title: request.title, revision: 2 }; return { draftId: firstId } },
  }
  const view = await mounted(t, api, focusDocument(), { actualTemplate: true })
  await view.invoke('open', firstId)
  view.setup.title = '已确认保存的标题'; await view.tick()
  await view.click('保存当前草稿')
  for (let attempt = 0; attempt < 5 && !view.setup.confirmedSaveNeedsRefresh; attempt++) await view.tick()
  assert.equal(updates, 1)
  assert.equal(view.setup.pending, undefined)
  assert.equal(view.setup.confirmedSaveNeedsRefresh, true)
  assert.match(String(view.setup.error), /保存已确认/u)
  assert.doesNotMatch(String(view.setup.error), /结果尚未确认/u)
  assert.equal(view.button('我的制作').props.disabled, true)
  await view.invoke('save'); assert.equal(updates, 1, '不能以旧修订再造一条保存命令')
  await view.click('重新读取')
  assert.equal(view.setup.confirmedSaveNeedsRefresh, false)
  assert.equal((view.setup.draft as MasterDraft).revision, 2)
})

test('MBR-002：真实工作台未知保存重读保留原命令，离页锁与原保存重试不消失', async t => {
  const f = apiFixture(), puts: unknown[] = []
  const api = { ...f.api, async putRecordingWorkspaceContext(request: unknown) { puts.push(structuredClone(request)); throw new Error('[TIMEOUT] /private/保存故障') } }
  const view = await mounted(t, api, focusDocument(), { actualTemplate: true,
    initialPhysical: { physicalId: 'MB-C-00022', physicalRevision: 7, modelId: firstId, skuId: secondId, packaging: 'opened' } })
  await view.invoke('open', firstId); await view.tick()
  assert.equal(view.setup.workspaceUnsaved, true); assert.equal((view.exposed.canLeave as () => boolean)(), false)
  const original = puts[0]
  await view.click('重新读取工作库（保留未决回执）')
  assert.equal(view.setup.workspaceUnsaved, true); assert.equal((view.exposed.canLeave as () => boolean)(), false)
  assert.equal(view.button('我的制作').props.disabled, true)
  assert.equal(puts.length, 1, '重读不能自动重放原保存或产生新写命令')
  await view.click('重试原保存操作'); assert.deepEqual(puts, [original, original])
  assert.doesNotMatch(view.text(), /private/u)
})

test('工作上下文写入悬挂时顶部我的制作同样不能绕过回执', async t => {
  const f = apiFixture(), physicalId = 'MB-C-00022'
  let settle!: (context: { draftId: string; draftRevision: number; contextRevision: number; selection: { selectedPhysicalId: string }; pagePosition: string; staleReasons: never[] }) => void
  const api = { ...f.api,
    async putRecordingWorkspaceContext() { return new Promise<Parameters<typeof settle>[0]>(done => { settle = done }) },
  }
  const view = await mounted(t, api, focusDocument(), { actualTemplate: true,
    initialPhysical: { physicalId, physicalRevision: 7, modelId: firstId, skuId: secondId, packaging: 'opened' } })
  await view.invoke('open', firstId); await view.tick()
  assert.equal(view.setup.workspaceUnsaved, true)
  const back = view.button('我的制作')
  assert.equal(back.props.disabled, true)
  ;(back.props.onClick as () => void)(); await view.tick()
  assert.equal((view.setup.draft as MasterDraft).id, firstId)
  assert.equal(view.setup.page, 'workbench')
  assert.equal((view.exposed.canLeave as () => boolean)(), false)
  settle({ draftId: firstId, draftRevision: 1, contextRevision: 1, selection: { selectedPhysicalId: physicalId }, pagePosition: 'workbench', staleReasons: [] })
  await view.tick()
  assert.equal(view.setup.workspaceUnsaved, false)
  assert.equal(view.events.initialPhysicalConsumed, 1)
  await view.click('我的制作')
  assert.equal(view.setup.page, 'my-work')
})

test('已预留单盘只打开确切草稿与规划，读取实时归属并保存本次选择后才消费导航', async t => {
  const f = apiFixture(), physicalId = 'MB-C-00022', otherPlanId = trackId, puts: { selection: { planId?: string; selectedPhysicalId?: string }; pagePosition: string }[] = []
  const spec = { format: 'cassette' as const, splitAfter: 1, leadInMs: 0, tailMs: 0, defaultGapMs: 5000, rules: [], compatibility: { confirmed: false, cassetteTypes: [], dat: false } }
  const plan = { id: secondId, draftId: firstId, draftRevision: 1, revision: 1, spec, layout: { timebase: 'milliseconds', executionReady: false, constraints: [], sides: [] }, sourceBasis: 'roon-estimate', inputFingerprint: 'a'.repeat(64), reservation: { physicalId, modelId: firstId, skuId: secondId, packaging: 'opened' }, requiresReview: false, executionReady: false }
  const otherPlan = { ...plan, id: otherPlanId, reservation: undefined }
  const api = { ...f.api,
    async listMediaPlans() { return { draftId: firstId, plans: [otherPlan, plan] } },
    async getMediaPlan(id: string) { assert.equal(id, secondId); return plan },
    async getCollectionCopy(id: string) { assert.equal(id, physicalId); return { modelId: firstId, copy: { physicalId, usage: 'reserved', reservationOwner: { kind: 'recording-plan', draftId: firstId, planId: secondId } } } },
    async getRecordingWorkspaceContext() { return { draftId: firstId, draftRevision: 1, contextRevision: 1, selection: { planId: otherPlanId }, pagePosition: 'versions', staleReasons: [] } },
    async putRecordingWorkspaceContext(request: { draftId: string; expectedDraftRevision: number; expectedContextRevision: number; selection: { planId?: string; selectedPhysicalId?: string }; pagePosition: string }) {
      puts.push(request); return { draftId: request.draftId, draftRevision: request.expectedDraftRevision, contextRevision: request.expectedContextRevision + 1, selection: request.selection, pagePosition: request.pagePosition, staleReasons: [] }
    },
  }
  const view = await mounted(t, api, focusDocument(), { reservationNavigation: { physicalId, draftId: firstId, planId: secondId } })
  for (let attempt = 0; attempt < 5 && view.setup.pendingReservationNavigation; attempt++) await view.tick()
  assert.equal((view.setup.draft as MasterDraft).id, firstId)
  assert.equal((view.setup.workflowState as { selection: { planId?: string } }).selection.planId, secondId)
  assert.equal((view.setup.workspaceState as { selection: { selectedPhysicalId?: string } }).selection.selectedPhysicalId, physicalId)
  assert.equal(view.setup.page, 'workbench')
  assert.ok(puts.length >= 1); assert.equal(puts.at(-1)?.selection.planId, secondId); assert.equal(puts.at(-1)?.selection.selectedPhysicalId, physicalId)
  assert.equal(view.events.reservationNavigationConsumed, 1)
})

test('预留已释放或实时归属不符时保留精确导航，不改选其他规划；明确取消才消费', async t => {
  const f = apiFixture(), physicalId = 'MB-C-00022'; let puts = 0
  const plan = { id: secondId, draftId: firstId, draftRevision: 1, revision: 1, spec: { format: 'cassette', splitAfter: 1, leadInMs: 0, tailMs: 0, defaultGapMs: 5000, rules: [], compatibility: { confirmed: false, cassetteTypes: [], dat: false } }, layout: { timebase: 'milliseconds', executionReady: false, constraints: [], sides: [] }, sourceBasis: 'roon-estimate', inputFingerprint: 'a'.repeat(64), reservation: { physicalId }, requiresReview: false, executionReady: false }
  const api = { ...f.api,
    async listMediaPlans() { return { draftId: firstId, plans: [plan] } }, async getMediaPlan() { return plan },
    async getCollectionCopy() { return { modelId: firstId, copy: { physicalId, usage: 'blank', reservationOwner: undefined } } },
    async putRecordingWorkspaceContext() { puts++; throw new Error('失效导航不得写入') },
  }
  const view = await mounted(t, api, focusDocument(), { actualTemplate: true, reservationNavigation: { physicalId, draftId: firstId, planId: secondId } })
  for (let attempt = 0; attempt < 5 && view.setup.reservationNavigationLoading; attempt++) await view.tick()
  assert.match(String(view.setup.reservationNavigationError), /原定位已保留/u)
  assert.equal((view.setup.workflowState as { selection: { planId?: string } }).selection.planId, undefined)
  assert.equal(puts, 0); assert.equal(view.events.reservationNavigationConsumed, 0)
  await view.click('取消这次定位')
  assert.equal(view.setup.pendingReservationNavigation, undefined)
  assert.equal(view.events.reservationNavigationConsumed, 1)
})

test('下一步向三个工具传递明确上下文，手动工具入口沿用本次已选身份', async t => {
  const f = selectedContextFixture(), view = await mounted(t, f.api); await view.invoke('open', firstId)
  await view.invoke('nextAction', { type: 'media' }); assert.equal(view.setup.initialMediaPlanId, '')
  await selectStoredContext(view, f.ids, 'prep')
  await view.invoke('nextAction', { type: 'media' }); assert.equal(view.setup.initialMediaPlanId, f.ids.plan)
  await view.invoke('nextAction', { type: 'versions' }); assert.equal(view.setup.initialVersionPlanId, f.ids.plan)
  assert.equal((view.setup.nextStep as { disabled: boolean }).disabled, false, JSON.stringify({ nextStep: view.setup.nextStep, notice: view.setup.notice, workspace: view.setup.workspaceState }))
  await view.invoke('nextAction', { type: 'execution' }); assert.deepEqual(view.setup.initialExecutionContext, { layoutId: f.ids.layout, mode: 'prepared-reference', preparedId: f.ids.prepared })
  await view.invoke('openMediaPlanning'); await view.invoke('openMasterVersions'); await view.invoke('openExecution')
  assert.equal(view.setup.initialMediaPlanId, f.ids.plan); assert.equal(view.setup.initialVersionPlanId, f.ids.plan); assert.deepEqual(view.setup.initialExecutionContext, { layoutId: f.ids.layout, mode: 'prepared-reference', preparedId: f.ids.prepared })
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
  const body = { isConnected: true, focus() {}, closest(_selector?: string): null { return null } }
  const document = { body, activeElement: body as unknown,
    addEventListener(type: string, listener: () => void) { const set = listeners.get(type) ?? new Set(); set.add(listener); listeners.set(type, set) },
    removeEventListener(type: string, listener: () => void) { listeners.get(type)?.delete(listener) },
    interact(type: string) { for (const listener of listeners.get(type) ?? []) listener() },
    element() { return Object.freeze({ isConnected: true, focus() { document.activeElement = this }, closest(_selector?: string): null { return null } }) },
  }
  return document
}

async function selectStoredContext(view: Awaited<ReturnType<typeof mounted>>, ids: ReturnType<typeof selectedContextFixture>['ids'], path: 'direct' | 'prep'): Promise<void> {
  await view.invoke('selectWorkflow', { planId: ids.plan })
  await view.invoke('selectWorkflow', { layoutId: ids.layout })
  await view.invoke('selectWorkflow', { path })
  if (path === 'prep') {
    await view.invoke('selectWorkflow', { preparationId: ids.preparation })
    await view.invoke('selectWorkflow', { preparedId: ids.prepared })
  }
  await view.tick()
  const selection = (view.setup.workflowState as { selection: Record<string, string> }).selection
  assert.equal(selection.planId, ids.plan)
  assert.equal(selection.layoutId, ids.layout)
  assert.equal(selection.path, path)
  if (path === 'prep') { assert.equal(selection.preparationId, ids.preparation); assert.equal(selection.preparedId, ids.prepared) }
  const workspace = view.setup.workspaceState as { status: string; writing: boolean; pending?: unknown; context?: { selection: Record<string, string> } }
  assert.equal(workspace.status, 'ready')
  assert.equal(workspace.writing, false)
  assert.equal(workspace.pending, undefined)
  assert.equal(workspace.context?.selection.layoutId, ids.layout)
}

test('五个工具关闭后返回本次实际触发按钮，保留下一步和旧工具两种入口', async t => {
  const doc = focusDocument(), f = selectedContextFixture(), view = await mounted(t, f.api, doc); await view.invoke('open', firstId)
  await selectStoredContext(view, f.ids, 'prep')
  for (const name of ['Execution', 'Preparation', 'Prepared', 'MediaPlanning', 'MasterVersions']) {
    const primary = doc.element(), legacy = doc.element(); view.setup[name.toLowerCase() + 'Trigger'] = legacy
    for (const trigger of [primary, legacy]) {
      const context = name === 'Execution' ? [{ layoutId: f.ids.layout, mode: 'prepared-reference', preparedId: f.ids.prepared }] : name === 'Preparation' ? [f.ids.layout] : name === 'Prepared' ? [f.ids.preparation] : []
      doc.activeElement = trigger; await view.invoke('open' + name, ...context); doc.activeElement = doc.body
      await view.invoke('close' + name); assert.strictEqual(doc.activeElement, trigger, name)
    }
  }
})

test('关闭后的迟到事实读取不抢走用户焦点，也不覆盖切草稿后的焦点', async t => {
  for (const scenario of ['other-focus', 'keyboard', 'new-draft']) {
    const doc = focusDocument(), f = selectedContextFixture(), view = await mounted(t, f.api, doc); await view.invoke('open', firstId)
    await selectStoredContext(view, f.ids, 'direct')
    const primary = doc.element(), legacy = doc.element(), other = doc.element()
    view.setup.executionTrigger = legacy; doc.activeElement = primary; await view.invoke('openExecution'); doc.activeElement = doc.body
    let resolve!: (value: DraftSourceSnapshot) => void
    f.api.getDraftSources = async (id: string): Promise<DraftSourceSnapshot> => id === firstId ? new Promise<DraftSourceSnapshot>(done => { resolve = done }) : sources(id)
    const closing = view.invoke('closeExecution'); await new Promise<void>(done => setImmediate(done))
    if (scenario === 'other-focus') doc.activeElement = other
    if (scenario === 'keyboard') doc.interact('keydown')
    if (scenario === 'new-draft') await view.invoke('open', secondId)
    resolve(sources(firstId)); await closing
    assert.strictEqual(doc.activeElement, scenario === 'other-focus' ? other : doc.body, scenario)
  }
})


test('计划与预检只接显式工作上下文，手动入口清空上下文，激活工作库关闭面板', async t => {
  const f = selectedContextFixture(), view = await mounted(t, f.api); await view.invoke('open', firstId)
  await selectStoredContext(view, f.ids, 'prep')
  assert.equal((view.setup.nextStep as { disabled: boolean }).disabled, false, JSON.stringify({ nextStep: view.setup.nextStep, notice: view.setup.notice, workspace: view.setup.workspaceState }))
  await view.invoke('nextAction', { type: 'recording-plan' })
  assert.deepEqual(view.setup.initialRecordingPlanContext, { layoutId: f.ids.layout, mode: 'prepared-reference', preparedId: f.ids.prepared })
  assert.equal(view.setup.recordingPlan, true)
  await view.invoke('openRecordingPlan'); assert.deepEqual(view.setup.initialRecordingPlanContext, { layoutId: f.ids.layout, mode: 'prepared-reference', preparedId: f.ids.prepared })
  await view.invoke('activatedDataset'); assert.equal(view.setup.recordingPlan, false)
})

test('计划面板关闭归还本次实际触发焦点，迟到刷新不抢用户焦点', async t => {
  const doc = focusDocument(), f = selectedContextFixture(), view = await mounted(t, f.api, doc); await view.invoke('open', firstId)
  await selectStoredContext(view, f.ids, 'direct')
  // 本用例不渲染子面板，但关闭路径仍须收到已收口的子面板守卫。
  view.setup.recordingPlanPanel = { canLeave: () => true, leaveBlockReason: () => null }
  const trigger = doc.element(); doc.activeElement = trigger; await view.invoke('openRecordingPlan'); doc.activeElement = doc.body
  await view.invoke('closeRecordingPlan'); assert.strictEqual(doc.activeElement, trigger)
  doc.activeElement = trigger; await view.invoke('openRecordingPlan'); doc.activeElement = doc.body
  let resolve!: (value: DraftSourceSnapshot) => void
  f.api.getDraftSources = async (): Promise<DraftSourceSnapshot> => new Promise<DraftSourceSnapshot>(done => { resolve = done })
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
  await view.invoke('open', firstId)
  await view.click('备份与恢复')
  view.setup.title = '尚未保存的编辑'
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

test('App 侧栏导航在录音档案子面板未收口时保留录音页，关闭后才卸载', async t => {
  const guard = { value: false }
  const view = await mounted(t, apiFixture().api, focusDocument(), { actualTemplate: true, appNavigation: true, recordsGuard: guard })
  await view.invoke('openRecords')
  assert.equal(view.all().some(item => item.props['data-testid'] === 'recording-records-guard-stub'), true)
  await view.navigate('collection')
  assert.equal(view.all().some(item => item.props['data-component'] === 'RecordingView'), true, '未收口时侧栏不得卸载录音页')
  assert.match(String(view.setup.leaveGuardNotice), /设备输出尚未收口/u)
  await view.invoke('closeRecords')
  assert.equal(view.setup.recordsOpen, true, '录音页内部关闭同样受子面板守卫约束')
  guard.value = true
  await view.invoke('closeRecords')
  assert.equal(view.setup.recordsOpen, false)
  await view.navigate('collection')
  assert.equal(view.all().some(item => item.props['data-component'] === 'RecordingView'), false)
})
