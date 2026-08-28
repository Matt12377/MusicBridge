import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const id = (n: number) => `72000000-0000-4000-8000-${String(n).padStart(12, '0')}`
function fixture() {
  const calls: string[] = [], hash = 'a'.repeat(64)
  const assets = [1, 2].map(n => ({ id: id(n), draftId: id(10), layoutVersionId: id(11), masterVersionId: id(12), mode: 'direct', createdAt: '2026-08-28T00:00:00.000Z' }))
  const operations = [1, 2].map(n => ({ id: id(n + 20), assetId: id(n), draftId: id(10), layoutVersionId: id(11), masterVersionId: id(12), phase: 'FINALIZED', active: false, sourcePolicy: 'reference-dependent', objectCount: 3, copyBytes: 2048 }))
  const settings = { profile: { id: id(40), sequence: 2, content: { name: '本次明确参数' } }, overrides: { noiseReduction: null }, effective: { noiseReduction: null, calibration: '合成校准', recordLevel: '-6 dB', preRollMs: 0, signalChain: [{ id: id(45), label: '合成 DAT', kind: 'dat-recorder' }] }, format: { sampleRate: 48000, channelCount: 2, channelLayout: 'stereo', outputSampleFormat: 'pcm-s16le', internalProcessingPrecision: 'integer-bit-copy', outputBackend: { id: 'synthetic', version: '1' }, outputProfileVersion: id(40), resamplerImplementation: 'none', resamplerVersion: 'not-applied', ditherPolicy: 'none', channelMapping: 'identity' }, fingerprint: hash }
  const material = { draftId: id(10), master: { id: id(12), sequence: 1, title: '合成母版' }, layout: { id: id(11), sequence: 1, timelineHash: hash, timeline: { sides: [{ name: 'Program', totalFrames: 48000, capacityFrames: 172800000 }] } }, execution: { assetId: id(2), manifestHash: hash, mode: 'direct', audio: [] }, archive: { operationId: id(22), rootId: id(23), phase: 'FINALIZED', sourcePolicy: 'reference-dependent', manifestHash: hash, objectCount: 3, copyBytes: 2048 }, physicalCopy: { physicalId: 'MB-D-00001', lengthMinutes: 60, packaging: 'opened', usage: 'reserved' }, profileSnapshot: { sessionRevision: 3, settings }, retentionPolicy: 'f01-permanent-execution-v1', formalReady: false }
  const version = { ...material, id: id(30), sequence: 1, createdAt: '2026-08-28T00:00:00.000Z', contentHash: hash }
  return { calls, api: {
    async listExecutionAssets() { return { draftId: id(10), assets, jobs: [] } },
    async listArchives() { return { draftId: id(10), operations } },
    async listMasterVersions() { return { draftId: id(10), masters: [], layouts: [{ id: id(11), draftId: id(10), masterVersionId: id(12) }], jobs: [] } },
    async listRecordingPlans() { return { draftId: id(10), versions: [version] } },
    async getRecordingPlanVersion() { calls.push('version'); return { plan: version } },
    async previewRecordingPlan(request: { selection: unknown }) { calls.push('preview'); return { ...material, selection: request.selection, checkedAt: version.createdAt, proposalFingerprint: hash } },
    async freezeRecordingPlan() { calls.push('freeze'); return version },
    async preflightRecordingPlan() { calls.push('preflight'); return { planVersionId: version.id, checkedAt: version.createdAt, state: 'blocked', gateB: 'NOT_RUN', formalReady: false, checks: [{ category: 'backend', state: 'not-run', code: 'BACKEND_NOT_CERTIFIED' }, { category: 'archive', state: 'blocked', code: 'ARCHIVE_INVALID' }] } },
    async cancelRecordingPlanRead() { calls.push('cancel'); return { cancelled: true } },
  } }
}
async function mounted(t: test.TestContext, api: unknown) {
  const { parse, compileScript, compileTemplate } = await import('@vue/compiler-sfc'), ts = (await import('typescript')).default
  const require = createRequire(import.meta.url), vue = require('vue') as typeof import('vue')
  const source = await readFile(new URL('../src/renderer/src/components/recording/RecordingPlanPanel.vue', import.meta.url), 'utf8').catch(() => '')
  assert.ok(source, '缺少实际计划面板SFC')
  const { descriptor, errors } = parse(source); assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: 'recording-plan-panel' })
  const controller = await import('../src/renderer/src/components/recording/recording-plan-controller.js')
  const outputPanel = { default: vue.defineComponent({ props: ['plan'], setup: props => () => vue.h('section', { 'data-testid': 'output-panel-embedding', 'data-plan-id': props.plan?.id ?? '' }) }) }
  const attemptPanel = { default: vue.defineComponent({ props: ['plan'], setup: props => () => vue.h('section', { 'data-testid': 'attempt-panel-embedding', 'data-plan-id': props.plan?.id ?? '' }) }) }
  const load = (name: string) => name === 'vue' ? vue : name === './recording-plan-controller' ? controller : name === './RecordingOutputPanel.vue' ? outputPanel : name === './RecordingAttemptPanel.vue' ? attemptPanel : require(name)
  const compile = (content: string) => ts.transpileModule(content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const module = { exports: {} as { default: import('vue').Component } }
  new Function('require', 'module', 'exports', 'window', compile(script.content))(load, module, module.exports, { musicBridge: api })
  const template = compileTemplate({ id: 'recording-plan-panel', filename: 'RecordingPlanPanel.vue', source: descriptor.template!.content, compilerOptions: { bindingMetadata: script.bindings } }); assert.deepEqual(template.errors, [])
  const rendered = { exports: {} as { render: (...args: unknown[]) => unknown } }
  new Function('require', 'module', 'exports', compile(template.code))(load, rendered, rendered.exports)
  interface Host { tag: string; text: string; children: Host[]; parent: Host | null; props: Record<string, unknown>; showModal(): void; close(): void }
  const node = (tag = ''): Host => ({ tag, text: '', children: [], parent: null, props: {}, showModal() {}, close() {} })
  const renderer = vue.createRenderer<Host, Host>({ createElement: node, createText: text => ({ ...node('#text'), text }), createComment: () => node('#comment'), setText(node, text) { node.text = text }, setElementText(node, text) { node.text = text; node.children = [] }, patchProp(node, key, _old, value) { node.props[key] = value }, insert(child, parent, anchor) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; if (index < 0) parent.children.push(child); else parent.children.splice(index, 0, child) }, remove(child) { child.parent?.children.splice(child.parent.children.indexOf(child), 1); child.parent = null }, parentNode: node => node.parent, nextSibling: node => node.parent?.children[(node.parent?.children.indexOf(node) ?? -1) + 1] ?? null })
  const root = node(), app = renderer.createApp({ ...module.exports.default, render: rendered.exports.render }, { draft: { id: id(10), revision: 1, title: '合成草稿' } }); app.mount(root); t.after(() => app.unmount())
  const tick = async () => { await new Promise<void>(done => setImmediate(done)); await vue.nextTick() }; await tick()
  const all = (current = root): Host[] => [current, ...current.children.flatMap(child => all(child))]
  const text = (current = root): string => current.text + current.children.map(child => text(child)).join(' ')
  const button = (label: string) => { const result = all().find(node => node.tag === 'button' && text(node).trim() === label); assert.ok(result, label); return result }
  const click = async (label: string) => { const target = button(label); assert.notEqual(target.props.disabled, true, label); await (target.props.onClick as () => unknown)(); await tick() }
  const change = async (name: string, value: string | boolean) => { const target = all().find(node => node.props.id === name); assert.ok(target, name); (target.props.onChange as (event: unknown) => void)({ target: { value, checked: value } }); await tick() }
  return { all, text, button, click, change, tick }
}

