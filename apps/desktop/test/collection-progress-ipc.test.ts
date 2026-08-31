import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { CoreIpcError } from '../src/main/core-supervisor.js'

test('完成度Main只注册六个只读入口，可信检查及严格DTO先于Core', async () => {
  const module = await import('../src/main/collection-progress-ipc.js').catch(() => ({}))
  assert.ok('installCollectionProgressReads' in module, '缺少完成度读取入口')
  const handlers = new Map<string, (event: boolean, value?: unknown) => unknown>(), calls: Array<[string, unknown]> = []
  let failure: Error | undefined
  ;(module as typeof import('../src/main/collection-progress-ipc.js')).installCollectionProgressReads({
    handle: (channel, handler) => handlers.set(channel, handler),
    requireTrusted: (trusted: boolean) => { if (!trusted) throw new Error('不可信Renderer') },
    supervisor: { request: (async (command: string, payload: unknown) => { if (failure) throw failure; calls.push([command, payload]); return { synthetic: true } }) as never },
  })
  const invoke = (channel: string, value?: unknown, trusted = true) => Promise.resolve().then(() => handlers.get(channel)!(trusted, value))
  assert.deepEqual([...handlers.keys()].sort(), ['wants', 'wantHistory', 'current', 'snapshots', 'snapshot', 'modelLengths'].map(name => `collectionProgress:${name}`).sort())
  const page = { offset: 0, limit: 25 }, id = randomUUID()
  await assert.rejects(invoke('collectionProgress:wants', { page }, false))
  await assert.rejects(invoke('collectionProgress:wants', { page, absolutePath: '/synthetic/private' }))
  await assert.rejects(invoke('collectionProgress:current', { revisionId: id, page: { ...page, limit: 26 } }))
  assert.equal(calls.length, 0)
  const cases: Array<[string, unknown]> = [['wants', { page }], ['wantHistory', { id, page }], ['current', { revisionId: id, page }], ['snapshots', { page }], ['snapshot', { id, page }], ['modelLengths', { modelId: id }]]
  for (const [name, payload] of cases) assert.deepEqual(await invoke(`collectionProgress:${name}`, payload), { synthetic: true })
  assert.deepEqual(calls, cases.map(([name, payload]) => [`collectionProgress.${name}`, payload]))
  failure = new Error('PRIVATE_SYNTHETIC_STACK')
  await assert.rejects(invoke('collectionProgress:wants', { page }), error => error instanceof Error && error.message.includes('[INVENTORY_UNAVAILABLE]') && !error.message.includes('PRIVATE_SYNTHETIC_STACK'))
  failure = new CoreIpcError('INVENTORY_CONFLICT', 'PRIVATE_SYNTHETIC_STACK')
  await assert.rejects(invoke('collectionProgress:wants', { page }), /INVENTORY_CONFLICT/u)
})
