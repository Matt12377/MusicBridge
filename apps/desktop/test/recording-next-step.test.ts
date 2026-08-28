import assert from 'node:assert/strict'
import test from 'node:test'
import type { MasterDraft, SourceBinding, MediaPlan, MasterVersion, LayoutVersion, PreparationWorkspace, FrozenPrepared, ExecutionAsset, ExecutionRecipe, ResolvedRecordingSettings } from '@music-bridge/contracts'
import type { RecordingWorkflowFacts, RecordingWorkflowState, RecordingWorkflowSelection } from '../src/renderer/src/components/recording/recording-next-step.js'
import type { RecordingWorkflowApi } from '../src/renderer/src/components/recording/recording-workflow-controller.js'

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const stamp = '2026-08-28T00:00:00.000Z', hash = 'a'.repeat(64), timelineHash = 'b'.repeat(64)
const metadata = { title: '合成曲目', artist: '合成作者', durationMs: 1000 }
function sample() {
  const draft: MasterDraft = { id: id(1), title: '合成草稿', revision: 1, status: 'draft', programType: 'continuous', sourceLockEligible: true, trackCount: 1, tracks: [{ id: id(2), source: 'roon', metadata }] }
  const binding: SourceBinding = { id: id(3), rootId: id(4), fileName: '合成.wav', acquisition: 'userFileBind', verification: 'fileHashVerified', preservation: 'externalReferenceOnly', availability: 'ONLINE', sha256: hash, size: 192044, modifiedAt: stamp, verifiedAt: stamp, technical: { container: 'wav', codec: 'pcm', sampleRate: 48000, channels: 2, durationMs: 1000, bitsPerSample: 16, lossless: true, sampleFrames: 48000, frameEvidence: 'container-declared' }, userConfirmed: true, sourceLockEligible: true }
  const spec = { format: 'dat' as const, splitAfter: 0, leadInMs: 0, tailMs: 0, defaultGapMs: 0, rules: [], compatibility: { confirmed: true, cassetteTypes: [], dat: true } }
  const reservation = { physicalId: 'MB-D-00001', modelId: id(5), skuId: id(6), packaging: 'opened' as const }
  const plan: MediaPlan = { id: id(7), draftId: draft.id, draftRevision: 1, revision: 1, spec, layout: { timebase: 'milliseconds', executionReady: false, sides: [{ name: 'Program', tracks: [{ trackId: id(2), startMs: 0, endMs: 1000, gapAfterMs: 0 }], durationMs: 1000, musicMs: 1000, gapMs: 0, leadInMs: 0, tailMs: 0 }], constraints: [] }, sourceBasis: 'verified-sources', inputFingerprint: hash, reservation, requiresReview: false, executionReady: false }
  const master: MasterVersion = { id: id(8), draftId: draft.id, sequence: 1, title: draft.title, createdAt: stamp, status: 'frozen', contentHash: hash, content: { programType: draft.programType, tracks: [{ trackId: id(2), metadata, source: { sha256: hash, size: binding.size, technical: { ...binding.technical, sampleFrames: 48000, frameEvidence: 'container-declared' } }, transitionAfterMs: 0, keepWithNext: false }] }, sourceEvidence: [{ trackId: id(2), binding }] }
  const layout: LayoutVersion = { id: id(9), draftId: draft.id, masterVersionId: master.id, sequence: 1, planId: plan.id, createdAt: stamp, spec, lengthMinutes: 60, reservation, timeline: { timebase: 'sample-frames', sampleRate: 48000, rounding: 'nearest-half-up-v1', sides: [{ name: 'Program', capacityFrames: 172800000, leadInFrames: 0, tailFrames: 0, totalFrames: 48000, tracks: [{ trackId: id(2), sourceBindingId: binding.id, sourceSampleRate: 48000, sourceFrames: 48000, startFrame: 0, endFrame: 48000, gapAfterFrames: 0 }] }] }, timelineHash, status: 'frozen', executionReady: false }
  const preparation: PreparationWorkspace = { id: id(10), draftId: draft.id, masterVersionId: master.id, layoutVersionId: layout.id, destinationId: id(11), createdAt: stamp, manifestHash: hash, trackCount: 1, bytes: binding.size, kind: 'logic-working-copy', executionReady: false }
  const prepared: FrozenPrepared = { id: id(12), draftId: draft.id, sequence: 1, preparationId: preparation.id, importJobId: id(13), masterVersionId: master.id, layoutVersionId: layout.id, contentHash: hash, plannedTimelineHash: timelineHash, plannedTimeline: layout.timeline, renderTimeline: { timebase: 'sample-frames', sides: [{ name: 'Program', renderAssetId: id(14), renderFileHash: hash, sampleRate: 48000, channelLayout: 'stereo', totalFrames: 48000, markers: [{ trackId: id(2), exactSourceSha256: hash, actualStartFrame: 0, actualEndFrame: 48000, actualGapToNextFrames: 0, confirmationMethod: 'manual', userConfirmed: true }] }] }, renderTimelineHash: hash, assets: [{ id: id(14), side: 'Program', sha256: hash, size: binding.size, format: 'wav', sampleRate: 48000, channelLayout: 'stereo', totalFrames: 48000, createdAt: stamp, creationTimeEvidence: 'first-observed' }], conformance: { status: 'MATCHED', policy: 'one-render-frame-v1', reasons: [] }, varianceReason: '', daw: '合成 Logic', processingLineage: '合成处理记录', createdAt: stamp, transitionRenderingMode: 'Baked Into Render', status: 'frozen', executionReady: false }
  const facts: RecordingWorkflowFacts = { sources: { draftId: draft.id, sourceLockEligible: true, tracks: [{ trackId: id(2), binding, jobs: [] }] }, plans: { draftId: draft.id, plans: [plan] }, versions: { draftId: draft.id, masters: [master], layouts: [layout], jobs: [] }, preparations: { draftId: draft.id, workspaces: [preparation], jobs: [] }, prepared: { draftId: draft.id, preps: [prepared], jobs: [] }, execution: { draftId: draft.id, assets: [], jobs: [] } }
  facts.prepared.jobs = [{ id: prepared.importJobId, draftId: draft.id, preparationId: preparation.id, destinationId: id(11), state: 'completed', completedFiles: 1, totalFiles: 1, assets: prepared.assets, manifestHash: hash }]
  const selection: RecordingWorkflowSelection = { planId: plan.id, layoutId: layout.id, path: 'direct' }
  const state: RecordingWorkflowState = { draftId: draft.id, draftRevision: 1, status: 'ready', facts, selection, error: '' }
  return { draft, binding, plan, master, layout, preparation, prepared, facts, state }
}
async function reducer() {
  const module = await import('../src/renderer/src/components/recording/recording-next-step.js').catch(() => ({}))
  assert.ok('getRecordingNextStep' in module, '缺少只读下一步归纳器')
  return (module as typeof import('../src/renderer/src/components/recording/recording-next-step.js')).getRecordingNextStep
}
async function controllerFixture() {
  const module = await import('../src/renderer/src/components/recording/recording-workflow-controller.js').catch(() => ({}))
  assert.ok('createRecordingWorkflowController' in module, '缺少代际隔离的只读工作状态控制器')
  const f = sample(), calls: string[] = []
  const api: RecordingWorkflowApi = {
    async getDraftSources() { calls.push('sources'); return structuredClone(f.facts.sources) },
    async listMediaPlans() { calls.push('plans'); return structuredClone(f.facts.plans) },
    async listMasterVersions() { calls.push('versions'); return structuredClone(f.facts.versions) },
    async listPreparations() { calls.push('preparations'); return structuredClone(f.facts.preparations) },
    async listPrepared() { calls.push('prepared'); return structuredClone(f.facts.prepared) },
    async listExecutionAssets() { calls.push('execution'); return structuredClone(f.facts.execution) },
  }
  const create = (module as typeof import('../src/renderer/src/components/recording/recording-workflow-controller.js')).createRecordingWorkflowController
  const controller = create({ api }); controller.setDraft(f.draft)
  return { ...f, calls, api, controller }
}
const input = (f: ReturnType<typeof sample>) => ({ draft: f.draft, pending: false, dirty: false, busy: false, workflow: f.state })

