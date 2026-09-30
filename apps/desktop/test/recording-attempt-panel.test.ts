import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isRecordingAttempt, RECORDING_PREFLIGHT_CATEGORIES, type RecordingAttempt, type RecordingAttemptReceipt, type RecordingAttemptReceiptRequest, type RecordingAttemptSide, type RecordingAttemptsPublicApi, type RecordingPlanVersion, type RecordingPreflightResult, type RecordingPlansPublicApi } from '@music-bridge/contracts'
import { CoreIpcError } from '../src/main/core-supervisor.js'
import { installRecordingAttemptHandlers } from '../src/main/recording-attempt-ipc.js'
import { createRecordingAttemptClient } from '../src/preload/recording-attempt-client.js'

const id = (n: number) => `74000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const hash = 'a'.repeat(64), at = '2026-08-29T10:00:00.000Z', later = '2026-08-29T10:00:01.000Z'
const blockedPreflight = (): RecordingPreflightResult => ({ planVersionId: id(3), checkedAt: at, state: 'blocked', gateB: 'NOT_RUN', formalReady: false,
  checks: RECORDING_PREFLIGHT_CATEGORIES.map(category => category === 'backend' ? { category, state: 'not-run', code: 'BACKEND_NOT_CERTIFIED' } : { category, state: 'passed' }) })
const readyPreflight = (): RecordingPreflightResult => ({ planVersionId: id(3), checkedAt: at, state: 'ready', gateB: 'VERIFIED', formalReady: true,
  checks: RECORDING_PREFLIGHT_CATEGORIES.map(category => ({ category, state: 'passed' })) })
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
  value.sides = [{ ...value.sides[0]!, phase: 'complete', endedAt: later, physicalStopConfirmedAt: later, cleanupQuiescent: true }, b]
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
  const api: RecordingAttemptsPublicApi & Pick<RecordingPlansPublicApi, 'preflightRecordingPlan'> = {
    async listRecordingAttempts(request) { calls.push({ name: 'list', request }); return { items: [structuredClone(value)], offset: request.page.offset, limit: 25, total: 1, hasMore: false } },
    async getRecordingAttempt(request) { calls.push({ name: 'get', request }); return { attempt: structuredClone(value) } },
    async beginRecordingAttempt(request) { calls.push({ name: 'begin', request }); throw new Error('NOT_READY') },
    async confirmRecordingAttempt(request) { calls.push({ name: 'confirm', request }); return { ...value, revision: value.revision + 1 } },
    async beginRecordingAttemptSide(request) { calls.push({ name: 'beginSide', request }); throw new Error('NOT_READY') },
    async stopRecordingAttempt(request) { calls.push({ name: 'stop', request }); return aborted() },
    async preflightRecordingPlan(request) { calls.push({ name: 'preflight', request }); return blockedPreflight() },
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

function quietAborted(): RecordingAttempt {
  return { ...aborted(), sides: aborted().sides.map(item => ({ ...item, engineStoppedSubmitting: true, cleanupQuiescent: true })) }
}

test('MBR-002：Stop已受理但软件未静止时再次停止深等原DTO，不新建命令', async t => {
  const f = await controller(); t.after(f.c.dispose); await f.c.select(id(1))
  await f.c.stop()
  const original = structuredClone(f.calls.find(call => call.name === 'stop')!.request)
  assert.equal(f.c.state.pending, undefined, '受理回执已知，不冒充未知操作')
  await f.c.stop()
  assert.deepEqual(f.calls.filter(call => call.name === 'stop').map(call => call.request), [original, original])
  assert.deepEqual(f.c.state.stopRecovery?.request, original)
  assert.equal(f.c.canLeave(), false); assert.equal(f.c.canStop(), true)
})

test('MBR-002：原Stop只读accepted未静止仍保留描述符，再次停止复用原DTO', async t => {
  const f = await controller(); t.after(f.c.dispose); await f.c.select(id(1))
  f.api.stopRecordingAttempt = async request => { f.calls.push({ name: 'stop', request }); throw new Error('[TIMEOUT] 原Stop回执未知') }
  await f.c.stop(); const original = structuredClone(f.c.state.pending)!
  f.api.getRecordingAttemptReceipt = async input => {
    f.calls.push({ name: 'receipt', request: input })
    return { commandId: input.request.commandId, action: input.action, status: 'accepted', receipt: aborted(), attempt: aborted() }
  }
  await f.c.reconcileReceipt(); assert.equal(f.c.state.pending, undefined)
  assert.deepEqual(f.c.state.stopRecovery, original); assert.equal(f.c.canReconcileReceipt(), true)
  await f.c.reconcileReceipt()
  assert.deepEqual(f.calls.filter(call => call.name === 'receipt').map(call => call.request), Array.from({ length: 2 }, () => ({ action: 'stop', request: original.request })))
  assert.equal(f.calls.filter(call => call.name === 'stop').length, 1, '只读核对不自动恢复close')
  f.api.stopRecordingAttempt = async request => { f.calls.push({ name: 'stop', request }); return aborted() }
  await f.c.stop()
  assert.deepEqual(f.calls.filter(call => call.name === 'stop').map(call => call.request), [original.request, original.request])
  assert.deepEqual(f.c.state.stopRecovery, original); assert.equal(f.c.canLeave(), false)
})

for (const read of ['detail', 'receipt'] as const) {
  test(`MBR-002：${read}软件静止证明才清原Stop，实体停止及旧终态不清描述符`, async t => {
    const f = await controller(); t.after(f.c.dispose); await f.c.select(id(1)); await f.c.stop()
    const original = structuredClone(f.c.state.stopRecovery); assert.ok(original)
    f.api.getRecordingAttempt = async () => ({ attempt: { ...aborted(), revision: 3, sides: [{ ...aborted().sides[0]!, physicalStopConfirmedAt: later }] } })
    await f.c.readSelected(); assert.deepEqual(f.c.state.stopRecovery, original); assert.equal(f.c.canLeave(), false)
    if (read === 'detail') {
      f.api.getRecordingAttempt = async () => ({ attempt: { ...quietAborted(), revision: 4, sides: [{ ...quietAborted().sides[0]!, physicalStopConfirmedAt: later }] } })
      await f.c.readSelected()
    } else {
      f.api.getRecordingAttemptReceipt = async input => ({ commandId: input.request.commandId, action: input.action, status: 'accepted', receipt: aborted(),
        attempt: { ...quietAborted(), revision: 4, sides: [{ ...quietAborted().sides[0]!, physicalStopConfirmedAt: later }] } })
      await f.c.reconcileReceipt()
    }
    assert.equal(f.c.state.stopRecovery, undefined); assert.equal(f.c.canLeave(), true); assert.equal(f.c.canStop(), false)
    assert.equal(f.calls.filter(call => call.name === 'stop').length, 1, '读取软件静止不重发Stop')
  })
}

test('MBR-002：Stop终态静止未知保留精确停止与离页锁，轮询新鲜软件静止后才收口', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await controller(); t.after(f.c.dispose)
  await f.c.select(id(1)); await f.c.stop()
  assert.equal(f.c.state.attempt?.status, 'aborted')
  assert.equal(f.c.state.stopId, id(1)); assert.equal(f.c.canStop(), true)
  assert.equal(f.c.canLeave(), false)
  f.api.preflightRecordingPlan = async () => readyPreflight(); await f.c.preflight(); f.c.setStartConfirmed(true)
  assert.equal(f.c.canBegin(), false, '绿色预检不能替代旧run的软件静止证明')
  let reads = 0
  f.api.getRecordingAttempt = async () => { reads++; return { attempt: { ...quietAborted(), revision: 3 } } }
  t.mock.timers.tick(1000); await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(reads, 1); assert.equal(f.c.state.attempt?.revision, 3)
  assert.equal(f.c.state.attempt?.sides[0]?.stopAcknowledged, false, 'Stop ACK与资源静止分别核对')
  assert.equal(f.c.canStop(), false); assert.equal(f.c.canLeave(), true)
  t.mock.timers.tick(3000); await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(reads, 1, '新鲜静止事实后结束观察，不持续刷新已收口终态')
})

test('MBR-002：实体人工停止确认不能解除软件close未知锁，读取失败仍保留精确Stop与轮询', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const terminal = { ...aborted(), sides: aborted().sides.map(item => ({ ...item, physicalStopConfirmedAt: later })) }
  const f = await controller(fixture(terminal)); t.after(f.c.dispose)
  await f.c.select(id(1)); assert.equal(f.c.canLeave(), false); assert.equal(f.c.canStop(), true)
  let reads = 0
  f.api.getRecordingAttempt = async () => { reads++; throw new Error('/private/故障细节') }
  await f.c.readSelected(); assert.equal(f.c.state.attempt, undefined)
  assert.equal(f.c.canLeave(), false); assert.equal(f.c.canStop(), true)
  t.mock.timers.tick(1000); await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(reads, 2); assert.doesNotMatch(f.c.state.detailError, /private/u)
})

test('MBR-002：Begin在途和未知时锁不同历史ID，未选历史也不能切走原命令', async t => {
  const f = await controller(fixture(quietAborted())), wait = deferred<RecordingAttempt>()
  t.after(() => { wait.resolve(attempt()); f.c.dispose() })
  f.api.preflightRecordingPlan = async () => readyPreflight()
  f.api.beginRecordingAttempt = () => wait.promise
  await f.c.preflight(); f.c.setStartConfirmed(true)
  const begin = f.c.begin(); await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(f.c.state.beginSending, true); assert.equal(f.c.canSelect(id(1)), false)
  await f.c.select(id(1)); assert.equal(f.c.state.selectedId, '')
  wait.reject(new Error('[TIMEOUT] 合成回执未知')); await begin
  assert.ok(f.c.state.pendingBegin); assert.equal(f.c.canSelect(id(1)), false)
  await f.c.select(id(1)); assert.equal(f.c.state.selectedId, '')
})

test('MBR-002：迟到权威Begin不同ID仍绑定真实活动身份与停止入口，不让旧终态放行', async t => {
  const f = await controller(fixture({ ...quietAborted(), id: id(9) })); t.after(f.c.dispose)
  await f.c.select(id(9))
  f.api.preflightRecordingPlan = async () => readyPreflight(); await f.c.preflight(); f.c.setStartConfirmed(true)
  f.api.beginRecordingAttempt = async () => attempt()
  await f.c.begin()
  assert.equal(f.c.state.pendingBegin, undefined)
  assert.equal(f.c.state.selectedId, id(1)); assert.equal(f.c.state.stopId, id(1))
  assert.equal(f.c.canStop(), true); assert.equal(f.c.canLeave(), false)
})

test('MBR-002：手动读取同revision冲突拒绝覆盖可信run与Stop身份', async t => {
  const f = await controller(); t.after(f.c.dispose); await f.c.select(id(1))
  f.api.getRecordingAttempt = async () => ({ attempt: { ...attempt(), sides: [{ ...side(), runId: id(80) }] } })
  await f.c.readSelected()
  assert.equal(f.c.state.attempt, undefined); assert.ok(f.c.state.detailError)
  assert.equal(f.c.state.stopId, id(1)); assert.equal(f.c.canStop(), true); assert.equal(f.c.canLeave(), false)
})

for (const code of ['TIMEOUT', 'INTERNAL_ERROR', 'INVENTORY_UNAVAILABLE']) {
  test(`MBR-002：${code}未知Begin按原命令仅读核对，pending/unknown不解锁，accepted绑定当前事实`, async t => {
    const f = await controller(); t.after(f.c.dispose)
    f.api.preflightRecordingPlan = async () => readyPreflight()
    f.api.beginRecordingAttempt = async request => { f.calls.push({ name: 'begin', request }); throw new Error(`[${code}] /private/录音故障`) }
    await f.c.preflight(); f.c.setStartConfirmed(true); await f.c.begin()
    const original = structuredClone(f.c.state.pendingBegin)!
    const reads: RecordingAttemptReceiptRequest[] = []
    let status: 'pending' | 'unknown' | 'accepted' = 'unknown'
    f.api.getRecordingAttemptReceipt = async input => {
      reads.push(structuredClone(input))
      return status === 'accepted' ? { commandId: input.request.commandId, action: input.action, status, receipt: attempt(), attempt: { ...quietAborted(), revision: 3 } }
        : { commandId: input.request.commandId, action: input.action, status }
    }
    for (const next of ['unknown', 'pending'] as const) {
      status = next; await f.c.reconcileReceipt()
      assert.deepEqual(f.c.state.pendingBegin, original); assert.equal(f.c.canLeave(), false)
      assert.equal(f.calls.filter(call => call.name === 'begin').length, 1)
    }
    status = 'accepted'; await f.c.reconcileReceipt()
    assert.equal(f.c.state.pendingBegin, undefined); assert.equal(f.c.state.selectedId, id(1))
    assert.equal(f.c.state.attempt?.revision, 3); assert.equal(f.c.state.attempt?.status, 'aborted')
    assert.equal(f.c.canLeave(), true); assert.equal(f.c.canStop(), false)
    assert.deepEqual(reads, Array.from({ length: 3 }, () => ({ action: 'begin', request: original.request })))
    assert.equal(f.calls.filter(call => call.name === 'begin' || call.name === 'beginSide' || call.name === 'stop').length, 1)
    assert.doesNotMatch(f.c.state.operationError + f.c.state.receiptError + f.c.state.receiptNotice, /private/u)
  })
}

for (const kind of ['confirm', 'beginSide', 'stop'] as const) {
  test(`MBR-002：未知${kind}只读核对原action/request，不重新派发执行且应用最新软件事实`, async t => {
    const waiting = waitingB(); waiting.sides[0]!.cleanupQuiescent = true
    const f = await controller(fixture(kind === 'beginSide' ? waiting : kind === 'confirm' ? drained() : attempt())); t.after(f.c.dispose)
    await f.c.select(id(1))
    const fail = async (request: unknown): Promise<RecordingAttempt> => { f.calls.push({ name: kind, request }); throw new Error('[TIMEOUT] 合成回执未知') }
    if (kind === 'stop') { f.api.stopRecordingAttempt = fail; await f.c.stop() }
    else if (kind === 'confirm') { f.api.confirmRecordingAttempt = fail; f.c.setConfirmed(true); await f.c.confirm('physical-stop', 'A') }
    else { f.api.beginRecordingAttemptSide = fail; f.api.preflightRecordingPlan = async () => readyPreflight(); await f.c.preflight(); f.c.setSideConfirmed(true); await f.c.beginSide() }
    const original = structuredClone(f.c.state.pending); assert.ok(original)
    const receipt: RecordingAttempt = kind === 'beginSide' ? { ...waiting, revision: 2, updatedAt: later, phase: 'outputting' as const, activeSide: 'B' as const, sides: [waiting.sides[0]!, { ...side('B'), startedAt: later }] }
      : kind === 'stop' ? aborted() : { ...drained(), revision: 2, updatedAt: later, phase: 'final-verification' as const, sides: [{ ...drained().sides[0]!, phase: 'complete' as const, endedAt: later, physicalStopConfirmedAt: later }] }
    if (kind === 'confirm') delete receipt.activeSide
    const latest: RecordingAttempt = kind === 'beginSide' ? { ...receipt, status: 'aborted', phase: 'finished', activeSide: undefined, endedAt: later, reason: 'user-stop', revision: 3,
      sides: [receipt.sides[0]!, { ...receipt.sides[1]!, phase: 'aborted', endedAt: later, reason: 'user-stop', engineStoppedSubmitting: true, cleanupQuiescent: true }] }
      : { ...receipt, revision: 3, sides: receipt.sides.map(item => ({ ...item, engineStoppedSubmitting: true, cleanupQuiescent: true })) }
    assert.equal(isRecordingAttempt(receipt), true); assert.equal(isRecordingAttempt(latest), true)
    const reads: RecordingAttemptReceiptRequest[] = []
    f.api.getRecordingAttemptReceipt = async input => { reads.push(structuredClone(input)); return { commandId: input.request.commandId, action: input.action, status: 'accepted', receipt, attempt: latest } }
    await f.c.reconcileReceipt()
    assert.equal(f.c.state.pending, undefined); assert.equal(f.c.state.attempt?.revision, 3)
    assert.deepEqual(reads, [{ action: kind, request: original.request }]); assert.equal(f.calls.filter(call => call.name === kind).length, 1)
    assert.equal(f.c.state.receiptReading, false); assert.equal(f.c.state.receiptError, '')
  })
}

test('MBR-002：回执缺能力、读取失败及身份/谱系/revision冲突均保留未知Begin，不生成新ID', async t => {
  const f = await controller(); t.after(f.c.dispose)
  f.api.preflightRecordingPlan = async () => readyPreflight()
  f.api.beginRecordingAttempt = async request => { f.calls.push({ name: 'begin', request }); throw new Error('[TIMEOUT] 回执未知') }
  await f.c.preflight(); f.c.setStartConfirmed(true); await f.c.begin()
  const original = structuredClone(f.c.state.pendingBegin)!
  assert.equal(f.c.canReconcileReceipt(), false); await f.c.reconcileReceipt(); assert.deepEqual(f.c.state.pendingBegin, original)
  const valid: RecordingAttemptReceipt = { commandId: original.request.commandId, action: 'begin', status: 'accepted', receipt: attempt(), attempt: { ...quietAborted(), revision: 3 } }
  const invalid: unknown[] = [
    { ...valid, commandId: id(99) }, { ...valid, action: 'stop' },
    { ...valid, receipt: { ...attempt(), planContentHash: 'b'.repeat(64) }, attempt: { ...quietAborted(), revision: 3, planContentHash: 'b'.repeat(64) } },
    { ...valid, attempt: { ...quietAborted(), id: id(99), revision: 3 } },
    { ...valid, receipt: { ...attempt(), revision: 4 } },
    { ...valid, receipt: quietAborted(), attempt: aborted() },
    { ...valid, privatePath: '/private/故障细节' },
  ]
  f.api.getRecordingAttemptReceipt = async () => { throw new Error('/private/核对故障') }
  await f.c.reconcileReceipt(); assert.deepEqual(f.c.state.pendingBegin, original)
  for (const value of invalid) {
    f.api.getRecordingAttemptReceipt = async () => value as RecordingAttemptReceipt
    await f.c.reconcileReceipt(); assert.deepEqual(f.c.state.pendingBegin, original); assert.equal(f.c.canLeave(), false)
    assert.ok(f.c.state.receiptError); assert.doesNotMatch(f.c.state.receiptError, /private/u)
  }
  assert.equal(f.calls.filter(call => call.name === 'begin' || call.name === 'beginSide').length, 1)
})

test('明确Plan分页25，无自动首条、Begin或BeginB；无Plan不读取', async () => {
  const f = await controller(); assert.deepEqual(f.calls, [{ name: 'list', request: { planVersionId: id(3), draftId: id(2), page: { offset: 0, limit: 25 } } }]); assert.equal(f.c.state.attempt, undefined)
  f.c.setPlan(); await f.c.refresh(); assert.equal(f.calls.length, 1); f.c.dispose()
})
test('正式开始必须本次实时预检通过并明确确认；Begin仅发冻结计划身份，Core回执不伪造完成', async () => {
  const f = await controller()
  await f.c.preflight(); f.c.setStartConfirmed(true); assert.equal(f.c.canBegin(), false)
  f.api.preflightRecordingPlan = async request => { f.calls.push({ name: 'preflight', request }); return readyPreflight() }
  await f.c.preflight(); assert.equal(f.c.canBegin(), true)
  f.api.beginRecordingAttempt = async request => { f.calls.push({ name: 'begin', request }); return attempt() }
  await f.c.begin()
  assert.equal(f.calls.filter(call => call.name === 'preflight').length, 3, '点击开始仍须重新实时预检')
  const request = f.calls.find(call => call.name === 'begin')!.request as Record<string, unknown>
  assert.deepEqual(Object.keys(request).sort(), ['commandId', 'planContentHash', 'planVersionId', 'userConfirmed'])
  assert.equal(request.planVersionId, id(3)); assert.equal(request.planContentHash, hash)
  assert.equal(f.c.state.attempt?.status, 'in-progress'); assert.equal(f.c.state.attempt?.softwarePlaybackComplete, false)
  assert.equal(f.c.state.preflightPhase, 'unread', '开始回执后旧预检不能继续充当资格')
  f.c.dispose()
})
test('预检迟到不得替换已切换计划，未知开始回执保留同一命令供手动重试', async () => {
  const f = await controller(), admission = deferred<RecordingPreflightResult>()
  f.api.preflightRecordingPlan = () => admission.promise
  const old = f.c.preflight(); f.c.setPlan(); admission.resolve(readyPreflight()); await old
  assert.equal(f.c.state.preflightPhase, 'unread'); assert.equal(f.c.canBegin(), false)
  f.c.setPlan(plan()); await f.c.refresh()
  f.api.preflightRecordingPlan = async () => readyPreflight()
  await f.c.preflight(); f.c.setStartConfirmed(true)
  f.api.beginRecordingAttempt = async request => { f.calls.push({ name: 'begin', request }); throw new Error('/private/unknown') }
  await f.c.begin(); assert.ok(f.c.state.pendingBegin); assert.doesNotMatch(f.c.state.operationError, /private/u)
  await f.c.retryBegin()
  const requests = f.calls.filter(call => call.name === 'begin').map(call => call.request)
  assert.deepEqual(requests[0], requests[1]); f.c.dispose()
})
test('Main与Preload实际错误形状：仅确未受理码清除Begin，泛化失败保留原命令', async () => {
  for (const code of ['NOT_READY', 'INVENTORY_CONFLICT', 'ATTEMPT_NOT_ACCEPTED'] as const) {
    const f = await controller(), handlers = new Map<string, (event: boolean, envelope?: unknown) => unknown>()
    installRecordingAttemptHandlers({
      handle: (channel, handler) => handlers.set(channel, handler),
      requireTrusted: trusted => { assert.equal(trusted, true) },
      supervisor: { request: (async () => { throw new CoreIpcError(code, '/private/not-for-renderer') }) as never },
    })
    const client = createRecordingAttemptClient(async (channel, envelope) => {
      if (channel === 'commandOutbox:context') return { datasetId: id(90) }
      const handler = handlers.get(channel); assert.ok(handler, channel)
      return await handler(true, envelope)
    })
    f.api.beginRecordingAttempt = client.beginRecordingAttempt
    f.api.preflightRecordingPlan = async () => readyPreflight()
    await f.c.preflight(); f.c.setStartConfirmed(true); await f.c.begin()
    assert.equal(!!f.c.state.pendingBegin, code !== 'ATTEMPT_NOT_ACCEPTED', code)
    assert.equal(f.c.canLeave(), code === 'ATTEMPT_NOT_ACCEPTED', code)
    assert.doesNotMatch(f.c.state.operationError, /private|not-for-renderer/u)
    f.c.dispose()
  }
})
test('延迟 Begin 与未知回执阻断离开和切计划；原命令可手动核对，新鲜静止终态才可离开', async () => {
  const f = await controller(), begin = deferred<RecordingAttempt>()
  f.api.preflightRecordingPlan = async () => readyPreflight()
  f.api.beginRecordingAttempt = () => begin.promise
  await f.c.preflight(); f.c.setStartConfirmed(true)
  const pending = f.c.begin(); await new Promise<void>(done => setImmediate(done))
  assert.equal(f.c.canLeave(), false); assert.match(f.c.leaveBlockReason()!, /开始命令回执尚未确认/u)
  f.c.setPlan(); assert.equal(f.c.state.plan?.id, id(3), '未确认 Begin 不能丢失原计划身份')
  begin.resolve(attempt()); await pending
  assert.equal(f.c.canLeave(), false); assert.match(f.c.leaveBlockReason()!, /正式输出或停止收口/u)
  await f.c.stop(); assert.equal(f.c.state.attempt?.status, 'aborted'); assert.equal(f.c.canLeave(), false)
  f.api.getRecordingAttempt = async () => ({ attempt: { ...quietAborted(), revision: 3 } }); await f.c.readSelected(); assert.equal(f.c.canLeave(), true)
  f.c.setPlan(); assert.equal(f.c.state.plan, undefined); f.c.dispose()

  const unknown = await controller(); unknown.api.preflightRecordingPlan = async () => readyPreflight()
  unknown.api.beginRecordingAttempt = async () => { throw new Error('/private/unknown') }
  await unknown.c.preflight(); unknown.c.setStartConfirmed(true); await unknown.c.begin()
  assert.ok(unknown.c.state.pendingBegin); assert.equal(unknown.c.canLeave(), false)
  unknown.c.setPlan(); assert.equal(unknown.c.state.plan?.id, id(3)); assert.ok(unknown.c.state.pendingBegin)
  unknown.c.dispose()
})
test('Begin失回执后同Plan记录不能冒充原命令；权威仅读核对才能绑定精确停止身份', async () => {
  const f = await controller(); f.api.preflightRecordingPlan = async () => readyPreflight()
  f.api.beginRecordingAttempt = async () => { throw new Error('[NOT_READY] 回执未知') }
  await f.c.preflight(); f.c.setStartConfirmed(true); await f.c.begin()
  const pending = structuredClone(f.c.state.pendingBegin); assert.ok(pending)
  await f.c.refresh(); await f.c.select(id(1))
  assert.equal(f.c.state.attempt, undefined); assert.equal(f.c.canStop(), false)
  assert.deepEqual(f.c.state.pendingBegin, pending, '同Plan记录不能冒充原命令回执')
  assert.equal(f.c.canBegin(), false); assert.equal(f.c.canLeave(), false)
  f.api.getRecordingAttemptReceipt = async input => ({ commandId: input.request.commandId, action: input.action, status: 'accepted', receipt: attempt(), attempt: attempt() })
  await f.c.reconcileReceipt(); assert.equal(f.c.state.pendingBegin, undefined); assert.equal(structuredClone(f.c.state).attempt?.id, id(1)); assert.equal(f.c.canStop(), true)
  await f.c.stop(); assert.equal(structuredClone(f.c.state).attempt?.status, 'aborted'); assert.equal(f.c.canLeave(), false)
  f.c.dispose()
})
test('原Begin核对后Stop优先，晚人工回执不覆盖较新的终止事实或卡住发送态', async () => {
  const f = await controller(), confirmation = deferred<RecordingAttempt>()
  f.api.preflightRecordingPlan = async () => readyPreflight()
  f.api.beginRecordingAttempt = async () => { throw new Error('[TIMEOUT] 原Begin未知') }
  await f.c.preflight(); f.c.setStartConfirmed(true); await f.c.begin()
  f.api.getRecordingAttemptReceipt = async input => ({ commandId: input.request.commandId, action: input.action, status: 'accepted', receipt: attempt(), attempt: { ...drained(), revision: 2 } })
  await f.c.reconcileReceipt(); assert.equal(f.c.canStop(), true)
  f.api.confirmRecordingAttempt = () => confirmation.promise; f.c.setConfirmed(true)
  const waitingConfirmation = f.c.confirm('physical-stop', 'A')
  f.api.stopRecordingAttempt = async () => ({ ...aborted(), revision: 3 })
  await f.c.stop(); assert.equal(f.c.state.attempt?.status, 'aborted')
  assert.equal(f.c.state.sending, false)
  confirmation.resolve({ ...drained(), revision: 4 }); await waitingConfirmation
  assert.equal(f.c.state.beginSending, false); assert.equal(f.c.state.pendingBegin, undefined)
  assert.equal(f.c.state.attempt?.status, 'aborted'); assert.equal(f.c.state.attempt?.revision, 3)
  assert.equal(f.c.canLeave(), false)
  f.api.getRecordingAttempt = async () => ({ attempt: { ...quietAborted(), revision: 4 } }); await f.c.readSelected()
  assert.equal(f.c.canLeave(), true); f.c.dispose()
})
test('Stop回执在途与未知结果期间不能交叉重试Begin，Stop完成后发送态正常释放', async () => {
  const f = await controller(), stopping = deferred<RecordingAttempt>()
  f.api.preflightRecordingPlan = async () => readyPreflight()
  let begins = 0
  f.api.beginRecordingAttempt = async () => { begins++; throw new Error('[NOT_READY] 开始回执未知') }
  await f.c.preflight(); f.c.setStartConfirmed(true); await f.c.begin()
  assert.equal(begins, 1); assert.ok(f.c.state.pendingBegin)
  f.api.getRecordingAttemptReceipt = async input => ({ commandId: input.request.commandId, action: input.action, status: 'accepted', receipt: attempt(), attempt: attempt() })
  await f.c.reconcileReceipt(); assert.equal(f.c.canStop(), true)
  f.api.stopRecordingAttempt = () => stopping.promise
  const waitingStop = f.c.stop(); await new Promise<void>(done => setImmediate(done))
  await f.c.retryBegin(); assert.equal(begins, 1); assert.equal(f.c.state.sending, true)
  stopping.reject(new Error('[TIMEOUT] 停止回执未知')); await waitingStop
  assert.equal(f.c.state.sending, false); assert.ok(f.c.state.pending)
  await f.c.retryBegin(); assert.equal(begins, 1, '未知Stop未核对时不交叉重试Begin')
  f.c.dispose()
})
test('人工命令未知与已知输出中不可开新Attempt或切历史；详情读取失败仍保留Stop身份', async () => {
  const f = await controller(fixture(aborted())); await f.c.select(id(1))
  f.api.confirmRecordingAttempt = async () => { throw new Error('[NOT_READY] 回执未知') }
  f.c.setConfirmed(true); await f.c.confirm('physical-stop', 'A')
  f.api.preflightRecordingPlan = async () => readyPreflight()
  await f.c.preflight(); f.c.setStartConfirmed(true)
  assert.equal(f.c.canBegin(), false, '旧人工操作未知时不签发新的Begin命令')
  f.c.dispose()

  const active = await controller()
  active.api.listRecordingAttempts = async request => ({ items: [attempt(), { ...attempt(), id: id(9) }], offset: request.page.offset, limit: 25, total: 2, hasMore: false })
  await active.c.refresh(); await active.c.select(id(1))
  assert.equal(active.c.canSelect(id(9)), false); assert.match(active.c.selectionLockReason()!, /不能切换/u)
  active.api.getRecordingAttempt = async () => { throw new Error('读取失败') }; await active.c.readSelected()
  assert.equal(active.c.state.attempt, undefined); assert.equal(active.c.canSelect(id(9)), false, '详情暂不可读不应丢失已知活动Stop身份')
  await active.c.select(id(9)); assert.equal(active.c.state.selectedId, id(1)); assert.equal(active.c.canStop(), true)
  await active.c.stop(); assert.equal(active.c.canSelect(id(9)), false)
  active.api.getRecordingAttempt = async () => ({ attempt: { ...quietAborted(), revision: 3 } }); await active.c.readSelected()
  assert.equal(active.c.canSelect(id(9)), true); active.c.dispose()
})
test('只读poll只在确认依据变化时撤勾；重复事实、进度与revision不抹除确认或回执', async () => {
  const f = await controller(fixture(drained())); await f.c.select(id(1)); await f.c.preflight()
  f.api.preflightRecordingPlan = async () => readyPreflight(); await f.c.preflight()
  f.c.setConfirmed(true); f.c.setSideConfirmed(true); f.c.state.notice = '已收到原操作回执'
  const unchanged = { ...drained(), revision: 2 }
  f.api.getRecordingAttempt = async () => ({ attempt: unchanged }); await f.c.pollSelected()
  assert.equal(f.c.state.confirmed, true); assert.equal(f.c.state.sideConfirmed, true); assert.equal(f.c.state.notice, '已收到原操作回执'); assert.equal(f.c.state.preflightPhase, 'ready')
  const final = { ...drained(), revision: 3, phase: 'final-verification' as const,
    sides: [{ ...drained().sides[0]!, phase: 'complete' as const, endedAt: later, physicalStopConfirmedAt: later }] }
  delete final.activeSide
  assert.equal(isRecordingAttempt(final), true)
  f.api.getRecordingAttempt = async () => ({ attempt: final }); await f.c.pollSelected()
  assert.equal(f.c.state.confirmed, false); assert.equal(f.c.state.sideConfirmed, false); assert.equal(f.c.state.preflightPhase, 'unread')
  assert.equal(f.c.state.notice, '已收到原操作回执'); f.c.dispose()

  const progress = await controller(); await progress.c.select(id(1)); progress.c.setConfirmed(true)
  const withProgress = { ...attempt(), revision: 2, updatedAt: later,
    sides: [{ ...side(), sourceFramesRead: 100, submittedFrames: 100, consumedFrames: 80 }] }
  assert.equal(isRecordingAttempt(withProgress), true)
  progress.api.getRecordingAttempt = async () => ({ attempt: withProgress }); await progress.c.pollSelected()
  assert.equal(progress.c.state.confirmed, true); progress.c.dispose()
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
test('BeginB仅显式方法和翻面阶段，本次预检与独立确认缺一不可', async () => {
  const f = await controller(fixture(waitingB())); await f.c.select(id(1)); assert.equal(f.calls.some(c => c.name === 'beginSide'), false)
  await f.c.beginSide(); assert.equal(f.calls.some(c => c.name === 'beginSide'), false)
  f.c.setSideConfirmed(true); await f.c.beginSide(); assert.equal(f.calls.some(c => c.name === 'beginSide'), false)
  f.api.preflightRecordingPlan = async request => { f.calls.push({ name: 'preflight', request }); return readyPreflight() }
  await f.c.preflight(); f.c.setSideConfirmed(true); await f.c.beginSide(); const request = f.calls.find(c => c.name === 'beginSide')!.request as object
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

async function mounted(t: test.TestContext, api: RecordingAttemptsPublicApi & Pick<RecordingPlansPublicApi, 'preflightRecordingPlan'>, initial = plan()) {
  const { parse, compileScript, compileTemplate } = await import('@vue/compiler-sfc'), ts = (await import('typescript')).default
  const require = createRequire(import.meta.url), vue = require('vue') as typeof import('vue')
  const source = await readFile(new URL('../src/renderer/src/components/recording/RecordingAttemptPanel.vue', import.meta.url), 'utf8').catch(() => '')
  assert.ok(source, '缺少实际录音尝试面板SFC'); const { descriptor, errors } = parse(source); assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: 'recording-attempt-panel' })
  const controller = await import('../src/renderer/src/components/recording/recording-attempt-controller.js')
  const load = (name: string) => name === 'vue' ? vue : name === './recording-attempt-controller' ? controller : name === './DatCueReminders.vue' ? { default: { render: () => null } } : require(name)
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
  const leaveStates: Array<{ canLeave: boolean; reason: string | null }> = []
  const root = node(), app = renderer.createApp({ setup: () => () => vue.h(component, { plan: selected.value, onLeaveState: (value: { canLeave: boolean; reason: string | null }) => leaveStates.push(value) }) }); app.mount(root); t.after(() => app.unmount())
  const tick = async () => { await new Promise<void>(done => setImmediate(done)); await vue.nextTick() }; await tick()
  const all = (current = root): Host[] => [current, ...current.children.flatMap(child => all(child))], text = (current = root): string => current.text + current.children.map(child => text(child)).join(' ')
  const button = (label: string) => { const target = all().find(n => n.tag === 'button' && text(n).trim() === label); assert.ok(target, label); return target }
  const confirm = async () => { const target = all().find(n => n.props.id === 'recording-attempt-confirm'); assert.ok(target); (target.props.onChange as (e: unknown) => void)({ target: { checked: true } }); await tick() }
  const startConfirm = async () => { const target = all().find(n => n.props.id === 'recording-attempt-start-confirm'); assert.ok(target); (target.props.onChange as (e: unknown) => void)({ target: { checked: true } }); await tick() }
  const sideConfirm = async () => { const target = all().find(n => n.props.id === 'recording-attempt-side-b-confirm'); assert.ok(target); (target.props.onChange as (e: unknown) => void)({ target: { checked: true } }); await tick() }
  const click = async (label: string) => { const target = button(label); assert.notEqual(target.props.disabled, true); await (target.props.onClick as (e: unknown) => unknown)({ currentTarget: target }); await tick() }
  return { all, text, button, confirm, startConfirm, sideConfirm, click, tick, selected, leaveStates, focused: () => focusDocument.activeElement, bodyFocused: () => focusDocument.activeElement === focusDocument.body, unmount: () => app.unmount() }
}

test('MBR-002：真实SFC提供原命令仅读核对，未知不重放，受理后保留软件停止入口', async t => {
  const f = fixture(); f.api.preflightRecordingPlan = async () => readyPreflight()
  let accepted = false
  f.api.getRecordingAttemptReceipt = async input => {
    f.calls.push({ name: 'receipt', request: input })
    return accepted ? { commandId: input.request.commandId, action: input.action, status: 'accepted', receipt: attempt(), attempt: attempt() }
      : { commandId: input.request.commandId, action: input.action, status: 'unknown' }
  }
  const panel = await mounted(t, f.api)
  await panel.click('本次正式输出预检'); await panel.startConfirm(); await panel.click('开始正式录音')
  const begin = f.calls.find(call => call.name === 'begin')!.request
  await panel.click('核对原命令回执（仅读）')
  assert.match(panel.text(), /缺席不等于未受理/u); assert.equal(panel.leaveStates.at(-1)?.canLeave, false)
  assert.equal(f.calls.filter(call => call.name === 'begin').length, 1)
  accepted = true; await panel.click('核对原命令回执（仅读）')
  assert.deepEqual(f.calls.filter(call => call.name === 'receipt').map(call => call.request), [{ action: 'begin', request: begin }, { action: 'begin', request: begin }])
  assert.equal(panel.button('停止本次录音').props.disabled, false)
  assert.equal(panel.leaveStates.at(-1)?.canLeave, false); assert.equal(f.calls.filter(call => call.name === 'stop').length, 0)
  await panel.click('停止本次录音')
  assert.match(panel.text(), /资源静止：未确认/u); assert.equal(panel.leaveStates.at(-1)?.canLeave, false)
  assert.equal(panel.button('停止本次录音').props.disabled, false)
})

test('MBR-002：真实SFC工作库无只读核对能力时不伪造回执，也不自动执行重试', async t => {
  const f = fixture(); f.api.preflightRecordingPlan = async () => readyPreflight()
  const panel = await mounted(t, f.api)
  await panel.click('本次正式输出预检'); await panel.startConfirm(); await panel.click('开始正式录音')
  assert.equal(panel.button('核对原命令回执（仅读）').props.disabled, true)
  assert.match(panel.text(), /当前窗口不支持只读核对/u)
  assert.equal(f.calls.filter(call => call.name === 'begin').length, 1)
  assert.equal(panel.leaveStates.at(-1)?.canLeave, false)
})

test('MBR-002：真实SFC停止已受理仍保留核对入口，重复按钮沿用原Stop直到软件静止', async t => {
  const f = fixture(), panel = await mounted(t, f.api)
  await panel.click('查看录音尝试 '+id(1)); await panel.click('停止本次录音')
  const original = structuredClone(f.calls.find(call => call.name === 'stop')!.request)
  assert.match(panel.text(), /停止已受理，软件静止仍待确认/u)
  assert.equal(panel.button('核对原命令回执（仅读）').props.disabled, true, '缺读取能力不能伪造核对')
  await panel.click('停止本次录音')
  assert.deepEqual(f.calls.filter(call => call.name === 'stop').map(call => call.request), [original, original])
  f.api.getRecordingAttempt = async () => ({ attempt: { ...quietAborted(), revision: 3 } })
  await panel.click('重新读取本次状态')
  assert.equal(panel.leaveStates.at(-1)?.canLeave, true)
  assert.doesNotMatch(panel.text(), /停止已受理，软件静止仍待确认/u)
  assert.equal(panel.all().some(node => node.tag === 'button' && panel.text(node) === '核对原命令回执（仅读）'), false)
})

test('真实SFC将离开状态同步通知父面板，输出和静止未知终态拦截、可信收口后释放', async t => {
  const f = fixture(), panel = await mounted(t, f.api)
  assert.equal(panel.leaveStates.at(-1)?.canLeave, true)
  await panel.click('查看录音尝试 '+id(1)); assert.equal(panel.leaveStates.at(-1)?.canLeave, false)
  await panel.click('停止本次录音'); assert.equal(panel.leaveStates.at(-1)?.canLeave, false)
  f.api.getRecordingAttempt = async () => ({ attempt: { ...quietAborted(), revision: 3 } })
  await panel.click('重新读取本次状态'); assert.equal(panel.leaveStates.at(-1)?.canLeave, true)
})

test('真实SFC预检明确GateB阻断、空态和历史不默认选，执行按钮禁用', async t => {
  const f = fixture(); f.api.listRecordingAttempts = async () => ({ items: [], offset: 0, limit: 25, total: 0, hasMore: false }); const panel = await mounted(t, f.api)
  assert.match(panel.text(), /这份计划尚无正式录音尝试；未生成演示记录。/u)
  await panel.click('本次正式输出预检'); assert.match(panel.text(), /Gate B.*NOT_RUN/u)
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
  panel.selected.value = undefined; await panel.tick(); assert.match(panel.text(), /用户中止/u); assert.equal(panel.leaveStates.at(-1)?.canLeave, false)
  panel.selected.value = plan(); await panel.tick()
  f.api.getRecordingAttempt = async () => ({ attempt: { ...quietAborted(), revision: 3 } }); await panel.click('重新读取本次状态')
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
  panel.selected.value = undefined; await panel.tick(); assert.equal(panel.button('停止本次录音').props.disabled, false)
  panel.selected.value = plan(); await panel.tick()
  f.api.getRecordingAttempt = async () => ({ attempt: { ...quietAborted(), revision: 3 } }); await panel.click('重新读取本次状态')
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
test('列表重读/切Plan使旧列表失效，待回执时拒切Plan；强制卸载后迟到回执不恢复旧详情', async () => {
  const f = await controller(), list = deferred<Awaited<ReturnType<RecordingAttemptsPublicApi['listRecordingAttempts']>>>()
  f.api.listRecordingAttempts = () => list.promise; const stale = f.c.refresh(); f.c.setPlan()
  list.resolve({ items: [attempt()], offset: 0, limit: 25, total: 1, hasMore: false }); await stale; assert.equal(f.c.state.page, undefined)
  for (const dispose of [false, true]) {
    const g = await controller(); await g.c.select(id(1)); const wait = deferred<RecordingAttempt>(); g.api.stopRecordingAttempt = () => wait.promise
    const write = g.c.stop(); if (dispose) g.c.dispose(); else { g.c.setPlan(); assert.equal(g.c.state.plan?.id, id(3)); assert.equal(g.c.canLeave(), false) }
    wait.resolve(aborted()); await write
    if (!dispose) {
      assert.equal(g.c.state.attempt?.status, 'aborted'); g.c.setPlan(); assert.equal(g.c.canLeave(), false)
      g.api.getRecordingAttempt = async () => ({ attempt: { ...quietAborted(), revision: 3 } }); await g.c.readSelected(); g.c.setPlan()
    }
    assert.equal(g.c.state.attempt, undefined); assert.equal(g.c.state.stopId, ''); g.c.dispose()
  }
  f.c.dispose()
})
