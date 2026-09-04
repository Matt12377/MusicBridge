<script setup lang="ts">
import { collectionModelLabel } from './collection-display'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, triggerRef, watch } from 'vue'
import { MAX_CATALOG_REFERENCES, isCanonicalReference, isCatalogMapping, isPreviewCatalogRevisionRequest, type CanonicalReference, type CatalogMatch, type SourcePack } from '@music-bridge/contracts'
import { createReferenceCatalogController, readReferenceSourceFile, readReferenceRevisionFile, type CatalogStep } from './reference-catalog-controller'

const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement>()
const controller = createReferenceCatalogController({ api: window.musicBridge, onChange: () => triggerRef(state) })
const state = shallowRef(controller.state)
const blocked = computed(() => state.value.busy || !!state.value.pendingLabel || fileLoading.value)
const steps: { id: CatalogStep; title: string }[] = [{ id: 'source', title: '资料来源' }, { id: 'revision', title: '整理发布' }, { id: 'review', title: '关联审核' }, { id: 'history', title: '历史快照' }]
const sourceConfirmed = ref(false), publishConfirmed = ref(false), matchConfirmed = ref(false), retryConfirmed = ref(false)
const fileLoading = ref(false), inputError = ref(''), closeRequested = ref(false)
let alive = true
onMounted(() => { dialog.value?.showModal(); void controller.start() })
onBeforeUnmount(() => { alive = false; controller.dispose() })
watch(() => state.value.sourcePreview, () => { sourceConfirmed.value = false })
watch(() => state.value.revisionPreview, () => { publishConfirmed.value = false })
watch(() => state.value.current, () => { matchConfirmed.value = false })

function rawChanged(event: Event): void { controller.setRawPack((event.target as HTMLTextAreaElement).value) }
async function chooseFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement, file = input.files?.[0]
  if (!file || blocked.value || fileLoading.value) return
  fileLoading.value = true; inputError.value = ''
  try { const text = await readReferenceSourceFile(file); if (alive) controller.setRawPack(text) }
  catch { if (alive) inputError.value = '请选择不超过 1 MiB 的有效 UTF-8 JSON 文件。未改写原输入。' }
  finally { if (alive) { fileLoading.value = false; input.value = '' } }
}
function fillSynthetic(): void {
  const pack: SourcePack = { schemaVersion: 1, bookId: 'synthetic-example', title: '合成示例（非书籍资料）', sourceVersion: '示例 1', items: [{ referenceId: 'synthetic-a', bookId: 'synthetic-example', brand: '合成品牌', series: '示例系列', edition: '示例版', model: '示例型号 A', lengths: [60], iec: 'unknown', era: null, image: { kind: 'none' }, pages: ['示例页 1'], notes: '仅用于演示，不是正式书籍数据。', confidence: 'unknown' }] }
  controller.setRawPack(JSON.stringify(pack, null, 2))
}
async function register(): Promise<void> { await controller.registerSource(sourceConfirmed.value) }
async function publish(): Promise<void> { await controller.publishRevision(publishConfirmed.value) }
function requestClose(): void {
  if (state.value.busy || fileLoading.value) return
  if (state.value.rawPack || state.value.items.length || state.value.pendingLabel) closeRequested.value = true
  else emit('close')
}

