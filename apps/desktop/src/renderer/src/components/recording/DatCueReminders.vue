<script setup lang="ts">
import { computed } from 'vue'
import type { RecordingAttempt, RecordingPlanVersion } from '@music-bridge/contracts'
import { datCueState } from './dat-cue-reminders'

const props = defineProps<{ plan: RecordingPlanVersion; attempt?: RecordingAttempt }>()
const state = computed(() => datCueState(props.plan, props.attempt))
const clock = (ms: number): string => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`
</script>

<template>
  <section v-if="state" class="dat-cues" aria-labelledby="dat-cue-title">
    <h4 id="dat-cue-title">DAT 人工 Cue 提醒</h4>
    <p>仅供人工操作参考；MusicBridge 不写入 DAT Track ID，也不以提示代替正式输出或实体确认。</p>
    <p v-if="state.basis === 'planned-only'">当前显示冻结布局的规划起点；没有可核对的实际音频段时基，不推算当前曲目。</p>
    <p v-else-if="state.basis === 'render-marker-derived'">当前显示冻结 Render 的人工 Marker 起点；执行音频经过采样率转换，位置仅作 Render 参考，不动态高亮。</p>
    <p v-else-if="state.basis === 'render-marker'">当前显示冻结 Render 的人工 Marker 起点，包括已接受的时间差异。</p>
    <p v-else>当前显示冻结执行资产的{{ state.basis === 'converted-receipt' ? '转换回执' : '执行回执' }}起点；运行高亮还须匹配正式 Attempt 音频身份。</p>
    <p v-if="state.positionIssue === 'audio-receipt-missing'" role="alert">此 Attempt 的音频回执身份未匹配，无法将消费帧对应到 Cue；请核对执行资产。</p>
    <p v-else-if="state.positionIssue === 'cue-position-mismatch'" role="alert">Cue 段顺序或时基与执行回执不一致，已退回参考时间，停止动态高亮。</p>
    <p v-if="state.observedFrames === null" role="status">尚无与这版计划完全匹配的正式 Attempt 消费帧。</p>
    <p v-else-if="state.activeIndex === null" role="status">正式 Attempt 已报告消费 {{ state.observedFrames }} 帧；当前不标记进行中的 Cue。</p>
    <p v-else role="status">正式 Attempt 已报告消费 {{ state.observedFrames }} 帧；高亮仅是人工 Cue 提醒。</p>
    <ol><li v-for="(cue, index) in state.cues" :key="cue.trackId" :class="{ active: state.activeIndex === index }" :aria-current="state.activeIndex === index ? 'step' : undefined">
      <span>{{ index + 1 }} · {{ cue.title }}</span><time>{{ clock(cue.referenceMs) }}</time><small v-if="state.activeIndex === index">当前人工提示</small>
    </li></ol>
  </section>
</template>

<style scoped>
.dat-cues{border:1px solid var(--mb-glass-border);border-radius:12px;padding:16px;color:var(--mb-text-primary)}h4{margin:0 0 8px;font-size:15px}p{font-size:12px;line-height:1.6;color:var(--mb-text-secondary)}ol{padding-left:24px}li{padding:8px 10px;border-radius:8px;font-size:13px;line-height:1.5}li.active{outline:2px solid var(--mb-accent);outline-offset:1px}time{margin-left:12px;font-variant-numeric:tabular-nums}small{display:block;color:var(--mb-text-secondary)}
</style>
