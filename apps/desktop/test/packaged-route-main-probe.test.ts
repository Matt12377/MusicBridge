import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { createPackagedRouteMainProbe, parsePackagedRouteRefreshRequest, assertPackagedRouteDiagnosticEnvironment, PACKAGED_ROUTE_FILTER_MATRIX } from '../src/main/packaged-route-main-probe.js'

test('候选刷新协议拒绝任意操作、资源路径与乱序参数', () => {
  assert.equal(parsePackagedRouteRefreshRequest({ schemaVersion: 1, type: 'rust012.refresh', ordinal: 1 }, 1), 1)
  for (const value of [null, { schemaVersion: 1, type: 'rust012.refresh', ordinal: 2 }, { schemaVersion: 1, type: 'rust012.refresh', ordinal: 1, path: '/secret' }, { schemaVersion: 1, type: 'rust012.refresh', ordinal: 1, operation: 'dispatch' }]) assert.equal(parsePackagedRouteRefreshRequest(value, 1), null)
})

test('候选探针在凭据或真实profile路径之前拒绝非离线诊断环境', () => {
  assert.throws(() => assertPackagedRouteDiagnosticEnvironment({}))
  assert.throws(() => assertPackagedRouteDiagnosticEnvironment({ MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_UI_E2E_OFFLINE: '1' }))
  assert.doesNotThrow(() => assertPackagedRouteDiagnosticEnvironment({ MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_UI_E2E_OFFLINE: '1', MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: '/synthetic' }))
})

test('Main固定诊断流程经typed outbox写入、重投同commandId并仅固定两次刷新', async () => {
  const lines: string[] = [], calls: any[] = [], diagnosticEvents = new EventEmitter(), ordinals: number[] = []
  const probe = createPackagedRouteMainProbe({ sink: line => lines.push(line) })
  const privatePort = { on: diagnosticEvents.on.bind(diagnosticEvents), start() {}, close() {}, postMessage(value: any) {
    ordinals.push(value.ordinal)
    setImmediate(() => diagnosticEvents.emit('message', { data: { schemaVersion: 1, type: 'rust012.refreshed', ordinal: value.ordinal, mode: 'node' } }))
  } }
  probe.observeChild({ postMessage() {}, once() {}, kill: () => true }, '/static/core.js', [], { port1: privatePort, port2: privatePort })
  const models: any[] = [], receipts = new Map<string, unknown>()
  const supervisor = { async request(command: string, payload: any, scope?: string) {
    calls.push({ command, payload: structuredClone(payload), scope })
    if (command === 'commandOutbox.context') return { datasetId: 'synthetic-dataset' }
    if (command === 'commandOutbox.execute') {
      if (!receipts.has(payload.payload.commandId)) {
        const model = { ...payload.payload.model, id: String(models.length), counts: { openedBlank: 1 } }
        models.push(model); receipts.set(payload.payload.commandId, { command: payload.command, result: { modelId: model.id } })
      }
      return receipts.get(payload.payload.commandId)
    }
    return { items: structuredClone(models), total: models.length, offset: 0, limit: 25, hasMore: false }
  } }
  await probe.run(supervisor as never)
  assert.deepEqual(ordinals, [1, 2]); assert.equal(models.length, 4)
  const writes = calls.filter(call => call.command === 'commandOutbox.execute')
  assert.equal(writes.length, 5); assert.deepEqual(writes[3].payload, writes[4].payload)
  assert.ok(calls.slice(5, 5 + PACKAGED_ROUTE_FILTER_MATRIX.length).every(call => call.command === 'collection.list'))
  assert.match(lines.join(''), /main\.probeComplete/)
})

test('Main观察保留实际请求完整信封且不替换Core入口', () => {
  const lines: string[] = [], probe = createPackagedRouteMainProbe({ sink: line => lines.push(line) })
  const events = new EventEmitter(), sent: unknown[] = []
  const port = { on: events.on.bind(events), start() {}, close() {}, postMessage(value: unknown) { sent.push(value) } }
  probe.observePublicPort(port)
  const request = { version: 1, id: 'c03f6e77-13e6-44b5-8a46-5d85832eb28e', command: 'collection.list', payload: { page: { offset: 0, limit: 25 }, filter: { query: '合成' } } }
  port.postMessage(request)
  events.emit('message', { data: { version: 1, id: request.id, ok: true, result: { items: [], total: 0, offset: 0, limit: 25, hasMore: false } } })
  assert.deepEqual(sent, [request])
  const recorded = lines.map(line => JSON.parse(line.slice('RUST012_EVIDENCE '.length)))
  assert.deepEqual(recorded.find(event => event.event === 'main.request').data.request, request)
  assert.equal(recorded.find(event => event.event === 'main.response').data.reply.id, request.id)
})

test('Electron退出清空child.pid后，退出证据仍关联实际spawn PID', () => {
  const lines: string[] = [], probe = createPackagedRouteMainProbe({ sink: line => lines.push(line) })
  const child = Object.assign(new EventEmitter(), { pid: 8765 as number | undefined, postMessage() {}, kill: () => true })
  const port = { on() {}, start() {}, close() {}, postMessage() {} }
  probe.observeChild(child as never, '/static/core.js', [], { port1: port, port2: port })
  child.emit('spawn'); child.pid = undefined; child.emit('exit', 0)
  const events = lines.map(line => JSON.parse(line.slice('RUST012_EVIDENCE '.length)))
  assert.deepEqual(events.find(event => event.event === 'main.coreSpawn').data, { pid: 8765 })
  assert.deepEqual(events.find(event => event.event === 'main.coreExit').data, { pid: 8765, code: 0 })
})
