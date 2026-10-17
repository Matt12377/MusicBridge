import assert from 'node:assert/strict'
import test from 'node:test'
import * as publicContracts from '@music-bridge/contracts'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { compileScript, parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import { createSSRApp, type Component } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { mountVueSfc } from './support/mbf-vue-host.js'
import {
  useLocalLibraryWorkbench, localWorkbenchExistingActionLabels, localWorkbenchFieldLabels, localWorkbenchResultLabels,
  isLocalWorkbenchPreviewUrl,
} from '../src/renderer/src/composables/application/local-library-workbench/controller.js'
import type {
  LocalAiNameCandidate, LocalWorkbenchAlbumRef, LocalWorkbenchApplyRequest, LocalWorkbenchPlan,
  LocalWorkbenchPorts, LocalWorkbenchReadback, LocalWorkbenchReceipt, LocalWorkbenchOperation,
} from '../src/renderer/src/composables/application/local-library-workbench/types.js'

const image = 'data:image/jpeg;base64,/9j/'
const album = (id = 'album-a'): LocalWorkbenchAlbumRef => ({ albumId: id, title: '合成专辑 ' + id, artist: '合成艺人', rootId: 'root-a', trackIds: ['track-' + id] })
const a = album(), b = album('album-b')
function readback(albums: readonly LocalWorkbenchAlbumRef[]): LocalWorkbenchReadback {
  return {
    datasetId: 'dataset-a', snapshotId: 'snapshot-a',
    albums: albums.map(value => ({
      album: structuredClone(value), capture: { albumId: value.albumId, readToken: 'capture-' + value.albumId },
      availability: 'online', issues: [], currentArtwork: { label: '原合成封面', previewUrl: image },
      cueSheets: [{ cueId: 'cue-' + value.albumId, label: '合成.cue', eligible: true }],
    })),
  }
}
function artwork(albumId = a.albumId) {
  return { candidateId: 'candidate-' + albumId, albumId, label: '合成候选封面', origin: 'manual' as const,
    sourceLabel: '明确选择的合成图片', previewUrl: image, width: 32, height: 32, licenseLabel: '用户提供' }
}
function suggestion(albumId = a.albumId): LocalAiNameCandidate {
  return { candidateId: 'ai-' + albumId, albumId, title: '合成专辑清洗后', artist: '合成艺人', reason: '合成模型根据已读专辑与标签提出名称。',
    changes: [{ field: 'album', before: '合成专辑原名', after: '合成专辑清洗后', reason: '移除已识别的格式后缀。' }] }
}
function artworkPlan(albums: readonly LocalWorkbenchAlbumRef[] = [a]): Extract<LocalWorkbenchPlan, { kind: 'artwork' }> {
  return { kind: 'artwork', scope: 'MB_ONLY', relationship: 'create-on-apply', datasetId: 'dataset-a',
    planId: 'plan-artwork-' + albums[0]!.albumId, revision: '1', planHash: 'a'.repeat(64), contextFingerprint: 'b'.repeat(64),
    expiresAt: '2099-01-01T00:00:00.000Z', albumIds: albums.map(value => value.albumId), state: 'ready', blockers: [],
    items: albums.map(value => ({ itemId: 'item-' + value.albumId, albumId: value.albumId, label: value.title, changes: [] })) }
}
function aiPlan(albums: readonly LocalWorkbenchAlbumRef[]): Extract<LocalWorkbenchPlan, { kind: 'ai' }> {
  const { relationship: _relationship, ...value } = artworkPlan(albums)
  return { ...value, kind: 'ai', candidateIds: albums.map(value => suggestion(value.albumId).candidateId),
    items: value.items.map(item => ({ ...item, changes: suggestion(item.albumId).changes })) }
}
function cuePlan(albums: readonly LocalWorkbenchAlbumRef[] = [a]): Extract<LocalWorkbenchPlan, { kind: 'cue' }> {
  const { relationship: _relationship, ...value } = artworkPlan(albums), target = { choiceId: 'output-target', label: '合成独立输出目录', independent: true as const }
  return { ...value, kind: 'cue', scope: 'INDEPENDENT_OUTPUT', sourceDisposition: 'retain', target,
    tracks: value.items.map((item, index) => ({ ...item, sequence: index + 1, sourceLabel: '合成整轨.flac',
      startFrame: 0, frameCount: 44_100, sampleRate: 44_100, outputName: '合成轨道' + (index + 1) + '.flac', outputFormat: 'flac' })) }
}
function receipt(request: LocalWorkbenchApplyRequest, plan: LocalWorkbenchPlan, state: LocalWorkbenchReceipt['state'] = 'succeeded'): LocalWorkbenchReceipt {
  return { commandId: request.commandId, datasetId: request.datasetId, planId: request.planId, planHash: request.planHash, state, message: null,
    items: plan.items.map(value => ({ itemId: value.itemId, albumId: value.albumId, label: value.label,
      state: state === 'succeeded' ? 'applied' : state === 'cancelled' ? 'cancelled' : 'unknown', message: null })) }
}
function recoveredOperation(captured: LocalWorkbenchPlan = cuePlan([a, b]), commandId = 'persisted-command'): LocalWorkbenchOperation {
  const request: LocalWorkbenchApplyRequest = { commandId, datasetId: captured.datasetId, planId: captured.planId,
    expectedRevision: captured.revision, planHash: captured.planHash, contextFingerprint: captured.contextFingerprint, kind: captured.kind }
  return { request, plan: captured, state: 'unknown', receipt: { ...receipt(request, captured, 'partial'),
    items: captured.items.map((item, index) => ({ itemId: item.itemId, albumId: item.albumId, label: item.label,
      state: index === 0 && captured.items.length > 1 ? 'applied' : 'unknown',
      message: index === 0 && captured.items.length > 1 ? null : '合成持久回执待确认。' })) } }
}
function ports(overrides: Partial<LocalWorkbenchPorts> = {}): LocalWorkbenchPorts {
  return {
    readAlbums: async request => readback(request.albums),
    findArtworkCandidates: async request => [artwork(request.capture.albumId)],
    previewArtwork: async request => artworkPlan([album(request.capture.albumId)]),
    aiBackends: [{ id: 'ollama', label: '本地 Ollama', availability: { available: true } }, { id: 'vllm', label: 'vLLM', availability: { available: true } }],
    suggestAlbumName: async request => ({ albumId: request.capture.albumId, candidates: [suggestion(request.capture.albumId)] }),
    previewAi: async request => aiPlan(request.selections.map(value => album(value.albumId))),
    cueFormats: [{ id: 'flac', label: 'FLAC', availability: { available: true } }],
    chooseCueOutputTarget: async () => ({ choiceId: 'output-target', label: '合成独立输出目录', independent: true }),
    previewCueSplit: async request => cuePlan(request.cueSelections.map(value => album(value.albumId))),
    ...overrides,
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (value: Error) => void
  const promise = new Promise<T>((r, e) => { resolve = r; reject = e })
  return { promise, resolve, reject }
}
function model(port: LocalWorkbenchPorts) {
  let commands = 0
  const value = useLocalLibraryWorkbench({ ports: port, makeCommandId: () => 'command-' + ++commands })
  return { value, commands: () => commands }
}
async function prepareArtwork(value: ReturnType<typeof useLocalLibraryWorkbench>, target = a) {
  await value.open({ action: 'artwork', albums: [target] })
  await value.lookupArtwork('local'); value.selectArtwork(artwork(target.albumId).candidateId); await value.previewArtwork()
}

test('工作台无发行也能读取候选；选择与预览不应用，只有明确保存派发一次', async t => {
  const applied: LocalWorkbenchApplyRequest[] = [], { value, commands } = model(ports({
    applyPlan: async request => { applied.push(request); return receipt(request, artworkPlan()) },
  })); t.after(() => value.dispose())
  await prepareArtwork(value)
  assert.equal(value.albums.value[0]?.editionId, undefined)
  assert.equal(value.plan.value?.kind, 'artwork'); assert.equal(applied.length, 0); assert.equal(commands(), 0)
  await value.applyPreview(); await value.applyPreview()
  assert.equal(applied.length, 1); assert.equal(commands(), 1)
  assert.equal(value.activeOperation.value?.state, 'succeeded')
})

test('工作台未接入能力明确不可用，不产生候选、建议或假成功', async t => {
  const { value, commands } = model({}); t.after(() => value.dispose())
  await value.open({ action: 'ai', albums: [a] }); await value.requestAiSuggestions(); await value.applyPreview()
  assert.match(value.error.value, /尚未接入/u); assert.equal(value.aiResults.value.length, 0)
  assert.equal(value.operations.value.length, 0); assert.equal(commands(), 0)
  assert.equal(value.backendOptions.value.find(item => item.id === 'cloud')?.availability.available, false)
  assert.ok(value.artworkSources.value.some(item => item.id === 'google-web' && !item.availability.available))
})

test('工作台取消批次后未开始项与当前项可见，迟到AI候选不覆盖原内容', async t => {
  const late = deferred<{ albumId: string; candidates: readonly LocalAiNameCandidate[] }>(), started = deferred<void>(), calls: string[] = []
  const { value } = model(ports({ suggestAlbumName: request => { calls.push(request.capture.albumId); started.resolve(); return late.promise } }))
  t.after(() => value.dispose()); await value.open({ action: 'ai', albums: [a, b] })
  const running = value.requestAiSuggestions(); await started.promise; value.cancelPreparation()
  late.resolve({ albumId: a.albumId, candidates: [suggestion()] }); await running
  assert.deepEqual(calls, [a.albumId]); assert.deepEqual(value.aiResults.value.map(item => item.state), ['cancelled', 'cancelled'])
  assert.equal(value.aiResults.value[0]?.candidates.length, 0)
  assert.equal(value.readback.value?.albums[0]?.album.title, a.title)
})

test('工作台AI失败逐项保留并继续下一项；候选必须明确选择后才能预览', async t => {
  const previews: string[][] = []
  const { value } = model(ports({
    suggestAlbumName: async request => {
      if (request.capture.albumId === a.albumId) throw new Error('合成模型失败')
      return { albumId: b.albumId, candidates: [suggestion(b.albumId)] }
    },
    previewAi: async request => { previews.push(request.selections.map(value => value.albumId)); return aiPlan([b]) },
  })); t.after(() => value.dispose())
  await value.open({ action: 'ai', albums: [a, b] }); await value.requestAiSuggestions()
  assert.deepEqual(value.aiResults.value.map(item => item.state), ['failed', 'ready'])
  await value.previewAi(); assert.equal(previews.length, 0); assert.match(value.error.value, /先选择/u)
  value.selectAiCandidate(b.albumId, suggestion(b.albumId).candidateId); await value.previewAi()
  assert.deepEqual(previews, [[b.albumId]]); assert.equal(value.plan.value?.kind, 'ai')
  assert.equal(value.operations.value.length, 0)
})

test('工作台拒绝没有理由/字段变化的模型返回，手工名称不能伪称AI候选', async t => {
  const { value } = model(ports({ suggestAlbumName: async () => ({ albumId: a.albumId, candidates: [{ ...suggestion(), reason: '', changes: [] }] }) }))
  t.after(() => value.dispose()); await value.open({ action: 'ai', albums: [a] }); await value.requestAiSuggestions()
  assert.equal(value.aiResults.value[0]?.state, 'failed'); assert.equal(value.aiResults.value[0]?.candidates.length, 0)
  assert.equal(value.plan.value, null); assert.equal(value.operations.value.length, 0)
})

test('工作台未知应用保留原请求，仅查原回执，不新签或再次confirm', async t => {
  const applies: LocalWorkbenchApplyRequest[] = [], reads: LocalWorkbenchApplyRequest[] = []
  const { value, commands } = model(ports({
    applyPlan: async request => { applies.push(request); throw new Error('合成响应丢失') },
    readOriginalReceipt: async request => { reads.push(request); return receipt(request, artworkPlan()) },
  })); t.after(() => value.dispose()); await prepareArtwork(value); await value.applyPreview()
  const original = structuredClone(value.operations.value[0]!.request)
  await value.applyPreview(); assert.equal(applies.length, 1); assert.equal(commands(), 1)
  await value.readOriginalReceipt()
  assert.deepEqual(reads, [original]); assert.equal(value.operations.value[0]?.state, 'succeeded')
  await value.applyPreview(); assert.equal(applies.length, 1); assert.equal(commands(), 1)
})

test('全新工作台冷开收取持久unknown与已完成单项，只查精确原回执，零apply与新UUID', async t => {
  const durable = recoveredOperation(), reads: LocalWorkbenchApplyRequest[] = []
  let applies = 0
  const { value, commands } = model(ports({
    readAlbums: async request => ({ ...readback(request.albums), pendingOperations: [structuredClone(durable)] }),
    applyPlan: async request => { applies++; return receipt(request, durable.plan) },
    readOriginalReceipt: async request => { reads.push(request); return receipt(request, durable.plan) },
  })); t.after(() => value.dispose())
  await value.open({ action: 'overview', albums: [b] })
  assert.equal(value.plan.value, null); assert.equal(value.resultOperation.value?.state, 'unknown')
  assert.deepEqual(value.resultItems(value.resultOperation.value!).map(item => item.state), ['applied', 'unknown'])
  assert.equal(value.mutationLocked.value, true); assert.equal(value.unresolvedOperations.value.length, 1)
  assert.deepEqual(value.operations.value[0]?.request, durable.request)
  assert.deepEqual(value.operations.value[0]?.plan, durable.plan)
  const component = rendererComponent(new URL('../src/renderer/src/components/library/local-workbench/LocalLibraryWorkbench.vue', import.meta.url))
  const html = await renderToString(createSSRApp(component, { model: value }))
  assert.match(html, /查询原回执/u); assert.match(html, /已应用/u); assert.match(html, /结果未确认/u)
  await value.applyPreview(); await value.readOriginalReceipt(durable.request.commandId); await value.applyPreview()
  assert.deepEqual(reads, [durable.request]); assert.equal(value.resultOperation.value?.state, 'succeeded')
  assert.equal(value.unresolvedOperations.value.length, 0); assert.equal(applies, 0); assert.equal(commands(), 0)
})

test('持久操作恢复不清内存unknown，错库/改写冻结计划/隐藏字段整项拒绝且原子保留', async t => {
  const durable = recoveredOperation()
  let response: LocalWorkbenchReadback = { ...readback([b]), pendingOperations: [durable] }
  const { value, commands } = model(ports({ readAlbums: async () => response })); t.after(() => value.dispose())
  await value.open({ action: 'overview', albums: [b] })
  response = readback([b]); await value.read()
  assert.deepEqual(value.operations.value, [durable])
  response = { ...readback([b]), pendingOperations: [] }; await value.read()
  assert.deepEqual(value.operations.value, [durable])
  const changedPlan = structuredClone(durable.plan)
  changedPlan.items = changedPlan.items.map(item => ({ ...item, label: item.label + '改写' }))
  if (changedPlan.kind === 'cue') changedPlan.tracks = changedPlan.tracks.map(item => ({ ...item, label: item.label + '改写' }))
  const changed: LocalWorkbenchOperation = { ...durable, receipt: null, plan: changedPlan }
  const extra = recoveredOperation(artworkPlan([b]), 'another-persisted-command')
  response = { ...readback([b]), snapshotId: 'changed-plan-snapshot', pendingOperations: [extra, changed] }
  await value.read()
  assert.match(value.error.value, /读取失败/u); assert.equal(value.readback.value?.snapshotId, 'snapshot-a')
  assert.deepEqual(value.operations.value, [durable])
  const crossDataset: LocalWorkbenchOperation = { ...durable, receipt: null,
    request: { ...durable.request, datasetId: 'dataset-b' }, plan: { ...durable.plan, datasetId: 'dataset-b' } }
  response = { ...readback([b]), snapshotId: 'wrong-dataset-snapshot', pendingOperations: [crossDataset] }
  await value.read(); assert.match(value.error.value, /读取失败/u); assert.deepEqual(value.operations.value, [durable])
  response = { ...readback([b]), snapshotId: 'hidden-snapshot', pendingOperations: [structuredClone(durable)] }
  Object.defineProperty(response.pendingOperations![0]!, 'grant', { value: '合成隐藏源权限', enumerable: false })
  await value.read(); assert.match(value.error.value, /读取失败/u); assert.deepEqual(value.operations.value, [durable])
  assert.equal(value.readback.value?.snapshotId, 'snapshot-a'); assert.equal(commands(), 0)
})

test('原回执终态先被确认后，旧持久unknown不能倒退；逐项迟到unknown保留已完成项', async t => {
  const durable = recoveredOperation(), earlier: LocalWorkbenchOperation = { ...durable, receipt: receipt(durable.request, durable.plan, 'unknown') }
  let response: LocalWorkbenchReadback = { ...readback([b]), pendingOperations: [durable] }
  const { value, commands } = model(ports({
    readAlbums: async () => response, readOriginalReceipt: async request => receipt(request, durable.plan),
  })); t.after(() => value.dispose()); await value.open({ action: 'overview', albums: [b] })
  response = { ...readback([b]), snapshotId: 'earlier-persisted-snapshot', pendingOperations: [earlier] }
  await value.read()
  assert.deepEqual(value.resultItems(value.operations.value[0]!).map(item => item.state), ['applied', 'unknown'])
  await value.readOriginalReceipt(durable.request.commandId)
  assert.equal(value.operations.value[0]?.state, 'succeeded')
  response = { ...readback([b]), snapshotId: 'late-unknown-snapshot', pendingOperations: [earlier] }
  await value.read()
  assert.equal(value.error.value, ''); assert.equal(value.operations.value[0]?.state, 'succeeded')
  assert.deepEqual(value.resultItems(value.operations.value[0]!).map(item => item.state), ['applied', 'applied'])
  assert.equal(value.unresolvedOperations.value.length, 0); assert.equal(commands(), 0)
})

test('工作台关闭后迟到应用回执只更新原命令，不覆盖新专辑读取上下文', async t => {
  const late = deferred<LocalWorkbenchReceipt>(), started = deferred<LocalWorkbenchApplyRequest>()
  const { value } = model(ports({ applyPlan: request => { started.resolve(request); return late.promise }, readOriginalReceipt: async request => receipt(request, artworkPlan()) }))
  t.after(() => value.dispose()); await prepareArtwork(value)
  const applying = value.applyPreview(), request = await started.promise
  assert.equal(value.close(), false); assert.equal(value.focusedAlbumId.value, a.albumId)
  await value.readOriginalReceipt(); value.close(); await value.open({ action: 'overview', albums: [b] })
  late.resolve(receipt(request, artworkPlan())); await applying
  assert.equal(value.focusedAlbumId.value, b.albumId); assert.equal(value.readback.value?.albums[0]?.album.albumId, b.albumId)
  assert.equal(value.operations.value[0]?.state, 'succeeded'); assert.equal(value.plan.value, null)
})

test('工作台查原回执先确认终态后，较早apply的迟到unknown不能使结果倒退', async t => {
  const late = deferred<LocalWorkbenchReceipt>(), started = deferred<LocalWorkbenchApplyRequest>()
  const { value } = model(ports({
    applyPlan: request => { started.resolve(request); return late.promise },
    readOriginalReceipt: async request => receipt(request, artworkPlan()),
  })); t.after(() => value.dispose()); await prepareArtwork(value)
  const applying = value.applyPreview(), request = await started.promise
  assert.equal(value.close(), false); await value.readOriginalReceipt()
  value.close(); await value.open({ action: 'overview', albums: [b] })
  late.resolve(receipt(request, artworkPlan(), 'unknown')); await applying
  assert.equal(value.operations.value[0]?.state, 'succeeded')
  assert.equal(value.unresolvedOperations.value.length, 0); assert.equal(value.focusedAlbumId.value, b.albumId)
})

test('工作台换专辑后丢弃旧封面读取和旧预览，取消选文件保留已保存封面', async t => {
  const late = deferred<readonly ReturnType<typeof artwork>[]>(), started = deferred<void>()
  const { value } = model(ports({
    findArtworkCandidates: () => { started.resolve(); return late.promise }, chooseArtworkFile: async () => null,
  })); t.after(() => value.dispose()); await value.open({ action: 'artwork', albums: [a] })
  const reading = value.lookupArtwork('local'); await started.promise
  await value.open({ action: 'artwork', albums: [b] }); late.resolve([artwork()]); await reading
  assert.equal(value.artworkCandidates.value.length, 0); assert.equal(value.focusedAlbumId.value, b.albumId)
  await value.lookupArtwork('file'); assert.equal(value.readback.value?.albums[0]?.currentArtwork?.label, '原合成封面')
  assert.match(value.notice.value, /已取消选图/u)
})

test('工作台CUE先预览实际轨序分段格式与目标，明确应用后保留逐轨部分失败', async t => {
  const calls: LocalWorkbenchApplyRequest[] = []
  const { value } = model(ports({
    applyPlan: async request => {
      calls.push(request)
      const result = receipt(request, cuePlan([a, b]), 'partial')
      return { ...result, items: result.items.map((item, index) => ({ ...item, state: index === 0 ? 'applied' : 'failed', message: index === 0 ? null : '合成目标故障，原文件保留。' })) }
    },
  })); t.after(() => value.dispose())
  await value.open({ action: 'cue', albums: [a, b] }); await value.chooseCueTarget(); await value.previewCue()
  assert.equal(calls.length, 0); assert.equal(value.plan.value?.scope, 'INDEPENDENT_OUTPUT')
  if (value.plan.value?.kind !== 'cue') assert.fail('未返回CUE计划')
  assert.equal(value.plan.value.sourceDisposition, 'retain'); assert.equal(value.plan.value.target.independent, true)
  assert.equal(value.plan.value.tracks[0]?.frameCount, 44_100); assert.equal(value.plan.value.tracks[0]?.outputFormat, 'flac')
  await value.applyPreview()
  assert.equal(calls.length, 1); assert.equal(value.activeOperation.value?.state, 'partial')
  assert.deepEqual(value.resultItems(value.operations.value[0]!).map(item => item.state), ['applied', 'failed'])
})

test('工作台拒绝CUE伪造源写scope或源删除意图，尚未应用', async t => {
  let applies = 0
  const bad = { ...cuePlan(), scope: 'SOURCE_FILES', sourceDisposition: 'delete' } as unknown as Extract<LocalWorkbenchPlan, { kind: 'cue' }>
  const { value } = model(ports({ previewCueSplit: async () => bad, applyPlan: async request => { applies++; return receipt(request, bad) } }))
  t.after(() => value.dispose()); await value.open({ action: 'cue', albums: [a] }); await value.chooseCueTarget(); await value.previewCue(); await value.applyPreview()
  assert.equal(value.plan.value, null); assert.equal(applies, 0); assert.match(value.error.value, /预览暂时无法确认/u)
})

test('工作台过期预览不生成应用command；错身份回执保持unknown', async t => {
  const expired = { ...artworkPlan(), expiresAt: '2000-01-01T00:00:00.000Z' }
  const first = model(ports({ previewArtwork: async () => expired, applyPlan: async request => receipt(request, expired) }))
  t.after(() => first.value.dispose()); await prepareArtwork(first.value); await first.value.applyPreview()
  assert.equal(first.commands(), 0); assert.match(first.value.error.value, /已过期/u)
  const second = model(ports({ applyPlan: async request => ({ ...receipt(request, artworkPlan()), commandId: 'other-command' }) }))
  t.after(() => second.value.dispose()); await prepareArtwork(second.value); await second.value.applyPreview()
  assert.equal(second.value.operations.value[0]?.state, 'unknown'); assert.equal(second.value.operations.value[0]?.receipt, null)
})

test('工作台原任务取消只签一次取消命令，未知取消不会再派发', async t => {
  const cancelled: string[] = []
  const { value, commands } = model(ports({
    applyPlan: async () => { throw new Error('合成原结果丢失') },
    cancelApplication: async request => { cancelled.push(request.cancelCommandId); throw new Error('合成取消结果丢失') },
  })); t.after(() => value.dispose()); await prepareArtwork(value); await value.applyPreview()
  await value.cancelApplication(value.operations.value[0]!.request.commandId)
  await value.cancelApplication(value.operations.value[0]!.request.commandId)
  assert.equal(cancelled.length, 1); assert.equal(commands(), 2); assert.equal(value.operations.value[0]?.state, 'unknown')
})

test('工作台部分完成仍含未确认项时保留逐项结果并锁住应用，只查询原命令', async t => {
  const reads: string[] = []
  const { value, commands } = model(ports({
    applyPlan: async request => ({ ...receipt(request, cuePlan([a, b]), 'partial'), items: [
      { itemId: 'item-' + a.albumId, albumId: a.albumId, label: a.title, state: 'applied', message: null },
      { itemId: 'item-' + b.albumId, albumId: b.albumId, label: b.title, state: 'unknown', message: '合成响应丢失。' },
    ] }),
    readOriginalReceipt: async request => { reads.push(request.commandId); return receipt(request, cuePlan([a, b])) },
  })); t.after(() => value.dispose())
  await value.open({ action: 'cue', albums: [a, b] }); await value.chooseCueTarget(); await value.previewCue(); await value.applyPreview()
  assert.equal(value.activeOperation.value?.state, 'unknown'); assert.equal(value.mutationLocked.value, true)
  assert.deepEqual(value.resultItems(value.operations.value[0]!).map(item => item.state), ['applied', 'unknown'])
  await value.applyPreview(); assert.equal(commands(), 1)
  value.close(); await value.open({ action: 'overview', albums: [b] }); await value.readOriginalReceipt()
  assert.deepEqual(reads, ['command-1']); assert.equal(value.resultOperation.value?.state, 'succeeded')
  assert.equal(value.resultItems(value.resultOperation.value!).length, 2)
})

test('工作台迟到取消失败和维护入口返回不覆盖或关闭新专辑上下文', async t => {
  const lateCancel = deferred<LocalWorkbenchReceipt>(), lateOpen = deferred<{ opened: true }>()
  const first = model(ports({ applyPlan: async () => { throw new Error('合成响应丢失') }, cancelApplication: () => lateCancel.promise, readOriginalReceipt: async request => receipt(request, artworkPlan(), 'cancelled') }))
  t.after(() => first.value.dispose()); await prepareArtwork(first.value); await first.value.applyPreview()
  const cancelling = first.value.cancelApplication(first.value.operations.value[0]!.request.commandId)
  assert.equal(first.value.close(), false); await first.value.readOriginalReceipt()
  await first.value.discardBeforeLeave(); first.value.close(); await first.value.open({ action: 'overview', albums: [b] })
  lateCancel.reject(new Error('合成迟到取消失败')); await cancelling
  assert.equal(first.value.readback.value?.albums[0]?.album.albumId, b.albumId); assert.equal(first.value.error.value, '')
  const second = model(ports({ existingActions: { finder: { available: true } }, openExistingAction: () => lateOpen.promise }))
  t.after(() => second.value.dispose()); await second.value.open({ action: 'overview', albums: [a] })
  const opening = second.value.openExisting('finder'); second.value.close(); await second.value.open({ action: 'overview', albums: [b] })
  lateOpen.resolve({ opened: true }); assert.equal(await opening, false)
  assert.equal(second.value.isOpen.value, true); assert.equal(second.value.focusedAlbumId.value, b.albumId)
})

test('工作台原图片与分轨格式完整列出资格，只有Main明确合格格式可进入预览', async t => {
  const imports: string[] = []
  const { value } = model(ports({
    artworkImportFormats: [{ mime: 'image/webp', label: 'WebP', availability: { available: true } }],
    importArtworkBytes: async request => { assert.ok('mime' in request); imports.push(request.mime); return artwork(request.capture.albumId) },
  })); t.after(() => value.dispose()); await value.open({ action: 'artwork', albums: [a] })
  assert.equal(value.cueFormats.value.length, 8); assert.equal(value.cueFormats.value.find(item => item.id === 'alac')?.availability.available, false)
  await value.lookupArtwork('drop', { bytes: new Uint8Array([1, 2, 3]), mime: 'image/tiff', label: '合成.tiff' })
  assert.deepEqual(imports, []); assert.match(value.error.value, /资格尚未接入/u)
  await value.lookupArtwork('drop', { bytes: new Uint8Array([1, 2, 3]), mime: 'image/webp', label: '合成.webp' })
  assert.deepEqual(imports, ['image/webp']); assert.equal(value.selectedArtworkId.value, null); assert.equal(value.plan.value, null)
})

test('工作台图片展示拒绝任意网络URL；声明不可用端口即使存在函数也不调用', async t => {
  assert.equal(isLocalWorkbenchPreviewUrl('https://example.invalid/private.jpg'), false)
  assert.equal(isLocalWorkbenchPreviewUrl(image), true)
  let called = 0
  const { value } = model(ports({
    capabilities: { 'artwork-local': { available: false, reason: '此来源已停用。' } },
    findArtworkCandidates: async () => { called++; return [artwork()] },
  })); t.after(() => value.dispose()); await value.open({ action: 'artwork', albums: [a] }); await value.lookupArtwork('local')
  assert.equal(called, 0); assert.match(value.error.value, /此来源已停用/u)
})

test('封面聚合保留各来源失败和预览失败，独立iTunes重试保留豆瓣结果与地区', async t => {
  const searches: { sourceId: string; country?: string }[] = []
  const { value } = model(ports({
    artworkSources: ['douban-itunes', 'douban', 'itunes'].map(id => ({ id, kind: id === 'douban-itunes' ? 'aggregate' : 'provider', label: id, availability: { available: true } })),
    searchArtworkCandidates: async request => {
      searches.push({ sourceId: request.sourceId, country: request.country })
      return { candidates: [artwork()], sources: request.sourceId === 'itunes' ? [{ source: 'itunes', country: request.country ?? 'US', status: 'ready', candidateCount: 1, previewFailureCount: 0, truncated: false, message: null }] : [
        { source: 'douban', country: null, status: 'failed', candidateCount: 0, previewFailureCount: 0, truncated: false, message: '合成来源失败' },
        { source: 'itunes', country: request.country ?? 'US', status: 'ready', candidateCount: 2, previewFailureCount: 1, truncated: true, message: '合成预览失败' },
      ] }
    },
  })); t.after(value.dispose); await value.open({ action: 'artwork', albums: [a] })
  await value.lookupArtwork('search', { sourceId: 'douban-itunes', query: '合成名称', country: 'JP' })
  assert.equal(value.artworkOutcomes.value[1]?.previewFailureCount, 1); await value.retryArtworkSource('itunes', 'JP')
  assert.deepEqual(searches, [{ sourceId: 'douban-itunes', country: 'JP' }, { sourceId: 'itunes', country: 'JP' }])
  assert.equal(value.artworkOutcomes.value.find(v => v.source === 'douban')?.status, 'failed'); assert.equal(value.artworkOutcomes.value.find(v => v.source === 'itunes')?.previewFailureCount, 0)
})

test('新专辑打开时丢弃旧来源结果，迟到旧search不能覆盖新album或制造空成功', async t => {
  const held = deferred<import('@music-bridge/contracts').LocalWorkbenchArtworkSearchReply>()
  const { value } = model(ports({ artworkSources: [{ id: 'itunes', label: 'iTunes', kind: 'provider', availability: { available: true } }], searchArtworkCandidates: () => held.promise })); t.after(value.dispose)
  await value.open({ action: 'artwork', albums: [a] }); const reading = value.lookupArtwork('search', { sourceId: 'itunes', query: '合成旧名称' })
  await value.open({ action: 'artwork', albums: [b] }); held.resolve({ candidates: [artwork()], sources: [{ source: 'itunes', country: 'US', status: 'ready', candidateCount: 1, previewFailureCount: 0, truncated: false, message: null }] }); await reading
  assert.equal(value.focusedAlbumId.value, b.albumId); assert.deepEqual(value.artworkOutcomes.value, []); assert.deepEqual(value.artworkCandidates.value, [])
})

test('真实工作台拖入HTTPS与粘贴data URI只发Main规范化合同，路径或凭据地址拒绝且没有保存', async t => {
  const imported: import('@music-bridge/contracts').LocalWorkbenchArtworkImportRequest[] = [], applied: unknown[] = []
  const { value } = model(ports({ importArtworkBytes: async request => { imported.push(structuredClone(request)); return artwork(request.capture.albumId) }, applyPlan: async request => { applied.push(request); return receipt(request, artworkPlan()) } })); t.after(value.dispose)
  await value.open({ action: 'artwork', albums: [a] })
  const host = await mountVueSfc(t, new URL('../src/renderer/src/components/library/local-workbench/LocalLibraryWorkbench.vue', import.meta.url).pathname, { model: value })
  const zone = host.all().find(node => node.props['aria-label'] === '拖入或粘贴封面')!
  await host.dispatch(zone, 'onDrop', { dataTransfer: { files: [], getData: (kind: string) => kind === 'text/uri-list' ? 'https://example.invalid/explicit-cover.png' : '' } })
  await host.dispatch(zone, 'onPaste', { clipboardData: { files: [], getData: (kind: string) => kind === 'text/plain' ? image : '' } })
  assert.deepEqual(imported.map(request => 'text' in request ? request.text : null), ['https://example.invalid/explicit-cover.png', image])
  for (const text of ['file:///synthetic/cover.png', 'https://synthetic:synthetic@example.invalid/cover.png']) await value.lookupArtwork('drop', { text, label: '合成非法地址' })
  assert.equal(imported.length, 2); assert.equal(applied.length, 0); assert.equal(value.selectedArtworkId.value, null)
})

/** 合成SSR直接消费正式组件；不开App、不挂载mounted、不联网、不写编译产物。 */
function rendererComponent(url: URL): Component {
  const { descriptor } = parse(readFileSync(url, 'utf8'), { filename: url.pathname })
  const script = compileScript(descriptor, { id: 'mbf-local-workbench', inlineTemplate: true })
  const output = ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } })
  const module = { exports: {} as Record<string, unknown> }, require = createRequire(import.meta.url)
  const dependencies = (name: string) => {
    // 合同包只有ESM入口；沿现有SFC host使用真实命名空间，不改生产exports或validator。
    if (name === '@music-bridge/contracts') return publicContracts
    if (name.endsWith('/SafeArtwork.vue')) return { __esModule: true, default: rendererComponent(new URL('../src/renderer/src/components/SafeArtwork.vue', import.meta.url)) }
    if (name.endsWith('/LocalAiReview.vue')) return { __esModule: true, default: rendererComponent(new URL('../src/renderer/src/components/library/local-workbench/LocalAiReview.vue', import.meta.url)) }
    if (name.endsWith('/LocalLyricsReview.vue')) return { __esModule: true, default: rendererComponent(new URL('../src/renderer/src/components/library/local-workbench/LocalLyricsReview.vue', import.meta.url)) }
    if (name.endsWith('/LocalLyricsBatchControl.vue')) return { __esModule: true, default: rendererComponent(new URL('../src/renderer/src/components/library/local-workbench/LocalLyricsBatchControl.vue', import.meta.url)) }
    if (name.endsWith('/LocalCueSplitReview.vue')) return { __esModule: true, default: rendererComponent(new URL('../src/renderer/src/components/library/local-workbench/LocalCueSplitReview.vue', import.meta.url)) }
    if (name.endsWith('/controller.js')) return { localWorkbenchExistingActionLabels, localWorkbenchFieldLabels, localWorkbenchResultLabels }
    return require(name)
  }
  new Function('require', 'module', 'exports', output.outputText)(dependencies, module, module.exports)
  return module.exports.default as Component
}