test('原命令与未保存修改优先；读取失败和未读取不能伪装成未配置', async () => {
  const next = await reducer(), f = sample(), props = input(f)
  f.state.status = 'error'; f.state.error = '工作状态读取失败，请重试。'
  assert.equal(next({ ...props, pending: true, dirty: true }).action.type, 'retry-pending')
  assert.equal(next({ ...props, pending: true, busy: true }).disabled, true)
  assert.equal(next({ ...props, dirty: true }).label, '保存当前草稿')
  assert.equal(next(props).action.type, 'refresh')
  for (const status of ['unread', 'loading'] as const) { f.state.status = status; const value = next(props); assert.equal(value.action.type, 'refresh'); assert.equal(value.disabled, status === 'loading') }
  assert.equal(next({ ...props, draft: undefined }).action.type, 'pick-source')
})

test('空草稿只选曲；源运行、缺失、离线、变化、撤权、未确认均阻止后续', async () => {
  const next = await reducer()
  const empty = sample(); empty.draft.tracks = []; empty.draft.trackCount = 0; empty.facts.sources.tracks = []
  assert.equal(next(input(empty)).action.type, 'pick-source')
  for (const availability of ['SOURCE_ROOT_OFFLINE', 'MISSING', 'CONTENT_CHANGED', 'REVOKED'] as const) {
    const f = sample(); f.binding.availability = availability; f.binding.sourceLockEligible = false; f.facts.sources.sourceLockEligible = false
    assert.deepEqual(next(input(f)).action, { type: 'source', trackId: id(2) })
  }
  const missing = sample(); missing.facts.sources.tracks = [{ trackId: id(2), jobs: [] }]
  assert.equal(next(input(missing)).action.type, 'source')
  const unconfirmed = sample(); unconfirmed.binding.userConfirmed = false; unconfirmed.binding.sourceLockEligible = false
  assert.match(next(input(unconfirmed)).description, /确认/u)
  const running = sample(); running.facts.sources.tracks = [{ trackId: id(2), binding: running.binding, jobs: [{ id: id(20), draftId: id(1), trackId: id(2), rootId: id(4), state: 'running' }] }]
  assert.match(next(input(running)).title, /进行中/u)
  assert.equal(next(input(running)).step, 1)
})

