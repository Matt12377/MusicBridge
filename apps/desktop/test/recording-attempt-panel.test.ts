import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isRecordingAttempt, type RecordingAttempt, type RecordingAttemptSide, type RecordingAttemptsPublicApi, type RecordingPlanVersion } from '@music-bridge/contracts'

const id = (n: number) => `74000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const hash = 'a'.repeat(64), at = '2026-08-29T10:00:00.000Z', later = '2026-08-29T10:00:01.000Z'
function side(name: 'A' | 'B' | 'Program' = 'A'): RecordingAttemptSide {
  return { side: name, phase: 'outputting', frameCount: 48000, recipeHash: hash, audioSha256: hash, pcmSha256: hash, runId: id(name === 'B' ? 8 : 7), sourceFramesRead: 0, submittedFrames: 0, consumedFrames: 0, sourceEof: false, backendDrained: false, engineStoppedSubmitting: false, stopAcknowledged: false, cleanupQuiescent: false, startedAt: at }
}
function attempt(): RecordingAttempt {
  return { kind: 'formal', id: id(1), draftId: id(2), planVersionId: id(3), planContentHash: hash, executionAssetId: id(4), physicalId: 'MB-C-00001', revision: 1, createdAt: at, updatedAt: at, status: 'in-progress', phase: 'outputting', activeSide: 'A', sides: [side()], softwarePlaybackComplete: false }
}
function drained(): RecordingAttempt {
  const value = attempt(); value.updatedAt = later; value.phase = 'awaiting-physical-stop'; value.softwarePlaybackComplete = true
  value.sides = [{ ...side(), phase: 'awaiting-physical-stop', sourceFramesRead: 48000, submittedFrames: 48000, consumedFrames: 48000, sourceEof: true, backendDrained: true, engineStoppedSubmitting: true }]
  return value
}
function aborted(): RecordingAttempt {
  const value = attempt(); delete value.activeSide
  return { ...value, revision: 2, updatedAt: later, endedAt: later, status: 'aborted', phase: 'finished', reason: 'user-stop', sides: [{ ...side(), phase: 'aborted', endedAt: later, reason: 'user-stop' }] }
}
function waitingB(): RecordingAttempt {
  const value = drained(); delete value.activeSide; value.softwarePlaybackComplete = false; value.phase = 'awaiting-side-b'; value.flipConfirmedAt = later
  const b = side('B'); b.phase = 'pending'; delete b.runId; delete b.startedAt
  value.sides = [{ ...value.sides[0]!, phase: 'complete', endedAt: later, physicalStopConfirmedAt: later }, b]
  return value
}
function plan(value = attempt()): RecordingPlanVersion {
  // 仅模拟此面板读取的已冻结Plan字段，Attempt本身须通过正式guard。
  return { id: value.planVersionId, draftId: value.draftId, sequence: 1, status: 'frozen', contentHash: value.planContentHash, formalReady: false, physicalCopy: { physicalId: value.physicalId }, execution: { assetId: value.executionAssetId, audio: value.sides.map(item => ({ recipe: { side: item.side }, recipeHash: item.recipeHash, audio: { frameCount: item.frameCount, sha256: item.audioSha256, pcmSha256: item.pcmSha256 } })) } } as unknown as RecordingPlanVersion
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function fixture(value = attempt()) {
  assert.equal(isRecordingAttempt(value), true, '合成Attempt必须符合正式合同')
  const calls: { name: string; request: unknown }[] = []
  const api: RecordingAttemptsPublicApi = {
    async listRecordingAttempts(request) { calls.push({ name: 'list', request }); return { items: [structuredClone(value)], offset: request.page.offset, limit: 25, total: 1, hasMore: false } },
    async getRecordingAttempt(request) { calls.push({ name: 'get', request }); return { attempt: structuredClone(value) } },
    async beginRecordingAttempt(request) { calls.push({ name: 'begin', request }); throw new Error('NOT_READY') },
    async confirmRecordingAttempt(request) { calls.push({ name: 'confirm', request }); return { ...value, revision: value.revision + 1 } },
    async beginRecordingAttemptSide(request) { calls.push({ name: 'beginSide', request }); throw new Error('NOT_READY') },
    async stopRecordingAttempt(request) { calls.push({ name: 'stop', request }); return aborted() },
  }
  return { api, calls, value }
}
async function controller(f = fixture()) {
  const module = await import('../src/renderer/src/components/recording/recording-attempt-controller.js').catch(() => ({}))
  assert.ok('createRecordingAttemptController' in module, '缺少正式录音尝试控制器')
  const c = (module as typeof import('../src/renderer/src/components/recording/recording-attempt-controller.js')).createRecordingAttemptController({ api: f.api })
  c.setPlan(plan(f.value)); await c.refresh()
  return { ...f, c }
}
test('明确Plan分页25，无自动首条、Begin或BeginB；无Plan不读取', async () => {
  const f = await controller(); assert.deepEqual(f.calls, [{ name: 'list', request: { planVersionId: id(3), draftId: id(2), page: { offset: 0, limit: 25 } } }]); assert.equal(f.c.state.attempt, undefined)
  f.c.setPlan(); await f.c.refresh(); assert.equal(f.calls.length, 1); f.c.dispose()
})
test('详情guard和完整Plan谱系匹配，错误/缺失不变为空历史', async () => {
  for (const patch of [{ id: id(90) }, { planVersionId: id(91) }, { draftId: id(92) }, { physicalId: 'MB-C-00002' }, { executionAssetId: id(93) }, { planContentHash: 'b'.repeat(64) }, { sides: [{ ...side(), audioSha256: 'b'.repeat(64) }] }, { formalReady: true }]) {
    const f = await controller(); f.api.getRecordingAttempt = async () => ({ attempt: { ...attempt(), ...patch } as never }); await f.c.select(id(1)); assert.equal(f.c.state.attempt, undefined); assert.ok(f.c.state.detailError); f.c.dispose()
  }
  const f = await controller(); f.api.listRecordingAttempts = async () => { throw new Error('/private/secret') }; await f.c.refresh(); assert.equal(f.c.state.listPhase, 'error'); assert.doesNotMatch(f.c.state.listError, /private|secret/); f.c.dispose()
})
test('列表和详情迟到在切Plan/取消选择/卸载后失效，不触发自动停止', async () => {
  const f = await controller(), wait = deferred<{ attempt: RecordingAttempt }>()
  f.api.getRecordingAttempt = () => wait.promise; const old = f.c.select(id(1)); f.c.setPlan(); wait.resolve({ attempt: attempt() }); await old; assert.equal(f.c.state.attempt, undefined)
  f.c.setPlan(plan()); await f.c.refresh(); const wait2 = deferred<{ attempt: RecordingAttempt }>(); f.api.getRecordingAttempt = () => wait2.promise; const late = f.c.select(id(1)); f.c.dispose(); wait2.resolve({ attempt: attempt() }); await late; assert.equal(f.c.state.attempt, undefined); assert.equal(f.calls.some(c => c.name === 'stop'), false)
})
test('人工确认只有符合阶段且明确勾选才发出，异常保留同DTO重试', async () => {
  const f = await controller(fixture(drained())); await f.c.select(id(1)); await f.c.confirm('physical-stop', 'A'); assert.equal(f.calls.filter(c => c.name === 'confirm').length, 0)
  f.c.setConfirmed(true); f.api.confirmRecordingAttempt = async request => { f.calls.push({ name: 'confirm', request }); throw new Error('/private/confirm') }
  await f.c.confirm('physical-stop', 'A'); assert.ok(f.c.state.pending); assert.equal(f.c.state.confirmed, false); assert.doesNotMatch(f.c.state.operationError, /private/)
  await f.c.retry(); const requests = f.calls.filter(c => c.name === 'confirm').map(c => c.request); assert.deepEqual(requests[0], requests[1]); assert.deepEqual(Object.keys(requests[0] as object).sort(), ['attemptId', 'commandId', 'expectedRevision', 'kind', 'side', 'userConfirmed']); f.c.dispose()
})
test('停止不用revision/二次确认，可越过未确认的人工命令，旧成功不能覆盖Aborted', async () => {
  const f = await controller(fixture(drained())); await f.c.select(id(1)); f.c.setConfirmed(true)
  const wait = deferred<RecordingAttempt>(); f.api.confirmRecordingAttempt = async request => { f.calls.push({ name: 'confirm', request }); return wait.promise }
  const old = f.c.confirm('physical-stop', 'A'); await f.c.stop(); assert.equal(f.c.state.attempt?.status, 'aborted')
  assert.deepEqual(Object.keys(f.calls.find(c => c.name === 'stop')!.request as object).sort(), ['attemptId', 'commandId'])
  wait.resolve({ ...drained(), revision: 3 }); await old; assert.equal(f.c.state.attempt?.status, 'aborted'); assert.equal(f.c.state.attempt?.sides[0]?.cleanupQuiescent, false); f.c.dispose()
})
test('BeginB仅显式方法和翻面阶段，不跟随读取/确认自动触发，也不发送认证', async () => {
  const f = await controller(fixture(waitingB())); await f.c.select(id(1)); assert.equal(f.calls.some(c => c.name === 'beginSide'), false)
  await f.c.beginSide(); assert.equal(f.calls.some(c => c.name === 'beginSide'), false)
  f.c.setConfirmed(true); await f.c.beginSide(); const request = f.calls.find(c => c.name === 'beginSide')!.request as object
  assert.deepEqual(Object.keys(request).sort(), ['attemptId', 'commandId', 'expectedRevision', 'side', 'userConfirmed']); assert.equal(f.c.state.attempt?.phase, 'awaiting-side-b'); f.c.dispose()
})
test('终止后只允许已开始面的实体停止确认，DAT和A-only没有翻面动作', async () => {
  const f = await controller(fixture(aborted())); await f.c.select(id(1)); assert.equal(f.c.canConfirm('physical-stop', 'A'), true); assert.equal(f.c.canConfirm('flip'), false); assert.equal(f.c.canConfirm('final-verification'), false)
  f.c.setConfirmed(true); await f.c.confirm('physical-stop', 'B'); assert.equal(f.calls.some(c => c.name === 'confirm'), false); f.c.dispose()
})
test('分页只保留当前25项、拒绝跨Plan/错误分页，刷新详情不能回退revision', async () => {
  const f = await controller(); f.api.listRecordingAttempts = async request => ({ items: Array.from({ length: 25 }, (_, n) => ({ ...attempt(), id: id(n + 100) })), offset: request.page.offset, limit: 25, total: 50, hasMore: request.page.offset === 0 })
  await f.c.refresh(); assert.equal(f.c.state.page?.items.length, 25); await f.c.refresh(25); assert.equal(f.c.state.page?.offset, 25); assert.equal(f.c.state.page?.items.length, 25)
  f.api.listRecordingAttempts = async () => ({ items: [attempt()], offset: 0, limit: 25, total: 1, hasMore: false }); await f.c.refresh(25); assert.equal(f.c.state.listPhase, 'error')
  await f.c.refresh(); await f.c.select(id(1)); f.api.getRecordingAttempt = async () => ({ attempt: { ...attempt(), revision: 3 } }); await f.c.readSelected(); assert.equal(f.c.state.attempt?.revision, 3)
  f.api.getRecordingAttempt = async () => ({ attempt: attempt() }); await f.c.readSelected(); assert.ok(f.c.state.detailError); assert.equal(f.c.state.attempt, undefined); f.c.dispose()
})

async function mounted(t: test.TestContext, api: RecordingAttemptsPublicApi, initial = plan()) {
  const { parse, compileScript, compileTemplate } = await import('@vue/compiler-sfc'), ts = (await import('typescript')).default
  const require = createRequire(import.meta.url), vue = require('vue') as typeof import('vue')
  const source = await readFile(new URL('../src/renderer/src/components/recording/RecordingAttemptPanel.vue', import.meta.url), 'utf8').catch(() => '')
  assert.ok(source, '缺少实际录音尝试面板SFC'); const { descriptor, errors } = parse(source); assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: 'recording-attempt-panel' })
  const controller = await import('../src/renderer/src/components/recording/recording-attempt-controller.js')
  const load = (name: string) => name === 'vue' ? vue : name === './recording-attempt-controller' ? controller : require(name)
  const compile = (content: string) => ts.transpileModule(content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const module = { exports: {} as { default: import('vue').Component } }
  const focusDocument = { activeElement: undefined as unknown, body: {} }
  new Function('require', 'module', 'exports', 'window', 'document', compile(script.content))(load, module, module.exports, { musicBridge: api }, focusDocument)
  const template = compileTemplate({ id: 'recording-attempt-panel', filename: 'RecordingAttemptPanel.vue', source: descriptor.template!.content, compilerOptions: { bindingMetadata: script.bindings } }); assert.deepEqual(template.errors, [])
  const rendered = { exports: {} as { render: (...args: unknown[]) => unknown } }; new Function('require', 'module', 'exports', compile(template.code))(load, rendered, rendered.exports)
  interface Host { tag: string; text: string; children: Host[]; parent: Host | null; props: Record<string, unknown>; focus(): void }
  const node = (tag = ''): Host => vue.markRaw({ tag, text: '', children: [], parent: null, props: {}, focus() { focusDocument.activeElement = this } })
  const renderer = vue.createRenderer<Host, Host>({ createElement: node, createText: text => ({ ...node('#text'), text }), createComment: () => node('#comment'), setText(node, text) { node.text = text }, setElementText(node, text) { node.text = text; node.children = [] }, patchProp(node, key, _old, value) { node.props[key] = key === 'disabled' && value === '' ? true : value; if (key === 'disabled' && (value === true || value === '') && focusDocument.activeElement === node) focusDocument.activeElement = focusDocument.body }, insert(child, parent, anchor) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; if (index < 0) parent.children.push(child); else parent.children.splice(index, 0, child) }, remove(child) { if (focusDocument.activeElement === child) focusDocument.activeElement = focusDocument.body; child.parent?.children.splice(child.parent.children.indexOf(child), 1); child.parent = null }, parentNode: node => node.parent, nextSibling: node => node.parent?.children[(node.parent?.children.indexOf(node) ?? -1) + 1] ?? null })
  const selected = vue.shallowRef<RecordingPlanVersion | undefined>(initial), component = { ...module.exports.default, render: rendered.exports.render }
  const root = node(), app = renderer.createApp({ setup: () => () => vue.h(component, { plan: selected.value }) }); app.mount(root); t.after(() => app.unmount())
  const tick = async () => { await new Promise<void>(done => setImmediate(done)); await vue.nextTick() }; await tick()
  const all = (current = root): Host[] => [current, ...current.children.flatMap(child => all(child))], text = (current = root): string => current.text + current.children.map(child => text(child)).join(' ')
  const button = (label: string) => { const target = all().find(n => n.tag === 'button' && text(n).trim() === label); assert.ok(target, label); return target }
  const confirm = async () => { const target = all().find(n => n.props.id === 'recording-attempt-confirm'); assert.ok(target); (target.props.onChange as (e: unknown) => void)({ target: { checked: true } }); await tick() }
  const click = async (label: string) => { const target = button(label); assert.notEqual(target.props.disabled, true); await (target.props.onClick as (e: unknown) => unknown)({ currentTarget: target }); await tick() }
  return { all, text, button, confirm, click, tick, selected, focused: () => focusDocument.activeElement, bodyFocused: () => focusDocument.activeElement === focusDocument.body, unmount: () => app.unmount() }
}

test('真实SFC明确GateB阻断、空态和历史不默认选，执行按钮禁用', async t => {
  const f = fixture(); f.api.listRecordingAttempts = async () => ({ items: [], offset: 0, limit: 25, total: 0, hasMore: false }); const panel = await mounted(t, f.api)
  assert.match(panel.text(), /这份计划尚无正式录音尝试；未生成演示记录。/u); assert.match(panel.text(), /Gate B.*NOT_RUN/u)
  assert.equal(panel.button('开始正式录音').props.disabled, true); assert.ok(panel.all().some(n => n.props['aria-live'] === 'polite'))
  assert.equal(f.calls.some(c => c.name === 'begin' || c.name === 'beginSide'), false)
})
test('真实SFC三层事实独立，确认请求后不伪造完成，停止ACK/静止不混同', async t => {
  const f = fixture(drained()), panel = await mounted(t, f.api, plan(f.value)); await panel.click('查看录音尝试 '+id(1))
  assert.match(panel.text(), /软件播放完成：已完成/u); assert.match(panel.text(), /实体录制确认：未确认/u); assert.match(panel.text(), /最终核验完成：未确认/u)
  assert.match(panel.text(), /停止请求应答：未确认/u); assert.match(panel.text(), /资源静止：未确认/u)
  assert.equal(panel.button('确认 A 面实体已停止').props.disabled, true); await panel.confirm(); await panel.click('确认 A 面实体已停止')
  assert.equal(f.calls.filter(c => c.name === 'confirm').length, 1); assert.doesNotMatch(panel.text(), /录音已完成/u)
})
test('真实SFC翻面后仍须明确BeginB且当前GateB禁用，不自动续录', async t => {
  const f = fixture(waitingB()), panel = await mounted(t, f.api, plan(f.value)); await panel.click('查看录音尝试 '+id(1))
  assert.match(panel.text(), /等待明确开始 B 面/u); assert.equal(panel.button('明确开始 B 面').props.disabled, true); assert.equal(f.calls.some(c => c.name === 'beginSide'), false)
})
test('真实SFC停止等待不称停止成功，失败同命令重试；切Plan清空旧事实', async t => {
  const f = fixture(), wait = deferred<RecordingAttempt>(); f.api.stopRecordingAttempt = async request => { f.calls.push({ name: 'stop', request }); return wait.promise }
  const panel = await mounted(t, f.api); await panel.click('查看录音尝试 '+id(1)); const button = panel.button('停止本次录音'); button.focus()
  const pending = (button.props.onClick as (event: unknown) => Promise<void>)({ currentTarget: button }); await panel.tick(); assert.match(panel.text(), /正在等待操作回执；尚不能确认输出已停止/u)
  wait.reject(new Error('/private/stop')); await pending; await panel.tick(); assert.ok(panel.all().some(n => n.props.role === 'alert')); assert.doesNotMatch(panel.text(), /private/u)
  f.api.stopRecordingAttempt = async request => { f.calls.push({ name: 'stop', request }); return aborted() }; await panel.click('重试原操作'); assert.deepEqual(f.calls.filter(c => c.name === 'stop')[0]?.request, f.calls.filter(c => c.name === 'stop')[1]?.request)
  assert.match(panel.text(), /用户中止/u); assert.match(panel.text(), /资源静止：未确认/u)
  panel.selected.value = undefined; await panel.tick(); assert.doesNotMatch(panel.text(), /用户中止/u)
})
test('真实SFC操作完成后恢复焦点，用户已移焦或卸载不抢回', async t => {
  for (const move of [false, true]) {
    const f = fixture(), wait = deferred<RecordingAttempt>(); f.api.stopRecordingAttempt = () => wait.promise
    const panel = await mounted(t, f.api); await panel.click('查看录音尝试 '+id(1)); const button = panel.button('停止本次录音'); button.focus()
    const pending = (button.props.onClick as (event: unknown) => Promise<void>)({ currentTarget: button }); await panel.tick(); assert.equal(panel.bodyFocused(), true)
    const other = panel.button('刷新录音尝试'); if (move) other.focus()
    wait.resolve(aborted()); await pending; await panel.tick()
    if (move) assert.ok(panel.focused() === other); else assert.ok(panel.focused() === panel.all().find(n => n.props.id === 'recording-attempt-detail-title'))
  }
})

test('刷新中的停止仍可用；晚到旧详情不能恢复已中止记录', async () => {
  const f = await controller(); await f.c.select(id(1))
  const wait = deferred<{ attempt: RecordingAttempt }>(); f.api.getRecordingAttempt = () => wait.promise
  const read = f.c.readSelected(); assert.equal(f.c.canStop(), true, '读取状态不应阻断停止'); await f.c.stop(); wait.resolve({ attempt: attempt() }); await read
  assert.equal(f.c.state.attempt?.status, 'aborted'); f.c.dispose()
})
test('确认回执之后同一记录的迟到旧读取不得覆盖新revision', async () => {
  const f = await controller(fixture(drained())); await f.c.select(id(1)); f.c.setConfirmed(true)
  const command = deferred<RecordingAttempt>(), read = deferred<{ attempt: RecordingAttempt }>()
  f.api.confirmRecordingAttempt = () => command.promise; const pending = f.c.confirm('physical-stop', 'A')
  f.api.getRecordingAttempt = () => read.promise; const reading = f.c.select(id(1))
  command.resolve({ ...drained(), revision: 3 }); await pending; read.resolve({ attempt: drained() }); await reading
  assert.notEqual(f.c.state.attempt?.revision, 1); f.c.dispose()
})
test('真实SFC读事实失败仍保留原停止身份，但人工确认不可用；切Plan清理身份', async t => {
  const f = fixture(drained()), panel = await mounted(t, f.api, plan(f.value)); await panel.click('查看录音尝试 '+id(1))
  f.api.getRecordingAttempt = async () => { throw new Error('读取失败') }; await panel.click('重新读取本次状态')
  assert.equal(panel.button('停止本次录音').props.disabled, false); assert.equal(panel.all().some(n => n.props.id === 'recording-attempt-confirm'), false)
  await panel.click('停止本次录音'); assert.equal(f.calls.filter(c => c.name === 'stop').length, 1)
  panel.selected.value = undefined; await panel.tick(); assert.equal(panel.all().some(n => n.tag === 'button' && panel.text(n) === '停止本次录音'), false)
})
test('A-only与DAT完成逐项人工确认，三层齐备前不显示Completed，不造空B', async t => {
  for (const name of ['A', 'Program'] as const) {
    let value = drained(); value.sides = [{ ...value.sides[0]!, side: name }]; value.activeSide = name
    if (name === 'Program') value.physicalId = 'MB-D-00001'
    const f = fixture(value)
    f.api.confirmRecordingAttempt = async request => {
      f.calls.push({ name: 'confirm', request })
      value = structuredClone(value); value.revision++
      if (request.kind === 'physical-stop') { delete value.activeSide; value.phase = 'final-verification'; value.sides = [{ ...value.sides[0]!, phase: 'complete', endedAt: later, physicalStopConfirmedAt: later }] }
      else if (request.kind === 'physical-recording') value.physicalRecordingConfirmedAt = later
      else if (request.kind === 'final-verification') { value.finalVerificationCompleteAt = later; value.endedAt = later; value.status = 'completed'; value.phase = 'finished' }
      assert.equal(isRecordingAttempt(value), true); return value
    }
    const panel = await mounted(t, f.api, plan(value)); await panel.click('查看录音尝试 '+id(1)); await panel.confirm()
    await panel.click(name === 'A' ? '确认 A 面实体已停止' : '确认 连续节目（Program）实体已停止')
    assert.match(panel.text(), /软件播放完成：已完成/u); assert.match(panel.text(), /实体录制确认：未确认/u)
    assert.equal(panel.all().some(n => n.tag === 'button' && /翻面|开始 B 面/u.test(panel.text(n))), false)
    await panel.confirm(); await panel.click('确认实体录制完成'); assert.match(panel.text(), /最终核验完成：未确认/u)
    await panel.confirm(); await panel.click('确认最终核验完成'); assert.match(panel.text(), /已完成 · 本次流程已结束/u)
    assert.match(panel.text(), /实体录制确认：已确认/u); assert.match(panel.text(), /最终核验完成：已确认/u)
    assert.equal(f.calls.some(c => c.name === 'begin' || c.name === 'beginSide'), false)
  }
})
test('A/B物理停止后才出现翻面确认，确认翻面不会调用BeginB', async t => {
  let value = waitingB(); delete value.flipConfirmedAt; value.phase = 'awaiting-flip'
  const f = fixture(value); f.api.confirmRecordingAttempt = async request => { f.calls.push({ name: 'confirm', request }); value = { ...value, revision: 2, phase: 'awaiting-side-b', flipConfirmedAt: later }; return value }
  const panel = await mounted(t, f.api, plan(value)); await panel.click('查看录音尝试 '+id(1)); await panel.confirm(); await panel.click('确认已翻面')
  assert.equal(panel.button('明确开始 B 面').props.disabled, true); assert.equal(f.calls.some(c => c.name === 'beginSide'), false)
})
test('列表重读/切Plan使旧列表失效，写回执切Plan与卸载后不得恢复旧详情', async () => {
  const f = await controller(), list = deferred<Awaited<ReturnType<RecordingAttemptsPublicApi['listRecordingAttempts']>>>()
  f.api.listRecordingAttempts = () => list.promise; const stale = f.c.refresh(); f.c.setPlan()
  list.resolve({ items: [attempt()], offset: 0, limit: 25, total: 1, hasMore: false }); await stale; assert.equal(f.c.state.page, undefined)
  for (const dispose of [false, true]) {
    const g = await controller(); await g.c.select(id(1)); const wait = deferred<RecordingAttempt>(); g.api.stopRecordingAttempt = () => wait.promise
    const write = g.c.stop(); if (dispose) g.c.dispose(); else g.c.setPlan()
    wait.resolve(aborted()); await write; assert.equal(g.c.state.attempt, undefined); assert.equal(g.c.state.stopId, ''); g.c.dispose()
  }
  f.c.dispose()
})
