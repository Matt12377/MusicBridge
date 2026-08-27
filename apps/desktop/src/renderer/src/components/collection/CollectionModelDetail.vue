<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { CollectionCopy, CollectionDetail, CollectionMaterializeRequest, CollectionPolicyRequest, CollectionUpdateCopyRequest, CollectorPolicy } from '@music-bridge/contracts'

const props = defineProps<{ detail: CollectionDetail; busy: boolean }>()
const emit = defineEmits<{ close: []; receive: []; page: [offset: number]; materialize: [request: CollectionMaterializeRequest]; updateCopy: [request: CollectionUpdateCopyRequest]; policy: [request: CollectionPolicyRequest] }>()
const policy = ref<CollectorPolicy>('normal')
const reserve = ref(0)
watch(() => props.detail.model, model => { policy.value = model.collectorPolicy; reserve.value = model.minimumSealedReserve }, { immediate: true })
const protectedSealed = computed(() => ['collector', 'preserve-sealed'].includes(props.detail.model.collectorPolicy) || props.detail.model.counts.sealedBlank <= props.detail.model.minimumSealedReserve)
const maxPageTotal = computed(() => Math.max(props.detail.lots.total, props.detail.copies.total))
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
function savePolicy(): void {
  emit('policy', { commandId: crypto.randomUUID(), modelId: props.detail.model.id, expectedRevision: props.detail.model.revision, collectorPolicy: policy.value, minimumSealedReserve: Number(reserve.value) })
}
function state(copy: CollectionCopy): string {
  if (!copy.available) return '不可用'
  return { blank: copy.packaging === 'sealed' ? '未开封空白' : '已拆空白', reserved: '已预留', recorded: '已录音 · 旧录音登记', unknown: '状态待确认', erased: '已擦除空白' }[copy.usage]
}
</script>

<template>
  <section class="model-detail" aria-label="磁带型号详情">
    <div class="detail-toolbar"><button type="button" @click="emit('close')">← 返回收藏</button><button type="button" :disabled="busy" @click="emit('receive')">补充库存</button></div>
    <h2>{{ detail.model.brand }} {{ detail.model.name }}</h2>
    <p class="muted">{{ detail.model.edition || '版次待确认' }} · {{ detail.model.format === 'dat' ? 'DAT' : '卡式磁带' }} · {{ detail.model.lengths.map(n => n ? `${n} 分钟` : '时长待确认').join(' / ') }}</p>
    <dl class="counts"><div v-for="[key, label, testId] in countItems" :key="key"><dt>{{ label }}</dt><dd :data-testid="`inventory-${testId}`">{{ detail.model.counts[key] }}</dd></div></dl>

    <details class="policy"><summary>收藏保护设置</summary><form @submit.prevent="savePolicy">
      <label>收藏策略<select v-model="policy" :disabled="busy"><option value="normal">正常使用</option><option value="prefer-opened">优先已拆空白</option><option value="preserve-sealed">封存未开封磁带</option><option value="collector">仅收藏，不用于录音</option></select></label>
      <label>最低未开封保留数量<input v-model.number="reserve" type="number" min="0" max="1000000" step="1" required :disabled="busy"></label>
      <button type="submit" :disabled="busy">保存保护设置</button>
    </form><p class="muted">保护规则会阻止拆封和录音预留，但仍允许建立实体档案。</p></details>

    <h3>批次库存</h3>
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

    <h3>单盘档案</h3>
    <p v-if="!detail.copies.total" class="muted">尚未建立单盘档案。批次数量已计入库存，无需逐盘编号。</p>
    <p v-else-if="!detail.copies.items.length" class="muted">本页没有单盘档案。</p>
    <article v-for="copy in detail.copies.items" :key="copy.physicalId" class="copy">
      <div><strong>{{ copy.physicalId }}</strong><p class="muted">{{ copy.lengthMinutes ? `${copy.lengthMinutes} 分钟 · ` : '' }}{{ state(copy) }}</p></div>
      <div class="copy-actions">
        <button v-if="copy.usage === 'reserved'" :disabled="busy" @click="update(copy, 'cancel-reservation')">取消预留</button>
        <button v-else-if="copy.usage === 'blank' || copy.usage === 'erased'" :disabled="busy || !copy.available || detail.model.collectorPolicy === 'collector' || (copy.packaging === 'sealed' && protectedSealed)" @click="update(copy, 'reserve')">预留</button>
        <button :disabled="busy" @click="update(copy, copy.available ? 'mark-unavailable' : 'mark-available')">{{ copy.available ? '标为不可用' : '恢复可用' }}</button>
      </div>
    </article>
    <nav v-if="maxPageTotal > 20" class="detail-toolbar" aria-label="库存详情分页"><button :disabled="busy || detail.lots.offset === 0" @click="emit('page', Math.max(0, detail.lots.offset - 20))">上一页</button><span>{{ Math.floor(detail.lots.offset / 20) + 1 }} / {{ Math.ceil(maxPageTotal / 20) }}</span><button :disabled="busy || detail.lots.offset + 20 >= maxPageTotal" @click="emit('page', detail.lots.offset + 20)">下一页</button></nav>
  </section>
</template>

<style scoped>
.model-detail { margin-top: 26px; } .detail-toolbar, .lot header, .lot-row, .copy { display: flex; justify-content: space-between; align-items: center; gap: 14px; } .detail-toolbar { margin-bottom: 24px; }
h2 { font-size: 28px; margin: 0; overflow-wrap: anywhere; } h3 { font-size: 17px; margin: 28px 0 12px; }
.muted { color: var(--mb-text-secondary); font-size: 13px; line-height: 1.7; }
.counts { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin: 24px 0; } .counts div { border: 1px solid var(--mb-glass-border); border-radius: 10px; padding: 16px; background: var(--mb-bg-base); } dt { font-size: 12px; color: var(--mb-text-secondary); } dd { margin: 8px 0 0; font-size: 26px; font-variant-numeric: tabular-nums; }
.policy, .lot, .copy { border: 1px solid var(--mb-glass-border); border-radius: 12px; padding: 18px; margin: 12px 0; background: var(--mb-bg-base); }
.policy summary { cursor: pointer; font-size: 14px; } .policy form { display: flex; flex-wrap: wrap; align-items: end; gap: 16px; margin: 18px 0; } label { display: grid; gap: 8px; font-size: 13px; }
input, select { box-sizing: border-box; max-width: 100%; min-height: 40px; padding: 8px; border: 1px solid var(--mb-glass-border); border-radius: 8px; background: var(--mb-bg-surface, #20232b); color: var(--mb-text-primary); font: inherit; }
button { min-height: 38px; padding: 8px 12px; border: 1px solid var(--mb-glass-border); border-radius: 8px; background: var(--mb-glass-clear); color: var(--mb-text-primary); font-size: 12px; } button:disabled { opacity: .5; cursor: not-allowed; }
.lot-row { padding-top: 12px; font-size: 13px; } .lot-row div, .copy-actions { display: flex; flex-wrap: wrap; gap: 8px; } b { margin-left: 8px; font-variant-numeric: tabular-nums; } .copy strong { font-family: monospace; font-size: 15px; } .copy p { margin-bottom: 0; }
@media (max-width: 900px) { .counts { grid-template-columns: repeat(2, minmax(0, 1fr)); } .lot-row, .copy { flex-wrap: wrap; } .lot, .copy { padding: 14px; } }
</style>
