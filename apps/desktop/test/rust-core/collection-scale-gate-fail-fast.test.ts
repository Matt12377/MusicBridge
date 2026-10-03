import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { assertCollectionScaleRunClosed, runCollectionScaleBehaviorCheck } from '../../../../scripts/ci/verify-rust-collection-scale.mjs'

// 这些是逐轮门禁的受控收据，不冒称实际 App、完整协议或数据库证据。
interface ControlledReceipt {
  mainExit: { code: number; signal: null }
  completion: string
  timedOut: boolean
  forceKilled: boolean
  parseErrors: number
  startupReady: boolean
  startupFailed: boolean
  events: Array<{ event: string; actor: string; pid?: number; elapsedMs?: number; sequence: number; data: Record<string, unknown> }>
  lifecycle: Array<{ phase: string; exitCode?: number }>
}
function closed(): ControlledReceipt {
  return {
    mainExit: { code: 0, signal: null }, completion: 'closed', timedOut: false,
    forceKilled: false, parseErrors: 0, startupReady: false, startupFailed: false,
    events: [
      { event: 'rust.spawn', actor: 'core', sequence: 1, data: { pid: 21 } },
      { event: 'node.closeStarted', actor: 'core', sequence: 2, data: {} },
      { event: 'node.exit', actor: 'core', sequence: 3, data: { threadId: 1, code: 0 } },
      { event: 'node.closeCompleted', actor: 'core', sequence: 4, data: {} },
      { event: 'rust.exit', actor: 'core', sequence: 5, data: { pid: 21, code: 0, signal: null, closeAcknowledged: true, pendingRequests: 0 } },
      { event: 'core.closedStatus', actor: 'core', sequence: 6, data: {} },
      { event: 'main.ipcRequest', actor: 'main', sequence: 1, data: { invokeId: 'ipc-1', channel: 'collection:list' } },
      { event: 'main.request', actor: 'main', sequence: 2, data: { invokeId: 'ipc-1', request: { id: 'request-1' } } },
      { event: 'main.response', actor: 'main', sequence: 3, data: { invokeId: 'ipc-1', requestId: 'request-1', reply: { ok: true } } },
      { event: 'main.ipcReply', actor: 'main', sequence: 4, data: { invokeId: 'ipc-1', channel: 'collection:list' } },
      { event: 'main.rendererIpcDrained', actor: 'main', sequence: 5, data: { scope: 'before-original-quit', pendingCount: 0, requestCount: 1, replyCount: 1, rejectedCount: 0 } },
      { event: 'main.rendererProbeComplete', actor: 'main', sequence: 6, data: {} },
      { event: 'main.beforeQuit', actor: 'main', sequence: 7, data: {} },
      { event: 'main.coreExit', actor: 'main', sequence: 8, data: { pid: 22, code: 0 } },
    ].map(event => ({ ...event, pid: event.actor === 'core' ? 22 : 11, elapsedMs: event.sequence })),
    lifecycle: [
      { phase: 'core-shutdown-start' }, { phase: 'core-exit', exitCode: 0 },
      { phase: 'core-shutdown-end' }, { phase: 'outbox-close-start' },
      { phase: 'outbox-close-end' }, { phase: 'will-quit' },
    ],
  }
}
function reorderMain(value: ControlledReceipt): void {
  value.events.filter(event => event.actor === 'main').forEach((event, index) => { event.sequence = index + 1; event.elapsedMs = index + 1 })
}

test('受控正常冷启收口可以继续下一轮，完整证据另由严格准入核验', () => {
  assertCollectionScaleRunClosed('scale-100-cold', 'scale-100', closed())
})
test('普通默认包仅使用原启动标记和自然Main退出，不伪造额外关闭观察', () => {
  const value = { ...closed(), startupReady: true, events: [], lifecycle: [] }
  assertCollectionScaleRunClosed('default-node', 'default-node', value)
})
test('已知预算拒绝没有创建native时允许零spawn和零exit', () => {
  const value = closed(); value.events = value.events.filter(event => !event.event.startsWith('rust.'))
  value.events.filter(event => event.actor === 'core').forEach((event, index) => { event.sequence = index + 1; event.elapsedMs = index + 1 })
  assertCollectionScaleRunClosed('scale-2001-cold', 'scale-2001', value)
})

