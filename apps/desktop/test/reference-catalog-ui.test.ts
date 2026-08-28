import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createReferenceCatalogController, hashReferenceSourceText, readReferenceSourceFile } from '../src/renderer/src/components/collection/reference-catalog-controller.js'
import type { CanonicalReference, CatalogRevisionDetail, CatalogRevisionPreview, SourcePack } from '@music-bridge/contracts'

test('显式JSON文件读取保留原UTF8、CRLF和空白，Hash不是重新序列化对象的Hash', async () => {
  const rawPack = '{\r\n  "title": "合成资料"\r\n}\r\n'
  const bytes = new TextEncoder().encode(rawPack)
  let reads = 0
  const file = { name: 'synthetic.json', size: bytes.byteLength, arrayBuffer: async () => { reads++; return bytes.buffer } }
  assert.equal(reads, 0)
  const result = await readReferenceSourceFile(file)
  assert.equal(result, rawPack)
  assert.equal(reads, 1)
  const hash = await hashReferenceSourceText(result)
  assert.equal(hash, createHash('sha256').update(bytes).digest('hex'))
  assert.notEqual(hash, createHash('sha256').update(JSON.stringify(JSON.parse(rawPack))).digest('hex'))
})

test('文件选择拒绝非JSON、超限和非法UTF8，不悄悄替换源字节', async () => {
  let reads = 0
  const arrayBuffer = async () => { reads++; return new Uint8Array([0xc3, 0x28]).buffer }
  await assert.rejects(readReferenceSourceFile({ name: 'source.txt', size: 2, arrayBuffer }), /JSON/u)
  await assert.rejects(readReferenceSourceFile({ name: 'source.json', size: 1_048_577, arrayBuffer }), /1 MiB/u)
  assert.equal(reads, 0)
  await assert.rejects(readReferenceSourceFile({ name: 'source.json', size: 2, arrayBuffer }), /UTF-8/u)
  await assert.rejects(readReferenceSourceFile({ name: 'source.json', size: 1, arrayBuffer: async () => new ArrayBuffer(1_048_577) }), /1 MiB/u)
  await assert.rejects(hashReferenceSourceText('\ud800'), /UTF-8/u)
})

test('UTF8 BOM保留给严格包预览处理，不从原文或Hash中静默删除', async () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d])
  const rawPack = await readReferenceSourceFile({ name: 'source.JSON', size: bytes.length, arrayBuffer: async () => bytes.buffer })
  assert.equal(rawPack, '\ufeff{}')
  assert.equal(await hashReferenceSourceText(rawPack), createHash('sha256').update(bytes).digest('hex'))
})

const sourceId = '11111111-1111-4111-8111-111111111111'
const revisionId = '22222222-2222-4222-8222-222222222222'
const snapshotId = '33333333-3333-4333-8333-333333333333'
const modelId = '44444444-4444-4444-8444-444444444444'
const canonical: CanonicalReference = { referenceId: 'synthetic-a', bookId: 'synthetic-book', brand: '合成', series: '测试系列', edition: '测试版', model: 'A', lengths: [60], iec: 'II', era: '1990年代', image: { kind: 'none' }, pages: ['1'], notes: '仅合成', confidence: 'high' }
const pack: SourcePack = { schemaVersion: 1, bookId: 'synthetic-book', title: '合成资料', sourceVersion: '示例一', items: [canonical] }
const counts = { total: 1, owned: 0, missing: 0, unknown: 1, candidate: 0, needsReview: 0 }
const timestamp = '2026-08-28T00:00:00.000Z'
const source = { id: sourceId, bookId: pack.bookId, title: pack.title, sourceVersion: pack.sourceVersion, packHash: 'a'.repeat(64), itemCount: 1, createdAt: timestamp }
const snapshot = { id: snapshotId, bookId: pack.bookId, revisionId, matchVersion: 0, createdAt: timestamp, counts, entries: [{ referenceId: canonical.referenceId, state: 'unknown' as const, stockCount: 0, matches: [] }] }
const detail: CatalogRevisionDetail = { revision: { id: revisionId, bookId: pack.bookId, sourceId, packHash: source.packHash, sequence: 1, previousRevisionId: null, items: [canonical], mappings: [], createdAt: timestamp }, matches: [], matchVersion: 0, snapshot, currentCounts: counts, currentEntries: snapshot.entries }
const preview: CatalogRevisionPreview = { baselineFingerprint: 'b'.repeat(64), expectedCurrentRevisionId: null, counts, entries: snapshot.entries, delta: { addedReferenceIds: [canonical.referenceId], removedReferenceIds: [], retainedReferenceIds: [], merged: 0, split: 0, before: null, after: counts } }

