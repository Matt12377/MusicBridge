import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isLocalWorkbenchCommandPayload, isLocalWorkbenchCommandResult, isLocalWorkbenchReadRequestEnvelope,
  isLocalWorkbenchCancelReadRequest, isLocalWorkbenchCancelReadReply, isLocalWorkbenchPlan,
  isLocalWorkbenchOperation, isLocalWorkbenchReadback,
  type LocalWorkbenchApplyRequest, type LocalWorkbenchPlan, type LocalWorkbenchOperation,
  type LocalWorkbenchReadback, type LocalWorkbenchReceipt,
} from '@music-bridge/contracts'

const capture = { albumId: 'album-a', readToken: 'read-a' }
const original: LocalWorkbenchApplyRequest = { commandId: 'command-a', datasetId: 'dataset-a', planId: 'plan-a', expectedRevision: '1', planHash: 'a'.repeat(64), contextFingerprint: 'b'.repeat(64), kind: 'artwork' }
function plan(): LocalWorkbenchPlan {
  return { kind: 'artwork', scope: 'MB_ONLY', relationship: 'create-on-apply', datasetId: 'dataset-a', planId: 'plan-a', revision: '1', planHash: 'a'.repeat(64),
    contextFingerprint: 'b'.repeat(64), expiresAt: '2099-01-01T00:00:00.000Z', albumIds: ['album-a'], state: 'ready', blockers: [],
    items: [{ itemId: 'item-a', albumId: 'album-a', label: '合成专辑', changes: [] }] }
}
function operation(index = 0): LocalWorkbenchOperation {
  const captured = { ...plan(), planId: 'plan-' + index }
  return { request: { ...original, commandId: 'command-' + index, planId: captured.planId }, plan: captured, receipt: null, state: 'unknown' }
}
function readback(pendingOperations?: readonly LocalWorkbenchOperation[]): LocalWorkbenchReadback {
  return { datasetId: 'dataset-a', snapshotId: 'snapshot-a', albums: [{
    album: { albumId: 'album-a', title: '合成专辑', artist: '合成艺人', trackIds: ['track-a'] },
    capture, availability: 'online', issues: [], currentArtwork: null, cueSheets: [],
  }], ...(pendingOperations === undefined ? {} : { pendingOperations }) }
}
function result(value: LocalWorkbenchOperation, state: LocalWorkbenchReceipt['state']): LocalWorkbenchReceipt {
  return { commandId: value.request.commandId, datasetId: value.request.datasetId, planId: value.request.planId,
    planHash: value.request.planHash, state, message: null, items: value.plan.items.map(item => ({
      itemId: item.itemId, albumId: item.albumId, label: item.label, state: state === 'succeeded' ? 'applied' : 'unknown', message: null,
    })) }
}

test('网页拖图公开请求仅接受原导航UUID及有界拖图序号，不能附新路径或来源权限', () => {
  const webCaptureId = '35bb416a-7501-458a-b054-17ce2b32ffac.1', base = { datasetId: 'dataset-a', capture, label: '原网页拖图' }
  assert.equal(isLocalWorkbenchCommandPayload('localWorkbench.artwork.import', { ...base, webCaptureId }), true)
  assert.equal(isLocalWorkbenchCommandPayload('localWorkbench.artwork.import', { ...base, text: 'https://images.example.com/original.jpg', webCaptureId }), true)
  for (const id of ['35bb416a-7501-458a-b054-17ce2b32ffac', '35bb416a-7501-458a-b054-17ce2b32ffac.0', '35bb416a-7501-458a-b054-17ce2b32ffac.1000000', 'file:///private/original']) {
    assert.equal(isLocalWorkbenchCommandPayload('localWorkbench.artwork.import', { ...base, webCaptureId: id }), false)
  }
  assert.equal(isLocalWorkbenchCommandPayload('localWorkbench.artwork.import', { ...base, webCaptureId, originalCaptureKey: 'a'.repeat(64) }), false)
  assert.equal(isLocalWorkbenchCommandPayload('localWorkbench.artwork.import', { ...base, webCaptureId, path: '/synthetic/image' }), false)
  assert.equal(isLocalWorkbenchCommandPayload('localWorkbench.artwork.import', { ...base, webCaptureId, bytes: new Uint8Array([1]), mime: 'image/jpeg' }), false)
})

