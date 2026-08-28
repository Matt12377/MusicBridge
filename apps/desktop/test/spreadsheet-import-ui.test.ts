import assert from 'node:assert/strict'
import test from 'node:test'
import { createSpreadsheetImportController } from '../src/renderer/src/components/collection/spreadsheet-import-controller.js'
import type { SpreadsheetWorkbookSource, SpreadsheetImportPreview, SpreadsheetImportRevision, SpreadsheetAdjustmentBalance, SpreadsheetInventoryAdjustment } from '@music-bridge/contracts'

const sourceId = '11111111-1111-4111-8111-111111111111'
const revisionId = '22222222-2222-4222-8222-222222222222'
const rowId = '33333333-3333-4333-8333-333333333333'
const lotId = '44444444-4444-4444-8444-444444444444'
const modelId = '55555555-5555-4555-8555-555555555555'
const hash = 'a'.repeat(64), fingerprint = 'b'.repeat(64), timestamp = '2026-08-28T00:00:00.000Z'
const columns = { brand: 1, model: 2, edition: null, year: null, iec: null, length: null, quantity: 3, price: 4, purchaseDate: 5, used: 6, notes: 7 }
const source: SpreadsheetWorkbookSource = { id: sourceId, displayName: '合成库存.xlsx', workbookHash: hash, fileFormat: 'xlsx', parserVersion: 'sheetjs-ce-0.20.3', dateSystem: '1900', byteLength: 1000, createdAt: timestamp, sheets: [{ name: '合成库存', rowCount: 2, nonEmptyCellCount: 8 }] }
const normalized = { descriptor: { brand: '', name: '', edition: '', year: null, format: 'cassette' as const, tapeType: 'unknown' as const, identification: 'partial' as const }, versionCandidate: '原版次候选', lengthMinutes: null, quantity: 10, used: 3, price: { columnIndex: 4, type: 'number' as const, value: 100 }, purchaseDate: { columnIndex: 5, type: 'number' as const, value: 45000, numberFormat: 'yyyy-mm-dd' }, notes: '原备注' }
const previewRow = { rowIndex: 2, rawRowHash: hash, normalizedSignature: hash, normalized, match: 'new' as const, previousRowId: null, issues: [], ready: true, candidates: [] }
const summary = { totalRows: 1, newRows: 1, matchedRows: 0, changedRows: 0, ambiguousRows: 0, skippedRows: 0, invalidRows: 0, removedRows: 0, newQuantity: 10, legacyUsed: 3, unclassified: 7 }
const page = <T>(items: readonly T[]) => ({ items, offset: 0, limit: 25, total: items.length, hasMore: false })
const revision: SpreadsheetImportRevision = { id: revisionId, sourceId, workbookHash: hash, sheetName: '合成库存', format: 'cassette', headerRow: 1, columns, previousRevisionId: null, sequence: 1, createdAt: timestamp, summary }
const preview: SpreadsheetImportPreview = { sourceId, sheetName: '合成库存', previousRevisionId: null, baselineFingerprint: fingerprint, summary, rows: page([previewRow]), removedRows: page([]) }
const balance: SpreadsheetAdjustmentBalance = { revisionId, rowId, lotId, modelId, legacyUsed: 3, unclassified: 7, quantityAcquired: 10, quantityAdjustment: 0, materializedCount: 0, balanceFingerprint: fingerprint }
const adjustment: SpreadsheetInventoryAdjustment = { id: '66666666-6666-4666-8666-666666666666', revisionId, rowId, lotId, before: balance, after: { ...balance, legacyUsed: 2, unclassified: 8 }, createdAt: timestamp }

