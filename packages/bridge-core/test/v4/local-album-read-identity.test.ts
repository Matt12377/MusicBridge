import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { MessageChannel, type MessagePort, type Worker } from 'node:worker_threads'
import { createDatasetOwnerClient } from '../../src/collection/dataset-owner-client.js'
import { attachDatasetOwnerWorkerPort } from '../../src/collection/dataset-owner-worker.js'
import { createDatasetDomain } from '../../src/collection/dataset-domain.js'
import { createCollectionRepository } from '../../src/collection/repository.js'
import { createBackupWorkflowStore } from '../../src/recording/backup-workflow-store.js'
import { failureForError } from '../../src/shared/ipc-failure.js'
import { DatasetWorkbenchWireError, type DatasetWorkbenchContext, type DatasetOwnerFatalReason, type OwnedDatasetDomain } from '../../src/collection/dataset-owner-protocol.js'

const checkpoint = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

/** 使用真实MessagePort、Client与Worker handler，只替代线程宿主的自然exit事件。 */
class PortWorker extends EventEmitter {
  constructor(readonly port: MessagePort) {
    super()
    port.on('message', value => this.emit('message', value))
    port.on('messageerror', error => this.emit('messageerror', error))
    port.once('close', () => this.emit('exit', 0))
  }
  postMessage(value: unknown) { this.port.postMessage(value) }
}

test('真实Domain只读身份实时核工作库且不读根目录，关闭后拒绝原身份', async () => {
  const collection = createCollectionRepository({ filePath: ':memory:' })
  const maintenance = createBackupWorkflowStore({ filePath: ':memory:' })
  let checks = 0, revoked = false
  const identity = { datasetId: randomUUID(), assertCurrent() { checks++; if (revoked) throw new Error('合成工作库身份已撤销。') } }
  const epoch = randomUUID()
  const domain = createDatasetDomain({ collectionRepository: collection, backupWorkflowStore: maintenance, collectionDatasetIdentity: identity, localSourceEpoch: epoch })
  const read = domain.workbenchReadIdentity; assert.ok(read)
  let roots = 0
  const original = domain.localRelocation.roots
  domain.localRelocation.roots = async () => { roots++; throw new Error('身份核验不能触发根目录探测。') }
  try {
    const before = checks
    assert.deepEqual(await read(), { datasetId: identity.datasetId, epoch, ready: true })
    assert.deepEqual(await read(), { datasetId: identity.datasetId, epoch, ready: true })
    assert.equal(checks, before + 2); assert.equal(roots, 0)
    revoked = true
    await assert.rejects(read(), /身份已撤销/u)
    revoked = false
  } finally { domain.localRelocation.roots = original; await domain.close() }
  await assert.rejects(read(), /关闭/u)
})

test('只读身份经真实Client和Worker实时派发，原context独立，取消及关闭等待本次settled', { timeout: 10_000 }, async t => {
  const { port1, port2 } = new MessageChannel(), worker = new PortWorker(port1)
  const datasetId = randomUUID(), fatals: DatasetOwnerFatalReason[] = []
  let full = 0, reads = 0, hold = false
  const entered = deferred<void>(), release = deferred<void>()
  attachDatasetOwnerWorkerPort(port2, { async prepare(epoch) {
    const context: DatasetWorkbenchContext = { epoch, datasetId, ready: true }
    const domain: OwnedDatasetDomain = {
      datasetId, failureForError, commitBoot() {}, async dispatch() { throw new Error('不应派发公开命令。') }, async close() {},
      async workbenchContext() { full++; return { ...context } },
      async workbenchReadIdentity() { reads++; if (hold) { entered.resolve(); await release.promise }; return { ...context } },
      async dispatchWorkbench() { throw new Error('不应读取完整工作台。') },
      async dispatchWorkbenchOwner() { throw new Error('不应派发私有写命令。') }, async closeWorkbench() {},
    }
    return domain
  } })
  const endpoint = createDatasetOwnerClient({ worker: worker as unknown as Worker, onFatal: reason => fatals.push(reason) })
  t.after(() => { release.resolve(); port1.close(); port2.close() })
  assert.ok(endpoint.workbenchReadIdentity)
  await assert.rejects(endpoint.workbenchReadIdentity(), error => error instanceof DatasetWorkbenchWireError && error.code === 'NOT_READY')
  const identity = await endpoint.prepare(); await endpoint.commitBoot()
  const expected = { ...identity, ready: true }
  assert.deepEqual(await endpoint.workbenchReadIdentity(), expected)
  assert.deepEqual(await endpoint.workbenchReadIdentity(), expected)
  assert.equal(reads, 2); assert.equal(full, 0)
  await endpoint.workbenchContext!(); assert.equal(full, 1)
  hold = true
  const controller = new AbortController(), pending = endpoint.workbenchReadIdentity({ signal: controller.signal })
  const rejected = assert.rejects(pending, error => error instanceof DatasetWorkbenchWireError && error.code === 'TIMEOUT')
  await entered.promise; controller.abort(); await rejected
  let joined = false
  const joining = endpoint.joinWorkbench!().then(() => { joined = true })
  await checkpoint(); assert.equal(joined, false)
  release.resolve(); await joining; assert.equal(joined, true)
  await endpoint.closeWorkbench!()
  await assert.rejects(endpoint.workbenchReadIdentity(), error => error instanceof DatasetWorkbenchWireError && error.code === 'NOT_READY')
  await endpoint.close(); assert.deepEqual(fatals, [])
})
