import assert from 'node:assert/strict'
import test from 'node:test'
import type { CommandOutboxRequest, RestoreActivationView } from '@music-bridge/contracts'
import type { CoreSupervisor } from '../src/main/core-supervisor.js'
import type { StoredCommandOutboxEntry } from '../src/main/command-outbox-store.js'
import { createCommandOutboxExecutor, type CommandOutboxPickOptions } from '../src/main/command-outbox-executor.js'

const datasetId = '11111111-1111-4111-8111-111111111111'
const commandId = '22222222-2222-4222-8222-222222222222'
const entityId = '33333333-3333-4333-8333-333333333333'
const otherDatasetId = '44444444-4444-4444-8444-444444444444'
const selectedPath = '/synthetic/outbox-selected'
const timestamp = '2026-08-28T00:00:00.000Z'
function stored(request: CommandOutboxRequest): StoredCommandOutboxEntry {
  return { ...request, schemaVersion: 1, id: entityId, commandId: request.payload.commandId,
    fingerprint: 'a'.repeat(64), createdAt: timestamp, updatedAt: timestamp, state: 'sending', acknowledged: false }
}
const ordinary = stored({ datasetId, command: 'collection.setPolicy', payload: { commandId, modelId: entityId, expectedRevision: 1, collectorPolicy: 'normal', minimumSealedReserve: 0 } })
const activation = stored({ datasetId, command: 'recordingBackups.activate', payload: { commandId, restoreJobId: entityId, expectedActiveId: null, userConfirmed: true, stopPlaybackConfirmed: true } })
interface Call { route: 'public' | 'internal' | 'activate'; command: string; payload: unknown; expectedDatasetId?: string }
const nativeCases: { command: CommandOutboxRequest['command']; payload: object; receipt: string; field: string; write: string; result: unknown; title: string; properties: string[] }[] = [
  { command: 'recordingSources.chooseRoot', payload: { commandId }, receipt: 'recordingSources.rootReceipt', field: 'root', write: 'recordingSources.authorize', result: { id: entityId, label: '合成来源', authorized: true, availability: 'ONLINE' }, title: '授权只读源目录', properties: ['openDirectory'] },
  { command: 'recordingSources.choose', payload: { commandId, draftId: entityId, trackId: entityId, rootId: entityId, acquisition: 'userFileBind' }, receipt: 'recordingSources.job', field: 'job', write: 'recordingSources.start', result: { id: commandId, draftId: entityId, trackId: entityId, rootId: entityId, state: 'running' }, title: '选择实际音频文件', properties: ['openFile'] },
  { command: 'recordingPreparation.chooseDestination', payload: { commandId }, receipt: 'recordingPreparation.authorizationReceipt', field: 'destination', write: 'recordingPreparation.authorize', result: { id: entityId, label: '合成准备目录', authorized: true }, title: '选择 Logic 工作区目标目录', properties: ['openDirectory', 'createDirectory'] },
  { command: 'recordingPrepared.choose', payload: { commandId, preparationId: entityId, side: 'A' }, receipt: 'recordingPrepared.selectionReceipt', field: 'selection', write: 'recordingPrepared.select', result: { id: entityId, preparationId: entityId, side: 'A', label: '合成 WAV', authorized: true }, title: '选择 A 面原始 Render', properties: ['openFile'] },
  { command: 'recordingArchive.choose', payload: { commandId }, receipt: 'recordingArchive.authorizationReceipt', field: 'root', write: 'recordingArchive.authorize', result: { id: entityId, label: '合成归档', state: 'selected' }, title: '选择归档父目录', properties: ['openDirectory'] },
  { command: 'recordingBackups.choose', payload: { commandId, kind: 'backup-destination' }, receipt: 'recordingBackups.authorizationReceipt', field: 'root', write: 'recordingBackups.authorize', result: { id: entityId, kind: 'backup-destination', label: '合成备份', authorized: true }, title: '选择备份目标目录', properties: ['openDirectory'] },
]
function fixture(spec?: typeof nativeCases[number]) {
  const calls: Call[] = [], picks: CommandOutboxPickOptions[] = []
  let currentDatasetId = datasetId, prior = false
  let pickResult = { canceled: false, filePaths: [selectedPath] }
  let result: unknown = { modelId: entityId }
  let receipt: unknown = null
  let onPick: (() => void) | undefined
  async function dispatch(call: Call): Promise<unknown> {
    calls.push(structuredClone(call))
    if (call.command === 'commandOutbox.context') return { datasetId: currentDatasetId }
    if (call.command === 'commandOutbox.execute') return { command: ordinary.command, result }
    if (call.command === 'recordingBackups.activationReceipt') return { activation: receipt }
    if (call.route === 'activate') return result
    if (call.expectedDatasetId !== undefined && call.expectedDatasetId !== currentDatasetId) throw Object.assign(new Error('合成切库拒绝'), { code: 'OUTBOX_SCOPE_MISMATCH' })
    if (spec && call.command === spec.receipt) return { [spec.field]: prior ? spec.result : null }
    if (call.command === 'recordingSources.context') return { absolutePath: '/synthetic/source-root' }
    if (spec && call.command === spec.write) {
      assert.equal(call.expectedDatasetId, datasetId, '写边界必须携带原工作库')
      return spec.result
    }
    throw new Error(`未配置的合成调用 ${call.command}`)
  }
  const supervisor = {
    request: ((command: string, payload: unknown) => dispatch({ route: 'public', command, payload })) as CoreSupervisor['request'],
    requestInternal: ((command: string, payload: unknown, expectedDatasetId?: string) => dispatch({ route: 'internal', command, payload, expectedDatasetId })) as CoreSupervisor['requestInternal'],
    activateRestoredDataset: ((payload: unknown, expectedDatasetId?: string) => dispatch({ route: 'activate', command: 'activate', payload, expectedDatasetId })) as CoreSupervisor['activateRestoredDataset'],
  }
  const executor = createCommandOutboxExecutor({ supervisor, pick: async (options) => { picks.push(structuredClone(options)); onPick?.(); return pickResult } })
  return { executor, calls, picks, setDataset: (value: string) => { currentDatasetId = value }, setPrior: () => { prior = true },
    setPick: (value: typeof pickResult) => { pickResult = value }, setResult: (value: unknown) => { result = value },
    setReceipt: (value: unknown) => { receipt = value }, onPick: (callback: () => void) => { onPick = callback } }
}

