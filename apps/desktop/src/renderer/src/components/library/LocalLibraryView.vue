<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import type { PlaybackSnapshot, TrackSummary } from '@music-bridge/contracts'
import type { useLocalLibrary } from '../../composables/application/useLocalLibrary.js'
import TrackTable from '../media/TrackTable.vue'
import LocalArtworkDialog from './LocalArtworkDialog.vue'
import LocalOrganizerDialog from './LocalOrganizerDialog.vue'
import SafeArtwork from '../SafeArtwork.vue'
import LocalLibrarySettings from '../settings/LocalLibrarySettings.vue'
import { localLibraryPlaybackStatus, mbQueueOwnershipStatus } from '../player/details.js'

const props = defineProps<{ session: ReturnType<typeof useLocalLibrary>; playbackState: PlaybackSnapshot | null }>()
const emit = defineEmits<{ 'open-queue': []; 'open-outbox': [] }>()
const model = reactive(props.session), queryDraft = ref(model.query), rootDraft = ref(model.rootId ?? '')
const SourceWritesDialog = props.session.sourceWrites?.capable ? defineAsyncComponent(() => import('./LocalSourceWritesDialog.vue')) : null
const RelocationDialog = props.session.relocationPlans?.capable ? defineAsyncComponent(() => import('./LocalRelocationDialog.vue')) : null
const detailHeading = ref<HTMLElement | null>(null), searchInput = ref<HTMLInputElement | null>(null), trackList = ref<HTMLElement | null>(null)
let detailTrigger: HTMLElement | null = null
let focusGeneration = 0
const playbackStatus = computed(() => localLibraryPlaybackStatus(props.playbackState, model.lastPlay))
const queueOwnership = computed(() => mbQueueOwnershipStatus(props.playbackState))
const metadataFields = [{ key: 'title', label: '标题' }, { key: 'artist', label: '艺术家' }, { key: 'album', label: '专辑' }, { key: 'year', label: '年份' }, { key: 'disc', label: '碟号' }, { key: 'track', label: '曲序' }] as const
const rootAvailability = { ONLINE: '目录可读取', SOURCE_ROOT_OFFLINE: '源目录离线', REVOKED: '目录许可已撤销' }
const tokenSource = { title: '标题', artist: '艺术家', album: '专辑', albumArtist: '专辑艺术家', directory: '目录' }

