import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import type { CanonicalReference, CatalogRevisionDetail, ReferenceCatalogPublicApi, ReferenceSourceVersion } from '@music-bridge/contracts'
import type { CassetteArchivePreview, CassetteCatalogApi, CassetteReferenceDetail } from '../src/shared/cassette-catalog.js'
import { createCassetteArchiveImportController } from '../src/renderer/src/components/collection/cassette-catalog-controller.js'
import { collectionPrefillForReference, filterCassetteCatalog, groupCassetteCatalog, loadPublishedCassetteCatalog, MAX_PUBLISHED_CASSETTE_SOURCES, referenceImageCaption, referenceImageUrl, referenceImagesForModel, type CassetteCatalogModelGroup, type PublishedCassetteReference } from '../src/renderer/src/components/collection/reference-images.js'
import * as referenceImages from '../src/renderer/src/components/collection/reference-images.js'
import * as referenceController from '../src/renderer/src/components/collection/reference-catalog-controller.js'
import * as cassetteShared from '../src/shared/cassette-catalog.js'

const sourceId = '11111111-1111-4111-8111-111111111111'
const revisionId = '22222222-2222-4222-8222-222222222222'
const datasetId = '33333333-3333-4333-8333-333333333333'
const sha256 = 'a'.repeat(64)
const source: ReferenceSourceVersion = { id: sourceId, bookId: 'tape-book', title: '磁带原书', sourceVersion: 'r3', packHash: 'b'.repeat(64), itemCount: 1, createdAt: '2026-10-10T00:00:00.000Z' }
const reference = (index = 0, brand = 'TDK'): CanonicalReference => ({ referenceId: `tape-${index}`, bookId: source.bookId,
  brand, model: `SA-X ${index}`, series: 'SA-X', edition: '原书1988版', era: '1988', iec: 'II', lengths: [60, 90],
  image: { kind: 'none' }, pages: [`${brand} p.${index}`], notes: '原书说明保留未知生产年份', confidence: 'unknown' })
function revision(items: readonly CanonicalReference[] = [reference()]): CatalogRevisionDetail {
  const counts = { total: items.length, owned: 0, missing: 0, unknown: items.length, candidate: 0, needsReview: 0 }
  const entries = items.map(item => ({ referenceId: item.referenceId, state: 'unknown' as const, matches: [], stockCount: 0 }))
  return { revision: { id: revisionId, bookId: source.bookId, sourceId, packHash: source.packHash, sequence: 1, previousRevisionId: null,
    items, mappings: [], createdAt: source.createdAt }, matches: [], matchVersion: 0, currentCounts: counts, currentEntries: entries,
    snapshot: { id: datasetId, bookId: source.bookId, revisionId, matchVersion: 0, createdAt: source.createdAt, counts, entries } }
}
function catalogFixture(items: readonly CanonicalReference[] = [reference()]) {
  const calls: string[] = [], current = revision(items)
  const api = {
    listReferenceSources: async () => { calls.push('sources'); return { items: [{ ...source, itemCount: items.length }, { ...source, id: datasetId }], total: 2, offset: 0, limit: 25 } },
    getCatalogHistory: async () => { calls.push('history'); return { bookId: source.bookId, currentRevisionId: revisionId, revisions: [], snapshots: [], total: 1, offset: 0, limit: 1 } },
    getCatalogRevision: async () => { calls.push('revision'); return current },
    getReferenceSource: async () => { calls.push('source'); return { source, rawPack: JSON.stringify({ schemaVersion: 1, bookId: source.bookId, title: source.title, sourceVersion: source.sourceVersion, items }) } },
    listReferenceSourceZipReceipts: async () => ({ items: [], total: 0, offset: 0, limit: 25 }),
    listCollection: async () => ({ items: [], total: 0, offset: 0, limit: 100, hasMore: false }),
  } as unknown as ReferenceCatalogPublicApi & { listCollection(): Promise<unknown> }
  return { api, calls, current }
}
const preview: CassetteArchivePreview = {
  datasetId, summary: { sha256, zipBytes: 12345, bookId: source.bookId, title: source.title, sourceVersion: 'r3',
    itemCount: 634, assetCount: 650, primaryCount: 618, missingPrimaryCount: 16, realPhotoCount: 2, opaqueDisplayCount: 3 },
  expectedCurrentRevisionId: null, baselineFingerprint: 'c'.repeat(64),
  delta: { addedReferenceIds: ['tape-0'], removedReferenceIds: [], retainedReferenceIds: [], merged: 0, split: 0, before: null, after: revision().currentCounts },
}