function fixture() {
  const calls: { name: string; request: unknown }[] = []
  let chooseFails = false, applyFails = false, adjustmentFails = false, duplicate = false
  const api: Parameters<typeof createSpreadsheetImportController>[0]['api'] = {
    async chooseSpreadsheetWorkbook(request) { calls.push({ name: 'choose', request: structuredClone(request) }); if (chooseFails) throw new Error('OUTBOX_RESULT_UNKNOWN /private/secret.xlsx'); return source },
    async listSpreadsheetSources(request) { calls.push({ name: 'sources', request }); return { ...page([source]), limit: 25 } },
    async getSpreadsheetSource(request) { calls.push({ name: 'source', request }); return source },
    async getSpreadsheetSourceRows(request) { calls.push({ name: 'sourceRows', request }); return page([{ sourceId, sheetName: '合成库存', rowIndex: 2, rawRowHash: hash, cells: [{ columnIndex: 3, type: 'number', value: 10 }, { columnIndex: 6, type: 'number', value: 3, formula: '1+2' }] }]) },
    async previewSpreadsheetImport(request) { calls.push({ name: 'preview', request: structuredClone(request) }); return { ...preview, rows: page([{ ...previewRow, ready: request.decisions.some(decision => decision.rowIndex === 2 && decision.action === 'new') }]) } },
    async applySpreadsheetImport(request) { calls.push({ name: 'apply', request: structuredClone(request) }); if (applyFails) throw new Error('OUTBOX_RESULT_UNKNOWN /private/secret'); return { revision, duplicate } },
    async getSpreadsheetImportRevision(request) { calls.push({ name: 'revision', request }); return { revision, rows: page([{ ...previewRow, id: rowId, action: 'created', lotId, modelId }]) } },
    async listSpreadsheetImportHistory(request) { calls.push({ name: 'history', request }); return { ...page([revision]), limit: 25 } },
    async previewSpreadsheetAdjustment(request) { calls.push({ name: 'balance', request }); return balance },
    async adjustSpreadsheetInventory(request) { calls.push({ name: 'adjust', request: structuredClone(request) }); if (adjustmentFails) throw new Error('BALANCE_CONFLICT /private/secret'); return adjustment },
    async listSpreadsheetAdjustments(request) { calls.push({ name: 'adjustments', request }); return page([adjustment]) },
    async listReferenceSources() { return { items: [], total: 0, offset: 0, limit: 25 } },
    async getCatalogHistory(request) { return { bookId: request.bookId, currentRevisionId: null, revisions: [], snapshots: [], total: 0, offset: 0, limit: 25 } },
  }
  const controller = createSpreadsheetImportController({ api })
  return { api, controller, calls, chooseFails: (value: boolean) => { chooseFails = value }, applyFails: (value: boolean) => { applyFails = value }, adjustmentFails: (value: boolean) => { adjustmentFails = value }, duplicate: (value: boolean) => { duplicate = value } }
}
async function planned(f: ReturnType<typeof fixture>) {
  await f.controller.selectSource(sourceId)
  f.controller.setMapping({ sheetName: '合成库存', format: 'cassette', sourceRelationship: 'independent', headerRow: 1, columns, previousRevisionId: null })
}

test('打开仅列来源与历史，未明确选择不调用原生选择器，介质默认不猜', async () => {
  const f = fixture(); assert.equal(f.calls.length, 0)
  await f.controller.start()
  assert.deepEqual(f.calls.map(call => call.name), ['sources', 'history'])
  assert.equal(f.controller.state.format, '')
  assert.equal(f.controller.state.sourceRelationship, '')
  assert.deepEqual(f.controller.state.decisions, [])
  f.controller.dispose()
})

test('原生失回执保留commandId，明确重试恢复且错误无路径；取消不丢既有来源', async () => {
  const f = fixture(); f.chooseFails(true)
  await f.controller.chooseWorkbook()
  assert.ok(f.controller.state.pendingLabel)
  assert.doesNotMatch(f.controller.state.error, /private|secret/u)
  await f.controller.chooseWorkbook(); assert.equal(f.calls.length, 1)
  f.chooseFails(false); await f.controller.retry(true)
  assert.deepEqual(f.calls.filter(call => call.name === 'choose').map(call => call.request), [f.calls[0]!.request, f.calls[0]!.request])
  assert.equal(f.controller.state.source?.id, sourceId)
  f.api.chooseSpreadsheetWorkbook = async () => null
  await f.controller.chooseWorkbook(); assert.equal(f.controller.state.source?.id, sourceId)
  assert.equal(f.controller.state.pendingLabel, undefined)
  f.controller.dispose()
})

