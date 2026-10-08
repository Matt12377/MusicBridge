import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { markRaw } from 'vue'
import type { CommandOutboxPublicApi, CommandOutboxView } from '@music-bridge/contracts'
import { mounted } from './mbrs014/ui-host.js'
import { mountedSourceWritesSettings, sourceWritesComposables } from './mbrs012-ui-host.js'
import { createCommandOutboxController } from '../src/renderer/src/components/command-outbox/controller.js'
import { useLocalSourceWrites } from '../src/renderer/src/composables/application/useLocalSourceWrites.js'
import { fixture, target } from './mbrs012-fixture.js'
const root = path.resolve(import.meta.dirname, '../src/renderer/src/components')
type Ui = Awaited<ReturnType<typeof mounted>>
const button = (ui: Ui, name: string) => ui.all().find(el => el.type === 'button' && ui.text(el) === name)
const named = (ui: Ui, name: string) => ui.all().find(el => el.props['aria-label'] === name)
/** 旧宿主只刷新渲染；源写须等真实事件处理（含WebCrypto指纹及计划回读）结束再观察。 */
async function clickSourceAction(ui: Ui, name: string): Promise<void> {
  const element = button(ui, name)
  assert.ok(element, '缺少源写点击目标'); assert.ok(!element.props.disabled, '不能点击禁用源写入口')
  const handlers = Array.isArray(element.props.onClick) ? element.props.onClick : [element.props.onClick]
  assert.ok(handlers.length && handlers.every(handler => typeof handler === 'function'), '源写事件处理器缺失')
  element.focus(); const event = ui.event(element)
  await Promise.all(handlers.map(handler => handler(event)))
  await ui.settle()
}

