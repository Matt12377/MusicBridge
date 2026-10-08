import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { markRaw } from 'vue'
import type * as dto from '@music-bridge/contracts'
import { useLocalRelocationPlans } from '../../src/renderer/src/composables/application/useLocalRelocationPlans.js'
import { button, click, mounted, named, submit } from './ui-host.js'
import { datasetId, fixture, fingerprint, id, issue, readyPlan, selection } from './fixture.js'

const dialogFile = path.resolve(import.meta.dirname, '../../src/renderer/src/components/library/LocalRelocationDialog.vue')

/** 受控Core回执/状态仅测试真实SFC接线；不冒充生产恢复、OS资格、grant认证或材料quiet。 */
async function protectedFamily(t: test.TestContext) {
  const f = fixture(); f.context.policy.enabled = true
  const session = markRaw(useLocalRelocationPlans({ api: f.api })); t.after(() => session.dispose())
  await session.open([selection], '013自有恢复材料', 'rename')
  const ui = await mounted(t, dialogFile, { session })
  await ui.input(named(ui, '搬迁新文件名'), 'original-intent.wav'); await submit(ui, '具体文件搬迁内容')
  const origin = f.plans.get(session.plan.value!.planId)!
  const choice: dto.LocalRelocationPlanRecoveryChoice = { choiceId: id(600), originPlanId: origin.planId, expectedOriginViewRevision: '2', recoveryFingerprint: '9'.repeat(64), action: 'keep-target', label: '核对完整目标并继续登记', resourceIds: origin.resources.map(resource => resource.resourceId) }
  let contextUnavailable = false, nextExpires = false
  const dispatch = f.api.localRelocationPlan
  f.api.localRelocationPlan = async <C extends dto.LocalRelocationPlanCommand>(command: C, payload: dto.LocalRelocationPlanCommandPayloads[C]): Promise<dto.LocalRelocationPlanCommandResults[C]> => {
    if (command === 'localRelocationPlan.get') {
      const request = payload as dto.LocalRelocationPlanCommandPayloads['localRelocationPlan.get']
      if (request.selector.kind === 'context' && contextUnavailable) throw new Error('受控当前context读回失联')
    }
    if (command === 'localRelocationPlan.confirm') {
      const request = payload as dto.LocalRelocationPlanConfirm
      if (request.planId === origin.planId) {
        f.calls.push({ command, payload: structuredClone(payload) }); f.unknown.add(request.commandId)
        origin.state = 'RECOVERY_REQUIRED'; origin.viewRevision = '2'; origin.journalSequence = '2'; origin.issues = [issue('RECOVERY_REQUIRED')]; origin.recoveryChoices = [choice]
        throw new Error('受控原confirm结果未知，认证家族仍有明确恢复选择')
      }
    }
    if (command === 'localRelocationPlan.preview') {
      const request = payload as dto.LocalRelocationPlanCommandPayloads['localRelocationPlan.preview']
      if (request.intent.kind === 'recovery') {
        assert.deepEqual(structuredClone(request.intent), { kind: 'recovery', originPlanId: origin.planId, expectedOriginViewRevision: origin.viewRevision, choiceId: choice.choiceId, recoveryFingerprint: choice.recoveryFingerprint })
        const value = readyPlan(700); value.intent = request.intent; value.planHash = '6'.repeat(64); value.contextFingerprint = '7'.repeat(64); value.closure.fingerprint = '8'.repeat(64)
        if (nextExpires) { value.createdAt = new Date(Date.now() - 60000).toISOString(); value.expiresAt = new Date(Date.now() - 1).toISOString() }
        f.calls.push({ command, payload: structuredClone(payload) }); f.plans.set(value.planId, value)
        return f.receipt('localRelocationPlan.preview', request, value) as dto.LocalRelocationPlanCommandResults[C]
      }
    }
    return dispatch(command, payload)
  }
  await click(ui, '确认这份搬迁计划'); const original = session.pending.value[0]!
  await click(ui, '重新读取搬迁结果')
  return { f, session, ui, origin, choice, original, unavailable: (value = true) => { contextUnavailable = value }, expireNext: () => { nextExpires = true } }
}
const recoverButton = (choice: dto.LocalRelocationPlanRecoveryChoice): string => `预览恢复：${choice.label}`
async function selectPlan(ui: Awaited<ReturnType<typeof mounted>>, planId: string): Promise<void> {
  const target = named(ui, `查看搬迁计划 ${planId}`)
  assert.ok(target); assert.equal(!!target.props.disabled, false)
  await target.props.onClick(ui.event(target)); await ui.settle()
}

