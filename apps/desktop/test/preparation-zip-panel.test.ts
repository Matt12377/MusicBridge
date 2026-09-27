import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import type { PreparationZipJob } from '@music-bridge/contracts'

const id = () => randomUUID()
const draftA = id(), draftB = id(), workspaceA = id(), workspaceB = id()
const workspaces = [workspaceA, workspaceB].map(workspaceId => ({ id: workspaceId, trackCount: 1, createdAt: '2026-09-27T00:00:00.000Z' }))
const job = (workspaceId: string, state: PreparationZipJob['state']): PreparationZipJob => ({
  id: id(), workspaceId, draftId: draftA, state, targetLabel: '合成目标.zip', completedFiles: state === 'completed' ? 11 : 0,
  fileCount: 11, zipBytes: state === 'completed' ? 4096 : undefined, zipSha256: state === 'completed' ? 'a'.repeat(64) : undefined,
}) as PreparationZipJob
const history = (draftId: string, jobs: PreparationZipJob[] = []) => ({ draftId, jobs })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function mounted(t: test.TestContext, api: Record<string, unknown>, stores?: { local: Map<string, string>; session: Map<string, string> }) {
  const { parse, compileScript } = await import('@vue/compiler-sfc')
  const ts = (await import('typescript')).default
  const require = createRequire(import.meta.url)
  const vue = require('vue') as typeof import('vue')
  const source = await readFile(new URL('../src/renderer/src/components/recording/PreparationZipPanel.vue', import.meta.url), 'utf8')
  const { descriptor, errors } = parse(source)
  assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: 'preparation-zip-panel-test' })
  const compiled = ts.transpileModule(script.content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const module = { exports: {} as { default: import('vue').Component } }
  const recovery = await import('../src/renderer/src/components/recording/preparation-zip-recovery.js')
  const local = stores?.local ?? new Map<string, string>(), session = stores?.session ?? new Map<string, string>()
  const storage = (values: Map<string, string>) => ({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } })
  const window = { musicBridge: { getCommandOutbox: async () => ({ datasetId: draftA, entries: [] }), getPreparationZipReceipt: async () => ({ status: 'unknown', job: null }), ...api }, localStorage: storage(local), sessionStorage: storage(session) }
  new Function('require', 'module', 'exports', 'window', compiled)((name: string) => name === './preparation-zip-recovery.js' ? recovery : require(name), module, module.exports, window)
  const component = { ...module.exports.default, render: () => null }
  type Host = { parent: Host | null; children: Host[]; text: string }
  const node = (): Host => ({ parent: null, children: [], text: '' })
  const renderer = vue.createRenderer<Host, Host>({
    createElement: node, createText(text) { return { ...node(), text } }, createComment: node,
    setText(item, value) { item.text = value }, setElementText(item, value) { item.text = value; item.children = [] }, patchProp() {},
    insert(child, parent) { child.parent = parent; parent.children.push(child) }, remove(child) { child.parent?.children.splice(child.parent.children.indexOf(child), 1); child.parent = null },
    parentNode: item => item.parent, nextSibling: () => null,
  })
  const props = vue.reactive({ draftId: draftA, workspaces })
  const app = renderer.createApp({ render: () => vue.h(component, props) })
  const root = app.mount(node())
  t.after(() => app.unmount())
  const tick = async () => { await new Promise<void>(done => setImmediate(done)); await vue.nextTick() }
  await tick()
  const child = (root.$.subTree as unknown as { component: { setupState: Record<string, unknown> } }).component
  const setup = child.setupState
  const invoke = async (name: string) => { await (setup[name] as () => Promise<void>)(); await tick() }
  return { setup, props, tick, invoke, local, session, window }
}

test('切换工作区或草稿后，较旧的轮询结果与错误不回填当前 ZIP 记录', async t => {
  const first = deferred<ReturnType<typeof history>>()
  const second = deferred<ReturnType<typeof history>>()
  const calls: string[] = []
  const panel = await mounted(t, { listPreparationZips(draftId: string) {
    calls.push(draftId)
    return calls.length === 1 ? first.promise : calls.length === 2 ? second.promise : history(draftId, [job(workspaceB, 'completed')])
  } })
  panel.setup.workspaceId = workspaceA; await panel.tick()
  panel.setup.workspaceId = workspaceB; await panel.tick()
  assert.equal((panel.setup.history as ReturnType<typeof history>).jobs[0]?.workspaceId, workspaceB)
  second.resolve(history(draftA, [job(workspaceA, 'running')]))
  first.resolve(history(draftA, [job(workspaceA, 'running')]))
  await panel.tick()
  assert.equal((panel.setup.history as ReturnType<typeof history>).jobs[0]?.workspaceId, workspaceB)
  panel.props.draftId = draftB; await panel.tick()
  assert.equal(panel.setup.workspaceId, '')
  assert.equal((panel.setup.history as ReturnType<typeof history>).draftId, draftB)
})