test('合成634条完整目录包含16条缺主图，同书多来源只读一次当前版次，不创建库存', async () => {
  const rows = Array.from({ length: 634 }, (_, index) => ({ ...reference(index), archive: { sha256, primaryAssetId: index < 16 ? null : `image-${index}` } }))
  const before = structuredClone(rows), f = catalogFixture(rows)
  const items = await loadPublishedCassetteCatalog(f.api)
  assert.equal(items.length, 634)
  assert.equal(items.filter(item => referenceImageUrl(item.reference) === null).length, 16)
  assert.equal(items.every(item => item.current?.state === 'unknown'), true)
  assert.equal(groupCassetteCatalog(items).reduce((total, group) => total + group.referenceCount, 0), 634)
  assert.equal(groupCassetteCatalog(items).flatMap(group => group.models.flatMap(model => model.items)).length, 634)
  assert.deepEqual(f.calls, ['sources', 'history', 'revision'])
  assert.deepEqual(rows, before)
})

test('品牌→型号→原书年份仅做UI分组，同型号各年份与未知保留，IEC和系列差异可辨', async () => {
  const rows = [
    { ...reference(1), model: 'SA-X', edition: '1988', era: '1988' },
    { ...reference(2), model: 'SA-X', edition: '1990', era: '1990' },
    { ...reference(3), model: 'SA-X', edition: '', era: null },
    { ...reference(4), model: 'SA-X', iec: 'IV' as const },
    { ...reference(5), model: 'SA-X', series: '另一系列' },
    { ...reference(6, 'SONY'), model: 'SA-X' },
  ]
  const before = structuredClone(rows), items = await loadPublishedCassetteCatalog(catalogFixture(rows).api)
  const groups = groupCassetteCatalog(items), tdk = groups.find(group => group.brand === 'TDK')!
  assert.equal(groups.length, 2)
  assert.equal(tdk.referenceCount, 5)
  assert.equal(tdk.models.length, 3)
  const sameModel = tdk.models.find(group => group.model === 'SA-X' && group.series === 'SA-X' && group.iec === 'II')!
  assert.deepEqual(sameModel.items.map(item => item.reference.referenceId), ['tape-1', 'tape-2', 'tape-3'])
  assert.equal(sameModel.items[2]?.reference.era, null)
  assert.equal(new Set(groups.flatMap(group => group.models.flatMap(model => model.items.map(item => item.reference.referenceId)))).size, 6)
  assert.deepEqual(rows, before)
})

test('完整目录搜索型号、原书页与说明，品牌和带型筛选不混入库存事实', async () => {
  const rows = [reference(1), { ...reference(2, 'SONY'), iec: 'IV' as const }]
  const items = await loadPublishedCassetteCatalog(catalogFixture(rows).api)
  assert.deepEqual(filterCassetteCatalog(items, { query: 'tdk SA-X 1', brand: '', iec: '' }).map(item => item.reference.referenceId), ['tape-1'])
  assert.equal(filterCassetteCatalog(items, { query: '生产年份', brand: '', iec: '' }).length, 2)
  assert.equal(filterCassetteCatalog(items, { query: 'p.2', brand: 'SONY', iec: 'IV' }).length, 1)
  assert.equal(filterCassetteCatalog(items, { query: '', brand: 'SONY', iec: 'II' }).length, 0)
})

