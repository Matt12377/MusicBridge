<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import type { RecordingRecordFilter } from '@music-bridge/contracts'
import { createRecordingRecordController, normalizeRecordingPhysicalId } from './recording-record-controller'
import RecordingRecordDetail from './RecordingRecordDetail.vue'
import RecordingRecordDisposition from './RecordingRecordDisposition.vue'
const props = defineProps<{ physicalId?: string; draftId?: string }>()
const emit = defineEmits<{ close: []; changed: [physicalId: string] }>()
const dialog = ref<HTMLDialogElement>(), heading = ref<HTMLElement>()
const controller = createRecordingRecordController({ api: window.musicBridge, draftId: props.draftId, onChange: () => { state.value = { ...controller.state } } })
const state = shallowRef({ ...controller.state })
const filter = ref({ query: '', artist: '', track: '', master: '', mediaBrand: '', mediaSeries: '', equipment: '', completedFrom: '', completedTo: '' })
const physical = ref(props.physicalId ?? ''), medium = ref<'' | 'C' | 'D'>(''), physicalError = ref('')
const canPreview = computed(() => { void state.value; return controller.canPreview() })
const canRetry = computed(() => { void state.value; return controller.canRetry() })
const statusLabels = { 'in-progress': '进行中', completed: '已完成', aborted: '用户中止', failed: '失败', interrupted: '中断' }
const actionLabels = { 'mark-content-unknown': '标记当前内容未知', 'confirm-current-recording': '确认当前历史录音', 'prepare-rerecord': '准备重录', 'cancel-rerecord': '取消重录准备', 'confirm-erased': '确认已擦除' }
let disposed = false
async function act(operation: () => void | Promise<void>, changed = false): Promise<void> {
  const origin = document.activeElement, generation = state.value.physicalId
  await operation(); await nextTick()
  if (disposed) return
  if (changed && state.value.notice.startsWith('处置已应用')) emit('changed', state.value.physicalId)
  if (document.activeElement === document.body || document.activeElement === origin && generation !== state.value.physicalId) heading.value?.focus({ preventScroll: true })
}
async function search(): Promise<void> {
  const request: RecordingRecordFilter = {}
  for (const [key, value] of Object.entries(filter.value)) {
    if (!value.trim()) continue
    if (key === 'completedFrom' || key === 'completedTo') request[key] = `${value}T${key === 'completedFrom' ? '00:00:00.000' : '23:59:59.999'}Z`
    else Object.assign(request, { [key]: value.trim() })
  }
  await act(() => controller.search(request))
}
async function historyLookup(): Promise<void> {
  const id = normalizeRecordingPhysicalId(physical.value, medium.value)
  if (!id) { physicalError.value = '请填写有效编号；只有纯数字时必须明确选择卡带或 DAT。'; return }
  physicalError.value = ''; await act(() => controller.openPhysical(id))
}
async function abandon(): Promise<void> { controller.abandonRetry(); await controller.history() }
function close(): void { if (!state.value.sending && !state.value.pending) { controller.dispose(); emit('close') } }
onMounted(() => { dialog.value?.showModal(); if (props.physicalId) void controller.openPhysical(props.physicalId); else void controller.refresh() })
onBeforeUnmount(() => { disposed = true; controller.dispose() })
</script>
<template>
  <dialog ref="dialog" class="records" aria-label="录音档案" data-testid="recording-records-panel" @cancel.prevent="close" @close="close">
    <header class="heading"><div><p class="muted">记录与实体认知</p><h2 ref="heading" tabindex="-1">录音档案</h2></div><button type="button" :disabled="state.sending || !!state.pending" @click="close">关闭录音档案</button></header>
    <p class="notice">历史完成记录与实体当前内容分开保存。本页不播放、不认证 Gate B、不生成演示档案；重录也不增加实物数量。</p>
    <form @submit.prevent="search">
      <label>搜索录音档案<input v-model="filter.query" maxlength="240" placeholder="编号、母版、曲目、艺术家…"></label>
      <details><summary>更多档案筛选</summary><div class="fields"><label>艺术家<input v-model="filter.artist" maxlength="240"></label><label>曲目<input v-model="filter.track" maxlength="240"></label><label>母版<input v-model="filter.master" maxlength="240"></label><label>介质品牌<input v-model="filter.mediaBrand" maxlength="240"></label><label>介质系列<input v-model="filter.mediaSeries" maxlength="240"></label><label>设备参数<input v-model="filter.equipment" maxlength="240"></label><label>完成日期起（UTC）<input v-model="filter.completedFrom" type="date"></label><label>完成日期止（UTC）<input v-model="filter.completedTo" type="date"></label></div></details>
      <button type="submit" :disabled="state.listPhase === 'loading'">搜索录音档案</button>
    </form>
    <section aria-label="按实体编号查看"><h3>没有完成档案，也能查看实体历史</h3><form class="fields" @submit.prevent="historyLookup"><label>编号介质<select v-model="medium"><option value="">纯数字编号请先选择</option><option value="C">卡带</option><option value="D">DAT</option></select></label><label>实体编号<input v-model="physical" maxlength="16" placeholder="427 / C-0427 / MB-C-00427"></label><button type="submit">查看实体历史</button></form><p v-if="physicalError" role="alert">{{ physicalError }}</p></section>
    <section aria-label="档案列表" aria-live="polite">
      <p v-if="state.listPhase === 'loading'">正在读取录音档案…</p><p v-if="state.listError" role="alert">{{ state.listError }}</p>
      <template v-if="state.page"><p v-if="!state.page.total">暂无符合条件的录音档案；这不表示实体不存在。</p><p v-else>共 {{ state.page.total }} 份 · 每页最多 25 份，请明确选择。</p>
        <ol class="record-list"><li v-for="item in state.page.items" :key="item.id"><h4>{{ item.title }}</h4><p>{{ item.physicalId }} · {{ item.artist || '艺术家未知' }} · {{ item.mediaBrand || '历史品牌未知' }} {{ item.mediaSeries }} · {{ item.completedAt }}</p><button type="button" :aria-label="`查看录音档案 ${item.id}`" @click="act(() => controller.select(item.id))">查看录音档案 {{ item.id }}</button></li></ol>
        <nav class="actions" aria-label="录音档案分页"><button type="button" :disabled="state.page.offset === 0 || state.listPhase === 'loading'" @click="act(() => controller.refresh(state.page!.offset - 25))">上一页档案</button><button type="button" :disabled="!state.page.hasMore || state.listPhase === 'loading'" @click="act(() => controller.refresh(state.page!.offset + 25))">下一页档案</button></nav>
      </template>
    </section>
    <p v-if="state.reading" role="status">正在读取所选档案…</p><p v-if="state.detailError" role="alert">{{ state.detailError }} <button type="button" @click="act(() => controller.select(state.selectedId))">重试档案详情</button></p>
    <RecordingRecordDetail v-if="state.detail" :detail="state.detail" :state="state" @visual="id => act(() => controller.loadVisual(id))" @image-error="controller.imageFailed" />
    <section v-if="state.physicalId" data-testid="recording-record-history" aria-label="实体当前内容与完整历史">
      <h3>实体当前内容与完整历史</h3><p>当前实体：{{ state.physicalId }}</p><button type="button" :disabled="state.historyPhase === 'loading'" @click="act(() => controller.history())">刷新实体历史</button>
      <p v-if="state.historyPhase === 'loading'" role="status">正在核对当前内容与历史…</p><p v-if="state.historyError" role="alert">{{ state.historyError }}</p>
      <div v-if="state.current" class="card"><h4>当前内容认知</h4><p v-if="state.historyPhase !== 'ready'" class="muted">以下为最近一次已读取状态；需刷新历史后才能预览处置。</p><p v-if="state.current.knowledge.state === 'confirmed-recording'">已确认是历史录音 · {{ state.current.knowledge.recordingId }}</p><p v-else-if="state.current.knowledge.state === 'erased'">用户已确认擦除</p><p v-else>当前内容未知；不沿用旧录音名称，也不认为为空白。</p><p>内容修订 {{ state.current.revision }} · 实体修订 {{ state.current.physicalRevision }}</p><p v-if="state.current.activeRerecordPermit">存在同实体一次重录许可：{{ state.current.activeRerecordPermit.id }} · 目标计划 {{ state.current.activeRerecordPermit.mediaPlanId }}。尚未执行。</p></div>
      <template v-if="state.history"><p v-if="!state.history.entries.total">此实体尚无正式尝试或处置历史；不自动补造历史。</p><ol class="record-list"><li v-for="item in state.history.entries.items" :key="`${item.kind}:${item.id}`"><p>{{ item.createdAt }}</p>
        <template v-if="item.kind === 'attempt'"><strong>{{ statusLabels[item.attempt.status] }} · {{ item.attempt.id }}</strong><p>软件播放完成：{{ item.attempt.softwarePlaybackComplete ? '已完成' : '未完成' }} · 实体录制确认：{{ item.attempt.physicalRecordingConfirmedAt ?? '未确认' }} · 最终核验：{{ item.attempt.finalVerificationCompleteAt ?? '未确认' }}</p><details><summary>查看本次尝试的分面与终止事实</summary><p>计划 {{ item.attempt.planVersionId }} · 修订 {{ item.attempt.revision }}</p><p v-if="item.attempt.reason">终止原因代码：{{ item.attempt.reason }}</p><p v-for="side in item.attempt.sides" :key="side.side">{{ side.side }} · 源已读 {{ side.sourceFramesRead.toLocaleString('zh-CN') }} / {{ side.frameCount.toLocaleString('zh-CN') }} 帧 · 已提交 {{ side.submittedFrames.toLocaleString('zh-CN') }} · 已消费 {{ side.consumedFrames.toLocaleString('zh-CN') }}<br>源结束 {{ side.sourceEof ? '已确认' : '未确认' }} · 排空 {{ side.backendDrained ? '已确认' : '未确认' }} · 停止提交 {{ side.engineStoppedSubmitting ? '已确认' : '未确认' }} · 停止应答 {{ side.stopAcknowledged ? '已确认' : '未确认' }} · 资源静止 {{ side.cleanupQuiescent ? '已确认' : '未确认' }}<br>实体停止 {{ side.physicalStopConfirmedAt ?? '未确认' }}</p></details><button v-if="item.recordingId" type="button" @click="act(() => controller.select(item.recordingId!))">查看录音档案 {{ item.recordingId }}</button></template>
        <template v-else><strong>{{ actionLabels[item.disposition.intent.action] }}</strong><p>内容修订 {{ item.disposition.beforeContentRevision }} → {{ item.disposition.afterContentRevision }} · 实体修订 {{ item.disposition.beforePhysicalRevision }} → {{ item.disposition.afterPhysicalRevision }}</p><p v-if="item.disposition.permitId">许可 {{ item.disposition.permitId }}</p></template>
      </li></ol><nav class="actions" aria-label="实体历史分页"><button type="button" :disabled="state.history.entries.offset === 0" @click="act(() => controller.history(state.history!.entries.offset - 25))">上一页实体历史</button><button type="button" :disabled="!state.history.entries.hasMore" @click="act(() => controller.history(state.history!.entries.offset + 25))">下一页实体历史</button></nav></template>
    </section>
    <RecordingRecordDisposition :state="state" :draft-id="draftId" :can-preview="canPreview" :can-retry="canRetry" @change="controller.changeIntent" @preview="intent => act(() => controller.preview(intent))" @confirmed="controller.setConfirmed" @apply="act(controller.apply, true)" @retry="act(controller.retry, true)" @abandon="act(abandon)" @plans="act(controller.loadPlans)" />
    <p v-if="state.notice" role="status">{{ state.notice }}</p>
  </dialog>
