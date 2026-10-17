import assert from 'node:assert/strict'
import test from 'node:test'
import { ref } from 'vue'
import { mountVueSfc } from './support/mbf-vue-host.js'
import { useLocalLibraryWorkbench } from '../src/renderer/src/composables/application/local-library-workbench/controller.js'
import type { LocalWorkbenchAlbumRef, LocalWorkbenchPlan, LocalWorkbenchReceipt, LocalWorkbenchPorts, LocalWorkbenchApplyRequest } from '../src/renderer/src/composables/application/local-library-workbench/types.js'
const album: LocalWorkbenchAlbumRef = { albumId: 'album-a', rootId: 'root-a', title: '合成完整专辑', artist: '合成艺人', trackIds: ['track-a'] }
const plan: Extract<LocalWorkbenchPlan, { kind: 'artwork' }> = { kind: 'artwork', scope: 'MB_ONLY', relationship: 'create-on-apply', datasetId: 'dataset-a', planId: 'cover-plan', revision: '1', planHash: 'a'.repeat(64), contextFingerprint: 'b'.repeat(64), expiresAt: '2099-01-01T00:00:00.000Z', albumIds: ['album-a'], state: 'ready', blockers: [], items: [{ itemId: 'cover-item', albumId: 'album-a', label: album.title, changes: [] }] }
const receipt = (body: LocalWorkbenchApplyRequest, state: LocalWorkbenchReceipt['state'] = 'succeeded'): LocalWorkbenchReceipt => ({ commandId: body.commandId, datasetId: body.datasetId, planId: body.planId, planHash: body.planHash, state, message: null, items: [{ itemId: 'cover-item', albumId: 'album-a', label: album.title, state: state === 'succeeded' ? 'applied' : 'unknown', message: null }] })
const ports = (extra: Partial<LocalWorkbenchPorts> = {}): LocalWorkbenchPorts => ({
  readAlbums: async () => ({ datasetId: 'dataset-a', snapshotId: 'snapshot-a', albums: [{ album, capture: { albumId: album.albumId, readToken: 'capture-a' }, availability: 'online', issues: [], currentArtwork: null, cueSheets: [] }] }),
  findArtworkCandidates: async () => [{ candidateId: 'cover-a', albumId: album.albumId, label: '合成图片', origin: 'manual', sourceLabel: '明确选择', previewUrl: 'data:image/jpeg;base64,/9j/', width: 32, height: 32, licenseLabel: '用户提供' }],
  previewArtwork: async () => plan, ...extra,
})
async function choose(model: ReturnType<typeof useLocalLibraryWorkbench>) { await model.open({ action: 'artwork', albums: [album] }); await model.lookupArtwork('local'); model.selectArtwork('cover-a') }

test('共同Save依序确认封面再保存歌词，二者完整终态才恢复原离开意图', async t => {
  const order: string[] = [], pending = ref(true), locked = ref(false)
  const model = useLocalLibraryWorkbench({ ports: ports({ applyPlan: async body => { order.push('cover'); return receipt(body) } }), saveParticipants: [{ pending, locked, save: async () => { order.push('lyrics'); pending.value = false; return true }, discard: () => true }] })
  t.after(() => model.dispose()); await choose(model)
  let left = 0; assert.equal(model.requestLeave(() => left++), false); assert.equal(left, 0)
  await model.saveBeforeLeave(); assert.deepEqual(order, ['cover', 'lyrics']); assert.equal(left, 1); assert.equal(model.leavePrompt.value, false)
})
test('封面派发结果UNKNOWN阻断歌词和丢弃，查询同原body不能重发或生成新UUID', async t => {
  let applies = 0, ids = 0, lyrics = 0; const seen: LocalWorkbenchApplyRequest[] = []
  const model = useLocalLibraryWorkbench({ makeCommandId: () => `command-${++ids}`, ports: ports({ applyPlan: async body => { applies++; seen.push(structuredClone(body)); throw new Error('合成超时') }, readOriginalReceipt: async body => { seen.push(structuredClone(body)); return null } }), saveParticipants: [{ pending: ref(true), locked: ref(false), save: async () => { lyrics++; return true }, discard: () => true }] })
  t.after(() => model.dispose()); await choose(model); let left = 0; model.requestLeave(() => left++)
  await model.saveBeforeLeave(); await model.discardBeforeLeave(); await model.readOriginalReceipt(); await model.saveBeforeLeave()
  assert.equal(applies, 1); assert.equal(ids, 1); assert.equal(lyrics, 0); assert.equal(left, 0); assert.equal(model.leaveLocked.value, true); assert.deepEqual(seen[1], seen[0])
})
test('Continue保留待保存选择，显式Discard只丢弃零写草稿且恢复一次原目标', async t => {
  const pending = ref(true); let discarded = 0, applies = 0
  const model = useLocalLibraryWorkbench({ ports: ports({ applyPlan: async body => { applies++; return receipt(body) } }), saveParticipants: [{ pending, locked: ref(false), save: async () => false, discard: () => { discarded++; pending.value = false; return true } }] })
  t.after(() => model.dispose()); await choose(model); let left = 0
  model.requestLeave(() => left++); model.continueEditing(); assert.equal(model.selectedArtworkId.value, 'cover-a'); assert.equal(left, 0)
  model.requestLeave(() => left++); await model.discardBeforeLeave(); await model.discardBeforeLeave()
  assert.equal(left, 1); assert.equal(discarded, 1); assert.equal(applies, 0); assert.equal(model.selectedArtworkId.value, null)
})
test('实际歌词writer锁定时Sidebar与Settings共用门禁，Save和Discard均不能清锁', async t => {
  const locked = ref(true); let saves = 0, discards = 0, left = 0
  const model = useLocalLibraryWorkbench({ ports: ports(), saveParticipants: [{ pending: ref(true), locked, save: async () => { saves++; return true }, discard: () => { discards++; return true } }] })
  t.after(() => model.dispose()); model.requestLeave(() => left++); await model.saveBeforeLeave(); await model.discardBeforeLeave()
  assert.equal(left, 0); assert.equal(saves, 0); assert.equal(discards, 0); assert.equal(model.close(), false)
})
test('封面终态已确认但歌词保存失败保留选择，后续离开不把部分完成当全部保存', async t => {
  const pending = ref(true); let cover = 0, lyrics = 0, left = 0
  const model = useLocalLibraryWorkbench({ ports: ports({ applyPlan: async body => { cover++; return receipt(body) } }), saveParticipants: [{ pending, locked: ref(false), save: async () => { lyrics++; return false }, discard: () => false }] })
  t.after(() => model.dispose()); await choose(model); model.requestLeave(() => left++); await model.saveBeforeLeave(); await model.saveBeforeLeave()
  assert.equal(cover, 1); assert.equal(lyrics, 2); assert.equal(left, 0); assert.equal(model.hasPendingChanges.value, true)
})