test('启动与取消的迟到回执不能污染新工作区提示或重试状态', async t => {
  const start = deferred<PreparationZipJob>(), cancel = deferred<PreparationZipJob>()
  const panel = await mounted(t, {
    listPreparationZips: async (draftId: string) => history(draftId),
    startPreparationZip: () => start.promise,
    cancelPreparationZipJob: () => cancel.promise,
  })
  panel.setup.workspaceId = workspaceA; await panel.tick()
  panel.setup.pendingStart = { commandId: id(), workspaceId: workspaceA, targetId: id(), proposalFingerprint: 'a'.repeat(64), userConfirmed: true }
  panel.setup.pendingStartScope = { draftId: draftA, workspaceId: workspaceA }
  const pendingStart = (panel.setup.submitStart as () => Promise<void>)()
  panel.setup.workspaceId = workspaceB; await panel.tick()
  start.resolve(job(workspaceA, 'running')); await pendingStart; await panel.tick()
  assert.doesNotMatch(String(panel.setup.notice), /正在打包|ZIP 已核验/u)
  assert.equal(panel.setup.pendingStart, undefined)
  assert.equal(panel.setup.busy, false)
  panel.setup.workspaceId = workspaceA; await panel.tick()
  panel.setup.pendingCancel = { commandId: id(), id: id() }
  panel.setup.pendingCancelScope = { draftId: draftA, workspaceId: workspaceA }
  const pendingCancel = (panel.setup.submitCancel as () => Promise<void>)()
  panel.setup.workspaceId = workspaceB; await panel.tick()
  cancel.resolve(job(workspaceA, 'completed')); await pendingCancel; await panel.tick()
  assert.doesNotMatch(String(panel.setup.notice), /ZIP 已核验/u)
  assert.equal(panel.setup.pendingCancel, undefined)
  assert.equal(panel.setup.busy, false)
})

test('已接受但丢失的启动回执按完整原请求核对，跨工作区不污染提示', async t => {
  const originalCommandId = id()
  const accepted = { ...job(workspaceA, 'completed'), id: originalCommandId }
  const commandIds: string[] = []
  const receiptIds: string[] = []
  let attempts = 0
  const checked = deferred<{ status: 'accepted'; job: PreparationZipJob }>()
  const panel = await mounted(t, {
    listPreparationZips: async (draftId: string) => history(draftId, attempts ? [accepted] : []),
    startPreparationZip: async (request: { commandId: string }) => {
      commandIds.push(request.commandId)
      if (++attempts === 1) throw new Error('合成 IPC 回执丢失；服务端已接受')
      return accepted
    },
    getPreparationZipReceipt: (request: { request: { commandId: string } }) => { receiptIds.push(request.request.commandId); return checked.promise },
  })
  panel.setup.workspaceId = workspaceA; await panel.tick()
  panel.setup.pendingStart = { commandId: originalCommandId, workspaceId: workspaceA, targetId: id(), proposalFingerprint: 'a'.repeat(64), userConfirmed: true }
  panel.setup.pendingStartScope = { draftId: draftA, workspaceId: workspaceA }
  const pending = (panel.setup.submitStart as () => Promise<void>)()
  await panel.tick()
  assert.equal(panel.setup.uncertain, true)
  assert.equal((panel.setup.pendingStart as { commandId: string }).commandId, originalCommandId)
  panel.setup.workspaceId = workspaceB; await panel.tick()
  assert.equal(panel.setup.uncertain, true)
  checked.resolve({ status: 'accepted', job: accepted }); await pending; await panel.tick()
  assert.deepEqual(commandIds, [originalCommandId])
  assert.deepEqual(receiptIds, [originalCommandId])
  assert.equal(panel.setup.uncertain, false)
  assert.equal(panel.setup.pendingStart, undefined)
  assert.doesNotMatch(String(panel.setup.notice), /ZIP 已核验/u)
})

