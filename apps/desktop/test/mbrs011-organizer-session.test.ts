import assert from 'node:assert/strict'
import test from 'node:test'
import { isLocalOrganizerPlan, type ChangeLocalOrganizer, type CommandOutboxOverview, type CommandOutboxState, type CommandOutboxView, type ConfirmLocalOrganizer, type LocalLibraryPublicApi, type LocalOrganizerPlan, type LocalOrganizerPublicApi, type LocalOrganizerTarget, type PreviewLocalOrganizer } from '@music-bridge/contracts'
import { organizerPlanFixture } from '../../../packages/contracts/test/mbrs011/fixture.js'
import { organizerEffective, useLocalOrganizer } from '../src/renderer/src/composables/application/useLocalOrganizer.js'
import { useLocalLibrary } from '../src/renderer/src/composables/application/useLocalLibrary.js'

const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`
const track = id(1000), second = id(1001), edition = id(20), otherEdition = id(21), dataset = id(90)
const copy = <T>(value: T): T => structuredClone(value)
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((r, e) => { resolve = r; reject = e }); return { promise, resolve, reject } }
function overview(entries: CommandOutboxView[] = [], datasetId = dataset): CommandOutboxOverview { return { datasetId, entries } }
function entry(commandId: string, state: CommandOutboxState, command: CommandOutboxView['command'] = 'localOrganizer.confirm', datasetId = dataset): CommandOutboxView {
  return { id: id(91), datasetId, commandId, command, state, createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z', acknowledged: false, canRetry: state === 'uncertain' }
}
function planFor(request: PreviewLocalOrganizer, state: LocalOrganizerPlan['state'] = 'DRAFT'): LocalOrganizerPlan {
  const value = organizerPlanFixture(), tracks = request.target.mode === 'single' ? [request.target.trackId] : request.target.mode === 'batch' ? request.target.trackIds : [track, second]
  value.planId = request.commandId; value.datasetId = dataset; value.expiresAt = '2099-01-01T00:00:00.000Z'; value.state = state
  value.items = tracks.map((trackId, index) => {
    const item = copy(value.items[0]!), operation = { ...item.operation, operation_id: id(400 + index), target_asset_id: id(2000 + index), source_relative_path: `合成目录/${index}.wav` }
    item.operation = operation; item.trackId = trackId; item.overrideRevision = '3'
    item.raw = { title: `原始曲目 ${index}`, artist: '原始作者', album: '同名专辑', year: '2000', disc: '1', track: String(index + 1) }
    item.before = { fields: { title: '旧人工标题', artist: '旧人工作者', year: '2010' }, annotations: { versionDescription: '此前说明' } }
    item.after = copy(item.before)
    for (const [field, change] of Object.entries(request.patch.fields)) {
      const key = field as keyof typeof item.after.fields
      if (change.action === 'clear') delete item.after.fields[key]; else item.after.fields[key] = change.value
    }
    const annotations = request.patch.annotations
    if (annotations?.versionDescription) { if (annotations.versionDescription.action === 'clear') delete item.after.annotations.versionDescription; else item.after.annotations.versionDescription = annotations.versionDescription.value }
    if (annotations?.groupingSuggestions) { if (annotations.groupingSuggestions.action === 'clear') delete item.after.annotations.groupingSuggestions; else item.after.annotations.groupingSuggestions = copy(annotations.groupingSuggestions.value) }
    return item
  })
  value.body.operations = value.items.map(item => item.operation)
  value.results = value.items.map(item => ({ operationId: item.operation.operation_id, trackId: item.trackId, state: state === 'COMPLETED' ? 'applied' : 'planned', overrideRevision: state === 'COMPLETED' ? '4' : null, issue: null }))
  value.editionBindings = request.target.mode === 'edition' ? [{ editionId: request.target.editionId, revision: '7' }] : []
  assert.equal(isLocalOrganizerPlan(value), true, '合成回执须通过真实闭集合验证')
  return value
}
function fixture(overrides: Partial<LocalOrganizerPublicApi & { getCommandOutbox(): Promise<CommandOutboxOverview> }> = {}) {
  const stored = new Map<string, LocalOrganizerPlan>(), previews: PreviewLocalOrganizer[] = [], confirmations: ConfirmLocalOrganizer[] = [], undos: ChangeLocalOrganizer[] = [], cancels: ChangeLocalOrganizer[] = [], reads: string[] = []
  const api: LocalOrganizerPublicApi & { getCommandOutbox(): Promise<CommandOutboxOverview> } = {
    getCommandOutbox: async () => overview(),
    previewLocalOrganizer: async request => { previews.push(request); const value = planFor(request); stored.set(value.planId, copy(value)); return value },
    getLocalOrganizerPlan: async request => { reads.push(request.planId); const value = stored.get(request.planId); assert.ok(value, '计划尚未持久化'); return copy(value) },
    listLocalOrganizerHistory: async request => ({ ...request, total: stored.size, items: [...stored.values()].slice(request.offset, request.offset + request.limit).map(value => ({ planId: value.planId, revision: value.revision, scope: value.scope, state: value.state, createdAt: value.createdAt, count: value.items.length, issue: value.issue })) }),
    confirmLocalOrganizer: async request => {
      confirmations.push(request); const value = copy(stored.get(request.planId)!); value.state = 'COMPLETED'; value.revision = String(BigInt(value.revision) + 2n)
      value.results = value.results.map(result => ({ ...result, state: 'applied', overrideRevision: '4' })); stored.set(value.planId, copy(value))
      if (value.undoOf) { const original = copy(stored.get(value.undoOf)!); original.state = 'ROLLED_BACK'; original.revision = String(BigInt(original.revision) + 1n); stored.set(original.planId, original) }
      return value
    },
    undoLocalOrganizer: async request => {
      undos.push(request); const value = copy(stored.get(request.planId)!); value.planId = request.commandId; value.revision = '1'; value.state = 'DRAFT'; value.undoOf = request.planId
      value.items = value.items.map(item => ({ ...item, before: copy(item.after), after: copy(item.before) })); value.results = value.results.map(result => ({ ...result, state: 'planned', overrideRevision: null })); stored.set(value.planId, copy(value)); return value
    },
    cancelLocalOrganizer: async request => { cancels.push(request); const value = copy(stored.get(request.planId)!); value.state = 'CANCELLED'; value.revision = String(BigInt(value.revision) + 1n); stored.set(value.planId, copy(value)); return value },
    ...overrides,
  }
  return { api, stored, previews, confirmations, undos, cancels, reads }
}
async function draft(model: ReturnType<typeof useLocalOrganizer>, selection: LocalOrganizerTarget = { mode: 'single', trackId: track }) { await model.open(selection, '合成明确选择'); model.setFieldAction('title', 'set'); model.setFieldValue('title', '本次人工标题'); await model.preview(); assert.ok(model.plan.value) }
async function settle() { for (let n = 0; n < 4; n++) await new Promise<void>(resolve => setImmediate(resolve)) }

test('011六字段保持/set空串/clear与MB注记使用不同意图，预览零保存、双击仅一次Hash绑定保存', async t => {
  const completed = deferred<LocalOrganizerPlan>(), started = deferred<void>(), f = fixture()
  f.api.confirmLocalOrganizer = request => { f.confirmations.push(request); started.resolve(); return completed.promise }
  const model = useLocalOrganizer({ api: f.api }); t.after(() => model.dispose())
  await model.open({ mode: 'single', trackId: track }, '明确曲目', [{ id: edition, title: '同名专辑', edition: '现场', revision: '7' }])
  assert.equal(model.canPreview.value, false)
  model.setFieldAction('title', 'set'); model.setFieldValue('title', ''); model.setFieldAction('year', 'clear')
  model.setVersionAction('set'); model.setVersionDescription('版本说明不是发行身份'); model.setGroupingAction('set'); model.setGroupingSuggestions([{ editionId: edition, expectedRevision: '7', reason: 'Owner选择的独立发行' }])
  await model.preview()
  assert.deepEqual(f.previews[0]!.patch, { fields: { title: { action: 'set', value: '' }, year: { action: 'clear' } }, annotations: { versionDescription: { action: 'set', value: '版本说明不是发行身份' }, groupingSuggestions: { action: 'set', value: [{ editionId: edition, expectedRevision: '7', reason: 'Owner选择的独立发行' }] } } })
  assert.equal(f.confirmations.length, 0); assert.equal(model.plan.value?.items[0]?.after.fields.title, ''); assert.equal(organizerEffective(model.plan.value!.items[0]!, 'year', true), '2000'); assert.equal(model.plan.value?.items[0]?.after.fields.artist, '旧人工作者')
  const value = copy(model.plan.value!), first = model.save(), secondClick = model.save(); await started.promise
  assert.equal(f.confirmations.length, 1); const request = f.confirmations[0]!
  assert.deepEqual({ planId: request.planId, expectedRevision: request.expectedRevision, scope: request.scope, planHash: request.planHash, contextFingerprint: request.contextFingerprint }, { planId: value.planId, expectedRevision: value.revision, scope: 'MB_ONLY', planHash: value.planHash, contextFingerprint: value.contextFingerprint })
  assert.equal(Object.isFrozen(request), true); assert.equal(Object.isFrozen(f.previews[0]!.patch.fields), true)
  value.state = 'COMPLETED'; value.revision = '3'; value.results[0]!.state = 'applied'; completed.resolve(value); await Promise.all([first, secondClick]); assert.equal(model.plan.value?.state, 'COMPLETED')
})

test('011单曲、具体发行与跨页批量保留精确identity，重复/超限选择零预览', async t => {
  const f = fixture(), model = useLocalOrganizer({ api: f.api }); t.after(() => model.dispose())
  const targets: LocalOrganizerTarget[] = [{ mode: 'single', trackId: second }, { mode: 'edition', editionId: otherEdition }, { mode: 'batch', trackIds: [second, track] }]
  for (const target of targets) { await draft(model, target); assert.deepEqual(f.previews.at(-1)?.target, target) }
  assert.equal(model.plan.value?.items.length, 2)
  const previous = copy(model.target.value), count = f.previews.length
  await model.open({ mode: 'batch', trackIds: [track, track] }); await model.open({ mode: 'batch', trackIds: Array.from({ length: 101 }, (_, n) => id(1000 + n)) }); assert.deepEqual(model.target.value, previous); assert.equal(f.previews.length, count)
})

test('011输入变化立即失效，迟到预览不覆盖当前草稿，也不能抢先再派发', async t => {
  const late = deferred<LocalOrganizerPlan>(), started = deferred<PreviewLocalOrganizer>(), f = fixture({ previewLocalOrganizer: request => { started.resolve(request); return late.promise } })
  const model = useLocalOrganizer({ api: f.api }); t.after(() => model.dispose())
  await model.open({ mode: 'single', trackId: track }); model.setFieldAction('title', 'set'); model.setFieldValue('title', '旧输入'); const first = model.preview(), request = await started.promise
  model.setFieldValue('title', '新输入'); assert.equal(model.plan.value, null); assert.equal(model.canConfirm.value, false); assert.equal(model.canPreview.value, false)
  await model.preview(); late.resolve(planFor(request)); await first
  assert.equal(model.plan.value, null); assert.equal(model.fields.title.value, '新输入'); assert.equal(model.canPreview.value, true)
  f.api.previewLocalOrganizer = async next => { f.previews.push(next); return planFor(next) }; await model.preview(); assert.equal((model.plan.value as LocalOrganizerPlan | null)?.items[0]?.after.fields.title, '新输入')
})

test('011已失效预览若变UNKNOWN，按原plan读取后保留新输入、零自动重发', async t => {
  const late = deferred<LocalOrganizerPlan>(), started = deferred<PreviewLocalOrganizer>(), f = fixture({ previewLocalOrganizer: request => { started.resolve(request); return late.promise } })
  const model = useLocalOrganizer({ api: f.api }); t.after(() => model.dispose())
  await model.open({ mode: 'single', trackId: track }); model.setFieldAction('title', 'set'); const first = model.preview(), request = await started.promise
  model.setFieldValue('title', '下一份输入'); f.stored.set(request.commandId, planFor(request)); late.reject(new Error('合成UNKNOWN')); await first
  assert.equal(model.unknown.value, true); await model.reconcile()
  assert.equal(model.pending.value.length, 0); assert.equal(model.plan.value, null); assert.equal(model.fields.title.value, '下一份输入'); assert.equal(model.canPreview.value, true); assert.deepEqual(f.reads, [request.commandId])
})

test('011切换曲目与关闭丢弃迟到预览，旧打开错误不能污染新页面', async t => {
  const late = deferred<LocalOrganizerPlan>(), started = deferred<PreviewLocalOrganizer>(), f = fixture({ previewLocalOrganizer: request => { started.resolve(request); return late.promise } })
  const model = useLocalOrganizer({ api: f.api }); t.after(() => model.dispose())
  await model.open({ mode: 'single', trackId: track }); model.setFieldAction('title', 'set'); const first = model.preview(), request = await started.promise
  await model.open({ mode: 'single', trackId: second }); late.resolve(planFor(request)); await first
  assert.deepEqual(model.target.value, { mode: 'single', trackId: second }); assert.equal(model.plan.value, null); assert.equal(model.error.value, '')
  const delayedOverview = deferred<CommandOutboxOverview>(); let reads = 0
  f.api.getCommandOutbox = () => ++reads === 1 ? delayedOverview.promise : Promise.resolve(overview())
  const oldOpen = model.open({ mode: 'single', trackId: track }); await model.open({ mode: 'single', trackId: second }); delayedOverview.reject(new Error('旧读取失败')); await oldOpen
  assert.equal(model.error.value, ''); assert.equal(model.loading.value, false); model.close(); assert.equal(model.isOpen.value, false)
})

test('011UNKNOWN保存保留原请求，关闭/恢复/ACK隐藏后读取持久终态而零重发', async t => {
  const f = fixture(), model = useLocalOrganizer({ api: f.api }); t.after(() => model.dispose()); await draft(model)
  const value = copy(model.plan.value!)
  f.api.confirmLocalOrganizer = async request => { f.confirmations.push(request); throw new Error('回执未知') }
  await model.save(); const request = model.pending.value[0]!.request; assert.equal(model.unknown.value, true); assert.equal(model.canConfirm.value, false)
  model.close(); model.observeOutbox(overview([entry(request.commandId, 'uncertain')])); assert.equal(f.reads.length, 0)
  value.state = 'COMPLETED'; value.revision = '3'; value.results[0]!.state = 'applied'; f.stored.set(value.planId, value)
  // ACK后的overview没有entry；计划的真实终态仍足以核对该plan。
  await model.open({ mode: 'single', trackId: track }); await model.save(); await model.preview()
  assert.equal(model.pending.value.length, 0); assert.equal(model.plan.value?.state, 'COMPLETED'); assert.equal(model.appliedCount.value, 1); assert.equal(f.confirmations.length, 1); assert.equal(f.previews.length, 1); assert.equal(f.confirmations[0], request)
})

test('011outbox只匹配dataset和commandId，终态后读取真实部分/未知逐项结果', async t => {
  const f = fixture(), model = useLocalOrganizer({ api: f.api }); t.after(() => model.dispose()); await draft(model, { mode: 'batch', trackIds: [track, second] })
  f.api.confirmLocalOrganizer = async request => { f.confirmations.push(request); throw new Error('回执未知') }; await model.save()
  const request = f.confirmations[0]!, value = copy(model.plan.value!); value.state = 'PARTIAL'; value.revision = '3'; value.results[0]!.state = 'applied'; value.results[1]!.state = 'unknown'; value.results[1]!.issue = 'WRITE_RESULT_UNKNOWN'; f.stored.set(value.planId, value)
  model.observeOutbox(overview([entry(id(99), 'succeeded')])); model.observeOutbox(overview([entry(request.commandId, 'succeeded', 'localOrganizer.confirm', id(98))], id(98))); await settle(); assert.equal(f.reads.length, 0)
  model.observeOutbox(overview([entry(request.commandId, 'succeeded')])); await settle()
  assert.equal(model.plan.value?.state, 'PARTIAL'); assert.deepEqual(model.plan.value?.results.map(result => result.state), ['applied', 'unknown']); assert.equal(model.canUndo.value, false); assert.equal(model.pending.value.length, 0); assert.equal(f.confirmations.length, 1); assert.equal(model.appliedCount.value, 1)
})

test('011终态读取失败仍保留UNKNOWN，手动重读只GET且保持原请求', async t => {
  const f = fixture(), model = useLocalOrganizer({ api: f.api }); t.after(() => model.dispose()); await draft(model)
  f.api.confirmLocalOrganizer = async request => { f.confirmations.push(request); throw new Error('UNKNOWN') }; await model.save()
  const originalGet = f.api.getLocalOrganizerPlan; f.api.getLocalOrganizerPlan = async () => { throw new Error('合成读失败') }
  model.observeOutbox(overview([entry(f.confirmations[0]!.commandId, 'succeeded')])); await settle(); assert.equal(model.pending.value.length, 1); assert.equal(model.canConfirm.value, false)
  const value = copy(model.plan.value!); value.state = 'COMPLETED'; value.revision = '3'; value.results[0]!.state = 'applied'; f.stored.set(value.planId, value); f.api.getLocalOrganizerPlan = originalGet
  await model.reconcile(); assert.equal(model.pending.value.length, 0); assert.equal(f.confirmations.length, 1); assert.equal(model.plan.value?.state, 'COMPLETED')
})

test('011pending取消先GET服务器CONFIRMED修订，不用本地DRAFT修订', async t => {
  const f = fixture(), model = useLocalOrganizer({ api: f.api }); t.after(() => model.dispose()); await draft(model)
  f.api.confirmLocalOrganizer = async request => { f.confirmations.push(request); const value = copy(f.stored.get(request.planId)!); value.state = 'CONFIRMED'; value.revision = '2'; f.stored.set(value.planId, value); throw new Error('UNKNOWN') }
  await model.save(); assert.equal(model.plan.value?.revision, '1'); assert.equal(model.canCancel.value, true)
  await model.cancelPlan(); assert.equal(f.cancels.length, 1); assert.equal(f.cancels[0]!.expectedRevision, '2'); assert.deepEqual(f.reads, [f.cancels[0]!.planId]); assert.equal(model.plan.value?.state, 'CANCELLED'); assert.equal(model.pending.value.length, 0); assert.equal(f.confirmations.length, 1)
})

test('011取消读取失败或结果已经完成，零取消派发并保留事实', async t => {
  const f = fixture(), model = useLocalOrganizer({ api: f.api }); t.after(() => model.dispose()); await draft(model)
  const originalGet = f.api.getLocalOrganizerPlan; f.api.getLocalOrganizerPlan = async () => { throw new Error('合成读失败') }; await model.cancelPlan(); assert.equal(f.cancels.length, 0); assert.equal(model.plan.value?.state, 'DRAFT')
  f.api.getLocalOrganizerPlan = originalGet; const value = copy(model.plan.value!); value.state = 'COMPLETED'; value.revision = '3'; value.results[0]!.state = 'applied'; f.stored.set(value.planId, value)
  await model.cancelPlan(); assert.equal(f.cancels.length, 0); assert.equal(model.plan.value?.state, 'COMPLETED')
})

test('011迟到的较旧保存回执不能把已取消计划倒退到旧修订', async t => {
  const late = deferred<LocalOrganizerPlan>(), started = deferred<ConfirmLocalOrganizer>(), f = fixture()
  f.api.confirmLocalOrganizer = request => { started.resolve(request); const value = copy(f.stored.get(request.planId)!); value.state = 'CONFIRMED'; value.revision = '2'; f.stored.set(value.planId, value); return late.promise }
  const model = useLocalOrganizer({ api: f.api }); t.after(() => model.dispose()); await draft(model); const saving = model.save(), request = await started.promise
  const old = copy(f.stored.get(request.planId)!); await model.cancelPlan(); assert.equal(model.plan.value?.revision, '3'); late.resolve(old); await saving
  assert.equal(model.plan.value?.state, 'CANCELLED'); assert.equal(model.plan.value?.revision, '3'); assert.equal(f.cancels.length, 1)
})

test('011撤销仅生成反向preview，第二次明确保存才执行并能从重启历史读取', async t => {
  const f = fixture(), model = useLocalOrganizer({ api: f.api }); t.after(() => model.dispose()); await draft(model); await model.save()
  const original = copy(model.plan.value!); await model.previewUndo()
  assert.equal(f.undos.length, 1); assert.equal(f.confirmations.length, 1); assert.equal(model.plan.value?.undoOf, original.planId); assert.equal(model.plan.value?.state, 'DRAFT'); assert.deepEqual(model.plan.value?.items[0]?.after, original.items[0]?.before)
  await model.save(); assert.equal(f.confirmations.length, 2); assert.equal(f.stored.get(original.planId)?.state, 'ROLLED_BACK'); model.dispose()
  const reopened = useLocalOrganizer({ api: f.api }); t.after(() => reopened.dispose()); await reopened.openHistory(); assert.equal(reopened.historyLoaded.value, true); assert.equal(reopened.history.value.total, 2)
  await reopened.loadPlan(original.planId); assert.equal(reopened.plan.value?.state, 'ROLLED_BACK'); assert.equal(f.confirmations.length, 2); assert.equal(f.undos.length, 1)
})

test('011撤销与取消UNKNOWN只按原identity读取，重开与ACK隐藏零自动派发', async t => {
  const f = fixture(), model = useLocalOrganizer({ api: f.api }); t.after(() => model.dispose()); await draft(model); await model.save()
  const normalUndo = f.api.undoLocalOrganizer; f.api.undoLocalOrganizer = async request => { await normalUndo(request); throw new Error('反向预览回执未知') }
  await model.previewUndo(); assert.equal(model.unknown.value, true); const reverseId = model.pending.value[0]!.planId; model.close(); await model.open({ mode: 'single', trackId: track })
  assert.equal(model.plan.value?.planId, reverseId); assert.equal(model.plan.value?.state, 'DRAFT'); assert.equal(model.pending.value.length, 0); assert.equal(f.undos.length, 1); assert.equal(f.confirmations.length, 1)
  const normalCancel = f.api.cancelLocalOrganizer; f.api.cancelLocalOrganizer = async request => { await normalCancel(request); throw new Error('取消回执未知') }
  await model.cancelPlan(); assert.equal(model.unknown.value, true); model.close(); await model.open({ mode: 'single', trackId: track }); assert.equal(model.plan.value?.state, 'CANCELLED'); assert.equal(model.pending.value.length, 0); assert.equal(f.cancels.length, 1); assert.equal(f.confirmations.length, 1); assert.equal(f.undos.length, 1)
})

test('011保存回执Hash错配保留未知原请求，较旧get在返回编辑后零覆盖', async t => {
  const f = fixture(), model = useLocalOrganizer({ api: f.api }); t.after(() => model.dispose()); await draft(model)
  f.api.confirmLocalOrganizer = async request => { f.confirmations.push(request); const value = copy(f.stored.get(request.planId)!); value.planHash = 'c'.repeat(64); value.state = 'COMPLETED'; value.revision = '3'; value.results[0]!.state = 'applied'; return value }
  await model.save(); assert.equal(model.unknown.value, true); assert.equal(model.plan.value?.state, 'DRAFT'); assert.equal(model.appliedCount.value, 0); assert.equal(model.pending.value.length, 1); await model.save(); assert.equal(f.confirmations.length, 1)
  await model.cancelPlan(); assert.equal(model.pending.value.length, 0)
  await draft(model); const value = copy(model.plan.value!), late = deferred<LocalOrganizerPlan>(), started = deferred<void>(); f.api.getLocalOrganizerPlan = () => { started.resolve(); return late.promise }
  const reading = model.loadPlan(value.planId); await started.promise; model.edit(); model.setFieldValue('title', '继续编辑的值'); late.resolve(value); await reading
  assert.equal(model.plan.value, null); assert.equal(model.view.value, 'edit'); assert.equal(model.fields.title.value, '继续编辑的值'); assert.equal(model.loading.value, false)
})

test('011历史首次失败不伪称空历史，迟到旧读取不能覆盖新记录', async t => {
  const late = deferred<LocalOrganizerPlan>(), f = fixture(), model = useLocalOrganizer({ api: f.api }); t.after(() => model.dispose())
  f.api.listLocalOrganizerHistory = async () => { throw new Error('合成首次失败') }; await model.openHistory(); assert.equal(model.historyLoaded.value, false); assert.match(model.error.value, /暂时无法读取/u)
  const a = planFor({ commandId: id(501), scope: 'MB_ONLY', target: { mode: 'single', trackId: track }, patch: { fields: { title: { action: 'set', value: 'A' } } } }), b = planFor({ commandId: id(502), scope: 'MB_ONLY', target: { mode: 'single', trackId: second }, patch: { fields: { title: { action: 'set', value: 'B' } } } })
  f.api.getLocalOrganizerPlan = request => request.planId === a.planId ? late.promise : Promise.resolve(b)
  const readingA = model.loadPlan(a.planId); await model.loadPlan(b.planId); late.resolve(a); await readingA; assert.equal(model.plan.value?.planId, b.planId); assert.equal(model.loading.value, false)
})

test('011切库保留未知请求并阻断新派发，返回原库只读取恢复', async t => {
  let currentDataset = dataset
  const f = fixture({ getCommandOutbox: async () => overview([], currentDataset) }), model = useLocalOrganizer({ api: f.api }); t.after(() => model.dispose()); await draft(model)
  f.api.confirmLocalOrganizer = async request => { f.confirmations.push(request); throw new Error('UNKNOWN') }; await model.save(); const originalRequest = model.pending.value[0]!.request
  model.close(); currentDataset = id(98); await model.open({ mode: 'single', trackId: second }); await model.preview(); await model.save(); assert.equal(model.datasetChanged.value, true); assert.equal(model.pending.value[0]!.request, originalRequest); assert.equal(f.previews.length, 1); assert.equal(f.confirmations.length, 1)
  currentDataset = dataset; const value = copy(f.stored.get((originalRequest as ConfirmLocalOrganizer).planId)!); value.state = 'CANCELLED'; value.revision = '3'; f.stored.set(value.planId, value); await model.open({ mode: 'single', trackId: track }); assert.equal(model.datasetChanged.value, false); assert.equal(model.pending.value.length, 0); assert.equal(model.plan.value?.state, 'CANCELLED')
})

test('011源文件计划与过期预览仅可读取，不能从界面保存或撤销', async t => {
  const f = fixture(), model = useLocalOrganizer({ api: f.api }); t.after(() => model.dispose()); await draft(model)
  const expired = copy(model.plan.value!); expired.expiresAt = '2026-10-07T00:15:00.000Z'; f.stored.set(expired.planId, expired); await model.loadPlan(expired.planId); assert.equal(model.canConfirm.value, false); await model.save(); assert.equal(f.confirmations.length, 0)
  const source = copy(expired); source.scope = 'SOURCE_FILES'; source.body.scope = 'SOURCE_FILES'; source.body.resource_guards.require_exclusive_asset_lock = true; source.body.resource_guards.defer_if_read_lease = true; source.items[0]!.operation.kind = 'WRITE_TAGS'; source.items[0]!.operation.backup_required = true; source.body.operations = source.items.map(item => item.operation); source.state = 'BLOCKED'; source.issue = 'SOURCE_FILES_WRITE_OFF'; source.expiresAt = '2099-01-01T00:00:00.000Z'; f.stored.set(source.planId, source)
  await model.loadPlan(source.planId); assert.equal(model.canConfirm.value, false); assert.equal(model.canUndo.value, false); await model.save(); await model.previewUndo(); assert.equal(f.confirmations.length, 0); assert.equal(f.undos.length, 0)
})

test('011跨页选择最多100个identity，整理busy独立于原本地播放与标题入口', async t => {
  const f = fixture(), sent: string[] = [], complete = deferred<LocalOrganizerPlan>(), started = deferred<ConfirmLocalOrganizer>()
  f.api.confirmLocalOrganizer = request => { f.confirmations.push(request); started.resolve(request); return complete.promise }
  const root = { root: { id: id(1), sourceRootId: id(2), role: 'library', revision: '1' }, label: '合成授权目录', availability: 'ONLINE' }
  const detail = { track: { id: track, assetId: id(2000), selectionRevision: '1', segment: null }, asset: { id: id(2000), libraryRootId: id(1), sourceRootId: id(2), rootRevision: '1', fileRevision: '1', locationRevision: '1', sampleFrames: null, timebaseHz: null }, metadata: { raw: { title: '原始曲目' }, effective: { title: '原始曲目' }, override: null }, editions: [], versionTokens: [], fileParameters: null }
  const libraryApi = { ...f.api, queryLocalLibraryTracks: async (query: any) => ({ ...query, total: 240, hasMore: query.offset + query.limit < 240, items: Array.from({ length: Math.min(query.limit, 240 - query.offset) }, (_, n) => { const index = query.offset + n; return { track: { ...detail.track, id: id(1000 + index), assetId: id(2000 + index) }, asset: { ...detail.asset, id: id(2000 + index) }, metadata: { title: `原始曲目 ${index}` }, versionTokens: [] } }) }), getLocalLibraryTrackDetail: async () => detail, listLocalLibraryRoots: async () => [root], getLocalLibraryPlaybackTarget: async () => ({ core_id: '受控Core', zone_id: '受控Zone' }) } as unknown as LocalLibraryPublicApi & typeof f.api
  const library = useLocalLibrary({ api: libraryApi, getSelectedZone: () => ({ zoneId: '受控Zone', displayName: '原播放目标', selected: true }), play: async request => { sent.push(request.local_track_id); return { status: 'accepted', request_id: request.request_id, action: request.action } } }); t.after(() => library.dispose())
  await library.activate(); for (let n = 0; n < 100; n++) library.toggleTrackSelection(id(1000 + n)); library.toggleTrackSelection(id(1100)); assert.equal(library.selectedTrackIds.value.length, 100); assert.match(library.selectionError.value, /100/u)
  await library.search('第二页'); await library.ensureRange(120, 130); assert.equal(library.selectedTrackIds.value[0], track); assert.equal(library.selectedTrackIds.value.at(-1), id(1099)); library.suspend(); assert.equal(library.selectedTrackIds.value.length, 100); await library.activate()
  await draft(library.organizer); const saving = library.organizer.save(); await started.promise; assert.equal(library.organizer.confirming.value, true); assert.equal(library.actionBusy.value, false)
  await library.playTrack(track); assert.deepEqual(sent, [track]); assert.equal(typeof library.saveTitle, 'function'); const value = copy(library.organizer.plan.value!); value.state = 'COMPLETED'; value.revision = '3'; value.results[0]!.state = 'applied'; complete.resolve(value); await saving
})
