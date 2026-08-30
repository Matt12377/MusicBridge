import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { compileScript, parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import * as contracts from '@music-bridge/contracts'

const require = createRequire(import.meta.url)
const vue = require('vue') as typeof import('vue')
const ids = [randomUUID(), randomUUID(), randomUUID()]
type Request = { commandId: string; id: string }
interface HostNode { children: HostNode[]; parent: HostNode | null }
interface PanelSetup {
  phase: 'idle' | 'import' | 'review'; selectedIds: Record<string, string>; stopChecks(): Promise<void>
  pendingAbort?: () => Promise<void>; aborting: boolean; notice: string; error: string
  preparationId: string; destinationId: string; importJobId: string; history: unknown
}
const node = (): HostNode => ({ children: [], parent: null })
const renderer = vue.createRenderer<HostNode, HostNode>({
  createElement: node, createText: node, createComment: node, setText() {}, setElementText() {}, patchProp() {},
  insert(child, parent) { child.parent = parent; parent.children.push(child) },
  remove(child) { if (child.parent) child.parent.children = child.parent.children.filter(item => item !== child) },
  parentNode: child => child.parent, nextSibling: () => null,
})

async function panelFixture(t: test.TestContext) {
  const source = await readFile(new URL('../src/renderer/src/components/recording/PreparedPanel.vue', import.meta.url), 'utf8')
  const { descriptor, errors } = parse(source)
  assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: 'prepared-revocations-behavior' })
  const compiled = ts.transpileModule(script.content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const persisted: Request[] = [], batches: Request[][] = [], singles: Request[] = [], destinations: Request[] = []
  let failReceipt = true, refreshes = 0
  let wait: Promise<void> | undefined
  const api = {
    async revokePreparedSelection(request: Request) { singles.push({ ...request }); persisted.push({ ...request }); if (failReceipt) throw new Error('合成首项回执丢失') },
    async revokePreparedSelections(requests: readonly Request[]) {
      batches.push(structuredClone(requests) as Request[])
      persisted.push(...requests.map(request => ({ ...request })))
      if (wait) await wait
      if (failReceipt) throw new Error('合成批次回执丢失')
      return requests.map(request => ({ id: request.id, preparationId: ids[0], side: 'A', label: '合成 WAV', authorized: false }))
    },
    async revokePreparationDestination(request: Request) { destinations.push({ ...request }) },
    async listMasterVersions() { refreshes++; return { layouts: [], masters: [] } },
    async listPreparations() { return { workspaces: [] } },
    async listPrepared() { return { jobs: [], preps: [] } },
    async listPreparationDestinations() { return { destinations: [] } },
    async listPreparedSelections() { return { selections: [] } },
  }
  const module = { exports: {} as { default: import('vue').Component } }
  const load = (name: string) => name === 'vue' ? vue : name === '@music-bridge/contracts' ? contracts : require(name)
  new Function('require', 'module', 'exports', 'window', 'crypto', compiled)(load, module, module.exports, { musicBridge: api }, { randomUUID })
  const component = { ...module.exports.default, render: () => null }
  const app = renderer.createApp(component, { draft: { id: randomUUID(), title: '合成撤权测试' } })
  const instance = app.mount(node())
  let unmounted = false
  const unmount = () => { if (!unmounted) { unmounted = true; app.unmount() } }
  t.after(unmount)
  await new Promise<void>(resolve => setImmediate(resolve))
  const state = (instance.$ as unknown as { setupState: PanelSetup }).setupState
  return { state, persisted, batches, singles, destinations, unmount,
    succeed: () => { failReceipt = false }, hold: (value: Promise<void>) => { wait = value }, refreshes: () => refreshes }
}