test('真实工作台关闭按钮进入Save/Discard/Continue，点击Save仅在参与者终态后关闭', async t => {
  const pending = ref(false); let saved = 0
  const model = useLocalLibraryWorkbench({ ports: ports(), saveParticipants: [{ pending, locked: ref(false), save: async () => { saved++; pending.value = false; return true }, discard: () => { pending.value = false; return true } }] }); t.after(model.dispose)
  await model.open({ action: 'overview', albums: [album] }); pending.value = true
  const host = await mountVueSfc(t, new URL('../src/renderer/src/components/library/local-workbench/LocalLibraryWorkbench.vue', import.meta.url).pathname, { model })
  const button = (label: string) => host.all().find(v => v.type === 'button' && host.text(v) === label)
  await host.dispatch(button('返回专辑浏览'), 'onClick'); assert.equal(model.isOpen.value, true); assert.match(host.text(), /继续编辑/u)
  await host.dispatch(button('继续编辑'), 'onClick'); assert.equal(model.isOpen.value, true); assert.equal(saved, 0)
  await host.dispatch(button('返回专辑浏览'), 'onClick'); await host.dispatch(button('保存并离开'), 'onClick')
  assert.equal(saved, 1); assert.equal(model.isOpen.value, false)
})

test('共同Discard在异步Owner确认前保留页面并阻重复点击，确认后只恢复一次原导航', async t => {
  const pending = ref(true); let resolve!: (value: boolean) => void, discarded = 0, left = 0
  const held = new Promise<boolean>(done => { resolve = done })
  const model = useLocalLibraryWorkbench({ ports: ports(), saveParticipants: [{ pending, locked: ref(false), save: async () => false, discard: async () => { discarded++; const accepted = await held; if (accepted) pending.value = false; return accepted } }] }); t.after(model.dispose)
  model.requestLeave(() => left++); const first = model.discardBeforeLeave(); await model.discardBeforeLeave()
  assert.equal(model.leaveLocked.value, true); assert.equal(model.leavePrompt.value, true); assert.equal(left, 0); assert.equal(discarded, 1)
  resolve(true); await first; assert.equal(left, 1); assert.equal(model.leavePrompt.value, false); assert.equal(model.leaveLocked.value, false)
})

function delegatedReply<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed })
  return { promise, resolve, reject }
}

