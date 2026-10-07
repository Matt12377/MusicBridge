<script setup lang="ts">
import { collectionModelLabel } from './collection-display'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { CanonicalReference, CollectionFilter, CollectionModel, CollectionReceiveRequest } from '@music-bridge/contracts'
import { loadPublishedReferenceImages, referenceImagesForModel } from './reference-images'
import CollectionReferenceImage from './CollectionReferenceImage.vue'
import { useCollection } from '../../composables/useCollection'
import CollectionReceiveDialog from './CollectionReceiveDialog.vue'
import CollectionModelDetail from './CollectionModelDetail.vue'
import CollectionPhoto from './CollectionPhoto.vue'
import PhysicalMusicView from './PhysicalMusicView.vue'
import RecordingRecordsPanel from '../recording/RecordingRecordsPanel.vue'
import ReferenceCatalogPanel from './ReferenceCatalogPanel.vue'
import SpreadsheetImportPanel from './SpreadsheetImportPanel.vue'
import CollectionProgressPanel from './CollectionProgressPanel.vue'
import type { CollectionReservationEntry, CollectionReturnLocation, CollectionStartEntry, RecordingPhysicalSelection, RecordingReservationSelection } from './collection-recording-navigation'

const props = defineProps<{ returnLocation?: CollectionReturnLocation }>()
const emit = defineEmits<{ startRecording: [selection: CollectionStartEntry]; openReservation: [selection: CollectionReservationEntry] }>()

const recordPhysicalId = ref('')
type LeaveGuard = { canLeave(): boolean; leaveBlockReason(): string | null }
const recordsPanel = ref<LeaveGuard | null>(null), musicView = ref<LeaveGuard | null>(null), leaveError = ref('')
// 面板在 v-for 内，字符串 ref 会被 Vue 收集为数组；离开守卫需要唯一组件实例。
function bindMusicView(instance: unknown): void {
  musicView.value = instance && typeof instance === 'object'
    && 'canLeave' in instance && typeof instance.canLeave === 'function'
    && 'leaveBlockReason' in instance && typeof instance.leaveBlockReason === 'function'
    ? instance as LeaveGuard : null
}
function leaveBlockReason(): string | null {
  if (recordPhysicalId.value && recordsPanel.value?.canLeave() !== true) return recordsPanel.value?.leaveBlockReason() ?? '录音档案中的设备运行尚未安全收口。'
  if (musicView.value?.canLeave() === false) return musicView.value.leaveBlockReason() ?? '实体音乐库中的设备运行尚未安全收口。'
  if (selectedView.value === 'music' && !musicView.value) return '实体音乐库正在加载，请稍后再切换页面。'
  return null
}
const canLeave = (): boolean => leaveBlockReason() === null
function guardLeave(): boolean { if (canLeave()) { leaveError.value = ''; return true }; leaveError.value = leaveBlockReason()!; return false }
defineExpose({ canLeave, leaveBlockReason })
let recordOrigin: HTMLElement | undefined
function showRecords(id: string): void { if (!guardLeave()) return; recordOrigin = document.activeElement as HTMLElement; recordPhysicalId.value = id }
function closeRecords(): void { if (!guardLeave()) return; recordPhysicalId.value = ''; void nextTick(() => recordOrigin?.isConnected && recordOrigin.focus({ preventScroll: true })) }
const progressOpen = ref(false)
const progressTrigger = ref<HTMLButtonElement | HTMLButtonElement[]>()
const progressSection = ref<'progress' | 'wants'>('progress')
let progressOrigin: HTMLElement | undefined
function openProgress(section: 'progress' | 'wants' = 'progress'): void {
  if (!guardLeave()) return
  progressOrigin = document.activeElement as HTMLElement
  progressSection.value = section; progressOpen.value = true
}
function closeProgress(): void { progressOpen.value = false; void nextTick(() => focusCollectionTrigger(progressOrigin?.isConnected ? progressOrigin : progressTrigger.value)) }

const spreadsheetOpen = ref(false)
const spreadsheetTrigger = ref<HTMLButtonElement>()
function closeSpreadsheet(): void { spreadsheetOpen.value = false; void nextTick(() => spreadsheetTrigger.value?.focus({ preventScroll: true })) }