test('工作台实际模板展示AI候选理由、前后字段及明确保存；无手工AI替代表单', async t => {
  const { value } = model(ports()); t.after(() => value.dispose())
  await value.open({ action: 'ai', albums: [a] }); await value.requestAiSuggestions(); value.selectAiCandidate(a.albumId, suggestion().candidateId); await value.previewAi()
  const component = rendererComponent(new URL('../src/renderer/src/components/library/local-workbench/LocalLibraryWorkbench.vue', import.meta.url))
  const html = await renderToString(createSSRApp(component, { model: value }))
  assert.match(html, /名称智能解析/u); assert.match(html, /合成模型根据已读专辑与标签/u)
  assert.match(html, /合成专辑原名/u); assert.match(html, /合成专辑清洗后/u); assert.match(html, /明确保存到 MB/u)
  assert.doesNotMatch(html, /<textarea/u)
  assert.match(html, /aria-labelledby="local-workbench-title"/u)
})

import { useLocalWorkbenchLyrics, type LocalLyricsRendererApi } from '../src/renderer/src/composables/application/local-library-workbench/lyrics.js'
import { ref } from 'vue'
import type { LocalLyricsCommand, LocalLyricsCommandPayloads, LocalLyricsCommandResults, LocalLyricsSession } from '@music-bridge/contracts'