test('普通命令通过唯一scoped execute路由，保留原DTO并返回已验证结果', async () => {
  const f = fixture(), before = structuredClone(ordinary)
  assert.deepEqual(await f.executor.execute(ordinary), { modelId: entityId })
  assert.deepEqual(f.calls, [{ route: 'public', command: 'commandOutbox.execute', payload: { datasetId, command: ordinary.command, payload: ordinary.payload } }])
  assert.deepEqual(ordinary, before)
  assert.equal(f.picks.length, 0)
})

test('普通命令拒绝非法返回值及不同命令的回执', async () => {
  const f = fixture()
  f.setResult({ absolutePath: selectedPath })
  await assert.rejects(f.executor.execute(ordinary), { code: 'INVALID_IPC_RESPONSE' })
  const supervisor = { request: async () => ({ command: 'collection.materialize', result: { modelId: entityId } }) } as unknown as Pick<CoreSupervisor, 'request' | 'requestInternal' | 'activateRestoredDataset'>
  const executor = createCommandOutboxExecutor({ supervisor, pick: async () => { throw new Error('不应打开') } })
  await assert.rejects(executor.execute(ordinary), { code: 'INVALID_IPC_RESPONSE' })
})

for (const spec of nativeCases) {
  function input() { return stored({ datasetId, command: spec.command, payload: spec.payload } as CommandOutboxRequest) }
  test(`${spec.command}：无回执才选择，写请求固定原scope且不改变持久条目`, async () => {
    const f = fixture(spec), entry = input(), before = structuredClone(entry)
    assert.deepEqual(await f.executor.execute(entry), spec.result)
    assert.equal(f.picks.length, 1)
    assert.equal(f.picks[0]?.title, spec.title)
    assert.deepEqual(f.picks[0]?.properties, spec.properties)
    const write = f.calls.find((call) => call.command === spec.write)!
    assert.equal(write.expectedDatasetId, datasetId)
    assert.deepEqual(write.payload, spec.command === 'recordingSources.choose' ? { selection: spec.payload, absolutePath: selectedPath } : { ...spec.payload, absolutePath: selectedPath })
    if (spec.command === 'recordingSources.choose') assert.equal(f.picks[0]?.defaultPath, '/synthetic/source-root')
    assert.deepEqual(entry, before)
  })
  test(`${spec.command}：取消和空选择不写Core`, async () => {
    for (const chosen of [{ canceled: true, filePaths: [selectedPath] }, { canceled: false, filePaths: [] }]) {
      const f = fixture(spec); f.setPick(chosen)
      assert.equal(await f.executor.execute(input()), null)
      assert.equal(f.calls.some((call) => call.command === spec.write), false)
    }
  })
  test(`${spec.command}：旧回执不再打开选择器`, async () => {
    const f = fixture(spec); f.setPrior()
    assert.deepEqual(await f.executor.execute(input()), spec.result)
    assert.equal(f.picks.length, 0)
    if (spec.command === 'recordingSources.choose') {
      const replay = f.calls.find((call) => call.command === spec.write)!
      assert.deepEqual(replay.payload, { selection: spec.payload, absolutePath: '/already-selected' })
      assert.equal(replay.expectedDatasetId, datasetId)
    } else assert.equal(f.calls.some((call) => call.command === spec.write), false)
  })
  test(`${spec.command}：选择器期间切库由最终固定scope写边界拒绝`, async () => {
    const f = fixture(spec); f.onPick(() => f.setDataset(otherDatasetId))
    await assert.rejects(f.executor.execute(input()), { code: 'OUTBOX_SCOPE_MISMATCH' })
    assert.equal(f.calls.find((call) => call.command === spec.write)?.expectedDatasetId, datasetId)
  })
}