const faults: Record<string, (receipt: ReturnType<typeof closed>) => void> = {
  'Node线程非自然0': value => { value.events.find(event => event.event === 'node.exit')!.data.code = 1 },
  'Node关闭拒绝': value => { value.events.find(event => event.event === 'node.closeCompleted')!.event = 'node.closeRejected' },
  'Rust已请求强制结束': value => { value.events.push({ event: 'rust.kill-request', actor: 'core', pid: 22, elapsedMs: 7, sequence: 7, data: {} }) },
  'Rust未得到关闭ACK': value => { value.events.find(event => event.event === 'rust.exit')!.data.closeAcknowledged = false },
  'Rust整个退出ACK记录缺失': value => { value.events = value.events.filter(event => event.event !== 'rust.exit'); value.events.filter(event => event.actor === 'core').forEach((event, index) => { event.sequence = index + 1 }) },
  'Rust退出记录属于其他PID': value => { value.events.find(event => event.event === 'rust.exit')!.data.pid = 23 },
  'Rust重复启动PID': value => { value.events.push({ event: 'rust.spawn', actor: 'core', pid: 22, elapsedMs: 7, sequence: 7, data: { pid: 21 } }) },
  'Node查询分发失败': value => { value.events.push({ event: 'node.dispatchFailed', actor: 'core', pid: 22, elapsedMs: 7, sequence: 7, data: {} }) },
  'Core退出非0': value => { value.events.find(event => event.event === 'main.coreExit')!.data.code = 1 },
  '原outbox关闭超时': value => { value.lifecycle.push({ phase: 'outbox-close-timeout' }) },
  'Core原件拒绝': value => { value.events.push({ event: 'main.coreEvidenceRejected', actor: 'main', pid: 11, elapsedMs: 9, sequence: 9, data: {} }) },
  'Renderer原件拒绝': value => { value.events.push({ event: 'renderer.observationRejected', actor: 'renderer', pid: 33, elapsedMs: 1, sequence: 1, data: {} }) },
  'Node关闭ACK缺失': value => { value.events = value.events.filter(event => event.event !== 'node.closeCompleted'); value.events.filter(event => event.actor === 'core').forEach((event, index) => { event.sequence = index + 1 }) },
  '原willQuit证据缺失': value => { value.lifecycle = value.lifecycle.filter(event => event.phase !== 'will-quit') },
}

for (const [label, mutate] of Object.entries({
  '排空声明缺失': (value: ControlledReceipt) => { value.events = value.events.filter(event => event.event !== 'main.rendererIpcDrained'); reorderMain(value) },
  '声明pending非零': (value: ControlledReceipt) => { value.events.find(event => event.event === 'main.rendererIpcDrained')!.data.pendingCount = 1 },
  '声明未封闭多字段': (value: ControlledReceipt) => { value.events.find(event => event.event === 'main.rendererIpcDrained')!.data.unchecked = true },
  '声明计数伪造': (value: ControlledReceipt) => { const data = value.events.find(event => event.event === 'main.rendererIpcDrained')!.data; data.requestCount = 0; data.replyCount = 0 },
  'IPC成功回执缺失': (value: ControlledReceipt) => { value.events = value.events.filter(event => event.event !== 'main.ipcReply'); reorderMain(value) },
  '原公开回复缺失': (value: ControlledReceipt) => { value.events = value.events.filter(event => event.event !== 'main.response'); reorderMain(value) },
  '原公开回复不是成功': (value: ControlledReceipt) => { (value.events.find(event => event.event === 'main.response')!.data.reply as { ok: boolean }).ok = false },
  '原IPC回复身份错位': (value: ControlledReceipt) => { value.events.find(event => event.event === 'main.ipcReply')!.data.invokeId = 'ipc-other' },
  '回复晚于排空': (value: ControlledReceipt) => { const reply = value.events.find(event => event.event === 'main.ipcReply')!; value.events = value.events.filter(event => event !== reply); value.events.splice(value.events.findIndex(event => event.event === 'main.rendererProbeComplete'), 0, reply); reorderMain(value) },
  '排空后出现新UI请求': (value: ControlledReceipt) => { value.events.splice(value.events.findIndex(event => event.event === 'main.rendererProbeComplete'), 0, { event: 'main.ipcRequest', actor: 'main', pid: 11, sequence: 0, elapsedMs: 0, data: { invokeId: 'ipc-late', channel: 'collection:list' } }); reorderMain(value) },
  '原退出早于排空': (value: ControlledReceipt) => { const quit = value.events.find(event => event.event === 'main.beforeQuit')!; value.events = value.events.filter(event => event !== quit); value.events.splice(value.events.findIndex(event => event.event === 'main.rendererIpcDrained'), 0, quit); reorderMain(value) },
})) test(`所有原Renderer IPC收口前不能开始原退出：${label}`, () => {
  const value = closed(); mutate(value)
  assert.throws(() => assertCollectionScaleRunClosed('scale-100-cold', 'scale-100', value))
})

