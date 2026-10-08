import assert from 'node:assert/strict'
import test from 'node:test'
import { reactive } from 'vue'
import * as dto from '@music-bridge/contracts'
import { useLocalSourceWrites } from '../src/renderer/src/composables/application/useLocalSourceWrites.js'
import { sourceWriteFingerprint } from '../src/main/local-source-writes-ipc.js'
import { datasetId, deferred, editionId, fixture, id, readyPlan, target, trackId } from './mbrs012-fixture.js'
const settle = async () => { for (let index = 0; index < 4; index++) await new Promise<void>(resolve => setImmediate(resolve)) }
function session(t: test.TestContext, f = fixture()) { const value = useLocalSourceWrites({ api: f.api }); t.after(() => value.dispose()); return { value, f } }
async function preview(t: test.TestContext) { const result = session(t); result.f.policy.enabled = true; await result.value.open(target, '精确单曲'); result.value.setAction('title', 'set'); result.value.setValue('title', '新标题'); await result.value.preview(); return result }

test('012读取默认OFF不等于读取失败，开启仅保存策略且不确认任何文件', async t => {
  const { value, f } = session(t); await value.open(target); assert.equal(value.context.value?.policy.enabled, false); assert.equal(value.contextFailed.value, false)
  await value.setPolicy(true); assert.equal(f.policies.length, 1); assert.equal(f.confirms.length, 0); assert.equal(value.context.value?.policy.enabled, true)
  f.api.getLocalSourceWrites = async () => { throw new Error('合成读取失败') }; await value.readContext(); assert.equal(value.contextFailed.value, true); assert.match(value.error.value, /读取失败/u); assert.equal(value.context.value?.policy.enabled, true)
})
test('012单曲、明确发行与批量只带精确身份；保持、非空设值和移除不混用，空设值不发送', async t => {
  const { value, f } = session(t); f.policy.enabled = true
  const selections: dto.LocalSourceWritesTarget[] = [target, { mode: 'edition', editionId }, { mode: 'batch', trackIds: [trackId, id(4)] }]
  for (const selection of selections) {
    await value.open(reactive(selection)); value.setAction('title', 'set'); value.setValue('title', '具体源标签值'); value.setAction('artist', 'remove'); await value.preview()
    assert.deepEqual(f.previews.at(-1)!.intent, { kind: 'tags', target: selection, fields: { title: { action: 'set', value: '具体源标签值' }, artist: { action: 'remove' } } }); assert.equal(f.confirms.length, 0)
    value.setValue('title', ''); const before = f.previews.length; assert.equal(value.fields.title.action, 'set'); assert.equal(value.canPreview.value, false); await value.preview(); assert.equal(f.previews.length, before)
  }
})
test('012具体READY确认双击单发，accepted与COMPLETED严格区分', async t => {
  const { value, f } = await preview(t); assert.equal(dto.isLocalSourceWritesPlan(value.plan.value), true); assert.equal(value.canConfirm.value, true)
  await Promise.all([value.confirm(), value.confirm()]); assert.equal(f.confirms.length, 1); assert.equal(value.plan.value?.state, 'RUNNING'); assert.match(value.notice.value, /受理/u)
  f.complete(value.plan.value!.planId); await value.reconcile(); assert.equal(value.plan.value?.state, 'COMPLETED'); assert.equal(value.canUndo.value, true)
})
test('012具体预览到期即时关闭最终确认，计时器只更新显示而不读写或重派', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
  const { value, f } = await preview(t), reads = f.reads.length
  assert.equal(value.canConfirm.value, true); t.mock.timers.tick(600001)
  assert.equal(value.planExpired.value, true); assert.equal(value.canConfirm.value, false)
  await value.confirm(); assert.equal(f.confirms.length, 0); assert.equal(f.reads.length, reads)
})
test('012输入改变使预览失效，迟到原回执不覆盖新草稿', async t => {
  const { value, f } = session(t); const gate = deferred<dto.LocalSourceWritesReceipt>(), started = deferred<void>(); f.policy.enabled = true
  f.api.previewLocalSourceWrites = async request => { f.previews.push(request); started.resolve(); return gate.promise }
  await value.open(target); value.setAction('title', 'set'); value.setValue('title', '第一值'); const flight = value.preview(); await started.promise
  value.setValue('title', '第二值'); const original = f.previews[0]!, plan = readyPlan(); f.plans.set(plan.planId, plan); gate.resolve(f.receipt('localSourceWrites.preview', original, plan.planId)); await flight
  assert.equal(value.fields.title.value, '第二值'); assert.equal(value.plan.value, null); assert.equal(value.pending.value.length, 0); assert.equal(f.confirms.length, 0)
})
test('012UNKNOWN及NOT_FOUND、关闭重开和ACK隐藏均不重派或再授权', async t => {
  const { value, f } = await preview(t); const original = f.api.confirmLocalSourceWrites
  f.api.confirmLocalSourceWrites = async request => { f.confirms.push(request); throw new Error('合成回执丢失') }
  await value.confirm(); assert.equal(value.unknown.value, true); await value.reconcile(); assert.equal(value.unknown.value, true); assert.equal(f.confirms.length, 1)
  value.close(); await value.open(target); await value.reconcile(); await settle(); assert.equal(f.confirms.length, 1)
  value.observeOutbox({ datasetId, entries: [] }); assert.equal(f.confirms.length, 1)
  f.api.confirmLocalSourceWrites = original
})
test('012真实冷启动顺序先observeOutbox再open，显式核对可展示原计划且不调用confirm', async t => {
  const f = fixture(), plan = readyPlan(); f.policy.enabled = true; f.plans.set(plan.planId, plan)
  const request: dto.ConfirmLocalSourceWrites = { datasetId, commandId: id(50), planId: plan.planId, expectedViewRevision: plan.viewRevision, scope: 'SOURCE_FILES', range: plan.range, planHash: plan.planHash!, contextFingerprint: plan.contextFingerprint! }
  f.receipt('localSourceWrites.confirm', request, plan.planId); f.entries.push({ id: id(51), commandId: request.commandId, command: 'localSourceWrites.confirm', datasetId, state: 'uncertain', createdAt: plan.createdAt, updatedAt: plan.createdAt, acknowledged: false, canRetry: false, sourceRequestFingerprint: sourceWriteFingerprint('localSourceWrites.confirm', request) })
  const { value } = session(t, f), readPlan = () => value.plan.value
  value.observeOutbox({ datasetId, entries: f.entries }); assert.equal(value.pending.value.length, 1); await value.open(target); assert.equal(value.unknown.value, true); assert.equal(value.plan.value, null)
  await value.reconcile(); const restored = readPlan(); assert.ok(dto.isLocalSourceWritesPlan(restored)); assert.equal(f.confirms.length, 0); assert.equal(restored.planId, plan.planId)
  assert.ok(f.reads.some(read => read.selector.kind === 'command' && read.selector.commandId === request.commandId)); assert.equal(value.unknown.value, false)
})
test('012显式get已核原请求后，原confirm自动迟到不再覆盖新对象草稿', async t => {
  const { value, f } = await preview(t), gate = deferred<dto.LocalSourceWritesReceipt>(), started = deferred<void>()
  f.api.confirmLocalSourceWrites = async request => { f.confirms.push(request); started.resolve(); return gate.promise }
  const work = value.confirm(); await started.promise
  const original = f.confirms[0]!, accepted = f.receipt('localSourceWrites.confirm', original, original.planId)
  await value.open({ mode: 'single', trackId: id(9) }, '新对象'); await value.reconcile(); assert.equal(value.plan.value?.planId, original.planId); assert.equal(value.unknown.value, false)
  await value.open({ mode: 'single', trackId: id(9) }, '新对象新草稿'); value.setAction('title', 'set'); value.setValue('title', '新对象值'); value.notice.value = '保留新草稿'
  gate.resolve(accepted); await work
  assert.equal(value.plan.value, null); assert.equal(value.fields.title.value, '新对象值'); assert.equal(value.notice.value, '保留新草稿'); assert.equal(f.confirms.length, 1)
})
test('012切对象后旧confirm迟到不能清新对象busy或通知，切库不写', async t => {
  const { value, f } = await preview(t), gate = deferred<dto.LocalSourceWritesReceipt>(), started = deferred<void>()
  f.api.confirmLocalSourceWrites = async request => { f.confirms.push(request); started.resolve(); return gate.promise }
  const old = value.confirm(); await started.promise; await value.open({ mode: 'single', trackId: id(9) }, '新对象'); value.confirming.value = true; value.notice.value = '新对象等待'
  gate.resolve(f.receipt('localSourceWrites.confirm', f.confirms[0]!, f.confirms[0]!.planId)); await old
  assert.equal(value.confirming.value, true); assert.equal(value.notice.value, '新对象等待'); assert.equal(value.plan.value, null)
  value.confirming.value = false; f.changeDataset(id(99)); await value.readContext(); assert.equal(value.datasetChanged.value, true); assert.equal(f.confirms.length, 1)
})
test('012撤销只生成反向READY，再次最终confirm才执行', async t => {
  const { value, f } = await preview(t); f.complete(value.plan.value!.planId); await value.reconcile(); const origin = value.plan.value!.planId
  await value.previewUndo(); assert.equal(f.undos.length, 1); assert.equal(f.confirms.length, 0); assert.equal(value.plan.value?.undoOf, origin); assert.equal(value.plan.value?.state, 'READY')
  await value.confirm(); assert.equal(f.confirms.length, 1)
})
test('012取消先get当前修订；get失败不猜旧修订', async t => {
  const { value, f } = await preview(t); f.plans.get(value.plan.value!.planId)!.viewRevision = '9'; await value.cancel(); assert.equal(f.cancels[0]?.expectedViewRevision, '9')
  await value.open(target); value.setAction('title', 'set'); value.setValue('title', '第二份有效预览'); await value.preview(); assert.ok(value.plan.value); f.api.getLocalSourceWrites = async () => { throw new Error('读取失败') }; await value.cancel(); assert.equal(f.cancels.length, 1)
})
test('012缺原图只能重新取得或MB-only，绝不以展示图构建source intent', async t => {
  const { value, f } = session(t); f.context.materials[0] = { ...f.context.materials[0]!, candidateId: null, availability: 'reacquire-required', contentRef: null, originalSha256: null }
  await value.open(target); value.setRange('EMBEDDED_COVER'); assert.equal(value.canPreview.value, false); await value.preview(); assert.equal(f.previews.length, 0); assert.equal(f.confirms.length, 0)
})
test('012历史与处理事件按真实cursor继续读取；不是固定首100条', async t => {
  const { value, f } = await preview(t); const original = f.api.listLocalSourceWritesHistory
  f.api.listLocalSourceWritesHistory = async request => { if (request.selector.kind !== 'events') return original(request); f.historyCalls.push(request); return { datasetId, kind: 'events', planId: request.selector.planId, snapshotFingerprint: 'd'.repeat(64), limit: request.limit, items: [], cursor: request.cursor ? null : 'cursor-two', hasMore: request.cursor === null } }
  await value.loadEvents(); assert.equal(value.eventCursor.value, 'cursor-two'); await value.loadEvents(true); assert.equal(f.historyCalls.at(-1)?.cursor, 'cursor-two'); assert.equal(value.eventCursor.value, null)
})
