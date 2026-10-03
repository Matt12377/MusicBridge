import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { UtilityPort } from '../../../../packages/bridge-core/src/utility-main.js'
import type { DatasetOwnerVersionedSnapshotEndpoint } from '../../../../packages/bridge-core/src/collection/dataset-owner-protocol.js'
import { installPackagedRendererCoreObserver } from '../../src/main/packaged-renderer-core-observer.js'

class Port {
  listeners: ((event: { data: unknown }) => void)[] = []
  sent: unknown[] = []
  started = false
  on(_event: string, listener: (event: { data: unknown }) => void) { this.listeners.push(listener) }
  start() { this.started = true }
  postMessage(value: unknown) { this.sent.push(value) }
  receive(data: unknown) { for (const listener of this.listeners) listener({ data }) }
}
function subject(mode: 'node' | 'rust', sink?: (line: string) => void) {
  const lines: string[] = [], publicPort = new Port(), diagnostic = new Port()
  let bind!: (value: { data: unknown; ports?: UtilityPort[] }) => void
  const hooks = installPackagedRendererCoreObserver(mode, { parent: { once(_event, callback) { bind = callback } }, sink: sink ?? (line => { lines.push(line) }) })
  bind({ data: { type: 'musicbridge.core.port' }, ports: [publicPort, diagnostic] as unknown as UtilityPort[] })
  const events = () => lines.map(line => JSON.parse(line.slice('RUST013_EVIDENCE '.length)) as { event: string; data: Record<string, unknown> })
  return { hooks, publicPort, diagnostic, events }
}
const refresh = (ordinal: number, fields: Record<string, unknown> = {}) => ({ schemaVersion: 1, type: 'rust013.refresh', ordinal, ...fields })
const settled = async () => { for (let index = 0; index < 10; index++) await Promise.resolve() }

test('候选 Core 观察同步登记原双端口，无业务创建副作用', () => {
  let bind!: (value: { data: unknown; ports?: UtilityPort[] }) => void
  const hooks = installPackagedRendererCoreObserver('node', { parent: { once(_event, callback) { bind = callback } }, sink() {} })
  assert.equal(typeof hooks.dependencies.decorateDatasetOwner, 'function')
  assert.equal(hooks.onRustReadonlyCoreController, undefined)
  assert.throws(() => bind({ data: {}, ports: [new Port()] as unknown as UtilityPort[] }), /双端口/u)
})

test('固定 Node 私有桥依序 no-op 两次，拒绝额外字段、乱序、重放和第三次', async () => {
  const value = subject('node')
  assert.equal(value.diagnostic.started, true)
  value.diagnostic.receive(refresh(2)); value.diagnostic.receive(refresh(1, { operation: '任意' }))
  assert.equal(value.diagnostic.sent.length, 2)
  value.diagnostic.receive(refresh(1)); await settled()
  assert.deepEqual(value.diagnostic.sent[2], { schemaVersion: 1, type: 'rust013.refreshed', ordinal: 1, mode: 'node' })
  value.diagnostic.receive(refresh(1)); value.diagnostic.receive(refresh(2)); await settled()
  assert.deepEqual(value.diagnostic.sent[4], { schemaVersion: 1, type: 'rust013.refreshed', ordinal: 2, mode: 'node' })
  value.diagnostic.receive(refresh(2)); value.diagnostic.receive(refresh(3))
  assert.equal(value.events().filter(event => event.event === 'core.explicitRefreshCompleted').length, 2)
  assert.equal(value.diagnostic.sent.filter(reply => (reply as { type: string }).type === 'rust013.rejected').length, 5)
})

test('Rust 私有桥只调用可信 controller，单在途拒绝并发，保持真实状态', async () => {
  const value = subject('rust'), status = { phase: 'ready' as const }
  let calls = 0, release!: () => void
  value.hooks.onRustReadonlyCoreController!(Object.freeze({ refresh: () => { calls++; return new Promise<void>(resolve => { release = resolve }) }, invalidate() {}, getStatus: () => status }))
  value.diagnostic.receive(refresh(1)); value.diagnostic.receive(refresh(2))
  assert.equal(calls, 1); assert.equal((value.diagnostic.sent[0] as { type: string }).type, 'rust013.rejected')
  release(); await settled()
  assert.deepEqual(value.diagnostic.sent[1], { schemaVersion: 1, type: 'rust013.refreshed', ordinal: 1, mode: 'rust', status })
  value.diagnostic.receive(refresh(2)); assert.equal(calls, 2); release(); await settled()
  assert.equal(value.events().filter(event => event.event === 'core.explicitRefreshCompleted').length, 2)
})

test('刷新失败封闭私有桥，不重试原未知刷新，不记录私有异常', async () => {
  const value = subject('rust'); let calls = 0
  value.hooks.onRustReadonlyCoreController!({ async refresh() { calls++; throw new Error('私有栈') }, invalidate() {}, getStatus: () => ({ phase: 'ready' }) })
  value.diagnostic.receive(refresh(1)); await settled()
  assert.deepEqual(value.diagnostic.sent[0], { schemaVersion: 1, type: 'rust013.rejected', ordinal: 1, code: 'NOT_READY' })
  value.diagnostic.receive(refresh(1)); value.diagnostic.receive(refresh(2)); await settled()
  assert.equal(calls, 1); assert.equal(JSON.stringify(value.events()).includes('私有栈'), false)
})

