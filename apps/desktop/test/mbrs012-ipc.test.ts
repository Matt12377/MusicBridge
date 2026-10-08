import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as dto from '@music-bridge/contracts'
import { installLocalSourceWritesHandlers, sourceWriteFingerprint } from '../src/main/local-source-writes-ipc.js'
import { createCommandOutboxStore } from '../src/main/command-outbox-store.js'
import { createCommandOutboxService } from '../src/main/command-outbox-service.js'
import { createCommandOutboxExecutor } from '../src/main/command-outbox-executor.js'
import { createLocalSourceWritesClient } from '../src/preload/local-source-writes-client.js'
import { canRetryOutboxItem } from '../src/renderer/src/components/command-outbox/controller.js'
import { datasetId, fixture, id, readyPlan, target } from './mbrs012-fixture.js'
type Event = { trusted: boolean }
async function harness(t: test.TestContext) {
  const directory = await mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), 'musicbridge-source-ipc-'))
  const f = fixture(), plan = readyPlan(); f.plans.set(plan.planId, plan)
  const confirm: dto.ConfirmLocalSourceWrites = { datasetId, commandId: id(60), planId: plan.planId, expectedViewRevision: plan.viewRevision, scope: 'SOURCE_FILES', range: plan.range, planHash: plan.planHash!, contextFingerprint: plan.contextFingerprint! }
  const handlers = new Map<string, (event: Event, value?: unknown) => unknown>(), normal: string[] = [], privateCalls: string[] = []
  let privateFailure = false, generic = 0
  let receiptFault: ((value: dto.LocalSourceWritesReceipt) => dto.LocalSourceWritesReceipt) | null = null
  const deliveredReceipt = (value: dto.LocalSourceWritesReceipt) => receiptFault ? receiptFault(value) : value
  const store = createCommandOutboxStore({ filePath: path.join(directory, 'outbox.sqlite') })
  const outbox = createCommandOutboxService({ store, currentDataset: async () => datasetId, execute: async () => { generic++; throw new Error('不应执行通用源写') } })
  const supervisor = {
    request: async (command: dto.LocalSourceWritesCommand, request: dto.LocalSourceWritesCommandPayloads[dto.LocalSourceWritesCommand]) => {
      normal.push(command)
      if (command === 'localSourceWrites.get') return f.api.getLocalSourceWrites(request as dto.GetLocalSourceWrites)
      if (command === 'localSourceWrites.preview') return f.api.previewLocalSourceWrites(request as dto.PreviewLocalSourceWrites)
      if (command === 'localSourceWrites.undo') return deliveredReceipt(await f.api.undoLocalSourceWrites(request as dto.UndoLocalSourceWrites))
      if (command === 'localSourceWrites.setPolicy') return deliveredReceipt(await f.api.setLocalSourceWritesPolicy(request as dto.SetLocalSourceWritesPolicy))
      throw new Error('未用的闭集方法')
    },
    requestSourceWrites: async (command: dto.LocalSourceWritesPrivateCommand, payload: dto.LocalSourceWritesPrivateCommandPayloads[dto.LocalSourceWritesPrivateCommand]) => {
      privateCalls.push(command)
      if (privateFailure) throw new Error('合成私有通道回执丢失')
      if (command === 'localSourceWrites.challenge') { const input = payload as dto.LocalSourceWritesChallengeRequest; return { datasetId, commandId: input.confirm.commandId, planId: input.confirm.planId, expectedViewRevision: input.confirm.expectedViewRevision, range: input.confirm.range, planHash: input.confirm.planHash, contextFingerprint: input.confirm.contextFingerprint, policyRevision: '1', requestFingerprint: sourceWriteFingerprint('localSourceWrites.confirm', input.confirm), expiresAt: new Date(Date.now() + 600000).toISOString(), grant: { challengeId: id(61), ownerEpoch: id(62), nonce: 'd'.repeat(64), authorityId: id(63), signature: 'e'.repeat(64) } } }
      return deliveredReceipt(f.receipt('localSourceWrites.confirm', (payload as dto.ExecuteGrantedLocalSourceWrites).confirm, plan.planId))
    },
  } as unknown as Parameters<typeof installLocalSourceWritesHandlers<Event>>[0]['supervisor']
  const control = installLocalSourceWritesHandlers<Event>({ handle: (channel, handler) => { handlers.set(channel, handler) }, requireTrusted: event => { if (!event.trusted) throw new Error('不可信窗口') }, supervisor, outbox })
  t.after(async () => { control.close(); await outbox.close(); await rm(directory, { recursive: true, force: true }) })
  const call = (command: dto.LocalSourceWritesCommand, payload: unknown, trusted = true) => Promise.resolve(handlers.get('localSourceWrites:request')!({ trusted }, { datasetId, command, payload }))
  return { f, store, outbox, call, control, confirm, privateCalls, normal, generic: () => generic, losePrivate: () => { privateFailure = true }, corruptReceipt: (change: typeof receiptFault) => { receiptFault = change }, supervisor }
}
test('012可信Main最终确认持久落盘后只走专用challenge/execute，不回传grant', async t => {
  const h = await harness(t), result = await h.call('localSourceWrites.confirm', h.confirm)
  assert.equal(dto.isLocalSourceWritesReceipt(result), true); assert.deepEqual(h.privateCalls, ['localSourceWrites.challenge', 'localSourceWrites.executeGranted']); assert.equal(h.generic(), 0); assert.deepEqual(h.normal, [])
  assert.doesNotMatch(JSON.stringify(result), /grant|authorityId|nonce|ownerEpoch/u)
  const entry = h.store.list()[0]!; assert.equal(entry.state, 'succeeded'); assert.equal(entry.canRetry, false); assert.equal(entry.sourceRequestFingerprint, sourceWriteFingerprint('localSourceWrites.confirm', h.confirm))
  await h.call('localSourceWrites.confirm', h.confirm); assert.equal(h.privateCalls.length, 2)
})
test('012不可信窗口、approval/path/未知键/getter/切scope全部零grant；关闭入口也拒绝', async t => {
  const h = await harness(t); let getters = 0
  const getter = Object.defineProperty({ ...h.confirm }, 'planId', { enumerable: true, get() { getters++; return h.confirm.planId } })
  for (const payload of [{ ...h.confirm, approval: true }, { ...h.confirm, path: '/私有路径' }, { ...h.confirm, datasetId: id(90) }, getter]) await assert.rejects(() => h.call('localSourceWrites.confirm', payload))
  await assert.rejects(() => h.call('localSourceWrites.confirm', h.confirm, false)); h.control.close(); await assert.rejects(() => h.call('localSourceWrites.confirm', h.confirm))
  assert.equal(getters, 0); assert.deepEqual(h.privateCalls, []); assert.equal(h.store.list().length, 0)
})
test('012UNKNOWN普通submit/retry/generic executor绝不能再次申请grant，NOT_FOUND不重发', async t => {
  const h = await harness(t); h.losePrivate(); await assert.rejects(() => h.call('localSourceWrites.confirm', h.confirm)); const entry = h.store.list()[0]!
  assert.equal(entry.state, 'uncertain'); assert.equal(canRetryOutboxItem({ ...entry, canRetry: true }, datasetId), false)
  await assert.rejects(() => h.outbox.retry({ id: entry.id, userConfirmed: true })); await assert.rejects(() => h.outbox.submit({ datasetId, command: 'localSourceWrites.confirm', payload: h.confirm }))
  const result = await h.call('localSourceWrites.get', { datasetId, selector: { kind: 'command', commandId: h.confirm.commandId, expectedCommand: 'localSourceWrites.confirm', requestFingerprint: entry.sourceRequestFingerprint! } }) as dto.LocalSourceWritesGetResult
  assert.equal(result.kind === 'command' && result.issue, 'NOT_FOUND'); assert.equal(h.privateCalls.length, 1); assert.equal(h.generic(), 0)
  const executor = createCommandOutboxExecutor({ supervisor: h.supervisor as never, pick: async () => { throw new Error('不能打开选择器') } })
  await assert.rejects(() => executor.execute(h.store.get(entry.id))); assert.equal(h.privateCalls.length, 1)
})
test('012原get(command)已核receipt只更新Outbox metadata，不execute；前端不多取启动scope', async t => {
  const h = await harness(t); h.losePrivate(); await assert.rejects(() => h.call('localSourceWrites.confirm', h.confirm)); const entry = h.store.list()[0]!
  h.f.receipt('localSourceWrites.confirm', h.confirm, h.confirm.planId)
  await h.call('localSourceWrites.get', { datasetId, selector: { kind: 'command', commandId: h.confirm.commandId, expectedCommand: 'localSourceWrites.confirm', requestFingerprint: entry.sourceRequestFingerprint! } })
  assert.equal(h.store.get(entry.id).state, 'succeeded'); assert.equal(h.privateCalls.length, 1); assert.equal(h.generic(), 0)
  let scopes = 0, invokes = 0
  const client = createLocalSourceWritesClient({ scope: async () => { scopes++; return datasetId }, invoke: async (_channel, value) => { invokes++; const request = value as { command: dto.LocalSourceWritesCommand; payload: unknown }; return h.call(request.command, request.payload) } })
  assert.equal(scopes, 0); await client.getLocalSourceWrites({ datasetId, selector: { kind: 'context', target } }); assert.equal(scopes, 1); assert.equal(invokes, 1)
  await assert.rejects(() => client.confirmLocalSourceWrites({ ...h.confirm, approval: true } as dto.ConfirmLocalSourceWrites)); assert.equal(invokes, 1)
})
for (const command of ['localSourceWrites.confirm', 'localSourceWrites.undo', 'localSourceWrites.setPolicy'] as const) {
  test(`012 ${command} 合法shape但错dataset/id/fingerprint的回执不会先存成功，只读对账只保存原绑定`, async t => {
    for (const changed of ['datasetId', 'commandId', 'requestFingerprint'] as const) {
      const h = await harness(t)
      const request = command === 'localSourceWrites.confirm' ? h.confirm : command === 'localSourceWrites.undo'
        ? { datasetId, commandId: id(64), planId: h.confirm.planId, expectedViewRevision: '1', operationIds: [readyPlan().items[0]!.operationId], journalFingerprint: readyPlan().journalFingerprint }
        : { datasetId, commandId: id(65), expectedPolicyRevision: '1', enabled: true }
      let bad: dto.LocalSourceWritesReceipt | null = null
      h.corruptReceipt(value => { bad = { ...value, [changed]: changed === 'requestFingerprint' ? 'f'.repeat(64) : id(90) }; assert.equal(dto.isLocalSourceWritesReceipt(bad), true); return bad })
      await assert.rejects(() => h.call(command, request))
      const entry = h.store.list()[0]!, calls = h.privateCalls.length + h.normal.length
      assert.equal(entry.datasetId, datasetId); assert.equal(entry.commandId, request.commandId); assert.equal(entry.command, command); assert.equal(entry.sourceRequestFingerprint, sourceWriteFingerprint(command, request))
      assert.equal(entry.state, 'uncertain'); assert.equal(entry.canRetry, false); assert.equal(h.store.get(entry.id).result, undefined)
      assert.throws(() => h.outbox.reconcileSourceWrites(entry.id, bad)); assert.equal(h.store.get(entry.id).state, 'uncertain')
      const value = await h.call('localSourceWrites.get', { datasetId, selector: { kind: 'command', commandId: request.commandId, expectedCommand: command, requestFingerprint: entry.sourceRequestFingerprint! } }) as dto.LocalSourceWritesGetResult
      assert.equal(value.kind, 'command')
      if (value.kind !== 'command') throw new Error('必须返回原命令只读结果')
      assert.equal(value.receipt?.datasetId, datasetId); assert.equal(value.receipt?.commandId, request.commandId); assert.equal(value.receipt?.command, command); assert.equal(value.receipt?.requestFingerprint, entry.sourceRequestFingerprint)
      const persisted = h.store.get(entry.id)
      assert.equal(persisted.state, 'succeeded'); assert.ok(dto.isLocalSourceWritesReceipt(persisted.result)); assert.ok(dto.isLocalSourceWritesReceipt(value.receipt))
      // JSON持久回读与合同捕获的原型可不同；先核完整公开合同，再严格比较所有捕获字段。
      assert.deepEqual(dto.localSourceWritesDataSnapshot(persisted.result, 16384), dto.localSourceWritesDataSnapshot(value.receipt, 16384)); assert.equal(h.privateCalls.length + h.normal.length, calls + 1); assert.equal(h.generic(), 0)
    }
  })
}