test('读取身份已变化的目录不返回旧来源，当前发布来源不在首页时精确读取', async () => {
  const f = catalogFixture()
  f.api.listReferenceSources = async () => ({ items: [{ ...source, id: datasetId }], total: 1, offset: 0, limit: 25 })
  const items = await loadPublishedCassetteCatalog(f.api)
  assert.equal(items[0]?.source.id, sourceId)
  assert.ok(f.calls.includes('source'))
  f.current.revision.id = datasetId
  await assert.rejects(loadPublishedCassetteCatalog(f.api), /版次身份/u)
})

test('26个同书历史来源按25条分页完整收集，同书当前版次只读一次', async () => {
  const f = catalogFixture(), sources = Array.from({ length: 26 }, (_, index) => ({ ...source, id: index === 0 ? sourceId : `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` }))
  f.api.listReferenceSources = async ({ offset, limit }) => { f.calls.push(`sources:${offset}`); return { items: sources.slice(offset, offset + limit), total: sources.length, offset, limit } }
  const items = await loadPublishedCassetteCatalog(f.api)
  assert.equal(items.length, 1)
  assert.equal(items[0]?.source.id, sourceId)
  assert.deepEqual(f.calls, ['sources:0', 'sources:25', 'history', 'revision'])
})

test('第二页的新书也读取当前条目，不把第一页结果静默当完整目录', async () => {
  const f = catalogFixture(), otherSource = { ...source, id: datasetId, bookId: 'other-book', title: '另一本原书' }
  const otherReference = { ...reference(2), bookId: otherSource.bookId }, other = revision([otherReference])
  other.revision = { ...other.revision, id: datasetId, sourceId: otherSource.id, bookId: otherSource.bookId }
  const sources = [...Array.from({ length: 25 }, (_, index) => ({ ...source, id: index === 0 ? sourceId : `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` })), otherSource]
  const reads: string[] = []
  f.api.listReferenceSources = async ({ offset, limit }) => ({ items: sources.slice(offset, offset + limit), total: sources.length, offset, limit })
  f.api.getCatalogHistory = async ({ bookId }) => { reads.push(bookId); return { bookId, currentRevisionId: bookId === otherSource.bookId ? datasetId : revisionId, revisions: [], snapshots: [], total: 1, offset: 0, limit: 1 } }
  f.api.getCatalogRevision = async ({ id }) => id === datasetId ? other : f.current
  const items = await loadPublishedCassetteCatalog(f.api)
  assert.deepEqual(new Set(items.map(item => item.reference.referenceId)), new Set(['tape-0', 'tape-2']))
  assert.deepEqual(reads, [source.bookId, otherSource.bookId])
})