test('同一任务的完成轮询替换过期的正在打包提示', async t => {
  const running = job(workspaceA, 'running')
  const complete = { ...running, state: 'completed' as const, completedFiles: 11, zipBytes: 4096, zipSha256: 'b'.repeat(64) }
  let currentJobs: PreparationZipJob[] = []
  const panel = await mounted(t, {
    listPreparationZips: async (draftId: string) => history(draftId, currentJobs),
    startPreparationZip: async () => { currentJobs = [complete]; return running },
  })
  panel.setup.workspaceId = workspaceA; await panel.tick()
  panel.setup.pendingStart = { commandId: id(), workspaceId: workspaceA, targetId: id(), proposalFingerprint: 'a'.repeat(64), userConfirmed: true }
  panel.setup.pendingStartScope = { draftId: draftA, workspaceId: workspaceA }
  await panel.invoke('submitStart')
  assert.match(String(panel.setup.notice), /ZIP 已核验并导出/u)
  assert.doesNotMatch(String(panel.setup.notice), /正在打包/u)
  assert.equal((panel.setup.history as ReturnType<typeof history>).jobs[0]?.id, running.id)
})

test('明确拒绝且精确账本无回执，清除原命令并要求重新选择目标', async t => {
  const panel = await mounted(t, {
    listPreparationZips: async (draftId: string) => history(draftId),
    startPreparationZip: async () => { throw new Error('[INVALID_IPC_REQUEST] 目标已过期') },
  })
  panel.setup.workspaceId = workspaceA; await panel.tick()
  panel.setup.pendingStart = { commandId: id(), workspaceId: workspaceA, targetId: id(), proposalFingerprint: 'a'.repeat(64), userConfirmed: true }
  panel.setup.pendingStartScope = { draftId: draftA, workspaceId: workspaceA }
  await panel.invoke('submitStart')
  assert.equal(panel.setup.pendingStart, undefined)
  assert.equal(panel.setup.uncertain, false)
  assert.match(String(panel.setup.error), /明确拒绝.*重新选择 ZIP 目标/u)
})

test('冷启按 dataset 和完整原号查回执；只依据 Core 的 accepted/not-accepted/unknown 收口', async t => {
  const commandId = id(), oldEpoch = id(), targetId = id(), datasetId = draftA
  const request = { commandId, workspaceId: workspaceA, targetId, proposalFingerprint: 'a'.repeat(64), userConfirmed: true }
  const local = new Map<string, string>([[`musicbridge.preparationZip.pending.v1.${datasetId}.${draftA}`,
    JSON.stringify({ kind: 'start', request, draftId: draftA, workspaceId: workspaceA, windowEpoch: oldEpoch })]])
  const seen: unknown[] = []
  const accepted = { ...job(workspaceA, 'completed'), id: commandId }
  const panel = await mounted(t, {
    listPreparationZips: async (draftId: string) => history(draftId, [accepted]),
    startPreparationZip: async () => { throw new Error('冷启不得重发旧目标') },
    getPreparationZipReceipt: async (value: unknown) => { seen.push(value); return { status: 'accepted', job: accepted } },
  }, { local, session: new Map() })
  assert.deepEqual(seen, [{ kind: 'start', request }])
  assert.equal(local.size, 0)
  assert.equal(panel.setup.pendingStart, undefined)
  assert.equal(panel.setup.uncertain, false)

  const absentLocal = new Map<string, string>([[`musicbridge.preparationZip.pending.v1.${datasetId}.${draftA}`,
    JSON.stringify({ kind: 'start', request, draftId: draftA, workspaceId: workspaceA, windowEpoch: oldEpoch })]])
  const absent = await mounted(t, {
    listPreparationZips: async (draftId: string) => history(draftId),
    startPreparationZip: async () => { throw new Error('冷启不得重发旧目标') },
    getPreparationZipReceipt: async () => ({ status: 'not-accepted', job: null }),
  }, { local: absentLocal, session: new Map() })
  assert.equal(absentLocal.size, 0)
  assert.equal(absent.setup.pendingStart, undefined)
  assert.equal(absent.setup.uncertain, false)
  assert.match(String(absent.setup.error), /未被 Core 接受.*旧目标已失效/u)

  const unknownLocal = new Map<string, string>([[`musicbridge.preparationZip.pending.v1.${datasetId}.${draftA}`,
    JSON.stringify({ kind: 'start', request, draftId: draftA, workspaceId: workspaceA, windowEpoch: oldEpoch })]])
  const unknown = await mounted(t, {
    listPreparationZips: async (draftId: string) => history(draftId),
    startPreparationZip: async () => { throw new Error('冷启不得重发旧目标') },
    getPreparationZipReceipt: async () => ({ status: 'unknown', job: null }),
  }, { local: unknownLocal, session: new Map() })
  assert.equal(unknownLocal.size, 1)
  assert.equal((unknown.setup.pendingStart as { commandId: string }).commandId, commandId)
  assert.equal(unknown.setup.uncertain, true)
  assert.match(String(unknown.setup.error), /旧窗口的原操作.*是否仍在途未知/u)
})
