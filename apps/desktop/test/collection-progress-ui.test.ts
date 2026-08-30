import assert from 'node:assert/strict'
import test from 'node:test'
import type { CollectionProgressPublicApi, ReferenceCatalogPublicApi, CanonicalReference } from '@music-bridge/contracts'

const revisionId = '11111111-1111-4111-8111-111111111111', sourceId = '22222222-2222-4222-8222-222222222222'
const wantId = '33333333-3333-4333-8333-333333333333', snapshotId = '44444444-4444-4444-8444-444444444444'
const oldRevisionId = '55555555-5555-4555-8555-555555555555', stamp = '2026-08-28T00:00:00.000Z', hash = 'a'.repeat(64)
const page = <T>(items: readonly T[], offset = 0) => ({ items, offset, limit: 25, total: items.length, hasMore: false })
const counts = { total: 1, owned: 1, missing: 0, unknown: 0, candidate: 0, needsReview: 0, wanted: 1, wantTargetCount: 1 }
const ref: CanonicalReference = { referenceId: 'synthetic-a', bookId: 'synthetic-book', brand: '合成品牌', series: '合成系列', model: '合成型号', edition: '测试版', lengths: [60, 90], iec: 'II', era: null, image: { kind: 'none' }, pages: ['1'], notes: '', confidence: 'unknown' }
const want = { id: wantId, version: 1, active: true, bookId: ref.bookId, revisionId, referenceId: ref.referenceId, brand: ref.brand, series: ref.series, model: ref.model, edition: ref.edition, priority: 'normal' as const, preferredCondition: '', notes: '', targetLengthMinutes: 90, packagingTarget: '', priceTarget: { currency: 'CNY', amount: '12.3400' }, createdAt: stamp, updatedAt: stamp }
const entry = { referenceId: ref.referenceId, brand: ref.brand, series: ref.series, model: ref.model, edition: ref.edition, state: 'owned' as const, matches: [], stockCount: 2, knownLengths: [60, 90], ownedLengths: [{ lengthMinutes: 60, quantity: 2 }], unknownLengthQty: 0, extraLengths: [], allKnownLengthsOwned: false, wantedTargets: [] }
const progress = { bookId: ref.bookId, revisionId, catalogSequence: 1, matchVersion: 0, metricsVersion: 1 as const, facts: 'current' as const, isCurrentRevision: true, fingerprint: hash, overall: counts, brands: [{ brand: ref.brand, counts }], series: [{ brand: ref.brand, series: ref.series, counts }], historicalWantedCount: 0, entries: page([entry]) }
const snapshot = { id: snapshotId, bookId: ref.bookId, revisionId, catalogSequence: 1, matchVersion: 0, metricsVersion: 1 as const, createdAt: stamp, fingerprint: hash, overall: counts, brands: progress.brands, series: progress.series, historicalWantedCount: 0 }
const source = { id: sourceId, bookId: ref.bookId, title: '合成参考书', sourceVersion: '1', packHash: hash, itemCount: 1, createdAt: stamp }
const revision = { id: revisionId, bookId: ref.bookId, sourceId, packHash: hash, sequence: 1, previousRevisionId: null, items: [ref], mappings: [], createdAt: stamp }

