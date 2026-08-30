<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { RecordingPlanVersion } from '@music-bridge/contracts'
import { createRecordingOutputController } from './recording-output-controller'

const props = defineProps<{ plan?: RecordingPlanVersion }>()
const controller = createRecordingOutputController({ api: window.musicBridge, onChange: () => { state.value = { ...controller.state } } })
const state = shallowRef({ ...controller.state })
const startButton = ref<HTMLButtonElement>(), cancelButton = ref<HTMLButtonElement>()
const sideSelect = ref<HTMLSelectElement>(), heading = ref<HTMLElement>()
let disposed = false
const sides = computed(() => { void state.value; return controller.sides() })
const canCheck = computed(() => { void state.value; return controller.canCheck() })
const busy = computed(() => ['checking', 'cancelling', 'cancel-failed'].includes(state.value.phase))
const sideLabels = { A: 'A 面', B: 'B 面', Program: '连续节目（Program）' }
watch(() => state.value.phase, phase => {
  if (typeof document === 'undefined' || ['checking', 'cancelling', 'cancel-failed'].includes(phase) || !cancelButton.value || document.activeElement !== cancelButton.value) return
  // 在v-if卸载按钮、清空ref之前记住焦点；用户若已移向别处则不抢回。
  const previous = cancelButton.value
  void nextTick().then(() => {
    if (!disposed && (document.activeElement === previous || document.activeElement === document.body)) {
      const target = canCheck.value ? startButton.value : sides.value.length ? sideSelect.value : heading.value
      target?.focus()
    }
  })
}, { flush: 'sync' })
watch(() => props.plan, value => controller.setPlan(value), { immediate: true, flush: 'sync' })
function selectSide(event: Event): void { controller.selectSide((event.target as HTMLSelectElement).value) }
async function check(): Promise<void> {
  // Chromium会在按钮禁用时移走焦点，须在发起检查前记录来源。
  const startedWithFocus = typeof document !== 'undefined' && document.activeElement === startButton.value
  await controller.check(); await nextTick()
  if (!disposed && startedWithFocus && (document.activeElement === document.body || document.activeElement === startButton.value || document.activeElement === cancelButton.value)) {
    const target = canCheck.value ? startButton.value : sides.value.length ? sideSelect.value : heading.value
    target?.focus()
  }
}
onMounted(() => { void controller.refreshStatus() })
onBeforeUnmount(() => { disposed = true; controller.dispose() })
</script>

