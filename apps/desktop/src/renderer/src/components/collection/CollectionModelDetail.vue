<script setup lang="ts">
import { canManuallyReceiveModel, collectionModelLabel } from './collection-display'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { CollectionChangePhotoRequest, CollectionCopy, CollectionDetail, CollectionMaterializeRequest, CollectionModelLengths, CollectionPolicyRequest, CollectionUpdateCopyRequest, CollectorPolicy } from '@music-bridge/contracts'
import CollectionPhotos from './CollectionPhotos.vue'
import CollectionPhotoView from './CollectionPhoto.vue'
import CollectionReferenceImage from './CollectionReferenceImage.vue'
import { referenceImageCaption, type IllustratedReference } from './reference-images'
import type { RecordingPhysicalSelection, RecordingReservationSelection } from './collection-recording-navigation'

const props = withDefaults(defineProps<{ detail: CollectionDetail; busy: boolean; referenceCandidates?: readonly IllustratedReference[]; focusPhysicalId?: string }>(), { referenceCandidates: () => [], focusPhysicalId: '' })
const emit = defineEmits<{ showRecords: [physicalId: string]; showRecording: [physicalId: string]; startRecording: [selection: RecordingPhysicalSelection]; openReservation: [selection: RecordingReservationSelection]; close: []; receive: []; page: [offset: number]; materialize: [request: CollectionMaterializeRequest]; updateCopy: [request: CollectionUpdateCopyRequest]; policy: [request: CollectionPolicyRequest]; addPhoto: [physicalId?: string]; changePhoto: [request: CollectionChangePhotoRequest] }>()
const pages = [{ id: 'overview', label: '概览' }, { id: 'inventory', label: '我的库存' }, { id: 'copies', label: '实体磁带' }, { id: 'photos', label: '资料照片' }] as const
type DetailPage = typeof pages[number]['id']
const activePage = ref<DetailPage>('overview'), pageTabs = ref<HTMLElement>()
watch(() => props.detail.model.id, () => { activePage.value = props.focusPhysicalId ? 'copies' : 'overview' })
watch(() => props.focusPhysicalId, id => { if (id) activePage.value = 'copies' }, { immediate: true })
function selectPage(id: DetailPage): void {
  if (activePage.value === id) return
  activePage.value = id
  // 分页只属于库存或实体页面；切换时回到该页第一批，避免沿用另一页的越界偏移。
  if ((id === 'inventory' || id === 'copies') && props.detail.lots.offset !== 0) emit('page', 0)
}
function onPageKeydown(event: KeyboardEvent): void {
  const current = pages.findIndex(page => page.id === activePage.value)
  const next = event.key === 'ArrowRight' ? (current + 1) % pages.length
    : event.key === 'ArrowLeft' ? (current + pages.length - 1) % pages.length
    : event.key === 'Home' ? 0 : event.key === 'End' ? pages.length - 1 : -1
  if (next < 0) return
  event.preventDefault(); selectPage(pages[next]!.id)
  pageTabs.value?.querySelector<HTMLButtonElement>(`#model-detail-tab-${pages[next]!.id}`)?.focus({ preventScroll: true })
}
const policy = ref<CollectorPolicy>('normal')
const reserve = ref(0)
watch(() => props.detail.model, model => { policy.value = model.collectorPolicy; reserve.value = model.minimumSealedReserve }, { immediate: true })
const protectedSealed = computed(() => ['collector', 'preserve-sealed'].includes(props.detail.model.collectorPolicy) || props.detail.model.counts.sealedBlank <= props.detail.model.minimumSealedReserve)
const manualReceiveAllowed = computed(() => canManuallyReceiveModel(props.detail.model))
const currentLengths = ref<CollectionModelLengths>(), lengthsLoading = ref(false), lengthsError = ref('')
let lengthsRead = 0, alive = true
async function loadLengths(): Promise<void> {
  const read = ++lengthsRead, modelId = props.detail.model.id
  currentLengths.value = undefined; lengthsLoading.value = true; lengthsError.value = ''
  try { const result = await window.musicBridge.getCollectionModelLengths({ modelId }); if (alive && read === lengthsRead && result.modelId === modelId) currentLengths.value = result }
  catch { if (alive && read === lengthsRead) lengthsError.value = '当前持有长度读取失败，请重试；不能据此判断为零或推断长度覆盖。' }
  finally { if (alive && read === lengthsRead) lengthsLoading.value = false }
}
onMounted(() => { watch(() => props.detail, () => { void loadLengths() }, { immediate: true }) })
onBeforeUnmount(() => { alive = false; lengthsRead++ })
const visiblePage = computed(() => activePage.value === 'inventory' ? props.detail.lots : props.detail.copies)
const countItems = [
  ['total', '全部实物', 'total'], ['sealedBlank', '未开封空白', 'sealed'], ['openedBlank', '已拆空白', 'opened'],
  ['legacyUsed', '旧录音待登记', 'legacy'], ['recorded', '已录音', 'recorded'], ['reserved', '已预留', 'reserved'], ['unknown', '未分类', 'unknown'], ['unavailable', '不可用', 'unavailable'],
] as const
function materialize(lotId: string, bucket: CollectionMaterializeRequest['bucket'], action: CollectionMaterializeRequest['action']): void {
  emit('materialize', { commandId: crypto.randomUUID(), lotId, bucket, action })
}
function update(copy: CollectionCopy, action: CollectionUpdateCopyRequest['action']): void {
  emit('updateCopy', { commandId: crypto.randomUUID(), physicalId: copy.physicalId, expectedRevision: copy.revision, action })
}
function startRecording(copy: CollectionCopy): void {
  if (!copy.available || !['blank', 'erased'].includes(copy.usage) || copy.packaging === 'unknown' || props.detail.model.collectorPolicy === 'collector' || copy.packaging === 'sealed' && protectedSealed.value) return
  emit('startRecording', { physicalId: copy.physicalId, physicalRevision: copy.revision, modelId: props.detail.model.id, skuId: copy.skuId, packaging: copy.packaging })
}
function openReservation(copy: CollectionCopy): void {
  const owner = copy.reservationOwner
  if (copy.usage !== 'reserved' || owner?.kind !== 'recording-plan' || copy.packaging === 'unknown') return
  emit('openReservation', { physicalId: copy.physicalId, physicalRevision: copy.revision, modelId: props.detail.model.id,
    skuId: copy.skuId, packaging: copy.packaging, draftId: owner.draftId, planId: owner.planId })
}
function savePolicy(): void {
  emit('policy', { commandId: crypto.randomUUID(), modelId: props.detail.model.id, expectedRevision: props.detail.model.revision, collectorPolicy: policy.value, minimumSealedReserve: Number(reserve.value) })
}
function state(copy: CollectionCopy): string {
  if (!copy.available) return '不可用'
  return { blank: copy.packaging === 'sealed' ? '未开封空白' : '已拆空白', reserved: '已预留', recorded: copy.recordingTitle ? `已录音 · ${copy.recordingTitle}` : '已录音，内容待补录', unknown: '状态待确认', erased: '已擦除空白' }[copy.usage]
}
</script>

