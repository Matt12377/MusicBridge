import assert from 'node:assert/strict'
import test from 'node:test'
import { syntheticFixtureRoot } from './helpers/synthetic-profile-root.js'
const controlledPackagedProfile = (env: NodeJS.ProcessEnv) => readPackagedRendererProfileWithinRoot(env, syntheticFixtureRoot())
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createPackagedRendererMainProbe, parsePackagedRendererRefreshRequest, createPackagedRendererEvidenceWriter, readPackagedRendererProfile, readPackagedRendererProfileWithinRoot } from '../src/main/packaged-renderer-main-probe.js'
import { PACKAGED_RENDERER_FIXTURE, packagedRendererDomExpression } from '../src/main/packaged-renderer-dom-driver.js'

test('固定DOM fixture有26种且拒绝任意表达式、越界型号和selector输入', () => {
  assert.equal(PACKAGED_RENDERER_FIXTURE.length, 26)
  assert.equal(new Set(PACKAGED_RENDERER_FIXTURE.map(row => row.model.name)).size, 26)
  for (const row of PACKAGED_RENDERER_FIXTURE) assert.deepEqual(row.quantities, { sealedBlank: 0, openedBlank: 1, legacyUsed: 0, unclassified: 0 })
  for (const operation of ['snapshot', 'navigate', 'receive-save', 'policy-save'] as const) {
    const script = packagedRendererDomExpression(operation, operation === 'receive-save' ? 0 : undefined)
    assert.doesNotMatch(script, /window\.musicBridge|__vue|supervisor|\.request\(/u)
  }
  assert.throws(() => packagedRendererDomExpression('window.musicBridge.receiveCollectionStock()' as never))
  assert.throws(() => packagedRendererDomExpression('receive-save', 26))
  assert.throws(() => packagedRendererDomExpression('snapshot', 1))
})

test('私有refresh只准闭集、精确顺序和数据属性', () => {
  assert.equal(parsePackagedRendererRefreshRequest({ schemaVersion: 1, type: 'rust013.refresh', ordinal: 1 }, 1), 1)
  for (const value of [null, { schemaVersion: 1, type: 'rust013.refresh', ordinal: 2 }, { schemaVersion: 1, type: 'rust013.refresh', ordinal: 1, path: '/secret' }, { get schemaVersion() { throw new Error('不应读取getter') }, type: 'rust013.refresh', ordinal: 1 }]) assert.equal(parsePackagedRendererRefreshRequest(value, 1), null)
})

test('真实公共端口仅旁路观察，保留完整信封和实际往返计时', () => {
  const lines: string[] = [], sent: unknown[] = [], events = new EventEmitter()
  const probe = createPackagedRendererMainProbe({ profileReader: controlledPackagedProfile, sink: line => { lines.push(line) } })
  const port = { on: events.on.bind(events), start() {}, close() {}, postMessage(value: unknown) { sent.push(value) } }
  probe.observePublicPort(port)
  const request = { version: 1, id: '65d3e2ae-9ad2-49f2-8633-7719f3e10a37', command: 'collection.list', payload: { page: { offset: 24, limit: 24 }, filter: { brand: 'RUST013合成甲' } } }
  port.postMessage(request)
  events.emit('message', { data: { version: 1, id: request.id, ok: true, result: { items: [], total: 0, offset: 24, limit: 24, hasMore: false } } })
  assert.deepEqual(sent, [request])
  const recorded = lines.map(line => JSON.parse(line.slice('RUST013_EVIDENCE '.length)))
  assert.deepEqual(recorded.find(value => value.event === 'main.request').data.request, request)
  const reply = recorded.find(value => value.event === 'main.response').data
  assert.equal(reply.requestId, request.id); assert.equal(reply.command, request.command)
  assert.equal(typeof reply.durationMs, 'number'); assert.ok(reply.durationMs >= 0)
  assert.equal(reply.actionId, null)
})

test('MainIPC旁路保留原DTO，sink拒绝不影响原事件调用', async () => {
  const probe = createPackagedRendererMainProbe({ profileReader: controlledPackagedProfile, sink: (() => Promise.reject(new Error('受控sink'))) as never })
  assert.doesNotThrow(() => probe.observeMainEvent('main.ipcReply', { invokeId: 'ipc-1', channel: 'collection:list', result: { items: [], total: 0 } }))
  await new Promise(resolve => setImmediate(resolve))
  const emit = createPackagedRendererEvidenceWriter('main', () => { throw new Error('受控sink') })
  assert.doesNotThrow(() => emit('main.test'))
})

test('实际spawn PID在Electron清除pid后仍关联退出，原kill行为不替换', () => {
  const lines: string[] = [], probe = createPackagedRendererMainProbe({ profileReader: controlledPackagedProfile, sink: line => { lines.push(line) } })
  let killCount = 0
  const child = Object.assign(new EventEmitter(), { pid: 9876 as number | undefined, postMessage() {}, kill() { killCount++; return true } })
  const port = { on() {}, start() {}, close() {}, postMessage() {} }
  probe.observeChild(child as never, '/fixed/core.js', [], { port1: port, port2: port })
  child.emit('spawn'); assert.equal(child.kill(), true); child.pid = undefined; child.emit('exit', 0)
  const events = lines.map(line => JSON.parse(line.slice('RUST013_EVIDENCE '.length)))
  assert.equal(killCount, 1); assert.deepEqual(events.find(value => value.event === 'main.coreExit').data, { code: 0, pid: 9876 })
  assert.equal(events.filter(value => value.event === 'main.coreKill').length, 1)
})

test('profile标记拒绝额外权限字段和symlink，不碰真实用户目录', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'musicbridge-ui-diagnostics-marker-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const env = { MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_UI_E2E_OFFLINE: '1', MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: directory }
  const marker = path.join(directory, 'rust013-profile.json')
  await writeFile(marker, JSON.stringify({ schemaVersion: 1, kind: 'rust013-synthetic-profile', nonce: randomUUID(), route: 'node' }), { mode: 0o600 })
  assert.throws(() => controlledPackagedProfile(env))
  await rm(marker)
  const target = path.join(directory, 'controlled.json'); await writeFile(target, JSON.stringify({ schemaVersion: 1, kind: 'rust013-synthetic-profile', nonce: randomUUID() }), { mode: 0o600 })
  await symlink(target, marker); assert.throws(() => controlledPackagedProfile(env))
  assert.throws(() => readPackagedRendererProfile({ ...env, MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: '/Users/yihe/Library/Application Support/MusicBridge' }))
})

