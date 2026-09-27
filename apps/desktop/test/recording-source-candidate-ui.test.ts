import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const id = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`

test('R08 候选扫描需显式点击、只启动完整校验，不自动确认曲目；取消后不可再选择', async t => {
  const { parse, compileScript, compileTemplate } = await import('@vue/compiler-sfc')
  const ts = (await import('typescript')).default, require = createRequire(import.meta.url), vue = require('vue') as typeof import('vue')
  const filename = new URL('../src/renderer/src/components/recording/SourceEvidencePanel.vue', import.meta.url)
  const { descriptor, errors } = parse(await readFile(filename, 'utf8'))
  assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: 'source-candidate-ui' })
  const template = compileTemplate({ source: descriptor.template!.content, filename: 'SourceEvidencePanel.vue', id: 'source-candidate-ui', compilerOptions: { bindingMetadata: script.bindings } })
  assert.deepEqual(template.errors, [])
  const candidate = { id: id(5), fileName: 'a.wav', relativeLabel: 'a.wav', extension: 'wav', size: 176444, modifiedAt: '2026-09-27T00:00:00.000Z' }
  const scan = { id: id(4), rootId: id(1), draftId: id(2), trackId: id(3), expectedDraftRevision: 1, state: 'completed', scannedEntries: 1, skippedSymlinks: 0, skippedUnreadable: 0, candidates: [candidate] }
  const started: unknown[] = [], selected: unknown[] = [], confirmed: unknown[] = []
  const api = {
    async listRecordingSourceRoots() { return { roots: [{ id: id(1), label: '合成源目录', authorized: true, availability: 'ONLINE' }] } },
    async getDraftSources() { return { draftId: id(2), sourceLockEligible: false, tracks: [{ trackId: id(3), jobs: [] }] } },
    async startRecordingSourceCandidateScan(request: unknown) { started.push(request); return scan },
    async getRecordingSourceCandidateScan() { return { scan } },
    async selectRecordingSourceCandidate(request: unknown) { selected.push(request); return { id: id(6), draftId: id(2), trackId: id(3), rootId: id(1), state: 'running' } },
    async confirmRecordingSource(request: unknown) { confirmed.push(request) },
  }
  const compile = (content: string) => ts.transpileModule(content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const module = { exports: {} as { default: import('vue').Component } }
  new Function('require', 'module', 'exports', 'window', compile(script.content))((name: string) => name === 'vue' ? vue : require(name), module, module.exports, { musicBridge: api })
  interface Host { children: Host[]; parent: Host | null; text: string; props: Record<string, unknown> }
  const node = (): Host => ({ children: [], parent: null, text: '', props: {} })
  const renderer = vue.createRenderer<Host, Host>({ createElement: node, createText(text) { return { ...node(), text } }, createComment: node,
    setText(target, text) { target.text = text }, setElementText(target, text) { target.text = text; target.children = [] }, patchProp(target, key, _previous, value) { target.props[key] = value },
    insert(child, parent, anchor) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; if (index < 0) parent.children.push(child); else parent.children.splice(index, 0, child) },
    remove(child) { child.parent?.children.splice(child.parent.children.indexOf(child), 1); child.parent = null }, parentNode: target => target.parent, nextSibling: target => target.parent?.children[(target.parent?.children.indexOf(target) ?? -1) + 1] ?? null,
  })
  const app = renderer.createApp({ ...module.exports.default, render: () => null }, { draftId: id(2), draftRevision: 1, trackId: id(3), title: '合成曲目', inline: true })
  const instance = app.mount(node())
  t.after(() => app.unmount())
  const tick = async () => { await new Promise<void>(resolve => setImmediate(resolve)); await vue.nextTick() }
  await tick()
  const setup = (instance.$ as unknown as { setupState: Record<string, unknown> }).setupState
  assert.equal(started.length, 0)
  ;(setup.startCandidateScan as () => void)(); await tick()
  assert.equal(started.length, 1)
  assert.equal((started[0] as { expectedDraftRevision: number }).expectedDraftRevision, 1)
  setup.selectedCandidateId = candidate.id
  ;(setup.chooseCandidate as () => void)(); await tick()
  assert.equal(selected.length, 1)
  assert.deepEqual((selected[0] as { candidate: unknown }).candidate, { scanId: scan.id, candidateId: candidate.id, expectedDraftRevision: 1 })
  assert.equal(confirmed.length, 0)
  setup.scan = { ...scan, state: 'cancelled' }
  ;(setup.chooseCandidate as () => void)(); await tick()
  assert.equal(selected.length, 1)
})