test('012源Outbox即使声称可重试也不重发，隐藏confirm/undo回执不冒充文件成功', async t => {
  for (const command of ['localSourceWrites.confirm', 'localSourceWrites.undo', 'localSourceWrites.setPolicy'] as const) {
    const f = fixture(), calls: string[] = []
    const entry: CommandOutboxView = { id: '11111111-1111-4111-8111-111111111111', commandId: '22222222-2222-4222-8222-222222222222', command, datasetId: f.context.datasetId, state: 'succeeded', createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z', acknowledged: false, canRetry: true, sourceRequestFingerprint: 'a'.repeat(64) }
    let hidden = false
    const api: CommandOutboxPublicApi = {
      async getCommandOutbox() { calls.push('get'); return { datasetId: entry.datasetId, entries: hidden ? [] : [entry] } },
      async retryCommandOutbox() { calls.push('retry'); return entry },
      async dismissCommandOutbox() { calls.push('dismiss'); return entry },
      async acknowledgeCommandOutbox() { calls.push('ack'); hidden = true; return { ...entry, acknowledged: true } },
    }
    const controller = createCommandOutboxController({ api, schedule: () => 1, cancel: () => {} }); t.after(() => controller.dispose())
    await controller.start(); await controller.act('retry', entry.id, true); await controller.act('ack', entry.id)
    assert.deepEqual(calls, ['get', 'ack', 'get']); assert.deepEqual(controller.state.overview?.entries, [])
    if (command !== 'localSourceWrites.setPolicy') {
      assert.match(controller.state.notice ?? '', /回执.*具体计划/u); assert.doesNotMatch(controller.state.notice ?? '', /成功|写回完成/u)
    } else assert.match(controller.state.notice ?? '', /成功结果已确认/u)
  }
})

test('012真实具体dialog预览零confirm，最终按钮只显示受理与实际逐项状态', async t => {
  const f = fixture(); f.policy.enabled = true; const session = markRaw(useLocalSourceWrites({ api: f.api })); t.after(() => session.dispose()); await session.open(target, '精确自制曲目')
  const ui = await mounted(t, path.join(root, 'library/LocalSourceWritesDialog.vue'), { session })
  assert.match(ui.text(), /非原子保全发布/u); assert.match(ui.text(), /保持不会改动/u)
  await ui.change(named(ui, '标题源标签操作'), 'set'); await ui.input(named(ui, '标题源标签值'), '新标题')
  assert.equal(session.fields.title.action, 'set'); assert.equal(session.fields.title.value, '新标题'); assert.equal(session.canPreview.value, true)
  const submit = ui.all().find(element => element.type === 'form' && element.props['aria-label'] === '具体源文件写入内容')!, previewButton = button(ui, '预览具体源写计划')!
  assert.ok(submit); assert.equal(previewButton.props.type, 'submit'); assert.equal(f.previews.length, 0); assert.equal(f.confirms.length, 0)
  await ui.click(previewButton); assert.equal(f.previews.length, 0); assert.equal(f.confirms.length, 0)
  // 只读旧宿主没有HTML按钮默认提交动作；明确派发真实表单的submit事件并等待处理完成。
  await submit.props.onSubmit(ui.event(submit)); await ui.settle(); assert.equal(f.previews.length, 1); assert.equal(f.previews[0]!.intent.kind, 'tags')
  if (f.previews[0]!.intent.kind === 'tags') assert.deepEqual(f.previews[0]!.intent.fields, { title: { action: 'set', value: '新标题' } })
  assert.equal(f.confirms.length, 0); assert.match(ui.text(), /原始标题.*新标题/u); assert.doesNotMatch(ui.text(), /planHash|contextFingerprint|[ab]{64}/u)
  await clickSourceAction(ui, '确认这份源写计划'); assert.equal(f.confirms.length, 1); assert.match(ui.text(), /已受理|正在处理文件/u); assert.doesNotMatch(ui.text(), /文件写回成功/u)
  f.complete(session.plan.value!.planId); await clickSourceAction(ui, '重新读取源写结果'); assert.match(ui.text(), /逐项核验完成/u); assert.match(ui.text(), /独立回读已核验/u)
})
test('012dialog缺原图明确重选，MB_ONLY只走原入口，Esc关闭不提交', async t => {
  const f = fixture(); f.context.materials[0] = { ...f.context.materials[0]!, availability: 'reacquire-required', contentRef: null, originalSha256: null }
  const session = markRaw(useLocalSourceWrites({ api: f.api })); t.after(() => session.dispose()); await session.open(target)
  let mbOnly = 0, reacquire = 0
  const ui = await mounted(t, path.join(root, 'library/LocalSourceWritesDialog.vue'), { session, onMbOnly: () => { mbOnly++ }, onReacquire: () => { reacquire++ } })
  await ui.change(named(ui, '保存范围'), 'EMBEDDED_COVER'); assert.match(ui.text(), /展示图不能代替原图/u); await ui.click(button(ui, '重新选择并保存 MB 封面')); assert.equal(reacquire, 1); assert.equal(f.previews.length, 0)
  await ui.change(named(ui, '保存范围'), 'MB_ONLY'); assert.equal(mbOnly, 1); assert.equal(f.confirms.length, 0); assert.equal(session.isOpen.value, false)
})
test('012设置真实七API读取OFF并CAS开启，未知不能乐观翻转或重发', async t => {
  const file = path.join(root, 'settings/LocalSourceWritesSettings.vue')
  assert.equal(sourceWritesComposables.useLocalSourceWrites, useLocalSourceWrites)
  const f = fixture(), ui = await mountedSourceWritesSettings(t, file, {}, f.api)
  const toggle = named(ui, '允许具体源文件写入')!; assert.equal(toggle.props.checked, false)
  toggle.checked = true; await toggle.props.onChange(ui.event(toggle)); await ui.settle(); assert.equal(f.policies.length, 1); assert.equal(toggle.props.checked, true); assert.equal(f.confirms.length, 0)
  f.api.setLocalSourceWritesPolicy = async request => { f.policies.push(request); throw new Error('合成未知') }; toggle.checked = false; await toggle.props.onChange(ui.event(toggle)); await ui.settle()
  assert.equal(toggle.props.checked, true); assert.equal(toggle.props.disabled, true); assert.match(ui.text(), /结果未知/u); await ui.click(button(ui, '重新读取源写设置')); assert.equal(f.policies.length, 2)
})
test('012预览撤销按钮后仍需最终confirm；关闭/Tab边界有实际焦点', async t => {
  const f = fixture(); f.policy.enabled = true; const session = markRaw(useLocalSourceWrites({ api: f.api })); t.after(() => session.dispose()); await session.open(target); session.setAction('title', 'set'); session.setValue('title', '新值'); await session.preview(); f.complete(session.plan.value!.planId); await session.reconcile()
  const ui = await mounted(t, path.join(root, 'library/LocalSourceWritesDialog.vue'), { session }), dialog = ui.all().find(el => el.type === 'dialog')!
  assert.equal(dialog.modalCount, 1); await clickSourceAction(ui, '预览源写撤销'); assert.equal(f.undos.length, 1); assert.equal(f.confirms.length, 0); assert.match(ui.text(), /再次确认/u)
  const last = button(ui, '确认这份源写计划')!; last.focus(); const event = ui.event(dialog, 'Tab'); dialog.props.onKeydown(event); assert.equal(event.prevented, true); assert.equal(ui.text(ui.active()!), '关闭')
  dialog.props.onCancel(ui.event(dialog)); await ui.settle(); assert.equal(session.isOpen.value, false); assert.equal(f.confirms.length, 0)
})
for (const range of ['TAGS', 'EMBEDDED_COVER', 'DIRECTORY_COVER'] as const) {
  test(`012 ${range} 逆向dialog展示核验备份或原无封面，原艺人多值逐项保留且不借candidate身份`, async t => {
    const f = fixture(); f.policy.enabled = true; const session = markRaw(useLocalSourceWrites({ api: f.api })); t.after(() => session.dispose()); await session.open(target, '精确反向材料', range)
    if (range === 'TAGS') { session.setAction('artist', 'set'); session.setValue('artist', '当前艺人') } else if (range === 'DIRECTORY_COVER') session.setFileName('cover.png')
    await session.preview(); f.complete(session.plan.value!.planId); await session.reconcile()
    const ui = await mounted(t, path.join(root, 'library/LocalSourceWritesDialog.vue'), { session }); await clickSourceAction(ui, '预览源写撤销')
    assert.equal(session.plan.value?.items[0]?.artwork, null); assert.equal(f.confirms.length, 0)
    if (range === 'DIRECTORY_COVER') { assert.match(ui.text(), /恢复原无目录封面状态/u); assert.equal(session.plan.value?.items[0]?.restoration?.material, 'verified-absence') }
    else assert.match(ui.text(), /从已核验备份恢复原音频文件/u)
    if (range === 'TAGS') {
      assert.deepEqual(session.plan.value?.items[0]?.changes[0]?.after, ['原艺人甲', '原艺人乙'])
      assert.ok(ui.all().some(element => element.type === 'li' && ui.text(element) === '原艺人甲')); assert.ok(ui.all().some(element => element.type === 'li' && ui.text(element) === '原艺人乙')); assert.doesNotMatch(ui.text(), /原艺人甲；原艺人乙/u)
    }
    await clickSourceAction(ui, '确认这份源写计划'); assert.equal(f.confirms.length, 1)
  })
}
