import assert from 'node:assert/strict'
import test from 'node:test'
import { createCoreShutdownReceipt } from '../../src/shared/core-shutdown-receipt.js'
import { attachCoreRuntimePort, type CoreRuntimeForIpc, type UtilityPort } from '../../src/utility-main.js'

const success = (id: string) => ({ version: 1, id, ok: true, result: { stopped: true } })
const receipt = (requestId: string) => ({ version: 1, type: 'musicbridge.core-shutdown-received', requestId })
const turn = () => new Promise<void>(resolve => setImmediate(resolve))

class FakePort implements UtilityPort {
  readonly messages: unknown[] = []
  private listener: ((event: { data: unknown }) => void) | undefined
  on(_event: 'message', listener: (event: { data: unknown }) => void): void { this.listener = listener }
  start(): void {}
  postMessage(message: unknown): void { this.messages.push(message) }
  send(message: unknown): void { this.listener?.({ data: message }) }
}

function runtime(shutdown: () => Promise<void> = async () => {}): CoreRuntimeForIpc {
  return { async start() {}, shutdown, ping: () => ({ pong: true }), getPlaybackEventProtocol: () => null,
    getState: () => ({ runtime: 'ready', roon: 'disconnected', provider: 'missing', activeStreamCount: 0, activePlaybackPresent: false }),
  } as unknown as CoreRuntimeForIpc
}

test('关闭握手仅接受原端口、原成功关闭编号和严格闭集确认，重复确认只生效一次', () => {
  const port = new FakePort(), other = new FakePort()
  let confirmed = 0, getterCalls = 0
  const controller = createCoreShutdownReceipt(port, () => { confirmed++ })
  assert.equal(controller.receive(port, receipt('close-1')), true)
  assert.equal(confirmed, 0)
  controller.postSuccess('close-1', success('close-1'))
  assert.equal(confirmed, 0)
  const accessor = { version: 1, type: 'musicbridge.core-shutdown-received' }
  Object.defineProperty(accessor, 'requestId', { enumerable: true, get() { getterCalls++; return 'close-1' } })
  for (const [source, frame] of [
    [other, receipt('close-1')], [port, receipt('other')], [port, { ...receipt('close-1'), extra: true }],
    [port, { ...receipt('close-1'), version: 2 }], [port, accessor], [port, { ...receipt('close-1'), [Symbol('extra')]: true }],
  ] as const) assert.equal(controller.receive(source, frame), true)
  assert.equal(confirmed, 0); assert.equal(getterCalls, 0)
  assert.equal(controller.isConfirmed(), false)
  assert.equal(controller.receive(port, receipt('close-1')), true)
  assert.equal(controller.isConfirmed(), true); assert.equal(confirmed, 1)
  controller.receive(port, receipt('close-1'))
  assert.equal(confirmed, 1)
  controller.postSuccess('close-2', success('close-2'))
  controller.receive(port, receipt('close-2'))
  assert.equal(port.messages.length, 2); assert.equal(confirmed, 1)
})

test('关闭失败、不同编号及非闭集成功结果不能登记退出资格', () => {
  const port = new FakePort()
  let confirmed = 0
  const controller = createCoreShutdownReceipt(port, () => { confirmed++ })
  for (const response of [
    { version: 1, id: 'close-1', ok: false, error: { code: 'INTERNAL_ERROR' } },
    success('other'), { ...success('close-1'), result: { stopped: false } },
    { ...success('close-1'), result: { stopped: true, extra: true } }, { ...success('close-1'), extra: true },
  ]) assert.throws(() => controller.postSuccess('close-1', response))
  controller.receive(port, receipt('close-1'))
  assert.equal(confirmed, 0); assert.equal(port.messages.length, 0)
})

test('关闭回执发送失败撤销确认；同步回入的确认也不能提前取得退出资格', () => {
  let confirmed = 0
  const failure = new Error('合成发送失败')
  const port = { postMessage() { controller.receive(port, receipt('close-1')); throw failure } }
  const controller = createCoreShutdownReceipt(port, () => { confirmed++ })
  assert.throws(() => controller.postSuccess('close-1', success('close-1')), error => error === failure)
  controller.receive(port, receipt('close-1'))
  assert.equal(confirmed, 0); assert.equal(controller.isConfirmed(), false)
})

test('重复成功关闭回应继续发送，但不能替换原确认编号或撤销已发送的原收据', () => {
  const port = new FakePort()
  let confirmed = 0
  const controller = createCoreShutdownReceipt(port, () => { confirmed++ })
  controller.postSuccess('close-1', success('close-1'))
  controller.postSuccess('close-2', success('close-2'))
  controller.postSuccess('close-1', success('close-1'))
  assert.deepEqual(port.messages, [success('close-1'), success('close-2'), success('close-1')])
  controller.receive(port, receipt('close-2'))
  assert.equal(confirmed, 0)
  controller.cancel('other'); controller.cancel('close-1')
  controller.receive(port, receipt('close-2')); assert.equal(confirmed, 0)
  controller.receive(port, receipt('close-1'))
  assert.equal(confirmed, 1)
  controller.cancel('close-1'); controller.receive(port, receipt('close-1'))
  assert.equal(controller.isConfirmed(), true); assert.equal(confirmed, 1)
})