test('实际PreparedPanel首项失败时完整三项已交给单次批量入口，尾项不能留在Renderer闭包', async t => {
  const f = await panelFixture(t)
  f.state.phase = 'import'; f.state.selectedIds = { A: ids[0]!, B: ids[1]!, Program: ids[2]! }
  await f.state.stopChecks()
  assert.deepEqual(f.persisted.map(request => request.id), ids)
  assert.equal(f.batches.length, 1)
  assert.equal(f.singles.length, 0)
  assert.equal(new Set(f.batches[0]!.map(request => request.commandId)).size, 3)
  assert.ok(f.state.pendingAbort)
  assert.match(f.state.error, /重试原撤权操作/u)
  assert.equal(f.state.aborting, false)
})

test('明确重试保留原完整请求，选择变化不能更换撤权目标或commandId', async t => {
  const f = await panelFixture(t)
  f.state.phase = 'import'; f.state.selectedIds = { A: ids[0]!, B: ids[1]! }
  await f.state.stopChecks()
  const original = f.batches[0]
  assert.ok(original)
  const operation = f.state.pendingAbort
  f.state.selectedIds = { Program: ids[2]! }; f.state.phase = 'idle'
  assert.equal(f.state.pendingAbort, operation)
  assert.equal(f.batches.length, 1, '状态变化不能自动重试')
  f.succeed(); await f.state.stopChecks()
  assert.deepEqual(f.batches, [original, original])
  assert.equal(f.state.pendingAbort, undefined)
  assert.match(f.state.notice, /已有文件和历史不会删除/u)
})

test('批次中途不重复提交，卸载后不刷新或更新回执也不开始新撤权', async t => {
  const f = await panelFixture(t)
  let finish!: () => void
  f.hold(new Promise<void>(resolve => { finish = resolve })); f.succeed()
  f.state.phase = 'import'; f.state.selectedIds = { A: ids[0]!, B: ids[1]! }
  const first = f.state.stopChecks()
  await f.state.stopChecks()
  assert.equal(f.batches.length, 1)
  assert.equal(f.state.aborting, true)
  const refreshes = f.refreshes(), notice = f.state.notice
  f.unmount(); finish(); await first
  assert.equal(f.refreshes(), refreshes)
  assert.equal(f.state.notice, notice)
  await f.state.stopChecks()
  assert.equal(f.batches.length, 1)
})

test('空集合、非法ID、重复或超过三个面不能进入批次，未选择空面不产生空ID', async t => {
  const invalidSelections: Record<string, string>[] = [{}, { A: '' }, { A: 'invalid-id' }, { A: ids[0]!, B: ids[0]! }, { A: ids[0]!, B: ids[1]!, Program: ids[2]!, extra: randomUUID() }]
  for (const selected of invalidSelections) {
    const f = await panelFixture(t)
    f.state.phase = 'import'; f.state.selectedIds = selected
    await f.state.stopChecks()
    assert.equal(f.batches.length, 0)
    assert.equal(f.singles.length, 0)
    assert.equal(f.state.pendingAbort, undefined)
    assert.match(f.state.error, /选择|授权/u)
  }
  const f = await panelFixture(t); f.succeed()
  f.state.phase = 'import'; f.state.selectedIds = { A: ids[0]!, B: '' }
  await f.state.stopChecks()
  assert.deepEqual(f.batches[0]?.map(request => request.id), [ids[0]])
})

test('review停止仍撤销已导入记录的原目标，不改成当前下拉目标或文件批次', async t => {
  const f = await panelFixture(t)
  f.state.preparationId = ids[0]!
  await vue.nextTick()
  f.state.history = { preps: [], jobs: [{ id: ids[1], preparationId: ids[0], destinationId: ids[2], state: 'completed' }] }
  f.state.importJobId = ids[1]!
  f.state.destinationId = randomUUID(); f.state.phase = 'review'
  await f.state.stopChecks()
  assert.equal(f.destinations.length, 1)
  assert.equal(f.destinations[0]?.id, ids[2])
  assert.equal(f.batches.length, 0)
  assert.equal(f.singles.length, 0)
})
