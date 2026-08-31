<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { RecordingRecordDetail, ReplicaTarget, RenderSide } from '@music-bridge/contracts'
import { createRecordingReplicaController, replicaIssueLabels } from './recording-replica-controller'
const props = defineProps<{ detail: RecordingRecordDetail }>()
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement>(), heading = ref<HTMLElement>()
let disposed = false, closed = false
let controller = createRecordingReplicaController({ api: window.musicBridge, detail: props.detail, onChange: () => { state.value = { ...controller.state } } })
const state = shallowRef({ ...controller.state })
const busy = computed(() => ['checking', 'cancelling', 'cancel-failed'].includes(state.value.phase))
const targetLabels: Record<ReplicaTarget, string> = { 'actual-execution': '实际执行音频', 'original-render': '原始 Render' }
const sideLabels: Record<RenderSide, string> = { A: 'A 面', B: 'B 面', Program: '连续节目（Program）' }
const targets = computed(() => [...new Set(state.value.inspection?.targets.map(t => t.target) ?? [])])
const sides = computed(() => state.value.inspection?.targets.filter(t => t.target === state.value.target) ?? [])
const selected = computed(() => { void state.value; return controller.selected() })
const number = (value: number) => value.toLocaleString('zh-CN')
function maybeClose(): void {
  if (!disposed && !closed && state.value.closeRequested && controller.canClose()) { closed = true; controller.dispose(); emit('close') }
}
async function act(operation: () => Promise<unknown>): Promise<void> {
  const origin = document.activeElement, owner = controller
  await operation(); await nextTick()
  if (disposed || closed || owner !== controller) return
  maybeClose()
  if (!closed && (document.activeElement === document.body || document.activeElement === origin && origin?.hasAttribute?.('disabled'))) heading.value?.focus({ preventScroll: true })
}
function close(): Promise<void> { return act(() => controller.requestClose()) }
watch(() => state.value.phase, () => { void nextTick().then(maybeClose) })
watch(() => [props.detail.record.id, props.detail.record.contentHash, props.detail.plan.id, props.detail.plan.contentHash].join(':'), () => {
  controller.dispose()
  controller = createRecordingReplicaController({ api: window.musicBridge, detail: props.detail, onChange: () => { state.value = { ...controller.state } } })
  state.value = { ...controller.state }; void controller.refreshStatus()
})
onMounted(() => { dialog.value?.showModal(); heading.value?.focus(); void controller.refreshStatus() })
onBeforeUnmount(() => { disposed = true; controller.dispose() })
</script>
<template>
  <dialog ref="dialog" class="replica" aria-label="历史音频 Digital Replica" data-testid="recording-replica-panel" @cancel.prevent="close" @close="close">
    <header><div><p class="muted">只读历史音频</p><h2 ref="heading" tabindex="-1">Digital Replica</h2></div><button type="button" @click="close">关闭 Digital Replica</button></header>
    <h3>{{ detail.plan.master.title }}</h3><p>档案 <code>{{ detail.record.id }}</code> · 实体 {{ detail.record.completion.physicalId }}</p>
    <div class="boundary" role="note"><strong>核验不播放音频，也不认证 Gate B。</strong><p>仅使用本份历史档案冻结的音频与归档引用；不使用当前设置重建，不额外添加间隔，不更改录音尝试或实体内容。</p></div>
    <section aria-label="播放后端状态" aria-live="polite">
      <p v-if="state.statusPhase === 'unread' || state.statusPhase === 'loading'">正在读取播放后端状态…</p>
      <p v-else-if="state.statusPhase === 'error'" role="alert">{{ state.statusError }}</p>
      <p v-else>播放后端不可用；不会播放音频，也不代表 Gate B 已认证。设备访问未授权，Gate B 为 NOT_RUN。</p>
      <button type="button" :disabled="state.statusPhase === 'loading'" @click="act(controller.refreshStatus)">重新读取播放后端状态</button>
    </section>
    <div class="actions"><button type="button" class="primary" :disabled="busy || state.closeRequested" @click="act(controller.inspect)">核验历史音频</button><button v-if="busy" type="button" :disabled="state.cancelSending" @click="act(controller.cancel)">{{ state.phase === 'cancel-failed' ? '重试取消核验' : '取消本次核验' }}</button></div>
    <section aria-label="历史音频核验结果" aria-live="polite" aria-atomic="true">
      <p v-if="state.phase === 'unread'">尚未核验；请选择明确操作，不会自动读取历史音频。</p>
      <p v-else-if="state.phase === 'checking'">正在核对本份历史档案的音频字节与谱系…</p>
      <p v-else-if="state.phase === 'cancelling'">已请求取消，正在等待本次核验收口；取消请求不代表读取已经结束。</p>
      <p v-else-if="state.phase === 'cancelled'">本次核验结果已作废；不会自动重试或播放。</p>
      <p v-if="state.error" role="alert">{{ state.error }}</p>
      <template v-if="state.inspection">
        <h4>{{ state.inspection.targets.some(t => t.state === 'verified') ? '历史音频核验通过' : '历史音频核验未通过' }}</h4>
        <p>以下逐项结果仅属于本次只读核验；部分缺失不表示全部可用，音频可核验不等于播放后端可用。</p>
        <ul class="results"><li v-for="item in state.inspection.targets" :key="`${item.target}:${item.side}`"><strong>{{ targetLabels[item.target] }} · {{ sideLabels[item.side] }}</strong><p v-if="item.state === 'verified'">已核验 · {{ number(item.audio.frameCount) }} 帧 · {{ number(item.audio.format.sampleRate) }} Hz · {{ item.audio.format.channelCount }} 声道 · {{ item.audio.format.sampleFormat }}</p><p v-else-if="item.state === 'empty'">空面，不存在可播放音频；不生成零帧成功。</p><p v-else>{{ replicaIssueLabels[item.reason] }}；不自动替换或重建。</p></li></ul>
        <p v-if="!targets.includes('original-render')">本份 Direct 档案没有原始 Render；不会用实际执行音频冒充原始 Render。</p>
        <details><summary>查看本次历史完整性摘要</summary><dl><dt>核验时间</dt><dd>{{ state.inspection.checkedAt }}</dd><dt>核验编号</dt><dd><code>{{ state.inspection.readId }}</code></dd><dt>档案 Hash</dt><dd><code>{{ state.inspection.recordingContentHash }}</code></dd><dt>计划 Hash</dt><dd><code>{{ state.inspection.planContentHash }}</code></dd><dt>归档 Hash</dt><dd><code>{{ state.inspection.archiveManifestHash }}</code></dd></dl></details>
      </template>
    </section>
    <div class="fields"><label>音频版本<select :value="state.target" :disabled="busy || !targets.length" @change="controller.selectTarget(($event.target as HTMLSelectElement).value)"><option value="">请明确选择音频版本</option><option v-for="target in targets" :key="target" :value="target">{{ targetLabels[target] }}</option></select></label><label>播放面／节目<select :value="state.side" :disabled="busy || !state.target" @change="controller.selectSide(($event.target as HTMLSelectElement).value)"><option value="">请明确选择面或节目</option><option v-for="item in sides" :key="item.side" :value="item.side" :disabled="item.state === 'empty'">{{ sideLabels[item.side] }}{{ item.state === 'empty' ? '（空面）' : '' }}</option></select></label></div>
    <section v-if="selected?.state === 'verified'" aria-label="所选音频事实"><p>{{ selected.audio.pcmHashEvidence === 'frozen-execution' ? 'PCM 摘要来自冻结执行证据。' : 'PCM 摘要来自本次核验的原始 Render 字节，不是执行配方或输出配置证据。' }}</p><details><summary>查看所选音频摘要</summary><dl><dt>文件 Hash</dt><dd><code>{{ selected.audio.fileSha256 }}</code></dd><dt>PCM Hash</dt><dd><code>{{ selected.audio.pcmSha256 }}</code></dd><dt>文件字节数</dt><dd>{{ number(selected.audio.size) }}</dd></dl></details></section>
    <p v-else-if="selected?.state === 'unavailable'">所选音频不可用：{{ replicaIssueLabels[selected.reason] }}。</p>
    <button type="button" disabled aria-describedby="replica-playback-blocked">播放所选历史音频</button><p id="replica-playback-blocked" class="muted">播放功能当前被阻断。核验通过也不会自动播放；合成消费证据不是用户播放。</p>
  </dialog>