const referenceOpen = ref(false)
const referenceTrigger = ref<HTMLButtonElement | HTMLButtonElement[]>()
// 循环中的字符串ref可能是数组；关闭后仍回到当前页面内的原入口。
function focusCollectionTrigger(trigger: HTMLElement | HTMLElement[] | undefined): void {
  const target = Array.isArray(trigger) ? trigger.find((element: HTMLElement) => element.isConnected) : trigger
  target?.focus({ preventScroll: true })
}
function closeReference(): void { referenceOpen.value = false; void loadReferenceImages(); void nextTick(() => focusCollectionTrigger(referenceTrigger.value)) }

const inventory = useCollection()
const collectionApi = window.musicBridge
const { catalog, detail, filter, loading, saving, refreshing, error, notice, pending, blocked } = inventory
const inventoryView = ref<'wall' | 'inventory'>('wall')
const reviewTotal = ref<number>()
let reviewRead = 0
async function loadReviewSummary(): Promise<void> {
  const read = ++reviewRead
  reviewTotal.value = undefined
  try {
    const page = await collectionApi.listCollection({ offset: 0, limit: 1 }, { stockState: 'needs-review' })
    if (alive && read === reviewRead) reviewTotal.value = page.total
  } catch { /* 汇总不可用时保留库存入口，不把未读取写成零。 */ }
}
watch(catalog, () => { void loadReviewSummary() })
const brandSuggestions = computed(() => [...new Set([
  ...(catalog.value?.items.map(model => model.brand.trim()) ?? []),
  ...referenceImages.value.map(item => item.brand.trim()),
  filterDraft.value.brand,
].filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN')))
function modelStatus(model: CollectionModel): string {
  if (!model.counts.total) return '暂无库存'
  return model.identification !== 'verified' || model.counts.unknown > 0 ? '尚待核实' : '已收藏'
}
let modelOrigin: HTMLElement | undefined
function openModel(id: string): void { modelOrigin = document.activeElement as HTMLElement; void inventory.openModel(id) }
function closeModel(): void { inventory.closeModel(); void nextTick(() => modelOrigin?.isConnected && modelOrigin.focus({ preventScroll: true })) }
const returnLocationStale = ref(false), relocating = ref(false)
const referenceImages = shallowRef<readonly CanonicalReference[]>([])
const referenceLoading = ref(false), referenceError = ref('')
let referenceRead = 0
async function loadReferenceImages(): Promise<void> {
  const read = ++referenceRead
  referenceLoading.value = true; referenceError.value = ''; referenceImages.value = []
  try { const items = await loadPublishedReferenceImages(collectionApi); if (read === referenceRead) referenceImages.value = items }
  catch { if (read === referenceRead) referenceError.value = '书籍参考图暂时无法读取，库存和实物照片不受影响。' }
  finally { if (read === referenceRead) referenceLoading.value = false }
}
const candidatesByModel = computed(() => new Map(catalog.value?.items.map(model => [model.id, referenceImagesForModel(model, referenceImages.value)])))
const referenceCandidates = (model: CollectionModel) => candidatesByModel.value.get(model.id) ?? referenceImagesForModel(model, referenceImages.value)
let restoreEpoch = 0, userFocusEpoch = 0, alive = true
function noteUserFocusAction(): void { userFocusEpoch++ }
onMounted(() => {
  document.addEventListener('pointerdown', noteUserFocusAction, true)
  document.addEventListener('keydown', noteUserFocusAction, true)
  void loadReferenceImages(); void restorePhysicalLocation()
})
onBeforeUnmount(() => {
  referenceRead++; reviewRead++; restoreEpoch++; alive = false
  document.removeEventListener('pointerdown', noteUserFocusAction, true)
  document.removeEventListener('keydown', noteUserFocusAction, true)
})
const filterDraft = ref({ query: '', brand: '', decade: '', stockState: '' as '' | NonNullable<CollectionFilter['stockState']> })
function applyFilter(): void {
  filter.value = { query: filterDraft.value.query, brand: filterDraft.value.brand,
    ...(filterDraft.value.stockState ? { stockState: filterDraft.value.stockState } : {}),
    ...(filterDraft.value.decade ? { decade: filterDraft.value.decade === 'unknown' ? 'unknown' as const : Number(filterDraft.value.decade) } : {}) }
  void inventory.load(0)
}
const hasFilter = computed(() => !!(filter.value.query || filter.value.brand || filter.value.decade || filter.value.stockState))
function clearFilter(): void { filterDraft.value = { query: '', brand: '', decade: '', stockState: '' }; applyFilter() }
function reviewInventory(): void { filterDraft.value = { query: '', brand: '', decade: '', stockState: 'needs-review' }; applyFilter() }
const musicId = ref<string>()
const musicNavigation = ref(0)
function startRecording(selection: RecordingPhysicalSelection): void {
  if (!guardLeave()) return
  emit('startRecording', { ...selection, returnOffset: detail.value?.copies.offset ?? 0 })
}
function openReservation(selection: RecordingReservationSelection): void {
  if (!guardLeave()) return
  emit('openReservation', { ...selection, returnOffset: detail.value?.copies.offset ?? 0 })
}
async function restorePhysicalLocation(location = props.returnLocation): Promise<void> {
  if (!location) return
  const epoch = ++restoreEpoch, focusEpoch = userFocusEpoch
  const stillCurrent = () => alive && epoch === restoreEpoch && focusEpoch === userFocusEpoch
    && props.returnLocation?.physicalId === location.physicalId && selectedView.value === 'tapes'
  await inventory.openModel(location.modelId, location.returnOffset)
  if (!stillCurrent() || detail.value?.model.id !== location.modelId || detail.value.copies.offset !== location.returnOffset) return
  if (detail.value.copies.items.some(copy => copy.physicalId === location.physicalId)) {
    await nextTick()
    if (stillCurrent() && detail.value?.model.id === location.modelId && detail.value.copies.offset === location.returnOffset) {
      returnLocationStale.value = false
      document.querySelector<HTMLElement>('[data-returned-copy="true"]')?.focus({ preventScroll: true })
    }
  } else if (!error.value) {
    returnLocationStale.value = true
    notice.value = `已返回 ${location.physicalId} 所在型号；实体分页已变化，尚未定位到这盘。`
  }
}
async function relocatePhysical(): Promise<void> {
  const physicalId = props.returnLocation?.physicalId
  if (!physicalId || relocating.value) return
  const focusEpoch = userFocusEpoch, epoch = restoreEpoch, modelId = detail.value?.model.id, offset = detail.value?.copies.offset
  relocating.value = true
  try {
    const result = await collectionApi.getCollectionCopy(physicalId)
    if (!alive || props.returnLocation?.physicalId !== physicalId || focusEpoch !== userFocusEpoch || epoch !== restoreEpoch
      || detail.value?.model.id !== modelId || detail.value?.copies.offset !== offset || selectedView.value !== 'tapes') return
    if (result.copy.physicalId !== physicalId || result.copyIndex === undefined) {
      notice.value = '单盘当前位置尚未得到确认，请稍后再试。'
      return
    }
    await restorePhysicalLocation({ physicalId, modelId: result.modelId, returnOffset: Math.floor(result.copyIndex / 20) * 20 })
  } catch { if (alive && props.returnLocation?.physicalId === physicalId) notice.value = '重新定位失败；已保留当前型号与单盘编号，请稍后重试。' }
  finally { relocating.value = false }
}
function showRecording(id: string): void { if (!guardLeave()) return; musicId.value = id; musicNavigation.value++; selectedView.value = 'music' }
function showModel(id: string): void { if (!guardLeave()) return; selectedView.value = 'tapes'; void inventory.openModel(id) }
const receiving = ref(false)
const receiveModel = ref<CollectionModel>()
function beginReceive(model?: CollectionModel): void { receiveModel.value = model; receiving.value = true }
async function receive(request: CollectionReceiveRequest): Promise<void> {
  if (await inventory.mutate(() => window.musicBridge.receiveCollectionStock(request))) receiving.value = false
}
async function retry(): Promise<void> { if (await inventory.retry()) receiving.value = false }

const selectedView = defineModel<'tapes' | 'music'>({ required: true })
const views = [
  { id: 'tapes', label: '收藏音乐库' },
  { id: 'music', label: '实体音乐库' },
] as const
</script>

<template>
  <RecordingRecordsPanel v-if="recordPhysicalId" ref="recordsPanel" :physical-id="recordPhysicalId" @close="closeRecords" @changed="detail && inventory.openModel(detail.model.id)" />
  <section class="collection-view" data-component="CollectionView" aria-label="实体收藏">
    <p v-if="leaveError" role="alert">{{ leaveError }}</p>
    <p class="collection-breadcrumb">实物收藏 / {{ selectedView === 'tapes' ? '收藏音乐库' : '实体音乐库' }}</p>

    <div v-for="view in views" v-show="selectedView === view.id" :id="`collection-panel-${view.id}`" :key="view.id"
      class="collection-panel" role="region" :aria-label="view.label">
      <div v-if="view.id === 'tapes'" class="inventory-feedback" aria-live="polite">
        <p v-if="error" role="alert">{{ error }} <button v-if="pending && !receiving" :disabled="saving" @click="retry">重试原操作</button><button v-else-if="!pending" :disabled="loading || blocked" @click="inventory.refresh()">刷新库存</button></p>
        <p v-else-if="notice" role="status">{{ notice }} <button v-if="returnLocationStale" type="button" :disabled="relocating || blocked" @click="relocatePhysical">重新定位这盘</button></p>
      </div>
      <div v-if="view.id === 'tapes' && detail" class="collection-actions collection-detail-actions">
        <button class="reference-entry" type="button" :disabled="loading || blocked" @click="inventory.refresh()">{{ refreshing ? '刷新中…' : '刷新库存' }}</button>
      </div>
      <CollectionModelDetail v-if="view.id === 'tapes' && detail" :detail="detail" :busy="blocked"
        :focus-physical-id="returnLocation?.physicalId" :reference-candidates="referenceCandidates(detail.model)"
        @show-records="showRecords" @show-recording="showRecording" @start-recording="startRecording" @open-reservation="openReservation" @close="closeModel" @receive="beginReceive(detail.model)" @page="inventory.openModel(detail.model.id, $event)"
        @materialize="request => inventory.mutate(() => collectionApi.materializeCollectionCopy(request))"
        @update-copy="request => inventory.mutate(() => collectionApi.updateCollectionCopy(request))"
        @add-photo="inventory.addPhoto" @change-photo="request => inventory.mutate(() => collectionApi.changeCollectionPhoto(request))"
        @policy="request => inventory.mutate(() => collectionApi.setCollectionPolicy(request))" />
      <PhysicalMusicView :key="musicNavigation" v-if="view.id === 'music'" :ref="bindMusicView" :requested-id="musicId" :active="selectedView === 'music'" @model="showModel" />

      <template v-if="view.id === 'tapes' && !detail">
        <header class="collection-heading">
          <div><p class="collection-kicker">PHYSICAL COLLECTION / V3</p><h2>每一盘，都有它的位置。</h2><p>按型号和年代看收藏；点开一款，就能看到数量、状态和录过的内容。</p></div>
          <div class="collection-header-tools"><label class="collection-search"><span class="filter-label">关键词</span><input v-model.trim="filterDraft.query" form="collection-filters" maxlength="120" placeholder="搜索品牌、型号、版次…"></label>
        <form id="collection-filters" class="inventory-filters" aria-label="筛选磁带收藏" @submit.prevent="applyFilter">
          <label class="brand-filter"><span class="filter-label">品牌</span><input v-model.trim="filterDraft.brand" list="collection-brand-options" maxlength="120" placeholder="所有品牌"><datalist id="collection-brand-options"><option v-for="brand in brandSuggestions" :key="brand" :value="brand" /></datalist></label>
          <label><span class="filter-label">年代</span><select v-model="filterDraft.decade" @change="applyFilter"><option value="">所有年代</option><option value="unknown">年代待确认</option><option v-for="decade in [1950, 1960, 1970, 1980, 1990, 2000, 2010, 2020, 2030]" :key="decade" :value="String(decade)">{{ decade }} 年代</option></select></label>
          <label class="state-filter"><span class="filter-label">收藏状态</span><select v-model="filterDraft.stockState" @change="applyFilter"><option value="">全部收藏状态</option><option value="identified">版次已确认</option><option value="needs-review">信息待整理</option><option value="blank">有空白库存</option><option value="recorded">已录音 / 已用库存</option></select></label>
          <button type="submit" :disabled="loading">筛选</button><button v-if="hasFilter" type="button" :disabled="loading" @click="clearFilter">清除</button>
        </form>
          <div class="collection-actions"><button class="reference-entry" type="button" :disabled="loading || blocked" @click="inventory.refresh()">{{ refreshing ? '刷新中…' : '刷新库存' }}</button><button ref="spreadsheetTrigger" class="reference-entry" type="button" aria-label="库存表导入" @click="spreadsheetOpen = true">导入库存</button><button class="collection-add" type="button" :disabled="blocked || !catalog" @click="beginReceive()"><span aria-hidden="true">＋</span> 添加磁带</button></div></div>
        </header>
        <nav class="inventory-subviews" aria-label="磁带收藏内容">
          <button type="button" :aria-pressed="inventoryView === 'wall'" @click="inventoryView = 'wall'">磁带墙</button>
          <button type="button" :aria-pressed="inventoryView === 'inventory'" @click="inventoryView = 'inventory'">我的库存</button>
        </nav>

        <div class="collection-list-tools"><span v-if="catalog">{{ hasFilter ? '筛选结果' : '已登记' }} · {{ catalog.total }} 个型号</span><div class="collection-list-actions"><button ref="progressTrigger" class="reference-entry" type="button" aria-label="完成度与求购" aria-haspopup="dialog" @click="openProgress()">收藏进度 / 求购</button><button v-if="reviewTotal" class="collection-review-entry" type="button" :disabled="loading" aria-label="待整理库存" title="未知库存仍计入拥有数量；整理不会自动确认版次或空白状态。" @click="reviewInventory">{{ reviewTotal }} 型号待整理 →</button><button ref="referenceTrigger" class="reference-entry" type="button" @click="referenceOpen = true">参考目录与版次</button></div></div>
        <p v-if="loading" role="status" class="collection-status">正在读取库存…</p>
        <p v-if="referenceLoading" role="status" class="collection-status">正在读取书籍参考图…</p>
        <p v-else-if="referenceError" role="alert" class="collection-status">{{ referenceError }} <button type="button" @click="loadReferenceImages">重试参考图</button></p>

        <div v-if="catalog?.items.length && inventoryView === 'wall'" class="inventory-grid">
          <article v-for="model in catalog.items" :key="model.id" class="inventory-tile">
            <button class="inventory-card" type="button" @click="openModel(model.id)">
              <div class="inventory-card-media">
                <div v-if="model.featuredPhoto" class="inventory-card-photo"><CollectionPhoto :photo="model.featuredPhoto" :alt="`${collectionModelLabel(model)} 实物代表图`" /></div>
                <div v-else-if="referenceCandidates(model).length" class="inventory-card-photo"><CollectionReferenceImage :reference="referenceCandidates(model)[0]!" /></div>
                <div v-else class="inventory-placeholder" aria-hidden="true"><svg viewBox="0 0 240 155" fill="none"><rect x="12" y="10" width="216" height="136" rx="9" fill="var(--collection-media)" stroke="currentColor" stroke-width="2"/><rect x="35" y="34" width="170" height="75" rx="23" fill="currentColor" fill-opacity=".1" stroke="currentColor" stroke-opacity=".3"/><circle cx="94" cy="78" r="14" fill="var(--collection-surface)" stroke="currentColor" stroke-opacity=".3"/><circle cx="146" cy="78" r="14" fill="var(--collection-surface)" stroke="currentColor" stroke-opacity=".3"/><circle cx="94" cy="78" r="6" fill="currentColor"/><circle cx="146" cy="78" r="6" fill="currentColor"/><path d="M53 137l8-16h118l8 16H53Z" fill="currentColor" fill-opacity=".1" stroke="currentColor" stroke-opacity=".3"/></svg></div>
                <span v-if="!model.featuredPhoto && !referenceCandidates(model).length" class="inventory-missing-photo">实物照片待添加</span>
                <span class="inventory-photo-source">{{ model.featuredPhoto ? '实物照片' : referenceCandidates(model).length ? '书籍参考 · 版次未核' : '线稿占位 · 非实物照片' }}</span>
              </div>
              <div class="inventory-card-body">
                <span class="inventory-card-title">{{ collectionModelLabel(model) }}</span>
                <span class="inventory-card-top"><span class="inventory-card-year">{{ model.year ?? '年代待确认' }}</span><span class="inventory-card-state" :class="{ 'needs-review': modelStatus(model) === '尚待核实' }">{{ modelStatus(model) }}</span></span>
              </div>
            </button>
          </article>
        </div>
        <div v-else-if="catalog?.items.length && inventoryView === 'inventory'" class="inventory-table-wrap" tabindex="0" aria-label="磁带库存表格滚动区">
          <table class="inventory-table" aria-label="磁带库存"><thead><tr><th scope="col">型号 / 版次</th><th scope="col">拥有</th><th scope="col">未开封</th><th scope="col">已拆空白</th><th scope="col">已录音 / 待登记</th><th scope="col">已预留</th><th scope="col">待整理</th></tr></thead><tbody><tr v-for="model in catalog.items" :key="model.id"><th scope="row"><button type="button" @click="openModel(model.id)">{{ collectionModelLabel(model) }}</button><small>{{ model.edition || '版次待确认' }} · {{ modelStatus(model) }}</small></th><td>{{ model.counts.total }}</td><td>{{ model.counts.sealedBlank }}</td><td>{{ model.counts.openedBlank }}</td><td>{{ model.counts.recorded }} / {{ model.counts.legacyUsed }}</td><td>{{ model.counts.reserved }}</td><td>{{ model.counts.unknown }}</td></tr></tbody></table>
        </div>
        <div v-if="catalog && !catalog.total && !loading" class="collection-empty">
          <svg class="collection-art" viewBox="0 0 220 150" fill="none" aria-hidden="true"><rect x="20" y="21" width="180" height="110" rx="12" stroke="currentColor"/><rect x="37" y="38" width="146" height="54" rx="7" stroke="currentColor"/><circle cx="66" cy="65" r="16" stroke="currentColor"/><circle cx="154" cy="65" r="16" stroke="currentColor"/><path d="M82 65h56M57 130l12-25h82l12 25" stroke="currentColor"/></svg>
          <h3>{{ hasFilter ? '没有符合筛选的型号' : '还没有磁带库存' }}</h3><p class="collection-description">{{ hasFilter ? '试着清除筛选，或换一个品牌、年代和收藏状态。' : '每一盘收藏，从这里开始。添加手上的磁带，或导入已有库存表；照片、版次和状态都可以逐步补齐。' }}</p><button v-if="hasFilter" type="button" @click="clearFilter">清除筛选</button>
        </div>
        <nav v-if="catalog && catalog.total > catalog.limit" class="inventory-pagination" aria-label="收藏分页"><button :disabled="loading || catalog.offset === 0" @click="inventory.load(Math.max(0, catalog.offset - catalog.limit))">上一页</button><span>{{ Math.floor(catalog.offset / catalog.limit) + 1 }} / {{ Math.ceil(catalog.total / catalog.limit) }}</span><button :disabled="loading || !catalog.hasMore" @click="inventory.load(catalog.offset + catalog.limit)">下一页</button></nav>
      </template>
    </div>
    <SpreadsheetImportPanel v-if="spreadsheetOpen" @close="closeSpreadsheet" @changed="inventory.load(); detail && inventory.openModel(detail.model.id)" />
    <ReferenceCatalogPanel v-if="referenceOpen" @close="closeReference" />
    <CollectionProgressPanel v-if="progressOpen" :initial-section="progressSection" @close="closeProgress" />
    <CollectionReceiveDialog v-if="receiving" :model="receiveModel" :busy="saving" :error="error" :retryable="!!pending" @close="receiving = false" @save="receive" @retry="retry" />
  </section>
</template>

<style scoped>
.collection-view {
  --collection-surface: var(--mb-content-glass); --collection-media: var(--mb-frosted-control);
  --collection-subtle: var(--mb-glass-clear); --collection-line: var(--mb-glass-border);
  --collection-accent: var(--mb-accent); --collection-text: var(--mb-text-primary);
  --collection-muted: var(--mb-text-secondary); --collection-background: var(--mb-frosted-plane);
  /* 内容与磨砂层一起铺满可用宽度，卡片列数随窗口增加。 */
  box-sizing: border-box; width: 100%; min-height: 100%; min-width: 0; margin: 0;
  padding: 30px 40px 160px;
  color: var(--collection-text); background: var(--collection-background); container-type: inline-size;
  -webkit-backdrop-filter: blur(25px) saturate(1.08); backdrop-filter: blur(25px) saturate(1.08);
}
.collection-breadcrumb { margin: 0 0 28px; color: var(--collection-muted); font-size: 12px; }
.collection-panel { min-width: 0; outline-offset: 4px; }
.collection-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin: 20px 0 24px; }
.collection-kicker { margin: 0 0 6px; color: var(--collection-accent); font-size: 11px; font-weight: 650; letter-spacing: .15em; }
h2 { margin: 0; font-size: 28px; font-weight: 650; letter-spacing: -.035em; line-height: 1.4; }
.collection-heading p:not(.collection-kicker) { margin: 10px 0 0; color: var(--collection-muted); font-size: 13px; line-height: 1.8; }
.collection-actions { display: flex; gap: 10px; align-items: center; flex: 0 0 auto; }
.collection-header-tools { display: flex; flex-direction: column; align-items: flex-end; gap: 12px; flex: 0 1 600px; min-width: 0; max-width: 100%; }
.collection-search { display: block; width: 100%; }
.collection-search input { box-sizing: border-box; width: 100%; min-height: 42px; padding: 10px 14px; border: 1px solid var(--collection-line); border-radius: 9px; background: var(--collection-surface); color: var(--collection-text); font: inherit; font-size: 13px; }
.collection-search input::placeholder { color: var(--collection-muted); }
.collection-view button { font: inherit; cursor: pointer; }
.collection-view button:disabled { opacity: .5; cursor: not-allowed; }
.collection-view .reference-entry, .inventory-filters button, .inventory-feedback button, .inventory-pagination button, .collection-empty button {
  min-height: 38px; padding: 8px 12px; border: 1px solid var(--collection-line); border-radius: 8px; color: var(--collection-text); background: var(--collection-surface); font-size: 12px;
}
.collection-view .collection-add { min-height: 44px; padding: 9px 15px; border: 1px solid var(--collection-accent); border-radius: 9px; color: var(--mb-on-accent); background: var(--collection-accent); font-size: 13px; font-weight: 650; }
.collection-add:hover:not(:disabled) { background: var(--mb-accent-hover); }
.inventory-subviews { display: flex; align-items: center; gap: 4px; padding: 4px; margin-bottom: 18px; border-radius: 10px; background: var(--collection-subtle); }
.inventory-subviews button { min-height: 34px; padding: 7px 13px; border: 0; border-radius: 7px; background: transparent; color: var(--collection-text); font-size: 12px; }
.inventory-subviews button[aria-pressed='true'] { color: var(--collection-accent); background: var(--collection-surface); box-shadow: 0 2px 6px #17392e0a; font-weight: 650; }
.inventory-filters { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; width: 100%; gap: 8px; margin: 0; }
.inventory-filters label { display: block; min-width: 0; flex: 1 1 110px; }
.inventory-filters .brand-filter { flex-basis: 120px; }
.inventory-filters .state-filter { flex-basis: 150px; }
.filter-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
.inventory-filters input, .inventory-filters select { box-sizing: border-box; width: 100%; min-width: 0; min-height: 42px; padding: 9px 11px; border: 1px solid var(--collection-line); border-radius: 7px; background: var(--collection-surface); color: var(--collection-text); font: inherit; font-size: 13px; }
.inventory-filters input::placeholder { color: var(--collection-muted); }
.inventory-filters button { flex-shrink: 0; }
.collection-list-tools { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin: 0 0 14px; font-size: 12px; color: var(--collection-muted); }
.collection-list-tools .reference-entry { min-height: 30px; padding-block: 5px; background: transparent; }
.collection-list-actions { display: flex; align-items: center; justify-content: flex-end; gap: 18px; flex-wrap: wrap; }
.collection-view .collection-review-entry { min-height: 30px; padding: 5px 0; border: 0; background: transparent; color: var(--collection-accent); font-size: 12px; }
.collection-review-entry:hover:not(:disabled) { text-decoration: underline; text-underline-offset: 3px; }
.inventory-feedback { font-size: 13px; line-height: 1.8; }.inventory-feedback p { margin: 12px 0; }
.collection-status { margin: 0 0 14px; color: var(--collection-muted); font-size: 12px; line-height: 1.7; }
.inventory-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(280px, 100%), 1fr)); gap: 28px; }
.inventory-tile { position: relative; min-width: 0; min-height: 0; border: 1px solid var(--collection-line); border-radius: 13px; background: var(--collection-surface); overflow: hidden; }
.inventory-tile:hover { border-color: var(--collection-accent); }
.collection-view .inventory-card { display: flex; flex-direction: column; width: 100%; min-width: 0; height: 100%; padding: 0; border: 0; border-radius: 0; background: transparent; color: var(--collection-text); box-shadow: none; text-align: left; }
.inventory-card-media { position: relative; width: 100%; aspect-ratio: 8 / 5; flex: 0 0 auto; min-height: 0; overflow: hidden; background: var(--collection-media); }
.collection-view .inventory-card-photo { position: absolute; inset: 0; box-sizing: border-box; width: 100%; height: 100%; padding: 0; background: var(--collection-media); }
/* 图片区统一为接近横版参考图的 8:5，减少上下留白；竖图仍完整缩放。 */
.inventory-card-photo :deep(.collection-photo), .inventory-card-photo :deep(.reference-image) { height: 100%; min-height: 0; background: transparent; }
.inventory-card-photo :deep(img) { width: 100%; height: 100%; object-fit: contain; }
.inventory-placeholder { display: flex; align-items: center; justify-content: center; height: 100%; min-height: 0; color: var(--collection-muted); }
.inventory-placeholder svg { width: 235px; max-width: 82%; height: 100%; filter: drop-shadow(0 5px 5px #20352e0b); }
.inventory-missing-photo { position: absolute; top: 9px; left: 9px; padding: 2px 5px; border-radius: 3px; background: var(--collection-surface); color: var(--collection-muted); font-size: 10px; }
.inventory-photo-source { position: absolute; right: 9px; bottom: 7px; max-width: calc(100% - 18px); padding: 2px 5px; border-radius: 3px; background: var(--collection-surface); color: var(--collection-muted); font-size: 10px; overflow-wrap: anywhere; }
.inventory-card-body { display: flex; flex-direction: column; flex: 0 0 64px; justify-content: space-between; min-height: 0; overflow: hidden; gap: 6px; width: 100%; box-sizing: border-box; padding: 9px 12px; }
.inventory-card-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.inventory-card-year { font-size: 12px; color: var(--collection-muted); }
.inventory-card-state { flex-shrink: 0; padding: 3px 7px; border-radius: 4px; font-size: 10px; line-height: 1.3; background: var(--mb-accent-soft); color: var(--collection-accent); }
.inventory-card-state.needs-review { background: var(--collection-subtle); color: var(--collection-muted); }
.collection-view .inventory-card-title { padding: 0; font-size: 16px; font-weight: 650; line-height: 1.4; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 1; overflow: hidden; }
.inventory-table-wrap { max-width: 100%; overflow-x: auto; border: 1px solid var(--collection-line); border-radius: 10px; background: var(--collection-surface); }
.inventory-table { width: 100%; min-width: 700px; border-collapse: collapse; font-size: 12px; }
.inventory-table th, .inventory-table td { padding: 15px 12px; text-align: left; border-bottom: 1px solid var(--collection-line); font-variant-numeric: tabular-nums; }
.inventory-table thead { background: var(--collection-subtle); }.inventory-table tbody tr:last-child > * { border-bottom: 0; }.inventory-table tbody th { min-width: 190px; max-width: 310px; }
.inventory-table button { padding: 0; background: transparent; border: 0; color: var(--collection-accent); text-align: left; overflow-wrap: anywhere; font-size: 13px; font-weight: 650; }
.inventory-table small { display: block; margin-top: 6px; color: var(--collection-muted); font-weight: 400; overflow-wrap: anywhere; }
.collection-view .collection-empty { display: flex; min-height: 310px; padding: 32px; align-items: center; justify-content: center; flex-direction: column; border: 1px dashed var(--collection-line); border-radius: 12px; background: var(--collection-surface); box-shadow: none; text-align: center; }
.collection-art { width: 170px; height: 116px; margin-bottom: 20px; color: var(--collection-muted); opacity: .65; }
h3 { margin: 0; font-size: 19px; font-weight: 650; }.collection-description { max-width: 390px; margin: 12px 0 18px; color: var(--collection-muted); font-size: 13px; line-height: 1.8; }
.inventory-pagination { display: flex; justify-content: center; align-items: center; gap: 20px; margin-top: 22px; font-size: 13px; }
.collection-view :is(button, input, select, textarea, summary):focus-visible, .collection-panel:focus-visible, .inventory-table-wrap:focus-visible { outline: 2px solid var(--collection-accent); outline-offset: 3px; }
.inventory-card:focus-visible { outline-offset: -4px !important; }
@media (max-width: 900px) { .collection-view { padding: 22px 20px 160px; }.collection-heading { flex-wrap: wrap; }.collection-actions { flex-wrap: wrap; }.collection-heading h2 { font-size: 25px; } }
@container (max-width: 820px) { .inventory-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; }.collection-heading { flex-wrap: wrap; }.collection-header-tools { flex: 1 1 100%; }.collection-search { min-width: 0; }.inventory-filters { flex-wrap: wrap; }.inventory-filters label { flex: 1 1 120px; } }
@container (max-width: 480px) { .inventory-grid { grid-template-columns: minmax(0, 1fr); }.collection-header-tools { min-width: 0; flex-wrap: wrap; }.collection-search { flex-basis: 100%; }.collection-actions { margin-left: auto; }.collection-list-tools { align-items: flex-start; flex-direction: column; }.collection-list-actions { justify-content: flex-start; gap: 12px; }.inventory-subviews { flex-wrap: wrap; }.collection-breadcrumb { margin-bottom: 20px; } }
:global(.app-shell:not(.is-now-playing) .content-scroll:has(> .collection-view)) { padding-bottom: 0; }
</style>