const editor = ref<CanonicalReference>(), editingId = ref<string>(), lengthsText = ref(''), pagesText = ref('')
const draftError = ref(''), advanced = ref('')
function editItem(item?: CanonicalReference): void {
  if (blocked.value || !state.value.source) return
  editingId.value = item?.referenceId
  editor.value = item ? JSON.parse(JSON.stringify(item)) as CanonicalReference : { referenceId: '', bookId: state.value.source.bookId, brand: '', series: '', edition: '', model: '', lengths: [], iec: 'unknown', era: null, image: { kind: 'none' }, pages: [], notes: '', confidence: 'unknown' }
  lengthsText.value = item?.lengths.join(', ') ?? ''; pagesText.value = item?.pages.join(', ') ?? ''; draftError.value = ''
}
function saveItem(): void {
  if (!editor.value || blocked.value) return
  const value: unknown = { ...JSON.parse(JSON.stringify(editor.value)), lengths: lengthsText.value.split(/[,，]/u).map(n => n.trim()).filter(Boolean).map(Number), pages: pagesText.value.split(/[,，]/u).map(n => n.trim()).filter(Boolean) }
  if (!isCanonicalReference(value)) { draftError.value = '请补全参考 ID、品牌、型号等字段；时长为 1–360 分钟，页码以逗号分隔。'; return }
  if (state.value.items.some(item => item.referenceId === value.referenceId && item.referenceId !== editingId.value)) { draftError.value = '参考 ID 已存在，请使用唯一 ID。'; return }
  controller.setDraft([...state.value.items.filter(item => item.referenceId !== editingId.value), value], state.value.mappings)
  editor.value = undefined; draftError.value = ''
}
function removeItem(id: string): void { controller.setDraft(state.value.items.filter(item => item.referenceId !== id), state.value.mappings.filter(mapping => !mapping.toReferenceIds.includes(id))) }
const fromIds = ref<string[]>([]), toIds = ref<string[]>([])
function addMapping(): void {
  const mapping = { fromReferenceIds: [...fromIds.value], toReferenceIds: [...toIds.value] }
  if (!isCatalogMapping(mapping) || state.value.mappings.some(prior => prior.fromReferenceIds.some(id => fromIds.value.includes(id)) || prior.toReferenceIds.some(id => toIds.value.includes(id)))) { draftError.value = '请选择旧版与新版条目：支持一对一、多合一或一拆多；每个条目只能参与一组映射。'; return }
  controller.setDraft(state.value.items, [...state.value.mappings, mapping]); fromIds.value = []; toIds.value = []; draftError.value = ''
}
function exportDraft(): void { advanced.value = JSON.stringify({ items: state.value.items, mappings: state.value.mappings }, null, 2) }
async function chooseRevisionFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement, file = input.files?.[0]
  if (!file || blocked.value || fileLoading.value || !state.value.source) return
  fileLoading.value = true; draftError.value = ''
  try { const text = await readReferenceRevisionFile(file); if (alive) { advanced.value = text; applyAdvanced() } }
  catch { if (alive) draftError.value = '请选择不超过 4 MiB 的有效 UTF-8 修订 JSON；原目录与库存未改变。' }
  finally { if (alive) { fileLoading.value = false; input.value = '' } }
}
function applyAdvanced(): void {
  try {
    const value: unknown = JSON.parse(advanced.value)
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['items', 'mappings'].includes(key))) throw new Error('INVALID')
    const draft = value as { items?: unknown; mappings?: unknown }
    const request = { sourceId: state.value.source?.id, expectedCurrentRevisionId: state.value.history?.currentRevisionId ?? null, items: draft.items, mappings: draft.mappings }
    if (!isPreviewCatalogRevisionRequest(request)) throw new Error('INVALID')
    controller.setDraft(request.items, request.mappings); draftError.value = ''; editor.value = undefined
  } catch { draftError.value = '高级草案必须包含有效且唯一的 items 与 mappings；原资料未改变。' }
}

const referenceId = ref(''), modelId = ref(''), matchStatus = ref<CatalogMatch['status']>('unmatched'), availability = ref<'missing' | 'unknown'>('unknown'), modelQuery = ref('')
watch([referenceId, modelId, matchStatus, availability], () => { matchConfirmed.value = false })
const selectedMatches = computed(() => state.value.current?.matches.filter(match => match.referenceId === referenceId.value) ?? [])
async function saveMatch(): Promise<void> {
  const match: CatalogMatch = matchStatus.value === 'unmatched'
    ? { referenceId: referenceId.value, modelId: null, status: 'unmatched', availability: availability.value }
    : { referenceId: referenceId.value, modelId: modelId.value, status: matchStatus.value, availability: 'unknown' }
  await controller.saveMatch(match, matchConfirmed.value)
}
const beforeId = ref(''), afterId = ref('')
const countFields = [{ id: 'total', label: '目录条目' }, { id: 'owned', label: '已拥有' }, { id: 'missing', label: '明确缺少' }, { id: 'unknown', label: '未知' }, { id: 'candidate', label: '候选' }, { id: 'needsReview', label: '待复核' }] as const
const statusLabel = (status: CatalogMatch['status']) => ({ confirmed: '已确认关联', candidate: '候选', 'needs-review': '待复核', unmatched: '未匹配' })[status]
</script>

