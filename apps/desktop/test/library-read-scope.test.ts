import assert from 'node:assert/strict'
import test from 'node:test'
import type { IpcCommandResults, LibraryReadCommand, LibraryReadRequest, RoonLibraryPage } from '@music-bridge/contracts'
import type { MusicBridgePublicApi } from '../src/preload/api.js'
import {
  createLibraryReadScope, isLibraryReadCancelled,
} from '../src/renderer/src/composables/libraryReadScope.js'

type ReadApi = Pick<MusicBridgePublicApi, 'readLibrary' | 'cancelLibraryRead'>
type Timer = ReturnType<typeof setTimeout>
const command = 'roon.library.albums' as const
const payload = { page: { offset: 0, limit: 24 } }
const page = (title: string): RoonLibraryPage => ({
  items: [{ kind: 'album', reference: title, title }], offset: 0, limit: 24, hasMore: false,
})
function deferred<T>() {
  let resolve!: (result: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject })
  return { promise, resolve, reject }
}
function protocol(read: (request: LibraryReadRequest) => Promise<unknown>, cancel: (id: string) => Promise<void>): ReadApi {
  return {
    readLibrary: <C extends LibraryReadCommand>(request: LibraryReadRequest<C>) =>
      read(request) as Promise<IpcCommandResults[C]>,
    cancelLibraryRead: cancel,
  }
}
function harness(api: ReadApi = {}) {
  let time = 50_000, ids = 0, clockReads = 0
  const timers = new Map<Timer, { operation: () => void; at: number; delay: number }>()
  const scope = createLibraryReadScope(api, {
    now: () => { clockReads += 1; return time },
    createId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
    schedule: (operation, delay) => {
      const timer = {} as Timer
      timers.set(timer, { operation, at: time + delay, delay })
      return timer
    },
    unschedule: timer => { timers.delete(timer) },
  })
  return {
    scope, timers,
    get ids() { return ids },
    get clockReads() { return clockReads },
    get time() { return time },
    setTimeWithoutTimers: (value: number) => { time = value },
    advance: (ms: number) => {
      time += ms
      for (const [timer, task] of [...timers]) if (task.at <= time) { timers.delete(timer); task.operation() }
    },
  }
}
const code = (expected: string) => (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === expected

test('MBP-002：任一可选能力缺失都仅调用一次具名 API，不分配读取 ID', async () => {
  let unsupportedReads = 0, unsupportedCancels = 0
  const partialRead = protocol(async () => { unsupportedReads += 1; return page('不能调用') }, async () => undefined)
  const cases: ReadApi[] = [{}, { readLibrary: partialRead.readLibrary }, { cancelLibraryRead: async () => { unsupportedCancels += 1 } }]
  for (const api of cases) {
    const state = harness(api)
    let fallbacks = 0
    const result = await state.scope.read(command, payload, async () => { fallbacks += 1; return page('旧 API') })
    assert.equal(result.items[0]?.title, '旧 API')
    assert.equal(fallbacks, 1)
    assert.equal(state.ids, 0)
    assert.equal(state.timers.size, 0)
    state.scope.cancelAll()
  }
  assert.equal(unsupportedReads, 0)
  assert.equal(unsupportedCancels, 0)
})

test('MBP-002：新协议只发送四字段、随机独立 ID 与不超过十秒的本机期限', async () => {
  const requests: LibraryReadRequest[] = []
  const state = harness(protocol(async request => { requests.push(request); return page('新协议') }, async () => undefined))
  let fallbacks = 0
  const fallback = async () => { fallbacks += 1; return page('不能回退') }
  const controller = new AbortController()
  await state.scope.read(command, payload, fallback, { signal: controller.signal })
  await state.scope.read(command, payload, fallback)
  assert.equal(requests.length, 2)
  assert.notEqual(requests[0]?.id, requests[1]?.id)
  for (const request of requests) {
    assert.deepEqual(Object.keys(request).sort(), ['command', 'deadlineAtMs', 'id', 'payload'])
    assert.equal(request.command, command)
    assert.deepEqual(request.payload, payload)
    assert.equal(request.deadlineAtMs, 60_000)
  }
  assert.equal(fallbacks, 0)
  assert.equal(state.timers.size, 0)
})

test('MBP-002：cancelAll 立即结束自己的等待，迟到回执不能影响新请求', async () => {
  const requests: LibraryReadRequest[] = [], cancelled: string[] = []
  const waits = [deferred<RoonLibraryPage>(), deferred<RoonLibraryPage>(), deferred<RoonLibraryPage>()]
  const state = harness(protocol(request => { requests.push(request); return waits[requests.length - 1]!.promise }, async id => { cancelled.push(id) }))
  const first = state.scope.read(command, payload, async () => page('不能回退'))
  const second = state.scope.read(command, payload, async () => page('不能回退'))
  const rejected = [assert.rejects(first, code('CANCELLED')), assert.rejects(second, code('CANCELLED'))]
  state.scope.cancelAll()
  await Promise.all(rejected)
  assert.deepEqual(cancelled, requests.map(request => request.id))
  assert.equal(state.timers.size, 0)
  const newer = state.scope.read(command, payload, async () => page('不能回退'))
  waits[0]!.resolve(page('旧结果'))
  waits[1]!.reject(new Error('旧失败'))
  await Promise.resolve()
  assert.equal(state.timers.size, 1)
  waits[2]!.resolve(page('新结果'))
  assert.equal((await newer).items[0]?.title, '新结果')
  assert.equal(state.timers.size, 0)
  assert.equal(cancelled.length, 2)
})

test('MBP-002：同载荷的不同 Renderer 消费者只取消各自 readId', async () => {
  const requests: LibraryReadRequest[] = [], cancelled: string[] = []
  const waits = [deferred<RoonLibraryPage>(), deferred<RoonLibraryPage>()]
  const api = protocol(request => { requests.push(request); return waits[requests.length - 1]!.promise }, async id => { cancelled.push(id) })
  const firstScope = harness(api)
  // 使用不同实际 ID；Core 的 flight 去重属于另一层，不能由两个 Renderer 调用数冒充。
  const second = createLibraryReadScope(api, { createId: () => '00000000-0000-4000-8000-000000000099' })
  const firstWait = firstScope.scope.read(command, payload, async () => page('不能回退'))
  const secondWait = second.read(command, payload, async () => page('不能回退'))
  const firstRejected = assert.rejects(firstWait, code('CANCELLED'))
  firstScope.scope.cancelAll()
  await firstRejected
  assert.deepEqual(cancelled, [requests[0]!.id])
  assert.notEqual(requests[0]!.id, requests[1]!.id)
  waits[1]!.resolve(page('另一消费者'))
  assert.equal((await secondWait).items[0]?.title, '另一消费者')
  second.dispose()
  assert.deepEqual(cancelled, [requests[0]!.id])
})

test('MBP-002：已取消 Signal 不读时钟、不生成 ID，也不派发新旧 API', async () => {
  let calls = 0
  const state = harness(protocol(async () => { calls += 1; return page('不能调用') }, async () => undefined))
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(state.scope.read(command, payload, async () => { calls += 1; return page('不能调用') }, { signal: controller.signal }), code('CANCELLED'))
  assert.equal(calls, 0)
  assert.equal(state.clockReads, 0)
  assert.equal(state.ids, 0)
  assert.equal(state.timers.size, 0)
})

test('MBP-002：读取完成或失败释放 Signal 监听与计时器', async () => {
  const controller = new AbortController()
  const signal = controller.signal
  const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal)
  let listeners = 0
  signal.addEventListener = ((...args: Parameters<AbortSignal['addEventListener']>) => { listeners += 1; add(...args) }) as AbortSignal['addEventListener']
  signal.removeEventListener = ((...args: Parameters<AbortSignal['removeEventListener']>) => { listeners -= 1; remove(...args) }) as AbortSignal['removeEventListener']
  const original = new Error('原业务失败'), cancelled: string[] = []
  let fail = false
  const state = harness(protocol(async () => { if (fail) throw original; return page('完成') }, async id => { cancelled.push(id) }))
  await state.scope.read(command, payload, async () => page('不能回退'), { signal })
  assert.equal(listeners, 0)
  fail = true
  await assert.rejects(state.scope.read(command, payload, async () => page('不能回退'), { signal }), error => error === original)
  assert.equal(listeners, 0)
  assert.equal(state.timers.size, 0)
  controller.abort()
  state.scope.cancelAll()
  assert.deepEqual(cancelled, [])
})

