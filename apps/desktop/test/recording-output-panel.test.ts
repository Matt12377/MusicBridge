import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import type { RecordingOutputCheckRequest, RecordingOutputCheckResult, RecordingOutputPublicApi, RecordingOutputStatus, RecordingPlanVersion } from '@music-bridge/contracts'

const id = (n: number) => `73000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const hash = 'a'.repeat(64), helperHash = 'b'.repeat(64), pcmHash = 'c'.repeat(64)
function plan(n = 1): RecordingPlanVersion {
  // 仅模拟此面板读取的冻结字段，完整跨字段合同由正式Core/合同测试负责。
  return { id: id(n), sequence: n, status: 'frozen', contentHash: hash, formalReady: false,
    execution: { audio: ['A', 'B'].map((side, index) => ({ recipe: { side }, audio: { frameCount: index ? 40 : 30, pcmSha256: pcmHash } })) },
  } as unknown as RecordingPlanVersion
}
const available: RecordingOutputStatus = { backend: { id: 'musicbridge-coreaudio-hal', version: '0.1.0', halAdapterCompiled: true }, syntheticCheck: { available: true, helperSha256: helperHash, protocolVersion: 1 }, deviceAccess: 'not-authorized', gateB: 'NOT_RUN', formalReady: false }
function result(request: RecordingOutputCheckRequest): RecordingOutputCheckResult {
  return { ...request, state: 'verified', planContentHash: hash, frameCount: request.side === 'B' ? 40 : 30, consumedFrames: request.side === 'B' ? 40 : 30, pcmSha256: pcmHash, helperSha256: helperHash, deviceOpened: false, formalReady: false, gateB: 'NOT_RUN', evidence: 'synthetic-only' }
}
function deferred<T>() { let resolve!: (v: T) => void, reject!: (e: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function fixture() {
  const checks: RecordingOutputCheckRequest[] = [], cancels: string[] = [], reads: string[] = []
  const api: RecordingOutputPublicApi = {
    async getRecordingOutputStatus() { reads.push('status'); return structuredClone(available) },
    async checkRecordingOutput(request) { checks.push(structuredClone(request)); return result(request) },
    async cancelRecordingOutputCheck(runId) { cancels.push(runId); return { cancelled: true } },
  }
  return { api, checks, cancels, reads }
}
async function controller(f = fixture()) {
  const module = await import('../src/renderer/src/components/recording/recording-output-controller.js').catch(() => ({}))
  assert.ok('createRecordingOutputController' in module, '缺少无设备输出检查控制器')
  const c = (module as typeof import('../src/renderer/src/components/recording/recording-output-controller.js')).createRecordingOutputController({ api: f.api })
  c.setPlan(plan()); await c.refreshStatus()
  return { ...f, c }
}

test('只读status、不默认选择面或自动check；仅接受明确冻结计划的非空面', async () => {
  const f = await controller()
  assert.deepEqual(f.reads, ['status']); assert.deepEqual(f.checks, []); assert.equal(f.c.state.phase, 'unchecked'); assert.equal(f.c.state.side, '')
  await f.c.check(); assert.equal(f.checks.length, 0)
  const selected = plan(); selected.execution.audio[1]!.audio.frameCount = 0
  f.c.setPlan(selected); assert.deepEqual(f.c.sides(), ['A']); f.c.selectSide('B'); assert.equal(f.c.state.side, '')
  f.c.selectSide('A'); assert.equal(f.c.canCheck(), true)
  f.c.setPlan({ ...plan(), status: 'proposal' } as never); assert.equal(f.c.canCheck(), false); f.c.dispose()
})
test('显式检查发送唯一DTO并匹配完整回执，重复点击不产生并行run', async () => {
  const f = fixture(), wait = deferred<RecordingOutputCheckResult>()
  f.api.checkRecordingOutput = async request => { f.checks.push(request); return wait.promise }
  const { c } = await controller(f); c.selectSide('B'); const pending = c.check(); await c.check()
  assert.equal(f.checks.length, 1); assert.deepEqual(Object.keys(f.checks[0]!).sort(), ['planVersionId', 'runId', 'side']); assert.equal(c.state.phase, 'checking')
  wait.resolve(result(f.checks[0]!)); await pending
  assert.equal(c.state.phase, 'verified'); assert.equal(c.state.result?.side, 'B'); assert.equal(c.state.result?.formalReady, false); c.dispose()
})
test('状态缺包、异常及伪造认证均禁用；status迟到不覆盖更新读取', async () => {
  const f = fixture(); f.api.getRecordingOutputStatus = async () => ({ ...available, backend: { ...available.backend, halAdapterCompiled: false }, syntheticCheck: { ...available.syntheticCheck, available: false, helperSha256: null } })
  const { c } = await controller(f); c.selectSide('A'); assert.equal(c.canCheck(), false); assert.equal(c.state.statusPhase, 'ready')
  f.api.getRecordingOutputStatus = async () => { throw new Error('/private/status') }; await c.refreshStatus(); assert.equal(c.state.statusPhase, 'error'); assert.ok(!c.state.statusError.includes('/private/'))
  f.api.getRecordingOutputStatus = async () => ({ ...available, formalReady: true } as never); await c.refreshStatus(); assert.equal(c.canCheck(), false)
  const wait = deferred<RecordingOutputStatus>(); f.api.getRecordingOutputStatus = () => wait.promise; const old = c.refreshStatus()
  f.api.getRecordingOutputStatus = async () => available; await c.refreshStatus(); wait.reject(new Error('迟到失败')); await old
  assert.equal(c.state.statusPhase, 'ready'); assert.equal(c.canCheck(), true); c.dispose()
})
test('回执任一身份、音频或边界不匹配都不能显示通过', async () => {
  for (const mismatch of [{ runId: id(90) }, { planVersionId: id(91) }, { planContentHash: 'd'.repeat(64) }, { side: 'B' }, { frameCount: 29, consumedFrames: 29 }, { pcmSha256: 'd'.repeat(64) }, { helperSha256: 'd'.repeat(64) }, { formalReady: true }, { deviceOpened: true }, { extra: 'private' }]) {
    const f = fixture(); f.api.checkRecordingOutput = async request => ({ ...result(request), ...mismatch } as never)
    const { c } = await controller(f); c.selectSide('A'); await c.check(); assert.equal(c.state.phase, 'error'); assert.equal(c.state.result, undefined); c.dispose()
  }
})
test('切换plan或side立即取消并失效，原检查结束前不能发起第二个run', async () => {
  for (const change of ['plan', 'side']) {
    const f = fixture(), wait = deferred<RecordingOutputCheckResult>()
    f.api.checkRecordingOutput = async request => { f.checks.push(request); return wait.promise }
    const { c } = await controller(f); c.selectSide('A'); const pending = c.check()
    if (change === 'plan') c.setPlan(plan(2)); else c.selectSide('B')
    await Promise.resolve(); assert.deepEqual(f.cancels, [f.checks[0]!.runId]); assert.equal(c.state.phase, 'cancelling'); assert.equal(c.canCheck(), false)
    wait.resolve(result(f.checks[0]!)); await pending
    assert.equal(c.state.result, undefined); assert.notEqual(c.state.phase, 'verified'); c.dispose()
  }
})
test('取消回执不是停止证明；取消失败可同run重试且不开放并发', async () => {
  const f = fixture(), wait = deferred<RecordingOutputCheckResult>(), cancel = deferred<{ cancelled: true }>()
  f.api.checkRecordingOutput = async request => { f.checks.push(request); return wait.promise }
  f.api.cancelRecordingOutputCheck = async runId => { f.cancels.push(runId); return cancel.promise }
  const { c } = await controller(f); c.selectSide('A'); const pending = c.check(), cancellation = c.cancel()
  assert.equal(c.state.phase, 'cancelling'); assert.equal(c.state.cancelSending, true)
  cancel.reject(new Error('/private/cancel')); await cancellation; assert.equal(c.state.phase, 'cancel-failed'); assert.equal(c.canCheck(), false)
  f.api.cancelRecordingOutputCheck = async runId => { f.cancels.push(runId); return { cancelled: true } }; await c.cancel()
  assert.deepEqual(f.cancels, [f.checks[0]!.runId, f.checks[0]!.runId]); assert.equal(c.state.phase, 'cancelling'); assert.equal(c.canCheck(), false)
  wait.resolve(result(f.checks[0]!)); await pending; assert.equal(c.state.result, undefined); assert.equal(c.state.phase, 'cancelled'); c.dispose()
})
test('dispose取消活动run，任何迟到结果或status不再通知或恢复', async () => {
  const f = fixture(), wait = deferred<RecordingOutputCheckResult>()
  f.api.checkRecordingOutput = async request => { f.checks.push(request); return wait.promise }
  const { c } = await controller(f); c.selectSide('A'); const pending = c.check(); c.dispose(); wait.resolve(result(f.checks[0]!)); await pending
  assert.deepEqual(f.cancels, [f.checks[0]!.runId]); assert.equal(c.state.result, undefined); await c.check(); assert.equal(f.checks.length, 1)
})
test('检查异常只显示有界中文错误，已通过结果在换面后清空', async () => {
  const f = await controller(); f.c.selectSide('A'); await f.c.check(); assert.equal(f.c.state.phase, 'verified')
  f.c.selectSide('B'); assert.equal(f.c.state.result, undefined); assert.equal(f.c.state.phase, 'unchecked')
  f.api.checkRecordingOutput = async () => { throw new Error('/private/input.wav') }; await f.c.check()
  assert.equal(f.c.state.phase, 'error'); assert.ok(!f.c.state.error.includes('/private/')); f.c.dispose()
})
test('重新读取检查能力清除上次通过，不能在检查包失效时保留当前通过提示', async () => {
  const f = await controller(); f.c.selectSide('A'); await f.c.check(); assert.equal(f.c.state.phase, 'verified')
  f.api.getRecordingOutputStatus = async () => { throw new Error('已断开') }; await f.c.refreshStatus()
  assert.equal(f.c.state.result, undefined); assert.equal(f.c.state.phase, 'unchecked'); assert.equal(f.c.canCheck(), false); f.c.dispose()
})
test('DAT只列非空Program，不猜A/B或自动发起检查', async () => {
  const f = await controller(), selected = plan()
  selected.execution.audio = [selected.execution.audio[0]!]; selected.execution.audio[0]!.recipe.side = 'Program'
  f.c.setPlan(selected); assert.deepEqual(f.c.sides(), ['Program']); assert.equal(f.c.state.side, '')
  f.c.selectSide('Program'); await f.c.check(); assert.equal(f.checks[0]!.side, 'Program'); assert.equal(f.c.state.phase, 'verified'); f.c.dispose()
})

async function mounted(t: test.TestContext, api: RecordingOutputPublicApi) {
  const { parse, compileScript, compileTemplate } = await import('@vue/compiler-sfc'), ts = (await import('typescript')).default
  const require = createRequire(import.meta.url), vue = require('vue') as typeof import('vue')
  const source = await readFile(new URL('../src/renderer/src/components/recording/RecordingOutputPanel.vue', import.meta.url), 'utf8').catch(() => '')
  assert.ok(source, '缺少实际无设备面板SFC'); const { descriptor, errors } = parse(source); assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: 'recording-output-panel' })
  const controller = await import('../src/renderer/src/components/recording/recording-output-controller.js')
  const load = (name: string) => name === 'vue' ? vue : name === './recording-output-controller' ? controller : require(name)
  const compile = (content: string) => ts.transpileModule(content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const module = { exports: {} as { default: import('vue').Component } }
  const focusDocument = { activeElement: undefined as unknown, body: {} }
  new Function('require', 'module', 'exports', 'window', 'document', compile(script.content))(load, module, module.exports, { musicBridge: api }, focusDocument)
  const template = compileTemplate({ id: 'recording-output-panel', filename: 'RecordingOutputPanel.vue', source: descriptor.template!.content, compilerOptions: { bindingMetadata: script.bindings } }); assert.deepEqual(template.errors, [])
  const rendered = { exports: {} as { render: (...args: unknown[]) => unknown } }; new Function('require', 'module', 'exports', compile(template.code))(load, rendered, rendered.exports)
  interface Host { tag: string; text: string; children: Host[]; parent: Host | null; props: Record<string, unknown>; focus(): void }
  const node = (tag = ''): Host => vue.markRaw({ tag, text: '', children: [], parent: null, props: {}, focus() { focusDocument.activeElement = this } })
  const renderer = vue.createRenderer<Host, Host>({ createElement: node, createText: text => ({ ...node('#text'), text }), createComment: () => node('#comment'), setText(node, text) { node.text = text }, setElementText(node, text) { node.text = text; node.children = [] }, patchProp(node, key, _old, value) { node.props[key] = value; if (key === 'disabled' && value === true && focusDocument.activeElement === node) focusDocument.activeElement = focusDocument.body }, insert(child, parent, anchor) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; if (index < 0) parent.children.push(child); else parent.children.splice(index, 0, child) }, remove(child) { if (focusDocument.activeElement === child) focusDocument.activeElement = focusDocument.body; child.parent?.children.splice(child.parent.children.indexOf(child), 1); child.parent = null }, parentNode: node => node.parent, nextSibling: node => node.parent?.children[(node.parent?.children.indexOf(node) ?? -1) + 1] ?? null })
  const selected = vue.shallowRef<RecordingPlanVersion | undefined>(plan()), component = { ...module.exports.default, render: rendered.exports.render }
  const root = node(), app = renderer.createApp({ setup: () => () => vue.h(component, { plan: selected.value }) }); app.mount(root); t.after(() => app.unmount())
  const tick = async () => { await new Promise<void>(done => setImmediate(done)); await vue.nextTick() }; await tick()
  const all = (current = root): Host[] => [current, ...current.children.flatMap(child => all(child))], text = (current = root): string => current.text + current.children.map(child => text(child)).join(' ')
  const button = (label: string) => { const target = all().find(n => n.tag === 'button' && text(n).trim() === label); assert.ok(target, label); return target }
  const change = async (value: string) => { const target = all().find(n => n.props.id === 'recording-output-side'); assert.ok(target); (target.props.onChange as (e: unknown) => void)({ target: { value } }); await tick() }
  return { all, text, button, change, tick, selected, focused: () => focusDocument.activeElement, bodyFocused: () => focusDocument.activeElement === focusDocument.body, unmount: () => app.unmount() }
}
test('实际SFC只有显式无设备检查，显示未检查/边界/标签和可访问状态', async t => {
  const f = fixture(), panel = await mounted(t, f.api)
  assert.equal(panel.button('无设备检查').props.disabled, true); assert.match(panel.text(), /本次尚未检查/u); assert.match(panel.text(), /不播放音频，不认证 Gate B/u)
  assert.ok(panel.all().some(n => n.props['aria-live'] === 'polite')); assert.deepEqual(f.checks, [])
  await panel.change('B'); await (panel.button('无设备检查').props.onClick as () => Promise<void>)(); await panel.tick()
  assert.match(panel.text(), /无设备检查通过/u); assert.match(panel.text(), /40/u); assert.ok(panel.all().some(n => n.tag === 'details'))
  panel.selected.value = plan(2); await panel.tick(); assert.doesNotMatch(panel.text(), /无设备检查通过/u)
})
test('实际SFC切换上下文保持取消等待，取消失败呈现重试且卸载不回填成功', async t => {
  const f = fixture(), wait = deferred<RecordingOutputCheckResult>()
  f.api.checkRecordingOutput = async request => { f.checks.push(request); return wait.promise }
  f.api.cancelRecordingOutputCheck = async runId => { f.cancels.push(runId); throw new Error('cancel') }
  const panel = await mounted(t, f.api); await panel.change('A'); const pending = (panel.button('无设备检查').props.onClick as () => Promise<void>)()
  await panel.tick(); await panel.change('B'); assert.match(panel.text(), /取消请求未确认/u); assert.equal(panel.button('重试取消').props.disabled, false)
  f.api.cancelRecordingOutputCheck = async () => ({ cancelled: true }); await (panel.button('重试取消').props.onClick as () => Promise<void>)(); await panel.tick()
  assert.match(panel.text(), /尚不能确认已停止/u); assert.equal(panel.button('无设备检查').props.disabled, true)
  panel.unmount(); wait.resolve(result(f.checks[0]!)); await pending
})
test('实际SFC取消按钮消失前记住焦点，结束后恢复到可用检查按钮', async t => {
  const f = fixture(), wait = deferred<RecordingOutputCheckResult>()
  f.api.checkRecordingOutput = async request => { f.checks.push(request); return wait.promise }
  const panel = await mounted(t, f.api); await panel.change('A')
  const pending = (panel.button('无设备检查').props.onClick as () => Promise<void>)(); await panel.tick()
  await (panel.button('取消无设备检查').props.onClick as () => Promise<void>)(); await panel.tick()
  panel.button('取消无设备检查').focus(); wait.resolve(result(f.checks[0]!)); await pending; await panel.tick()
  assert.ok(panel.focused() === panel.button('无设备检查'), '取消按钮卸载后焦点应回到检查按钮')
})
for (const scenario of ['完成后回到检查按钮', '失败后回到检查按钮', '换计划后回到面选择', '清空计划后回到标题', '用户移焦不抢回', '卸载后不恢复'] as const) {
  test(`实际SFC检查按钮禁用失焦：${scenario}`, async t => {
    const f = fixture(), wait = deferred<RecordingOutputCheckResult>()
    f.api.checkRecordingOutput = async request => { f.checks.push(request); return wait.promise }
    const panel = await mounted(t, f.api); await panel.change('A')
    const start = panel.button('无设备检查'); start.focus()
    const pending = (start.props.onClick as () => Promise<void>)(); await panel.tick()
    assert.equal(start.props.disabled, true); assert.equal(panel.bodyFocused(), true, '模拟Chromium禁用当前按钮后焦点回到body')
    const side = panel.all().find(n => n.props.id === 'recording-output-side')!
    const heading = panel.all().find(n => n.props.id === 'recording-output-title')!
    if (scenario === '换计划后回到面选择') panel.selected.value = plan(2)
    if (scenario === '清空计划后回到标题') panel.selected.value = undefined
    if (scenario === '用户移焦不抢回') side.focus()
    if (scenario === '卸载后不恢复') panel.unmount()
    await panel.tick()
    if (scenario === '失败后回到检查按钮') wait.reject(new Error('HELPER_PROTOCOL'))
    else wait.resolve(result(f.checks[0]!))
    await pending; await panel.tick()
    if (scenario === '卸载后不恢复') assert.equal(panel.bodyFocused(), true)
    else assert.ok(panel.focused() === (scenario === '完成后回到检查按钮' || scenario === '失败后回到检查按钮' ? start : scenario === '清空计划后回到标题' ? heading : side), '仅在用户未移焦且组件仍挂载时恢复到可用控件')
  })
}