test('规划与布局必须显式选择，历史数组顺序不能替用户选latest', async () => {
  const next = await reducer(), f = sample()
  f.state.selection = {}
  assert.equal(next(input(f)).action.type, 'choose-context')
  f.state.selection = { planId: f.plan.id }; assert.equal(next(input(f)).action.type, 'choose-context')
  f.facts.versions.layouts = []; assert.equal(next(input(f)).action.type, 'versions')
  f.state.selection = {}; f.facts.plans.plans = []; assert.equal(next(input(f)).action.type, 'media')
})

test('规划需复核、来源估计、缺少预留或草稿revision变化不能推进', async () => {
  const next = await reducer()
  for (const alter of [(f: ReturnType<typeof sample>) => { f.plan.requiresReview = true }, (f: ReturnType<typeof sample>) => { f.plan.sourceBasis = 'roon-estimate' }, (f: ReturnType<typeof sample>) => { f.plan.reservation = undefined }, (f: ReturnType<typeof sample>) => { f.plan.draftRevision = 2 }]) {
    const f = sample(); alter(f); const value = next(input(f)); assert.equal(value.action.type, 'media'); assert.equal(value.step, 2)
  }
  const f = sample(); f.state.draftRevision = 2; assert.equal(next(input(f)).action.type, 'refresh')
})