test('MBP-002：Signal 中途取消立即终态，取消确认同步或异步失败均隔离', async () => {
  for (const mode of ['同步失败', '异步失败']) {
    const waiting = deferred<RoonLibraryPage>(), cancelled: string[] = []
    const state = harness(protocol(() => waiting.promise, id => {
      cancelled.push(id)
      if (mode === '同步失败') throw new Error('合成取消通道失败')
      return Promise.reject(new Error('合成取消通道失败'))
    }))
    const controller = new AbortController()
    const pending = state.scope.read(command, payload, async () => page('不能回退'), { signal: controller.signal })
    const rejected = assert.rejects(pending, code('CANCELLED'))
    controller.abort()
    await rejected
    assert.equal(cancelled.length, 1)
    assert.equal(state.timers.size, 0)
    state.scope.cancelAll()
    waiting.reject(new Error('取消后的迟到失败'))
    await Promise.resolve()
    assert.equal(cancelled.length, 1)
  }
})

test('MBP-002：期限到达给 TIMEOUT 而非 CANCELLED，发送一次取消且不重放 fallback', async () => {
  const waiting = deferred<RoonLibraryPage>(), cancelled: string[] = []
  let fallbacks = 0
  const state = harness(protocol(() => waiting.promise, async id => { cancelled.push(id) }))
  const pending = state.scope.read(command, payload, async () => { fallbacks += 1; return page('不能回退') })
  const rejected = assert.rejects(pending, error => code('TIMEOUT')(error) && !isLibraryReadCancelled(error))
  state.advance(10_000)
  await rejected
  assert.equal(cancelled.length, 1)
  assert.equal(fallbacks, 0)
  assert.equal(state.timers.size, 0)
  waiting.resolve(page('超时后的旧结果'))
  await Promise.resolve()
  assert.equal(cancelled.length, 1)
})