<template>
  <section class="model-detail" aria-label="磁带型号详情">
    <div class="detail-toolbar"><button class="back" type="button" @click="emit('close')">← 返回收藏</button></div>
    <header class="detail-hero">
      <div class="hero-media"><CollectionPhotoView v-if="detail.model.featuredPhoto" :photo="detail.model.featuredPhoto" :alt="`${collectionModelLabel(detail.model)} 实物代表图`" /><CollectionReferenceImage v-else-if="referenceCandidates[0]" :reference="referenceCandidates[0]" /><div v-else class="hero-placeholder" aria-hidden="true"><span class="placeholder-shell"><i></i><i></i></span></div><span class="photo-label">{{ detail.model.featuredPhoto ? '用户实物照片' : referenceCandidates[0] ? '书籍参考图 · 非持有实物证据' : '示意占位 · 非实物照片' }}</span></div>
      <div class="hero-body"><p class="eyebrow">磁带型号 / {{ detail.model.year ?? '年代待确认' }}</p><h2>{{ collectionModelLabel(detail.model) }}</h2><p class="muted">{{ detail.model.edition || '版次待确认' }} · {{ detail.model.format === 'dat' ? 'DAT' : '卡式磁带' }} · {{ detail.model.tapeType === 'unknown' ? '类型待确认' : detail.model.tapeType === 'dat' ? '数字磁带' : `Type ${detail.model.tapeType}` }}</p><p class="model-id">型号编号：{{ detail.model.id }}</p><p v-if="!manualReceiveAllowed" class="muted">导入型号的资料尚待确认，不能通过普通入库补充。请从 Excel 导入历史核对源行，再单独确认数量更正。</p><button class="primary" type="button" :disabled="busy || !manualReceiveAllowed" @click="emit('receive')">补充库存</button></div>
    </header>
    <nav ref="pageTabs" class="detail-nav" role="tablist" aria-label="型号详情页面">
      <button v-for="page in pages" :id="`model-detail-tab-${page.id}`" :key="page.id" type="button" role="tab"
        :aria-selected="activePage === page.id" :aria-controls="`model-detail-page-${page.id}`" :tabindex="activePage === page.id ? 0 : -1"
        @click="selectPage(page.id)" @keydown="onPageKeydown">{{ page.label }}</button>
    </nav>
    <section v-show="activePage === 'overview'" id="model-detail-page-overview" class="overview-layout detail-section" role="tabpanel" tabindex="0" aria-labelledby="model-detail-tab-overview">
    <dl class="counts"><div v-for="[key, label, testId] in countItems" :key="key"><dt>{{ label }}</dt><dd :data-testid="`inventory-${testId}`">{{ detail.model.counts[key] }}</dd></div></dl>
    <section class="current-lengths" aria-labelledby="current-lengths-title"><h3 id="current-lengths-title">当前真实持有长度</h3><p class="muted">按目前持有数量统计；旧批次曾出现的长度不代表现在仍然拥有。</p><p v-if="lengthsLoading" role="status">正在读取当前持有长度…</p><p v-else-if="lengthsError" role="alert">{{ lengthsError }}</p><template v-else-if="currentLengths"><p>当前持有总量 {{ currentLengths.total }} 盘 · 未知长度 {{ currentLengths.unknownLengthQty }} 盘</p><ul><li v-for="length in currentLengths.lengths" :key="length.lengthMinutes">{{ length.lengthMinutes }} 分钟 · {{ length.quantity }} 盘</li></ul><p v-if="!currentLengths.lengths.length" class="muted">没有已确认长度的当前持有记录，不代表已集齐任何长度。</p></template><p v-else class="muted">当前持有长度尚未读取。</p><button :disabled="lengthsLoading" @click="loadLengths">刷新持有长度</button></section>


    <details class="policy"><summary>收藏保护设置</summary><form @submit.prevent="savePolicy">
      <label>收藏策略<select v-model="policy" :disabled="busy"><option value="normal">正常使用</option><option value="prefer-opened">优先已拆空白</option><option value="preserve-sealed">封存未开封磁带</option><option value="collector">仅收藏，不用于录音</option></select></label>
      <label>最低未开封保留数量<input v-model.number="reserve" type="number" min="0" max="1000000" step="1" required :disabled="busy"></label>
      <button type="submit" :disabled="busy">保存保护设置</button>
    </form><p class="muted">保护规则会阻止拆封和录音预留，但仍允许建立实体档案。</p></details>

    </section>

    <section v-show="activePage === 'inventory'" id="model-detail-page-inventory" class="detail-section" role="tabpanel" tabindex="0" aria-labelledby="model-detail-tab-inventory">
    <div class="section-heading"><h3>批次库存</h3><span class="muted">{{ detail.lots.total }} 个批次</span></div>
    <p class="muted">只登记你已确认的实物状态。“拆封一盘”会将未开封数量减一，并建立一盘已拆空白档案；总数不变。</p>
    <p v-if="protectedSealed" class="muted">当前封存保护或最低保留数量已生效。</p>
    <p v-if="!detail.lots.items.length" class="muted">本页没有批次。</p>
    <article v-for="lot in detail.lots.items" :key="lot.id" class="lot">
      <header><strong>{{ lot.lengthMinutes ? `${lot.lengthMinutes} 分钟` : '时长待确认' }}</strong><span class="muted">入库 {{ lot.quantityAcquired }} 盘</span></header>
      <div class="lot-row"><span>未开封空白 <b>{{ lot.quantities.sealedBlank }}</b></span><div><button :disabled="busy || !lot.quantities.sealedBlank" @click="materialize(lot.id, 'sealedBlank', 'identify')">建立未拆档案</button><button :disabled="busy || !lot.quantities.sealedBlank || protectedSealed" @click="materialize(lot.id, 'sealedBlank', 'open')">拆封一盘</button></div></div>
      <div class="lot-row"><span>已拆空白 <b>{{ lot.quantities.openedBlank }}</b></span><button :disabled="busy || !lot.quantities.openedBlank" @click="materialize(lot.id, 'openedBlank', 'identify')">建立空白档案</button></div>
      <div class="lot-row"><span>旧录音待登记 <b>{{ lot.quantities.legacyUsed }}</b></span><button :disabled="busy || !lot.quantities.legacyUsed" @click="materialize(lot.id, 'legacyUsed', 'register-legacy')">登记旧录音</button></div>
      <div class="lot-row"><span>未分类 <b>{{ lot.quantities.unclassified }}</b></span><button :disabled="busy || !lot.quantities.unclassified" @click="materialize(lot.id, 'unclassified', 'identify')">建立待确认档案</button></div>
    </article>

    </section>

    <section v-show="activePage === 'copies'" id="model-detail-page-copies" class="detail-section" role="tabpanel" tabindex="0" aria-labelledby="model-detail-tab-copies">
    <div class="section-heading"><h3>单盘档案</h3><span class="muted">{{ detail.copies.total }} 盘已建立档案</span></div>
    <p v-if="!detail.copies.total" class="muted">尚未建立单盘档案。批次数量已计入库存，无需逐盘编号。</p>
    <p v-else-if="!detail.copies.items.length" class="muted">本页没有单盘档案。</p>
    <article v-for="copy in detail.copies.items" :key="copy.physicalId" class="copy" :data-returned-copy="focusPhysicalId === copy.physicalId ? 'true' : undefined" :tabindex="focusPhysicalId === copy.physicalId ? -1 : undefined">
      <div><strong>{{ copy.physicalId }}</strong><p class="muted">{{ copy.lengthMinutes ? `${copy.lengthMinutes} 分钟 · ` : '' }}{{ state(copy) }}</p></div>
      <div class="copy-actions">
        <button :disabled="busy" @click="emit('showRecords', copy.physicalId)">档案与当前内容</button>
        <button v-if="copy.usage === 'recorded'" :disabled="busy" @click="emit('showRecording', copy.physicalId)">查看录音内容</button>
        <button v-if="copy.usage === 'blank' || copy.usage === 'erased'" type="button" :disabled="busy || !copy.available || copy.packaging === 'unknown' || detail.model.collectorPolicy === 'collector' || (copy.packaging === 'sealed' && protectedSealed)" @click="startRecording(copy)">用于本次录音</button>
        <button :aria-label="`添加单盘照片 ${copy.physicalId}`" :disabled="busy || (detail.model.photoCount ?? 0) >= 24" @click="emit('addPhoto', copy.physicalId)">添加照片</button>
        <button v-if="copy.usage === 'reserved' && copy.reservationOwner?.kind === 'inventory'" :disabled="busy" @click="update(copy, 'cancel-reservation')">取消库存预留</button>
        <button v-else-if="copy.usage === 'reserved' && copy.reservationOwner?.kind === 'recording-plan'" :disabled="busy" @click="openReservation(copy)">这盘的制作</button>
        <button v-else-if="copy.usage === 'reserved'" type="button" disabled title="预留归属尚未确认；不能在库存页取消预留">预留归属待核对</button>
        <button v-else-if="copy.usage === 'blank' || copy.usage === 'erased'" :disabled="busy || !copy.available || detail.model.collectorPolicy === 'collector' || (copy.packaging === 'sealed' && protectedSealed)" @click="update(copy, 'reserve')">预留</button>
        <button :disabled="busy" @click="update(copy, copy.available ? 'mark-unavailable' : 'mark-available')">{{ copy.available ? '标为不可用' : '恢复可用' }}</button>
      </div>
    </article>
    </section>
    <section v-show="activePage === 'photos'" id="model-detail-page-photos" class="detail-section photo-section" role="tabpanel" tabindex="0" aria-labelledby="model-detail-tab-photos">
    <CollectionPhotos :detail="detail" :busy="busy" @add="emit('addPhoto', $event)" @change="emit('changePhoto', $event)" />
    <section v-if="referenceCandidates.length" aria-label="书籍参考图">
      <h3>书籍参考图</h3><p class="muted">以下是同型号的书籍参考候选，不是实物照片，不代表实物版次已确认；库存数量与关联审核不会因此改变。</p>
      <div class="reference-gallery"><figure v-for="reference in referenceCandidates" :key="reference.referenceId"><CollectionReferenceImage :reference="reference" /><figcaption>{{ referenceImageCaption(reference) }} · {{ reference.edition || '书中版次未知' }} · {{ reference.pages.join('、') }}</figcaption></figure></div>
    </section>
    </section>
    <nav v-if="(activePage === 'inventory' || activePage === 'copies') && visiblePage.total > 20" class="detail-toolbar" aria-label="库存详情分页"><button :disabled="busy || visiblePage.offset === 0" @click="emit('page', Math.max(0, visiblePage.offset - 20))">上一页</button><span>{{ Math.floor(visiblePage.offset / 20) + 1 }} / {{ Math.ceil(visiblePage.total / 20) }}</span><button :disabled="busy || visiblePage.offset + 20 >= visiblePage.total" @click="emit('page', visiblePage.offset + 20)">下一页</button></nav>
  </section>