test('013默认OFF真实SFC显示拒绝receipt且不创建BLOCKED计划或确认入口', async t => {
  const f = fixture(), session = markRaw(useLocalRelocationPlans({ api: f.api })); t.after(() => session.dispose())
  await session.open([selection], '013自有OFF材料', 'rename')
  const ui = await mounted(t, dialogFile, { session }); await ui.input(named(ui, '搬迁新文件名'), 'disabled.wav'); await submit(ui, '具体文件搬迁内容')
  assert.equal(f.plans.size, 0); assert.equal(session.plan.value, null); assert.equal(session.unknown.value, false); assert.equal(session.canConfirm.value, false)
  assert.equal(button(ui, '确认这份搬迁计划'), undefined); assert.match(ui.text(), /文件搬迁开关已关闭；可继续读取计划与历史/u)
  const previews = f.calls.filter(call => call.command === 'localRelocationPlan.preview'); assert.equal(previews.length, 1)
  const request = previews[0]!.payload as dto.LocalRelocationPlanCommandPayloads['localRelocationPlan.preview'], receipt = f.receipts.get(request.commandId)!
  assert.equal(receipt.outcome, 'rejected'); assert.equal(receipt.issue?.code, 'POLICY_DISABLED'); assert.equal(receipt.planId, null); assert.equal(receipt.jobId, null); assert.equal(receipt.requestFingerprint, fingerprint('localRelocationPlan.preview', request))
  await click(ui, '搬迁历史'); assert.equal(session.history.value.length, 0); assert.equal(f.calls.filter(call => call.command === 'localRelocationPlan.confirm').length, 0)
})
test('013真实SFC仅精确家族可新恢复预览和具体确认，原unknown绑定保留且受理不冒完成', async t => {
  const h = await protectedFamily(t), { f, session, ui, choice, original, origin } = h
  assert.equal(session.unknown.value, true); assert.equal(session.canConfirm.value, false); assert.equal(button(ui, recoverButton(choice))?.props.disabled, false)
  const savedFingerprint = original.fingerprint, savedRequest = structuredClone(original.request)
  await click(ui, recoverButton(choice))
  assert.equal(session.pending.value[0], original); assert.equal(session.unknown.value, true); assert.equal(session.canConfirm.value, true); assert.equal(session.canCleanup.value, false); assert.equal(session.canCancel.value, false)
  const recoveries = f.calls.filter(call => call.command === 'localRelocationPlan.preview' && (call.payload as dto.LocalRelocationPlanCommandPayloads['localRelocationPlan.preview']).intent.kind === 'recovery')
  assert.equal(recoveries.length, 1)
  const recoveryRequest = recoveries[0]!.payload as dto.LocalRelocationPlanCommandPayloads['localRelocationPlan.preview']
  assert.notEqual(recoveryRequest.commandId, original.request.commandId); assert.notEqual(session.plan.value!.planId, origin.planId); assert.notEqual(session.plan.value!.planHash, origin.planHash); assert.notEqual(session.plan.value!.contextFingerprint, origin.contextFingerprint)
  assert.match(ui.text(), /新的具体恢复预览/u); assert.match(ui.text(), /保留目标并继续核验登记/u); assert.match(ui.text(), /原未知命令继续保留并只读核对/u)
  assert.equal(ui.all().filter(element => element.props['data-relocation-resource-id']).length, 2)
  assert.doesNotMatch(ui.text(), /grant|nonce|[a-f0-9]{64}/u); assert.doesNotMatch(ui.text(), /恢复已完成|文件搬迁成功/u)
  await click(ui, '确认这份搬迁计划')
  const confirms = f.calls.filter(call => call.command === 'localRelocationPlan.confirm'); assert.equal(confirms.length, 2)
  const fresh = confirms[1]!.payload as dto.LocalRelocationPlanConfirm
  assert.notEqual(fresh.commandId, original.request.commandId); assert.equal(fresh.planId, session.plan.value!.planId); assert.notEqual(fresh.planId, origin.planId)
  assert.equal(session.pending.value[0], original); assert.equal(session.pending.value.length, 1); assert.equal(original.fingerprint, savedFingerprint); assert.deepEqual(structuredClone(original.request), savedRequest)
  assert.match(ui.text(), /原命令已受理/u); assert.match(ui.text(), /正在处理文件/u); assert.equal(session.canCleanup.value, false)
  f.complete(fresh.planId); await click(ui, '重新读取搬迁结果'); assert.equal(session.plan.value?.cleanup.state, 'eligible'); assert.equal(session.canCleanup.value, false)
  session.close(); await session.open([selection], '普通新改名', 'rename'); await ui.settle(); await ui.input(named(ui, '搬迁新文件名'), 'must-remain-blocked.wav')
  assert.equal(session.canPreview.value, false); assert.equal(session.pending.value[0], original); assert.equal(f.calls.filter(call => call.command === 'localRelocationPlan.confirm').length, 2)
})
test('013真实SFC恢复choice变修订或完整指纹时fresh原计划读回拒绝旧事件，不创建新计划', async t => {
  const { f, session, ui, origin, choice, original } = await protectedFamily(t)
  assert.equal(button(ui, recoverButton(choice))?.props.disabled, false)
  origin.viewRevision = '3'; choice.expectedOriginViewRevision = '3'; choice.recoveryFingerprint = '5'.repeat(64)
  await click(ui, recoverButton(choice))
  assert.match(ui.text(), /原恢复选择或修订已改变/u); assert.equal(session.pending.value[0], original)
  assert.equal(f.calls.filter(call => call.command === 'localRelocationPlan.preview').length, 1); assert.equal(f.calls.filter(call => call.command === 'localRelocationPlan.confirm').length, 1)
  assert.equal(session.plan.value?.planId, origin.planId); assert.equal(session.plan.value?.viewRevision, '3')
})
test('013真实SFCforeign或不完整choice及无关unknown家族全部阻断，context失联也不借旧资格放行', async t => {
  const { f, session, ui, origin, choice, original, unavailable } = await protectedFamily(t)
  choice.originPlanId = id(900); await click(ui, '重新读取搬迁结果'); assert.equal(button(ui, recoverButton(choice))?.props.disabled, true)
  choice.originPlanId = origin.planId; choice.resourceIds = [origin.resources[0]!.resourceId]; await click(ui, '重新读取搬迁结果'); assert.equal(button(ui, recoverButton(choice))?.props.disabled, true)
  choice.resourceIds = origin.resources.map(resource => resource.resourceId)
  const foreign = readyPlan(800); foreign.state = 'RECOVERY_REQUIRED'; foreign.issues = [issue('RECOVERY_REQUIRED')]
  foreign.recoveryChoices = [{ ...choice, choiceId: id(901), originPlanId: foreign.planId, expectedOriginViewRevision: foreign.viewRevision, resourceIds: foreign.resources.map(resource => resource.resourceId) }]; f.plans.set(foreign.planId, foreign)
  await click(ui, '搬迁历史'); await selectPlan(ui, foreign.planId)
  assert.equal(button(ui, recoverButton(foreign.recoveryChoices[0]!))?.props.disabled, true); assert.equal(session.pending.value[0], original)
  await click(ui, '搬迁历史'); await selectPlan(ui, origin.planId); assert.equal(button(ui, recoverButton(choice))?.props.disabled, false)
  unavailable(); await click(ui, '重新读取搬迁结果')
  assert.equal(session.contextFailed.value, true); assert.equal(session.qualified.value, true); assert.equal(button(ui, recoverButton(choice))?.props.disabled, true)
  assert.equal(session.canConfirm.value, false); assert.equal(session.canCancel.value, false); assert.equal(session.canCleanup.value, false); assert.equal(session.canPreview.value, false)
  assert.equal(f.calls.filter(call => call.command === 'localRelocationPlan.preview').length, 1); assert.equal(f.calls.filter(call => call.command === 'localRelocationPlan.confirm').length, 1)
})
test('013真实SFC新的恢复READY已经过期时保原unknown且不派发新confirm', async t => {
  const { f, session, ui, choice, original, expireNext } = await protectedFamily(t)
  expireNext(); await click(ui, recoverButton(choice))
  assert.equal(session.plan.value?.state, 'READY'); assert.equal(session.planExpired.value, true); assert.equal(session.canConfirm.value, false)
  assert.equal(button(ui, '确认这份搬迁计划')?.props.disabled, true); assert.match(ui.text(), /此具体预览已过期/u); assert.equal(session.pending.value[0], original)
  assert.equal(f.calls.filter(call => call.command === 'localRelocationPlan.confirm').length, 1)
})
test('013真实SFC新恢复确认前重新核原choice，stale不提交并保完整原绑定', async t => {
  const { f, session, ui, origin, choice, original } = await protectedFamily(t)
  await click(ui, recoverButton(choice)); assert.equal(session.canConfirm.value, true)
  origin.viewRevision = '3'; choice.expectedOriginViewRevision = '3'; choice.recoveryFingerprint = '4'.repeat(64)
  await click(ui, '确认这份搬迁计划')
  assert.equal(session.canConfirm.value, false); assert.match(ui.text(), /原恢复选择或修订已改变/u); assert.equal(session.pending.value[0], original)
  assert.equal(f.calls.filter(call => call.command === 'localRelocationPlan.confirm').length, 1); assert.equal(f.calls.filter(call => call.command === 'localRelocationPlan.cleanup').length, 0)
  assert.equal(original.request.datasetId, datasetId); assert.equal(original.fingerprint, fingerprint(original.command, original.request))
})
