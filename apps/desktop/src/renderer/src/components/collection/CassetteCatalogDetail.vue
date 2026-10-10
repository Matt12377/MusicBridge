<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { CanonicalReference } from '@music-bridge/contracts'
import { cassetteAssetUrl, type CassetteReferenceAsset, type CassetteReferenceDetail } from '../../../../shared/cassette-catalog'
import CollectionReferenceImage from './CollectionReferenceImage.vue'
import { hasReferenceImage, type PublishedCassetteReference, type ReferenceCatalogSelection } from './reference-images'

const props = defineProps<{ item: PublishedCassetteReference }>()
const emit = defineEmits<{ close: []; review: [selection: ReferenceCatalogSelection]; openModel: [modelId: string]; receive: [reference: CanonicalReference] }>()
const heading = ref<HTMLHeadingElement>()
const archiveDetail = shallowRef<CassetteReferenceDetail>()
const loading = ref(false), error = ref('')
const primaryAssetFailed = ref(false)
let alive = true, readGeneration = 0
const reference = computed(() => props.item.reference)
const primaryAsset = computed(() => {
  const id = reference.value.archive?.primaryAssetId
  if (!id) return
  const assets = archiveDetail.value?.assets ?? []
  return assets.find(asset => asset.origin === 'book' && asset.id === `${id}:original`)
    ?? assets.find(asset => asset.origin === 'book' && asset.id === id)
})
const primaryAssetUrl = computed(() => primaryAsset.value ? assetUrl(primaryAsset.value) : undefined)
const bookAssets = computed(() => {
  const id = reference.value.archive?.primaryAssetId
  return archiveDetail.value?.assets.filter(asset => asset.origin === 'book' && (!id || asset.id !== id && asset.id !== `${id}:original`)) ?? []
})
const photoAssets = computed(() => archiveDetail.value?.assets.filter(asset => asset.origin === 'real-photo-reference') ?? [])
const displayAssets = computed(() => archiveDetail.value?.assets.filter(asset => asset.origin === 'opaque-display') ?? [])
const linkedModels = computed(() => props.item.current?.matches.filter(match => match.modelId !== null) ?? [])
const matchLabel = (status: string) => status === 'confirmed' ? '已确认关联' : status === 'candidate' ? '候选关联' : '待复核关联'
const ownershipLabel = computed(() => props.item.current?.state === 'owned' ? `已确认拥有 · 库存 ${props.item.current.stockCount}`
  : props.item.current?.state === 'missing' ? '已核对：明确缺少' : '拥有情况未知')
function assetUrl(asset: CassetteReferenceAsset): string | undefined {
  if (!reference.value.archive) return
  try { return cassetteAssetUrl(reference.value.archive.sha256, asset.id) } catch { return }
}
async function loadDetail(): Promise<void> {
  const generation = ++readGeneration, current = reference.value
  archiveDetail.value = undefined; primaryAssetFailed.value = false; error.value = ''; loading.value = !!current.archive
  if (!current.archive) return
  try {
    const detail = await window.musicBridge.getCassetteReferenceDetail({ sha256: current.archive.sha256, referenceId: current.referenceId })
    if (alive && generation === readGeneration) {
      if (detail.referenceId !== current.referenceId) throw new Error('REFERENCE_ID_CHANGED')
      archiveDetail.value = detail
    }
  } catch { if (alive && generation === readGeneration) error.value = '完整原书资料暂时无法读取。已发布条目与库存关联保留，请重试。' }
  finally { if (alive && generation === readGeneration) loading.value = false }
}
function review(): void { emit('review', { sourceId: props.item.source.id, referenceId: reference.value.referenceId, step: 'review' }) }
watch(() => props.item, () => { void loadDetail() }, { immediate: true })
onMounted(() => { void nextTick(() => { heading.value?.focus({ preventScroll: true }); heading.value?.scrollIntoView({ block: 'start', behavior: 'auto' }) }) })
onBeforeUnmount(() => { alive = false; readGeneration++ })
</script>

