import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { markRaw } from 'vue'
import type * as dto from '@music-bridge/contracts'
import { useLocalRelocationPlans } from '../../src/renderer/src/composables/application/useLocalRelocationPlans.js'
import { button, click, mounted, named, submit } from './ui-host.js'
import { mountedRelocationSettings, relocationComposables } from './settings-ui-host.js'
import { datasetId, fixture, id, issue, selection } from './fixture.js'

const components = path.resolve(import.meta.dirname, '../../src/renderer/src/components'), dialogFile = path.join(components, 'library/LocalRelocationDialog.vue')
async function prepared(t: test.TestContext) {
  const f = fixture(); f.context.policy.enabled = true
  const session = markRaw(useLocalRelocationPlans({ api: f.api })); t.after(() => session.dispose())
  await session.open([selection], '013自有源', 'rename')
  const ui = await mounted(t, dialogFile, { session })
  await ui.input(named(ui, '搬迁新文件名'), 'Unicode-é-新名.wav')
  return { f, session, ui }
}

test('013真实SFC完整预览零confirm，具体按钮只受理，逐项闭集来自持久回读', async t => {
  const { f, session, ui } = await prepared(t)
  assert.match(ui.text(), /逐项处理音频和伴随文件/u)
  await submit(ui, '具体文件搬迁内容')
  assert.equal(f.calls.filter(value => value.command === 'localRelocationPlan.preview').length, 1); assert.equal(f.calls.filter(value => value.command === 'localRelocationPlan.confirm').length, 0)
  assert.equal(session.plan.value?.resources.length, 2); assert.match(ui.text(), /owned-original\.wav.*owned-original\.lrc/u); assert.match(ui.text(), /歌词/u)
  assert.doesNotMatch(ui.text(), /planHash|contextFingerprint|[a-f]{64}|grant|fd/u)
  const dispatch = f.api.localRelocationPlan; let contextUnavailable = true
  f.api.localRelocationPlan = (async (command: dto.LocalRelocationPlanCommand, payload: dto.LocalRelocationPlanCommandPayloads[dto.LocalRelocationPlanCommand]) => {
    if (command === 'localRelocationPlan.get' && (payload as dto.LocalRelocationPlanCommandPayloads['localRelocationPlan.get']).selector.kind === 'context' && contextUnavailable) throw new Error('受控设置读回失联')
    return dispatch(command, payload)
  }) as dto.LocalRelocationPlanPublicApi['localRelocationPlan']
  await click(ui, '重新读取搬迁结果'); assert.equal(session.contextFailed.value, true); assert.equal(session.canConfirm.value, false); assert.equal(session.canCleanup.value, false)
  assert.equal(f.calls.filter(value => value.command === 'localRelocationPlan.confirm').length, 0)
  contextUnavailable = false; await click(ui, '重新读取搬迁结果'); assert.equal(session.canConfirm.value, true)
  await click(ui, '确认这份搬迁计划')
  assert.equal(f.calls.filter(value => value.command === 'localRelocationPlan.confirm').length, 1); assert.match(ui.text(), /原命令已受理/u); assert.match(ui.text(), /正在处理文件/u); assert.doesNotMatch(ui.text(), /文件搬迁成功/u)
  f.complete(session.plan.value!.planId); await click(ui, '重新读取搬迁结果')
  assert.match(ui.text(), /目标已登记，源材料保留/u); assert.match(ui.text(), /目标已独立完整回读/u)
})
test('013目标VERIFIED但未REGISTERED不能清理，目标登记后具体按钮只清当前完整源集合', async t => {
  const { f, session, ui } = await prepared(t); await submit(ui, '具体文件搬迁内容'); await click(ui, '确认这份搬迁计划')
  const value = f.plans.get(session.plan.value!.planId)!; value.state = 'VERIFIED_TARGET'
  for (const resource of value.resources) { resource.state = 'verified'; resource.phase = 'VERIFIED_TARGET'; resource.verification = 'verified-target'; resource.sourceHandling = 'retained' }
  await click(ui, '重新读取搬迁结果'); assert.equal(session.canCleanup.value, false); assert.match(ui.text(), /目标尚未完整验证并登记，不能清理/u)
  assert.equal(f.calls.filter(value => value.command === 'localRelocationPlan.cleanup').length, 0)
  f.complete(value.planId); await click(ui, '重新读取搬迁结果'); assert.equal(session.canCleanup.value, true)
  const confirm = f.calls.find(value => value.command === 'localRelocationPlan.confirm')!.payload as dto.LocalRelocationPlanConfirm
  await click(ui, '清理这份已验证计划的源副本')
  const cleans = f.calls.filter(value => value.command === 'localRelocationPlan.cleanup'); assert.equal(cleans.length, 1)
  const cleanup = cleans[0]!.payload as dto.LocalRelocationPlanCleanup
  assert.notEqual(cleanup.commandId, confirm.commandId); assert.deepEqual(cleanup.sourceResourceIds, value.resources.map(resource => resource.resourceId)); assert.equal(cleanup.verifiedTargetFingerprint, 'f'.repeat(64))
  assert.match(ui.text(), /具体清理正在处理/u)
})
test('013真实SFC未知confirm保原command/fingerprint，NOT_FOUND与冷返回只读不重播', async t => {
  const { f, session, ui } = await prepared(t); await submit(ui, '具体文件搬迁内容')
  const dispatch = f.api.localRelocationPlan
  f.api.localRelocationPlan = (async (command: dto.LocalRelocationPlanCommand, payload: dto.LocalRelocationPlanCommandPayloads[dto.LocalRelocationPlanCommand]) => {
    if (command === 'localRelocationPlan.confirm') { f.calls.push({ command, payload: structuredClone(payload) }); f.unknown.add((payload as dto.LocalRelocationPlanConfirm).commandId); throw new Error('受控原命令结果未知') }
    return dispatch(command, payload)
  }) as dto.LocalRelocationPlanPublicApi['localRelocationPlan']
  await click(ui, '确认这份搬迁计划'); const original = session.pending.value[0]!
  assert.equal(session.unknown.value, true); assert.equal(button(ui, '确认这份搬迁计划')?.props.disabled, true); assert.match(ui.text(), /不会自动重签、重放/u)
  await click(ui, '重新读取搬迁结果'); assert.equal(session.pending.value[0], original)
  f.unknown.delete(original.request.commandId); await click(ui, '重新读取搬迁结果'); assert.equal(session.pending.value[0], original); assert.match(ui.text(), /尚未找到原命令记录/u)
  session.close(); await session.openHistory(); await session.reconcile()
  const queries = f.calls.filter(value => value.command === 'localRelocationPlan.get').map(value => value.payload as dto.LocalRelocationPlanCommandPayloads['localRelocationPlan.get']).filter(value => value.selector.kind === 'command')
  assert.ok(queries.length >= 3); for (const query of queries) { assert.equal(query.selector.kind, 'command'); if (query.selector.kind === 'command') { assert.equal(query.selector.commandId, original.request.commandId); assert.equal(query.selector.requestFingerprint, original.fingerprint) } }
  assert.equal(f.calls.filter(value => value.command === 'localRelocationPlan.confirm').length, 1)
})
test('013活动lease延期和未知伴随引用完整显示，不强停、不截取部分确认', async t => {
  const { f, session, ui } = await prepared(t); await submit(ui, '具体文件搬迁内容')
  const value = f.plans.get(session.plan.value!.planId)!
  value.state = 'DEFERRED'; value.issues = [issue('LEASE_ACTIVE')]; value.items[0]!.state = 'deferred'; value.resources[0]!.state = 'deferred'; value.resources[0]!.issue = issue('LEASE_ACTIVE')
  await click(ui, '重新读取搬迁结果'); assert.match(ui.text(), /暂停读取或预取.*不会停止播放/u); assert.equal(session.canConfirm.value, false)
  value.state = 'BLOCKED'; value.closure.complete = false; value.resources[1]!.role = 'UNKNOWN_REFERENCE'; value.resources[1]!.bytes = null; value.resources[1]!.issue = issue('UNKNOWN_REFERENCE'); value.issues = [issue('UNKNOWN_REFERENCE')]
  await click(ui, '重新读取搬迁结果'); assert.match(ui.text(), /资源闭集未完整/u); assert.equal(ui.all().filter(element => element.props['data-relocation-resource-id']).length, 2); assert.equal(session.canConfirm.value, false)
  assert.equal(f.calls.filter(value => ['localRelocationPlan.confirm', 'localRelocationPlan.cleanup'].includes(value.command)).length, 0)
})
test('013目录重关联真实SFC只使用Main不透明choice，旧找回流程不被替换', async t => {
  const f = fixture(); f.context.policy.enabled = true
  const session = markRaw(useLocalRelocationPlans({ api: f.api })); t.after(() => session.dispose())
  await session.openRoot({ libraryRootId: id(800), expectedRootRevision: '1' }, '自有逻辑根')
  const ui = await mounted(t, dialogFile, { session }); await click(ui, '选择重关联目标目录'); await submit(ui, '具体文件搬迁内容')
  const preview = f.calls.find(value => value.command === 'localRelocationPlan.preview')!.payload as dto.LocalRelocationPlanCommandPayloads['localRelocationPlan.preview']
  assert.deepEqual(preview.intent, { kind: 'root-reassociate', libraryRootId: id(800), expectedRootRevision: '1', targetChoiceId: id(500), sourceDisposition: 'RETAIN' })
  const privateFields = new Set(['absolutePath', 'fd', 'grant', 'actor'])
  function containsPrivateField(value: unknown): boolean {
    if (Array.isArray(value)) return value.some(containsPrivateField)
    if (value === null || typeof value !== 'object') return false
    return Object.entries(value as Record<string, unknown>).some(([key, nested]) => /absolutePath|fd|grant|actor/u.test(key) || containsPrivateField(nested))
  }
  assert.equal(containsPrivateField(preview), false); assert.equal(f.calls.filter(value => value.command === 'localRelocationPlan.confirm').length, 0)
  // UUID中的fd是合法值；私有字段名在任意层级都必须检出。
  const validCommandId = '9b36dc61-a846-4608-85fd-145285f76eb7'
  assert.equal(containsPrivateField({ ...preview, commandId: validCommandId }), false)
  for (const field of privateFields) {
    assert.equal(containsPrivateField({ [field]: null }), true)
    assert.equal(containsPrivateField({ plan: { resources: [{ [field]: null }] } }), true)
  }
})
test('013 Esc/关闭与Tab真实焦点边界不产生文件动作', async t => {
  const { f, session, ui } = await prepared(t); await submit(ui, '具体文件搬迁内容')
  const originalPlanId = session.plan.value!.planId
  const currentPlan = (): dto.LocalRelocationPlan | null => session.plan.value
  await click(ui, '搬迁历史'); assert.equal(session.view.value, 'history'); assert.equal(session.plan.value, null)
  assert.equal(session.canConfirm.value, false); assert.equal(session.canCleanup.value, false); assert.equal(session.canCancel.value, false)
  assert.equal(button(ui, '确认这份搬迁计划'), undefined); assert.equal(f.calls.filter(value => value.command === 'localRelocationPlan.confirm').length, 0)
  assert.ok(named(ui, `查看搬迁计划 ${originalPlanId}`)); await click(ui, '查看计划')
  assert.equal(currentPlan()?.planId, originalPlanId); assert.equal(session.view.value, 'plan'); assert.equal(session.canConfirm.value, true)
  assert.equal(ui.all().filter(element => element.props['data-relocation-resource-id']).length, 2)
  const dialog = ui.all().find(element => element.type === 'dialog')!; assert.equal(dialog.modalCount, 1)
  button(ui, '确认这份搬迁计划')!.focus(); const event = ui.event(dialog, 'Tab'); dialog.props.onKeydown(event)
  assert.equal(event.prevented, true); assert.equal(ui.text(ui.active()!), '关闭')
  dialog.props.onCancel(ui.event(dialog)); await ui.settle(); assert.equal(session.isOpen.value, false); assert.equal(session.canConfirm.value, false); assert.equal(f.calls.filter(value => ['localRelocationPlan.confirm', 'localRelocationPlan.cleanup'].includes(value.command)).length, 0)
})
test('013原指纹计算迟到且关闭，真实SFC提交不会派发plan或确认', async t => {
  const { f, session, ui } = await prepared(t)
  const form = ui.all().find(element => element.type === 'form' && element.props['aria-label'] === '具体文件搬迁内容')!
  const submitted = Promise.resolve(form.props.onSubmit(ui.event(form))); session.close(); await submitted; await ui.settle()
  assert.equal(f.calls.filter(value => value.command === 'localRelocationPlan.preview').length, 0); assert.equal(f.calls.filter(value => value.command === 'localRelocationPlan.confirm').length, 0)
})
test('013设置真实SFC默认OFF及CAS开启，未知回执不乐观翻转或重发', async t => {
  assert.equal(relocationComposables.useLocalRelocationPlans, useLocalRelocationPlans)
  const f = fixture(), api = { ...f.api, listLocalLibraryRoots: async () => [], localLibraryScan: async () => ({ items: [], hasMore: false }) }
  const ui = await mountedRelocationSettings(t, path.join(components, 'settings/LocalLibrarySettings.vue'), { managementOnly: true }, api), toggle = named(ui, '允许具体文件搬迁')!
  assert.equal(toggle.props.checked, false); assert.equal(toggle.props.disabled, false)
  toggle.checked = true; await toggle.props.onChange(ui.event(toggle)); await ui.settle()
  assert.equal(toggle.props.checked, true); assert.equal(f.calls.filter(value => value.command === 'localRelocationPlan.setPolicy').length, 1); assert.equal(f.calls.filter(value => value.command === 'localRelocationPlan.confirm').length, 0)
  const dispatch = api.localRelocationPlan
  api.localRelocationPlan = async <C extends dto.LocalRelocationPlanCommand>(command: C, payload: dto.LocalRelocationPlanCommandPayloads[C]) => {
    if (command === 'localRelocationPlan.setPolicy') { f.calls.push({ command, payload: structuredClone(payload) }); f.unknown.add((payload as dto.LocalRelocationPlanCommandPayloads['localRelocationPlan.setPolicy']).commandId); throw new Error('合成未知') }
    return dispatch(command, payload)
  }
  toggle.checked = false; await toggle.props.onChange(ui.event(toggle)); await ui.settle()
  assert.equal(toggle.props.checked, true); assert.equal(toggle.props.disabled, true); assert.match(ui.text(), /结果未知/u)
  await click(ui, '重新读取搬迁设置与原命令'); assert.equal(f.calls.filter(value => value.command === 'localRelocationPlan.setPolicy').length, 2)
})
test('013切工作库保留旧未知绑定，不能把新scope读回用来清理或重发旧命令', async t => {
  const { f, session, ui } = await prepared(t); await submit(ui, '具体文件搬迁内容')
  f.api.localRelocationPlan = (async (command: dto.LocalRelocationPlanCommand, payload: dto.LocalRelocationPlanCommandPayloads[dto.LocalRelocationPlanCommand]) => { if (command === 'localRelocationPlan.confirm') throw new Error('合成未知'); return f.dispatch(command, payload) }) as dto.LocalRelocationPlanPublicApi['localRelocationPlan']
  await click(ui, '确认这份搬迁计划'); assert.equal(session.pending.value.length, 1)
  f.api.getCommandOutbox = async () => ({ datasetId: id(900), entries: [] }); await click(ui, '重新读取搬迁结果')
  assert.equal(session.datasetChanged.value, true); assert.equal(session.pending.value.length, 1); assert.equal(session.canCleanup.value, false); assert.equal(session.canConfirm.value, false)
  assert.equal(session.pending.value[0]!.request.datasetId, datasetId)
})
