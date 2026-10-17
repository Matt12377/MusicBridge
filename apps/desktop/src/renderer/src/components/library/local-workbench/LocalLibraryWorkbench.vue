<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { isLocalWorkbenchCommandPayload } from '@music-bridge/contracts'
import SafeArtwork from '../../SafeArtwork.vue'
import LocalAiReview from './LocalAiReview.vue'
import LocalCueSplitReview from './LocalCueSplitReview.vue'
import LocalLyricsReview from './LocalLyricsReview.vue'
import LocalLyricsBatchControl from './LocalLyricsBatchControl.vue'
import type { LocalWorkbenchLyrics } from '../../../composables/application/local-library-workbench/lyrics.js'
import type { LocalWorkbenchLibrary } from '../../../composables/application/local-library-workbench/library.js'
import { localWorkbenchExistingActionLabels, localWorkbenchFieldLabels, localWorkbenchResultLabels, type LocalWorkbenchController } from '../../../composables/application/local-library-workbench/controller.js'
import type { LocalWorkbenchPane, LocalWorkbenchExistingAction, LocalWorkbenchLyricsResultKey, LocalWorkbenchLyricsResultInspection, LocalWorkbenchLibraryResultKey, LocalWorkbenchLibraryResultInspection } from '../../../composables/application/local-library-workbench/types.js'

