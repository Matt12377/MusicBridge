import assert from 'node:assert/strict'
import test from 'node:test'
import * as dto from '@music-bridge/contracts'
import { installLocalRelocationHandlers, relocationRequestFingerprint, type LocalRelocationHandlersOptions } from '../../src/main/local-relocation-ipc.js'
import { createLocalRelocationClient } from '../../src/preload/local-relocation-client.js'
import { datasetId, fixture, fingerprint, id, issue, readyPlan, selection } from './fixture.js'

interface Event { trusted: boolean }
function harness(t: test.TestContext) {
  const f = fixture(), value = readyPlan(); f.plans.set(value.planId, value); f.context.policy.enabled = true
  const confirm: dto.LocalRelocationPlanConfirm = { datasetId, commandId: id(60), planId: value.planId, expectedViewRevision: value.viewRevision, domain: 'LOCAL_RELOCATION_V1', planHash: value.planHash, contextFingerprint: value.contextFingerprint }
  const handlers = new Map<string, (event: Event, value?: unknown) => unknown>(), privateCalls: { command: dto.LocalRelocationMainCommand; payload: dto.LocalRelocationMainCommandPayloads[dto.LocalRelocationMainCommand] }[] = []
  let lost = false, pickerCalls = 0, picker: (() => Promise<{ canceled: boolean; filePaths: string[] }>) | null = null, transform: ((value: unknown) => unknown) | null = null
  let challengeTransform: ((value: dto.LocalRelocationMainChallenge) => dto.LocalRelocationMainChallenge) | null = null
  const publicRequest = async (command: dto.LocalRelocationPlanCommand, payload: dto.LocalRelocationPlanCommandPayloads[dto.LocalRelocationPlanCommand]) => {
    const result = await f.dispatch(command, payload)
    return transform && command === 'localRelocationPlan.get' && (payload as dto.LocalRelocationPlanCommandPayloads['localRelocationPlan.get']).selector.kind === 'command' ? transform(result) : result
  }
  const requestMain = async (command: dto.LocalRelocationMainCommand, payload: dto.LocalRelocationMainCommandPayloads[dto.LocalRelocationMainCommand]) => {
    privateCalls.push({ command, payload: structuredClone(payload) })
    if (command === 'localRelocationMain.captureTarget') return { choiceId: id(70), kind: (payload as dto.LocalRelocationMainCaptureTarget).kind, label: '自有选择目录', expiresAt: new Date(Date.now() + 600000).toISOString() }
    if (command === 'localRelocationMain.challenge' || command === 'localRelocationMain.challengeCleanup') {
      const cleanup = command === 'localRelocationMain.challengeCleanup', request = cleanup ? (payload as dto.LocalRelocationMainCommandPayloads['localRelocationMain.challengeCleanup']).cleanup : (payload as dto.LocalRelocationMainCommandPayloads['localRelocationMain.challenge']).confirm
      const challenge: dto.LocalRelocationMainChallenge = { datasetId, commandId: request.commandId, planId: request.planId, expectedViewRevision: request.expectedViewRevision, domain: 'LOCAL_RELOCATION_V1', action: cleanup ? 'cleanup' : 'execute', planHash: request.planHash, contextFingerprint: request.contextFingerprint, policyRevision: '1', requestFingerprint: fingerprint(cleanup ? 'localRelocationPlan.cleanup' : 'localRelocationPlan.confirm', request), verifiedTargetFingerprint: cleanup ? (request as dto.LocalRelocationPlanCleanup).verifiedTargetFingerprint : null, sourceResourceIds: cleanup ? [...(request as dto.LocalRelocationPlanCleanup).sourceResourceIds] : [], expiresAt: new Date(Date.now() + 600000).toISOString(), grant: { domain: 'LOCAL_RELOCATION_V1', action: cleanup ? 'cleanup' : 'execute', challengeId: id(71), ownerEpoch: id(72), nonce: 'd'.repeat(64), authorityId: id(73), signature: 'e'.repeat(64) } }
      return challengeTransform ? challengeTransform(challenge) : challenge
    }
    const cleanup = command === 'localRelocationMain.cleanupGranted', request = cleanup ? (payload as dto.LocalRelocationMainCommandPayloads['localRelocationMain.cleanupGranted']).cleanup : (payload as dto.LocalRelocationMainCommandPayloads['localRelocationMain.executeGranted']).confirm
    const result = f.receipt(cleanup ? 'localRelocationPlan.cleanup' : 'localRelocationPlan.confirm', request, f.plans.get(request.planId) ?? value)
    if (lost) throw new Error('受控原ACK失联，Core receipt已保存')
    return result
  }
  const control = installLocalRelocationHandlers<Event>({ handle: (channel, handler) => { handlers.set(channel, handler) }, requireTrusted: event => { if (!event.trusted) throw new Error('不可信窗口') }, requestPublic: publicRequest as LocalRelocationHandlersOptions<Event>['requestPublic'], requestMain: requestMain as LocalRelocationHandlersOptions<Event>['requestMain'], pickTarget: async () => { pickerCalls++; return picker ? picker() : { canceled: false, filePaths: ['/自有私有目录/实际目标'] } } })
  t.after(() => control.close())
  const call = (command: dto.LocalRelocationPlanCommand, payload: unknown, trusted = true) => Promise.resolve(handlers.get('localRelocationPlan:request')!({ trusted }, { datasetId, command, payload }))
  const query = (request: dto.LocalRelocationPlanConfirm) => call('localRelocationPlan.get', { datasetId, selector: { kind: 'command', commandId: request.commandId, expectedCommand: 'localRelocationPlan.confirm', requestFingerprint: fingerprint('localRelocationPlan.confirm', request) } })
  return { f, confirm, privateCalls, call, query, control, pickerCalls: () => pickerCalls, loseAck: (enabled = true) => { lost = enabled }, changeQuery: (change: typeof transform) => { transform = change }, changeChallenge: (change: typeof challengeTransform) => { challengeTransform = change }, setPicker: (pick: typeof picker) => { picker = pick } }
}