<template>
  <section class="cassette-detail" aria-labelledby="cassette-detail-title">
    <button class="back" type="button" @click="emit('close')">← 返回资料列表</button>
    <header><div><p class="eyebrow">{{ item.source.title }} · 版次 {{ item.revisionSequence }}</p><h2 id="cassette-detail-title" ref="heading" tabindex="-1">{{ reference.brand }} {{ reference.model }}</h2><p>{{ ownershipLabel }}</p></div><div class="detail-actions"><button class="primary" type="button" @click="emit('receive', reference)">添加到我的收藏</button><button type="button" @click="review">关联已有库存</button></div></header>
    <div class="overview">
      <figure class="primary-image"><img v-if="primaryAssetUrl && !primaryAssetFailed" class="primary-original" :src="primaryAssetUrl" :alt="`${reference.brand} ${reference.model} 原书主图，非我的实物照片`" @error="primaryAssetFailed = true"><CollectionReferenceImage v-else :reference="reference" /><figcaption>{{ hasReferenceImage(reference) ? '原书主图 · 资料参考，非我的实物照片' : archiveDetail?.missingPrimaryReason || '主图尚缺 · 资料条目保留' }}<small v-if="primaryAssetFailed">原书原图暂时无法读取，当前保留资料缩略图。</small></figcaption></figure>
      <dl class="metadata">
        <div><dt>品牌 / 系列</dt><dd>{{ reference.brand }} / {{ reference.series || '系列未提供' }}</dd></div>
        <div><dt>资料版次</dt><dd>{{ reference.edition || '版次未提供' }}</dd></div>
        <div><dt>原书年代标注</dt><dd>{{ archiveDetail?.bookYearLabel ?? reference.era ?? '未提供' }}</dd></div>
        <div><dt>带型 / 时长</dt><dd>{{ reference.iec === 'unknown' ? '带型未知' : reference.iec === 'dat' ? 'DAT' : `IEC ${reference.iec}` }} · {{ reference.lengths.length ? `${reference.lengths.join(' / ')} 分钟` : '时长未知' }}</dd></div>
        <div><dt>原书来源页</dt><dd>{{ reference.pages.join('、') || '页码未提供' }}</dd></div>
        <div><dt>资料来源</dt><dd>{{ archiveDetail?.bookTitle || item.source.title }} · {{ archiveDetail?.sourceVersion || item.source.sourceVersion }}</dd></div>
        <div><dt>参考 ID</dt><dd>{{ reference.referenceId }}</dd></div>
      </dl>
    </div>
    <p class="evidence-note">年份为原书标注，不作为生产年确认。图片与资料用于比对；库存状态和实物版次仍需核实。</p>
    <p v-if="loading" role="status">正在读取完整原书资料与图片来源…</p>
    <p v-if="error" class="error" role="alert">{{ error }} <button type="button" @click="loadDetail">重试完整资料</button></p>
    <section v-if="archiveDetail" class="evidence" aria-label="版次与时长依据"><h3>资料依据</h3><p>版次依据：{{ archiveDetail.editionBasis || '未提供' }}</p><p>时长依据：{{ archiveDetail.lengthsEvidence || '未提供' }}</p><p v-if="archiveDetail.missingPrimaryReason">缺主图原因：{{ archiveDetail.missingPrimaryReason }}</p></section>
    <template v-if="archiveDetail">
      <section v-for="(section, index) in archiveDetail.sections" :key="index" class="transcription"><h3>{{ section.title || '原书资料' }}</h3><p>{{ section.text }}</p></section>
      <section v-if="bookAssets.length" aria-label="原书辅助图"><h3>原书辅助图</h3><div class="asset-gallery"><figure v-for="asset in bookAssets" :key="asset.id"><img :src="assetUrl(asset)" :alt="`${reference.brand} ${reference.model} 原书辅助图：${asset.caption}`" loading="lazy"><figcaption>{{ asset.caption || '原书辅助图' }}<small>原书资料 · {{ asset.source || item.source.title }}</small></figcaption></figure></div></section>
      <section aria-label="真实照片参考"><h3>真实照片参考</h3><p>用于核对外观，不代表当前拥有，也不替代我的实物照片。</p><div v-if="photoAssets.length" class="asset-gallery"><figure v-for="asset in photoAssets" :key="asset.id"><img :src="assetUrl(asset)" :alt="`${reference.brand} ${reference.model} 真实照片参考：${asset.caption}`" loading="lazy"><figcaption>{{ asset.caption || '真实照片参考' }}<small>照片来源：{{ asset.source || '来源未提供' }}</small></figcaption></figure></div><p v-else>此条目没有已归档的真实照片参考。</p></section>
      <section v-if="displayAssets.length" aria-label="展示用素材"><h3>展示用素材</h3><p>这些图片用于展示，保留独立来源；原书图仍按原样保留。</p><div class="asset-gallery"><figure v-for="asset in displayAssets" :key="asset.id"><img :src="assetUrl(asset)" :alt="`${reference.brand} ${reference.model} 展示用素材：${asset.caption}`" loading="lazy"><figcaption>{{ asset.caption || '展示用素材' }}<small>展示素材 · {{ asset.source || '来源未提供' }}</small></figcaption></figure></div></section>
      <section v-if="archiveDetail.unknownFields.length" class="evidence" aria-label="保留的未知信息"><h3>仍未知的信息</h3><ul><li v-for="(field, index) in archiveDetail.unknownFields" :key="index">{{ field }}</li></ul></section>
    </template>
    <section v-else-if="!reference.archive && reference.notes" class="transcription"><h3>资料说明</h3><p>{{ reference.notes }}</p></section>
    <section class="associations" aria-label="已有库存关联"><h3>已有库存关联</h3><p v-if="!linkedModels.length">尚未关联已有库存。可以在参考目录里逐条核对，不会自动创建库存。</p><div v-else class="linked-models"><button v-for="match in linkedModels" :key="`${match.modelId}-${match.status}`" type="button" @click="match.modelId && emit('openModel', match.modelId)">{{ matchLabel(match.status) }} · 查看已有型号</button></div><p v-if="linkedModels.some(match => match.status !== 'confirmed')">候选与待复核关联保留未知状态，不计为明确拥有。</p></section>
  </section>