async function fixture() {
  const module = await import('../src/renderer/src/components/collection/collection-progress-controller.js').catch(() => ({}))
  assert.ok('createCollectionProgressController' in module, '缺少完成度与求购控制器')
  const create = (module as typeof import('../src/renderer/src/components/collection/collection-progress-controller.js')).createCollectionProgressController
  const calls: { name: string; request: unknown }[] = []
  let fail = false
  const api: CollectionProgressPublicApi & Pick<ReferenceCatalogPublicApi, 'listReferenceSources' | 'getCatalogHistory' | 'getCatalogRevision' | 'getCatalogSnapshot'> = {
    async listReferenceSources(request) { calls.push({ name: 'sources', request }); return { items: [source], total: 1, ...request } },
    async getCatalogHistory(request) { calls.push({ name: 'catalogHistory', request }); return { bookId: ref.bookId, currentRevisionId: revisionId, revisions: [{ ...revision, itemCount: 1 }], snapshots: [], total: 1, offset: request.offset, limit: request.limit } },
    async getCatalogRevision(request) { calls.push({ name: 'catalog', request }); return { revision: { ...revision, id: request.id }, matches: [], matchVersion: 0, currentCounts: counts, currentEntries: [], snapshot: { id: snapshotId, bookId: ref.bookId, revisionId: request.id, matchVersion: 0, createdAt: stamp, counts, entries: [] } } },
    async getCatalogSnapshot(request) { calls.push({ name: 'legacySnapshot', request }); return { id: request.id, bookId: ref.bookId, revisionId, matchVersion: 0, createdAt: stamp, counts: { total: 0, owned: 0, missing: 0, unknown: 0, candidate: 0, needsReview: 0 }, entries: [] } },
    async listWantEntries(request) { calls.push({ name: 'wants', request }); return page([{ entry: want, needsReview: false }], request.page.offset) },
    async saveWantEntry(request) { calls.push({ name: 'save', request: structuredClone(request) }); if (fail) throw new Error('OUTBOX_UNKNOWN /private/source'); return { ...want, ...request, id: request.id ?? wantId, version: request.expectedVersion + 1 } },
    async cancelWantEntry(request) { calls.push({ name: 'cancel', request: structuredClone(request) }); if (fail) throw new Error('OUTBOX_UNKNOWN'); return { ...want, active: false, version: request.expectedVersion + 1 } },
    async getWantEntryHistory(request) { calls.push({ name: 'wantHistory', request }); return page([want], request.page.offset) },
    async getCollectionProgress(request) { calls.push({ name: 'progress', request }); if (fail) throw new Error('CORE_UNAVAILABLE'); return { ...progress, revisionId: request.revisionId, isCurrentRevision: request.revisionId === revisionId, entries: page([entry], request.page.offset) } },
    async captureCollectionProgress(request) { calls.push({ name: 'capture', request: structuredClone(request) }); if (fail) throw new Error('OUTBOX_UNKNOWN'); return snapshot },
    async listCollectionProgressSnapshots(request) { calls.push({ name: 'snapshots', request }); return page([snapshot], request.page.offset) },
    async getCollectionProgressSnapshot(request) { calls.push({ name: 'snapshot', request }); return { snapshot, entries: page([entry], request.page.offset) } },
    async getCollectionModelLengths(request) { calls.push({ name: 'lengths', request }); return { modelId: request.modelId, modelRevision: 1, total: 2, lengths: [{ lengthMinutes: 60, quantity: 2 }], unknownLengthQty: 0 } },
  }
  const controller = create({ api })
  return { api, controller, calls, fail: (value: boolean) => { fail = value } }
}
async function selected(f: Awaited<ReturnType<typeof fixture>>) { await f.controller.selectBook(ref.bookId); await f.controller.selectRevision(revisionId) }

function variableSnapshots(f: Awaited<ReturnType<typeof fixture>>) {
  const rows = Array.from({ length: 6 }, (_, index) => ({ ...snapshot, id: `44444444-4444-4444-8444-${String(index + 1).padStart(12, '0')}` }))
  const requests: number[] = []; let fail = false
  f.api.listCollectionProgressSnapshots = async request => {
    const offset = request.page.offset; requests.push(offset)
    assert.equal(request.page.limit, 25)
    if (fail) throw new Error('合成快照列表读取失败')
    const limit = offset === 0 ? 2 : offset === 2 ? 3 : request.page.limit
    const items = rows.slice(offset, offset + limit)
    return { items, offset, limit, total: rows.length, hasMore: offset + items.length < rows.length }
  }
  return { rows, requests, fail: (value: boolean) => { fail = value } }
}

