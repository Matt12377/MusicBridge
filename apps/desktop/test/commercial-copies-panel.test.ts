import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const id = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`

test('商业逐件照片选择按实物卡片隔离，不能把另一件的选择确认到本件', async t => {
  const { parse, compileScript, compileTemplate } = await import('@vue/compiler-sfc')
  const ts = (await import('typescript')).default, require = createRequire(import.meta.url), vue = require('vue') as typeof import('vue')
  const filename = new URL('../src/renderer/src/components/collection/CommercialCopiesPanel.vue', import.meta.url)
  const { descriptor, errors } = parse(await readFile(filename, 'utf8'))
  assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: 'commercial-copies-ui' })
  const template = compileTemplate({ source: descriptor.template!.content, filename: 'CommercialCopiesPanel.vue', id: 'commercial-copies-ui', compilerOptions: { bindingMetadata: script.bindings } })
  assert.deepEqual(template.errors, [])
  const release = { id: id(1), kind: 'cd', title: '合成发行版', artist: '合成作者', quantity: 2, revision: 1, contentStatus: 'commercial' }
  const photos = [id(4), id(5)].map(photoId => ({ id: photoId, releaseId: release.id, width: 80, height: 80, source: 'user-photo' }))
  const copies = [id(2), id(3)].map(copyId => ({ id: copyId, releaseId: release.id, assignedAt: '2026-09-27T00:00:00.000Z', revision: 1, details: {}, photoIds: [] }))
  const snapshot = { releaseId: release.id, quantity: 2, assignedCount: 2, poolCount: 0, photoAssignments: [],
    copies: { items: copies, offset: 0, limit: 20, total: 2, hasMore: false } }
  const assigned: unknown[] = []
  const api = {
    async getCommercialCopies() { return snapshot },
    async assignCommercialCopyPhoto(request: unknown) { assigned.push(request); return { id: release.id, copyId: (request as { copyId: string }).copyId } },
  }
  const module = { exports: {} as { default: import('vue').Component } }
  const compile = (content: string) => ts.transpileModule(content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  new Function('require', 'module', 'exports', 'window', compile(script.content))((name: string) =>
    name === 'vue' ? vue : name === './CollectionPhoto.vue' ? { default: { render: () => null } } : require(name), module, module.exports, { musicBridge: api })
  interface Host { children: Host[]; parent: Host | null; text: string; props: Record<string, unknown> }
  const node = (): Host => ({ children: [], parent: null, text: '', props: {} })
  const renderer = vue.createRenderer<Host, Host>({ createElement: node, createText(text) { return { ...node(), text } }, createComment: node,
    setText(target, text) { target.text = text }, setElementText(target, text) { target.text = text; target.children = [] }, patchProp(target, key, _previous, value) { target.props[key] = value },
    insert(child, parent, anchor) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; if (index < 0) parent.children.push(child); else parent.children.splice(index, 0, child) },
    remove(child) { child.parent?.children.splice(child.parent.children.indexOf(child), 1); child.parent = null }, parentNode: target => target.parent, nextSibling: target => target.parent?.children[(target.parent?.children.indexOf(target) ?? -1) + 1] ?? null,
  })
  const app = renderer.createApp({ ...module.exports.default, render: () => null }, { release, photos })
  const instance = app.mount(node())
  t.after(() => app.unmount())
  const tick = async () => { await new Promise<void>(resolve => setImmediate(resolve)); await vue.nextTick() }
  await tick()
  const setup = (instance.$ as unknown as { setupState: Record<string, unknown> }).setupState
  setup.selectedPhotoByCopy = { [copies[0]!.id]: photos[0]!.id, [copies[1]!.id]: photos[1]!.id }
  await tick()
  const selectedPhotoFor = setup.selectedPhotoFor as (copyId: string) => { id: string } | undefined
  const assignPhoto = setup.assignPhoto as (copyId: string, photoId: string, action: 'attach' | 'detach') => void
  assert.equal(selectedPhotoFor(copies[0]!.id)?.id, photos[0]!.id)
  assert.equal(selectedPhotoFor(copies[1]!.id)?.id, photos[1]!.id)
  assignPhoto(copies[0]!.id, photos[1]!.id, 'attach')
  assignPhoto(copies[1]!.id, photos[0]!.id, 'attach')
  await tick()
  assert.equal(assigned.length, 0, '跨卡片传入另一件的照片不得派发写入')
  assignPhoto(copies[1]!.id, photos[1]!.id, 'attach')
  await tick()
  assert.equal(assigned.length, 1)
  assert.deepEqual(assigned[0], { commandId: (assigned[0] as { commandId: string }).commandId, copyId: copies[1]!.id,
    photoId: photos[1]!.id, expectedRevision: 1, action: 'attach', userConfirmed: true })
})
