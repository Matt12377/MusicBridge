import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { CoreIpcError } from '../src/main/core-supervisor.js'

test('计划Main只注册五个读取入口，先验证可信来源和DTO，freeze只能走outbox', async () => {
  const module = await import('../src/main/recording-plan-ipc.js').catch(() => ({}))
  assert.ok('installRecordingPlanReads' in module, '缺少安全计划读取入口')
  const handlers = new Map<string, (event: boolean, value?: unknown) => unknown>(), calls: Array<[string, unknown]> = []
  let failure: Error | undefined
  ;(module as typeof import('../src/main/recording-plan-ipc.js')).installRecordingPlanReads({
    handle: (channel, handler) => handlers.set(channel, handler),
    requireTrusted: (trusted: boolean) => { if (!trusted) throw new Error('不可信Renderer') },
    supervisor: { request: (async (command: string, payload: unknown) => { if (failure) throw failure; calls.push([command, payload]); return { synthetic: true } }) as never },
  })
  const invoke = (name: string, value: unknown, trusted = true) => Promise.resolve().then(() => handlers.get(`recordingPlans:${name}`)!(trusted, value))
  assert.deepEqual([...handlers.keys()].sort(), ['list','version','preview','preflight','cancelRead'].map(n => `recordingPlans:${n}`).sort())
  const id = randomUUID(), selection = { assetId: id, archiveOperationId: id }
  await assert.rejects(invoke('list', { draftId: id }, false))
  await assert.rejects(invoke('preview', { readId: id, selection, certified: true }))
  await assert.rejects(invoke('preflight', { readId: id, planVersionId: id, absolutePath: '/synthetic/private' }))
  assert.equal(calls.length, 0)
  const cases: Array<[string, unknown]> = [['list',{ draftId: id }],['version',{ id }],['preview',{ readId: id, selection }],['preflight',{ readId: id, planVersionId: id }],['cancelRead',{ id }]]
  for (const [name, payload] of cases) assert.deepEqual(await invoke(name, payload), { synthetic: true })
  assert.deepEqual(calls, cases.map(([name, payload]) => [`recordingPlans.${name}`, payload]))
  failure = new Error('PRIVATE_SYNTHETIC_STACK')
  await assert.rejects(invoke('list', { draftId: id }), error => error instanceof Error && error.message.includes('[INVENTORY_UNAVAILABLE]') && !error.message.includes('PRIVATE_SYNTHETIC_STACK'))
  failure = new CoreIpcError('INVENTORY_CONFLICT', 'PRIVATE_SYNTHETIC_STACK')
  await assert.rejects(invoke('list', { draftId: id }), /INVENTORY_CONFLICT/u)
})