test('默认只读取目录来源与求购，不选书不采集快照，不自动重放命令', async () => {
  const f = await fixture(); await f.controller.start()
  assert.deepEqual(f.calls.map(call => call.name), ['sources', 'wants'])
  assert.equal(f.controller.state.revisionId, '')
  assert.equal(f.controller.state.progress, undefined)
  f.controller.dispose()
})

for (const failed of ['sources', 'wants'] as const) {
  test(`初始化${failed}单项失败仍接收另一成功资源，错误与重试彼此独立`, async () => {
    const f = await fixture(), sourcesRead = f.api.listReferenceSources, wantsRead = f.api.listWantEntries
    if (failed === 'sources') f.api.listReferenceSources = async () => { throw new Error('来源故障 /private/source') }
    else f.api.listWantEntries = async () => { throw new Error('清单故障 /private/wants') }
    await f.controller.start()
    if (failed === 'sources') { assert.equal(f.controller.state.wants?.items[0]?.entry.id, wantId); assert.ok(f.controller.state.sourcesError); assert.equal(f.controller.state.wantsError, '') }
    else { assert.equal(f.controller.state.sources?.items[0]?.id, sourceId); assert.ok(f.controller.state.wantsError); assert.equal(f.controller.state.sourcesError, '') }
    assert.doesNotMatch(f.controller.state.sourcesError + f.controller.state.wantsError, /private/u)
    const priorError = failed === 'sources' ? f.controller.state.sourcesError : f.controller.state.wantsError
    if (failed === 'sources') await f.controller.loadWants()
    else await f.controller.loadSources()
    assert.equal(failed === 'sources' ? f.controller.state.sourcesError : f.controller.state.wantsError, priorError)
    f.api.listReferenceSources = sourcesRead; f.api.listWantEntries = wantsRead
    if (failed === 'sources') await f.controller.loadSources()
    else await f.controller.loadWants()
    assert.equal(f.controller.state.sourcesError, ''); assert.equal(f.controller.state.wantsError, '')
    assert.equal(f.controller.state.sources?.items[0]?.id, sourceId); assert.equal(f.controller.state.wants?.items[0]?.entry.id, wantId)
    f.controller.dispose()
  })
}

test('慢来源不阻止查看已完成求购和独立重试，目录选择与写入保持互斥，卸载忽略迟到结果', async () => {
  const f = await fixture(); let finish!: (value: Awaited<ReturnType<typeof f.api.listReferenceSources>>) => void; let reads = 0
  f.api.listReferenceSources = async () => { reads++; return new Promise(resolve => { finish = resolve }) }
  const starting = f.controller.start(); await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(f.controller.state.wants?.items[0]?.entry.id, wantId)
  assert.equal(f.controller.state.sourcesLoading, true); assert.equal(f.controller.state.wantsLoading, false)
  f.controller.setSection('wants'); assert.equal(f.controller.state.section, 'wants')
  await f.controller.loadWants(); assert.equal(f.calls.filter(call => call.name === 'wants').length, 2)
  await f.controller.loadSources(); assert.equal(reads, 1, '同资源仍单飞')
  await f.controller.selectBook(ref.bookId); await f.controller.cancelWant(want, true)
  assert.equal(f.controller.state.bookId, ''); assert.equal(f.calls.some(call => call.name === 'cancel'), false)
  const beforeDispose = structuredClone(f.controller.state); f.controller.dispose()
  finish({ items: [source], total: 1, offset: 0, limit: 25 }); await starting
  assert.deepEqual(f.controller.state, beforeDispose)
})