test('Sheet、介质和映射明确后才预览；预览不写库存，改映射/决策使旧指纹失效', async () => {
  const f = fixture(); await f.controller.selectSource(sourceId)
  await f.controller.previewImport(); assert.equal(f.calls.some(call => call.name === 'preview'), false)
  await planned(f); await f.controller.previewImport()
  assert.ok(f.controller.state.preview)
  assert.equal(f.calls.some(call => call.name === 'apply'), false)
  f.controller.setDecision({ rowIndex: 2, action: 'new', formulaConfirmed: true })
  assert.equal(f.controller.state.preview, undefined)
  await f.controller.previewImport()
  f.controller.setMapping({ headerRow: 0 })
  assert.equal(f.controller.state.preview, undefined)
  assert.deepEqual(f.controller.state.decisions, [])
  f.controller.dispose()
})

test('完整映射仍须主动声明独立或承接来源，空旧修订不等于默认首次', async () => {
  const f = fixture(); await f.controller.selectSource(sourceId)
  f.controller.setMapping({ sheetName: '合成库存', format: 'cassette', headerRow: 1, columns })
  await f.controller.previewImport()
  assert.equal(f.calls.some(call => call.name === 'preview'), false, '未声明来源关系不能发送预览')
  assert.equal(f.controller.state.sourceRelationship, '')
  assert.match(f.controller.state.error, /独立|承接|来源关系/u)
  f.controller.setMapping({ sourceRelationship: 'revision' })
  await f.controller.previewImport(); assert.equal(f.calls.some(call => call.name === 'preview'), false)
  f.controller.setMapping({ previousRevisionId: revisionId }); await f.controller.previewImport()
  assert.equal((f.calls.at(-1)?.request as Record<string, unknown>).sourceRelationship, 'revision')
  f.controller.setDecision({ rowIndex: 2, action: 'match', previousRowId: rowId })
  f.controller.setMapping({ sourceRelationship: 'independent' })
  assert.equal(f.controller.state.previousRevisionId, null)
  assert.equal(f.controller.state.preview, undefined); assert.deepEqual(f.controller.state.decisions, [])
  await f.controller.previewImport()
  assert.equal((f.calls.at(-1)?.request as Record<string, unknown>).sourceRelationship, 'independent')
  await f.controller.selectSource(sourceId)
  assert.equal(f.controller.state.sourceRelationship, '', '重新选择来源不能继承上次首次声明')
  f.controller.dispose()
})

test('新增先明确行决策与独立确认，回执未知重试保持原计划/指纹，重复文件显示零新增', async () => {
  const f = fixture(); await planned(f); await f.controller.previewImport()
  await f.controller.applyImport(true); assert.equal(f.calls.some(call => call.name === 'apply'), false)
  f.controller.setDecision({ rowIndex: 2, action: 'new', formulaConfirmed: true }); await f.controller.previewImport()
  await f.controller.applyImport(false); assert.equal(f.calls.some(call => call.name === 'apply'), false)
  f.applyFails(true); await f.controller.applyImport(true)
  const request = f.calls.find(call => call.name === 'apply')!.request
  assert.equal((request as Record<string, unknown>).sourceRelationship, 'independent')
  f.controller.setMapping({ format: 'dat' }); assert.equal(f.controller.state.format, 'cassette')
  f.controller.setMapping({ sourceRelationship: 'revision', previousRevisionId: revisionId }); assert.equal(f.controller.state.sourceRelationship, 'independent')
  f.applyFails(false); f.duplicate(true); await f.controller.retry(true)
  assert.deepEqual(f.calls.filter(call => call.name === 'apply').map(call => call.request), [request, request])
  assert.match(f.controller.state.notice, /重复|已导入/u)
  assert.match(f.controller.state.notice, /不新增|0/u)
  assert.equal(f.controller.state.preview, undefined)
  f.controller.dispose()
})

test('歧义对应保持手动一对一，不能让两行静默指向同一旧行', async () => {
  const f = fixture(); await planned(f)
  f.controller.setDecision({ rowIndex: 2, action: 'match', previousRowId: rowId })
  assert.equal(f.controller.state.decisions.length, 0, '未承接旧修订不能建立旧行对应')
  f.controller.setMapping({ sourceRelationship: 'revision', previousRevisionId: revisionId })
  f.controller.setDecision({ rowIndex: 2, action: 'match', previousRowId: rowId })
  f.controller.setDecision({ rowIndex: 3, action: 'match', previousRowId: rowId })
  assert.equal(f.controller.state.decisions.length, 1)
  assert.ok(f.controller.state.error)
  f.controller.dispose()
})

