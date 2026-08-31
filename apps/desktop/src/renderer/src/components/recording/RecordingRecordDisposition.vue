<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { PhysicalRecordingDispositionIntent } from '@music-bridge/contracts'
import type { RecordingRecordState } from './recording-record-controller'
const props = defineProps<{ state: RecordingRecordState; draftId?: string; canPreview: boolean; canRetry: boolean }>()
const emit = defineEmits<{ change: []; preview: [intent: PhysicalRecordingDispositionIntent]; confirmed: [value: boolean]; apply: []; retry: []; abandon: []; plans: [] }>()
const action = ref<PhysicalRecordingDispositionIntent['action'] | ''>(''), recordingId = ref(''), planId = ref(''), revision = ref('')
const actions = { 'mark-content-unknown': '标记当前内容未知', 'confirm-current-recording': '确认当前仍是指定历史录音', 'prepare-rerecord': '准备同实体重录', 'cancel-rerecord': '取消重录准备', 'confirm-erased': '确认已擦除' }
const effects = { 'content-unknown': '当前内容改为未知；旧档案保留', 'content-confirmed': '当前内容指向所选历史档案；不会新建档案', 'rerecord-reserved': '为明确目标计划预留本实体一次重录；不会开始输出', 'rerecord-cancelled': '撤销本次重录许可；不宣称实体为空白', 'erased-confirmed': '登记用户确认已擦除；不会执行擦除或删除历史' }
watch(() => props.state.physicalId, () => { action.value = ''; recordingId.value = ''; planId.value = ''; revision.value = '' })
const intent = computed<PhysicalRecordingDispositionIntent | undefined>(() => {
  if (action.value === 'mark-content-unknown' || action.value === 'confirm-erased') return { action: action.value }
  if (action.value === 'confirm-current-recording' && recordingId.value) return { action: action.value, recordingId: recordingId.value }
  if (action.value === 'cancel-rerecord' && props.state.current?.activeRerecordPermit) return { action: action.value, permitId: props.state.current.activeRerecordPermit.id }
  if (action.value === 'prepare-rerecord' && planId.value) {
    const selected = props.state.plans.find(plan => plan.id === planId.value)
    return { action: action.value, mediaPlanId: planId.value, expectedMediaPlanRevision: props.draftId ? selected?.revision ?? 0 : Number(revision.value) }
  }
  return undefined
})
const records = computed(() => {
  const items = props.state.history?.entries.items.flatMap(item => item.kind === 'attempt' && item.recordingId ? [item.recordingId] : []) ?? []
  if (props.state.detail) items.unshift(props.state.detail.record.id)
  return [...new Set(items)]
})
</script>
<template>
  <section v-if="state.current || state.pending" data-testid="recording-record-disposition" aria-label="明确处置当前实体">
    <h3>明确处置当前实体</h3><p>只登记你的明确判断或预留许可，不播放、不擦除、不创建完成档案，也不认证 Gate B。</p>
    <fieldset v-if="state.current" :disabled="state.sending || !!state.pending"><legend>处置目标</legend>
      <label>处置方式<select v-model="action" @change="emit('change')"><option value="">请选择处置方式</option><option v-for="(label, key) in actions" :key="key" :value="key">{{ label }}</option></select></label>
      <label v-if="action === 'confirm-current-recording'">指定历史录音<select v-model="recordingId" @change="emit('change')"><option value="">请选择已明确读取的历史档案</option><option v-for="id in records" :key="id" :value="id">{{ id }}</option></select><span>可在实体历史翻页或查看档案后选择；不默认使用最近一次。</span></label>
      <div v-if="action === 'prepare-rerecord'">
        <template v-if="draftId"><button type="button" :disabled="state.plansPhase === 'loading'" @click="emit('plans')">读取目标介质计划</button><p v-if="state.plansError" role="alert">{{ state.plansError }}</p><label>目标介质计划<select v-model="planId" @change="emit('change')"><option value="">请明确选择目标计划</option><option v-for="plan in state.plans" :key="plan.id" :value="plan.id">{{ plan.spec.format === 'dat' ? 'DAT' : '卡带' }} · {{ plan.layout.sides.map(side => `${side.name} ${side.durationMs === undefined ? '长度未知' : `${(side.durationMs / 1000).toFixed(1)}秒`}`).join(' / ') }} · 修订 {{ plan.revision }} · {{ plan.reservation ? `已占用 ${plan.reservation.physicalId}` : '未预留' }} · {{ plan.id }}</option></select></label><p v-if="state.plansPhase === 'ready' && !state.plans.length">当前草稿暂无目标计划，请先返回录音页准备。</p></template>
        <details v-else open><summary>高级：明确现有目标计划</summary><p>此入口没有录音草稿上下文。请先在录音草稿准备目标计划，再填写其 ID 与修订；不会自动创建计划。</p><label>目标介质计划 ID<input v-model="planId" maxlength="36" @input="emit('change')"></label><label>目标介质计划修订<input v-model="revision" type="number" min="1" step="1" @input="emit('change')"></label></details>
      </div>
      <p v-if="action === 'cancel-rerecord'">{{ state.current.activeRerecordPermit ? `将撤销许可 ${state.current.activeRerecordPermit.id}` : '此实体没有可撤销的活动重录许可。' }}</p>
      <button type="button" :disabled="!canPreview || !intent" @click="intent && emit('preview', intent)">预览处置</button>
    </fieldset>
    <p v-if="state.previewing" role="status">正在核对实体、最新尝试与处置条件…</p>
    <div v-if="state.proposal" class="notice" data-testid="recording-record-disposition-preview"><h4>处置预览</h4><p>{{ state.proposal.request.physicalId }} · 当前内容修订 {{ state.proposal.request.expectedContentRevision }} · 实体修订 {{ state.proposal.request.expectedPhysicalRevision }}</p><p>{{ effects[state.proposal.effect] }}</p><p v-if="state.proposal.request.intent.action === 'confirm-current-recording'">目标档案：{{ state.proposal.request.intent.recordingId }}</p><p v-if="state.proposal.request.intent.action === 'prepare-rerecord'">目标计划：{{ state.proposal.request.intent.mediaPlanId }} · 修订 {{ state.proposal.request.intent.expectedMediaPlanRevision }}</p><label class="check"><input type="checkbox" :checked="state.confirmed" :disabled="state.sending || !!state.pending" @change="emit('confirmed', ($event.target as HTMLInputElement).checked)">我已核实此实体与处置后果，确认按预览应用</label><button type="button" :disabled="!state.confirmed || state.sending || !!state.pending" @click="emit('apply')">确认应用处置</button></div>
    <p v-if="state.sending" role="status">正在等待处置回执；尚未确认是否应用成功。</p><p v-if="state.operationError" role="alert">{{ state.operationError }}</p>
    <div v-if="state.pending"><p>待确认原处置属于 {{ state.pending.physicalId }}。重试保留相同命令与预览，不自动提交。</p><div class="actions"><button type="button" :disabled="!canRetry" @click="emit('retry')">重试原处置</button><button type="button" :disabled="state.sending" @click="emit('abandon')">停止重试并重新读取</button></div></div>
  </section>
</template>