function search(): void { void model.search(queryDraft.value, rootDraft.value || null) }
function openOrganizerTrack(): void {
  const current = model.detail
  if (current) void props.session.organizer.open({ mode: 'single', trackId: current.track.id }, current.metadata.effective.title ?? '当前曲目', current.editions, current.metadata.effective, current.metadata.override?.annotations)
}
function openOrganizerEdition(editionId: string): void {
  const current = model.detail, edition = current?.editions.find(value => value.id === editionId)
  if (current && edition) void props.session.organizer.open({ mode: 'edition', editionId }, `${edition.title}${edition.edition ? ` · ${edition.edition}` : ''} · 发行 ${edition.id.slice(-8)}`, current.editions)
}
function openOrganizerBatch(): void {
  if (model.selectedTrackIds.length) void props.session.organizer.open({ mode: 'batch', trackIds: [...model.selectedTrackIds] }, `明确选择的 ${model.selectedTrackIds.length} 首`, model.detail?.editions ?? [])
}
function organizerReturnFocus(): void { (detailHeading.value ?? searchInput.value)?.focus({ preventScroll: true }) }
function openSourceTrack(): void { const current = model.detail; if (current) void props.session.sourceWrites.open({ mode: 'single', trackId: current.track.id }, current.metadata.effective.title ?? '当前曲目') }
function openSourceEdition(editionId: string): void { const edition = model.detail?.editions.find(value => value.id === editionId); if (edition) void props.session.sourceWrites.open({ mode: 'edition', editionId }, `${edition.title} · 发行 ${edition.id.slice(-8)}`) }
function openSourceBatch(): void { if (model.selectedTrackIds.length) void props.session.sourceWrites.open({ mode: 'batch', trackIds: [...model.selectedTrackIds] }, `明确选择的 ${model.selectedTrackIds.length} 首`) }
function sourceFromOrganizer(): void {
  const current = props.session.organizer.target.value
  if (current) void props.session.sourceWrites.open(current, props.session.organizer.targetLabel.value, 'TAGS')
}
function sourceFromArtwork(): void {
  const current = props.session.artwork.target.value, selection = props.session.artwork.context.value?.selection
  if (!current || !selection?.candidate) return
  void props.session.sourceWrites.open({ mode: 'single', trackId: current.trackId }, '当前曲目已保存的 MB 封面', 'EMBEDDED_COVER', current.editionId)
}
function openMBOnly(): void {
  const current = props.session.sourceWrites.target.value, detail = model.detail
  if (!current) return
  if (props.session.sourceWrites.range.value !== 'TAGS') {
    const chosenEdition = props.session.sourceWrites.editionId.value
    const exactTrackId = current.mode === 'single' ? current.trackId : detail && detail.editions.some(edition => edition.id === chosenEdition) && (current.mode === 'batch' ? current.trackIds.includes(detail.track.id) : current.editionId === chosenEdition) ? detail.track.id : null
    if (exactTrackId) { void props.session.artwork.open(exactTrackId, chosenEdition || null); return }
  }
  const exactDetail = current.mode === 'single' && detail?.track.id === current.trackId ? detail : null
  void props.session.organizer.open(current, props.session.sourceWrites.targetLabel.value, detail?.editions ?? [], exactDetail?.metadata.effective, exactDetail?.metadata.override?.annotations)
}
function reacquireSourceArtwork(): void {
  const current = model.detail, requested = props.session.sourceWrites.editionId.value
  if (!current || requested && !current.editions.some(edition => edition.id === requested)) { props.session.sourceWrites.error.value = '请从此具体发行的曲目详情进入原选图入口，保存 MB 封面后重新读取材料。'; return }
  props.session.sourceWrites.close(); void props.session.artwork.open(current.track.id, requested || null)
}
function openDetail(track: TrackSummary, event?: Event): void {
  focusGeneration++; detailTrigger = event?.currentTarget as HTMLElement | null
  const entry = model.rangeWindow.entries.find(value => value.track.id === track.id)
  model.detailReturnTarget = entry ? { trackId: track.id, index: entry.index, scrollTop: model.scrollTop, query: model.query, rootId: model.rootId } : null
  void model.selectTrack(track.id)
}
function closeDetail(): void {
  const origin = model.detailReturnTarget, generation = ++focusGeneration
  model.closeDetail()
  void (async () => {
    await nextTick()
    if (generation !== focusGeneration) return
    if (detailTrigger?.isConnected) { detailTrigger.focus({ preventScroll: true }); return }
    if (origin && origin.query === model.query && origin.rootId === model.rootId) {
      model.scrollTop = origin.scrollTop
      await model.ensureRange(origin.index, origin.index + 1); await nextTick()
      if (generation !== focusGeneration) return
      const trigger = trackList.value?.querySelector<HTMLButtonElement>(`[data-local-detail-track="${origin.trackId}"]`)
      if (trigger) { trigger.focus({ preventScroll: true }); return }
    }
    searchInput.value?.focus({ preventScroll: true })
  })()
}
watch(() => model.selectedId, id => { if (id) void nextTick(() => { if (model.selectedId === id) detailHeading.value?.focus({ preventScroll: true }) }) })
onMounted(() => { void model.activate(); if (model.selectedId) void nextTick(() => detailHeading.value?.focus({ preventScroll: true })) })
onUnmounted(() => { focusGeneration++; model.suspend() })
</script>

