import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { parse, compileTemplate } from '@vue/compiler-sfc'
import type { CommandOutboxOverview, CommandOutboxPublicApi, CommandOutboxView } from '@music-bridge/contracts'
import { createCommandOutboxController } from '../src/renderer/src/components/command-outbox/controller.js'

const datasetId = '11111111-1111-4111-8111-111111111111'
function entry(overrides: Partial<CommandOutboxView> = {}): CommandOutboxView {
  return { id: '22222222-2222-4222-8222-222222222222', commandId: '33333333-3333-4333-8333-333333333333',
    command: 'collection.receive', datasetId, state: 'uncertain', createdAt: '2026-08-28T00:00:00.000Z', updatedAt: '2026-08-28T00:00:01.000Z',
    acknowledged: false, canRetry: true, ...overrides }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function fixture(initial = entry()) {
  let overview: CommandOutboxOverview = { datasetId, entries: [initial] }
  const calls: { method: string; request?: unknown }[] = []
  const timers = new Map<number, () => void>()
  let nextTimer = 0
  const api: CommandOutboxPublicApi = {
    async getCommandOutbox() { calls.push({ method: 'get' }); return overview },
    async retryCommandOutbox(request) { calls.push({ method: 'retry', request }); return initial },
    async dismissCommandOutbox(request) { calls.push({ method: 'dismiss', request }); overview = { datasetId, entries: [] }; return { ...initial, state: 'dismissed' } },
    async acknowledgeCommandOutbox(request) { calls.push({ method: 'ack', request }); overview = { datasetId, entries: [] }; return { ...initial, acknowledged: true } },
  }
  const controller = createCommandOutboxController({ api, pollLimit: 2,
    schedule: (callback) => { const id = ++nextTimer; timers.set(id, callback); return id },
    cancel: (id) => { timers.delete(id) },
  })
  return { api, controller, calls, timers, setOverview: (value: CommandOutboxOverview) => { overview = value } }
}

test('打开与重新创建面板只读取持久状态，不自动重试或确认', async () => {
  const f = fixture()
  assert.equal(f.calls.length, 0)
  await f.controller.start()
  assert.deepEqual(f.calls.map((call) => call.method), ['get'])
  assert.equal(f.controller.state.overview?.entries[0]?.state, 'uncertain')
  f.controller.dispose()
  const reopened = fixture()
  await reopened.controller.start()
  assert.deepEqual(reopened.calls.map((call) => call.method), ['get'])
  reopened.controller.dispose()
})

test('重试和放弃必须明确确认，旧工作库即使canRetry=true也不能发送', async () => {
  const f = fixture()
  await f.controller.start()
  await f.controller.act('retry', entry().id, false)
  await f.controller.act('dismiss', entry().id, false)
  assert.equal(f.calls.some((call) => call.method !== 'get'), false)
  assert.match(f.controller.state.itemErrors[entry().id] ?? '', /确认/u)
  f.setOverview({ datasetId: '44444444-4444-4444-8444-444444444444', entries: [entry()] })
  await f.controller.refresh()
  await f.controller.act('retry', entry().id, true)
  assert.equal(f.calls.some((call) => call.method === 'retry'), false)
  assert.match(f.controller.state.itemErrors[entry().id] ?? '', /工作库|重新加载/u)
  f.controller.dispose()
})

test('旧库激活仅在Main允许时恢复切换回执，普通命令及禁用项仍不可重试', async () => {
  const activation = entry({ command: 'recordingBackups.activate' })
  const f = fixture(activation)
  const currentId = '44444444-4444-4444-8444-444444444444'
  f.setOverview({ datasetId: currentId, entries: [activation] })
  await f.controller.start()
  await f.controller.act('retry', activation.id, true)
  assert.deepEqual(f.calls.filter((call) => call.method === 'retry'), [{ method: 'retry', request: { id: activation.id, userConfirmed: true } }])
  f.setOverview({ datasetId: currentId, entries: [{ ...activation, canRetry: false }] })
  await f.controller.refresh()
  await f.controller.act('retry', activation.id, true)
  assert.equal(f.calls.filter((call) => call.method === 'retry').length, 1)
  f.controller.dispose()
})

test('同项动作单飞且重试只发送原条目ID，成功后刷新', async () => {
  const f = fixture()
  const pending = deferred<CommandOutboxView>()
  f.api.retryCommandOutbox = async (request) => { f.calls.push({ method: 'retry', request }); return pending.promise }
  await f.controller.start()
  const first = f.controller.act('retry', entry().id, true)
  const second = f.controller.act('retry', entry().id, true)
  await f.controller.act('dismiss', entry().id, true)
  assert.deepEqual(f.calls.filter((call) => call.method !== 'get'), [{ method: 'retry', request: { id: entry().id, userConfirmed: true } }])
  assert.deepEqual(f.controller.state.busyIds, [entry().id])
  f.setOverview({ datasetId, entries: [entry({ state: 'succeeded', canRetry: false })] })
  pending.resolve(entry({ state: 'succeeded', canRetry: false }))
  await Promise.all([first, second])
  assert.equal(f.controller.state.overview?.entries[0]?.state, 'succeeded')
  assert.deepEqual(f.controller.state.busyIds, [])
  f.controller.dispose()
})

test('动作完成后的刷新仍保持单飞，避免确认框清除前再次发送', async () => {
  const f = fixture()
  await f.controller.start()
  const refreshing = deferred<CommandOutboxOverview>()
  f.api.getCommandOutbox = () => refreshing.promise
  const first = f.controller.act('retry', entry().id, true)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(f.controller.state.busyIds, [entry().id])
  const second = f.controller.act('retry', entry().id, true)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(f.calls.filter((call) => call.method === 'retry').length, 1)
  refreshing.resolve({ datasetId, entries: [entry()] })
  await Promise.all([first, second])
  assert.deepEqual(f.controller.state.busyIds, [])
  f.controller.dispose()
})

test('放弃和已确认成功都刷新列表，已确认不需要重新投递', async () => {
  const dismissed = fixture()
  await dismissed.controller.start()
  await dismissed.controller.act('dismiss', entry().id, true)
  assert.deepEqual(dismissed.controller.state.overview?.entries, [])
  assert.match(dismissed.controller.state.notice ?? '', /不是撤销|不等于撤销/u)
  dismissed.controller.dispose()
  const acknowledged = fixture(entry({ state: 'succeeded', canRetry: false }))
  await acknowledged.controller.start()
  await acknowledged.controller.act('ack', entry().id)
  assert.deepEqual(acknowledged.calls.map((call) => call.method), ['get', 'ack', 'get'])
  assert.deepEqual(acknowledged.controller.state.overview?.entries, [])
  acknowledged.controller.dispose()
})

test('核心不可用与动作失败就近显示有限文案，不输出原生路径或错误栈', async () => {
  const f = fixture()
  await f.controller.start()
  f.api.retryCommandOutbox = async () => { throw new Error('[NOT_READY] /private/synthetic-secret stack') }
  await f.controller.act('retry', entry().id, true)
  assert.match(f.controller.state.itemErrors[entry().id] ?? '', /Core|核心/u)
  assert.doesNotMatch(JSON.stringify(f.controller.state), /synthetic-secret|private\//u)
  assert.deepEqual(f.controller.state.busyIds, [])
  f.api.getCommandOutbox = async () => { throw new Error('/private/hidden') }
  await f.controller.refresh()
  assert.match(f.controller.state.error ?? '', /读取|暂时/u)
  assert.equal(f.controller.state.overview?.entries.length, 1)
  f.controller.dispose()
})

test('旧查询不能覆盖已确认成功后的刷新结果', async () => {
  const f = fixture(entry({ state: 'succeeded', canRetry: false }))
  await f.controller.start()
  const stale = deferred<CommandOutboxOverview>()
  let reads = 0
  f.api.getCommandOutbox = () => ++reads === 1 ? stale.promise : Promise.resolve({ datasetId, entries: [] })
  const oldRead = f.controller.refresh()
  await f.controller.act('ack', entry().id)
  stale.resolve({ datasetId, entries: [entry({ state: 'succeeded' })] })
  await oldRead
  assert.deepEqual(f.controller.state.overview?.entries, [])
  f.controller.dispose()
})

test('成功回执后刷新失败仍保留成功状态，不把旧的未知状态重新显示为可重试', async () => {
  const f = fixture()
  await f.controller.start()
  f.api.retryCommandOutbox = async () => entry({ state: 'succeeded', canRetry: false })
  f.api.getCommandOutbox = async () => { throw new Error('[NOT_READY]') }
  await f.controller.act('retry', entry().id, true)
  assert.equal(f.controller.state.overview?.entries[0]?.state, 'succeeded')
  assert.equal(f.controller.state.overview?.entries[0]?.canRetry, false)
  assert.ok(f.controller.state.error)
  f.controller.dispose()
})

test('轮询次数有界，关闭取消计时并忽略晚到的响应', async () => {
  const f = fixture()
  await f.controller.start()
  for (let i = 0; i < 2; i++) {
    const [id, callback] = [...f.timers][0]!
    f.timers.delete(id); callback()
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  assert.equal(f.calls.filter((call) => call.method === 'get').length, 3)
  assert.equal(f.timers.size, 0)
  assert.equal(f.controller.state.pollingPaused, true)
  const late = deferred<CommandOutboxOverview>()
  f.api.getCommandOutbox = () => late.promise
  const reading = f.controller.refresh()
  f.controller.dispose()
  late.resolve({ datasetId, entries: [] }); await reading
  assert.equal(f.controller.state.overview?.entries.length, 1)
  assert.equal(f.timers.size, 0)
})

test('面板使用可编译原生dialog、独立确认和就近反馈，App入口不自动打开', async () => {
  const source = await readFile(new URL('../src/renderer/src/components/CommandOutboxPanel.vue', import.meta.url), 'utf8')
  const { descriptor, errors } = parse(source)
  assert.deepEqual(errors, [])
  assert.deepEqual(compileTemplate({ source: descriptor.template!.content, filename: 'CommandOutboxPanel.vue', id: 'outbox' }).errors, [])
  assert.match(source, /<dialog\b/u)
  assert.match(source, /aria-labelledby="outbox-title"/u)
  assert.match(source, /@cancel\.prevent="close"/u)
  assert.match(source, /v-model="retryConfirm\[item\.id\]"/u)
  assert.match(source, /v-model="dismissConfirm\[item\.id\]"/u)
  assert.match(source, /role="alert"/u)
  assert.match(source, /放弃跟踪不等于撤销业务/u)
  assert.match(source, /恢复原选择回执；若未曾完成，重新选择文件或目录/u)
  assert.match(source, /仅查询原切换的持久回执，不停止播放、不重启 Core/u)
  assert.doesNotMatch(source, /item\.(?:payload|result|path)|JSON\.stringify/u)
  const app = await readFile(new URL('../src/renderer/src/App.vue', import.meta.url), 'utf8')
  assert.match(app, /const commandOutboxOpen = ref\(false\)/u)
  assert.match(app, /<CommandOutboxPanel v-if="commandOutboxOpen"/u)
})