test('实际工作台局部撤销封面按钮保留歌词及AI候选和选择，回显原图且零apply', async t => {
  const lyricCandidate = { candidateId: 'lyrics-candidate-a', trackId: 'track-a', source: 'lrclib' as const, title: '合成歌曲', artist: '合成艺人', album: '合成专辑', durationMs: 90000, language: '中文', version: 'original' as const, score: 95 }
  const lyricScope = { datasetId: 'dataset-a', libraryId: 'root-a', albumId: a.albumId, captureId: 'capture-' + a.albumId }
  const lyricCalls: string[] = []
  const api: LocalLyricsRendererApi = { async localLibraryLyrics<C extends LocalLyricsCommand>(command: C, payload: LocalLyricsCommandPayloads[C]): Promise<LocalLyricsCommandResults[C]> {
    lyricCalls.push(command)
    const selected = command === 'localLyrics.select' && 'candidateId' in payload ? payload.candidateId : null
    const view: LocalLyricsSession = { sessionId: 'lyrics-session-a', scope: lyricScope, state: 'ready', candidates: [lyricCandidate], tracks: [{ trackId: lyricCandidate.trackId, title: lyricCandidate.title, presence: 'false', match: 'review', candidateIds: [lyricCandidate.candidateId], selectedCandidateId: selected, sources: [{ source: 'lrclib', state: 'ok' }] }] }
    return view as LocalLyricsCommandResults[C]
  } }
  const lyrics = useLocalWorkbenchLyrics({ api }); t.after(lyrics.dispose); lyrics.bind(lyricScope); await lyrics.query(); await lyrics.select(lyricCandidate.trackId, lyricCandidate.candidateId)
  let applies = 0
  const value = useLocalLibraryWorkbench({ ports: ports({ applyPlan: async request => { applies++; return receipt(request, artworkPlan()) } }), saveParticipants: [lyrics] }); t.after(value.dispose)
  await value.open({ action: 'ai', albums: [a] }); await value.requestAiSuggestions(); value.selectAiCandidate(a.albumId, suggestion().candidateId)
  value.setAction('artwork'); await value.lookupArtwork('local'); value.selectArtwork(artwork().candidateId); value.toggleComparison(artwork().candidateId); await value.previewArtwork()
  const beforeAi = structuredClone(value.aiResults.value), beforeLyrics = structuredClone(lyrics.session.value), beforeRead = structuredClone(value.readback.value)
  const host = await mountVueSfc(t, new URL('../src/renderer/src/components/library/local-workbench/LocalLibraryWorkbench.vue', import.meta.url).pathname, { model: value, lyrics })
  const undo = host.all().find(node => node.type === 'button' && host.text(node) === '撤销待保存封面')
  assert.ok(undo); assert.equal(!!undo.props.disabled, false); await host.dispatch(undo, 'onClick')
  assert.equal(value.selectedArtworkId.value, null); assert.equal(value.plan.value, null); assert.deepEqual(value.comparisonIds.value, [])
  assert.deepEqual(value.aiResults.value, beforeAi); assert.deepEqual(lyrics.session.value, beforeLyrics); assert.equal(lyrics.selectedCount.value, 1)
  assert.deepEqual(value.readback.value, beforeRead); assert.match(host.text(), /原合成封面/u)
  assert.equal(applies, 0); assert.deepEqual(lyricCalls, ['localLyrics.query', 'localLyrics.select'])
  assert.equal(value.hasPendingChanges.value, true); assert.equal(value.close(), false)
})

