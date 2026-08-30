<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, triggerRef, watch } from 'vue'
import type { SpreadsheetCell, SpreadsheetImportField, SpreadsheetImportIssueCode, SpreadsheetPreviewRow, SpreadsheetRowDecision } from '@music-bridge/contracts'
import { createSpreadsheetImportController, type SpreadsheetStep } from './spreadsheet-import-controller'
import { collectionModelLabel } from './collection-display'

const emit = defineEmits<{ close: []; changed: [] }>()
const dialog = ref<HTMLDialogElement>()
const controller = createSpreadsheetImportController({ api: window.musicBridge, onChange: () => triggerRef(state), onInventoryChanged: () => emit('changed') })
const state = shallowRef(controller.state)
const blocked = computed(() => state.value.busy || !!state.value.pendingLabel)
const closeRequested = ref(false), applyConfirmed = ref(false), adjustmentConfirmed = ref(false), retryConfirmed = ref(false)
const legacyDelta = ref(0), unclassifiedDelta = ref(0)
const rowActions = ref<Record<number, '' | SpreadsheetRowDecision['action']>>({})
const previousRows = ref<Record<number, string>>({}), formulaReviewed = ref<Record<number, boolean>>({})
const rowError = ref('')
const steps: { id: SpreadsheetStep; title: string }[] = [{ id: 'source', title: '选择来源' }, { id: 'mapping', title: '映射字段' }, { id: 'review', title: '核对源行' }, { id: 'apply', title: '批准导入' }, { id: 'history', title: '历史与更正' }]
const fields: { id: SpreadsheetImportField; label: string }[] = [{ id: 'brand', label: '品牌' }, { id: 'model', label: '型号' }, { id: 'edition', label: '版次候选' }, { id: 'year', label: '年份' }, { id: 'iec', label: 'IEC 类型' }, { id: 'length', label: '时长（分钟）' }, { id: 'quantity', label: '总数量' }, { id: 'used', label: 'Used 数量' }, { id: 'price', label: '价格原值' }, { id: 'purchaseDate', label: '购买日期原值' }, { id: 'notes', label: '备注' }]
const issues: Record<SpreadsheetImportIssueCode, string> = { UNKNOWN_METADATA: '资料缺失，保留待确认', INVALID_METADATA: '资料格式或长度无效，请修正原资料或跳过此行', INVALID_QUANTITY: '总数量无效', INVALID_USED: 'Used 数量无效', INVALID_LENGTH: '时长无效', INVALID_YEAR: '年份无效', INVALID_DATE: '日期异常，保留原值', FORMULA_REVIEW_REQUIRED: '数量公式需明确审核', FORMULA_CACHE_MISSING: '公式无缓存值，不能猜数', CELL_ERROR: '单元格错误', AMBIGUOUS_ROW: '对应关系有歧义', UNCONFIRMED_NEW_ROW: '尚未明确批准为新增' }
const matchLabels = { new: '待确认新增', matched: '已对应旧行', changed: '原行已变化，仅保留建议', ambiguous: '对应待人工确认', skipped: '跳过', invalid: '无效行' }
const summaryFields = [{ id: 'totalRows', label: '源行' }, { id: 'newRows', label: '新增行' }, { id: 'matchedRows', label: '对应旧行' }, { id: 'changedRows', label: '变化行' }, { id: 'ambiguousRows', label: '歧义行' }, { id: 'invalidRows', label: '无效行' }, { id: 'skippedRows', label: '跳过行' }, { id: 'removedRows', label: '移除建议' }] as const
const pageSize = 25
const decisionFor = (rowIndex: number) => state.value.decisions.find(decision => decision.rowIndex === rowIndex)
const columnLabel = (index: number): string => {
  const first = Math.floor((index - 1) / 26), last = String.fromCharCode(65 + (index - 1) % 26)
  return `${first ? String.fromCharCode(64 + first) : ''}${last}（第 ${index} 列）`
}
function cellText(cell: SpreadsheetCell | null): string {
  if (!cell) return '未提供'
  return cell.value === null ? '空值' : String(cell.value)
}
function setColumn(field: SpreadsheetImportField, event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  controller.setMapping({ columns: { ...state.value.columns, [field]: value === '' ? null : Number(value) } })
}
function setFormat(event: Event): void {
  const format = (event.target as HTMLSelectElement).value
  if (format === '' || format === 'cassette' || format === 'dat') controller.setMapping({ format })
}
function setSourceRelationship(event: Event): void {
  const sourceRelationship = (event.target as HTMLSelectElement).value
  if (sourceRelationship === '' || sourceRelationship === 'independent' || sourceRelationship === 'revision') controller.setMapping({ sourceRelationship })
}
function setDecision(row: SpreadsheetPreviewRow): void {
  const action = rowActions.value[row.rowIndex]
  if (!action) { rowError.value = '请选择新增、对应旧行或跳过。'; return }
  const decision: SpreadsheetRowDecision = { rowIndex: row.rowIndex, action,
    ...(action === 'match' ? { previousRowId: previousRows.value[row.rowIndex] || row.previousRowId || '' } : {}),
    ...(action !== 'skip' && formulaReviewed.value[row.rowIndex] ? { formulaConfirmed: true as const } : {}) }
  controller.setDecision(decision); rowError.value = ''
}
function approvePageNew(): void {
  for (const row of state.value.review?.rows.items ?? []) {
    if (row.match !== 'new' || row.issues.some(issue => !['UNKNOWN_METADATA', 'UNCONFIRMED_NEW_ROW'].includes(issue.code))) continue
    controller.setDecision({ rowIndex: row.rowIndex, action: 'new' })
  }
}
function requestClose(): void {
  if (state.value.busy) return
  if (state.value.source || state.value.pendingLabel) closeRequested.value = true
  else emit('close')
}
watch(() => state.value.preview, () => { applyConfirmed.value = false })
watch(() => state.value.mappingRevision, () => { rowActions.value = {}; previousRows.value = {}; formulaReviewed.value = {}; rowError.value = '' }, { flush: 'sync' })
watch(() => state.value.balance, () => { legacyDelta.value = 0; unclassifiedDelta.value = 0; adjustmentConfirmed.value = false })
watch([legacyDelta, unclassifiedDelta], () => { adjustmentConfirmed.value = false })
onMounted(async () => { await nextTick(); dialog.value?.showModal(); dialog.value?.querySelector<HTMLElement>('#spreadsheet-title')?.focus({ preventScroll: true }); void controller.start() })
onBeforeUnmount(() => { controller.dispose(); dialog.value?.close() })
</script>