test('数量更正独立核对原Lot余额，以有符号delta和原指纹提交，不重置原始数量', async () => {
  const f = fixture(); await f.controller.loadRevision(revisionId); await f.controller.loadBalance(rowId)
  await f.controller.adjustInventory(-4, 0, true)
  assert.equal(f.calls.some(call => call.name === 'adjust'), false)
  await f.controller.adjustInventory(-1, 1, false)
  assert.equal(f.calls.some(call => call.name === 'adjust'), false)
  f.adjustmentFails(true); await f.controller.adjustInventory(-1, 1, true)
  const request = f.calls.find(call => call.name === 'adjust')!.request as Record<string, unknown>
  assert.equal(request.expectedBalanceFingerprint, fingerprint)
  assert.equal(request.lotId, lotId)
  assert.equal(request.legacyUsedDelta, -1); assert.equal(request.unclassifiedDelta, 1)
  assert.equal('quantity' in request, false)
  assert.doesNotMatch(f.controller.state.error, /private|secret/u)
  f.adjustmentFails(false); await f.controller.retry(true)
  assert.deepEqual(f.calls.filter(call => call.name === 'adjust').map(call => call.request), [request, request])
  assert.equal(f.controller.state.balance, undefined)
  f.controller.dispose()
})

test('来源原单元格/价格/日期/备注只读保留；历史读取不自动应用或调整', async () => {
  const f = fixture(); await f.controller.selectSource(sourceId); f.controller.setMapping({ sheetName: '合成库存' }); await f.controller.loadSourceRows()
  assert.equal(f.controller.state.sourceRows?.items[0]?.cells[1]?.formula, '1+2')
  await f.controller.loadRevision(revisionId)
  assert.deepEqual(f.controller.state.revision?.rows.items[0]?.normalized, normalized)
  await f.controller.loadAdjustments(rowId)
  assert.equal(f.calls.some(call => ['apply', 'adjust'].includes(call.name)), false)
  f.controller.dispose()
})

test('单飞与卸载阻止重入和迟到状态更新，重新打开不会自动重发', async () => {
  const f = fixture(); let finish!: (value: SpreadsheetWorkbookSource) => void
  let count = 0
  f.api.chooseSpreadsheetWorkbook = async () => { count++; return new Promise(resolve => { finish = resolve }) }
  const choosing = f.controller.chooseWorkbook(); await f.controller.chooseWorkbook(); await f.controller.retry(true)
  assert.equal(count, 1)
  f.controller.dispose(); finish(source); await choosing
  assert.equal(f.controller.state.source, undefined)
  const reopened = fixture(); await reopened.controller.start()
  assert.equal(reopened.calls.some(call => ['choose', 'apply', 'adjust'].includes(call.name)), false)
  reopened.controller.dispose()
})

test('实际来源行/预览/修订/更正历史请求遵守公共分页上限25，不能靠宽松fake放过', async () => {
  const guards = await import('../../../packages/contracts/src/spreadsheet-import.js')
  const f = fixture()
  const methods = [
    ['getSpreadsheetSourceRows', guards.isSpreadsheetSourceRowsRequest],
    ['previewSpreadsheetImport', guards.isPreviewSpreadsheetImportRequest],
    ['getSpreadsheetImportRevision', guards.isSpreadsheetImportRevisionRequest],
    ['listSpreadsheetAdjustments', guards.isSpreadsheetAdjustmentsRequest],
  ] as const
  const validity: boolean[] = []
  for (const [key, guard] of methods) {
    const original = f.api[key]
    Object.assign(f.api, { [key]: (request: never) => { validity.push(guard(request)); return original(request) } })
  }
  await planned(f); await f.controller.loadSourceRows(); await f.controller.previewImport()
  await f.controller.loadRevision(revisionId); await f.controller.loadAdjustments(rowId)
  assert.deepEqual(validity, [true, true, true, true])
  f.controller.dispose()
})