test('局部封面撤销在真实保存参与者锁定或已派发failed unknown时均拒绝，原选择与回执保留', async t => {
  for (const blocked of ['writer', 'failed', 'unknown'] as const) {
    const writer = ref(false)
    const value = useLocalLibraryWorkbench({ ports: ports({ applyPlan: async request => blocked === 'unknown'
      ? receipt(request, artworkPlan(), 'unknown')
      : { ...receipt(request, artworkPlan(), 'failed'), items: artworkPlan().items.map(item => ({ itemId: item.itemId, albumId: item.albumId, label: item.label, state: 'failed' as const, message: '合成明确失败' })) } }),
      saveParticipants: [{ pending: writer, locked: writer, save: async () => false, discard: () => false }] })
    t.after(value.dispose); await prepareArtwork(value)
    if (blocked === 'writer') writer.value = true
    else await value.applyPreview()
    const before = structuredClone(value.operations.value)
    const host = await mountVueSfc(t, new URL('../src/renderer/src/components/library/local-workbench/LocalLibraryWorkbench.vue', import.meta.url).pathname, { model: value })
    const undo = host.all().find(node => node.type === 'button' && host.text(node) === '撤销待保存封面')
    assert.ok(undo); assert.equal(!!undo.props.disabled, true); await host.dispatch(undo, 'onClick')
    assert.equal(value.selectedArtworkId.value, artwork().candidateId); assert.deepEqual(value.operations.value, before)
    assert.equal(value.plan.value?.kind, 'artwork'); assert.equal(value.hasPendingChanges.value, true)
  }
})


import { useLocalWorkbenchLibrary, type LocalLibraryWorkspaceApi } from '../src/renderer/src/composables/application/local-library-workbench/library.js'
import type { LocalWorkbenchLyricsResultKey, LocalWorkbenchLibraryResultKey } from '../src/renderer/src/composables/application/local-library-workbench/types.js'
import type { LocalLyricsJobSnapshot, LocalLyricsScope, LocalLibraryManagementMainCommand as LocalLibraryManagementCommand, LocalLibraryManagementMainPayloads as LocalLibraryManagementPayloads, LocalLibraryManagementMainResults as LocalLibraryManagementResults, LocalLibraryBatchPage, LocalNameSettingsCommand, LocalNameSettingsPayloads, LocalNameSettingsResults } from '@music-bridge/contracts'
const stageFourUiLibrary = { datasetId: 'dataset-a', libraryId: 'library-a', captureId: 'original-library-capture' }
const stageFourUiScope: LocalLyricsScope = { ...stageFourUiLibrary, albumId: 'album-current', captureId: 'original-current-album-capture' }
const stageFourUiCandidates = [
  { candidateId: 'metadata-zero', trackId: 'metadata-track', source: 'lrclib' as const, title: '候选自身曲目', artist: '候选自身艺术家', album: '候选自身发行名', durationMs: 0, language: '中文', version: 'original' as const, score: 90 },
  { candidateId: 'metadata-null', trackId: 'metadata-track', source: 'qq' as const, title: '无来源专辑候选', artist: '', album: '', durationMs: null, language: '', version: 'unknown' as const, score: 20 },
]
const stageFourUiSession = (): LocalLyricsSession => ({ sessionId: 'current-lyrics-session', scope: stageFourUiScope, state: 'ready', candidates: structuredClone(stageFourUiCandidates),
  tracks: [{ trackId: 'metadata-track', title: '当前音乐文件曲目', presence: 'false', match: 'review', candidateIds: stageFourUiCandidates.map(row => row.candidateId), selectedCandidateId: null, sources: [{ source: 'lrclib', state: 'ok' }, { source: 'qq', state: 'ok' }] }] })
const stageFourUiJob = (jobId = 'result-lyrics-job', unknown = true, revision = 8): LocalLyricsJobSnapshot => ({ jobId, library: { ...stageFourUiLibrary }, state: unknown ? 'unknown' : 'stopped',
  totalAlbums: 3, processedAlbums: 3, savedAlbums: 0, reviewAlbumIds: ['review-unmapped'], failedAlbumIds: ['failed-unmapped'], unknownAlbumIds: unknown ? ['unknown-unmapped'] : [], sidecars: 0, embedded: 0, inspectionFailures: 0, revision })