<template>
  <dialog ref="dialog" class="reference-dialog" aria-labelledby="reference-title" @cancel.prevent="requestClose">
    <header class="reference-heading"><div><p class="eyebrow">收藏 · 参考资料</p><h2 id="reference-title">参考目录与版次</h2><p>登记来源、整理版次、审核关联。资料与图片都不等于拥有证据。</p></div><button type="button" :disabled="state.busy || fileLoading" @click="requestClose">关闭</button></header>
    <nav class="steps" aria-label="参考目录步骤"><button v-for="(step, index) in steps" :key="step.id" :aria-current="state.step === step.id ? 'step' : undefined" :disabled="blocked || fileLoading" @click="controller.setStep(step.id)"><span>{{ index + 1 }}</span>{{ step.title }}</button></nav>
    <div v-if="closeRequested" class="feedback" role="alert"><p>关闭会丢弃未保存的本地草案。已登记资料和已发布目录保留；未确认命令仍可从全局入口恢复，不会自动重试。</p><div class="actions"><button @click="closeRequested = false">继续编辑</button><button @click="emit('close')">确认关闭</button></div></div>
    <p v-if="state.busy || fileLoading" role="status">正在处理，请稍候…</p>
    <p v-if="state.error || inputError" class="error" role="alert">{{ inputError || state.error }}</p>
    <p v-if="state.notice" class="notice" role="status">{{ state.notice }}</p>
    <section v-if="state.pendingLabel" class="feedback" aria-label="恢复原操作"><strong>{{ state.pendingLabel }}：等待明确回执</strong><p>不会自动重发。重试使用原命令、原输入和原工作库；关闭后可在全局未确认操作中核对。</p><label class="check"><input v-model="retryConfirmed" type="checkbox" :disabled="state.busy">我已核对，继续恢复原操作，或退出本地重试后重新读取</label><div class="actions"><button :disabled="state.busy || !retryConfirmed" @click="controller.retry(); retryConfirmed = false">重试原操作</button><button :disabled="state.busy || !retryConfirmed" @click="controller.releasePending(true); retryConfirmed = false">退出本地重试</button></div></section>

    <section v-if="state.step === 'source'" aria-labelledby="reference-source-title">
      <h3 id="reference-source-title">1. 登记原资料版本</h3><p>请选择明确提供的结构化 JSON，或粘贴原文。默认不读取书籍、目录或照片。上限 1 MiB / {{ MAX_CATALOG_REFERENCES }} 行。</p>
      <fieldset :disabled="blocked || fileLoading"><legend>结构化资料</legend><label class="file-label">选择 JSON 文件<input type="file" accept=".json,application/json" @change="chooseFile"></label><label>原资料 JSON<textarea :value="state.rawPack" rows="8" spellcheck="false" placeholder="在此粘贴 Source Pack；默认没有书籍数据" @input="rawChanged"></textarea></label><div class="actions"><button @click="controller.previewSource">严格预览原资料</button><button @click="fillSynthetic">填入合成示例（非书籍数据）</button></div></fieldset>
      <div v-if="state.sourcePreview" class="summary"><h4>{{ state.sourcePreview.pack.title }} · {{ state.sourcePreview.pack.sourceVersion }}</h4><p>来源 {{ state.sourcePreview.pack.bookId }} · 原行 {{ state.sourcePreview.pack.items.length }} · 去重条目 {{ state.sourcePreview.items.length }}</p><p>原 UTF-8 SHA-256</p><code>{{ state.sourcePreview.packHash }}</code><ul><li v-for="item in state.sourcePreview.items.slice(0, 10)" :key="item.referenceId">{{ item.brand }} {{ item.model }} · {{ item.edition || '版次未知' }} · 页 {{ item.pages.join('、') || '未知' }}</li></ul><p v-if="state.sourcePreview.items.length > 10">其余条目登记后在整理步骤查看。</p><label class="check"><input v-model="sourceConfirmed" type="checkbox" :disabled="blocked">我确认登记此原资料与 Hash；这不会发布目录或创建库存</label><button class="primary" :disabled="blocked || !sourceConfirmed" @click="register">登记资料版本</button></div>
      <h4>已登记来源</h4><p v-if="!state.sources?.items.length">还没有已登记的资料版本。登记后可从这里继续整理。</p><ul class="source-list"><li v-for="source in state.sources?.items" :key="source.id"><div><strong>{{ source.title }}</strong><p>{{ source.sourceVersion }} · {{ source.itemCount }} 条 · {{ source.createdAt }}</p></div><button :disabled="blocked" @click="controller.selectSource(source.id)">整理此来源</button></li></ul><div class="actions"><button :disabled="blocked" @click="controller.loadSources()">刷新来源</button><template v-if="state.sources && state.sources.total > state.sources.limit"><button :disabled="blocked || state.sources.offset === 0" @click="controller.loadSources(Math.max(0, state.sources.offset - 25))">上一页来源</button><button :disabled="blocked || state.sources.offset + 25 >= state.sources.total" @click="controller.loadSources(state.sources.offset + 25)">下一页来源</button></template></div>
    </section>

    <section v-if="state.step === 'revision'" aria-labelledby="reference-revision-title">
      <h3 id="reference-revision-title">2. 整理并发布目录</h3><p v-if="!state.source">先在资料来源中登记或选择一个版本。</p>
      <template v-else><p><strong>{{ state.source.title }} · {{ state.source.sourceVersion }}</strong> — 原资料始终保留，以下仅修改修订草案。</p><code>{{ state.source.packHash }}</code><div class="actions"><button :disabled="blocked" @click="controller.selectSource(state.source.id); editor = undefined">重新读取来源与当前基线</button><button :disabled="blocked" @click="editItem()">添加整理条目</button></div><p class="hint">重新读取会放弃本地草案。当前基线：{{ state.history?.currentRevisionId ? '已有发布版次' : '无已发布版次或尚未读取' }}。</p>
        <div class="table-wrap" tabindex="0" aria-label="整理后的参考条目"><table><thead><tr><th>参考 ID / 型号</th><th>版次 / 来源页</th><th>参考图</th><th>整理</th></tr></thead><tbody><tr v-for="item in state.items" :key="item.referenceId"><td><strong>{{ item.brand }} {{ item.model }}</strong><small>{{ item.referenceId }} · {{ item.series || '系列未知' }} · {{ item.lengths.join(' / ') || '?' }} min · {{ item.iec }}</small></td><td>{{ item.edition || '版次未知' }}<small>{{ item.pages.join('、') || '页码未知' }}</small></td><td><figure v-if="item.image.kind === 'reference'"><img :src="item.image.image.dataUrl" :alt="`${item.brand} ${item.model} 资料参考图`" loading="lazy"><figcaption>{{ item.image.caption }} · 资料参考，非拥有证据</figcaption></figure><span v-else class="placeholder">无参考图</span></td><td><button :disabled="blocked" @click="editItem(item)">编辑</button><button :disabled="blocked" @click="removeItem(item.referenceId)">从草案移除</button></td></tr></tbody></table></div>
        <form v-if="editor" class="editor" aria-label="编辑参考条目" @submit.prevent="saveItem"><fieldset :disabled="blocked"><legend>{{ editingId ? '编辑整理条目' : '新增整理条目' }}</legend><div class="field-grid"><label>参考 ID<input v-model="editor.referenceId" required maxlength="96"></label><label>品牌<input v-model="editor.brand" required maxlength="120"></label><label>系列<input v-model="editor.series" maxlength="120"></label><label>版次<input v-model="editor.edition" maxlength="120"></label><label>型号<input v-model="editor.model" required maxlength="120"></label><label>时长（逗号分隔，分钟）<input v-model="lengthsText" placeholder="60, 90"></label><label>IEC<select v-model="editor.iec"><option v-for="iec in ['unknown', 'I', 'II', 'III', 'IV', 'dat']" :key="iec" :value="iec">{{ iec === 'unknown' ? '未知' : iec }}</option></select></label><label>年代<input :value="editor.era ?? ''" maxlength="120" @input="editor.era = ($event.target as HTMLInputElement).value || null"></label><label>来源页（逗号分隔）<input v-model="pagesText"></label><label>可信度<select v-model="editor.confidence"><option value="unknown">未知</option><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></label></div><label>备注<input v-model="editor.notes" maxlength="2000"></label><label v-if="editor.image.kind === 'reference'">参考图来源说明<input v-model="editor.image.caption" maxlength="240"></label><div class="actions"><button type="submit">保存到草案</button><button type="button" @click="editor = undefined">取消编辑</button></div></fieldset></form>
        <h4>旧版 → 新版映射</h4><p>多合一保留原确认关联，只计一个目录条目；一拆多须重新复核，不自动成为多条已拥有。未显式映射时不会猜测旧关联。</p><fieldset :disabled="blocked || !state.current"><legend>添加映射</legend><div class="field-grid"><label>旧版条目（可多选）<select v-model="fromIds" multiple size="4"><option v-for="item in state.current?.revision.items" :key="item.referenceId" :value="item.referenceId">{{ item.referenceId }} · {{ item.model }}</option></select></label><label>新版草案条目（可多选）<select v-model="toIds" multiple size="4"><option v-for="item in state.items" :key="item.referenceId" :value="item.referenceId">{{ item.referenceId }} · {{ item.model }}</option></select></label></div><button @click="addMapping">加入映射</button></fieldset><p v-if="!state.current" class="hint">首个版次无需旧版映射。</p><ul><li v-for="(mapping, index) in state.mappings" :key="index">{{ mapping.fromReferenceIds.join(' + ') }} → {{ mapping.toReferenceIds.join(' + ') }} <button :disabled="blocked" @click="controller.setDraft(state.items, state.mappings.filter((_, i) => i !== index))">移除此映射</button></li></ul>
        <label>载入配图修订 JSON（最多 4 MiB）<input type="file" accept=".json,application/json" :disabled="blocked || fileLoading" @change="chooseRevisionFile"></label>
        <p class="hint">仅载入 items 与 mappings 草案，仍需预览和确认发布；不改写原始资料，不增加库存。</p>
        <details><summary>高级修订草案 JSON</summary><p>仅整理草案，不修改 Source Pack 或原 Hash。适合批量编辑与精确映射。</p><button :disabled="blocked || fileLoading" @click="exportDraft">载入当前草案</button><label>items 与 mappings<textarea v-model="advanced" rows="8" :disabled="blocked || fileLoading" spellcheck="false"></textarea></label><button :disabled="blocked || fileLoading" @click="applyAdvanced">校验并应用到草案</button></details>
        <p v-if="draftError" class="error" role="alert">{{ draftError }}</p><button class="primary" :disabled="blocked || !!editor" @click="controller.previewRevision">预览发布影响</button>
        <div v-if="state.revisionPreview" class="summary"><h4>本次发布预览</h4><p>新增 {{ state.revisionPreview.delta.addedReferenceIds.length }} · 移除 {{ state.revisionPreview.delta.removedReferenceIds.length }} · 合并 {{ state.revisionPreview.delta.merged }} · 拆分 {{ state.revisionPreview.delta.split }}</p><dl class="counts"><div v-for="field in countFields" :key="field.id"><dt>{{ field.label }}</dt><dd>{{ state.revisionPreview.counts[field.id] }}</dd></div></dl><details><summary>查看影响的参考 ID</summary><p>新增：{{ state.revisionPreview.delta.addedReferenceIds.join('、') || '无' }}</p><p>移除：{{ state.revisionPreview.delta.removedReferenceIds.join('、') || '无' }}</p></details><label class="check"><input v-model="publishConfirmed" type="checkbox" :disabled="blocked">我已核对映射和影响，确认发布不可变目录修订；库存不增加</label><button class="primary" :disabled="blocked || !publishConfirmed" @click="publish">确认发布目录</button></div>
      </template>
    </section>

    <section v-if="state.step === 'review'" aria-labelledby="reference-review-title"><h3 id="reference-review-title">3. 审核参考目录与库存的关联</h3><p v-if="!state.current">先发布目录，或在资料来源中选择已有版次。</p><template v-else><p>版次 {{ state.current.revision.sequence }} · 审核版本 {{ state.current.matchVersion }}。已拥有必须来自明确确认关联与现存库存；候选和待复核仍属于未知。</p><dl class="counts"><div v-for="field in countFields" :key="field.id"><dt>{{ field.label }}</dt><dd>{{ state.current.currentCounts[field.id] }}</dd></div></dl><p class="hint">以上为当前库存视图。历史快照保留当时数字，不随库存变动重写。</p><button :disabled="blocked" @click="controller.refreshCurrent">刷新当前关联与库存</button><div class="table-wrap" tabindex="0" aria-label="当前目录关联"><table><thead><tr><th>条目</th><th>拥有事实</th><th>关联状态</th></tr></thead><tbody><tr v-for="entry in state.current.currentEntries" :key="entry.referenceId"><td>{{ entry.referenceId }}</td><td>{{ entry.state === 'owned' ? '已拥有' : entry.state === 'missing' ? '明确缺少' : '未知' }} · 库存 {{ entry.stockCount }}</td><td>{{ entry.matches.map(match => statusLabel(match.status)).join('、') || '未匹配' }}</td></tr></tbody></table></div>
      <form @submit.prevent="saveMatch"><fieldset :disabled="blocked"><legend>逐条审核（不录入库存）</legend><label>参考条目<select v-model="referenceId" required><option value="">请选择条目</option><option v-for="item in state.current.revision.items" :key="item.referenceId" :value="item.referenceId">{{ item.referenceId }} · {{ item.brand }} {{ item.model }}</option></select></label><p v-if="selectedMatches.length">当前关联：{{ selectedMatches.map(match => `${statusLabel(match.status)} ${match.modelId || (match.availability === 'missing' ? '明确缺少' : '未知')}`).join('；') }}。保存会整体替换该条目的所有关联，包括合并保留的多个型号。</p><label>审核结论<select v-model="matchStatus"><option value="unmatched">未匹配</option><option value="candidate">候选关联（仍未知）</option><option value="needs-review">待复核（仍未知）</option><option value="confirmed">明确确认关联</option></select></label><label v-if="matchStatus === 'unmatched'">拥有事实<select v-model="availability"><option value="unknown">未知（默认，不推断缺少）</option><option value="missing">明确缺少（我已核对）</option></select></label><template v-else><label>查找已有收藏型号<input v-model="modelQuery" maxlength="120" placeholder="品牌或型号关键词"></label><button type="button" @click="controller.loadModels(modelQuery)">搜索库存型号</button><label>已有收藏型号<select v-model="modelId" required><option value="">请选择已有型号</option><option v-for="model in state.models?.items" :key="model.id" :value="model.id">{{ collectionModelLabel(model) }} · {{ model.edition || '版次未知' }} · 库存 {{ model.counts.total }}</option></select></label><p v-if="!state.models?.items.length">未找到已有型号。此处不会自动创建库存；请先在收藏页核实。</p><div v-if="state.models && state.models.total > state.models.limit" class="actions"><button type="button" :disabled="state.models.offset === 0" @click="controller.loadModels(modelQuery, Math.max(0, state.models.offset - 100))">上一页型号</button><button type="button" :disabled="!state.models.hasMore" @click="controller.loadModels(modelQuery, state.models.offset + 100)">下一页型号</button></div></template><label class="check"><input v-model="matchConfirmed" type="checkbox">我已核对条目与实际收藏，确认替换该条目的关联审核；不改变库存账本</label><button class="primary" :disabled="!matchConfirmed || !referenceId" type="submit">保存关联审核</button></fieldset></form>
    </template></section>

    <section v-if="state.step === 'history'" aria-labelledby="reference-history-title"><h3 id="reference-history-title">4. 历史版次与快照</h3><p>快照为保存当时的分母与拥有事实。以下操作只读，不回滚目录或重新计算旧记录。</p><button :disabled="blocked || !state.source" @click="controller.loadHistory()">读取历史</button><p v-if="!state.history?.revisions.length">选择已登记来源后读取历史；尚未发布时没有快照。</p><ul class="source-list"><li v-for="revision in state.history?.revisions" :key="revision.id"><div><strong>版次 {{ revision.sequence }} · {{ revision.itemCount }} 条</strong><p>{{ revision.createdAt }}</p><code>{{ revision.packHash }}</code></div><button :disabled="blocked" @click="controller.loadHistoricalRevision(revision.id)">查看版次</button></li></ul><div v-if="state.history && state.history.total > state.history.limit" class="actions"><button :disabled="blocked || state.history.offset === 0" @click="controller.loadHistory(Math.max(0, state.history.offset - 25))">上一页历史</button><button :disabled="blocked || state.history.offset + 25 >= state.history.total" @click="controller.loadHistory(state.history.offset + 25)">下一页历史</button></div>
      <details v-if="state.historical" open><summary>版次 {{ state.historical.revision.sequence }} · 只读</summary><p>原 Hash：<code>{{ state.historical.revision.packHash }}</code></p><ul><li v-for="item in state.historical.revision.items" :key="item.referenceId">{{ item.referenceId }} · {{ item.brand }} {{ item.model }} · {{ item.edition || '版次未知' }} · 页 {{ item.pages.join('、') }}</li></ul><p v-for="(mapping, index) in state.historical.revision.mappings" :key="index">{{ mapping.fromReferenceIds.join(' + ') }} → {{ mapping.toReferenceIds.join(' + ') }}</p></details>
      <fieldset :disabled="blocked || !state.history?.snapshots.length"><legend>比较两份持久快照</legend><div class="field-grid"><label>前一快照<select v-model="beforeId"><option value="">请选择快照</option><option v-for="snapshot in state.history?.snapshots" :key="snapshot.id" :value="snapshot.id">{{ snapshot.createdAt }} · 审核 {{ snapshot.matchVersion }} · {{ snapshot.id.slice(0, 8) }}</option></select></label><label>后一快照<select v-model="afterId"><option value="">请选择快照</option><option v-for="snapshot in state.history?.snapshots" :key="snapshot.id" :value="snapshot.id">{{ snapshot.createdAt }} · 审核 {{ snapshot.matchVersion }} · {{ snapshot.id.slice(0, 8) }}</option></select></label></div><button :disabled="!beforeId || !afterId" @click="controller.compareSnapshots(beforeId, afterId)">只读比较快照</button></fieldset><div v-if="state.comparison" class="summary"><table><thead><tr><th>事实</th><th>前</th><th>后</th><th>变化</th></tr></thead><tbody><tr v-for="field in countFields" :key="field.id"><th>{{ field.label }}</th><td>{{ state.comparison.before.counts[field.id] }}</td><td>{{ state.comparison.after.counts[field.id] }}</td><td>{{ state.comparison.after.counts[field.id] - state.comparison.before.counts[field.id] }}</td></tr></tbody></table><p>新增参考：{{ state.comparison.added.join('、') || '无' }}</p><p>移除参考：{{ state.comparison.removed.join('、') || '无' }}</p></div>
    </section>
  </dialog>