test('013真实Main叶最终确认只走本域challenge/execute，公开受理回执无path/grant', async t => {
  const h = harness(t), receipt = await h.call('localRelocationPlan.confirm', h.confirm)
  assert.equal(dto.isLocalRelocationPlanCommandResult('localRelocationPlan.confirm', receipt), true)
  assert.deepEqual(h.privateCalls.map(value => value.command), ['localRelocationMain.challenge', 'localRelocationMain.executeGranted'])
  assert.doesNotMatch(JSON.stringify(receipt), /grant|nonce|authorityId|absolutePath|ownerEpoch/u)
  assert.equal(relocationRequestFingerprint('localRelocationPlan.confirm', h.confirm), fingerprint('localRelocationPlan.confirm', h.confirm))
  await h.call('localRelocationPlan.confirm', h.confirm); assert.equal(h.privateCalls.length, 2)
})
test('013选择目标只捕获真实picker结果，取消/不可信/换scope/关闭都零额外捕获', async t => {
  const h = harness(t), choose: dto.LocalRelocationTargetRequest = { datasetId, commandId: id(80), kind: 'directory' }
  const result = await h.call('localRelocationPlan.chooseTarget', choose)
  assert.equal(dto.isLocalRelocationPlanCommandResult('localRelocationPlan.chooseTarget', result), true); assert.doesNotMatch(JSON.stringify(result), /absolutePath|自有私有目录/u)
  assert.deepEqual(h.privateCalls[0]?.payload, { ...choose, absolutePath: '/自有私有目录/实际目标' })
  h.setPicker(async () => ({ canceled: true, filePaths: [] })); assert.equal(await h.call('localRelocationPlan.chooseTarget', { ...choose, commandId: id(81) }), null)
  await assert.rejects(() => h.call('localRelocationPlan.chooseTarget', choose, false)); await assert.rejects(() => h.call('localRelocationPlan.chooseTarget', { ...choose, datasetId: id(99) }))
  h.setPicker(async () => { h.control.close(); return { canceled: false, filePaths: ['/私有已关闭目标'] } }); await assert.rejects(() => h.call('localRelocationPlan.chooseTarget', { ...choose, commandId: id(82) }))
  assert.equal(h.privateCalls.length, 1); assert.equal(h.pickerCalls(), 3)
})
test('013公开伪path/FD/grant/actor/Reader事实/getter和旧012domain均拒绝，不触私有能力', async t => {
  const h = harness(t); let getters = 0
  const getter = Object.defineProperty({ ...h.confirm }, 'planId', { enumerable: true, get() { getters++; return h.confirm.planId } })
  for (const payload of [{ ...h.confirm, absolutePath: '/私有路径' }, { ...h.confirm, fd: 7 }, { ...h.confirm, grant: {} }, { ...h.confirm, actor: 'MAIN' }, { ...h.confirm, readFacts: [] }, { ...h.confirm, domain: 'SOURCE_FILES' }, getter]) await assert.rejects(() => h.call('localRelocationPlan.confirm', payload))
  assert.equal(getters, 0); assert.deepEqual(h.privateCalls, []); assert.equal(h.f.calls.length, 0)
})
test('013cleanup是新的具体能力，首次execute不能带cleanup资源或跨action grant', async t => {
  const h = harness(t), cleanup: dto.LocalRelocationPlanCleanup = { ...h.confirm, commandId: id(83), verifiedTargetFingerprint: 'f'.repeat(64), sourceResourceIds: readyPlan().resources.map(resource => resource.resourceId) }
  await h.call('localRelocationPlan.cleanup', cleanup)
  assert.deepEqual(h.privateCalls.map(value => value.command), ['localRelocationMain.challengeCleanup', 'localRelocationMain.cleanupGranted'])
  const other = harness(t); other.changeChallenge(value => ({ ...value, grant: { ...value.grant, action: 'cleanup' } }))
  await assert.rejects(() => other.call('localRelocationPlan.confirm', other.confirm)); assert.equal(other.privateCalls.length, 1)
})
test('013原ACK失联→合法只读GET回收槽→既有receipt查询不重签，新具体计划可进入', async t => {
  const h = harness(t); h.loseAck(); await assert.rejects(() => h.call('localRelocationPlan.confirm', h.confirm)); assert.equal(h.privateCalls.length, 2)
  await assert.rejects(() => h.call('localRelocationPlan.confirm', h.confirm)); assert.equal(h.privateCalls.length, 2)
  const restored = await h.query(h.confirm) as dto.LocalRelocationPlanGetResult
  assert.equal(restored.kind === 'command' && restored.receipt?.commandId, h.confirm.commandId)
  h.loseAck(false); await h.call('localRelocationPlan.confirm', h.confirm); assert.equal(h.privateCalls.length, 2)
  const next = { ...h.confirm, commandId: id(84), planId: id(85) }; await h.call('localRelocationPlan.confirm', next)
  assert.equal(h.privateCalls.filter(value => value.command === 'localRelocationMain.executeGranted').length, 2)
})
test('013 UNKNOWN/null/错command或fingerprint只读查询不回收原槽，不重新执行', async t => {
  for (const variant of ['unknown', 'fingerprint', 'command'] as const) {
    const h = harness(t); h.loseAck(); await assert.rejects(() => h.call('localRelocationPlan.confirm', h.confirm))
    h.changeQuery(raw => {
      const value = raw as Extract<dto.LocalRelocationPlanGetResult, { kind: 'command' }>
      return variant === 'unknown' ? { ...value, receipt: null, issue: issue('COMMAND_UNKNOWN') } : variant === 'fingerprint' ? { ...value, requestFingerprint: 'f'.repeat(64) } : { ...value, expectedCommand: 'localRelocationPlan.cleanup' }
    })
    if (variant === 'unknown') await h.query(h.confirm); else await assert.rejects(() => h.query(h.confirm))
    await assert.rejects(() => h.call('localRelocationPlan.confirm', h.confirm)); assert.equal(h.privateCalls.length, 2)
  }
})
test('013 128个原未知槽整体拒新投递，精确GET恢复一个槽后容量可回收且原执行各一次', async t => {
  const h = harness(t); h.loseAck()
  const originals = Array.from({ length: 128 }, (_, index) => ({ ...h.confirm, commandId: id(1000 + index) }))
  for (const request of originals) await assert.rejects(() => h.call('localRelocationPlan.confirm', request))
  const next = { ...h.confirm, commandId: id(2000) }, calls = h.privateCalls.length
  await assert.rejects(() => h.call('localRelocationPlan.confirm', next)); assert.equal(h.privateCalls.length, calls)
  await h.query(originals[0]!); h.loseAck(false); await h.call('localRelocationPlan.confirm', next)
  assert.equal(h.privateCalls.filter(value => value.command === 'localRelocationMain.executeGranted').length, 129)
  const executed = h.privateCalls.filter(value => value.command === 'localRelocationMain.executeGranted').map(value => (value.payload as dto.LocalRelocationMainCommandPayloads['localRelocationMain.executeGranted']).confirm.commandId)
  assert.equal(new Set(executed).size, 129); await h.call('localRelocationPlan.confirm', originals[0]!); assert.equal(h.privateCalls.length, calls + 2)
})
test('013 Core已知COMMAND_UNKNOWN即使Main首次见到也只查询，不申请能力', async t => {
  const h = harness(t); h.f.unknown.add(h.confirm.commandId)
  await assert.rejects(() => h.call('localRelocationPlan.confirm', h.confirm)); assert.deepEqual(h.privateCalls, [])
})
test('013 Preload先捕获完整请求再等待scope，旧输入修改不改变已确认意图', async () => {
  const f = fixture(); f.context.policy.enabled = true
  let resolveScope!: (value: string) => void, sent: unknown
  const scope = new Promise<string>(resolve => { resolveScope = resolve })
  const client = createLocalRelocationClient({ scope: () => scope, invoke: async (_channel, envelope) => { sent = envelope; const value = envelope as { command: dto.LocalRelocationPlanCommand; payload: dto.LocalRelocationPlanCommandPayloads[dto.LocalRelocationPlanCommand] }; return f.dispatch(value.command, value.payload) } })
  const request: dto.LocalRelocationPlanCommandPayloads['localRelocationPlan.preview'] = { datasetId, commandId: id(2100), intent: { kind: 'rename', target: { ...selection }, newName: '原确认的Unicode-é.wav', sourceDisposition: 'RETAIN' } }
  const pending = client.localRelocationPlan('localRelocationPlan.preview', request); request.intent = { kind: 'rename', target: { ...selection }, newName: '迟到修改.wav', sourceDisposition: 'RETAIN' }; resolveScope(datasetId); await pending
  assert.equal((sent as { payload: dto.LocalRelocationPlanCommandPayloads['localRelocationPlan.preview'] }).payload.intent.kind, 'rename')
  assert.equal(((sent as { payload: dto.LocalRelocationPlanCommandPayloads['localRelocationPlan.preview'] }).payload.intent as Extract<dto.LocalRelocationPlanIntent, { kind: 'rename' }>).newName, '原确认的Unicode-é.wav')
})
test('013 Preload无自动scope调用，getter/错scope/错receipt全拒，公开仅一个generic叶API', async () => {
  let scopes = 0, invokes = 0, getters = 0
  const f = fixture(), client = createLocalRelocationClient({ scope: async () => { scopes++; return datasetId }, invoke: async (_channel, envelope) => { invokes++; const value = envelope as { command: dto.LocalRelocationPlanCommand; payload: dto.LocalRelocationPlanCommandPayloads[dto.LocalRelocationPlanCommand] }; return f.dispatch(value.command, value.payload) } })
  assert.equal(scopes, 0); assert.deepEqual(Object.keys(client), ['localRelocationPlan'])
  const getter = Object.defineProperty({ datasetId, commandId: id(2200), kind: 'directory' }, 'kind', { enumerable: true, get() { getters++; return 'directory' } })
  await assert.rejects(() => client.localRelocationPlan('localRelocationPlan.chooseTarget', getter as dto.LocalRelocationTargetRequest)); assert.equal(getters, 0); assert.equal(scopes, 0)
  await assert.rejects(() => client.localRelocationPlan('localRelocationPlan.chooseTarget', { datasetId: id(99), commandId: id(2200), kind: 'directory' })); assert.equal(invokes, 0)
  const request = { datasetId, commandId: id(2201), expectedPolicyRevision: '1', enabled: true }
  const faulty = createLocalRelocationClient({ scope: async () => datasetId, invoke: async () => ({ ...await f.dispatch('localRelocationPlan.setPolicy', request) as dto.LocalRelocationPlanReceipt, commandId: id(99) }) })
  await assert.rejects(() => faulty.localRelocationPlan('localRelocationPlan.setPolicy', request)); assert.equal(invokes, 0)
})

