import assert from 'node:assert/strict'
import test from 'node:test'
import * as dto from '@music-bridge/contracts'
import { CoreSupervisor, type CoreChildProcess, type CoreRelocationMessagePort } from '../../src/main/core-supervisor.js'
import { installLocalRelocationHandlers, type LocalRelocationHandlersOptions } from '../../src/main/local-relocation-ipc.js'
import { datasetId, fixture, fingerprint, id, readyPlan } from './fixture.js'

/** 真实Supervisor与Main叶配受控物理端口；不代表utilityProcess、OS或App实际证据。 */
class Port implements CoreRelocationMessagePort {
  readonly sent: unknown[] = []
  private readonly messages: ((event: { data: unknown }) => void)[] = []
  private readonly ends = new Map<'close' | 'messageerror', (() => void)[]>()
  closed = false
  started = false
  on(event: 'message', listener: (event: { data: unknown }) => void): void
  on(event: 'close' | 'messageerror', listener: () => void): void
  on(event: 'message' | 'close' | 'messageerror', listener: ((event: { data: unknown }) => void) | (() => void)): void {
    if (event === 'message') this.messages.push(listener as (event: { data: unknown }) => void)
    else this.ends.set(event, [...(this.ends.get(event) ?? []), listener as () => void])
  }
  start(): void { this.started = true }
  postMessage(value: unknown): void { if (this.closed) throw new Error('受控端口已关闭'); this.sent.push(value) }
  receive(value: unknown): void { for (const listener of this.messages) listener({ data: value }) }
  end(event: 'close' | 'messageerror'): void { for (const listener of this.ends.get(event) ?? []) listener() }
  close(): void { if (this.closed) return; this.closed = true; this.end('close') }
}
type Channel = { port1: Port; port2: Port }
class Child implements CoreChildProcess {
  readonly posted: { message: unknown; transfer: readonly unknown[] }[] = []
  private readonly exits: ((code: number) => void)[] = []
  killed = false
  postMessage(message: unknown, transfer: readonly unknown[] = []): void { this.posted.push({ message, transfer }) }
  once(event: 'exit', listener: (code: number) => void): void { assert.equal(event, 'exit'); this.exits.push(listener) }
  kill(): boolean { this.killed = true; this.exit(0); return true }
  exit(code: number): void { for (const listener of this.exits.splice(0)) listener(code) }
}
function harness(t: test.TestContext, alias?: 'public' | 'source' | 'missing') {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const publicChannels: Channel[] = [], sourceChannels: Channel[] = [], relocationChannels: Channel[] = [], children: Child[] = []
  const channel = () => ({ port1: new Port(), port2: new Port() })
  const supervisor = new CoreSupervisor({
    entryPath: '/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-mbrs013-m65qznwo/controlled-core-entry.js',
    cwd: '/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-mbrs013-m65qznwo',
    sourceWritesPort: true, relocationMainPort: true, requestTimeoutMs: 20, startupTimeoutMs: 20,
    dependencies: {
      createChannel: () => { const next = channel(); publicChannels.push(next); return next },
      createSourceWritesChannel: () => { const next = channel(); sourceChannels.push(next); return next },
      ...(alias === 'missing' ? {} : { createRelocationChannel: () => {
        const next = alias === 'public' ? publicChannels.at(-1)! : alias === 'source' ? sourceChannels.at(-1)! : channel()
        relocationChannels.push(next); return next
      } }),
      fork: () => { const child = new Child(); children.push(child); return child },
    },
  })
  // 行为断言仍使用20ms模拟期限；清理恢复真实时钟，让原有有界shutdown/kill完成。
  t.after(async () => { t.mock.timers.reset(); await supervisor.shutdown() })
  const ready = (index = publicChannels.length - 1) => publicChannels[index]!.port2.receive({ version: dto.IPC_VERSION, event: 'core.ready', payload: { state: { runtime: 'ready', roon: 'disconnected', provider: 'missing', activeStreamCount: 0, activePlaybackPresent: false } } })
  return { supervisor, publicChannels, sourceChannels, relocationChannels, children, ready }
}
const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
const request = (port: Port, index = port.sent.length - 1): dto.LocalRelocationMainRequest => port.sent[index] as dto.LocalRelocationMainRequest
function reply(port: Port, value: dto.LocalRelocationMainRequest, result: dto.LocalRelocationMainCommandResults[dto.LocalRelocationMainCommand]): void {
  port.receive({ version: 1, type: 'relocation-main-response', requestId: value.requestId, sequence: value.sequence, ok: true, result })
}
const choice = (number: number): dto.LocalRelocationTargetChoice => ({ choiceId: id(number), kind: 'directory', label: `自有目标${number}`, expiresAt: new Date(Date.now() + 600000).toISOString() })
function confirm(number = 300): dto.LocalRelocationPlanConfirm {
  const plan = readyPlan()
  return { datasetId, commandId: id(number), planId: plan.planId, expectedViewRevision: plan.viewRevision, domain: 'LOCAL_RELOCATION_V1', planHash: plan.planHash, contextFingerprint: plan.contextFingerprint }
}
function challenge(value: dto.LocalRelocationPlanConfirm): dto.LocalRelocationMainChallenge {
  return { ...value, action: 'execute', policyRevision: '1', requestFingerprint: fingerprint('localRelocationPlan.confirm', value), verifiedTargetFingerprint: null, sourceResourceIds: [], expiresAt: new Date(Date.now() + 600000).toISOString(), grant: { domain: 'LOCAL_RELOCATION_V1', action: 'execute', challengeId: id(301), ownerEpoch: id(302), nonce: 'd'.repeat(64), authorityId: id(303), signature: 'e'.repeat(64) } }
}