test('实际计划面板保持空选择和禁用确认，显示保留政策且不提供正式播放按钮', async t => {
  const f = fixture(), panel = await mounted(t, f.api)
  assert.equal(panel.all().find(node => node.props.id === 'plan-asset')!.props.value, '')
  assert.equal(panel.button('核对所选资产与归档').props.disabled, true)
  assert.match(panel.text(), /Gate B.*尚未认证/u); assert.match(panel.text(), /永久保留/u)
  assert.equal(panel.all().filter(node => node.tag === 'button' && /开始录音|正式播放/u.test(panel.text(node))).length, 0)
  assert.deepEqual(f.calls, [])
})
test('实际SFC选择非首资产后预览、确认冻结、显式预检，逐项展示阻断而不冒充已就绪', async t => {
  const f = fixture(), panel = await mounted(t, f.api)
  await panel.change('plan-asset', id(2)); await panel.change('plan-archive', id(22)); await panel.click('核对所选资产与归档')
  assert.equal(panel.button('确认并冻结计划').props.disabled, true); assert.match(panel.text(), /本次明确参数/u); assert.match(panel.text(), /MB-D-00001/u)
  assert.match(panel.text(), /已开封 · 冻结时已预留/u)
  await panel.change('plan-confirm', true); await panel.click('确认并冻结计划')
  assert.deepEqual(f.calls, ['preview', 'freeze']); await panel.click('重新执行只读预检')
  assert.match(panel.text(), /BACKEND_NOT_CERTIFIED/u); assert.match(panel.text(), /归档.*完整性|归档文件/u); assert.match(panel.text(), /正式输出被阻断/u)
  assert.deepEqual(f.calls, ['preview', 'freeze', 'preflight'])
})
test('实际SFC读取失败展示alert和重试，不显示空历史结论', async t => {
  const f = fixture(); f.api.listArchives = async () => { throw new Error('/private/synthetic') }; const panel = await mounted(t, f.api)
  assert.ok(panel.all().some(node => node.props.role === 'alert')); assert.match(panel.text(), /读取失败/u); assert.doesNotMatch(panel.text(), /尚无已冻结计划|private/u)
  assert.equal(panel.button('刷新计划资料').props.disabled, false)
})
test('无设备子面板常驻接收明确历史版本，未选择时不自动绑定首份计划', async t => {
  const f = fixture(), panel = await mounted(t, f.api)
  const output = () => panel.all().find(node => node.props['data-testid'] === 'output-panel-embedding')
  assert.ok(output(), '缺少无设备面板接线'); assert.equal(output()!.props['data-plan-id'], '')
  await panel.click('查看计划第 1 版'); assert.equal(output()!.props['data-plan-id'], id(30))
})

test('Attempt面板常驻接收明确Plan，未选择时保持空上下文', async t => {
  const f = fixture(), panel = await mounted(t, f.api)
  const attempt = () => panel.all().find(node => node.props['data-testid'] === 'attempt-panel-embedding')
  assert.ok(attempt(), '缺少正式录音尝试面板接线'); assert.equal(attempt()!.props['data-plan-id'], '')
  await panel.click('查看计划第 1 版'); assert.equal(attempt()!.props['data-plan-id'], id(30))
})