test('工作台公开请求闭集拒绝路径、凭据、隐藏键、自定义原型和getter', () => {
  const valid = { datasetId: 'dataset-a', capture, backend: 'ollama' }
  assert.equal(isLocalWorkbenchCommandPayload('localWorkbench.ai.suggest', valid), true)
  for (const extra of [{ endpoint: '合成地址' }, { apiKey: '合成密钥' }, { path: '/合成/源文件' }, { grant: 'SOURCE_FILES' }])
    assert.equal(isLocalWorkbenchCommandPayload('localWorkbench.ai.suggest', { ...valid, ...extra }), false)
  const hidden = { ...valid }; Object.defineProperty(hidden, 'grant', { value: '合成授权', enumerable: false })
  assert.equal(isLocalWorkbenchCommandPayload('localWorkbench.ai.suggest', hidden), false)
  assert.equal(isLocalWorkbenchCommandPayload('localWorkbench.ai.suggest', Object.assign(Object.create({ grant: '合成继承授权' }), valid)), false)
  let calls = 0
  const getter = { ...valid }; Object.defineProperty(getter, 'capture', { enumerable: true, get: () => { calls++; return capture } })
  assert.equal(isLocalWorkbenchCommandPayload('localWorkbench.ai.suggest', getter), false); assert.equal(calls, 0)
})

test('工作台read envelope只准11类读/候选/预览，不能包装应用/unknown回执/取消任务', () => {
  assert.equal(isLocalWorkbenchReadRequestEnvelope({ requestId: 'nonce-a', command: 'localWorkbench.ai.suggest', payload: { datasetId: 'dataset-a', capture, backend: 'cloud' } }), true)
  for (const command of ['localWorkbench.plan.apply', 'localWorkbench.plan.receipt', 'localWorkbench.plan.cancel', 'localWorkbench.existing.open'])
    assert.equal(isLocalWorkbenchReadRequestEnvelope({ requestId: 'nonce-a', command, payload: original }), false)
  assert.equal(isLocalWorkbenchReadRequestEnvelope({ requestId: 'nonce-a', command: 'localWorkbench.ai.suggest', payload: { ...original } }), false)
  assert.equal(isLocalWorkbenchReadRequestEnvelope({ requestId: 'nonce-a', command: 'localWorkbench.cue.target', payload: {}, channel: '合成任意通道' }), false)
  assert.equal(isLocalWorkbenchCancelReadRequest({ requestId: 'nonce-a' }), true)
  assert.equal(isLocalWorkbenchCancelReadRequest({ requestId: 'nonce-a', datasetId: 'dataset-a' }), false)
  assert.equal(isLocalWorkbenchCancelReadRequest({ requestId: 'n'.repeat(129) }), false)
  assert.equal(isLocalWorkbenchCancelReadReply({ cancelled: true }), true)
  assert.equal(isLocalWorkbenchCancelReadReply({ cancelled: true, closedDialog: true }), false)
})

test('工作台ready/blocked计划闭集与MB_ONLY/独立输出约束不可扩展', () => {
  assert.equal(isLocalWorkbenchPlan(plan()), true)
  assert.equal(isLocalWorkbenchPlan({ ...plan(), sourceDisposition: 'delete' }), false)
  assert.equal(isLocalWorkbenchPlan({ ...plan(), scope: 'SOURCE_FILES' }), false)
  assert.equal(isLocalWorkbenchPlan({ ...plan(), albumIds: ['album-a', 'unrepresented-album'] }), false)
  assert.equal(isLocalWorkbenchPlan({ ...plan(), state: 'ready', blockers: ['合成阻断'] }), false)
})

test('工作台AI公共候选须有真实前后字段/理由，输出extra key与错专辑拒绝', () => {
  const request = { datasetId: 'dataset-a', capture, backend: 'ollama' as const }
  const candidate = { candidateId: 'candidate-a', albumId: 'album-a', title: '合成新专辑', artist: '合成艺人', reason: 'Ollama 名称建议，待确认；模型未提供理由。',
    changes: [{ field: 'album', before: '合成原专辑', after: '合成新专辑', reason: '来源说明。' }] }
  assert.equal(isLocalWorkbenchCommandResult('localWorkbench.ai.suggest', { albumId: 'album-a', candidates: [candidate] }, request), true)
  assert.equal(isLocalWorkbenchCommandResult('localWorkbench.ai.suggest', { albumId: 'album-a', candidates: [{ ...candidate, changes: [] }] }, request), false)
  assert.equal(isLocalWorkbenchCommandResult('localWorkbench.ai.suggest', { albumId: 'album-a', candidates: [{ ...candidate, albumId: 'other-album' }] }, request), false)
  assert.equal(isLocalWorkbenchCommandResult('localWorkbench.ai.suggest', { albumId: 'album-a', candidates: [candidate], credential: '合成字段' }, request), false)
})