for (const [label, mutate] of Object.entries({
  '整行丢失但没有拒绝事件': (value: ControlledReceipt) => { value.events.filter(event => event.actor === 'core').slice(1).forEach(event => { event.sequence += 13; event.elapsedMs = event.sequence }) },
  '同一actor重复序号': (value: ControlledReceipt) => { value.events[1]!.sequence = 1 },
  '同一actor本地clock倒退': (value: ControlledReceipt) => { value.events[1]!.elapsedMs = 0 },
  'actor身份缺失': (value: ControlledReceipt) => { delete value.events[1]!.pid },
})) test(`逐轮原件不完整在下一候选启动前拒绝：${label}`, () => {
  const value = closed(); mutate(value)
  assert.throws(() => assertCollectionScaleRunClosed('scale-100-cold', 'scale-100', value))
})
for (const [label, mutate] of Object.entries(faults)) test(`受控冷启关闭故障在下一候选启动前拒绝：${label}`, () => {
  const value = closed(); mutate(value)
  assert.throws(() => assertCollectionScaleRunClosed('scale-100-cold', 'scale-100', value))
})

// 真实测试子进程的生命周期证据，区别于App/native运行期限；测试目录和失败原件保留。
function evidenceCheckDirectory(): string {
  const temporary = process.env.TMPDIR
  assert.ok(typeof temporary === 'string')
  assert.ok(temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'))
  return mkdtempSync(path.join(temporary, 'collection-scale-check-'))
}
function tapSummary(field?: 'fail' | 'cancelled' | 'skipped'): string {
  return '# tests 1\n# pass ' + (field ? '0' : '1') + '\n# fail ' + (field === 'fail' ? '1' : '0') +
    '\n# cancelled ' + (field === 'cancelled' ? '1' : '0') + '\n# skipped ' + (field === 'skipped' ? '1' : '0') + '\n'
}
test('证据测试独立预算：有延迟的完整自然成功保留原零失败零跳过合同', async () => {
  const directory = evidenceCheckDirectory()
  const receipt = await runCollectionScaleBehaviorCheck(directory, process.execPath,
    ['--eval', 'setTimeout(() => console.log(' + JSON.stringify(tapSummary()) + '), 40)'], {}, process.cwd(), 1000)
  assert.equal(receipt.code, 0); assert.equal(receipt.signal, null); assert.equal(receipt.timedOut, false)
  assert.equal(receipt.forcedCleanup, false); assert.ok(receipt.childPid > 0)
})
test('证据测试独立预算：真实子进程超时保存失败并只中断自身', async () => {
  const directory = evidenceCheckDirectory()
  await assert.rejects(runCollectionScaleBehaviorCheck(directory, process.execPath,
    ['--eval', 'setInterval(() => {}, 10000)'], {}, process.cwd(), 150))
  const receipt = JSON.parse(readFileSync(path.join(directory, 'collection-scale-behavior.json'), 'utf8'))
  assert.equal(receipt.deadlineMs, 150); assert.equal(receipt.timedOut, true); assert.equal(receipt.forcedCleanup, true)
  assert.notEqual(receipt.code, 0); assert.ok(receipt.childPid > 0)
})
test('证据测试独立预算：非零退出即使输出成功TAP仍必须拒绝', async () => {
  const directory = evidenceCheckDirectory()
  await assert.rejects(runCollectionScaleBehaviorCheck(directory, process.execPath,
    ['--eval', 'console.log(' + JSON.stringify(tapSummary()) + '); process.exitCode = 2'], {}, process.cwd(), 1000))
  const receipt = JSON.parse(readFileSync(path.join(directory, 'collection-scale-behavior.json'), 'utf8'))
  assert.equal(receipt.code, 2); assert.equal(receipt.timedOut, false); assert.equal(receipt.forcedCleanup, false)
})
for (const field of ['fail', 'cancelled', 'skipped'] as const) test('证据测试独立预算：自然退出0仍拒绝TAP的' + field, async () => {
  const directory = evidenceCheckDirectory()
  await assert.rejects(runCollectionScaleBehaviorCheck(directory, process.execPath,
    ['--eval', 'console.log(' + JSON.stringify(tapSummary(field)) + ')'], {}, process.cwd(), 1000))
})
test('证据测试独立预算：没有完整TAP结尾不能接受部分运行', async () => {
  const directory = evidenceCheckDirectory()
  await assert.rejects(runCollectionScaleBehaviorCheck(directory, process.execPath,
    ['--eval', "console.log('ok 1 - 仅部分日志')"], {}, process.cwd(), 1000))
})
