<script setup lang="ts">
import { collectionModelLabel } from './collection-display'
import { nextTick, ref } from 'vue'
import type { CollectionModel, CollectionReceiveRequest } from '@music-bridge/contracts'
import { useCollection } from '../../composables/useCollection'
import CollectionReceiveDialog from './CollectionReceiveDialog.vue'
import CollectionModelDetail from './CollectionModelDetail.vue'
import CollectionPhoto from './CollectionPhoto.vue'
import PhysicalMusicView from './PhysicalMusicView.vue'
import ReferenceCatalogPanel from './ReferenceCatalogPanel.vue'
import SpreadsheetImportPanel from './SpreadsheetImportPanel.vue'
import CollectionProgressPanel from './CollectionProgressPanel.vue'

const progressOpen = ref(false)
const progressTrigger = ref<HTMLButtonElement>()
function closeProgress(): void { progressOpen.value = false; void nextTick(() => progressTrigger.value?.focus({ preventScroll: true })) }

const spreadsheetOpen = ref(false)
const spreadsheetTrigger = ref<HTMLButtonElement>()
function closeSpreadsheet(): void { spreadsheetOpen.value = false; void nextTick(() => spreadsheetTrigger.value?.focus({ preventScroll: true })) }

const referenceOpen = ref(false)
const referenceTrigger = ref<HTMLButtonElement>()
function closeReference(): void { referenceOpen.value = false; void nextTick(() => referenceTrigger.value?.focus({ preventScroll: true })) }

const inventory = useCollection()
const collectionApi = window.musicBridge
const { catalog, detail, filter, loading, saving, error, notice, pending, blocked } = inventory
const filterDraft = ref({ query: '', brand: '', decade: '' })
function applyFilter(): void {
  filter.value = { query: filterDraft.value.query, brand: filterDraft.value.brand,
    ...(filterDraft.value.decade ? { decade: filterDraft.value.decade === 'unknown' ? 'unknown' as const : Number(filterDraft.value.decade) } : {}) }
  void inventory.load(0)
}
function clearFilter(): void { filterDraft.value = { query: '', brand: '', decade: '' }; applyFilter() }
const musicId = ref<string>()
const musicNavigation = ref(0)
function showRecording(id: string): void { musicId.value = id; musicNavigation.value++; selectedView.value = 'music' }
function showModel(id: string): void { selectedView.value = 'tapes'; void inventory.openModel(id) }
const receiving = ref(false)
const receiveModel = ref<CollectionModel>()
function beginReceive(model?: CollectionModel): void { receiveModel.value = model; receiving.value = true }
async function receive(request: CollectionReceiveRequest): Promise<void> {
  if (await inventory.mutate(() => window.musicBridge.receiveCollectionStock(request))) receiving.value = false
}
async function retry(): Promise<void> { if (await inventory.retry()) receiving.value = false }

const selectedView = defineModel<'tapes' | 'music'>({ required: true })
const tabs = ref<HTMLElement | null>(null)
const views = [
  { id: 'tapes', label: '空白磁带收藏' },
  { id: 'music', label: '实体音乐库' },
] as const

function onTabKeydown(event: KeyboardEvent): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  selectedView.value = event.key === 'Home' ? 'tapes'
    : event.key === 'End' ? 'music'
      : selectedView.value === 'tapes' ? 'music' : 'tapes'
  void nextTick(() => tabs.value?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus())
}
</script>