test('工作台结果绑定原命令/计划hash，未知不伪称success；图片只公开规范化副本', () => {
  const result = { commandId: 'command-a', datasetId: 'dataset-a', planId: 'plan-a', planHash: 'a'.repeat(64), state: 'unknown', message: null,
    items: [{ itemId: 'item-a', albumId: 'album-a', label: '合成专辑', state: 'unknown', message: null }] }
  assert.equal(isLocalWorkbenchCommandResult('localWorkbench.plan.apply', result, original), true)
  assert.equal(isLocalWorkbenchCommandResult('localWorkbench.plan.apply', { ...result, state: 'succeeded' }, original), false)
  assert.equal(isLocalWorkbenchCommandResult('localWorkbench.plan.apply', { ...result, commandId: 'other-command' }, original), false)
  const artwork = { candidateId: 'image-a', albumId: 'album-a', label: '合成图片', origin: 'manual', sourceLabel: '用户提供', previewUrl: 'https://example.invalid/image.jpg', width: 1, height: 1, licenseLabel: '用户提供' }
  assert.equal(isLocalWorkbenchCommandResult('localWorkbench.artwork.file', artwork, { datasetId: 'dataset-a', capture }), false)
})

test('工作台持久原操作回显验证完整身份与逐项状态；通用终态与pending投影分别闭集', () => {
  const pending = operation(), request = { albums: readback().albums.map(item => item.album) }
  assert.equal(isLocalWorkbenchOperation(pending, 'dataset-a'), true)
  assert.equal(isLocalWorkbenchReadback(readback([pending]), request), true)
  assert.equal(isLocalWorkbenchReadback(readback(), request), true)
  const done: LocalWorkbenchOperation = { ...pending, receipt: result(pending, 'succeeded'), state: 'succeeded' }
  assert.equal(isLocalWorkbenchOperation(done, 'dataset-a'), true)
  assert.equal(isLocalWorkbenchReadback(readback([done]), request), false)
  const running: LocalWorkbenchOperation = { ...pending, receipt: result(pending, 'running'), state: 'running' }
  assert.equal(isLocalWorkbenchReadback(readback([running]), request), true)
  const multiple = operation(1)
  multiple.plan = { ...multiple.plan, items: [...multiple.plan.items, { itemId: 'item-b', albumId: 'album-a', label: '合成第二项', changes: [] }] }
  multiple.receipt = { ...result(multiple, 'partial'), items: [
    { itemId: 'item-a', albumId: 'album-a', label: '合成专辑', state: 'applied', message: null },
    { itemId: 'item-b', albumId: 'album-a', label: '合成第二项', state: 'unknown', message: '合成回执未确认。' },
  ] }
  assert.equal(isLocalWorkbenchOperation(multiple, 'dataset-a'), true)
  assert.equal(isLocalWorkbenchReadback(readback([multiple]), request), true)
  assert.equal(isLocalWorkbenchOperation({ ...multiple, state: 'partial' }), false)
  for (const changed of [
    { request: { ...pending.request, datasetId: 'other-dataset' } },
    { request: { ...pending.request, planId: 'other-plan' } },
    { request: { ...pending.request, expectedRevision: '2' } },
    { request: { ...pending.request, planHash: 'c'.repeat(64) } },
    { request: { ...pending.request, contextFingerprint: 'c'.repeat(64) } },
    { request: { ...pending.request, kind: 'ai' } },
    { receipt: { ...result(pending, 'unknown'), commandId: 'other-command' } },
    { receipt: { ...result(pending, 'unknown'), items: [{ ...result(pending, 'unknown').items[0]!, label: '被改写的原标签' }] } },
  ]) assert.equal(isLocalWorkbenchOperation({ ...pending, ...changed }, 'dataset-a'), false)
  assert.equal(isLocalWorkbenchOperation({ ...pending, state: 'running' }), false)
  let calls = 0
  const getter = { ...pending }
  Object.defineProperty(getter, 'request', { enumerable: true, get: () => { calls++; return pending.request } })
  assert.equal(isLocalWorkbenchOperation(getter), false); assert.equal(calls, 0)
  const hidden = { ...pending }; Object.defineProperty(hidden, 'grant', { value: '合成隐藏源权限' })
  assert.equal(isLocalWorkbenchReadback(readback([hidden])), false)
})