test('慢求购不阻止来源结果到达，来源刷新不清求购错误，两个区域不会伪空', async () => {
  const f = await fixture(); let reject!: (error: Error) => void
  f.api.listWantEntries = async () => new Promise((_resolve, fail) => { reject = fail })
  const starting = f.controller.start(); await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(f.controller.state.sources?.items[0]?.id, sourceId)
  assert.equal(f.controller.state.sourcesLoading, false); assert.equal(f.controller.state.wantsLoading, true)
  reject(new Error('合成清单失败')); await starting
  const error = f.controller.state.wantsError; assert.ok(error)
  await f.controller.loadSources(); assert.equal(f.controller.state.wantsError, error)
  assert.equal(f.controller.state.wants, undefined)
  f.controller.dispose()
})

test('已拥有参考项仍可显式求购，精确金额原字符串与expectedVersion0不转换', async () => {
  const f = await fixture(); await selected(f)
  f.controller.newWant(ref.referenceId)
  f.controller.setDraft({ priority: 'high', amount: '12.3400', currency: 'CNY', targetLength: '90', notes: '另找未拆封版本' })
  await f.controller.saveWant(false); assert.equal(f.calls.some(call => call.name === 'save'), false)
  await f.controller.saveWant(true)
  const request = f.calls.find(call => call.name === 'save')!.request as Record<string, unknown>
  assert.deepEqual(request.priceTarget, { currency: 'CNY', amount: '12.3400' })
  assert.equal(request.id, null); assert.equal(request.expectedVersion, 0); assert.equal(request.targetLengthMinutes, 90)
  assert.equal(f.controller.state.progress, undefined, '求购后不能继续展示旧Wanted计数')
  f.controller.dispose()
})

test('保存失回执保留原请求，禁止改参数或自动重试', async () => {
  const f = await fixture(); await selected(f); f.controller.newWant(ref.referenceId)
  f.fail(true); await f.controller.saveWant(true)
  const original = f.calls.find(call => call.name === 'save')!.request
  assert.doesNotMatch(f.controller.state.error, /private|source/u)
  const reads = f.calls.length; await f.controller.loadSources(); await f.controller.loadWants()
  assert.equal(f.calls.length, reads, 'pending原命令存在时不能并行刷新覆盖上下文')
  f.controller.setDraft({ amount: '999' }); await f.controller.selectRevision(oldRevisionId); await f.controller.saveWant(true)
  assert.equal(f.calls.filter(call => call.name === 'save').length, 1)
  f.fail(false); await f.controller.retry(true)
  assert.deepEqual(f.calls.filter(call => call.name === 'save').map(call => call.request), [original, original])
  f.controller.dispose()
})

test('旧目标编辑必须重新选当前目录引用，取消终态不能复活，版本保留', async () => {
  const f = await fixture(); await selected(f)
  f.controller.editWant({ entry: { ...want, revisionId: oldRevisionId, version: 4 }, needsReview: true })
  await f.controller.saveWant(true); assert.equal(f.calls.some(call => call.name === 'save'), false)
  f.controller.setDraft({ referenceId: ref.referenceId }); await f.controller.saveWant(true)
  const request = f.calls.find(call => call.name === 'save')!.request as Record<string, unknown>
  assert.equal(request.id, wantId); assert.equal(request.expectedVersion, 4); assert.equal(request.revisionId, revisionId)
  f.controller.editWant({ entry: { ...want, active: false }, needsReview: false })
  await f.controller.saveWant(true); assert.equal(f.calls.filter(call => call.name === 'save').length, 1)
  await f.controller.cancelWant(want, false); assert.equal(f.calls.some(call => call.name === 'cancel'), false)
  await f.controller.cancelWant(want, true); assert.equal(f.controller.state.savedWant?.active, false)
  f.controller.dispose()
})