<template>
  <section class="output-panel" data-testid="recording-output-panel" aria-labelledby="recording-output-title">
    <h4 id="recording-output-title" ref="heading" tabindex="-1">4 · 无设备输出检查</h4>
    <div class="boundary" role="note"><strong>不播放音频，不认证 Gate B。</strong><p>仅核对所选计划的实际执行音频与合成消费回执，不打开声卡或录音机，不改变库存。Gate B 仍为 NOT_RUN，正式输出被阻断。</p></div>
    <p v-if="plan">当前选择：计划第 {{ plan.sequence }} 版 · <code>{{ plan.id }}</code></p>
    <p v-else class="muted">请先明确查看或冻结一份计划；不会自动选择历史版本。</p>
    <div class="capability" aria-live="polite">
      <p v-if="state.statusPhase === 'loading' || state.statusPhase === 'unread'">正在读取无设备检查能力…</p>
      <p v-else-if="state.statusPhase === 'error'" role="alert">{{ state.statusError }}</p>
      <p v-else-if="!state.status?.syntheticCheck.available">无设备检查不可用：当前固定检查包未就绪或已禁用。不会使用其他后端。</p>
      <p v-else>固定合成检查包可用；设备访问仍未授权。</p>
      <button type="button" :disabled="busy || state.statusPhase === 'loading'" @click="controller.refreshStatus">重新读取检查能力</button>
    </div>
    <label for="recording-output-side">检查面／节目</label>
    <select id="recording-output-side" ref="sideSelect" :value="state.side" :disabled="!sides.length" @change="selectSide">
      <option value="">请明确选择一个非空面或节目</option>
      <option v-for="side in sides" :key="side" :value="side">{{ sideLabels[side] }}</option>
    </select>
    <p v-if="plan && !sides.length" class="muted">这份计划没有可检查的非空执行音频；没有改选其他计划或来源。</p>
    <div class="actions">
      <button ref="startButton" type="button" class="primary" :disabled="!canCheck" @click="check">无设备检查</button>
      <button v-if="busy" ref="cancelButton" type="button" :disabled="state.cancelSending" @click="controller.cancel">{{ state.phase === 'cancel-failed' ? '重试取消' : '取消无设备检查' }}</button>
    </div>
    <div class="result" aria-live="polite" aria-atomic="true">
      <p v-if="state.phase === 'unchecked'">本次尚未检查。</p>
      <p v-else-if="state.phase === 'checking'">正在核对文件并运行合成消费，期间不播放音频。</p>
      <p v-else-if="state.phase === 'cancelling'">已请求取消，正在等待本次检查结束；尚不能确认已停止。</p>
      <p v-else-if="state.phase === 'cancelled'">本次检查结果已作废；如需检查，请再次明确发起。</p>
      <p v-else-if="state.error" role="alert">{{ state.error }}</p>
      <template v-else-if="state.result">
        <h5>无设备检查通过</h5>
        <p>{{ sideLabels[state.result.side] }} · {{ state.result.consumedFrames }} / {{ state.result.frameCount }} 帧消费一致。此结果仅属于本次检查，不是正式输出许可。</p>
        <p>未打开设备 · Gate B NOT_RUN · 正式输出仍被阻断。</p>
      </template>
    </div>
    <details v-if="state.result"><summary>查看本次完整性摘要</summary><dl><dt>检查编号</dt><dd><code>{{ state.result.runId }}</code></dd><dt>计划 Hash</dt><dd><code>{{ state.result.planContentHash }}</code></dd><dt>PCM Hash</dt><dd><code>{{ state.result.pcmSha256 }}</code></dd><dt>检查包 Hash</dt><dd><code>{{ state.result.helperSha256 }}</code></dd></dl></details>
  </section>
</template>

<style scoped>
.output-panel{min-width:0;padding:18px;border:1px solid var(--mb-glass-border);border-radius:10px;margin:20px 0;color:var(--mb-text-primary)}h4{font-size:18px;margin:0 0 12px}h5{font-size:16px;margin:0 0 8px}p,dd{font-size:14px;line-height:1.75;overflow-wrap:anywhere}.muted,dt{color:var(--mb-text-secondary)}.boundary{border-left:3px solid var(--mb-accent);padding-left:14px}.boundary strong{font-size:15px}.capability{margin:18px 0}label{display:block;font-size:14px;margin:18px 0 8px}select,button{box-sizing:border-box;min-width:0;max-width:100%;min-height:44px;padding:10px 12px;background:var(--mb-bg-base);color:var(--mb-text-primary);border:1px solid var(--mb-glass-border);border-radius:8px;font:inherit;font-size:14px}select{width:100%}button,summary{cursor:pointer}button:disabled,select:disabled{cursor:not-allowed;opacity:.5}.actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:16px}.primary{background:var(--mb-accent);color:var(--mb-bg-deep);font-weight:600}.result{margin-top:16px;min-height:40px}summary{box-sizing:border-box;min-height:44px;padding:12px 0;font-size:14px}dl{display:grid;grid-template-columns:100px minmax(0,1fr);gap:10px}dt{font-size:13px}dd{margin:0;min-width:0}code{font-size:12px;white-space:normal;overflow-wrap:anywhere}:focus-visible{outline:2px solid var(--mb-accent);outline-offset:3px}button:not(:disabled):active{transform:scale(.97)}@media(hover:hover) and (pointer:fine){button:not(:disabled):hover{border-color:var(--mb-accent)}}@media(max-width:600px){.output-panel{padding:14px}dl{grid-template-columns:1fr;gap:4px}dd{margin-bottom:8px}}@media(prefers-reduced-motion:reduce){button:not(:disabled):active{transform:none}}
</style>