</template>

<style scoped>
.model-detail{margin-top:24px;color:var(--collection-text,var(--mb-text-primary));container-type:inline-size}.detail-toolbar,.lot header,.lot-row,.copy,.section-heading{display:flex;justify-content:space-between;align-items:center;gap:14px}.detail-toolbar{margin-bottom:20px;flex-wrap:wrap}.detail-hero{display:grid;grid-template-columns:270px minmax(0,1fr);gap:27px;align-items:center;margin-bottom:22px}.hero-media{height:188px;border-radius:12px;background:var(--collection-media,var(--mb-glass-clear));position:relative;overflow:hidden;padding:12px;box-sizing:border-box}.hero-media:deep(.collection-photo),.hero-media:deep(.reference-image){height:100%;background:transparent}.photo-label{position:absolute;bottom:7px;right:9px;padding:2px 6px;border-radius:4px;background:var(--collection-surface,var(--mb-bg-base));color:var(--collection-muted,var(--mb-text-secondary));font-size:10px}.hero-body{min-width:0}.eyebrow{font-size:11px;color:var(--collection-accent,var(--mb-accent));font-weight:700;letter-spacing:1.8px;margin:0 0 6px}.hero-body h2{font-size:30px;letter-spacing:-.5px;line-height:1.4;margin:0 0 8px}.hero-body p{margin:7px 0}.hero-body button{margin-top:10px}.model-id{font:11px/1.6 ui-monospace,SFMono-Regular,monospace;color:var(--collection-muted,var(--mb-text-secondary))}.hero-placeholder{height:100%;display:grid;place-items:center}.placeholder-shell{width:200px;height:118px;border-radius:9px;border:2px solid var(--collection-line,var(--mb-glass-border));background:var(--collection-subtle,var(--mb-glass-clear));display:flex;gap:30px;align-items:center;justify-content:center;position:relative;opacity:.65}.placeholder-shell:after{content:'';position:absolute;bottom:9px;left:40px;right:40px;height:14px;border:1px solid var(--collection-line,var(--mb-glass-border));border-radius:3px}.placeholder-shell i{width:26px;height:26px;border-radius:50%;border:7px solid var(--collection-surface,var(--mb-bg-base));background:var(--collection-line,var(--mb-glass-border))}
h2,h3,p,strong{overflow-wrap:anywhere}h3{font-size:17px;margin:0 0 12px}.muted{color:var(--collection-muted,var(--mb-text-secondary));font-size:13px;line-height:1.8}.counts{display:grid;grid-column:1/-1;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:0}.counts div{border:1px solid var(--collection-line,var(--mb-glass-border));border-radius:11px;padding:16px 19px;background:var(--collection-surface,var(--mb-bg-base))}dt{font-size:12px;color:var(--collection-muted,var(--mb-text-secondary))}dd{margin:6px 0 0;font-size:27px;line-height:1.35;font-weight:650;font-variant-numeric:tabular-nums;letter-spacing:-.7px}.detail-nav{display:flex;gap:5px;flex-wrap:wrap;border-bottom:1px solid var(--collection-line,var(--mb-glass-border));padding-bottom:12px;margin:0 0 22px}.detail-nav button{border-color:transparent;background:transparent;font-size:13px;padding:9px 14px;color:var(--collection-accent,var(--mb-accent))}.detail-nav button:hover{background:var(--collection-subtle,var(--mb-glass-clear))}.detail-nav button[aria-selected='true']{background:var(--mb-accent-soft);border-color:var(--collection-accent,var(--mb-accent));font-weight:700}.overview-layout{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:22px;align-items:start}.current-lengths,.policy{border:1px solid var(--collection-line,var(--mb-glass-border));border-radius:12px;padding:21px;background:var(--collection-surface,var(--mb-bg-base));min-width:0}.current-lengths ul{list-style:none;display:flex;gap:8px;flex-wrap:wrap;padding:0;margin:16px 0}.current-lengths li{padding:6px 10px;border-radius:6px;background:var(--collection-subtle,var(--mb-glass-clear));font-size:12px;color:var(--collection-accent,var(--mb-accent))}.policy summary{cursor:pointer;font-size:14px;font-weight:600}.policy form{display:flex;flex-wrap:wrap;align-items:end;gap:16px;margin:18px 0}label{display:grid;gap:8px;font-size:13px;min-width:0;max-width:100%}.policy label{width:100%}input,select{box-sizing:border-box;width:100%;max-width:100%;min-height:40px;padding:8px 10px;border:1px solid var(--collection-line,var(--mb-glass-border));border-radius:8px;background:var(--collection-surface,var(--mb-bg-base));color:var(--collection-text,var(--mb-text-primary));font:inherit}button{min-height:36px;padding:8px 12px;border:1px solid var(--collection-line,var(--mb-glass-border));border-radius:8px;background:var(--collection-surface,var(--mb-glass-clear));color:var(--collection-text,var(--mb-text-primary));font-size:12px;font-weight:600;cursor:pointer}button:hover{border-color:var(--collection-accent,var(--mb-accent));background:var(--collection-subtle,var(--mb-glass-clear))}button:disabled{opacity:.5;cursor:not-allowed}button.primary{background:var(--collection-accent,var(--mb-accent));border-color:var(--collection-accent,var(--mb-accent));color:var(--mb-on-accent,#fff);min-height:40px}.back{background:transparent;border-color:transparent;padding-left:0}button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid var(--collection-accent,var(--mb-accent));outline-offset:3px}.detail-section{scroll-margin-top:20px;margin-bottom:24px;min-width:0}.detail-section:focus{outline:none}.detail-section:focus-visible{outline:2px solid var(--collection-accent,var(--mb-accent));outline-offset:5px}.section-heading{margin:28px 0 12px;flex-wrap:wrap}.section-heading h3{margin:0}.section-heading>span{font-size:12px}.lot,.copy{border:1px solid var(--collection-line,var(--mb-glass-border));border-radius:12px;padding:18px;margin:12px 0;background:var(--collection-surface,var(--mb-bg-base));min-width:0}.lot header{padding-bottom:12px;border-bottom:1px solid var(--collection-line,var(--mb-glass-border));flex-wrap:wrap}.lot-row{padding-top:12px;font-size:13px;flex-wrap:wrap}.lot-row div,.copy-actions{display:flex;flex-wrap:wrap;gap:8px}b{margin-left:8px;font-variant-numeric:tabular-nums}.copy{align-items:flex-start;flex-wrap:wrap}.copy>div:first-child{min-width:0;flex:1 1 180px}.copy strong{font-family:ui-monospace,SFMono-Regular,monospace;font-size:14px}.copy p{margin-bottom:0}.copy-actions{flex:1 1 340px;justify-content:flex-end}.copy[data-returned-copy='true']{outline:2px solid var(--collection-accent,var(--mb-accent));outline-offset:3px}.photo-section{border-top:1px solid var(--collection-line,var(--mb-glass-border));padding-top:8px}.reference-gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(180px,100%),1fr));gap:16px}.reference-gallery figure{margin:0;min-width:0}.reference-gallery:deep(.reference-image){height:240px;border:1px solid var(--collection-line,var(--mb-glass-border));border-radius:9px;overflow:hidden}.reference-gallery figcaption{padding:8px 0;color:var(--collection-muted,var(--mb-text-secondary));font-size:12px;line-height:1.6;overflow-wrap:anywhere}
@container(max-width:900px){.detail-hero{grid-template-columns:210px minmax(0,1fr)}.hero-media{height:170px}.hero-body h2{font-size:25px}.overview-layout{grid-template-columns:1fr}.counts div{padding:14px}.copy-actions{justify-content:flex-start}}
@container(max-width:540px){.detail-hero{grid-template-columns:1fr;gap:18px}.hero-media{max-width:310px;width:100%}.counts{grid-template-columns:repeat(2,minmax(0,1fr))}.lot,.copy,.current-lengths,.policy{padding:16px}.detail-nav button{padding:8px 10px;font-size:12px}.copy-actions{flex-basis:100%}.lot-row>div{width:100%}.detail-hero h2{font-size:23px}}
</style>