function stageFourUiLyrics(run?: (command: LocalLyricsCommand, payload: LocalLyricsCommandPayloads[LocalLyricsCommand]) => Promise<unknown>, makeCommandId = () => 'result-lyrics-job') {
  const calls: { command: string; payload: unknown }[] = []
  const api: LocalLyricsRendererApi = { async localLibraryLyrics<C extends LocalLyricsCommand>(command: C, payload: LocalLyricsCommandPayloads[C]): Promise<LocalLyricsCommandResults[C]> {
    calls.push({ command, payload: structuredClone(payload) })
    if (run) return await run(command, payload) as LocalLyricsCommandResults[C]
    const v = command === 'localLyrics.detail' ? { candidate: stageFourUiCandidates.find(row => row.candidateId === (payload as LocalLyricsCommandPayloads['localLyrics.detail']).candidateId)!, body: '[00:00.00]候选原正文' }
      : command === 'localLyrics.job.start' ? stageFourUiJob() : stageFourUiSession()
    return v as LocalLyricsCommandResults[C]
  } }
  return { model: useLocalWorkbenchLyrics({ api, makeCommandId }), calls }
}
async function stageFourUiWorkspace(kind: 'ai' | 'cue', unknown = true) {
  const jobId = 'original-' + kind + '-job', captureId = 'original-' + kind + '-capture', calls: { command: string; payload: unknown }[] = []
  const page: LocalLibraryBatchPage = { jobId, captureId, kind, state: unknown ? 'unknown' : 'partial', totalAlbums: 2, processedAlbums: 2, succeededAlbums: 0, failedAlbums: 1, offset: 0,
    items: [{ albumId: kind + '-failed-album', state: 'failed', message: '合成原失败说明' }, { albumId: kind + '-unknown-album', state: 'unknown', message: '合成原结果未确认' }] }
  const api: LocalLibraryWorkspaceApi = {
    async localLibraryManagement<C extends LocalLibraryManagementCommand>(command: C, payload: LocalLibraryManagementPayloads[C]): Promise<LocalLibraryManagementResults[C]> {
      if (command === 'library.import.cancel') throw new Error('此原批次组件未prepare目录，不能借job回包冒取消闭口')
      calls.push({ command, payload: structuredClone(payload) }); let value: unknown = page
      if (command === 'library.read') value = { datasetId: 'dataset-a', revision: '1', scanConcurrency: 12, libraries: [{ libraryId: 'library-a', label: '原明确音乐库', role: 'catalog', online: true, watching: false, latestSnapshotId: 'snapshot-a', totalAlbums: 2, totalTracks: 2, scanState: 'complete' }] }
      if (command === 'library.capture') value = { datasetId: 'dataset-a', captureId, libraryIds: ['library-a'], revision: '1', lyricsLibraries: [] }
      return value as LocalLibraryManagementResults[C]
    },
    async localNameSettings<C extends LocalNameSettingsCommand>(_command: C, _payload: LocalNameSettingsPayloads[C]): Promise<LocalNameSettingsResults[C]> { throw new Error('此场景不修改模型设置') },
  }
  const workspace = useLocalWorkbenchLibrary({ api, makeCommandId: () => jobId }); await workspace.read()
  if (kind === 'ai') await workspace.startAi('ollama')
  else await workspace.startAllCue('flac', { choiceId: 'original-independent-output', label: '原独立输出', independent: true })
  return { workspace, calls, page }
}
function stageFourInspectionButton(host: Awaited<ReturnType<typeof mountVueSfc>>, albumId: string) {
  const rows = host.all().filter(node => (node.type === 'li' || node.type === 'tr' || node.type === 'article') && host.text(node).includes(albumId)).sort((x, y) => host.text(x).length - host.text(y).length)
  for (const row of rows) {
    const button = host.all(row).find(node => node.type === 'button' && /核对|查看|检查/u.test(host.text(node) + String(node.props['aria-label'] ?? '')))
    if (button) return button
  }
  return undefined
}

test('真实歌词候选行和正文显示来源自身artist/album/0秒，空album与null不借当前专辑', async t => {
  const { model: lyrics, calls } = stageFourUiLyrics(); t.after(lyrics.dispose); lyrics.bind(stageFourUiScope, stageFourUiLibrary); await lyrics.query()
  const host = await mountVueSfc(t, new URL('../src/renderer/src/components/library/local-workbench/LocalLyricsReview.vue', import.meta.url).pathname, { model: lyrics })
  const zero = host.all().find(node => node.type === 'label' && host.text(node).includes('候选自身曲目')); assert.ok(zero)
  assert.match(host.text(zero), /候选自身艺术家/u); assert.match(host.text(zero), /候选自身发行名/u); assert.match(host.text(zero), /0 秒/u)
  const empty = host.all().find(node => node.type === 'label' && host.text(node).includes('无来源专辑候选')); assert.ok(empty)
  assert.doesNotMatch(host.text(empty), /候选自身发行名|当前音乐文件|0 秒|null|undefined/u)
  const previews = host.all().filter(node => node.type === 'button' && host.text(node) === '预览正文'); assert.equal(previews.length, 2)
  await host.dispatch(previews[0], 'onClick')
  let detail = host.all().find(node => node.props['aria-label'] === '歌词正文预览'); assert.ok(detail); assert.match(host.text(detail), /候选自身艺术家/u); assert.match(host.text(detail), /候选自身发行名/u); assert.match(host.text(detail), /0 秒/u)
  await host.dispatch(previews[1], 'onClick'); detail = host.all().find(node => node.props['aria-label'] === '歌词正文预览'); assert.ok(detail)
  assert.doesNotMatch(host.text(detail), /候选自身发行名|候选自身艺术家|0 秒|null|undefined/u)
  assert.deepEqual(calls.map(row => row.command), ['localLyrics.query', 'localLyrics.detail', 'localLyrics.detail']); assert.equal(lyrics.selectedCount.value, 0)
})

test('真实歌词三数组逐行发完整原key，Workbench父转发不调用新query或改当前pending', async t => {
  const f = stageFourUiLyrics(); t.after(f.model.dispose); f.model.bind(null, stageFourUiLibrary); await f.model.startBatch()
  const { value } = model(ports()); t.after(value.dispose); await value.open({ action: 'overview', albums: [a] }); value.setAction('library')
  const emitted: LocalWorkbenchLyricsResultKey[] = []
  const host = await mountVueSfc(t, new URL('../src/renderer/src/components/library/local-workbench/LocalLibraryWorkbench.vue', import.meta.url).pathname, { model: value, lyrics: f.model,
    onInspectLyricsResult: (key: LocalWorkbenchLyricsResultKey) => emitted.push(structuredClone(key)) })
  const before = structuredClone({ current: f.model.session.value, original: f.model.originalJob.value, job: f.model.job.value, pending: f.model.pending.value, workbench: value.readback.value, phase: value.phase.value }), calls = f.calls.length
  for (const category of ['review', 'failed', 'unknown'] as const) {
    const albumId = category + '-unmapped', button = stageFourInspectionButton(host, albumId); assert.ok(button, '缺少' + category + '原专辑逐项核对入口')
    assert.equal(!!button.props.disabled, false); await host.dispatch(button, 'onClick')
    assert.deepEqual(emitted.at(-1), { jobId: 'result-lyrics-job', jobRevision: 8, library: stageFourUiLibrary, albumId, category })
  }
  assert.equal(emitted.length, 3); assert.equal(f.calls.length, calls)
  assert.deepEqual({ current: f.model.session.value, original: f.model.originalJob.value, job: f.model.job.value, pending: f.model.pending.value, workbench: value.readback.value, phase: value.phase.value }, before)
  const unknownRows = host.all().filter(node => (node.type === 'li' || node.type === 'tr') && host.text(node).includes('unknown-unmapped')).sort((x, y) => host.text(x).length - host.text(y).length)
  assert.ok(unknownRows.length); assert.doesNotMatch(host.text(unknownRows[0]), /已保存/u)
})

test('真实历史歌词结果使用历史原id/revision而非当前任务，检查不接管新job', async t => {
  let ids = 0
  const f = stageFourUiLyrics(async (command, payload) => command === 'localLyrics.job.start'
    ? stageFourUiJob((payload as LocalLyricsCommandPayloads['localLyrics.job.start']).commandId, ids > 1, ids === 1 ? 2 : 9)
    : stageFourUiJob('history-job-1', false, 3), () => 'history-job-' + ++ids)
  t.after(f.model.dispose); f.model.bind(null, stageFourUiLibrary); await f.model.startBatch(); assert.equal(await f.model.discard(), true); f.model.newBatch(); await f.model.startBatch()
  const seen: LocalWorkbenchLyricsResultKey[] = []
  const host = await mountVueSfc(t, new URL('../src/renderer/src/components/library/local-workbench/LocalLyricsBatchControl.vue', import.meta.url).pathname, { model: f.model,
    onInspect: (key: LocalWorkbenchLyricsResultKey) => seen.push(structuredClone(key)) })
  const history = host.all().find(node => node.props['aria-label'] === '已结束的原歌词批次'); assert.ok(history)
  const before = structuredClone(f.model.originalJob.value), calls = f.calls.length
  const rows = host.all(history).filter(node => (node.type === 'li' || node.type === 'tr') && host.text(node).includes('review-unmapped')).sort((x, y) => host.text(x).length - host.text(y).length)
  const button = rows.flatMap(row => host.all(row)).find(node => node.type === 'button' && /核对|查看|检查/u.test(host.text(node))); assert.ok(button, '历史review集合应有原结果入口')
  await host.dispatch(button, 'onClick')
  assert.deepEqual(seen[0], { jobId: 'history-job-1', jobRevision: 3, library: stageFourUiLibrary, albumId: 'review-unmapped', category: 'review' })
  assert.deepEqual(f.model.originalJob.value, before); assert.equal(f.model.job.value?.jobId, 'history-job-2'); assert.equal(f.calls.length, calls)
})

test('真实AI及CUE原行发送完整原job/capture/kind key，检查关闭零写且保原输出', async t => {
  for (const kind of ['ai', 'cue'] as const) {
    const f = await stageFourUiWorkspace(kind); t.after(f.workspace.dispose); const { value } = model(ports()); t.after(value.dispose)
    await value.open({ action: 'overview', albums: [a] }); const seen: LocalWorkbenchLibraryResultKey[] = []; let closed = 0
    const key: LocalWorkbenchLibraryResultKey = { jobId: f.page.jobId, captureId: f.page.captureId, kind, albumId: kind + '-unknown-album' }
    const host = await mountVueSfc(t, new URL('../src/renderer/src/components/library/local-workbench/LocalLibraryWorkbench.vue', import.meta.url).pathname, { model: value, workspace: f.workspace,
      libraryInspection: { key, phase: 'loading', album: null, trackPage: null, capture: null, error: null },
      onInspectLibraryResult: (v: LocalWorkbenchLibraryResultKey) => seen.push(structuredClone(v)), onCloseLibraryInspection: () => closed++ })
    const original = structuredClone(f.workspace.originalJob.value), calls = f.calls.length, button = stageFourInspectionButton(host, key.albumId); assert.ok(button, '缺少原' + kind + '逐项入口')
    await host.dispatch(button, 'onClick'); assert.deepEqual(seen, [key]); assert.equal(f.calls.length, calls); assert.deepEqual(f.workspace.originalJob.value, original)
    const close = host.all().find(node => node.type === 'button' && /关闭/u.test(host.text(node) + String(node.props['aria-label'] ?? '')) && /核对|检查/u.test(host.text(node) + String(node.props['aria-label'] ?? '')))
    assert.ok(close, '独立原条目盘点应可关闭'); await host.dispatch(close, 'onClick'); assert.equal(closed, 1); assert.equal(f.calls.length, calls)
    assert.equal(f.workspace.pending.value, true); assert.deepEqual(f.workspace.originalJob.value, original)
  }
})

test('inspection陈旧library key不能显示另一任务的专辑事实，原items仍保留可核对', async t => {
  const f = await stageFourUiWorkspace('ai'); t.after(f.workspace.dispose); const { value } = model(ports()); t.after(value.dispose); await value.open({ action: 'overview', albums: [a] })
  const wrong = { jobId: 'different-job', captureId: 'different-capture', kind: 'ai', albumId: 'other-album' }
  const host = await mountVueSfc(t, new URL('../src/renderer/src/components/library/local-workbench/LocalLibraryWorkbench.vue', import.meta.url).pathname, { model: value, workspace: f.workspace,
    libraryInspection: { key: wrong, phase: 'ready', album: { title: '不能借显示的别的原专辑', artist: '不能借显示的别的原艺术家' }, trackPage: null, capture: null, error: null } })
  assert.doesNotMatch(host.text(), /不能借显示的别的原专辑|不能借显示的别的原艺术家/u)
  assert.ok(stageFourInspectionButton(host, 'ai-unknown-album')); assert.deepEqual(f.workspace.originalJob.value?.payload.commandId, 'original-ai-job')
})