<template>
  <section class="collection-view" data-component="CollectionView" aria-label="实体收藏">
    <div class="collection-context">
    <div ref="tabs" class="collection-tabs" role="tablist" aria-label="收藏视图">
      <button
        v-for="view in views" :id="`collection-tab-${view.id}`" :key="view.id"
        type="button" role="tab" :aria-selected="selectedView === view.id"
        :aria-controls="`collection-panel-${view.id}`" :tabindex="selectedView === view.id ? 0 : -1"
        @click="selectedView = view.id" @keydown="onTabKeydown"
      >{{ view.label }}</button>
    </div>
    <div class="collection-tools"><button ref="spreadsheetTrigger" class="reference-entry" type="button" @click="spreadsheetOpen = true">Excel 导入</button>
    <button ref="referenceTrigger" class="reference-entry" type="button" @click="referenceOpen = true">参考目录与版次</button>
    <button ref="progressTrigger" class="reference-entry" type="button" @click="progressOpen = true">完成度与求购</button></div>
    </div>

    <div
      v-for="view in views" v-show="selectedView === view.id" :id="`collection-panel-${view.id}`" :key="view.id"
      class="collection-panel" role="tabpanel" :aria-labelledby="`collection-tab-${view.id}`" tabindex="0"
    >
      <div v-if="view.id === 'tapes'" class="inventory-feedback" aria-live="polite">
        <p v-if="error" role="alert">{{ error }} <button v-if="pending && !receiving" :disabled="saving" @click="retry">重试原操作</button><button v-else-if="!pending" :disabled="loading" @click="inventory.load(); detail && inventory.openModel(detail.model.id)">刷新库存</button></p>
        <p v-else-if="notice" role="status">{{ notice }}</p>
      </div>
      <CollectionModelDetail v-if="view.id === 'tapes' && detail" :detail="detail" :busy="blocked"
        @show-recording="showRecording" @close="inventory.closeModel" @receive="beginReceive(detail.model)" @page="inventory.openModel(detail.model.id, $event)"
        @materialize="request => inventory.mutate(() => collectionApi.materializeCollectionCopy(request))"
        @update-copy="request => inventory.mutate(() => collectionApi.updateCollectionCopy(request))"
        @add-photo="inventory.addPhoto"
        @change-photo="request => inventory.mutate(() => collectionApi.changeCollectionPhoto(request))"
        @policy="request => inventory.mutate(() => collectionApi.setCollectionPolicy(request))" />
      <PhysicalMusicView :key="musicNavigation" v-if="view.id === 'music'" :requested-id="musicId" :active="selectedView === 'music'" @model="showModel" />
      <header v-if="view.id === 'tapes' && !detail" class="collection-heading">
        <div>
          <p class="collection-kicker">磁带收藏</p>
          <h2>每一盘，都值得留下。</h2>
          <p>按型号与版次收藏，记录每盘磁带的状态与故事。</p>
        </div>
        <button class="collection-add" type="button" :disabled="blocked || !catalog" @click="beginReceive()">
          <span aria-hidden="true">＋</span> 添加磁带
        </button>
      </header>

      <template v-if="view.id === 'tapes' && !detail">
        <form class="inventory-filters" aria-label="筛选磁带收藏" @submit.prevent="applyFilter">
          <label>关键词<input v-model.trim="filterDraft.query" maxlength="120" placeholder="品牌、型号或版次"></label>
          <label>品牌<input v-model.trim="filterDraft.brand" maxlength="120" placeholder="输入品牌全名"></label>
          <label>年代<select v-model="filterDraft.decade"><option value="">全部年代</option><option value="unknown">年代待确认</option><option v-for="decade in [1950, 1960, 1970, 1980, 1990, 2000, 2010, 2020, 2030]" :key="decade" :value="String(decade)">{{ decade }} 年代</option></select></label>
          <button type="submit" :disabled="loading">筛选</button><button type="button" :disabled="loading" @click="clearFilter">清除</button>
        </form>
        <p v-if="loading" role="status" class="collection-status">正在读取库存…</p>
        <div v-if="catalog?.items.length" class="inventory-grid">
          <button v-for="model in catalog.items" :key="model.id" class="inventory-card" type="button" @click="inventory.openModel(model.id)">
            <div v-if="model.featuredPhoto" class="inventory-card-photo"><CollectionPhoto :photo="model.featuredPhoto" :alt="`${collectionModelLabel(model)} 实物代表图`" /></div>
            <div v-else class="inventory-placeholder" aria-hidden="true"><svg viewBox="0 0 220 130" fill="none"><rect x="20" y="20" width="180" height="95" rx="12" stroke="currentColor"/><rect x="36" y="35" width="148" height="48" rx="8" stroke="currentColor"/><circle cx="64" cy="59" r="14" stroke="currentColor"/><circle cx="156" cy="59" r="14" stroke="currentColor"/><path d="M78 59h64M55 115l10-20h90l10 20" stroke="currentColor"/></svg><span>实物照片待添加</span></div>
            <span v-if="model.featuredPhoto" class="inventory-photo-source">实物照片{{ model.featuredPhoto.physicalId ? ` · ${model.featuredPhoto.physicalId}` : '' }}</span>
            <span class="inventory-card-title">{{ collectionModelLabel(model) }}</span>
            <span class="inventory-card-edition">{{ model.edition || '版次待确认' }} · {{ model.lengths.map(n => n ? `${n} min` : '时长待确认').join(' / ') }}</span>
            <span class="inventory-card-counts"><span>未开封 <b>{{ model.counts.sealedBlank }}</b></span><span>已拆空白 <b>{{ model.counts.openedBlank }}</b></span><span>全部 <b>{{ model.counts.total }}</b></span></span>
          </button>
        </div>
        <nav v-if="catalog && catalog.total > catalog.limit" class="inventory-pagination" aria-label="收藏分页"><button :disabled="loading || catalog.offset === 0" @click="inventory.load(Math.max(0, catalog.offset - catalog.limit))">上一页</button><span>{{ Math.floor(catalog.offset / catalog.limit) + 1 }} / {{ Math.ceil(catalog.total / catalog.limit) }}</span><button :disabled="loading || !catalog.hasMore" @click="inventory.load(catalog.offset + catalog.limit)">下一页</button></nav>
      </template>
      <div v-if="view.id === 'tapes' && !detail && catalog && !catalog.total" class="collection-empty">
        <!-- 线稿只表示尚未接入的页面，不冒充用户实物照片或参考品牌资源。 -->
        <svg v-if="view.id === 'tapes'" class="collection-art" viewBox="0 0 220 150" fill="none" aria-hidden="true">
          <rect x="20" y="21" width="180" height="110" rx="12" fill="currentColor" fill-opacity=".035" stroke="currentColor" stroke-opacity=".45" />
          <rect x="37" y="38" width="146" height="54" rx="7" stroke="currentColor" stroke-opacity=".35" />
          <circle cx="66" cy="65" r="16" stroke="currentColor" /><circle cx="154" cy="65" r="16" stroke="currentColor" />
          <circle cx="66" cy="65" r="6" stroke="currentColor" /><circle cx="154" cy="65" r="6" stroke="currentColor" />
          <path d="M82 65h56M57 130l12-25h82l12 25" stroke="currentColor" stroke-opacity=".6" />
        </svg>
        <h3>{{ filter.query || filter.brand || filter.decade ? '没有符合筛选的型号' : '还没有磁带库存' }}</h3>
        <p class="collection-description">{{ view.id === 'tapes' ? '实物照片成为封面。打开一个型号，就能看到未开封、已拆空白和已录磁带，以及它们录下的音乐。' : '按音乐浏览实体收藏；自录磁带保留原有型号与实体编号，不重复计算库存。' }}</p>
        <p :id="`collection-status-${view.id}`" class="collection-status">录入后打开型号，即可添加实物照片；也可清除筛选查看全部收藏。</p>
      </div>
    </div>
    <SpreadsheetImportPanel v-if="spreadsheetOpen" @close="closeSpreadsheet" @changed="inventory.load(); detail && inventory.openModel(detail.model.id)" />
    <ReferenceCatalogPanel v-if="referenceOpen" @close="closeReference" />
    <CollectionProgressPanel v-if="progressOpen" @close="closeProgress" />
    <CollectionReceiveDialog v-if="receiving" :model="receiveModel" :busy="saving" :error="error" :retryable="!!pending" @close="receiving = false" @save="receive" @retry="retry" />
  </section>