test('母版内容/源hash/规划spec/预留及跨草稿谱系变化均不能把旧冻结历史当当前', async () => {
  const next = await reducer()
  for (const alter of [
    (f: ReturnType<typeof sample>) => { f.binding.sha256 = 'c'.repeat(64) },
    (f: ReturnType<typeof sample>) => { f.master.content = { ...f.master.content, tracks: f.master.content.tracks.map(track => ({ ...track, metadata: { title: '别的曲目' } })) } },
    (f: ReturnType<typeof sample>) => { f.layout.spec = { ...f.layout.spec, tailMs: 1000 } },
    (f: ReturnType<typeof sample>) => { f.layout.reservation = { ...f.layout.reservation, physicalId: 'MB-' + 'B'.repeat(12) } },
    (f: ReturnType<typeof sample>) => { f.layout.planId = id(21) },
    (f: ReturnType<typeof sample>) => { f.layout.masterVersionId = id(22) },
  ]) { const f = sample(); alter(f); assert.equal(next(input(f)).action.type, 'versions') }
  const wrong = sample(); wrong.master.draftId = id(23); assert.equal(next(input(wrong)).action.type, 'refresh')
})

test('Direct不受无关Logic历史绑架，Logic和PREP均要求所选工作区与PREP完整谱系', async () => {
  const next = await reducer(), f = sample()
  let value = next(input(f)); assert.equal(value.action.type, 'execution'); assert.equal(value.formalReady, false); assert.match(value.description, /正式预检/u)
  f.state.selection.path = undefined; assert.equal(next(input(f)).action.type, 'choose-context')
  for (const path of ['logic', 'prep'] as const) {
    f.state.selection = { planId: f.plan.id, layoutId: f.layout.id, path }
    assert.equal(next(input(f)).action.type, 'choose-context')
    f.state.selection.preparationId = f.preparation.id; assert.equal(next(input(f)).action.type, 'choose-context')
    f.state.selection.preparedId = f.prepared.id; assert.equal(next(input(f)).action.type, 'execution')
    f.prepared.plannedTimelineHash = 'c'.repeat(64); assert.equal(next(input(f)).action.type, 'prepared'); f.prepared.plannedTimelineHash = timelineHash
    f.prepared.preparationId = id(24); assert.equal(next(input(f)).action.type, 'prepared'); f.prepared.preparationId = f.preparation.id
  }
})

test('Logic缺工作区/PREP及有关任务运行时只引导已有工具，不执行预检或写入', async () => {
  const next = await reducer(), f = sample(); f.state.selection.path = 'logic'; f.facts.preparations.workspaces = []
  assert.deepEqual(next(input(f)).action, { type: 'preparation', layoutId: f.layout.id })
  f.facts.preparations.workspaces = [f.preparation]; f.state.selection.preparationId = f.preparation.id; f.facts.prepared.preps = []
  assert.deepEqual(next(input(f)).action, { type: 'prepared', preparationId: f.preparation.id })
  f.facts.preparations.jobs = [{ id: id(25), draftId: f.draft.id, layoutVersionId: f.layout.id, destinationId: id(11), state: 'running', completedTracks: 0, totalTracks: 1 }]
  assert.match(next(input(f)).title, /进行中/u)
  assert.equal(next(input(f)).action.type, 'preparation')
})