</template>
<style scoped>
.records{box-sizing:border-box;width:min(920px,calc(100vw - 32px));max-height:calc(100dvh - 32px);padding:24px;border:1px solid var(--mb-glass-border);border-radius:14px;color:var(--mb-text-primary);background:var(--mb-bg-base);overflow:auto}.records::backdrop{background:#000b}.heading,.records :deep(.actions){display:flex;flex-wrap:wrap;gap:12px;align-items:center}.heading{justify-content:space-between;align-items:flex-start}.records :deep(h2){font-size:24px;margin:0}.records :deep(h3){font-size:18px;margin:24px 0 14px}.records :deep(h4){font-size:16px;margin:14px 0 8px}.records :deep(p),.records :deep(li),.records :deep(dd){font-size:14px;line-height:1.75;overflow-wrap:anywhere}.records :deep(.muted),.records :deep(dt){color:var(--mb-text-secondary)}.records :deep(section){min-width:0;border-top:1px solid var(--mb-glass-border);margin-top:24px;padding-top:8px}.records :deep(button),.records :deep(input),.records :deep(select){box-sizing:border-box;min-width:0;max-width:100%;min-height:44px;padding:10px 12px;font:inherit;font-size:14px;border:1px solid var(--mb-glass-border);border-radius:8px;color:var(--mb-text-primary);background:var(--mb-bg-base)}.records :deep(button){cursor:pointer;overflow-wrap:anywhere}.records :deep(button:disabled){opacity:.5;cursor:not-allowed}.records :deep(input),.records :deep(select){width:100%}.records :deep(label){display:grid;gap:8px;margin:14px 0;font-size:14px;line-height:1.7}.records :deep(label span){font-size:13px;color:var(--mb-text-secondary)}.fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;align-items:end}.records :deep(fieldset){min-width:0;padding:14px;border:1px solid var(--mb-glass-border);border-radius:8px}.records :deep(legend){font-size:14px}.records :deep(.check){display:flex;align-items:flex-start;gap:12px}.records :deep(.check input){width:18px;min-height:18px;height:18px;margin-top:4px;flex-shrink:0;accent-color:var(--mb-accent)}.records :deep(.notice),.records :deep(.card){padding:14px;border:1px solid var(--mb-glass-border);border-radius:8px;margin:18px 0}.records :deep(.notice){border-left:3px solid var(--mb-accent)}.record-list{padding-left:24px}.record-list>li{padding:12px 0;border-bottom:1px solid var(--mb-glass-border)}.records :deep(dl){display:grid;grid-template-columns:130px minmax(0,1fr);gap:8px}.records :deep(dd){margin:0;min-width:0}.records :deep(dt){font-size:13px;line-height:1.75}.records :deep(code),.records :deep(pre){white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;min-width:0}.records :deep(summary){min-height:44px;padding:12px 0;box-sizing:border-box;cursor:pointer;font-size:14px}.records :deep(figure){margin:16px 0;min-width:0}.records :deep(img){display:block;max-width:100%;width:auto;height:auto;max-height:55dvh;object-fit:contain}.records :deep(figcaption){font-size:13px;line-height:1.7}.records :deep(:focus-visible){outline:2px solid var(--mb-accent);outline-offset:3px}.records :deep(button:not(:disabled):active){transform:scale(.97)}@media(hover:hover) and (pointer:fine){.records :deep(button:not(:disabled):hover){border-color:var(--mb-accent)}}@media(max-width:600px){.records{padding:16px}.fields{grid-template-columns:1fr}.records :deep(dl){grid-template-columns:1fr;gap:4px}.records :deep(dd){margin-bottom:8px}}@media(prefers-reduced-motion:reduce){.records :deep(button:not(:disabled):active){transform:none}}
</style>