function controllerFixture() {
  const calls: { method: string; request: unknown }[] = []
  let failRegister = false
  const api: Parameters<typeof createReferenceCatalogController>[0]['api'] = {
    async listReferenceSources(request) { calls.push({ method: 'sources', request }); return { items: [source], total: 1, offset: 0, limit: 25 } },
    async getReferenceSource(request) { calls.push({ method: 'source', request }); return { source, rawPack: JSON.stringify(pack) } },
    async registerReferenceSource(request) { calls.push({ method: 'register', request: structuredClone(request) }); if (failRegister) throw new Error('[OUTBOX_RESULT_UNKNOWN] /private/secret'); return { ...source, packHash: request.packHash } },
    async previewCatalogRevision(request) { calls.push({ method: 'preview', request: structuredClone(request) }); return preview },
    async publishCatalogRevision(request) { calls.push({ method: 'publish', request: structuredClone(request) }); return detail },
    async getCatalogRevision(request) { calls.push({ method: 'revision', request }); return detail },
    async setCatalogMatch(request) { calls.push({ method: 'match', request: structuredClone(request) }); return { ...detail, matchVersion: 1 } },
    async getCatalogSnapshot(request) { calls.push({ method: 'snapshot', request }); return snapshot },
    async getCatalogHistory(request) { calls.push({ method: 'history', request }); return { bookId: pack.bookId, currentRevisionId: null, revisions: [], snapshots: [], total: 0, offset: 0, limit: 25 } },
    async listCollection(page) { calls.push({ method: 'models', request: page }); return { items: [], offset: 0, limit: 100, total: 0, hasMore: false } },
  }
  const controller = createReferenceCatalogController({ api })
  return { controller, api, calls, failRegister: (value: boolean) => { failRegister = value } }
}

test('打开只读取，来源严格预览保留原包；确认前不登记且默认没有书籍或库存写入', async () => {
  const f = controllerFixture()
  assert.equal(f.calls.length, 0)
  assert.equal(f.controller.state.rawPack, '')
  await f.controller.start()
  assert.deepEqual(f.calls.map(call => call.method), ['sources', 'models'])
  const raw = JSON.stringify(pack, null, 2) + '\r\n'
  f.controller.setRawPack(raw)
  await f.controller.previewSource()
  assert.equal(f.controller.state.sourcePreview?.packHash, createHash('sha256').update(raw).digest('hex'))
  assert.equal(f.controller.state.rawPack, raw)
  await f.controller.registerSource(false)
  assert.equal(f.calls.some(call => call.method === 'register'), false)
  f.controller.setRawPack('{"schemaVersion":1,"unknown":true}')
  await f.controller.previewSource()
  assert.equal(f.controller.state.sourcePreview, undefined)
  assert.ok(f.controller.state.error)
  f.controller.dispose()
})

test('登记回执未知保留原text/hash/commandId，明确重试且错误不泄露原路径', async () => {
  const f = controllerFixture(), raw = JSON.stringify(pack, null, 2)
  f.controller.setRawPack(raw); await f.controller.previewSource(); f.failRegister(true)
  await f.controller.registerSource(true)
  const first = f.calls.find(call => call.method === 'register')!
  assert.ok(f.controller.state.pendingLabel)
  assert.doesNotMatch(f.controller.state.error, /private|secret/u)
  f.controller.setRawPack('changed')
  assert.equal(f.controller.state.rawPack, raw)
  f.failRegister(false); await f.controller.retry()
  assert.deepEqual(f.calls.filter(call => call.method === 'register').map(call => call.request), [first.request, first.request])
  assert.equal(f.controller.state.pendingLabel, undefined)
  assert.equal(f.controller.state.step, 'revision')
  f.controller.dispose()
})

test('发布先预览后独立确认，草案编辑失效旧指纹，禁止凭空提交', async () => {
  const f = controllerFixture()
  await f.controller.selectSource(sourceId)
  await f.controller.publishRevision(true)
  assert.equal(f.calls.some(call => call.method === 'publish'), false)
  await f.controller.previewRevision()
  await f.controller.publishRevision(false)
  assert.equal(f.calls.some(call => call.method === 'publish'), false)
  f.controller.setDraft([{ ...canonical, notes: '明确编辑' }], [])
  assert.equal(f.controller.state.revisionPreview, undefined)
  await f.controller.previewRevision(); await f.controller.publishRevision(true)
  const request = f.calls.find(call => call.method === 'publish')!.request as { baselineFingerprint: string; items: CanonicalReference[] }
  assert.equal(request.baselineFingerprint, preview.baselineFingerprint)
  assert.equal(request.items[0]?.notes, '明确编辑')
  assert.equal(f.controller.state.step, 'review')
  f.controller.dispose()
})

test('审核显式区分Missing/Unknown与候选，带原matchVersion，不写库存', async () => {
  const f = controllerFixture()
  await f.controller.selectSource(sourceId); await f.controller.previewRevision(); await f.controller.publishRevision(true)
  await f.controller.saveMatch({ referenceId: canonical.referenceId, modelId: null, status: 'unmatched', availability: 'missing' }, false)
  assert.equal(f.calls.some(call => call.method === 'match'), false)
  await f.controller.saveMatch({ referenceId: canonical.referenceId, modelId, status: 'candidate', availability: 'unknown' }, true)
  const request = f.calls.find(call => call.method === 'match')!.request as { expectedMatchVersion: number; match: unknown }
  assert.equal(request.expectedMatchVersion, 0)
  assert.deepEqual(request.match, { referenceId: canonical.referenceId, modelId, status: 'candidate', availability: 'unknown' })
  f.controller.dispose()
})