/** 页面导航应只展示该页面的操作，其他功能仍在其原入口中。 */
test('歌词和整库页面不混入源文件维护面板，维护导航仍保完整原入口', async t => {
  const f = stageFourUiLyrics(); t.after(f.model.dispose); f.model.bind(stageFourUiScope, stageFourUiLibrary)
  const { value } = model(ports()); t.after(value.dispose); await value.open({ action: 'overview', albums: [a] })
  const host = await mountVueSfc(t, new URL('../src/renderer/src/components/library/local-workbench/LocalLibraryWorkbench.vue', import.meta.url).pathname, { model: value, lyrics: f.model })
  for (const pane of ['lyrics', 'library'] as const) {
    value.setAction(pane); await host.settle()
    assert.equal(host.all().some(node => node.props['aria-label'] === '已有信息与源文件维护'), false, pane + '页不应混入另一页源文件维护网格')
    assert.ok(host.all().some(node => node.props['aria-label'] === (pane === 'lyrics' ? '专辑歌词工作台' : '完整音乐库工作台')))
  }
  value.setAction('organize'); await host.settle()
  assert.ok(host.all().some(node => node.props['aria-label'] === '已有信息与源文件维护')); assert.equal(f.calls.length, 0)
})

function installQueryClipboard462(t:import('node:test').TestContext,writeText:(text:string)=>Promise<void>){
  const previous=Object.getOwnPropertyDescriptor(globalThis,'navigator');Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText}}});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'navigator',previous);else delete (globalThis as {navigator?:unknown}).navigator;});
}
const nameQueryFile462=new URL('../src/renderer/src/components/library/local-workbench/LocalLibraryWorkbench.vue',import.meta.url).pathname;
test('名称查询462：原始清洗与明确所选AI组合可编辑复制，未选建议和查询不改变原字段或派发保存',async t=>{
  const copies:string[]=[];installQueryClipboard462(t,async query=>{copies.push(query);});
  const {value,commands}=model(ports({readAlbums:async request=>{const result=readback(request.albums);for(const row of result.albums)row.searchNames={original:{artist:'原作者 [FLAC]',title:'原专辑 [FLAC]'},cleaned:{artist:'原作者',title:'原专辑'}};return result;}}));t.after(value.dispose);await value.open({action:'artwork',albums:[a,b]});
  const before=structuredClone(value.readback.value),host=await mountVueSfc(t,nameQueryFile462,{model:value}),input=()=>host.all().find(node=>node.props['aria-label']==='封面搜索词')!,button=(label:string)=>host.all().find(node=>node.type==='button'&&host.text(node)===label);
  assert.match(host.text(),/原始名称：原作者 \[FLAC\] 原专辑 \[FLAC\]/u);assert.match(host.text(),/清洗名称：原作者 原专辑/u);
  (input().props['onUpdate:modelValue'] as (query:string)=>void)('用户手动词');await host.settle();await host.dispatch(button('将原始名称加入搜索词'),'onClick');await host.dispatch(button('将清洗名称加入搜索词'),'onClick');
  const combined='用户手动词 原作者 [FLAC] 原专辑 [FLAC] 原作者 原专辑';assert.equal(input().value,combined);
  await value.requestAiSuggestions();await host.settle();assert.equal(button('将明确选择的AI名称加入搜索词'),undefined);assert.equal(input().value,combined);
  value.selectAiCandidate(a.albumId,suggestion(a.albumId).candidateId);await host.settle();assert.match(host.text(),/已选择的 AI 名称：合成艺人 合成专辑清洗后/u);
  await host.dispatch(button('将明确选择的AI名称加入搜索词'),'onClick');const expected=combined+' 合成艺人 合成专辑清洗后';assert.equal(input().value,expected);
  await host.dispatch(button('复制当前搜索词'),'onClick');assert.deepEqual(copies,[expected]);assert.match(host.text(),/搜索词已复制/u);assert.deepEqual(value.readback.value,before);assert.equal(commands(),0);assert.equal(value.plan.value,null);assert.equal(value.operations.value.length,0);
  t.diagnostic('真实Vue处理器与受控clipboard Promise；未触碰系统剪贴板或执行真实平台、源写、保存。');
});
test('名称查询462：复制拒绝保编辑词与明确失败，越界组合不覆盖，切专辑后迟到复制结果不串入新页面',async t=>{
  const held=deferred<void>(),calls:string[]=[];let reject=true;installQueryClipboard462(t,async query=>{calls.push(query);if(reject)throw new Error('受控剪贴板权限拒绝');return held.promise;});
  const {value,commands}=model(ports({readAlbums:async request=>{const result=readback(request.albums);for(const row of result.albums)row.searchNames={original:{artist:'原作者',title:'原专辑'},cleaned:{artist:'原作者',title:'原专辑'}};return result;}}));t.after(value.dispose);await value.open({action:'artwork',albums:[a,b]});
  const host=await mountVueSfc(t,nameQueryFile462,{model:value}),input=()=>host.all().find(node=>node.props['aria-label']==='封面搜索词')!,button=(label:string)=>host.all().find(node=>node.type==='button'&&host.text(node)===label);
  const edit=async(query:string)=>{(input().props['onUpdate:modelValue'] as (query:string)=>void)(query);await host.settle();};
  await edit(' 用户编辑的查询 ');await host.dispatch(button('复制当前搜索词'),'onClick');assert.deepEqual(calls,['用户编辑的查询']);assert.equal(input().value,' 用户编辑的查询 ');assert.match(host.text(),/复制未完成，搜索词保留/u);assert.doesNotMatch(host.text(),/搜索词已复制/u);
  await edit('词'.repeat(256));await host.dispatch(button('将原始名称加入搜索词'),'onClick');assert.equal(input().value,'词'.repeat(256));assert.match(host.text(),/组合超过 256 字/u);
  await edit('原专辑的待复制词');reject=false;await host.dispatch(button('复制当前搜索词'),'onClick');value.focusAlbum(b.albumId);await host.settle();const next=input().value;held.resolve();await host.settle();assert.equal(input().value,next);assert.equal(next,b.artist+' '+b.title);assert.doesNotMatch(host.text(),/搜索词已复制|复制未完成/u);assert.equal(commands(),0);assert.equal(value.operations.value.length,0);
});

// 直接派发正式SFC事件，Main端口为受控合同夹具；不证明Main抓图、解码、账号或原生拖放。
test('封面拖入：File字节不可用时只复用同次已快照的HTTPS或data URI，原候选仍需明确选择', async t => {
  const imported: import('@music-bridge/contracts').LocalWorkbenchArtworkImportRequest[] = [], applied: unknown[] = []
  const { value } = model(ports({ importArtworkBytes: async request => { imported.push(structuredClone(request)); return { ...artwork(request.capture.albumId), candidateId: 'fallback-candidate-' + imported.length } }, applyPlan: async request => { applied.push(request); return receipt(request, artworkPlan()) } })); t.after(value.dispose)
  await value.open({ action: 'artwork', albums: [a] })
  const host = await mountVueSfc(t, new URL('../src/renderer/src/components/library/local-workbench/LocalLibraryWorkbench.vue', import.meta.url).pathname, { model: value })
  for (const kind of ['missing-mime', 'zero-size', 'read-rejection', 'empty-bytes'] as const) {
    await value.open({ action: 'artwork', albums: [a] })
    const file = new File(kind === 'zero-size' ? [] : [new Uint8Array([1])], '同次合成图片.jpg', { type: kind === 'missing-mime' ? '' : 'image/jpeg' })
    let reading = false
    if (kind === 'read-rejection' || kind === 'empty-bytes') Object.defineProperty(file, 'arrayBuffer', { value: () => { reading = true; return kind === 'read-rejection' ? Promise.reject(new Error('受控File读取失败')) : Promise.resolve(new ArrayBuffer(0)) } })
    const text = kind === 'missing-mime' ? image : 'https://example.invalid/same-transfer-' + kind + '.jpg', readKinds: string[] = []
    const transfer = { files: [file], getData(format: string) { readKinds.push(format); if (reading) return ''; return kind === 'missing-mime' ? format === 'text/uri-list' ? 'file:///synthetic/unavailable.jpg' : text : format === 'text/uri-list' ? '# 同次图片\n' + text : '' } }
    const before = imported.length, zone = host.all().find(node => node.props['aria-label'] === '拖入或粘贴封面')!
    await host.dispatch(zone, kind === 'zero-size' ? 'onPaste' : 'onDrop', kind === 'zero-size' ? { clipboardData: transfer } : { dataTransfer: transfer })
    assert.equal(imported.length, before + 1, '一个原transfer只能产生一次Main导入')
    const original = imported[before]!
    assert.ok('text' in original); assert.equal(original.text, text); assert.equal(original.datasetId, value.readback.value!.datasetId); assert.deepEqual(original.capture, value.focusedAlbum.value!.capture)
    assert.deepEqual(readKinds, ['text/uri-list', 'text/plain'], '两个文本必须在File await前各读取一次，不能借后续drag或clipboard')
    assert.equal(value.selectedArtworkId.value, null); assert.equal(value.plan.value, null); assert.equal(applied.length, 0)
    assert.match(value.notice.value, /候选已读取/u)
  }
})

test('封面拖入：合法File bytes始终优先，Main原导入拒绝不改走同次URL或自动保存', async t => {
  const imported: import('@music-bridge/contracts').LocalWorkbenchArtworkImportRequest[] = [], applied: unknown[] = []
  const { value } = model(ports({ importArtworkBytes: async request => { imported.push(structuredClone(request)); throw new Error('受控Main原导入拒绝') }, applyPlan: async request => { applied.push(request); return receipt(request, artworkPlan()) } })); t.after(value.dispose)
  await value.open({ action: 'artwork', albums: [a] }); await value.lookupArtwork('local'); value.selectArtwork(artwork().candidateId)
  const originalCandidates = value.artworkCandidates.value, selected = value.selectedArtworkId.value
  const host = await mountVueSfc(t, new URL('../src/renderer/src/components/library/local-workbench/LocalLibraryWorkbench.vue', import.meta.url).pathname, { model: value }), zone = host.all().find(node => node.props['aria-label'] === '拖入或粘贴封面')!
  const file = new File([new Uint8Array([1, 2, 3])], '合成正常图片.jpg', { type: 'image/jpeg' })
  await host.dispatch(zone, 'onDrop', { dataTransfer: { files: [file], getData: () => 'https://example.invalid/not-a-second-import.jpg' } })
  assert.equal(imported.length, 1); assert.ok('bytes' in imported[0]!); assert.deepEqual(imported[0]!.bytes, new Uint8Array([1, 2, 3])); assert.equal(imported[0]!.mime, 'image/jpeg')
  assert.deepEqual(value.artworkCandidates.value, originalCandidates); assert.equal(value.selectedArtworkId.value, selected); assert.equal(applied.length, 0); assert.equal(value.plan.value, null)
  assert.match(value.error.value, /拒绝|候选读取失败/u)
})