<template>
  <dialog ref="dialog" class="spreadsheet-dialog" aria-labelledby="spreadsheet-title" aria-describedby="spreadsheet-boundary" @cancel.prevent="requestClose">
    <header class="heading">
      <div><p class="kicker">收藏 · 工作簿资料</p><h2 id="spreadsheet-title" tabindex="-1">Excel 非破坏导入</h2></div>
      <button type="button" :disabled="state.busy" @click="requestClose">关闭</button>
    </header>
    <p id="spreadsheet-boundary">原文件和原行完整保留。预览不写库存；导入不会推断空白磁带、分配实体编号或改写人工资料。</p>
    <nav class="steps" aria-label="Excel 导入步骤"><button v-for="(step, index) in steps" :key="step.id" :aria-current="state.step === step.id ? 'step' : undefined" :disabled="blocked" @click="controller.setStep(step.id)"><span>{{ index + 1 }}</span>{{ step.title }}</button></nav>
    <section v-if="closeRequested" class="feedback" role="alert"><p>关闭会丢弃未保存的列映射与逐行决定。已登记来源和历史保留；未确认命令可从全局入口恢复，不会自动重试。</p><div class="actions"><button @click="closeRequested = false">继续核对</button><button @click="emit('close')">确认关闭</button></div></section>
    <p v-if="state.busy" role="status">正在处理，请稍候…</p>
    <p v-if="state.error" class="error" role="alert">{{ state.error }}</p>
    <p v-if="state.notice" class="notice" role="status">{{ state.notice }}</p>
    <section v-if="state.pendingLabel" class="feedback" aria-label="恢复 Excel 原操作">
      <h3>{{ state.pendingLabel }}：等待明确回执</h3>
      <p>{{ state.pendingNative ? '先恢复原选择回执；如果从未完成，本次明确确认后可能重新打开文件选择器。' : '恢复原命令、原计划与原指纹，不换参数绕过冲突。' }}</p>
      <label class="check"><input v-model="retryConfirmed" type="checkbox" :disabled="state.busy">{{ state.pendingNative ? '我确认恢复原选择回执；若未完成，重新选择工作簿' : '我已核对结果，确认重试原操作或退出本地重试' }}</label>
      <div class="actions"><button :disabled="state.busy || !retryConfirmed" @click="controller.retry(true); retryConfirmed = false">重试原操作</button><button :disabled="state.busy || !retryConfirmed" @click="controller.releasePending(true); retryConfirmed = false">退出本地重试</button></div>
      <p class="hint">退出只清除本面板的重试状态，不撤销业务；全局未确认操作仍保留记录。</p>
    </section>

    <section v-if="state.step === 'source'" aria-labelledby="spreadsheet-source-title">
      <h3 id="spreadsheet-source-title">1. 显式选择工作簿</h3>
      <p>支持 .xlsx 与 .xls，最多 8 MiB。只读取你选择的单个文件，不扫描目录、不跟随链接、不执行公式或宏。</p>
      <button class="primary" :disabled="blocked" @click="controller.chooseWorkbook">选择 Excel 工作簿</button>
      <h4>已登记工作簿</h4><p v-if="!state.sources?.items.length">尚无工作簿。没有默认示例或自动读取的真实资料。</p>
      <ul class="records"><li v-for="source in state.sources?.items" :key="source.id"><div><strong>{{ source.displayName }}</strong><p>{{ source.fileFormat.toUpperCase() }} · {{ source.sheets.length }} 个 Sheet · {{ source.createdAt }}</p><code>{{ source.workbookHash }}</code></div><button :disabled="blocked" @click="controller.selectSource(source.id)">使用此来源</button></li></ul>
      <div class="actions"><button :disabled="blocked" @click="controller.loadSources()">刷新来源</button><template v-if="state.sources && state.sources.total > state.sources.limit"><button :disabled="blocked || state.sources.offset === 0" @click="controller.loadSources(Math.max(0, state.sources.offset - pageSize))">上一页来源</button><button :disabled="blocked || !state.sources.hasMore" @click="controller.loadSources(state.sources.offset + pageSize)">下一页来源</button></template></div>
    </section>

    <section v-if="state.step === 'mapping'" aria-labelledby="spreadsheet-mapping-title">
      <h3 id="spreadsheet-mapping-title">2. 选择 Sheet、介质与列映射</h3><p v-if="!state.source">请先选择或读取已登记的工作簿。</p>
      <template v-else>
        <div class="summary"><strong>{{ state.source.displayName }}</strong><p>{{ state.source.parserVersion }} · {{ state.source.dateSystem }} 日期系统 · {{ state.source.byteLength }} 字节</p><code>{{ state.source.workbookHash }}</code></div>
        <p>不确定的字段可以不映射，数据保持 Unknown。总量 10、Used 3 将记为旧录音待登记 3、未分类 7，不认定为空白磁带。</p>
        <fieldset :disabled="blocked"><legend>导入上下文</legend><div class="fields">
          <label>工作表 Sheet<select :value="state.sheetName" @change="controller.setMapping({ sheetName: ($event.target as HTMLSelectElement).value })"><option value="">请选择 Sheet</option><option v-for="sheet in state.source.sheets" :key="sheet.name" :value="sheet.name">{{ sheet.name }} · {{ sheet.rowCount }} 行</option></select></label>
          <label>介质类别（必须明确选择）<select :value="state.format" @change="setFormat"><option value="">不猜测，请选择</option><option value="cassette">Cassette · 卡式磁带</option><option value="dat">DAT</option></select></label>
          <label>表头行号（0 表示无表头）<input :value="state.headerRow" type="number" min="0" max="19999" step="1" @change="controller.setMapping({ headerRow: Number(($event.target as HTMLInputElement).value) })"></label>
          <label>来源关系（必须明确声明）<select :value="state.sourceRelationship" @change="setSourceRelationship"><option value="">请选择，不默认首次导入</option><option value="independent">独立首次导入 · 不承接既有库存资料</option><option value="revision">承接已有导入 · 修改、排序或增删行</option></select></label>
          <label v-if="state.sourceRelationship === 'revision'">承接旧导入修订<select :value="state.previousRevisionId ?? ''" @change="controller.setMapping({ previousRevisionId: ($event.target as HTMLSelectElement).value || null })"><option value="">请选择要承接的旧修订</option><option v-for="revision in state.history?.items" :key="revision.id" :value="revision.id">{{ revision.sheetName }} · 修订 {{ revision.sequence }} · {{ revision.createdAt }} · {{ revision.workbookHash.slice(0, 8) }}</option></select></label>
        </div><p class="hint">若这是已导入资料的修改、排序或增删行，请选择承接旧修订。只有确认它是独立来源时才选独立首次导入；文件字节变化不会自动代表新库存。同文件同 Sheet 重复导入不增加数量。</p>
        <div class="actions"><button :disabled="!state.sheetName" @click="controller.loadSourceRows()">读取原始行以核对列</button><button @click="controller.loadHistory()">刷新可承接修订</button><button v-if="state.history?.hasMore" @click="controller.loadHistory(state.history.offset + pageSize)">更多旧修订</button><button v-if="state.history && state.history.offset > 0" @click="controller.loadHistory(Math.max(0, state.history.offset - pageSize))">上一页旧修订</button></div>
        <div class="fields"><label v-for="field in fields" :key="field.id">{{ field.label }}对应列<select :value="state.columns[field.id] ?? ''" @change="setColumn(field.id, $event)"><option value="">未映射 / 保留未知</option><option v-for="column in 64" :key="column" :value="column">{{ columnLabel(column) }}</option></select></label></div>
        </fieldset>
        <p class="hint">改变映射会清除当前逐行决定，需要重新预览；原工作簿和已入库记录始终不变。</p>
        <details><summary>可选：参考目录候选</summary><p>仅提供 Candidate，不自动确认拥有，不把未匹配变成 Missing，也不修改历史快照。</p><button :disabled="blocked" @click="controller.loadReferenceSources()">读取已登记参考来源</button><label>参考书籍来源<select :disabled="blocked" @change="controller.loadReferenceHistory(($event.target as HTMLSelectElement).value)"><option value="">请选择参考来源</option><option v-for="source in state.referenceSources?.items" :key="source.id" :value="source.bookId">{{ source.title }} · {{ source.sourceVersion }}</option></select></label><button v-if="state.referenceSources?.total && state.referenceSources.offset + pageSize < state.referenceSources.total" :disabled="blocked" @click="controller.loadReferenceSources(state.referenceSources.offset + pageSize)">更多参考来源</button><label>用于产生候选的目录修订<select :value="state.catalogRevisionId ?? ''" :disabled="blocked" @change="controller.setMapping({ catalogRevisionId: ($event.target as HTMLSelectElement).value || undefined })"><option value="">不使用参考目录</option><option v-for="revision in state.referenceHistory?.revisions" :key="revision.id" :value="revision.id">版次 {{ revision.sequence }} · {{ revision.createdAt }}</option></select></label></details>
        <button class="primary" :disabled="blocked || !state.sheetName || !state.format || !state.sourceRelationship || state.sourceRelationship === 'revision' && !state.previousRevisionId" @click="controller.previewImport()">预览源行与修订差异</button>
      </template>
    </section>

    <section v-if="state.step === 'review'" aria-labelledby="spreadsheet-review-title">
      <h3 id="spreadsheet-review-title">3. 核对原行与对应关系</h3><p v-if="!state.review">请先完成映射并预览。</p>
      <template v-else>
        <p>整批共 {{ state.review.summary.totalRows }} 行；下面每页最多 25 行。Unknown 可保留，数量错误与歧义必须处理；公式仅显示原公式和缓存值。</p>
        <dl class="metrics"><div v-for="field in summaryFields" :key="field.id"><dt>{{ field.label }}</dt><dd>{{ state.review.summary[field.id] }}</dd></div></dl>
        <p v-if="!state.preview" class="notice">逐行决定已改变；以下是上次预览的原行。重新预览后才能批准。</p>
        <div class="actions"><button :disabled="blocked" @click="approvePageNew">本页有效新行标为新增</button><button :disabled="blocked" @click="controller.previewImport(state.review.rows.offset)">按当前决定重新预览</button><button :disabled="blocked || !state.previousRevisionId" @click="controller.loadPreviousRows()">读取旧行供人工对应</button></div>
        <p class="hint">批量标记只处理本页无数量/公式问题的新增行，不包含歧义行，也不会立即入库。</p>
        <div v-if="state.previousRevision" class="summary"><p>已读取旧修订 {{ state.previousRevision.revision.sequence }} 的 {{ state.previousRevision.rows.items.length }} 行，可在对应菜单中选择。</p><div class="actions"><button :disabled="blocked || state.previousRevision.rows.offset === 0" @click="controller.loadPreviousRows(Math.max(0, state.previousRevision.rows.offset - pageSize))">上一页旧行</button><button :disabled="blocked || !state.previousRevision.rows.hasMore" @click="controller.loadPreviousRows(state.previousRevision.rows.offset + pageSize)">下一页旧行</button></div></div>
        <ol class="review-rows"><li v-for="row in state.review.rows.items" :key="row.rowIndex">
          <header><div><h4>原行 {{ row.rowIndex }} · {{ collectionModelLabel(row.normalized.descriptor) }}</h4><p>{{ matchLabels[row.match] }} · {{ row.ready ? '本行已满足处理条件' : '本行仍需决定' }}</p></div><span v-if="decisionFor(row.rowIndex)" class="decision">已选 {{ decisionFor(row.rowIndex)?.action === 'new' ? '明确新增' : decisionFor(row.rowIndex)?.action === 'match' ? '对应旧行' : '跳过' }}</span></header>
          <p>总数量 {{ row.normalized.quantity ?? '无有效值' }} · Used {{ row.normalized.used ?? '未提供，保持未分类' }} · 时长 {{ row.normalized.lengthMinutes ?? '未知' }} · IEC {{ row.normalized.descriptor.tapeType }}</p>
          <ul v-if="row.issues.length" class="issues"><li v-for="(issue, index) in row.issues" :key="index">{{ issue.field ? `${fields.find(field => field.id === issue.field)?.label}：` : '' }}{{ issues[issue.code] }}</li></ul>
          <details><summary>查看原资料与候选</summary><p>版次候选：{{ row.normalized.versionCandidate || '未知' }}；年份：{{ row.normalized.descriptor.year ?? '未知' }}</p><p>价格原值：{{ cellText(row.normalized.price) }}（{{ row.normalized.price?.type ?? '未提供' }}）</p><p>购买日期原值：{{ cellText(row.normalized.purchaseDate) }}（{{ row.normalized.purchaseDate?.type ?? '未提供' }}）；日期格式 {{ row.normalized.purchaseDate?.numberFormat ?? '未提供' }}</p><p class="preserve">备注：{{ row.normalized.notes || '未提供' }}</p><p>原行 Hash <code>{{ row.rawRowHash }}</code></p><p>规范化签名 <code>{{ row.normalizedSignature }}</code></p><p v-for="candidate in row.candidates" :key="`${candidate.revisionId}:${candidate.referenceId}`">参考候选 {{ candidate.referenceId }} · {{ candidate.revisionId }}（仅候选）</p><p v-if="!row.candidates.length">没有参考候选，不推断 Missing。</p></details>
          <fieldset :disabled="blocked"><legend>原行 {{ row.rowIndex }} 的明确决定</legend><div class="fields"><label>原行 {{ row.rowIndex }} 处理方式<select v-model="rowActions[row.rowIndex]"><option value="">请选择</option><option value="new">我认定为新增库存</option><option :disabled="!state.previousRevisionId" value="match">对应旧源行，不重新加量</option><option value="skip">本次跳过，不写库存</option></select></label><label v-if="rowActions[row.rowIndex] === 'match'">原行 {{ row.rowIndex }} 对应的旧源行<select v-model="previousRows[row.rowIndex]"><option value="">请选择旧行</option><option v-if="row.previousRowId" :value="row.previousRowId">使用唯一内容对应建议 · {{ row.previousRowId.slice(0, 8) }}</option><option v-for="old in state.previousRevision?.rows.items" :key="old.id" :value="old.id">旧行 {{ old.rowIndex }} · {{ collectionModelLabel(old.normalized.descriptor) }} · 数量 {{ old.normalized.quantity ?? '?' }}</option></select></label></div><label v-if="row.issues.some(issue => issue.code === 'FORMULA_REVIEW_REQUIRED')" class="check"><input v-model="formulaReviewed[row.rowIndex]" type="checkbox">我已核对原数量公式与缓存数值；不会执行公式或猜测缺失缓存</label><div class="actions"><button @click="setDecision(row)">保存本行决定</button><button v-if="decisionFor(row.rowIndex)" @click="controller.removeDecision(row.rowIndex)">清除此行决定</button></div></fieldset>
        </li></ol>
        <p v-if="rowError" class="error" role="alert">{{ rowError }}</p>
        <div class="actions"><button :disabled="blocked || state.review.rows.offset === 0" @click="controller.previewImport(Math.max(0, state.review.rows.offset - pageSize))">上一页源行</button><span>{{ state.review.rows.offset + 1 }}–{{ state.review.rows.offset + state.review.rows.items.length }} / {{ state.review.rows.total }}</span><button :disabled="blocked || !state.review.rows.hasMore" @click="controller.previewImport(state.review.rows.offset + pageSize)">下一页源行</button></div>
        <details v-if="state.review.summary.removedRows"><summary>旧行移除建议（不删除库存）</summary><p v-for="row in state.review.removedRows.items" :key="row.previousRowId">旧行 {{ row.rowIndex }} · {{ row.previousRowId }} · 仅保留建议，不减少实际 Lot</p><p v-if="state.review.removedRows.hasMore">更多移除建议可用下面分页读取，不等于库存删除。</p><div class="actions"><button :disabled="blocked || state.review.removedRows.offset === 0" @click="controller.previewImport(Math.max(0, state.review.removedRows.offset - pageSize))">上一页移除建议</button><button :disabled="blocked || !state.review.removedRows.hasMore" @click="controller.previewImport(state.review.removedRows.offset + pageSize)">下一页移除建议</button></div></details>
        <button class="primary" :disabled="blocked || !state.preview" @click="controller.setStep('apply')">前往批准导入</button>
      </template>
    </section>

    <section v-if="state.step === 'apply'" aria-labelledby="spreadsheet-apply-title"><h3 id="spreadsheet-apply-title">4. 独立批准本次导入</h3><p v-if="!state.preview">请回到核对源行，按当前决定重新预览。</p><template v-else><p>这是整批预览，不只当前页。尚有歧义、无效或未确认行时，Core 会拒绝整批应用，不会部分入库。</p><div class="summary"><p>明确新增数量 <strong>{{ state.preview.summary.newQuantity }}</strong></p><p>旧录音待登记 {{ state.preview.summary.legacyUsed }} · 未分类 {{ state.preview.summary.unclassified }}</p><p>变化行 {{ state.preview.summary.changedRows }} · 移除建议 {{ state.preview.summary.removedRows }}：仅保留建议，不覆盖版次、照片、实体编号或历史。</p><code>{{ state.preview.baselineFingerprint }}</code></div><p>同文件同 Sheet 重导不会增加数量，即使使用新命令；修改后的工作簿必须明确承接旧修订。参考目录仅产生候选。</p><label class="check"><input v-model="applyConfirmed" type="checkbox" :disabled="blocked">我已核对整批源行、Unknown 与对应关系，批准仅明确新增的有效行入库</label><button class="primary" :disabled="blocked || !applyConfirmed" @click="controller.applyImport(applyConfirmed)">批准本次导入</button></template></section>

    <section v-if="state.step === 'history'" aria-labelledby="spreadsheet-history-title">
      <h3 id="spreadsheet-history-title">5. 只读历史与独立数量更正</h3><p>历史保留原始来源、映射、逐行结果和更正前后事实。数量更正单独确认，不覆盖原始 Quantity。</p>
      <div v-if="state.applied" class="summary"><strong>{{ state.applied.duplicate ? '原文件已导入，本次 0 增量' : '导入修订已保存' }}</strong><p>修订 {{ state.applied.revision.sequence }} · {{ state.applied.revision.sheetName }}</p><button :disabled="blocked" @click="controller.loadRevision(state.applied.revision.id)">查看本次持久结果</button></div>
      <div class="actions"><button :disabled="blocked" @click="controller.loadHistory()">刷新导入历史</button><template v-if="state.history && state.history.total > state.history.limit"><button :disabled="blocked || state.history.offset === 0" @click="controller.loadHistory(Math.max(0, state.history.offset - pageSize))">上一页历史</button><button :disabled="blocked || !state.history.hasMore" @click="controller.loadHistory(state.history.offset + pageSize)">下一页历史</button></template></div>
      <p v-if="!state.history">导入历史尚未刷新，请点击“刷新导入历史”读取持久记录。</p>
      <p v-else-if="state.history.total === 0">还没有已应用的导入修订。</p>
      <p v-else-if="!state.history.items.length">当前页没有修订，请返回上一页或刷新历史。</p>
      <ul class="records"><li v-for="revision in state.history?.items" :key="revision.id"><div><strong>{{ revision.sheetName }} · 修订 {{ revision.sequence }}</strong><p>{{ revision.createdAt }} · {{ revision.format === 'dat' ? 'DAT' : 'Cassette' }} · 原新增 {{ revision.summary.newQuantity }} 盘</p><code>{{ revision.workbookHash }}</code></div><button :disabled="blocked" @click="controller.loadRevision(revision.id)">查看修订与源行</button></li></ul>
      <section v-if="state.revision" class="summary"><h4>修订 {{ state.revision.revision.sequence }} 的持久源行</h4><p>来源 <code>{{ state.revision.revision.sourceId }}</code> · 表头行 {{ state.revision.revision.headerRow }} · {{ state.revision.revision.sheetName }}</p><details><summary>原列映射</summary><p v-for="field in fields" :key="field.id">{{ field.label }}：{{ state.revision.revision.columns[field.id] === null ? '未映射' : columnLabel(state.revision.revision.columns[field.id]!) }}</p></details>
        <div class="actions"><button :disabled="blocked" @click="controller.loadSourceRows(0, state.revision.revision.sourceId, state.revision.revision.sheetName)">读取此修订的原始单元格</button><button :disabled="blocked" @click="controller.loadAdjustments()">读取更正历史</button></div>
        <ul class="records"><li v-for="row in state.revision.rows.items" :key="row.id"><div><strong>原行 {{ row.rowIndex }} · {{ collectionModelLabel(row.normalized.descriptor) }}</strong><p>{{ ({ created: '已创建批次', linked: '链接旧行', suggested: '只保存建议', skipped: '已跳过', invalid: '无效' })[row.action] }} · 原 Quantity {{ row.normalized.quantity ?? '未知' }} · 原 Used {{ row.normalized.used ?? '未提供' }}</p><details><summary>来源资料与原值</summary><p>版次候选：{{ row.normalized.versionCandidate || '未知' }}</p><p>价格：{{ cellText(row.normalized.price) }} · 日期：{{ cellText(row.normalized.purchaseDate) }}</p><p class="preserve">备注：{{ row.normalized.notes || '未提供' }}</p><code>{{ row.rawRowHash }}</code></details></div><div class="actions"><button :disabled="blocked || !row.lotId" @click="controller.loadBalance(row.id)">核对本行批次余额</button><button :disabled="blocked" @click="controller.loadAdjustments(row.id)">本行更正记录</button></div></li></ul>
        <div class="actions"><button :disabled="blocked || state.revision.rows.offset === 0" @click="controller.loadRevision(state.revision.revision.id, Math.max(0, state.revision.rows.offset - pageSize))">上一页历史源行</button><button :disabled="blocked || !state.revision.rows.hasMore" @click="controller.loadRevision(state.revision.revision.id, state.revision.rows.offset + pageSize)">下一页历史源行</button></div>
      </section>
      <form v-if="state.balance" class="adjustment" @submit.prevent="controller.adjustInventory(Number(legacyDelta), Number(unclassifiedDelta), adjustmentConfirmed)"><fieldset :disabled="blocked"><legend>独立数量更正</legend><p>绑定原行 <code>{{ state.balance.rowId }}</code> 与实际 Lot <code>{{ state.balance.lotId }}</code></p><p>原始入库 {{ state.balance.quantityAcquired }} · 累计更正 {{ state.balance.quantityAdjustment }} · 已物化 {{ state.balance.materializedCount }}</p><p>本操作只调整剩余旧录音待登记与未分类数量；不消耗已物化、预留或已录实体。</p><div class="fields"><label>Legacy Used 增减量<input v-model.number="legacyDelta" type="number" min="-10000" max="10000" step="1" required><span>当前 {{ state.balance.legacyUsed }} → 更正后 {{ state.balance.legacyUsed + Number(legacyDelta) }}</span></label><label>Unclassified 增减量<input v-model.number="unclassifiedDelta" type="number" min="-10000" max="10000" step="1" required><span>当前 {{ state.balance.unclassified }} → 更正后 {{ state.balance.unclassified + Number(unclassifiedDelta) }}</span></label></div><p>当前余额指纹 <code>{{ state.balance.balanceFingerprint }}</code></p><label class="check"><input v-model="adjustmentConfirmed" type="checkbox">我已核对原行、实际批次与前后余额，确认只记录上述增减量，不重置原库存</label><button class="primary" :disabled="!adjustmentConfirmed" type="submit">确认独立数量更正</button></fieldset></form>
      <section v-if="state.adjustments"><h4>更正记录（只读）</h4><p v-if="!state.adjustments.items.length">没有更正记录。</p><ul class="records"><li v-for="adjustment in state.adjustments.items" :key="adjustment.id"><div><strong>{{ adjustment.createdAt }}</strong><p>源行 <code>{{ adjustment.rowId }}</code></p><p>Legacy Used：{{ adjustment.before.legacyUsed }} → {{ adjustment.after.legacyUsed }}；Unclassified：{{ adjustment.before.unclassified }} → {{ adjustment.after.unclassified }}</p><p>原始入库量 {{ adjustment.before.quantityAcquired }} → {{ adjustment.after.quantityAcquired }}（保持原始事实）</p></div></li></ul><div class="actions"><button :disabled="blocked || state.adjustments.offset === 0" @click="controller.loadAdjustments(state.adjustmentRowId, Math.max(0, state.adjustments.offset - pageSize))">上一页更正</button><button :disabled="blocked || !state.adjustments.hasMore" @click="controller.loadAdjustments(state.adjustmentRowId, state.adjustments.offset + pageSize)">下一页更正</button></div></section>
    </section>

    <details v-if="state.sourceRows" class="raw-data" open><summary>原始单元格（只读，不执行公式）</summary><p>{{ state.sourceRows.items[0]?.sheetName || state.sheetName }} · 来源 <code>{{ state.sourceRows.items[0]?.sourceId }}</code></p><div class="table-wrap" tabindex="0" aria-label="原始工作簿单元格"><table><thead><tr><th>原行</th><th>列与类型</th><th>原值与公式</th></tr></thead><tbody><template v-for="row in state.sourceRows.items" :key="row.rowIndex"><tr v-for="cell in row.cells" :key="`${row.rowIndex}:${cell.columnIndex}`"><td>{{ row.rowIndex }}</td><td>{{ columnLabel(cell.columnIndex) }} · {{ cell.type }}</td><td><span class="preserve">{{ cellText(cell) }}</span><p v-if="cell.formula !== undefined">原公式 <code>{{ cell.formula }}</code>；以上为缓存值</p><p v-if="cell.numberFormat">原格式 {{ cell.numberFormat }}</p><p v-if="cell.displayText !== undefined">原显示文本 {{ cell.displayText }}</p></td></tr></template></tbody></table></div><div class="actions"><button :disabled="blocked || state.sourceRows.offset === 0" @click="controller.loadSourceRows(Math.max(0, state.sourceRows.offset - pageSize), state.sourceRows.items[0]?.sourceId, state.sourceRows.items[0]?.sheetName)">上一页原始单元格</button><button :disabled="blocked || !state.sourceRows.hasMore" @click="controller.loadSourceRows(state.sourceRows.offset + pageSize, state.sourceRows.items[0]?.sourceId, state.sourceRows.items[0]?.sheetName)">下一页原始单元格</button></div></details>
  </dialog>
