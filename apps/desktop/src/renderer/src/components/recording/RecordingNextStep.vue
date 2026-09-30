<script setup lang="ts">
import { computed, ref } from 'vue'
import { recordingWorkflowChoices, type RecordingNextAction, type RecordingNextStep, type RecordingWorkflowSelection, type RecordingWorkflowState } from './recording-next-step.js'

// disabled 只锁定上下文；原命令重试与草稿保存是否可点由 reducer 独立决定。
const props = defineProps<{ state: RecordingWorkflowState; nextStep: RecordingNextStep; disabled?: boolean }>()
const emit = defineEmits<{ action: [action: RecordingNextAction]; select: [patch: Partial<RecordingWorkflowSelection>] }>()
const context = ref<HTMLFieldSetElement>()
const contextDetails = ref<HTMLDetailsElement>()
const choices = computed(() => props.state.status === 'ready' && props.state.facts ? recordingWorkflowChoices(props.state.facts, props.state.selection) : undefined)
const usesPrepared = computed(() => props.state.selection.path === 'logic' || props.state.selection.path === 'prep')
const short = (id: string) => id.slice(0, 8)
function choose(key: keyof RecordingWorkflowSelection, event: Event): void {
  if (props.disabled || props.state.status !== 'ready') return
  emit('select', { [key]: (event.target as HTMLSelectElement).value || undefined })
}
function focusContext(): void {
  if (contextDetails.value) contextDetails.value.open = true
  const controls = Array.from(context.value?.querySelectorAll<HTMLSelectElement>('select:not(:disabled)') ?? [])
  ;(controls.find(control => !control.value) ?? controls[0])?.focus()
}
function act(): void {
  if (props.nextStep.disabled) return
  if (props.nextStep.action.type === 'choose-context') focusContext()
  emit('action', props.nextStep.action)
}
defineExpose({ focusContext })
</script>

<template>
  <section class="recording-next-step" data-testid="recording-next-step" aria-labelledby="recording-next-title">
    <div class="next-summary">
      <div class="next-copy">
        <p class="next-kicker">下一步 · {{ String(nextStep.step).padStart(2, '0') }}</p>
        <h3 id="recording-next-title">{{ nextStep.title }}</h3>
        <p id="recording-next-description" :role="state.status === 'error' ? 'alert' : 'status'">{{ nextStep.description }}</p>
      </div>
      <button type="button" class="next-primary" data-recording-return-focus="next-action" data-testid="recording-next-action" :data-action="nextStep.action.type" :disabled="nextStep.disabled" aria-describedby="recording-next-description" @click="act">{{ nextStep.label }}</button>
    </div>
    <details v-if="choices" ref="contextDetails" class="next-details">
      <summary>版本与关联详情 <span>按需展开并明确选择，不自动沿用最新版本</span></summary>
      <fieldset ref="context" class="next-context" :disabled="disabled || state.status !== 'ready'">
      <legend>本次工作上下文</legend>
      <p class="context-note">本次选择和页面位置保存在工作库；历史记录与库存不会因选择而改变。失效引用会保留原身份，需明确复核。</p>
      <div class="context-grid">
        <label>本次媒体规划<select :value="state.selection.planId ?? ''" :disabled="!choices.plans.length" @change="choose('planId', $event)"><option value="">{{ choices.plans.length ? '请选择媒体规划' : '尚无媒体规划' }}</option><option v-for="plan in choices.plans" :key="plan.id" :value="plan.id">规划 {{ short(plan.id) }} · 修订 {{ plan.revision }}{{ plan.requiresReview ? ' · 需复核' : '' }}{{ plan.reservation ? ' · 已预留' : ' · 未预留' }}</option></select></label>
        <label>本次冻结布局<select :value="state.selection.layoutId ?? ''" :disabled="!state.selection.planId || !choices.layouts.length" @change="choose('layoutId', $event)"><option value="">{{ !state.selection.planId ? '先选择媒体规划' : choices.layouts.length ? '请选择冻结布局' : '尚无对应冻结布局' }}</option><option v-for="layout in choices.layouts" :key="layout.id" :value="layout.id">布局 L{{ layout.sequence }} · {{ short(layout.id) }} · 母版 {{ short(layout.masterVersionId) }}</option></select></label>
        <label>本次处理路径<select :value="state.selection.path ?? ''" :disabled="!state.selection.layoutId" @change="choose('path', $event)"><option value="">请选择处理路径</option><option value="direct">Direct · 从已验证源准备</option><option value="logic">Logic · 继续工作区与 Render</option><option value="prep">PREP · 使用所选原始 Render</option></select></label>
        <template v-if="usesPrepared">
          <label>本次 Logic 工作区<select :value="state.selection.preparationId ?? ''" :disabled="!state.selection.layoutId || !choices.preparations.length" @change="choose('preparationId', $event)"><option value="">{{ choices.preparations.length ? '请选择对应工作区' : '尚无对应工作区' }}</option><option v-for="preparation in choices.preparations" :key="preparation.id" :value="preparation.id">工作区 {{ short(preparation.id) }} · {{ preparation.createdAt }}</option></select></label>
          <label>本次 PREP 版本<select :value="state.selection.preparedId ?? ''" :disabled="!state.selection.preparationId || !choices.prepared.length" @change="choose('preparedId', $event)"><option value="">{{ !state.selection.preparationId ? '先选择 Logic 工作区' : choices.prepared.length ? '请选择对应 PREP' : '尚无匹配的 PREP' }}</option><option v-for="prepared in choices.prepared" :key="prepared.id" :value="prepared.id">PREP {{ prepared.sequence }} · {{ short(prepared.id) }} · {{ prepared.conformance.status }}</option></select></label>
        </template>
      </div>
      </fieldset>
    </details>
  </section>