test('旧revision当前事实只读，只有当前head原全批fingerprint可明确采集', async () => {
  const f = await fixture(); await selected(f); await f.controller.selectRevision(oldRevisionId)
  assert.equal(f.controller.state.progress?.facts, 'current'); assert.equal(f.controller.state.progress?.isCurrentRevision, false)
  await f.controller.capture(true); assert.equal(f.calls.some(call => call.name === 'capture'), false)
  await f.controller.selectRevision(revisionId); await f.controller.loadProgress(25)
  await f.controller.capture(false); assert.equal(f.calls.some(call => call.name === 'capture'), false)
  await f.controller.capture(true)
  assert.equal((f.calls.find(call => call.name === 'capture')!.request as Record<string, unknown>).expectedFingerprint, hash)
  f.controller.dispose()
})

test('历史快照独立分页读取，旧snapshot没有Wanted或长度值，不用当前事实回填', async () => {
  const f = await fixture(); await selected(f)
  await f.controller.loadSnapshots(25); await f.controller.loadSnapshot(snapshotId, 25)
  const original = structuredClone(f.controller.state.snapshot)
  await f.controller.loadProgress()
  assert.deepEqual(f.controller.state.snapshot, original)
  await f.controller.loadLegacySnapshot(snapshotId)
  assert.equal('wanted' in f.controller.state.legacySnapshot!.counts, false)
  for (const call of f.calls) {
    const request = call.request as { page?: { limit: number } }
    if (request.page) assert.equal(request.page.limit, 25)
  }
  f.controller.dispose()
})

test('刷新失败保留上次事实但失效提交能力，切换书籍清旧上下文不伪造零完成度', async () => {
  const f = await fixture(); await selected(f)
  f.fail(true); await f.controller.loadProgress()
  assert.equal(f.controller.state.progress?.overall.owned, 1); assert.ok(f.controller.state.error)
  await f.controller.capture(true); assert.equal(f.calls.some(call => call.name === 'capture'), false)
  f.fail(false); await f.controller.selectBook('another-book')
  assert.equal(f.controller.state.progress, undefined); assert.equal(f.controller.state.revisionId, '')
  f.controller.dispose()
})

test('读取单飞且卸载忽略迟到结果，重新打开不重放求购或采集', async () => {
  const f = await fixture(); let finish!: (value: typeof progress) => void; let reads = 0
  f.api.getCollectionProgress = async () => { reads++; return new Promise(resolve => { finish = resolve }) }
  const reading = f.controller.selectRevision(revisionId)
  await f.controller.selectRevision(oldRevisionId); assert.equal(reads, 1)
  f.controller.dispose(); finish(progress); await reading
  assert.equal(f.controller.state.progress, undefined)
  const reopened = await fixture(); await reopened.controller.start()
  assert.equal(reopened.calls.some(call => ['save', 'cancel', 'capture'].includes(call.name)), false)
  reopened.controller.dispose()
})

test('取消和采集失回执保持原版本及原全批指纹，明确重试不换commandId', async () => {
  for (const operation of ['cancel', 'capture'] as const) {
    const f = await fixture(); await selected(f); f.fail(true)
    if (operation === 'cancel') await f.controller.cancelWant(want, true)
    else await f.controller.capture(true)
    const original = f.calls.find(call => call.name === operation)!.request
    await f.controller.retry(false); assert.equal(f.calls.filter(call => call.name === operation).length, 1)
    f.fail(false); await f.controller.retry(true)
    assert.deepEqual(f.calls.filter(call => call.name === operation).map(call => call.request), [original, original])
    f.controller.dispose()
  }
})

test('目录历史刷新发现head变化时使旧当前声明失效，不能用旧指纹继续提交', async () => {
  const f = await fixture(); await selected(f)
  const read = f.api.getCatalogHistory
  f.api.getCatalogHistory = async request => ({ ...await read(request), currentRevisionId: oldRevisionId })
  await f.controller.loadCatalogHistory()
  assert.equal(f.controller.state.progressFresh, false)
  await f.controller.capture(true); assert.equal(f.calls.some(call => call.name === 'capture'), false)
  f.controller.dispose()
})