test('合法发布历史只证明发布时事实，执行任务按所选布局路径过滤，始终不显示正式就绪', async () => {
  const next = await reducer(), f = sample(), dto = await import('@music-bridge/contracts')
  assert.ok(dto.isMasterDraft(f.draft)); assert.ok(dto.isDraftSourceSnapshot(f.facts.sources)); assert.ok(dto.isMediaPlan(f.plan))
  assert.ok(dto.isVersionHistory(f.facts.versions)); assert.ok(dto.isPreparationHistory(f.facts.preparations)); assert.ok(dto.isPreparedHistory(f.facts.prepared))
  const executionFormat = { sampleRate: 48000, channelCount: 2 as const, channelLayout: 'stereo' as const, internalProcessingPrecision: 'integer-bit-copy' as const, outputSampleFormat: 'pcm-s16le' as const, resamplerImplementation: 'none', resamplerVersion: 'not-applied', ditherPolicy: 'none' as const, channelMapping: 'identity' as const, outputBackend: { id: 'synthetic', version: '1' } }
  const defaults = { noiseReduction: null, calibration: null, recordLevel: null, preRollMs: 0 }, signalChain = [{ id: id(30), kind: 'dat-recorder' as const, label: '合成 DAT' }]
  const settings: ResolvedRecordingSettings = { profile: { id: id(31), profileId: id(32), sequence: 1, createdAt: stamp, content: { name: '合成参数', signalChain, defaults, compatibility: f.plan.spec.compatibility, executionFormat }, contentHash: hash }, overrides: {}, effective: { ...defaults, signalChain }, format: { ...executionFormat, outputProfileVersion: id(31) }, fingerprint: hash }
  const recipe: ExecutionRecipe = { schemaVersion: 1, mode: 'direct', compiler: 'musicbridge-pcm-copy-v1', masterVersionId: f.master.id, layoutVersionId: f.layout.id, contentHash: hash, plannedTimelineHash: timelineHash, format: settings.format, side: 'Program', capacityFrames: 172800000, totalFrames: 48000, segments: [{ kind: 'source', trackId: id(2), input: { sha256: hash, size: 192044, sampleRate: 48000, channelCount: 2, bitsPerSample: 16, totalFrames: 48000 }, startFrame: 0, endFrame: 48000 }], formalReady: false }
  const asset: ExecutionAsset = { id: id(33), draftId: f.draft.id, masterVersionId: f.master.id, layoutVersionId: f.layout.id, destinationId: id(11), mode: 'direct', settings, recipes: [recipe], audio: [{ recipe, recipeHash: hash, origin: 'compiled', audio: { sha256: hash, size: 192044, pcmSha256: hash, dataOffset: 44, frameCount: 48000 }, formalReady: false }], manifestHash: hash, createdAt: stamp, state: 'verified-at-publication', retentionPolicy: 'unresolved-no-automatic-deletion', formalReady: false }
  assert.ok(dto.isExecutionAsset(asset)); f.facts.execution.assets = [asset]
  const before = JSON.stringify(f.facts), published = next(input(f)); assert.match(published.description, /已有对应发布历史.*仍需显式核验/u); assert.equal(published.formalReady, false); assert.equal(published.action.type, 'execution'); assert.equal(JSON.stringify(f.facts), before)
  f.facts.execution.jobs = [{ id: id(34), draftId: f.draft.id, layoutVersionId: f.layout.id, destinationId: id(11), profileVersionId: id(31), mode: 'prepared-reference', state: 'running', completedSides: 0, totalSides: 1 }]
  assert.doesNotMatch(next(input(f)).title, /进行中/u)
  f.facts.execution.jobs = f.facts.execution.jobs.map(job => ({ ...job, mode: 'direct' }))
  assert.match(next(input(f)).title, /进行中/u); assert.equal(next(input(f)).formalReady, false)
})

test('只调用六个事实读取，默认无历史选择；同草稿刷新只保留一致上下文', async () => {
  const f = await controllerFixture(); assert.equal(f.controller.state.status, 'unread'); assert.deepEqual(f.calls, [])
  await f.controller.refresh(); assert.equal(f.controller.state.status, 'ready'); assert.deepEqual(f.calls.sort(), ['execution', 'plans', 'preparations', 'prepared', 'sources', 'versions'])
  assert.deepEqual(f.controller.state.selection, {})
  f.controller.select(f.state.selection); await f.controller.refresh(); assert.deepEqual(f.controller.state.selection, f.state.selection)
  f.plan.revision++; f.plan.spec = { ...f.plan.spec, tailMs: 1000 }; await f.controller.refresh()
  assert.equal(f.controller.state.selection.planId, undefined); assert.equal(f.controller.state.selection.layoutId, undefined)
  f.controller.dispose()
})

test('显式切规划/布局/路径清除下游选择，不能跨历史分支拼接', async () => {
  const f = await controllerFixture(); await f.controller.refresh()
  f.controller.select({ ...f.state.selection, path: 'prep', preparationId: f.preparation.id, preparedId: f.prepared.id })
  assert.equal(f.controller.state.selection.preparedId, f.prepared.id)
  f.controller.select({ path: 'direct' }); assert.equal(f.controller.state.selection.preparationId, undefined); assert.equal(f.controller.state.selection.preparedId, undefined)
  f.controller.select({ layoutId: id(99) }); assert.equal(f.controller.state.selection.layoutId, undefined)
  f.controller.select({ planId: undefined }); assert.equal(f.controller.state.selection.layoutId, undefined)
  f.controller.dispose()
})