/** 这里核真实Main路由与封套绑定；Core HMAC、恢复家族认证与真实quiet另由Core集成验证。 */
function addRecovery(h: ReturnType<typeof harness>, number: number): dto.LocalRelocationPlanConfirm {
  const value = readyPlan(number), origin = h.f.plans.get(h.confirm.planId)!
  value.intent = { kind: 'recovery', originPlanId: origin.planId, expectedOriginViewRevision: origin.viewRevision, choiceId: id(number + 6), recoveryFingerprint: '9'.repeat(64) }
  value.planHash = '6'.repeat(64); value.contextFingerprint = '7'.repeat(64); value.closure.fingerprint = '8'.repeat(64)
  h.f.plans.set(value.planId, value)
  return { datasetId, commandId: id(number + 7), planId: value.planId, expectedViewRevision: value.viewRevision, domain: 'LOCAL_RELOCATION_V1', planHash: value.planHash, contextFingerprint: value.contextFingerprint }
}
test('013真实Main新恢复command单次challenge/execute，原UNKNOWN始终只GET且失联恢复不重播', async t => {
  const h = harness(t); h.f.unknown.add(h.confirm.commandId)
  const readPrivateCalls = (): ReturnType<typeof harness>['privateCalls'] => h.privateCalls
  await assert.rejects(() => h.call('localRelocationPlan.confirm', h.confirm)); assert.deepEqual(h.privateCalls, [])
  const recovery = addRecovery(h, 3000); h.loseAck()
  await assert.rejects(() => h.call('localRelocationPlan.confirm', recovery))
  assert.deepEqual(readPrivateCalls().map(call => call.command), ['localRelocationMain.challenge', 'localRelocationMain.executeGranted'])
  const challengeRequest = readPrivateCalls()[0]!.payload as dto.LocalRelocationMainCommandPayloads['localRelocationMain.challenge']
  assert.deepEqual(challengeRequest, { datasetId, confirm: recovery }); assert.notEqual(challengeRequest.confirm.commandId, h.confirm.commandId); assert.notEqual(challengeRequest.confirm.planId, h.confirm.planId)
  await assert.rejects(() => h.call('localRelocationPlan.confirm', recovery)); assert.equal(h.privateCalls.length, 2)
  const original = await h.query(h.confirm) as Extract<dto.LocalRelocationPlanGetResult, { kind: 'command' }>
  assert.equal(original.receipt, null); assert.equal(original.issue?.code, 'COMMAND_UNKNOWN'); assert.equal(original.requestFingerprint, fingerprint('localRelocationPlan.confirm', h.confirm))
  const restored = await h.query(recovery) as Extract<dto.LocalRelocationPlanGetResult, { kind: 'command' }>
  assert.equal(restored.receipt?.planId, recovery.planId); assert.equal(restored.receipt?.requestFingerprint, fingerprint('localRelocationPlan.confirm', recovery))
  h.loseAck(false); await h.call('localRelocationPlan.confirm', recovery); await assert.rejects(() => h.call('localRelocationPlan.confirm', h.confirm))
  assert.equal(h.privateCalls.length, 2); assert.equal(h.f.unknown.has(h.confirm.commandId), true)
})
test('013真实Main新恢复不能借旧原计划challenge和grant封套，错绑定失败后保新未知槽', async t => {
  const h = harness(t); let previous: dto.LocalRelocationMainChallenge | undefined
  h.changeChallenge(value => { previous = structuredClone(value); return value }); await h.call('localRelocationPlan.confirm', h.confirm)
  assert.ok(previous)
  const old = previous, recovery = addRecovery(h, 3100)
  h.changeChallenge(() => old)
  await assert.rejects(() => h.call('localRelocationPlan.confirm', recovery))
  assert.deepEqual(h.privateCalls.map(call => call.command), ['localRelocationMain.challenge', 'localRelocationMain.executeGranted', 'localRelocationMain.challenge'])
  await assert.rejects(() => h.call('localRelocationPlan.confirm', recovery)); assert.equal(h.privateCalls.length, 3)
  assert.equal(h.f.receipts.has(recovery.commandId), false); assert.equal(h.f.receipts.get(h.confirm.commandId)?.planId, h.confirm.planId)
})
test('013真实Main新恢复能力已过期则拒execute，不续签或增加重试', async t => {
  const h = harness(t), recovery = addRecovery(h, 3200)
  h.changeChallenge(value => ({ ...value, expiresAt: new Date(Date.now() - 1).toISOString() }))
  await assert.rejects(() => h.call('localRelocationPlan.confirm', recovery))
  assert.deepEqual(h.privateCalls.map(call => call.command), ['localRelocationMain.challenge'])
  await assert.rejects(() => h.call('localRelocationPlan.confirm', recovery)); assert.equal(h.privateCalls.length, 1); assert.equal(h.f.receipts.has(recovery.commandId), false)
})