const props = withDefaults(defineProps<{ model: LocalWorkbenchController; lyrics?: LocalWorkbenchLyrics; workspace?: LocalWorkbenchLibrary; lyricsInspection?: LocalWorkbenchLyricsResultInspection | null; libraryInspection?: LocalWorkbenchLibraryResultInspection | null; presentation?: 'dialog' | 'page'; artworkSourcePresentation?: 'select' | 'original-tabs' }>(), { presentation: 'dialog', artworkSourcePresentation: 'select' })
const emit = defineEmits<{ close: []; 'inspect-lyrics-result': [key: LocalWorkbenchLyricsResultKey]; 'close-lyrics-inspection': []; 'inspect-library-result': [key: LocalWorkbenchLibraryResultKey]; 'close-library-inspection': [] }>()
const dialog = ref<HTMLElement>(), heading = ref<HTMLElement>()
const currentDialog = (): HTMLDialogElement | null => props.presentation === 'dialog' && dialog.value?.tagName === 'DIALOG' ? dialog.value as HTMLDialogElement : null
const artworkQuery = ref(''), artworkSourceId = ref(''), dragging = ref(false), dropError = ref(''), artworkText = ref('')
const selectedWebSource=computed(()=>props.model.artworkSources.value.find(value=>value.id===artworkSourceId.value&&value.kind==='web'))
const sourceSelectable=(source:LocalWorkbenchController['artworkSources']['value'][number])=>source.availability.available||source.kind==='web'&&!!source.webActions&&Object.values(source.webActions).some(value=>value.available)
const originalArtworkSourceTabs = computed(() => {
  const sources = props.model.artworkSources.value
  return [
    { key: 'aggregate', source: sources.find(value => value.id === 'aggregate' && value.kind === 'aggregate'), label: '聚合搜索' },
    { key: 'douban-web', source: sources.find(value => value.id === 'douban-web' && value.kind === 'web'), label: '豆瓣' },
    { key: 'bing-web', source: sources.find(value => value.id === 'bing-web' && value.kind === 'web'), label: 'Bing 图片' },
    { key: 'google-web', source: sources.find(value => value.id === 'google-web' && value.kind === 'web'), label: 'Google 图片' },
  ]
})
const previewPage = ref(0), resultPage = ref(0), pageSize = 100
const pages: readonly { id: LocalWorkbenchPane; label: string }[] = [
  { id: 'overview', label: '专辑信息' }, { id: 'artwork', label: '封面' }, { id: 'ai', label: '智能解析' }, { id: 'cue', label: 'CUE 分轨' }, { id: 'organize', label: '信息与文件整理' }, { id: 'lyrics', label: '歌词' }, { id: 'library', label: '整个音乐库' },
]
const maintenance: readonly LocalWorkbenchExistingAction[] = ['mb-info', 'source-tags', 'source-cover', 'rename', 'move', 'organizer-history', 'finder', 'lyrics']
const libraryActions: readonly LocalWorkbenchExistingAction[] = ['libraries', 'scan-settings', 'ai-settings', 'scan-history', 'scan-refresh']
const plan = computed(() => props.model.plan.value)
const planItems = computed(() => plan.value?.items.slice(previewPage.value * pageSize, (previewPage.value + 1) * pageSize) ?? [])
const activeOperation = computed(() => props.model.resultOperation.value)
const resultItems = computed(() => activeOperation.value ? props.model.resultItems(activeOperation.value) : [])
const visibleResults = computed(() => resultItems.value.slice(resultPage.value * pageSize, (resultPage.value + 1) * pageSize))
const importFormatLabels = computed(() => props.model.artworkImportFormats.value.filter(value => value.availability.available).map(value => value.label).join('、'))
const valueText = (value: string | null) => value === null ? '未提供' : value === '' ? '空值' : value
const operationLabels = { succeeded: '已确认完成', partial: '部分完成', failed: '失败', unknown: '结果未确认', running: '正在处理', cancelled: '已取消' }
const libraryNames = computed(() => Object.fromEntries(props.workspace?.state.value?.libraries.map(value => [value.libraryId, value.label]) ?? []))
const libraryItemStates = { queued: '原项排队中', running: '原项处理中', ready: '已返回待核对', applied: '原回执已应用', review: '待核对', failed: '该项失败', unknown: '原结果未确认', cancelled: '原项已取消' }
const inspectionPhases = { idle: '尚未读取', loading: '正在只读检查原结果', ready: '只读检查已返回，不代表已保存', stale: '原检查已陈旧', error: '原检查尚未确认' }
function localWorkbenchLibraryResultKeyMatches(key: LocalWorkbenchLibraryResultKey, page: LocalWorkbenchLibrary['job']['value'] | undefined, original: LocalWorkbenchLibrary['originalJob']['value'] | undefined): boolean {
  return !!page && !!original && key.jobId === original.payload.commandId && page.jobId === key.jobId
    && key.captureId === original.payload.captureId && page.captureId === key.captureId && page.kind === key.kind
    && key.kind === (original.command === 'library.ai.start' ? 'ai' : 'cue') && page.items.some(item => item.albumId === key.albumId)
}
function sameLocalWorkbenchLibraryResultKey(a: LocalWorkbenchLibraryResultKey, b: LocalWorkbenchLibraryResultKey): boolean {
  return a.jobId === b.jobId && a.captureId === b.captureId && a.kind === b.kind && a.albumId === b.albumId
}
function libraryKey(albumId: string): LocalWorkbenchLibraryResultKey | null {
  const original = props.workspace?.originalJob.value, page = props.workspace?.job.value
  if (!original || !page) return null
  const key = { jobId: original.payload.commandId, captureId: original.payload.captureId, kind: page.kind, albumId }
  return localWorkbenchLibraryResultKeyMatches(key, page, original) ? key : null
}
function inspectLibrary(albumId: string): void { const key = libraryKey(albumId); if (key) emit('inspect-library-result', key) }
const libraryInspectionCurrent = computed(() => !!props.libraryInspection && localWorkbenchLibraryResultKeyMatches(props.libraryInspection.key, props.workspace?.job.value, props.workspace?.originalJob.value))
const inspectedLibraryAlbum = computed(() => { const value = props.libraryInspection; return libraryInspectionCurrent.value && value && value.album?.id === value.key.albumId ? value.album : null })
const inspectedLibraryTrackPage = computed(() => { const value = props.libraryInspection; return libraryInspectionCurrent.value && value && value.trackPage?.albumKey === value.key.albumId ? value.trackPage : null })
function libraryItemTitle(albumId: string): string {
  const key = libraryKey(albumId)
  return key && inspectedLibraryAlbum.value && props.libraryInspection && sameLocalWorkbenchLibraryResultKey(key, props.libraryInspection.key) ? inspectedLibraryAlbum.value.title || albumId : albumId
}
const selectedAiName = computed(() => { const result = props.model.aiResults.value.find(value => value.albumId === props.model.focusedAlbumId.value); return result?.candidates.find(value => value.candidateId === result.selectedCandidateId) ?? null })
const searchNames = computed(() => props.model.focusedAlbum.value?.searchNames ?? null)
const webHostIdentity=computed(()=>props.model.readback.value&&props.model.focusedAlbum.value?JSON.stringify([props.model.readback.value.datasetId,props.model.focusedAlbum.value.capture.albumId,props.model.focusedAlbum.value.capture.readToken]):'')
const queryIdentity = computed(() => { const album = props.model.focusedAlbum.value; return album ? album.album.albumId + ':' + album.capture.readToken : '' })
const copyNotice = ref('')
let unmounted = false
let transferEpoch = 0
// 只沿现有工作台状态记本组件代际，关闭重开或页签/焦点ABA不能复用旧拖入意图。
watch(() => [props.model, props.model.isOpen.value, props.model.action.value, props.model.readback.value, props.model.focusedAlbumId.value], () => { transferEpoch++ }, { flush: 'sync' })
let returnFocus: HTMLElement | null = null
function close(): void { if (props.model.close()) emit('close') }
function changeAlbum(event: Event): void { props.model.focusAlbum((event.target as HTMLSelectElement).value) }
async function importTransfer(transfer: DataTransfer | null, webDrop = false): Promise<void> {
  dragging.value = false; dropError.value = ''
  if (props.model.mutationLocked.value) return
  const files = Array.from(transfer?.files ?? [])
  if (files.length > 1) { dropError.value = '每次请拖入一张图片。'; return }
  const model = props.model, readback = model.readback.value, album = model.focusedAlbum.value
  if (!model.isOpen.value || !readback || !album) return
  const original = { epoch: transferEpoch, datasetId: readback.datasetId, snapshotId: readback.snapshotId,
    albumId: model.focusedAlbumId.value, capture: album.capture, readToken: album.capture.readToken, action: model.action.value }
  const current = () => !unmounted && transferEpoch === original.epoch && props.model === model && model.isOpen.value
    && model.readback.value === readback && model.readback.value.datasetId === original.datasetId && model.readback.value.snapshotId === original.snapshotId
    && model.action.value === original.action && model.focusedAlbumId.value === original.albumId
    && model.focusedAlbum.value?.capture === original.capture && model.focusedAlbum.value.capture.readToken === original.readToken
  // 同次drag/clipboard文本须在第一个await前读取；不能等File读取结束再取受保护的DataTransfer。
  let textReadFailed = false
  const texts = ['text/uri-list', 'text/plain'].map(kind => {
    try { return transfer?.getData(kind) ?? '' }
    catch { textReadFailed = true; return '' }
  })
  let webCaptureId: string | undefined
  if (webDrop && transfer?.types?.includes('application/x-musicbridge-artwork-drag')) {
    try {
      const id = transfer.getData('application/x-musicbridge-artwork-drag')
      if (isLocalWorkbenchCommandPayload('localWorkbench.artwork.import', { datasetId: original.datasetId, capture: original.capture, webCaptureId: id, label: '当前网页拖入的图片' })) webCaptureId = id
    } catch { /* 不能读取原引用时仅保留本次已有bytes或图片地址。 */ }
  }
  const lines = (text: string) => text.split(/\r?\n/u).map(value => value.trim()).filter(value => value && !value.startsWith('#'))
  if (files.length === 0) {
    const values = lines(texts[0] || texts[1] || '')
    if (values.length > 1) { dropError.value = '每次请明确拖入或粘贴一个图片地址。'; return }
    await importSameTransferText(textReadFailed ? '图片地址读取失败，原封面保留。' : '每次请明确拖入或粘贴一个图片地址。')
    return
  }
  async function importSameTransferText(reason: string): Promise<void> {
    if (!current()) return
    for (const text of texts) {
      const values = lines(text)
      if (values.length > 1) { dropError.value = reason; return }
      if (values.length !== 1) continue
      const value = values[0]!
      if (!isLocalWorkbenchCommandPayload('localWorkbench.artwork.import', { datasetId: original.datasetId, capture: original.capture, text: value, label: '用户提供的图片地址' })) continue
      if (value.startsWith('https:')) {
        try { const url = new URL(value); if (url.protocol !== 'https:' || url.username || url.password) continue }
        catch { continue }
      }
      if (current()) await model.lookupArtwork('drop', { text: value, label: '用户提供的图片地址', ...(webCaptureId ? { webCaptureId } : {}) })
      return
    }
    if (webCaptureId && current()) { await model.lookupArtwork('drop', { webCaptureId, label: '当前网页拖入的图片' }); return }
    if (current()) dropError.value = reason
  }
  const file = files[0]!
  const format = model.artworkImportFormats.value.find(value => value.mime === file.type)
  if (!format?.availability.available) { await importSameTransferText(format?.availability.available === false ? format.availability.reason : '此图片格式的归一化资格尚未接入。'); return }
  if (file.size < 1) { await importSameTransferText('请选择不超过 4 MB 的合格图片。'); return }
  if (file.size > 4 * 1024 * 1024) { dropError.value = '请选择不超过 4 MB 的合格图片。'; return }
  let bytes: Uint8Array
  try { bytes = new Uint8Array(await file.arrayBuffer()) }
  catch { await importSameTransferText('拖入图片读取失败，原封面保留。'); return }
  if (bytes.length === 0) { await importSameTransferText('拖入图片读取失败，原封面保留。'); return }
  if (!current()) return
  // bytes已经进入原Main管线后不再尝试URL；失败仍由原controller反馈，不能派第二次导入。
  try { await model.lookupArtwork('drop', { bytes, mime: file.type, label: file.name }) }
  catch { if (current()) dropError.value = '拖入图片读取失败，原封面保留。' }
}
async function drop(event: DragEvent): Promise<void> { event.preventDefault(); await importTransfer(event.dataTransfer, true) }
async function paste(event: ClipboardEvent): Promise<void> { event.preventDefault(); await importTransfer(event.clipboardData) }
async function importText(): Promise<void> { await props.model.lookupArtwork('drop', { text: artworkText.value.trim(), label: '用户明确提供的图片地址' }) }
function appendSearchName(name: { artist: string; title: string } | null): void {
  if (!name || props.model.mutationLocked.value) return
  const combined = [...new Set([artworkQuery.value.trim(), name.artist.trim(), name.title.trim()].filter(Boolean))].join(' ')
  if (combined.length > 256) { copyNotice.value = '组合超过 256 字，请编辑搜索词后再追加。'; return }
  artworkQuery.value = combined
}
async function copyQuery(): Promise<void> {
  const identity = queryIdentity.value, query = artworkQuery.value.trim()
  if (!query) return
  try { await navigator.clipboard.writeText(query); if (!unmounted && identity === queryIdentity.value && query === artworkQuery.value.trim()) copyNotice.value = '搜索词已复制。' }
  catch { if (!unmounted && identity === queryIdentity.value && query === artworkQuery.value.trim()) copyNotice.value = '复制未完成，搜索词保留，可手动选择复制。' }
}
function availabilityReason(action: LocalWorkbenchExistingAction): string {
  const value = props.model.existingAvailability(action)
  return value.available ? '' : value.reason
}
watch(queryIdentity, () => { const value = props.model.focusedAlbum.value; artworkQuery.value = value ? [value.album.artist, value.album.title].filter(Boolean).join(' ') : ''; copyNotice.value = '' }, { immediate: true })
watch(artworkQuery, () => { copyNotice.value = '' })
watch(() => [props.model.artworkSources.value, props.artworkSourcePresentation] as const, ([values, presentation]) => {
  if (presentation === 'original-tabs') {
    const sources = originalArtworkSourceTabs.value.flatMap(tab => tab.source ? [tab.source] : [])
    if (!sources.some(value => value.id === artworkSourceId.value && sourceSelectable(value))) artworkSourceId.value = sources.find(sourceSelectable)?.id ?? ''
    return
  }
  if (!values.some(value => value.id === artworkSourceId.value && sourceSelectable(value))) artworkSourceId.value = values.find(sourceSelectable)?.id ?? ''
}, { immediate: true })
watch(() => plan.value?.planId, () => { previewPage.value = 0; resultPage.value = 0 })
watch(() => activeOperation.value?.request.commandId, () => { resultPage.value = 0 })
watch(() => [props.model.isOpen.value, props.model.leavePrompt.value], ([open, prompt]) => { if (!open && !prompt) currentDialog()?.close() })
onMounted(async () => {
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  if (props.model.isOpen.value || props.model.leavePrompt.value) { const element = currentDialog(); if (element && !element.open) element.show() }
  await nextTick(); heading.value?.focus({ preventScroll: true })
})
onBeforeUnmount(() => { unmounted = true; currentDialog()?.close(); if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true }) })
</script>