test('开始前scope不匹配不弹选择器，调用中修改原entry也不能换掉已捕获scope或DTO', async () => {
  const spec = nativeCases[0]!, f = fixture(spec)
  f.setDataset(otherDatasetId)
  await assert.rejects(f.executor.execute(stored({ datasetId, command: 'recordingSources.chooseRoot', payload: { commandId } })), { code: 'OUTBOX_SCOPE_MISMATCH' })
  assert.equal(f.picks.length, 0)
  const g = fixture(spec), entry = stored({ datasetId, command: 'recordingSources.chooseRoot', payload: { commandId } })
  g.onPick(() => { entry.datasetId = otherDatasetId; entry.payload.commandId = entityId })
  await g.executor.execute(entry)
  const write = g.calls.find((call) => call.command === spec.write)!
  assert.equal(write.expectedDatasetId, datasetId)
  assert.deepEqual(write.payload, { commandId, absolutePath: selectedPath })
})

function activationResult(state: RestoreActivationView['state']): RestoreActivationView {
  return { id: commandId, restoreJobId: entityId, previousId: null, state, createdAt: timestamp, contentIncluded: false,
    ...(state === 'failed' ? { issue: 'PREPARATION_FAILED' as const } : state === 'rolled-back' ? { issue: 'BOOT_FAILED' as const } : {}) }
}
test('显式激活传原完整请求与固定scope，执行桥不直接调用播放或restart', async () => {
  const f = fixture(), result = activationResult('active'); f.setResult(result)
  assert.deepEqual(await f.executor.execute(activation), result)
  assert.deepEqual(f.calls.filter((call) => call.route !== 'public'), [{ route: 'activate', command: 'activate', payload: activation.payload, expectedDatasetId: datasetId }])
  assert.equal(f.picks.length, 0)
})
test('跨库恢复只读取原激活终态，所有非终态和无回执都不执行', async () => {
  for (const state of ['active', 'superseded', 'failed', 'rolled-back', 'preparing', 'prepared', 'activating', null] as const) {
    const f = fixture(), result = state ? activationResult(state) : null
    f.setDataset(otherDatasetId); f.setReceipt(result)
    const terminal = state !== null && ['active', 'superseded', 'failed', 'rolled-back'].includes(state)
    assert.deepEqual(await f.executor.recoverAcrossDataset(activation), terminal ? { found: true, result } : { found: false })
    assert.deepEqual(f.calls, [{ route: 'internal', command: 'recordingBackups.activationReceipt', payload: activation.payload, expectedDatasetId: undefined }])
    assert.equal(f.picks.length, 0)
  }
})
test('跨库普通命令不查询，错误恢复身份或非法激活回执不能冒充成功', async () => {
  const f = fixture()
  assert.deepEqual(await f.executor.recoverAcrossDataset(ordinary), { found: false })
  assert.deepEqual(f.calls, [])
  f.setReceipt({ ...activationResult('active'), restoreJobId: commandId })
  await assert.rejects(f.executor.recoverAcrossDataset(activation), { code: 'INVALID_IPC_RESPONSE' })
  f.setReceipt({ ...activationResult('active'), absolutePath: selectedPath })
  await assert.rejects(f.executor.recoverAcrossDataset(activation), { code: 'INVALID_IPC_RESPONSE' })
})