async function mounted(t: test.TestContext, name: string, api: unknown, props: Record<string, unknown> = {}) {
  const { readFile } = await import('node:fs/promises'), { createRequire } = await import('node:module')
  const { parse, compileScript, compileTemplate } = await import('@vue/compiler-sfc'), ts = (await import('typescript')).default
  const require = createRequire(import.meta.url), vue = require('vue') as typeof import('vue')
  const { descriptor, errors } = parse(await readFile(new URL(`../src/renderer/src/components/collection/${name}.vue`, import.meta.url), 'utf8')); assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: 'progress-ui-test' }), template = compileTemplate({ id: 'progress-ui-test', filename: name + '.vue', source: descriptor.template!.content, compilerOptions: { bindingMetadata: script.bindings } }); assert.deepEqual(template.errors, [])
  const controller = await import('../src/renderer/src/components/collection/collection-progress-controller.js'), display = await import('../src/renderer/src/components/collection/collection-display.js')
  const module = { exports: {} as { default: import('vue').Component } }, rendered = { exports: {} as { render: (...args: unknown[]) => unknown } }
  const load = (name: string) => name === 'vue' ? vue : name.includes('collection-progress-controller') ? controller : name.includes('collection-display') ? display : name.endsWith('.vue') ? { default: { render: () => null } } : require(name)
  const compile = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  new Function('require', 'module', 'exports', 'window', compile(script.content))(load, module, module.exports, { musicBridge: api })
  new Function('require', 'module', 'exports', compile(template.code))(load, rendered, rendered.exports)
  interface Host { children: Host[]; parent: Host | null }
  const node = (): Host => ({ children: [], parent: null })
  const renderer = vue.createRenderer<Host, Host>({ createElement: node, createText: node, createComment: node, setText() {}, setElementText() {}, patchProp() {}, insert(child, parent) { child.parent = parent; parent.children.push(child) }, remove() {}, parentNode: n => n.parent, nextSibling: () => null })
  const app = renderer.createApp({ ...module.exports.default, render: () => null }, props), instance = app.mount(node()); t.after(() => app.unmount())
  await new Promise<void>(resolve => setImmediate(resolve))
  const setup = (instance.$ as unknown as { setupState: Record<string, unknown> }).setupState
  const text = (value: unknown): string => typeof value === 'string' ? value : Array.isArray(value) ? value.map(text).join(' ') : value && typeof value === 'object' && 'children' in value ? text(value.children) : ''
  function renderText(): string {
    let content = ''
    const rendering = renderer.createApp({ render() { content = text(rendered.exports.render(instance, [], props, setup, {}, {})); return null } })
    rendering.mount(node()); rendering.unmount(); return content
  }
  async function clickButton(label: string): Promise<void> {
    let action: (() => unknown) | undefined
    function find(value: unknown): void {
      if (Array.isArray(value)) { value.forEach(find); return }
      if (!value || typeof value !== 'object') return
      const vnode = value as { type?: unknown; props?: { onClick?: () => unknown }; children?: unknown }
      if (vnode.type === 'button' && text(vnode.children) === label) action = vnode.props?.onClick
      else find(vnode.children)
    }
    const rendering = renderer.createApp({ render() { find(rendered.exports.render(instance, [], props, setup, {}, {})); return null } })
    rendering.mount(node()); rendering.unmount(); assert.ok(action, `缺少可执行按钮：${label}`); await action(); await vue.nextTick()
  }
  return { setup, tick: vue.nextTick, renderText, clickButton }
}

