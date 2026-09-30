import assert from 'node:assert/strict'
import test from 'node:test'
import { createLibraryReadBroker } from '../src/main/library-read-ipc.js'
import { CoreIpcError, type CoreSupervisor } from '../src/main/core-supervisor.js'
const value = { id: 'read-1', command: 'library.search', payload: { query: 'x', page: { offset: 0, limit: 24 } }, deadlineAtMs: Date.now() + 1000 }

test('MBP-002：Main 读取白名单拒绝写命令、未知字段与原参数非法值', async () => {
  let calls = 0
  const supervisor = { request: async () => { calls++; return [] } } as unknown as Pick<CoreSupervisor, 'request'>
  const broker = createLibraryReadBroker(supervisor)
  for (const input of [{ ...value, command: 'playback.stop', payload: {} }, { ...value, extra: true }, { ...value, deadlineAtMs: 1.5 }, { ...value, payload: { query: 'x', page: { offset: -1, limit: 24 } } }]) {
    await assert.rejects(broker.read(1, input), error => error instanceof CoreIpcError && error.code === 'INVALID_IPC_REQUEST')
  }
  assert.equal(calls, 0); assert.deepEqual(await broker.read(1, value), []); assert.equal(calls, 1)
})
test('MBP-002：取消仅对原窗口读取生效，旧 finally 不清除新 ID', async () => {
  const signals: AbortSignal[] = []; const finish: Array<(value: unknown) => void> = []
  const supervisor = { request: (_command: unknown, _payload: unknown, _scope: unknown, read: { signal: AbortSignal }) => {
    signals.push(read.signal); return new Promise(resolve => { finish.push(resolve) })
  } } as unknown as Pick<CoreSupervisor, 'request'>
  const broker = createLibraryReadBroker(supervisor); const pending = broker.read(1, value)
  assert.throws(() => broker.cancel(2, value.id), /其他窗口/u); assert.equal(signals[0]!.aborted, false)
  await assert.rejects(broker.read(1, value), /冲突/u); broker.cancel(1, value.id); assert.equal(signals[0]!.aborted, true)
  finish[0]!('old'); assert.equal(await pending, 'old'); const next = broker.read(1, value); broker.cancelOwner(2); assert.equal(signals[1]!.aborted, false)
  broker.cancelOwner(1); assert.equal(signals[1]!.aborted, true); finish[1]!('new'); assert.equal(await next, 'new')
})