test('真实委托回调确认成功后切换歌词或音乐库面板，等待期间不提前改变原上下文', async t => {
  for (const [existing, pane] of [['lyrics', 'lyrics'], ['libraries', 'library']] as const) {
    const held = delegatedReply<{ opened: true }>()
    let model!: ReturnType<typeof useLocalLibraryWorkbench>, calls = 0
    model = useLocalLibraryWorkbench({ ports: ports({
      existingActions: { [existing]: { available: true } },
      openExistingAction: async request => { calls++; assert.equal(request.action, existing); model.setAction(pane); return held.promise },
    }) })
    t.after(model.dispose); await model.open({ action: 'organize', albums: [album] })
    const binding = structuredClone(model.readback.value), opening = model.openExisting(existing)
    assert.equal(model.action.value, 'organize'); assert.equal(model.busy.value, true)
    held.resolve({ opened: true }); assert.equal(await opening, true)
    assert.equal(calls, 1); assert.equal(model.action.value, pane); assert.equal(model.isOpen.value, true)
    assert.deepEqual(model.readback.value, binding); assert.equal(model.busy.value, false)
  }
})

test('真实委托回调返回失败或抛错时保留原面板，不能应用待确认的内部跳转', async t => {
  for (const failure of ['reply', 'throw'] as const) {
    const held = delegatedReply<{ opened: false; reason: string }>()
    let model!: ReturnType<typeof useLocalLibraryWorkbench>
    model = useLocalLibraryWorkbench({ ports: ports({
      existingActions: { lyrics: { available: true } },
      openExistingAction: async () => { model.setAction('lyrics'); return held.promise },
    }) })
    t.after(model.dispose); await model.open({ action: 'organize', albums: [album] })
    const opening = model.openExisting('lyrics'); assert.equal(model.action.value, 'organize')
    if (failure === 'reply') held.resolve({ opened: false, reason: '合成委托入口未打开。' })
    else held.reject(new Error('合成委托失败'))
    assert.equal(await opening, false); assert.equal(model.action.value, 'organize')
    assert.equal(model.isOpen.value, true); assert.equal(model.busy.value, false); assert.notEqual(model.error.value, '')
  }
})

test('旧委托确认迟到不切换重新打开的面板，也不关闭新的专辑上下文', async t => {
  const held = delegatedReply<{ opened: true }>()
  let model!: ReturnType<typeof useLocalLibraryWorkbench>
  model = useLocalLibraryWorkbench({ ports: ports({
    existingActions: { lyrics: { available: true } },
    openExistingAction: async () => { model.setAction('lyrics'); return held.promise },
  }) })
  t.after(model.dispose); await model.open({ action: 'organize', albums: [album] })
  const opening = model.openExisting('lyrics'); assert.equal(model.close(), true)
  await model.open({ action: 'overview', albums: [album] }); const binding = structuredClone(model.readback.value)
  held.resolve({ opened: true }); assert.equal(await opening, false)
  assert.equal(model.action.value, 'overview'); assert.equal(model.isOpen.value, true)
  assert.deepEqual(model.readback.value, binding); assert.equal(model.busy.value, false)
})

test('真实专辑读取忙碌时仍阻断面板切换和维护委托，不能为快捷入口放开所有busy', async t => {
  const held = delegatedReply<Awaited<ReturnType<NonNullable<LocalWorkbenchPorts['readAlbums']>>>>()
  let delegated = 0
  const original = await ports().readAlbums!({ albums: [album] }, { signal: new AbortController().signal })
  const model = useLocalLibraryWorkbench({ ports: ports({
    readAlbums: async () => held.promise,
    existingActions: { lyrics: { available: true } },
    openExistingAction: async () => { delegated++; return { opened: true } },
  }) })
  t.after(model.dispose); const opening = model.open({ action: 'organize', albums: [album] })
  model.setAction('lyrics'); const delegatedWhileBusy = await model.openExisting('lyrics')
  held.resolve(original); await opening
  assert.equal(delegatedWhileBusy, false); assert.equal(delegated, 0); assert.equal(model.action.value, 'organize')
  model.setAction('lyrics'); assert.equal(model.action.value, 'lyrics')
})

test('局部撤销封面后共同Save只保存保留的歌词，歌词失败仍保门禁且没有apply或共同Discard', async t => {
  const pending = ref(true); let applies = 0, saves = 0, discards = 0, accepted = false, left = 0
  const model = useLocalLibraryWorkbench({ ports: ports({ applyPlan: async body => { applies++; return receipt(body) } }),
    saveParticipants: [{ pending, locked: ref(false), save: async () => { saves++; if (accepted) pending.value = false; return accepted }, discard: () => { discards++; return false } }] })
  t.after(model.dispose); await choose(model); await model.previewArtwork()
  const undo = Reflect.get(model, 'revokeArtwork') as () => void
  assert.equal(typeof undo, 'function'); undo()
  assert.equal(model.selectedArtworkId.value, null); assert.equal(model.hasPendingChanges.value, true)
  model.requestLeave(() => left++); await model.saveBeforeLeave()
  assert.equal(left, 0); assert.equal(model.leavePrompt.value, true); assert.equal(pending.value, true)
  accepted = true; await model.saveBeforeLeave()
  assert.equal(left, 1); assert.equal(saves, 2); assert.equal(applies, 0); assert.equal(discards, 0)
})