test('MBP-002：绝对期限已到而 timer 未执行时迟到成功仍为 TIMEOUT', async () => {
  for (const useProtocol of [true, false]) {
    const waiting = deferred<RoonLibraryPage>(), cancelled: string[] = []
    const state = harness(useProtocol ? protocol(() => waiting.promise, async id => { cancelled.push(id) }) : {})
    const pending = state.scope.read(command, payload, () => waiting.promise)
    const rejected = assert.rejects(pending, code('TIMEOUT'))
    state.setTimeWithoutTimers(state.time + 10_000)
    assert.equal(state.timers.size, 1)
    waiting.resolve(page('不能接受的迟到成功'))
    await rejected
    assert.equal(cancelled.length, useProtocol ? 1 : 0)
    assert.equal(state.timers.size, 0)
  }
})

test('MBP-002：指定期限只能缩短十秒预算，过期请求零 API 派发', async () => {
  const requests: LibraryReadRequest[] = [], waiting = deferred<RoonLibraryPage>()
  const state = harness(protocol(request => { requests.push(request); return waiting.promise }, async () => undefined))
  const short = state.scope.read(command, payload, async () => page('不能回退'), { deadlineAtMs: state.time + 30 })
  const shortRejected = assert.rejects(short, code('TIMEOUT'))
  assert.equal(requests[0]!.deadlineAtMs, 50_030)
  state.advance(30)
  await shortRejected
  const long = state.scope.read(command, payload, async () => page('不能回退'), { deadlineAtMs: state.time + 20_000 })
  assert.equal(requests[1]!.deadlineAtMs, 60_030)
  assert.equal([...state.timers.values()][0]?.delay, 10_000)
  const longRejected = assert.rejects(long, code('CANCELLED'))
  state.scope.cancelAll()
  await longRejected
  const previousIds = state.ids
  await assert.rejects(state.scope.read(command, payload, async () => page('不能调用'), { deadlineAtMs: state.time }), code('TIMEOUT'))
  assert.equal(state.ids, previousIds)
  assert.equal(requests.length, 2)
})