<template>
  <component :is="props.presentation === 'page' ? 'section' : 'dialog'" ref="dialog" class="local-library-workbench" :class="{ 'is-page': props.presentation === 'page' }" aria-labelledby="local-workbench-title" aria-describedby="local-workbench-target" tabindex="-1" @cancel.prevent="close">
    <slot name="header" :artwork-query="artworkQuery" :copy-query="copyQuery" :copy-notice="copyNotice">
    <header class="workbench-header">
      <div><p class="workbench-muted">本地音乐 · 整理工作台</p><h2 id="local-workbench-title" ref="heading" tabindex="-1">{{ model.albums.value.length === 0 ? '音乐库整理' : model.albums.value.length === 1 ? model.albums.value[0]?.title || '专辑整理' : '选中专辑的整理' }}</h2></div>
      <button type="button" class="secondary-button" aria-label="关闭本地整理工作台" @click="close">关闭</button>
    </header>
    </slot>
    <p id="local-workbench-target" class="workbench-muted">{{ model.albums.value.length ? '此次明确选择 ' + model.albums.value.length + ' 张专辑。' : '整库任务使用下方明确选择的音乐库。' }}{{ model.phase.value }}。</p>
    <slot name="navigation"><nav class="workbench-navigation" aria-label="专辑整理功能">
      <button v-for="page in pages" :key="page.id" type="button" class="secondary-button" :aria-pressed="model.action.value === page.id" :disabled="model.busy.value" @click="model.setAction(page.id)">{{ page.label }}</button>
    </nav></slot>
    <div v-if="model.albums.value.length > 1 && model.action.value === 'artwork'" class="workbench-controls">
      <label>当前选图专辑<select :value="model.focusedAlbumId.value" :disabled="model.busy.value" @change="changeAlbum"><option v-for="album in model.albums.value" :key="album.albumId" :value="album.albumId">{{ album.artist }} · {{ album.title }}</option></select></label>
    </div>
    <p v-if="model.loading.value" class="workbench-status" role="status">正在读取已保存的专辑事实…</p>
    <p v-if="model.error.value" class="workbench-status is-error" role="alert">{{ model.error.value }}</p>
    <p v-if="model.notice.value" class="workbench-status" role="status">{{ model.notice.value }}</p>
    <button v-if="model.loading.value || model.lookingUp.value || model.previewing.value" type="button" class="secondary-button" @click="model.cancelPreparation()">取消此次读取</button>
    <section v-if="model.unresolvedOperations.value.length" class="workbench-section" aria-label="未确认的原操作">
      <h3>核对原操作</h3>
      <p class="workbench-muted">原操作结果尚未确认。应用请求已保留，查询不会重复应用。</p>
      <div v-for="operation in model.unresolvedOperations.value" :key="operation.request.commandId" class="workbench-controls">
        <span>{{ operation.plan.kind === 'cue' ? '独立分轨' : operation.plan.kind === 'ai' ? '名称建议应用' : '封面保存' }} · {{ operationLabels[operation.state] }}</span>
        <button type="button" class="secondary-button" :disabled="model.busy.value || !model.availability('receipt').available" @click="model.readOriginalReceipt(operation.request.commandId)">查询原回执</button>
        <button v-if="model.availability('cancel-application').available" type="button" class="secondary-button" :disabled="model.cancellingApplication.value" @click="model.cancelApplication(operation.request.commandId)">请求取消原任务</button>
      </div>
    </section>

    <section v-if="model.action.value === 'overview'" class="workbench-section" aria-label="选中专辑的已保存信息">
      <slot name="overview">
      <article v-for="album in model.readback.value?.albums ?? []" :key="album.album.albumId" class="workbench-album-summary">
        <SafeArtwork :src="album.currentArtwork?.previewUrl ?? undefined" :alt="album.album.title" class="roon-artwork workbench-current-artwork" />
        <div><h3>{{ album.album.title || '来源未提供专辑名' }}</h3><p>{{ album.album.artist || '来源未提供艺术家' }} · {{ album.album.trackCount ?? album.album.trackIds.length }} 首已关联曲目</p><p class="workbench-muted">{{ album.currentArtwork?.label || '尚未确认可显示封面' }}</p><p v-if="album.availability !== 'online'" class="workbench-status">来源离线或读取不可用。</p><ul v-if="album.issues.length" class="workbench-issues"><li v-for="issue in album.issues" :key="issue">{{ issue }}</li></ul></div>
      </article>
      <p v-if="!model.readback.value && !model.loading.value" class="workbench-muted">专辑读取服务尚未提供可确认内容。</p>
      <button type="button" class="secondary-button" :disabled="model.busy.value || !model.availability('read').available" @click="model.read()">重新读取专辑信息</button>
      </slot>
    </section>

    <section v-else-if="model.action.value === 'artwork'" class="workbench-section" aria-labelledby="local-workbench-artwork-title">
      <h3 id="local-workbench-artwork-title">封面候选</h3>
      <div class="workbench-artwork-layout"><aside class="workbench-artwork-sidebar">
      <label>iTunes地区（ISO两字母）<input v-model="model.artworkCountry.value" maxlength="2" :disabled="model.mutationLocked.value" aria-label="iTunes搜索地区"></label>
      <ul aria-label="各封面来源结果"><li v-for="source in model.artworkOutcomes.value" :key="source.source">{{ source.source }}<span v-if="source.country"> · {{ source.country }}</span> · {{ source.status === 'failed' ? '失败' : source.status === 'opened' ? '已打开网页' : '已返回' }} · {{ source.candidateCount }} 个候选 · {{ source.previewFailureCount }} 个预览失败<span v-if="source.truncated"> · 来源结果截断</span><p v-if="source.message">{{ source.message }}</p><button type="button" :disabled="model.mutationLocked.value" @click="model.retryArtworkSource(source.source, source.country)">重试此来源</button></li></ul>
      <div class="workbench-album-summary">
        <SafeArtwork :src="model.focusedAlbum.value?.currentArtwork?.previewUrl ?? undefined" alt="当前已保存封面" class="roon-artwork workbench-current-artwork" />
        <div><h4>当前封面</h4><p class="workbench-muted">{{ model.focusedAlbum.value?.currentArtwork?.label || '尚未确认可显示封面' }}</p><p class="workbench-muted">选图只产生候选，预览后再明确保存。</p></div>
      </div>
      <div class="workbench-controls">
        <button type="button" class="secondary-button" :disabled="model.mutationLocked.value || !model.availability('artwork-local').available" @click="model.lookupArtwork('local')">查找本地与内嵌图片</button>
        <button type="button" class="secondary-button" :disabled="model.mutationLocked.value || !model.availability('artwork-file').available" @click="model.lookupArtwork('file')">选择图片文件</button>
      </div>
      <div class="workbench-drop-zone" :class="{ 'is-dragging': dragging }" tabindex="0" aria-label="拖入或粘贴封面" @dragover.prevent="dragging = !model.mutationLocked.value" @dragleave="dragging = false" @drop="drop" @paste="paste">
        <p>拖入一张图片{{ importFormatLabels ? '（' + importFormatLabels + '）' : '' }}</p><p class="workbench-muted">{{ model.availability('artwork-drop').available ? '不超过 4 MB，读取后仍需预览与保存。' : '拖入服务尚未接入，当前封面保留。' }}</p>
      </div>
      <div class="workbench-controls"><label>HTTPS图片地址或图片data URI<input v-model="artworkText" aria-label="明确提供封面图片地址" :disabled="model.mutationLocked.value || !model.availability('artwork-drop').available" maxlength="5592536" autocomplete="off" spellcheck="false"></label><button type="button" :disabled="model.mutationLocked.value || !model.availability('artwork-drop').available || !artworkText.trim()" @click="importText()">读取此图片地址</button></div>
      <p v-for="format in model.artworkImportFormats.value.filter(value => !value.availability.available)" :key="format.mime" class="workbench-muted">{{ format.label }}：{{ !format.availability.available ? format.availability.reason : '' }}</p>
      <p v-if="dropError" class="workbench-status is-error" role="alert">{{ dropError }}</p>
      <form class="workbench-controls" aria-label="按来源搜索封面" @submit.prevent="model.lookupArtwork('search', { query: artworkQuery, sourceId: artworkSourceId })">
        <label>搜索词<input v-model="artworkQuery" aria-label="封面搜索词" maxlength="256" :disabled="model.mutationLocked.value" /></label>
        <button type="button" :disabled="!artworkQuery.trim()" @click="copyQuery()">复制当前搜索词</button><span v-if="copyNotice" role="status">{{ copyNotice }}</span>
        <div v-if="props.artworkSourcePresentation === 'original-tabs'" class="workbench-artwork-source-tabs" role="group" aria-label="封面搜索来源">
          <button v-for="tab in originalArtworkSourceTabs" :key="tab.key" type="button" class="workbench-artwork-source-tab" :aria-pressed="!!tab.source && artworkSourceId === tab.source.id" :disabled="model.mutationLocked.value || !tab.source || !sourceSelectable(tab.source)" :title="!tab.source ? '原来源未接入' : !tab.source.availability.available ? tab.source.availability.reason : undefined" @click="tab.source && (artworkSourceId = tab.source.id)">{{ tab.label }}</button>
        </div>
        <template v-else>
        <label>来源<select v-model="artworkSourceId" :disabled="model.mutationLocked.value"><option value="" disabled>选择可用来源</option><option v-for="source in model.artworkSources.value" :key="source.id" :value="source.id" :disabled="!sourceSelectable(source)">{{ source.label }}{{ sourceSelectable(source) ? '' : ' · 暂不可用' }}</option></select></label>
        </template>
        <button type="submit" class="secondary-button" :disabled="model.mutationLocked.value || !artworkQuery.trim() || !artworkSourceId || !model.availability('artwork-search').available">读取搜索候选</button>
      </form>
      <div v-if="selectedWebSource" class="workbench-controls" aria-label="原网页来源操作">
        <button type="button" :disabled="model.mutationLocked.value || !model.webArtworkAvailability(artworkSourceId,'refresh',artworkQuery).available" @click="model.lookupArtwork('search',{query:artworkQuery,sourceId:artworkSourceId,webAction:'refresh'})">刷新网页</button>
        <button type="button" :disabled="model.mutationLocked.value || !artworkQuery.trim() || !model.webArtworkAvailability(artworkSourceId,'external').available" @click="model.lookupArtwork('search',{query:artworkQuery,sourceId:artworkSourceId,webAction:'external'})">在浏览器中打开</button>
      </div>
      <div v-if="searchNames" class="workbench-review-item" aria-label="名称查询来源">
        <p>原始名称：{{ searchNames.original.artist }} {{ searchNames.original.title }}</p><button type="button" :disabled="model.mutationLocked.value || !(searchNames.original.artist || searchNames.original.title)" @click="appendSearchName(searchNames.original)">将原始名称加入搜索词</button>
        <p>清洗名称：{{ searchNames.cleaned.artist }} {{ searchNames.cleaned.title }}</p><button type="button" :disabled="model.mutationLocked.value || !(searchNames.cleaned.artist || searchNames.cleaned.title)" @click="appendSearchName(searchNames.cleaned)">将清洗名称加入搜索词</button>
      </div>
      <div v-if="selectedAiName" class="workbench-review-item" aria-label="已选择的AI查询名称"><p>已选择的 AI 名称：{{ selectedAiName.artist }} {{ selectedAiName.title }}</p><button type="button" :disabled="model.mutationLocked.value" @click="appendSearchName(selectedAiName)">将明确选择的AI名称加入搜索词</button></div>
      <ul class="workbench-issues"><li v-for="source in model.artworkSources.value.filter(value => !value.availability.available)" :key="source.id">{{ source.label }}：{{ !source.availability.available ? source.availability.reason : '' }}</li></ul>
      <slot name="artwork-search-return" />
      </aside><div class="workbench-artwork-results">
      <div v-if="selectedWebSource" class="workbench-web-host" data-musicbridge-artwork-web-host :data-musicbridge-artwork-web-identity="webHostIdentity" aria-label="当前来源封面网页"><p class="workbench-muted">使用右侧搜索打开当前来源网页，再将图片拖到右侧封面区。</p></div>
      <div class="workbench-artwork-grid">
        <article v-for="candidate in model.visibleArtworkCandidates.value" :key="candidate.candidateId" class="workbench-artwork-candidate" :class="{ 'is-selected': model.selectedArtworkId.value === candidate.candidateId }">
          <SafeArtwork :src="candidate.previewUrl ?? undefined" :alt="candidate.label" class="roon-artwork workbench-candidate-image" />
          <h4>{{ candidate.label }}</h4><p class="workbench-muted">{{ candidate.sourceLabel }} · {{ candidate.width }} × {{ candidate.height }}</p><p class="workbench-muted">{{ candidate.licenseLabel }}</p><p v-if="candidate.reason" class="workbench-muted">{{ candidate.reason }}</p>
          <div class="workbench-controls"><button type="button" class="secondary-button" :aria-pressed="model.selectedArtworkId.value === candidate.candidateId" :disabled="model.mutationLocked.value" @click="model.selectArtwork(candidate.candidateId)">选择候选</button><button type="button" class="secondary-button" :aria-pressed="model.comparisonIds.value.includes(candidate.candidateId)" :disabled="model.busy.value" @click="model.toggleComparison(candidate.candidateId)">比较</button></div>
        </article>
      </div>
      <p v-if="!model.visibleArtworkCandidates.value.length" class="workbench-muted">尚未读取可比较的候选。</p>
      <div v-if="model.comparisonCandidates.value.length" class="workbench-comparison" aria-label="封面候选比较">
        <figure v-for="candidate in model.comparisonCandidates.value" :key="candidate.candidateId"><SafeArtwork :src="candidate.previewUrl ?? undefined" :alt="candidate.label" class="roon-artwork workbench-comparison-image" /><figcaption>{{ candidate.label }} · {{ candidate.width }} × {{ candidate.height }}<br />{{ candidate.sourceLabel }}</figcaption></figure>
      </div>
      </div></div>
      <button type="button" class="secondary-button" :disabled="model.mutationLocked.value || !model.selectedArtwork.value || !model.availability('artwork-preview').available" @click="model.previewArtwork()">预览保存此候选</button>
      <button v-if="model.selectedArtworkId.value" type="button" class="secondary-button" :disabled="!model.canRevokeArtwork.value" @click="model.revokeArtwork()">撤销待保存封面</button>
      <p v-if="!model.availability('artwork-preview').available" class="workbench-muted">封面保存计划尚未接入，当前封面保留。</p>
    </section>

    <LocalAiReview v-else-if="model.action.value === 'ai'" :model="model" />
    <LocalCueSplitReview v-else-if="model.action.value === 'cue'" :model="model" :workspace="workspace" />
    <section v-else-if="model.action.value === 'organize'" class="workbench-section" aria-label="已有信息与源文件维护">
      <h3>信息与文件整理</h3>
      <p class="workbench-muted">选择对应维护流程，先查看精确范围和变化，再使用原计划的保存按钮。</p>
      <div class="workbench-maintenance-grid">
        <div v-for="item in maintenance" :key="item" class="workbench-review-item"><button type="button" class="secondary-button" :disabled="model.mutationLocked.value || !model.existingAvailability(item).available" @click="model.openExisting(item)">{{ localWorkbenchExistingActionLabels[item] }}</button><p class="workbench-muted">{{ availabilityReason(item) }}</p></div>
      </div>
    </section>

    <section v-if="plan" class="workbench-section workbench-preview" aria-label="明确应用前的计划预览">
      <h3>{{ plan.kind === 'cue' ? '独立分轨计划' : plan.kind === 'ai' ? '名称建议应用预览' : '封面保存预览' }}</h3>
      <p class="workbench-muted">{{ plan.albumIds.length }} 张明确选择的专辑 · {{ plan.items.length }} 项变化。</p>
      <p v-if="plan.kind === 'artwork' && plan.relationship === 'create-on-apply'" class="workbench-status">保存时将为本次核对的成员建立专辑关联；候选读取期间尚未建立。</p>
      <p v-if="plan.kind !== 'cue'" class="workbench-muted">保存到 MB；源音频、标签与图片保留。</p>
      <ul v-if="plan.blockers.length" class="workbench-issues is-error"><li v-for="issue in plan.blockers" :key="issue">{{ issue }}</li></ul>
      <div v-if="plan.kind !== 'cue'" class="workbench-table-scroll"><table><thead><tr><th scope="col">项目</th><th scope="col">字段变化与理由</th></tr></thead><tbody><tr v-for="item in planItems" :key="item.itemId"><td>{{ item.label }}</td><td><p v-if="!item.changes.length" class="workbench-muted">封面选择与专辑关联按此计划保存。</p><p v-for="change in item.changes" :key="change.field">{{ localWorkbenchFieldLabels[change.field] }}：{{ valueText(change.before) }} → {{ valueText(change.after) }}<br /><span class="workbench-muted">{{ change.reason }}</span></p></td></tr></tbody></table></div>
      <nav v-if="plan.kind !== 'cue' && plan.items.length > pageSize" class="workbench-controls" aria-label="计划预览分页"><button type="button" class="secondary-button" :disabled="previewPage === 0" @click="previewPage--">上一页</button><span>{{ previewPage + 1 }} / {{ Math.ceil(plan.items.length / pageSize) }}</span><button type="button" class="secondary-button" :disabled="(previewPage + 1) * pageSize >= plan.items.length" @click="previewPage++">下一页</button></nav>
      <button type="button" class="primary-button" :disabled="!model.canApply.value" @click="model.applyPreview()">{{ model.applying.value ? '正在应用…' : plan.kind === 'cue' ? '明确生成独立分轨文件' : '明确保存到 MB' }}</button>
    </section>
    <section v-if="activeOperation" class="workbench-section" aria-label="原回执逐项结果">
      <h3>逐项结果 · {{ operationLabels[activeOperation.state] }}</h3>
      <p v-if="activeOperation.receipt?.message" class="workbench-status">{{ activeOperation.receipt.message }}</p>
      <div class="workbench-table-scroll"><table><thead><tr><th scope="col">项目</th><th scope="col">结果</th><th scope="col">说明</th></tr></thead><tbody><tr v-for="item in visibleResults" :key="item.itemId"><td>{{ item.label }}</td><td>{{ localWorkbenchResultLabels[item.state] }}</td><td>{{ item.message || '原回执未提供额外说明。' }}</td></tr></tbody></table></div>
      <nav v-if="resultItems.length > pageSize" class="workbench-controls" aria-label="逐项结果分页"><button type="button" class="secondary-button" :disabled="resultPage === 0" @click="resultPage--">上一页</button><span>{{ resultPage + 1 }} / {{ Math.ceil(resultItems.length / pageSize) }}</span><button type="button" class="secondary-button" :disabled="(resultPage + 1) * pageSize >= resultItems.length" @click="resultPage++">下一页</button></nav>
    </section>

    <details class="workbench-section"><summary>音乐库与解析设置</summary>
      <p v-if="model.readback.value?.settings" class="workbench-muted">已保存扫描并发：{{ model.readback.value.settings.scanConcurrency }}；解析后端：{{ model.readback.value.settings.aiBackend }}；模型：{{ model.readback.value.settings.aiModelLabel }}</p>
      <p v-else class="workbench-muted">配置读取暂不可用。</p>
      <div class="workbench-maintenance-grid"><div v-for="item in libraryActions" :key="item"><button type="button" class="secondary-button" :disabled="model.mutationLocked.value || !model.existingAvailability(item).available" @click="model.openExisting(item)">{{ localWorkbenchExistingActionLabels[item] }}</button><p class="workbench-muted">{{ availabilityReason(item) }}</p></div></div>
    </details>
    <template v-if="model.action.value === 'lyrics' && props.lyrics"><slot name="lyrics"><LocalLyricsReview :model="props.lyrics" /></slot></template>
    <section v-if="model.action.value === 'library'" aria-label="完整音乐库工作台"><slot name="library" /><LocalLyricsBatchControl v-if="props.lyrics" :model="props.lyrics" :library-names="libraryNames" :inspection="props.lyricsInspection" @inspect="emit('inspect-lyrics-result', $event)" @close-inspection="emit('close-lyrics-inspection')" /></section>
    <section v-if="workspace?.originalJob.value" class="workbench-section" aria-label="原全库名称与分轨任务">
      <h3>{{ workspace.originalJob.value.command === 'library.cue.start' ? '全库分轨任务' : '全库名称解析任务' }}</h3>
      <p v-if="workspace.job.value">{{ workspace.job.value.state }} · {{ workspace.job.value.processedAlbums }} / {{ workspace.job.value.totalAlbums }} 张 · 成功 {{ workspace.job.value.succeededAlbums }} · 失败 {{ workspace.job.value.failedAlbums }}</p>
      <button type="button" :disabled="workspace.writing.value" @click="workspace.jobAction('read')">查询原全库任务</button>
      <button v-if="workspace.job.value?.state === 'running' || workspace.job.value?.state === 'queued'" type="button" :disabled="workspace.writing.value" @click="workspace.jobAction('stop')">停止全库任务并释放资源</button>
      <button v-if="workspace.job.value?.state === 'stopped'" type="button" :disabled="workspace.writing.value" @click="workspace.jobAction('resume')">恢复原全库任务</button>
      <button v-if="workspace.job.value?.failedAlbums" type="button" :disabled="workspace.locked.value" @click="workspace.retryAllFailed()">核对全批次并只恢复失败专辑</button>
      <button v-if="workspace.job.value?.state === 'complete'" type="button" :disabled="workspace.locked.value" @click="workspace.newBatch()">准备下一次明确全库任务</button>
      <ul><li v-for="item in workspace.job.value?.items ?? []" :key="item.albumId" class="workbench-result-row">{{ libraryItemTitle(item.albumId) }} · {{ libraryItemStates[item.state] }}<span v-if="item.message"> · {{ item.message }}</span> <button type="button" class="secondary-button workbench-result-button" :aria-label="`查看原${workspace.job.value?.kind === 'cue' ? 'CUE分轨' : '名称解析'}任务项目 ${item.albumId}`" :disabled="!libraryKey(item.albumId)" @click="inspectLibrary(item.albumId)">查看原任务项目</button></li></ul>
      <nav v-if="workspace.job.value" aria-label="全库任务逐项回执分页"><button type="button" :disabled="workspace.writing.value || workspace.jobOffset.value === 0" @click="workspace.jobAction('read', Math.max(0, workspace.jobOffset.value - 200))">上一页</button><span>从第 {{ workspace.jobOffset.value + 1 }} 张开始</span><button type="button" :disabled="workspace.writing.value || workspace.jobOffset.value + 200 >= workspace.job.value.totalAlbums" @click="workspace.jobAction('read', workspace.jobOffset.value + 200)">下一页</button></nav>
    </section>
    <section v-if="props.libraryInspection" class="workbench-section" aria-label="原名称与分轨逐项只读检查">
      <h3>{{ inspectedLibraryAlbum?.title || props.libraryInspection.key.albumId }}</h3>
      <p>{{ props.libraryInspection.key.jobId }} · {{ props.libraryInspection.key.kind === 'cue' ? '原CUE分轨任务' : '原名称解析任务' }}</p>
      <p role="status">{{ libraryInspectionCurrent ? inspectionPhases[props.libraryInspection.phase] : inspectionPhases.stale }}</p>
      <p v-if="props.libraryInspection.error" role="alert">{{ props.libraryInspection.error }}</p>
      <p v-if="inspectedLibraryAlbum">{{ inspectedLibraryAlbum.artists.join(' / ') }} · {{ inspectedLibraryAlbum.trackCount }} 首来源曲目</p>
      <p v-if="libraryInspectionCurrent && props.libraryInspection.capture?.albumId === props.libraryInspection.key.albumId">已取得作者的原只读捕获引用。</p>
      <template v-if="inspectedLibraryTrackPage"><p>这里只显示已读取的曲目页：{{ inspectedLibraryTrackPage.items.length }} / {{ inspectedLibraryTrackPage.total }} 首。</p><ul><li v-for="track in inspectedLibraryTrackPage.items" :key="track.facts.track.id">{{ track.facts.metadata.effective.title || track.facts.track.id }}</li></ul></template>
      <button type="button" class="secondary-button workbench-result-button" @click="emit('close-library-inspection')">关闭原任务项目检查</button>
    </section>
    <section v-if="model.leavePrompt.value" class="workbench-leave-gate" role="alertdialog" aria-label="保存或继续编辑" aria-modal="true">
      <h3>还有未保存或未确认的内容</h3><p>封面先保存，再核对同一目标的歌词。写入正在进行或结果UNKNOWN时不能丢弃。</p>
      <button type="button" :disabled="model.leaveLocked.value" @click="model.saveBeforeLeave()">保存并离开</button>
      <button type="button" :disabled="model.leaveLocked.value" @click="model.discardBeforeLeave()">丢弃待保存选择并离开</button>
      <button type="button" @click="model.continueEditing()">继续编辑</button>
    </section>
    <slot name="footer"><footer class="workbench-footer"><p class="workbench-muted">待保存封面和歌词共用离开门禁；已派发任务始终核对原回执。</p><button v-if="model.hasPendingChanges.value" type="button" class="primary-button" :disabled="model.leaveLocked.value" @click="model.savePending()">保存封面与歌词</button><button type="button" class="secondary-button" @click="close">返回专辑浏览</button></footer></slot>
  </component>