test('历史snapshot比较仅调用读取API，失败不清空已加载的当前目录', async () => {
  const f = controllerFixture()
  await f.controller.selectSource(sourceId); await f.controller.previewRevision(); await f.controller.publishRevision(true)
  const before = f.controller.state.current
  await f.controller.compareSnapshots(snapshotId, snapshotId)
  assert.deepEqual(f.controller.state.comparison?.added, [])
  assert.deepEqual(f.controller.state.comparison?.removed, [])
  f.api.getCatalogRevision = async () => { throw new Error('/private/hidden') }
  await f.controller.loadHistoricalRevision(revisionId)
  assert.deepEqual(f.controller.state.current, before)
  assert.doesNotMatch(f.controller.state.error, /private|hidden/u)
  f.controller.dispose()
})


test('同一发布单飞，关闭后迟到回执不更新状态；重新打开不自动重试', async () => {
  const f = controllerFixture()
  await f.controller.selectSource(sourceId); await f.controller.previewRevision()
  let complete!: (value: CatalogRevisionDetail) => void
  let writes = 0
  f.api.publishCatalogRevision = async () => { writes++; return new Promise(resolve => { complete = resolve }) }
  const first = f.controller.publishRevision(true)
  await f.controller.publishRevision(true); await f.controller.retry()
  assert.equal(writes, 1)
  f.controller.dispose(); complete(detail); await first
  assert.equal(f.controller.state.current, undefined)
  const reopened = controllerFixture(); await reopened.controller.start()
  assert.equal(reopened.calls.some(call => ['register', 'publish', 'match'].includes(call.method)), false)
  reopened.controller.dispose()
})

test('实际面板默认空来源；显式合成示例与独立确认才能登记，不由切步骤触发写入', async t => {
  const { readFile } = await import('node:fs/promises')
  const { createRequire } = await import('node:module')
  const { parse, compileScript, compileTemplate } = await import('@vue/compiler-sfc')
  const ts = (await import('typescript')).default
  const require = createRequire(import.meta.url)
  const vue = require('vue') as typeof import('vue')
  const sourceText = await readFile(new URL('../src/renderer/src/components/collection/ReferenceCatalogPanel.vue', import.meta.url), 'utf8')
  const { descriptor, errors } = parse(sourceText)
  assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: 'reference-catalog-test' })
  const template = compileTemplate({ id: 'reference-catalog-test', source: descriptor.template!.content, filename: 'ReferenceCatalogPanel.vue', compilerOptions: { bindingMetadata: script.bindings } })
  assert.deepEqual(template.errors, [])
  const compiled = ts.transpileModule(script.content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const contracts = await import('@music-bridge/contracts')
  const controllerModule = await import('../src/renderer/src/components/collection/reference-catalog-controller.js')
  const f = controllerFixture()
  const module = { exports: {} as { default: import('vue').Component } }
  new Function('require', 'module', 'exports', 'window', compiled)((name: string) => name === 'vue' ? vue : name === '@music-bridge/contracts' ? contracts : name.includes('reference-catalog-controller') ? controllerModule : require(name), module, module.exports, { musicBridge: f.api })
  interface Host { children: Host[]; parent: Host | null }
  const node = (): Host => ({ children: [], parent: null })
  const renderer = vue.createRenderer<Host, Host>({ createElement: node, createText: node, createComment: node, setText() {}, setElementText() {}, patchProp() {}, insert(child, parent) { child.parent = parent; parent.children.push(child) }, remove() {}, parentNode: n => n.parent, nextSibling: () => null })
  const app = renderer.createApp({ ...module.exports.default, render: () => null })
  const instance = app.mount(node()); t.after(() => app.unmount())
  await new Promise<void>(resolve => setImmediate(resolve))
  const setup = (instance.$ as unknown as { setupState: { state: ReturnType<typeof createReferenceCatalogController>['state']; controller: ReturnType<typeof createReferenceCatalogController>; fillSynthetic(): void; register(): Promise<void>; sourceConfirmed: boolean } }).setupState
  assert.equal(setup.state.rawPack, '')
  setup.fillSynthetic()
  assert.match(setup.state.rawPack, /合成/u)
  await setup.controller.previewSource(); await setup.register()
  assert.equal(f.calls.some(c => c.method === 'register'), false)
  setup.sourceConfirmed = true; await setup.register()
  assert.equal(f.calls.filter(c => c.method === 'register').length, 1)
  setup.controller.setStep('history')
  assert.equal(f.calls.filter(c => c.method === 'register').length, 1)
})

test('来源登记成功消耗原确认预览，返回来源页不能沿用勾选再次登记', async () => {
  const f = controllerFixture()
  f.controller.setRawPack(JSON.stringify(pack)); await f.controller.previewSource()
  await f.controller.registerSource(true)
  f.controller.setStep('source'); await f.controller.registerSource(true)
  assert.equal(f.calls.filter(call => call.method === 'register').length, 1)
  assert.equal(f.controller.state.sourcePreview, undefined)
  f.controller.dispose()
})