test('30 秒总期限后消费迟到成功，不能重新发布成功或准入下一刷新', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const value = subject('rust'); let release!: () => void
  value.hooks.onRustReadonlyCoreController!({ refresh: () => new Promise<void>(resolve => { release = resolve }), invalidate() {}, getStatus: () => ({ phase: 'ready' }) })
  value.diagnostic.receive(refresh(1)); t.mock.timers.tick(30_000); await settled()
  assert.equal((value.diagnostic.sent[0] as { code: string }).code, 'NOT_READY')
  release(); await settled(); value.diagnostic.receive(refresh(2)); await settled()
  assert.equal(value.events().filter(event => event.event === 'core.explicitRefreshCompleted').length, 0)
  assert.equal(value.diagnostic.sent.length, 2)
})

test('公共请求与回复原样转交，记录真实 requestId 和完整结果', () => {
  const value = subject('node'), id = randomUUID()
  const request = { version: 1, id, command: 'collection.list', payload: { page: { offset: 0, limit: 24 } } }
  value.publicPort.receive(request)
  const reply = { version: 1, id, ok: true, result: { items: [], offset: 0, limit: 24, total: 0, hasMore: false } }
  value.publicPort.postMessage(reply)
  assert.equal(value.publicPort.sent[0], reply)
  assert.deepEqual(value.events().find(event => event.event === 'core.publicRequest')!.data.request, request)
  assert.deepEqual(value.events().find(event => event.event === 'core.publicReply')!.data.reply, reply)
})

test('Node owner 装饰器保留准备、写入、完整快照和关闭原能力，sink 故障不改变结果', async () => {
  for (const sink of [() => { throw new Error('观察失败') }, () => Promise.reject(new Error('观察拒绝'))]) {
    const value = subject('node', sink), identity = { epoch: randomUUID(), datasetId: randomUUID() }, snapshot = { ...identity, snapshotId: randomUUID(), models: [] }, version = { ...identity, revision: '1' }
    const result = { modelId: randomUUID() }, calls: string[] = []
    const original: DatasetOwnerVersionedSnapshotEndpoint = {
      async prepare() { calls.push('prepare'); return identity }, async commitBoot() { calls.push('boot') }, async close() { calls.push('close') },
      async dispatch() { calls.push('dispatch'); return result }, async getCollectionSnapshotVersion() { return version },
      async exportCollectionSnapshot() { return snapshot }, async exportVersionedCollectionSnapshot() { return { snapshot, version } },
    }
    const wrapped = value.hooks.dependencies.decorateDatasetOwner!(original) as DatasetOwnerVersionedSnapshotEndpoint
    assert.equal(await wrapped.prepare(), identity); await wrapped.commitBoot()
    assert.equal(await wrapped.dispatch({ version: 1, id: randomUUID(), command: 'commandOutbox.context', payload: {} }), result)
    assert.equal(await wrapped.exportCollectionSnapshot(), snapshot); assert.equal(await wrapped.getCollectionSnapshotVersion(), version)
    assert.deepEqual(await wrapped.exportVersionedCollectionSnapshot(), { snapshot, version }); await wrapped.close(); await settled()
    assert.deepEqual(calls, ['prepare', 'boot', 'dispatch', 'close'])
  }
})

test('Node 原 dispatch 拒绝对象与关闭拒绝对象保持，不因观察替换', async () => {
  const value = subject('node'), failure = new Error('合成故障')
  const wrapped = value.hooks.dependencies.decorateDatasetOwner!({ async prepare() { return { epoch: randomUUID(), datasetId: randomUUID() } }, async commitBoot() {}, async dispatch() { throw failure }, async close() { throw failure } })
  await assert.rejects(wrapped.dispatch({ version: 1, id: randomUUID(), command: 'commandOutbox.context', payload: {} }), error => error === failure)
  await assert.rejects(wrapped.close(), error => error === failure)
})

test('真实 Node 子进程显式 exit0 前的候选 Core 观察尾部必须完整抵达 pipe', () => {
  const observerUrl = new URL('../../src/main/packaged-renderer-core-observer.ts', import.meta.url).href
  const writerUrl = new URL('../../src/main/packaged-renderer-main-probe.ts', import.meta.url).href
  const loader = fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url))
  // 受控 cork 保留真实 Node Writable 缓冲，不等待异步写回调；原 exit0 政策保持。
  const source = `import { createPackagedRendererCoreEvidenceSink } from ${JSON.stringify(observerUrl)};
    import { createPackagedRendererEvidenceWriter } from ${JSON.stringify(writerUrl)};
    process.stdout.cork();
    const emit = createPackagedRendererEvidenceWriter('core', createPackagedRendererCoreEvidenceSink());
    for (let i = 0; i < 1200; i++) emit('node.snapshotExport', { index: i, synthetic: 'x'.repeat(4096) });
    emit('node.closeCompleted');
    emit('core.publicReply', { command: 'core.shutdown', reply: { version: 1, id: '合成原回执', ok: true, result: { stopped: true } } });
    emit('core.closedStatus', { mode: 'node' });
    process.exit(0);`
  const child = spawnSync(process.execPath, ['--import', loader, '--input-type=module', '--eval', source], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 15_000, env: process.env })
  assert.equal(child.error, undefined); assert.equal(child.status, 0); assert.equal(child.signal, null)
  const lines = child.stdout.split('\n').filter(Boolean)
  assert.equal(lines.length, 1203, '显式退出丢失候选 stdout 观察，不能根据 exit0 补成功事件。')
  const events = lines.map(line => JSON.parse(line.slice('RUST013_EVIDENCE '.length)))
  assert.deepEqual(events.slice(-3).map(event => event.event), ['node.closeCompleted', 'core.publicReply', 'core.closedStatus'])
  assert.equal(events.every((event, index) => event.sequence === index + 1), true)
})
