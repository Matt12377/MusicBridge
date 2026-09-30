import assert from 'node:assert/strict'
import test from 'node:test'
import { PerformanceTraceRecorder } from '@music-bridge/contracts'
import { createPerformanceIpcBridge } from '../src/main/performance-ipc.js'
import { createPerformanceInteractions, createPerformanceInvoker, readPerformanceMetadata } from '../src/shared/performance-transport.js'

test('关闭性能诊断保留 IPC 参数和结果，不读取时钟或生成身份', async () => {
  const recorder = new PerformanceTraceRecorder({ component: 'renderer', now: () => { throw new Error('不得读取时钟') }, id: () => { throw new Error('不得生成身份') } })
  const payload = { query: '合成查询' }, result = { ready: true }
  const calls: unknown[][] = []
  const invoke = createPerformanceInvoker(async (...args) => { calls.push(args); return result }, recorder,
    () => { throw new Error('关闭时不得请求下一帧') },
    () => { throw new Error('关闭时不得读取交互回调') })
  assert.equal(await invoke('library:search', payload), result)
  assert.deepEqual(calls, [['library:search', payload]])
  assert.equal(recorder.snapshot().events.length, 0)
})

test('交互诊断回调故障保留业务调用次数、参数、结果和原错误', async () => {
  const recorder = new PerformanceTraceRecorder({ component: 'renderer', enabled: true })
  const payload = { query: '合成查询' }, result = { ready: true }, failure = new Error('原业务失败')
  const calls: unknown[][] = []
  let callbackCalls = 0
  const invoke = createPerformanceInvoker(async (...args) => {
    calls.push(args)
    if (args[0] === 'library:fail') throw failure
    return result
  }, recorder, () => { throw new Error('合成下一帧诊断故障') }, () => {
    callbackCalls++
    throw new Error('合成交互诊断故障')
  })
  assert.equal(await invoke('library:search', payload), result)
  await assert.rejects(invoke('library:fail', payload), error => error === failure)
  assert.equal(callbackCalls, 2)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map(args => args.slice(0, 2)), [['library:search', payload], ['library:fail', payload]])
  assert.ok(calls.every(args => readPerformanceMetadata(args.at(-1))))
  assert.equal(recorder.snapshot().inflightCount, 0)
  assert.deepEqual(recorder.snapshot().events.filter(event => event.phase === 'end').map(event => event.outcome), ['ok', 'error'])
})

test('并行 Renderer 请求贯通身份且 Main 异步上下文互不串线', async () => {
  const renderer = new PerformanceTraceRecorder({ component: 'renderer', enabled: true })
  const main = new PerformanceTraceRecorder({ component: 'main', enabled: true })
  const bridge = createPerformanceIpcBridge(main)
  const interactions = createPerformanceInteractions(renderer)
  const seen: Array<{ input: number; traceId: string }> = []
  const handler = bridge.wrap(async (_event: unknown, input: number) => {
    const before = bridge.context()!
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(bridge.context(), before)
    seen.push({ input, traceId: before.traceId })
    return input
  })
  const invoke = createPerformanceInvoker((channel, ...args) => handler({}, ...args), renderer, undefined, interactions.consume)
  const first = interactions.api.begin('playback')!, second = interactions.api.begin('library')!
  interactions.api.use(first)
  const a = invoke('playback:play', 1)
  interactions.api.use(second)
  const b = invoke('library:album', 2)
  assert.deepEqual(await Promise.all([a, b]), [1, 2])
  assert.deepEqual(seen, [{ input: 1, traceId: first.traceId }, { input: 2, traceId: second.traceId }])
  interactions.api.end(first); interactions.api.end(second)
  assert.equal(renderer.snapshot().inflightCount, 0)
  assert.equal(main.snapshot().inflightCount, 0)
  assert.equal(bridge.context(), undefined)
})

test('业务错误保持同一对象，诊断记录不含参数且未持有未知关联身份', async () => {
  const recorder = new PerformanceTraceRecorder({ component: 'renderer', enabled: true })
  const interactions = createPerformanceInteractions(recorder)
  const error = new Error('合成业务失败')
  interactions.api.use({ traceId: '伪造', requestId: '伪造' })
  assert.equal(interactions.consume(), undefined)
  const invoke = createPerformanceInvoker(async () => { throw error }, recorder)
  await assert.rejects(invoke('library:search', { cookie: '私人合成值', path: '/Users/private', url: 'https://private.invalid' }), value => value === error)
  assert.equal(recorder.snapshot().inflightCount, 0)
  assert.equal(recorder.snapshot().events.at(-1)?.outcome, 'error')
  assert.doesNotMatch(recorder.export(), /私人合成值|\/Users\/|https:/)
})

test('非法诊断元数据不被消费，合法诊断导出只接收 Renderer 白名单快照', () => {
  const recorder = new PerformanceTraceRecorder({ component: 'renderer', enabled: true })
  const context = recorder.context()!
  assert.equal(readPerformanceMetadata({ __musicBridgePerformance: 1, context, payload: '禁止' }), undefined)
  const result = readPerformanceMetadata({ __musicBridgePerformance: 1, context, renderer: { ...recorder.snapshot(), private: '禁止导出' } })
  assert.ok(result?.renderer)
  assert.doesNotMatch(JSON.stringify(result), /禁止导出|private/)
})

test('未经信任的 Renderer 不能覆盖导出的诊断快照', async () => {
  const main = new PerformanceTraceRecorder({ component: 'main', enabled: true })
  const renderer = new PerformanceTraceRecorder({ component: 'renderer', enabled: true })
  const bridge = createPerformanceIpcBridge(main)
  const rejection = new Error('原处理函数拒绝不可信来源')
  const handler = bridge.wrap(async (_event: { trusted: boolean }) => { throw rejection }, event => event.trusted)
  await assert.rejects(handler({ trusted: false }, { __musicBridgePerformance: 1, context: renderer.context(), renderer: renderer.snapshot() }), error => error === rejection)
  assert.equal(bridge.rendererSnapshot(), undefined)
  assert.equal(main.snapshot().inflightCount, 0)
})
