import assert from 'node:assert/strict'
import test from 'node:test'
import type { MasterDraft, PutRecordingWorkspaceContextRequest, RecordingWorkspaceContext } from '@music-bridge/contracts'
import { createRecordingWorkspaceController } from '../src/renderer/src/components/recording/recording-workspace-controller.js'

const id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`
const draft = (n: number, revision = 1): MasterDraft => ({ id: id(n), title: '合成草稿', revision, status: 'draft', programType: 'compilation', trackCount: 0, tracks: [], sourceLockEligible: false })
const saved = (n: number, contextRevision = 1): RecordingWorkspaceContext => ({ draftId: id(n), draftRevision: 1, contextRevision, selection: { planId: id(10), layoutId: id(11), path: 'logic', preparationId: id(12), preparedId: id(13) }, pagePosition: 'logic', staleReasons: [{ field: 'planId', reason: 'plan-changed' }] })

for (const resetFirst of [false, true]) {
  test(`MBR-002：未知工作区保存经${resetFirst ? 'reset再打开' : '重新读取'}仍保留原描述符且不自动重放`, async t => {
    const requests: PutRecordingWorkspaceContextRequest[] = []
    const controller = createRecordingWorkspaceController({ api: {
      getRecordingWorkspaceContext: async () => saved(1),
      putRecordingWorkspaceContext: async request => { requests.push(structuredClone(request)); throw new Error('[TIMEOUT] 合成回执未知') },
    } })
    t.after(controller.dispose)
    await controller.open(draft(1)); await controller.choose({ planId: id(20) })
    const original = structuredClone(controller.state.pending); assert.ok(original)
    if (resetFirst) controller.reset()
    await controller.reread(draft(1))
    assert.deepEqual(controller.state.pending, original, '重读当前快照不能冒充原commandId已获回执')
    assert.equal(controller.state.status, 'error'); assert.equal(controller.state.selection.planId, id(20))
    await controller.navigate('media'); assert.equal(requests.length, 1)
    await controller.retry(); assert.deepEqual(requests, [original, original])
  })
}

test('MBR-002：A 保存迟到失败不覆盖 B 的显式选择，返回 A 仍只重试原命令', async t => {
  const requests: PutRecordingWorkspaceContextRequest[] = []
  let rejectA!: (cause: Error) => void
  let firstA = true
  const controller = createRecordingWorkspaceController({ api: {
    getRecordingWorkspaceContext: async draftId => saved(draftId === id(1) ? 1 : 2),
    putRecordingWorkspaceContext: request => {
      requests.push(structuredClone(request))
      if (request.draftId === id(1) && firstA) {
        firstA = false
        return new Promise<RecordingWorkspaceContext>((_resolve, reject) => { rejectA = reject })
      }
      return Promise.resolve({ draftId: request.draftId, draftRevision: request.expectedDraftRevision,
        contextRevision: request.expectedContextRevision + 1, selection: request.selection, pagePosition: request.pagePosition, staleReasons: [] })
    },
  } })
  t.after(controller.dispose)
  await controller.open(draft(1)); const saveA = controller.choose({ planId: id(20) })
  const originalA = structuredClone(controller.state.pending)!
  await controller.open(draft(2)); const saveB = controller.choose({ planId: id(30) })
  rejectA(new Error('[TIMEOUT] 合成迟到保存未知')); await Promise.all([saveA, saveB])
  assert.equal(controller.state.draftId, id(2)); assert.equal(controller.state.status, 'ready')
  assert.equal(controller.state.selection.planId, id(30)); assert.equal(controller.state.pending, undefined)
  assert.deepEqual(requests.map(request => request.draftId), [id(1), id(2)])
  await controller.open(draft(1))
  assert.equal(controller.state.status, 'error'); assert.equal(controller.state.selection.planId, id(20))
  assert.deepEqual(controller.state.pending, originalA); assert.equal(requests.length, 2)
  await controller.retry()
  assert.deepEqual(requests[2], originalA); assert.equal(controller.state.status, 'ready')
})

test('MBR-002：错误草稿或修订的保存ACK不清原描述符，重读后仍保留原DTO', async t => {
  const requests: PutRecordingWorkspaceContextRequest[] = []
  let wrongDraft = true
  const controller = createRecordingWorkspaceController({ api: {
    getRecordingWorkspaceContext: async () => saved(1),
    putRecordingWorkspaceContext: async request => {
      requests.push(structuredClone(request))
      return { draftId: wrongDraft ? id(2) : request.draftId, draftRevision: request.expectedDraftRevision,
        contextRevision: wrongDraft ? request.expectedContextRevision + 1 : request.expectedContextRevision,
        selection: request.selection, pagePosition: request.pagePosition, staleReasons: [] }
    },
  } })
  t.after(controller.dispose)
  await controller.open(draft(1)); await controller.navigate('media')
  const original = structuredClone(controller.state.pending)!
  assert.equal(controller.state.status, 'error'); wrongDraft = false; await controller.retry()
  await controller.reread(draft(1))
  assert.equal(controller.state.status, 'error'); assert.deepEqual(controller.state.pending, original)
  assert.deepEqual(requests, [original, original]); assert.equal(controller.state.pagePosition, 'media')
})

test('迟到的 A 草稿读取不覆盖 B；旧版本与失效引用保留且不自动写回', async () => {
  let finishA!: (value: RecordingWorkspaceContext) => void
  const puts: PutRecordingWorkspaceContextRequest[] = []
  const api = { getRecordingWorkspaceContext: (draftId: string) => draftId === id(1) ? new Promise<RecordingWorkspaceContext>(resolve => { finishA = resolve }) : Promise.resolve(saved(2)), putRecordingWorkspaceContext: async (request: PutRecordingWorkspaceContextRequest) => { puts.push(request); return saved(2) } }
  const controller = createRecordingWorkspaceController({ api })
  const a = controller.open(draft(1)); await controller.open(draft(2, 2)); finishA(saved(1)); await a
  assert.equal(controller.state.draftId, id(2)); assert.equal(controller.state.draftRevision, 2)
  assert.deepEqual(controller.state.selection, saved(2).selection)
  assert.deepEqual(controller.state.context?.staleReasons, saved(2).staleReasons)
  assert.deepEqual(puts, [])
  controller.dispose()
})

test('显式换规划才清下游；页面写与选择写按 contextRevision 串行', async () => {
  let finish!: (value: RecordingWorkspaceContext) => void
  const requests: PutRecordingWorkspaceContextRequest[] = []
  const api = {
    getRecordingWorkspaceContext: async () => saved(1),
    putRecordingWorkspaceContext: (request: PutRecordingWorkspaceContextRequest) => {
      requests.push(request)
      return requests.length === 1 ? new Promise<RecordingWorkspaceContext>(resolve => { finish = resolve }) : Promise.resolve({ ...saved(1, 3), selection: request.selection, pagePosition: request.pagePosition, staleReasons: [] })
    },
  }
  const controller = createRecordingWorkspaceController({ api }); await controller.open(draft(1))
  controller.choose({ planId: id(20) }); controller.navigate('media')
  assert.equal(requests.length, 1); assert.equal(requests[0]!.expectedContextRevision, 1)
  assert.deepEqual(requests[0]!.selection, { planId: id(20), path: 'logic' })
  finish({ ...saved(1, 2), selection: requests[0]!.selection, pagePosition: 'logic', staleReasons: [] })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(requests.length, 2); assert.equal(requests[1]!.expectedContextRevision, 2); assert.equal(requests[1]!.pagePosition, 'media')
  assert.equal(controller.state.context?.pagePosition, 'media'); controller.dispose()
})

test('写失败保留本地意图，重试使用同一命令身份', async () => {
  const requests: PutRecordingWorkspaceContextRequest[] = []
  let fail = true
  const api = { getRecordingWorkspaceContext: async () => null, putRecordingWorkspaceContext: async (request: PutRecordingWorkspaceContextRequest): Promise<RecordingWorkspaceContext> => {
    requests.push(request)
    if (fail) throw new Error('回执未知')
    return { draftId: request.draftId, draftRevision: request.expectedDraftRevision, contextRevision: 1, selection: request.selection, pagePosition: request.pagePosition, staleReasons: [] }
  } }
  const controller = createRecordingWorkspaceController({ api }); await controller.open(draft(1))
  controller.navigate('media'); await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(controller.state.status, 'error'); assert.equal(controller.state.pagePosition, 'media'); assert.ok(controller.state.pending)
  fail = false; await controller.retry()
  assert.equal(controller.state.status, 'ready'); assert.equal(controller.state.context?.pagePosition, 'media')
  assert.equal(requests[0]!.commandId, requests[1]!.commandId); controller.dispose()
})

test('A 未回执写入后切 B，A 回执不触发 B 的隐式写入', async () => {
  let finishA!: (value: RecordingWorkspaceContext) => void
  const requests: PutRecordingWorkspaceContextRequest[] = []
  const api = {
    getRecordingWorkspaceContext: async (draftId: string) => draftId === id(1) ? saved(1) : null,
    putRecordingWorkspaceContext: (request: PutRecordingWorkspaceContextRequest) => {
      requests.push(request)
      return new Promise<RecordingWorkspaceContext>(resolve => { finishA = resolve })
    },
  }
  const controller = createRecordingWorkspaceController({ api }); await controller.open(draft(1))
  controller.navigate('media'); await controller.open(draft(2))
  finishA({ ...saved(1, 2), pagePosition: 'media' }); await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(controller.state.draftId, id(2)); assert.equal(controller.state.context, null)
  assert.deepEqual(requests.map(request => request.draftId), [id(1)])
  controller.dispose()
})

test('从收藏带入具体副本后首次保存规划，仍保留同盘意图且不自动预留', async () => {
  const requests: PutRecordingWorkspaceContextRequest[] = []
  const api = {
    getRecordingWorkspaceContext: async () => null,
    putRecordingWorkspaceContext: async (request: PutRecordingWorkspaceContextRequest): Promise<RecordingWorkspaceContext> => {
      requests.push(request)
      return { draftId: request.draftId, draftRevision: request.expectedDraftRevision, contextRevision: request.expectedContextRevision + 1, selection: request.selection, pagePosition: request.pagePosition, staleReasons: [] }
    },
  }
  const controller = createRecordingWorkspaceController({ api }); await controller.open(draft(1))
  controller.choose({ selectedPhysicalId: 'MB-C-00001' })
  await new Promise<void>(resolve => setImmediate(resolve))
  controller.choose({ planId: id(20) })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(controller.state.selection.selectedPhysicalId, 'MB-C-00001')
  assert.equal(requests.at(-1)?.selection.selectedPhysicalId, 'MB-C-00001')
  assert.equal(requests.at(-1)?.selection.planId, id(20))
  controller.dispose()
})

test('旧草稿写入未回执期间，新草稿主动选择仍会串行保存', async () => {
  let finishA!: (value: RecordingWorkspaceContext) => void
  const requests: PutRecordingWorkspaceContextRequest[] = []
  const api = {
    getRecordingWorkspaceContext: async () => null,
    putRecordingWorkspaceContext: (request: PutRecordingWorkspaceContextRequest) => {
      requests.push(request)
      if (request.draftId === id(1)) return new Promise<RecordingWorkspaceContext>(resolve => { finishA = resolve })
      return Promise.resolve({ draftId: request.draftId, draftRevision: request.expectedDraftRevision, contextRevision: 1, selection: request.selection, pagePosition: request.pagePosition, staleReasons: [] })
    },
  }
  const controller = createRecordingWorkspaceController({ api }); await controller.open(draft(1))
  controller.navigate('media')
  await controller.open(draft(2))
  controller.choose({ selectedPhysicalId: 'MB-C-00002' })
  finishA({ draftId: id(1), draftRevision: 1, contextRevision: 1, selection: {}, pagePosition: 'media', staleReasons: [] })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(requests.map(request => request.draftId), [id(1), id(2)])
  assert.equal(controller.state.context?.selection.selectedPhysicalId, 'MB-C-00002')
  controller.dispose()
})

test('A 的排队等待者在切到未修改的 B 后不隐式写 B', async () => {
  let finishA!: (value: RecordingWorkspaceContext) => void
  const requests: PutRecordingWorkspaceContextRequest[] = []
  const api = {
    getRecordingWorkspaceContext: async () => null,
    putRecordingWorkspaceContext: (request: PutRecordingWorkspaceContextRequest) => {
      requests.push(request)
      return new Promise<RecordingWorkspaceContext>(resolve => { finishA = resolve })
    },
  }
  const controller = createRecordingWorkspaceController({ api }); await controller.open(draft(1))
  controller.navigate('media')
  controller.choose({ path: 'logic' })
  await controller.open(draft(2))
  finishA({ draftId: id(1), draftRevision: 1, contextRevision: 1, selection: {}, pagePosition: 'media', staleReasons: [] })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(requests.map(request => request.draftId), [id(1)])
  assert.equal(controller.state.draftId, id(2))
  assert.equal(controller.state.context, null)
  controller.dispose()
})