test('实际快照列表按返回2→3→1页长前进，后退使用访问偏移而非当前页长，无遗漏重复', async t => {
  const f = await fixture(), pages = variableSnapshots(f), { setup, clickButton } = await mounted(t, 'CollectionProgressPanel', f.api)
  const controller = setup.controller as Awaited<ReturnType<typeof fixture>>['controller']; controller.setSection('history')
  await controller.loadSnapshots()
  const ids = controller.state.snapshots!.items.map(item => item.id)
  await clickButton('下一页快照'); assert.equal(controller.state.snapshots?.offset, 2)
  ids.push(...controller.state.snapshots!.items.map(item => item.id))
  await clickButton('下一页快照'); assert.equal(controller.state.snapshots?.offset, 5)
  assert.equal(controller.state.snapshots?.limit, 25, '自然末页仍保留请求上限，必须能返回上一页')
  ids.push(...controller.state.snapshots!.items.map(item => item.id))
  assert.deepEqual(ids, pages.rows.map(item => item.id)); assert.equal(new Set(ids).size, 6)
  await clickButton('上一页快照'); assert.equal(controller.state.snapshots?.offset, 2)
  await clickButton('上一页快照'); assert.equal(controller.state.snapshots?.offset, 0)
  assert.deepEqual(pages.requests, [0, 2, 5, 2, 0])
})

test('快照翻页或刷新失败保持旧页和回退栈，成功刷新/换book/采集才重置', async () => {
  const f = await fixture(), pages = variableSnapshots(f); await selected(f)
  await f.controller.loadSnapshots(); await f.controller.nextSnapshots()
  assert.equal(f.controller.state.snapshotPreviousOffset, 0)
  const prior = structuredClone(f.controller.state.snapshots); pages.fail(true)
  await f.controller.nextSnapshots(); assert.deepEqual(f.controller.state.snapshots, prior); assert.equal(f.controller.state.snapshotPreviousOffset, 0)
  await f.controller.previousSnapshots(); assert.deepEqual(f.controller.state.snapshots, prior); assert.equal(f.controller.state.snapshotPreviousOffset, 0)
  await f.controller.loadSnapshots(); assert.deepEqual(f.controller.state.snapshots, prior); assert.equal(f.controller.state.snapshotPreviousOffset, 0)
  pages.fail(false); await f.controller.nextSnapshots(); assert.equal(f.controller.state.snapshots?.offset, 5); assert.equal(f.controller.state.snapshotPreviousOffset, 2)
  await f.controller.loadSnapshots(); assert.equal(f.controller.state.snapshots?.offset, 0); assert.equal(f.controller.state.snapshotPreviousOffset, undefined)
  await f.controller.nextSnapshots(); await f.controller.selectBook(ref.bookId)
  assert.equal(f.controller.state.snapshots, undefined); assert.equal(f.controller.state.snapshotPreviousOffset, undefined)
  await f.controller.selectRevision(revisionId); await f.controller.loadSnapshots(); await f.controller.nextSnapshots()
  const beforeCapture = structuredClone(f.controller.state.snapshots); f.fail(true); await f.controller.capture(true)
  assert.deepEqual(f.controller.state.snapshots, beforeCapture); assert.equal(f.controller.state.snapshotPreviousOffset, 0)
  f.fail(false); await f.controller.retry(true)
  assert.equal(f.controller.state.snapshots, undefined); assert.equal(f.controller.state.snapshotPreviousOffset, undefined)
  const count = pages.requests.length; await f.controller.previousSnapshots(); assert.equal(pages.requests.length, count)
  f.controller.dispose()
})

test('实际模板就近显示资源错误与重试，另一成功清单仍能查看，不伪造空状态', async t => {
  const f = await fixture(); f.api.listReferenceSources = async () => { throw new Error('合成来源失败') }
  const { setup, tick, renderText } = await mounted(t, 'CollectionProgressPanel', f.api)
  const controller = setup.controller as Awaited<ReturnType<typeof fixture>>['controller']
  controller.setSection('wants'); await tick()
  const visible = renderText()
  assert.match(visible, /参考来源读取失败.*重试参考来源/u)
  assert.match(visible, /合成品牌 合成型号.*价格目标 CNY 12.3400/u)
  assert.doesNotMatch(visible, /求购清单尚未刷新|还没有求购目标|尚无参考书籍/u)
  f.api.listWantEntries = async () => { throw new Error('合成求购失败') }; await controller.loadWants(); await tick()
  assert.match(renderText(), /求购清单读取失败.*重试求购清单/u)
  assert.match(renderText(), /参考来源读取失败/u)
  assert.doesNotMatch(renderText(), /还没有求购目标/u)
})

