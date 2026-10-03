import assert from 'node:assert/strict'
import test from 'node:test'
import { observePackagedRendererIpc } from '../../src/main/packaged-renderer-ipc-observer.js'

const sender = { webContentsId: 7, rendererPid: 19, frameUrl: 'musicbridge://app/index.html', trusted: true as const }

test('候选 IPC 旁路绑定实际可信 sender 和请求回执，不改变同步返回对象或执行次数', () => {
  const events: { event: string; data: Record<string, unknown> }[] = [], result = { ok: true, outboxId: '合成回执' }
  let calls = 0
  const listener = observePackagedRendererIpc({ channel: 'commandOutbox:submit', trustedSender: () => sender,
    listener: (_event: boolean, value: { request: string }) => { calls++; assert.equal(value.request, '合成输入'); return result },
    observe: (event, data) => { events.push({ event, data }) } })
  assert.equal(listener(true, { request: '合成输入' }), result)
  assert.equal(calls, 1); assert.equal(events.length, 2)
  assert.equal(events[0]!.event, 'main.ipcRequest'); assert.equal(events[1]!.event, 'main.ipcReply')
  assert.deepEqual(events[0]!.data.args, [{ request: '合成输入' }])
  assert.deepEqual(events[0]!.data.sender, sender)
  assert.equal(events[0]!.data.invokeId, events[1]!.data.invokeId)
  assert.deepEqual(events[1]!.data.result, result)
})

test('候选 IPC 旁路保留原 Promise 身份和拒绝对象，失败只记录公共错误码', async () => {
  const failure = new Error('[OUTBOX_UNAVAILABLE] 合成私有栈不能记录'), promise = Promise.reject(failure), events: Record<string, unknown>[] = []
  const listener = observePackagedRendererIpc({ channel: 'collection:list', trustedSender: () => sender,
    listener: () => promise, observe: (event, data) => { events.push({ event, data }) } })
  assert.equal(listener(undefined), promise)
  await assert.rejects(promise, error => error === failure)
  await Promise.resolve()
  assert.equal(events.length, 2); assert.equal(events[1]!.event, 'main.ipcRejected')
  assert.equal((events[1]!.data as Record<string, unknown>).code, 'OUTBOX_UNAVAILABLE')
  assert.equal(JSON.stringify(events).includes('合成私有栈'), false)
})

test('观察者同步异常、异步拒绝及可信检测异常均不改变原结果', async () => {
  for (const observe of [() => { throw new Error('观察失败') }, () => Promise.reject(new Error('观察拒绝'))]) {
    let calls = 0
    const original = Promise.resolve({ saved: true })
    const listener = observePackagedRendererIpc({ channel: 'commandOutbox:acknowledge', trustedSender: () => sender,
      listener: () => { calls++; return original }, observe })
    assert.equal(listener(undefined), original); assert.deepEqual(await original, { saved: true }); assert.equal(calls, 1)
    await Promise.resolve()
  }
  const listener = observePackagedRendererIpc({ channel: 'collection:list', trustedSender: () => { throw new Error('信任检测失败') }, listener: () => 17,
    observe: () => { throw new Error('不能进入') } })
  assert.equal(listener(undefined), 17)
})

test('原同步异常必须是同一对象，未知异常只记录固定公共码', () => {
  const failure = new Error('私有内容'), events: Record<string, unknown>[] = []
  const listener = observePackagedRendererIpc({ channel: 'collection:detail', trustedSender: () => sender,
    listener: () => { throw failure }, observe: (event, data) => { events.push({ event, data }) } })
  assert.throws(() => listener(undefined), error => error === failure)
  assert.equal(events.length, 2)
  assert.equal((events[1]!.data as Record<string, unknown>).code, 'INTERNAL_ERROR')
})

test('不可信请求和非冻结渠道没有候选 IPC 观察，但原 listener 照常执行一次', () => {
  for (const [channel, trusted] of [['collection:list', false], ['auth:set-credential', true]]) {
    let calls = 0, observations = 0
    const listener = observePackagedRendererIpc({ channel: String(channel), trustedSender: () => trusted ? sender : undefined,
      listener: () => ++calls, observe: () => { observations++ } })
    assert.equal(listener(undefined), 1); assert.equal(observations, 0)
  }
})

test('观察 DTO 的克隆不能反向改写原参数或成功结果', () => {
  const input = { page: { offset: 0, limit: 24 } }, result = { total: 26 }
  const listener = observePackagedRendererIpc({ channel: 'collection:list', trustedSender: () => sender,
    listener: (_event: unknown, value: typeof input) => { assert.equal(value, input); assert.equal(value.page.offset, 0); return result },
    observe: (_event, data) => {
      if (Array.isArray(data.args)) (data.args[0] as typeof input).page.offset = 900
      if (data.result) (data.result as typeof result).total = 900
    } })
  assert.equal(listener(undefined, input), result); assert.equal(result.total, 26); assert.equal(input.page.offset, 0)
})