</template>

<style scoped>
.recording-next-step { min-width: 0; margin: 0; padding: 19px; border: 1px solid var(--mb-glass-border); border-radius: 14px; background: var(--recording-card-bg, var(--mb-bg-base)); }
.next-summary { display: flex; align-items: stretch; flex-direction: column; gap: 16px; }
.next-copy { min-width: 0; overflow-wrap: anywhere; }
.next-kicker { margin: 0 0 8px; color: var(--mb-accent); font-size: 12px; }
h3 { margin: 0; font-size: 16px; line-height: 1.5; }
.next-copy > p:last-child, .context-note { margin: 8px 0 0; color: var(--mb-text-secondary); font-size: 13px; line-height: 1.7; overflow-wrap: anywhere; }
.next-primary { width: 100%; min-height: 44px; padding: 10px 16px; border: 1px solid var(--mb-accent); border-radius: 10px; background: var(--mb-accent); color: var(--mb-on-accent); font: inherit; font-size: 13px; font-weight: 650; cursor: pointer; overflow-wrap: anywhere; }
.next-primary:active:not(:disabled) { opacity: .85; }
.next-primary:disabled { opacity: .55; cursor: default; }
.next-details { min-width: 0; margin-top: 14px; border-top: 1px solid var(--mb-glass-border); }
.next-details summary { display: flex; min-height: 44px; align-items: center; justify-content: space-between; gap: 10px; padding: 11px 0 0; color: var(--mb-text-primary); font-size: 12px; font-weight: 650; cursor: pointer; }
.next-details summary span { color: var(--mb-text-secondary); font-size: 11px; font-weight: 400; text-align: right; }
.next-details summary:focus-visible { outline: 2px solid var(--mb-accent); outline-offset: 2px; }
.next-context { min-width: 0; margin: 8px 0 0; padding: 8px 0 0; border: 0; }
legend { padding: 0 8px 0 0; color: var(--mb-text-primary); font-size: 13px; }
.context-note { margin: 0 0 12px; }
.context-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(210px, 100%), 1fr)); gap: 12px; }
label { display: grid; min-width: 0; gap: 6px; color: var(--mb-text-secondary); font-size: 12px; }
select { width: 100%; min-width: 0; min-height: 38px; padding: 8px; border: 1px solid var(--mb-glass-border); border-radius: 8px; background: var(--mb-bg-base); color: var(--mb-text-primary); font: inherit; }
@media (max-width: 900px) { .next-details summary { align-items: flex-start; flex-direction: column; gap: 4px; } .next-details summary span { text-align: left; } }
</style>
