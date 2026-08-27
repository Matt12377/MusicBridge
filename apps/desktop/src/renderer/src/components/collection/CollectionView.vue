<script setup lang="ts">
import { nextTick, ref } from 'vue'
import type { CollectionModel, CollectionReceiveRequest } from '@music-bridge/contracts'
import { useCollection } from '../../composables/useCollection'
import CollectionReceiveDialog from './CollectionReceiveDialog.vue'
import CollectionModelDetail from './CollectionModelDetail.vue'

const inventory = useCollection()
const collectionApi = window.musicBridge
const { catalog, detail, loading, saving, error, notice, pending, blocked } = inventory
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
    <div ref="tabs" class="collection-tabs" role="tablist" aria-label="收藏视图">
      <button
        v-for="view in views" :id="`collection-tab-${view.id}`" :key="view.id"
        type="button" role="tab" :aria-selected="selectedView === view.id"
        :aria-controls="`collection-panel-${view.id}`" :tabindex="selectedView === view.id ? 0 : -1"
        @click="selectedView = view.id" @keydown="onTabKeydown"
      >{{ view.label }}</button>
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
        @close="inventory.closeModel" @receive="beginReceive(detail.model)" @page="inventory.openModel(detail.model.id, $event)"
        @materialize="request => inventory.mutate(() => collectionApi.materializeCollectionCopy(request))"
        @update-copy="request => inventory.mutate(() => collectionApi.updateCollectionCopy(request))"
        @policy="request => inventory.mutate(() => collectionApi.setCollectionPolicy(request))" />
      <header v-if="view.id !== 'tapes' || !detail" class="collection-heading">
        <div>
          <p class="collection-kicker">{{ view.id === 'tapes' ? '磁带收藏' : '音乐与实物' }}</p>
          <h2>{{ view.id === 'tapes' ? '每一盘，都值得留下。' : '让音乐，有一个实体位置。' }}</h2>
          <p>{{ view.id === 'tapes' ? '按型号与版次收藏，记录每盘磁带的状态与故事。' : '原版 CD、原版磁带与自录作品，在这里与数字音乐相连。' }}</p>
        </div>
        <button class="collection-add" type="button" :disabled="view.id === 'music' || blocked || !catalog" @click="beginReceive()">
          <span aria-hidden="true">＋</span> {{ view.id === 'tapes' ? '添加磁带' : '添加实体音乐' }}
        </button>
      </header>

      <template v-if="view.id === 'tapes' && !detail">
        <p v-if="loading" role="status" class="collection-status">正在读取库存…</p>
        <div v-if="catalog?.items.length" class="inventory-grid">
          <button v-for="model in catalog.items" :key="model.id" class="inventory-card" type="button" @click="inventory.openModel(model.id)">
            <div class="inventory-placeholder" aria-hidden="true"><svg viewBox="0 0 220 130" fill="none"><rect x="20" y="20" width="180" height="95" rx="12" stroke="currentColor"/><rect x="36" y="35" width="148" height="48" rx="8" stroke="currentColor"/><circle cx="64" cy="59" r="14" stroke="currentColor"/><circle cx="156" cy="59" r="14" stroke="currentColor"/><path d="M78 59h64M55 115l10-20h90l10 20" stroke="currentColor"/></svg><span>实物照片待添加</span></div>
            <span class="inventory-card-title">{{ model.brand }} {{ model.name }}</span>
            <span class="inventory-card-edition">{{ model.edition || '版次待确认' }} · {{ model.lengths.map(n => n ? `${n} min` : '时长待确认').join(' / ') }}</span>
            <span class="inventory-card-counts"><span>未开封 <b>{{ model.counts.sealedBlank }}</b></span><span>已拆空白 <b>{{ model.counts.openedBlank }}</b></span><span>全部 <b>{{ model.counts.total }}</b></span></span>
          </button>
        </div>
        <nav v-if="catalog && catalog.total > catalog.limit" class="inventory-pagination" aria-label="收藏分页"><button :disabled="loading || catalog.offset === 0" @click="inventory.load(Math.max(0, catalog.offset - catalog.limit))">上一页</button><span>{{ Math.floor(catalog.offset / catalog.limit) + 1 }} / {{ Math.ceil(catalog.total / catalog.limit) }}</span><button :disabled="loading || !catalog.hasMore" @click="inventory.load(catalog.offset + catalog.limit)">下一页</button></nav>
      </template>
      <div v-if="view.id === 'music' || (!detail && catalog && !catalog.total)" class="collection-empty">
        <!-- 线稿只表示尚未接入的页面，不冒充用户实物照片或参考品牌资源。 -->
        <svg v-if="view.id === 'tapes'" class="collection-art" viewBox="0 0 220 150" fill="none" aria-hidden="true">
          <rect x="20" y="21" width="180" height="110" rx="12" fill="currentColor" fill-opacity=".035" stroke="currentColor" stroke-opacity=".45" />
          <rect x="37" y="38" width="146" height="54" rx="7" stroke="currentColor" stroke-opacity=".35" />
          <circle cx="66" cy="65" r="16" stroke="currentColor" /><circle cx="154" cy="65" r="16" stroke="currentColor" />
          <circle cx="66" cy="65" r="6" stroke="currentColor" /><circle cx="154" cy="65" r="6" stroke="currentColor" />
          <path d="M82 65h56M57 130l12-25h82l12 25" stroke="currentColor" stroke-opacity=".6" />
        </svg>
        <svg v-else class="collection-art" viewBox="0 0 220 150" fill="none" aria-hidden="true">
          <rect x="25" y="18" width="112" height="114" rx="7" fill="currentColor" fill-opacity=".035" stroke="currentColor" stroke-opacity=".4" />
          <path d="M37 18v114M51 41h60M51 51h42" stroke="currentColor" stroke-opacity=".35" />
          <circle cx="141" cy="78" r="53" fill="var(--mb-bg-base)" stroke="currentColor" stroke-opacity=".6" />
          <circle cx="141" cy="78" r="42" stroke="currentColor" stroke-opacity=".15" /><circle cx="141" cy="78" r="13" stroke="currentColor" />
          <circle cx="141" cy="78" r="4" stroke="currentColor" />
        </svg>
        <h3>{{ view.id === 'tapes' ? '还没有磁带库存' : '这里将保存你拥有的音乐' }}</h3>
        <p class="collection-description">{{ view.id === 'tapes' ? '实物照片成为封面。打开一个型号，就能看到未开封、已拆空白和已录磁带，以及它们录下的音乐。' : '按音乐浏览实体收藏；自录磁带保留原有型号与实体编号，不重复计算库存。' }}</p>
        <p :id="`collection-status-${view.id}`" class="collection-status">{{ view.id === 'tapes' ? '从一批磁带开始录入。实物照片管理将在后续任务接入。' : '实体音乐关联与照片管理尚未接入，当前不展示示例库存。' }}</p>
      </div>
    </div>
    <CollectionReceiveDialog v-if="receiving" :model="receiveModel" :busy="saving" :error="error" :retryable="!!pending" @close="receiving = false" @save="receive" @retry="retry" />
  </section>
</template>

<style scoped>
.collection-view { max-width: 1240px; margin: 0 auto; padding: 24px 36px 40px; }
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