</template>
<style scoped>
.replica{box-sizing:border-box;width:min(880px,calc(100vw - 32px));max-height:calc(100vh - 32px);padding:24px;overflow:auto;border:1px solid var(--mb-glass-border);border-radius:14px;background:var(--mb-bg-base);color:var(--mb-text-primary)}.replica::backdrop{background:rgba(0,0,0,.6)}header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}header>div{min-width:0}h2{font-size:24px;margin:0 0 16px}h3,h4{margin:16px 0 8px}h3,p,li,dd,button,label{overflow-wrap:anywhere;min-width:0}p{font-size:14px;line-height:1.75}.muted,dt{color:var(--mb-text-secondary)}.boundary{border-left:3px solid var(--mb-accent);padding-left:14px;margin:18px 0}.actions{display:flex;flex-wrap:wrap;gap:12px;margin:18px 0}.fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin:18px 0}label{display:flex;flex-direction:column;gap:8px;font-size:14px}button,select{box-sizing:border-box;min-height:44px;max-width:100%;min-width:0;border:1px solid var(--mb-glass-border);border-radius:8px;padding:10px 12px;background:var(--mb-bg-base);color:var(--mb-text-primary);font:inherit;font-size:14px}button,summary{cursor:pointer}button:disabled,select:disabled{opacity:.5;cursor:not-allowed}.primary{background:var(--mb-accent);color:var(--mb-bg-deep);font-weight:600}.results{padding-left:20px}.results li{margin:12px 0}dl{display:grid;grid-template-columns:110px minmax(0,1fr);gap:10px}dd{margin:0}code{font-size:12px;white-space:normal;overflow-wrap:anywhere}summary{min-height:44px;box-sizing:border-box;padding:12px 0;font-size:14px}:focus-visible{outline:2px solid var(--mb-accent);outline-offset:3px}@media(max-width:600px){.replica{padding:16px}.fields{grid-template-columns:1fr}header{flex-wrap:wrap}dl{grid-template-columns:1fr;gap:4px}dd{margin-bottom:8px}}
</style>