</template>

<style src="./workbench.css"></style>
<style scoped>
.workbench-web-host { width:100%; height:480px; min-height:320px; margin-bottom:16px; overflow:hidden; border:1px solid var(--border-color); border-radius:12px; background:var(--surface-panel); }
.workbench-web-host > p { padding:20px; }
.workbench-section .workbench-result-button { min-height: 44px; }
.workbench-result-row { overflow-wrap: anywhere; }
.workbench-artwork-source-tabs { display:flex; flex:1 0 100%; gap:16px; box-sizing:border-box; min-width:0; max-width:100%; padding:4px 2px; overflow-x:auto; }
.workbench-artwork-source-tab { flex:none; min-height:34px; padding:8px 0; border:0; border-bottom:2px solid transparent; border-radius:0; color:var(--mb-text-secondary); background:transparent; font:inherit; font-size:13px; white-space:nowrap; cursor:pointer; }
.workbench-artwork-source-tab[aria-pressed='true'] { border-bottom-color:var(--mb-accent); color:var(--mb-accent); }
.workbench-artwork-layout,.workbench-artwork-sidebar,.workbench-artwork-results { display:contents; }
.local-library-workbench.is-page .workbench-artwork-layout { display:grid; grid-template-columns:minmax(0,1fr) 320px; gap:20px; align-items:start; }
.local-library-workbench.is-page .workbench-artwork-sidebar { display:block; grid-column:2; grid-row:1; min-width:0; }
.local-library-workbench.is-page .workbench-artwork-results { display:block; grid-column:1; grid-row:1; min-width:0; }
@media (max-width:760px) { .local-library-workbench.is-page .workbench-artwork-layout { grid-template-columns:minmax(0,1fr); } .local-library-workbench.is-page .workbench-artwork-sidebar { grid-column:1; grid-row:1; } .local-library-workbench.is-page .workbench-artwork-results { grid-column:1; grid-row:2; } }
.local-library-workbench.is-page { position: static; inset: auto; width: 100%; max-width: none; max-height: none; margin: 0; padding: 0; overflow: visible; border: 0; border-radius: 0; box-shadow: none; background: transparent; color: inherit; }
</style>