test('封面拖入：文件及同次备用来源失败保留候选，路径凭据和多地址零派写且远程失败不重试另一地址', async t => {
  const imported: import('@music-bridge/contracts').LocalWorkbenchArtworkImportRequest[] = [], applied: unknown[] = []
  const { value } = model(ports({ importArtworkBytes: async request => { imported.push(structuredClone(request)); throw new Error('受控同次远程读取失败') }, applyPlan: async request => { applied.push(request); return receipt(request, artworkPlan()) } })); t.after(value.dispose)
  await value.open({ action: 'artwork', albums: [a] }); await value.lookupArtwork('local'); value.selectArtwork(artwork().candidateId)
  const originalCandidates = value.artworkCandidates.value, selected = value.selectedArtworkId.value
  const host = await mountVueSfc(t, new URL('../src/renderer/src/components/library/local-workbench/LocalLibraryWorkbench.vue', import.meta.url).pathname, { model: value })
  const invalid = [
    ['https://synthetic:synthetic@example.invalid/rejected.jpg', 'file:///synthetic/rejected.jpg'],
    ['https://example.invalid/one.jpg\nhttps://example.invalid/two.jpg', ''],
  ]
  for (const [uri, plain] of invalid) {
    const file = new File([new Uint8Array([1])], '合成读取失败.jpg', { type: 'image/jpeg' }); Object.defineProperty(file, 'arrayBuffer', { value: () => Promise.reject(new Error('受控File读取失败')) })
    const zone = host.all().find(node => node.props['aria-label'] === '拖入或粘贴封面')!
    await host.dispatch(zone, 'onDrop', { dataTransfer: { files: [file], getData: (format: string) => format === 'text/uri-list' ? uri : plain } })
    assert.equal(imported.length, 0); assert.match(host.text(), /拖入图片读取失败/u)
  }
  const file = new File([new Uint8Array([1])], '合成读取失败.jpg', { type: 'image/jpeg' }); Object.defineProperty(file, 'arrayBuffer', { value: () => Promise.reject(new Error('受控File读取失败')) })
  await host.dispatch(host.all().find(node => node.props['aria-label'] === '拖入或粘贴封面')!, 'onDrop', { dataTransfer: { files: [file], getData: (format: string) => format === 'text/uri-list' ? 'https://example.invalid/first-only.jpg' : 'https://example.invalid/not-retried.jpg' } })
  assert.equal(imported.length, 1); assert.ok('text' in imported[0]!); assert.equal(imported[0]!.text, 'https://example.invalid/first-only.jpg')
  assert.deepEqual(value.artworkCandidates.value, originalCandidates); assert.equal(value.selectedArtworkId.value, selected); assert.equal(applied.length, 0); assert.equal(value.plan.value, null)
  assert.match(value.error.value, /读取失败/u)
})

test('封面拖入：关闭重开同专辑及dataset捕获页签焦点ABA均丢弃迟到File和原文本，不换新capture派写', async t => {
  const imported: import('@music-bridge/contracts').LocalWorkbenchArtworkImportRequest[] = []
  let datasetId = 'dataset-a', snapshotId = 'snapshot-a', readToken = 'capture-same'
  const { value } = model(ports({ readAlbums: async request => ({ ...readback(request.albums), datasetId, snapshotId, albums: readback(request.albums).albums.map(item => ({ ...item, capture: { ...item.capture, readToken } })) }), importArtworkBytes: async request => { imported.push(structuredClone(request)); return artwork(request.capture.albumId) } })); t.after(value.dispose)
  await value.open({ action: 'artwork', albums: [a, b] })
  const host = await mountVueSfc(t, new URL('../src/renderer/src/components/library/local-workbench/LocalLibraryWorkbench.vue', import.meta.url).pathname, { model: value })
  for (const change of ['close-reopen', 'dataset-capture', 'pane-aba', 'focus-aba', 'same-readback-refresh'] as const) {
    datasetId = 'dataset-a'; snapshotId = 'snapshot-a'; readToken = 'capture-same'; await value.open({ action: 'artwork', albums: [a, b] }); value.focusAlbum(a.albumId)
    const held = deferred<ArrayBuffer>(), file = new File([new Uint8Array([1])], '合成迟到图片.jpg', { type: 'image/jpeg' }); let reading = false
    Object.defineProperty(file, 'arrayBuffer', { value: () => { reading = true; return held.promise } })
    const zone = host.all().find(node => node.props['aria-label'] === '拖入或粘贴封面')!, pending = host.dispatch(zone, 'onDrop', { dataTransfer: { files: [file], getData: () => 'https://example.invalid/original-intent.jpg' } })
    assert.equal(reading, true, '必须已进入原SFC File读取，不能只测试完成后的拒绝')
    if (change === 'close-reopen') { assert.equal(value.close(), true); await value.open({ action: 'artwork', albums: [a, b] }) }
    else if (change === 'dataset-capture') { datasetId = 'dataset-b'; snapshotId = 'snapshot-b'; readToken = 'capture-new'; await value.open({ action: 'artwork', albums: [a, b] }) }
    else if (change === 'pane-aba') { value.setAction('ai'); value.setAction('artwork') }
    else if (change === 'focus-aba') { value.focusAlbum(b.albumId); value.focusAlbum(a.albumId) }
    else await value.read()
    held.resolve(new ArrayBuffer(1)); await pending
    assert.equal(imported.length, 0); assert.equal(value.focusedAlbumId.value, a.albumId); assert.equal(value.isOpen.value, true); assert.equal(value.plan.value, null)
    assert.deepEqual(value.artworkCandidates.value, [])
  }
})

// 原网页引用只由明确drop转交原Main；受控端口不能替代真实Electron dragstart。
test('封面网页拖图：同次空文本drop传原引用，paste不借网页缓存，bytes成功仍优先', async t => {
  const imported: import('@music-bridge/contracts').LocalWorkbenchArtworkImportRequest[] = []
  const { value } = model(ports({ importArtworkBytes: async request => { imported.push(structuredClone(request)); return { ...artwork(request.capture.albumId), candidateId: 'web-drag-' + imported.length } } })); t.after(value.dispose)
  await value.open({ action: 'artwork', albums: [a] })
  const host = await mountVueSfc(t, new URL('../src/renderer/src/components/library/local-workbench/LocalLibraryWorkbench.vue', import.meta.url).pathname, { model: value })
  const id = '35bb416a-7501-458a-b054-17ce2b32ffac.1', kinds: string[] = []
  const transfer = (files: File[] = []) => ({ files, types: ['application/x-musicbridge-artwork-drag'], getData(kind: string) { kinds.push(kind); return kind === 'application/x-musicbridge-artwork-drag' ? id : '' } })
  const zone = () => host.all().find(node => node.props['aria-label'] === '拖入或粘贴封面')!
  await host.dispatch(zone(), 'onDrop', { dataTransfer: transfer() })
  assert.equal(imported.length, 1); assert.deepEqual(imported[0], { datasetId: value.readback.value!.datasetId, capture: value.focusedAlbum.value!.capture, webCaptureId: id, label: '当前网页拖入的图片' })
  assert.deepEqual(kinds, ['text/uri-list', 'text/plain', 'application/x-musicbridge-artwork-drag'])
  await host.dispatch(zone(), 'onPaste', { clipboardData: transfer() }); assert.equal(imported.length, 1)
  await host.dispatch(zone(), 'onDrop', { dataTransfer: transfer([new File([new Uint8Array([1, 2])], '原图片.jpg', { type: 'image/jpeg' })]) })
  assert.equal(imported.length, 2); assert.ok('bytes' in imported[1]!); assert.equal('webCaptureId' in imported[1]!, false)
  assert.equal(value.selectedArtworkId.value, null); assert.equal(value.plan.value, null); assert.equal(value.operations.value.length, 0)
})

test('CD21实际Renderer网页按钮按分别availability走原search/capture，external不借navigate且不改候选计划', async t => {
  const calls: publicContracts.LocalWorkbenchArtworkSearchRequest[] = []
  let navigateReady = false
  const sources: publicContracts.LocalArtworkSearchSource[] = [{ id: 'google-web', label: 'Google网页', kind: 'web', availability: { available: false, reason: '内嵌暂不可用' }, webActions: { navigate: { available: false, reason: '内嵌暂不可用' }, refresh: { available: true }, external: { available: true } } }]
  const model = useLocalLibraryWorkbench({ ports: { readAlbums: async request => readback(request.albums), artworkSources: sources, capabilities: { read: { available: true }, 'artwork-search': { available: false, reason: '图片搜索暂不可用' } }, async searchArtworkCandidates(request) { calls.push(structuredClone(request)); return { candidates: [], sources: [{ source: 'web', country: null, status: 'opened', candidateCount: 0, previewFailureCount: 0, truncated: false, message: null }] } } } }); t.after(model.dispose)
  await model.open({ action: 'artwork', albums: [a] }); model.artworkCandidates.value = [artwork()]; model.selectedArtworkId.value = artwork().candidateId; model.plan.value = artworkPlan()
  const originalPlan = model.plan.value, originalSelected = model.selectedArtworkId.value
  const host = await mountVueSfc(t, new URL('../src/renderer/src/components/library/local-workbench/LocalLibraryWorkbench.vue', import.meta.url).pathname, { model })
  const button = (label: string) => host.all().find(node => node.type === 'button' && host.text(node) === label)
  assert.equal(button('刷新网页')?.props.disabled, true); assert.equal(button('在浏览器中打开')?.props.disabled, false)
  await host.dispatch(button('在浏览器中打开'), 'onClick'); assert.equal(calls.length, 1); assert.equal(calls[0]!.webAction, 'external'); assert.deepEqual(calls[0]!.capture, readback([a]).albums[0]!.capture)
  assert.equal(model.plan.value, originalPlan); assert.equal(model.selectedArtworkId.value, originalSelected); assert.equal(model.webArtworkAvailability('google-web', 'refresh').available, false)
  // 普通导航成功才能给同capture/query刷新；来源状态仍为真实当前配置快照。
  navigateReady = true; sources[0]!.availability = { available: navigateReady }; sources[0]!.webActions!.navigate = { available: navigateReady }
  model.plan.value = null; model.selectedArtworkId.value = null
  const portsModel = useLocalLibraryWorkbench({ ports: { readAlbums: async request => readback(request.albums), artworkSources: sources, capabilities: { read: { available: true }, 'artwork-search': { available: true } }, async searchArtworkCandidates(request) { calls.push(structuredClone(request)); return { candidates: [], sources: [{ source: 'web', country: null, status: 'opened', candidateCount: 0, previewFailureCount: 0, truncated: false, message: null }] } } } }); t.after(portsModel.dispose)
  await portsModel.open({ action: 'artwork', albums: [a] }); await portsModel.lookupArtwork('search', { query: '原查询', sourceId: 'google-web' }); assert.equal(portsModel.webArtworkAvailability('google-web', 'refresh', '原查询').available, true)
  assert.equal(portsModel.webArtworkAvailability('google-web', 'refresh', '改查询').available, false)
  await portsModel.lookupArtwork('search', { query: '原查询', sourceId: 'google-web', webAction: 'refresh' }); assert.equal(calls.at(-1)!.webAction, 'refresh')
  portsModel.close(); assert.equal(portsModel.webArtworkAvailability('google-web', 'refresh', '原查询').available, false)
})

/** 有意打乱端口顺序并保留额外Provider；原版Tabs必须消费真实对象及其原id。 */
function replicaOriginalArtworkSources(): publicContracts.LocalArtworkSearchSource[] {
  return [
    { id: 'itunes', label: '原iTunes单来源', kind: 'provider', availability: { available: true } },
    { id: 'google-web', label: '原Google网页', kind: 'web', availability: { available: true } },
    { id: 'other-aggregate', label: '另一个可用聚合对象', kind: 'aggregate', availability: { available: true } },
    { id: 'aggregate', label: '原聚合对象', kind: 'aggregate', availability: { available: true } },
    { id: 'douban', label: '原豆瓣单来源', kind: 'provider', availability: { available: true } },
    { id: 'bing-web', label: '原Bing网页', kind: 'web', availability: { available: true } },
    { id: 'douban-web', label: '原豆瓣网页', kind: 'web', availability: { available: true } },
  ]
}
const replicaSourceTabLabels = ['聚合搜索', '豆瓣', 'Bing 图片', 'Google 图片']
const replicaSourceTabIds = ['aggregate', 'douban-web', 'bing-web', 'google-web']