<template>
  <section class="view local-library-view" aria-labelledby="local-library-heading" data-testid="local-library-view">
    <header class="local-library-heading"><div><p class="section-kicker">本地数字音乐</p><h1 id="local-library-heading">本地音乐</h1><p>浏览已加入的文件与版本，原文件直送所选 Roon 播放目标。</p></div><button type="button" @click="emit('open-queue')">打开原播放队列</button></header>
    <div class="local-target" aria-live="polite"><strong>播放目标：{{ model.targetLabel }}</strong><span v-if="model.target">Roon Core {{ model.target.core_id }} · Zone {{ model.target.zone_id }}</span><span>当前观察：{{ playbackStatus.state }} · {{ playbackStatus.delivery }}</span><span>{{ playbackStatus.request }}</span><button v-if="model.canReadOriginalPlay" type="button" :disabled="model.actionBusy" @click="model.readOriginalPlay()">核对原点播</button><p v-if="queueOwnership">{{ queueOwnership }}</p></div>
    <details class="local-library-management"><summary>目录与扫描管理</summary><LocalLibrarySettings :management-only="true" @updated="model.refresh()" /></details>
    <form class="local-library-search" role="search" aria-label="搜索本地音乐" @submit.prevent="search">
      <label for="local-library-query">搜索曲目、艺术家、专辑与已有版本</label>
      <div class="local-search-controls"><input id="local-library-query" ref="searchInput" v-model="queryDraft" type="search" autocomplete="off" placeholder="保留版本信息的名称" aria-describedby="local-library-query-hint"><label class="local-root-filter"><span>目录</span><select v-model="rootDraft" aria-label="搜索目录"><option value="">全部已加入目录</option><option v-for="root in model.roots" :key="root.root.id" :value="root.root.id">{{ root.label }} · {{ rootAvailability[root.availability] }}</option></select></label><button type="submit">搜索</button><button type="button" @click="model.refresh()">刷新</button></div>
      <p id="local-library-query-hint" class="local-note">最多 256 个字符，匹配原始与显示名称。每页读取 100 首，滚动时按需加载。</p>
    </form>
    <div class="local-organizer-toolbar" aria-label="本地信息整理"><button type="button" :aria-pressed="model.selectionMode" @click="model.selectionMode = !model.selectionMode">{{ model.selectionMode ? '结束选择' : '选择曲目' }}</button><span aria-live="polite">已选 {{ model.selectedTrackIds.length }} / 100 首</span><button type="button" :disabled="!model.selectedTrackIds.length" @click="openOrganizerBatch">整理已选曲目</button><button type="button" :disabled="!model.selectedTrackIds.length" @click="model.clearTrackSelection()">清空选择</button><button type="button" @click="props.session.organizer.openHistory()">整理历史</button></div>
    <div class="local-detail-actions" aria-label="具体源文件写入入口"><button type="button" :disabled="!model.selectedTrackIds.length || !props.session.sourceWrites?.capable" @click="openSourceBatch">预览已选曲目源写</button><button type="button" :disabled="!props.session.sourceWrites?.capable" @click="props.session.sourceWrites.openHistory()">源写历史与恢复</button><span v-if="!props.session.sourceWrites?.capable" class="local-note">源写服务尚未就绪；原信息整理与选图继续可用。</span></div>
    <div class="local-detail-actions" aria-label="具体文件搬迁入口"><button type="button" :disabled="model.actionBusy || !model.selectedTrackIds.length || !props.session.relocationPlans?.capable" @click="model.openRelocationBatch()">预览已选曲目文件搬迁</button><button type="button" :disabled="!props.session.relocationPlans?.capable" @click="props.session.relocationPlans.openHistory()">搬迁历史与恢复</button><span v-if="!props.session.relocationPlans?.capable" class="local-note">文件搬迁服务尚未就绪；原播放与外部找回继续可用。</span></div>
    <p v-if="model.selectionMode" class="local-note">按曲目选择，翻页与搜索会保留已选内容；保存前逐项预览。</p><p v-if="model.selectionError" class="local-error" role="alert">{{ model.selectionError }}</p>
    <p v-if="model.error" class="local-error" role="alert">{{ model.error }} <button type="button" @click="model.ensureRange(Math.floor(model.scrollTop / 84), Math.floor(model.scrollTop / 84) + 24)">重试读取</button></p>
    <p v-if="model.actionError" class="local-error" role="alert">{{ model.actionError }}</p>
    <p v-if="model.pendingOverride || model.pendingRelocation || model.relocationUnknown" class="local-note">请核对已有请求。<button type="button" @click="emit('open-outbox')">打开未确认操作</button></p>
    <div class="local-library-body" :class="{ 'has-detail': model.selectedId }">
      <div ref="trackList" class="local-track-list"><div class="local-results-summary" aria-live="polite"><span v-if="model.loaded">{{ model.total }} 首{{ model.query ? ` · “${model.query}”的结果` : '' }}</span><span v-if="model.loading" role="status">正在读取…</span><span v-if="model.stale">正在显示上次成功读取的结果。</span></div>
        <TrackTable v-if="model.loaded || model.loading" :tracks="model.tracks" :range-window="model.rangeWindow" :initial-loading="!model.loaded && model.loading" :scroll-top="model.scrollTop"
          :busy="model.actionBusy" :empty-title="model.query ? '没有匹配的曲目' : '本地音乐库还没有曲目'"
          :empty-copy="model.query ? '试试原始名称或不同关键词；现有音乐库保留。' : '展开目录与扫描管理，加入源目录并开始扫描。源文件只读。'"
          @visible-range="model.ensureRange" @update:scroll-top="model.scrollTop = $event"
          @play="model.playTrack($event.id)" @queue="model.playTrack($event.id, 'APPEND_MB_QUEUE')" @play-next="model.playTrack($event.id, 'PLAY_NEXT_MB_QUEUE')">
          <template #row-detail="{ track }"><button type="button" class="row-action local-detail-button" :data-local-detail-track="track.id" :aria-label="`查看 ${track.title} 的版本与文件详情`" @click.stop="openDetail(track, $event)">详情</button></template>
          <template v-if="model.selectionMode" #row-leading="{ track }"><label class="local-track-choice" @click.stop @dblclick.stop @keydown.enter.stop><input type="checkbox" :checked="model.selectedTrackIds.includes(track.id)" :aria-label="`选择 ${track.title}`" @change="model.toggleTrackSelection(track.id)"></label></template>
        </TrackTable>
        <p v-else class="local-note" role="status">尚未成功读取本地音乐库，请重试读取。</p>
      </div>
      <section v-if="model.selectedId" class="local-track-detail settings-glass-panel" aria-labelledby="local-track-detail-heading" @keydown.esc.stop.prevent="closeDetail">
        <div class="local-detail-heading"><h2 id="local-track-detail-heading" ref="detailHeading" tabindex="-1">{{ model.detail?.metadata.effective.title || '曲目详情' }}</h2><button type="button" aria-label="关闭曲目详情" @click="closeDetail">×</button></div>
        <p v-if="model.detailLoading" role="status">正在读取当前曲目详情…</p><p v-if="model.detailError" role="alert">{{ model.detailError }}<button type="button" @click="model.selectTrack(model.selectedId!)">重试详情</button></p>
        <template v-if="model.detail">
          <p v-if="model.detailStale" class="local-note">正在显示上次成功读取的详情。</p>
          <p class="local-note">{{ model.selectedRoot ? rootAvailability[model.selectedRoot.availability] : '目录状态暂未读取' }} · 本地原文件</p>
          <div class="local-detail-actions"><button type="button" :disabled="model.actionBusy || model.detail.track.segment !== null" @click="model.playTrack(model.detail.track.id)">原文件直送</button><button type="button" :disabled="model.actionBusy || model.detail.track.segment !== null" @click="model.playTrack(model.detail.track.id, 'APPEND_MB_QUEUE')">加入 MB 队列</button><button type="button" :disabled="model.actionBusy || model.detail.track.segment !== null" @click="model.playTrack(model.detail.track.id, 'PLAY_NEXT_MB_QUEUE')">MB 下一首</button></div>
          <p v-if="model.detail.track.segment !== null" class="local-note">这是已保存的 CUE 段落；段落直送尚不支持，曲目身份与信息保留。</p>
          <div class="local-detail-actions"><button type="button" @click="props.session.artwork.open(model.detail.track.id)">选择封面</button><span class="local-note">只保存到 MB；封面不改变版本与音质信息。</span></div>
          <div class="local-detail-actions"><button type="button" @click="openOrganizerTrack">整理此曲目信息</button><button type="button" :disabled="!props.session.sourceWrites?.capable" @click="openSourceTrack">预览此曲目源写</button></div>
          <div class="local-detail-actions"><button type="button" :disabled="model.actionBusy || !props.session.relocationPlans?.capable" @click="model.openRelocationTrack('rename')">预览此源文件改名</button><button type="button" :disabled="model.actionBusy || !props.session.relocationPlans?.capable" @click="model.openRelocationTrack('move')">预览此源文件移动</button></div>
          <div v-if="model.detailArtwork?.selection?.candidate" class="local-detail-artwork"><SafeArtwork :src="model.detailArtwork.selection.candidate.display.dataUrl" alt="MB 已保存的独立发行封面" loading="eager" style="width:100px;height:100px;flex:none" /><p class="local-note">MB 已保存封面 · {{ model.detailArtwork.selection.candidate.sourceLabel }}<br>Roon 封面接收状态另行验证。</p></div>
          <h3>版本</h3><ul v-if="model.detail.editions.length"><li v-for="edition in model.detail.editions" :key="edition.id">{{ edition.title }} · {{ edition.edition || '未注明版本' }} · 发行 {{ edition.id.slice(-8) }} <button type="button" :aria-label="`整理具体发行 ${edition.title} ${edition.edition} ${edition.id}`" @click="openOrganizerEdition(edition.id)">整理这个发行</button><button type="button" :disabled="!props.session.sourceWrites?.capable" :aria-label="`预览具体发行 ${edition.title} ${edition.edition} ${edition.id} 的源写`" @click="openSourceEdition(edition.id)">预览这个发行源写</button></li></ul><p v-else class="local-note">尚无已保存的独立发行关系。</p>
          <p v-if="model.detail.versionTokens.length" class="local-note">名称线索：<span v-for="(token, index) in model.detail.versionTokens" :key="`${token.source}-${token.start}-${index}`">{{ token.raw }}（{{ tokenSource[token.source] }}）{{ index + 1 < model.detail.versionTokens.length ? ' · ' : '' }}</span>。名称线索用于辨认版本。</p>
          <h3>原始标签与显示信息</h3><div class="local-metadata-wrap"><table class="local-metadata"><caption>已保存的来源、人工更正与生效信息</caption><thead><tr><th scope="col">字段</th><th scope="col">原始标签</th><th scope="col">显示更正</th><th scope="col">生效信息</th></tr></thead><tbody><tr v-for="field in metadataFields" :key="field.key"><th scope="row">{{ field.label }}</th><td>{{ model.detail.metadata.raw[field.key] || '未提供' }}</td><td>{{ model.detail.metadata.override?.fields[field.key] ?? '未更正' }}</td><td>{{ model.detail.metadata.effective[field.key] || '未提供' }}</td></tr></tbody></table></div>
          <form class="local-title-form" @submit.prevent="model.saveTitle()"><label for="local-display-title">仅修改 MB 显示名称</label><input id="local-display-title" v-model="model.titleDraft" :disabled="model.actionBusy || !!model.pendingOverride" autocomplete="off"><p class="local-note">更正只保存在音乐库中，音频字节与文件标签保留。已有收藏与关联不会删除。</p><button type="submit" :disabled="model.actionBusy || !!model.pendingOverride">保存显示更正</button></form>
          <h3>文件参数</h3><p v-if="model.detail.fileParameters">扫描解析报告：{{ model.detail.fileParameters.container }} · {{ model.detail.fileParameters.codec }} · {{ model.detail.fileParameters.sampleRateHz / 1000 }} kHz · {{ model.detail.fileParameters.bitsPerSample === null ? '位深未知' : `${model.detail.fileParameters.bitsPerSample} bit` }} · {{ model.detail.fileParameters.channels }} 声道</p><p v-else class="local-note">文件参数未知；当前解析事实尚未确认。</p><p class="local-note">Roon 实际输入、处理与输出：未知。HTTP 字节、Signal Path、数字输出和曲目边界按各自观察确认。</p>
          <h3>外部改名后的文件</h3><button type="button" :disabled="model.actionBusy || !!model.pendingRelocation || model.relocationUnknown || model.detail.track.segment !== null" @click="model.locateSelected()">选择重新定位候选</button><p class="local-note">重新定位保留曲目、已保存标签、显示更正与收藏。多个同名候选需要逐项人工核对。</p>
          <section v-if="model.candidates" aria-label="重新定位候选"><p v-if="!model.candidates.candidates.length">没有可用候选，请检查授权目录。</p><label><input v-model="model.relocationConfirmed" type="checkbox" :disabled="!!model.pendingRelocation || model.relocationUnknown">我已核对候选文件，保留原曲目身份与已有信息</label><ul><li v-for="candidate in model.candidates.candidates" :key="candidate.id">{{ candidate.relativeLabel }} · {{ candidate.size }} 字节 · {{ candidate.evidence === 'same-inode-observation' ? '观察到相同文件对象' : '人工选择，内容需核对' }}<button type="button" :disabled="model.actionBusy || !!model.pendingRelocation || !model.relocationConfirmed || model.relocationUnknown" @click="model.confirmCandidate(candidate.id)">确认这个候选</button></li></ul></section>
        </template>
      </section>
    </div>
    <LocalArtworkDialog v-if="props.session.artwork.isOpen.value" :session="props.session.artwork" :source-writes-available="props.session.sourceWrites?.capable" @source-writes="sourceFromArtwork" />
    <LocalOrganizerDialog v-if="props.session.organizer.isOpen.value" :session="props.session.organizer" :source-writes-available="props.session.sourceWrites?.capable" @open-outbox="emit('open-outbox')" @return-focus="organizerReturnFocus" @source-writes="sourceFromOrganizer" />
    <SourceWritesDialog v-if="SourceWritesDialog && props.session.sourceWrites.isOpen.value" :session="props.session.sourceWrites" @open-outbox="emit('open-outbox')" @return-focus="organizerReturnFocus" @mb-only="openMBOnly" @reacquire="reacquireSourceArtwork" />
    <RelocationDialog v-if="RelocationDialog && props.session.relocationPlans.isOpen.value" :session="props.session.relocationPlans" @return-focus="organizerReturnFocus" />
  </section>