test('013 Supervisor实际注册独立三端口与bootstrap，公共/旧012/新013能力不混线', async t => {
  const h = harness(t), starting = h.supervisor.start(); h.ready(); await starting
  const published = h.children[0]!.posted[0]!
  assert.deepEqual(published.message, { type: 'musicbridge.core.port', playbackEventProtocol: 'compact-v1', relocationMainPort: 'local-relocation-main-port-v1' })
  assert.deepEqual(published.transfer, [h.publicChannels[0]!.port1, h.sourceChannels[0]!.port1, h.relocationChannels[0]!.port1])
  assert.equal(new Set(published.transfer).size, 3); assert.equal(h.relocationChannels[0]!.port2.started, true)
  const pending = h.supervisor.requestRelocationMain('localRelocationMain.captureTarget', { datasetId, commandId: id(310), kind: 'directory', absolutePath: '/013自有私有目标' })
  const port = h.relocationChannels[0]!.port2, sent = request(port)
  assert.equal(sent.command, 'localRelocationMain.captureTarget'); assert.equal(sent.sequence, 1)
  assert.equal(h.publicChannels[0]!.port2.sent.length, 0); assert.equal(h.sourceChannels[0]!.port2.sent.length, 0)
  const selected = choice(311); reply(port, sent, selected); assert.deepEqual(await pending, dto.localRelocationMainCommandResultSnapshot('localRelocationMain.captureTarget', selected))
})
test('013缺失或借用公共/012端口时fork前拒绝，既有作者端口不转交', async t => {
  for (const alias of ['public', 'source', 'missing'] as const) {
    const h = harness(t, alias)
    await assert.rejects(() => h.supervisor.start()); assert.equal(h.children.length, 0)
    assert.equal(h.publicChannels[0]!.port1.closed, true); assert.equal(h.sourceChannels[0]!.port2.closed, true)
    await h.supervisor.shutdown(); t.mock.timers.reset()
  }
})
test('013私有错dataset/getter请求不消耗seq，已捕获输入不受后续修改影响', async t => {
  const h = harness(t), starting = h.supervisor.start(); h.ready(); await starting
  const port = h.relocationChannels[0]!.port2, value = confirm(); let getters = 0
  await assert.rejects(() => h.supervisor.requestRelocationMain('localRelocationMain.challenge', { datasetId: id(999), confirm: value }))
  const getter = Object.defineProperty({ datasetId, commandId: id(312), kind: 'directory', absolutePath: '/013自有目标' }, 'absolutePath', { enumerable: true, get() { getters++; return '/013自有目标' } })
  await assert.rejects(() => h.supervisor.requestRelocationMain('localRelocationMain.captureTarget', getter as dto.LocalRelocationMainCaptureTarget))
  assert.equal(getters, 0); assert.equal(port.sent.length, 0)
  const original: dto.LocalRelocationMainCaptureTarget = { datasetId, commandId: id(313), kind: 'directory', absolutePath: '/013原具体选择' }
  const pending = h.supervisor.requestRelocationMain('localRelocationMain.captureTarget', original); original.absolutePath = '/013迟到改变'
  const sent = request(port); assert.equal(sent.sequence, 1); assert.equal(sent.command, 'localRelocationMain.captureTarget')
  if (sent.command === 'localRelocationMain.captureTarget') assert.equal(sent.payload.absolutePath, '/013原具体选择')
  const result = choice(314); reply(port, sent, result); assert.deepEqual(await pending, dto.localRelocationMainCommandResultSnapshot('localRelocationMain.captureTarget', result))
})
test('013倒序私有响应按原requestId与seq归属，错seq关闭整个本域且不重发', async t => {
  const h = harness(t), starting = h.supervisor.start(); h.ready(); await starting
  const port = h.relocationChannels[0]!.port2
  const first = h.supervisor.requestRelocationMain('localRelocationMain.captureTarget', { datasetId, commandId: id(315), kind: 'directory', absolutePath: '/013目标一' })
  const second = h.supervisor.requestRelocationMain('localRelocationMain.captureTarget', { datasetId, commandId: id(316), kind: 'directory', absolutePath: '/013目标二' })
  const one = request(port, 0), two = request(port, 1), firstChoice = choice(317), secondChoice = choice(318)
  assert.equal(one.sequence, 1); assert.equal(two.sequence, 2); assert.notEqual(one.requestId, two.requestId)
  reply(port, two, secondChoice); reply(port, one, firstChoice)
  assert.deepEqual(await first, dto.localRelocationMainCommandResultSnapshot('localRelocationMain.captureTarget', firstChoice)); assert.deepEqual(await second, dto.localRelocationMainCommandResultSnapshot('localRelocationMain.captureTarget', secondChoice))
  const third = h.supervisor.requestRelocationMain('localRelocationMain.captureTarget', { datasetId, commandId: id(319), kind: 'directory', absolutePath: '/013目标三' })
  const rejection = assert.rejects(() => third), sent = request(port)
  port.receive({ version: 1, type: 'relocation-main-response', requestId: sent.requestId, sequence: sent.sequence + 1, ok: true, result: choice(320) })
  await rejection; assert.equal(port.closed, true)
  await assert.rejects(() => h.supervisor.requestRelocationMain('localRelocationMain.captureTarget', { datasetId, commandId: id(321), kind: 'directory', absolutePath: '/013目标四' }))
  assert.equal(port.sent.length, 3); assert.equal(h.supervisor.status, 'ready')
})
test('013 Supervisor原execute ACK失联，Main只读GET恢复且相同nonce不自动重发', async t => {
  const h = harness(t), starting = h.supervisor.start(); h.ready(); await starting
  const f = fixture(), plan = readyPlan(); f.plans.set(plan.planId, plan); f.context.policy.enabled = true
  const handlers = new Map<string, (event: boolean, value?: unknown) => unknown>()
  const leaf = installLocalRelocationHandlers<boolean>({ handle: (name, handler) => { handlers.set(name, handler) }, requireTrusted: event => { assert.equal(event, true) }, requestPublic: f.dispatch as LocalRelocationHandlersOptions<boolean>['requestPublic'], requestMain: (command, payload) => h.supervisor.requestRelocationMain(command, payload), pickTarget: async () => ({ canceled: true, filePaths: [] }) })
  t.after(() => leaf.close())
  const value = confirm(322), call = (command: dto.LocalRelocationPlanCommand, payload: unknown) => Promise.resolve(handlers.get('localRelocationPlan:request')!(true, { datasetId, command, payload }))
  const dispatched = call('localRelocationPlan.confirm', value), failed = assert.rejects(() => dispatched)
  await settle(); const port = h.relocationChannels[0]!.port2, auth = request(port)
  assert.equal(auth.command, 'localRelocationMain.challenge'); reply(port, auth, challenge(value)); await settle()
  const execution = request(port); assert.equal(execution.command, 'localRelocationMain.executeGranted')
  if (execution.command === 'localRelocationMain.executeGranted') assert.deepEqual(execution.payload.grant, dto.localRelocationMainCommandResultSnapshot('localRelocationMain.challenge', challenge(value)).grant)
  const receipt = f.receipt('localRelocationPlan.confirm', value, plan)
  t.mock.timers.tick(20); await failed
  await assert.rejects(() => call('localRelocationPlan.confirm', value)); assert.equal(port.sent.length, 2)
  const lookup = await call('localRelocationPlan.get', { datasetId, selector: { kind: 'command', commandId: value.commandId, expectedCommand: 'localRelocationPlan.confirm', requestFingerprint: receipt.requestFingerprint } }) as dto.LocalRelocationPlanGetResult
  assert.equal(lookup.kind === 'command' && lookup.receipt?.requestFingerprint, receipt.requestFingerprint)
  assert.deepEqual(await call('localRelocationPlan.confirm', value), dto.localRelocationPlanCommandResultSnapshot('localRelocationPlan.confirm', receipt)); assert.equal(port.sent.length, 2)
  assert.equal(f.calls.filter(item => item.command === 'localRelocationPlan.confirm').length, 0)
})
test('013物理close或Core重启清空旧inflight，不继承旧nonce、不消费迟到旧port响应', async t => {
  const h = harness(t), starting = h.supervisor.start(); h.ready(); await starting
  const old = h.relocationChannels[0]!.port2, value = confirm(323), capability = challenge(value)
  const pending = h.supervisor.requestRelocationMain('localRelocationMain.executeGranted', { datasetId, confirm: value, grant: capability.grant }), failed = assert.rejects(() => pending)
  const sent = request(old); old.end('messageerror'); await failed
  assert.equal(old.closed, true); assert.equal(old.sent.length, 1)
  h.children[0]!.exit(1); await settle(); h.ready(); await settle()
  assert.equal(h.supervisor.status, 'ready'); assert.equal(h.children.length, 2)
  const fresh = h.relocationChannels[1]!.port2; assert.notEqual(fresh, old); assert.equal(fresh.sent.length, 0)
  const receipt = fixture().receipt('localRelocationPlan.confirm', value, readyPlan()); reply(old, sent, receipt)
  assert.equal(fresh.sent.length, 0)
  const current = h.supervisor.requestRelocationMain('localRelocationMain.captureTarget', { datasetId, commandId: id(324), kind: 'directory', absolutePath: '/013新具体选择' }), freshRequest = request(fresh)
  assert.equal(freshRequest.sequence, 1); assert.equal(freshRequest.command, 'localRelocationMain.captureTarget'); assert.doesNotMatch(JSON.stringify(fresh.sent), /nonce|signature|grant/u)
  const selected = choice(325); reply(fresh, freshRequest, selected); assert.deepEqual(await current, dto.localRelocationMainCommandResultSnapshot('localRelocationMain.captureTarget', selected))
  assert.deepEqual(h.children[1]!.posted[0]!.transfer, [h.publicChannels[1]!.port1, h.sourceChannels[1]!.port1, h.relocationChannels[1]!.port1])
})