</template>

<style scoped>
.spreadsheet-dialog { box-sizing: border-box; width: min(980px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); padding: 24px; overflow: auto; color: var(--mb-text-primary); background: var(--mb-bg-base); border: 1px solid var(--mb-glass-border); border-radius: 16px; font-size: 13px; line-height: 1.65; }
.spreadsheet-dialog::backdrop { background: #0009; }
.heading, .records > li, .review-rows > li > header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
h2 { margin: 0; font-size: 23px; letter-spacing: -.025em; } h3 { margin: 22px 0 10px; font-size: 18px; } h4 { margin: 8px 0; font-size: 14px; } p { color: var(--mb-text-secondary); } .kicker { margin: 0 0 6px; color: var(--mb-accent); font-size: 12px; }
button { min-height: 44px; padding: 9px 13px; border: 1px solid var(--mb-glass-border); border-radius: 8px; background: var(--mb-glass-clear); color: var(--mb-text-primary); font: inherit; cursor: pointer; } button:disabled { opacity: .5; cursor: default; } button:hover:not(:disabled), .primary { border-color: var(--mb-accent); }
:where(button, input, select, summary, .table-wrap):focus-visible { outline: 2px solid var(--mb-accent); outline-offset: 3px; }
.steps { display: flex; flex-wrap: wrap; gap: 8px; margin: 18px 0; }.steps button { flex: 1; min-width: 140px; text-align: left; }.steps button[aria-current] { border-color: var(--mb-accent); background: var(--mb-glass-strong); }.steps span { display: inline-flex; justify-content: center; align-items: center; width: 22px; height: 22px; border: 1px solid var(--mb-glass-border); border-radius: 50%; margin-right: 8px; }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 12px 0; } fieldset { min-width: 0; padding: 16px; margin: 16px 0; border: 1px solid var(--mb-glass-border); border-radius: 10px; } legend { padding: 0 6px; color: var(--mb-text-secondary); }.fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 16px; }
label { display: grid; gap: 6px; min-width: 0; margin: 8px 0; } input:not([type='checkbox']), select { box-sizing: border-box; width: 100%; min-width: 0; min-height: 44px; padding: 9px 10px; border: 1px solid var(--mb-glass-border); border-radius: 7px; color: var(--mb-text-primary); background: var(--mb-bg-base); font: inherit; }.check { display: flex; align-items: flex-start; gap: 10px; padding: 8px 0; }.check input { flex: 0 0 auto; margin-top: 5px; accent-color: var(--mb-accent); }
.summary, .feedback, .review-rows > li { padding: 16px; margin: 16px 0; border: 1px solid var(--mb-glass-border); border-radius: 10px; background: var(--mb-glass-clear); }.notice { padding: 8px 0; }.error { padding: 10px 12px; border-left: 3px solid var(--mb-accent); color: var(--mb-text-primary); }.hint { font-size: 12px; }.records, .review-rows { padding: 0; list-style: none; }.records > li { padding: 14px 0; border-bottom: 1px solid var(--mb-divider); }.records > li > div { min-width: 0; }.records p { margin: 5px 0; }.records button { flex-shrink: 0; }.review-rows { margin: 0; }.review-rows > li > header p { margin: 0; }.issues { color: var(--mb-text-secondary); padding-left: 20px; }.decision { color: var(--mb-accent); flex-shrink: 0; }
code { display: inline-block; max-width: 100%; overflow-wrap: anywhere; font-size: 11px; }.preserve { white-space: pre-wrap; overflow-wrap: anywhere; }.metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }.metrics dt { color: var(--mb-text-secondary); font-size: 12px; }.metrics dd { margin: 4px 0; font-size: 22px; font-variant-numeric: tabular-nums; }
details { margin: 16px 0; } summary { min-height: 44px; padding: 8px 0; cursor: pointer; }.table-wrap { overflow: auto; max-height: 400px; } table { border-collapse: collapse; width: 100%; min-width: 500px; text-align: left; } th, td { padding: 10px 8px; border-bottom: 1px solid var(--mb-divider); vertical-align: top; } td:last-child { max-width: 420px; overflow-wrap: anywhere; } .raw-data { padding-top: 12px; border-top: 1px solid var(--mb-divider); }
@media (max-width: 760px) { .spreadsheet-dialog { padding: 18px; }.fields { grid-template-columns: minmax(0, 1fr); }.records > li, .review-rows > li > header { flex-wrap: wrap; }.metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