test('MBP-002：协议同步与异步普通错误保持原错误对象，新协议失败不回退', async () => {
  for (const mode of ['同步失败', '异步失败']) {
    const original = new Error('原业务错误'), requests: LibraryReadRequest[] = []
    let fallbacks = 0
    const state = harness(protocol(request => {
      requests.push(request)
      if (mode === '同步失败') throw original
      return Promise.reject(original)
    }, async () => undefined))
    await assert.rejects(state.scope.read(command, payload, async () => { fallbacks += 1; return page('不能回退') }), error => error === original)
    assert.equal(requests.length, 1)
    assert.equal(fallbacks, 0)
    assert.equal(state.timers.size, 0)
  }
})

test('MBP-002：旧能力仍可结束本地等待，迟到失败被消费且不发送取消 IPC', async () => {
  const waiting = deferred<RoonLibraryPage>(), state = harness()
  let fallbacks = 0
  const pending = state.scope.read(command, payload, () => { fallbacks += 1; return waiting.promise })
  const rejected = assert.rejects(pending, code('CANCELLED'))
  state.scope.cancelAll()
  await rejected
  waiting.reject(new Error('旧能力的迟到失败'))
  await Promise.resolve()
  assert.equal(fallbacks, 1)
  assert.equal(state.ids, 0)
  assert.equal(state.timers.size, 0)
})

test('MBP-002：dispose 可重复调用且永久拒绝新读取，cancelAll 后可重新读取', async () => {
  const state = harness()
  state.scope.cancelAll()
  await state.scope.read(command, payload, async () => page('仍可读取'))
  const clockReads = state.clockReads
  state.scope.dispose()
  state.scope.dispose()
  let calls = 0
  await assert.rejects(state.scope.read(command, payload, async () => { calls += 1; return page('不能调用') }), code('CANCELLED'))
  assert.equal(calls, 0)
  assert.equal(state.clockReads, clockReads)
  assert.equal(state.timers.size, 0)
})

test('MBP-002：只有 CANCELLED 静默，桥接错误前缀和本地错误均可识别', () => {
  assert.equal(isLibraryReadCancelled({ code: 'CANCELLED' }), true)
  assert.equal(isLibraryReadCancelled(new Error("Error invoking remote method 'library:read': [CANCELLED] 已取消")), true)
  assert.equal(isLibraryReadCancelled({ code: 'TIMEOUT' }), false)
  assert.equal(isLibraryReadCancelled(new Error('[TIMEOUT] 已超时')), false)
  assert.equal(isLibraryReadCancelled({ code: 'TIMEOUT', message: '[CANCELLED] 不能覆盖明确错误码' }), false)
  assert.equal(isLibraryReadCancelled(null), false)
  assert.equal(isLibraryReadCancelled('CANCELLED'), true)
})

test('MBP-002：读取及取消函数保持原 API receiver', async () => {
  const waiting = deferred<RoonLibraryPage>()
  let readCount = 0, cancelCount = 0
  const api: ReadApi = {
    readLibrary: function<C extends LibraryReadCommand>(this: ReadApi, _request: LibraryReadRequest<C>) {
      assert.equal(this, api)
      readCount += 1
      return waiting.promise as Promise<IpcCommandResults[C]>
    },
    cancelLibraryRead: async function(this: ReadApi, _id: string) {
      assert.equal(this, api)
      cancelCount += 1
    },
  }
  const state = harness(api)
  const pending = state.scope.read(command, payload, async () => page('不能回退'))
  const rejected = assert.rejects(pending, code('CANCELLED'))
  state.scope.cancelAll()
  await rejected
  assert.equal(readCount, 1)
  assert.equal(cancelCount, 1)
})

test('MBP-002：不安全整数或小数期限拒绝派发且不分配身份', async () => {
  let calls = 0
  const state = harness(protocol(async () => { calls += 1; return page('不能调用') }, async () => undefined))
  for (const deadlineAtMs of [NaN, Infinity, 50_000.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(state.scope.read(command, payload, async () => { calls += 1; return page('不能调用') }, { deadlineAtMs }), /\[INVALID_IPC_REQUEST\]/u)
  }
  assert.equal(calls, 0)
  assert.equal(state.ids, 0)
  assert.equal(state.timers.size, 0)
})
