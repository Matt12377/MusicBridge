import { isCollectionId, isSpreadsheetImportPlan, isSpreadsheetRowDecision, isAdjustSpreadsheetInventoryRequest, type SpreadsheetImportPublicApi, type ReferenceCatalogPublicApi } from '@music-bridge/contracts'

type Api = SpreadsheetImportPublicApi & Pick<ReferenceCatalogPublicApi, 'listReferenceSources' | 'getCatalogHistory'>
type Result<K extends keyof Api> = Awaited<ReturnType<Api[K]>>
type Plan = Omit<Parameters<Api['previewSpreadsheetImport']>[0], 'page'>
type Decision = Plan['decisions'][number]
type Mapping = Pick<Plan, 'sheetName' | 'headerRow' | 'columns' | 'previousRevisionId' | 'catalogRevisionId'> & { format: '' | Plan['format']; sourceRelationship: '' | Plan['sourceRelationship'] }
export type SpreadsheetStep = 'source' | 'mapping' | 'review' | 'apply' | 'history'
export interface SpreadsheetImportState extends Mapping {
  /** 映射编辑代次；普通逐行决定或重预览不会改变它。 */
  mappingRevision: number
  source?: NonNullable<Result<'chooseSpreadsheetWorkbook'>>
  sources?: Result<'listSpreadsheetSources'>
  sourceRows?: Result<'getSpreadsheetSourceRows'>
  preview?: Result<'previewSpreadsheetImport'>
  review?: Result<'previewSpreadsheetImport'>
  decisions: Decision[]
  history?: Result<'listSpreadsheetImportHistory'>
  revision?: Result<'getSpreadsheetImportRevision'>
  previousRevision?: Result<'getSpreadsheetImportRevision'>
  balance?: Result<'previewSpreadsheetAdjustment'>
  adjustments?: Result<'listSpreadsheetAdjustments'>
  adjustmentRowId?: string
  applied?: Result<'applySpreadsheetImport'>
  referenceSources?: Result<'listReferenceSources'>
  referenceHistory?: Result<'getCatalogHistory'>
  busy: boolean; pendingLabel?: string; pendingNative: boolean; error: string; notice: string; step: SpreadsheetStep
}

const emptyColumns = (): Plan['columns'] => ({ brand: null, model: null, edition: null, year: null, iec: null, length: null, quantity: null, price: null, purchaseDate: null, used: null, notes: null })
function message(error: unknown): string {
  const code = error instanceof Error ? error.message : ''
  if (/CONFLICT|STALE|FINGERPRINT/u.test(code)) return '原资料或批次余额已变化。请先核对原操作结果，再重新读取和预览；不会替换原指纹强行提交。'
  if (/OUTBOX|TIMEOUT|UNAVAILABLE|DISCONNECTED/u.test(code)) return '暂未取得明确回执。原命令和原工作库已保留；恢复连接后请明确重试。'
  if (/LIMIT|TOO_LARGE|TIME_BUDGET/u.test(code)) return '工作簿超出文件或解析预算，已拒绝导入；不会截断后入库。'
  if (/INVALID|FORMULA|DECISION/u.test(code)) return '请检查工作簿结构、数量和逐行决定。公式不会执行，未确认或无效的行不能入库。'
  return '操作未完成。请检查选择、行问题与当前工作库，原输入和决定仍保留。'
}