test('来源超过总预算、后页缺条目或总数漂移时明确失败，不返回截断目录', async () => {
  const f = catalogFixture()
  f.api.listReferenceSources = async () => ({ items: [], total: MAX_PUBLISHED_CASSETTE_SOURCES + 1, offset: 0, limit: 25 })
  await assert.rejects(loadPublishedCassetteCatalog(f.api), /超过读取总预算/u)
  const sources = Array.from({ length: 25 }, (_, index) => ({ ...source, id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` }))
  f.api.listReferenceSources = async ({ offset, limit }) => ({ items: offset === 0 ? sources : [], total: 26, offset, limit })
  await assert.rejects(loadPublishedCassetteCatalog(f.api), /分页不完整/u)
  f.api.listReferenceSources = async ({ offset, limit }) => ({ items: offset === 0 ? sources : [source], total: offset === 0 ? 26 : 27, offset, limit })
  await assert.rejects(loadPublishedCassetteCatalog(f.api), /总数已变化/u)
  assert.equal(f.calls.includes('history'), false)
})

test('归档原书图可作为同型号候选，缺主图与非法资产不补位，旧内嵌图继续可用', () => {
  const archived = { ...reference(), archive: { sha256, primaryAssetId: 'primary:01' } }
  const descriptor = { brand: 'TDK', name: archived.model, edition: '', year: null, format: 'cassette' as const, tapeType: 'II' as const, identification: 'partial' as const }
  assert.equal(referenceImagesForModel(descriptor, [archived]).length, 1)
  assert.equal(referenceImageUrl(archived), `musicbridge://app/reference-assets/${sha256}/primary%3A01`)
  assert.equal(referenceImageCaption(archived), '原书资料参考图')
  assert.equal(referenceImageUrl({ ...archived, archive: { sha256, primaryAssetId: '../private' } }), null)
  assert.equal(referenceImageUrl({ ...archived, archive: { sha256, primaryAssetId: null } }), null)
  const old = { ...reference(), image: { kind: 'reference' as const, image: { dataUrl: 'data:image/jpeg;base64,/9j/2Q==', width: 1, height: 1 }, caption: '旧书籍参考图' } }
  assert.equal(referenceImageUrl(old), old.image.image.dataUrl)
  assert.equal(referenceImageCaption(old), '旧书籍参考图')
})

test('完整ZIP选择只预览，确认后绑定原预览和dataset，未知回执仅恢复同一命令', async () => {
  const requests: unknown[] = []
  const api: CassetteCatalogApi = { pickCassetteArchive: async () => preview, importCassetteArchive: async request => { requests.push(request); if (requests.length === 1) throw new Error('OUTBOX_UNKNOWN'); return revision() }, getCassetteReferenceDetail: async () => { throw new Error('NOT_USED') } }
  let imported = 0
  const controller = createCassetteArchiveImportController({ api, onImported: () => imported++ })
  await controller.importArchive(true); await controller.pickArchive(); await controller.importArchive(false)
  assert.equal(requests.length, 0)
  await controller.importArchive(true)
  const original = controller.state.pendingRequest
  assert.ok(original)
  assert.equal(original.expectedDatasetId, datasetId)
  assert.equal(original.archiveSha256, sha256)
  assert.equal(original.baselineFingerprint, preview.baselineFingerprint)
  assert.equal(Object.isFrozen(original), true)
  await controller.pickArchive(); await controller.importArchive(true)
  assert.equal(requests.length, 1)
  await controller.retry()
  assert.equal(requests[0], requests[1])
  assert.equal(imported, 1)
  assert.equal(controller.state.pendingRequest, undefined)
  assert.equal(controller.state.preview, undefined)
  assert.match(controller.state.notice, /未创建磁带库存/u)
})

test('导入单飞，关闭后迟到回执不更新局部状态或触发目录导航', async () => {
  let resolve!: (value: CatalogRevisionDetail) => void, writes = 0, imported = 0
  const api: CassetteCatalogApi = { pickCassetteArchive: async () => preview, importCassetteArchive: async () => { writes++; return new Promise<CatalogRevisionDetail>(done => { resolve = done }) }, getCassetteReferenceDetail: async () => { throw new Error('NOT_USED') } }
  const controller = createCassetteArchiveImportController({ api, onImported: () => imported++ })
  await controller.pickArchive()
  const pending = controller.importArchive(true)
  await controller.importArchive(true); await controller.retry()
  assert.equal(writes, 1)
  controller.dispose(); resolve(revision()); await pending
  assert.equal(controller.state.result, undefined)
  assert.equal(imported, 0)
})

test('取消重新选择保留原预览；选择失败不暴露Main文件路径', async () => {
  let picks = 0
  const api: CassetteCatalogApi = { pickCassetteArchive: async () => { picks++; if (picks === 1) return preview; if (picks === 2) return null; throw new Error('/Users/private/file.zip') }, importCassetteArchive: async () => { throw new Error('NOT_USED') }, getCassetteReferenceDetail: async () => { throw new Error('NOT_USED') } }
  const controller = createCassetteArchiveImportController({ api })
  await controller.pickArchive(); const selected = controller.state.preview
  await controller.pickArchive(); assert.equal(controller.state.preview, selected)
  await controller.pickArchive(); assert.equal(controller.state.preview, selected)
  assert.doesNotMatch(controller.state.error, /Users|private/u)
})

async function mountScript(t: test.TestContext, file: string, props: Record<string, unknown>, api: unknown, renderTemplate = false) {
  const { parse, compileScript, compileTemplate } = await import('@vue/compiler-sfc')
  const ts = (await import('typescript')).default
  const require = createRequire(import.meta.url), vue = require('vue') as typeof import('vue')
  const sourceText = await readFile(new URL(`../src/renderer/src/components/collection/${file}`, import.meta.url), 'utf8')
  const { descriptor, errors } = parse(sourceText); assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: 'cassette-ui-behavior' })
  const template = compileTemplate({ id: 'cassette-ui-behavior', source: descriptor.template!.content, filename: file, compilerOptions: { bindingMetadata: script.bindings, hoistStatic: false } })
  assert.deepEqual(template.errors, [])
  const contracts = await import('@music-bridge/contracts')
  const modules: Record<string, unknown> = { vue, '@music-bridge/contracts': contracts, './reference-images': referenceImages,
    './reference-catalog-controller': referenceController, './collection-display': { collectionModelLabel: () => '' },
    './cassette-catalog-controller': { createCassetteArchiveImportController },
    '../../../../shared/cassette-catalog': cassetteShared }
  const module = { exports: {} as { default: import('vue').Component } }
  const code = ts.transpileModule(script.content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  new Function('require', 'module', 'exports', 'window', 'document', code)((name: string) => modules[name] ?? (name.endsWith('.vue') ? { default: { render: () => null } } : require(name)), module, module.exports, { musicBridge: api }, { activeElement: { isConnected: true, focus() {} } })
  interface Host { tag: string; text: string; children: Host[]; parent: Host | null; props: Record<string, unknown>; showModal(): void; focus(): void; scrollIntoView(): void }
  const node = (tag = '', text = ''): Host => ({ tag, text, children: [], parent: null, props: {}, showModal() {}, focus() {}, scrollIntoView() {} })
  const renderer = vue.createRenderer<Host, Host>({ createElement: tag => node(tag), createText: text => node('', text), createComment: () => node(), setText(item, text) { item.text = text }, setElementText(item, text) { item.text = text; item.children = [] }, patchProp(item, key, _before, value) { item.props[key] = value }, insert(child, parent, anchor) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; if (index < 0) parent.children.push(child); else parent.children.splice(index, 0, child) }, remove(child) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = null }, parentNode: item => item.parent, nextSibling: item => item.parent?.children[item.parent.children.indexOf(item) + 1] ?? null })
  let render: import('vue').RenderFunction = () => null
  if (renderTemplate) {
    const compiledTemplate = ts.transpileModule(template.code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    const templateModule = { exports: {} as { render: import('vue').RenderFunction } }
    new Function('require', 'module', 'exports', compiledTemplate)((name: string) => modules[name] ?? require(name), templateModule, templateModule.exports)
    render = templateModule.exports.render
  }
  const app = renderer.createApp({ ...module.exports.default, render }, props)
  const root = node('root'), instance = app.mount(root); t.after(() => app.unmount())
  const settle = async () => { await new Promise<void>(done => setImmediate(done)); await vue.nextTick() }
  const text = (item: Host): string => item.text + item.children.map(text).join('')
  const all = (item: Host): Host[] => [item, ...item.children.flatMap(all)]
  return { instance: instance.$ as unknown as { props: Record<string, unknown>; setupState: Record<string, unknown> }, settle, text: () => text(root), elements: (tag: string) => all(root).filter(item => item.tag === tag) }
}

test('实际关联审核面板接收资料条目后只读定位当前来源与review步骤，不触发库存写入', async t => {
  const f = catalogFixture()
  const mounted = await mountScript(t, 'ReferenceCatalogPanel.vue', { initialSelection: { sourceId, referenceId: 'tape-0', step: 'review' } }, f.api)
  await mounted.settle()
  const state = mounted.instance.setupState.state as ReturnType<typeof referenceController.createReferenceCatalogController>['state']
  assert.equal(state.step, 'review')
  assert.equal(state.source?.id, sourceId)
  assert.equal(mounted.instance.setupState.referenceId, 'tape-0')
  assert.equal(state.pendingLabel, undefined)
})

test('实际完整详情组件切换条目时旧全文回执不能覆盖新条目，年份保持原书证据', async t => {
  const first = { reference: { ...reference(1), archive: { sha256, primaryAssetId: null } }, source, revisionId, revisionSequence: 1 }
  const second = { ...first, reference: { ...reference(2), archive: { sha256, primaryAssetId: null } } }
  const reads: { referenceId: string; resolve: (detail: CassetteReferenceDetail) => void }[] = []
  const api = { getCassetteReferenceDetail: ({ referenceId }: { referenceId: string }) => new Promise<CassetteReferenceDetail>(resolve => reads.push({ referenceId, resolve })) }
  const mounted = await mountScript(t, 'CassetteCatalogDetail.vue', { item: first }, api)
  mounted.instance.props.item = second; await mounted.settle()
  assert.equal(reads.length, 2)
  const response = (referenceId: string, text: string): CassetteReferenceDetail => ({ referenceId, bookTitle: source.title, sourceVersion: 'r3', bookYearLabel: '1988（原书标注）', editionBasis: '未确认生产年', lengthsEvidence: '60 / 90', missingPrimaryReason: '原书未提供', sections: [{ title: '原书全文', text }], assets: [], unknownFields: ['生产年未知'] })
  reads[1]!.resolve(response('tape-2', '新条目全文')); await mounted.settle()
  reads[0]!.resolve(response('tape-1', '旧条目全文')); await mounted.settle()
  const detail = mounted.instance.setupState.archiveDetail as CassetteReferenceDetail
  assert.equal(detail.referenceId, 'tape-2')
  assert.equal(detail.sections[0]?.text, '新条目全文')
  assert.equal(detail.bookYearLabel, '1988（原书标注）')
})

test('实际详情顶部优先原书原图，辅助画廊排除同一主图，兼容旧base资产', async t => {
  const item = { reference: { ...reference(), archive: { sha256, primaryAssetId: 'primary-01' } }, source, revisionId, revisionSequence: 1 }
  const asset = (id: string) => ({ id, origin: 'book' as const, role: 'book-image', url: cassetteShared.cassetteAssetUrl(sha256, id), caption: id, source: source.title })
  let detail: CassetteReferenceDetail = { referenceId: item.reference.referenceId, bookTitle: source.title, sourceVersion: 'r3', bookYearLabel: null, editionBasis: '原书资料', lengthsEvidence: '', missingPrimaryReason: null,
    sections: [], assets: [asset('primary-01:original'), asset('primary-01'), asset('auxiliary-01:original')], unknownFields: [] }
  const mounted = await mountScript(t, 'CassetteCatalogDetail.vue', { item }, { getCassetteReferenceDetail: async () => detail }, true)
  await mounted.settle()
  const setup = mounted.instance.setupState
  assert.equal((setup.primaryAsset as { id: string }).id, 'primary-01:original')
  assert.deepEqual((setup.bookAssets as { id: string }[]).map(asset => asset.id), ['auxiliary-01:original'])
  assert.deepEqual(mounted.elements('img').map(image => image.props.src), [cassetteShared.cassetteAssetUrl(sha256, 'primary-01:original'), cassetteShared.cassetteAssetUrl(sha256, 'auxiliary-01:original')])
  detail = { ...detail, assets: [asset('primary-01'), asset('auxiliary-01')] }
  await (setup.loadDetail as () => Promise<void>)(); await mounted.settle()
  assert.equal((setup.primaryAsset as { id: string }).id, 'primary-01')
  assert.deepEqual((setup.bookAssets as { id: string }[]).map(asset => asset.id), ['auxiliary-01'])
  assert.equal(mounted.elements('img')[0]?.props.src, cassetteShared.cassetteAssetUrl(sha256, 'primary-01'))
})

test('实际资料浏览组件层级可回退，搜索结果直接打开具体reference，无需三次点击', async t => {
  const rows = [reference(1), { ...reference(2), model: reference(1).model, era: '1990', edition: '1990' }]
  const items = await loadPublishedCassetteCatalog(catalogFixture(rows).api)
  const mounted = await mountScript(t, 'CassetteCatalogView.vue', { items, loading: false, error: '' }, {})
  const setup = mounted.instance.setupState
  assert.equal(setup.selectedBrand, '')
  ;(setup.showBrand as (brand: string) => void)('TDK'); await mounted.settle()
  const currentBrand = setup.currentBrand as { models: CassetteCatalogModelGroup[] }
  assert.equal(currentBrand.models.length, 1)
  ;(setup.showModel as (group: CassetteCatalogModelGroup) => void)(currentBrand.models[0]!); await mounted.settle()
  assert.equal((setup.visibleRows as PublishedCassetteReference[]).length, 2)
  ;(setup.showBrands as () => void)(); await mounted.settle()
  setup.query = 'p.2'; await mounted.settle()
  const results = setup.visibleRows as PublishedCassetteReference[]
  assert.equal(results.length, 1)
  ;(setup.openDetail as (item: PublishedCassetteReference) => void)(results[0]!); await mounted.settle()
  assert.equal((setup.selected as PublishedCassetteReference).reference.referenceId, 'tape-2')
  assert.equal(setup.selectedModelKey, '')
  assert.equal(setup.breadcrumbBrand, 'TDK')
})

test('资料详情添加收藏只预填已知品牌型号和IEC，实物年份、版次、数量必须按原校验保存', async t => {
  const known = { ...reference(), edition: '1988', era: '1988', confidence: 'high' as const }
  const prefill = collectionPrefillForReference(known), saved: unknown[] = []
  const mounted = await mountScript(t, 'CollectionReceiveDialog.vue', { prefill, busy: false, error: '', retryable: false, onSave: (request: unknown) => saved.push(request) }, {})
  const setup = mounted.instance.setupState, descriptor = setup.descriptor as Record<string, unknown>
  assert.deepEqual(prefill, { brand: 'TDK', name: known.model, format: 'cassette', tapeType: 'II' })
  assert.equal(descriptor.year, null)
  assert.equal(descriptor.edition, '')
  assert.equal(descriptor.identification, 'unidentified')
  assert.equal(setup.year, '')
  assert.deepEqual(setup.quantities, { sealedBlank: 0, openedBlank: 0, legacyUsed: 0, unclassified: 0 })
  assert.equal(saved.length, 0)
  ;(setup.save as () => void)(); assert.equal(saved.length, 0)
  ;(setup.quantities as { unclassified: number }).unclassified = 1
  ;(setup.save as () => void)(); assert.equal(saved.length, 1)
  const request = saved[0] as { model: { year: null; edition: string; identification: string }; quantities: { unclassified: number } }
  assert.equal(request.model.year, null)
  assert.equal(request.model.edition, '')
  assert.equal(request.model.identification, 'unidentified')
  assert.equal(request.quantities.unclassified, 1)
})

test('实际完整ZIP预览展示同ID资料字段更新数量和完整ID，兼容旧delta没有更新字段', async t => {
  const updated = { ...preview, expectedCurrentRevisionId: revisionId, delta: { ...preview.delta, addedReferenceIds: [], retainedReferenceIds: ['tape-0'], updatedReferenceIds: ['tape-0'] } }
  const api: CassetteCatalogApi = { pickCassetteArchive: async () => updated, importCassetteArchive: async () => { throw new Error('NOT_USED') }, getCassetteReferenceDetail: async () => { throw new Error('NOT_USED') } }
  const mounted = await mountScript(t, 'CassetteArchiveImportPanel.vue', {}, api, true)
  const controller = mounted.instance.setupState.controller as ReturnType<typeof createCassetteArchiveImportController>
  await controller.pickArchive(); await mounted.settle()
  assert.match(mounted.text().replace(/\s+/gu, ''), /资料字段更新1项/u)
  assert.match(mounted.text(), /tape-0/u)
  api.pickCassetteArchive = async () => preview
  await controller.pickArchive(); await mounted.settle()
  assert.match(mounted.text().replace(/\s+/gu, ''), /资料字段更新0项/u)
})
