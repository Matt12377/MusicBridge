import assert from 'node:assert/strict'
import test from 'node:test'
import { CoreSupervisor, type CoreMessagePort, type CoreChildProcess } from '../src/main/core-supervisor.js'
import * as dto from '@music-bridge/contracts'
import { datasetId, id, readyPlan } from './mbrs012-fixture.js'
class Port implements CoreMessagePort {
  sent: unknown[] = []; closed = false; listener?: (event: { data: unknown }) => void; onSend?: (value: unknown) => void
  on(_event: 'message', listener: (event: { data: unknown }) => void) { this.listener = listener }
  start() {} close() { this.closed = true } postMessage(value: unknown) { this.sent.push(value); this.onSend?.(value) } receive(value: unknown) { this.listener?.({ data: value }) }
}
class Child implements CoreChildProcess {
  ports: CoreMessagePort[] = []; listener?: (code: number) => void
  postMessage(_value: unknown, ports?: CoreMessagePort[]) { this.ports = ports ?? [] }
  once(_event: 'exit', listener: (code: number) => void) { this.listener = listener }
  kill() { this.listener?.(0); return true }
}
async function fixture(t: test.TestContext) {
  const normal = { port1: new Port(), port2: new Port() }, source = { port1: new Port(), port2: new Port() }, child = new Child()
  const supervisor = new CoreSupervisor({ entryPath: '/合成/core.js', cwd: '/合成', sourceWritesPort: true, requestTimeoutMs: 2000, dependencies: { createChannel: () => normal, createSourceWritesChannel: () => source, fork: () => child } })
  const start = supervisor.start(); normal.port2.receive({ version: 1, event: 'core.ready', payload: { state: { runtime: 'ready', roon: 'disconnected', provider: 'missing', activeStreamCount: 0, activePlaybackPresent: false } } }); await start
  normal.port2.onSend = value => { const request = value as { id: string; command: string }; if (request.command === 'core.shutdown') { normal.port2.receive({ version: 1, id: request.id, ok: true, result: { stopped: true } }); child.kill() } }
  t.after(() => supervisor.shutdown())
  return { supervisor, normal, source, child }
}
test('012私有材料通道与普通Core物理分离；二次clone整块4MiB且不枚举bytes', async t => {
  const f = await fixture(t); assert.deepEqual(f.child.ports, [f.normal.port1, f.source.port1])
  const bytes = new Uint8Array(4194304), payload: dto.AttachLocalSourceWritesOriginal = { datasetId, commandId: id(30), target: { trackId: id(2), editionId: id(3), expectedTrackRevision: '1', expectedEditionRevision: '1', expectedSourceRevision: 'a'.repeat(64) }, candidateId: id(31), original: { mime: 'image/png', bytes: bytes.length, sha256: 'b'.repeat(64), width: 16, height: 16 }, bytes }
  const work = f.supervisor.requestSourceWrites('localSourceWrites.attachOriginal', payload), sent = f.source.port2.sent[0] as dto.SourceWritesMainRequest
  assert.equal(f.normal.port2.sent.length, 0); assert.equal(sent.command, 'localSourceWrites.attachOriginal'); if (sent.command !== 'localSourceWrites.attachOriginal') throw new Error('错误私有命令')
  assert.notEqual(sent.payload.bytes.buffer, bytes.buffer); assert.equal(sent.payload.bytes.byteOffset, 0); assert.equal(sent.payload.bytes.buffer.byteLength, 4194304)
  f.source.port2.receive({ version: 1, type: 'source-writes-response', requestId: sent.requestId, sequence: sent.sequence, ok: true, result: { contentRef: id(32), sha256: payload.original.sha256, bytes: bytes.length } }); assert.equal((await work).contentRef, id(32))
})
test('012普通requestInternal及伪造响应不能获得私有actor，错误回执关闭该专用端口', async t => {
  const f = await fixture(t), plan = readyPlan(), confirm: dto.ConfirmLocalSourceWrites = { datasetId, commandId: id(40), planId: plan.planId, expectedViewRevision: plan.viewRevision, scope: 'SOURCE_FILES', range: plan.range, planHash: plan.planHash!, contextFingerprint: plan.contextFingerprint! }
  await assert.rejects(() => f.supervisor.requestInternal('localSourceWrites.challenge' as never, { datasetId, confirm } as never)); assert.equal(f.source.port2.sent.length, 0)
  const work = f.supervisor.requestSourceWrites('localSourceWrites.challenge', { datasetId, confirm }), rejected = assert.rejects(() => work)
  const request = f.source.port2.sent[0] as dto.SourceWritesMainRequest
  f.source.port2.receive({ version: 1, type: 'source-writes-response', requestId: request.requestId, sequence: request.sequence + 1, ok: true, result: {} }); await rejected
  assert.equal(f.source.port2.closed, true); assert.equal(f.supervisor.status, 'ready'); await assert.rejects(() => f.supervisor.requestSourceWrites('localSourceWrites.challenge', { datasetId, confirm })); assert.equal(f.source.port2.sent.length, 1)
})
test('012私有受理超时后迟到回执不重派、不换sequence、不重连', async t => {
  const f = await fixture(t); t.mock.timers.enable({ apis: ['setTimeout'] }); const plan = readyPlan(), confirm: dto.ConfirmLocalSourceWrites = { datasetId, commandId: id(41), planId: plan.planId, expectedViewRevision: plan.viewRevision, scope: 'SOURCE_FILES', range: plan.range, planHash: plan.planHash!, contextFingerprint: plan.contextFingerprint! }
  const work = f.supervisor.requestSourceWrites('localSourceWrites.challenge', { datasetId, confirm }), rejected = assert.rejects(() => work); t.mock.timers.tick(2001); await rejected
  const request = f.source.port2.sent[0] as dto.SourceWritesMainRequest; f.source.port2.receive({ version: 1, type: 'source-writes-response', requestId: request.requestId, sequence: request.sequence, ok: true, result: {} }); await Promise.resolve()
  assert.equal(f.source.port2.sent.length, 1); assert.equal(f.source.port2.closed, false); assert.equal(f.supervisor.status, 'ready')
})