</template>

<style scoped>
.cassette-detail { color: var(--collection-text); font-size: 13px; line-height: 1.75; } header { display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 16px; margin: 18px 0 24px; } h2 { margin: 0; font-size: 28px; line-height: 1.4; letter-spacing: -.035em; } h3 { margin: 0 0 12px; font-size: 17px; } p, figcaption { color: var(--collection-muted); } .eyebrow { margin: 0 0 5px; font-size: 12px; }
button { min-height: 42px; padding: 9px 13px; border: 1px solid var(--collection-line); border-radius: 8px; background: var(--collection-surface); color: var(--collection-text); font: inherit; cursor: pointer; } .back { padding-inline: 0; border: 0; background: transparent; color: var(--collection-accent); }
.detail-actions { display: flex; gap: 10px; flex-wrap: wrap; } .primary { color: var(--collection-accent); border-color: var(--collection-accent); font-weight: 650; }
.overview { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 28px; align-items: start; } figure { margin: 0; min-width: 0; } .primary-image :deep(.reference-image) { height: auto; min-height: 0; aspect-ratio: 8 / 5; border-radius: 10px; background: var(--collection-media); } figcaption { margin-top: 8px; font-size: 12px; overflow-wrap: anywhere; }
.primary-original { display: block; width: 100%; height: auto; aspect-ratio: 8 / 5; object-fit: contain; border-radius: 10px; background: var(--collection-media); }
.metadata { margin: 0; display: grid; gap: 12px; } .metadata > div { display: grid; grid-template-columns: 108px minmax(0, 1fr); gap: 12px; } dt { color: var(--collection-muted); } dd { margin: 0; overflow-wrap: anywhere; }
.evidence-note { margin: 18px 0 26px; } section section { margin-top: 30px; } .evidence { padding: 18px; border: 1px solid var(--collection-line); border-radius: 10px; background: var(--collection-subtle); } .evidence p { margin: 8px 0; } .transcription p { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--collection-text); }
.asset-gallery { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(280px, 100%), 1fr)); gap: 24px; } .asset-gallery img { display: block; width: 100%; max-height: 440px; object-fit: contain; border-radius: 8px; background: var(--collection-media); } small { display: block; margin-top: 4px; overflow-wrap: anywhere; } .linked-models { display: flex; gap: 10px; flex-wrap: wrap; } .error { border-left: 3px solid var(--collection-accent); padding: 10px 14px; }
:where(button, h2):focus-visible { outline: 2px solid var(--collection-accent); outline-offset: 3px; } button:active { transform: scale(.98); }
@container (max-width: 700px) { .overview { grid-template-columns: minmax(0, 1fr); gap: 20px; } h2 { font-size: 25px; } }
</style>