test('逐行决定使提交预览失效但保留可读行，不能每点一行就丢掉审核表', async () => {
  const f = fixture(); await planned(f); await f.controller.previewImport()
  f.controller.setDecision({ rowIndex: 2, action: 'new' })
  assert.equal(f.controller.state.preview, undefined)
  assert.equal(f.controller.state.review?.rows.items[0]?.rowIndex, 2)
  f.controller.dispose()
})

async function mountedPanel(t: test.TestContext, f = fixture()) {
  const { readFile } = await import('node:fs/promises')
  const { createRequire } = await import('node:module')
  const { parse, compileScript, compileTemplate } = await import('@vue/compiler-sfc')
  const ts = (await import('typescript')).default
  const require = createRequire(import.meta.url), vue = require('vue') as typeof import('vue')
  const sourceText = await readFile(new URL('../src/renderer/src/components/collection/SpreadsheetImportPanel.vue', import.meta.url), 'utf8')
  const { descriptor, errors } = parse(sourceText); assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: 'spreadsheet-panel-test' })
  const template = compileTemplate({ id: 'spreadsheet-panel-test', source: descriptor.template!.content, filename: 'SpreadsheetImportPanel.vue', compilerOptions: { bindingMetadata: script.bindings } }); assert.deepEqual(template.errors, [])
  const compiled = ts.transpileModule(script.content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const controllerModule = await import('../src/renderer/src/components/collection/spreadsheet-import-controller.js')
  const displayModule = await import('../src/renderer/src/components/collection/collection-display.js')
  const module = { exports: {} as { default: import('vue').Component } }
  new Function('require', 'module', 'exports', 'window', compiled)((name: string) => name === 'vue' ? vue : name.includes('spreadsheet-import-controller') ? controllerModule : name.includes('collection-display') ? displayModule : require(name), module, module.exports, { musicBridge: f.api })
  interface Host { children: Host[]; parent: Host | null }
  const node = (): Host => ({ children: [], parent: null })
  const renderer = vue.createRenderer<Host, Host>({ createElement: node, createText: node, createComment: node, setText() {}, setElementText() {}, patchProp() {}, insert(child, parent) { child.parent = parent; parent.children.push(child) }, remove() {}, parentNode: n => n.parent, nextSibling: () => null })
  const app = renderer.createApp({ ...module.exports.default, render: () => null })
  const instance = app.mount(node()); t.after(() => app.unmount())
  await new Promise<void>(resolve => setImmediate(resolve))
  const setup = (instance.$ as unknown as { setupState: {
    state: ReturnType<typeof createSpreadsheetImportController>['state']; controller: ReturnType<typeof createSpreadsheetImportController>
    applyConfirmed: boolean; adjustmentConfirmed: boolean; issues: Record<string, string>
    rowActions: Record<number, '' | 'new' | 'match' | 'skip'>; previousRows: Record<number, string>; formulaReviewed: Record<number, boolean>; rowError: string
    setDecision(row: typeof previewRow): void
  } }).setupState
  const templateModule = { exports: {} as { render: (...args: unknown[]) => unknown } }
  const templateCode = ts.transpileModule(template.code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  new Function('require', 'module', 'exports', templateCode)((name: string) => name === 'vue' ? vue : require(name), templateModule, templateModule.exports)
  function text(value: unknown): string {
    if (typeof value === 'string') return value
    if (Array.isArray(value)) return value.map(text).join(' ')
    return value && typeof value === 'object' && 'children' in value ? text(value.children) : ''
  }
  return { f, setup, tick: vue.nextTick, renderText: () => text(templateModule.exports.render(instance, [], {}, setup, {}, {})) }
}

test('实际导入面板编译执行后只读历史，介质为空且新增未确认，不自动打开文件', async t => {
  const { f, setup } = await mountedPanel(t)
  assert.equal(setup.state.format, '')
  assert.equal(setup.state.sourceRelationship, '')
  assert.equal(setup.issues.INVALID_METADATA, '资料格式或长度无效，请修正原资料或跳过此行')
  assert.equal(setup.applyConfirmed, false); assert.equal(setup.adjustmentConfirmed, false)
  assert.deepEqual(f.calls.map(call => call.name), ['sources', 'history'])
})

test('实际SFC同工作簿改映射清除旧公式确认与编辑，普通行决定及重预览不清除', async t => {
  const f = fixture()
  f.api.getSpreadsheetSource = async () => ({ ...source, sheets: [...source.sheets, { name: '另一个Sheet', rowCount: 2, nonEmptyCellCount: 8 }] })
  const { setup, tick } = await mountedPanel(t, f), controller = setup.controller
  await controller.selectSource(sourceId)
  controller.setMapping({ sheetName: '合成库存', format: 'cassette', sourceRelationship: 'independent', headerRow: 1, columns })
  await tick()
  for (const patch of [{ columns: { ...columns, quantity: 6 } }, { columns: { ...columns, used: 3 } }, { sheetName: '另一个Sheet' }, { headerRow: 0 }, { format: 'dat' as const }, { sourceRelationship: 'revision' as const, previousRevisionId: revisionId }]) {
    setup.rowActions = { 2: 'new' }; setup.previousRows = { 2: rowId }; setup.formulaReviewed = { 2: true }; setup.rowError = '旧行提示'
    setup.setDecision(previewRow); await tick()
    assert.equal(controller.state.decisions[0]?.formulaConfirmed, true)
    assert.equal(setup.formulaReviewed[2], true, '普通setDecision不得清公式确认')
    const previews = f.calls.filter(call => call.name === 'preview').length
    await controller.previewImport(); await tick()
    assert.equal(f.calls.filter(call => call.name === 'preview').length, previews + 1)
    assert.equal(setup.rowActions[2], 'new'); assert.equal(setup.formulaReviewed[2], true, '普通重预览不得清编辑')
    controller.setMapping(patch); await tick()
    assert.deepEqual(setup.rowActions, {}); assert.deepEqual(setup.previousRows, {}); assert.deepEqual(setup.formulaReviewed, {})
    assert.equal(setup.rowError, ''); assert.equal(controller.state.decisions.length, 0)
    setup.rowActions = { 2: 'new' }; setup.setDecision(previewRow)
    assert.equal(controller.state.decisions[0]?.formulaConfirmed, undefined, '映射后的同号行不得自动继承旧公式确认')
  }
})

test('实际模板成功导入后不再把缓存空历史显示成没有修订，刷新才采纳真实分页', async t => {
  const f = fixture(); f.api.listSpreadsheetImportHistory = async () => page([])
  const { setup, tick, renderText } = await mountedPanel(t, f), controller = setup.controller
  controller.setStep('history'); await tick()
  assert.match(renderText(), /还没有已应用的导入修订/u)
  await controller.selectSource(sourceId)
  controller.setMapping({ sheetName: '合成库存', format: 'cassette', sourceRelationship: 'independent', headerRow: 1, columns })
  controller.setDecision({ rowIndex: 2, action: 'new' }); await controller.previewImport(); await controller.applyImport(true); await tick()
  const visible = renderText()
  assert.match(visible, /导入修订已保存/u)
  assert.doesNotMatch(visible, /还没有已应用的导入修订/u)
  assert.match(visible, /导入历史尚未刷新/u)
  assert.equal(controller.state.history?.total ?? 0, 0, '不得拼装虚假的历史页')
  f.api.listSpreadsheetImportHistory = async request => ({ ...page([revision]), offset: request.offset, total: 26, hasMore: true })
  await controller.loadHistory(); await tick()
  assert.equal(controller.state.history?.total, 26); assert.equal(controller.state.history?.hasMore, true)
  assert.match(renderText(), /查看修订与源行/u)
  assert.doesNotMatch(renderText(), /导入历史尚未刷新/u)
})


test('源行更正历史翻页保留原行筛选，明确读取全部历史才清除筛选', async () => {
  const f = fixture(); await f.controller.loadRevision(revisionId)
  await f.controller.loadAdjustments(rowId)
  await f.controller.loadAdjustments(undefined, 25)
  const pages = f.calls.filter(call => call.name === 'adjustments').map(call => call.request as { rowId?: string; page: { offset: number } })
  assert.equal(pages[0]?.rowId, rowId); assert.equal(pages[1]?.rowId, rowId)
  assert.equal(pages[1]?.page.offset, 25)
  await f.controller.loadAdjustments()
  assert.equal((f.calls.at(-1)?.request as { rowId?: string }).rowId, undefined)
  f.controller.dispose()
})
