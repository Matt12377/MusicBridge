<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { isCollectionReceiveRequest, type CollectionDescriptor, type CollectionModel, type CollectionReceiveRequest } from '@music-bridge/contracts'

const props = defineProps<{ model?: CollectionModel; busy: boolean; error: string; retryable: boolean }>()
const emit = defineEmits<{ close: []; save: [request: CollectionReceiveRequest]; retry: [] }>()
const dialog = ref<HTMLDialogElement>()
const descriptor = ref<CollectionDescriptor>({ brand: props.model?.brand ?? '', name: props.model?.name ?? '', edition: props.model?.edition ?? '', year: props.model?.year ?? null, format: props.model?.format ?? 'cassette', tapeType: props.model?.tapeType ?? 'unknown', identification: props.model?.identification ?? 'unidentified' })
const minutes = ref<number | ''>('')
const year = ref<number | ''>(descriptor.value.year ?? '')
const quantities = ref({ sealedBlank: 0, openedBlank: 0, legacyUsed: 0, unclassified: 0 })
const validation = ref('')
const locked = computed(() => props.busy || props.retryable)
const title = computed(() => props.model ? '补充库存' : '添加磁带')
function save(): void {
  const request: CollectionReceiveRequest = { commandId: crypto.randomUUID(), model: { ...descriptor.value, year: year.value === '' ? null : Number(year.value), tapeType: descriptor.value.format === 'dat' ? 'dat' : descriptor.value.tapeType }, lengthMinutes: minutes.value === '' ? null : Number(minutes.value), quantities: { ...quantities.value } }
  if (!isCollectionReceiveRequest(request)) { validation.value = '请填写品牌、型号和正确的数量；每批合计 1–10,000 盘。确认版次时必须填写包装版本。'; return }
  validation.value = ''
  emit('save', request)
}
onMounted(() => dialog.value?.showModal())
</script>

<template>
  <dialog ref="dialog" class="inventory-dialog" :aria-label="title" @cancel.prevent="!locked && emit('close')">
    <form @submit.prevent="save">
      <header><h2>{{ title }}</h2><button type="button" :disabled="locked" aria-label="关闭录入" @click="emit('close')">关闭</button></header>
      <p class="muted">按实际状态录入，不确定的磁带请放入“未分类”。同版次不同时长会归在一个型号下。</p>
      <fieldset :disabled="locked">
        <div class="fields">
          <label>品牌<input v-model.trim="descriptor.brand" required maxlength="120" :readonly="!!model" autofocus></label>
          <label>型号<input v-model.trim="descriptor.name" required maxlength="120" :readonly="!!model"></label>
          <label>版次 / 包装版本<input v-model.trim="descriptor.edition" maxlength="120" :readonly="!!model" placeholder="不确定可留空"></label>
          <label>年份<input v-model.number="year" type="number" min="1900" max="2200" step="1" :readonly="!!model" placeholder="可留空"></label>
          <label>介质<select v-model="descriptor.format" :disabled="!!model" @change="descriptor.tapeType = descriptor.format === 'dat' ? 'dat' : 'unknown'"><option value="cassette">卡式磁带</option><option value="dat">DAT</option></select></label>
          <label>磁带类型<select v-model="descriptor.tapeType" :disabled="!!model || descriptor.format === 'dat'"><option v-if="descriptor.format === 'dat'" value="dat">DAT</option><template v-else><option value="unknown">待确认</option><option v-for="kind in ['I', 'II', 'III', 'IV']" :key="kind" :value="kind">Type {{ kind }}</option></template></select></label>
          <label>时长（分钟）<input v-model.number="minutes" type="number" min="1" max="360" step="1" placeholder="未知可留空"></label>
          <label>版次确认<select v-model="descriptor.identification" :disabled="!!model"><option value="unidentified">尚未识别</option><option value="candidate">候选版次</option><option value="verified">已经确认</option></select></label>
        </div>
        <h3>本批数量</h3>
        <div class="fields">
          <label>未开封空白<input v-model.number="quantities.sealedBlank" type="number" min="0" max="10000" step="1" required></label>
          <label>已拆空白<input v-model.number="quantities.openedBlank" type="number" min="0" max="10000" step="1" required></label>
          <label>旧录音待登记<input v-model.number="quantities.legacyUsed" type="number" min="0" max="10000" step="1" required></label>
          <label>未分类<input v-model.number="quantities.unclassified" type="number" min="0" max="10000" step="1" required></label>
        </div>
      </fieldset>
      <p v-if="validation || error" role="alert" class="inventory-error">{{ validation || error }}</p>
      <footer><button v-if="retryable" type="button" :disabled="busy" @click="emit('retry')">重试原操作</button><button class="primary" type="submit" :disabled="locked">{{ busy ? '正在保存…' : '保存库存' }}</button></footer>
    </form>
  </dialog>
</template>

<style scoped>
.inventory-dialog { box-sizing: border-box; width: min(620px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); padding: 26px; border: 1px solid var(--mb-glass-border); border-radius: 18px; color: var(--mb-text-primary); background: var(--mb-bg-base); }
.inventory-dialog::backdrop { background: #0009; }
header, footer { display: flex; justify-content: space-between; align-items: center; gap: 12px; } footer { justify-content: flex-end; margin-top: 24px; }
h2 { margin: 0; font-size: 23px; } h3 { margin: 24px 0 12px; font-size: 15px; }
.muted { color: var(--mb-text-secondary); font-size: 13px; line-height: 1.8; }
fieldset { min-width: 0; padding: 0; border: 0; margin: 20px 0 0; }
.fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
label { display: grid; gap: 7px; font-size: 13px; }
input, select { box-sizing: border-box; min-width: 0; width: 100%; min-height: 42px; padding: 8px 10px; border: 1px solid var(--mb-glass-border); border-radius: 8px; background: var(--mb-bg-surface, #20232b); color: var(--mb-text-primary); font: inherit; }
button { min-height: 40px; padding: 8px 14px; border: 1px solid var(--mb-glass-border); border-radius: 8px; background: var(--mb-glass-clear); color: var(--mb-text-primary); }
.primary { background: var(--mb-accent); color: #071018; }
.inventory-error { color: var(--mb-text-primary); font-size: 13px; line-height: 1.7; padding: 12px; border: 1px solid var(--mb-glass-border); border-radius: 8px; }
:disabled { opacity: .55; cursor: not-allowed; }
@media (max-width: 480px) { .fields { grid-template-columns: 1fr; } .inventory-dialog { padding: 20px; } }
</style>