test('单项失败保持error不伪空，并拒绝错误草稿的源或历史读取', async () => {
  for (const failed of ['getDraftSources', 'listMediaPlans', 'listMasterVersions', 'listPreparations', 'listPrepared', 'listExecutionAssets'] as const) {
    const f = await controllerFixture(); f.api[failed] = async () => { throw new Error('/private/不得泄露') }
    await f.controller.refresh(); assert.equal(f.controller.state.status, 'error'); assert.doesNotMatch(f.controller.state.error, /private/u); f.controller.dispose()
  }
  const f = await controllerFixture(); f.facts.execution.draftId = id(99); await f.controller.refresh(); assert.equal(f.controller.state.status, 'error'); f.controller.dispose()
})

test('草稿revision/切库重置和卸载使迟到读取失效，同次刷新只收最新代际', async () => {
  const f = await controllerFixture(); await f.controller.refresh(); f.controller.select(f.state.selection)
  let resolve!: (value: typeof f.facts.sources) => void
  f.api.getDraftSources = () => new Promise(value => { resolve = value })
  const pending = f.controller.refresh(); f.controller.setDraft({ ...f.draft, revision: 2 })
  assert.deepEqual(f.controller.state.selection, {}); resolve(f.facts.sources); await pending; assert.equal(f.controller.state.status, 'unread'); assert.equal(f.controller.state.draftRevision, 2)
  const resetRead = f.controller.refresh(); f.controller.reset(); resolve(f.facts.sources); await resetRead; assert.equal(f.controller.state.draftId, null); assert.equal(f.controller.state.facts, undefined)
  f.controller.setDraft(f.draft); const disposeRead = f.controller.refresh(); f.controller.dispose(); const before = structuredClone(f.controller.state); resolve(f.facts.sources); await disposeRead; assert.deepEqual(f.controller.state, before)
})

test('源内容变化刷新撤销旧布局及PREP选择；晚到上一轮不覆盖新事实', async () => {
  const f = await controllerFixture(); await f.controller.refresh(); f.controller.select({ ...f.state.selection, path: 'prep', preparationId: f.preparation.id, preparedId: f.prepared.id })
  f.binding.sha256 = 'c'.repeat(64); await f.controller.refresh(); assert.equal(f.controller.state.selection.layoutId, undefined); assert.equal(f.controller.state.selection.preparedId, undefined)
  let resolve!: (value: typeof f.facts.sources) => void
  f.api.getDraftSources = () => new Promise(value => { resolve = value }); const old = f.controller.refresh()
  f.api.getDraftSources = async () => structuredClone(f.facts.sources); await f.controller.refresh(); const current = structuredClone(f.controller.state)
  resolve({ ...f.facts.sources, draftId: id(99) }); await old; assert.deepEqual(f.controller.state, current); f.controller.dispose()
})