</template>

<style scoped>
.collection-view { max-width: 1240px; margin: 0 auto; padding: 24px 36px 40px; }
.collection-tools { display: flex; gap: 10px; flex-wrap: wrap; }
.collection-context { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; }
.reference-entry { min-height: 44px; padding: 8px 14px; border: 1px solid var(--mb-glass-border); border-radius: 9px; color: var(--mb-text-primary); background: var(--mb-glass-clear); font-size: 13px; }
.reference-entry:focus-visible { outline: 2px solid var(--mb-accent); outline-offset: 3px; }
.collection-tabs { display: flex; gap: 5px; width: fit-content; max-width: 100%; padding: 4px; border: 1px solid var(--mb-glass-border); border-radius: 12px; background: var(--mb-bg-base); }
.collection-tabs button { min-height: 38px; padding: 0 18px; border-radius: 8px; color: var(--mb-text-secondary); background: transparent; font-size: 13px; }
.collection-tabs button[aria-selected="true"] { color: var(--mb-text-primary); background: var(--mb-glass-strong); box-shadow: 0 2px 8px #0003; }
.collection-tabs button:hover { color: var(--mb-text-primary); }
.collection-panel { outline-offset: 6px; }
.collection-panel:focus-visible { outline: 2px solid var(--mb-accent); }
.collection-heading { display: flex; align-items: center; justify-content: space-between; gap: 24px; margin: 32px 0 28px; }
.collection-kicker { margin: 0 0 10px; color: var(--mb-accent); font-size: 12px; letter-spacing: .08em; }
h2 { margin: 0; font-size: clamp(22px, 2.4vw, 30px); letter-spacing: -.035em; line-height: 1.3; }
.collection-heading p:not(.collection-kicker) { margin: 12px 0 0; color: var(--mb-text-secondary); font-size: 13px; line-height: 1.7; }
.collection-add { flex: 0 0 auto; min-height: 38px; padding: 0 15px; border: 1px solid var(--mb-glass-border); border-radius: 9px; color: var(--mb-text-primary); background: var(--mb-glass-clear); font-size: 13px; }
.collection-empty { display: flex; min-height: 350px; align-items: center; flex-direction: column; justify-content: center; padding: 36px 24px; border: 1px solid var(--mb-glass-border); border-radius: 18px; background: var(--mb-bg-base); text-align: center; }
.collection-art { width: 200px; max-width: 70%; height: 138px; margin-bottom: 22px; color: #92aab6; }
h3 { margin: 0; font-size: 19px; font-weight: 550; letter-spacing: -.02em; }
.collection-description { max-width: 395px; margin: 14px 0 0; color: var(--mb-text-secondary); font-size: 13px; line-height: 1.9; }
.collection-status { max-width: 460px; margin: 28px 0 0; padding-top: 18px; border-top: 1px solid var(--mb-divider); color: var(--mb-text-secondary); font-size: 12px; line-height: 1.8; }
.inventory-feedback { font-size: 13px; color: var(--mb-text-primary); line-height: 1.8; }
.inventory-feedback button, .inventory-pagination button { min-height: 38px; padding: 8px 12px; border: 1px solid var(--mb-glass-border); border-radius: 8px; background: var(--mb-glass-clear); color: var(--mb-text-primary); }
.inventory-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(230px, 100%), 1fr)); gap: 20px; }
.inventory-card { display: flex; flex-direction: column; min-width: 0; padding: 0; overflow: hidden; border: 1px solid var(--mb-glass-border); border-radius: 14px; background: var(--mb-bg-base); color: var(--mb-text-primary); text-align: left; }
.inventory-card:hover { border-color: var(--mb-accent); }
.inventory-placeholder { display: flex; flex-direction: column; align-items: center; justify-content: center; width: 100%; aspect-ratio: 1.6; background: var(--mb-glass-clear); color: var(--mb-text-secondary); font-size: 12px; }
.inventory-placeholder svg { width: 70%; max-height: 150px; opacity: .65; }
.inventory-card-photo { box-sizing: border-box; width: 100%; aspect-ratio: 1.6; padding: 12px; background: var(--mb-bg-base); }
.inventory-photo-source { padding: 8px 18px 0; font-size: 12px; color: var(--mb-accent); }
.inventory-filters { display: flex; align-items: end; flex-wrap: wrap; gap: 12px; margin: 0 0 24px; }
.inventory-filters label { display: grid; gap: 7px; min-width: 120px; flex: 1; font-size: 12px; color: var(--mb-text-secondary); }
.inventory-filters input, .inventory-filters select { box-sizing: border-box; width: 100%; min-width: 0; min-height: 40px; padding: 8px 10px; border: 1px solid var(--mb-glass-border); border-radius: 8px; background: var(--mb-bg-base); color: var(--mb-text-primary); font: inherit; }
.inventory-filters button { min-height: 40px; padding: 8px 14px; border: 1px solid var(--mb-glass-border); border-radius: 8px; background: var(--mb-glass-clear); color: var(--mb-text-primary); font-size: 12px; }
.inventory-card-title { padding: 18px 18px 0; font-size: 17px; font-weight: 600; overflow-wrap: anywhere; }
.inventory-card-edition { padding: 8px 18px; color: var(--mb-text-secondary); font-size: 12px; overflow-wrap: anywhere; }
.inventory-card-counts { display: flex; flex-wrap: wrap; gap: 12px; margin: 8px 18px 18px; padding-top: 12px; border-top: 1px solid var(--mb-divider); color: var(--mb-text-secondary); font-size: 12px; }
.inventory-card-counts b { color: var(--mb-text-primary); font-variant-numeric: tabular-nums; }
.inventory-pagination { display: flex; justify-content: center; align-items: center; gap: 20px; margin-top: 24px; font-size: 13px; }
@media (max-width: 900px) {
  .collection-view { padding: 20px; }
  .collection-heading { flex-wrap: wrap; gap: 16px; margin: 26px 0 22px; }
  .collection-empty { padding: 26px 18px; }
}
</style>