test('实际面板慢来源时能浏览求购并关闭，单独loading不冻结整页', async t => {
  const f = await fixture(); let finish!: (value: Awaited<ReturnType<typeof f.api.listReferenceSources>>) => void; let closes = 0
  f.api.listReferenceSources = async () => new Promise(resolve => { finish = resolve })
  const { setup, tick, renderText } = await mounted(t, 'CollectionProgressPanel', f.api, { onClose: () => { closes++ } })
  const controller = setup.controller as Awaited<ReturnType<typeof fixture>>['controller']
  controller.setSection('wants'); await tick()
  assert.match(renderText(), /正在读取参考来源/u)
  assert.match(renderText(), /合成品牌 合成型号/u)
  assert.equal(setup.navigationBlocked, false); assert.equal(setup.blocked, true)
  ;(setup.requestClose as () => void)(); assert.equal(closes, 1)
  controller.dispose(); finish({ items: [source], total: 1, offset: 0, limit: 25 })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(controller.state.sources, undefined)
})

test('实际面板模板区分旧目录当前事实与旧快照，Wanted和长度维度不伪造零', async t => {
  const f = await fixture(), { setup, tick, renderText } = await mounted(t, 'CollectionProgressPanel', f.api)
  const controller = setup.controller as Awaited<ReturnType<typeof fixture>>['controller']
  await controller.selectBook(ref.bookId); await controller.selectRevision(oldRevisionId); await tick()
  assert.match(renderText(), /旧目录的当前事实，不是历史快照/u)
  await controller.loadLegacySnapshot(snapshotId); await tick()
  assert.match(renderText(), /Wanted.*长度.*未采集/u)
  assert.match(renderText(), /旧口径/u)
})

test('实际型号详情读取真实持有长度，加载与错误不把旧SKU90当覆盖或伪造零', async t => {
  let finish!: (value: Awaited<ReturnType<CollectionProgressPublicApi['getCollectionModelLengths']>>) => void
  const api = { getCollectionModelLengths: async () => new Promise<Awaited<ReturnType<CollectionProgressPublicApi['getCollectionModelLengths']>>>(resolve => { finish = resolve }) }
  const model = { id: sourceId, brand: '合成品牌', name: '合成型号', edition: '', year: null, format: 'cassette', tapeType: 'unknown', identification: 'unidentified', collectorPolicy: 'normal', minimumSealedReserve: 0, revision: 1, lengths: [60, 90], counts: { total: 2, sealedBlank: 0, openedBlank: 0, legacyUsed: 0, recorded: 0, reserved: 0, unknown: 2, unavailable: 0 } }
  const empty = page([]), { setup, tick, renderText } = await mounted(t, 'CollectionModelDetail', api, { detail: { model, lots: empty, copies: empty }, busy: false })
  assert.match(renderText(), /正在读取当前持有长度/u)
  finish({ modelId: sourceId, modelRevision: 1, total: 2, lengths: [{ lengthMinutes: 60, quantity: 2 }], unknownLengthQty: 0 }); await new Promise<void>(resolve => setImmediate(resolve)); await tick()
  assert.match(renderText(), /60 分钟.*2 盘/u)
  assert.doesNotMatch(renderText(), /90 分钟.*持有/u)
  api.getCollectionModelLengths = async () => { throw new Error('CORE_UNAVAILABLE /private/source') }
  await (setup.loadLengths as () => Promise<void>)(); await tick()
  assert.match(renderText(), /当前持有长度读取失败/u)
  assert.doesNotMatch(renderText(), /private|当前持有总量 0/u)
})