test('原版四来源Tabs保持原顺序与真实聚合web身份，切换零lookup，原读取按钮才发原sourceId', async t => {
  const searches: publicContracts.LocalWorkbenchArtworkSearchRequest[] = []
  const { value, commands } = model(ports({ artworkSources: replicaOriginalArtworkSources(), searchArtworkCandidates: async request => {
    searches.push(structuredClone(request))
    return { candidates: [], sources: [{ source: request.sourceId === 'aggregate' ? 'douban' : 'web', country: null,
      status: request.sourceId === 'aggregate' ? 'ready' : 'opened', candidateCount: 0, previewFailureCount: 0, truncated: false, message: null }] }
  } })); t.after(value.dispose); await value.open({ action: 'artwork', albums: [a] })
  value.artworkCandidates.value = [artwork()]; value.selectedArtworkId.value = artwork().candidateId; value.plan.value = artworkPlan(); value.artworkCountry.value = 'JP'
  const originalPlan = value.plan.value, originalRead = value.readback.value, originalSelection = value.selectedArtworkId.value
  const host = await mountVueSfc(t, new URL('../src/renderer/src/components/library/local-workbench/LocalLibraryWorkbench.vue', import.meta.url).pathname,
    { model: value, artworkSourcePresentation: 'original-tabs' })
  const group = host.all().find(node => node.props.role === 'group' && node.props['aria-label'] === '封面搜索来源'); assert.ok(group)
  const tabs = () => host.all(group).filter(node => node.type === 'button')
  assert.deepEqual(tabs().map(node => host.text(node)), replicaSourceTabLabels)
  assert.deepEqual(tabs().map(node => node.props['aria-pressed']), [true, false, false, false])
  const form = host.all().find(node => node.type === 'form' && node.props['aria-label'] === '按来源搜索封面'); assert.ok(form)
  assert.equal(host.all(form).some(node => node.type === 'select'), false)
  const input = host.all().find(node => node.props['aria-label'] === '封面搜索词'); assert.ok(input)
  ;(input.props['onUpdate:modelValue'] as (query: string) => void)('原Tabs查询'); await host.settle()
  for (let index = 0; index < replicaSourceTabIds.length; index++) {
    await host.dispatch(tabs()[index], 'onClick'); assert.equal(searches.length, 0)
    assert.deepEqual(tabs().map(node => node.props['aria-pressed']), replicaSourceTabIds.map((_id, at) => at === index))
    assert.equal(value.plan.value, originalPlan); assert.equal(value.readback.value, originalRead); assert.equal(value.selectedArtworkId.value, originalSelection)
    const web = host.all().find(node => node.props['aria-label'] === '当前来源封面网页')
    if (index === 0) assert.equal(web, undefined)
    else { assert.ok(web); assert.equal(web.props['data-musicbridge-artwork-web-identity'], JSON.stringify([originalRead!.datasetId, originalRead!.albums[0]!.capture.albumId, originalRead!.albums[0]!.capture.readToken])) }
  }
  for (let index = 0; index < replicaSourceTabIds.length; index++) {
    await host.dispatch(tabs()[index], 'onClick'); assert.equal(searches.length, index)
    await host.dispatch(form, 'onSubmit')
    assert.equal(searches.length, index + 1)
    assert.deepEqual(searches[index], { datasetId: originalRead!.datasetId, capture: originalRead!.albums[0]!.capture,
      query: '原Tabs查询', sourceId: replicaSourceTabIds[index], country: 'JP' })
  }
  assert.equal(value.readback.value, originalRead); assert.equal(commands(), 0); assert.equal(value.operations.value.length, 0)
})

test('原版Tabs不默选隐藏Provider，沿原webActions保禁用原因，UNKNOWN保选择计划并锁住所有来源', async t => {
  const searches: publicContracts.LocalWorkbenchArtworkSearchRequest[] = []
  const sources: publicContracts.LocalArtworkSearchSource[] = replicaOriginalArtworkSources().map(source => source.kind === 'provider' || source.id === 'other-aggregate' ? source : {
    ...source, availability: { available: false, reason: source.id === 'aggregate' ? '原聚合暂不可用' : source.label + '内嵌暂不可用' },
    ...(source.id === 'bing-web' ? { webActions: { navigate: { available: false, reason: '原Bing网页内嵌暂不可用' },
      refresh: { available: false, reason: '原Bing网页刷新暂不可用' }, external: { available: true } } } : {}),
  })
  const { value, commands } = model(ports({ artworkSources: sources, searchArtworkCandidates: async request => {
    searches.push(structuredClone(request)); return { candidates: [], sources: [{ source: 'web', country: null, status: 'opened', candidateCount: 0, previewFailureCount: 0, truncated: false, message: null }] }
  } })); t.after(value.dispose); await value.open({ action: 'artwork', albums: [a] })
  value.artworkCandidates.value = [artwork()]; value.selectedArtworkId.value = artwork().candidateId; value.plan.value = artworkPlan()
  const originalPlan = value.plan.value, originalRead = value.readback.value, originalSelection = value.selectedArtworkId.value
  const host = await mountVueSfc(t, new URL('../src/renderer/src/components/library/local-workbench/LocalLibraryWorkbench.vue', import.meta.url).pathname,
    { model: value, artworkSourcePresentation: 'original-tabs' })
  const group = host.all().find(node => node.props.role === 'group' && node.props['aria-label'] === '封面搜索来源'); assert.ok(group)
  const tabs = () => host.all(group).filter(node => node.type === 'button'), button = (label: string) => host.all().find(node => node.type === 'button' && host.text(node) === label)
  assert.deepEqual(tabs().map(node => host.text(node)), replicaSourceTabLabels)
  assert.deepEqual(tabs().map(node => !!node.props.disabled), [true, true, false, true])
  assert.deepEqual(tabs().map(node => node.props['aria-pressed']), [false, false, true, false], '可用隐藏Provider及其他聚合不能成为原Tabs当前来源')
  assert.match(host.text(), /原聚合暂不可用/u); assert.match(host.text(), /原豆瓣网页内嵌暂不可用/u)
  const form = host.all().find(node => node.type === 'form' && node.props['aria-label'] === '按来源搜索封面'); assert.ok(form)
  await host.dispatch(form, 'onSubmit'); assert.equal(searches.length, 0); assert.equal(value.error.value, '原Bing网页内嵌暂不可用')
  assert.equal(button('在浏览器中打开')?.props.disabled, false); await host.dispatch(button('在浏览器中打开'), 'onClick')
  assert.equal(searches.length, 1); assert.deepEqual(searches[0], { datasetId: originalRead!.datasetId, capture: originalRead!.albums[0]!.capture,
    query: [a.artist, a.title].join(' '), sourceId: 'bing-web', country: 'US', webAction: 'external' })
  assert.equal(value.plan.value, originalPlan); assert.equal(value.selectedArtworkId.value, originalSelection)
  value.operations.value = [recoveredOperation(originalPlan!, 'tabs-original-unknown')]
  const originalOperations = value.operations.value, originalRequest = JSON.stringify(originalOperations[0]!.request)
  await host.settle(); assert.ok(tabs().every(node => node.props.disabled === true))
  assert.deepEqual(tabs().map(node => node.props['aria-pressed']), [false, false, true, false])
  assert.equal(button('读取搜索候选')?.props.disabled, true); assert.equal(button('在浏览器中打开')?.props.disabled, true)
  await host.dispatch(form, 'onSubmit'); assert.equal(searches.length, 1)
  assert.equal(value.operations.value, originalOperations); assert.equal(JSON.stringify(value.operations.value[0]!.request), originalRequest)
  assert.equal(value.operations.value[0]!.state, 'unknown'); assert.equal(value.plan.value, originalPlan); assert.equal(value.selectedArtworkId.value, originalSelection)
  assert.equal(value.readback.value, originalRead); assert.match(host.text(), /结果未确认/u); assert.equal(commands(), 0)
  await t.test('真实aggregate缺席仍保留禁用标签，其他聚合与旧fallback不能代替', async leaf => {
    const requests: publicContracts.LocalWorkbenchArtworkSearchRequest[] = []
    const missing = model(ports({ artworkSources: replicaOriginalArtworkSources().filter(source => source.id !== 'aggregate'), searchArtworkCandidates: async request => {
      requests.push(structuredClone(request)); return { candidates: [], sources: [{ source: 'web', country: null, status: 'opened', candidateCount: 0, previewFailureCount: 0, truncated: false, message: null }] }
    } })); leaf.after(missing.value.dispose); await missing.value.open({ action: 'artwork', albums: [a] })
    assert.ok(missing.value.artworkSources.value.some(source => source.id === 'other-aggregate' && source.availability.available))
    assert.ok(missing.value.artworkSources.value.some(source => source.id === 'douban-itunes' && source.kind === 'aggregate'))
    const missingHost = await mountVueSfc(leaf, new URL('../src/renderer/src/components/library/local-workbench/LocalLibraryWorkbench.vue', import.meta.url).pathname,
      { model: missing.value, artworkSourcePresentation: 'original-tabs' })
    const missingGroup = missingHost.all().find(node => node.props.role === 'group' && node.props['aria-label'] === '封面搜索来源'); assert.ok(missingGroup)
    const missingTabs = missingHost.all(missingGroup).filter(node => node.type === 'button')
    assert.deepEqual(missingTabs.map(node => missingHost.text(node)), replicaSourceTabLabels)
    assert.equal(missingTabs[0]!.props.disabled, true); assert.ok(String(missingTabs[0]!.props.title ?? '').trim(), '缺席原来源必须给出禁用理由')
    assert.deepEqual(missingTabs.map(node => node.props['aria-pressed']), [false, true, false, false])
    assert.equal(requests.length, 0)
    const missingForm = missingHost.all().find(node => node.type === 'form' && node.props['aria-label'] === '按来源搜索封面'); assert.ok(missingForm)
    await missingHost.dispatch(missingForm, 'onSubmit')
    assert.deepEqual(requests, [{ datasetId: missing.value.readback.value!.datasetId, capture: missing.value.focusedAlbum.value!.capture,
      query: [a.artist, a.title].join(' '), sourceId: 'douban-web', country: 'US' }]); assert.equal(missing.commands(), 0)
  })
})

test('共享工作台默认仍用完整来源select，额外Provider可选且沿原读取合同', async t => {
  const searches: publicContracts.LocalWorkbenchArtworkSearchRequest[] = []
  const { value, commands } = model(ports({ artworkSources: replicaOriginalArtworkSources(), searchArtworkCandidates: async request => {
    searches.push(structuredClone(request)); return { candidates: [], sources: [{ source: 'douban', country: null, status: 'ready', candidateCount: 0, previewFailureCount: 0, truncated: false, message: null }] }
  } })); t.after(value.dispose); await value.open({ action: 'artwork', albums: [a] })
  const originalRead = value.readback.value, host = await mountVueSfc(t, new URL('../src/renderer/src/components/library/local-workbench/LocalLibraryWorkbench.vue', import.meta.url).pathname, { model: value })
  assert.equal(host.all().some(node => node.props['aria-label'] === '封面搜索来源'), false)
  const form = host.all().find(node => node.type === 'form' && node.props['aria-label'] === '按来源搜索封面'); assert.ok(form)
  const select = host.all(form).find(node => node.type === 'select'); assert.ok(select)
  const options = host.all(select).filter(node => node.type === 'option')
  assert.deepEqual(options.map(node => node.props.value), ['', ...value.artworkSources.value.map(source => source.id)])
  for (const id of ['itunes', 'douban']) assert.equal(options.find(node => node.props.value === id)?.props.disabled, false)
  ;(select.props['onUpdate:modelValue'] as (sourceId: string) => void)('douban'); await host.settle(); assert.equal(searches.length, 0)
  await host.dispatch(form, 'onSubmit')
  assert.deepEqual(searches, [{ datasetId: originalRead!.datasetId, capture: originalRead!.albums[0]!.capture,
    query: [a.artist, a.title].join(' '), sourceId: 'douban', country: 'US' }])
  assert.equal(value.readback.value, originalRead); assert.equal(commands(), 0); assert.equal(value.plan.value, null); assert.equal(value.operations.value.length, 0)
})