</template>

<style scoped>
.local-detail-artwork { display:flex; gap:16px; align-items:center; margin:16px 0; }
.local-organizer-toolbar { display:flex; gap:12px; align-items:center; flex-wrap:wrap; margin:12px 0; }
.local-organizer-toolbar span { color:var(--mb-text-secondary); font-variant-numeric:tabular-nums; }
.local-track-choice { display:flex; align-items:center; justify-content:center; width:44px; min-height:44px; cursor:pointer; }
.local-track-choice input { width:18px; height:18px; margin:0; accent-color:var(--mb-accent); }
.local-library-view { padding-bottom: 170px; }
.local-library-heading, .local-detail-heading, .local-search-controls, .local-detail-actions, .local-results-summary { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.local-library-heading { justify-content: space-between; margin-bottom: 16px; }
.local-library-heading h1 { margin: 0 0 8px; }
.local-note, .local-library-heading p, .local-target span { color: var(--mb-text-secondary); line-height: 1.6; }
.local-target { display: grid; gap: 6px; margin: 16px 0; overflow-wrap: anywhere; }
.local-library-management { margin: 20px 0; }
.local-library-management summary { min-height: 44px; cursor: pointer; display: list-item; line-height: 44px; }
.local-library-search { display: grid; gap: 10px; margin-bottom: 14px; }
.local-search-controls input { flex: 1 1 200px; min-width: 0; }
.local-root-filter { display: flex; align-items: center; gap: 8px; }
.local-library-view input:not([type=checkbox]), .local-library-view select { min-height: 44px; padding: 8px 12px; color: var(--mb-text-primary); background: var(--mb-glass-clear); border: 1px solid var(--mb-glass-border); border-radius: 8px; }
.local-library-view button { min-height: 44px; min-width: 44px; }
.local-library-view :deep(.settings-card button) { min-height: 44px; min-width: 44px; }
.local-track-detail label:has(input[type=checkbox]) { display: flex; align-items: center; gap: 8px; min-height: 44px; }
.local-library-view :deep(.local-detail-button) { font-size: 11px; padding: 0 2px; }
.local-library-body { display: grid; gap: 20px; min-width: 0; }
.local-library-body.has-detail { grid-template-columns: minmax(260px, 1fr) minmax(300px, 440px); }
.local-track-list { min-width: 0; }
.local-results-summary { min-height: 32px; color: var(--mb-text-secondary); font-variant-numeric: tabular-nums; }
.local-library-view :deep(.track-table.is-virtualized) { height: min(65vh, 720px); min-height: 252px; overflow: auto; }
.local-track-detail { padding: 20px; min-width: 0; border-radius: 16px; align-self: start; }
.local-detail-heading { flex-wrap: nowrap; justify-content: space-between; align-items: flex-start; }
.local-detail-heading h2 { font-size: 20px; overflow-wrap: anywhere; margin: 0; }
.local-track-detail h3 { margin-top: 24px; font-size: 15px; }
.local-metadata-wrap { overflow-x: auto; }
.local-metadata { width: 100%; border-collapse: collapse; font-size: 12px; }
.local-metadata caption { text-align: left; padding: 8px 0; color: var(--mb-text-secondary); }
.local-metadata td, .local-metadata th { padding: 8px 4px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--mb-divider); overflow-wrap: anywhere; }
.local-title-form { display: grid; gap: 8px; margin-top: 18px; }
.local-error { color: var(--mb-danger); }
.local-library-view button:focus-visible, .local-library-view input:focus-visible, .local-library-view select:focus-visible, .local-library-management summary:focus-visible, .local-detail-heading h2:focus-visible { outline: 2px solid var(--mb-accent); outline-offset: 2px; }
@media (max-width: 1200px) { .local-library-body.has-detail { grid-template-columns: minmax(0, 1fr); } }
@media (prefers-reduced-motion: reduce) { .local-library-view :deep(*) { scroll-behavior: auto; } }
</style>