test('工作台恢复整批拒绝重复命令/计划、跨库、超过100操作和2MiB回复，不截断', () => {
  const pending = operation(), other = operation(1)
  assert.equal(isLocalWorkbenchReadback(readback([pending, { ...other, request: { ...other.request, commandId: pending.request.commandId } }])), false)
  assert.equal(isLocalWorkbenchReadback(readback([pending, { ...pending, request: { ...pending.request, commandId: 'other-command' } }])), false)
  const crossDataset: LocalWorkbenchOperation = { ...other, request: { ...other.request, datasetId: 'dataset-b' }, plan: { ...other.plan, datasetId: 'dataset-b' } }
  assert.equal(isLocalWorkbenchOperation(crossDataset, 'dataset-b'), true)
  assert.equal(isLocalWorkbenchReadback(readback([crossDataset])), false)
  assert.equal(isLocalWorkbenchReadback(readback(Array.from({ length: 100 }, (_, index) => operation(index)))), true)
  assert.equal(isLocalWorkbenchReadback(readback(Array.from({ length: 101 }, (_, index) => operation(index)))), false)
  const large = operation()
  large.plan = { ...large.plan, items: Array.from({ length: 2100 }, (_, index) => ({
    itemId: 'item-' + index, albumId: 'album-a', label: 'a'.repeat(1024), changes: [],
  })) }
  assert.equal(isLocalWorkbenchOperation(large, 'dataset-a'), true)
  assert.equal(isLocalWorkbenchReadback(readback([large])), false)
  const sparse = [pending, other]; delete sparse[0]
  assert.equal(isLocalWorkbenchReadback(readback(sparse)), false)
})

test('CD21网页动作只扩原search有限正文，缺省navigate、拒URL权限隐藏字段及未知mode', async () => {
  const dto = await import('@music-bridge/contracts'), body = { datasetId: 'dataset-a', capture, query: '合成 & 查询', sourceId: 'google-web' }
  assert.equal(dto.LOCAL_WORKBENCH_COMMANDS.length, 15)
  assert.equal(isLocalWorkbenchCommandPayload('localWorkbench.artwork.search', body), true)
  for (const webAction of ['navigate', 'refresh', 'external']) assert.equal(isLocalWorkbenchCommandPayload('localWorkbench.artwork.search', { ...body, webAction }), true)
  for (const webAction of ['reload-new-window', '', null, 1, undefined, { toString: () => 'external' }]) assert.equal(isLocalWorkbenchCommandPayload('localWorkbench.artwork.search', { ...body, webAction }), false)
  for (const extra of [{ url: 'https://example.invalid' }, { path: '/private/source' }, { originalSignal: {} }, { captureId: 'Renderer自定' }]) assert.equal(isLocalWorkbenchCommandPayload('localWorkbench.artwork.search', { ...body, webAction: 'external', ...extra }), false)
  let gets = 0; const hidden = Object.defineProperty({ ...body, webAction: 'refresh' }, 'authority', { get() { gets++; return '伪权限' } })
  assert.equal(isLocalWorkbenchCommandPayload('localWorkbench.artwork.search', hidden), false); assert.equal(gets, 0)
  const capability = { capabilities: {}, artworkSources: [{ id: 'google-web', label: 'Google网页', kind: 'web', availability: { available: false, reason: '内嵌未就绪' }, webActions: { navigate: { available: false, reason: '内嵌未就绪' }, refresh: { available: false, reason: '未接入' }, external: { available: true } } }], artworkImportFormats: [], aiBackends: [], cueFormats: [], existingActions: {} }
  assert.equal(dto.isLocalWorkbenchCapabilitiesReply(capability), true)
  assert.equal(dto.isLocalWorkbenchCapabilitiesReply({ ...capability, artworkSources: [{ ...capability.artworkSources[0], kind: 'provider' }] }), false)
  assert.equal(dto.isLocalWorkbenchCapabilitiesReply({ ...capability, artworkSources: [{ ...capability.artworkSources[0], webActions: { ...capability.artworkSources[0]!.webActions, newWindow: { available: true } } }] }), false)
})