export function createSpreadsheetImportController(options: { api: Api; onChange?: () => void; onInventoryChanged?: () => void }) {
  const { api } = options
  const state: SpreadsheetImportState = { mappingRevision: 0, sheetName: '', format: '', sourceRelationship: '', headerRow: 0, columns: emptyColumns(), previousRevisionId: null, decisions: [], busy: false, pendingNative: false, error: '', notice: '', step: 'source' }
  let alive = true
  let pending: (() => Promise<void>) | undefined
  const changed = () => { if (alive) options.onChange?.() }
  const blocked = () => !alive || state.busy || !!pending
  const error = (text: string) => { if (alive) { state.error = text; changed() } }
  async function read<T>(send: () => Promise<T>, accept: (result: T) => void): Promise<void> {
    if (blocked()) return
    state.busy = true; state.error = ''; changed()
    try { const result = await send(); if (alive) accept(result) }
    catch (failure) { if (alive) state.error = message(failure) }
    finally { if (alive) { state.busy = false; changed() } }
  }
  async function retry(confirmed: boolean): Promise<void> {
    if (!confirmed || !alive || state.busy || !pending) return
    const operation = pending
    state.busy = true; state.error = ''; changed()
    try { await operation(); if (alive) { pending = undefined; state.pendingLabel = undefined; state.pendingNative = false } }
    catch (failure) { if (alive) state.error = message(failure) }
    finally { if (alive) { state.busy = false; changed() } }
  }
  async function write<T>(label: string, send: () => Promise<T>, accept: (result: T) => void, native = false): Promise<void> {
    if (blocked()) return
    pending = async () => { const result = await send(); if (alive) accept(result) }
    state.pendingLabel = label; state.pendingNative = native
    await retry(true)
  }
  function acceptSource(source: NonNullable<Result<'chooseSpreadsheetWorkbook'>>): void {
    Object.assign(state, { source, sheetName: '', format: '', sourceRelationship: '', headerRow: 0, columns: emptyColumns(), previousRevisionId: null, catalogRevisionId: undefined, decisions: [], sourceRows: undefined, preview: undefined, review: undefined, previousRevision: undefined, applied: undefined, step: 'mapping' })
    state.mappingRevision++
    state.notice = '原工作簿已登记，尚未写入库存。请声明来源关系，再选择 Sheet、介质和列映射。'
  }
  function plan(): Plan | undefined {
    if (!state.source || !state.sheetName || !state.source.sheets.some(sheet => sheet.name === state.sheetName) || !state.format) { error('请明确选择工作簿、Sheet 和 Cassette / DAT 介质；不会从缺失字段猜测。'); return }
    if (!state.sourceRelationship || state.sourceRelationship === 'revision' && !isCollectionId(state.previousRevisionId) || state.sourceRelationship === 'independent' && state.previousRevisionId !== null) { error('请明确声明来源关系：独立首次导入，或承接一个有效的旧导入修订。'); return }
    if (!Number.isInteger(state.headerRow) || state.headerRow < 0 || state.headerRow > 19_999 || Object.values(state.columns).some(column => column !== null && (!Number.isInteger(column) || column < 1 || column > 64))) { error('请检查表头行与列映射；0 表示无表头，列编号为 1–64。'); return }
    if (state.previousRevisionId !== null && !isCollectionId(state.previousRevisionId) || state.catalogRevisionId !== undefined && !isCollectionId(state.catalogRevisionId)) { error('请选择有效的旧导入修订与参考目录。'); return }
    const request = structuredClone({ sourceId: state.source.id, sheetName: state.sheetName, format: state.format, sourceRelationship: state.sourceRelationship, headerRow: state.headerRow, columns: state.columns, previousRevisionId: state.previousRevisionId, decisions: state.decisions, ...(state.catalogRevisionId ? { catalogRevisionId: state.catalogRevisionId } : {}) })
    if (!isSpreadsheetImportPlan(request)) { error('请检查列映射与逐行决定；对应旧行时必须明确承接旧修订。'); return }
    return request
  }
  return {
    state,
    async start() { await read(() => Promise.all([api.listSpreadsheetSources({ offset: 0, limit: 25 }), api.listSpreadsheetImportHistory({ offset: 0, limit: 25 })]), ([sources, history]) => { state.sources = sources; state.history = history }) },
    async loadSources(offset = 0) { await read(() => api.listSpreadsheetSources({ offset, limit: 25 }), result => { state.sources = result }) },
    async loadHistory(offset = 0) { await read(() => api.listSpreadsheetImportHistory({ offset, limit: 25 }), result => { state.history = result }) },
    async chooseWorkbook() {
      const request = { commandId: crypto.randomUUID() }
      await write('选择 Excel 工作簿', () => api.chooseSpreadsheetWorkbook(request), result => { if (result) acceptSource(result); else state.notice = '已取消选择，没有新增来源或库存。' }, true)
    },
    async selectSource(id: string) { await read(() => api.getSpreadsheetSource({ id }), acceptSource) },
    setStep(step: SpreadsheetStep) { if (!blocked()) { state.step = step; changed() } },
    setMapping(patch: Partial<Mapping>) {
      if (blocked()) return
      Object.assign(state, structuredClone(patch)); state.preview = undefined; state.review = undefined; state.decisions = []; state.error = ''; state.applied = undefined
      if ('sourceRelationship' in patch) { state.previousRevisionId = patch.sourceRelationship === 'revision' ? patch.previousRevisionId ?? null : null; state.previousRevision = undefined }
      if ('sheetName' in patch) state.sourceRows = undefined
      if ('previousRevisionId' in patch) state.previousRevision = undefined
      state.mappingRevision++
      changed()
    },
    async loadSourceRows(offset = 0, sourceId = state.source?.id, sheetName = state.sheetName) {
      if (!sourceId || !sheetName) { error('请先选择 Sheet。'); return }
      await read(() => api.getSpreadsheetSourceRows({ sourceId, sheetName, page: { offset, limit: 25 } }), result => { state.sourceRows = result })
    },
    async loadPreviousRows(offset = 0) {
      const revisionId = state.previousRevisionId
      if (revisionId) await read(() => api.getSpreadsheetImportRevision({ revisionId, page: { offset, limit: 25 } }), result => { state.previousRevision = result })
    },
    setDecision(decision: Decision) {
      if (blocked()) return
      if (!isSpreadsheetRowDecision(decision) || !Number.isInteger(decision.rowIndex) || decision.rowIndex <= state.headerRow || decision.rowIndex > 20_000) { error('请选择表头之后的有效原始行号。'); return }
      if (decision.action === 'match' && (state.sourceRelationship !== 'revision' || state.previousRevisionId === null || !isCollectionId(decision.previousRowId) || state.decisions.some(prior => prior.rowIndex !== decision.rowIndex && prior.action === 'match' && prior.previousRowId === decision.previousRowId))) { error('对应关系必须是一对一；两行不能指向同一个旧源行。'); return }
      state.decisions = [...state.decisions.filter(prior => prior.rowIndex !== decision.rowIndex), structuredClone(decision)].sort((a, b) => a.rowIndex - b.rowIndex)
      state.preview = undefined; state.error = ''; changed()
    },
    removeDecision(rowIndex: number) { if (!blocked()) { state.decisions = state.decisions.filter(row => row.rowIndex !== rowIndex); state.preview = undefined; changed() } },
    async previewImport(offset = 0) {
      if (blocked()) return
      const request = plan(); if (!request) return
      await read(() => api.previewSpreadsheetImport({ ...request, page: { offset, limit: 25 } }), result => { state.preview = result; state.review = result; state.step = 'review'; state.notice = '仅预览，库存未改变。逐行核对后再次预览并独立批准。' })
    },
    async applyImport(confirmed: boolean) {
      if (blocked() || !confirmed || !state.preview) return
      if (state.preview.rows.items.some(row => !row.ready) || state.preview.summary.ambiguousRows > 0 || state.preview.summary.invalidRows > 0) { error('本次仍有未确认、歧义或无效行。请明确对应、新增或跳过后重新预览。'); return }
      const original = plan(); if (!original) return
      const request = structuredClone({ ...original, commandId: crypto.randomUUID(), baselineFingerprint: state.preview.baselineFingerprint, userConfirmed: true as const })
      await write('批准 Excel 导入', () => api.applySpreadsheetImport(request), result => {
        state.applied = result; state.preview = undefined; state.history = undefined; state.step = 'history'
        state.notice = result.duplicate ? '此文件与 Sheet 已导入，本次不新增数量（0 盘）。' : `导入修订已保存：新增 ${result.revision.summary.newQuantity} 盘；只有明确批准的新增行写入库存，修改与移除仅保留建议。`
        options.onInventoryChanged?.()
      })
    },
    async loadRevision(revisionId: string, offset = 0) {
      await read(() => api.getSpreadsheetImportRevision({ revisionId, page: { offset, limit: 25 } }), result => { state.revision = result; state.balance = undefined; state.adjustments = undefined; state.adjustmentRowId = undefined; state.step = 'history' })
    },
    async loadBalance(rowId: string) {
      const revisionId = state.revision?.revision.id
      if (revisionId) await read(() => api.previewSpreadsheetAdjustment({ revisionId, rowId }), result => { state.balance = result })
    },
    async adjustInventory(legacyUsedDelta: number, unclassifiedDelta: number, confirmed: boolean) {
      if (blocked() || !confirmed || !state.balance) return
      const before = state.balance
      if (![legacyUsedDelta, unclassifiedDelta].every(Number.isSafeInteger) || Math.abs(legacyUsedDelta) > 10_000 || Math.abs(unclassifiedDelta) > 10_000 || legacyUsedDelta === 0 && unclassifiedDelta === 0 || before.legacyUsed + legacyUsedDelta < 0 || before.unclassified + unclassifiedDelta < 0) { error('请填写明确的整数增减量，至少一项非零，且不能使任何批次余额为负。'); return }
      const request = { commandId: crypto.randomUUID(), revisionId: before.revisionId, rowId: before.rowId, lotId: before.lotId, expectedBalanceFingerprint: before.balanceFingerprint, legacyUsedDelta, unclassifiedDelta, userConfirmed: true as const }
      if (!isAdjustSpreadsheetInventoryRequest(request)) { error('数量更正请求无效。请重新读取余额并核对整数增减量。'); return }
      await write('确认源行数量更正', () => api.adjustSpreadsheetInventory(request), () => {
        state.balance = undefined; state.notice = '数量更正已保存为独立账本记录。原始入库量与历史保持不变；再次更正前须重新读取余额。'
        options.onInventoryChanged?.()
      })
    },
    async loadAdjustments(rowId?: string, offset = 0) {
      const revisionId = state.revision?.revision.id
      const filterRowId = offset > 0 ? rowId ?? state.adjustmentRowId : rowId
      if (revisionId) await read(() => api.listSpreadsheetAdjustments({ revisionId, ...(filterRowId ? { rowId: filterRowId } : {}), page: { offset, limit: 25 } }), result => { state.adjustments = result; state.adjustmentRowId = filterRowId })
    },
    async loadReferenceSources(offset = 0) { await read(() => api.listReferenceSources({ offset, limit: 25 }), result => { state.referenceSources = result }) },
    async loadReferenceHistory(bookId: string) { await read(() => api.getCatalogHistory({ bookId, offset: 0, limit: 25 }), result => { state.referenceHistory = result }) },
    retry,
    releasePending(confirmed: boolean) {
      if (!confirmed || !alive || state.busy || !pending) return
      pending = undefined; state.pendingLabel = undefined; state.pendingNative = false; state.preview = undefined; state.balance = undefined
      state.notice = '仅退出本地重试。原命令仍保留在全局未确认操作，请核对结果后重新预览；这不撤销已发生的业务。'; changed()
    },
    dispose() { alive = false },
  }
}
