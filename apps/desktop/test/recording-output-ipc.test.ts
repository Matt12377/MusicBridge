import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { CoreIpcError } from '../src/main/core-supervisor.js'

test('输出Main只注册三个无设备读取入口，先验证可信Renderer和完整DTO', async () => {
  const module = await import('../src/main/recording-output-ipc.js').catch(() => ({}))
  assert.ok('installRecordingOutputReads' in module, '缺少受限输出检查Main入口')
  const handlers = new Map<string, (event: boolean, value?: unknown) => unknown>(), calls: Array<[string, unknown]> = []
  let failure: Error | undefined
  ;(module as typeof import('../src/main/recording-output-ipc.js')).installRecordingOutputReads({
    handle: (channel, handler) => handlers.set(channel, handler),
    requireTrusted: (trusted: boolean) => { if (!trusted) throw new Error('不可信Renderer') },
    supervisor: { request: (async (command: string, payload: unknown) => { if (failure) throw failure; calls.push([command, payload]); return { synthetic: true } }) as never },
  })
  const invoke = (name: string, payload: unknown, trusted = true) => Promise.resolve().then(() => handlers.get(`recordingOutput:${name}`)!(trusted, payload))
  assert.deepEqual([...handlers.keys()].sort(), ['recordingOutput:cancel', 'recordingOutput:check', 'recordingOutput:status'])
  const runId = randomUUID(), check = { runId, planVersionId: randomUUID(), side: 'Program' }
  for (const [name, payload] of [['status', {}], ['check', check], ['cancel', { runId }]] as const) await assert.rejects(invoke(name, payload, false), /不可信Renderer/u)
  for (const [name, payload] of [['status', { device: 'default' }], ['check', { ...check, path: '/private/audio' }], ['check', { ...check, side: 'all' }], ['check', { ...check, certified: true }], ['cancel', { id: runId }]] as const) await assert.rejects(invoke(name, payload), /INVALID_IPC_REQUEST/u)
  assert.equal(calls.length, 0)
  const cases: Array<[string, unknown]> = [['status', {}], ['check', check], ['cancel', { runId }]]
  for (const [name, payload] of cases) assert.deepEqual(await invoke(name, payload), { synthetic: true })
  assert.deepEqual(calls, cases.map(([name, payload]) => [`recordingOutput.${name}`, payload]))
  failure = new Error('PRIVATE_SYNTHETIC_STACK')
  await assert.rejects(invoke('check', check), error => error instanceof Error && error.message.includes('[INVENTORY_UNAVAILABLE]') && !error.message.includes('PRIVATE_SYNTHETIC_STACK'))
  failure = new CoreIpcError('INVENTORY_CONFLICT', 'PRIVATE_SYNTHETIC_STACK')
  await assert.rejects(invoke('check', check), error => error instanceof Error && error.message.includes('[INVENTORY_CONFLICT]') && !error.message.includes('PRIVATE_SYNTHETIC_STACK'))
})
