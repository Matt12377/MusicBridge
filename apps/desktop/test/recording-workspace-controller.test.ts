import assert from 'node:assert/strict'
import test from 'node:test'
import type { MasterDraft, PutRecordingWorkspaceContextRequest, RecordingWorkspaceContext } from '@music-bridge/contracts'
import { createRecordingWorkspaceController } from '../src/renderer/src/components/recording/recording-workspace-controller.js'

const id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`
const draft = (n: number, revision = 1): MasterDraft => ({ id: id(n), title: '合成草稿', revision, status: 'draft', programType: 'compilation', trackCount: 0, tracks: [], sourceLockEligible: false })
const saved = (n: number, contextRevision = 1): RecordingWorkspaceContext => ({ draftId: id(n), draftRevision: 1, contextRevision, selection: { planId: id(10), layoutId: id(11), path: 'logic', preparationId: id(12), preparedId: id(13) }, pagePosition: 'logic', staleReasons: [{ field: 'planId', reason: 'plan-changed' }] })

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