test('受控窗口流程：26原表单回执+单次策略、两次refresh，cold零写零refresh且先到第二页', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'musicbridge-ui-diagnostics-probe-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(path.join(directory, 'rust013-profile.json'), JSON.stringify({ schemaVersion: 1, kind: 'rust013-synthetic-profile', nonce: randomUUID() }), { mode: 0o600 })
  for (const [key, value] of Object.entries({ MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_UI_E2E_OFFLINE: '1', MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: directory })) {
    const previous = process.env[key]; process.env[key] = value
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous })
  }
  const datasetId = randomUUID(), stored: any[] = [], actions: string[] = [], lines: string[] = [], refreshes: number[] = []
  let totalWrites = 0
  async function launch(cold: boolean) {
    const probe = createPackagedRendererMainProbe({ profileReader: controlledPackagedProfile, sink: line => { lines.push(line) } }), portEvents = new EventEmitter(), diagnosticEvents = new EventEmitter()
    let ipc = 0, offset = 0, filter = '', detail: any, dialog = false
    const publicPort = { on: portEvents.on.bind(portEvents), start() {}, close() {}, postMessage(_value: unknown) {} }
    probe.observePublicPort(publicPort)
    const privatePort = { on: diagnosticEvents.on.bind(diagnosticEvents), start() {}, close() {}, postMessage(value: any) { refreshes.push(value.ordinal); setImmediate(() => diagnosticEvents.emit('message', { data: { schemaVersion: 1, type: 'rust013.refreshed', ordinal: value.ordinal, mode: 'node' } })) } }
    probe.observeChild({ postMessage() {}, once() {}, kill() { return true } }, '/fixed/core.js', [], { port1: privatePort, port2: privatePort })
    function domain(command: string, payload: any, result: any) {
      const id = randomUUID(); publicPort.postMessage({ version: 1, id, command, payload } as never)
      portEvents.emit('message', { data: { version: 1, id, ok: true, result: structuredClone(result) } })
    }
    function invoke(channel: string, args: any[], result: any) {
      const invokeId = `ipc-${++ipc}`
      probe.observeMainEvent('main.ipcRequest', { invokeId, channel, args, sender: { webContentsId: 1, rendererPid: 3456, frameUrl: 'musicbridge://app/index.html', trusted: true } })
      probe.observeMainEvent('main.ipcReply', { invokeId, channel, result })
    }
    function selected() { return [...stored].reverse().filter(model => filter === 'brand' ? model.brand === 'RUST013合成甲' : filter === 'query' ? model.name === PACKAGED_RENDERER_FIXTURE[0]!.model.name : filter === 'decade' ? model.year === 1991 : filter === 'state' ? model.identification === 'unidentified' : true) }
    function list() { const all = selected(), page = { items: structuredClone(all.slice(offset, offset + 24)), total: all.length, offset, limit: 24, hasMore: offset + 24 < all.length }; domain('collection.list', { page: { offset, limit: 24 }, filter: {} }, page) }
    function snapshot() {
      const all = selected()
      return { frameUrl: 'musicbridge://app/index.html', readyState: 'complete', total: detail ? null : all.length, page: all.length > 24 ? `${offset === 0 ? 1 : 2} / 2` : null,
        rows: detail ? [] : all.slice(offset, offset + 24).map(model => ({ label: model.brand + ' ' + model.name, year: String(model.year), state: '已收藏' })),
        detail: detail ? { label: detail.name, modelId: detail.id, total: 1, openedBlank: 1, policy: detail.collectorPolicy, reserve: String(detail.minimumSealedReserve) } : null, dialog, inventoryLoading: false, errorCount: 0 }
    }
    const window = { webContents: { id: 1, getOSProcessId: () => 3456, getURL: () => 'musicbridge://app/index.html', async capturePage() { return { toPNG: () => Buffer.from('仅受控像素fixture'), getSize: () => ({ width: 1, height: 1 }) } }, async executeJavaScript(script: string) {
      const matched = /\)\("([a-z-]+)",(.+)\);\}\)\(\)$/su.exec(script)
      assert.ok(matched, '只能收到包内固定表达式')
      const operation = matched[1]!, fixture = JSON.parse(matched[2]!)
      if (operation === 'snapshot') return snapshot()
      actions.push(`${cold ? 'cold' : 'fresh'}:${operation}`)
      if (operation === 'navigate') list()
      else if (operation === 'receive-open') dialog = true
      else if (operation === 'receive-save') {
        assert.equal(cold, false); assert.equal(dialog, true); totalWrites++
        const model = { ...fixture.model, id: randomUUID(), collectorPolicy: 'normal', minimumSealedReserve: 0, revision: 1, lengths: [60], counts: { total: 1, sealedBlank: 0, openedBlank: 1, legacyUsed: 0, recorded: 0, reserved: 0, unavailable: 0, unknown: 0 } }
        stored.push(model)
        const payload = { commandId: randomUUID(), ...fixture }, result = { modelId: model.id, lotId: randomUUID() }, request = { datasetId, command: 'collection.receive', payload }, outboxId = randomUUID()
        domain('commandOutbox.execute', request, { command: request.command, result }); invoke('commandOutbox:submit', [{ request }], { ok: true, outboxId, result }); invoke('commandOutbox:acknowledge', [{ id: outboxId }], { id: outboxId, acknowledged: true })
        dialog = false; list()
      } else if (operation.startsWith('filter-')) { filter = operation.slice(7); offset = 0; list() }
      else if (operation === 'clear') { filter = ''; offset = 0; list() }
      else if (operation === 'next' || operation === 'previous') { offset = operation === 'next' ? 24 : 0; list() }
      else if (operation === 'detail-open') {
        assert.equal(offset, 24, '原ORDER rowid DESC下目标01必须在第二页')
        detail = stored.find(model => model.name === fixture.model.name)
        domain('collection.detail', { modelId: detail.id, page: { offset: 0, limit: 20 } }, { model: detail, lots: { items: [], total: 0, offset: 0, limit: 20, hasMore: false }, copies: { items: [], total: 0, offset: 0, limit: 20, hasMore: false } })
      } else if (operation === 'detail-close') detail = undefined
      else if (operation === 'policy-save') {
        assert.equal(cold, false); totalWrites++
        const payload = { commandId: randomUUID(), modelId: detail.id, expectedRevision: detail.revision, collectorPolicy: 'collector', minimumSealedReserve: 2 }, request = { datasetId, command: 'collection.setPolicy', payload }, outboxId = randomUUID(), result = { modelId: detail.id }
        detail.collectorPolicy = 'collector'; detail.minimumSealedReserve = 2; detail.revision++
        domain('commandOutbox.execute', request, { command: request.command, result }); invoke('commandOutbox:submit', [{ request }], { ok: true, outboxId, result }); invoke('commandOutbox:acknowledge', [{ id: outboxId }], { id: outboxId, acknowledged: true })
        list(); domain('collection.detail', { modelId: detail.id, page: { offset: 0, limit: 20 } }, { model: detail, lots: { items: [], total: 0, offset: 0, limit: 20, hasMore: false }, copies: { items: [], total: 0, offset: 0, limit: 20, hasMore: false } })
      }
      return snapshot()
    } }, isVisible: () => true, getBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }) }
    await probe.run(window as never)
  }
  await launch(false); assert.equal(totalWrites, 27); assert.deepEqual(refreshes, [1, 2])
  const before = await readFile(path.join(directory, 'rust013-completed.json'))
  await launch(true); assert.equal(totalWrites, 27); assert.deepEqual(refreshes, [1, 2])
  assert.deepEqual(await readFile(path.join(directory, 'rust013-completed.json')), before)
  assert.equal(actions.filter(action => action === 'fresh:receive-save').length, 26)
  assert.equal(actions.filter(action => action === 'fresh:policy-save').length, 1)
  assert.ok(actions.filter(action => action.startsWith('cold:')).every(action => !action.includes('save')))
  const evidence = lines.map(line => JSON.parse(line.slice('RUST013_EVIDENCE '.length)))
  assert.deepEqual(evidence.filter(value => value.event === 'main.rendererProbeComplete').map(value => value.data.phase), ['fresh', 'cold'])
})