</template>

<style scoped>
.reference-dialog { box-sizing: border-box; width: min(980px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); padding: 24px; border: 1px solid var(--mb-glass-border); border-radius: 16px; background: var(--mb-bg-base); color: var(--mb-text-primary); overflow: auto; font-size: 13px; line-height: 1.65; }
.reference-dialog::backdrop { background: #0009; }
.reference-heading, .actions, .source-list li { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.reference-heading { align-items: flex-start; }
h2 { margin: 0; font-size: 23px; letter-spacing: -.025em; } h3 { margin: 22px 0 8px; font-size: 18px; } h4 { margin: 16px 0 8px; font-size: 14px; }
p { color: var(--mb-text-secondary); } .eyebrow { margin: 0 0 6px; color: var(--mb-accent); font-size: 12px; }
button { min-height: 44px; padding: 9px 13px; border: 1px solid var(--mb-glass-border); border-radius: 8px; background: var(--mb-glass-clear); color: var(--mb-text-primary); font: inherit; cursor: pointer; } button:disabled { opacity: .5; cursor: default; } button:hover:not(:disabled) { border-color: var(--mb-accent); } .primary { border-color: var(--mb-accent); }
:where(button, input, select, textarea, summary, .table-wrap):focus-visible { outline: 2px solid var(--mb-accent); outline-offset: 3px; }
.steps { display: flex; gap: 8px; flex-wrap: wrap; margin: 18px 0; }.steps button { flex: 1; min-width: 140px; text-align: left; }.steps button[aria-current] { border-color: var(--mb-accent); background: var(--mb-glass-strong); }.steps span { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border: 1px solid var(--mb-glass-border); border-radius: 50%; margin-right: 8px; }
fieldset { min-width: 0; padding: 16px; margin: 16px 0; border: 1px solid var(--mb-glass-border); border-radius: 10px; } legend { padding: 0 6px; color: var(--mb-text-secondary); }
label { display: grid; gap: 6px; min-width: 0; margin: 10px 0; } input:not([type='checkbox']), select, textarea { box-sizing: border-box; width: 100%; min-width: 0; min-height: 44px; padding: 9px 10px; border: 1px solid var(--mb-glass-border); border-radius: 7px; background: var(--mb-bg-base); color: var(--mb-text-primary); font: inherit; } textarea { resize: vertical; font-family: ui-monospace, monospace; } select[multiple] { min-height: 124px; }
.check { display: flex; align-items: flex-start; gap: 10px; padding: 8px 0; }.check input { flex: 0 0 auto; margin-top: 5px; accent-color: var(--mb-accent); }.field-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 16px; }.actions { justify-content: flex-start; flex-wrap: wrap; margin: 12px 0; }
.summary, .feedback { padding: 16px; margin: 16px 0; border: 1px solid var(--mb-glass-border); border-radius: 10px; background: var(--mb-glass-clear); }.error { color: var(--mb-text-primary); border-left: 3px solid var(--mb-accent); padding: 10px 12px; }.notice { padding: 8px 0; }.hint, small { color: var(--mb-text-secondary); font-size: 12px; } code { display: inline-block; max-width: 100%; overflow-wrap: anywhere; font-size: 11px; } small { display: block; }.source-list { padding: 0; list-style: none; }.source-list li { padding: 14px 0; border-bottom: 1px solid var(--mb-divider); }.source-list li > div { min-width: 0; }.source-list p { margin: 4px 0; }
.table-wrap { overflow-x: auto; margin: 16px 0; } table { border-collapse: collapse; width: 100%; text-align: left; } th, td { padding: 12px 8px; border-bottom: 1px solid var(--mb-divider); vertical-align: top; overflow-wrap: anywhere; } td button { margin: 0 4px 6px 0; } .table-wrap table { min-width: 530px; } figure { margin: 0; max-width: 150px; } figure img { width: 100px; height: 65px; object-fit: contain; } figcaption { font-size: 11px; color: var(--mb-text-secondary); }.placeholder { display: inline-flex; align-items: center; justify-content: center; width: 100px; height: 65px; border: 1px dashed var(--mb-glass-border); color: var(--mb-text-secondary); font-size: 12px; }.counts { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; }.counts dt { color: var(--mb-text-secondary); font-size: 12px; }.counts dd { margin: 5px 0; font-size: 22px; font-variant-numeric: tabular-nums; } details { margin: 18px 0; } summary { min-height: 44px; cursor: pointer; display: list-item; padding: 8px 0; }
@media (max-width: 760px) { .reference-dialog { padding: 18px; }.field-grid { grid-template-columns: minmax(0, 1fr); }.counts { grid-template-columns: repeat(3, minmax(0, 1fr)); }.source-list li { align-items: flex-start; flex-wrap: wrap; }.reference-heading { gap: 8px; } }
</style>
