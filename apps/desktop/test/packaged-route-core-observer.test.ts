import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { installPackagedRouteCoreObserver } from '../src/main/packaged-route-core-observer.js'

test('Core诊断监听同步登记，非法刷新不触及controller', async () => {
  const parent = new EventEmitter(), lines: string[] = []
  let refreshes = 0
  const hooks = installPackagedRouteCoreObserver('rust', { parent: parent as never, sink: line => lines.push(line) })
  assert.equal(parent.listenerCount('message'), 1)
  hooks.onRustReadonlyCoreController?.({ refresh: async () => { refreshes++ }, invalidate() {}, getStatus: () => ({ phase: 'ready' }) })
  const publicEvents = new EventEmitter(), privateEvents = new EventEmitter(), replies: unknown[] = []
  const pub = { on: publicEvents.on.bind(publicEvents), start() {}, postMessage() {} }
  const diagnostic = { on: privateEvents.on.bind(privateEvents), start() {}, postMessage(value: unknown) { replies.push(value) } }
  parent.emit('message', { data: { type: 'musicbridge.core.port' }, ports: [pub, diagnostic] })
  privateEvents.emit('message', { data: { schemaVersion: 1, type: 'rust012.refresh', ordinal: 1, binary: '/bad' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(refreshes, 0)
  assert.equal(replies.length, 1)
  assert.match(lines.join(''), /core\.diagnosticRejected/)
})

test('可信controller刷新仅接受ordinal1再2，不接受并发和重放', async () => {
  const parent = new EventEmitter(), lines: string[] = []
  let release!: () => void, refreshes = 0
  const hooks = installPackagedRouteCoreObserver('rust', { parent: parent as never, sink: line => lines.push(line) })
  hooks.onRustReadonlyCoreController?.({ refresh: async () => { refreshes++; await new Promise<void>(resolve => { release = resolve }) }, invalidate() {}, getStatus: () => ({ phase: 'ready' }) })
  const events = new EventEmitter(), replies: any[] = []
  parent.emit('message', { data: { type: 'musicbridge.core.port' }, ports: [{ on() {}, postMessage() {}, start() {} }, { on: events.on.bind(events), start() {}, postMessage(value: unknown) { replies.push(value) } }] })
  const send = (ordinal: number) => events.emit('message', { data: { schemaVersion: 1, type: 'rust012.refresh', ordinal } })
  send(2); assert.equal(refreshes, 0)
  send(1); send(1); assert.equal(refreshes, 1)
  release(); await new Promise(resolve => setImmediate(resolve))
  send(1); assert.equal(refreshes, 1)
  send(2); assert.equal(refreshes, 2)
  release(); await new Promise(resolve => setImmediate(resolve))
  send(2); assert.equal(refreshes, 2)
  assert.deepEqual(replies.filter(value => value.type === 'rust012.refreshed').map(value => value.ordinal), [1, 2])
})

test('观察装饰不创建第二Owner且保留原快照与完整Node回执', async () => {
  const parent = new EventEmitter(), lines: string[] = [], calls: string[] = []
  const hooks = installPackagedRouteCoreObserver('node', { parent: parent as never, sink: line => lines.push(line) })
  const source = { prepare: async () => ({ epoch: 'epoch', datasetId: 'dataset' }), commitBoot: async () => { calls.push('boot') },
    dispatch: async (request: any) => { calls.push(request.id); return { typed: true } }, close: async () => { calls.push('close') }, getCollectionSnapshotVersion: async () => ({ epoch: 'epoch', datasetId: 'dataset', revision: 'revision' }) }
  const decorated = hooks.dependencies.decorateDatasetOwner!(source)
  await decorated.commitBoot()
  const request = { version: 1 as const, id: 'actual-id', command: 'commandOutbox.context' as const, payload: {} }
  assert.deepEqual(await decorated.dispatch(request), { typed: true })
  assert.equal(typeof (decorated as any).getCollectionSnapshotVersion, 'function')
  await decorated.close(); assert.deepEqual(calls, ['boot', 'actual-id', 'close'])
  assert.match(lines.join(''), /actual-id/)
})

for (const failingEvent of ['node.reply', 'node.closeStarted']) {
  test(`观察sink在${failingEvent}抛错仍保留原成功回执与唯一关闭`, async () => {
    const calls: string[] = [], result = { command: 'collection.receive', result: { modelId: '合成' } }
    const hooks = installPackagedRouteCoreObserver('node', { parent: new EventEmitter() as never, sink(line) {
      if (JSON.parse(line.slice('RUST012_EVIDENCE '.length)).event === failingEvent) throw new Error('受控观察通道关闭')
    } })
    const source = { prepare: async () => ({ epoch: 'epoch', datasetId: 'dataset' }), commitBoot: async () => {},
      dispatch: async () => { calls.push('dispatch'); return result }, close: async () => { calls.push('close') } }
    const decorated = hooks.dependencies.decorateDatasetOwner!(source)
    const actual = await decorated.dispatch({ version: 1, id: 'actual-id', command: 'commandOutbox.execute', payload: {} } as never)
    assert.equal(actual, result)
    await decorated.close(); assert.deepEqual(calls, ['dispatch', 'close'])
  })
}

test('观察sink异步拒绝被消费，Node成功回执与关闭保持', async () => {
  const calls: string[] = [], result = { typed: true }
  const hooks = installPackagedRouteCoreObserver('node', { parent: new EventEmitter() as never,
    sink: async () => { throw new Error('受控异步观察失败') } })
  const decorated = hooks.dependencies.decorateDatasetOwner!({ prepare: async () => ({ epoch: 'epoch', datasetId: 'dataset' }),
    commitBoot: async () => {}, dispatch: async () => { calls.push('dispatch'); return result }, close: async () => { calls.push('close') } })
  assert.equal(await decorated.dispatch({ version: 1, id: 'actual-id', command: 'commandOutbox.context', payload: {} }), result)
  await decorated.close(); await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, ['dispatch', 'close'])
})