for (const received of [false, true]) test(`重复发送失败和其取消不能抹掉原${received ? '已确认' : '待确认'}成功收据`, () => {
  let confirmed = 0, failing = false
  const failure = new Error('合成重复回应发送失败')
  const port = { postMessage() { if (failing) throw failure } }
  const controller = createCoreShutdownReceipt(port, () => { confirmed++ })
  controller.postSuccess('close-1', success('close-1'))
  if (received) controller.receive(port, receipt('close-1'))
  failing = true
  assert.throws(() => controller.postSuccess('close-1', success('close-1')), error => error === failure)
  controller.cancel('close-1')
  assert.equal(controller.isConfirmed(), received)
  assert.throws(() => controller.postSuccess('close-2', success('close-2')), error => error === failure)
  controller.cancel('close-2'); controller.receive(port, receipt('close-2'))
  assert.equal(confirmed, Number(received))
  controller.receive(port, receipt('close-1'))
  assert.equal(controller.isConfirmed(), true); assert.equal(confirmed, 1)
})

test('生产Utility关闭回执发出后继续存活，原Main确认到达后才安排exit0', async t => {
  const exits: (number | string | null | undefined)[] = []
  t.mock.method(process, 'exit', (code?: number | string | null) => { exits.push(code); return undefined as never })
  const port = new FakePort()
  let calls = 0
  await attachCoreRuntimePort(port, runtime(async () => { calls++ }), { exitAfterShutdown: true })
  port.send(receipt('shutdown-1'))
  port.send({ version: 1, id: 'ping-1', command: 'core.ping', payload: {} })
  await turn(); port.send(receipt('ping-1')); await turn()
  assert.equal(calls, 0); assert.deepEqual(exits, [])
  port.send({ version: 1, id: 'shutdown-1', command: 'core.shutdown', payload: {} })
  await turn(); await turn()
  assert.equal(calls, 1)
  assert.deepEqual(port.messages.at(-1), success('shutdown-1'))
  assert.deepEqual(exits, [])
  const count = port.messages.length
  port.send(receipt('other')); port.send({ ...receipt('shutdown-1'), extra: true }); await turn()
  assert.deepEqual(exits, []); assert.equal(port.messages.length, count)
  port.send(receipt('shutdown-1')); await turn()
  assert.deepEqual(exits, [0])
  port.send(receipt('shutdown-1')); await turn()
  assert.deepEqual(exits, [0])
})

test('生产Utility实际关闭失败时，匹配编号的Main确认仍不能退出', async t => {
  const exits: unknown[] = []
  t.mock.method(process, 'exit', (code?: number | string | null) => { exits.push(code); return undefined as never })
  const port = new FakePort()
  await attachCoreRuntimePort(port, runtime(async () => { throw new Error('合成关闭失败') }), { exitAfterShutdown: true })
  port.send({ version: 1, id: 'shutdown-failed', command: 'core.shutdown', payload: {} })
  await turn()
  const response = port.messages.at(-1) as { id: string; ok: boolean }
  assert.equal(response.id, 'shutdown-failed'); assert.equal(response.ok, false)
  const count = port.messages.length
  port.send(receipt('shutdown-failed')); await turn()
  assert.deepEqual(exits, []); assert.equal(port.messages.length, count)
})

test('生产Utility重复回应发送失败后的cancel保留原成功回应的ACK退出资格', async t => {
  const exits: unknown[] = [], port = new FakePort()
  t.mock.method(process, 'exit', (code?: number | string | null) => { exits.push(code); return undefined as never })
  const post = port.postMessage.bind(port)
  let successes = 0
  t.mock.method(port, 'postMessage', (message: unknown) => {
    if ((message as { id?: string; ok?: boolean }).id === 'shutdown-1'
      && (message as { ok?: boolean }).ok === true && ++successes === 2) throw new Error('合成重复成功回应发送失败')
    post(message)
  })
  await attachCoreRuntimePort(port, runtime(), { exitAfterShutdown: true })
  const request = { version: 1, id: 'shutdown-1', command: 'core.shutdown', payload: {} }
  port.send(request); await turn(); await turn()
  assert.deepEqual(port.messages.at(-1), success('shutdown-1'))
  port.send(request); await turn(); await turn()
  assert.equal(successes, 2)
  assert.equal((port.messages.at(-1) as { ok: boolean }).ok, false)
  assert.deepEqual(exits, [])
  port.send(receipt('shutdown-1')); await turn()
  assert.deepEqual(exits, [0])
  port.send(receipt('shutdown-1')); await turn()
  assert.deepEqual(exits, [0])
})

test('非退出测试运行也消费私有关闭确认，不把确认交给通用IPC或调用exit', async t => {
  const exits: unknown[] = []
  t.mock.method(process, 'exit', (code?: number | string | null) => { exits.push(code); return undefined as never })
  const port = new FakePort()
  await attachCoreRuntimePort(port, runtime(), { exitAfterShutdown: false })
  port.send({ version: 1, id: 'shutdown-test', command: 'core.shutdown', payload: {} })
  await turn()
  const count = port.messages.length
  port.send(receipt('shutdown-test')); await turn()
  assert.equal(port.messages.length, count); assert.deepEqual(exits, [])
})