async function mountedNextStep(t: test.TestContext, props: Record<string, unknown>) {
  const { readFile } = await import('node:fs/promises'), { createRequire } = await import('node:module')
  const { parse, compileScript } = await import('@vue/compiler-sfc'), ts = (await import('typescript')).default
  const require = createRequire(import.meta.url), vue = require('vue') as typeof import('vue')
  const source = await readFile(new URL('../src/renderer/src/components/recording/RecordingNextStep.vue', import.meta.url), 'utf8')
  const { descriptor, errors } = parse(source); assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: 'recording-next-step-behavior', inlineTemplate: true })
  const compiled = ts.transpileModule(script.content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const helpers = await import('../src/renderer/src/components/recording/recording-next-step.js')
  const module = { exports: {} as { default: import('vue').Component } }
  new Function('require', 'module', 'exports', compiled)((name: string) => name.includes('recording-next-step') ? helpers : name === 'vue' ? vue : require(name), module, module.exports)
  interface Host { tag: string; text: string; props: Record<string, unknown>; children: Host[]; parent: Host | null; value: unknown; focused: boolean; focus(): void; querySelectorAll(): Host[] }
  function node(tag = ''): Host {
    return { tag, text: '', props: {}, children: [], parent: null, get value() { return this.props.value }, focused: false,
      focus() { this.focused = true }, querySelectorAll() { return descendants(this).filter(item => item.tag === 'select' && !item.props.disabled) } }
  }
  const descendants = (root: Host): Host[] => [root, ...root.children.flatMap(descendants)]
  const renderer = vue.createRenderer<Host, Host>({ createElement: node, createText: text => ({ ...node('#text'), text }), createComment: node,
    setText(item, text) { item.text = text }, setElementText(item, text) { item.text = text }, patchProp(item, key, _old, value) { item.props[key] = value },
    insert(child, parent) { child.parent = parent; parent.children.push(child) }, remove(child) { if (child.parent) child.parent.children = child.parent.children.filter(value => value !== child) }, parentNode: item => item.parent, nextSibling: () => null,
  })
  const root = node(), app = renderer.createApp(module.exports.default, props); app.mount(root); t.after(() => app.unmount())
  await vue.nextTick()
  const text = (host: Host): string => host.text + host.children.map(text).join('')
  return { nodes: () => descendants(root), text: () => text(root), tick: vue.nextTick }
}

test('实际下一步组件只有一个主CTA，选择可见且只emit不写数据；选择上下文可聚焦', async t => {
  const next = await reducer(), f = sample(); f.state.selection = {}
  const actions: unknown[] = [], selections: unknown[] = []
  const mounted = await mountedNextStep(t, { state: f.state, nextStep: next(input(f)), onAction: (value: unknown) => actions.push(value), onSelect: (value: unknown) => selections.push(value) })
  const buttons = mounted.nodes().filter(node => node.tag === 'button')
  assert.equal(buttons.length, 1); assert.equal(buttons[0]!.props['data-testid'], 'recording-next-action')
  assert.ok(mounted.nodes().some(node => node.props['data-testid'] === 'recording-next-step'))
  assert.match(mounted.text(), /本次媒体规划/u); assert.match(mounted.text(), /本次冻结布局/u); assert.match(mounted.text(), /本次处理路径/u)
  ;(buttons[0]!.props.onClick as () => void)()
  assert.deepEqual(actions, [{ type: 'choose-context' }]); assert.ok(mounted.nodes().some(node => node.tag === 'select' && node.focused))
  const select = mounted.nodes().find(node => node.tag === 'select' && !node.props.disabled)!
  ;(select.props.onChange as (event: unknown) => void)({ target: { value: f.plan.id } })
  assert.deepEqual(selections, [{ planId: f.plan.id }]); assert.deepEqual(f.state.selection, {})
})

test('实际组件pending/dirty只锁上下文，原命令重试与保存当前草稿仍可emit', async t => {
  const next = await reducer()
  for (const flag of ['pending', 'dirty'] as const) {
    const f = sample(), actions: unknown[] = [], value = next({ ...input(f), [flag]: true })
    const mounted = await mountedNextStep(t, { state: f.state, nextStep: value, disabled: true, onAction: (action: unknown) => actions.push(action) })
    assert.ok(mounted.nodes().find(node => node.tag === 'fieldset')?.props.disabled)
    const button = mounted.nodes().find(node => node.tag === 'button')!
    assert.equal(button.props.disabled, false); (button.props.onClick as () => void)(); assert.deepEqual(actions, [value.action])
  }
  const f = sample(), actions: unknown[] = []
  const mounted = await mountedNextStep(t, { state: f.state, nextStep: next({ ...input(f), pending: true, busy: true }), onAction: (action: unknown) => actions.push(action) })
  const button = mounted.nodes().find(node => node.tag === 'button')!
  assert.equal(button.props.disabled, true); (button.props.onClick as () => void)(); assert.deepEqual(actions, [])
})
